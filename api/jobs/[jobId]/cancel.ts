import type { VercelRequest, VercelResponse } from "@vercel/node";
import { authenticateRequest, queryValue, rejectMethod, sendError } from "../../../server/cloud/http.js";
import { createAdminClient } from "../../../server/cloud/supabase.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "POST") return rejectMethod(response, ["POST"]);
  try {
    const { user } = await authenticateRequest(request);
    const jobId = queryValue(request.query.jobId);
    if (!jobId) return response.status(400).json({ error: "Job id is required." });
    const { data, error } = await createAdminClient().from("activity_jobs").update({ status: "cancelled", error: null }).eq("id", jobId).eq("user_id", user.id).select("id").maybeSingle();
    if (error || !data) return response.status(404).json({ error: "Job not found." });
    response.status(202).json({ status: "cancelled" });
  } catch (error) { sendError(response, error); }
}
