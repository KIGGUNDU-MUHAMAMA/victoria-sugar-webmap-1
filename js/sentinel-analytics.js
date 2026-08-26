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

// Layers that show a value scale (as opposed to Colour Image, which is a
// true-colour photo, not a low→high measurement) — the colour-scale legend
// only makes sense for these.
const SCALE_LAYER_IDS = new Set(["NDVI_ADVANCED", "MOISTURE_STRESS"]);

// Cloud cover ceiling + scene selection strategy for the WMS request — fixed
// for now rather than user-configurable.
function getSentinelWmsAuxParams() {
  return { MAXCC: 30, PRIORITY: "leastCC" };
}

function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Sentinel Hub's TIME param wants a "search window", not a single day — we
// give it the days leading up to (and including) the date the user picked
// and let PRIORITY: "leastCC" choose the clearest scene in that window.
function getDateRange(dateStr) {
  const DATE_WINDOW_DAYS = 20;
  const end = new Date(`${dateStr}T00:00:00`);
  const start = new Date(end);
  start.setDate(start.getDate() - DATE_WINDOW_DAYS);
  return `${toIsoDate(start)}/${toIsoDate(end)}`;
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

  // Derived fresh from the actual layers every time, rather than trusted
  // incrementally via events — ol-layerswitcher fully tears down and
  // rebuilds its whole panel (new <ul>, new <li>s) on ANY layer visibility
  // change anywhere in the map (see renderPanel() in ol-layerswitcher.js),
  // which is also why the date row/legend row below have to be re-injected
  // via MutationObserver rather than created once. Reading real state here
  // instead of relying on a separately-maintained flag means the date
  // row/legend can't get out of sync with what's actually visible,
  // regardless of exactly how a layer gets toggled on/off.
  function getActiveLayerId() {
    for (const def of LAYER_DEFS) {
      if (layers[def.id]?.getVisible()) return def.id;
    }
    return null;
  }

  const todayStr = toIsoDate(new Date());
  let selectedDateStr = todayStr;

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
        TIME: getDateRange(selectedDateStr),
        MAXCC: "30",
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
      if (l.getVisible()) applyWmsParams();
      syncInjectedRowVisibility();
    });
  });

  let pendingTiles = 0;

  function updateTileSpinner() {
    const spinner = document.querySelector(".vsl-sentinel-date-spinner");
    if (spinner) spinner.hidden = pendingTiles <= 0;
  }

  Object.values(sources).forEach(src => {
    src.on("tileloadstart", () => { pendingTiles += 1; updateTileSpinner(); });
    src.on("tileloadend", () => { pendingTiles = Math.max(0, pendingTiles - 1); updateTileSpinner(); });
    src.on("tileloaderror", () => { pendingTiles = Math.max(0, pendingTiles - 1); updateTileSpinner(); });
  });

  function applyWmsParams() {
    if (!getActiveLayerId()) return;

    const aux = getSentinelWmsAuxParams();
    const timeRange = getDateRange(selectedDateStr);

    Object.entries(sources).forEach(([id, src]) => {
      const wmsP = {
        LAYERS: id, // Keep the correct layer ID for each source
        STYLES: "default",
        SHOWLOGO: "false",
        WARNINGS: "NO",
        MAXCC: String(aux.MAXCC),
        PRIORITY: aux.PRIORITY,
        FORMAT: "image/png",
        TRANSPARENT: "true",
        TIME: timeRange
      };

      src.updateParams(wmsP);
      if (typeof src.refresh === "function") src.refresh();
    });
  }

  // 3. Inline date picker + colour-scale legend, injected directly below the
  // SENTINEL group's layer list (i.e. below "Soil Moisture") in the
  // layer-switcher panel — replaces the old gear-icon-opens-a-separate-window
  // flow (windows/sentinel-minimal-control.html, removed).
  function findSentinelGroupList() {
    const labels = document.querySelectorAll(".layer-switcher li.group > label");
    for (const label of labels) {
      if (label.textContent.trim() === "SENTINEL") {
        return label.parentElement.querySelector(":scope > ul");
      }
    }
    return null;
  }

  // Date row only while a Sentinel layer is actually toggled on; legend row
  // only while the active layer is a value-scale layer (not Colour Image).
  // Called both right after (re-)injecting the rows AND on every
  // change:visible, so the shown/hidden state can never drift from what's
  // actually visible on the map.
  function syncInjectedRowVisibility() {
    const activeLayerId = getActiveLayerId();
    const dateRow = document.querySelector(".vsl-sentinel-date-row");
    if (dateRow) dateRow.hidden = !activeLayerId;
    const legendRow = document.querySelector(".vsl-sentinel-legend-row");
    if (legendRow) legendRow.hidden = !activeLayerId || !SCALE_LAYER_IDS.has(activeLayerId);
  }

  function buildDateRow() {
    const li = document.createElement("li");
    li.className = "vsl-sentinel-date-row";
    li.hidden = !getActiveLayerId();

    // No visible text label (it rendered as a broken checkbox-like box —
    // the layer-switcher's own `li input`/`li label` rules squash any
    // control down to a 1em box regardless of type). The input's own
    // aria-label covers accessibility instead.
    const input = document.createElement("input");
    input.type = "date";
    input.id = "vslSentinelDateInput";
    input.className = "vsl-sentinel-date-input";
    input.setAttribute("aria-label", "Sentinel imagery date");
    input.value = selectedDateStr;
    input.max = todayStr;
    input.addEventListener("click", (e) => e.stopPropagation());
    input.addEventListener("change", (e) => {
      if (!e.target.value) return;
      selectedDateStr = e.target.value;
      applyWmsParams();
    });

    const spinner = document.createElement("span");
    spinner.className = "vsl-sentinel-date-spinner";
    spinner.hidden = pendingTiles <= 0;
    spinner.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

    li.appendChild(input);
    li.appendChild(spinner);
    return li;
  }

  function buildLegendRow() {
    const li = document.createElement("li");
    li.className = "vsl-sentinel-legend-row";
    const activeLayerId = getActiveLayerId();
    li.hidden = !activeLayerId || !SCALE_LAYER_IDS.has(activeLayerId);

    const bar = document.createElement("div");
    bar.className = "vsl-sentinel-legend-bar";
    for (let i = 0; i < 6; i++) bar.appendChild(document.createElement("span"));

    const labels = document.createElement("div");
    labels.className = "vsl-sentinel-legend-labels";
    labels.innerHTML = "<span>Low</span><span>High</span>";

    li.appendChild(bar);
    li.appendChild(labels);
    return li;
  }

  function injectRows() {
    const ul = findSentinelGroupList();
    if (!ul) return;
    if (!ul.querySelector(".vsl-sentinel-date-row")) {
      ul.appendChild(buildDateRow());
    }
    if (!ul.querySelector(".vsl-sentinel-legend-row")) {
      ul.appendChild(buildLegendRow());
    }
    // ol-layerswitcher rebuilds its entire panel (fresh <ul>, fresh <li>s)
    // on every layer visibility change anywhere in the map, not just
    // Sentinel's own — re-syncing here as well as from change:visible below
    // means a freshly-rebuilt row can never briefly (or permanently) show
    // the wrong hidden state.
    syncInjectedRowVisibility();
  }

  const lsPanel = document.querySelector(".layer-switcher");
  if (lsPanel) {
    const observer = new MutationObserver(() => injectRows());
    observer.observe(lsPanel, { childList: true, subtree: true });
    injectRows();
  } else {
    // If not rendered yet, poll a few times
    let attempts = 0;
    const interval = setInterval(() => {
      const p = document.querySelector(".layer-switcher");
      if (p) {
        clearInterval(interval);
        const observer = new MutationObserver(() => injectRows());
        observer.observe(p, { childList: true, subtree: true });
        injectRows();
      }
      if (attempts++ > 10) clearInterval(interval);
    }, 500);
  }

  return { close: () => {} };
}
