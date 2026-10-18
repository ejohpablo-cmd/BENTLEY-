// The Settings page: Appearance, Axelvon, Connections, Chat, Privacy & security and About.

import { state, resetChat, DEFAULT_SETTINGS, LAST_CONVERSATION_KEY } from "./state.js";
import { supabase, sendAppFeedback } from "./api.js";
import { $, el, toast, regenerateEnabled, safeGet, safeSet, safeRemove } from "./helpers.js";
import { confirmDialog, openModal } from "./modal.js";
import { applyAppearance } from "./appearance.js";
import { renderMessages } from "./chat.js";
import { stopTyping } from "./typewriter.js";
import { isLockOn, openTurnOnLock, openTurnOffLock } from "./applock.js";
import { openPrivacyPolicy, openTerms } from "./legal.js";
import { getConnection, connectGoogle, openDisconnectGoogle, openConnectToken, openDisconnectToken } from "./connections.js";

/* ---------- What the page contains ---------- */

const options = (...pairs) => pairs.map(([value, text]) => [value, text]);

const SECTIONS = [
  {
    title: "Appearance",
    rows: [
      { type: "select", key: "theme", label: "Theme", options: options(["light", "Light"], ["dark", "Dark"], ["system", "System"]) },
      { type: "select", key: "bubble_style", label: "Chat bubble style", options: options(["rounded", "Rounded"], ["soft", "Soft"], ["square", "Square"]) },
    ],
  },
  {
    title: "Axelvon",
    rows: [
      {
        type: "select",
        key: "personality",
        label: "Personality",
        options: options(["friendly", "Friendly"], ["professional", "Professional"], ["playful", "Playful"], ["direct", "Direct"]),
      },
      { type: "toggle", key: "memory_enabled", label: "Memory", hint: "Axelvon remembers things you tell her" },
      { type: "button", label: "Clear memories", buttonLabel: "Clear", danger: true, onClick: openClearMemories },
    ],
  },
  {
    title: "Connections",
    rows: [
      { type: "connection", provider: "google", label: "Google", hint: "Gmail, Calendar and Drive" },
      { type: "connection", provider: "github", label: "GitHub", hint: "Repositories, files and issues" },
      { type: "connection", provider: "supabase", label: "Supabase", hint: "Your projects and tables" },
      { type: "connection", provider: "composio", label: "Composio", hint: "Slack, Notion, Trello and more" },
    ],
  },
  {
    title: "Chat",
    rows: [{ type: "toggle", key: "regenerate", label: "Regenerate response", hint: "Show the button on Axelvon's latest reply" }],
  },
  {
    title: "Privacy & security",
    rows: [
      { type: "lock", label: "App lock", hint: "Ask for a PIN when the app opens" },
      { type: "button", label: "Data control", buttonLabel: "Open", onClick: openDataControl },
    ],
  },
  {
    title: "About",
    rows: [
      { type: "button", label: "Feedback", buttonLabel: "Send", onClick: openFeedback },
      { type: "button", label: "Privacy policy", buttonLabel: "Read", onClick: openPrivacyPolicy },
      { type: "button", label: "Terms", buttonLabel: "Read", onClick: openTerms },
    ],
  },
];

/* ---------- Loading and saving ---------- */

const ALLOWED_VALUES = {
  theme: ["light", "dark", "system"],
  personality: ["friendly", "professional", "playful", "direct"],
  bubble_style: ["rounded", "soft", "square"],
};

// The bubble style and the Regenerate button are kept on this phone only (not in the account).
function getSetting(key) {
  if (key === "regenerate") return regenerateEnabled();
  return state.settings[key];
}

export async function loadSettings() {
  const { data, error } = await supabase.from("user_settings").select("*").eq("user_id", state.user.id).maybeSingle();
  if (error) throw error;

  let row = data;
  if (!row) {
    const created = await supabase.from("user_settings").insert({ user_id: state.user.id }).select("*").single();
    if (created.error) throw created.error;
    row = created.data;
  }

  state.settings = { ...DEFAULT_SETTINGS, ...row, bubble_style: safeGet("bentley_bubble") || "rounded" };
  // An older version of the app saved other values (for example personality "default"). Unknown ones fall back.
  for (const [key, allowed] of Object.entries(ALLOWED_VALUES)) {
    if (!allowed.includes(state.settings[key])) state.settings[key] = DEFAULT_SETTINGS[key];
  }

  // The new off-white look starts as Light once. After that the person's own choice is kept.
  if (!safeGet("bentley_theme_v2")) {
    safeSet("bentley_theme_v2", "1");
    state.settings.theme = "light";
    supabase.from("user_settings").update({ theme: "light" }).eq("user_id", state.user.id).then(() => {});
  }
}

async function updateSetting(key, value) {
  if (key === "regenerate") {
    safeSet("bentley_regenerate", value ? "on" : "off");
    renderMessages({ keepScroll: true });
    return;
  }
  if (key === "bubble_style") {
    state.settings.bubble_style = value;
    applyAppearance();
    return;
  }

  const previous = state.settings[key];
  state.settings[key] = value;
  if (key === "theme") applyAppearance();

  const { error } = await supabase.from("user_settings").update({ [key]: value }).eq("user_id", state.user.id);
  if (error) {
    console.error(error);
    state.settings[key] = previous; // put the old value back
    if (key === "theme") applyAppearance();
    renderSettings();
    toast("Couldn't save that setting.");
  }
}

/* ---------- Drawing the page ---------- */

function buildSelect(row) {
  const select = el("select", "select");
  select.setAttribute("aria-label", row.label);
  row.options.forEach(([value, text]) => {
    const option = el("option", undefined, text);
    option.value = value;
    select.append(option);
  });
  select.value = getSetting(row.key);
  if (select.value !== String(getSetting(row.key))) select.selectedIndex = 0; // never show an empty box
  select.addEventListener("change", () => updateSetting(row.key, select.value));
  return select;
}

function buildToggle(row) {
  const button = el("button", "switch");
  button.type = "button";
  button.setAttribute("role", "switch");
  button.setAttribute("aria-label", row.label);
  button.setAttribute("aria-checked", String(Boolean(getSetting(row.key))));
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-checked") !== "true";
    button.setAttribute("aria-checked", String(next));
    updateSetting(row.key, next);
  });
  return button;
}

function buildButton(row) {
  const button = el("button", `btn sm ${row.danger ? "outline-danger" : "secondary"}`, row.buttonLabel);
  button.type = "button";
  button.addEventListener("click", row.onClick);
  return button;
}

// "Turn on" while App lock is off, "Turn off" while it is on.
function buildLockButton() {
  const on = isLockOn();
  const button = el("button", on ? "btn sm outline-danger" : "btn sm primary", on ? "Turn off" : "Turn on");
  button.type = "button";
  button.addEventListener("click", () => (on ? openTurnOffLock(renderSettings) : openTurnOnLock(renderSettings)));
  return button;
}

// "Connect" while the app is not linked, "Disconnect" while it is.
function buildConnectionButton(row) {
  const linked = Boolean(getConnection(row.provider));
  const button = el("button", linked ? "btn sm outline-danger" : "btn sm primary", linked ? "Disconnect" : "Connect");
  button.type = "button";
  button.addEventListener("click", () => {
    if (row.provider === "google") return linked ? openDisconnectGoogle(renderSettings) : connectGoogle();
    return linked ? openDisconnectToken(row.provider, renderSettings) : openConnectToken(row.provider, renderSettings);
  });
  return button;
}

function buildRowControl(row) {
  if (row.type === "select") return buildSelect(row);
  if (row.type === "toggle") return buildToggle(row);
  if (row.type === "lock") return buildLockButton();
  if (row.type === "connection") return buildConnectionButton(row);
  return buildButton(row);
}

function buildRow(row) {
  const wrapper = el("div", "row");
  const label = el("div", "row-label");
  label.append(el("span", "row-title", row.label));
  // A linked app shows the account it is linked to.
  const linked = row.type === "connection" ? getConnection(row.provider) : null;
  const hint = linked ? `Connected${linked.account_email ? ` as ${linked.account_email}` : ""}` : row.hint;
  if (hint) label.append(el("span", "row-hint", hint));
  wrapper.append(label, buildRowControl(row));
  return wrapper;
}

export function renderSettings() {
  const root = $("#settings-root");
  root.replaceChildren();

  SECTIONS.forEach((section) => {
    const card = el("section", "card");
    card.append(el("h2", "card-title", section.title));
    section.rows.forEach((row) => card.append(buildRow(row)));
    root.append(card);
  });
}

/* ---------- Clear memories ---------- */

function openClearMemories() {
  confirmDialog({
    title: "Clear memories?",
    message: "Axelvon will forget everything she remembered about you. Your chats stay as they are.",
    confirmLabel: "Clear memories",
    onConfirm: async () => {
      // Memories are switched off (not erased from the database), and only the person's own are touched.
      const { error } = await supabase.from("memories").update({ active: false }).eq("user_id", state.user.id).eq("active", true);
      if (error) {
        console.error(error);
        toast("Couldn't clear memories. Please try again.");
        return false;
      }
      toast("Memories cleared");
      return true;
    },
  });
}

/* ---------- Data control ---------- */

// Reads every row of one of the person's tables, 1000 at a time.
async function readAll(table, column, value) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select("*").eq(column, value).order("created_at", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

async function downloadMyData() {
  try {
    const id = state.user.id;
    const [conversations, messages, memories] = await Promise.all([
      readAll("conversations", "user_id", id),
      readAll("messages", "user_id", id),
      readAll("memories", "user_id", id),
    ]);
    const data = { exported_at: new Date().toISOString(), profile: state.profile, settings: state.settings, conversations, messages, memories };

    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "axelvon-data.json";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast("Your data was downloaded");
  } catch (error) {
    console.error(error);
    toast("Couldn't download your data. Please try again.");
  }
}

function openDataControl() {
  openModal({
    title: "Data control",
    body: el("p", "modal-text", "Download a copy of your chats, memories and profile, or clear all of your chats."),
    actions: [
      {
        label: "Download my data",
        kind: "primary",
        onClick: async () => {
          await downloadMyData();
          return false;
        },
      },
      {
        label: "Clear all chats",
        kind: "outline-danger",
        onClick: () => {
          openClearChats(); // replaces this sheet with the confirmation
          return false;
        },
      },
      { label: "Close", kind: "secondary" },
    ],
  });
}

function openClearChats() {
  // Only after the user confirms, and only their own conversations are affected.
  confirmDialog({
    title: "Clear all chats?",
    message: "All of your conversations and messages will be permanently deleted. This can't be undone.",
    confirmLabel: "Clear all chats",
    onConfirm: async () => {
      const { error } = await supabase.from("conversations").delete().eq("user_id", state.user.id);
      if (error) {
        console.error(error);
        toast("Couldn't clear chats. Please try again.");
        return false;
      }

      resetChat();
      stopTyping();
      safeRemove(LAST_CONVERSATION_KEY);
      renderMessages();
      toast("Chats cleared");
      return true;
    },
  });
}

/* ---------- Feedback ---------- */

function openFeedback() {
  const field = el("label", "field");
  const text = el("textarea");
  text.maxLength = 2000;
  text.placeholder = "Tell us what you like or what to improve";
  field.append(el("span", undefined, "Your feedback"), text);
  const message = el("p", "form-error");
  const form = el("div", "modal-form");
  form.append(field, message);

  openModal({
    title: "Feedback",
    body: form,
    actions: [
      {
        label: "Send",
        kind: "primary",
        onClick: async () => {
          const note = text.value.trim();
          if (!note) {
            message.textContent = "Write something first.";
            return false;
          }
          try {
            await sendAppFeedback(state.user.id, note);
          } catch (error) {
            console.error(error);
            message.textContent = "Couldn't send. Please try again.";
            return false;
          }
          toast("Thank you for your feedback");
        },
      },
      { label: "Cancel", kind: "secondary" },
    ],
  });
}
