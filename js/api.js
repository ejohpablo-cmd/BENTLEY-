// Everything that talks to Supabase: the client, the Edge Functions and photo storage.

import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";

export const isConfigured =
  /^https?:\/\//.test(SUPABASE_URL) &&
  typeof SUPABASE_ANON_KEY === "string" &&
  SUPABASE_ANON_KEY.length > 0 &&
  !SUPABASE_ANON_KEY.includes("YOUR_");

export const supabase = isConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Calls one of the Edge Functions as the signed-in person. The signal lets a request be cancelled.
async function callFunction(name, body, signal, onText) {
  const { data } = await supabase.auth.getSession();
  const token = data.session ? data.session.access_token : null;
  if (!token) throw new Error("You are not signed in.");

  const response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = new Error(`The ${name} request failed (${response.status}).`);
    error.status = response.status;
    // While Axelvon is resting (usage limit reached) the server says when she is back.
    try {
      const body = await response.json();
      if (body && typeof body.resting_until === "string") error.restingUntil = body.resting_until;
    } catch (parseError) {
      // No readable body: the status code is enough.
    }
    throw error;
  }
  const isStream = (response.headers.get("content-type") || "").includes("text/event-stream");
  return isStream && response.body ? readStream(response, onText) : response.json();
}

// Reads the events of a streamed answer (see the chat function). Returns the finished answer.
async function readStream(response, onText) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let written = "";
  let result = null;

  const handleEvent = (block) => {
    const line = block.split("\n").find((item) => item.startsWith("data:"));
    if (!line) return;
    let event;
    try {
      event = JSON.parse(line.slice(5));
    } catch (parseError) {
      return; // a broken piece is skipped
    }
    if (event.t === "text") {
      written += event.d;
      if (onText) onText(written);
    } else if (event.t === "reset") {
      written = "";
      if (onText) onText(written);
    } else if (event.t === "done") {
      result = event.result;
    } else if (event.t === "error") {
      const error = new Error(event.error || "The chat request failed.");
      error.status = event.status;
      if (typeof event.resting_until === "string") error.restingUntil = event.resting_until;
      throw error;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop();
    blocks.forEach(handleEvent);
  }
  if (buffer.trim()) handleEvent(buffer);
  if (!result) throw new Error("The answer was cut off.");
  return result;
}

// The timezone Axelvon uses for calendar times, for example "Africa/Lagos".
function userTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// Calls the "chat" Edge Function. The Stop button cancels it through the signal.
//
// Body options:
//   { conversation_id, message, images }              send a new message (images: photo paths, optional;
//                                                     the message may be empty when photos are attached)
//   { conversation_id, message, edit_message_id }     edit one of your messages and get a new reply
//   { conversation_id, regenerate: true }             ask for a new version of the last reply
//   { conversation_id, greet: true }                  let Axelvon open the conversation
//   { conversation_id, action_id, approve }           Approve (true) or Deny (false) one of Axelvon's requests
//
// onText(text) is optional. When given, the reply arrives while Axelvon is still writing it and
// onText receives everything written so far. The finished answer is returned as usual.
export async function requestChat(body, signal, onText) {
  const result = await callFunction("chat", { timezone: userTimezone(), ...body, ...(onText ? { stream: true } : {}) }, signal, onText);
  if (!result || !result.message) throw new Error("Chat returned an unexpected answer.");
  return result;
}

// Signs in (or creates the account) with Google. Google sends the person back to this page afterwards.
// The Google provider must be switched on in Supabase: Authentication > Providers > Google.
export async function signInWithGoogle() {
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
  if (error) throw error;
}

// When Axelvon may be used again, or null. Only the person's own row can be read.
export async function fetchRestingUntil(userId) {
  const { data, error } = await supabase.from("user_usage").select("locked_until").eq("user_id", userId).maybeSingle();
  if (error || !data || !data.locked_until) return null;
  return Date.parse(data.locked_until) > Date.now() ? data.locked_until : null;
}

// Saves a note from Settings > Feedback.
export async function sendAppFeedback(userId, message) {
  const { error } = await supabase.from("app_feedback").insert({ user_id: userId, message });
  if (error) throw error;
}

// Returns Google's sign-in address. Google sends the person back to this page afterwards.
export async function startGoogleConnect() {
  const returnUrl = window.location.origin + window.location.pathname;
  const result = await callFunction("connect-google", { action: "start", return_url: returnUrl });
  if (!result || typeof result.url !== "string") throw new Error("Google sign-in is not available.");
  return result.url;
}

export async function disconnectGoogle() {
  await callFunction("connect-google", { action: "disconnect" });
}

// Saves a GitHub, Supabase or Composio token. The server checks it first.
// Returns { ok: true, label } or { ok: false, error }.
export async function saveConnectionToken(provider, token) {
  return await callFunction("connect-token", { action: "save", provider, token });
}

export async function disconnectProvider(provider) {
  await callFunction("connect-token", { action: "disconnect", provider });
}

const CHAT_PHOTO_BUCKET = "chat-images"; // private: photos are only reachable through short-lived links

// Uploads the photos of one message into the person's own folder and returns their paths.
// Every photo gets a new random name, so nothing is ever overwritten.
export async function uploadChatPhotos(userId, blobs) {
  const paths = [];
  for (const blob of blobs) {
    const path = `${userId}/${crypto.randomUUID()}.jpg`;
    const { error } = await supabase.storage
      .from(CHAT_PHOTO_BUCKET)
      .upload(path, blob, { contentType: "image/jpeg", cacheControl: "3600" });
    if (error) throw error;
    paths.push(path);
  }
  return paths;
}

// Turns photo paths into web addresses that work for a limited time. Returns { path: address }.
export async function getPhotoUrls(paths, seconds) {
  const { data, error } = await supabase.storage.from(CHAT_PHOTO_BUCKET).createSignedUrls(paths, seconds);
  if (error) throw error;

  const urls = {};
  (data || []).forEach((item) => {
    if (item.signedUrl) urls[item.path] = item.signedUrl;
  });
  return urls;
}

// Uploads one profile photo and returns its public web address.
// Each upload gets its own file name, so an older photo is never overwritten.
export async function uploadProfilePhoto(userId, blob) {
  const path = `${userId}/${Date.now()}.jpg`;
  const { error } = await supabase.storage
    .from("avatars")
    .upload(path, blob, { contentType: "image/jpeg", cacheControl: "31536000" });
  if (error) throw error;

  const { data } = supabase.storage.from("avatars").getPublicUrl(path);
  return data.publicUrl;
}
