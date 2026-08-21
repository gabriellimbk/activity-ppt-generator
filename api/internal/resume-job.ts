import type { VercelRequest, VercelResponse } from "@vercel/node";
import { z } from "zod";
import { headerValue, rejectMethod, sendError } from "../../server/cloud/http.js";
import { processCloudJob } from "../../server/cloud/worker.js";

const bodySchema = z.object({ jobId: z.string().uuid() });

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "POST") return rejectMethod(response, ["POST"]);
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret || headerValue(request.headers.authorization) !== `Bearer ${secret}`) {
      return response.status(401).json({ error: "Invalid recovery authorization." });
    }
    const { jobId } = bodySchema.parse(request.body);
    await processCloudJob(jobId, true);
    response.status(200).json({ ok: true, jobId });
  } catch (error) {
    sendError(response, error);
  }
}
