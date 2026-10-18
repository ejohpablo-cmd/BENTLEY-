// Sign in / create account screen.

import { supabase, signInWithGoogle } from "./api.js";
import { $ } from "./helpers.js";

let mode = "signin"; // "signin" or "signup"
let submitting = false;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/; // a simple "name@site.com" check; the server checks it again

// The background video only plays while the sign in screen is showing.
function playBackgroundVideo(shouldPlay) {
  const video = $("#auth-video");
  if (!video) return;
  if (shouldPlay) video.play().catch(() => {}); // a blocked or missing video is fine: the plain background shows
  else video.pause();
}

export function showAuthScreen() {
  document.documentElement.setAttribute("data-screen", "auth"); // no wood wallpaper on this screen
  $("#app").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
  playBackgroundVideo(true);
}

export function showAppScreen() {
  document.documentElement.setAttribute("data-screen", "app");
  $("#auth-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  playBackgroundVideo(false);
}

function setMessage(text, isGood = false) {
  const node = $("#auth-message");
  node.textContent = text;
  node.classList.toggle("ok", isGood);
}

function setMode(nextMode) {
  mode = nextMode;
  const signingIn = mode === "signin";

  $("#auth-subtitle").textContent = signingIn ? "Sign in to talk to Axelvon" : "Create your Axelvon account";
  $("#auth-submit").textContent = signingIn ? "Sign in" : "Create account";
  $("#google-btn-label").textContent = signingIn ? "Continue with Google" : "Sign up with Google";
  $("#auth-toggle").textContent = signingIn ? "New here? Create an account" : "Already have an account? Sign in";
  $("#auth-password").setAttribute("autocomplete", signingIn ? "current-password" : "new-password");
  $("#auth-password").setAttribute("placeholder", signingIn ? "Your password" : "At least 6 characters");
  $("#auth-confirm-field").classList.toggle("hidden", signingIn);
  $("#auth-hint").classList.toggle("hidden", signingIn);
  $("#auth-terms").classList.toggle("hidden", signingIn);
  $("#auth-confirm").value = "";
  setMessage("");
}

async function submit(event) {
  event.preventDefault();
  if (submitting) return;

  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  if (!EMAIL_PATTERN.test(email)) {
    setMessage("Enter a valid email address.");
    $("#auth-email").focus();
    return;
  }
  if (password.length < 6) {
    setMessage("Your password needs at least 6 characters.");
    $("#auth-password").focus();
    return;
  }
  if (mode === "signup" && $("#auth-confirm").value !== password) {
    setMessage("The two passwords don't match.");
    $("#auth-confirm").focus();
    return;
  }

  submitting = true;
  const submitButton = $("#auth-submit");
  submitButton.disabled = true;
  submitButton.textContent = mode === "signup" ? "Creating account…" : "Signing in…";
  setMessage("");

  try {
    if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) setMessage(error.message);
      else if (!data.session) setMessage("Check your email to confirm your account, then sign in.", true);
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMessage(error.message);
    }
  } catch (error) {
    console.error(error);
    setMessage("Something went wrong. Please try again.");
  } finally {
    submitting = false;
    submitButton.disabled = false;
    submitButton.textContent = mode === "signup" ? "Create account" : "Sign in";
  }
}

// Google sign in and Google sign up are the same step: Google creates the account the first time.
async function continueWithGoogle() {
  const button = $("#google-btn");
  button.disabled = true;
  setMessage("");
  try {
    await signInWithGoogle(); // the page leaves for Google and comes back signed in
  } catch (error) {
    console.error(error);
    setMessage("Google sign in isn't available yet. Please use your email for now.");
    button.disabled = false;
  }
}

export function bindAuth() {
  setMode("signin");
  $("#google-btn").addEventListener("click", continueWithGoogle);
  $("#auth-form").addEventListener("submit", submit);
  $("#auth-toggle").addEventListener("click", () => setMode(mode === "signin" ? "signup" : "signin"));

  // Show / hide password (also reveals the "confirm" box when it is on screen)
  const passwordInput = $("#auth-password");
  const confirmInput = $("#auth-confirm");
  const toggle = $("#auth-password-toggle");
  toggle.addEventListener("click", () => {
    const show = passwordInput.type === "password";
    passwordInput.type = show ? "text" : "password";
    confirmInput.type = show ? "text" : "password";
    toggle.classList.toggle("showing", show);
    toggle.setAttribute("aria-pressed", String(show));
    toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
    passwordInput.focus();
  });
}
