// The rest countdown. After 4 pictures or 3M tokens Bentley rests for 1 hour 30 minutes.
// The server decides when that happens (supabase/functions/chat/usage.ts); this file only shows the countdown
// and locks the input box until the rest is over.

import { state } from "./state.js";
import { $ } from "./helpers.js";
import { fetchRestingUntil } from "./api.js";

let timer = null;
let onChange = () => {};

// callback runs whenever resting starts or ends, so the input box can follow it.
export function bindUsage(callback) {
  onChange = callback;
}

export function isResting() {
  return Boolean(state.restingUntil) && Date.parse(state.restingUntil) > Date.now();
}

function formatCountdown(milliseconds) {
  const total = Math.max(0, Math.ceil(milliseconds / 1000));
  const parts = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

function tick() {
  if (!isResting()) {
    state.restingUntil = null;
    render();
    return;
  }
  $("#rest-timer").textContent = formatCountdown(Date.parse(state.restingUntil) - Date.now());
}

function render() {
  clearInterval(timer);
  timer = null;

  const resting = isResting();
  $("#rest-banner").classList.toggle("hidden", !resting);
  if (resting) {
    $("#rest-timer").textContent = formatCountdown(Date.parse(state.restingUntil) - Date.now());
    timer = setInterval(tick, 1000);
  }
  onChange();
}

// Called when the server says Bentley is resting (a 429 answer with the time).
export function startResting(until) {
  state.restingUntil = until;
  render();
}

// Asks the server whether a rest is going on (after signing in, and after each reply).
export async function refreshUsage() {
  if (!state.user) return;
  try {
    // A rest already known on screen is kept; an ended rest clears itself when its countdown reaches zero.
    const until = await fetchRestingUntil(state.user.id);
    if (until) state.restingUntil = until;
  } catch (error) {
    console.error(error);
  }
  render();
}

export function clearResting() {
  state.restingUntil = null;
  render();
}
