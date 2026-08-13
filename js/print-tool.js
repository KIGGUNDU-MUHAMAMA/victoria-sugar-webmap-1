// js/print-tool.js
//
// Print/PDF Plot — was a placeholder tab inside the Survey window, moved
// out to its own top-level map tool (#printTopBtn in #mapLeftBtnStack,
// windows/print-panel.html docked in #mapLeftStack). Workflow:
//   1. Pan/zoom the live map to frame whatever should be plotted — there's
//      no separate "select a window" UI, the current view *is* the frame.
//   2. Toggle/drag/resize an on-screen legend and toggle a north arrow.
//   3. Generate PDF captures exactly what's on screen right now (same
//      "composite every .ol-layer canvas onto one canvas" technique
//      js/feature-export.js already uses for single-feature PDFs — see
//      captureMapSnapshot() there) and lays it into an A4 jsPDF page with
//      a title, an approximate map scale, the legend redrawn as crisp PDF
//      vectors (not a screenshot), a north arrow, and a source line.
//
// Scope calls made here (built while the user was asleep, per their
// explicit "don't ask me anything" instruction):
//   - "legend... movable by moving and resizing it" -> a plain draggable/
//     resizable HTML overlay docked over the live map. Its on-screen
//     position/size (as a % of the map viewport) is re-projected onto the
//     PDF page at export time and redrawn as real vector text/swatches,
//     so it stays sharp instead of being baked into the map screenshot.
//   - "compute the scale of these labels based on the current zoom level
//     to determine the size of the labels" -> the map's own on-screen
//     labels (plot names/areas) are already rendered by OL at whatever
//     size the current zoom level implies, and the PDF captures that
//     exact canvas, so they come through at their true on-screen size
//     automatically — nothing extra needed for that part. What this file
//     *adds* is a computed "Scale approx. 1:N" line on the page itself
//     (the standard OL resolution -> scale-denominator conversion), so
//     whoever prints it knows the scale. Redoing true cartographic
//     re-scaling of the whole page felt out of scope for a first pass.
//   - "the current layers (osm, google, or no maps) are what determine
//     the background" -> free — whatever base layer is visible on screen
//     is simply whatever the canvas capture picks up.
//   - The north arrow is a fixed corner marker (not draggable/resizable);
//     only the legend was asked to be movable.

export function initPrintTool({ map, setStatus, statusEl, closeOtherPanels }) {
  const topBtn = document.getElementById("printTopBtn");
  const panel = document.getElementById("printPanel");
  if (!topBtn || !panel || !map) return null;

  const closeBtn = document.getElementById("printPanelCloseBtn");
  const titleInput = document.getElementById("printTitleInput");
  const orientationSelect = document.getElementById("printOrientationSelect");
  const legendCb = document.getElementById("printLegendCb");
  const northArrowCb = document.getElementById("printNorthArrowCb");
  const statusLine = document.getElementById("printStatus");
  const generateBtn = document.getElementById("printGenerateBtn");
  const viewportWrap = document.querySelector(".map-viewport-wrap");

  let legendEl = null;
  let northArrowEl = null;

  function setPrintStatus(msg, isError) {
    if (statusLine) {
      statusLine.hidden = !msg;
      statusLine.textContent = msg || "";
      // Base .uam-hint is already tomato/error-colored by default (see
      // styles.css) — .uam-hint--blue is the override for non-error text,
      // same convention as every other tab's feedback line.
      statusLine.classList.toggle("uam-hint--blue", !isError);
    }
    setStatus?.(statusEl, msg, isError);
  }

  // ---- Draggable/resizable legend + fixed north arrow overlays ----------

  function wireDrag(el, handle) {
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
    };
    const onUp = () => {
      dragging = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
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

  function wireResize(el, handle) {
    let startX = 0, startY = 0, startW = 0, startH = 0, resizing = false;
    const onMove = (e) => {
      if (!resizing) return;
      el.style.width = `${Math.max(120, startW + (e.clientX - startX))}px`;
      el.style.height = `${Math.max(60, startH + (e.clientY - startY))}px`;
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

  function buildLegendOverlay() {
    if (legendEl || !viewportWrap) return;
    // Reuses the exact same cultivation-status data/colors as the real
    // Legend panel (see window.vslBuildLegendList hook in map-app.js) so
    // this can never drift from what's actually drawn on the map.
    window.vslBuildLegendList?.();
    const source = document.getElementById("legendStatusList");
    const el = document.createElement("div");
    el.className = "print-legend";
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
    wireResize(el, el.querySelector(".print-legend__resize"));
  }

  function removeLegendOverlay() {
    legendEl?.remove();
    legendEl = null;
  }

  function buildNorthArrow() {
    if (northArrowEl || !viewportWrap) return;
    const el = document.createElement("div");
    el.className = "print-north-arrow";
    el.innerHTML = '<i class="fas fa-location-arrow" aria-hidden="true"></i><span>N</span>';
    viewportWrap.appendChild(el);
    northArrowEl = el;
  }

  function removeNorthArrow() {
    northArrowEl?.remove();
    northArrowEl = null;
  }

  function syncOverlays() {
    if (legendCb?.checked) buildLegendOverlay(); else removeLegendOverlay();
    if (northArrowCb?.checked) buildNorthArrow(); else removeNorthArrow();
  }

  // ---- Panel open/close ---------------------------------------------------

  function openPanel() {
    closeOtherPanels?.();
    panel.hidden = false;
    topBtn.classList.add("active");
    topBtn.setAttribute("aria-expanded", "true");
    syncOverlays();
  }

  function closePanel() {
    panel.hidden = true;
    topBtn.classList.remove("active");
    topBtn.setAttribute("aria-expanded", "false");
    removeLegendOverlay();
    removeNorthArrow();
    setPrintStatus("", false);
  }

  topBtn.addEventListener("click", () => {
    if (panel.hidden) openPanel(); else closePanel();
  });
  closeBtn?.addEventListener("click", () => closePanel());
  legendCb?.addEventListener("change", syncOverlays);
  northArrowCb?.addEventListener("change", syncOverlays);

  // ---- Map capture (same technique as feature-export.js's
  // captureMapSnapshot, minus the view.fit() — this captures whatever the
  // user is currently panned/zoomed to, unchanged) ------------------------

  function captureCurrentMapView() {
    return new Promise((resolve, reject) => {
      map.once("rendercomplete", () => {
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
          resolve({ dataUrl: mapCanvas.toDataURL("image/png"), width: mapCanvas.width, height: mapCanvas.height });
        } catch (err) {
          reject(err);
        }
      });
      map.renderSync();
    });
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

  async function generatePdf() {
    const jsPDFCtor = window.jspdf?.jsPDF;
    if (!jsPDFCtor) {
      setPrintStatus("PDF library didn't load — check your connection and try again.", true);
      return;
    }
    if (generateBtn) generateBtn.disabled = true;
    setPrintStatus("Capturing the map…", false);
    try {
      const snap = await captureCurrentMapView();
      const orientation = orientationSelect?.value === "portrait" ? "portrait" : "landscape";
      const doc = new jsPDFCtor({ unit: "pt", format: "a4", orientation });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();

      const margin = 24;
      const titleH = 26;
      const sourceH = 16;
      const mapTop = margin + titleH;
      const mapAreaW = pageW - margin * 2;
      const mapAreaH = pageH - margin - sourceH - mapTop;

      // Letterbox the captured snapshot into the map frame without
      // distorting its aspect ratio.
      const snapRatio = snap.width / snap.height;
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
      doc.addImage(snap.dataUrl, "PNG", drawX, drawY, drawW, drawH);
      doc.setDrawColor(190);
      doc.rect(margin, mapTop, mapAreaW, mapAreaH, "S");

      // Title (generic/simple, as asked) + approx. scale.
      const title = (titleInput?.value || "").trim() || "Farm Map";
      doc.setFont("helvetica", "bold");
      doc.setFontSize(16);
      doc.setTextColor(30, 42, 30);
      doc.text(title, pageW / 2, margin + 15, { align: "center" });

      const scaleDenom = computeScaleDenominator();
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(100, 100, 100);
      doc.text(`Scale approx. 1:${scaleDenom.toLocaleString()}`, pageW - margin, margin + 15, { align: "right" });

      // North arrow — fixed top-right corner of the map frame.
      if (northArrowCb?.checked) {
        const naX = drawX + drawW - 24;
        const naY = drawY + 34;
        doc.setFillColor(30, 42, 30);
        doc.triangle(naX, naY - 14, naX - 7, naY + 6, naX + 7, naY + 6, "F");
        doc.setFont("helvetica", "bold");
        doc.setFontSize(9);
        doc.setTextColor(30, 42, 30);
        doc.text("N", naX, naY + 17, { align: "center" });
      }

      // Legend — redrawn as real vector text/swatches at the same relative
      // position/size the on-screen draggable overlay currently has.
      if (legendCb?.checked && legendEl && viewportWrap) {
        const items = [...legendEl.querySelectorAll(".print-legend__list .legend-panel__item")]
          .map((li) => ({
            color: li.querySelector(".legend-panel__swatch")?.style.background,
            label: li.querySelector("span:last-child")?.textContent || ""
          }))
          .filter((i) => i.label);

        if (items.length) {
          const wrapRect = viewportWrap.getBoundingClientRect();
          const legendRect = legendEl.getBoundingClientRect();
          const relX = (legendRect.left - wrapRect.left) / wrapRect.width;
          const relY = (legendRect.top - wrapRect.top) / wrapRect.height;
          const relW = legendRect.width / wrapRect.width;

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

      // Source line, bottom of the page.
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(130, 130, 130);
      doc.text(
        `Source: ${window.location.hostname || "Victoria Sugar Webmap"}  •  Generated ${new Date().toLocaleString()}`,
        pageW / 2,
        pageH - margin + 2,
        { align: "center" }
      );

      doc.save(`${(title.replace(/[^\w\-]+/g, "_") || "map")}.pdf`);
      setPrintStatus("PDF downloaded.", false);
    } catch (err) {
      console.error("[Victoria Print] Generate PDF failed:", err);
      setPrintStatus(`Couldn't generate PDF: ${err.message}`, true);
    } finally {
      if (generateBtn) generateBtn.disabled = false;
    }
  }

  generateBtn?.addEventListener("click", generatePdf);

  // So map-app.js's shared closeSearchPanel/closeUAM/closeParcelStatusPanel
  // functions (called from many places — Measure button, Survey button,
  // Search button, etc.) can also close this panel for mutual exclusivity,
  // the same loosely-coupled window.* hook pattern used throughout this
  // app (window.closeMenu, window.closeSearchPanel, ...).
  window.vslClosePrintPanel = closePanel;

  return { openPanel, closePanel };
}
