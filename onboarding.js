// ═══════════════════════════════════════════════════════════════
// onboarding.js — RoleKraft Automation Engine
//
// Flow:
//   1. POST /api/onboard  ← called by Tally webhook after form submit
//   2. Parse user details from Tally payload
//   3. Call Claude API → generate full 4-week plan + 12 questions + ATS analysis
//   4. Write everything to Google Sheets (Users, Plans, Questions tabs)
//   5. Send welcome email via Gmail with login credentials
// ═══════════════════════════════════════════════════════════════

const Anthropic  = require('@anthropic-ai/sdk');
const https = require('https');

// ── Anthropic client ──
function getAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  return new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ── Send email via Brevo HTTP API (no SMTP, no nodemailer needed) ──
function sendBrevoEmail(to, toName, subject, htmlContent) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      reject(new Error('BREVO_API_KEY not set'));
      return;
    }

    const fromEmail = process.env.BREVO_SENDER_EMAIL || process.env.GMAIL_USER;
    const fromName  = 'RoleKraft';

    const payload = JSON.stringify({
      sender:   { name: fromName, email: fromEmail },
      to:       [{ email: to, name: toName }],
      subject:  subject,
      htmlContent: htmlContent,
    });

    const options = {
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers:  {
        'Content-Type':  'application/json',
        'api-key':       apiKey,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`Brevo API error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Brevo API timeout')); });
    req.write(payload);
    req.end();
  });
}

// ── Generate a simple default password ──
function generatePassword(name) {
  const clean = (name || 'User').split(' ')[0];
  return `${clean}@RoleKraft1`;
}

// ══════════════════════════════════════════════════════
// CLAUDE PROMPT — generates plan + questions + ATS in one call
// ══════════════════════════════════════════════════════
// ── PHASE 1: Fast prompt — ATS score + tips only (~3s) ──
function buildFastPrompt(name, role, experience, techStack, resumeText) {
  return 'You are a resume expert for Indian tech hiring. Return ONLY raw JSON, no markdown.' +
    '\n\nUser: ' + name + ' | Role: ' + role + ' | Experience: ' + experience + ' yrs | Tech: ' + techStack +
    '\nResume: ' + (resumeText ? resumeText.slice(0, 2000) : 'Not provided') +
    '\n\nReturn exactly this JSON structure (nothing else):\n' +
    '{\n' +
    '  "atsScore": 72,\n' +
    '  "atsTips": "Tip 1: specific tip\\nTip 2: specific tip\\nTip 3: specific tip\\nTip 4: specific tip\\nTip 5: specific tip",\n' +
    '  "keyStrengths": ["strength 1", "strength 2", "strength 3"],\n' +
    '  "missingKeywords": ["keyword1", "keyword2", "keyword3", "keyword4"]\n' +
    '}\n\n' +
    'Rules: atsScore = realistic 50-95 based on resume (65 if no resume). ' +
    'atsTips = exactly 5 lines starting with Tip 1: through Tip 5:, specific to ' + role + ' in Indian job market. ' +
    'keyStrengths = 3 things already good in resume. missingKeywords = 4 skills/keywords missing for ' + role + '. ' +
    'Return ONLY the JSON object.';
}

function buildPrompt(name, email, role, experience, techStack, resumeText) {
  return `You are an expert career coach and interview trainer specialising in tech roles in India.

A new user has signed up for RoleKraft — a 30-day personalised interview preparation programme.

USER DETAILS:
- Name: ${name}
- Target Role: ${role}
- Tech Stack: ${techStack}
- Experience Level: ${experience} years (e.g. 0-5 means junior/fresher, 5-10 means mid-senior)
- Resume Text: ${resumeText ? resumeText.slice(0, 3000) : 'Not provided'}

Your job is to generate their complete personalised programme. Return ONLY valid JSON — no explanation, no markdown, no code fences. Just raw JSON.

The JSON must follow this exact structure:

{
  "tasks": [
    {
      "Week": "1",
      "Day": "1",
      "Task Title": "task description here",
      "Type": "Theory"
    }
  ],
  "questions": [
    {
      "Week": "1",
      "Q No.": "Q1",
      "Type": "Technical",
      "Question": "full question text here"
    }
  ],
  "atsScore": 72,
  "atsTips": "Tip 1: Add TypeScript to skills section\nTip 2: Quantify your impact with metrics\nTip 3: Add a 3-line professional summary at top\nTip 4: Replace vague verbs with action verbs\nTip 5: Remove irrelevant skills to improve signal"
}

RULES FOR TASKS:
- Generate exactly 28 tasks total: 7 tasks per week, across 4 weeks
- Use Day values 1 through 7 within each week (one task per day)
- Week 1: Foundation building — theory, core concepts, fundamentals for ${role}
- Week 2: Technical depth — hands-on practice, ${techStack} specifics, build something
- Week 3: Interview practice — mock answers, system design, problem solving drills
- Week 4: Final readiness — polish weak areas, confidence building, final preparation
- Spread Types across the week: roughly 3 Theory, 2 Practice, 2 Mock per week
- Type must be exactly one of: Theory / Practice / Mock
- Make tasks highly specific to ${role} and ${techStack} — not generic filler

RULES FOR QUESTIONS:
- Generate exactly 12 questions total: 3 questions per week, across 4 weeks
- Each week: 1 Technical + 1 Behavioral + 1 System Design question
- Week 1 questions: foundational and conceptual
- Week 2 questions: intermediate technical depth
- Week 3 questions: advanced, interview-style
- Week 4 questions: senior-level, real interview difficulty
- Q No. format: Q1 through Q3 — RESET each week (Week 2 starts at Q1 again)
- Make questions very specific to ${role} and ${techStack}
- Type must be exactly one of: Technical / Behavioral / System Design

RULES FOR ATS ANALYSIS:
- If resume text is provided, analyse it and give a realistic score 50-95
- If no resume, give score of 65 and generic tips for ${role}
- atsTips must be exactly 5 tips, each on a new line starting with "Tip N:"
- Tips must be specific and actionable for ${role} in Indian job market`;
}

// ══════════════════════════════════════════════════════
// CALL CLAUDE API
// ══════════════════════════════════════════════════════
// ── PHASE 1: Generate ATS preview only (fast, ~3s) ──
async function generateFastPreview(name, role, experience, techStack, resumeText) {
  const client = getAnthropicClient();
  console.log('⚡ Phase 1: Fast ATS preview for', name);

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,  // Even smaller — we only need 4 fields
    system: 'You are a resume scoring API. Return ONLY a JSON object. No explanation. No markdown.',
    messages: [{ role: 'user', content: buildFastPrompt(name, role, experience, techStack, resumeText) }],
  });

  const raw     = message.content[0].text.trim();
  const cleaned = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
  const parsed  = JSON.parse(cleaned);
  console.log('✅ Phase 1 done — ATS score:', parsed.atsScore);
  return parsed;
}

async function generateWithClaude(name, email, role, experience, techStack, resumeText) {
  const client = getAnthropicClient();

  console.log(`🤖 Calling Claude for ${name} (${role}, ${experience})`);

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',  // Fast + cheap, perfect for structured generation
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: buildPrompt(name, email, role, experience, techStack, resumeText),
    }],
  });

  const rawText = message.content[0].text.trim();

  // Strip any accidental markdown fences
  const cleaned = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.error('Claude JSON parse failed:', e.message);
    console.error('Raw output:', rawText.slice(0, 300));

    // Attempt recovery — retry with a simpler prompt
    try {
      console.log('🔄 Retrying with simplified prompt...');
      const retryMsg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: 'Generate interview prep JSON for a ' + role + ' with ' + experience + ' years experience. ' +
            'Return ONLY raw JSON (no markdown). Exactly this structure:\n' +
            '{\n  "tasks": [28 objects with Week/Day/Task Title/Type],\n' +
            '  "questions": [12 objects with Week/Q No./Type/Question],\n' +
            '  "atsScore": 70,\n' +
            '  "atsTips": "Tip 1: ...\\nTip 2: ...\\nTip 3: ...\\nTip 4: ...\\nTip 5: ..."\n}\n' +
            'Tasks: 7 per week x 4 weeks. Type = Theory/Practice/Mock.\n' +
            'Questions: 3 per week x 4 weeks (1 Technical + 1 Behavioral + 1 System Design). Q No. = Q1/Q2/Q3 per week.\n' +
            'Make all content specific to ' + role + ' and tech stack: ' + techStack + '. Return ONLY the JSON object.'
        }],
      });
      const retryText = retryMsg.content[0].text.trim()
        .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = JSON.parse(retryText);
      console.log('✅ Retry succeeded');
    } catch (retryErr) {
      console.error('Retry also failed:', retryErr.message);
      throw new Error('Claude returned invalid JSON. Check logs.');
    }
  }

  // Validate structure
  if (!parsed.tasks || !Array.isArray(parsed.tasks)) throw new Error('Missing tasks array in Claude response');
  if (!parsed.questions || !Array.isArray(parsed.questions)) throw new Error('Missing questions array in Claude response');
  if (!parsed.atsScore) throw new Error('Missing atsScore in Claude response');

  console.log(`✅ Claude generated: ${parsed.tasks.length} tasks, ${parsed.questions.length} questions, ATS: ${parsed.atsScore}`);
  return parsed;
}

// ══════════════════════════════════════════════════════
// WRITE TO GOOGLE SHEETS
// ══════════════════════════════════════════════════════
async function writeToSheets(sheets, sheetId, name, email, password, role, experience, techStack, generated) {

  // ── 1. Add user row to Users tab ──
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Users!A:A',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[
        email,                     // A: Email
        name,                      // B: Name
        password,                  // C: Password
        role,                      // D: Role
        experience,                // E: Experience
        '1',                       // F: Week (starts at 1)
        'TRUE',                    // G: Plan Active
        String(generated.atsScore),// H: ATS Score
        generated.atsTips || '',   // I: ATS Tips
        '',                        // J: Resume URL
        today,                     // K: Week Started
        'free',                    // L: Tier (free|pro|premium)
        '',                        // M: Tier Expiry
      ]]
    }
  });
  console.log(`✅ Added user row: ${email}`);

  // ── 2. Add plan tasks to Plans tab (one row per task) ──
  if (generated.tasks && generated.tasks.length > 0) {
    const taskRows = generated.tasks.map(task => [
      email,
      task.Week || '1',
      task.Day || '1',
      task['Task Title'] || '',
      task.Type || 'Theory',
      '',        // Status — blank until completed
      role,
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Plans!A:A',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: taskRows }
    });
    console.log(`✅ Added ${taskRows.length} plan tasks`);
  }

  // ── 3. Add questions to Questions tab (one row per question) ──
  if (generated.questions && generated.questions.length > 0) {
    const questionRows = generated.questions.map(q => [
      email,
      q.Week || '1',
      q['Q No.'] || 'Q1',
      q.Type || 'Technical',
      q.Question || '',
      '',      // Answer — blank until user submits
      '',      // Score — blank until scored
      '',      // AI Feedback — blank until scored
      'FALSE', // Submitted
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Questions!A:A',
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: questionRows }
    });
    console.log(`✅ Added ${questionRows.length} questions`);
  }
}

// ══════════════════════════════════════════════════════
// SEND WELCOME EMAIL
// ══════════════════════════════════════════════════════
async function sendWelcomeEmail(name, email, password, role, dashboardUrl) {
  if (!process.env.BREVO_API_KEY) {
    console.warn('⚠️  BREVO_API_KEY not set — skipping welcome email');
    return;
  }

  const firstName = (name || 'there').split(' ')[0];
  const subject   = `Your RoleKraft dashboard is ready, ${firstName}! 🚀`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9ff;padding:32px 20px">
    <div style="background:linear-gradient(135deg,#00b38a,#5048e5);border-radius:16px;padding:28px;color:white;text-align:center;margin-bottom:24px">
      <div style="font-size:28px;font-weight:900;letter-spacing:3px;margin-bottom:6px">ROLECRAFT</div>
      <div style="font-size:16px;opacity:.9">Your 30-Day Interview Prep Plan is Ready</div>
    </div>
    <div style="background:white;border-radius:14px;padding:28px;margin-bottom:16px;border:1px solid rgba(0,0,0,.07)">
      <p style="font-size:18px;font-weight:700;margin-bottom:8px">Hi ${firstName}! 👋</p>
      <p style="color:#6b6b8a;line-height:1.7;margin-bottom:20px">Your personalised <strong>${role}</strong> interview preparation programme is ready. Your complete 4-week plan, 12 interview questions, and resume analysis are all set.</p>
      <div style="background:#e6f7f3;border-radius:10px;padding:18px;margin-bottom:20px;border-left:4px solid #00b38a">
        <div style="font-size:12px;color:#007a5e;font-weight:700;letter-spacing:2px;margin-bottom:10px">YOUR LOGIN DETAILS</div>
        <div style="margin-bottom:6px"><strong>Dashboard:</strong> <a href="${dashboardUrl}" style="color:#5048e5">${dashboardUrl}</a></div>
        <div style="margin-bottom:6px"><strong>Email:</strong> ${email}</div>
        <div><strong>Password:</strong> <code style="background:white;padding:2px 8px;border-radius:5px;font-size:15px">${password}</code></div>
      </div>
      <a href="${dashboardUrl}" style="display:block;background:linear-gradient(135deg,#00b38a,#5048e5);color:white;text-align:center;padding:14px;border-radius:10px;font-weight:700;font-size:16px;text-decoration:none;margin-bottom:16px">Open My Dashboard →</a>
      <p style="color:#6b6b8a;font-size:13px;margin:0">💡 <strong>First thing to do:</strong> Login, check your Week 1 plan, and change your password in Settings.</p>
    </div>
    <div style="background:white;border-radius:14px;padding:20px;border:1px solid rgba(0,0,0,.07)">
      <div style="font-size:13px;font-weight:700;margin-bottom:12px">What is waiting for you:</div>
      <div style="font-size:13px;color:#6b6b8a;margin-bottom:8px">✅  28 personalised daily tasks across 4 weeks</div>
      <div style="font-size:13px;color:#6b6b8a;margin-bottom:8px">✅  12 interview questions (Technical + Behavioral + System Design)</div>
      <div style="font-size:13px;color:#6b6b8a;margin-bottom:8px">✅  Resume ATS analysis with improvement tips</div>
      <div style="font-size:13px;color:#6b6b8a">✅  AI scoring on your submitted answers</div>
    </div>
    <div style="text-align:center;margin-top:20px;font-size:12px;color:#9999bb">Questions? Reply to this email. — Team RoleKraft</div>
  </div>`;

  await sendBrevoEmail(email, firstName, subject, html);
  console.log(`✅ Welcome email sent to ${email}`);
}

// ══════════════════════════════════════════════════════
// PARSE TALLY WEBHOOK PAYLOAD
// Tally sends form data in a specific structure
// ══════════════════════════════════════════════════════
function parseTallyPayload(body) {
  // Tally webhook format: body.data.fields is an array of field objects
  const fields = body?.data?.fields || [];

  // Log raw fields to help debug field names
  console.log('Tally fields received:', JSON.stringify(fields.map(f => ({
    label: f.label, type: f.type, value: f.value
  })), null, 2));

  function getField(label) {
    const field = fields.find(f =>
      (f.label || '').toLowerCase().includes(label.toLowerCase())
    );
    if (!field) return '';

    // Tally dropdown/multiple choice: value is an array of option IDs
    // We need to match against field.options to get the actual text
    if (Array.isArray(field.value)) {
      if (field.options && Array.isArray(field.options)) {
        // Map option IDs back to their labels
        const labels = field.value.map(optId => {
          const opt = field.options.find(o => o.id === optId);
          return opt ? opt.text : optId;
        });
        return labels.join(', ');
      }
      return field.value.join(', ');
    }

    // Single value — check if it looks like a UUID (option ID)
    const val = String(field.value || '');
    const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
    if (isUUID && field.options && Array.isArray(field.options)) {
      const opt = field.options.find(o => o.id === val);
      return opt ? opt.text : val;
    }

    return val;
  }

  // Also handle file upload fields (resume)
  function getFileUrl(label) {
    const field = fields.find(f =>
      (f.label || '').toLowerCase().includes(label.toLowerCase())
    );
    if (!field) return '';
    // File upload value is array of {url, name, mimeType}
    if (Array.isArray(field.value) && field.value[0] && field.value[0].url) {
      return field.value[0].url;
    }
    return String(field.value || '');
  }

  // If Target Role is "Other", use the free-text field instead
  const rawRole = getField('target role') || getField('role') || '';

  // Try multiple label patterns for the "Other" free-text field
  // Tally field is: "Please put Other Target Role details here"
  const otherRole = (function() {
    const patterns = ['other target role', 'please put other', 'other role details', 'other role'];
    for (const p of patterns) {
      const v = getField(p);
      if (v && v.trim()) return v.trim();
    }
    // Last resort: scan all fields for any text field with "other" in label
    // that has a non-UUID, non-empty value
    const otherField = fields.find(f => {
      const lbl = (f.label || '').toLowerCase();
      const val = String(f.value || '').trim();
      const isUUID = /^[0-9a-f-]{36}$/i.test(val);
      return lbl.includes('other') && val && !isUUID;
    });
    return otherField ? String(otherField.value || '').trim() : '';
  })();

  const resolvedRole = (rawRole.toLowerCase().trim() === 'other' && otherRole)
    ? otherRole
    : rawRole;

  console.log('Role resolution → raw: "' + rawRole + '" | other field: "' + otherRole + '" | final: "' + resolvedRole + '"');

  return {
    name:       getField('name') || getField('full name'),
    email:      getField('email'),
    role:       resolvedRole,
    techStack:  getField('tech stack') || getField('tech'),
    experience: getField('experience') || getField('years') || getField('exp'),
    resumeUrl:  getFileUrl('resume'),
  };
}

// ══════════════════════════════════════════════════════
// FETCH RESUME TEXT FROM URL
// ══════════════════════════════════════════════════════
async function fetchResumeText(resumeUrl) {
  if (!resumeUrl || !resumeUrl.startsWith('http')) return '';
  try {
    const https   = require('https');
    const http    = require('http');
    const { URL } = require('url');

    // We just send the URL to Claude — Claude can read text from it
    // For now return the URL so Claude knows a resume exists
    return `[Resume uploaded — URL: ${resumeUrl}]`;
  } catch (e) {
    console.warn('Could not fetch resume:', e.message);
    return '';
  }
}

// ══════════════════════════════════════════════════════
// MAIN ONBOARDING FUNCTION
// Called by the Express route in server.js
// ══════════════════════════════════════════════════════
async function runOnboarding(rawBody, getSheetsClientFn, sheetId) {
  const result = { success: false, email: null, error: null };

  try {
    // 1. Parse Tally payload
    const { name, email, role, techStack, experience, resumeUrl } = parseTallyPayload(rawBody);
    const displayName = name || email.split('@')[0];

    console.log(`\n🚀 New onboarding: ${displayName} | ${email} | Role: ${role} | Exp: ${experience} yrs | Tech: ${techStack}`);

    if (!email) throw new Error('No email found in Tally payload');
    if (!role)  throw new Error('No role found in Tally payload');

    result.email = email;

    // 2. Check if user already exists — if so, return their existing data
    const sheets   = getSheetsClientFn();
    const allUsers = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Users!A:AZ',
    });
    const [hdrs, ...uRows] = allUsers.data.values || [];
    const existingRow = uRows.find(r => (r[0]||'').toLowerCase() === email.toLowerCase());

    if (existingRow) {
      console.log(`ℹ️  User ${email} already exists — returning existing data for welcome page`);
      const userObj = hdrs ? Object.fromEntries(hdrs.map((h,i) => [h.trim(), (existingRow[i]||'').trim()])) : {};
      result.success     = true;
      result.phase1Ready = true;
      result.welcomeData = {
        name:            userObj.Name || displayName,
        email,
        role:            userObj.Role || role,
        experience:      userObj.Experience || experience || 'Mid',
        atsScore:        parseInt(userObj['ATS Score']) || 65,
        atsTips:         userObj['ATS Tips'] || '',
        keyStrengths:    [],
        missingKeywords: [],
        taskCount:       28,
        qCount:          12,
        planReady:       userObj['Plan Active'] === 'TRUE',
        returning:       true,
      };
      return result;
    }

    // 3. Fetch resume text + generate password (parallel, instant)
    const resumeText = await fetchResumeText(resumeUrl);
    const password   = generatePassword(displayName);

    // ── PHASE 1: Fast ATS preview — Haiku with minimal prompt ──
    const t1 = Date.now();
    let fastPreview = null;
    try {
      fastPreview = await generateFastPreview(displayName, role, experience || 'Mid', techStack || role, resumeText);
      console.log('⚡ Phase 1 took', Date.now() - t1, 'ms');
    } catch(e) {
      console.error('Phase 1 fast preview failed:', e.message);
      fastPreview = {
        atsScore: 65,
        atsTips: 'Tip 1: Add quantified achievements\nTip 2: Include role-specific keywords\nTip 3: Add professional summary\nTip 4: List relevant certifications\nTip 5: Tailor skills section to job description',
        keyStrengths: ['Relevant work experience', 'Technical background', 'Domain knowledge'],
        missingKeywords: ['Leadership', 'Agile', 'Cloud', 'CI/CD']
      };
    }

    // Write user row immediately (non-blocking is fine here, await to ensure it's ready before token)
    await writeBasicUser(sheets, sheetId, displayName, email, password, role, experience || 'Mid', fastPreview);
    console.log('✅ Phase 1 complete in', Date.now() - t1, 'ms total — welcome page ready');

    // Surface Phase 1 result immediately
    result.success     = true;
    result.phase1Ready = true;
    result.welcomeData = {
      name:            displayName,
      email,
      role,
      experience:      experience || 'Mid',
      atsScore:        fastPreview.atsScore,
      atsTips:         fastPreview.atsTips,
      keyStrengths:    fastPreview.keyStrengths    || [],
      missingKeywords: fastPreview.missingKeywords || [],
      taskCount:       28,
      qCount:          12,
      planReady:       false, // plan still generating
    };

    // Send welcome email immediately with credentials
    const dashboardUrl = (process.env.APP_URL || process.env.DASHBOARD_URL || 'https://your-app.railway.app') + '/app';
    try {
      await sendWelcomeEmail(displayName, email, password, role, dashboardUrl);
    } catch(emailErr) {
      console.error('Welcome email failed:', emailErr.message);
    }

    // ── PHASE 2: Full plan generation (background, ~30s) ──
    // This runs after we return — dashboard will be ready by the time user logs in
    // Phase 2 fires immediately but doesn't block Phase 1 return
    const t2 = Date.now();
    setImmediate(async () => {
      try {
        console.log('🔄 Phase 2 starting for', email);
        const generated = await generateWithClaude(displayName, email, role, experience || 'Mid', techStack || role, resumeText);
        await writeFullPlan(getSheetsClientFn(), sheetId, email, generated);
        await updatePlanActive(getSheetsClientFn(), sheetId, email);
        console.log('✅ Phase 2 complete in', Math.round((Date.now()-t2)/1000), 's for', email);
      } catch(e) {
        console.error('Phase 2 failed for', email, ':', e.message);
        // Retry once
        setTimeout(async () => {
          try {
            console.log('🔁 Phase 2 retry for', email);
            const gen2 = await generateWithClaude(displayName, email, role, experience || 'Mid', techStack || role, resumeText);
            await writeFullPlan(getSheetsClientFn(), sheetId, email, gen2);
            await updatePlanActive(getSheetsClientFn(), sheetId, email);
            console.log('✅ Phase 2 retry succeeded for', email);
          } catch(e2) { console.error('Phase 2 retry also failed:', e2.message); }
        }, 10000);
      }
    });

    // Skip the old monolithic flow below — return early
    return result;

  } catch (err) {
    result.error = err.message;
    console.error(`\n❌ Onboarding failed:`, err.message);
    return result;
  }
}

// ── Write just the user row (Phase 1) ──
async function writeBasicUser(sheets, sheetId, name, email, password, role, experience, fastPreview) {
  const today = new Date().toISOString().split('T')[0];
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Users!A:A',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[
      email, name, password, role, experience,
      '1',        // Week
      'FALSE',    // Plan Active — FALSE until Phase 2 completes
      String(fastPreview.atsScore || 65),
      fastPreview.atsTips || '',
      '',         // Resume URL
      today,      // Week Started
      'free',     // Tier
      '',         // Tier Expiry
    ]]}
  });
  console.log('✅ Basic user row created for', email);
}

// ── Write full plan tasks + questions (Phase 2) ──
async function writeFullPlan(sheets, sheetId, email, generated) {
  if (generated.tasks && generated.tasks.length > 0) {
    const taskRows = generated.tasks.map(task => [
      email, task['Week'] || '1', task['Day'] || '1',
      task['Task Title'] || '', task['Type'] || 'Theory', 'FALSE', ''
    ]);
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId, range: 'Plans!A:A',
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: taskRows }
    });
    console.log('✅ Written', taskRows.length, 'tasks for', email);
  }
  if (generated.questions && generated.questions.length > 0) {
    const qRows = generated.questions.map(q => [
      email, q['Week'] || '1', q['Q No.'] || 'Q1',
      q['Type'] || 'Technical', q['Question'] || '', '', '', '', ''
    ]);
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId, range: 'Questions!A:A',
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: qRows }
    });
    console.log('✅ Written', qRows.length, 'questions for', email);
  }
}

// ── Flip Plan Active to TRUE after Phase 2 ──
async function updatePlanActive(sheets, sheetId, email) {
  const raw    = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Users!A:G' });
  const rows   = raw.data.values || [];
  const rowIdx = rows.findIndex((r, i) => i > 0 && (r[0]||'').toLowerCase() === email.toLowerCase());
  if (rowIdx > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: 'Users!G' + (rowIdx + 1),
      valueInputOption: 'RAW',
      requestBody: { values: [['TRUE']] }
    });
    console.log('✅ Plan Active set to TRUE for', email);
  }
}

module.exports = { runOnboarding, parseTallyPayload };
