/**
 * Sentinel Analytics - Minimalist
 */

export const VSL_WMS_LAYER_IDS = [
  "TRUE_COLOR",
  "NDVI",
  "NDVI_ADVANCED",
  "NDRE",
  "MOISTURE_STRESS"
];

function getSentinelWmsAuxParams() {
  // Hardcoded for best cloud-free monthly mosaics
  return { MAXCC: 40, PRIORITY: "leastCC" };
}

function getMonthTimeRange(year, month) {
  // Return YYYY-MM-01/YYYY-MM-lastDay
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0); // last day of month
  return `${startDate.toISOString().slice(0, 10)}/${endDate.toISOString().slice(0, 10)}`;
}

function renderWmsLegend(legendEl, layerId) {
  if (!legendEl) return;
  if (layerId === "TRUE_COLOR") {
    legendEl.innerHTML = '<p class="smc-legend-note" style="margin:0">True color composite.</p>';
  } else if (layerId === "NDVI" || layerId === "NDVI_ADVANCED") {
    legendEl.innerHTML = `
      <div class="smc-legend-gradient" style="background:linear-gradient(90deg,#c62828 0%,#fbc02d 50%,#1b5e20 100%); height:8px; border-radius:4px; margin-bottom:4px;"></div>
      <div style="display:flex; justify-content:space-between; font-size:11px;"><span>Poor</span><span>Healthy</span></div>
    `;
  } else if (layerId === "NDRE" || layerId === "MOISTURE_STRESS") {
    legendEl.innerHTML = `
      <div class="smc-legend-gradient" style="background:linear-gradient(90deg,#d32f2f 0%,#ffeb3b 50%,#388e3c 100%); height:8px; border-radius:4px; margin-bottom:4px;"></div>
      <div style="display:flex; justify-content:space-between; font-size:11px;"><span>Stress</span><span>Optimal</span></div>
    `;
  }
}

export function initSentinelAnalytics(opts) {
  const {
    map,
    sentinelLayer,
    blocksLayer
  } = opts;

  if (!map || !sentinelLayer) return null;

  const source = sentinelLayer.getSource();
  if (!source || typeof source.updateParams !== "function") return null;

  const container = document.getElementById("sentinelMinimalControl");
  const yearSel = document.getElementById("smcYear");
  const monthSlider = document.getElementById("smcMonth");
  const monthLabel = document.getElementById("smcMonthLabel");
  const layerSel = document.getElementById("smcLayer");
  const legendBody = document.getElementById("smcLegend");
  const spinner = document.getElementById("smcSpinner");

  let pendingTiles = 0;
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // Set current year/month
  const now = new Date();
  if (yearSel) {
    // Make sure current year is in the list
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

  source.on("tileloadstart", () => {
    pendingTiles += 1;
    updateTileSpinner();
  });
  source.on("tileloadend", () => {
    pendingTiles = Math.max(0, pendingTiles - 1);
    updateTileSpinner();
  });
  source.on("tileloaderror", () => {
    pendingTiles = Math.max(0, pendingTiles - 1);
    updateTileSpinner();
  });

  function applyWmsParams() {
    if (!sentinelLayer.getVisible()) return;

    const layerId = layerSel ? layerSel.value : "TRUE_COLOR";
    const yr = yearSel ? parseInt(yearSel.value, 10) : now.getFullYear();
    const mo = monthSlider ? parseInt(monthSlider.value, 10) : now.getMonth() + 1;
    
    const tParam = getMonthTimeRange(yr, mo);
    const aux = getSentinelWmsAuxParams();

    const wmsP = {
      LAYERS: layerId,
      STYLES: "default",
      TIME: tParam,
      SHOWLOGO: "false",
      WARNINGS: "NO",
      MAXCC: String(aux.MAXCC),
      PRIORITY: aux.PRIORITY,
      FORMAT: "image/png",
      TRANSPARENT: "true"
    };

    source.updateParams(wmsP);
    if (typeof source.refresh === "function") source.refresh();
    
    sentinelLayer.setOpacity(1.0); // Hardcoded 100%
    renderWmsLegend(legendBody, layerId);
  }

  // Bind UI Events
  if (yearSel) yearSel.addEventListener("change", applyWmsParams);
  if (monthSlider) {
    monthSlider.addEventListener("input", () => {
      if (monthLabel) monthLabel.textContent = monthNames[parseInt(monthSlider.value, 10) - 1];
    });
    monthSlider.addEventListener("change", applyWmsParams);
  }
  if (layerSel) layerSel.addEventListener("change", applyWmsParams);

  // Toggle Panel visibility based on Layer Switcher
  sentinelLayer.on("change:visible", () => {
    const isVis = sentinelLayer.getVisible();
    if (container) container.hidden = !isVis;
    if (isVis) {
      applyWmsParams();
    }
  });
  
  // Apply initial state if already visible
  if (sentinelLayer.getVisible() && container) {
    container.hidden = false;
    applyWmsParams();
  }

  // Removed buggy clipping logic to restore layer rendering

  return { close: () => {} };
}
