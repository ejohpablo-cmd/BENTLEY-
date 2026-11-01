// Applies the saved appearance before the first paint, so the page never flashes the wrong theme.
(function applySavedAppearance() {
  try {
    const root = document.documentElement;
    const savedTheme = localStorage.getItem("bentley_theme") || "system";
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

    let theme = savedTheme === "system" ? (prefersDark ? "dark" : "light") : savedTheme;
    if (theme !== "light" && theme !== "dark") theme = "light";

    root.setAttribute("data-theme", theme);
    root.setAttribute("data-bubble", localStorage.getItem("bentley_bubble") || "rounded");
    root.setAttribute("data-font", localStorage.getItem("bentley_font") || "medium");
    root.setAttribute("data-animations", localStorage.getItem("bentley_animations") || "on");

    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute("content", theme === "dark" ? "#000000" : "#FFFFFF");
  } catch (error) {
    // Storage is unavailable: keep the defaults written in index.html.
  }
})();
