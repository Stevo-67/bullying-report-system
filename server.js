const express = require('express');
const cors = require('cors');
const path = require('path');
const { createClient } = require('@libsql/client');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Turso Database Client
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// SSE Clients Registry
let sseClients = [];

// Initialize Database Tables
async function initDatabase() {
  try {
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
      CREATE TABLE IF NOT EXISTS banned_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT UNIQUE NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS reset_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id TEXT UNIQUE NOT NULL,
        reason TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ Turso Database tables verified and initialized.');
  } catch (err) {
    console.error('❌ Failed to initialize Turso database:', err);
  }
}

initDatabase();

// Admin Authentication Middleware
function checkAdminPin(req, res, next) {
  const pin = req.headers['x-admin-pin'];
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Unauthorized: Invalid PIN' });
  }
  next();
}

// Broadcast SSE Event to Admin Dashboards
function notifyAdminClients(data) {
  sseClients.forEach(client => {
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// --- SSE Real-time Feed ---
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

// --- Public / Student Endpoints ---

// Submit a new incident report
app.post('/api/reports', async (req, res) => {
  const { admission_number, category, description, urgency } = req.body;

  if (!admission_number || !category || !description || !urgency) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    // Check if client is banned
    const banCheck = await db.execute({
      sql: 'SELECT * FROM banned_clients WHERE client_id = ?',
      args: [admission_number]
    });

    if (banCheck.rows.length > 0) {
      return res.status(403).json({ error: 'This account has been banned.' });
    }

    const result = await db.execute({
      sql: 'INSERT INTO reports (admission_number, category, description, urgency) VALUES (?, ?, ?, ?)',
      args: [admission_number, category, description, urgency]
    });

    const newReport = {
      id: Number(result.lastInsertRowid),
      admission_number,
      category,
      description,
      urgency,
      status: 'Pending',
      timestamp: new Date().toISOString()
    };

    notifyAdminClients(newReport);
    res.status(201).json({ success: true, report: newReport });
  } catch (err) {
    console.error('Error inserting report:', err);
    res.status(500).json({ error: 'Failed to save incident report.' });
  }
});

// Submit Ban Appeal / Reset Request
app.post('/api/appeal', async (req, res) => {
  const { clientId, reason } = req.body;
  if (!clientId || !reason) return res.status(400).json({ error: 'Missing parameters.' });

  try {
    await db.execute({
      sql: 'INSERT OR REPLACE INTO reset_requests (client_id, reason) VALUES (?, ?)',
      args: [clientId, reason]
    });
    res.json({ success: true, message: 'Appeal recorded.' });
  } catch (err) {
    console.error('Error recording appeal:', err);
    res.status(500).json({ error: 'Failed to record appeal.' });
  }
});

// --- Protected Admin Endpoints ---

// Get all active reports
app.get('/api/reports', checkAdminPin, async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM reports ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching reports:', err);
    res.status(500).json({ error: 'Failed to retrieve reports.' });
  }
});

// Update report status
app.patch('/api/reports/:id', checkAdminPin, async (req, res) => {
  const { id } = req.params;
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

// Delete a report
app.delete('/api/reports/:id', checkAdminPin, async (req, res) => {
  const { id } = req.params;

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

// Ban account tied to a report
app.post('/api/reports/:id/ban', checkAdminPin, async (req, res) => {
  const { id } = req.params;

  try {
    const reportResult = await db.execute({
      sql: 'SELECT admission_number FROM reports WHERE id = ?',
      args: [id]
    });

    if (reportResult.rows.length === 0) {
      return res.status(404).json({ error: 'Report not found.' });
    }

    const clientId = reportResult.rows[0].admission_number;

    await db.execute({
      sql: 'INSERT OR IGNORE INTO banned_clients (client_id) VALUES (?)',
      args: [clientId]
    });

    res.json({ success: true, message: `Banned student ${clientId}` });
  } catch (err) {
    console.error('Error banning client:', err);
    res.status(500).json({ error: 'Failed to ban student.' });
  }
});

// Get banned accounts and reset appeals
app.get('/api/banned-clients', checkAdminPin, async (req, res) => {
  try {
    const bansResult = await db.execute('SELECT * FROM banned_clients ORDER BY timestamp DESC');
    const appealsResult = await db.execute('SELECT * FROM reset_requests ORDER BY timestamp DESC');

    res.json({
      bans: bansResult.rows,
      reset_requests: appealsResult.rows
    });
  } catch (err) {
    console.error('Error fetching banned clients:', err);
    res.status(500).json({ error: 'Failed to retrieve banned accounts list.' });
  }
});

// Unban a student account
app.post('/api/unban', checkAdminPin, async (req, res) => {
  const { clientId } = req.body;

  try {
    await db.execute({
      sql: 'DELETE FROM banned_clients WHERE client_id = ?',
      args: [clientId]
    });
    await db.execute({
      sql: 'DELETE FROM reset_requests WHERE client_id = ?',
      args: [clientId]
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Error unbanning client:', err);
    res.status(500).json({ error: 'Failed to unban student.' });
  }
});

// Reset PIN for a student
app.post('/api/admin/reset-pin', checkAdminPin, async (req, res) => {
  const { admission_number } = req.body;

  try {
    await db.execute({
      sql: 'DELETE FROM reset_requests WHERE client_id = ?',
      args: [admission_number]
    });

    res.json({ success: true, message: `PIN reset flag issued for ${admission_number}` });
  } catch (err) {
    console.error('Error resetting PIN:', err);
    res.status(500).json({ error: 'Failed to execute PIN reset.' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
});