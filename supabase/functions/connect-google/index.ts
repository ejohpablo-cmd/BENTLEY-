// Supabase Edge Function: /functions/v1/connect-google
//
// Connects (and disconnects) a person's Google account. Three jobs:
//   POST { action: "start", return_url }   gives back the Google sign-in address
//   GET  ?code=...&state=...               Google sends the person back here; tokens are stored
//   POST { action: "disconnect" }          revokes access and forgets the tokens
//
// Secrets (set in Supabase, never in the app): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
// Deploy with "Verify JWT" OFF: Google's redirect carries no login token.
// The "start" and "disconnect" jobs check the person's login themselves.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/* ---------- Settings ---------- */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

// What Axelvon is allowed to do: read and send Gmail, manage Calendar, manage Drive files.
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
];

const STATE_LIFETIME_MS = 10 * 60 * 1000; // the sign-in link works for 10 minutes

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/* ---------- Small types and helpers ---------- */

type Config = {
  supabaseUrl: string;
  anonKey: string;
  serviceKey: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};
type StatePayload = { userId: string; returnUrl: string; expires: number; nonce: string };

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
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

  if (!supabaseUrl || !anonKey || !serviceKey || !clientId || !clientSecret) {
    console.error("Missing required function configuration.");
    throw new HttpError(500, "Google connection is not set up yet.");
  }
  return {
    supabaseUrl,
    anonKey,
    serviceKey,
    clientId,
    clientSecret,
    redirectUri: `${supabaseUrl}/functions/v1/connect-google`,
  };
}

// A database client that can read the locked token table. Only used inside this function.
function adminClient(config: Config) {
  return createClient(config.supabaseUrl, config.serviceKey, { auth: { persistSession: false } });
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

/* ---------- Signed "state": proves the sign-in came from this person ---------- */

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function signingKey(config: Config) {
  return crypto.subtle.importKey("raw", encoder.encode(config.serviceKey), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function createState(config: Config, userId: string, returnUrl: string): Promise<string> {
  const payload: StatePayload = {
    userId,
    returnUrl,
    expires: Date.now() + STATE_LIFETIME_MS,
    nonce: crypto.randomUUID(),
  };
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await signingKey(config), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

async function readState(config: Config, state: string | null): Promise<StatePayload> {
  const [body, signature] = (state || "").split(".");
  if (!body || !signature) throw new HttpError(400, "Invalid sign-in link.");

  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(config),
      fromBase64Url(signature),
      encoder.encode(body),
    );
    if (!valid) throw new Error("bad signature");

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as StatePayload;
    if (typeof payload.userId !== "string" || typeof payload.returnUrl !== "string") throw new Error("bad payload");
    if (Date.now() > payload.expires) throw new HttpError(400, "This sign-in link expired. Please try again.");
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid sign-in link.");
  }
}

/* ---------- Start: build the Google sign-in address ---------- */

// The app tells us where to send the person afterwards. Only plain web addresses are accepted.
function cleanReturnUrl(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "Invalid request");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "Invalid request");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "Invalid request");
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function handleStart(req: Request, config: Config, body: Record<string, unknown>) {
  const userId = await authenticate(req, config);
  const returnUrl = cleanReturnUrl(body.return_url);
  const state = await createState(config, userId, returnUrl);

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline"); // gives us a refresh token
  url.searchParams.set("prompt", "consent"); // makes sure Google always sends that refresh token
  url.searchParams.set("state", state);
  return json({ url: url.toString() });
}

/* ---------- Callback: Google sends the person back here ---------- */

async function exchangeCode(config: Config, code: string) {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    console.error("Google token exchange failed with status", response.status);
    throw new Error("token_exchange");
  }
  return await response.json();
}

async function readAccountEmail(accessToken: string): Promise<string> {
  const response = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) return "";
  const info = await response.json();
  return typeof info.email === "string" ? info.email : "";
}

// The person can untick permissions on Google's screen. Axelvon needs all of them.
function hasAllScopes(granted: unknown): boolean {
  const list = typeof granted === "string" ? granted.split(" ") : [];
  return GOOGLE_SCOPES.filter((scope) => scope.startsWith("https://")).every((scope) => list.includes(scope));
}

async function storeTokens(config: Config, userId: string, tokens: Record<string, unknown>) {
  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;
  const expiresIn = Number(tokens.expires_in) || 3600;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") throw new Error("missing_tokens");

  const email = await readAccountEmail(accessToken);
  const admin = adminClient(config);

  const secrets = await admin.from("connection_secrets").upsert({
    user_id: userId,
    provider: "google",
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  });
  if (secrets.error) {
    console.error("Failed to store tokens", secrets.error);
    throw new Error("store_failed");
  }

  const connection = await admin
    .from("connections")
    .upsert({ user_id: userId, provider: "google", account_email: email }, { onConflict: "user_id,provider" });
  if (connection.error) {
    console.error("Failed to store connection", connection.error);
    throw new Error("store_failed");
  }
}

// Sends the person back to the app with a result the app shows as a message.
function backToApp(returnUrl: string, key: "connected" | "connect_error", value: string): Response {
  const url = new URL(returnUrl);
  url.searchParams.set(key, value);
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

async function handleCallback(url: URL, config: Config): Promise<Response> {
  const state = await readState(config, url.searchParams.get("state"));

  // The person pressed "Cancel" on Google's screen.
  if (url.searchParams.get("error")) return backToApp(state.returnUrl, "connect_error", "cancelled");

  const code = url.searchParams.get("code");
  if (!code) return backToApp(state.returnUrl, "connect_error", "failed");

  try {
    const tokens = await exchangeCode(config, code);
    if (!hasAllScopes(tokens.scope)) return backToApp(state.returnUrl, "connect_error", "permissions");
    await storeTokens(config, state.userId, tokens);
  } catch (error) {
    console.error("Google connection failed", error instanceof Error ? error.message : error);
    return backToApp(state.returnUrl, "connect_error", "failed");
  }
  return backToApp(state.returnUrl, "connected", "google");
}

/* ---------- Disconnect ---------- */

async function handleDisconnect(req: Request, config: Config) {
  const userId = await authenticate(req, config);
  const admin = adminClient(config);

  const { data } = await admin
    .from("connection_secrets")
    .select("refresh_token")
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();

  // Tell Google to cancel the access. If that fails we still forget the tokens.
  if (data && typeof data.refresh_token === "string") {
    try {
      await fetch(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: data.refresh_token }),
      });
    } catch (error) {
      console.error("Google revoke failed", error);
    }
  }

  const secrets = await admin.from("connection_secrets").delete().eq("user_id", userId).eq("provider", "google");
  const connection = await admin.from("connections").delete().eq("user_id", userId).eq("provider", "google");
  if (secrets.error || connection.error) {
    console.error("Failed to disconnect", secrets.error || connection.error);
    throw new HttpError(500, "Could not disconnect.");
  }
  return json({ ok: true });
}

/* ---------- The request handler ---------- */

async function handle(req: Request): Promise<Response> {
  const config = readConfig();

  if (req.method === "GET") return await handleCallback(new URL(req.url), config);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, "Invalid request");
  }
  if (body.action === "start") return await handleStart(req, config, body);
  if (body.action === "disconnect") return await handleDisconnect(req, config);
  throw new HttpError(400, "Invalid request");
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    return await handle(req);
  } catch (error) {
    if (error instanceof HttpError) {
      // A person who followed a bad link sees a short page instead of raw JSON.
      if (req.method === "GET") {
        return new Response(error.message + " You can close this page and try again from Axelvon.", {
          status: error.status,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return json({ error: error.message }, error.status);
    }
    console.error("Unhandled error in connect-google function", error);
    return json({ error: "Something went wrong." }, 500);
  }
});
