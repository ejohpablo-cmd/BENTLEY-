// App lock: a PIN (4 to 6 digits) that hides Bentley when it is opened or comes back from the background.
//
// SAFE CHOICE: the PIN is kept only on this device (a salted hash, never the PIN itself) and protects against
// someone casually picking up the phone. It is not account security. "Forgot PIN" signs the person out.

import { state } from "./state.js";
import { supabase } from "./api.js";
import { $, el, toast, safeGet, safeSet, safeRemove } from "./helpers.js";
import { openModal } from "./modal.js";

const LOCK_KEY = "bentley_app_lock";
const AWAY_SECONDS = 10; // coming back after this long asks for the PIN
const MAX_TRIES = 5;
const WAIT_SECONDS = 30;

let hiddenAt = null;
let wrongTries = 0;
let waitUntil = 0;

/* ---------- Storing the PIN ---------- */

function readLock() {
  try {
    const saved = JSON.parse(safeGet(LOCK_KEY) || "null");
    return saved && saved.salt && saved.hash ? saved : null;
  } catch (error) {
    return null;
  }
}

export function isLockOn() {
  return Boolean(readLock());
}

async function hashPin(pin, salt) {
  if (!window.crypto || !window.crypto.subtle) throw new Error("App lock needs a secure (https) connection.");
  const bytes = new TextEncoder().encode(`${salt}:${pin}`);
  const digest = await window.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function pinMatches(pin) {
  const saved = readLock();
  return Boolean(saved) && (await hashPin(pin, saved.salt)) === saved.hash;
}

/* ---------- The lock screen ---------- */

export function lockNow() {
  if (!state.user || !isLockOn()) return;
  $("#lock-pin").value = "";
  $("#lock-error").textContent = "";
  $("#lock-screen").classList.remove("hidden");
  setTimeout(() => $("#lock-pin").focus(), 50);
}

function unlock() {
  $("#lock-screen").classList.add("hidden");
  $("#lock-pin").value = "";
  wrongTries = 0;
}

async function submitPin(event) {
  event.preventDefault();
  const error = $("#lock-error");

  const secondsLeft = Math.ceil((waitUntil - Date.now()) / 1000);
  if (secondsLeft > 0) {
    error.textContent = `Too many tries. Wait ${secondsLeft} seconds.`;
    return;
  }

  const pin = $("#lock-pin").value;
  try {
    if (await pinMatches(pin)) {
      unlock();
      return;
    }
  } catch (problem) {
    console.error(problem);
    error.textContent = problem.message;
    return;
  }

  wrongTries += 1;
  $("#lock-pin").value = "";
  if (wrongTries >= MAX_TRIES) {
    wrongTries = 0;
    waitUntil = Date.now() + WAIT_SECONDS * 1000;
    error.textContent = `Too many tries. Wait ${WAIT_SECONDS} seconds.`;
  } else {
    error.textContent = "That PIN is not right.";
  }
}

async function forgotPin() {
  // Signing out removes the lock from this device. The person signs in again with their account.
  safeRemove(LOCK_KEY);
  unlock();
  await supabase.auth.signOut();
}

export function bindAppLock() {
  $("#lock-form").addEventListener("submit", submitPin);
  $("#lock-signout").addEventListener("click", forgotPin);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt && Date.now() - hiddenAt > AWAY_SECONDS * 1000) {
      lockNow();
    }
  });
}

/* ---------- Turning it on and off (Settings) ---------- */

function pinField(label) {
  const field = el("label", "field");
  const input = el("input");
  input.type = "password";
  input.inputMode = "numeric";
  input.pattern = "[0-9]*";
  input.maxLength = 6;
  input.autocomplete = "off";
  field.append(el("span", undefined, label), input);
  return { field, input };
}

export function openTurnOnLock(onDone) {
  const first = pinField("Choose a PIN (4 to 6 digits)");
  const second = pinField("Type it again");
  const message = el("p", "form-error");
  const form = el("div", "modal-form");
  form.append(first.field, second.field, message);

  openModal({
    title: "Turn on App lock",
    body: form,
    actions: [
      {
        label: "Turn on",
        kind: "primary",
        onClick: async () => {
          if (!/^\d{4,6}$/.test(first.input.value)) {
            message.textContent = "Use 4 to 6 digits.";
            return false;
          }
          if (first.input.value !== second.input.value) {
            message.textContent = "The two PINs are not the same.";
            return false;
          }
          try {
            const salt = crypto.randomUUID();
            safeSet(LOCK_KEY, JSON.stringify({ salt, hash: await hashPin(first.input.value, salt) }));
          } catch (error) {
            message.textContent = error.message;
            return false;
          }
          toast("App lock is on");
          onDone();
        },
      },
      { label: "Cancel", kind: "secondary" },
    ],
  });
  setTimeout(() => first.input.focus(), 50);
}

export function openTurnOffLock(onDone) {
  const current = pinField("Enter your PIN to turn it off");
  const message = el("p", "form-error");
  const form = el("div", "modal-form");
  form.append(current.field, message);

  openModal({
    title: "Turn off App lock",
    body: form,
    actions: [
      {
        label: "Turn off",
        kind: "danger",
        onClick: async () => {
          let correct = false;
          try {
            correct = await pinMatches(current.input.value);
          } catch (error) {
            message.textContent = error.message;
            return false;
          }
          if (!correct) {
            message.textContent = "That PIN is not right.";
            return false;
          }
          safeRemove(LOCK_KEY);
          toast("App lock is off");
          onDone();
        },
      },
      { label: "Cancel", kind: "secondary" },
    ],
  });
  setTimeout(() => current.input.focus(), 50);
}
