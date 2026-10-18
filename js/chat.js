// The Chat page: showing messages, sending, editing, stopping, regenerating, feedback and approvals.

import { state, resetChat, MAX_MESSAGE_LENGTH, LAST_CONVERSATION_KEY } from "./state.js";
import { supabase, requestChat, uploadChatPhotos } from "./api.js";
import { $, el, icon, toast, copyText, regenerateEnabled, safeSet, safeRemove } from "./helpers.js";
import { buildAxelvonAvatar } from "./avatars.js";
import { renderMarkdown } from "./markdown.js";
import { shareText } from "./share.js";
import { finishTyping, isTyping, startTyping, stopTyping, typedText } from "./typewriter.js";
import { bindUsage, isResting, refreshUsage, startResting } from "./usage.js";
import { onPageShown, showTab } from "./navigation.js";
import { bindPhotos, buildPhotos, clearPending, pendingCount, pendingPhotos, releasePending, rememberLocalPhoto, warmPhotoLinks } from "./photos.js";

/* =====================================================================
   Loading conversations
   ===================================================================== */

// Reads one conversation (with its feedback and approval requests). Returns null if it doesn't exist.
async function fetchConversation(id) {
  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", id)
    .eq("user_id", state.user.id)
    .maybeSingle();
  if (conversationError) throw conversationError;
  if (!conversation) return null;

  const { data: messages, error } = await supabase
    .from("messages")
    .select("id,role,content,created_at,images")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw error;

  const feedback = {};
  const replyIds = messages
    .filter((message) => message.role === "assistant")
    .map((message) => message.id)
    .slice(-100);

  if (replyIds.length > 0) {
    const { data: rows } = await supabase
      .from("feedback")
      .select("message_id,type")
      .eq("user_id", state.user.id)
      .in("message_id", replyIds);
    (rows || []).forEach((row) => {
      feedback[row.message_id] = row.type;
    });
  }

  const actions = {};
  const { data: requests } = await supabase
    .from("pending_actions")
    .select("id,message_id,tool,summary,status")
    .eq("conversation_id", id)
    .eq("user_id", state.user.id);
  (requests || []).forEach((request) => {
    actions[request.message_id] = request;
  });

  return { messages, feedback, actions };
}

// Opens a conversation in the chat. Returns false if it no longer exists.
export async function loadConversation(id) {
  const result = await fetchConversation(id);
  if (!result) return false;
  await warmPhotoLinks(result.messages);
  stopTyping();
  state.conversationId = id;
  state.messages = result.messages;
  state.feedback = result.feedback;
  state.actions = result.actions;
  return true;
}

// Re-reads the open conversation so the screen matches what is really saved.
async function syncConversation() {
  const id = state.conversationId;
  if (!id) return;
  try {
    const result = await fetchConversation(id);
    if (result && state.conversationId === id) {
      await warmPhotoLinks(result.messages);
      state.messages = result.messages;
      state.feedback = result.feedback;
      state.actions = result.actions;
    }
  } catch (error) {
    console.error(error);
  }
}

async function createConversation() {
  const { data, error } = await supabase
    .from("conversations")
    .insert({ user_id: state.user.id, title: "New chat" })
    .select("id")
    .single();
  if (error) throw error;
  state.conversationId = data.id;
  return data.id;
}

/* =====================================================================
   Drawing the messages
   ===================================================================== */

function isGreetingOnly() {
  return state.messages.length === 1 && state.messages[0].role === "assistant";
}

function lastAssistantIndex() {
  for (let i = state.messages.length - 1; i >= 0; i--) {
    if (state.messages[i].role === "assistant") return i;
  }
  return -1;
}

export function scrollToBottom() {
  const root = $("#messages");
  requestAnimationFrame(() => {
    root.scrollTop = root.scrollHeight;
  });
}

function buildThinkingRow() {
  const row = el("div", "thinking");
  const dots = el("span", "dots");
  dots.append(el("span", "dot"), el("span", "dot"), el("span", "dot"));
  row.append(dots, el("span", "label", "Axelvon is thinking…"));
  return row;
}

// Shown in the middle of the page before the conversation has any message.
function buildEmptyState() {
  const wrapper = el("div", "empty-state");
  wrapper.append(buildAxelvonAvatar("lg"), el("h2", undefined, "Axelvon"));
  wrapper.append(state.busy ? buildThinkingRow() : el("p", undefined, "Your AI creative companion. Say hi!"));
  return wrapper;
}

// A conversation that only contains Axelvon's opening line: logo in the middle, greeting below it.
function buildWelcome(message) {
  const wrapper = el("div", "welcome");
  wrapper.append(buildAxelvonAvatar("lg"), buildAxelvonMessage(message, true));
  return wrapper;
}

function actionButton(iconName, label, onClick, active = false) {
  const button = el("button", `action-btn${active ? " active" : ""}`);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(iconName));
  button.addEventListener("click", onClick);
  return button;
}

function buildActionGroup(buttons) {
  const group = el("div", "actions");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "Message actions");
  group.append(...buttons);
  return group;
}

/* ---------- Your messages ---------- */

function toggleSelected(id) {
  state.selectedMessageId = state.selectedMessageId === id ? null : id;
  renderMessages({ keepScroll: true });
}

function buildUserActions(message) {
  const buttons = [];
  if (message.content) {
    buttons.push(
      actionButton("copy", "Copy", async () => {
        toast((await copyText(message.content)) ? "Copied" : "Couldn't copy");
      })
    );
  }
  if (!state.busy) buttons.push(actionButton("edit", "Edit", () => startEdit(message)));
  return buildActionGroup(buttons);
}

function buildUserMessage(message) {
  const wrapper = el("article", "msg user");
  if (message.images && message.images.length > 0) wrapper.append(buildPhotos(message.images));
  const bubble = el("div", "bubble", message.content);

  // Tapping your message reveals Copy and Edit under it.
  if (message.id) {
    bubble.classList.add("tappable");
    bubble.setAttribute("role", "button");
    bubble.tabIndex = 0;
    bubble.addEventListener("click", () => toggleSelected(message.id));
    bubble.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleSelected(message.id);
      }
    });
  }

  // A message that is only photos has no bubble.
  if (message.content) wrapper.append(bubble);
  if (message.id && state.selectedMessageId === message.id) wrapper.append(buildUserActions(message));
  return wrapper;
}

/* ---------- Axelvon asking for approval ---------- */

const ACTION_STATUS_TEXT = {
  approved: "Approved",
  denied: "Not done",
  failed: "Approved, but it didn't work",
};

// Shown under a message where Axelvon wants to do something risky (send an email, delete something).
// The text is built by the server from what will really happen. Only the newest request can be answered;
// an older one was cancelled when the chat moved on.
function buildActionCard(action, isLast) {
  const card = el("div", "approval");
  card.append(el("div", "approval-text", action.summary));

  if (action.status !== "pending") {
    card.append(el("div", "approval-status", ACTION_STATUS_TEXT[action.status] || ACTION_STATUS_TEXT.denied));
  } else if (!isLast) {
    card.append(el("div", "approval-status", ACTION_STATUS_TEXT.denied));
  } else {
    const buttons = el("div", "approval-buttons");
    const approve = el("button", "btn sm primary", "Approve");
    const deny = el("button", "btn sm secondary", "Deny");
    [approve, deny].forEach((button) => {
      button.type = "button";
      button.disabled = state.busy; // greyed out while Axelvon is already working on it
    });
    approve.addEventListener("click", () => answerRequest(action, true));
    deny.addEventListener("click", () => answerRequest(action, false));
    buttons.append(approve, deny);
    card.append(buttons);
  }
  return card;
}

/* ---------- Axelvon's messages (no bubble, markdown) ---------- */

function buildAxelvonActions(message, isLast) {
  const buttons = [
    actionButton("copy", "Copy", async () => {
      toast((await copyText(message.content)) ? "Copied" : "Couldn't copy");
    }),
    actionButton("share", "Share", () => shareMessage(message)),
    actionButton("up", "Good response", () => sendFeedback(message, "good"), state.feedback[message.id] === "good"),
    actionButton("down", "Bad response", () => sendFeedback(message, "bad"), state.feedback[message.id] === "bad"),
  ];
  if (isLast && regenerateEnabled()) buttons.push(actionButton("refresh", "Regenerate", regenerate));
  return buildActionGroup(buttons);
}

function buildAxelvonMessage(message, isLast) {
  const wrapper = el("article", "msg axelvon");
  const bubble = el("div", "bubble");
  const text = el("div", "markdown");
  const typing = isTyping(message.id);

  if (typing) {
    // A new reply is being written out. The typewriter fills this box; tapping it shows the whole reply.
    wrapper.dataset.typing = "true";
    text.classList.add("typing");
    text.innerHTML = renderMarkdown(typedText(message.id)); // sanitized inside renderMarkdown
    bubble.addEventListener("click", finishTyping);
  } else {
    text.innerHTML = renderMarkdown(message.content); // sanitized inside renderMarkdown
  }
  bubble.append(text);

  if (!typing) {
    if (message.images && message.images.length > 0) bubble.append(buildPhotos(message.images));
    const action = message.id ? state.actions[message.id] : null;
    if (action) bubble.append(buildActionCard(action, isLast));
  }
  wrapper.append(bubble);

  if (message.id && !typing) wrapper.append(buildAxelvonActions(message, isLast && !state.busy));
  return wrapper;
}

// The reply that is still arriving: the words so far, or "thinking" before the first word.
function fillLiveBubble(bubble) {
  if (!state.streamingText) {
    bubble.append(buildThinkingRow());
    return;
  }
  const text = el("div", "markdown typing");
  text.innerHTML = renderMarkdown(state.streamingText); // sanitized inside renderMarkdown
  bubble.append(text);
}

// Called as Axelvon's words arrive. Redraws at most once per frame, and follows the text down
// unless the person scrolled up to read.
let livePaintQueued = false;
function showStreamedText(text) {
  state.streamingText = text;
  if (livePaintQueued) return;
  livePaintQueued = true;
  requestAnimationFrame(() => {
    livePaintQueued = false;
    const bubble = document.querySelector("#messages [data-live] .bubble");
    if (!bubble) return;
    bubble.replaceChildren();
    fillLiveBubble(bubble);
    const list = $("#messages");
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 140) list.scrollTop = list.scrollHeight;
  });
}

/* ---------- The whole message list ---------- */

export function renderMessages({ keepScroll = false } = {}) {
  const root = $("#messages");
  const previousScroll = root.scrollTop;
  root.replaceChildren();

  if (state.messages.length === 0) {
    root.append(buildEmptyState());
  } else if (isGreetingOnly()) {
    root.append(buildWelcome(state.messages[0]));
  } else {
    const lastReply = lastAssistantIndex();
    state.messages.forEach((message, index) => {
      root.append(message.role === "user" ? buildUserMessage(message) : buildAxelvonMessage(message, index === lastReply));
    });
  }

  if (state.busy && state.messages.length > 0) {
    const live = el("article", "msg axelvon");
    live.dataset.live = "true";
    const bubble = el("div", "bubble");
    fillLiveBubble(bubble);
    live.append(bubble);
    root.append(live);
  }

  if (keepScroll) root.scrollTop = previousScroll;
  else scrollToBottom();
  updateComposer();
}

/* =====================================================================
   The input box
   ===================================================================== */

function autoGrowInput() {
  const input = $("#chat-input");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
}

function clearInput() {
  $("#chat-input").value = "";
  autoGrowInput();
}

// Keeps the send / stop button and the "Editing message" bar in step with the state.
export function updateComposer() {
  // Photos alone are enough to send.
  const hasContent = $("#chat-input").value.trim().length > 0 || pendingCount() > 0;
  const button = $("#send-btn");

  const resting = isResting();

  button.disabled = !state.busy && (!hasContent || state.uploading || resting);
  $("#chat-input").disabled = resting;
  $("#chat-input").placeholder = resting ? "Axelvon is resting…" : "Talk to Axelvon";
  $("#composer").classList.toggle("resting", resting);
  button.classList.toggle("is-stop", state.busy);
  button.setAttribute("aria-label", state.busy ? "Stop response" : "Send message");
  $("#send-icon").classList.toggle("hidden", state.busy);
  $("#stop-icon").classList.toggle("hidden", !state.busy);
  $("#edit-bar").classList.toggle("hidden", !state.editingId);
}

function startEdit(message) {
  if (state.busy) return;
  state.editingId = message.id;
  state.selectedMessageId = null;
  clearPending(); // photos can't be added to an edit

  const input = $("#chat-input");
  input.value = message.content;
  autoGrowInput();
  renderMessages({ keepScroll: true });
  input.focus();
}

function cancelEdit() {
  state.editingId = null;
  clearInput();
  renderMessages({ keepScroll: true });
}

/* =====================================================================
   Talking to Axelvon
   ===================================================================== */

// Runs one request to Axelvon while showing the "thinking" state.
//   request(signal, onText)  makes the call and returns Axelvon's answer (onText shows words as they arrive)
//   apply(result)    puts the answer into state.messages
async function askAxelvon({ request, apply, failureText }) {
  const controller = new AbortController();
  state.abortController = controller;
  state.busy = true;
  renderMessages();

  try {
    apply(await request(controller.signal, showStreamedText));
  } catch (error) {
    // Another chat was opened while waiting, so this request no longer matters.
    if (state.abortController !== controller) return;

    if (error.restingUntil) {
      startResting(error.restingUntil); // the usage limit was reached: show the countdown
      toast("Axelvon needs a rest. See the countdown below.");
    } else if (error.name !== "AbortError") {
      console.error(error);
      toast(failureText);
    }
    await syncConversation();
  } finally {
    if (state.abortController === controller) {
      state.abortController = null;
      state.busy = false;
      state.streamingText = "";
      renderMessages();
      refreshUsage(); // a reply may have used up the limit, which starts the rest
    }
  }
}

export function stopResponse() {
  if (state.abortController) state.abortController.abort();
}

async function sendMessage() {
  const text = $("#chat-input").value.trim();
  const photos = state.editingId ? [] : pendingPhotos();
  if ((!text && photos.length === 0) || state.busy || state.uploading || isResting()) return;
  if (text.length > MAX_MESSAGE_LENGTH) {
    toast("That message is too long.");
    return;
  }

  finishTyping(); // a reply still being written is shown in full first

  // Photos go up first. If that fails, the text and photos stay in the box so nothing is lost.
  let photoPaths = [];
  if (photos.length > 0) {
    state.uploading = true;
    updateComposer();
    try {
      photoPaths = await uploadChatPhotos(state.user.id, photos.map((photo) => photo.blob));
    } catch (error) {
      console.error(error);
      toast("Couldn't upload your photo. Please try again.");
      return;
    } finally {
      state.uploading = false;
      updateComposer();
    }
    photoPaths.forEach((path, index) => rememberLocalPhoto(path, photos[index].url));
    releasePending();
  }

  const editingId = state.editingId;
  state.editingId = null;
  state.selectedMessageId = null;
  clearInput();

  // Show the message straight away. When editing, everything after it is dropped from the screen.
  if (editingId) {
    const index = state.messages.findIndex((message) => message.id === editingId);
    if (index < 0) return;
    state.messages = [...state.messages.slice(0, index), { ...state.messages[index], content: text }];
  } else {
    state.messages.push({ id: null, role: "user", content: text, images: photoPaths, created_at: new Date().toISOString() });
  }
  const yourMessage = state.messages[state.messages.length - 1];

  await askAxelvon({
    request: async (signal, onText) => {
      const conversationId = state.conversationId || (await createConversation());
      safeSet(LAST_CONVERSATION_KEY, conversationId);
      return requestChat(
        {
          conversation_id: conversationId,
          message: text,
          edit_message_id: editingId || undefined,
          images: photoPaths.length > 0 ? photoPaths : undefined,
        },
        signal,
        onText
      );
    },
    apply: (result) => {
      if (result.user_message && result.user_message.id) yourMessage.id = result.user_message.id;
      state.messages.push(result.message);
      rememberAction(result);
      typeReply(result.message);
    },
    failureText: "Axelvon couldn't reply right now. Please try again.",
  });
}

// Writes a brand new reply out letter by letter (the typewriter effect).
function typeReply(message) {
  if (state.streamingText) return; // it was already shown word by word
  if (message && message.id) startTyping(message.id, message.content, () => renderMessages({ keepScroll: true }));
}

function regenerate() {
  if (state.busy || !state.conversationId || isResting()) return;
  const index = lastAssistantIndex();
  if (index < 0) return;

  askAxelvon({
    request: (signal, onText) => requestChat({ conversation_id: state.conversationId, regenerate: true }, signal, onText),
    apply: (result) => {
      delete state.feedback[state.messages[index].id];
      delete state.actions[state.messages[index].id];
      state.messages[index] = result.message;
      rememberAction(result);
      typeReply(result.message);
    },
    failureText: "Couldn't regenerate. Please try again.",
  });
}

// Axelvon opens an empty conversation with a fresh greeting.
function greet() {
  askAxelvon({
    request: async (signal, onText) => {
      const conversationId = state.conversationId || (await createConversation());
      safeSet(LAST_CONVERSATION_KEY, conversationId);
      return requestChat({ conversation_id: conversationId, greet: true }, signal, onText);
    },
    apply: (result) => {
      state.messages.push(result.message);
      typeReply(result.message);
    },
    failureText: "Axelvon couldn't say hi right now.",
  });
}

// If Axelvon's answer asks for approval, keep the request so its card can be shown.
function rememberAction(result) {
  if (result.action) state.actions[result.message.id] = result.action;
}

// Approve or Deny. Axelvon then carries on (for example, tells you the email was sent).
function answerRequest(action, approve) {
  if (state.busy || !state.conversationId || isResting()) return;

  askAxelvon({
    request: (signal, onText) =>
      requestChat({ conversation_id: state.conversationId, action_id: action.id, approve }, signal, onText),
    apply: (result) => {
      action.status = result.resolved_action.status;
      state.messages.push(result.message);
      rememberAction(result);
      typeReply(result.message);
    },
    failureText: "Couldn't complete that. Please try again.",
  });
}

// "New chat": an empty page, and Axelvon greets you as soon as it is shown.
export function startNewChat() {
  // An empty conversation (for example a greeting that failed) is reused instead of creating another.
  const reusableId = state.messages.length === 0 ? state.conversationId : null;
  resetChat();
  stopTyping();
  state.conversationId = reusableId;
  if (!reusableId) safeRemove(LAST_CONVERSATION_KEY);

  clearInput();
  renderMessages();
  showTab("chat");
}

/* =====================================================================
   Share and feedback
   ===================================================================== */

function shareMessage(message) {
  return shareText(message.content); // the phone's share sheet (see share.js)
}

async function sendFeedback(message, type) {
  if (!message.id || state.feedback[message.id] === type) return;

  const { error } = await supabase
    .from("feedback")
    .upsert({ message_id: message.id, user_id: state.user.id, type }, { onConflict: "message_id,user_id" });
  if (error) {
    console.error(error);
    toast("Couldn't save feedback.");
    return;
  }

  state.feedback[message.id] = type;
  renderMessages({ keepScroll: true });
  toast("Thanks for the feedback");
}

/* =====================================================================
   Wiring
   ===================================================================== */

export function bindChat() {
  const input = $("#chat-input");

  input.addEventListener("input", () => {
    autoGrowInput();
    updateComposer();
  });
  input.addEventListener("focus", () => setTimeout(scrollToBottom, 250));
  input.addEventListener("keydown", (event) => {
    const enterSends = event.key === "Enter" && !event.shiftKey && !event.isComposing && state.settings.enter_to_send;
    if (!enterSends) return;
    event.preventDefault();
    if (!state.busy) sendMessage();
  });

  // The same button sends a message, or stops Axelvon while a reply is on the way.
  $("#composer").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.busy) stopResponse();
    else sendMessage();
  });

  bindPhotos(updateComposer);
  $("#cancel-edit-btn").addEventListener("click", cancelEdit);
  $("#new-chat-btn").addEventListener("click", startNewChat);

  // Each time the Chat page is shown: jump to the newest message, or let Axelvon say hi in an empty chat.
  onPageShown("chat", () => {
    scrollToBottom();
    if (state.messages.length === 0 && !state.busy && state.user && !isResting()) greet();
  });

  bindUsage(updateComposer);
}
