import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ZodError } from "zod";
import { authenticateAuthorization, errorMessage, errorStatus } from "./supabase.js";

export const headerValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
export const queryValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
export const authenticateRequest = (request: VercelRequest) => authenticateAuthorization(headerValue(request.headers.authorization));
export const rejectMethod = (response: VercelResponse, allowed: string[]) => response.status(405).setHeader("Allow", allowed.join(", ")).json({ error: "Method not allowed." });
export async function readJsonBody(request: VercelRequest): Promise<unknown> {
  const supplied = request.body;
  if (supplied && typeof supplied === "object" && !Buffer.isBuffer(supplied)) {
    const payload = (supplied as Record<string, unknown>).payload;
    if (typeof payload === "string") {
      try { return JSON.parse(payload); }
      catch { throw Object.assign(new Error("The encoded request payload is not valid JSON."), { statusCode: 400 }); }
    }
    return supplied;
  }
  if (typeof supplied === "string" || Buffer.isBuffer(supplied)) {
    const text = Buffer.isBuffer(supplied) ? supplied.toString("utf8") : supplied;
    if (!text.trim()) throw Object.assign(new Error("The request body is empty."), { statusCode: 400 });
    const encodedPayload = new URLSearchParams(text).get("payload");
    try { return JSON.parse(encodedPayload ?? text); }
    catch { throw Object.assign(new Error("The request body is not valid JSON."), { statusCode: 400 }); }
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (!chunks.length) throw Object.assign(new Error("The request body is empty. Refresh the app and try again."), { statusCode: 400 });
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("The request body is not valid JSON."), { statusCode: 400 }); }
}
export const sendError = (response: VercelResponse, error: unknown) => {
  if (error instanceof ZodError) return response.status(400).json({ error: error.issues.map((issue) => issue.message).join(" ") });
  return response.status(errorStatus(error)).json({ error: errorMessage(error) });
};
