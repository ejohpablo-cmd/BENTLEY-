// The picture viewer: opens a picture on top of the chat (no new tab, no new page) and can download it.

import { $, toast } from "./helpers.js";

let currentUrl = null;
let currentName = "bentley-picture.jpg";

export function openLightbox(url, name) {
  currentUrl = url;
  currentName = name || "bentley-picture.jpg";
  $("#lightbox-image").src = url;
  $("#lightbox").classList.remove("hidden");
  $("#lightbox-close").focus();
}

export function closeLightbox() {
  $("#lightbox").classList.add("hidden");
  $("#lightbox-image").removeAttribute("src");
  currentUrl = null;
}

export function isLightboxOpen() {
  return !$("#lightbox").classList.contains("hidden");
}

function saveLink(href, filename) {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

// Downloads the picture. It is fetched first so the file saves under a proper name;
// if the browser blocks that, the storage link is asked to send it as a download instead.
async function download() {
  if (!currentUrl) return;
  try {
    const response = await fetch(currentUrl);
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const blob = await response.blob();
    const extension = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
    const objectUrl = URL.createObjectURL(blob);
    saveLink(objectUrl, currentName.replace(/\.[a-z0-9]+$/i, "") + "." + extension);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    toast("Picture saved");
  } catch (error) {
    console.error(error);
    try {
      const url = new URL(currentUrl);
      url.searchParams.set("download", currentName);
      saveLink(url.toString(), currentName);
    } catch (fallbackError) {
      toast("Couldn't download the picture.");
    }
  }
}

export function bindLightbox() {
  $("#lightbox-close").addEventListener("click", closeLightbox);
  $("#lightbox-download").addEventListener("click", download);
  $("#lightbox").addEventListener("click", (event) => {
    if (event.target === $("#lightbox")) closeLightbox();
  });
}
