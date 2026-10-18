// Shared constants and the single app-wide state object.

export const APP_VERSION = "2.0.0";
export const MAX_MESSAGE_LENGTH = 4000;
export const LAST_CONVERSATION_KEY = "bentley_last_conversation";
export const BENTLEY_AVATAR = "benny.png";

export const DEFAULT_SETTINGS = {
  theme: "system",
  response_style: "balanced",
  creativity_level: "medium",
  personality: "friendly",
  bubble_style: "rounded",
  memory_enabled: false,
  enter_to_send: true,
};

export const state = {
  user: null,
  profile: null,
  settings: { ...DEFAULT_SETTINGS },
  connections: [], // linked apps: { provider, account_email }

  // The open conversation
  conversationId: null,
  messages: [],
  feedback: {}, // message id -> "good" | "bad"
  actions: {}, // message id -> something Bentley asked to do: { id, summary, status }

  // Chat activity
  busy: false, // true while waiting for Bentley
  uploading: false, // true while photos are being uploaded before sending
  abortController: null, // lets the Stop button cancel the request
  editingId: null, // id of the user message being edited
  selectedMessageId: null, // user message whose Copy / Edit buttons are showing
  restingUntil: null, // ISO time when Bentley is back after the usage limit, or null

  tab: "chat",
};

// Clears the open conversation and cancels any request still running for it.
export function resetChat() {
  if (state.abortController) state.abortController.abort();
  state.abortController = null;
  state.busy = false;
  state.conversationId = null;
  state.messages = [];
  state.feedback = {};
  state.actions = {};
  state.editingId = null;
  state.selectedMessageId = null;
}
