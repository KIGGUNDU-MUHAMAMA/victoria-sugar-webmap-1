/**
 * Copernicus Data Space WMS (OpenLayers TileWMS) — single instance, one LAYERS at a time.
 * Controls live in the Satellite panel (WMS, cloud, overlays, reports).
 */

/** WMS LAYERS ids from the configured CDSE instance (exact names). */
export const VSL_WMS_LAYER_IDS = [
  "TRUE_COLOR",
  "FALSE_COLOR",
  "NDVI",
  "NDVI_ADVANCED",
  "NDRE",
  "MOISTURE_STRESS",
  "DEM"
];

/**
 * WMS “aux” params (CDSE / Sentinel Hub). MAXCC = max mean cloud %; PRIORITY mosaics overlapping tiles.
 * @param {object} cfg
 * @param {{ maxcc?: number, priority?: string }} [overrides]
 */
export function getSentinelWmsAuxParams(cfg, overrides = {}) {
  const m =
    overrides.maxcc != null
      ? Number(overrides.maxcc)
      : Number(cfg.SENTINEL_MAX_CLOUD_COVER) >= 0
        ? Number(cfg.SENTINEL_MAX_CLOUD_COVER)
        : 25;
  const MAXCC = Math.min(100, Math.max(0, m));
  const PRIORITY = String(
    overrides.priority != null ? overrides.priority : cfg.SENTINEL_TILE_PRIORITY || "leastCC"
  );
  return { MAXCC, PRIORITY };
}

/**
 * Default WMS TIME range: last 30 days (YYYY-MM-DD/YYYY-MM-DD).
 * @returns {{ from: string, to: string, timeParam: string }}
 */
export function getDefaultWmsTimeRange() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 864e5);
  const from = start.toISOString().slice(0, 10);
  const to = end.toISOString().slice(0, 10);
  return { from, to, timeParam: `${from}/${to}` };
}

/**
 * Newest first (optional manual list). Used for block report sync hints only.
 */
export function buildSentinelTimeline(cfg) {
  if (Array.isArray(cfg.SENTINEL_TIMELINE) && cfg.SENTINEL_TIMELINE.length > 0) {
    return cfg.SENTINEL_TIMELINE.map((d) => String(d).slice(0, 10));
  }
  const stepDays = Number(cfg.SENTINEL_TIMELINE_STEP_DAYS) > 0 ? Number(cfg.SENTINEL_TIMELINE_STEP_DAYS) : 14;
  const monthsBack = Number(cfg.SENTINEL_TIMELINE_MONTHS_BACK) > 0 ? Number(cfg.SENTINEL_TIMELINE_MONTHS_BACK) : 24;
  const end = new Date();
  const start = new Date(end.getTime());
  start.setMonth(start.getMonth() - monthsBack);
  const out = [];
  for (let t = end.getTime(); t >= start.getTime(); t -= stepDays * 864e5) {
    const cur = new Date(t);
    out.push(cur.toISOString().slice(0, 10));
  }
  if (out.length === 0) {
    out.push(new Date().toISOString().slice(0, 10));
  }
  return out;
}

function debounce(fn, ms) {
  let t;
  return function debounced(...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

function padDateLabel(iso) {
  if (!iso) return "—";
  return String(iso).slice(0, 10);
}

function formatTimeRange(from, to) {
  if (!from || !to) return "—";
  return `${padDateLabel(from)} / ${padDateLabel(to)}`;
}

/**
 * @param {HTMLElement | null} legendEl
 * @param {string} layerId - WMS LAYERS id or "off"
 */
function renderWmsLegend(legendEl, layerId) {
  if (!legendEl) return;
  if (!layerId || layerId === "off") {
    legendEl.innerHTML =
      "<p class=\"sentinel-legend__placeholder\">Choose a WMS layer above.</p>";
    return;
  }
  if (layerId === "NDVI" || layerId === "NDVI_ADVANCED") {
    legendEl.innerHTML = `
      <div class="sentinel-legend__row sentinel-legend__row--ndvi-interpret" role="img" aria-label="NDVI scale">
        <span class="sentinel-legend__swatch" style="background:linear-gradient(90deg,#c62828 0%,#fbc02d 50%,#1b5e20 100%)"></span>
      </div>
      <div class="sentinel-legend__ticks">
        <span>Red — poor / stressed</span><span>Yellow — moderate</span><span>Green — healthy</span>
      </div>
      <p class="sentinel-legend__note">${
        layerId === "NDVI_ADVANCED"
          ? "NDVI (advanced) — use for refined crop health within the block."
          : "NDVI — general vegetation vigour (sugarcane canopy health)."
      } Interpret with field knowledge.</p>`;
    return;
  }
  if (layerId === "DEM") {
    legendEl.innerHTML =
      "<p class=\"sentinel-legend__note\"><strong>Copernicus DEM</strong> — relief / elevation. <em>Contours:</em> planned. Adjust WMS opacity above.</p>";
    return;
  }
  if (layerId === "MOISTURE_STRESS" || layerId === "NDRE") {
    legendEl.innerHTML = `<p class="sentinel-legend__note"><strong>${
      layerId === "NDRE" ? "NDRE" : "Moisture stress"
    }</strong> — ${
      layerId === "NDRE"
        ? "red-edge chlorophyll / nitrogen sensitivity."
        : "farm water-stress / moisture product from your layer configuration."
    } Compare with true colour in the field.</p>`;
    return;
  }
  if (layerId === "TRUE_COLOR" || layerId === "FALSE_COLOR") {
    legendEl.innerHTML = `<p class="sentinel-legend__note"><strong>${
      layerId === "TRUE_COLOR" ? "True colour" : "False colour"
    }</strong> — Sentinel-2 composite; blend with basemap using opacity.</p>`;
    return;
  }
  legendEl.innerHTML = `<p class="sentinel-legend__note">Active layer: <code>${String(layerId).replace(
    /[<>]/g,
    ""
  )}</code></p>`;
}

/**
 * @param {object} opts
 * @param {import("ol/Map").default} opts.map
 * @param {object} opts.cfg
 * @param {() => import("ol/layer/Group").default | null} [opts.getBaseGroup]
 * @param {import("ol/layer/Tile").default} opts.sentinelLayer
 * @param {import("ol/layer/Vector").default} opts.blocksLayer
 * @param {import("ol/layer/Vector").default} opts.parcelsLayer
 * @param {() => { polyLayer?: import("ol/layer/Vector").default; pointLayer?: import("ol/layer/Vector").default } | null} [opts.getSurveyPreviewLayers]
 */
export function initSentinelAnalytics(opts) {
  const {
    map,
    cfg,
    getBaseGroup,
    sentinelLayer,
    blocksLayer,
    parcelsLayer,
    getSurveyPreviewLayers,
    closeOtherPanels
  } = opts;

  if (!map || !sentinelLayer) return null;

  const source = sentinelLayer.getSource();
  if (!source || typeof source.updateParams !== "function") return null;

  const wmsFloat = document.getElementById("vslWmsControlCard");
  const wmsOffBtn = document.getElementById("vslWmsOffBtn");
  const wmsLoadSpinner = document.getElementById("vslWmsFloatSpinner");
  const wmsTimeFrom = document.getElementById("vslWmsTimeFrom");
  const wmsTimeTo = document.getElementById("vslWmsTimeTo");
  const wmsOpacityRange = document.getElementById("vslWmsOpacityRange");
  const wmsOpacityValue = document.getElementById("vslWmsOpacityValue");
  const wmsResetViewBtn = document.getElementById("vslWmsResetViewBtn");
  const wmsContoursHook = document.getElementById("vslWmsContoursHook");

  const el = (id) => document.getElementById(id);
  const opacityRangeLeft = el("sentinelOpacityRange");
  const opacityValueLeft = el("sentinelOpacityValue");
  const legendBody = el("sentinelLegendBody");
  const infoLine = el("sentinelInfoLine");
  const tileSpinner = el("sentinelTileSpinner");
  const ovBlocks = el("overlayBlocksCb");
  const ovParcels = el("overlayParcelsCb");
  const ovSurvey = el("overlaySurveyCb");
  const panelBtn = el("sentinelPanelBtn");
  const panelRoot = el("sentinelAnalyticsPanel");
  const closePanelBtn = el("sentinelPanelCloseBtn");
  const maxCcRange = el("sentinelMaxCcRange");
  const maxCcValue = el("sentinelMaxCcValue");
  const prioritySelect = el("sentinelPrioritySelect");

  let activeLayerId = "off";
  let timeFrom = "";
  let timeTo = "";
  let panelOpen = false;
  let panelOutsideHandler = null;
  let panelEscapeHandler = null;
  let pendingTiles = 0;

  const layerPickButtons = wmsFloat
    ? wmsFloat.querySelectorAll("[data-vsl-wms-layer]")
    : [];

  function readAuxOverrides() {
    return {
      maxcc: maxCcRange ? parseInt(maxCcRange.value, 10) : undefined,
      priority: prioritySelect?.value
    };
  }

  function currentTimeParam() {
    const a = (wmsTimeFrom && wmsTimeFrom.value) || timeFrom;
    const b = (wmsTimeTo && wmsTimeTo.value) || timeTo;
    if (!a || !b) {
      const d = getDefaultWmsTimeRange();
      return d.timeParam;
    }
    return `${String(a).slice(0, 10)}/${String(b).slice(0, 10)}`;
  }

  /** Static DEM: short TIME ranges often return empty/white tiles. */
  const WMS_WIDE_TIME = "1980-01-01/2030-12-31";

  /** S2 mosaics for some indices are sparse: if the UI range is very short, use ~12 months ending on "To". */
  function timeParamForWmsLayer(layerId) {
    if (layerId === "DEM") return WMS_WIDE_TIME;
    const expandIfNarrow = new Set(["NDRE", "NDVI_ADVANCED", "MOISTURE_STRESS"]);
    if (!expandIfNarrow.has(layerId)) return currentTimeParam();
    const a = (wmsTimeFrom && wmsTimeFrom.value) || timeFrom;
    const b = (wmsTimeTo && wmsTimeTo.value) || timeTo;
    if (!a || !b) return currentTimeParam();
    const t0 = new Date(`${String(a).slice(0, 10)}T12:00:00Z`).getTime();
    const t1 = new Date(`${String(b).slice(0, 10)}T12:00:00Z`).getTime();
    const days = (t1 - t0) / 864e5;
    if (days > 50) return currentTimeParam();
    const end = String(b).slice(0, 10);
    const endMs = new Date(`${end}T12:00:00Z`).getTime();
    const fromMs = endMs - 365 * 864e5;
    const from = new Date(fromMs).toISOString().slice(0, 10);
    return `${from}/${end}`;
  }

  function setFloatSpinner(show) {
    if (wmsLoadSpinner) wmsLoadSpinner.hidden = !show;
  }

  function updateTileSpinner() {
    if (!tileSpinner) return;
    tileSpinner.hidden = pendingTiles <= 0;
    tileSpinner.setAttribute("aria-busy", pendingTiles > 0 ? "true" : "false");
  }

  source.on("tileloadstart", () => {
    pendingTiles += 1;
    setFloatSpinner(true);
    updateTileSpinner();
  });
  source.on("tileloadend", () => {
    pendingTiles = Math.max(0, pendingTiles - 1);
    if (pendingTiles <= 0) setFloatSpinner(false);
    updateTileSpinner();
  });
  source.on("tileloaderror", () => {
    pendingTiles = Math.max(0, pendingTiles - 1);
    if (pendingTiles <= 0) setFloatSpinner(false);
    updateTileSpinner();
  });

  function highlightPickedLayer() {
    for (const b of layerPickButtons) {
      const id = b.getAttribute("data-vsl-wms-layer");
      b.classList.toggle("vsl-wms-pick--active", id === activeLayerId);
      if (b instanceof HTMLElement) {
        b.setAttribute("aria-pressed", id === activeLayerId ? "true" : "false");
      }
    }
    if (wmsOffBtn) {
      wmsOffBtn.classList.toggle("vsl-wms-pick--active", activeLayerId === "off");
      wmsOffBtn.setAttribute("aria-pressed", activeLayerId === "off" ? "true" : "false");
    }
  }

  function applyWmsParams({ skipOpacityFlash = false } = {}) {
    if (activeLayerId === "off") {
      sentinelLayer.setVisible(false);
      renderWmsLegend(legendBody, "off");
      updateInfoLine();
      return;
    }

    const layersParam = String(activeLayerId);
    const aux = getSentinelWmsAuxParams(cfg, readAuxOverrides());
    const tParam = timeParamForWmsLayer(activeLayerId);

    const targetOp = wmsOpacityRange
      ? parseInt(wmsOpacityRange.value, 10) / 100
      : opacityRangeLeft
        ? parseInt(opacityRangeLeft.value, 10) / 100
        : 0.88;

    if (!skipOpacityFlash) {
      sentinelLayer.setOpacity(targetOp * 0.4);
    }

    source.updateParams({
      LAYERS: layersParam,
      STYLES: "default",
      TIME: tParam,
      MAXCC: aux.MAXCC,
      PRIORITY: aux.PRIORITY,
      SHOWLOGO: "false",
      WARNINGS: "NO"
    });
    if (typeof source.refresh === "function") source.refresh();
    sentinelLayer.setVisible(true);
    if (!skipOpacityFlash) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          sentinelLayer.setOpacity(targetOp);
        });
      });
    } else {
      sentinelLayer.setOpacity(targetOp);
    }

    renderWmsLegend(legendBody, activeLayerId);
    updateInfoLine();
  }

  function setActiveLayer(id) {
    const next = id === "off" || !id ? "off" : String(id);
    activeLayerId = VSL_WMS_LAYER_IDS.includes(next) || next === "off" ? next : "TRUE_COLOR";
    highlightPickedLayer();
    applyWmsParams({});
  }

  function getVisibleBasemapTitle() {
    const bg = getBaseGroup?.();
    if (bg) {
      let t = "Basemap";
      bg.getLayers().forEach((ly) => {
        if (ly.getVisible() && ly.get("title")) t = String(ly.get("title"));
      });
      return t;
    }
    return "Basemap";
  }

  function updateInfoLine() {
    if (!infoLine) return;
    const basemap = getVisibleBasemapTitle();
    const tr = formatTimeRange(
      wmsTimeFrom && wmsTimeFrom.value,
      wmsTimeTo && wmsTimeTo.value
    );
    const mode = activeLayerId === "off" ? "WMS off" : activeLayerId;
    infoLine.textContent = `${basemap} · TIME ${tr} · ${mode}`;
  }

  for (const b of layerPickButtons) {
    b.addEventListener("click", (e) => {
      e.preventDefault();
      const id = b.getAttribute("data-vsl-wms-layer");
      if (id) setActiveLayer(id);
    });
  }
  wmsOffBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    setActiveLayer("off");
  });

  const defaultRange = getDefaultWmsTimeRange();
  timeFrom = defaultRange.from;
  timeTo = defaultRange.to;
  if (wmsTimeFrom) wmsTimeFrom.value = timeFrom;
  if (wmsTimeTo) wmsTimeTo.value = timeTo;

  const onTimeChange = debounce(() => {
    timeFrom = wmsTimeFrom ? wmsTimeFrom.value : timeFrom;
    timeTo = wmsTimeTo ? wmsTimeTo.value : timeTo;
    if (activeLayerId !== "off") applyWmsParams({ skipOpacityFlash: true });
    else updateInfoLine();
  }, 120);
  wmsTimeFrom?.addEventListener("change", onTimeChange);
  wmsTimeTo?.addEventListener("change", onTimeChange);

  const onWmsOpacity = debounce(() => {
    if (wmsOpacityRange && wmsOpacityValue) {
      const pct = parseInt(wmsOpacityRange.value, 10);
      wmsOpacityValue.textContent = String(pct);
    }
    if (activeLayerId !== "off") {
      const op = wmsOpacityRange
        ? parseInt(wmsOpacityRange.value, 10) / 100
        : 0.88;
      sentinelLayer.setOpacity(op);
    }
  }, 50);
  wmsOpacityRange?.addEventListener("input", onWmsOpacity);

  wmsResetViewBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    if (!map || !window.ol || !window.ol.proj) return;
    const v = map.getView();
    const center = cfg.DEFAULT_CENTER;
    if (Array.isArray(center) && center.length >= 2) {
      v.setCenter(window.ol.proj.fromLonLat([Number(center[0]), Number(center[1])]));
    }
    v.setZoom(Number(cfg.DEFAULT_ZOOM) > 0 ? Number(cfg.DEFAULT_ZOOM) : 11);
  });

  if (opacityRangeLeft) {
    opacityRangeLeft.addEventListener(
      "input",
      debounce(() => {
        if (wmsOpacityRange) {
          wmsOpacityRange.value = opacityRangeLeft.value;
          if (wmsOpacityValue) wmsOpacityValue.textContent = opacityRangeLeft.value;
        }
        if (activeLayerId !== "off") onWmsOpacity();
      }, 50)
    );
  }

  const onCloudOrPriority = debounce(() => {
    if (maxCcValue && maxCcRange) maxCcValue.textContent = maxCcRange.value;
    if (activeLayerId !== "off") applyWmsParams({ skipOpacityFlash: true });
  }, 100);
  maxCcRange?.addEventListener("input", onCloudOrPriority);
  prioritySelect?.addEventListener("change", onCloudOrPriority);

  if (ovBlocks) {
    ovBlocks.checked = blocksLayer.getVisible();
    ovBlocks.addEventListener("change", () => {
      blocksLayer.setVisible(ovBlocks.checked);
    });
    blocksLayer.on("change:visible", () => {
      if (ovBlocks) ovBlocks.checked = blocksLayer.getVisible();
    });
  }
  if (ovParcels) {
    ovParcels.checked = parcelsLayer.getVisible();
    ovParcels.addEventListener("change", () => {
      parcelsLayer.setVisible(ovParcels.checked);
    });
    parcelsLayer.on("change:visible", () => {
      if (ovParcels) ovParcels.checked = parcelsLayer.getVisible();
    });
  }
  if (ovSurvey) {
    const sur = getSurveyPreviewLayers?.();
    if (sur?.polyLayer && sur?.pointLayer) {
      ovSurvey.checked = sur.polyLayer.getVisible() || sur.pointLayer.getVisible();
      ovSurvey.addEventListener("change", () => {
        const v = ovSurvey.checked;
        sur.polyLayer.setVisible(v);
        sur.pointLayer.setVisible(v);
      });
    } else {
      ovSurvey.disabled = true;
      ovSurvey.checked = false;
      ovSurvey.title = "Open Survey import and preview a CSV to enable";
    }
  }

  function closeSentinelPanel() {
    if (!panelRoot) return;
    if (panelEscapeHandler) {
      document.removeEventListener("keydown", panelEscapeHandler, true);
      panelEscapeHandler = null;
    }
    if (panelOutsideHandler) {
      document.removeEventListener("pointerdown", panelOutsideHandler, true);
      panelOutsideHandler = null;
    }
    panelOpen = false;
    panelRoot.hidden = true;
    panelBtn?.classList.remove("active");
    panelBtn?.setAttribute("aria-expanded", "false");
    map?.updateSize();
  }

  function openSentinelPanel() {
    if (!panelRoot) return;
    closeOtherPanels?.();
    panelRoot.hidden = false;
    panelOpen = true;
    panelBtn?.classList.add("active");
    panelBtn?.setAttribute("aria-expanded", "true");
    panelEscapeHandler = (ev) => {
      if (ev.key === "Escape" && panelOpen) {
        ev.preventDefault();
        closeSentinelPanel();
      }
    };
    document.addEventListener("keydown", panelEscapeHandler, true);
    panelOutsideHandler = (ev) => {
      if (!panelOpen) return;
      if (panelRoot.contains(ev.target) || panelBtn?.contains(ev.target)) return;
      closeSentinelPanel();
    };
    document.addEventListener("pointerdown", panelOutsideHandler, true);
    requestAnimationFrame(() => {
      map?.updateSize();
    });
  }

  function toggleSentinelPanel() {
    if (panelOpen) closeSentinelPanel();
    else openSentinelPanel();
  }

  panelBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSentinelPanel();
  });
  closePanelBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeSentinelPanel();
  });

  if (panelRoot) panelRoot.hidden = true;
  panelBtn?.setAttribute("aria-expanded", "false");

  if (wmsContoursHook) {
    wmsContoursHook.disabled = true;
    wmsContoursHook.title = "Terrain contours — planned (hook for future release)";
  }

  if (wmsOpacityRange) {
    const o = Math.round(
      (typeof sentinelLayer.getOpacity === "function" ? sentinelLayer.getOpacity() : 0.88) * 100
    );
    wmsOpacityRange.value = String(o);
    if (wmsOpacityValue) wmsOpacityValue.textContent = String(o);
  }

  const paramGetter = source.getParams && source.getParams.bind(source);
  const p0 = (paramGetter && paramGetter()) || source.params_ || {};
  const startLayer = String(p0.LAYERS || "TRUE_COLOR");
  if (VSL_WMS_LAYER_IDS.includes(startLayer)) {
    activeLayerId = startLayer;
  } else {
    activeLayerId = "TRUE_COLOR";
  }
  if (!sentinelLayer.getVisible()) {
    activeLayerId = "off";
  }
  highlightPickedLayer();
  if (activeLayerId === "off") {
    renderWmsLegend(legendBody, "off");
    updateInfoLine();
  } else {
    applyWmsParams({ skipOpacityFlash: true });
  }

  const bg = getBaseGroup?.();
  if (bg) {
    const layers = bg.getLayers();
    const onBasemapVis = () => updateInfoLine();
    layers.forEach((ly) => ly.on("change:visible", onBasemapVis));
    layers.on("add", (e) => e.element.on("change:visible", onBasemapVis));
  }

  if (maxCcRange) {
    const d0 = getSentinelWmsAuxParams(cfg, {});
    maxCcRange.value = String(Math.round(d0.MAXCC));
    if (maxCcValue) maxCcValue.textContent = String(Math.round(d0.MAXCC));
  }
  if (prioritySelect) {
    const d1 = getSentinelWmsAuxParams(cfg, {});
    if ([...prioritySelect.options].some((o) => o.value === d1.PRIORITY)) {
      prioritySelect.value = d1.PRIORITY;
    }
  }

  updateInfoLine();
  return { close: closeSentinelPanel };
}
