import sqlite3
from datetime import date, datetime
from models import StudentCreate, StudentUpdate, AttendanceUpdate

def row_to_dict(row):
    return dict(row) if row else None

# ── Students ──────────────────────────────────────────────────────────────────
def get_all_students(db):
    rows = db.execute(
        "SELECT id, name, ag_number, fp_id, class_name, section, semester, created_at FROM students ORDER BY id"
    ).fetchall()
    return [row_to_dict(r) for r in rows]

def get_student_by_fp(db, fp_id: int):
    row = db.execute(
        "SELECT id, name, ag_number, fp_id, class_name, section, semester FROM students WHERE fp_id = ?",
        (fp_id,)
    ).fetchone()
    return row_to_dict(row)

def create_student(db, payload: StudentCreate):
    try:
        cur = db.execute(
            "INSERT INTO students (name, ag_number, fp_id, class_name, section, semester) VALUES (?,?,?,?,?,?)",
            (payload.name, payload.ag_number, payload.fp_id,
             payload.class_name, payload.section, payload.semester)
        )
        db.commit()
        row = db.execute(
            "SELECT id, name, ag_number, fp_id, class_name, section, semester, created_at FROM students WHERE id = ?",
            (cur.lastrowid,)
        ).fetchone()
        return row_to_dict(row)
    except sqlite3.IntegrityError as e:
        db.rollback()
        raise ValueError(str(e))

def update_student(db, student_id: int, payload: StudentUpdate):
    fields, values = [], []
    if payload.name       is not None: fields.append("name=?");       values.append(payload.name)
    if payload.ag_number  is not None: fields.append("ag_number=?");  values.append(payload.ag_number)
    if payload.fp_id      is not None: fields.append("fp_id=?");      values.append(payload.fp_id)
    if payload.class_name is not None: fields.append("class_name=?"); values.append(payload.class_name)
    if payload.section    is not None: fields.append("section=?");    values.append(payload.section)
    if payload.semester   is not None: fields.append("semester=?");   values.append(payload.semester)
    if not fields: return None
    values.append(student_id)
    try:
        db.execute(f"UPDATE students SET {', '.join(fields)} WHERE id=?", values)
        db.commit()
    except sqlite3.IntegrityError as e:
        db.rollback()
        raise ValueError(str(e))
    row = db.execute(
        "SELECT id, name, ag_number, fp_id, class_name, section, semester, created_at FROM students WHERE id=?",
        (student_id,)
    ).fetchone()
    return row_to_dict(row)

def delete_student(db, student_id: int):
    cur = db.execute("DELETE FROM students WHERE id=?", (student_id,))
    db.commit()
    return cur.rowcount > 0

# ── Sessions ──────────────────────────────────────────────────────────────────
def start_session(db):
    today = str(date.today())
    now   = datetime.now().strftime("%H:%M:%S")
    # close any lingering open session first
    db.execute("UPDATE attendance_sessions SET active=0, ended_at=? WHERE active=1", (now,))
    cur = db.execute(
        "INSERT INTO attendance_sessions (date, started_at, active) VALUES (?,?,1)",
        (today, now)
    )
    db.commit()
    return row_to_dict(db.execute("SELECT * FROM attendance_sessions WHERE id=?", (cur.lastrowid,)).fetchone())

def end_session(db):
    now = datetime.now().strftime("%H:%M:%S")
    db.execute("UPDATE attendance_sessions SET active=0, ended_at=? WHERE active=1", (now,))
    db.commit()

def get_active_session(db):
    row = db.execute("SELECT * FROM attendance_sessions WHERE active=1 ORDER BY id DESC LIMIT 1").fetchone()
    return row_to_dict(row)

def get_sessions(db):
    rows = db.execute("SELECT * FROM attendance_sessions ORDER BY id DESC").fetchall()
    return [row_to_dict(r) for r in rows]

# ── Attendance ────────────────────────────────────────────────────────────────
def record_scan(db, student_id: int, session_id: int):
    today = str(date.today())
    now   = datetime.now().strftime("%H:%M:%S")
    existing = db.execute(
        "SELECT id FROM attendance WHERE session_id=? AND student_id=?",
        (session_id, student_id)
    ).fetchone()
    if existing:
        return {"status": "already"}
    db.execute(
        "INSERT INTO attendance (session_id, student_id, date, time, status) VALUES (?,?,?,?,'present')",
        (session_id, student_id, today, now)
    )
    db.commit()
    return {"status": "present"}

def update_attendance_status(db, attendance_id: int, payload: AttendanceUpdate):
    db.execute("UPDATE attendance SET status=? WHERE id=?", (payload.status, attendance_id))
    db.commit()
    row = db.execute(
        """SELECT a.*, s.name, s.ag_number, s.fp_id, s.class_name, s.section, s.semester
           FROM attendance a JOIN students s ON s.id=a.student_id WHERE a.id=?""",
        (attendance_id,)
    ).fetchone()
    return row_to_dict(row)

def get_today_summary(db, session_id=None):
    today = str(date.today())
    students = db.execute(
        "SELECT id, name, ag_number, fp_id, class_name, section, semester FROM students"
    ).fetchall()

    if session_id:
        att = db.execute(
            "SELECT id, student_id, time, status FROM attendance WHERE session_id=?",
            (session_id,)
        ).fetchall()
    else:
        # get latest session of today
        sess = db.execute(
            "SELECT id FROM attendance_sessions WHERE date=? ORDER BY id DESC LIMIT 1", (today,)
        ).fetchone()
        if sess:
            att = db.execute(
                "SELECT id, student_id, time, status FROM attendance WHERE session_id=?",
                (sess["id"],)
            ).fetchall()
        else:
            att = []

    att_map = {r["student_id"]: {"time": r["time"], "status": r["status"], "att_id": r["id"]} for r in att}

    result = []
    for s in students:
        d = row_to_dict(s)
        rec = att_map.get(s["id"])
        d["status"] = rec["status"] if rec else "absent"
        d["time"]   = rec["time"]   if rec else None
        d["att_id"] = rec["att_id"] if rec else None
        d["date"]   = today
        result.append(d)
    return result

def get_attendance_log(db, start=None, end=None, student_id=None):
    query = """
        SELECT a.id, a.date, a.time, a.status, a.session_id,
               s.id as student_id, s.name, s.ag_number, s.fp_id,
               s.class_name, s.section, s.semester
        FROM attendance a
        JOIN students s ON s.id = a.student_id
        WHERE 1=1
    """
    params = []
    if start:      query += " AND a.date >= ?"; params.append(start)
    if end:        query += " AND a.date <= ?"; params.append(end)
    if student_id: query += " AND a.student_id = ?"; params.append(student_id)
    query += " ORDER BY a.date DESC, a.time DESC"
    rows = db.execute(query, params).fetchall()
    return [row_to_dict(r) for r in rows]
