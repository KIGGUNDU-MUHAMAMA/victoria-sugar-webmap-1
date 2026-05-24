import { CRS_OPTIONS, registerProj4Defs, toProjectedFromWgs84 } from "./crs-definitions.js";

function downloadText(filename, text, mime = "text/plain;charset=utf-8") {
  const bom = filename.endsWith(".csv") ? "\uFEFF" : "";
  const blob = new Blob([bom + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeCsv(s) {
  const t = String(s ?? "");
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sameCoord(a, b, eps = 1e-5) {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

function ringWithoutDuplicateClose(ring) {
  if (ring.length >= 2 && sameCoord(ring[0], ring[ring.length - 1])) {
    return ring.slice(0, -1);
  }
  return ring;
}

function getExteriorRings3857(geometry) {
  const t = geometry.getType();
  if (t === "Polygon") {
    return [ringWithoutDuplicateClose(geometry.getLinearRing(0).getCoordinates())];
  }
  if (t === "MultiPolygon") {
    return geometry.getPolygons().map((poly) =>
      ringWithoutDuplicateClose(poly.getLinearRing(0).getCoordinates())
    );
  }
  return [];
}

function buildCsvRows(rings3857, proj4lib, crs, blockCode, parcelCode, layerType) {
  const rows = [];
  rings3857.forEach((ring, ri) => {
    ring.forEach((xy, pi) => {
      const [lon, lat] = ol.proj.transform(xy, "EPSG:3857", "EPSG:4326");
      const [x, y] = toProjectedFromWgs84(proj4lib, crs, lon, lat);
      rows.push({
        ring: ri + 1,
        pt: pi + 1,
        layerType,
        block: blockCode,
        parcel: parcelCode,
        crs,
        x,
        y
      });
    });
  });
  return rows;
}

function buildCsvContent(rows, crs) {
  const geo = crs === "EPSG:4326";
  const h1 = geo ? "longitude" : "easting";
  const h2 = geo ? "latitude" : "northing";
  const lines = [
    `ring_index,point_index,layer_type,block_code,parcel_code,crs,${h1},${h2}`,
    ...rows.map((r) =>
      `${r.ring},${r.pt},${escapeCsv(r.layerType)},${escapeCsv(r.block)},${escapeCsv(r.parcel)},${escapeCsv(r.crs)},${r.x},${r.y}`
    )
  ];
  return lines.join("\n");
}

function buildDxfFromRings(projectedRings, dxfLayerName = "PARCEL") {
  const layer = String(dxfLayerName || "PARCEL").replace(/[^\w-]/g, "_").slice(0, 32) || "PARCEL";
  const lines = [];
  const push = (a, b) => {
    lines.push(String(a));
    lines.push(String(b));
  };
  push(0, "SECTION");
  push(2, "ENTITIES");

  projectedRings.forEach((pts) => {
    push(0, "POLYLINE");
    push(8, layer);
    push(66, "1");
    push(70, "1");
    push(10, "0");
    push(20, "0");
    push(30, "0");
    
    pts.forEach(([x, y]) => {
      push(0, "VERTEX");
      push(8, layer);
      push(10, x);
      push(20, y);
      push(30, "0");
    });
    push(0, "SEQEND");
    push(8, layer);
  });

  push(0, "ENDSEC");
  push(0, "EOF");
  return lines.join("\r\n");
}

function sanitizeFilenamePart(s) {
  return String(s ?? "parcel").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "parcel";
}

export function initCoordExtractDrawer({
  map,
  parcelsLayer,
  blocksLayer,
  setStatus,
  statusEl,
  stopActiveTool,
  panelMode
}) {
  const drawer = document.getElementById("coordExtractDrawer");
  // In panelMode the toggle button is the Search toolbar btn — no dedicated drawer toggle
  const toggleBtn = panelMode ? null : document.getElementById("coordExtractorMainBtn");
  const closeBtn = panelMode ? null : document.getElementById("coordExtractCloseBtn");
  const crsSelect = document.getElementById("coordExtractCrsSelect");
  const exportCsv = document.getElementById("coordExtractCsv");
  const exportDxf = document.getElementById("coordExtractDxf");
  const pickBtn = document.getElementById("coordExtractPickBtn");
  const cancelPickBtn = document.getElementById("coordExtractCancelPickBtn");
  const hintEl = document.getElementById("coordExtractHint");
  const lastExportEl = document.getElementById("coordExtractLastExport");

  if (!drawer) {
    return { closeDrawer: () => {} };
  }
  // In non-panelMode we need the toggle button
  if (!panelMode && !toggleBtn) {
    return { closeDrawer: () => {} };
  }

  const parcelHitOpts = { hitTolerance: 14, layerFilter: (layer) => layer === parcelsLayer };
  const blockHitOpts =
    blocksLayer != null
      ? { hitTolerance: 14, layerFilter: (layer) => layer === blocksLayer }
      : null;

  CRS_OPTIONS.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    crsSelect?.appendChild(opt);
  });
  if (crsSelect) crsSelect.value = "EPSG:32636";
  if (exportCsv) exportCsv.checked = true;
  if (exportDxf) exportDxf.checked = true;

  let proj4lib = null;
  let pickingArmed = false;

  async function ensureProj4() {
    if (proj4lib) return proj4lib;
    const mod = await import("https://esm.sh/proj4@2.11.0");
    proj4lib = mod.default;
    registerProj4Defs(proj4lib);
    return proj4lib;
  }

  function setPickingUi(armed) {
    pickingArmed = armed;
    
    // Toggle UI visibility for "Give Way"
    const measureHead = document.querySelector("#drawingPanel .draw-tools__head");
    const measureSection1 = document.querySelector("#drawingPanel .draw-tools__section:nth-of-type(1)");
    const measureFooter = document.querySelector("#drawingPanel .draw-tools__footer");
    const extTitle = document.querySelector("#drawingPanel h4");
    const extCrs = document.getElementById("coordExtractCrsSelect");
    const extFormats = document.querySelector("#drawingPanel .coord-export-formats");
    const actionRow = document.getElementById("coordExtractActionRow");
    const panelHost = document.getElementById("panelHost");
    
    if (armed) {
      if (measureHead) measureHead.style.display = 'none';
      if (measureSection1) measureSection1.style.display = 'none';
      if (measureFooter) measureFooter.style.display = 'none';
      if (extTitle) extTitle.style.display = 'none';
      if (extCrs) extCrs.style.display = 'none';
      if (extFormats) extFormats.style.display = 'none';
      if (pickBtn) pickBtn.style.display = 'none';
      if (actionRow) actionRow.hidden = false;
      if (panelHost) {
        panelHost.style.height = "auto";
        panelHost.style.top = "auto";
        panelHost.style.bottom = "10px";
      }
    } else {
      if (measureHead) measureHead.style.display = '';
      if (measureSection1) measureSection1.style.display = '';
      if (measureFooter) measureFooter.style.display = '';
      if (extTitle) extTitle.style.display = '';
      if (extCrs) extCrs.style.display = '';
      if (extFormats) extFormats.style.display = 'flex';
      if (pickBtn) pickBtn.style.display = '';
      if (actionRow) actionRow.hidden = true;
      if (panelHost) {
        panelHost.style.height = "";
        panelHost.style.top = "";
        panelHost.style.bottom = "";
      }
    }
  }
  
  let extractSelectedFeatures = [];
  const extractHighlightLayer = new ol.layer.Vector({
    source: new ol.source.Vector(),
    style: new ol.style.Style({
      stroke: new ol.style.Stroke({ color: "#00e5ff", width: 4 }),
      fill: new ol.style.Fill({ color: "rgba(0, 229, 255, 0.2)" })
    }),
    zIndex: 999
  });
  map.addLayer(extractHighlightLayer);

  async function finishBatchExport() {
    if (!extractSelectedFeatures.length) {
      setStatus(statusEl, "No features selected to export.", true);
      disarmPicking();
      return;
    }

    const wantCsv = exportCsv?.checked;
    const wantDxf = exportDxf?.checked;
    const crs = crsSelect?.value;

    try {
      const p4 = await ensureProj4();
      const allRows = [];
      const allProjectedRings = [];

      for (const item of extractSelectedFeatures) {
        const geom = item.feature.getGeometry();
        if (!geom) continue;
        const rings3857 = getExteriorRings3857(geom);
        if (!rings3857.length) continue;

        const props = item.feature.getProperties();
        const blockCode = props.block_code ?? "";
        const parcelCode = item.layerType === "PARCELS" ? (props.parcel_code ?? props.parcel_no ?? "") : "";

        const rows = buildCsvRows(rings3857, p4, crs, blockCode, parcelCode, item.layerType);
        allRows.push(...rows);

        for (const ring of rings3857) {
          const pts = ring.map((xy) => {
            const [lon, lat] = ol.proj.transform(xy, "EPSG:3857", "EPSG:4326");
            return toProjectedFromWgs84(p4, crs, lon, lat);
          });
          allProjectedRings.push(pts);
        }
      }

      if (!allRows.length && !allProjectedRings.length) {
        setStatus(statusEl, "No valid geometry found in selection.", true);
        disarmPicking();
        return;
      }

      const crsTag = crs.replace(":", "_");
      
      if (wantCsv) {
        const csv = buildCsvContent(allRows, crs);
        downloadText(`batch_export_${crsTag}_corners.csv`, csv, "text/csv;charset=utf-8");
      }
      if (wantDxf) {
        const dxf = buildDxfFromRings(allProjectedRings, "BATCH_EXPORT");
        downloadText(`batch_export_${crsTag}.dxf`, dxf, "image/vnd.dxf");
      }

      setStatus(statusEl, `Exported ${extractSelectedFeatures.length} feature(s).`);
      disarmPicking();
    } catch (err) {
      setStatus(statusEl, err.message || "Export failed", true);
      disarmPicking();
    }
  }

  const finishBtn = document.getElementById("coordExtractFinishBtn");
  finishBtn?.addEventListener("click", finishBatchExport);

  function updateExtractUI() {
    if (finishBtn) {
      finishBtn.textContent = `Export (${extractSelectedFeatures.length})`;
    }
    extractHighlightLayer.getSource().clear();
    extractHighlightLayer.getSource().addFeatures(extractSelectedFeatures.map(item => item.feature));
  }

  function onExtractSingleClick(evt) {
    if (!pickingArmed) return;

    let picked = null;
    let layerType = null;

    map.forEachFeatureAtPixel(
      evt.pixel,
      (feature) => {
        picked = feature;
        return true;
      },
      parcelHitOpts
    );
    if (picked) layerType = "PARCELS";
    else if (blockHitOpts) {
      map.forEachFeatureAtPixel(
        evt.pixel,
        (feature) => {
          picked = feature;
          return true;
        },
        blockHitOpts
      );
      if (picked) layerType = "BLOCKS";
    }

    if (!picked) {
      setStatus(statusEl, "No block or parcel here.", true);
      return;
    }

    const existingIdx = extractSelectedFeatures.findIndex(item => item.feature.getId() === picked.getId());
    if (existingIdx > -1) {
      extractSelectedFeatures.splice(existingIdx, 1);
    } else {
      extractSelectedFeatures.push({ feature: picked, layerType });
    }
    updateExtractUI();
  }

  function disarmPicking() {
    setPickingUi(false);
    extractSelectedFeatures = [];
    updateExtractUI();
  }

  function armPicking() {
    const wantCsv = exportCsv?.checked;
    const wantDxf = exportDxf?.checked;
    if (!wantCsv && !wantDxf) {
      setStatus(statusEl, "Choose at least one export format.", true);
      return;
    }
    if (!crsSelect?.value) {
      setStatus(statusEl, "Choose an export CRS.", true);
      return;
    }

    stopActiveTool?.();
    extractSelectedFeatures = [];
    updateExtractUI();
    setPickingUi(true);
    setStatus(statusEl, "Click blocks or parcels to toggle selection.");
  }

  map.on("singleclick", onExtractSingleClick);

  function closeDrawer() {
    if (panelMode) {
      // In panelMode the search panel manages its own visibility;
      // only disarm picking here.
      disarmPicking();
      return;
    }
    disarmPicking();
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    toggleBtn.classList.remove("active");
    drawer.dataset.picking = "";
  }

  function openDrawer() {
    if (panelMode) return;
  }

  pickBtn?.addEventListener("click", () => {
    if (pickingArmed) {
      disarmPicking();
      setStatus(statusEl, "Picking cancelled.");
      return;
    }
    armPicking();
  });

  cancelPickBtn?.addEventListener("click", () => {
    disarmPicking();
    setStatus(statusEl, "Picking cancelled.");
  });

  if (!panelMode) {
    toggleBtn.addEventListener("click", () => {
      if (drawer.classList.contains("open")) {
        closeDrawer();
      } else {
        openDrawer();
      }
    });
    closeBtn?.addEventListener("click", closeDrawer);
  }

  function onForceClose() {
    if (panelMode) {
      disarmPicking();
    } else if (drawer.classList.contains("open")) {
      closeDrawer();
    }
  }
  window.addEventListener("vsl-force-close-extract-drawer", onForceClose);

  window.addEventListener("vsl-open-extract-drawer", () => {
    disarmPicking();
  });
  return { closeDrawer };
}
