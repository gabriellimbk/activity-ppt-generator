import type { VercelRequest, VercelResponse } from "@vercel/node";
import { QueueClient } from "@vercel/queue";
import { z } from "zod";
import { processCloudJob } from "../../server/cloud/worker.js";

const messageSchema = z.object({ jobId: z.string().uuid() });
const queue = new QueueClient();

const callback = queue.handleNodeCallback(async (message, metadata) => {
  const { jobId } = messageSchema.parse(message);
  await processCloudJob(jobId, metadata.deliveryCount > 1);
}, {
  visibilityTimeoutSeconds: 3600,
  retry: (_error, metadata) => metadata.deliveryCount >= 4 ? { acknowledge: true } : { afterSeconds: Math.min(300, 15 * 2 ** metadata.deliveryCount) },
});

export default function handler(request: VercelRequest, response: VercelResponse) {
  return callback(request, response);
}
