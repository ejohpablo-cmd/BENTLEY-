// The History page: list of conversations with Pin, Rename and Delete.

import { state, resetChat, LAST_CONVERSATION_KEY } from "./state.js";
import { supabase } from "./api.js";
import { $, el, icon, toast, formatDate, safeSet, safeRemove } from "./helpers.js";
import { openModal, confirmDialog } from "./modal.js";
import { loadConversation, renderMessages } from "./chat.js";
import { onPageShown, showTab } from "./navigation.js";

/* ---------- Loading and drawing the list ---------- */

async function loadHistory() {
  const root = $("#history-list");
  root.replaceChildren(el("p", "muted", "Loading…"));

  // Pinned conversations first, then the most recent.
  const { data, error } = await supabase
    .from("conversations")
    .select("id,title,updated_at,pinned")
    .eq("user_id", state.user.id)
    .eq("archived", false)
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error(error);
    root.replaceChildren(el("p", "muted", "Couldn't load your conversations."));
    return;
  }
  renderHistory(data || []);
}

function buildConversationItem(conversation) {
  const item = el("div", "history-item");

  const open = el("button", "history-main");
  open.type = "button";
  open.addEventListener("click", () => openConversation(conversation.id));

  const title = el("span", "history-title");
  if (conversation.pinned) {
    const pin = icon("pin", 14);
    pin.classList.add("pin-mark");
    title.append(pin);
  }
  title.append(document.createTextNode(conversation.title || "New chat"));
  open.append(title, el("span", "history-date", formatDate(conversation.updated_at)));

  const menu = el("button", "icon-btn");
  menu.type = "button";
  menu.setAttribute("aria-label", "Conversation options");
  menu.append(icon("dots"));
  menu.addEventListener("click", () => openConversationMenu(conversation));

  item.append(open, menu);
  return item;
}

function renderHistory(conversations) {
  const root = $("#history-list");
  root.replaceChildren();

  if (conversations.length === 0) {
    const empty = el("div", "empty-state");
    empty.append(
      el("h2", undefined, "No conversations yet"),
      el("p", undefined, "Start chatting with Axelvon and your conversations will appear here.")
    );
    root.append(empty);
    return;
  }

  conversations.forEach((conversation) => root.append(buildConversationItem(conversation)));
}

/* ---------- Opening a conversation ---------- */

async function openConversation(id) {
  try {
    resetChat();
    const found = await loadConversation(id);
    if (!found) {
      toast("That conversation no longer exists.");
      loadHistory();
      return;
    }
    safeSet(LAST_CONVERSATION_KEY, id);
    renderMessages();
    showTab("chat");
  } catch (error) {
    console.error(error);
    toast("Couldn't open that conversation.");
  }
}

/* ---------- The three-dot menu ---------- */

function openConversationMenu(conversation) {
  // The next sheet opens on the next tick, after this one has closed.
  const then = (next) => () => {
    setTimeout(() => next(conversation), 0);
  };

  openModal({
    title: conversation.title || "New chat",
    actions: [
      { label: conversation.pinned ? "Unpin" : "Pin", kind: "secondary", onClick: then(togglePin) },
      { label: "Rename", kind: "secondary", onClick: then(openRename) },
      { label: "Delete", kind: "danger", onClick: then(openDelete) },
      { label: "Cancel", kind: "secondary" },
    ],
  });
}

async function togglePin(conversation) {
  const { error } = await supabase
    .from("conversations")
    .update({ pinned: !conversation.pinned })
    .eq("id", conversation.id)
    .eq("user_id", state.user.id);

  if (error) {
    console.error(error);
    toast("Couldn't update the pin. Please try again.");
    return;
  }
  toast(conversation.pinned ? "Unpinned" : "Pinned");
  loadHistory();
}

function openRename(conversation) {
  const form = el("form", "modal-form");
  form.addEventListener("submit", (event) => event.preventDefault());

  const label = el("label", "field");
  label.append(el("span", undefined, "Conversation name"));
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 80;
  input.value = conversation.title || "";
  label.append(input);

  const message = el("p", "form-error");
  form.append(label, message);

  openModal({
    title: "Rename conversation",
    body: form,
    actions: [
      {
        label: "Save",
        kind: "primary",
        onClick: async () => {
          const title = input.value.trim();
          if (title.length < 1 || title.length > 80) {
            message.textContent = "Enter a name between 1 and 80 characters.";
            return false;
          }

          const { error } = await supabase
            .from("conversations")
            .update({ title })
            .eq("id", conversation.id)
            .eq("user_id", state.user.id);
          if (error) {
            console.error(error);
            message.textContent = "Couldn't rename. Please try again.";
            return false;
          }

          loadHistory();
          return true;
        },
      },
      { label: "Cancel", kind: "secondary" },
    ],
  });
}

function openDelete(conversation) {
  // Only happens after the user confirms, and only for their own conversation.
  confirmDialog({
    title: "Delete conversation?",
    message: "This conversation and its messages will be permanently deleted.",
    confirmLabel: "Delete",
    onConfirm: async () => {
      const { error } = await supabase
        .from("conversations")
        .delete()
        .eq("id", conversation.id)
        .eq("user_id", state.user.id);
      if (error) {
        console.error(error);
        toast("Couldn't delete. Please try again.");
        return false;
      }

      if (state.conversationId === conversation.id) {
        resetChat();
        safeRemove(LAST_CONVERSATION_KEY);
        renderMessages();
      }
      loadHistory();
      return true;
    },
  });
}

export function bindHistory() {
  onPageShown("history", loadHistory);
}
