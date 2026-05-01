const express = require('express');
const QRCode  = require('qrcode');
const path    = require('path');
const app     = express();

app.use(express.json());
app.use(express.static(__dirname));

// ── Seed data ─────────────────────────────────────────────────────────────────
const store = {
  students: [
    { rollNo:'24L-3001', name:'Ahmed Raza',       section:'BSE-243A', pass:'pass' },
    { rollNo:'24L-3002', name:'Sara Khan',         section:'BSE-243A', pass:'pass' },
    { rollNo:'24L-3003', name:'Adina Saqib',       section:'BSE-243A', pass:'pass' },
    { rollNo:'24L-3027', name:'Fatima Kamran',     section:'BSE-243A', pass:'pass' },
    { rollNo:'24L-3079', name:'Maryam Ashfaq',     section:'BSE-243A', pass:'pass' },
    { rollNo:'24L-3083', name:'Areeba Iqbal',      section:'BSE-243A', pass:'pass' },
    { rollNo:'24L-3010', name:'Usman Tariq',       section:'BSE-243A', pass:'pass' },
    { rollNo:'24L-3015', name:'Hina Malik',        section:'BSE-243A', pass:'pass' },
    { rollNo:'24L-3022', name:'Bilal Ahmed',       section:'BSE-243A', pass:'pass' },
    { rollNo:'24L-3045', name:'Zara Hussain',      section:'BSE-243A', pass:'pass' },
    { rollNo:'24L-3051', name:'Ali Hassan',        section:'BSE-243B', pass:'pass' },
    { rollNo:'24L-3062', name:'Noor Fatima',       section:'BSE-243B', pass:'pass' },
  ],
  faculty: [
    { id:'FAC-001', name:'Dr. Zeeshan Ali Rana', dept:'SE',  courses:['SE-2001','SE-3002'], pass:'admin' },
    { id:'FAC-002', name:'Dr. Aisha Tariq',      dept:'CS',  courses:['CS-3001'],           pass:'admin' },
  ],
  sessions: {},
  currentToken: {},
  scans: {},
  rotateIntervals: {},
  // historical attendance per student per course
  attendanceHistory: {},
};

// ── Utils ─────────────────────────────────────────────────────────────────────
const token8  = () => Math.random().toString(36).substring(2,10).toUpperCase();
const sesId   = () => 'SES-' + Date.now();
const fmt     = ts  => new Date(ts).toLocaleString('en-PK', { hour12:true });

function lockSession(sessionId) {
  const s = store.sessions[sessionId];
  if (!s || s.locked) return;
  s.locked    = true;
  s.status    = 'locked';
  s.lockedAt  = Date.now();
  if (store.rotateIntervals[sessionId]) {
    clearInterval(store.rotateIntervals[sessionId]);
    delete store.rotateIntervals[sessionId];
  }
  // Commit results to history
  const students = store.students.filter(st => st.section === s.section);
  const scans    = store.scans[sessionId] || {};
  students.forEach(st => {
    const scan = scans[st.rollNo];
    let finalStatus = 'Absent';
    if (scan) {
      if (scan.opening && scan.closing) finalStatus = 'Present';
      else if (scan.closing)            finalStatus = 'Late';
      else if (scan.opening)            finalStatus = 'Present'; // opened only → count present
    }
    // apply override
    const ov = (s.overrides||[]).find(o => o.rollNo === st.rollNo);
    if (ov) finalStatus = ov.status;

    const key = `${st.rollNo}::${s.courseCode}`;
    if (!store.attendanceHistory[key]) store.attendanceHistory[key] = [];
    store.attendanceHistory[key].push({
      sessionId, date: s.startedAt, topic: s.topic,
      status: finalStatus, locked: true
    });
  });
  console.log(`🔒 Session ${sessionId} locked.`);
}

function rosterForSession(sessionId) {
  const s        = store.sessions[sessionId];
  const scans    = store.scans[sessionId] || {};
  const students = store.students.filter(st => st.section === s.section);
  return students.map(st => {
    const scan = scans[st.rollNo];
    let status  = 'Absent';
    if (scan) {
      if (scan.opening && scan.closing)  status = 'Present';
      else if (scan.closing)             status = 'Late';
      else if (scan.opening)             status = 'Opening Recorded';
    }
    const ov = (s.overrides||[]).find(o => o.rollNo === st.rollNo);
    if (ov) status = ov.status + ' (override)';
    return { ...st, status, scanned: !!scan };
  });
}

// ── Faculty auth ──────────────────────────────────────────────────────────────
app.post('/api/faculty/login', (req,res) => {
  const { id, pass } = req.body;
  const f = store.faculty.find(f => f.id === id && f.pass === pass);
  if (!f) return res.status(401).json({ error:'Invalid credentials' });
  res.json({ id:f.id, name:f.name, dept:f.dept, courses:f.courses });
});

// ============ STUDENT ROUTES ============

// Student login
// ── Student auth ──────────────────────────────────────────────────────────────
app.post('/api/student/login', (req, res) => {
  const { rollNo, pass } = req.body;
  console.log('Student login attempt:', rollNo, pass);
  
  const student = store.students.find(s => s.rollNo === rollNo.toUpperCase() && s.pass === pass);
  
  if (!student) {
    console.log('Student not found');
    return res.status(401).json({ error: 'Invalid roll number or password' });
  }
  
  console.log('Login successful:', student.name);
  res.json({ 
    rollNo: student.rollNo, 
    name: student.name, 
    section: student.section 
  });
});

// Get student by roll number (for login check)
app.get('/api/student/:rollNo', (req, res) => {
  const student = store.students.find(s => s.rollNo === req.params.rollNo);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  res.json(student);
});

// ── Start session ─────────────────────────────────────────────────────────────
app.post('/api/faculty/start-session', async (req,res) => {
  const { topic, courseCode, section, facultyId, facultyName } = req.body;
  if (!topic || !courseCode || !section) return res.status(400).json({ error:'Missing fields' });

  const sessionId = sesId();
  const tok       = token8();
  const now       = Date.now();

  store.sessions[sessionId] = {
    sessionId, topic, courseCode, section, facultyId, facultyName,
    startedAt: now, status:'opening', locked:false, overrides:[]
  };
  store.currentToken[sessionId] = { token:tok, generatedAt:now, expiresAt:now+30000 };
  store.scans[sessionId]        = {};

  // Switch to closing window after 10 min
  setTimeout(() => {
    const s = store.sessions[sessionId];
    if (s && !s.locked) { s.status = 'closing'; console.log(`⏱ ${sessionId} → closing window`); }
  }, 10*60*1000);

  // Auto-lock after 20 min
  setTimeout(() => lockSession(sessionId), 20*60*1000);

  // Rotate token every 30 s
  store.rotateIntervals[sessionId] = setInterval(() => {
    const s = store.sessions[sessionId];
    if (!s || s.locked) { clearInterval(store.rotateIntervals[sessionId]); return; }
    const nt  = token8(), now2 = Date.now();
    store.currentToken[sessionId] = { token:nt, generatedAt:now2, expiresAt:now2+30000 };
    console.log(`🔄 Token rotated → ${nt}`);
  }, 30000);

  const qrData = `${sessionId}|${tok}`;
  const qrImg  = await QRCode.toDataURL(qrData, { width:300, margin:2 });
  res.json({ sessionId, token:tok, qrCode:qrImg, expiresAt:now+30000 });
});

// ── Poll session (faculty) ────────────────────────────────────────────────────
app.get('/api/faculty/session/:sessionId', async (req,res) => {
  const { sessionId } = req.params;
  const s = store.sessions[sessionId];
  if (!s) return res.status(404).json({ error:'Not found' });

  const td      = store.currentToken[sessionId];
  const roster  = rosterForSession(sessionId);
  let qrCode    = null;

  if (td && !s.locked) {
    const qrData = `${sessionId}|${td.token}`;
    qrCode = await QRCode.toDataURL(qrData, { width:300, margin:2 });
  }

  res.json({
    session:s, token:td?.token, expiresAt:td?.expiresAt, serverTime:Date.now(),
    qrCode, roster,
    presentCount: roster.filter(r=>r.status.startsWith('Present')).length,
    lateCount:    roster.filter(r=>r.status==='Late').length,
    absentCount:  roster.filter(r=>r.status==='Absent').length,
  });
});

// ── Lock manually ─────────────────────────────────────────────────────────────
app.post('/api/faculty/lock-session/:sessionId', (req,res) => {
  lockSession(req.params.sessionId);
  res.json({ success:true });
});

// ── Switch to closing window manually ────────────────────────────────────────
app.post('/api/faculty/closing-window/:sessionId', (req,res) => {
  const s = store.sessions[req.params.sessionId];
  if (s && !s.locked) s.status = 'closing';
  res.json({ success:true });
});

// ── Manual override ───────────────────────────────────────────────────────────
app.post('/api/faculty/override/:sessionId', (req,res) => {
  const { rollNo, status, reason } = req.body;
  const s = store.sessions[req.params.sessionId];
  if (!s) return res.status(404).json({ error:'Not found' });
  s.overrides = (s.overrides||[]).filter(o=>o.rollNo!==rollNo);
  s.overrides.push({ rollNo, status, reason, at:Date.now() });
  res.json({ success:true });
});

// ── All sessions (for student to find active one) ─────────────────────────────
app.get('/api/sessions', (req,res) => {
  res.json(Object.values(store.sessions));
});

// ── Student scan ──────────────────────────────────────────────────────────────
app.post('/api/student/scan', (req,res) => {
  const { rollNo, sessionId, token } = req.body;
  const student = store.students.find(s=>s.rollNo===rollNo);
  if (!student) return res.status(404).json({ error:'Roll number not found' });

  const s = store.sessions[sessionId];
  if (!s) return res.status(404).json({ error:'Session not found' });
  if (s.locked) return res.status(400).json({ error:'Session is locked. Cannot record attendance.', code:'LOCKED' });

  const td = store.currentToken[sessionId];
  if (!td) return res.status(400).json({ error:'No active token', code:'NO_TOKEN' });

  // Token must match
  if (token !== td.token) {
    return res.status(400).json({
      error:'QR code expired or invalid. Please scan the current code on the projector.',
      code:'EXPIRED'
    });
  }

  // Token must not be past expiry
  if (Date.now() > td.expiresAt) {
    return res.status(400).json({ error:'Token has expired. Please scan the new QR code.', code:'EXPIRED' });
  }

  if (!store.scans[sessionId]) store.scans[sessionId] = {};
  const existing = store.scans[sessionId][rollNo];

  // Already fully recorded
  if (existing && existing.opening && existing.closing) {
    return res.status(400).json({ error:'Attendance already fully recorded for this session.', code:'DUPLICATE' });
  }

  const isClosing = s.status === 'closing';

  if (!existing) {
    store.scans[sessionId][rollNo] = {
      opening: !isClosing,
      closing:  isClosing,
      firstScanAt: Date.now()
    };
  } else {
    // Second scan — record closing
    store.scans[sessionId][rollNo].closing    = true;
    store.scans[sessionId][rollNo].secondScanAt = Date.now();
  }

  const scan = store.scans[sessionId][rollNo];
  let currentStatus = '';
  if      (scan.opening && scan.closing) currentStatus = 'Present';
  else if (scan.closing)                 currentStatus = 'Late';
  else                                   currentStatus = 'Opening Recorded';

  const messages = {
    'Present':          '✅ You are marked PRESENT.',
    'Late':             '⏰ You are marked LATE.',
    'Opening Recorded': '📝 Opening window recorded. Scan again during closing window to confirm Present.'
  };

  res.json({ success:true, currentStatus, message:messages[currentStatus], window:isClosing?'closing':'opening' });
});

// ── Student attendance history ─────────────────────────────────────────────────
app.get('/api/student/:rollNo/attendance', (req,res) => {
  const { rollNo } = req.params;
  const { courseCode } = req.query;
  const key     = `${rollNo}::${courseCode}`;
  const records = store.attendanceHistory[key] || [];

  const total   = records.length;
  const present = records.filter(r=>r.status==='Present').length;
  const late    = records.filter(r=>r.status==='Late').length;
  const absent  = records.filter(r=>r.status==='Absent').length;
  const pct     = total ? Math.round(((present+late)/total)*100) : 0;

  res.json({ records, total, present, late, absent, pct });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n══════════════════════════════════════════');
  console.log('  FLEX Attendance System');
  console.log('══════════════════════════════════════════');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Faculty → http://localhost:${PORT}/faculty.html`);
  console.log(`  Student → http://localhost:${PORT}/student.html`);
  const { networkInterfaces } = require('os');
  Object.values(networkInterfaces()).flat().filter(n=>n.family==='IPv4'&&!n.internal)
    .forEach(n => console.log(`  Phone   → http://${n.address}:${PORT}/student.html`));
  console.log('══════════════════════════════════════════\n');
  console.log('Faculty IDs: FAC-001 / FAC-002   Password: admin');
  console.log('Student roll nos: 24L-3083 etc.  Password: pass\n');
});