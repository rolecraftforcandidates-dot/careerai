// ═══════════════════════════════════════════════════════════════
// onboarding.js — RoleKraft Automation Engine
//
// Flow:
//   1. POST /api/onboard  ← called by Tally webhook after form submit
//   2. Parse user details from Tally payload
//   3. Call Claude API → generate full 4-week plan + 28 questions + ATS analysis
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

// ══════════════════════════════════════════════════════
// EXTRACT INFO FROM RESUME TEXT USING CLAUDE
// Extracts: name, techStack, experience (years)
// ══════════════════════════════════════════════════════
// ── Extract ONLY name from resume — fast, used in Phase 1 ──
// Much lighter than full extractResumeInfo (no work history calc needed)
async function extractNameFromResume(resumeText, emailHint, tallyName, emailPrefix) {
  // If Tally provided name, use it directly
  if (tallyName && tallyName.trim().length > 1) return tallyName.trim();

  // If no resume text, fall back to email prefix
  if (!resumeText || resumeText.trim().length < 30) {
    return emailPrefix || (emailHint||'').split('@')[0];
  }

  // Try a simple heuristic first — first non-empty line of resume is usually the name
  const firstLines = resumeText.trim().split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3);
  for (const line of firstLines) {
    // A name line: 2-4 words, no @, no digits, not too long
    const words = line.split(/\s+/);
    if (words.length >= 2 && words.length <= 5 && !line.includes('@') && !/\d/.test(line) && line.length < 50) {
      // Title case it
      const titled = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      console.log(`👤 Name from resume first line: "${titled}"`);
      return titled;
    }
  }

  // Heuristic failed — ask Claude Haiku (very small call, < 1s)
  try {
    const client = getAnthropicClient();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 30,
      messages: [{ role: 'user', content:
        'What is the full name of the person in this resume? Reply with ONLY the name, nothing else.\n\n' +
        resumeText.slice(0, 500)
      }],
    });
    const extracted = (response.content[0]?.text || '').trim().replace(/["'.]/g, '');
    if (extracted && extracted.length > 1 && extracted.length < 60 && !extracted.includes('\n')) {
      console.log(`👤 Name from Claude: "${extracted}"`);
      return extracted;
    }
  } catch(e) {
    console.warn('Name extraction fallback failed:', e.message);
  }

  return emailPrefix || (emailHint||'').split('@')[0];
}

async function extractResumeInfo(resumeText, emailHint) {
  if (!resumeText || resumeText.trim().length < 50) {
    // No usable resume text — derive name from email
    const nameFromEmail = (emailHint || '').split('@')[0]
      .replace(/[._\-0-9]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
    return { name: nameFromEmail || 'User', techStack: '', experience: 'Mid' };
  }

  try {
    const client = getAnthropicClient();
    const currentYear = new Date().getFullYear();
    const prompt = `You are extracting structured data from a resume. Return ONLY raw JSON, no markdown, no explanation.

Resume text:
${resumeText.slice(0, 4000)}

Return exactly this JSON:
{
  "name": "full name",
  "techStack": "comma-separated tech skills",
  "experienceYears": 15,
  "workHistory": [
    { "company": "Company Name", "from": "Jul 2010", "to": "Present" }
  ]
}

Rules for name:
- The candidate's full name is almost always the very first line of the resume (before email/phone)
- Return it exactly as written

Rules for techStack:
- List only hard technical skills: languages, frameworks, cloud services, databases, tools
- No soft skills, no job titles, no certifications
- Maximum 12 items, comma separated

Rules for experienceYears — THIS IS CRITICAL, READ CAREFULLY:
- List ALL jobs in workHistory with their from/to dates
- experienceYears = sum of ALL work periods across ALL jobs (not just the most recent)
- "Present" or "current" = ${currentYear}
- Calculate months for each role, sum them all, convert to years (round to nearest whole number)
- Example: if someone worked Jul 2010 to Dec 2010 (6 months), then Jun 2014 to Aug 2015 (15 months), then Sep 2015 to present = sum all of these
- Do NOT just take the most recent start date and subtract from today
- Do NOT assume overlapping roles — treat each role separately

Return ONLY the JSON object.`;

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = (response.content[0]?.text || '').trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);

    // Log workHistory for debugging
    console.log('📅 Work history extracted:', JSON.stringify(parsed.workHistory || []));
    console.log('📊 Raw experienceYears from Claude:', parsed.experienceYears);

    // Map experienceYears number → band string
    const yrs = parseInt(parsed.experienceYears) || 0;
    let expBand = 'Mid';
    if (yrs <= 1)       expBand = 'Fresher';
    else if (yrs <= 3)  expBand = 'Junior';
    else if (yrs <= 6)  expBand = 'Mid';
    else if (yrs <= 10) expBand = 'Senior';
    else                expBand = 'Lead';

    console.log(`✅ Extracted — Name: ${parsed.name} | Tech: ${parsed.techStack} | Exp: ${yrs} yrs (${expBand})`);

    return {
      name:            (parsed.name || '').trim() || (emailHint||'').split('@')[0],
      techStack:       (parsed.techStack || '').trim(),
      experience:      expBand,
      experienceYears: yrs,
    };
  } catch(e) {
    console.error('Resume info extraction failed:', e.message);
    const nameFromEmail = (emailHint || '').split('@')[0]
      .replace(/[._\-0-9]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim();
    return { name: nameFromEmail || 'User', techStack: '', experience: 'Mid', experienceYears: 2 };
  }
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
  var hasResume = resumeText && resumeText.length > 100;
  var resumeSnippet = hasResume ? resumeText.slice(0, 3000).replace(/`/g, "'") : 'Not provided';
  var p = [];
  p.push('You are a senior technical recruiter and ATS expert for Indian tech companies.');
  p.push('Analyse this resume for a ' + role + ' role.');
  p.push('Return ONLY a raw JSON object - no markdown, no code fences, nothing else.');
  p.push('');
  p.push('CANDIDATE: ' + name);
  p.push('TARGET ROLE: ' + role);
  p.push('RESUME:');
  p.push(resumeSnippet);
  p.push('');
  p.push('Return this exact JSON shape:');
  p.push('{');
  p.push('  "atsScore": <number 50-95>,');
  p.push('  "atsTips": "<tip1> | <tip2> | <tip3> | <tip4> | <tip5>",');
  p.push('  "keyStrengths": ["<strength1>", "<strength2>", "<strength3>"],');
  p.push('  "missingKeywords": ["<keyword1>", "<keyword2>", "<keyword3>", "<keyword4>"]');
  p.push('}');
  p.push('');
  p.push('SCORING:');
  p.push('- 80-95: strong resume with metrics/numbers, good ' + role + ' keywords');
  p.push('- 65-79: decent but missing impact numbers, weak summary, keyword gaps');
  p.push('- 50-64: no summary, vague descriptions, missing core ' + role + ' skills');
  p.push('');
  p.push('TIP RULES - write 5 tips separated by | character:');
  p.push('- MUST reference specific content from this resume (company names, tools, roles)');
  p.push('- Include concrete numbers/examples where possible');
  p.push('- Good: "Led data migration at [Company] lacks scale - add PB moved and latency improvement"');
  p.push('- Bad: "Add quantified achievements" (too generic - not allowed)');
  p.push('- Each tip max 30 words. No newlines inside atsTips string.');
  p.push('');
  p.push('keyStrengths: 3 specific strengths seen in this resume (name actual tools/companies)');
  p.push('missingKeywords: 4 technical keywords for ' + role + ' jobs NOT present in this resume');
  p.push('');
  p.push('CRITICAL: atsTips value must be a single string with exactly 5 tips separated by | only.');
  return p.join('\n');
}

function buildPrompt(name, email, role, experience, techStack, resumeText) {
  // Use array join — safe from backticks/em-dashes/special chars in resume text
  var resume = resumeText ? resumeText.slice(0, 3000).replace(/`/g, "'") : 'Not provided';
  var p = [];
  p.push('You are an expert career coach and interview trainer specialising in tech roles in India.');
  p.push('');
  p.push('A new user has signed up for RoleKraft, a 30-day personalised interview preparation programme.');
  p.push('');
  p.push('USER DETAILS:');
  p.push('- Name: ' + name);
  p.push('- Email: ' + email);
  p.push('- Target Role: ' + role);
  p.push('- Tech Stack: ' + (techStack || role));
  p.push('- Experience Level: ' + experience);
  p.push('- Resume Text: ' + resume);
  p.push('');
  p.push('Generate their complete personalised programme. Return ONLY valid JSON - no explanation, no markdown, no code fences. Raw JSON only.');
  p.push('');
  p.push('The JSON must follow this EXACT structure:');
  p.push('{');
  p.push('  "tasks": [');
  p.push('    { "Week": "1", "Day": "1", "Task Title": "task description here", "Type": "Theory" }');
  p.push('  ],');
  p.push('  "questions": [');
  p.push('    { "Week": "1", "Q No.": "Q1", "Type": "Technical", "Question": "full question text here" }');
  p.push('  ],');
  p.push('  "atsScore": 72,');
  p.push('  "atsTips": "Tip 1: specific tip here | Tip 2: specific tip | Tip 3: specific tip | Tip 4: specific tip | Tip 5: specific tip"');
  p.push('}');
  p.push('');
  p.push('RULES FOR TASKS:');
  p.push('- Generate exactly 28 tasks total: 7 tasks per week, across 4 weeks');
  p.push('- Use Day values 1 through 7 within each week (one task per day)');
  p.push('- Week 1: Foundation building - theory, core concepts, fundamentals for ' + role);
  p.push('- Week 2: Technical depth - hands-on practice, ' + (techStack || role) + ' specifics, build something');
  p.push('- Week 3: Interview practice - mock answers, system design, problem solving drills');
  p.push('- Week 4: Final readiness - polish weak areas, confidence building, final preparation');
  p.push('- Spread Types across the week: roughly 3 Theory, 2 Practice, 2 Mock per week');
  p.push('- Type must be exactly one of: Theory / Practice / Mock');
  p.push('- Make tasks highly specific to ' + role + ' and ' + (techStack || role) + ' - not generic filler');
  p.push('');
  p.push('RULES FOR QUESTIONS:');
  p.push('- Generate exactly 28 questions total: 7 questions per week, across 4 weeks');
  p.push('- Each week distribute types: 3 Technical + 2 Behavioral + 2 System Design');
  p.push('- Week 1 questions: foundational and conceptual - test core knowledge');
  p.push('- Week 2 questions: intermediate technical depth - test hands-on skills');
  p.push('- Week 3 questions: advanced, real interview-style - test problem solving');
  p.push('- Week 4 questions: senior-level, full interview difficulty - test readiness');
  p.push('- Q No. format: Q1 through Q7, RESET each week (Week 2 starts at Q1 again)');
  p.push('- Make questions very specific to ' + role + ' and ' + (techStack || role) + ' - no generic questions');
  p.push('- Type must be exactly one of: Technical / Behavioral / System Design');
  p.push('');
  p.push('RULES FOR ATS ANALYSIS:');
  p.push('- If resume text is provided, analyse it and give a realistic score 50-95');
  p.push('- If no resume, give score of 65 and generic tips for ' + role);
  p.push('- atsTips: exactly 5 tips separated by | character (no newlines inside the string)');
  p.push('- Tips must be specific and actionable for ' + role + ' in the Indian job market');
  p.push('');
  p.push('CRITICAL: Return ONLY the JSON object. No text before or after. No markdown fences.');
  return p.join('\n');
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
    max_tokens: 1000, // Enough for 5 detailed specific tips + strengths + keywords
    system: 'You are a resume scoring API. Return ONLY a JSON object. No explanation. No markdown.',
    messages: [{ role: 'user', content: buildFastPrompt(name, role, experience, techStack, resumeText) }],
  });

  const raw     = message.content[0].text.trim();
  const cleaned = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
  console.log('📝 Phase 1 raw response (first 200 chars):', cleaned.slice(0, 200));
  const parsed  = JSON.parse(cleaned);
  console.log('✅ Phase 1 done — ATS score:', parsed.atsScore);
  return parsed;
}

async function generateWithClaude(name, email, role, experience, techStack, resumeText) {
  const client = getAnthropicClient();

  console.log(`🤖 Calling Claude for ${name} (${role}, ${experience})`);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5-20251001', // Sonnet for richer, more specific plan content
    max_tokens: 16000,
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
        model: 'claude-sonnet-4-5-20251001',
        max_tokens: 16000,
        messages: [{
          role: 'user',
          content: 'Generate interview prep JSON for a ' + role + ' with ' + experience + ' years experience. ' +
            'Return ONLY raw JSON (no markdown). Exactly this structure:\n' +
            '{\n  "tasks": [28 objects with Week/Day/Task Title/Type],\n' +
            '  "questions": [28 objects with Week/Q No./Type/Question],\n' +
            '  "atsScore": 70,\n' +
            '  "atsTips": "Tip 1: ...\\nTip 2: ...\\nTip 3: ...\\nTip 4: ...\\nTip 5: ..."\n}\n' +
            'Tasks: 7 per week x 4 weeks. Type = Theory/Practice/Mock.\n' +
            'Questions: 7 per week x 4 weeks (3 Technical + 2 Behavioral + 2 System Design). Q No. = Q1-Q7 per week.\n' +
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
        '',                        // J: Resume URL (Drive URL populated separately if uploaded)
        today,                     // K: Week Started
        (resumeText || '').slice(0, 50000), // L: Resume Text (saved for Job Match)
        'free',                    // M: Tier (free|pro|premium)
        '',                        // N: Tier Expiry
        techStack || '',           // O: Tech Stack
        '',                        // P: Experience Years
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
async function sendWelcomeEmail(name, email, password, role, techStack, experience, experienceYears, dashboardUrl) {
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
      <p style="color:#6b6b8a;line-height:1.7;margin-bottom:20px">Your personalised <strong>${role}</strong> interview preparation programme is ready. Your complete 4-week plan, 28 interview questions, and resume analysis are all set.</p>
      <div style="background:#f0f0ff;border-radius:10px;padding:14px 18px;margin-bottom:20px;font-size:13px;color:#5048e5;border-left:4px solid #5048e5">
        <strong>📋 Your Profile (extracted from your resume)</strong><br>
        <span style="color:#444">Experience:</span> <strong>${experienceYears ? experienceYears + " years" : experience}</strong> &nbsp;·&nbsp;
        <span style="color:#444">Tech Stack:</span> <strong>${techStack || role}</strong>
      </div>
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
      <div style="font-size:13px;color:#6b6b8a;margin-bottom:8px">✅  28 interview questions (Technical + Behavioral + System Design)</div>
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
    // name, techStack, experience are now extracted from resume by extractResumeInfo()
    // We still read them as graceful fallback for old form submissions
    name:       getField('name') || getField('full name') || '',
    email:      getField('email'),
    role:       resolvedRole,
    techStack:  getField('tech stack') || getField('tech') || '',
    experience: getField('experience') || getField('years') || getField('exp') || '',
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

    // Download the file buffer from the Tally-hosted URL
    const buffer = await new Promise((resolve, reject) => {
      const parsed = new URL(resumeUrl);
      const client = parsed.protocol === 'https:' ? https : http;
      const chunks = [];
      const req = client.get(resumeUrl, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode));
          return;
        }
        res.on('data', c => chunks.push(c));
        res.on('end',  () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });

    // Detect file type from URL or content
    const urlLower = resumeUrl.toLowerCase().split('?')[0];
    let mimetype = 'application/pdf'; // default
    if (urlLower.endsWith('.docx')) mimetype = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    else if (urlLower.endsWith('.doc')) mimetype = 'application/msword';

    // Parse text from buffer
    let text = '';
    if (mimetype === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
      text = (data.text || '').trim();
    } else {
      const mammoth = require('mammoth');
      const result  = await mammoth.extractRawText({ buffer });
      text = (result.value || '').trim();
    }

    console.log(`📄 Resume parsed: ${text.length} chars`);
    return text;
  } catch (e) {
    console.warn('Could not fetch/parse resume:', e.message);
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
    // displayName is a temporary placeholder — real name extracted from resume below
    const emailPrefix = (email || '').split('@')[0].replace(/[._\-0-9]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();

    console.log(`\n🚀 New onboarding: ${name || emailPrefix} | ${email} | Role: ${role}`);
    console.log(`   (Tally fallback values — Tech: "${techStack || 'none'}" | Exp: "${experience || 'none'}" — will extract from resume)`);

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
        name:            userObj.Name || name || emailPrefix,
        email,
        role:            userObj.Role || role,
        techStack:       userObj['Tech Stack'] || techStack || '',
        experience:      userObj.Experience || experience || 'Mid',
        experienceYears: parseInt(userObj['Experience Years']) || 0,
        atsScore:        parseInt(userObj['ATS Score']) || 65,
        atsTips:         userObj['ATS Tips'] || '',
        keyStrengths:    [],
        missingKeywords: [],
        taskCount:       28,
        qCount:          28,
        planReady:       userObj['Plan Active'] === 'TRUE',
        returning:       true,
      };
      return result;
    }

    // ── PHASE 1: Fetch resume + extract name + fast ATS preview ──
    // Name extracted here so welcome page + dashboard show correct name
    // Tech stack + experience extracted in Phase 2 (after user clicks dashboard)
    const resumeText = await fetchResumeText(resumeUrl);

    // Extract name from resume (fast — only asks for name, not full extraction)
    const realName    = await extractNameFromResume(resumeText, email, name, emailPrefix);
    const displayName = realName;
    const password    = generatePassword(displayName);
    console.log(`👤 Name resolved: "${displayName}"`);

    const t1 = Date.now();
    let fastPreview = null;
    try {
      fastPreview = await generateFastPreview(displayName, role, 'Mid', role, resumeText);
      console.log('⚡ Phase 1 ATS preview took', Date.now() - t1, 'ms');
    } catch(e) {
      console.error('Phase 1 fast preview failed:', e.message, e.stack);
      // Generate basic tips using role name at minimum — never show hardcoded generics
      fastPreview = {
        atsScore: 65,
        atsTips: 'Tip 1: Add quantified achievements with metrics relevant to ' + role + '\nTip 2: Include ' + role + '-specific keywords in your skills section\nTip 3: Add a 3-line professional summary targeting ' + role + ' roles\nTip 4: Use strong action verbs (built, designed, optimised, led) for each role\nTip 5: Tailor your skills section to match ' + role + ' job descriptions',
        keyStrengths: ['Work experience in relevant domain', 'Technical background', 'Problem-solving skills'],
        missingKeywords: [role + ' certifications', 'System design', 'Cloud platforms', 'Agile/Scrum']
      };
    }

    // Write basic user row with real name — tech/exp updated after Phase 2
    await writeBasicUser(sheets, sheetId, displayName, email, password, role, '', '', null, fastPreview, resumeText);
    console.log('✅ Phase 1 complete in', Date.now() - t1, 'ms — welcome page ready');

    // Surface Phase 1 result to welcome page
    result.success     = true;
    result.phase1Ready = true;
    result.welcomeData = {
      name:            displayName,
      email,
      role,
      atsScore:        fastPreview.atsScore,
      atsTips:         fastPreview.atsTips,
      keyStrengths:    fastPreview.keyStrengths    || [],
      missingKeywords: fastPreview.missingKeywords || [],
      taskCount: 28,
      qCount:    28,
      planReady: false,
    };

    // ── Welcome email is sent in triggerPhase2 (when user clicks Go to Dashboard) ──
    // By that point we have real name + tech stack + experience to include

    // ── PHASE 2 is now triggered on-demand ──
    // triggerPhase2() is called by /api/trigger-plan when user clicks "Go to Dashboard"
    // Store resumeText + context so triggerPhase2 can use it
    pendingPhase2.set(email.toLowerCase(), {
      resumeText, role,
      tallyName: name, tallyTech: techStack, tallyExp: experience,
      displayName, getSheetsClientFn, sheetId,
      createdAt: Date.now(),
    });
    console.log(`⏸️  Phase 2 queued for ${email} — waiting for user to click dashboard button`);

    return result;

  } catch (err) {
    result.error = err.message;
    console.error(`\n❌ Onboarding failed:`, err.message);
    return result;
  }
}

// ── Write just the user row (Phase 1) ──
async function writeBasicUser(sheets, sheetId, name, email, password, role, experience, techStack, experienceYears, fastPreview, resumeText) {
  const today = new Date().toISOString().split('T')[0];
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Users!A:A',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[
      email,                              // A: Email
      name,                               // B: Name
      password,                           // C: Password
      role,                               // D: Role
      experience,                         // E: Experience (band)
      '1',                                // F: Week
      'FALSE',                            // G: Plan Active — FALSE until Phase 2 completes
      String(fastPreview.atsScore || 65), // H: ATS Score
      fastPreview.atsTips || '',          // I: ATS Tips
      '',                                 // J: Resume URL (Tally CDN URL — not saved long term)
      today,                              // K: Week Started
      (resumeText || '').slice(0, 45000), // L: Resume Text — saved for Job Match
      'free',                             // M: Tier
      '',                                 // N: Tier Expiry
      techStack || '',                    // O: Tech Stack  ← new column (add header in sheet)
      String(experienceYears ?? ''),      // P: Experience Years ← new column (add header in sheet)
    ]]}
  });
  console.log('✅ Basic user row created for', email, '| Tech:', techStack, '| Exp:', experience, experienceYears + 'yrs');
}

// ── Update user row with extracted resume info after Phase 2 extraction ──
async function updateUserExtractedInfo(sheets, sheetId, email, name, techStack, experience, experienceYears, resumeText) {
  try {
    // Find the user's row number in the sheet
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: 'Users!A:A',
    });
    const rows = resp.data.values || [];
    const rowIndex = rows.findIndex(r => (r[0]||'').toLowerCase() === email.toLowerCase());
    if (rowIndex === -1) {
      console.warn('⚠️  updateUserExtractedInfo: user row not found for', email);
      return;
    }
    const sheetRow = rowIndex + 1; // 1-indexed

    // Update B (Name), E (Experience), L (Resume Text), O (Tech Stack), P (Experience Years)
    const updates = [
      { range: `Users!B${sheetRow}`, values: [[name]] },
      { range: `Users!E${sheetRow}`, values: [[experience]] },
      { range: `Users!L${sheetRow}`, values: [[(resumeText || '').slice(0, 45000)]] },
      { range: `Users!O${sheetRow}`, values: [[techStack || '']] },
      { range: `Users!P${sheetRow}`, values: [[String(experienceYears ?? '')]] },
    ];

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: {
        valueInputOption: 'RAW',
        data: updates,
      },
    });
    console.log(`✅ User row updated — Name: ${name} | Exp: ${experience} | Tech: ${techStack} | Years: ${experienceYears}`);
  } catch(e) {
    console.error('updateUserExtractedInfo failed:', e.message);
    // Non-critical — plan generation continues even if this fails
  }
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

// ══════════════════════════════════════════════════════
// PENDING PHASE 2 STORE
// Holds resumeText + context for users who haven't clicked dashboard yet
// ══════════════════════════════════════════════════════
const pendingPhase2 = new Map();

// ══════════════════════════════════════════════════════
// triggerPhase2 — called by /api/trigger-plan when user clicks "Go to Dashboard"
// ══════════════════════════════════════════════════════
// ── Get stored password for a user (needed for welcome email in Phase 2) ──
async function getUserPassword(sheets, sheetId, email) {
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Users!A:C' });
    const rows = resp.data.values || [];
    const row  = rows.find(r => (r[0]||'').toLowerCase() === email.toLowerCase());
    return row ? (row[2] || '') : '';
  } catch(e) {
    console.error('getUserPassword failed:', e.message);
    return '';
  }
}

async function triggerPhase2(email, getSheetsClientFn, sheetId) {
  const key     = email.toLowerCase();
  const pending = pendingPhase2.get(key);

  if (!pending) {
    console.warn(`⚠️  triggerPhase2: no pending data for ${email} — may have already run or expired`);
    return;
  }

  // Remove from pending immediately to prevent double-run
  pendingPhase2.delete(key);

  const { resumeText, role, tallyName, tallyTech, tallyExp, displayName } = pending;
  const t2 = Date.now();

  const runPhase2 = async () => {
    console.log('🔄 Phase 2 starting for', email);

    // Step 1: Extract name, tech stack, experience from resume
    console.log('🔍 Extracting resume info...');
    const extracted = await extractResumeInfo(resumeText, email);

    // displayName was already extracted correctly in Phase 1 via extractNameFromResume
    // Prefer it over extractResumeInfo's name (which can fall back to email prefix)
    // Only use extracted.name if displayName looks like an email prefix (no spaces = likely prefix)
    const phase1NameIsReal = displayName && displayName.includes(' ');
    const resolvedName       = phase1NameIsReal ? displayName : (extracted.name || displayName);
    const resolvedTechStack  = tallyTech || extracted.techStack  || role;
    const resolvedExperience = tallyExp  || extracted.experience || 'Mid';
    const resolvedExpYears   = extracted.experienceYears ?? 2;

    console.log(`📋 Extracted — Name: ${resolvedName} | Tech: ${resolvedTechStack} | Exp: ${resolvedExperience} (${resolvedExpYears} yrs)`);

    // Step 2: Update user row with real name, tech, experience
    await updateUserExtractedInfo(getSheetsClientFn(), sheetId, email, resolvedName, resolvedTechStack, resolvedExperience, resolvedExpYears, resumeText);

    // Step 2b: Send welcome email with real name + tech stack + experience
    try {
      const dashUrl = (process.env.APP_URL || 'https://www.rolekraft.com') + '/app';
      const pwRow = await getUserPassword(getSheetsClientFn(), sheetId, email);
      await sendWelcomeEmail(resolvedName, email, pwRow, pending.role, resolvedTechStack, resolvedExperience, resolvedExpYears, dashUrl);
      console.log('📧 Welcome email sent to', email);
    } catch(emailErr) {
      console.error('Welcome email failed:', emailErr.message);
    }


    // Step 3: Generate full 4-week plan using accurate tech + experience
    const generated = await generateWithClaude(resolvedName, email, role, resolvedExperience, resolvedTechStack, resumeText);
    await writeFullPlan(getSheetsClientFn(), sheetId, email, generated);
    await updatePlanActive(getSheetsClientFn(), sheetId, email);

    console.log('✅ Phase 2 complete in', Math.round((Date.now() - t2) / 1000), 's for', email);
  };

  try {
    await runPhase2();
  } catch(e) {
    console.error('Phase 2 failed for', email, ':', e.message);
    // Retry once after 10s
    setTimeout(async () => {
      try {
        console.log('🔁 Phase 2 retry for', email);
        await runPhase2();
        console.log('✅ Phase 2 retry succeeded for', email);
      } catch(e2) {
        console.error('Phase 2 retry also failed for', email, ':', e2.message);
      }
    }, 10000);
  }
}

module.exports = { runOnboarding, parseTallyPayload, triggerPhase2 };
