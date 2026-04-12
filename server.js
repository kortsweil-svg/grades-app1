const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Database setup ---
const db = new Database('./grades.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API Routes ---

// Get all students (teacher)
app.get('/api/students', (req, res) => {
  const rows = db.prepare('SELECT id, name, created_at FROM students ORDER BY created_at DESC').all();
  res.json(rows);
});

// Add student
app.post('/api/students', (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'חסרים שדות' });
  if (!/^\d{5,9}$/.test(id)) return res.status(400).json({ error: 'תז לא תקינה' });
  try {
    db.prepare('INSERT INTO students (id, name) VALUES (?, ?)').run(id.trim(), name.trim());
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'תז זו כבר קיימת במערכת' });
    res.status(500).json({ error: 'שגיאה בשרת' });
  }
});

// Delete student
app.delete('/api/students/:id', (req, res) => {
  const result = db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'לא נמצא' });
  res.json({ ok: true });
});

// Delete all students
app.delete('/api/students', (req, res) => {
  db.prepare('DELETE FROM students').run();
  res.json({ ok: true });
});

// Student lookup by ID
app.get('/api/grade/:id', (req, res) => {
  const row = db.prepare('SELECT id, name FROM students WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'לא נמצא תלמיד עם תז זו' });
  res.json({ name: row.name, status: 'נכשל' });
});

// Serve pages
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
