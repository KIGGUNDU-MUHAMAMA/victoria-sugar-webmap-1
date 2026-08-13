/**
 * unified-menu.js
 * Controls the Floating Action Button (FAB) and Unified Action Menu (UAM) panel.
 * Wires up tab switching, file-name display, and dropzone.
 */

export function initUnifiedMenu({ map, supabase, cfg, setStatus, statusEl, blocksSource, parcelsSource, blocksLayer, parcelsLayer, surveyPreviewSnapSources, stopActiveTool }) {

  const fabBtn   = document.getElementById("toolsTopBtn") || document.getElementById("toolsFabBtn");
  const overlay  = document.getElementById("unifiedActionMenu");
  const closeBtn = document.getElementById("uamCloseBtn");
  // Selected by [data-uam-tab]/[data-uam-panel]/[data-uam-actions] attributes
  // rather than a dedicated class, since the nav buttons now just use the
  // shared .search-tab look (same as Modify/Select's vertical tabs).
  const navBtns      = overlay?.querySelectorAll("[data-uam-tab]");
  const tabs         = overlay?.querySelectorAll("[data-uam-panel]");
  const actionGroups = overlay?.querySelectorAll("[data-uam-actions]");

  if (!fabBtn || !overlay) return;

  // ── Open / Close ──────────────────────────────────────────────
  function openMenu() {
    // Close other panels at DOM level to prevent overlap
    const measurePanel = document.getElementById("measurePanel");
    if (measurePanel) measurePanel.hidden = true;

    const parcelStatusPanel = document.getElementById("parcelStatusPanel");
    if (parcelStatusPanel) {
      parcelStatusPanel.hidden = true;
      parcelStatusPanel.setAttribute("aria-hidden", "true");
    }
    const parcelStatusBtn = document.getElementById("parcelStatusBtn");
    parcelStatusBtn?.classList.remove("active");

    // Also call the function if available
    if (typeof window.closeParcelStatusPanel === "function") window.closeParcelStatusPanel();

    // Survey now docks in the same .map-left-stack column as Search
    // (see windows/survey-panel.html) instead of floating as its own
    // overlay, so Search needs to be explicitly closed here too.
    if (typeof window.closeSearchPanel === "function") window.closeSearchPanel();

    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    fabBtn.classList.add("uam-open");
    fabBtn.setAttribute("aria-expanded", "true");
    // Ensure first tab is shown if none active
    const anySelected = [...navBtns].some(b => b.getAttribute("aria-selected") === "true");
    if (!anySelected) switchTab("import");
  }

  // window.vslConfirmSurveyClose (set by js/survey-edit.js) is a loosely-
  // coupled guard, same "expose a global hook, call it if present" pattern
  // as window.closeSearchPanel/window.closeParcelStatusPanel above — lets
  // an active, unsaved Edit-tab session block navigation away from it
  // (closing this window, or switching to any other tab) until the user
  // confirms discarding it. Resolves true immediately (no popup) whenever
  // there's nothing to lose, so this is a no-op the vast majority of the
  // time.
  async function confirmLeaveIfEditing() {
    if (typeof window.vslConfirmSurveyClose !== "function") return true;
    return await window.vslConfirmSurveyClose();
  }

  async function closeMenu() {
    if (!(await confirmLeaveIfEditing())) return;
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    fabBtn.classList.remove("uam-open");
    fabBtn.setAttribute("aria-expanded", "false");
  }

  // Expose globally so other modules can close it to prevent overlap
  window.closeMenu = closeMenu;

  fabBtn.addEventListener("click", () => {
    if (overlay.hidden) openMenu(); else closeMenu();
  });

  closeBtn?.addEventListener("click", closeMenu);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeMenu();
  });

  // ── Tab switching ─────────────────────────────────────────────
  async function switchTab(tabId) {
    // Re-clicking the tab that's already active isn't "leaving" it — skip
    // the confirm-discard guard entirely, otherwise an in-progress Edit
    // session with unsaved changes would spuriously prompt every time its
    // own nav button is clicked again.
    const current = [...navBtns].find(b => b.getAttribute("aria-selected") === "true")?.dataset.uamTab;
    if (current === tabId) return;
    if (!(await confirmLeaveIfEditing())) return;
    navBtns.forEach(btn => {
      const active = btn.dataset.uamTab === tabId;
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
    });
    tabs.forEach(panel => {
      panel.hidden = panel.dataset.uamPanel !== tabId;
    });
    // Footer's action-button group swaps to match the active tab, same as
    // its body panel does above (see [data-uam-actions] in survey-panel.html).
    actionGroups.forEach(group => {
      group.hidden = group.dataset.uamActions !== tabId;
    });
  }

  navBtns.forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.uamTab));
  });

  window.openUamTab = function(tabId) {
    openMenu();
    switchTab(tabId);
  };

  // Default to Import on load
  switchTab("import");

  // ── File input label update ───────────────────────────────────
  function bindFileLabel(inputId, labelId) {
    const input = document.getElementById(inputId);
    const label = document.getElementById(labelId);
    if (!input || !label) return;
    input.addEventListener("change", () => {
      label.textContent = input.files?.[0]?.name ?? "Choose a file or drop it here…";
    });
  }
  bindFileLabel("surveyFileInput", "surveyFileName");

  // ── Draw tab: wire draw panel buttons to map-app.js ───────────
  // map-app.js already queries these IDs on init; nothing extra needed here
  // because drawingPanelBtn (hidden) is still in the DOM for panelButtons binding.
  // We just need to keep the panel itself open without the old aside.
  // The UAM tab IS the draw panel — we keep the legacy panelHost but
  // just never show it; the new UAM handles the UI while map-app still
  // responds to button clicks via event listeners it already set up.

  return { openMenu, closeMenu, switchTab };
}
