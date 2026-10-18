// On-screen keyboard handling.
//
// The keyboard OVERLAYS the app: the navigation bar and the wallpaper stay where they are and the
// keyboard simply covers them. Only the Chat input (and pop-up sheets) are lifted so they stay visible.
//
//   --app-height  the full height of the screen without the keyboard (never shrinks while typing)
//   --kb          how tall the keyboard is right now (0px when closed)

import { state } from "./state.js";
import { scrollToBottom } from "./chat.js";

const root = document.documentElement;
const NON_TEXT_INPUTS = ["checkbox", "radio", "button", "submit", "file", "range", "color"];
const MIN_KEYBOARD_PX = 100; // smaller differences are browser toolbars, not a keyboard

let fullHeight = 0;
let lastWidth = 0;
let lastKeyboard = 0;

function isTyping() {
  const field = document.activeElement;
  if (!field) return false;
  if (field.tagName === "TEXTAREA") return true;
  return field.tagName === "INPUT" && !NON_TEXT_INPUTS.includes(field.type);
}

function isTouchScreen() {
  return Boolean(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
}

function update() {
  const viewport = window.visualViewport;
  const innerHeight = window.innerHeight;

  // The full height is only remembered while a touch screen is typing (that is when the keyboard is up).
  // Otherwise it follows the real window, so resizing a computer window works normally.
  if (!fullHeight || window.innerWidth !== lastWidth || !isTouchScreen() || !isTyping() || innerHeight > fullHeight) {
    fullHeight = innerHeight;
  }
  lastWidth = window.innerWidth;

  const visibleBottom = viewport ? viewport.height + viewport.offsetTop : innerHeight;
  const covered = Math.max(0, Math.round(fullHeight - visibleBottom));
  const keyboard = isTouchScreen() && isTyping() && covered >= MIN_KEYBOARD_PX ? covered : 0;

  root.style.setProperty("--app-height", `${fullHeight}px`);
  root.style.setProperty("--kb", `${keyboard}px`);

  // The visible area (what is left above the keyboard). Pop-ups are sized to it.
  const visibleHeight = viewport ? Math.round(viewport.height) : innerHeight;
  const visibleTop = viewport ? Math.round(viewport.offsetTop) : 0;
  root.style.setProperty("--vv-h", `${visibleHeight}px`);
  root.style.setProperty("--vv-top", `${visibleTop}px`);
  root.classList.toggle("kb-open", keyboard > 0 || visibleHeight < fullHeight - MIN_KEYBOARD_PX);
  root.classList.toggle("short-screen", visibleHeight < 560);

  if (keyboard !== lastKeyboard) {
    lastKeyboard = keyboard;
    window.scrollTo(0, 0); // some phones scroll the page to show the field; the app handles it itself
    if (state.tab === "chat") scrollToBottom();
  }
}

// Brings a field that was tapped into view above the keyboard (sign in form, pop-up forms).
function showFocusedField(event) {
  const field = event.target;
  if (!field || !field.scrollIntoView || field.id === "chat-input") return;
  setTimeout(() => field.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
}

export function bindKeyboard() {
  update();
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", () => setTimeout(update, 300));
  document.addEventListener("focusin", () => setTimeout(update, 50));
  document.addEventListener("focusin", showFocusedField);
  document.addEventListener("focusout", () => setTimeout(update, 50));
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", update);
    window.visualViewport.addEventListener("scroll", update);
  }
}
