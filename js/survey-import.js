/**
 * Survey CSV import: left drawer UI + Edge Function preview/commit.
 */

import { CRS_OPTIONS, registerProj4Defs, toMap3857FromCrs } from "./crs-definitions.js";
import { confirmDanger, promptSelect, promptText } from "../popups/popup.js";
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

// KML's <LookAt> (or the newer <Camera>) is the author's intended "here's
// where to look" view — OpenLayers' KML reader only extracts Placemark
// geometries, not this, so we pull it straight out of the raw XML
// ourselves. Returns null if neither element is present.
function extractKmlLookAt(xmlText) {
  try {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const look = doc.querySelector("LookAt") || doc.querySelector("Camera");
    if (!look) return null;
    const lon = parseFloat(look.querySelector("longitude")?.textContent);
    const lat = parseFloat(look.querySelector("latitude")?.textContent);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const rangeText = look.querySelector("range")?.textContent ?? look.querySelector("altitude")?.textContent;
    const range = parseFloat(rangeText);
    return { lon, lat, range: Number.isFinite(range) ? range : 0 };
  } catch {
    return null;
  }
}

// Rough range(meters)->zoom heuristic — <LookAt>'s range is camera distance,
// not a standard web-map zoom level, so there's no exact conversion. Good
// enough to land in the right neighbourhood; plotFeaturesByGeometry's
// extent-fit (run right after, when there are actual placemarks) takes over
// for precise framing.
function zoomFromRange(range) {
  if (!range || range <= 0) return 15;
  return Math.min(19, Math.max(3, Math.round(24 - Math.log2(range))));
}

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
  const blockEstateManageBtn = document.getElementById("surveyBlockEstateManageBtn");
  const surveyParcelEstateSelect = document.getElementById("surveyParcelEstateSelect");
  const parcelEstateManageBtn = document.getElementById("surveyParcelEstateManageBtn");
  // Wraps surveyParcelEstateSelect + parcelEstateManageBtn — hidden as a
  // pair while "Automatically select" is checked (see applyAutoSelectState).
  const surveyParcelEstateRow = document.getElementById("surveyParcelEstateRow");
  const parentBlockSelect = document.getElementById("surveyParentBlockSelect");
  const autoSelectRow = document.getElementById("surveyAutoSelectRow");
  const autoSelectCb = document.getElementById("surveyAutoSelectCb");
  // Block-assignment review list — only used on the PLOTS + "Automatically
  // Choose Block" path (see runAutoAssign/renderAssignmentRows below).
  const assignPanel = document.getElementById("surveyAssignPanel");
  const assignScroll = document.getElementById("surveyAssignScroll");
  const assignCountEl = document.getElementById("surveyAssignCount");
  const assignExpandBtn = document.getElementById("surveyAssignExpandBtn");
  const assignMatchedWrap = document.getElementById("surveyAssignMatchedWrap");
  const assignMatchedEl = document.getElementById("surveyAssignMatched");
  const assignMatchedTitle = document.getElementById("surveyAssignMatchedTitle");
  const assignUnmatchedWrap = document.getElementById("surveyAssignUnmatchedWrap");
  const assignUnmatchedEl = document.getElementById("surveyAssignUnmatched");
  const assignUnmatchedTitle = document.getElementById("surveyAssignUnmatchedTitle");
  // Module-level (not a dropdown) — set by promptForCrs() when a DXF/KML/
  // GeoJSON file is loaded; CSV/digitized imports always use WGS84 below.
  let dxfCrs = DEFAULT_DXF_CRS;
  const fileInput = document.getElementById("surveyFileInput");
  // File selector doubles as the dropzone now — the separate #surveyDropzone
  // box was removed, drag/drop lands directly on this label.
  const dropzone = document.getElementById("surveyFileLabel");
  const summaryEl = document.getElementById("surveySummary");
  // One footer button now does Preview AND Save (see setPreviewBtnMode/
  // updateImportButtonsForFile below) — #surveySaveBtn no longer exists.
  const previewBtn = document.getElementById("surveyPreviewBtn");
  const clearImportBtn = document.getElementById("surveyClearBtn");
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
  // Tracks what's currently loaded so the footer button pair (Preview/Save
  // + Clear) know what state to be in — set by handleFile(), cleared by
  // resetImportUI().
  let fileLoaded = false;
  let currentFileKind = null; // "csv" | "kml" | "geojson" | "dxf"
  let previewBtnMode = "preview"; // "preview" | "save"

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

  // "+"/pencil button next to either estate dropdown — used to open a
  // quick add-estate prompt inline; now switches the Survey window to its
  // own Estates tab (js/manage-estates.js), which covers add + rename +
  // delete in one place. That tab dispatches "vsl-estates-changed" on any
  // change, which the listener below picks up to refresh both dropdowns
  // here.
  function openManageEstates() {
    window.openUamTab?.("estates");
  }
  blockEstateManageBtn?.addEventListener("click", openManageEstates);
  parcelEstateManageBtn?.addEventListener("click", openManageEstates);

  window.addEventListener("vsl-estates-changed", () => {
    refreshEstateOptions();
    if (surveyParcelEstateSelect?.value) {
      refreshParentBlockOptions(surveyParcelEstateSelect.value);
    }
  });

  // Estate name to send with a batch, per layer type — Blocks read their own
  // dedicated picker, Plots read theirs (or "" while "Automatically Choose
  // Block" has it disabled), and Titles never have one at all (no Estate
  // fields are even shown for TITLES — see updateLayerFields() below), so
  // this must NOT fall through to whatever's left over in
  // surveyParcelEstateSelect from an earlier Plots import this session.
  function resolveEstateNameFor(layerType) {
    if (layerType === "BLOCKS") return toTitleCase(blockEstateSelect?.value?.trim() || "");
    if (layerType === "PARCELS") return surveyParcelEstateSelect?.value?.trim() || "";
    return "";
  }

  function updateLayerFields() {
    const v = layerSelect.value;
    blockFields.hidden = v !== "BLOCKS";
    parcelFields.hidden = v !== "PARCELS";
    // "Automatically select" is Plots-only — hidden (and its effect
    // ignored, see doPreview()'s BLOCKS branch below) for BLOCKS.
    if (autoSelectRow) autoSelectRow.hidden = v !== "PARCELS";
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
    applyAutoSelectState();
  }

  // "Automatically select" checkbox — Plots-only (see updateLayerFields(),
  // which hides #surveyAutoSelectRow outside of PARCELS). When on, the Plot
  // Estate/Block pickers go inert — disabled, cleared, and relabelled to
  // "— Auto Estate —"/"— Auto Block —" so it's obvious neither is a real
  // pick — and doPreview()'s validation for them is skipped below. When
  // off, they're refetched/rebuilt back to their normal empty state
  // (refreshEstateOptions/refreshParentBlockOptions already own the
  // "— Select Estate —"/"— Select Estate first —" placeholders and the
  // disabled-until-an-Estate-is-chosen rule, so just delegate back to
  // them rather than duplicating that logic here). Blocks import never
  // consults this — its own Estate field is always required.
  function applyAutoSelectState() {
    const auto = !!autoSelectCb?.checked;
    // Estate select + its "Manage estates" button are wrapped together —
    // hidden as a pair. parentBlockSelect isn't wrapped, hidden directly.
    if (surveyParcelEstateRow) surveyParcelEstateRow.hidden = auto;
    if (parentBlockSelect) parentBlockSelect.hidden = auto;
    if (surveyParcelEstateSelect) {
      surveyParcelEstateSelect.disabled = auto;
      if (auto) {
        surveyParcelEstateSelect.innerHTML = '<option value="">— Auto Estate —</option>';
        surveyParcelEstateSelect.value = "";
      } else {
        refreshEstateOptions();
      }
    }
    if (parentBlockSelect) {
      if (auto) {
        parentBlockSelect.innerHTML = '<option value="">— Auto Block —</option>';
        parentBlockSelect.value = "";
        parentBlockSelect.disabled = true;
      } else {
        refreshParentBlockOptions(surveyParcelEstateSelect?.value?.trim() || "");
      }
    }
  }
  autoSelectCb?.addEventListener("change", () => {
    applyAutoSelectState();
    // Any assignment list on screen was resolved under the old setting —
    // drop it and make the user re-Preview rather than leaving stale rows
    // that no longer correspond to what Save would do.
    clearAssignments();
    setPreviewBtnMode("preview");
  });

  // ──────────────────────────────────────────────────────────────────────
  // Automatic block assignment
  //
  // With "Automatically Choose Block" ticked, Preview does its normal job
  // (geometry validation + plotting) and then asks the database which block
  // each plot falls inside — vsl_resolve_parcel_blocks, which tests
  // ST_Contains(block.geom, ST_PointOnSurface(plot.geom)). PointOnSurface
  // rather than a centroid: a centroid can land outside its own polygon when
  // the plot is concave, which would silently mis-assign it.
  //
  // Nothing is written at this stage. The answers are rendered as an
  // editable list (#surveyAssignPanel) so the user can verify them, override
  // any row, and fill in the plots that matched nothing, before Save commits
  // anything. Each row's chosen block is stashed as `block_id` directly on
  // its entry in lastPreviewPayload.results — not in a parallel array — so
  // it survives the parcelId rewriting that doSave's auto-numbering does.
  // ──────────────────────────────────────────────────────────────────────

  // The CSV's `id` column, as echoed back by the preview. Transient — it
  // groups rows into one polygon and labels things on screen, and is never
  // stored. `parcelId` is what the previous edge-function build emitted;
  // reading both means a response from a not-yet-updated function (or a
  // cached one) still works.
  function featureIdOf(result) {
    return result?.featureId ?? result?.parcelId ?? "";
  }

  // The CSV's `name` column — what actually becomes parcel_name / block_name.
  // `descriptions` is the old key, kept for the same reason.
  function featureNameOf(result) {
    return String(result?.name ?? result?.descriptions ?? "").trim();
  }

  // { result, matched, badGeometry, estateKey, blockId }
  let assignRows = [];
  let blockCatalog = [];
  let estateCatalog = [];
  // Blocks may have no estate at all (vsl_blocks.estate_id is nullable), and
  // an estate-first cascade would make those unreachable — they get their own
  // synthetic group instead.
  const NO_ESTATE_KEY = "__none__";

  function estateKeyOf(estateId) {
    return estateId == null || estateId === "" ? NO_ESTATE_KEY : String(estateId);
  }

  async function callRpc(fnName, body) {
    const base = cfg.SUPABASE_URL.replace(/\/$/, "");
    const res = await fetch(`${base}/rest/v1/rpc/${fnName}`, {
      method: "POST",
      headers: {
        "apikey": cfg.SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`${fnName} returned invalid JSON (HTTP ${res.status}).`);
    }
    if (!res.ok) {
      throw new Error(data?.message || data?.error || `${fnName} failed (HTTP ${res.status}).`);
    }
    return data;
  }

  function clearAssignments() {
    assignRows = [];
    blockCatalog = [];
    estateCatalog = [];
    if (assignMatchedEl) assignMatchedEl.innerHTML = "";
    if (assignUnmatchedEl) assignUnmatchedEl.innerHTML = "";
    if (assignMatchedWrap) assignMatchedWrap.hidden = true;
    if (assignUnmatchedWrap) assignUnmatchedWrap.hidden = true;
    if (assignPanel) assignPanel.hidden = true;
  }

  // Asks the database to place every previewed plot, then hands off to
  // renderAssignmentRows. `results` is the already-filtered list of previews
  // that actually produced geometry — index alignment with the response is
  // what links a row back to its result object.
  async function runAutoAssign(results) {
    clearAssignments();
    if (!results.length) return { matched: 0, unmatched: 0 };

    const features = results.map((r) => ({
      parcel_id: featureIdOf(r),
      geometry: r.geometry
    }));

    const data = await callRpc("vsl_resolve_parcel_blocks", { p_features: features });
    if (!data?.success) {
      throw new Error(data?.error || "Could not resolve blocks for these plots.");
    }

    blockCatalog = Array.isArray(data.blocks) ? data.blocks : [];
    estateCatalog = Array.isArray(data.estates) ? data.estates : [];
    const matches = Array.isArray(data.matches) ? data.matches : [];

    assignRows = results.map((result, i) => {
      const m = matches[i] || {};
      // Stamped onto the result object itself — this is what doSave reads.
      result.block_id = m.block_id || null;
      return {
        result,
        matched: !!m.block_id,
        badGeometry: !!m.bad_geometry,
        estateKey: estateKeyOf(m.estate_id),
        blockId: m.block_id || null
      };
    });

    renderAssignmentRows();
    return {
      matched: assignRows.filter((r) => r.blockId).length,
      unmatched: assignRows.filter((r) => !r.blockId).length
    };
  }

  function blocksForEstate(estateKey) {
    if (!estateKey) return [];
    return blockCatalog.filter((b) => estateKeyOf(b.estate_id) === estateKey);
  }

  // block_code is NOT unique across estates in this database (several blocks
  // share code "1"), so rows are keyed by block id and labelled with
  // block_name, falling back to the code only when a block has no name.
  function blockLabel(b) {
    const name = String(b.block_name ?? "").trim();
    const code = String(b.block_code ?? "").trim();
    if (name && code && name !== code) return `${name} (${code})`;
    return name || code || "Unnamed block";
  }

  function fillEstateOptions(sel, selectedKey) {
    sel.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "— Select Estate —";
    sel.appendChild(blank);

    for (const e of estateCatalog) {
      const opt = document.createElement("option");
      opt.value = String(e.id);
      opt.textContent = e.estate_name || `Estate ${e.id}`;
      sel.appendChild(opt);
    }
    if (blockCatalog.some((b) => b.estate_id == null)) {
      const opt = document.createElement("option");
      opt.value = NO_ESTATE_KEY;
      opt.textContent = "— No estate —";
      sel.appendChild(opt);
    }
    sel.value = selectedKey && [...sel.options].some((o) => o.value === selectedKey) ? selectedKey : "";
  }

  function fillBlockOptions(sel, estateKey, selectedBlockId) {
    sel.innerHTML = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = estateKey ? "— Select Block —" : "— Select Estate first —";
    sel.appendChild(blank);

    for (const b of blocksForEstate(estateKey)) {
      const opt = document.createElement("option");
      opt.value = String(b.id);
      opt.textContent = blockLabel(b);
      sel.appendChild(opt);
    }
    sel.disabled = !estateKey;
    sel.value =
      selectedBlockId && [...sel.options].some((o) => o.value === String(selectedBlockId))
        ? String(selectedBlockId)
        : "";
  }

  function paintRowState(rowEl, row) {
    const resolved = !!row.blockId;
    rowEl.classList.toggle("sa-row--unmatched", !row.matched && !resolved);
    rowEl.classList.toggle("sa-row--resolved", !row.matched && resolved);
    const blockSel = rowEl.querySelector(".sa-row__block");
    const estateSel = rowEl.querySelector(".sa-row__estate");
    blockSel?.classList.toggle("is-empty", !resolved);
    estateSel?.classList.toggle("is-empty", !row.estateKey);
  }

  // Zooms the map to a single plot so the user can eyeball the assignment
  // against the block boundaries underneath it. The preview polygons are
  // already in polySource, tagged with featureId.
  function zoomToPreviewFeature(featureId) {
    const feat = polySource.getFeatures().find((f) => f.get("featureId") === featureId);
    const geom = feat?.getGeometry();
    if (!geom) return;
    map.getView().fit(geom.getExtent(), { padding: [120, 120, 120, 120], maxZoom: 19, duration: 350 });
  }

  function buildRowEl(row, index) {
    const el = document.createElement("div");
    el.className = "sa-row";
    el.dataset.idx = String(index);

    const head = document.createElement("div");
    head.className = "sa-row__id";
    const label = document.createElement("span");
    // Two different things, both worth seeing: the CSV's parcel_id (the
    // grouping key, which is NOT saved) and the description, which becomes
    // the plot's name in the database.
    const fid = featureIdOf(row.result);
    const name = featureNameOf(row.result);
    label.textContent = name ? `${fid} · ${name}` : fid;
    label.title = name
      ? `CSV id: ${fid} — saved name: ${name}`
      : `CSV id: ${fid} — no name given, will be named after its generated code`;
    head.appendChild(label);

    const zoomBtn = document.createElement("button");
    zoomBtn.type = "button";
    zoomBtn.className = "sa-row__zoom";
    zoomBtn.title = "Zoom to this plot";
    zoomBtn.setAttribute("aria-label", `Zoom to ${fid}`);
    zoomBtn.innerHTML = '<i class="fas fa-crosshairs" aria-hidden="true"></i>';
    zoomBtn.addEventListener("click", () => zoomToPreviewFeature(fid));
    head.appendChild(zoomBtn);
    el.appendChild(head);

    const selects = document.createElement("div");
    selects.className = "sa-row__selects";

    const estateSel = document.createElement("select");
    estateSel.className = "sa-row__estate";
    fillEstateOptions(estateSel, row.estateKey);

    const blockSel = document.createElement("select");
    blockSel.className = "sa-row__block";
    fillBlockOptions(blockSel, row.estateKey, row.blockId);

    // Changing estate invalidates the block — repopulate and clear, rather
    // than leaving a block from a different estate selected.
    estateSel.addEventListener("change", () => {
      row.estateKey = estateSel.value || "";
      row.blockId = null;
      row.result.block_id = null;
      fillBlockOptions(blockSel, row.estateKey, null);
      paintRowState(el, row);
      updateAssignCount();
    });
    blockSel.addEventListener("change", () => {
      row.blockId = blockSel.value || null;
      row.result.block_id = row.blockId;
      paintRowState(el, row);
      updateAssignCount();
    });

    selects.appendChild(estateSel);
    selects.appendChild(blockSel);
    el.appendChild(selects);
    paintRowState(el, row);
    return el;
  }

  function updateAssignCount() {
    const assigned = assignRows.filter((r) => r.blockId).length;
    const pending = assignRows.length - assigned;
    if (assignCountEl) {
      assignCountEl.textContent = pending
        ? `${assigned} of ${assignRows.length} assigned · ${pending} pending`
        : `${assigned} of ${assignRows.length} assigned`;
    }
    if (assignUnmatchedTitle) {
      assignUnmatchedTitle.textContent = `Outside all blocks (${
        assignRows.filter((r) => !r.matched).length
      })`;
    }
  }

  function renderAssignmentRows() {
    if (!assignPanel) return;
    const matchedFrag = document.createDocumentFragment();
    const unmatchedFrag = document.createDocumentFragment();
    let matchedCount = 0;
    let unmatchedCount = 0;

    assignRows.forEach((row, i) => {
      const el = buildRowEl(row, i);
      // Grouping is by what the *database* found, not by what's currently
      // selected — a plot the user rescues by hand stays in the unmatched
      // group (turning green) so the list doesn't reshuffle under them
      // mid-edit.
      if (row.matched) {
        matchedFrag.appendChild(el);
        matchedCount++;
      } else {
        unmatchedFrag.appendChild(el);
        unmatchedCount++;
      }
    });

    assignMatchedEl.innerHTML = "";
    assignUnmatchedEl.innerHTML = "";
    assignMatchedEl.appendChild(matchedFrag);
    assignUnmatchedEl.appendChild(unmatchedFrag);
    assignMatchedWrap.hidden = matchedCount === 0;
    assignUnmatchedWrap.hidden = unmatchedCount === 0;
    if (assignMatchedTitle) assignMatchedTitle.textContent = `Matched (${matchedCount})`;
    assignPanel.hidden = assignRows.length === 0;
    updateAssignCount();
  }

  assignExpandBtn?.addEventListener("click", () => {
    const collapsed = !assignScroll.hidden;
    assignScroll.hidden = collapsed;
    assignExpandBtn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    assignExpandBtn.innerHTML = collapsed
      ? '<i class="fas fa-chevron-down" aria-hidden="true"></i>'
      : '<i class="fas fa-chevron-up" aria-hidden="true"></i>';
  });

  function clearPreview() {
    polySource.clear(true);
    pointSource.clear(true);
    dxfSource.clear(true);

    parsedDxf = null;

    clearAssignments();
    lastPreviewPayload = null;
    // previewBtn's enabled/mode state is no longer this function's job —
    // see updateImportButtonsForFile(), which callers invoke separately so
    // clearPreview() can still be used mid-load (e.g. re-parsing a file)
    // without prematurely disabling the button.
  }

  // Plain text only — the <p class="uam-hint uam-hint--blue"> markup lives
  // once in survey-panel.html, not rebuilt per call, so every summary looks
  // identical no matter which code path renders it.
  function renderSummary(text) {
    summaryEl.hidden = !text;
    summaryEl.textContent = text || "";
  }

  // Footer button (#surveyPreviewBtn) does double duty: "Preview" runs the
  // preview step, then — for CSV/GeoJSON only — flips to "Save", which
  // commits to the database. KML/DXF can only ever be previewed.
  function setPreviewBtnMode(mode) {
    previewBtnMode = mode;
    previewBtn.innerHTML = mode === "save"
      ? '<i class="fas fa-database" aria-hidden="true"></i> Save'
      : '<i class="fas fa-eye" aria-hidden="true"></i> Preview';
  }

  // Called whenever what's loaded changes (a new file, Clear, or a failed
  // preview) — always resets the button back to "Preview" mode, and only
  // enables it when something's loaded. KML/DXF stay enabled too — Preview
  // still does something useful for them (re-fits the map / confirms
  // what's shown, see doPreview) — it just never flips to Save.
  function updateImportButtonsForFile() {
    setPreviewBtnMode("preview");
    previewBtn.disabled = !fileLoaded;
    clearImportBtn.disabled = !fileLoaded;
  }

  // Wipes the plotted preview off the map AND resets the file picker back
  // to empty, plus both footer buttons back to their inactive starting
  // state — used by the Clear button and after a successful Save.
  function resetImportUI() {
    clearPreview();
    parsedRows = [];
    fileLoaded = false;
    currentFileKind = null;
    if (fileInput) fileInput.value = "";
    if (fileNameEl) fileNameEl.textContent = "Choose a file or drop it here…";
    renderSummary("");
    updateImportButtonsForFile();
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
    updateImportButtonsForFile();
  });

  // A LWPOLYLINE/POLYLINE is closed (i.e. an outline, not just a line) when
  // dxf-parser flags it (`shape`/`closed` — different dxf-parser versions
  // use different property names) or, failing that, when its first and
  // last vertex coincide.
  function isClosedDxfPolyline(ent) {
    if (ent.shape === true || ent.closed === true) return true;
    const v = ent.vertices;
    if (!v || v.length < 3) return false;
    const a = v[0], b = v[v.length - 1];
    return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;
  }

  // Plots every entity type dxf-parser hands back that we can meaningfully
  // show: LINE/POLYLINE/LWPOLYLINE as lines (or, if closed, as a filled
  // polygon outline), POINT as a point, and TEXT/MTEXT as a labelled point
  // at its insertion location. CIRCLE/ARC/SPLINE/INSERT (blocks) aren't
  // handled — reasonably rare in a survey DXF and a lot more work to
  // project correctly.
  async function renderDxf() {
    dxfSource.clear(true);
    pointSource.clear(true);
    polySource.clear(true);
    if (!parsedDxf) return;
    try {
      const crs = dxfCrs;
      const p4 = await getProj4();

      parsedDxf.entities.forEach(ent => {
        if ((ent.type === 'LINE' || ent.type === 'POLYLINE' || ent.type === 'LWPOLYLINE') && ent.vertices?.length) {
          const coords = ent.vertices.map(v => toMap3857FromCrs(p4, crs, v.x, v.y));
          if (ent.type !== 'LINE' && isClosedDxfPolyline(ent) && coords.length >= 3) {
            const ring = (coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1])
              ? coords
              : [...coords, coords[0]];
            polySource.addFeature(new ol.Feature({ geometry: new ol.geom.Polygon([ring]) }));
          } else {
            dxfSource.addFeature(new ol.Feature({ geometry: new ol.geom.LineString(coords) }));
          }
        } else if (ent.type === 'POINT' && ent.position) {
          const coord = toMap3857FromCrs(p4, crs, ent.position.x, ent.position.y);
          pointSource.addFeature(new ol.Feature({ geometry: new ol.geom.Point(coord) }));
        } else if ((ent.type === 'TEXT' || ent.type === 'MTEXT') && (ent.startPoint || ent.position || ent.insertionPoint)) {
          const p = ent.startPoint || ent.position || ent.insertionPoint;
          const coord = toMap3857FromCrs(p4, crs, p.x, p.y);
          const feat = new ol.Feature({ geometry: new ol.geom.Point(coord) });
          if (ent.text) feat.set("label", ent.text);
          pointSource.addFeature(feat);
        }
      });

      const extent = ol.extent.createEmpty();
      for (const src of [dxfSource, pointSource, polySource]) {
        for (const f of src.getFeatures()) {
          const g = f.getGeometry();
          if (g) ol.extent.extend(extent, g.getExtent());
        }
      }
      const total = dxfSource.getFeatures().length + pointSource.getFeatures().length + polySource.getFeatures().length;
      if (total > 0) {
        if (!ol.extent.isEmpty(extent) && extent.every(Number.isFinite)) {
          map.getView().fit(extent, { padding: [100, 100, 100, 220], maxZoom: 18, duration: 400 });
        }
        setStatus(statusEl, `DXF loaded (shown for reference) — ${total} entity(ies). Use the Draw tab to create features.`);
      } else {
        setStatus(statusEl, "DXF parsed, but no supported entities (line/polyline/point/text) were found.", true);
      }
    } catch(e) {
      console.error(e);
      setStatus(statusEl, "Failed to project DXF: " + e.message, true);
    }
  }

  function promptForCrs(filename) {
    return promptSelect({
      title: "DXF Coordinate System",
      message: `Select the coordinate system for ${filename}:`,
      options: CRS_OPTIONS,
      value: dxfCrs,
      confirmLabel: "Plot DXF"
    });
  }

  // Splits parsed KML/GeoJSON features across the three preview layers by
  // geometry type (points -> pointSource, lines -> dxfSource, polygons ->
  // polySource) and fits the map to whatever ended up plotted. Previously
  // this only ever kept polygons and silently dropped everything else —
  // which is exactly why Preview could fail with "load a file with
  // polygons first" even on a KML that clearly had placemarks, just not
  // polygon ones.
  function plotFeaturesByGeometry(features) {
    polySource.clear(true);
    pointSource.clear(true);
    dxfSource.clear(true);
    const counts = { point: 0, line: 0, polygon: 0 };
    for (const f of features) {
      const geom = f.getGeometry();
      if (!geom) continue;
      const type = geom.getType();
      if (type.includes("Polygon")) {
        polySource.addFeature(f);
        counts.polygon++;
      } else if (type.includes("LineString")) {
        dxfSource.addFeature(f);
        counts.line++;
      } else if (type.includes("Point")) {
        // KML/GeoJSON placemarks/features commonly carry a "name" — reuse
        // it as the point's label (same property CSV-preview vertex points
        // already use).
        const label = f.get("name");
        if (label) f.set("label", label);
        pointSource.addFeature(f);
        counts.point++;
      }
    }
    const extent = ol.extent.createEmpty();
    for (const src of [polySource, pointSource, dxfSource]) {
      for (const feat of src.getFeatures()) {
        const g = feat.getGeometry();
        if (g) ol.extent.extend(extent, g.getExtent());
      }
    }
    if (!ol.extent.isEmpty(extent) && extent.every(Number.isFinite)) {
      map.getView().fit(extent, { padding: [80, 80, 80, 80], maxZoom: 18, duration: 400 });
    }
    return counts;
  }

  async function handleFile(file) {
    if (!file) return;
    const name = file.name.toLowerCase();

    // Every new file selection starts from a clean slate. Without this, a
    // previously loaded file's parsedRows could survive into a new load —
    // e.g. load a CSV, then load a DXF: doPreview() checks
    // `parsedRows.length` to decide CSV-vs-local-polygons, so a leftover
    // CSV array would route the DXF straight into the CSV edge-function
    // preview path instead of the "DXF is preview-only" path. Resetting
    // (and re-disabling the buttons) here up front closes that gap
    // regardless of which branch below ends up running.
    parsedRows = [];
    fileLoaded = false;
    currentFileKind = null;
    clearPreview();
    updateImportButtonsForFile();

    if (name.endsWith(".kml")) {
      // KML is defined by its spec to always be WGS84 lon/lat (EPSG:4326) —
      // unlike DXF/GeoJSON, which have no such guarantee, there's nothing
      // to ask the user about.
      try {
        setStatus(statusEl, "Parsing KML…");
        const text = await file.text();
        const kmlFormat = new ol.format.KML({ extractStyles: false });
        const features = kmlFormat.readFeatures(text, { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" });

        // The author's intended view, if the file has one — set it first so
        // there's something sensible on screen even before/regardless of
        // what plotFeaturesByGeometry finds below.
        const lookAt = extractKmlLookAt(text);
        if (lookAt) {
          map.getView().animate({
            center: ol.proj.fromLonLat([lookAt.lon, lookAt.lat]),
            zoom: zoomFromRange(lookAt.range),
            duration: 400
          });
        }

        const counts = plotFeaturesByGeometry(features);
        parsedDxf = { entities: [], _kmlFeatures: features };
        const total = counts.point + counts.line + counts.polygon;

        if (total > 0) {
          setStatus(statusEl, `KML loaded — ${counts.polygon} polygon(s), ${counts.line} line(s), ${counts.point} point(s). Click Preview.`);
        } else if (lookAt) {
          setStatus(statusEl, "KML has a <LookAt>/<Camera> view but no plottable placemarks — zoomed there anyway.");
        } else {
          setStatus(statusEl, "No plottable placemarks (or <LookAt>) found in KML.", true);
        }
        fileLoaded = true;
        currentFileKind = "kml";
        renderSummary(`${total} feature(s) loaded (${counts.polygon} polygon, ${counts.line} line, ${counts.point} point). This kml file can only be previewed for drawing — it can't be saved.`);
        updateImportButtonsForFile();
      } catch(e) {
        setStatus(statusEl, "KML parsing failed: " + e.message, true);
      }
    } else if (name.endsWith(".dxf") || name.endsWith(".geojson") || name.endsWith(".json")) {
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
          await renderDxf();
          fileLoaded = true;
          currentFileKind = "dxf";
          renderSummary("This dxf file can only be previewed for drawing — it can't be saved. Click Preview to re-fit the map to it.");
          updateImportButtonsForFile();
        } catch(e) {
          setStatus(statusEl, "DXF parsing failed: " + e.message, true);
        }
      } else {
        // geojson
        try {
          setStatus(statusEl, "Parsing GeoJSON…");
          const text = await file.text();
          const gjFormat = new ol.format.GeoJSON();
          const features = gjFormat.readFeatures(text, { dataProjection: chosenCrs, featureProjection: "EPSG:3857" });
          const counts = plotFeaturesByGeometry(features);
          parsedDxf = { entities: [], _gjFeatures: features };
          const total = counts.point + counts.line + counts.polygon;
          setStatus(
            statusEl,
            total
              ? `GeoJSON loaded — ${counts.polygon} polygon(s), ${counts.line} line(s), ${counts.point} point(s). Click Preview${counts.polygon ? ", then Save" : ""}.`
              : "No plottable features found in GeoJSON.",
            !total
          );
          fileLoaded = true;
          currentFileKind = "geojson";
          renderSummary(`${total} feature(s) loaded (${counts.polygon} polygon, ${counts.line} line, ${counts.point} point).`);
          updateImportButtonsForFile();
        } catch(e) {
          setStatus(statusEl, "GeoJSON parsing failed: " + e.message, true);
        }
      }
    } else {
      try {
        clearPreview();
        parsedRows = await parseCsvFile(file);
        const n = parsedRows.length;
        fileLoaded = true;
        currentFileKind = "csv";
        renderSummary(`${n} data row(s) read.`);
        updateImportButtonsForFile();
      } catch (e) {
        parsedRows = [];
        fileLoaded = false;
        currentFileKind = null;
        setStatus(statusEl, e.message, true);
        renderSummary("");
        updateImportButtonsForFile();
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

  // KML/GeoJSON files already contain full geometry (no tracing needed) —
  // Preview just packages whatever's currently in polySource as the save
  // payload (the only geometry a Plot/Block can be saved as), the same
  // shape the CSV edge-function preview produces. Lines/points plotted
  // alongside it (see plotFeaturesByGeometry) are shown for reference only
  // — they're never save-eligible.
  async function previewLocalPolygons(layerType) {
    const gj = new ol.format.GeoJSON();
    const features = polySource.getFeatures();
    const results = features.map((f, i) => {
      const geom = f.getGeometry().clone().transform("EPSG:3857", "EPSG:4326");
      return {
        featureId: f.get("featureId") || `Feature ${i + 1}`,
        success: true,
        geometry: gj.writeGeometryObject(geom)
      };
    });
    const lineCount = dxfSource.getFeatures().length;
    const pointCount = pointSource.getFeatures().length;
    const refParts = [];
    if (lineCount) refParts.push(`${lineCount} line(s)`);
    if (pointCount) refParts.push(`${pointCount} point(s)`);
    const refSuffix = refParts.length ? ` (${refParts.join(", ")} also shown for reference.)` : "";

    // KML is preview-only (see the hint shown when it's loaded), and a
    // GeoJSON with no polygons at all has nothing save-eligible either —
    // both cases stay in Preview mode (never flip to Save), but the button
    // stays enabled so Preview can be clicked again to re-verify.
    if (currentFileKind === "kml" || !results.length) {
      renderSummary(
        `${results.length} polygon(s) previewed.${refSuffix}` +
          (currentFileKind === "kml"
            ? " This kml file can only be previewed for drawing — it can't be saved."
            : " No polygons found to save.")
      );
      setStatus(statusEl, currentFileKind === "kml" ? "Preview ready (view only — KML can't be saved)." : "Preview ready — nothing polygon-shaped to save.");
      return;
    }

    const resolvedEstate = resolveEstateNameFor(layerType);

    lastPreviewPayload = {
      layerType,
      estate_name: resolvedEstate,
      parentBlockCode: parentBlockSelect?.value?.trim() || "",
      coordinateSystem: "EPSG:4326",
      additionalInfo: "",
      results
    };

    // Plots + "Automatically Choose Block": resolve each polygon's block and
    // put the answers in the review list before Save becomes available.
    if (layerType === "PARCELS" && autoSelectCb?.checked) {
      try {
        setStatus(statusEl, "Matching plots to blocks…");
        const { matched, unmatched } = await runAutoAssign(results);
        renderSummary(
          `${results.length} polygon(s) previewed — ${matched} matched to a block` +
            (unmatched ? `, ${unmatched} outside all blocks.` : ".") +
            `${refSuffix}`
        );
        previewBtn.disabled = false;
        setPreviewBtnMode("save");
        setStatus(
          statusEl,
          unmatched
            ? `Review the assignments below — ${unmatched} plot(s) need a block.`
            : "All plots matched a block. Review below, then save."
        );
      } catch (e) {
        console.error("[Victoria Survey] Block auto-assign failed", e);
        clearAssignments();
        setStatus(statusEl, `Automatic block selection failed: ${e.message}`, true);
      }
      return;
    }

    renderSummary(`Total Figures: ${results.length} ready to save.${refSuffix}`);
    previewBtn.disabled = !results.length;
    if (results.length) setPreviewBtnMode("save");
    setStatus(statusEl, "Preview ready. Verify on map, then save.");
  }

  // Wipes the plotted preview off the map AND resets the file picker back
  // to empty, plus both footer buttons back to their inactive starting
  // state.
  clearImportBtn?.addEventListener("click", () => {
    resetImportUI();
    setStatus(statusEl, "Cleared.");
  });

  async function doPreview() {
    // DXF has no polygons and never gets saved — it's not tied to a
    // layer/estate/block at all, so skip straight past those checks.
    // Preview just re-runs the same render-and-fit step file load already
    // did, so clicking it re-confirms/re-zooms to what's on the map.
    if (currentFileKind === "dxf") {
      await renderDxf();
      const n = dxfSource.getFeatures().length + pointSource.getFeatures().length + polySource.getFeatures().length;
      renderSummary(
        n
          ? "This dxf file can only be previewed for drawing — it can't be saved."
          : "This DXF has no supported entities to show."
      );
      setStatus(statusEl, n ? `DXF previewed — zoomed to ${n} entity(ies).` : "DXF has nothing to preview.", !n);
      return;
    }
    // KML is likewise never saved, and isn't tied to a layer/estate/block
    // either — skip straight to plotting whatever it has (previewLocalPolygons
    // already handles "no polygons" gracefully for the preview-only case).
    if (currentFileKind === "kml") {
      await previewLocalPolygons(layerSelect.value || "");
      return;
    }
    const layerType = layerSelect.value;
    if (!layerType) {
      setStatus(statusEl, "Select target layer (BLOCKS, PLOTS, or LAND TITLES).", true);
      return;
    }
    if (layerType === "BLOCKS") {
      const estateName = blockEstateSelect?.value?.trim() || "";
      if (!estateName) {
        setStatus(statusEl, "Select an Estate before previewing blocks.", true);
        return;
      }
    }
    // "Automatically select" is Plots-only — skips the Estate/Block
    // requirement entirely, leaving whatever's resolving estate_name/
    // parentBlockCode downstream (still just reads the now-disabled,
    // likely-empty selects) to figure itself out rather than blocking
    // Preview/Save on a manual pick. Blocks import above always requires
    // its Estate regardless.
    const autoSelect = !!autoSelectCb?.checked;
    if (!autoSelect && layerType === "PARCELS") {
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
      // GeoJSON — already parsed (and split by geometry type into
      // polySource/pointSource/dxfSource, see plotFeaturesByGeometry), no
      // edge-function round trip needed. Any of the three counts as
      // "something to preview" now — previewLocalPolygons only requires
      // polySource specifically for the save payload.
      if (polySource.getFeatures().length || pointSource.getFeatures().length || dxfSource.getFeatures().length) {
        await previewLocalPolygons(layerType);
        return;
      }
      setStatus(
        statusEl,
        "Load a file with shapes first (CSV, KML, or GeoJSON).",
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
          { type: "Feature", geometry: r.geometry, properties: { featureId: featureIdOf(r) } },
          { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" }
        );
        polySource.addFeature(feat);
        const ring = r.geometry.coordinates[0];
        for (let i = 0; i < ring.length - 1; i++) {
          const [lon, lat] = ring[i];
          const pf = new ol.Feature({
            geometry: new ol.geom.Point(ol.proj.fromLonLat([lon, lat]))
          });
          // Vertex marker label: prefer the feature's real name, fall back to
          // the CSV id when the file didn't provide one.
          pf.set("label", featureNameOf(r) || featureIdOf(r));
          pointSource.addFeature(pf);
        }
      }
      if (validResults.length) {
        const extent = polySource.getExtent();
        if (extent && extent.every(Number.isFinite)) {
          map.getView().fit(extent, { padding: [100, 100, 100, 220], maxZoom: 18, duration: 400 });
        }
      }

      const resolvedEstate = resolveEstateNameFor(layerType);

      lastPreviewPayload = {
        layerType,
        estate_name: resolvedEstate,
        parentBlockCode: parentBlockSelect?.value?.trim() || "",
        coordinateSystem: crs,
        additionalInfo: "",
        results
      };

      // Plots + "Automatically Choose Block": ask the database which block
      // each previewed plot falls inside, then show the review list. Save
      // only unlocks once that has succeeded — committing with no
      // assignments at all would just fail server-side.
      if (layerType === "PARCELS" && autoSelect) {
        setStatus(statusEl, "Matching plots to blocks…");
        const { matched, unmatched } = await runAutoAssign(validResults);
        renderSummary(
          `Total Figures: ${summary.totalParcels}   Failed: ${summary.failedParcels}   ` +
            `Matched to a block: ${matched}` +
            (unmatched ? `   Outside all blocks: ${unmatched}` : "")
        );
        previewBtn.disabled = !validResults.length;
        if (validResults.length) setPreviewBtnMode("save");
        setStatus(
          statusEl,
          unmatched
            ? `Review the assignments below — ${unmatched} plot(s) need a block.`
            : "All plots matched a block. Review below, then save."
        );
        return;
      }

      previewBtn.disabled = !validResults.length;
      if (validResults.length) setPreviewBtnMode("save");
      setStatus(statusEl, "Preview ready. Verify on map, then save.");
    } catch (e) {
      clearPreview();
      updateImportButtonsForFile();
      console.error("[Victoria Survey] Preview failed", e);
      setStatus(statusEl, e.message, true);
    }
  }

  // Only reached for digitized/KML/GeoJSON imports, which have no description
  // column and therefore no name. CSV imports never see this — their names
  // come from `description`, and their codes are auto-numbered by the
  // database either way, so there is nothing left to ask about.
  function promptForStartingId(layerType) {
    const noun = layerType === "BLOCKS" ? "Block" : layerType === "TITLES" ? "Title" : "Plot";
    const example = layerType === "BLOCKS" ? "Block-1" : layerType === "TITLES" ? "Title-1" : "A1";
    return promptText({
      title: `Starting ${noun} Name`,
      message: `This file has no description column. Give the first ${noun.toLowerCase()} a name and the rest are numbered from it (e.g. ${example}). Codes are generated by the database.`,
      placeholder: example,
      // Blank is a valid, deliberate answer here ("don't name them, let each
      // one fall back to its generated code") — only Cancel/Escape should
      // resolve null.
      required: false
    });
  }

  async function doSave() {
    if (getManagementLocked?.() || !lastPreviewPayload) return;

    // Which previews are actually going to the database. Normally all of
    // them; on the auto-assign path, only the plots that ended up with a
    // block. Everything downstream (auto-numbering included) works off this
    // list so the numbering stays contiguous over what really gets saved.
    let resultsToSend = lastPreviewPayload.results;

    if (lastPreviewPayload.layerType === "PARCELS" && assignRows.length) {
      const assignable = assignRows.filter((r) => r.result.success && r.result.geometry);
      const discarded = assignable.filter((r) => !r.blockId);
      const keeping = assignable.filter((r) => r.blockId);

      if (!keeping.length) {
        setStatus(
          statusEl,
          "No plots have a block assigned — assign at least one before saving.",
          true
        );
        return;
      }

      if (discarded.length) {
        const names = discarded.map(
          (r) => featureNameOf(r.result) || featureIdOf(r.result)
        );
        const shown = names.slice(0, 8).join(", ");
        const more = names.length > 8 ? ` and ${names.length - 8} more` : "";
        const ok = await confirmDanger({
          title: "Discard unassigned plots?",
          message:
            `${discarded.length} plot(s) have no block and will NOT be saved: ${shown}${more}. ` +
            `${keeping.length} plot(s) will be saved. Assign a block to the rest first if you want to keep them.`,
          confirmLabel: `Discard ${discarded.length} & save ${keeping.length}`,
          icon: "fa-triangle-exclamation"
        });
        if (!ok) {
          setStatus(statusEl, "Save cancelled — no changes were made.");
          return;
        }
      }

      resultsToSend = keeping.map((r) => r.result);
    }

    // Auto-generate NAMES for digitized/KML/GeoJSON imports, which carry no
    // description column. CSV imports skip this — their names already came
    // from `description`. Codes are generated by the database in both cases.
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
        
        // Numbers only what's being saved — a plot dropped for having no
        // block shouldn't consume a number and leave a gap in the sequence.
        //
        // Writes `name`, which the commit RPC reads into parcel_name /
        // block_name. It used to write the id, back when that became the
        // database code; codes are auto-numbered server-side now, and the id
        // is only a transient grouping/display key.
        resultsToSend.forEach((r, idx) => {
          const seqNumStr = String(currentNum + idx).padStart(numLength, '0');
          r.name = prefix + seqNumStr;
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
        // Each entry may carry its own block_id (auto-assign path). The
        // commit RPC prefers that over parentBlockCode, so a single batch
        // can span as many blocks as the plots landed in.
        results: resultsToSend
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
      // Import's done — reset the file input, map preview, and both footer
      // buttons back to their inactive starting state, same as Clear.
      resetImportUI();
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
  }

  // One footer button, two modes — click routes to whichever step is
  // current (see setPreviewBtnMode). getManagementLocked is re-checked
  // inside doPreview/doSave too, but bail out here first either way.
  previewBtn?.addEventListener("click", async () => {
    if (getManagementLocked?.()) return;
    if (previewBtnMode === "save") {
      await doSave();
    } else {
      await doPreview();
    }
  });

  updateImportButtonsForFile();
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
