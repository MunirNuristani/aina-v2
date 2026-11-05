// bench_test_4ch: read all four perfboard channels, serial output only.
//
// Wiring: perfboard power in <- ESP32 3V3 + GND.
//   header pin 1 -> GPIO34, pin 2 -> GPIO32, pin 3 -> GPIO33, pin 4 -> GPIO35
//   (same pin order the old firmware used; all four are ADC1 pins)
//
// Plug ONE known-good sensor into one connector at a time. Only that channel
// should change between air and water. If another channel moves too, two
// signal lines are touching or coupled.
#include <Arduino.h>

const int PINS[4] = {34, 32, 33, 35};
const int N = 32;

int cmp(const void* a, const void* b) { return *(int*)a - *(int*)b; }

int medianOf(int pin, int* spread) {
  // throwaway read first: the ESP32 ADC's sample-and-hold keeps a little charge
  // from the previous channel, which makes neighbouring channels look
  // like they affect each other even on a clean board
  analogRead(pin);
  delayMicroseconds(200);
  int s[N];
  for (int i = 0; i < N; i++) { s[i] = analogRead(pin); delay(2); }
  qsort(s, N, sizeof(int), cmp);
  *spread = s[N - 1] - s[0];
  return s[N / 2];
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  for (int p : PINS) analogSetPinAttenuation(p, ADC_11db);
  Serial.println("bench_test_4ch ready");
}

void loop() {
  for (int c = 0; c < 4; c++) {
    int spread;
    int m = medianOf(PINS[c], &spread);
    Serial.printf("ch%d med=%4d spr=%3d | ", c + 1, m, spread);
  }
  Serial.println();
  delay(500);
}
