// Photos in the chat: taking or choosing them, the preview strip above the input box,
// and showing photos (yours and the ones Axelvon makes) inside messages.
//
// Photos are shrunk and saved as JPG before they leave the phone. They live in a private
// storage folder, so they are shown through short-lived links.

import { state } from "./state.js";
import { $, el, toast } from "./helpers.js";
import { openModal } from "./modal.js";
import { getPhotoUrls } from "./api.js";
import { openLightbox } from "./lightbox.js";

export const MAX_PHOTOS = 4;
const MAX_SIDE = 1280; // the longest side, in pixels
const JPEG_QUALITY = 0.85;
const LINK_SECONDS = 3600;
const LINK_MARGIN_MS = 60000; // a link is renewed a minute before it runs out

let pending = []; // photos waiting to be sent: { blob, url }
let onChange = () => {};
const linkCache = new Map(); // path -> { url, expires }

/* ---------- Shrinking a photo ---------- */

async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The photo could not be processed."))),
      "image/jpeg",
      JPEG_QUALITY
    );
  });
}

/* ---------- Photos waiting to be sent ---------- */

export function pendingCount() {
  return pending.length;
}

// The photos to send now. They stay in the strip until releasePending() is called.
export function pendingPhotos() {
  return [...pending];
}

// The photos were sent: empty the strip but keep the previews alive, because the chat still shows them.
export function releasePending() {
  pending = [];
  renderStrip();
}

// The photos were dropped: empty the strip and free the previews.
export function clearPending() {
  pending.forEach((photo) => URL.revokeObjectURL(photo.url));
  releasePending();
}

function removePending(photo) {
  URL.revokeObjectURL(photo.url);
  pending = pending.filter((other) => other !== photo);
  renderStrip();
}

function renderStrip() {
  const strip = $("#photo-strip");
  strip.replaceChildren();
  strip.classList.toggle("hidden", pending.length === 0);

  pending.forEach((photo) => {
    const item = el("div", "pending-photo");
    const image = el("img");
    image.src = photo.url;
    image.alt = "Photo to send";

    const remove = el("button", "photo-remove");
    remove.type = "button";
    remove.setAttribute("aria-label", "Remove photo");
    remove.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    remove.addEventListener("click", () => removePending(photo));

    item.append(image, remove);
    strip.append(item);
  });
  onChange();
}

async function addFiles(fileList) {
  let failed = false;
  for (const file of Array.from(fileList)) {
    if (pending.length >= MAX_PHOTOS) {
      toast(`You can send up to ${MAX_PHOTOS} photos at once.`);
      break;
    }
    if (!file.type.startsWith("image/")) {
      failed = true;
      continue;
    }
    try {
      const blob = await shrinkPhoto(file);
      pending.push({ blob, url: URL.createObjectURL(blob) });
      renderStrip();
    } catch (error) {
      console.error(error);
      failed = true;
    }
  }
  if (failed) toast("Couldn't use that photo. Try a JPG or PNG.");
}

/* ---------- The + menu ---------- */

function openAttachMenu() {
  if (state.editingId) return toast("Photos can't be added while editing.");
  if (state.uploading) return;
  if (pending.length >= MAX_PHOTOS) return toast(`You can send up to ${MAX_PHOTOS} photos at once.`);

  // The pickers are opened straight from the tap, which phones require.
  openModal({
    title: "Add a photo",
    actions: [
      { label: "Take a photo", kind: "primary", onClick: () => $("#camera-input").click() },
      { label: "Choose from gallery", kind: "secondary", onClick: () => $("#gallery-input").click() },
      { label: "Cancel", kind: "secondary" },
    ],
  });
}

// onPhotosChanged runs whenever the strip changes, so the Send button can follow it.
export function bindPhotos(onPhotosChanged) {
  onChange = onPhotosChanged;
  $("#attach-btn").addEventListener("click", openAttachMenu);

  ["#camera-input", "#gallery-input"].forEach((selector) => {
    const input = $(selector);
    input.addEventListener("change", async () => {
      const files = Array.from(input.files || []);
      input.value = ""; // lets the same photo be chosen again
      await addFiles(files);
    });
  });
}

/* ---------- Showing photos in messages ---------- */

// A photo sent from this phone is shown from the phone's own copy straight away.
export function rememberLocalPhoto(path, url) {
  linkCache.set(path, { url, expires: Infinity });
}

// Returns { path: address } for the paths, asking the server only for the ones not known yet.
async function photoLinks(paths) {
  const now = Date.now();
  const missing = [...new Set(paths)].filter((path) => {
    const known = linkCache.get(path);
    return !known || known.expires < now;
  });

  if (missing.length > 0) {
    try {
      const urls = await getPhotoUrls(missing, LINK_SECONDS);
      Object.entries(urls).forEach(([path, url]) => {
        linkCache.set(path, { url, expires: now + LINK_SECONDS * 1000 - LINK_MARGIN_MS });
      });
    } catch (error) {
      console.error(error);
    }
  }

  const links = {};
  paths.forEach((path) => {
    const known = linkCache.get(path);
    if (known) links[path] = known.url;
  });
  return links;
}

// Gets the links for every photo in a list of messages in one go, before they are drawn.
export async function warmPhotoLinks(messages) {
  const paths = messages.flatMap((message) => message.images || []);
  if (paths.length > 0) await photoLinks(paths);
}

// The photos of one message. Tapping a photo opens it full size on top of the chat (with a Download button).
export function buildPhotos(paths) {
  const box = el("div", `msg-photos ${paths.length === 1 ? "single" : "multi"}`);
  const parts = paths.map((path) => {
    const button = el("button", "photo-link");
    button.type = "button";
    button.setAttribute("aria-label", "Open picture");
    const image = el("img", "photo");
    image.alt = "Photo";
    image.decoding = "async";
    button.append(image);
    box.append(button);
    button.addEventListener("click", () => {
      if (image.src) openLightbox(image.src, path.split("/").pop());
    });
    return { button, image };
  });

  photoLinks(paths).then((links) => {
    parts.forEach(({ button, image }, index) => {
      const url = links[paths[index]];
      if (url) {
        image.src = url;
      } else {
        image.alt = "Photo unavailable";
        button.disabled = true;
      }
    });
  });
  return box;
}
