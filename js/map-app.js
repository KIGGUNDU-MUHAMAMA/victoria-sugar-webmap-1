import { createSupabaseClient, getConfig } from "./supabase-client.js";
import { clearStatus, parseNum, setStatus, vincentyDistanceMeters, computeUtmCartesianAreaAcres } from "./utils.js";
import { initSurveyImport } from "./survey-import.js";
import { initCoordSearchDrawer } from "./coord-search-drawer.js";
import { initCoordExtractDrawer } from "./coord-extract-drawer.js";
import { initPrintComposer } from "./print-composer.js";
import { initSentinelAnalytics } from "./sentinel-analytics.js?v=1.1";
import { initFarmReports } from "./farm-reports.js";
import { initUnifiedMenu } from "./unified-menu.js?v=1.7";
import { initDroneImageModule } from "./drone-image.js?v=1.6";
import { initExportTools } from "./export-tools.js";

const supabase = createSupabaseClient();
const cfg = getConfig();

const statusEl = document.getElementById("status");
const panelHost = document.getElementById("panelHost");

const measureLineBtn = document.getElementById("measureLineBtn");
const measureAreaBtn = document.getElementById("measureAreaBtn");
const measureAdvancedBtn = document.getElementById("measureAdvancedBtn");
const drawLineBtn = document.getElementById("drawLineBtn");
const drawPolygonBtn = document.getElementById("drawPolygonBtn");
const stopDrawBtn = document.getElementById("stopDrawBtn");
const snapBlocksCb = document.getElementById("snapBlocksCb");
const snapParcelsCb = document.getElementById("snapParcelsCb");
const snapSurveyCb = document.getElementById("snapSurveyCb");
const clearMeasuresBtn = document.getElementById("clearMeasuresBtn");
const clearDrawingsBtn = document.getElementById("clearDrawingsBtn");
const drawToolsFeedback = document.getElementById("drawToolsFeedback");
const measureFeedback = document.getElementById("measureFeedback");

const measureTopBtn = document.getElementById("measureTopBtn");
const measurePanel = document.getElementById("measurePanel");
const measurePanelCloseBtn = document.getElementById("measurePanelCloseBtn");
const panelButtons = {}; // draw tools now live in UAM; no legacy panel button needed

const locateBtn = document.getElementById("locateBtn");
const printBtn = document.getElementById("printBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const infoBtn = document.getElementById("infoBtn");
const logoutBtn = document.getElementById("logoutBtn");
const fallbackLayerSwitcherEl = document.getElementById("fallbackLayerSwitcher");

let map;
let currentUser;
let currentProfile;
let isAuthenticated = false;
let selectedFeature = null;
let selectedLayerType = null;
let activeInteraction = null;
let activeSnapInteractions = [];
let smartMeasureListener = null;
/** Survey CSV preview vector sources (for snap); set after initSurveyImport */
let surveyPreviewSnapSources = null;
let baseGroupRef;
let sentinelHubLayer;
let sentinelGroupRef;
let droneImagesGroupRef;
let annotationsGroupRef;
/** Set by initSentinelAnalytics so openSearchPanel can close the Sentinel dock. */
let vslCloseSentinelPanel = () => {};

const MAP_DRAW_PROJ = "EPSG:3857";

const blocksSource = new ol.source.Vector();
const parcelsSource = new ol.source.Vector();
const editSource = new ol.source.Vector();

/** Set by parcel search RPC; layer styles emphasize these ids after bbox reload. */
const searchHighlight = { blockId: null, parcelId: null };

/** Cultivation status → map colours (blocks & parcels when not search-highlighted). */
const CULTIVATION_PALETTE = {
  not_in_cane: { stroke: "#455a64", fill: "rgba(84, 110, 122, 0.32)", text: "#37474f" },
  prepared: { stroke: "#4e342e", fill: "rgba(93, 64, 55, 0.3)", text: "#3e2723" },
  planted: { stroke: "#1b5e20", fill: "rgba(46, 125, 50, 0.36)", text: "#1b5e20" },
  standing: { stroke: "#0d3d0d", fill: "rgba(13, 61, 13, 0.4)", text: "#0d2f0d" },
  harvested: { stroke: "#e65100", fill: "rgba(251, 192, 45, 0.42)", text: "#bf360c" },
  replant_renovation: { stroke: "#4a148c", fill: "rgba(106, 27, 154, 0.32)", text: "#4a148c" }
};

function cultivationKeyFromFeature(feature) {
  const s = feature.get("cultivation_status");
  return s && CULTIVATION_PALETTE[s] ? s : "not_in_cane";
}

const parcelStatusState = {
  panelOpen: false,
  pickArmed: false,
  selectedFeatures: [],
  selectedLayerType: "PARCELS"
};

const CULTIVATION_STATUS_LABELS = {
  not_in_cane: "Not in cane",
  prepared: "Prepared",
  planted: "Planted",
  standing: "Standing",
  harvested: "Harvested",
  replant_renovation: "Replant / renovation"
};

const INFO_FIELD_LABELS = {
  block_code: "Block code",
  block_name: "Block name",
  estate_name: "Estate",
  parcel_no: "Plot number",
  parcel_code: "Plot code",
  parcel_label: "Plot label",
  expected_area_acres: "Expected area",
  geometry_status: "Geometry status",
  cultivation_status: "Cultivation status",
  harvest_tonnes: "Harvest (tonnes cane)",
  last_harvest_date: "Last harvest date",
  cultivation_notes: "Notes",
  cultivation_updated_at: "Status last updated"
};

const INFO_BLOCK_FIELD_ORDER = [
  "estate_name",
  "block_name",
  "cultivation_status",
  "cultivation_updated_at"
];

const INFO_PARCEL_FIELD_ORDER = [
  "parcel_label",
  "block_code",
  "expected_area_acres",
  "cultivation_status"
];

let infoHelpPopoverOpen = false;
let infoHelpOutsideHandler = null;
let infoHelpEscapeHandler = null;

let searchPanelOpen = false;
let searchPanelOutsideHandler = null;
let searchPanelEscapeHandler = null;

// Legacy aliases kept for internal functions that still reference these names
let parcelSearchDockOpen = false;

let placeSearchOpen = false;

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInfoFieldValue(key, val) {
  if (val == null || val === "") return "—";
  if (key === "expected_area_acres" && Number.isFinite(Number(val))) {
    return `${Number(val).toFixed(2)} ac`;
  }
  if (key === "harvest_tonnes" && Number.isFinite(Number(val))) {
    return `${Number(val).toLocaleString(undefined, { maximumFractionDigits: 3 })} t`;
  }
  if (key === "cultivation_status") {
    return CULTIVATION_STATUS_LABELS[String(val)] || escapeHtml(val);
  }
  if (key === "last_harvest_date" || key === "cultivation_updated_at") {
    const t = String(val);
    return escapeHtml(t.length > 16 ? t.slice(0, 16) : t);
  }
  return escapeHtml(val);
}

function buildAdvancedModifyHtml(layerType, props, featureId, disableStr) {
  if (layerType === "BLOCKS") {
    return `
      <div style="margin-bottom:8px;">
        <label style="display:block;margin-bottom:4px;font-weight:600;">Block Name</label>
        <input type="text" class="popup-modify-bname" value="${escapeHtml(props.block_name || '')}" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
      </div>
      <div style="margin-bottom:8px;">
        <label style="display:block;margin-bottom:4px;font-weight:600;">Location / Address</label>
        <input type="text" class="popup-modify-loc" value="${escapeHtml(props.location_address || '')}" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
      </div>
      <div style="margin-bottom:8px; display:flex; gap:8px;">
        <div style="flex:1;">
          <label style="display:block;margin-bottom:4px;font-weight:600;">Soil Type</label>
          <input type="text" class="popup-modify-soil" value="${escapeHtml(props.soil_type || '')}" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
        </div>
        <div style="flex:1;">
          <label style="display:block;margin-bottom:4px;font-weight:600;">Soil pH</label>
          <input type="number" step="0.1" class="popup-modify-ph" value="${props.soil_ph || ''}" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
        </div>
      </div>
      <div style="margin-bottom:8px; display:flex; gap:8px;">
        <div style="flex:1;">
          <label style="display:block;margin-bottom:4px;font-weight:600;">Irrigation</label>
          <select class="popup-modify-irrigation" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
             <option value="" ${!props.irrigation_type ? 'selected' : ''}>-- Select --</option>
             <option value="drip" ${props.irrigation_type === 'drip' ? 'selected' : ''}>Drip</option>
             <option value="furrow" ${props.irrigation_type === 'furrow' ? 'selected' : ''}>Furrow</option>
             <option value="overhead" ${props.irrigation_type === 'overhead' ? 'selected' : ''}>Overhead</option>
             <option value="rainfed" ${props.irrigation_type === 'rainfed' ? 'selected' : ''}>Rainfed</option>
          </select>
        </div>
        <div style="flex:1;">
          <label style="display:block;margin-bottom:4px;font-weight:600;">Ownership</label>
          <select class="popup-modify-ownership" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
             <option value="" ${!props.ownership ? 'selected' : ''}>-- Select --</option>
             <option value="bought" ${props.ownership === 'bought' ? 'selected' : ''}>Bought</option>
             <option value="rented" ${props.ownership === 'rented' ? 'selected' : ''}>Rented</option>
          </select>
        </div>
      </div>
      <div style="margin-bottom:8px; display:flex; gap:8px;">
        <div style="flex:1;">
          <label style="display:block;margin-bottom:4px;font-weight:600;">Manager</label>
          <input type="text" class="popup-modify-mname" value="${escapeHtml(props.manager_name || '')}" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
        </div>
        <div style="flex:1;">
          <label style="display:block;margin-bottom:4px;font-weight:600;">Phone</label>
          <input type="text" class="popup-modify-mphone" value="${escapeHtml(props.manager_phone || '')}" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
        </div>
      </div>
      <hr style="margin:12px 0; border:none; border-top:1px solid var(--border);">
      <div style="display:flex;gap:8px;">
        <button type="button" class="btn-primary btn-save-feature" data-layer="${layerType}" data-id="${featureId}" style="flex:1;" ${disableStr}>Save changes</button>
        <button type="button" class="btn-delete-feature" data-layer="${layerType}" data-id="${featureId}" style="background:#dc3545;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:0.8rem;font-weight:600;flex:1;" ${disableStr}><i class="fas fa-trash-alt"></i> Delete</button>
      </div>
    `;
  }

  // PARCELS
  const ad = props.agronomy_data || {};
  return `
    <div style="margin-bottom:8px;">
      <label style="display:block;margin-bottom:4px;font-weight:600;">Plot label</label>
      <input type="text" class="popup-modify-label" value="${escapeHtml(props.parcel_label || '')}" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" placeholder="e.g. A1" ${disableStr}>
    </div>
    <div style="margin-bottom:8px; display:flex; gap:8px;">
      <div style="flex:1;">
        <label style="display:block;margin-bottom:4px;font-weight:600;">Planting Date</label>
        <input type="date" class="popup-modify-pdate" value="${props.planting_date || ''}" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
      </div>
      <div style="flex:1;">
        <label style="display:block;margin-bottom:4px;font-weight:600;">Ratoon #</label>
        <input type="number" min="0" class="popup-modify-ratoon" value="${props.ratoon_number || 0}" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
      </div>
    </div>
    <div style="margin-bottom:8px;">
      <label style="display:block;margin-bottom:4px;font-weight:600;">Cultivation status</label>
      <select class="popup-modify-status" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
         <option value="not_in_cane" ${props.cultivation_status === 'not_in_cane' ? 'selected' : ''}>Not in cane</option>
         <option value="prepared" ${props.cultivation_status === 'prepared' ? 'selected' : ''}>Prepared</option>
         <option value="planted" ${props.cultivation_status === 'planted' ? 'selected' : ''}>Planted</option>
         <option value="standing" ${props.cultivation_status === 'standing' ? 'selected' : ''}>Standing</option>
         <option value="harvested" ${props.cultivation_status === 'harvested' ? 'selected' : ''}>Harvested</option>
         <option value="replant_renovation" ${props.cultivation_status === 'replant_renovation' ? 'selected' : ''}>Replant / renovation</option>
      </select>
    </div>
    
    <div style="margin-bottom:8px; display:flex; gap:8px; background:#f4faf1; padding:8px; border-radius:6px; border:1px solid #c8d6c4;">
      <div style="flex:1;">
        <label style="display:block;margin-bottom:4px;font-weight:600;font-size:0.8rem;color:#2d6a3a;">Log Harvest</label>
        <input type="date" class="popup-modify-hdate" value="${props.last_harvest_date || ''}" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;margin-bottom:4px;" placeholder="Date" ${disableStr}>
        
        <div style="display:flex; border:1px solid var(--border); border-radius:4px; overflow:hidden;">
          <input type="number" step="0.01" class="popup-modify-tonnes" value="${props.harvest_tonnes || ''}" style="width:100%;padding:6px;border:none;" placeholder="Yield" ${disableStr}>
          <select class="popup-modify-unit" style="background:#eef5ec; border:none; border-left:1px solid var(--border); padding:0 4px;" ${disableStr}>
            <option value="tonnes">Tonnes</option>
            <option value="kg">Kg</option>
          </select>
        </div>
      </div>
    </div>
    
    <details style="margin-bottom:8px; border:1px solid var(--border); border-radius:4px; padding:4px;">
      <summary style="font-weight:600; cursor:pointer;">Inputs & Fertilizer</summary>
      <div style="margin-top:6px; display:flex; gap:8px;">
        <input type="text" class="popup-modify-ferttype" value="${escapeHtml(ad.fertilizer_type || '')}" placeholder="Type (e.g. NPK)" style="flex:1;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
        <div style="display:flex; border:1px solid var(--border); border-radius:4px; overflow:hidden; flex:1;">
          <input type="number" class="popup-modify-fertqty" value="${ad.fertilizer_quantity || ''}" placeholder="Qty" style="width:100%;padding:6px;border:none;" ${disableStr}>
          <select class="popup-modify-fertunit" style="background:#eef5ec; border:none; border-left:1px solid var(--border); padding:0 4px;" ${disableStr}>
            <option value="kg" ${ad.fertilizer_unit === 'kg' ? 'selected' : ''}>Kg</option>
            <option value="l" ${ad.fertilizer_unit === 'l' ? 'selected' : ''}>Liters</option>
          </select>
        </div>
      </div>
    </details>

    <details style="margin-bottom:8px; border:1px solid var(--border); border-radius:4px; padding:4px;">
      <summary style="font-weight:600; cursor:pointer;">Activities</summary>
      <div style="margin-top:6px;">
        <select class="popup-modify-activity" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;margin-bottom:4px;" ${disableStr}>
           <option value="">-- Select Activity --</option>
           <option value="land_prep" ${ad.current_activity === 'land_prep' ? 'selected' : ''}>Land Prep</option>
           <option value="bush_clearing" ${ad.current_activity === 'bush_clearing' ? 'selected' : ''}>Bush Clearing</option>
           <option value="ghasiya_collection" ${ad.current_activity === 'ghasiya_collection' ? 'selected' : ''}>Ghasiya Collection</option>
           <option value="repeating" ${ad.current_activity === 'repeating' ? 'selected' : ''}>Repeating</option>
           <option value="first_ploughing" ${ad.current_activity === 'first_ploughing' ? 'selected' : ''}>First Ploughing</option>
           <option value="second_ploughing" ${ad.current_activity === 'second_ploughing' ? 'selected' : ''}>Second Ploughing</option>
           <option value="harroe" ${ad.current_activity === 'harroe' ? 'selected' : ''}>Harroe</option>
           <option value="ridging" ${ad.current_activity === 'ridging' ? 'selected' : ''}>Ridging</option>
           <option value="planting" ${ad.current_activity === 'planting' ? 'selected' : ''}>Planting</option>
           <option value="medicine" ${ad.current_activity === 'medicine' ? 'selected' : ''}>Medicine</option>
           <option value="weeding" ${ad.current_activity === 'weeding' ? 'selected' : ''}>Weeding</option>
           <option value="spraying" ${ad.current_activity === 'spraying' ? 'selected' : ''}>Spraying</option>
           <option value="irrigation" ${ad.current_activity === 'irrigation' ? 'selected' : ''}>Irrigation</option>
           <option value="cultivating" ${ad.current_activity === 'cultivating' ? 'selected' : ''}>Cultivating</option>
           <option value="harvesting" ${ad.current_activity === 'harvesting' ? 'selected' : ''}>Harvesting</option>
           <option value="loading" ${ad.current_activity === 'loading' ? 'selected' : ''}>Loading</option>
           <option value="trans_line" ${ad.current_activity === 'trans_line' ? 'selected' : ''}>Trans Line</option>
        </select>
        <div style="display:flex; gap:8px; align-items:center;">
          <input type="text" class="popup-modify-assigned" value="${escapeHtml(ad.assigned_to || '')}" placeholder="Assigned To" style="flex:1;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
          <input type="number" class="popup-modify-progress" value="${ad.activity_status || ''}" placeholder="%" style="width:60px;padding:6px;border:1px solid var(--border);border-radius:4px;" ${disableStr}>
        </div>
      </div>
    </details>

    <div style="margin-bottom:12px;">
      <label style="display:block;margin-bottom:4px;font-weight:600;">General Notes / Issues</label>
      <textarea rows="2" class="popup-modify-notes" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:4px;" placeholder="Disease, theft, general notes…" ${disableStr}>${escapeHtml(props.cultivation_notes || '')}</textarea>
    </div>
    <div style="display:flex;gap:8px;">
      <button type="button" class="btn-primary btn-save-feature" data-layer="${layerType}" data-id="${featureId}" style="flex:1;" ${disableStr}>Save changes</button>
      <button type="button" class="btn-delete-feature" data-layer="${layerType}" data-id="${featureId}" style="background:#dc3545;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:0.8rem;font-weight:600;flex:1;" ${disableStr}><i class="fas fa-trash-alt"></i> Delete</button>
    </div>
  `;
}

// Badge/icon text shown in the panel's static popWinHead — kept alongside
// the field-order tables so both stay in one place.
const FEATURE_INFO_BADGE = { PARCELS: "Parcel", BLOCKS: "Block" };

function buildFeatureInfoPopupHtml(layerType, feature) {
  const props = feature.getProperties();
  const order = layerType === "PARCELS" ? INFO_PARCEL_FIELD_ORDER : INFO_BLOCK_FIELD_ORDER;
  const rows = order
    .map((key) => {
      let raw = props[key];
      if (key === "expected_area_acres") {
        surveyFeatureAreaAcresText(feature);
        const computed = feature.get("_computed_utm_area_acres");
        if (computed) raw = computed;
      }
      if (raw == null || raw === "") return null;
      const label = INFO_FIELD_LABELS[key] || key;
      const display = formatInfoFieldValue(key, raw);
      return `<tr><th>${escapeHtml(label)}</th><td>${display}</td></tr>`;
    })
    .filter(Boolean)
    .join("");
  const body = rows
    ? `<table class="map-popup__table"><tbody>${rows}</tbody></table>`
    : `<p class="map-popup__empty">No attributes loaded for this feature. Zoom in or reload layers.</p>`;

  const canEdit = currentProfile?.role === "ADMIN" || currentProfile?.role === "SURVEYOR";
  const readOnlyMsg = canEdit ? "" : `<div class="feature-info-readonly-msg">Sign in as Admin or Surveyor to modify.</div>`;
  const disableStr = canEdit ? "" : "disabled";

  // popWinHead (icon/title) and popWinTabs are static markup in
  // windows/feature-info-panel.html — this only rebuilds popWinBody's
  // content (the Info/Modify tab panes), via setFeatureInfoHeader() /
  // resetFeatureInfoTabs() in setupInfoPopup() below.
  return `
    <div class="map-popup__tab-content" id="popupTabInfo">
      <div class="map-popup__grid">${body}</div>
    </div>
    <div class="map-popup__tab-content" id="popupTabMore" hidden>
      ${readOnlyMsg}
      <div class="feature-info-modify-wrap">
        ${buildAdvancedModifyHtml(layerType, props, feature.getId(), disableStr)}
      </div>
    </div>`;
}

function surveyFeatureAreaAcresText(feature) {
  let areaAcres = feature.get("_computed_utm_area_acres");
  if (areaAcres !== undefined) {
    return areaAcres > 0 ? `${areaAcres.toFixed(2)} ac` : "";
  }
  const g = feature.getGeometry();
  if (!g) return "";
  areaAcres = 0;
  try {
    if (g.getType() === "Polygon") {
      const ring = g.getLinearRing(0);
      if (ring) {
        const lonLats = ring.getCoordinates().map(pt => ol.proj.transform(pt, MAP_DRAW_PROJ, "EPSG:4326"));
        areaAcres = computeUtmCartesianAreaAcres(lonLats);
      }
    } else if (g.getType() === "MultiPolygon") {
      const polys = g.getPolygons();
      for (const poly of polys) {
        const ring = poly.getLinearRing(0);
        if (ring) {
          const lonLats = ring.getCoordinates().map(pt => ol.proj.transform(pt, MAP_DRAW_PROJ, "EPSG:4326"));
          areaAcres += computeUtmCartesianAreaAcres(lonLats);
        }
      }
    }
  } catch {}
  feature.set("_computed_utm_area_acres", areaAcres, true);
  return areaAcres > 0 ? `${areaAcres.toFixed(2)} ac` : "";
}

const blocksLayer = new ol.layer.Vector({
  title: "BLOCKS",
  visible: true,
  declutter: true,
  source: blocksSource,
  style: (feature, resolution) => {
    const bid = feature.getId();
    const isSearchHi = searchHighlight.blockId != null && bid != null && String(bid) === String(searchHighlight.blockId);
    const isStatusHi = parcelStatusState.selectedLayerType === "BLOCKS" && parcelStatusState.selectedFeatures.some(f => String(f.getId()) === String(bid));
    const hi = isSearchHi || isStatusHi;
      
    const status = feature.get("cultivation_status");
    let fillColor = "rgba(255, 255, 255, 0.05)";
    let strokeColor = "#d32f2f"; 
    let strokeWidth = resolution > 25 && !hi ? 1.5 : (hi ? 5 : 3); 
    let textColor = "#d32f2f";
    
    if (status && CULTIVATION_PALETTE[status] && status !== "not_in_cane") {
      fillColor = CULTIVATION_PALETTE[status].fill;
    }

    let textStyle = null;
    if (hi || resolution <= 25) {
      const name = String(feature.get("block_name") ?? "").trim() || "—";
      textStyle = new ol.style.Text({
        text: name,
        font: hi ? "700 13px Inter, sans-serif" : "600 12px Inter, sans-serif",
        fill: new ol.style.Fill({ color: hi ? "#bf360c" : textColor }),
        stroke: new ol.style.Stroke({ color: "#ffffff", width: 3 }),
        overflow: true
      });
    }

    return new ol.style.Style({
      stroke: new ol.style.Stroke({ color: hi ? "#e65100" : strokeColor, width: strokeWidth }),
      fill: new ol.style.Fill({ color: hi ? "rgba(230, 81, 0, 0.14)" : fillColor }),
      text: textStyle
    });
  }
});

const parcelsLayer = new ol.layer.Vector({
  title: "PARCELS",
  visible: true,
  declutter: true,
  source: parcelsSource,
  style: (feature, resolution) => {
    const pid = feature.getId();
    const isSearchHi = searchHighlight.parcelId != null && pid != null && String(pid) === String(searchHighlight.parcelId);
    const isStatusHi = parcelStatusState.selectedLayerType === "PARCELS" && parcelStatusState.selectedFeatures.some(f => String(f.getId()) === String(pid));
    const hi = isSearchHi || isStatusHi;
      
    const status = feature.get("cultivation_status");
    let fillColor = "rgba(255, 255, 255, 0.05)";
    let strokeColor = "#2e7d32"; 
    let strokeWidth = resolution > 12 && !hi ? 1 : (hi ? 4 : 2);
    let textColor = "#2e7d32";

    if (status && CULTIVATION_PALETTE[status] && status !== "not_in_cane") {
      fillColor = CULTIVATION_PALETTE[status].fill;
    }

    const styles = [];

    styles.push(new ol.style.Style({
      stroke: new ol.style.Stroke(
        hi ? { color: "#ffffff", width: strokeWidth + 2 } : { color: "#ffffff", width: strokeWidth + 1.5 }
      ),
      fill: new ol.style.Fill({
        color: hi ? "rgba(249, 168, 37, 0.38)" : fillColor
      })
    }));

    let textStyle = null;
    if (hi || resolution <= 12) {
      const pLabel = feature.get("parcel_label") || feature.get("parcel_no");
      const label = pLabel != null && pLabel !== "" ? String(pLabel) : "—";
      const expArea = feature.get("expected_area_acres");
      const area = expArea ? `${Number(expArea).toFixed(2)} ac` : surveyFeatureAreaAcresText(feature);
      const text = area ? `${label}\n${area}` : label;

      textStyle = new ol.style.Text({
        text,
        font: hi ? "700 12px Inter, sans-serif" : "600 11px Inter, sans-serif",
        fill: new ol.style.Fill({ color: hi ? "#f57f17" : textColor }),
        stroke: new ol.style.Stroke({ color: "#ffffff", width: hi ? 4 : 3 }),
        overflow: true
      });
    }

    styles.push(new ol.style.Style({
      stroke: new ol.style.Stroke({ color: hi ? "#f9a825" : strokeColor, width: strokeWidth }),
      text: textStyle
    }));

    if (hi || resolution <= 4) {
      const geometry = feature.getGeometry();
      if (geometry && geometry.getType() === "Polygon") {
        const ring = geometry.getLinearRing(0);
        if (ring) {
          const coords = ring.getCoordinates();
          for (let i = 0; i < coords.length - 1; i++) {
            const pt1 = coords[i];
            const pt2 = coords[i + 1];
            const p1LonLat = ol.proj.transform(pt1, MAP_DRAW_PROJ, "EPSG:4326");
            const p2LonLat = ol.proj.transform(pt2, MAP_DRAW_PROJ, "EPSG:4326");
            const distMeters = vincentyDistanceMeters(p1LonLat[0], p1LonLat[1], p2LonLat[0], p2LonLat[1]);
            
            if (distMeters > 0) {
              const segment = new ol.geom.LineString([pt1, pt2]);
              styles.push(new ol.style.Style({
                geometry: segment,
                text: new ol.style.Text({
                  text: `${distMeters.toFixed(1)}m`,
                  font: "600 10px Inter, sans-serif",
                  fill: new ol.style.Fill({ color: "#1976d2" }),
                  stroke: new ol.style.Stroke({ color: "#ffffff", width: 3 }),
                  placement: "line",
                  textBaseline: "bottom",
                  offsetY: -2
                })
              }));
            }
          }
        }
      } else if (geometry && geometry.getType() === "MultiPolygon") {
        const polys = geometry.getPolygons();
        for (const poly of polys) {
          const ring = poly.getLinearRing(0);
          if (ring) {
            const coords = ring.getCoordinates();
            for (let i = 0; i < coords.length - 1; i++) {
              const pt1 = coords[i];
              const pt2 = coords[i + 1];
              const p1LonLat = ol.proj.transform(pt1, MAP_DRAW_PROJ, "EPSG:4326");
              const p2LonLat = ol.proj.transform(pt2, MAP_DRAW_PROJ, "EPSG:4326");
              const distMeters = vincentyDistanceMeters(p1LonLat[0], p1LonLat[1], p2LonLat[0], p2LonLat[1]);
              if (distMeters > 0) {
                const segment = new ol.geom.LineString([pt1, pt2]);
                styles.push(new ol.style.Style({
                  geometry: segment,
                  text: new ol.style.Text({
                    text: `${distMeters.toFixed(1)}m`,
                    font: "600 10px Inter, sans-serif",
                    fill: new ol.style.Fill({ color: "#1976d2" }),
                    stroke: new ol.style.Stroke({ color: "#ffffff", width: 3 }),
                    placement: "line",
                    textBaseline: "bottom",
                    offsetY: -2
                  })
                }));
              }
            }
          }
        }
      }
    }

    return styles;
  }
});

const sketchLayer = new ol.layer.Vector({
  title: "Draw and Measure",
  visible: true,
  source: editSource,
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: "#8d6a3a", width: 2, lineDash: [6, 4] }),
    fill: new ol.style.Fill({ color: "rgba(141, 106, 58, 0.15)" })
  })
});
sketchLayer.setZIndex(920);

const measureSource = new ol.source.Vector();

function formatGroundLengthM(m) {
  if (!Number.isFinite(m)) return "—";
  if (m >= 1000) return `${(m / 1000).toFixed(3)} km`;
  if (m >= 1) return `${m.toFixed(1)} m`;
  return `${m.toFixed(2)} m`;
}

function buildLineMeasureStyles(feature) {
  const geometry = feature.getGeometry();
  if (!geometry || geometry.getType() !== "LineString") return [];
  const coords = geometry.getCoordinates();
  const styles = [
    new ol.style.Style({
      geometry,
      stroke: new ol.style.Stroke({ color: "#5d4037", width: 3 }),
      zIndex: 0
    })
  ];
  for (let i = 0; i < coords.length - 1; i += 1) {
    const seg = new ol.geom.LineString([coords[i], coords[i + 1]]);
    const lenM = ol.sphere.getLength(seg, { projection: MAP_DRAW_PROJ });
    const mid = seg.getCoordinateAt(0.5);
    styles.push(
      new ol.style.Style({
        geometry: new ol.geom.Point(mid),
        text: new ol.style.Text({
          text: formatGroundLengthM(lenM),
          font: "600 11px Inter, system-ui, sans-serif",
          fill: new ol.style.Fill({ color: "#1d2a1d" }),
          stroke: new ol.style.Stroke({ color: "#fff", width: 3 }),
          padding: [2, 4, 2, 4]
        }),
        zIndex: 2
      })
    );
  }
  return styles;
}

function buildAreaMeasureStyles(feature) {
  const geometry = feature.getGeometry();
  if (!geometry || geometry.getType() !== "Polygon") return [];
  
  let areaAcres = 0;
  try {
    const ring = geometry.getLinearRing(0);
    if (ring) {
      const lonLats = ring.getCoordinates().map(pt => ol.proj.transform(pt, MAP_DRAW_PROJ, "EPSG:4326"));
      areaAcres = computeUtmCartesianAreaAcres(lonLats);
    }
  } catch {}
  
  if (!areaAcres || areaAcres <= 0) {
    const areaM2 = ol.sphere.getArea(geometry, { projection: MAP_DRAW_PROJ });
    areaAcres = (areaM2 / 10000) * 2.47105;
  }

  const ip = geometry.getInteriorPoint();
  const styles = [
    new ol.style.Style({
      geometry,
      stroke: new ol.style.Stroke({ color: "#4e342e", width: 2.5 }),
      fill: new ol.style.Fill({ color: "rgba(78, 52, 46, 0.14)" }),
      zIndex: 0
    }),
    new ol.style.Style({
      geometry: ip,
      text: new ol.style.Text({
        text: `${areaAcres.toFixed(2)} ac`,
        font: "700 12px Inter, system-ui, sans-serif",
        fill: new ol.style.Fill({ color: "#3e2723" }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 4 })
      }),
      zIndex: 2
    })
  ];

  // Draw segment lengths along the perimeter
  const ring = geometry.getLinearRing(0);
  if (ring) {
    const coords = ring.getCoordinates();
    for (let i = 0; i < coords.length - 1; i += 1) {
      const seg = new ol.geom.LineString([coords[i], coords[i + 1]]);
      const lenM = ol.sphere.getLength(seg, { projection: MAP_DRAW_PROJ });
      const mid = seg.getCoordinateAt(0.5);
      styles.push(
        new ol.style.Style({
          geometry: new ol.geom.Point(mid),
          text: new ol.style.Text({
            text: formatGroundLengthM(lenM),
            font: "600 11px Inter, system-ui, sans-serif",
            fill: new ol.style.Fill({ color: "#3e2723" }),
            stroke: new ol.style.Stroke({ color: "#fff", width: 3 }),
            padding: [2, 4, 2, 4]
          }),
          zIndex: 2
        })
      );
    }
  }

  return styles;
}

const measureLayer = new ol.layer.Vector({
  title: "Measurements",
  visible: true,
  source: measureSource,
  style: (feature) => {
    const k = feature.get("_measureKind");
    if (k === "distance") return buildLineMeasureStyles(feature);
    if (k === "area") return buildAreaMeasureStyles(feature);
    return [];
  }
});
measureLayer.setZIndex(930);
measureLayer.set("displayInLayerSwitcher", false);

function createBasemapLayer(title, source, visible = false) {
  return new ol.layer.Tile({
    title,
    type: "base",
    visible,
    source
  });
}

function buildLayerTree() {
  const osmBasemap = createBasemapLayer(
    "OpenStreetMap",
    new ol.source.OSM()
  );
  const googleHybrid = createBasemapLayer("Google Satellite Hybrid", new ol.source.XYZ({
    url: "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
    crossOrigin: "anonymous"
  }), false);
  const esriImagery = createBasemapLayer("Esri World Imagery", new ol.source.XYZ({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    crossOrigin: "anonymous"
  }), true);
  const noBasemap = createBasemapLayer("No Basemap", new ol.source.XYZ({
    url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
  }));

  // BASE MAPS Group
  const baseGroup = new ol.layer.Group({
    title: "Base Maps",
    fold: "open",
    layers: [osmBasemap, googleHybrid, esriImagery, noBasemap]
  });
  baseGroupRef = baseGroup;

  // DRONE IMAGES Group
  const droneGroup = new ol.layer.Group({
    title: "DRONE IMAGES",
    type: 'overlay',
    combine: true,
    fold: "open",
    layers: [],
    visible: false,
    zIndex: 5
  });
  droneGroup.set("displayInLayerSwitcher", true);
  droneImagesGroupRef = droneGroup;

  // SENTINEL Group (Radio buttons via type='base-group')
  const sentinelGroup = new ol.layer.Group({
    title: "SENTINEL",
    fold: "open",
    // We do NOT set combine: true so it shows children.
    // By setting type to "base-group" or having children with type="base" 
    // ol-layerswitcher will render them as radio buttons.
    layers: [],
    zIndex: 10
  });
  sentinelGroupRef = sentinelGroup;

  // SURVEY LAYERS Group
  const overlaysGroup = new ol.layer.Group({
    title: "SURVEY LAYERS",
    fold: "open",
    layers: [blocksLayer, parcelsLayer]
  });
  overlaysGroup.setZIndex(20);

  // ANNOTATIONS Group
  sketchLayer.set("displayInLayerSwitcher", true);
  measureLayer.set("displayInLayerSwitcher", true);
  const annotationsGroup = new ol.layer.Group({
    title: "ANNOTATIONS",
    fold: "open",
    layers: [sketchLayer, measureLayer]
  });
  annotationsGroup.setZIndex(30);
  annotationsGroupRef = annotationsGroup;

  // Order on map (bottom to top). Layer switcher shows reverse (top to bottom).
  // 1. baseGroup
  // 2. droneGroup
  // 3. sentinelGroup
  // 4. overlaysGroup (Survey Layers)
  // 5. annotationsGroup
  const stack = [baseGroup];
  stack.push(droneGroup, sentinelGroup, overlaysGroup, annotationsGroup);
  
  return stack;
}

function setBasemapByTitle(targetTitle) {
  if (!baseGroupRef) return;
  baseGroupRef.getLayers().forEach((layer) => {
    layer.setVisible(layer.get("title") === targetTitle);
  });
}

function enableFallbackLayerSwitcher() {
  if (!fallbackLayerSwitcherEl) return;
  fallbackLayerSwitcherEl.hidden = false;
  const fbBlocks = document.getElementById("fbBlocks");
  const fbParcels = document.getElementById("fbParcels");
  fbBlocks?.addEventListener("change", () => blocksLayer.setVisible(fbBlocks.checked));
  fbParcels?.addEventListener("change", () => parcelsLayer.setVisible(fbParcels.checked));

  fallbackLayerSwitcherEl.querySelectorAll("input[name='fbBasemap']").forEach((radio) => {
    radio.addEventListener("change", () => {
      if (radio.checked) setBasemapByTitle(radio.value);
    });
  });
}

function setActivePanel(panelId) {
  closeParcelStatusPanel();
  closeInfoHelpPopover();
  closePlaceSearchCard();
  vslCloseSentinelPanel();
  closeSearchPanel({ clearHighlight: true });

  window.dispatchEvent(new CustomEvent("vsl-force-close-extract-drawer"));

  const extractBtn = document.getElementById("coordExtractorMainBtn");
  extractBtn?.classList.remove("active");

  panelHost.classList.add("visible");
  for (const panel of panelHost.querySelectorAll(".panel")) {
    panel.classList.toggle("active", panel.id === panelId);
  }
  for (const [btnId, pId] of Object.entries(panelButtons)) {
    document.getElementById(btnId)?.classList.toggle("active", pId === panelId);
  }
  syncDrawToolsMapInset();
}

function setDrawToolsFeedback(message, isError) {
  if (drawToolsFeedback) {
    drawToolsFeedback.textContent = message;
    drawToolsFeedback.style.color = isError ? "var(--danger)" : "var(--primary-2)";
  }
  if (measureFeedback) {
    measureFeedback.textContent = message;
    measureFeedback.style.color = isError ? "var(--danger)" : "var(--primary-2)";
  }
}

function syncDrawToolsMapInset() {
  const wrap = document.querySelector(".map-viewport-wrap");
  if (!wrap) return;
  const drawOpen =
    panelHost.classList.contains("visible") &&
    document.getElementById("drawingPanel")?.classList.contains("active");
  wrap.classList.toggle("map-viewport-wrap--draw-dock", !!drawOpen);
  requestAnimationFrame(() => {
    map?.updateSize();
  });
}

function readSnapOptions() {
  return {
    snapBlocks: !!snapBlocksCb?.checked,
    snapParcels: !!snapParcelsCb?.checked,
    snapSurvey: !!snapSurveyCb?.checked
  };
}

function detachSnapInteractions() {
  if (!map) return;
  for (const s of activeSnapInteractions) {
    map.removeInteraction(s);
  }
  activeSnapInteractions = [];
}

function attachSnapInteractions(opts) {
  try {
    detachSnapInteractions();
    if (!map || !opts) return;
    const tol = 12;

    if (opts.snapAllVisible) {
      const getVisibleVectorSources = (group) => {
        let sources = [];
        if (!group || typeof group.getLayers !== "function") return sources;
        group.getLayers().forEach((layer) => {
          try {
            if (!layer || typeof layer.getVisible !== "function" || !layer.getVisible()) return;
            if (layer instanceof ol.layer.Group) {
              sources = sources.concat(getVisibleVectorSources(layer));
            } else if (layer instanceof ol.layer.Vector) {
              const src = layer.getSource();
              if (src) sources.push(src);
            }
          } catch (e) {
            console.warn("Error checking layer in snap setup:", e);
          }
        });
        return sources;
      };
      
      const visibleSources = getVisibleVectorSources(map.getLayerGroup());
      for (const src of visibleSources) {
        try {
          activeSnapInteractions.push(new ol.interaction.Snap({ source: src, pixelTolerance: tol }));
        } catch (e) {
          console.warn("Error creating snap interaction:", e);
        }
      }
    } else {
      if (opts.snapBlocks && blocksSource) {
        activeSnapInteractions.push(new ol.interaction.Snap({ source: blocksSource, pixelTolerance: tol }));
      }
      if (opts.snapParcels && parcelsSource) {
        activeSnapInteractions.push(new ol.interaction.Snap({ source: parcelsSource, pixelTolerance: tol }));
      }
      if (opts.snapSurvey && surveyPreviewSnapSources) {
        activeSnapInteractions.push(
          new ol.interaction.Snap({ source: surveyPreviewSnapSources.polySource, pixelTolerance: tol })
        );
        activeSnapInteractions.push(
          new ol.interaction.Snap({ source: surveyPreviewSnapSources.pointSource, pixelTolerance: tol })
        );
      }
    }

    for (const s of activeSnapInteractions) {
      map.addInteraction(s);
    }
  } catch (err) {
    console.error("Error in attachSnapInteractions:", err);
  }
}

function closeDrawToolsPanel() {
  stopActiveTool();
  panelHost.classList.remove("visible");
  for (const p of panelHost.querySelectorAll(".panel")) p.classList.remove("active");
  for (const bId of Object.keys(panelButtons)) {
    document.getElementById(bId)?.classList.remove("active");
  }
  syncDrawToolsMapInset();
}

function setupPanels() {
  for (const [btnId, panelId] of Object.entries(panelButtons)) {
    document.getElementById(btnId)?.addEventListener("click", () => {
      if (
        btnId === "drawingPanelBtn" &&
        panelHost.classList.contains("visible") &&
        document.getElementById("drawingPanel")?.classList.contains("active")
      ) {
        closeDrawToolsPanel();
        return;
      }
      setActivePanel(panelId);
    });
  }
  document.getElementById("drawPanelCloseBtn")?.addEventListener("click", () => closeDrawToolsPanel());
}

function getParcelStatusLayerMode() {
  return parcelStatusState.selectedLayerType || "PARCELS";
}

function setParcelStatusFormError(msg) {
  const el = document.getElementById("parcelStatusFormError");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.hidden = false;
}

function disarmParcelStatusPick() {
  parcelStatusState.pickArmed = false;
}

function renderParcelStatusPreview() {
  const selectionLabel = document.getElementById("parcelStatusSelectionLabel");
  const actionsRow = document.getElementById("parcelStatusActionsRow");
  const features = parcelStatusState.selectedFeatures;
  
  if (!features || features.length === 0) {
    if (selectionLabel) selectionLabel.textContent = "Select on map";
    if (actionsRow) actionsRow.hidden = true;
  } else {
    if (selectionLabel) selectionLabel.textContent = `Selection: ${features.length}`;
    if (actionsRow) actionsRow.hidden = false;
  }
}

function openEditDetailsModal() {
  const modal = document.getElementById("editDetailsModal");
  const form = document.getElementById("editDetailsForm");
  const nameInput = document.getElementById("editDetailsNameInput");
  const nameLabel = document.getElementById("editDetailsNameLabel");
  const statusSelect = document.getElementById("editDetailsStatusSelect");
  const tonnesInput = document.getElementById("editDetailsHarvestTonnes");
  const dateInput = document.getElementById("editDetailsLastHarvest");
  const notesInput = document.getElementById("editDetailsNotes");
  const errorEl = document.getElementById("editDetailsError");
  const titleEl = document.getElementById("editDetailsTitle");

  if (!modal || !form) return;
  if (errorEl) errorEl.hidden = true;

  const features = parcelStatusState.selectedFeatures;
  const lt = parcelStatusState.selectedLayerType;
  if (!features || !features.length || !lt) return;

  if (titleEl) {
    const typeLabel = lt === "BLOCKS" ? "Block" : "Parcel";
    titleEl.textContent = `Edit Details (${features.length} ${features.length === 1 ? typeLabel : typeLabel + "s"} selected)`;
  }

  if (nameLabel) {
    nameLabel.textContent = lt === "BLOCKS" ? "Block Name" : "Parcel Label";
  }

  if (features.length === 1) {
    const f = features[0];
    if (nameInput) {
      nameInput.value = String(f.get(lt === "BLOCKS" ? "block_name" : "parcel_label") ?? "");
      nameInput.disabled = false;
      nameInput.readOnly = false;
    }
    if (statusSelect) statusSelect.value = cultivationKeyFromFeature(f);
    if (tonnesInput) {
      const tonnes = f.get("harvest_tonnes");
      tonnesInput.value = tonnes != null && tonnes !== "" ? String(tonnes) : "";
    }
    if (dateInput) {
      const d = f.get("last_harvest_date");
      dateInput.value = d ? String(d).slice(0, 10) : "";
    }
    if (notesInput) {
      notesInput.value = String(f.get("cultivation_notes") ?? "");
    }
  } else {
    // Bulk editing
    if (nameInput) {
      nameInput.value = "(Multiple selected)";
      nameInput.disabled = true;
      nameInput.readOnly = true;
    }
    if (statusSelect) statusSelect.value = "not_in_cane";
    if (tonnesInput) tonnesInput.value = "";
    if (dateInput) dateInput.value = "";
    if (notesInput) notesInput.value = "";
  }

  modal.hidden = false;
}

function closeEditDetailsModal() {
  const modal = document.getElementById("editDetailsModal");
  if (modal) modal.hidden = true;
}

async function saveEditDetailsForm(event) {
  event.preventDefault();
  const features = parcelStatusState.selectedFeatures;
  const lt = parcelStatusState.selectedLayerType;
  const modal = document.getElementById("editDetailsModal");
  const errorEl = document.getElementById("editDetailsError");
  const saveBtn = event.target.querySelector("button[type='submit']");

  if (!features || !features.length || !lt) return;

  if (!isAuthenticated || !currentUser?.id || currentUser.id === "guest") {
    if (errorEl) {
      errorEl.textContent = "Sign in to save changes.";
      errorEl.hidden = false;
    }
    return;
  }
  if (currentProfile?.role !== "ADMIN" && currentProfile?.role !== "SURVEYOR") {
    if (errorEl) {
      errorEl.textContent = "Only Admin or Surveyor can save status.";
      errorEl.hidden = false;
    }
    return;
  }

  const nameInput = document.getElementById("editDetailsNameInput");
  const statusSelect = document.getElementById("editDetailsStatusSelect");
  const tonnesInput = document.getElementById("editDetailsHarvestTonnes");
  const dateInput = document.getElementById("editDetailsLastHarvest");
  const notesInput = document.getElementById("editDetailsNotes");

  const status = statusSelect?.value || "not_in_cane";
  const tonnesRaw = tonnesInput?.value?.trim() ?? "";
  const tonnes = tonnesRaw === "" ? null : parseNum(tonnesRaw);
  if (tonnesRaw !== "" && (tonnes == null || tonnes < 0)) {
    if (errorEl) {
      errorEl.textContent = "Harvest tonnes must be a non-negative number or blank.";
      errorEl.hidden = false;
    }
    return;
  }
  const lastHarvest = dateInput?.value?.trim() || null;
  const notes = notesInput?.value?.trim() ?? "";
  const newName = nameInput?.value?.trim() ?? "";

  if (saveBtn) saveBtn.disabled = true;
  if (errorEl) errorEl.hidden = true;
  setStatus(statusEl, `Saving details for ${features.length} item(s)...`);

  let errorCount = 0;
  for (const f of features) {
    const { data, error } = await supabase.rpc("vsl_set_cultivation_status", {
      p_layer_type: lt,
      p_feature_id: f.getId(),
      p_status: status,
      p_harvest_tonnes: tonnes,
      p_last_harvest_date: lastHarvest,
      p_notes: notes || null
    });
    if (error || !data || data.success !== true) {
      errorCount++;
    }
  }

  if (features.length === 1 && newName !== "") {
    const f = features[0];
    const oldName = f.get(lt === "BLOCKS" ? "block_name" : "parcel_label") ?? "";
    if (newName !== oldName) {
      const tableName = lt === "BLOCKS" ? "vsl_blocks" : "vsl_parcels";
      const updatePayload = lt === "BLOCKS" ? { block_name: newName } : { parcel_label: newName };
      const { error } = await supabase
        .from(tableName)
        .update(updatePayload)
        .eq("id", f.getId());
      if (error) {
        console.error(`[Victoria] Error updating name: ${error.message}`);
        errorCount++;
      }
    }
  }

  if (saveBtn) saveBtn.disabled = false;

  if (errorCount > 0) {
    if (errorEl) {
      errorEl.textContent = `Failed to save changes on ${errorCount} item(s).`;
      errorEl.hidden = false;
    }
    setStatus(statusEl, `Failed to save changes.`, true);
  } else {
    if (modal) modal.hidden = true;
    setStatus(statusEl, `Changes saved for ${features.length} item(s).`);
    
    const savedIds = features.map(f => String(f.getId()));
    const savedLt = lt;
    await loadLayersFromDb();
    blocksLayer.changed();
    parcelsLayer.changed();
    
    const src = savedLt === "PARCELS" ? parcelsSource : blocksSource;
    const newFeatures = src.getFeatures().filter(x => savedIds.includes(String(x.getId())));
    if (newFeatures.length > 0) {
      parcelStatusState.selectedFeatures = newFeatures;
      parcelStatusState.selectedLayerType = savedLt;
      renderParcelStatusPreview();
    } else {
      clearParcelStatusSelection();
    }
  }
}

function clearParcelStatusSelection() {
  parcelStatusState.selectedFeatures = [];
  parcelStatusState.selectedLayerType = null;
  blocksLayer.changed();
  parcelsLayer.changed();
  renderParcelStatusPreview();
}

function closeParcelStatusPanel() {
  const panel = document.getElementById("parcelStatusPanel");
  const btn = document.getElementById("parcelStatusBtn");
  parcelStatusState.panelOpen = false;
  disarmParcelStatusPick();
  clearParcelStatusSelection();
  if (panel) {
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
  }
  btn?.classList.remove("active");
}

function closeUAM() {
  // Direct DOM close — does not rely on window.closeMenu being available yet
  const uamOverlay = document.getElementById("unifiedActionMenu");
  const fabBtn = document.getElementById("toolsTopBtn") || document.getElementById("toolsFabBtn");
  if (uamOverlay && !uamOverlay.hidden) {
    uamOverlay.hidden = true;
    uamOverlay.setAttribute("aria-hidden", "true");
    fabBtn?.classList.remove("uam-open");
    fabBtn?.setAttribute("aria-expanded", "false");
  }
  // Also call the function if available
  if (typeof window.closeMenu === "function") window.closeMenu();
}

function openParcelStatusPanel() {
  const panel = document.getElementById("parcelStatusPanel");
  const btn = document.getElementById("parcelStatusBtn");
  if (!panel) return;
  closeInfoHelpPopover();
  closePlaceSearchCard();
  
  // Forcibly close Measure panel
  const mp = document.getElementById("measurePanel");
  if (mp) mp.hidden = true;
  
  // Forcibly close Survey UAM at DOM level (does not depend on window.closeMenu)
  closeUAM();
  
  panel.hidden = false;
  panel.setAttribute("aria-hidden", "false");
  parcelStatusState.panelOpen = true;
  parcelStatusState.pickArmed = true; // Auto-arm picking
  btn?.classList.add("active");
  panelHost.classList.remove("visible");
  for (const p of panelHost.querySelectorAll(".panel")) p.classList.remove("active");
  for (const bId of Object.keys(panelButtons)) {
    document.getElementById(bId)?.classList.remove("active");
  }

  renderParcelStatusPreview();
}

function tryParcelStatusMapClick(evt) {
  if (!parcelStatusState.pickArmed) return false;
  const mode = getParcelStatusLayerMode();
  let hit = null;
  let layerHit = null;
  const hitOpts = { hitTolerance: 20 };

  if (mode === "PARCELS") {
    map.forEachFeatureAtPixel(
      evt.pixel,
      (feature) => {
        hit = feature;
        return true;
      },
      { ...hitOpts, layerFilter: (layer) => layer === parcelsLayer }
    );
    if (hit) layerHit = "PARCELS";
  } else {
    map.forEachFeatureAtPixel(
      evt.pixel,
      (feature) => {
        hit = feature;
        return true;
      },
      { ...hitOpts, layerFilter: (layer) => layer === blocksLayer }
    );
    if (hit) layerHit = "BLOCKS";
  }

  if (!hit) {
    setStatus(statusEl, `Click a ${mode === "PARCELS" ? "parcel" : "block"} polygon.`, true);
    return true;
  }
  
  if (parcelStatusState.selectedLayerType !== layerHit) {
    parcelStatusState.selectedFeatures = [];
    parcelStatusState.selectedLayerType = layerHit;
  }
  
  const existingIdx = parcelStatusState.selectedFeatures.findIndex(f => f.getId() === hit.getId());
  if (existingIdx > -1) {
    parcelStatusState.selectedFeatures.splice(existingIdx, 1);
  } else {
    parcelStatusState.selectedFeatures.push(hit);
  }
  
  renderParcelStatusPreview();
  clearStatus(statusEl);
  blocksLayer.changed();
  parcelsLayer.changed();
  return true;
}

function setupParcelStatusPanel() {
  const toolbarBtn = document.getElementById("parcelStatusBtn");
  const closeBtn = document.getElementById("parcelStatusCloseBtn");
  const modifyBtn = document.getElementById("parcelStatusModifyBtn");
  const deleteBtn = document.getElementById("parcelStatusDeleteBtn");
  
  const tabParcels = document.getElementById("modifyTabParcels");
  const tabBlocks = document.getElementById("modifyTabBlocks");

  const modalCloseBtn = document.getElementById("editDetailsCloseBtn");
  const modalCancelBtn = document.getElementById("editDetailsCancelBtn");
  const modalForm = document.getElementById("editDetailsForm");

  deleteBtn?.addEventListener("click", async () => {
    const features = parcelStatusState.selectedFeatures;
    const lt = parcelStatusState.selectedLayerType;
    if (!features || features.length === 0 || !lt) return;
    
    if (!isAuthenticated || !currentUser?.id || currentUser.id === "guest") {
      setParcelStatusFormError("Sign in to delete features.");
      return;
    }
    if (currentProfile?.role !== "ADMIN" && currentProfile?.role !== "SURVEYOR") {
      setParcelStatusFormError("Only Admin or Surveyor can delete features.");
      return;
    }

    const modeName = lt === "BLOCKS" ? "block" : "parcel";
    const msg = `CRITICAL WARNING: You are about to permanently delete ${features.length} ${modeName}(s).\n\nThis action cannot be undone. Are you absolutely sure?`;
    if (!confirm(msg)) return;

    deleteBtn.disabled = true;
    setParcelStatusFormError("");
    setStatus(statusEl, `Deleting ${features.length} ${modeName}(s)...`);

    const tableName = lt === "BLOCKS" ? "vsl_blocks" : "vsl_parcels";
    const ids = features.map(f => f.getId());
    
    let errorCount = 0;
    for (const id of ids) {
      const { error } = await supabase.from(tableName).delete().eq("id", id);
      if (error) errorCount++;
    }

    deleteBtn.disabled = false;

    if (errorCount > 0) {
      setParcelStatusFormError(`Failed to delete ${errorCount} of ${features.length} item(s).`);
    } else {
      setStatus(statusEl, `Successfully deleted ${features.length} ${modeName}(s).`);
      clearParcelStatusSelection();
      await loadLayersFromDb();
    }
  });

  toolbarBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (parcelStatusState.panelOpen) closeParcelStatusPanel();
    else openParcelStatusPanel();
  });
  
  closeBtn?.addEventListener("click", () => closeParcelStatusPanel());

  tabParcels?.addEventListener("click", () => {
    tabParcels.classList.add("active");
    tabParcels.setAttribute("aria-selected", "true");
    tabBlocks?.classList.remove("active");
    tabBlocks?.setAttribute("aria-selected", "false");
    
    clearParcelStatusSelection();
    parcelStatusState.selectedLayerType = "PARCELS";
    parcelStatusState.pickArmed = true;
    renderParcelStatusPreview();
  });

  tabBlocks?.addEventListener("click", () => {
    tabBlocks.classList.add("active");
    tabBlocks.setAttribute("aria-selected", "true");
    tabParcels?.classList.remove("active");
    tabParcels?.setAttribute("aria-selected", "false");
    
    clearParcelStatusSelection();
    parcelStatusState.selectedLayerType = "BLOCKS";
    parcelStatusState.pickArmed = true;
    renderParcelStatusPreview();
  });

  modifyBtn?.addEventListener("click", () => openEditDetailsModal());

  modalCloseBtn?.addEventListener("click", () => closeEditDetailsModal());
  modalCancelBtn?.addEventListener("click", () => closeEditDetailsModal());
  modalForm?.addEventListener("submit", (e) => saveEditDetailsForm(e));
}

function closeInfoPopup() {
  const inner = document.getElementById("featureInfoPanelInner");
  const panel = document.getElementById("featureInfoPanel");
  if (inner) inner.innerHTML = "";
  if (panel) panel.hidden = true;
}

// popWinHead's icon/title are static markup, so the layer type needs to be
// pushed into them explicitly each time a different feature is clicked.
function setFeatureInfoHeader(layerType) {
  const iconEl = document.querySelector("#featureInfoPanelIcon i");
  const titleEl = document.getElementById("featureInfoPanelTitle");
  const isParcel = layerType === "PARCELS";
  if (iconEl) iconEl.className = isParcel ? "fas fa-map" : "fas fa-cubes";
  if (titleEl) titleEl.textContent = FEATURE_INFO_BADGE[layerType] || "Feature";
}

// popWinTabs is also static, so it doesn't get wiped/rebuilt with the rest
// of the popup on every click — reset it back to "Info" selected instead.
function resetFeatureInfoTabs() {
  const tabInfo = document.getElementById("featureInfoTabInfo");
  const tabModify = document.getElementById("featureInfoTabModify");
  const paneInfo = document.getElementById("popupTabInfo");
  const paneModify = document.getElementById("popupTabMore");
  tabInfo?.setAttribute("aria-selected", "true");
  tabModify?.setAttribute("aria-selected", "false");
  if (paneInfo) paneInfo.hidden = false;
  if (paneModify) paneModify.hidden = true;
}

function setupInfoPopup() {
  const inner = document.getElementById("featureInfoPanelInner");
  const panel = document.getElementById("featureInfoPanel");
  const closeBtn = document.getElementById("featureInfoPanelCloseBtn");
  const tabInfo = document.getElementById("featureInfoTabInfo");
  const tabModify = document.getElementById("featureInfoTabModify");
  if (!inner || !panel) return;

  closeBtn?.addEventListener("click", () => {
    closeInfoPopup();
    selectedFeature = null;
    selectedLayerType = null;
  });

  tabInfo?.addEventListener("click", () => {
    tabInfo.setAttribute("aria-selected", "true");
    tabModify?.setAttribute("aria-selected", "false");
    const paneInfo = document.getElementById("popupTabInfo");
    const paneModify = document.getElementById("popupTabMore");
    if (paneInfo) paneInfo.hidden = false;
    if (paneModify) paneModify.hidden = true;
  });

  tabModify?.addEventListener("click", () => {
    tabModify.setAttribute("aria-selected", "true");
    tabInfo?.setAttribute("aria-selected", "false");
    const paneInfo = document.getElementById("popupTabInfo");
    const paneModify = document.getElementById("popupTabMore");
    if (paneInfo) paneInfo.hidden = true;
    if (paneModify) paneModify.hidden = false;
  });

  inner.addEventListener("click", async (ev) => {
    if (ev.target.closest(".btn-delete-feature")) {
      const btn = ev.target.closest(".btn-delete-feature");
      const layerType = btn.dataset.layer;
      const featureId = btn.dataset.id;
      const isParcel = layerType === "PARCELS";
      if (!confirm(`Are you sure you want to delete this ${isParcel ? "parcel" : "block"}? This action cannot be undone.`)) return;

      const tableName = isParcel ? "vsl_parcels" : "vsl_blocks";
      const { error } = await supabase.from(tableName).delete().eq("id", featureId);

      if (error) {
        alert("Failed to delete feature: " + error.message);
      } else {
        closeInfoPopup();
        selectedFeature = null;
        selectedLayerType = null;
        loadLayersFromDb();
      }
    } else if (ev.target.closest(".btn-save-feature")) {
      const btn = ev.target.closest(".btn-save-feature");
      const layerType = btn.dataset.layer;
      const featureId = btn.dataset.id;
      const isParcel = layerType === "PARCELS";
      
      let updateData = {};
      
      if (!isParcel) {
        // BLOCKS
        updateData = {
          block_name: inner.querySelector(".popup-modify-bname")?.value || null,
          location_address: inner.querySelector(".popup-modify-loc")?.value || null,
          soil_type: inner.querySelector(".popup-modify-soil")?.value || null,
          soil_ph: parseFloat(inner.querySelector(".popup-modify-ph")?.value) || null,
          irrigation_type: inner.querySelector(".popup-modify-irrigation")?.value || null,
          ownership: inner.querySelector(".popup-modify-ownership")?.value || null,
          manager_name: inner.querySelector(".popup-modify-mname")?.value || null,
          manager_phone: inner.querySelector(".popup-modify-mphone")?.value || null,
          updated_at: new Date().toISOString()
        };
      } else {
        // PARCELS
        const rawTonnes = parseFloat(inner.querySelector(".popup-modify-tonnes")?.value) || null;
        const harvestUnit = inner.querySelector(".popup-modify-unit")?.value || "tonnes";
        const tonnesCalc = (rawTonnes && harvestUnit === "kg") ? (rawTonnes / 1000) : rawTonnes;
        
        const agronomy_data = {
          fertilizer_type: inner.querySelector(".popup-modify-ferttype")?.value || null,
          fertilizer_quantity: parseFloat(inner.querySelector(".popup-modify-fertqty")?.value) || null,
          fertilizer_unit: inner.querySelector(".popup-modify-fertunit")?.value || "kg",
          current_activity: inner.querySelector(".popup-modify-activity")?.value || null,
          assigned_to: inner.querySelector(".popup-modify-assigned")?.value || null,
          activity_status: parseFloat(inner.querySelector(".popup-modify-progress")?.value) || null,
        };

        updateData = {
          parcel_label: inner.querySelector(".popup-modify-label")?.value || null,
          planting_date: inner.querySelector(".popup-modify-pdate")?.value || null,
          ratoon_number: parseInt(inner.querySelector(".popup-modify-ratoon")?.value) || 0,
          cultivation_status: inner.querySelector(".popup-modify-status")?.value || "not_in_cane",
          last_harvest_date: inner.querySelector(".popup-modify-hdate")?.value || null,
          harvest_tonnes: tonnesCalc,
          cultivation_notes: inner.querySelector(".popup-modify-notes")?.value || null,
          agronomy_data: agronomy_data,
          cultivation_updated_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };
        
        // Log to history tables (Harvests & Activities) async in background if there's new data
        if (tonnesCalc > 0 && updateData.last_harvest_date) {
           supabase.from('vsl_harvests').insert({
             parcel_id: featureId,
             harvest_date: updateData.last_harvest_date,
             gross_weight_tonnes: tonnesCalc,
             ratoon_at_harvest: updateData.ratoon_number
           }).then();
        }
        if (agronomy_data.current_activity) {
           supabase.from('vsl_activities').insert({
             parcel_id: featureId,
             activity_type: agronomy_data.current_activity,
             status_percent: agronomy_data.activity_status || 0,
             assigned_to: agronomy_data.assigned_to,
             activity_date: new Date().toISOString().split('T')[0]
           }).then();
        }
      }
      
      const tableName = isParcel ? "vsl_parcels" : "vsl_blocks";
      const { error } = await supabase.from(tableName).update(updateData).eq("id", featureId);
      
      if (error) {
        alert("Failed to modify feature: " + error.message);
      } else {
        // Quick visual feedback on button
        const oldText = btn.innerHTML;
        btn.innerHTML = `<i class="fas fa-check"></i> Saved`;
        btn.style.background = "#28a745";
        setTimeout(() => {
          closeInfoPopup();
          selectedFeature = null;
          selectedLayerType = null;
          loadLayersFromDb();
        }, 800);
      }
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!panel.hidden) {
      closeInfoPopup();
      selectedFeature = null;
      selectedLayerType = null;
    }
  });

  map.on("click", (evt) => {
    if (activeInteraction) return; // do not popup when measuring or drawing

    if (document.getElementById("coordExtractDrawer")?.dataset.picking === "1") {
      return;
    }

    if (tryParcelStatusMapClick(evt)) {
      return;
    }

    selectedFeature = null;
    selectedLayerType = null;
    inner.innerHTML = "";
    panel.hidden = true;

    map.forEachFeatureAtPixel(
      evt.pixel,
      (feature, layer) => {
        const isBlocks = layer === blocksLayer;
        const isParcels = layer === parcelsLayer;
        if (!isBlocks && !isParcels) return false;

        selectedFeature = feature;
        selectedLayerType = isBlocks ? "BLOCKS" : "PARCELS";

        setFeatureInfoHeader(selectedLayerType);
        resetFeatureInfoTabs();
        inner.innerHTML = buildFeatureInfoPopupHtml(selectedLayerType, feature);
        panel.hidden = false;
        panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return true;
      },
      { layerFilter: (layer) => layer === blocksLayer || layer === parcelsLayer, hitTolerance: 20 }
    );
  });
}

function positionInfoHelpPopover() {
  const pop = document.getElementById("infoHelpPopover");
  if (!pop || pop.hidden) return;
  pop.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function closeInfoHelpPopover() {
  const pop = document.getElementById("infoHelpPopover");
  const btn = document.getElementById("infoBtn");
  if (infoHelpOutsideHandler) {
    document.removeEventListener("pointerdown", infoHelpOutsideHandler, true);
    infoHelpOutsideHandler = null;
  }
  if (infoHelpEscapeHandler) {
    document.removeEventListener("keydown", infoHelpEscapeHandler, true);
    infoHelpEscapeHandler = null;
  }
  infoHelpPopoverOpen = false;
  if (pop) pop.hidden = true;
  btn?.classList.remove("active");
  btn?.setAttribute("aria-expanded", "false");
}

function openInfoHelpPopover() {
  const pop = document.getElementById("infoHelpPopover");
  const btn = document.getElementById("infoBtn");
  if (!pop || !btn || infoHelpPopoverOpen) return;
  closeParcelSearchPopover({ clearHighlight: false });
  closeInfoPopup();
  closePlaceSearchCard();
  selectedFeature = null;
  selectedLayerType = null;
  pop.hidden = false;
  btn.classList.add("active");
  btn.setAttribute("aria-expanded", "true");
  infoHelpPopoverOpen = true;

  infoHelpOutsideHandler = (ev) => {
    if (!infoHelpPopoverOpen) return;
    if (pop.contains(ev.target) || btn.contains(ev.target)) return;
    closeInfoHelpPopover();
  };
  document.addEventListener("pointerdown", infoHelpOutsideHandler, true);

  infoHelpEscapeHandler = (ev) => {
    if (ev.key === "Escape" && infoHelpPopoverOpen) {
      ev.preventDefault();
      closeInfoHelpPopover();
    }
  };
  document.addEventListener("keydown", infoHelpEscapeHandler, true);

  requestAnimationFrame(() => {
    pop.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

function toggleInfoHelpPopover() {
  if (infoHelpPopoverOpen) closeInfoHelpPopover();
  else openInfoHelpPopover();
}

function setupInfoHelpPopover() {
  const btn = document.getElementById("infoBtn");
  const closeBtn = document.getElementById("infoHelpCloseBtn");
  btn?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleInfoHelpPopover();
  });
  closeBtn?.addEventListener("click", () => closeInfoHelpPopover());
  window.addEventListener("resize", () => {
    if (infoHelpPopoverOpen) positionInfoHelpPopover();
  });
}

let lastNominatimRequestAt = 0;


function setPlaceSearchError(msg) {
  const el = document.getElementById("placeSearchError");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.hidden = false;
}

function closePlaceSearchCard() {
  // Place search is now inside the unified search panel; this is a no-op kept for compatibility
  placeSearchOpen = false;
  const results = document.getElementById("placeSearchResults");
  if (results) {
    results.innerHTML = "";
    results.hidden = true;
  }
  setPlaceSearchError("");
}

function openPlaceSearchCard() {
  // Now activates the Place tab inside the unified search panel instead of a floating popover
  openSearchPanel("place");
  placeSearchOpen = true;
  requestAnimationFrame(() => {
    document.getElementById("placeSearchInput")?.focus();
  });
}

function togglePlaceSearchCard() {
  if (searchPanelOpen) {
    // If panel already open on place tab, close it
    const placeTab = document.getElementById("tabPlace");
    if (placeTab?.getAttribute("aria-selected") === "true") {
      closeSearchPanel({ clearHighlight: false });
      return;
    }
  }
  openSearchPanel("place");
}

function renderPlaceResults(items) {
  const ul = document.getElementById("placeSearchResults");
  if (!ul) return;
  ul.innerHTML = "";
  if (!items || !items.length) {
    ul.hidden = true;
    setPlaceSearchError("No places found. Try a different spelling or broader name.");
    return;
  }
  setPlaceSearchError("");
  ul.hidden = false;
  for (const item of items) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "place-search-result-btn";
    const name = escapeHtml(item.display_name || "Unnamed");
    const typeLabel = item.type ? escapeHtml(String(item.type)) : "";
    const typeHtml = typeLabel
      ? `<span class="place-search-result-type">${typeLabel}</span>`
      : "";
    b.innerHTML = `<span class="place-search-result-name">${name}</span>${typeHtml}`;
    b.addEventListener("click", () => {
      flyToNominatimResult(item);
      closePlaceSearchCard();
      clearStatus(statusEl);
      setStatus(statusEl, `Showing: ${item.display_name ?? "place"}`);
    });
    li.appendChild(b);
    ul.appendChild(li);
  }
}

function flyToNominatimResult(item) {
  if (!map) return;
  const lon = parseFloat(item.lon);
  const lat = parseFloat(item.lat);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
  const bb = item.boundingbox;
  if (bb && bb.length === 4) {
    const south = parseFloat(bb[0]);
    const north = parseFloat(bb[1]);
    const west = parseFloat(bb[2]);
    const east = parseFloat(bb[3]);
    if ([south, north, west, east].every(Number.isFinite)) {
      const sw = ol.proj.fromLonLat([west, south]);
      const ne = ol.proj.fromLonLat([east, north]);
      const extent = ol.extent.boundingExtent([sw, ne]);
      let afterOnce = false;
      const after = () => {
        if (afterOnce) return;
        afterOnce = true;
        loadLayersFromDb();
      };
      map.getView().fit(extent, {
        padding: [72, 72, 100, 72],
        maxZoom: 17,
        duration: 900,
        callback: after
      });
      window.setTimeout(after, 1300);
      return;
    }
  }
  map.getView().animate({
    center: ol.proj.fromLonLat([lon, lat]),
    zoom: Math.max(map.getView().getZoom() || 10, 13),
    duration: 750
  });
  window.setTimeout(() => loadLayersFromDb(), 850);
}

async function runPlaceSearchQuery() {
  const input = document.getElementById("placeSearchInput");
  const goBtn = document.getElementById("placeSearchGoBtn");
  const q = input?.value?.trim() ?? "";
  setPlaceSearchError("");
  if (!q) {
    setPlaceSearchError("Type a place name, then Search.");
    return;
  }
  const now = Date.now();
  if (now - lastNominatimRequestAt < 1100) {
    setPlaceSearchError("Please wait a moment between searches.");
    return;
  }
  lastNominatimRequestAt = now;

  if (goBtn) goBtn.disabled = true;
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=7&addressdetails=0`;
    const res = await fetch(url, {
      headers: { "Accept-Language": "en" },
      referrerPolicy: "strict-origin-when-cross-origin"
    });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const data = await res.json();
    renderPlaceResults(Array.isArray(data) ? data : []);
  } catch (e) {
    setPlaceSearchError(e.message || "Search could not complete. Check your connection.");
    const ul = document.getElementById("placeSearchResults");
    if (ul) {
      ul.innerHTML = "";
      ul.hidden = true;
    }
  } finally {
    if (goBtn) goBtn.disabled = false;
  }
}

function setupPlaceSearch() {
  const goBtn = document.getElementById("placeSearchGoBtn");
  const input = document.getElementById("placeSearchInput");

  goBtn?.addEventListener("click", () => void runPlaceSearchQuery());
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runPlaceSearchQuery();
    }
  });
}

async function loadLayersFromDb() {
  if (!map) return;
  map.updateSize();
  const size = map.getSize();
  if (!size || size[0] < 2 || size[1] < 2) {
    if (cfg.DEBUG_MAP_RPC && window.console?.debug) {
      console.debug("[Victoria map] Skipping bbox load: map size not ready yet");
    }
    return;
  }
  const extent = map.getView().calculateExtent(size);
  const [minLon, minLat, maxLon, maxLat] = ol.proj.transformExtent(extent, "EPSG:3857", "EPSG:4326");
  const { data, error } = await supabase.rpc("vsl_get_features_bbox", {
    p_min_lon: minLon,
    p_min_lat: minLat,
    p_max_lon: maxLon,
    p_max_lat: maxLat
  });
  if (error) {
    setStatus(statusEl, `Layer load failed: ${error.message}`, true);
    return;
  }

  blocksSource.clear(true);
  parcelsSource.clear(true);

  const geojsonFmt = new ol.format.GeoJSON();
  const projOpts = { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" };
  const geomTypes = new Set([
    "Point",
    "LineString",
    "Polygon",
    "MultiPoint",
    "MultiLineString",
    "MultiPolygon",
    "GeometryCollection"
  ]);

  let n = 0;
  for (const row of data || []) {
    if (!row.geojson) continue;
    let feature;
    const gj = row.geojson;
    if (typeof gj === "string") {
      try {
        feature = geojsonFmt.readFeature(gj, projOpts);
      } catch {
        continue;
      }
    } else if (gj.type === "Feature") {
      feature = geojsonFmt.readFeature(gj, projOpts);
    } else if (geomTypes.has(gj.type)) {
      const geom = geojsonFmt.readGeometry(gj, projOpts);
      feature = new ol.Feature({ geometry: geom });
    } else {
      continue;
    }
    feature.setProperties(row.properties || {}, true);
    feature.setId(row.feature_id);
    if (row.layer_type === "BLOCKS") blocksSource.addFeature(feature);
    if (row.layer_type === "PARCELS") parcelsSource.addFeature(feature);
    n += 1;
  }
  const rowCount = (data || []).length;
  if (cfg.DEBUG_MAP_RPC && window.console?.debug) {
    console.debug(`[Victoria map] vsl_get_features_bbox: ${n} feature(s) drawn, ${rowCount} row(s) from API`);
  }
}

function clearSearchHighlight() {
  searchHighlight.blockId = null;
  searchHighlight.parcelId = null;
  if (map) {
    blocksLayer.changed();
    parcelsLayer.changed();
  }
}

function setParcelSearchPopoverError(msg) {
  const el = document.getElementById("parcelSearchPopoverError");
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.hidden = false;
}


function openSearchPanel(tab = "parcel") {
  const panel = document.getElementById("searchPanel");
  const btn = document.getElementById("searchPanelBtn");
  if (!panel || !btn) return;
  vslCloseSentinelPanel();
  closeInfoHelpPopover();
  closePlaceSearchCard();
  panel.hidden = false;
  btn.classList.add("active");
  btn.setAttribute("aria-expanded", "true");
  searchPanelOpen = true;
  parcelSearchDockOpen = true; // keep legacy flag in sync for runLocateParcelFromPopover

  // Activate the requested tab
  activateSearchTab(tab);

  // Keyboard close
  searchPanelEscapeHandler = (ev) => {
    if (ev.key === "Escape" && searchPanelOpen) {
      ev.preventDefault();
      closeSearchPanel({ clearHighlight: false });
    }
  };
  document.addEventListener("keydown", searchPanelEscapeHandler, true);

  searchPanelOutsideHandler = (ev) => {
    if (!searchPanelOpen) return;
    if (panel.contains(ev.target) || btn.contains(ev.target)) return;
    closeSearchPanel({ clearHighlight: false });
  };
  document.addEventListener("pointerdown", searchPanelOutsideHandler, true);

  requestAnimationFrame(() => {
    // Focus first input of active tab
    const activeTab = panel.querySelector(".search-panel__tab-body:not([hidden]) input, .search-panel__tab-body:not([hidden]) select");
    activeTab?.focus();
    map?.updateSize();
  });
}

function closeSearchPanel(options = {}) {
  const { clearHighlight = true } = options;
  const panel = document.getElementById("searchPanel");
  const btn = document.getElementById("searchPanelBtn");
  if (searchPanelOutsideHandler) {
    document.removeEventListener("pointerdown", searchPanelOutsideHandler, true);
    searchPanelOutsideHandler = null;
  }
  if (searchPanelEscapeHandler) {
    document.removeEventListener("keydown", searchPanelEscapeHandler, true);
    searchPanelEscapeHandler = null;
  }
  searchPanelOpen = false;
  parcelSearchDockOpen = false;
  placeSearchOpen = false;
  if (panel) panel.hidden = true;
  btn?.classList.remove("active");
  btn?.setAttribute("aria-expanded", "false");
  setParcelSearchPopoverError("");
  setPlaceSearchError("");
  if (clearHighlight) clearSearchHighlight();
  map?.updateSize();
}

function activateSearchTab(tab) {
  const tabs = ["parcel", "place", "coords"];
  const tabElMap = { coords: "tabCoords", parcel: "tabParcel", place: "tabPlace", extract: "tabExtract" };
  const bodyElMap = { coords: "searchTabCoords", parcel: "searchTabParcel", place: "searchTabPlace", extract: "searchTabExtract" };
  tabs.forEach((t) => {
    const tabEl = document.getElementById(tabElMap[t]);
    const bodyEl = document.getElementById(bodyElMap[t]);
    const active = t === tab;
    if (tabEl) tabEl.setAttribute("aria-selected", String(active));
    if (bodyEl) bodyEl.hidden = !active;
  });
}

function setupSearchTabSwitching() {
  ["tabCoords", "tabParcel", "tabPlace", "tabExtract"].forEach((id) => {
    const btn = document.getElementById(id);
    btn?.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      if (tab) activateSearchTab(tab);
    });
  });
}

// Legacy: openParcelSearchDock now delegates to the unified panel
function openParcelSearchDock() {
  openSearchPanel("parcel");
}

// Legacy no-op kept so nothing breaks
function positionPlaceSearchPopover() {}

function closeParcelSearchPopover(options = {}) {
  closeSearchPanel(options);
}

async function runLocateParcelFromPopover() {
  const blockSelect = document.getElementById("searchBlockSelect");
  const parcelSelect = document.getElementById("searchParcelSelect");

  const blockInput = document.getElementById("parcelSearchBlockInput");
  const noInput = document.getElementById("parcelSearchNoInput");
  const goBtn = document.getElementById("parcelSearchGoBtn");
  const cancelBtn = document.getElementById("parcelSearchPopoverCancelBtn");

  // Read block code (prioritize dropdown, fallback to text input)
  let blockQ = "";
  if (blockSelect && blockSelect.selectedIndex >= 0) {
    const opt = blockSelect.options[blockSelect.selectedIndex];
    blockQ = opt.dataset.code || opt.value || "";
  }
  if (!blockQ) {
    blockQ = blockInput?.value?.trim() ?? "";
  }

  // Read plot/parcel number (prioritize dropdown, fallback to text input)
  let plotStr = "";
  if (parcelSelect && parcelSelect.value) {
    plotStr = parcelSelect.value;
  }
  if (!plotStr) {
    plotStr = noInput?.value?.trim() ?? "";
  }

  let parcelNo = null;
  if (plotStr !== "") {
    const parcelNoRaw = parseNum(plotStr);
    parcelNo = parcelNoRaw != null ? Math.trunc(parcelNoRaw) : null;
    if (parcelNo == null || parcelNo < 1 || !Number.isFinite(parcelNo)) {
      setParcelSearchPopoverError(
        "Enter a valid plot number (whole number ≥ 1), or leave plot empty to search the block only."
      );
      return;
    }
  }

  setParcelSearchPopoverError("");
  if (!blockQ) {
    setParcelSearchPopoverError("Enter a block code or block name.");
    return;
  }

  goBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;

  const { data, error } = await supabase.rpc("vsl_locate_parcel", {
    p_block_query: blockQ,
    p_parcel_no: parcelNo
  });

  if (error) {
    setParcelSearchPopoverError(error.message || "Search failed.");
    goBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    return;
  }

  if (!data || data.success !== true) {
    const errMsg = (data && data.error) || "Nothing matched.";
    setParcelSearchPopoverError(String(errMsg));
    goBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    return;
  }

  const mode = data.search_mode === "parcel" ? "parcel" : "block";
  const geojsonFmt = new ol.format.GeoJSON();
  const projOpts = { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" };
  let blockGeom;
  try {
    blockGeom = geojsonFmt.readGeometry(data.block.geojson, projOpts);
  } catch (e) {
    setParcelSearchPopoverError("Could not read geometry from the server.");
    goBtn.disabled = false;
    if (cancelBtn) cancelBtn.disabled = false;
    return;
  }

  let parcelGeom = null;
  if (mode === "parcel" && data.parcel?.geojson) {
    try {
      parcelGeom = geojsonFmt.readGeometry(data.parcel.geojson, projOpts);
    } catch (e) {
      setParcelSearchPopoverError("Could not read plot geometry from the server.");
      goBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
      return;
    }
  }

  searchHighlight.blockId = data.block.id;
  searchHighlight.parcelId = mode === "parcel" && data.parcel?.id != null ? data.parcel.id : null;

  const combined = ol.extent.createEmpty();
  ol.extent.extend(combined, blockGeom.getExtent());
  if (parcelGeom) ol.extent.extend(combined, parcelGeom.getExtent());

  const finish = async () => {
    try {
      await loadLayersFromDb();
      blocksLayer.changed();
      parcelsLayer.changed();
      clearStatus(statusEl);
      const bc = data.block.block_code ?? "";
      if (mode === "parcel" && data.parcel) {
        setStatus(
          statusEl,
          `Block ${bc}, plot ${data.parcel.parcel_no} — highlighted on the map.`
        );
      } else {
        setStatus(statusEl, `Block ${bc} — zoomed to block boundary.`);
      }
      setParcelSearchPopoverError("");
    } finally {
      goBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = false;
    }
  };

  let finished = false;
  const safeFinish = () => {
    if (finished) return;
    finished = true;
    finish();
  };

  const dockEl = document.getElementById("searchPanel");
  let leftPad = 96;
  if (dockEl && !dockEl.hidden) {
    const w = dockEl.getBoundingClientRect().width;
    if (w > 0) leftPad = Math.min(360, Math.round(w + 24));
  }
  const fitOpts = {
    padding: [88, 96, 96, leftPad],
    maxZoom: 19,
    duration: 1350,
    callback: () => safeFinish()
  };
  if (ol.easing && typeof ol.easing.easeOut === "function") {
    fitOpts.easing = ol.easing.easeOut;
  }

  map.getView().fit(combined, fitOpts);
  window.setTimeout(() => safeFinish(), 2200);
}

function setupParcelSearchPopover() {
  const searchBtn = document.getElementById("searchPanelBtn");
  const form = document.getElementById("parcelSearchForm");
  const cancelBtn = document.getElementById("parcelSearchPopoverCancelBtn");

  // ── CASCADE: Estate → Block → Parcel ──────────────────────────────────────
  const estateSelect = document.getElementById("searchEstateSelect");
  const blockSelect  = document.getElementById("searchBlockSelect");
  const parcelSelect = document.getElementById("searchParcelSelect");
  const goBtn        = document.getElementById("parcelSearchGoBtn");

  async function loadSearchEstates() {
    if (!estateSelect) return;
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_blocks?select=estate_name&estate_name=not.is.null`;
      const res = await fetch(url, {
        headers: { "apikey": cfg.SUPABASE_ANON_KEY, "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}`, "Accept": "application/json" }
      });
      if (!res.ok) return;
      const data = await res.json();
      const names = [...new Set(data.map(d => d.estate_name).filter(Boolean))].sort((a,b) => a.localeCompare(b));
      estateSelect.innerHTML = '<option value="">— Select Estate —</option>';
      names.forEach(n => {
        const o = document.createElement("option"); o.value = n; o.textContent = n;
        estateSelect.appendChild(o);
      });
    } catch(e) { console.warn("[VSL Search] estates:", e); }
  }

  async function loadSearchBlocks(estate) {
    if (!blockSelect) return;
    blockSelect.innerHTML = '<option value="">Loading…</option>';
    blockSelect.disabled = true;
    parcelSelect.innerHTML = '<option value="">— Select Block first —</option>';
    parcelSelect.disabled = true;
    if (!estate) { blockSelect.innerHTML = '<option value="">— Select Estate first —</option>'; return; }
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_blocks?select=id,block_code,block_name&estate_name=eq.${encodeURIComponent(estate)}`;
      const res = await fetch(url, {
        headers: { "apikey": cfg.SUPABASE_ANON_KEY, "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}`, "Accept": "application/json" }
      });
      if (!res.ok) throw new Error("fetch failed");
      const data = await res.json();
      data.sort((a,b) => { const na=Number(a.block_code), nb=Number(b.block_code); return Number.isFinite(na)&&Number.isFinite(nb)?na-nb:String(a.block_code).localeCompare(String(b.block_code),undefined,{numeric:true}); });
      blockSelect.innerHTML = '<option value="">— Select Block —</option>';
      data.forEach(b => {
        const o = document.createElement("option");
        o.value = b.id;
        o.dataset.code = b.block_code;
        o.textContent = `Block ${b.block_code}${b.block_name ? " – "+b.block_name : ""}`;
        blockSelect.appendChild(o);
      });
      blockSelect.disabled = false;
    } catch(e) { blockSelect.innerHTML = '<option value="">Error loading blocks</option>'; console.warn("[VSL Search] blocks:", e); }
  }

  async function loadSearchParcels(blockCode, blockId, estate) {
    if (!parcelSelect) return;
    parcelSelect.innerHTML = '<option value="">Loading…</option>';
    parcelSelect.disabled = true;
    if (!blockId) { parcelSelect.innerHTML = '<option value="">— Select Block first —</option>'; return; }
    try {
      let url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_parcels?select=id,parcel_no,parcel_label&block_id=eq.${encodeURIComponent(blockId)}`;
      if (estate) url += `&estate_name=eq.${encodeURIComponent(estate)}`;
      url += "&order=parcel_no.asc";
      const res = await fetch(url, {
        headers: { "apikey": cfg.SUPABASE_ANON_KEY, "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}`, "Accept": "application/json" }
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`fetch failed: ${res.status} ${res.statusText} - ${errText}`);
      }
      const data = await res.json();
      parcelSelect.innerHTML = '<option value="">— All parcels in block —</option>';
      data.forEach(p => {
        const o = document.createElement("option");
        o.value = p.parcel_no;
        o.textContent = p.parcel_label ? `Plot ${p.parcel_no} – ${p.parcel_label}` : `Plot ${p.parcel_no}`;
        parcelSelect.appendChild(o);
      });
      parcelSelect.disabled = false;
      // Zoom to block when block selected
      const blockInput = document.getElementById("parcelSearchBlockInput");
      if (blockInput) blockInput.value = String(blockCode);
      const noInput   = document.getElementById("parcelSearchNoInput");
      if (noInput) noInput.value = "";
      runLocateParcelFromPopover();
    } catch(e) { parcelSelect.innerHTML = '<option value="">Error loading parcels</option>'; console.warn("[VSL Search] parcels:", e); }
  }

  estateSelect?.addEventListener("change", () => loadSearchBlocks(estateSelect.value));
  blockSelect?.addEventListener("change", () => {
    const opt = blockSelect.options[blockSelect.selectedIndex];
    if (blockSelect.value) loadSearchParcels(opt.dataset.code, blockSelect.value, estateSelect?.value);
    else { parcelSelect.innerHTML = '<option value="">— Select Block first —</option>'; parcelSelect.disabled = true; }
  });
  parcelSelect?.addEventListener("change", () => {
    const blockInput = document.getElementById("parcelSearchBlockInput");
    const noInput   = document.getElementById("parcelSearchNoInput");
    if (blockInput) blockInput.value = blockSelect?.value || "";
    if (noInput) noInput.value = parcelSelect?.value || "";
    if (blockSelect?.value) runLocateParcelFromPopover();
  });
  goBtn?.addEventListener("click", () => {
    const blockInput = document.getElementById("parcelSearchBlockInput");
    const noInput   = document.getElementById("parcelSearchNoInput");
    if (blockInput) blockInput.value = blockSelect?.value || "";
    if (noInput) noInput.value = parcelSelect?.value || "";
    runLocateParcelFromPopover();
  });

  // ── Legacy form ────────────────────────────────────────────────────────────
  searchBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (searchPanelOpen) {
      closeSearchPanel({ clearHighlight: false });
    } else {
      openSearchPanel("parcel");
      loadSearchEstates();
    }
  });

  cancelBtn?.addEventListener("click", () => {
    setParcelSearchPopoverError("");
    clearSearchHighlight();
  });

  form?.addEventListener("submit", (e) => {
    e.preventDefault();
    runLocateParcelFromPopover();
  });

  // Also wire legacy "Go" button
  const legacyGoBtn = document.getElementById("parcelSearchGoBtnLegacy");
  legacyGoBtn?.addEventListener("click", () => runLocateParcelFromPopover());
}

function stopActiveTool() {
  try {
    detachSnapInteractions();
    if (smartMeasureListener) {
      try {
        ol.Observable.unByKey(smartMeasureListener);
      } catch (e) {
        console.warn("Error unbinding listener:", e);
      }
      smartMeasureListener = null;
    }
    if (activeInteraction && map) {
      map.removeInteraction(activeInteraction);
      activeInteraction = null;
    }
    const mapEl = document.getElementById("map");
    if (mapEl) mapEl.style.cursor = "";
    
    const ph = document.getElementById("panelHost");
    if (ph) ph.classList.remove("side-panel--minimized");
  } catch (err) {
    console.error("Error stopping active tool:", err);
  }
}

function drawGeometry(layerType) {
  stopActiveTool();
  setDrawToolsFeedback("", false);
  if (layerType === "BLOCKS") {
    const code = drawBlockCodeInput?.value?.trim() ?? "";
    if (!code) {
      setDrawToolsFeedback("Enter a block code or name before drawing.", true);
      setStatus(statusEl, "Enter block code before draw block.", true);
      return;
    }
  } else {
    const blk = drawParcelBlockInput?.value?.trim() ?? "";
    if (!blk) {
      setDrawToolsFeedback("Enter the parent block code or number before drawing.", true);
      setStatus(statusEl, "Enter parent block before draw parcel.", true);
      return;
    }
    const overrideRaw = drawParcelNoOverride?.value?.trim() ?? "";
    if (overrideRaw !== "" && !/^\d+$/.test(overrideRaw)) {
      setDrawToolsFeedback("Parcel number override must be a whole number.", true);
      return;
    }
  }

  const draw = new ol.interaction.Draw({ source: editSource, type: "Polygon" });
  draw.on("drawend", async (evt) => {
    map.removeInteraction(draw);
    activeInteraction = null;
    detachSnapInteractions();
    const feature = evt.feature;
    editSource.clear(true);
    let blockCode = "";
    let parcelNoOverride = null;
    if (layerType === "BLOCKS") {
      blockCode = drawBlockCodeInput?.value?.trim() ?? "";
    } else {
      blockCode = drawParcelBlockInput?.value?.trim() ?? "";
      const o = drawParcelNoOverride?.value?.trim() ?? "";
      parcelNoOverride = o === "" ? null : parseInt(o, 10);
    }
    await saveGeometry(feature, layerType, { blockCode, parcelNoOverride });
  });
  activeInteraction = draw;
  map.addInteraction(draw);
  attachSnapInteractions(readSnapOptions());
  setDrawToolsFeedback(
    layerType === "BLOCKS"
      ? "Click corners, double-click to finish the block polygon."
      : "Click corners, double-click to finish the parcel polygon.",
    false
  );
  setStatus(statusEl, `Drawing ${layerType === "BLOCKS" ? "block" : "parcel"}…`);
}

async function saveGeometry(feature, layerType, opts = {}) {
  const { blockCode: blockCodeRaw, parcelNoOverride } = opts;
  const blockCode = String(blockCodeRaw ?? "").trim();
  if (!blockCode) {
    setDrawToolsFeedback("Block code is missing.", true);
    setStatus(statusEl, "Block code is required.", true);
    return;
  }

  const geojson = new ol.format.GeoJSON().writeFeatureObject(feature, {
    featureProjection: "EPSG:3857",
    dataProjection: "EPSG:4326"
  });

  let parcelNo = null;
  if (layerType === "PARCELS") {
    parcelNo = parcelNoOverride;
    if (parcelNo != null && (!Number.isInteger(parcelNo) || parcelNo < 1)) {
      setDrawToolsFeedback("Parcel number must be a positive whole number.", true);
      setStatus(statusEl, "Invalid parcel number.", true);
      return;
    }
  }

  const { data: savedId, error } = await supabase.rpc("vsl_upsert_geometry", {
    p_layer_type: layerType,
    p_block_code: blockCode,
    p_parcel_no: parcelNo,
    p_geojson: geojson.geometry,
    p_user_id: currentUser.id
  });
  if (error) {
    setDrawToolsFeedback(error.message, true);
    setStatus(statusEl, `Save failed: ${error.message}`, true);
    return;
  }
  await loadLayersFromDb();
  if (layerType === "PARCELS" && parcelNo == null && savedId) {
    const { data: row } = await supabase
      .from("vsl_parcels")
      .select("parcel_no")
      .eq("id", savedId)
      .maybeSingle();
    if (row?.parcel_no != null) {
      const msg = `Parcel saved as plot ${row.parcel_no} in block ${blockCode}.`;
      setDrawToolsFeedback(msg, false);
      setStatus(statusEl, msg);
    } else {
      const msg = `Parcel saved in block ${blockCode}.`;
      setDrawToolsFeedback(msg, false);
      setStatus(statusEl, msg);
    }
  } else if (layerType === "PARCELS") {
    const msg = `Parcel ${parcelNo} saved in block ${blockCode}.`;
    setDrawToolsFeedback(msg, false);
    setStatus(statusEl, msg);
  } else {
    const msg = `Block ${blockCode} geometry saved.`;
    setDrawToolsFeedback(msg, false);
    setStatus(statusEl, msg);
  }
}

function startMeasure(type, isDrawOnly = false) {
  stopActiveTool();
  editSource.clear(true);
  const draw = new ol.interaction.Draw({ source: editSource, type });
  
  const mapEl = document.getElementById("map");
  if (mapEl) mapEl.style.cursor = "crosshair";

  draw.on("drawend", (evt) => {
    map.removeInteraction(draw);
    activeInteraction = null;
    detachSnapInteractions();
    const geom = evt.feature.getGeometry();
    editSource.removeFeature(evt.feature);
    
    if (isDrawOnly) {
      const feat = new ol.Feature({ geometry: geom.clone() });
      feat.set("_measureKind", "draw");
      measureSource.addFeature(feat);
      const msg = `Drawing complete.`;
      setDrawToolsFeedback(msg, false);
      setStatus(statusEl, msg);
    } else if (type === "LineString") {
      const feat = new ol.Feature({ geometry: geom.clone() });
      feat.set("_measureKind", "distance");
      const totalM = ol.sphere.getLength(geom, { projection: MAP_DRAW_PROJ });
      measureSource.addFeature(feat);
      const msg = `Total length: ${formatGroundLengthM(totalM)}. Segment labels are on the map.`;
      setDrawToolsFeedback(msg, false);
      setStatus(statusEl, msg);
    } else {
      const feat = new ol.Feature({ geometry: geom.clone() });
      feat.set("_measureKind", "area");
      
      let areaAcres = 0;
      try {
        const ring = geom.getLinearRing(0);
        if (ring) {
          const lonLats = ring.getCoordinates().map(pt => ol.proj.transform(pt, MAP_DRAW_PROJ, "EPSG:4326"));
          areaAcres = computeUtmCartesianAreaAcres(lonLats);
        }
      } catch {}
      
      if (!areaAcres || areaAcres <= 0) {
        const areaM2 = ol.sphere.getArea(geom, { projection: MAP_DRAW_PROJ });
        areaAcres = (areaM2 / 10000) * 2.47105;
      }
      
      measureSource.addFeature(feat);
      const msg = `Area: ${areaAcres.toFixed(2)} ac`;
      setDrawToolsFeedback(msg, false);
      setStatus(statusEl, msg);
    }
  });
  activeInteraction = draw;
  map.addInteraction(draw);
  attachSnapInteractions(readSnapOptions());
  setDrawToolsFeedback("", false);
  setStatus(statusEl, type === "LineString" ? "Measuring distance…" : "Measuring area…");
}

function startSmartMeasure() {
  try {
    stopActiveTool();
    editSource.clear(true);
    
    const mapEl = document.getElementById("map");
    if (mapEl) mapEl.style.cursor = "crosshair";

    const distEl = document.getElementById("measureDistanceReadout");
    const areaEl = document.getElementById("measureAreaReadout");

    const sketchFeatures = new ol.Collection();

    const draw = new ol.interaction.Draw({
      source: editSource,
      type: "LineString"
    });

    draw.on("drawstart", (evt) => {
      const sketch = evt.feature;
      sketchFeatures.clear();
      
      const geom = sketch.getGeometry();
      const coords = geom ? geom.getCoordinates() : [];
      if (coords && coords.length > 0) {
        const startPointFeature = new ol.Feature({
          geometry: new ol.geom.Point(coords[0])
        });
        sketchFeatures.push(startPointFeature);
      }

      const sketchSnap = new ol.interaction.Snap({
        features: sketchFeatures,
        pixelTolerance: 12
      });
      map.addInteraction(sketchSnap);
      activeSnapInteractions.push(sketchSnap);
      
      // Clear display readouts at the start of a new draw
      if (distEl) distEl.textContent = "0.00 m";
      if (areaEl) areaEl.textContent = "0.00 ac";
      if (measureFeedback) measureFeedback.textContent = "";

      let lastClickedCoordsLength = 0;

      smartMeasureListener = sketch.getGeometry().on("change", (geomEvt) => {
        try {
          const geom = geomEvt.target;
          const coords = geom.getCoordinates();
          
          if (coords && coords.length > 0 && sketchFeatures.getLength() === 0) {
            const startPointFeature = new ol.Feature({
              geometry: new ol.geom.Point(coords[0])
            });
            sketchFeatures.push(startPointFeature);
          }

          // Calculate based on clicked points only (exclude the moving mouse pointer at the end)
          if (coords && coords.length > 1) {
            const clickedCoords = coords.slice(0, -1);
            
            if (clickedCoords.length !== lastClickedCoordsLength) {
              lastClickedCoordsLength = clickedCoords.length;

              // Programmatically finish drawing if clicked back on start point
              if (clickedCoords.length >= 4) {
                const first = clickedCoords[0];
                const last = clickedCoords[clickedCoords.length - 1];
                const dist = Math.hypot(first[0] - last[0], first[1] - last[1]);
                if (dist < 0.1) {
                  // User clicked on start point! Let's finish the drawing programmatically.
                  setTimeout(() => {
                    try {
                      if (activeInteraction === draw) {
                        draw.finishDrawing();
                      }
                    } catch (e) {
                      console.warn("Error auto-closing drawing:", e);
                    }
                  }, 10);
                  return;
                }
              }

              // Update distance
              if (clickedCoords.length >= 2) {
                const tempLine = new ol.geom.LineString(clickedCoords);
                const totalM = ol.sphere.getLength(tempLine, { projection: MAP_DRAW_PROJ });
                if (distEl) distEl.textContent = formatGroundLengthM(totalM);
              } else {
                if (distEl) distEl.textContent = "0.00 m";
              }
              
              // Update area
              if (clickedCoords.length >= 3) {
                const isClosedAlready = clickedCoords.length >= 4 &&
                  Math.hypot(clickedCoords[0][0] - clickedCoords[clickedCoords.length - 1][0], clickedCoords[0][1] - clickedCoords[clickedCoords.length - 1][1]) < 0.1;
                const closedCoords = isClosedAlready ? [...clickedCoords] : [...clickedCoords, clickedCoords[0]];
                const tempPoly = new ol.geom.Polygon([closedCoords]);
                let areaAcres = 0;
                try {
                  const ring = tempPoly.getLinearRing(0);
                  if (ring) {
                    const lonLats = ring.getCoordinates().map(pt => ol.proj.transform(pt, MAP_DRAW_PROJ, "EPSG:4326"));
                    areaAcres = computeUtmCartesianAreaAcres(lonLats);
                  }
                } catch (err) {}
                if (!areaAcres || areaAcres <= 0) {
                  const areaM2 = ol.sphere.getArea(tempPoly, { projection: MAP_DRAW_PROJ });
                  areaAcres = (areaM2 / 10000) * 2.47105;
                }
                if (areaEl) areaEl.textContent = `${areaAcres.toFixed(2)} ac`;
              } else {
                if (areaEl) areaEl.textContent = "0.00 ac";
              }
            }
          } else {
            if (distEl) distEl.textContent = "0.00 m";
            if (areaEl) areaEl.textContent = "0.00 ac";
            lastClickedCoordsLength = 0;
          }
        } catch (err) {
          console.error("Error in Measure change listener:", err);
        }
      });
    });

    draw.on("drawend", (evt) => {
      if (smartMeasureListener) {
        try {
          ol.Observable.unByKey(smartMeasureListener);
        } catch (e) {
          console.warn("Error unbinding listener:", e);
        }
        smartMeasureListener = null;
      }

      sketchFeatures.clear();
      map.removeInteraction(draw);
      activeInteraction = null;
      detachSnapInteractions();
      
      try {
        const geom = evt.feature.getGeometry();
        editSource.removeFeature(evt.feature);
        
        const coords = geom.getCoordinates();
        if (!coords || coords.length < 2) return;

        const uniqueCoords = [];
        for (const coord of coords) {
          if (uniqueCoords.length === 0) {
            uniqueCoords.push(coord);
          } else {
            const prev = uniqueCoords[uniqueCoords.length - 1];
            if (Math.hypot(prev[0] - coord[0], prev[1] - coord[1]) > 0.001) {
              uniqueCoords.push(coord);
            }
          }
        }

        const isClosed = uniqueCoords.length >= 3;

        if (isClosed) {
          // Explicitly close the polygon coordinate ring
          const closedCoords = [...uniqueCoords, uniqueCoords[0]];
          
          const polyGeom = new ol.geom.Polygon([closedCoords]);
          const feat = new ol.Feature({ geometry: polyGeom });
          feat.set("_measureKind", "area");
          
          let areaAcres = 0;
          try {
            const ring = polyGeom.getLinearRing(0);
            if (ring) {
              const lonLats = ring.getCoordinates().map(pt => ol.proj.transform(pt, MAP_DRAW_PROJ, "EPSG:4326"));
              areaAcres = computeUtmCartesianAreaAcres(lonLats);
            }
          } catch (err) {}
          if (!areaAcres || areaAcres <= 0) {
            const areaM2 = ol.sphere.getArea(polyGeom, { projection: MAP_DRAW_PROJ });
            areaAcres = (areaM2 / 10000) * 2.47105;
          }
          
          measureSource.addFeature(feat);
          const totalM = ol.sphere.getLength(polyGeom, { projection: MAP_DRAW_PROJ });
          
          if (distEl) distEl.textContent = formatGroundLengthM(totalM);
          if (areaEl) areaEl.textContent = `${areaAcres.toFixed(2)} ac`;
          
          const msg = `Area: ${areaAcres.toFixed(2)} ac (Perimeter: ${formatGroundLengthM(totalM)})`;
          setStatus(statusEl, msg);
          if (measureFeedback) measureFeedback.textContent = msg;
        } else {
          const lineGeom = new ol.geom.LineString(uniqueCoords);
          const feat = new ol.Feature({ geometry: lineGeom });
          feat.set("_measureKind", "distance");
          const totalM = ol.sphere.getLength(lineGeom, { projection: MAP_DRAW_PROJ });
          
          measureSource.addFeature(feat);
          
          if (distEl) distEl.textContent = formatGroundLengthM(totalM);
          if (areaEl) areaEl.textContent = "0.00 ac";
          
          const msg = `Distance: ${formatGroundLengthM(totalM)}`;
          setStatus(statusEl, msg);
          if (measureFeedback) measureFeedback.textContent = msg;
        }
      } catch (err) {
        console.error("Error finalizing measure:", err);
      }

      if (measurePanel && !measurePanel.hidden) {
        setTimeout(() => {
          if (measurePanel && !measurePanel.hidden) {
            startSmartMeasure();
          }
        }, 100);
      }
    });

    activeInteraction = draw;
    map.addInteraction(draw);
    attachSnapInteractions({ snapAllVisible: true });
    setStatus(statusEl, "Measuring active. Click to start.");
  } catch (err) {
    console.error("Error starting measure:", err);
    if (measureFeedback) {
      measureFeedback.textContent = "Error: " + err.message;
    }
  }
}

let userLocationLayer = null;
let currentBackgroundLocation = null;
let backgroundWatchId = null;

function startBackgroundLocationTracking() {
  if (!navigator.geolocation) return;
  
  if (!userLocationLayer && map) {
    userLocationLayer = new ol.layer.Vector({
      source: new ol.source.Vector(),
      zIndex: 1100,
      style: new ol.style.Style({
        image: new ol.style.Circle({
          radius: 8,
          fill: new ol.style.Fill({ color: '#3b82f6' }), /* Blue dot */
          stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 })
        })
      })
    });
    userLocationLayer.set("displayInLayerSwitcher", false);
    userLocationLayer.set("title", "My Location");
    map.addLayer(userLocationLayer);
  }

  if (backgroundWatchId) return;

  backgroundWatchId = navigator.geolocation.watchPosition((pos) => {
    const coord = ol.proj.fromLonLat([pos.coords.longitude, pos.coords.latitude]);
    currentBackgroundLocation = coord;
    
    if (userLocationLayer) {
      userLocationLayer.getSource().clear();
      userLocationLayer.getSource().addFeature(new ol.Feature({
        geometry: new ol.geom.Point(coord)
      }));
    }
  }, (err) => {
    console.warn("Background location error:", err.message);
  }, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
}

function locateMe() {
  if (!navigator.geolocation) {
    setStatus(statusEl, "Geolocation is not supported in this browser.", true);
    return;
  }
  
  if (currentBackgroundLocation && map) {
    map.getView().animate({ center: currentBackgroundLocation, zoom: 16, duration: 350 });
    setStatus(statusEl, "Location found.");
    setTimeout(() => clearStatus(statusEl), 3000);
  } else {
    setStatus(statusEl, "Waiting for location...", true);
    if (!backgroundWatchId) {
      startBackgroundLocationTracking();
    }
  }
}
let isWalkModeActive = false;
let walkModeCoords = [];

function setupWalkMode() {
  window.addEventListener("vsl-measure-mode", (e) => {
    const mode = e.detail; // 'pick' or 'walk'
    const activeContainer = document.getElementById("measureActiveContainer");
    const startContainer = document.getElementById("measureStartWalkContainer");
    const clearBtn = document.getElementById("clearMeasuresBtn");
    const markBtn = document.getElementById("markWalkBtn");
    const finishBtn = document.getElementById("finishWalkBtn");
    
    if (mode === 'pick') {
      isWalkModeActive = false;
      if (startContainer) startContainer.style.display = "none";
      if (activeContainer) activeContainer.style.display = "block";
      if (clearBtn) clearBtn.style.display = "flex";
      if (markBtn) markBtn.style.display = "none";
      if (finishBtn) finishBtn.style.display = "none";
      startSmartMeasure();
    } else {
      isWalkModeActive = false;
      stopActiveTool();
      editSource.clear(true);
      if (startContainer) startContainer.style.display = "block";
      if (activeContainer) activeContainer.style.display = "none";
      if (clearBtn) clearBtn.style.display = "none";
      if (markBtn) markBtn.style.display = "none";
      if (finishBtn) finishBtn.style.display = "none";
    }
  });

  const startWalkBtn = document.getElementById("startWalkBtn");
  if (startWalkBtn) {
    startWalkBtn.addEventListener("click", () => {
      if (!currentBackgroundLocation) {
        alert("Waiting for GPS location. Please ensure location services are enabled.");
        if (!backgroundWatchId) startBackgroundLocationTracking();
        return;
      }
      
      if (map) {
        map.getView().animate({ center: currentBackgroundLocation, zoom: 16, duration: 350 });
      }
      
      isWalkModeActive = true;
      walkModeCoords = [];
      editSource.clear(true);
      document.getElementById("measureStartWalkContainer").style.display = "none";
      document.getElementById("measureActiveContainer").style.display = "block";
      
      document.getElementById("markWalkBtn").style.display = "flex";
      document.getElementById("finishWalkBtn").style.display = "flex";
      
      const distEl = document.getElementById("measureDistanceReadout");
      const areaEl = document.getElementById("measureAreaReadout");
      if (distEl) distEl.textContent = "0.00 m";
      if (areaEl) areaEl.textContent = "0.00 ac";
    });
  }

  const markWalkBtn = document.getElementById("markWalkBtn");
  if (markWalkBtn) {
    markWalkBtn.addEventListener("click", () => {
      if (!currentBackgroundLocation) {
        alert("No GPS location available yet. Please wait for signal.");
        return;
      }
      walkModeCoords.push([...currentBackgroundLocation]);
      redrawWalkMode();
    });
  }

  const finishWalkBtn = document.getElementById("finishWalkBtn");
  if (finishWalkBtn) {
    finishWalkBtn.addEventListener("click", () => {
      if (walkModeCoords.length >= 3) {
        const polyCoords = [...walkModeCoords, walkModeCoords[0]];
        const poly = new ol.geom.Polygon([polyCoords]);
        const feat = new ol.Feature({ geometry: poly });
        feat.set("_measureKind", "area");
        measureSource.addFeature(feat);
        setStatus(statusEl, "Walk area measurement finished.");
      } else if (walkModeCoords.length >= 2) {
        const line = new ol.geom.LineString(walkModeCoords);
        const feat = new ol.Feature({ geometry: line });
        feat.set("_measureKind", "distance");
        measureSource.addFeature(feat);
        setStatus(statusEl, "Walk distance measurement finished.");
      }
      
      isWalkModeActive = false;
      walkModeCoords = [];
      editSource.clear(true);
      
      document.getElementById("measureStartWalkContainer").style.display = "block";
      document.getElementById("measureActiveContainer").style.display = "none";
      document.getElementById("markWalkBtn").style.display = "none";
      document.getElementById("finishWalkBtn").style.display = "none";
    });
  }
}

function redrawWalkMode() {
  editSource.clear(true);
  
  walkModeCoords.forEach((coord, idx) => {
    const pt = new ol.Feature(new ol.geom.Point(coord));
    const pointStyle = [
      new ol.style.Style({
        image: new ol.style.Circle({
          radius: 6,
          fill: new ol.style.Fill({ color: '#f59e0b' }), 
          stroke: new ol.style.Stroke({ color: '#fff', width: 2 })
        })
      }),
      new ol.style.Style({
        text: new ol.style.Text({
          text: String(idx + 1),
          font: 'bold 12px sans-serif',
          fill: new ol.style.Fill({ color: '#fff' }),
          stroke: new ol.style.Stroke({ color: '#000', width: 3 }),
          offsetY: -18
        })
      })
    ];
    pt.setStyle(pointStyle);
    editSource.addFeature(pt);
  });
  
  const distEl = document.getElementById("measureDistanceReadout");
  const areaEl = document.getElementById("measureAreaReadout");
  
  if (walkModeCoords.length >= 2) {
    const line = new ol.Feature(new ol.geom.LineString(walkModeCoords));
    editSource.addFeature(line);
    
    const totalM = ol.sphere.getLength(line.getGeometry(), { projection: MAP_DRAW_PROJ });
    if (distEl) distEl.textContent = formatGroundLengthM(totalM);
  } else {
    if (distEl) distEl.textContent = "0.00 m";
  }
  
  if (walkModeCoords.length >= 3) {
    const polyCoords = [...walkModeCoords, walkModeCoords[0]];
    const poly = new ol.geom.Polygon([polyCoords]);
    
    let areaAcres = 0;
    try {
      const ring = poly.getLinearRing(0);
      if (ring) {
        const lonLats = ring.getCoordinates().map(pt => ol.proj.transform(pt, MAP_DRAW_PROJ, "EPSG:4326"));
        areaAcres = computeUtmCartesianAreaAcres(lonLats);
      }
    } catch {}
    
    if (!areaAcres || areaAcres <= 0) {
      const areaM2 = ol.sphere.getArea(poly, { projection: MAP_DRAW_PROJ });
      areaAcres = (areaM2 / 10000) * 2.47105;
    }
    
    if (areaEl) areaEl.textContent = areaAcres.toFixed(2) + " ac";
  } else {
    if (areaEl) areaEl.textContent = "0.00 ac";
  }
}

function bindEvents() {
  setupWalkMode();
  setupPanels();
  setupSearchTabSwitching();
  setupParcelSearchPopover();
  setupParcelStatusPanel();
  setupPlaceSearch();

  const searchCloseBtn = document.getElementById("searchPanelCloseBtn");
  searchCloseBtn?.addEventListener("click", () => closeSearchPanel({ clearHighlight: false }));

  drawLineBtn?.addEventListener("click", () => startMeasure("LineString", true));
  drawPolygonBtn?.addEventListener("click", () => startMeasure("Polygon", true));
  stopDrawBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    stopActiveTool();
  });
  
  clearDrawingsBtn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    measureSource.clear(true);
    setDrawToolsFeedback("Drawings cleared.", false);
    setStatus(statusEl, "Drawings cleared.");
  });
  
  const handleClearMeasures = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    measureSource.clear(true);
    const distEl = document.getElementById("measureDistanceReadout");
    const areaEl = document.getElementById("measureAreaReadout");
    if (distEl) distEl.textContent = "0.00 m";
    if (areaEl) areaEl.textContent = "0.00 ac";
    if (measureFeedback) measureFeedback.textContent = "Measurements cleared.";
    setTimeout(() => { if (measureFeedback) measureFeedback.textContent = ""; }, 3000);
    setStatus(statusEl, "Measurements cleared.");
    // Restart active smart measure to begin fresh sketch if open
    if (measurePanel && !measurePanel.hidden) {
      if (isWalkModeActive) {
        walkModeCoords = [];
        redrawWalkMode();
      } else {
        startSmartMeasure();
      }
    }
  };
  clearMeasuresBtn?.addEventListener("click", handleClearMeasures);
  clearMeasuresBtn?.addEventListener("touchstart", handleClearMeasures, { passive: false });

  measureTopBtn?.addEventListener("click", (e) => {
    if (measurePanel) {
      measurePanel.hidden = !measurePanel.hidden;
      if (!measurePanel.hidden) {
        // Close search panel, UAM, and Modify panel to prevent overlap
        closeSearchPanel({ clearHighlight: false });
        closeUAM();
        closeParcelStatusPanel();
        
        const tabPick = document.getElementById('measureTabPick');
        const tabWalk = document.getElementById('measureTabWalk');
        if (tabPick && tabWalk) {
          tabPick.setAttribute('aria-selected', 'true');
          tabWalk.setAttribute('aria-selected', 'false');
          window.dispatchEvent(new CustomEvent('vsl-measure-mode', {detail:'pick'}));
        } else {
          startSmartMeasure();
        }
      } else {
        stopActiveTool();
      }
    }
  });

  const handleCloseMeasurePanel = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (measurePanel) measurePanel.hidden = true;
    stopActiveTool();
  };
  measurePanelCloseBtn?.addEventListener("click", handleCloseMeasurePanel);
  measurePanelCloseBtn?.addEventListener("touchstart", handleCloseMeasurePanel, { passive: false });

  const undoMeasureBtn = document.getElementById("undoMeasureBtn");
  const handleUndo = (e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (isWalkModeActive) {
      if (walkModeCoords.length > 0) {
        walkModeCoords.pop();
        redrawWalkMode();
      }
    } else if (activeInteraction && typeof activeInteraction.removeLastPoint === "function") {
      activeInteraction.removeLastPoint();
    }
  };
  undoMeasureBtn?.addEventListener("click", handleUndo);
  undoMeasureBtn?.addEventListener("touchstart", handleUndo, { passive: false });

  locateBtn.addEventListener("click", locateMe);
  fullscreenBtn.addEventListener("click", () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
  });
  logoutBtn.addEventListener("click", async () => {
    await supabase.auth.signOut();
    window.location.href = "./login.html";
  });

  window.addEventListener("resize", () => map?.updateSize());
}

async function initUser() {
  const { data } = await supabase.auth.getSession();
  if (!data.session?.user) {
    if (cfg.ALLOW_GUEST_PREVIEW) {
      isAuthenticated = false;
      currentUser = { id: "guest" };
      currentProfile = { role: "GUEST" };
      const psBanner = document.getElementById("parcelStatusReadOnlyBanner");
      const psApply = document.getElementById("parcelStatusApplyBtn");
      if (psBanner) psBanner.hidden = false;
      if (psApply) psApply.disabled = true;
      return true;
    }
    window.location.href = "./login.html";
    return false;
  }
  currentUser = data.session.user;
  isAuthenticated = true;
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
  const psBanner = document.getElementById("parcelStatusReadOnlyBanner");
  const psApply = document.getElementById("parcelStatusApplyBtn");
  const statusReadonly =
    currentProfile.role === "MANAGMENT";
  if (psBanner) psBanner.hidden = !statusReadonly;
  if (psApply) psApply.disabled = statusReadonly;

  if (currentProfile.role === "MANAGMENT") {
    if (measureLineBtn) measureLineBtn.disabled = true;
    if (measureAreaBtn) measureAreaBtn.disabled = true;
    if (measureTopBtn) measureTopBtn.disabled = true;
    const undoMeasureBtn = document.getElementById("undoMeasureBtn");
    if (undoMeasureBtn) undoMeasureBtn.disabled = true;
    if (stopDrawBtn) stopDrawBtn.disabled = true;
    if (clearMeasuresBtn) clearMeasuresBtn.disabled = true;
    for (const el of [
      snapBlocksCb,
      snapParcelsCb,
      snapSurveyCb
    ]) {
      if (el) el.disabled = true;
    }
    const sp = document.getElementById("surveyPreviewBtn");
    const ss = document.getElementById("surveySaveBtn");
    if (sp) sp.disabled = true;
    if (ss) ss.disabled = true;
  }
  return true;
}

async function initMap() {
  map = new ol.Map({
    target: "map",
    layers: buildLayerTree(),
    view: new ol.View({
      center: ol.proj.fromLonLat(cfg.DEFAULT_CENTER || [32.59, 0.35]),
      zoom: cfg.DEFAULT_ZOOM || 11
    }),
    controls: []
  });

  map.on("dblclick", (evt) => {
    if (activeInteraction && typeof activeInteraction.finishDrawing === "function") {
      if (evt.originalEvent) {
        evt.originalEvent.preventDefault();
        evt.originalEvent.stopPropagation();
      }
      try {
        activeInteraction.finishDrawing();
      } catch (e) {
        console.warn("Error auto-closing drawing on dblclick:", e);
      }
      return false;
    }
  });

  const luweeroExtent = ol.proj.transformExtent(
    [32.24921182, 0.957816699, 32.5740272, 1.104066909],
    "EPSG:4326",
    "EPSG:3857"
  );
  setTimeout(() => {
    map.updateSize();
    map.getView().fit(luweeroExtent, { padding: [10, 10, 10, 10], maxZoom: 16 });
  }, 400);

  const LayerSwitcherClass = ol.control.LayerSwitcher || window.LayerSwitcher;
  if (LayerSwitcherClass) {
    const layerSwitcher = new LayerSwitcherClass({
      tipLabel: "Layers",
      groupSelectStyle: "children",
      activationMode: "click",
      startActive: false
    });
    map.addControl(layerSwitcher);
    if (typeof layerSwitcher.renderPanel === "function") {
      setTimeout(() => {
        layerSwitcher.renderPanel();
        if (typeof layerSwitcher.hidePanel === "function") {
          layerSwitcher.hidePanel();
        }
      }, 0);
    }
  } else {
    console.warn("LayerSwitcher not found at ol.control.LayerSwitcher or window.LayerSwitcher");
    enableFallbackLayerSwitcher();
  }

  // Google tile fallback in case provider blocks/returns empty.
  const googleLayer = baseGroupRef?.getLayers()?.getArray()?.find((l) => l.get("title") === "Google Satellite Hybrid");
  if (googleLayer?.getSource) {
    let errorCount = 0;
    googleLayer.getSource().on("tileloaderror", () => {
      errorCount += 1;
      if (errorCount >= 4 && googleLayer.getVisible()) {
        setBasemapByTitle("Esri World Imagery");
        const radio = fallbackLayerSwitcherEl?.querySelector("input[name='fbBasemap'][value='Esri World Imagery']");
        if (radio) radio.checked = true;
        setStatus(statusEl, "Google Hybrid unavailable. Fell back to Esri World Imagery.", true);
      }
    });
  }

  setupInfoPopup();
  bindEvents();
  startBackgroundLocationTracking();
  initPrintComposer({
    getMap: () => map,
    getBaseGroup: () => baseGroupRef,
    blocksSource,
    parcelsSource,
    blocksLayer,
    parcelsLayer,
    setStatus,
    statusEl
  });
  const surveyImportHandles = initSurveyImport({
    map,
    cfg,
    setStatus,
    statusEl,
    loadLayersFromDb,
    getManagementLocked: () => currentProfile?.role === "MANAGMENT",
    blocksSource,
    parcelsSource
  });
  surveyPreviewSnapSources = surveyImportHandles?.getPreviewSnapSources?.() ?? null;

  if (sentinelGroupRef) {
    const sentinelCtl = initSentinelAnalytics({
      map,
      cfg,
      getBaseGroup: () => baseGroupRef,
      sentinelGroup: sentinelGroupRef,
      blocksLayer,
      parcelsLayer,
      getSurveyPreviewLayers: () => surveyImportHandles?.getPreviewLayers?.() ?? null,
      closeOtherPanels: () => {
        closeSearchPanel({ clearHighlight: false });
      }
    });
    if (sentinelCtl?.close) {
      vslCloseSentinelPanel = sentinelCtl.close;
    }
  }

  initFarmReports({
    map,
    supabase,
    blocksSource,
    cfg,
    setStatus,
    statusEl,
    getCurrentUser: () => currentUser
  });

  initCoordSearchDrawer({
    map,
    setStatus,
    statusEl,
    onDrawerOpen: () => {},
    onDrawerClose: () => {},
    panelMode: true,
    annotationsGroup: annotationsGroupRef
  });
  initCoordExtractDrawer({
    map,
    parcelsLayer,
    blocksLayer,
    setStatus,
    statusEl,
    stopActiveTool,
    panelMode: true
  });

  initExportTools({
    map,
    parcelsLayer,
    blocksLayer,
    setStatus,
    statusEl
  });

  initDroneImageModule({
    map,
    supabase,
    setStatus,
    statusEl,
    getBaseGroup: () => baseGroupRef,
    droneGroup: droneImagesGroupRef
  });

  initUnifiedMenu({
    map,
    supabase,
    cfg,
    setStatus,
    statusEl,
    blocksSource,
    parcelsSource,
    blocksLayer,
    parcelsLayer,
    surveyPreviewSnapSources,
    stopActiveTool
  });

  await loadLayersFromDb();
  map.on("moveend", async () => {
    await loadLayersFromDb();
  });

  const loader = document.getElementById("mapLoader");
  if (loader) {
    loader.classList.add("hidden");
    setTimeout(() => loader.remove(), 500);
  }

  // Global drag and drop for survey files on map canvas
  const mapEl = document.getElementById("map");
  if (mapEl) {
    mapEl.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      mapEl.classList.add("map-drop-active");
    });
    mapEl.addEventListener("dragleave", () => mapEl.classList.remove("map-drop-active"));
    mapEl.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      mapEl.classList.remove("map-drop-active");
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      const name = f.name.toLowerCase();
      const isSurvey = name.endsWith(".dxf") || name.endsWith(".csv") ||
                       name.endsWith(".kml") || name.endsWith(".geojson") ||
                       name.endsWith(".json");
      if (isSurvey && window.handleGlobalSurveyDrop) {
        await window.handleGlobalSurveyDrop(f);
      }
    });
  }

  // First paint often reports 0×0 map size; reload layers once layout is stable.
  requestAnimationFrame(() => {
    map.updateSize();
    loadLayersFromDb();
  });
  setTimeout(() => {
    map.updateSize();
    loadLayersFromDb();
  }, 350);
}

async function start() {
  clearStatus(statusEl);
  const ok = await initUser();
  if (!ok) return;
  await initMap();
  if (isAuthenticated) {
    setStatus(statusEl, `Signed in as ${currentProfile.role}. Ready.`);
  } else if (cfg.ALLOW_GUEST_PREVIEW) {
    setStatus(statusEl, "Guest preview mode: sign in for full access.");
  }
}

// Expose key references globally for the Rover inline script (non-module context)
window._vslMap        = () => map;
window._vslBlocksSrc  = blocksSource;
window._vslParcelsSrc = parcelsSource;
window._vslBlocksLyr  = blocksLayer;
window._vslParcelsLyr = parcelsLayer;
window.closeParcelStatusPanel = closeParcelStatusPanel;

start().catch((err) => setStatus(statusEl, err.message, true));
