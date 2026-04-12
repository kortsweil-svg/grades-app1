const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database('./grades.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    lookup_key TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function buildKey(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const first = parts[0];
  const lastInitial = parts[parts.length - 1][0];
  return `${first}.${lastInitial}`.toLowerCase();
}

app.get('/api/students', (req, res) => {
  const rows = db.prepare('SELECT id, name, lookup_key, created_at FROM students ORDER BY created_at DESC').all();
  res.json(rows);
});

app.post('/api/students', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'חסר שם' });
  const key = buildKey(name);
  if (!key) return res.status(400).json({ error: 'נא להזין שם פרטי ושם משפחה' });
  try {
    db.prepare('INSERT INTO students (name, lookup_key) VALUES (?, ?)').run(name.trim(), key);
    res.json({ ok: true, lookup_key: key });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'תלמיד עם שם זה כבר קיים' });
    res.status(500).json({ error: 'שגיאה בשרת' });
  }
});

app.delete('/api/students/:id', (req, res) => {
  const result = db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'לא נמצא' });
  res.json({ ok: true });
});

app.delete('/api/students', (req, res) => {
  db.prepare('DELETE FROM students').run();
  res.json({ ok: true });
});

app.get('/api/grade/:key', (req, res) => {
  const key = req.params.key.toLowerCase().trim();
  const row = db.prepare('SELECT name FROM students WHERE lookup_key = ?').get(key);
  if (!row) return res.status(404).json({ error: 'לא נמצא תלמיד — בדוק שם פרטי ואות ראשונה של שם משפחה' });
  res.json({ name: row.name, status: 'נכשל' });
});

app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
