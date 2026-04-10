import { createSupabaseClient, getConfig } from "./supabase-client.js";
import { clearStatus, parseNum, setStatus } from "./utils.js";
import { importAttributesCsv } from "./importer.js";

const supabase = createSupabaseClient();
const cfg = getConfig();

const statusEl = document.getElementById("status");
const currentUserEl = document.getElementById("currentUser");

const basemapSelect = document.getElementById("basemapSelect");
const toggleBlocks = document.getElementById("toggleBlocks");
const toggleParcels = document.getElementById("toggleParcels");

const searchInput = document.getElementById("parcelSearchInput");
const searchBtn = document.getElementById("parcelSearchBtn");
const coordLon = document.getElementById("coordLon");
const coordLat = document.getElementById("coordLat");
const coordSearchBtn = document.getElementById("coordSearchBtn");

const drawBlockBtn = document.getElementById("drawBlockBtn");
const drawParcelBtn = document.getElementById("drawParcelBtn");
const measureLineBtn = document.getElementById("measureLineBtn");
const measureAreaBtn = document.getElementById("measureAreaBtn");
const stopDrawBtn = document.getElementById("stopDrawBtn");

const extractCoordsBtn = document.getElementById("extractCoordsBtn");
const coordsOutput = document.getElementById("coordsOutput");
const flagNoteInput = document.getElementById("flagNoteInput");
const flagFeatureBtn = document.getElementById("flagFeatureBtn");

const csvInput = document.getElementById("csvInput");
const importCsvBtn = document.getElementById("importCsvBtn");

const locateBtn = document.getElementById("locateBtn");
const infoBtn = document.getElementById("infoBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const printBtn = document.getElementById("printBtn");
const logoutBtn = document.getElementById("logoutBtn");

const baseLayers = new Map();
let map;
let activeInteraction = null;
let selectedFeature = null;
let selectedLayerType = null;
let currentUser;
let currentProfile;

const blocksSource = new ol.source.Vector();
const parcelsSource = new ol.source.Vector();
const drawSource = new ol.source.Vector();

const blocksLayer = new ol.layer.Vector({
  source: blocksSource,
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: "#3474c6", width: 2 }),
    fill: new ol.style.Fill({ color: "rgba(52, 116, 198, 0.2)" })
  })
});

const parcelsLayer = new ol.layer.Vector({
  source: parcelsSource,
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: "#3d9656", width: 2 }),
    fill: new ol.style.Fill({ color: "rgba(61, 150, 86, 0.2)" })
  })
});

const measureLayer = new ol.layer.Vector({
  source: drawSource,
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: "#8d6a3a", width: 2, lineDash: [6, 4] }),
    fill: new ol.style.Fill({ color: "rgba(141, 106, 58, 0.15)" })
  })
});

function createBaseLayers() {
  const layers = [
    ["OpenStreetMap", new ol.layer.Tile({ source: new ol.source.OSM(), visible: true })],
    ["Esri Satellite", new ol.layer.Tile({
      source: new ol.source.XYZ({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
      }),
      visible: false
    })],
    ["Esri Topographic", new ol.layer.Tile({
      source: new ol.source.XYZ({
        url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"
      }),
      visible: false
    })],
    ["OpenTopoMap", new ol.layer.Tile({
      source: new ol.source.XYZ({
        url: "https://tile.opentopomap.org/{z}/{x}/{y}.png"
      }),
      visible: false
    })],
    ["Carto Light", new ol.layer.Tile({
      source: new ol.source.XYZ({
        url: "https://{a-d}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png"
      }),
      visible: false
    })]
  ];
  for (const [name, layer] of layers) {
    baseLayers.set(name, layer);
  }
}

function populateBasemapSelect() {
  for (const name of baseLayers.keys()) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    basemapSelect.appendChild(option);
  }
}

function switchBasemap(name) {
  for (const [n, layer] of baseLayers.entries()) {
    layer.setVisible(n === name);
  }
}

function setupPopup() {
  const container = document.createElement("div");
  container.className = "map-popup";
  const overlay = new ol.Overlay({
    element: container,
    offset: [8, 8],
    positioning: "bottom-left"
  });
  map.addOverlay(overlay);

  map.on("singleclick", (evt) => {
    selectedFeature = null;
    selectedLayerType = null;
    container.innerHTML = "";
    overlay.setPosition(undefined);

    map.forEachFeatureAtPixel(evt.pixel, (feature, layer) => {
      selectedFeature = feature;
      selectedLayerType = layer === blocksLayer ? "BLOCKS" : (layer === parcelsLayer ? "PARCELS" : null);
      const props = feature.getProperties();
      const rows = Object.entries(props)
        .filter(([key]) => !["geometry", "_layer_type"].includes(key))
        .slice(0, 8)
        .map(([key, value]) => `<div><strong>${key}:</strong> ${String(value ?? "")}</div>`)
        .join("");
      container.innerHTML = `
        <div><strong>${selectedLayerType || "Feature"}</strong></div>
        ${rows}
      `;
      overlay.setPosition(evt.coordinate);
      return true;
    }, { layerFilter: (layer) => layer === blocksLayer || layer === parcelsLayer });
  });
}

function toGeoJsonFeature(feature, layerType) {
  const format = new ol.format.GeoJSON();
  const geo = format.writeFeatureObject(feature, {
    dataProjection: "EPSG:4326",
    featureProjection: "EPSG:3857"
  });
  geo.properties = {
    ...(feature.getProperties() || {}),
    _layer_type: layerType
  };
  delete geo.properties.geometry;
  return geo;
}

async function loadLayersFromDb() {
  clearStatus(statusEl);
  const extent = map.getView().calculateExtent(map.getSize());
  const [minX, minY, maxX, maxY] = ol.proj.transformExtent(extent, "EPSG:3857", "EPSG:4326");

  const { data, error } = await supabase.rpc("vsl_get_features_bbox", {
    p_min_lon: minX,
    p_min_lat: minY,
    p_max_lon: maxX,
    p_max_lat: maxY
  });

  if (error) {
    setStatus(statusEl, `Failed loading layers: ${error.message}`, true);
    return;
  }

  blocksSource.clear(true);
  parcelsSource.clear(true);

  const format = new ol.format.GeoJSON();
  for (const row of data || []) {
    if (!row?.geojson) continue;
    const feature = format.readFeature(row.geojson, {
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:3857"
    });
    feature.setProperties(row.properties || {}, true);
    feature.setId(row.feature_id);
    if (row.layer_type === "BLOCKS") {
      blocksSource.addFeature(feature);
    } else if (row.layer_type === "PARCELS") {
      parcelsSource.addFeature(feature);
    }
  }
}

async function saveGeometry(feature, layerType) {
  const featureGeo = toGeoJsonFeature(feature, layerType);

  const defaultBlockCode = layerType === "BLOCKS"
    ? prompt("Enter block_code (required):", "")
    : prompt("Enter parent block_code for parcel:", "");
  if (!defaultBlockCode) {
    setStatus(statusEl, "Save cancelled: block_code is required.", true);
    return;
  }

  let parcelNo = null;
  if (layerType === "PARCELS") {
    const maybeNo = prompt("Optional parcel_no (leave blank for auto-number):", "");
    parcelNo = maybeNo ? Number(maybeNo) : null;
    if (maybeNo && !Number.isInteger(parcelNo)) {
      setStatus(statusEl, "Parcel number must be an integer.", true);
      return;
    }
  }

  const { error } = await supabase.rpc("vsl_upsert_geometry", {
    p_layer_type: layerType,
    p_block_code: defaultBlockCode,
    p_parcel_no: parcelNo,
    p_geojson: featureGeo.geometry,
    p_user_id: currentUser.id
  });
  if (error) {
    setStatus(statusEl, `Save failed: ${error.message}`, true);
    return;
  }
  setStatus(statusEl, `${layerType} geometry saved.`);
  await loadLayersFromDb();
}

function stopCurrentInteraction() {
  if (activeInteraction) {
    map.removeInteraction(activeInteraction);
    activeInteraction = null;
  }
}

function drawGeometry(type, targetLayerType) {
  stopCurrentInteraction();
  const draw = new ol.interaction.Draw({
    source: drawSource,
    type
  });
  draw.on("drawend", async (evt) => {
    drawSource.clear();
    await saveGeometry(evt.feature, targetLayerType);
  });
  activeInteraction = draw;
  map.addInteraction(draw);
}

function startMeasure(type) {
  stopCurrentInteraction();
  drawSource.clear();
  const draw = new ol.interaction.Draw({
    source: drawSource,
    type
  });
  draw.on("drawend", (evt) => {
    const geom = evt.feature.getGeometry();
    if (type === "LineString") {
      const lengthMeters = ol.sphere.getLength(geom);
      setStatus(statusEl, `Measured length: ${(lengthMeters / 1000).toFixed(3)} km`);
    } else {
      const areaSqm = ol.sphere.getArea(geom);
      const acres = areaSqm * 0.000247105;
      setStatus(statusEl, `Measured area: ${acres.toFixed(2)} acres`);
    }
  });
  activeInteraction = draw;
  map.addInteraction(draw);
}

function extractCoords() {
  if (!selectedFeature) {
    setStatus(statusEl, "Select a block or parcel first.", true);
    return;
  }
  const geom = selectedFeature.getGeometry();
  const format = new ol.format.GeoJSON();
  const geo = format.writeGeometryObject(geom, {
    featureProjection: "EPSG:3857",
    dataProjection: "EPSG:4326"
  });
  coordsOutput.value = JSON.stringify(geo.coordinates, null, 2);
  setStatus(statusEl, "Coordinates extracted.");
}

async function submitFlag() {
  if (!selectedFeature || !selectedLayerType) {
    setStatus(statusEl, "Select BLOCKS or PARCELS feature first.", true);
    return;
  }
  const note = flagNoteInput.value.trim();
  if (!note) {
    setStatus(statusEl, "Enter flag note.", true);
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
    setStatus(statusEl, `Flag failed: ${error.message}`, true);
    return;
  }
  flagNoteInput.value = "";
  setStatus(statusEl, "Flag submitted.");
}

function searchFeature() {
  const q = searchInput.value.trim().toLowerCase();
  if (!q) return;
  const feature = [...blocksSource.getFeatures(), ...parcelsSource.getFeatures()].find((f) => {
    const p = f.getProperties();
    return [p.block_code, p.block_name, p.estate_name, p.parcel_no]
      .map((v) => String(v ?? "").toLowerCase())
      .some((v) => v.includes(q));
  });
  if (!feature) {
    setStatus(statusEl, "No matching block/parcel in current extent.", true);
    return;
  }
  const extent = feature.getGeometry().getExtent();
  map.getView().fit(extent, { duration: 450, maxZoom: 17, padding: [60, 60, 60, 60] });
  setStatus(statusEl, "Search result found.");
}

function coordinateSearch() {
  const lon = parseNum(coordLon.value);
  const lat = parseNum(coordLat.value);
  if (lon === null || lat === null) {
    setStatus(statusEl, "Longitude/Latitude required.", true);
    return;
  }
  const coord = ol.proj.fromLonLat([lon, lat]);
  map.getView().animate({ center: coord, zoom: 16, duration: 400 });
}

function locateMe() {
  if (!navigator.geolocation) {
    setStatus(statusEl, "Geolocation not supported.", true);
    return;
  }
  navigator.geolocation.getCurrentPosition((pos) => {
    const coord = ol.proj.fromLonLat([pos.coords.longitude, pos.coords.latitude]);
    map.getView().animate({ center: coord, zoom: 16, duration: 450 });
    setStatus(statusEl, "Location centered.");
  }, (err) => setStatus(statusEl, err.message, true), {
    enableHighAccuracy: true,
    timeout: 8000
  });
}

function bindUi() {
  basemapSelect.addEventListener("change", () => switchBasemap(basemapSelect.value));
  toggleBlocks.addEventListener("change", () => blocksLayer.setVisible(toggleBlocks.checked));
  toggleParcels.addEventListener("change", () => parcelsLayer.setVisible(toggleParcels.checked));

  drawBlockBtn.addEventListener("click", () => drawGeometry("Polygon", "BLOCKS"));
  drawParcelBtn.addEventListener("click", () => drawGeometry("Polygon", "PARCELS"));
  measureLineBtn.addEventListener("click", () => startMeasure("LineString"));
  measureAreaBtn.addEventListener("click", () => startMeasure("Polygon"));
  stopDrawBtn.addEventListener("click", stopCurrentInteraction);

  searchBtn.addEventListener("click", searchFeature);
  coordSearchBtn.addEventListener("click", coordinateSearch);
  extractCoordsBtn.addEventListener("click", extractCoords);
  flagFeatureBtn.addEventListener("click", submitFlag);
  locateBtn.addEventListener("click", locateMe);
  printBtn.addEventListener("click", () => window.print());
  infoBtn.addEventListener("click", () => {
    setStatus(
      statusEl,
      "Use click for info, draw for geometry capture, search for block/parcel, and flags for issue tracking."
    );
  });
  fullscreenBtn.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  });
  logoutBtn.addEventListener("click", async () => {
    await supabase.auth.signOut();
    window.location.href = "./login.html";
  });
  importCsvBtn.addEventListener("click", async () => {
    if (!csvInput.files?.[0]) {
      setStatus(statusEl, "Select CSV file first.", true);
      return;
    }
    try {
      const result = await importAttributesCsv({
        supabase,
        file: csvInput.files[0],
        currentUserId: currentUser.id
      });
      setStatus(statusEl, `CSV imported. Batch #${result.batchId}, rows: ${result.rowCount}`);
      await loadLayersFromDb();
    } catch (err) {
      setStatus(statusEl, err.message, true);
    }
  });
}

function applyRoleUi() {
  const role = currentProfile.role;
  currentUserEl.textContent = `${currentUser.email} | ${role}`;
  if (role === "MANAGMENT") {
    drawBlockBtn.disabled = true;
    drawParcelBtn.disabled = true;
    measureLineBtn.disabled = true;
    measureAreaBtn.disabled = true;
    stopDrawBtn.disabled = true;
    importCsvBtn.disabled = true;
  }
}

async function initUser() {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.user) {
    window.location.href = "./login.html";
    return false;
  }
  currentUser = data.session.user;
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
  return true;
}

async function initMap() {
  createBaseLayers();
  populateBasemapSelect();

  const center = ol.proj.fromLonLat(cfg.DEFAULT_CENTER || [32.59, 0.35]);
  map = new ol.Map({
    target: "map",
    layers: [
      ...baseLayers.values(),
      blocksLayer,
      parcelsLayer,
      measureLayer
    ],
    view: new ol.View({
      center,
      zoom: cfg.DEFAULT_ZOOM || 11
    }),
    controls: ol.control.defaults().extend([
      new ol.control.FullScreen()
    ])
  });

  setupPopup();
  bindUi();
  applyRoleUi();
  await loadLayersFromDb();
  map.on("moveend", loadLayersFromDb);
}

async function start() {
  try {
    const ok = await initUser();
    if (!ok) return;
    await initMap();
  } catch (err) {
    setStatus(statusEl, err.message, true);
  }
}

start();
