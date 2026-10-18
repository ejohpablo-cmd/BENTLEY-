// The bottom-sheet pop-up used for menus, forms and confirmations.

import { $, el } from "./helpers.js";

let focusBeforeOpen = null;

// actions: [{ label, kind: "primary" | "secondary" | "danger", onClick }]
// If an onClick returns false the sheet stays open (used to show form errors).
export function openModal({ title, body, actions }) {
  focusBeforeOpen = document.activeElement;
  $("#modal-title").textContent = title;

  const bodyBox = $("#modal-body");
  bodyBox.replaceChildren();
  if (body) bodyBox.append(body);

  const actionsBox = $("#modal-actions");
  actionsBox.replaceChildren();

  const buttons = [];
  actions.forEach((action) => {
    const button = el("button", `btn ${action.kind || "secondary"}`, action.label);
    button.type = "button";
    button.addEventListener("click", async () => {
      let keepOpen = false;
      if (action.onClick) {
        buttons.forEach((other) => (other.disabled = true));
        try {
          keepOpen = (await action.onClick()) === false;
        } catch (error) {
          console.error(error);
        } finally {
          buttons.forEach((other) => (other.disabled = false));
        }
      }
      if (!keepOpen) closeModal();
    });
    buttons.push(button);
    actionsBox.append(button);
  });

  $("#modal").classList.remove("hidden");
  const firstField = bodyBox.querySelector("input[type='text'], textarea") || actionsBox.querySelector("button");
  if (firstField) firstField.focus();
}

export function closeModal() {
  $("#modal").classList.add("hidden");
  $("#modal-body").replaceChildren();
  $("#modal-actions").replaceChildren();
  if (focusBeforeOpen && typeof focusBeforeOpen.focus === "function") focusBeforeOpen.focus();
  focusBeforeOpen = null;
}

export function isModalOpen() {
  return !$("#modal").classList.contains("hidden");
}

// A simple "Are you sure?" sheet. onConfirm may return false to stay open.
export function confirmDialog({ title, message, confirmLabel, onConfirm }) {
  openModal({
    title,
    body: el("p", "modal-text", message),
    actions: [
      { label: confirmLabel, kind: "danger", onClick: onConfirm },
      { label: "Cancel", kind: "secondary" },
    ],
  });
}
