// Typewriter effect: Axelvon's new replies are written out letter by letter.
// Only one reply is typed at a time. Tapping the reply (or sending a new message) finishes it at once.

import { renderMarkdown } from "./markdown.js";

const TICK_MS = 24;
const TARGET_TICKS = 170; // a long reply still finishes in about four seconds

let current = null; // { id, text, shown, step, onDone }
let timer = null;

function reducedMotion() {
  return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// Starts typing a reply. Returns false (and does nothing) when animations are reduced by the phone.
export function startTyping(id, text, onDone) {
  finishTyping();
  if (!id || !text || reducedMotion()) return false;
  current = { id, text, shown: 0, step: Math.max(2, Math.ceil(text.length / TARGET_TICKS)), onDone };
  timer = setInterval(tick, TICK_MS);
  return true;
}

export function isTyping(id) {
  return Boolean(current && current.id === id);
}

// The part of the reply written so far (used when the screen is redrawn while typing).
export function typedText(id) {
  return current && current.id === id ? current.text.slice(0, current.shown) : "";
}

function paint() {
  const box = document.querySelector("[data-typing] .markdown");
  if (!box || !current) return;
  box.innerHTML = renderMarkdown(current.text.slice(0, current.shown)); // sanitized inside renderMarkdown
  box.classList.add("typing");

  // Follow the text down, unless the person scrolled up to read.
  const list = document.querySelector("#messages");
  if (list && list.scrollHeight - list.scrollTop - list.clientHeight < 140) list.scrollTop = list.scrollHeight;
}

function tick() {
  if (!current) return;
  current.shown = Math.min(current.text.length, current.shown + current.step);
  paint();
  if (current.shown >= current.text.length) finishTyping();
}

// Stops the animation and shows the whole reply.
export function finishTyping() {
  if (!current) return;
  const done = current.onDone;
  stopTyping();
  if (done) done();
}

// Stops the animation without showing anything more (the chat was closed or replaced).
export function stopTyping() {
  clearInterval(timer);
  timer = null;
  current = null;
}
