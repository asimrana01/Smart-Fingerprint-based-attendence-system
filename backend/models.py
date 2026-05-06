from pydantic import BaseModel
from typing import Optional

class StudentCreate(BaseModel):
    name:       str
    ag_number:  str
    fp_id:      int
    class_name: str
    section:    str
    semester:   str

class StudentUpdate(BaseModel):
    name:       Optional[str] = None
    ag_number:  Optional[str] = None
    fp_id:      Optional[int] = None
    class_name: Optional[str] = None
    section:    Optional[str] = None
    semester:   Optional[str] = None

class AttendanceScan(BaseModel):
    fp_id:      int
    confidence: Optional[int] = 0

class AttendanceUpdate(BaseModel):
    status: str   # 'present' or 'absent'
