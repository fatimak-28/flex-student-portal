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

// ---------- Database Initialization ----------
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
                ('24L-3003', 'Adina Saqib', 'BSE-243A', 'pass'),
                ('24L-3027', 'Fatima Kamran', 'BSE-243A', 'pass'),
                ('24L-3079', 'Maryam Ashfaq', 'BSE-243A', 'pass'),
                ('24L-3083', 'Areeba Iqbal', 'BSE-243A', 'pass')
            `);
            console.log('✓ Students seeded');
        }
        console.log('✅ Database ready');
    } catch (err) {
        console.error('DB init error:', err);
    } finally {
        client.release();
    }
}

// ---------- In-Memory Store ----------
const store = {
    sessions: {},
    currentToken: {},
    scans: {},
    rotateIntervals: {},
    openingTimers: {},
    closingTimers: {},
};

const token8 = () => Math.random().toString(36).substring(2, 10).toUpperCase();
const sesId = () => 'SES-' + Date.now();

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

async function lockSession(sessionId) {
    const s = store.sessions[sessionId];
    if (!s || s.locked) return;

    s.locked = true;
    s.status = 'locked';
    s.lockedAt = Date.now();

    if (store.rotateIntervals[sessionId]) clearInterval(store.rotateIntervals[sessionId]);
    if (store.openingTimers[sessionId]) clearTimeout(store.openingTimers[sessionId]);
    if (store.closingTimers[sessionId]) clearTimeout(store.closingTimers[sessionId]);

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
             ON CONFLICT (session_id, roll_no) DO NOTHING`,
            [sessionId, st.roll_no, st.name, st.section, s.courseCode, finalStatus, s.startedAt]
        );
    }
    console.log(`🔒 Session ${sessionId} locked.`);
}

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

// ---------- FACULTY ROUTES ----------
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
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});
// PUT /api/faculty/session/:sessionId/topic
app.put('/api/faculty/session/:sessionId/topic', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { topic } = req.body;
        if (!topic || !topic.trim()) return res.status(400).json({ error: 'Topic cannot be empty' });

        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });

        s.topic = topic.trim();
        await pool.query('UPDATE sessions SET topic=$1 WHERE session_id=$2', [topic.trim(), sessionId]);
        res.json({ success: true, topic: s.topic });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});
// POST /api/faculty/override-locked/:sessionId
app.post('/api/faculty/override-locked/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { rollNo, status } = req.body;
        const validStatuses = ['Present', 'Late', 'Absent'];
        if (!rollNo || !status) return res.status(400).json({ error: 'Roll number and status required' });
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });

        // Allow override only if session is locked (or you can also allow during active session)
        if (!s.locked) {
            // Fallback to normal override (already exists)
            s.overrides = (s.overrides || []).filter(o => o.rollNo !== rollNo);
            s.overrides.push({ rollNo, status, at: Date.now() });
            await pool.query('UPDATE sessions SET overrides=$1 WHERE session_id=$2', [JSON.stringify(s.overrides), sessionId]);
            return res.json({ success: true, message: 'Override saved (active session)' });
        }

        // For locked sessions, update attendance_records directly
        await pool.query(
            `UPDATE attendance_records SET status=$1 WHERE session_id=$2 AND roll_no=$3`,
            [status, sessionId, rollNo]
        );
        res.json({ success: true, message: `Override saved for locked session (${status})` });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/faculty/start-session', async (req, res) => {
    try {
        const { topic, courseCode, section, facultyId, facultyName } = req.body;
        if (!topic || !topic.trim()) return res.status(400).json({ error: 'Topic required' });
        if (!courseCode) return res.status(400).json({ error: 'Course required' });
        if (!section) return res.status(400).json({ error: 'Section required' });
        if (!facultyId) return res.status(400).json({ error: 'Faculty ID missing' });

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

        store.openingTimers[sessionId] = setTimeout(async () => {
            const s = store.sessions[sessionId];
            if (s && !s.locked && s.status === 'opening') {
                s.status = 'opening_locked';
                if (store.rotateIntervals[sessionId]) clearInterval(store.rotateIntervals[sessionId]);
                await pool.query('UPDATE sessions SET status=$1 WHERE session_id=$2', ['opening_locked', sessionId]);
                console.log(`⏱ Opening auto-locked: ${sessionId}`);
            }
        }, 10 * 60 * 1000);

        const qrImg = await QRCode.toDataURL(`${sessionId}|${tok}`, { width: 300, margin: 2 });
        res.json({ sessionId, token: tok, qrCode: qrImg, expiresAt: now + 30000, session: store.sessions[sessionId] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/faculty/lock-opening/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (s.locked) return res.status(400).json({ error: 'Already locked' });
        if (s.status !== 'opening') return res.status(400).json({ error: 'Not in opening' });
        s.status = 'opening_locked';
        if (store.rotateIntervals[sessionId]) clearInterval(store.rotateIntervals[sessionId]);
        if (store.openingTimers[sessionId]) clearTimeout(store.openingTimers[sessionId]);
        await pool.query('UPDATE sessions SET status=$1 WHERE session_id=$2', ['opening_locked', sessionId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/faculty/resume-opening/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (s.locked) return res.status(400).json({ error: 'Locked cannot resume' });
        if (s.status !== 'opening_locked') return res.status(400).json({ error: 'Not in opening_locked' });
        s.status = 'opening';
        await pool.query('UPDATE sessions SET status=$1 WHERE session_id=$2', ['opening', sessionId]);
        startTokenRotation(sessionId);
        store.openingTimers[sessionId] = setTimeout(async () => {
            const s2 = store.sessions[sessionId];
            if (s2 && !s2.locked && s2.status === 'opening') {
                s2.status = 'opening_locked';
                if (store.rotateIntervals[sessionId]) clearInterval(store.rotateIntervals[sessionId]);
                await pool.query('UPDATE sessions SET status=$1 WHERE session_id=$2', ['opening_locked', sessionId]);
            }
        }, 10 * 60 * 1000);
        const td = store.currentToken[sessionId];
        const qrImg = await QRCode.toDataURL(`${sessionId}|${td.token}`, { width: 300, margin: 2 });
        res.json({ success: true, token: td.token, qrCode: qrImg, expiresAt: td.expiresAt });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/faculty/start-closing/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Not found' });
        if (s.locked) return res.status(400).json({ error: 'Locked' });
        if (s.status !== 'opening_locked') return res.status(400).json({ error: 'Must close opening first' });
        s.status = 'closing';
        await pool.query('UPDATE sessions SET status=$1 WHERE session_id=$2', ['closing', sessionId]);
        startTokenRotation(sessionId);
        store.closingTimers[sessionId] = setTimeout(async () => {
            const s2 = store.sessions[sessionId];
            if (s2 && !s2.locked && s2.status === 'closing') {
                await lockSession(sessionId);
            }
        }, 10 * 60 * 1000);
        const td = store.currentToken[sessionId];
        const qrImg = await QRCode.toDataURL(`${sessionId}|${td.token}`, { width: 300, margin: 2 });
        res.json({ success: true, token: td.token, qrCode: qrImg, expiresAt: td.expiresAt });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/faculty/lock-session/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Not found' });
        if (s.locked) return res.status(400).json({ error: 'Already locked' });
        if (s.status !== 'closing') return res.status(400).json({ error: 'Closing window must be active' });
        await lockSession(sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/faculty/session/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Not found' });
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
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/faculty/override/:sessionId', async (req, res) => {
    try {
        const { rollNo, status } = req.body;
        const { sessionId } = req.params;
        const valid = ['Present', 'Late', 'Absent'];
        if (!rollNo || !status) return res.status(400).json({ error: 'Missing' });
        if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        s.overrides = (s.overrides || []).filter(o => o.rollNo !== rollNo);
        s.overrides.push({ rollNo, status, at: Date.now() });
        await pool.query('UPDATE sessions SET overrides=$1 WHERE session_id=$2', [JSON.stringify(s.overrides), sessionId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/faculty/history', async (req, res) => {
    try {
        const { facultyId } = req.query;
        if (!facultyId) return res.status(400).json({ error: 'Faculty ID required' });
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
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/faculty/export/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = (await pool.query('SELECT * FROM sessions WHERE session_id=$1', [sessionId])).rows[0];
        if (!session) return res.status(404).json({ error: 'Not found' });
        if (!session.locked) return res.status(400).json({ error: 'Session must be locked' });
        const buffer = await exportToExcel(sessionId);
        const dateStr = new Date(Number(session.started_at)).toLocaleDateString('en-GB').replace(/\//g, '-');
        const filename = `Attendance_${session.course_code}_${session.section}_${dateStr}.xlsx`;
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- STUDENT ROUTES ----------
app.post('/api/student/login', async (req, res) => {
    try {
        const { rollNo, pass } = req.body;
        if (!rollNo || !pass) return res.status(400).json({ error: 'Roll number and password required' });
        const student = (await pool.query('SELECT * FROM students WHERE roll_no=$1 AND pass=$2',
            [rollNo.trim().toUpperCase(), pass])).rows[0];
        if (!student) return res.status(401).json({ error: 'Incorrect roll number or password' });
        res.json({ rollNo: student.roll_no, name: student.name, section: student.section });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/sessions', (req, res) => {
    const active = Object.values(store.sessions).filter(s => !s.locked);
    res.json(active);
});

app.post('/api/student/scan', async (req, res) => {
    try {
        const { rollNo, sessionId, token } = req.body;
        if (!rollNo || !sessionId || !token) return res.status(400).json({ error: 'Missing data' });
        const student = (await pool.query('SELECT * FROM students WHERE roll_no=$1', [rollNo.toUpperCase()])).rows[0];
        if (!student) return res.status(404).json({ error: 'Student not found' });
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (s.locked) return res.status(400).json({ error: 'Session locked', code: 'LOCKED' });
        if (s.status === 'opening_locked') return res.status(400).json({ error: 'Opening closed', code: 'OPENING_LOCKED' });
        if (s.status !== 'opening' && s.status !== 'closing') return res.status(400).json({ error: 'No active window', code: 'NO_WINDOW' });
        const td = store.currentToken[sessionId];
        if (!td) return res.status(400).json({ error: 'No token', code: 'NO_TOKEN' });
        if (token.trim().toUpperCase() !== td.token) return res.status(400).json({ error: 'Token expired/wrong', code: 'EXPIRED' });
        if (Date.now() > td.expiresAt) return res.status(400).json({ error: 'Token expired', code: 'EXPIRED' });
        if (!store.scans[sessionId]) store.scans[sessionId] = {};
        const existing = store.scans[sessionId][rollNo];
        if (existing && existing.opening && existing.closing) {
            return res.status(400).json({ error: 'Already fully recorded', code: 'DUPLICATE' });
        }
        let currentStatus = '', message = '';
        if (!existing) {
            if (s.status === 'closing') {
                store.scans[sessionId][rollNo] = { opening: false, closing: true, firstScanAt: Date.now() };
                await pool.query(`INSERT INTO scans (session_id, roll_no, opening, closing, first_scan_at) VALUES ($1,$2,$3,$4,$5)`,
                    [sessionId, rollNo, false, true, Date.now()]);
                currentStatus = 'Late';
                message = 'Marked LATE (only closing window)';
            } else {
                store.scans[sessionId][rollNo] = { opening: true, closing: false, firstScanAt: Date.now() };
                await pool.query(`INSERT INTO scans (session_id, roll_no, opening, closing, first_scan_at) VALUES ($1,$2,$3,$4,$5)`,
                    [sessionId, rollNo, true, false, Date.now()]);
                currentStatus = 'Opening Recorded';
                message = 'Opening recorded! Scan again in closing window.';
            }
        } else {
            if (s.status !== 'closing') {
                return res.status(400).json({ error: 'Wait for closing window', code: 'WAIT_FOR_CLOSING' });
            }
            existing.closing = true;
            existing.secondScanAt = Date.now();
            await pool.query('UPDATE scans SET closing=$1, second_scan_at=$2 WHERE session_id=$3 AND roll_no=$4',
                [true, Date.now(), sessionId, rollNo]);
            currentStatus = 'Present';
            message = 'Marked PRESENT! (both windows)';
        }
        res.json({ success: true, currentStatus, message });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/student/:rollNo/attendance', async (req, res) => {
    try {
        const { rollNo } = req.params;
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
        res.status(500).json({ error: 'Server error' });
    }
});

// ---------- STATIC FILES & CODE VIEWER ----------
app.get('/code-file/:name', (req, res) => {
    const allowed = ['server.js', 'faculty.html', 'student.html'];
    if (!allowed.includes(req.params.name)) return res.status(404).send('Not allowed');
    res.sendFile(path.join(__dirname, req.params.name));
});

app.get('/download/:name', (req, res) => {
    const allowed = ['server.js', 'faculty.html', 'student.html'];
    if (!allowed.includes(req.params.name)) return res.status(404).send('Not allowed');
    res.download(path.join(__dirname, req.params.name));
});

app.get('/downloads', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Downloads</title></head><body><h1>Download Files</h1><a href="/download/server.js">server.js</a><br><a href="/download/faculty.html">faculty.html</a><br><a href="/download/student.html">student.html</a></body></html>`);
});

app.get('/code', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Code Viewer</title></head><body><h1>FLEX Source Code</h1><a href="/code-file/server.js">server.js</a><br><a href="/code-file/faculty.html">faculty.html</a><br><a href="/code-file/student.html">student.html</a></body></html>`);
});

// ---------- START SERVER ----------
async function startServer() {
    await initDatabase();
    await restoreActiveSessions();
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n✅ FLEX running on http://localhost:${PORT}`);
        console.log(`   Faculty → http://localhost:${PORT}/faculty.html`);
        console.log(`   Student → http://localhost:${PORT}/student.html\n`);
    });
}

startServer();