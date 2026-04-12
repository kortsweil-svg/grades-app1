# מערכת ציונים 📋

אפליקציית ציונים עם שרת Node.js ובסיס נתונים SQLite.

## העלאה ל-Glitch (5 דקות)

### שלב 1 — צור פרויקט חדש
1. כנס לאתר **glitch.com**
2. לחץ **New Project** ← **Import from GitHub** או **hello-node**

### שלב 2 — העלה את הקבצים
**אפשרות א׳ — גרור קבצים:**
1. פתח את ה-Files panel בצד שמאל
2. גרור את הקבצים הבאים:
   - `server.js`
   - `package.json`
   - תיקיית `public/` (עם `index.html` ו-`student.html`)

**אפשרות ב׳ — GitHub:**
1. העלה את הקבצים לריפו ב-GitHub
2. ב-Glitch: **New Project** ← **Import from GitHub**

### שלב 3 — הפעלה
Glitch מריץ `npm install` ו-`npm start` אוטומטית.

### שלב 4 — קבל את הקישורים
- **מורה:** `https://your-project.glitch.me/`
- **תלמידים:** `https://your-project.glitch.me/student`

---

## העלאה ל-Replit

1. כנס לאתר **replit.com** ← **Create Repl** ← **Node.js**
2. העלה את כל הקבצים
3. לחץ **Run**
4. הקישורים יופיעו בחלון ה-Webview

---

## מבנה הפרויקט

```
grades-app/
├── server.js          ← שרת Express + SQLite
├── package.json       ← תלויות
└── public/
    ├── index.html     ← ממשק מורה
    └── student.html   ← ממשק תלמיד
```

## API

| Method | Path | תיאור |
|--------|------|-------|
| GET | /api/students | כל התלמידים |
| POST | /api/students | הוסף תלמיד |
| DELETE | /api/students/:id | מחק תלמיד |
| DELETE | /api/students | מחק הכל |
| GET | /api/grade/:id | בדיקת ציון לפי תז |
