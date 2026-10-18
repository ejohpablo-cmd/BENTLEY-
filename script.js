// Bentley starts here. This file only connects the pieces; the real work lives in js/.
//
//   js/chat.js        the Chat page (messages, send, stop, edit, greeting)
//   js/typewriter.js  writes new replies out letter by letter
//   js/usage.js       the rest countdown after the 4 pictures / 3M tokens limit
//   js/history.js     the History page (open, pin, rename, delete)
//   js/settings.js    the Settings page (+ legal.js for the policy and terms, applock.js for the PIN)
//   js/profile.js     the Profile page and profile photo
//   js/auth.js        sign in / create account / Google
//   js/session.js     what happens after signing in or out
//   js/photos.js      photos: camera, gallery, preview strip and showing photos in the chat
//   js/lightbox.js    the picture viewer with Download
//   js/keyboard.js    keeps the on-screen keyboard overlaying the app
//   js/share.js       the share sheet
//   js/api.js         Supabase: login, the Edge Functions, photo storage
//   js/markdown.js    turns Bentley's markdown into safe HTML

import { $ } from "./js/helpers.js";
import { supabase } from "./js/api.js";
import { watchSystemTheme } from "./js/appearance.js";
import { attachFallback } from "./js/avatars.js";
import { bindAuth, showAuthScreen } from "./js/auth.js";
import { bindChat } from "./js/chat.js";
import { bindHistory } from "./js/history.js";
import { bindProfile } from "./js/profile.js";
import { bindNavigation } from "./js/navigation.js";
import { bindKeyboard } from "./js/keyboard.js";
import { bindLightbox, closeLightbox, isLightboxOpen } from "./js/lightbox.js";
import { bindAppLock } from "./js/applock.js";
import { closeModal, isModalOpen } from "./js/modal.js";
import { handleSession } from "./js/session.js";

function bindOverlays() {
  $("#modal").addEventListener("click", (event) => {
    if (event.target === $("#modal")) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (isLightboxOpen()) closeLightbox();
    else if (isModalOpen()) closeModal();
  });
}

async function init() {
  // The logos written in index.html also fall back to a "B" badge if benny.png is missing.
  document.querySelectorAll("img.bentley-img").forEach(attachFallback);

  bindAuth();
  bindNavigation();
  bindChat();
  bindHistory();
  bindProfile();
  bindOverlays();
  bindLightbox();
  bindAppLock();
  bindKeyboard();
  watchSystemTheme();

  if (!supabase) {
    $("#config-error").classList.remove("hidden");
    $("#auth-submit").disabled = true;
    $("#google-btn").disabled = true;
    showAuthScreen();
    return;
  }

  const { data } = await supabase.auth.getSession();
  await handleSession(data.session);

  supabase.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_IN" || event === "SIGNED_OUT") {
      // Deferred so Supabase calls are not awaited inside the auth callback.
      setTimeout(() => handleSession(session), 0);
    }
  });
}

init();
