// Safety net for a blank page: if the app could not start (for example the internet is off, or the local
// server sends .js files with the wrong type), this shows a clear message instead of an empty screen.
// It is a normal script (not a module) so it still runs when the app's own scripts fail to load.

(function watchStartup() {
  const WAIT_MS = 8000; // how long the app gets to show the sign in screen or the chat before we speak up
  const startedAt = Date.now();
  let banner = null;

  function appIsShowing() {
    const auth = document.getElementById("auth-screen");
    const app = document.getElementById("app");
    return Boolean((auth && !auth.classList.contains("hidden")) || (app && !app.classList.contains("hidden")));
  }

  function showBanner() {
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "config-error"; // reuses the existing warning style from style.css
      banner.setAttribute("role", "alert");
      banner.textContent =
        "Axelvon couldn't start. Check that you are online, that your local server is running from this folder, then refresh the page.";
      document.body.appendChild(banner);
    }
  }

  function check() {
    if (appIsShowing()) {
      if (banner) banner.remove();
      banner = null;
    } else if (Date.now() - startedAt >= WAIT_MS) {
      showBanner();
    }
  }

  // A script that fails to download (or is sent with the wrong type) is reported straight away.
  window.addEventListener(
    "error",
    (event) => {
      if (event.target && event.target.tagName === "SCRIPT") showBanner();
    },
    true
  );

  document.addEventListener("DOMContentLoaded", () => setInterval(check, 1000));
})();
