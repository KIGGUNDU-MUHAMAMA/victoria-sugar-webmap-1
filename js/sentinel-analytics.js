/**
 * Sentinel Analytics - Minimalist
 */

export const VSL_WMS_LAYER_IDS = [
  "TRUE_COLOR",
  "NDVI_ADVANCED",
  "MOISTURE_STRESS"
];

const LAYER_DEFS = [
  { id: "TRUE_COLOR", title: "Colour Image" },
  { id: "NDVI_ADVANCED", title: "NDVI" },
  { id: "MOISTURE_STRESS", title: "Soil Moisture" }
];

function getSentinelWmsAuxParams() {
  return { MAXCC: 40, PRIORITY: "leastCC" };
}

function getMonthTimeRange(year, month) {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0); 
  return `${startDate.toISOString().slice(0, 10)}/${endDate.toISOString().slice(0, 10)}`;
}

export function initSentinelAnalytics(opts) {
  const {
    map,
    sentinelGroup,
    cfg
  } = opts;

  if (!map || !sentinelGroup) return null;

  // 1. Base URL
  const wmsBase = cfg?.SENTINEL_HUB_WMS_BASE || "https://sh.dataspace.copernicus.eu/ogc/wms/ab8b1162-e45e-4405-9db6-aa882b920217";

  // 2. Create sub-layers and add to sentinelGroup in reverse order
  // ol-layerswitcher renders the LAST layer at the TOP of the UI.
  // We want Colour Image at the top of the UI, so we push it last.
  const layers = {};
  const sources = {};
  let activeLayerId = null;

  [...LAYER_DEFS].reverse().forEach(def => {
    const src = new ol.source.TileWMS({
      url: wmsBase,
      params: {
        LAYERS: def.id, // Fixed layer ID for this specific source
        STYLES: "default",
        VERSION: "1.1.1",
        FORMAT: "image/png",
        TRANSPARENT: true,
        TILED: true,
        TIME: "2024-01-01/2024-01-31", // dummy, updated on load
        MAXCC: "40",
        PRIORITY: "leastCC",
        SHOWLOGO: "false",
        WARNINGS: "NO"
      },
      crossOrigin: "anonymous"
    });
    sources[def.id] = src;

    const l = new ol.layer.Tile({
      title: def.title,
      type: "base", // radio button in ol-layerswitcher
      visible: false,
      opacity: 0.88,
      source: src,
      transition: 200
    });
    layers[def.id] = l;
    sentinelGroup.getLayers().push(l);

    l.on("change:visible", () => {
      if (l.getVisible()) {
        activeLayerId = def.id;
        applyWmsParams();
      } else {
        // Check if all are hidden
        const anyVisible = LAYER_DEFS.some(d => layers[d.id].getVisible());
        if (!anyVisible) activeLayerId = null;
      }
    });
  });

  // 3. DOM Elements for Settings
  const container = document.getElementById("sentinelMinimalControl");
  const yearSel = document.getElementById("smcYear");
  const monthSlider = document.getElementById("smcMonth");
  const monthLabel = document.getElementById("smcMonthLabel");
  const spinner = document.getElementById("smcSpinner");
  
  // Hide the layer selector in the old panel since we now use layer switcher
  const layerSelRow = document.getElementById("smcLayer")?.closest(".form-group");
  if (layerSelRow) layerSelRow.style.display = "none";
  
  // Hide the back button in the old panel
  const backBtn = document.getElementById("smcBackBtn");
  if (backBtn) backBtn.style.display = "none";

  const closeBtn = document.getElementById("smcCloseBtn");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      if (container) container.hidden = true;
    });
  }

  // Container is styled by CSS class vsl-sentinel-settings-popup

  let pendingTiles = 0;
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  let userSetDate = false;

  const now = new Date();
  if (yearSel) {
    if (![...yearSel.options].find(o => o.value === String(now.getFullYear()))) {
      const opt = document.createElement("option");
      opt.value = String(now.getFullYear());
      opt.textContent = String(now.getFullYear());
      yearSel.insertBefore(opt, yearSel.firstChild);
    }
    yearSel.value = String(now.getFullYear());
  }
  
  if (monthSlider) {
    monthSlider.value = String(now.getMonth() + 1);
    if (monthLabel) monthLabel.textContent = monthNames[now.getMonth()];
  }

  function updateTileSpinner() {
    if (!spinner) return;
    spinner.hidden = pendingTiles <= 0;
  }

  Object.values(sources).forEach(src => {
    src.on("tileloadstart", () => { pendingTiles += 1; updateTileSpinner(); });
    src.on("tileloadend", () => { pendingTiles = Math.max(0, pendingTiles - 1); updateTileSpinner(); });
    src.on("tileloaderror", () => { pendingTiles = Math.max(0, pendingTiles - 1); updateTileSpinner(); });
  });

  function applyWmsParams() {
    if (!activeLayerId) return;

    const yr = yearSel ? parseInt(yearSel.value, 10) : now.getFullYear();
    const mo = monthSlider ? parseInt(monthSlider.value, 10) : now.getMonth() + 1;
    
    const aux = getSentinelWmsAuxParams();

    Object.entries(sources).forEach(([id, src]) => {
      const wmsP = {
        LAYERS: id, // Keep the correct layer ID for each source
        STYLES: "default",
        SHOWLOGO: "false",
        WARNINGS: "NO",
        MAXCC: String(aux.MAXCC),
        PRIORITY: aux.PRIORITY,
        FORMAT: "image/png",
        TRANSPARENT: "true"
      };

      if (userSetDate) {
        wmsP.TIME = getMonthTimeRange(yr, mo);
      } else {
        // By default, search the last 3 months for the clearest image
        // to guarantee a beautiful preview without user intervention.
        // e.g. "2024-03-01/2024-06-01"
        const start = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
        wmsP.TIME = `${start.toISOString().slice(0, 10)}/${now.toISOString().slice(0, 10)}`;
      }

      src.updateParams(wmsP);
      if (typeof src.refresh === "function") src.refresh();
    });
  }

  if (yearSel) {
    yearSel.addEventListener("change", () => {
      userSetDate = true;
      applyWmsParams();
    });
  }
  if (monthSlider) {
    monthSlider.addEventListener("input", () => {
      if (monthLabel) monthLabel.textContent = monthNames[parseInt(monthSlider.value, 10) - 1];
    });
    monthSlider.addEventListener("change", () => {
      userSetDate = true;
      applyWmsParams();
    });
  }

  // 4. Inject Gear Icon
  function injectSettingsGear() {
    const labels = document.querySelectorAll(".layer-switcher label");
    labels.forEach(label => {
      if (label.textContent.includes("SENTINEL") && !label.querySelector('.vsl-sentinel-gear')) {
        const gear = document.createElement("i");
        gear.className = "fas fa-cog vsl-sentinel-gear";
        gear.style.cursor = "pointer";
        gear.style.marginLeft = "8px";
        gear.style.color = "#666";
        gear.title = "Settings";
        gear.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (container) {
            container.hidden = !container.hidden;
          }
        });
        label.appendChild(gear);
      }
    });
  }

  const lsPanel = document.querySelector(".layer-switcher");
  if (lsPanel) {
    const observer = new MutationObserver(() => injectSettingsGear());
    observer.observe(lsPanel, { childList: true, subtree: true });
    injectSettingsGear();
  } else {
    // If not rendered yet, poll a few times
    let attempts = 0;
    const interval = setInterval(() => {
      const p = document.querySelector(".layer-switcher");
      if (p) {
        clearInterval(interval);
        const observer = new MutationObserver(() => injectSettingsGear());
        observer.observe(p, { childList: true, subtree: true });
        injectSettingsGear();
      }
      if (attempts++ > 10) clearInterval(interval);
    }, 500);
  }

  return { close: () => { if (container) container.hidden = true; } };
}
