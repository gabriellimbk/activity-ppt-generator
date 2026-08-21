import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ZodError } from "zod";
import { authenticateAuthorization, errorMessage, errorStatus } from "./supabase.js";

export const headerValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
export const queryValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
export const authenticateRequest = (request: VercelRequest) => authenticateAuthorization(headerValue(request.headers.authorization));
export const rejectMethod = (response: VercelResponse, allowed: string[]) => response.status(405).setHeader("Allow", allowed.join(", ")).json({ error: "Method not allowed." });
export const sendError = (response: VercelResponse, error: unknown) => {
  if (error instanceof ZodError) return response.status(400).json({ error: error.issues.map((issue) => issue.message).join(" ") });
  return response.status(errorStatus(error)).json({ error: errorMessage(error) });
};
