import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createCloudJobSchema } from "../../server/cloud/contracts.js";
import { authenticateRequest, rejectMethod, sendError } from "../../server/cloud/http.js";
import { createAdminClient } from "../../server/cloud/supabase.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "POST") return rejectMethod(response, ["POST"]);
  try {
    const { user } = await authenticateRequest(request);
    const body = createCloudJobSchema.parse(request.body);
    const prefix = `${user.id}/${body.id}/`;
    if (body.inputs.some((input) => !input.path.startsWith(prefix) || input.path.includes(".."))) return response.status(400).json({ error: "An uploaded file path is outside this job." });
    const admin = createAdminClient();
    const { data: active } = await admin.from("activity_jobs").select("id").eq("user_id", user.id).in("status", ["uploading", "queued", "running"]).limit(1);
    if (active?.length) return response.status(409).json({ error: "You already have a generation in progress. Cancel it or wait for it to finish before starting another." });
    const { error } = await admin.from("activity_jobs").insert({
      id: body.id, user_id: user.id, status: "uploading", stage: "Preparing files", progress: 0,
      warnings: [], inputs: body.inputs, artifacts: {}, use_default_references: body.useDefaultReferences,
      design_prompt: body.designPrompt, additional_prompt: body.additionalPrompt,
    });
    if (error?.code === "23505") return response.status(409).json({ error: "You already have a generation in progress." });
    if (error) throw new Error(`Could not create the generation job: ${error.message}`);
    response.status(201).json({ jobId: body.id, status: "uploading" });
  } catch (error) { sendError(response, error); }
}
