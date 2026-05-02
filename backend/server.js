const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

// DATABASE SETUP
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

initDatabase();

// IN-MEMORY STORE
const store = {
    students: [
        { rollNo: '24L-3001', name: 'Ahmed Raza', section: 'BSE-243A', pass: 'pass' },
        { rollNo: '24L-3002', name: 'Sara Khan', section: 'BSE-243A', pass: 'pass' },
        { rollNo: '24L-3003', name: 'Adina Saqib', section: 'BSE-243A', pass: 'pass' },
        { rollNo: '24L-3027', name: 'Fatima Kamran', section: 'BSE-243A', pass: 'pass' },
        { rollNo: '24L-3079', name: 'Maryam Ashfaq', section: 'BSE-243A', pass: 'pass' },
        { rollNo: '24L-3083', name: 'Areeba Iqbal', section: 'BSE-243A', pass: 'pass' },
        { rollNo: '24L-3010', name: 'Usman Tariq', section: 'BSE-243A', pass: 'pass' },
        { rollNo: '24L-3015', name: 'Hina Malik', section: 'BSE-243A', pass: 'pass' },
        { rollNo: '24L-3022', name: 'Bilal Ahmed', section: 'BSE-243A', pass: 'pass' },
        { rollNo: '24L-3045', name: 'Zara Hussain', section: 'BSE-243A', pass: 'pass' },
        { rollNo: '24L-3051', name: 'Ali Hassan', section: 'BSE-243B', pass: 'pass' },
        { rollNo: '24L-3062', name: 'Noor Fatima', section: 'BSE-243B', pass: 'pass' },
    ],
    faculty: [
        { id: 'FAC-001', name: 'Dr. Zeeshan Ali Rana', dept: 'SE', courses: ['SE-2001', 'SE-3002'], pass: 'admin' },
        { id: 'FAC-002', name: 'Dr. Aisha Tariq', dept: 'CS', courses: ['CS-3001'], pass: 'admin' },
    ],
    sessions: {},
    currentToken: {},
    scans: {},
    rotateIntervals: {},
    attendanceHistory: {},
};

// UTILITY FUNCTIONS
const token8 = () => Math.random().toString(36).substring(2, 10).toUpperCase();
const sesId = () => 'SES-' + Date.now();

async function lockSession(sessionId) {
    const s = store.sessions[sessionId];
    if (!s || s.locked) return;

    s.locked = true;
    s.status = 'locked';
    s.lockedAt = Date.now();

    if (store.rotateIntervals[sessionId]) {
        clearInterval(store.rotateIntervals[sessionId]);
        delete store.rotateIntervals[sessionId];
    }

    await pool.query(
        'UPDATE sessions SET locked = $1, status = $2, locked_at = $3 WHERE session_id = $4',
        [true, 'locked', s.lockedAt, sessionId]
    );

    const students = store.students.filter(st => st.section === s.section);
    const scans = store.scans[sessionId] || {};

    for (const st of students) {
        const scan = scans[st.rollNo];
        let finalStatus = 'Absent';

        if (scan) {
            if (scan.opening && scan.closing) finalStatus = 'Present';
            else if (scan.closing) finalStatus = 'Late';
            else if (scan.opening) finalStatus = 'Present';
        }

        const ov = (s.overrides || []).find(o => o.rollNo === st.rollNo);
        if (ov) finalStatus = ov.status;

        await pool.query(
            `INSERT INTO attendance_records (session_id, roll_no, name, section, course_code, status, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (session_id, roll_no) DO UPDATE SET status = $6`,
            [sessionId, st.rollNo, st.name, st.section, s.courseCode, finalStatus, s.startedAt]
        );
    }

    console.log(`🔒 Session ${sessionId} locked.`);
}

function rosterForSession(sessionId) {
    const s = store.sessions[sessionId];
    const scans = store.scans[sessionId] || {};
    const students = store.students.filter(st => st.section === s.section);

    return students.map(st => {
        const scan = scans[st.rollNo];
        let status = 'Absent';

        if (scan) {
            if (scan.opening && scan.closing) status = 'Present';
            else if (scan.closing) status = 'Late';
            else if (scan.opening) status = 'Opening Recorded';
        }

        const ov = (s.overrides || []).find(o => o.rollNo === st.rollNo);
        if (ov) status = ov.status + ' (override)';

        return { ...st, status, scanned: !!scan };
    });
}

// ============ FACULTY ROUTES ============

app.post('/api/faculty/login', async (req, res) => {
    const { id, pass } = req.body;
    const dbRes = await pool.query('SELECT * FROM faculty WHERE id = $1 AND pass = $2', [id, pass]);
    const f = dbRes.rows[0];

    if (!f) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ id: f.id, name: f.name, dept: f.dept, courses: f.courses });
});

app.post('/api/faculty/start-session', async (req, res) => {
    const { topic, courseCode, section, facultyId, facultyName } = req.body;
    if (!topic || !courseCode || !section) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    const sessionId = sesId();
    const tok = token8();
    const now = Date.now();

    store.sessions[sessionId] = {
        sessionId, topic, courseCode, section, facultyId, facultyName,
        startedAt: now, status: 'opening', locked: false, overrides: []
    };
    store.currentToken[sessionId] = { token: tok, generatedAt: now, expiresAt: now + 30000 };
    store.scans[sessionId] = {};

    await pool.query(
        `INSERT INTO sessions (session_id, topic, course_code, section, faculty_id, faculty_name, started_at, locked, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [sessionId, topic, courseCode, section, facultyId, facultyName, now, false, 'opening']
    );
    await pool.query(
        `INSERT INTO current_tokens (session_id, token, generated_at, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [sessionId, tok, now, now + 30000]
    );

    setTimeout(() => {
        const s = store.sessions[sessionId];
        if (s && !s.locked) {
            s.status = 'closing';
            pool.query('UPDATE sessions SET status = $1 WHERE session_id = $2', ['closing', sessionId]);
        }
    }, 10 * 60 * 1000);

    setTimeout(() => lockSession(sessionId), 20 * 60 * 1000);

    store.rotateIntervals[sessionId] = setInterval(async () => {
        const s = store.sessions[sessionId];
        if (!s || s.locked) {
            clearInterval(store.rotateIntervals[sessionId]);
            return;
        }
        const nt = token8();
        const now2 = Date.now();
        store.currentToken[sessionId] = { token: nt, generatedAt: now2, expiresAt: now2 + 30000 };
        await pool.query(
            `UPDATE current_tokens SET token = $1, generated_at = $2, expires_at = $3 WHERE session_id = $4`,
            [nt, now2, now2 + 30000, sessionId]
        );
    }, 30000);

    const qrData = `${sessionId}|${tok}`;
    const qrImg = await QRCode.toDataURL(qrData, { width: 300, margin: 2 });
    res.json({ sessionId, token: tok, qrCode: qrImg, expiresAt: now + 30000 });
});

app.get('/api/faculty/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const s = store.sessions[sessionId];
    if (!s) return res.status(404).json({ error: 'Not found' });

    const td = store.currentToken[sessionId];
    const roster = rosterForSession(sessionId);
    let qrCode = null;

    if (td && !s.locked) {
        const qrData = `${sessionId}|${td.token}`;
        qrCode = await QRCode.toDataURL(qrData, { width: 300, margin: 2 });
    }

    res.json({
        session: s, token: td?.token, expiresAt: td?.expiresAt, serverTime: Date.now(),
        qrCode, roster,
        presentCount: roster.filter(r => r.status.startsWith('Present')).length,
        lateCount: roster.filter(r => r.status === 'Late').length,
        absentCount: roster.filter(r => r.status === 'Absent').length,
    });
});

app.post('/api/faculty/lock-session/:sessionId', async (req, res) => {
    await lockSession(req.params.sessionId);
    res.json({ success: true });
});

app.post('/api/faculty/closing-window/:sessionId', async (req, res) => {
    const s = store.sessions[req.params.sessionId];
    if (s && !s.locked) {
        s.status = 'closing';
        await pool.query('UPDATE sessions SET status = $1 WHERE session_id = $2', ['closing', req.params.sessionId]);
    }
    res.json({ success: true });
});

app.post('/api/faculty/override/:sessionId', async (req, res) => {
    const { rollNo, status, reason } = req.body;
    const s = store.sessions[req.params.sessionId];
    if (!s) return res.status(404).json({ error: 'Not found' });

    s.overrides = (s.overrides || []).filter(o => o.rollNo !== rollNo);
    s.overrides.push({ rollNo, status, reason, at: Date.now() });
    await pool.query(
        'UPDATE sessions SET overrides = $1 WHERE session_id = $2',
        [JSON.stringify(s.overrides), req.params.sessionId]
    );
    res.json({ success: true });
});

app.get('/api/faculty/history', async (req, res) => {
    const { facultyId } = req.query;

    const facRes = await pool.query('SELECT * FROM faculty WHERE id = $1', [facultyId]);
    const fac = facRes.rows[0];
    if (!fac) return res.status(404).json({ error: 'Faculty not found' });

    const sessionsRes = await pool.query(
        `SELECT * FROM sessions 
         WHERE locked = true AND course_code = ANY($1::text[])
         ORDER BY started_at DESC`,
        [fac.courses]
    );

    const locked = [];
    for (const s of sessionsRes.rows) {
        const recordsRes = await pool.query(
            'SELECT * FROM attendance_records WHERE session_id = $1',
            [s.session_id]
        );

        const records = recordsRes.rows.map(r => ({
            rollNo: r.roll_no,
            name: r.name,
            section: r.section,
            status: r.status,
        }));

        const present = records.filter(r => r.status === 'Present').length;
        const late = records.filter(r => r.status === 'Late').length;
        const absent = records.filter(r => r.status === 'Absent').length;

        locked.push({
            sessionId: s.session_id,
            topic: s.topic,
            courseCode: s.course_code,
            section: s.section,
            facultyName: s.faculty_name,
            startedAt: s.started_at,
            records,
            present, late, absent,
            total: records.length,
        });
    }

    res.json(locked);
});

// ============ EDIT ENDPOINTS ============

app.patch('/api/faculty/session/:sessionId/meta', async (req, res) => {
    const { sessionId } = req.params;
    const { topic, courseCode, section } = req.body;

    console.log('📝 Editing session metadata:', sessionId);

    try {
        const dbCheck = await pool.query('SELECT session_id FROM sessions WHERE session_id = $1', [sessionId]);
        if (dbCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Session not found in database' });
        }

        await pool.query(
            'UPDATE sessions SET topic = $1, course_code = $2, section = $3 WHERE session_id = $4',
            [topic, courseCode, section, sessionId]
        );

        if (store.sessions[sessionId]) {
            if (topic) store.sessions[sessionId].topic = topic;
            if (courseCode) store.sessions[sessionId].courseCode = courseCode;
            if (section) store.sessions[sessionId].section = section;
        }

        res.json({ success: true, message: 'Metadata updated' });
    } catch (err) {
        console.error('DB update error:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});

app.patch('/api/faculty/session/:sessionId/record', async (req, res) => {
    const { sessionId } = req.params;
    const { rollNo, status } = req.body;

    console.log('📝 Updating student record:', sessionId, rollNo, '→', status);

    try {
        // Step 1: try to update the existing row
        const updateResult = await pool.query(
            'UPDATE attendance_records SET status = $1 WHERE session_id = $2 AND roll_no = $3',
            [status, sessionId, rollNo]
        );

        // Step 2: if no row existed yet, look up student and session separately then insert
        if (updateResult.rowCount === 0) {
            const studentRes = await pool.query(
                'SELECT name, section FROM students WHERE roll_no = $1',
                [rollNo]
            );
            const sessionRes = await pool.query(
                'SELECT course_code, started_at FROM sessions WHERE session_id = $1',
                [sessionId]
            );

            if (studentRes.rows.length === 0 || sessionRes.rows.length === 0) {
                return res.status(404).json({ error: 'Student or session not found' });
            }

            const { name, section } = studentRes.rows[0];
            const { course_code, started_at } = sessionRes.rows[0];

            await pool.query(
                'INSERT INTO attendance_records (session_id, roll_no, name, section, course_code, status, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (session_id, roll_no) DO UPDATE SET status = EXCLUDED.status',
                [sessionId, rollNo, name, section, course_code, status, started_at]
            );
        }

        res.json({ success: true, message: 'Record updated' });
    } catch (err) {
        console.error('DB update error:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    }
});


// Batch update all attendance records for a session in one transactional request
app.patch('/api/faculty/session/:sessionId/records-batch', async (req, res) => {
    const { sessionId } = req.params;
    const { records } = req.body;

    if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: 'records array is required' });
    }

    console.log('Batch updating', records.length, 'records for session:', sessionId);

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const { rollNo, status } of records) {
            const updateResult = await client.query(
                'UPDATE attendance_records SET status = $1 WHERE session_id = $2 AND roll_no = $3',
                [status, sessionId, rollNo]
            );

            if (updateResult.rowCount === 0) {
                const studentRes = await client.query(
                    'SELECT name, section FROM students WHERE roll_no = $1',
                    [rollNo]
                );
                const sessionRes = await client.query(
                    'SELECT course_code, started_at FROM sessions WHERE session_id = $1',
                    [sessionId]
                );
                if (studentRes.rows.length > 0 && sessionRes.rows.length > 0) {
                    const { name, section } = studentRes.rows[0];
                    const { course_code, started_at } = sessionRes.rows[0];
                    await client.query(
                        'INSERT INTO attendance_records (session_id, roll_no, name, section, course_code, status, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (session_id, roll_no) DO UPDATE SET status = EXCLUDED.status',
                        [sessionId, rollNo, name, section, course_code, status, started_at]
                    );
                }
            }
        }

        await client.query('COMMIT');
        res.json({ success: true, updated: records.length });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Batch update error:', err);
        res.status(500).json({ error: 'Database error: ' + err.message });
    } finally {
        client.release();
    }
});

// ============ STUDENT ROUTES ============

app.post('/api/student/login', async (req, res) => {
    const { rollNo, pass } = req.body;
    const dbRes = await pool.query('SELECT * FROM students WHERE roll_no = $1 AND pass = $2', [rollNo.toUpperCase(), pass]);
    const student = dbRes.rows[0];

    if (!student) {
        return res.status(401).json({ error: 'Invalid roll number or password' });
    }

    res.json({
        rollNo: student.roll_no,
        name: student.name,
        section: student.section
    });
});

app.get('/api/student/:rollNo', async (req, res) => {
    const dbRes = await pool.query('SELECT * FROM students WHERE roll_no = $1', [req.params.rollNo]);
    const student = dbRes.rows[0];
    if (!student) return res.status(404).json({ error: 'Student not found' });
    res.json(student);
});

app.get('/api/sessions', (req, res) => {
    res.json(Object.values(store.sessions));
});

app.post('/api/student/scan', async (req, res) => {
    const { rollNo, sessionId, token } = req.body;
    const student = store.students.find(s => s.rollNo === rollNo);
    if (!student) return res.status(404).json({ error: 'Roll number not found' });

    const s = store.sessions[sessionId];
    if (!s) return res.status(404).json({ error: 'Session not found' });
    if (s.locked) return res.status(400).json({ error: 'Session is locked. Cannot record attendance.', code: 'LOCKED' });

    const td = store.currentToken[sessionId];
    if (!td) return res.status(400).json({ error: 'No active token', code: 'NO_TOKEN' });

    if (token !== td.token) {
        return res.status(400).json({
            error: 'QR code expired or invalid. Please scan the current code on the projector.',
            code: 'EXPIRED'
        });
    }

    if (Date.now() > td.expiresAt) {
        return res.status(400).json({ error: 'Token has expired. Please scan the new QR code.', code: 'EXPIRED' });
    }

    if (!store.scans[sessionId]) store.scans[sessionId] = {};
    const existing = store.scans[sessionId][rollNo];

    if (existing && existing.opening && existing.closing) {
        return res.status(400).json({ error: 'Attendance already fully recorded for this session.', code: 'DUPLICATE' });
    }

    const isClosing = s.status === 'closing';

    if (!existing) {
        store.scans[sessionId][rollNo] = {
            opening: !isClosing,
            closing: isClosing,
            firstScanAt: Date.now()
        };
        await pool.query(
            `INSERT INTO scans (session_id, roll_no, opening, closing, first_scan_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (session_id, roll_no) DO UPDATE SET opening = $3, closing = $4`,
            [sessionId, rollNo, !isClosing, isClosing, Date.now()]
        );
    } else {
        store.scans[sessionId][rollNo].closing = true;
        store.scans[sessionId][rollNo].secondScanAt = Date.now();
        await pool.query(
            `UPDATE scans SET closing = $1, second_scan_at = $2 WHERE session_id = $3 AND roll_no = $4`,
            [true, Date.now(), sessionId, rollNo]
        );
    }

    const scan = store.scans[sessionId][rollNo];
    let currentStatus = '';
    if (scan.opening && scan.closing) currentStatus = 'Present';
    else if (scan.closing) currentStatus = 'Late';
    else currentStatus = 'Opening Recorded';

    const messages = {
        'Present': '✅ You are marked PRESENT.',
        'Late': '⏰ You are marked LATE.',
        'Opening Recorded': '📝 Opening window recorded. Scan again during closing window to confirm Present.'
    };

    res.json({ success: true, currentStatus, message: messages[currentStatus], window: isClosing ? 'closing' : 'opening' });
});

app.get('/api/student/:rollNo/attendance', async (req, res) => {
    const { rollNo } = req.params;
    const { courseCode } = req.query;

    const dbRes = await pool.query(
        'SELECT * FROM attendance_records WHERE roll_no = $1 AND course_code = $2 ORDER BY recorded_at DESC',
        [rollNo, courseCode]
    );
    const records = dbRes.rows.map(r => ({
        sessionId: r.session_id,
        date: r.recorded_at,
        status: r.status
    }));

    const total = records.length;
    const present = records.filter(r => r.status === 'Present').length;
    const late = records.filter(r => r.status === 'Late').length;
    const absent = records.filter(r => r.status === 'Absent').length;
    const pct = total ? Math.round(((present + late) / total) * 100) : 0;

    res.json({ records, total, present, late, absent, pct });
});

// ============ START SERVER ============
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', async () => {
    console.log('\n══════════════════════════════════════════');
    console.log('  FLEX Attendance System');
    console.log('══════════════════════════════════════════');
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Faculty → http://localhost:${PORT}/faculty.html`);
    console.log(`  Student → http://localhost:${PORT}/student.html`);
    console.log('══════════════════════════════════════════\n');
    console.log('Faculty IDs: FAC-001 / FAC-002   Password: admin');
    console.log('Student roll nos: 24L-3083 etc.  Password: pass\n');
});