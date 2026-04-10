import { CRS_OPTIONS, registerProj4Defs, toMap3857FromCrs } from "./crs-definitions.js";

function isValidLonLat(lon, lat) {
  return Number.isFinite(lon) && Number.isFinite(lat) && lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}

function normalizeCoordRow(row) {
  const lower = {};
  for (const [k, v] of Object.entries(row)) {
    lower[String(k).toLowerCase().trim()] = v;
  }
  const east = Number(
    lower.eastings ?? lower.easting ?? lower.e ?? lower.x ?? lower.east
  );
  const north = Number(
    lower.northings ?? lower.northing ?? lower.n ?? lower.y ?? lower.north
  );
  const label = String(
    lower.point_id ?? lower.pointid ?? lower.id ?? lower.label ?? lower.name ?? ""
  ).trim();
  if (!Number.isFinite(east) || !Number.isFinite(north)) return null;
  return { east, north, label };
}

export function initCoordSearchDrawer({ map, setStatus, statusEl, onDrawerOpen, onDrawerClose }) {
  const drawer = document.getElementById("coordSearchDrawer");
  const toggleBtn = document.getElementById("coordSearchBtn");
  const closeBtn = document.getElementById("coordSearchCloseBtn");
  const crsSelect = document.getElementById("coordDrawerCrsSelect");
  const modeSingle = document.getElementById("coordModeSingle");
  const modeCsv = document.getElementById("coordModeCsv");
  const singleBlock = document.getElementById("coordSingleBlock");
  const csvBlock = document.getElementById("coordCsvBlock");
  const eastInput = document.getElementById("coordDrawerEasting");
  const northInput = document.getElementById("coordDrawerNorthing");
  const plotSingleBtn = document.getElementById("coordPlotSingleBtn");
  const csvInput = document.getElementById("coordDrawerCsvInput");
  const csvDropzone = document.getElementById("coordCsvDropzone");
  const plotCsvBtn = document.getElementById("coordPlotCsvBtn");
  const clearBtn = document.getElementById("coordClearMarkersBtn");

  if (!drawer || !toggleBtn) return;

  CRS_OPTIONS.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    crsSelect?.appendChild(opt);
  });
  if (crsSelect) crsSelect.value = "EPSG:32636";

  const markersSource = new ol.source.Vector();
  const markersLayer = new ol.layer.Vector({
    source: markersSource,
    zIndex: 950,
    style: (feature) => {
      const label = feature.get("label") || "";
      return new ol.style.Style({
        image: new ol.style.Circle({
          radius: 7,
          fill: new ol.style.Fill({ color: "rgba(196, 30, 90, 0.85)" }),
          stroke: new ol.style.Stroke({ color: "#fff", width: 2 })
        }),
        text: label
          ? new ol.style.Text({
            text: label,
            offsetY: -14,
            font: "600 11px Inter, sans-serif",
            fill: new ol.style.Fill({ color: "#1d2a1d" }),
            stroke: new ol.style.Stroke({ color: "#fff", width: 3 })
          })
          : undefined
      });
    }
  });
  markersLayer.set("displayInLayerSwitcher", false);
  markersLayer.set("title", "Coordinate markers");
  map.addLayer(markersLayer);

  let proj4lib = null;

  async function ensureProj4() {
    if (proj4lib) return proj4lib;
    const mod = await import("https://esm.sh/proj4@2.11.0");
    proj4lib = mod.default;
    registerProj4Defs(proj4lib);
    return proj4lib;
  }

  function closeDrawer() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    toggleBtn.classList.remove("active");
    onDrawerClose?.();
  }

  function openDrawer() {
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    toggleBtn.classList.add("active");
    onDrawerOpen?.();
  }

  function updateModeUi() {
    const csv = modeCsv?.checked;
    if (singleBlock) singleBlock.hidden = csv;
    if (csvBlock) csvBlock.hidden = !csv;
  }

  modeSingle?.addEventListener("change", updateModeUi);
  modeCsv?.addEventListener("change", updateModeUi);
  updateModeUi();

  toggleBtn.addEventListener("click", () => {
    if (drawer.classList.contains("open")) {
      closeDrawer();
    } else {
      window.dispatchEvent(new CustomEvent("vsl-force-close-extract-drawer"));
      document.getElementById("surveyDrawer")?.classList.remove("open");
      document.getElementById("surveyPanelBtn")?.classList.remove("active");
      openDrawer();
    }
  });

  closeBtn?.addEventListener("click", closeDrawer);

  document.getElementById("coordSearchOpenExtractBtn")?.addEventListener("click", () => {
    closeDrawer();
    toggleBtn.classList.remove("active");
    window.dispatchEvent(new CustomEvent("vsl-open-extract-drawer"));
  });

  function fitToMarkers() {
    const extent = markersSource.getExtent();
    if (!extent || !extent.every(Number.isFinite)) return;
    if (ol.extent.getWidth(extent) === 0 && ol.extent.getHeight(extent) === 0) {
      const f = markersSource.getFeatures()[0];
      if (f) {
        map.getView().animate({
          center: f.getGeometry().getCoordinates(),
          zoom: 17,
          duration: 400
        });
      }
      return;
    }
    map.getView().fit(extent, { padding: [100, 100, 100, 100], maxZoom: 18, duration: 450 });
  }

  plotSingleBtn?.addEventListener("click", async () => {
    const crs = crsSelect?.value;
    const east = parseFloat(String(eastInput?.value ?? "").replace(/,/g, ""));
    const north = parseFloat(String(northInput?.value ?? "").replace(/,/g, ""));
    if (!crs || !Number.isFinite(east) || !Number.isFinite(north)) {
      setStatus(statusEl, "Choose CRS and enter valid easting and northing.", true);
      return;
    }
    try {
      await ensureProj4();
      const coord3857 = toMap3857FromCrs(crs, east, north);
      const [lon, lat] = ol.proj.transform(coord3857, "EPSG:3857", "EPSG:4326");
      if (!isValidLonLat(lon, lat)) {
        setStatus(statusEl, `Resulting lon/lat out of range: ${lon}, ${lat}. Check CRS vs values.`, true);
        return;
      }
      const pt = new ol.Feature({
        geometry: new ol.geom.Point(coord3857)
      });
      pt.set("label", `${east.toFixed(2)}, ${north.toFixed(2)}`);
      markersSource.addFeature(pt);
      map.getView().animate({ center: coord3857, zoom: 17, duration: 450 });
      setStatus(
        statusEl,
        `Plotted WGS84 ${lon.toFixed(6)}, ${lat.toFixed(6)} (from ${crs}).`
      );
    } catch (e) {
      setStatus(statusEl, e.message || "Transform failed", true);
    }
  });

  async function parseCsvFile(file) {
    return new Promise((resolve, reject) => {
      if (!window.Papa?.parse) {
        reject(new Error("PapaParse is not loaded."));
        return;
      }
      window.Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (r) => resolve(r.data || []),
        error: reject
      });
    });
  }

  plotCsvBtn?.addEventListener("click", async () => {
    const crs = crsSelect?.value;
    const file = csvInput?.files?.[0];
    if (!crs || !file) {
      setStatus(statusEl, "Choose CRS and a CSV file.", true);
      return;
    }
    try {
      await ensureProj4();
      const rows = await parseCsvFile(file);
      let ok = 0;
      let skipped = 0;
      for (const row of rows) {
        const n = normalizeCoordRow(row);
        if (!n) {
          skipped++;
          continue;
        }
        try {
          const coord3857 = toMap3857FromCrs(crs, n.east, n.north);
          const [lon, lat] = ol.proj.transform(coord3857, "EPSG:3857", "EPSG:4326");
          if (!isValidLonLat(lon, lat)) {
            skipped++;
            continue;
          }
          const pt = new ol.Feature({
            geometry: new ol.geom.Point(coord3857)
          });
          pt.set("label", n.label || String(ok + 1));
          markersSource.addFeature(pt);
          ok++;
        } catch {
          skipped++;
        }
      }
      if (!ok) {
        setStatus(
          statusEl,
          "No valid points. CSV needs columns eastings & northings (or easting/northing).",
          true
        );
        return;
      }
      fitToMarkers();
      setStatus(statusEl, `Plotted ${ok} point(s).${skipped ? ` Skipped ${skipped} row(s).` : ""}`);
    } catch (e) {
      setStatus(statusEl, e.message || "CSV failed", true);
    }
  });

  csvDropzone?.addEventListener("dragover", (e) => {
    e.preventDefault();
    csvDropzone.classList.add("dragover");
  });
  csvDropzone?.addEventListener("dragleave", () => csvDropzone.classList.remove("dragover"));
  csvDropzone?.addEventListener("drop", (e) => {
    e.preventDefault();
    csvDropzone.classList.remove("dragover");
    const f = e.dataTransfer?.files?.[0];
    if (f && (f.name.endsWith(".csv") || f.type === "text/csv")) {
      const dt = new DataTransfer();
      dt.items.add(f);
      if (csvInput) csvInput.files = dt.files;
      setStatus(statusEl, `Loaded file: ${f.name}. Click “Plot CSV points”.`);
    }
  });

  clearBtn?.addEventListener("click", () => {
    markersSource.clear(true);
    setStatus(statusEl, "Coordinate markers cleared.");
  });

  return { closeDrawer, markersSource };
}
