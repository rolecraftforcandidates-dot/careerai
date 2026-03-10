require('dotenv').config();
const express    = require('express');
const session     = require('express-session');
const cookieSession = require('cookie-session');
const helmet     = require('helmet');
const cors       = require('cors');
const path       = require('path');
const { google } = require('googleapis');
const multer    = require('multer');
const upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max
const { runOnboarding } = require('./onboarding');
const passport       = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security middleware ──
app.use(helmet({ contentSecurityPolicy: false })); // CSP off so dashboard JS works
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: false })); // index:false prevents auto-serving index.html at /

// ── Trust Railway's proxy (required for secure cookies on HTTPS) ──
app.set('trust proxy', 1);

// ── Session ──
// Detect production environment
const isProduction = !!(process.env.APP_URL && process.env.APP_URL.startsWith('https'));
console.log('🌍 Environment:', isProduction ? 'production' : 'development');

// cookie-session: stores session data directly in signed cookie — no store needed
app.use(cookieSession({
  name:   'rolecraft.sess',
  keys:   [process.env.SESSION_SECRET || 'rolecraft-secret-2026', 'rolecraft-backup-key'],
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  secure:   isProduction,
  httpOnly: true,
  sameSite: isProduction ? 'none' : 'lax',
}));

// Compatibility shim — passport and other middleware expect req.session
app.use(function(req, res, next) {
  if (req.session && !req.session.regenerate) {
    req.session.regenerate = function(cb) { cb(); };
  }
  if (req.session && !req.session.save) {
    req.session.save = function(cb) { cb(); };
  }
  if (req.session && !req.session.destroy) {
    req.session.destroy = function(cb) {
      req.session = null;
      if (cb) cb();
    };
  }
  next();
});

// ── Passport / Google OAuth ──
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL:  process.env.APP_URL
                    ? process.env.APP_URL + '/auth/google/callback'
                    : '/auth/google/callback',
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = (profile.emails && profile.emails[0] && profile.emails[0].value || '').toLowerCase();
      const name  = profile.displayName || profile.emails[0].value.split('@')[0];
      if (!email) return done(new Error('No email from Google'));

      // Check if user exists in sheet
      const users = await readSheet('Users');
      let user    = users.find(u => (u.Email||'').toLowerCase() === email);

      if (!user) {
        // New Google user — don't create sheet row yet
        // Send them to Tally form first so they complete onboarding properly
        console.log('Google OAuth new user (no sheet entry):', email);
        return done(null, {
          email, name,
          role: '', experience: '', week: 0,
          tier: 'free', tierExpiry: '',
          authProvider: 'google',
          needsOnboarding: true,
        });
      }

      // Build session user — same shape as email/password login
      const tierExpiry = user['Tier Expiry'] || '';
      let activeTier   = (user.Tier || 'free').toLowerCase();
      if (activeTier !== 'free' && tierExpiry) {
        if (new Date(tierExpiry) < new Date()) activeTier = 'free';
      }

      const sessionUser = {
        email:       user.Email,
        name:        user.Name        || user['Full Name'] || '',
        role:        user.Role        || user['Target Role'] || '',
        experience:  user.Experience  || '',
        techStack:   user['Tech Stack'] || user['O'] || '',
        week:        parseInt(user.Week) || 0,
        weekStarted: user['Week Started'] || today,
        dayOfWeek:   1,
        tier:        activeTier,
        tierExpiry:  tierExpiry,
        authProvider: 'google',
        needsOnboarding: !(user.Role || user['Target Role']) || user.Week === '0',
      };

      done(null, sessionUser);
    } catch (err) {
      done(err);
    }
  }));
  console.log('✅ Google OAuth configured');
} else {
  console.log('⚠️  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google login disabled');
}

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

function getDriveClient() {
  let credentials;
  try {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is missing or invalid');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
  });
  return google.drive({ version: 'v3', auth });
}

// Extract text from PDF or DOCX buffer
async function extractResumeText(buffer, mimetype) {
  try {
    if (mimetype === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      return (data.text || '').trim();
    }
    if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        mimetype === 'application/msword') {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ buffer });
      return (result.value || '').trim();
    }
    return '';
  } catch (err) {
    console.error('Text extraction error:', err.message);
    return '';
  }
}

// Upload file buffer to Google Drive, return public URL
async function uploadToDrive(buffer, filename, mimetype, email) {
  const drive = getDriveClient();
  const { Readable } = require('stream');

  // Get or create a 'RoleKraft Resumes' folder
  let folderId = process.env.DRIVE_RESUME_FOLDER_ID || null;

  if (!folderId) {
    // Check if folder exists
    const folderSearch = await drive.files.list({
      q: "name='RoleKraft Resumes' and mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id)',
    });
    if (folderSearch.data.files.length > 0) {
      folderId = folderSearch.data.files[0].id;
    } else {
      // Create it
      const folder = await drive.files.create({
        requestBody: { name: 'RoleKraft Resumes', mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id',
      });
      folderId = folder.data.id;
      console.log('📁 Created RoleKraft Resumes folder:', folderId);
    }
  }

  // Upload file
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);

  const safeEmail = email.replace(/[^a-zA-Z0-9]/g, '_');
  const ext       = filename.split('.').pop();
  const driveFilename = `resume_${safeEmail}.${ext}`;

  // Delete old resume for this user if exists
  try {
    const existing = await drive.files.list({
      q: `name='${driveFilename}' and '${folderId}' in parents and trashed=false`,
      fields: 'files(id)',
    });
    for (const f of existing.data.files) {
      await drive.files.delete({ fileId: f.id });
    }
  } catch (e) { /* ignore */ }

  const file = await drive.files.create({
    requestBody: {
      name: driveFilename,
      parents: [folderId],
    },
    media: { mimeType: mimetype, body: stream },
    fields: 'id,webViewLink,webContentLink',
  });

  // Make publicly readable
  await drive.permissions.create({
    fileId: file.data.id,
    requestBody: { role: 'reader', type: 'anyone' },
  });

  return {
    fileId:   file.data.id,
    viewUrl:  file.data.webViewLink,
    directUrl: file.data.webContentLink,
  };
}

const SHEET_ID = process.env.SHEET_ID;

// ── Helper: read a tab ──
async function readSheet(tabName) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A:AZ`,
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
  // Block users who signed in with Google but never completed Tally onboarding
  if (req.session.user.needsOnboarding) {
    req.session = null; // wipe incomplete Google OAuth session
    return res.status(401).json({ error: 'Not logged in' });
  }
  // If role missing but session exists, allow through — role may be blank for old users
  next();
}

function isPro(user) {
  return user && (user.tier === 'pro' || user.tier === 'premium');
}

function requirePro(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  if (!isPro(req.session.user)) {
    return res.status(403).json({
      error: 'pro_required',
      message: 'This feature requires RoleKraft Pro. Upgrade to unlock unlimited access.',
    });
  }
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
    console.log('🔑 Login attempt:', email);
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const users = await readSheet('Users');
    console.log('👥 Total users in sheet:', users.length);
    const user  = users.find(u => (u.Email||'').toLowerCase() === email.toLowerCase().trim());

    if (!user) {
      console.log('❌ User not found:', email);
      return res.status(401).json({ error: 'No account found with this email' });
    }
    console.log('✅ User found:', user.Email, '| Password hash starts:', (user.Password||'').slice(0,10));

    // Allow login even if plan is still generating (Phase 2 may still be running)
    // Only block if account was never set up at all (no password)
    if (!user.Password)
      return res.status(403).json({ error: 'Account setup incomplete. Please check your email.' });

    // Password comparison — handle both bcrypt hashes and plain text (legacy)
    const bcrypt = require('bcryptjs');
    let passwordOk = false;
    const storedPw = user.Password || '';
    if (storedPw.startsWith('$2a$') || storedPw.startsWith('$2b$')) {
      // bcrypt hash — use bcrypt.compare
      try { passwordOk = await bcrypt.compare(password, storedPw); }
      catch(e) { passwordOk = false; }
    } else {
      // Plain text password (older accounts created manually)
      passwordOk = (storedPw === password);
    }
    if (!passwordOk) {
      console.log('❌ Password mismatch for', email, '| isHashed:', storedPw.startsWith('$2'));
      return res.status(401).json({ error: 'Incorrect password' });
    }
    console.log('✅ Password verified for', email);

    // Store session
    const weekStarted = user['Week Started'] || todayStr();
    // Determine tier — check Tier column, default to 'free'
    const userTier = (user.Tier || 'free').toLowerCase().trim();
    const tierExpiry = user['Tier Expiry'] || '';
    console.log(`🎫 Tier check for ${user.Email}: Tier="${user.Tier}" raw, resolved="${userTier}", expiry="${tierExpiry}"`);
    // Check if paid tier has expired
    let activeTier = userTier;
    if (userTier !== 'free' && tierExpiry) {
      const expDate = new Date(tierExpiry);
      if (!isNaN(expDate) && expDate < new Date()) {
        activeTier = 'free'; // expired — downgrade
        console.log(`⚠️  Tier expired for ${user.Email} — downgrading to free`);
      }
    }

    req.session.user = {
      email:           user.Email,
      name:            user.Name  || user['Full Name'] || '',
      role:            user.Role  || user['Target Role'] || user['Role'] || '',
      experience:      user.Experience || user['Experience'] || '',
      experienceYears: parseInt(user['Experience Years'] || user['P'] || '') || null,
      techStack:       user['Tech Stack'] || user['O'] || '',
      week:            parseInt(user.Week) || 1,
      weekStarted: weekStarted,
      dayOfWeek:   Math.min(daysSince(weekStarted) + 1, 7),
      tier:        activeTier,
      tierExpiry:  tierExpiry,
    };
    const sessionSize = JSON.stringify(req.session).length;
    console.log('📦 Session set for', user.Email, '| size:', sessionSize, 'bytes | user set:', !!req.session.user);

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

    console.log('✅ Email login session set for', req.session.user?.email, '| keys:', Object.keys(req.session));
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
  req.session = null; // cookie-session: set to null to clear
  res.json({ success: true });
});

// GET /api/me — check session
app.get('/api/me', requireLogin, async (req, res) => {
  const u = req.session.user;
  // Only block incomplete Google OAuth sessions (needsOnboarding flag)
  // Do NOT wipe session based on missing role — role column may be named differently
  if (u.needsOnboarding) {
    req.session = null;
    return res.status(401).json({ error: 'Incomplete registration — please complete onboarding' });
  }
  if (!u.tier) u.tier = 'free';
  // For free users, include jmUsage so UI can show/hide the job match lock
  let jmUsage = 0;
  if (!isPro(u)) {
    try {
      const users = await readSheet('Users');
      const user  = users.find(uu => uu.Email.toLowerCase() === u.email.toLowerCase());
      jmUsage = parseInt(user && user['JM Usage'] || '0');
    } catch(e) { /* non-critical */ }
  }
  const tallyFormUrl = process.env.TALLY_FORM_URL || 'https://tally.so/r/D4NpLX';
  res.json({ user: u, jmUsage, tallyFormUrl });
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

// GET /api/questions — all questions up to current week for logged-in user
app.get('/api/questions', requireLogin, async (req, res) => {
  try {
    const { email, week, tier } = req.session.user;
    const rows = await readSheet('Questions');
    // Return all questions for weeks 1 through current week
    const questions = rows.filter(
      r => r.Email.toLowerCase() === email.toLowerCase() && parseInt(r.Week) <= week
    );
    res.json({ questions, week });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load questions' });
  }
});

// POST /api/questions/submit — submit answer + instantly score with Claude
app.post('/api/questions/submit', requireLogin, async (req, res) => {
  try {
    const { questionNo, answer, weekOverride } = req.body;
    const { email, role, experience } = req.session.user;
    const week = weekOverride ? parseInt(weekOverride) : req.session.user.week;

    // Free tier: only 3 AI-scored question submissions total (not per month)
    if (!isPro(req.session.user)) {
      const allQRaw = await getSheetsClient().spreadsheets.values.get({
        spreadsheetId: SHEET_ID, range: 'Questions!A:Z'
      });
      const [qHdrs, ...qDataRows] = allQRaw.data.values || [];
      const qEmailIdx = qHdrs.indexOf('Email');
      const qSubIdx   = qHdrs.indexOf('Submitted');
      const qScoreIdx = qHdrs.indexOf('Score');
      const scoredCount = qDataRows.filter(r =>
        (r[qEmailIdx]||'').toLowerCase() === email.toLowerCase() &&
        (r[qSubIdx]||'').toUpperCase() === 'TRUE' &&
        r[qScoreIdx] && r[qScoreIdx] !== ''
      ).length;
      if (scoredCount >= 3) {
        return res.status(403).json({
          error: 'pro_required',
          message: 'Free plan includes 3 AI-scored answers. Upgrade to Pro for unlimited AI analysis on all 28 questions.',
        });
      }
    }
    console.log(`📝 Submit received: qno="${questionNo}" type=${typeof questionNo} weekOverride=${weekOverride} week=${week} bodyKeys=${Object.keys(req.body).join(',')}`);
    if (!answer || answer.trim().length < 20)
      return res.status(400).json({ error: 'Answer is too short' });

    // Find the row in Questions sheet
    const allRaw = await getSheetsClient().spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'Questions!A:Z'
    });
    const [headers, ...dataRows] = allRaw.data.values || [];
    const emailIdx    = headers.indexOf('Email');
    const weekIdx     = headers.indexOf('Week');
    const qIdx        = headers.indexOf('Q No.');
    const typeIdx     = headers.indexOf('Type');
    const questionIdx = headers.indexOf('Question');
    const answerIdx   = headers.indexOf('Answer');
    const subIdx      = headers.indexOf('Submitted');
    const scoreIdx    = headers.indexOf('Score');
    const feedbackIdx = headers.indexOf('AI Feedback');

    // Log full picture for debugging
    console.log(`🔍 Submit: email=${email} week=${week} qno="${questionNo}"`);
    const userRows = dataRows.filter(r => (r[emailIdx]||'').toLowerCase() === email.toLowerCase());
    console.log('📋 All rows for user:', JSON.stringify(userRows.map((r,i)=>({
      sheetRow: i+2, w: r[weekIdx], q: r[qIdx], type: r[typeIdx], submitted: r[subIdx]
    }))));

    // Find ALL matching rows (not just first) — pick the unsubmitted one if multiple
    const candidateIdxs = [];
    dataRows.forEach((r, i) => {
      const rowEmail = (r[emailIdx]||'').toLowerCase().trim();
      const rowWeek  = String(r[weekIdx]||'').trim();
      const rowQNo   = (r[qIdx]||'').trim();
      if (rowEmail === email.toLowerCase().trim() &&
          rowWeek  === String(week).trim() &&
          rowQNo   === String(questionNo).trim()) {
        candidateIdxs.push(i);
      }
    });

    console.log(`🔍 Matching rows: ${JSON.stringify(candidateIdxs.map(i=>i+2))}`);

    if (candidateIdxs.length === 0) {
      console.log('❌ No match found');
      return res.status(404).json({ error: `Question not found: week=${week} qno=${questionNo}` });
    }

    // Prefer unsubmitted row; fall back to first match
    let rowIdx = candidateIdxs.find(i => (dataRows[i][subIdx]||'').toUpperCase() !== 'TRUE');
    if (rowIdx === undefined) rowIdx = candidateIdxs[0];
    console.log(`✅ Using row ${rowIdx+2} (submitted=${dataRows[rowIdx][subIdx]})`);

    const sheetRow   = rowIdx + 2;
    const questionText = dataRows[rowIdx][questionIdx] || '';
    const questionType = dataRows[rowIdx][typeIdx]     || 'Technical';

    // ── Score with Claude ──
    let score = null, feedback = '', technical = 0, communication = 0, problemSolving = 0, behavioral = 0, primarySkill = 'technical';
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

      // Type-specific scoring weights
      const typeWeights = {
        'Technical':     'Weight technical accuracy (40%), communication clarity (30%), problem solving (20%), behavioral (10%)',
        'Behavioral':    'Weight behavioral depth/STAR format (40%), communication (35%), technical context (15%), problem solving (10%)',
        'System Design': 'Weight problem solving/architecture (40%), technical accuracy (35%), communication (20%), behavioral (5%)',
      };
      const weightGuide = typeWeights[questionType] || typeWeights['Technical'];

      const scorePrompt = `You are an expert technical interviewer evaluating a ${questionType} question answer for a ${role} role (${experience} years experience).

QUESTION TYPE: ${questionType}
QUESTION: ${questionText}

CANDIDATE'S ANSWER:
${answer.trim()}

Scoring weights for ${questionType} questions: ${weightGuide}

Return ONLY valid JSON — no markdown, no code fences, nothing else:
{
  "score": <overall integer 0-100 using the weights above>,
  "technical": <integer 0-100, how technically accurate and deep>,
  "communication": <integer 0-100, how clear, structured and articulate>,
  "problemSolving": <integer 0-100, how well they break down and solve the problem>,
  "behavioral": <integer 0-100, for behavioral: STAR format depth; for others: professional maturity>,
  "primarySkill": "${questionType === 'Behavioral' ? 'behavioral' : questionType === 'System Design' ? 'problemSolving' : 'technical'}",
  "feedback": "<3 sentences: 1) what was strong, 2) what was missing or weak, 3) one very specific improvement tip for ${role}>"
}

Scoring guide:
- 85-100: Exceptional — specific, structured, examples from real experience
- 70-84: Good — covers main points, missing depth or concrete examples
- 55-69: Average — basic answer, vague or lacks structure
- 40-54: Weak — incomplete, off-topic, or missing key concepts
- 0-39: Poor — does not address the question

Be honest. Reference specific things the candidate wrote.`;

      const msg = await client.messages.create({
        model: 'claude-sonnet-4-5', // Sonnet for richer answer feedback
        max_tokens: 800,
        messages: [{ role: 'user', content: scorePrompt }],
      });

      const raw     = msg.content[0].text.trim().replace(/```json|```/g,'').trim();
      const parsed  = JSON.parse(raw);
      score         = Math.min(100, Math.max(0, parseInt(parsed.score) || 0));
      technical     = Math.min(100, Math.max(0, parseInt(parsed.technical) || 0));
      communication = Math.min(100, Math.max(0, parseInt(parsed.communication) || 0));
      problemSolving= Math.min(100, Math.max(0, parseInt(parsed.problemSolving) || 0));
      behavioral    = Math.min(100, Math.max(0, parseInt(parsed.behavioral) || 0));
      primarySkill  = parsed.primarySkill || (questionType === 'Behavioral' ? 'behavioral' : questionType === 'System Design' ? 'problemSolving' : 'technical');
      feedback      = parsed.feedback || '';
      console.log(`✅ Claude scored ${email} Week ${week} ${questionNo}: ${score}/100 [${questionType}]`);
    } catch (scoreErr) {
      console.error('Claude scoring failed:', scoreErr.message);
      // Fallback — still save answer even if scoring fails
    }

    // ── Write answer + score + feedback to Questions sheet ──
    const sheets  = getSheetsClient();
    const updates = [
      { range: `Questions!${String.fromCharCode(65+answerIdx)}${sheetRow}`, values: [[answer.trim()]] },
      { range: `Questions!${String.fromCharCode(65+subIdx)}${sheetRow}`,   values: [['TRUE']] },
    ];
    if (score !== null && scoreIdx !== -1)    updates.push({ range: `Questions!${String.fromCharCode(65+scoreIdx)}${sheetRow}`,    values: [[String(score)]] });
    if (feedback && feedbackIdx !== -1)        updates.push({ range: `Questions!${String.fromCharCode(65+feedbackIdx)}${sheetRow}`, values: [[feedback]] });

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { valueInputOption: 'RAW', data: updates }
    });

    // ── Also write to Scores tab for history + graphs ──
    if (score !== null) {
      const today = new Date().toISOString().split('T')[0];
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Scores!A:A',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[
          email, String(week), questionNo, String(score),
          String(technical), String(communication), String(problemSolving), String(behavioral),
          today, feedback
        ]]}
      });
    }

    res.json({
      success:      true,
      score:        score,
      feedback:     feedback,
      questionType: questionType,
      primarySkill: primarySkill,
      technical, communication, problemSolving, behavioral,
      message:   score !== null ? `Scored ${score}/100` : 'Submitted — scoring unavailable'
    });
  } catch (err) {
    console.error('Submit error:', err.message);
    res.status(500).json({ error: 'Could not submit answer: ' + err.message });
  }
});

// GET /api/scores — all scores for logged-in user
app.get('/api/scores', requireLogin, async (req, res) => {
  try {
    const email = req.session.user.email;

    // Read raw to handle missing headers gracefully
    const raw = await getSheetsClient().spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: 'Scores!A:Z',
    });

    const values = raw.data.values || [];
    console.log(`📊 Scores sheet: ${values.length} rows, headers: ${values[0]?.join('|')}`);
    if (values.length < 2) {
      return res.json({ scores: [], latest: null, average: 0 });
    }

    const [headers, ...dataRows] = values;
    // Map rows to objects using header names
    const allScores = dataRows.map(row =>
      Object.fromEntries(headers.map((h, i) => [h.trim(), (row[i]||'').trim()]))
    );

    const scores = allScores.filter(r =>
      (r.Email||'').toLowerCase() === email.toLowerCase() && r.Score
    );

    // Keep original sheet order (appended = newest last), reverse for display
    // Don't sort by date when same-day — use sheet row order instead
    scores.reverse(); // Last appended row = most recent

    const latest  = scores[0] || null;
    const average = scores.length
      ? Math.round(scores.reduce((s, r) => s + (parseInt(r.Score)||0), 0) / scores.length)
      : 0;

    res.json({ scores, latest, average });
  } catch (err) {
    console.error('Scores route error:', err.message);
    res.json({ scores: [], latest: null, average: 0 }); // Return empty rather than error
  }
});

// GET /api/jobs — fetch live jobs from Adzuna + quick match score
app.get('/api/jobs', requireLogin, async (req, res) => {
  try {
    const { email, role, experience } = req.session.user;
    const location = req.query.location || 'india';

    const appId  = process.env.ADZUNA_APP_ID;
    const appKey = process.env.ADZUNA_APP_KEY;
    if (!appId || !appKey) {
      return res.status(500).json({ error: 'Adzuna API keys not configured. Add ADZUNA_APP_ID and ADZUNA_APP_KEY to Railway environment variables.' });
    }

    const roleKeywords = (role || 'software engineer').trim();

    // ── Fallback keyword map — fuzzy matched against user's role ──
    // Keys are partial patterns, values are alternative search terms
    const fallbackMap = [
      { pattern: 'data engineer',      alts: ['big data engineer','data platform engineer','etl engineer','data infrastructure','analytics engineer','azure data engineer','aws data engineer'] },
      { pattern: 'frontend',           alts: ['frontend engineer','react developer','ui developer','javascript developer','web developer','angular developer','vue developer'] },
      { pattern: 'front end',          alts: ['frontend engineer','react developer','ui developer','javascript developer','web developer'] },
      { pattern: 'backend',            alts: ['backend engineer','api developer','nodejs developer','java developer','python developer','software engineer backend'] },
      { pattern: 'back end',           alts: ['backend engineer','api developer','nodejs developer','java developer'] },
      { pattern: 'full stack',         alts: ['full stack engineer','software engineer','web developer','mern stack','mean stack developer'] },
      { pattern: 'fullstack',          alts: ['full stack engineer','software engineer','web developer','mern stack'] },
      { pattern: 'data scientist',     alts: ['data scientist','senior data scientist','machine learning engineer','ml engineer','ai engineer','applied scientist','research scientist','data science engineer'] },
      { pattern: 'devops',             alts: ['site reliability engineer','platform engineer','cloud engineer','infrastructure engineer','sre'] },
      { pattern: 'cloud engineer',     alts: ['aws engineer','azure engineer','gcp engineer','devops engineer','platform engineer'] },
      { pattern: 'product manager',    alts: ['product owner','program manager','technical product manager','senior product manager'] },
      { pattern: 'android',            alts: ['android engineer','mobile developer','kotlin developer','mobile app developer'] },
      { pattern: 'ios developer',      alts: ['ios engineer','swift developer','mobile developer','apple developer'] },
      { pattern: 'ml engineer',        alts: ['machine learning engineer','ai engineer','deep learning engineer','data scientist','nlp engineer'] },
      { pattern: 'machine learning',   alts: ['ml engineer','ai engineer','data scientist','deep learning engineer','nlp engineer'] },
      { pattern: 'software engineer',  alts: ['software developer','programmer','application developer','sde','swe'] },
      { pattern: 'software developer', alts: ['software engineer','application developer','programmer','sde'] },
      { pattern: 'java developer',     alts: ['java engineer','spring boot developer','j2ee developer','backend developer'] },
      { pattern: 'python developer',   alts: ['python engineer','django developer','flask developer','backend developer'] },
      { pattern: 'qa engineer',        alts: ['quality assurance','test engineer','sdet','automation engineer','qa analyst'] },
      { pattern: 'security engineer',  alts: ['cybersecurity engineer','infosec engineer','application security','cloud security'] },
    ];

    const roleKey  = roleKeywords.toLowerCase().trim();
    // Fuzzy match — find first entry whose pattern appears in the role string
    const matched  = fallbackMap.find(f => roleKey.includes(f.pattern) || f.pattern.includes(roleKey.split(' ')[0]));
    const fallbacks = matched ? matched.alts : [roleKeywords + ' engineer', roleKeywords + ' developer', 'senior ' + roleKeywords];
    console.log('Fallbacks for "' + roleKey + '":', fallbacks.slice(0,3));

    const locationMap = {
      india: '', bangalore: 'bangalore', mumbai: 'mumbai',
      delhi: 'delhi', hyderabad: 'hyderabad', pune: 'pune', chennai: 'chennai'
    };
    const locationParam = locationMap[location] || '';
    const locationStr   = locationParam ? '&where=' + encodeURIComponent(locationParam) : '';

    const https = require('https');

    // Helper to fetch from Adzuna
    async function fetchAdzuna(query) {
      const url = 'https://api.adzuna.com/v1/api/jobs/in/search/1' +
        '?app_id=' + appId + '&app_key=' + appKey +
        '&what=' + encodeURIComponent(query) +
        locationStr +
        '&results_per_page=50&max_days_old=30&content-type=application/json&sort_by=date';
      console.log('Adzuna query: "' + query + '" | location:', locationParam || 'India');
      return new Promise((resolve) => {
        https.get(url, (r) => {
          let data = '';
          r.on('data', c => data += c);
          r.on('end', () => {
            try { resolve(JSON.parse(data).results || []); }
            catch(e) { resolve([]); }
          });
        }).on('error', () => resolve([]));
      });
    }

    // Primary search
    let rawJobs = await fetchAdzuna(roleKeywords);
    console.log('Primary search "' + roleKeywords + '": ' + rawJobs.length + ' jobs');

    // Fallback searches if primary gives < 10 results
    // Try fallbacks if < 15 results — keep going until we have 20+
    if (rawJobs.length < 15 && fallbacks.length) {
      for (const alt of fallbacks.slice(0, 4)) {
        if (rawJobs.length >= 20) break;
        const altJobs = await fetchAdzuna(alt);
        console.log('Fallback "' + alt + '": ' + altJobs.length + ' jobs');
        rawJobs = rawJobs.concat(altJobs);
      }
    }
    // ── Resume keyword fallback — extract top skills from resume and search by skill ──
    // Triggered if still < 15 jobs after role-based fallbacks
    if (rawJobs.length < 15) {
      const users      = await readSheet('Users');
      const user       = users.find(u => u.Email.toLowerCase() === email.toLowerCase());
      const resumeText = (user && user['Resume Text']) || (user && user['ATS Tips']) || '';

      if (resumeText.length > 50) {
        // Use Claude to extract top 5 searchable skills from resume
        const Anthropic = require('@anthropic-ai/sdk');
        const client    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
        try {
          const skillMsg = await client.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages: [{
              role: 'user',
              content: 'Extract the top 5 most job-searchable tech skills from this resume. ' +
                'Return ONLY a JSON array of strings — short skill names good for job searching (e.g. ["React","Node.js","AWS","TypeScript","MongoDB"]). ' +
                'Resume: ' + resumeText.slice(0, 1500)
            }]
          });
          const raw    = skillMsg.content[0].text.trim().replace(/```json|```/g,'').trim();
          const skills = JSON.parse(raw);
          console.log('Resume skills extracted:', skills);

          // Use role-aware skill search — append the user's core job function, not just 'engineer'
          const coreRole = roleKeywords.toLowerCase().includes('scientist') ? 'scientist'
                         : roleKeywords.toLowerCase().includes('analyst')   ? 'analyst'
                         : roleKeywords.toLowerCase().includes('manager')   ? 'manager'
                         : roleKeywords.toLowerCase().includes('designer')  ? 'designer'
                         : 'engineer';
          for (const skill of skills.slice(0, 3)) {
            if (rawJobs.length >= 18) break;
            const skillJobs = await fetchAdzuna(skill + ' ' + coreRole);
            console.log('Skill fallback "' + skill + ' ' + coreRole + '": ' + skillJobs.length + ' jobs');
            rawJobs = rawJobs.concat(skillJobs);
          }
        } catch(skillErr) {
          console.log('Skill extraction failed, using broad fallback:', skillErr.message);
          // Broad fallback — last keyword in role e.g. "Engineer" from "Data Engineer"
          const broadTerm = roleKeywords.split(' ').pop();
          const broadJobs = await fetchAdzuna('senior ' + broadTerm);
          console.log('Broad fallback "senior ' + broadTerm + '": ' + broadJobs.length + ' jobs');
          rawJobs = rawJobs.concat(broadJobs);
        }
      } else {
        // No resume — use broad role keyword fallback
        const broadTerm = roleKeywords.split(' ').pop();
        const broadJobs = await fetchAdzuna('senior ' + broadTerm);
        console.log('Broad fallback "senior ' + broadTerm + '": ' + broadJobs.length + ' jobs');
        rawJobs = rawJobs.concat(broadJobs);
      }
    }

    if (!rawJobs.length) return res.json({ jobs: [], message: 'No jobs found. Try Pan India or refresh.' });

    // Deduplicate by title+company
    const seen = new Set();
    rawJobs = rawJobs.filter(job => {
      const key = (job.title||'').toLowerCase().trim() + '|' + (job.company ? job.company.display_name.toLowerCase() : '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Take top 20 for Claude scoring
    rawJobs = rawJobs.slice(0, 20);
    console.log('Sending ' + rawJobs.length + ' unique jobs to Claude for scoring');

    // ── Top company bonus list ──
    const premiumCompanies = new Set([
      // Big tech
      'google','microsoft','amazon','meta','apple','netflix','uber','airbnb',
      // Indian unicorns / top product cos
      'flipkart','swiggy','zomato','phonepe','paytm','razorpay','freshworks',
      'zoho','byju','cred','meesho','nykaa','ola','rapido','lenskart','sharechat',
      'groww','zepto','blinkit','slice','dhruva','browserstack','postman',
      'atlassian','thoughtworks','publicis sapient','moengage','cleartax','clevertap',
      // IT services (top tier)
      'tcs','infosys','wipro','hcl','tech mahindra','ltimindtree','mphasis','hexaware',
      'persistent','zensar','coforge','sonata','cyient',
      // MNCs with strong India presence
      'ibm','oracle','sap','salesforce','adobe','intuit','paypal','jp morgan',
      'goldman sachs','morgan stanley','deutsche bank','barclays','hsbc',
      'accenture','deloitte','pwc','capgemini','ey','kpmg',
      // Startups with good rep
      'khatabook','ofbusiness','darwinbox','leadsquared','hasura','setu','sarvam',
    ]);

    // Get user profile for matching (re-use if already loaded in fallback, else load now)
    const users2      = await readSheet('Users');
    const user2       = users2.find(u => u.Email.toLowerCase() === email.toLowerCase());
    const resumeText  = (user2 && user2['Resume Text']) || (user2 && user2['ATS Tips']) || '';

    // Build structured job list for Claude batch scoring
    const jobsForScoring = rawJobs.map((job, i) => ({
      index:       i,
      title:       job.title || '',
      company:     job.company ? job.company.display_name : '',
      description: ((job.description || '')).slice(0, 600), // trim for batch
    }));

    // ── Single Claude call to score ALL jobs at once ──
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const jobListText = jobsForScoring.map(function(j) {
      return '[' + j.index + '] ' + j.title + ' at ' + j.company + '\n' + j.description;
    }).join('\n---\n');

    // Build role-specific context for better scoring
    // e.g. for "Data Engineer": ETL pipelines, Spark, Airflow, cloud data platforms are all relevant
    const batchPrompt = 'You are a helpful job matching expert for Indian tech companies.\n\n' +
      'CANDIDATE:\n' +
      '- Target Role: ' + roleKeywords + '\n' +
      '- Years Experience: ' + experience + '\n' +
      '- Resume/Skills: ' + (resumeText ? resumeText.slice(0,1500) : 'Not provided — use role and experience only') + '\n\n' +
      'JOB LISTINGS (' + rawJobs.length + ' jobs):\n' + jobListText + '\n\n' +
      'TASK: Score each job 0-100 for this candidate. Be generous with related roles.\n\n' +
      'SCORING GUIDE:\n' +
      '- Completely unrelated field (healthcare, sales, HR, media) → 5-20\n' +
      '- Same tech domain, different specialisation (e.g. Data Analyst for Data Engineer) → 35-55\n' +
      '- Related role with overlapping skills (e.g. Data Platform, Big Data, ETL, Cloud Engineer for Data Engineer) → 50-70\n' +
      '- Good match for role with most skills present → 60-80\n' +
      '- Excellent match — title + skills + seniority all align → 78-92\n\n' +
      'IMPORTANT: A job does not need to have the exact title "' + roleKeywords + '" to score well.\n' +
      'Related roles that use the same skills and experience should score 50+.\n\n' +
      'For "have": tech skills in the JD the candidate likely has (based on their role/resume, max 6).\n' +
      'For "missing": important skills in the JD the candidate likely lacks (max 5, be specific).\n\n' +
      'Return ONLY a JSON array, nothing else:\n' +
      '[{"index":0,"score":72,"have":["Python","SQL","Spark"],"missing":["dbt","Airflow"]},...]';

    let scores = [];
    try {
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: batchPrompt }],
      });
      const raw = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
      scores = JSON.parse(raw);
      console.log(`✅ Claude scored ${scores.length} jobs for ${email}`);
    } catch (scoreErr) {
      console.error('Batch scoring failed, using fallback:', scoreErr.message);
      // Fallback: simple role title match only
      scores = rawJobs.map((job, i) => {
        const titleMatch = (job.title||'').toLowerCase().includes((role||'').split(' ')[0].toLowerCase());
        return { index: i, score: titleMatch ? 55 : 25, have: [], missing: [] };
      });
    }

    // Merge scores with job data + apply premium company bonus
    const scoreMap = {};
    scores.forEach(s => { scoreMap[s.index] = s; });

    const jobs = rawJobs.map((job, i) => {
      const s           = scoreMap[i] || { score: 30, have: [], missing: [] };
      const companyName = (job.company ? job.company.display_name : '').toLowerCase();
      const isPremium   = [...premiumCompanies].some(c => companyName.includes(c));
      const baseScore   = Math.min(97, Math.max(1, parseInt(s.score)||30));
      // Premium company bonus: +5 points (capped at 99), shown in UI with a badge
      const finalScore  = isPremium ? Math.min(99, baseScore + 5) : baseScore;

      return {
        id:              job.id,
        title:           job.title,
        company:         job.company ? job.company.display_name : 'Company',
        isPremium:       isPremium,
        location:        job.location ? job.location.display_name : 'India',
        description:     (job.description||'').slice(0, 2000),
        url:             job.redirect_url,
        salaryMin:       job.salary_min || null,
        salaryMax:       job.salary_max || null,
        contractType:    job.contract_type || 'Full-time',
        created:         job.created,
        matchScore:      finalScore,
        keywordsHave:    (s.have    || []).slice(0, 8),
        keywordsMissing: (s.missing || []).slice(0, 6),
      };
    });

    // Filter out clearly irrelevant jobs (score < 20), then sort
    const relevantJobs = jobs.filter(j => j.matchScore >= 20);
    const filteredJobs = relevantJobs.length >= 5 ? relevantJobs : jobs; // fallback: keep all if too few
    filteredJobs.sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      return (b.isPremium ? 1 : 0) - (a.isPremium ? 1 : 0);
    });
    const jobs_final = filteredJobs;

    console.log(`✅ Jobs ready for ${email}: ${jobs_final.length}/${jobs.length} relevant jobs, top=${jobs_final[0]?.matchScore}`);
    res.json({ jobs: jobs_final, total: jobs_final.length });

  } catch (err) {
    console.error('Jobs error:', err.message);
    res.status(500).json({ error: 'Could not fetch jobs: ' + err.message });
  }
});

// POST /api/jobmatch — analyse JD against user's resume with Claude
app.post('/api/jobmatch', requireLogin, async (req, res) => {
  try {
    const { jd, customResume } = req.body;
    const { email, role, experience, tier } = req.session.user;

    // Free tier: 2 job match analyses per month
    if (!isPro(req.session.user)) {
      const users   = await readSheet('Users');
      const user    = users.find(u => u.Email.toLowerCase() === email.toLowerCase());
      const totalUsage = parseInt(user && user['JM Usage'] || '0');
      if (totalUsage >= 1) {
        return res.status(403).json({
          error: 'pro_required',
          message: 'Free plan includes 1 Job Match analysis. Upgrade to Pro for unlimited job matching.',
        });
      }
      // Increment usage counter
      try {
        const raw2  = await getSheetsClient().spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Users!A:Z' });
        const hdrs  = raw2.data.values[0];
        const rows  = raw2.data.values.slice(1);
        const eIdx  = hdrs.indexOf('Email');
        const rowIdx = rows.findIndex(r => (r[eIdx]||'').toLowerCase() === email.toLowerCase());
        if (rowIdx >= 0) {
          let jmIdx = hdrs.indexOf('JM Usage');
          let jmmIdx = hdrs.indexOf('JM Month');
          // Create columns if missing
          if (jmIdx === -1) { jmIdx = hdrs.length; await getSheetsClient().spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: 'Users!' + String.fromCharCode(65+jmIdx) + '1', valueInputOption: 'RAW', requestBody: { values: [['JM Usage']] } }); }
          if (jmmIdx === -1) { jmmIdx = hdrs.length + (jmIdx === hdrs.length ? 1 : 0); await getSheetsClient().spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: 'Users!' + String.fromCharCode(65+jmmIdx) + '1', valueInputOption: 'RAW', requestBody: { values: [['JM Month']] } }); }
          const sheetRow = rowIdx + 2;
          await getSheetsClient().spreadsheets.values.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { valueInputOption: 'RAW', data: [
            { range: 'Users!' + String.fromCharCode(65+jmIdx) + sheetRow, values: [[String(totalUsage + 1)]] },
          ]}});
        }
      } catch(e) { console.error('Usage track failed:', e.message); }
    }

    if (!jd || jd.trim().length < 50)
      return res.status(400).json({ error: 'Please paste a complete job description.' });

    // Get user's resume — priority: custom paste > saved resume text > ATS tips
    let resumeContext = customResume && customResume.trim().length > 30
      ? customResume.trim()
      : null;

    if (!resumeContext) {
      const users = await readSheet('Users');
      const user  = users.find(u => u.Email.toLowerCase() === email.toLowerCase());
      const savedResumeText = user ? (user['Resume Text'] || '') : '';
      const atsTips         = user ? (user['ATS Tips']    || '') : '';
      const atsScore        = user ? (user['ATS Score']   || '') : '';

      if (savedResumeText.length > 50) {
        resumeContext = savedResumeText;
        console.log(`📄 Using saved resume text (${savedResumeText.length} chars) for job match`);
      } else if (atsTips) {
        resumeContext = `ATS Score at signup: ${atsScore}/100. Resume feedback: ${atsTips}`;
        console.log('📄 Using ATS tips as resume context for job match');
      } else {
        resumeContext = 'No resume provided — analyse based on role and experience level only.';
      }
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are a senior recruiter and ATS specialist helping a candidate understand how well they match a specific job.

CANDIDATE PROFILE:
- Target Role: ${role}
- Experience: ${experience} years
- Resume / Profile Context: ${resumeContext.slice(0, 2500)}

JOB DESCRIPTION:
${jd.slice(0, 3000)}

Analyse the match carefully and return ONLY valid JSON — no markdown, no code fences, nothing else:
{
  "score": <integer 0-100>,
  "shortlist": "<High|Medium|Low>",
  "keywordsHave": ["keyword1", "keyword2", ...],
  "keywordsMissing": ["keyword1", "keyword2", ...],
  "tweaks": [
    "Specific, detailed resume change 1 tailored exactly to this job",
    "Specific, detailed resume change 2",
    "Specific, detailed resume change 3"
  ],
  "breakdown": [
    {"label": "Technical Skills Match", "score": <0-100>},
    {"label": "Experience Level Match", "score": <0-100>},
    {"label": "Domain / Industry Match", "score": <0-100>},
    {"label": "Keywords & ATS Score",    "score": <0-100>}
  ]
}

Scoring rules:
- Score generously for transferable skills — a candidate targeting this role likely has relevant experience even if their resume context is partial
- If resume context is limited, infer skills from their target role and experience years
- keywordsHave: up to 12 skills/tools from the JD the candidate clearly has or likely has given their background
- keywordsMissing: up to 8 genuinely missing keywords that are critical for this specific role (not generic ones)
- tweaks: 3 highly specific, actionable resume edits for THIS exact job — mention the company name, specific JD phrases, or metrics where possible. Each tweak should be 1-2 sentences
- shortlist: High = 70+, Medium = 45-69, Low = below 45
- Overall score: weighted average of breakdown scores (tech skills 40%, experience 30%, domain 20%, keywords 10%)`;

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-5', // Sonnet for deeper job match analysis
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw    = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
    const result = JSON.parse(raw);
    console.log(`✅ Job match for ${email}: ${result.score}/100 [${result.shortlist}]`);

    res.json({
      score:           Math.min(100, Math.max(0, parseInt(result.score)||0)),
      shortlist:       result.shortlist || 'Medium',
      keywordsHave:    result.keywordsHave   || [],
      keywordsMissing: result.keywordsMissing || [],
      tweaks:          result.tweaks         || [],
      breakdown:       result.breakdown      || [],
    });
  } catch (err) {
    console.error('Job match error:', err.message);
    res.status(500).json({ error: 'Could not analyse job match. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════
// generateAndCacheResource — shared logic used by both
// /api/resources (on-demand) and preloadWeek1Resources (post-payment)
// ══════════════════════════════════════════════════════
async function generateAndCacheResource(email, role, experience, week, day, taskTitle, taskType) {
  const cacheKey = `${email}|W${week}D${day}`;

  // Check cache first — don't regenerate if already exists
  try {
    const cached = await readSheet('Resources');
    const hit = cached.find(r => (r.CacheKey || '').trim() === cacheKey.trim());
    if (hit && hit.Data) {
      console.log(`📦 Cache hit — skipping: ${cacheKey}`);
      return JSON.parse(hit.Data);
    }
  } catch(e) { /* non-fatal */ }

  const Anthropic = require('@anthropic-ai/sdk');
  const client    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are an expert career coach and technical trainer for ${role} roles in India.

A candidate (${experience} experience, targeting ${role}) is working on this task:
TASK: "${taskTitle}"
TYPE: ${taskType} (Theory = learn concepts | Practice = hands-on | Mock = interview simulation)
WEEK: ${week} of 4 (Week 1=foundations, Week 2=technical depth, Week 3=interview practice, Week 4=final readiness)

Generate a personalised study resource for this task. Return ONLY valid JSON:
{
  "summary": "<2-3 sentence plain-English explanation of what this task covers and why it matters for ${role} interviews>",
  "cheatsheet": [
    "<key concept or fact — concise, specific, interview-relevant>",
    "<key concept or fact>",
    "<key concept or fact>",
    "<key concept or fact>",
    "<key concept or fact>",
    "<key concept or fact>"
  ],
  "practice": [
    "<specific action to do today — hands-on, concrete>",
    "<specific action to do today>",
    "<specific action to do today>"
  ],
  "resources": [
    { "title": "<resource title>", "url": "<real working URL>", "source": "<YouTube | Official Docs | GeeksforGeeks | Medium | etc>", "type": "<video | docs | article>" },
    { "title": "<resource title>", "url": "<real working URL>", "source": "<source name>", "type": "<video | docs | article>" },
    { "title": "<resource title>", "url": "<real working URL>", "source": "<source name>", "type": "<video | docs | article>" }
  ],
  "interviewTip": "<one highly specific tip: what interviewers at top Indian tech companies actually ask about this topic, and the #1 mistake candidates make>"
}

Rules:
- cheatsheet: exactly 6 points, each under 20 words, fact-dense and interview-ready
- practice: exactly 3 concrete actions for TODAY
- resources: ONLY real, well-known URLs (YouTube search URLs fine: https://www.youtube.com/results?search_query=...)
- interviewTip: specific to ${role} and this exact task — not generic advice`;

  const msg = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw    = msg.content[0].text.trim().replace(/```json|```/g, '').trim();
  const result = JSON.parse(raw);

  const payload = {
    summary:      result.summary      || '',
    cheatsheet:   result.cheatsheet   || [],
    practice:     result.practice     || [],
    resources:    result.resources    || [],
    interviewTip: result.interviewTip || '',
  };

  // Save to Resources sheet
  try {
    const today = new Date().toISOString().split('T')[0];
    await getSheetsClient().spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range:         'Resources!A:A',
      valueInputOption:  'RAW',
      insertDataOption:  'INSERT_ROWS',
      requestBody: { values: [[
        cacheKey, email, String(week), String(day), taskTitle, taskType, today,
        JSON.stringify(payload)
      ]]}
    });
    console.log(`✅ Cached: ${cacheKey}`);
  } catch(e) {
    console.error('Cache write failed (non-fatal):', e.message);
  }

  return payload;
}

// ── Pre-generate all 7 Week 1 study materials for a user (runs in background after payment) ──
async function preloadWeek1Resources(email, role, experience) {
  console.log(`🚀 Preloading Week 1 resources for ${email} (${role} — ${experience})`);

  // Fetch this user's Week 1 plan tasks from the Plans sheet
  let week1Tasks = [];
  try {
    const allPlans = await readSheet('Plans');
    week1Tasks = allPlans.filter(r =>
      (r.Email || '').toLowerCase() === email.toLowerCase() &&
      String(r.Week) === '1'
    );
  } catch(e) {
    console.error('preloadWeek1: could not read Plans:', e.message);
    return;
  }

  if (week1Tasks.length === 0) {
    console.warn(`⚠️  preloadWeek1: no Week 1 tasks found for ${email} — plan may still be generating`);
    return;
  }

  console.log(`📋 Found ${week1Tasks.length} Week 1 tasks — generating resources in parallel`);

  // Run all 7 in parallel (Haiku is fast, parallel is safe at this scale)
  const results = await Promise.allSettled(
    week1Tasks.map(task =>
      generateAndCacheResource(
        email, role, experience,
        1,                          // week
        parseInt(task.Day) || 1,    // day
        task.Task || task.Title || task.TaskTitle || '',
        task.Type || task.TaskType || 'Theory'
      )
    )
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed    = results.filter(r => r.status === 'rejected').length;
  console.log(`✅ Week 1 preload done for ${email}: ${succeeded} succeeded, ${failed} failed`);
}

// POST /api/resources — generate cheatsheet + curated links (uses shared generateAndCacheResource)
app.post('/api/resources', requirePro, async (req, res) => {
  try {
    const { week, day, taskTitle, taskType } = req.body;
    const { email, role, experience } = req.session.user;

    if (!taskTitle) return res.status(400).json({ error: 'Task title required' });

    console.log(`🔨 Resource request: ${email} W${week}D${day} "${taskTitle}"`);
    const payload = await generateAndCacheResource(email, role, experience, week, day, taskTitle, taskType);
    res.json(payload);
  } catch (err) {
    console.error('Resources error:', err.message);
    res.status(500).json({ error: 'Could not generate resources. Please try again.' });
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
      resumeText: user['Resume Text'] || null,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load resume data' });
  }
});

// POST /api/resume/upload — upload PDF/DOCX, store on Drive, extract text
app.post('/api/resume/upload', requireLogin, upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { email } = req.session.user;
    const { buffer, originalname, mimetype, size } = req.file;

    // Validate file type
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ];
    if (!allowed.includes(mimetype))
      return res.status(400).json({ error: 'Only PDF and DOCX files are supported' });

    console.log(`📤 Uploading resume for ${email}: ${originalname} (${Math.round(size/1024)}KB)`);

    // 1. Extract text from file
    const resumeText = await extractResumeText(buffer, mimetype);
    console.log(`📝 Extracted ${resumeText.length} chars from resume`);

    // 2. Upload to Google Drive
    let driveUrl = null;
    try {
      const driveResult = await uploadToDrive(buffer, originalname, mimetype, email);
      driveUrl = driveResult.viewUrl;
      console.log(`✅ Uploaded to Drive: ${driveUrl}`);
    } catch (driveErr) {
      console.error('Drive upload failed:', driveErr.message);
      // Continue — still save text even if Drive fails
    }

    // 3. Save resumeText + driveUrl to Users sheet
    const raw = await getSheetsClient().spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'Users!A:Z'
    });
    const [headers, ...rows] = raw.data.values || [];
    const emailIdx = headers.indexOf('Email');

    // Ensure Resume Text and Resume URL columns exist
    let resumeTextIdx = headers.indexOf('Resume Text');
    let resumeUrlIdx  = headers.indexOf('Resume URL');

    const newHeaders = [];
    if (resumeTextIdx === -1) {
      resumeTextIdx = headers.length + newHeaders.length;
      newHeaders.push({ col: resumeTextIdx, header: 'Resume Text' });
    }
    if (resumeUrlIdx === -1) {
      resumeUrlIdx = headers.length + newHeaders.length;
      newHeaders.push({ col: resumeUrlIdx, header: 'Resume URL' });
    }

    // Write any new column headers
    for (const h of newHeaders) {
      await getSheetsClient().spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: 'Users!' + String.fromCharCode(65 + h.col) + '1',
        valueInputOption: 'RAW',
        requestBody: { values: [[h.header]] }
      });
    }

    // Find user row and update
    const rowIdx = rows.findIndex(r => (r[emailIdx]||'').toLowerCase() === email.toLowerCase());
    if (rowIdx === -1) return res.status(404).json({ error: 'User not found' });
    const sheetRow = rowIdx + 2;

    const updates = [];
    if (resumeText) updates.push({
      range: 'Users!' + String.fromCharCode(65 + resumeTextIdx) + sheetRow,
      values: [[resumeText.slice(0, 10000)]] // cap at 10k chars for sheet
    });
    if (driveUrl) updates.push({
      range: 'Users!' + String.fromCharCode(65 + resumeUrlIdx) + sheetRow,
      values: [[driveUrl]]
    });

    if (updates.length) {
      await getSheetsClient().spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: { valueInputOption: 'RAW', data: updates }
      });
    }

    res.json({
      success:    true,
      driveUrl:   driveUrl,
      textLength: resumeText.length,
      message:    resumeText.length > 100
        ? 'Resume uploaded and text extracted successfully!'
        : 'Resume uploaded! Text extraction was limited — Job Match will use available data.',
    });
  } catch (err) {
    console.error('Resume upload error:', err.message);
    res.status(500).json({ error: 'Upload failed: ' + err.message });
  }
});

// POST /api/resume/save — save resume text to Users sheet
app.post('/api/resume/save', requireLogin, async (req, res) => {
  try {
    const { resumeText } = req.body;
    const email = req.session.user.email;
    if (!resumeText || resumeText.trim().length < 20)
      return res.status(400).json({ error: 'Resume text too short' });

    // Find user row in sheet
    const raw = await getSheetsClient().spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: 'Users!A:Z'
    });
    const [headers, ...rows] = raw.data.values || [];
    const emailIdx = headers.indexOf('Email');

    // Find or add 'Resume Text' column
    let resumeTextIdx = headers.indexOf('Resume Text');
    if (resumeTextIdx === -1) {
      // Add header to first empty column
      resumeTextIdx = headers.length;
      await getSheetsClient().spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `Users!${String.fromCharCode(65+resumeTextIdx)}1`,
        valueInputOption: 'RAW',
        requestBody: { values: [['Resume Text']] }
      });
    }

    const rowIdx = rows.findIndex(r => (r[emailIdx]||'').toLowerCase() === email.toLowerCase());
    if (rowIdx === -1) return res.status(404).json({ error: 'User not found' });
    const sheetRow = rowIdx + 2;

    await getSheetsClient().spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Users!${String.fromCharCode(65+resumeTextIdx)}${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[resumeText.trim()]] }
    });

    console.log(`✅ Resume text saved for ${email} (${resumeText.length} chars)`);
    res.json({ success: true });
  } catch (err) {
    console.error('Resume save error:', err.message);
    res.status(500).json({ error: 'Could not save resume' });
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
    const myQuestions = questionRows.filter(r => r.Email.toLowerCase() === email.toLowerCase() && parseInt(r.Week) <= week);

    const tasksDone   = myPlan.filter(r => r.Status === 'Done').length;
    const totalTasks  = myPlan.length;
    // Use last appended row as latest (date sort breaks when multiple same-day submissions)
    const latestScore = myScores.length ? myScores[myScores.length - 1] : null;
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

// ── Welcome tokens: email → { name, role, atsScore, atsTips, createdAt } ──
const welcomeTokens = new Map();   // token → data
const emailTokenMap = new Map();   // email → token (for polling)
const processingEmails = new Set(); // emails currently being processed
// Clean up tokens older than 24 hours every hour
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [token, data] of welcomeTokens.entries()) {
    if (data.createdAt < cutoff) welcomeTokens.delete(token);
  }
}, 60 * 60 * 1000);

// GET /api/welcome/:token — fetch welcome data for results page (no login needed)
app.get('/api/welcome/:token', async (req, res) => {
  const data = welcomeTokens.get(req.params.token);
  if (!data) return res.status(404).json({ error: 'Welcome data not found or expired' });
  res.json(data);
});

// POST /api/trigger-plan — called when user clicks "Go to Dashboard" on welcome page
// This is what actually kicks off Phase 2 (plan generation)
app.post('/api/trigger-plan', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'No token' });

  const welcomeData = welcomeTokens.get(token);
  if (!welcomeData) return res.status(404).json({ error: 'Token not found or expired' });

  const { email } = welcomeData;
  if (!email) return res.status(400).json({ error: 'No email in token' });

  // Prevent double-triggering
  if (welcomeData.planTriggered) {
    console.log(`ℹ️  Plan already triggered for ${email} — skipping`);
    return res.json({ ok: true, alreadyTriggered: true });
  }
  welcomeData.planTriggered = true;

  console.log(`🚀 Plan generation triggered by user click for ${email}`);
  res.json({ ok: true });

  // Run Phase 2 in background
  const { triggerPhase2 } = require('./onboarding');
  triggerPhase2(email, getSheetsClient, SHEET_ID)
    .then(() => console.log(`✅ Phase 2 complete for ${email}`))
    .catch(e => console.error(`❌ Phase 2 failed for ${email}:`, e.message));
});

// POST /api/onboard — Tally webhook → Claude → Sheets → Email
// ══════════════════════════════════════════════════════
app.post('/api/onboard', async (req, res) => {
  console.log('\n📥 Tally webhook received at', new Date().toISOString());
  console.log('Headers:', JSON.stringify({
    'content-type': req.headers['content-type'],
    'tally-webhook-secret': req.headers['tally-webhook-secret'] ? '***set***' : 'NOT SET',
    'user-agent': req.headers['user-agent'],
  }));
  console.log('Body keys:', Object.keys(req.body || {}));

  // Verify Tally webhook secret (optional but recommended)
  const secret = process.env.TALLY_WEBHOOK_SECRET;
  if (secret && req.headers['tally-webhook-secret'] !== secret) {
    console.error('❌ Webhook secret mismatch — rejecting');
    return res.status(401).json({ error: 'Invalid webhook secret' });
  }

  // Extract email early so we can track processing state
  let earlyEmail = null;
  try {
    const fields = (req.body?.data?.fields || req.body?.fields || []);
    // Try multiple strategies to find email — field type, label, then Tally meta
    const emailField =
      fields.find(f => f.type === 'INPUT_EMAIL') ||
      fields.find(f => (f.label || '').toLowerCase().includes('email address')) ||
      fields.find(f => (f.label || '').toLowerCase().includes('email'));
    const emailFromMeta = req.body?.data?.respondentEmail || req.body?.respondentEmail || '';
    earlyEmail = (emailField?.value || emailFromMeta || '').trim().toLowerCase() || null;
    if (earlyEmail) {
      processingEmails.add(earlyEmail.toLowerCase());
      console.log(`⏳ Processing started for: ${earlyEmail}`);
    }
  } catch(e) { /* non-fatal */ }

  // Respond to Tally immediately (Tally expects fast response)
  res.json({ received: true });
  console.log('✅ Responded 200 to Tally');

  // Run onboarding async (so Tally doesn't time out)
  const result = await runOnboarding(req.body, getSheetsClient, SHEET_ID);
  if (result.success) {
    console.log(`✅ Onboarding complete: ${result.email}`);
    if (result.welcomeData) {
      const crypto  = require('crypto');
      const token   = crypto.randomBytes(20).toString('hex');
      welcomeTokens.set(token, { ...result.welcomeData, createdAt: Date.now() });
      emailTokenMap.set(result.email.toLowerCase(), token);
      const appUrl     = process.env.APP_URL || process.env.DASHBOARD_URL || 'https://your-app.railway.app';
      const welcomeUrl = appUrl + '/welcome?token=' + token;
      console.log(`🎉 Welcome page for ${result.email}: ${welcomeUrl}`);

      // Send a follow-up "results ready" email with the welcome URL
      if (process.env.BREVO_API_KEY && result.welcomeData.email) {
        const wd = result.welcomeData;
        const firstName = (wd.name || '').split(' ')[0] || 'there';
        const score     = wd.atsScore || 0;
        const scoreColor = score >= 75 ? '#00b38a' : score >= 55 ? '#f59e0b' : '#e84040';
        const emailHtml =
          '<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9ff;padding:32px 20px">' +
          '<div style="background:linear-gradient(135deg,#00b38a,#5048e5);border-radius:16px;padding:28px;color:white;text-align:center;margin-bottom:24px">' +
            '<div style="font-size:26px;font-weight:900;letter-spacing:3px;margin-bottom:4px">ROLEKRAFT</div>' +
            '<div style="font-size:14px;opacity:.85">Your Resume Analysis + 30-Day Plan is Ready</div>' +
          '</div>' +
          '<div style="background:white;border-radius:14px;padding:28px;margin-bottom:16px;border:1px solid rgba(0,0,0,.07)">' +
            '<p style="font-size:18px;font-weight:700;margin-bottom:12px">Hi ' + firstName + '! 🎉</p>' +
            '<p style="color:#6b6b8a;line-height:1.7;margin-bottom:20px">Your <strong>' + wd.role + '</strong> interview prep plan is ready. Claude AI has analysed your resume and built your personalised 4-week plan.</p>' +
            '<div style="background:#f8f9ff;border-radius:10px;padding:18px;margin-bottom:20px;text-align:center">' +
              '<div style="font-size:12px;color:#6b6b8a;letter-spacing:2px;margin-bottom:8px;font-weight:600">YOUR ATS SCORE</div>' +
              '<div style="font-size:52px;font-weight:900;color:' + scoreColor + ';line-height:1">' + score + '</div>' +
              '<div style="font-size:12px;color:#6b6b8a;margin-top:4px">out of 100</div>' +
            '</div>' +
            '<a href="' + welcomeUrl + '" style="display:block;background:linear-gradient(135deg,#00b38a,#5048e5);color:white;text-align:center;padding:14px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:16px">View My Results + 30-Day Plan →</a>' +
            '<p style="color:#9999bb;font-size:12px;text-align:center;margin:0">Link expires in 24 hours · Your dashboard login was sent separately</p>' +
          '</div></div>';

        try {
          const { sendBrevoEmail } = require('./onboarding');
          // sendBrevoEmail may not be exported — use direct API call
          const https2 = require('https');
          const payload2 = JSON.stringify({
            sender: { name: 'RoleKraft', email: process.env.BREVO_SENDER_EMAIL || 'noreply@rolecraft.ai' },
            to: [{ email: wd.email, name: wd.name }],
            subject: firstName + ', your resume scored ' + score + '/100 — see your full plan',
            htmlContent: emailHtml,
          });
          const opts2 = {
            hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY, 'Content-Length': Buffer.byteLength(payload2) }
          };
          const req2 = https2.request(opts2, r2 => { let d=''; r2.on('data',c=>d+=c); r2.on('end',()=>console.log('📧 Results email sent:', r2.statusCode)); });
          req2.on('error', e => console.error('Results email error:', e.message));
          req2.write(payload2); req2.end();
        } catch(emailErr) {
          console.error('Results email failed:', emailErr.message);
        }
      }
    }
  } else {
    console.error(`❌ Onboarding failed: ${result.error}`);
  }
});

// GET /api/session-test — verify session is working
app.get('/api/session-test', (req, res) => {
  if (!req.session.testCount) req.session.testCount = 0;
  req.session.testCount++;
  res.json({
    count:      req.session.testCount,
    hasUser:    !!req.session.user,
    userEmail:  req.session.user?.email || null,
    sessionKeys: Object.keys(req.session),
  });
});


// ── robots.txt ──
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`User-agent: *
Allow: /
Disallow: /app
Disallow: /processing
Disallow: /welcome
Disallow: /api/
Disallow: /register

Sitemap: https://www.rolekraft.com/sitemap.xml`);
});

// ── sitemap.xml ──
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.rolekraft.com/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://www.rolekraft.com/privacy</loc>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>https://www.rolekraft.com/refund</loc>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
</urlset>`);
});

// GET /register — redirect to correct Tally form based on environment
app.get('/register', (req, res) => {
  const tallyUrl = process.env.TALLY_FORM_URL || 'https://tally.so/r/D4NpLX';
  res.redirect(tallyUrl);
});

// GET /api/onboard/ping — test that onboard endpoint is reachable
app.get('/api/onboard/ping', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Onboard endpoint is live',
    webhookUrl: (process.env.APP_URL || 'https://your-app.railway.app') + '/api/onboard',
    sheetConfigured: !!process.env.SHEET_ID,
    tallySecretSet: !!process.env.TALLY_WEBHOOK_SECRET,
    timestamp: new Date().toISOString(),
  });
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
// ══════════════════════════════════════════════════════
// RAZORPAY PAYMENT ROUTES
// ══════════════════════════════════════════════════════

// POST /api/payment/create-order — create Razorpay order
app.post('/api/payment/create-order', requireLogin, async (req, res) => {
  try {
    const { plan } = req.body; // 'pro_monthly' | 'pro_yearly' | 'premium_monthly' | 'premium_yearly'
    const { email, name } = req.session.user;

    const plans = {
      pro_monthly:      { amount: 49900,  label: 'Pro Monthly',  tier: 'pro',     months: 1  },
      pro_yearly:       { amount: 399900, label: 'Pro Yearly',   tier: 'pro',     months: 12 },
      premium_monthly:  { amount: 99900,  label: 'Premium Monthly', tier: 'premium', months: 1 },
      premium_yearly:   { amount: 799900, label: 'Premium Yearly',  tier: 'premium', months: 12 },
    };

    const selected = plans[plan];
    if (!selected) return res.status(400).json({ error: 'Invalid plan' });

    const keyId     = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) return res.status(500).json({ error: 'Payment not configured' });

    // Create Razorpay order via API
    const https      = require('https');
    const orderData  = JSON.stringify({
      amount:   selected.amount,
      currency: 'INR',
      receipt:  'rc_' + Date.now(),
      notes:    { email, plan, tier: selected.tier },
    });

    const order = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'api.razorpay.com',
        path:     '/v1/orders',
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(orderData),
          'Authorization':  'Basic ' + Buffer.from(keyId + ':' + keySecret).toString('base64'),
        },
      };
      const req2 = https.request(opts, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      });
      req2.on('error', reject);
      req2.write(orderData);
      req2.end();
    });

    res.json({
      orderId:   order.id,
      amount:    selected.amount,
      currency:  'INR',
      keyId:     keyId,
      planLabel: selected.label,
      email,
      name,
    });
  } catch (err) {
    console.error('Create order error:', err.message);
    res.status(500).json({ error: 'Could not create payment order: ' + err.message });
  }
});

// POST /api/payment/verify — verify Razorpay signature and activate tier
app.post('/api/payment/verify', requireLogin, async (req, res) => {
  try {
    const { orderId, paymentId, signature, plan } = req.body;
    const { email } = req.session.user;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    // Verify HMAC signature
    const crypto   = require('crypto');
    const expected = crypto.createHmac('sha256', keySecret)
      .update(orderId + '|' + paymentId)
      .digest('hex');

    if (expected !== signature) {
      return res.status(400).json({ error: 'Payment verification failed — invalid signature' });
    }

    // Calculate expiry date
    const planMeta = {
      pro_monthly:      { tier: 'pro',     months: 1  },
      pro_yearly:       { tier: 'pro',     months: 12 },
      premium_monthly:  { tier: 'premium', months: 1  },
      premium_yearly:   { tier: 'premium', months: 12 },
    };
    const meta    = planMeta[plan] || { tier: 'pro', months: 1 };
    const expiry  = new Date();
    expiry.setMonth(expiry.getMonth() + meta.months);
    const expiryStr = expiry.toISOString().split('T')[0];

    // Update Users sheet — Tier and Tier Expiry columns
    const raw    = await getSheetsClient().spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Users!A:Z' });
    const hdrs   = raw.data.values[0];
    const rows   = raw.data.values.slice(1);
    const eIdx   = hdrs.indexOf('Email');
    const rowIdx = rows.findIndex(r => (r[eIdx]||'').toLowerCase() === email.toLowerCase());
    if (rowIdx === -1) return res.status(404).json({ error: 'User not found' });

    const sheetRow = rowIdx + 2;

    // Ensure Tier and Tier Expiry columns exist
    let tierIdx   = hdrs.indexOf('Tier');
    let expiryIdx = hdrs.indexOf('Tier Expiry');
    if (tierIdx   === -1) { tierIdx   = hdrs.length;     await getSheetsClient().spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: 'Users!' + String.fromCharCode(65+tierIdx)   + '1', valueInputOption: 'RAW', requestBody: { values: [['Tier']] } }); }
    if (expiryIdx === -1) { expiryIdx = hdrs.length + 1; await getSheetsClient().spreadsheets.values.update({ spreadsheetId: SHEET_ID, range: 'Users!' + String.fromCharCode(65+expiryIdx) + '1', valueInputOption: 'RAW', requestBody: { values: [['Tier Expiry']] } }); }

    await getSheetsClient().spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: [
          { range: 'Users!' + String.fromCharCode(65+tierIdx)   + sheetRow, values: [[meta.tier]] },
          { range: 'Users!' + String.fromCharCode(65+expiryIdx) + sheetRow, values: [[expiryStr]] },
        ]
      }
    });

    // Update session immediately
    req.session.user.tier        = meta.tier;
    req.session.user.tierExpiry  = expiryStr;

    console.log(`✅ Payment verified: ${email} → ${meta.tier} until ${expiryStr}`);
    res.json({ success: true, tier: meta.tier, expiryStr });

    // ── Fire Week 1 resource preload in background (non-blocking) ──
    // User gets instant response above; this runs while they see the success modal
    const { role, experience } = req.session.user;
    setImmediate(async () => {
      try {
        await preloadWeek1Resources(email, role, experience);
      } catch(e) {
        console.error('Week 1 preload failed (non-fatal):', e.message);
      }
    });

  } catch (err) {
    console.error('Verify payment error:', err.message);
    res.status(500).json({ error: 'Verification failed: ' + err.message });
  }
});

// GET /api/me/tier — get current user tier (for UI checks)
app.get('/api/me/tier', requireLogin, (req, res) => {
  const { tier, tierExpiry } = req.session.user;
  res.json({ tier: tier || 'free', tierExpiry: tierExpiry || null });
});

// ── Google OAuth routes ──
app.get('/auth/google/status', (req, res) => {
  const enabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  res.json({ enabled });
});

app.get('/auth/google',
  (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/app?error=google_not_configured');
    next();
  },
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  (req, res, next) => {
    if (!process.env.GOOGLE_CLIENT_ID) return res.redirect('/app?error=google_not_configured');
    next();
  },
  (req, res, next) => {
    passport.authenticate('google', (err, user, info) => {
      if (err) {
        console.error('Google OAuth error:', err.message);
        return res.redirect('/app?error=google_auth_failed');
      }
      if (!user) {
        console.error('Google OAuth no user:', info);
        return res.redirect('/app?error=google_auth_failed');
      }
      console.log('✅ Google login success:', user.email, '| needsOnboarding:', user.needsOnboarding);

      if (user.needsOnboarding) {
        // New Google user — NOT in sheet yet — send directly to Tally, no session set
        // This prevents any flash of dashboard before redirect
        const tallyBase = process.env.TALLY_FORM_URL || 'https://tally.so/r/D4NpLX';
        const tallyUrl  = tallyBase + '?email=' + encodeURIComponent(user.email) + '&name=' + encodeURIComponent(user.name || '');
        console.log('⏩ New Google user — redirecting to Tally (no session):', user.email);
        return res.redirect(tallyUrl);
      }

      // Existing user — set session and go to dashboard
      req.session.user = user;
      return res.send(`<!DOCTYPE html><html><head>
        <meta http-equiv="refresh" content="0;url=/app">
        <script>window.location.href='/app';</script>
        </head><body>Redirecting...</body></html>`);
    })(req, res, next);
  }
);

// ── Razorpay Webhook — backup payment confirmation ──
app.post('/api/payment/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const secret    = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    // Verify webhook signature if secret is set
    if (secret) {
      const crypto   = require('crypto');
      const expected = crypto.createHmac('sha256', secret)
        .update(req.body).digest('hex');
      if (expected !== signature) {
        console.error('❌ Razorpay webhook signature mismatch');
        return res.status(400).json({ error: 'Invalid signature' });
      }
    }

    const event = JSON.parse(req.body);
    console.log('📦 Razorpay webhook:', event.event);

    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity;
      const email   = (payment.email || payment.notes?.email || '').toLowerCase().trim();
      const plan    = payment.notes?.plan || 'pro_monthly';

      if (!email) { console.warn('⚠️  Webhook: no email in payment'); return res.json({ ok: true }); }

      const planMeta = {
        pro_monthly:     { tier: 'pro',     months: 1  },
        pro_yearly:      { tier: 'pro',     months: 12 },
        premium_monthly: { tier: 'premium', months: 1  },
        premium_yearly:  { tier: 'premium', months: 12 },
      };
      const meta   = planMeta[plan] || { tier: 'pro', months: 1 };
      const expiry = new Date();
      expiry.setMonth(expiry.getMonth() + meta.months);
      const expiryStr = expiry.toISOString().split('T')[0];

      // Update sheet
      const sheets = getSheetsClient();
      const raw    = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Users!A:AZ' });
      const hdrs   = raw.data.values[0];
      const rows   = raw.data.values.slice(1);
      const eIdx   = hdrs.findIndex(h => h.trim() === 'Email');
      const tIdx   = hdrs.findIndex(h => h.trim() === 'Tier');
      const xIdx   = hdrs.findIndex(h => h.trim() === 'Tier Expiry');
      const rowIdx = rows.findIndex(r => (r[eIdx]||'').toLowerCase() === email);

      if (rowIdx === -1) { console.warn('⚠️  Webhook: user not found:', email); return res.json({ ok: true }); }

      const sheetRow = rowIdx + 2;
      const tierCol  = String.fromCharCode(65 + tIdx);
      const xCol     = String.fromCharCode(65 + xIdx);

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SHEET_ID,
        requestBody: {
          valueInputOption: 'RAW',
          data: [
            { range: 'Users!' + tierCol + sheetRow, values: [[meta.tier]] },
            { range: 'Users!' + xCol   + sheetRow, values: [[expiryStr]] },
          ]
        }
      });

      console.log('✅ Webhook: upgraded', email, '→', meta.tier, 'until', expiryStr);

      // Preload Week 1 resources in background (same as payment/verify route)
      setImmediate(async () => {
        try {
          const userRows  = await readSheet('Users');
          const userRow   = userRows.find(r => (r.Email||'').toLowerCase() === email);
          const userRole  = userRow?.Role || '';
          const userExp   = userRow?.Experience || 'Mid';
          if (userRole) await preloadWeek1Resources(email, userRole, userExp);
        } catch(e) {
          console.error('Webhook Week 1 preload failed (non-fatal):', e.message);
        }
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Page routes ──
// GET /api/ready?email=... — polling endpoint for processing page
app.get('/api/ready', async (req, res) => {
  const email = (req.query.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email required' });

  // 1. Check in-memory token map (fastest path — normal flow)
  const token = emailTokenMap.get(email);
  if (token) return res.json({ ready: true, token });

  // 2. Still processing
  if (processingEmails.has(email)) return res.json({ ready: false, processing: true });

  // 3. Fallback — check Sheet to see if user exists (handles post-redeploy token loss)
  // If user row exists with Plan Active = TRUE, plan is ready — issue a fresh token
  try {
    const sheets   = getSheetsClient();
    const resp     = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: 'Users!A:Q' });
    const rows     = resp.data.values || [];
    const userRow  = rows.find((r, i) => i > 0 && (r[0]||'').toLowerCase() === email);
    if (userRow) {
      const planActive = (userRow[6]||'').toUpperCase() === 'TRUE'; // col G
      if (planActive) {
        // Plan is ready but token was lost (redeploy) — create fresh token from Sheet data
        const crypto = require('crypto');
        const freshToken = crypto.randomBytes(20).toString('hex');
        const welcomePayload = {
          name:     userRow[1] || '',
          email,
          role:     userRow[3] || '',
          atsScore: parseInt(userRow[7]) || 0,
          atsTips:  userRow[8] || '',
          taskCount: 28,
          qCount:   28,
          planReady: true,
          createdAt: Date.now(),
        };
        welcomeTokens.set(freshToken, welcomePayload);
        emailTokenMap.set(email, freshToken);
        console.log('🔄 Fresh token issued from Sheet for', email, '(post-redeploy recovery)');
        return res.json({ ready: true, token: freshToken });
      }
      // User exists but plan not ready yet — still processing
      return res.json({ ready: false, processing: true });
    }
  } catch(e) {
    console.error('Sheet fallback in /api/ready failed:', e.message);
  }

  // Unknown — webhook may not have arrived yet, keep polling
  return res.json({ ready: false, processing: false });
});

app.get('/',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
function noCache(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  next();
}
app.get('/app',        noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.html')));
app.get('/welcome',    noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'welcome.html')));
app.get('/processing', noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'processing.html')));
app.get('/privacy',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/privacy.html',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/refund',        (req, res) => res.sendFile(path.join(__dirname, 'public', 'refund.html')));
app.get('/refund.html',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'refund.html')));
app.get('/index.html',    (req, res) => res.redirect('/app'));
app.get('*',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));

// ── Start ──
app.listen(PORT, () => {
  console.log(`✅ CareerAI server running on http://localhost:${PORT}`);
  if (!process.env.SHEET_ID) console.warn('⚠️  SHEET_ID not set in .env');
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) console.warn('⚠️  GOOGLE_SERVICE_ACCOUNT_JSON not set in .env');
});
