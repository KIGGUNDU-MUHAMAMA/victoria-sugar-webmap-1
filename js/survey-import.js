/**
 * Survey CSV import: left drawer UI + Edge Function preview/commit.
 */

import { CRS_OPTIONS } from "./crs-definitions.js";

function surveyFunctionUrl(cfg) {
  const base = (cfg.SUPABASE_URL || "").replace(/\/$/, "");
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
  const parentBlock = document.getElementById("surveyParentBlockCode");
  const crsSelect = document.getElementById("surveyCrsSelect");
  const additionalInfo = document.getElementById("surveyAdditionalInfo");
  const fileInput = document.getElementById("surveyFileInput");
  const dropzone = document.getElementById("surveyDropzone");
  const summaryEl = document.getElementById("surveySummary");
  const skipSelf = document.getElementById("surveySkipSelfIntersect");
  const previewBtn = document.getElementById("surveyPreviewBtn");
  const saveBtn = document.getElementById("surveySaveBtn");

  if (!drawer || !toggleBtn) return;

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

  let parsedRows = [];
  let lastPreviewPayload = null;

  function closeDrawer() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  }

  function updateLayerFields() {
    const v = layerSelect.value;
    blockFields.hidden = v !== "BLOCKS";
    parcelFields.hidden = v !== "PARCELS";
  }

  function clearPreview() {
    polySource.clear(true);
    pointSource.clear(true);
    lastPreviewPayload = null;
    saveBtn.disabled = true;
  }

  function renderSummary(html) {
    summaryEl.hidden = !html;
    summaryEl.innerHTML = html || "";
  }

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
    } else {
      toggleBtn.classList.remove("active");
    }
  });

  closeBtn?.addEventListener("click", () => {
    closeDrawer();
    toggleBtn.classList.remove("active");
  });

  layerSelect?.addEventListener("change", () => {
    updateLayerFields();
    clearPreview();
    renderSummary("");
  });

  async function handleFile(file) {
    if (!file) return;
    try {
      parsedRows = await parseCsvFile(file);
      const n = parsedRows.length;
      renderSummary(
        `<p><strong>${n}</strong> data row(s) read. Choose CRS and click <strong>Preview on map</strong>.</p>`
      );
      clearPreview();
    } catch (e) {
      parsedRows = [];
      setStatus(statusEl, e.message, true);
      renderSummary("");
    }
  }

  fileInput?.addEventListener("change", () => handleFile(fileInput.files?.[0]));

  dropzone?.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone?.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone?.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const f = e.dataTransfer?.files?.[0];
    if (f && (f.name.endsWith(".csv") || f.type === "text/csv")) {
      handleFile(f);
    } else {
      setStatus(statusEl, "Please drop a .csv file.", true);
    }
  });

  previewBtn?.addEventListener("click", async () => {
    if (getManagementLocked?.()) return;
    const layerType = layerSelect.value;
    if (!layerType) {
      setStatus(statusEl, "Select target layer (BLOCKS or PARCELS).", true);
      return;
    }
    if (layerType === "BLOCKS" && !projectName?.value?.trim()) {
      setStatus(statusEl, "Enter project name for BLOCKS import.", true);
      return;
    }
    if (layerType === "PARCELS" && !parentBlock?.value?.trim()) {
      setStatus(statusEl, "Enter parent block code for PARCELS import.", true);
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
        parentBlockCode: parentBlock?.value?.trim() || "",
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
            : "Nothing was saved (0 rows). For PARCELS, the parent block code must match an existing block exactly. Check the console for [Victoria Survey].";
        setStatus(statusEl, errMsg, true);
        return;
      }
      polySource.clear(true);
      pointSource.clear(true);
      lastPreviewPayload = null;
      saveBtn.disabled = true;
      await loadLayersFromDb();
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
}
