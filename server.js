require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const helmet     = require('helmet');
const cors       = require('cors');
const path       = require('path');
const { google } = require('googleapis');
const { runOnboarding } = require('./onboarding');

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

// ── Helper: check if week should advance and update Sheets + session ──
// ── Helper: calculate days elapsed since a date string (YYYY-MM-DD) ──
function daysSince(dateStr) {
  if (!dateStr) return 0;
  const start = new Date(dateStr);
  const today = new Date();
  start.setHours(0,0,0,0);
  today.setHours(0,0,0,0);
  return Math.floor((today - start) / (1000 * 60 * 60 * 24));
}

// ── Helper: today as YYYY-MM-DD ──
function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// ── Helper: check if week should advance (all done OR 7 days passed) ──
// Returns { newWeek, weekStarted, advanced, reason }
async function checkAndAdvanceWeek(email, currentWeek, weekStarted, sessionRef) {
  if (currentWeek >= 4) return { newWeek: currentWeek, weekStarted, advanced: false };

  const plans     = await readSheet('Plans');
  const weekTasks = plans.filter(r =>
    r.Email.toLowerCase() === email.toLowerCase() &&
    parseInt(r.Week) === currentWeek
  );

  if (!weekTasks.length) return { newWeek: currentWeek, weekStarted, advanced: false };

  const allDone      = weekTasks.every(r => r.Status === 'Done');
  const daysElapsed  = daysSince(weekStarted);
  const sevenDaysDue = daysElapsed >= 7;

  const shouldAdvance = allDone || sevenDaysDue;
  if (!shouldAdvance) return { newWeek: currentWeek, weekStarted, advanced: false };

  const reason  = allDone ? 'all tasks completed' : '7 days elapsed';
  const newWeek = currentWeek + 1;
  const newDate = todayStr();
  console.log(`🎉 ${email}: Week ${currentWeek} → ${newWeek} (${reason})`);

  // Update Users sheet — Week and Week Started columns
  const sheets = getSheetsClient();
  const raw    = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: 'Users!A:Z',
  });
  const [headers, ...rows] = raw.data.values || [];
  const emailIdx       = headers.indexOf('Email');
  const weekIdx        = headers.indexOf('Week');
  const weekStartedIdx = headers.indexOf('Week Started');
  const rowIdx         = rows.findIndex(r =>
    (r[emailIdx]||'').toLowerCase() === email.toLowerCase()
  );

  if (rowIdx !== -1) {
    const sheetRow = rowIdx + 2;
    const updates  = [
      { range: `Users!${String.fromCharCode(65+weekIdx)}${sheetRow}`,        values: [[String(newWeek)]] },
    ];
    if (weekStartedIdx !== -1) {
      updates.push({ range: `Users!${String.fromCharCode(65+weekStartedIdx)}${sheetRow}`, values: [[newDate]] });
    }
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: updates }
    });
  }

  // Update session
  if (sessionRef) {
    sessionRef.week        = newWeek;
    sessionRef.weekStarted = newDate;
  }

  return { newWeek, weekStarted: newDate, advanced: true, reason };
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
    const weekStarted = user['Week Started'] || todayStr();
    req.session.user = {
      email:       user.Email,
      name:        user.Name,
      role:        user.Role,
      experience:  user.Experience,
      week:        parseInt(user.Week) || 1,
      weekStarted: weekStarted,
      dayOfWeek:   Math.min(daysSince(weekStarted) + 1, 7), // Day 1–7
    };

    // Check if week should advance (all done OR 7 days)
    const { newWeek, weekStarted: newWS, advanced } = await checkAndAdvanceWeek(
      req.session.user.email,
      req.session.user.week,
      req.session.user.weekStarted,
      req.session.user
    );
    if (advanced) {
      req.session.user.week        = newWeek;
      req.session.user.weekStarted = newWS;
      req.session.user.dayOfWeek   = 1;
    }

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

    // Overdue = past weeks with incomplete tasks
    const overdueCount = myPlan.filter(r =>
      parseInt(r.Week) < week && r.Status !== 'Done'
    ).length;

    // Current week progress
    const curWeekTasks    = myPlan.filter(r => parseInt(r.Week) === week);
    const curWeekDone     = curWeekTasks.filter(r => r.Status === 'Done').length;
    const curWeekProgress = curWeekTasks.length
      ? Math.round((curWeekDone / curWeekTasks.length) * 100)
      : 0;

    res.json({
      week,
      tasksDone,
      totalTasks,
      progress: totalTasks ? Math.round((tasksDone / totalTasks) * 100) : 0,
      latestScore: latestScore ? parseInt(latestScore.Score) : null,
      pendingQuestions: pendingQs,
      recentActivity,
      overdueCount,
      currentWeekProgress: curWeekProgress,
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

// ══════════════════════════════════════════════════════
// POST /api/plan/task — update a task's Status (Done / blank)
app.post('/api/plan/task', requireLogin, async (req, res) => {
  try {
    const { week, day, taskTitle, status } = req.body;
    const email = req.session.user.email;

    if (!taskTitle) return res.status(400).json({ error: 'taskTitle required' });

    // Get raw Plans sheet to find the exact row
    const sheets = getSheetsClient();
    const raw = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Plans!A:Z',
    });

    const [headers, ...rows] = raw.data.values || [];
    const emailIdx = headers.indexOf('Email');
    const weekIdx  = headers.indexOf('Week');
    const dayIdx   = headers.indexOf('Day');
    const titleIdx = headers.indexOf('Task Title');
    const statIdx  = headers.indexOf('Status');

    // Find the matching row
    const rowIdx = rows.findIndex(r =>
      (r[emailIdx]||'').toLowerCase() === email.toLowerCase() &&
      String(r[weekIdx]||'') === String(week) &&
      String(r[dayIdx]||'')  === String(day) &&
      (r[titleIdx]||'').trim() === taskTitle.trim()
    );

    if (rowIdx === -1)
      return res.status(404).json({ error: 'Task not found' });

    // Update Status cell
    const sheetRow = rowIdx + 2; // +1 header +1 for 1-based
    const col = String.fromCharCode(65 + statIdx);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Plans!${col}${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status || '']] },
    });

    // Check if this completed the week — advance if so
    const currentWeek   = req.session.user.week;
    const weekStarted   = req.session.user.weekStarted || todayStr();
    const { newWeek, weekStarted: newWS, advanced } = await checkAndAdvanceWeek(
      req.session.user.email,
      currentWeek,
      weekStarted,
      req.session.user
    );

    res.json({
      success:     true,
      weekAdvanced: advanced,
      newWeek:     newWeek,
      dayOfWeek:   advanced ? 1 : req.session.user.dayOfWeek,
    });
  } catch (err) {
    console.error('Task update error:', err.message);
    res.status(500).json({ error: 'Could not update task: ' + err.message });
  }
});

// POST /api/onboard — Tally webhook → Claude → Sheets → Email
// ══════════════════════════════════════════════════════
app.post('/api/onboard', async (req, res) => {
  // Verify Tally webhook secret (optional but recommended)
  const secret = process.env.TALLY_WEBHOOK_SECRET;
  if (secret && req.headers['tally-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  // Respond to Tally immediately (Tally expects fast response)
  res.json({ received: true });

  // Run onboarding async (so Tally doesn't time out)
  const result = await runOnboarding(req.body, getSheetsClient, SHEET_ID);
  if (result.success) {
    console.log(`✅ Onboarding complete: ${result.email}`);
  } else {
    console.error(`❌ Onboarding failed: ${result.error}`);
  }
});

// POST /api/onboard/debug — log raw Tally payload to see field structure
app.post('/api/onboard/debug', (req, res) => {
  console.log('RAW TALLY PAYLOAD:', JSON.stringify(req.body, null, 2));
  res.json({ received: true, fields: req.body?.data?.fields || req.body });
});

// POST /api/onboard/test — test onboarding manually with custom data
app.post('/api/onboard/test', async (req, res) => {
  const { name, email, role, techStack, experience } = req.body;
  if (!email || !role) return res.status(400).json({ error: 'email and role required' });

  // Build a fake Tally payload from the test data
  const fakeTallyPayload = {
    data: {
      fields: [
        { label: 'Name', value: name || 'Test User' },
        { label: 'Email Address', value: email },
        { label: 'Target Role', value: role },
        { label: 'Tech Stack', value: techStack || role },
        { label: 'Experience', value: experience || 'Mid' },
      ]
    }
  };

  const result = await runOnboarding(fakeTallyPayload, getSheetsClient, SHEET_ID);
  res.json(result);
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
