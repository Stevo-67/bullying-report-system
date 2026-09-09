const express = require('express');
// NEW WAY:
const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});
// Function that runs when server starts
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      description TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

// Execute the function and log any connection errors
initDB().catch(console.error);
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;


// Middleware configuration
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ✅ PASTE THIS TURSO BLOCK:
async function initDB() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      description TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
initDB().catch(console.error);

// Submit a new report to Turso
app.post('/api/reports', async (req, res) => {
  try {
    const { category, description } = req.body;

    await db.execute({
      sql: 'INSERT INTO reports (category, description) VALUES (?, ?)',
      args: [category, description]
    });

    res.json({ success: true, message: 'Report submitted successfully' });
  } catch (error) {
    console.error('Error saving report:', error);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// Fetch all reports for the admin page
app.get('/api/reports', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM reports ORDER BY id DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});


// API Endpoint: Update report status (Counselor Dashboard)
app.patch('/api/reports/:id', (req, res) => {
    const { status } = req.body;
    const sql = `UPDATE reports SET status = ? WHERE id = ?`;

    db.run(sql, [status, req.params.id], function (err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: "Status updated." });
    });
});

// Start the Web Server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});