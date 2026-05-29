/**
 * Survey CSV import: left drawer UI + Edge Function preview/commit.
 */

import { CRS_OPTIONS, registerProj4Defs, toMap3857FromCrs } from "./crs-definitions.js";
import DxfParser from "https://esm.sh/dxf-parser@1.1.2";

let proj4lib = null;
async function getProj4() {
  if (proj4lib) return proj4lib;
  const mod = await import("https://esm.sh/proj4@2.11.0");
  proj4lib = mod.default;
  registerProj4Defs(proj4lib);
  return proj4lib;
}

function parseDxfFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parser = new DxfParser();
        const dxf = parser.parseSync(e.target.result);
        resolve(dxf);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}
function surveyFunctionUrl(cfg) {
  const base = (cfg.SUPABASE_URL || "").replace(/\/\$/, "");
  const name = cfg.SURVEY_FUNCTION_NAME || "quick-api";
  return `${base}/functions/v1/${name}`;
}

async function callSurveyEdge(cfg, body) {
  const url = surveyFunctionUrl(cfg);
  const headers = {
    Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
    apikey: cfg.SUPABASE_ANON_KEY,
    "Content-Type": "application/json"
  };
  if (cfg.SURVEY_IMPORT_SECRET) {
    headers["x-vsl-survey-secret"] = cfg.SURVEY_IMPORT_SECRET;
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    console.error("[Victoria Survey] Response was not JSON", {
      url,
      action: body?.action,
      httpStatus: res.status,
      responsePreview: text.slice(0, 2500)
    });
    throw new Error(
      `Survey service returned invalid JSON (HTTP ${res.status}). Open the browser console (F12) and look for [Victoria Survey].`
    );
  }
  if (!res.ok) {
    console.error("[Victoria Survey] HTTP error", {
      url,
      action: body?.action,
      httpStatus: res.status,
      responseBody: data,
      responsePreview: text.slice(0, 2500)
    });
    throw new Error(
      data.error ||
        data.message ||
        `Survey service error (HTTP ${res.status}). Details are in the console under [Victoria Survey].`
    );
  }
  if (!data.success) {
    console.error("[Victoria Survey] success:false", {
      url,
      action: body?.action,
      responseBody: data
    });
    throw new Error(
      data.error || "Survey request failed. Details are in the console under [Victoria Survey]."
    );
  }
  return data;
}

function parseCsvFile(file) {
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

function fitMapToLayerSources(map, blocksSource, parcelsSource) {
  if (!map || !blocksSource || !parcelsSource) return;
  const extent = ol.extent.createEmpty();
  for (const f of blocksSource.getFeatures()) {
    const g = f.getGeometry();
    if (g) ol.extent.extend(extent, g.getExtent());
  }
  for (const f of parcelsSource.getFeatures()) {
    const g = f.getGeometry();
    if (g) ol.extent.extend(extent, g.getExtent());
  }
  if (ol.extent.isEmpty(extent)) return;
  map.getView().fit(extent, { padding: [90, 90, 90, 90], maxZoom: 18, duration: 450 });
}

export function initSurveyImport({
  map,
  cfg,
  setStatus,
  statusEl,
  loadLayersFromDb,
  getManagementLocked,
  blocksSource,
  parcelsSource
}) {
  const drawer = document.getElementById("surveyDrawer");
  const toggleBtn = document.getElementById("surveyPanelBtn");
  const closeBtn = document.getElementById("surveyCloseBtn");
  const layerSelect = document.getElementById("surveyLayerSelect");
  const blockFields = document.getElementById("surveyBlockFields");
  const parcelFields = document.getElementById("surveyParcelFields");
  const projectName = document.getElementById("surveyProjectName");
  const parentBlockSelect = document.getElementById("surveyParentBlockSelect");
  const crsSelect = document.getElementById("surveyCrsSelect");
  const additionalInfo = document.getElementById("surveyAdditionalInfo");
  const fileInput = document.getElementById("surveyFileInput");
  const dropzone = document.getElementById("surveyDropzone");
  const summaryEl = document.getElementById("surveySummary");
  const skipSelf = document.getElementById("surveySkipSelfIntersect");
  const previewBtn = document.getElementById("surveyPreviewBtn");
  const saveBtn = document.getElementById("surveySaveBtn");

  if (!drawer) return null;
  // toggleBtn and surveyCloseBtn may be absent (stubs); guard all calls
  const hasToggle = toggleBtn && !toggleBtn.hidden;

  // Populate CRS dropdown from CRS_OPTIONS
  CRS_OPTIONS.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    crsSelect?.appendChild(opt);
  });
  if (crsSelect) crsSelect.value = "EPSG:32636";

  const polySource = new ol.source.Vector();
  const pointSource = new ol.source.Vector();
  const previewPolyLayer = new ol.layer.Vector({
    source: polySource,
    style: new ol.style.Style({
      stroke: new ol.style.Stroke({ color: "#c45c1a", width: 2 }),
      fill: new ol.style.Fill({ color: "rgba(196, 92, 26, 0.12)" })
    }),
    zIndex: 900
  });
  previewPolyLayer.set("displayInLayerSwitcher", false);
  const previewPointLayer = new ol.layer.Vector({
    source: pointSource,
    style: new ol.style.Style({
      image: new ol.style.Circle({
        radius: 4,
        fill: new ol.style.Fill({ color: "#1d2a1d" }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 1 })
      })
    }),
    zIndex: 901
  });
  previewPointLayer.set("displayInLayerSwitcher", false);
  map.addLayer(previewPolyLayer);
  map.addLayer(previewPointLayer);

  let parsedDxf = null;
  const dxfSource = new ol.source.Vector();
  const dxfLayer = new ol.layer.Vector({
    source: dxfSource,
    style: new ol.style.Style({
      stroke: new ol.style.Stroke({ color: "#00f", width: 1.5, lineDash: [4, 4] })
    }),
    zIndex: 899
  });
  dxfLayer.set("displayInLayerSwitcher", false);
  map.addLayer(dxfLayer);

  let digitizeCount = 0;
  const drawSource = new ol.source.Vector();
  const drawLayer = new ol.layer.Vector({
    source: drawSource,
    style: new ol.style.Style({
      stroke: new ol.style.Stroke({ color: "#28a745", width: 2 }),
      fill: new ol.style.Fill({ color: "rgba(40, 167, 69, 0.2)" })
    }),
    zIndex: 902
  });
  drawLayer.set("displayInLayerSwitcher", false);
  map.addLayer(drawLayer);

  let drawInteraction = null;
  let snapInteraction1 = null;
  let snapInteraction2 = null;

  let parsedRows = [];
  let lastPreviewPayload = null;

  function closeDrawer() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  }

  async function refreshParentBlockOptions() {
    if (!parentBlockSelect) return;
    const keep = parentBlockSelect.value;
    parentBlockSelect.innerHTML = '<option value="">Loading blocks…</option>';
    
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_blocks?select=block_code`;
      const res = await fetch(url, {
        headers: {
          "apikey": cfg.SUPABASE_ANON_KEY,
          "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}`,
          "Accept": "application/json"
        }
      });
      if (!res.ok) throw new Error("Failed to fetch blocks");
      
      const data = await res.json();
      
      const codes = [...new Set(data.map(d => d.block_code).filter(c => c != null && String(c).trim() !== ""))];
      
      codes.sort((a, b) => {
        const ca = String(a);
        const cb = String(b);
        const na = Number(ca);
        const nb = Number(cb);
        if (Number.isFinite(na) && Number.isFinite(nb) && String(na) === ca && String(nb) === cb) {
          return na - nb;
        }
        return ca.localeCompare(cb, undefined, { numeric: true });
      });
      
      parentBlockSelect.innerHTML = '<option value="">Select a block (codes 1, 2, 3…)</option>';
      for (const code of codes) {
        const opt = document.createElement("option");
        opt.value = String(code).trim();
        opt.textContent = `Block ${String(code).trim()}`;
        parentBlockSelect.appendChild(opt);
      }
      
      if (keep && [...parentBlockSelect.options].some((o) => o.value === keep)) {
        parentBlockSelect.value = keep;
      }
    } catch (e) {
      console.error("[Victoria Survey] Error fetching parent blocks:", e);
      parentBlockSelect.innerHTML = '<option value="">Error loading blocks</option>';
    }
  }

  function updateLayerFields() {
    const v = layerSelect.value;
    blockFields.hidden = v !== "BLOCKS";
    parcelFields.hidden = v !== "PARCELS";
    if (v === "PARCELS") refreshParentBlockOptions();
  }

  function clearPreview() {
    polySource.clear(true);
    pointSource.clear(true);
    dxfSource.clear(true);
    drawSource.clear(true);
    if (drawInteraction) {
      map.removeInteraction(drawInteraction);
      if (snapInteraction1) map.removeInteraction(snapInteraction1);
      if (snapInteraction2) map.removeInteraction(snapInteraction2);
      drawInteraction = null;
      snapInteraction1 = null;
      snapInteraction2 = null;
    }
    const stBtn = document.getElementById("surveyStartTracingBtn");
    if(stBtn) {
       stBtn.textContent = "Start Tracing";
       stBtn.classList.replace("btn-danger", "btn-primary");
    }
    digitizeCount = 0;
    const dc = document.getElementById("surveyDigitizeCount");
    if(dc) dc.textContent = `0 polygons digitized`;
    
    parsedDxf = null;
    const dTools = document.getElementById("surveyDigitizeTools");
    if(dTools) dTools.hidden = true;
    
    lastPreviewPayload = null;
    saveBtn.disabled = true;
  }

  function renderSummary(html) {
    summaryEl.hidden = !html;
    summaryEl.innerHTML = html || "";
  }

  if (hasToggle) {
  toggleBtn.addEventListener("click", () => {
    if (getManagementLocked?.()) {
      setStatus(statusEl, "Survey import is not available for your role.", true);
      return;
    }
    const coordDrawer = document.getElementById("coordSearchDrawer");
    const coordBtn = document.getElementById("coordSearchBtn");
    drawer.classList.toggle("open");
    drawer.setAttribute("aria-hidden", drawer.classList.contains("open") ? "false" : "true");
    if (drawer.classList.contains("open")) {
      toggleBtn.classList.add("active");
      coordDrawer?.classList.remove("open");
      coordBtn?.classList.remove("active");
      window.dispatchEvent(new CustomEvent("vsl-force-close-extract-drawer"));
      refreshParentBlockOptions();
    } else {
      toggleBtn.classList.remove("active");
      if (drawInteraction) {
        map.removeInteraction(drawInteraction);
        if (snapInteraction1) map.removeInteraction(snapInteraction1);
        if (snapInteraction2) map.removeInteraction(snapInteraction2);
        drawInteraction = null;
        snapInteraction1 = null;
        snapInteraction2 = null;
        document.getElementById("surveyStartTracingBtn")?.classList.replace("btn-danger", "btn-primary");
        document.getElementById("surveyStartTracingBtn").textContent = "Start Tracing";
      }
    }
  }) // end toggleBtn click
  } // end hasToggle

  closeBtn?.addEventListener("click", () => {
    closeDrawer();
    if (hasToggle) toggleBtn.classList.remove("active");
  });

  layerSelect?.addEventListener("change", () => {
    updateLayerFields();
    clearPreview();
    renderSummary("");
  });

  async function renderDxf() {
    dxfSource.clear(true);
    if (!parsedDxf) return;
    try {
      const crs = crsSelect.value;
      const p4 = await getProj4();
      
      parsedDxf.entities.forEach(ent => {
        if ((ent.type === 'LINE' || ent.type === 'POLYLINE' || ent.type === 'LWPOLYLINE') && ent.vertices) {
          const coords = ent.vertices.map(v => {
            return toMap3857FromCrs(p4, crs, v.x, v.y);
          });
          const line = new ol.geom.LineString(coords);
          dxfSource.addFeature(new ol.Feature({ geometry: line }));
        }
      });
      if (dxfSource.getFeatures().length > 0) {
        const ext = dxfSource.getExtent();
        if (ext && ext.every(Number.isFinite)) {
          map.getView().fit(ext, { padding: [100, 100, 100, 220], maxZoom: 18, duration: 400 });
        }
        document.getElementById("surveyDigitizeTools").hidden = false;
        setStatus(statusEl, "DXF loaded. Choose target layer, click Start Tracing, and trace over lines.");
      }
    } catch(e) {
      console.error(e);
      setStatus(statusEl, "Failed to project DXF: " + e.message, true);
    }
  }

  crsSelect?.addEventListener("change", () => {
    if (parsedDxf) {
      renderDxf();
    }
  });

  function promptForCrs(filename) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:9999; display:flex; align-items:center; justify-content:center;";
      
      const modal = document.createElement("div");
      modal.style.cssText = "background:#fff; padding:20px; border-radius:12px; width:300px; max-width:90%; box-shadow:0 4px 12px rgba(0,0,0,0.2);";
      
      modal.innerHTML = `
        <h3 style="margin-top:0;">DXF Coordinate System</h3>
        <p style="font-size:0.85rem; color:#666;">Select the coordinate system for <strong>${filename}</strong>:</p>
        <select id="dxfCrsPromptSelect" style="width:100%; padding:8px; margin-bottom:16px; border:1px solid #ccc; border-radius:6px; font-size:0.9rem;">
          ${CRS_OPTIONS.map(o => `<option value="${o.value}" ${o.value === (crsSelect?.value || "EPSG:32636") ? "selected" : ""}>${o.label}</option>`).join('')}
        </select>
        <div style="display:flex; justify-content:flex-end; gap:8px;">
          <button id="dxfCrsPromptCancel" style="padding:8px 16px; border-radius:6px; background:#f0f0f0; border:none; cursor:pointer;">Cancel</button>
          <button id="dxfCrsPromptOk" style="padding:8px 16px; border-radius:6px; background:#28a745; color:#fff; border:none; cursor:pointer;">Plot DXF</button>
        </div>
      `;
      
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      
      document.getElementById("dxfCrsPromptCancel").onclick = () => {
        document.body.removeChild(overlay);
        resolve(null);
      };
      
      document.getElementById("dxfCrsPromptOk").onclick = () => {
        const val = document.getElementById("dxfCrsPromptSelect").value;
        document.body.removeChild(overlay);
        resolve(val);
      };
    });
  }

  async function handleFile(file) {
    if (!file) return;
    const name = file.name.toLowerCase();
    
    if (name.endsWith(".dxf") || name.endsWith(".kml") || name.endsWith(".geojson") || name.endsWith(".json")) {
      const chosenCrs = await promptForCrs(file.name);
      if (!chosenCrs) {
        setStatus(statusEl, "Import cancelled (no CRS selected).");
        return;
      }
      if (crsSelect) crsSelect.value = chosenCrs;
      
      if (name.endsWith(".dxf")) {
        try {
          setStatus(statusEl, "Parsing DXF...");
          parsedDxf = await parseDxfFile(file);
          parsedRows = [];
          renderSummary("");
          await renderDxf();
        } catch(e) {
          setStatus(statusEl, "DXF parsing failed: " + e.message, true);
        }
      } else if (name.endsWith(".kml")) {
        try {
          clearPreview();
          setStatus(statusEl, "Parsing KML…");
          const text = await file.text();
          const kmlFormat = new ol.format.KML({ extractStyles: false });
          const features = kmlFormat.readFeatures(text, { dataProjection: chosenCrs, featureProjection: "EPSG:3857" });
          polySource.clear(true);
          for (const f of features) {
            if (f.getGeometry()?.getType().includes("Polygon")) polySource.addFeature(f);
          }
          parsedDxf = { entities: [], _kmlFeatures: features }; // flag for digitizer
          if (polySource.getFeatures().length > 0) {
            const ext = polySource.getExtent();
            if (ext && ext.every(Number.isFinite)) map.getView().fit(ext, { padding: [80,80,80,80], maxZoom: 18, duration: 400 });
            const dTools = document.getElementById("surveyDigitizeTools");
            if (dTools) dTools.hidden = false;
            setStatus(statusEl, `KML loaded — ${polySource.getFeatures().length} polygon(s). Use Trace to create parcels.`);
          } else {
            setStatus(statusEl, "No polygon features found in KML.", true);
          }
          renderSummary(`<p>${features.length} KML feature(s) loaded.</p>`);
        } catch(e) {
          setStatus(statusEl, "KML parsing failed: " + e.message, true);
        }
      } else {
        // geojson
        try {
          clearPreview();
          setStatus(statusEl, "Parsing GeoJSON…");
          const text = await file.text();
          const gjFormat = new ol.format.GeoJSON();
          const features = gjFormat.readFeatures(text, { dataProjection: chosenCrs, featureProjection: "EPSG:3857" });
          polySource.clear(true);
          for (const f of features) {
            if (f.getGeometry()?.getType().includes("Polygon")) polySource.addFeature(f);
          }
          parsedDxf = { entities: [], _gjFeatures: features }; // flag for digitizer
          if (polySource.getFeatures().length > 0) {
            const ext = polySource.getExtent();
            if (ext && ext.every(Number.isFinite)) map.getView().fit(ext, { padding: [80,80,80,80], maxZoom: 18, duration: 400 });
            const dTools = document.getElementById("surveyDigitizeTools");
            if (dTools) dTools.hidden = false;
            setStatus(statusEl, `GeoJSON loaded — ${polySource.getFeatures().length} polygon(s). Use Trace or save directly.`);
          } else {
            setStatus(statusEl, "No polygon features found in GeoJSON.", true);
          }
          renderSummary(`<p>${features.length} GeoJSON feature(s) loaded.</p>`);
        } catch(e) {
          setStatus(statusEl, "GeoJSON parsing failed: " + e.message, true);
        }
      }
    } else {
      try {
        clearPreview();
        parsedRows = await parseCsvFile(file);
        const n = parsedRows.length;
        renderSummary(
          `<p><strong>${n}</strong> data row(s) read. Choose CRS and click <strong>Preview</strong>.</p>`
        );
      } catch (e) {
        parsedRows = [];
        setStatus(statusEl, e.message, true);
        renderSummary("");
      }
    }
  }

  // Export so global drag and drop can use it
  window.handleGlobalSurveyDrop = async function(file) {
    if (window.openUamTab) {
      window.openUamTab("import");
    }
    const sel = document.getElementById("importFormatSelect");
    if (sel) {
      const name = file.name.toLowerCase();
      if (name.endsWith(".dxf")) sel.value = "dxf";
      else if (name.endsWith(".kml")) sel.value = "kml";
      else if (name.endsWith(".geojson") || name.endsWith(".json")) sel.value = "geojson";
      else if (name.endsWith(".csv")) sel.value = "csv";
      sel.dispatchEvent(new Event("change"));
    }
    await handleFile(file);
  };

  fileInput?.addEventListener("change", () => handleFile(fileInput.files?.[0]));

  dropzone?.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.add("dragover");
  });
  dropzone?.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone?.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove("dragover");
    const f = e.dataTransfer?.files?.[0];
    if (f) {
      // Set the format dropdown to match the file type
      const sel = document.getElementById("importFormatSelect");
      if (sel) {
        const nm = f.name.toLowerCase();
        if (nm.endsWith(".dxf")) sel.value = "dxf";
        else if (nm.endsWith(".kml")) sel.value = "kml";
        else if (nm.endsWith(".geojson") || nm.endsWith(".json")) sel.value = "geojson";
        else if (nm.endsWith(".csv")) sel.value = "csv";
        sel.dispatchEvent(new Event("change"));
      }
      await handleFile(f);
    }
  });

  function updateDigitizePayload() {
    const features = drawSource.getFeatures();
    if (features.length === 0) {
      lastPreviewPayload = null;
      saveBtn.disabled = true;
      return;
    }
    
    const gj = new ol.format.GeoJSON();
    const results = features.map((f, i) => {
      const geom = f.getGeometry().clone().transform('EPSG:3857', 'EPSG:4326');
      return {
        parcelId: `Traced ${i + 1}`,
        success: true,
        geometry: gj.writeGeometryObject(geom)
      };
    });
    
    lastPreviewPayload = {
        layerType: layerSelect.value,
        projectName: projectName?.value?.trim() || "",
        parentBlockCode: parentBlockSelect?.value?.trim() || "",
        coordinateSystem: "EPSG:4326", 
        additionalInfo: additionalInfo?.value?.trim() || "",
        results
    };
    saveBtn.disabled = false;
  }

  document.getElementById("surveyStartTracingBtn")?.addEventListener("click", () => {
    const stBtn = document.getElementById("surveyStartTracingBtn");
    if (drawInteraction) {
      map.removeInteraction(drawInteraction);
      map.removeInteraction(snapInteraction);
      drawInteraction = null;
      snapInteraction = null;
      stBtn.textContent = "Start Tracing";
      stBtn.classList.replace("btn-danger", "btn-primary");
      return;
    }
    
    const layerType = layerSelect.value;
    if (!layerType) {
      setStatus(statusEl, "Select target layer (BLOCKS or PARCELS) before tracing.", true);
      return;
    }
    if (layerType === "PARCELS" && !parentBlockSelect?.value?.trim()) {
      setStatus(statusEl, "Choose the parent block before tracing parcels.", true);
      return;
    }

    drawInteraction = new ol.interaction.Draw({
      source: drawSource,
      type: "Polygon"
    });
    
    snapInteraction1 = new ol.interaction.Snap({ source: dxfSource });
    snapInteraction2 = new ol.interaction.Snap({ source: drawSource });
    
    map.addInteraction(drawInteraction);
    map.addInteraction(snapInteraction1);
    map.addInteraction(snapInteraction2);
    
    drawInteraction.on('drawend', (e) => {
      digitizeCount++;
      const dc = document.getElementById("surveyDigitizeCount");
      if(dc) dc.textContent = `${digitizeCount} polygons digitized`;
      // Update the payload next tick so the feature is actually in the source
      setTimeout(() => updateDigitizePayload(), 10);
    });
    
    stBtn.textContent = "Stop Tracing";
    stBtn.classList.replace("btn-primary", "btn-danger");
    setStatus(statusEl, "Tracing active. Click map to draw polygon corners. Double-click to finish.");
  });

  document.getElementById("surveyClearTracingBtn")?.addEventListener("click", () => {
    drawSource.clear(true);
    digitizeCount = 0;
    const dc = document.getElementById("surveyDigitizeCount");
    if(dc) dc.textContent = `0 polygons digitized`;
    updateDigitizePayload();
  });

  previewBtn?.addEventListener("click", async () => {
    if (getManagementLocked?.()) return;
    const layerType = layerSelect.value;
    if (!layerType) {
      setStatus(statusEl, "Select target layer (BLOCKS or PARCELS).", true);
      return;
    }
    if (layerType === "PARCELS" && !parentBlockSelect?.value?.trim()) {
      setStatus(statusEl, "Choose the parent block for these parcels (load blocks on the map if the list is empty).", true);
      return;
    }
    if (!parsedRows.length) {
      setStatus(statusEl, "Load a CSV file first.", true);
      return;
    }
    const crs = crsSelect.value;
    try {
      setStatus(statusEl, "Building preview…");
      const data = await callSurveyEdge(cfg, {
        action: "preview_batch",
        crs,
        rows: parsedRows,
        skipSelfIntersectionCheck: !!skipSelf?.checked
      });
      const { summary, results } = data;
      renderSummary(
        `<p><strong>Parcels (groups):</strong> ${summary.totalParcels} &nbsp;|&nbsp; <strong>Valid:</strong> ${summary.validParcels} &nbsp;|&nbsp; <strong>Failed:</strong> ${summary.failedParcels}</p>` +
          `<p><strong>Total points:</strong> ${summary.totalPoints} &nbsp;|&nbsp; <strong>Skipped rows:</strong> ${summary.skippedRows}</p>` +
          (layerType === "BLOCKS"
            ? "<p class=\"small\">On save, each polygon becomes a new block numbered <strong>1, 2, 3…</strong> (CSV <code>parcel_id</code> is only for grouping points).</p>"
            : "<p class=\"small\">On save, parcels get numbers <strong>1, 2, 3…</strong> in the selected block (CSV <code>parcel_id</code> is only for grouping corners).</p>") +
          (summary.failedParcels > 0
            ? "<p class=\"small\">Some parcels failed validation; check console or fix CSV.</p>"
            : "")
      );

      polySource.clear(true);
      pointSource.clear(true);
      const gj = new ol.format.GeoJSON();
      const validResults = results.filter((r) => r.success && r.geometry);
      for (const r of validResults) {
        const feat = gj.readFeature(
          { type: "Feature", geometry: r.geometry, properties: { parcelId: r.parcelId } },
          { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" }
        );
        polySource.addFeature(feat);
        const ring = r.geometry.coordinates[0];
        for (let i = 0; i < ring.length - 1; i++) {
          const [lon, lat] = ring[i];
          const pf = new ol.Feature({
            geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat]))
          });
          pf.set("label", r.parcelId);
          pointSource.addFeature(pf);
        }
      }
      if (validResults.length) {
        const extent = polySource.getExtent();
        if (extent && extent.every(Number.isFinite)) {
          map.getView().fit(extent, { padding: [100, 100, 100, 220], maxZoom: 18, duration: 400 });
        }
      }

      lastPreviewPayload = {
        layerType,
        projectName: projectName?.value?.trim() || "",
        parentBlockCode: parentBlockSelect?.value?.trim() || "",
        coordinateSystem: crs,
        additionalInfo: additionalInfo?.value?.trim() || "",
        results
      };
      saveBtn.disabled = !validResults.length;
      setStatus(statusEl, "Preview ready. Verify on map, then save.");
    } catch (e) {
      clearPreview();
      console.error("[Victoria Survey] Preview failed", e);
      setStatus(statusEl, e.message, true);
    }
  });

  saveBtn?.addEventListener("click", async () => {
    if (getManagementLocked?.() || !lastPreviewPayload) return;
    try {
      setStatus(statusEl, "Saving to database…");
      const data = await callSurveyEdge(cfg, {
        action: "commit_batch",
        layerType: lastPreviewPayload.layerType,
        projectName: lastPreviewPayload.projectName,
        parentBlockCode: lastPreviewPayload.parentBlockCode,
        coordinateSystem: lastPreviewPayload.coordinateSystem,
        additionalInfo: lastPreviewPayload.additionalInfo,
        results: lastPreviewPayload.results
      });
      const inserted = data.db?.inserted ?? 0;
      const errs = data.db?.errors || [];
      if (inserted === 0) {
        console.error("[Victoria Survey] Save returned 0 rows inserted", {
          fullResponse: data,
          dbErrors: errs
        });
        const errMsg =
          Array.isArray(errs) && errs.length
            ? `Nothing was saved. Database reported: ${JSON.stringify(errs)}`
            : "Nothing was saved (0 rows). For PARCELS, choose a parent block that exists on the map. See console [Victoria Survey].";
        setStatus(statusEl, errMsg, true);
        return;
      }
      polySource.clear(true);
      pointSource.clear(true);
      lastPreviewPayload = null;
      saveBtn.disabled = true;
      await loadLayersFromDb();
      refreshParentBlockOptions();
      fitMapToLayerSources(map, blocksSource, parcelsSource);
      setStatus(
        statusEl,
        `Saved ${inserted} feature(s).` +
          (Array.isArray(errs) && errs.length ? ` (${errs.length} minor row note(s) in console.)` : "")
      );
      if (Array.isArray(errs) && errs.length) {
        console.warn("[Victoria Survey] Partial row notes from database", errs);
      }
    } catch (e) {
      console.error("[Victoria Survey] Save failed", e);
      setStatus(statusEl, e.message, true);
    }
  });

  updateLayerFields();

  return {
    getPreviewSnapSources() {
      return { polySource, pointSource };
    },
    getPreviewLayers() {
      return { polyLayer: previewPolyLayer, pointLayer: previewPointLayer };
    }
  };
}
