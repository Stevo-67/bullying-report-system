require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
let MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === 'true';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite via LibSQL Client
const db = createClient({
  url: 'file:reports.db'
});

let sseClients = [];

// Database Schema Setup
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
      CREATE TABLE IF NOT EXISTS banned_devices (
        device_id TEXT PRIMARY KEY,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        admission_number TEXT NOT NULL,
        device_id TEXT NOT NULL,
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        urgency TEXT NOT NULL,
        is_anonymous INTEGER DEFAULT 0,
        status TEXT DEFAULT 'Pending',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS appeals (
        admission_number TEXT PRIMARY KEY,
        device_id TEXT,
        reason TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ SQLite schema initialized with device tracking and maintenance support.');
  } catch (err) {
    console.error('❌ Database init error:', err);
  }
}

initDb();

// Maintenance Check Middleware
function checkMaintenance(req, res, next) {
  if (MAINTENANCE_MODE) {
    return res.status(503).json({ error: 'Portal is temporarily offline for maintenance.' });
  }
  next();
}

// Ban Check Middleware (Device + Account)
async function checkBans(req, res, next) {
  const deviceId = req.headers['x-device-id'] || req.body.device_id;
  const admissionNumber = (req.body.admission_number || req.params.admNo || '').trim().toUpperCase();

  try {
    if (deviceId) {
      const devCheck = await db.execute({
        sql: 'SELECT * FROM banned_devices WHERE device_id = ?',
        args: [deviceId]
      });
      if (devCheck.rows.length > 0) {
        return res.status(403).json({ error: 'This device has been permanently restricted from submitting reports.' });
      }
    }

    if (admissionNumber) {
      const studentCheck = await db.execute({
        sql: 'SELECT status FROM students WHERE admission_number = ?',
        args: [admissionNumber]
      });
      if (studentCheck.rows.length > 0 && studentCheck.rows[0].status === 'banned') {
        return res.status(403).json({ error: 'Account restricted. Please submit an appeal to counselors.' });
      }
    }

    next();
  } catch (err) {
    console.error('Ban check error:', err);
    res.status(500).json({ error: 'System authorization failure.' });
  }
}

// Admin Verification Middleware
function verifyAdminPin(req, res, next) {
  const pin = req.headers['x-admin-pin'];
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin PIN' });
  }
  next();
}

// Real-time Event Notification Broadcast
function broadcastNewReport(report) {
  sseClients.forEach(client => {
    client.res.write(`data: ${JSON.stringify(report)}\n\n`);
  });
}

// ----------------------------------------------------
// SYSTEM & SSE ROUTING
// ----------------------------------------------------
app.get('/api/maintenance-status', (req, res) => {
  res.json({ maintenance: MAINTENANCE_MODE });
});

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
// STUDENT PORTAL ENDPOINTS
// ----------------------------------------------------
app.get('/api/client-status/:admNo', checkMaintenance, checkBans, async (req, res) => {
  const cleanAdm = req.params.admNo.trim().toUpperCase();
  try {
    const result = await db.execute({
      sql: 'SELECT * FROM students WHERE admission_number = ?',
      args: [cleanAdm]
    });

    if (result.rows.length === 0) return res.json({ status: 'clean' });

    const student = result.rows[0];
    if (student.warning) return res.json({ status: 'warned', message: student.warning });

    res.json({ status: 'clean' });
  } catch (err) {
    res.status(500).json({ error: 'Database query error' });
  }
});

app.post('/api/student/auth', checkMaintenance, checkBans, async (req, res) => {
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

    if (result.rows.length === 0) {
      const pin_hash = await bcrypt.hash(pin, 10);
      await db.execute({
        sql: 'INSERT INTO students (admission_number, pin_hash, status) VALUES (?, ?, ?)',
        args: [cleanAdm, pin_hash, 'active']
      });
      return res.json({ success: true, message: 'Account PIN established.' });
    }

    const student = result.rows[0];
    const isValidPin = await bcrypt.compare(pin, student.pin_hash);
    if (!isValidPin) {
      return res.status(401).json({ error: 'Invalid PIN for this Admission Number.' });
    }

    res.json({ success: true, message: 'Authentication successful.' });
  } catch (err) {
    res.status(500).json({ error: 'Authentication failed.' });
  }
});

app.post('/api/reports', checkMaintenance, checkBans, async (req, res) => {
  const { admission_number, device_id, category, description, urgency, is_anonymous } = req.body;
  const cleanAdm = (admission_number || '').trim().toUpperCase();

  if (!device_id) {
    return res.status(400).json({ error: 'Missing client device signature.' });
  }

  try {
    // Cooldown check (10 seconds)
    const recentReport = await db.execute({
      sql: 'SELECT timestamp FROM reports WHERE admission_number = ? OR device_id = ? ORDER BY id DESC LIMIT 1',
      args: [cleanAdm, device_id]
    });

    if (recentReport.rows.length > 0) {
      const lastTime = new Date(recentReport.rows[0].timestamp).getTime();
      if (Date.now() - lastTime < 10000) {
        return res.status(429).json({ error: 'Cooldown active. Please wait 10 seconds between submissions.' });
      }
    }

    const insertResult = await db.execute({
      sql: 'INSERT INTO reports (admission_number, device_id, category, description, urgency, is_anonymous) VALUES (?, ?, ?, ?, ?, ?)',
      args: [cleanAdm, device_id, category, description, urgency, is_anonymous ? 1 : 0]
    });

    const newReport = {
      id: Number(insertResult.lastInsertRowid),
      admission_number: is_anonymous ? 'ANONYMOUS' : cleanAdm,
      category,
      description,
      urgency,
      is_anonymous: Boolean(is_anonymous),
      status: 'Pending',
      timestamp: new Date().toISOString()
    };

    broadcastNewReport(newReport);
    res.json({ success: true, message: 'Report submitted successfully.' });
  } catch (err) {
    console.error('Report submission error:', err);
    res.status(500).json({ error: 'Failed to record incident report.' });
  }
});

app.post('/api/request-reset', checkMaintenance, async (req, res) => {
  const { clientId, device_id, reason } = req.body;
  const cleanAdm = (clientId || '').trim().toUpperCase();

  if (!reason) {
    return res.status(400).json({ error: 'Appeal reason is required.' });
  }

  try {
    await db.execute({
      sql: 'INSERT INTO appeals (admission_number, device_id, reason) VALUES (?, ?, ?) ON CONFLICT(admission_number) DO UPDATE SET reason = excluded.reason, timestamp = CURRENT_TIMESTAMP',
      args: [cleanAdm, device_id || 'UNKNOWN', reason]
    });
    res.json({ success: true, message: 'Appeal submitted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to log appeal.' });
  }
});

// ----------------------------------------------------
// ADMIN DASHBOARD ENDPOINTS
// ----------------------------------------------------
app.post('/api/admin/toggle-maintenance', verifyAdminPin, (req, res) => {
  MAINTENANCE_MODE = !MAINTENANCE_MODE;
  res.json({ success: true, maintenance: MAINTENANCE_MODE });
});

app.get('/api/reports', verifyAdminPin, async (req, res) => {
  try {
    const result = await db.execute('SELECT id, CASE WHEN is_anonymous = 1 THEN "ANONYMOUS" ELSE admission_number END as admission_number, category, description, urgency, status, timestamp, is_anonymous FROM reports ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve reports.' });
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
    res.status(500).json({ error: 'Failed to update report status.' });
  }
});

app.post('/api/reports/:id/ban-all', verifyAdminPin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const reportRes = await db.execute({
      sql: 'SELECT admission_number, device_id FROM reports WHERE id = ?',
      args: [id]
    });

    if (reportRes.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    const { admission_number, device_id } = reportRes.rows[0];

    await db.execute({
      sql: "UPDATE students SET status = 'banned' WHERE admission_number = ?",
      args: [admission_number]
    });

    if (device_id) {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO banned_devices (device_id) VALUES (?)',
        args: [device_id]
      });
    }

    res.json({ success: true, message: `Banned account ${admission_number} and device fingerprint.` });
  } catch (err) {
    console.error('Ban error:', err);
    res.status(500).json({ error: 'Failed to issue complete ban.' });
  }
});

app.get('/api/banned-clients', verifyAdminPin, async (req, res) => {
  try {
    const bannedStudents = await db.execute("SELECT admission_number AS client_id, 'Account Ban' AS type FROM students WHERE status = 'banned'");
    const bannedDevices = await db.execute("SELECT device_id AS client_id, 'Device Fingerprint Ban' AS type FROM banned_devices");
    const appeals = await db.execute('SELECT admission_number AS client_id, reason FROM appeals');

    res.json({
      bans: [...bannedStudents.rows, ...bannedDevices.rows],
      reset_requests: appeals.rows
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve ban logs.' });
  }
});

app.post('/api/unban', verifyAdminPin, async (req, res) => {
  const cleanTarget = (req.body.clientId || '').trim().toUpperCase();

  try {
    await db.execute({ sql: "UPDATE students SET status = 'active' WHERE admission_number = ?", args: [cleanTarget] });
    await db.execute({ sql: 'DELETE FROM banned_devices WHERE device_id = ?', args: [cleanTarget] });
    await db.execute({ sql: 'DELETE FROM appeals WHERE admission_number = ?', args: [cleanTarget] });

    res.json({ success: true, message: `Unbanned target ${cleanTarget}.` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove restriction.' });
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
    res.status(500).json({ error: 'Failed to reset PIN.' });
  }
});

app.delete('/api/reports/:id', verifyAdminPin, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM reports WHERE id = ?', args: [parseInt(req.params.id)] });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed.' });
  }
});

app.delete('/api/admin/clear-all-reports', verifyAdminPin, async (req, res) => {
  try {
    await db.execute('DELETE FROM reports');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Purge failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});