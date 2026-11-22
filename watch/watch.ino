// Emily watch firmware (LilyGO T-Watch S3).
// CJ-4: read the BMA423 accelerometer at 50 Hz and keep the last 3 s in a ring buffer.
// CJ-5: detect a fall with thresholds, vibrate and show the values on screen.
// CJ-8: connect to the phone hotspot and POST the fall to Convex (HANDOFF section 6).
// CJ-10: after a fall, play "Are you OK?" and record 5 s from the microphone.
// CJ-11: send that recording as the body of POST /fall.
// CJ-15: poll Convex for Emily's reply, show it and play it.

#include <LilyGoLib.h>
#include <LV_Helper.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <math.h>
#include "secrets.h"
#include "are_you_ok.h"  // round 1 question as a WAV array (made with watch/tools/wav2h.js)
#include "fall_model.h"         // CJ-22: Random Forest from ml/watch_model (emlearn)
#include "fall_threshold.h"
#include "model_test_cases.h"   // ml/watch_model/test_cases.csv, for the self-test

// ---- Tunable constants ----
const uint32_t SERIAL_BAUD = 115200;
const uint32_t SAMPLE_PERIOD_MS = 20;    // 50 Hz
const float STANDARD_GRAVITY = 9.80665f; // m/s² per g
const size_t HISTORY_SAMPLES = 400;      // 8 s at 50 Hz (the model needs 1 s before to 3 s after
                                         // the impact, read 6 s after the trigger)
const bool PRINT_RAW_SAMPLES = false;   // true = print every sample (CJ-4 test / Serial Plotter)

// The Random Forest as judge (CJ-22). The thresholds below are the gate; the model decides.
#define USE_MODEL 1                           // 0 = thresholds only (CJ-5), if the model misbehaves in the demo
const bool RUN_MODEL_SELF_TEST = true;        // at boot: test_cases.csv through the model, print the error
const bool DUMP_MODEL_WINDOW = true;          // print the 200 samples the model saw (to compare with features.py)
const float AXIS_LIMIT_G = 8.0f;              // clamp each axis like ml/features.py
const int MODEL_BEFORE_SAMPLES = 50;          // 1 s before the impact
const int MODEL_AFTER_SAMPLES = 150;          // 3 s after it
const int ORIENTATION_SAMPLES = 25;           // half a second

// Fall detection (CJ-5). Starting values from the literature; tune by testing.
const float TRIGGER_G = 2.0f;                 // 1. a sample above this starts the check
const uint32_t IMPACT_WINDOW_MS = 1000;       // 2. impact_max_g = max mag up to 1 s after the trigger
const float FREE_FALL_G = 0.75f;              // 3. free fall: mag below this...
const uint32_t FREE_FALL_LOOKBACK_MS = 500;   //    ...in the 500 ms before the trigger
const uint32_t STILL_WATCH_MS = 5000;         // 4. watch 5 s after the impact window
const float STILL_MIN_G = 0.85f;              //    a second is "still" if every sample is in this band
const float STILL_MAX_G = 1.15f;
const uint32_t GRAVITY_BEFORE_MS = 1000;      // 5. gravity before = average of the 1 s before the trigger
const uint32_t GRAVITY_AFTER_FROM_MS = 2000;  //    gravity after = average from 2 s...
const uint32_t GRAVITY_AFTER_TO_MS = 3000;    //    ...to 3 s after the trigger
const float POSITION_CHANGE_DEG = 45.0f;
const int MIN_STILL_SECONDS = 2;              // 6. fall if still >= 2 s, or position changed,
const int MIN_STILL_SECONDS_WITH_FREE_FALL = 1;  //  or still >= 1 s when there was free fall
const uint32_t COOLDOWN_MS = 30000;           // no new trigger for 30 s after a fall
const float SIMULATED_IMPACT_G = 3.4f;        // "Simulate fall" button
const uint8_t VIBRATION_EFFECT = 47;          // DRV2605 effect 47 = "Buzz 1, 100%"
const uint8_t VIBRATION_REPEATS = 3;

// Sending the fall (CJ-8).
const uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
const uint32_t HTTP_TIMEOUT_MS = 8000;
const uint32_t SEND_RETRY_MS = 5000;
const uint32_t WIFI_NUDGE_MS = 10000;         // call WiFi.reconnect() at most this often while offline
const float MODEL_CONFIDENCE = 1.0f;          // no model yet (CJ-22)
const uint32_t SCREEN_WIFI_REFRESH_MS = 1000;

// Asking "Are you OK?" and recording the answer (CJ-10).
const uint8_t SPEAKER_VOLUME = 100;
const uint32_t AFTER_QUESTION_MS = 300;       // so we do not record our own speaker
const size_t RECORD_SECONDS = 3;               // was 5 (CJ-10); 3 s uploads ~1 s faster (Sebastian, 22 nov)
const uint16_t RECORD_SAMPLE_RATE = 16000;
const uint8_t RECORD_CHANNELS = 1;            // mono
const float MIC_GAIN_DB = 12.0f;              // software gain with soft clipping; library default is 0 on core 3.x.
                                              // 20 dB measured rms -5.7 dB / peak 0 dB (too hot); 12 dB aims ~ -14 dB rms
const bool PLAY_BACK_RECORDING = false;       // true = play the answer back before sending (CJ-10 test)

// Sending the recording (CJ-11).
const uint32_t AUDIO_HTTP_TIMEOUT_MS = 10000;
const int AUDIO_SEND_TRIES = 2;               // one try + one retry, then send without audio
const uint32_t AUDIO_WIFI_WAIT_MS = 15000;    // wait this long for WiFi before giving up on the audio
const uint32_t SEND_TASK_STACK = 12288;       // TLS + HTTP in the send task

// Getting Emily's reply (CJ-15).
const uint32_t POLL_RUSH_MS = 1000;           // first minute after the fall, when Emily's reply comes
const uint32_t RUSH_POLL_WINDOW_MS = 60000;
const uint32_t POLL_FAST_MS = 3000;           // rest of the incident (e.g. "Lucie is on her way")
const uint32_t POLL_IDLE_MS = 60000;          // normal day (also the heartbeat)
const uint32_t FAST_POLL_WINDOW_MS = 5UL * 60 * 1000;  // back to 60 s 5 min after the fall
const uint32_t POLL_HTTP_TIMEOUT_MS = 5000;
const uint32_t REPLY_AUDIO_TIMEOUT_MS = 10000;
const size_t MAX_REPLY_WAV_BYTES = 1024 * 1024;  // reject anything bigger (3 s of voice ~ 96 KB)
const uint8_t VIBRATION_BEFORE_REPLY = 1;     // one buzz before Emily speaks
const uint8_t VIBRATION_TEXT_ONLY = 2;        // two buzzes when there is only text (plan C)
const size_t REPLY_TEXT_MAX = 256;

// Round 2 and follow-up (CJ-17).
const uint32_t ROUND2_TIMEOUT_MS = 20000;     // card says 10 s, but Convex takes ~12-15 s to reply
                                              // today (decided with Sebastian, 21 nov); lower it when faster
const uint32_t FOLLOW_UP_MS = 5UL * 60 * 1000;  // after the last round, listen 5 min, then back to idle
const uint32_t ALARM_BUZZ_MS = 2000;          // no connection: buzz every 2 s until it is sent
const uint8_t *const ROUND2_WAV = are_you_ok_wav;  // TODO: are_you_ok_2.h ("Rosa, it's Emily again")
const size_t ROUND2_WAV_LEN = are_you_ok_wav_len;

struct AccelSample {
  uint32_t tMs;
  float x, y, z;  // g
  float mag;      // g
};

// What a detected fall sends on (CJ-8 posts these to Convex).
struct FallEvent {
  float impactMaxG;
  int secondsStill;
  bool positionChanged;
  bool freeFall;
  uint32_t atMs;
  float confidence;  // model score (CJ-22), sent as &confidence=
  uint32_t fallNumber;  // set by onFall; with bootId makes &fallId= (same for both rounds)
};

// fallId = "<bootId>-<fallNumber>": unique per fall, the same for its retries and its round 2,
// so Convex can tell a retry from a new fall (instead of a 60 s window).
uint32_t bootId = 0;
uint32_t fallCounter = 0;

// Ring buffer: history[historyHead] is the next slot to write.
AccelSample history[HISTORY_SAMPLES];
size_t historyHead = 0;
size_t historyCount = 0;
uint32_t nextSampleMs = 0;

// Detector state.
enum class DetectorState { Idle, Watching };
DetectorState detectorState = DetectorState::Idle;
uint32_t triggerMs = 0;
float impactMaxG = 0;
uint32_t impactMs = 0;    // time of the strongest sample (the model's centre)
bool freeFall = false;
float gravityBefore[3] = {0, 0, 0};
float gravityAfterSum[3] = {0, 0, 0};
int gravityAfterCount = 0;
bool stillSecond[STILL_WATCH_MS / 1000];
uint32_t cooldownUntilMs = 0;

FallEvent lastFall;
bool hasFall = false;

// Sending runs in its own task so the accelerometer keeps reading at 50 Hz.
// The task only talks to the network; screen and vibration stay in loop().
enum class SendStatus { Idle, Sending, Sent, Retrying, Failed };
volatile SendStatus sendStatus = SendStatus::Idle;
volatile bool sendRequested = false;
FallEvent fallToSend;
String incidentId;             // from the last POST /fall answer
SendStatus shownSendStatus = SendStatus::Idle;
volatile bool noConnectionBuzz = false;  // set by the send task when the first attempt fails
uint8_t *volatile audioToSend = nullptr;  // recording handed to the send task (it frees it)
volatile size_t audioToSendLen = 0;
portMUX_TYPE handoffMux = portMUX_INITIALIZER_UNLOCKED;  // guards the hand-off between loop() and the task

// Reply hand-off: the send task fills these and sets replyReady; loop() plays and clears it.
volatile bool replyReady = false;
uint8_t *replyWav = nullptr;       // ps_malloc'd WAV or null; loop() frees it
size_t replyWavLen = 0;
char replyText[REPLY_TEXT_MAX];
bool replyAskAgain = false;
volatile bool audioBusy = false;   // loop() is recording or playing: do not poll (card CJ-15)
volatile uint32_t fastPollUntilMs = 0;
volatile uint32_t rushPollUntilMs = 0;
uint32_t recordEndMs = 0;          // to measure "recording ends -> watch speaks"

// Conversation after a fall (CJ-17). Only loop() changes it.
enum class Flow { Idle, Asking1, Waiting1, Asking2, Waiting2, FollowUp };
Flow flow = Flow::Idle;
uint32_t flowSinceMs = 0;
bool replySeen = false;                 // any message from /poll since round 1
volatile int roundToSend = 1;           // handed to the send task with the recording
volatile bool round1Ended = false;      // send task: round 1 upload finished (or first failed)
volatile uint32_t round1EndedMs = 0;
volatile bool round2Ended = false;
volatile bool replyIncoming = false;    // send task took a message and is downloading its voice
volatile bool inConversation = false;   // ASKING/WAITING: only messages of the current fall count
uint32_t lastAlarmBuzzMs = 0;

// The question and the recording block for ~8 s, so they run from loop(), not from a UI callback.
bool askRequested = false;
int askRound = 1;
int recordingsDone = 0;

// Screen.
lv_obj_t *statusLabel;
lv_obj_t *valuesLabel;
lv_obj_t *wifiLabel;
lv_obj_t *stateLabel;                   // current Flow in a corner (helps debugging)
uint32_t nextWifiRefreshMs = 0;

const char *flowName(Flow f) {
  switch (f) {
    case Flow::Idle: return "IDLE";
    case Flow::Asking1: return "ASKING_1";
    case Flow::Waiting1: return "WAITING_1";
    case Flow::Asking2: return "ASKING_2";
    case Flow::Waiting2: return "WAITING_2";
    case Flow::FollowUp: return "FOLLOW_UP";
  }
  return "?";
}

void setFlow(Flow f) {
  flow = f;
  flowSinceMs = millis();
  inConversation = f == Flow::Asking1 || f == Flow::Waiting1 || f == Flow::Asking2 || f == Flow::Waiting2;
  if (f == Flow::FollowUp) fastPollUntilMs = millis() + FOLLOW_UP_MS;  // poll every 3 s all along
  if (stateLabel) lv_label_set_text(stateLabel, flowName(f));
  Serial.printf("FLOW %s\n", flowName(f));
}

void addSample(const AccelSample &s) {
  history[historyHead] = s;
  historyHead = (historyHead + 1) % HISTORY_SAMPLES;
  if (historyCount < HISTORY_SAMPLES) historyCount++;
}

// i = 0 is the newest sample.
const AccelSample &historyAt(size_t i) {
  return history[(historyHead + HISTORY_SAMPLES - 1 - i) % HISTORY_SAMPLES];
}

bool readAccel(AccelSample &out) {
  AccelerometerData data;
  if (!instance.sensor->readData(data)) return false;
  out.tMs = millis();
  out.x = data.mps2.x / STANDARD_GRAVITY;
  out.y = data.mps2.y / STANDARD_GRAVITY;
  out.z = data.mps2.z / STANDARD_GRAVITY;
  out.mag = sqrtf(out.x * out.x + out.y * out.y + out.z * out.z);
  return true;
}

float angleBetweenDeg(const float a[3], const float b[3]) {
  float dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  float na = sqrtf(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  float nb = sqrtf(b[0] * b[0] + b[1] * b[1] + b[2] * b[2]);
  if (na < 0.01f || nb < 0.01f) return 0;
  float c = dot / (na * nb);
  if (c > 1) c = 1;
  if (c < -1) c = -1;
  return acosf(c) * 180.0f / (float)M_PI;
}

void vibrate(uint8_t repeats = VIBRATION_REPEATS) {
  for (uint8_t i = 0; i < repeats; i++) instance.drv.setWaveform(i, VIBRATION_EFFECT);
  instance.drv.setWaveform(repeats, 0);  // end of sequence
  instance.drv.run();
}

void showFall(const FallEvent &f) {
  lv_label_set_text(statusLabel, "Fall detected");
  lv_label_set_text_fmt(valuesLabel, "impact: %.2f g\nstill: %d s\nposition: %s\nfree fall: %s",
                        f.impactMaxG, f.secondsStill, f.positionChanged ? "changed" : "same",
                        f.freeFall ? "yes" : "no");
}

void onFall(const FallEvent &f) {
  lastFall = f;
  hasFall = true;
  cooldownUntilMs = millis() + COOLDOWN_MS;
  vibrate();
  showFall(f);
  Serial.printf("FALL impact_max_g=%.2f seconds_still=%d position_changed=%d free_fall=%d\n",
                f.impactMaxG, f.secondsStill, f.positionChanged, f.freeFall);
  // Round 1: fall -> vibrate -> "Are you OK?" -> record -> POST /fall with the audio.
  // A new fall replaces the previous conversation completely (decided with Sebastian, 22 nov).
  fallToSend = f;
  fallToSend.fallNumber = ++fallCounter;
  replySeen = false;
  replyIncoming = false;
  askRound = 1;
  askRequested = true;
  setFlow(Flow::Asking1);
}

// Loudness of a 16-bit recording, to tune MIC_GAIN_DB (0 dB = full scale).
void printLevel(const uint8_t *pcm, size_t bytes) {
  const int16_t *s = (const int16_t *)pcm;
  size_t n = bytes / 2;
  double sum = 0;
  int peak = 0;
  for (size_t i = 0; i < n; i++) {
    sum += (double)s[i] * s[i];
    int a = abs((int)s[i]);
    if (a > peak) peak = a;
  }
  float rmsDb = n ? 20.0f * log10f(sqrtf(sum / n) / 32768.0f + 1e-9f) : -99;
  float peakDb = 20.0f * log10f(peak / 32768.0f + 1e-9f);
  Serial.printf("LEVEL rms=%.1f dB peak=%.1f dB gain=%.0f dB\n", rmsDb, peakDb, MIC_GAIN_DB);
}

void refreshScreenNow() {
  lv_timer_handler();
  lv_refr_now(NULL);
}

// Blocking: ~3 s question + 0.3 s + 5 s recording. The fall is already detected, so pausing
// the accelerometer here is fine. The recording is handed to the send task, which frees it.
void askAndRecord(int round) {
  AudioOutputIf *out = instance.getAudioOutput();
  AudioInputIf *in = instance.getAudioInput();
  audioBusy = true;
  if (round == 2) vibrate();

  lv_label_set_text(statusLabel, "Are you OK?");
  refreshScreenNow();
  out->setVolume(SPEAKER_VOLUME);
  if (round == 1) out->playWAV((uint8_t *)are_you_ok_wav, are_you_ok_wav_len);
  else out->playWAV((uint8_t *)ROUND2_WAV, ROUND2_WAV_LEN);
  delay(AFTER_QUESTION_MS);

  lv_label_set_text(statusLabel, "Listening...");
  refreshScreenNow();
  uint8_t *wav = nullptr;
  size_t wavSize = 0;
  uint32_t t0 = millis();
  in->setMicGain(MIC_GAIN_DB);
  bool ok = in->recordWAV(RECORD_SECONDS, &wav, &wavSize, RECORD_SAMPLE_RATE, RECORD_CHANNELS);
  recordEndMs = millis();
  recordingsDone++;
  Serial.printf("RECORD ok=%d size=%u in %lu ms count=%d free_psram=%u\n", ok, (unsigned)wavSize,
                (unsigned long)(millis() - t0), recordingsDone, (unsigned)ESP.getFreePsram());
  if (ok) printLevel(wav + PCM_WAV_HEADER_SIZE, wavSize - PCM_WAV_HEADER_SIZE);

  if (ok && PLAY_BACK_RECORDING) {
    lv_label_set_text(statusLabel, "Playing back");
    refreshScreenNow();
    out->playWAV(wav, wavSize);
  }

  // Hand the recording to the send task (it frees it). If the task is still busy with an
  // older fall that it never picked up, drop that older clip.
  if (!ok && wav) {
    free(wav);
    wav = nullptr;
  }
  taskENTER_CRITICAL(&handoffMux);
  uint8_t *older = audioToSend;
  audioToSend = wav;
  audioToSendLen = wav ? wavSize : 0;
  roundToSend = round;
  if (round == 1) round1Ended = false;
  else round2Ended = false;
  sendStatus = SendStatus::Sending;  // so the screen never shows the previous fall's status
  sendRequested = true;
  taskEXIT_CRITICAL(&handoffMux);
  if (older) free(older);
  setFlow(round == 1 ? Flow::Waiting1 : Flow::Waiting2);

  shownSendStatus = SendStatus::Idle;
  lv_label_set_text(statusLabel, "Fall detected");
  audioBusy = false;
  nextSampleMs = millis();  // restart sampling cleanly after the pause
}

// Auto-reconnect gives up after some errors (e.g. a wrong password), so nudge it now and then.
void nudgeWifi() {
  static uint32_t lastNudgeMs = 0;
  if (WiFi.status() == WL_CONNECTED || millis() - lastNudgeMs < WIFI_NUDGE_MS) return;
  lastNudgeMs = millis();
  WiFi.reconnect();
}

// Waits up to maxMs for WiFi; gives up early if a newer fall is waiting.
bool waitForWifi(uint32_t maxMs) {
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - t0 >= maxMs || sendRequested) return false;
    nudgeWifi();
    vTaskDelay(pdMS_TO_TICKS(250));
  }
  return true;
}

// One POST /fall with an optional WAV body (len 0 = no audio). Returns the HTTP code
// (negative = network error) and fills incidentId on 200.
int postFall(const FallEvent &f, int round, uint8_t *audio, size_t len, uint32_t timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("SEND no WiFi");
    return -1;
  }
  String url = String(CONVEX_SITE_URL) + "/fall?device=" + DEVICE_ID + "&round=" + String(round) +
               "&impact=" + String(f.impactMaxG, 2) + "&still=" + String(f.secondsStill) +
               "&position=" + (f.positionChanged ? "1" : "0") +
               "&confidence=" + String(f.confidence, 2);
  // Round 2 joins round 1's incident. If round 1 never arrived, Convex creates the incident.
  if (round == 2 && incidentId.length() > 0) url += "&incidentId=" + incidentId;
  url += "&fallId=" + String(bootId, HEX) + "-" + String(f.fallNumber);

  WiFiClientSecure client;
  client.setInsecure();  // demo only (HANDOFF section 10)
  client.setHandshakeTimeout(timeoutMs / 1000);  // seconds; the library default is 120 s
  HTTPClient http;
  http.setConnectTimeout(timeoutMs);
  http.setTimeout(timeoutMs);
  if (!http.begin(client, url)) {
    Serial.println("SEND begin failed");
    return -1;
  }
  if (len > 0) http.addHeader("Content-Type", "audio/wav");  // HTTPClient sets Content-Length
  uint32_t t0 = millis();
  int code = http.POST(audio, len);
  String body = code > 0 ? http.getString() : http.errorToString(code);
  http.end();
  Serial.printf("SEND http=%d audio=%u bytes in %lu ms stack_free=%u body=%s\n", code, (unsigned)len,
                (unsigned long)(millis() - t0), (unsigned)uxTaskGetStackHighWaterMark(NULL), body.c_str());
  if (code != 200) return code;

  // Body is {"incidentId":"..."}; a tiny search is enough, no JSON library needed.
  int key = body.indexOf("\"incidentId\"");
  int start = key < 0 ? -1 : body.indexOf('"', body.indexOf(':', key) + 1);
  int end = start < 0 ? -1 : body.indexOf('"', start + 1);
  if (end < 0) return -1;
  incidentId = body.substring(start + 1, end);
  Serial.printf("INCIDENT %s\n", incidentId.c_str());
  return 200;
}

// 400/404 will not get better by retrying (bad request, unknown device).
bool isFinalError(int code) { return code == 400 || code == 404; }

// ---- CJ-15: getting Emily's reply ----

// Reads "key":"value" from the small flat JSON that /poll returns (JSON.stringify, no spaces)
// and unescapes it. No JSON library needed for three fields.
bool jsonString(const String &body, const char *key, String &out) {
  String k = String("\"") + key + "\":\"";
  int i = body.indexOf(k);
  if (i < 0) return false;
  i += k.length();
  out = "";
  while (i < (int)body.length()) {
    char c = body[i++];
    if (c == '"') return true;
    if (c == '\\' && i < (int)body.length()) {
      char e = body[i++];
      if (e == 'n') out += '\n';
      else if (e == 'u') { i += 4; out += '?'; }  // rare in English replies
      else out += e;                             // \" \\ \/
    } else {
      out += c;
    }
  }
  return false;
}

// Collects an HTTP body into a fixed PSRAM buffer (used with HTTPClient::writeToStream,
// which also handles chunked bodies). Returns 0 when full, so oversize bodies fail.
struct BufStream : Stream {
  uint8_t *buf;
  size_t cap, len = 0;
  BufStream(uint8_t *b, size_t c) : buf(b), cap(c) {}
  size_t write(uint8_t b) override { return write(&b, 1); }
  size_t write(const uint8_t *p, size_t n) override {
    if (len + n > cap) return 0;
    memcpy(buf + len, p, n);
    len += n;
    return n;
  }
  int available() override { return 0; }
  int read() override { return -1; }
  int peek() override { return -1; }
};

// Downloads Emily's reply WAV into PSRAM. The caller frees *out.
bool getReplyWav(const String &url, uint8_t **out, size_t *outLen) {
  WiFiClientSecure client;
  client.setInsecure();
  client.setHandshakeTimeout(REPLY_AUDIO_TIMEOUT_MS / 1000);
  HTTPClient http;
  http.setConnectTimeout(REPLY_AUDIO_TIMEOUT_MS);
  http.setTimeout(REPLY_AUDIO_TIMEOUT_MS);
  if (!http.begin(client, url)) return false;
  uint32_t t0 = millis();
  int code = http.GET();
  int size = http.getSize();
  if (code != 200 || size > (int)MAX_REPLY_WAV_BYTES) {
    Serial.printf("AUDIO http=%d size=%d rejected\n", code, size);
    http.end();
    return false;
  }
  size_t cap = size > 0 ? (size_t)size : MAX_REPLY_WAV_BYTES;
  uint8_t *buf = (uint8_t *)ps_malloc(cap);
  if (!buf) {
    http.end();
    return false;
  }
  BufStream bs(buf, cap);
  int written = http.writeToStream(&bs);
  http.end();
  Serial.printf("AUDIO http=%d bytes=%u in %lu ms\n", code, (unsigned)bs.len, (unsigned long)(millis() - t0));
  if (written < 0 || bs.len < 44) {
    free(buf);
    return false;
  }
  *out = buf;
  *outLen = bs.len;
  return true;
}

// One GET /poll. Returns 1 if a message was handed to loop(), 0 if the queue is empty,
// -1 on error. With deliver=false the message is read and dropped (boot clean-up).
int pollOnce(bool deliver) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  WiFiClientSecure client;
  client.setInsecure();
  client.setHandshakeTimeout(POLL_HTTP_TIMEOUT_MS / 1000);
  HTTPClient http;
  http.setConnectTimeout(POLL_HTTP_TIMEOUT_MS);
  http.setTimeout(POLL_HTTP_TIMEOUT_MS);
  if (!http.begin(client, String(CONVEX_SITE_URL) + "/poll?device=" + DEVICE_ID)) return -1;
  int code = http.GET();
  String body = code > 0 ? http.getString() : "";
  http.end();
  if (code != 200) {
    Serial.printf("POLL http=%d\n", code);
    return -1;
  }
  String text, audioUrl;
  if (!jsonString(body, "text", text)) return 0;  // {} = nothing waiting
  bool askAgain = body.indexOf("\"askAgain\":true") >= 0;
  bool hasAudio = jsonString(body, "audioUrl", audioUrl);
  Serial.printf("POLL text=\"%s\" askAgain=%d audio=%d%s\n", text.c_str(), askAgain, hasAudio,
                deliver ? "" : " (old message, dropped)");
  if (!deliver) return 1;

  // During a conversation, a message about another (older) fall is not said: the newest fall
  // replaces the old conversation. Needs incidentId in /poll (Convex, Fabian); a message
  // without it is still delivered, as before. incidentId is only touched by this task.
  String msgIncident;
  if (inConversation && jsonString(body, "incidentId", msgIncident) && msgIncident != incidentId) {
    Serial.printf("POLL dropped: message for incident %s, current is %s\n", msgIncident.c_str(),
                  incidentId.length() ? incidentId.c_str() : "(not sent yet)");
    return 1;  // poll again right away
  }
  replyIncoming = true;  // stops the round-2 timer while the voice downloads

  uint8_t *wav = nullptr;
  size_t wavLen = 0;
  // The message is marked delivered before we download, so retry the audio once.
  // With askAgain the voice is not played (the watch asks itself), so do not download it.
  if (hasAudio && !askAgain && !getReplyWav(audioUrl, &wav, &wavLen)) getReplyWav(audioUrl, &wav, &wavLen);

  strlcpy(replyText, text.c_str(), sizeof(replyText));
  replyAskAgain = askAgain;
  replyWav = wav;
  replyWavLen = wavLen;
  replyReady = true;
  return 1;
}

void sendTask(void *) {
  // Drop replies left over from earlier tests, so they do not play during the next fall
  // (/poll does not say which incident a message belongs to).
  while (pollOnce(false) == 1) {}
  uint32_t nextPollMs = millis();

  for (;;) {
    if (!sendRequested) {
      // Poll for Emily's reply: every 3 s during an incident, every 60 s otherwise.
      // Not while loop() records or plays, and not until loop() took the last reply.
      uint32_t now = millis();
      if (!audioBusy && !replyReady && (int32_t)(now - nextPollMs) >= 0) {
        int r = pollOnce(true);
        bool rush = (int32_t)(rushPollUntilMs - now) > 0;
        bool fast = (int32_t)(fastPollUntilMs - now) > 0;
        uint32_t wait = rush ? POLL_RUSH_MS : (fast ? POLL_FAST_MS : POLL_IDLE_MS);
        // A message arrived: poll again right away (several can be queued).
        nextPollMs = millis() + (r == 1 ? 0 : wait);
      }
      vTaskDelay(pdMS_TO_TICKS(50));
      continue;
    }
    taskENTER_CRITICAL(&handoffMux);
    FallEvent f = fallToSend;
    uint8_t *audio = audioToSend;
    size_t audioLen = audioToSendLen;
    int round = roundToSend;
    audioToSend = nullptr;
    audioToSendLen = 0;
    sendRequested = false;
    sendStatus = SendStatus::Sending;
    taskEXIT_CRITICAL(&handoffMux);
    if (round == 1) incidentId = "";  // a new fall: forget the previous incident

    // With audio: wait a little for WiFi (a short hotspot blip should not cost the clip),
    // then one try + one retry. After that, send without audio so the alert still goes out.
    int code = -1;
    for (int i = 0; audio && code != 200 && !isFinalError(code) && i < AUDIO_SEND_TRIES; i++) {
      if (!waitForWifi(AUDIO_WIFI_WAIT_MS)) break;
      code = postFall(f, round, audio, audioLen, AUDIO_HTTP_TIMEOUT_MS);
    }
    if (audio) free(audio);
    if (code != 200 && !isFinalError(code)) {
      noConnectionBuzz = true;
      code = postFall(f, round, nullptr, 0, HTTP_TIMEOUT_MS);
    }
    // The round-2 timer starts here, whether the upload worked or not (card CJ-17).
    if (round == 1) {
      round1EndedMs = millis();
      round1Ended = true;
    } else {
      round2Ended = true;
    }
    // Keep trying until it is sent or a newer fall replaces it (HANDOFF section 7: the incident
    // goes out when the connection comes back; the server merges repeats within 60 s).
    for (int retry = 1; code != 200 && !isFinalError(code) && !sendRequested; retry++) {
      sendStatus = SendStatus::Retrying;
      Serial.printf("SEND retry %d in %lu ms (no audio)\n", retry, (unsigned long)SEND_RETRY_MS);
      vTaskDelay(pdMS_TO_TICKS(SEND_RETRY_MS));
      nudgeWifi();
      if (WiFi.status() == WL_CONNECTED) code = postFall(f, round, nullptr, 0, HTTP_TIMEOUT_MS);
    }
    if (isFinalError(code)) Serial.printf("SEND gave up: http=%d\n", code);
    // Round 1 got through only on a later retry: give Convex the full wait to reply.
    if (round == 1 && code == 200) round1EndedMs = millis();
    if (sendRequested) continue;  // a newer fall is waiting; its status comes next
    if (code == 200) {
      fastPollUntilMs = millis() + FAST_POLL_WINDOW_MS;
      rushPollUntilMs = millis() + RUSH_POLL_WINDOW_MS;
      nextPollMs = millis() + POLL_RUSH_MS;
    }
    sendStatus = code == 200 ? SendStatus::Sent : SendStatus::Failed;
  }
}

// Called from loop(): screen and vibration follow the send task.
void updateSendScreen() {
  if (noConnectionBuzz) {
    noConnectionBuzz = false;
    vibrate();  // 3 buzzes when the first attempt fails
    lastAlarmBuzzMs = millis();
  }
  SendStatus s = sendStatus;
  // Local alarm while the fall is not sent: buzz every 2 s (not while recording or playing).
  bool offline = s == SendStatus::Retrying;  // Failed = 400/404: retrying will not help
  if (offline && !audioBusy && millis() - lastAlarmBuzzMs >= ALARM_BUZZ_MS) {
    vibrate(1);
    lastAlarmBuzzMs = millis();
  }
  if (s == shownSendStatus) return;
  shownSendStatus = s;
  if (s == SendStatus::Sending) lv_label_set_text(statusLabel, "Sending...");
  if (s == SendStatus::Sent) lv_label_set_text(statusLabel, "Help notified");
  if (offline) lv_label_set_text(statusLabel, "No connection.\nCall for help");
  if (s == SendStatus::Failed) lv_label_set_text(statusLabel, "Send failed");
}

// CJ-17: what happens next in the conversation. Called from loop().
void updateFlow() {
  uint32_t now = millis();
  switch (flow) {
    case Flow::Waiting1:
      // No message at all for 20 s after round 1 was sent (or failed): ask again.
      if (!replySeen && !replyIncoming && round1Ended &&
          (int32_t)(now - round1EndedMs) >= (int32_t)ROUND2_TIMEOUT_MS) {
        Serial.println("ROUND2 timer: no reply after round 1");
        askRound = 2;
        askRequested = true;
        setFlow(Flow::Asking2);
      }
      break;
    case Flow::Waiting2:
      if (round2Ended) setFlow(Flow::FollowUp);  // never a third question
      break;
    case Flow::FollowUp:
      if (now - flowSinceMs >= FOLLOW_UP_MS) {
        setFlow(Flow::Idle);
        lv_label_set_text(statusLabel, "Watching");
        lv_label_set_text(valuesLabel, "");
        shownSendStatus = SendStatus::Idle;  // keep showing "No connection" if still offline
      }
      break;
    default:
      break;
  }
}

// Plays a WAV after checking its header ourselves: LilyGoLib's playWAV trusts the sizes in
// the header, and the reply comes from the network.
bool playReply(const uint8_t *w, size_t n) {
  if (n < 12 || memcmp(w, "RIFF", 4) != 0 || memcmp(w + 8, "WAVE", 4) != 0) return false;
  uint16_t fmt = 0, ch = 0, bits = 0;
  uint32_t rate = 0;
  size_t p = 12;
  while (p + 8 <= n) {
    uint32_t sz;
    memcpy(&sz, w + p + 4, 4);
    if (memcmp(w + p, "fmt ", 4) == 0 && p + 24 <= n) {
      memcpy(&fmt, w + p + 8, 2);
      memcpy(&ch, w + p + 10, 2);
      memcpy(&rate, w + p + 12, 4);
      memcpy(&bits, w + p + 22, 2);
    } else if (memcmp(w + p, "data", 4) == 0) {
      if (fmt != 1 || ch == 0 || bits != 16 || rate == 0) return false;
      size_t len = min((size_t)sz, n - (p + 8));  // the size can be 0xFFFFFFFF in streamed WAVs
      Serial.printf("REPLY wav rate=%lu ch=%u bits=%u pcm=%u header=%u\n", (unsigned long)rate, ch, bits,
                    (unsigned)len, (unsigned)(p + 8));
      AudioOutputIf *out = instance.getAudioOutput();
      out->setVolume(SPEAKER_VOLUME);
      out->open(bits, ch, rate);
      out->write((uint8_t *)w + p + 8, len);
      out->close();
      return true;
    }
    if (sz > n) return false;
    p += 8 + sz + (sz & 1);
  }
  return false;
}

// Called from loop() when the send task got a message from /poll.
void handleReply() {
  // askAgain = Convex did not understand round 1. The watch asks round 2 with its own
  // question, so Emily's text/voice for it is skipped (otherwise Rosa hears it twice).
  // Agreed with Fabian's side: when askAgain is true the watch ignores text and audioUrl.
  if (replyAskAgain) {
    if (replyWav) free(replyWav);
    replyWav = nullptr;
    replySeen = true;
    replyReady = false;
    if (flow == Flow::Waiting1) {
      Serial.println("ROUND2 askAgain from Convex (its question is skipped)");
      askRound = 2;
      askRequested = true;
      setFlow(Flow::Asking2);
    } else {
      Serial.println("REPLY askAgain ignored (already asked twice)");
    }
    return;
  }

  audioBusy = true;
  bool hasText = replyText[0] != '\0';
  if (hasText) {
    lv_label_set_text(statusLabel, "Emily says:");
    lv_label_set_text(valuesLabel, replyText);
    refreshScreenNow();
  }
  bool spoke = false;
  if (replyWav) {
    vibrate(VIBRATION_BEFORE_REPLY);
    delay(300);  // let the buzz finish before the voice
    uint32_t sinceRecord = millis() - recordEndMs;
    spoke = playReply(replyWav, replyWavLen);
    Serial.printf("REPLY played=%d, %lu ms after the recording ended\n", spoke, (unsigned long)sinceRecord);
    free(replyWav);
    replyWav = nullptr;
  }
  if (!spoke && hasText) vibrate(VIBRATION_TEXT_ONLY);  // plan C: text only
  replySeen = true;
  replyReady = false;
  audioBusy = false;
  nextSampleMs = millis();

  // A real answer to round 1: no second question, just listen for "... is on the way".
  if (flow == Flow::Waiting1) setFlow(Flow::FollowUp);
}

void updateWifiScreen() {
  if ((int32_t)(millis() - nextWifiRefreshMs) < 0) return;
  nextWifiRefreshMs = millis() + SCREEN_WIFI_REFRESH_MS;
  lv_label_set_text(wifiLabel, WiFi.status() == WL_CONNECTED ? "WiFi OK" : "No WiFi");
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);  // reconnect on its own only if the link drops
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_TIMEOUT_MS) delay(100);
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("WIFI OK ip=%s in %lu ms\n", WiFi.localIP().toString().c_str(), (unsigned long)(millis() - t0));
  } else {
    Serial.println("WIFI not connected (will keep trying in the background)");
  }
}

// ---- CJ-22: the 9 features of ml/features.py (extract_features), same order and windows ----

float clampAxis(float v) { return v > AXIS_LIMIT_G ? AXIS_LIMIT_G : (v < -AXIS_LIMIT_G ? -AXIS_LIMIT_G : v); }

// Builds the features around the strongest sample (impactMs) and runs the model.
// Returns false if the buffer does not hold 1 s before to 3 s after the impact.
bool modelScore(float *scoreOut) {
  // a = age of the impact sample (historyAt(a)); sample k rows after it is historyAt(a - k).
  int a = -1;
  for (size_t i = 0; i < historyCount; i++) {
    if (historyAt(i).tMs == impactMs) { a = (int)i; break; }
  }
  if (a < MODEL_AFTER_SAMPLES - 1 || a + MODEL_BEFORE_SAMPLES >= (int)historyCount) {
    Serial.printf("MODEL window incomplete (impact age %d, buffer %u)\n", a, (unsigned)historyCount);
    return false;
  }
  uint32_t t0 = micros();
  auto axes = [&](int k, float v[3]) {
    const AccelSample &s = historyAt(a - k);
    v[0] = clampAxis(s.x); v[1] = clampAxis(s.y); v[2] = clampAxis(s.z);
  };
  auto mag = [](const float v[3]) { return sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]); };

  // "around": 1 s before to 1 s after (k = -50..49). Python: force.max/min/mean/var (divide by N).
  float v[3], mx = -1e9f, mn = 1e9f;
  double sum = 0, sumSq = 0;
  float firstDir[3] = {0, 0, 0}, lastDir[3] = {0, 0, 0};
  const int aroundN = 2 * MODEL_BEFORE_SAMPLES;
  for (int k = -MODEL_BEFORE_SAMPLES; k < MODEL_BEFORE_SAMPLES; k++) {
    axes(k, v);
    float m = mag(v);
    if (m > mx) mx = m;
    if (m < mn) mn = m;
    sum += m;
    sumSq += (double)m * m;
    int idx = k + MODEL_BEFORE_SAMPLES;
    for (int j = 0; j < 3; j++) {
      if (idx < ORIENTATION_SAMPLES) firstDir[j] += v[j] / ORIENTATION_SAMPLES;    // around[:25]
      if (idx >= aroundN - ORIENTATION_SAMPLES) lastDir[j] += v[j] / ORIENTATION_SAMPLES;  // around[-25:]
    }
  }
  double mean = sum / aroundN;

  // "after": 1 s to 3 s after (k = 50..149). std (N), mean |force - 1|, max; direction of the last 1 s.
  double aSum = 0, aSumSq = 0, offSum = 0;
  float aMax = -1e9f, afterDir[3] = {0, 0, 0};
  const int afterN = MODEL_AFTER_SAMPLES - MODEL_BEFORE_SAMPLES;
  for (int k = MODEL_BEFORE_SAMPLES; k < MODEL_AFTER_SAMPLES; k++) {
    axes(k, v);
    float m = mag(v);
    aSum += m;
    aSumSq += (double)m * m;
    offSum += fabsf(m - 1.0f);
    if (m > aMax) aMax = m;
    if (k >= MODEL_AFTER_SAMPLES - 2 * ORIENTATION_SAMPLES) {
      for (int j = 0; j < 3; j++) afterDir[j] += v[j] / (2 * ORIENTATION_SAMPLES);
    }
  }
  double aMean = aSum / afterN;

  // before_direction = rows -50..-26 = around[:25] (firstDir).
  float features[FALL_FEATURES] = {
      mx,
      mn,
      (float)mean,
      (float)(sumSq / aroundN - mean * mean),
      angleBetweenDeg(firstDir, lastDir),
      (float)sqrt(fmax(0.0, aSumSq / afterN - aMean * aMean)),
      (float)(offSum / afterN),
      aMax,
      angleBetweenDeg(firstDir, afterDir),
  };
  float out[2] = {0, 0};
  fall_model_predict_proba(features, FALL_FEATURES, out, 2);
  uint32_t us = micros() - t0;
  *scoreOut = out[1];
  Serial.printf("MODEL features=%.4f,%.4f,%.4f,%.4f,%.2f,%.4f,%.4f,%.4f,%.2f score=%.3f threshold=%.3f in %lu us\n",
                features[0], features[1], features[2], features[3], features[4], features[5], features[6],
                features[7], features[8], out[1], FALL_SCORE_THRESHOLD, (unsigned long)us);
  if (DUMP_MODEL_WINDOW) {
    // Same 200 rows (clamped x,y,z in g), for ml/features.py: impact is row 50.
    Serial.println("WINDOW begin x,y,z (impact at row 50)");
    for (int k = -MODEL_BEFORE_SAMPLES; k < MODEL_AFTER_SAMPLES; k++) {
      axes(k, v);
      Serial.printf("W %.4f,%.4f,%.4f\n", v[0], v[1], v[2]);
    }
    Serial.println("WINDOW end");
  }
  return true;
}

// ml/watch_model/test_cases.csv through the model: the score must match Python (2 decimals).
void runModelSelfTest() {
  float worst = 0;
  for (int i = 0; i < MODEL_TEST_CASE_COUNT; i++) {
    float out[2] = {0, 0};
    fall_model_predict_proba(MODEL_TEST_CASES[i], FALL_FEATURES, out, 2);
    float diff = fabsf(out[1] - MODEL_TEST_CASES[i][FALL_FEATURES]);
    if (diff > worst) worst = diff;
    Serial.printf("SELFTEST %d watch=%.4f python=%.4f\n", i, out[1], MODEL_TEST_CASES[i][FALL_FEATURES]);
  }
  Serial.printf("SELFTEST %d cases, worst difference %.4f -> %s\n", MODEL_TEST_CASE_COUNT, worst,
                worst < 0.005f ? "OK" : "MISMATCH");
}

void startWatching(const AccelSample &trigger) {
  detectorState = DetectorState::Watching;
  triggerMs = trigger.tMs;
  impactMaxG = trigger.mag;
  impactMs = trigger.tMs;
  freeFall = false;
  gravityAfterSum[0] = gravityAfterSum[1] = gravityAfterSum[2] = 0;
  gravityAfterCount = 0;
  for (bool &s : stillSecond) s = true;

  // Look back in the ring buffer (skip i = 0, the trigger itself).
  float sum[3] = {0, 0, 0};
  int n = 0;
  for (size_t i = 1; i < historyCount; i++) {
    const AccelSample &s = historyAt(i);
    uint32_t age = triggerMs - s.tMs;
    if (age <= FREE_FALL_LOOKBACK_MS && s.mag < FREE_FALL_G) freeFall = true;
    if (age <= GRAVITY_BEFORE_MS) {
      sum[0] += s.x; sum[1] += s.y; sum[2] += s.z;
      n++;
    }
  }
  for (int k = 0; k < 3; k++) gravityBefore[k] = n > 0 ? sum[k] / n : 0;

  Serial.printf("TRIGGER mag=%.2f free_fall=%d\n", trigger.mag, freeFall);
}

void finishWatching() {
  detectorState = DetectorState::Idle;

  int secondsStill = 0;
  for (bool s : stillSecond) if (s) secondsStill++;

  float gravityAfter[3] = {0, 0, 0};
  for (int k = 0; k < 3; k++) gravityAfter[k] = gravityAfterCount > 0 ? gravityAfterSum[k] / gravityAfterCount : 0;
  float angle = angleBetweenDeg(gravityBefore, gravityAfter);
  bool positionChanged = angle > POSITION_CHANGE_DEG;

  bool thresholdFall = impactMaxG > TRIGGER_G &&
                       (secondsStill >= MIN_STILL_SECONDS || positionChanged ||
                        (freeFall && secondsStill >= MIN_STILL_SECONDS_WITH_FREE_FALL));
  bool isFall = thresholdFall;
  float confidence = MODEL_CONFIDENCE;
#if USE_MODEL
  // Score only (no "always ask above 3 g" rule: it would ask on 62 % of strong normal moves).
  // If the window is not complete, fall back to the thresholds.
  float score;
  if (modelScore(&score)) {
    isFall = score > FALL_SCORE_THRESHOLD;
    confidence = score;
  }
#endif

  Serial.printf("CHECK impact_max_g=%.2f seconds_still=%d angle=%.0f free_fall=%d thresholds=%d -> %s\n",
                impactMaxG, secondsStill, angle, freeFall, thresholdFall, isFall ? "FALL" : "no fall");

  if (isFall) {
    onFall({impactMaxG, secondsStill, positionChanged, freeFall, triggerMs, confidence});
  }
}

void updateDetector(const AccelSample &s) {
  if (detectorState == DetectorState::Idle) {
    // A second fall must not be missed: detect in IDLE and also in FOLLOW_UP (decided with
    // Sebastian, 22 nov). Not while asking/waiting: the mic is busy and it would break the rounds.
    bool canDetect = flow == Flow::Idle || flow == Flow::FollowUp;
    if (canDetect && s.mag > TRIGGER_G && (int32_t)(s.tMs - cooldownUntilMs) >= 0) startWatching(s);
    return;
  }

  uint32_t since = s.tMs - triggerMs;
  if (since <= IMPACT_WINDOW_MS && s.mag > impactMaxG) {
    impactMaxG = s.mag;
    impactMs = s.tMs;
  }

  if (since >= GRAVITY_AFTER_FROM_MS && since < GRAVITY_AFTER_TO_MS) {
    gravityAfterSum[0] += s.x; gravityAfterSum[1] += s.y; gravityAfterSum[2] += s.z;
    gravityAfterCount++;
  }

  if (since >= IMPACT_WINDOW_MS && since < IMPACT_WINDOW_MS + STILL_WATCH_MS) {
    size_t second = (since - IMPACT_WINDOW_MS) / 1000;
    if (s.mag < STILL_MIN_G || s.mag > STILL_MAX_G) stillSecond[second] = false;
  }

  if (since >= IMPACT_WINDOW_MS + STILL_WATCH_MS) finishWatching();
}

void onSimulateFall(lv_event_t *e) {
  if (lv_event_get_code(e) != LV_EVENT_CLICKED) return;
  // Not in the middle of a conversation (and never re-entrantly from a blocking step, where
  // refreshScreenNow() runs the UI): that would ask a third time and confuse the server.
  if (audioBusy || (flow != Flow::Idle && flow != Flow::FollowUp)) {
    Serial.printf("SIMULATE ignored in %s\n", flowName(flow));
    return;
  }
  Serial.println("SIMULATE fall button");
  detectorState = DetectorState::Idle;
  onFall({SIMULATED_IMPACT_G, (int)(STILL_WATCH_MS / 1000), true, false, millis(), MODEL_CONFIDENCE});
}

void setupScreen() {
  beginLvglHelper(instance);

  statusLabel = lv_label_create(lv_screen_active());
  lv_obj_set_style_text_font(statusLabel, &lv_font_montserrat_28, 0);
  lv_label_set_text(statusLabel, "Watching");
  lv_obj_align(statusLabel, LV_ALIGN_TOP_MID, 0, 12);

  valuesLabel = lv_label_create(lv_screen_active());
  lv_obj_set_style_text_font(valuesLabel, &lv_font_montserrat_20, 0);
  lv_label_set_text(valuesLabel, "");
  lv_obj_align(valuesLabel, LV_ALIGN_TOP_LEFT, 12, 55);
  lv_obj_set_width(valuesLabel, 216);                       // Emily's reply wraps
  lv_label_set_long_mode(valuesLabel, LV_LABEL_LONG_WRAP);

  wifiLabel = lv_label_create(lv_screen_active());
  lv_obj_set_style_text_font(wifiLabel, &lv_font_montserrat_16, 0);
  lv_label_set_text(wifiLabel, "No WiFi");
  lv_obj_align(wifiLabel, LV_ALIGN_BOTTOM_RIGHT, -10, -66);

  stateLabel = lv_label_create(lv_screen_active());
  lv_obj_set_style_text_font(stateLabel, &lv_font_montserrat_14, 0);
  lv_label_set_text(stateLabel, flowName(flow));
  lv_obj_align(stateLabel, LV_ALIGN_BOTTOM_LEFT, 10, -68);

  lv_obj_t *btn = lv_button_create(lv_screen_active());
  lv_obj_set_size(btn, 200, 50);
  lv_obj_align(btn, LV_ALIGN_BOTTOM_MID, 0, -10);
  lv_obj_add_event_cb(btn, onSimulateFall, LV_EVENT_CLICKED, NULL);
  lv_obj_t *btnLabel = lv_label_create(btn);
  lv_obj_set_style_text_font(btnLabel, &lv_font_montserrat_20, 0);
  lv_label_set_text(btnLabel, "Simulate fall");
  lv_obj_center(btnLabel);
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  bootId = esp_random() & 0xFFFFFF;  // fallId prefix, different on every boot
  instance.begin();
  // Turn the backlight on so the screen shows the watch is alive.
  instance.setBrightness(DEVICE_MAX_BRIGHTNESS_LEVEL);

  // FS_8G so a 3 g impact is not clipped (the library example uses FS_2G).
  if (!instance.sensor->configAccelerometer(OperationMode::NORMAL,
                                            AccelFullScaleRange::FS_8G,
                                            50.0f,
                                            AccelBandwidth::OSR2_AVG2,
                                            AccelPerfMode::CIC_AVG_MODE)) {
    while (true) {
      Serial.println("Failed to configure accelerometer");
      delay(1000);
    }
  }

  setupScreen();
  lv_timer_handler();  // draw the screen before the (up to 15 s) WiFi wait
  connectWifi();
  xTaskCreatePinnedToCore(sendTask, "sendFall", SEND_TASK_STACK, nullptr, 1, nullptr, 0);

  if (PRINT_RAW_SAMPLES) Serial.println("t_ms,x,y,z,mag");
  if (RUN_MODEL_SELF_TEST) runModelSelfTest();
  Serial.println("READY");
  nextSampleMs = millis();
}

void loop() {
  instance.loop();
  lv_timer_handler();
  if (askRequested) {
    askRequested = false;
    askAndRecord(askRound);
  }
  if (replyReady) handleReply();
  updateFlow();
  updateSendScreen();
  updateWifiScreen();

  uint32_t now = millis();
  if ((int32_t)(now - nextSampleMs) < 0) return;
  nextSampleMs += SAMPLE_PERIOD_MS;
  // If we fell far behind, resync instead of bursting to catch up.
  if ((int32_t)(now - nextSampleMs) > (int32_t)SAMPLE_PERIOD_MS) nextSampleMs = now + SAMPLE_PERIOD_MS;

  AccelSample s;
  if (!readAccel(s)) return;
  addSample(s);
  updateDetector(s);

  if (PRINT_RAW_SAMPLES) {
    Serial.printf("%lu,%.3f,%.3f,%.3f,%.3f\n", (unsigned long)s.tMs, s.x, s.y, s.z, s.mag);
  }
}
