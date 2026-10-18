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

// Keyboard height from the VirtualKeyboard API (0 when the browser does not have it).
function readKeyboardApiHeight() {
  const keyboardApi = navigator.virtualKeyboard;
  if (!keyboardApi || !keyboardApi.boundingRect) return 0;
  return Math.max(0, Math.round(keyboardApi.boundingRect.height));
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
  const coveredByViewport = Math.max(0, Math.round(fullHeight - visibleBottom));
  // Chrome on Android (with "overlays-content") keeps the page full height, so the viewport never
  // shrinks. Its VirtualKeyboard API tells us the keyboard height directly.
  const coveredByKeyboardApi = readKeyboardApiHeight();
  const covered = Math.max(coveredByViewport, coveredByKeyboardApi);
  const keyboard = isTouchScreen() && isTyping() && covered >= MIN_KEYBOARD_PX ? covered : 0;
  const top = viewport ? Math.round(viewport.offsetTop) : 0;

  root.style.setProperty("--app-height", `${fullHeight}px`);
  root.style.setProperty("--kb", `${keyboard}px`);
  // The part of the screen you can really see (full height minus the keyboard). Pop-ups use this,
  // so they fit above the keyboard whether the browser overlays the keyboard or shrinks the page.
  root.style.setProperty("--vv-top", `${top}px`);
  root.style.setProperty("--vv-height", `${Math.max(0, fullHeight - keyboard - top)}px`);
  root.style.setProperty("--vv-h", `${Math.max(0, fullHeight - keyboard - top)}px`); // the same value under the older name, so either style.css works

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
  if (navigator.virtualKeyboard) {
    navigator.virtualKeyboard.overlaysContent = true; // the keyboard covers the page; we lift the input ourselves
    navigator.virtualKeyboard.addEventListener("geometrychange", update);
  }
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
