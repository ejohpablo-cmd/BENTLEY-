// Runs whenever someone signs in or out: loads their data, or clears it.

import { state, resetChat, DEFAULT_SETTINGS, LAST_CONVERSATION_KEY } from "./state.js";
import { $, toast, safeGet, safeRemove } from "./helpers.js";
import { applyAppearance } from "./appearance.js";
import { showAuthScreen, showAppScreen } from "./auth.js";
import { loadConversation, renderMessages } from "./chat.js";
import { loadProfile, renderProfile } from "./profile.js";
import { loadSettings, renderSettings } from "./settings.js";
import { loadConnections, announceConnectionResult } from "./connections.js";
import { showTab } from "./navigation.js";
import { lockNow } from "./applock.js";
import { clearResting, refreshUsage } from "./usage.js";

function clearSignedOutState() {
  resetChat();
  clearResting();
  state.user = null;
  state.profile = null;
  state.settings = { ...DEFAULT_SETTINGS };
  state.connections = [];
  $("#auth-password").value = "";
}

export async function handleSession(session) {
  if (!session) {
    clearSignedOutState();
    showAuthScreen();
    return;
  }

  // Already loaded for this person (the sign-in event can fire more than once).
  if (state.user && state.user.id === session.user.id) return;

  state.user = session.user;
  showAppScreen();
  lockNow(); // asks for the PIN straight away when App lock is on

  try {
    await Promise.all([loadProfile(), loadSettings(), loadConnections()]);
    applyAppearance();
    renderSettings();
    renderProfile();
    announceConnectionResult(); // when Google has just sent the person back

    // Pick up where they left off.
    const lastId = safeGet(LAST_CONVERSATION_KEY);
    if (lastId && !(await loadConversation(lastId))) safeRemove(LAST_CONVERSATION_KEY);
  } catch (error) {
    console.error(error);
    toast("Couldn't load your data. Please refresh.");
  }

  // Is Bentley resting after the usage limit? This decides whether the input box is locked.
  await refreshUsage();

  // Open the Chat page, which makes Bentley say hi when there is no saved conversation.
  renderMessages();
  showTab("chat");
}
