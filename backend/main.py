from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from contextlib import asynccontextmanager
import json, csv, io
from datetime import date, datetime
from typing import List
from database import init_db, get_db
from models import StudentCreate, StudentUpdate, AttendanceScan, AttendanceUpdate
from crud import (
    create_student, get_all_students, update_student, delete_student,
    record_scan, get_attendance_log, get_today_summary, get_student_by_fp,
    start_session, end_session, get_active_session, get_sessions,
    update_attendance_status
)

# ── State ──────────────────────────────────────────────────────────────────────
enroll_mode:    bool = False
enroll_last_fp: int  = None

# ── WebSocket manager ──────────────────────────────────────────────────────────
class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []
    async def connect(self, ws: WebSocket):
        await ws.accept(); self.active.append(ws)
    def disconnect(self, ws: WebSocket):
        if ws in self.active: self.active.remove(ws)
    async def broadcast(self, data: dict):
        dead = []
        for ws in self.active:
            try: await ws.send_text(json.dumps(data))
            except: dead.append(ws)
        for ws in dead: self.active.remove(ws)

manager = ConnectionManager()

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db(); yield

app = FastAPI(title="AttendX API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── WebSocket ──────────────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await manager.connect(ws)
    try:
        while True: await ws.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(ws)

# ── Session endpoints ──────────────────────────────────────────────────────────
@app.post("/session/start")
async def session_start():
    db = get_db()
    session = start_session(db)
    await manager.broadcast({"event": "session_started", "session": session})
    return session

@app.post("/session/end")
async def session_end():
    db = get_db()
    end_session(db)
    await manager.broadcast({"event": "session_ended"})
    return {"ended": True}

@app.get("/session/active")
def session_active():
    return get_active_session(get_db()) or {}

@app.get("/sessions")
def list_sessions():
    return get_sessions(get_db())

# ── Enroll mode ────────────────────────────────────────────────────────────────
@app.post("/enroll-mode/start")
async def enroll_mode_start():
    global enroll_mode
    enroll_mode = True
    await manager.broadcast({"event": "enroll_mode", "active": True})
    return {"enroll_mode": True}

@app.post("/enroll-mode/cancel")
async def enroll_mode_cancel():
    global enroll_mode
    enroll_mode = False
    await manager.broadcast({"event": "enroll_mode", "active": False})
    return {"enroll_mode": False}

@app.get("/enroll-mode")
def get_enroll_mode():
    return {"enroll_mode": enroll_mode}

@app.get("/enroll-last")
def get_enroll_last():
    return {"fp_id": enroll_last_fp}

# ── Scan (ESP32) ───────────────────────────────────────────────────────────────
@app.post("/scan")
async def scan(payload: AttendanceScan):
    global enroll_mode, enroll_last_fp

    if enroll_mode:
        enroll_mode    = False
        enroll_last_fp = payload.fp_id
        event = {"event": "enroll_scan", "fp_id": payload.fp_id, "confidence": payload.confidence}
        await manager.broadcast(event)
        return event

    db = get_db()
    session = get_active_session(db)
    if not session:
        return {"status": "no_session", "message": "No active attendance session"}

    student = get_student_by_fp(db, payload.fp_id)
    if not student:
        await manager.broadcast({"event": "scan_unknown", "fp_id": payload.fp_id})
        return {"status": "unknown", "message": "Fingerprint not enrolled"}

    result = record_scan(db, student["id"], session["id"])
    event = {
        "event":      "scan",
        "student_id": student["id"],
        "name":       student["name"],
        "ag_number":  student["ag_number"],
        "fp_id":      student["fp_id"],
        "status":     result["status"],
        "time":       datetime.now().strftime("%H:%M:%S"),
        "date":       str(date.today()),
    }
    await manager.broadcast(event)
    return event

# ── Students ───────────────────────────────────────────────────────────────────
@app.get("/students")
def list_students():
    return get_all_students(get_db())

@app.post("/students")
async def add_student(payload: StudentCreate):
    db = get_db()
    try:
        student = create_student(db, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await manager.broadcast({"event": "student_added", "student": student})
    return student

@app.put("/students/{student_id}")
async def edit_student(student_id: int, payload: StudentUpdate):
    db = get_db()
    try:
        student = update_student(db, student_id, payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not student: raise HTTPException(404, "Student not found")
    await manager.broadcast({"event": "student_updated", "student": student})
    return student

@app.delete("/students/{student_id}")
async def remove_student(student_id: int):
    db = get_db()
    if not delete_student(db, student_id): raise HTTPException(404, "Student not found")
    await manager.broadcast({"event": "student_deleted", "student_id": student_id})
    return {"deleted": student_id}

# ── Attendance ─────────────────────────────────────────────────────────────────
@app.get("/attendance")
def attendance_log(start: str = None, end: str = None, student_id: int = None):
    return get_attendance_log(get_db(), start, end, student_id)

@app.get("/attendance/today")
def today_summary():
    return get_today_summary(get_db())

@app.patch("/attendance/{attendance_id}")
async def patch_attendance(attendance_id: int, payload: AttendanceUpdate):
    if payload.status not in ("present", "absent"):
        raise HTTPException(400, "status must be 'present' or 'absent'")
    db = get_db()
    rec = update_attendance_status(db, attendance_id, payload)
    if not rec: raise HTTPException(404, "Record not found")
    await manager.broadcast({"event": "attendance_updated", "record": rec})
    return rec

# ── Export ─────────────────────────────────────────────────────────────────────
@app.get("/export/csv")
def export_csv(start: str = None, end: str = None):
    rows = get_attendance_log(get_db(), start, end)
    buf  = io.StringIO()
    w    = csv.writer(buf)
    w.writerow(["Date","Name","AG Number","FP ID","Class","Section","Semester","Time","Status"])
    for r in rows:
        w.writerow([r["date"], r["name"], r["ag_number"],
                    f"FP-{str(r['fp_id']).zfill(3)}",
                    r["class_name"], r["section"], r["semester"],
                    r["time"] or "—", r["status"]])
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=attendance.csv"})
