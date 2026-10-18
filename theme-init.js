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

    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.setAttribute("content", theme === "dark" ? "#120D24" : "#FAF7FF");
  } catch (error) {
    // Storage is unavailable: keep the defaults written in index.html.
  }
})();
