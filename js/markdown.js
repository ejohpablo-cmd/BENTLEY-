// Turns Axelvon's markdown (**bold**, *italic*, > quotes, lists, code...) into safe HTML.

import { marked } from "https://cdn.jsdelivr.net/npm/marked@12.0.2/+esm";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.2.6/+esm";

marked.setOptions({ gfm: true, breaks: true });

// Links open in a new tab and cannot access this page.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// Always sanitized, so nothing in a reply can run scripts. Images are blocked to avoid tracking pixels.
export function renderMarkdown(text) {
  const html = marked.parse(text);
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true }, FORBID_TAGS: ["img"] });
}
