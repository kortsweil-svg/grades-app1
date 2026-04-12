const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database('./grades.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    lookup_key TEXT NOT NULL UNIQUE,
    last3 TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS teacher_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    id_number TEXT NOT NULL,
    phone TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS teacher_sessions (
    token TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + 8 * 60 * 60 * 1000;
  db.prepare('INSERT OR REPLACE INTO teacher_sessions (token, expires_at) VALUES (?, ?)').run(token, expires);
  db.prepare('DELETE FROM teacher_sessions WHERE expires_at < ?').run(Date.now());
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  return !!db.prepare('SELECT 1 FROM teacher_sessions WHERE token = ? AND expires_at > ?').get(token, Date.now());
}

function auth(req, res, next) {
  if (!isValidSession(req.headers['x-session-token']))
    return res.status(401).json({ error: 'לא מורשה' });
  next();
}

app.post('/api/teacher/login', (req, res) => {
  const id_number = (req.body.id_number || '').trim().replace(/\D/g, '');
  const phone     = (req.body.phone     || '').trim().replace(/\D/g, '');
  if (!id_number || id_number.length < 5) return res.status(400).json({ error: 'נא להזין תז תקינה' });
  if (!phone     || phone.length < 9)     return res.status(400).json({ error: 'נא להזין מספר טלפון תקין' });

  const creds = db.prepare('SELECT * FROM teacher_credentials WHERE id = 1').get();
  if (!creds) {
    db.prepare('INSERT INTO teacher_credentials (id, id_number, phone) VALUES (1, ?, ?)').run(id_number, phone);
    return res.json({ ok: true, token: createSession(), first_time: true });
  }
  if (creds.id_number !== id_number || creds.phone !== phone)
    return res.status(401).json({ error: 'תז או טלפון שגויים' });
  res.json({ ok: true, token: createSession() });
});

app.post('/api/teacher/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) db.prepare('DELETE FROM teacher_sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

app.get('/api/teacher/check', (req, res) => {
  res.json({ valid: isValidSession(req.headers['x-session-token']) });
});

function buildKey(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return `${parts[0]}.${parts[parts.length - 1][0]}`.toLowerCase();
}

app.get('/api/students', auth, (req, res) => {
  res.json(db.prepare('SELECT id, name, lookup_key, last3 FROM students ORDER BY created_at DESC').all());
});

app.post('/api/students', auth, (req, res) => {
  const { name, last3 } = req.body;
  if (!name) return res.status(400).json({ error: 'חסר שם' });
  if (!last3 || !/^\d{3}$/.test(last3)) return res.status(400).json({ error: 'נא להזין 3 ספרות אחרונות של תז' });
  const key = buildKey(name);
  if (!key) return res.status(400).json({ error: 'נא להזין שם פרטי ושם משפחה' });
  try {
    db.prepare('INSERT INTO students (name, lookup_key, last3) VALUES (?, ?, ?)').run(name.trim(), key, last3);
    res.json({ ok: true, lookup_key: key });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'תלמיד עם שם זה כבר קיים' });
    res.status(500).json({ error: 'שגיאה בשרת' });
  }
});

app.delete('/api/students/:id', auth, (req, res) => {
  const result = db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'לא נמצא' });
  res.json({ ok: true });
});

app.delete('/api/students', auth, (req, res) => {
  db.prepare('DELETE FROM students').run();
  res.json({ ok: true });
});

app.post('/api/grade', (req, res) => {
  const key   = (req.body.key   || '').toLowerCase().trim();
  const last3 = (req.body.last3 || '').trim();
  if (!key)                   return res.status(400).json({ error: 'חסר מפתח כניסה' });
  if (!/^\d{3}$/.test(last3)) return res.status(400).json({ error: 'נא להזין 3 ספרות בדיוק' });
  const row = db.prepare('SELECT name, last3 FROM students WHERE lookup_key = ?').get(key);
  if (!row)              return res.status(404).json({ error: 'לא נמצא — בדוק שם פרטי ואות ראשונה של שם משפחה' });
  if (row.last3 !== last3) return res.status(401).json({ error: 'הספרות האחרונות של הת"ז אינן נכונות' });
  res.json({ name: row.name });
});

app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get('/login',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
