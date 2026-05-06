import sqlite3, os

DB_PATH = os.path.join(os.path.dirname(__file__), "attendance.db")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def init_db():
    db = get_db()
    db.executescript("""
        CREATE TABLE IF NOT EXISTS students (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT    NOT NULL,
            ag_number  TEXT    NOT NULL UNIQUE,
            fp_id      INTEGER NOT NULL UNIQUE,
            class_name TEXT    NOT NULL,
            section    TEXT    NOT NULL,
            semester   TEXT    NOT NULL,
            created_at TEXT    DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS attendance_sessions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            date       TEXT    NOT NULL,
            started_at TEXT    NOT NULL,
            ended_at   TEXT,
            active     INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS attendance (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            date       TEXT    NOT NULL,
            time       TEXT    NOT NULL,
            status     TEXT    NOT NULL DEFAULT 'present',
            created_at TEXT    DEFAULT (datetime('now')),
            UNIQUE(session_id, student_id)
        );
    """)
    db.commit()
    db.close()
