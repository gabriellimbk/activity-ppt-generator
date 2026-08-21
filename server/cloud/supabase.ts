import { createClient, type User } from "@supabase/supabase-js";

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value || /YOUR_|REPLACE_ME/i.test(value)) throw new Error(`${name} is missing from the server environment.`);
  return value;
};

export const storageBuckets = { inputs: "activity-inputs", outputs: "activity-outputs" } as const;

export const createAdminClient = () => createClient(required("SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const createAuthClient = () => createClient(required("SUPABASE_URL"), required("SUPABASE_PUBLISHABLE_KEY"), {
  auth: { persistSession: false, autoRefreshToken: false },
});

export async function authenticateAuthorization(authorization: string | undefined): Promise<{ user: User; token: string }> {
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw Object.assign(new Error("Authentication is required."), { statusCode: 401 });
  const { data, error } = await createAuthClient().auth.getUser(token);
  if (error || !data.user) throw Object.assign(new Error("Your session is invalid or has expired."), { statusCode: 401 });
  const domain = required("ALLOWED_EMAIL_DOMAIN").toLowerCase().replace(/^@/, "");
  if (!data.user.email?.toLowerCase().endsWith(`@${domain}`)) throw Object.assign(new Error(`Use an @${domain} email account.`), { statusCode: 403 });
  return { user: data.user, token };
}

export const errorStatus = (error: unknown) => typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode: unknown }).statusCode) : 500;
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Unexpected server error.";
