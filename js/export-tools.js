/**
 * export-tools.js
 * Handles exporting parcels/blocks to DXF, CSV, KML, or GeoJSON
 * in a user-selected CRS.
 */

import { CRS_OPTIONS, PROJ4_DEFS, registerProj4Defs } from "./crs-definitions.js";

// ── proj4 lazy singleton ──────────────────────────────────────────────────────
let _proj4 = null;
async function getProj4() {
  if (_proj4) return _proj4;
  const mod = await import("https://esm.sh/proj4@2.11.0");
  _proj4 = mod.default;
  registerProj4Defs(_proj4);
  return _proj4;
}

// ── Coordinate reprojection ───────────────────────────────────────────────────

/**
 * Reproject a single [x, y] coordinate from EPSG:3857 to targetCrs.
 * @param {Function} proj4  - proj4 library instance
 * @param {string}   targetCrs
 * @param {number[]} coord  - [x, y] in EPSG:3857
 * @returns {number[]} [easting, northing] in targetCrs
 */
function reprojectCoord(proj4, targetCrs, coord) {
  if (targetCrs === "EPSG:3857") return [coord[0], coord[1]];
  if (targetCrs === "EPSG:4326") {
    const lonLat = ol.proj.toLonLat(coord, "EPSG:3857");
    return [lonLat[0], lonLat[1]];
  }
  const lonLat = ol.proj.toLonLat(coord, "EPSG:3857");
  return proj4("EPSG:4326", targetCrs, [lonLat[0], lonLat[1]]);
}

/**
 * Extract all rings from a geometry (Polygon or MultiPolygon) as arrays of
 * reprojected [easting, northing] coordinate arrays (one per ring/polygon).
 * Only outer rings are included.
 */
function extractRings(proj4, geom, targetCrs) {
  const rings = [];
  const type  = geom.getType();
  if (type === "Polygon") {
    const coords = geom.getLinearRing(0)?.getCoordinates();
    if (coords) rings.push(coords.map(c => reprojectCoord(proj4, targetCrs, c)));
  } else if (type === "MultiPolygon") {
    for (const poly of geom.getPolygons()) {
      const coords = poly.getLinearRing(0)?.getCoordinates();
      if (coords) rings.push(coords.map(c => reprojectCoord(proj4, targetCrs, c)));
    }
  }
  return rings;
}

// ── File download helper ──────────────────────────────────────────────────────
function downloadText(filename, content, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Format generators ─────────────────────────────────────────────────────────

function buildGeoJSON(features, proj4, targetCrs) {
  const featureObjs = [];
  for (const feature of features) {
    const geom  = feature.getGeometry();
    if (!geom) continue;
    const rings = extractRings(proj4, geom, targetCrs);
    const props = { ...feature.getProperties() };
    delete props.geometry;

    const type = geom.getType();
    if (type === "Polygon" && rings.length === 1) {
      featureObjs.push({
        type: "Feature",
        properties: props,
        geometry: { type: "Polygon", coordinates: [rings[0]] }
      });
    } else if (type === "MultiPolygon" || rings.length > 1) {
      featureObjs.push({
        type: "Feature",
        properties: props,
        geometry: { type: "MultiPolygon", coordinates: rings.map(r => [r]) }
      });
    }
  }
  return JSON.stringify(
    {
      type: "FeatureCollection",
      crs: {
        type: "name",
        properties: { name: targetCrs }
      },
      features: featureObjs
    },
    null,
    2
  );
}

function buildKML(features, proj4, targetCrs) {
  // KML always uses geographic (lon/lat WGS84); we note the CRS in the
  // description if it differs.
  const coordsInGeo = targetCrs === "EPSG:4326";

  const placemarks = features.map(feature => {
    const geom  = feature.getGeometry();
    if (!geom) return "";
    const props = feature.getProperties();
    const name  = props.parcel_code ?? props.block_code ?? props.parcel_no ?? feature.getId() ?? "Feature";
    // Always output in geographic for valid KML
    const rings = extractRings(proj4, geom, "EPSG:4326");

    const coordStrings = rings.map(ring =>
      ring.map(([lon, lat]) => `${lon.toFixed(8)},${lat.toFixed(8)},0`).join(" ")
    );

    const geometryTag = coordStrings.length === 1
      ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coordStrings[0]}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
      : `<MultiGeometry>${coordStrings.map(cs =>
          `<Polygon><outerBoundaryIs><LinearRing><coordinates>${cs}</coordinates></LinearRing></outerBoundaryIs></Polygon>`
        ).join("")}</MultiGeometry>`;

    return `  <Placemark>
    <name>${escapeXml(String(name))}</name>
    ${geometryTag}
  </Placemark>`;
  }).filter(Boolean).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Export</name>
${placemarks}
  </Document>
</kml>`;
}

function buildCSV(features, proj4, targetCrs) {
  const isGeo  = targetCrs === "EPSG:4326";
  const col3   = isGeo ? "longitude"  : "easting";
  const col4   = isGeo ? "latitude"   : "northing";
  const rows   = [`parcel_id,point_no,${col3},${col4}`];

  for (const feature of features) {
    const geom = feature.getGeometry();
    if (!geom) continue;
    const props = feature.getProperties();
    const id    = props.parcel_code ?? props.block_code ?? props.parcel_no ?? feature.getId() ?? "";
    const rings = extractRings(proj4, geom, targetCrs);
    for (const ring of rings) {
      ring.forEach(([e, n], i) => {
        rows.push(`${csvEscape(String(id))},${i + 1},${e.toFixed(6)},${n.toFixed(6)}`);
      });
    }
  }
  return rows.join("\r\n");
}

function buildDXF(features, proj4, targetCrs) {
  // Minimal DXF R12 ASCII with LWPOLYLINE-equivalent (POLYLINE + VERTEX entities).
  const entities = [];

  for (const feature of features) {
    const geom = feature.getGeometry();
    if (!geom) continue;
    const rings = extractRings(proj4, geom, targetCrs);

    for (const ring of rings) {
      // POLYLINE entity (R12 style)
      entities.push(
        "  0\nPOLYLINE\n" +
        "  8\n0\n" +         // layer 0
        " 66\n     1\n" +    // vertices follow
        " 70\n     1\n"      // closed polyline
      );
      for (const [e, n] of ring) {
        entities.push(
          "  0\nVERTEX\n" +
          "  8\n0\n" +
          " 10\n" + e.toFixed(4) + "\n" +
          " 20\n" + n.toFixed(4) + "\n" +
          " 30\n0.0\n"
        );
      }
      entities.push("  0\nSEQEND\n");
    }
  }

  return (
    "  0\nSECTION\n" +
    "  2\nHEADER\n" +
    "  0\nENDSEC\n" +
    "  0\nSECTION\n" +
    "  2\nENTITIES\n" +
    entities.join("") +
    "  0\nENDSEC\n" +
    "  0\nEOF\n"
  );
}

// ── XML / CSV escape helpers ──────────────────────────────────────────────────
function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function csvEscape(s) {
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ── Module entry point ────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {ol.Map}        opts.map
 * @param {ol.layer.Vector} opts.parcelsLayer
 * @param {ol.layer.Vector} opts.blocksLayer
 * @param {Function}        opts.setStatus   - setStatus(el, msg, isError?)
 * @param {HTMLElement}     opts.statusEl
 */
export function initExportTools({ map, parcelsLayer, blocksLayer, setStatus, statusEl }) {
  // ── DOM refs ──────────────────────────────────────────────────────────────
  const exportCrsSelectEl  = document.getElementById("exportCrsSelect");
  const exportFmtSelectEl  = document.getElementById("exportFormatSelect");
  const exportSelectBtn    = document.getElementById("exportSelectBtn");
  const exportDoBtn        = document.getElementById("exportDoBtn");
  const exportCancelBtn    = document.getElementById("exportCancelBtn");
  const exportSelCountEl   = document.getElementById("exportSelCount");

  // ── Populate CRS dropdown ─────────────────────────────────────────────────
  if (exportCrsSelectEl && !exportCrsSelectEl.options.length) {
    CRS_OPTIONS.forEach(opt => {
      const el = document.createElement("option");
      el.value       = opt.value;
      el.textContent = opt.label;
      exportCrsSelectEl.appendChild(el);
    });
    exportCrsSelectEl.value = "EPSG:4326";
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let selectInteraction = null;
  const selectedFeatures = new ol.Collection();

  function updateSelCount() {
    const n = selectedFeatures.getLength();
    if (exportSelCountEl) {
      exportSelCountEl.textContent = n === 1 ? "1 feature" : `${n} features`;
    }
    if (exportDoBtn) exportDoBtn.disabled = n === 0;
  }
  updateSelCount();

  function showStatus(msg, isError = false) {
    if (statusEl && typeof setStatus === "function") {
      setStatus(statusEl, msg, isError);
    }
  }

  // ── Select interaction management ─────────────────────────────────────────
  function removeSelectInteraction() {
    if (selectInteraction && map) {
      map.removeInteraction(selectInteraction);
      selectInteraction = null;
    }
  }

  function startSelection() {
    removeSelectInteraction();
    selectedFeatures.clear();
    updateSelCount();

    const layers = [parcelsLayer, blocksLayer].filter(Boolean);
    if (!layers.length || !map) {
      showStatus("No parcel/block layers available.", true);
      return;
    }

    selectInteraction = new ol.interaction.Select({
      condition: ol.events.condition.click,
      toggleCondition: ol.events.condition.click,
      layers,
      features: selectedFeatures,
      style: new ol.style.Style({
        stroke: new ol.style.Stroke({ color: "#ff6d00", width: 3 }),
        fill:   new ol.style.Fill({ color: "rgba(255, 109, 0, 0.18)" })
      })
    });

    map.addInteraction(selectInteraction);
    showStatus("Click features to select them. Click again to deselect. Then press Export.");

    selectInteraction.on("select", updateSelCount);
  }

  exportSelectBtn?.addEventListener("click", startSelection);

  exportCancelBtn?.addEventListener("click", () => {
    removeSelectInteraction();
    selectedFeatures.clear();
    updateSelCount();
    showStatus("Selection cancelled.");
  });

  // ── Export action ─────────────────────────────────────────────────────────
  exportDoBtn?.addEventListener("click", async () => {
    const features   = selectedFeatures.getArray();
    if (!features.length) {
      showStatus("Select at least one feature first.", true);
      return;
    }
    const targetCrs  = exportCrsSelectEl?.value || "EPSG:4326";
    const format     = exportFmtSelectEl?.value || "GeoJSON";

    showStatus("Reprojecting and building file…");
    try {
      const proj4 = await getProj4();
      let content, ext, mime;

      switch (format.toUpperCase()) {
        case "GEOJSON":
          content = buildGeoJSON(features, proj4, targetCrs);
          ext     = "geojson";
          mime    = "application/geo+json;charset=utf-8";
          break;
        case "KML":
          content = buildKML(features, proj4, targetCrs);
          ext     = "kml";
          mime    = "application/vnd.google-earth.kml+xml;charset=utf-8";
          break;
        case "CSV":
          content = buildCSV(features, proj4, targetCrs);
          ext     = "csv";
          mime    = "text/csv;charset=utf-8";
          break;
        case "DXF":
          content = buildDXF(features, proj4, targetCrs);
          ext     = "dxf";
          mime    = "application/dxf;charset=utf-8";
          break;
        default:
          throw new Error(`Unknown format: ${format}`);
      }

      const crsSlug = targetCrs.replace(":", "_");
      const filename = `export_${features.length}feat_${crsSlug}.${ext}`;
      downloadText(filename, content, mime);
      showStatus(`Downloaded ${filename} (${features.length} feature(s)).`);
    } catch (err) {
      showStatus(`Export failed: ${err.message}`, true);
    }
  });

  // ── Return ────────────────────────────────────────────────────────────────
  return {};
}
