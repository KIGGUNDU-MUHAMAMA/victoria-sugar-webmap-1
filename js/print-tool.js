// js/print-tool.js
//
// Print/PDF Plot — no longer a docked side panel (windows/print-panel.html
// is no longer loaded, see app-boot.js). #printTopBtn now toggles an
// in-place "print mode" directly on the live map, Google-Earth-style:
//   1. Entering print mode clears the map of every floating button stack
//      (.vsl-print-mode on .map-viewport-wrap — see styles.css) and shows
//      a top-center "Add title" button + a bottom-center toolbar.
//   2. The toolbar's crosshair button arms a drag-to-draw selection
//      rectangle on the map — the print area. Everything outside it is
//      dimmed via one CSS box-shadow (see .vsl-print-selection in
//      styles.css), everything inside stays fully clear.
//   3. Once a selection exists, the legend (if enabled) snaps into its
//      top-right corner and the north arrow into its top-left — both
//      still draggable afterward, same as before.
//   4. The toolbar's gear button opens a small setup popup (legend/north
//      arrow/date/source toggles + a resolution dropdown). Page
//      orientation isn't a setting — it's derived automatically from
//      whichever side of the selection (width vs height) is longer.
//   5. Save PDF builds the page from two independent pieces: the basemap
//      (+ drone/sentinel/annotation layers) is captured as a raster image
//      — blocksLayer/parcelsLayer hidden for that capture, re-rendered at a
//      modest fixed zoom (BASEMAP_ZOOM_SCALE — the same for both the
//      Standard and High settings) via the "composite every .ol-layer
//      canvas onto one canvas" technique js/feature-export.js uses for
//      single-feature PDFs — while the plot/block boundaries and labels are
//      drawn as genuine PDF vectors straight on top (projected from their
//      real map geometry, see drawParcelsAndBlocksVector), so the text that
//      actually needs to be legible never depends on pixel density at all.
//      Which detail tier a plot/block draws at (name only / full name+area+
//      ratoon / + per-edge distance labels) and how big everything is sized
//      is decided by an effective "print resolution" compared against the
//      SAME zoom thresholds the live map's own style functions use — see
//      the LOD comment above drawBlockVector. Legend/north arrow were
//      already vectors and are unchanged (see buildLegendOverlay's
//      comment); title/description and a date/source
//      line are also real text, stamped in and bottom-left respectively.
//
// Filename: "VSL Map Print <SS>S<MM>M<HH>H<DD>D.pdf" (seconds/minutes/
// hour/day of when it was generated) per the user's spec.

export function initPrintTool({
  map, setStatus, statusEl, closeOtherPanels,
  // Plot/block styling data + layer refs — used to redraw parcels/blocks as
  // real PDF vectors (Option B) instead of rasterizing them. See
  // drawParcelsAndBlocksVector below.
  blocksLayer, parcelsLayer, CULTIVATION_PALETTE, ALERT_SEVERITY_FILL,
  ALERT_SEVERITY_COLORS, getFeatureInteriorPoint, surveyFeatureAreaAcresText
}) {
  const topBtn = document.getElementById("printTopBtn");
  const viewportWrap = document.querySelector(".map-viewport-wrap");
  if (!topBtn || !viewportWrap || !map) return null;

  let printModeActive = false;
  let armed = false; // crosshair "select area" mode is on, next drag on the map defines the rect
  let drawingFrom = null; // { x, y } in viewportWrap-relative px, while a drag is in progress

  let legendEl = null;
  let northArrowEl = null;
  let selectionEl = null;
  let selectionHandleEl = null;
  let selectionHintEl = null;
  let selectionRect = null; // { left, top, width, height } in viewportWrap-relative px, once drawn

  const settings = { legend: true, northArrow: true, date: true, source: true, resolution: "1" };

  // Zoom-in factor for the basemap-only raster capture (Option C) — how
  // much denser than the live on-screen view the basemap tiles get
  // re-requested/rendered at before being cropped into the page. The SAME
  // for both Resolution settings, deliberately: pushing this harder for
  // "High" (6x plus a long extra tile-load wait) is what made it laggy,
  // and it didn't help the thing that actually needed to be legible, since
  // the boundaries and labels are PDF vectors, not pixels. "High" spends
  // its effort on the vector layer instead — see
  // PRINT_HIGH_ADDS_EDGE_DISTANCES.
  const BASEMAP_ZOOM_SCALE = 3;

  function setPrintStatus(msg, isError) {
    setStatus?.(statusEl, msg, isError);
  }

  // ---------------------------------------------------------------------
  // Generic drag/resize helpers (unchanged approach from the original
  // draggable legend) — reused for the legend AND the selection rectangle.
  // ---------------------------------------------------------------------
  function wireDrag(el, handle, onMoveExtra) {
    let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;
    const onMove = (e) => {
      if (!dragging) return;
      const wrapRect = viewportWrap.getBoundingClientRect();
      let left = startLeft + (e.clientX - startX);
      let top = startTop + (e.clientY - startY);
      left = Math.max(0, Math.min(left, wrapRect.width - el.offsetWidth));
      top = Math.max(0, Math.min(top, wrapRect.height - el.offsetHeight));
      el.style.left = `${left}px`;
      el.style.top = `${top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
      onMoveExtra?.();
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      const wrapRect = viewportWrap.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = elRect.left - wrapRect.left;
      startTop = elRect.top - wrapRect.top;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  function wireResize(el, handle, minW, minH, onResizeExtra) {
    let startX = 0, startY = 0, startW = 0, startH = 0, resizing = false;
    const onMove = (e) => {
      if (!resizing) return;
      const wrapRect = viewportWrap.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const maxW = wrapRect.width - (elRect.left - wrapRect.left);
      const maxH = wrapRect.height - (elRect.top - wrapRect.top);
      el.style.width = `${Math.max(minW, Math.min(maxW, startW + (e.clientX - startX)))}px`;
      el.style.height = `${Math.max(minH, Math.min(maxH, startH + (e.clientY - startY)))}px`;
      onResizeExtra?.();
    };
    const onUp = () => {
      resizing = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      const rect = el.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startW = rect.width;
      startH = rect.height;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  // ---------------------------------------------------------------------
  // "Add title" button + title/description card
  // ---------------------------------------------------------------------
  const addTitleBtn = document.createElement("button");
  addTitleBtn.type = "button";
  addTitleBtn.className = "vsl-print-addtitle-btn";
  addTitleBtn.hidden = true;
  addTitleBtn.innerHTML = '<i class="fas fa-plus" aria-hidden="true"></i> Add title';

  const titleCard = document.createElement("div");
  titleCard.className = "vsl-print-title-card";
  titleCard.hidden = true;
  titleCard.innerHTML = `
    <input type="text" class="vsl-print-title-card__title" placeholder="Untitled Map" maxlength="90">
    <textarea class="vsl-print-title-card__desc" rows="2" maxlength="220" placeholder="Write a description for your map."></textarea>
  `;
  const titleInput = titleCard.querySelector(".vsl-print-title-card__title");
  const descInput = titleCard.querySelector(".vsl-print-title-card__desc");

  addTitleBtn.addEventListener("click", () => {
    addTitleBtn.hidden = true;
    titleCard.hidden = false;
    titleInput.focus();
  });

  viewportWrap.appendChild(addTitleBtn);
  viewportWrap.appendChild(titleCard);

  // ---------------------------------------------------------------------
  // Bottom toolbar
  // ---------------------------------------------------------------------
  const toolbar = document.createElement("div");
  toolbar.className = "vsl-print-toolbar";
  toolbar.hidden = true;
  toolbar.innerHTML = `
    <button type="button" class="vsl-print-toolbar__btn" id="vslPrintSelectAreaBtn" title="Select print area" aria-label="Select print area">
      <i class="fas fa-crosshairs" aria-hidden="true"></i>
    </button>
    <div class="vsl-print-toolbar__sep"></div>
    <button type="button" class="vsl-print-toolbar__btn" id="vslPrintSetupBtn" title="Setup" aria-label="Setup">
      <i class="fas fa-sliders" aria-hidden="true"></i>
    </button>
    <button type="button" class="vsl-print-toolbar__btn vsl-print-toolbar__btn--primary" id="vslPrintSaveBtn" title="Save PDF" aria-label="Save PDF" disabled>
      <i class="fas fa-file-pdf" aria-hidden="true"></i>
    </button>
    <div class="vsl-print-toolbar__sep"></div>
    <button type="button" class="vsl-print-toolbar__btn vsl-print-toolbar__btn--danger" id="vslPrintCancelBtn" title="Cancel" aria-label="Cancel">
      <i class="fas fa-times" aria-hidden="true"></i>
    </button>
  `;
  viewportWrap.appendChild(toolbar);

  const selectAreaBtn = toolbar.querySelector("#vslPrintSelectAreaBtn");
  const setupBtn = toolbar.querySelector("#vslPrintSetupBtn");
  const saveBtn = toolbar.querySelector("#vslPrintSaveBtn");
  const cancelBtn = toolbar.querySelector("#vslPrintCancelBtn");

  // ---------------------------------------------------------------------
  // Setup popup
  // ---------------------------------------------------------------------
  const setupPopup = document.createElement("div");
  setupPopup.className = "vsl-print-setup";
  setupPopup.hidden = true;
  setupPopup.innerHTML = `
    <label class="vsl-print-setup__row"><input type="checkbox" id="vslPrintLegendCb" checked> Legend</label>
    <label class="vsl-print-setup__row"><input type="checkbox" id="vslPrintNorthArrowCb" checked> North arrow</label>
    <label class="vsl-print-setup__row"><input type="checkbox" id="vslPrintDateCb" checked> Date</label>
    <label class="vsl-print-setup__row"><input type="checkbox" id="vslPrintSourceCb" checked> Source</label>
    <p class="vsl-print-setup__heading">Resolution</p>
    <select id="vslPrintResolutionSelect">
      <option value="1">Standard</option>
      <option value="2">High</option>
    </select>
  `;
  viewportWrap.appendChild(setupPopup);

  const legendCb = setupPopup.querySelector("#vslPrintLegendCb");
  const northArrowCb = setupPopup.querySelector("#vslPrintNorthArrowCb");
  const dateCb = setupPopup.querySelector("#vslPrintDateCb");
  const sourceCb = setupPopup.querySelector("#vslPrintSourceCb");
  const resolutionSelect = setupPopup.querySelector("#vslPrintResolutionSelect");

  function readSettings() {
    settings.legend = !!legendCb.checked;
    settings.northArrow = !!northArrowCb.checked;
    settings.date = !!dateCb.checked;
    settings.source = !!sourceCb.checked;
    settings.resolution = resolutionSelect.value;
  }
  [legendCb, northArrowCb, dateCb, sourceCb, resolutionSelect].forEach((el) => {
    el.addEventListener("change", () => {
      readSettings();
      syncOverlays();
    });
  });

  // ---------------------------------------------------------------------
  // Legend + north arrow overlays — same building blocks as before, just
  // anchored to the selection's corners once one exists instead of
  // floating freely over the whole map.
  // ---------------------------------------------------------------------
  function buildLegendOverlay() {
    if (legendEl) return;
    // Reuses the exact same cultivation-status data/colors as the real
    // Legend panel (window.vslBuildLegendList hook, see buildLegendList in
    // map-app.js) so this can never drift from what's actually drawn.
    window.vslBuildLegendList?.();
    const source = document.getElementById("legendStatusList");
    const el = document.createElement("div");
    el.className = "print-legend print-legend--in-selection";
    el.innerHTML =
      '<div class="print-legend__head">' +
        '<span>Legend</span>' +
        '<span class="print-legend__drag" title="Drag to move"><i class="fas fa-up-down-left-right" aria-hidden="true"></i></span>' +
      '</div>' +
      '<ul class="print-legend__list"></ul>' +
      '<div class="print-legend__resize" title="Drag to resize"></div>';
    const list = el.querySelector(".print-legend__list");
    if (source) list.innerHTML = source.innerHTML;
    viewportWrap.appendChild(el);
    legendEl = el;
    wireDrag(el, el.querySelector(".print-legend__head"));
    wireResize(el, el.querySelector(".print-legend__resize"), 120, 60);
    anchorLegendToSelection();
  }

  function removeLegendOverlay() {
    legendEl?.remove();
    legendEl = null;
  }

  /** Drops the legend into the selection's top-right corner — only done
   *  once, right after it's (re)built, not on every subsequent selection
   *  resize/move, so it doesn't fight a manual drag the user did after. */
  function anchorLegendToSelection() {
    if (!legendEl || !selectionRect) return;
    const inset = 10;
    legendEl.style.left = `${selectionRect.left + selectionRect.width - legendEl.offsetWidth - inset}px`;
    legendEl.style.top = `${selectionRect.top + inset}px`;
    legendEl.style.right = "auto";
    legendEl.style.bottom = "auto";
  }

  function buildNorthArrow() {
    if (northArrowEl) return;
    const el = document.createElement("div");
    el.className = "print-north-arrow";
    el.innerHTML = '<i class="fas fa-location-arrow" aria-hidden="true"></i><span>N</span>';
    viewportWrap.appendChild(el);
    northArrowEl = el;
    anchorNorthArrowToSelection();
  }

  function removeNorthArrow() {
    northArrowEl?.remove();
    northArrowEl = null;
  }

  /** Opposite corner from the legend (top-left) — fixed, not draggable,
   *  same as before. */
  function anchorNorthArrowToSelection() {
    if (!northArrowEl || !selectionRect) return;
    const inset = 10;
    northArrowEl.style.left = `${selectionRect.left + inset}px`;
    northArrowEl.style.top = `${selectionRect.top + inset}px`;
    northArrowEl.style.right = "auto";
  }

  /** Legend/north arrow only make sense once a print area is actually
   *  selected — before that there's nowhere sensible to anchor them, so
   *  both stay off regardless of their checkboxes. */
  function syncOverlays() {
    if (selectionRect && settings.legend) buildLegendOverlay(); else removeLegendOverlay();
    if (selectionRect && settings.northArrow) buildNorthArrow(); else removeNorthArrow();
  }

  // ---------------------------------------------------------------------
  // Selection rectangle — drag-to-draw (armed via the crosshair button),
  // then drag-to-move / drag-corner-to-resize like the legend above. The
  // "clear inside, dimmed outside" look is pure CSS (see .vsl-print-
  // selection's box-shadow in styles.css) — nothing to compute here.
  // ---------------------------------------------------------------------
  function updateSelectionRectFromEl() {
    if (!selectionEl) return;
    selectionRect = {
      left: parseFloat(selectionEl.style.left) || 0,
      top: parseFloat(selectionEl.style.top) || 0,
      width: selectionEl.offsetWidth,
      height: selectionEl.offsetHeight
    };
    updateSelectionHint();
  }

  function updateSelectionHint() {
    if (!selectionHintEl || !selectionRect) return;
    const orientation = selectionRect.width >= selectionRect.height ? "Landscape" : "Portrait";
    selectionHintEl.textContent = `${Math.round(selectionRect.width)} × ${Math.round(selectionRect.height)} px — ${orientation}`;
  }

  function ensureSelectionEl() {
    if (selectionEl) return;
    selectionEl = document.createElement("div");
    selectionEl.className = "vsl-print-selection";
    selectionHandleEl = document.createElement("div");
    selectionHandleEl.className = "vsl-print-selection__handle";
    selectionHandleEl.title = "Drag to resize";
    selectionHintEl = document.createElement("div");
    selectionHintEl.className = "vsl-print-selection__hint";
    selectionEl.appendChild(selectionHandleEl);
    selectionEl.appendChild(selectionHintEl);
    viewportWrap.appendChild(selectionEl);

    // Move by dragging the rectangle body itself (not the resize handle —
    // wireResize's own stopPropagation on the handle keeps that from also
    // triggering a move).
    wireDrag(selectionEl, selectionEl, updateSelectionRectFromEl);
    wireResize(selectionEl, selectionHandleEl, 80, 60, updateSelectionRectFromEl);
  }

  function removeSelection() {
    selectionEl?.remove();
    selectionEl = null;
    selectionHandleEl = null;
    selectionHintEl = null;
    selectionRect = null;
    saveBtn.disabled = true;
    removeLegendOverlay();
    removeNorthArrow();
  }

  function viewportPointFromEvent(e) {
    const wrapRect = viewportWrap.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(e.clientX - wrapRect.left, wrapRect.width)),
      y: Math.max(0, Math.min(e.clientY - wrapRect.top, wrapRect.height))
    };
  }

  function onArmedPointerDown(e) {
    if (!armed) return;
    // Ignore clicks that started on the UI chrome itself (toolbar, setup
    // popup, title card) — only an actual click-drag on the map should
    // start drawing a selection.
    if (e.target.closest(".vsl-print-toolbar, .vsl-print-setup, .vsl-print-title-card, .vsl-print-addtitle-btn")) return;
    e.preventDefault();
    drawingFrom = viewportPointFromEvent(e);
    ensureSelectionEl();
    selectionEl.style.left = `${drawingFrom.x}px`;
    selectionEl.style.top = `${drawingFrom.y}px`;
    selectionEl.style.width = "0px";
    selectionEl.style.height = "0px";
    window.addEventListener("pointermove", onArmedPointerMove);
    window.addEventListener("pointerup", onArmedPointerUp);
  }

  function onArmedPointerMove(e) {
    if (!drawingFrom) return;
    const p = viewportPointFromEvent(e);
    const left = Math.min(drawingFrom.x, p.x);
    const top = Math.min(drawingFrom.y, p.y);
    const width = Math.abs(p.x - drawingFrom.x);
    const height = Math.abs(p.y - drawingFrom.y);
    selectionEl.style.left = `${left}px`;
    selectionEl.style.top = `${top}px`;
    selectionEl.style.width = `${width}px`;
    selectionEl.style.height = `${height}px`;
  }

  function onArmedPointerUp() {
    window.removeEventListener("pointermove", onArmedPointerMove);
    window.removeEventListener("pointerup", onArmedPointerUp);
    drawingFrom = null;

    // Enforce a sane minimum so a quick click (near-zero drag) still
    // yields a usable print area instead of a sliver.
    const minSize = 100;
    if (selectionEl.offsetWidth < minSize || selectionEl.offsetHeight < minSize) {
      const wrapRect = viewportWrap.getBoundingClientRect();
      const left = Math.max(0, Math.min(parseFloat(selectionEl.style.left) || 0, wrapRect.width - minSize));
      const top = Math.max(0, Math.min(parseFloat(selectionEl.style.top) || 0, wrapRect.height - minSize));
      selectionEl.style.left = `${left}px`;
      selectionEl.style.top = `${top}px`;
      selectionEl.style.width = `${minSize}px`;
      selectionEl.style.height = `${minSize}px`;
    }

    updateSelectionRectFromEl();
    saveBtn.disabled = false;
    disarmSelection();
    syncOverlays();
  }

  function armSelection() {
    armed = true;
    selectAreaBtn.classList.add("active");
    viewportWrap.classList.add("vsl-print-selecting");
  }
  function disarmSelection() {
    armed = false;
    selectAreaBtn.classList.remove("active");
    viewportWrap.classList.remove("vsl-print-selecting");
  }

  selectAreaBtn.addEventListener("click", () => {
    if (armed) disarmSelection();
    else armSelection();
  });
  viewportWrap.addEventListener("pointerdown", onArmedPointerDown);

  setupBtn.addEventListener("click", () => {
    setupPopup.hidden = !setupPopup.hidden;
    setupBtn.classList.toggle("active", !setupPopup.hidden);
  });

  cancelBtn.addEventListener("click", () => exitPrintMode());

  // ---------------------------------------------------------------------
  // Extent + basemap-only raster capture (Option B + C combined).
  //
  // The page is now built from two independent pieces instead of one flat
  // screenshot:
  //   - The plot/block boundaries + labels + legend + north arrow are real
  //     PDF vector content (drawParcelsAndBlocksVector below) — infinitely
  //     crisp regardless of resolution, which is what actually needed to
  //     be legible.
  //   - Everything else (basemap imagery, drone/sentinel overlays, drawn
  //     features/annotations like roads/houses/trees) is still a raster
  //     capture, using the same canvas-compositing technique as before,
  //     but with blocksLayer/parcelsLayer hidden for the duration of that
  //     capture so they aren't drawn twice, and re-rendered at a deeper
  //     zoom (STANDARD_ZOOM_SCALE / HIGH_ZOOM_SCALE) so the imagery itself
  //     is genuinely sharper, not just upscaled.
  //
  // getPrintExtent() MUST be called before captureBasemapOnly() touches
  // the map's size/resolution — it converts the selection rectangle's
  // on-screen px into geographic (EPSG:3857) coordinates using the map's
  // CURRENT, unmodified view, which is also the extent the vector redraw
  // projects plot geometry against, so the two layers line up.
  // ---------------------------------------------------------------------
  function getPrintExtent() {
    if (!selectionRect) return null;
    const topLeft = map.getCoordinateFromPixel([selectionRect.left, selectionRect.top]);
    const bottomRight = map.getCoordinateFromPixel([
      selectionRect.left + selectionRect.width,
      selectionRect.top + selectionRect.height
    ]);
    if (!topLeft || !bottomRight) return null;
    return [
      Math.min(topLeft[0], bottomRight[0]),
      Math.min(topLeft[1], bottomRight[1]),
      Math.max(topLeft[0], bottomRight[0]),
      Math.max(topLeft[1], bottomRight[1])
    ];
  }

  function captureBasemapOnly(scale, extraWaitMs) {
    return new Promise((resolve, reject) => {
      const origSize = map.getSize();
      const view = map.getView();
      const origResolution = view.getResolution();
      const needsResize = scale > 1 && origSize && origSize[0] && origSize[1];
      const blocksWasVisible = blocksLayer ? blocksLayer.getVisible() : null;
      const parcelsWasVisible = parcelsLayer ? parcelsLayer.getVisible() : null;
      blocksLayer?.setVisible(false);
      parcelsLayer?.setVisible(false);

      function restoreLiveMap() {
        blocksLayer?.setVisible(blocksWasVisible);
        parcelsLayer?.setVisible(parcelsWasVisible);
        if (needsResize) {
          map.setSize(origSize);
          view.setResolution(origResolution);
        }
        map.renderSync();
      }

      function compositeAndResolve() {
        try {
          const size = map.getSize();
          if (!size || !size[0] || !size[1]) throw new Error("Map isn't ready yet.");
          const mapCanvas = document.createElement("canvas");
          mapCanvas.width = size[0];
          mapCanvas.height = size[1];
          const ctx = mapCanvas.getContext("2d");
          Array.prototype.forEach.call(
            map.getViewport().querySelectorAll(".ol-layer canvas, canvas.ol-layer"),
            (canvas) => {
              if (!canvas.width) return;
              const opacity = canvas.parentNode.style.opacity || canvas.style.opacity;
              ctx.globalAlpha = opacity === "" ? 1 : Number(opacity);
              const transform = canvas.style.transform;
              let matrix;
              if (transform) {
                matrix = transform.match(/^matrix\(([^(]*)\)$/)[1].split(",").map(Number);
              } else {
                matrix = [
                  parseFloat(canvas.style.width) / canvas.width, 0,
                  0, parseFloat(canvas.style.height) / canvas.height,
                  0, 0
                ];
              }
              CanvasRenderingContext2D.prototype.setTransform.apply(ctx, matrix);
              ctx.drawImage(canvas, 0, 0);
            }
          );
          ctx.globalAlpha = 1;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          restoreLiveMap();
          resolve(mapCanvas);
        } catch (err) {
          restoreLiveMap();
          reject(err);
        }
      }

      function afterRenderComplete() {
        // "High" gets an explicit extra pause beyond rendercomplete —
        // deeper zooms mean more tiles to fetch, and this gives stragglers
        // a real chance to arrive (and paints them in) before the capture,
        // rather than relying solely on whatever rendercomplete caught.
        if (extraWaitMs > 0) {
          setTimeout(() => {
            map.renderSync();
            compositeAndResolve();
          }, extraWaitMs);
        } else {
          compositeAndResolve();
        }
      }

      if (needsResize) {
        map.setSize([Math.round(origSize[0] * scale), Math.round(origSize[1] * scale)]);
        view.setResolution(origResolution / scale);
      }
      map.once("rendercomplete", afterRenderComplete);
      map.renderSync();
    });
  }

  // ---------------------------------------------------------------------
  // Parcel/block vector redraw (Option B) — projects each feature's real
  // geometry from map coordinates into PDF page points and draws it as
  // actual vector paths/text, reusing the exact same colors/labels as the
  // live map style functions in map-app.js so the print never drifts from
  // what's shown on screen.
  // ---------------------------------------------------------------------
  function makeProjector(extent, drawX, drawY, drawW, drawH) {
    const [minX, minY, maxX, maxY] = extent;
    const spanX = (maxX - minX) || 1;
    const spanY = (maxY - minY) || 1;
    return (coord) => [
      drawX + ((coord[0] - minX) / spanX) * drawW,
      drawY + ((maxY - coord[1]) / spanY) * drawH
    ];
  }

  function parseRgba(str) {
    if (!str) return { rgb: [153, 153, 153], a: 1 };
    const m = String(str).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/i);
    if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] !== undefined ? Number(m[4]) : 1 };
    const hex = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(str).trim());
    if (hex) return { rgb: hex.slice(1).map((h) => parseInt(h, 16)), a: 1 };
    return { rgb: [153, 153, 153], a: 1 };
  }

  /** jsPDF's alpha (GState) support — gracefully degrades to opaque fills
   *  on older jsPDF builds that don't expose it rather than throwing. */
  function setFillAlpha(doc, alpha) {
    try {
      if (doc.GState && doc.setGState) doc.setGState(new doc.GState({ opacity: alpha }));
    } catch { /* no-op — fill stays opaque */ }
  }
  function resetAlpha(doc) {
    try {
      if (doc.GState && doc.setGState) doc.setGState(new doc.GState({ opacity: 1 }));
    } catch { /* no-op */ }
  }

  /** Draws one closed ring (array of [x,y] PDF page points, already
   *  projected) as fill + optional white "halo" stroke + colored stroke,
   *  matching the double-stroke look the live parcels layer uses. */
  function drawClosedPath(doc, pagePoints, opts) {
    if (pagePoints.length < 3) return;
    const [x0, y0] = pagePoints[0];
    const deltas = [];
    for (let i = 1; i < pagePoints.length; i++) {
      deltas.push([pagePoints[i][0] - pagePoints[i - 1][0], pagePoints[i][1] - pagePoints[i - 1][1]]);
    }
    const last = pagePoints[pagePoints.length - 1];
    if (Math.abs(last[0] - x0) > 0.01 || Math.abs(last[1] - y0) > 0.01) {
      deltas.push([x0 - last[0], y0 - last[1]]);
    }
    if (opts.fill) {
      setFillAlpha(doc, opts.fillAlpha ?? 1);
      doc.setFillColor(opts.fill[0], opts.fill[1], opts.fill[2]);
      doc.lines(deltas, x0, y0, [1, 1], "F", true);
      resetAlpha(doc);
    }
    if (opts.haloColor) {
      doc.setDrawColor(opts.haloColor[0], opts.haloColor[1], opts.haloColor[2]);
      doc.setLineWidth(opts.haloWidth ?? 2);
      doc.lines(deltas, x0, y0, [1, 1], "S", true);
    }
    if (opts.strokeColor) {
      doc.setDrawColor(opts.strokeColor[0], opts.strokeColor[1], opts.strokeColor[2]);
      doc.setLineWidth(opts.strokeWidth ?? 0.75);
      doc.lines(deltas, x0, y0, [1, 1], "S", true);
    }
  }

  /** Plain-text "halo" (colored text over a repeated white offset-stamp)
   *  standing in for the stroke-outlined text OL draws on screen — jsPDF
   *  has no single-call equivalent. Cheap and reads fine at label sizes.
   *  Supports embedded \n (jsPDF lays out multi-line text natively), and an
   *  optional `angle` (degrees) for text that follows a line — see
   *  drawEdgeDistanceLabels. A fresh options object is built per doc.text
   *  call because jsPDF reads/normalizes that object internally. */
  function drawHaloText(doc, text, x, y, opts) {
    const { align = "center", fontSize, colorRGB, angle } = opts;
    const textOpts = () => (angle ? { align, angle } : { align });
    doc.setFont("helvetica", "bold");
    doc.setFontSize(fontSize);
    doc.setTextColor(255, 255, 255);
    const d = 0.35;
    [[-d, 0], [d, 0], [0, -d], [0, d], [-d, -d], [d, -d], [-d, d], [d, d]].forEach(([dx, dy]) => {
      doc.text(text, x + dx, y + dy, textOpts());
    });
    doc.setTextColor(colorRGB[0], colorRGB[1], colorRGB[2]);
    doc.text(text, x, y, textOpts());
  }

  function forEachOuterRing(geometry, cb) {
    if (!geometry) return;
    const type = geometry.getType();
    if (type === "Polygon") {
      const rings = geometry.getCoordinates();
      if (rings[0]) cb(rings[0]);
    } else if (type === "MultiPolygon") {
      geometry.getCoordinates().forEach((rings) => {
        if (rings[0]) cb(rings[0]);
      });
    }
  }

  const BLOCK_STROKE_RGB = [211, 47, 47]; // #d32f2f
  const PARCEL_STROKE_RGB = [46, 125, 50]; // #2e7d32
  const EDGE_DISTANCE_RGB = [25, 118, 210]; // #1976d2

  // ---------------------------------------------------------------------
  // TUNABLE — flat label/stroke sizes, in PDF points. These are plain
  // fixed sizes on purpose: the earlier "compute everything dynamically
  // from an effective print resolution" experiment is gone. Standard and
  // High print IDENTICALLY except for one thing — High additionally draws
  // the per-edge distance labels (see PRINT_HIGH_ADDS_EDGE_DISTANCES).
  // ---------------------------------------------------------------------
  const BLOCK_LABEL_PT = 8;        // block name *was 8*
  const BLOCK_STROKE_PT = 0.5;       // block outline *was 1*
  const PARCEL_LABEL_PT = 1;       // plot name / area / ratoon / Alerts(n) was 7
  const PARCEL_LABEL_SIMPLE_PT = 2.5; // plot name only, when the page is busy was 6.5
  const PARCEL_STROKE_PT = 0.5;   // plot outline was 0.85
  const PARCEL_HALO_PT = 1;     // white casing under the plot outline *was 1.75*
  const EDGE_DISTANCE_PT = 5;      // "123.4m" edge labels (High only) was 6

  /** Above this many plots in the selection, plot labels collapse to the
   *  name alone (no area/ratoon) so a wide print doesn't turn into a wall
   *  of stacked text. */
  const SIMPLIFY_LABELS_ABOVE = 150;

  /** The single difference between the Standard and High resolution
   *  settings: High spends its effort on the vector layer by additionally
   *  plotting every plot edge's length. The basemap capture is identical
   *  for both (see BASEMAP_ZOOM_SCALE) — pushing that harder for High is
   *  what made it laggy. */
  const PRINT_HIGH_ADDS_EDGE_DISTANCES = false; // true = High draws edge distances, false = Standard and High identical  

  /** Haversine — good enough for a printed edge-length label, avoids
   *  needing map-app.js's own vincentyDistanceMeters wired through. */
  function haversineMeters(lon1, lat1, lon2, lat2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // TUNABLE — edge-distance label rotation/fit. See drawEdgeDistanceLabels.
  //
  // EDGE_LABEL_ANGLE_SIGN: which way jsPDF's `angle` option turns text.
  //   Page space here has y growing DOWNWARD (project() puts north at the
  //   top), while a positive jsPDF angle rotates counter-clockwise as seen
  //   on the page — so the visual angle of an edge is -atan2(dy, dx), i.e.
  //   sign -1. If the distance labels come out mirrored about the line
  //   (leaning the wrong way relative to their edge), flip this to 1.
  //
  // EDGE_LABEL_FIT_RATIO: a label is skipped when the edge it belongs to
  //   is shorter than (text width x this). Mirrors what OL's
  //   placement:"line" does natively — it refuses to draw text that
  //   wouldn't fit along its line — and is the main thing keeping short
  //   edges from stacking labels on top of each other. Raise it (1.3, 1.6)
  //   to drop more labels and de-clutter; lower it toward 1 to show more.
  //
  // EDGE_LABEL_OFFSET_PT: perpendicular nudge off the boundary line itself,
  //   in points, so text doesn't sit directly on the stroke.
  const EDGE_LABEL_ANGLE_SIGN = -1;
  const EDGE_LABEL_FIT_RATIO = 1.15;
  const EDGE_LABEL_OFFSET_PT = 0;

  /** Per-edge distance labels along a ring — the print equivalent of the
   *  live parcelsLayer style function's `resolution <= 4` segment-length
   *  text, which uses ol.style.Text's placement:"line" to run the text
   *  along each edge. jsPDF has no placement:"line", so this does the same
   *  job manually: rotate the text to the edge's own angle, fold that angle
   *  into (-90, 90] so it never renders upside-down or right-to-left, and
   *  skip edges too short to hold the label (see EDGE_LABEL_FIT_RATIO). */
  function drawEdgeDistanceLabels(doc, ring, project, fontSize) {
    // getTextWidth measures at the CURRENT font/size, so set both before
    // the loop — drawHaloText sets the same pair, so they stay in sync.
    doc.setFont("helvetica", "bold");
    doc.setFontSize(fontSize);

    for (let i = 0; i < ring.length - 1; i++) {
      const pt1 = ring[i];
      const pt2 = ring[i + 1];
      const ll1 = ol.proj.transform(pt1, "EPSG:3857", "EPSG:4326");
      const ll2 = ol.proj.transform(pt2, "EPSG:3857", "EPSG:4326");
      const distM = haversineMeters(ll1[0], ll1[1], ll2[0], ll2[1]);
      if (!(distM > 0)) continue;

      const p1 = project(pt1);
      const p2 = project(pt2);
      const dx = p2[0] - p1[0];
      const dy = p2[1] - p1[1];
      const len = Math.hypot(dx, dy);
      if (!(len > 0)) continue;

      const text = `${distM.toFixed(1)}m`;
      if (doc.getTextWidth(text) * EDGE_LABEL_FIT_RATIO > len) continue; // wouldn't fit along this edge

      // Edge angle in page space, then folded upright: any edge pointing
      // into the left half-plane gets spun 180 degrees so the text still
      // reads left-to-right instead of upside-down. Rotating by 180 doesn't
      // move the text (it's centered on its anchor), only its reading
      // direction, so the perpendicular offset below stays valid either way.
      let angleDeg = EDGE_LABEL_ANGLE_SIGN * Math.atan2(dy, dx) * (180 / Math.PI);
      if (angleDeg > 90) angleDeg -= 180;
      else if (angleDeg <= -90) angleDeg += 180;

      const midX = (p1[0] + p2[0]) / 2;
      const midY = (p1[1] + p2[1]) / 2;
      const lx = midX + (-dy / len) * EDGE_LABEL_OFFSET_PT;
      const ly = midY + (dx / len) * EDGE_LABEL_OFFSET_PT;
      drawHaloText(doc, text, lx, ly, { fontSize, colorRGB: EDGE_DISTANCE_RGB, angle: angleDeg });
    }
  }

  function drawBlockVector(doc, feature, project) {
    const geometry = feature.getGeometry();
    if (!geometry) return;
    const status = feature.get("cultivation_status");
    let fillRGB = null, fillAlpha = 1;
    if (status && CULTIVATION_PALETTE?.[status] && status !== "not_in_cane") {
      const parsed = parseRgba(CULTIVATION_PALETTE[status].fill);
      fillRGB = parsed.rgb;
      fillAlpha = parsed.a;
    }
    forEachOuterRing(geometry, (ring) => {
      drawClosedPath(doc, ring.map(project), {
        fill: fillRGB, fillAlpha,
        strokeColor: BLOCK_STROKE_RGB, strokeWidth: BLOCK_STROKE_PT
      });
    });
    const ip = getFeatureInteriorPoint?.(geometry);
    if (!ip) return;
    const [px, py] = project(ip.getCoordinates());
    const name = String(feature.get("block_name") ?? "").trim() || "—";
    drawHaloText(doc, name, px, py, { fontSize: BLOCK_LABEL_PT, colorRGB: BLOCK_STROKE_RGB });
  }

  function drawParcelVector(doc, feature, project, simplifyLabels, withEdgeDistances) {
    const geometry = feature.getGeometry();
    if (!geometry) return;
    const status = feature.get("cultivation_status");
    let fillRGB = [255, 255, 255], fillAlpha = 0.05;
    if (status && CULTIVATION_PALETTE?.[status] && status !== "not_in_cane") {
      const parsed = parseRgba(CULTIVATION_PALETTE[status].fill);
      fillRGB = parsed.rgb;
      fillAlpha = parsed.a;
    }
    const alertSeverity = feature.get("_alert_severity");
    const alertCount = feature.get("_alert_count");
    if (alertSeverity && ALERT_SEVERITY_FILL?.[alertSeverity]) {
      const parsed = parseRgba(ALERT_SEVERITY_FILL[alertSeverity]);
      fillRGB = parsed.rgb;
      fillAlpha = parsed.a;
    }

    forEachOuterRing(geometry, (ring) => {
      drawClosedPath(doc, ring.map(project), {
        fill: fillRGB, fillAlpha,
        haloColor: [255, 255, 255], haloWidth: PARCEL_HALO_PT,
        strokeColor: PARCEL_STROKE_RGB, strokeWidth: PARCEL_STROKE_PT
      });
    });

    // The one High-resolution extra — plot edge lengths, rotated to follow
    // each edge. Plots only; blocks never had these on screen either.
    if (withEdgeDistances) {
      forEachOuterRing(geometry, (ring) => drawEdgeDistanceLabels(doc, ring, project, EDGE_DISTANCE_PT));
    }

    const ip = getFeatureInteriorPoint?.(geometry);
    if (!ip) return;
    const [px, py] = project(ip.getCoordinates());
    const pLabel = feature.get("parcel_name") || feature.get("parcel_code");
    const label = pLabel != null && pLabel !== "" ? String(pLabel) : "—";

    if (simplifyLabels) {
      drawHaloText(doc, label, px, py, { fontSize: PARCEL_LABEL_SIMPLE_PT, colorRGB: PARCEL_STROKE_RGB });
      return;
    }

    const expArea = feature.get("expected_area_acres");
    const area = expArea ? `${Number(expArea).toFixed(2)} ac` : (surveyFeatureAreaAcresText?.(feature) || "");
    const ratoonVal = feature.get("ratoon_number");
    const hasRatoon = ratoonVal !== null && ratoonVal !== undefined && ratoonVal !== "";
    const ratoonLine = hasRatoon ? `R:${ratoonVal}` : null;
    let text = area ? `${label}\n${area}` : label;
    let lineCount = area ? 2 : 1;
    if (ratoonLine) { text += `\n${ratoonLine}`; lineCount += 1; }

    const fontSize = PARCEL_LABEL_PT;
    drawHaloText(doc, text, px, py, { fontSize, colorRGB: PARCEL_STROKE_RGB });

    if (alertSeverity && alertCount) {
      const alertRGB = parseRgba(ALERT_SEVERITY_COLORS?.[alertSeverity] || "").rgb;
      const offsetPt = (lineCount + 1.6) * fontSize * 0.42;
      drawHaloText(doc, `Alerts(${alertCount})`, px, py + offsetPt, { fontSize, colorRGB: alertRGB });
    }
  }

  /** Draws every block, then every parcel, that intersects `extent` —
   *  blocks first so parcels (drawn on top, same as the live LAND LAYERS
   *  group order) win any visual overlap. Identical for Standard and High
   *  except `isHigh`, which adds the per-edge distance labels. */
  function drawParcelsAndBlocksVector(doc, extent, drawX, drawY, drawW, drawH, isHigh) {
    if (!extent || !blocksLayer || !parcelsLayer) return;
    const project = makeProjector(extent, drawX, drawY, drawW, drawH);
    const blockFeatures = blocksLayer.getSource().getFeaturesInExtent(extent);
    const parcelFeatures = parcelsLayer.getSource().getFeaturesInExtent(extent);
    const simplifyLabels = parcelFeatures.length > SIMPLIFY_LABELS_ABOVE;
    const withEdgeDistances = !!isHigh && PRINT_HIGH_ADDS_EDGE_DISTANCES;
    blockFeatures.forEach((feature) => drawBlockVector(doc, feature, project));
    parcelFeatures.forEach((feature) => drawParcelVector(doc, feature, project, simplifyLabels, withEdgeDistances));
  }

  /** Plain pixel-accurate crop — `rect` must already be in the same pixel
   *  space as `sourceCanvas` (see generatePdf: when the map was captured
   *  at `scale`x via captureBasemapOnly, the selection rect's
   *  on-screen px are multiplied by that same scale before being passed
   *  in here). No resizing/interpolation at all — the whole point of
   *  capturing at higher density up front is that the crop itself needs
   *  no blurry upscale afterward. */
  function cropCanvasToRect(sourceCanvas, rect) {
    const cropCanvas = document.createElement("canvas");
    cropCanvas.width = Math.max(1, Math.round(rect.width));
    cropCanvas.height = Math.max(1, Math.round(rect.height));
    const ctx = cropCanvas.getContext("2d");
    ctx.drawImage(
      sourceCanvas,
      rect.left, rect.top, rect.width, rect.height,
      0, 0, cropCanvas.width, cropCanvas.height
    );
    return cropCanvas;
  }

  /** Full-map overlay shown for the (possibly multi-second, if higher-
   *  resolution tiles need to load) duration of a scale>1 capture — masks
   *  the brief live-map resize/restore from view entirely. */
  const capturingOverlay = document.createElement("div");
  capturingOverlay.className = "vsl-print-capturing-overlay";
  capturingOverlay.hidden = true;
  capturingOverlay.innerHTML =
    '<div class="vsl-print-capturing-overlay__spinner"></div>' +
    '<span class="vsl-print-capturing-overlay__text">Rendering…</span>';
  viewportWrap.appendChild(capturingOverlay);

  function setCapturingOverlay(on, text) {
    const textEl = capturingOverlay.querySelector(".vsl-print-capturing-overlay__text");
    if (textEl && text) textEl.textContent = text;
    capturingOverlay.hidden = !on;
  }

  // Standard OL resolution -> scale-denominator conversion (view resolution
  // is in meters/px at EPSG:3857; getPointResolution corrects that to the
  // true ground meters/px at the view's actual latitude).
  function computeScaleDenominator() {
    const view = map.getView();
    const resolution = view.getResolution();
    const center = view.getCenter();
    const proj = view.getProjection();
    const pointResolution = typeof ol !== "undefined" && ol.proj?.getPointResolution
      ? ol.proj.getPointResolution(proj, resolution, center)
      : resolution;
    const dpi = 96;
    const inchesPerMeter = 39.3701;
    return Math.round(pointResolution * inchesPerMeter * dpi);
  }

  function rgbFromColorString(str) {
    if (!str) return [153, 153, 153];
    const rgbMatch = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgbMatch) return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])];
    const hexMatch = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(str.trim());
    if (hexMatch) return hexMatch.slice(1).map((h) => parseInt(h, 16));
    return [153, 153, 153];
  }

  /** "VSL Map Print <SS>S<MM>M<HH>H<DD>D.pdf" — seconds/minutes/hour/day
   *  of generation time, per the requested S/M/H/D format. */
  function buildPrintFilename() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `VSL Map Print ${pad(d.getSeconds())}S${pad(d.getMinutes())}M${pad(d.getHours())}H${pad(d.getDate())}D.pdf`;
  }

  async function generatePdf() {
    if (!selectionRect) {
      setPrintStatus("Select a print area first.", true);
      return;
    }
    const jsPDFCtor = window.jspdf?.jsPDF;
    if (!jsPDFCtor) {
      setPrintStatus("PDF library didn't load — check your connection and try again.", true);
      return;
    }
    saveBtn.disabled = true;
    const isHigh = settings.resolution === "2";
    // Basemap capture is IDENTICAL for both settings — High's extra effort
    // goes into the vector layer (per-edge distance labels), not into
    // fetching deeper tiles, which is what made it laggy.
    const scale = BASEMAP_ZOOM_SCALE;
    setPrintStatus("Rendering imagery…", false);
    setCapturingOverlay(true, "Rendering imagery…");
    try {
      // Must be read before captureBasemapOnly touches the map's size/
      // resolution — see getPrintExtent's comment above.
      const extent = getPrintExtent();
      const fullCanvas = await captureBasemapOnly(scale, 0);
      const scaledRect = {
        left: selectionRect.left * scale,
        top: selectionRect.top * scale,
        width: selectionRect.width * scale,
        height: selectionRect.height * scale
      };
      const cropped = cropCanvasToRect(fullCanvas, scaledRect);
      const croppedDataUrl = cropped.toDataURL("image/png");

      // Orientation isn't a setting — automatic from whichever side of the
      // selection is longer.
      const orientation = selectionRect.width >= selectionRect.height ? "landscape" : "portrait";
      const doc = new jsPDFCtor({ unit: "pt", format: "a4", orientation });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();

      const margin = 24;
      const title = (titleInput.value || "").trim() || "Untitled Map";
      const description = (descInput.value || "").trim();
      const titleH = description ? 40 : 26;
      const stampH = (settings.date || settings.source) ? 16 : 0;
      const mapTop = margin + titleH;
      const mapAreaW = pageW - margin * 2;
      const mapAreaH = pageH - margin - stampH - mapTop;

      // Letterbox the cropped snapshot into the map frame without
      // distorting its aspect ratio (it should already match mapAreaW/H's
      // ratio closely since orientation was picked from it, but margins
      // mean it's never pixel-exact).
      const snapRatio = cropped.width / cropped.height;
      const areaRatio = mapAreaW / mapAreaH;
      let drawW, drawH, drawX, drawY;
      if (snapRatio > areaRatio) {
        drawW = mapAreaW;
        drawH = mapAreaW / snapRatio;
        drawX = margin;
        drawY = mapTop + (mapAreaH - drawH) / 2;
      } else {
        drawH = mapAreaH;
        drawW = mapAreaH * snapRatio;
        drawX = margin + (mapAreaW - drawW) / 2;
        drawY = mapTop;
      }

      doc.setFillColor(245, 245, 245);
      doc.rect(margin, mapTop, mapAreaW, mapAreaH, "F");
      doc.addImage(croppedDataUrl, "PNG", drawX, drawY, drawW, drawH);

      // Plot/block boundaries + labels — real vectors (Option B), drawn
      // straight on top of the raster basemap image using the same extent
      // it was captured against, clipped to the map frame so nothing
      // spills past the border drawn right after. Which detail tier each
      // feature gets (name only / full name+area+ratoon / + per-edge
      // distances) and how big everything is drawn is decided inside by
      // the print's effective resolution vs. the live map's own zoom
      // thresholds — see the LOD comment above drawBlockVector. This
      // applies the same regardless of the Standard/High Resolution
      // setting, since it's purely about how much of the map the selected
      // area vs. the page represents, not the basemap capture quality.
      doc.saveGraphicsState?.();
      try {
        doc.rect(drawX, drawY, drawW, drawH);
        doc.clip?.();
        doc.discardPath?.();
      } catch { /* clip unsupported — vectors still draw, just unclipped */ }
      drawParcelsAndBlocksVector(doc, extent, drawX, drawY, drawW, drawH, isHigh);
      doc.restoreGraphicsState?.();

      doc.setDrawColor(190);
      doc.rect(margin, mapTop, mapAreaW, mapAreaH, "S");

      // Title + optional description, centered above the map frame.
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.setTextColor(30, 42, 30);
      doc.text(title, pageW / 2, margin + 15, { align: "center" });
      if (description) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(9);
        doc.setTextColor(100, 100, 100);
        doc.text(description, pageW / 2, margin + 29, { align: "center", maxWidth: mapAreaW });
      }

      // Approx. scale, top-right (unaffected by the Setup checkboxes —
      // same as before, just informational).
      const scaleDenom = computeScaleDenominator();
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(100, 100, 100);
      doc.text(`Scale approx. 1:${scaleDenom.toLocaleString()}`, pageW - margin, margin + 15, { align: "right" });

      // North arrow — top-left of the map frame.
      if (settings.northArrow) {
        const naX = drawX + 24;
        const naY = drawY + 34;
        doc.setFillColor(30, 42, 30);
        doc.triangle(naX, naY - 14, naX - 7, naY + 6, naX + 7, naY + 6, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9);
        doc.setTextColor(30, 42, 30);
        doc.text("N", naX, naY + 17, { align: "center" });
      }

      // Legend — redrawn as real vector text/swatches, positioned relative
      // to the SELECTION (not the whole map view) since that's the frame
      // that actually became the page.
      if (settings.legend && legendEl) {
        const items = [...legendEl.querySelectorAll(".print-legend__list .legend-panel__item")]
          .map((li) => ({
            color: li.querySelector(".legend-panel__swatch")?.style.background,
            label: li.querySelector("span:last-child")?.textContent || ""
          }))
          .filter((i) => i.label);

        if (items.length) {
          const legendRect = legendEl.getBoundingClientRect();
          const relX = Math.max(0, Math.min(1, (parseFloat(legendEl.style.left) - selectionRect.left) / selectionRect.width));
          const relY = Math.max(0, Math.min(1, (parseFloat(legendEl.style.top) - selectionRect.top) / selectionRect.height));
          const relW = legendRect.width / selectionRect.width;

          const lx = drawX + relX * drawW;
          const ly = drawY + relY * drawH;
          const lw = Math.max(95, relW * drawW);
          const rowH = 13;
          const lh = 20 + items.length * rowH;

          doc.setFillColor(255, 255, 255);
          doc.setDrawColor(180);
          doc.roundedRect(lx, ly, lw, lh, 3, 3, "FD");
          doc.setFont("helvetica", "bold");
          doc.setFontSize(8.5);
          doc.setTextColor(30, 42, 30);
          doc.text("Legend", lx + 6, ly + 13);
          doc.setFont("helvetica", "normal");
          items.forEach((item, i) => {
            const rowY = ly + 24 + i * rowH;
            const rgb = rgbFromColorString(item.color);
            doc.setFillColor(rgb[0], rgb[1], rgb[2]);
            doc.rect(lx + 6, rowY - 7, 9, 9, "F");
            doc.setFontSize(7.8);
            doc.setTextColor(60, 60, 60);
            doc.text(item.label, lx + 19, rowY);
          });
        }
      }

      // Date/source, stamped bottom-left of the page (each independently
      // toggled in Setup).
      if (settings.date || settings.source) {
        const parts = [];
        if (settings.date) parts.push(new Date().toLocaleDateString());
        if (settings.source) parts.push(window.location.hostname || "Victoria Sugar Webmap");
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(130, 130, 130);
        doc.text(parts.join("  •  "), margin, pageH - margin + 2, { align: "left" });
      }

      doc.save(buildPrintFilename());
      setPrintStatus("PDF downloaded.", false);
    } catch (err) {
      console.error("[Victoria Print] Generate PDF failed:", err);
      setPrintStatus(`Couldn't generate PDF: ${err.message}`, true);
    } finally {
      setCapturingOverlay(false);
      saveBtn.disabled = !selectionRect;
    }
  }

  saveBtn.addEventListener("click", generatePdf);

  // ---------------------------------------------------------------------
  // Print mode enter/exit
  // ---------------------------------------------------------------------
  function enterPrintMode() {
    closeOtherPanels?.();
    printModeActive = true;
    viewportWrap.classList.add("vsl-print-mode");
    addTitleBtn.hidden = false;
    toolbar.hidden = false;
    topBtn.classList.add("active");
    topBtn.setAttribute("aria-expanded", "true");
    readSettings();
  }

  function exitPrintMode() {
    printModeActive = false;
    disarmSelection();
    viewportWrap.classList.remove("vsl-print-mode");
    addTitleBtn.hidden = true;
    titleCard.hidden = true;
    toolbar.hidden = true;
    setupPopup.hidden = true;
    setupBtn.classList.remove("active");
    removeSelection();
    setCapturingOverlay(false);
    topBtn.classList.remove("active");
    topBtn.setAttribute("aria-expanded", "false");
    setPrintStatus("", false);
  }

  topBtn.addEventListener("click", () => {
    if (printModeActive) exitPrintMode(); else enterPrintMode();
  });

  // So map-app.js's shared closeSearchPanel/closeUAM/closeParcelStatusPanel
  // functions (called from many places — Measure button, Survey button,
  // Search button, etc.) can also close print mode for mutual exclusivity,
  // the same loosely-coupled window.* hook pattern used throughout this app.
  window.vslClosePrintPanel = exitPrintMode;

  return { enterPrintMode, exitPrintMode };
}
