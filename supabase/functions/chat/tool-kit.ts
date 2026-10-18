// The pieces every tool file shares: the Tool type, input checks and a few small helpers.
//
// Every tool is described once, in one place: its name, what the AI sees, how its input is
// checked, what it does, and whether it is "risky". Risky tools never run on their own:
// the chat function stops and asks the person to Approve or Deny first.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Db = ReturnType<typeof createClient>;
export type Args = Record<string, unknown>;

// Which connection a tool belongs to. "web" and "image" need no sign-in, only the server's key.
export type Provider = "google" | "github" | "supabase" | "composio" | "web" | "image" | "memory";

// A problem the AI can read and react to (for example "GitHub is not connected").
export class ToolError extends Error {}

export type ToolContext = {
  admin: Db; // can read the locked token table
  userId: string;
  timezone: string;
  signal: AbortSignal;
  googleClientId?: string;
  googleClientSecret?: string;
  tavilyKey?: string; // the server's web search key
  imageKey?: string; // the server's Pollinations picture-making key
  nvidiaKey?: string; // the server's NVIDIA key; used for pictures when Cloudflare is not set
  cloudflareAccountId?: string; // with cloudflareToken: pictures are made with Cloudflare Workers AI (first choice)
  cloudflareToken?: string;
  memoryOn?: boolean; // the person turned Memory on in Settings
  imageAllowance?: number; // how many more pictures the person may make before resting
  images: string[]; // pictures made during this request (storage paths), saved with Bentley's reply
  accessToken?: string; // filled in the first time Google is called
  tokens?: Record<string, string>; // saved tokens already read during this request
};

export type Tool = {
  name: string;
  provider: Provider;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema shown to the AI
  risky: boolean;
  parse(raw: Args): unknown; // checks and cleans the AI's input
  describe?(args: unknown, ctx: ToolContext): Promise<string>; // risky tools: what the person is asked to approve
  run(args: unknown, ctx: ToolContext): Promise<unknown>;
};

// Lets each tool keep precise input types while all tools share one list.
export function defineTool<A>(tool: {
  name: string;
  provider: Provider;
  description: string;
  parameters: Record<string, unknown>;
  risky: boolean;
  parse(raw: Args): A;
  describe?(args: A, ctx: ToolContext): Promise<string>;
  run(args: A, ctx: ToolContext): Promise<unknown>;
}): Tool {
  return tool as unknown as Tool;
}

/* ---------- Checking the AI's input ---------- */

export function requiredText(args: Args, key: string, max: number): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0) throw new ToolError(`"${key}" is required.`);
  if (value.length > max) throw new ToolError(`"${key}" is too long (maximum ${max} characters).`);
  return value.trim();
}

export function optionalText(args: Args, key: string, max: number): string | undefined {
  if (args[key] === undefined || args[key] === null || args[key] === "") return undefined;
  return requiredText(args, key, max);
}

export function limit(args: Args, key: string, fallback: number, max: number): number {
  const value = Number(args[key]);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

// Gmail and Drive ids are plain letters, numbers, dashes and underscores.
export function requiredId(args: Args, key: string): string {
  const value = requiredText(args, key, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new ToolError(`"${key}" is not a valid id.`);
  return value;
}

export function optionalDate(args: Args, key: string): string | undefined {
  const value = optionalText(args, key, 64);
  if (value !== undefined && Number.isNaN(Date.parse(value))) throw new ToolError(`"${key}" is not a valid date.`);
  return value;
}

/* ---------- Small helpers ---------- */

export function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (cut off)` : text;
}

export function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// Reads the token the person saved for GitHub, Supabase or Composio from the locked table.
export async function savedToken(ctx: ToolContext, provider: Provider, name: string): Promise<string> {
  const known = ctx.tokens?.[provider];
  if (known) return known;

  const { data } = await ctx.admin
    .from("connection_secrets")
    .select("access_token")
    .eq("user_id", ctx.userId)
    .eq("provider", provider)
    .maybeSingle();
  if (!data || !data.access_token) {
    throw new ToolError(`${name} is not connected. Ask the person to connect it in Settings → Connections.`);
  }
  ctx.tokens = { ...(ctx.tokens || {}), [provider]: data.access_token as string };
  return data.access_token as string;
}

// Reads a failed response into one short sentence the AI can use. Never includes secrets.
export async function failureDetail(response: Response): Promise<string> {
  try {
    const body = await response.json();
    const text = body?.message || body?.error?.message || body?.error || "";
    return String(text).slice(0, 200);
  } catch {
    return ""; // the status code is enough
  }
}
