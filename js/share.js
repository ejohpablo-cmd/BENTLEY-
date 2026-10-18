// Sharing a reply. The phone's own share sheet is used when the browser has one (WhatsApp, Messages, Mail...).
// SAFE CHOICE: when it doesn't (for example on a computer or in a page opened without https), a small sheet with the
// most common apps opens instead, so Share never just silently copies the text.

import { el, toast, copyText } from "./helpers.js";
import { openModal } from "./modal.js";

const TITLE = "Axelvon";

function openFallbackSheet(text) {
  const message = encodeURIComponent(text);
  const targets = [
    ["WhatsApp", `https://wa.me/?text=${message}`],
    ["Telegram", `https://t.me/share/url?url=%20&text=${message}`],
    ["X (Twitter)", `https://twitter.com/intent/tweet?text=${encodeURIComponent(text.slice(0, 270))}`],
    ["Email", `mailto:?subject=${encodeURIComponent(TITLE)}&body=${message}`],
    ["Text message", `sms:?&body=${message}`],
  ];

  const list = el("div", "modal-actions");
  targets.forEach(([label, href]) => {
    const link = el("a", "btn secondary", label);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.style.display = "grid";
    link.style.placeItems = "center";
    link.style.textDecoration = "none";
    link.addEventListener("click", () => setTimeout(() => document.querySelector("#modal-actions button")?.click(), 0));
    list.append(link);
  });

  openModal({
    title: "Share with",
    body: list,
    actions: [
      {
        label: "Copy text",
        kind: "primary",
        onClick: async () => {
          toast((await copyText(text)) ? "Copied to clipboard" : "Couldn't copy");
        },
      },
      { label: "Cancel", kind: "secondary" },
    ],
  });
}

export async function shareText(text) {
  if (navigator.share) {
    try {
      await navigator.share({ title: TITLE, text });
      return;
    } catch (error) {
      if (error && error.name === "AbortError") return; // the person closed the share sheet
      // Any other problem: fall through to the sheet below.
    }
  }
  openFallbackSheet(text);
}
