// Switching between the Chat, History, Settings and Profile pages.

import { state } from "./state.js";

const pageHooks = {};

// Lets a page run code each time it is shown (for example, History reloads its list).
export function onPageShown(name, callback) {
  pageHooks[name] = callback;
}

export function showTab(name) {
  state.tab = name;
  document.documentElement.setAttribute("data-tab", name); // the wood wallpaper is only for Chat

  document.querySelectorAll(".page").forEach((page) => {
    page.classList.toggle("active", page.id === `page-${name}`);
  });

  document.querySelectorAll(".nav-btn").forEach((button) => {
    const isActive = button.dataset.tab === name;
    button.classList.toggle("active", isActive);
    if (isActive) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  if (pageHooks[name]) pageHooks[name]();
}

export function bindNavigation() {
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  });
}
