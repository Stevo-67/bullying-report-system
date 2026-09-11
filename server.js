const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || '',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

async function initDB() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT,
        description TEXT,
        status TEXT DEFAULT 'Pending',
        student_name TEXT DEFAULT 'Anonymous',
        urgency TEXT DEFAULT 'Medium',
        client_id TEXT,
        ip_address TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS warnings (
        client_id TEXT PRIMARY KEY,
        warning_message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS banned_clients (
        client_id TEXT PRIMARY KEY,
        ip TEXT,
        reason TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try { await db.execute(`ALTER TABLE reports ADD COLUMN client_id TEXT`); } catch (e) {}
    try { await db.execute(`ALTER TABLE reports ADD COLUMN ip_address TEXT`); } catch (e) {}

  } catch (err) {
    console.error('Database setup error:', err);
  }
}
initDB();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : req.ip || req.socket.remoteAddress;
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-pin'] === ADMIN_PIN) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized: Invalid PIN' });
  }
}

// PUBLIC: Check client warning / ban status
app.get('/api/client-status/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;

    const banCheck = await db.execute({
      sql: 'SELECT client_id FROM banned_clients WHERE client_id = ?',
      args: [clientId]
    });

    if (banCheck.rows.length > 0) {
      return res.json({ status: 'banned' });
    }

    const warnCheck = await db.execute({
      sql: 'SELECT warning_message FROM warnings WHERE client_id = ?',
      args: [clientId]
    });

    if (warnCheck.rows.length > 0) {
      return res.json({ status: 'warned', message: warnCheck.rows[0].warning_message });
    }

    res.json({ status: 'clean' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// PUBLIC: Submit Report
app.post('/api/reports', async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const clientId = req.body.client_id || 'unknown';

    const banCheck = await db.execute({
      sql: 'SELECT client_id FROM banned_clients WHERE client_id = ?',
      args: [clientId]
    });

    if (banCheck.rows.length > 0) {
      return res.status(403).json({ error: 'Your device has been suspended from submitting reports.' });
    }

    const student_name = req.body.student_name || req.body.student || 'Anonymous';
    const category = req.body.category || 'General';
    const description = req.body.description || req.body.message || 'No description provided';
    const urgency = req.body.urgency || 'Medium';

    await db.execute({
      sql: 'INSERT INTO reports (category, description, status, student_name, urgency, client_id, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [String(category), String(description), 'Pending', String(student_name), String(urgency), String(clientId), String(clientIp)]
    });

    res.json({ success: true, message: 'Report submitted successfully' });
  } catch (error) {
    console.error('Error saving report:', error);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// PROTECTED: Fetch reports and include warning status
app.get('/api/reports', requireAdmin, async (req, res) => {
  try {
    const reportsResult = await db.execute('SELECT * FROM reports ORDER BY id DESC');
    const warningsResult = await db.execute('SELECT client_id FROM warnings');
    
    const warnedClientIds = new Set(warningsResult.rows.map(w => w.client_id));

    const reports = reportsResult.rows.map(report => ({
      ...report,
      is_warned: warnedClientIds.has(report.client_id)
    }));

    res.json(reports);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// PROTECTED: Issue warning to client
app.post('/api/reports/:id/warn', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const report = await db.execute({ sql: 'SELECT client_id FROM reports WHERE id = ?', args: [id] });

    if (report.rows.length > 0 && report.rows[0].client_id) {
      const clientId = report.rows[0].client_id;
      const warningMsg = req.body.message || 'Warning: Submitting troll or inappropriate reports is prohibited.';

      await db.execute({
        sql: 'INSERT OR REPLACE INTO warnings (client_id, warning_message) VALUES (?, ?)',
        args: [clientId, warningMsg]
      });

      return res.json({ success: true, message: 'Warning issued to client device.' });
    }

    res.status(404).json({ error: 'Report or device ID not found.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send warning.' });
  }
});

// PROTECTED: Ban client device
app.post('/api/reports/:id/ban', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const report = await db.execute({ sql: 'SELECT client_id, ip_address FROM reports WHERE id = ?', args: [id] });

    if (report.rows.length > 0 && report.rows[0].client_id) {
      const clientId = report.rows[0].client_id;
      const ip = report.rows[0].ip_address;

      await db.execute({
        sql: 'INSERT OR IGNORE INTO banned_clients (client_id, ip, reason) VALUES (?, ?, ?)',
        args: [clientId, ip, 'Repeated troll reports after warning']
      });

      await db.execute({ sql: 'DELETE FROM reports WHERE id = ?', args: [id] });
      return res.json({ success: true, message: 'Device banned and report removed.' });
    }

    res.status(404).json({ error: 'Report or device ID not found.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to ban device.' });
  }
});

// PROTECTED: Fetch banned clients list
app.get('/api/banned-clients', requireAdmin, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM banned_clients ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch banned clients' });
  }
});

// PROTECTED: Unban client device
app.post('/api/unban', requireAdmin, async (req, res) => {
  try {
    const { clientId } = req.body;
    await db.execute({ sql: 'DELETE FROM banned_clients WHERE client_id = ?', args: [clientId] });
    await db.execute({ sql: 'DELETE FROM warnings WHERE client_id = ?', args: [clientId] });
    res.json({ success: true, message: 'Device unbanned successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unban device' });
  }
});

// PROTECTED: Update report status
app.patch('/api/reports/:id', requireAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE reports SET status = ? WHERE id = ?',
      args: [req.body.status || 'Pending', req.params.id]
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// PROTECTED: Delete report
app.delete('/api/reports/:id', requireAdmin, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM reports WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));