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
//      OpenLayers' own pan/zoom interactions are switched off for the
//      duration of the drag (see suspendMapInteractions) so dragging draws
//      a box instead of panning the map. A plain click with no drag still
//      yields a 100x100px box you can then move and resize.
//   3. The legend and north arrow are NOT shown on the live map. They have
//      fixed homes in a side column on the printed page (see the layout
//      sketch in generatePdf) — nothing to drag or resize.
//   4. The toolbar's gear button opens a small setup window — its own
//      header and close button — holding the legend/north arrow/date/
//      source toggles. There is deliberately no quality or resolution
//      choice; every print uses the one pipeline below. Page orientation
//      isn't a setting either; it's derived automatically from whichever
//      side of the selection (width vs height) is longer.
//   5. Save PDF builds the page from two independent pieces: the basemap
//      (+ drone/sentinel/annotation layers) is captured as a raster image
//      — blocksLayer/parcelsLayer hidden for that capture, re-rendered at a
//      modest fixed zoom (BASEMAP_ZOOM_SCALE) via the "composite every
//      .ol-layer canvas onto one canvas" technique js/feature-export.js
//      uses for single-feature PDFs — while the plot/block boundaries and
//      labels are drawn as genuine PDF vectors straight on top (projected
//      from their real map geometry, see drawMapVectors), so
//      the text never depends on pixel density at all. Every plot keeps its
//      full name/area/ratoon label; how big all of it comes out is driven
//      purely by the selection's ground size in km, so a wide selection
//      simply prints smaller (see computePrintSizes). The north arrow and
//      legend are drawn as boxed vector cells in the side column, and the
//      title and date/source line are real text too.
//
// Filename: "VSL Map Print <SS>S<MM>M<HH>H<DD>D.pdf" (seconds/minutes/
// hour/day of when it was generated) per the user's spec.

export function initPrintTool({
  map, setStatus, statusEl, closeOtherPanels,
  // Layer refs + styling data — every one of these is redrawn as real PDF
  // vectors rather than rasterized. See drawMapVectors below.
  blocksLayer, parcelsLayer, estatesLayer, titlesLayer, getFeaturesLayer, getFeatureLabelsLayer,
  CULTIVATION_PALETTE, CULTIVATION_STATUS_LABELS, ALERT_SEVERITY_FILL,
  ALERT_SEVERITY_COLORS, getFeatureInteriorPoint, surveyFeatureAreaAcresText
}) {
  const topBtn = document.getElementById("printTopBtn");
  const viewportWrap = document.querySelector(".map-viewport-wrap");
  if (!topBtn || !viewportWrap || !map) return null;

  let printModeActive = false;
  let armed = false; // crosshair "select area" mode is on, next drag on the map defines the rect
  let drawingFrom = null; // { x, y } in viewportWrap-relative px, while a drag is in progress

  let selectionEl = null;
  let selectionHandleEl = null; // single bottom-right grip
  let selectionHintEl = null;
  let selectionRect = null; // { left, top, width, height } in viewportWrap-relative px, once drawn

  /** Text size runs 1–10 with 5 as the neutral default: the BASE_* text
   *  constants are calibrated at 5, and the chosen value divided by 5
   *  becomes the multiplier applied to them. So 5 = exactly the constants
   *  as written, 10 = double, 2 = 0.4x. Line widths are NOT affected —
   *  only text. */
  const TEXT_SIZE_DEFAULT = 5;

  /** Icon size works exactly like text size: 1–10 with 5 neutral, and the
   *  chosen value over 5 becomes the multiplier on BASE_FEATURE_ICON_PT
   *  (and the dot fallback). Independent of text size so icons can be
   *  dialled up without inflating every label with them. */
  const ICON_SIZE_DEFAULT = 5;

  /**
   * Print settings, grouped the same way the settings window's tabs are.
   * `featureTypes` is null until the user touches the Features tab, which
   * means "every type" — that way a newly-drawn feature type shows up on
   * prints without anyone having to go and tick it.
   */
  const settings = {
    // Text labels
    textSize: TEXT_SIZE_DEFAULT,
    // Features
    iconSize: ICON_SIZE_DEFAULT,
    labels: {
      estate: true, block: true, plot: true, area: true,
      ratoon: true, feature: true, distance: false, alerts: true,
      // Land Title name + area — its own toggle, mirroring the plot area one.
      titleDetails: true
    },
    // Layers
    layers: { estate: true, block: true, plot: true, titleBoundary: true },
    hatching: true,
    // Basemaps — off by default: the vectors are the point of the print,
    // and skipping the imagery also skips the slow tile capture.
    basemap: false,
    boostQuality: false,
    // Features — null = all types
    featureTypes: null,
    // Map details
    details: {
      title: true, legend: true, northArrow: true, qr: true,
      counts: true, comments: true, date: true, source: true, scale: true, printedBy: false
    }
  };

  /** When on (the default), the selection can only be drawn/resized at the
   *  exact aspect ratio the printed map area will have, so the imagery
   *  fills its frame edge-to-edge with no letterboxing. */
  let lockAspect = true;

  // Zoom-in factor for the basemap-only raster capture — how much denser
  // than the live on-screen view the basemap tiles get re-requested and
  // rendered at before being cropped into the page. Kept modest on
  // purpose: pushing it to 6x (plus a long extra tile-load wait) was tried
  // and was simply slow, without improving what actually needed to be
  // legible, since the boundaries and labels are PDF vectors rather than
  // pixels. This applies to every print — there's no quality setting.
  const BASEMAP_ZOOM_SCALE = 3;

  /** "Higher image quality" in Setup: renders the basemap denser still and
   *  then waits before grabbing the pixels, so the extra tiles that deeper
   *  zoom needs have time to actually download. That wait is the whole
   *  point — rendercomplete fires as soon as the tiles OL asked for are
   *  in, but a denser render asks for many more of them. */
  const BASEMAP_ZOOM_SCALE_BOOST = 5;
  const BOOST_TILE_WAIT_MS = 1800;

  // ---------------------------------------------------------------------
  // PAGE LAYOUT
  //
  // Two layouts, picked automatically from the selection's own shape:
  //
  //   LANDSCAPE                        PORTRAIT
  //     TITLE                            TITLE
  //   ┌──────────┐ ┌──┐  north arrow   ┌──────────────┐
  //   │          │ ├──┤                │              │
  //   │   MAP    │ │L │  legend        │     MAP      │
  //   │          │ │E │                │              │
  //   └──────────┘ └──┘                └──────────────┘
  //   date • source        scale       ┌───────────┐┌─┐  legend bar + arrow
  //                                    date • source    scale
  //
  // computePageLayout() below is the single source of truth for both — the
  // PDF drawing AND the on-screen selection ratio lock read from it, so
  // the selected area always matches the frame it will be printed into.
  // ---------------------------------------------------------------------
  const PAGE_MARGIN_PT = 24;
  const PAGE_TITLE_BAND_PT = 26;
  const PAGE_STAMP_BAND_PT = 16;
  const PAGE_GAP_PT = 10;

  /** Landscape: side column down the right. The legend fills it from the
   *  top; summary and then a QR + north-arrow row sit at the bottom. */
  const SIDE_COLUMN_PT = 110;

  /** Portrait: a legend bar across the bottom with a square north-arrow
   *  cell at its right end. */
  /** Portrait bottom-bar height. Sized so the legend's rows just fill it —
   *  it also sets how big the stacked QR/north-arrow squares come out,
   *  since those split the bar's height between them. */
  const BOTTOM_BAR_PT = 120;
  const BOTTOM_ARROW_W_PT = 62;

  /** QR cell caption height. In landscape the QR is deliberately the same
   *  square as the north-arrow box rather than the full column width —
   *  a 110pt QR ate most of the column and left the legend no room for its
   *  Features group. Portrait still sizes it to the bar height. */
  /** Cap on the bottom-row squares (QR / north arrow) so they stay
   *  sensible if the side column is ever widened. */
  const BOTTOM_SQUARE_MAX_PT = 56;

  /** Gap between the stacked cells inside the landscape side column
   *  (arrow / legend / summary / QR). Tighter than PAGE_GAP_PT — that one
   *  separates the map from the column, where a bigger gap reads better. */
  const SIDE_CELL_GAP_PT = 4;

  /** Selection summary cell — a fixed block in landscape (it holds four
   *  label/value rows), a fixed width in the portrait bottom bar. */
  const SUMMARY_BOX_PT = 60;
  /** Comments box width in the portrait bar — kept narrow so the legend
   *  gets the width instead; it's reserved blank space, not content. */
  const SUMMARY_BAR_W_PT = 80;

  /** Width reserved for the right-aligned count column on a legend row. */
  const COUNT_COL_PT = 22;

  /** Gutter between legend columns — the vertical separator rule is drawn
   *  down its middle, so this is the space around that line too. */
  const LEGEND_COL_GAP_PT = 14;

  /** Legend columns in the portrait bottom bar. The bar is wide and short,
   *  so rows flow down each column and wrap into the next. */
  const PORTRAIT_LEGEND_COLUMNS = 3;

  /** A4 in points, as jsPDF reports it. */
  const A4_LONG_PT = 841.89;
  const A4_SHORT_PT = 595.28;

  /**
   * Every rectangle on the page, for one orientation and one set of
   * Setup toggles. `mapAreaW/H` is the frame the captured imagery fills —
   * its ratio is what the selection lock snaps to.
   */
  function computePageLayout(orientation, opts) {
    const showLegend = !!opts.legend;
    const showNorthArrow = !!opts.northArrow;
    const showQr = !!opts.qr;
    const showSummary = !!opts.summary;
    const showStamp = !!opts.stamp;
    const landscape = orientation === "landscape";
    const pageW = landscape ? A4_LONG_PT : A4_SHORT_PT;
    const pageH = landscape ? A4_SHORT_PT : A4_LONG_PT;

    const m = PAGE_MARGIN_PT;
    const mapTop = m + PAGE_TITLE_BAND_PT;
    const stampH = showStamp ? PAGE_STAMP_BAND_PT : 0;
    const hasExtras = showLegend || showNorthArrow || showQr || showSummary;

    const layout = {
      pageW, pageH, margin: m, mapTop, stampH, landscape,
      showLegend, showNorthArrow, showQr, showSummary
    };

    if (landscape) {
      // Extras stack down the right-hand column, bottom-anchored in the
      // order the user reads them: north arrow, legend, summary, QR.
      const sideColW = hasExtras ? SIDE_COLUMN_PT : 0;
      const sideGap = sideColW ? PAGE_GAP_PT : 0;
      layout.mapAreaW = pageW - m * 2 - sideColW - sideGap;
      layout.mapAreaH = pageH - m - stampH - mapTop;
      layout.sideColW = sideColW;
      layout.sideX = m + layout.mapAreaW + sideGap;

      const frameBottom = mapTop + layout.mapAreaH;

      // Bottom row: QR and north arrow sit SIDE BY SIDE as two squares,
      // rather than the arrow taking a full-width cell at the top of the
      // column. That frees the whole top of the column for the legend,
      // which is what needed the room. Each is half the column, or the
      // full column when only one of them is switched on.
      const bothBottom = showQr && showNorthArrow;
      const bottomCellW = bothBottom ? (sideColW - SIDE_CELL_GAP_PT) / 2 : sideColW;
      const bottomRowH = (showQr || showNorthArrow)
        ? Math.min(bottomCellW, BOTTOM_SQUARE_MAX_PT)
        : 0;
      layout.bottomRowH = bottomRowH;
      layout.bottomRowY = frameBottom - bottomRowH;
      layout.bottomCellW = Math.min(bottomCellW, BOTTOM_SQUARE_MAX_PT);
      // QR on the left, arrow on the right (see the reference layout).
      layout.qrSize = showQr ? layout.bottomCellW : 0;
      layout.qrX = layout.sideX;
      layout.qrY = layout.bottomRowY;
      layout.arrowW = showNorthArrow ? layout.bottomCellW : 0;
      layout.arrowX = showQr
        ? layout.sideX + layout.bottomCellW + SIDE_CELL_GAP_PT
        : layout.sideX;
      layout.arrowY = layout.bottomRowY;

      // Summary sits directly above that row.
      layout.summaryH = showSummary ? SUMMARY_BOX_PT : 0;
      layout.summaryY = layout.bottomRowY
        - (bottomRowH && showSummary ? SIDE_CELL_GAP_PT : 0)
        - layout.summaryH;
    } else {
      // Extras live in a bar across the bottom: legend, summary, QR, then
      // the north arrow at the right end.
      const barH = hasExtras ? BOTTOM_BAR_PT : 0;
      const barGap = barH ? PAGE_GAP_PT : 0;
      layout.mapAreaW = pageW - m * 2;
      layout.mapAreaH = pageH - m - stampH - mapTop - barH - barGap;
      layout.barH = barH;
      layout.barY = mapTop + layout.mapAreaH + barGap;
      // The QR and north arrow STACK into one narrow right-hand column —
      // QR on top, arrow beneath — rather than sitting side by side. Two
      // squares stacked are far narrower than two side by side, and that
      // reclaimed width goes to the legend, which is the cell that
      // actually needs it. The stack's width is whatever makes each half
      // square, so the column ends up exactly bar-height tall.
      const stackBoth = showQr && showNorthArrow;
      const stackSquare = stackBoth ? (barH - SIDE_CELL_GAP_PT) / 2 : barH;
      layout.stackSquare = stackSquare;
      layout.stackW = (showQr || showNorthArrow) ? stackSquare : 0;
      layout.qrSize = showQr ? stackSquare : 0;
      layout.barArrowW = showNorthArrow ? stackSquare : 0;
      layout.summaryW = showSummary ? SUMMARY_BAR_W_PT : 0;

      // One gap between each pair of cells present — legend | comments |
      // stack (the stack counts once, however many squares are in it).
      const cells = [showLegend, showSummary, !!layout.stackW].filter(Boolean).length;
      const gaps = PAGE_GAP_PT * Math.max(0, cells - 1);
      layout.barLegendW = layout.mapAreaW - layout.stackW - layout.summaryW - gaps;

      let x = m + (showLegend ? layout.barLegendW + PAGE_GAP_PT : 0);
      layout.summaryX = x;
      if (showSummary) x += layout.summaryW + PAGE_GAP_PT;
      layout.stackX = x;
      layout.qrX = x;
      layout.qrY = layout.barY;
      layout.arrowX = x;
      // Arrow sits under the QR when both are on, else takes the column.
      layout.arrowY = showQr ? layout.barY + stackSquare + SIDE_CELL_GAP_PT : layout.barY;
    }
    return layout;
  }

  /** Width:height the selection must hold to fill the printed map frame
   *  exactly, for the orientation the user is aiming at. */
  function targetAspectRatio(orientation) {
    const l = computePageLayout(orientation, {
      legend: settings.details.legend,
      northArrow: settings.details.northArrow,
      qr: settings.details.qr,
      summary: settings.details.comments,
      stamp: settings.details.date || settings.details.source || settings.details.printedBy
    });
    return l.mapAreaW / l.mapAreaH;
  }

  function setPrintStatus(msg, isError) {
    setStatus?.(statusEl, msg, isError);
  }

  // ---------------------------------------------------------------------
  // Generic drag/resize helpers — now used only by the selection
  // rectangle (the legend and north arrow used to be draggable overlays
  // too; they have fixed homes on the printed page instead).
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

  /** `enabledFn` (optional) lets a handle be wired once but only act when
   *  it returns true — used so the bottom-right handle does a free resize
   *  when the aspect lock is off and a ratio-locked one when it's on. */
  function wireResize(el, handle, minW, minH, onResizeExtra, enabledFn) {
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
      if (enabledFn && !enabledFn()) return;
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
  // "Add title" button + editable title card
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
  `;
  const titleInput = titleCard.querySelector(".vsl-print-title-card__title");

  /** The card has two states. Editing: full size, input focusable and its
   *  placeholder visible. Resting (after it loses focus): the --resting
   *  class shrinks it to a compact caption. The value itself is never
   *  touched — generatePdf still reads titleInput exactly as before. */
  function setTitleEditing(editing) {
    titleCard.classList.toggle("vsl-print-title-card--resting", !editing);
    // Read-only at rest, so the caret can't land in it without going
    // through the click handler that restores editing.
    titleInput.readOnly = !editing;
  }

  function enterTitleEditing() {
    addTitleBtn.hidden = true;
    titleCard.hidden = false;
    setTitleEditing(true);
    titleInput.focus();
  }

  function leaveTitleEditing() {
    // Nothing typed — fold the card back into the button so print mode
    // looks as clean as it did before the user opened it.
    if (!titleInput.value.trim()) {
      titleCard.hidden = true;
      addTitleBtn.hidden = false;
      return;
    }
    setTitleEditing(false);
  }

  addTitleBtn.addEventListener("click", enterTitleEditing);

  // Clicking the resting card puts it back into edit mode.
  titleCard.addEventListener("click", () => {
    if (titleCard.classList.contains("vsl-print-title-card--resting")) enterTitleEditing();
  });

  titleCard.addEventListener("focusout", leaveTitleEditing);

  // Escape or Enter finishes editing.
  titleCard.addEventListener("keydown", (e) => {
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      e.target.blur();
    }
  });

  // ---------------------------------------------------------------------
  // Bottom toolbar
  // ---------------------------------------------------------------------
  const toolbar = document.createElement("div");
  toolbar.className = "vsl-print-toolbar";
  toolbar.hidden = true;
  // Font Awesome 6 glyphs chosen to read like the reference artwork:
  //   fa-vector-square — a marquee/selection box with corner handles, the
  //                      closest FA has to a "select area" tool icon.
  //   fa-gear          — settings.
  //   fa-file-pdf      — export to PDF.
  // Glyphs rather than <img>, so hover/active/disabled states can actually
  // recolor them (a raster icon can't be restyled by CSS).
  toolbar.innerHTML = `
    <div class="vsl-print-split">
      <button type="button" class="vsl-print-toolbar__btn vsl-print-split__main" id="vslPrintSelectAreaBtn" title="Select print area" aria-label="Select print area">
        <i class="fas fa-vector-square" aria-hidden="true"></i>
      </button>
      <button type="button" class="vsl-print-split__caret" id="vslPrintSelectOptsBtn" title="Selection options" aria-label="Selection options" aria-expanded="false">
        <i class="fas fa-chevron-up" aria-hidden="true"></i>
      </button>
      <div class="vsl-print-lock-pop" id="vslPrintLockPop" hidden>
        <label class="vsl-print-lock-pop__row">
          <input type="checkbox" id="vslPrintLockAspectCb" checked>
          <span>Lock Aspect Ratio</span>
        </label>
      </div>
    </div>
    <div class="vsl-print-toolbar__sep"></div>
    <button type="button" class="vsl-print-toolbar__btn" id="vslPrintSetupBtn" title="Setup" aria-label="Setup">
      <i class="fas fa-gear" aria-hidden="true"></i>
    </button>
    <button type="button" class="vsl-print-toolbar__btn vsl-print-toolbar__btn--primary" id="vslPrintSaveBtn" title="Save PDF" aria-label="Save PDF" disabled>
      <i class="fas fa-file-pdf" aria-hidden="true"></i>
    </button>
    <div class="vsl-print-toolbar__sep"></div>
    <button type="button" class="vsl-print-toolbar__btn vsl-print-toolbar__btn--danger" id="vslPrintCancelBtn" title="Cancel" aria-label="Cancel">
      <i class="fas fa-times" aria-hidden="true"></i>
    </button>
  `;

  // ---------------------------------------------------------------------
  // Bottom stack — the "Add title" button / title card and the toolbar all
  // live in ONE wrapper pinned to the bottom-center, stacked vertically,
  // instead of the card floating at the top independently. The wrapper
  // itself is pointer-events:none (see styles.css) with its children
  // re-enabling pointer events, so the transparent gap between the card
  // and the toolbar doesn't swallow clicks meant for the map underneath.
  // ---------------------------------------------------------------------
  const bottomStack = document.createElement("div");
  bottomStack.className = "vsl-print-bottom-stack";
  bottomStack.appendChild(addTitleBtn);
  bottomStack.appendChild(titleCard);
  bottomStack.appendChild(toolbar);
  viewportWrap.appendChild(bottomStack);

  const selectAreaBtn = toolbar.querySelector("#vslPrintSelectAreaBtn");
  const selectOptsBtn = toolbar.querySelector("#vslPrintSelectOptsBtn");
  const lockPop = toolbar.querySelector("#vslPrintLockPop");
  const lockAspectCb = toolbar.querySelector("#vslPrintLockAspectCb");
  const setupBtn = toolbar.querySelector("#vslPrintSetupBtn");
  const saveBtn = toolbar.querySelector("#vslPrintSaveBtn");
  const cancelBtn = toolbar.querySelector("#vslPrintCancelBtn");

  // --- Lock-aspect dropdown -------------------------------------------
  let lockPopOutsideHandler = null;

  function closeLockPop() {
    lockPop.hidden = true;
    selectOptsBtn.classList.remove("active");
    selectOptsBtn.setAttribute("aria-expanded", "false");
    if (lockPopOutsideHandler) {
      document.removeEventListener("pointerdown", lockPopOutsideHandler, true);
      lockPopOutsideHandler = null;
    }
  }

  function openLockPop() {
    lockPop.hidden = false;
    selectOptsBtn.classList.add("active");
    selectOptsBtn.setAttribute("aria-expanded", "true");
    if (lockPopOutsideHandler) return;
    lockPopOutsideHandler = (e) => {
      if (lockPop.contains(e.target) || selectOptsBtn.contains(e.target)) return;
      closeLockPop();
    };
    document.addEventListener("pointerdown", lockPopOutsideHandler, true);
  }

  selectOptsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (lockPop.hidden) openLockPop();
    else closeLockPop();
  });

  lockAspectCb.addEventListener("change", () => {
    lockAspect = !!lockAspectCb.checked;
    syncHandleVisibility();
    // Turning the lock ON corrects whatever free-form box is already there.
    reflowLockedSelection();
    updateSelectionHint();
  });

  // ---------------------------------------------------------------------
  // Print settings window
  //
  // A tabbed window (vertical tabs, same shape as the Survey window) rather
  // than one long list — there are far more options now than fit on a
  // single page. Built data-driven from SETTINGS_TABS so adding an option
  // is one entry, not new markup + new wiring in three places.
  //
  // Field kinds:
  //   check  — boolean, bound to settings[group][key]
  //   select — numeric/string, bound to settings[key]
  //   note   — static hint line, no binding
  // `reflow: true` marks a field that changes the PAGE FURNITURE (and so
  // the map frame's aspect ratio), which means a ratio-locked selection has
  // to be re-snapped when it changes.
  // ---------------------------------------------------------------------
  const SETTINGS_TABS = [
    {
      id: "labels", label: "Text labels", icon: "fa-font",
      fields: [
        { kind: "select", key: "textSize", label: "Text size",
          options: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], value: TEXT_SIZE_DEFAULT },
        { kind: "check", group: "labels", key: "estate", label: "Estate names" },
        { kind: "check", group: "labels", key: "block", label: "Block names" },
        { kind: "check", group: "labels", key: "plot", label: "Plot names" },
        { kind: "check", group: "labels", key: "area", label: "Plot area" },
        { kind: "check", group: "labels", key: "titleDetails", label: "Title Details" },
        { kind: "check", group: "labels", key: "ratoon", label: "Ratoon numbers" },
        { kind: "check", group: "labels", key: "feature", label: "Feature labels" },
        { kind: "check", group: "labels", key: "alerts", label: "Alerts" },
        { kind: "check", group: "labels", key: "distance", label: "Line distances" }
      ]
    },
    {
      id: "layers", label: "Layers", icon: "fa-layer-group",
      fields: [
        { kind: "check", group: "layers", key: "estate", label: "Estates" },
        { kind: "check", group: "layers", key: "block", label: "Blocks" },
        { kind: "check", group: "layers", key: "plot", label: "Plots" },
        { kind: "check", group: "layers", key: "titleBoundary", label: "Land Titles" },
        { kind: "check", key: "hatching", label: "Status colour fills" },
      ]
    },
    {
      id: "basemaps", label: "Basemaps", icon: "fa-image",
      fields: [
        { kind: "check", key: "basemap", label: "Print basemap image", id: "vslPrintBasemapCb" },
        { kind: "check", key: "boostQuality", label: "Higher image quality (slower)", sub: true, id: "vslPrintBoostCb" },
      ]
    },
    {
      id: "features", label: "Features", icon: "fa-shapes", custom: "features",
      fields: [
        { kind: "select", key: "iconSize", label: "Icon size",
          options: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], value: ICON_SIZE_DEFAULT }
      ]
    },
    {
      id: "details", label: "Map details", icon: "fa-file-lines",
      fields: [
        { kind: "check", group: "details", key: "title", label: "Title", reflow: true },
        { kind: "check", group: "details", key: "legend", label: "Legend", reflow: true },
        { kind: "check", group: "details", key: "northArrow", label: "North arrow", reflow: true },
        { kind: "check", group: "details", key: "counts", label: "Show counts in legend" },
        { kind: "check", group: "details", key: "comments", label: "Comments box", reflow: true },
        { kind: "check", group: "details", key: "qr", label: "Location QR", reflow: true },
        { kind: "check", group: "details", key: "date", label: "Date", reflow: true },
        { kind: "check", group: "details", key: "source", label: "Source", reflow: true },
        { kind: "check", group: "details", key: "scale", label: "Scale" },
        { kind: "check", group: "details", key: "printedBy", label: "Printed by" }
      ]
    }
  ];

  const setupPopup = document.createElement("div");
  setupPopup.className = "vsl-print-setup";
  setupPopup.hidden = true;

  const tabBtnsHtml = SETTINGS_TABS.map((t, i) =>
    `<button type="button" class="vsl-print-settings__tab${i === 0 ? " active" : ""}" data-tab="${t.id}">
       <i class="fas ${t.icon}" aria-hidden="true"></i><span>${t.label}</span>
     </button>`).join("");

  function fieldHtml(f) {
    if (f.kind === "note") {
      return `<p class="vsl-print-setup__note"${f.id ? ` id="${f.id}"` : ""}${f.hidden ? " hidden" : ""}>${f.text}</p>`;
    }
    if (f.kind === "select") {
      const opts = f.options.map((o) => `<option value="${o}"${o === f.value ? " selected" : ""}>${o}</option>`).join("");
      return `<label class="vsl-print-setup__row vsl-print-setup__row--select">
                <span>${f.label}</span>
                <select data-key="${f.key}">${opts}</select>
              </label>`;
    }
    const cls = `vsl-print-setup__row${f.sub ? " vsl-print-setup__row--sub" : ""}`;
    // Initial checked state comes from the settings object, so the markup
    // and the state agree from the very first render. (They used to
    // disagree — every box rendered unchecked, and enterPrintMode's
    // readSettings() then read that back and switched everything off.)
    const initial = f.group ? settings[f.group]?.[f.key] : settings[f.key];
    return `<label class="${cls}">
              <input type="checkbox"
                     data-group="${f.group || ""}" data-key="${f.key}"
                     ${f.id ? `id="${f.id}"` : ""}
                     ${f.reflow ? 'data-reflow="1"' : ""}
                     ${initial ? "checked" : ""}
                     ${f.disabled ? "disabled" : ""}>
              <span>${f.label}</span>
            </label>`;
  }

  // A tab can have plain fields, custom content, or both — the Features
  // tab has an icon-size dropdown above its generated type list.
  const tabPanesHtml = SETTINGS_TABS.map((t, i) => {
    let body = (t.fields || []).map(fieldHtml).join("");
    if (t.custom === "features") {
      body += `<div class="vsl-print-features" id="vslPrintFeatureList"></div>`;
    }
    return `<div class="vsl-print-settings__pane${i === 0 ? " active" : ""}" data-pane="${t.id}">${body}</div>`;
  }).join("");

  setupPopup.innerHTML = `
    <div class="vsl-print-setup__head">
      <span class="vsl-print-setup__title"><i class="fas fa-gear" aria-hidden="true"></i> Print settings</span>
      <button type="button" class="vsl-print-setup__close" id="vslPrintSetupCloseBtn" title="Close" aria-label="Close">
        <i class="fas fa-times" aria-hidden="true"></i>
      </button>
    </div>
    <div class="vsl-print-settings">
      <div class="vsl-print-settings__tabs">${tabBtnsHtml}</div>
      <div class="vsl-print-settings__body">${tabPanesHtml}</div>
    </div>
  `;
  viewportWrap.appendChild(setupPopup);

  const setupCloseBtn = setupPopup.querySelector("#vslPrintSetupCloseBtn");
  const featureListEl = setupPopup.querySelector("#vslPrintFeatureList");
  const basemapCb = setupPopup.querySelector("#vslPrintBasemapCb");
  const boostCb = setupPopup.querySelector("#vslPrintBoostCb");
  const basemapNote = setupPopup.querySelector("#vslPrintBasemapNote");

  // Tab switching.
  setupPopup.querySelectorAll(".vsl-print-settings__tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.tab;
      setupPopup.querySelectorAll(".vsl-print-settings__tab")
        .forEach((b) => b.classList.toggle("active", b === btn));
      setupPopup.querySelectorAll(".vsl-print-settings__pane")
        .forEach((p) => p.classList.toggle("active", p.dataset.pane === id));
    });
  });

  /** Pushes the settings object OUT to the controls — used on open, so the
   *  window always reflects real state rather than its markup defaults. */
  function writeSettingsToForm() {
    setupPopup.querySelectorAll("input[type=checkbox][data-key]").forEach((el) => {
      const g = el.dataset.group;
      const v = g ? settings[g]?.[el.dataset.key] : settings[el.dataset.key];
      el.checked = !!v;
    });
    setupPopup.querySelectorAll("select[data-key]").forEach((el) => {
      el.value = String(settings[el.dataset.key]);
    });
  }

  /** Pulls the controls back INTO the settings object. */
  function readSettings() {
    setupPopup.querySelectorAll("input[type=checkbox][data-key]").forEach((el) => {
      const g = el.dataset.group;
      if (g) { if (settings[g]) settings[g][el.dataset.key] = !!el.checked; }
      else settings[el.dataset.key] = !!el.checked;
    });
    setupPopup.querySelectorAll("select[data-key]").forEach((el) => {
      // Fall back to whatever the setting already held, so a malformed
      // value can't silently reset textSize and iconSize to each other's
      // default.
      settings[el.dataset.key] = Number(el.value) || settings[el.dataset.key];
    });
    // Basemap can be wanted but unavailable — the effective value is both.
    settings.basemap = !!basemapCb?.checked && !!findVisibleBasemap();
  }

  setupPopup.addEventListener("change", (e) => {
    const el = e.target;
    if (!el.matches("input[type=checkbox][data-key], select[data-key]")) return;
    readSettings();
    syncBasemapAvailability();
    if (el.dataset.reflow) reflowLockedSelection();
  });

  /** Walks the layer tree for a visible base layer that actually renders
   *  something — "No Basemap" is a real layer in the group (a 1px blank
   *  tile), so it has to be excluded by name or the checkbox would claim
   *  imagery is available when the map is deliberately blank. */
  function findVisibleBasemap() {
    let found = null;
    const walk = (collection) => {
      collection.forEach((layer) => {
        if (found) return;
        if (typeof layer.getLayers === "function") { walk(layer.getLayers()); return; }
        if (layer.get("type") === "base" && layer.getVisible()) {
          const title = String(layer.get("title") || "");
          if (title && !/^no basemap$/i.test(title)) found = layer;
        }
      });
    };
    walk(map.getLayers());
    return found;
  }

  /** Greys out the basemap options when there's no imagery to print. */
  function syncBasemapAvailability() {
    if (!basemapCb) return;
    const available = !!findVisibleBasemap();
    basemapCb.disabled = !available;
    basemapCb.closest(".vsl-print-setup__row")?.classList.toggle("is-disabled", !available);
    if (boostCb) {
      boostCb.disabled = !available || !basemapCb.checked;
      boostCb.closest(".vsl-print-setup__row")?.classList.toggle("is-disabled", boostCb.disabled);
    }
    if (basemapNote) basemapNote.hidden = available;
  }

  // ---------------------------------------------------------------------
  // Features tab — lists only the feature TYPES actually drawn on the map,
  // not the whole ~50-entry library, so the list is about this estate
  // rather than about what could theoretically exist. Types come off the
  // loaded features layer (_typeId/_typeName, set in js/survey-draw.js).
  // ---------------------------------------------------------------------
  function usedFeatureTypes() {
    const src = getFeaturesLayer?.()?.getSource();
    if (!src) return [];
    const byId = new Map();
    src.forEachFeature((f) => {
      const id = f.get("_typeId");
      if (id == null || byId.has(id)) return;
      byId.set(id, {
        id,
        name: f.get("_typeName") || "Feature",
        color: f.get("_color") || "#3f8f3f",
        icon: f.get("_icon") || "",
        kind: (f.getGeometry()?.getType() || "").toLowerCase()
      });
    });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  function renderFeatureList() {
    const types = usedFeatureTypes();
    if (!types.length) {
      featureListEl.innerHTML =
        `<p class="vsl-print-setup__note">No features have been drawn on the map yet.</p>`;
      return;
    }
    const on = (id) => settings.featureTypes === null || settings.featureTypes.has(id);
    featureListEl.innerHTML = types.map((t) => `
      <label class="vsl-print-setup__row">
        <input type="checkbox" data-feature-type="${t.id}"${on(t.id) ? " checked" : ""}>
        <span class="vsl-print-features__swatch" style="color:${t.color}">
          <i class="fas ${t.icon || "fa-circle-dot"}" aria-hidden="true"></i>
        </span>
        <span>${t.name}</span>
      </label>`).join("");

    featureListEl.querySelectorAll("input[data-feature-type]").forEach((cb) => {
      cb.addEventListener("change", () => {
        // First interaction converts "all types" (null) into an explicit set.
        if (settings.featureTypes === null) {
          settings.featureTypes = new Set(types.map((t) => t.id));
        }
        const id = Number(cb.dataset.featureType);
        if (cb.checked) settings.featureTypes.add(id);
        else settings.featureTypes.delete(id);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Legend data.
  //
  // The legend and north arrow are no longer draggable/resizable overlays
  // sitting on the live map. They now have fixed homes in a side column on
  // the printed page (see the page layout in generatePdf), so there's
  // nothing to position interactively and nothing to show on screen — the
  // Setup checkboxes just decide whether that column gets drawn.
  //
  // The printed legend is built here rather than scraped from the Legend
  // panel's DOM, but from the SAME constants that panel uses
  // (CULTIVATION_PALETTE / CULTIVATION_STATUS_LABELS / ALERT_SEVERITY_*,
  // passed into initPrintTool), so the two can't drift. buildLegendList in
  // js/map-app.js is the on-screen equivalent, group for group — the only
  // difference being that it lists every feature type on the map, while
  // this lists only those inside the selected print area.
  // ---------------------------------------------------------------------
  // ---------------------------------------------------------------------
  // Feature icons in the PDF.
  //
  // jsPDF has only its own core fonts, so a Font Awesome character can't
  // be written as text — it would come out as a missing-glyph box. The
  // icons are therefore shipped as SVG files in /icons, named exactly like
  // vsl_feature_type.icon ("fa-tree" -> icons/fa-icons/fa-tree.svg), pulled from
  // the Font Awesome Free 6.4.0 package (same version webmap.html loads).
  //
  // Files rather than the webfont because a font-based render depends on
  // the FA stylesheet having loaded and on reading a glyph out of a
  // ::before rule — both silent-failure paths. A file either exists or
  // doesn't. Each icon is fetched, tinted, rasterised to a PNG once, and
  // cached by icon+colour; preloadFeatureIcons() warms that cache before
  // the (synchronous) PDF drawing needs it.
  // ---------------------------------------------------------------------
  const ICON_DIR = "./icons/fa-icons";
  const ICON_RASTER_PX = 96; // rasterised large, scaled down in the PDF

  const faIconCache = new Map();   // "fa-tree|46,125,50" -> PNG data URL
  const faSvgTextCache = new Map(); // "fa-tree" -> raw SVG source

  /** Loads one icon's SVG source from /icons. Missing files resolve to
   *  null rather than throwing — the caller falls back to a dot. */
  async function loadIconSvg(iconClass) {
    if (faSvgTextCache.has(iconClass)) return faSvgTextCache.get(iconClass);
    let text = null;
    try {
      const res = await fetch(`${ICON_DIR}/${iconClass}.svg`);
      if (res.ok) text = await res.text();
    } catch { text = null; }
    faSvgTextCache.set(iconClass, text);
    return text;
  }

  /** Rasterises one icon in one colour and caches the PNG. Font Awesome's
   *  SVGs carry no fill attribute (so they'd paint black), hence the
   *  injected fill on the <svg> element itself — the paths inherit it. */
  async function loadIconPng(iconClass, rgb) {
    const key = `${iconClass}|${rgb.join(",")}`;
    if (faIconCache.has(key)) return faIconCache.get(key);
    const svgText = await loadIconSvg(iconClass);
    if (!svgText) { faIconCache.set(key, null); return null; }

    let url = null;
    try {
      const colored = svgText.replace(
        /<svg\b/,
        `<svg fill="rgb(${rgb[0]},${rgb[1]},${rgb[2]})"`
      );
      const svgUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(colored);
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("icon decode failed"));
        im.src = svgUrl;
      });
      // Square canvas with the glyph centred — FA viewBoxes vary in width
      // (448x512, 640x512, …), so letterbox rather than stretch.
      const px = ICON_RASTER_PX;
      const canvas = document.createElement("canvas");
      canvas.width = px;
      canvas.height = px;
      const ctx = canvas.getContext("2d");
      const iw = img.naturalWidth || img.width || px;
      const ih = img.naturalHeight || img.height || px;
      const scale = Math.min(px / iw, px / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      ctx.drawImage(img, (px - dw) / 2, (px - dh) / 2, dw, dh);
      url = canvas.toDataURL("image/png");
    } catch { url = null; }

    faIconCache.set(key, url);
    return url;
  }

  /** Warms the icon cache for every point-feature type inside `extent`,
   *  so the (synchronous) legend drawing can just read from it. Called
   *  from generatePdf before the document is built. */
  async function preloadFeatureIcons(extent) {
    const src = getFeaturesLayer?.()?.getSource();
    if (!src || !extent) return;
    const wanted = new Map();
    src.getFeaturesInExtent(extent).forEach((f) => {
      if (!featureTypeEnabled(f)) return;
      const kind = (f.getGeometry()?.getType() || "").toLowerCase();
      if (!kind.includes("point")) return;
      const icon = f.get("_icon");
      if (!icon) return;
      const rgb = parseRgba(f.get("_color") || "#3f8f3f").rgb;
      wanted.set(`${icon}|${rgb.join(",")}`, { icon, rgb });
    });
    await Promise.all([...wanted.values()].map((w) => loadIconPng(w.icon, w.rgb)));
  }

  /** Synchronous cache read for the legend swatch. Returns null when the
   *  icon wasn't preloaded or its file is missing. */
  function faIconDataUrl(iconClass, rgb) {
    return faIconCache.get(`${iconClass}|${rgb.join(",")}`) || null;
  }

  /** vsl_feature_type.linetype -> a jsPDF dash pattern (null = solid or
   *  "none", which the caller skips entirely). Scaled by the stroke width
   *  where one is known, so a thick dashed line doesn't print as a solid
   *  one with nicks in it — the same proportions the map uses. */
  function dashPatternFor(linetype, widthPt) {
    const t = String(linetype || "").toLowerCase();
    if (!t || t.includes("solid") || t.includes("none")) return null;
    const w = Number(widthPt) > 0 ? Number(widthPt) : 1;
    if (t.includes("dot")) return [w, w * 2];
    if (t.includes("dash")) return [w * 3, w * 2];
    return null;
  }

  /** One stroke's printed thickness. vsl_feature_type.line_weight is in
   *  screen pixels, which means nothing on paper — so it's read as a
   *  multiplier of the print's own feature stroke size (calibrated at the
   *  column's default of 2), keeping a "thick" road thick relative to
   *  everything else at whatever scale the sheet ends up. */
  function featureStrokePt(feature, sizes) {
    const weight = Number(feature.get("_weight")) || 2;
    return sizes.featureStroke * (weight / 2);
  }

  /**
   * The stroke passes that draw a single/double/triple line, in paint order.
   * Identical arithmetic to the map's lineStrokeStyles (js/survey-draw.js) —
   * a wide stroke in the feature's colour with the middle knocked back out
   * in white, so the visible result is `n` lines of `weightPt` separated by
   * `spacingPt`:
   *   double: outer 2w+s, knockout s
   *   triple: outer 3w+2s, knockout w+2s, then a dotted centre line on top
   * Spacing arrives already converted from ground metres (sizes.ptPerMeter),
   * so a 6m-wide double line prints 6m wide at the sheet's scale.
   */
  function pdfLineStrokes(rgb, weightPt, dash, lineStyle, spacingPt) {
    const w = Math.max(0.05, Number(weightPt) || 0.5);
    const s = Math.max(w * 0.5, Number(spacingPt) || 0);
    const white = [255, 255, 255];
    if (lineStyle === "double") {
      return [
        { role: "casing", rgb, width: 2 * w + s, dash },
        { role: "knockout", rgb: white, width: s, dash: null }
      ];
    }
    if (lineStyle === "triple") {
      return [
        { role: "casing", rgb, width: 3 * w + 2 * s, dash },
        { role: "knockout", rgb: white, width: w + 2 * s, dash: null },
        { role: "fill", rgb, width: w, dash: dashPatternFor("dotted", w) }
      ];
    }
    // A single stroke is a "fill", not a casing: it has no knockout of its
    // own, and being painted in the fill round means a neighbouring road's
    // knockout can't erase it where the two cross.
    return [{ role: "fill", rgb, width: w, dash }];
  }

  /** The order every line stroke on the page is painted in — ALL casings,
   *  then ALL knockouts, then ALL fills. See drawFeaturePlans. */
  const LINE_PASS_ORDER = ["casing", "knockout", "fill"];

  /**
   * The printed legend, as ordered groups of symbol rows. Each row carries
   * a `sym` describing HOW to draw its swatch, so the legend can show a
   * dashed estate outline, a hollow plot square, a filled status square, a
   * short line and a point icon side by side rather than forcing
   * everything into one coloured box.
   *
   *   sym.kind: "poly"  — square; fill (rgb|null), stroke, dash
   *             "line"  — short horizontal rule; stroke, dash
   *             "point" — filled dot (icon glyphs aren't in the PDF fonts)
   *
   * Groups mirror what's actually on the page, and each is skipped when
   * its layer/labels are switched off, so the legend never advertises
   * something that wasn't printed.
   */
  function buildLegendGroups(extent) {
    const groups = [];
    // Every row can carry a `count` — how many of that thing fall inside
    // the printed area. Rendered as a right-aligned column when "Show
    // counts in legend" is on, which is what replaced the old separate
    // Summary box.
    const estateFeatures = estatesLayer?.getSource()?.getFeaturesInExtent(extent) || [];
    const blockFeatures = blocksLayer?.getSource()?.getFeaturesInExtent(extent) || [];
    const plotFeatures = parcelsLayer?.getSource()?.getFeaturesInExtent(extent) || [];
    const titleFeatures = titlesLayer?.getSource()?.getFeaturesInExtent(extent) || [];

    // 1. Land properties — how each land layer is drawn.
    const land = [];
    if (settings.layers.estate) {
      land.push({ label: "Estate", count: estateFeatures.length,
        sym: { kind: "poly", fill: null, stroke: ESTATE_STROKE_RGB, dash: true } });
    }
    if (settings.layers.block) {
      land.push({ label: "Block", count: blockFeatures.length,
        sym: { kind: "poly", fill: null, stroke: BLOCK_STROKE_RGB } });
    }
    if (settings.layers.plot) {
      land.push({ label: "Plot", count: plotFeatures.length,
        sym: { kind: "poly", fill: null, stroke: PARCEL_STROKE_RGB } });
    }
    if (settings.layers.titleBoundary) {
      land.push({ label: "Land Title", count: titleFeatures.length,
        sym: { kind: "poly", fill: null, stroke: TITLE_BOUNDARY_RGB, dash: true } });
    }
    if (land.length) groups.push({ title: "LAND PROPERTIES", items: land });

    // 2. Plot status — only meaningful when the fills are actually drawn.
    if (settings.layers.plot && settings.hatching && CULTIVATION_PALETTE) {
      const statusCounts = {};
      plotFeatures.forEach((f) => {
        const k = f.get("cultivation_status") || "vacant";
        statusCounts[k] = (statusCounts[k] || 0) + 1;
      });
      const status = Object.keys(CULTIVATION_PALETTE).map((key) => {
        const parsed = parseRgba(CULTIVATION_PALETTE[key].fill);
        // Vacant is a fully transparent fill — show it as a hollow box.
        const fill = parsed.a === 0 ? null : parsed.rgb;
        return {
          label: CULTIVATION_STATUS_LABELS?.[key] || key,
          count: statusCounts[key] || 0,
          sym: { kind: "poly", fill, stroke: parseRgba(CULTIVATION_PALETTE[key].stroke).rgb }
        };
      });
      if (status.length) groups.push({ title: "PLOT STATUS", items: status });
    }

    // 3. Alerts — the three severities, same colours as the map.
    if (settings.labels.alerts && ALERT_SEVERITY_COLORS) {
      const alertCounts = {};
      plotFeatures.forEach((f) => {
        const sev = f.get("_alert_severity");
        if (sev) alertCounts[sev] = (alertCounts[sev] || 0) + (Number(f.get("_alert_count")) || 1);
      });
      const alerts = ["critical", "warning", "information"]
        .filter((k) => ALERT_SEVERITY_COLORS[k])
        .map((k) => ({
          label: k.charAt(0).toUpperCase() + k.slice(1),
          count: alertCounts[k] || 0,
          sym: {
            kind: "poly",
            fill: parseRgba(ALERT_SEVERITY_FILL?.[k] || ALERT_SEVERITY_COLORS[k]).rgb,
            stroke: parseRgba(ALERT_SEVERITY_COLORS[k]).rgb
          }
        }));
      if (alerts.length) groups.push({ title: "ALERTS", items: alerts });
    }

    // 4. Features — only the types actually inside this print, and only
    //    those still ticked in the Features tab.
    const featSrc = getFeaturesLayer?.()?.getSource();
    if (featSrc && extent) {
      const byId = new Map();
      featSrc.getFeaturesInExtent(extent).forEach((f) => {
        if (!featureTypeEnabled(f)) return;
        const id = f.get("_typeId");
        const key = id == null ? f.get("_typeName") || "?" : id;
        if (byId.has(key)) { byId.get(key).count += 1; return; }
        const kind = (f.getGeometry()?.getType() || "").toLowerCase();
        const rgb = parseRgba(f.get("_color") || "#3f8f3f").rgb;
        const dash = dashPatternFor(f.get("_linetype"), 1.2);
        byId.set(key, {
          label: f.get("_typeName") || "Feature",
          count: 1,
          sym: kind.includes("point")
            // Its real icon, in the type's own colour.
            ? { kind: "point", fill: rgb, icon: f.get("_icon") || "" }
            : kind.includes("line")
              // A short rule in the type's colour and line style. `lineStyle`
              // makes the swatch show a double/triple as two/three rules —
              // drawn as genuinely separate lines here rather than by the
              // knockout trick, since a legend swatch has no ground scale to
              // knock out against.
              ? { kind: "line", stroke: rgb, dashPattern: dash, lineStyle: f.get("_lineStyle") || "single" }
              // Filled square, same shape as a plot swatch.
              : { kind: "poly", fill: rgb, fillAlpha: 0.35, stroke: rgb, dashPattern: dash }
        });
      });
      const feats = [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
      if (feats.length) groups.push({ title: "FEATURES", items: feats });
    }

    return groups;
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
    const locked = lockAspect ? " · locked" : "";
    selectionHintEl.textContent =
      `${Math.round(selectionRect.width)} × ${Math.round(selectionRect.height)} px — ${orientation}${locked}`;
  }

  /** Locked resize from the bottom-right grip. The top-left corner stays
   *  pinned and the ORIENTATION is chosen dynamically from the drag
   *  itself — pull wide and it snaps to the landscape page ratio, pull
   *  tall and it snaps to portrait — which is the same behaviour as
   *  drawing a fresh box, so the two feel identical. */
  function applyLockedResize(pointerX, pointerY) {
    const wrapRect = viewportWrap.getBoundingClientRect();
    const left = parseFloat(selectionEl.style.left) || 0;
    const top = parseFloat(selectionEl.style.top) || 0;
    const minSide = 80;

    // Raw drag extent decides which layout we're heading for.
    const rawW = Math.max(minSide, pointerX - left);
    const rawH = Math.max(minSide, pointerY - top);
    const ratio = targetAspectRatio(rawW >= rawH ? "landscape" : "portrait");

    // Snap to that ratio, then clamp to the viewport without distorting.
    let width = rawW;
    let height = width / ratio;
    if (rawW / rawH < ratio) { height = rawH; width = height * ratio; }
    if (left + width > wrapRect.width) { width = wrapRect.width - left; height = width / ratio; }
    if (top + height > wrapRect.height) { height = wrapRect.height - top; width = height * ratio; }

    selectionEl.style.width = `${width}px`;
    selectionEl.style.height = `${height}px`;
    updateSelectionRectFromEl();
  }

  /** The bottom-right grip's locked behaviour. Inert while the lock is
   *  off, in which case wireResize's plain free resize takes the drag. */
  function wireLockedHandle(handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (!lockAspect) return; // unlocked: wireResize handles this grip instead
      e.preventDefault();
      e.stopPropagation();
      const onMove = (ev) => {
        const wrapRect = viewportWrap.getBoundingClientRect();
        applyLockedResize(ev.clientX - wrapRect.left, ev.clientY - wrapRect.top);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });
  }

  /** Just a colour cue on the single grip — green while the ratio lock is
   *  holding it to a page shape, default otherwise. */
  function syncHandleVisibility() {
    if (selectionHandleEl) {
      selectionHandleEl.classList.toggle("vsl-print-selection__handle--locked", lockAspect);
    }
  }

  /** Re-snaps an existing selection after something changed the page's
   *  proportions (a Setup toggle, or the lock being switched on). Keeps
   *  the top-left corner and the current orientation, only correcting the
   *  ratio, so the box doesn't jump across the map. */
  function reflowLockedSelection() {
    if (!lockAspect || !selectionEl || !selectionRect) return;
    const wrapRect = viewportWrap.getBoundingClientRect();
    const left = selectionRect.left;
    const top = selectionRect.top;
    const ratio = targetAspectRatio(
      selectionRect.width >= selectionRect.height ? "landscape" : "portrait"
    );
    let width = selectionRect.width;
    let height = width / ratio;
    if (left + width > wrapRect.width) { width = wrapRect.width - left; height = width / ratio; }
    if (top + height > wrapRect.height) { height = wrapRect.height - top; width = height * ratio; }
    selectionEl.style.width = `${width}px`;
    selectionEl.style.height = `${height}px`;
    updateSelectionRectFromEl();
  }

  function ensureSelectionEl() {
    if (selectionEl) return;
    selectionEl = document.createElement("div");
    selectionEl.className = "vsl-print-selection";

    selectionHandleEl = document.createElement("div");
    selectionHandleEl.className = "vsl-print-selection__handle vsl-print-selection__handle--br";
    selectionHandleEl.title = "Drag to resize";

    selectionHintEl = document.createElement("div");
    selectionHintEl.className = "vsl-print-selection__hint";

    selectionEl.appendChild(selectionHandleEl);
    selectionEl.appendChild(selectionHintEl);
    viewportWrap.appendChild(selectionEl);

    // Move by dragging the rectangle body itself (the grip stops
    // propagation, so it never also triggers a move).
    wireDrag(selectionEl, selectionEl, updateSelectionRectFromEl);
    // One grip, two behaviours: free resize when unlocked, ratio-locked
    // (orientation chosen from the drag) when locked. Both are wired; each
    // checks lockAspect so exactly one acts.
    wireResize(selectionEl, selectionHandleEl, 80, 60, updateSelectionRectFromEl, () => !lockAspect);
    wireLockedHandle(selectionHandleEl);

    // Wheel over the box would otherwise scroll/zoom the PAGE, because the
    // box is a sibling of the OL viewport rather than inside it. Forward it
    // to the view so zooming behaves the same inside and outside the box.
    selectionEl.addEventListener("wheel", onSelectionWheel, { passive: false });

    syncHandleVisibility();
  }

  /** Zooms the map view under the pointer, standing in for OL's own
   *  MouseWheelZoom for events that never reach the map viewport. */
  function onSelectionWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    const view = map.getView();
    if (!view) return;
    const vpRect = map.getViewport().getBoundingClientRect();
    const anchor = map.getCoordinateFromPixel([e.clientX - vpRect.left, e.clientY - vpRect.top]);
    const zoom = view.getZoom();
    if (zoom == null) return;
    const step = e.deltaY > 0 ? -0.5 : 0.5;
    view.animate({ zoom: zoom + step, anchor: anchor || undefined, duration: 120 });
  }

  function removeSelection() {
    selectionEl?.removeEventListener("wheel", onSelectionWheel);
    selectionEl?.remove();
    selectionEl = null;
    selectionHandleEl = null;
    selectionHintEl = null;
    selectionRect = null;
    saveBtn.disabled = true;
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
    if (e.target.closest(".vsl-print-bottom-stack, .vsl-print-setup")) return;
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
    let left = Math.min(drawingFrom.x, p.x);
    let top = Math.min(drawingFrom.y, p.y);
    let width = Math.abs(p.x - drawingFrom.x);
    let height = Math.abs(p.y - drawingFrom.y);

    // With the lock on, the box being drawn snaps to whichever page ratio
    // the drag is closest to — drag wide and it holds the landscape ratio,
    // drag tall and it holds the portrait one. The corner the user started
    // from stays put; only the free corner moves.
    if (lockAspect && width > 0 && height > 0) {
      const orientation = width >= height ? "landscape" : "portrait";
      const ratio = targetAspectRatio(orientation);
      if (width / height > ratio) width = height * ratio;
      else height = width / ratio;
      if (p.x < drawingFrom.x) left = drawingFrom.x - width;
      if (p.y < drawingFrom.y) top = drawingFrom.y - height;
    }

    selectionEl.style.left = `${left}px`;
    selectionEl.style.top = `${top}px`;
    selectionEl.style.width = `${width}px`;
    selectionEl.style.height = `${height}px`;
  }

  function onArmedPointerUp() {
    window.removeEventListener("pointermove", onArmedPointerMove);
    window.removeEventListener("pointerup", onArmedPointerUp);
    drawingFrom = null;

    // A quick click with no real drag still yields a usable print area
    // rather than a sliver: a 100px box the user can then move and resize.
    // When locked, that starter box takes the landscape ratio.
    const minSize = 100;
    if (selectionEl.offsetWidth < minSize || selectionEl.offsetHeight < minSize) {
      const wrapRect = viewportWrap.getBoundingClientRect();
      let w = minSize;
      let h = minSize;
      if (lockAspect) {
        const ratio = targetAspectRatio("landscape");
        if (ratio >= 1) { h = minSize; w = h * ratio; }
        else { w = minSize; h = w / ratio; }
      }
      const left = Math.max(0, Math.min(parseFloat(selectionEl.style.left) || 0, wrapRect.width - w));
      const top = Math.max(0, Math.min(parseFloat(selectionEl.style.top) || 0, wrapRect.height - h));
      selectionEl.style.left = `${left}px`;
      selectionEl.style.top = `${top}px`;
      selectionEl.style.width = `${w}px`;
      selectionEl.style.height = `${h}px`;
    }

    updateSelectionRectFromEl();
    saveBtn.disabled = false;
    disarmSelection();
  }

  /** OpenLayers' own drag-pan would otherwise fight the selection drag —
   *  you'd pan the map instead of drawing a box — so every DRAG-based
   *  interaction is switched off while the crosshair is armed and switched
   *  back on when the selection finishes or is cancelled.
   *
   *  Wheel zoom is deliberately left ALONE: zooming while choosing an area
   *  is genuinely useful, and killing MouseWheelZoom is what made the page
   *  scroll instead of the map. (Wheel events over the selection box never
   *  reach OL at all, since the box is a sibling of the map viewport —
   *  onSelectionWheel forwards those manually.) Only interactions that
   *  WERE active get restored, so anything another tool had already
   *  disabled stays disabled. */
  let suspendedInteractions = [];

  /** instanceof against the ol namespace rather than constructor.name —
   *  OL is loaded minified from a CDN, so class names are mangled. */
  function keepActiveWhileSelecting(interaction) {
    const I = typeof ol !== "undefined" ? ol.interaction : null;
    if (!I) return false;
    return (
      (I.MouseWheelZoom && interaction instanceof I.MouseWheelZoom) ||
      (I.PinchZoom && interaction instanceof I.PinchZoom)
    );
  }

  function suspendMapInteractions() {
    if (suspendedInteractions.length) return;
    map.getInteractions().forEach((interaction) => {
      if (keepActiveWhileSelecting(interaction)) return;
      if (interaction.getActive()) {
        suspendedInteractions.push(interaction);
        interaction.setActive(false);
      }
    });
  }

  function restoreMapInteractions() {
    suspendedInteractions.forEach((interaction) => interaction.setActive(true));
    suspendedInteractions = [];
  }

  function armSelection() {
    armed = true;
    selectAreaBtn.classList.add("active");
    viewportWrap.classList.add("vsl-print-selecting");
    suspendMapInteractions();
  }
  function disarmSelection() {
    armed = false;
    selectAreaBtn.classList.remove("active");
    viewportWrap.classList.remove("vsl-print-selecting");
    restoreMapInteractions();
  }

  selectAreaBtn.addEventListener("click", () => {
    if (armed) disarmSelection();
    else armSelection();
  });
  viewportWrap.addEventListener("pointerdown", onArmedPointerDown);

  /** Dismisses the setup popup on any click that isn't inside it or on the
   *  gear button itself. Bound only while the popup is actually open, and
   *  torn down on close/exit so no stray document listener survives print
   *  mode. Capture phase, so it still fires for clicks on the map (which
   *  stops propagation while a selection drag is armed). */
  let setupOutsideHandler = null;

  function closeSetupPopup() {
    setupPopup.hidden = true;
    setupBtn.classList.remove("active");
    if (setupOutsideHandler) {
      document.removeEventListener("pointerdown", setupOutsideHandler, true);
      setupOutsideHandler = null;
    }
  }

  function openSetupPopup() {
    setupPopup.hidden = false;
    setupBtn.classList.add("active");
    // Reflect real state, not markup defaults: the controls are filled
    // from `settings`, the Features list is rebuilt (types drawn since it
    // last opened), and basemap availability re-checked (the user may have
    // switched basemaps or turned them off in the meantime).
    writeSettingsToForm();
    renderFeatureList();
    syncBasemapAvailability();
    if (setupOutsideHandler) return;
    setupOutsideHandler = (e) => {
      if (setupPopup.contains(e.target) || setupBtn.contains(e.target)) return;
      closeSetupPopup();
    };
    document.addEventListener("pointerdown", setupOutsideHandler, true);
  }

  setupBtn.addEventListener("click", () => {
    if (setupPopup.hidden) openSetupPopup();
    else closeSetupPopup();
  });
  setupCloseBtn.addEventListener("click", closeSetupPopup);

  cancelBtn.addEventListener("click", () => exitPrintMode());

  // ---------------------------------------------------------------------
  // Extent + basemap-only raster capture.
  //
  // The page is built from two independent pieces rather than one flat
  // screenshot:
  //   - Estates, blocks, plots and the saved custom features — geometry
  //     AND labels — are real PDF vector content (drawMapVectors below),
  //     crisp at any size, which is what actually needed to be legible.
  //   - Everything else (basemap imagery, drone/sentinel rasters) is a
  //     pixel capture using the canvas-compositing technique, re-rendered
  //     at BASEMAP_ZOOM_SCALE so the imagery itself is genuinely sharper
  //     rather than upscaled. Every layer drawn as vectors is hidden for
  //     the duration of that capture so nothing appears twice.
  //
  // getPrintExtent() MUST be called before captureBasemapOnly() touches
  // the map's size/resolution — it converts the selection rectangle's
  // on-screen px into geographic (EPSG:3857) coordinates using the map's
  // CURRENT, unmodified view, which is also the extent the vector redraw
  // projects geometry against, so the two line up exactly.
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

      // Every layer that gets redrawn as PDF vectors is hidden for the
      // capture, so the raster underneath carries only the imagery.
      const vectorLayers = [
        estatesLayer, blocksLayer, parcelsLayer, titlesLayer,
        getFeaturesLayer?.(),
        // Feature names live on their own decluttered layer (see
        // featureLabelsLayer in js/survey-draw.js) and are redrawn as PDF
        // text further down, so they have to be hidden here too.
        getFeatureLabelsLayer?.()
      ].filter(Boolean);
      const wasVisible = vectorLayers.map((l) => l.getVisible());
      vectorLayers.forEach((l) => l.setVisible(false));

      function restoreLiveMap() {
        vectorLayers.forEach((l, i) => l.setVisible(wasVisible[i]));
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
  /** Page points per ground metre for a given extent drawn `drawW` points
   *  wide. See the note at its call site in drawMapVectors. */
  function ptPerMeterFor(extent, drawW) {
    const [minX, minY, maxX, maxY] = extent;
    const spanX = (maxX - minX) || 1;
    const ptPerMapUnit = drawW / spanX;
    let cosLat = 1;
    try {
      const lat = ol.proj.toLonLat([(minX + maxX) / 2, (minY + maxY) / 2])[1];
      cosLat = Math.cos((lat * Math.PI) / 180) || 1;
    } catch {
      cosLat = 1;
    }
    return ptPerMapUnit / cosLat;
  }

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
    doc.setFont("helvetica", "bold");
    doc.setFontSize(fontSize);

    // ── jsPDF align + angle correction ──
    //
    // jsPDF (2.5.1) subtracts the alignment offset along the PAGE x-axis and
    // only THEN rotates the text about that already-shifted point. The
    // offset is never rotated with the text, so a centred label sitting on a
    // tilted line ends up displaced from its anchor by roughly
    //     (width/2) x sin(angle)   perpendicular to the line
    //     (width/2) x (1 - cos(angle))  along it
    // — an error that grows with the LENGTH of the text, which is why a long
    // road name floated far off its road while a three-letter one barely
    // moved, and why horizontal labels (angle 0, sin 0) always looked fine.
    //
    // Fix: never let jsPDF do the centring on rotated text. Draw left-
    // aligned, which lands exactly on the anchor, and walk the anchor back
    // half a text width along the text's OWN baseline. A jsPDF angle A gives
    // a baseline running (cos A, -sin A) on the page, y growing downward.
    let ax = x;
    let ay = y;
    let drawAlign = align;
    if (angle) {
      const back = align === "center" ? doc.getTextWidth(text) / 2
        : align === "right" ? doc.getTextWidth(text)
          : 0;
      if (back) {
        const a = (angle * Math.PI) / 180;
        ax = x - back * Math.cos(a);
        ay = y + back * Math.sin(a);
      }
      drawAlign = "left";
    }

    const textOpts = () => (angle ? { align: drawAlign, angle } : { align: drawAlign });
    doc.setTextColor(255, 255, 255);
    // Halo thickness has to track the font size now that sizes scale with
    // the selection — a fixed offset that looked right at 7pt would smear
    // 2pt text into an unreadable white blob. 5% of the font size is the
    // ratio the old fixed 0.35 had at the original 7pt default, so this
    // reproduces the previous look exactly at that size.
    const d = fontSize * 0.05;
    [[-d, 0], [d, 0], [0, -d], [0, d], [-d, -d], [d, -d], [-d, d], [d, d]].forEach(([dx, dy]) => {
      doc.text(text, ax + dx, ay + dy, textOpts());
    });
    doc.setTextColor(colorRGB[0], colorRGB[1], colorRGB[2]);
    doc.text(text, ax, ay, textOpts());
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

  // ---------------------------------------------------------------------
  // Clipping to the map frame.
  //
  // jsPDF's own clip() proved unreliable here (the rect path gets painted
  // and consumed before clip() sees it, so geometry straddling the
  // selection edge ran on to the page border), so the trimming is done in
  // geometry instead: Sutherland–Hodgman against the frame rectangle for
  // filled polygons, and a per-segment Liang–Barsky trim for open lines.
  // All coordinates here are already-projected PDF page points.
  // ---------------------------------------------------------------------

  /** Sutherland–Hodgman: clips a closed polygon ring to an axis-aligned
   *  rect, one edge at a time. Returns [] if nothing survives. */
  function clipPolygonToRect(points, rect) {
    const { x0, y0, x1, y1 } = rect;
    const inside = (p, edge) => {
      if (edge === 0) return p[0] >= x0; // left
      if (edge === 1) return p[0] <= x1; // right
      if (edge === 2) return p[1] >= y0; // top
      return p[1] <= y1;                 // bottom
    };
    const intersect = (a, b, edge) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      let t;
      if (edge === 0) t = (x0 - a[0]) / dx;
      else if (edge === 1) t = (x1 - a[0]) / dx;
      else if (edge === 2) t = (y0 - a[1]) / dy;
      else t = (y1 - a[1]) / dy;
      return [a[0] + t * dx, a[1] + t * dy];
    };

    let out = points;
    for (let edge = 0; edge < 4 && out.length; edge++) {
      const input = out;
      out = [];
      for (let i = 0; i < input.length; i++) {
        const cur = input[i];
        const prev = input[(i + input.length - 1) % input.length];
        const curIn = inside(cur, edge);
        const prevIn = inside(prev, edge);
        if (curIn) {
          if (!prevIn) out.push(intersect(prev, cur, edge));
          out.push(cur);
        } else if (prevIn) {
          out.push(intersect(prev, cur, edge));
        }
      }
    }
    return out;
  }

  /** Liang–Barsky: trims one open segment to the rect. Returns null when
   *  the segment lies entirely outside. */
  function clipSegmentToRect(a, b, rect) {
    let t0 = 0, t1 = 1;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const tests = [
      [-dx, a[0] - rect.x0],
      [dx, rect.x1 - a[0]],
      [-dy, a[1] - rect.y0],
      [dy, rect.y1 - a[1]]
    ];
    for (const [p, q] of tests) {
      if (p === 0) {
        if (q < 0) return null; // parallel to this edge and outside it
        continue;
      }
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
    return [
      [a[0] + t0 * dx, a[1] + t0 * dy],
      [a[0] + t1 * dx, a[1] + t1 * dy]
    ];
  }

  function pointInRect(p, rect) {
    return p[0] >= rect.x0 && p[0] <= rect.x1 && p[1] >= rect.y0 && p[1] <= rect.y1;
  }

  const BLOCK_STROKE_RGB = [211, 47, 47]; // #d32f2f
  const PARCEL_STROKE_RGB = [46, 125, 50]; // #2e7d32
  const EDGE_DISTANCE_RGB = [25, 118, 210]; // #1976d2
  const ESTATE_STROKE_RGB = [215, 98, 19]; // #D76213 — matches estatesLayer
  const TITLE_BOUNDARY_RGB = [123, 31, 162]; // #7b1fa2 — matches titlesLayer
  // Fallback only. A feature's name prints in that feature type's OWN
  // colour (see the `colorRGB` carried on every label in planCustomFeature),
  // matching the live map — so a label reads as belonging to the road or
  // marker it names. This neutral is used only if a plan somehow arrives
  // without one.
  const FEATURE_LABEL_RGB = [29, 42, 29]; // #1d2a1d

  // ---------------------------------------------------------------------
  // TUNABLE — BASE label/stroke sizes, in PDF points.
  //
  // These are NOT used directly. Every one of them is divided by the
  // selection's ground size in km (the longer of the selection window's
  // width/height — see getSelectionSizeKm) before anything is drawn, so
  // the whole drawing scales inversely with how much ground the print
  // covers. Tighter selection -> bigger text and thicker lines; wider
  // selection -> smaller text and thinner lines.
  //
  // Read each value below as "the size this would be at a 1km selection".
  // Worked example, selecting a 10km x 5km window (selection size = 10):
  //     PARCEL_HALO_PT        2/10  = 0.2
  //     PARCEL_STROKE_PT      1/10  = 0.1
  //     BLOCK_STROKE_PT       2/10  = 0.2
  //     BLOCK_LABEL_PT       40/10  = 4
  //     PARCEL_LABEL_PT      20/10  = 2
  //     EDGE_DISTANCE_PT     10/10  = 1
  //
  // The division happens once per print in computePrintSizes(), which
  // hands a `sizes` object down to the draw functions — it can't live on
  // the constants themselves, since the selection isn't known until the
  // user has actually drawn one.
  //
  // Every plot inside the selection gets its full name/area/ratoon label,
  // always. There's deliberately no "too many plots, drop to name only"
  // fallback any more — the sizes above shrink to fit instead, and it's
  // the user's call to print on bigger paper or select a smaller area if
  // the result comes out too small to read.
  // ---------------------------------------------------------------------

  //---------- LINE CONSTANTS (per 1km of selection) --------------------\\
  const BASE_PARCEL_HALO_PT = 2;     // white casing under the plot outline
  const BASE_PARCEL_STROKE_PT = 1;   // plot line thickness
  const BASE_BLOCK_STROKE_PT = 2;    // block outline
  const BASE_ESTATE_STROKE_PT = 3;   // estate boundary (dashed)
  const BASE_ESTATE_DASH_PT = 6;     // estate dash length
  const BASE_TITLE_STROKE_PT = 2;    // land title boundary (dashed)
  const BASE_TITLE_DASH_PT = 5;      // land title dash length
  const BASE_FEATURE_STROKE_PT = 2;  // custom feature line / polygon outline
  const BASE_FEATURE_POINT_PT = 20;   // point feature dot radius (icon fallback)
  const BASE_FEATURE_ICON_PT = 50;   // point feature ICON box (width = height)

  //---------- TEXT CONSTANTS (per 1km of selection) --------------------\\
  const BASE_BLOCK_LABEL_PT = 40;   // block name
  const BASE_PARCEL_LABEL_PT = 20;  // plot name / area / ratoon / Alerts(n)
  const BASE_EDGE_DISTANCE_PT = 12; // "123.4m" edge labels (off by default)
  const BASE_ESTATE_LABEL_PT = 60;  // estate name
  const BASE_TITLE_LABEL_PT = 20;   // land title name / area — same size as a plot's
  const BASE_FEATURE_LABEL_PT = 25; // custom feature name

  //---------- REPEATED ROAD LABELS (tuning) ----------------------------\\
  // On the live map, OpenLayers repeats a road's name along it for us (see
  // LINE_LABEL_REPEAT_PX in js/survey-draw.js). It gives no way to read back
  // WHERE it put them, so the PDF walks the geometry itself and picks its
  // own spots. These are the knobs for that.

  /** Distance between one name and the next, in page points, per 1km of
   *  selection — same per-km scaling as every BASE_* above, so the labels
   *  stay proportional to the text as the sheet scale changes. At the
   *  default it works out to a gap of about 30x the label's font size.
   *  Smaller = more names per road. */
  const BASE_FEATURE_LABEL_REPEAT_PT = 900;

  /** A name is only placed where a single straight run of road is at least
   *  this many times the text's width. It's what keeps names off bends and
   *  short stubs: the text always sits wholly within one straight piece.
   *  Higher = fussier, fewer labels. */
  const FEATURE_LABEL_FIT_FACTOR = 1.15;

  /** Rough width of one character as a fraction of the font size, used to
   *  guess how wide a name will be before it's drawn. Helvetica Bold
   *  averages near 0.55. Only affects the fit and overlap tests. */
  const FEATURE_LABEL_CHAR_WIDTH_FACTOR = 0.55;

  /** Hard ceiling on repeats per road, so one very long feature on a very
   *  zoomed-in sheet can't carpet the page with its own name. */
  const FEATURE_LABEL_MAX_REPEATS = 12;

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

  /** The selection window's ground size in KILOMETRES — the larger of its
   *  width and height, measured across the middle of the extent so it's
   *  true ground distance (haversine on real lon/lat) rather than raw
   *  Web-Mercator units, which would over-report the further you get from
   *  the equator. This single number is the divisor behind every BASE_*
   *  size above: select 10km x 5km and it returns 10. */
  function getSelectionSizeKm(extent) {
    if (!extent) return 1;
    const [minX, minY, maxX, maxY] = extent;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    const toLonLat = (c) => ol.proj.transform(c, "EPSG:3857", "EPSG:4326");
    const w = toLonLat([minX, midY]);
    const e = toLonLat([maxX, midY]);
    const s = toLonLat([midX, minY]);
    const n = toLonLat([midX, maxY]);
    const widthM = haversineMeters(w[0], w[1], e[0], e[1]);
    const heightM = haversineMeters(s[0], s[1], n[0], n[1]);
    return Math.max(widthM, heightM) / 1000;
  }

  /** Divides every BASE_* size by the selection's km size, once per print.
   *  The only safety here is against a zero/NaN divisor (which would make
   *  every size Infinity and render nothing) — the results themselves are
   *  deliberately NOT clamped, so the raw inverse relationship is exactly
   *  what lands on the page. */
  function computePrintSizes(extent) {
    const km = getSelectionSizeKm(extent);
    const d = km > 0 && isFinite(km) ? km : 1;
    // Text-size multiplier from Setup — the BASE_* text constants are
    // calibrated at TEXT_SIZE_DEFAULT, so the chosen step over that is the
    // factor. Applied ONLY to the text sizes; line widths keep their own
    // scale so boosting label size doesn't fatten every boundary with it.
    const mf = (Number(settings.textSize) || TEXT_SIZE_DEFAULT) / TEXT_SIZE_DEFAULT;
    // Icon-size multiplier — same 1–10 / neutral-at-5 scheme as text, but
    // its own dropdown, so icons and labels size independently.
    const imf = (Number(settings.iconSize) || ICON_SIZE_DEFAULT) / ICON_SIZE_DEFAULT;
    return {
      selectionKm: d,
      textMF: mf,
      iconMF: imf,
      parcelHalo: BASE_PARCEL_HALO_PT / d,
      parcelStroke: BASE_PARCEL_STROKE_PT / d,
      blockStroke: BASE_BLOCK_STROKE_PT / d,
      blockLabel: (BASE_BLOCK_LABEL_PT * mf) / d,
      parcelLabel: (BASE_PARCEL_LABEL_PT * mf) / d,
      edgeDistance: (BASE_EDGE_DISTANCE_PT * mf) / d,
      featureLabelRepeat: BASE_FEATURE_LABEL_REPEAT_PT / d,
      estateStroke: BASE_ESTATE_STROKE_PT / d,
      estateDash: BASE_ESTATE_DASH_PT / d,
      estateLabel: (BASE_ESTATE_LABEL_PT * mf) / d,
      titleStroke: BASE_TITLE_STROKE_PT / d,
      titleDash: BASE_TITLE_DASH_PT / d,
      titleLabel: (BASE_TITLE_LABEL_PT * mf) / d,
      featureStroke: BASE_FEATURE_STROKE_PT / d,
      featurePoint: (BASE_FEATURE_POINT_PT * imf) / d,
      featureIcon: (BASE_FEATURE_ICON_PT * imf) / d,
      featureLabel: (BASE_FEATURE_LABEL_PT * mf) / d
    };
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

  /** Fraction of the font size used to lift the baseline so the glyphs
   *  straddle the line instead of resting on it. Roughly half Helvetica's
   *  cap height. Increase to push labels further off the line, decrease to
   *  sink them into it. */
  const EDGE_LABEL_CENTER_FACTOR = 0.36;

  /** Per-edge distance labels along a ring — the print equivalent of the
   *  live parcelsLayer style function's `resolution <= 4` segment-length
   *  text, which uses ol.style.Text's placement:"line" to run the text
   *  along each edge. jsPDF has no placement:"line", so this does the same
   *  job manually: rotate the text to the edge's own angle, fold that angle
   *  into (-90, 90] so it never renders upside-down or right-to-left, and
   *  skip edges too short to hold the label (see EDGE_LABEL_FIT_RATIO). */
  function drawEdgeDistanceLabels(doc, ring, project, fontSize, frame) {
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

      // Centre the glyphs ON the line. jsPDF anchors text on its baseline,
      // so glyphs sit wholly to one side of the anchor; its own
      // baseline:"middle" option isn't applied in the ROTATED text's frame,
      // which is why it looked right on near-horizontal edges and pushed
      // off to the side on near-vertical ones. So the correction is done
      // here instead, rotated by the same angle as the text.
      //
      // "Down relative to the text" is (0, +h) in the text's own frame;
      // rotating that by the jsPDF angle `a` (positive = counter-clockwise
      // on the page, where page y grows downward) gives:
      //     dx = h*sin(a),  dy = h*cos(a)
      // At a=0 that's a straight downward nudge, which is exactly what
      // centres glyphs that sit above their baseline.
      const a = (angleDeg * Math.PI) / 180;
      const h = fontSize * EDGE_LABEL_CENTER_FACTOR;
      const perpX = h * Math.sin(a);
      const perpY = h * Math.cos(a);

      const lx = midX + (-dy / len) * EDGE_LABEL_OFFSET_PT + perpX;
      const ly = midY + (dx / len) * EDGE_LABEL_OFFSET_PT + perpY;
      if (frame && !pointInRect([lx, ly], frame)) continue; // off-page edge
      drawHaloText(doc, text, lx, ly, {
        fontSize, colorRGB: EDGE_DISTANCE_RGB, angle: angleDeg
      });
    }
  }

  function drawBlockVector(doc, feature, project, sizes, frame) {
    const geometry = feature.getGeometry();
    if (!geometry) return;
    const status = feature.get("cultivation_status");
    let fillRGB = null, fillAlpha = 1;
    // "Status colour fills" off in Setup means outlines only — no
    // cultivation-status shading at all.
    if (settings.hatching && status && CULTIVATION_PALETTE?.[status] && status !== "vacant") {
      const parsed = parseRgba(CULTIVATION_PALETTE[status].fill);
      fillRGB = parsed.rgb;
      fillAlpha = parsed.a;
    }
    forEachOuterRing(geometry, (ring) => {
      const clipped = clipPolygonToRect(ring.map(project), frame);
      if (clipped.length < 3) return;
      drawClosedPath(doc, clipped, {
        fill: fillRGB, fillAlpha,
        strokeColor: BLOCK_STROKE_RGB, strokeWidth: sizes.blockStroke
      });
    });
    if (!settings.labels.block) return;
    const ip = getFeatureInteriorPoint?.(geometry);
    if (!ip) return;
    const anchor = project(ip.getCoordinates());
    if (!pointInRect(anchor, frame)) return; // label anchored off-page
    const name = String(feature.get("block_name") ?? "").trim() || "—";
    drawHaloText(doc, name, anchor[0], anchor[1], { fontSize: sizes.blockLabel, colorRGB: BLOCK_STROKE_RGB });
  }

  function drawParcelVector(doc, feature, project, sizes, frame) {
    const geometry = feature.getGeometry();
    if (!geometry) return;
    const status = feature.get("cultivation_status");
    const alertSeverity = feature.get("_alert_severity");
    const alertCount = feature.get("_alert_count");

    // With "Status colour fills" off, plots print as bare outlines — no
    // cultivation shading and no alert shading either, since both are the
    // same kind of area colouring the user asked to be able to drop. The
    // Alerts(n) label below still prints; only the fill goes.
    let fillRGB = null, fillAlpha = 1;
    if (settings.hatching) {
      fillRGB = [255, 255, 255];
      fillAlpha = 0.05;
      if (status && CULTIVATION_PALETTE?.[status] && status !== "vacant") {
        const parsed = parseRgba(CULTIVATION_PALETTE[status].fill);
        fillRGB = parsed.rgb;
        fillAlpha = parsed.a;
      }
      if (alertSeverity && ALERT_SEVERITY_FILL?.[alertSeverity]) {
        const parsed = parseRgba(ALERT_SEVERITY_FILL[alertSeverity]);
        fillRGB = parsed.rgb;
        fillAlpha = parsed.a;
      }
    }

    forEachOuterRing(geometry, (ring) => {
      const clipped = clipPolygonToRect(ring.map(project), frame);
      if (clipped.length < 3) return;
      drawClosedPath(doc, clipped, {
        fill: fillRGB, fillAlpha,
        haloColor: [255, 255, 255], haloWidth: sizes.parcelHalo,
        strokeColor: PARCEL_STROKE_RGB, strokeWidth: sizes.parcelStroke
      });
    });

    // Plot edge lengths, rotated to follow each edge — the "Line
    // distances" toggle, off by default because it puts a number on every
    // boundary segment of every plot. Plots only; blocks never had these
    // on screen either.
    if (settings.labels.distance) {
      forEachOuterRing(geometry, (ring) => drawEdgeDistanceLabels(doc, ring, project, sizes.edgeDistance, frame));
    }

    const ip = getFeatureInteriorPoint?.(geometry);
    if (!ip) return;
    const anchor = project(ip.getCoordinates());
    if (!pointInRect(anchor, frame)) return; // label anchored off-page
    const [px, py] = anchor;
    const pLabel = feature.get("parcel_name") || feature.get("parcel_code");
    const label = pLabel != null && pLabel !== "" ? String(pLabel) : "—";

    // Each line of the plot label is its own toggle in the Text labels tab.
    const expArea = feature.get("expected_area_acres");
    const areaText = expArea ? `${Number(expArea).toFixed(2)} ac` : (surveyFeatureAreaAcresText?.(feature) || "");
    const area = settings.labels.area ? areaText : "";
    const ratoonVal = feature.get("ratoon_number");
    const hasRatoon = settings.labels.ratoon &&
      ratoonVal !== null && ratoonVal !== undefined && ratoonVal !== "";
    const ratoonLine = hasRatoon ? `R:${ratoonVal}` : null;

    const parts = [];
    if (settings.labels.plot) parts.push(label);
    if (area) parts.push(area);
    if (ratoonLine) parts.push(ratoonLine);
    const text = parts.join("\n");
    const lineCount = parts.length || 1;

    const fontSize = sizes.parcelLabel;
    if (text) drawHaloText(doc, text, px, py, { fontSize, colorRGB: PARCEL_STROKE_RGB });

    if (settings.labels.alerts && alertSeverity && alertCount) {
      const alertRGB = parseRgba(ALERT_SEVERITY_COLORS?.[alertSeverity] || "").rgb;
      const offsetPt = (lineCount + 1.6) * fontSize * 0.42;
      drawHaloText(doc, `Alerts(${alertCount})`, px, py + offsetPt, { fontSize, colorRGB: alertRGB });
    }
  }

  /** Estate boundary — dashed orange outline, no fill, name at the
   *  top-left of its extent, mirroring estatesLayer's own style. */
  function drawEstateVector(doc, feature, project, sizes, frame) {
    const geometry = feature.getGeometry();
    if (!geometry) return;
    doc.setDrawColor(ESTATE_STROKE_RGB[0], ESTATE_STROKE_RGB[1], ESTATE_STROKE_RGB[2]);
    doc.setLineWidth(sizes.estateStroke);
    if (doc.setLineDash) doc.setLineDash([sizes.estateDash, sizes.estateDash * 1.6], 0);
    forEachOuterRing(geometry, (ring) => {
      const clipped = clipPolygonToRect(ring.map(project), frame);
      if (clipped.length < 3) return;
      for (let i = 0; i < clipped.length; i++) {
        const a = clipped[i];
        const b = clipped[(i + 1) % clipped.length];
        doc.line(a[0], a[1], b[0], b[1]);
      }
    });
    if (doc.setLineDash) doc.setLineDash([], 0);

    const name = String(feature.get("estate_name") ?? "").trim();
    if (!name || !settings.labels.estate) return;
    // Same anchor as on screen: top-left corner of the geometry's extent.
    const ext = geometry.getExtent();
    const anchor = project([ext[0], ext[3]]);
    if (!pointInRect(anchor, frame)) return;
    drawHaloText(doc, name, anchor[0], anchor[1], {
      fontSize: sizes.estateLabel,
      colorRGB: ESTATE_STROKE_RGB,
      align: "left"
    });
  }

  /** Land Title boundary — dashed purple outline (no fill), name and area
   *  centred inside the polygon (same anchor as drawParcelVector's label),
   *  matching titlesLayer's own on-screen style exactly. */
  function drawTitleVector(doc, feature, project, sizes, frame) {
    const geometry = feature.getGeometry();
    if (!geometry) return;
    // Outline only — no fill pass, matching titlesLayer's on-screen style
    // (a title tint would muddy the Block/Plot status colours beneath it).
    // Dashes are drawn segment-by-segment because drawClosedPath has no
    // dash-capable stroke option — same split drawEstateVector uses.
    doc.setDrawColor(TITLE_BOUNDARY_RGB[0], TITLE_BOUNDARY_RGB[1], TITLE_BOUNDARY_RGB[2]);
    doc.setLineWidth(sizes.titleStroke);
    if (doc.setLineDash) doc.setLineDash([sizes.titleDash, sizes.titleDash * 1.2], 0);
    forEachOuterRing(geometry, (ring) => {
      const clipped = clipPolygonToRect(ring.map(project), frame);
      if (clipped.length < 3) return;
      for (let i = 0; i < clipped.length; i++) {
        const a = clipped[i];
        const b = clipped[(i + 1) % clipped.length];
        doc.line(a[0], a[1], b[0], b[1]);
      }
    });
    if (doc.setLineDash) doc.setLineDash([], 0);

    if (!settings.labels.titleDetails) return;
    const ip = getFeatureInteriorPoint?.(geometry);
    if (!ip) return;
    const anchor = project(ip.getCoordinates());
    if (!pointInRect(anchor, frame)) return; // label anchored off-page
    const name = String(feature.get("title_name") ?? "").trim();
    const expArea = feature.get("expected_area_acres");
    const areaText = expArea ? `${Number(expArea).toFixed(2)} ac` : (surveyFeatureAreaAcresText?.(feature) || "");
    const text = name && areaText ? `${name}\n${areaText}` : (name || areaText);
    if (text) {
      drawHaloText(doc, text, anchor[0], anchor[1], { fontSize: sizes.titleLabel, colorRGB: TITLE_BOUNDARY_RGB });
    }
  }

  /** Saved custom features (trees, boreholes, roads, walls, …) — polygons
   *  get a translucent fill + outline, lines a stroke, and points get
   *  their real Font Awesome icon from /icons (see preloadFeatureIcons),
   *  falling back to a filled dot when an icon can't be loaded. All in the
   *  feature type's own colour, with the feature's name beneath. */
  /** Lift of a line-following label off the stroke it sits on, as a
   *  fraction of the font size. Subtracted from EDGE_LABEL_CENTER_FACTOR,
   *  so 0 leaves the text straddling the line and larger values raise it.
   *  0.18 reproduces the live map's `offsetY: -2` at its 11px label font
   *  (see displayLabelStyle in js/survey-draw.js). */
  const FEATURE_LINE_LABEL_LIFT_FACTOR = 0.18;

  /** The jsPDF rotation that makes text run along a segment.
   *
   *  Same convention as drawEdgeDistanceLabels: page y grows downward while
   *  a positive jsPDF angle turns counter-clockwise, hence the sign flip.
   *  Folding into (-90, 90] keeps the text reading left-to-right instead of
   *  upside-down; since the text is centred on its anchor, a 180 degree fold
   *  doesn't move it. */
  function lineLabelAngle(dx, dy) {
    let angleDeg = EDGE_LABEL_ANGLE_SIGN * Math.atan2(dy, dx) * (180 / Math.PI);
    if (angleDeg > 90) angleDeg -= 180;
    else if (angleDeg <= -90) angleDeg += 180;
    return angleDeg;
  }

  /** Nudges a rotated label off the stroke it sits on.
   *
   *  jsPDF anchors text on its baseline, and its baseline:"middle" isn't
   *  applied in the ROTATED frame — so the vertical centring is done here,
   *  rotated by the same angle. "Down in the text's own frame" is
   *  (sin a, cos a) on the page; moving the baseline that way by ~half the
   *  cap height straddles the line, and subtracting the lift raises the text
   *  just clear of the stroke. */
  function liftLabelOffLine(at, angleDeg, fontSize) {
    const a = (angleDeg * Math.PI) / 180;
    const h = fontSize * (EDGE_LABEL_CENTER_FACTOR - FEATURE_LINE_LABEL_LIFT_FACTOR);
    return [at[0] + h * Math.sin(a), at[1] + h * Math.cos(a)];
  }

  /** Guess at how wide a name will print, without needing the document.
   *  Only feeds the fit and overlap tests, so an approximation is fine. */
  function estimateTextWidth(text, fontSize) {
    return String(text || "").length * fontSize * FEATURE_LABEL_CHAR_WIDTH_FACTOR;
  }

  /** The page rectangle a label occupies, used to stop repeated names
   *  landing on top of each other. Rotated text is measured by its
   *  unrotated box, which is close enough at the shallow angles roads
   *  usually run at. */
  function labelBox(at, text, fontSize, align) {
    const w = estimateTextWidth(text, fontSize);
    const h = fontSize;
    const x0 = align === "left" ? at[0] : at[0] - w / 2;
    return { x0, y0: at[1] - h * 0.8, x1: x0 + w, y1: at[1] + h * 0.3 };
  }

  function boxesOverlap(a, b) {
    return !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0);
  }

  /**
   * Walks a road on the page and returns every good spot to repeat its name.
   *
   * OpenLayers does this internally on the live map but exposes nothing
   * about where it landed, so the PDF works it out from scratch: march along
   * the projected line, and every `repeatPt` of travel consider dropping a
   * label. A spot is only used when the straight piece of road it falls on
   * is long enough to hold the whole name with room to spare — which is what
   * keeps text off bends and off short stubs at junctions, without needing a
   * separate angle rule.
   *
   * Returns anchors with the road's local bearing, ready to rotate.
   */
  function planLineLabelAnchors(lines, project, frame, text, fontSize, repeatPt) {
    const anchors = [];
    if (!(repeatPt > 0)) return anchors;
    const textW = estimateTextWidth(text, fontSize);
    const needed = textW * FEATURE_LABEL_FIT_FACTOR;

    for (const line of lines) {
      const pts = line.map(project);
      // Start half an interval in, so a road that's only just long enough
      // gets its name near the middle rather than jammed against one end.
      let nextAt = repeatPt / 2;
      let travelled = 0;

      for (let i = 0; i < pts.length - 1 && anchors.length < FEATURE_LABEL_MAX_REPEATS; i++) {
        const [x0, y0] = pts[i];
        const [x1, y1] = pts[i + 1];
        const segLen = Math.hypot(x1 - x0, y1 - y0);
        if (segLen <= 0) continue;

        while (nextAt <= travelled + segLen && anchors.length < FEATURE_LABEL_MAX_REPEATS) {
          const into = nextAt - travelled;
          nextAt += repeatPt;

          // The whole name has to sit inside this one straight run.
          if (segLen < needed) continue;
          if (into < needed / 2 || segLen - into < needed / 2) continue;

          const t = into / segLen;
          const at = [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
          if (!pointInRect(at, frame)) continue;

          anchors.push({ at, dx: x1 - x0, dy: y1 - y0 });
        }
        travelled += segLen;
      }
    }
    return anchors;
  }

  /**
   * Works out everything one custom feature needs drawn, WITHOUT drawing any
   * of it. Splitting "decide" from "paint" is what lets drawFeaturePlans
   * below paint every feature's casing before any feature's knockout — see
   * the note there for why that matters at junctions.
   *
   * Returns null for a feature with nothing visible in this frame.
   */
  function planCustomFeature(feature, project, sizes, frame) {
    const geometry = feature.getGeometry();
    if (!geometry) return null;
    const type = geometry.getType();
    const colorRGB = parseRgba(feature.get("_color") || "#3f8f3f").rgb;
    const name = String(feature.get("_name") ?? "").trim();
    let labelAnchor = null;
    // Points label to the right of their marker, lines and polygons stay
    // centred — same split as the live map (see displayLabelStyle in
    // js/survey-draw.js).
    let labelAlign = "center";
    // Rotation for line features whose type asks for it (degrees, jsPDF
    // convention). Stays null for everything else, which keeps the label
    // horizontal exactly as before.
    let labelAngle = null;

    if (type === "Point" || type === "MultiPoint") {
      const coords = type === "Point" ? [geometry.getCoordinates()] : geometry.getCoordinates();
      const iconClass = feature.get("_icon") || "";
      const iconUrl = iconClass ? faIconDataUrl(iconClass, colorRGB) : null;
      labelAlign = "left";
      // jsPDF draws text from its baseline, so the anchor is nudged down by
      // roughly a third of the cap height to sit level with the marker.
      const vCentre = sizes.featureLabel * 0.35;
      const marks = [];
      coords.forEach((c) => {
        const p = project(c);
        if (!pointInRect(p, frame)) return;
        if (iconUrl) {
          const s = sizes.featureIcon;
          marks.push({ p, iconUrl, size: s });
          if (!labelAnchor) labelAnchor = [p[0] + s * 0.6, p[1] + vCentre];
        } else {
          const r = sizes.featurePoint;
          marks.push({ p, radius: r });
          if (!labelAnchor) labelAnchor = [p[0] + r * 1.6, p[1] + vCentre];
        }
      });
      if (!marks.length) return null;
      return {
        kind: "point",
        colorRGB,
        marks,
        label: name && labelAnchor ? { text: name, at: labelAnchor, align: labelAlign, angle: null, colorRGB } : null
      };
    } else if (type === "LineString" || type === "MultiLineString") {
      const linetype = feature.get("_linetype") || "solid";
      const lines = type === "LineString" ? [geometry.getCoordinates()] : geometry.getCoordinates();
      const weightPt = featureStrokePt(feature, sizes);
      const spacingPt = (Number(feature.get("_lineSpacingM")) || 0) * sizes.ptPerMeter;
      // "No line" prints nothing but still gets its label, same as on screen
      // — so the segments below are still walked, just never stroked.
      const passes =
        linetype === "none"
          ? []
          : pdfLineStrokes(
              colorRGB, weightPt, dashPatternFor(linetype, weightPt),
              feature.get("_lineStyle"), spacingPt
            );

      // Clipped geometry, resolved once and reused by every pass — a
      // double/triple line is the same shape painted two or three times at
      // different widths, so re-projecting per pass would be pure waste (and
      // risks the passes disagreeing).
      //
      // Kept as CONTIGUOUS RUNS of points, not loose segments. Each run is
      // stroked as a single jsPDF path, which is the only way the PDF gets
      // real line joins at corners — jsPDF's doc.line() emits every segment
      // as its own two-point path, so a corner would be two unconnected
      // strokes butted together. (Round caps used to paper over that, at the
      // cost of a semicircle sticking out past both ends of every road.) A
      // run breaks wherever clipping drops a piece or the line leaves and
      // re-enters the page.
      const paths = [];
      let currentPath = null;
      const SAME_PT = 0.01;
      const isSamePoint = (a, b) => Math.abs(a[0] - b[0]) < SAME_PT && Math.abs(a[1] - b[1]) < SAME_PT;
      // The label rides the LONGEST visible segment rather than the first
      // one. The first segment of a road is often a short stub off a
      // junction — anchoring there gave the label an arbitrary tilt and
      // crowded the corner. The longest run is both the most representative
      // direction and the piece with room for the text, which is roughly
      // what OL's placement:"line" settles on.
      let bestSeg = null;
      let bestLen = -1;
      lines.forEach((line) => {
        const pts = line.map(project);
        currentPath = null;
        for (let i = 0; i < pts.length - 1; i++) {
          const seg = clipSegmentToRect(pts[i], pts[i + 1], frame);
          if (!seg) {
            currentPath = null; // gap — the next piece starts a fresh run
            continue;
          }
          if (currentPath && isSamePoint(currentPath[currentPath.length - 1], seg[0])) {
            currentPath.push(seg[1]);
          } else {
            currentPath = [seg[0], seg[1]];
            paths.push(currentPath);
          }
          const segLen = Math.hypot(seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]);
          if (segLen > bestLen) {
            bestLen = segLen;
            bestSeg = seg;
          }
        }
      });

      // Follow the line only when the feature type asks for it, matching
      // the live map: displayLabelStyle sets placement:"line" only for
      // _labelDir === "along". Any other setting stays horizontal, which
      // is what it looks like on screen too — and, as on the map, a
      // horizontal label is placed once rather than repeated.
      const along = feature.get("_labelDir") === "along";

      if (bestSeg) {
        labelAnchor = [
          (bestSeg[0][0] + bestSeg[1][0]) / 2,
          (bestSeg[0][1] + bestSeg[1][1]) / 2
        ];
        if (along && bestLen > 0) {
          labelAngle = lineLabelAngle(bestSeg[1][0] - bestSeg[0][0], bestSeg[1][1] - bestSeg[0][1]);
          labelAnchor = liftLabelOffLine(labelAnchor, labelAngle, sizes.featureLabel);
        }
      }

      // Extra copies of the name further along the road — the printed
      // equivalent of OpenLayers' `repeat`. Drawn only if they don't collide
      // with a name already on the page (see drawFeaturePlans), so the
      // primary label above is never lost to one of its own repeats.
      const repeats = [];
      if (along && name) {
        planLineLabelAnchors(lines, project, frame, name, sizes.featureLabel, sizes.featureLabelRepeat)
          .forEach((anchor) => {
            const angle = lineLabelAngle(anchor.dx, anchor.dy);
            repeats.push({
              text: name,
              at: liftLabelOffLine(anchor.at, angle, sizes.featureLabel),
              align: "center",
              angle,
              colorRGB
            });
          });
      }

      if (!paths.length) return null;
      return {
        kind: "line",
        paths,
        passes,
        label: name && labelAnchor ? { text: name, at: labelAnchor, align: labelAlign, angle: labelAngle, colorRGB } : null,
        repeats
      };
    }

    // Polygon.
    const polyLinetype = feature.get("_linetype") || "solid";
    const polyWeightPt = featureStrokePt(feature, sizes);
    const rings = [];
    forEachOuterRing(geometry, (ring) => {
      const clipped = clipPolygonToRect(ring.map(project), frame);
      if (clipped.length >= 3) rings.push(clipped);
    });
    if (!rings.length) return null;

    const ip = getFeatureInteriorPoint?.(geometry);
    if (ip) {
      const a = project(ip.getCoordinates());
      if (pointInRect(a, frame)) labelAnchor = a;
    }

    return {
      kind: "polygon",
      rings,
      fill: colorRGB,
      // "No line" polygons print as bare fill, same as on screen.
      strokeColor: polyLinetype === "none" ? null : colorRGB,
      strokeWidth: polyWeightPt,
      dash: polyLinetype === "none" ? null : dashPatternFor(polyLinetype, polyWeightPt),
      label: name && labelAnchor ? { text: name, at: labelAnchor, align: labelAlign, angle: labelAngle, colorRGB } : null
    };
  }

  function drawPointPlan(doc, plan) {
    plan.marks.forEach((m) => {
      if (m.iconUrl) {
        // Icon box centred on the point, so it sits where the dot did.
        doc.addImage(m.iconUrl, "PNG", m.p[0] - m.size / 2, m.p[1] - m.size / 2, m.size, m.size);
      } else {
        doc.setFillColor(plan.colorRGB[0], plan.colorRGB[1], plan.colorRGB[2]);
        doc.setDrawColor(255, 255, 255);
        doc.setLineWidth(Math.max(0.1, m.radius * 0.25));
        doc.circle(m.p[0], m.p[1], m.radius, "FD");
      }
    });
  }

  function drawPolygonPlan(doc, plan) {
    if (plan.dash && doc.setLineDash) doc.setLineDash(plan.dash, 0);
    plan.rings.forEach((ring) => {
      drawClosedPath(doc, ring, {
        fill: plan.fill,
        fillAlpha: 0.18,
        strokeColor: plan.strokeColor,
        strokeWidth: plan.strokeWidth
      });
    });
    if (doc.setLineDash) doc.setLineDash([], 0);
  }

  /** Strokes one contiguous run of points as a SINGLE jsPDF path, so the
   *  corners between its segments get real line joins. doc.lines() takes
   *  deltas from the previous point, which is why the run is differenced
   *  here — same call drawClosedPath uses, just left open. */
  function strokePath(doc, path) {
    if (!path || path.length < 2) return;
    const deltas = [];
    for (let i = 1; i < path.length; i++) {
      deltas.push([path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]]);
    }
    doc.lines(deltas, path[0][0], path[0][1], [1, 1], "S", false);
  }

  /** Paints just the strokes of `plan` that belong to `role`. */
  function drawLinePassRole(doc, plan, role) {
    plan.passes
      .filter((pass) => pass.role === role)
      .forEach((pass) => {
        doc.setDrawColor(pass.rgb[0], pass.rgb[1], pass.rgb[2]);
        doc.setLineWidth(pass.width);
        if (doc.setLineDash) doc.setLineDash(pass.dash || [], 0);
        plan.paths.forEach((path) => strokePath(doc, path));
      });
  }

  /** Draws one label and returns the page rectangle it took up (or null if
   *  there was nothing to draw), so later labels can avoid it. */
  function drawOneLabel(doc, label, sizes) {
    if (!label) return null;
    drawHaloText(doc, label.text, label.at[0], label.at[1], {
      fontSize: sizes.featureLabel,
      colorRGB: label.colorRGB || FEATURE_LABEL_RGB,
      align: label.align,
      // null for points/polygons and for lines not set to "along" —
      // drawHaloText treats a falsy angle as "no rotation".
      angle: label.angle
    });
    return labelBox(label.at, label.text, sizes.featureLabel, label.align);
  }

  /**
   * Paints every custom feature on the page, grouped by what's being drawn
   * rather than by which feature it belongs to.
   *
   * Drawing each feature start-to-finish is what produced the broken
   * junctions: a road paints its wide casing, then its white core, and the
   * NEXT road's white core then lands on top of the first road's finished
   * pixels, cutting a white slice straight through it. Painting every
   * casing, then every core, then every centreline means roads that cross
   * share one continuous casing layer and one continuous core layer, so the
   * junction merges instead of one road erasing the other. It's the same
   * ordering Mapnik/QGIS use for cased roads.
   *
   * Round JOINS go on for the whole line phase, butt caps stay. Each road is
   * stroked as one path per contiguous run (see strokePath), so jsPDF applies
   * genuine joins at its corners — a round join is a disc of radius width/2
   * at the vertex, and discs of different radii around the same point stay
   * concentric, which is what stops the narrow knockout biting a wedge out of
   * the wide casing. (A mitre or bevel projects past the vertex by an amount
   * that depends on stroke width, so the passes disagreed about where the
   * corner was.) Caps stay butt: a round cap would add a semicircle past the
   * last vertex, printing the road half a stroke width longer than it was
   * surveyed.
   */
  function drawFeaturePlans(doc, plans, sizes) {
    // Fills first, so lines and markers sit on top of them.
    plans.filter((p) => p.kind === "polygon").forEach((p) => drawPolygonPlan(doc, p));

    const linePlans = plans.filter((p) => p.kind === "line");
    if (linePlans.length) {
      const hasCap = typeof doc.setLineCap === "function";
      const hasJoin = typeof doc.setLineJoin === "function";
      if (hasCap) doc.setLineCap(0); // 0 = butt — ends stop where the road does
      if (hasJoin) doc.setLineJoin(1); // 1 = round — corners agree across passes

      LINE_PASS_ORDER.forEach((role) => {
        linePlans.forEach((plan) => drawLinePassRole(doc, plan, role));
      });

      if (doc.setLineDash) doc.setLineDash([], 0);
      // Back to jsPDF's defaults so the blocks/parcels/legend drawing that
      // follows isn't silently restyled.
      if (hasCap) doc.setLineCap(0); // 0 = butt
      if (hasJoin) doc.setLineJoin(0); // 0 = mitre
    }

    plans.filter((p) => p.kind === "point").forEach((p) => drawPointPlan(doc, p));

    // Labels last of all — no stroke can paint over a name this way.
    //
    // Two rounds, and the order matters. Every feature's PRIMARY label goes
    // down first and unconditionally, so nothing that used to be labelled
    // stops being labelled. The repeats then fill in along each road, but
    // only where they don't land on a name already on the page — a poor
    // man's version of the declutter OpenLayers does for the live map.
    if (!settings.labels.feature) return;
    const placed = [];
    plans.forEach((p) => {
      const box = drawOneLabel(doc, p.label, sizes);
      if (box) placed.push(box);
    });
    plans.forEach((p) => {
      (p.repeats || []).forEach((rep) => {
        const box = labelBox(rep.at, rep.text, sizes.featureLabel, rep.align);
        if (placed.some((b) => boxesOverlap(b, box))) return;
        drawOneLabel(doc, rep, sizes);
        placed.push(box);
      });
    });
  }

  /** Draws everything that intersects `extent`, bottom-up in the same
   *  order the live map stacks them: estates, then blocks, then parcels,
   *  then the custom features on top.
   *
   *  Every font size and line width comes from computePrintSizes(), which
   *  divides the BASE_* constants by the selection's ground size in km —
   *  computed once here and passed down, so the whole page is drawn at one
   *  consistent scale. `frame` is the map rectangle everything is trimmed
   *  to, so nothing bleeds out to the page border. */
  /** True when this feature's TYPE is switched on in the Features tab.
   *  `null` there means "all types", including any drawn since. */
  function featureTypeEnabled(feature) {
    if (settings.featureTypes === null) return true;
    const id = feature.get("_typeId");
    return id == null ? true : settings.featureTypes.has(id);
  }

  function drawMapVectors(doc, extent, drawX, drawY, drawW, drawH) {
    if (!extent) return;
    const project = makeProjector(extent, drawX, drawY, drawW, drawH);
    const sizes = computePrintSizes(extent);
    // Page points per real ground metre — the sheet's scale, in effect.
    // Needed by anything measured on the ground rather than on screen (so
    // far: line_spacing_m, the gap inside a double/triple line). Web-
    // Mercator units are only true metres at the equator, hence the cosine
    // correction, same as the map's metersToPixels.
    sizes.ptPerMeter = ptPerMeterFor(extent, drawW);
    const frame = { x0: drawX, y0: drawY, x1: drawX + drawW, y1: drawY + drawH };

    if (settings.layers.estate) {
      estatesLayer?.getSource()?.getFeaturesInExtent(extent)
        .forEach((f) => drawEstateVector(doc, f, project, sizes, frame));
    }
    if (settings.layers.block) {
      blocksLayer?.getSource()?.getFeaturesInExtent(extent)
        .forEach((f) => drawBlockVector(doc, f, project, sizes, frame));
    }
    if (settings.layers.plot) {
      parcelsLayer?.getSource()?.getFeaturesInExtent(extent)
        .forEach((f) => drawParcelVector(doc, f, project, sizes, frame));
    }
    if (settings.layers.titleBoundary) {
      titlesLayer?.getSource()?.getFeaturesInExtent(extent)
        .forEach((f) => drawTitleVector(doc, f, project, sizes, frame));
    }
    // Planned first, painted second — the whole feature set has to be known
    // before any of it is drawn, so the casing/knockout/fill rounds can span
    // every feature. See drawFeaturePlans.
    const featurePlans = (getFeaturesLayer?.()?.getSource()?.getFeaturesInExtent(extent) || [])
      .filter(featureTypeEnabled)
      .map((f) => planCustomFeature(f, project, sizes, frame))
      .filter(Boolean);
    drawFeaturePlans(doc, featurePlans, sizes);
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

  /** Signed-in user's name for the "Printed by" line, via map-app.js's
   *  window hook. Null for guests, in which case the line is skipped. */
  function currentUserName() {
    try { return window.vslCurrentUserName?.() || null; } catch { return null; }
  }

  /** Google Maps link for the centre of the printed area — same format
   *  the Feature Info export uses, so a scan lands in the same place. */
  function googleMapsLinkForExtent(extent) {
    if (!extent) return null;
    const cx = (extent[0] + extent[2]) / 2;
    const cy = (extent[1] + extent[3]) / 2;
    const [lon, lat] = ol.proj.transform([cx, cy], "EPSG:3857", "EPSG:4326");
    return `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
  }

  /** Same public QR-image service js/feature-export.js uses (no key, sends
   *  CORS headers). Fetched as a blob and turned into a data URL because
   *  that's what jsPDF's addImage() needs. */
  async function fetchQrCodeDataUrl(data) {
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("QR code service unavailable");
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Failed to read QR code image"));
      reader.readAsDataURL(blob);
    });
  }

  /** "VSL Map Print <SS>S<MM>M<HH>H<DD>D.pdf" — seconds/minutes/hour/day
   *  of generation time, per the requested S/M/H/D format. */
  function buildPrintFilename() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `VSL Map Print ${pad(d.getSeconds())}${pad(d.getMinutes())}${pad(d.getHours())}${pad(d.getDate())}.pdf`;
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
    const wantBasemap = !!settings.basemap;
    const boost = wantBasemap && !!settings.boostQuality;
    const scale = boost ? BASEMAP_ZOOM_SCALE_BOOST : BASEMAP_ZOOM_SCALE;
    const firstMsg = !wantBasemap
      ? "Drawing map…"
      : (boost ? "Rendering imagery (high quality)…" : "Rendering imagery…");
    setPrintStatus(firstMsg, false);
    setCapturingOverlay(true, firstMsg);
    try {
      // Must be read before captureBasemapOnly touches the map's size/
      // resolution — see getPrintExtent's comment above.
      const extent = getPrintExtent();

      // The imagery capture is skipped entirely when the user turned the
      // basemap off (or has no basemap layer switched on) — the vectors
      // then print on plain white, and the whole slow tile step is avoided.
      let cropped = null;
      let croppedDataUrl = null;
      if (wantBasemap) {
        const fullCanvas = await captureBasemapOnly(scale, boost ? BOOST_TILE_WAIT_MS : 0);
        const scaledRect = {
          left: selectionRect.left * scale,
          top: selectionRect.top * scale,
          width: selectionRect.width * scale,
          height: selectionRect.height * scale
        };
        cropped = cropCanvasToRect(fullCanvas, scaledRect);
        croppedDataUrl = cropped.toDataURL("image/png");
      }

      // Feature icons for the legend. These are local files, but loading
      // and rasterising them is async, so the cache is warmed here — the
      // legend drawing further down is synchronous and just reads it.
      await preloadFeatureIcons(extent);

      // QR for the centre of the printed area. Fetched from a remote
      // service, so a failure here must not sink the whole print — the
      // page just goes out without it.
      const mapsLink = googleMapsLinkForExtent(extent);
      let qrDataUrl = null;
      if (settings.details.qr && mapsLink) {
        setCapturingOverlay(true, "Fetching QR code…");
        try {
          qrDataUrl = await fetchQrCodeDataUrl(mapsLink);
        } catch (qrErr) {
          console.warn("[Victoria Print] QR code unavailable, continuing without it:", qrErr);
        }
      }

      // Orientation isn't a setting — automatic from whichever side of the
      // selection is longer.
      const orientation = selectionRect.width >= selectionRect.height ? "landscape" : "portrait";
      const doc = new jsPDFCtor({ unit: "pt", format: "a4", orientation });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();

      // Page geometry comes from computePageLayout — the SAME function the
      // on-screen selection lock reads, so a locked selection fills its
      // frame exactly with no letterboxing.
      const legendGroups = settings.details.legend ? buildLegendGroups(extent) : [];
      const showLegend = settings.details.legend && legendGroups.length > 0;
      const showNorthArrow = !!settings.details.northArrow;
      const showQr = !!qrDataUrl;
      const showCounts = !!settings.details.counts;
      const showSummary = !!settings.details.comments; // the reserved Comments box
      const showStamp = !!(
        settings.details.date || settings.details.source ||
        (settings.details.printedBy && currentUserName())
      );
      const L = computePageLayout(orientation, {
        legend: showLegend, northArrow: showNorthArrow, qr: showQr,
        summary: showSummary, stamp: showStamp
      });
      const margin = L.margin;
      const mapTop = L.mapTop;
      const mapAreaW = L.mapAreaW;
      const mapAreaH = L.mapAreaH;
      const title = (titleInput.value || "").trim();

      // Letterbox into the map frame without distorting. With the aspect
      // lock on this is a no-op (the ratios match); with it off, this is
      // what keeps a mismatched selection from stretching. Without a
      // basemap there's no image to fit, so the selection's own shape
      // stands in — the vectors still land in the right place.
      const snapRatio = cropped
        ? cropped.width / cropped.height
        : selectionRect.width / selectionRect.height;
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

      // Plain white behind a basemap-less print; the usual grey letterbox
      // backing when there IS an image to sit on.
      doc.setFillColor(croppedDataUrl ? 245 : 255, croppedDataUrl ? 245 : 255, croppedDataUrl ? 245 : 255);
      doc.rect(margin, mapTop, mapAreaW, mapAreaH, "F");
      if (croppedDataUrl) {
        doc.addImage(croppedDataUrl, "PNG", drawX, drawY, drawW, drawH);
      }

      // Estates / blocks / plots / features — real vectors on top of the
      // imagery, all trimmed to the map rectangle in geometry (see
      // clipPolygonToRect) so nothing bleeds out to the page border.
      drawMapVectors(doc, extent, drawX, drawY, drawW, drawH);

      doc.setDrawColor(190);
      doc.setLineWidth(1);
      doc.rect(margin, mapTop, mapAreaW, mapAreaH, "S");

      // Title, centred over the map frame. Nothing is drawn when the user
      // left it blank (no "Untitled Map" placeholder) or switched it off.
      if (title && settings.details.title) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(16);
        doc.setTextColor(30, 42, 30);
        doc.text(title, margin + mapAreaW / 2, margin + 15, { align: "center" });
      }

      /** North arrow drawn to fill a given cell. */
      /** North arrow, sized to whatever cell it's given — it shares the
       *  bottom row with the QR in landscape and sits in the bar in
       *  portrait, so the geometry is proportional rather than fixed. */
      const drawNorthArrowCell = (x, y, w, h) => {
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(120);
        doc.setLineWidth(1);
        doc.rect(x, y, w, h, "FD");

        const cx = x + w / 2;
        const s = Math.min(w, h);
        // Arrow occupies the upper ~62%, the "N" sits under it.
        const headH = s * 0.26;
        const shaftH = s * 0.20;
        const top = y + h * 0.16;
        const halfW = s * 0.16;

        doc.setFillColor(30, 42, 30);
        doc.triangle(cx, top, cx - halfW, top + headH, cx + halfW, top + headH, "F");
        doc.rect(cx - s * 0.055, top + headH - 0.5, s * 0.11, shaftH, "F");

        doc.setFont("helvetica", "bold");
        doc.setFontSize(Math.max(6.5, Math.min(10, s * 0.2)));
        doc.setTextColor(30, 42, 30);
        doc.text("N", cx, top + headH + shaftH + s * 0.2, { align: "center" });
      };

      /** Legend drawn into a given cell. `columns` lays the swatch rows out
       *  side by side, which is what makes the short, wide portrait bar
       *  usable instead of clipping most of the list. */
      /** One legend swatch, drawn per its symbol kind — see
       *  buildLegendGroups for what each kind means. */
      const drawLegendSwatch = (sym, cx, cy, size) => {
        doc.setLineWidth(0.5);
        const dash = sym.dashPattern || (sym.dash ? [1.2, 1.2] : null);

        if (sym.kind === "line") {
          doc.setDrawColor(sym.stroke[0], sym.stroke[1], sym.stroke[2]);
          const lw = 1.2;
          doc.setLineWidth(lw);
          const y = cy - size / 2;
          // One rule per parallel line, offset by a legible fixed gap (the
          // real spacing is in ground metres and would be meaningless in a
          // swatch this size). Triple's centre rule is dotted, matching the
          // map and the printed feature.
          const count = sym.lineStyle === "triple" ? 3 : sym.lineStyle === "double" ? 2 : 1;
          const step = lw + 1.4;
          const offsets = count === 1 ? [0] : count === 2 ? [-step / 2, step / 2] : [-step, 0, step];
          offsets.forEach((off, i) => {
            const isCentre = count === 3 && i === 1;
            const d = isCentre ? dashPatternFor("dotted", lw) : dash;
            if (doc.setLineDash) doc.setLineDash(d || [], 0);
            doc.line(cx, y + off, cx + size, y + off);
          });
          if (doc.setLineDash) doc.setLineDash([], 0);
          return;
        }

        if (sym.kind === "point") {
          // Real Font Awesome icon where we can resolve one; a plain dot
          // is the fallback for icon classes that don't resolve.
          const iconUrl = sym.icon ? faIconDataUrl(sym.icon, sym.fill) : null;
          if (iconUrl) {
            doc.addImage(iconUrl, "PNG", cx, cy - size + 1, size, size);
          } else {
            doc.setFillColor(sym.fill[0], sym.fill[1], sym.fill[2]);
            doc.setDrawColor(255, 255, 255);
            doc.circle(cx + size / 2, cy - size / 2 + 1, size / 2.4, "FD");
          }
          return;
        }

        // Polygon square: filled or hollow, solid or dashed edge.
        const top = cy - size + 2;
        if (sym.fill) {
          setFillAlpha(doc, sym.fillAlpha ?? 1);
          doc.setFillColor(sym.fill[0], sym.fill[1], sym.fill[2]);
          doc.rect(cx, top, size, size, "F");
          resetAlpha(doc);
        }
        const st = sym.stroke || [120, 120, 120];
        doc.setDrawColor(st[0], st[1], st[2]);
        if (dash && doc.setLineDash) doc.setLineDash(dash, 0);
        doc.rect(cx, top, size, size, "S");
        if (doc.setLineDash) doc.setLineDash([], 0);
      };

      /** Grouped legend. Rows flow down each column and wrap into the next
       *  one, so the same builder serves the tall landscape column and the
       *  short wide portrait bar; `columns` just says how many are
       *  available. Group headings flow with their rows. */
      const drawLegendCell = (x, y, w, h, columns) => {
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(120);
        doc.setLineWidth(1);
        doc.rect(x, y, w, h, "FD");

        doc.setFont("helvetica", "bold");
        doc.setFontSize(9);
        doc.setTextColor(30, 42, 30);
        doc.text("LEGEND", x + 8, y + 14);

        // Flatten groups into a single stream of heading/item rows, then
        // deal it into columns.
        // A blank spacer row before each group after the first, so the
        // groups read as separate blocks. Moving the north arrow out of
        // the top of the column bought back the height for these.
        const stream = [];
        legendGroups.forEach((g, gi) => {
          if (gi > 0) stream.push({ type: "gap" });
          stream.push({ type: "head", label: g.title });
          g.items.forEach((it) => stream.push({ type: "item", ...it }));
        });

        const rowsTop = y + 26;
        const avail = h - (rowsTop - y) - 6;

        // ── Row height, then FLOW the rows into columns ───────────────
        // Rows fill a column to its full height and then continue in the
        // next one — the groups are one continuous list, not one column
        // each. (Dealing them out as ceil(total/columns) per column made
        // each group land in its own column purely by coincidence of
        // their sizes, and left most of every column empty.)
        //
        // Row height starts at the comfortable maximum and only shrinks if
        // the list wouldn't otherwise fit the columns available.
        let rowH = 11;
        let rowsPerCol = Math.max(1, Math.floor(avail / rowH));
        while (rowsPerCol * columns < stream.length && rowH > 6.5) {
          rowH = Math.max(6.5, rowH - 0.25);
          rowsPerCol = Math.max(1, Math.floor(avail / rowH));
        }

        const swatch = Math.min(8, rowH - 2);
        const itemFont = Math.min(7, rowH - 2);
        const headFont = Math.min(6.4, rowH - 2);

        const cols = Array.from({ length: columns }, () => []);
        {
          let c = 0;
          for (const row of stream) {
            if (c >= columns) break;
            if (cols[c].length >= rowsPerCol) { c += 1; if (c >= columns) break; }
            // A spacer is only a separator BETWEEN groups — never the
            // first thing in a column.
            if (row.type === "gap" && cols[c].length === 0) continue;
            // Don't strand a group heading alone at the foot of a column;
            // start it at the top of the next one instead.
            if (row.type === "head" && cols[c].length === rowsPerCol - 1 && c < columns - 1) {
              c += 1;
            }
            cols[c].push(row);
          }
        }

        // ── Column widths, measured from content ──────────────────────
        // Columns used to split the box evenly, which stranded a lot of
        // white space inside each one. Instead each column is only as wide
        // as its own widest row needs (symbol + label + count, or its
        // heading, whichever is wider), and they're packed left with a
        // fixed gutter. Whatever's left over collects at the right of the
        // box rather than being spread through every row.
        const colContentW = [];
        for (let c = 0; c < columns; c++) {
          const rows = cols[c];
          doc.setFont("helvetica", "normal");
          doc.setFontSize(itemFont);
          let widestLabel = 0;
          let anyCount = false;
          rows.forEach((r) => {
            if (r.type !== "item") return;
            widestLabel = Math.max(widestLabel, doc.getTextWidth(r.label));
            if (showCounts && r.count != null) anyCount = true;
          });
          doc.setFont("helvetica", "bold");
          doc.setFontSize(headFont);
          let widestHead = 0;
          rows.forEach((r) => {
            if (r.type === "head") widestHead = Math.max(widestHead, doc.getTextWidth(r.label));
          });
          const itemW = swatch + 5 + widestLabel + (anyCount ? 8 + COUNT_COL_PT : 0);
          colContentW[c] = rows.length ? Math.max(itemW, widestHead) : 0;
        }

        // Pack the columns; if the measured widths don't fit (many long
        // feature names), fall back to an even split so nothing overflows.
        const usedCols = colContentW.filter((v) => v > 0).length;
        const totalMeasured = colContentW.reduce((a, b) => a + b, 0)
          + LEGEND_COL_GAP_PT * Math.max(0, usedCols - 1);
        const fits = totalMeasured <= w - 16;
        const colX = [];
        if (fits) {
          let cx0 = x + 8;
          for (let c = 0; c < columns; c++) {
            colX[c] = cx0;
            if (colContentW[c] > 0) cx0 += colContentW[c] + LEGEND_COL_GAP_PT;
          }
        } else {
          const even = (w - 16) / columns;
          for (let c = 0; c < columns; c++) {
            colX[c] = x + 8 + c * even;
            colContentW[c] = even - LEGEND_COL_GAP_PT;
          }
        }

        // Counts sit at the right edge of their own column's content, so
        // they stay close to the labels instead of at the box edge.
        const countX = [];
        for (let c = 0; c < columns; c++) {
          countX[c] = colX[c] + colContentW[c] - COUNT_COL_PT;
        }

        // ── Vertical separators between the columns ───────────────────
        doc.setDrawColor(200);
        doc.setLineWidth(0.5);
        for (let c = 1; c < columns; c++) {
          if (!cols[c].length) continue;
          const sx = colX[c] - LEGEND_COL_GAP_PT / 2;
          doc.line(sx, rowsTop - 8, sx, y + h - 6);
        }

        cols.forEach((rows, col) => {
          const cx = colX[col];
          rows.forEach((row, idx) => {
            const cy = rowsTop + idx * rowH;
            if (cy > y + h - 3) return;
            if (row.type === "gap") return; // blank separator row
            if (row.type === "head") {
              doc.setFont("helvetica", "bold");
              doc.setFontSize(headFont);
              doc.setTextColor(120, 120, 120);
              doc.text(row.label, cx, cy, { maxWidth: colContentW[col] });
              return;
            }
            drawLegendSwatch(row.sym, cx, cy, swatch);
            doc.setFont("helvetica", "normal");
            doc.setFontSize(itemFont);
            doc.setTextColor(60, 60, 60);

            // symbol | label | count, packed left. Counts within a column
            // share an x (see countX above) so the numbers still line up,
            // and are right-aligned within their own narrow slot so the
            // digits do too.
            const showCount = showCounts && row.count != null;
            const lx = cx + swatch + 5;
            doc.text(row.label, lx, cy, { maxWidth: countX[col] - lx - 4 });
            if (showCount) {
              doc.setTextColor(30, 42, 30);
              doc.text(String(row.count), countX[col] + COUNT_COL_PT, cy, { align: "right" });
            }
          });
        });
      };

      /** Square QR cell + caption, linking to the centre of the printed
       *  area on Google Maps. */
      // No caption under the QR any more — it now shares a row with the
      // north arrow at the very bottom of the column, so there's nothing
      // below it to caption into, and "Scan for location" wouldn't fit a
      // half-column square anyway.
      const drawQrCell = (x, y, size) => {
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(120);
        doc.setLineWidth(1);
        doc.rect(x, y, size, size, "FD");
        const pad = Math.max(2, size * 0.07);
        doc.addImage(qrDataUrl, "PNG", x + pad, y + pad, size - pad * 2, size - pad * 2);
      };

      /** Reserved "Comments" box — the counts it used to hold moved into
       *  the legend itself (a count column per row), which puts each
       *  number next to the symbol it belongs to. The box is kept as
       *  deliberate blank space for a written note. */
      const drawCommentsCell = (x, y, w, h) => {
        doc.setFillColor(255, 255, 255);
        doc.setDrawColor(120);
        doc.setLineWidth(1);
        doc.rect(x, y, w, h, "FD");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8);
        doc.setTextColor(30, 42, 30);
        doc.text("COMMENTS", x + 8, y + 13);
      };

      if (L.landscape) {
        // Extras stack down the right-hand column: arrow on top, then the
        // legend filling what's left, with summary and QR pinned bottom.
        // Legend runs from the very top of the column down to whatever
        // sits below it; summary next, then the QR + north arrow row.
        const stackTop = showSummary
          ? L.summaryY
          : (L.bottomRowH ? L.bottomRowY : mapTop + mapAreaH);
        const legendBottom = stackTop - (showSummary || L.bottomRowH ? SIDE_CELL_GAP_PT : 0);
        if (showLegend && legendBottom - mapTop > 30) {
          drawLegendCell(L.sideX, mapTop, L.sideColW, legendBottom - mapTop, 1);
        }
        if (showSummary) drawCommentsCell(L.sideX, L.summaryY, L.sideColW, L.summaryH);
        if (showQr) drawQrCell(L.qrX, L.qrY, L.qrSize);
        if (showNorthArrow) drawNorthArrowCell(L.arrowX, L.arrowY, L.arrowW, L.bottomRowH);
      } else {
        // Extras sit in a bar under the map: legend, comments, QR, then
        // the arrow at the right end. The legend spans the bar's full
        // height with its rows flowing across several columns; the QR and
        // arrow are fixed squares centred vertically in it.
        if (showLegend) {
          drawLegendCell(margin, L.barY, L.barLegendW, L.barH, PORTRAIT_LEGEND_COLUMNS);
        }
        if (showSummary) drawCommentsCell(L.summaryX, L.barY, L.summaryW, L.barH);
        if (showQr) drawQrCell(L.qrX, L.qrY, L.qrSize);
        if (showNorthArrow) {
          drawNorthArrowCell(L.arrowX, L.arrowY, L.barArrowW, L.stackSquare);
        }
      }

      // Approx. scale, bottom-right under the map frame.
      if (settings.details.scale) {
        const scaleDenom = computeScaleDenominator();
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(100, 100, 100);
        doc.text(
          `Scale approx. 1:${scaleDenom.toLocaleString()}`,
          margin + mapAreaW,
          pageH - margin + 2,
          { align: "right" }
        );
      }

      // Date / source / printed-by, stamped bottom-left of the page (each
      // independently toggled in the Map details tab).
      const stampParts = [];
      if (settings.details.date) stampParts.push(new Date().toLocaleDateString());
      if (settings.details.source) stampParts.push(window.location.hostname || "Victoria Sugar Webmap");
      if (settings.details.printedBy) {
        const who = currentUserName();
        if (who) stampParts.push(`Printed by: ${who}`);
      }
      if (stampParts.length) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(8);
        doc.setTextColor(130, 130, 130);
        doc.text(stampParts.join("  •  "), margin, pageH - margin + 2, { align: "left" });
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
    // Deliberately NOT readSettings() here — that reads the form back into
    // the settings object, which would clobber the defaults with whatever
    // the (possibly never-opened) settings window happens to hold. The
    // window pushes state the other way, via writeSettingsToForm on open.
    // Straight into area-selection — that's the first thing you'd do
    // anyway, so there's no reason to make the crosshair button a second
    // click. The toast says what to do next.
    armSelection();
    setPrintStatus("Select area to print", false);
  }

  function exitPrintMode() {
    printModeActive = false;
    disarmSelection();
    viewportWrap.classList.remove("vsl-print-mode");
    addTitleBtn.hidden = true;
    titleCard.hidden = true;
    toolbar.hidden = true;
    // Via closeSetupPopup (not a bare hidden=true) so the document-level
    // outside-click listener is always torn down with it.
    closeSetupPopup();
    closeLockPop();
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
