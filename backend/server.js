const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const { Pool } = require('pg');
const XLSX = require('xlsx');
const fs = require('fs');
require('dotenv').config();

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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

        console.log('✅ Database initialized successfully');
    } catch (err) {
        console.error('Database init error:', err);
    } finally {
        client.release();
    }
}

// IN-MEMORY STORE
const store = {
    sessions: {},
    currentToken: {},
    scans: {},
    rotateIntervals: {},
    lastExport: {},
};

const token8 = () => Math.random().toString(36).substring(2, 10).toUpperCase();
const sesId = () => 'SES-' + Date.now();

async function exportToExcel(sessionId, section) {
    try {
        const sessionRes = await pool.query('SELECT * FROM sessions WHERE session_id = $1', [sessionId]);
        const session = sessionRes.rows[0];
        if (!session) return null;
        
        const recordsRes = await pool.query('SELECT * FROM attendance_records WHERE session_id = $1 ORDER BY roll_no', [sessionId]);
        const studentsRes = await pool.query('SELECT * FROM students WHERE section = $1 ORDER BY roll_no', [section]);
        
        const workbook = XLSX.utils.book_new();
        const dateStr = new Date(Number(session.started_at)).toLocaleDateString('en-GB');
        const headers = ['S#', 'Roll No.', 'Student Name', dateStr];
        const data = [headers];
        
        let sno = 1;
        for (const student of studentsRes.rows) {
            const record = recordsRes.rows.find(r => r.roll_no === student.roll_no);
            let status = 'A';
            if (record) {
                if (record.status === 'Present') status = 'P';
                else if (record.status === 'Late') status = 'L';
            }
            data.push([sno++, student.roll_no, student.name, status]);
        }
        
        const worksheet = XLSX.utils.aoa_to_sheet(data);
        worksheet['!cols'] = [{ wch: 5 }, { wch: 12 }, { wch: 30 }, { wch: 15 }];
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Attendance');
        
        return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    } catch (err) {
        console.error('Excel export error:', err);
        return null;
    }
}

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

    await pool.query('UPDATE sessions SET locked = $1, status = $2, locked_at = $3 WHERE session_id = $4',
        [true, 'locked', s.lockedAt, sessionId]);

    const studentsRes = await pool.query('SELECT * FROM students WHERE section = $1', [s.section]);
    const students = studentsRes.rows;
    const scans = store.scans[sessionId] || {};

    for (const st of students) {
        const scan = scans[st.roll_no];
        let finalStatus = 'Absent';

        if (scan) {
            if (scan.opening && scan.closing) finalStatus = 'Present';
            else if (scan.closing) finalStatus = 'Late';
            else if (scan.opening) finalStatus = 'Late';
        }

        const ov = (s.overrides || []).find(o => o.rollNo === st.roll_no);
        if (ov) finalStatus = ov.status;

        await pool.query(
            `INSERT INTO attendance_records (session_id, roll_no, name, section, course_code, status, recorded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (session_id, roll_no) DO UPDATE SET status = $6`,
            [sessionId, st.roll_no, st.name, st.section, s.courseCode, finalStatus, s.startedAt]
        );
    }
    
    const excelBuffer = await exportToExcel(sessionId, s.section);
    if (excelBuffer) {
        if (!fs.existsSync(path.join(__dirname, 'exports'))) fs.mkdirSync(path.join(__dirname, 'exports'));
        const filename = `attendance_${sessionId}_${new Date().toISOString().split('T')[0]}.xlsx`;
        fs.writeFileSync(path.join(__dirname, 'exports', filename), excelBuffer);
        console.log(`📊 Excel export saved: ${filename}`);
    }
    console.log(`🔒 Session ${sessionId} locked.`);
}

async function rosterForSession(sessionId) {
    const s = store.sessions[sessionId];
    if (!s) return [];
    const scans = store.scans[sessionId] || {};
    const studentsRes = await pool.query('SELECT * FROM students WHERE section = $1', [s.section]);
    
    return studentsRes.rows.map(st => {
        const scan = scans[st.roll_no];
        let status = 'Absent';
        if (scan) {
            if (scan.opening && scan.closing) status = 'Present';
            else if (scan.closing) status = 'Late';
            else if (scan.opening) status = 'Opening Recorded';
        }
        const ov = (s.overrides || []).find(o => o.rollNo === st.roll_no);
        if (ov) status = ov.status;
        return { rollNo: st.roll_no, name: st.name, status };
    });
}

// RESTORE ACTIVE SESSIONS FUNCTION - FIXED
async function restoreActiveSessions() {
    try {
        const res = await pool.query('SELECT session_id FROM sessions WHERE locked = false');
        for (const row of res.rows) {
            // Rebuild session in memory from database
            const sessionRes = await pool.query('SELECT * FROM sessions WHERE session_id = $1', [row.session_id]);
            const sessionData = sessionRes.rows[0];
            if (sessionData) {
                const tokenRes = await pool.query('SELECT * FROM current_tokens WHERE session_id = $1', [row.session_id]);
                const tokenData = tokenRes.rows[0];
                
                store.sessions[row.session_id] = {
                    sessionId: sessionData.session_id,
                    topic: sessionData.topic,
                    courseCode: sessionData.course_code,
                    section: sessionData.section,
                    facultyId: sessionData.faculty_id,
                    facultyName: sessionData.faculty_name,
                    startedAt: sessionData.started_at,
                    status: sessionData.status,
                    locked: sessionData.locked,
                    overrides: sessionData.overrides || []
                };
                
                if (tokenData) {
                    store.currentToken[row.session_id] = {
                        token: tokenData.token,
                        generatedAt: tokenData.generated_at,
                        expiresAt: tokenData.expires_at
                    };
                }
                
                store.scans[row.session_id] = {};
                const scansRes = await pool.query('SELECT * FROM scans WHERE session_id = $1', [row.session_id]);
                for (const scan of scansRes.rows) {
                    store.scans[row.session_id][scan.roll_no] = {
                        opening: scan.opening,
                        closing: scan.closing,
                        firstScanAt: scan.first_scan_at,
                        secondScanAt: scan.second_scan_at
                    };
                }
                
                console.log(`🔄 Restored session: ${row.session_id} (${sessionData.status})`);
            }
        }
        console.log('✅ Active sessions restored');
    } catch (err) {
        console.error('Session restore error:', err);
    }
}

async function getActiveSessionForFaculty(facultyId) {
    for (const [id, session] of Object.entries(store.sessions)) {
        if (session.facultyId === facultyId && !session.locked) {
            return { sessionId: id, ...session };
        }
    }
    return null;
}

// ============ FACULTY ROUTES ============

app.post('/api/faculty/login', async (req, res) => {
    try {
        const { id, pass } = req.body;
        const dbRes = await pool.query('SELECT * FROM faculty WHERE id = $1 AND pass = $2', [id, pass]);
        if (!dbRes.rows[0]) return res.status(401).json({ error: 'Invalid credentials' });
        const f = dbRes.rows[0];
        
        const activeSession = await getActiveSessionForFaculty(id);
        
        res.json({ 
            id: f.id, name: f.name, dept: f.dept, courses: f.courses,
            activeSession: activeSession ? {
                sessionId: activeSession.sessionId,
                topic: activeSession.topic,
                status: activeSession.status,
                startedAt: activeSession.startedAt
            } : null
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/faculty/start-session', async (req, res) => {
    try {
        const { topic, courseCode, section, facultyId, facultyName } = req.body;
        if (!topic || !courseCode || !section) return res.status(400).json({ error: 'Missing fields' });

        const sessionId = sesId();
        const tok = token8();
        const tokenNow = Date.now();

        store.sessions[sessionId] = {
            sessionId, topic, courseCode, section, facultyId, facultyName,
            startedAt: tokenNow, status: 'opening', locked: false, overrides: []
        };
        store.currentToken[sessionId] = { token: tok, generatedAt: tokenNow, expiresAt: tokenNow + 30000 };
        store.scans[sessionId] = {};

        await pool.query(
            `INSERT INTO sessions (session_id, topic, course_code, section, faculty_id, faculty_name, started_at, locked, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [sessionId, topic, courseCode, section, facultyId, facultyName, tokenNow, false, 'opening']
        );
        await pool.query(`INSERT INTO current_tokens VALUES ($1, $2, $3, $4)`, [sessionId, tok, tokenNow, tokenNow + 30000]);

        store.rotateIntervals[sessionId] = setInterval(async () => {
            const s = store.sessions[sessionId];
            if (!s || s.locked) { clearInterval(store.rotateIntervals[sessionId]); return; }
            const nt = token8();
            const now2 = Date.now();
            store.currentToken[sessionId] = { token: nt, generatedAt: now2, expiresAt: now2 + 30000 };
            await pool.query(`UPDATE current_tokens SET token = $1, generated_at = $2, expires_at = $3 WHERE session_id = $4`,
                [nt, now2, now2 + 30000, sessionId]);
        }, 30000);

        const qrImg = await QRCode.toDataURL(`${sessionId}|${tok}`, { width: 300, margin: 2 });
        res.json({ sessionId, token: tok, qrCode: qrImg, expiresAt: tokenNow + 30000 });
    } catch (err) {
        console.error('Start error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/faculty/resume-session/:sessionId', async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const s = store.sessions[sessionId];
        
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (s.locked) return res.status(400).json({ error: 'Session already locked' });
        
        const td = store.currentToken[sessionId];
        const qrImg = await QRCode.toDataURL(`${sessionId}|${td.token}`, { width: 300, margin: 2 });
        
        res.json({ 
            sessionId, token: td.token, qrCode: qrImg, expiresAt: td.expiresAt,
            status: s.status, topic: s.topic, courseCode: s.courseCode, section: s.section
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/faculty/lock-opening/:sessionId', async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const s = store.sessions[sessionId];
        
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (s.locked) return res.status(400).json({ error: 'Session already locked' });
        
        s.status = 'opening_locked';
        await pool.query('UPDATE sessions SET status = $1 WHERE session_id = $2', ['opening_locked', sessionId]);
        
        res.json({ success: true, status: s.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/faculty/start-closing/:sessionId', async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const s = store.sessions[sessionId];
        
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (s.locked) return res.status(400).json({ error: 'Session already locked' });
        
        s.status = 'closing';
        await pool.query('UPDATE sessions SET status = $1 WHERE session_id = $2', ['closing', sessionId]);
        
        res.json({ success: true, status: s.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/faculty/session/:sessionId', async (req, res) => {
    try {
        const s = store.sessions[req.params.sessionId];
        if (!s) return res.status(404).json({ error: 'Not found' });

        const td = store.currentToken[req.params.sessionId];
        const roster = await rosterForSession(req.params.sessionId);
        let qrCode = null;

        if (td && !s.locked) {
            qrCode = await QRCode.toDataURL(`${req.params.sessionId}|${td.token}`, { width: 300, margin: 2 });
        }

        res.json({
            session: s, token: td?.token, expiresAt: td?.expiresAt,
            qrCode, roster,
            presentCount: roster.filter(r => r.status === 'Present').length,
            lateCount: roster.filter(r => r.status === 'Late').length,
            absentCount: roster.filter(r => r.status === 'Absent').length,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/faculty/lock-session/:sessionId', async (req, res) => {
    try {
        await lockSession(req.params.sessionId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.get('/api/faculty/token/:sessionId', async (req, res) => {
    try {
        const sessionId = req.params.sessionId;
        const td = store.currentToken[sessionId];
        if (!td) return res.status(404).json({ error: 'No active token' });
        
        const qrImg = await QRCode.toDataURL(`${sessionId}|${td.token}`, { width: 300, margin: 2 });
        res.json({ token: td.token, qrCode: qrImg, expiresAt: td.expiresAt });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.post('/api/faculty/override/:sessionId', async (req, res) => {
    try {
        const { rollNo, status } = req.body;
        const s = store.sessions[req.params.sessionId];
        if (!s) return res.status(404).json({ error: 'Not found' });
        s.overrides = (s.overrides || []).filter(o => o.rollNo !== rollNo);
        s.overrides.push({ rollNo, status, at: Date.now() });
        await pool.query('UPDATE sessions SET overrides = $1 WHERE session_id = $2', [JSON.stringify(s.overrides), req.params.sessionId]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/faculty/history', async (req, res) => {
    try {
        const { facultyId } = req.query;
        const fac = (await pool.query('SELECT * FROM faculty WHERE id = $1', [facultyId])).rows[0];
        if (!fac) return res.status(404).json({ error: 'Faculty not found' });

        const sessions = (await pool.query(
            `SELECT * FROM sessions WHERE locked = true AND course_code = ANY($1::text[]) ORDER BY started_at DESC`,
            [fac.courses]
        )).rows;

        const locked = [];
        for (const s of sessions) {
            const records = (await pool.query('SELECT * FROM attendance_records WHERE session_id = $1', [s.session_id])).rows;
            locked.push({
                sessionId: s.session_id, topic: s.topic || 'No topic', courseCode: s.course_code || 'N/A',
                section: s.section || 'N/A', facultyName: s.faculty_name || 'Unknown', startedAt: s.started_at,
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
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/faculty/export/:sessionId', async (req, res) => {
    try {
        const session = (await pool.query('SELECT * FROM sessions WHERE session_id = $1', [req.params.sessionId])).rows[0];
        if (!session) return res.status(404).json({ error: 'Session not found' });
        
        const buffer = await exportToExcel(req.params.sessionId, session.section);
        const filename = `Attendance_${session.course_code}_${new Date(Number(session.started_at)).toLocaleDateString('en-GB').replace(/\//g, '-')}.xlsx`;
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============ STUDENT ROUTES ============

app.post('/api/student/login', async (req, res) => {
    try {
        const { rollNo, pass } = req.body;
        const student = (await pool.query('SELECT * FROM students WHERE roll_no = $1 AND pass = $2', [rollNo.toUpperCase(), pass])).rows[0];
        if (!student) return res.status(401).json({ error: 'Invalid credentials' });
        res.json({ rollNo: student.roll_no, name: student.name, section: student.section });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/sessions', (req, res) => {
    res.json(Object.values(store.sessions));
});

app.post('/api/student/scan', async (req, res) => {
    try {
        const { rollNo, sessionId, token } = req.body;
        const student = (await pool.query('SELECT * FROM students WHERE roll_no = $1', [rollNo])).rows[0];
        if (!student) return res.status(404).json({ error: 'Roll number not found' });

        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (s.locked) return res.status(400).json({ error: 'Session locked', code: 'LOCKED' });
        if (s.status === 'opening_locked') return res.status(400).json({ error: 'Opening window closed. Wait for closing window.', code: 'OPENING_LOCKED' });

        const td = store.currentToken[sessionId];
        if (!td) return res.status(400).json({ error: 'No active token' });
        if (token !== td.token) return res.status(400).json({ error: 'Invalid or expired token', code: 'EXPIRED' });
        if (Date.now() > td.expiresAt) return res.status(400).json({ error: 'Token expired', code: 'EXPIRED' });

        if (!store.scans[sessionId]) store.scans[sessionId] = {};
        
        const isClosing = s.status === 'closing';
        const existingScan = store.scans[sessionId][rollNo];
        
        if (existingScan?.opening && existingScan?.closing) {
            return res.status(400).json({ error: 'Attendance already recorded', code: 'DUPLICATE' });
        }
        
        let currentStatus = '';
        let message = '';
        
        if (!existingScan) {
            if (isClosing) {
                store.scans[sessionId][rollNo] = { opening: false, closing: true, firstScanAt: Date.now() };
                await pool.query(`INSERT INTO scans (session_id, roll_no, opening, closing, first_scan_at) VALUES ($1, $2, $3, $4, $5)`, [sessionId, rollNo, false, true, Date.now()]);
                currentStatus = 'Late';
                message = '⏰ You are marked LATE (scanned only during closing window)';
            } else {
                store.scans[sessionId][rollNo] = { opening: true, closing: false, firstScanAt: Date.now() };
                await pool.query(`INSERT INTO scans (session_id, roll_no, opening, closing, first_scan_at) VALUES ($1, $2, $3, $4, $5)`, [sessionId, rollNo, true, false, Date.now()]);
                currentStatus = 'Opening Recorded';
                message = '📝 Opening recorded! Please scan again during closing window (10 minutes) to be marked PRESENT.';
            }
        } else {
            if (!isClosing) {
                return res.status(400).json({ error: 'Already recorded opening. Please scan during closing window.', code: 'WAIT_FOR_CLOSING' });
            }
            if (!existingScan.opening) {
                return res.status(400).json({ error: 'Cannot mark attendance. Please contact faculty.', code: 'INVALID' });
            }
            existingScan.closing = true;
            existingScan.secondScanAt = Date.now();
            await pool.query(`UPDATE scans SET closing = $1, second_scan_at = $2 WHERE session_id = $3 AND roll_no = $4`, [true, Date.now(), sessionId, rollNo]);
            currentStatus = 'Present';
            message = '✅ You are marked PRESENT! (scanned in both windows)';
        }
        
        res.json({ success: true, currentStatus, message, window: isClosing ? 'closing' : 'opening' });
    } catch (err) {
        console.error('Scan error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/student/:rollNo/attendance', async (req, res) => {
    try {
        const records = (await pool.query('SELECT * FROM attendance_records WHERE roll_no = $1 ORDER BY recorded_at DESC', [req.params.rollNo])).rows;
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
        res.status(500).json({ error: err.message });
    }
});

// ============ START SERVER ============
async function startServer() {
    await initDatabase();
    await restoreActiveSessions();
    if (!fs.existsSync(path.join(__dirname, 'exports'))) fs.mkdirSync(path.join(__dirname, 'exports'));
    
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