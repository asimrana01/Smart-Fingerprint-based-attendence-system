/*
  AttendX — ESP32 Firmware
  ─────────────────────────────────────────────────────────────
  Connections:
    Fingerprint RX  → GPIO16 (ESP32 RX2)
    Fingerprint TX  → GPIO17 (ESP32 TX2)
    Fingerprint 3.3V→ 3.3V
    Fingerprint GND → GND
    Buzzer          → GPIO27
    Green LED       → GPIO25
    Red LED         → GPIO26

  Libraries (Arduino Library Manager):
    • Adafruit Fingerprint Sensor Library
    • ArduinoJson (Benoit Blanchon)
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Adafruit_Fingerprint.h>

// ── Config ──────────────────────────────────────────────────────
const char* SSID     = "YOUR_WIFI_SSID";
const char* PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER   = "http://192.168.1.100:8000";   // your PC local IP

// ── Pins ────────────────────────────────────────────────────────
#define PIN_BUZZER  27
#define PIN_GREEN   25
#define PIN_RED     26
#define FP_RX       16
#define FP_TX       17

// ── Sensor ──────────────────────────────────────────────────────
HardwareSerial fpSerial(2);
Adafruit_Fingerprint finger(&fpSerial);

// ── State ────────────────────────────────────────────────────────
bool enrollMode    = false;
bool fingerWasDown = false;
unsigned long lastPoll = 0;
const unsigned long POLL_MS = 500;

// ════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_GREEN,  OUTPUT);
  pinMode(PIN_RED,    OUTPUT);

  fpSerial.begin(57600, SERIAL_8N1, FP_RX, FP_TX);
  delay(200);
  finger.begin(57600);

  // Connect WiFi
  Serial.print("Connecting WiFi");
  WiFi.begin(SSID, PASSWORD);
  int t = 0;
  while (WiFi.status() != WL_CONNECTED && t < 40) { delay(500); Serial.print("."); t++; }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nIP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\nWiFi failed — restarting"); ESP.restart();
  }

  // Verify sensor
  if (finger.verifyPassword()) {
    finger.getParameters();
    Serial.printf("Sensor OK  Capacity:%d\n", finger.capacity);
    beep(1, 150); greenFlash(1);
  } else {
    Serial.println("Sensor NOT found"); redFlash(5); while (1);
  }
}

// ════════════════════════════════════════════════════════════════
void loop() {
  // Poll server for enroll mode
  if (millis() - lastPoll >= POLL_MS) {
    lastPoll = millis();
    pollEnrollMode();
  }

  // Blink green while waiting to enroll
  if (enrollMode) digitalWrite(PIN_GREEN, (millis() / 400) % 2);

  // ── Finger detection ────────────────────────────────────────
  uint8_t img = finger.getImage();

  if (img == FINGERPRINT_NOFINGER) {
    if (fingerWasDown) {
      fingerWasDown = false;
      digitalWrite(PIN_GREEN, LOW);
      digitalWrite(PIN_RED,   LOW);
    }
    delay(60); return;
  }

  if (img != FINGERPRINT_OK) { delay(80); return; }

  // Finger is down
  fingerWasDown = true;
  delay(80);  // let image stabilise

  if (enrollMode) {
    // ── ENROLL MODE: store new fingerprint into sensor ─────────
    handleEnroll();
  } else {
    // ── ATTENDANCE MODE: search existing fingerprint ───────────
    handleAttendance();
  }

  waitForFingerUp();
}

// ────────────────────────────────────────────────────────────────
// ENROLL: capture finger twice, store in next free slot, notify server
// ────────────────────────────────────────────────────────────────
void handleEnroll() {
  Serial.println("=== ENROLL MODE ===");

  // Find next free slot
  int slot = getNextFreeSlot();
  if (slot < 0) {
    Serial.println("Sensor full!");
    redFlash(4); beep(2, 300);
    cancelEnrollMode();
    return;
  }
  Serial.printf("Using slot: %d\n", slot);

  // ── Capture 1 ─────────────────────────────────────────────
  Serial.println("Capture 1 — finger on sensor");
  greenFlash(1);  // signal: place finger

  uint8_t p = FINGERPRINT_IMAGEFAIL;
  for (int i = 0; i < 5; i++) {
    p = finger.getImage();
    if (p == FINGERPRINT_OK) break;
    delay(100);
  }
  if (p != FINGERPRINT_OK) { Serial.println("Image 1 failed"); redFlash(2); cancelEnrollMode(); return; }

  p = finger.image2Tz(1);
  if (p != FINGERPRINT_OK) { Serial.println("Tz1 failed"); redFlash(2); cancelEnrollMode(); return; }

  Serial.println("Capture 1 OK — lift finger");
  beep(1, 80);
  waitForFingerUp();
  delay(600);

  // ── Capture 2 ─────────────────────────────────────────────
  Serial.println("Capture 2 — place same finger again");
  greenFlash(2);

  p = FINGERPRINT_IMAGEFAIL;
  for (int i = 0; i < 30; i++) {   // wait up to 3s for second placement
    p = finger.getImage();
    if (p == FINGERPRINT_OK) break;
    delay(100);
  }
  if (p != FINGERPRINT_OK) { Serial.println("Image 2 failed"); redFlash(2); cancelEnrollMode(); return; }

  p = finger.image2Tz(2);
  if (p != FINGERPRINT_OK) { Serial.println("Tz2 failed"); redFlash(2); cancelEnrollMode(); return; }

  // ── Create model ───────────────────────────────────────────
  p = finger.createModel();
  if (p != FINGERPRINT_OK) {
    Serial.println("createModel failed — fingers didn't match");
    redFlash(3); beep(2, 200);
    cancelEnrollMode(); return;
  }

  // ── Store model ─────────────────────────────────────────────
  p = finger.storeModel(slot);
  if (p != FINGERPRINT_OK) {
    Serial.println("storeModel failed");
    redFlash(3); cancelEnrollMode(); return;
  }

  Serial.printf("Fingerprint stored in slot %d\n", slot);
  greenFlash(3); beep(3, 80);

  // ── Notify server ────────────────────────────────────────────
  enrollMode = false;   // clear before HTTP call
  sendEnrollResult(slot);
}

// ────────────────────────────────────────────────────────────────
// ATTENDANCE: search and POST to /scan
// ────────────────────────────────────────────────────────────────
void handleAttendance() {
  // image2Tz with retry
  uint8_t tz = FINGERPRINT_IMAGEFAIL;
  for (int i = 0; i < 3; i++) {
    tz = finger.image2Tz();
    if (tz == FINGERPRINT_OK) break;
    delay(60);
    finger.getImage();
  }
  if (tz != FINGERPRINT_OK) { redFlash(1); return; }

  uint8_t sr = finger.fingerSearch();
  if (sr == FINGERPRINT_OK) {
    int fpID = finger.fingerID, conf = finger.confidence;
    Serial.printf("Match: slot=%d  conf=%d\n", fpID, conf);
    if (conf < 40) { Serial.println("Low confidence — rejected"); redFlash(2); return; }
    sendScan(fpID, conf);
  } else if (sr == FINGERPRINT_NOTFOUND) {
    Serial.println("No match");
    redFlash(2); beep(1, 350);
  } else {
    Serial.printf("Search err: %d\n", sr);
    redFlash(1);
  }
}

// ────────────────────────────────────────────────────────────────
// Find the first empty slot in the sensor's database
// ────────────────────────────────────────────────────────────────
int getNextFreeSlot() {
  finger.getParameters();
  for (int i = 1; i <= finger.capacity; i++) {
    uint8_t p = finger.loadModel(i);
    if (p != FINGERPRINT_OK) return i;   // slot is empty
  }
  return -1;   // full
}

// ────────────────────────────────────────────────────────────────
// POST enroll result to /scan (server sees enroll_mode=true)
// ────────────────────────────────────────────────────────────────
void sendEnrollResult(int slot) {
  if (WiFi.status() != WL_CONNECTED) { reconnectWiFi(); return; }
  HTTPClient http;
  http.begin(String(SERVER) + "/scan");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);

  StaticJsonDocument<128> doc;
  doc["fp_id"]      = slot;
  doc["confidence"] = 100;
  String body; serializeJson(doc, body);
  int code = http.POST(body);

  if (code == 200) {
    Serial.println("Enroll notified server OK — slot=" + String(slot));
  } else {
    Serial.printf("Server error on enroll: %d\n", code);
  }
  http.end();
}

// ────────────────────────────────────────────────────────────────
// POST attendance scan to /scan
// ────────────────────────────────────────────────────────────────
void sendScan(int fpID, int confidence) {
  if (WiFi.status() != WL_CONNECTED) { reconnectWiFi(); return; }
  HTTPClient http;
  http.begin(String(SERVER) + "/scan");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);

  StaticJsonDocument<128> doc;
  doc["fp_id"]      = fpID;
  doc["confidence"] = confidence;
  String body; serializeJson(doc, body);
  int code = http.POST(body);

  if (code == 200) {
    StaticJsonDocument<256> res;
    deserializeJson(res, http.getString());
    const char* ev     = res["event"]  | "";
    const char* status = res["status"] | "";

    if      (strcmp(status, "present")    == 0) { greenFlash(2); beep(2, 100); }
    else if (strcmp(status, "already")    == 0) { greenFlash(1); beep(1, 300); }
    else if (strcmp(status, "no_session") == 0) { redFlash(1);  beep(1, 500); Serial.println("No active session"); }
    else                                         { redFlash(2);  beep(1, 500); }
  } else {
    Serial.printf("HTTP %d\n", code); redFlash(3);
  }
  http.end();
}

// Cancel enroll mode on server
void cancelEnrollMode() {
  enrollMode = false;
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.begin(String(SERVER) + "/enroll-mode/cancel");
  http.addHeader("Content-Type","application/json");
  http.POST("{}");
  http.end();
}

// Poll /enroll-mode
void pollEnrollMode() {
  if (WiFi.status() != WL_CONNECTED) { reconnectWiFi(); return; }
  HTTPClient http;
  http.begin(String(SERVER) + "/enroll-mode");
  http.setTimeout(2000);
  int code = http.GET();
  if (code == 200) {
    StaticJsonDocument<64> doc;
    deserializeJson(doc, http.getString());
    bool nm = doc["enroll_mode"] | false;
    if (nm != enrollMode) {
      enrollMode = nm;
      Serial.println(enrollMode ? "ENROLL MODE ON" : "ENROLL MODE OFF");
      if (enrollMode) { beep(2, 70); }
    }
  }
  http.end();
}

// Wait for finger to be lifted
void waitForFingerUp() {
  int c = 0;
  while (c < 4) {
    delay(60);
    if (finger.getImage() == FINGERPRINT_NOFINGER) c++;
    else c = 0;
  }
  fingerWasDown = false;
  digitalWrite(PIN_GREEN, LOW); digitalWrite(PIN_RED, LOW);
  delay(200);
}

void reconnectWiFi() {
  WiFi.disconnect(); WiFi.begin(SSID, PASSWORD);
  int t = 0;
  while (WiFi.status() != WL_CONNECTED && t < 20) { delay(500); t++; }
}

void greenFlash(int n) { for(int i=0;i<n;i++){digitalWrite(PIN_GREEN,HIGH);delay(200);digitalWrite(PIN_GREEN,LOW);delay(80);} }
void redFlash(int n)   { for(int i=0;i<n;i++){digitalWrite(PIN_RED,HIGH);delay(200);digitalWrite(PIN_RED,LOW);delay(80);} }
void beep(int n,int ms){ for(int i=0;i<n;i++){digitalWrite(PIN_BUZZER,HIGH);delay(ms);digitalWrite(PIN_BUZZER,LOW);delay(70);} }

/*
  ── HOW ENROLL WORKS NOW ─────────────────────────────────────
  Teacher clicks "Enroll Student" → clicks "Scan Finger" in portal
  Server sets enroll_mode = true
  ESP32 picks it up within 500ms → beeps twice + green blinks
  
  SCAN 1: Place finger → green flash once → LIFT finger
  SCAN 2: Place SAME finger again → green flash twice
  
  ESP32 creates + stores model in next free slot automatically
  Sends slot number to server → portal auto-fills FP ID
  Teacher fills name, AG, class, section, semester → Save
  
  Next time that finger scans → attendance recorded normally
  ─────────────────────────────────────────────────────────────
*/
