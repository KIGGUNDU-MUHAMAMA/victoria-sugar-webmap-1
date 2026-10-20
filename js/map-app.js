import { createSupabaseClient, getConfig } from "./supabase-client.js";
import {
  clearStatus, parseNum, setStatus, vincentyDistanceMeters, computeUtmCartesianAreaAcres,
  // Every zoom-dependent show/hide on the map reads from this one ladder —
  // see the big comment on MAP_ZOOM in utils.js for the order and why.
  MAP_ZOOM, zoomFromResolution, layerMinZoom
} from "./utils.js";
import { readLandCache, writeLandCache, clearLandCache } from "./land-cache.js";
import { initSurveyImport } from "./survey-import.js";
import { initSurveyDraw } from "./survey-draw.js";
import { initManageFeatures } from "./manage-features.js";
import { initFeatureTypeEditor } from "./feature-type-editor.js";
import { initManageEstates } from "./manage-estates.js";
import { initSurveyEdit } from "./survey-edit.js";
import { initCoordSearchDrawer } from "./coord-search-drawer.js";
import { initCoordExtractDrawer } from "./coord-extract-drawer.js";
import { initSentinelAnalytics } from "./sentinel-analytics.js?v=1.1";
import { initDroneTiles } from "./drone-tiles.js?v=1.0";
import { initFarmReports } from "./farm-reports.js";
import { initUnifiedMenu } from "./unified-menu.js?v=1.7";
import { initExportTools } from "./export-tools.js";
import { initFeatureExport, setFeatureExportContext, clearFeatureExportContext } from "./feature-export.js";
import { initPrintTool } from "./print-tool.js";
import { attachMediaToRecords, mediaFileError } from "./media-store.js";
// Role → which tools are reachable, plus the local profile cache that keeps
// boot from refetching vsl_profiles. See role-store.js for why the cache is
// a UI optimisation and never a permission check.
import {
  readCachedProfile, cacheProfile, clearCachedProfiles,
  applyToolVisibility, isLandEditor
} from "./role-store.js";
import { confirmDanger, promptFields } from "../popups/popup.js";

const supabase = createSupabaseClient();
const cfg = getConfig();

/**
 * Layer stacking order, bottom of the map upward.
 *
 * Spaced in tens so a new layer can be slotted between two existing ones
 * without renumbering. The drone imagery used to need 0.5, because Estates
 * held 1 and there was no gap left anywhere.
 *
 * A group's zIndex is only inherited by children that set none of their own,
 * so OVERLAYS never reaches Estates/Blocks/Plots/Titles — those four carry
 * their own values, and those are what actually stack.
 */
const LAYER_Z = Object.freeze({
  BASEMAPS:         0,
  DRONE:           10,   // orthomosaics: above the basemap, below everything else
  SENTINEL:        20,
  TITLES:          30,
  ESTATES:         40,
  BLOCKS:          50,
  PLOTS:           60,
  OVERLAYS:        70,   // only reaches a future child that sets no zIndex
  ANNOTATIONS:     80,
  SKETCH:         110,
  MEASURE:        120,
  USER_LOCATION:  200
});


const statusEl = document.getElementById("status");
const panelHost = document.getElementById("panelHost");

const measureLineBtn = document.getElementById("measureLineBtn");
const measureAreaBtn = document.getElementById("measureAreaBtn");
const measureAdvancedBtn = document.getElementById("measureAdvancedBtn");
const drawLineBtn = document.getElementById("drawLineBtn");
const drawPolygonBtn = document.getElementById("drawPolygonBtn");
const stopDrawBtn = document.getElementById("stopDrawBtn");
// Snap-to-existing-geometry toggle (windows/snap-panel.html) — a single
// on/off switch (no more per-layer boxes) read via isSnapMasterOn()/
// readSnapOptions() below.
const snapMasterCb = document.getElementById("snapMasterCb");
const clearMeasuresBtn = document.getElementById("clearMeasuresBtn");
const clearDrawingsBtn = document.getElementById("clearDrawingsBtn");
const drawToolsFeedback = document.getElementById("drawToolsFeedback");
const measureFeedback = document.getElementById("measureFeedback");

const measureTopBtn = document.getElementById("measureTopBtn");
const measurePanel = document.getElementById("measurePanel");
const measurePanelCloseBtn = document.getElementById("measurePanelCloseBtn");
const panelButtons = {}; // draw tools now live in UAM; no legacy panel button needed

const locateBtn = document.getElementById("locateBtn");
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
let parcelActionOverlay;
/** Overlay behind #featureInfoToolbar — the drawn-feature readout card. */
let featureInfoOverlay;
// Whether a plain map click is allowed to select a block/parcel and show
// the floating .parcel-action-toolbar (Log Activity/Alert/Info). Survey's
// Edit tab (selecting a feature to reshape) and Draw tab (drawing a new
// one) both turn this off for the duration of their session — see
// window.vslSetParcelClickEnabled below and js/survey-edit.js /
// js/survey-draw.js — so clicking a parcel while editing/drawing doesn't
// also pop up the unrelated toolbar underneath.
let parcelClickSelectionEnabled = true;
window.vslSetParcelClickEnabled = function (enabled) {
  parcelClickSelectionEnabled = !!enabled;
  if (!parcelClickSelectionEnabled) {
    selectedFeature = null;
    selectedLayerType = null;
    hideParcelActionToolbar();
  }
};
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
/** FEATURES group in the layer switcher — one proxy row per custom feature
 *  type actually used on the map, rebuilt by rebuildFeaturesSwitcherGroup()
 *  whenever features change. See buildLayerTree() and initSurveyDraw's
 *  onFeaturesRefreshed hook. */
let featuresGroupRef;
let layerSwitcherRef;
/** Set by initSentinelAnalytics so openSearchPanel can close the Sentinel dock. */
let vslCloseSentinelPanel = () => {};

const MAP_DRAW_PROJ = "EPSG:3857";

const blocksSource = new ol.source.Vector();
const parcelsSource = new ol.source.Vector();
const estatesSource = new ol.source.Vector();
// Legal land-title boundaries (vsl_title) — never linked to an Estate, drawn
// as an outline only so it can sit over Blocks/Plots without hiding their
// cultivation-status fill, for spotting cultivation that's strayed outside
// the legal boundary. See loadLayersFromDb() (bbox-loaded alongside blocks/
// parcels via vsl_get_features_bbox) and the "Title boundary" legend row in
// buildLegendList().
const titlesSource = new ol.source.Vector();
const editSource = new ol.source.Vector();

/** Set by parcel search RPC; layer styles emphasize these ids after bbox reload. */
const searchHighlight = { blockId: null, parcelId: null };

/** Handles returned by initSurveyDraw() — the drawn-features layer/source and
 *  its highlight hook, needed by the search panel's Feature tab. Assigned
 *  during init; null before that. */
let surveyDrawApi = null;
/** Re-populates the Feature tab's Kind/Type/Name dropdowns from whatever is
 *  currently on the features layer. Set by setupFeatureSearch(). */
let refreshFeatureSearchOptions = null;

/** Cultivation status → map colours (blocks & parcels when not search-highlighted).
 *
 *  Four working statuses plus Vacant. "Vacant" is deliberately unfilled —
 *  every fill check below pairs `CULTIVATION_PALETTE[status]` with
 *  `status !== "vacant"`, so a vacant plot draws as a bare outline and its
 *  legend swatch is an empty box.
 *
 *  Renamed 2026-08: not_in_cane -> vacant, replant_renovation -> ratoon,
 *  and "standing" removed entirely (its one plot was moved to planted).
 *  The database was migrated to match — vsl_parcels/vsl_blocks values,
 *  their column defaults, both *_cultivation_status_chk constraints and
 *  the vsl_block_stats view all use these keys now. */
const CULTIVATION_PALETTE = {
  vacant: { stroke: "#607d8b", fill: "rgba(0, 0, 0, 0)", text: "#455a64" },
  prepared: { stroke: "#12a876", fill: "rgba(30, 224, 161, 0.38)", text: "#0b6b4a" },
  planted: { stroke: "#2d7c33", fill: "rgba(45, 124, 51, 0.42)", text: "#1b4d20" },
  ratoon: { stroke: "#0c3d0c", fill: "rgba(12, 61, 12, 0.45)", text: "#0c3d0c" },
  harvested: { stroke: "#5fa84b", fill: "rgba(161, 251, 142, 0.48)", text: "#35702a" }
};

function cultivationKeyFromFeature(feature) {
  const s = feature.get("cultivation_status");
  return s && CULTIVATION_PALETTE[s] ? s : "vacant";
}

/* Parcel label staging used to live here as two resolution constants
   (PARCEL_FULL_DETAIL_RES / PARCEL_NAME_ONLY_RES). Both are gone: every
   zoom-dependent reveal on the map is now one ordered ladder, MAP_ZOOM in
   utils.js, so blocks, plots, labels, features and edge distances can't
   drift into a nonsensical order relative to each other. */

/** Multiplier (x font size) used for both the name/area/ratoon block's own
 *  line spacing AND the Alerts(n) line's offset below it — kept as one
 *  constant so the two can never drift out of sync with each other. */
const LABEL_LINE_HEIGHT = 1.25;

/** Alert text-line color by severity (vsl_alerts.severity: information | warning | critical). */
const ALERT_SEVERITY_COLORS = {
  critical: "#d32f2f",
  warning: "#f9a825",
  information: "#1976d2"
};

/** Same severity colors as ALERT_SEVERITY_COLORS, as translucent fills —
 *  used by parcelsLayer's style function to color a plot by its worst
 *  unresolved alert (see _alert_severity/refreshParcelAlertBadges),
 *  overriding the cultivation-status fill so an alert is visible on the
 *  map itself, not just in the "Alerts(n)" text line/popups. */
const ALERT_SEVERITY_FILL = {
  critical: "rgba(211, 47, 47, 0.42)",
  warning: "rgba(249, 168, 37, 0.42)",
  information: "rgba(25, 118, 210, 0.36)"
};

/* Gone with the on-map "Alerts(n)" label line: computeAlertChipOffsetY(),
   getMeasureTextCtx() and isClickOnAlertsLine(). That line used to be
   clickable — hit-tested by mirroring the style function's own placement
   maths — and opened the Alerts List modal for the plot.

   Nothing is lost: the plot popup now carries an Alerts row that opens the
   same modal (renderParcelActionInfo), and it is a real DOM button rather
   than a rectangle guessed from measureText. */

/** Interior anchor point for label/text-line placement — handles Polygon and MultiPolygon. */
function getFeatureInteriorPoint(geometry) {
  if (!geometry) return null;
  const type = geometry.getType();
  if (type === "Polygon") return geometry.getInteriorPoint();
  if (type === "MultiPolygon") {
    const polys = geometry.getPolygons();
    if (polys.length) return polys[0].getInteriorPoint();
  }
  return null;
}

const parcelStatusState = {
  panelOpen: false,
  pickArmed: false,
  selectedFeatures: [],
  selectedLayerType: "PARCELS",
  // Which tab is active — "PARCELS" | "BLOCKS" | "FEATURE". Kept separate
  // from selectedLayerType (which tracks the *actual* layer of whatever is
  // currently selected) so the "Feature" tab can keep accepting clicks on
  // either layer across multiple picks, instead of locking to whichever
  // layer got clicked first.
  tabMode: "PARCELS"
};

const CULTIVATION_STATUS_LABELS = {
  vacant: "Vacant",
  prepared: "Prepared",
  planted: "Planted",
  ratoon: "Ratoon",
  harvested: "Harvested"
};

/** vsl_alerts.severity -> display label, shared by badges, the info panel, and the log-alert modal. */
const SEVERITY_LABELS = { critical: "Critical", warning: "Warning", information: "Information" };

let infoHelpPopoverOpen = false;
let infoHelpOutsideHandler = null;
let infoHelpEscapeHandler = null;

let searchPanelOpen = false;
let searchPanelOutsideHandler = null;
let searchPanelEscapeHandler = null;
// Which search tab is active — drives the shared Clear/Go buttons in the
// footer (see setupUnifiedSearchActionButtons()) so they act on whichever
// tab the user is actually looking at.
let activeSearchTabId = "parcel";

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

// Badge/icon text shown in the panel's static popWinHead.
const FEATURE_INFO_BADGE = { PARCELS: "Parcel", BLOCKS: "Block", ESTATE: "Estate" };

// ---------------------------------------------------------------------------
// Log Activity — the vsl_activities.activity_name values, the fields that
// are real shared columns on every row (LOG_ACTIVITY_COMMON_FIELDS), and the
// extra per-activity properties that get stored in activity_properties jsonb
// (ACTIVITY_PROPERTY_DEFS).
//
// This used to be hardcoded here (and, separately, in the dashboard's own
// app.js — the two copies drifting apart is exactly what caused the webmap
// and dashboard to get out of sync). The real source of truth is now the
// vsl_activity_types / vsl_activity_type_properties / vsl_activity_common_fields
// tables, fetched by loadActivityCatalogFromDb() at startup (see start()),
// which overwrites the `let` bindings below in place. The literal values
// here only serve as a fallback so the form still works if that fetch ever
// fails (offline, RLS misconfigured, etc) — see docs/activities.md for the
// same list kept as human-readable reference documentation.
// ---------------------------------------------------------------------------
let ACTIVITY_NAMES = [
  "Bush Clearing", "Ploughing", "Harrow", "Ripping", "Ridging", "Furrowing",
  "Lime Application", "Planting", "Manuring", "Fertilization", "Weeding",
  "Spraying", "Irrigation", "Harvesting", "Loading",
  "Trash Lining", "Trash Collection"
];

// Shared across every activity that logs a weather condition (Planting,
// Spraying, Harvesting) so the option list only lives in one place.
const WEATHER_CONDITION_FIELD = {
  key: "weather_condition",
  label: "Weather condition",
  type: "select",
  options: ["Sunny", "Cloudy", "Overcast", "Rainy", "Windy", "Other"]
};

// Cost fields (estimated/actual cost, currency, per-activity "cost"/"cost of
// X" properties) were removed from this form entirely — costs are now
// admin-only, logged against an activity later from the dashboard into
// vsl_activity_costs (see that table's migration). Team size/number of
// machines/progress/area covered/comments are the only fields shown for every
// activity regardless of which one is picked.
//
// Progress is an enum (0%, 20%, 50%, 75%, 100%), not free numeric input.
// When it's anything other than 100%, an extra "Area covered" field appears
// (see showWhen below) so a partially-done activity can record how much of
// the plot's area was actually covered so far; that value is capped
// client-side at the plot's own expected area + 5 (see
// renderLogActivityFields / saveLogActivityForm) and is written to its own
// vsl_activities.area_covered_acres column (promoted out of
// activity_properties so it can actually be queried/reported on).
let PROGRESS_OPTIONS = ["0", "20", "50", "75", "100"];
let PROGRESS_OPTION_LABELS = PROGRESS_OPTIONS.map((v) => `${v}%`);

let LOG_ACTIVITY_COMMON_FIELDS = [
  { key: "team_size", label: "Team size", type: "number" },
  { key: "number_of_machines", label: "Number of machines", type: "number" },
  { key: "completion_value", label: "Progress (%)", type: "select", options: PROGRESS_OPTIONS, optionLabels: PROGRESS_OPTION_LABELS },
  // Always visible now (used to hide at 100% via showWhen) — at 100% it's
  // auto-filled with the selected plot/block's own area and locked instead;
  // see applyAreaCoveredLock() in renderLogActivityFields.
  { key: "area_covered_acres", label: "Area covered (ac)", type: "number" },
  // One free-text box only. There used to be a second ("Challenges"); it was
  // dropped from the form AND from vsl_activities, since in practice whatever
  // went wrong was written into Comments anyway.
  { key: "comments", label: "Comments", type: "textarea" }
];

let ACTIVITY_PROPERTY_DEFS = {
  "Bush Clearing": [
    { key: "vegetation_density", label: "Vegetation density", type: "select", options: ["Light", "Medium", "Heavy"] },
    { key: "clearing_depth", label: "Clearing depth", type: "select", options: ["Surface clearing only", "Includes stump & root removal"] },
    { key: "disposal_method", label: "Disposal method", type: "select", options: ["Burning", "Piling", "Mulching in place", "Hauled away"] },
    { key: "land_type", label: "Land type", type: "select", options: ["New land", "Fallow reclamation"] },
    { key: "machine_type", label: "Machine type", type: "select", options: ["Bulldozer", "Brush cutter", "Tractor + slasher", "Excavator", "Other"] },
    { key: "fuel_used_litres", label: "Fuel used (litres)", type: "number" },
    { key: "hours_worked", label: "Hours worked", type: "number" }
  ],
  "Ploughing": [
    { key: "plough_type", label: "Plough type", type: "select", options: ["First", "Second", "Third"] },
    { key: "implement_used", label: "Implement used", type: "select", options: ["Disc plough", "Moldboard plough", "Chisel plough"] },
    { key: "plough_depth_cm", label: "Plough depth (cm)", type: "number" },
    { key: "soil_moisture_condition", label: "Soil moisture condition", type: "select", options: ["Dry", "Moist", "Wet"] },
    { key: "fuel_used_litres", label: "Fuel used (litres)", type: "number" },
    { key: "hours_worked", label: "Hours worked", type: "number" },
    { key: "operator_name", label: "Operator name", type: "text" }
  ],
  "Harrow": [
    { key: "type", label: "Type", type: "select", options: ["Disc harrow", "Spike-tooth harrow", "Tine harrow", "Rotary harrow"] },
    { key: "harrow_depth_cm", label: "Harrow depth (cm)", type: "number" },
    { key: "soil_moisture_condition", label: "Soil moisture condition", type: "select", options: ["Dry", "Moist", "Wet"] },
    { key: "fuel_used_litres", label: "Fuel used (litres)", type: "number" },
    { key: "hours_worked", label: "Hours worked", type: "number" },
    { key: "operator_name", label: "Operator name", type: "text" }
  ],
  "Ripping": [
    { key: "ripping_depth_cm", label: "Ripping depth (cm)", type: "number" },
    { key: "rip_line_spacing_m", label: "Rip line spacing (m)", type: "number" },
    { key: "fuel_used_litres", label: "Fuel used (litres)", type: "number" },
    { key: "hours_worked", label: "Hours worked", type: "number" },
    { key: "operator_name", label: "Operator name", type: "text" }
  ],
  "Ridging": [
    { key: "spacing_m", label: "Spacing (m)", type: "number" },
    { key: "ridge_height_cm", label: "Ridge height (cm)", type: "number" },
    { key: "ridge_width_cm", label: "Ridge width (cm)", type: "number" },
    { key: "fuel_used_litres", label: "Fuel used (litres)", type: "number" },
    { key: "hours_worked", label: "Hours worked", type: "number" },
    { key: "operator_name", label: "Operator name", type: "text" }
  ],
  "Furrowing": [
    { key: "furrow_depth_cm", label: "Furrow depth (cm)", type: "number" },
    { key: "furrow_spacing_m", label: "Furrow spacing (m)", type: "number" },
    { key: "implement_used", label: "Implement used", type: "text" },
    { key: "fuel_used_litres", label: "Fuel used (litres)", type: "number" },
    { key: "hours_worked", label: "Hours worked", type: "number" },
    { key: "operator_name", label: "Operator name", type: "text" }
  ],
  "Lime Application": [
    { key: "lime_quantity_kg", label: "Lime quantity (kg)", type: "number" },
    { key: "lime_type", label: "Lime type/name", type: "text" },
    { key: "soil_ph_before", label: "Soil pH before application", type: "number" },
    { key: "target_soil_ph", label: "Target soil pH", type: "number" },
    { key: "incorporation_method", label: "Incorporation method", type: "select", options: ["Ploughed in", "Harrowed in", "Left on surface"] }
  ],
  // Ratoon number and expected germination date aren't user-entered here —
  // saving a Planting activity always resets the plot's ratoon number to 0
  // and computes an expected germination date automatically (see
  // saveLogActivityForm's Planting write-back).
  "Planting": [
    { key: "cane_variety", label: "Cane variety", type: "text" },
    { key: "row_spacing_m", label: "Row/sett spacing (m)", type: "number" },
    { key: "planting_depth_cm", label: "Planting depth (cm)", type: "number" },
    WEATHER_CONDITION_FIELD
  ],
  "Manuring": [
    { key: "manure_type", label: "Manure type", type: "select", options: ["Farmyard manure", "Compost", "Poultry manure", "Green manure"] },
    { key: "quantity", label: "Quantity", type: "text" }
  ],
  "Fertilization": [
    { key: "fertilizer_name", label: "Fertilizer name", type: "text" },
    { key: "quantity", label: "Quantity", type: "text" },
    { key: "application_type", label: "Application type", type: "select", options: ["Basal", "Top dressing", "Foliar"] },
    { key: "npk_ratio", label: "NPK ratio", type: "text" },
    { key: "weather_condition", label: "Weather condition", type: "text" }
  ],
  "Weeding": [
    { key: "weeding_round", label: "Weeding round", type: "select", options: ["1st", "2nd", "3rd+"] },
    { key: "weed_pressure", label: "Weed pressure", type: "select", options: ["Light", "Medium", "Heavy"] },
    { key: "tools_used", label: "Tools used", type: "select", options: ["Hoe", "Machete", "Cultivator", "Other"] }
  ],
  "Spraying": [
    { key: "medicine_name", label: "Medicine name (chemical/product)", type: "text" },
    { key: "quantity", label: "Quantity", type: "text" },
    { key: "chemical_type", label: "Chemical type", type: "select", options: ["Herbicide", "Pesticide", "Fungicide"] },
    { key: "water_volume_litres", label: "Water volume used (litres)", type: "number" },
    { key: "application_equipment", label: "Application equipment", type: "select", options: ["Knapsack sprayer", "Boom sprayer", "Drone", "Tractor-mounted"] },
    WEATHER_CONDITION_FIELD
  ],
  "Irrigation": [
    { key: "litres_pumped", label: "Litres pumped", type: "number" },
    { key: "water_source", label: "Water source", type: "text" },
    { key: "duration_hours", label: "Duration (hours)", type: "number" },
    { key: "fuel_used", label: "Fuel used", type: "text" },
    { key: "operator_name", label: "Operator name", type: "text" }
  ],
  // Ratoon number isn't user-entered — the system already knows the plot's
  // current ratoon number, so saveLogActivityForm reads it and writes it
  // into activity_properties.ratoon_number automatically before the insert
  // (see the Harvesting block there). It also counts up and
  // cultivation_status flips to "replant renovation" automatically on save
  // (see applyHarvestingWriteBack), and a matching row is added to the
  // plot's harvest history. Only "Yield (tonnes)" is collected for weight —
  // separate gross/net weight fields were removed as redundant.
  "Harvesting": [
    { key: "yield_tonnes", label: "Yield (tonnes)", type: "number" },
    { key: "brix_reading", label: "Brix reading", type: "number" },
    { key: "transport_vehicle", label: "Transport vehicle(s)", type: "text" },
    { key: "mill_destination", label: "Mill destination", type: "text" },
    WEATHER_CONDITION_FIELD
  ],
  "Loading": [
    { key: "loading_equipment", label: "Loading equipment", type: "select", options: ["Grab loader", "Crane", "Manual"] },
    { key: "number_of_trucks", label: "Number of trucks/trailers loaded", type: "number" },
    { key: "truck_registration_number", label: "Truck registration number", type: "text" },
    { key: "destination_mill", label: "Destination (mill name)", type: "text" }
  ],
  "Trash Lining": [
    { key: "purpose", label: "Purpose", type: "select", options: ["Moisture retention", "Weed suppression", "Nutrient recycling"] }
  ],
  "Trash Collection": [
    { key: "disposal_method", label: "Disposal method", type: "select", options: ["Burning", "Composting", "Baling", "Hauled away", "Mulching"] },
    { key: "purpose", label: "Purpose", type: "select", options: ["Land prep for next season", "Sale", "Biomass use"] },
    { key: "transport_vehicle", label: "Transport vehicle (if removed)", type: "text" }
  ]
};

/** Fetches the activity catalog (activity types, their extra properties, and
 *  the fields shared by every activity) from the database and overwrites
 *  ACTIVITY_NAMES / ACTIVITY_PROPERTY_DEFS / LOG_ACTIVITY_COMMON_FIELDS in
 *  place. This is what makes the Log Activity form (and, via
 *  buildRecordDetailRows, the record detail drill-down) data-driven instead
 *  of hardcoded — the dashboard's Activities page reads the exact same
 *  tables, so the two apps can no longer drift apart. Called once from
 *  start(), before the user can interact with the map; on any failure the
 *  hardcoded fallback values defined above are left in place so the form
 *  keeps working. */
async function loadActivityCatalogFromDb() {
  try {
    const [typesRes, propsRes, commonRes] = await Promise.all([
      supabase.from("vsl_activity_types").select("*").eq("is_active", true).order("sort_order"),
      supabase.from("vsl_activity_type_properties").select("*").order("sort_order"),
      supabase.from("vsl_activity_common_fields").select("*").order("sort_order"),
    ]);
    if (typesRes.error) throw typesRes.error;
    if (propsRes.error) throw propsRes.error;
    if (commonRes.error) throw commonRes.error;

    const types = typesRes.data || [];
    if (!types.length) return; // empty catalog — keep the built-in fallback rather than showing nothing

    const nameById = new Map(types.map((t) => [t.id, t.name]));
    const defs = {};
    types.forEach((t) => { defs[t.name] = []; });
    (propsRes.data || []).forEach((p) => {
      const activityName = nameById.get(p.activity_type_id);
      if (!activityName) return;
      defs[activityName].push({
        key: p.key,
        label: p.label,
        type: p.data_type,
        options: p.options || undefined,
        optionLabels: p.option_labels || undefined,
        showWhen: p.show_when || undefined,
      });
    });

    const common = (commonRes.data || []).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.data_type,
      options: f.options || undefined,
      optionLabels: f.option_labels || undefined,
      showWhen: f.show_when || undefined,
    }));

    ACTIVITY_NAMES = types.map((t) => t.name);
    ACTIVITY_PROPERTY_DEFS = defs;
    if (common.length) LOG_ACTIVITY_COMMON_FIELDS = common;
  } catch (err) {
    console.error("[Victoria] Failed to load activity catalog from the database — falling back to the built-in list:", err);
  }
}

/** The markup-neutral half of a field def ({key, label, type:
 *  text|number|date|select|textarea, options?, optionLabels?, default?, min?,
 *  max?, allowNegative?, showWhen?: {key, notEquals}}): builds the control
 *  itself plus the wrapper attributes, leaving it to the caller to wrap them
 *  in a table row (buildPropFieldRow) or a grid cell (buildPropFieldCell).
 *
 *  Every number field gets min="0" unless def.allowNegative is true — none
 *  of the activity properties (depths, quantities, counts, hours, weights,
 *  pH, etc.) are ever legitimately negative, so this is the default rather
 *  than something each def has to opt into.
 *
 *  showWhen lets the wrapper hide itself until another field (in the same
 *  container) has a value other than notEquals — used for the "Area
 *  covered" field, which only makes sense while Progress isn't 100%. See
 *  wireConditionalFieldVisibility, which actually applies this at render time. */
function buildPropFieldParts(def) {
  const fieldId = `propField_${def.key}_${Math.random().toString(36).slice(2, 8)}`;
  let control;
  const isNumber = def.type === "number";
  const minAttr = isNumber && !def.allowNegative ? ` min="${def.min ?? 0}"` : "";
  const maxAttr = isNumber && def.max != null ? ` max="${def.max}"` : "";
  if (def.type === "select") {
    const opts = (def.options || []).map((val, i) => {
      const optLabel = def.optionLabels ? def.optionLabels[i] : val;
      const selected = def.default === val ? " selected" : "";
      return `<option value="${escapeHtml(val)}"${selected}>${escapeHtml(optLabel)}</option>`;
    }).join("");
    control = `<select id="${fieldId}" class="vsl-prop-input" data-key="${escapeHtml(def.key)}"><option value="">—</option>${opts}</select>`;
  } else if (def.type === "textarea") {
    control = `<textarea id="${fieldId}" class="vsl-prop-input" data-key="${escapeHtml(def.key)}" rows="2">${escapeHtml(def.default || "")}</textarea>`;
  } else {
    control = `<input id="${fieldId}" class="vsl-prop-input" data-key="${escapeHtml(def.key)}" type="${def.type}" value="${escapeHtml(def.default || "")}"${minAttr}${maxAttr}>`;
  }
  const wrapAttrs = def.showWhen
    ? ` data-show-when-key="${escapeHtml(def.showWhen.key)}" data-show-when-not-equals="${escapeHtml(def.showWhen.notEquals)}"`
    : "";
  const label = `<label for="${fieldId}">${escapeHtml(def.label)}</label>`;
  return { fieldId, control, wrapAttrs, label };
}

/** Renders one <tr><th>label</th><td><input/></td></tr> row for a field def —
 *  label LEFT, control RIGHT, one field per row. Used by the Log Alert modal
 *  and by Log Activity's per-activity "Other Details" table. */
function buildPropFieldRow(def) {
  const { control, wrapAttrs, label } = buildPropFieldParts(def);
  return `<tr${wrapAttrs}><th>${label}</th><td>${control}</td></tr>`;
}

/** Same field defs, laid out as a GRID CELL instead of a table row: label
 *  above its control, two cells to a row (see .vsl-field-grid in
 *  css/styles.css). Used for the Log Activity modal's common fields, whose
 *  values are all short enough to sit side by side — Team size, Machines,
 *  Progress, Area covered.
 *
 *  textarea defs (Comments) get --full so they span the whole width; a
 *  two-line box squeezed into half a 460px modal is unusable.
 *
 *  The control keeps its own wrapper div because the Area covered warning is
 *  injected into input.parentElement and positioned absolutely against it
 *  (renderLogActivityFields) — exactly the role the <td> played in the table
 *  layout. The showWhen/data-key/id contracts are identical to
 *  buildPropFieldRow's, so wireConditionalFieldVisibility and the save path
 *  work on either markup unchanged. */
function buildPropFieldCell(def) {
  const { control, wrapAttrs, label } = buildPropFieldParts(def);
  const fullClass = def.type === "textarea" ? " vsl-field-grid__item--full" : "";
  return `<div class="vsl-field-grid__item${fullClass}"${wrapAttrs}>` +
    `<div class="vsl-field-grid__label">${label}</div>` +
    `<div class="vsl-field-grid__control">${control}</div></div>`;
}

/** Wires up any showWhen-driven rows inside a rendered field table: hides a
 *  row while its controlling field's value equals notEquals... no wait —
 *  shows the row EXCEPT when the controlling field's value equals notEquals.
 *  (Named from the controlling field's perspective: "show when [key] is not
 *  equal to [notEquals]".) Safe to call on any container; no-ops if there
 *  are no conditional rows in it. */
function wireConditionalFieldVisibility(container) {
  if (!container) return;
  // Not "tr[...]": the Log Activity common fields are grid cells (divs), not
  // table rows — see buildPropFieldCell. Both carry the same data attributes
  // and both respond to .hidden, so the selector stays element-agnostic.
  const rows = Array.from(container.querySelectorAll("[data-show-when-key]"));
  if (!rows.length) return;
  const apply = () => {
    rows.forEach((row) => {
      const key = row.dataset.showWhenKey;
      const notEquals = row.dataset.showWhenNotEquals;
      const controller = container.querySelector(`[data-key="${key}"]`);
      const val = controller ? controller.value : "";
      row.hidden = val === notEquals;
    });
  };
  const seen = new Set();
  rows.forEach((row) => {
    const key = row.dataset.showWhenKey;
    if (seen.has(key)) return;
    seen.add(key);
    const controller = container.querySelector(`[data-key="${key}"]`);
    controller?.addEventListener("change", apply);
  });
  apply();
}

// ---------------------------------------------------------------------------
// Feature info panel — read-only, grouped/collapsible view (see docs/
// plot-details.md, block-details.md, activities.md for the field groupings).
// Opened only via the map selection toolbar's info button (openFeatureInfoPanel).
// ---------------------------------------------------------------------------

/** Escaped placeholder-aware value formatter — shows "—" for null/blank so
 *  fields never just silently disappear (0 still prints as "0"). */
function fmt(val, opts = {}) {
  if (val == null || val === "") return opts.fallback ?? "—";
  return escapeHtml(val);
}

/** Same placeholder-aware fallback as fmt(), but WITHOUT HTML-escaping —
 *  for building the plain-text export sections (see
 *  buildParcelExportSections/buildBlockExportSections) that feed
 *  js/feature-export.js's CSV/PDF output. Using fmt() there would leave
 *  literal "&amp;" etc. in the downloaded file instead of the real
 *  character, since escaping is only needed when a value ends up inside
 *  live HTML. */
function fmtPlain(val, opts = {}) {
  if (val == null || val === "") return opts.fallback ?? "—";
  return String(val);
}

function buildCollapsibleGroup(title, innerHtml, { open = false } = {}) {
  return `
    <details class="info-group"${open ? " open" : ""}>
      <summary class="info-group__summary">
        <span class="info-group__chevron" aria-hidden="true"></span>
        <span class="info-group__title">${escapeHtml(title)}</span>
      </summary>
      <div class="info-group__body">${innerHtml}</div>
    </details>`;
}

/** rows: [[label, valueHtml], ...] — valueHtml is trusted (pass through fmt()/escapeHtml() first). */
function buildKvTable(rows) {
  const trs = rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${value}</td></tr>`).join("");
  return `<table class="map-popup__table"><tbody>${trs}</tbody></table>`;
}

/** rows: [[cellHtml, ...], ...] — cells are trusted (pass through fmt()/escapeHtml() first).
 *  colWidths: optional array of percentages (one per header) — e.g. [40, 30, 30] for
 *  3-column tables, whose default auto layout otherwise tends to squeeze the last
 *  column (often a date) down to ~20%. 2-column tables look fine with the default
 *  ~40/60 from .map-popup__table's CSS and don't need this. */
function buildListTable(headers, rows, emptyMsg = "No records yet.", colWidths = null) {
  if (!rows.length) return `<p class="map-popup__empty">${escapeHtml(emptyMsg)}</p>`;
  const thead = `<tr>${headers.map((h, i) => {
    const widthAttr = colWidths && colWidths[i] != null ? ` style="width:${colWidths[i]}%"` : "";
    return `<th${widthAttr}>${escapeHtml(h)}</th>`;
  }).join("")}</tr>`;
  const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table class="map-popup__table"><thead>${thead}</thead><tbody>${trs}</tbody></table>`;
}

const THREE_COL_WIDTHS = [40, 30, 30];
// Estate's Blocks table and Block's Plots table are both 4 evenly-important
// columns (no single column that should dominate like a name/title column
// elsewhere), so split evenly rather than leaving column widths to the
// browser's default auto-sizing.
const FOUR_COL_EQUAL_WIDTHS = [25, 25, 25, 25];

/** Builds the Name/Status/Severity alerts table — shared by the parcel info
 *  panel's "Alerts" group and the standalone Alerts List modal (opened by
 *  clicking a plot's Alerts(n) chip on the map) so the two always look and
 *  behave identically. Name links to the alert record-detail drill-down;
 *  Severity is filled with its color only while the alert is unresolved
 *  (open/investigating) so an urgent one stands out at a glance. */
/** `withActions`: only the standalone Alerts List modal passes this — adds a
 *  4th "Actions" column with a Resolve button on unresolved rows, gated to
 *  ADMIN/SURVEYOR (same as the "flags resolve admin_surveyor" RLS policy).
 *  The embedded info-panel Alerts group keeps the original 3-column,
 *  read-only table. */
function buildAlertsListTableHtml(alerts, emptyMsg = "No alerts yet.", withActions = false) {
  const canResolve = withActions && (currentProfile?.role === "ADMIN" || currentProfile?.role === "SURVEYOR");
  const headers = withActions ? ["Name", "Status", "Severity", "Actions"] : ["Name", "Status", "Severity"];
  const widths = withActions ? [32, 22, 22, 24] : THREE_COL_WIDTHS;
  return buildListTable(
    headers,
    alerts.map((a, i) => {
      const unresolved = a.status === "open" || a.status === "investigating";
      const sevLabel = fmt(SEVERITY_LABELS[a.severity] || a.severity);
      const sevColor = ALERT_SEVERITY_COLORS[a.severity] || ALERT_SEVERITY_COLORS.information;
      const sevCell = unresolved
        ? `<span class="vsl-severity-chip" style="background:${sevColor}">${sevLabel}</span>`
        : sevLabel;
      const row = [
        buildRecordLink("alert", i, fmt(a.alert_name)),
        fmt(a.status),
        sevCell
      ];
      if (withActions) {
        row.push(
          unresolved && canResolve
            ? `<button type="button" class="vsl-resolve-alert-btn" data-resolve-index="${i}" title="Resolve this alert">✓ Resolve</button>`
            : (unresolved ? "—" : "Resolved")
        );
      }
      return row;
    }),
    emptyMsg,
    widths
  );
}

const HISTORY_AUDIT_PLACEHOLDER = `<p class="map-popup__empty">Change history isn't tracked yet for this record.</p>`;

// ---------------------------------------------------------------------------
// Record detail drill-down (windows/record-detail-modal.html) — clicking the
// first-column cell of a repeating group (Alerts, Activity History, Harvest
// History, Media, Comments) in the parcel info panel opens this modal with
// every field of that one record. infoPanelRecords holds the raw rows the
// currently-open info panel was built from, keyed the same way as
// RECORD_LIST_KEY below; buildParcelInfoHtml populates it, and the delegated
// click listener set up in setupRecordDetailModal() reads back into it using
// each link's data-record-kind/data-record-index attributes.
// ---------------------------------------------------------------------------
let infoPanelRecords = {};

const RECORD_LIST_KEY = { alert: "alerts", activity: "activities", harvest: "harvests", media: "media", comment: "comments" };
const RECORD_DETAIL_TITLES = { alert: "Alert details", activity: "Activity details", harvest: "Harvest details", media: "Media details", comment: "Comment details" };
const RECORD_DETAIL_ICONS = { alert: "fa-bullhorn", activity: "fa-person-digging", harvest: "fa-wheat-awn", media: "fa-image", comment: "fa-comment" };
const RECORD_TABLE_BY_KIND = { alert: "vsl_alerts", activity: "vsl_activities", harvest: "vsl_harvests", media: "vsl_media", comment: "vsl_comments" };

// The real "who did this" column(s) per record kind (created_by isn't even
// the actual column name on every table — vsl_media uses captured_by,
// vsl_comments uses user_id). Used by buildParcelInfoHtml to resolve these
// raw user ids into readable names for the drill-down view (see
// buildRecordDetailRows) without overwriting the id itself, which
// canEditRecordDetail still needs for the "is this the person who logged
// it" permission check.
const RECORD_WHO_COLUMNS = {
  activity: ["created_by"],
  alert: ["created_by", "resolved_by"],
  harvest: ["created_by"],
  media: ["captured_by"],
  comment: ["user_id", "resolved_by"]
};

/** Wraps a table cell's text in a link that opens the drill-down detail
 *  modal for that specific record — used for the first column of every
 *  repeating group in the parcel info panel. `label` is trusted (already
 *  run through fmt()/escapeHtml()). */
function buildRecordLink(kind, index, label) {
  return `<a href="#" class="vsl-record-link" data-record-kind="${escapeHtml(kind)}" data-record-index="${index}">${label}</a>`;
}

/** snake_case_key -> "Snake case key" — fallback label for any DB column
 *  that isn't explicitly named below, so the drill-down view never just
 *  silently drops an unfamiliar field. */
function humanizeKey(key) {
  const s = String(key).replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Raw ids/FKs that are internal plumbing, not something worth showing the
// user spelled out in the drill-down view.
const RECORD_DETAIL_SKIP_KEYS = new Set(["id", "parcel_id", "block_id", "target_id", "layer_type", "entity_type", "entity_id", "activity_properties"]);

const RECORD_DETAIL_LABELS = {
  alert: { alert_name: "Alert name", note: "Description", status: "Status", severity: "Severity", created_at: "Logged", resolved_at: "Resolved at", created_by: "Logged by", resolved_by: "Resolved by" },
  activity: { activity_name: "Activity", activity_date: "Date", team_size: "Team size", number_of_machines: "Number of machines", completion_value: "Progress (%)", area_covered_acres: "Area covered (ac)", comments: "Comments", created_at: "Logged at", created_by: "Logged by" },
  harvest: { harvest_date: "Harvest date", gross_weight_tonnes: "Yield (tonnes)", ratoon_at_harvest: "Ratoon", created_at: "Logged at", created_by: "Logged by" },
  // media/comment's real "who" columns are captured_by/user_id, not
  // created_by — see RECORD_WHO_COLUMNS above.
  media: { media_type: "Type", caption: "Caption", captured_at: "Captured", file_url: "File", created_at: "Uploaded at", captured_by: "Uploaded by" },
  comment: { comment_type: "Type", comment_text: "Comment", is_resolved: "Resolved", created_at: "Date", user_id: "Author", resolved_by: "Resolved by" }
};

/** Builds the [[label, valueHtml], ...] rows for the drill-down detail
 *  view: every real column becomes a row (skipping internal FK/id
 *  plumbing), plus — for activities specifically — every key inside
 *  activity_properties flattened out using the same field labels the Log
 *  Activity form itself uses (ACTIVITY_PROPERTY_DEFS), so the full set of
 *  whatever was actually logged is visible, not just the shared columns. */
function buildRecordDetailRows(kind, record) {
  const labels = RECORD_DETAIL_LABELS[kind] || {};
  const whoCols = RECORD_WHO_COLUMNS[kind] || [];
  const rows = [];

  for (const [key, value] of Object.entries(record)) {
    // "_"-prefixed keys are bookkeeping we attached ourselves (e.g.
    // _whoNames, see buildParcelInfoHtml) — never a real DB column.
    if (RECORD_DETAIL_SKIP_KEYS.has(key) || key.startsWith("_")) continue;
    const label = labels[key] || humanizeKey(key);

    let display;
    // Show the resolved name (fetched in buildParcelInfoHtml) instead of
    // the raw user id — falls back to the id itself if no matching
    // profile was found (e.g. a deleted account).
    if (whoCols.includes(key)) display = record._whoNames?.[key] ? escapeHtml(record._whoNames[key]) : fmt(value);
    else if (kind === "alert" && key === "severity") display = fmt(SEVERITY_LABELS[value] || value);
    else if (key === "is_resolved") display = value ? "Resolved" : "Open";
    else if (key === "file_url" && value) display = `<a href="${escapeHtml(value)}" target="_blank" rel="noopener">Open</a>`;
    else if (key === "completion_value" && value != null) display = `${escapeHtml(value)}%`;
    else if (value != null && /(_at|_date)$/.test(key)) display = fmt(String(value).length > 10 ? String(value).slice(0, 16).replace("T", " ") : value);
    else display = fmt(value);

    rows.push([label, display]);
  }

  if (kind === "activity" && record.activity_properties && typeof record.activity_properties === "object") {
    const defs = ACTIVITY_PROPERTY_DEFS[record.activity_name] || [];
    const labelByKey = {};
    defs.forEach((d) => { labelByKey[d.key] = d.label; });
    // Not in ACTIVITY_PROPERTY_DEFS — ratoon_number/expected_germination_date
    // are auto-filled by the write-back logic (never shown as inputs) but
    // still deserve a readable label when they show up in the drill-down.
    labelByKey.ratoon_number = labelByKey.ratoon_number || "Ratoon number";
    labelByKey.expected_germination_date = labelByKey.expected_germination_date || "Expected germination date";

    for (const [key, value] of Object.entries(record.activity_properties)) {
      if (value === "" || value == null) continue;
      rows.push([labelByKey[key] || humanizeKey(key), fmt(value)]);
    }
  }

  return rows;
}

// Record detail — edit mode (Activity only for now). Tracks which
// kind/record the modal is currently showing, and whether it's currently
// in edit mode, so the Edit/Cancel button handlers (wired once in
// setupRecordDetailModal) know what to act on without re-querying the DOM
// for it. Only two buttons ever show at once: Edit doubles as Save (same
// button, its label/action just change) once clicked, with Cancel
// appearing alongside it only while editing.
const recordDetailState = { kind: null, record: null, editing: false };

/** Edit is only offered for Activity records right now (that's what was
 *  asked for), and only to an ADMIN or the person who originally logged
 *  that activity — same rule as the rest of the app's admin-gated actions
 *  (see resolveAlert's canResolve). */
function canEditRecordDetail(kind, record) {
  if (kind !== "activity" || !record) return false;
  if (!isAuthenticated || !currentUser?.id || currentUser.id === "guest") return false;
  if (currentProfile?.role === "ADMIN") return true;
  return currentUser.id === record.created_by;
}

function renderRecordDetailReadOnly(kind, record) {
  const inner = document.getElementById("recordDetailInner");
  if (inner) inner.innerHTML = buildKvTable(buildRecordDetailRows(kind, record));
}

/** Builds the editable form for an Activity record — same field defs (and
 *  same buildPropFieldRow markup/classes) as the Log Activity form itself,
 *  just prefilled with this record's current values instead of blank. */
function renderRecordDetailEditForm(record) {
  const inner = document.getElementById("recordDetailInner");
  if (!inner) return;

  const commonDefs = LOG_ACTIVITY_COMMON_FIELDS.map((d) => ({
    ...d,
    default: record[d.key] != null ? String(record[d.key]) : (d.default || "")
  }));
  const propDefs = (ACTIVITY_PROPERTY_DEFS[record.activity_name] || []).map((d) => ({
    ...d,
    default: record.activity_properties?.[d.key] != null ? String(record.activity_properties[d.key]) : (d.default || "")
  }));

  inner.innerHTML = `
    <table class="map-popup__table vsl-prop-table" id="recordDetailEditCommon">
      <tbody>${commonDefs.map(buildPropFieldRow).join("")}</tbody>
    </table>
    ${propDefs.length ? `
    <table class="map-popup__table vsl-prop-table" id="recordDetailEditProps">
      <tbody>${propDefs.map(buildPropFieldRow).join("")}</tbody>
    </table>` : ""}
  `;
  wireConditionalFieldVisibility(document.getElementById("recordDetailEditCommon"));
  const propsEl = document.getElementById("recordDetailEditProps");
  if (propsEl) wireConditionalFieldVisibility(propsEl);
}

function setRecordDetailEditMode(isEditing) {
  const editBtn = document.getElementById("recordDetailEditBtn");
  const cancelBtn = document.getElementById("recordDetailCancelBtn");
  const errorEl = document.getElementById("recordDetailError");
  if (errorEl) { errorEl.hidden = true; errorEl.textContent = ""; }

  recordDetailState.editing = isEditing;
  if (editBtn) editBtn.textContent = isEditing ? "Save changes" : "Edit";
  if (cancelBtn) cancelBtn.hidden = !isEditing;

  const { kind, record } = recordDetailState;
  if (isEditing && kind === "activity" && record) renderRecordDetailEditForm(record);
  else if (kind && record) renderRecordDetailReadOnly(kind, record);
}

async function saveRecordDetailEdit() {
  const { kind, record } = recordDetailState;
  const errorEl = document.getElementById("recordDetailError");
  const editBtn = document.getElementById("recordDetailEditBtn");
  if (kind !== "activity" || !record) return;

  if (errorEl) { errorEl.hidden = true; errorEl.textContent = ""; }
  if (editBtn) editBtn.disabled = true;

  try {
    const common = {};
    document.querySelectorAll("#recordDetailEditCommon [data-key]").forEach((el) => {
      common[el.dataset.key] = (el.value ?? "").trim();
    });
    const properties = {};
    document.querySelectorAll("#recordDetailEditProps [data-key]").forEach((el) => {
      const v = (el.value ?? "").trim();
      if (v !== "") properties[el.dataset.key] = v;
    });

    const payload = {
      team_size: numOrNull(common.team_size),
      number_of_machines: numOrNull(common.number_of_machines),
      completion_value: numOrNull(common.completion_value),
      area_covered_acres: common.area_covered_acres !== "" ? numOrNull(common.area_covered_acres) : null,
      comments: common.comments || null,
      activity_properties: properties
    };

    const { error } = await supabase.from(RECORD_TABLE_BY_KIND.activity).update(payload).eq("id", record.id);
    if (error) throw error;

    // Reflect the change immediately in this same object — it's the exact
    // instance sitting in infoPanelRecords[...].activities[i] too, so the
    // parcel info panel's Activity History table (and this modal, if
    // reopened) picks it up without a full reload.
    Object.assign(record, payload);

    setRecordDetailEditMode(false);

    // Also refresh the info panel behind this modal so its Activity
    // History row (progress/date column) reflects the edit right away.
    if (selectedFeature && selectedLayerType) openFeatureInfoPanel(selectedFeature, selectedLayerType);
  } catch (err) {
    if (errorEl) { errorEl.textContent = err?.message || "Failed to save changes."; errorEl.hidden = false; }
  } finally {
    if (editBtn) editBtn.disabled = false;
  }
}

function openRecordDetailModal(kind, record) {
  const overlay = document.getElementById("recordDetailOverlay");
  const inner = document.getElementById("recordDetailInner");
  const titleEl = document.getElementById("recordDetailTitle");
  const iconEl = document.getElementById("recordDetailIcon");
  const actionBtns = document.getElementById("recordDetailActionBtns");
  const editBtn = document.getElementById("recordDetailEditBtn");
  if (!overlay || !inner || !record) return;

  recordDetailState.kind = kind;
  recordDetailState.record = record;
  recordDetailState.editing = false;

  if (titleEl) titleEl.textContent = RECORD_DETAIL_TITLES[kind] || "Record details";
  if (iconEl) iconEl.innerHTML = `<i class="fas ${RECORD_DETAIL_ICONS[kind] || "fa-circle-info"}" aria-hidden="true"></i>`;

  const editable = canEditRecordDetail(kind, record);
  if (actionBtns) actionBtns.hidden = !editable;
  if (editBtn) { editBtn.textContent = "Edit"; editBtn.disabled = false; }
  const cancelBtn = document.getElementById("recordDetailCancelBtn");
  if (cancelBtn) cancelBtn.hidden = true;

  renderRecordDetailReadOnly(kind, record);
  overlay.hidden = false;
}

function closeRecordDetailModal() {
  const overlay = document.getElementById("recordDetailOverlay");
  if (overlay) overlay.hidden = true;
  recordDetailState.kind = null;
  recordDetailState.record = null;
}

/** Delegated click listener lives on #featureInfoPanelInner (the info
 *  panel's body, which is fully re-rendered via innerHTML on every open) so
 *  it keeps working across re-renders without needing to be re-wired. */
/** Delegated click wiring for a container full of buildRecordLink() anchors —
 *  shared by the info panel's #featureInfoPanelInner (backed by
 *  infoPanelRecords, five record kinds) and the standalone Alerts List
 *  modal's #alertsListInner (backed by alertsListRecords, alert kind only).
 *  `getRecordsForKind(kind)` returns the array to index into for a given
 *  link's data-record-kind. Safe to call on a container that's fully
 *  replaced via innerHTML on every open — it's one listener on the
 *  container itself, not on the individual links. */
function wireRecordLinkClicks(container, getRecordsForKind) {
  container?.addEventListener("click", (ev) => {
    const link = ev.target.closest("a[data-record-kind]");
    if (!link) return;
    ev.preventDefault();
    const kind = link.dataset.recordKind;
    const index = Number(link.dataset.recordIndex);
    const list = getRecordsForKind(kind) || [];
    const record = list[index];
    if (record) openRecordDetailModal(kind, record);
  });
}

function setupRecordDetailModal() {
  const overlay = document.getElementById("recordDetailOverlay");
  const closeBtn = document.getElementById("recordDetailCloseBtn");
  if (!overlay) return;

  closeBtn?.addEventListener("click", () => closeRecordDetailModal());
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !overlay.hidden) closeRecordDetailModal();
  });

  // Edit doubles as Save once clicked — see recordDetailState.editing.
  document.getElementById("recordDetailEditBtn")?.addEventListener("click", () => {
    if (recordDetailState.editing) saveRecordDetailEdit();
    else setRecordDetailEditMode(true);
  });
  document.getElementById("recordDetailCancelBtn")?.addEventListener("click", () => setRecordDetailEditMode(false));

  wireRecordLinkClicks(
    document.getElementById("featureInfoPanelInner"),
    (kind) => infoPanelRecords[RECORD_LIST_KEY[kind]]
  );
}

// ---------------------------------------------------------------------------
// "My Profile" popup (windows/profile-modal.html) — opened by clicking the
// account button in the top controls (was a plain Sign Out button). Shows the
// signed-in user's own vsl_profiles record with their photo, and lets them
// edit their own name/title/phone/photo (a direct client-side update — the
// "profiles self update" RLS policy already allows id = auth.uid()) or sign
// out from inside the popup.
// ---------------------------------------------------------------------------
function initialsFromName(name) {
  return (name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

/** Signed-in user's display name, for anything outside this module that
 *  needs to stamp it (the print tool's "Printed by" line). Same loosely-
 *  coupled window.* hook pattern used for vslBuildLegendList /
 *  vslClosePrintPanel. Returns null for guests. */
window.vslCurrentUserName = () => {
  if (!currentUser || currentUser.id === "guest") return null;
  return currentProfile?.full_name || currentProfile?.email || currentUser?.email || null;
};

function updateProfileButtonAvatar() {
  const slot = document.getElementById("profileAvatarSlot");
  if (!slot || !currentProfile || !currentUser || currentUser.id === "guest") return;
  const name = currentProfile.full_name || currentProfile.email || "Account";
  logoutBtn.title = name + " — My Profile";
  if (currentProfile.avatar_url) {
    slot.innerHTML = `<img src="${currentProfile.avatar_url}" alt="${escapeHtml(name)}" style="width:35px;height:35px;border-radius:50%;object-fit:cover;flex-shrink:0">`;
  } else {
    slot.innerHTML = `<span class="vsl-profile-avatar-fallback-sm">${escapeHtml(initialsFromName(name) || "?")}</span>`;
  }
}

// Uploads a picked File to the public "Media" Storage bucket under avatars/
// and returns its public URL — same convention the dashboard uses.
async function uploadOwnAvatarFile(file) {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `avatars/${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("Media").upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (error) throw new Error("Photo upload failed: " + error.message);
  return supabase.storage.from("Media").getPublicUrl(path).data.publicUrl;
}

// Positions the dropdown fixed under the account button, right-aligned to
// it (button sits in the top-right controls cluster, so the dropdown should
// open downward/leftward from there rather than off the edge of the screen).
function positionProfileDropdown(dropdown) {
  const rect = logoutBtn.getBoundingClientRect();
  dropdown.style.top = rect.bottom + 8 + "px";
  dropdown.style.right = (window.innerWidth - rect.right) + "px";
  dropdown.style.left = "auto";
}

function renderProfileDropdownIdentity() {
  const p = currentProfile || {};
  const name = p.full_name || p.email || "Unknown";
  document.getElementById("profileDropdownName").textContent = name;
  document.getElementById("profileDropdownEmail").textContent = p.email || "";
  const img = document.getElementById("profileDropdownAvatarImg");
  const fallback = document.getElementById("profileDropdownAvatarFallback");
  if (p.avatar_url) {
    img.src = p.avatar_url;
    img.style.display = "";
    fallback.style.display = "none";
  } else {
    img.style.display = "none";
    fallback.style.display = "flex";
    fallback.textContent = initialsFromName(name) || "?";
  }
}

function initProfileModal() {
  const dropdown = document.getElementById("profileDropdown");
  const overlay = document.getElementById("profileOverlay");
  if (!dropdown || !overlay) return;
  const closeBtn = document.getElementById("profileCloseBtn");
  const editForm = document.getElementById("profileEditForm");
  const dropdownEditBtn = document.getElementById("profileDropdownEditBtn");
  const dropdownLogoutBtn = document.getElementById("profileDropdownLogoutBtn");
  const cancelBtn = document.getElementById("profileEditCancelBtn");
  const errorEl = document.getElementById("profileEditError");

  function closeDropdown() {
    dropdown.hidden = true;
  }

  window.openProfileModal = function () {
    if (!currentUser || currentUser.id === "guest") return;
    // Clicking the account button again toggles the dropdown closed.
    if (!dropdown.hidden) {
      closeDropdown();
      return;
    }
    renderProfileDropdownIdentity();
    dropdown.hidden = false;
    positionProfileDropdown(dropdown);
  };

  // Click-outside / Escape closes the dropdown, same as any other popover.
  document.addEventListener("click", (ev) => {
    if (!dropdown.hidden && !dropdown.contains(ev.target) && ev.target !== logoutBtn && !logoutBtn.contains(ev.target)) {
      closeDropdown();
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (!dropdown.hidden) closeDropdown();
      if (!overlay.hidden) closeEditModal();
    }
  });
  window.addEventListener("resize", () => {
    if (!dropdown.hidden) positionProfileDropdown(dropdown);
  });

  function openEditModal() {
    closeDropdown();
    const p = currentProfile || {};
    document.getElementById("profileEditName").value = p.full_name || "";
    document.getElementById("profileEditTitle").value = p.title || "";
    document.getElementById("profileEditPhone").value = p.phone || "";
    // Email is the auth session's, not vsl_profiles' — that's the actual sign-in
    // identity; vsl_profiles.email is just a denormalized copy set at creation.
    document.getElementById("profileEditEmail").value = currentUser?.email || p.email || "";
    document.getElementById("profileEditPassword").value = "";
    document.getElementById("profileEditPasswordConfirm").value = "";
    const preview = document.getElementById("profileEditPreview");
    if (p.avatar_url) {
      preview.src = p.avatar_url;
      preview.style.display = "";
    } else {
      preview.style.display = "none";
    }
    const photoInput = document.getElementById("profileEditPhoto");
    if (photoInput) photoInput.value = "";
    errorEl.hidden = true;
    overlay.hidden = false;
  }
  function closeEditModal() {
    overlay.hidden = true;
  }

  dropdownEditBtn?.addEventListener("click", openEditModal);
  dropdownLogoutBtn?.addEventListener("click", async () => {
    // Before the redirect, so a shared machine doesn't hand the next person
    // a toolbar already laid out for this one's role — or, in the land
    // cache's case, a readable copy of the boundaries. Row-level security
    // protects the database, not a local copy of it.
    clearCachedProfiles();
    await clearLandCache();
    await supabase.auth.signOut();
    window.location.href = "./login.html";
  });

  closeBtn?.addEventListener("click", closeEditModal);
  cancelBtn?.addEventListener("click", closeEditModal);

  document.getElementById("profileEditPhoto")?.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const preview = document.getElementById("profileEditPreview");
      preview.src = reader.result;
      preview.style.display = "";
    };
    reader.readAsDataURL(file);
  });

  editForm?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    errorEl.hidden = true;
    const submitBtn = editForm.querySelector('button[type="submit"]');

    // vsl_profiles fields (name/title/phone/photo) vs. auth.users fields
    // (email/password) — two different tables, two different update calls.
    const full_name = document.getElementById("profileEditName").value.trim();
    const title = document.getElementById("profileEditTitle").value.trim();
    const phone = document.getElementById("profileEditPhone").value.trim();
    const photoFile = document.getElementById("profileEditPhoto").files[0] || null;
    const newEmail = document.getElementById("profileEditEmail").value.trim();
    const newPassword = document.getElementById("profileEditPassword").value;
    const confirmPassword = document.getElementById("profileEditPasswordConfirm").value;

    if (!newEmail || !/^[^@]+@[^@]+\.[^@]+$/.test(newEmail)) {
      errorEl.textContent = "Please enter a valid email.";
      errorEl.hidden = false;
      return;
    }
    if (newPassword || confirmPassword) {
      if (newPassword.length < 8) {
        errorEl.textContent = "New password must be at least 8 characters.";
        errorEl.hidden = false;
        return;
      }
      if (newPassword !== confirmPassword) {
        errorEl.textContent = "New password and confirmation don't match.";
        errorEl.hidden = false;
        return;
      }
    }

    if (submitBtn) submitBtn.disabled = true;
    try {
      // 1. public.vsl_profiles — direct self-update (RLS: id = auth.uid()).
      const patch = { full_name: full_name || null, title: title || null, phone: phone || null };
      if (photoFile) patch.avatar_url = await uploadOwnAvatarFile(photoFile);

      const { data, error } = await supabase
        .from("vsl_profiles")
        .update(patch)
        .eq("id", currentUser.id)
        .select()
        .single();
      if (error) throw error;
      currentProfile = { ...currentProfile, ...data };

      // 2. auth.users — email and/or password, via supabase-js's own auth API
      // (not a table update). Email changes are NOT applied immediately: Supabase
      // sends a confirmation link to the new address and the old email stays
      // active until it's clicked.
      const messages = ["Profile updated."];
      const emailChanged = newEmail && newEmail.toLowerCase() !== (currentUser.email || "").toLowerCase();
      if (emailChanged || newPassword) {
        const authPatch = {};
        if (emailChanged) authPatch.email = newEmail;
        if (newPassword) authPatch.password = newPassword;
        const { data: authData, error: authErr } = await supabase.auth.updateUser(authPatch);
        if (authErr) throw authErr;
        if (emailChanged) messages.push("Check your new email address for a confirmation link — the change won't take effect until you click it.");
        if (newPassword) messages.push("Password changed.");
        if (authData?.user) currentUser = authData.user;
      }

      updateProfileButtonAvatar();
      closeEditModal();
      setStatus(statusEl, messages.join(" "));
    } catch (err) {
      errorEl.textContent = err?.message || "Failed to save changes.";
      errorEl.hidden = false;
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Alerts List modal (windows/alerts-list-modal.html) — opened from the
// Alerts row of the plot popup (renderParcelActionInfo). It used to be
// reached by clicking an "Alerts(n)" text line drawn on the map itself;
// that line was removed from the plot label, so the popup is the way in now.
// Shows just that one plot's alerts (same Name/Status/Severity table as the
// info panel's Alerts group, via buildAlertsListTableHtml), with Name still
// linking into the same record-detail drill-down used everywhere else.
// ---------------------------------------------------------------------------
let alertsListRecords = [];
let alertsListCurrentParcel = null; // { id, label } — so resolving an alert can refresh this same list

/** Batched created_by/resolved_by -> profile full_name lookup for a list of
 *  alert rows, mirroring the same _whoNames attachment buildParcelInfoHtml
 *  does (see RECORD_WHO_COLUMNS/buildRecordDetailRows) — needed here too
 *  since the Alerts List modal loads its rows directly from vsl_alerts
 *  rather than going through buildParcelInfoHtml, so without this the
 *  record-detail drill-down opened from it ("Logged by"/"Resolved by")
 *  fell back to showing the raw user id instead of a name. */
async function attachAlertWhoNames(alerts) {
  const cols = RECORD_WHO_COLUMNS.alert;
  const whoIds = new Set();
  for (const r of alerts) for (const c of cols) if (r[c]) whoIds.add(r[c]);

  let nameById = new Map();
  if (whoIds.size) {
    const { data: whoProfiles } = await supabase.from("vsl_profiles").select("id, full_name").in("id", Array.from(whoIds));
    nameById = new Map((whoProfiles || []).map((p) => [p.id, p.full_name]));
  }
  for (const r of alerts) {
    r._whoNames = {};
    for (const c of cols) if (r[c]) r._whoNames[c] = nameById.get(r[c]) || null;
  }
}

async function openAlertsListModal(parcelId, parcelLabel) {
  const overlay = document.getElementById("alertsListOverlay");
  const inner = document.getElementById("alertsListInner");
  const titleEl = document.getElementById("alertsListTitle");
  if (!overlay || !inner || parcelId == null) return;

  alertsListCurrentParcel = { id: parcelId, label: parcelLabel };
  if (titleEl) titleEl.textContent = `Alerts${parcelLabel ? ` — ${parcelLabel}` : ""}`;
  inner.innerHTML = `<p class="map-popup__empty">Loading…</p>`;
  overlay.hidden = false;

  try {
    const { data, error } = await supabase
      .from("vsl_alerts")
      .select("*")
      .eq("layer_type", "PARCELS")
      .eq("target_id", String(parcelId))
      .order("created_at", { ascending: false });
    if (error) throw error;

    alertsListRecords = data || [];
    await attachAlertWhoNames(alertsListRecords);
    inner.innerHTML = buildAlertsListTableHtml(alertsListRecords, "No alerts yet.", true);
  } catch (err) {
    console.error("[Victoria] Failed to load alerts list:", err);
    alertsListRecords = [];
    inner.innerHTML = `<p class="map-popup__empty">Failed to load alerts: ${escapeHtml(err?.message || "unknown error")}</p>`;
  }
}

function closeAlertsListModal() {
  const overlay = document.getElementById("alertsListOverlay");
  const inner = document.getElementById("alertsListInner");
  if (inner) inner.innerHTML = "";
  if (overlay) overlay.hidden = true;
  alertsListRecords = [];
  alertsListCurrentParcel = null;
}

function setupAlertsListModal() {
  const overlay = document.getElementById("alertsListOverlay");
  const closeBtn = document.getElementById("alertsListCloseBtn");
  if (!overlay) return;

  closeBtn?.addEventListener("click", () => closeAlertsListModal());
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !overlay.hidden) closeAlertsListModal();
  });

  wireRecordLinkClicks(
    document.getElementById("alertsListInner"),
    () => alertsListRecords
  );

  document.getElementById("alertsListInner")?.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".vsl-resolve-alert-btn");
    if (!btn) return;
    const record = alertsListRecords[Number(btn.dataset.resolveIndex)];
    if (record) openResolveAlertModal(record);
  });
}

// ---------------------------------------------------------------------------
// Resolve Alert modal (windows/resolve-alert-modal.html) — opened via the
// "Resolve" button added to unresolved rows in the Alerts List modal above.
// ADMIN/SURVEYOR only. Captures a resolution note, then updates the alert's
// status to "resolved" (never deletes it) and refreshes the Alerts List
// modal it was opened from.
// ---------------------------------------------------------------------------
let resolveAlertTarget = null;

function openResolveAlertModal(alertRecord) {
  const overlay = document.getElementById("resolveAlertOverlay");
  const summaryEl = document.getElementById("resolveAlertSummary");
  const noteEl = document.getElementById("resolveAlertNote");
  const errorEl = document.getElementById("resolveAlertError");
  if (!overlay || !alertRecord) return;

  resolveAlertTarget = alertRecord;
  if (summaryEl) {
    const sevLabel = fmt(SEVERITY_LABELS[alertRecord.severity] || alertRecord.severity);
    summaryEl.innerHTML = `<strong>${escapeHtml(fmt(alertRecord.alert_name))}</strong> — ${escapeHtml(sevLabel)}<br>${escapeHtml(fmt(alertRecord.note))}`;
  }
  if (noteEl) noteEl.value = "";
  if (errorEl) { errorEl.hidden = true; errorEl.textContent = ""; }
  overlay.hidden = false;
}

function closeResolveAlertModal() {
  const overlay = document.getElementById("resolveAlertOverlay");
  if (overlay) overlay.hidden = true;
  resolveAlertTarget = null;
}

async function submitResolveAlertForm(event) {
  event.preventDefault();
  const errorEl = document.getElementById("resolveAlertError");
  const saveBtn = document.getElementById("resolveAlertSaveBtn");
  if (!resolveAlertTarget) return;

  if (!isAuthenticated || !currentUser?.id || currentUser.id === "guest") {
    if (errorEl) { errorEl.textContent = "Sign in to resolve alerts."; errorEl.hidden = false; }
    return;
  }
  if (currentProfile?.role !== "ADMIN" && currentProfile?.role !== "SURVEYOR") {
    if (errorEl) { errorEl.textContent = "Only Admin or Surveyor can resolve alerts."; errorEl.hidden = false; }
    return;
  }

  const note = document.getElementById("resolveAlertNote")?.value?.trim() || null;
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
  try {
    const { error } = await supabase
      .from("vsl_alerts")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        resolved_by: currentUser.id,
        resolution_note: note,
      })
      .eq("id", resolveAlertTarget.id);
    if (error) throw error;

    closeResolveAlertModal();
    if (alertsListCurrentParcel) {
      await openAlertsListModal(alertsListCurrentParcel.id, alertsListCurrentParcel.label);
    }
  } catch (err) {
    console.error("[Victoria] Failed to resolve alert:", err);
    if (errorEl) { errorEl.textContent = err?.message || "Failed to resolve alert."; errorEl.hidden = false; }
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "Mark Resolved"; }
  }
}

function setupResolveAlertModal() {
  const overlay = document.getElementById("resolveAlertOverlay");
  const closeBtn = document.getElementById("resolveAlertCloseBtn");
  const form = document.getElementById("resolveAlertForm");
  if (!overlay) return;

  closeBtn?.addEventListener("click", () => closeResolveAlertModal());
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !overlay.hidden) closeResolveAlertModal();
  });
  form?.addEventListener("submit", submitResolveAlertForm);
}

/** Given the selected feature/layer, resolves which vsl_parcels.id(s) an
 *  activity/alert should be logged against. A parcel selection is just
 *  itself; a block selection cascades to every parcel currently in that
 *  block (see the "applies to the whole block" warning in the log modals). */
async function resolveSelectionParcelIds(feature, layerType) {
  if (layerType === "PARCELS") {
    return { parcelIds: [feature.getId()], blockId: null, isBlockSelection: false };
  }
  const blockId = feature.getId();
  const { data, error } = await supabase.from("vsl_parcels").select("id").eq("block_id", blockId);
  if (error) throw error;
  return { parcelIds: (data || []).map((r) => r.id), blockId, isBlockSelection: true };
}

/** "" and non-numeric input become null (not 0/NaN) — used for every numeric
 *  field in the Log Activity form and its write-back helpers below. */
function numOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Land-linked write-back for Planting — a plant crop always starts at ratoon
 * 0, so that's reset on the plot regardless of what (if anything) used to be
 * there, and the plot flips to cultivation_status "planted". Cane variety
 * isn't a vsl_parcels column (only vsl_parcel_seasons has it), so once the
 * update below has let trg_vsl_sync_parcel_season create/refresh the current
 * season row, it's patched onto that row directly.
 */
async function applyPlantingWriteBack(parcelIds, properties) {
  const today = new Date().toISOString().slice(0, 10);
  const { error: updateErr } = await supabase
    .from("vsl_parcels")
    .update({
      ratoon_number: 0,
      planting_date: today,
      cultivation_status: "planted",
      cultivation_updated_at: new Date().toISOString()
    })
    .in("id", parcelIds);
  if (updateErr) throw updateErr;

  if (properties.cane_variety) {
    for (const parcelId of parcelIds) {
      const { data: seasonRows } = await supabase
        .from("vsl_parcel_seasons")
        .select("id")
        .eq("parcel_id", parcelId)
        .order("created_at", { ascending: false })
        .limit(1);
      const seasonId = seasonRows?.[0]?.id;
      if (seasonId) {
        await supabase.from("vsl_parcel_seasons").update({ cane_variety: properties.cane_variety }).eq("id", seasonId);
      }
    }
  }
}

/**
 * Land-linked write-back for Harvesting — registers the harvest in
 * vsl_harvests (the plot detail panel's Harvest History reads straight from
 * that table), then bumps each plot's ratoon number and flips
 * cultivation_status to "ratoon" — harvested cane regrows as ratoon,
 * which is what the next cycle actually is.
 */
async function applyHarvestingWriteBack(parcelIds, properties, createdBy) {
  const today = new Date().toISOString().slice(0, 10);
  const yieldWeight = numOrNull(properties.yield_tonnes);
  if (yieldWeight == null) {
    throw new Error("Enter a yield (tonnes) before saving a Harvesting activity.");
  }

  const { data: parcelsNow, error: fetchErr } = await supabase
    .from("vsl_parcels")
    .select("id, ratoon_number")
    .in("id", parcelIds);
  if (fetchErr) throw fetchErr;

  const harvestRows = (parcelsNow || []).map((p) => ({
    parcel_id: p.id,
    harvest_date: today,
    gross_weight_tonnes: yieldWeight,
    ratoon_at_harvest: p.ratoon_number ?? 0,
    created_by: createdBy
  }));
  const { error: harvestErr } = await supabase.from("vsl_harvests").insert(harvestRows);
  if (harvestErr) throw harvestErr;

  for (const p of parcelsNow || []) {
    const { error: updErr } = await supabase
      .from("vsl_parcels")
      .update({
        ratoon_number: (p.ratoon_number ?? 0) + 1,
        cultivation_status: "ratoon",
        cultivation_updated_at: new Date().toISOString()
      })
      .eq("id", p.id);
    if (updErr) throw updErr;
  }
}

async function buildParcelInfoHtml(parcelId) {
  const [parcelRes, alertsRes, seasonsRes, activitiesRes, harvestsRes, soilRes, mediaRes, docsRes, commentsRes] = await Promise.all([
    supabase.from("vsl_parcels").select("*").eq("id", parcelId).single(),
    supabase.from("vsl_alerts").select("*").eq("layer_type", "PARCELS").eq("target_id", String(parcelId)).order("created_at", { ascending: false }),
    supabase.from("vsl_parcel_seasons").select("*").eq("parcel_id", parcelId).order("created_at", { ascending: false }),
    supabase.from("vsl_activities").select("*").eq("parcel_id", parcelId).order("activity_date", { ascending: false }).limit(15),
    supabase.from("vsl_harvests").select("*").eq("parcel_id", parcelId).order("harvest_date", { ascending: false }),
    supabase.from("vsl_parcel_soil_tests").select("*").eq("parcel_id", parcelId).order("sample_date", { ascending: false }),
    supabase.from("vsl_media").select("*").eq("entity_type", "parcel").eq("entity_id", String(parcelId)).order("captured_at", { ascending: false }),
    supabase.from("vsl_documents").select("*").eq("entity_type", "parcel").eq("entity_id", String(parcelId)).order("upload_date", { ascending: false }),
    supabase.from("vsl_comments").select("*").eq("entity_type", "parcel").eq("entity_id", String(parcelId)).order("created_at", { ascending: false })
  ]);

  const parcel = parcelRes.data;
  if (!parcel) throw new Error("Plot not found.");

  let blockRow = null;
  try {
    const { data } = await supabase.from("vsl_blocks").select("estate_id, block_code, block_name, vsl_estate(estate_name)").eq("id", parcel.block_id).single();
    blockRow = data;
  } catch {}

  const alerts = alertsRes.data || [];
  const seasons = seasonsRes.data || [];
  const activities = activitiesRes.data || [];
  const harvests = harvestsRes.data || [];
  const soilTests = soilRes.data || [];
  const media = mediaRes.data || [];
  const docs = docsRes.data || [];
  const comments = commentsRes.data || [];
  const currentSeason = seasons[0] || null;

  // Resolve "who did this" user ids (created_by/resolved_by/captured_by/
  // user_id — see RECORD_WHO_COLUMNS) into readable names for the
  // record-detail drill-down (buildRecordDetailRows), in one batched
  // lookup rather than a query per record. Names are attached as
  // record._whoNames[column] — the raw id columns themselves are left
  // untouched (canEditRecordDetail still needs them for permission checks).
  const whoIds = new Set();
  const collectWhoIds = (list, cols) => { for (const r of list) for (const c of cols) if (r[c]) whoIds.add(r[c]); };
  collectWhoIds(alerts, RECORD_WHO_COLUMNS.alert);
  collectWhoIds(activities, RECORD_WHO_COLUMNS.activity);
  collectWhoIds(harvests, RECORD_WHO_COLUMNS.harvest);
  collectWhoIds(media, RECORD_WHO_COLUMNS.media);
  collectWhoIds(comments, RECORD_WHO_COLUMNS.comment);

  let nameById = new Map();
  if (whoIds.size) {
    const { data: whoProfiles } = await supabase.from("vsl_profiles").select("id, full_name").in("id", Array.from(whoIds));
    nameById = new Map((whoProfiles || []).map((p) => [p.id, p.full_name]));
  }
  const attachWhoNames = (list, cols) => {
    for (const r of list) {
      r._whoNames = {};
      for (const c of cols) if (r[c]) r._whoNames[c] = nameById.get(r[c]) || null;
    }
  };
  attachWhoNames(alerts, RECORD_WHO_COLUMNS.alert);
  attachWhoNames(activities, RECORD_WHO_COLUMNS.activity);
  attachWhoNames(harvests, RECORD_WHO_COLUMNS.harvest);
  attachWhoNames(media, RECORD_WHO_COLUMNS.media);
  attachWhoNames(comments, RECORD_WHO_COLUMNS.comment);

  const groups = [];

  groups.push(buildCollapsibleGroup("Details", buildKvTable([
    ["Plot code", fmt(parcel.parcel_code)],
    ["Plot name", fmt(parcel.parcel_name)],
    ["Block name", fmt(blockRow?.block_name)],
    ["Estate name", fmt(blockRow?.vsl_estate?.estate_name)],
    ["Current activity", fmt(parcel.current_activity_name)],
    ["Cultivation status", fmt(CULTIVATION_STATUS_LABELS[parcel.cultivation_status] || parcel.cultivation_status)],
    ["Area", parcel.area_acres != null ? `${Number(parcel.area_acres).toFixed(2)} ac` : "—"],
    ["Geometry status", fmt(parcel.geometry_status)],
    ["Notes", fmt(parcel.cultivation_notes)],
    ["Last updated", fmt(parcel.cultivation_updated_at ? String(parcel.cultivation_updated_at).slice(0, 16).replace("T", " ") : null)]
  ]), { open: true }));

  // Name/Status/Severity only — Description and Logged date are still
  // there, just one click away via the record-detail drill-down (the link
  // on the Name cell) rather than crowding the summary row. Severity is
  // filled with its color whenever the alert is still unresolved (open or
  // investigating) so an urgent one stands out at a glance.
  groups.push(buildCollapsibleGroup(`Alerts (${alerts.length})`, buildAlertsListTableHtml(alerts)));

  groups.push(buildCollapsibleGroup("Current Crop Cycle", currentSeason
    ? buildKvTable([
      ["Season name", fmt(currentSeason.season_name)],
      ["Cane variety", fmt(currentSeason.cane_variety)],
      ["Ratoon number", fmt(currentSeason.ratoon_number, { fallback: "0" })],
      ["Growth stage", fmt(currentSeason.growth_stage)],
      ["Planting date", fmt(currentSeason.planting_date)],
      ["Expected harvest date", fmt(currentSeason.expected_harvest_date)],
      ["Actual harvest date", fmt(currentSeason.actual_harvest_date)],
      ["Season status", fmt(currentSeason.season_status)],
      ["Target yield (t)", fmt(currentSeason.target_yield_tonnes)],
      ["Actual yield (t)", fmt(currentSeason.actual_yield_tonnes)],
      ["Yield per hectare", fmt(currentSeason.yield_per_hectare)]
    ])
    : `<p class="map-popup__empty">No crop cycle recorded yet.</p>`));

  groups.push(buildCollapsibleGroup(`Activity History (${activities.length})`,
    buildKvTable([["Current activity", fmt(parcel.current_activity_name)]]) +
    buildListTable(["Activity", "Progress", "Date"], activities.map((a, i) => [
      buildRecordLink("activity", i, fmt(a.activity_name)),
      a.completion_value != null ? `${escapeHtml(a.completion_value)}%` : "—",
      fmt(a.activity_date)
    ]), "No activities logged yet.", THREE_COL_WIDTHS)));

  groups.push(buildCollapsibleGroup(`Harvest History (${harvests.length})`, buildListTable(
    ["Date", "Gross weight", "Ratoon"],
    harvests.map((h, i) => [
      buildRecordLink("harvest", i, fmt(h.harvest_date)),
      h.gross_weight_tonnes != null ? `${escapeHtml(h.gross_weight_tonnes)} t` : "—",
      fmt(h.ratoon_at_harvest, { fallback: "0" })
    ]),
    "No harvests logged yet.",
    THREE_COL_WIDTHS
  )));

  groups.push(buildCollapsibleGroup(`Soil & Land (${soilTests.length})`, buildListTable(
    ["Sampled", "pH", "N", "P", "K", "Organic matter", "Texture", "Lab"],
    soilTests.map((s) => [
      fmt(s.sample_date), fmt(s.soil_ph), fmt(s.nitrogen), fmt(s.phosphorus), fmt(s.potassium),
      s.organic_matter_pct != null ? `${escapeHtml(s.organic_matter_pct)}%` : "—",
      fmt(s.texture), fmt(s.lab_name)
    ])
  )));

  groups.push(buildCollapsibleGroup(`Media (${media.length})`, buildListTable(
    ["Type", "Caption", "Captured", "File"],
    media.map((m, i) => [buildRecordLink("media", i, fmt(m.media_type)), fmt(m.caption), fmt(m.captured_at ? String(m.captured_at).slice(0, 10) : null),
      m.file_url ? `<a href="${escapeHtml(m.file_url)}" target="_blank" rel="noopener">Open</a>` : "—"])
  )));

  groups.push(buildCollapsibleGroup(`Documents (${docs.length})`, buildListTable(
    ["Type", "Title", "Uploaded", "File"],
    docs.map((d) => [fmt(d.doc_type), fmt(d.document_title), fmt(d.upload_date),
      d.file_url ? `<a href="${escapeHtml(d.file_url)}" target="_blank" rel="noopener">Open</a>` : "—"])
  )));

  groups.push(buildCollapsibleGroup(`Comments (${comments.length})`, buildListTable(
    ["Type", "Comment", "Status", "Date"],
    comments.map((c, i) => [buildRecordLink("comment", i, fmt(c.comment_type)), fmt(c.comment_text), c.is_resolved ? "Resolved" : "Open", fmt(c.created_at ? String(c.created_at).slice(0, 10) : null)])
  )));

  groups.push(buildCollapsibleGroup("History / Audit", HISTORY_AUDIT_PLACEHOLDER));

  // Drives the record-detail drill-down's click handler (see
  // setupRecordDetailModal) — the links just rendered above reference rows
  // in these same arrays by index.
  infoPanelRecords = { alerts, activities, harvests, media, comments };

  const exportSections = buildParcelExportSections({
    parcel, blockRow, alerts, currentSeason, activities, harvests, soilTests, media, docs, comments
  });

  return {
    html: groups.join(""),
    exportSections,
    title: parcel.parcel_name || parcel.parcel_code || "Plot",
    estateId: blockRow?.estate_id ?? null,
    blockId: parcel.block_id ?? null,
    parcelId: parcel.id,
    estateName: blockRow?.vsl_estate?.estate_name || null,
    blockName: blockRow?.block_name || null,
    parcelName: parcel.parcel_name || parcel.parcel_code || null,
    expectedAreaAcres: parcel.area_acres ?? null
  };
}

/** Plain-text mirror of buildParcelInfoHtml's groups — same data, same
 *  section titles/order, just {label,value} pairs (or header+row tables)
 *  instead of HTML, for js/feature-export.js's CSV/PDF output. Kept as a
 *  separate function rather than threading export rows through the HTML
 *  builder above so the two stay easy to read independently; if you add a
 *  group up there, add its export equivalent here too. */
function buildParcelExportSections({ parcel, blockRow, alerts, currentSeason, activities, harvests, soilTests, media, docs, comments }) {
  const sections = [];

  sections.push({ title: "Details", type: "kv", rows: [
    ["Plot code", fmtPlain(parcel.parcel_code)],
    ["Plot name", fmtPlain(parcel.parcel_name)],
    ["Block name", fmtPlain(blockRow?.block_name)],
    ["Estate name", fmtPlain(blockRow?.vsl_estate?.estate_name)],
    ["Current activity", fmtPlain(parcel.current_activity_name)],
    ["Cultivation status", fmtPlain(CULTIVATION_STATUS_LABELS[parcel.cultivation_status] || parcel.cultivation_status)],
    ["Area", parcel.area_acres != null ? `${Number(parcel.area_acres).toFixed(2)} ac` : "—"],
    ["Geometry status", fmtPlain(parcel.geometry_status)],
    ["Notes", fmtPlain(parcel.cultivation_notes)],
    ["Last updated", fmtPlain(parcel.cultivation_updated_at ? String(parcel.cultivation_updated_at).slice(0, 16).replace("T", " ") : null)]
  ] });

  sections.push({ title: `Alerts (${alerts.length})`, type: "table", headers: ["Alert", "Status", "Severity"], rows: alerts.map((a) => [
    fmtPlain(a.alert_name), fmtPlain(a.status), fmtPlain(SEVERITY_LABELS[a.severity] || a.severity)
  ]) });

  sections.push({ title: "Current Crop Cycle", type: "kv", rows: currentSeason ? [
    ["Season name", fmtPlain(currentSeason.season_name)],
    ["Cane variety", fmtPlain(currentSeason.cane_variety)],
    ["Ratoon number", fmtPlain(currentSeason.ratoon_number, { fallback: "0" })],
    ["Growth stage", fmtPlain(currentSeason.growth_stage)],
    ["Planting date", fmtPlain(currentSeason.planting_date)],
    ["Expected harvest date", fmtPlain(currentSeason.expected_harvest_date)],
    ["Actual harvest date", fmtPlain(currentSeason.actual_harvest_date)],
    ["Season status", fmtPlain(currentSeason.season_status)],
    ["Target yield (t)", fmtPlain(currentSeason.target_yield_tonnes)],
    ["Actual yield (t)", fmtPlain(currentSeason.actual_yield_tonnes)],
    ["Yield per hectare", fmtPlain(currentSeason.yield_per_hectare)]
  ] : [["Status", "No crop cycle recorded yet."]] });

  sections.push({ title: `Activity History (${activities.length})`, type: "table", headers: ["Activity", "Progress", "Date"], rows: activities.map((a) => [
    fmtPlain(a.activity_name), a.completion_value != null ? `${a.completion_value}%` : "—", fmtPlain(a.activity_date)
  ]) });

  sections.push({ title: `Harvest History (${harvests.length})`, type: "table", headers: ["Date", "Gross weight", "Ratoon"], rows: harvests.map((h) => [
    fmtPlain(h.harvest_date), h.gross_weight_tonnes != null ? `${h.gross_weight_tonnes} t` : "—", fmtPlain(h.ratoon_at_harvest, { fallback: "0" })
  ]) });

  sections.push({ title: `Soil & Land (${soilTests.length})`, type: "table", headers: ["Sampled", "pH", "N", "P", "K", "Organic matter", "Texture", "Lab"], rows: soilTests.map((s) => [
    fmtPlain(s.sample_date), fmtPlain(s.soil_ph), fmtPlain(s.nitrogen), fmtPlain(s.phosphorus), fmtPlain(s.potassium),
    s.organic_matter_pct != null ? `${s.organic_matter_pct}%` : "—", fmtPlain(s.texture), fmtPlain(s.lab_name)
  ]) });

  sections.push({ title: `Media (${media.length})`, type: "table", headers: ["Type", "Caption", "Captured", "File"], rows: media.map((m) => [
    fmtPlain(m.media_type), fmtPlain(m.caption), fmtPlain(m.captured_at ? String(m.captured_at).slice(0, 10) : null), m.file_url || "—"
  ]) });

  sections.push({ title: `Documents (${docs.length})`, type: "table", headers: ["Type", "Title", "Uploaded", "File"], rows: docs.map((d) => [
    fmtPlain(d.doc_type), fmtPlain(d.document_title), fmtPlain(d.upload_date), d.file_url || "—"
  ]) });

  sections.push({ title: `Comments (${comments.length})`, type: "table", headers: ["Type", "Comment", "Status", "Date"], rows: comments.map((c) => [
    fmtPlain(c.comment_type), fmtPlain(c.comment_text), c.is_resolved ? "Resolved" : "Open", fmtPlain(c.created_at ? String(c.created_at).slice(0, 10) : null)
  ]) });

  return sections;
}

async function buildBlockInfoHtml(blockId) {
  const [blockRes, parcelsRes, mediaRes, docsRes, commentsRes] = await Promise.all([
    // vsl_profiles!manager_id embeds the assigned manager's profile straight off
    // vsl_blocks.manager_id — vsl_estate_managers (the old junction table) was dropped.
    supabase.from("vsl_blocks").select("*, vsl_estate(estate_name), vsl_profiles!manager_id(email, full_name, phone, title)").eq("id", blockId).single(),
    supabase.from("vsl_parcels").select("id, parcel_name, cultivation_status, ratoon_number, current_activity_name, area_acres").eq("block_id", blockId),
    supabase.from("vsl_media").select("*").eq("entity_type", "block").eq("entity_id", String(blockId)).order("captured_at", { ascending: false }),
    supabase.from("vsl_documents").select("*").eq("entity_type", "block").eq("entity_id", String(blockId)).order("upload_date", { ascending: false }),
    supabase.from("vsl_comments").select("*").eq("entity_type", "block").eq("entity_id", String(blockId)).order("created_at", { ascending: false })
  ]);

  const block = blockRes.data;
  if (!block) throw new Error("Block not found.");
  const parcels = parcelsRes.data || [];
  const parcelIds = parcels.map((p) => p.id);

  const [alertsRes, seasonsRes, harvestsRes] = await Promise.all([
    parcelIds.length
      ? supabase.from("vsl_alerts").select("severity").eq("layer_type", "PARCELS").eq("status", "open").in("target_id", parcelIds.map(String))
      : Promise.resolve({ data: [] }),
    parcelIds.length
      ? supabase.from("vsl_parcel_seasons").select("parcel_id, cane_variety, created_at").in("parcel_id", parcelIds).order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    parcelIds.length
      ? supabase.from("vsl_harvests").select("parcel_id, gross_weight_tonnes, harvest_date").in("parcel_id", parcelIds)
      : Promise.resolve({ data: [] })
  ]);

  const totalPlots = parcels.length;
  const totalArea = parcels.reduce((s, p) => s + (Number(p.area_acres) || 0), 0);

  const statusCounts = {};
  for (const p of parcels) {
    const k = p.cultivation_status || "vacant";
    statusCounts[k] = (statusCounts[k] || 0) + 1;
  }
  const statusRows = Object.keys(CULTIVATION_STATUS_LABELS).map((k) => [CULTIVATION_STATUS_LABELS[k], String(statusCounts[k] || 0)]);

  const ratoonCounts = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5+": 0 };
  for (const p of parcels) {
    const r = Number(p.ratoon_number) || 0;
    const key = r >= 5 ? "5+" : String(r);
    ratoonCounts[key] = (ratoonCounts[key] || 0) + 1;
  }
  const ratoonRows = Object.entries(ratoonCounts).map(([k, v]) => [k === "0" ? "0 (Plant crop)" : k, String(v)]);

  const activityCounts = {};
  for (const p of parcels) {
    const name = p.current_activity_name || "None";
    activityCounts[name] = (activityCounts[name] || 0) + 1;
  }
  const activityRows = Object.entries(activityCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]);

  const alertCounts = { critical: 0, warning: 0, information: 0 };
  for (const a of alertsRes.data || []) {
    if (alertCounts[a.severity] != null) alertCounts[a.severity] += 1;
  }
  const alertRows = [
    ["Critical", String(alertCounts.critical)],
    ["Warning", String(alertCounts.warning)],
    ["Information", String(alertCounts.information)]
  ];

  const latestSeasonByParcel = new Map();
  for (const s of seasonsRes.data || []) {
    if (!latestSeasonByParcel.has(s.parcel_id)) latestSeasonByParcel.set(s.parcel_id, s);
  }
  const varietyCounts = {};
  for (const s of latestSeasonByParcel.values()) {
    const v = s.cane_variety || "Unspecified";
    varietyCounts[v] = (varietyCounts[v] || 0) + 1;
  }
  const varietyRows = Object.entries(varietyCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([k, v], i) => [String(i + 1), k, String(v)]);

  // Per-plot table (name, area, ratoon, cane variety) — reuses
  // latestSeasonByParcel just above rather than re-querying seasons.
  const plotRows = parcels
    .slice()
    .sort((a, b) => String(a.parcel_name ?? "").localeCompare(String(b.parcel_name ?? ""), undefined, { numeric: true }))
    .map((p) => [
      p.parcel_name || "Plot",
      p.area_acres != null ? `${Number(p.area_acres).toFixed(2)} ac` : "—",
      p.ratoon_number != null ? String(p.ratoon_number) : "0",
      latestSeasonByParcel.get(p.id)?.cane_variety || "—"
    ]);

  const harvestList = harvestsRes.data || [];
  const totalGross = harvestList.reduce((s, h) => s + (Number(h.gross_weight_tonnes) || 0), 0);
  const plotsHarvested = new Set(harvestList.map((h) => h.parcel_id)).size;
  const lastHarvestDate = harvestList.reduce((max, h) => (!max || h.harvest_date > max ? h.harvest_date : max), null);

  const media = mediaRes.data || [];
  const docs = docsRes.data || [];
  const comments = commentsRes.data || [];

  const groups = [];

  groups.push(buildCollapsibleGroup("Details", buildKvTable([
    ["Block code", fmt(block.block_code)],
    ["Block name", fmt(block.block_name)],
    ["Estate name", fmt(block.vsl_estate?.estate_name)],
    ["Number of plots", String(totalPlots)],
    ["Block area", block.area_acres != null ? `${Number(block.area_acres).toFixed(2)} ac` : "—"],
    ["Total plot area", `${totalArea.toFixed(2)} ac`],
    ["Dominant soil type", fmt(block.soil_type)],
    ["Soil pH", fmt(block.soil_ph)],
    ["Irrigation type", fmt(block.irrigation_type)],
    ["Manager (flat field)", fmt(block.manager_name)],
    ["Manager phone", fmt(block.manager_phone)]
  ]), { open: true }));

  groups.push(buildCollapsibleGroup(`Plots (${plotRows.length})`, buildListTable(
    ["Plot", "Area", "Ratoon", "Cane variety"], plotRows, "No plots in this block yet.", FOUR_COL_EQUAL_WIDTHS
  )));

  groups.push(buildCollapsibleGroup("Status", buildListTable(["Status", "Number of plots"], statusRows)));
  groups.push(buildCollapsibleGroup("Ratoon Number", buildListTable(["Ratoon number", "Number of plots"], ratoonRows)));
  groups.push(buildCollapsibleGroup("Activities", buildListTable(["Activity", "Number of plots"], activityRows)));
  groups.push(buildCollapsibleGroup("Alerts (open)", buildListTable(["Severity", "Number of plots"], alertRows)));
  groups.push(buildCollapsibleGroup("Harvest Summary", buildKvTable([
    ["Total harvests logged", String(harvestList.length)],
    ["Plots harvested", String(plotsHarvested)],
    ["Total gross weight", `${totalGross.toFixed(2)} t`],
    ["Last harvest date", fmt(lastHarvestDate)]
  ])));
  groups.push(buildCollapsibleGroup("Top 5 Cane Varieties", buildListTable(["Rank", "Variety", "Number of plots"], varietyRows)));
  groups.push(buildCollapsibleGroup("Manager", block.vsl_profiles
    ? buildKvTable([
      ["Name", fmt(block.vsl_profiles.full_name)],
      ["Email", fmt(block.vsl_profiles.email)],
      ["Phone", fmt(block.vsl_profiles.phone)],
      ["Title", fmt(block.vsl_profiles.title)]
    ])
    : `<p class="map-popup__empty">No manager assigned.</p>`));
  groups.push(buildCollapsibleGroup(`Media (${media.length})`, buildListTable(
    ["Type", "Caption", "Captured", "File"],
    media.map((m) => [fmt(m.media_type), fmt(m.caption), fmt(m.captured_at ? String(m.captured_at).slice(0, 10) : null),
      m.file_url ? `<a href="${escapeHtml(m.file_url)}" target="_blank" rel="noopener">Open</a>` : "—"])
  )));
  groups.push(buildCollapsibleGroup(`Documents (${docs.length})`, buildListTable(
    ["Type", "Title", "Uploaded", "File"],
    docs.map((d) => [fmt(d.doc_type), fmt(d.document_title), fmt(d.upload_date),
      d.file_url ? `<a href="${escapeHtml(d.file_url)}" target="_blank" rel="noopener">Open</a>` : "—"])
  )));
  groups.push(buildCollapsibleGroup(`Comments (${comments.length})`, buildListTable(
    ["Type", "Comment", "Status", "Date"],
    comments.map((c) => [fmt(c.comment_type), fmt(c.comment_text), c.is_resolved ? "Resolved" : "Open", fmt(c.created_at ? String(c.created_at).slice(0, 10) : null)])
  )));
  groups.push(buildCollapsibleGroup("History / Audit", HISTORY_AUDIT_PLACEHOLDER));

  // Block view has no per-row drill-down links, so nothing here would ever
  // read this — reset it anyway so a stale parcel's records can't linger.
  infoPanelRecords = {};

  const exportSections = buildBlockExportSections({
    block, totalPlots, totalArea, plotRows, statusRows, ratoonRows, activityRows, alertRows,
    harvestList, plotsHarvested, totalGross, lastHarvestDate, varietyRows, media, docs, comments
  });

  return {
    html: groups.join(""),
    exportSections,
    title: block.block_name || block.block_code || "Block",
    estateId: block.estate_id ?? null,
    blockId: block.id,
    parcelId: null,
    estateName: block.vsl_estate?.estate_name || null,
    blockName: block.block_name || block.block_code || null,
    parcelName: null,
    expectedAreaAcres: block.area_acres ?? null
  };
}

/** Plain-text mirror of buildBlockInfoHtml's groups — see
 *  buildParcelExportSections above for why this is a separate function
 *  rather than threading export rows through the HTML builder. */
function buildBlockExportSections({ block, totalPlots, totalArea, plotRows, statusRows, ratoonRows, activityRows, alertRows, harvestList, plotsHarvested, totalGross, lastHarvestDate, varietyRows, media, docs, comments }) {
  const sections = [];

  sections.push({ title: "Details", type: "kv", rows: [
    ["Block code", fmtPlain(block.block_code)],
    ["Block name", fmtPlain(block.block_name)],
    ["Estate name", fmtPlain(block.vsl_estate?.estate_name)],
    ["Number of plots", String(totalPlots)],
    ["Block area", block.area_acres != null ? `${Number(block.area_acres).toFixed(2)} ac` : "—"],
    ["Total plot area", `${totalArea.toFixed(2)} ac`],
    ["Dominant soil type", fmtPlain(block.soil_type)],
    ["Soil pH", fmtPlain(block.soil_ph)],
    ["Irrigation type", fmtPlain(block.irrigation_type)],
    ["Manager (flat field)", fmtPlain(block.manager_name)],
    ["Manager phone", fmtPlain(block.manager_phone)]
  ] });

  sections.push({ title: `Plots (${plotRows.length})`, type: "table", headers: ["Plot", "Area", "Ratoon", "Cane variety"], rows: plotRows });

  sections.push({ title: "Status", type: "table", headers: ["Status", "Number of plots"], rows: statusRows });
  sections.push({ title: "Ratoon Number", type: "table", headers: ["Ratoon number", "Number of plots"], rows: ratoonRows });
  sections.push({ title: "Activities", type: "table", headers: ["Activity", "Number of plots"], rows: activityRows });
  sections.push({ title: "Alerts (open)", type: "table", headers: ["Severity", "Number of plots"], rows: alertRows });

  sections.push({ title: "Harvest Summary", type: "kv", rows: [
    ["Total harvests logged", String(harvestList.length)],
    ["Plots harvested", String(plotsHarvested)],
    ["Total gross weight", `${totalGross.toFixed(2)} t`],
    ["Last harvest date", fmtPlain(lastHarvestDate)]
  ] });

  sections.push({ title: "Top 5 Cane Varieties", type: "table", headers: ["Rank", "Variety", "Number of plots"], rows: varietyRows });

  sections.push({ title: "Manager", type: "kv", rows: block.vsl_profiles ? [
    ["Name", fmtPlain(block.vsl_profiles.full_name)],
    ["Email", fmtPlain(block.vsl_profiles.email)],
    ["Phone", fmtPlain(block.vsl_profiles.phone)],
    ["Title", fmtPlain(block.vsl_profiles.title)]
  ] : [["Status", "No manager assigned."]] });

  sections.push({ title: `Media (${media.length})`, type: "table", headers: ["Type", "Caption", "Captured", "File"], rows: media.map((m) => [
    fmtPlain(m.media_type), fmtPlain(m.caption), fmtPlain(m.captured_at ? String(m.captured_at).slice(0, 10) : null), m.file_url || "—"
  ]) });

  sections.push({ title: `Documents (${docs.length})`, type: "table", headers: ["Type", "Title", "Uploaded", "File"], rows: docs.map((d) => [
    fmtPlain(d.doc_type), fmtPlain(d.document_title), fmtPlain(d.upload_date), d.file_url || "—"
  ]) });

  sections.push({ title: `Comments (${comments.length})`, type: "table", headers: ["Type", "Comment", "Status", "Date"], rows: comments.map((c) => [
    fmtPlain(c.comment_type), fmtPlain(c.comment_text), c.is_resolved ? "Resolved" : "Open", fmtPlain(c.created_at ? String(c.created_at).slice(0, 10) : null)
  ]) });

  return sections;
}

/** Estate-level view (the Feature Info panel's filter bar with only Estate
 *  picked, no Block/Plot — see setupFeatureInfoFilterBar). Mirrors
 *  buildParcelInfoHtml/buildBlockInfoHtml's { html, exportSections, title,
 *  estateId/blockId/parcelId, estateName/blockName/parcelName } shape so it
 *  slots into the same rendering/export pipeline. "Planted area" (per
 *  block and estate-wide) is the sum of vsl_parcels.area_acres
 *  for plots whose cultivation_status is
 *  anything other than "vacant" — there's no dedicated column for it. */
async function buildEstateInfoHtml(estateId) {
  const [estateRes, blocksRes] = await Promise.all([
    supabase.from("vsl_estate").select("*, vsl_profiles!manager_id(email, full_name, phone, title)").eq("id", estateId).single(),
    supabase.from("vsl_blocks").select("id, block_code, block_name, area_acres").eq("estate_id", estateId)
  ]);

  const estate = estateRes.data;
  if (!estate) throw new Error("Estate not found.");
  const blocks = blocksRes.data || [];
  const blockIds = blocks.map((b) => b.id);

  const parcelRowsRes = blockIds.length
    ? await supabase.from("vsl_parcels").select("block_id, area_acres, cultivation_status").in("block_id", blockIds)
    : { data: [] };
  const parcelRows = parcelRowsRes.data || [];

  const perBlock = new Map();
  for (const b of blocks) perBlock.set(b.id, { plots: 0, plantedArea: 0 });
  for (const p of parcelRows) {
    const agg = perBlock.get(p.block_id);
    if (!agg) continue;
    agg.plots += 1;
    if (p.cultivation_status && p.cultivation_status !== "vacant") {
      agg.plantedArea += Number(p.area_acres) || 0;
    }
  }

  const blockRows = blocks
    .slice()
    .sort((a, b) => {
      const na = Number(a.block_code), nb = Number(b.block_code);
      return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : String(a.block_code).localeCompare(String(b.block_code), undefined, { numeric: true });
    })
    .map((b) => {
      const agg = perBlock.get(b.id) || { plots: 0, plantedArea: 0 };
      return {
        name: b.block_name || b.block_code || "Block",
        area: Number(b.area_acres) || 0,
        plots: agg.plots,
        plantedArea: agg.plantedArea
      };
    });

  const totalArea = blockRows.reduce((s, r) => s + r.area, 0);
  const totalPlots = blockRows.reduce((s, r) => s + r.plots, 0);
  const totalPlantedArea = blockRows.reduce((s, r) => s + r.plantedArea, 0);

  const groups = [];

  groups.push(buildCollapsibleGroup("Details", buildKvTable([
    ["Estate code", fmt(estate.estate_code)],
    ["Estate name", fmt(estate.estate_name)],
    ["Region", fmt(estate.region)],
    ["District", fmt(estate.district)],
    ["Country", fmt(estate.country)],
    ["Address", fmt(estate.address)],
    ["Number of blocks", String(blockRows.length)],
    ["Total area", `${totalArea.toFixed(2)} ac`],
    ["Number of plots", String(totalPlots)],
    ["Total planted area", `${totalPlantedArea.toFixed(2)} ac`],
    ["Primary soil type", fmt(estate.primary_soil_type)],
    ["Average rainfall", estate.average_rainfall_mm != null ? `${estate.average_rainfall_mm} mm` : "—"],
    ["Elevation range", (estate.elevation_min_m != null || estate.elevation_max_m != null) ? `${fmt(estate.elevation_min_m)}–${fmt(estate.elevation_max_m)} m` : "—"],
    ["Ownership type", fmt(estate.ownership_type)],
    ["Owner", fmt(estate.owner_name)],
    ["Owner phone", fmt(estate.owner_contact_phone)],
    ["Owner email", fmt(estate.owner_contact_email)],
    ["Established", fmt(estate.established_date)],
    ["Status", fmt(estate.status)],
    ["Yield per acre (t)", fmt(estate.yield_per_acre_tons)],
    ["Notes", fmt(estate.notes)]
  ]), { open: true }));

  groups.push(buildCollapsibleGroup(`Blocks (${blockRows.length})`, buildListTable(
    ["Block", "Area", "Plots", "Planted area"],
    blockRows.map((r) => [r.name, `${r.area.toFixed(2)} ac`, String(r.plots), `${r.plantedArea.toFixed(2)} ac`]),
    "No blocks in this estate yet.",
    FOUR_COL_EQUAL_WIDTHS
  )));

  groups.push(buildCollapsibleGroup("Manager", estate.vsl_profiles
    ? buildKvTable([
      ["Name", fmt(estate.vsl_profiles.full_name)],
      ["Email", fmt(estate.vsl_profiles.email)],
      ["Phone", fmt(estate.vsl_profiles.phone)],
      ["Title", fmt(estate.vsl_profiles.title)]
    ])
    : `<p class="map-popup__empty">No manager assigned.</p>`));

  // Estate view has no per-row drill-down links (unlike the parcel view) —
  // reset it anyway so a stale parcel's records can't linger.
  infoPanelRecords = {};

  const exportSections = buildEstateExportSections({ estate, blockRows, totalArea, totalPlots, totalPlantedArea });

  return {
    html: groups.join(""),
    exportSections,
    title: estate.estate_name || "Estate",
    estateId: estate.id,
    blockId: null,
    parcelId: null,
    estateName: estate.estate_name || null,
    blockName: null,
    parcelName: null
  };
}

/** Plain-text mirror of buildEstateInfoHtml's groups — see
 *  buildParcelExportSections above for why this is a separate function. */
function buildEstateExportSections({ estate, blockRows, totalArea, totalPlots, totalPlantedArea }) {
  const sections = [];

  sections.push({ title: "Details", type: "kv", rows: [
    ["Estate code", fmtPlain(estate.estate_code)],
    ["Estate name", fmtPlain(estate.estate_name)],
    ["Region", fmtPlain(estate.region)],
    ["District", fmtPlain(estate.district)],
    ["Country", fmtPlain(estate.country)],
    ["Address", fmtPlain(estate.address)],
    ["Number of blocks", String(blockRows.length)],
    ["Total area", `${totalArea.toFixed(2)} ac`],
    ["Number of plots", String(totalPlots)],
    ["Total planted area", `${totalPlantedArea.toFixed(2)} ac`],
    ["Primary soil type", fmtPlain(estate.primary_soil_type)],
    ["Average rainfall", estate.average_rainfall_mm != null ? `${estate.average_rainfall_mm} mm` : "—"],
    ["Elevation range", (estate.elevation_min_m != null || estate.elevation_max_m != null) ? `${fmtPlain(estate.elevation_min_m)}-${fmtPlain(estate.elevation_max_m)} m` : "—"],
    ["Ownership type", fmtPlain(estate.ownership_type)],
    ["Owner", fmtPlain(estate.owner_name)],
    ["Owner phone", fmtPlain(estate.owner_contact_phone)],
    ["Owner email", fmtPlain(estate.owner_contact_email)],
    ["Established", fmtPlain(estate.established_date)],
    ["Status", fmtPlain(estate.status)],
    ["Yield per acre (t)", fmtPlain(estate.yield_per_acre_tons)],
    ["Notes", fmtPlain(estate.notes)]
  ] });

  sections.push({ title: `Blocks (${blockRows.length})`, type: "table", headers: ["Block", "Area", "Plots", "Planted area"], rows: blockRows.map((r) => [
    r.name, `${r.area.toFixed(2)} ac`, String(r.plots), `${r.plantedArea.toFixed(2)} ac`
  ]) });

  sections.push({ title: "Manager", type: "kv", rows: estate.vsl_profiles ? [
    ["Name", fmtPlain(estate.vsl_profiles.full_name)],
    ["Email", fmtPlain(estate.vsl_profiles.email)],
    ["Phone", fmtPlain(estate.vsl_profiles.phone)],
    ["Title", fmtPlain(estate.vsl_profiles.title)]
  ] : [["Status", "No manager assigned."]] });

  return sections;
}

/** Entry point for the toolbar's info button (a real clicked OL feature) —
 *  resolves to the same central dispatcher (renderFeatureInfoView) the
 *  filter bar itself uses, so both paths render/export identically; this
 *  wrapper's only job is turning a clicked feature into the right id. */
async function openFeatureInfoPanel(feature, layerType) {
  const overlay = document.getElementById("featureInfoOverlay");
  if (!overlay || !feature || !layerType) return;
  overlay.hidden = false;
  const id = feature.getId();
  if (layerType === "BLOCKS") await renderFeatureInfoView({ blockId: id });
  else await renderFeatureInfoView({ parcelId: id });
}

/** Entry point for the standalone floating info button below
 *  .dashboard-btn (no feature pre-selected) — opens the panel with an
 *  empty filter bar so the person can browse to any Estate/Block/Plot. */
async function openFeatureInfoPanelManual() {
  const overlay = document.getElementById("featureInfoOverlay");
  const filterBar = document.getElementById("featureInfoFilterBar");
  if (!overlay) return;
  selectedFeature = null;
  selectedLayerType = null;
  overlay.hidden = false;
  if (filterBar) filterBar.hidden = false;

  const { estateSelect, blockSelect, plotSelect } = getFeatureInfoFilterEls();
  await loadFeatureInfoEstates();
  suppressFeatureInfoFilterEvents = true;
  try {
    if (estateSelect) estateSelect.value = "";
    if (blockSelect) { blockSelect.innerHTML = '<option value="">— Block (all) —</option>'; blockSelect.disabled = true; }
    if (plotSelect) { plotSelect.innerHTML = '<option value="">— Plot (all) —</option>'; plotSelect.disabled = true; }
  } finally {
    suppressFeatureInfoFilterEvents = false;
  }
  renderFeatureInfoEmptyState();
}

// ---------------------------------------------------------------------------
// Feature Info panel — Estate/Block/Plot filter bar (points 1 & 4) and the
// estate/block/parcel view dispatcher (points 5 & 6). See
// windows/feature-info-panel.html for the markup this wires up.
// ---------------------------------------------------------------------------

// What the panel is currently showing — read by the footer's Log button (to
// know what to log against, see setupFeatureInfoActionFooter) and by
// Download's naming/context. Kept separate from selectedFeature/
// selectedLayerType (only set for a real clicked OL feature) since a manual
// filter-bar pick has no OL feature backing it.
let featureInfoSelection = { estateId: null, blockId: null, parcelId: null, blockName: null, parcelName: null };

let featureInfoFilterBarWired = false;
let featureInfoEstatesLoaded = false;
// True only while this module is programmatically writing the selects'
// values (auto-fill from a map click, or re-sync after a render) — their
// own change handlers check this and bail out, so our own writes don't
// trigger a redundant re-render/re-fetch of the view we just rendered.
let suppressFeatureInfoFilterEvents = false;

function getFeatureInfoFilterEls() {
  return {
    estateSelect: document.getElementById("featureInfoEstateSelect"),
    blockSelect: document.getElementById("featureInfoBlockSelect"),
    plotSelect: document.getElementById("featureInfoPlotSelect")
  };
}

async function loadFeatureInfoEstates(force = false) {
  const { estateSelect } = getFeatureInfoFilterEls();
  if (!estateSelect) return;
  if (featureInfoEstatesLoaded && !force) return;
  const { data } = await supabase.from("vsl_estate").select("id, estate_name").order("estate_name", { ascending: true });
  estateSelect.innerHTML = '<option value="">— Estate —</option>';
  for (const e of data || []) {
    const o = document.createElement("option");
    o.value = e.id;
    o.textContent = e.estate_name;
    estateSelect.appendChild(o);
  }
  featureInfoEstatesLoaded = true;
}

async function loadFeatureInfoBlocks(estateId) {
  const { blockSelect, plotSelect } = getFeatureInfoFilterEls();
  if (!blockSelect || !plotSelect) return;
  plotSelect.innerHTML = '<option value="">— Plot (all) —</option>';
  plotSelect.disabled = true;
  if (!estateId) {
    blockSelect.innerHTML = '<option value="">— Block (all) —</option>';
    blockSelect.disabled = true;
    return;
  }
  blockSelect.innerHTML = '<option value="">Loading…</option>';
  blockSelect.disabled = true;
  const { data } = await supabase.from("vsl_blocks").select("id, block_code, block_name").eq("estate_id", estateId);
  const rows = (data || []).slice().sort((a, b) => {
    const na = Number(a.block_code), nb = Number(b.block_code);
    return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : String(a.block_code).localeCompare(String(b.block_code), undefined, { numeric: true });
  });
  blockSelect.innerHTML = '<option value="">— Block (all) —</option>';
  for (const b of rows) {
    const o = document.createElement("option");
    o.value = b.id;
    o.textContent = b.block_name || `Block ${b.block_code}`;
    blockSelect.appendChild(o);
  }
  blockSelect.disabled = false;
}

async function loadFeatureInfoPlots(blockId) {
  const { plotSelect } = getFeatureInfoFilterEls();
  if (!plotSelect) return;
  if (!blockId) {
    plotSelect.innerHTML = '<option value="">— Plot (all) —</option>';
    plotSelect.disabled = true;
    return;
  }
  plotSelect.innerHTML = '<option value="">Loading…</option>';
  plotSelect.disabled = true;
  const { data } = await supabase.from("vsl_parcels").select("id, parcel_code, parcel_name").eq("block_id", blockId);
  const rows = (data || []).slice().sort((a, b) => {
    const na = Number(a.parcel_code), nb = Number(b.parcel_code);
    return Number.isFinite(na) && Number.isFinite(nb) ? na - nb : String(a.parcel_code).localeCompare(String(b.parcel_code), undefined, { numeric: true });
  });
  plotSelect.innerHTML = '<option value="">— Plot (all) —</option>';
  for (const p of rows) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.parcel_name || `Plot ${p.parcel_code}`;
    plotSelect.appendChild(o);
  }
  plotSelect.disabled = false;
}

function setupFeatureInfoFilterBar() {
  if (featureInfoFilterBarWired) return;
  featureInfoFilterBarWired = true;
  const { estateSelect, blockSelect, plotSelect } = getFeatureInfoFilterEls();

  estateSelect?.addEventListener("change", async () => {
    if (suppressFeatureInfoFilterEvents) return;
    const estateId = estateSelect.value || null;
    await loadFeatureInfoBlocks(estateId);
    if (estateId) await renderFeatureInfoView({ estateId });
    else renderFeatureInfoEmptyState();
  });

  blockSelect?.addEventListener("change", async () => {
    if (suppressFeatureInfoFilterEvents) return;
    const estateId = estateSelect?.value || null;
    const blockId = blockSelect.value || null;
    await loadFeatureInfoPlots(blockId);
    if (blockId) await renderFeatureInfoView({ estateId, blockId });
    else if (estateId) await renderFeatureInfoView({ estateId });
    else renderFeatureInfoEmptyState();
  });

  plotSelect?.addEventListener("change", async () => {
    if (suppressFeatureInfoFilterEvents) return;
    const estateId = estateSelect?.value || null;
    const blockId = blockSelect?.value || null;
    const parcelId = plotSelect.value || null;
    if (parcelId) await renderFeatureInfoView({ estateId, blockId, parcelId });
    else if (blockId) await renderFeatureInfoView({ estateId, blockId });
    else if (estateId) await renderFeatureInfoView({ estateId });
    else renderFeatureInfoEmptyState();
  });
}

function renderFeatureInfoEmptyState() {
  const inner = document.getElementById("featureInfoPanelInner");
  const actionBtns = document.getElementById("featureInfoActionBtns");
  if (inner) inner.innerHTML = `<p class="map-popup__empty">Select an estate to see its details.</p>`;
  if (actionBtns) actionBtns.hidden = true;
  clearFeatureExportContext();
  featureInfoSelection = { estateId: null, blockId: null, parcelId: null, blockName: null, parcelName: null };
  setFeatureInfoHeader("ESTATE");
}

/** Central dispatcher for the Feature Info panel — decides which of the
 *  three detail views to show based on which ids are given (deepest wins:
 *  parcelId > blockId > estateId), fetches + renders it, feeds the
 *  footer's Download button, and re-syncs the filter bar's three selects
 *  to match (so opening from a map click, which only ever knows one id,
 *  still ends up with all three dropdowns correctly populated). */
async function renderFeatureInfoView({ estateId = null, blockId = null, parcelId = null }) {
  const inner = document.getElementById("featureInfoPanelInner");
  const overlay = document.getElementById("featureInfoOverlay");
  const filterBar = document.getElementById("featureInfoFilterBar");
  const actionBtns = document.getElementById("featureInfoActionBtns");
  if (!inner || !overlay) return;

  overlay.hidden = false;
  if (filterBar) filterBar.hidden = false;
  inner.innerHTML = `<p class="map-popup__empty">Loading…</p>`;
  clearFeatureExportContext();
  if (actionBtns) actionBtns.hidden = true;

  try {
    let result;
    let kind;
    if (parcelId) {
      kind = "parcel";
      result = await buildParcelInfoHtml(parcelId);
    } else if (blockId) {
      kind = "block";
      result = await buildBlockInfoHtml(blockId);
    } else if (estateId) {
      kind = "estate";
      result = await buildEstateInfoHtml(estateId);
    } else {
      renderFeatureInfoEmptyState();
      return;
    }

    inner.innerHTML = result.html;
    setFeatureInfoHeader(kind === "parcel" ? "PARCELS" : kind === "block" ? "BLOCKS" : "ESTATE");

    featureInfoSelection = {
      estateId: result.estateId ?? estateId ?? null,
      blockId: result.blockId ?? blockId ?? null,
      parcelId: result.parcelId ?? parcelId ?? null,
      blockName: result.blockName || null,
      parcelName: result.parcelName || null,
      expectedAreaAcres: result.expectedAreaAcres ?? null
    };

    await syncFeatureInfoFilterBar(featureInfoSelection);

    const { extent3857, lonLat } = computeExportGeometry(kind, featureInfoSelection);
    setFeatureExportContext({
      kind,
      title: result.title,
      estateName: result.estateName,
      blockName: result.blockName,
      parcelName: result.parcelName,
      printedBy: currentProfile?.full_name || currentProfile?.email || null,
      sections: result.exportSections,
      extent3857,
      lonLat
    });

    if (actionBtns) actionBtns.hidden = false;
    // Estate-level has no single block/plot to log an activity/alert
    // against — the Log button only makes sense once a Block (and
    // optionally Plot) is picked.
    const logMainBtn = document.getElementById("featureLogMainBtn");
    if (logMainBtn) logMainBtn.disabled = kind === "estate";
  } catch (err) {
    console.error("[Victoria] Failed to load feature info:", err);
    inner.innerHTML = `<p class="map-popup__empty">Failed to load details: ${escapeHtml(err?.message || "unknown error")}</p>`;
  }
}

/** Re-populates the three filter selects to match the given ids without
 *  re-triggering their own change handlers (see
 *  suppressFeatureInfoFilterEvents above). */
async function syncFeatureInfoFilterBar({ estateId, blockId, parcelId }) {
  const { estateSelect, blockSelect, plotSelect } = getFeatureInfoFilterEls();
  if (!estateSelect) return;
  suppressFeatureInfoFilterEvents = true;
  try {
    await loadFeatureInfoEstates();
    estateSelect.value = estateId != null ? String(estateId) : "";
    await loadFeatureInfoBlocks(estateId);
    if (blockSelect) blockSelect.value = blockId != null ? String(blockId) : "";
    await loadFeatureInfoPlots(blockId);
    if (plotSelect) plotSelect.value = parcelId != null ? String(parcelId) : "";
  } finally {
    suppressFeatureInfoFilterEvents = false;
  }
}

/** Geometry for the currently-shown kind, used by Download's PDF map
 *  snapshot + QR code. Looked up from whichever OL vector source already
 *  holds that feature — estatesSource is loaded in full at boot (see
 *  loadEstateBoundaries), while blocksSource/parcelsSource only hold
 *  whatever's currently in the map's viewport (see the bbox loader). If
 *  the feature isn't loaded in that source, the PDF just skips the
 *  snapshot/QR (see feature-export.js) rather than failing. */
function computeExportGeometry(kind, { estateId, blockId, parcelId }) {
  let feature = null;
  if (kind === "parcel" && parcelId != null) feature = parcelsSource.getFeatureById(parcelId);
  else if (kind === "block" && blockId != null) feature = blocksSource.getFeatureById(blockId);
  else if (kind === "estate" && estateId != null) feature = estatesSource.getFeatureById(estateId);
  const geom = feature?.getGeometry?.();
  if (!geom) return { extent3857: null, lonLat: null };
  const extent3857 = geom.getExtent();
  const lonLat = ol.proj.toLonLat(ol.extent.getCenter(extent3857), "EPSG:3857");
  return { extent3857, lonLat };
}

/** Lightweight object standing in for a real OL feature, so the Feature
 *  Info panel's Log button can open Log Activity/Log Alert against a
 *  manually-selected (filter-bar) block/plot that isn't necessarily loaded
 *  in the map's vector source. Both modals' open + save flows only ever
 *  call .getId() and .get(key) on whatever feature they're given — never
 *  .getGeometry() — so this covers everything they actually need. */
function makeFeatureInfoShim(layerType, sel) {
  const id = layerType === "PARCELS" ? sel.parcelId : sel.blockId;
  const props = layerType === "PARCELS"
    ? { parcel_name: sel.parcelName, block_name: sel.blockName, area_acres: sel.expectedAreaAcres }
    : { block_name: sel.blockName, area_acres: sel.expectedAreaAcres };
  return {
    getId: () => id,
    get: (key) => props[key],
    getGeometry: () => null
  };
}

/** Wires the Feature Info panel's footer "Log" split-button (Activity/Alert
 *  mode select) — opens the same Log Activity/Log Alert modals the map's
 *  own selection toolbar uses, targeting whatever block/plot the panel is
 *  currently showing (featureInfoSelection). Reuses the real clicked OL
 *  feature when it's the exact same one (so anything else that expects a
 *  genuine feature keeps working); falls back to makeFeatureInfoShim for a
 *  manual filter-bar pick. Disabled at estate-level (see
 *  renderFeatureInfoView) since there's no single block/plot to log
 *  against. The Download half of this footer is wired by
 *  js/feature-export.js's initFeatureExport. */
function setupFeatureInfoActionFooter() {
  const logMainBtn = document.getElementById("featureLogMainBtn");
  const logModeSelect = document.getElementById("featureLogModeSelect");

  logMainBtn?.addEventListener("click", () => {
    const sel = featureInfoSelection;
    if (!sel.blockId) return;

    const layerType = sel.parcelId ? "PARCELS" : "BLOCKS";
    const targetId = sel.parcelId || sel.blockId;
    const feature = (selectedFeature && selectedFeature.getId() === targetId && selectedLayerType === layerType)
      ? selectedFeature
      : makeFeatureInfoShim(layerType, sel);

    const mode = logModeSelect?.value === "alert" ? "alert" : "activity";
    if (mode === "alert") openLogAlertModal(feature, layerType);
    else openLogActivityModal(feature, layerType);
  });
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

// Estate boundary — a computed rectangular bbox (vsl_estate.geom, see
// vsl_recompute_estate_geometry() / trg_vsl_blocks_estate_geometry in the DB),
// drawn as a dotted outline with the estate name labeled above its top-right
// corner. Loaded once at boot from v_estate_boundaries (see loadEstateBoundaries()),
// not refetched on every pan/zoom like blocks/parcels — estate boundaries rarely change.
const estatesLayer = new ol.layer.Vector({
  title: "Estates",
  visible: true,
  declutter: false,
  // Explicit zIndex — decoupled from array order in overlaysGroup, whose
  // array order instead controls only the layer-switcher panel's row order
  // (ol-layerswitcher renders each group's children reversed; see the
  // comment on overlaysGroup below).
  zIndex: LAYER_Z.ESTATES,
  source: estatesSource,
  style: (feature) => {
    const geometry = feature.getGeometry();
    const styles = [
      new ol.style.Style({
        stroke: new ol.style.Stroke({ color: "#D76213", width: 2, lineDash: [2, 8], lineCap: "round" }),
        fill: new ol.style.Fill({ color: "rgba(0,0,0,0)" })
      })
    ];
    if (geometry) {
      const extent = geometry.getExtent();
      const topLeft = new ol.geom.Point([extent[0], extent[3]]);
      const name = String(feature.get("estate_name") ?? "").trim();
      if (name) {
        styles.push(new ol.style.Style({
          geometry: topLeft,
          text: new ol.style.Text({
            text: name,
            font: "700 13px Inter, sans-serif",
            fill: new ol.style.Fill({ color: "#D76213" }),
            stroke: new ol.style.Stroke({ color: "#ffffff", width: 3 }),
            textAlign: "left",
            textBaseline: "bottom",
            offsetY: -2,
            offsetX: 4
          })
        }));
      }
    }
    return styles;
  }
});

// Land Title boundary — same "#7b1fa2, dashed" symbol the "Land properties"
// group in buildLegendList()/print-tool.js already declares. Outline only,
// no fill (like estatesLayer), with the title's
// name + area centered inside the polygon (getFeatureInteriorPoint), matching
// how parcelsLayer anchors its own name/area label — not at a corner, since a
// corner collides with whatever Block/Plot label already occupies that spot.
const titlesLayer = new ol.layer.Vector({
  title: "Land Titles",
  visible: true,
  declutter: false,
  zIndex: LAYER_Z.TITLES,
  source: titlesSource,
  style: (feature) => {
    const geometry = feature.getGeometry();
    // Outline only — NO fill. A title boundary is meant to be read against
    // whatever Block/Plot fill sits underneath it, and any tint of its own
    // (however faint) muddies those status colours where titles overlap.
    // Kept fill-free in the PDF too (see drawTitleVector in print-tool.js).
    // Picked in the Select window's Feature tab — same orange "you chose
    // this" emphasis blocksLayer/parcelsLayer use for their own selections,
    // still fill-free so the land underneath stays readable.
    const isStatusHi =
      parcelStatusState.selectedLayerType === "TITLES" &&
      parcelStatusState.selectedFeatures.some((f) => String(f.getId()) === String(feature.getId()));
    const styles = [
      new ol.style.Style({
        stroke: isStatusHi
          ? new ol.style.Stroke({ color: "#ff6d00", width: 4, lineDash: [6, 5] })
          : new ol.style.Stroke({ color: "#7b1fa2", width: 2, lineDash: [6, 5] })
      })
    ];
    const interiorPoint = getFeatureInteriorPoint(geometry);
    const name = String(feature.get("title_name") ?? "").trim();
    if (interiorPoint) {
      const expArea = feature.get("area_acres");
      const area = expArea ? `${Number(expArea).toFixed(2)} ac` : surveyFeatureAreaAcresText(feature);
      const text = name && area ? `${name}\n${area}` : (name || area || "");
      if (text) {
        styles.push(new ol.style.Style({
          geometry: interiorPoint,
          text: new ol.style.Text({
            text,
            font: "700 12px Inter, sans-serif",
            fill: new ol.style.Fill({ color: "#7b1fa2" }),
            stroke: new ol.style.Stroke({ color: "#ffffff", width: 3 }),
            textAlign: "center",
            overflow: true,
            lineHeight: LABEL_LINE_HEIGHT
          })
        }));
      }
    }
    return styles;
  }
});

async function loadEstateBoundaries() {
  const { data, error } = await supabase.from("v_estate_boundaries").select("id, estate_name, geojson");
  if (error) {
    if (cfg.DEBUG_MAP_RPC && window.console?.debug) console.debug("[Victoria map] Estate boundary load failed:", error.message);
    return;
  }
  estatesSource.clear(true);
  const geojsonFmt = new ol.format.GeoJSON();
  const projOpts = { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" };
  for (const row of data || []) {
    if (!row.geojson) continue;
    let geom;
    try {
      geom = geojsonFmt.readGeometry(row.geojson, projOpts);
    } catch {
      continue;
    }
    const feature = new ol.Feature({ geometry: geom });
    feature.setId(row.id);
    feature.set("estate_name", row.estate_name, true);
    estatesSource.addFeature(feature);
  }
}

const blocksLayer = new ol.layer.Vector({
  title: "Blocks",
  visible: true,
  declutter: true,
  zIndex: LAYER_Z.BLOCKS,
  // Hidden below MAP_ZOOM.BLOCK. This also takes the layer out of
  // hit-testing at those zooms, which is what we want — you shouldn't be
  // able to click a block you can't see.
  minZoom: layerMinZoom(MAP_ZOOM.BLOCK),
  source: blocksSource,
  style: (feature, resolution) => {
    const bid = feature.getId();
    const isSearchHi = searchHighlight.blockId != null && bid != null && String(bid) === String(searchHighlight.blockId);
    const isStatusHi = parcelStatusState.selectedLayerType === "BLOCKS" && parcelStatusState.selectedFeatures.some(f => String(f.getId()) === String(bid));
    const hi = isSearchHi || isStatusHi;
    const zoom = zoomFromResolution(map?.getView?.(), resolution);

    // Blocks (like estates) carry no status fill — a block's state is the
    // mix of its plots', which draw their own colours. This near-invisible
    // fill only exists so clicks inside a block still hit it.
    const fillColor = "rgba(255, 255, 255, 0.05)";
    let strokeColor = "#d32f2f";
    // Thinner outline until the block's own name appears — before that a
    // block is context rather than the subject, and a heavy outline at that
    // zoom just crowds the estate boundaries.
    let strokeWidth = zoom < MAP_ZOOM.BLOCK_LABEL && !hi ? 1.5 : (hi ? 5 : 3);
    let textColor = "#d32f2f";

    let textStyle = null;
    // A highlighted block keeps its name at any zoom — if something has been
    // searched for or selected, naming it is the entire point.
    if (hi || zoom >= MAP_ZOOM.BLOCK_LABEL) {
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
  title: "Parcels",
  visible: true,
  declutter: true,
  zIndex: LAYER_Z.PLOTS,
  // Hidden below MAP_ZOOM.PLOT — blocks carry the map until then.
  minZoom: layerMinZoom(MAP_ZOOM.PLOT),
  source: parcelsSource,
  style: (feature, resolution) => {
    const pid = feature.getId();
    const isSearchHi = searchHighlight.parcelId != null && pid != null && String(pid) === String(searchHighlight.parcelId);
    const isStatusHi = parcelStatusState.selectedLayerType === "PARCELS" && parcelStatusState.selectedFeatures.some(f => String(f.getId()) === String(pid));
    const hi = isSearchHi || isStatusHi;
    const zoom = zoomFromResolution(map?.getView?.(), resolution);

    const status = feature.get("cultivation_status");
    let fillColor = "rgba(255, 255, 255, 0.05)";
    let strokeColor = "#2e7d32";
    let strokeWidth = zoom < MAP_ZOOM.PLOT_LABEL && !hi ? 1 : (hi ? 4 : 2);
    let textColor = "#2e7d32";

    if (status && CULTIVATION_PALETTE[status] && status !== "vacant") {
      fillColor = CULTIVATION_PALETTE[status].fill;
    }

    // An unresolved alert takes priority over the cultivation-status color
    // — _alert_severity is only set while at least one of this plot's
    // alerts is still open/investigating (see refreshParcelAlertBadges),
    // so this naturally clears itself once the alert is resolved.
    const alertSeverityForFill = feature.get("_alert_severity");
    if (alertSeverityForFill && ALERT_SEVERITY_FILL[alertSeverityForFill]) {
      fillColor = ALERT_SEVERITY_FILL[alertSeverityForFill];
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

    // NAME AND AREA ONLY — deliberately nothing else.
    //
    // This label used to also stack a "R:n" ratoon line and an "Alerts(n)"
    // line beneath it. Both were removed: they are states of the moment, and
    // a map gets printed and pinned to a wall. A ratoon number and an open
    // alert are both wrong within a season, while the plot's name and area
    // stay true for as long as the paper lasts. Both now live in the popup
    // you get by clicking the plot (renderParcelActionInfo), which is always
    // read live.
    const pLabel = feature.get("parcel_name") || feature.get("parcel_code");
    const label = pLabel != null && pLabel !== "" ? String(pLabel) : "—";

    // Anchor every text line at the same guaranteed-inside-the-polygon
    // point (rather than leaving geometry unset) so label/ratoon/alert text
    // is never at the mercy of OL's own default anchor-on-unset-geometry
    // behavior, which could diverge from this point on large/concave plots.
    const labelIp = getFeatureInteriorPoint(feature.getGeometry());

    let textStyle = null;
    // A highlighted plot keeps its label at any zoom, same as a block.
    if (hi || zoom >= MAP_ZOOM.PLOT_LABEL) {
      const expArea = feature.get("area_acres");
      const area = expArea ? `${Number(expArea).toFixed(2)} ac` : surveyFeatureAreaAcresText(feature);
      const text = area ? `${label}\n${area}` : label;

      const fontPx = hi ? 12 : 11;
      textStyle = new ol.style.Text({
        text,
        font: `${hi ? "700" : "600"} ${fontPx}px Inter, sans-serif`,
        fill: new ol.style.Fill({ color: hi ? "#f57f17" : textColor }),
        stroke: new ol.style.Stroke({ color: "#ffffff", width: hi ? 4 : 3 }),
        overflow: true,
        // Explicit rather than leaving it to whatever the canvas/OL would
        // pick, so estimateParcelLabelHalfHeightPx (which assumes this exact
        // multiplier when positioning the popup above the label) can't drift
        // out of sync with what's actually drawn.
        lineHeight: LABEL_LINE_HEIGHT
      });
    }

    // Polygon's second (colored) outline — kept on the feature's own
    // geometry (a Point geometry has nothing to stroke).
    styles.push(new ol.style.Style({
      stroke: new ol.style.Stroke({ color: hi ? "#f9a825" : strokeColor, width: strokeWidth })
    }));

    // Label text (and the alerts chip, if any) are their own Style objects,
    // explicitly anchored at labelIp rather than sharing the polygon-stroke
    // Style or falling back to OL's default text-anchor-on-unset-geometry
    // behavior.
    if (textStyle) {
      styles.push(new ol.style.Style({
        geometry: labelIp || undefined,
        text: textStyle
      }));
    }

    if (hi || zoom >= MAP_ZOOM.PLOT_DISTANCE) {
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

// No `title` set on purpose — ol-layerswitcher (v4.1.0) only renders a row
// for a layer/group that HAS a title (checks `lyr.get('title')`); there's no
// separate "hide from panel" flag in this library version, so the old
// `displayInLayerSwitcher` property used elsewhere in this file never
// actually did anything. Leaving title unset is what keeps this out of the
// Layers panel while the layer itself keeps working normally everywhere else.
const sketchLayer = new ol.layer.Vector({
  visible: true,
  source: editSource,
  style: new ol.style.Style({
    stroke: new ol.style.Stroke({ color: "#8d6a3a", width: 2, lineDash: [6, 4] }),
    fill: new ol.style.Fill({ color: "rgba(141, 106, 58, 0.15)" })
  })
});
sketchLayer.setZIndex(LAYER_Z.SKETCH);

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

// No `title` — see sketchLayer's comment above for why.
const measureLayer = new ol.layer.Vector({
  visible: true,
  source: measureSource,
  style: (feature) => {
    const k = feature.get("_measureKind");
    if (k === "distance") return buildLineMeasureStyles(feature);
    if (k === "area") return buildAreaMeasureStyles(feature);
    return [];
  }
});
measureLayer.setZIndex(LAYER_Z.MEASURE);

function createBasemapLayer(title, source, visible = false) {
  return new ol.layer.Tile({
    title,
    type: "base",
    visible,
    source
  });
}

function buildLayerTree() {
  const googleHybrid = createBasemapLayer("Google Satellite", new ol.source.XYZ({
    url: "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}",
    crossOrigin: "anonymous"
  }), false);
  const esriImagery = createBasemapLayer("Esri Imagery", new ol.source.XYZ({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    crossOrigin: "anonymous"
  }), true);
  const noBasemap = createBasemapLayer("No Basemap", new ol.source.XYZ({
    url: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
  }));

  // BASE MAPS Group
  const baseGroup = new ol.layer.Group({
    title: "BASE MAPS",
    fold: "open",
    layers: [googleHybrid, esriImagery, noBasemap],
    zIndex: LAYER_Z.BASEMAPS
  });
  baseGroupRef = baseGroup;

  // FEATURES Group — one row per custom feature TYPE actually drawn on the
  // map (trees, boreholes, roads, walls, …), each a lightweight PROXY layer
  // with an empty source: every real custom feature lives on ONE shared
  // layer (survey-draw.js's featuresLayer/featuresSource), so there is no
  // separate per-type layer to add/remove here. Toggling a proxy row's
  // visibility instead calls survey-draw.js's setFeatureTypeVisible(), which
  // hides that type's features via featuresLayer's own style function and
  // triggers a redraw — see rebuildFeaturesSwitcherGroup(). Starts empty;
  // populated once survey-draw.js has loaded features (see
  // onFeaturesRefreshed passed into initSurveyDraw).
  const featuresGroup = new ol.layer.Group({
    title: "FEATURES",
    fold: "close",
    layers: []
  });
  featuresGroupRef = featuresGroup;

  // DRONE IMAGES Group — filled at runtime by js/drone-tiles.js, which reads
  // the surveys out of the tile bucket and pushes one child per survey.
  //
  // Each child is itself a foldable group holding that survey's per-site
  // .pmtiles layers. The survey group is type "base", so surveys render as
  // radio buttons and picking one swaps every site to that year at once —
  // the year-to-year comparison the surveyors actually want. Its children
  // set no type, so each site is a tick box and can be turned off on its own.
  // Starts empty; a failed or still-loading fetch just leaves it with no rows.
  //
  // A group's zIndex only reaches children that set none of their own, so
  // overlaysGroup's value never gets as far as Estates/Blocks/Plots/Titles
  // — those four carry their own. Every value lives in LAYER_Z at the top
  // of this file.
  const droneGroup = new ol.layer.Group({
    title: "DRONE IMAGES",
    fold: "open",
    layers: [],
    zIndex: LAYER_Z.DRONE
  });
  droneImagesGroupRef = droneGroup;

  // SENTINEL Group (Radio buttons via type='base-group')
  const sentinelGroup = new ol.layer.Group({
    title: "SENTINEL",
    fold: "open",
    // We do NOT set combine: true so it shows children.
    // By setting type to "base-group" or having children with type="base" 
    // ol-layerswitcher will render them as radio buttons.
    layers: [],
    zIndex: LAYER_Z.SENTINEL
  });
  sentinelGroupRef = sentinelGroup;

  // LAND LAYERS Group
  // ol-layerswitcher renders every group's children in REVERSE array order
  // (LayerSwitcher.reverse defaults to true), so this array is deliberately
  // the opposite of the desired panel order — panel top-to-bottom reads
  // Estates, Blocks, Plots, Land titles. Actual map stacking is controlled
  // independently via each layer's own explicit zIndex (see their
  // definitions above), not by this array's order.
  const overlaysGroup = new ol.layer.Group({
    title: "LAND LAYERS",
    fold: "open",
    layers: [titlesLayer, parcelsLayer, blocksLayer, estatesLayer]
  });
  overlaysGroup.setZIndex(LAYER_Z.OVERLAYS);

  // ANNOTATIONS Group — deliberately has no `title`, which is what actually
  // keeps a group (and, since ol-layerswitcher never recurses into an
  // untitled group's children, both sketchLayer and measureLayer inside it
  // too) out of the Layers panel in this library version — see the comment
  // on sketchLayer's definition above for why the old `displayInLayerSwitcher`
  // property didn't work. The layers themselves stay active on the map; the
  // Draw/Measure tools work exactly as before, they just don't show up as
  // toggleable rows in the switcher.
  const annotationsGroup = new ol.layer.Group({
    fold: "open",
    layers: [sketchLayer, measureLayer]
  });
  annotationsGroup.setZIndex(LAYER_Z.ANNOTATIONS);
  annotationsGroupRef = annotationsGroup;

  // Order on map (bottom to top). Layer switcher shows reverse (top to bottom).
  // 1. featuresGroup (proxy-only, empty sources — placement here is purely
  //    to land it as the LAST/bottom row in the switcher, directly below
  //    BASE MAPS; it has no effect on actual map stacking)
  // 2. baseGroup
  // 3. droneGroup
  // 4. sentinelGroup
  // 5. overlaysGroup (Survey Layers)
  // 6. annotationsGroup
  const stack = [featuresGroup, baseGroup];
  stack.push(droneGroup, sentinelGroup, overlaysGroup, annotationsGroup);
  
  return stack;
}

/** Repopulates the FEATURES group with one proxy row per feature type
 *  currently used on the map, reading from survey-draw.js's
 *  getUsedFeatureTypes(). Called via onFeaturesRefreshed, so it always runs
 *  right after featuresSource itself has just been refreshed (boot, Draw tab
 *  save, Manage Features CRUD, …) — never on stale data. Existing proxy rows
 *  are torn down and rebuilt from scratch each time rather than diffed —
 *  the list is short (one row per type in use, typically well under 20) so
 *  this is cheap, and it trivially handles types being renamed/recolored/
 *  removed without needing to reconcile a diff.
 */
function rebuildFeaturesSwitcherGroup() {
  if (!featuresGroupRef) return;
  const types = surveyDrawApi?.getUsedFeatureTypes?.() || [];
  const collection = featuresGroupRef.getLayers();
  collection.clear();
  types.forEach((t) => {
    const proxyLayer = new ol.layer.Vector({
      title: t.name,
      visible: true,
      source: new ol.source.Vector()
    });
    proxyLayer.on("change:visible", () => {
      surveyDrawApi?.setFeatureTypeVisible?.(t.id, proxyLayer.getVisible());
    });
    collection.push(proxyLayer);
  });
  if (typeof layerSwitcherRef?.renderPanel === "function") {
    layerSwitcherRef.renderPanel();
  }
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

/** Reads the toggle's own state (aria-checked, not .checked — it's a
 *  <button role="switch"> now, not a checkbox). Snapping no longer has
 *  per-layer granularity: master on means "snap to every snappable layer",
 *  master off means none of them. */
function isSnapMasterOn() {
  return snapMasterCb ? snapMasterCb.getAttribute("aria-checked") !== "false" : true;
}
// Exposed so survey-draw.js/survey-edit.js (which own a couple of raw
// ol.interaction.Snap instances of their own — custom-feature and
// in-session pending-shape snapping, neither routed through
// attachSnapInteractions below) can gate those on the same switch instead
// of arming them unconditionally regardless of it.
window.vslIsSnapMasterOn = isSnapMasterOn;

/** Writes both the a11y state and the visual .snap-toggle--on class in one
 *  place, so nothing can update one without the other. */
function setSnapMasterOn(on) {
  if (!snapMasterCb) return;
  snapMasterCb.setAttribute("aria-checked", on ? "true" : "false");
  snapMasterCb.classList.toggle("snap-toggle--on", on);
}

function readSnapOptions() {
  const on = isSnapMasterOn();
  return { snapBlocks: on, snapParcels: on, snapSurvey: on };
}

/** True while a snapping-capable tool is live. Deliberately keyed on
 *  lastSnapOptions rather than activeSnapInteractions.length: with the
 *  master off a live drawing tool has zero Snap interactions, and turning
 *  it on should still take effect on the next click rather than only after
 *  the tool is restarted. Null means no tool is running, so a toggle change
 *  must not arm snapping on an idle map. */
function snapInteractionsActive() {
  return lastSnapOptions !== null;
}

/** Shows the floating Snap widget — called only while an editing-capable
 *  tool is actually live (Measure pick mode, Draw/Edit tab sessions; see
 *  their own call sites). Also exposed on window so survey-draw.js/
 *  survey-edit.js, which don't import map-app.js, can call it directly. */
function showSnapFab() {
  const panel = document.getElementById("snapPanel");
  if (panel) panel.hidden = false;
}

/** Hides the floating Snap widget when its editing-capable tool ends, and —
 *  per spec — unconditionally forces the master toggle back ON first, even
 *  if the user had just switched it off. That's deliberate: it stops
 *  snapping being silently left disabled the next time some other tool
 *  starts, from a toggle the user has no way to see or remember they
 *  touched once this widget is gone. */
function hideSnapFab() {
  setSnapMasterOn(true);
  if (snapInteractionsActive()) {
    if (lastSnapOptions?.snapAllVisible) attachSnapInteractions({ snapAllVisible: true });
    else attachSnapInteractions(readSnapOptions());
  }
  const panel = document.getElementById("snapPanel");
  if (panel) panel.hidden = true;
}
window.vslShowSnapFab = showSnapFab;
window.vslHideSnapFab = hideSnapFab;

/** "Drafting mode" — the one place that owns every behavior common to a
 *  tool that lets the user click on the map to place vertices (Measure
 *  pick mode, the Draw tab, the Edit tab). Previously each of these grew
 *  its own ad hoc bits of this — some set a crosshair cursor, some didn't;
 *  none hid the floating button stacks — so it drifted inconsistent. Any
 *  future shared drafting behavior belongs here, not back in each tool.
 *  Exposed on window so survey-draw.js/survey-edit.js, which don't import
 *  map-app.js, can call it directly (same pattern as vslShowSnapFab).
 *
 *  `undoFn`, if given, is stored as window.vslDraftingUndo — what the Snap
 *  widget's Undo button calls (see setupSnapPanel()). Optional: the Edit
 *  tab has no equivalent of "undo the last placed vertex" (it edits
 *  existing geometry rather than sketching new), so it enters drafting mode
 *  without one and the button is simply a no-op while Edit is live.
 *
 *  `snapSyncFn`, if given, is stored as window.vslDraftingSnapSync — called
 *  with the new on/off state whenever the Snap toggle is flipped while this
 *  tool is live (see setupSnapPanel()'s click handler), so a tool's own
 *  extra Snap interactions (custom-feature/pending-shape snapping in
 *  survey-draw.js/survey-edit.js — neither routed through
 *  attachSnapInteractions below) stay in step with the toggle instead of
 *  only reacting to it the next time the tool restarts. */
function enterDraftingMode(undoFn, snapSyncFn) {
  const mapEl = document.getElementById("map");
  if (mapEl) mapEl.style.cursor = "crosshair";
  showSnapFab();
  document.getElementById("mapLeftBtnStack")?.setAttribute("hidden", "");
  document.getElementById("mapRightBtnStack")?.setAttribute("hidden", "");
  window.vslDraftingUndo = typeof undoFn === "function" ? undoFn : null;
  window.vslDraftingSnapSync = typeof snapSyncFn === "function" ? snapSyncFn : null;
}

function exitDraftingMode() {
  const mapEl = document.getElementById("map");
  if (mapEl) mapEl.style.cursor = "";
  hideSnapFab();
  document.getElementById("mapLeftBtnStack")?.removeAttribute("hidden");
  document.getElementById("mapRightBtnStack")?.removeAttribute("hidden");
  window.vslDraftingUndo = null;
  window.vslDraftingSnapSync = null;
}
window.vslEnterDraftingMode = enterDraftingMode;
window.vslExitDraftingMode = exitDraftingMode;

function setupSnapPanel() {
  document.getElementById("snapFabUndoBtn")?.addEventListener("click", () => {
    window.vslDraftingUndo?.();
  });

  setSnapMasterOn(isSnapMasterOn());
  snapMasterCb?.addEventListener("click", () => {
    const next = !isSnapMasterOn();
    setSnapMasterOn(next);
    // The live tool's own extra Snap interactions (Draw/Edit tabs' custom-
    // feature/pending-shape snapping) aren't part of attachSnapInteractions
    // below — sync them separately so toggling mid-session actually takes
    // effect immediately instead of only on the next Start.
    window.vslDraftingSnapSync?.(next);
    // Only re-arm a tool that was already snapping (see
    // snapInteractionsActive) — never start snapping on an idle map.
    if (!snapInteractionsActive()) return;
    if (lastSnapOptions?.snapAllVisible) {
      // Measure snaps to everything visible; the master switch still turns
      // it off entirely.
      if (next) attachSnapInteractions({ snapAllVisible: true });
      else detachSnapInteractions({ keepMode: true });
    } else if (next) {
      attachSnapInteractions(readSnapOptions());
    } else {
      detachSnapInteractions({ keepMode: true });
    }
  });
}

/** The opts object the live snap interactions were built from — see
 *  attachSnapInteractions. Null whenever nothing is snapping. */
let lastSnapOptions = null;

/** `keepMode` is for attachSnapInteractions' own internal clear-then-rebuild
 *  — a rebuild isn't a disarm, so it must not forget which mode is live.
 *  Every external caller is a genuine "stop snapping", and clears it. */
function detachSnapInteractions({ keepMode = false } = {}) {
  if (!keepMode) lastSnapOptions = null;
  if (!map) return;
  for (const s of activeSnapInteractions) {
    map.removeInteraction(s);
  }
  activeSnapInteractions = [];
}

function attachSnapInteractions(opts) {
  try {
    detachSnapInteractions({ keepMode: true });
    if (!map || !opts) return;
    // Remembered so setupSnapPanel() can re-arm mid-tool in whichever mode
    // the active tool asked for: the Measure tool snaps to every visible
    // layer, drawing snaps to just the ticked ones.
    lastSnapOptions = opts;
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
  return parcelStatusState.tabMode || "PARCELS";
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

/** Only Admin/Surveyor may modify or delete land records, so the Select
 *  window's whole ACTION column is theirs alone. */
function canModifyLand() {
  return currentProfile?.role === "ADMIN" || currentProfile?.role === "SURVEYOR";
}

function renderParcelStatusPreview() {
  const selectionLabel = document.getElementById("parcelStatusSelectionLabel");
  const actionsRow = document.getElementById("parcelStatusActionsRow");
  const actionCol = document.getElementById("parcelStatusActionCol");
  const features = parcelStatusState.selectedFeatures;
  const isFeatureTab = parcelStatusState.selectedLayerType === "FEATURES";
  const isTitleTab = parcelStatusState.selectedLayerType === "TITLES";
  const hasSelection = !!features?.length;

  if (!hasSelection) {
    if (selectionLabel) selectionLabel.textContent = "Select on map";
  } else if (isTitleTab) {
    // Titles are named legal parcels — name the one that's picked, same as
    // a drawn feature, rather than counting an anonymous selection.
    if (selectionLabel) {
      selectionLabel.textContent =
        features.length === 1
          ? `${features[0].get("title_name") || "Land Title"} · Title`
          : `Selection: ${features.length} land titles`;
    }
  } else if (isFeatureTab) {
    // Drawn features are individually named things rather than a numbered
    // grid, so name what's picked instead of just counting it.
    if (selectionLabel) {
      selectionLabel.textContent =
        features.length === 1
          ? `${features[0].get("_name") || features[0].get("_typeName") || "Feature"}` +
            (features[0].get("_typeName") ? ` · ${features[0].get("_typeName")}` : "")
          : `Selection: ${features.length} features`;
    }
  } else {
    if (selectionLabel) selectionLabel.textContent = `Selection: ${features.length}`;
  }

  // Modify/Delete: any selection, but Admin/Surveyor only.
  if (actionCol) actionCol.hidden = !hasSelection || !canModifyLand();

  // Log Activity/Alert: plots and blocks only — neither a drawn feature nor
  // a land title has cultivation activity or an agronomic alert to log
  // against it (a title is a legal boundary, not a growing area).
  if (actionsRow) actionsRow.hidden = !hasSelection || isFeatureTab || isTitleTab;
}

// ---------------------------------------------------------------------------
// Select window > Modify — a small popup form (popups/popup.js promptFields)
// rather than a full modal, holding just the handful of properties that are
// actually re-assignable per record type:
//
//   Block   — name, estate
//   Plot    — name, estate, block
//   Feature — name, description
//
// Cultivation status/harvest live in the Edit Details modal; geometry lives
// in the Survey window's Edit tab. This is only about identity/parentage.
// ---------------------------------------------------------------------------

/** id/name option lists for the parent dropdowns, fetched per open so a
 *  block or estate added since page load is offered. */
async function fetchEstateOptions() {
  const { data } = await supabase
    .from("vsl_estate").select("id, estate_name").order("estate_name", { ascending: true });
  return (data || []).map((e) => ({ value: String(e.id), label: e.estate_name || `Estate ${e.id}` }));
}

async function fetchBlockOptions(estateId) {
  let q = supabase.from("vsl_blocks").select("id, block_name, estate_id");
  if (estateId) q = q.eq("estate_id", estateId);
  const { data } = await q.order("block_name", { ascending: true });
  return (data || []).map((b) => ({ value: String(b.id), label: b.block_name || `Block ${b.id}` }));
}

/** An OL geometry type mapped to the vsl_feature_type.geometry_kind
 *  vocabulary. Used to keep a feature's retyping options to its own kind. */
function geometryKindOf(feature) {
  const t = feature?.getGeometry?.()?.getType() || "";
  if (t === "Point" || t === "MultiPoint") return "point";
  if (t === "LineString" || t === "MultiLineString") return "line";
  return "polygon";
}

/** Every active feature type of one geometry kind, as dropdown options —
 *  what a selected feature is allowed to be retyped to. */
async function fetchFeatureTypeOptions(kind) {
  const { data } = await supabase
    .from("vsl_feature_type")
    .select("id, name, code")
    .eq("geometry_kind", kind)
    .eq("is_active", true)
    .order("code", { ascending: true });
  return (data || []).map((t) => ({ value: String(t.id), label: `${t.name} (${t.code})` }));
}

/** Ratoon cycle options for the Modify popup — 0 (plant crop) through 5. */
const RATOON_OPTIONS = [0, 1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: String(n) }));

/** Cultivation status options, straight off the shared label map so this
 *  can't drift from the map styling or the legend. */
function cultivationStatusOptions() {
  return Object.keys(CULTIVATION_STATUS_LABELS).map((k) => ({
    value: k,
    label: CULTIVATION_STATUS_LABELS[k]
  }));
}

/** Value shared by every selected row, or "" when they differ — so a
 *  multi-selection starts on the common value where there is one and on
 *  blank where there isn't, instead of silently showing the first row's. */
function sharedValue(rows, key) {
  if (!rows.length) return "";
  const first = rows[0]?.[key];
  return rows.every((r) => r?.[key] === first) ? String(first ?? "") : "";
}

/**
 * The Select window's Modify action.
 *
 * Works on several records at once. Only fields the user actually CHANGED
 * are written — a blank "mixed" dropdown left alone therefore leaves each
 * record's own value intact, rather than flattening them all to one. The
 * name is per-record by definition, so it's disabled (and skipped) as soon
 * as more than one row is selected.
 */
async function openModifySelectedPopup() {
  const features = parcelStatusState.selectedFeatures;
  const lt = parcelStatusState.selectedLayerType;
  if (!features?.length || !lt) return;

  if (!canModifyLand()) {
    setParcelStatusFormError("Only Admin or Surveyor can modify records.");
    return;
  }
  setParcelStatusFormError("");

  const ids = features.map((f) => f.getId());
  const many = ids.length > 1;
  // Shown IN the disabled name box for a multi-selection. It's also what
  // `initial.name` is set to below, so patchFrom sees no change and this
  // placeholder can never be written to the records as an actual name.
  const NAME_MULTI = "Multiple editing";

  /** Applies only what changed, to every selected row. */
  const patchFrom = (result, initial, map) => {
    const patch = {};
    Object.entries(map).forEach(([field, key]) => {
      if (result[key] === undefined) return;
      if (String(result[key]) === String(initial[key] ?? "")) return; // untouched
      patch[field] = result[key] === "" ? null : result[key];
    });
    return patch;
  };

  try {
    if (lt === "TITLES") {
      // A title carries only its name and the acreage the deed states —
      // there's no estate/block parentage to reassign (a title is never
      // linked to one; see the vsl_title comment above titlesLayer).
      const { data: rows } = await supabase
        .from("vsl_title").select("id, title_name, area_acres").in("id", ids);
      const list = rows || [];
      const initial = {
        title_name: many ? NAME_MULTI : String(list[0]?.title_name ?? ""),
        area_acres: many ? "" : String(list[0]?.area_acres ?? "")
      };
      const result = await promptFields({
        title: many ? `Modify ${ids.length} Land Titles` : "Modify Land Title",
        icon: "fa-pen",
        fields: [
          { key: "title_name", label: "Title name", type: "text", value: initial.title_name,
            required: !many, disabled: many },
          { key: "area_acres", label: "Titled area (acres)", type: "text",
            value: initial.area_acres, placeholder: "e.g. 42.5" }
        ]
      });
      if (!result) return;
      const patch = patchFrom(result, initial, {
        title_name: "title_name", area_acres: "area_acres"
      });
      if (many) delete patch.title_name; // never bulk-rename
      if (patch.area_acres !== undefined && patch.area_acres !== null) {
        const acres = Number(patch.area_acres);
        if (!Number.isFinite(acres) || acres < 0) {
          setParcelStatusFormError("Titled area must be a positive number.");
          return;
        }
        patch.area_acres = acres;
      }
      if (!Object.keys(patch).length) return;
      const { error } = await supabase.from("vsl_title").update(patch).in("id", ids);
      if (error) throw error;
      setStatus(statusEl, `Updated ${ids.length} land title(s).`);
      clearParcelStatusSelection();
      await loadLayersFromDb();
      return;
    }

    if (lt === "FEATURES") {
      // Retyping is only offered when everything selected is the same
      // geometry kind. A point type can't be applied to a line — the
      // geometry wouldn't match how that type is drawn, and the code bands
      // (1-99 point, 100-199 line, 200-299 polygon) exist precisely to keep
      // those separate. Mixed selections therefore get name/description
      // only, with a line explaining why.
      const kinds = new Set(features.map((f) => geometryKindOf(f)));
      const oneKind = kinds.size === 1 ? [...kinds][0] : null;
      const typeOptions = oneKind ? await fetchFeatureTypeOptions(oneKind) : [];
      const sharedTypeId = sharedValue(
        features.map((f) => ({ feature_type_id: f.get("_typeId") })),
        "feature_type_id"
      );

      const initial = {
        name: many ? NAME_MULTI : String(features[0].get("_name") ?? ""),
        description: many ? "" : String(features[0].get("_description") ?? ""),
        feature_type_id: sharedTypeId
      };
      const fields = [
        { key: "name", label: "Name", type: "text", value: initial.name,
          required: false, disabled: many },
        { key: "description", label: "Description", type: "textarea", value: initial.description }
      ];
      if (oneKind && typeOptions.length) {
        fields.push({
          key: "feature_type_id", label: "Type", type: "select", value: initial.feature_type_id,
          options: [{ value: "", label: many && !sharedTypeId ? "— Mixed types —" : "— Type —" }, ...typeOptions]
        });
      }

      const result = await promptFields({
        title: many ? `Modify ${ids.length} Features` : "Modify Feature",
        message: oneKind ? undefined : "Mixed point/line/polygon selection — select one kind at a time to change the type.",
        icon: "fa-pen",
        fields
      });
      if (!result) return;
      const patch = patchFrom(result, initial, {
        name: "name", description: "description", feature_type_id: "feature_type_id"
      });
      if (many) delete patch.name; // never bulk-rename
      if (!Object.keys(patch).length) return;
      const { error } = await supabase.from("vsl_feature").update(patch).in("id", ids);
      if (error) throw error;
      features.forEach((f) => {
        if (patch.name !== undefined) f.set("_name", patch.name);
        if (patch.description !== undefined) f.set("_description", patch.description);
      });
      // A type change rewrites colour, icon, line style and labels, none of
      // which live on the feature row — so the layer is reloaded rather than
      // patched in place.
      if (patch.feature_type_id !== undefined) {
        await surveyDrawApi?.refreshFeaturesLayer?.();
      }
      window.dispatchEvent(new CustomEvent("vsl-features-changed"));
      setStatus(statusEl, `Updated ${ids.length} feature(s).`);
      renderParcelStatusPreview();
      return;
    }

    const estateOptions = await fetchEstateOptions();

    if (lt === "BLOCKS") {
      const { data: rows } = await supabase
        .from("vsl_blocks").select("id, block_name, estate_id").in("id", ids);
      const list = rows || [];
      const initial = {
        block_name: many ? NAME_MULTI : String(list[0]?.block_name ?? ""),
        estate_id: sharedValue(list, "estate_id")
      };
      const result = await promptFields({
        title: many ? `Modify ${ids.length} Blocks` : "Modify Block",
        icon: "fa-pen",
        fields: [
          { key: "block_name", label: "Block name", type: "text", value: initial.block_name,
            required: !many, disabled: many },
          { key: "estate_id", label: "Estate", type: "select", value: initial.estate_id,
            options: [{ value: "", label: "— Estate —" }, ...estateOptions] }
        ]
      });
      if (!result) return;
      const patch = patchFrom(result, initial, { block_name: "block_name", estate_id: "estate_id" });
      if (many) delete patch.block_name;
      if (!Object.keys(patch).length) return;
      const { error } = await supabase.from("vsl_blocks").update(patch).in("id", ids);
      if (error) throw error;
      setStatus(statusEl, `Updated ${ids.length} block(s).`);
    } else {
      const { data: rows } = await supabase
        .from("vsl_parcels")
        .select("id, parcel_name, block_id, cultivation_status, ratoon_number")
        .in("id", ids);
      const list = rows || [];

      // A plot's estate is its block's estate — offered here so plots can
      // be moved wholesale, with the block list filtered to match whichever
      // estate they currently share (all blocks when they're mixed).
      const blockIds = [...new Set(list.map((r) => r.block_id).filter(Boolean))];
      const { data: blockRows } = blockIds.length
        ? await supabase.from("vsl_blocks").select("id, estate_id").in("id", blockIds)
        : { data: [] };
      const sharedEstate = sharedValue(blockRows || [], "estate_id");
      const blockOptions = await fetchBlockOptions(sharedEstate || null);

      const initial = {
        parcel_name: many ? NAME_MULTI : String(list[0]?.parcel_name ?? ""),
        estate_id: sharedEstate,
        block_id: sharedValue(list, "block_id"),
        cultivation_status: sharedValue(list, "cultivation_status"),
        ratoon_number: sharedValue(list, "ratoon_number")
      };

      const result = await promptFields({
        title: many ? `Modify ${ids.length} Plots` : "Modify Plot",
        icon: "fa-pen",
        fields: [
          { key: "parcel_name", label: "Plot name", type: "text", value: initial.parcel_name,
            required: !many, disabled: many },
          // Estate and Block share a line.
          { key: "estate_id", label: "Estate", type: "select", half: true, value: initial.estate_id,
            options: [{ value: "", label: "— Estate —" }, ...estateOptions] },
          { key: "block_id", label: "Block", type: "select", half: true, value: initial.block_id,
            options: [{ value: "", label: "— Block —" }, ...blockOptions] },
          { key: "cultivation_status", label: "Status", type: "select", half: true,
            value: initial.cultivation_status,
            options: [{ value: "", label: "— Status —" }, ...cultivationStatusOptions()] },
          { key: "ratoon_number", label: "Ratoon", type: "select", half: true,
            value: initial.ratoon_number,
            options: [{ value: "", label: "— Ratoon —" }, ...RATOON_OPTIONS] }
        ]
      });
      if (!result) return;

      const patch = patchFrom(result, initial, {
        parcel_name: "parcel_name",
        block_id: "block_id",
        cultivation_status: "cultivation_status",
        ratoon_number: "ratoon_number"
      });
      if (many) delete patch.parcel_name;
      // estate_id isn't a column on vsl_parcels — it's implied by the block,
      // so changing it only matters through the block picked alongside it.
      if (patch.ratoon_number != null) patch.ratoon_number = Number(patch.ratoon_number);
      if (!Object.keys(patch).length) return;

      const { error } = await supabase.from("vsl_parcels").update(patch).in("id", ids);
      if (error) throw error;
      setStatus(statusEl, `Updated ${ids.length} plot(s).`);
    }

    clearParcelStatusSelection();
    await loadLayersFromDb();
  } catch (err) {
    setParcelStatusFormError(err?.message || "Couldn't save the change.");
  }
}

/** Deletes the selected drawn features (vsl_feature). Unlike a block, a
 *  feature has nothing hanging off it, so there's no linked-records guard —
 *  just the confirmation. */
async function deleteSelectedFeatures() {
  const features = parcelStatusState.selectedFeatures;
  if (!features?.length) return;
  if (!isAuthenticated || !currentUser?.id || currentUser.id === "guest") {
    setParcelStatusFormError("Sign in to delete features.");
    return;
  }
  if (currentProfile?.role !== "ADMIN" && currentProfile?.role !== "SURVEYOR") {
    setParcelStatusFormError("Only Admin or Surveyor can delete features.");
    return;
  }

  const confirmed = await confirmDanger({
    title: `Delete ${features.length} feature${features.length > 1 ? "s" : ""}`,
    message: `You are about to permanently delete ${features.length} drawn feature(s). This action cannot be undone.`,
    confirmLabel: "Delete"
  });
  if (!confirmed) return;

  setParcelStatusFormError("");
  setParcelStatusBusy(true, `Deleting ${features.length} feature(s)…`);
  let errorCount = 0;
  for (const f of features) {
    const { error } = await supabase.from("vsl_feature").delete().eq("id", f.getId());
    if (error) errorCount++;
  }
  setParcelStatusBusy(false);

  if (errorCount) {
    setParcelStatusFormError(`Failed to delete ${errorCount} of ${features.length} feature(s).`);
    return;
  }
  setStatus(statusEl, `Deleted ${features.length} feature(s).`);
  clearParcelStatusSelection();
  await surveyDrawApi?.refreshFeaturesLayer?.();
  window.dispatchEvent(new CustomEvent("vsl-features-changed"));
}

/** Deletes the selected Land Titles (vsl_title). Titles are standalone legal
 *  boundaries — nothing is keyed to them the way plots are keyed to a block —
 *  so, like a drawn feature, there's no linked-records guard, just the
 *  confirmation. */
async function deleteSelectedTitles() {
  const features = parcelStatusState.selectedFeatures;
  if (!features?.length) return;
  if (!isAuthenticated || !currentUser?.id || currentUser.id === "guest") {
    setParcelStatusFormError("Sign in to delete land titles.");
    return;
  }
  if (!canModifyLand()) {
    setParcelStatusFormError("Only Admin or Surveyor can delete land titles.");
    return;
  }

  const confirmed = await confirmDanger({
    title: `Delete ${features.length} land title${features.length > 1 ? "s" : ""}`,
    message: `You are about to permanently delete ${features.length} land title(s). This action cannot be undone.`,
    confirmLabel: "Delete"
  });
  if (!confirmed) return;

  setParcelStatusFormError("");
  setParcelStatusBusy(true, `Deleting ${features.length} land title(s)…`);
  const ids = features.map((f) => f.getId());
  let errorCount = 0;
  for (const id of ids) {
    const { error } = await supabase.from("vsl_title").delete().eq("id", id);
    if (error) errorCount++;
  }
  setParcelStatusBusy(false);

  if (errorCount) {
    setParcelStatusFormError(`Failed to delete ${errorCount} of ${features.length} land title(s).`);
    return;
  }
  setStatus(statusEl, `Deleted ${features.length} land title(s).`);
  clearParcelStatusSelection();
  await loadLayersFromDb();
}

function clearParcelStatusSelection() {
  parcelStatusState.selectedFeatures = [];
  parcelStatusState.selectedLayerType = null;
  blocksLayer.changed();
  parcelsLayer.changed();
  titlesLayer.changed();
  surveyDrawApi?.setHighlightedFeatures?.([]);
  renderParcelStatusPreview();
}

function closeParcelStatusPanel() {
  window.vslClosePrintPanel?.();
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
  window.vslClosePrintPanel?.();
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

  if (mode === "FEATURE") {
    // "Feature" tab — the drawn features (vsl_feature: trees, roads, walls,
    // …) on survey-draw.js's own layer PLUS Land Titles (vsl_title, on
    // titlesLayer). Neither is a plot or a block, so neither has a tab of
    // its own; they share this one. Drawn features are hit-tested first
    // because a title is a large background polygon that would otherwise
    // swallow every click on a tree standing inside it.
    const featuresLayer = surveyDrawApi?.getFeaturesLayer?.();
    if (featuresLayer) {
      map.forEachFeatureAtPixel(
        evt.pixel,
        (feature) => {
          hit = feature;
          return true;
        },
        { ...hitOpts, layerFilter: (layer) => layer === featuresLayer }
      );
    }
    if (hit) {
      layerHit = "FEATURES";
    } else {
      map.forEachFeatureAtPixel(
        evt.pixel,
        (feature) => {
          hit = feature;
          return true;
        },
        { ...hitOpts, layerFilter: (layer) => layer === titlesLayer }
      );
      if (hit) layerHit = "TITLES";
    }
  } else if (mode === "PARCELS") {
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
    const label = mode === "FEATURE" ? "drawn feature" : mode === "PARCELS" ? "parcel" : "block";
    setStatus(
      statusEl,
      mode === "FEATURE" ? "Click a drawn feature or a land title." : `Click a ${label} polygon.`,
      true
    );
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
  titlesLayer.changed();
  syncFeatureSelectionHighlight();
  return true;
}

/** Drawn features don't live on blocksLayer/parcelsLayer, so their
 *  "you picked this" emphasis can't come from those layers' style
 *  functions — it goes through survey-draw.js's own highlight hook, the
 *  same one the Search window's Feature tab uses. */
function syncFeatureSelectionHighlight() {
  if (!surveyDrawApi?.setHighlightedFeatures) return;
  const ids =
    parcelStatusState.selectedLayerType === "FEATURES"
      ? parcelStatusState.selectedFeatures.map((f) => f.getId())
      : [];
  surveyDrawApi.setHighlightedFeatures(ids);
}

/** Busy overlay covering the Select window's body while Delete is in
 *  flight — same generic pattern as Survey's #surveyBusyOverlay/
 *  window.vslSurveyBusy (survey-panel.html / survey-edit.js), just scoped
 *  to this window's own overlay element instead of sharing that one. */
function setParcelStatusBusy(on, text) {
  const overlay = document.getElementById("parcelStatusBusyOverlay");
  const textEl = document.getElementById("parcelStatusBusyOverlayText");
  if (!overlay) return;
  if (textEl && text) textEl.textContent = text;
  overlay.hidden = !on;
}

function setupParcelStatusPanel() {
  const toolbarBtn = document.getElementById("parcelStatusBtn");
  const closeBtn = document.getElementById("parcelStatusCloseBtn");
  const modifyBtn = document.getElementById("parcelStatusModifyBtn");
  const deleteBtn = document.getElementById("parcelStatusDeleteBtn");
  
  const tabParcels = document.getElementById("modifyTabParcels");
  const tabBlocks = document.getElementById("modifyTabBlocks");
  const tabFeature = document.getElementById("modifyTabFeature");

  deleteBtn?.addEventListener("click", async () => {
    const features = parcelStatusState.selectedFeatures;
    const lt = parcelStatusState.selectedLayerType;
    if (!features || features.length === 0 || !lt) return;

    // Drawn features live in their own table with their own guards.
    if (lt === "FEATURES") {
      await deleteSelectedFeatures();
      return;
    }
    if (lt === "TITLES") {
      await deleteSelectedTitles();
      return;
    }

    if (!isAuthenticated || !currentUser?.id || currentUser.id === "guest") {
      setParcelStatusFormError("Sign in to delete features.");
      return;
    }
    if (currentProfile?.role !== "ADMIN" && currentProfile?.role !== "SURVEYOR") {
      setParcelStatusFormError("Only Admin or Surveyor can delete features.");
      return;
    }

    const modeName = lt === "BLOCKS" ? "block" : "parcel";
    const ids = features.map(f => f.getId());

    // A block with linked plots can't be deleted (FK constraint) — same
    // guard/message as Survey > Estates deleting an estate with linked
    // blocks (see manage-estates.js's confirmDanger call).
    if (lt === "BLOCKS") {
      const { count, error: countError } = await supabase
        .from("vsl_parcels")
        .select("id", { count: "exact", head: true })
        .in("block_id", ids);
      if (!countError && count > 0) {
        await confirmDanger({
          title: "Can't Delete Block",
          message: "You can not delete a block with linked Plots, manually delete the linked plots first."
        });
        return;
      }
    }

    const confirmed = await confirmDanger({
      title: `Delete ${features.length} ${modeName}${features.length > 1 ? "s" : ""}`,
      message: `You are about to permanently delete ${features.length} ${modeName}(s). This action cannot be undone.`,
      confirmLabel: "Delete"
    });
    if (!confirmed) return;

    deleteBtn.disabled = true;
    setParcelStatusFormError("");
    setParcelStatusBusy(true, `Deleting ${features.length} ${modeName}(s)…`);

    const tableName = lt === "BLOCKS" ? "vsl_blocks" : "vsl_parcels";

    let errorCount = 0;
    let lastError = null;
    for (const id of ids) {
      const { error } = await supabase.from(tableName).delete().eq("id", id);
      if (error) { errorCount++; lastError = error; }
    }

    deleteBtn.disabled = false;
    setParcelStatusBusy(false);

    if (errorCount > 0) {
      // A stale linked-plots count (a plot added concurrently since this
      // panel's selection was made) hits the same FK constraint
      // server-side — same message either way, since the cause is identical.
      setParcelStatusFormError(
        lt === "BLOCKS" && /foreign key|violates/i.test(lastError?.message || "")
          ? "You can not delete a block with linked Plots, manually delete the linked plots first."
          : `Failed to delete ${errorCount} of ${features.length} item(s).`
      );
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

  const modifyTabs = [
    { el: tabParcels, mode: "PARCELS" },
    { el: tabBlocks, mode: "BLOCKS" },
    { el: tabFeature, mode: "FEATURE" }
  ];

  const activateModifyTab = (mode) => {
    modifyTabs.forEach(({ el, mode: tabModeValue }) => {
      if (!el) return;
      const isActive = tabModeValue === mode;
      el.classList.toggle("active", isActive);
      el.setAttribute("aria-selected", isActive ? "true" : "false");
      el.tabIndex = isActive ? 0 : -1;
    });

    clearParcelStatusSelection();
    parcelStatusState.tabMode = mode;
    parcelStatusState.pickArmed = true;
    renderParcelStatusPreview();
  };

  modifyTabs.forEach(({ el, mode }) => {
    el?.addEventListener("click", () => activateModifyTab(mode));
  });

  // Modify now opens the small per-type popup form for every tab, rather
  // than the cultivation-status Edit Details modal for plots/blocks and a
  // one-field rename for features. Edit Details is still reachable from
  // the Feature Info panel, which is where status/harvest belong.
  modifyBtn?.addEventListener("click", () => openModifySelectedPopup());

  // Footer logging actions — the same modals the map's own selection
  // toolbar and the Feature Info footer open, targeting whatever this
  // panel currently has selected. Both are hidden on the Feature tab (see
  // renderParcelStatusPreview), so no layer-type guard is needed here.
  const logActivityBtn = document.getElementById("parcelStatusLogActivityBtn");
  const logAlertBtn = document.getElementById("parcelStatusLogAlertBtn");

  const openLogFor = (which) => {
    const features = parcelStatusState.selectedFeatures;
    const lt = parcelStatusState.selectedLayerType;
    if (!features?.length || !lt || lt === "FEATURES") return;
    if (features.length > 1) {
      setParcelStatusFormError("Select a single plot or block to log against.");
      return;
    }
    setParcelStatusFormError("");
    if (which === "alert") openLogAlertModal(features[0], lt);
    else openLogActivityModal(features[0], lt);
  };

  logActivityBtn?.addEventListener("click", () => openLogFor("activity"));
  logAlertBtn?.addEventListener("click", () => openLogFor("alert"));
}

// ---------------------------------------------------------------------------
// Log Activity modal (windows/log-activity-modal.html) — opened from the map
// selection toolbar's "+" button. Snapshots the feature/layer that was
// selected when it opened (logActivityState) so a stray click elsewhere
// can't change targets out from under an open form.
// ---------------------------------------------------------------------------
const logActivityState = { feature: null, layerType: null };

// ---------------------------------------------------------------------------
// Two-step form
//
// "location" — pick the activity and where it happened, then Next.
// "details"  — only that activity's own fields; the location collapses into
//              a chip next to the activity dropdown, which clicks back here.
//
// Both steps live in the same modal rather than in two windows: going back
// has to keep everything already chosen, and a second window would mean
// either re-reading it out of the first or holding the state in two places.
// ---------------------------------------------------------------------------
let logActivityStep = "location";

/** Shows one step and the footer button that belongs to it. */
function setLogActivityStep(step) {
  logActivityStep = step;
  const details = step === "details";

  const locationPane = document.getElementById("logActivityStepLocation");
  const fieldsWrap = document.getElementById("logActivityFieldsWrap");
  const nextBtn = document.getElementById("logActivityNextBtn");
  const saveBtn = document.getElementById("logActivitySaveBtn");
  const chip = document.getElementById("logActivityTargetChip");

  if (locationPane) locationPane.hidden = details;
  if (nextBtn) nextBtn.hidden = details;
  if (saveBtn) saveBtn.hidden = !details;
  if (chip) chip.hidden = !details;

  // The fields themselves are still gated on an activity being chosen —
  // renderLogActivityFields owns that, and it only ever shows them on the
  // details step.
  if (!details && fieldsWrap) fieldsWrap.hidden = true;
  if (details) renderLogActivityFields(document.getElementById("logActivitySelect")?.value || "");

  syncLogActivityStepButtons();
}

/** Next needs both halves of step 1; Save needs step 2 to have rendered. */
function syncLogActivityStepButtons() {
  const nextBtn = document.getElementById("logActivityNextBtn");
  const saveBtn = document.getElementById("logActivitySaveBtn");
  const hasActivity = !!document.getElementById("logActivitySelect")?.value;
  const hasTarget = !!logActivityState.feature;

  if (nextBtn) nextBtn.disabled = !(hasActivity && hasTarget);
  if (saveBtn) saveBtn.disabled = !(hasActivity && hasTarget);
}

/** Fills the collapsed location chip shown on step 2. */
function renderLogActivityChip() {
  const { estate, block, plot } = logTargetEls();
  const line = (id, text) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
  };
  const textOf = (sel) => (sel && sel.selectedIndex > 0)
    ? (sel.options[sel.selectedIndex]?.textContent || "")
    : "";

  line("logChipEstate", textOf(estate));
  line("logChipBlock", textOf(block));
  // Blank plot means the whole block, which the chip has to say rather than
  // leaving a gap that reads as "some plot".
  line("logChipPlot", plot?.value ? textOf(plot) : "All plots");
}

function renderLogActivityFields(activityName) {
  const wrap = document.getElementById("logActivityFieldsWrap");
  const commonBody = document.getElementById("logActivityCommonFields");
  const propsSection = document.getElementById("logActivityPropsSection");
  const propsBody = document.getElementById("logActivityPropsFields");
  const saveBtn = document.getElementById("logActivitySaveBtn");
  if (!wrap || !commonBody || !propsBody) return;

  // Fields belong to step 2 only. On step 1 this still runs (the activity
  // dropdown lives up in the header and can change there), but it must not
  // reveal the fields underneath the location pane.
  if (!activityName || logActivityStep !== "details") {
    wrap.hidden = true;
    if (saveBtn) saveBtn.disabled = true;
    syncLogActivityStepButtons();
    return;
  }

  commonBody.innerHTML = LOG_ACTIVITY_COMMON_FIELDS.map(buildPropFieldCell).join("");
  wireConditionalFieldVisibility(commonBody);

  // Area covered can't exceed the selected plot's (or block's) own expected
  // area + 5 acres — set that cap as the input's max here, once the feature
  // whose area it's bounded by is known (also enforced again on save).
  const areaCoveredInput = commonBody.querySelector('[data-key="area_covered_acres"]');
  if (areaCoveredInput) {
    const ownArea = Number(logActivityState.feature?.get("area_acres"));
    if (Number.isFinite(ownArea)) {
      areaCoveredInput.max = String(ownArea + 5);
    } else {
      areaCoveredInput.removeAttribute("max");
    }

    // Soft warning (not a blocking error/popup) — flagged on blur when the
    // typed value is negative or exceeds the plot/block's own database area.
    // Saving still just caps at area + 5 (see saveLogActivityForm); this is
    // purely a heads-up shown between the label and the input, with the
    // input's border highlighted.
    let areaCoveredWarning = areaCoveredInput.parentElement?.querySelector(".vsl-field-warning");
    if (!areaCoveredWarning) {
      areaCoveredWarning = document.createElement("div");
      areaCoveredWarning.className = "vsl-field-warning";
      areaCoveredWarning.hidden = true;
      areaCoveredWarning.textContent = "Area out of range";
      areaCoveredInput.parentElement?.insertBefore(areaCoveredWarning, areaCoveredInput);
    }
    const clearAreaCoveredWarning = () => {
      areaCoveredWarning.hidden = true;
      areaCoveredInput.classList.remove("vsl-field-warn");
    };
    areaCoveredInput.addEventListener("blur", () => {
      const val = areaCoveredInput.value.trim();
      if (val === "") { clearAreaCoveredWarning(); return; }
      const num = Number(val);
      const tooLow = Number.isFinite(num) && num < 0;
      const tooHigh = Number.isFinite(num) && Number.isFinite(ownArea) && num > ownArea;
      if (tooLow || tooHigh) {
        areaCoveredWarning.hidden = false;
        areaCoveredInput.classList.add("vsl-field-warn");
      } else {
        clearAreaCoveredWarning();
      }
    });

    // At 100% complete, the whole plot/block was covered — auto-fill Area
    // covered with its own area and lock it instead of leaving it for
    // manual entry (a completed job can't have covered anything less than
    // the full area). Any other progress value releases the lock again.
    const completionSelect = commonBody.querySelector('[data-key="completion_value"]');
    const applyAreaCoveredLock = () => {
      clearAreaCoveredWarning();
      if (completionSelect?.value === "100") {
        areaCoveredInput.value = Number.isFinite(ownArea) ? String(Math.round(ownArea * 100) / 100) : "";
        areaCoveredInput.disabled = true;
      } else if (areaCoveredInput.disabled) {
        // Was locked at 100% — clear the auto-filled value now that it's
        // editable again rather than leaving a stale number behind.
        areaCoveredInput.value = "";
        areaCoveredInput.disabled = false;
      }
    };
    completionSelect?.addEventListener("change", applyAreaCoveredLock);
    applyAreaCoveredLock();
  }

  // "Other Details" — the per-activity extras (Bush Clearing's vegetation
  // density, Harvesting's yield, etc). Label + table are toggled together
  // via the shared #logActivityPropsSection wrapper so the section heading
  // never shows with nothing under it.
  const extra = ACTIVITY_PROPERTY_DEFS[activityName] || [];
  if (extra.length) {
    propsBody.innerHTML = extra.map(buildPropFieldRow).join("");
    wireConditionalFieldVisibility(propsBody);
    if (propsSection) propsSection.hidden = false;
  } else {
    propsBody.innerHTML = "";
    if (propsSection) propsSection.hidden = true;
  }

  wrap.hidden = false;
  syncLogActivityStepButtons();
}

/**
 * Opens the Log Activity form.
 *
 * `feature`/`layerType` are OPTIONAL. Pass them when arriving from a map
 * click and the Estate/Block/Plot row is prefilled to match; omit them (the
 * Log Activity button in the tool stack) and the row starts empty for the
 * person to fill in. Either way those dropdowns are the source of truth from
 * then on — see syncLogActivityTarget().
 */
async function openLogActivityModal(feature = null, layerType = null) {
  const modal = document.getElementById("logActivityModal");
  const select = document.getElementById("logActivitySelect");
  const errorEl = document.getElementById("logActivityError");
  if (!modal) return;

  // A queue left over from a form the person opened and walked away from
  // would otherwise attach itself to whatever they log next.
  logActivityMedia.reset();
  logActivityState.feature = null;
  logActivityState.layerType = null;

  if (select) {
    select.innerHTML = `<option value="">-- Select Activity --</option>` +
      ACTIVITY_NAMES.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join("");
    select.value = "";
  }
  if (errorEl) { errorEl.hidden = true; errorEl.textContent = ""; }

  // Always starts at step 1. Arriving from a map click only prefills the
  // location — the activity still has to be chosen.
  setLogActivityStep("location");
  modal.hidden = false;

  // After the modal is up, so loading the estate list can't delay it.
  await prefillLogActivityTarget(feature, layerType);
}

// ---------------------------------------------------------------------------
// Where the activity is being logged — the Estate/Block/Plot row in the form
//
// These three dropdowns replaced a separate picker window that did nothing
// else. Keeping them inside the form means one way in regardless of how the
// person got here, and it means the target can be corrected without starting
// over: pick the wrong plot on the map and you fix it here rather than
// closing the form and clicking again.
//
// They keep logActivityState.feature/layerType in step with themselves, so
// everything downstream — the area-covered cap in renderLogActivityFields,
// resolveSelectionParcelIds in the save — carries on reading exactly what it
// always read and needed no changes at all.
// ---------------------------------------------------------------------------

/** Plots for the selected block. Cached so switching plots can read an area
 *  without another round trip. */
let logActivityPlotRows = [];

function logTargetEls() {
  return {
    estate: document.getElementById("logActivityEstate"),
    block: document.getElementById("logActivityBlock"),
    plot: document.getElementById("logActivityPlot")
  };
}

function fillTargetSelect(select, rows, placeholder, labelOf) {
  if (!select) return;
  select.innerHTML =
    `<option value="">${placeholder}</option>` +
    rows.map((r) => `<option value="${escapeHtml(String(r.id))}">${escapeHtml(labelOf(r))}</option>`).join("");
  select.disabled = rows.length === 0;
}

async function loadLogActivityEstates(selectedId = "") {
  const { estate } = logTargetEls();
  if (!estate) return;
  const { data, error } = await supabase
    .from("vsl_estate").select("id, estate_name").order("estate_name");
  if (error) { setLogActivityError(`Couldn't load estates: ${error.message}`); return; }
  fillTargetSelect(estate, data || [], "— Select estate —", (r) => r.estate_name || "(unnamed)");
  if (selectedId) estate.value = String(selectedId);
}

async function loadLogActivityBlocks(estateId, selectedId = "") {
  const { block, plot } = logTargetEls();
  if (!block) return;
  logActivityPlotRows = [];
  if (plot) {
    plot.innerHTML = '<option value="">— Select block first —</option>';
    plot.disabled = true;
  }
  if (!estateId) {
    block.innerHTML = '<option value="">— Select estate first —</option>';
    block.disabled = true;
    return;
  }
  const { data, error } = await supabase
    .from("vsl_blocks").select("id, block_code, block_name")
    .eq("estate_id", estateId).order("block_code");
  if (error) { setLogActivityError(`Couldn't load blocks: ${error.message}`); return; }
  const rows = data || [];
  fillTargetSelect(block, rows, rows.length ? "— Select block —" : "— No blocks —",
    (r) => r.block_name || r.block_code || "(unnamed)");
  if (selectedId) block.value = String(selectedId);
}

async function loadLogActivityPlots(blockId, selectedId = "") {
  const { plot } = logTargetEls();
  if (!plot) return;
  logActivityPlotRows = [];
  if (!blockId) {
    plot.innerHTML = '<option value="">— Select block first —</option>';
    plot.disabled = true;
    return;
  }
  const { data, error } = await supabase
    .from("vsl_parcels").select("id, parcel_code, parcel_name, area_acres")
    .eq("block_id", blockId).order("parcel_code");
  if (error) { setLogActivityError(`Couldn't load plots: ${error.message}`); return; }
  logActivityPlotRows = data || [];
  // "All plots" is the blank option rather than a prompt — leaving it selected
  // is a real choice (log against the whole block), not an omission.
  plot.innerHTML =
    `<option value="">All plots in this block</option>` +
    logActivityPlotRows.map((r) =>
      `<option value="${escapeHtml(String(r.id))}">${escapeHtml(r.parcel_name || r.parcel_code || "(unnamed)")}</option>`
    ).join("");
  plot.disabled = false;
  if (selectedId) plot.value = String(selectedId);
}

function setLogActivityError(msg) {
  const el = document.getElementById("logActivityError");
  if (!el) return;
  el.textContent = msg || "";
  el.hidden = !msg;
}

/**
 * Rebuilds logActivityState from whatever the dropdowns currently say.
 *
 * The feature is synthesised rather than looked up on the map: the chosen
 * plot may well be outside the current viewport, and parcelsSource only
 * holds what the last bbox fetch returned. Everything downstream reads it
 * through getId()/get(), so a synthetic feature is indistinguishable from a
 * clicked one.
 */
function syncLogActivityTarget() {
  const { block, plot } = logTargetEls();
  const titleEl = document.getElementById("logActivityTitle");

  let feature = null;
  let layerType = null;
  let label = "";

  if (block?.value) {
    feature = new ol.Feature();
    if (plot?.value) {
      const row = logActivityPlotRows.find((r) => String(r.id) === plot.value);
      label = row?.parcel_name || row?.parcel_code || "";
      feature.setId(plot.value);
      feature.set("parcel_name", label);
      // What the area-covered cap is measured against.
      feature.set("area_acres", row?.area_acres ?? null);
      layerType = "PARCELS";
    } else {
      label = block.options[block.selectedIndex]?.textContent || "";
      feature.setId(block.value);
      feature.set("block_name", label);
      layerType = "BLOCKS";
    }
  }

  logActivityState.feature = feature;
  logActivityState.layerType = layerType;

  // The block-scope warning line was removed from the markup. Scope is
  // still legible without it: the chip reads "All plots" whenever no plot
  // is picked.
  if (titleEl) titleEl.textContent = `Log Activity${label ? ` — ${label}` : ""}`;

  renderLogActivityChip();
  // Re-render so the area cap picks up the new target's own area. Harmless
  // when no activity is chosen yet — it just redraws the empty state.
  renderLogActivityFields(document.getElementById("logActivitySelect")?.value || "");
  syncLogActivityStepButtons();
}

/** Fills the dropdowns to match a feature clicked on the map, or clears them
 *  when opened from the tool stack. */
async function prefillLogActivityTarget(feature, layerType) {
  const { estate, block, plot } = logTargetEls();
  if (!estate) return;

  if (!feature || !layerType) {
    await loadLogActivityEstates();
    await loadLogActivityBlocks("");
    syncLogActivityTarget();
    return;
  }

  let estateId = "";
  let blockId = "";
  let plotId = "";

  if (layerType === "BLOCKS") {
    estateId = feature.get("estate_id") || "";
    blockId = feature.getId();
  } else {
    plotId = feature.getId();
    // A parcel's map properties carry block_code but not block_id or
    // estate_id (see vsl_get_features_bbox), so the parentage is fetched.
    const { data } = await supabase
      .from("vsl_parcels").select("block_id, vsl_blocks(estate_id)")
      .eq("id", plotId).single();
    blockId = data?.block_id || "";
    estateId = data?.vsl_blocks?.estate_id || "";
  }

  await loadLogActivityEstates(estateId);
  await loadLogActivityBlocks(estateId, blockId);
  await loadLogActivityPlots(blockId, plotId);
  if (estate) estate.value = String(estateId || "");
  if (block) block.value = String(blockId || "");
  if (plot) plot.value = String(plotId || "");
  syncLogActivityTarget();
}

function closeLogActivityModal() {
  const modal = document.getElementById("logActivityModal");
  if (modal) modal.hidden = true;
}

/** The docked panels all share one column, so opening any of them closes the
 *  rest. Each exposes its own closer as a window hook (the same loosely
 *  coupled pattern unified-menu.js uses). */
function closeOtherMapPanels() {
  window.closeSearchPanel?.();
  window.closeMenu?.();
  window.closeParcelStatusPanel?.();
  window.vslClosePrintPanel?.();
  const measurePanel = document.getElementById("measurePanel");
  if (measurePanel) measurePanel.hidden = true;
}

// ---------------------------------------------------------------------------
// Photo/video picker shared by the Log Activity and Log Alert modals
//
// Files are held HERE, in memory, and only uploaded once the record they
// belong to has actually been written — see the note in the modal markup.
// Each modal gets its own instance so one form's queue can't leak into the
// other's when both have been opened in a session.
// ---------------------------------------------------------------------------
function createMediaPicker({ inputId, listId }) {
  /** Chosen but not yet uploaded. Cleared on reset(). */
  let files = [];

  function render() {
    const list = document.getElementById(listId);
    if (!list) return;
    list.innerHTML = files
      .map(
        (file, index) => `
        <li class="vsl-media-attach__item">
          <i class="fas ${String(file.type || "").startsWith("video/") ? "fa-film" : "fa-image"}" aria-hidden="true"></i>
          <span class="vsl-media-attach__name">${escapeHtml(file.name || "attachment")}</span>
          <span class="vsl-media-attach__size">${(file.size / 1048576).toFixed(1)}MB</span>
          <button type="button" class="vsl-media-attach__remove" data-media-remove="${index}"
                  title="Remove" aria-label="Remove ${escapeHtml(file.name || "attachment")}">
            <i class="fas fa-times" aria-hidden="true"></i>
          </button>
        </li>`
      )
      .join("");
  }

  function add(fileList) {
    const rejected = [];
    for (const file of Array.from(fileList || [])) {
      const problem = mediaFileError(file);
      if (problem) { rejected.push(problem); continue; }
      // Same file picked twice (easy to do across two trips to the picker)
      // would otherwise upload and attach twice.
      const duplicate = files.some(
        (f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified
      );
      if (!duplicate) files.push(file);
    }
    render();
    return rejected;
  }

  function bind(onRejected) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(listId);
    input?.addEventListener("change", () => {
      const rejected = add(input.files);
      // Reset the input so choosing the SAME file again still fires change.
      input.value = "";
      if (rejected.length) onRejected?.(rejected.join(" "));
    });
    list?.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-media-remove]");
      if (!btn) return;
      files.splice(Number(btn.dataset.mediaRemove), 1);
      render();
    });
  }

  return {
    bind,
    reset() { files = []; render(); },
    get files() { return files.slice(); },
    get count() { return files.length; }
  };
}

const logActivityMedia = createMediaPicker({
  inputId: "logActivityMediaInput",
  listId: "logActivityMediaList"
});
const logAlertMedia = createMediaPicker({
  inputId: "logAlertMediaInput",
  listId: "logAlertMediaList"
});

/**
 * Uploads a modal's queued files and links them to the rows just written.
 *
 * Deliberately never throws: the activity or alert is already saved by the
 * time this runs, so a failed attachment is reported as a warning rather
 * than being allowed to look like the whole log entry failed.
 */
async function attachQueuedMedia(picker, entityType, recordIds) {
  if (!picker.count || !recordIds?.length) return "";
  try {
    const { failures } = await attachMediaToRecords(supabase, picker.files, {
      entityType,
      recordIds,
      capturedBy: currentUser?.id || null
    });
    return failures.length ? ` Some attachments failed: ${failures.join(" ")}` : "";
  } catch (error) {
    console.error("[Victoria Media] attach failed:", error);
    return ` Attachments failed: ${error.message}`;
  }
}

async function saveLogActivityForm(event) {
  event.preventDefault();
  const errorEl = document.getElementById("logActivityError");
  const saveBtn = document.getElementById("logActivitySaveBtn");
  const select = document.getElementById("logActivitySelect");
  const activityName = select?.value || "";
  const { feature, layerType } = logActivityState;

  // Enter inside step 1 still reaches the form's submit handler even though
  // its own button is type="button" — so saving is refused there outright
  // rather than committing a record whose fields were never shown.
  if (logActivityStep !== "details") {
    setLogActivityStep("details");
    return;
  }

  // The target comes from the Estate/Block/Plot row rather than from however
  // the form was opened, so a missing one is a real user-facing state (the
  // tool-stack route starts empty) and gets told, not silently ignored.
  if (!feature || !layerType) {
    if (errorEl) {
      errorEl.textContent = "Choose at least an estate and a block to log against.";
      errorEl.hidden = false;
    }
    return;
  }
  if (!activityName) return;

  if (!isAuthenticated || !currentUser?.id || currentUser.id === "guest") {
    if (errorEl) { errorEl.textContent = "Sign in to log an activity."; errorEl.hidden = false; }
    return;
  }

  if (saveBtn) saveBtn.disabled = true;
  if (errorEl) errorEl.hidden = true;

  try {
    const { parcelIds, blockId } = await resolveSelectionParcelIds(feature, layerType);
    if (!parcelIds.length) {
      throw new Error(layerType === "BLOCKS" ? "This block has no plots to log against." : "Could not resolve the selected plot.");
    }

    const common = {};
    document.querySelectorAll("#logActivityCommonFields [data-key]").forEach((el) => {
      common[el.dataset.key] = (el.value ?? "").trim();
    });
    const properties = {};
    document.querySelectorAll("#logActivityPropsFields [data-key]").forEach((el) => {
      const v = (el.value ?? "").trim();
      if (v !== "") properties[el.dataset.key] = v;
    });

    // Area covered — at 100% it was auto-filled with the plot/block's own
    // area and locked (see applyAreaCoveredLock in renderLogActivityFields),
    // so that value is read and saved here just like a manually-typed one.
    // Still capped at the plot's own area + 5 either way. Lives in its own
    // vsl_activities.area_covered_acres column (not activity_properties) so
    // it can be queried/reported on directly.
    let areaCoveredAcres = null;
    if (common.area_covered_acres !== "") {
      const areaCovered = numOrNull(common.area_covered_acres);
      if (areaCovered != null) {
        const ownArea = Number(feature.get("area_acres"));
        if (Number.isFinite(ownArea) && areaCovered > ownArea + 5) {
          throw new Error(`Area covered can't exceed the plot's area + 5 (max ${(ownArea + 5).toFixed(2)} ac).`);
        }
        areaCoveredAcres = areaCovered;
      }
    }

    // Planting: ratoon number and germination date are never typed in — the
    // write-back below always resets ratoon to 0, and germination date is
    // approximated (sugarcane typically germinates ~30 days after planting)
    // and stored on the activity row purely for reference.
    if (activityName === "Planting") {
      const germDate = new Date();
      germDate.setDate(germDate.getDate() + 30);
      properties.expected_germination_date = germDate.toISOString().slice(0, 10);
    }

    // Harvesting needs a yield to record in vsl_harvests — validate before
    // the activity row (and the harvest record) gets written at all. Ratoon
    // number is never typed in either — it's read from each plot's current
    // ratoon_number and stamped into that plot's own activity_properties
    // below, purely for the record (applyHarvestingWriteBack is what
    // actually bumps the real ratoon_number column afterwards).
    let harvestRatoonByParcel = null;
    if (activityName === "Harvesting") {
      const yieldWeight = numOrNull(properties.yield_tonnes);
      if (yieldWeight == null) {
        throw new Error("Enter a yield (tonnes) before saving a Harvesting activity.");
      }
      const { data: parcelsNow, error: fetchErr } = await supabase
        .from("vsl_parcels")
        .select("id, ratoon_number")
        .in("id", parcelIds);
      if (fetchErr) throw fetchErr;
      harvestRatoonByParcel = new Map((parcelsNow || []).map((p) => [String(p.id), p.ratoon_number ?? 0]));
    }

    const basePayload = {
      activity_name: activityName,
      team_size: numOrNull(common.team_size),
      number_of_machines: numOrNull(common.number_of_machines),
      completion_value: numOrNull(common.completion_value),
      area_covered_acres: areaCoveredAcres,
      comments: common.comments || null,
      activity_date: new Date().toISOString().slice(0, 10),
      created_by: currentUser.id,
      block_id: blockId || null
    };

    const rows = parcelIds.map((parcelId) => {
      const rowProperties = harvestRatoonByParcel
        ? { ...properties, ratoon_number: harvestRatoonByParcel.get(String(parcelId)) ?? 0 }
        : properties;
      return { ...basePayload, activity_properties: rowProperties, parcel_id: parcelId };
    });
    // .select("id") so the freshly written rows can be linked to any queued
    // photos — one activity row per plot, and the evidence belongs to all
    // of them (see attachMediaToRecords in js/media-store.js).
    const { data: insertedActivities, error } = await supabase
      .from("vsl_activities").insert(rows).select("id");
    if (error) throw error;

    const mediaNote = await attachQueuedMedia(
      logActivityMedia,
      "activity",
      (insertedActivities || []).map((r) => r.id)
    );

    // Land-linked write-back — keeps the plot record (and, for Harvesting,
    // the harvest history) in sync with what was just logged. The activity
    // itself is already saved by this point, so a failure here is reported
    // but doesn't mean the log entry was lost.
    try {
      if (activityName === "Planting") {
        await applyPlantingWriteBack(parcelIds, properties);
      } else if (activityName === "Harvesting") {
        await applyHarvestingWriteBack(parcelIds, properties, currentUser.id);
      }
    } catch (writeBackErr) {
      console.error("[Victoria] Activity logged, but plot write-back failed:", writeBackErr);
      setStatus(statusEl, `Logged "${activityName}", but updating the plot record failed: ${writeBackErr.message}${mediaNote}`, true);
      closeLogActivityModal();
      loadLayersFromDb();
      return;
    }

    setStatus(
      statusEl,
      `Logged "${activityName}" on ${rows.length} plot${rows.length === 1 ? "" : "s"}.${mediaNote}`,
      !!mediaNote
    );
    closeLogActivityModal();
    if (activityName === "Planting" || activityName === "Harvesting") {
      loadLayersFromDb(); // ratoon number/cultivation status changed — refresh map labels & badges
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err?.message || "Failed to log activity.";
      errorEl.hidden = false;
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function setupLogActivityModal() {
  const modal = document.getElementById("logActivityModal");
  const select = document.getElementById("logActivitySelect");
  // Cancel button was removed from the footer — the header X close button
  // is the only close/cancel affordance now (was a redundant duplicate).
  const closeBtn = document.getElementById("logActivityCloseBtn");
  const form = document.getElementById("logActivityForm");
  if (!modal) return;

  // The activity dropdown lives in the header and is reachable from BOTH
  // steps, so a change has to re-gate Next as well as redraw the fields.
  select?.addEventListener("change", () => {
    renderLogActivityFields(select.value);
    syncLogActivityStepButtons();
  });
  closeBtn?.addEventListener("click", () => closeLogActivityModal());
  form?.addEventListener("submit", (e) => saveLogActivityForm(e));

  document.getElementById("logActivityNextBtn")?.addEventListener("click", () => {
    setLogActivityError("");
    setLogActivityStep("details");
  });

  // The collapsed location chip is the only way back — tapping it reopens
  // step 1 with the activity and location still chosen, so correcting a
  // wrong plot costs one click rather than restarting the form.
  document.getElementById("logActivityTargetChip")?.addEventListener("click", () => {
    setLogActivityError("");
    setLogActivityStep("location");
  });

  // Estate → Block → Plot. Each level clears the ones under it before
  // reloading, so a half-stale selection can never survive a change higher
  // up — picking a different estate must not leave the old estate's block
  // still chosen underneath.
  const { estate, block, plot } = logTargetEls();
  estate?.addEventListener("change", async () => {
    setLogActivityError("");
    await loadLogActivityBlocks(estate.value);
    syncLogActivityTarget();
  });
  block?.addEventListener("change", async () => {
    setLogActivityError("");
    await loadLogActivityPlots(block.value);
    syncLogActivityTarget();
  });
  plot?.addEventListener("change", () => {
    setLogActivityError("");
    syncLogActivityTarget();
  });

  logActivityMedia.bind((message) => {
    const errorEl = document.getElementById("logActivityError");
    if (errorEl) { errorEl.textContent = message; errorEl.hidden = false; }
  });
}

// ---------------------------------------------------------------------------
// Log Alert modal (windows/log-alert-modal.html) — opened from the map
// selection toolbar's warning-triangle button.
// ---------------------------------------------------------------------------
const logAlertState = { feature: null, layerType: null };

// Every logged alert starts life as status "open" — resolving/investigating
// is an admin action done later from the dashboard, not something the person
// logging the alert picks, so there's no status field here.
const LOG_ALERT_FIELDS = [
  { key: "alert_name", label: "Alert name", type: "text" },
  { key: "note", label: "Description", type: "textarea" }
];

function renderLogAlertFields(severity) {
  const wrap = document.getElementById("logAlertFieldsWrap");
  const emptyHint = document.getElementById("logAlertEmptyHint");
  const body = document.getElementById("logAlertFields");
  const saveBtn = document.getElementById("logAlertSaveBtn");
  if (!wrap || !body) return;

  if (!severity) {
    wrap.hidden = true;
    if (emptyHint) emptyHint.hidden = false;
    if (saveBtn) saveBtn.disabled = true;
    return;
  }

  body.innerHTML = LOG_ALERT_FIELDS.map(buildPropFieldRow).join("");
  wrap.hidden = false;
  if (emptyHint) emptyHint.hidden = true;
  if (saveBtn) saveBtn.disabled = false;
}

function openLogAlertModal(feature, layerType) {
  const modal = document.getElementById("logAlertModal");
  const select = document.getElementById("logAlertSeveritySelect");
  const warning = document.getElementById("logAlertBlockWarning");
  const errorEl = document.getElementById("logAlertError");
  const titleEl = document.getElementById("logAlertTitle");
  if (!modal || !feature || !layerType) return;

  logAlertMedia.reset();       // same reason as the activity modal
  logAlertState.feature = feature;
  logAlertState.layerType = layerType;

  if (select) select.value = "";
  if (warning) warning.hidden = layerType !== "BLOCKS";
  if (errorEl) { errorEl.hidden = true; errorEl.textContent = ""; }
  if (titleEl) {
    const name = layerType === "BLOCKS" ? feature.get("block_name") : feature.get("parcel_name");
    titleEl.textContent = `Log Alert${name ? ` — ${name}` : ""}`;
  }
  renderLogAlertFields("");
  modal.hidden = false;
}

function closeLogAlertModal() {
  const modal = document.getElementById("logAlertModal");
  if (modal) modal.hidden = true;
}

async function saveLogAlertForm(event) {
  event.preventDefault();
  const errorEl = document.getElementById("logAlertError");
  const saveBtn = document.getElementById("logAlertSaveBtn");
  const select = document.getElementById("logAlertSeveritySelect");
  const severity = select?.value || "";
  const { feature, layerType } = logAlertState;

  if (!feature || !layerType || !severity) return;

  if (!isAuthenticated || !currentUser?.id || currentUser.id === "guest") {
    if (errorEl) { errorEl.textContent = "Sign in to log an alert."; errorEl.hidden = false; }
    return;
  }

  if (saveBtn) saveBtn.disabled = true;
  if (errorEl) errorEl.hidden = true;

  try {
    const { parcelIds } = await resolveSelectionParcelIds(feature, layerType);
    if (!parcelIds.length) {
      throw new Error(layerType === "BLOCKS" ? "This block has no plots to log against." : "Could not resolve the selected plot.");
    }

    const fieldsMap = {};
    document.querySelectorAll("#logAlertFields [data-key]").forEach((el) => {
      fieldsMap[el.dataset.key] = (el.value ?? "").trim();
    });

    if (!fieldsMap.note) {
      throw new Error("Description is required for an alert.");
    }

    const basePayload = {
      severity,
      alert_name: fieldsMap.alert_name || null,
      note: fieldsMap.note,
      status: "open",
      layer_type: "PARCELS",
      created_by: currentUser.id
    };

    const rows = parcelIds.map((parcelId) => ({ ...basePayload, target_id: String(parcelId) }));
    const { data: insertedAlerts, error } = await supabase
      .from("vsl_alerts").insert(rows).select("id");
    if (error) throw error;

    const mediaNote = await attachQueuedMedia(
      logAlertMedia,
      "alert",
      (insertedAlerts || []).map((r) => r.id)
    );

    setStatus(
      statusEl,
      `Logged ${severity} alert on ${rows.length} plot${rows.length === 1 ? "" : "s"}.${mediaNote}`,
      !!mediaNote
    );
    closeLogAlertModal();
    refreshParcelAlertBadges();
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err?.message || "Failed to log alert.";
      errorEl.hidden = false;
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function setupLogAlertModal() {
  const modal = document.getElementById("logAlertModal");
  const select = document.getElementById("logAlertSeveritySelect");
  // Cancel button was removed from the footer — the header X close button
  // is the only close/cancel affordance now (was a redundant duplicate).
  const closeBtn = document.getElementById("logAlertCloseBtn");
  const form = document.getElementById("logAlertForm");
  if (!modal) return;

  select?.addEventListener("change", () => renderLogAlertFields(select.value));
  closeBtn?.addEventListener("click", () => closeLogAlertModal());
  form?.addEventListener("submit", (e) => saveLogAlertForm(e));

  logAlertMedia.bind((message) => {
    const errorEl = document.getElementById("logAlertError");
    if (errorEl) { errorEl.textContent = message; errorEl.hidden = false; }
  });
}

function closeInfoPopup() {
  const inner = document.getElementById("featureInfoPanelInner");
  const overlay = document.getElementById("featureInfoOverlay");
  const filterBar = document.getElementById("featureInfoFilterBar");
  const actionBtns = document.getElementById("featureInfoActionBtns");
  if (inner) inner.innerHTML = "";
  if (overlay) overlay.hidden = true;
  if (filterBar) filterBar.hidden = true;
  if (actionBtns) actionBtns.hidden = true;
  clearFeatureExportContext();
  hideParcelActionToolbar();
  featureInfoSelection = { estateId: null, blockId: null, parcelId: null, blockName: null, parcelName: null };
}

/** Rough half-height (in px) of the name/area/ratoon(/alerts) label block
 *  for a given feature, used to lift the action toolbar clear of it. Mirrors
 *  the line-count logic in the parcels layer's style function; assumes the
 *  non-highlighted 11px font since a plain single-click selection (the only
 *  time this toolbar shows) isn't necessarily in the "hi" highlighted state. */
function estimateParcelLabelHalfHeightPx() {
  const fontPx = 11;
  const lineHeightPx = fontPx * LABEL_LINE_HEIGHT;
  // Always exactly two lines now: name + area. The ratoon and alert lines
  // this used to account for are no longer drawn on the map at all, so the
  // per-feature inspection they needed is gone with them. Two is also a safe
  // upper bound when the area happens to be blank.
  const lines = 2;
  return (lines * lineHeightPx) / 2;
}

/**
 * Builds the popup's summary rows for the selected block or plot.
 *
 * Everything here comes off properties the feature is already carrying —
 * vsl_get_features_bbox returns cultivation_status, ratoon_number and
 * current_activity_name with the geometry, and refreshParcelAlertBadges()
 * stamps on _alert_severity/_alert_count. So the popup opens instantly, with
 * no fetch and no loading state to design around.
 *
 * Ratoon and alerts live here now rather than on the map label: both change
 * within a season, and a map gets printed. This is read live, so it's the
 * right home for them.
 */
function renderParcelActionInfo(feature, layerType) {
  const el = document.getElementById("parcelActionSummary");
  if (!el || !feature) return;

  const rows = [];
  const addRow = (label, value, opts = {}) => {
    if (value === null || value === undefined || value === "") return;
    const color = opts.color ? ` style="color:${opts.color}"` : "";
    const valueHtml = opts.button
      ? `<button type="button" class="parcel-action-toolbar__alerts"${color} ${opts.button}>${escapeHtml(String(value))}</button>`
      : `<span class="parcel-action-toolbar__val"${color}>${escapeHtml(String(value))}</span>`;
    rows.push(
      `<div class="parcel-action-toolbar__row">` +
      `<span class="parcel-action-toolbar__key">${escapeHtml(label)}</span>${valueHtml}</div>`
    );
  };

  /** Alerts row, shared by both kinds. A real button when there are any —
   *  it opens the same Alerts List modal the on-map "Alerts(n)" text line
   *  used to, which is where that capability went when the line was taken
   *  off the plot label. */
  const addAlertsRow = (count, severity, { pending = false, clickable = true } = {}) => {
    if (pending) { addRow("Alerts", "…"); return; }
    if (count > 0) {
      addRow("Alerts", `${count} open`, {
        color: ALERT_SEVERITY_COLORS[severity] || ALERT_SEVERITY_COLORS.information,
        button: clickable ? 'data-open-alerts="1"' : null
      });
    } else {
      addRow("Alerts", "None");
    }
  };

  if (layerType === "PARCELS") {
    // Status, Ratoon, Alerts, Activity — all already on the feature, so this
    // renders with no round trip at all.
    const statusKey = cultivationKeyFromFeature(feature);
    addRow("Status", CULTIVATION_STATUS_LABELS[statusKey] || statusKey, {
      color: CULTIVATION_PALETTE[statusKey]?.text
    });

    // Ratoon 0 is meaningful ("planted, not yet ratooned"), so this tests for
    // absence rather than falsiness.
    const ratoon = feature.get("ratoon_number");
    if (ratoon !== null && ratoon !== undefined && ratoon !== "") {
      addRow("Ratoon", `R${ratoon}`);
    }

    addAlertsRow(Number(feature.get("_alert_count")) || 0, feature.get("_alert_severity"));
    // Always shown, even when empty. current_activity_name is null on every
    // plot until something is logged against it, and omitting the row made
    // the field look forgotten rather than simply blank.
    addRow("Activity", feature.get("current_activity_name") || "None yet");
  } else {
    // Block area, Plots, Alerts, Manager.
    //
    // Area and plot count ride along on the feature (vsl_block_stats feeds
    // them through vsl_get_features_bbox). Manager and alerts do not: the
    // manager is a join onto vsl_profiles, and alerts are recorded against
    // PARCELS, so a block's figure is the sum across its own plots — see
    // refreshParcelAlertBadges, which only ever stamps parcels. Both are
    // fetched by loadBlockPopupExtras() and patched in when they land.
    // area_acres, NOT expected_area_acres — the column was renamed on both
    // vsl_blocks and vsl_parcels, and the old name silently yields undefined
    // here, which is why this row went missing entirely.
    const area = Number(feature.get("area_acres"));
    if (Number.isFinite(area)) addRow("Block area", `${area.toFixed(2)} ac`);

    const plots = feature.get("total_plots");
    if (plots !== null && plots !== undefined && plots !== "") addRow("Plots", plots);

    const cached = blockPopupExtras.get(String(feature.getId()));
    if (cached) {
      // Not clickable: the Alerts List modal is per-plot, and a block's
      // figure spans several. "More info" is the way into the detail.
      addAlertsRow(cached.alertCount, cached.alertSeverity, { clickable: false });
      addRow("Manager", cached.manager || "—");
    } else {
      addAlertsRow(0, null, { pending: true });
      addRow("Manager", "…");
    }
  }

  el.innerHTML = rows.join("");
}

/**
 * Manager name and alert count for a block, keyed by block id.
 *
 * Cached for the life of the page: a popup reopened on the same block should
 * not refetch, and neither value changes often. Cleared by
 * refreshParcelAlertBadges, which is already the point at which alert
 * figures are known to be stale.
 */
const blockPopupExtras = new Map();

/**
 * Fetches the two block rows that aren't on the feature, then re-renders.
 *
 * Deliberately fire-and-forget: the popup is already on screen showing "…"
 * for these, and a slow or failed lookup must not hold up the rows that were
 * ready immediately.
 */
async function loadBlockPopupExtras(feature) {
  const blockId = feature?.getId();
  if (!blockId || blockPopupExtras.has(String(blockId))) return;

  try {
    // One round trip for the manager and the block's plot ids — the ids are
    // needed because alerts are recorded per plot, never per block.
    // manager_name is a plain column on vsl_blocks now; the manager_id join
    // onto vsl_profiles is the older route and is kept as the fallback,
    // since most blocks currently have one or the other rather than both.
    const { data: block, error } = await supabase
      .from("vsl_blocks")
      .select("id, manager_name, vsl_profiles!manager_id(full_name), vsl_parcels(id)")
      .eq("id", blockId)
      .single();
    if (error) throw error;

    const parcelIds = (block?.vsl_parcels || []).map((p) => String(p.id));
    let alertCount = 0;
    let alertSeverity = null;
    if (parcelIds.length) {
      const { data: alerts } = await supabase
        .from("vsl_alerts")
        .select("severity")
        .eq("layer_type", "PARCELS")
        .neq("status", "resolved")
        .in("target_id", parcelIds);
      const RANK = { critical: 3, warning: 2, information: 1 };
      alertCount = (alerts || []).length;
      // The block shows its WORST open severity, same rule the plot fills use.
      alertSeverity = (alerts || []).reduce((worst, a) =>
        (RANK[a.severity] || 0) > (RANK[worst] || 0) ? a.severity : worst, null);
    }

    blockPopupExtras.set(String(blockId), {
      manager: block?.manager_name || block?.vsl_profiles?.full_name || null,
      alertCount,
      alertSeverity
    });
  } catch (err) {
    console.warn("[Victoria] Could not load block popup details:", err);
    // Cached as blanks rather than left pending, so the popup settles on
    // "—"/"None" instead of showing "…" forever.
    blockPopupExtras.set(String(blockId), { manager: null, alertCount: 0, alertSeverity: null });
  }

  // Only repaint if this block is still the one on screen — the person may
  // have clicked elsewhere while this was in flight.
  if (selectedFeature?.getId?.() === blockId && selectedLayerType === "BLOCKS") {
    renderParcelActionInfo(selectedFeature, "BLOCKS");
  }
}

/**
 * Floating action popup for whichever block/parcel is selected: a short live
 * summary, a "More info" link into the full Feature Info panel, and the two
 * logging actions. Positioned via an ol.Overlay bound to
 * #parcelActionToolbar (see setupParcelActionToolbar).
 */
function showParcelActionToolbar(feature) {
  const el = document.getElementById("parcelActionToolbar");
  const geometry = feature?.getGeometry?.();
  if (!el || !parcelActionOverlay || !geometry) return;
  // Anchor horizontally/vertically on the same guaranteed-inside-the-shape
  // point the plot's label uses (getFeatureInteriorPoint) — a bounding-box
  // based anchor (extent midpoint/top) doesn't work reliably here, since
  // for an irregular/triangular plot the box can extend well beyond the
  // shape itself, landing the toolbar over a neighboring plot.
  const ip = getFeatureInteriorPoint(geometry);
  const extent = geometry.getExtent();
  const anchor = ip ? ip.getCoordinates() : [(extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2];

  // The label block is vertically centered on that same anchor point, so
  // "above the label" means clearing half its height (not sitting right on
  // top of the anchor, which covers the name/area text) plus a small gap.
  const gapPx = 10;
  parcelActionOverlay.setOffset([0, -(estimateParcelLabelHalfHeightPx() + gapPx)]);

  // Filled before it's shown, so the card is never briefly visible with the
  // previous selection's details still in it.
  renderParcelActionInfo(feature, selectedLayerType);
  // A block's manager and alert count aren't on the feature. Not awaited —
  // the rows that were ready render now, and these patch in when they land.
  if (selectedLayerType === "BLOCKS") loadBlockPopupExtras(feature);

  el.hidden = false;
  parcelActionOverlay.setPosition(anchor);
}

function hideParcelActionToolbar() {
  const el = document.getElementById("parcelActionToolbar");
  if (el) el.hidden = true;
  parcelActionOverlay?.setPosition(undefined);
  hideFeatureInfoToolbar();
}

/**
 * The drawn-feature counterpart to the toolbar above: tap a tree, road or
 * wall and a small card appears over it with what's actually recorded —
 * name and description for every kind, plus length for a line or area for a
 * polygon. A readout, not actions; editing and deleting live in the Select
 * window's Feature tab.
 *
 * Area is read from vsl_feature.area_ac (acres, computed by PostGIS and
 * carried onto the feature as _areaAc), so this readout and the map label
 * always show the same number. Length is still computed from the geometry.
 * Both fall back to computing from geometry when there's no stored value —
 * an unsaved shape, or one mid-drag in the Edit tab.
 */
function showFeatureInfoToolbar(feature) {
  const el = document.getElementById("featureInfoToolbar");
  const geometry = feature?.getGeometry?.();
  if (!el || !featureInfoOverlay || !geometry) return;

  const kind = geometryKindOf(feature);
  const typeName = String(feature.get("_typeName") ?? "");
  const name = String(feature.get("_name") ?? "").trim();
  const description = String(feature.get("_description") ?? "").trim();

  const swatch = document.getElementById("featureInfoToolbarSwatch");
  if (swatch) swatch.style.background = feature.get("_color") || "#3f8f3f";
  document.getElementById("featureInfoToolbarName").textContent = name || typeName || "Feature";
  const typeEl = document.getElementById("featureInfoToolbarType");
  // Only worth a second line when it isn't just repeating the name above.
  typeEl.textContent = name && typeName ? typeName : "";
  typeEl.hidden = !typeEl.textContent;

  const descEl = document.getElementById("featureInfoToolbarDesc");
  descEl.textContent = description;
  descEl.hidden = !description;

  const measureEl = document.getElementById("featureInfoToolbarMeasure");
  let measure = "";
  if (kind === "line") {
    const m = ol.sphere.getLength(geometry, { projection: "EPSG:3857" });
    if (Number.isFinite(m)) measure = m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(1)} m`;
  } else if (kind === "polygon") {
    // Acres, from vsl_feature.area_ac where available (see _areaAc in
    // js/survey-draw.js) so this readout matches the map label exactly.
    const stored = feature.get("_areaAc");
    const storedNum = stored === null || stored === undefined || stored === "" ? NaN : Number(stored);
    if (Number.isFinite(storedNum)) {
      measure = `${storedNum.toFixed(2)} ac`;
    } else {
      const m2 = ol.sphere.getArea(geometry, { projection: "EPSG:3857" });
      if (Number.isFinite(m2)) measure = `${(m2 / 4046.8564224).toFixed(2)} ac`;
    }
  }
  measureEl.textContent = measure;
  measureEl.hidden = !measure;

  // Anchored the same way the plot toolbar is: a point sits on its own
  // coordinate, anything else on a point guaranteed to be inside the shape.
  const anchor =
    kind === "point"
      ? geometry.getClosestPoint(ol.extent.getCenter(geometry.getExtent()))
      : getFeatureInteriorPoint(geometry)?.getCoordinates()
        || ol.extent.getCenter(geometry.getExtent());

  el.hidden = false;
  featureInfoOverlay.setPosition(anchor);
}

function hideFeatureInfoToolbar() {
  const el = document.getElementById("featureInfoToolbar");
  if (el) el.hidden = true;
  featureInfoOverlay?.setPosition(undefined);
}

function setupParcelActionToolbar() {
  const el = document.getElementById("parcelActionToolbar");
  if (!el) return;

  // "bottom-center" so the toolbar's bottom edge sits at the given anchor
  // coordinate, then showParcelActionToolbar sets a per-feature negative Y
  // offset (via setOffset) that lifts it just clear of the label block
  // instead of covering it. The offset is set dynamically per-show (it
  // depends on how many lines that feature's label has), so the value here
  // is just a sane pre-first-show default.
  parcelActionOverlay = new ol.Overlay({
    element: el,
    positioning: "bottom-center",
    offset: [0, -18],
    stopEvent: true
  });
  map.addOverlay(parcelActionOverlay);

  const featureInfoEl = document.getElementById("featureInfoToolbar");
  if (featureInfoEl) {
    featureInfoOverlay = new ol.Overlay({
      element: featureInfoEl,
      positioning: "bottom-center",
      offset: [0, -16],
      stopEvent: true
    });
    map.addOverlay(featureInfoOverlay);
  }

  document.getElementById("parcelActionLogActivityBtn")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (selectedFeature && selectedLayerType) openLogActivityModal(selectedFeature, selectedLayerType);
  });
  document.getElementById("parcelActionLogAlertBtn")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (selectedFeature && selectedLayerType) openLogAlertModal(selectedFeature, selectedLayerType);
  });
  // Replaces the old round "i" button — same destination, now a plain link
  // under the summary.
  document.getElementById("parcelActionMoreBtn")?.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (selectedFeature && selectedLayerType) openFeatureInfoPanel(selectedFeature, selectedLayerType);
  });

  // The Alerts row is a button only when there are open alerts, and the rows
  // are re-rendered on every selection — so this is delegated from the
  // container rather than bound to an element that keeps being replaced.
  document.getElementById("parcelActionSummary")?.addEventListener("click", (ev) => {
    if (!ev.target.closest("[data-open-alerts]")) return;
    ev.stopPropagation();
    if (selectedFeature && selectedLayerType === "PARCELS") {
      openAlertsListModal(selectedFeature.getId(), selectedFeature.get("parcel_name"));
    }
  });
}

/**
 * Legend window (windows/legend-panel.html), opened from the Legend button
 * next to the Layers control. Rows are built from CULTIVATION_PALETTE +
 * CULTIVATION_STATUS_LABELS (the same objects the map's own parcel/block
 * styling reads from — see cultivationKeyFromFeature) rather than
 * hardcoded in HTML, so the swatches shown here can never drift out of
 * sync with what's actually drawn on the map. Future rows (roads, houses,
 * trenches, trees, powerlines, etc. — see the user's request) can be
 * appended the same way, each as its own .legend-panel__section.
 */
/**
 * Builds the Legend panel — the same four groups the printed legend uses
 * (see buildLegendGroups in js/print-tool.js), from the same constants the
 * map styles itself with, so the panel, the map and the PDF can't disagree.
 *
 * The one deliberate difference from the PDF: the printed legend lists only
 * the feature types that fall inside the selected print area, whereas this
 * panel lists every type present anywhere on the map — you're looking at
 * the whole map, so the key should cover the whole map.
 *
 * Symbol kinds mirror how each thing is actually drawn:
 *   poly  — square, hollow or filled, solid or dashed edge
 *   line  — short rule in the type's colour/line style
 *   icon  — the feature type's own Font Awesome glyph
 */
function buildLegendList() {
  const root = document.getElementById("legendGroups");
  if (!root) return;
  root.innerHTML = "";

  const groups = [];

  // 1. Land properties — how each land layer is drawn on the map.
  groups.push({
    title: "Land properties",
    items: [
      { label: "Estate", sym: { kind: "poly", stroke: "#D76213", dashed: true } },
      { label: "Block", sym: { kind: "poly", stroke: "#d32f2f" } },
      { label: "Plot", sym: { kind: "poly", stroke: "#2e7d32" } },
      { label: "Land Title", sym: { kind: "poly", stroke: "#7b1fa2", dashed: true } }
    ]
  });

  // 2. Plot status. Vacant's palette fill is fully transparent, so it shows
  //    as a hollow box here exactly as it prints and draws.
  groups.push({
    title: "Plot status",
    items: Object.keys(CULTIVATION_STATUS_LABELS).map((key) => {
      const palette = CULTIVATION_PALETTE[key] || {};
      return {
        label: CULTIVATION_STATUS_LABELS[key],
        sym: { kind: "poly", fill: palette.fill, stroke: palette.stroke }
      };
    })
  });

  // 3. Alerts — the three severities.
  groups.push({
    title: "Alerts",
    items: Object.keys(ALERT_SEVERITY_COLORS).map((key) => ({
      label: SEVERITY_LABELS[key] || key,
      sym: {
        kind: "poly",
        fill: ALERT_SEVERITY_FILL?.[key] || ALERT_SEVERITY_COLORS[key],
        stroke: ALERT_SEVERITY_COLORS[key]
      }
    }))
  });

  // 4. Features — every type drawn anywhere on the map, deduped by type.
  const featureItems = [];
  const seenTypes = new Map();
  surveyDrawApi?.getFeaturesLayer?.()?.getSource()?.forEachFeature((f) => {
    const id = f.get("_typeId");
    const key = id == null ? (f.get("_typeName") || "?") : id;
    if (seenTypes.has(key)) return;
    const kind = (f.getGeometry()?.getType() || "").toLowerCase();
    const color = f.get("_color") || "#3f8f3f";
    seenTypes.set(key, true);
    featureItems.push({
      label: f.get("_typeName") || "Feature",
      sym: kind.includes("point")
        ? { kind: "icon", icon: f.get("_icon") || "fa-circle-dot", stroke: color }
        : kind.includes("line")
          ? { kind: "line", stroke: color, dashed: isDashedLinetype(f.get("_linetype")) }
          : { kind: "poly", fill: hexToTranslucent(color, 0.35), stroke: color,
              dashed: isDashedLinetype(f.get("_linetype")) }
    });
  });
  featureItems.sort((a, b) => a.label.localeCompare(b.label));
  if (featureItems.length) groups.push({ title: "Features", items: featureItems });

  groups.forEach((g) => {
    const section = document.createElement("div");
    section.className = "legend-panel__section";

    const heading = document.createElement("h3");
    heading.className = "legend-panel__heading";
    heading.textContent = g.title;
    section.appendChild(heading);

    const ul = document.createElement("ul");
    ul.className = "legend-panel__list";
    g.items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "legend-panel__item";
      li.appendChild(buildLegendSwatch(item.sym));
      const label = document.createElement("span");
      label.textContent = item.label;
      li.appendChild(label);
      ul.appendChild(li);
    });

    section.appendChild(ul);
    root.appendChild(section);
  });
}

/** vsl_feature_type.linetype -> dashed or not. The column is all NULL
 *  today, so everything draws solid until it's populated. */
function isDashedLinetype(linetype) {
  const t = String(linetype || "").toLowerCase();
  return t.includes("dash") || t.includes("dot");
}

/** "#rrggbb" -> "rgba(r,g,b,a)" for the translucent polygon-feature fill
 *  (features are drawn at 0.18 alpha on the map; a little stronger reads
 *  better in a 16px swatch). */
function hexToTranslucent(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
  if (!m) return hex;
  const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** One legend swatch, drawn per its symbol kind. */
function buildLegendSwatch(sym) {
  if (sym.kind === "icon") {
    const el = document.createElement("span");
    el.className = "legend-panel__sym legend-panel__sym--icon";
    el.style.color = sym.stroke;
    el.innerHTML = `<i class="fas ${sym.icon}" aria-hidden="true"></i>`;
    return el;
  }
  if (sym.kind === "line") {
    const el = document.createElement("span");
    el.className = "legend-panel__sym legend-panel__sym--line";
    el.style.borderTopColor = sym.stroke;
    el.style.borderTopStyle = sym.dashed ? "dashed" : "solid";
    return el;
  }
  const el = document.createElement("span");
  el.className = "legend-panel__sym legend-panel__swatch";
  el.style.background = sym.fill || "transparent";
  el.style.borderColor = sym.stroke || "rgba(0,0,0,0.25)";
  el.style.borderStyle = sym.dashed ? "dashed" : "solid";
  return el;
}

// js/print-tool.js builds its own legend independently (buildLegendGroups)
// rather than scraping this one's DOM, but keeps calling this hook so the
// panel is rebuilt/kept in sync when a print is produced.
window.vslBuildLegendList = buildLegendList;

function closeLegendPanel() {
  const panel = document.getElementById("legendPanel");
  const btn = document.getElementById("legendBtn");
  if (panel) panel.hidden = true;
  btn?.classList.remove("active");
  btn?.setAttribute("aria-expanded", "false");
}

function openLegendPanel() {
  const panel = document.getElementById("legendPanel");
  const btn = document.getElementById("legendBtn");
  if (!panel) return;
  buildLegendList();
  panel.hidden = false;
  btn?.classList.add("active");
  btn?.setAttribute("aria-expanded", "true");
}

// ---------------------------------------------------------------------------
// Left tool stack — collapse/expand
//
// Collapsing hides the labels only; the icon rail stays put, so every tool
// is still one click away. Phones start collapsed (a 7-row labelled panel
// eats most of a small screen), desktops start expanded.
//
// The person's own choice wins over the width-based default once they make
// one, and is remembered across visits. Resizing the window afterwards
// doesn't fight them — the breakpoint only ever decides the FIRST state.
// ---------------------------------------------------------------------------
/** Remembered SEPARATELY per breakpoint.
 *
 *  With one shared key, expanding the stack once on a desktop wrote
 *  "expanded" for every device, so the same account then opened expanded on
 *  a phone — the mobile default never got a chance to apply. Two keys means
 *  "collapsed on mobile, expanded on desktop" stays true no matter what was
 *  toggled on the other one, while an explicit choice on this device is
 *  still remembered. */
const TOOL_STACK_COLLAPSE_KEY_MOBILE = "vsl.toolStack.collapsed.mobile";
const TOOL_STACK_COLLAPSE_KEY_DESKTOP = "vsl.toolStack.collapsed.desktop";
/** Matches the phone-width media queries used elsewhere in styles.css. */
const TOOL_STACK_MOBILE_MAX_PX = 900;
/** Left gap kept when the stack is hidden entirely (drafting mode) — the
 *  same 8px the phone layout already uses for the docked column. */
const TOOL_STACK_HIDDEN_LEFT_PX = 8;

function setupToolStackCollapse() {
  const stack = document.getElementById("mapLeftBtnStack");
  const toggle = document.getElementById("mapToolStackToggle");
  if (!stack || !toggle) return;

  const isMobile = () => window.innerWidth <= TOOL_STACK_MOBILE_MAX_PX;
  const storageKey = () =>
    isMobile() ? TOOL_STACK_COLLAPSE_KEY_MOBILE : TOOL_STACK_COLLAPSE_KEY_DESKTOP;

  // localStorage can throw outright in a locked-down/private context, so
  // every access is guarded — a failure here just means "no memory", never
  // a broken toolbar.
  const readSaved = () => {
    try { return window.localStorage?.getItem(storageKey()); } catch { return null; }
  };
  const writeSaved = (v) => {
    try { window.localStorage?.setItem(storageKey(), v ? "1" : "0"); } catch { /* not available */ }
  };

  /** Pushes the docked-window column clear of the stack.
   *
   *  .map-left-stack (Search, Survey, Measure, Select, …) is a fixed-position
   *  sibling that opens to the right of this stack, so it can't discover the
   *  stack's width in CSS alone. Measuring is better than hardcoding two
   *  numbers: it stays correct if a label is renamed, a button is added, or
   *  the font renders wider than expected. */
  function syncDockOffset() {
    // Read after layout has settled, or a just-collapsed stack still
    // measures at its expanded width.
    requestAnimationFrame(() => {
      // Drafting mode (Measure's pick tool, Survey's Draw/Edit tabs) hides
      // the stack outright via enterDraftingMode(). A hidden stack measures
      // 0 wide, and reserving room for something that isn't on screen is
      // exactly the gap that used to sit to the left of the Measure window.
      const width = stack.hasAttribute("hidden") ? 0 : stack.getBoundingClientRect().width;
      const left = width
        // 16px is .map-btn-stack--left's own `left`, plus 12px of breathing room.
        ? Math.round(width + 16 + 12)
        : TOOL_STACK_HIDDEN_LEFT_PX;
      document.body.style.setProperty("--vsl-tool-stack-left", `${left}px`);
      map?.updateSize();
    });
  }

  // enterDraftingMode()/exitDraftingMode() set and clear the stack's
  // `hidden` attribute directly, and they're called from several modules
  // (map-app, survey-draw, survey-edit). Watching the attribute means the
  // offset follows automatically from all of them, rather than each having
  // to remember to call back in here.
  new MutationObserver(syncDockOffset).observe(stack, {
    attributes: true,
    attributeFilter: ["hidden"]
  });

  function apply(collapsed) {
    stack.classList.toggle("is-collapsed", collapsed);
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    toggle.title = collapsed ? "Expand tools" : "Collapse tools";
    toggle.setAttribute("aria-label", toggle.title);
    // The caret points the way the panel will MOVE: left to fold it away,
    // right to bring it back out.
    const icon = toggle.querySelector("i");
    if (icon) {
      icon.classList.toggle("fa-square-caret-right", collapsed);
      icon.classList.toggle("fa-square-caret-left", !collapsed);
    }
    syncDockOffset();
  }

  const saved = readSaved();
  apply(saved === null ? isMobile() : saved === "1");

  syncPanelToggleState();

  toggle.addEventListener("click", () => {
    const next = !stack.classList.contains("is-collapsed");
    apply(next);
    writeSaved(next);
  });
}

/**
 * Mirrors a panel's visibility onto its tool-stack button, so every tool
 * shows the same "this window is open" state.
 *
 * Search, Select and Print already maintain `.active` themselves, and
 * Survey maintains `.uam-open` (which the stylesheet treats identically).
 * Measure and Feature Info maintained nothing — and both are toggled from
 * several places by assigning `.hidden` directly, so rather than editing
 * every one of those call sites (and hoping the next one remembers), this
 * watches the panels themselves. Any future code that shows or hides them,
 * by any route, keeps the button honest for free.
 */
function syncPanelToggleState() {
  const pairs = [
    ["measurePanel", "measureTopBtn"],
    ["featureInfoOverlay", "mapFeatureInfoBtn"]
  ];
  for (const [panelId, btnId] of pairs) {
    const panel = document.getElementById(panelId);
    const btn = document.getElementById(btnId);
    if (!panel || !btn) continue;
    const sync = () => btn.classList.toggle("active", !panel.hidden);
    sync();
    new MutationObserver(sync).observe(panel, {
      attributes: true,
      attributeFilter: ["hidden"]
    });
  }
}

// ---------------------------------------------------------------------------
// Messages panel (windows/messages-panel.html)
//
// UI ONLY at this stage — nothing here sends, receives or stores a message.
// What IS wired: open/close, Escape to close, the composer's auto-grow, and
// enabling Send only once something has been typed. The thread renders its
// empty state and is otherwise untouched.
// ---------------------------------------------------------------------------
function setupMessagesPanel() {
  const panel = document.getElementById("messagesPanel");
  const btn = document.getElementById("messagesBtn");
  const closeBtn = document.getElementById("messagesCloseBtn");
  const input = document.getElementById("messagesInput");
  const sendBtn = document.getElementById("messagesSendBtn");
  if (!panel || !btn) return;

  function setOpen(open) {
    panel.hidden = !open;
    btn.classList.toggle("active", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) input?.focus();
  }

  btn.addEventListener("click", () => setOpen(panel.hidden));
  closeBtn?.addEventListener("click", () => setOpen(false));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) setOpen(false);
  });

  // Auto-grow: reset to `auto` first so the box can SHRINK again when text
  // is deleted — scrollHeight only ever reports the content height for the
  // current box, so measuring without the reset would ratchet upwards.
  // The CSS max-height then takes over and it scrolls.
  function autoGrow() {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }

  input?.addEventListener("input", () => {
    autoGrow();
    if (sendBtn) sendBtn.disabled = !input.value.trim();
  });

  // Enter sends, Shift+Enter makes a new line — the chat convention. No-op
  // beyond preventing the newline until there's sending logic to call.
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) e.preventDefault();
  });
}

function setupLegendPanel() {
  const btn = document.getElementById("legendBtn");
  const closeBtn = document.getElementById("legendCloseBtn");

  btn?.addEventListener("click", () => {
    const panel = document.getElementById("legendPanel");
    if (panel && !panel.hidden) closeLegendPanel();
    else openLegendPanel();
  });
  closeBtn?.addEventListener("click", closeLegendPanel);
}

// popWinHead's icon/title are static markup, so the layer type needs to be
// pushed into them explicitly each time a different feature is clicked.
function setFeatureInfoHeader(layerType) {
  const iconEl = document.querySelector("#featureInfoPanelIcon i");
  const titleEl = document.getElementById("featureInfoPanelTitle");
  const iconClass = layerType === "PARCELS" ? "fas fa-map" : layerType === "BLOCKS" ? "fas fa-cubes" : "fas fa-city";
  if (iconEl) iconEl.className = iconClass;
  if (titleEl) titleEl.textContent = FEATURE_INFO_BADGE[layerType] || "Feature";
}

function setupInfoPopup() {
  const inner = document.getElementById("featureInfoPanelInner");
  const overlay = document.getElementById("featureInfoOverlay");
  const closeBtn = document.getElementById("featureInfoPanelCloseBtn");
  if (!inner || !overlay) return;

  closeBtn?.addEventListener("click", () => {
    closeInfoPopup();
    selectedFeature = null;
    selectedLayerType = null;
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!overlay.hidden) {
      closeInfoPopup();
      selectedFeature = null;
      selectedLayerType = null;
    }
  });

  // Plain map click: select the feature and show the selection toolbar only.
  // The (now read-only, grouped) info panel opens exclusively via the
  // toolbar's info button — see openFeatureInfoPanel(), wired in
  // setupParcelActionToolbar(). Editing lives in the separate Edit Details
  // modal (top-toolbar "Modify" button), unaffected by this.
  map.on("click", (evt) => {
    if (activeInteraction) return; // do not popup when measuring or drawing
    if (!parcelClickSelectionEnabled) return; // Survey Edit/Draw session in progress — see window.vslSetParcelClickEnabled

    if (document.getElementById("coordExtractDrawer")?.dataset.picking === "1") {
      return;
    }

    if (tryParcelStatusMapClick(evt)) {
      return;
    }

    selectedFeature = null;
    selectedLayerType = null;
    closeInfoPopup(); // hides the info panel (if open) and the selection toolbar

    // Drawn features (trees, roads, walls) are checked FIRST and on their
    // own: they sit above the plots and blocks on the map, so a tap that
    // lands on one should read as picking that feature, not the plot it
    // happens to stand in.
    const drawnFeaturesLayer = surveyDrawApi?.getFeaturesLayer?.();
    if (drawnFeaturesLayer) {
      let drawnHit = null;
      map.forEachFeatureAtPixel(
        evt.pixel,
        (feature) => {
          drawnHit = feature;
          return true;
        },
        { layerFilter: (layer) => layer === drawnFeaturesLayer, hitTolerance: 12 }
      );
      if (drawnHit) {
        showFeatureInfoToolbar(drawnHit);
        return;
      }
    }

    map.forEachFeatureAtPixel(
      evt.pixel,
      (feature, layer) => {
        const isBlocks = layer === blocksLayer;
        const isParcels = layer === parcelsLayer;
        if (!isBlocks && !isParcels) return false;

        selectedFeature = feature;
        selectedLayerType = isBlocks ? "BLOCKS" : "PARCELS";
        showParcelActionToolbar(feature);

        // The Alerts List modal used to open by clicking the on-map
        // "Alerts(n)" text line. That line is gone (see the parcels style
        // function); the popup's own Alerts row opens it instead.
        return true;
      },
      { layerFilter: (layer) => layer === blocksLayer || layer === parcelsLayer, hitTolerance: 20 }
    );
  });

  setupFeatureInfoFilterBar();
  setupFeatureInfoActionFooter();

  // Standalone floating button (below .dashboard-btn) — opens the panel
  // for manual Estate/Block/Plot browsing, no map click needed.
  document.getElementById("mapFeatureInfoBtn")?.addEventListener("click", () => {
    openFeatureInfoPanelManual();
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

// ---------------------------------------------------------------------------
// Offline land cache
//
// The map draws from whatever is in IndexedDB before it asks the network for
// anything, so a device with one bar shows its boundaries immediately instead
// of waiting on a request that may never answer. Freshness is settled by a
// counter in the database (public.vsl_sync_version), bumped by a trigger on
// every insert, update and delete across estates, blocks, plots, features and
// titles. The client keeps the version it downloaded; when the two differ it
// re-downloads in the background.
//
// No polling. The version is checked when the app opens, when the browser
// says it's back online, and on refocus if the last check is stale — enough
// to catch a long field session without a timer running all day.
// ---------------------------------------------------------------------------

/** How long a version check stays "recent enough" that returning to the tab
 *  doesn't trigger another one. */
const LAND_CACHE_RECHECK_MS = 10 * 60 * 1000;

const landCacheState = {
  /** ISO timestamp of the cached rows currently drawn, for the status line. */
  savedAt: null,
  /** Version of the rows currently in the cache. */
  version: null,
  /** Epoch ms of the last completed version check. */
  lastCheck: 0,
  /** Guards against two checks overlapping (open + online can fire together). */
  busy: false
};

/** "Land data saved 14:20 — showing the offline copy", or "" when the cache
 *  isn't what's on screen. Used only to explain a failed network load. */
function landCacheStatusText() {
  if (!landCacheState.savedAt) return "";
  const when = new Date(landCacheState.savedAt);
  const time = Number.isNaN(when.getTime())
    ? ""
    : when.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
  return `Offline copy of the land data${time ? ` from ${time}` : ""} — reconnect to refresh.`;
}

/** The server's current land version, or null when it can't be reached. */
async function fetchServerLandVersion() {
  const { data, error } = await supabase
    .from("vsl_sync_version")
    .select("version")
    .eq("dataset", "land")
    .maybeSingle();
  if (error || !data) return null;
  return Number(data.version);
}

/**
 * Draws the cached boundaries, if there are any. Called before the first
 * network request so there's something on screen straight away.
 */
async function drawLandFromCache() {
  const cached = await readLandCache();
  if (!cached) return false;
  landCacheState.savedAt = cached.savedAt;
  landCacheState.version = cached.version;
  const n = drawLandRows(cached.rows);
  if (cfg.DEBUG_MAP_RPC && window.console?.debug) {
    console.debug(`[Victoria map] Drew ${n} feature(s) from the land cache (version ${cached.version}).`);
  }
  return n > 0;
}

/**
 * Compares the cached version against the server's and re-downloads if they
 * differ. Safe to call whenever; does nothing when already current, already
 * running, or offline.
 *
 * Never awaited by the render path — the whole point is that the map is
 * already usable while this happens.
 */
async function syncLandCache({ force = false } = {}) {
  if (landCacheState.busy) return;
  if (!navigator.onLine && !force) return;
  landCacheState.busy = true;
  try {
    // Version first, snapshot second. The other order can pair a new version
    // number with older rows and then never notice it's stale — see the
    // comment on vsl_land_snapshot.
    const serverVersion = await fetchServerLandVersion();
    landCacheState.lastCheck = Date.now();
    if (serverVersion === null) return; // offline or blocked; cache stands
    if (!force && serverVersion === landCacheState.version) return;

    const { data, error } = await supabase.rpc("vsl_land_snapshot");
    if (error || !Array.isArray(data)) {
      console.warn("[Victoria map] Land snapshot failed:", error?.message);
      return;
    }

    // Only written once every row is in hand — a partial cache would look
    // authoritative and hide plots that exist.
    await writeLandCache(serverVersion, data);
    landCacheState.version = serverVersion;
    landCacheState.savedAt = new Date().toISOString();
    if (cfg.DEBUG_MAP_RPC && window.console?.debug) {
      console.debug(`[Victoria map] Land cache updated to version ${serverVersion} (${data.length} rows).`);
    }
    // The visible layers are bbox-filtered, so they're refreshed from the
    // network rather than redrawn wholesale from what was just cached.
    await loadLayersFromDb();
  } catch (e) {
    console.warn("[Victoria map] Land cache sync failed:", e);
  } finally {
    landCacheState.busy = false;
  }
}

/** The three moments worth re-checking, per the note at the top. */
function setupLandCacheSync() {
  window.addEventListener("online", () => syncLandCache());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - landCacheState.lastCheck < LAND_CACHE_RECHECK_MS) return;
    syncLandCache();
  });
  // Any edit made in this tab invalidates the cache immediately — no need to
  // wait for a reload to notice our own change.
  ["vsl-features-changed", "vsl-estates-changed", "vsl-feature-types-changed"].forEach((evt) => {
    window.addEventListener(evt, () => syncLandCache({ force: true }));
  });
}

/**
 * Puts a set of vsl_get_features_bbox-shaped rows onto the three land
 * layers, replacing whatever was there.
 *
 * Split out of loadLayersFromDb because the cache path (js/land-cache.js)
 * feeds in exactly the same row shape — vsl_land_snapshot is literally
 * vsl_get_features_bbox over the whole world — and both must draw it the
 * same way. Returns how many features were actually rendered.
 */
function drawLandRows(rows) {
  blocksSource.clear(true);
  parcelsSource.clear(true);
  titlesSource.clear(true);

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
  for (const row of rows || []) {
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
    if (row.layer_type === "TITLES") titlesSource.addFeature(feature);
    n += 1;
  }
  return n;
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
    // Offline or a flaky link. Whatever is already drawn came from the cache
    // at startup and is better than an empty map, so it's left alone — this
    // only reports, it doesn't clear.
    console.warn("[Victoria map] bbox load failed, keeping what's drawn:", error.message);
    setStatus(statusEl, landCacheStatusText() || `Layer load failed: ${error.message}`, true);
    return;
  }

  const n = drawLandRows(data);
  if (cfg.DEBUG_MAP_RPC && window.console?.debug) {
    console.debug(`[Victoria map] vsl_get_features_bbox: ${n} feature(s) drawn, ${(data || []).length} row(s) from API`);
  }

  await refreshParcelAlertBadges();
}

/**
 * Populates the "_alert_severity"/"_alert_count" feature properties that the
 * parcels layer's style function reads to render the severity-colored
 * "Alerts(n)" text line below the name/area/ratoon label — only unresolved
 * (open/investigating) vsl_alerts rows count, so a plot with no active
 * alerts (or only resolved ones) simply gets no alerts line at all.
 * Severity shown is the highest-ranked one present (critical > warning >
 * information). Called after every bbox reload and right after logging a
 * new alert.
 */
async function refreshParcelAlertBadges() {
  // A block popup's alert figure is derived from its plots' alerts, so this
  // is exactly the moment those cached totals stop being trustworthy.
  blockPopupExtras.clear();

  const features = parcelsSource.getFeatures();
  if (!features.length) return;

  const idByKey = new Map();
  for (const f of features) {
    const id = f.getId();
    if (id != null) idByKey.set(String(id), f);
  }
  const ids = Array.from(idByKey.keys());
  if (!ids.length) return;

  const { data, error } = await supabase
    .from("vsl_alerts")
    .select("target_id, severity, status")
    .eq("layer_type", "PARCELS")
    .neq("status", "resolved")
    .in("target_id", ids);

  if (error) {
    console.error("[Victoria] Failed to load parcel alert badges:", error.message);
    return;
  }

  const SEVERITY_RANK = { critical: 3, warning: 2, information: 1 };
  const summary = new Map(); // target_id -> { count, severity, rank }
  for (const row of data || []) {
    const key = String(row.target_id);
    const rank = SEVERITY_RANK[row.severity] || 0;
    const existing = summary.get(key);
    if (!existing) {
      summary.set(key, { count: 1, severity: row.severity, rank });
    } else {
      existing.count += 1;
      if (rank > existing.rank) {
        existing.severity = row.severity;
        existing.rank = rank;
      }
    }
  }

  for (const [key, feature] of idByKey) {
    const s = summary.get(key);
    if (s) {
      feature.set("_alert_severity", s.severity, true);
      feature.set("_alert_count", s.count, true);
    } else {
      feature.unset("_alert_severity", true);
      feature.unset("_alert_count", true);
    }
  }
  parcelsLayer.changed();
}

function clearSearchHighlight() {
  searchHighlight.blockId = null;
  searchHighlight.parcelId = null;
  // The Feature tab's halo is owned by survey-draw.js's layer, not by the
  // block/parcel styles below, so it has to be cleared through its own hook.
  surveyDrawApi?.setHighlightedFeatures?.([]);
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
  // Survey now docks in the same .map-left-stack column (see
  // windows/survey-panel.html) instead of floating as its own overlay, so
  // it needs to be explicitly closed here too or both panels would stack
  // in the column at once.
  closeUAM();
  // Measure moved into the same column too (see app-boot.js) — same reason.
  if (measurePanel) measurePanel.hidden = true;
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
  window.vslClosePrintPanel?.();
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
  const tabs = ["parcel", "feature", "place", "coords"];
  const tabElMap = { coords: "tabCoords", parcel: "tabParcel", feature: "tabFeature", place: "tabPlace", extract: "tabExtract" };
  const bodyElMap = { coords: "searchTabCoords", parcel: "searchTabParcel", feature: "searchTabFeature", place: "searchTabPlace", extract: "searchTabExtract" };
  tabs.forEach((t) => {
    const tabEl = document.getElementById(tabElMap[t]);
    const bodyEl = document.getElementById(bodyElMap[t]);
    const active = t === tab;
    if (tabEl) tabEl.setAttribute("aria-selected", String(active));
    if (bodyEl) bodyEl.hidden = !active;
  });
  activeSearchTabId = tab;
  // The Feature tab's options come from what's currently drawn on the map,
  // so rebuild them each time it's shown rather than trusting a snapshot
  // taken at startup.
  if (tab === "feature") refreshFeatureSearchOptions?.();
}

function setupSearchTabSwitching() {
  ["tabCoords", "tabParcel", "tabFeature", "tabPlace", "tabExtract"].forEach((id) => {
    const btn = document.getElementById(id);
    btn?.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      if (tab) activateSearchTab(tab);
    });
  });
}

// Resets the Place-search tab (no dedicated "clear" button of its own
// pre-existing, unlike Parcel/Coords) — empties the query, hides results,
// and clears any error message.
function clearPlaceSearch() {
  const input = document.getElementById("placeSearchInput");
  if (input) input.value = "";
  setPlaceSearchError("");
  const ul = document.getElementById("placeSearchResults");
  if (ul) {
    ul.innerHTML = "";
    ul.hidden = true;
  }
}

// One shared Clear + Go pair in the search panel's footer (see
// windows/search-panel.html) forwards its clicks to whichever tab is
// currently active, instead of each tab having its own button pair. The
// original per-tab buttons stay in the DOM (hidden) so their existing
// listeners — runLocateParcelFromPopover() / runPlaceSearchQuery() /
// coord-search-drawer.js's own wiring — don't need to be duplicated here.
function setupUnifiedSearchActionButtons() {
  const goBtn = document.getElementById("searchGoBtn");
  const clearBtn = document.getElementById("searchClearBtn");
  const goBtnIdByTab = {
    parcel: "parcelSearchGoBtn",
    feature: "featureSearchGoBtn",
    place: "placeSearchGoBtn",
    coords: "coordPlotSingleBtn"
  };
  const clearBtnIdByTab = {
    parcel: "parcelSearchPopoverCancelBtn",
    feature: "featureSearchClearBtn",
    coords: "coordClearMarkersBtn"
  };

  goBtn?.addEventListener("click", () => {
    document.getElementById(goBtnIdByTab[activeSearchTabId])?.click();
  });
  clearBtn?.addEventListener("click", () => {
    const proxyId = clearBtnIdByTab[activeSearchTabId];
    if (proxyId) document.getElementById(proxyId)?.click();
    else clearPlaceSearch(); // "place" tab has no proxy clear button — clear its own state directly
  });
}

// ── Feature search (Search window → Feature tab) ───────────────────────────
// Finds already-drawn features (vsl_feature — trees, roads, walls, …) and
// zooms to them. Unlike the Block/Plot tab there's no RPC involved: every
// feature is already on the map in survey-draw.js's features layer, geometry
// and all, so the three dropdowns are built straight from that source. Which
// also means they can never drift from what's actually drawn.
function setupFeatureSearch() {
  const kindSelect = document.getElementById("featureKindSelect");
  const typeSelect = document.getElementById("featureTypeSelect");
  const nameSelect = document.getElementById("featureNameSelect");
  const goBtn = document.getElementById("featureSearchGoBtn");
  const clearBtn = document.getElementById("featureSearchClearBtn");
  const errorEl = document.getElementById("featureSearchError");
  if (!kindSelect || !typeSelect || !nameSelect) return;

  function setFeatureSearchError(msg) {
    if (!errorEl) return;
    errorEl.textContent = msg || "";
    errorEl.hidden = !msg;
  }

  // OL geometry type -> the vsl_feature_type.geometry_kind vocabulary the
  // Kind dropdown uses.
  function kindOfGeometry(type) {
    if (type === "Point" || type === "MultiPoint") return "point";
    if (type === "LineString" || type === "MultiLineString") return "line";
    return "polygon";
  }

  function allEntries() {
    const source = surveyDrawApi?.getFeaturesSource?.();
    if (!source) return [];
    return source.getFeatures().map((f) => ({
      id: f.getId(),
      name: f.get("_name") || "",
      typeId: f.get("_typeId"),
      typeName: f.get("_typeName") || "",
      kind: kindOfGeometry(f.getGeometry()?.getType()),
      olFeature: f
    }));
  }

  // Each dropdown narrows the ones after it, but none of them is required —
  // "Any" at every level means Go zooms to everything drawn.
  function matching({ includeName = true } = {}) {
    const kind = kindSelect.value;
    const typeId = typeSelect.value;
    const featureId = includeName ? nameSelect.value : "";
    return allEntries().filter((e) => {
      if (kind && e.kind !== kind) return false;
      if (typeId && String(e.typeId) !== String(typeId)) return false;
      if (featureId && String(e.id) !== String(featureId)) return false;
      return true;
    });
  }

  function fillSelect(select, options, anyLabel) {
    const keep = select.value;
    select.innerHTML =
      `<option value="">${anyLabel}</option>` +
      options.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");
    if (keep && options.some((o) => String(o.value) === keep)) select.value = keep;
  }

  function refreshTypeOptions() {
    const kind = kindSelect.value;
    const seen = new Map();
    for (const e of allEntries()) {
      if (kind && e.kind !== kind) continue;
      if (e.typeId != null && !seen.has(String(e.typeId))) {
        seen.set(String(e.typeId), { value: e.typeId, label: e.typeName || `Type ${e.typeId}` });
      }
    }
    const options = [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
    fillSelect(typeSelect, options, "— Any Type —");
  }

  function refreshNameOptions() {
    // Unnamed features still need to be selectable — fall back to their type
    // name so the option isn't blank.
    const options = matching({ includeName: false })
      .map((e) => ({ value: e.id, label: e.name || `(unnamed ${e.typeName || "feature"})` }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    fillSelect(nameSelect, options, "— Any Name —");
  }

  function refreshAll() {
    refreshTypeOptions();
    refreshNameOptions();
  }
  refreshFeatureSearchOptions = refreshAll;

  kindSelect.addEventListener("change", () => {
    // A type only belongs to one kind, so a kind switch invalidates both
    // downstream picks.
    typeSelect.value = "";
    nameSelect.value = "";
    refreshAll();
    setFeatureSearchError("");
  });
  typeSelect.addEventListener("change", () => {
    nameSelect.value = "";
    refreshNameOptions();
    setFeatureSearchError("");
  });
  nameSelect.addEventListener("change", () => setFeatureSearchError(""));

  // Drawing, editing or deleting a feature changes what's searchable.
  window.addEventListener("vsl-features-changed", () => refreshAll());

  goBtn?.addEventListener("click", () => {
    setFeatureSearchError("");
    const hits = matching();
    if (!hits.length) {
      setFeatureSearchError(
        allEntries().length ? "No features match those filters." : "No features have been drawn yet."
      );
      return;
    }

    const combined = ol.extent.createEmpty();
    for (const hit of hits) {
      const geom = hit.olFeature.getGeometry();
      if (geom) ol.extent.extend(combined, geom.getExtent());
    }
    if (ol.extent.isEmpty(combined)) {
      setFeatureSearchError("Those features have no geometry to zoom to.");
      return;
    }

    surveyDrawApi?.setHighlightedFeatures?.(hits.map((h) => h.id));

    // Same framing as the Block/Plot tab's fit — keep the panel itself from
    // covering what was just zoomed to.
    const dockEl = document.getElementById("searchPanel");
    let leftPad = 96;
    if (dockEl && !dockEl.hidden) {
      const w = dockEl.getBoundingClientRect().width;
      if (w > 0) leftPad = Math.min(360, Math.round(w + 24));
    }
    const fitOpts = { padding: [88, 96, 96, leftPad], maxZoom: 19, duration: 1350 };
    if (ol.easing && typeof ol.easing.easeOut === "function") fitOpts.easing = ol.easing.easeOut;
    map.getView().fit(combined, fitOpts);

    const one = hits.length === 1 ? hits[0] : null;
    setStatus(
      statusEl,
      one
        ? `${one.name || one.typeName || "Feature"} — highlighted on the map.`
        : `${hits.length} features highlighted on the map.`
    );
  });

  clearBtn?.addEventListener("click", () => {
    kindSelect.value = "";
    typeSelect.value = "";
    nameSelect.value = "";
    refreshAll();
    setFeatureSearchError("");
    surveyDrawApi?.setHighlightedFeatures?.([]);
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
  const estateSelect = document.getElementById("searchEstateSelect");
  const blockSelect = document.getElementById("searchBlockSelect");
  const parcelSelect = document.getElementById("searchParcelSelect");

  const blockInput = document.getElementById("parcelSearchBlockInput");
  const noInput = document.getElementById("parcelSearchNoInput");
  const goBtn = document.getElementById("parcelSearchGoBtn");
  const cancelBtn = document.getElementById("parcelSearchPopoverCancelBtn");

  // Block dropdown option values are the block's UUID (unique across every
  // estate) — prefer that so blocks that share a code/name across different
  // estates (e.g. two "BLOCK1"s) can never resolve to the wrong one.
  let blockId = "";
  let blockQ = "";
  let estateId = "";
  if (blockSelect && blockSelect.value) {
    blockId = blockSelect.value;
  }
  if (!blockId) {
    // Legacy free-text fallback (no dropdown selection made) — scope by the
    // selected estate too, when we have one, so a duplicate code/name in a
    // different estate can't be picked instead.
    blockQ = blockInput?.value?.trim() ?? "";
    estateId = estateSelect?.value || "";
  }

  // Read plot/parcel number (prioritize dropdown, fallback to text input)
  let plotStr = "";
  if (parcelSelect && parcelSelect.value) {
    plotStr = parcelSelect.value;
  }
  if (!plotStr) {
    plotStr = noInput?.value?.trim() ?? "";
  }

  let parcelCode = null;
  if (plotStr !== "") {
    parcelCode = plotStr;
  }

  setParcelSearchPopoverError("");
  if (!blockId && !blockQ) {
    setParcelSearchPopoverError("Select a block, or enter a block code or block name.");
    return;
  }

  goBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;

  const { data, error } = await supabase.rpc("vsl_locate_parcel", {
    p_block_query: blockQ || null,
    p_parcel_code: parcelCode,
    p_block_id: blockId || null,
    p_estate_id: estateId ? Number(estateId) : null
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
          `Block ${bc}, plot ${data.parcel.parcel_code} — highlighted on the map.`
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
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_estate?select=id,estate_name&order=estate_name.asc`;
      const res = await fetch(url, {
        headers: { "apikey": cfg.SUPABASE_ANON_KEY, "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}`, "Accept": "application/json" }
      });
      if (!res.ok) return;
      const data = await res.json();
      estateSelect.innerHTML = '<option value="">— Select Estate —</option>';
      data.forEach(e => {
        const o = document.createElement("option"); o.value = e.id; o.textContent = e.estate_name;
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
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_blocks?select=id,block_code,block_name&estate_id=eq.${encodeURIComponent(estate)}`;
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
        o.textContent = b.block_name || `Block ${b.block_code}`;
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
      let url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_parcels?select=id,parcel_code,parcel_name&block_id=eq.${encodeURIComponent(blockId)}`;
      const res = await fetch(url, {
        headers: { "apikey": cfg.SUPABASE_ANON_KEY, "Authorization": `Bearer ${cfg.SUPABASE_ANON_KEY}`, "Accept": "application/json" }
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`fetch failed: ${res.status} ${res.statusText} - ${errText}`);
      }
      const data = await res.json();
      data.sort((a,b) => { const na=Number(a.parcel_code), nb=Number(b.parcel_code); return Number.isFinite(na)&&Number.isFinite(nb)?na-nb:String(a.parcel_code).localeCompare(String(b.parcel_code),undefined,{numeric:true}); });
      parcelSelect.innerHTML = '<option value="">— All parcels in block —</option>';
      data.forEach(p => {
        const o = document.createElement("option");
        o.value = p.parcel_code;
        o.textContent = p.parcel_name || `Plot ${p.parcel_code}`;
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
    let parcelCodeOverride = null;
    if (layerType === "BLOCKS") {
      blockCode = drawBlockCodeInput?.value?.trim() ?? "";
    } else {
      blockCode = drawParcelBlockInput?.value?.trim() ?? "";
      const o = drawParcelNoOverride?.value?.trim() ?? "";
      parcelCodeOverride = o === "" ? null : o;
    }
    await saveGeometry(feature, layerType, { blockCode, parcelCodeOverride });
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
  const { blockCode: blockCodeRaw, parcelCodeOverride } = opts;
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

  let parcelCode = null;
  if (layerType === "PARCELS") {
    parcelCode = parcelCodeOverride;
  }

  const { data: savedId, error } = await supabase.rpc("vsl_upsert_geometry", {
    p_layer_type: layerType,
    p_block_code: blockCode,
    p_parcel_code: parcelCode,
    p_geojson: geojson.geometry,
    p_user_id: currentUser.id
  });
  if (error) {
    setDrawToolsFeedback(error.message, true);
    setStatus(statusEl, `Save failed: ${error.message}`, true);
    return;
  }
  await loadLayersFromDb();
  if (layerType === "PARCELS" && parcelCode == null && savedId) {
    const { data: row } = await supabase
      .from("vsl_parcels")
      .select("parcel_code")
      .eq("id", savedId)
      .maybeSingle();
    if (row?.parcel_code != null) {
      const msg = `Parcel saved as plot ${row.parcel_code} in block ${blockCode}.`;
      setDrawToolsFeedback(msg, false);
      setStatus(statusEl, msg);
    } else {
      const msg = `Parcel saved in block ${blockCode}.`;
      setDrawToolsFeedback(msg, false);
      setStatus(statusEl, msg);
    }
  } else if (layerType === "PARCELS") {
    const msg = `Parcel ${parcelCode} saved in block ${blockCode}.`;
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
      zIndex: LAYER_Z.USER_LOCATION,
      style: new ol.style.Style({
        image: new ol.style.Circle({
          radius: 8,
          fill: new ol.style.Fill({ color: '#3b82f6' }), /* Blue dot */
          stroke: new ol.style.Stroke({ color: '#ffffff', width: 3 })
        })
      })
    });
    // Deliberately no `title` set — see sketchLayer's comment near
    // buildLayerTree() for why that (not the old, ineffective
    // displayInLayerSwitcher flag) is what keeps a layer out of the Layers
    // panel in this ol-layerswitcher version. Location tracking itself keeps
    // running and stays visible on the map exactly as before either way.
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

/** The Measure tool's pick-mode undo — same call the tool's own
 *  #undoMeasureBtn already makes, shared here so it can also be passed into
 *  enterDraftingMode() as the Snap widget's Undo hook. */
function undoActiveMeasureVertex() {
  if (activeInteraction && typeof activeInteraction.removeLastPoint === "function") {
    activeInteraction.removeLastPoint();
  }
}

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
      enterDraftingMode(undoActiveMeasureVertex);
    } else {
      isWalkModeActive = false;
      stopActiveTool();
      exitDraftingMode();
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
  setupFeatureSearch();
  setupUnifiedSearchActionButtons();

  const searchCloseBtn = document.getElementById("searchPanelCloseBtn");
  searchCloseBtn?.addEventListener("click", () => closeSearchPanel({ clearHighlight: false }));

  drawLineBtn?.addEventListener("click", () => startMeasure("LineString", true));
  drawPolygonBtn?.addEventListener("click", () => startMeasure("Polygon", true));
  // #stopDrawBtn/#clearDrawingsBtn (below) no longer exist in the DOM — the
  // Draw tab's footer now has its own drawCancelBtn/drawSaveBtn pair (see
  // js/survey-draw.js) instead, and drawLineBtn/drawPolygonBtn above have
  // had no matching element for a while either. Left `?.`-guarded rather
  // than deleted outright since stopActiveTool()/measureSource.clear() here
  // are otherwise-harmless generic "stop/clear whatever's active" calls.
  stopDrawBtn?.addEventListener("click", (e) => {
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
          enterDraftingMode(undoActiveMeasureVertex);
        }
      } else {
        stopActiveTool();
        exitDraftingMode();
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
    exitDraftingMode();
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
  // Clicking the account button opens the profile popup (view details, edit,
  // or sign out from there) rather than signing out immediately — see
  // initProfileModal()/windows/profile-modal.html.
  logoutBtn.addEventListener("click", () => {
    if (typeof window.openProfileModal === "function") window.openProfileModal();
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

  // Cached role first. Sign-in wrote the profile to localStorage, so the
  // common case needs no round trip at all and the tool buttons are correct
  // on the first paint rather than after a fetch resolves.
  const cached = readCachedProfile(currentUser.id);
  if (cached) {
    currentProfile = cached;
    applyRoleGating(currentProfile.role);
    // Confirm in the background. A role change is rare but real (someone
    // promoted or demoted between visits), so the cache is checked rather
    // than trusted forever — just not on the critical path.
    revalidateProfile();
    return true;
  }

  // No usable cache — first visit on this browser, storage unavailable, or
  // a cache written for a different user. Fetch and remember.
  const profile = await fetchProfile();
  if (!profile) {
    clearCachedProfiles();
    await clearLandCache();
    await supabase.auth.signOut();
    window.location.href = "./login.html";
    return false;
  }
  currentProfile = profile;
  cacheProfile(profile);
  applyRoleGating(profile.role);
  return true;
}

/** The signed-in user's vsl_profiles row, or null if it's missing/unreadable
 *  (which is a sign-out, since a session without a role is unusable). */
async function fetchProfile() {
  const { data, error } = await supabase
    .from("vsl_profiles")
    .select("id, email, role, full_name, phone, title, avatar_url")
    .eq("id", currentUser.id)
    .single();
  if (error || !data?.role) return null;
  return data;
}

/**
 * Background re-check of a cached profile.
 *
 * Deliberately not awaited: the UI is already up from the cache, and this
 * only has to correct it if something changed. A network failure leaves the
 * cached role in place, which is the right call — being offline shouldn't
 * lock a surveyor out of their own tools.
 */
async function revalidateProfile() {
  try {
    const fresh = await fetchProfile();
    if (!fresh) return;
    const roleChanged = fresh.role !== currentProfile?.role;
    currentProfile = fresh;
    cacheProfile(fresh);
    if (roleChanged) {
      applyRoleGating(fresh.role);
      updateProfileButtonAvatar();
    }
  } catch (err) {
    console.warn("[Victoria] Could not revalidate the cached profile:", err);
  }
}

/**
 * Everything that depends on the current role, in one place.
 *
 * Runs on boot and again if revalidation finds the role changed, so it has
 * to be idempotent — hence setting both sides of every flag rather than only
 * the restricting one.
 */
function applyRoleGating(role) {
  // Which map tools are reachable at all (see TOOL_ROLES in role-store.js).
  applyToolVisibility(role);

  // The Select window's own read-only state. Separate from the button
  // gating above because MANAGMENT can still OPEN things they can't change.
  const psBanner = document.getElementById("parcelStatusReadOnlyBanner");
  const psApply = document.getElementById("parcelStatusApplyBtn");
  const statusReadonly = !isLandEditor(role);
  if (psBanner) psBanner.hidden = !statusReadonly;
  if (psApply) psApply.disabled = statusReadonly;

  // Importing reshapes land records, so it stays with the land editors even
  // though the Survey window is already hidden from everyone else.
  // surveyPreviewBtn does double duty as Preview AND Save (see
  // survey-import.js), so this one flag covers both.
  const sp = document.getElementById("surveyPreviewBtn");
  if (sp) sp.disabled = statusReadonly;

  // Measure is open to every role — it draws nothing and saves nothing.
  // These controls used to be disabled for MANAGMENT; they are explicitly
  // re-enabled rather than simply left alone, so that a demotion applied by
  // revalidateProfile() can't leave a stale disabled button behind.
  for (const el of [measureLineBtn, measureAreaBtn, measureTopBtn, stopDrawBtn,
                    clearMeasuresBtn, snapMasterCb,
                    document.getElementById("undoMeasureBtn")]) {
    if (el) el.disabled = false;
  }
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
      startActive: false,
      // Renders into the right floating button stack (alongside Locate Me)
      // instead of OL's default top-right corner — see .map-btn-stack /
      // #mapRightBtnStack in styles.css/webmap.html for the packing wrapper
      // this lets it share.
      target: document.getElementById("mapRightBtnStack") || undefined
    });
    map.addControl(layerSwitcher);
    layerSwitcherRef = layerSwitcher;
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
  const googleLayer = baseGroupRef?.getLayers()?.getArray()?.find((l) => l.get("title") === "Google Satellite");
  if (googleLayer?.getSource) {
    let errorCount = 0;
    googleLayer.getSource().on("tileloaderror", () => {
      errorCount += 1;
      if (errorCount >= 4 && googleLayer.getVisible()) {
        setBasemapByTitle("Esri Imagery");
        const radio = fallbackLayerSwitcherEl?.querySelector("input[name='fbBasemap'][value='Esri Imagery']");
        if (radio) radio.checked = true;
        setStatus(statusEl, "Google Hybrid unavailable. Fell back to Esri Imagery.", true);
      }
    });
  }

  setupInfoPopup();
  setupParcelActionToolbar();
  setupLegendPanel();
  // Log Activity button in the left tool stack — opens the same form a map
  // click opens, just with an empty Estate/Block/Plot row to fill in.
  document.getElementById("mapLogActivityBtn")?.addEventListener("click", () => {
    openLogActivityModal();
  });
  setupMessagesPanel();
  setupToolStackCollapse();
  setupSnapPanel();
  setupLogActivityModal();
  setupLogAlertModal();
  setupRecordDetailModal();
  setupAlertsListModal();
  setupResolveAlertModal();
  initProfileModal();
  updateProfileButtonAvatar();
  bindEvents();
  startBackgroundLocationTracking();
  const surveyImportHandles = initSurveyImport({
    map,
    cfg,
    supabase,
    setStatus,
    statusEl,
    loadLayersFromDb,
    // Blocks carry estate_id; a DB trigger recomputes vsl_estate.geom
    // whenever a block's geom/estate_id changes (see
    // vsl_recompute_estate_geometry / trg_vsl_blocks_estate_geometry), but
    // the client's estate-boundary layer was only ever loaded once at boot
    // — this lets a BLOCKS commit pull the freshly (re)computed bounds in.
    refreshEstateBoundaries: loadEstateBoundaries,
    // Importing rewrites land records, so it's the land editors' job. Asks
    // the shared role rule rather than naming a role, so adding a fourth
    // role later only means editing role-store.js.
    getManagementLocked: () => !isLandEditor(currentProfile?.role),
    blocksSource,
    parcelsSource
  });
  surveyPreviewSnapSources = surveyImportHandles?.getPreviewSnapSources?.() ?? null;

  const surveyDrawHandles = initSurveyDraw({
    map,
    cfg,
    supabase,
    setStatus,
    statusEl,
    loadLayersFromDb,
    refreshEstateBoundaries: loadEstateBoundaries,
    // Same shared snap-to-existing-geometry mechanism the Measure tool
    // already uses. attachSnap/detachSnap wrap the module-scoped
    // readSnapOptions()/attachSnapInteractions()/detachSnapInteractions()
    // defined above in this file.
    attachSnap: () => attachSnapInteractions(readSnapOptions()),
    detachSnap: detachSnapInteractions,
    // Rebuilds the FEATURES group in the layer switcher every time
    // featuresSource is repopulated (boot, Draw tab save, Manage Features
    // CRUD, …) — see rebuildFeaturesSwitcherGroup().
    onFeaturesRefreshed: () => rebuildFeaturesSwitcherGroup()
  });
  // Published for the Search window's Feature tab (setupFeatureSearch),
  // which reads this layer's features and drives its highlight.
  surveyDrawApi = surveyDrawHandles;

  // Registers window.openFeatureTypeEditor, which the Manage Features list
  // calls — so it has to be initialised before/alongside that list.
  initFeatureTypeEditor({ cfg, supabase, setStatus, statusEl });
  initManageFeatures({ cfg, supabase, setStatus, statusEl });
  initManageEstates({ cfg, supabase, setStatus, statusEl });

  // Drone tab + the DRONE IMAGES group. Given droneGroup directly rather than
  // the module reaching for it, so the group stays owned by buildLayerStack().
  initDroneTiles({
    cfg,
    supabase,
    map,
    droneGroup: droneImagesGroupRef,
    setStatus,
    statusEl,
    // Only-one-survey is enforced inside drone-tiles.js, so the panel has to
    // be redrawn afterwards to show the boxes it just changed.
    refreshSwitcher: () => layerSwitcherRef?.renderPanel?.()
  });

  initPrintTool({
    map,
    setStatus,
    statusEl,
    closeOtherPanels: () => {
      closeSearchPanel({ clearHighlight: false });
      closeUAM();
      closeParcelStatusPanel();
      const mp = document.getElementById("measurePanel");
      if (mp) mp.hidden = true;
    },
    // Needed for the print PDF's vector redraw (Option B) — the plot/block
    // geometry, styling data, and label helpers are drawn as real PDF
    // vectors instead of being rasterized, while the basemap (+ every other
    // raster layer) is still captured as pixels, just at a deeper zoom
    // (Option C) with blocksLayer/parcelsLayer hidden for that capture so
    // they don't get double-drawn. See js/print-tool.js.
    blocksLayer,
    parcelsLayer,
    // Estate boundaries/names and the saved custom features (trees, roads,
    // boreholes, …) are drawn as vectors too. The features layer is owned
    // by survey-draw, so it's fetched lazily through its handle rather
    // than captured here — it's rebuilt whenever feature types change.
    estatesLayer,
    titlesLayer,
    getFeaturesLayer: () => surveyDrawHandles?.getFeaturesLayer?.() || null,
    // Feature names sit on their own decluttered layer; the print tool needs
    // it only so it can hide it while capturing the basemap raster.
    getFeatureLabelsLayer: () => surveyDrawHandles?.getFeatureLabelsLayer?.() || null,
    CULTIVATION_PALETTE,
    CULTIVATION_STATUS_LABELS,
    ALERT_SEVERITY_FILL,
    ALERT_SEVERITY_COLORS,
    getFeatureInteriorPoint,
    surveyFeatureAreaAcresText
  });

  initSurveyEdit({
    map,
    cfg,
    supabase,
    setStatus,
    statusEl,
    blocksLayer,
    parcelsLayer,
    blocksSource,
    parcelsSource,
    getFeaturesLayer: () => surveyDrawHandles?.getFeaturesLayer?.() ?? null,
    refreshFeaturesLayer: () => surveyDrawHandles?.refreshFeaturesLayer?.(),
    loadLayersFromDb,
    refreshEstateBoundaries: loadEstateBoundaries,
    // Same shared snap mechanism as the Draw tab (see initSurveyDraw above)
    // — snaps a dragged node onto existing block/parcel geometry.
    attachSnap: () => attachSnapInteractions(readSnapOptions()),
    detachSnap: detachSnapInteractions
  });

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

  // Feature Info panel's Download button (CSV/PDF) — see
  // js/feature-export.js. setFeatureExportContext()/clearFeatureExportContext()
  // (called from openFeatureInfoPanel/closeInfoPopup above) feed it what's
  // currently shown; this call just wires the button/select once and gives
  // it the map instance it needs for the PDF's snapshot image.
  initFeatureExport({ map, setStatus, statusEl });

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

  // Cached boundaries go up first so a weak connection has something to show
  // immediately; the bbox load then refreshes them when the network answers.
  await drawLandFromCache();
  setupLandCacheSync();

  await loadLayersFromDb();
  await loadEstateBoundaries();
  map.on("moveend", async () => {
    await loadLayersFromDb();
  });

  // Deliberately not awaited: the map is already usable, and on a bad link
  // this can take a while or never finish.
  syncLandCache();

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
  // Activity catalog fetch runs alongside the map init — it's needed before
  // Log Activity/record-detail can be opened, but doesn't block anything
  // map-related, so there's no reason to serialize it after initMap().
  await Promise.all([initMap(), loadActivityCatalogFromDb()]);
  if (isAuthenticated) {
    setStatus(statusEl, `Signed in as ${currentProfile.role}. Ready.`);
  } else if (cfg.ALLOW_GUEST_PREVIEW) {
    setStatus(statusEl, "Guest preview mode: sign in for full access.");
  }
}

window.closeParcelStatusPanel = closeParcelStatusPanel;
window.closeSearchPanel = closeSearchPanel;

start().catch((err) => setStatus(statusEl, err.message, true));
