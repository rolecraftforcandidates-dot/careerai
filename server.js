require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const helmet     = require('helmet');
const cors       = require('cors');
const path       = require('path');
const { google } = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security middleware ──
app.use(helmet({ contentSecurityPolicy: false })); // CSP off so dashboard JS works
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Trust Railway's proxy (required for secure cookies on HTTPS) ──
app.set('trust proxy', 1);

// ── Session ──
app.use(session({
  secret: process.env.SESSION_SECRET || 'careerai-dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000   // 7 days
  }
}));

// ── Google Sheets client ──
function getSheetsClient() {
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing or invalid in .env');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

const SHEET_ID = process.env.SHEET_ID;

// ── Helper: read a tab ──
async function readSheet(tabName) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A:Z`,
  });
  const [headers, ...rows] = res.data.values || [];
  if (!headers) return [];
  return rows.map(row =>
    Object.fromEntries(headers.map((h, i) => [h.trim(), (row[i] || '').trim()]))
  );
}

// ── Helper: write a single cell ──
async function writeCell(tabName, rowIndex, colIndex, value) {
  const sheets = getSheetsClient();
  const col    = String.fromCharCode(65 + colIndex); // 0→A, 1→B ...
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!${col}${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  });
}

// ── Helper: append a row ──
async function appendRow(tabName, values) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A:A`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] },
  });
}

// ── Auth middleware ──
function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// ════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════

// POST /api/login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const users = await readSheet('Users');
    const user  = users.find(u => u.Email.toLowerCase() === email.toLowerCase().trim());

    if (!user)
      return res.status(401).json({ error: 'No account found with this email' });

    if (user['Plan Active'] !== 'TRUE')
      return res.status(403).json({ error: 'Your account is not active. Please complete payment first.' });

    // Simple password check (plain text — upgrade to bcrypt if desired)
    if (user.Password !== password)
      return res.status(401).json({ error: 'Incorrect password' });

    // Store session
    req.session.user = {
      email:      user.Email,
      name:       user.Name,
      role:       user.Role,
      experience: user.Experience,
      week:       parseInt(user.Week) || 1,
    };

    res.json({ success: true, user: req.session.user });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// GET /api/debug — diagnose env vars and Sheets connection (remove after go-live)
app.get('/api/debug', async (req, res) => {
  const info = {
    hasSheetId:   !!process.env.SHEET_ID,
    sheetIdValue: process.env.SHEET_ID ? process.env.SHEET_ID.slice(0,10)+'...' : 'MISSING',
    hasJson:      !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    jsonLength:   process.env.GOOGLE_SERVICE_ACCOUNT_JSON ? process.env.GOOGLE_SERVICE_ACCOUNT_JSON.length : 0,
    jsonParses:   false,
    clientEmail:  null,
    sheetsConnects: false,
    usersCount:   null,
    error:        null,
  };
  try {
    const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    info.jsonParses  = true;
    info.clientEmail = parsed.client_email || 'not found';
  } catch(e) {
    info.error = 'JSON parse failed: ' + e.message;
    return res.json(info);
  }
  try {
    const users = await readSheet('Users');
    info.sheetsConnects = true;
    info.usersCount = users.length;
  } catch(e) {
    info.error = 'Sheets connection failed: ' + e.message;
  }
  res.json(info);
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// GET /api/me — check session
app.get('/api/me', requireLogin, (req, res) => {
  res.json({ user: req.session.user });
});

// ════════════════════════════════════════
// DATA ROUTES (all require login)
// ════════════════════════════════════════

// GET /api/plan — logged-in user's 4-week plan
app.get('/api/plan', requireLogin, async (req, res) => {
  try {
    const email = req.session.user.email;
    const rows  = await readSheet('Plans');
    const plan  = rows
      .filter(r => r.Email.toLowerCase() === email.toLowerCase())
      .sort((a, b) => (parseInt(a.Week)||0) - (parseInt(b.Week)||0) || (parseInt(a.Day)||0) - (parseInt(b.Day)||0));
    res.json({ plan });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load plan' });
  }
});

// GET /api/questions — current week's questions for logged-in user
app.get('/api/questions', requireLogin, async (req, res) => {
  try {
    const { email, week } = req.session.user;
    const rows = await readSheet('Questions');
    const questions = rows.filter(
      r => r.Email.toLowerCase() === email.toLowerCase() && parseInt(r.Week) === week
    );
    res.json({ questions, week });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load questions' });
  }
});

// POST /api/questions/submit — submit an answer
app.post('/api/questions/submit', requireLogin, async (req, res) => {
  try {
    const { questionNo, answer } = req.body;
    const { email, week }        = req.session.user;
    if (!answer || answer.trim().length < 20)
      return res.status(400).json({ error: 'Answer is too short' });

    // Find the row index in the sheet
    const rows   = await readSheet('Questions');
    const allRaw = await getSheetsClient().spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'Questions!A:Z'
    });
    const [headers, ...dataRows] = allRaw.data.values || [];
    const emailIdx  = headers.indexOf('Email');
    const weekIdx   = headers.indexOf('Week');
    const qIdx      = headers.indexOf('Q No.');
    const answerIdx = headers.indexOf('Answer');
    const subIdx    = headers.indexOf('Submitted');

    const rowIdx = dataRows.findIndex(
      r => (r[emailIdx]||'').toLowerCase() === email.toLowerCase() &&
           parseInt(r[weekIdx]) === week &&
           (r[qIdx]||'') === questionNo
    );

    if (rowIdx === -1)
      return res.status(404).json({ error: 'Question not found' });

    const sheetRow = rowIdx + 2; // +1 for header, +1 for 1-based index
    const sheets   = getSheetsClient();

    // Write answer and mark submitted
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: `Questions!${String.fromCharCode(65+answerIdx)}${sheetRow}`, values: [[answer.trim()]] },
          { range: `Questions!${String.fromCharCode(65+subIdx)}${sheetRow}`,   values: [['TRUE']] },
        ]
      }
    });

    res.json({ success: true, message: 'Answer submitted! AI score will appear soon.' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not submit answer' });
  }
});

// GET /api/scores — all scores for logged-in user
app.get('/api/scores', requireLogin, async (req, res) => {
  try {
    const email  = req.session.user.email;
    const rows   = await readSheet('Scores');
    const scores = rows.filter(r => r.Email.toLowerCase() === email.toLowerCase());
    // Sort by date desc
    scores.sort((a, b) => new Date(b.Date) - new Date(a.Date));

    const latest  = scores[0] || null;
    const average = scores.length
      ? Math.round(scores.reduce((s, r) => s + parseInt(r.Score||0), 0) / scores.length)
      : 0;

    res.json({ scores, latest, average });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load scores' });
  }
});

// GET /api/resume — resume review data for logged-in user
app.get('/api/resume', requireLogin, async (req, res) => {
  try {
    const email = req.session.user.email;
    const users = await readSheet('Users');
    const user  = users.find(u => u.Email.toLowerCase() === email.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({
      atsScore:   user['ATS Score']   || null,
      atsTips:    user['ATS Tips']    || null,
      resumeUrl:  user['Resume URL']  || null,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load resume data' });
  }
});

// GET /api/overview — summary stats for the overview panel
app.get('/api/overview', requireLogin, async (req, res) => {
  try {
    const { email, week } = req.session.user;

    const [planRows, scoreRows, questionRows] = await Promise.all([
      readSheet('Plans'),
      readSheet('Scores'),
      readSheet('Questions'),
    ]);

    const myPlan      = planRows.filter(r => r.Email.toLowerCase() === email.toLowerCase());
    const myScores    = scoreRows.filter(r => r.Email.toLowerCase() === email.toLowerCase());
    const myQuestions = questionRows.filter(r => r.Email.toLowerCase() === email.toLowerCase() && parseInt(r.Week) === week);

    const tasksDone   = myPlan.filter(r => r.Status === 'Done').length;
    const totalTasks  = myPlan.length;
    const latestScore = myScores.sort((a,b) => new Date(b.Date)-new Date(a.Date))[0] || null;
    const pendingQs   = myQuestions.filter(r => r.Submitted !== 'TRUE').length;

    const recentActivity = [
      ...myScores.slice(0,2).map(s => ({ type: 'score',    text: `AI Score received: ${s.Score}/100 — Week ${s.Week} ${s['Q No.']}`, date: s.Date })),
      ...myQuestions.filter(r=>r.Submitted==='TRUE').slice(0,2).map(q => ({ type: 'submit', text: `Submitted Week ${q.Week} ${q['Q No.']} answer`, date: '' })),
    ].slice(0, 4);

    res.json({
      week,
      tasksDone,
      totalTasks,
      progress: totalTasks ? Math.round((tasksDone / totalTasks) * 100) : 0,
      latestScore: latestScore ? parseInt(latestScore.Score) : null,
      pendingQuestions: pendingQs,
      recentActivity,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load overview' });
  }
});

// POST /api/change-password — updates password in Google Sheet + session
app.post('/api/change-password', requireLogin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Both current and new password are required' });
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const email = req.session.user.email;

    // Fetch current row to verify current password
    const sheets = getSheetsClient();
    const raw = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Users!A:Z',
    });
    const [headers, ...rows] = raw.data.values || [];
    const emailIdx    = headers.indexOf('Email');
    const passwordIdx = headers.indexOf('Password');

    const rowIdx = rows.findIndex(r => (r[emailIdx] || '').toLowerCase() === email.toLowerCase());
    if (rowIdx === -1)
      return res.status(404).json({ error: 'User not found in sheet' });

    const existingPassword = (rows[rowIdx][passwordIdx] || '').trim();
    if (existingPassword !== currentPassword)
      return res.status(401).json({ error: 'Current password is incorrect' });

    // Write new password back to the Sheet
    const sheetRow = rowIdx + 2; // +1 header, +1 for 1-based index
    const col = String.fromCharCode(65 + passwordIdx);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Users!${col}${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[newPassword]] },
    });

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('Change password error:', err.message);
    res.status(500).json({ error: 'Could not update password. Please try again.' });
  }
});

// ── Catch-all: serve dashboard for any non-API route ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`✅ CareerAI server running on http://localhost:${PORT}`);
  if (!process.env.SHEET_ID) console.warn('⚠️  SHEET_ID not set in .env');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) console.warn('⚠️  GOOGLE_SERVICE_ACCOUNT_JSON not set in .env');
});
