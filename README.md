# Collaborative Activity PowerPoint Generator

A Windows-only, local teacher console that analyses a syllabus and teaching materials with Gemini, then creates editable Set A, Set B, and compiled-answer PowerPoints.

## Requirements

- Windows with Microsoft Word and PowerPoint installed
- Node.js 22 or newer
- Internet access for Gemini
- Environment settings based on `.env.example`

Supported inputs are PDF/DOCX for the syllabus, PDF/DOCX/PPTX for learning materials, and up to three template PowerPoints. The three PowerPoints in the parent `Output` folder are loaded as the default templates; replacing them in the console never changes the originals. Template decks guide formatting and layout only and are not treated as content evidence. Macro-enabled formats are rejected. Files are limited to 50 MB each and 1,000 combined pages.

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
ALLOWED_EMAIL_DOMAIN=YOUR_SCHOOL_DOMAIN.edu
VITE_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_YOUR_SUPABASE_KEY
VITE_ALLOWED_EMAIL_DOMAIN=YOUR_SCHOOL_DOMAIN.edu
VITE_SUPABASE_ALLOW_SIGNUPS=true
```

The browser receives only the Supabase URL and publishable key. The Gemini key remains server-only. The API independently validates each Supabase access token and rejects users outside `ALLOWED_EMAIL_DOMAIN`; generation jobs and downloads are also scoped to the authenticated user. Keep `VITE_SUPABASE_ALLOW_SIGNUPS=true` when teachers with an approved-domain address should be able to sign in for the first time. The domain check in the browser is only guidance—the API check is the security boundary.

`GEMINI_FAKE=1` enables deterministic mock generation for offline UI/integration testing. Never use mock output in class.

Generated files live in a job-specific OS temporary directory and expire after 30 minutes. The API key is server-only and never included in browser assets.

## Verification

```powershell
npm test
npm run build
```

Every generated PPTX is opened and rendered by Microsoft PowerPoint before it is offered for download. The ZIP contains exactly the three PPTX artifacts.

For `N` generated questions, each deck must contain exactly `N + 1` slides: one instruction slide and one slide per question. Every compiled debrief slide contains the complete common, Set A, and Set B answer for that question; continuation and separate solution slides are not permitted.

Question and answer content is source-locked. The syllabus defines scope, while lecture notes, worked examples, tutorials and supplied answers provide the permitted facts, terminology, examples and reasoning steps. Each common, Set A and Set B answer carries exact file/page evidence and a short supporting quotation or faithful paraphrase in speaker notes. A deterministic grounding audit rejects unknown files, vague locations and syllabus-only answer evidence, and requests one automatic repair pass when necessary.

## GitHub and Vercel deployment boundary

Commit `.env.example`, but never commit `.env`. Add the values from `.env.example` to the Vercel project's environment variables for Preview and Production. Configure the production URL in Supabase's URL settings before testing OTP email delivery.

The React login interface can be hosted on Vercel, but the current generation service cannot run there unchanged. It depends on Windows Microsoft Word and PowerPoint automation, keeps active jobs in process memory, and writes temporary PowerPoint artifacts to the local filesystem. Host that API/worker on a persistent Windows machine (set `HOST=0.0.0.0` there) or replace those dependencies with a Linux-compatible conversion/rendering pipeline plus a durable job queue and object storage. Do not point a public Vercel frontend at this service until HTTPS, upload limits, rate limiting and persistent artifact storage are in place.
