/**
 * drone-image.js
 * Handles Cloud Optimized GeoTIFF (COG) drone images:
 *  - Local preview using geotiff.js (window.GeoTIFF) before upload
 *  - Upload to Cloudflare Worker
 *  - Save metadata to Supabase vsl_drone_images table
 *  - VIC-GEOTIFF layer group in the OL layer tree
 */

import { PROJ4_DEFS, registerProj4Defs } from "./crs-definitions.js";

const UPLOAD_ENDPOINT = "https://nlis-image-upload.kiggundumuhamad.workers.dev/";
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

/**
 * Draw interleaved RGB raster data onto a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {TypedArray} rgb  - Interleaved R,G,B values (length = w*h*3)
 * @param {number} width
 * @param {number} height
 * @param {number} noDataValue - Optional no-data value (treated as transparent)
 */
function renderRgbToCanvas(canvas, rgb, width, height, noDataValue) {
  canvas.width  = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(width, height);
  const data = img.data;

  // Determine per-band stretch (2 %–98 % percentile) for display quality.
  // Simple min/max is good enough for a thumbnail.
  let rMin = Infinity, rMax = -Infinity;
  let gMin = Infinity, gMax = -Infinity;
  let bMin = Infinity, bMax = -Infinity;
  const len = width * height;
  for (let i = 0; i < len; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    if (noDataValue !== undefined && r === noDataValue) continue;
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
  }
  // Avoid division by zero on uniform images.
  const rRange = rMax - rMin || 1;
  const gRange = gMax - gMin || 1;
  const bRange = bMax - bMin || 1;

  for (let i = 0; i < len; i++) {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    const isNoData = noDataValue !== undefined && r === noDataValue;
    data[i * 4]     = isNoData ? 0 : Math.round(((r - rMin) / rRange) * 255);
    data[i * 4 + 1] = isNoData ? 0 : Math.round(((g - gMin) / gRange) * 255);
    data[i * 4 + 2] = isNoData ? 0 : Math.round(((b - bMin) / bRange) * 255);
    data[i * 4 + 3] = isNoData ? 0 : 255;
  }
  ctx.putImageData(img, 0, 0);
}

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

  // ── OL layer group for saved drone images ─────────────────────────────────
  const droneGroup = new ol.layer.Group({
    title: LAYER_GROUP_TITLE,
    fold: "open",
    layers: [],
    visible: false,
    zIndex: 5
  });
  droneGroup.set("displayInLayerSwitcher", true);
  map?.addLayer(droneGroup);

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
  uploadBtn?.addEventListener("click", async () => {
    if (!currentFile) {
      showStatus("No file selected.", true);
      return;
    }
    uploadBtn.disabled = true;
    showStatus("Uploading…");
    try {
      const url = await uploadToCloudflare(currentFile);
      showStatus("Upload complete. Saving metadata…");
      await saveMetadataToSupabase(url, currentFile.name);
      showStatus(`Saved: ${currentFile.name}`);
      // Reload saved images into the layer group if it is visible
      if (droneGroup.getVisible()) {
        await loadSavedDroneImages();
      }
    } catch (err) {
      showStatus(`Upload failed: ${err.message}`, true);
      uploadBtn.disabled = false;
    }
  });

  // ── COG preview ───────────────────────────────────────────────────────────
  async function previewCOG(file) {
    const GeoTIFF = window.GeoTIFF;
    const tiff    = await GeoTIFF.fromBlob(file);

    // Use lowest resolution overview for a fast thumbnail.
    const imageCount = await tiff.getImageCount();
    const overviewIdx = Math.max(0, imageCount - 1); // last = smallest overview
    const image = await tiff.getImage(overviewIdx);

    const width  = image.getWidth();
    const height = image.getHeight();
    const samplesPerPixel = image.getSamplesPerPixel();

    // Read raster: we need at least 3 bands for RGB.
    let rgb;
    const noDataValue = image.fileDirectory?.GDAL_NODATA
      ? Number(image.fileDirectory.GDAL_NODATA)
      : undefined;

    if (samplesPerPixel >= 3) {
      // Request bands 0, 1, 2 (R, G, B)
      rgb = await image.readRasters({ samples: [0, 1, 2], interleave: true });
    } else if (samplesPerPixel === 1) {
      // Grayscale — duplicate the band to all three channels.
      const gray = await image.readRasters({ samples: [0], interleave: true });
      rgb = new Uint8Array(width * height * 3);
      for (let i = 0; i < width * height; i++) {
        rgb[i * 3]     = gray[i];
        rgb[i * 3 + 1] = gray[i];
        rgb[i * 3 + 2] = gray[i];
      }
    } else {
      throw new Error(`Unsupported band count: ${samplesPerPixel}`);
    }

    // Render thumbnail to the canvas element.
    if (previewCanvas) {
      renderRgbToCanvas(previewCanvas, rgb, width, height, noDataValue);
    }

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

    // ── Place an ImageStatic layer on the map ─────────────────────────────
    removePreviiewLayer();

    // Export the canvas as a data URL for ol.source.ImageStatic.
    const dataUrl = previewCanvas
      ? previewCanvas.toDataURL("image/png")
      : null;

    if (dataUrl && map) {
      const imageSource = new ol.source.ImageStatic({
        url: dataUrl,
        imageExtent: previewBbox3857,
        projection: "EPSG:3857"
      });
      previewLayer = new ol.layer.Image({
        title: `Preview: ${file.name}`,
        source: imageSource,
        opacity: 0.85
      });
      previewLayer.set("displayInLayerSwitcher", false);
      previewLayer.setZIndex(500);
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

  // ── Upload to Cloudflare ──────────────────────────────────────────────────
  async function uploadToCloudflare(file) {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(UPLOAD_ENDPOINT, {
      method: "POST",
      body: formData
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Worker responded ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json();
    // Accept { url } or { publicUrl } or { result: { variants: [...] } } (Cloudflare Images)
    const url =
      json?.url ||
      json?.publicUrl ||
      json?.result?.variants?.[0] ||
      null;
    if (!url) {
      throw new Error("Upload succeeded but no URL returned: " + JSON.stringify(json).slice(0, 300));
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
