const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      lookup_key TEXT NOT NULL UNIQUE,
      last3 TEXT NOT NULL,
      grade INTEGER DEFAULT NULL,
      grade_updated_at TIMESTAMPTZ DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE students ADD COLUMN IF NOT EXISTS grade_updated_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS class_name TEXT DEFAULT NULL;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS grade_level TEXT DEFAULT NULL;
    CREATE TABLE IF NOT EXISTS teacher_credentials (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      id_number TEXT NOT NULL,
      phone TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS teacher_sessions (
      token TEXT PRIMARY KEY,
      expires_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS student_attempts (
      ip TEXT PRIMARY KEY,
      attempts INTEGER DEFAULT 1,
      blocked_until BIGINT DEFAULT 0,
      last_attempt BIGINT NOT NULL
    );
  `);
  console.log('DB ready');
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting ─────────────────────────────────────────────
const MAX_ATTEMPTS = 5;
const BLOCK_MINUTES = 15;

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

async function checkRateLimit(ip) {
  const now = Date.now();
  const { rows } = await pool.query('SELECT * FROM student_attempts WHERE ip = $1', [ip]);
  if (!rows.length) return { allowed: true };
  const row = rows[0];
  if (row.blocked_until > now) return { allowed: false, minutesLeft: Math.ceil((row.blocked_until - now) / 60000) };
  if (now - row.last_attempt > 60 * 60 * 1000) {
    await pool.query('DELETE FROM student_attempts WHERE ip = $1', [ip]);
    return { allowed: true };
  }
  return { allowed: true, attempts: row.attempts };
}

async function recordFailedAttempt(ip) {
  const now = Date.now();
  const { rows } = await pool.query('SELECT * FROM student_attempts WHERE ip = $1', [ip]);
  if (!rows.length) {
    await pool.query('INSERT INTO student_attempts (ip, attempts, last_attempt) VALUES ($1, 1, $2)', [ip, now]);
    return { attempts: 1, blocked: false };
  }
  const newAttempts = rows[0].attempts + 1;
  let blockedUntil = 0, blocked = false;
  if (newAttempts >= MAX_ATTEMPTS) { blockedUntil = now + BLOCK_MINUTES * 60 * 1000; blocked = true; }
  await pool.query('UPDATE student_attempts SET attempts=$1, blocked_until=$2, last_attempt=$3 WHERE ip=$4',
    [newAttempts, blockedUntil, now, ip]);
  return { attempts: newAttempts, blocked, minutesLeft: BLOCK_MINUTES };
}

async function clearAttempts(ip) {
  await pool.query('DELETE FROM student_attempts WHERE ip = $1', [ip]);
}

// ── Auth ──────────────────────────────────────────────────────
function createToken() { return crypto.randomBytes(32).toString('hex'); }

async function createSession() {
  const token = createToken();
  const expires = Date.now() + 8 * 60 * 60 * 1000;
  await pool.query('INSERT INTO teacher_sessions (token, expires_at) VALUES ($1, $2) ON CONFLICT (token) DO UPDATE SET expires_at=$2', [token, expires]);
  await pool.query('DELETE FROM teacher_sessions WHERE expires_at < $1', [Date.now()]);
  return token;
}

async function isValidSession(token) {
  if (!token) return false;
  const { rows } = await pool.query('SELECT 1 FROM teacher_sessions WHERE token=$1 AND expires_at>$2', [token, Date.now()]);
  return rows.length > 0;
}

async function auth(req, res, next) {
  if (!await isValidSession(req.headers['x-session-token'])) return res.status(401).json({ error: 'לא מורשה' });
  next();
}

// ── Teacher login ─────────────────────────────────────────────
app.post('/api/teacher/login', async (req, res) => {
  try {
    const id_number = (req.body.id_number || '').trim().replace(/\D/g, '');
    const phone     = (req.body.phone     || '').trim().replace(/\D/g, '');
    if (!id_number || id_number.length < 5) return res.status(400).json({ error: 'נא להזין תז תקינה' });
    if (!phone     || phone.length < 9)     return res.status(400).json({ error: 'נא להזין מספר טלפון תקין' });
    const { rows } = await pool.query('SELECT * FROM teacher_credentials WHERE id = 1');
    if (!rows.length) {
      await pool.query('INSERT INTO teacher_credentials (id, id_number, phone) VALUES (1, $1, $2)', [id_number, phone]);
      return res.json({ ok: true, token: await createSession(), first_time: true });
    }
    if (rows[0].id_number !== id_number || rows[0].phone !== phone)
      return res.status(401).json({ error: 'תז או טלפון שגויים' });
    res.json({ ok: true, token: await createSession() });
  } catch(e) { res.status(500).json({ error: 'שגיאה בשרת' }); }
});

app.post('/api/teacher/logout', async (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) await pool.query('DELETE FROM teacher_sessions WHERE token=$1', [token]);
  res.json({ ok: true });
});

app.get('/api/teacher/check', async (req, res) => {
  res.json({ valid: await isValidSession(req.headers['x-session-token']) });
});

// ── Students ──────────────────────────────────────────────────
function buildKey(fullName, last3) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 1) return null;
  // שם משפחה (ראשון) + 3 ספרות אחרונות של תז
  return `${parts[0]}${last3}`.toLowerCase();
}

app.get('/api/students', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, lookup_key, last3, grade, class_name, grade_level, grade_updated_at FROM students ORDER BY created_at DESC');
    res.json(rows);
  } catch(e) { res.status(500).json({ error: 'שגיאה' }); }
});

app.post('/api/students', auth, async (req, res) => {
  try {
    const { name, last3, grade, class_name, grade_level } = req.body;
    if (!name) return res.status(400).json({ error: 'חסר שם' });
    if (!last3 || !/^\d{3}$/.test(last3)) return res.status(400).json({ error: 'נא להזין 3 ספרות אחרונות של תז' });
    const key = buildKey(name, last3);
    if (!key) return res.status(400).json({ error: 'נא להזין שם פרטי ושם משפחה' });
    let gradeVal = null;
    if (grade !== null && grade !== undefined && grade !== '') {
      gradeVal = parseInt(grade);
      if (isNaN(gradeVal) || gradeVal < 0 || gradeVal > 100) return res.status(400).json({ error: 'ציון חייב להיות בין 0 ל-100' });
    }
    await pool.query('INSERT INTO students (name, lookup_key, last3, grade, class_name, grade_level) VALUES ($1, $2, $3, $4, $5, $6)', [name.trim(), key, last3, gradeVal, class_name||null, grade_level||null]);
    res.json({ ok: true, lookup_key: key });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'תלמיד עם שם זה כבר קיים' });
    res.status(500).json({ error: 'שגיאה בשרת' });
  }
});

app.patch('/api/students/:id/grade', auth, async (req, res) => {
  try {
    const grade = req.body.grade;
    if (grade === null || grade === undefined || grade === '') {
      await pool.query('UPDATE students SET grade = NULL, grade_updated_at = NULL WHERE id = $1', [req.params.id]);
      return res.json({ ok: true });
    }
    const g = parseInt(grade);
    if (isNaN(g) || g < 0 || g > 100) return res.status(400).json({ error: 'ציון חייב להיות בין 0 ל-100' });
    const { rowCount } = await pool.query('UPDATE students SET grade = $1, grade_updated_at = NOW() WHERE id = $2', [g, req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'לא נמצא' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'שגיאה' }); }
});

app.delete('/api/students/:id', auth, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM students WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'לא נמצא' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'שגיאה' }); }
});

app.delete('/api/students', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM students');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: 'שגיאה' }); }
});

// ── Student grade lookup ──────────────────────────────────────
app.post('/api/grade', async (req, res) => {
  try {
    const ip  = getClientIp(req);
    const key = (req.body.key || '').toLowerCase().trim();
    const limit = await checkRateLimit(ip);
    if (!limit.allowed) return res.status(429).json({ error: `יותר מדי ניסיונות. נסה שוב בעוד ${limit.minutesLeft} דקות` });
    if (!key || key.length < 4) return res.status(400).json({ error: 'נא להזין שם משפחה + 3 ספרות ת"ז' });
    const { rows } = await pool.query('SELECT name, grade, grade_updated_at FROM students WHERE lookup_key = $1', [key]);
    if (!rows.length) {
      const result = await recordFailedAttempt(ip);
      const remaining = MAX_ATTEMPTS - result.attempts;
      if (result.blocked) return res.status(429).json({ error: `יותר מדי ניסיונות. נסה שוב בעוד ${result.minutesLeft} דקות` });
      return res.status(401).json({ error: `לא נמצא — בדוק שם משפחה ו-3 ספרות ת"ז (נותרו ${remaining} ניסיונות)` });
    }
    await clearAttempts(ip);
    res.json({ name: rows[0].name, grade: rows[0].grade, grade_updated_at: rows[0].grade_updated_at });
  } catch(e) { res.status(500).json({ error: 'שגיאה בשרת' }); }
});

// ── Pages ─────────────────────────────────────────────────────
app.get('/student', (req, res) => res.sendFile(path.join(__dirname, 'public', 'student.html')));
app.get('/login',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB().then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)));
