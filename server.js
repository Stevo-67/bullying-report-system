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

// SSE Live Notification Connections
let sseClients = [];

setInterval(() => {
  sseClients.forEach(client => client.write(': ping\n\n'));
}, 20000);

function notifyAdmins(reportData) {
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify(reportData)}\n\n`);
  });
}

// Database Initialization
async function initDB() {
  try {
    // 1. Reports Table
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
        is_quarantined INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const reportCols = [
      'client_id TEXT',
      'ip_address TEXT',
      'is_quarantined INTEGER DEFAULT 0',
      'urgency TEXT DEFAULT "Medium"',
      'student_name TEXT DEFAULT "Anonymous"'
    ];
    for (const colSpec of reportCols) {
      try { await db.execute(`ALTER TABLE reports ADD COLUMN ${colSpec}`); } catch (e) {}
    }

    // 2. Warnings Table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS warnings (
        client_id TEXT PRIMARY KEY,
        warning_message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 3. Banned Clients Table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS banned_clients (
        client_id TEXT PRIMARY KEY,
        ip TEXT,
        ban_type TEXT DEFAULT 'shadow',
        expires_at DATETIME,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const banCols = [
      "ban_type TEXT DEFAULT 'shadow'",
      "expires_at DATETIME",
      "ip TEXT"
    ];
    for (const colSpec of banCols) {
      try { await db.execute(`ALTER TABLE banned_clients ADD COLUMN ${colSpec}`); } catch (e) {}
    }

    // 4. Ban Appeals / Reset Requests Table
    await db.execute(`
      CREATE TABLE IF NOT EXISTS reset_requests (
        client_id TEXT PRIMARY KEY,
        reason TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database initialized successfully.');
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

// SSE Live Event Stream
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// PUBLIC: Check client restriction status
app.get('/api/client-status/:clientId', async (req, res) => {
  try {
    const { clientId } = req.params;

    const banCheck = await db.execute({
      sql: 'SELECT ban_type, expires_at FROM banned_clients WHERE client_id = ?',
      args: [clientId]
    });

    if (banCheck.rows.length > 0) {
      const ban = banCheck.rows[0];
      if (ban.ban_type === '24h' && ban.expires_at && new Date(ban.expires_at) > new Date()) {
        return res.json({ status: 'cooldown', expires_at: ban.expires_at });
      } else if (ban.ban_type === '24h' && ban.expires_at && new Date(ban.expires_at) <= new Date()) {
        await db.execute({ sql: 'DELETE FROM banned_clients WHERE client_id = ?', args: [clientId] });
      } else if (ban.ban_type === 'shadow') {
        return res.json({ status: 'clean' });
      }
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
    console.error('Error in /api/client-status:', err);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});

// PUBLIC: Submit Report
app.post('/api/reports', async (req, res) => {
  try {
    const clientIp = getClientIp(req);
    const clientId = req.body.client_id || 'unknown';
    const urgency = req.body.urgency || 'Medium';

    const banCheck = await db.execute({
      sql: 'SELECT ban_type, expires_at FROM banned_clients WHERE client_id = ?',
      args: [clientId]
    });

    let isQuarantined = 0;

    if (banCheck.rows.length > 0) {
      const ban = banCheck.rows[0];

      if (ban.ban_type === '24h' && ban.expires_at && new Date(ban.expires_at) > new Date()) {
        if (urgency.toLowerCase() === 'high') {
          isQuarantined = 0;
        } else {
          return res.status(429).json({ error: 'Device is on a 24-hour submission cooldown. Emergency (High Urgency) reports can still be submitted.' });
        }
      } else if (ban.ban_type === 'shadow') {
        isQuarantined = 1;
      }
    }

    const student_name = req.body.student_name || 'Anonymous';
    const category = req.body.category || 'General';
    const description = req.body.description || 'No description provided';

    await db.execute({
      sql: `INSERT INTO reports (category, description, status, student_name, urgency, client_id, ip_address, is_quarantined) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        String(category),
        String(description),
        'Pending',
        String(student_name),
        String(urgency),
        String(clientId),
        String(clientIp),
        isQuarantined
      ]
    });

    notifyAdmins({
      category,
      student_name,
      urgency,
      description,
      is_quarantined: isQuarantined,
      timestamp: new Date().toISOString()
    });

    res.json({ success: true, message: 'Report submitted successfully' });
  } catch (error) {
    console.error('Error saving report:', error);
    res.status(500).json({ error: 'Failed to submit report. Please try again.' });
  }
});

// PUBLIC: Submit Ban Appeal / Access Reset Request
app.post('/api/request-reset', async (req, res) => {
  try {
    const { clientId, reason } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Missing client ID' });

    await db.execute({
      sql: 'INSERT OR REPLACE INTO reset_requests (client_id, reason) VALUES (?, ?)',
      args: [String(clientId), String(reason || 'User requested ban appeal')]
    });
    res.json({ success: true, message: 'Appeal submitted to counselors.' });
  } catch (err) {
    console.error('Error in /api/request-reset:', err);
    res.status(500).json({ error: 'Failed to send appeal request' });
  }
});

// PROTECTED: Fetch Reports
app.get('/api/reports', requireAdmin, async (req, res) => {
  try {
    const reportsResult = await db.execute('SELECT * FROM reports ORDER BY id DESC');
    const warningsResult = await db.execute('SELECT client_id FROM warnings');
    const resetRequests = await db.execute('SELECT client_id FROM reset_requests');
    const historyCounts = await db.execute('SELECT client_id, COUNT(*) as count FROM reports GROUP BY client_id');

    const warnedSet = new Set(warningsResult.rows.map(w => w.client_id));
    const resetSet = new Set(resetRequests.rows.map(r => r.client_id));
    const countMap = {};
    historyCounts.rows.forEach(h => { countMap[h.client_id] = h.count; });

    const reports = reportsResult.rows.map(report => ({
      ...report,
      is_warned: warnedSet.has(report.client_id),
      has_reset_request: resetSet.has(report.client_id),
      device_history_count: countMap[report.client_id] || 1
    }));

    res.json(reports);
  } catch (error) {
    console.error('Error in GET /api/reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// PROTECTED: Issue Warning
app.post('/api/reports/:id/warn', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const report = await db.execute({ sql: 'SELECT client_id FROM reports WHERE id = ?', args: [id] });

    if (report.rows.length > 0 && report.rows[0].client_id) {
      const clientId = report.rows[0].client_id;
      const warningMsg = req.body.message || 'Warning: Submitting false reports violates portal guidelines.';

      await db.execute({
        sql: 'INSERT OR REPLACE INTO warnings (client_id, warning_message) VALUES (?, ?)',
        args: [clientId, warningMsg]
      });

      return res.json({ success: true, message: 'Warning issued.' });
    }
    res.status(404).json({ error: 'Report not found' });
  } catch (err) {
    console.error('Error in /api/reports/:id/warn:', err);
    res.status(500).json({ error: 'Failed to send warning' });
  }
});

// PROTECTED: Apply Ban
app.post('/api/reports/:id/ban', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { banType } = req.body;
    const report = await db.execute({ sql: 'SELECT client_id, ip_address FROM reports WHERE id = ?', args: [id] });

    if (report.rows.length > 0 && report.rows[0].client_id) {
      const clientId = report.rows[0].client_id;
      const ip = report.rows[0].ip_address || '';
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

      await db.execute({
        sql: 'INSERT OR REPLACE INTO banned_clients (client_id, ip, ban_type, expires_at) VALUES (?, ?, ?, ?)',
        args: [clientId, ip, banType || 'shadow', banType === '24h' ? expiresAt : null]
      });

      await db.execute({ sql: 'DELETE FROM reports WHERE id = ?', args: [id] });
      return res.json({ success: true, message: `${banType === '24h' ? '24-Hour Cooldown' : 'Shadow Ban'} applied.` });
    }

    res.status(404).json({ error: 'Report not found' });
  } catch (err) {
    console.error('Error in /api/reports/:id/ban:', err);
    res.status(500).json({ error: 'Failed to restrict device' });
  }
});

// PROTECTED: Fetch Banned Devices & Pending Appeals
app.get('/api/banned-clients', requireAdmin, async (req, res) => {
  try {
    const bans = await db.execute('SELECT * FROM banned_clients ORDER BY timestamp DESC');
    const resets = await db.execute('SELECT * FROM reset_requests ORDER BY timestamp DESC');
    res.json({ bans: bans.rows, reset_requests: resets.rows });
  } catch (err) {
    console.error('Error in /api/banned-clients:', err);
    res.status(500).json({ error: 'Failed to fetch banned records' });
  }
});

// PROTECTED: Undo Ban / Accept Appeal
app.post('/api/unban', requireAdmin, async (req, res) => {
  try {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Missing client ID' });

    await db.execute({ sql: 'DELETE FROM banned_clients WHERE client_id = ?', args: [clientId] });
    await db.execute({ sql: 'DELETE FROM warnings WHERE client_id = ?', args: [clientId] });
    await db.execute({ sql: 'DELETE FROM reset_requests WHERE client_id = ?', args: [clientId] });
    await db.execute({ sql: 'UPDATE reports SET is_quarantined = 0 WHERE client_id = ?', args: [clientId] });

    res.json({ success: true, message: 'Device unbanned and reports restored.' });
  } catch (err) {
    console.error('Error in /api/unban:', err);
    res.status(500).json({ error: 'Failed to unban device' });
  }
});

// PROTECTED: Update Status
app.patch('/api/reports/:id', requireAdmin, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE reports SET status = ? WHERE id = ?',
      args: [req.body.status || 'Pending', req.params.id]
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// PROTECTED: Delete Report
app.delete('/api/reports/:id', requireAdmin, async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM reports WHERE id = ?', args: [req.params.id] });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting report:', error);
    res.status(500).json({ error: 'Failed to delete report' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));