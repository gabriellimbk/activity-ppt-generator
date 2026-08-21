import express from "express";
import multer from "multer";
import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileTypeFromFile } from "file-type";
import JSZip from "jszip";
import { createClient } from "@supabase/supabase-js";
import type { Job } from "./types.js";
import { normalize, runPipeline, type InputFile } from "./pipeline.js";

const ROOT = join(tmpdir(), "collaborative-activity-generator");
await mkdir(ROOT, { recursive: true });
const upload = multer({ dest: join(ROOT, "incoming"), limits: { fileSize: 50 * 1024 * 1024, files: 54 } });
const jobs = new Map<string, Job>();
const supabaseUrl = process.env.SUPABASE_URL?.trim();
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
const allowedEmailDomain = process.env.ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase().replace(/^@/, "");
const authConfigured = Boolean(
  supabaseUrl &&
    supabasePublishableKey &&
    allowedEmailDomain &&
    !/YOUR_PROJECT/i.test(supabaseUrl) &&
    !/YOUR_/i.test(supabasePublishableKey) &&
    !allowedEmailDomain.includes("your_"),
);
const supabaseAuth = authConfigured ? createClient(supabaseUrl!, supabasePublishableKey!, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
type AuthenticatedRequest = express.Request & { authUserId: string };
const allowedMaterials = new Set([".pdf", ".docx", ".pptx"]);
const allowedSyllabus = new Set([".pdf", ".docx"]);
const allowedReferences = new Set([".pptx"]);
const expectedMime: Record<string, string> = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
const DEFAULT_REFERENCE_NAMES = ["Set A.pptx", "Set B.pptx", "Ans for Set A and B.pptx"];
const bundledReferences = DEFAULT_REFERENCE_NAMES.map((name) => resolve(process.cwd(), "assets", "templates", name));
const legacyReferences = DEFAULT_REFERENCE_NAMES.map((name) => resolve(process.cwd(), "..", "Output", name));
const DEFAULT_REFERENCES = bundledReferences.every(existsSync) ? bundledReferences : legacyReferences;
async function hasValidSignature(file: Express.Multer.File) { const detected = await fileTypeFromFile(file.path); return Boolean(detected && detected.mime === expectedMime[extname(file.originalname).toLowerCase()]); }

function safeOriginal(name: string) { return basename(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 180); }
async function cleanup(job: Job) {
  jobs.delete(job.id);
  const target = resolve(job.dir); const root = resolve(ROOT);
  if (target.startsWith(root + "\\") || target.startsWith(root + "/")) await rm(target, { recursive: true, force: true });
}

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.get("/api/health", (_request, response) => response.json({ status: "ok", model: process.env.GEMINI_MODEL ?? "gemini-3-flash-preview", authentication: authConfigured ? "supabase" : "not-configured" }));
app.use("/api", async (request, response, next) => {
  if (!supabaseAuth) return void response.status(503).json({ error: "Supabase authentication is not configured on the server." });
  const authorization = request.headers.authorization ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return void response.status(401).json({ error: "Authentication is required." });
  const { data, error } = await supabaseAuth.auth.getUser(token);
  if (error || !data.user) return void response.status(401).json({ error: "Your session is invalid or has expired." });
  if (!data.user.email?.toLowerCase().endsWith(`@${allowedEmailDomain}`)) return void response.status(403).json({ error: `Use an @${allowedEmailDomain} email account.` });
  (request as AuthenticatedRequest).authUserId = data.user.id;
  next();
});

function ownedJob(request: express.Request) {
  const rawJobId = request.params.jobId;
  const jobId = Array.isArray(rawJobId) ? rawJobId[0] : rawJobId;
  const job = jobs.get(jobId);
  return job?.userId === (request as AuthenticatedRequest).authUserId ? job : undefined;
}

app.get("/api/reference-defaults", async (_request, response) => {
  const files = await Promise.all(DEFAULT_REFERENCES.filter(existsSync).map(async (path) => {
    const zip = await JSZip.loadAsync(await readFile(path));
    const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
    return { name: basename(path), slides, size: (await stat(path)).size };
  }));
  response.json({ files });
});

app.post("/api/inspect", upload.single("file"), async (request, response) => {
  if (!request.file) return void response.status(400).json({ error: "File is required." });
  const ext = extname(request.file.originalname).toLowerCase();
  if (!allowedMaterials.has(ext) || !(await hasValidSignature(request.file))) { await rm(request.file.path, { force: true }); return void response.status(400).json({ error: "Unsupported file type or file signature." }); }
  const dir = join(ROOT, `inspect-${randomUUID()}`); await mkdir(dir, { recursive: true });
  try { const result = await normalize({ path: request.file.path, originalname: safeOriginal(request.file.originalname), role: "Other" }, dir); response.json({ pages: result.pages, warning: result.warning }); }
  finally { await rm(request.file.path, { force: true }); await rm(dir, { recursive: true, force: true }); }
});

app.post("/api/jobs", upload.fields([{ name: "materials", maxCount: 50 }, { name: "syllabus", maxCount: 1 }, { name: "references", maxCount: 3 }]), async (request, response) => {
  const fields = request.files as Record<string, Express.Multer.File[]> | undefined;
  const materialUploads = fields?.materials ?? []; const syllabusUpload = fields?.syllabus?.[0]; const referenceUploads = fields?.references ?? [];
  const reject = async (message: string, status = 400) => { await Promise.all(Object.values(fields ?? {}).flat().map((file) => rm(file.path, { force: true }))); response.status(status).json({ error: message }); };
  if (!materialUploads.length || !syllabusUpload) return void await reject("At least one material and exactly one syllabus are required.");
  if (materialUploads.some((file) => !allowedMaterials.has(extname(file.originalname).toLowerCase())) || !allowedSyllabus.has(extname(syllabusUpload.originalname).toLowerCase())) return void await reject("Unsupported or macro-enabled file type.");
  if (referenceUploads.some((file) => !allowedReferences.has(extname(file.originalname).toLowerCase()))) return void await reject("Template PowerPoints must be editable PPTX files.");
  if (!(await Promise.all([...materialUploads, syllabusUpload, ...referenceUploads].map(hasValidSignature))).every(Boolean)) return void await reject("A file's contents do not match its extension.");
  const designPrompt = String(request.body.designPrompt ?? "").trim(); if (designPrompt.length < 20) return void await reject("The design prompt is missing or too short.");
  const id = randomUUID(); const dir = join(ROOT, id); await mkdir(dir, { recursive: true });
  let roles: Record<string, string> = {}; try { roles = JSON.parse(String(request.body.roles ?? "{}")); } catch { return void await reject("Material roles are invalid."); }
  const move = async (file: Express.Multer.File, role: string): Promise<InputFile> => {
    const name = `${randomUUID()}-${safeOriginal(file.originalname)}`; const path = join(dir, name);
    await import("node:fs/promises").then((fs) => fs.rename(file.path, path));
    return { path, originalname: safeOriginal(file.originalname), role };
  };
  const materials = await Promise.all(materialUploads.map((file) => move(file, roles[file.originalname] ?? "Other")));
  const syllabus = await move(syllabusUpload, "Syllabus");
  const useDefaultReferences = String(request.body.useDefaultReferences ?? "true") !== "false";
  const references = referenceUploads.length
    ? await Promise.all(referenceUploads.map((file) => move(file, "Reference format")))
    : useDefaultReferences ? await Promise.all(DEFAULT_REFERENCES.filter(existsSync).map(async (source) => {
      const originalname = safeOriginal(basename(source)); const path = join(dir, `${randomUUID()}-${originalname}`); await copyFile(source, path);
      return { path, originalname, role: "Reference format" } satisfies InputFile;
    })) : [];
  const job: Job = { id, userId: (request as AuthenticatedRequest).authUserId, dir, status: "queued", stage: "Preparing files", progress: 0, warnings: [], createdAt: Date.now(), abort: new AbortController(), artifacts: {}, events: new Set() };
  job.cleanup = () => cleanup(job);
  jobs.set(id, job); setTimeout(() => void cleanup(job), 30 * 60_000).unref();
  response.status(202).json({ jobId: id });
  void runPipeline(job, materials, syllabus, references, designPrompt, String(request.body.additionalPrompt ?? ""));
});

app.get("/api/jobs/:jobId/events", (request, response) => {
  const job = ownedJob(request); if (!job) return void response.status(404).json({ error: "Job not found or expired." });
  response.setHeader("Content-Type", "text/event-stream"); response.setHeader("Cache-Control", "no-cache"); response.setHeader("Connection", "keep-alive");
  const send = (payload: object) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
  job.events.add(send); send({ status: job.status, stage: job.stage, progress: job.progress, warnings: job.warnings, error: job.error });
  const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
  request.on("close", () => { clearInterval(keepAlive); job.events.delete(send); });
});

app.get("/api/jobs/:jobId", (request, response) => {
  const job = ownedJob(request); if (!job) return void response.status(404).json({ error: "Job not found or expired." });
  response.json({ status: job.status, stage: job.stage, progress: job.progress, warnings: job.warnings, error: job.error });
});

app.post("/api/jobs/:jobId/cancel", async (request, response) => {
  const job = ownedJob(request); if (!job) return void response.status(404).json({ error: "Job not found." });
  job.abort.abort(); job.status = "cancelled"; response.status(202).json({ status: "cancelled" });
});

app.get("/api/jobs/:jobId/files/:artifact", (request, response) => {
  const job = ownedJob(request); const artifact = request.params.artifact as keyof Job["artifacts"];
  if (!job) return void response.status(404).json({ error: "Job not found or expired." });
  if (job.status !== "ready" || !job.artifacts[artifact]) return void response.status(409).json({ error: "Artifact is not ready." });
  const path = job.artifacts[artifact]!; response.setHeader("Content-Disposition", `attachment; filename="${basename(path)}"`); createReadStream(path).pipe(response);
});

app.delete("/api/jobs/:jobId", async (request, response) => {
  const job = ownedJob(request); if (!job) return void response.status(204).end();
  job.abort.abort(); await cleanup(job); response.status(204).end();
});

const clientDir = resolve(process.cwd(), "dist", "client");
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get("/{*path}", (request, response, next) => request.path.startsWith("/api/") ? next() : response.sendFile(join(clientDir, "index.html")));
}

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE" ? "Each file must be 50 MB or smaller." : error instanceof Error ? error.message : "Unexpected server error.";
  response.status(400).json({ error: message });
});
