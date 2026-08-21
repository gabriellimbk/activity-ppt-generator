import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticateRequest, queryValue, rejectMethod, sendError } from "../../../../server/cloud/http.js";
import { createAdminClient, storageBuckets } from "../../../../server/cloud/supabase.js";
import type { CloudArtifacts, CloudJobRow } from "../../../../server/cloud/contracts.js";

const artifactKeys = new Set<keyof CloudArtifacts>(["setA", "setB", "answers", "bundle"]);

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "GET") return rejectMethod(response, ["GET"]);
  try {
    const { user } = await authenticateRequest(request);
    const jobId = queryValue(request.query.jobId); const key = queryValue(request.query.artifact) as keyof CloudArtifacts | undefined;
    if (!jobId || !key || !artifactKeys.has(key)) return response.status(400).json({ error: "A valid job and artifact are required." });
    const admin = createAdminClient();
    const { data: job } = await admin.from("activity_jobs").select("status,artifacts,user_id").eq("id", jobId).eq("user_id", user.id).maybeSingle<Pick<CloudJobRow, "status" | "artifacts" | "user_id">>();
    const artifact = job?.artifacts?.[key];
    if (!job) return response.status(404).json({ error: "Job not found or expired." });
    if (job.status !== "ready" || !artifact) return response.status(409).json({ error: "Artifact is not ready." });
    const { data, error } = await admin.storage.from(storageBuckets.outputs).createSignedUrl(artifact.path, 60, { download: artifact.filename });
    if (error || !data) throw new Error(`Could not prepare the download: ${error?.message ?? "unknown error"}`);
    response.setHeader("Cache-Control", "no-store");
    response.redirect(302, data.signedUrl);
  } catch (error) { sendError(response, error); }
}
