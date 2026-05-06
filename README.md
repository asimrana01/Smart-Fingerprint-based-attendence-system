# Smart Attendance System — Setup Guide

## Project Structure
```
attendance_system/
├── backend/
│   ├── main.py          ← FastAPI app (WebSocket + REST)
│   ├── database.py      ← SQLite setup
│   ├── models.py        ← Pydantic request models
│   ├── crud.py          ← All DB operations
│   └── requirements.txt
├── frontend/
│   ├── index.html       ← Main portal
│   ├── style.css        ← Stylesheet
│   └── app.js           ← All JS logic
└── esp32/
    └── attendance_esp32.ino  ← Arduino firmware
```

---

## 1. Backend Setup

```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

API will be at: http://localhost:8000  
Docs at:        http://localhost:8000/docs

---

## 2. Frontend Setup

Just open `frontend/index.html` in any browser.  
No build step needed — pure HTML/CSS/JS.

If you want to serve it properly:
```bash
cd frontend
python -m http.server 5500
```
Then open: http://localhost:5500

---

## 3. ESP32 Setup

### Arduino IDE
1. Install ESP32 board support (Espressif)
2. Install libraries via Library Manager:
   - **Adafruit Fingerprint Sensor Library**
   - **ArduinoJson** (by Benoit Blanchon)

### Configure the sketch
Open `esp32/attendance_esp32.ino` and edit:
```cpp
const char* SSID     = "YOUR_WIFI_SSID";
const char* PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER   = "http://192.168.1.xxx:8000";  // your PC's local IP
```

Find your PC's IP:
- Windows: `ipconfig` → look for IPv4 under your WiFi adapter
- Linux/Mac: `ifconfig` → look for `inet` under `wlan0` or `en0`

### Upload
Select board: **ESP32 Dev Module**, port: your COM port, then upload.

---

## 4. Enrolling Fingerprints

1. Use **Adafruit's enroll example** first:
   `File → Examples → Adafruit Fingerprint Sensor Library → enroll`
2. Open Serial Monitor (115200 baud)
3. Enter the slot number — **this must match the FP ID you enter in the portal**
4. Scan the finger twice when prompted
5. In the portal → Students tab → Enroll Student
6. Enter the same FP ID number you used in step 3

---

## 5. How FP ID flows through the system

```
Sensor stores fingerprint in slot 3
         ↓
ESP32 scans → finds slot 3 → POST /scan { fp_id: 3 }
         ↓
FastAPI looks up student with fp_id=3 in DB
         ↓
Records attendance → broadcasts via WebSocket
         ↓
Portal updates in real time
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /scan | ESP32 posts a scan |
| GET | /students | List all students |
| POST | /students | Add student |
| PUT | /students/{id} | Edit student |
| DELETE | /students/{id} | Remove student |
| GET | /attendance | Full log (filterable) |
| GET | /attendance/today | Today's summary |
| GET | /export/csv | Download CSV |
| WS | /ws | Real-time WebSocket |

---

## Troubleshooting

**Portal shows "Disconnected"**  
→ Make sure FastAPI is running. Check the WS URL in app.js matches your server.

**ESP32 not connecting**  
→ Check SSID/password. Open Serial Monitor to see connection status.

**Fingerprint not recognised**  
→ The slot number in the sensor must match the fp_id in the database exactly.

**CORS error in browser**  
→ The FastAPI backend already has `allow_origins=["*"]`. Make sure you're hitting the right port (8000).
# Smart-Fingerprint-based-attendence-system
