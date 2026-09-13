require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

// Express Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Local LibSQL / SQLite Client
const db = createClient({
  url: 'file:reports.db'
});

// SSE Clients Registry
let sseClients = [];

// Initialize Database Tables
async function initDb() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS students (
        admission_number TEXT PRIMARY KEY,
        pin_hash TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        warning TEXT
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admission_number TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        urgency TEXT NOT NULL,
        status TEXT DEFAULT 'Pending',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS appeals (
        admission_number TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ Local SQLite database (reports.db) initialized.');
  } catch (err) {
    console.error('❌ Failed to initialize database:', err);
  }
}

initDb();

// Admin Middleware
function verifyAdminPin(req, res, next) {
  const pin = req.headers['x-admin-pin'];
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin PIN' });
  }
  next();
}

// SSE Notification Broadcast
function broadcastNewReport(report) {
  sseClients.forEach(client => {
    client.res.write(`data: ${JSON.stringify(report)}\n\n`);
  });
}

// ----------------------------------------------------
// SSE REAL-TIME STREAM
// ----------------------------------------------------
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// ----------------------------------------------------
// STUDENT AUTH & STATUS ROUTING
// ----------------------------------------------------
app.get('/api/client-status/:admNo', async (req, res) => {
  const cleanAdm = req.params.admNo.trim().toUpperCase();

  try {
    const result = await db.execute({
      sql: 'SELECT * FROM students WHERE admission_number = ?',
      args: [cleanAdm]
    });

    if (result.rows.length === 0) {
      return res.json({ status: 'clean' });
    }

    const student = result.rows[0];

    if (student.status === 'banned') {
      return res.json({ status: 'cooldown' });
    }

    if (student.warning) {
      return res.json({ status: 'warned', message: student.warning });
    }

    res.json({ status: 'clean' });
  } catch (err) {
    console.error('Error fetching client status:', err);
    res.status(500).json({ error: 'Database query error' });
  }
});

app.post('/api/student/auth', async (req, res) => {
  const { admission_number, pin } = req.body;

  if (!admission_number || !pin) {
    return res.status(400).json({ error: 'Admission Number and PIN are required.' });
  }

  const cleanAdm = admission_number.trim().toUpperCase();

  try {
    const result = await db.execute({
      sql: 'SELECT * FROM students WHERE admission_number = ?',
      args: [cleanAdm]
    });

    // FIRST-TIME USER: Create account & set PIN
    if (result.rows.length === 0) {
      const pin_hash = await bcrypt.hash(pin, 10);
      await db.execute({
        sql: 'INSERT INTO students (admission_number, pin_hash, status) VALUES (?, ?, ?)',
        args: [cleanAdm, pin_hash, 'active']
      });
      return res.json({ success: true, message: 'Account PIN set successfully.' });
    }

    const student = result.rows[0];

    // BANNED ACCOUNT CHECK
    if (student.status === 'banned') {
      return res.status(403).json({ error: 'This account is currently restricted. Please submit an appeal.' });
    }

    // RETURNING USER: Verify PIN
    const isValidPin = await bcrypt.compare(pin, student.pin_hash);
    if (!isValidPin) {
      return res.status(401).json({ error: 'Incorrect PIN for this Admission Number.' });
    }

    res.json({ success: true, message: 'Authentication successful.' });
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Authentication failed.' });
  }
});

// ----------------------------------------------------
// REPORT & APPEAL SUBMISSION
// ----------------------------------------------------
app.post('/api/reports', async (req, res) => {
  const { admission_number, category, description, urgency } = req.body;
  const cleanAdm = (admission_number || '').trim().toUpperCase();

  try {
    const studentResult = await db.execute({
      sql: 'SELECT status FROM students WHERE admission_number = ?',
      args: [cleanAdm]
    });

    if (studentResult.rows.length > 0 && studentResult.rows[0].status === 'banned') {
      return res.status(403).json({ error: 'Submission denied. Account is restricted.' });
    }

    // Rate Limit Cooldown Check (10 seconds)
    const recentReport = await db.execute({
      sql: 'SELECT timestamp FROM reports WHERE admission_number = ? ORDER BY id DESC LIMIT 1',
      args: [cleanAdm]
    });

    if (recentReport.rows.length > 0) {
      const lastTime = new Date(recentReport.rows[0].timestamp).getTime();
      if (Date.now() - lastTime < 10000) {
        return res.status(429).json({ error: 'Please wait 10 seconds before submitting another report.' });
      }
    }

    const insertResult = await db.execute({
      sql: 'INSERT INTO reports (admission_number, category, description, urgency) VALUES (?, ?, ?, ?)',
      args: [cleanAdm, category, description, urgency]
    });

    const newReport = {
      id: Number(insertResult.lastInsertRowid),
      admission_number: cleanAdm,
      student_name: cleanAdm,
      category,
      description,
      urgency,
      status: 'Pending',
      timestamp: new Date().toISOString()
    };

    broadcastNewReport(newReport);
    res.json({ success: true, message: 'Report submitted successfully.' });
  } catch (err) {
    console.error('Error submitting report:', err);
    res.status(500).json({ error: 'Failed to save report.' });
  }
});

app.post('/api/request-reset', async (req, res) => {
  const { clientId, reason } = req.body;
  const cleanAdm = (clientId || '').trim().toUpperCase();

  if (!reason) {
    return res.status(400).json({ error: 'Appeal reason is required.' });
  }

  try {
    await db.execute({
      sql: 'INSERT INTO appeals (admission_number, reason) VALUES (?, ?) ON CONFLICT(admission_number) DO UPDATE SET reason = excluded.reason, timestamp = CURRENT_TIMESTAMP',
      args: [cleanAdm, reason]
    });

    res.json({ success: true, message: 'Appeal submitted to counselors.' });
  } catch (err) {
    console.error('Error submitting appeal:', err);
    res.status(500).json({ error: 'Failed to record appeal.' });
  }
});

// ----------------------------------------------------
// ADMIN DASHBOARD ENDPOINTS
// ----------------------------------------------------
app.get('/api/reports', verifyAdminPin, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM reports ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching reports:', err);
    res.status(500).json({ error: 'Failed to fetch reports.' });
  }
});

app.get('/api/banned-clients', verifyAdminPin, async (req, res) => {
  try {
    const bannedResult = await db.execute("SELECT admission_number AS client_id, 'Account Ban' AS ban_type, CURRENT_TIMESTAMP AS timestamp FROM students WHERE status = 'banned'");
    const appealsResult = await db.execute('SELECT admission_number AS client_id, reason FROM appeals');

    res.json({ bans: bannedResult.rows, reset_requests: appealsResult.rows });
  } catch (err) {
    console.error('Error fetching banned clients:', err);
    res.status(500).json({ error: 'Failed to fetch banned clients.' });
  }
});

app.patch('/api/reports/:id', verifyAdminPin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { status } = req.body;

  try {
    await db.execute({
      sql: 'UPDATE reports SET status = ? WHERE id = ?',
      args: [status, id]
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating status:', err);
    res.status(500).json({ error: 'Failed to update report status.' });
  }
});

app.post('/api/reports/:id/warn', verifyAdminPin, async (req, res) => {
  const id = parseInt(req.params.id);
  const { message } = req.body;

  try {
    const reportResult = await db.execute({
      sql: 'SELECT admission_number FROM reports WHERE id = ?',
      args: [id]
    });

    if (reportResult.rows.length > 0) {
      const admNo = reportResult.rows[0].admission_number;
      await db.execute({
        sql: 'UPDATE students SET warning = ? WHERE admission_number = ?',
        args: [message, admNo]
      });
      return res.json({ success: true });
    }

    res.status(404).json({ error: 'Report not found' });
  } catch (err) {
    console.error('Error issuing warning:', err);
    res.status(500).json({ error: 'Failed to issue warning.' });
  }
});

app.post('/api/reports/:id/ban', verifyAdminPin, async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    const reportResult = await db.execute({
      sql: 'SELECT admission_number FROM reports WHERE id = ?',
      args: [id]
    });

    if (reportResult.rows.length > 0) {
      const admNo = reportResult.rows[0].admission_number;
      await db.execute({
        sql: 'UPDATE students SET status = \'banned\' WHERE admission_number = ?',
        args: [admNo]
      });
      return res.json({ success: true });
    }

    res.status(404).json({ error: 'Report not found' });
  } catch (err) {
    console.error('Error banning account:', err);
    res.status(500).json({ error: 'Failed to ban student.' });
  }
});

app.post('/api/admin/reset-pin', verifyAdminPin, async (req, res) => {
  const cleanAdm = (req.body.admission_number || '').trim().toUpperCase();

  try {
    await db.execute({
      sql: 'DELETE FROM students WHERE admission_number = ?',
      args: [cleanAdm]
    });

    res.json({ success: true, message: `PIN reset for ${cleanAdm}.` });
  } catch (err) {
    console.error('Error resetting PIN:', err);
    res.status(500).json({ error: 'Failed to reset PIN.' });
  }
});

app.post('/api/unban', verifyAdminPin, async (req, res) => {
  const cleanAdm = (req.body.clientId || '').trim().toUpperCase();

  try {
    await db.execute({
      sql: 'UPDATE students SET status = \'active\' WHERE admission_number = ?',
      args: [cleanAdm]
    });

    await db.execute({
      sql: 'DELETE FROM appeals WHERE admission_number = ?',
      args: [cleanAdm]
    });

    res.json({ success: true, message: `Account ${cleanAdm} unbanned.` });
  } catch (err) {
    console.error('Error unbanning student:', err);
    res.status(500).json({ error: 'Failed to unban student.' });
  }
});

app.delete('/api/reports/:id', verifyAdminPin, async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    await db.execute({
      sql: 'DELETE FROM reports WHERE id = ?',
      args: [id]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting report:', err);
    res.status(500).json({ error: 'Failed to delete report.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});