// Emily watch firmware (LilyGO T-Watch S3).
// CJ-4: read the BMA423 accelerometer at 50 Hz and keep the last 3 s in a ring buffer.
// CJ-5: detect a fall with thresholds, vibrate and show the values on screen.

#include <LilyGoLib.h>
#include <LV_Helper.h>
#include <math.h>

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

// Screen.
lv_obj_t *statusLabel;
lv_obj_t *valuesLabel;

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

void vibrate() {
  for (uint8_t i = 0; i < VIBRATION_REPEATS; i++) instance.drv.setWaveform(i, VIBRATION_EFFECT);
  instance.drv.setWaveform(VIBRATION_REPEATS, 0);  // end of sequence
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

  if (PRINT_RAW_SAMPLES) Serial.println("t_ms,x,y,z,mag");
  Serial.println("READY");
  nextSampleMs = millis();
}

void loop() {
  instance.loop();
  lv_timer_handler();

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
