/**
 * unified-menu.js
 * Controls the Floating Action Button (FAB) and Unified Action Menu (UAM) panel.
 * Wires up tab switching, file-name display, dropzone, and Rover launch.
 */

export function initUnifiedMenu({ map, supabase, cfg, setStatus, statusEl, blocksSource, parcelsSource, blocksLayer, parcelsLayer, surveyPreviewSnapSources, stopActiveTool }) {

  const fabBtn   = document.getElementById("toolsFabBtn");
  const overlay  = document.getElementById("unifiedActionMenu");
  const closeBtn = document.getElementById("uamCloseBtn");
  const navBtns  = overlay?.querySelectorAll(".uam-nav-btn");
  const tabs     = overlay?.querySelectorAll(".uam-tab");

  if (!fabBtn || !overlay) return;

  // ── Open / Close ──────────────────────────────────────────────
  function openMenu() {
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
    fabBtn.classList.add("uam-open");
    fabBtn.setAttribute("aria-expanded", "true");
    // Ensure first tab is shown if none active
    const anySelected = [...navBtns].some(b => b.getAttribute("aria-selected") === "true");
    if (!anySelected) switchTab("import");
  }

  function closeMenu() {
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    fabBtn.classList.remove("uam-open");
    fabBtn.setAttribute("aria-expanded", "false");
  }

  fabBtn.addEventListener("click", () => {
    if (overlay.hidden) openMenu(); else closeMenu();
  });

  closeBtn?.addEventListener("click", closeMenu);

  // Close on backdrop click (outside .uam-shell)
  overlay.addEventListener("click", (e) => {
    if (!e.target.closest(".uam-shell")) closeMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) closeMenu();
  });

  // ── Tab switching ─────────────────────────────────────────────
  function switchTab(tabId) {
    navBtns.forEach(btn => {
      const active = btn.dataset.uamTab === tabId;
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    tabs.forEach(panel => {
      panel.hidden = panel.dataset.uamPanel !== tabId;
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
      label.textContent = input.files?.[0]?.name ?? "Choose file…";
    });
  }
  bindFileLabel("surveyFileInput", "surveyFileName");
  bindFileLabel("droneFileInput",  "droneFileName");

  // Update surveyFileInput to also update accept based on importFormatSelect
  const importFormatSel = document.getElementById("importFormatSelect");
  const surveyFileInput = document.getElementById("surveyFileInput");
  const ACCEPT_MAP = {
    csv:     ".csv,text/csv",
    dxf:     ".dxf",
    kml:     ".kml",
    geojson: ".geojson,.json"
  };

  if (importFormatSel && surveyFileInput) {
    importFormatSel.addEventListener("change", () => {
      const fmt = importFormatSel.value;
      surveyFileInput.accept = ACCEPT_MAP[fmt] ?? ".csv,.dxf,.kml,.geojson";
    });
  }

  // ── Rover launch ──────────────────────────────────────────────
  const launchRoverBtn = document.getElementById("uamLaunchRoverBtn");
  // The rover is still activated by the hidden #vslRoverBtn. Click it programmatically.
  launchRoverBtn?.addEventListener("click", () => {
    closeMenu();
    document.getElementById("vslRoverBtn")?.click();
  });

  // ── Draw tab: wire draw panel buttons to map-app.js ───────────
  // map-app.js already queries these IDs on init; nothing extra needed here
  // because drawingPanelBtn (hidden) is still in the DOM for panelButtons binding.
  // We just need to keep the panel itself open without the old aside.
  // The UAM tab IS the draw panel — we keep the legacy panelHost but
  // just never show it; the new UAM handles the UI while map-app still
  // responds to button clicks via event listeners it already set up.

  return { openMenu, closeMenu, switchTab };
}
