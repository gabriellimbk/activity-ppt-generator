import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
export const supabaseUrl = url ?? "";
export const supabasePublishableKey = publishableKey ?? "";
export const serverlessMode = import.meta.env.VITE_SERVERLESS_MODE === "true";
export const allowedEmailDomain = import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN?.trim().toLowerCase().replace(/^@/, "") ?? "";

export const supabaseConfigured = Boolean(
  url &&
    publishableKey &&
    allowedEmailDomain &&
    !/YOUR_PROJECT/i.test(url) &&
    !/YOUR_/i.test(publishableKey) &&
    !allowedEmailDomain.includes("your_"),
);
export const supabase = supabaseConfigured
  ? createClient(url!, publishableKey!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

export const allowOtpSignups = import.meta.env.VITE_SUPABASE_ALLOW_SIGNUPS !== "false";

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  if (!supabase) throw new Error("Supabase authentication is not configured.");
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("Your session has expired. Please sign in again.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.access_token}`);
  return fetch(input, { ...init, headers });
}
