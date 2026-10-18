// Builds the round pictures: Bentley's logo and the user's profile photo.

import { state, BENTLEY_AVATAR } from "./state.js";
import { el } from "./helpers.js";

// Shown if benny.png is missing, so the app never displays a broken image.
const FALLBACK_AVATAR =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
      '<rect width="64" height="64" fill="#C4B5FD"/>' +
      '<text x="32" y="44" font-family="Arial, sans-serif" font-size="34" font-weight="500" ' +
      'text-anchor="middle" fill="#6D28D9">B</text></svg>'
  );

// Swaps in the fallback picture if the image fails to load.
export function attachFallback(image) {
  const useFallback = () => {
    if (image.getAttribute("src") !== FALLBACK_AVATAR) image.src = FALLBACK_AVATAR;
  };
  image.addEventListener("error", useFallback, { once: true });
  if (image.complete && image.naturalWidth === 0 && image.getAttribute("src")) useFallback();
}

// size: "sm" | "md" | "lg"
export function buildBentleyAvatar(size) {
  const image = document.createElement("img");
  image.className = `avatar bentley-img ${size}`;
  image.alt = "Bentley";
  image.src = BENTLEY_AVATAR;
  attachFallback(image);
  return image;
}

// Shows the profile photo, or the first letter of the name when there is no photo.
// previewUrl lets the edit screen show a newly chosen photo before it is saved.
export function buildUserAvatar(size, previewUrl) {
  const wrapper = el("div", `avatar user-avatar ${size}`);
  const profile = state.profile || {};
  const url = previewUrl || profile.avatar_url;
  const initial = (profile.display_name || "?").trim().charAt(0).toUpperCase() || "?";

  if (url && /^(https:|blob:)/i.test(url)) {
    const image = document.createElement("img");
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      image.remove();
      wrapper.textContent = initial;
    });
    image.src = url;
    wrapper.append(image);
  } else {
    wrapper.textContent = initial;
  }
  return wrapper;
}
