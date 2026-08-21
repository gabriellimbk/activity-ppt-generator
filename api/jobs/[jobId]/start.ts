import type { VercelRequest, VercelResponse } from "@vercel/node";
import { send } from "@vercel/queue";
import { authenticateRequest, queryValue, rejectMethod, sendError } from "../../../server/cloud/http.js";
import { createAdminClient } from "../../../server/cloud/supabase.js";
import type { CloudJobRow } from "../../../server/cloud/contracts.js";

const fileName = (path: string) => path.split("/").at(-1) ?? "";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "POST") return rejectMethod(response, ["POST"]);
  try {
    const { user } = await authenticateRequest(request);
    const jobId = queryValue(request.query.jobId);
    if (!jobId) return response.status(400).json({ error: "Job id is required." });
    const admin = createAdminClient();
    const { data: job } = await admin.from("activity_jobs").select("id,status,inputs").eq("id", jobId).eq("user_id", user.id).maybeSingle<Pick<CloudJobRow, "id" | "status" | "inputs">>();
    if (!job) return response.status(404).json({ error: "Reserved job not found." });
    if (!["uploading", "failed"].includes(job.status)) return response.status(202).json({ jobId, status: job.status });
    const folders = [...new Set(job.inputs.map((input) => input.path.split("/").slice(0, -1).join("/")))];
    const listings = await Promise.all(folders.map(async (folder) => {
      const { data, error } = await admin.storage.from("activity-inputs").list(folder, { limit: 100 });
      if (error) throw new Error(`Could not verify uploaded files: ${error.message}`);
      return new Set((data ?? []).map((item) => `${folder}/${item.name}`));
    }));
    const uploadedPaths = new Set(listings.flatMap((listing) => [...listing]));
    const missing = job.inputs.filter((input) => !uploadedPaths.has(input.path));
    if (missing.length) return response.status(409).json({ error: `Upload did not finish for: ${missing.map((input) => fileName(input.path)).join(", ")}` });
    const { error: updateError } = await admin.from("activity_jobs").update({
      status: "queued", progress: 18, error: null, expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    }).eq("id", jobId).eq("user_id", user.id);
    if (updateError) throw new Error(`Could not queue the job: ${updateError.message}`);
    try {
      await send("activity-generation", { jobId }, { idempotencyKey: jobId, retentionSeconds: 86_400 });
    } catch (queueError) {
      await admin.from("activity_jobs").update({ status: "failed", error: queueError instanceof Error ? queueError.message : String(queueError) }).eq("id", jobId);
      throw queueError;
    }
    response.status(202).json({ jobId, status: "queued" });
  } catch (error) { sendError(response, error); }
}
