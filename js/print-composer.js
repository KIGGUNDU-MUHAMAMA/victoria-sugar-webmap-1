/**
 * Map PDF export: framed preview map, optional grid, branded PDF with QR.
 */

import { CRS_OPTIONS, registerProj4Defs, PROJ4_DEFS } from "./crs-definitions.js";

const PRINT_QR_URL = "https://farms.victoriasugarltd.xyz/webmap";

let deps = null;
let previewMap = null;
let gridLayer = null;
let gridSource = null;
let gridCornerLayer = null;
let gridCornerSource = null;
let proj4lib = null;
let pdfPreviewBlobUrl = null;

function $(id) {
  return document.getElementById(id);
}

async function ensureProj4() {
  if (proj4lib) return proj4lib;
  const mod = await import("https://esm.sh/proj4@2.11.0");
  proj4lib = mod.default;
  registerProj4Defs(proj4lib);
  return proj4lib;
}

function getActiveBasemapTileLayer(baseGroup) {
  if (!baseGroup) return null;
  const layers = baseGroup.getLayers().getArray();
  return layers.find((l) => l.getVisible() && l.get("type") === "base") || null;
}

function cloneBasemapLayer(tileLayer) {
  if (!tileLayer) return null;
  const src = tileLayer.getSource();
  if (!src) return null;
  return new ol.layer.Tile({
    source: src,
    opacity: tileLayer.getOpacity(),
    zIndex: 0
  });
}

function cloneVectorLayerWithStyle(vectorLayer, source, zIndex) {
  const st = vectorLayer.getStyle();
  return new ol.layer.Vector({
    source,
    style: typeof st === "function" ? st : st,
    zIndex: zIndex ?? vectorLayer.getZIndex?.() ?? 100
  });
}

function disposePreviewMap() {
  disposePdfPreview();
  setPdfPreviewNote("");
  const wrap = $("printPdfPreviewWrap");
  if (wrap) wrap.hidden = true;
  if (previewMap) {
    previewMap.setTarget(null);
    previewMap = null;
  }
  gridLayer = null;
  gridSource = null;
  gridCornerLayer = null;
  gridCornerSource = null;
}

function buildGraticuleLayer() {
  if (typeof ol === "undefined" || !ol.layer?.Graticule) return null;
  return new ol.layer.Graticule({
    maxLines: 14,
    targetSize: 220,
    strokeStyle: new ol.style.Stroke({
      color: "rgba(20, 60, 40, 0.55)",
      width: 1,
      lineDash: [6, 8]
    }),
    showLabels: true,
    lonLabelStyle: new ol.style.Text({
      font: "600 10px Inter, system-ui, sans-serif",
      fill: new ol.style.Fill({ color: "#1b3d1b" }),
      stroke: new ol.style.Stroke({ color: "rgba(255,255,255,0.9)", width: 2.5 }),
      textBaseline: "bottom"
    }),
    latLabelStyle: new ol.style.Text({
      font: "600 10px Inter, system-ui, sans-serif",
      fill: new ol.style.Fill({ color: "#1b3d1b" }),
      stroke: new ol.style.Stroke({ color: "rgba(255,255,255,0.9)", width: 2.5 }),
      textAlign: "end"
    }),
    lonLabelFormatter: (lon) => `${lon.toFixed(2)}°`,
    latLabelFormatter: (lat) => `${lat.toFixed(2)}°`,
    zIndex: 480
  });
}

function disposePdfPreview() {
  if (pdfPreviewBlobUrl) {
    URL.revokeObjectURL(pdfPreviewBlobUrl);
    pdfPreviewBlobUrl = null;
  }
  const frame = $("printPdfPreviewFrame");
  if (frame) frame.removeAttribute("src");
}

function setPdfPreviewNote(text) {
  const el = $("printPdfPreviewNote");
  if (!el) return;
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.textContent = text;
  el.hidden = false;
}

function invalidatePdfPreviewIfShown(reason) {
  const wrap = $("printPdfPreviewWrap");
  const hadSrc = Boolean($("printPdfPreviewFrame")?.getAttribute("src"));
  disposePdfPreview();
  if (hadSrc && wrap && !wrap.hidden) {
    setPdfPreviewNote(reason || "Export changed — use Preview PDF again before printing.");
  } else {
    setPdfPreviewNote("");
  }
}

/**
 * OpenLayers can stack several canvases (tiles, vectors, graticule). Composite them in DOM order.
 */
function compositeMapViewportToDataUrl(map, mimeType = "image/jpeg", quality = 0.9) {
  const viewport = map.getViewport();
  const size = map.getSize();
  if (!viewport || !size || size[0] < 2 || size[1] < 2) return null;

  const canvases = Array.from(viewport.querySelectorAll("canvas")).filter((c) => c.width > 0 && c.height > 0);
  if (!canvases.length) return null;

  const out = document.createElement("canvas");
  out.width = Math.round(size[0]);
  out.height = Math.round(size[1]);
  const ctx = out.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#dde8d9";
  ctx.fillRect(0, 0, out.width, out.height);

  const vpRect = viewport.getBoundingClientRect();
  for (const c of canvases) {
    const r = c.getBoundingClientRect();
    const x = Math.round(r.left - vpRect.left);
    const y = Math.round(r.top - vpRect.top);
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    if (w < 1 || h < 1) continue;
    try {
      ctx.drawImage(c, 0, 0, c.width, c.height, x, y, w, h);
    } catch {
      /* tainted sub-canvas — skip */
    }
  }

  try {
    return out.toDataURL(mimeType, quality);
  } catch {
    return null;
  }
}

/**
 * Wait for render cycles. Always schedules a fresh render first — otherwise after the first export
 * OpenLayers may not emit rendercomplete again and the PDF step would hang indefinitely.
 */
async function waitForMapRenderStable(map, cycles = 3) {
  const waitOnce = (timeoutMs = 4000) =>
    new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(tid);
        map.un("rendercomplete", onRc);
        resolve();
      };
      const onRc = () => {
        clearTimeout(tid);
        done();
      };
      const tid = setTimeout(done, timeoutMs);
      map.once("rendercomplete", onRc);
      try {
        map.getView().changed();
        map.getLayers().forEach((ly) => {
          ly.changed();
        });
        map.render();
      } catch {
        done();
      }
    });

  for (let i = 0; i < cycles; i += 1) {
    await waitOnce();
  }
  map.renderSync();
  await new Promise(requestAnimationFrame);
  await new Promise((r) => setTimeout(r, 120));
}

function formatProjectedGridValue(v) {
  const a = Math.abs(Number(v) || 0);
  if (a >= 100000) return `${Math.round(v)}`;
  if (a >= 10000) return `${Math.round(v)}`;
  if (a >= 1000) return `${Number(v).toFixed(1)}`;
  return `${Number(v).toFixed(2)}`;
}

/**
 * Simple projected grid in map CRS (Web Mercator edges labeled in selected CRS at corners).
 * Adds point labels at line midpoints so easting/northing values appear in exports.
 */
async function updateProjectedGrid(pMap, crs, spacingM) {
  if (!gridSource || !pMap || crs === "EPSG:4326") return;
  if (!PROJ4_DEFS[crs]) return;
  const p4 = await ensureProj4();
  gridSource.clear(true);
  const view = pMap.getView();
  const size = pMap.getSize();
  if (!size) return;
  const extent = view.calculateExtent(size);
  const corners = [
    [extent[0], extent[1]],
    [extent[2], extent[1]],
    [extent[2], extent[3]],
    [extent[0], extent[3]]
  ];
  const utmCorners = corners.map((xy) => {
    const ll = ol.proj.transform(xy, "EPSG:3857", "EPSG:4326");
    return p4("EPSG:4326", crs, ll);
  });
  let minE = Infinity;
  let maxE = -Infinity;
  let minN = Infinity;
  let maxN = -Infinity;
  for (const [e, n] of utmCorners) {
    minE = Math.min(minE, e);
    maxE = Math.max(maxE, e);
    minN = Math.min(minN, n);
    maxN = Math.max(maxN, n);
  }
  const s = Math.max(50, Number(spacingM) || 500);
  const e0 = Math.floor(minE / s) * s;
  const e1 = Math.ceil(maxE / s) * s;
  const n0 = Math.floor(minN / s) * s;
  const n1 = Math.ceil(maxN / s) * s;
  const midE = (e0 + e1) / 2;
  const midN = (n0 + n1) / 2;
  const features = [];
  const maxLines = 40;
  let nLines = 0;
  for (let e = e0; e <= e1 && nLines < maxLines; e += s) {
    nLines += 1;
    const ll0 = p4(crs, "EPSG:4326", [e, n0]);
    const ll1 = p4(crs, "EPSG:4326", [e, n1]);
    const g = new ol.geom.LineString([ol.proj.fromLonLat(ll0), ol.proj.fromLonLat(ll1)]);
    features.push(new ol.Feature({ geometry: g }));
    const llMid = p4(crs, "EPSG:4326", [e, midN]);
    features.push(
      new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat(llMid)),
        label: formatProjectedGridValue(e),
        kind: "easting"
      })
    );
  }
  nLines = 0;
  for (let n = n0; n <= n1 && nLines < maxLines; n += s) {
    nLines += 1;
    const ll0 = p4(crs, "EPSG:4326", [e0, n]);
    const ll1 = p4(crs, "EPSG:4326", [e1, n]);
    const g = new ol.geom.LineString([ol.proj.fromLonLat(ll0), ol.proj.fromLonLat(ll1)]);
    features.push(new ol.Feature({ geometry: g }));
    const llMid = p4(crs, "EPSG:4326", [midE, n]);
    features.push(
      new ol.Feature({
        geometry: new ol.geom.Point(ol.proj.fromLonLat(llMid)),
        label: formatProjectedGridValue(n),
        kind: "northing"
      })
    );
  }
  gridSource.addFeatures(features);
}

function refreshGeographicCornerLabels() {
  if (!previewMap || !gridCornerSource) return;
  gridCornerSource.clear(true);
  const view = previewMap.getView();
  const size = previewMap.getSize();
  if (!size) return;
  const ext = view.calculateExtent(size);
  const w = ext[2] - ext[0];
  const h = ext[3] - ext[1];
  const inset = Math.max(24, Math.min(w, h) * 0.05);
  const corners = [
    { xy: [ext[0] + inset, ext[1] + inset], ta: "left", tb: "bottom", ox: 2, oy: -2 },
    { xy: [ext[2] - inset, ext[1] + inset], ta: "right", tb: "bottom", ox: -2, oy: -2 },
    { xy: [ext[2] - inset, ext[3] - inset], ta: "right", tb: "top", ox: -2, oy: 2 },
    { xy: [ext[0] + inset, ext[3] - inset], ta: "left", tb: "top", ox: 2, oy: 2 }
  ];
  const feats = corners.map((c) => {
    const ll = ol.proj.toLonLat(c.xy);
    const label = `${ll[0].toFixed(3)}°, ${ll[1].toFixed(3)}°`;
    return new ol.Feature({
      geometry: new ol.geom.Point(c.xy),
      label,
      ta: c.ta,
      tb: c.tb,
      ox: c.ox,
      oy: c.oy
    });
  });
  gridCornerSource.addFeatures(feats);
}

function refreshGridLayer() {
  if (!previewMap) return;
  const show = $("printGridShow")?.checked;
  const crs = $("printGridCrs")?.value || "EPSG:4326";
  const spacing = parseFloat($("printGridSpacing")?.value || "500");

  if (gridCornerLayer) {
    previewMap.removeLayer(gridCornerLayer);
    gridCornerLayer = null;
    gridCornerSource = null;
  }
  if (gridLayer) {
    previewMap.removeLayer(gridLayer);
    gridLayer = null;
  }
  if (gridSource) gridSource.clear(true);
  if (!show) return;

  if (crs === "EPSG:4326") {
    const grat = buildGraticuleLayer();
    if (grat) {
      gridLayer = grat;
      previewMap.addLayer(gridLayer);
    }
    gridCornerSource = new ol.source.Vector();
    gridCornerLayer = new ol.layer.Vector({
      source: gridCornerSource,
      zIndex: 490,
      style: (feature) =>
        new ol.style.Style({
          text: new ol.style.Text({
            text: feature.get("label") || "",
            font: "600 9px Inter, system-ui, sans-serif",
            fill: new ol.style.Fill({ color: "#0f2d1c" }),
            stroke: new ol.style.Stroke({ color: "rgba(255,255,255,0.9)", width: 2.4 }),
            textAlign: feature.get("ta") || "center",
            textBaseline: feature.get("tb") || "middle",
            offsetX: feature.get("ox") || 0,
            offsetY: feature.get("oy") || 0
          })
        })
    });
    previewMap.addLayer(gridCornerLayer);
    refreshGeographicCornerLabels();
    return;
  }

  const lineStroke = new ol.style.Stroke({
    color: "rgba(12, 74, 52, 0.5)",
    width: 1,
    lineDash: [4, 6]
  });
  const labelFill = new ol.style.Fill({ color: "#082818" });
  const labelHalo = new ol.style.Stroke({ color: "rgba(255,255,255,0.9)", width: 2.5 });

  gridLayer = new ol.layer.Vector({
    source: gridSource,
    style(feature) {
      if (feature.get("label")) {
        const kind = feature.get("kind");
        return new ol.style.Style({
          text: new ol.style.Text({
            text: String(feature.get("label")),
            font: "600 10px Inter, system-ui, sans-serif",
            fill: labelFill,
            stroke: labelHalo,
            offsetX: kind === "northing" ? -8 : 0,
            offsetY: kind === "easting" ? -8 : 0
          })
        });
      }
      return new ol.style.Style({
        stroke: lineStroke
      });
    },
    zIndex: 460
  });
  previewMap.addLayer(gridLayer);
  void updateProjectedGrid(previewMap, crs, spacing).then(() => previewMap.renderSync());
}

function syncPreviewFromMain() {
  const main = deps.getMap();
  if (!main || !previewMap) return;
  const base = getActiveBasemapTileLayer(deps.getBaseGroup());
  const layers = previewMap.getLayers();
  layers.clear();
  const baseClone = cloneBasemapLayer(base);
  if (baseClone) {
    layers.push(baseClone);
  } else {
    layers.push(
      new ol.layer.Tile({
        source: new ol.source.OSM(),
        zIndex: 0
      })
    );
  }
  layers.push(cloneVectorLayerWithStyle(deps.blocksLayer, deps.blocksSource, 420));
  layers.push(cloneVectorLayerWithStyle(deps.parcelsLayer, deps.parcelsSource, 440));

  gridSource = new ol.source.Vector();
  gridLayer = null;
  refreshGridLayer();

  const v = main.getView();
  previewMap.getView().setCenter(v.getCenter());
  previewMap.getView().setZoom(v.getZoom());
  previewMap.getView().setRotation(v.getRotation());
  previewMap.updateSize();
  previewMap.renderSync();
  invalidatePdfPreviewIfShown("Matched main map — use Preview PDF again if you had a draft open.");
}

function createPreviewMap() {
  const target = $("printPreviewMap");
  if (!target) return;
  target.innerHTML = "";
  gridSource = new ol.source.Vector();
  gridLayer = null;

  const main = deps.getMap();
  const base = getActiveBasemapTileLayer(deps.getBaseGroup());
  const layers = [];
  const b = cloneBasemapLayer(base);
  if (b) {
    layers.push(b);
  } else {
    layers.push(
      new ol.layer.Tile({
        source: new ol.source.OSM(),
        zIndex: 0
      })
    );
  }
  layers.push(cloneVectorLayerWithStyle(deps.blocksLayer, deps.blocksSource, 420));
  layers.push(cloneVectorLayerWithStyle(deps.parcelsLayer, deps.parcelsSource, 440));

  previewMap = new ol.Map({
    target,
    layers,
    view: new ol.View({
      projection: "EPSG:3857",
      center: main.getView().getCenter(),
      zoom: main.getView().getZoom(),
      rotation: main.getView().getRotation()
    }),
    controls: []
  });
  refreshGridLayer();
  previewMap.on("moveend", () => {
    invalidatePdfPreviewIfShown("Map view changed — use Preview PDF again.");
    if (!$("printGridShow")?.checked) return;
    const crs = $("printGridCrs")?.value;
    if (crs === "EPSG:4326") {
      refreshGeographicCornerLabels();
      previewMap.renderSync();
      return;
    }
    if (!crs || !gridSource) return;
    const spacing = parseFloat($("printGridSpacing")?.value || "500");
    void updateProjectedGrid(previewMap, crs, spacing).then(() => previewMap.renderSync());
  });
}

function openModal() {
  const modal = $("printComposerModal");
  if (!modal) return;
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("print-composer-open");
  disposePreviewMap();
  requestAnimationFrame(() => {
    createPreviewMap();
    requestAnimationFrame(() => {
      previewMap?.updateSize();
    });
  });
}

function closeModal() {
  const modal = $("printComposerModal");
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("print-composer-open");
  disposePreviewMap();
}

function approximateScaleDenominator() {
  if (!previewMap) return null;
  const view = previewMap.getView();
  const res = view.getResolution();
  const center = view.getCenter();
  if (!res || !center) return null;
  const mpu = ol.proj.getPointResolution(view.getProjection(), res, center);
  const dpi = 96;
  const inch = 0.0254;
  const denom = mpu / (inch / dpi);
  return Math.round(denom / 10) * 10;
}

async function loadPdfLibs() {
  if (window.__vslPdfLibs) return window.__vslPdfLibs;
  const [jspdfMod, QRCodeMod] = await Promise.all([
    import("https://cdn.jsdelivr.net/npm/jspdf@2.5.2/+esm"),
    import("https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm")
  ]);
  const QRCode = QRCodeMod.default || QRCodeMod;
  let PdfCtor = jspdfMod.jsPDF;
  if (typeof PdfCtor !== "function") PdfCtor = jspdfMod.default;
  if (typeof PdfCtor !== "function" || !QRCode?.toDataURL) {
    throw new Error("PDF or QR library failed to load.");
  }
  window.__vslPdfLibs = { jsPDF: PdfCtor, QRCode };
  return window.__vslPdfLibs;
}

function drawGraphicFooter(pdf, opts) {
  const {
    margin,
    pageW,
    pageH,
    footerH,
    blockRef,
    parcelRef,
    locationNotes,
    crsLabel,
    crsValue,
    gridOn,
    spacingM,
    scaleDen
  } = opts;
  const footerTop = pageH - margin - footerH;
  const bandW = pageW - margin * 2;
  const mid = pageW / 2 + 1;

  pdf.setFillColor(238, 245, 252);
  pdf.roundedRect(margin, footerTop, bandW, footerH, 3.2, 3.2, "F");
  pdf.setDrawColor(92, 128, 168);
  pdf.setLineWidth(0.4);
  pdf.roundedRect(margin, footerTop, bandW, footerH, 3.2, 3.2, "S");

  pdf.setFillColor(56, 108, 148);
  pdf.rect(margin, footerTop + 2.2, 3, footerH - 4.4, "F");

  pdf.setDrawColor(120, 158, 198);
  pdf.setLineWidth(0.5);
  pdf.line(margin + 6, footerTop + 6, pageW - margin - 4, footerTop + 6);

  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  const spacingTxt = crsValue === "EPSG:4326" ? "Graticule (auto spacing)" : `${spacingM} m`;
  const gridSummary = gridOn ? `On · ${crsLabel || crsValue || "—"} · ${spacingTxt}` : "Off";

  function kvColumn(startX, startY, maxValW, entries) {
    let y = startY;
    for (const [label, value] of entries) {
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(6.4);
      pdf.setTextColor(72, 98, 122);
      pdf.text(String(label).toUpperCase(), startX, y);
      y += 3.2;
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(7.9);
      pdf.setTextColor(28, 44, 58);
      const lines = pdf.splitTextToSize(value || "—", maxValW);
      pdf.text(lines, startX, y);
      y += lines.length * 3.65 + 2;
    }
    return y;
  }

  const leftW = mid - margin - 16;
  const rightW = pageW - margin - mid - 10;
  kvColumn(margin + 7, footerTop + 11, leftW, [
    ["Block reference", blockRef],
    ["Plot / parcel reference", parcelRef],
    ["Location or job notes", locationNotes]
  ]);
  kvColumn(mid + 6, footerTop + 11, rightW, [
    ["Coordinate grid", gridSummary],
    ["Approximate scale", scaleDen != null ? `1 : ${scaleDen.toLocaleString()}` : "—"],
    ["Exported (UTC)", ts]
  ]);

  pdf.setFillColor(72, 124, 168);
  pdf.rect(margin + 6, footerTop + footerH - 3.4, bandW - 12, 2, "F");
}

async function buildPdfDocument() {
  if (!previewMap) throw new Error("Preview map not ready.");
  const { jsPDF: PdfCtor, QRCode } = await loadPdfLibs();
  await waitForMapRenderStable(previewMap, 3);

  let mapImg = compositeMapViewportToDataUrl(previewMap, "image/jpeg", 0.9);
  if (!mapImg) {
    const canvas = previewMap.getViewport().querySelector("canvas");
    if (!canvas) throw new Error("Map canvas not ready. Wait for tiles, then try again.");
    mapImg = canvas.toDataURL("image/jpeg", 0.88);
  }

  const logoUrl = new URL("./assets/victoria-sugar-logo.jpg", window.location.href).href;
  let logoData = null;
  try {
    const res = await fetch(logoUrl);
    const blob = await res.blob();
    logoData = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch {
    logoData = null;
  }

  const qrDataUrl = await QRCode.toDataURL(PRINT_QR_URL, {
    width: 112,
    margin: 1,
    color: { dark: "#1a4d2e", light: "#ffffff" }
  });

  const sheetTitle = $("printSheetTitle")?.value?.trim() || "";
  const blockRef = $("printBlockRef")?.value?.trim() || "";
  const parcelRef = $("printParcelRef")?.value?.trim() || "";
  const locationNotes = $("printLocationNotes")?.value?.trim() || "";
  const crsLabel = $("printGridCrs")?.selectedOptions?.[0]?.textContent || "";
  const crsValue = $("printGridCrs")?.value || "";
  const gridOn = Boolean($("printGridShow")?.checked);
  const spacingM = $("printGridSpacing")?.value || "500";
  const scaleDen = approximateScaleDenominator();

  const pdf = new PdfCtor({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = pdf.internal.pageSize.getWidth();
  const pageH = pdf.internal.pageSize.getHeight();
  const margin = 12;
  const headerH = 28;
  const footerH = 46;
  const mapTop = margin + headerH + 4;
  const mapBottom = pageH - margin - footerH - 4;
  const mapLeft = margin;
  const mapW = pageW - margin * 2;
  const mapH = mapBottom - mapTop;

  pdf.setFillColor(232, 241, 250);
  pdf.rect(0, 0, pageW, pageH, "F");
  pdf.setDrawColor(68, 108, 148);
  pdf.setLineWidth(0.55);
  pdf.roundedRect(2.4, 2.4, pageW - 4.8, pageH - 4.8, 1.2, 1.2, "S");

  pdf.setFillColor(226, 236, 248);
  pdf.rect(0, 0, pageW, headerH + 6, "F");
  pdf.setDrawColor(88, 128, 168);
  pdf.setLineWidth(0.5);
  pdf.line(margin, headerH + 6, pageW - margin, headerH + 6);

  if (logoData) {
    pdf.addImage(logoData, "JPEG", margin, 6, 22, 18);
  }
  pdf.setTextColor(26, 60, 40);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(15);
  pdf.text("VICTORIA SUGAR LTD", margin + (logoData ? 28 : 0), 12);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9.2);
  pdf.setTextColor(55, 75, 55);
  const tag = "Land intelligence platform for sugarcane blocks and parcels.";
  pdf.text(tag, margin + (logoData ? 28 : 0), 19);
  if (sheetTitle) {
    pdf.setFontSize(10);
    pdf.setTextColor(40, 90, 50);
    pdf.text(sheetTitle, margin + (logoData ? 28 : 0), 25);
  }
  pdf.addImage(qrDataUrl, "PNG", pageW - margin - 24, 5, 22, 22);

  pdf.setDrawColor(72, 118, 162);
  pdf.setLineWidth(0.65);
  pdf.roundedRect(mapLeft - 1.5, mapTop - 1.5, mapW + 3, mapH + 3, 2, 2, "S");
  pdf.addImage(mapImg, "JPEG", mapLeft, mapTop, mapW, mapH);

  drawGraphicFooter(pdf, {
    margin,
    pageW,
    pageH,
    footerH,
    blockRef,
    parcelRef,
    locationNotes,
    crsLabel,
    crsValue,
    gridOn,
    spacingM,
    scaleDen
  });

  const safeName = (sheetTitle || "victoria-sugar-map-export")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 48);
  return { pdf, safeName: safeName || "map-export" };
}

async function runPreviewPdf() {
  if (!previewMap) return;
  const { setStatus, statusEl } = deps;
  setStatus(statusEl, "Building PDF preview…");
  try {
    const { pdf } = await buildPdfDocument();
    disposePdfPreview();
    const ab = pdf.output("arraybuffer");
    const blob = new Blob([ab], { type: "application/pdf" });
    pdfPreviewBlobUrl = URL.createObjectURL(blob);
    const frame = $("printPdfPreviewFrame");
    const wrap = $("printPdfPreviewWrap");
    if (frame) frame.src = pdfPreviewBlobUrl;
    if (wrap) wrap.hidden = false;
    setPdfPreviewNote("");
    setStatus(statusEl, "Preview ready. Use Print to PDF when the layout looks correct.");
  } catch (e) {
    deps.setStatus(deps.statusEl, e.message || "PDF preview failed.", true);
  }
}

async function runExportPdf() {
  if (!previewMap) return;
  const { setStatus, statusEl } = deps;
  setStatus(statusEl, "Preparing PDF…");
  try {
    const { pdf, safeName } = await buildPdfDocument();
    pdf.save(`${safeName}.pdf`);
    setStatus(statusEl, "PDF downloaded.");
  } catch (e) {
    deps.setStatus(deps.statusEl, e.message || "PDF export failed.", true);
  }
}

function wireForm() {
  $("printGridShow")?.addEventListener("change", () => {
    if (previewMap) refreshGridLayer();
    invalidatePdfPreviewIfShown("Grid options changed — use Preview PDF again.");
  });
  $("printGridCrs")?.addEventListener("change", () => {
    if (previewMap) refreshGridLayer();
    invalidatePdfPreviewIfShown("Grid options changed — use Preview PDF again.");
  });
  $("printGridSpacing")?.addEventListener("change", () => {
    if (previewMap && $("printGridCrs")?.value !== "EPSG:4326") refreshGridLayer();
    invalidatePdfPreviewIfShown("Grid options changed — use Preview PDF again.");
  });
  for (const id of ["printSheetTitle", "printBlockRef", "printParcelRef", "printLocationNotes"]) {
    $(id)?.addEventListener("input", () => {
      invalidatePdfPreviewIfShown("Sheet details changed — use Preview PDF again.");
    });
  }
}

let printComposerWired = false;

export function initPrintComposer(options) {
  if (printComposerWired) return;
  printComposerWired = true;
  deps = options;
  $("printBtn")?.addEventListener("click", () => openModal());

  window.addEventListener("resize", () => {
    const m = $("printComposerModal");
    if (m && !m.hidden && previewMap) {
      previewMap.updateSize();
      invalidatePdfPreviewIfShown("Map panel was resized — use Preview PDF again.");
    }
  });

  $("printComposerCloseBtn")?.addEventListener("click", () => closeModal());
  $("printComposerCancelBtn")?.addEventListener("click", () => closeModal());
  $("printComposerBackdrop")?.addEventListener("click", () => closeModal());
  $("printComposerSyncBtn")?.addEventListener("click", () => syncPreviewFromMain());
  $("printComposerPreviewBtn")?.addEventListener("click", () => void runPreviewPdf());
  $("printComposerExportBtn")?.addEventListener("click", () => void runExportPdf());

  const crsSel = $("printGridCrs");
  if (crsSel && !crsSel.options.length) {
    for (const o of CRS_OPTIONS) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      crsSel.appendChild(opt);
    }
    crsSel.value = "EPSG:32636";
  }

  wireForm();

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("printComposerModal")?.hidden) {
      closeModal();
    }
  });
}
