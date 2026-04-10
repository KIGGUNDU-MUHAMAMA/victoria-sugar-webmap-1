import { createSupabaseClient, getConfig } from "./supabase-client.js";
import { clearStatus, parseNum, setStatus } from "./utils.js";
import { initSurveyImport } from "./survey-import.js";
import { initCoordSearchDrawer } from "./coord-search-drawer.js";
import { initCoordExtractDrawer } from "./coord-extract-drawer.js";

const supabase = createSupabaseClient();
const cfg = getConfig();

const statusEl = document.getElementById("status");
const panelHost = document.getElementById("panelHost");

const parcelSearchInput = document.getElementById("parcelSearchInput");
const parcelSearchRunBtn = document.getElementById("parcelSearchRunBtn");
const flagNoteInput = document.getElementById("flagNoteInput");
const flagFeatureBtn = document.getElementById("flagFeatureBtn");
const refreshFlagsBtn = document.getElementById("refreshFlagsBtn");
const flagList = document.getElementById("flagList");
const drawBlockBtn = document.getElementById("drawBlockBtn");
const drawParcelBtn = document.getElementById("drawParcelBtn");
const measureLineBtn = document.getElementById("measureLineBtn");
const measureAreaBtn = document.getElementById("measureAreaBtn");
const stopDrawBtn = document.getElementById("stopDrawBtn");
const panelButtons = {
  parcelSearchBtn: "parcelSearchPanel",
  qualityFlagsBtn: "qualityFlagsPanel",
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

const blocksLayer = new ol.layer.Vector({
  title: "BLOCKS",
  visible: true,
  source: blocksSource,
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: "#c62828", width: 2 }),
    fill: new ol.style.Fill({ color: "rgba(0, 0, 0, 0)" })
  })
});

const parcelsLayer = new ol.layer.Vector({
  title: "PARCELS",
  visible: true,
  source: parcelsSource,
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: "#1565c0", width: 2 }),
    fill: new ol.style.Fill({ color: "rgba(21, 101, 192, 0.06)" })
  })
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

function runParcelSearch() {
  const q = parcelSearchInput.value.trim().toLowerCase();
  if (!q) return;
  const allFeatures = [...blocksSource.getFeatures(), ...parcelsSource.getFeatures()];
  const match = allFeatures.find((f) => {
    const p = f.getProperties();
    return [p.block_code, p.block_name, p.estate_name, p.parcel_no, p.parcel_code]
      .map((v) => String(v ?? "").toLowerCase())
      .some((v) => v.includes(q));
  });
  if (!match) {
    setStatus(statusEl, "No result in current loaded extent.", true);
    return;
  }
  map.getView().fit(match.getGeometry().getExtent(), { duration: 350, maxZoom: 18, padding: [40, 40, 40, 40] });
  setStatus(statusEl, "Search result found.");
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

async function submitFlag() {
  if (!selectedFeature || !selectedLayerType) {
    setStatus(statusEl, "Select a BLOCK/PARCEL before flagging.", true);
    return;
  }
  const note = flagNoteInput.value.trim();
  if (!note) {
    setStatus(statusEl, "Flag note is required.", true);
    return;
  }
  const { error } = await supabase.from("vsl_flags").insert({
    layer_type: selectedLayerType,
    target_id: String(selectedFeature.getId() || ""),
    note,
    status: "open",
    created_by: currentUser.id
  });
  if (error) {
    setStatus(statusEl, `Flag submit failed: ${error.message}`, true);
    return;
  }
  flagNoteInput.value = "";
  await refreshFlags();
  setStatus(statusEl, "Flag submitted.");
}

async function refreshFlags() {
  const { data, error } = await supabase
    .from("vsl_flags")
    .select("id, layer_type, target_id, note, status, created_at")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) {
    setStatus(statusEl, `Could not load flags: ${error.message}`, true);
    return;
  }
  flagList.innerHTML = (data || []).map((row) => {
    return `<div class="flag-item"><strong>${row.layer_type}</strong> #${row.target_id}<br>${row.note}</div>`;
  }).join("");
}

function bindEvents() {
  setupPanels();

  parcelSearchRunBtn.addEventListener("click", runParcelSearch);
  flagFeatureBtn.addEventListener("click", submitFlag);
  refreshFlagsBtn.addEventListener("click", refreshFlags);

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
  await refreshFlags();
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
