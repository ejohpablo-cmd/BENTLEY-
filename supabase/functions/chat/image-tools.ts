// Making pictures from a description, using Cloudflare Workers AI (CLOUDFLARE_ACCOUNT_ID and
// CLOUDFLARE_API_TOKEN secrets), or else NVIDIA's FLUX (NVIDIA_API_KEY), or else Pollinations
// (POLLINATIONS_API_KEY).
//
// The server keeps the keys. The finished picture is saved in the person's own private folder
// of the chat-images bucket and shown under Bentley's reply.
import { defineTool, failureDetail, optionalText, requiredText, ToolError } from "./tool-kit.ts";
import type { Tool, ToolContext } from "./tool-kit.ts";

const IMAGE_URL = "https://gen.pollinations.ai/image";
const NVIDIA_URL = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell"; // FLUX.1-schnell, 1024x1024 only
const CLOUDFLARE_URL = "https://api.cloudflare.com/client/v4/accounts";
const CLOUDFLARE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const MODEL = "flux";
const BUCKET = "chat-images";
const MAX_BYTES = 5 * 1024 * 1024; // the bucket's own limit
const MAX_PER_REPLY = 2;
const PICTURE_TIMEOUT_MS = 100000; // one picture; a stuck picture service must not use up the whole reply's time

const SIZES: Record<string, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 768, height: 1024 },
  landscape: { width: 1024, height: 768 },
};
const FILE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

type Picture = { bytes: Uint8Array; type: string };

// Pollinations: the picture comes back as the response itself.
async function fromPollinations(ctx: ToolContext, prompt: string, size: string): Promise<Picture> {
  const { width, height } = SIZES[size];
  const seed = Math.floor(Math.random() * 1_000_000);
  const query = new URLSearchParams({ model: MODEL, width: String(width), height: String(height), seed: String(seed), safe: "true" });
  const response = await fetch(`${IMAGE_URL}/${encodeURIComponent(prompt)}?${query}`, {
    headers: { Authorization: `Bearer ${ctx.imageKey}` },
    signal: ctx.signal,
  });
  if (!response.ok) {
    console.error("Picture request failed with status", response.status);
    if (response.status === 401 || response.status === 403) throw new ToolError("The picture service rejected the server's key.");
    if (response.status === 429) throw new ToolError("The picture service is busy. Try again in a moment.");
    throw new ToolError(`The picture service returned an error (${response.status}). ${await failureDetail(response)}`.trim());
  }
  const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  return { bytes: new Uint8Array(await response.arrayBuffer()), type };
}

// The kind of picture a file is, read from its first bytes (NVIDIA does not say in a header).
function sniffType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return "image/webp";
  return "";
}

// NVIDIA: the picture comes back inside JSON as base64. FLUX.1-schnell only makes 1024x1024.
async function fromNvidia(ctx: ToolContext, prompt: string): Promise<Picture> {
  const started = Date.now();
  const response = await fetch(NVIDIA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${ctx.nvidiaKey}` },
    body: JSON.stringify({ prompt, width: 1024, height: 1024, steps: 4, seed: 0, samples: 1 }), // seed 0 = random
    signal: ctx.signal,
  });
  console.log(`NVIDIA answered with status ${response.status} after ${Date.now() - started}ms`); // timing only, for the function logs
  if (!response.ok) {
    console.error("NVIDIA picture request failed with status", response.status);
    if (response.status === 401 || response.status === 403) throw new ToolError("The picture service rejected the server's key.");
    if (response.status === 429) throw new ToolError("The picture service is busy. Try again in a moment.");
    throw new ToolError(`The picture service returned an error (${response.status}). ${await failureDetail(response)}`.trim());
  }

  const data = await response.json();
  const first = Array.isArray(data?.artifacts) ? data.artifacts[0] : undefined;
  const reason = String(first?.finishReason ?? first?.finish_reason ?? "");
  if (reason && reason !== "SUCCESS") throw new ToolError("The picture service did not make that picture (it may have been blocked by its safety filter).");

  const base64 = typeof first?.base64 === "string" ? first.base64 : typeof data?.image === "string" ? data.image : "";
  if (!base64) throw new ToolError("The picture service did not return a usable picture.");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    throw new ToolError("The picture service did not return a usable picture.");
  }
  return { bytes, type: sniffType(bytes) };
}

// Cloudflare Workers AI (FLUX.1-schnell): the picture comes back inside JSON as base64 (a JPEG).
async function fromCloudflare(ctx: ToolContext, prompt: string): Promise<Picture> {
  const accountId = String(ctx.cloudflareAccountId);
  // The account id goes into the web address, so it must be exactly 32 letters/numbers (Cloudflare's format).
  if (!/^[A-Za-z0-9]{32}$/.test(accountId)) throw new ToolError("The server's Cloudflare account id is not valid.");
  const started = Date.now();
  const response = await fetch(`${CLOUDFLARE_URL}/${accountId}/ai/run/${CLOUDFLARE_MODEL}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.cloudflareToken}` },
    body: JSON.stringify({ prompt, steps: 4 }),
    signal: ctx.signal,
  });
  console.log(`Cloudflare answered with status ${response.status} after ${Date.now() - started}ms`); // timing only, for the function logs
  if (!response.ok) {
    console.error("Cloudflare picture request failed with status", response.status);
    if (response.status === 401 || response.status === 403) throw new ToolError("The picture service rejected the server's key.");
    if (response.status === 429) throw new ToolError("The picture service is busy. Try again in a moment.");
    throw new ToolError(`The picture service returned an error (${response.status}). ${await failureDetail(response)}`.trim());
  }

  const data = await response.json();
  const base64 = typeof data?.result?.image === "string" ? data.result.image : typeof data?.image === "string" ? data.image : "";
  if (!base64) throw new ToolError("The picture service did not return a usable picture.");
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    throw new ToolError("The picture service did not return a usable picture.");
  }
  return { bytes, type: sniffType(bytes) };
}

const generateImage = defineTool({
  name: "generate_image",
  provider: "image",
  description:
    "Make a picture from a description. The picture appears under your reply automatically, so never write a link to it. Write the description in English with plenty of detail: subject, style, colours, mood.",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "A detailed description of the picture." },
      size: { type: "string", enum: ["square", "portrait", "landscape"], description: "Shape of the picture. Default square." },
    },
    required: ["prompt"],
  },
  risky: false,
  parse: (raw) => {
    const size = optionalText(raw, "size", 16) ?? "square";
    if (!(size in SIZES)) throw new ToolError(`"size" must be square, portrait or landscape.`);
    return { prompt: requiredText(raw, "prompt", 800), size };
  },
  async run({ prompt, size }, ctx) {
    const useCloudflare = Boolean(ctx.cloudflareAccountId && ctx.cloudflareToken);
    if (!useCloudflare && !ctx.nvidiaKey && !ctx.imageKey) throw new ToolError("Picture making is not set up on the server.");
    if (ctx.imageAllowance !== undefined && ctx.images.length >= ctx.imageAllowance) {
      throw new ToolError("The person has reached their picture limit. Tell them briefly that Bentley needs a rest and they can make more pictures soon.");
    }
    if (ctx.images.length >= MAX_PER_REPLY) throw new ToolError(`Only ${MAX_PER_REPLY} pictures can be made in one reply.`);

    // The picture service gets its own time limit, on top of the person pressing Stop.
    const timeout = AbortSignal.timeout(PICTURE_TIMEOUT_MS);
    const combine = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
    const limited = { ...ctx, signal: combine ? combine([ctx.signal, timeout]) : timeout };

    let picture: Picture;
    try {
      // Cloudflare first, then NVIDIA, then Pollinations: whichever the server has keys for.
      if (useCloudflare) picture = await fromCloudflare(limited, prompt);
      else if (ctx.nvidiaKey) picture = await fromNvidia(limited, prompt);
      else picture = await fromPollinations(limited, prompt, size);
    } catch (error) {
      if (!ctx.signal.aborted && timeout.aborted) throw new ToolError("The picture service took too long. Do not try again in this reply: tell the person briefly and ask them to try again in a moment.");
      throw error;
    }
    const { bytes, type } = picture;
    const extension = FILE_TYPES[type];
    if (!extension) throw new ToolError("The picture service did not return a usable picture.");
    if (bytes.length === 0 || bytes.length > MAX_BYTES) throw new ToolError("The picture came back too large or empty.");

    const path = `${ctx.userId}/${crypto.randomUUID()}.${extension}`;
    const { error } = await ctx.admin.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: false });
    if (error) {
      console.error("Could not store the picture", error);
      throw new ToolError("The picture could not be saved.");
    }
    ctx.images.push(path);
    return { done: true, note: "The picture is made and will show under your reply. Say something short about it." };
  },
});

export const IMAGE_TOOLS: Tool[] = [generateImage];
