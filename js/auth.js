// Sign in / create account screen.

import { supabase, signInWithGoogle } from "./api.js";
import { $ } from "./helpers.js";

let mode = "signin"; // "signin" or "signup"
let submitting = false;

// The looping background video plays on the sign in / sign up screen only.
function playAuthVideo(play) {
  const video = $("#auth-video");
  if (!video) return;
  video.muted = true; // phones only allow autoplay when muted
  if (play) {
    const started = video.play();
    if (started && started.catch) started.catch(() => {});
  } else {
    video.pause();
  }
}

export function showAuthScreen() {
  document.documentElement.setAttribute("data-screen", "auth"); // no wood wallpaper here
  $("#app").classList.add("hidden");
  $("#auth-screen").classList.remove("hidden");
  playAuthVideo(true);
}

export function showAppScreen() {
  document.documentElement.setAttribute("data-screen", "app");
  $("#auth-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  playAuthVideo(false);
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
  setMessage("");
}

async function submit(event) {
  event.preventDefault();
  if (submitting) return;

  const email = $("#auth-email").value.trim();
  const password = $("#auth-password").value;
  if (!email || password.length < 6) {
    setMessage("Enter a valid email and a password of at least 6 characters.");
    return;
  }

  submitting = true;
  $("#auth-submit").disabled = true;
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
    $("#auth-submit").disabled = false;
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

  // Show / hide password
  const passwordInput = $("#auth-password");
  const toggle = $("#auth-password-toggle");
  toggle.addEventListener("click", () => {
    const show = passwordInput.type === "password";
    passwordInput.type = show ? "text" : "password";
    toggle.classList.toggle("showing", show);
    toggle.setAttribute("aria-pressed", String(show));
    toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
    passwordInput.focus();
  });
}
