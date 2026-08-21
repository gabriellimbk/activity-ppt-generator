import type { VercelRequest, VercelResponse } from "@vercel/node";
import { headerValue, rejectMethod, sendError } from "../../server/cloud/http.js";
import { createAdminClient, storageBuckets } from "../../server/cloud/supabase.js";
import type { CloudArtifacts, CloudInput, CloudJobRow } from "../../server/cloud/contracts.js";

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "GET") return rejectMethod(response, ["GET"]);
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || headerValue(request.headers.authorization) !== `Bearer ${secret}`) return response.status(401).json({ error: "Invalid cron authorization." });
    const admin = createAdminClient();
    const { data: jobs, error } = await admin.from("activity_jobs").select("id,inputs,artifacts").lt("expires_at", new Date().toISOString()).limit(100) as { data: Pick<CloudJobRow, "id" | "inputs" | "artifacts">[] | null; error: { message: string } | null };
    if (error) throw new Error(error.message);
    let removed = 0;
    for (const job of jobs ?? []) {
      const inputs = (job.inputs as CloudInput[]).map((input) => input.path);
      const outputs = Object.values(job.artifacts as CloudArtifacts).flatMap((artifact) => artifact ? [artifact.path] : []);
      if (inputs.length) await admin.storage.from(storageBuckets.inputs).remove(inputs);
      if (outputs.length) await admin.storage.from(storageBuckets.outputs).remove(outputs);
      await admin.from("activity_jobs").delete().eq("id", job.id);
      removed++;
    }
    response.status(200).json({ removed });
  } catch (error) { sendError(response, error); }
}
