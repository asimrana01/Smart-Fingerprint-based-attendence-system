// ── Config ─────────────────────────────────────────
const API = 'http://localhost:8000';
const WS  = 'ws://localhost:8000/ws';

// ── State ───────────────────────────────────────────
let students   = [];
let attendance = [];
let logData    = [];
let session    = null;   // active session object or null
let sessionTimer = null;
let sessionStart = null;

let scannedFP     = null;
let scanPollTimer = null;
let scanTimeout   = null;

// ── Init ────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setTodayLabel();
  connectWS();
  await Promise.all([loadStudents(), loadToday(), loadLog(), checkSession()]);
});

// ── WebSocket ────────────────────────────────────────
let ws, wsRetry = 0;
function connectWS() {
  ws = new WebSocket(WS);
  ws.onopen = () => {
    wsRetry = 0; setWS(true);
    ws._ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 20000);
  };
  ws.onmessage = e => { try { handleEvent(JSON.parse(e.data)); } catch(_){} };
  ws.onclose = () => {
    clearInterval(ws._ping); setWS(false);
    wsRetry = Math.min(wsRetry + 1, 5);
    setTimeout(connectWS, 2000 * wsRetry);
  };
  ws.onerror = () => ws.close();
}
function setWS(ok) {
  document.getElementById('ws-dot').className   = 'ws-dot ' + (ok ? 'connected' : 'disconnected');
  document.getElementById('ws-label').textContent = ok ? 'ESP32 connected' : 'Disconnected';
}

// ── Events ────────────────────────────────────────────
async function handleEvent(ev) {
  if (ev.event === 'scan') {
    flashScanner(ev.status === 'present' ? 'success' : 'fail');
    document.getElementById('scanner-status').textContent =
      ev.status === 'present' ? `✓ ${ev.name} — present` :
      ev.status === 'already' ? `${ev.name} — already recorded` : `Unknown fingerprint`;
    prependFeed(ev);
    await loadToday();
    return;
  }
  if (ev.event === 'enroll_scan') { setFPScanned(ev.fp_id); return; }
  if (ev.event === 'session_started') { session = ev.session; renderSession(); }
  if (ev.event === 'session_ended')   { session = null; renderSession(); await loadToday(); }
  if (ev.event === 'attendance_updated') { await loadToday(); await loadLog(); }
  if (['student_added','student_updated','student_deleted'].includes(ev.event)) {
    await loadStudents(); await loadToday();
  }
}

// ── API ────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Request failed');
  }
  return res.json();
}

// ── Load data ──────────────────────────────────────────
async function loadStudents() { students = await api('GET', '/students'); renderStudents(); }
async function loadToday()    { attendance = await api('GET', '/attendance/today'); renderStats(); renderTodayTable(); }
async function loadLog()      { logData = await api('GET', '/attendance'); renderLog(); }
async function checkSession() {
  const s = await api('GET', '/session/active');
  session = s && s.id ? s : null;
  renderSession();
}

// ── Session ─────────────────────────────────────────────
async function toggleSession() {
  if (session) {
    if (!confirm('End the current attendance session?')) return;
    await api('POST', '/session/end');
    session = null;
  } else {
    session = await api('POST', '/session/start');
    toast('Attendance session started', 'success');
  }
  renderSession();
  await loadToday();
}

function renderSession() {
  const btn    = document.getElementById('session-btn');
  const label  = document.getElementById('session-label');
  const icon   = document.getElementById('session-icon');
  const banner = document.getElementById('session-banner');
  const badge  = document.getElementById('session-status-badge');

  clearInterval(sessionTimer);

  if (session) {
    btn.classList.add('active');
    label.textContent = 'End Attendance';
    icon.innerHTML = '<rect x="6" y="6" width="12" height="12" rx="2"/>';
    banner.classList.remove('hidden');
    badge.textContent = 'Session Active';
    badge.classList.add('active');

    // Start timer
    sessionStart = new Date();
    // Try to use session's started_at if same day
    updateTimer();
    sessionTimer = setInterval(updateTimer, 1000);
  } else {
    btn.classList.remove('active');
    label.textContent = 'Start Attendance';
    icon.innerHTML = '<circle cx="12" cy="12" r="10"/><polygon points="10,8 16,12 10,16"/>';
    banner.classList.add('hidden');
    badge.textContent = 'No Session';
    badge.classList.remove('active');
  }
}

function updateTimer() {
  if (!sessionStart) return;
  const diff = Math.floor((Date.now() - sessionStart) / 1000);
  const mm   = String(Math.floor(diff / 60)).padStart(2,'0');
  const ss   = String(diff % 60).padStart(2,'0');
  document.getElementById('session-timer').textContent = `${mm}:${ss}`;
}

// ── Stats ───────────────────────────────────────────────
function renderStats() {
  const total   = students.length;
  const present = attendance.filter(r => r.status === 'present').length;
  const absent  = total - present;
  const pct     = total ? Math.round(present / total * 100) : 0;
  animateVal('s-total',   total);
  animateVal('s-present', present);
  animateVal('s-absent',  absent);
  document.getElementById('s-pct').textContent = pct + '%';
}

function animateVal(id, target) {
  const el = document.getElementById(id);
  const from = parseInt(el.textContent) || 0;
  if (from === target) return;
  let start = null;
  const step = ts => {
    if (!start) start = ts;
    const p = Math.min((ts - start) / 400, 1);
    el.textContent = Math.round(from + (target - from) * p);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ── Today table ─────────────────────────────────────────
function renderTodayTable() {
  const tbody = document.getElementById('today-tbody');
  if (!attendance.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">No students enrolled</td></tr>';
    return;
  }
  tbody.innerHTML = attendance.map(r => `
    <tr>
      <td><div class="name-cell">
        <div class="av ${avColor(r.student_id)}">${initials(r.name)}</div>
        <div>
          <div style="font-weight:500">${esc(r.name)}</div>
          <div style="font-size:11px;color:var(--text-3)">${esc(r.class_name)} · ${esc(r.section)} · ${esc(r.semester)}</div>
        </div>
      </div></td>
      <td><span class="pill mono">${esc(r.ag_number)}</span></td>
      <td style="color:var(--text-3)">${r.time || '—'}</td>
      <td><span class="pill ${r.status}">${r.status}</span></td>
      <td>${r.att_id
        ? `<select class="status-select ${r.status}" onchange="updateStatus(${r.att_id},this)">
             <option value="present" ${r.status==='present'?'selected':''}>Present</option>
             <option value="absent"  ${r.status==='absent' ?'selected':''}>Absent</option>
           </select>`
        : '<span style="color:var(--text-3);font-size:11px">—</span>'
      }</td>
    </tr>`).join('');
}

async function updateStatus(attId, select) {
  const newStatus = select.value;
  select.className = `status-select ${newStatus}`;
  try {
    await api('PATCH', `/attendance/${attId}`, { status: newStatus });
    toast(`Status updated to ${newStatus}`, 'success');
    await loadToday();
  } catch(err) {
    toast(err.message, 'error');
  }
}

// ── Log table ───────────────────────────────────────────
function renderLog() { applyFilters(); }

function applyFilters() {
  const search = (document.getElementById('log-search')?.value || '').toLowerCase();
  const start  = document.getElementById('log-start')?.value;
  const end    = document.getElementById('log-end')?.value;
  let rows = [...logData];
  if (search) rows = rows.filter(r => r.name.toLowerCase().includes(search) || r.ag_number.toLowerCase().includes(search));
  if (start)  rows = rows.filter(r => r.date >= start);
  if (end)    rows = rows.filter(r => r.date <= end);

  const tbody = document.getElementById('log-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">No records found</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td style="color:var(--text-3)">${r.date}</td>
      <td><div class="name-cell">
        <div class="av ${avColor(r.student_id)}">${initials(r.name)}</div>
        ${esc(r.name)}
      </div></td>
      <td><span class="pill mono">${esc(r.ag_number)}</span></td>
      <td style="color:var(--text-3)">${esc(r.class_name)}</td>
      <td style="color:var(--text-3)">${esc(r.section)}</td>
      <td style="color:var(--text-3)">${esc(r.semester)}</td>
      <td style="color:var(--text-3)">${r.time || '—'}</td>
      <td><span class="pill ${r.status}">${r.status}</span></td>
    </tr>`).join('');
}

function clearFilters() {
  document.getElementById('log-search').value = '';
  document.getElementById('log-start').value  = '';
  document.getElementById('log-end').value    = '';
  applyFilters();
}

// ── Students table ───────────────────────────────────────
function renderStudents() {
  document.getElementById('enrolled-sub').textContent = `${students.length} students enrolled`;
  const tbody = document.getElementById('students-tbody');
  if (!students.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">No students enrolled yet</td></tr>';
    return;
  }
  tbody.innerHTML = students.map(s => `
    <tr>
      <td><div class="name-cell">
        <div class="av ${avColor(s.id)}">${initials(s.name)}</div>
        <div>
          <div style="font-weight:500">${esc(s.name)}</div>
          <div style="font-size:11px;color:var(--text-3)">${s.created_at?.slice(0,10)||'—'}</div>
        </div>
      </div></td>
      <td><span class="pill mono">${esc(s.ag_number)}</span></td>
      <td><span class="pill mono">FP-${String(s.fp_id).padStart(3,'0')}</span></td>
      <td style="color:var(--text-3)">${esc(s.class_name)}</td>
      <td style="color:var(--text-3)">${esc(s.section)}</td>
      <td style="color:var(--text-3)">${esc(s.semester)}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn sm outline" onclick="openModal(${s.id})">Edit</button>
          <button class="btn sm danger"  onclick="deleteStudent(${s.id})">Remove</button>
        </div>
      </td>
    </tr>`).join('');
}

// ── Modal ────────────────────────────────────────────────
function openModal(id) {
  scannedFP = null; resetFPScanUI();
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (id) {
    const s = students.find(x => x.id === id);
    document.getElementById('modal-title').textContent = 'Edit Student';
    document.getElementById('edit-id').value      = s.id;
    document.getElementById('inp-name').value     = s.name;
    document.getElementById('inp-ag').value       = s.ag_number;
    document.getElementById('inp-class').value    = s.class_name;
    document.getElementById('inp-section').value  = s.section;
    document.getElementById('inp-semester').value = s.semester;
    setFPScanned(s.fp_id);
  } else {
    document.getElementById('modal-title').textContent = 'Enroll Student';
    ['edit-id','inp-name','inp-ag','inp-class','inp-section','inp-semester'].forEach(id => document.getElementById(id).value = '');
  }
}

function closeModal() { cancelFPScan(); document.getElementById('modal-overlay').classList.add('hidden'); }
function overlayClick(e) { if (e.target === document.getElementById('modal-overlay')) closeModal(); }

async function submitStudent() {
  const id       = document.getElementById('edit-id').value;
  const name     = document.getElementById('inp-name').value.trim();
  const ag       = document.getElementById('inp-ag').value.trim().toUpperCase();
  const cls      = document.getElementById('inp-class').value.trim();
  const section  = document.getElementById('inp-section').value.trim();
  const semester = document.getElementById('inp-semester').value.trim();

  if (!name || !ag || !cls || !section || !semester) { toast('Fill in all fields', 'error'); return; }
  if (!scannedFP) { toast('Please scan the fingerprint first', 'error'); return; }

  try {
    if (id) {
      await api('PUT', `/students/${id}`, { name, ag_number: ag, fp_id: scannedFP, class_name: cls, section, semester });
      toast('Student updated', 'success');
    } else {
      await api('POST', '/students', { name, ag_number: ag, fp_id: scannedFP, class_name: cls, section, semester });
      toast('Student enrolled successfully', 'success');
    }
    closeModal(); await loadStudents(); await loadToday();
  } catch(err) { toast(err.message, 'error'); }
}

async function deleteStudent(id) {
  if (!confirm('Remove this student and all their attendance records?')) return;
  try {
    await api('DELETE', `/students/${id}`);
    toast('Student removed', 'info');
    await loadStudents(); await loadToday(); await loadLog();
  } catch(err) { toast(err.message, 'error'); }
}

// ── FP Scan ──────────────────────────────────────────────
async function startFPScan() {
  const btn = document.getElementById('btn-scan-fp');
  btn.disabled = true;
  btn.innerHTML = '<span class="pulse-dot" style="display:inline-block"></span> Waiting…';
  document.getElementById('fp-waiting').classList.remove('hidden');
  try {
    await api('POST', '/enroll-mode/start');
    toast('Sensor ready — place finger on sensor', 'info');
  } catch(err) { toast('Server error: ' + err.message, 'error'); resetFPScanUI(); return; }

  scanPollTimer = setInterval(async () => {
    try {
      const res = await fetch(API + '/enroll-mode');
      const data = await res.json();
      if (!data.enroll_mode && scannedFP === null) {
        clearInterval(scanPollTimer); clearTimeout(scanTimeout);
        const r2 = await fetch(API + '/enroll-last');
        const d2 = await r2.json();
        if (d2.fp_id) setFPScanned(d2.fp_id);
      }
    } catch(_) {}
  }, 600);

  scanTimeout = setTimeout(() => {
    clearInterval(scanPollTimer); cancelFPScan();
    toast('Scan timed out. Try again.', 'error');
  }, 30000);
}

async function cancelFPScan() {
  clearInterval(scanPollTimer); clearTimeout(scanTimeout);
  await api('POST', '/enroll-mode/cancel').catch(() => {});
  resetFPScanUI();
}

function setFPScanned(fpID) {
  clearInterval(scanPollTimer); clearTimeout(scanTimeout);
  scannedFP = fpID;
  const d = document.getElementById('fp-display');
  d.className = 'fp-display filled';
  d.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:18px;height:18px;flex-shrink:0"><path d="M5 12l5 5 9-9"/></svg><span>FP-${String(fpID).padStart(3,'0')} captured</span>`;
  document.getElementById('fp-waiting').classList.add('hidden');
  const btn = document.getElementById('btn-scan-fp');
  btn.disabled = false;
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M12 2C8 2 5 5 5 9s3 7 7 7 7-3 7-7"/><path d="M12 6c-1.7 0-3 1.3-3 3"/></svg> Re-scan`;
  toast(`FP-${String(fpID).padStart(3,'0')} captured!`, 'success');
}

function resetFPScanUI() {
  scannedFP = null;
  const d = document.getElementById('fp-display');
  if (d) {
    d.className = 'fp-display';
    d.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:18px;height:18px;flex-shrink:0"><path d="M12 2C8.1 2 5 5.1 5 9c0 3.9 3.1 7 7 7s7-3.1 7-7"/><path d="M12 5c-2.2 0-4 1.8-4 4"/><path d="M12 8c-.6 0-1 .4-1 1v4"/></svg><span id="fp-display-text">Not scanned yet</span>`;
  }
  const w = document.getElementById('fp-waiting');
  if (w) w.classList.add('hidden');
  const btn = document.getElementById('btn-scan-fp');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px"><path d="M12 2C8 2 5 5 5 9s3 7 7 7 7-3 7-7"/><path d="M12 6c-1.7 0-3 1.3-3 3"/></svg> Scan Finger`;
  }
}

// ── Feed ─────────────────────────────────────────────────
function prependFeed(ev) {
  const feed = document.getElementById('live-feed');
  const item = document.createElement('div');
  item.className = 'feed-item';
  item.innerHTML = `
    <div class="feed-av ${avColor(ev.student_id)}">${initials(ev.name)}</div>
    <div style="flex:1;min-width:0">
      <div class="feed-name">${esc(ev.name)}</div>
      <div class="feed-ag">${esc(ev.ag_number||'')}</div>
    </div>
    <span class="feed-pill ${ev.status}">${ev.status}</span>
    <span class="feed-time">${ev.time}</span>`;
  feed.prepend(item);
  while (feed.children.length > 8) feed.removeChild(feed.lastChild);
}

// ── Scanner animation ─────────────────────────────────────
function flashScanner(cls) {
  const ring = document.getElementById('fp-scanner');
  ring.className = 'fp-scanner ' + cls;
  setTimeout(() => ring.className = 'fp-scanner', 1800);
}

// ── Export ─────────────────────────────────────────────────
function exportCSV() { window.location.href = API + '/export/csv'; }
function exportPDF() {
  const rows = logData.map(r =>
    `<tr><td>${r.date}</td><td>${esc(r.name)}</td><td>${r.ag_number}</td>` +
    `<td>${r.class_name}</td><td>${r.section}</td><td>${r.semester}</td>` +
    `<td>${r.time||'—'}</td><td>${r.status}</td></tr>`).join('');
  const win = window.open('','_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Attendance Report</title>
    <style>body{font-family:sans-serif;padding:30px;font-size:13px}h2{margin-bottom:16px}
    table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}
    th{background:#f3f4f6;font-size:11px;text-transform:uppercase}
    .present{color:green}.absent{color:red}</style></head><body>
    <h2>Attendance Report — ${new Date().toLocaleDateString()}</h2>
    <table><thead><tr><th>Date</th><th>Name</th><th>AG Number</th><th>Class</th><th>Section</th><th>Semester</th><th>Time</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <script>window.onload=()=>window.print()<\/script></body></html>`);
  win.document.close();
}

// ── Tab switching ───────────────────────────────────────────
function switchTab(name, el) {
  const current = document.querySelector('.page.active');
  if (current) {
    current.classList.add('leaving');
    setTimeout(() => { current.classList.remove('active','leaving'); }, 300);
  }
  setTimeout(() => {
    document.getElementById('tab-' + name).classList.add('active');
  }, 150);
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  el.classList.add('active');
}

// ── Helpers ─────────────────────────────────────────────────
const AV = ['av-a','av-b','av-c','av-d','av-e'];
function avColor(id) { return AV[id % AV.length]; }
function initials(name) { return (name||'?').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2); }
function esc(str) { const d = document.createElement('div'); d.textContent = str||''; return d.innerHTML; }
function setTodayLabel() {
  document.getElementById('today-label').textContent =
    new Date().toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'});
}

function toast(msg, type='info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icons = { success:'✓', error:'✕', info:'ℹ' };
  el.innerHTML = `<span style="font-size:14px">${icons[type]||''}</span> ${msg}`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toast-out .3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}
