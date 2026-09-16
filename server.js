require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@libsql/client');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// 1. Database Connection
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// SSE Clients for Real-Time Updates
let clients = [];
function sendEvent(data) {
  clients.forEach(c => c.res.write(`data: ${JSON.stringify(data)}\n\n`));
}

// 2. Initialize DB Schema (Isolated Ban Tables ignore legacy test bans)
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admission_number TEXT,
      device_id TEXT,
      category TEXT,
      urgency TEXT,
      description TEXT,
      is_anonymous BOOLEAN,
      status TEXT DEFAULT 'Pending',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS user_bans (
      user_id TEXT PRIMARY KEY,
      strike_count INTEGER DEFAULT 0,
      is_pbanned BOOLEAN DEFAULT 0
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS device_bans (
      device_id TEXT PRIMARY KEY,
      strike_count INTEGER DEFAULT 0,
      is_pbanned BOOLEAN DEFAULT 0
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS appeals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT,
      device_id TEXT,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS system_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      maintenance BOOLEAN DEFAULT 0
    )
  `);
  await db.execute(`INSERT OR IGNORE INTO system_state (id, maintenance) VALUES (1, 0)`);
}
initDB();

// Middleware
const adminAuth = (req, res, next) => {
  const pin = req.headers['x-admin-pin'];
  if (pin !== '1234') return res.status(401).json({ error: 'Unauthorized PIN' });
  next();
};

async function checkBanStatus(userId, deviceId) {
  const uRes = await db.execute("SELECT is_pbanned, strike_count FROM user_bans WHERE user_id = ?", [userId]);
  const dRes = await db.execute("SELECT is_pbanned, strike_count FROM device_bans WHERE device_id = ?", [deviceId]);

  const uBan = uRes.rows[0];
  const dBan = dRes.rows[0];

  if ((uBan && uBan.is_pbanned) || (dBan && dBan.is_pbanned)) {
    return { banned: true, message: "Access Restricted: Account or Hardware Device is Permanently Banned." };
  }

  const uStrikes = uBan ? uBan.strike_count : 0;
  const dStrikes = dBan ? dBan.strike_count : 0;
  const maxStrikes = Math.max(uStrikes, dStrikes);

  if (maxStrikes > 0) {
    return { banned: true, message: `Access Restricted: Active Strike ${maxStrikes}/3 on Account or Device.` };
  }

  return { banned: false };
}

// Routes
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  clients.push({ id: Date.now(), res });
  req.on('close', () => { clients = clients.filter(c => c.res !== res); });
  const ping = setInterval(() => res.write(':ping\n\n'), 15000);
  req.on('close', () => clearInterval(ping));
});

app.get('/api/maintenance-status', async (req, res) => {
  const state = await db.execute("SELECT maintenance FROM system_state WHERE id = 1");
  res.json({ maintenance: state.rows[0].maintenance === 1 });
});

app.post('/api/admin/toggle-maintenance', adminAuth, async (req, res) => {
  const state = await db.execute("SELECT maintenance FROM system_state WHERE id = 1");
  const newVal = state.rows[0].maintenance === 1 ? 0 : 1;
  await db.execute("UPDATE system_state SET maintenance = ? WHERE id = 1", [newVal]);
  res.json({ maintenance: newVal === 1 });
});

app.post('/api/student/auth', async (req, res) => {
  const { admission_number } = req.body;
  const deviceId = req.headers['x-device-id'];
  const banStatus = await checkBanStatus(admission_number, deviceId);
  if (banStatus.banned) return res.status(403).json({ error: banStatus.message });
  res.json({ success: true });
});

app.post('/api/reports', async (req, res) => {
  const { admission_number, category, urgency, description, is_anonymous } = req.body;
  const deviceId = req.headers['x-device-id'];

  const banStatus = await checkBanStatus(admission_number, deviceId);
  if (banStatus.banned) return res.status(403).json({ error: banStatus.message });

  const result = await db.execute(
    "INSERT INTO reports (admission_number, device_id, category, urgency, description, is_anonymous) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, category, urgency",
    [admission_number, deviceId, category, urgency, description, is_anonymous ? 1 : 0]
  );

  sendEvent(result.rows[0]);
  res.json({ success: true, id: result.rows[0].id });
});

app.post('/api/request-reset', async (req, res) => {
  const { clientId, device_id, reason } = req.body;
  await db.execute("INSERT INTO appeals (client_id, device_id, reason) VALUES (?, ?, ?)", [clientId, device_id, reason]);
  res.json({ success: true });
});

app.get('/api/announcements', async (req, res) => {
  const result = await db.execute("SELECT * FROM announcements ORDER BY created_at DESC LIMIT 5");
  res.json(result.rows);
});

app.post('/api/admin/announcements', adminAuth, async (req, res) => {
  const { title, message } = req.body;
  await db.execute("INSERT INTO announcements (title, message) VALUES (?, ?)", [title, message]);
  res.json({ success: true });
});

app.get('/api/reports', adminAuth, async (req, res) => {
  const result = await db.execute("SELECT * FROM reports ORDER BY timestamp DESC");
  res.json(result.rows);
});

app.patch('/api/reports/:id', adminAuth, async (req, res) => {
  await db.execute("UPDATE reports SET status = ? WHERE id = ?", [req.body.status, req.params.id]);
  res.json({ success: true });
});

app.delete('/api/reports/:id', adminAuth, async (req, res) => {
  await db.execute("DELETE FROM reports WHERE id = ?", [req.params.id]);
  res.json({ success: true });
});

app.delete('/api/admin/clear-all-reports', adminAuth, async (req, res) => {
  await db.execute("DELETE FROM reports");
  res.json({ success: true });
});

// Targeted Ban Handler: User, Device, or Both
app.post('/api/reports/:id/ban', adminAuth, async (req, res) => {
  const { id } = req.params;
  const { target } = req.body; // 'user' | 'device' | 'both'

  const reportRes = await db.execute("SELECT admission_number, device_id FROM reports WHERE id = ?", [id]);
  if (reportRes.rows.length === 0) return res.status(404).json({ error: "Report not found" });

  const { admission_number, device_id } = reportRes.rows[0];

  const applyStrike = async (table, colName, idValue) => {
    const existing = await db.execute(`SELECT strike_count FROM ${table} WHERE ${colName} = ?`, [idValue]);
    let strikes = existing.rows.length > 0 ? existing.rows[0].strike_count : 0;
    strikes += 1;
    const isPBanned = strikes >= 3 ? 1 : 0;

    await db.execute(`
      INSERT INTO ${table} (${colName}, strike_count, is_pbanned) VALUES (?, ?, ?)
      ON CONFLICT(${colName}) DO UPDATE SET strike_count = excluded.strike_count, is_pbanned = excluded.is_pbanned
    `, [idValue, strikes, isPBanned]);
    return { strikes, isPBanned: isPBanned === 1 };
  };

  let logs = [];
  if (target === 'user' || target === 'both') {
    const resU = await applyStrike('user_bans', 'user_id', admission_number);
    logs.push(`User '${admission_number}' -> Strike ${resU.strikes}/3 ${resU.isPBanned ? '(PBanned)' : ''}`);
  }
  if (target === 'device' || target === 'both') {
    const resD = await applyStrike('device_bans', 'device_id', device_id);
    logs.push(`Device '${device_id}' -> Strike ${resD.strikes}/3 ${resD.isPBanned ? '(PBanned)' : ''}`);
  }

  res.json({ success: true, message: logs.join(' | ') });
});

app.get('/api/banned-clients', adminAuth, async (req, res) => {
  const uBans = await db.execute("SELECT user_id as client_id, strike_count, is_pbanned, 'ACCOUNT' as target_type FROM user_bans WHERE strike_count > 0");
  const dBans = await db.execute("SELECT device_id as client_id, strike_count, is_pbanned, 'DEVICE' as target_type FROM device_bans WHERE strike_count > 0");
  const appeals = await db.execute("SELECT * FROM appeals");

  const formattedBans = [...uBans.rows, ...dBans.rows].map(b => ({
    client_id: b.client_id,
    type: `${b.target_type}: ${b.is_pbanned ? 'PERMANENT BAN (3 Strikes)' : 'TEMPORARY BAN (Strike ' + b.strike_count + ')'}`
  }));

  res.json({ bans: formattedBans, reset_requests: appeals.rows });
});

app.post('/api/unban', adminAuth, async (req, res) => {
  const { clientId } = req.body;
  await db.execute("DELETE FROM user_bans WHERE user_id = ?", [clientId]);
  await db.execute("DELETE FROM device_bans WHERE device_id = ?", [clientId]);
  await db.execute("DELETE FROM appeals WHERE client_id = ? OR device_id = ?", [clientId, clientId]);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bullying Report System running on port ${PORT}`));