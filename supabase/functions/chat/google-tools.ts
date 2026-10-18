// The things Bentley can do in Gmail, Google Calendar and Google Drive.
//
// Nothing here can permanently delete anything. Drive files go to the trash, which can be undone.
import { defineTool, jsonRequest, limit, optionalDate, optionalText, requiredId, requiredText, shorten, ToolError } from "./tool-kit.ts";
import type { Tool, ToolContext } from "./tool-kit.ts";

/* ---------- Talking to Google ---------- */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary";
const DRIVE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

const RECONNECT_HINT = "Ask the person to reconnect Google in Settings → Connections.";
const MAX_READ_CHARS = 6000;

// Returns a valid Google access token, refreshing it when it is about to expire.
async function accessToken(ctx: ToolContext): Promise<string> {
  if (ctx.accessToken) return ctx.accessToken;

  const { data } = await ctx.admin
    .from("connection_secrets")
    .select("access_token,refresh_token,expires_at")
    .eq("user_id", ctx.userId)
    .eq("provider", "google")
    .maybeSingle();
  if (!data) throw new ToolError("Google is not connected. Ask the person to connect it in Settings → Connections.");

  const stillValid = new Date(data.expires_at as string).getTime() - Date.now() > 60_000;
  if (stillValid) return (ctx.accessToken = data.access_token as string);

  if (!ctx.googleClientId || !ctx.googleClientSecret) throw new ToolError("Google is not set up on the server.");
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: ctx.googleClientId,
      client_secret: ctx.googleClientSecret,
      refresh_token: data.refresh_token as string,
      grant_type: "refresh_token",
    }),
    signal: ctx.signal,
  });
  if (!response.ok) {
    console.error("Google token refresh failed with status", response.status);
    throw new ToolError(`Google access has expired or was removed. ${RECONNECT_HINT}`);
  }

  const tokens = await response.json();
  const expiresIn = Number(tokens.expires_in) || 3600;
  await ctx.admin
    .from("connection_secrets")
    .update({
      access_token: tokens.access_token,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", ctx.userId)
    .eq("provider", "google");
  return (ctx.accessToken = tokens.access_token as string);
}

// Calls Google. Anything other than success becomes a short ToolError the AI can read.
async function google(ctx: ToolContext, url: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken(ctx);
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    signal: ctx.signal,
  });
  if (response.ok) return response;

  let detail = "";
  try {
    detail = String((await response.json())?.error?.message || "").slice(0, 200);
  } catch {
    // The error had no readable body; the status code is enough.
  }
  console.error("Google request failed with status", response.status);
  if (response.status === 401 || response.status === 403) {
    throw new ToolError(`Google refused the request (${response.status}). ${detail} ${RECONNECT_HINT}`.trim());
  }
  throw new ToolError(`Google returned an error (${response.status}). ${detail}`.trim());
}

async function googleJson(ctx: ToolContext, url: string, init: RequestInit = {}) {
  return await (await google(ctx, url, init)).json();
}

/* ---------- Text helpers ---------- */

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/* ---------- Gmail ---------- */

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] };
type GmailMessage = {
  id: string;
  threadId: string;
  snippet?: string;
  payload?: GmailPart & { headers?: { name: string; value: string }[] };
};

function header(message: GmailMessage, name: string): string {
  const found = message.payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : "";
}

// Finds the first part of an email with the given type and returns its text.
function findPartText(part: GmailPart | undefined, mimeType: string): string {
  if (!part) return "";
  if (part.mimeType === mimeType && part.body?.data) return new TextDecoder().decode(fromBase64Url(part.body.data));
  for (const child of part.parts || []) {
    const found = findPartText(child, mimeType);
    if (found) return found;
  }
  return "";
}

function emailBody(message: GmailMessage): string {
  const plain = findPartText(message.payload, "text/plain");
  if (plain) return plain;
  return htmlToText(findPartText(message.payload, "text/html"));
}

const EMAIL_PATTERN = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

// Subjects with non-English letters or emoji must be encoded to be valid in an email header.
function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ");
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${toBase64(encoder.encode(clean))}?=`;
}

const gmailSearch = defineTool({
  name: "gmail_search",
  provider: "google",
  description:
    "Search the person's Gmail. Uses Gmail search syntax, for example 'from:ada newer_than:7d' or 'is:unread'. Returns sender, subject, date and a snippet.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Gmail search query. Use an empty-looking query like 'in:inbox' for recent mail." },
      max_results: { type: "integer", description: "How many emails to return (1-10, default 5)." },
    },
    required: ["query"],
  },
  risky: false,
  parse: (raw) => ({ query: requiredText(raw, "query", 300), max: limit(raw, "max_results", 5, 10) }),
  async run({ query, max }, ctx) {
    const list = await googleJson(ctx, `${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`);
    const ids: string[] = (list.messages || []).map((item: { id: string }) => item.id);

    const messages: GmailMessage[] = await Promise.all(
      ids.map((id) => {
        const params = new URLSearchParams({ format: "metadata" });
        ["From", "Subject", "Date"].forEach((name) => params.append("metadataHeaders", name));
        return googleJson(ctx, `${GMAIL}/messages/${id}?${params}`);
      }),
    );
    return messages.map((message) => ({
      id: message.id,
      thread_id: message.threadId,
      from: header(message, "From"),
      subject: header(message, "Subject"),
      date: header(message, "Date"),
      snippet: message.snippet || "",
    }));
  },
});

const gmailRead = defineTool({
  name: "gmail_read",
  provider: "google",
  description: "Read one email in full, using an id from gmail_search.",
  parameters: {
    type: "object",
    properties: { message_id: { type: "string", description: "The email id from gmail_search." } },
    required: ["message_id"],
  },
  risky: false,
  parse: (raw) => ({ id: requiredId(raw, "message_id") }),
  async run({ id }, ctx) {
    const message: GmailMessage = await googleJson(ctx, `${GMAIL}/messages/${id}?format=full`);
    return {
      id: message.id,
      thread_id: message.threadId,
      from: header(message, "From"),
      to: header(message, "To"),
      subject: header(message, "Subject"),
      date: header(message, "Date"),
      body: shorten(emailBody(message), MAX_READ_CHARS),
    };
  },
});

// Sending always needs approval: an email cannot be taken back.
const gmailSend = defineTool({
  name: "gmail_send",
  provider: "google",
  description:
    "Send an email from the person's Gmail to one recipient. The person must approve it first. To reply inside an existing conversation, pass reply_to_message_id.",
  parameters: {
    type: "object",
    properties: {
      to: { type: "string", description: "One email address." },
      subject: { type: "string" },
      body: { type: "string", description: "Plain text body." },
      reply_to_message_id: { type: "string", description: "Optional. The id of the email being replied to." },
    },
    required: ["to", "subject", "body"],
  },
  risky: true,
  parse(raw) {
    const to = requiredText(raw, "to", 254);
    if (!EMAIL_PATTERN.test(to)) throw new ToolError('"to" must be a single email address.');
    return {
      to,
      subject: requiredText(raw, "subject", 200).replace(/[\r\n]+/g, " "),
      body: requiredText(raw, "body", 10000),
      replyTo: raw.reply_to_message_id ? requiredId(raw, "reply_to_message_id") : undefined,
    };
  },
  describe: async ({ to, subject, body, replyTo }) =>
    `Send an email to ${to}${replyTo ? " (as a reply)" : ""}\nSubject: ${subject}\n\n${shorten(body, 600)}`,
  async run({ to, subject, body, replyTo }, ctx) {
    const lines = [`To: ${to}`, `Subject: ${encodeHeader(subject)}`];
    let threadId: string | undefined;

    if (replyTo) {
      const original: GmailMessage = await googleJson(
        ctx,
        `${GMAIL}/messages/${replyTo}?format=metadata&metadataHeaders=Message-ID`,
      );
      const messageId = header(original, "Message-ID").replace(/[\r\n]+/g, "");
      if (messageId) lines.push(`In-Reply-To: ${messageId}`, `References: ${messageId}`);
      threadId = original.threadId;
    }

    lines.push(
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      (toBase64(encoder.encode(body)).match(/.{1,76}/g) || []).join("\r\n"),
    );
    const raw = toBase64Url(encoder.encode(lines.join("\r\n")));
    const sent = await googleJson(ctx, `${GMAIL}/messages/send`, jsonRequest("POST", { raw, threadId }));
    return { sent: true, id: sent.id, thread_id: sent.threadId };
  },
});

/* ---------- Google Calendar ---------- */

type CalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
};

// Accepts "2026-10-12" (all day) or "2026-10-12T15:00:00+01:00" (a moment in time).
function eventTime(value: string, timezone: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  if (Number.isNaN(Date.parse(value))) throw new ToolError(`"${value}" is not a valid date or time.`);
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(value);
  return hasOffset ? { dateTime: value } : { dateTime: value, timeZone: timezone };
}

function summarizeEvent(event: CalendarEvent) {
  return {
    id: event.id,
    title: event.summary || "(no title)",
    start: event.start?.dateTime || event.start?.date || "",
    end: event.end?.dateTime || event.end?.date || "",
    location: event.location || "",
    notes: shorten(event.description || "", 300),
    link: event.htmlLink || "",
  };
}

const timeProperty = (label: string) => ({
  type: "string",
  description: `${label}: 'YYYY-MM-DD' for an all-day event, or 'YYYY-MM-DDTHH:MM:SS' with an optional +HH:MM offset.`,
});

const calendarList = defineTool({
  name: "calendar_list_events",
  provider: "google",
  description: "List events on the person's primary Google Calendar. Defaults to the next 7 days.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Start of the range (ISO date or date-time with offset). Default: now." },
      to: { type: "string", description: "End of the range (ISO date or date-time with offset). Default: 7 days from now." },
      max_results: { type: "integer", description: "1-25, default 10." },
    },
  },
  risky: false,
  parse: (raw) => ({ from: optionalDate(raw, "from"), to: optionalDate(raw, "to"), max: limit(raw, "max_results", 10, 25) }),
  async run({ from, to, max }, ctx) {
    const start = from ? new Date(from) : new Date();
    const end = to ? new Date(to) : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(max),
    });
    const result = await googleJson(ctx, `${CALENDAR}/events?${params}`);
    return (result.items || []).map(summarizeEvent);
  },
});

const calendarCreate = defineTool({
  name: "calendar_create_event",
  provider: "google",
  description:
    "Add an event to the person's primary Google Calendar. This does not invite anyone else. Use the person's timezone unless they say otherwise.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      start: timeProperty("Start"),
      end: timeProperty("End"),
      description: { type: "string" },
      location: { type: "string" },
    },
    required: ["title", "start", "end"],
  },
  risky: false,
  parse: (raw) => ({
    title: requiredText(raw, "title", 200),
    start: requiredText(raw, "start", 64),
    end: requiredText(raw, "end", 64),
    description: optionalText(raw, "description", 2000),
    location: optionalText(raw, "location", 200),
  }),
  async run({ title, start, end, description, location }, ctx) {
    const event: CalendarEvent = await googleJson(
      ctx,
      `${CALENDAR}/events`,
      jsonRequest("POST", {
        summary: title,
        description,
        location,
        start: eventTime(start, ctx.timezone),
        end: eventTime(end, ctx.timezone),
      }),
    );
    return summarizeEvent(event);
  },
});

const calendarUpdate = defineTool({
  name: "calendar_update_event",
  provider: "google",
  description: "Change an existing calendar event (title, time, notes or place). Only the fields you pass are changed.",
  parameters: {
    type: "object",
    properties: {
      event_id: { type: "string", description: "The event id from calendar_list_events." },
      title: { type: "string" },
      start: timeProperty("New start"),
      end: timeProperty("New end"),
      description: { type: "string" },
      location: { type: "string" },
    },
    required: ["event_id"],
  },
  risky: false,
  parse(raw) {
    const changes = {
      id: requiredId(raw, "event_id"),
      title: optionalText(raw, "title", 200),
      start: optionalText(raw, "start", 64),
      end: optionalText(raw, "end", 64),
      description: optionalText(raw, "description", 2000),
      location: optionalText(raw, "location", 200),
    };
    const { id: _id, ...fields } = changes;
    if (Object.values(fields).every((value) => value === undefined)) throw new ToolError("Nothing to change.");
    return changes;
  },
  async run({ id, title, start, end, description, location }, ctx) {
    const event: CalendarEvent = await googleJson(
      ctx,
      `${CALENDAR}/events/${id}`,
      jsonRequest("PATCH", {
        summary: title,
        description,
        location,
        start: start ? eventTime(start, ctx.timezone) : undefined,
        end: end ? eventTime(end, ctx.timezone) : undefined,
      }),
    );
    return summarizeEvent(event);
  },
});

const calendarDelete = defineTool({
  name: "calendar_delete_event",
  provider: "google",
  description: "Delete an event from the person's calendar. The person must approve it first.",
  parameters: {
    type: "object",
    properties: { event_id: { type: "string", description: "The event id from calendar_list_events." } },
    required: ["event_id"],
  },
  risky: true,
  parse: (raw) => ({ id: requiredId(raw, "event_id") }),
  // The approval card shows the real event title, looked up here, not text written by the AI.
  async describe({ id }, ctx) {
    const event = summarizeEvent(await googleJson(ctx, `${CALENDAR}/events/${id}`));
    return `Delete the calendar event "${event.title}"\nStarts: ${event.start}`;
  },
  async run({ id }, ctx) {
    await google(ctx, `${CALENDAR}/events/${id}`, { method: "DELETE" });
    return { deleted: true };
  },
});

/* ---------- Google Drive ---------- */

type DriveFile = { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string };

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
const READABLE_TYPES = ["application/json", "application/xml"];

function escapeDriveQuery(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const driveSearch = defineTool({
  name: "drive_search",
  provider: "google",
  description: "Search the person's Google Drive by words in a file's name or content.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to look for." },
      max_results: { type: "integer", description: "1-10, default 5." },
    },
    required: ["query"],
  },
  risky: false,
  parse: (raw) => ({ query: requiredText(raw, "query", 200), max: limit(raw, "max_results", 5, 10) }),
  async run({ query, max }, ctx) {
    const params = new URLSearchParams({
      q: `fullText contains '${escapeDriveQuery(query)}' and trashed = false`,
      pageSize: String(max),
      fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
    });
    const result = await googleJson(ctx, `${DRIVE}/files?${params}`);
    return (result.files || []).map((file: DriveFile) => ({
      id: file.id,
      name: file.name,
      type: file.mimeType,
      modified: file.modifiedTime,
      link: file.webViewLink,
    }));
  },
});

const driveRead = defineTool({
  name: "drive_read_file",
  provider: "google",
  description:
    "Read the text of a Google Doc, Sheet (as CSV), Slides deck, or a plain text, JSON or XML file from Drive. Other file types cannot be read.",
  parameters: {
    type: "object",
    properties: { file_id: { type: "string", description: "The file id from drive_search." } },
    required: ["file_id"],
  },
  risky: false,
  parse: (raw) => ({ id: requiredId(raw, "file_id") }),
  async run({ id }, ctx) {
    const file: DriveFile = await googleJson(ctx, `${DRIVE}/files/${id}?fields=id,name,mimeType`);

    let url: string;
    if (file.mimeType === GOOGLE_DOC || file.mimeType === GOOGLE_SLIDES) {
      url = `${DRIVE}/files/${id}/export?mimeType=text/plain`;
    } else if (file.mimeType === GOOGLE_SHEET) {
      url = `${DRIVE}/files/${id}/export?mimeType=text/csv`;
    } else if (file.mimeType.startsWith("text/") || READABLE_TYPES.includes(file.mimeType)) {
      url = `${DRIVE}/files/${id}?alt=media`;
    } else {
      throw new ToolError(`"${file.name}" is a ${file.mimeType} file, which cannot be read as text.`);
    }

    const text = await (await google(ctx, url)).text();
    return { name: file.name, content: shorten(text, MAX_READ_CHARS) };
  },
});

const driveCreateDoc = defineTool({
  name: "drive_create_doc",
  provider: "google",
  description: "Create a new Google Doc in the person's Drive from plain text. It never changes existing files.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "The document title." },
      content: { type: "string", description: "Plain text for the document body." },
    },
    required: ["name", "content"],
  },
  risky: false,
  parse: (raw) => ({ name: requiredText(raw, "name", 200), content: requiredText(raw, "content", 20000) }),
  async run({ name, content }, ctx) {
    const boundary = `bentley-${crypto.randomUUID()}`;
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify({ name, mimeType: GOOGLE_DOC })}\r\n` +
      `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;

    const file: DriveFile = await googleJson(ctx, `${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,webViewLink`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return { id: file.id, name: file.name, link: file.webViewLink };
  },
});

// Moves a file to the Drive trash. It stays there and can be restored; nothing is erased for good.
const driveTrash = defineTool({
  name: "drive_trash_file",
  provider: "google",
  description: "Move a Drive file to the trash (it can be restored). The person must approve it first.",
  parameters: {
    type: "object",
    properties: { file_id: { type: "string", description: "The file id from drive_search." } },
    required: ["file_id"],
  },
  risky: true,
  parse: (raw) => ({ id: requiredId(raw, "file_id") }),
  async describe({ id }, ctx) {
    const file: DriveFile = await googleJson(ctx, `${DRIVE}/files/${id}?fields=id,name`);
    return `Move "${file.name}" to the Google Drive trash`;
  },
  async run({ id }, ctx) {
    await google(ctx, `${DRIVE}/files/${id}`, jsonRequest("PATCH", { trashed: true }));
    return { trashed: true };
  },
});

/* ---------- The list the tools registry uses ---------- */

export const GOOGLE_TOOLS: Tool[] = [
  gmailSearch,
  gmailRead,
  gmailSend,
  calendarList,
  calendarCreate,
  calendarUpdate,
  calendarDelete,
  driveSearch,
  driveRead,
  driveCreateDoc,
  driveTrash,
];
