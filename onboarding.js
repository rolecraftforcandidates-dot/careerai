// ═══════════════════════════════════════════════════════════════
// onboarding.js — RoleCraft Automation Engine
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
    const fromName  = 'RoleCraft';

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
  return `${clean}@RoleCraft1`;
}

// ══════════════════════════════════════════════════════
// CLAUDE PROMPT — generates plan + questions + ATS in one call
// ══════════════════════════════════════════════════════
function buildPrompt(name, email, role, experience, techStack, resumeText) {
  return `You are an expert career coach and interview trainer specialising in tech roles in India.

A new user has signed up for RoleCraft — a 30-day personalised interview preparation programme.

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
- Generate exactly 16 tasks total: 4 tasks per week, across 4 weeks
- Week 1: Foundation building (theory, core concepts for ${role})
- Week 2: Technical depth (hands-on practice, ${techStack} specifics)
- Week 3: Interview practice (mock answers, system design, problem solving)
- Week 4: Final readiness (full mock interviews, polish, confidence)
- Type must be exactly one of: Theory / Practice / Mock
- Make tasks highly specific to ${role} and ${techStack} — not generic

RULES FOR QUESTIONS:
- Generate exactly 12 questions total: 3 questions per week, across 4 weeks
- Each week must have: 1 Technical question + 1 Behavioral question + 1 System Design or Role-specific question
- Week 1 questions should be foundational, Week 4 should be advanced
- Q No. format: Q1, Q2, Q3 (reset each week — Week 2 also starts at Q1)
- Make questions very specific to ${role} and ${techStack} — interviewers at top Indian tech companies would ask these
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
async function generateWithClaude(name, email, role, experience, techStack, resumeText) {
  const client = getAnthropicClient();

  console.log(`🤖 Calling Claude for ${name} (${role}, ${experience})`);

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',  // Fast + cheap, perfect for structured generation
    max_tokens: 4096,
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
    console.error('Raw output:', rawText.slice(0, 500));
    throw new Error('Claude returned invalid JSON. Check logs.');
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
  const subject   = `Your RoleCraft dashboard is ready, ${firstName}! 🚀`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f8f9ff;padding:32px 20px">
    <div style="background:linear-gradient(135deg,#00b38a,#5048e5);border-radius:16px;padding:28px;color:white;text-align:center;margin-bottom:24px">
      <div style="font-size:28px;font-weight:900;letter-spacing:3px;margin-bottom:6px">ROLECRAFT</div>
      <div style="font-size:16px;opacity:.9">Your 30-Day Interview Prep Plan is Ready</div>
    </div>
    <div style="background:white;border-radius:14px;padding:28px;margin-bottom:16px;border:1px solid rgba(0,0,0,.07)">
      <p style="font-size:18px;font-weight:700;margin-bottom:8px">Hi ${firstName}! 👋</p>
      <p style="color:#6b6b8a;line-height:1.7;margin-bottom:20px">Your personalised <strong>${role}</strong> interview preparation programme is ready. Claude AI has generated your complete 4-week plan, 12 interview questions, and resume analysis.</p>
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
      <div style="font-size:13px;color:#6b6b8a;margin-bottom:8px">✅  16 personalised daily tasks across 4 weeks</div>
      <div style="font-size:13px;color:#6b6b8a;margin-bottom:8px">✅  12 interview questions (Technical + Behavioral + System Design)</div>
      <div style="font-size:13px;color:#6b6b8a;margin-bottom:8px">✅  Resume ATS analysis with improvement tips</div>
      <div style="font-size:13px;color:#6b6b8a">✅  AI scoring on your submitted answers</div>
    </div>
    <div style="text-align:center;margin-top:20px;font-size:12px;color:#9999bb">Questions? Reply to this email. — Team RoleCraft</div>
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

  return {
    name:       getField('name') || getField('full name'),
    email:      getField('email'),
    role:       getField('target role') || getField('role'),
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

    console.log(`\n🚀 New onboarding: ${name} | ${email} | Role: ${role} | Exp: ${experience} yrs | Tech: ${techStack}`);

    if (!email) throw new Error('No email found in Tally payload');
    if (!role)  throw new Error('No role found in Tally payload');

    result.email = email;

    // 2. Check if user already exists
    const sheets   = getSheetsClientFn();
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Users!A:A',
    });
    const emails = (existing.data.values || []).flat().map(e => e.toLowerCase());
    if (emails.includes(email.toLowerCase())) {
      throw new Error(`User ${email} already exists in sheet`);
    }

    // 3. Fetch resume text if available
    const resumeText = await fetchResumeText(resumeUrl);

    // 4. Generate with Claude
    const generated = await generateWithClaude(
      name || email.split('@')[0],
      email,
      role,
      experience || 'Mid',
      techStack || role,
      resumeText
    );

    // 5. Generate password
    const password = generatePassword(name);

    // 6. Write to Google Sheets
    await writeToSheets(
      sheets,
      sheetId,
      name || email.split('@')[0],
      email,
      password,
      role,
      experience || 'Mid',
      techStack || '',
      generated
    );

    // 7. Send welcome email (wrapped separately — sheet data is already saved)
    const dashboardUrl = process.env.DASHBOARD_URL || 'https://your-app.railway.app';
    try {
      await sendWelcomeEmail(
        name || email.split('@')[0],
        email,
        password,
        role,
        dashboardUrl
      );
    } catch (emailErr) {
      // Email failed but data is already in Sheets — log and continue
      console.error(`⚠️  Email failed for ${email}: ${emailErr.message}`);
      console.log(`📋 Manual credentials — Email: ${email} | Password: ${password} | URL: ${dashboardUrl}`);
    }

    result.success = true;
    console.log(`\n✅ Onboarding complete for ${email} (check logs if email failed)`);

  } catch (err) {
    result.error = err.message;
    console.error(`\n❌ Onboarding failed:`, err.message);
  }

  return result;
}

module.exports = { runOnboarding, parseTallyPayload };
