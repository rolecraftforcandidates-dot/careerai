require('dotenv').config();
const express    = require('express');
const session    = require('express-session');
const helmet     = require('helmet');
const cors       = require('cors');
const path       = require('path');
const { google } = require('googleapis');
const multer    = require('multer');
const upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max
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

  // Get or create a 'RoleCraft Resumes' folder
  let folderId = process.env.DRIVE_RESUME_FOLDER_ID || null;

  if (!folderId) {
    // Check if folder exists
    const folderSearch = await drive.files.list({
      q: "name='RoleCraft Resumes' and mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id)',
    });
    if (folderSearch.data.files.length > 0) {
      folderId = folderSearch.data.files[0].id;
    } else {
      // Create it
      const folder = await drive.files.create({
        requestBody: { name: 'RoleCraft Resumes', mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id',
      });
      folderId = folder.data.id;
      console.log('📁 Created RoleCraft Resumes folder:', folderId);
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

// POST /api/questions/submit — submit answer + instantly score with Claude
app.post('/api/questions/submit', requireLogin, async (req, res) => {
  try {
    const { questionNo, answer, weekOverride } = req.body;
    const { email, role, experience } = req.session.user;
    const week = weekOverride ? parseInt(weekOverride) : req.session.user.week;
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
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
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

    // Build a precise search query — use key terms from role to avoid broad matches
    // e.g. "Data Engineer" not just "engineer", "Frontend Developer" not just "developer"
    const roleKeywords = (role || 'software engineer').trim();
    const searchQuery  = encodeURIComponent(roleKeywords);

    const locationMap = {
      india: '', bangalore: 'bangalore', mumbai: 'mumbai',
      delhi: 'delhi', hyderabad: 'hyderabad', pune: 'pune', chennai: 'chennai'
    };
    const locationParam = locationMap[location] || '';
    const locationStr   = locationParam ? '&where=' + encodeURIComponent(locationParam) : '';

    // Fetch last 7 days, 30 results, sorted by date, title-only search for precision
    // &title_only=1 ensures the role appears in the job title (not just description)
    // &max_days_old=7 gets last week of postings
    const url = 'https://api.adzuna.com/v1/api/jobs/in/search/1' +
      '?app_id=' + appId + '&app_key=' + appKey +
      '&what_or=' + searchQuery +
      locationStr +
      '&results_per_page=30' +
      '&max_days_old=7' +
      '&content-type=application/json' +
      '&sort_by=date';

    console.log('Adzuna URL:', url.replace(appKey, '***'));

    const https   = require('https');
    const adzData = await new Promise((resolve, reject) => {
      https.get(url, (r) => {
        let data = '';
        r.on('data', c => data += c);
        r.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(new Error('Invalid Adzuna response: ' + data.slice(0,200))); }
        });
      }).on('error', reject);
    });

    let rawJobs = adzData.results || [];
    if (!rawJobs.length) return res.json({ jobs: [], message: 'No jobs found for this role and location in the last 7 days.' });

    // ── Pre-filter: remove jobs that are clearly wrong role ──
    // Keep only jobs where title contains at least one meaningful word from target role
    const roleWords = roleKeywords.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3); // skip short words like "of", "and"

    const relevant = rawJobs.filter(job => {
      const titleLower = (job.title || '').toLowerCase();
      return roleWords.some(word => titleLower.includes(word));
    });

    // Use filtered list if we have enough, otherwise fall back to all results
    rawJobs = relevant.length >= 5 ? relevant : rawJobs;
    console.log('Jobs after title filter: ' + rawJobs.length + ' (from ' + (adzData.results||[]).length + ' total)');

    // Limit to 20 for Claude scoring
    rawJobs = rawJobs.slice(0, 20);

    // Get user profile for matching
    const users      = await readSheet('Users');
    const user       = users.find(u => u.Email.toLowerCase() === email.toLowerCase());
    const resumeText = (user && user['Resume Text']) || (user && user['ATS Tips']) || '';

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

    const batchPrompt = 'You are a strict job matching expert for Indian tech companies. Score each job for this candidate.\n\n' +
      'CANDIDATE:\n' +
      '- Target Role: ' + roleKeywords + '\n' +
      '- Years Experience: ' + experience + '\n' +
      '- Resume/Skills: ' + (resumeText ? resumeText.slice(0,1500) : 'Use role and experience only') + '\n\n' +
      'JOB LISTINGS:\n' + jobListText + '\n\n' +
      'SCORING RULES (be strict and honest):\n' +
      '- If the job title has NOTHING to do with ' + roleKeywords + ' → score 5-15. No exceptions.\n' +
      '- If the job is in the same broad tech domain but different specialisation → score 20-40\n' +
      '- If the job matches the role but seniority is wrong → score 35-55\n' +
      '- If the job is a good match for role and experience → score 55-75\n' +
      '- If the job is an excellent match (title + skills + seniority all align) → score 75-92\n\n' +
      'For "have" list: skills from the JD the candidate clearly has (max 6, specific tech skills only).\n' +
      'For "missing" list: important skills in JD the candidate lacks (max 5, specific and actionable).\n\n' +
      'Return ONLY a JSON array, no explanation:\n' +
      '[{"index":0,"score":72,"have":["Python","SQL"],"missing":["dbt","Airflow"]},...]';

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

    // Merge scores with job data
    const scoreMap = {};
    scores.forEach(s => { scoreMap[s.index] = s; });

    const jobs = rawJobs.map((job, i) => {
      const s = scoreMap[i] || { score: 30, have: [], missing: [] };
      return {
        id:              job.id,
        title:           job.title,
        company:         job.company ? job.company.display_name : 'Company',
        location:        job.location ? job.location.display_name : 'India',
        description:     (job.description||'').slice(0, 2000),
        url:             job.redirect_url,
        salaryMin:       job.salary_min || null,
        salaryMax:       job.salary_max || null,
        contractType:    job.contract_type || 'Full-time',
        created:         job.created,
        matchScore:      Math.min(99, Math.max(1, parseInt(s.score)||30)),
        keywordsHave:    (s.have    || []).slice(0, 8),
        keywordsMissing: (s.missing || []).slice(0, 6),
      };
    });

    // Sort by match score descending
    jobs.sort((a, b) => b.matchScore - a.matchScore);

    console.log(`✅ Jobs ready for ${email}: top score=${jobs[0]?.matchScore}, bottom=${jobs[jobs.length-1]?.matchScore}`);
    res.json({ jobs, total: adzData.count || jobs.length });

  } catch (err) {
    console.error('Jobs error:', err.message);
    res.status(500).json({ error: 'Could not fetch jobs: ' + err.message });
  }
});

// POST /api/jobmatch — analyse JD against user's resume with Claude
app.post('/api/jobmatch', requireLogin, async (req, res) => {
  try {
    const { jd, customResume } = req.body;
    const { email, role, experience } = req.session.user;

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

    const prompt = `You are an expert ATS and recruitment specialist analysing a candidate's fit for a job.

CANDIDATE PROFILE:
- Target Role: ${role}
- Experience: ${experience} years
- Resume / Profile Context: ${resumeContext.slice(0, 2500)}

JOB DESCRIPTION:
${jd.slice(0, 3000)}

Analyse the match and return ONLY valid JSON — no markdown, no code fences, nothing else:
{
  "score": <integer 0-100, overall match score>,
  "shortlist": "<High|Medium|Low — likelihood of being shortlisted>",
  "keywordsHave": ["keyword1", "keyword2", ...],
  "keywordsMissing": ["keyword1", "keyword2", ...],
  "tweaks": [
    "Specific resume change 1 to better match this JD",
    "Specific resume change 2",
    "Specific resume change 3"
  ],
  "breakdown": [
    {"label": "Technical Skills Match", "score": <0-100>},
    {"label": "Experience Level Match", "score": <0-100>},
    {"label": "Domain / Industry Match", "score": <0-100>},
    {"label": "Keywords & ATS Score", "score": <0-100>}
  ]
}

Rules:
- keywordsHave: skills/tools/technologies from the JD that the candidate clearly has (max 12)
- keywordsMissing: important keywords in the JD NOT in the candidate's profile (max 10, most critical first)
- tweaks: 3 very specific, actionable resume changes for THIS job (not generic advice)
- shortlist: High = 75+, Medium = 50-74, Low = below 50
- Be honest — don't inflate scores`;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
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

// POST /api/resources — generate cheatsheet + curated links (cached in Resources sheet)
app.post('/api/resources', requireLogin, async (req, res) => {
  try {
    const { week, day, taskTitle, taskType } = req.body;
    const { email, role, experience } = req.session.user;

    if (!taskTitle) return res.status(400).json({ error: 'Task title required' });

    // ── Check cache first ──
    const cacheKey = `${email}|W${week}D${day}`;
    try {
      const cached = await readSheet('Resources');
      const hit = cached.find(r =>
        (r.CacheKey || '').trim() === cacheKey.trim()
      );
      if (hit && hit.Data) {
        console.log(`📦 Cache hit for ${cacheKey}`);
        return res.json(JSON.parse(hit.Data));
      }
    } catch (cacheErr) {
      console.log('Cache read skipped:', cacheErr.message);
    }

    console.log(`🔨 Generating resources for ${cacheKey}: "${taskTitle}"`);
    const Anthropic = require('@anthropic-ai/sdk');
    const client    = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `You are an expert career coach and technical trainer for ${role} roles in India.

A candidate (${experience} years experience, targeting ${role}) is working on this task:
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
    {
      "title": "<resource title>",
      "url": "<real working URL — YouTube video, official docs, or well-known article>",
      "source": "<YouTube | Official Docs | GeeksforGeeks | Medium | etc>",
      "type": "<video | docs | article>"
    },
    {
      "title": "<resource title>",
      "url": "<real working URL>",
      "source": "<source name>",
      "type": "<video | docs | article>"
    },
    {
      "title": "<resource title>",
      "url": "<real working URL>",
      "source": "<source name>",
      "type": "<video | docs | article>"
    }
  ],
  "interviewTip": "<one highly specific tip: what interviewers at top Indian tech companies actually ask about this topic, and the #1 mistake candidates make>"
}

Rules:
- cheatsheet: exactly 6 points, each under 20 words, fact-dense and interview-ready
- practice: exactly 3 concrete actions for TODAY (not vague like "study X" — specific like "implement X function", "write 3 SQL queries for Y")
- resources: ONLY use real, well-known URLs that actually exist (YouTube search URLs are fine: https://www.youtube.com/results?search_query=...)
- interviewTip: be very specific to ${role} and this exact task — not generic advice
- All content must be specific to ${role} with ${experience} years experience level`;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
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

    // ── Save to Resources sheet (cache) ──
    try {
      const today = new Date().toISOString().split('T')[0];
      await getSheetsClient().spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: 'Resources!A:A',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [[
          cacheKey, email, String(week), String(day), taskTitle, taskType, today,
          JSON.stringify(payload)
        ]]}
      });
      console.log(`✅ Cached resources for ${cacheKey}`);
    } catch (cacheWriteErr) {
      console.error('Cache write failed (non-fatal):', cacheWriteErr.message);
    }

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
    const myQuestions = questionRows.filter(r => r.Email.toLowerCase() === email.toLowerCase() && parseInt(r.Week) === week);

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
