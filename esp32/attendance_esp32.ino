/*
  Smart Attendance System — ESP32 Firmware
  Connections:
    Fingerprint RX  → ESP32 TX2 (GPIO17)
    Fingerprint TX  → ESP32 RX2 (GPIO16)
    Buzzer → GPIO 27 | Green LED → GPIO 25 | Red LED → GPIO 26

  Libraries needed:
    - Adafruit Fingerprint Sensor Library
    - ArduinoJson
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Adafruit_Fingerprint.h>

const char* SSID     = "YOUR_WIFI_SSID";
const char* PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER   = "http://192.168.1.100:8000";  // your PC's local IP

#define PIN_BUZZER  27
#define PIN_GREEN   25
#define PIN_RED     26
#define FP_RX       16
#define FP_TX       17

HardwareSerial fpSerial(2);
Adafruit_Fingerprint finger(&fpSerial);

bool enrollMode = false;
unsigned long lastPoll = 0;
const unsigned long POLL_MS = 500;

void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_GREEN,  OUTPUT);
  pinMode(PIN_RED,    OUTPUT);

  fpSerial.begin(57600, SERIAL_8N1, FP_RX, FP_TX);
  finger.begin(57600);

  Serial.print("Connecting to WiFi");
  WiFi.begin(SSID, PASSWORD);
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println("\nConnected: " + WiFi.localIP().toString());

  if (finger.verifyPassword()) {
    Serial.println("Fingerprint sensor OK");
    beep(1, 100); greenFlash(1);
  } else {
    Serial.println("Sensor NOT found!");
    redFlash(3); while (true);
  }
}

void loop() {
  if (millis() - lastPoll >= POLL_MS) {
    lastPoll = millis();
    pollEnrollMode();
  }

  if (enrollMode) {
    digitalWrite(PIN_GREEN, (millis() / 300) % 2);
  }

  int fpID = getFingerprintID();
  if (fpID > 0) {
    Serial.printf("Match: FP-ID=%d  confidence=%d\n", fpID, finger.confidence);
    sendScan(fpID, finger.confidence);
    digitalWrite(PIN_GREEN, LOW);
  }

  delay(50);
}

void pollEnrollMode() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.begin(String(SERVER) + "/enroll-mode");
  int code = http.GET();
  if (code == 200) {
    StaticJsonDocument<64> doc;
    deserializeJson(doc, http.getString());
    bool newMode = doc["enroll_mode"];
    if (newMode != enrollMode) {
      enrollMode = newMode;
      Serial.println(enrollMode ? ">>> ENROLL MODE ON" : ">>> ENROLL MODE OFF");
      if (enrollMode) { beep(2, 60); }
    }
  }
  http.end();
}

int getFingerprintID() {
  uint8_t p = finger.getImage();
  if (p != FINGERPRINT_OK) return -1;
  p = finger.image2Tz();
  if (p != FINGERPRINT_OK) return -1;
  p = finger.fingerSearch();
  if (p == FINGERPRINT_OK)       return finger.fingerID;
  if (p == FINGERPRINT_NOTFOUND) { redFlash(1); return 0; }
  return -1;
}

void sendScan(int fpID, int confidence) {
  if (WiFi.status() != WL_CONNECTED) { WiFi.reconnect(); return; }
  HTTPClient http;
  http.begin(String(SERVER) + "/scan");
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<128> doc;
  doc["fp_id"]      = fpID;
  doc["confidence"] = confidence;
  String body; serializeJson(doc, body);

  int code = http.POST(body);
  if (code == 200) {
    StaticJsonDocument<256> res;
    deserializeJson(res, http.getString());
    const char* event = res["event"];

    if (strcmp(event, "enroll_scan") == 0) {
      greenFlash(3); beep(3, 60);
      Serial.printf("Enroll scan sent: FP-%d\n", fpID);
    } else {
      const char* status = res["status"];
      if      (strcmp(status, "present") == 0) { greenFlash(2); beep(2, 80); }
      else if (strcmp(status, "already") == 0) { greenFlash(1); beep(1, 200); }
      else                                      { redFlash(2);  beep(1, 400); }
    }
  } else {
    Serial.printf("HTTP error: %d\n", code);
    redFlash(3);
  }
  http.end();
}

void greenFlash(int n) {
  for (int i=0;i<n;i++){digitalWrite(PIN_GREEN,HIGH);delay(180);digitalWrite(PIN_GREEN,LOW);delay(80);}
}
void redFlash(int n) {
  for (int i=0;i<n;i++){digitalWrite(PIN_RED,HIGH);delay(180);digitalWrite(PIN_RED,LOW);delay(80);}
}
void beep(int n, int ms) {
  for (int i=0;i<n;i++){digitalWrite(PIN_BUZZER,HIGH);delay(ms);digitalWrite(PIN_BUZZER,LOW);delay(70);}
}
