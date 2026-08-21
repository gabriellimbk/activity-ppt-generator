import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileTypeFromFile } from "file-type";
import { createAdminClient, storageBuckets } from "./supabase.js";
import type { CloudArtifact, CloudArtifacts, CloudInput, CloudJobRow } from "./contracts.js";
import type { InputFile } from "../pipeline.js";
import { runPipeline } from "../pipeline.js";
import type { Job } from "../types.js";

const expectedMime: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const templateNames = ["Set A.pptx", "Set B.pptx", "Ans for Set A and B.pptx"];
const safeName = (value: string) => basename(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 180);

async function downloadInput(input: CloudInput, dir: string): Promise<InputFile> {
  const admin = createAdminClient();
  const { data, error } = await admin.storage.from(storageBuckets.inputs).download(input.path);
  if (error || !data) throw new Error(`Could not download ${input.name}: ${error?.message ?? "missing object"}`);
  const path = join(dir, `${crypto.randomUUID()}-${safeName(input.name)}`);
  await writeFile(path, Buffer.from(await data.arrayBuffer()));
  const ext = extname(input.name).toLowerCase();
  const detected = await fileTypeFromFile(path);
  if (!expectedMime[ext] || detected?.mime !== expectedMime[ext]) throw new Error(`${input.name} does not match its declared file type.`);
  return { path, originalname: safeName(input.name), role: input.role };
}

async function bundledReferences(dir: string): Promise<InputFile[]> {
  const result: InputFile[] = [];
  for (const name of templateNames) {
    const source = join(process.cwd(), "assets", "templates", name);
    if (!existsSync(source)) throw new Error(`Bundled template is missing: ${name}`);
    const path = join(dir, `${crypto.randomUUID()}-${name}`);
    await copyFile(source, path);
    result.push({ path, originalname: name, role: "Reference format" });
  }
  return result;
}

async function uploadArtifact(job: CloudJobRow, key: keyof CloudArtifacts, localPath: string): Promise<CloudArtifact> {
  const admin = createAdminClient();
  const filename = safeName(basename(localPath));
  const path = `${job.user_id}/${job.id}/artifacts/${filename}`;
  const bytes = await readFile(localPath);
  const mime = key === "bundle" ? "application/zip" : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const { error } = await admin.storage.from(storageBuckets.outputs).upload(path, bytes, { contentType: mime, upsert: true, cacheControl: "3600" });
  if (error) throw new Error(`Could not store ${filename}: ${error.message}`);
  return { path, filename, mime, size: bytes.length };
}

export async function processCloudJob(jobId: string, force = false) {
  process.env.SERVERLESS_MODE = "1";
  const admin = createAdminClient();
  const { data: current, error: readError } = await admin.from("activity_jobs").select("*").eq("id", jobId).maybeSingle<CloudJobRow>();
  if (readError || !current) throw new Error(`Job ${jobId} is unavailable: ${readError?.message ?? "not found"}`);
  if (current.status === "ready" || current.status === "cancelled") return;
  if (current.status === "running" && !force) return;

  const { data: claimed, error: claimError } = await admin.from("activity_jobs").update({ status: "running", stage: "Preparing files", progress: 2, error: null }).eq("id", jobId).select("*").single<CloudJobRow>();
  if (claimError || !claimed) throw new Error(`Could not claim job ${jobId}: ${claimError?.message ?? "unknown error"}`);
  const dir = await mkdtemp(join(tmpdir(), `activity-${jobId}-`));
  const abort = new AbortController();
  const cancelTimer = setInterval(async () => {
    const { data } = await admin.from("activity_jobs").select("status").eq("id", jobId).maybeSingle<{ status: string }>();
    if (!data || data.status === "cancelled") abort.abort();
  }, 2500);
  cancelTimer.unref();

  try {
    await mkdir(join(dir, "sources"), { recursive: true });
    const downloaded = await Promise.all(claimed.inputs.map((input) => downloadInput(input, join(dir, "sources"))));
    const syllabusIndex = claimed.inputs.findIndex((input) => input.kind === "syllabus");
    const syllabus = downloaded[syllabusIndex];
    const materials = downloaded.filter((_file, index) => claimed.inputs[index].kind === "material");
    const uploadedReferences = downloaded.filter((_file, index) => claimed.inputs[index].kind === "reference");
    const references = uploadedReferences.length ? uploadedReferences : claimed.use_default_references ? await bundledReferences(join(dir, "sources")) : [];
    if (!syllabus || !materials.length) throw new Error("The cloud job is missing its syllabus or learning materials.");

    const localJob: Job = {
      id: claimed.id, userId: claimed.user_id, dir, status: "running", stage: "Preparing files", progress: 2,
      warnings: claimed.warnings ?? [], createdAt: Date.now(), abort, artifacts: {}, events: new Set(),
      onProgress: async (payload) => {
        await admin.from("activity_jobs").update({ status: payload.status, stage: payload.stage, progress: payload.progress, warnings: payload.warnings, error: payload.error ?? null }).eq("id", jobId).neq("status", "cancelled");
      },
    };
    await runPipeline(localJob, materials, syllabus, references, claimed.design_prompt, claimed.additional_prompt);
    if (localJob.status === "cancelled") {
      await admin.from("activity_jobs").update({ status: "cancelled", error: null }).eq("id", jobId);
      return;
    }
    if (localJob.status !== "ready") throw new Error(localJob.error ?? "PowerPoint generation failed.");

    const artifacts: CloudArtifacts = {};
    for (const key of ["setA", "setB", "answers", "bundle"] as const) {
      const path = localJob.artifacts[key];
      if (!path) throw new Error(`The ${key} artifact was not created.`);
      artifacts[key] = await uploadArtifact(claimed, key, path);
    }
    const { error: readyError } = await admin.from("activity_jobs").update({ status: "ready", stage: "Ready", progress: 100, warnings: localJob.warnings, error: null, artifacts }).eq("id", jobId).neq("status", "cancelled");
    if (readyError) throw new Error(`Could not complete job ${jobId}: ${readyError.message}`);
    await admin.storage.from(storageBuckets.inputs).remove(claimed.inputs.map((input) => input.path));
  } catch (error) {
    if (abort.signal.aborted) await admin.from("activity_jobs").update({ status: "cancelled", error: null }).eq("id", jobId);
    else await admin.from("activity_jobs").update({ status: "failed", error: error instanceof Error ? error.message : String(error) }).eq("id", jobId);
    throw error;
  } finally {
    clearInterval(cancelTimer);
    await rm(dir, { recursive: true, force: true });
  }
}
