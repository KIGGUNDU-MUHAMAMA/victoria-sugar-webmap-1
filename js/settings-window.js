/**
 * settings-window.js — the Settings window (windows/settings-modal.html),
 * opened from the Settings item in the account dropdown.
 *
 * It explains what the app remembers (js/user-settings.js) and offers one
 * action, Restore Default Settings: forget all of it and reload, so the map
 * comes back exactly as a first-time visitor sees it.
 */

import { hasSavedSettings, clearSettings, suspendSaving } from "./user-settings.js";

export function initSettingsWindow({ confirmDanger }) {
  const overlay = document.getElementById("settingsOverlay");
  const openBtn = document.getElementById("profileDropdownSettingsBtn");
  const dropdown = document.getElementById("profileDropdown");
  const statusEl = document.getElementById("settingsStatus");
  const restoreBtn = document.getElementById("settingsRestoreBtn");
  if (!overlay || !openBtn || !restoreBtn) return;

  function refreshStatus() {
    const saved = hasSavedSettings();
    if (statusEl) {
      statusEl.textContent = saved
        ? "Your settings are being remembered."
        : "Nothing remembered yet — the site is using its original settings.";
    }
    restoreBtn.disabled = !saved;
  }

  function open() {
    if (dropdown) dropdown.hidden = true;
    refreshStatus();
    overlay.hidden = false;
  }
  function close() {
    overlay.hidden = true;
  }

  openBtn.addEventListener("click", open);
  document.getElementById("settingsCloseBtn")?.addEventListener("click", close);
  document.getElementById("settingsDoneBtn")?.addEventListener("click", close);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) close();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !overlay.hidden) close();
  });

  restoreBtn.addEventListener("click", async () => {
    const confirmed = await confirmDanger({
      title: "Restore Default Settings?",
      message: "This forgets your saved map position, layers, print settings and last search, and reloads the map with the original site settings.",
      confirmLabel: "Restore"
    });
    if (!confirmed) return;
    // Stop any write already queued from landing after the wipe, then start
    // over from a clean page — a reload is what applies every default at once.
    suspendSaving();
    clearSettings();
    window.location.reload();
  });
}
