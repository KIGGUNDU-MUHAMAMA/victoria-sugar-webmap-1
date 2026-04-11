/**
 * Map PDF export: framed preview map, optional grid, branded PDF with QR.
 */

import { CRS_OPTIONS, registerProj4Defs, PROJ4_DEFS } from "./crs-definitions.js";

const PRINT_QR_URL = "https://farms.victoriasugarltd.xyz/webmap";

let deps = null;
let previewMap = null;
let gridLayer = null;
let gridSource = null;
let proj4lib = null;

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
    opacity: tileLayer.getOpacity()
  });
}

function cloneVectorLayerWithStyle(vectorLayer, source) {
  const st = vectorLayer.getStyle();
  return new ol.layer.Vector({
    source,
    style: typeof st === "function" ? st : st,
    zIndex: vectorLayer.getZIndex?.() ?? 100
  });
}

function disposePreviewMap() {
  if (previewMap) {
    previewMap.setTarget(null);
    previewMap = null;
  }
  gridLayer = null;
  gridSource = null;
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
    zIndex: 500
  });
}

/**
 * Simple projected grid in map CRS (Web Mercator edges labeled in selected CRS at corners).
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
  const features = [];
  const maxLines = 40;
  let nLines = 0;
  for (let e = e0; e <= e1 && nLines < maxLines; e += s) {
    nLines += 1;
    const ll0 = p4(crs, "EPSG:4326", [e, n0]);
    const ll1 = p4(crs, "EPSG:4326", [e, n1]);
    const g = new ol.geom.LineString([ol.proj.fromLonLat(ll0), ol.proj.fromLonLat(ll1)]);
    features.push(new ol.Feature({ geometry: g }));
  }
  nLines = 0;
  for (let n = n0; n <= n1 && nLines < maxLines; n += s) {
    nLines += 1;
    const ll0 = p4(crs, "EPSG:4326", [e0, n]);
    const ll1 = p4(crs, "EPSG:4326", [e1, n]);
    const g = new ol.geom.LineString([ol.proj.fromLonLat(ll0), ol.proj.fromLonLat(ll1)]);
    features.push(new ol.Feature({ geometry: g }));
  }
  gridSource.addFeatures(features);
}

function refreshGridLayer() {
  if (!previewMap) return;
  const show = $("printGridShow")?.checked;
  const crs = $("printGridCrs")?.value || "EPSG:4326";
  const spacing = parseFloat($("printGridSpacing")?.value || "500");

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
    return;
  }

  gridLayer = new ol.layer.Vector({
    source: gridSource,
    style: new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: "rgba(12, 74, 52, 0.45)",
        width: 1,
        lineDash: [4, 6]
      })
    }),
    zIndex: 500
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
        source: new ol.source.OSM()
      })
    );
  }
  layers.push(cloneVectorLayerWithStyle(deps.blocksLayer, deps.blocksSource));
  layers.push(cloneVectorLayerWithStyle(deps.parcelsLayer, deps.parcelsSource));

  gridSource = new ol.source.Vector();
  gridLayer = null;
  refreshGridLayer();

  const v = main.getView();
  previewMap.getView().setCenter(v.getCenter());
  previewMap.getView().setZoom(v.getZoom());
  previewMap.getView().setRotation(v.getRotation());
  previewMap.updateSize();
  previewMap.renderSync();
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
        source: new ol.source.OSM()
      })
    );
  }
  layers.push(cloneVectorLayerWithStyle(deps.blocksLayer, deps.blocksSource));
  layers.push(cloneVectorLayerWithStyle(deps.parcelsLayer, deps.parcelsSource));

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
    if (!$("printGridShow")?.checked) return;
    const crs = $("printGridCrs")?.value;
    if (!crs || crs === "EPSG:4326" || !gridSource) return;
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

async function exportPdf() {
  if (!previewMap) return;
  const { setStatus, statusEl } = deps;
  setStatus(statusEl, "Preparing PDF…");
  try {
    const { jsPDF: PdfCtor, QRCode } = await loadPdfLibs();
    await new Promise((r) => previewMap.once("rendercomplete", r));
    await new Promise((r) => setTimeout(r, 450));

    const canvas = previewMap.getViewport().querySelector("canvas");
    if (!canvas) throw new Error("Map canvas not ready. Wait for tiles, then try again.");
    const mapImg = canvas.toDataURL("image/jpeg", 0.88);

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
    const scaleDen = approximateScaleDenominator();

    const pdf = new PdfCtor({ orientation: "landscape", unit: "mm", format: "a4" });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 12;
    const headerH = 28;
    const footerH = 26;
    const mapTop = margin + headerH + 4;
    const mapBottom = pageH - margin - footerH - 4;
    const mapLeft = margin;
    const mapW = pageW - margin * 2;
    const mapH = mapBottom - mapTop;

    pdf.setFillColor(245, 250, 242);
    pdf.rect(0, 0, pageW, headerH + 6, "F");
    pdf.setDrawColor(62, 107, 62);
    pdf.setLineWidth(0.6);
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

    pdf.setDrawColor(78, 112, 61);
    pdf.setLineWidth(0.85);
    pdf.roundedRect(mapLeft - 1.5, mapTop - 1.5, mapW + 3, mapH + 3, 2, 2, "S");
    pdf.addImage(mapImg, "JPEG", mapLeft, mapTop, mapW, mapH);

    pdf.setFontSize(8.5);
    pdf.setTextColor(45, 55, 45);
    let fy = pageH - margin - footerH + 4;
    pdf.setFont("helvetica", "bold");
    pdf.text("Sheet details", margin, fy);
    fy += 5;
    pdf.setFont("helvetica", "normal");
    const lines = [
      `Block reference: ${blockRef || "—"}`,
      `Plot / parcel reference: ${parcelRef || "—"}`,
      `Location / job notes: ${locationNotes || "—"}`,
      `Approx. scale 1 : ${scaleDen != null ? scaleDen.toLocaleString() : "—"}  |  Grid CRS: ${crsLabel || "—"}`,
      `Exported: ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`
    ];
    for (const line of lines) {
      pdf.text(line, margin, fy);
      fy += 4.2;
    }

    const safeName = (sheetTitle || "victoria-sugar-map-export")
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 48);
    pdf.save(`${safeName || "map-export"}.pdf`);
    setStatus(statusEl, "PDF downloaded.");
  } catch (e) {
    deps.setStatus(deps.statusEl, e.message || "PDF export failed.", true);
  }
}

function wireForm() {
  $("printGridShow")?.addEventListener("change", () => {
    if (previewMap) refreshGridLayer();
  });
  $("printGridCrs")?.addEventListener("change", () => {
    if (previewMap) refreshGridLayer();
  });
  $("printGridSpacing")?.addEventListener("change", () => {
    if (previewMap && $("printGridCrs")?.value !== "EPSG:4326") refreshGridLayer();
  });
}

let printComposerWired = false;

export function initPrintComposer(options) {
  if (printComposerWired) return;
  printComposerWired = true;
  deps = options;
  $("printBtn")?.addEventListener("click", () => openModal());

  window.addEventListener("resize", () => {
    const m = $("printComposerModal");
    if (m && !m.hidden && previewMap) previewMap.updateSize();
  });

  $("printComposerCloseBtn")?.addEventListener("click", () => closeModal());
  $("printComposerCancelBtn")?.addEventListener("click", () => closeModal());
  $("printComposerBackdrop")?.addEventListener("click", () => closeModal());
  $("printComposerSyncBtn")?.addEventListener("click", () => syncPreviewFromMain());
  $("printComposerExportBtn")?.addEventListener("click", () => void exportPdf());

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
