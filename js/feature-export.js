/**
 * feature-export.js
 *
 * Feature Info panel's Download button — CSV or PDF export of whatever
 * estate/block/parcel is currently open in the panel (see
 * setFeatureExportContext()/clearFeatureExportContext(), called from
 * map-app.js's renderFeatureInfoView/closeInfoPopup as the panel's data
 * loads/closes).
 *
 * PDF additionally embeds, ahead of the same detail tables CSV exports:
 *   - a snapshot of the map framed on the feature (captureMapSnapshot(),
 *     using OpenLayers' documented canvas-compositing technique)
 *   - a QR code linking to the feature's location on Google Maps
 *
 * Libraries used are all already loaded globally by webmap.html — nothing
 * here needs bundling/importing them itself:
 *   - PapaParse (window.Papa)               → CSV
 *   - jsPDF (window.jspdf.jsPDF)             → PDF document
 *   - jspdf-autotable (doc.autoTable(...))   → PDF detail tables
 */

let mapRef = null;
let currentContext = null;

/** Wires the panel's Download button + format <select> once. Call after the
 *  map and the feature-info-panel DOM (fetched at runtime — see
 *  js/app-boot.js) both exist. */
export function initFeatureExport({ map }) {
  mapRef = map;

  const btn = document.getElementById("featureExportBtn");
  const formatSelect = document.getElementById("featureExportFormat");
  const errorEl = document.getElementById("featureExportError");
  if (!btn) return;

  const originalLabel = btn.innerHTML;

  btn.addEventListener("click", async () => {
    if (!currentContext) return;
    const format = formatSelect?.value === "pdf" ? "pdf" : "csv";

    if (errorEl) { errorEl.hidden = true; errorEl.textContent = ""; }
    btn.disabled = true;
    btn.innerHTML = `<i class="fas fa-spinner fa-spin" aria-hidden="true"></i> Preparing…`;

    try {
      if (format === "pdf") await exportAsPdf(currentContext);
      else exportAsCsv(currentContext);
    } catch (err) {
      console.error("[VSL Export] failed:", err);
      if (errorEl) { errorEl.textContent = `Export failed: ${err?.message || "unknown error"}`; errorEl.hidden = false; }
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalLabel;
    }
  });
}

/** Called once a feature/estate/block/plot's details have loaded
 *  (map-app.js's renderFeatureInfoView/openFeatureInfoPanel) — un-hides the
 *  panel's action footer and gives its Download button something to
 *  export. (The footer's Log button is wired separately in map-app.js —
 *  this module only owns Download.)
 *
 *  ctx = {
 *    kind: "parcel" | "block" | "estate",
 *    title: string,                 // e.g. the plot/block/estate name, used as the PDF heading
 *    estateName: string | null,     // used to build the export filename (see buildExportFileName)
 *    blockName: string | null,      // omitted for kind "estate"
 *    parcelName: string | null,     // only present for kind "parcel"
 *    printedBy: string | null,      // current user's full name, for the PDF's Document Details section
 *    sections: [                    // same shape either way:
 *      { title, type: "kv",    rows: [[label, value], ...] } |
 *      { title, type: "table", headers: [...], rows: [[...], ...] }
 *    ],
 *    extent3857: [minx,miny,maxx,maxy] | null,  // PDF map snapshot framing
 *    lonLat: [lon, lat] | null                  // PDF QR code target
 *  }
 *
 *  extent3857/lonLat are optional — CSV never needs them, and PDF just
 *  skips the snapshot/QR if they're missing rather than failing (e.g. the
 *  feature currently isn't loaded in the map's viewport). */
export function setFeatureExportContext(ctx) {
  currentContext = ctx;
  const wrap = document.getElementById("featureExportSplitBtn");
  if (wrap) wrap.hidden = !ctx;
}

export function clearFeatureExportContext() {
  currentContext = null;
  const wrap = document.getElementById("featureExportSplitBtn");
  if (wrap) wrap.hidden = true;
}

// ---------------------------------------------------------------------------
// Shared file-naming — "Details {estate} {block} {plot} {timestamp}",
// trimmed to whichever of estate/block/plot actually apply for this kind.
// Timestamp is generated at export time (not when the panel opened), as
// zero-padded MM/HH/DD/MO + 4-digit year concatenated with no separators,
// in the literal Minute-Hour-Day-Month-Year order the naming spec calls
// for (e.g. 2:05pm on 30 August 2026 -> "05" + "14" + "30" + "08" + "2026").
// ---------------------------------------------------------------------------

function formatExportTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  // Minute, Hour, Day, Month, Year — in that literal order, per spec.
  return `${pad(d.getMinutes())}${pad(d.getHours())}${pad(d.getDate())}${pad(d.getMonth() + 1)}${d.getFullYear()}`;
}

// Strips characters that are invalid (or awkward) in a downloaded filename
// on Windows/macOS — everything else (spaces included) is left as-is so
// names stay human-readable.
function sanitizeFileNamePart(s) {
  return String(s ?? "").replace(/[\\/:*?"<>|]/g, "").trim();
}

function buildExportFileName(ctx) {
  const parts = ["Details"];
  if (ctx.estateName) parts.push(ctx.estateName);
  if (ctx.kind !== "estate" && ctx.blockName) parts.push(ctx.blockName);
  if (ctx.kind === "parcel" && ctx.parcelName) parts.push(ctx.parcelName);
  parts.push(formatExportTimestamp());
  return parts.map(sanitizeFileNamePart).filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function exportAsCsv(ctx) {
  const rows = [];
  rows.push([ctx.title || "Details"]);
  rows.push([]);

  for (const section of ctx.sections || []) {
    rows.push([section.title]);
    if (section.type === "table" && section.headers) rows.push(section.headers);
    for (const r of section.rows || []) rows.push(r);
    rows.push([]); // blank separator row between sections
  }

  const csv = window.Papa ? window.Papa.unparse(rows) : rows.map((r) => r.map(csvEscapeCell).join(",")).join("\r\n");
  downloadBlob(csv, `${buildExportFileName(ctx)}.csv`, "text/csv;charset=utf-8;");
}

// Only used if PapaParse somehow isn't loaded — Papa.unparse already
// handles quoting correctly; this is just a safety net.
function csvEscapeCell(val) {
  const s = String(val ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async function exportAsPdf(ctx) {
  const jsPDFCtor = window.jspdf?.jsPDF;
  if (!jsPDFCtor) throw new Error("PDF library didn't load — check your connection and try again.");

  const doc = new jsPDFCtor({ unit: "pt", format: "a4" });
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  let y = margin;

  doc.setFontSize(16);
  doc.setFont(undefined, "bold");
  doc.text(String(ctx.title || "Feature details"), margin, y);
  y += 22;

  // "Document Details" — date/time, who printed it, and where it came
  // from, ahead of everything else in the PDF.
  doc.setFontSize(10);
  doc.setFont(undefined, "bold");
  doc.text("Document Details", margin, y);
  y += 14;
  doc.setFontSize(9);
  doc.setFont(undefined, "normal");
  doc.setTextColor(90, 90, 90);
  doc.text(`Date and time: ${new Date().toLocaleString()}`, margin, y);
  y += 13;
  doc.text(`Printed By: ${ctx.printedBy || "Unknown"}`, margin, y);
  y += 13;
  doc.text("Source: farms.victoriasugarltd.xyz", margin, y);
  doc.setTextColor(0, 0, 0);
  y += 20;

  // Map snapshot + QR code, side by side, whenever we have a location to
  // work with — failures here are non-fatal, the PDF still finishes with
  // just the detail tables.
  if (mapRef && ctx.extent3857) {
    try {
      const snap = await captureMapSnapshot(mapRef, ctx.extent3857);
      const snapW = 260;
      const snapH = snapW * (snap.height / snap.width);
      doc.addImage(snap.dataUrl, "PNG", margin, y, snapW, snapH);

      if (ctx.lonLat) {
        try {
          const qrDataUrl = await fetchQrCodeDataUrl(googleMapsLink(ctx.lonLat));
          const qrSize = Math.min(snapH, 130);
          const qrX = margin + snapW + 20;
          doc.addImage(qrDataUrl, "PNG", qrX, y, qrSize, qrSize);
          doc.setFontSize(8);
          doc.setTextColor(110, 110, 110);
          doc.text("Scan for location", qrX, y + qrSize + 11);
          doc.setTextColor(0, 0, 0);
        } catch (qrErr) {
          console.warn("[VSL Export] QR code unavailable, continuing without it:", qrErr);
        }
      }
      y += snapH + 22;
    } catch (snapErr) {
      console.warn("[VSL Export] map snapshot unavailable, continuing without it:", snapErr);
    }
  }

  for (const section of ctx.sections || []) {
    if (y > pageHeight - 90) { doc.addPage(); y = margin; }

    doc.setFontSize(11);
    doc.setFont(undefined, "bold");
    doc.text(section.title, margin, y);
    y += 14;
    doc.setFont(undefined, "normal");

    if (!section.rows || !section.rows.length) {
      doc.setFontSize(9);
      doc.setTextColor(140, 140, 140);
      doc.text("No records.", margin, y);
      doc.setTextColor(0, 0, 0);
      y += 20;
      continue;
    }

    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      head: section.type === "table" ? [section.headers] : [["Field", "Value"]],
      body: section.rows,
      styles: { fontSize: 9, cellPadding: 4, overflow: "linebreak" },
      headStyles: { fillColor: [40, 95, 40] },
      theme: "grid"
    });
    y = doc.lastAutoTable.finalY + 18;
  }

  doc.save(`${buildExportFileName(ctx)}.pdf`);
}

function googleMapsLink([lon, lat]) {
  return `https://www.google.com/maps?q=${lat},${lon}`;
}

/** Public QR-image API (no key/auth needed, sends CORS headers) — simplest
 *  reliable way to get a QR code image without bundling an encoder
 *  library. Fetched as a blob and converted to a data URL (rather than
 *  just used as an <img src>) since that's what jsPDF's addImage() needs. */
async function fetchQrCodeDataUrl(data) {
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(data)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("QR code service unavailable");
  const blob = await res.blob();
  return blobToDataUrl(blob);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Failed to read QR code image"));
    reader.readAsDataURL(blob);
  });
}

/** OpenLayers' own documented "export map as image" technique — composites
 *  every layer's own <canvas> onto one, respecting each layer's
 *  opacity/CSS transform (see
 *  https://openlayers.org/en/latest/examples/export-map.html). Framed on
 *  `extent` (the feature's own extent, in the map's projection) rather
 *  than whatever the user happened to be looking at, then restores the
 *  original view afterward so exporting doesn't leave the live map
 *  somewhere else. Resolves { dataUrl, width, height } — width/height are
 *  the snapshot's actual pixel size, so callers can scale it into a PDF
 *  without distorting the aspect ratio. */
function captureMapSnapshot(map, extent) {
  return new Promise((resolve, reject) => {
    const view = map.getView();
    const prevCenter = view.getCenter();
    const prevResolution = view.getResolution();

    let settled = false;
    const finish = (result, err) => {
      if (settled) return;
      settled = true;
      // Restore the view the user actually had before we fitted to the
      // feature for the snapshot.
      if (prevCenter) view.setCenter(prevCenter);
      if (prevResolution != null) view.setResolution(prevResolution);
      if (err) reject(err); else resolve(result);
    };

    try {
      view.fit(extent, { padding: [24, 24, 24, 24], maxZoom: 19, duration: 0 });
    } catch (err) {
      finish(null, err);
      return;
    }

    map.once("rendercomplete", () => {
      try {
        const size = map.getSize();
        if (!size || !size[0] || !size[1]) throw new Error("Map has no size to snapshot.");

        const mapCanvas = document.createElement("canvas");
        mapCanvas.width = size[0];
        mapCanvas.height = size[1];
        const mapContext = mapCanvas.getContext("2d");

        Array.prototype.forEach.call(
          map.getViewport().querySelectorAll(".ol-layer canvas, canvas.ol-layer"),
          (canvas) => {
            if (!canvas.width) return;
            const opacity = canvas.parentNode.style.opacity || canvas.style.opacity;
            mapContext.globalAlpha = opacity === "" ? 1 : Number(opacity);
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
            CanvasRenderingContext2D.prototype.setTransform.apply(mapContext, matrix);
            mapContext.drawImage(canvas, 0, 0);
          }
        );
        mapContext.globalAlpha = 1;
        mapContext.setTransform(1, 0, 0, 1, 0, 0);

        finish({ dataUrl: mapCanvas.toDataURL("image/png"), width: mapCanvas.width, height: mapCanvas.height });
      } catch (err) {
        finish(null, err);
      }
    });
    map.renderSync();
  });
}
