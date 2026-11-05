// bench_test: one capacitive sensor, serial output only.
//
// Wiring: sensor VCC -> 3V3, GND -> GND, signal (AOUT) -> GPIO34.
//
// Run it four ways and note the median + spread each time:
//   1) signal wire unplugged   2) connected, in air
//   3) dipped to the line in a glass of water   4) back in air
#include <Arduino.h>

const int PIN = 34;   // ADC1 pin (ADC2 pins stop working once wifi is on)
const int N = 32;     // samples per printed line

int cmp(const void* a, const void* b) { return *(int*)a - *(int*)b; }

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);                // 0..4095
  analogSetPinAttenuation(PIN, ADC_11db);  // ~0..3.3V range, set explicitly
  Serial.println("bench_test ready");
}

void loop() {
  int s[N];
  for (int i = 0; i < N; i++) { s[i] = analogRead(PIN); delay(10); }
  qsort(s, N, sizeof(int), cmp);
  Serial.printf("min=%d median=%d max=%d spread=%d  ~%dmV\n",
                s[0], s[N / 2], s[N - 1], s[N - 1] - s[0],
                analogReadMilliVolts(PIN));
  delay(500);
}
