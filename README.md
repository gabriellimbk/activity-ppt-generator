# Collaborative Activity PowerPoint Generator

A secure teacher console that analyses a syllabus and teaching materials with Gemini, then creates editable Set A, Set B, and compiled-answer PowerPoints. It supports both the original Windows-local workflow and a Vercel + Supabase cloud workflow.

## Local requirements

- Windows with Microsoft Word and PowerPoint installed
- Node.js 22 or newer
- Internet access for Gemini
- Environment settings based on `.env.example`

Supported inputs are PDF/DOCX for the syllabus, PDF/DOCX/PPTX for learning materials, and up to three template PowerPoints. The three PowerPoints in `assets/templates` are the deployable defaults; replacing them in the console never changes the originals. Template decks guide formatting and layout only and are not treated as content evidence. Macro-enabled formats are rejected. Files are limited to 50 MB each and 1,000 combined pages.

## Run locally

```powershell
cd "C:\Projects\Collaborative Activity\console"
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. The API listens only on `127.0.0.1:4174`.

Supabase email OTP is required. Copy `.env.example` to `.env`, replace every placeholder, and keep the file out of Git. In Supabase, open **Authentication → Email Templates → Magic Link** and include `{{ .Token }}` in the message body so the email contains the six-digit code. Set the site URL and permitted redirect URLs to your local and production addresses.

For public use with first-time signup enabled, also configure Supabase's **Before User Created** hook to allow only the same school domain. The browser and Express API both enforce the domain, while the Supabase hook prevents direct signup attempts from creating out-of-domain Auth users.

For a production-style local run:

```powershell
npm run build
npm start
```

Then open `http://127.0.0.1:4174`.

## Configuration

The server reads `console/.env` first and falls back to the parent `.env` file for existing local installations. Supported values are:

```dotenv
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3-flash-preview
CROP_CONCURRENCY=5
CROP_DPI=150
HOST=127.0.0.1
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_SUPABASE_KEY
SUPABASE_SECRET_KEY=sb_secret_YOUR_SERVER_ONLY_KEY
ALLOWED_EMAIL_DOMAIN=YOUR_SCHOOL_DOMAIN.edu
CRON_SECRET=YOUR_RANDOM_CRON_SECRET
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_SUPABASE_KEY
VITE_ALLOWED_EMAIL_DOMAIN=YOUR_SCHOOL_DOMAIN.edu
VITE_SUPABASE_ALLOW_SIGNUPS=true
VITE_SERVERLESS_MODE=true
```

The browser receives only the Supabase URL and publishable key. The Gemini key remains server-only. The API independently validates each Supabase access token and rejects users outside `ALLOWED_EMAIL_DOMAIN`; generation jobs and downloads are also scoped to the authenticated user. Keep `VITE_SUPABASE_ALLOW_SIGNUPS=true` when teachers with an approved-domain address should be able to sign in for the first time. The domain check in the browser is only guidance—the API check is the security boundary.

`GEMINI_FAKE=1` enables deterministic mock generation for offline UI/integration testing. Never use mock output in class.

Generated files live in a job-specific OS temporary directory and expire after 30 minutes. The API key is server-only and never included in browser assets.

## Verification

```powershell
npm test
npm run build
```

In local Windows mode, every generated PPTX is opened and rendered by Microsoft PowerPoint before download. In Vercel mode, every PPTX is structurally opened and its slide count is checked; a warning is added because desktop PowerPoint visual rendering is unavailable in a Linux serverless function. The ZIP contains exactly the three PPTX artifacts.

For `N` generated questions, each deck must contain exactly `N + 1` slides: one instruction slide and one slide per question. Every compiled debrief slide contains the complete common, Set A, and Set B answer for that question; continuation and separate solution slides are not permitted.

Question and answer content is source-locked. The syllabus defines scope, while lecture notes, worked examples, tutorials and supplied answers provide the permitted facts, terminology, examples and reasoning steps. Each common, Set A and Set B answer carries exact file/page evidence and a short supporting quotation or faithful paraphrase in speaker notes. A deterministic grounding audit rejects unknown files, vague locations and syllabus-only answer evidence, and requests one automatic repair pass when necessary.

## Deploy with GitHub, Vercel and Supabase

The cloud redesign uses only these three services:

- Vercel hosts React, authenticated API functions, the durable generation queue and its worker.
- Supabase provides six-digit email OTP, private input/output Storage and durable job state.
- GitHub is the deployment source.

Before the first deployment:

1. Open the Supabase SQL editor and run `supabase/migrations/20260821_serverless_activity_jobs.sql`. This creates the private buckets, row-level policies and activity job table. The upload policy permits a teacher to upload only into a job they first reserved.
2. Import the GitHub repository in Vercel. Keep **Root Directory** as `./`, use the Vite framework preset (or let Vercel detect it), and retain the build settings from `vercel.json`.
3. Add every variable below in Vercel for Production and Preview. Generate `CRON_SECRET` as a long random value. Never put `SUPABASE_SECRET_KEY` or `GEMINI_API_KEY` in a `VITE_` variable.
4. Deploy. Add `https://YOUR_VERCEL_DOMAIN` to Supabase **Authentication → URL Configuration** as the Site URL and an allowed redirect URL.
5. Test OTP sign-in, reserve/upload/generate, all four download buttons, cancellation, and a second generation after the first completes.

Required Vercel variables:

```dotenv
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3-flash-preview
CROP_CONCURRENCY=5
CROP_DPI=150
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SECRET_KEY=sb_secret_...
ALLOWED_EMAIL_DOMAIN=school.edu
CRON_SECRET=generate-a-long-random-value
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_ALLOWED_EMAIL_DOMAIN=school.edu
VITE_SUPABASE_ALLOW_SIGNUPS=true
VITE_SERVERLESS_MODE=true
```

The browser uploads directly to the private `activity-inputs` bucket, avoiding Vercel's request-body limit. One active generation is allowed per user. Queue progress and artifacts survive individual function invocations; output links are signed and jobs expire after 30 minutes. A daily Vercel cron removes expired records and objects.

DOCX/PPTX files are not converted with Microsoft Office in Vercel. The cloud worker uses direct structured extraction instead: PPTX slide numbers, shape positions, dimensions, font sizes, emphasis, colours, text and tables are retained for analysis. Embedded visuals and Word pagination may be incomplete and are reported as evidence-quality warnings. PDF remains the highest-fidelity cloud input format.

Commit `.env.example`, `vercel.json`, `assets/templates`, `api`, `server/cloud`, and the Supabase migration. Never commit `.env`.
