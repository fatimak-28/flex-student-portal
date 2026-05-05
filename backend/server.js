const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const { Pool } = require('pg');
const XLSX = require('xlsx');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initDatabase() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS faculty (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                dept VARCHAR(100),
                pass VARCHAR(100) NOT NULL,
                courses TEXT[]
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                roll_no VARCHAR(50) PRIMARY KEY,
                name VARCHAR(200) NOT NULL,
                section VARCHAR(50),
                pass VARCHAR(100) NOT NULL
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                session_id VARCHAR(100) PRIMARY KEY,
                topic TEXT,
                course_code VARCHAR(50),
                section VARCHAR(50),
                faculty_id VARCHAR(50),
                faculty_name VARCHAR(200),
                started_at BIGINT,
                locked BOOLEAN DEFAULT FALSE,
                status VARCHAR(20),
                locked_at BIGINT,
                overrides JSONB DEFAULT '[]'
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS attendance_records (
                id SERIAL PRIMARY KEY,
                session_id VARCHAR(100),
                roll_no VARCHAR(50),
                name VARCHAR(200),
                section VARCHAR(50),
                course_code VARCHAR(50),
                status VARCHAR(20),
                recorded_at BIGINT,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id),
                UNIQUE(session_id, roll_no)
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS scans (
                session_id VARCHAR(100),
                roll_no VARCHAR(50),
                opening BOOLEAN DEFAULT FALSE,
                closing BOOLEAN DEFAULT FALSE,
                first_scan_at BIGINT,
                second_scan_at BIGINT,
                PRIMARY KEY (session_id, roll_no)
            )
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS current_tokens (
                session_id VARCHAR(100) PRIMARY KEY,
                token VARCHAR(10),
                generated_at BIGINT,
                expires_at BIGINT
            )
        `);

        const facultyRes = await client.query('SELECT COUNT(*) FROM faculty');
        if (parseInt(facultyRes.rows[0].count) === 0) {
            await client.query(`
                INSERT INTO faculty (id, name, dept, pass, courses) VALUES
                ('FAC-001', 'Dr. Zeeshan Ali Rana', 'SE', 'admin', ARRAY['SE-2001', 'SE-3002']),
                ('FAC-002', 'Dr. Aisha Tariq', 'CS', 'admin', ARRAY['CS-3001'])
            `);
            console.log('✓ Faculty seeded');
        }
        const studentsRes = await client.query('SELECT COUNT(*) FROM students');
        if (parseInt(studentsRes.rows[0].count) === 0) {
            await client.query(`
                INSERT INTO students (roll_no, name, section, pass) VALUES
                ('24L-3001', 'Ahmed Raza', 'BSE-243A', 'pass'),
                ('24L-3002', 'Sara Khan', 'BSE-243A', 'pass'),
                ('24L-3003', 'Adina Saqib', 'BSE-243A', 'pass'),
                ('24L-3027', 'Fatima Kamran', 'BSE-243A', 'pass'),
                ('24L-3079', 'Maryam Ashfaq', 'BSE-243A', 'pass'),
                ('24L-3083', 'Areeba Iqbal', 'BSE-243A', 'pass'),
                ('24L-3010', 'Usman Tariq', 'BSE-243A', 'pass'),
                ('24L-3015', 'Hina Malik', 'BSE-243A', 'pass'),
                ('24L-3022', 'Bilal Ahmed', 'BSE-243A', 'pass'),
                ('24L-3045', 'Zara Hussain', 'BSE-243A', 'pass'),
                ('24L-3051', 'Ali Hassan', 'BSE-243B', 'pass'),
                ('24L-3062', 'Noor Fatima', 'BSE-243B', 'pass')
            `);
            console.log('✓ Students seeded');
        }
        console.log('✅ Database initialized successfully');
    } catch (err) {
        console.error('Database init error:', err);
    } finally {
        client.release();
    }
}

// ── IN-MEMORY STORE ──────────────────────────────────────────────────────────
const store = {
    sessions: {},
    currentToken: {},
    scans: {},
    rotateIntervals: {},
    openingTimers: {},
    closingTimers: {},
};

const token8 = () => Math.random().toString(36).substring(2, 10).toUpperCase();
const sesId  = () => 'SES-' + Date.now();

// ── RESTORE ACTIVE SESSIONS ON RESTART ───────────────────────────────────────
async function restoreActiveSessions() {
    try {
        const res = await pool.query('SELECT session_id FROM sessions WHERE locked = false');
        for (const row of res.rows) {
            const sessionRes = await pool.query('SELECT * FROM sessions WHERE session_id = $1', [row.session_id]);
            const sd = sessionRes.rows[0];
            if (!sd) continue;
            const tokenRes = await pool.query('SELECT * FROM current_tokens WHERE session_id = $1', [sd.session_id]);
            const td = tokenRes.rows[0];
            store.sessions[sd.session_id] = {
                sessionId: sd.session_id, topic: sd.topic, courseCode: sd.course_code,
                section: sd.section, facultyId: sd.faculty_id, facultyName: sd.faculty_name,
                startedAt: sd.started_at, status: sd.status, locked: sd.locked,
                overrides: sd.overrides || []
            };
            if (td) {
                store.currentToken[sd.session_id] = {
                    token: td.token, generatedAt: td.generated_at, expiresAt: td.expires_at
                };
            }
            store.scans[sd.session_id] = {};
            const scansRes = await pool.query('SELECT * FROM scans WHERE session_id = $1', [sd.session_id]);
            for (const scan of scansRes.rows) {
                store.scans[sd.session_id][scan.roll_no] = {
                    opening: scan.opening, closing: scan.closing,
                    firstScanAt: scan.first_scan_at, secondScanAt: scan.second_scan_at
                };
            }
            startTokenRotation(sd.session_id);
            console.log(`🔄 Restored session: ${sd.session_id} (${sd.status})`);
        }
        console.log('✅ Active sessions restored');
    } catch (err) {
        console.error('Session restore error:', err);
    }
}

function startTokenRotation(sessionId) {
    if (store.rotateIntervals[sessionId]) clearInterval(store.rotateIntervals[sessionId]);
    store.rotateIntervals[sessionId] = setInterval(async () => {
        const s = store.sessions[sessionId];
        if (!s || s.locked || s.status === 'opening_locked') {
            clearInterval(store.rotateIntervals[sessionId]);
            delete store.rotateIntervals[sessionId];
            return;
        }
        const nt = token8();
        const now = Date.now();
        store.currentToken[sessionId] = { token: nt, generatedAt: now, expiresAt: now + 30000 };
        await pool.query('UPDATE current_tokens SET token=$1, generated_at=$2, expires_at=$3 WHERE session_id=$4',
            [nt, now, now + 30000, sessionId]);
    }, 30000);
}

// ── LOCK SESSION (finalize attendance) ───────────────────────────────────────
async function lockSession(sessionId) {
    const s = store.sessions[sessionId];
    if (!s || s.locked) return;

    s.locked = true;
    s.status = 'locked';
    s.lockedAt = Date.now();

    if (store.rotateIntervals[sessionId]) { clearInterval(store.rotateIntervals[sessionId]); delete store.rotateIntervals[sessionId]; }
    if (store.openingTimers[sessionId])   { clearTimeout(store.openingTimers[sessionId]);   delete store.openingTimers[sessionId]; }
    if (store.closingTimers[sessionId])   { clearTimeout(store.closingTimers[sessionId]);   delete store.closingTimers[sessionId]; }

    await pool.query('UPDATE sessions SET locked=$1, status=$2, locked_at=$3 WHERE session_id=$4',
        [true, 'locked', s.lockedAt, sessionId]);

    const studentsRes = await pool.query('SELECT * FROM students WHERE section=$1', [s.section]);
    const scans = store.scans[sessionId] || {};

    for (const st of studentsRes.rows) {
        const scan = scans[st.roll_no];
        let finalStatus = 'Absent';
        if (scan) {
            if (scan.opening && scan.closing) finalStatus = 'Present';
            else finalStatus = 'Late';
        }
        const ov = (s.overrides || []).find(o => o.rollNo === st.roll_no);
        if (ov) finalStatus = ov.status;

        await pool.query(
            `INSERT INTO attendance_records (session_id, roll_no, name, section, course_code, status, recorded_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (session_id, roll_no) DO UPDATE SET status=$6`,
            [sessionId, st.roll_no, st.name, st.section, s.courseCode, finalStatus, s.startedAt]
        );
    }
    console.log(`🔒 Session ${sessionId} locked.`);
}

async function rosterForSession(sessionId) {
    const s = store.sessions[sessionId];
    if (!s) return [];
    const scans = store.scans[sessionId] || {};
    const studentsRes = await pool.query('SELECT * FROM students WHERE section=$1', [s.section]);
    return studentsRes.rows.map(st => {
        const scan = scans[st.roll_no];
        let status = 'Absent';
        if (scan) {
            if (scan.opening && scan.closing) status = 'Present';
            else if (scan.opening || scan.closing) status = 'Opening Recorded';
        }
        const ov = (s.overrides || []).find(o => o.rollNo === st.roll_no);
        if (ov) status = ov.status + ' (override)';
        return { rollNo: st.roll_no, name: st.name, status };
    });
}

async function exportToExcel(sessionId) {
    const sessionRes = await pool.query('SELECT * FROM sessions WHERE session_id=$1', [sessionId]);
    const session = sessionRes.rows[0];
    if (!session) return null;
    const recordsRes = await pool.query('SELECT * FROM attendance_records WHERE session_id=$1 ORDER BY roll_no', [sessionId]);
    const studentsRes = await pool.query('SELECT * FROM students WHERE section=$1 ORDER BY roll_no', [session.section]);
    const dateStr = new Date(Number(session.started_at)).toLocaleDateString('en-GB');
    const data = [['S#', 'Roll No.', 'Student Name', 'Status (' + dateStr + ')']];
    let sno = 1;
    for (const st of studentsRes.rows) {
        const rec = recordsRes.rows.find(r => r.roll_no === st.roll_no);
        let status = 'A';
        if (rec) { if (rec.status === 'Present') status = 'P'; else if (rec.status === 'Late') status = 'L'; }
        data.push([sno++, st.roll_no, st.name, status]);
    }
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [{ wch: 5 }, { wch: 14 }, { wch: 30 }, { wch: 20 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ═══════════════════════════════════════════════════════════ FACULTY ROUTES ══

app.post('/api/faculty/login', async (req, res) => {
    try {
        const { id, pass } = req.body;
        if (!id || !pass) return res.status(400).json({ error: 'Faculty ID and password are required' });
        const dbRes = await pool.query('SELECT * FROM faculty WHERE id=$1 AND pass=$2', [id.trim(), pass]);
        if (!dbRes.rows[0]) return res.status(401).json({ error: 'Incorrect Faculty ID or password' });
        const f = dbRes.rows[0];
        let activeSession = null;
        for (const [sid, s] of Object.entries(store.sessions)) {
            if (s.facultyId === id && !s.locked) { activeSession = { sessionId: sid, ...s }; break; }
        }
        res.json({
            id: f.id, name: f.name, dept: f.dept, courses: f.courses,
            activeSession: activeSession ? {
                sessionId: activeSession.sessionId, topic: activeSession.topic,
                status: activeSession.status, startedAt: activeSession.startedAt,
                courseCode: activeSession.courseCode, section: activeSession.section
            } : null
        });
    } catch (err) {
        console.error('Faculty login error:', err);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

app.post('/api/faculty/start-session', async (req, res) => {
    try {
        const { topic, courseCode, section, facultyId, facultyName } = req.body;
        if (!topic || !topic.trim()) return res.status(400).json({ error: 'Session topic is required' });
        if (!courseCode) return res.status(400).json({ error: 'Course is required' });
        if (!section) return res.status(400).json({ error: 'Section is required' });
        if (!facultyId) return res.status(400).json({ error: 'Faculty ID is missing' });

        const sessionId = sesId();
        const tok = token8();
        const now = Date.now();

        store.sessions[sessionId] = {
            sessionId, topic: topic.trim(), courseCode, section, facultyId, facultyName,
            startedAt: now, status: 'opening', locked: false, overrides: []
        };
        store.currentToken[sessionId] = { token: tok, generatedAt: now, expiresAt: now + 30000 };
        store.scans[sessionId] = {};

        await pool.query(
            `INSERT INTO sessions (session_id, topic, course_code, section, faculty_id, faculty_name, started_at, locked, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [sessionId, topic.trim(), courseCode, section, facultyId, facultyName, now, false, 'opening']
        );
        await pool.query(`INSERT INTO current_tokens VALUES ($1,$2,$3,$4)`, [sessionId, tok, now, now + 30000]);

        startTokenRotation(sessionId);

        // Auto-lock opening after 10 min
        store.openingTimers[sessionId] = setTimeout(async () => {
            const s = store.sessions[sessionId];
            if (s && !s.locked && s.status === 'opening') {
                s.status = 'opening_locked';
                if (store.rotateIntervals[sessionId]) { clearInterval(store.rotateIntervals[sessionId]); delete store.rotateIntervals[sessionId]; }
                await pool.query('UPDATE sessions SET status=$1 WHERE session_id=$2', ['opening_locked', sessionId]);
                console.log(`⏱ Opening window auto-locked: ${sessionId}`);
            }
        }, 10 * 60 * 1000);

        const qrImg = await QRCode.toDataURL(`${sessionId}|${tok}`, { width: 300, margin: 2 });
        res.json({ sessionId, token: tok, qrCode: qrImg, expiresAt: now + 30000 });
    } catch (err) {
        console.error('Start session error:', err);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

// Lock opening window manually
app.post('/api/faculty/lock-opening/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (s.locked) return res.status(400).json({ error: 'Session already locked' });
        if (s.status !== 'opening') return res.status(400).json({ error: 'Opening window is not active' });

        s.status = 'opening_locked';
        if (store.rotateIntervals[sessionId]) { clearInterval(store.rotateIntervals[sessionId]); delete store.rotateIntervals[sessionId]; }
        if (store.openingTimers[sessionId]) { clearTimeout(store.openingTimers[sessionId]); delete store.openingTimers[sessionId]; }
        await pool.query('UPDATE sessions SET status=$1 WHERE session_id=$2', ['opening_locked', sessionId]);
        res.json({ success: true, status: 'opening_locked' });
    } catch (err) {
        console.error('Lock opening error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// Resume opening window (opening_locked → opening)
app.post('/api/faculty/resume-opening/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (s.locked) return res.status(400).json({ error: 'Locked attendance cannot be resumed' });
        if (s.status !== 'opening_locked') return res.status(400).json({ error: 'Session is not in opening_locked state' });

        s.status = 'opening';
        await pool.query('UPDATE sessions SET status=$1 WHERE session_id=$2', ['opening', sessionId]);
        startTokenRotation(sessionId);

        // Auto-lock opening again after 10 min
        store.openingTimers[sessionId] = setTimeout(async () => {
            const s2 = store.sessions[sessionId];
            if (s2 && !s2.locked && s2.status === 'opening') {
                s2.status = 'opening_locked';
                if (store.rotateIntervals[sessionId]) { clearInterval(store.rotateIntervals[sessionId]); delete store.rotateIntervals[sessionId]; }
                await pool.query('UPDATE sessions SET status=$1 WHERE session_id=$2', ['opening_locked', sessionId]);
                console.log(`⏱ Resumed opening auto-locked: ${sessionId}`);
            }
        }, 10 * 60 * 1000);

        const td = store.currentToken[sessionId];
        const qrImg = await QRCode.toDataURL(`${sessionId}|${td.token}`, { width: 300, margin: 2 });
        res.json({ success: true, status: 'opening', token: td.token, qrCode: qrImg, expiresAt: td.expiresAt });
    } catch (err) {
        console.error('Resume opening error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// Start closing window
app.post('/api/faculty/start-closing/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (s.locked) return res.status(400).json({ error: 'Session already locked' });
        if (s.status !== 'opening_locked') return res.status(400).json({ error: 'Must close opening window first' });

        s.status = 'closing';
        await pool.query('UPDATE sessions SET status=$1 WHERE session_id=$2', ['closing', sessionId]);
        startTokenRotation(sessionId);

        // Auto-lock closing after 10 min
        store.closingTimers[sessionId] = setTimeout(async () => {
            const s2 = store.sessions[sessionId];
            if (s2 && !s2.locked && s2.status === 'closing') {
                await lockSession(sessionId);
                console.log(`⏱ Closing window auto-locked: ${sessionId}`);
            }
        }, 10 * 60 * 1000);

        const td = store.currentToken[sessionId];
        const qrImg = await QRCode.toDataURL(`${sessionId}|${td.token}`, { width: 300, margin: 2 });
        res.json({ success: true, status: 'closing', token: td.token, qrCode: qrImg, expiresAt: td.expiresAt });
    } catch (err) {
        console.error('Start closing error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// Full lock (finalize attendance)
app.post('/api/faculty/lock-session/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (s.locked) return res.status(400).json({ error: 'Session already locked' });
        if (s.status !== 'closing') return res.status(400).json({ error: 'Closing window must be active to lock attendance' });
        await lockSession(sessionId);
        res.json({ success: true });
    } catch (err) {
        console.error('Lock session error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

app.get('/api/faculty/session/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        if (!sessionId || !sessionId.startsWith('SES-')) return res.status(400).json({ error: 'Invalid session ID' });
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        const td = store.currentToken[sessionId];
        const roster = await rosterForSession(sessionId);
        let qrCode = null;
        if (td && !s.locked && s.status !== 'opening_locked') {
            qrCode = await QRCode.toDataURL(`${sessionId}|${td.token}`, { width: 300, margin: 2 });
        }
        res.json({
            session: s, token: td?.token, expiresAt: td?.expiresAt, serverTime: Date.now(),
            qrCode, roster,
            presentCount: roster.filter(r => r.status === 'Present' || r.status.startsWith('Present')).length,
            lateCount: roster.filter(r => r.status === 'Late').length,
            absentCount: roster.filter(r => r.status === 'Absent').length,
        });
    } catch (err) {
        console.error('Session poll error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

app.post('/api/faculty/override/:sessionId', async (req, res) => {
    try {
        const { rollNo, status } = req.body;
        const validStatuses = ['Present', 'Late', 'Absent'];
        if (!rollNo || !status) return res.status(400).json({ error: 'Roll number and status are required' });
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status value' });
        const s = store.sessions[req.params.sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        s.overrides = (s.overrides || []).filter(o => o.rollNo !== rollNo);
        s.overrides.push({ rollNo, status, at: Date.now() });
        await pool.query('UPDATE sessions SET overrides=$1 WHERE session_id=$2',
            [JSON.stringify(s.overrides), req.params.sessionId]);
        res.json({ success: true });
    } catch (err) {
        console.error('Override error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

app.get('/api/faculty/history', async (req, res) => {
    try {
        const { facultyId } = req.query;
        if (!facultyId) return res.status(400).json({ error: 'Faculty ID is required' });
        const fac = (await pool.query('SELECT * FROM faculty WHERE id=$1', [facultyId])).rows[0];
        if (!fac) return res.status(404).json({ error: 'Faculty not found' });
        const sessions = (await pool.query(
            `SELECT * FROM sessions WHERE locked=true AND course_code=ANY($1::text[]) ORDER BY started_at DESC`,
            [fac.courses]
        )).rows;
        const locked = [];
        for (const s of sessions) {
            const records = (await pool.query('SELECT * FROM attendance_records WHERE session_id=$1', [s.session_id])).rows;
            locked.push({
                sessionId: s.session_id, topic: s.topic || 'No topic', courseCode: s.course_code || 'N/A',
                section: s.section || 'N/A', facultyName: s.faculty_name, startedAt: s.started_at,
                records: records.map(r => ({ rollNo: r.roll_no, name: r.name, status: r.status })),
                present: records.filter(r => r.status === 'Present').length,
                late: records.filter(r => r.status === 'Late').length,
                absent: records.filter(r => r.status === 'Absent').length,
                total: records.length,
            });
        }
        res.json(locked);
    } catch (err) {
        console.error('History error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

app.get('/api/faculty/export/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
        const session = (await pool.query('SELECT * FROM sessions WHERE session_id=$1', [sessionId])).rows[0];
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (!session.locked) return res.status(400).json({ error: 'Session must be locked before exporting' });
        const buffer = await exportToExcel(sessionId);
        if (!buffer) return res.status(500).json({ error: 'Failed to generate Excel file' });
        const dateStr = new Date(Number(session.started_at)).toLocaleDateString('en-GB').replace(/\//g, '-');
        const filename = `Attendance_${session.course_code}_${session.section}_${dateStr}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (err) {
        console.error('Export error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ═══════════════════════════════════════════════════════════ STUDENT ROUTES ══

app.post('/api/student/login', async (req, res) => {
    try {
        const { rollNo, pass } = req.body;
        if (!rollNo || !pass) return res.status(400).json({ error: 'Roll number and password are required' });
        const student = (await pool.query('SELECT * FROM students WHERE roll_no=$1 AND pass=$2',
            [rollNo.trim().toUpperCase(), pass])).rows[0];
        if (!student) return res.status(401).json({ error: 'Incorrect roll number or password' });
        res.json({ rollNo: student.roll_no, name: student.name, section: student.section });
    } catch (err) {
        console.error('Student login error:', err);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

app.get('/api/sessions', (req, res) => {
    res.json(Object.values(store.sessions));
});

app.post('/api/student/scan', async (req, res) => {
    try {
        const { rollNo, sessionId, token } = req.body;
        if (!rollNo || !sessionId || !token) return res.status(400).json({ error: 'Roll number, session ID and token are required' });

        const student = (await pool.query('SELECT * FROM students WHERE roll_no=$1', [rollNo.trim().toUpperCase()])).rows[0];
        if (!student) return res.status(404).json({ error: 'Roll number not found' });

        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found. Make sure you have the right session ID.' });
        if (s.locked) return res.status(400).json({ error: 'Session is locked. Attendance has been finalized.', code: 'LOCKED' });
        if (s.status === 'opening_locked') return res.status(400).json({ error: 'Opening window is closed. Wait for faculty to start the closing window.', code: 'OPENING_LOCKED' });
        if (s.status !== 'opening' && s.status !== 'closing') return res.status(400).json({ error: 'No active attendance window right now.', code: 'NO_WINDOW' });

        const td = store.currentToken[sessionId];
        if (!td) return res.status(400).json({ error: 'No active token. Please try again.', code: 'NO_TOKEN' });
        if (token.trim().toUpperCase() !== td.token) return res.status(400).json({ error: 'QR code expired or token is wrong. Please scan the current code on the projector.', code: 'EXPIRED' });
        if (Date.now() > td.expiresAt) return res.status(400).json({ error: 'Token has expired. Please scan the new QR code.', code: 'EXPIRED' });

        if (!store.scans[sessionId]) store.scans[sessionId] = {};
        const isClosing = s.status === 'closing';
        const existing = store.scans[sessionId][rollNo];

        if (existing && existing.opening && existing.closing) {
            return res.status(400).json({ error: 'Your attendance is already fully recorded for this session.', code: 'DUPLICATE' });
        }

        let currentStatus = '';
        let message = '';

        if (!existing) {
            if (isClosing) {
                store.scans[sessionId][rollNo] = { opening: false, closing: true, firstScanAt: Date.now() };
                await pool.query(`INSERT INTO scans (session_id, roll_no, opening, closing, first_scan_at) VALUES ($1,$2,$3,$4,$5)`,
                    [sessionId, rollNo, false, true, Date.now()]);
                currentStatus = 'Late';
                message = '⏰ You are marked LATE (only closing window scanned).';
            } else {
                store.scans[sessionId][rollNo] = { opening: true, closing: false, firstScanAt: Date.now() };
                await pool.query(`INSERT INTO scans (session_id, roll_no, opening, closing, first_scan_at) VALUES ($1,$2,$3,$4,$5)`,
                    [sessionId, rollNo, true, false, Date.now()]);
                currentStatus = 'Opening Recorded';
                message = '📝 Opening window recorded! Scan again during the closing window to be marked PRESENT.';
            }
        } else {
            if (!isClosing) {
                return res.status(400).json({ error: 'Opening already recorded. Please scan during the closing window.', code: 'WAIT_FOR_CLOSING' });
            }
            existing.closing = true;
            existing.secondScanAt = Date.now();
            await pool.query('UPDATE scans SET closing=$1, second_scan_at=$2 WHERE session_id=$3 AND roll_no=$4',
                [true, Date.now(), sessionId, rollNo]);
            currentStatus = 'Present';
            message = '✅ You are marked PRESENT! (scanned in both windows)';
        }

        res.json({ success: true, currentStatus, message, window: isClosing ? 'closing' : 'opening' });
    } catch (err) {
        console.error('Scan error:', err);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

app.get('/api/student/:rollNo/attendance', async (req, res) => {
    try {
        const { rollNo } = req.params;
        if (!rollNo) return res.status(400).json({ error: 'Roll number is required' });
        const student = (await pool.query('SELECT * FROM students WHERE roll_no=$1', [rollNo.toUpperCase()])).rows[0];
        if (!student) return res.status(404).json({ error: 'Student not found' });
        const records = (await pool.query('SELECT * FROM attendance_records WHERE roll_no=$1 ORDER BY recorded_at DESC', [rollNo])).rows;
        const total = records.length;
        const present = records.filter(r => r.status === 'Present').length;
        const late = records.filter(r => r.status === 'Late').length;
        const absent = records.filter(r => r.status === 'Absent').length;
        const pct = total ? Math.round(((present + late) / total) * 100) : 0;
        res.json({
            records: records.map(r => ({ sessionId: r.session_id, date: r.recorded_at, status: r.status, courseCode: r.course_code })),
            total, present, late, absent, pct
        });
    } catch (err) {
        console.error('Attendance history error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ═══════════════════════════════════════════════════════ VIEW CODE PAGE ══
const fs = require('fs');
const ALLOWED_FILES = ['server.js', 'faculty.html', 'student.html'];

app.get('/code-file/:name', (req, res) => {
    const name = req.params.name;
    if (!ALLOWED_FILES.includes(name)) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.sendFile(path.join(__dirname, name));
});

app.get('/download/:name', (req, res) => {
    const name = req.params.name;
    if (!ALLOWED_FILES.includes(name)) return res.status(404).send('Not found');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.sendFile(path.join(__dirname, name));
});

app.get('/downloads', (req, res) => {
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>FLEX \u2014 Download Files</title><style>' +
'*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}' +
'.box{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:36px 40px;width:100%;max-width:460px}' +
'h1{font-size:22px;font-weight:700;color:#fff;margin-bottom:6px}' +
'.sub{font-size:13px;color:#64748b;margin-bottom:28px}' +
'.file-row{display:flex;align-items:center;justify-content:space-between;background:#0f172a;border:1px solid #334155;border-radius:10px;padding:14px 18px;margin-bottom:12px}' +
'.file-row:last-child{margin-bottom:0}' +
'.fname{font-family:monospace;font-size:14px;font-weight:700;color:#60a5fa}' +
'.fdesc{font-size:11px;color:#475569;margin-top:3px}' +
'a.dl{display:inline-flex;align-items:center;gap:6px;background:#2563eb;color:#fff;text-decoration:none;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:600;white-space:nowrap}' +
'a.dl:hover{background:#1d4ed8}' +
'.note{margin-top:24px;font-size:12px;color:#475569;line-height:1.7;background:#0f172a;border-radius:8px;padding:14px 16px}' +
'</style></head><body><div class="box">' +
'<h1>FLEX \u2014 Download Source Files</h1>' +
'<div class="sub">Click a button to download the file to your computer.</div>' +
'<div class="file-row"><div><div class="fname">server.js</div><div class="fdesc">Backend \u2014 all API routes &amp; database logic</div></div><a class="dl" href="/download/server.js">\u2193 Download</a></div>' +
'<div class="file-row"><div><div class="fname">faculty.html</div><div class="fdesc">Faculty portal \u2014 session management &amp; QR</div></div><a class="dl" href="/download/faculty.html">\u2193 Download</a></div>' +
'<div class="file-row"><div><div class="fname">student.html</div><div class="fdesc">Student portal \u2014 scan attendance &amp; history</div></div><a class="dl" href="/download/student.html">\u2193 Download</a></div>' +
'<div class="note">\u2139\ufe0f Each file downloads directly to your <strong>Downloads</strong> folder. Place all three inside a <code>backend/</code> folder in your project.</div>' +
'</div></body></html>');
});

app.get('/code', (req, res) => {
    res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><title>FLEX \u2014 Source Files</title><style>' +
'*{box-sizing:border-box;margin:0;padding:0}' +
'body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px;min-height:100vh}' +
'h1{font-size:22px;font-weight:700;margin-bottom:6px;color:#fff}' +
'.sub{font-size:13px;color:#64748b;margin-bottom:28px}' +
'.file-block{background:#1e293b;border:1px solid #334155;border-radius:12px;margin-bottom:28px;overflow:hidden}' +
'.file-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #334155}' +
'.file-name{font-family:monospace;font-size:14px;font-weight:700;color:#60a5fa}' +
'.copy-btn{background:#2563eb;color:#fff;border:none;padding:8px 18px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer}' +
'.copy-btn:hover{background:#1d4ed8}.copy-btn.done{background:#16a34a}' +
'.loading{padding:24px;color:#475569;font-family:monospace;font-size:13px}' +
'textarea{width:100%;height:440px;background:#0f172a;color:#a5f3fc;font-family:monospace;font-size:12px;line-height:1.6;padding:18px;border:none;resize:vertical;outline:none;display:block}' +
'</style></head><body>' +
'<h1>FLEX \u2014 Source Files</h1>' +
'<div class="sub">Click \u201cCopy All\u201d on any file, then paste it into your text editor.</div>' +
'<div id="root"><div class="loading">Loading files\u2026</div></div>' +
'<script>' +
'const FILES=["server.js","faculty.html","student.html"];' +
'async function load(){' +
'  const root=document.getElementById("root");root.innerHTML="";' +
'  for(const name of FILES){' +
'    const block=document.createElement("div");block.className="file-block";' +
'    const hdr=document.createElement("div");hdr.className="file-header";' +
'    const lbl=document.createElement("span");lbl.className="file-name";lbl.textContent="backend/"+name;' +
'    const btn=document.createElement("button");btn.className="copy-btn";btn.textContent="Copy All";' +
'    hdr.appendChild(lbl);hdr.appendChild(btn);block.appendChild(hdr);' +
'    const ta=document.createElement("textarea");ta.readOnly=true;ta.value="Loading...";' +
'    block.appendChild(ta);root.appendChild(block);' +
'    try{const r=await fetch("/code-file/"+name);ta.value=await r.text();}' +
'    catch(e){ta.value="Error loading file.";}' +
'    btn.onclick=function(){' +
'      ta.select();ta.setSelectionRange(0,99999999);' +
'      navigator.clipboard.writeText(ta.value).then(()=>{' +
'        btn.textContent="\u2713 Copied!";btn.classList.add("done");' +
'        setTimeout(()=>{btn.textContent="Copy All";btn.classList.remove("done");},2000);' +
'      }).catch(()=>{document.execCommand("copy");});' +
'    };' +
'  }' +
'}' +
'load();' +
'</script></body></html>');
});

// ═══════════════════════════════════════════════════════════ START SERVER ════
async function startServer() {
    await initDatabase();
    await restoreActiveSessions();
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log('\n══════════════════════════════════════════');
        console.log('  FLEX Attendance System');
        console.log('══════════════════════════════════════════');
        console.log(`  http://localhost:${PORT}`);
        console.log(`  Faculty → http://localhost:${PORT}/faculty.html`);
        console.log(`  Student → http://localhost:${PORT}/student.html`);
        console.log('══════════════════════════════════════════\n');
    });
}

startServer();
