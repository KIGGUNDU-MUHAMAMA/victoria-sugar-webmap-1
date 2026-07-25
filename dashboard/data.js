// ══════════════════════════════════════
//  SUGARESTATE — FALLBACK / PLACEHOLDER DATA
//  This is shown only until live Supabase data finishes loading
//  (see supabase-client.js → initLiveData()). Once live data arrives,
//  this object is mutated in place with real estate/block/parcel records.
// ══════════════════════════════════════

const DATA = {

  // Set to true once live Supabase data has successfully loaded
  isLive: false,

  // ── STATS ──
  stats: {
    totalEstates: 4,
    totalBlocks: 18,
    totalPlots: 214,
    totalAreaHa: 4820.5,
    plantedAreaHa: 3640.8,
    fallowAreaHa: 680.2,
    reservedAreaHa: 499.5,
    activePlots: 162,
    fallowPlots: 38,
    underPrepPlots: 14,
    currentSeasonYieldTonnes: 28640,
    targetYieldTonnes: 34000,
    totalRevenue: 857200000,
    totalCost: 412800000,
    grossProfit: 444400000,
    avgYieldPerHa: 7.87,
    avgBrix: 16.4,
    avgSucrose: 14.1,
  },

  // ── ESTATES ──
  estates: [
    { id: 'E001', name: 'Kachung A', district: 'Lira', blocks: 5, plots: 62, areaHa: 1420, plantedHa: 1180, status: 'active', health: 'good', manager: 'John Onen' },
    { id: 'E002', name: 'Kachung B', district: 'Lira', blocks: 4, plots: 48, areaHa: 1100, plantedHa: 780, status: 'active', health: 'watch', manager: 'Grace Akello' },
    { id: 'E003', name: 'Masindi C', district: 'Masindi', blocks: 6, plots: 74, areaHa: 1640, plantedHa: 1380, status: 'active', health: 'good', manager: 'Peter Okello' },
    { id: 'E004', name: 'Jinja D', district: 'Jinja', blocks: 3, plots: 30, areaHa: 660, plantedHa: 300, status: 'active', health: 'alert', manager: 'Sarah Namukasa' },
  ],

  // ── BLOCKS ──
  blocks: [
    { id: 'BLK-A1', estate: 'Kachung A', plots: 14, areaHa: 310.5, plantedHa: 280.0, status: 'active', avgYield: 8.2, season: '2024-B' },
    { id: 'BLK-A2', estate: 'Kachung A', plots: 12, areaHa: 275.0, plantedHa: 265.0, status: 'active', avgYield: 7.8, season: '2024-B' },
    { id: 'BLK-A3', estate: 'Kachung A', plots: 10, areaHa: 290.0, plantedHa: 240.0, status: 'active', avgYield: 8.0, season: '2024-B' },
    { id: 'BLK-B1', estate: 'Kachung B', plots: 13, areaHa: 295.0, plantedHa: 220.0, status: 'active', avgYield: 7.1, season: '2024-B' },
    { id: 'BLK-B2', estate: 'Kachung B', plots: 11, areaHa: 260.0, plantedHa: 180.0, status: 'watch', avgYield: 6.5, season: '2024-B' },
    { id: 'BLK-C1', estate: 'Masindi C', plots: 15, areaHa: 330.0, plantedHa: 310.0, status: 'active', avgYield: 8.4, season: '2024-B' },
    { id: 'BLK-C2', estate: 'Masindi C', plots: 13, areaHa: 280.0, plantedHa: 265.0, status: 'active', avgYield: 8.1, season: '2024-B' },
    { id: 'BLK-D1', estate: 'Jinja D',   plots: 10, areaHa: 230.0, plantedHa: 110.0, status: 'alert', avgYield: 5.2, season: '2024-B' },
  ],

  // ── PLOTS SAMPLE ──
  plots: [
    { id: 'PLT-A1-001', block: 'BLK-A1', estate: 'Kachung A', areaHa: 22.4, variety: 'N14', stage: 'Grand Growth', ratoon: 1, health: 'good', planted: '2024-02-10', expectedHarvest: '2024-12-10', yield: null },
    { id: 'PLT-A1-002', block: 'BLK-A1', estate: 'Kachung A', areaHa: 18.6, variety: 'Co421', stage: 'Ripening', ratoon: 2, health: 'good', planted: '2024-01-15', expectedHarvest: '2024-10-15', yield: null },
    { id: 'PLT-A1-003', block: 'BLK-A1', estate: 'Kachung A', areaHa: 20.1, variety: 'N14', stage: 'Tillering', ratoon: 0, health: 'watch', planted: '2024-04-20', expectedHarvest: '2025-02-20', yield: null },
    { id: 'PLT-A2-001', block: 'BLK-A2', estate: 'Kachung A', areaHa: 24.0, variety: 'Mex64-1487', stage: 'Harvested', ratoon: 1, health: 'good', planted: '2023-12-01', expectedHarvest: '2024-08-01', yield: 192.0 },
    { id: 'PLT-B1-001', block: 'BLK-B1', estate: 'Kachung B', areaHa: 19.8, variety: 'N14', stage: 'Grand Growth', ratoon: 1, health: 'watch', planted: '2024-03-05', expectedHarvest: '2024-11-05', yield: null },
    { id: 'PLT-B2-001', block: 'BLK-B2', estate: 'Kachung B', areaHa: 21.2, variety: 'Co421', stage: 'Germination', ratoon: 0, health: 'watch', planted: '2024-06-10', expectedHarvest: '2025-04-10', yield: null },
    { id: 'PLT-C1-001', block: 'BLK-C1', estate: 'Masindi C', areaHa: 23.5, variety: 'N14', stage: 'Ripening', ratoon: 2, health: 'good', planted: '2023-11-20', expectedHarvest: '2024-09-20', yield: null },
    { id: 'PLT-D1-001', block: 'BLK-D1', estate: 'Jinja D', areaHa: 18.0, variety: 'Mex64-1487', stage: 'Fallow', ratoon: 0, health: 'alert', planted: null, expectedHarvest: null, yield: null },
    { id: 'PLT-D1-002', block: 'BLK-D1', estate: 'Jinja D', areaHa: 16.5, variety: 'N14', stage: 'Fallow', ratoon: 0, health: 'alert', planted: null, expectedHarvest: null, yield: null },
    { id: 'PLT-C2-001', block: 'BLK-C2', estate: 'Masindi C', areaHa: 20.8, variety: 'Co421', stage: 'Grand Growth', ratoon: 1, health: 'good', planted: '2024-02-28', expectedHarvest: '2024-12-28', yield: null },
  ],

  // ── PRODUCTION MONTHLY (tonnes) ──
  productionMonthly: {
    labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    actual:  [1800, 2100, 2400, 2600, 2200, 1900, 2800, 3100, 3400, 3600, null, null],
    target:  [2000, 2200, 2500, 2800, 2500, 2200, 3000, 3200, 3500, 3800, 3900, 4000],
  },

  // ── PRODUCTION BY ESTATE ──
  productionByEstate: {
    labels: ['Kachung A', 'Kachung B', 'Masindi C', 'Jinja D'],
    values: [9680, 6320, 11240, 1400],
    colors: ['#2e6647','#e8a020','#4a9e6e','#c0392b'],
  },

  // ── COST BREAKDOWN ──
  costBreakdown: {
    labels: ['Land Prep', 'Planting', 'Inputs', 'Labour', 'Irrigation', 'Harvest', 'Transport'],
    values: [38000000, 52000000, 120000000, 88000000, 44000000, 54000000, 16800000],
  },

  // ── YIELD PER VARIETY ──
  yieldByVariety: {
    labels: ['N14', 'Co421', 'Mex64-1487', 'NCo376', 'R570'],
    values: [8.4, 7.9, 7.2, 8.1, 6.8],
  },

  // ── USERS ──
  users: [
    { id: 'U001', name: 'Admin Moses',     email: 'moses@sugarestate.ug',   role: 'Admin',         estate: 'All Estates',  status: 'active',   lastLogin: '2024-10-14 08:30', avatar: 'AM' },
    { id: 'U002', name: 'John Onen',       email: 'j.onen@sugarestate.ug',  role: 'Land Manager',  estate: 'Kachung A',    status: 'active',   lastLogin: '2024-10-14 07:55', avatar: 'JO' },
    { id: 'U003', name: 'Grace Akello',    email: 'g.akello@sugarestate.ug',role: 'Land Manager',  estate: 'Kachung B',    status: 'active',   lastLogin: '2024-10-13 16:42', avatar: 'GA' },
    { id: 'U004', name: 'Peter Okello',    email: 'p.okello@sugarestate.ug',role: 'Land Manager',  estate: 'Masindi C',    status: 'active',   lastLogin: '2024-10-14 09:10', avatar: 'PO' },
    { id: 'U005', name: 'Sarah Namukasa',  email: 's.namukasa@sugarestate.ug',role:'Land Manager', estate: 'Jinja D',      status: 'active',   lastLogin: '2024-10-12 14:20', avatar: 'SN' },
    { id: 'U006', name: 'David Opiyo',     email: 'd.opiyo@sugarestate.ug', role: 'Field Officer', estate: 'Kachung A',    status: 'active',   lastLogin: '2024-10-14 06:45', avatar: 'DO' },
    { id: 'U007', name: 'Harriet Atim',    email: 'h.atim@sugarestate.ug',  role: 'Field Officer', estate: 'Kachung B',    status: 'active',   lastLogin: '2024-10-13 11:30', avatar: 'HA' },
    { id: 'U008', name: 'Emmanuel Wafula', email: 'e.wafula@sugarestate.ug',role: 'Field Officer', estate: 'Masindi C',    status: 'active',   lastLogin: '2024-10-14 07:00', avatar: 'EW' },
    { id: 'U009', name: 'Ivan Kizito',     email: 'i.kizito@sugarestate.ug',role: 'Surveyor',      estate: 'All Estates',  status: 'active',   lastLogin: '2024-10-10 09:00', avatar: 'IK' },
    { id: 'U010', name: 'Roland Musoke',   email: 'r.musoke@invest.co.ug',  role: 'Investor',      estate: 'Kachung A',    status: 'active',   lastLogin: '2024-10-08 15:30', avatar: 'RM' },
    { id: 'U011', name: 'Agnes Nakato',    email: 'a.nakato@invest.co.ug',  role: 'Investor',      estate: 'Masindi C',    status: 'active',   lastLogin: '2024-09-30 10:00', avatar: 'AN' },
    { id: 'U012', name: 'Brian Ssemakula', email: 'b.ssemakula@sugarestate.ug',role:'Agronomist',  estate: 'All Estates',  status: 'active',   lastLogin: '2024-10-13 14:00', avatar: 'BS' },
    { id: 'U013', name: 'Fatuma Nakirya',  email: 'f.nakirya@sugarestate.ug',role:'Field Officer', estate: 'Jinja D',      status: 'inactive', lastLogin: '2024-09-15 08:00', avatar: 'FN' },
    { id: 'U014', name: 'Julius Ochieng',  email: 'j.ochieng@sugarestate.ug',role:'Stakeholder',   estate: 'Kachung B',    status: 'active',   lastLogin: '2024-10-01 12:00', avatar: 'JC' },
  ],

  // ── EMAIL SUBSCRIBERS ──
  emailSubscribers: [
    { id: 1, email: 'director@sugarestate.ug',    name: 'Executive Director',  frequency: 'Weekly',  lastSent: '2024-10-07', status: 'active' },
    { id: 2, email: 'r.musoke@invest.co.ug',      name: 'Roland Musoke',       frequency: 'Monthly', lastSent: '2024-10-01', status: 'active' },
    { id: 3, email: 'a.nakato@invest.co.ug',      name: 'Agnes Nakato',        frequency: 'Monthly', lastSent: '2024-10-01', status: 'active' },
    { id: 4, email: 'board@sugarestate.ug',       name: 'Board Secretary',     frequency: 'Monthly', lastSent: '2024-10-01', status: 'active' },
    { id: 5, email: 'agronomy@sugarestate.ug',    name: 'Agronomy Team',       frequency: 'Weekly',  lastSent: '2024-10-07', status: 'active' },
    { id: 6, email: 'finance@sugarestate.ug',     name: 'Finance Manager',     frequency: 'Weekly',  lastSent: '2024-10-07', status: 'active' },
  ],

  // ── ALERTS ──
  alerts: [
    { id: 1, type: 'critical', title: 'Jinja D — Low planting rate', desc: 'Only 45% of plots in Jinja D have been planted this season. Immediate intervention required.', time: '2 hours ago', estate: 'Jinja D' },
    { id: 2, type: 'critical', title: 'BLK-D1 pest scouting overdue', desc: 'Last scouting was 28 days ago. Pest or disease risk elevated.', time: '5 hours ago', estate: 'Jinja D' },
    { id: 3, type: 'warning',  title: 'Kachung B — Below target yield', desc: 'Season 2024-B projected yield is 18% below target for BLK-B2.', time: '1 day ago', estate: 'Kachung B' },
    { id: 4, type: 'warning',  title: '14 plots due for harvest within 30 days', desc: 'Harvesting crew scheduling needed for Masindi C and Kachung A.', time: '1 day ago', estate: 'Masindi C' },
    { id: 5, type: 'info',     title: 'Soil tests due for BLK-A3', desc: '90-day soil test cycle is approaching for Block A3, Kachung A.', time: '2 days ago', estate: 'Kachung A' },
    { id: 6, type: 'info',     title: 'New season (2025-A) planning window opens', desc: 'Land preparation planning for 2025-A should begin within 60 days.', time: '3 days ago', estate: 'All Estates' },
  ],

  // ── RECENT ACTIVITY ──
  recentActivity: [
    { type: 'harvest', icon: '🌾', color: 'green', text: 'PLT-A2-001 harvested — 192 tonnes, Brix 16.8%', meta: 'Kachung A · BLK-A2 · 2 hours ago' },
    { type: 'task',    icon: '✓',  color: 'blue',  text: 'Fertilizer application completed on PLT-C1-001 (120 kg/ha CAN)', meta: 'Masindi C · BLK-C1 · 4 hours ago' },
    { type: 'alert',   icon: '⚠',  color: 'amber', text: 'Weed pressure flagged as HIGH on PLT-B2-001', meta: 'Kachung B · BLK-B2 · 6 hours ago' },
    { type: 'user',    icon: '👤', color: 'blue',  text: 'New field officer account created for Emmanuel Wafula', meta: 'System · Admin Moses · 8 hours ago' },
    { type: 'scout',   icon: '🔍', color: 'green', text: 'Scouting completed on 8 plots in BLK-C2 — All clear', meta: 'Masindi C · Peter Okello · 1 day ago' },
    { type: 'alert',   icon: '🚨', color: 'red',   text: 'Pest detected (Eldana saccharina) in PLT-D1-001', meta: 'Jinja D · BLK-D1 · 1 day ago' },
    { type: 'task',    icon: '💧', color: 'blue',  text: 'Irrigation scheduled for BLK-A1 (16 plots)', meta: 'Kachung A · John Onen · 1 day ago' },
    { type: 'finance', icon: '₤',  color: 'green', text: 'Invoice #INV-2024-088 paid — UGX 18,400,000', meta: 'Finance · 2 days ago' },
  ],

};
