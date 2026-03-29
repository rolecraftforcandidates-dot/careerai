# CareerAI Dashboard — Setup Guide

## What this is
A real Node.js web app that:
- Shows a login page
- Verifies email + password against your **Google Sheet** (Users tab)
- Loads each user's personalised plan, questions, scores, and resume review
- Hosted on Railway (free) — no Softr needed

---

## STEP 1 — Set up Google Sheet

Create a Google Spreadsheet with these **4 tabs** (names must match exactly):

### Tab: Users
| Email | Name | Password | Role | Experience | Week | Plan Active | ATS Score | ATS Tips | Resume URL |
|-------|------|----------|------|------------|------|-------------|-----------|----------|------------|
| rahul@gmail.com | Rahul Kumar | Career@2025 | Frontend Dev | Mid | 2 | TRUE | 72 | Missing keywords\nVague impact statements\nStrong project section | |

### Tab: Plans
| Email | Week | Day | Task Title | Type | Status | Role |
|-------|------|-----|-----------|------|--------|------|
| rahul@gmail.com | 1 | 1 | Resume keyword optimisation | Theory | Done | Frontend Dev |

### Tab: Questions
| Email | Week | Q No. | Type | Question | Answer | Score | AI Feedback | Submitted |
|-------|------|-------|------|----------|--------|-------|-------------|-----------|
| rahul@gmail.com | 2 | Q1 | Technical | Explain useMemo vs useCallback | | | | FALSE |

### Tab: Scores
| Email | Week | Q No. | Score | Technical | Communication | Problem Solving | Behavioral | Date |
|-------|------|-------|-------|-----------|---------------|-----------------|------------|------|
| rahul@gmail.com | 1 | Q1 | 78 | 75 | 80 | 72 | 85 | 2025-01-20 |

---

## STEP 2 — Get Google Sheets API credentials

1. Go to https://console.cloud.google.com
2. Click **"New Project"** → name it `careerai` → Create
3. In the left menu → **APIs & Services → Library**
4. Search **"Google Sheets API"** → click it → click **Enable**
5. Go to **APIs & Services → Credentials**
6. Click **"+ Create Credentials" → Service Account**
7. Name: `careerai-sheets` → click **Create and Continue → Done**
8. Click the service account email you just created
9. Go to **Keys tab → Add Key → Create new key → JSON**
10. A `.json` file will download — **keep this safe**

11. Open your Google Sheet
12. Click **Share** (top right)
13. Paste the `client_email` from the JSON file → give it **Editor** access → Share

---

## STEP 3 — Configure environment variables

Copy `.env.example` to `.env`:
```
cp .env.example .env
```

Open `.env` and fill in:

```env
# Paste your Google Sheet ID from the URL:
# https://docs.google.com/spreadsheets/d/THIS_PART_HERE/edit
SHEET_ID=your_sheet_id_here

# Paste the ENTIRE contents of the downloaded JSON file as one line:
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"careerai",...}

# Generate a random secret (run this in terminal):
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=paste_random_string_here
```

---

## STEP 4 — Test locally (optional)

```bash
npm install
npm run dev
```

Open http://localhost:3000 — you should see the login page.
Log in with any email/password that exists in your Users sheet with Plan Active = TRUE.

---

## STEP 5 — Deploy to Railway

1. Go to https://railway.app → Sign up with GitHub (free)
2. Click **"New Project" → "Deploy from GitHub repo"**
3. Push this folder to a GitHub repo first:
   ```bash
   git init
   git add .
   git commit -m "Initial CareerAI deploy"
   # Create a repo on github.com, then:
   git remote add origin https://github.com/YOUR_USERNAME/careerai-app.git
   git push -u origin main
   ```
4. In Railway, select your repo → it auto-detects Node.js
5. Go to your project → **Variables tab** → add these:
   - `SHEET_ID` = your sheet ID
   - `GOOGLE_SERVICE_ACCOUNT_JSON` = entire JSON as one line
   - `SESSION_SECRET` = your random string
   - `NODE_ENV` = production
6. Railway deploys automatically — takes ~2 minutes
7. Click **"Generate Domain"** → you get a free URL like `careerai-app.up.railway.app`

---

## STEP 6 — Update your landing page

Open `ai-career-agent-white.html` and update the two buttons:

```html
<!-- Paid plan button -->
<a href="YOUR_RAZORPAY_LINK">Get Full Access — ₹999</a>

<!-- Already have access button / nav link -->
<a href="https://careerai-app.up.railway.app">Login to Dashboard</a>
```

---

## STEP 7 — Zapier automation (payment → auto add user)

When someone pays on Razorpay, Zapier automatically adds them to your Sheet:

1. Zapier → New Zap
2. **Trigger**: Razorpay → Payment Captured
3. **Action 1**: Zapier Formatter → Text → lowercase the email
4. **Action 2**: Google Sheets → Create Row in Users tab:
   - Email = (lowercased from step 3)
   - Name = from Razorpay payment data
   - Password = `Career@2025` (default, they can ask you to change)
   - Role = (blank — you fill after they tell you)
   - Week = 1
   - Plan Active = TRUE
   - Access = Full
5. **Action 3**: Gmail → Send email with login link

---

## How to add AI scores after users submit answers

1. Open Google Sheet → Questions tab
2. Find rows where `Submitted = TRUE` and `Score` is empty
3. Copy the answer → go to Claude → use this prompt:

```
Score this interview answer out of 100. Give:
1. Overall Score (number only)
2. Technical /100
3. Communication /100
4. Problem Solving /100
5. Behavioral /100
6. 2-3 sentence feedback

Question: [paste]
Answer: [paste]
Role: [paste from Users tab]
```

4. Paste scores into: Score, Technical, Communication, Problem Solving, Behavioral, AI Feedback columns
5. Also add a new row in Scores tab with same data + today's date
6. User sees the score next time they log in — no other action needed

---

## Adding ATS Score for a user's resume

1. After reviewing their resume, go to Users tab
2. Fill in `ATS Score` (number like 72) and `ATS Tips` (one tip per line, use \n to separate)
3. User sees it in their Resume Review panel automatically

---

## Project Structure

```
careerai-app/
├── server.js          ← Main backend (Express + Google Sheets API)
├── package.json       ← Dependencies
├── railway.toml       ← Railway deployment config
├── .env.example       ← Environment variables template
├── .gitignore
└── public/
    └── index.html     ← Full dashboard frontend
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Login says "No account found" | Check email matches exactly in Users tab (must be lowercase) |
| Login says "account not active" | Set Plan Active = TRUE in Users tab |
| Google Sheets error on Railway | Check GOOGLE_SERVICE_ACCOUNT_JSON is valid JSON on one line |
| Dashboard shows no plan | Add rows to Plans tab with user's email |
| Score bars empty | Add a row to Scores tab with all 5 skill columns filled |
| Session logs out immediately | Set SESSION_SECRET in Railway Variables |
