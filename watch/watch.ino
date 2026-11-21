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

// ---- Tunable constants ----
const uint32_t SERIAL_BAUD = 115200;
const uint32_t SAMPLE_PERIOD_MS = 20;    // 50 Hz
const float STANDARD_GRAVITY = 9.80665f; // m/s² per g
const size_t HISTORY_SAMPLES = 150;      // 3 s at 50 Hz
const bool PRINT_RAW_SAMPLES = false;   // true = print every sample (CJ-4 test / Serial Plotter)

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
const size_t RECORD_SECONDS = 5;
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
};

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

// The question and the recording block for ~8 s, so they run from loop(), not from a UI callback.
bool askRequested = false;
int recordingsDone = 0;

// Screen.
lv_obj_t *statusLabel;
lv_obj_t *valuesLabel;
lv_obj_t *wifiLabel;
uint32_t nextWifiRefreshMs = 0;

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
  // Round 1: fall -> vibrate -> "Are you OK?" -> record 5 s -> POST /fall with the audio.
  fallToSend = f;
  askRequested = true;
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
void askAndRecord() {
  AudioOutputIf *out = instance.getAudioOutput();
  AudioInputIf *in = instance.getAudioInput();
  audioBusy = true;

  lv_label_set_text(statusLabel, "Are you OK?");
  refreshScreenNow();
  out->setVolume(SPEAKER_VOLUME);
  out->playWAV((uint8_t *)are_you_ok_wav, are_you_ok_wav_len);
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
  sendStatus = SendStatus::Sending;  // so the screen never shows the previous fall's status
  sendRequested = true;
  taskEXIT_CRITICAL(&handoffMux);
  if (older) free(older);

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
int postFall(const FallEvent &f, uint8_t *audio, size_t len, uint32_t timeoutMs) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("SEND no WiFi");
    return -1;
  }
  String url = String(CONVEX_SITE_URL) + "/fall?device=" + DEVICE_ID + "&round=1" +
               "&impact=" + String(f.impactMaxG, 2) + "&still=" + String(f.secondsStill) +
               "&position=" + (f.positionChanged ? "1" : "0") +
               "&confidence=" + String(MODEL_CONFIDENCE, 2);

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

  uint8_t *wav = nullptr;
  size_t wavLen = 0;
  // The message is marked delivered before we download, so retry the audio once.
  if (hasAudio && !getReplyWav(audioUrl, &wav, &wavLen)) getReplyWav(audioUrl, &wav, &wavLen);

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
    audioToSend = nullptr;
    audioToSendLen = 0;
    sendRequested = false;
    sendStatus = SendStatus::Sending;
    taskEXIT_CRITICAL(&handoffMux);

    // With audio: wait a little for WiFi (a short hotspot blip should not cost the clip),
    // then one try + one retry. After that, send without audio so the alert still goes out.
    int code = -1;
    for (int i = 0; audio && code != 200 && !isFinalError(code) && i < AUDIO_SEND_TRIES; i++) {
      if (!waitForWifi(AUDIO_WIFI_WAIT_MS)) break;
      code = postFall(f, audio, audioLen, AUDIO_HTTP_TIMEOUT_MS);
    }
    if (audio) free(audio);
    if (code != 200 && !isFinalError(code)) {
      noConnectionBuzz = true;
      code = postFall(f, nullptr, 0, HTTP_TIMEOUT_MS);
    }
    // Keep trying until it is sent or a newer fall replaces it (HANDOFF section 7: the incident
    // goes out when the connection comes back; the server merges repeats within 60 s).
    for (int retry = 1; code != 200 && !isFinalError(code) && !sendRequested; retry++) {
      sendStatus = SendStatus::Retrying;
      Serial.printf("SEND retry %d in %lu ms (no audio)\n", retry, (unsigned long)SEND_RETRY_MS);
      vTaskDelay(pdMS_TO_TICKS(SEND_RETRY_MS));
      nudgeWifi();
      if (WiFi.status() == WL_CONNECTED) code = postFall(f, nullptr, 0, HTTP_TIMEOUT_MS);
    }
    if (isFinalError(code)) Serial.printf("SEND gave up: http=%d\n", code);
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
  }
  SendStatus s = sendStatus;
  if (s == shownSendStatus) return;
  shownSendStatus = s;
  if (s == SendStatus::Sending) lv_label_set_text(statusLabel, "Sending...");
  if (s == SendStatus::Sent) lv_label_set_text(statusLabel, "Help notified");
  if (s == SendStatus::Retrying || s == SendStatus::Failed) lv_label_set_text(statusLabel, "No connection");
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
  if (replyAskAgain) Serial.println("REPLY askAgain=1 (round 2 comes in CJ-17)");
  replyReady = false;
  audioBusy = false;
  nextSampleMs = millis();
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

void startWatching(const AccelSample &trigger) {
  detectorState = DetectorState::Watching;
  triggerMs = trigger.tMs;
  impactMaxG = trigger.mag;
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

  bool isFall = impactMaxG > TRIGGER_G &&
                (secondsStill >= MIN_STILL_SECONDS || positionChanged ||
                 (freeFall && secondsStill >= MIN_STILL_SECONDS_WITH_FREE_FALL));

  Serial.printf("CHECK impact_max_g=%.2f seconds_still=%d angle=%.0f free_fall=%d -> %s\n",
                impactMaxG, secondsStill, angle, freeFall, isFall ? "FALL" : "no fall");

  if (isFall) {
    onFall({impactMaxG, secondsStill, positionChanged, freeFall, triggerMs});
  }
}

void updateDetector(const AccelSample &s) {
  if (detectorState == DetectorState::Idle) {
    if (s.mag > TRIGGER_G && (int32_t)(s.tMs - cooldownUntilMs) >= 0) startWatching(s);
    return;
  }

  uint32_t since = s.tMs - triggerMs;
  if (since <= IMPACT_WINDOW_MS && s.mag > impactMaxG) impactMaxG = s.mag;

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
  Serial.println("SIMULATE fall button");
  detectorState = DetectorState::Idle;
  onFall({SIMULATED_IMPACT_G, (int)(STILL_WATCH_MS / 1000), true, false, millis()});
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
  lv_obj_align(wifiLabel, LV_ALIGN_BOTTOM_MID, 0, -66);

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
  Serial.println("READY");
  nextSampleMs = millis();
}

void loop() {
  instance.loop();
  lv_timer_handler();
  if (askRequested) {
    askRequested = false;
    askAndRecord();
  }
  if (replyReady) handleReply();
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
