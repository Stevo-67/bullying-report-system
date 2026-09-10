const express = require('express');
const { createClient } = require('@libsql/client');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Turso Client
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || '',
  authToken: process.env.TURSO_AUTH_TOKEN || '',
});

// Initialize Database Table
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
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Safely apply schema upgrades for existing tables
    try {
      await db.execute(`ALTER TABLE reports ADD COLUMN status TEXT DEFAULT 'Pending'`);
    } catch (e) {}

    try {
      await db.execute(`ALTER TABLE reports ADD COLUMN student_name TEXT DEFAULT 'Anonymous'`);
    } catch (e) {}

    try {
      await db.execute(`ALTER TABLE reports ADD COLUMN urgency TEXT DEFAULT 'Medium'`);
    } catch (e) {}

  } catch (err) {
    console.error('Database initialization error:', err);
  }
}
initDB();

// GET all reports
app.get('/api/reports', async (req, res) => {
  try {
    const result = await db.execute('SELECT * FROM reports ORDER BY id DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ error: 'Failed to fetch reports' });
  }
});

// POST a new report (handles student_name, category, description, urgency)
app.post('/api/reports', async (req, res) => {
  try {
    const student_name = 
      req.body.student_name || 
      req.body.student || 
      req.body.name || 
      req.body.author || 
      'Anonymous';

    const category = req.body.category || req.body.type || 'General';
    
    const description = 
      req.body.description || 
      req.body.content || 
      req.body.details || 
      req.body.message || 
      req.body.text || 
      'No description provided';

    const urgency = 
      req.body.urgency || 
      req.body.priority || 
      req.body.level || 
      'Medium';

    await db.execute({
      sql: 'INSERT INTO reports (category, description, status, student_name, urgency) VALUES (?, ?, ?, ?, ?)',
      args: [String(category), String(description), 'Pending', String(student_name), String(urgency)]
    });

    res.json({ success: true, message: 'Report submitted successfully' });
  } catch (error) {
    console.error('Error saving report:', error);
    res.status(500).json({ error: 'Failed to submit report' });
  }
});

// PATCH update status
app.patch('/api/reports/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    await db.execute({
      sql: 'UPDATE reports SET status = ? WHERE id = ?',
      args: [status || 'Pending', id]
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});