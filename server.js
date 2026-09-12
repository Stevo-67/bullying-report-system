const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234'; // Default admin PIN

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-Memory Database Storage (Replace with Turso/SQLite queries if needed)
let students = []; // Format: { admission_number, pin_hash, status: 'active'|'banned', warning: null }
let reports = [];  // Format: { id, admission_number, category, urgency, description, status, timestamp }
let appeals = [];  // Format: { admission_number, reason, timestamp }

// SSE Clients List for Live Audio/Desktop Notifications
let sseClients = [];

// Middleware: Admin PIN Verification
function verifyAdminPin(req, res, next) {
  const pin = req.headers['x-admin-pin'];
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Admin PIN' });
  }
  next();
}

// ----------------------------------------------------
// 1. SSE LIVE EVENT FEED
// ----------------------------------------------------
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

function broadcastNewReport(report) {
  sseClients.forEach(client => {
    client.write(`data: ${JSON.stringify(report)}\n\n`);
  });
}

// ----------------------------------------------------
// 2. STUDENT AUTH & STATUS ROUTE
// ----------------------------------------------------
app.get('/api/client-status/:admNo', (req, res) => {
  const cleanAdm = req.params.admNo.trim().toUpperCase();
  const student = students.find(s => s.admission_number === cleanAdm);

  if (!student) {
    return res.json({ status: 'clean' });
  }

  if (student.status === 'banned') {
    return res.json({ status: 'cooldown' });
  }

  if (student.warning) {
    return res.json({ status: 'warned', message: student.warning });
  }

  res.json({ status: 'clean' });
});

app.post('/api/student/auth', async (req, res) => {
  const { admission_number, pin } = req.body;

  if (!admission_number || !pin) {
    return res.status(400).json({ error: 'Admission Number and PIN are required.' });
  }

  const cleanAdm = admission_number.trim().toUpperCase();
  let student = students.find(s => s.admission_number === cleanAdm);

  // FIRST-TIME USER: Create account & set PIN
  if (!student) {
    const pin_hash = await bcrypt.hash(pin, 10);
    student = { admission_number: cleanAdm, pin_hash, status: 'active', warning: null };
    students.push(student);
    return res.json({ success: true, message: 'Account PIN set successfully.' });
  }

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
});

// ----------------------------------------------------
// 3. STUDENT REPORT & APPEAL SUBMISSION
// ----------------------------------------------------
app.post('/api/reports', (req, res) => {
  const { admission_number, category, description, urgency } = req.body;
  const cleanAdm = (admission_number || '').trim().toUpperCase();

  const student = students.find(s => s.admission_number === cleanAdm);

  if (!student || student.status === 'banned') {
    return res.status(403).json({ error: 'Submission denied. Account is restricted or unverified.' });
  }

  const newReport = {
    id: reports.length + 1,
    admission_number: cleanAdm,
    student_name: cleanAdm,
    category,
    description,
    urgency,
    status: 'Pending',
    timestamp: new Date().toISOString()
  };

  reports.push(newReport);

  // Trigger real-time sound/desktop notification in admin panel
  broadcastNewReport(newReport);

  res.json({ success: true, message: 'Report submitted successfully.' });
});

app.post('/api/request-reset', (req, res) => {
  const { clientId, reason } = req.body; // clientId maps to Admission Number
  const cleanAdm = (clientId || '').trim().toUpperCase();

  if (!reason) {
    return res.status(400).json({ error: 'Appeal reason is required.' });
  }

  const existing = appeals.find(a => a.admission_number === cleanAdm);
  if (existing) {
    existing.reason = reason;
    existing.timestamp = new Date().toISOString();
  } else {
    appeals.push({ admission_number: cleanAdm, reason, timestamp: new Date().toISOString() });
  }

  res.json({ success: true, message: 'Appeal submitted to counselors.' });
});

// ----------------------------------------------------
// 4. ADMIN DASHBOARD ROUTING
// ----------------------------------------------------
app.get('/api/reports', verifyAdminPin, (req, res) => {
  res.json(reports);
});

app.get('/api/banned-clients', verifyAdminPin, (req, res) => {
  const bannedStudents = students.filter(s => s.status === 'banned').map(s => ({
    client_id: s.admission_number,
    ban_type: 'Account Ban',
    timestamp: new Date().toISOString()
  }));

  const resetRequests = appeals.map(a => ({
    client_id: a.admission_number,
    reason: a.reason
  }));

  res.json({ bans: bannedStudents, reset_requests: resetRequests });
});

app.patch('/api/reports/:id', verifyAdminPin, (req, res) => {
  const report = reports.find(r => r.id === parseInt(req.params.id));
  if (report) {
    report.status = req.body.status;
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Report not found' });
});

app.post('/api/reports/:id/warn', verifyAdminPin, (req, res) => {
  const report = reports.find(r => r.id === parseInt(req.params.id));
  if (report) {
    const student = students.find(s => s.admission_number === report.admission_number);
    if (student) student.warning = req.body.message;
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Report not found' });
});

app.post('/api/reports/:id/ban', verifyAdminPin, (req, res) => {
  const report = reports.find(r => r.id === parseInt(req.params.id));
  if (report) {
    let student = students.find(s => s.admission_number === report.admission_number);
    if (student) student.status = 'banned';
    return res.json({ success: true });
  }
  res.status(404).json({ error: 'Report not found' });
});

app.post('/api/admin/reset-pin', verifyAdminPin, (req, res) => {
  const cleanAdm = (req.body.admission_number || '').trim().toUpperCase();
  const index = students.findIndex(s => s.admission_number === cleanAdm);

  if (index !== -1) {
    students.splice(index, 1);
    return res.json({ success: true, message: `PIN reset for ${cleanAdm}.` });
  }
  res.status(404).json({ error: 'Student record not found.' });
});

app.post('/api/unban', verifyAdminPin, (req, res) => {
  const cleanAdm = (req.body.clientId || '').trim().toUpperCase();
  const student = students.find(s => s.admission_number === cleanAdm);

  if (student) {
    student.status = 'active';
  }
  appeals = appeals.filter(a => a.admission_number !== cleanAdm);

  res.json({ success: true, message: `Account ${cleanAdm} unbanned.` });
});

app.delete('/api/reports/:id', verifyAdminPin, (req, res) => {
  reports = reports.filter(r => r.id !== parseInt(req.params.id));
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});