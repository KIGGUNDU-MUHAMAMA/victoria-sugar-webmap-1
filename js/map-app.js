import { createSupabaseClient, getConfig } from "./supabase-client.js";
import { clearStatus, parseNum, setStatus } from "./utils.js";
import { initSurveyImport } from "./survey-import.js";
import { initCoordSearchDrawer } from "./coord-search-drawer.js";
import { initCoordExtractDrawer } from "./coord-extract-drawer.js";
import { initPrintComposer } from "./print-composer.js";

const supabase = createSupabaseClient();
const cfg = getConfig();

const statusEl = document.getElementById("status");
const panelHost = document.getElementById("panelHost");

const drawBlockBtn = document.getElementById("drawBlockBtn");
const drawParcelBtn = document.getElementById("drawParcelBtn");
const measureLineBtn = document.getElementById("measureLineBtn");
const measureAreaBtn = document.getElementById("measureAreaBtn");
const stopDrawBtn = document.getElementById("stopDrawBtn");
const drawBlockCodeInput = document.getElementById("drawBlockCodeInput");
const drawParcelBlockInput = document.getElementById("drawParcelBlockInput");
const drawParcelNoOverride = document.getElementById("drawParcelNoOverride");
const snapBlocksCb = document.getElementById("snapBlocksCb");
const snapParcelsCb = document.getElementById("snapParcelsCb");
const snapSurveyCb = document.getElementById("snapSurveyCb");
const clearMeasuresBtn = document.getElementById("clearMeasuresBtn");
const drawToolsFeedback = document.getElementById("drawToolsFeedback");
const panelButtons = {
  drawingPanelBtn: "drawingPanel"
};

const locateBtn = document.getElementById("locateBtn");
const printBtn = document.getElementById("printBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const infoBtn = document.getElementById("infoBtn");
const logoutBtn = document.getElementById("logoutBtn");
const fallbackLayerSwitcherEl = document.getElementById("fallbackLayerSwitcher");

let map;
let currentUser;
let currentProfile;
let isAuthenticated = false;
let selectedFeature = null;
let selectedLayerType = null;
let activeInteraction = null;
let activeSnapInteractions = [];
/** Survey CSV preview vector sources (for snap); set after initSurveyImport */
let surveyPreviewSnapSources = null;
let baseGroupRef;

const MAP_DRAW_PROJ = "EPSG:3857";

const blocksSource = new ol.source.Vector();
const parcelsSource = new ol.source.Vector();
const editSource = new ol.source.Vector();

/** Set by parcel search RPC; layer styles emphasize these ids after bbox reload. */
const searchHighlight = { blockId: null, parcelId: null };

/** Cultivation status → map colours (blocks & parcels when not search-highlighted). */
const CULTIVATION_PALETTE = {
  not_in_cane: { stroke: "#455a64", fill: "rgba(84, 110, 122, 0.32)", text: "#37474f" },
  prepared: { stroke: "#4e342e", fill: "rgba(93, 64, 55, 0.3)", text: "#3e2723" },
  planted: { stroke: "#1b5e20", fill: "rgba(46, 125, 50, 0.36)", text: "#1b5e20" },
  standing: { stroke: "#0d3d0d", fill: "rgba(13, 61, 13, 0.4)", text: "#0d2f0d" },
  harvested: { stroke: "#e65100", fill: "rgba(251, 192, 45, 0.42)", text: "#bf360c" },
  replant_renovation: { stroke: "#4a148c", fill: "rgba(106, 27, 154, 0.32)", text: "#4a148c" }
};

function cultivationKeyFromFeature(feature) {
  const s = feature.get("cultivation_status");
  return s && CULTIVATION_PALETTE[s] ? s : "not_in_cane";
}

const parcelStatusState = {
  panelOpen: false,
  pickArmed: false,
  selectedFeature: null,
  selectedLayerType: null
};

const CULTIVATION_STATUS_LABELS = {
  not_in_cane: "Not in cane",
  prepared: "Prepared",
  planted: "Planted",
  standing: "Standing",
  harvested: "Harvested",
  replant_renovation: "Replant / renovation"
};

const INFO_FIELD_LABELS = {
  block_code: "Block code",
  block_name: "Block name",
  estate_name: "Estate / project",
  parcel_no: "Plot number",
  parcel_code: "Plot code",
  parcel_label: "Plot label",
  expected_area_acres: "Expected area",
  geometry_status: "Geometry status",
  cultivation_status: "Cultivation status",
  harvest_tonnes: "Harvest (tonnes cane)",
  last_harvest_date: "Last harvest date",
  cultivation_notes: "Notes",
  cultivation_updated_at: "Status last updated"
};

const INFO_BLOCK_FIELD_ORDER = [
  "block_code",
  "block_name",
  "estate_name",
  "expected_area_acres",
  "geometry_status",
  "cultivation_status",
  "harvest_tonnes",
  "last_harvest_date",
  "cultivation_notes",
  "cultivation_updated_at"
];

const INFO_PARCEL_FIELD_ORDER = [
  "block_code",
  "parcel_no",
  "parcel_code",
  "parcel_label",
  "expected_area_acres",
  "geometry_status",
  "cultivation_status",
  "harvest_tonnes",
  "last_harvest_date",
  "cultivation_notes",
  "cultivation_updated_at"
];

let infoHelpPopoverOpen = false;
let infoHelpOutsideHandler = null;
let infoHelpEscapeHandler = null;

let searchPanelOpen = false;
let searchPanelOutsideHandler = null;
let searchPanelEscapeHandler = null;

// Legacy aliases kept for internal functions that still reference these names
let parcelSearchDockOpen = false;

let placeSearchOpen = false;

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInfoFieldValue(key, val) {
  if (val == null || val === "") return "—";
  if (key === "expected_area_acres" && Number.isFinite(Number(val))) {
    return `${Number(val).toFixed(2)} ac`;
  }
  if (key === "harvest_tonnes" && Number.isFinite(Number(val))) {
    return `${Number(val).toLocaleString(undefined, { maximumFractionDigits: 3 })} t`;
  }
  if (key === "cultivation_status") {
    return CULTIVATION_STATUS_LABELS[String(val)] || escapeHtml(val);
  }
  if (key === "last_harvest_date" || key === "cultivation_updated_at") {
    const t = String(val);
    return escapeHtml(t.length > 16 ? t.slice(0, 16) : t);
  }
  return escapeHtml(val);
}

function buildFeatureInfoPopupHtml(layerType, feature) {
  const props = feature.getProperties();
  const order = layerType === "PARCELS" ? INFO_PARCEL_FIELD_ORDER : INFO_BLOCK_FIELD_ORDER;
  const badge = layerType === "PARCELS" ? "Parcel" : "Block";
  const rows = order
    .map((key) => {
      const raw = props[key];
      if (raw == null || raw === "") return null;
      const label = INFO_FIELD_LABELS[key] || key;
      const display = formatInfoFieldValue(key, raw);
      return `<div class="map-popup__row"><span class="map-popup__dt">${escapeHtml(label)}</span><span class="map-popup__dd">${display}</span></div>`;
    })
    .filter(Boolean)
    .join("");
  const body =
    rows ||
    `<p class="map-popup__empty">No attributes loaded for this feature. Zoom in or reload layers.</p>`;
  return `
    <div class="map-popup__inner">
      <header class="map-popup__head">
        <span class="map-popup__badge">${badge}</span>
        <button type="button" class="map-popup__close" aria-label="Close details">&times;</button>
      </header>
      <div class="map-popup__grid">${body}</div>
    </div>`;
}

function surveyFeatureAreaAcresText(feature) {
  const raw = feature.get("expected_area_acres");
  if (raw != null && raw !== "" && Number.isFinite(Number(raw))) {
    return `${Number(raw).toFixed(2)} ac`;
  }
  const g = feature.getGeometry();
  if (!g) return "";
  try {
    return `${(ol.sphere.getArea(g) * 0.000247105).toFixed(2)} ac`;
  } catch {
    return "";
  }
}

const blocksLayer = new ol.layer.Vector({
  title: "BLOCKS",
  visible: true,
  source: blocksSource,
  style: (feature) => {
    const bid = feature.getId();
    const hi =
      searchHighlight.blockId != null &&
      bid != null &&
      String(bid) === String(searchHighlight.blockId);
    const pal = CULTIVATION_PALETTE[cultivationKeyFromFeature(feature)];
    const code = String(feature.get("block_code") ?? "").trim() || "—";
    const area = surveyFeatureAreaAcresText(feature);
    const text = area ? `${code}\n${area}` : code;
    return new ol.style.Style({
      stroke: new ol.style.Stroke(
        hi ? { color: "#e65100", width: 4 } : { color: pal.stroke, width: 2 }
      ),
      fill: new ol.style.Fill({
        color: hi ? "rgba(230, 81, 0, 0.14)" : pal.fill
      }),
      text: new ol.style.Text({
        text,
        font: hi ? "700 12px Inter, sans-serif" : "600 11px Inter, sans-serif",
        fill: new ol.style.Fill({ color: hi ? "#bf360c" : pal.text }),
        stroke: new ol.style.Stroke({ color: "#ffffff", width: 3 }),
        overflow: true
      })
    });
  }
});

const parcelsLayer = new ol.layer.Vector({
  title: "PARCELS",
  visible: true,
  source: parcelsSource,
  style: (feature) => {
    const pid = feature.getId();
    const hi =
      searchHighlight.parcelId != null &&
      pid != null &&
      String(pid) === String(searchHighlight.parcelId);
    const pal = CULTIVATION_PALETTE[cultivationKeyFromFeature(feature)];
    const num = feature.get("parcel_no");
    const label =
      num != null && num !== ""
        ? String(num)
        : String(feature.get("parcel_code") ?? "")
            .replace(/^P-/i, "")
            .trim() || "—";
    const area = surveyFeatureAreaAcresText(feature);
    const text = area ? `${label}\n${area}` : label;
    return new ol.style.Style({
      stroke: new ol.style.Stroke(
        hi ? { color: "#f9a825", width: 4 } : { color: pal.stroke, width: 2 }
      ),
      fill: new ol.style.Fill({
        color: hi ? "rgba(249, 168, 37, 0.38)" : pal.fill
      }),
      text: new ol.style.Text({
        text,
        font: hi ? "700 12px Inter, sans-serif" : "600 11px Inter, sans-serif",
        fill: new ol.style.Fill({ color: hi ? "#f57f17" : pal.text }),
        stroke: new ol.style.Stroke({ color: "#ffffff", width: hi ? 4 : 3 }),
        overflow: true
      })
    });
  }
});

const sketchLayer = new ol.layer.Vector({
  title: "Draw and Measure",
  visible: true,
  source: editSource,
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: "#8d6a3a", width: 2, lineDash: [6, 4] }),
    fill: new ol.style.Fill({ color: "rgba(141, 106, 58, 0.15)" })
  })
});
sketchLayer.setZIndex(920);

const measureSource = new ol.source.Vector();

function formatGroundLengthM(m) {
  if (!Number.isFinite(m)) return "—";
  if (m >= 1000) return `${(m / 1000).toFixed(3)} km`;
  if (m >= 1) return `${m.toFixed(1)} m`;
  return `${m.toFixed(2)} m`;
}

function buildLineMeasureStyles(feature) {
  const geometry = feature.getGeometry();
  if (!geometry || geometry.getType() !== "LineString") return [];
  const coords = geometry.getCoordinates();
  const styles = [
    new ol.style.Style({
      geometry,
      stroke: new ol.style.Stroke({ color: "#5d4037", width: 3 }),
      zIndex: 0
    })
  ];
  for (let i = 0; i < coords.length - 1; i += 1) {
    const seg = new ol.geom.LineString([coords[i], coords[i + 1]]);
    const lenM = ol.sphere.getLength(seg, { projection: MAP_DRAW_PROJ });
    const mid = seg.getCoordinateAt(0.5);
    styles.push(
      new ol.style.Style({
        geometry: new ol.geom.Point(mid),
        text: new ol.style.Text({
          text: formatGroundLengthM(lenM),
          font: "600 11px Inter, system-ui, sans-serif",
          fill: new ol.style.Fill({ color: "#1d2a1d" }),
          stroke: new ol.style.Stroke({ color: "#fff", width: 3 }),
          padding: [2, 4, 2, 4]
        }),
        zIndex: 2
      })
    );
  }
  return styles;
}

function buildAreaMeasureStyles(feature) {
  const geometry = feature.getGeometry();
  if (!geometry || geometry.getType() !== "Polygon") return [];
  const areaM2 = ol.sphere.getArea(geometry, { projection: MAP_DRAW_PROJ });
  const ha = areaM2 / 10000;
  const ip = geometry.getInteriorPoint();
  return [
    new ol.style.Style({
      geometry,
      stroke: new ol.style.Stroke({ color: "#4e342e", width: 2.5 }),
      fill: new ol.style.Fill({ color: "rgba(78, 52, 46, 0.14)" }),
      zIndex: 0
    }),
    new ol.style.Style({
      geometry: ip,
      text: new ol.style.Text({
        text: `${ha.toFixed(3)} ha`,
        font: "700 12px Inter, system-ui, sans-serif",
        fill: new ol.style.Fill({ color: "#3e2723" }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 4 })
      }),
      zIndex: 2
    })
  ];
}

const measureLayer = new ol.layer.Vector({
  title: "Measurements",
  visible: true,
  source: measureSource,
  style: (feature) => {
    const k = feature.get("_measureKind");
    if (k === "distance") return buildLineMeasureStyles(feature);
    if (k === "area") return buildAreaMeasureStyles(feature);
    return [];
  }
});
measureLayer.setZIndex(930);
measureLayer.set("displayInLayerSwitcher", false);

function createBasemapLayer(title, source, visible = false) {
  return new ol.layer.Tile({
    title,
    type: "base",
    visible,
    source
  });
}

function buildLayerTree() {
  const googleHybrid = createBasemapLayer("Google Satellite Hybrid", new ol.source.XYZ({
    url: "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
    crossOrigin: "anonymous"
  }), true);
  const esriImagery = createBasemapLayer("Esri World Imagery", new ol.source.XYZ({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    crossOrigin: "anonymous"
  }));
  const noBasemap = createBasemapLayer("No Basemap", new ol.source.XYZ({
    url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
  }));

  const overlaysGroup = new ol.layer.Group({
    title: "SURVEY LAYERS",
    fold: "open",
    layers: [blocksLayer, parcelsLayer]
  });

  const baseGroup = new ol.layer.Group({
    title: "Base Maps",
    fold: "open",
    layers: [googleHybrid, esriImagery, noBasemap]
  });

  let graticuleLayer = null;
  if (typeof ol !== "undefined" && ol.layer && typeof ol.layer.Graticule === "function") {
    graticuleLayer = new ol.layer.Graticule({
      visible: true,
      maxLines: 12,
      targetSize: 300,
      strokeStyle: new ol.style.Stroke({
        color: "rgba(34, 78, 34, 0.42)",
        width: 1,
        lineDash: [10, 14]
      }),
      showLabels: true,
      lonLabelStyle: new ol.style.Text({
        font: "600 10px Inter, system-ui, sans-serif",
        fill: new ol.style.Fill({ color: "#1b3d1b" }),
        stroke: new ol.style.Stroke({ color: "rgba(255,255,255,0.88)", width: 2.5 }),
        textBaseline: "bottom"
      }),
      latLabelStyle: new ol.style.Text({
        font: "600 10px Inter, system-ui, sans-serif",
        fill: new ol.style.Fill({ color: "#1b3d1b" }),
        stroke: new ol.style.Stroke({ color: "rgba(255,255,255,0.88)", width: 2.5 }),
        textAlign: "end"
      }),
      lonLabelFormatter: (lon) => `${lon.toFixed(1)}°`,
      latLabelFormatter: (lat) => `${lat.toFixed(1)}°`,
      zIndex: 0
    });
    graticuleLayer.set("displayInLayerSwitcher", false);
  }

  sketchLayer.set("displayInLayerSwitcher", false);
  baseGroupRef = baseGroup;
  // Order = bottom → top. Tile basemaps must be below vector layers or opaque maps hide polygons.
  const stack = [baseGroup];
  if (graticuleLayer) stack.push(graticuleLayer);
  stack.push(overlaysGroup, sketchLayer, measureLayer);
  return stack;
}

function setBasemapByTitle(targetTitle) {
  if (!baseGroupRef) return;
  baseGroupRef.getLayers().forEach((layer) => {
    layer.setVisible(layer.get("title") === targetTitle);
  });
}

function enableFallbackLayerSwitcher() {
  if (!fallbackLayerSwitcherEl) return;
  fallbackLayerSwitcherEl.hidden = false;
  const fbBlocks = document.getElementById("fbBlocks");
  const fbParcels = document.getElementById("fbParcels");
  fbBlocks?.addEventListener("change", () => blocksLayer.setVisible(fbBlocks.checked));
  fbParcels?.addEventListener("change", () => parcelsLayer.setVisible(fbParcels.checked));

  fallbackLayerSwitcherEl.querySelectorAll("input[name='fbBasemap']").forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) setBasemapByTitle(radio.value);
    });
  });
}

function setActivePanel(panelId) {
  closeParcelStatusPanel();
  closeInfoHelpPopover();
  closePlaceSearchCard();
  closeSearchPanel({ clearHighlight: true });

  window.dispatchEvent(new CustomEvent("vsl-force-close-extract-drawer"));

  const extractBtn = document.getElementById("coordExtractorMainBtn");
  extractBtn?.classList.remove("active");

  panelHost.classList.add("visible");
  for (const panel of panelHost.querySelectorAll(".panel")) {
    panel.classList.toggle("active", panel.id === panelId);
  }
  for (const [btnId, pId] of Object.entries(panelButtons)) {
    document.getElementById(btnId)?.classList.toggle("active", pId === panelId);
  }
  syncDrawToolsMapInset();
}

function setDrawToolsFeedback(message, isError) {
  if (!drawToolsFeedback) return;
  drawToolsFeedback.textContent = message || "";
  drawToolsFeedback.classList.toggle("draw-tools__feedback--error", !!isError && !!message);
}

function syncDrawToolsMapInset() {
  const wrap = document.querySelector(".map-viewport-wrap");
  if (!wrap) return;
  const drawOpen =
    panelHost.classList.contains("visible") &&
    document.getElementById("drawingPanel")?.classList.contains("active");
  wrap.classList.toggle("map-viewport-wrap--draw-dock", !!drawOpen);
  requestAnimationFrame(() => {
    map?.updateSize();
  });
}

function readSnapOptions() {
  return {
    snapBlocks: !!snapBlocksCb?.checked,
    snapParcels: !!snapParcelsCb?.checked,
    snapSurvey: !!snapSurveyCb?.checked
  };
}

function detachSnapInteractions() {
  if (!map) return;
  for (const s of activeSnapInteractions) {
    map.removeInteraction(s);
  }
  activeSnapInteractions = [];
}

function attachSnapInteractions(opts) {
  detachSnapInteractions();
  if (!map || !opts) return;
  const tol = 12;
  if (opts.snapBlocks) {
    activeSnapInteractions.push(new ol.interaction.Snap({ source: blocksSource, pixelTolerance: tol }));
  }
  if (opts.snapParcels) {
    activeSnapInteractions.push(new ol.interaction.Snap({ source: parcelsSource, pixelTolerance: tol }));
  }
  if (opts.snapSurvey && surveyPreviewSnapSources) {
    activeSnapInteractions.push(
      new ol.interaction.Snap({ source: surveyPreviewSnapSources.polySource, pixelTolerance: tol })
    );
    activeSnapInteractions.push(
      new ol.interaction.Snap({ source: surveyPreviewSnapSources.pointSource, pixelTolerance: tol })
    );
  }
  for (const s of activeSnapInteractions) {
    map.addInteraction(s);
  }
}

function closeDrawToolsPanel() {
  stopActiveTool();
  panelHost.classList.remove("visible");
  for (const p of panelHost.querySelectorAll(".panel")) p.classList.remove("active");
  for (const bId of Object.keys(panelButtons)) {
    document.getElementById(bId)?.classList.remove("active");
  }
  syncDrawToolsMapInset();
}

function setupPanels() {
  for (const [btnId, panelId] of Object.entries(panelButtons)) {
    document.getElementById(btnId)?.addEventListener("click", () => {
      if (
        btnId === "drawingPanelBtn" &&
        panelHost.classList.contains("visible") &&
        document.getElementById("drawingPanel")?.classList.contains("active")
      ) {
        closeDrawToolsPanel();
        return;
      }
      setActivePanel(panelId);
    });
  }
  document.getElementById("drawPanelCloseBtn")?.addEventListener("click", () => closeDrawToolsPanel());
}

function getParcelStatusLayerMode() {
  const r = document.querySelector("input[name='parcelStatusLayer']:checked");
  return r?.value === "BLOCKS" ? "BLOCKS" : "PARCELS";
}

function setParcelStatusFormError(msg) {
  const el = document.getElementById("parcelStatusFormError");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.hidden = false;
}

function disarmParcelStatusPick() {
  parcelStatusState.pickArmed = false;
  const pickBtn = document.getElementById("parcelStatusPickBtn");
  const cancelBtn = document.getElementById("parcelStatusCancelPickBtn");
  const hint = document.getElementById("parcelStatusPickHint");
  pickBtn?.classList.remove("picking-active");
  if (cancelBtn) cancelBtn.hidden = true;
  if (hint) {
    hint.innerHTML =
      "Choose <strong>Parcels</strong> or <strong>Blocks</strong>, then press <strong>Select on map</strong> and click a polygon.";
  }
}

function renderParcelStatusPreview() {
  const box = document.getElementById("parcelStatusPreview");
  const sec = document.getElementById("parcelStatusSelectionSection");
  const f = parcelStatusState.selectedFeature;
  const lt = parcelStatusState.selectedLayerType;
  if (!box || !sec) return;
  if (!f || !lt) {
    sec.hidden = true;
    box.innerHTML = "";
    return;
  }
  sec.hidden = false;
  const p = f.getProperties();
  if (lt === "PARCELS") {
    const bc = p.block_code ?? "—";
    const pn = p.parcel_no ?? p.parcel_code ?? "—";
    box.innerHTML = `<strong>Parcel</strong> in block <strong>${bc}</strong>, plot <strong>${pn}</strong><br><span class="parcel-status-preview-id">ID: ${f.getId() ?? ""}</span>`;
  } else {
    const code = p.block_code ?? "—";
    const name = p.block_name ?? "";
    box.innerHTML = `<strong>Block</strong> <strong>${code}</strong>${name ? ` — ${name}` : ""}<br><span class="parcel-status-preview-id">ID: ${f.getId() ?? ""}</span>`;
  }
}

function syncParcelStatusFormFromSelection() {
  const f = parcelStatusState.selectedFeature;
  const sel = document.getElementById("parcelStatusSelect");
  const ht = document.getElementById("parcelStatusHarvestTonnes");
  const dt = document.getElementById("parcelStatusLastHarvest");
  const notes = document.getElementById("parcelStatusNotes");
  if (!f || !sel) return;
  const st = cultivationKeyFromFeature(f);
  sel.value = st;
  const tonnes = f.get("harvest_tonnes");
  if (ht) ht.value = tonnes != null && tonnes !== "" ? String(tonnes) : "";
  const d = f.get("last_harvest_date");
  if (dt) dt.value = d ? String(d).slice(0, 10) : "";
  if (notes) notes.value = String(f.get("cultivation_notes") ?? "");
  setParcelStatusFormError("");
  renderParcelStatusPreview();
}

function clearParcelStatusSelection() {
  parcelStatusState.selectedFeature = null;
  parcelStatusState.selectedLayerType = null;
  renderParcelStatusPreview();
}

function closeParcelStatusPanel() {
  const panel = document.getElementById("parcelStatusPanel");
  const btn = document.getElementById("parcelStatusBtn");
  parcelStatusState.panelOpen = false;
  disarmParcelStatusPick();
  clearParcelStatusSelection();
  if (panel) {
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
  }
  btn?.classList.remove("active");
}

function openParcelStatusPanel() {
  const panel = document.getElementById("parcelStatusPanel");
  const btn = document.getElementById("parcelStatusBtn");
  if (!panel) return;
  closeInfoHelpPopover();
  closePlaceSearchCard();
  panel.hidden = false;
  panel.setAttribute("aria-hidden", "false");
  parcelStatusState.panelOpen = true;
  btn?.classList.add("active");
  panelHost.classList.remove("visible");
  for (const p of panelHost.querySelectorAll(".panel")) p.classList.remove("active");
  for (const bId of Object.keys(panelButtons)) {
    document.getElementById(bId)?.classList.remove("active");
  }
}

function tryParcelStatusMapClick(evt) {
  if (!parcelStatusState.pickArmed) return false;
  const mode = getParcelStatusLayerMode();
  let hit = null;
  let layerHit = null;
  const hitOpts = { hitTolerance: 12 };

  if (mode === "PARCELS") {
    map.forEachFeatureAtPixel(
      evt.pixel,
      (feature) => {
        hit = feature;
        return true;
      },
      { ...hitOpts, layerFilter: (layer) => layer === parcelsLayer }
    );
    if (hit) layerHit = "PARCELS";
  } else {
    map.forEachFeatureAtPixel(
      evt.pixel,
      (feature) => {
        hit = feature;
        return true;
      },
      { ...hitOpts, layerFilter: (layer) => layer === blocksLayer }
    );
    if (hit) layerHit = "BLOCKS";
  }

  if (!hit) {
    setStatus(statusEl, `Click a ${mode === "PARCELS" ? "parcel" : "block"} polygon.`, true);
    return true;
  }
  parcelStatusState.selectedFeature = hit;
  parcelStatusState.selectedLayerType = layerHit;
  disarmParcelStatusPick();
  syncParcelStatusFormFromSelection();
  clearStatus(statusEl);
  return true;
}

async function applyParcelStatusFromPanel() {
  const f = parcelStatusState.selectedFeature;
  const lt = parcelStatusState.selectedLayerType;
  const applyBtn = document.getElementById("parcelStatusApplyBtn");
  const sel = document.getElementById("parcelStatusSelect");
  if (!f || !lt || !sel) {
    setParcelStatusFormError("Select a feature on the map first.");
    return;
  }
  if (!isAuthenticated || !currentUser?.id || currentUser.id === "guest") {
    setParcelStatusFormError("Sign in to save changes.");
    return;
  }
  if (currentProfile?.role !== "ADMIN" && currentProfile?.role !== "SURVEYOR") {
    setParcelStatusFormError("Only Admin or Surveyor can save status.");
    return;
  }

  const status = sel.value;
  const htEl = document.getElementById("parcelStatusHarvestTonnes");
  const dtEl = document.getElementById("parcelStatusLastHarvest");
  const notesEl = document.getElementById("parcelStatusNotes");
  const tonnesRaw = htEl?.value?.trim() ?? "";
  const tonnes = tonnesRaw === "" ? null : parseNum(tonnesRaw);
  if (tonnesRaw !== "" && (tonnes == null || tonnes < 0)) {
    setParcelStatusFormError("Harvest tonnes must be a non-negative number or blank.");
    return;
  }
  const lastHarvest = dtEl?.value?.trim() || null;
  const notes = notesEl?.value?.trim() ?? "";

  if (applyBtn) applyBtn.disabled = true;
  setParcelStatusFormError("");

  const { data, error } = await supabase.rpc("vsl_set_cultivation_status", {
    p_layer_type: lt,
    p_feature_id: f.getId(),
    p_status: status,
    p_harvest_tonnes: tonnes,
    p_last_harvest_date: lastHarvest,
    p_notes: notes || null
  });

  if (applyBtn) applyBtn.disabled = false;

  if (error) {
    setParcelStatusFormError(error.message || "Save failed.");
    return;
  }
  if (!data || data.success !== true) {
    setParcelStatusFormError(String((data && data.error) || "Save failed."));
    return;
  }

  const savedId = f.getId();
  const savedLt = lt;
  await loadLayersFromDb();
  blocksLayer.changed();
  parcelsLayer.changed();
  const src = savedLt === "PARCELS" ? parcelsSource : blocksSource;
  const nf = src.getFeatures().find((x) => String(x.getId()) === String(savedId));
  if (nf) {
    parcelStatusState.selectedFeature = nf;
    parcelStatusState.selectedLayerType = savedLt;
    syncParcelStatusFormFromSelection();
  } else {
    clearParcelStatusSelection();
  }
  setStatus(statusEl, "Cultivation status saved.");
}

function setupParcelStatusPanel() {
  const toolbarBtn = document.getElementById("parcelStatusBtn");
  const closeBtn = document.getElementById("parcelStatusCloseBtn");
  const pickBtn = document.getElementById("parcelStatusPickBtn");
  const cancelPickBtn = document.getElementById("parcelStatusCancelPickBtn");
  const applyBtn = document.getElementById("parcelStatusApplyBtn");
  const layerRadios = document.querySelectorAll("input[name='parcelStatusLayer']");

  toolbarBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (parcelStatusState.panelOpen) closeParcelStatusPanel();
    else openParcelStatusPanel();
  });
  closeBtn?.addEventListener("click", () => closeParcelStatusPanel());

  pickBtn?.addEventListener("click", () => {
    if (!parcelStatusState.panelOpen) openParcelStatusPanel();
    parcelStatusState.pickArmed = true;
    pickBtn.classList.add("picking-active");
    if (cancelPickBtn) cancelPickBtn.hidden = false;
    const mode = getParcelStatusLayerMode();
    const hint = document.getElementById("parcelStatusPickHint");
    if (hint) {
      hint.innerHTML =
        mode === "BLOCKS"
          ? "Click a <strong>block</strong> boundary on the map."
          : "Click a <strong>parcel</strong> (plot) on the map.";
    }
    setStatus(statusEl, mode === "BLOCKS" ? "Click a block on the map." : "Click a parcel on the map.");
  });

  cancelPickBtn?.addEventListener("click", () => {
    disarmParcelStatusPick();
    clearStatus(statusEl);
  });

  layerRadios.forEach((r) => {
    r.addEventListener("change", () => {
      disarmParcelStatusPick();
      clearParcelStatusSelection();
    });
  });

  applyBtn?.addEventListener("click", () => applyParcelStatusFromPanel());
}

function closeInfoPopup() {
  const inner = document.getElementById("featureInfoPanelInner");
  const panel = document.getElementById("featureInfoPanel");
  if (inner) inner.innerHTML = "";
  if (panel) panel.hidden = true;
}

function setupInfoPopup() {
  const inner = document.getElementById("featureInfoPanelInner");
  const panel = document.getElementById("featureInfoPanel");
  if (!inner || !panel) return;

  inner.addEventListener("click", (ev) => {
    if (ev.target.closest(".map-popup__close")) {
      closeInfoPopup();
      selectedFeature = null;
      selectedLayerType = null;
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!panel.hidden) {
      closeInfoPopup();
      selectedFeature = null;
      selectedLayerType = null;
    }
  });

  map.on("singleclick", (evt) => {
    if (document.getElementById("coordExtractDrawer")?.dataset.picking === "1") {
      return;
    }

    if (tryParcelStatusMapClick(evt)) {
      return;
    }

    selectedFeature = null;
    selectedLayerType = null;
    inner.innerHTML = "";
    panel.hidden = true;

    map.forEachFeatureAtPixel(
      evt.pixel,
      (feature, layer) => {
        const isBlocks = layer === blocksLayer;
        const isParcels = layer === parcelsLayer;
        if (!isBlocks && !isParcels) return false;

        selectedFeature = feature;
        selectedLayerType = isBlocks ? "BLOCKS" : "PARCELS";

        inner.innerHTML = `<div class="map-popup map-popup--feature map-popup--feature-dock">${buildFeatureInfoPopupHtml(
          selectedLayerType,
          feature
        )}</div>`;
        panel.hidden = false;
        panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return true;
      },
      { layerFilter: (layer) => layer === blocksLayer || layer === parcelsLayer, hitTolerance: 6 }
    );
  });
}

function positionInfoHelpPopover() {
  const pop = document.getElementById("infoHelpPopover");
  if (!pop || pop.hidden) return;
  pop.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function closeInfoHelpPopover() {
  const pop = document.getElementById("infoHelpPopover");
  const btn = document.getElementById("infoBtn");
  if (infoHelpOutsideHandler) {
    document.removeEventListener("pointerdown", infoHelpOutsideHandler, true);
    infoHelpOutsideHandler = null;
  }
  if (infoHelpEscapeHandler) {
    document.removeEventListener("keydown", infoHelpEscapeHandler, true);
    infoHelpEscapeHandler = null;
  }
  infoHelpPopoverOpen = false;
  if (pop) pop.hidden = true;
  btn?.classList.remove("active");
  btn?.setAttribute("aria-expanded", "false");
}

function openInfoHelpPopover() {
  const pop = document.getElementById("infoHelpPopover");
  const btn = document.getElementById("infoBtn");
  if (!pop || !btn || infoHelpPopoverOpen) return;
  closeParcelSearchPopover({ clearHighlight: false });
  closeInfoPopup();
  closePlaceSearchCard();
  selectedFeature = null;
  selectedLayerType = null;
  pop.hidden = false;
  btn.classList.add("active");
  btn.setAttribute("aria-expanded", "true");
  infoHelpPopoverOpen = true;

  infoHelpOutsideHandler = (ev) => {
    if (!infoHelpPopoverOpen) return;
    if (pop.contains(ev.target) || btn.contains(ev.target)) return;
    closeInfoHelpPopover();
  };
  document.addEventListener("pointerdown", infoHelpOutsideHandler, true);

  infoHelpEscapeHandler = (ev) => {
    if (ev.key === "Escape" && infoHelpPopoverOpen) {
      ev.preventDefault();
      closeInfoHelpPopover();
    }
  };
  document.addEventListener("keydown", infoHelpEscapeHandler, true);

  requestAnimationFrame(() => {
    pop.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function toggleInfoHelpPopover() {
  if (infoHelpPopoverOpen) closeInfoHelpPopover();
  else openInfoHelpPopover();
}

function setupInfoHelpPopover() {
  const btn = document.getElementById("infoBtn");
  const closeBtn = document.getElementById("infoHelpCloseBtn");
  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleInfoHelpPopover();
  });
  closeBtn?.addEventListener("click", () => closeInfoHelpPopover());
  window.addEventListener("resize", () => {
    if (infoHelpPopoverOpen) positionInfoHelpPopover();
  });
}

let lastNominatimRequestAt = 0;


function setPlaceSearchError(msg) {
  const el = document.getElementById("placeSearchError");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.hidden = false;
}

function closePlaceSearchCard() {
  // Place search is now inside the unified search panel; this is a no-op kept for compatibility
  placeSearchOpen = false;
  const results = document.getElementById("placeSearchResults");
  if (results) {
    results.innerHTML = "";
    results.hidden = true;
  }
  setPlaceSearchError("");
}

function openPlaceSearchCard() {
  // Now activates the Place tab inside the unified search panel instead of a floating popover
  openSearchPanel("place");
  placeSearchOpen = true;
  requestAnimationFrame(() => {
    document.getElementById("placeSearchInput")?.focus();
  });
}

function togglePlaceSearchCard() {
  if (searchPanelOpen) {
    // If panel already open on place tab, close it
    const placeTab = document.getElementById("tabPlace");
    if (placeTab?.getAttribute("aria-selected") === "true") {
      closeSearchPanel({ clearHighlight: false });
      return;
    }
  }
  openSearchPanel("place");
}

function renderPlaceResults(items) {
  const ul = document.getElementById("placeSearchResults");
  if (!ul) return;
  ul.innerHTML = "";
  if (!items || !items.length) {
    ul.hidden = true;
    setPlaceSearchError("No places found. Try a different spelling or broader name.");
    return;
  }
  setPlaceSearchError("");
  ul.hidden = false;
  for (const item of items) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "place-search-result-btn";
    const name = escapeHtml(item.display_name || "Unnamed");
    const typeLabel = item.type ? escapeHtml(String(item.type)) : "";
    const typeHtml = typeLabel
      ? `<span class="place-search-result-type">${typeLabel}</span>`
      : "";
    b.innerHTML = `<span class="place-search-result-name">${name}</span>${typeHtml}`;
    b.addEventListener("click", () => {
      flyToNominatimResult(item);
      closePlaceSearchCard();
      clearStatus(statusEl);
      setStatus(statusEl, `Showing: ${item.display_name ?? "place"}`);
    });
    li.appendChild(b);
    ul.appendChild(li);
  }
}

function flyToNominatimResult(item) {
  if (!map) return;
  const lon = parseFloat(item.lon);
  const lat = parseFloat(item.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  const bb = item.boundingbox;
  if (bb && bb.length === 4) {
    const south = parseFloat(bb[0]);
    const north = parseFloat(bb[1]);
    const west = parseFloat(bb[2]);
    const east = parseFloat(bb[3]);
    if ([south, north, west, east].every(Number.isFinite)) {
      const sw = ol.proj.fromLonLat([west, south]);
      const ne = ol.proj.fromLonLat([east, north]);
      const extent = ol.extent.boundingExtent([sw, ne]);
      let afterOnce = false;
      const after = () => {
        if (afterOnce) return;
        afterOnce = true;
        loadLayersFromDb();
      };
      map.getView().fit(extent, {
        padding: [72, 72, 100, 72],
        maxZoom: 17,
        duration: 900,
        callback: after
      });
      window.setTimeout(after, 1300);
      return;
    }
  }
  map.getView().animate({
    center: ol.proj.fromLonLat([lon, lat]),
    zoom: Math.max(map.getView().getZoom() || 10, 13),
    duration: 750
  });
  window.setTimeout(() => loadLayersFromDb(), 850);
}

async function runPlaceSearchQuery() {
  const input = document.getElementById("placeSearchInput");
  const goBtn = document.getElementById("placeSearchGoBtn");
  const q = input?.value?.trim() ?? "";
  setPlaceSearchError("");
  if (!q) {
    setPlaceSearchError("Type a place name, then Search.");
    return;
  }
  const now = Date.now();
  if (now - lastNominatimRequestAt < 1100) {
    setPlaceSearchError("Please wait a moment between searches.");
    return;
  }
  lastNominatimRequestAt = now;

  if (goBtn) goBtn.disabled = true;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=7&addressdetails=0`;
    const res = await fetch(url, {
      headers: { "Accept-Language": "en" },
      referrerPolicy: "strict-origin-when-cross-origin"
    });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const data = await res.json();
    renderPlaceResults(Array.isArray(data) ? data : []);
  } catch (e) {
    setPlaceSearchError(e.message || "Search could not complete. Check your connection.");
    const ul = document.getElementById("placeSearchResults");
    if (ul) {
      ul.innerHTML = "";
      ul.hidden = true;
    }
  } finally {
    if (goBtn) goBtn.disabled = false;
  }
}

function setupPlaceSearch() {
  const goBtn = document.getElementById("placeSearchGoBtn");
  const input = document.getElementById("placeSearchInput");

  goBtn?.addEventListener("click", () => void runPlaceSearchQuery());
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runPlaceSearchQuery();
    }
  });
}

async function loadLayersFromDb() {
  if (!map) return;
  map.updateSize();
  const size = map.getSize();
  if (!size || size[0] < 2 || size[1] < 2) {
    if (cfg.DEBUG_MAP_RPC && window.console?.debug) {
      console.debug("[Victoria map] Skipping bbox load: map size not ready yet");
    }
    return;
  }
  const extent = map.getView().calculateExtent(size);
  const [minLon, minLat, maxLon, maxLat] = ol.proj.transformExtent(extent, "EPSG:3857", "EPSG:4326");
  const { data, error } = await supabase.rpc("vsl_get_features_bbox", {
    p_min_lon: minLon,
    p_min_lat: minLat,
    p_max_lon: maxLon,
    p_max_lat: maxLat
  });
  if (error) {
    setStatus(statusEl, `Layer load failed: ${error.message}`, true);
    return;
  }

  blocksSource.clear(true);
  parcelsSource.clear(true);

  const geojsonFmt = new ol.format.GeoJSON();
  const projOpts = { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" };
  const geomTypes = new Set([
    "Point",
    "LineString",
    "Polygon",
    "MultiPoint",
    "MultiLineString",
    "MultiPolygon",
    "GeometryCollection"
  ]);

  let n = 0;
  for (const row of data || []) {
    if (!row.geojson) continue;
    let feature;
    const gj = row.geojson;
    if (typeof gj === "string") {
      try {
        feature = geojsonFmt.readFeature(gj, projOpts);
      } catch {
        continue;
      }
    } else if (gj.type === "Feature") {
      feature = geojsonFmt.readFeature(gj, projOpts);
    } else if (geomTypes.has(gj.type)) {
      const geom = geojsonFmt.readGeometry(gj, projOpts);
      feature = new ol.Feature({ geometry: geom });
    } else {
      continue;
    }
    feature.setProperties(row.properties || {}, true);
    feature.setId(row.feature_id);
    if (row.layer_type === "BLOCKS") blocksSource.addFeature(feature);
    if (row.layer_type === "PARCELS") parcelsSource.addFeature(feature);
    n += 1;
  }
  const rowCount = (data || []).length;
  if (cfg.DEBUG_MAP_RPC && window.console?.debug) {
    console.debug(`[Victoria map] vsl_get_features_bbox: ${n} feature(s) drawn, ${rowCount} row(s) from API`);
  }
}

function clearSearchHighlight() {
  searchHighlight.blockId = null;
  searchHighlight.parcelId = null;
  if (map) {
    blocksLayer.changed();
    parcelsLayer.changed();
  }
}

function setParcelSearchPopoverError(msg) {
  const el = document.getElementById("parcelSearchPopoverError");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.hidden = false;
}


function openSearchPanel(tab = "coords") {
  const panel = document.getElementById("searchPanel");
  const btn = document.getElementById("searchPanelBtn");
  if (!panel || !btn) return;
  closeInfoHelpPopover();
  closePlaceSearchCard();
  panel.hidden = false;
  btn.classList.add("active");
  btn.setAttribute("aria-expanded", "true");
  searchPanelOpen = true;
  parcelSearchDockOpen = true; // keep legacy flag in sync for runLocateParcelFromPopover

  // Activate the requested tab
  activateSearchTab(tab);

  // Keyboard close
  searchPanelEscapeHandler = (ev) => {
    if (ev.key === "Escape" && searchPanelOpen) {
      ev.preventDefault();
      closeSearchPanel({ clearHighlight: false });
    }
  };
  document.addEventListener("keydown", searchPanelEscapeHandler, true);

  searchPanelOutsideHandler = (ev) => {
    if (!searchPanelOpen) return;
    if (panel.contains(ev.target) || btn.contains(ev.target)) return;
    closeSearchPanel({ clearHighlight: false });
  };
  document.addEventListener("pointerdown", searchPanelOutsideHandler, true);

  requestAnimationFrame(() => {
    // Focus first input of active tab
    const activeTab = panel.querySelector(".search-panel__tab-body:not([hidden]) input, .search-panel__tab-body:not([hidden]) select");
    activeTab?.focus();
    map?.updateSize();
  });
}

function closeSearchPanel(options = {}) {
  const { clearHighlight = true } = options;
  const panel = document.getElementById("searchPanel");
  const btn = document.getElementById("searchPanelBtn");
  if (searchPanelOutsideHandler) {
    document.removeEventListener("pointerdown", searchPanelOutsideHandler, true);
    searchPanelOutsideHandler = null;
  }
  if (searchPanelEscapeHandler) {
    document.removeEventListener("keydown", searchPanelEscapeHandler, true);
    searchPanelEscapeHandler = null;
  }
  searchPanelOpen = false;
  parcelSearchDockOpen = false;
  placeSearchOpen = false;
  if (panel) panel.hidden = true;
  btn?.classList.remove("active");
  btn?.setAttribute("aria-expanded", "false");
  setParcelSearchPopoverError("");
  setPlaceSearchError("");
  if (clearHighlight) clearSearchHighlight();
  map?.updateSize();
}

function activateSearchTab(tab) {
  const tabs = ["coords", "parcel", "place"];
  const tabElMap = { coords: "tabCoords", parcel: "tabParcel", place: "tabPlace" };
  const bodyElMap = { coords: "searchTabCoords", parcel: "searchTabParcel", place: "searchTabPlace" };
  tabs.forEach((t) => {
    const tabEl = document.getElementById(tabElMap[t]);
    const bodyEl = document.getElementById(bodyElMap[t]);
    const active = t === tab;
    if (tabEl) tabEl.setAttribute("aria-selected", String(active));
    if (bodyEl) bodyEl.hidden = !active;
  });
}

function setupSearchTabSwitching() {
  ["tabCoords", "tabParcel", "tabPlace"].forEach((id) => {
    const btn = document.getElementById(id);
    btn?.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      if (tab) activateSearchTab(tab);
    });
  });
}

// Legacy: openParcelSearchDock now delegates to the unified panel
function openParcelSearchDock() {
  openSearchPanel("parcel");
}

// Legacy no-op kept so nothing breaks
function positionPlaceSearchPopover() {}

function closeParcelSearchPopover(options = {}) {
  closeSearchPanel(options);
}

async function runLocateParcelFromPopover() {
  const blockInput = document.getElementById("parcelSearchBlockInput");
  const noInput = document.getElementById("parcelSearchNoInput");
  const goBtn = document.getElementById("parcelSearchGoBtn");
  const cancelBtn = document.getElementById("parcelSearchPopoverCancelBtn");
  const blockQ = blockInput?.value?.trim() ?? "";
  const plotStr = noInput?.value?.trim() ?? "";
  let parcelNo = null;
  if (plotStr !== "") {
    const parcelNoRaw = parseNum(plotStr);
    parcelNo = parcelNoRaw != null ? Math.trunc(parcelNoRaw) : null;
    if (parcelNo == null || parcelNo < 1 || !Number.isFinite(parcelNo)) {
      setParcelSearchPopoverError(
        "Enter a valid plot number (whole number ≥ 1), or leave plot empty to search the block only."
      );
      return;
    }
  }

  setParcelSearchPopoverError("");
  if (!blockQ) {
    setParcelSearchPopoverError("Enter a block code or block name.");
    return;
  }

  goBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;

  const { data, error } = await supabase.rpc("vsl_locate_parcel", {
    p_block_query: blockQ,
    p_parcel_no: parcelNo
  });

  if (error) {
    setParcelSearchPopoverError(error.message || "Search failed.");
    goBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    return;
  }

  if (!data || data.success !== true) {
    const errMsg = (data && data.error) || "Nothing matched.";
    setParcelSearchPopoverError(String(errMsg));
    goBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    return;
  }

  const mode = data.search_mode === "parcel" ? "parcel" : "block";
  const geojsonFmt = new ol.format.GeoJSON();
  const projOpts = { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" };
  let blockGeom;
  try {
    blockGeom = geojsonFmt.readGeometry(data.block.geojson, projOpts);
  } catch (e) {
    setParcelSearchPopoverError("Could not read geometry from the server.");
    goBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    return;
  }

  let parcelGeom = null;
  if (mode === "parcel" && data.parcel?.geojson) {
    try {
      parcelGeom = geojsonFmt.readGeometry(data.parcel.geojson, projOpts);
    } catch (e) {
      setParcelSearchPopoverError("Could not read plot geometry from the server.");
      goBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      return;
    }
  }

  searchHighlight.blockId = data.block.id;
  searchHighlight.parcelId = mode === "parcel" && data.parcel?.id != null ? data.parcel.id : null;

  const combined = ol.extent.createEmpty();
  ol.extent.extend(combined, blockGeom.getExtent());
  if (parcelGeom) ol.extent.extend(combined, parcelGeom.getExtent());

  const finish = async () => {
    try {
      await loadLayersFromDb();
      blocksLayer.changed();
      parcelsLayer.changed();
      clearStatus(statusEl);
      const bc = data.block.block_code ?? "";
      if (mode === "parcel" && data.parcel) {
        setStatus(
          statusEl,
          `Block ${bc}, plot ${data.parcel.parcel_no} — highlighted on the map.`
        );
      } else {
        setStatus(statusEl, `Block ${bc} — zoomed to block boundary.`);
      }
      setParcelSearchPopoverError("");
    } finally {
      goBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
    }
  };

  let finished = false;
  const safeFinish = () => {
    if (finished) return;
    finished = true;
    finish();
  };

  const dockEl = document.getElementById("searchPanel");
  let leftPad = 96;
  if (dockEl && !dockEl.hidden) {
    const w = dockEl.getBoundingClientRect().width;
    if (w > 0) leftPad = Math.min(360, Math.round(w + 24));
  }
  const fitOpts = {
    padding: [88, 96, 96, leftPad],
    maxZoom: 19,
    duration: 1350,
    callback: () => safeFinish()
  };
  if (ol.easing && typeof ol.easing.easeOut === "function") {
    fitOpts.easing = ol.easing.easeOut;
  }

  map.getView().fit(combined, fitOpts);
  window.setTimeout(() => safeFinish(), 2200);
}

function setupParcelSearchPopover() {
  const searchBtn = document.getElementById("searchPanelBtn");
  const form = document.getElementById("parcelSearchForm");
  const cancelBtn = document.getElementById("parcelSearchPopoverCancelBtn");

  searchBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (searchPanelOpen) {
      closeSearchPanel({ clearHighlight: false });
    } else {
      openSearchPanel("coords");
    }
  });

  cancelBtn?.addEventListener("click", () => {
    setParcelSearchPopoverError("");
    clearSearchHighlight();
  });

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    runLocateParcelFromPopover();
  });
}

function stopActiveTool() {
  detachSnapInteractions();
  if (activeInteraction && map) {
    map.removeInteraction(activeInteraction);
    activeInteraction = null;
  }
}

function drawGeometry(layerType) {
  stopActiveTool();
  setDrawToolsFeedback("", false);
  if (layerType === "BLOCKS") {
    const code = drawBlockCodeInput?.value?.trim() ?? "";
    if (!code) {
      setDrawToolsFeedback("Enter a block code or name before drawing.", true);
      setStatus(statusEl, "Enter block code before draw block.", true);
      return;
    }
  } else {
    const blk = drawParcelBlockInput?.value?.trim() ?? "";
    if (!blk) {
      setDrawToolsFeedback("Enter the parent block code or number before drawing.", true);
      setStatus(statusEl, "Enter parent block before draw parcel.", true);
      return;
    }
    const overrideRaw = drawParcelNoOverride?.value?.trim() ?? "";
    if (overrideRaw !== "" && !/^\d+$/.test(overrideRaw)) {
      setDrawToolsFeedback("Parcel number override must be a whole number.", true);
      return;
    }
  }

  const draw = new ol.interaction.Draw({ source: editSource, type: "Polygon" });
  draw.on("drawend", async (evt) => {
    map.removeInteraction(draw);
    activeInteraction = null;
    detachSnapInteractions();
    const feature = evt.feature;
    editSource.clear(true);
    let blockCode = "";
    let parcelNoOverride = null;
    if (layerType === "BLOCKS") {
      blockCode = drawBlockCodeInput?.value?.trim() ?? "";
    } else {
      blockCode = drawParcelBlockInput?.value?.trim() ?? "";
      const o = drawParcelNoOverride?.value?.trim() ?? "";
      parcelNoOverride = o === "" ? null : parseInt(o, 10);
    }
    await saveGeometry(feature, layerType, { blockCode, parcelNoOverride });
  });
  activeInteraction = draw;
  map.addInteraction(draw);
  attachSnapInteractions(readSnapOptions());
  setDrawToolsFeedback(
    layerType === "BLOCKS"
      ? "Click corners, double-click to finish the block polygon."
      : "Click corners, double-click to finish the parcel polygon.",
    false
  );
  setStatus(statusEl, `Drawing ${layerType === "BLOCKS" ? "block" : "parcel"}…`);
}

async function saveGeometry(feature, layerType, opts = {}) {
  const { blockCode: blockCodeRaw, parcelNoOverride } = opts;
  const blockCode = String(blockCodeRaw ?? "").trim();
  if (!blockCode) {
    setDrawToolsFeedback("Block code is missing.", true);
    setStatus(statusEl, "Block code is required.", true);
    return;
  }

  const geojson = new ol.format.GeoJSON().writeFeatureObject(feature, {
    featureProjection: "EPSG:3857",
    dataProjection: "EPSG:4326"
  });

  let parcelNo = null;
  if (layerType === "PARCELS") {
    parcelNo = parcelNoOverride;
    if (parcelNo != null && (!Number.isInteger(parcelNo) || parcelNo < 1)) {
      setDrawToolsFeedback("Parcel number must be a positive whole number.", true);
      setStatus(statusEl, "Invalid parcel number.", true);
      return;
    }
  }

  const { data: savedId, error } = await supabase.rpc("vsl_upsert_geometry", {
    p_layer_type: layerType,
    p_block_code: blockCode,
    p_parcel_no: parcelNo,
    p_geojson: geojson.geometry,
    p_user_id: currentUser.id
  });
  if (error) {
    setDrawToolsFeedback(error.message, true);
    setStatus(statusEl, `Save failed: ${error.message}`, true);
    return;
  }
  await loadLayersFromDb();
  if (layerType === "PARCELS" && parcelNo == null && savedId) {
    const { data: row } = await supabase
      .from("vsl_parcels")
      .select("parcel_no")
      .eq("id", savedId)
      .maybeSingle();
    if (row?.parcel_no != null) {
      const msg = `Parcel saved as plot ${row.parcel_no} in block ${blockCode}.`;
      setDrawToolsFeedback(msg, false);
      setStatus(statusEl, msg);
    } else {
      const msg = `Parcel saved in block ${blockCode}.`;
      setDrawToolsFeedback(msg, false);
      setStatus(statusEl, msg);
    }
  } else if (layerType === "PARCELS") {
    const msg = `Parcel ${parcelNo} saved in block ${blockCode}.`;
    setDrawToolsFeedback(msg, false);
    setStatus(statusEl, msg);
  } else {
    const msg = `Block ${blockCode} geometry saved.`;
    setDrawToolsFeedback(msg, false);
    setStatus(statusEl, msg);
  }
}

function startMeasure(type) {
  stopActiveTool();
  editSource.clear(true);
  const draw = new ol.interaction.Draw({ source: editSource, type });
  draw.on("drawend", (evt) => {
    map.removeInteraction(draw);
    activeInteraction = null;
    detachSnapInteractions();
    const geom = evt.feature.getGeometry();
    editSource.removeFeature(evt.feature);
    if (type === "LineString") {
      const feat = new ol.Feature({ geometry: geom.clone() });
      feat.set("_measureKind", "distance");
      const totalM = ol.sphere.getLength(geom, { projection: MAP_DRAW_PROJ });
      measureSource.addFeature(feat);
      const msg = `Total length: ${formatGroundLengthM(totalM)}. Segment labels are on the map.`;
      setDrawToolsFeedback(msg, false);
      setStatus(statusEl, msg);
    } else {
      const feat = new ol.Feature({ geometry: geom.clone() });
      feat.set("_measureKind", "area");
      const areaM2 = ol.sphere.getArea(geom, { projection: MAP_DRAW_PROJ });
      const ha = areaM2 / 10000;
      measureSource.addFeature(feat);
      const msg = `Area: ${ha.toFixed(3)} ha`;
      setDrawToolsFeedback(msg, false);
      setStatus(statusEl, msg);
    }
  });
  activeInteraction = draw;
  map.addInteraction(draw);
  attachSnapInteractions(readSnapOptions());
  setDrawToolsFeedback(
    type === "LineString"
      ? "Draw a path; double-click to finish. Snaps use the checkboxes above."
      : "Draw a polygon; double-click to finish.",
    false
  );
  setStatus(statusEl, type === "LineString" ? "Measuring distance…" : "Measuring area…");
}

function locateMe() {
  if (!navigator.geolocation) {
    setStatus(statusEl, "Geolocation is not supported in this browser.", true);
    return;
  }
  navigator.geolocation.getCurrentPosition((pos) => {
    const coord = ol.proj.fromLonLat([pos.coords.longitude, pos.coords.latitude]);
    map.getView().animate({ center: coord, zoom: 16, duration: 350 });
  }, (err) => setStatus(statusEl, err.message, true), { enableHighAccuracy: true, timeout: 9000 });
}

function bindEvents() {
  setupPanels();
  setupSearchTabSwitching();
  setupParcelSearchPopover();
  setupParcelStatusPanel();
  setupInfoHelpPopover();
  setupPlaceSearch();

  drawBlockBtn.addEventListener("click", () => drawGeometry("BLOCKS"));
  drawParcelBtn.addEventListener("click", () => drawGeometry("PARCELS"));
  measureLineBtn.addEventListener("click", () => startMeasure("LineString"));
  measureAreaBtn.addEventListener("click", () => startMeasure("Polygon"));
  stopDrawBtn.addEventListener("click", stopActiveTool);
  clearMeasuresBtn?.addEventListener("click", () => {
    measureSource.clear(true);
    setDrawToolsFeedback("Measurements cleared.", false);
    setStatus(statusEl, "Measurements cleared.");
  });

  locateBtn.addEventListener("click", locateMe);
  fullscreenBtn.addEventListener("click", () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  });
  logoutBtn.addEventListener("click", async () => {
    await supabase.auth.signOut();
    window.location.href = "./login.html";
  });

  window.addEventListener("resize", () => map?.updateSize());
}

async function initUser() {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.user) {
    if (cfg.ALLOW_GUEST_PREVIEW) {
      isAuthenticated = false;
      currentUser = { id: "guest" };
      currentProfile = { role: "GUEST" };
      const psBanner = document.getElementById("parcelStatusReadOnlyBanner");
      const psApply = document.getElementById("parcelStatusApplyBtn");
      if (psBanner) psBanner.hidden = false;
      if (psApply) psApply.disabled = true;
      return true;
    }
    window.location.href = "./login.html";
    return false;
  }
  currentUser = data.session.user;
  isAuthenticated = true;
  const { data: profile, error } = await supabase
    .from("vsl_profiles")
    .select("role")
    .eq("id", currentUser.id)
    .single();
  if (error || !profile?.role) {
    await supabase.auth.signOut();
    window.location.href = "./login.html";
    return false;
  }
  currentProfile = profile;
  const psBanner = document.getElementById("parcelStatusReadOnlyBanner");
  const psApply = document.getElementById("parcelStatusApplyBtn");
  const statusReadonly =
    currentProfile.role === "MANAGMENT";
  if (psBanner) psBanner.hidden = !statusReadonly;
  if (psApply) psApply.disabled = statusReadonly;

  if (currentProfile.role === "MANAGMENT") {
    drawBlockBtn.disabled = true;
    drawParcelBtn.disabled = true;
    measureLineBtn.disabled = true;
    measureAreaBtn.disabled = true;
    stopDrawBtn.disabled = true;
    clearMeasuresBtn.disabled = true;
    for (const el of [
      drawBlockCodeInput,
      drawParcelBlockInput,
      drawParcelNoOverride,
      snapBlocksCb,
      snapParcelsCb,
      snapSurveyCb
    ]) {
      if (el) el.disabled = true;
    }
    const sp = document.getElementById("surveyPreviewBtn");
    const ss = document.getElementById("surveySaveBtn");
    if (sp) sp.disabled = true;
    if (ss) ss.disabled = true;
  }
  return true;
}

async function initMap() {
  map = new ol.Map({
    target: "map",
    layers: buildLayerTree(),
    view: new ol.View({
      center: ol.proj.fromLonLat(cfg.DEFAULT_CENTER || [32.59, 0.35]),
      zoom: cfg.DEFAULT_ZOOM || 11
    }),
    controls: [
      new ol.control.ScaleLine()
    ]
  });

  const LayerSwitcherClass = ol.control.LayerSwitcher || window.LayerSwitcher;
  if (LayerSwitcherClass) {
    const layerSwitcher = new LayerSwitcherClass({
      tipLabel: "Layers",
      groupSelectStyle: "children",
      activationMode: "click",
      startActive: true
    });
    map.addControl(layerSwitcher);
    if (typeof layerSwitcher.renderPanel === "function") {
      setTimeout(() => layerSwitcher.renderPanel(), 0);
    }
  } else {
    console.warn("LayerSwitcher not found at ol.control.LayerSwitcher or window.LayerSwitcher");
    enableFallbackLayerSwitcher();
  }

  // Google tile fallback in case provider blocks/returns empty.
  const googleLayer = baseGroupRef?.getLayers()?.getArray()?.find((l) => l.get("title") === "Google Satellite Hybrid");
  if (googleLayer?.getSource) {
    let errorCount = 0;
    googleLayer.getSource().on("tileloaderror", () => {
      errorCount += 1;
      if (errorCount >= 4 && googleLayer.getVisible()) {
        setBasemapByTitle("Esri World Imagery");
        const radio = fallbackLayerSwitcherEl?.querySelector("input[name='fbBasemap'][value='Esri World Imagery']");
        if (radio) radio.checked = true;
        setStatus(statusEl, "Google Hybrid unavailable. Fell back to Esri World Imagery.", true);
      }
    });
  }

  setupInfoPopup();
  bindEvents();
  initPrintComposer({
    getMap: () => map,
    getBaseGroup: () => baseGroupRef,
    blocksSource,
    parcelsSource,
    blocksLayer,
    parcelsLayer,
    setStatus,
    statusEl
  });
  const surveyImportHandles = initSurveyImport({
    map,
    cfg,
    setStatus,
    statusEl,
    loadLayersFromDb,
    getManagementLocked: () => currentProfile?.role === "MANAGMENT",
    blocksSource,
    parcelsSource
  });
  surveyPreviewSnapSources = surveyImportHandles?.getPreviewSnapSources?.() ?? null;
  initCoordSearchDrawer({
    map,
    setStatus,
    statusEl,
    onDrawerOpen: () => {
      closePlaceSearchCard();
    },
    // The coord search now lives inside #searchPanel; pass a no-op open/close
    // so the module doesn't try to toggle a non-existent aside drawer.
    panelMode: true
  });
  initCoordExtractDrawer({
    map,
    parcelsLayer,
    blocksLayer,
    setStatus,
    statusEl,
    stopActiveTool
  });
  await loadLayersFromDb();
  map.on("moveend", async () => {
    await loadLayersFromDb();
  });

  const loader = document.getElementById("mapLoader");
  if (loader) {
    loader.classList.add("hidden");
    setTimeout(() => loader.remove(), 500);
  }

  // First paint often reports 0×0 map size; reload layers once layout is stable.
  requestAnimationFrame(() => {
    map.updateSize();
    loadLayersFromDb();
  });
  setTimeout(() => {
    map.updateSize();
    loadLayersFromDb();
  }, 350);
}

async function start() {
  clearStatus(statusEl);
  const ok = await initUser();
  if (!ok) return;
  await initMap();
  if (isAuthenticated) {
    setStatus(statusEl, `Signed in as ${currentProfile.role}. Ready.`);
  } else if (cfg.ALLOW_GUEST_PREVIEW) {
    setStatus(statusEl, "Guest preview mode: sign in for full access.");
  }
}

start().catch((err) => setStatus(statusEl, err.message, true));
