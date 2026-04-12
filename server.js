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
    grade INTEGER DEFAULT NULL,
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
  CREATE TABLE IF NOT EXISTS student_attempts (
    ip TEXT PRIMARY KEY,
    attempts INTEGER DEFAULT 1,
    blocked_until INTEGER DEFAULT 0,
    last_attempt INTEGER NOT NULL
  );
`);

// Add grade column if upgrading from old DB
try { db.exec('ALTER TABLE students ADD COLUMN grade INTEGER DEFAULT NULL'); } catch(e) {}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting ─────────────────────────────────────────────
const MAX_ATTEMPTS = 5;
const BLOCK_MINUTES = 15;

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function checkRateLimit(ip) {
  const now = Date.now();
  const row = db.prepare('SELECT * FROM student_attempts WHERE ip = ?').get(ip);
  if (!row) return { allowed: true };
  if (row.blocked_until > now) {
    return { allowed: false, minutesLeft: Math.ceil((row.blocked_until - now) / 60000) };
  }
  if (now - row.last_attempt > 60 * 60 * 1000) {
    db.prepare('DELETE FROM student_attempts WHERE ip = ?').run(ip);
    return { allowed: true };
  }
  return { allowed: true, attempts: row.attempts };
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const row = db.prepare('SELECT * FROM student_attempts WHERE ip = ?').get(ip);
  if (!row) {
    db.prepare('INSERT INTO student_attempts (ip, attempts, last_attempt) VALUES (?, 1, ?)').run(ip, now);
    return { attempts: 1, blocked: false };
  }
  const newAttempts = row.attempts + 1;
  let blockedUntil = 0, blocked = false;
  if (newAttempts >= MAX_ATTEMPTS) { blockedUntil = now + BLOCK_MINUTES * 60 * 1000; blocked = true; }
  db.prepare('UPDATE student_attempts SET attempts=?, blocked_until=?, last_attempt=? WHERE ip=?').run(newAttempts, blockedUntil, now, ip);
  return { attempts: newAttempts, blocked, minutesLeft: BLOCK_MINUTES };
}

function clearAttempts(ip) {
  db.prepare('DELETE FROM student_attempts WHERE ip = ?').run(ip);
}

// ── Auth ──────────────────────────────────────────────────────
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
  if (!isValidSession(req.headers['x-session-token'])) return res.status(401).json({ error: 'לא מורשה' });
  next();
}

// ── Teacher login ─────────────────────────────────────────────
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

// ── Students ──────────────────────────────────────────────────
function buildKey(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return null;
  return `${parts[0]}.${parts[parts.length - 1][0]}`.toLowerCase();
}

app.get('/api/students', auth, (req, res) => {
  res.json(db.prepare('SELECT id, name, lookup_key, last3, grade FROM students ORDER BY created_at DESC').all());
});

app.post('/api/students', auth, (req, res) => {
  const { name, last3, grade } = req.body;
  if (!name) return res.status(400).json({ error: 'חסר שם' });
  if (!last3 || !/^\d{3}$/.test(last3)) return res.status(400).json({ error: 'נא להזין 3 ספרות אחרונות של תז' });
  const key = buildKey(name);
  if (!key) return res.status(400).json({ error: 'נא להזין שם פרטי ושם משפחה' });
  let gradeVal = null;
  if (grade !== null && grade !== undefined && grade !== '') {
    gradeVal = parseInt(grade);
    if (isNaN(gradeVal) || gradeVal < 0 || gradeVal > 100) return res.status(400).json({ error: 'ציון חייב להיות בין 0 ל-100' });
  }
  try {
    db.prepare('INSERT INTO students (name, lookup_key, last3, grade) VALUES (?, ?, ?, ?)').run(name.trim(), key, last3, gradeVal);
    res.json({ ok: true, lookup_key: key });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'תלמיד עם שם זה כבר קיים' });
    res.status(500).json({ error: 'שגיאה בשרת' });
  }
});

// Update grade
app.patch('/api/students/:id/grade', auth, (req, res) => {
  const grade = req.body.grade;
  if (grade === null || grade === undefined || grade === '') {
    db.prepare('UPDATE students SET grade = NULL WHERE id = ?').run(req.params.id);
    return res.json({ ok: true });
  }
  const g = parseInt(grade);
  if (isNaN(g) || g < 0 || g > 100) return res.status(400).json({ error: 'ציון חייב להיות בין 0 ל-100' });
  const result = db.prepare('UPDATE students SET grade = ? WHERE id = ?').run(g, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'לא נמצא' });
  res.json({ ok: true });
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

// ── Student grade lookup ──────────────────────────────────────
app.post('/api/grade', (req, res) => {
  const ip    = getClientIp(req);
  const key   = (req.body.key   || '').toLowerCase().trim();
  const last3 = (req.body.last3 || '').trim();

  const limit = checkRateLimit(ip);
  if (!limit.allowed) return res.status(429).json({ error: `יותר מדי ניסיונות. נסה שוב בעוד ${limit.minutesLeft} דקות` });

  if (!key)                   return res.status(400).json({ error: 'חסר מפתח כניסה' });
  if (!/^\d{3}$/.test(last3)) return res.status(400).json({ error: 'נא להזין 3 ספרות בדיוק' });

  const row = db.prepare('SELECT name, last3, grade FROM students WHERE lookup_key = ?').get(key);

  if (!row || row.last3 !== last3) {
    const result = recordFailedAttempt(ip);
    const remaining = MAX_ATTEMPTS - result.attempts;
    if (result.blocked) return res.status(429).json({ error: `יותר מדי ניסיונות. נסה שוב בעוד ${result.minutesLeft} דקות` });
    const errorMsg = !row
      ? `לא נמצא — בדוק שם פרטי ואות ראשונה של שם משפחה (נותרו ${remaining} ניסיונות)`
      : `הספרות האחרונות של הת"ז אינן נכונות (נותרו ${remaining} ניסיונות)`;
    return res.status(401).json({ error: errorMsg });
  }

  clearAttempts(ip);
  res.json({ name: row.name, grade: row.grade });
});

// ── Pages ─────────────────────────────────────────────────────
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get('/login',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
