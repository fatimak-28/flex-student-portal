const express = require('express');
const QRCode = require('qrcode');
const path = require('path');
const { Pool } = require('pg');
const XLSX = require('xlsx');
const multer = require('multer');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Create uploads directory if it doesn't exist
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

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
                ('FAC-001', 'Dr. Zeeshan Ali Rana', 'SE', 'admin', ARRAY['SE-2001', 'SE-3002'])
            `);
            console.log('✓ Faculty seeded');
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
             ON CONFLICT (session_id, roll_no) DO UPDATE SET status=$6`,
            [sessionId, st.roll_no, st.name, st.section, s.courseCode, finalStatus, s.startedAt]
        );
    }
    
    console.log(`🔒 Session ${sessionId} locked.`);
}

async function exportAttendanceToExcel(section, courseCode) {
    // Get locked sessions
    let sessionsQuery = 'SELECT * FROM sessions WHERE locked=true';
    const params = [];
    if (section) { params.push(section); sessionsQuery += ` AND section=$${params.length}`; }
    if (courseCode) { params.push(courseCode); sessionsQuery += ` AND course_code=$${params.length}`; }
    sessionsQuery += ' ORDER BY started_at ASC';
    
    const sessionsRes = await pool.query(sessionsQuery, params);
    const sessions = sessionsRes.rows;
    
    // Get students
    let studentsRes;
    if (section) {
        studentsRes = await pool.query('SELECT * FROM students WHERE section=$1 ORDER BY roll_no', [section]);
    } else {
        studentsRes = await pool.query('SELECT * FROM students ORDER BY roll_no');
    }
    
    // Get attendance records
    const sessionIds = sessions.map(s => s.session_id);
    let allRecords = [];
    if (sessionIds.length > 0) {
        const recRes = await pool.query(
            `SELECT * FROM attendance_records WHERE session_id = ANY($1::text[])`,
            [sessionIds]
        );
        allRecords = recRes.rows;
    }
    
    // Build record map
    const recordMap = {};
    for (const rec of allRecords) {
        if (!recordMap[rec.session_id]) recordMap[rec.session_id] = {};
        recordMap[rec.session_id][rec.roll_no] = rec;
    }
    
    // Create date headers
    const sessionDates = sessions.map(s => {
        const d = new Date(Number(s.started_at));
        return d.toLocaleDateString('en-GB');
    });
    
    // Build data rows
    const headers = ['S#', 'Roll No.', 'Student Name', ...sessionDates];
    const dataRows = [headers];
    let sno = 1;
    
    for (const student of studentsRes.rows) {
        const row = [sno++, student.roll_no, student.name];
        for (const session of sessions) {
            const record = recordMap[session.session_id]?.[student.roll_no];
            let status = 'A';
            if (record) {
                if (record.status === 'Present') status = 'P';
                else if (record.status === 'Late') status = 'L';
            }
            row.push(status);
        }
        dataRows.push(row);
    }
    
    const ws = XLSX.utils.aoa_to_sheet(dataRows);
    ws['!cols'] = [{ wch: 5 }, { wch: 14 }, { wch: 30 }];
    for (let i = 0; i < sessionDates.length; i++) {
        ws['!cols'].push({ wch: 13 });
    }
    
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    
    const filename = `Attendance_${courseCode || 'All'}_${section || 'All'}_${new Date().toLocaleDateString('en-GB').replace(/\//g, '-')}.xlsx`;
    return { buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), filename };
}

// Intelligent import function - creates date columns if they don't exist
async function importAttendanceFromExcel(filePath, section, courseCode, selectedDates) {
    if (!fs.existsSync(filePath)) {
        return { success: false, message: 'File not found' };
    }
    
    try {
        const wb = XLSX.readFile(filePath);
        const ws = wb.Sheets[wb.SheetNames[0]];
        let rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
        
        if (!rows || rows.length < 2) {
            return { success: false, message: 'Empty sheet' };
        }
        
        let headers = [...rows[0]];
        
        // Find which columns already exist and which need to be created
        const existingColumns = {};
        const columnIndexes = {};
        
        for (let i = 3; i < headers.length; i++) {
            if (headers[i] && selectedDates.includes(headers[i])) {
                existingColumns[headers[i]] = i;
                columnIndexes[headers[i]] = i;
            }
        }
        
        // Find missing dates that need new columns
        const missingDates = selectedDates.filter(date => !existingColumns[date]);
        
        // Add missing date columns to headers
        if (missingDates.length > 0) {
            for (const date of missingDates) {
                headers.push(date);
                columnIndexes[date] = headers.length - 1;
            }
            rows[0] = headers;
            
            // Extend each row to have the new columns (fill with empty string)
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                const currentLen = row.length;
                for (let j = 0; j < missingDates.length; j++) {
                    row[currentLen + j] = '';
                }
                rows[i] = row;
            }
        }
        
        // Get students from sheet (roll no to row mapping)
        const studentRowMap = {};
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || !row[1]) continue;
            studentRowMap[String(row[1]).trim()] = { rowIndex: i, rowData: row };
        }
        
        // Get locked sessions from database for the selected dates
        let sessionsQuery = 'SELECT * FROM sessions WHERE locked=true';
        const params = [];
        if (section) { params.push(section); sessionsQuery += ` AND section=$${params.length}`; }
        if (courseCode) { params.push(courseCode); sessionsQuery += ` AND course_code=$${params.length}`; }
        sessionsQuery += ' ORDER BY started_at ASC';
        
        const sessionsRes = await pool.query(sessionsQuery, params);
        const sessions = sessionsRes.rows;
        
        // Map dates to sessions
        const sessionDateMap = {};
        for (const s of sessions) {
            const dateStr = new Date(Number(s.started_at)).toLocaleDateString('en-GB');
            sessionDateMap[dateStr] = s;
        }
        
        // Get attendance records
        const sessionIds = sessions.map(s => s.session_id);
        let allRecords = [];
        if (sessionIds.length > 0) {
            const recRes = await pool.query(
                `SELECT * FROM attendance_records WHERE session_id = ANY($1::text[])`,
                [sessionIds]
            );
            allRecords = recRes.rows;
        }
        
        // Build record map
        const recordMap = {};
        for (const rec of allRecords) {
            if (!recordMap[rec.session_id]) recordMap[rec.session_id] = {};
            recordMap[rec.session_id][rec.roll_no] = rec;
        }
        
        // Update attendance cells (only empty cells)
        let updates = 0;
        let columnsCreated = 0;
        
        for (const date of selectedDates) {
            const session = sessionDateMap[date];
            if (!session) {
                console.log(`No session found for date: ${date}`);
                continue;
            }
            
            const colIndex = columnIndexes[date];
            
            for (const [rollNo, studentData] of Object.entries(studentRowMap)) {
                const currentCellValue = studentData.rowData[colIndex];
                // Only update if cell is empty, null, undefined, or not already P/L/A
                if (!currentCellValue || currentCellValue === '' || currentCellValue === null || 
                    currentCellValue === 0 || currentCellValue === '0') {
                    
                    const record = recordMap[session.session_id]?.[rollNo];
                    let status = '';
                    if (record) {
                        if (record.status === 'Present') status = 'P';
                        else if (record.status === 'Late') status = 'L';
                        else status = 'A';
                    } else {
                        status = 'A';
                    }
                    
                    if (status && status !== currentCellValue) {
                        rows[studentData.rowIndex][colIndex] = status;
                        updates++;
                    }
                }
            }
        }
        
        // Write back to file
        const newWs = XLSX.utils.aoa_to_sheet(rows);
        // Set column widths
        newWs['!cols'] = [{ wch: 5 }, { wch: 14 }, { wch: 30 }];
        for (let i = 0; i < headers.length - 3; i++) {
            newWs['!cols'].push({ wch: 13 });
        }
        
        XLSX.utils.book_append_sheet(wb, newWs, 'Attendance');
        XLSX.writeFile(wb, filePath);
        
        const message = `Updated ${updates} entries. ${missingDates.length > 0 ? `Created ${missingDates.length} new date columns: ${missingDates.join(', ')}.` : ''}`;
        console.log(`✅ ${message}`);
        return { success: true, message: message, updates: updates, columnsCreated: missingDates.length };
    } catch (err) {
        console.error('Import error:', err);
        return { success: false, message: err.message };
    }
}

// Get available locked sessions with dates for import selection
app.get('/api/faculty/available-sessions', async (req, res) => {
    try {
        const { section, courseCode, facultyId } = req.query;
        
        let sessionsQuery = 'SELECT * FROM sessions WHERE locked=true';
        const params = [];
        if (section) { params.push(section); sessionsQuery += ` AND section=$${params.length}`; }
        if (courseCode) { params.push(courseCode); sessionsQuery += ` AND course_code=$${params.length}`; }
        sessionsQuery += ' ORDER BY started_at ASC';
        
        const sessionsRes = await pool.query(sessionsQuery, params);
        const sessions = sessionsRes.rows;
        
        const availableSessions = sessions.map(s => ({
            sessionId: s.session_id,
            topic: s.topic,
            date: new Date(Number(s.started_at)).toLocaleDateString('en-GB'),
            startedAt: s.started_at,
            courseCode: s.course_code,
            section: s.section
        }));
        
        res.json(availableSessions);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

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
            else if (scan.opening) status = 'Opening Recorded';
            else if (scan.closing) status = 'Late';
        }
        const ov = (s.overrides || []).find(o => o.rollNo === st.roll_no);
        if (ov) status = ov.status;
        return { rollNo: st.roll_no, name: st.name, status };
    });
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

// ============ FACULTY ROUTES ============

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

app.post('/api/faculty/override-locked/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { rollNo, status } = req.body;
        const validStatuses = ['Present', 'Late', 'Absent'];
        if (!rollNo || !status) return res.status(400).json({ error: 'Roll number and status required' });
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (!s.locked) {
            s.overrides = (s.overrides || []).filter(o => o.rollNo !== rollNo);
            s.overrides.push({ rollNo, status, at: Date.now() });
            await pool.query('UPDATE sessions SET overrides=$1 WHERE session_id=$2', [JSON.stringify(s.overrides), sessionId]);
            return res.json({ success: true, message: 'Override saved (active session)' });
        }
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

// Resume opening window (opening_locked → opening)
app.post('/api/faculty/resume-opening/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Session not found' });
        if (s.locked) return res.status(400).json({ error: 'Locked cannot resume' });
        if (s.status !== 'opening_locked') return res.status(400).json({ error: 'Not in opening_locked' });
        
        s.status = 'opening';
        await pool.query('UPDATE sessions SET status=$1 WHERE session_id=$2', ['opening', sessionId]);
        
        // Generate a FRESH token immediately
        if (store.rotateIntervals[sessionId]) {
            clearInterval(store.rotateIntervals[sessionId]);
        }
        
        const freshToken = token8();
        const now = Date.now();
        store.currentToken[sessionId] = { token: freshToken, generatedAt: now, expiresAt: now + 30000 };
        await pool.query('UPDATE current_tokens SET token=$1, generated_at=$2, expires_at=$3 WHERE session_id=$4',
            [freshToken, now, now + 30000, sessionId]);
        
        // Start fresh token rotation
        store.rotateIntervals[sessionId] = setInterval(async () => {
            const s2 = store.sessions[sessionId];
            if (s2 && !s2.locked && s2.status === 'opening') {
                const nt = token8();
                const now2 = Date.now();
                store.currentToken[sessionId] = { token: nt, generatedAt: now2, expiresAt: now2 + 30000 };
                await pool.query(`UPDATE current_tokens SET token=$1, generated_at=$2, expires_at=$3 WHERE session_id=$4`,
                    [nt, now2, now2 + 30000, sessionId]);
            } else {
                clearInterval(store.rotateIntervals[sessionId]);
            }
        }, 30000);
        
        // Auto-lock opening again after 10 min
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
        res.json({ success: true, status: 'opening', token: td.token, qrCode: qrImg, expiresAt: td.expiresAt });
    } catch (err) {
        console.error('Resume opening error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Start closing window
app.post('/api/faculty/start-closing/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const s = store.sessions[sessionId];
        if (!s) return res.status(404).json({ error: 'Not found' });
        if (s.locked) return res.status(400).json({ error: 'Locked' });
        if (s.status !== 'opening_locked') return res.status(400).json({ error: 'Must close opening first' });
        
        s.status = 'closing';
        await pool.query('UPDATE sessions SET status=$1 WHERE session_id=$2', ['closing', sessionId]);
        
        // Stop existing token rotation
        if (store.rotateIntervals[sessionId]) {
            clearInterval(store.rotateIntervals[sessionId]);
            delete store.rotateIntervals[sessionId];
        }
        
        // Generate a FRESH token immediately
        const freshToken = token8();
        const now = Date.now();
        store.currentToken[sessionId] = { token: freshToken, generatedAt: now, expiresAt: now + 30000 };
        await pool.query('UPDATE current_tokens SET token=$1, generated_at=$2, expires_at=$3 WHERE session_id=$4',
            [freshToken, now, now + 30000, sessionId]);
        
        // Start fresh token rotation for closing window
        store.rotateIntervals[sessionId] = setInterval(async () => {
            const sess = store.sessions[sessionId];
            if (!sess || sess.locked || sess.status !== 'closing') { 
                clearInterval(store.rotateIntervals[sessionId]); 
                delete store.rotateIntervals[sessionId];
                return; 
            }
            const nt = token8();
            const now2 = Date.now();
            store.currentToken[sessionId] = { token: nt, generatedAt: now2, expiresAt: now2 + 30000 };
            await pool.query(`UPDATE current_tokens SET token=$1, generated_at=$2, expires_at=$3 WHERE session_id=$4`,
                [nt, now2, now2 + 30000, sessionId]);
        }, 30000);
        
        // Auto-lock closing after 10 min
        store.closingTimers[sessionId] = setTimeout(async () => {
            const s2 = store.sessions[sessionId];
            if (s2 && !s2.locked && s2.status === 'closing') {
                await lockSession(sessionId);
            }
        }, 10 * 60 * 1000);
        
        const td = store.currentToken[sessionId];
        const qrImg = await QRCode.toDataURL(`${sessionId}|${td.token}`, { width: 300, margin: 2 });
        res.json({ success: true, status: 'closing', token: td.token, qrCode: qrImg, expiresAt: td.expiresAt });
    } catch (err) {
        console.error('Start closing error:', err);
        res.status(500).json({ error: err.message });
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
            presentCount: roster.filter(r => r.status === 'Present').length,
            lateCount: roster.filter(r => r.status === 'Late').length,
            absentCount: roster.filter(r => r.status === 'Absent').length,
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/faculty/token/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const td = store.currentToken[sessionId];
        if (!td) return res.status(404).json({ error: 'No active token' });
        const s = store.sessions[sessionId];
        if (s && (s.status === 'opening_locked' || s.locked)) {
            return res.json({ token: td.token, qrCode: null, expiresAt: td.expiresAt });
        }
        const qrImg = await QRCode.toDataURL(`${sessionId}|${td.token}`, { width: 300, margin: 2 });
        res.json({ token: td.token, qrCode: qrImg, expiresAt: td.expiresAt });
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
            // IMPORTANT: Order by roll_no to keep consistent order
            const records = (await pool.query(
                `SELECT * FROM attendance_records WHERE session_id=$1 ORDER BY roll_no`, 
                [s.session_id]
            )).rows;
            
            locked.push({
                sessionId: s.session_id, 
                topic: s.topic || 'No topic', 
                courseCode: s.course_code || 'N/A',
                section: s.section || 'N/A', 
                facultyName: s.faculty_name, 
                startedAt: s.started_at,
                records: records.map(r => ({ 
                    rollNo: r.roll_no, 
                    name: r.name, 
                    status: r.status 
                })),
                present: records.filter(r => r.status === 'Present').length,
                late: records.filter(r => r.status === 'Late').length,
                absent: records.filter(r => r.status === 'Absent').length,
                total: records.length,
            });
        }
        res.json(locked);
    } catch (err) {
        console.error('History error:', err);
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

async function exportToExcel(sessionId) {
    const sessionRes = await pool.query('SELECT * FROM sessions WHERE session_id=$1', [sessionId]);
    const session = sessionRes.rows[0];
    if (!session) return null;
    const recordsRes = await pool.query('SELECT * FROM attendance_records WHERE session_id=$1 ORDER BY roll_no', [sessionId]);
    const studentsRes = await pool.query('SELECT * FROM students WHERE section=$1 ORDER BY roll_no', [session.section]);
    const dateStr = new Date(Number(session.started_at)).toLocaleDateString('en-GB');
    const data = [['S#', 'Roll No.', 'Student Name', dateStr]];
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

// ============ IMPORT/EXPORT ENDPOINTS ============

// Get available sessions for import (with dates)
app.get('/api/faculty/available-sessions', async (req, res) => {
    try {
        const { section, courseCode, facultyId } = req.query;
        
        let sessionsQuery = 'SELECT * FROM sessions WHERE locked=true';
        const params = [];
        if (section) { params.push(section); sessionsQuery += ` AND section=$${params.length}`; }
        if (courseCode) { params.push(courseCode); sessionsQuery += ` AND course_code=$${params.length}`; }
        sessionsQuery += ' ORDER BY started_at ASC';
        
        const sessionsRes = await pool.query(sessionsQuery, params);
        const sessions = sessionsRes.rows;
        
        const availableSessions = sessions.map(s => ({
            sessionId: s.session_id,
            topic: s.topic,
            date: new Date(Number(s.started_at)).toLocaleDateString('en-GB'),
            startedAt: s.started_at,
            courseCode: s.course_code,
            section: s.section
        }));
        
        res.json(availableSessions);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Add this helper function BEFORE the import endpoint
async function processAttendanceExcel(filePath, section, courseCode, selectedDates) {
    if (!fs.existsSync(filePath)) {
        throw new Error('File not found');
    }
    
    try {
        // Read the workbook
        const wb = XLSX.readFile(filePath);
        const ws = wb.Sheets[wb.SheetNames[0]];
        let rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
        
        if (!rows || rows.length < 2) {
            throw new Error('Empty sheet');
        }
        
        let headers = [...rows[0]];
        
        // Find which columns already exist and which need to be created
        const columnIndexes = {};
        
        for (let i = 3; i < headers.length; i++) {
            if (headers[i] && selectedDates.includes(headers[i])) {
                columnIndexes[headers[i]] = i;
            }
        }
        
        // Find missing dates that need new columns
        const missingDates = selectedDates.filter(date => !columnIndexes[date]);
        
        // Add missing date columns to headers
        if (missingDates.length > 0) {
            for (const date of missingDates) {
                headers.push(date);
                columnIndexes[date] = headers.length - 1;
            }
            rows[0] = headers;
            
            // Extend each row to have the new columns (fill with empty string)
            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                if (!row) continue;
                const currentLen = row.length;
                for (let j = 0; j < missingDates.length; j++) {
                    row[currentLen + j] = '';
                }
                rows[i] = row;
            }
        }
        
        // Get students from sheet (roll no to row mapping)
        const studentRowMap = {};
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || !row[1]) continue;
            studentRowMap[String(row[1]).trim()] = { rowIndex: i, rowData: row };
        }
        
        // Get locked sessions from database for the selected dates
        let sessionsQuery = 'SELECT * FROM sessions WHERE locked=true';
        const params = [];
        if (section) { params.push(section); sessionsQuery += ` AND section=$${params.length}`; }
        if (courseCode) { params.push(courseCode); sessionsQuery += ` AND course_code=$${params.length}`; }
        sessionsQuery += ' ORDER BY started_at ASC';
        
        const sessionsRes = await pool.query(sessionsQuery, params);
        const sessions = sessionsRes.rows;
        
        // Map dates to sessions (remove duplicates - keep first session per date)
        const sessionDateMap = {};
        for (const s of sessions) {
            const dateStr = new Date(Number(s.started_at)).toLocaleDateString('en-GB');
            if (!sessionDateMap[dateStr]) {
                sessionDateMap[dateStr] = s;
            }
        }
        
        // Get attendance records
        const sessionIds = sessions.map(s => s.session_id);
        let allRecords = [];
        if (sessionIds.length > 0) {
            const recRes = await pool.query(
                `SELECT * FROM attendance_records WHERE session_id = ANY($1::text[])`,
                [sessionIds]
            );
            allRecords = recRes.rows;
        }
        
        // Build record map
        const recordMap = {};
        for (const rec of allRecords) {
            if (!recordMap[rec.session_id]) recordMap[rec.session_id] = {};
            recordMap[rec.session_id][rec.roll_no] = rec;
        }
        
        // Update attendance cells (only empty cells)
        let updates = 0;
        
        for (const date of selectedDates) {
            const session = sessionDateMap[date];
            if (!session) {
                console.log(`No session found for date: ${date}`);
                continue;
            }
            
            const colIndex = columnIndexes[date];
            
            for (const [rollNo, studentData] of Object.entries(studentRowMap)) {
                const currentCellValue = studentData.rowData[colIndex];
                // Only update if cell is empty, null, undefined, or not already P/L/A
                if (!currentCellValue || currentCellValue === '' || currentCellValue === null || 
                    currentCellValue === 0 || currentCellValue === '0') {
                    
                    const record = recordMap[session.session_id]?.[rollNo];
                    let status = 'A';
                    if (record) {
                        if (record.status === 'Present') status = 'P';
                        else if (record.status === 'Late') status = 'L';
                    }
                    
                    if (status && status !== currentCellValue) {
                        rows[studentData.rowIndex][colIndex] = status;
                        updates++;
                    }
                }
            }
        }
        
        // Create new workbook
        const newWs = XLSX.utils.aoa_to_sheet(rows);
        // Set column widths
        newWs['!cols'] = [{ wch: 5 }, { wch: 14 }, { wch: 30 }];
        for (let i = 0; i < headers.length - 3; i++) {
            newWs['!cols'].push({ wch: 13 });
        }
        
        const newWb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(newWb, newWs, 'Attendance');
        
        // Save to temporary output file
        const outputPath = path.join(__dirname, 'uploads', `output_${Date.now()}.xlsx`);
        XLSX.writeFile(newWb, outputPath);
        
        console.log(`✅ Updated ${updates} entries. Created ${missingDates.length} new date columns`);
        return outputPath;
    } catch (err) {
        console.error('Process error:', err);
        throw err;
    }
}

// Replace the import endpoint with this version
app.post('/api/faculty/import-attendance', upload.single('file'), async (req, res) => {
    let tempFilePath = null;
    let outputFilePath = null;
    try {
        console.log('Import request received');
        const { section, courseCode, selectedDates } = req.body;
        
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        tempFilePath = req.file.path;
        
        if (!section) {
            return res.status(400).json({ error: 'Section is required' });
        }
        
        let datesToUpdate = [];
        if (selectedDates) {
            try {
                datesToUpdate = JSON.parse(selectedDates);
            } catch(e) {
                datesToUpdate = [];
            }
        }
        
        if (datesToUpdate.length === 0) {
            return res.status(400).json({ error: 'Please select at least one date column to update' });
        }
        
        console.log(`Processing file: ${tempFilePath}, section: ${section}, dates: ${datesToUpdate.join(', ')}`);
        
        // Process the file and save to a new output file
        outputFilePath = await processAttendanceExcel(tempFilePath, section, courseCode, datesToUpdate);
        
        if (outputFilePath && fs.existsSync(outputFilePath)) {
            const originalFileName = req.file.originalname || 'attendance_sheet.xlsx';
            const outputFileName = `Updated_${originalFileName}`;
            
            // Send the file
            res.download(outputFilePath, outputFileName, (err) => {
                if (err) {
                    console.error('Download error:', err);
                }
                // Clean up temp files after download
                setTimeout(() => {
                    try {
                        if (tempFilePath && fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
                        if (outputFilePath && fs.existsSync(outputFilePath)) fs.unlinkSync(outputFilePath);
                    } catch(e) { console.log('Cleanup error:', e); }
                }, 1000);
            });
        } else {
            throw new Error('Failed to process file');
        }
    } catch (err) {
        console.error('Import error:', err);
        // Clean up temp file
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch(e) {}
        }
        if (outputFilePath && fs.existsSync(outputFilePath)) {
            try { fs.unlinkSync(outputFilePath); } catch(e) {}
        }
        res.status(500).json({ error: err.message });
    }
});


// Export attendance sheet (download)
app.get('/api/faculty/export-attendance-sheet', async (req, res) => {
    try {
        const { section, courseCode, facultyId } = req.query;
        
        if (!facultyId) {
            return res.status(400).json({ error: 'Faculty ID required' });
        }
        
        const fac = (await pool.query('SELECT * FROM faculty WHERE id=$1', [facultyId])).rows[0];
        if (!fac) {
            return res.status(404).json({ error: 'Faculty not found' });
        }
        
        const result = await exportAttendanceToExcel(section, courseCode);
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
        res.send(result.buffer);
    } catch (err) {
        console.error('Export error:', err);
        res.status(500).json({ error: 'Export failed: ' + err.message });
    }
});

app.get('/api/faculty/export-cumulative', async (req, res) => {
    try {
        const { section, courseCode, facultyId } = req.query;
        if (!facultyId) return res.status(400).json({ error: 'Faculty ID is required' });
        const fac = (await pool.query('SELECT * FROM faculty WHERE id=$1', [facultyId])).rows[0];
        if (!fac) return res.status(404).json({ error: 'Faculty not found' });

        let sessionsQuery = 'SELECT * FROM sessions WHERE locked=true';
        const params = [];
        if (section) { params.push(section); sessionsQuery += ` AND section=$${params.length}`; }
        if (courseCode) { params.push(courseCode); sessionsQuery += ` AND course_code=$${params.length}`; }
        sessionsQuery += ' ORDER BY started_at ASC';
        const sessionsRes = await pool.query(sessionsQuery, params);
        const sessions = sessionsRes.rows;

        let studentsRes;
        if (section) {
            studentsRes = await pool.query('SELECT * FROM students WHERE section=$1 ORDER BY roll_no', [section]);
        } else {
            studentsRes = await pool.query('SELECT * FROM students ORDER BY roll_no');
        }

        const sessionIds = sessions.map(s => s.session_id);
        let allRecords = [];
        if (sessionIds.length > 0) {
            const recRes = await pool.query(
                `SELECT * FROM attendance_records WHERE session_id = ANY($1::text[])`,
                [sessionIds]
            );
            allRecords = recRes.rows;
        }

        const dateCols = sessions.map(s => {
            const d = new Date(Number(s.started_at));
            return d.toLocaleDateString('en-GB');
        });
        const header = ['S#', 'Roll No.', 'Student Name', ...dateCols];
        const dataRows = [header];
        let sno = 1;
        for (const st of studentsRes.rows) {
            const row = [sno++, st.roll_no, st.name];
            for (const s of sessions) {
                const rec = allRecords.find(r => r.session_id === s.session_id && r.roll_no === st.roll_no);
                if (!rec) { row.push('A'); continue; }
                if (rec.status === 'Present') row.push('P');
                else if (rec.status === 'Late') row.push('L');
                else row.push('A');
            }
            dataRows.push(row);
        }

        const ws = XLSX.utils.aoa_to_sheet(dataRows);
        const colWidths = [{ wch: 5 }, { wch: 14 }, { wch: 30 }];
        for (let i = 0; i < sessions.length; i++) colWidths.push({ wch: 13 });
        ws['!cols'] = colWidths;

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
        const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        const sectionLabel = section ? section.replace(/[^a-zA-Z0-9]/g, '-') : 'All';
        const courseLabel = courseCode ? courseCode.replace(/[^a-zA-Z0-9]/g, '-') : 'All';
        const today = new Date().toLocaleDateString('en-GB').replace(/\//g, '-');
        const filename = `AttendanceSheet_${courseLabel}_${sectionLabel}_${today}.xlsx`;

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (err) {
        console.error('Cumulative export error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

app.get('/api/sections', async (req, res) => {
    try {
        const r = await pool.query('SELECT DISTINCT section FROM students ORDER BY section');
        res.json(r.rows.map(row => row.section));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ============ STUDENT ROUTES ============

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

// ============ STATIC FILES & CODE VIEWER ============
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

// ============ START SERVER ============
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
// Delete entire session and its attendance records
app.delete('/api/faculty/session/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        console.log(`Deleting session: ${sessionId}`);
        
        // Check if session exists
        const sessionCheck = await pool.query('SELECT * FROM sessions WHERE session_id = $1', [sessionId]);
        if (sessionCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        // Delete related records in correct order
        await pool.query('DELETE FROM attendance_records WHERE session_id = $1', [sessionId]);
        await pool.query('DELETE FROM scans WHERE session_id = $1', [sessionId]);
        await pool.query('DELETE FROM current_tokens WHERE session_id = $1', [sessionId]);
        await pool.query('DELETE FROM sessions WHERE session_id = $1', [sessionId]);
        
        // Also remove from memory store
        if (store.sessions[sessionId]) {
            if (store.rotateIntervals[sessionId]) {
                clearInterval(store.rotateIntervals[sessionId]);
            }
            if (store.openingTimers[sessionId]) {
                clearTimeout(store.openingTimers[sessionId]);
            }
            if (store.closingTimers[sessionId]) {
                clearTimeout(store.closingTimers[sessionId]);
            }
            delete store.sessions[sessionId];
            delete store.currentToken[sessionId];
            delete store.scans[sessionId];
        }
        
        res.json({ success: true, message: 'Session deleted successfully' });
    } catch (err) {
        console.error('Delete session error:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// Override attendance record in history (for locked sessions)
app.post('/api/faculty/override-history/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { rollNo, status } = req.body;
        
        console.log(`Override history - session: ${sessionId}, rollNo: ${rollNo}, status: ${status}`);
        
        const validStatuses = ['Present', 'Late', 'Absent'];
        if (!rollNo || !status) {
            return res.status(400).json({ error: 'Roll number and status required' });
        }
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status' });
        }
        
        // Check if session exists and is locked
        const sessionCheck = await pool.query('SELECT * FROM sessions WHERE session_id = $1 AND locked = true', [sessionId]);
        if (sessionCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Locked session not found' });
        }
        
        // Update attendance record
        const result = await pool.query(
            `UPDATE attendance_records 
             SET status = $1 
             WHERE session_id = $2 AND roll_no = $3
             RETURNING *`,
            [status, sessionId, rollNo]
        );
        
        if (result.rows.length === 0) {
            // If no record exists, create one
            const studentRes = await pool.query('SELECT * FROM students WHERE roll_no = $1', [rollNo]);
            const sessionRes = await pool.query('SELECT * FROM sessions WHERE session_id = $1', [sessionId]);
            
            if (studentRes.rows.length > 0 && sessionRes.rows.length > 0) {
                await pool.query(
                    `INSERT INTO attendance_records (session_id, roll_no, name, section, course_code, status, recorded_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [sessionId, rollNo, studentRes.rows[0].name, studentRes.rows[0].section, 
                     sessionRes.rows[0].course_code, status, Date.now()]
                );
            } else {
                return res.status(404).json({ error: 'Student record not found' });
            }
        }
        
        // Also update in-memory store if session exists there
        if (store.sessions[sessionId]) {
            const s = store.sessions[sessionId];
            s.overrides = (s.overrides || []).filter(o => o.rollNo !== rollNo);
            s.overrides.push({ rollNo, status, at: Date.now() });
            await pool.query('UPDATE sessions SET overrides=$1 WHERE session_id=$2', 
                [JSON.stringify(s.overrides), sessionId]);
        }
        
        res.json({ success: true, message: `Override set to ${status} for ${rollNo}` });
    } catch (err) {
        console.error('Override history error:', err);
        res.status(500).json({ error: 'Server error: ' + err.message });
    }
});

// Get single session details for editing
app.get('/api/faculty/session-details/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;
        
        const sessionRes = await pool.query('SELECT * FROM sessions WHERE session_id = $1', [sessionId]);
        if (sessionRes.rows.length === 0) {
            return res.status(404).json({ error: 'Session not found' });
        }
        
        const recordsRes = await pool.query('SELECT * FROM attendance_records WHERE session_id = $1 ORDER BY roll_no', [sessionId]);
        
        res.json({
            session: sessionRes.rows[0],
            records: recordsRes.rows
        });
    } catch (err) {
        console.error('Session details error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

startServer();