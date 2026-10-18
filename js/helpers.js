// Small tools used all over the app: DOM shortcuts, icons, storage, toast and clipboard.

export const $ = (selector, root = document) => root.querySelector(selector);

// Creates an element, optionally with a class name and plain text.
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ---------- Icons ---------- */

const ICON_PATHS = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 10.5l6.8-4M8.6 13.5l6.8 4"/>',
  up: '<path d="M7 11v9H4v-9h3zM7 11l4-8a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 17.7 20H7"/>',
  down: '<g transform="rotate(180 12 12)"><path d="M7 11v9H4v-9h3zM7 11l4-8a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 17.7 20H7"/></g>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  dots: '<circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
};

// Returns an inline SVG icon. The paths above are fixed, trusted markup.
export function icon(name, size = 20) {
  const wrapper = el("span", "icon");
  wrapper.innerHTML =
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
  return wrapper;
}

/* ---------- Browser storage (safe when storage is blocked) ---------- */

export function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (error) {
    return null;
  }
}

export function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    // Storage is unavailable: the app still works, it just won't remember this.
  }
}

export function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    // Storage is unavailable.
  }
}

// Settings > Regenerate response. Kept on this phone only.
export function regenerateEnabled() {
  return safeGet("bentley_regenerate") !== "off";
}

/* ---------- Dates ---------- */

export function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatDate(iso) {
  const date = new Date(iso);
  const day = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${day} · ${formatTime(iso)}`;
}

/* ---------- Toast ---------- */

let toastTimer = null;

export function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3000);
}

/* ---------- Clipboard ---------- */

// Copies text and returns true on success. Falls back to the old method on older browsers.
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    // Fall through to the legacy method below.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch (error) {
    return false;
  }
}
