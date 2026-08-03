// ══════════════════════════════════════
//  SUGARESTATE — SUPABASE CLIENT & LIVE DATA LOADER
//  Connects to the Victoria Sugar Webmap Supabase project
//  and reshapes real DB rows into the DATA object shape
//  expected by app.js (estates / blocks / plots / users / emailSubscribers).
// ══════════════════════════════════════

// ── DATA — empty shell, populated moments later by loadLiveData() ──
// This used to be a large placeholder/demo dataset in data.js (removed —
// the app is now live-data-only). All it needs to do now is exist with the
// right shape so nothing crashes in the brief window between page load and
// the live Supabase fetch finishing; initLiveData() below mutates every
// field in place via Object.assign(DATA, live) once real rows arrive.
const DATA = {
  isLive: false,
  stats: {
    totalEstates: 0, totalBlocks: 0, totalPlots: 0,
    totalAreaHa: 0, plantedAreaHa: 0, fallowAreaHa: 0, reservedAreaHa: 0,
    activePlots: 0, fallowPlots: 0, underPrepPlots: 0,
    currentSeasonYieldTonnes: 0, targetYieldTonnes: 1,
    totalRevenue: 0, totalCost: 0, grossProfit: 0,
    avgYieldPerHa: 0, avgBrix: 0, avgSucrose: 0,
  },
  estates: [],
  blocks: [],
  plots: [],
  productionMonthly: { labels: [], actual: [] },
  productionByEstate: { labels: [], values: [], colors: [] },
  costBreakdown: { labels: [], values: [] },
  yieldByVariety: { labels: [], values: [] },
  users: [],
  emailSubscribers: [],
  activities: [],
  seasons: [],
  costs: [],
  documents: [],
  media: [],
  alerts: [],
  recentActivity: [],
  // Activity catalog — names + per-activity extra property defs, fetched
  // from vsl_activity_types / vsl_activity_type_properties /
  // vsl_activity_common_fields (see loadLiveData below). This used to be a
  // hardcoded ACTIVITY_TYPES array here, duplicated separately in the
  // webmap's map-app.js, which is what let the two apps drift out of sync
  // (e.g. different Completion widgets). Both now read the same tables.
  activityTypes: [],
  activityPropertyDefs: {},
  activityCommonFields: [],
};

const SUPABASE_URL      = "https://knhgliyghacvkeeptsfl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_W2kx87RbvH0Qd1HkPPXlIg_6GAy0HAV";
const APP_NAME           = "Victoria Sugar Webmap";

// supabase-js v2 is loaded globally as `window.supabase` via the CDN script in index.html
let sbClient = null;
function getSbClient() {
  if (!sbClient) {
    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return sbClient;
}

// seedFromString() gives a deterministic per-record number, still used as a
// last-resort estimate for avgYield when a block has no real harvest logged yet.
function seedFromString(str) {
  let hash = 0;
  for (let i = 0; i < (str || '').length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

// Acres → hectares
const ACRES_TO_HA = 0.404686;
function acresToHa(acres) {
  const n = parseFloat(acres);
  return isFinite(n) ? n * ACRES_TO_HA : 0;
}

// Statuses considered "actively growing cane" for harvest-due scheduling —
// not_in_cane/prepared (nothing planted yet) and replant_renovation (being
// reworked) never have a meaningful due date; 'harvested' is treated as a
// brief transitional flag some records still carry from before the Log
// Harvest flow existed.
const GROWING_CULTIVATION_STATUSES = ['planted', 'standing'];

// Given the reference start date (planting_date for a plant crop, or
// ratoon_start_date once a plot has been through its first harvest) and the
// estate's configured harvest_period_months, works out the due date and how
// many whole months past due the plot currently is (0 if not yet due).
function computeHarvestDue(referenceDateStr, harvestPeriodMonths) {
  if (!referenceDateStr) return { dueDate: null, monthsPastDue: null, isDue: false };
  const ref = new Date(referenceDateStr + 'T00:00:00');
  if (isNaN(ref.getTime())) return { dueDate: null, monthsPastDue: null, isDue: false };
  const due = new Date(ref);
  due.setMonth(due.getMonth() + (harvestPeriodMonths || 18));
  const now = new Date();
  const daysPastDue = Math.floor((now - due) / 86400000);
  return {
    dueDate: due.toISOString().slice(0, 10),
    monthsPastDue: Math.max(0, Math.floor(daysPastDue / 30.44)),
    isDue: daysPastDue >= 0,
  };
}

// Map raw cultivation_status → UI health bucket
function healthFromCultivationStatus(status) {
  if (!status) return 'watch';
  const s = status.toLowerCase();
  if (s === 'planted' || s === 'cane_standing' || s === 'ratoon') return 'good';
  if (s === 'not_in_cane' || s === 'fallow') return 'watch';
  if (s === 'replant_renovation' || s === 'failed') return 'alert';
  return 'watch';
}

// Map cultivation_status → display growth stage label
function stageFromCultivationStatus(status) {
  const map = {
    not_in_cane:          'Fallow',
    planted:               'Grand Growth',
    cane_standing:          'Grand Growth',
    ratoon:                 'Tillering',
    replant_renovation:     'Under Prep',
    pending:                 'Under Prep',
    failed:                  'Fallow',
  };
  return map[status] || 'Fallow';
}

// Last-resort fallback if vsl_activity_types comes back empty (e.g. before
// the activity-catalog migration has been run against this project yet).
const ACTIVITY_TYPES_FALLBACK = ['Bush Clearing','Ploughing','Harrow','Ripping','Ridging','Furrowing',
  'Lime Application','Planting','Manuring','Fertilization','Weeding','Spraying','Irrigation',
  'Harvesting','Loading','Trash Lining','Trash Collection'];

function titleCase(str) {
  if (!str) return str;
  return str.replace(/_/g, ' ').replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

// ── MAIN LOADER ──
// Fetches everything from Supabase and reshapes into the DATA object
// declared as an empty shell above.

async function loadLiveData() {
  const client = getSbClient();

  const [
    estRes, blkRes, parRes, profRes, recRes, blkHarvestRes, parHarvestRes,
    actRes, actCostRes, alertRes, docRes, mediaRes, blkStatsRes, parStatsRes,
    seasonRes, soilTestRes, harvestHistoryRes,
    actTypeRes, actTypePropRes, actCommonFieldRes,
  ] = await Promise.all([
    client.from('vsl_estate').select('*'),
    client.from('vsl_blocks').select('*'),
    client.from('vsl_parcels').select('*'),
    client.from('vsl_profiles').select('*'),
    client.from('vsl_report_recipients').select('*'),
    client.from('v_block_last_harvest').select('block_id, harvest_tonnes, last_harvest_date'),
    client.from('v_parcel_last_harvest').select('parcel_id, harvest_tonnes, last_harvest_date'),
    client.from('vsl_activities').select('*').order('activity_date', { ascending: false }).limit(200),
    client.from('vsl_activity_costs').select('*').order('created_at', { ascending: false }).limit(500),
    client.from('vsl_alerts').select('*').order('created_at', { ascending: false }),
    client.from('vsl_documents').select('*').order('upload_date', { ascending: false }).limit(200),
    client.from('vsl_media').select('*').order('captured_at', { ascending: false }).limit(200),
    client.from('vsl_block_stats').select('block_id, centroid_lat, centroid_lon'),
    client.from('vsl_parcel_stats').select('parcel_id, centroid_lat, centroid_lon'),
    client.from('vsl_parcel_seasons').select('*'),
    client.from('vsl_parcel_soil_tests').select('*').order('sample_date', { ascending: false }),
    // Full rows (not just harvest_date/gross_weight_tonnes) — parcel_id + created_by are
    // needed to resolve "logged by" per-plot on the Harvests page, and ratoon_at_harvest
    // for the harvest detail view. Ordered so the first row per parcel_id is the latest.
    client.from('vsl_harvests').select('id, parcel_id, harvest_date, gross_weight_tonnes, ratoon_at_harvest, created_by, created_at')
      .order('harvest_date', { ascending: false }).order('created_at', { ascending: false }),
    // Activity catalog — see comment on DATA.activityTypes above.
    client.from('vsl_activity_types').select('*').eq('is_active', true).order('sort_order'),
    client.from('vsl_activity_type_properties').select('*').order('sort_order'),
    client.from('vsl_activity_common_fields').select('*').order('sort_order'),
  ]);

  if (estRes.error) console.error('Supabase estate fetch error:', estRes.error);
  if (blkRes.error) console.error('Supabase blocks fetch error:', blkRes.error);
  if (parRes.error) console.error('Supabase parcels fetch error:', parRes.error);
  if (profRes.error) console.error('Supabase profiles fetch error:', profRes.error);
  if (recRes.error) console.error('Supabase report_recipients fetch error:', recRes.error);
  if (blkHarvestRes.error) console.error('Supabase block harvest fetch error:', blkHarvestRes.error);
  if (parHarvestRes.error) console.error('Supabase parcel harvest fetch error:', parHarvestRes.error);
  if (actRes.error) console.error('Supabase activities fetch error:', actRes.error);
  if (actCostRes.error) console.error('Supabase activity_costs fetch error:', actCostRes.error);
  if (alertRes.error) console.error('Supabase alerts fetch error:', alertRes.error);
  if (docRes.error) console.error('Supabase documents fetch error:', docRes.error);
  if (mediaRes.error) console.error('Supabase media fetch error:', mediaRes.error);
  if (blkStatsRes.error) console.error('Supabase block stats fetch error:', blkStatsRes.error);
  if (parStatsRes.error) console.error('Supabase parcel stats fetch error:', parStatsRes.error);
  if (seasonRes.error) console.error('Supabase parcel_seasons fetch error:', seasonRes.error);
  if (soilTestRes.error) console.error('Supabase parcel_soil_tests fetch error:', soilTestRes.error);
  if (harvestHistoryRes.error) console.error('Supabase harvests history fetch error:', harvestHistoryRes.error);
  if (actTypeRes.error) console.error('Supabase activity_types fetch error:', actTypeRes.error);
  if (actTypePropRes.error) console.error('Supabase activity_type_properties fetch error:', actTypePropRes.error);
  if (actCommonFieldRes.error) console.error('Supabase activity_common_fields fetch error:', actCommonFieldRes.error);

  // ── Activity catalog — activity names + their extra property defs ──
  // Falls back to the pre-existing hardcoded 17-name list (kept below,
  // ACTIVITY_TYPES_FALLBACK) if the catalog tables come back empty, so the
  // Activities page still works even before this migration has been run.
  const rawActivityTypes = actTypeRes.data || [];
  const activityTypeNameById = new Map(rawActivityTypes.map(t => [t.id, t.name]));
  const activityTypes = rawActivityTypes.length ? rawActivityTypes.map(t => t.name) : ACTIVITY_TYPES_FALLBACK;
  const activityPropertyDefs = {};
  activityTypes.forEach(name => { activityPropertyDefs[name] = []; });
  (actTypePropRes.data || []).forEach(p => {
    const name = activityTypeNameById.get(p.activity_type_id);
    if (!name || !activityPropertyDefs[name]) return;
    activityPropertyDefs[name].push({
      key: p.key, label: p.label, type: p.data_type,
      options: p.options || null, optionLabels: p.option_labels || null, showWhen: p.show_when || null,
    });
  });
  const activityCommonFields = (actCommonFieldRes.data || []).map(f => ({
    key: f.key, label: f.label, type: f.data_type,
    options: f.options || null, optionLabels: f.option_labels || null, showWhen: f.show_when || null,
  }));

  const rawEstates = estRes.data || [];
  const rawBlocks  = blkRes.data || [];
  const rawParcels = parRes.data || [];
  const rawProfiles = profRes.data || [];
  const rawRecipients = recRes.data || [];
  const rawActivities = actRes.data || [];
  const rawActivityCosts = actCostRes.data || [];
  const rawAlerts = alertRes.data || [];
  const rawDocuments = docRes.data || [];
  const rawMedia = mediaRes.data || [];
  const rawSeasons = seasonRes.data || [];
  const rawSoilTests = soilTestRes.data || [];
  const rawHarvestHistory = harvestHistoryRes.data || [];

  // Latest harvest row per parcel (rawHarvestHistory is already ordered harvest_date
  // desc, created_at desc, so the first row seen per parcel_id wins) — used to resolve
  // "Logged By" and ratoon-at-harvest on the Harvests page / Harvest Details modal.
  const latestHarvestByParcel = new Map();
  rawHarvestHistory.forEach(h => { if (!latestHarvestByParcel.has(h.parcel_id)) latestHarvestByParcel.set(h.parcel_id, h); });

  // Per-estate harvest scheduling settings (admin-configurable on the Harvests page;
  // vsl_estate.harvest_period_months / yield_per_acre_tons, default 18mo / 30 t/ac).
  const harvestSettingsByEstateName = new Map(rawEstates.map(e => [e.estate_name, {
    harvestPeriodMonths: e.harvest_period_months ?? 18,
    yieldPerAcreTons: Number(e.yield_per_acre_tons) || 30,
  }]));

  // Centroid lookups (used to build Google Maps links + QR codes per block/parcel).
  const blockStatsById  = new Map((blkStatsRes.data || []).map(s => [s.block_id, s]));
  const parcelStatsById = new Map((parStatsRes.data || []).map(s => [s.parcel_id, s]));

  // Real (non-placeholder) agronomy lookups for the Plot detail view.
  const seasonById = new Map(rawSeasons.map(s => [s.id, s]));
  // Latest soil test per parcel (rawSoilTests is already ordered sample_date desc).
  const latestSoilTestByParcel = new Map();
  rawSoilTests.forEach(t => { if (!latestSoilTestByParcel.has(t.parcel_id)) latestSoilTestByParcel.set(t.parcel_id, t); });

  // Estate id → estate_name lookup (estate_name was dropped from vsl_blocks/vsl_parcels; both
  // now reference vsl_estate via estate_id / block_id → block.estate_id).
  const estateNameById = new Map(rawEstates.map(e => [e.id, e.estate_name]));

  // Latest-harvest lookups (harvest_tonnes/last_harvest_date were dropped as flat columns —
  // they now live in the vsl_harvests history table, surfaced via these views).
  const blockHarvestById = new Map((blkHarvestRes.data || []).map(h => [h.block_id, h]));
  const parcelHarvestById = new Map((parHarvestRes.data || []).map(h => [h.parcel_id, h]));

  // Profile lookup — used to resolve the direct manager_id FK on vsl_estate/
  // vsl_blocks/vsl_parcels (one manager per record) into a display-ready record.
  const profileByIdForManagers = new Map(rawProfiles.map(p => [p.id, p]));

  // ── BLOCKS reshaped first (estates roll up from blocks) ──
  const blocks = rawBlocks.map(b => {
    const parcelsInBlock = rawParcels.filter(p => p.block_id === b.id);
    const areaHa = acresToHa(b.expected_area_acres);
    const plantedAcres = parcelsInBlock
      .filter(p => p.cultivation_status && p.cultivation_status !== 'not_in_cane' && p.cultivation_status !== 'pending')
      .reduce((s, p) => s + (parseFloat(p.expected_area_acres) || 0), 0);
    const plantedHa = acresToHa(plantedAcres) || (areaHa * 0.0); // 0 if nothing planted yet
    const seed = seedFromString(b.id);
    const harvest = blockHarvestById.get(b.id);
    const harvestTonnes = harvest?.harvest_tonnes ?? null;
    const blockStats = blockStatsById.get(b.id);
    const assignedManager = b.manager_id ? profileByIdForManagers.get(b.manager_id) : null;
    return {
      id: b.block_code || b.id,
      name: b.block_name || b.block_code || b.id,
      _uuid: b.id,
      estate: estateNameById.get(b.estate_id) || 'Unassigned',
      mapsLink: buildGoogleMapsLink(blockStats?.centroid_lat, blockStats?.centroid_lon) || buildGoogleMapsSearchLink(b.location_address) || null,
      plots: parcelsInBlock.length,
      areaHa: Number(areaHa.toFixed(2)),
      plantedHa: Number(plantedHa.toFixed(2)),
      status: b.cultivation_status === 'not_in_cane' ? 'watch'
            : b.cultivation_status === 'replant_renovation' ? 'alert'
            : 'active',
      avgYield: harvestTonnes && areaHa ? Number((harvestTonnes / (areaHa * 2.47105)).toFixed(2)) : Number(((6.5 + (seed % 30) / 10) / 2.47105).toFixed(2)), // t/acre; placeholder if no harvest yet
      season: '2024-B',
      // Legacy plain-text columns (kept for reference, not the assigned-manager source of truth anymore).
      managerName: b.manager_name || '—',
      managerPhone: b.manager_phone || '—',
      // Assigned manager — direct vsl_blocks.manager_id → vsl_profiles (one manager per block).
      managerId: b.manager_id || null,
      assignedManagerName:  assignedManager ? (assignedManager.full_name || assignedManager.email) : null,
      assignedManagerEmail: assignedManager ? assignedManager.email : null,
      assignedManagerPhone: assignedManager ? assignedManager.phone : null,
      assignedManagerTitle: assignedManager ? assignedManager.title : null,
      assignedManagerAvatarUrl: assignedManager ? assignedManager.avatar_url : null,
      soilType: b.soil_type || null,
      irrigationType: b.irrigation_type || null,
      soilPh: b.soil_ph ?? null,
      ownership: b.ownership || null,
      geometryStatus: b.geometry_status || 'pending',
      cultivationStatus: b.cultivation_status || 'not_in_cane',
      lastHarvestDate: harvest?.last_harvest_date ?? null,
      harvestTonnes,
      cultivationNotes: b.cultivation_notes,
      createdAt: b.created_at,
      updatedAt: b.updated_at,
    };
  });

  // ── PARCELS (plots) reshaped ──
  const plots = rawParcels.map(p => {
    const parentBlock = rawBlocks.find(b => b.id === p.block_id);
    // The already-reshaped block (built above) so we can show its real,
    // DB-backed soil/irrigation values as a block-level fallback — no more
    // per-parcel seeded placeholders.
    const parentBlockReshaped = blocks.find(b => b._uuid === p.block_id);
    const areaHa = acresToHa(p.expected_area_acres);
    const harvest = parcelHarvestById.get(p.id);
    const parcelStats = parcelStatsById.get(p.id);
    // Real per-parcel season history (cane_variety etc.) — trigger-maintained
    // on vsl_parcels.current_season_id, falls back to the newest season row
    // for this parcel if the cache pointer isn't set yet.
    const currentSeason = (p.current_season_id && seasonById.get(p.current_season_id))
      || rawSeasons.filter(s => s.parcel_id === p.id).sort((a,b) => new Date(b.created_at) - new Date(a.created_at))[0]
      || null;
    const soilTest = latestSoilTestByParcel.get(p.id) || null;
    const estateNameForParcel = parentBlock ? (estateNameById.get(parentBlock.estate_id) || 'Unassigned') : 'Unassigned';
    const harvestSettings = harvestSettingsByEstateName.get(estateNameForParcel) || { harvestPeriodMonths: 18, yieldPerAcreTons: 30 };
    // Reference date for "months since due for harvest": the current ratoon's start
    // date once the plot has been through at least one logged harvest, otherwise the
    // original planting date (plant crop).
    const harvestReferenceDate = p.ratoon_start_date || p.planting_date || null;
    const harvestDue = GROWING_CULTIVATION_STATUSES.includes(p.cultivation_status)
      ? computeHarvestDue(harvestReferenceDate, harvestSettings.harvestPeriodMonths)
      : { dueDate: null, monthsPastDue: null, isDue: false };
    const latestHarvest = latestHarvestByParcel.get(p.id) || null;
    const latestHarvestLogger = latestHarvest?.created_by ? profileByIdForManagers.get(latestHarvest.created_by) : null;
    return {
      id: p.parcel_code || p.parcel_name || p.id,
      _uuid: p.id,
      block: parentBlock ? (parentBlock.block_code || parentBlock.id) : '—',
      blockName: parentBlock ? (parentBlock.block_name || parentBlock.block_code || parentBlock.id) : '—',
      _blockUuid: p.block_id,
      estate: parentBlock ? (estateNameById.get(parentBlock.estate_id) || 'Unassigned') : 'Unassigned',
      mapsLink: buildGoogleMapsLink(parcelStats?.centroid_lat, parcelStats?.centroid_lon) || null,
      areaHa: Number(areaHa.toFixed(2)),
      variety: currentSeason?.cane_variety || null, // real value from vsl_parcel_seasons; '—' in the UI if this parcel has no season history yet
      stage: stageFromCultivationStatus(p.cultivation_status),
      ratoon: p.ratoon_number ?? 0,
      ratoonStartDate: p.ratoon_start_date || null,
      health: healthFromCultivationStatus(p.cultivation_status),
      planted: p.planting_date,
      expectedHarvest: p.expected_harvest_date,
      yield: harvest?.harvest_tonnes ?? null,
      cultivationStatus: p.cultivation_status || 'not_in_cane',
      cultivationNotes: p.cultivation_notes,
      lastHarvestDate: harvest?.last_harvest_date ?? null,
      // Logged By — who recorded this plot's most recent harvest (vsl_harvests.created_by
      // → vsl_profiles), shown in the Harvest Details modal on the Harvests page.
      lastHarvestLoggedByName: latestHarvestLogger ? (latestHarvestLogger.full_name || latestHarvestLogger.email) : null,
      lastHarvestRatoon: latestHarvest?.ratoon_at_harvest ?? null,
      // Ratoon-shift tracking (vsl_parcels.ratoon_start_date) + estate-configurable
      // harvest-due scheduling — powers the "Harvests Due" table/settings on the
      // Harvests page. See computeHarvestDue()/GROWING_CULTIVATION_STATUSES above.
      ratoonStartDate: p.ratoon_start_date || null,
      harvestReferenceDate,
      harvestReferenceType: p.ratoon_start_date ? 'ratoon' : 'planting',
      harvestPeriodMonths: harvestSettings.harvestPeriodMonths,
      yieldPerAcreTons: harvestSettings.yieldPerAcreTons,
      harvestDueDate: harvestDue.dueDate,
      monthsPastDue: harvestDue.monthsPastDue,
      isHarvestDue: harvestDue.isDue,
      expectedYieldTons: harvestDue.isDue ? Number(((parseFloat(p.expected_area_acres) || 0) * harvestSettings.yieldPerAcreTons).toFixed(1)) : null,
      geometryStatus: p.geometry_status || 'pending',
      parcelName: p.parcel_name,
      currentActivity: p.current_activity_name || null,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      // Real soil-test history from vsl_parcel_soil_tests (empty until the
      // agronomy team logs a sample for this parcel — no fabricated numbers).
      soilTest: soilTest ? {
        soilPh: soilTest.soil_ph,
        nitrogen: soilTest.nitrogen,
        phosphorus: soilTest.phosphorus,
        potassium: soilTest.potassium,
        organicMatterPct: soilTest.organic_matter_pct,
        texture: soilTest.texture,
        sampleDate: soilTest.sample_date,
        labName: soilTest.lab_name,
      } : null,
      // Block-level real DB columns (vsl_blocks.soil_type/irrigation_type/soil_ph)
      // shown as a fallback since these aren't tracked per-parcel in the DB.
      blockSoilType: parentBlockReshaped?.soilType || null,
      blockSoilPh: parentBlockReshaped?.soilPh || null,
      blockIrrigationType: parentBlockReshaped?.irrigationType || null,
    };
  });

  // ── SEASONS (vsl_parcel_seasons) reshaped — plot-level planting/crop-cycle
  // history, one row per crop cycle. Most fields (ratoon_number,
  // expected_harvest_date, season_status, actual_harvest_date) are trigger-
  // maintained from vsl_parcels — see vsl_sync_parcel_season() in the DB,
  // which fires on every vsl_parcels insert/update. season_name, cane_variety,
  // target/actual yield, growth_stage, failure_reason and notes are
  // manual-only fields, set from the Seasons page.
  const seasons = rawSeasons.map(s => {
    const parcel = rawParcels.find(p => p.id === s.parcel_id);
    const parentBlockForSeason = parcel ? rawBlocks.find(b => b.id === parcel.block_id) : null;
    const logger = s.created_by ? profileByIdForManagers.get(s.created_by) : null;
    return {
      id: s.id,
      parcelId: s.parcel_id,
      plot: parcel ? (parcel.parcel_name || parcel.parcel_code || parcel.id) : '—',
      block: parentBlockForSeason ? (parentBlockForSeason.block_name || parentBlockForSeason.block_code || parentBlockForSeason.id) : '—',
      blockUuid: parcel ? parcel.block_id : null,
      estate: parentBlockForSeason ? (estateNameById.get(parentBlockForSeason.estate_id) || 'Unassigned') : 'Unassigned',
      seasonName: s.season_name,
      caneVariety: s.cane_variety,
      ratoonNumber: s.ratoon_number ?? 0,
      plantingDate: s.planting_date,
      expectedHarvestDate: s.expected_harvest_date,
      actualHarvestDate: s.actual_harvest_date,
      growthStage: s.growth_stage,
      targetYieldTonnes: s.target_yield_tonnes != null ? Number(s.target_yield_tonnes) : null,
      actualYieldTonnes: s.actual_yield_tonnes != null ? Number(s.actual_yield_tonnes) : null,
      yieldPerHectare: s.yield_per_hectare != null ? Number(s.yield_per_hectare) : null,
      status: s.season_status || 'planned',
      failureReason: s.failure_reason,
      notes: s.notes,
      createdBy: s.created_by,
      createdByName: logger ? (logger.full_name || logger.email) : null,
      createdAt: s.created_at,
      // Whether this is the parcel's current pointer (vsl_parcels.current_season_id)
      // — trigger-managed, always the most recently created season row per parcel.
      isCurrent: parcel ? parcel.current_season_id === s.id : false,
    };
  }).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  // ── ESTATES reshaped, with rollups from blocks ──
  const estates = rawEstates.map(e => {
    const estBlocks = blocks.filter(b => b.estate === e.estate_name);
    const totalAreaHa = estBlocks.reduce((s, b) => s + b.areaHa, 0);
    const plantedHa = estBlocks.reduce((s, b) => s + b.plantedHa, 0);
    const totalPlots = estBlocks.reduce((s, b) => s + b.plots, 0);
    const alertBlocks = estBlocks.filter(b => b.status === 'alert').length;
    const watchBlocks = estBlocks.filter(b => b.status === 'watch').length;
    const assignedManager = e.manager_id ? profileByIdForManagers.get(e.manager_id) : null;
    return {
      id: 'E' + String(e.id).padStart(3, '0'),
      _id: e.id,
      name: e.estate_name,
      district: e.district || (e.address || '').split(',').pop().trim() || '—',
      location: e.address || '—',
      mapsLink: e.location_link || buildGoogleMapsSearchLink(e.address) || null,
      blocks: estBlocks.length,
      plots: totalPlots,
      areaHa: Number(totalAreaHa.toFixed(2)),
      plantedHa: Number(plantedHa.toFixed(2)),
      status: 'active',
      health: alertBlocks > 0 ? 'alert' : watchBlocks > estBlocks.length / 2 ? 'watch' : 'good',
      // Owner (legacy field — separate concept from the assigned staff manager below).
      manager: e.owner_name || '—',
      managerPhone: e.owner_contact_phone || '—',
      // Assigned manager — direct vsl_estate.manager_id → vsl_profiles (one manager per estate).
      managerId: e.manager_id || null,
      assignedManagerName:  assignedManager ? (assignedManager.full_name || assignedManager.email) : null,
      assignedManagerEmail: assignedManager ? assignedManager.email : null,
      assignedManagerPhone: assignedManager ? assignedManager.phone : null,
      assignedManagerTitle: assignedManager ? assignedManager.title : null,
      assignedManagerAvatarUrl: assignedManager ? assignedManager.avatar_url : null,
      createdAt: e.created_at,
      // Admin-configurable harvest scheduling settings (vsl_estate.harvest_period_months /
      // yield_per_acre_tons) — edited from the Harvest Settings panel on the Harvests page.
      harvestPeriodMonths: e.harvest_period_months ?? 18,
      yieldPerAcreTons: Number(e.yield_per_acre_tons) || 30,
    };
  });

  // ── USERS (profiles) reshaped ──
  const ROLE_LABELS = {
    ADMIN: 'Admin',
    MANAGMENT: 'Management', // NB: source value is misspelled "MANAGMENT" in the DB — kept as-is to match the check constraint
    SURVEYOR: 'Surveyor',
  };
  const estateNameByIdForUsers = new Map(rawEstates.map(e => [e.id, e.estate_name]));
  const users = rawProfiles.map(p => {
    const initials = (p.full_name || p.email || '??')
      .split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase();
    return {
      id: p.id,
      name: p.full_name || (p.email ? p.email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Unnamed User'),
      email: p.email,
      role: ROLE_LABELS[p.role] || titleCase(p.role) || p.role,
      roleRaw: p.role,
      title: p.title || '',
      phone: p.phone || '',
      estate: p.estate_id ? (estateNameByIdForUsers.get(p.estate_id) || 'Unassigned') : 'All Estates',
      estateId: p.estate_id || null,
      status: p.is_active === false ? 'inactive' : 'active',
      lastLogin: p.last_login_at ? p.last_login_at.replace('T', ' ').slice(0, 16) : '—',
      avatar: initials || '??',
      avatarUrl: p.avatar_url || null,
      createdAt: p.created_at,
    };
  });

  // ── EMAIL SUBSCRIBERS (report recipients) reshaped ──
  const emailSubscribers = rawRecipients.map(r => ({
    id: r.id,
    email: r.email,
    name: r.name || r.email.split('@')[0],
    frequency: r.freq ? titleCase(r.freq) : 'Weekly',
    estate: r.estate || 'All Estates',
    reportType: r.report_type || 'Season Summary Report',
    lastSent: r.last_sent ? new Date(r.last_sent).toLocaleDateString() : '—',
    status: 'active',
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));

  // ── ACTIVITIES reshaped ──
  const blockById = new Map(rawBlocks.map(b => [b.id, b]));
  const parcelById = new Map(rawParcels.map(p => [p.id, p]));
  const profileById = new Map(rawProfiles.map(p => [p.id, p]));
  function estateNameForActivity(a) {
    if (a.estate_id != null) return estateNameByIdForUsers.get(a.estate_id) || 'Unassigned';
    const blk = a.block_id ? blockById.get(a.block_id) : (a.parcel_id ? blockById.get(parcelById.get(a.parcel_id)?.block_id) : null);
    return blk ? (estateNameByIdForUsers.get(blk.estate_id) || 'Unassigned') : 'Unassigned';
  }
  const activities = rawActivities.map(a => {
    const parcel = a.parcel_id ? parcelById.get(a.parcel_id) : null;
    const block = a.block_id ? blockById.get(a.block_id) : (parcel ? blockById.get(parcel.block_id) : null);
    const assignee = a.assigned_to ? profileById.get(a.assigned_to) : null;
    // Logged By — vsl_activities.created_by → vsl_profiles (created_by targets
    // auth.users.id, which is the same id vsl_profiles rows key on 1:1).
    const logger = a.created_by ? profileById.get(a.created_by) : null;
    return {
      id: a.id,
      name: a.activity_name,
      date: a.activity_date,
      estate: estateNameForActivity(a),
      block: block ? (block.block_name || block.block_code || block.id) : '—',
      parcel: parcel ? (parcel.parcel_name || parcel.parcel_code || parcel.id) : (a.parcel_id ? '—' : null),
      assignedTo: assignee ? (assignee.full_name || assignee.email) : (a.assigned_to_legacy || '—'),
      createdById: a.created_by || null,
      createdByName: logger ? (logger.full_name || logger.email) : null,
      teamSize: a.team_size,
      machines: a.number_of_machines,
      completionValue: a.completion_value,
      areaCoveredAcres: a.area_covered_acres,
      challenges: a.challenges,
      comments: a.comments,
      properties: a.activity_properties || {},
      createdAt: a.created_at,
      _blockId: a.block_id,
      _parcelId: a.parcel_id,
      _estateId: a.estate_id,
    };
  });

  // ── ACTIVITY COSTS reshaped ──
  const activityById = new Map(rawActivities.map(a => [a.id, a]));
  const costs = rawActivityCosts.map(c => {
    const parcel = c.parcel_id ? parcelById.get(c.parcel_id) : null;
    const block = c.block_id ? blockById.get(c.block_id) : (parcel ? blockById.get(parcel.block_id) : null);
    const activity = c.activity_id ? activityById.get(c.activity_id) : null;
    return {
      id: c.id,
      activityId: c.activity_id,
      activityName: activity ? activity.activity_name : '—',
      costType: c.cost_type || '—',
      description: c.description || '',
      amount: Number(c.amount) || 0,
      currency: c.currency || 'UGX',
      estate: block ? (estateNameByIdForUsers.get(block.estate_id) || 'Unassigned') : 'Unassigned',
      block: block ? (block.block_name || block.block_code || block.id) : '—',
      parcel: parcel ? (parcel.parcel_name || parcel.parcel_code) : '—',
      createdAt: c.created_at,
      _blockId: c.block_id,
      _parcelId: c.parcel_id,
    };
  });

  // ── ALERTS reshaped (real vsl_alerts rows) ──
  function resolveAlertScope(a) {
    if (a.layer_type === 'ESTATE') {
      const est = rawEstates.find(e => String(e.id) === String(a.target_id));
      return est ? est.estate_name : 'Unassigned';
    }
    if (a.layer_type === 'BLOCKS') {
      const blk = rawBlocks.find(b => b.id === a.target_id);
      return blk ? (estateNameByIdForUsers.get(blk.estate_id) || 'Unassigned') : 'Unassigned';
    }
    if (a.layer_type === 'PARCELS') {
      const par = rawParcels.find(p => p.id === a.target_id);
      const blk = par ? blockById.get(par.block_id) : null;
      return blk ? (estateNameByIdForUsers.get(blk.estate_id) || 'Unassigned') : 'Unassigned';
    }
    return 'All Estates';
  }
  const dbAlerts = rawAlerts.map(a => ({
    id: a.id,
    type: a.severity === 'critical' ? 'critical' : a.severity === 'warning' ? 'warning' : 'info',
    title: a.alert_name || titleCase(a.layer_type) + ' alert',
    desc: a.note || '',
    layerType: a.layer_type,
    targetId: a.target_id,
    estate: resolveAlertScope(a),
    status: a.status,
    time: a.created_at ? new Date(a.created_at).toLocaleString() : '—',
    createdAt: a.created_at,
    resolvedAt: a.resolved_at,
    resolvedTime: a.resolved_at ? new Date(a.resolved_at).toLocaleString() : '',
    resolutionNote: a.resolution_note || '',
    isReal: true,
  }));

  // ── DOCUMENTS & MEDIA reshaped ──
  function resolveEntityLabel(entity_type, entity_id) {
    if (entity_type === 'estate') {
      const e = rawEstates.find(x => String(x.id) === String(entity_id));
      return e ? e.estate_name : entity_id;
    }
    if (entity_type === 'block') {
      const b = blockById.get(entity_id);
      return b ? (b.block_name || b.block_code || b.id) : entity_id;
    }
    if (entity_type === 'parcel') {
      const p = parcelById.get(entity_id);
      return p ? (p.parcel_name || p.parcel_code || p.id) : entity_id;
    }
    return entity_id;
  }
  const documents = rawDocuments.map(d => ({
    id: d.id,
    title: d.document_title,
    docType: d.doc_type || '—',
    entityType: d.entity_type,
    entityLabel: resolveEntityLabel(d.entity_type, d.entity_id),
    fileUrl: d.file_url,
    description: d.description || '',
    uploadDate: d.upload_date,
  }));
  const media = rawMedia.map(m => ({
    id: m.id,
    mediaType: m.media_type || 'photo',
    entityType: m.entity_type,
    entityLabel: resolveEntityLabel(m.entity_type, m.entity_id),
    fileUrl: m.file_url,
    caption: m.caption || '',
    capturedAt: m.captured_at,
  }));

  // ── AGGREGATE STATS ──
  const totalAreaHa = blocks.reduce((s, b) => s + b.areaHa, 0);
  const plantedAreaHa = blocks.reduce((s, b) => s + b.plantedHa, 0);
  const fallowAreaHa = Math.max(totalAreaHa - plantedAreaHa, 0);
  const activePlots = plots.filter(p => p.health === 'good').length;
  const fallowPlots = plots.filter(p => p.health === 'watch').length;
  const underPrepPlots = plots.filter(p => p.health === 'alert').length;
  const harvestedTonnage = plots.reduce((s, p) => s + (parseFloat(p.yield) || 0), 0);

  const stats = {
    totalEstates: estates.length,
    totalBlocks: blocks.length,
    totalPlots: plots.length,
    totalAreaHa: Number(totalAreaHa.toFixed(1)),
    plantedAreaHa: Number(plantedAreaHa.toFixed(1)),
    fallowAreaHa: Number(fallowAreaHa.toFixed(1)),
    reservedAreaHa: Number((totalAreaHa * 0.03).toFixed(1)), // placeholder reserve estimate
    activePlots,
    fallowPlots,
    underPrepPlots,
    currentSeasonYieldTonnes: Number(harvestedTonnage.toFixed(1)),
    targetYieldTonnes: Number((plantedAreaHa * 8).toFixed(0)) || 1, // placeholder target: 8t/ha
    totalRevenue: 0,      // not tracked yet in DB — placeholder until finance module is wired
    totalCost: 0,         // not tracked yet in DB
    grossProfit: 0,
    avgYieldPerHa: plantedAreaHa ? Number((harvestedTonnage / (plantedAreaHa * 2.47105)).toFixed(2)) : 0, // t/acre
    avgBrix: 16.4,         // placeholder — agronomy capture not yet live
    avgSucrose: 14.1,      // placeholder
  };

  // ── Monthly harvest trend (last 12 months), computed from real vsl_harvests rows.
  // No fabricated "target" line — there's no monthly-target table in the DB.
  const productionMonthly = (() => {
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleString('en', { month: 'short' }) });
    }
    const totalsByKey = {};
    rawHarvestHistory.forEach(h => {
      if (!h.harvest_date) return;
      const key = h.harvest_date.slice(0, 7); // 'YYYY-MM'
      totalsByKey[key] = (totalsByKey[key] || 0) + (parseFloat(h.gross_weight_tonnes) || 0);
    });
    return {
      labels: months.map(m => m.label),
      actual: months.map(m => (totalsByKey[m.key] != null ? Number(totalsByKey[m.key].toFixed(1)) : null)),
    };
  })();

  // ── Cost breakdown by category, computed from real vsl_activity_costs rows.
  const costBreakdown = (() => {
    const byType = {};
    costs.forEach(c => { byType[c.costType] = (byType[c.costType] || 0) + c.amount; });
    return { labels: Object.keys(byType), values: Object.values(byType) };
  })();

  // ── Average yield per acre by cane variety, computed from real plot data
  // (variety comes from vsl_parcel_seasons — see PARCELS reshape above).
  // Sparse/empty until more parcels have season + harvest history, which is
  // honest given how little of that data exists yet.
  const yieldByVariety = (() => {
    const byVariety = {};
    plots.forEach(p => {
      if (!p.variety || !p.yield || !p.areaHa) return;
      const yieldPerAc = p.yield / (p.areaHa * 2.47105);
      if (!byVariety[p.variety]) byVariety[p.variety] = { total: 0, count: 0 };
      byVariety[p.variety].total += yieldPerAc;
      byVariety[p.variety].count += 1;
    });
    const labels = Object.keys(byVariety);
    return { labels, values: labels.map(v => Number((byVariety[v].total / byVariety[v].count).toFixed(2))) };
  })();

  return {
    isLive: true,
    stats,
    estates,
    blocks,
    plots,
    productionMonthly,
    productionByEstate: {
      labels: estates.map(e => e.name),
      values: estates.map(e => blocks.filter(b => b.estate === e.name).reduce((s, b) => s + (b.harvestTonnes || 0), 0)),
      colors: ['#2e6647', '#e8a020', '#4a9e6e', '#c0392b', '#2563eb', '#9fd4b8'].slice(0, estates.length),
    },
    costBreakdown,
    yieldByVariety,
    users,
    emailSubscribers,
    activities,
    seasons,
    costs,
    documents,
    media,
    activityTypes,
    activityPropertyDefs,
    activityCommonFields,
    alerts: dbAlerts.length ? dbAlerts : buildAlertsFromLiveData(estates, blocks, plots),
    recentActivity: activities.length
      ? activities.slice(0, 8).map(a => ({
          type: 'activity',
          icon: '🌾',
          color: 'green',
          text: `${a.name} logged on ${a.parcel && a.parcel !== '—' ? 'parcel ' + a.parcel : (a.block !== '—' ? 'block ' + a.block : a.estate)}`,
          meta: `${a.estate} · ${a.assignedTo || 'Unassigned'} · ${a.date || ''}`,
        }))
      : buildRecentActivityFromLiveData(rawParcels, rawBlocks, estateNameById),
  };
}

// ── Derive alerts from real cultivation_status / dates rather than static dummy text ──
function buildAlertsFromLiveData(estates, blocks, plots) {
  const alerts = [];

  estates.forEach(e => {
    if (e.health === 'alert') {
      alerts.push({
        id: 'auto-est-' + e.id,
        type: 'critical',
        title: `${e.name} — low planted area`,
        desc: `Planted area is ${e.plantedHa.toFixed(1)} ha of ${e.areaHa.toFixed(1)} ha total. Review block readiness.`,
        time: 'Live',
        estate: e.name,
      });
    }
  });

  blocks.filter(b => b.status === 'alert').forEach(b => {
    alerts.push({
      id: 'auto-blk-' + b._uuid,
      type: 'warning',
      title: `${b.name || b.id} flagged for renovation`,
      desc: `Block is marked for replant/renovation in ${b.estate}.`,
      time: 'Live',
      estate: b.estate,
    });
  });

  const pendingGeom = [...blocks].filter(b => b.geometryStatus === 'pending').length;
  if (pendingGeom > 0) {
    alerts.push({
      id: 'auto-geom',
      type: 'info',
      title: `${pendingGeom} block(s) awaiting boundary capture`,
      desc: `Geometry status is "pending" for ${pendingGeom} block(s) — survey team follow-up needed.`,
      time: 'Live',
      estate: 'All Estates',
    });
  }

  if (alerts.length === 0) {
    alerts.push({
      id: 'auto-none',
      type: 'info',
      title: 'No active alerts',
      desc: 'All estates and blocks are currently within normal operating thresholds.',
      time: 'Live',
      estate: 'All Estates',
    });
  }
  return alerts;
}

function buildRecentActivityFromLiveData(rawParcels, rawBlocks, estateNameById) {
  const items = [];
  const recentParcels = [...rawParcels]
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
    .slice(0, 6);

  recentParcels.forEach(p => {
    const parentBlock = rawBlocks.find(b => b.id === p.block_id);
    const estateName = parentBlock ? estateNameById.get(parentBlock.estate_id) : null;
    items.push({
      type: 'update',
      icon: p.cultivation_status === 'not_in_cane' ? '🪴' : '🌾',
      color: p.cultivation_status === 'replant_renovation' ? 'amber' : 'green',
      text: `Parcel ${p.parcel_name || p.parcel_code} updated — status: ${titleCase(p.cultivation_status)}`,
      meta: `${estateName || ''} · ${new Date(p.updated_at).toLocaleString()}`,
    });
  });
  return items;
}

// ── BOOTSTRAP: fetch live data, replace DATA, then let app.js render ──
async function initLiveData() {
  try {
    const live = await loadLiveData();
    Object.assign(DATA, live); // mutate the existing DATA object so all references in app.js stay valid
    document.dispatchEvent(new CustomEvent('sugarestate:data-ready'));
  } catch (err) {
    console.error('Failed to load live Supabase data, falling back to placeholder data:', err);
    document.dispatchEvent(new CustomEvent('sugarestate:data-error', { detail: err }));
  }
}
