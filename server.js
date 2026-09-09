const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;


// Middleware configuration
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to SQLite Database (Creates 'reports.db' automatically if missing)
const db = new sqlite3.Database('./reports.db', (err) => {
    if (err) {
        console.error('Database connection error:', err.message);
    } else {
        console.log('Connected to SQLite database.');
    }
});

// Create 'reports' table if it does not exist
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            student_name TEXT DEFAULT 'Anonymous',
            is_anonymous INTEGER NOT NULL,
            urgency TEXT DEFAULT 'Medium',
            status TEXT DEFAULT 'Pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// API Endpoint: Submit a new report (Student Page)
app.post('/api/reports', (req, res) => {
    const { content, student_name, is_anonymous, urgency } = req.body;

    if (!content || content.trim() === "") {
        return res.status(400).json({ error: "Report description cannot be empty." });
    }

    const anonymousFlag = is_anonymous ? 1 : 0;
    const finalName = anonymousFlag ? "Anonymous" : (student_name ? student_name.trim() : "Anonymous");

    const sql = `INSERT INTO reports (content, student_name, is_anonymous, urgency) VALUES (?, ?, ?, ?)`;
    
    db.run(sql, [content, finalName, anonymousFlag, urgency || 'Medium'], function (err) {
        if (err) {
            console.error(err.message);
            return res.status(500).json({ error: "Failed to save report to database." });
        }
        res.json({ success: true, message: "Report submitted successfully.", reportId: this.lastID });
    });
});

// API Endpoint: Retrieve all reports (Counselor Dashboard)
app.get('/api/reports', (req, res) => {
    const sql = `SELECT * FROM reports ORDER BY created_at DESC`;
    db.all(sql, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
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