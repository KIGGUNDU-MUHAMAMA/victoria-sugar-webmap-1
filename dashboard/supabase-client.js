// ══════════════════════════════════════
//  SUGARESTATE — SUPABASE CLIENT & LIVE DATA LOADER
//  Connects to the Victoria Sugar Webmap Supabase project
//  and reshapes real DB rows into the DATA object shape
//  expected by app.js (estates / blocks / plots / users / emailSubscribers).
// ══════════════════════════════════════

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

// ── Helpers for placeholder agronomy fields not yet captured in the DB ──
// These are clearly-labelled, deterministic placeholders (not random per reload)
// so the UI looks complete while real agronomy capture is rolled out.

const CANE_VARIETIES = ['N14', 'Co421', 'Mex64-1487', 'NCo376', 'R570'];
const SOIL_TYPES      = ['Clay Loam', 'Sandy Loam', 'Silty Clay', 'Loam'];
const IRRIGATION_TYPES = ['Furrow', 'Drip', 'Overhead', 'Rainfed'];
const DRAINAGE_CLASSES = ['Well Drained', 'Moderately Drained', 'Poorly Drained'];

function seedFromString(str) {
  // Simple deterministic hash so the same parcel always gets the same placeholder values
  let hash = 0;
  for (let i = 0; i < (str || '').length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}
function pickFromSeed(arr, seed) {
  return arr[seed % arr.length];
}

// Acres → hectares
const ACRES_TO_HA = 0.404686;
function acresToHa(acres) {
  const n = parseFloat(acres);
  return isFinite(n) ? n * ACRES_TO_HA : 0;
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

function titleCase(str) {
  if (!str) return str;
  return str.replace(/_/g, ' ').replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

// ── MAIN LOADER ──
// Fetches everything from Supabase and reshapes into the DATA object
// already declared (as fallback/placeholder) in data.js.

async function loadLiveData() {
  const client = getSbClient();

  const [
    estRes, blkRes, parRes, profRes, recRes, blkHarvestRes, parHarvestRes,
    actRes, actCostRes, alertRes, docRes, mediaRes,
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

  // Estate id → estate_name lookup (estate_name was dropped from vsl_blocks/vsl_parcels; both
  // now reference vsl_estate via estate_id / block_id → block.estate_id).
  const estateNameById = new Map(rawEstates.map(e => [e.id, e.estate_name]));

  // Latest-harvest lookups (harvest_tonnes/last_harvest_date were dropped as flat columns —
  // they now live in the vsl_harvests history table, surfaced via these views).
  const blockHarvestById = new Map((blkHarvestRes.data || []).map(h => [h.block_id, h]));
  const parcelHarvestById = new Map((parHarvestRes.data || []).map(h => [h.parcel_id, h]));

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
    return {
      id: b.block_code || b.id,
      _uuid: b.id,
      estate: estateNameById.get(b.estate_id) || 'Unassigned',
      plots: parcelsInBlock.length,
      areaHa: Number(areaHa.toFixed(2)),
      plantedHa: Number(plantedHa.toFixed(2)),
      status: b.cultivation_status === 'not_in_cane' ? 'watch'
            : b.cultivation_status === 'replant_renovation' ? 'alert'
            : 'active',
      avgYield: harvestTonnes && areaHa ? Number((harvestTonnes / (areaHa * 2.47105)).toFixed(2)) : Number(((6.5 + (seed % 30) / 10) / 2.47105).toFixed(2)), // t/acre; placeholder if no harvest yet
      season: '2024-B',
      managerName: b.manager_name || '—',
      managerPhone: b.manager_phone || '—',
      soilType: b.soil_type || pickFromSeed(SOIL_TYPES, seed),
      irrigationType: b.irrigation_type || pickFromSeed(IRRIGATION_TYPES, seed),
      soilPh: b.soil_ph || (5.8 + (seed % 12) / 10).toFixed(2),
      ownership: b.ownership || 'Company-owned',
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
    const seed = seedFromString(p.id);
    const parentBlock = rawBlocks.find(b => b.id === p.block_id);
    const areaHa = acresToHa(p.expected_area_acres);
    const harvest = parcelHarvestById.get(p.id);
    return {
      id: p.parcel_code || p.parcel_name || p.id,
      _uuid: p.id,
      block: parentBlock ? (parentBlock.block_code || parentBlock.id) : '—',
      _blockUuid: p.block_id,
      estate: parentBlock ? (estateNameById.get(parentBlock.estate_id) || 'Unassigned') : 'Unassigned',
      areaHa: Number(areaHa.toFixed(2)),
      variety: pickFromSeed(CANE_VARIETIES, seed), // placeholder — not yet captured per-parcel
      stage: stageFromCultivationStatus(p.cultivation_status),
      ratoon: p.ratoon_number ?? 0,
      health: healthFromCultivationStatus(p.cultivation_status),
      planted: p.planting_date,
      expectedHarvest: p.expected_harvest_date,
      yield: harvest?.harvest_tonnes ?? null,
      cultivationStatus: p.cultivation_status || 'not_in_cane',
      cultivationNotes: p.cultivation_notes,
      lastHarvestDate: harvest?.last_harvest_date ?? null,
      geometryStatus: p.geometry_status || 'pending',
      parcelName: p.parcel_name,
      currentActivity: p.current_activity_name || null,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      // Placeholder agronomy fields (clearly not yet in DB)
      _placeholders: {
        soilType: pickFromSeed(SOIL_TYPES, seed),
        soilPh: (5.8 + (seed % 14) / 10).toFixed(2),
        irrigationType: pickFromSeed(IRRIGATION_TYPES, seed + 1),
        drainageClass: pickFromSeed(DRAINAGE_CLASSES, seed + 2),
        brix: (15 + (seed % 30) / 10).toFixed(1),
        sucrose: (13 + (seed % 25) / 10).toFixed(1),
      },
    };
  });

  // ── ESTATES reshaped, with rollups from blocks ──
  const estates = rawEstates.map(e => {
    const estBlocks = blocks.filter(b => b.estate === e.estate_name);
    const totalAreaHa = estBlocks.reduce((s, b) => s + b.areaHa, 0);
    const plantedHa = estBlocks.reduce((s, b) => s + b.plantedHa, 0);
    const totalPlots = estBlocks.reduce((s, b) => s + b.plots, 0);
    const alertBlocks = estBlocks.filter(b => b.status === 'alert').length;
    const watchBlocks = estBlocks.filter(b => b.status === 'watch').length;
    return {
      id: 'E' + String(e.id).padStart(3, '0'),
      _id: e.id,
      name: e.estate_name,
      district: e.district || (e.address || '').split(',').pop().trim() || '—',
      location: e.address || '—',
      blocks: estBlocks.length,
      plots: totalPlots,
      areaHa: Number(totalAreaHa.toFixed(2)),
      plantedHa: Number(plantedHa.toFixed(2)),
      status: 'active',
      health: alertBlocks > 0 ? 'alert' : watchBlocks > estBlocks.length / 2 ? 'watch' : 'good',
      manager: e.owner_name || '—',
      managerPhone: e.owner_contact_phone || '—',
      createdAt: e.created_at,
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
    return {
      id: a.id,
      name: a.activity_name,
      date: a.activity_date,
      estate: estateNameForActivity(a),
      block: block ? (block.block_code || block.id) : '—',
      parcel: parcel ? (parcel.parcel_code || parcel.parcel_name || parcel.id) : (a.parcel_id ? '—' : null),
      assignedTo: assignee ? (assignee.full_name || assignee.email) : (a.assigned_to_legacy || '—'),
      teamSize: a.team_size,
      machines: a.number_of_machines,
      completionValue: a.completion_value,
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
      block: block ? (block.block_code || block.id) : '—',
      parcel: parcel ? (parcel.parcel_code || parcel.parcel_name) : '—',
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
      return b ? (b.block_code || b.id) : entity_id;
    }
    if (entity_type === 'parcel') {
      const p = parcelById.get(entity_id);
      return p ? (p.parcel_code || p.parcel_name || p.id) : entity_id;
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

  return {
    isLive: true,
    stats,
    estates,
    blocks,
    plots,
    productionMonthly: DATA.productionMonthly,       // kept as placeholder chart shape — no monthly history table yet
    productionByEstate: {
      labels: estates.map(e => e.name),
      values: estates.map(e => blocks.filter(b => b.estate === e.name).reduce((s, b) => s + (b.harvestTonnes || 0), 0)),
      colors: ['#2e6647', '#e8a020', '#4a9e6e', '#c0392b', '#2563eb', '#9fd4b8'].slice(0, estates.length),
    },
    costBreakdown: DATA.costBreakdown,                // placeholder — no cost ledger table yet
    yieldByVariety: DATA.yieldByVariety,              // placeholder — variety not tracked per-parcel yet
    users,
    emailSubscribers,
    activities,
    costs,
    documents,
    media,
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
      title: `${b.id} flagged for renovation`,
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
      text: `Parcel ${p.parcel_code || p.parcel_name} updated — status: ${titleCase(p.cultivation_status)}`,
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
