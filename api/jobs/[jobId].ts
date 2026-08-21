import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticateRequest, queryValue, rejectMethod, sendError } from "../../server/cloud/http.js";
import { createAdminClient, storageBuckets } from "../../server/cloud/supabase.js";
import type { CloudArtifacts, CloudInput, CloudJobRow } from "../../server/cloud/contracts.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!request.method || !["GET", "DELETE"].includes(request.method)) return rejectMethod(response, ["GET", "DELETE"]);
  try {
    const { user } = await authenticateRequest(request);
    const jobId = queryValue(request.query.jobId);
    if (!jobId) return response.status(400).json({ error: "Job id is required." });
    const admin = createAdminClient();
    const { data: job, error } = await admin.from("activity_jobs").select("*").eq("id", jobId).eq("user_id", user.id).maybeSingle<CloudJobRow>();
    if (error || !job) return response.status(404).json({ error: "Job not found or expired." });
    if (request.method === "GET") {
      response.setHeader("Cache-Control", "no-store");
      return response.status(200).json({ status: job.status, stage: job.stage, progress: job.progress, warnings: job.warnings, error: job.error });
    }
    const wasActive = ["queued", "running"].includes(job.status);
    if (wasActive) await admin.from("activity_jobs").update({ status: "cancelled", error: null }).eq("id", job.id).eq("user_id", user.id);
    const inputPaths = (job.inputs as CloudInput[]).map((input) => input.path);
    const outputPaths = Object.values(job.artifacts as CloudArtifacts).flatMap((artifact) => artifact ? [artifact.path] : []);
    if (inputPaths.length) await admin.storage.from(storageBuckets.inputs).remove(inputPaths);
    if (outputPaths.length) await admin.storage.from(storageBuckets.outputs).remove(outputPaths);
    // Keep an active job's cancellation marker so an in-flight worker sees it.
    // Upload reservations and terminal jobs are safe to remove immediately.
    if (!wasActive) await admin.from("activity_jobs").delete().eq("id", job.id).eq("user_id", user.id);
    response.status(204).end();
  } catch (error) { sendError(response, error); }
}
