const API = 'http://localhost:8000';
const WS_URL = 'ws://localhost:8000/ws';

// ── state ──────────────────────────────────────────────────────
var students   = [];
var attendance = [];
var logData    = [];
var session    = null;
var sessionStart = null;
var sessionTimerInterval = null;
var scannedFP  = null;
var scanPoll   = null;
var scanTimer  = null;
var ws         = null;
var wsRetry    = 0;
var currentPage = 'dashboard';

// ── boot ───────────────────────────────────────────────────────
window.addEventListener('load', function() {
  setDateLabel();
  console.log("connectWS called");
  connectWS();
  loadAll();
});

function loadAll() {
  loadStudents();
  loadToday();
  loadLog();
  loadSession();
}

// ── navigation ─────────────────────────────────────────────────
function goTo(name) {
  document.getElementById('page-' + currentPage).classList.add('hidden');
  document.getElementById('nav-' + currentPage).classList.remove('active');
  currentPage = name;
  document.getElementById('page-' + name).classList.remove('hidden');
  document.getElementById('nav-' + name).classList.add('active');
}

// ── websocket ──────────────────────────────────────────────────
function connectWS() {
  try {
    ws = new WebSocket(WS_URL);
    ws.onopen = function() {
      console.log("WS CONNECTED");
      wsRetry = 0;
      setWSDot(true);
      ws._ping = setInterval(function() { if (ws.readyState === 1) ws.send('ping'); }, 20000);
    };
    ws.onmessage = function(e) {
      console.log("WS MESSAGE", e.data);
      try { handleEvent(JSON.parse(e.data)); } catch(err) {}
    };
    ws.onclose = function() {
      console.log("WS CLOSED");
      clearInterval(ws._ping);
      setWSDot(false);
      wsRetry = Math.min(wsRetry + 1, 6);
      setTimeout(connectWS, 2000 * wsRetry);
    };
    ws.onerror = function() { 
      console.log("WS ERROR");
      ws.close(); };
  } catch(err) { setWSDot(false); }
}

function setWSDot(ok) {
  var dot = document.getElementById('ws-dot');
  var lbl = document.getElementById('ws-label');
  dot.className = 'ws-dot ' + (ok ? 'ok' : 'err');
  lbl.textContent = ok ? 'ESP32 connected' : 'Disconnected';
}

function handleEvent(ev) {
  if (ev.event === 'scan') {
    flashScanner(ev.status === 'present' ? 'ok' : 'err');
    document.getElementById('scanner-txt').textContent =
      ev.status === 'present' ? ('✓ ' + ev.name + ' — present') :
      ev.status === 'already' ? (ev.name + ' — already marked') : 'Unknown fingerprint';
    addFeedItem(ev);
    loadToday();
    return;
  }
  if (ev.event === 'enroll_scan') { setFPScanned(ev.fp_id); return; }
  if (ev.event === 'session_started') { session = ev.session; renderSession(); }
  if (ev.event === 'session_ended')   { session = null; renderSession(); loadToday(); }
  if (ev.event === 'attendance_updated') { loadToday(); loadLog(); }
  if (ev.event === 'student_added' || ev.event === 'student_updated' || ev.event === 'student_deleted') {
    loadStudents(); loadToday();
  }
}

// ── api ────────────────────────────────────────────────────────
function apiCall(method, path, body, cb) {
  var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  fetch(API + path, opts)
    .then(function(r) {
      if (!r.ok) return r.json().then(function(e) { throw new Error(e.detail || 'Error'); });
      return r.json();
    })
    .then(cb)
    .catch(function(err) { showToast(err.message, 'error'); });
}

// ── load data ──────────────────────────────────────────────────
function loadStudents() {
  apiCall('GET', '/students', null, function(data) {
    students = data; renderStudents();
  });
}

function loadToday() {
  apiCall('GET', '/attendance/today', null, function(data) {
    attendance = data; renderStats(); renderTodayTable();
  });
}

function loadLog() {
  apiCall('GET', '/attendance', null, function(data) {
    logData = data; applyFilters();
  });
}

function loadSession() {
  apiCall('GET', '/session/active', null, function(data) {
    session = (data && data.id) ? data : null;
    renderSession();
  });
}

// ── session ────────────────────────────────────────────────────
function toggleSession() {
  if (session) {
    if (!confirm('End the current attendance session?')) return;
    apiCall('POST', '/session/end', {}, function() {
      session = null; renderSession(); loadToday();
      showToast('Session ended', 'info');
    });
  } else {
    apiCall('POST', '/session/start', {}, function(data) {
      session = data; sessionStart = new Date(); renderSession();
      showToast('Attendance session started', 'success');
    });
  }
}

function renderSession() {
  var btn   = document.getElementById('session-btn');
  var lbl   = document.getElementById('session-label');
  var banner = document.getElementById('session-banner');
  var badge  = document.getElementById('session-badge');

  clearInterval(sessionTimerInterval);

  if (session) {
    btn.textContent = '⏹ End Attendance';
    btn.classList.add('stop');
    banner.classList.remove('hidden');
    badge.textContent = 'Active';
    badge.classList.add('on');
    sessionStart = sessionStart || new Date();
    sessionTimerInterval = setInterval(updateTimer, 1000);
    updateTimer();
  } else {
    btn.textContent = '▶ Start Attendance';
    btn.classList.remove('stop');
    banner.classList.add('hidden');
    badge.textContent = 'No Session';
    badge.classList.remove('on');
    sessionStart = null;
    document.getElementById('session-timer').textContent = '00:00';
  }
}

function updateTimer() {
  if (!sessionStart) return;
  var diff = Math.floor((Date.now() - sessionStart.getTime()) / 1000);
  var mm = String(Math.floor(diff / 60)).padStart(2, '0');
  var ss = String(diff % 60).padStart(2, '0');
  document.getElementById('session-timer').textContent = mm + ':' + ss;
}

// ── stats ──────────────────────────────────────────────────────
function renderStats() {
  var total   = students.length;
  var present = 0;
  for (var i = 0; i < attendance.length; i++) { if (attendance[i].status === 'present') present++; }
  var absent  = total - present;
  var pct     = total ? Math.round(present / total * 100) : 0;
  document.getElementById('s-total').textContent   = total;
  document.getElementById('s-present').textContent = present;
  document.getElementById('s-absent').textContent  = absent;
  document.getElementById('s-pct').textContent     = pct + '%';
}

// ── today table ────────────────────────────────────────────────
function renderTodayTable() {
  var tbody = document.getElementById('today-tbody');
  if (!attendance.length) {
    tbody.innerHTML = '<tr class="empty"><td colspan="5">No students enrolled</td></tr>';
    return;
  }
  var html = '';
  for (var i = 0; i < attendance.length; i++) {
    var r = attendance[i];
    html += '<tr>';
    html += '<td><div class="nc"><div class="av ' + avCol(r.student_id) + '">' + ini(r.name) + '</div>';
    html += '<div><div style="font-weight:600">' + esc(r.name) + '</div>';
    html += '<div style="font-size:11px;color:#9ca3af">' + esc(r.class_name) + ' · ' + esc(r.section) + ' · ' + esc(r.semester) + '</div></div></div></td>';
    html += '<td><span class="pill mono">' + esc(r.ag_number) + '</span></td>';
    html += '<td style="color:#6b7280">' + (r.time || '—') + '</td>';
    html += '<td><span class="pill ' + r.status + '">' + r.status + '</span></td>';
    if (r.att_id) {
      html += '<td><select class="ssel ' + r.status + '" onchange="fixStatus(' + r.att_id + ',this)">';
      html += '<option value="present"' + (r.status === 'present' ? ' selected' : '') + '>Present</option>';
      html += '<option value="absent"'  + (r.status === 'absent'  ? ' selected' : '') + '>Absent</option>';
      html += '</select></td>';
    } else {
      html += '<td style="color:#9ca3af;font-size:11px">—</td>';
    }
    html += '</tr>';
  }
  tbody.innerHTML = html;
}

function fixStatus(attId, sel) {
  var st = sel.value;
  sel.className = 'ssel ' + st;
  apiCall('PATCH', '/attendance/' + attId, { status: st }, function() {
    showToast('Status updated to ' + st, 'success');
    loadToday();
  });
}

// ── log table ──────────────────────────────────────────────────
function applyFilters() {
  var search = (document.getElementById('f-search').value || '').toLowerCase();
  var start  = document.getElementById('f-start').value;
  var end    = document.getElementById('f-end').value;
  var rows   = logData.slice();
  if (search) rows = rows.filter(function(r) { return r.name.toLowerCase().indexOf(search) > -1 || r.ag_number.toLowerCase().indexOf(search) > -1; });
  if (start)  rows = rows.filter(function(r) { return r.date >= start; });
  if (end)    rows = rows.filter(function(r) { return r.date <= end; });

  var tbody = document.getElementById('log-tbody');
  if (!rows.length) { tbody.innerHTML = '<tr class="empty"><td colspan="9">No records found</td></tr>'; return; }

  var html = '';
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    html += '<tr>';
    html += '<td style="color:#6b7280">' + r.date + '</td>';
    html += '<td><div class="nc"><div class="av ' + avCol(r.student_id) + '">' + ini(r.name) + '</div>' + esc(r.name) + '</div></td>';
    html += '<td><span class="pill mono">' + esc(r.ag_number) + '</span></td>';
    html += '<td style="color:#6b7280">' + esc(r.class_name) + '</td>';
    html += '<td style="color:#6b7280">' + esc(r.section)    + '</td>';
    html += '<td style="color:#6b7280">' + esc(r.semester)   + '</td>';
    html += '<td style="color:#6b7280">' + (r.time || '—')   + '</td>';
    html += '<td><span class="pill ' + r.status + '">' + r.status + '</span></td>';
    html += '<td><button class="btn btn-outline sm" onclick="exportStudentCSV(' + r.student_id + ')">CSV</button></td>';
    html += '</tr>';
  }
  tbody.innerHTML = html;
}

function clearFilters() {
  document.getElementById('f-search').value = '';
  document.getElementById('f-start').value  = '';
  document.getElementById('f-end').value    = '';
  applyFilters();
}

// ── students table ─────────────────────────────────────────────
function renderStudents() {
  document.getElementById('enrolled-sub').textContent = students.length + ' students enrolled';
  var tbody = document.getElementById('students-tbody');
  if (!students.length) { tbody.innerHTML = '<tr class="empty"><td colspan="7">No students enrolled yet</td></tr>'; return; }
  var html = '';
  for (var i = 0; i < students.length; i++) {
    var s = students[i];
    html += '<tr>';
    html += '<td><div class="nc"><div class="av ' + avCol(s.id) + '">' + ini(s.name) + '</div>';
    html += '<div><div style="font-weight:600">' + esc(s.name) + '</div>';
    html += '<div style="font-size:11px;color:#9ca3af">' + (s.created_at ? s.created_at.slice(0,10) : '') + '</div></div></div></td>';
    html += '<td><span class="pill mono">' + esc(s.ag_number) + '</span></td>';
    html += '<td><span class="pill mono">FP-' + String(s.fp_id).padStart(3,'0') + '</span></td>';
    html += '<td style="color:#6b7280">' + esc(s.class_name) + '</td>';
    html += '<td style="color:#6b7280">' + esc(s.section)    + '</td>';
    html += '<td style="color:#6b7280">' + esc(s.semester)   + '</td>';
    html += '<td><div style="display:flex;gap:6px">';
    html += '<button class="btn btn-outline sm" onclick="openModal(' + s.id + ')">Edit</button>';
    html += '<button class="btn btn-danger  sm" onclick="delStudent(' + s.id + ')">Remove</button>';
    html += '</div></td>';
    html += '</tr>';
  }
  tbody.innerHTML = html;
}

// ── modal ──────────────────────────────────────────────────────
function openModal(id) {
  scannedFP = null;
  resetFPUI();
  document.getElementById('modal-overlay').classList.remove('hidden');
  if (id) {
    var s = null;
    for (var i = 0; i < students.length; i++) { if (students[i].id === id) { s = students[i]; break; } }
    if (!s) return;
    document.getElementById('modal-title').textContent   = 'Edit Student';
    document.getElementById('edit-id').value             = s.id;
    document.getElementById('inp-name').value            = s.name;
    document.getElementById('inp-ag').value              = s.ag_number;
    document.getElementById('inp-class').value           = s.class_name;
    document.getElementById('inp-section').value         = s.section;
    document.getElementById('inp-semester').value        = s.semester;
    setFPScanned(s.fp_id);
  } else {
    document.getElementById('modal-title').textContent = 'Enroll Student';
    document.getElementById('edit-id').value    = '';
    document.getElementById('inp-name').value   = '';
    document.getElementById('inp-ag').value     = '';
    document.getElementById('inp-class').value  = '';
    document.getElementById('inp-section').value  = '';
    document.getElementById('inp-semester').value = '';
  }
}

function closeModal() {
  cancelFPScan();
  document.getElementById('modal-overlay').classList.add('hidden');
}

function overlayClick(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
}

function submitStudent() {
  var id       = document.getElementById('edit-id').value;
  var name     = document.getElementById('inp-name').value.trim();
  var ag       = document.getElementById('inp-ag').value.trim().toUpperCase();
  var cls      = document.getElementById('inp-class').value.trim();
  var section  = document.getElementById('inp-section').value.trim();
  var semester = document.getElementById('inp-semester').value.trim();

  if (!name || !ag || !cls || !section || !semester) { showToast('Fill in all fields', 'error'); return; }
  if (!scannedFP) { showToast('Scan the fingerprint first', 'error'); return; }

  var body = { name: name, ag_number: ag, fp_id: scannedFP, class_name: cls, section: section, semester: semester };

  if (id) {
    apiCall('PUT', '/students/' + id, body, function() {
      showToast('Student updated', 'success');
      closeModal(); loadStudents(); loadToday();
    });
  } else {
    apiCall('POST', '/students', body, function() {
      showToast('Student enrolled', 'success');
      closeModal(); loadStudents(); loadToday();
    });
  }
}

function delStudent(id) {
  if (!confirm('Remove this student and all their records?')) return;
  apiCall('DELETE', '/students/' + id, null, function() {
    showToast('Student removed', 'info');
    loadStudents(); loadToday(); loadLog();
  });
}

// ── fingerprint scan ───────────────────────────────────────────
function startFPScan() {
  var btn = document.getElementById('btn-scan');
  btn.disabled = true;
  btn.textContent = 'Waiting…';
  document.getElementById('fp-hint').classList.remove('hidden');

  apiCall('POST', '/enroll-mode/start', {}, function() {
    showToast('Place finger on sensor now', 'info');
  });

  scanPoll = setInterval(function() {
    fetch(API + '/enroll-mode')
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.enroll_mode) {
          clearInterval(scanPoll);
          clearTimeout(scanTimer);
          fetch(API + '/enroll-last')
            .then(function(r) { return r.json(); })
            .then(function(d2) { if (d2.fp_id) setFPScanned(d2.fp_id); });
        }
      })
      .catch(function() {});
  }, 600);

  scanTimer = setTimeout(function() {
    clearInterval(scanPoll);
    cancelFPScan();
    showToast('Scan timed out — try again', 'error');
  }, 30000);
}

function cancelFPScan() {
  clearInterval(scanPoll);
  clearTimeout(scanTimer);
  fetch(API + '/enroll-mode/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function() {});
  resetFPUI();
}

function setFPScanned(fpID) {
  clearInterval(scanPoll);
  clearTimeout(scanTimer);
  scannedFP = fpID;
  var box = document.getElementById('fp-box');
  box.className = 'fp-box scanned';
  box.textContent = '✓ FP-' + String(fpID).padStart(3,'0') + ' captured';
  document.getElementById('fp-hint').classList.add('hidden');
  var btn = document.getElementById('btn-scan');
  btn.disabled = false;
  btn.textContent = 'Re-scan';
  showToast('FP-' + String(fpID).padStart(3,'0') + ' captured!', 'success');
}

function resetFPUI() {
  var box = document.getElementById('fp-box');
  if (box) { box.className = 'fp-box'; box.textContent = '💬 Not scanned yet'; }
  var hint = document.getElementById('fp-hint');
  if (hint) hint.classList.add('hidden');
  var btn = document.getElementById('btn-scan');
  if (btn) { btn.disabled = false; btn.textContent = 'Scan Finger'; }
}

// ── scanner animation ──────────────────────────────────────────
function flashScanner(cls) {
  var ring = document.getElementById('scanner-ring');
  ring.className = 'scanner-ring ' + cls;
  setTimeout(function() { ring.className = 'scanner-ring'; }, 1800);
}

// ── live feed ──────────────────────────────────────────────────
function addFeedItem(ev) {
  var feed = document.getElementById('feed-list');
  var div  = document.createElement('div');
  div.className = 'feed-item';
  var statusCls = ev.status === 'present' ? 'present' : 'absent';
  div.innerHTML =
    '<div class="feed-av ' + avCol(ev.student_id) + '">' + ini(ev.name) + '</div>' +
    '<div style="flex:1;min-width:0"><div class="feed-name">' + esc(ev.name) + '</div>' +
    '<div class="feed-ag">' + esc(ev.ag_number || '') + '</div></div>' +
    '<span class="feed-status ' + statusCls + '">' + ev.status + '</span>' +
    '<span class="feed-time">' + ev.time + '</span>';
  feed.insertBefore(div, feed.firstChild);
  while (feed.children.length > 8) feed.removeChild(feed.lastChild);
}

// ── export ─────────────────────────────────────────────────────
function exportCSV() { window.location.href = API + '/export/csv'; }
function exportStudentCSV(sid) { window.location.href = API + '/export/csv?student_id=' + sid; }

function exportPDF() { printReport(logData, 'Full Attendance Report'); }

function printReport(data, title) {
  var rows = '';
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    rows += '<tr>';
    rows += '<td>' + r.date + '</td>';
    rows += '<td>' + esc(r.name) + '</td>';
    rows += '<td>' + esc(r.ag_number) + '</td>';
    rows += '<td>' + esc(r.class_name) + '</td>';
    rows += '<td>' + esc(r.section) + '</td>';
    rows += '<td>' + esc(r.semester) + '</td>';
    rows += '<td>' + (r.time || '—') + '</td>';
    rows += '<td class="' + r.status + '">' + r.status + '</td>';
    rows += '</tr>';
  }

  var w = window.open('', '_blank');
  w.document.open();
  w.document.write('<html><head><title>' + title + '</title>');
  w.document.write('<style>body{font-family:sans-serif;padding:30px;font-size:13px}');
  w.document.write('h2{margin-bottom:16px}table{width:100%;border-collapse:collapse}');
  w.document.write('th,td{border:1px solid #e5e7eb;padding:9px 13px;text-align:left}');
  w.document.write('th{background:#f9fafb;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280}');
  w.document.write('.present{color:#16a34a;font-weight:600}.absent{color:#dc2626;font-weight:600}');
  w.document.write('</style></head><body>');
  w.document.write('<h2>' + title + '</h2>');
  w.document.write('<p style="color:#9ca3af;font-size:12px;margin-bottom:20px">Generated: ' + new Date().toLocaleString() + '</p>');
  w.document.write('<table><thead><tr>');
  w.document.write('<th>Date</th><th>Name</th><th>AG Number</th><th>Class</th><th>Section</th><th>Semester</th><th>Time</th><th>Status</th>');
  w.document.write('</tr></thead><tbody>' + rows + '</tbody></table>');
  w.document.write('<script>window.onload=function(){window.print();}<\/script>');
  w.document.write('</body></html>');
  w.document.close();
}

// ── helpers ────────────────────────────────────────────────────
function setDateLabel() {
  document.getElementById('today-label').textContent =
    new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

var AV_COLS = ['c0','c1','c2','c3','c4'];
function avCol(id) { return AV_COLS[id % AV_COLS.length]; }

function ini(name) {
  if (!name) return '?';
  return name.split(' ').map(function(w) { return w[0]; }).join('').toUpperCase().slice(0,2);
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, type) {
  type = type || 'info';
  var icons = { success: '✓', error: '✕', info: 'ℹ' };
  var el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = '<span>' + (icons[type] || '') + '</span> ' + msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(function() {
    el.style.animation = 'toast-out .3s ease forwards';
    setTimeout(function() { el.remove(); }, 300);
  }, 3000);
}