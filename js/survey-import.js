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

// DXF/KML/GeoJSON files still get their own one-off CRS prompt at load time
// (promptForCrs, below) since those are essentially never in lon/lat — the
// tab-level CRS dropdown that used to seed its default is gone, so this is
// now the sole hardcoded fallback.
const DEFAULT_DXF_CRS = "EPSG:32636";

export function initSurveyImport({
  map,
  cfg,
  supabase,
  setStatus,
  statusEl,
  loadLayersFromDb,
  refreshEstateBoundaries,
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
  // Both estate pickers are real <select>s now, sourced from vsl_estate
  // (refreshEstateOptions) — Blocks used to be a free-text input w/
  // datalist, Plots used to read a since-dropped vsl_blocks.estate_name
  // column. Neither matched the live schema (estate_id -> vsl_estate).
  const blockEstateSelect = document.getElementById("surveyBlockEstateSelect");
  const blockEstateAddBtn = document.getElementById("surveyBlockEstateAddBtn");
  const surveyParcelEstateSelect = document.getElementById("surveyParcelEstateSelect");
  const parcelEstateAddBtn = document.getElementById("surveyParcelEstateAddBtn");
  const parentBlockSelect = document.getElementById("surveyParentBlockSelect");
  // Module-level (not a dropdown) — set by promptForCrs() when a DXF/KML/
  // GeoJSON file is loaded; CSV/digitized imports always use WGS84 below.
  let dxfCrs = DEFAULT_DXF_CRS;
  const fileInput = document.getElementById("surveyFileInput");
  // File selector doubles as the dropzone now — the separate #surveyDropzone
  // box was removed, drag/drop lands directly on this label.
  const dropzone = document.getElementById("surveyFileLabel");
  const summaryEl = document.getElementById("surveySummary");
  const previewBtn = document.getElementById("surveyPreviewBtn");
  const clearImportBtn = document.getElementById("surveyClearBtn");
  const saveBtn = document.getElementById("surveySaveBtn");
  const fileNameEl = document.getElementById("surveyFileName");

  if (!drawer) return null;
  // toggleBtn and surveyCloseBtn may be absent (stubs); guard all calls
  const hasToggle = toggleBtn && !toggleBtn.hidden;

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

  let parsedRows = [];
  let lastPreviewPayload = null;

  function closeDrawer() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  }

  function toTitleCase(str) {
    return str.trim().replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
  }

  function fillEstateSelect(selectEl, estates) {
    if (!selectEl) return;
    const keep = selectEl.value;
    selectEl.innerHTML = '<option value="">— Select Estate —</option>';
    for (const e of estates) {
      const opt = document.createElement("option");
      opt.value = e.estate_name;
      opt.textContent = e.estate_name;
      selectEl.appendChild(opt);
    }
    if (keep && [...selectEl.options].some(o => o.value === keep)) {
      selectEl.value = keep;
    }
  }

  // Populates both the Blocks-import and Plots-import estate dropdowns from
  // vsl_estate directly — this used to read estate_name off vsl_blocks,
  // which no longer has that column now that estates are their own table
  // (vsl_blocks.estate_id -> vsl_estate.id).
  async function refreshEstateOptions() {
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_estate?select=id,estate_name&order=estate_name.asc`;
      const res = await fetch(url, {
        headers: {
          "apikey": cfg.SUPABASE_ANON_KEY,
          "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}`,
          "Accept": "application/json"
        }
      });
      if (!res.ok) return;
      const data = await res.json();
      const estates = data.filter(d => d.estate_name && String(d.estate_name).trim());
      fillEstateSelect(blockEstateSelect, estates);
      fillEstateSelect(surveyParcelEstateSelect, estates);
    } catch (e) {
      console.error("[Victoria Survey] Error fetching estates:", e);
    }
  }

  async function refreshParentBlockOptions(estateName) {
    if (!parentBlockSelect) return;
    const keep = parentBlockSelect.value;

    if (!estateName) {
      parentBlockSelect.innerHTML = '<option value="">— Select Estate first —</option>';
      parentBlockSelect.disabled = true;
      return;
    }

    parentBlockSelect.disabled = false;
    parentBlockSelect.innerHTML = '<option value="">Loading blocks…</option>';

    try {
      const base = cfg.SUPABASE_URL.replace(/\/$/, "");
      const headers = {
        "apikey": cfg.SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}`,
        "Accept": "application/json"
      };
      // vsl_blocks is keyed by estate_id now, not estate_name, so resolve
      // the id first.
      const estRes = await fetch(
        `${base}/rest/v1/vsl_estate?select=id&estate_name=eq.${encodeURIComponent(estateName)}&limit=1`,
        { headers }
      );
      if (!estRes.ok) throw new Error("Failed to resolve estate");
      const estRows = await estRes.json();
      const estateId = estRows[0]?.id;
      if (estateId == null) {
        parentBlockSelect.innerHTML = '<option value="">No blocks for this estate</option>';
        return;
      }

      const res = await fetch(
        `${base}/rest/v1/vsl_blocks?select=block_code&estate_id=eq.${estateId}`,
        { headers }
      );
      if (!res.ok) throw new Error("Failed to fetch blocks");

      const data = await res.json();
      const codes = [...new Set(data.map(d => d.block_code).filter(c => c != null && String(c).trim() !== ""))];
      codes.sort((a, b) => {
        const na = Number(String(a)), nb = Number(String(b));
        if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
        return String(a).localeCompare(String(b), undefined, { numeric: true });
      });

      parentBlockSelect.innerHTML = '<option value="">— Select Block —</option>';
      for (const code of codes) {
        const opt = document.createElement("option");
        opt.value = String(code).trim();
        opt.textContent = `Block ${String(code).trim()}`;
        parentBlockSelect.appendChild(opt);
      }
      if (keep && [...parentBlockSelect.options].some(o => o.value === keep)) {
        parentBlockSelect.value = keep;
      }
    } catch (e) {
      console.error("[Victoria Survey] Error fetching parent blocks:", e);
      parentBlockSelect.innerHTML = '<option value="">Error loading blocks</option>';
    }
  }

  // "+" button next to either estate dropdown — small in-app modal (same
  // pattern as promptForCrs/promptForStartingId below) that inserts a row
  // into vsl_estate via the authenticated Supabase client (RLS requires
  // ADMIN/SURVEYOR, same as everything else this panel can do), then
  // refreshes both dropdowns and selects the new estate.
  function promptCreateEstate() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.4); z-index:9999; display:flex; align-items:center; justify-content:center; backdrop-filter: blur(2px);";
      const modal = document.createElement("div");
      modal.style.cssText = "background:#fff; padding:20px; border-radius:8px; width:280px; max-width:90%; box-shadow:0 10px 25px rgba(0,0,0,0.15); font-family: system-ui, -apple-system, sans-serif;";
      modal.innerHTML = `
        <h4 style="margin:0 0 8px 0; font-size:1.1rem; color:#333;">New Estate</h4>
        <p style="margin:0 0 16px 0; font-size:0.85rem; color:#666;">Estate name</p>
        <input type="text" id="newEstateNameInput" placeholder="e.g. Lugazi" style="width:100%; padding:8px 12px; margin-bottom:20px; border:1px solid #ddd; border-radius:6px; font-size:1rem; box-sizing:border-box; outline:none;" />
        <div style="display:flex; justify-content:flex-end; gap:10px;">
          <button id="newEstateCancel" style="padding:8px 16px; border-radius:6px; background:#f1f3f5; color:#495057; border:none; cursor:pointer; font-size:0.9rem; font-weight:500;">Cancel</button>
          <button id="newEstateOk" style="padding:8px 16px; border-radius:6px; background:#28a745; color:#fff; border:none; cursor:pointer; font-size:0.9rem; font-weight:500;">Create</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      const input = document.getElementById("newEstateNameInput");
      input.focus();
      const cleanup = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
      document.getElementById("newEstateCancel").onclick = () => { cleanup(); resolve(null); };
      document.getElementById("newEstateOk").onclick = () => { const v = input.value.trim(); cleanup(); resolve(v || null); };
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") document.getElementById("newEstateOk").click();
        else if (e.key === "Escape") document.getElementById("newEstateCancel").click();
      });
    });
  }

  async function handleAddEstate(targetSelect) {
    const name = await promptCreateEstate();
    if (!name) return;
    if (!supabase) {
      setStatus(statusEl, "Can't create an estate — Supabase client not available.", true);
      return;
    }
    try {
      const { data, error } = await supabase
        .from("vsl_estate")
        .insert({ estate_name: name })
        .select("id, estate_name")
        .single();
      if (error) throw error;
      setStatus(statusEl, `Estate "${data.estate_name}" created.`);
      await refreshEstateOptions();
      if (targetSelect) {
        targetSelect.value = data.estate_name;
        targetSelect.dispatchEvent(new Event("change"));
      }
    } catch (e) {
      console.error("[Victoria Survey] Failed to create estate:", e);
      setStatus(statusEl, `Failed to create estate: ${e.message}`, true);
    }
  }

  blockEstateAddBtn?.addEventListener("click", () => handleAddEstate(blockEstateSelect));
  parcelEstateAddBtn?.addEventListener("click", () => handleAddEstate(surveyParcelEstateSelect));

  function updateLayerFields() {
    const v = layerSelect.value;
    blockFields.hidden = v !== "BLOCKS";
    parcelFields.hidden = v !== "PARCELS";
    if (v === "PARCELS") {
      refreshEstateOptions();
      // Reset block dropdown until estate chosen
      if (parentBlockSelect) {
        parentBlockSelect.innerHTML = '<option value="">— Select Estate first —</option>';
        parentBlockSelect.disabled = true;
      }
    }
    if (v === "BLOCKS") {
      refreshEstateOptions();
    }
  }

  function clearPreview() {
    polySource.clear(true);
    pointSource.clear(true);
    dxfSource.clear(true);

    parsedDxf = null;

    lastPreviewPayload = null;
    saveBtn.disabled = true;
  }

  // Plain text only — the <p class="uam-hint uam-hint--blue"> markup lives
  // once in survey-panel.html, not rebuilt per call, so every summary looks
  // identical no matter which code path renders it.
  function renderSummary(text) {
    summaryEl.hidden = !text;
    summaryEl.textContent = text || "";
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
      refreshEstateOptions();
      // Also refresh blocks if a parcel estate was already chosen
      if (surveyParcelEstateSelect?.value) {
        refreshParentBlockOptions(surveyParcelEstateSelect.value);
      }
    } else {
      toggleBtn.classList.remove("active");
    }
  }) // end toggleBtn click
  } // end hasToggle

  // Estate cascade for parcel import
  surveyParcelEstateSelect?.addEventListener("change", () => {
    refreshParentBlockOptions(surveyParcelEstateSelect.value);
  });

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
      const crs = dxfCrs;
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
        // DXF has no polygons of its own (just lines) — shown for reference
        // only. Use the Draw tab to create features on top of it.
        setStatus(statusEl, "DXF loaded (shown for reference). Use the Draw tab to create features.");
      }
    } catch(e) {
      console.error(e);
      setStatus(statusEl, "Failed to project DXF: " + e.message, true);
    }
  }

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
          ${CRS_OPTIONS.map(o => `<option value="${o.value}" ${o.value === dxfCrs ? "selected" : ""}>${o.label}</option>`).join('')}
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
      dxfCrs = chosenCrs;

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
          parsedDxf = { entities: [], _kmlFeatures: features };
          if (polySource.getFeatures().length > 0) {
            const ext = polySource.getExtent();
            if (ext && ext.every(Number.isFinite)) map.getView().fit(ext, { padding: [80,80,80,80], maxZoom: 18, duration: 400 });
            setStatus(statusEl, `KML loaded — ${polySource.getFeatures().length} polygon(s). Click Preview, then Save.`);
          } else {
            setStatus(statusEl, "No polygon features found in KML.", true);
          }
          renderSummary(`${features.length} KML feature(s) loaded.`);
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
          parsedDxf = { entities: [], _gjFeatures: features };
          if (polySource.getFeatures().length > 0) {
            const ext = polySource.getExtent();
            if (ext && ext.every(Number.isFinite)) map.getView().fit(ext, { padding: [80,80,80,80], maxZoom: 18, duration: 400 });
            setStatus(statusEl, `GeoJSON loaded — ${polySource.getFeatures().length} polygon(s). Click Preview, then Save.`);
          } else {
            setStatus(statusEl, "No polygon features found in GeoJSON.", true);
          }
          renderSummary(`${features.length} GeoJSON feature(s) loaded.`);
        } catch(e) {
          setStatus(statusEl, "GeoJSON parsing failed: " + e.message, true);
        }
      }
    } else {
      try {
        clearPreview();
        parsedRows = await parseCsvFile(file);
        const n = parsedRows.length;
        renderSummary(`${n} data row(s) read.`);
      } catch (e) {
        parsedRows = [];
        setStatus(statusEl, e.message, true);
        renderSummary("");
      }
    }
  }

  // Export so global drag and drop can use it. The file's extension alone
  // decides how it's parsed (see handleFile) — there's no format dropdown
  // to keep in sync anymore.
  window.handleGlobalSurveyDrop = async function(file) {
    if (window.openUamTab) {
      window.openUamTab("import");
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
      await handleFile(f);
    }
  });

  // KML/GeoJSON files already contain full polygons (no tracing needed) —
  // Preview just packages whatever's currently in polySource as the save
  // payload, the same shape the CSV edge-function preview produces.
  function previewLocalPolygons(layerType) {
    const gj = new ol.format.GeoJSON();
    const features = polySource.getFeatures();
    const results = features.map((f, i) => {
      const geom = f.getGeometry().clone().transform("EPSG:3857", "EPSG:4326");
      return {
        parcelId: f.get("parcelId") || `Feature ${i + 1}`,
        success: true,
        geometry: gj.writeGeometryObject(geom)
      };
    });

    const resolvedEstate = layerType === "BLOCKS"
      ? toTitleCase(blockEstateSelect?.value?.trim() || "")
      : (surveyParcelEstateSelect?.value?.trim() || "");

    lastPreviewPayload = {
      layerType,
      estate_name: resolvedEstate,
      parentBlockCode: parentBlockSelect?.value?.trim() || "",
      coordinateSystem: "EPSG:4326",
      additionalInfo: "",
      results
    };

    renderSummary(`Total Figures: ${results.length} ready to save.`);
    saveBtn.disabled = !results.length;
    setStatus(statusEl, "Preview ready. Verify on map, then save.");
  }

  // Wipes the plotted preview off the map AND resets the file picker back
  // to empty — clearPreview() alone (used elsewhere, e.g. on layer change)
  // deliberately leaves the loaded file in place, since a fresh file load
  // calls it too and shouldn't wipe itself.
  clearImportBtn?.addEventListener("click", () => {
    clearPreview();
    parsedRows = [];
    if (fileInput) fileInput.value = "";
    if (fileNameEl) fileNameEl.textContent = "Choose a file or drop it here…";
    renderSummary("");
    setStatus(statusEl, "Cleared.");
  });

  previewBtn?.addEventListener("click", async () => {
    if (getManagementLocked?.()) return;
    const layerType = layerSelect.value;
    if (!layerType) {
      setStatus(statusEl, "Select target layer (BLOCKS or PLOTS).", true);
      return;
    }
    if (layerType === "BLOCKS") {
      const estateName = blockEstateSelect?.value?.trim() || "";
      if (!estateName) {
        setStatus(statusEl, "Select an Estate before previewing blocks.", true);
        return;
      }
    }
    if (layerType === "PARCELS") {
      if (!surveyParcelEstateSelect?.value?.trim()) {
        setStatus(statusEl, "Select an Estate before previewing plots.", true);
        return;
      }
      if (!parentBlockSelect?.value?.trim()) {
        setStatus(statusEl, "Select a Block (within the chosen Estate) before previewing plots.", true);
        return;
      }
    }
    if (!parsedRows.length) {
      if (polySource.getFeatures().length) {
        // KML/GeoJSON — polygons are already parsed, no edge-function
        // round trip needed.
        previewLocalPolygons(layerType);
        return;
      }
      setStatus(
        statusEl,
        "Load a file with polygons first (CSV, KML, or GeoJSON). DXF files are shown for reference only.",
        true
      );
      return;
    }
    // CRS dropdown is gone — CSV eastings/northings default to UTM Zone 36N
    // (the surveyors' standard projected grid; matches DEFAULT_DXF_CRS used
    // for DXF/KML/GeoJSON below). The edge function reprojects server-side
    // via proj4 before validating/saving.
    const crs = "EPSG:32636";
    try {
      setStatus(statusEl, "Building preview…");
      const data = await callSurveyEdge(cfg, {
        action: "preview_batch",
        crs,
        rows: parsedRows,
        // Self-intersect check is always skipped now — it kept failing
        // imports whenever the surveyor forgot to tick the old checkbox.
        skipSelfIntersectionCheck: true
      });
      const { summary, results } = data;
      renderSummary(
        `Total Figures: ${summary.totalParcels}   Failed: ${summary.failedParcels}   Total points: ${summary.totalPoints}` +
          (summary.failedParcels > 0 ? "  — some plots failed validation." : "")
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

      const resolvedEstate = layerType === "BLOCKS"
        ? toTitleCase(blockEstateSelect?.value?.trim() || "")
        : (surveyParcelEstateSelect?.value?.trim() || "");

      lastPreviewPayload = {
        layerType,
        estate_name: resolvedEstate,
        parentBlockCode: parentBlockSelect?.value?.trim() || "",
        coordinateSystem: crs,
        additionalInfo: "",
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

  function promptForStartingId(layerType) {
    return new Promise((resolve) => {
      const isBlock = layerType === "BLOCKS";
      const title = isBlock ? "Starting Block ID" : "Starting Plot ID";
      const desc = isBlock ? "Provide the first ID to auto-number the rest (e.g. Block-1)" : "Provide the first ID to auto-number the rest (e.g. A1)";
      const placeholder = isBlock ? "Block-1" : "A1";

      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.4); z-index:9999; display:flex; align-items:center; justify-content:center; backdrop-filter: blur(2px);";
      
      const modal = document.createElement("div");
      modal.style.cssText = "background:#fff; padding:20px; border-radius:8px; width:280px; max-width:90%; box-shadow:0 10px 25px rgba(0,0,0,0.15); font-family: system-ui, -apple-system, sans-serif;";
      
      modal.innerHTML = `
        <h4 style="margin:0 0 8px 0; font-size:1.1rem; color:#333;">${title}</h4>
        <p style="margin:0 0 16px 0; font-size:0.85rem; color:#666;">${desc}</p>
        <input type="text" id="dxfStartIdPromptInput" placeholder="${placeholder}" style="width:100%; padding:8px 12px; margin-bottom:20px; border:1px solid #ddd; border-radius:6px; font-size:1rem; box-sizing:border-box; outline:none; transition:border-color 0.2s;" />
        <div style="display:flex; justify-content:flex-end; gap:10px;">
          <button id="dxfStartIdPromptCancel" style="padding:8px 16px; border-radius:6px; background:#f1f3f5; color:#495057; border:none; cursor:pointer; font-size:0.9rem; font-weight:500; transition:background 0.2s;">Cancel</button>
          <button id="dxfStartIdPromptOk" style="padding:8px 16px; border-radius:6px; background:#007bff; color:#fff; border:none; cursor:pointer; font-size:0.9rem; font-weight:500; transition:background 0.2s;">Save</button>
        </div>
      `;
      
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      
      const input = document.getElementById("dxfStartIdPromptInput");
      input.focus();
      
      input.addEventListener("focus", () => input.style.borderColor = "#007bff");
      input.addEventListener("blur", () => input.style.borderColor = "#ddd");
      
      const cleanup = () => {
        if (document.body.contains(overlay)) {
          document.body.removeChild(overlay);
        }
      };

      document.getElementById("dxfStartIdPromptCancel").onclick = () => {
        cleanup();
        resolve(null);
      };
      
      document.getElementById("dxfStartIdPromptOk").onclick = () => {
        cleanup();
        resolve(input.value);
      };
      
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          document.getElementById("dxfStartIdPromptOk").click();
        } else if (e.key === "Escape") {
          document.getElementById("dxfStartIdPromptCancel").click();
        }
      });
    });
  }

  saveBtn?.addEventListener("click", async () => {
    if (getManagementLocked?.() || !lastPreviewPayload) return;
    
    // Auto-generate labels for digitized/DXF imports
    if (parsedRows.length === 0) {
      const firstId = await promptForStartingId(lastPreviewPayload.layerType);
      if (firstId === null) {
        setStatus(statusEl, "Save cancelled.");
        return; // User cancelled
      }
      if (firstId.trim() !== "") {
        let prefix = "";
        let numStr = "";
        const match = firstId.trim().match(/^(.*?)(\d+)$/);
        if (match) {
          prefix = match[1];
          numStr = match[2];
        } else {
          prefix = firstId.trim();
          numStr = "1";
        }
        
        let currentNum = parseInt(numStr, 10);
        const numLength = numStr.length;
        
        lastPreviewPayload.results.forEach((r, idx) => {
          const seqNumStr = String(currentNum + idx).padStart(numLength, '0');
          r.parcelId = prefix + seqNumStr;
        });
      }
    }

    try {
      setStatus(statusEl, "Saving to database…");
      const data = await callSurveyEdge(cfg, {
        action: "commit_batch",
        layerType: lastPreviewPayload.layerType,
        // The edge function reads this into `projectName` (not
        // `estate_name`) — it was silently ignored before, and the RPC
        // would fall back to using the Notes field as a pseudo estate name.
        projectName: lastPreviewPayload.estate_name,
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
      const savedLayerType = lastPreviewPayload.layerType;
      polySource.clear(true);
      pointSource.clear(true);
      lastPreviewPayload = null;
      saveBtn.disabled = true;
      await loadLayersFromDb();
      // Refresh estate+block dropdowns after save
      await refreshEstateOptions();
      if (surveyParcelEstateSelect?.value) {
        await refreshParentBlockOptions(surveyParcelEstateSelect.value);
      }
      // A block's geom/estate_id feeds a DB trigger that recomputes the
      // parent estate's boundary (vsl_recompute_estate_geometry) — pull
      // that fresh geometry into the map's estate-outline layer, which
      // otherwise only ever loads once at boot.
      if (savedLayerType === "BLOCKS") {
        await refreshEstateBoundaries?.();
      }
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
