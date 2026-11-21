// Emily watch firmware (LilyGO T-Watch S3).
// CJ-4: read the BMA423 accelerometer at 50 Hz and keep the last 3 s in a ring buffer.

#include <LilyGoLib.h>
#include <math.h>

// ---- Tunable constants ----
const uint32_t SERIAL_BAUD = 115200;
const uint32_t SAMPLE_PERIOD_MS = 20;   // 50 Hz
const float STANDARD_GRAVITY = 9.80665f; // m/s² per g
const size_t HISTORY_SAMPLES = 150;      // 3 s at 50 Hz (used by CJ-5)

struct AccelSample {
  uint32_t tMs;
  float x, y, z;  // g
  float mag;      // g
};

// Ring buffer: history[historyHead] is the next slot to write.
AccelSample history[HISTORY_SAMPLES];
size_t historyHead = 0;
size_t historyCount = 0;

uint32_t nextSampleMs = 0;

void addSample(const AccelSample &s) {
  history[historyHead] = s;
  historyHead = (historyHead + 1) % HISTORY_SAMPLES;
  if (historyCount < HISTORY_SAMPLES) historyCount++;
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

void setup() {
  Serial.begin(SERIAL_BAUD);
  instance.begin();

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

  Serial.println("t_ms,x,y,z,mag");
  nextSampleMs = millis();
}

void loop() {
  instance.loop();

  uint32_t now = millis();
  if ((int32_t)(now - nextSampleMs) < 0) return;
  nextSampleMs += SAMPLE_PERIOD_MS;
  // If we fell far behind, resync instead of bursting to catch up.
  if ((int32_t)(now - nextSampleMs) > (int32_t)SAMPLE_PERIOD_MS) nextSampleMs = now + SAMPLE_PERIOD_MS;

  AccelSample s;
  if (!readAccel(s)) return;
  addSample(s);

  Serial.printf("%lu,%.3f,%.3f,%.3f,%.3f\n", (unsigned long)s.tMs, s.x, s.y, s.z, s.mag);
}
