// Supabase Edge Function: POST /functions/v1/connect-token
//
// Connects (and disconnects) GitHub, Supabase and Composio, which sign in with a token or key
// the person creates themselves instead of a sign-in page.
//   { action: "save", provider, token }   checks the token with the service, then stores it
//   { action: "disconnect", provider }    forgets the stored token
//
// Deploy with "Verify JWT" ON. The token is kept in the locked connection_secrets table,
// which only this server can read, and it is never sent back to the app.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ---------- Settings ---------- */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FAR_FUTURE = "9999-12-31T00:00:00Z"; // these tokens do not expire on their own
const MAX_TOKEN_LENGTH = 500;

/* ---------- Small types and helpers ---------- */

type Provider = "github" | "supabase" | "composio";
type Db = ReturnType<typeof createClient>;
type Config = { supabaseUrl: string; anonKey: string; serviceKey: string };

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function readConfig(): Config {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) {
    console.error("Missing required function configuration.");
    throw new HttpError(500, "Service unavailable.");
  }
  return { supabaseUrl, anonKey, serviceKey };
}

async function authenticate(req: Request, config: Config): Promise<string> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new HttpError(401, "Unauthorized");

  const client = createClient(config.supabaseUrl, config.anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data || !data.user) throw new HttpError(401, "Unauthorized");
  return data.user.id;
}

function readProvider(value: unknown): Provider {
  if (value === "github" || value === "supabase" || value === "composio") return value;
  throw new HttpError(400, "Invalid request");
}

/* ---------- Checking a token with the service ---------- */

// Each check returns the name to show as "Connected as ...", or null when the service rejects the token.
type Check = (token: string) => Promise<string | null>;

const CHECKS: Record<Provider, Check> = {
  async github(token) {
    const response = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Axelvon" },
    });
    if (!response.ok) return null;
    const user = await response.json();
    return typeof user.login === "string" ? user.login : "GitHub account";
  },

  async supabase(token) {
    const response = await fetch("https://api.supabase.com/v1/projects", { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) return null;
    const projects = await response.json();
    const count = Array.isArray(projects) ? projects.length : 0;
    return `Supabase (${count} project${count === 1 ? "" : "s"})`;
  },

  async composio(token) {
    // 4xx means the key is wrong; this call only checks that the key is accepted.
    const response = await fetch("https://backend.composio.dev/api/v3.1/connected_accounts?limit=1", {
      headers: { "x-api-key": token },
    });
    return response.ok ? "Composio account" : null;
  },
};

/* ---------- The two jobs ---------- */

async function handleSave(admin: Db, userId: string, body: Record<string, unknown>) {
  const provider = readProvider(body.provider);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token || token.length > MAX_TOKEN_LENGTH || /\s/.test(token)) {
    return json({ ok: false, error: "That doesn't look like a valid token." });
  }

  let label: string | null;
  try {
    label = await CHECKS[provider](token);
  } catch (error) {
    console.error(`Could not reach ${provider}`, error);
    return json({ ok: false, error: "Couldn't reach the service. Please try again." });
  }
  if (!label) return json({ ok: false, error: "The service did not accept that token." });

  const now = new Date().toISOString();
  const secret = await admin.from("connection_secrets").upsert(
    { user_id: userId, provider, access_token: token, refresh_token: "", expires_at: FAR_FUTURE, updated_at: now },
    { onConflict: "user_id,provider" },
  );
  if (secret.error) {
    console.error("Failed to store the token", secret.error);
    throw new HttpError(500, "Could not save the connection.");
  }

  const connection = await admin
    .from("connections")
    .upsert({ user_id: userId, provider, account_email: label }, { onConflict: "user_id,provider" });
  if (connection.error) {
    console.error("Failed to save the connection", connection.error);
    throw new HttpError(500, "Could not save the connection.");
  }
  return json({ ok: true, label });
}

async function handleDisconnect(admin: Db, userId: string, body: Record<string, unknown>) {
  const provider = readProvider(body.provider);
  const secret = await admin.from("connection_secrets").delete().eq("user_id", userId).eq("provider", provider);
  const connection = await admin.from("connections").delete().eq("user_id", userId).eq("provider", provider);
  if (secret.error || connection.error) {
    console.error("Failed to disconnect", secret.error || connection.error);
    throw new HttpError(500, "Could not disconnect.");
  }
  return json({ ok: true });
}

/* ---------- The request handler ---------- */

async function handle(req: Request): Promise<Response> {
  const config = readConfig();
  const userId = await authenticate(req, config);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Invalid request");
  }

  const admin = createClient(config.supabaseUrl, config.serviceKey, { auth: { persistSession: false } });
  if (body.action === "save") return await handleSave(admin, userId, body);
  if (body.action === "disconnect") return await handleDisconnect(admin, userId, body);
  throw new HttpError(400, "Invalid request");
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    return await handle(req);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error("Unhandled error in connect-token function", error);
    return json({ error: "Something went wrong." }, 500);
  }
});
