import { createSupabaseClient, getConfig } from "./supabase-client.js";
import { clearStatus, parseNum, setStatus } from "./utils.js";
import { initSurveyImport } from "./survey-import.js";
import { initCoordSearchDrawer } from "./coord-search-drawer.js";
import { initCoordExtractDrawer } from "./coord-extract-drawer.js";

const supabase = createSupabaseClient();
const cfg = getConfig();

const statusEl = document.getElementById("status");
const panelHost = document.getElementById("panelHost");

const drawBlockBtn = document.getElementById("drawBlockBtn");
const drawParcelBtn = document.getElementById("drawParcelBtn");
const measureLineBtn = document.getElementById("measureLineBtn");
const measureAreaBtn = document.getElementById("measureAreaBtn");
const stopDrawBtn = document.getElementById("stopDrawBtn");
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
let infoOverlay;
let baseGroupRef;

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
  const osm = createBasemapLayer("OpenStreetMap", new ol.source.OSM(), false);
  const osmHot = createBasemapLayer("OpenStreetMap HOT", new ol.source.XYZ({
    url: "https://{a-c}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png",
    crossOrigin: "anonymous"
  }));
  const esriImagery = createBasemapLayer("Esri World Imagery", new ol.source.XYZ({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    crossOrigin: "anonymous"
  }));
  const esriTopo = createBasemapLayer("Esri World Topo Map", new ol.source.XYZ({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    crossOrigin: "anonymous"
  }));
  const esriTerrain = createBasemapLayer("Esri World Terrain", new ol.source.XYZ({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}",
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
    layers: [
      googleHybrid, osm, osmHot,
      esriImagery, esriTopo, esriTerrain,
      noBasemap
    ]
  });

  sketchLayer.set("displayInLayerSwitcher", false);
  baseGroupRef = baseGroup;
  // Order = bottom → top. Tile basemaps must be below vector layers or opaque maps hide polygons.
  return [baseGroup, overlaysGroup, sketchLayer];
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
  closeParcelSearchPopover({ clearHighlight: true });

  window.dispatchEvent(new CustomEvent("vsl-force-close-extract-drawer"));

  const coordDrawer = document.getElementById("coordSearchDrawer");
  const coordBtn = document.getElementById("coordSearchBtn");
  coordDrawer?.classList.remove("open");
  coordBtn?.classList.remove("active");
  coordDrawer?.setAttribute("aria-hidden", "true");

  const extractBtn = document.getElementById("coordExtractorMainBtn");
  extractBtn?.classList.remove("active");

  panelHost.classList.add("visible");
  for (const panel of panelHost.querySelectorAll(".panel")) {
    panel.classList.toggle("active", panel.id === panelId);
  }
  for (const [btnId, pId] of Object.entries(panelButtons)) {
    document.getElementById(btnId)?.classList.toggle("active", pId === panelId);
  }
}

function setupPanels() {
  for (const [btnId, panelId] of Object.entries(panelButtons)) {
    document.getElementById(btnId)?.addEventListener("click", () => setActivePanel(panelId));
  }
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
  const wantBlocks = mode === "BLOCKS";
  const wantParcels = mode === "PARCELS";
  let hits = map.getFeaturesAtPixel(evt.pixel, {
    layerFilter: (layer) => layer === blocksLayer || layer === parcelsLayer,
    hitTolerance: 8
  });
  if (hits == null) hits = [];
  if (!Array.isArray(hits)) hits = [hits];
  let hit = null;
  let layerHit = null;
  if (wantParcels) {
    const h = hits.find((x) => x.layer === parcelsLayer);
    if (h) {
      hit = h.feature;
      layerHit = "PARCELS";
    }
  } else if (wantBlocks) {
    const h = hits.find((x) => x.layer === blocksLayer);
    if (h) {
      hit = h.feature;
      layerHit = "BLOCKS";
    }
  }
  if (!hit) {
    setStatus(statusEl, `Click a ${wantParcels ? "parcel" : "block"} polygon.`, true);
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
    const hint = document.getElementById("parcelStatusPickHint");
    if (hint) {
      const mode = getParcelStatusLayerMode();
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

function setupInfoPopup() {
  const popupEl = document.createElement("div");
  popupEl.className = "map-popup";
  infoOverlay = new ol.Overlay({
    element: popupEl,
    offset: [10, 10],
    positioning: "bottom-left"
  });
  map.addOverlay(infoOverlay);

  map.on("singleclick", (evt) => {
    if (document.getElementById("coordExtractDrawer")?.dataset.picking === "1") {
      return;
    }

    if (tryParcelStatusMapClick(evt)) {
      return;
    }

    selectedFeature = null;
    selectedLayerType = null;
    popupEl.innerHTML = "";
    infoOverlay.setPosition(undefined);

    map.forEachFeatureAtPixel(
      evt.pixel,
      (feature, layer) => {
        const isBlocks = layer === blocksLayer;
        const isParcels = layer === parcelsLayer;
        if (!isBlocks && !isParcels) return false;

        selectedFeature = feature;
        selectedLayerType = isBlocks ? "BLOCKS" : "PARCELS";

        const props = feature.getProperties();
        const infoRows = Object.entries(props)
          .filter(([k]) => k !== "geometry")
          .slice(0, 10)
          .map(([k, v]) => `<div><strong>${k}:</strong> ${String(v ?? "")}</div>`)
          .join("");

        popupEl.innerHTML = `<div><strong>${selectedLayerType}</strong></div>${infoRows}`;
        infoOverlay.setPosition(evt.coordinate);
        return true;
      },
      { layerFilter: (layer) => layer === blocksLayer || layer === parcelsLayer }
    );
  });
}

async function loadLayersFromDb() {
  if (!map) return;
  map.updateSize();
  const size = map.getSize();
  if (!size || size[0] < 2 || size[1] < 2) {
    if (window.console && console.debug) {
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
  if (window.console && typeof console.debug === "function") {
    console.debug(`[Victoria map] vsl_get_features_bbox: ${n} feature(s) in view (${(data || []).length} row(s) from API)`);
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

let parcelSearchPopoverOpen = false;
let parcelSearchOutsideHandler = null;
let parcelSearchEscapeHandler = null;

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

function positionParcelSearchPopover() {
  const btn = document.getElementById("parcelSearchBtn");
  const pop = document.getElementById("parcelSearchPopover");
  if (!btn || !pop || pop.hidden) return;
  const r = btn.getBoundingClientRect();
  const gap = 10;
  const margin = 12;
  pop.style.position = "fixed";
  pop.style.zIndex = "1250";
  const measured = pop.getBoundingClientRect();
  const w = measured.width || 300;
  const h = measured.height || 260;
  let left = r.left;
  if (left + w > window.innerWidth - margin) {
    left = Math.max(margin, window.innerWidth - w - margin);
  }
  if (left < margin) left = margin;
  let top = r.bottom + gap;
  if (top + h > window.innerHeight - margin) {
    top = Math.max(margin, r.top - gap - h);
  }
  pop.style.top = `${Math.round(top)}px`;
  pop.style.left = `${Math.round(left)}px`;
}

function closeParcelSearchPopover(options = {}) {
  const { clearHighlight = true } = options;
  const pop = document.getElementById("parcelSearchPopover");
  const btn = document.getElementById("parcelSearchBtn");
  if (parcelSearchOutsideHandler) {
    document.removeEventListener("pointerdown", parcelSearchOutsideHandler, true);
    parcelSearchOutsideHandler = null;
  }
  if (parcelSearchEscapeHandler) {
    document.removeEventListener("keydown", parcelSearchEscapeHandler, true);
    parcelSearchEscapeHandler = null;
  }
  parcelSearchPopoverOpen = false;
  if (pop) pop.hidden = true;
  btn?.classList.remove("active");
  btn?.setAttribute("aria-expanded", "false");
  setParcelSearchPopoverError("");
  if (clearHighlight) clearSearchHighlight();
}

function openParcelSearchPopover() {
  const pop = document.getElementById("parcelSearchPopover");
  const btn = document.getElementById("parcelSearchBtn");
  const blockInput = document.getElementById("parcelSearchBlockInput");
  if (!pop || !btn || parcelSearchPopoverOpen) return;

  pop.hidden = false;
  btn.classList.add("active");
  btn.setAttribute("aria-expanded", "true");
  parcelSearchPopoverOpen = true;

  parcelSearchOutsideHandler = (ev) => {
    if (!parcelSearchPopoverOpen) return;
    if (pop.contains(ev.target) || btn.contains(ev.target)) return;
    closeParcelSearchPopover({ clearHighlight: true });
  };
  document.addEventListener("pointerdown", parcelSearchOutsideHandler, true);

  parcelSearchEscapeHandler = (ev) => {
    if (ev.key === "Escape" && parcelSearchPopoverOpen) {
      ev.preventDefault();
      closeParcelSearchPopover({ clearHighlight: true });
    }
  };
  document.addEventListener("keydown", parcelSearchEscapeHandler, true);

  requestAnimationFrame(() => {
    positionParcelSearchPopover();
    blockInput?.focus();
    blockInput?.select?.();
  });
}

function toggleParcelSearchPopover() {
  if (parcelSearchPopoverOpen) closeParcelSearchPopover({ clearHighlight: true });
  else openParcelSearchPopover();
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
      closeParcelSearchPopover({ clearHighlight: false });
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

  const fitOpts = {
    padding: [100, 100, 100, 100],
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
  const searchBtn = document.getElementById("parcelSearchBtn");
  const form = document.getElementById("parcelSearchForm");
  const closeBtn = document.getElementById("parcelSearchPopoverCloseBtn");
  const cancelBtn = document.getElementById("parcelSearchPopoverCancelBtn");

  searchBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleParcelSearchPopover();
  });

  closeBtn?.addEventListener("click", () => closeParcelSearchPopover({ clearHighlight: true }));
  cancelBtn?.addEventListener("click", () => closeParcelSearchPopover({ clearHighlight: true }));

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    runLocateParcelFromPopover();
  });

  window.addEventListener("resize", () => {
    if (parcelSearchPopoverOpen) positionParcelSearchPopover();
  });
}

function stopActiveTool() {
  if (activeInteraction) {
    map.removeInteraction(activeInteraction);
    activeInteraction = null;
  }
}

function drawGeometry(layerType) {
  stopActiveTool();
  const draw = new ol.interaction.Draw({ source: editSource, type: "Polygon" });
  draw.on("drawend", async (evt) => {
    const feature = evt.feature;
    editSource.clear(true);
    await saveGeometry(feature, layerType);
  });
  activeInteraction = draw;
  map.addInteraction(draw);
}

async function saveGeometry(feature, layerType) {
  const geojson = new ol.format.GeoJSON().writeFeatureObject(feature, {
    featureProjection: "EPSG:3857",
    dataProjection: "EPSG:4326"
  });

  const blockCode = layerType === "BLOCKS"
    ? prompt("Enter block_code:", "")
    : prompt("Enter parent block_code:", "");
  if (!blockCode) return;

  let parcelNo = null;
  if (layerType === "PARCELS") {
    const no = prompt("Optional parcel number (blank = auto):", "");
    parcelNo = no ? Number(no) : null;
    if (no && !Number.isInteger(parcelNo)) {
      setStatus(statusEl, "Parcel number must be an integer.", true);
      return;
    }
  }

  const { error } = await supabase.rpc("vsl_upsert_geometry", {
    p_layer_type: layerType,
    p_block_code: blockCode,
    p_parcel_no: parcelNo,
    p_geojson: geojson.geometry,
    p_user_id: currentUser.id
  });
  if (error) {
    setStatus(statusEl, `Save failed: ${error.message}`, true);
    return;
  }
  await loadLayersFromDb();
  setStatus(statusEl, `${layerType} saved.`);
}

function startMeasure(type) {
  stopActiveTool();
  editSource.clear(true);
  const draw = new ol.interaction.Draw({ source: editSource, type });
  draw.on("drawend", (evt) => {
    const geom = evt.feature.getGeometry();
    if (type === "LineString") {
      const km = ol.sphere.getLength(geom) / 1000;
      setStatus(statusEl, `Length: ${km.toFixed(3)} km`);
    } else {
      const acres = ol.sphere.getArea(geom) * 0.000247105;
      setStatus(statusEl, `Area: ${acres.toFixed(2)} acres`);
    }
  });
  activeInteraction = draw;
  map.addInteraction(draw);
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
  setupParcelSearchPopover();
  setupParcelStatusPanel();

  drawBlockBtn.addEventListener("click", () => drawGeometry("BLOCKS"));
  drawParcelBtn.addEventListener("click", () => drawGeometry("PARCELS"));
  measureLineBtn.addEventListener("click", () => startMeasure("LineString"));
  measureAreaBtn.addEventListener("click", () => startMeasure("Polygon"));
  stopDrawBtn.addEventListener("click", stopActiveTool);

  locateBtn.addEventListener("click", locateMe);
  printBtn.addEventListener("click", () => window.print());
  fullscreenBtn.addEventListener("click", () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  });
  infoBtn.addEventListener("click", () => {
    setStatus(statusEl, "Click any BLOCK/PARCEL on map to inspect its details.");
  });
  logoutBtn.addEventListener("click", async () => {
    await supabase.auth.signOut();
    window.location.href = "./login.html";
  });
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
        setBasemapByTitle("OpenStreetMap");
        const radio = fallbackLayerSwitcherEl?.querySelector("input[name='fbBasemap'][value='OpenStreetMap']");
        if (radio) radio.checked = true;
        setStatus(statusEl, "Google Hybrid unavailable. Fell back to OpenStreetMap.", true);
      }
    });
  }

  setupInfoPopup();
  bindEvents();
  initSurveyImport({
    map,
    cfg,
    setStatus,
    statusEl,
    loadLayersFromDb,
    getManagementLocked: () => currentProfile?.role === "MANAGMENT",
    blocksSource,
    parcelsSource
  });
  initCoordSearchDrawer({ map, setStatus, statusEl });
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
