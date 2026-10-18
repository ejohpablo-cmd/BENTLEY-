// Theme (light, dark or follow the phone) and chat bubble style, applied to the whole page.

import { state } from "./state.js";
import { safeSet } from "./helpers.js";

const THEME_COLORS = { light: "#FAF7FF", dark: "#130F22" };

function resolveTheme(preference) {
  if (preference === "light" || preference === "dark") return preference;
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

export function applyAppearance() {
  const root = document.documentElement;
  const theme = resolveTheme(state.settings.theme);

  root.setAttribute("data-theme", theme);
  root.setAttribute("data-bubble", state.settings.bubble_style || "rounded");
  // Remembered on this phone so the next start paints the right colours straight away (see theme-init.js).
  safeSet("bentley_theme", state.settings.theme);
  safeSet("bentley_bubble", state.settings.bubble_style || "rounded");

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute("content", THEME_COLORS[theme]);
}

// Re-applies the theme when the phone switches between light and dark (only for the "System" option).
export function watchSystemTheme() {
  if (!window.matchMedia) return;
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  if (!query.addEventListener) return;
  query.addEventListener("change", () => {
    if (state.settings.theme === "system") applyAppearance();
  });
}
