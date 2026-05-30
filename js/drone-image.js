/**
 * drone-image.js
 * Handles Cloud Optimized GeoTIFF (COG) drone images:
 *  - Local preview using geotiff.js (window.GeoTIFF) before upload
 *  - Upload to Cloudflare Worker
 *  - Save metadata to Supabase vsl_drone_images table
 *  - VIC-GEOTIFF layer group in the OL layer tree
 */

import { PROJ4_DEFS, registerProj4Defs } from "./crs-definitions.js";

const SUPABASE_TABLE  = "vsl_drone_images";
const LAYER_GROUP_TITLE = "VIC-GEOTIFF";

// ── proj4 lazy singleton ──────────────────────────────────────────────────────
let _proj4 = null;
async function getProj4() {
  if (_proj4) return _proj4;
  const mod = await import("https://esm.sh/proj4@2.11.0");
  _proj4 = mod.default;
  registerProj4Defs(_proj4);
  return _proj4;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Transform a bounding box [minX, minY, maxX, maxY] from sourceCrs → EPSG:3857.
 * Falls back to treating the CRS as geographic (lon/lat) if proj4 definition
 * is not available.
 */
async function bboxTo3857(bbox, sourceCrs) {
  const [minX, minY, maxX, maxY] = bbox;
  const proj4 = await getProj4();

  // If the CRS is already Web Mercator, return as-is.
  if (sourceCrs === "EPSG:3857") {
    return [minX, minY, maxX, maxY];
  }

  // If the CRS is geographic WGS84 (or undefined/unknown), use fromLonLat.
  const isGeo = !sourceCrs || sourceCrs === "EPSG:4326" || !PROJ4_DEFS[sourceCrs];
  if (isGeo) {
    const sw = ol.proj.fromLonLat([minX, minY]);
    const ne = ol.proj.fromLonLat([maxX, maxY]);
    return [sw[0], sw[1], ne[0], ne[1]];
  }

  const sw = proj4(sourceCrs, "EPSG:3857", [minX, minY]);
  const ne = proj4(sourceCrs, "EPSG:3857", [maxX, maxY]);
  return [sw[0], sw[1], ne[0], ne[1]];
}

/**
 * Derive the CRS EPSG code from a GeoTIFF image object.
 * Reads EPSG code from GeoKeyDirectory if available; falls back to supplied
 * UI value or "EPSG:4326".
 */
function guessCrsFromImage(image, fallbackCrs) {
  try {
    const fd = image.fileDirectory;
    const gkd = fd?.GeoKeyDirectory;
    if (gkd && gkd.length >= 4) {
      // GeoKeyDirectory: [KeyDirectoryVersion, KeyRevision, MinorRevision, NumberOfKeys,
      //                   key, location, count, value, ...]
      const numKeys = gkd[3];
      for (let i = 0; i < numKeys; i++) {
        const base = 4 + i * 4;
        const keyId = gkd[base];
        // 2048 = GeographicTypeGeoKey, 3072 = ProjectedCSTypeGeoKey
        if (keyId === 3072 || keyId === 2048) {
          const epsg = gkd[base + 3];
          if (Number.isFinite(epsg) && epsg > 0) {
            return `EPSG:${epsg}`;
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return fallbackCrs || "EPSG:4326";
}

// (Canvas rendering removed in favor of lightning-fast vector bounding box preview)

// ── Module entry point ────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {ol.Map}    opts.map
 * @param {object}    opts.supabase    - Supabase client
 * @param {Function}  opts.setStatus   - setStatus(el, msg, isError?)
 * @param {HTMLElement} opts.statusEl  - Global status element (optional)
 * @param {Function}  opts.getBaseGroup - Returns the OL base layer group
 */
export function initDroneImageModule({ map, supabase, setStatus, statusEl, getBaseGroup }) {
  // ── DOM refs ──────────────────────────────────────────────────────────────
  const fileInput      = document.getElementById("droneFileInput");
  const previewBtn     = document.getElementById("dronePreviewBtn");
  const uploadBtn      = document.getElementById("droneUploadBtn");
  const crsSelect      = document.getElementById("droneCrsSelect");
  const uploadStatusEl = document.getElementById("droneUploadStatus");
  const previewCanvas  = document.getElementById("dronePreviewCanvas");

  // ── Module state ──────────────────────────────────────────────────────────
  let currentFile    = null;
  let previewBbox3857 = null;  // [minX, minY, maxX, maxY] in EPSG:3857
  let previewLayer   = null;   // ol.layer.Image placed on the map during preview

  const droneGroup = new ol.layer.Group({
    title: LAYER_GROUP_TITLE,
    type: 'overlay',
    combine: true, // Forces LayerSwitcher to render this group as a single toggleable checkbox even if empty
    fold: "open",
    layers: [],
    visible: false,
    zIndex: 5
  });
  droneGroup.set("displayInLayerSwitcher", true);
  map?.addLayer(droneGroup);
  
  // Explicitly ensure visibility is off to force LayerSwitcher to uncheck it
  droneGroup.setVisible(false);

  // Show/hide group layers when group visibility toggles.
  droneGroup.on("change:visible", () => {
    if (droneGroup.getVisible()) {
      loadSavedDroneImages();
    } else {
      droneGroup.getLayers().clear();
    }
  });

  // ── Status helper (uses module-local span, falls back to global) ───────────
  function showStatus(msg, isError = false) {
    if (uploadStatusEl) {
      uploadStatusEl.textContent = msg;
      uploadStatusEl.style.color = isError ? "#c62828" : "#1b5e20";
    }
    if (statusEl && typeof setStatus === "function") {
      setStatus(statusEl, msg, isError);
    }
  }

  function clearLocalStatus() {
    if (uploadStatusEl) {
      uploadStatusEl.textContent = "";
      uploadStatusEl.style.color = "";
    }
  }

  // ── Toast Notification Helper ───────────────────────────────────────────────
  function showToast(msg, type = "info") {
    let container = document.getElementById("vsl-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.id = "vsl-toast-container";
      Object.assign(container.style, {
        position: "fixed",
        bottom: "20px",
        right: "20px",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        pointerEvents: "none"
      });
      document.body.appendChild(container);
    }
    const toast = document.createElement("div");
    toast.textContent = msg;
    const bg = type === "error" ? "#c62828" : type === "success" ? "#2e7d32" : "#1565c0";
    Object.assign(toast.style, {
      background: bg,
      color: "white",
      padding: "12px 20px",
      borderRadius: "8px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
      fontFamily: "system-ui, sans-serif",
      fontSize: "14px",
      opacity: "0",
      transform: "translateY(20px)",
      transition: "all 0.3s ease"
    });
    container.appendChild(toast);
    
    // animate in
    requestAnimationFrame(() => {
      toast.style.opacity = "1";
      toast.style.transform = "translateY(0)";
    });

    // auto remove after 5s
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(20px)";
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  // ── Disable upload button until a successful preview ──────────────────────
  if (uploadBtn) uploadBtn.disabled = true;

  // ── File input wiring ─────────────────────────────────────────────────────
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    currentFile      = file;
    previewBbox3857  = null;
    if (uploadBtn) uploadBtn.disabled = true;
    clearLocalStatus();
    // Reset canvas
    if (previewCanvas) {
      const ctx = previewCanvas.getContext("2d");
      ctx?.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    }
    // Remove any existing preview layer from the map
    removePreviiewLayer();
  });

  // ── Preview button ────────────────────────────────────────────────────────
  previewBtn?.addEventListener("click", async () => {
    if (!currentFile) {
      showStatus("Select a GeoTIFF file first.", true);
      return;
    }
    if (!window.GeoTIFF) {
      showStatus("GeoTIFF library not loaded. Ensure geotiff.js CDN script is included.", true);
      return;
    }
    showStatus("Reading GeoTIFF…");
    try {
      await previewCOG(currentFile);
      if (uploadBtn) uploadBtn.disabled = false;
      showStatus("Preview ready. Inspect the map, then upload.");
    } catch (err) {
      showStatus(`Preview failed: ${err.message}`, true);
      if (uploadBtn) uploadBtn.disabled = true;
    }
  });

  // ── Upload button ─────────────────────────────────────────────────────────
  uploadBtn?.addEventListener("click", () => {
    if (!currentFile) {
      showStatus("No file selected.", true);
      return;
    }
    const file = currentFile;
    
    // Instantly reset the UI to free up the map and panel
    currentFile = null;
    uploadBtn.disabled = true;
    removePreviiewLayer();
    if (fileInput) fileInput.value = "";
    clearLocalStatus();
    
    // Fire-and-forget background upload
    showToast(`Uploading started/initiated for ${file.name}...`, "info");
    
    uploadToCloudflare(file)
      .then(url => {
        showToast(`Upload complete! Saving metadata for ${file.name}...`, "info");
        return saveMetadataToSupabase(url, file.name);
      })
      .then(() => {
        showToast(`Successfully saved ${file.name}!`, "success");
        if (droneGroup.getVisible()) {
          loadSavedDroneImages();
        }
      })
      .catch(err => {
        showToast(`Failed to upload ${file.name}: ${err.message}`, "error");
        console.error(err);
      });
  });

  // ── COG preview (Instant Bounding Box) ────────────────────────────────────
  async function previewCOG(file) {
    const GeoTIFF = window.GeoTIFF;
    const tiff    = await GeoTIFF.fromBlob(file);

    // Read only the first image metadata (no raster pixels read!)
    const image = await tiff.getImage(0);

    // ── Compute bounding box ──────────────────────────────────────────────
    // getBoundingBox() uses ModelTiepointTag + ModelPixelScaleTag internally.
    const bboxNative = image.getBoundingBox(); // [minX, minY, maxX, maxY] in image CRS

    // Determine source CRS.
    const uiCrs   = crsSelect?.value?.trim() || "";
    const imageCrs = guessCrsFromImage(image, uiCrs || "EPSG:4326");

    previewBbox3857 = await bboxTo3857(bboxNative, imageCrs);

    // Validate the reprojected bbox is within reasonable Web Mercator bounds.
    const [x0, y0, x1, y1] = previewBbox3857;
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
      throw new Error("Could not reproject bounding box to EPSG:3857. Check the CRS selection.");
    }

    // ── Place a Vector polygon layer on the map ───────────────────────────
    removePreviiewLayer();

    if (map) {
      const polygon = ol.geom.Polygon.fromExtent(previewBbox3857);
      const feature = new ol.Feature(polygon);
      
      const vectorSource = new ol.source.Vector({
        features: [feature]
      });

      previewLayer = new ol.layer.Vector({
        title: `Preview: ${file.name}`,
        source: vectorSource,
        style: new ol.style.Style({
          stroke: new ol.style.Stroke({
            color: '#1565c0', // Bright blue border
            width: 3,
            lineDash: [10, 10]
          }),
          fill: new ol.style.Fill({
            color: 'rgba(21, 101, 192, 0.15)' // Light blue transparent fill
          })
        }),
        zIndex: 500
      });
      
      previewLayer.set("displayInLayerSwitcher", false);
      map.addLayer(previewLayer);
      
      // Fit the view to the image extent.
      map.getView().fit(previewBbox3857, { padding: [60, 60, 60, 60], maxZoom: 18, duration: 400 });
    }
  }

  function removePreviiewLayer() {
    if (previewLayer && map) {
      map.removeLayer(previewLayer);
      previewLayer = null;
    }
  }

  // ── Upload to Cloudflare Storage (R2) ───────────────────────────────────
  async function uploadToCloudflare(file) {
    const workerUrl = "https://victoria-sugar-images.kiggundumuhamad.workers.dev";

    // Generate a unique filename to prevent collisions
    const fileExt = file.name.split('.').pop();
    const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${fileExt}`;

    // Clean up worker URL to ensure no double slashes before adding filename
    const baseUrl = workerUrl.replace(/\/$/, "");
    const uploadUrl = `${baseUrl}/${fileName}`;

    // Upload using PUT directly with the file body stream
    const res = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        // Pass the content type so the worker sets it in R2 correctly
        "Content-Type": file.type || "image/tiff"
      },
      body: file
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Cloudflare worker failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const json = await res.json().catch(() => ({}));
    const url = json?.url || json?.publicUrl;
    
    if (!url) {
      throw new Error("Worker succeeded but returned no public URL.");
    }
    
    return url;
  }

  // ── Save metadata to Supabase ─────────────────────────────────────────────
  async function saveMetadataToSupabase(url, name) {
    if (!supabase) throw new Error("Supabase client not available.");
    const { error } = await supabase
      .from(SUPABASE_TABLE)
      .insert({ url, name });
    if (error) throw new Error(error.message || "Supabase insert failed.");
  }

  // ── Load saved drone images into the layer group ──────────────────────────
  async function loadSavedDroneImages() {
    if (!supabase) return;
    droneGroup.getLayers().clear();
    try {
      const { data, error } = await supabase
        .from(SUPABASE_TABLE)
        .select("url, name, uploaded_at")
        .order("uploaded_at", { ascending: false });
      if (error) throw new Error(error.message);
      if (!data?.length) return;

      for (const row of data) {
        const layer = buildStaticLayerFromUrl(row.url, row.name);
        if (layer) droneGroup.getLayers().push(layer);
      }
    } catch (err) {
      showStatus(`Could not load drone images: ${err.message}`, true);
    }
  }

  /**
   * Build an ol.layer.Image from a remote GeoTIFF URL.
   * For saved images we cannot re-read the GeoTIFF metadata from a plain URL
   * without an additional Range request, so we use a TileWMS/XYZ proxy or,
   * most simply, try to fetch the image's bbox via a HEAD-level geotiff read.
   *
   * Practical approach: use geotiff.js fromUrl() to fetch metadata only
   * (COGs support HTTP Range requests), then render the overview.
   */
  function buildStaticLayerFromUrl(url, name) {
    if (!url) return null;

    // Create a placeholder layer; load asynchronously.
    const source = new ol.source.ImageStatic({
      url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      imageExtent: ol.proj.get("EPSG:3857").getExtent()
    });
    const layer = new ol.layer.Image({
      title: name || url.split("/").pop(),
      source,
      opacity: 0.85
    });
    layer.set("displayInLayerSwitcher", true);

    // Async: read COG headers and replace source with actual imagery.
    (async () => {
      try {
        if (!window.GeoTIFF) return;
        const tiff    = await window.GeoTIFF.fromUrl(url);
        const imgCount = await tiff.getImageCount();
        const image   = await tiff.getImage(Math.max(0, imgCount - 1));
        const bboxNative = image.getBoundingBox();
        const imageCrs   = guessCrsFromImage(image, "EPSG:4326");
        const bbox3857   = await bboxTo3857(bboxNative, imageCrs);
        const [x0, y0, x1, y1] = bbox3857;
        if (!Number.isFinite(x0)) return;

        const width  = image.getWidth();
        const height = image.getHeight();
        const sp     = image.getSamplesPerPixel();
        let rgb;
        const noData = image.fileDirectory?.GDAL_NODATA
          ? Number(image.fileDirectory.GDAL_NODATA)
          : undefined;

        if (sp >= 3) {
          rgb = await image.readRasters({ samples: [0, 1, 2], interleave: true });
        } else {
          const gray = await image.readRasters({ samples: [0], interleave: true });
          rgb = new Uint8Array(width * height * 3);
          for (let i = 0; i < width * height; i++) {
            rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = gray[i];
          }
        }

        const offscreen = document.createElement("canvas");
        renderRgbToCanvas(offscreen, rgb, width, height, noData);
        const dataUrl = offscreen.toDataURL("image/png");

        const newSource = new ol.source.ImageStatic({
          url: dataUrl,
          imageExtent: bbox3857,
          projection: "EPSG:3857"
        });
        layer.setSource(newSource);
      } catch {
        // Silent — layer stays as placeholder; user can remove it manually.
      }
    })();

    return layer;
  }

  // ── Public API ────────────────────────────────────────────────────────────
  return {
    getDroneLayer: () => droneGroup
  };
}
