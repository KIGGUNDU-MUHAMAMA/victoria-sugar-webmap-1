/**
 * Sentinel Hub WMS — Victoria Sugar Ltd
 * Single TileWMS layer; one SH product (LAYERS) at a time; TIME from UI.
 * Basemap radios, overlay toggles, opacity, legend, time animation.
 */

const SENTINEL_PRODUCT_TO_SH = {
  trueColor: "1_TRUE_COLOR",
  ndvi: "3_NDVI",
  falseColor: "2_FALSE_COLOR"
};

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

function renderLegend(legendEl, productKey) {
  if (!legendEl) return;
  if (productKey === "off" || !productKey) {
    legendEl.innerHTML =
      "<p class=\"sentinel-legend__placeholder\">Enable Sentinel-2 to show a legend.</p>";
    return;
  }
  if (productKey === "ndvi") {
    legendEl.innerHTML = `
      <div class="sentinel-legend__row sentinel-legend__row--gradient" role="img" aria-label="NDVI from low to high">
        <span class="sentinel-legend__scale sentinel-legend__scale--ndvi"></span>
      </div>
      <div class="sentinel-legend__ticks">
        <span>Low vigour</span><span>High vigour</span>
      </div>
      <p class="sentinel-legend__note">NDVI emphasises green biomass — useful for cane vigour.</p>`;
    return;
  }
  if (productKey === "trueColor") {
    legendEl.innerHTML =
      "<p class=\"sentinel-legend__note\"><strong>True colour</strong> — RGB (natural view).</p>";
    return;
  }
  if (productKey === "falseColor") {
    legendEl.innerHTML =
      "<p class=\"sentinel-legend__note\"><strong>False colour</strong> — NIR/Red/Green style composite: healthy vegetation is bright; pale/dark can indicate stress, senescence, or bare soil (interpret with field knowledge).</p>";
  }
}

/**
 * @param {object} opts
 * @param {import("ol/Map").default} opts.map
 * @param {object} opts.cfg
 * @param {function(string): void} opts.setBasemapByTitle
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
    setBasemapByTitle,
    getBaseGroup,
    sentinelLayer,
    blocksLayer,
    parcelsLayer,
    getSurveyPreviewLayers
  } = opts;

  if (!map || !sentinelLayer) return;

  const source = sentinelLayer.getSource();
  if (!source || typeof source.updateParams !== "function") return;

  const timeline = Array.isArray(cfg.SENTINEL_TIMELINE) && cfg.SENTINEL_TIMELINE.length
    ? cfg.SENTINEL_TIMELINE.map((d) => String(d).slice(0, 10))
    : ["2024-06-15", "2024-03-01", "2023-11-01"];

  const el = (id) => document.getElementById(id);
  const basemapRadios = document.querySelectorAll("input[name='basemapChoice']");
  const sentinelRadios = document.querySelectorAll("input[name='sentinelProduct']");
  const modeBtns = {
    natural: el("sentinelModeNatural"),
    ndvi: el("sentinelModeNdvi"),
    stress: el("sentinelModeStress")
  };
  const opacityRange = el("sentinelOpacityRange");
  const opacityValue = el("sentinelOpacityValue");
  const dateRange = el("sentinelDateRange");
  const dateSelect = el("sentinelDateSelect");
  const dateLabel = el("sentinelDateLabel");
  const playBtn = el("sentinelPlayBtn");
  const legendBody = el("sentinelLegendBody");
  const infoLine = el("sentinelInfoLine");
  const tileSpinner = el("sentinelTileSpinner");
  const ovBlocks = el("overlayBlocksCb");
  const ovParcels = el("overlayParcelsCb");
  const ovSurvey = el("overlaySurveyCb");
  const panelToggle = el("sentinelPanelToggle");
  const panelRoot = el("sentinelAnalyticsPanel");
  const panelShell = el("sentinelAnalyticsShell");

  let productMode = "off";
  let playTimer = null;
  let pendingTiles = 0;

  function updateTileSpinner() {
    if (!tileSpinner) return;
    tileSpinner.hidden = pendingTiles <= 0;
    tileSpinner.setAttribute("aria-busy", pendingTiles > 0 ? "true" : "false");
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

  function currentBasemapTitle() {
    for (const r of basemapRadios) {
      if (r.checked) return r.value;
    }
    return "Esri World Imagery";
  }

  function updateInfoLine() {
    if (!infoLine) return;
    const basemap = currentBasemapTitle();
    const idx = dateRange ? parseInt(dateRange.value, 10) : 0;
    const date = timeline[Number.isFinite(idx) ? Math.min(Math.max(idx, 0), timeline.length - 1) : 0] || "—";
    const modeLabel =
      productMode === "ndvi"
        ? "NDVI"
        : productMode === "falseColor"
          ? "False colour"
          : productMode === "trueColor"
            ? "True colour"
            : "Off";
    infoLine.textContent = `${basemap} · ${padDateLabel(date)} · ${modeLabel}`;
  }

  function highlightModeButtons(mode) {
    const mapAct = { off: null, trueColor: "natural", ndvi: "ndvi", falseColor: "stress" };
    const activeKey = mapAct[mode];
    for (const k of Object.keys(modeBtns)) {
      const b = modeBtns[k];
      if (!b) continue;
      b.classList.toggle("sentinel-mode-btn--active", activeKey === k);
      b.setAttribute("aria-pressed", activeKey === k ? "true" : "false");
    }
  }

  function setSentinelProduct(mode, { skipRadios = false, skipDateFlash = false } = {}) {
    productMode = mode;
    highlightModeButtons(mode);

    if (!skipRadios) {
      for (const r of sentinelRadios) {
        r.checked = r.value === mode;
      }
    }

    if (mode === "off") {
      stopPlay();
      sentinelLayer.setVisible(false);
      renderLegend(legendBody, "off");
      updateInfoLine();
      return;
    }

    const layersParam = SENTINEL_PRODUCT_TO_SH[mode];
    if (!layersParam) {
      sentinelLayer.setVisible(false);
      updateInfoLine();
      return;
    }

    const idx = dateRange ? parseInt(dateRange.value, 10) : 0;
    const safeIdx = Math.min(Math.max(Number.isFinite(idx) ? idx : 0, 0), timeline.length - 1);
    const timeStr = timeline[safeIdx];

    const targetOp =
      opacityRange && opacityValue
        ? parseInt(opacityRange.value, 10) / 100
        : typeof sentinelLayer.getOpacity === "function"
          ? sentinelLayer.getOpacity()
          : 0.88;

    if (!skipDateFlash) {
      sentinelLayer.setOpacity(targetOp * 0.4);
    }

    source.updateParams({
      LAYERS: layersParam,
      TIME: timeStr
    });
    if (typeof source.refresh === "function") source.refresh();
    sentinelLayer.setVisible(true);

    if (!skipDateFlash) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          sentinelLayer.setOpacity(targetOp);
        });
      });
    } else {
      sentinelLayer.setOpacity(targetOp);
    }

    renderLegend(legendBody, mode);
    updateInfoLine();
  }

  function syncDateIndex(index) {
    const safeIdx = Math.min(Math.max(index, 0), timeline.length - 1);
    if (dateRange) {
      dateRange.min = "0";
      dateRange.max = String(timeline.length - 1);
      dateRange.value = String(safeIdx);
    }
    if (dateLabel) {
      dateLabel.textContent = padDateLabel(timeline[safeIdx]);
    }
    if (dateSelect) {
      dateSelect.innerHTML = "";
      for (let i = 0; i < timeline.length; i += 1) {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = padDateLabel(timeline[i]);
        if (i === safeIdx) opt.selected = true;
        dateSelect.appendChild(opt);
      }
    }
  }

  function stopPlay() {
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
    }
    if (playBtn) {
      playBtn.setAttribute("aria-pressed", "false");
      playBtn.innerHTML = "<i class=\"fas fa-play\" aria-hidden=\"true\"></i> Play";
    }
  }

  function startPlay() {
    if (playTimer) {
      stopPlay();
      return;
    }
    if (productMode === "off") {
      setSentinelProduct("trueColor");
    }
    if (playBtn) {
      playBtn.setAttribute("aria-pressed", "true");
      playBtn.innerHTML = "<i class=\"fas fa-pause\" aria-hidden=\"true\"></i> Pause";
    }
    playTimer = setInterval(() => {
      if (!dateRange) return;
      const max = timeline.length - 1;
      let v = parseInt(dateRange.value, 10) || 0;
      v = v >= max ? 0 : v + 1;
      syncDateIndex(v);
      if (productMode !== "off") {
        setSentinelProduct(productMode, { skipRadios: true, skipDateFlash: true });
      }
    }, 2400);
  }

  // ——— Basemap
  for (const r of basemapRadios) {
    r.addEventListener("change", () => {
      if (r.checked) {
        setBasemapByTitle(r.value);
        updateInfoLine();
        map.updateSize();
      }
    });
  }

  for (const r of sentinelRadios) {
    r.addEventListener("change", () => {
      if (r.checked) setSentinelProduct(r.value);
    });
  }

  if (modeBtns.natural) {
    modeBtns.natural.addEventListener("click", (e) => {
      e.preventDefault();
      setSentinelProduct("trueColor");
    });
  }
  if (modeBtns.ndvi) {
    modeBtns.ndvi.addEventListener("click", (e) => {
      e.preventDefault();
      setSentinelProduct("ndvi");
    });
  }
  if (modeBtns.stress) {
    modeBtns.stress.addEventListener("click", (e) => {
      e.preventDefault();
      setSentinelProduct("falseColor");
    });
  }

  const onOpacity = debounce(() => {
    if (!opacityRange) return;
    const pct = parseInt(opacityRange.value, 10);
    if (opacityValue) opacityValue.textContent = `${pct}`;
    if (productMode !== "off") {
      sentinelLayer.setOpacity(pct / 100);
    }
  }, 60);

  opacityRange?.addEventListener("input", onOpacity);

  function onDateChange() {
    if (!dateRange) return;
    const idx = parseInt(dateRange.value, 10);
    syncDateIndex(Number.isFinite(idx) ? idx : 0);
    if (productMode !== "off") {
      setSentinelProduct(productMode, { skipRadios: true, skipDateFlash: true });
    } else {
      updateInfoLine();
    }
  }

  const onDateDebounce = debounce(onDateChange, 90);
  dateRange?.addEventListener("input", onDateDebounce);
  dateRange?.addEventListener("change", onDateChange);

  dateSelect?.addEventListener("change", () => {
    const idx = parseInt(dateSelect.value, 10);
    syncDateIndex(Number.isFinite(idx) ? idx : 0);
    onDateChange();
  });

  playBtn?.addEventListener("click", () => {
    if (playTimer) stopPlay();
    else startPlay();
  });

  // ——— Overlays (vectors)
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

  // ——— Collapse
  if (panelToggle && panelRoot) {
    let collapsed = false;
    panelToggle.addEventListener("click", () => {
      collapsed = !collapsed;
      panelRoot.classList.toggle("sentinel-analytics--collapsed", collapsed);
      panelToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      if (panelShell) panelShell.hidden = collapsed;
      requestAnimationFrame(() => map.updateSize());
    });
  }

  // ——— Init UI from layer / map state
  if (dateRange) {
    dateRange.min = "0";
    dateRange.max = String(Math.max(0, timeline.length - 1));
    dateRange.value = "0";
  }
  syncDateIndex(0);

  const paramGetter = source.getParams && source.getParams.bind(source);
  const params = (paramGetter && paramGetter()) || source.params_ || {};
  const startLayer = params.LAYERS || "1_TRUE_COLOR";
  const startMode =
    startLayer === "3_NDVI" ? "ndvi" : startLayer === "2_FALSE_COLOR" ? "falseColor" : "trueColor";

  for (const r of sentinelRadios) {
    r.checked = false;
  }
  if (sentinelLayer.getVisible()) {
    const onRadio = [...sentinelRadios].find((r) => r.value === startMode);
    if (onRadio) onRadio.checked = true;
    productMode = startMode;
  } else {
    const offRadio = [...sentinelRadios].find((r) => r.value === "off");
    if (offRadio) offRadio.checked = true;
    productMode = "off";
  }

  highlightModeButtons(productMode);
  if (productMode === "off") {
    renderLegend(legendBody, "off");
  } else {
    setSentinelProduct(productMode, { skipRadios: true, skipDateFlash: true });
  }

  if (opacityRange) {
    const o = Math.round(
      (typeof sentinelLayer.getOpacity === "function" ? sentinelLayer.getOpacity() : 0.88) * 100
    );
    opacityRange.value = String(o);
    if (opacityValue) opacityValue.textContent = String(o);
  }

  // Sync basemap radio with the visible basemap in the group
  const bg = getBaseGroup?.();
  if (bg) {
    let activeTitle = "Esri World Imagery";
    bg.getLayers().forEach((ly) => {
      if (ly.getVisible() && ly.get("title")) activeTitle = ly.get("title");
    });
    for (const r of basemapRadios) {
      r.checked = r.value === activeTitle;
    }
  }

  updateInfoLine();
}
