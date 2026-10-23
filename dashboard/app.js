// ══════════════════════════════════════
//  SUGARESTATE ADMIN — APP.JS
// ══════════════════════════════════════

let activeCharts = [];
let currentPage = null;
let viewingUserId = null; // user id when viewing full user detail (Users page drill-down)

// ── UTILS ──────────────────────────────

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString();
}
function fmtUGX(n) {
  if (!n) return '—';
  if (n >= 1_000_000_000) return 'UGX ' + (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000)     return 'UGX ' + (n / 1_000_000).toFixed(1) + 'M';
  return 'UGX ' + fmt(n);
}
// Internal area values are stored in hectares (converted from the DB's acre
// columns in supabase-client.js); the UI's default display unit is acres, so
// this formatter converts back on the way out. Kept named fmtHa for the
// (very large) set of existing call sites — it now renders acres.
function fmtHa(n)   { return n != null ? (Number(n) * 2.47105).toFixed(1) + ' ac' : '—'; }
function fmtAcres(n){ return fmtHa(n); }
function pct(a, b)  { return b ? Math.round((a / b) * 100) : 0; }
// Adds N months to a 'YYYY-MM-DD' date string, returning a new 'YYYY-MM-DD' string.
// Used by the Harvests page to project the next harvest-due date after a harvest is
// logged (harvest_date + the estate's configured harvest_period_months).
function addMonthsToDateStr(dateStr, months) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + (Number(months) || 0));
  return d.toISOString().slice(0, 10);
}
function titleCaseLocal(str) {
  if (!str) return str;
  return String(str).replace(/_/g, ' ').replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}
// Entity-type labels for Documents/Media "Linked To" — DB stores 'parcel' but the UI says "Plot".
function entityTypeLabel(t) { return t === 'parcel' ? 'Plot' : titleCaseLocal(t); }

// Growth-stage labels, matching the buckets stageFromCultivationStatus() in
// supabase-client.js maps cultivation_status onto (Grand Growth, Tillering,
// Under Prep, Fallow, etc). Order here is display order; unknown stages fall
// back to gray rather than being silently dropped.
const STAGE_ORDER  = ['Germination','Tillering','Grand Growth','Ripening','Harvested','Under Prep','Fallow'];
const STAGE_COLORS = { Germination:'#60a5fa', Tillering:'#2563eb', 'Grand Growth':'#4a9e6e', Ripening:'#e8a020', Harvested:'#16a34a', 'Under Prep':'#f4c56a', Fallow:'#c8d0ce' };
function plotStageDistribution() {
  const counts = {};
  DATA.plots.forEach(p => { counts[p.stage] = (counts[p.stage]||0) + 1; });
  const known = STAGE_ORDER.filter(s => counts[s]);
  const other = Object.keys(counts).filter(s => !STAGE_ORDER.includes(s));
  const labels = [...known, ...other];
  return {
    labels,
    values: labels.map(s => counts[s]),
    colors: labels.map(s => STAGE_COLORS[s] || '#9ca3af'),
  };
}

function pill(text, color) {
  return `<span class="pill ${color}">${text}</span>`;
}
function healthPill(h) {
  const map = { good:'green', watch:'amber', alert:'red', active:'green', inactive:'gray',
                fallow:'gray', planted:'green', harvested:'blue', critical:'red' };
  const label = h ? h.charAt(0).toUpperCase() + h.slice(1) : '—';
  return pill(label, map[h] || 'gray');
}
function stagePill(s) {
  if (!s) return pill('—','gray');
  const map = { 'Germination':'blue','Tillering':'blue','Grand Growth':'green',
                'Ripening':'amber','Harvested':'green','Fallow':'gray','Under Prep':'amber' };
  return pill(s, map[s] || 'gray');
}

// ── AVATARS ──
// initialsFrom/avatarHTML are the one shared way any person (a vsl_profiles
// user, or an estate/block/plot's assigned manager, which is just a profile
// referenced by manager_id) gets rendered anywhere in the dashboard: a
// circular photo if avatar_url is set, otherwise a circular initials badge —
// always carrying a title= tooltip with the person's name so they're still
// identifiable without text next to it.
function initialsFrom(name) {
  return (name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}
// shape: 'circle' (default — Users nav, topbar, etc.) or 'square' (rounded-
// corner square — used for manager avatars in the Land Management tables).
function avatarHTML(name, avatarUrl, size, shape) {
  size = size || 32;
  const radius = shape === 'square' ? Math.max(6, Math.round(size * 0.22)) + 'px' : '50%';
  const title = (name || 'Unknown').replace(/"/g, '&quot;');
  if (avatarUrl) {
    return `<img src="${avatarUrl}" alt="${title}" title="${title}" style="width:${size}px;height:${size}px;border-radius:${radius};object-fit:cover;flex-shrink:0">`;
  }
  const initials = name ? initialsFrom(name) : '👤';
  return `<div class="user-avatar" title="${title}" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.34)}px;flex-shrink:0;border-radius:${radius}">${initials || '👤'}</div>`;
}

// Shared clickable "Manager" cell used by the Estates, Blocks & Plots tables
// and by their detail attribute lists. Each has a single assigned manager
// (vsl_estate.manager_id / vsl_blocks.manager_id / vsl_parcels.manager_id —
// a direct FK to vsl_profiles, one manager per record). If one is assigned,
// their photo (or an initials/emoji placeholder, titled with their name) is
// a clickable button that opens a small detail popup; otherwise a
// "+ Link Manager" button is shown in its place.
function managerCellHTML(scopeType, scopeId, scopeLabel, managerId, managerName, managerAvatarUrl, showName) {
  if (managerId) {
    return `<button type="button" onclick="viewManagerDetail('${scopeType}','${scopeId}')"
              style="background:none;border:none;padding:0;cursor:pointer;display:inline-flex;align-items:center;gap:8px;line-height:1.2">
              ${avatarHTML(managerName, managerAvatarUrl, 32, 'square')}
              ${showName ? `<span style="font-weight:600;color:var(--green-700);text-decoration:underline">${managerName || 'View manager'}</span>` : ''}
            </button>`;
  }
  return `<button class="icon-btn" onclick="event.stopPropagation();showLinkManagerModal('${scopeType}','${scopeId}','${(scopeLabel||'').replace(/'/g,"")}')" title="Link Manager">👤</button>`;
}

// Uploads a picked File to the public "Media" Storage bucket under avatars/
// and returns its public URL (saved straight onto vsl_profiles.avatar_url).
// Always a fresh random filename — never overwrites — so replacing a photo
// can't end up serving a stale cached image at the same URL.
async function uploadAvatarFile(file) {
  if (!file) return null;
  const client = getSbClient();
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const path = `avatars/${crypto.randomUUID()}.${ext}`;
  const { error } = await client.storage.from('Media').upload(path, file, { upsert: false, contentType: file.type || undefined });
  if (error) throw new Error('Photo upload failed: ' + error.message);
  return client.storage.from('Media').getPublicUrl(path).data.publicUrl;
}

// Resolves the signed-in user's id (auth.users.id == vsl_profiles.id) so writes
// that should be attributed to "who did this" (created_by columns) can be set
// explicitly rather than left null — used when logging activities/harvests.
async function getCurrentUserId() {
  try {
    const { data: sess } = await getSbClient().auth.getSession();
    return sess?.session?.user?.id || null;
  } catch (err) {
    console.error('Failed to resolve current user id:', err);
    return null;
  }
}

function showToast(msg, color) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = color==='red' ? 'var(--red-500)'
                     : color==='amber' ? 'var(--amber-600)'
                     : 'var(--green-800)';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3200);
}

function destroyCharts() {
  activeCharts.forEach(c => { try { c.destroy(); } catch(e){} });
  activeCharts = [];
}

// ── PAGE SWITCHING ────────────────────
// Sidebar is a fixed rail on desktop and a permanent icon-only rail on mobile
// (nav items are directly tappable by icon — no expand/collapse affordance).

const PAGE_TITLES = {
  dashboard:     'Dashboard',
  analytics:     'Estate Analytics',
  estates:       'Land Management',
  production:    'Harvests',
  seasons:       'Seasons',
  activities:    'Activities',
  costs:         'Costs',
  documents:     'Documents & Media',
  users:         'Users',
  notifications: 'Reports',
  messages:      'Messages',
  alerts:        'Alerts & Notifications',
  settings:      'Settings',
};

function openPanel(page, navEl) {
  // Update active nav item — fall back to matching by page id if no element was clicked
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (navEl) {
    navEl.classList.add('active');
  } else {
    const match = [...document.querySelectorAll('.nav-item')]
      .find(n => (n.getAttribute('onclick') || '').includes(`openPanel('${page}'`));
    if (match) match.classList.add('active');
  }

  currentPage = page;
  if (page === 'activities') markActivitiesSeen();
  document.getElementById('panel-title').textContent = PAGE_TITLES[page] || page;

  destroyCharts();
  const body = document.getElementById('panel-body');
  body.innerHTML = '';

  const pages = {
    dashboard:     renderDashboard,
    analytics:     renderAnalytics,
    estates:       renderEstatesPage,
    production:    renderProduction,
    seasons:       renderSeasons,
    activities:    renderActivities,
    costs:         renderCosts,
    documents:     renderDocuments,
    users:         renderUsers,
    notifications: renderNotifications,
    messages:      renderMessages,
    alerts:        renderAlerts,
    settings:      renderSettings,
  };
  if (pages[page]) pages[page](body);

  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  setTimeout(() => initCharts(page), 60);
}

// ══════════════════════════════════════
//  PAGE: DASHBOARD
// ══════════════════════════════════════

function renderDashboard(el) {
  const s = DATA.stats;
  el.innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-header-title">Overview</div>
      <div class="page-header-sub">Season 2024-B · All Estates · Last updated: Today 09:14</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <select class="form-input" style="width:150px">
        <option>All Estates</option>
        ${DATA.estates.map(e=>`<option>${e.name}</option>`).join('')}
      </select>
      <button class="btn btn-primary btn-sm" onclick="openPanel('analytics',null)">Full Analytics →</button>
    </div>
  </div>

  <div class="grid-4">
    <div class="stat-card green">
      <div class="stat-label">Total Area</div>
      <div class="stat-value">${fmtHa(s.totalAreaHa)}</div>
      <div class="stat-meta">${fmtHa(s.plantedAreaHa)} planted · ${fmtHa(s.fallowAreaHa)} fallow</div>
    </div>
    <div class="stat-card blue">
      <div class="stat-label">Active Plots</div>
      <div class="stat-value">${s.activePlots}</div>
      <div class="stat-meta">${s.totalPlots} total · ${s.fallowPlots} fallow · ${s.underPrepPlots} prep</div>
    </div>
    <div class="stat-card amber">
      <div class="stat-label">Season Yield</div>
      <div class="stat-value">${fmt(s.currentSeasonYieldTonnes)}<span style="font-size:14px;font-weight:500"> t</span></div>
      <div class="stat-meta">${pct(s.currentSeasonYieldTonnes,s.targetYieldTonnes)}% of ${fmt(s.targetYieldTonnes)} t target</div>
    </div>
    <div class="stat-card green">
      <div class="stat-label">Gross Profit</div>
      <div class="stat-value" style="font-size:20px">${fmtUGX(s.grossProfit)}</div>
      <div class="stat-meta">Rev ${fmtUGX(s.totalRevenue)} · Cost ${fmtUGX(s.totalCost)}</div>
    </div>
  </div>

  <div class="grid-2-1">
    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Monthly Production (Tonnes)</div>
          <div class="card-sub">Actual harvest tonnage · last 12 months</div>
        </div>
      </div>
      <div class="chart-box"><canvas id="chart-prod-monthly"></canvas></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Production by Estate</div></div>
      <div style="max-width:180px;margin:0 auto"><canvas id="chart-prod-estate"></canvas></div>
      <div style="margin-top:12px">
        ${DATA.productionByEstate.labels.map((l,i)=>`
          <div class="legend-row">
            <span class="legend-dot" style="background:${DATA.productionByEstate.colors[i]}"></span>
            <span>${l}</span>
            <span class="legend-val">${fmt(DATA.productionByEstate.values[i])} t</span>
          </div>`).join('')}
      </div>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="card-header"><div class="card-title">Plot Status Distribution</div></div>
      <div class="chart-box"><canvas id="chart-plot-status"></canvas></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Area Utilisation</div></div>
      <div class="chart-box"><canvas id="chart-area-util"></canvas></div>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <div class="card-header">
        <div class="card-title">Estate Summary</div>
        <button class="btn btn-outline btn-sm" onclick="openPanel('analytics',null)">View all</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Estate</th><th>Blocks</th><th>Plots</th><th>Area</th><th>Health</th></tr></thead>
          <tbody>
            ${DATA.estates.map(e=>`
              <tr>
                <td><strong>${e.name}</strong><br><span style="font-size:11px;color:var(--gray-500)">${e.district}</span></td>
                <td>${e.blocks}</td><td>${e.plots}</td>
                <td>${fmtHa(e.areaHa)}</td>
                <td>${healthPill(e.health)}</td>
              </tr>`).join('')}
          </tbody>
          <tfoot><tr style="font-weight:700;background:var(--gray-50)">
            <td>Total</td>
            <td>${s.totalBlocks}</td><td>${s.totalPlots}</td>
            <td>${fmtHa(s.totalAreaHa)}</td><td></td>
          </tr></tfoot>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Recent Activity</div></div>
      ${DATA.recentActivity.map(a=>`
        <div class="activity-item">
          <div class="activity-dot ${a.color}">${a.icon}</div>
          <div class="activity-content">
            <div class="activity-text">${a.text}</div>
            <div class="activity-meta">${a.meta}</div>
          </div>
        </div>`).join('')}
    </div>
  </div>

  <div class="card" style="margin-bottom:20px">
    <div class="card-header"><div class="card-title">Operational Indicators</div></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));border:1px solid var(--gray-100);border-radius:var(--radius-sm);overflow:hidden">
      ${[
        ['Active Blocks', DATA.blocks.filter(b=>b.status==='active').length, 'Of '+s.totalBlocks],
        ['Estates', s.totalEstates, 'Operational'],
        ['Boundary Captured', pct(DATA.blocks.filter(b=>b.geometryStatus==='captured').length, DATA.blocks.length)+'%', 'Blocks surveyed'],
        ['Open Alerts', DATA.alerts.filter(a=>!a.isReal || a.status!=='resolved').length, DATA.alerts.filter(a=>a.type==='critical').length+' critical'],
        ['Activities (7d)', DATA.activities.filter(a=>a.date && new Date(a.date).getTime() >= Date.now()-7*24*60*60*1000).length, 'Logged this week'],
        ['Total Cost Logged', fmtUGX(DATA.costs.reduce((sum,c)=>sum+c.amount,0)), DATA.costs.length+' entries'],
      ].map(([l,v,m])=>`
        <div class="kpi-mini" style="border-right:1px solid var(--gray-100)">
          <div class="kpi-mini-val">${v}</div>
          <div class="kpi-mini-label">${l}</div>
          <div style="font-size:10px;color:var(--gray-500);margin-top:2px">${m}</div>
        </div>`).join('')}
    </div>
  </div>`;
}

// ══════════════════════════════════════
//  PAGE: ESTATE ANALYTICS
// ══════════════════════════════════════

function renderAnalytics(el) {
  let estFilter = '';

  function estateRows() { return DATA.estates.filter(e => !estFilter || e.name === estFilter); }
  function activityRows() { return DATA.activities.filter(a => !estFilter || a.estate === estFilter).slice(0, 12); }

  function estateTable() {
    const rows = estateRows();
    const totals = rows.reduce((t,e)=>({
      blocks: t.blocks+e.blocks, plots: t.plots+e.plots, areaHa: t.areaHa+e.areaHa, plantedHa: t.plantedHa+e.plantedHa,
    }), { blocks:0, plots:0, areaHa:0, plantedHa:0 });
    return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Estate</th><th>District</th><th>Manager</th><th>Blocks</th><th>Plots</th>
          <th>Total Area</th><th>Planted</th><th>Utilisation</th><th>Health</th></tr>
        </thead>
        <tbody>
          ${rows.length ? rows.map(e=>`
            <tr>
              <td><strong>${e.name}</strong></td><td>${e.district}</td><td>${e.manager}</td>
              <td>${e.blocks}</td><td>${e.plots}</td>
              <td>${fmtHa(e.areaHa)}</td><td>${fmtHa(e.plantedHa)}</td>
              <td>
                <div style="display:flex;align-items:center;gap:8px">
                  <div class="progress-bar-wrap" style="width:80px">
                    <div class="progress-bar ${pct(e.plantedHa,e.areaHa)>75?'green':pct(e.plantedHa,e.areaHa)>50?'amber':'red'}"
                         style="width:${pct(e.plantedHa,e.areaHa)}%"></div>
                  </div>
                  <span style="font-size:12px;font-weight:600">${pct(e.plantedHa,e.areaHa)}%</span>
                </div>
              </td>
              <td>${healthPill(e.health)}</td>
            </tr>`).join('') : `<tr><td colspan="9" style="text-align:center;color:var(--gray-500);padding:24px">No estates match this filter</td></tr>`}
        </tbody>
        ${rows.length ? `<tfoot><tr style="font-weight:700;background:var(--gray-50)">
          <td colspan="3">Total</td>
          <td>${totals.blocks}</td><td>${totals.plots}</td>
          <td>${fmtHa(totals.areaHa)}</td><td>${fmtHa(totals.plantedHa)}</td>
          <td colspan="2">${pct(totals.plantedHa,totals.areaHa)}% overall</td>
        </tr></tfoot>` : ''}
      </table>
    </div>`;
  }

  function activityTable() {
    const rows = activityRows();
    return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Activity</th><th>Estate</th><th>Block</th><th>Plot</th><th>Assigned To</th><th>Completion</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(a=>`
            <tr>
              <td>${a.date || '—'}</td><td><strong>${a.name}</strong></td><td>${a.estate}</td>
              <td>${a.block}</td><td>${a.parcel || '—'}</td><td>${a.assignedTo || '—'}</td>
              <td>${a.completionValue != null ? a.completionValue : '—'}</td>
            </tr>`).join('') : `<tr><td colspan="7" style="text-align:center;color:var(--gray-500);padding:24px">No activities logged yet</td></tr>`}
        </tbody>
      </table>
    </div>`;
  }

  el.innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-header-title">Estate Analytics</div>
      <div class="page-header-sub">Comprehensive estate performance data</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <select class="form-input" style="width:160px" id="an-estate-filter" onchange="applyAnalyticsFilter(this.value)">
        <option value="">All Estates</option>
        ${DATA.estates.map(e=>`<option value="${e.name}">${e.name}</option>`).join('')}
      </select>
      <button class="btn btn-primary btn-sm" onclick="showToast('PDF export coming soon')">Export PDF</button>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px">
    <div class="card-header"><div class="card-title">Recent Activities</div>
      <div style="font-size:11px;color:var(--gray-500)">Latest 12${estFilter ? ' · ' + estFilter : ''}</div></div>
    <div id="an-activities">${activityTable()}</div>
  </div>

  <div class="grid-3" style="margin-bottom:20px">
    <div class="card">
      <div class="card-header"><div class="card-title">Yield by Variety</div></div>
      <div class="chart-box"><canvas id="chart-yield-variety"></canvas></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Cost Breakdown</div></div>
      <div class="chart-box"><canvas id="chart-cost-break"></canvas></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Plot Stage Distribution</div></div>
      <div class="chart-box"><canvas id="chart-stage-dist"></canvas></div>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px">
    <div class="card-header"><div class="card-title">Estate Performance Comparison</div></div>
    <div id="an-estates">${estateTable()}</div>
  </div>

  <div class="grid-4" style="margin-bottom:20px">
    <div class="stat-card green">
      <div class="stat-label">Total Revenue</div>
      <div class="stat-value" style="font-size:20px">${fmtUGX(DATA.stats.totalRevenue)}</div>
    </div>
    <div class="stat-card red">
      <div class="stat-label">Total Cost</div>
      <div class="stat-value" style="font-size:20px">${fmtUGX(DATA.stats.totalCost)}</div>
    </div>
    <div class="stat-card green">
      <div class="stat-label">Gross Profit</div>
      <div class="stat-value" style="font-size:20px">${fmtUGX(DATA.stats.grossProfit)}</div>
      <div class="stat-meta">Margin: ${pct(DATA.stats.grossProfit,DATA.stats.totalRevenue)}%</div>
    </div>
    <div class="stat-card amber">
      <div class="stat-label">Cost per Tonne</div>
      <div class="stat-value" style="font-size:20px">UGX ${fmt(Math.round(DATA.stats.totalCost/DATA.stats.currentSeasonYieldTonnes))}</div>
    </div>
  </div>`;

  window.applyAnalyticsFilter = function(val) {
    estFilter = val;
    document.getElementById('an-estates').innerHTML = estateTable();
    document.getElementById('an-activities').innerHTML = activityTable();
  };
}

// ══════════════════════════════════════
//  PAGE: ESTATES, BLOCKS & PLOTS  (renamed from "Plots & Blocks")
// ══════════════════════════════════════

function renderEstatesPage(el) {
  // State
  let activeTab         = 'estates';
  let selectedEstate    = '';
  let selectedBlock     = null;   // block id when drilling into a block
  let viewingPlotId     = null;   // plot id when viewing full plot detail
  let viewingEstateId   = null;   // estate id when viewing full estate detail (from Estates tab)
  let viewingBlockId    = null;   // block id when viewing full block detail (from Estates tab drill-down)

  // ── Helper: estate summary stats for one estate ──
  function estateStats(estate) {
    const blocks = DATA.blocks.filter(b => !estate || b.estate === estate);
    const plots  = DATA.plots.filter(p => !estate || p.estate === estate);
    return {
      totalBlocks:  blocks.length,
      totalPlots:   plots.length,
      totalAreaHa:  blocks.reduce((s,b)=>s+b.areaHa,0),
      plantedHa:    blocks.reduce((s,b)=>s+b.plantedHa,0),
      fallowHa:     blocks.reduce((s,b)=>s+(b.areaHa-b.plantedHa),0),
      activePlots:  plots.filter(p=>p.health==='good').length,
      alertPlots:   plots.filter(p=>p.health==='alert').length,
    };
  }

  // ── TAB: ESTATES ──
  function buildEstatesTab() {
    const estatesData = [...DATA.estates];
    const allStats = estateStats('');
    return `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:flex-end">
      <div class="form-group" style="max-width:200px;margin-bottom:0">
        <label class="form-label">Filter Estate</label>
        <select class="form-input" id="est-filter" onchange="applyEstFilter(this.value)">
          <option value="">All Estates</option>
          ${DATA.estates.map(e=>`<option value="${e.name}" ${selectedEstate===e.name?'selected':''}>${e.name}</option>`).join('')}
        </select>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" onclick="showAddEstateModal()">+ Add Estate</button>
      </div>
    </div>

    <!-- Summary stats -->
    <div class="grid-4" style="margin-bottom:20px">
      <div class="stat-card green">
        <div class="stat-label">Total Estates</div>
        <div class="stat-value">${estatesData.length}</div>
        <div class="stat-meta">Operational</div>
      </div>
      <div class="stat-card blue">
        <div class="stat-label">Total Blocks</div>
        <div class="stat-value">${allStats.totalBlocks}</div>
        <div class="stat-meta">Across all estates</div>
      </div>
      <div class="stat-card amber">
        <div class="stat-label">Total Plots</div>
        <div class="stat-value">${allStats.totalPlots}</div>
        <div class="stat-meta">${allStats.activePlots} healthy · ${allStats.alertPlots} on alert</div>
      </div>
      <div class="stat-card green">
        <div class="stat-label">Total Area</div>
        <div class="stat-value" style="font-size:20px">${fmtHa(allStats.totalAreaHa)}</div>
        <div class="stat-meta">${fmtHa(allStats.plantedHa)} planted</div>
      </div>
    </div>

    <!-- Estates table -->
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Estate</th><th>District</th><th>Manager</th><th>Blocks</th>
            <th>Plots</th><th>Total Area</th><th>Planted Ac</th>
            <th>Fallow Ac</th><th>Utilisation</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${estatesData.filter(e=>!selectedEstate||e.name===selectedEstate).map(e=>{
            const st = estateStats(e.name);
            return `
            <tr style="cursor:pointer" onclick="viewEstateDetail('${e.id}')">
              <td>
                <div style="font-weight:700">${e.name}</div>
                <div style="font-size:11px;color:var(--gray-500)">${e.id}</div>
              </td>
              <td>${e.district}</td>
              <td style="text-align:center" onclick="event.stopPropagation()">${managerCellHTML('estate', e._id, e.name, e.managerId, e.assignedManagerName, e.assignedManagerAvatarUrl)}</td>
              <td><strong>${e.blocks}</strong></td>
              <td><strong>${e.plots}</strong></td>
              <td>${fmtHa(e.areaHa)}</td>
              <td>${fmtHa(e.plantedHa)}</td>
              <td>${fmtHa(e.areaHa - e.plantedHa)}</td>
              <td>
                <div style="display:flex;align-items:center;gap:7px">
                  <div class="progress-bar-wrap" style="width:70px">
                    <div class="progress-bar ${pct(e.plantedHa,e.areaHa)>75?'green':pct(e.plantedHa,e.areaHa)>50?'amber':'red'}"
                         style="width:${pct(e.plantedHa,e.areaHa)}%"></div>
                  </div>
                  <span style="font-size:11px;font-weight:700">${pct(e.plantedHa,e.areaHa)}%</span>
                </div>
              </td>
              <td onclick="event.stopPropagation()">
                <div style="display:flex;gap:4px">
                  <button class="icon-btn" onclick="showEditEstateModal('${e.id}')" title="Edit">✎</button>
                  <button class="icon-btn danger" onclick="confirmDeleteEstate('${e.id}','${e.name}')" title="Delete">🗑</button>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="font-size:12px;color:var(--gray-500);margin-top:10px">
      💡 Click any estate row to view full estate details
    </div>`;
  }

  // ── TAB: BLOCKS ──
  function buildBlocksTab() {
    const filtered = DATA.blocks.filter(b=>!selectedEstate||b.estate===selectedEstate);
    return `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:flex-end">
      <input class="form-input" style="max-width:200px" placeholder="Search blocks..." id="blk-search"
             oninput="filterBlockRows(this.value)">
      <select class="form-input" style="width:150px" id="blk-estate-filter"
              onchange="applyEstFilter(this.value)">
        <option value="">All Estates</option>
        ${DATA.estates.map(e=>`<option value="${e.name}" ${selectedEstate===e.name?'selected':''}>${e.name}</option>`).join('')}
      </select>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Block Name</th><th>Estate</th><th>Plots</th><th>Total Area</th>
          <th>Planted</th><th>Utilisation</th><th>Avg Yield</th><th>Manager</th>
          <th>Actions</th></tr>
        </thead>
        <tbody id="blocks-tbody">
          ${filtered.map(b=>`
            <tr class="blk-row" data-estate="${b.estate}" data-status="${b.status}"
                style="cursor:pointer" onclick="viewBlockDetail('${b.id}')">
              <td><strong>${b.name || b.id}</strong><br><span style="font-size:11px;color:var(--gray-500)">${b.id}</span></td>
              <td>${b.estate}</td>
              <td>${b.plots}</td>
              <td>${fmtHa(b.areaHa)}</td>
              <td>${fmtHa(b.plantedHa)}</td>
              <td>
                <div style="display:flex;align-items:center;gap:6px">
                  <div class="progress-bar-wrap" style="width:70px">
                    <div class="progress-bar ${pct(b.plantedHa,b.areaHa)>75?'green':pct(b.plantedHa,b.areaHa)>50?'amber':'red'}"
                         style="width:${pct(b.plantedHa,b.areaHa)}%"></div>
                  </div>
                  <span style="font-size:11px;font-weight:700">${pct(b.plantedHa,b.areaHa)}%</span>
                </div>
              </td>
              <td><strong>${b.avgYield}</strong> t/ac</td>
              <td style="text-align:center" onclick="event.stopPropagation()">${managerCellHTML('block', b._uuid, b.name || b.id, b.managerId, b.assignedManagerName, b.assignedManagerAvatarUrl)}</td>
              <td onclick="event.stopPropagation()">
                <div style="display:flex;gap:4px">
                  <button class="icon-btn" onclick="showEditBlockModal('${b.id}')" title="Edit">✎</button>
                  <button class="icon-btn danger" onclick="confirmDeleteBlock('${b.id}')" title="Delete">🗑</button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="font-size:12px;color:var(--gray-500);margin-top:10px">
      💡 Click any block row to view full block details
    </div>`;
  }

  // ── TAB: PLOTS (all plots or filtered by block) ──
  function buildPlotsTab(blockId) {
    const filtered = DATA.plots.filter(p =>
      (!selectedEstate || p.estate === selectedEstate) &&
      (!blockId || p.block === blockId)
    );
    // Block filter options are scoped to the currently selected estate (if any)
    const blocksForFilter = DATA.blocks.filter(b => !selectedEstate || b.estate === selectedEstate);
    const activeBlock = blockId ? DATA.blocks.find(b => b.id === blockId) : null;
    return `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:flex-end">
      <input class="form-input" style="max-width:180px" placeholder="Search plots..." id="plt-search"
             oninput="filterPlotRows(this.value)">
      <select class="form-input" style="width:150px" onchange="applyEstFilter(this.value)">
        <option value="">All Estates</option>
        ${DATA.estates.map(e=>`<option value="${e.name}" ${selectedEstate===e.name?'selected':''}>${e.name}</option>`).join('')}
      </select>
      <select class="form-input" style="width:160px" id="plt-block-filter" onchange="applyPlotBlockFilter(this.value)">
        <option value="">All Blocks</option>
        ${blocksForFilter.map(b=>`<option value="${b.id}" ${b.id===blockId?'selected':''}>${b.name || b.id}</option>`).join('')}
      </select>
      <div style="font-size:12px;color:var(--gray-500);margin-top:10px">
        💡 Click any plot row to view full plot details
      </div>
    </div>
    ${activeBlock ? `<div style="padding:8px 12px;background:var(--blue-100);border-radius:var(--radius-sm);margin-bottom:14px;font-size:12px;color:var(--blue-500);font-weight:600">Showing plots in <strong>${activeBlock.name || activeBlock.id}</strong></div>` : ''}
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Plot Name</th><th>Block</th><th>Estate</th><th>Area</th>
          <th>Variety</th><th>Ratoon</th><th>Stage</th><th>Health</th>
          <th>Planted</th><th>Est. Harvest</th><th>Actions</th></tr>
        </thead>
        <tbody id="plots-tbody">
          ${filtered.map(p=>`
            <tr class="plt-row" style="cursor:pointer" onclick="viewPlotDetail('${p.id}')">
              <td><strong style="color:var(--green-700)">${p.parcelName || p.id}</strong><br><span style="font-size:11px;color:var(--gray-500)">${p.id}</span></td>
              <td>${p.blockName || p.block}</td>
              <td>${p.estate}</td>
              <td>${fmtHa(p.areaHa)}</td>
              <td>${p.variety || '—'}</td>
              <td>${p.ratoon===0?'Plant Crop':'Ratoon '+p.ratoon}</td>
              <td>${stagePill(p.stage)}</td>
              <td>${healthPill(p.health)}</td>
              <td>${p.planted||'—'}</td>
              <td>${p.expectedHarvest||'—'}</td>
              <td onclick="event.stopPropagation()">
                <div style="display:flex;gap:4px;align-items:center">
                  <button class="icon-btn primary" onclick="logActivityForPlot('${p.id}')" title="Log Activity" aria-label="Log Activity"><i class="fas fa-person-digging" aria-hidden="true"></i></button>
                  <button class="icon-btn" onclick="showEditPlotModal('${p.id}')" title="Edit">✎</button>
                  <button class="icon-btn danger" onclick="confirmDeletePlot('${p.id}')" title="Delete">🗑</button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  // ── PLOT DETAIL VIEW ──
  function buildPlotDetail(plotId) {
    const p = DATA.plots.find(x=>x.id===plotId) || DATA.plots[0];
    if (!p) return '<p>Plot not found.</p>';

    const soil = p.soilTest; // real vsl_parcel_soil_tests row (latest), or null if none logged yet

    const attrs = [
      ['Plot ID',             p.id],
      ['Plot Name',           p.parcelName || p.id],
      ['Current Activity',    p.currentActivity || '—'],
      ['Block',               p.blockName || p.block],
      ['Estate',               p.estate],
      ['Area (ac)',           fmtHa(p.areaHa)],
      ['Geometry Status',     p.geometryStatus ? titleCaseLocal(p.geometryStatus) : '—'],
      ['Cultivation Status',  p.cultivationStatus ? titleCaseLocal(p.cultivationStatus) : '—'],
      ['Cane Variety',        p.variety || '— (no season record yet)'],
      ['Ratoon Number',       p.ratoon===0 ? 'Plant Crop (0)' : 'Ratoon ' + p.ratoon],
      ['Planting Date',       p.planted || '—'],
      ['Expected Harvest',    p.expectedHarvest || '—'],
      ['Growth Stage',        p.stage],
      ['Health Status',       p.health.charAt(0).toUpperCase()+p.health.slice(1)],
      ['Actual Harvest (t)',  p.yield ? p.yield + ' t' : 'Pending harvest'],
      ['Yield per Ac',        p.yield ? (p.yield/(p.areaHa*2.47105)).toFixed(2) + ' t/ac' : '—'],
      ['Last Harvest Date',   p.lastHarvestDate || '—'],
      ['Irrigation Type (from Block)', p.blockIrrigationType || '—'],
      ['Soil Test — pH',            soil ? (soil.soilPh ?? '—') : 'No soil test recorded yet'],
      ['Soil Test — Texture',       soil ? (soil.texture || '—') : 'No soil test recorded yet'],
      ['Soil Test — N / P / K',     soil ? `${soil.nitrogen ?? '—'} / ${soil.phosphorus ?? '—'} / ${soil.potassium ?? '—'}` : 'No soil test recorded yet'],
      ['Soil Test — Organic Matter %', soil ? (soil.organicMatterPct ?? '—') : 'No soil test recorded yet'],
      ['Soil Test Date',            soil ? (soil.sampleDate || '—') : '—'],
      ['Soil Type (from Block)',    p.blockSoilType || '—'],
      ['Soil pH (from Block)',      p.blockSoilPh ?? '—'],
      ['Cultivation Notes',   p.cultivationNotes || '—'],
      ['Date Created',        p.createdAt ? p.createdAt.replace('T',' ').slice(0,16) : '—'],
      ['Last Updated',        p.updatedAt ? p.updatedAt.replace('T',' ').slice(0,16) : '—'],
      ['Record ID (UUID)',    p._uuid || '—'],
    ];

    const backLabel = viewingBlockId ? '← Back to Block' : viewingEstateId ? '← Back to Estate' : '← Back to Plots';

    return `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-outline btn-sm btn-back-accent" onclick="clearPlotDetail()">${backLabel}</button>
      <div style="font-size:13px;color:var(--gray-500)">Full Plot Record — <strong>${p.parcelName || p.id}</strong></div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" onclick="logActivityForPlot('${p.id}')"><i class="fas fa-person-digging" aria-hidden="true"></i> Log Activity</button>
        <button class="btn btn-outline btn-sm" onclick="showEditPlotModal('${p.id}')">✏ Edit Plot</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeletePlot('${p.id}')">🗑 Delete Plot</button>
      </div>
    </div>
    <div class="grid-4" style="margin-bottom:20px">
      <div class="stat-card green"><div class="stat-label">Area</div><div class="stat-value" style="font-size:20px">${fmtHa(p.areaHa)}</div></div>
      <div class="stat-card blue"><div class="stat-label">Growth Stage</div><div class="stat-value" style="font-size:16px">${p.stage}</div></div>
      <div class="stat-card amber"><div class="stat-label">Variety</div><div class="stat-value" style="font-size:16px">${p.variety || '—'}</div></div>
      <div class="stat-card ${p.health==='good'?'green':p.health==='watch'?'amber':'red'}">
        <div class="stat-label">Health</div>
        <div class="stat-value" style="font-size:16px">${p.health.charAt(0).toUpperCase()+p.health.slice(1)}</div>
      </div>
    </div>
    ${locationCardHTML(`qr-plot-${p._uuid}`, p.mapsLink)}
    <div class="card">
      <div class="card-header"><div class="card-title">All Plot Attributes</div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:40%">Attribute</th><th>Value</th></tr></thead>
          <tbody>
            ${attrs.map(([attr,val],i)=>`
              <tr style="background:${i%2===0?'var(--gray-50)':'var(--white)'}">
                <td style="font-weight:600;color:var(--gray-700);font-size:12px">${attr}</td>
                <td style="color:var(--gray-900);font-size:13px">${val}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    ${plotActivityHistoryHTML(p)}`;
  }

  // Activities logged against this plot, newest first.
  function plotActivityHistoryHTML(p) {
    const rows = DATA.activities
      .filter(a => a._parcelId === p._uuid)
      .sort((a,b) => (new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0)));
    return `
    <div class="card" style="margin-top:16px">
      <div class="card-header">
        <div class="card-title">Activity History (${rows.length})</div>
        <button class="btn btn-outline btn-sm" onclick="logActivityForPlot('${p.id}')">+ Log Activity</button>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Date</th><th>Activity</th><th>Logged By</th><th>Team</th><th>Completion</th></tr></thead>
          <tbody>
            ${rows.length ? rows.map(a => `
              <tr>
                <td>${a.date || '—'}</td>
                <td><strong>${a.name}</strong></td>
                <td>${a.createdByName || '—'}</td>
                <td>${a.teamSize ?? '—'}</td>
                <td>${a.completionValue != null ? a.completionValue + '%' : '—'}</td>
              </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;color:var(--gray-500);padding:20px">No activities logged for this plot yet</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  // ── ESTATE DETAIL VIEW ──
  function buildEstateDetail(estateId) {
    const e = DATA.estates.find(x=>x.id===estateId);
    if (!e) return '<p>Estate not found.</p>';

    const blocksInEstate = DATA.blocks.filter(b=>b.estate===e.name);

    const attrs = [
      ['Estate Name',       e.name],
      ['Estate ID',         e.id],
      ['District',          e.district || '—'],
      ['Address',           e.location || '—'],
      ['Assigned Manager',  managerCellHTML('estate', e._id, e.name, e.managerId, e.assignedManagerName, e.assignedManagerAvatarUrl, true)],
      ['Owner Name',        e.manager || '—'],
      ['Owner Phone',       e.managerPhone || '—'],
      ['Total Blocks',      e.blocks],
      ['Total Plots',       e.plots],
      ['Total Area',        fmtHa(e.areaHa)],
      ['Planted Area',      fmtHa(e.plantedHa)],
      ['Fallow Area',       fmtHa(e.areaHa - e.plantedHa)],
      ['Utilisation',       pct(e.plantedHa, e.areaHa) + '%'],
      ['Health Status',     e.health ? e.health.charAt(0).toUpperCase()+e.health.slice(1) : '—'],
      ['Date Created',      e.createdAt ? e.createdAt.replace('T',' ').slice(0,16) : '—'],
    ];

    return `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-outline btn-sm btn-back-accent" onclick="clearEstateDetail()">← Back to Estates</button>
      <div style="font-size:13px;color:var(--gray-500)">Full Estate Record — <strong>${e.name}</strong></div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-outline btn-sm" onclick="showEditEstateModal('${e.id}')">✏ Edit Estate</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteEstate('${e.id}','${e.name}')">🗑 Delete Estate</button>
      </div>
    </div>
    <div class="grid-4" style="margin-bottom:20px">
      <div class="stat-card green"><div class="stat-label">Total Area</div><div class="stat-value" style="font-size:20px">${fmtHa(e.areaHa)}</div></div>
      <div class="stat-card blue"><div class="stat-label">Blocks</div><div class="stat-value" style="font-size:20px">${e.blocks}</div></div>
      <div class="stat-card amber"><div class="stat-label">Plots</div><div class="stat-value" style="font-size:20px">${e.plots}</div></div>
      <div class="stat-card ${e.health==='good'?'green':e.health==='watch'?'amber':'red'}">
        <div class="stat-label">Health</div>
        <div class="stat-value" style="font-size:16px">${e.health ? e.health.charAt(0).toUpperCase()+e.health.slice(1) : '—'}</div>
      </div>
    </div>
    ${locationCardHTML(`qr-estate-${e.id}`, e.mapsLink)}
    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><div class="card-title">Estate Attributes</div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:40%">Attribute</th><th>Value</th></tr></thead>
          <tbody>
            ${attrs.map(([attr,val],i)=>`
              <tr style="background:${i%2===0?'var(--gray-50)':'var(--white)'}">
                <td style="font-weight:600;color:var(--gray-700);font-size:12px">${attr}</td>
                <td style="color:var(--gray-900);font-size:13px">${val}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Blocks in this Estate</div>
        <div style="font-size:11px;color:var(--gray-500)">${blocksInEstate.length} block(s)</div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Block Name</th><th>Plots</th><th>Total Area</th><th>Planted</th><th>Utilisation</th><th>Status</th></tr></thead>
          <tbody>
            ${blocksInEstate.length ? blocksInEstate.map(b=>`
              <tr style="cursor:pointer" onclick="viewBlockDetail('${b.id}')">
                <td><strong>${b.name || b.id}</strong><br><span style="font-size:11px;color:var(--gray-500)">${b.id}</span></td>
                <td>${b.plots}</td>
                <td>${fmtHa(b.areaHa)}</td>
                <td>${fmtHa(b.plantedHa)}</td>
                <td>${pct(b.plantedHa,b.areaHa)}%</td>
                <td>${healthPill(b.status)}</td>
              </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--gray-500);padding:24px">No blocks yet</td></tr>`}
          </tbody>
        </table>
      </div>
      <div style="font-size:12px;color:var(--gray-500);margin-top:10px">
        💡 Click any block row to view full block details
      </div>
    </div>`;
  }

  // ── BLOCK DETAIL VIEW ──
  function buildBlockDetail(blockId) {
    const b = DATA.blocks.find(x=>x.id===blockId);
    if (!b) return '<p>Block not found.</p>';

    const plotsInBlock = DATA.plots.filter(p=>p.block===blockId);

    const attrs = [
      ['Block Name',         b.name || b.id],
      ['Block Code',         b.id],
      ['Estate',             b.estate],
      ['Total Plots',        b.plots],
      ['Total Area',         fmtHa(b.areaHa)],
      ['Planted Area',       fmtHa(b.plantedHa)],
      ['Fallow Area',        fmtHa(b.areaHa - b.plantedHa)],
      ['Utilisation',        pct(b.plantedHa, b.areaHa) + '%'],
      ['Avg Yield',          b.avgYield + ' t/ac'],
      ['Assigned Manager',   managerCellHTML('block', b._uuid, b.name || b.id, b.managerId, b.assignedManagerName, b.assignedManagerAvatarUrl, true)],
      ['Soil Type',          b.soilType || '—'],
      ['Soil pH',            b.soilPh || '—'],
      ['Irrigation Type',    b.irrigationType || '—'],
      ['Ownership',          b.ownership || '—'],
      ['Geometry Status',    b.geometryStatus ? titleCaseLocal(b.geometryStatus) : '—'],
      ['Last Harvest Date',  b.lastHarvestDate || '—'],
      ['Harvest Tonnes',     b.harvestTonnes ? b.harvestTonnes + ' t' : '—'],
      ['Date Created',       b.createdAt ? b.createdAt.replace('T',' ').slice(0,16) : '—'],
      ['Last Updated',       b.updatedAt ? b.updatedAt.replace('T',' ').slice(0,16) : '—'],
      ['Record ID (UUID)',   b._uuid || '—'],
    ];

    const blockBackLabel = viewingEstateId ? '← Back to Estate' : '← Back to Blocks';

    return `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-outline btn-sm btn-back-accent" onclick="clearBlockDetail()">${blockBackLabel}</button>
      <div style="font-size:13px;color:var(--gray-500)">Full Block Record — <strong>${b.name || b.id}</strong></div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-outline btn-sm" onclick="showEditBlockModal('${b.id}')">✏ Edit Block</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteBlock('${b.id}')">🗑 Delete Block</button>
      </div>
    </div>
    <div class="grid-4" style="margin-bottom:20px">
      <div class="stat-card green"><div class="stat-label">Total Area</div><div class="stat-value" style="font-size:20px">${fmtHa(b.areaHa)}</div></div>
      <div class="stat-card blue"><div class="stat-label">Plots</div><div class="stat-value" style="font-size:20px">${b.plots}</div></div>
      <div class="stat-card amber"><div class="stat-label">Avg Yield</div><div class="stat-value" style="font-size:16px">${b.avgYield} t/ac</div></div>
      <div class="stat-card ${b.status==='active'?'green':b.status==='watch'?'amber':'red'}">
        <div class="stat-label">Status</div>
        <div class="stat-value" style="font-size:16px">${healthPill(b.status)}</div>
      </div>
    </div>
    ${locationCardHTML(`qr-block-${b._uuid}`, b.mapsLink)}
    <div class="card" style="margin-bottom:20px">
      <div class="card-header"><div class="card-title">Block Attributes</div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:40%">Attribute</th><th>Value</th></tr></thead>
          <tbody>
            ${attrs.map(([attr,val],i)=>`
              <tr style="background:${i%2===0?'var(--gray-50)':'var(--white)'}">
                <td style="font-weight:600;color:var(--gray-700);font-size:12px">${attr}</td>
                <td style="color:var(--gray-900);font-size:13px">${val}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Plots in this Block</div>
        <div style="font-size:11px;color:var(--gray-500)">${plotsInBlock.length} plot(s)</div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Plot Name</th><th>Area</th><th>Variety</th><th>Stage</th><th>Health</th></tr></thead>
          <tbody>
            ${plotsInBlock.length ? plotsInBlock.map(p=>`
              <tr style="cursor:pointer" onclick="viewPlotDetail('${p.id}')">
                <td><strong style="color:var(--green-700)">${p.parcelName || p.id}</strong><br><span style="font-size:11px;color:var(--gray-500)">${p.id}</span></td>
                <td>${fmtHa(p.areaHa)}</td>
                <td>${p.variety || '—'}</td>
                <td>${stagePill(p.stage)}</td>
                <td>${healthPill(p.health)}</td>
              </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;color:var(--gray-500);padding:24px">No plots yet</td></tr>`}
          </tbody>
        </table>
      </div>
      <div style="font-size:12px;color:var(--gray-500);margin-top:10px">
        💡 Click any plot row to view full plot details
      </div>
    </div>`;
  }

  // ── RENDER CONTAINER ──
  function renderTabContent() {
    const container = document.getElementById('estates-tab-content');
    if (!container) return;
    container.innerHTML =
      viewingPlotId   ? buildPlotDetail(viewingPlotId) :
      viewingBlockId  ? buildBlockDetail(viewingBlockId) :
      viewingEstateId ? buildEstateDetail(viewingEstateId) :
      activeTab==='estates' ? buildEstatesTab() :
      activeTab==='blocks'  ? buildBlocksTab() :
      buildPlotsTab(selectedBlock);
    rebindHelpers();
  }

  // ── RENDER FULL PAGE ──
  el.innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-header-title">Land Management</div>
      <div class="page-header-sub">${DATA.stats.totalEstates} estates · ${DATA.stats.totalBlocks} blocks · ${DATA.stats.totalPlots} plots</div>
    </div>
  </div>
  <div class="tab-bar" id="estates-tabs">
    <button class="tab-btn active" data-tab="estates" onclick="switchEBPTab('estates',this)">Estates (${DATA.stats.totalEstates})</button>
    <button class="tab-btn" data-tab="blocks" onclick="switchEBPTab('blocks',this)">Blocks (${DATA.stats.totalBlocks})</button>
    <button class="tab-btn" data-tab="plots" onclick="switchEBPTab('plots',this)">Plots (${DATA.stats.totalPlots})</button>
  </div>
  <div class="card" id="estates-tab-content">
    ${buildEstatesTab()}
  </div>`;

  // ── HELPERS bound to window ──
  function rebindHelpers() {
    window.filterBlockRows = function(val) {
      document.querySelectorAll('#blocks-tbody tr').forEach(r=>{
        r.style.display = r.textContent.toLowerCase().includes(val.toLowerCase()) ? '' : 'none';
      });
    };
    window.filterPlotRows = function(val) {
      document.querySelectorAll('#plots-tbody tr').forEach(r=>{
        r.style.display = r.textContent.toLowerCase().includes(val.toLowerCase()) ? '' : 'none';
      });
    };
    window.applyPlotBlockFilter = function(val) {
      selectedBlock = val || null;
      renderTabContent();
    };
    window.viewPlotDetail = function(plotId) {
      viewingPlotId = plotId;
      renderTabContent();
    };
    window.clearPlotDetail = function() {
      viewingPlotId = null;
      renderTabContent();
    };
    window.viewEstateDetail = function(estateId) {
      viewingEstateId = estateId;
      viewingBlockId = null;
      viewingPlotId = null;
      renderTabContent();
    };
    window.clearEstateDetail = function() {
      viewingEstateId = null;
      viewingBlockId = null;
      renderTabContent();
    };
    window.viewBlockDetail = function(blockId) {
      viewingBlockId = blockId;
      viewingPlotId = null;
      renderTabContent();
    };
    window.clearBlockDetail = function() {
      viewingBlockId = null;
      renderTabContent();
    };
  }

  rebindHelpers();

  // Log Activity for one plot — opens the shared Add Activity window with the
  // Estate/Block/Plot fixed to that plot, then refreshes this view in place.
  window.logActivityForPlot = function(plotId) {
    showAddActivityModal({ plotId, onSaved: renderTabContent });
  };

  window.switchEBPTab = function(tab, btn) {
    activeTab = tab;
    viewingPlotId = null;
    viewingBlockId = null;
    viewingEstateId = null;
    if (tab !== 'plots') selectedBlock = null;
    document.querySelectorAll('#estates-tabs .tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    renderTabContent();
  };

  window.applyEstFilter = function(val) {
    selectedEstate = val;
    // Reset the block filter if the previously-selected block doesn't belong to the newly chosen estate
    if (selectedBlock) {
      const blk = DATA.blocks.find(b => b.id === selectedBlock);
      if (!blk || (val && blk.estate !== val)) selectedBlock = null;
    }
    renderTabContent();
  };

  // ── ESTATE MODALS ──
  window.showAddEstateModal = function() {
    showModal(`
      <div class="modal-title">Add New Estate</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Estate Name</label><input class="form-input" id="ae-name" placeholder="e.g. Buyala"></div>
        <div class="form-group"><label class="form-label">Owner Name</label><input class="form-input" id="ae-manager" placeholder="e.g. Musa Kaalo"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Contact Phone</label><input class="form-input" id="ae-phone" placeholder="07XXXXXXXX"></div>
        <div class="form-group"><label class="form-label">Address</label><input class="form-input" id="ae-location" placeholder="e.g. Kalere, Wakiso"></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddEstate()">Save Estate</button>
      </div>`);
  };

  window.submitAddEstate = async function() {
    const name = document.getElementById('ae-name').value.trim();
    const manager = document.getElementById('ae-manager').value.trim();
    const phone = document.getElementById('ae-phone').value.trim();
    const location = document.getElementById('ae-location').value.trim();
    if (!name) { showToast('Estate name is required','red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_estate').insert([{
        estate_name: name, owner_name: manager || null, owner_contact_phone: phone || null, address: location || null,
      }]);
      if (error) throw error;
      closeModal();
      showToast('Estate added successfully');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to add estate: ' + err.message, 'red');
    }
  };

  window.showEditEstateModal = function(id) {
    const e = DATA.estates.find(x=>x.id===id);
    if (!e) return;
    showModal(`
      <div class="modal-title">Edit Estate — ${e.name}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Estate Name</label><input class="form-input" id="ee-name" value="${e.name}"></div>
        <div class="form-group"><label class="form-label">Owner Name</label><input class="form-input" id="ee-manager" value="${e.manager||''}"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Contact Phone</label><input class="form-input" id="ee-phone" value="${e.managerPhone||''}"></div>
        <div class="form-group"><label class="form-label">Address</label><input class="form-input" id="ee-location" value="${e.location||''}"></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitEditEstate('${e._id}')">Save Changes</button>
      </div>`);
  };

  window.submitEditEstate = async function(estateDbId) {
    const name = document.getElementById('ee-name').value.trim();
    const manager = document.getElementById('ee-manager').value.trim();
    const phone = document.getElementById('ee-phone').value.trim();
    const location = document.getElementById('ee-location').value.trim();
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_estate').update({
        estate_name: name, owner_name: manager || null, owner_contact_phone: phone || null, address: location || null,
      }).eq('id', estateDbId);
      if (error) throw error;
      closeModal();
      showToast('Estate updated successfully');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to update estate: ' + err.message, 'red');
    }
  };

  // ── CASCADE DELETE (Estate → Blocks → Plots) ──
  // The database enforces the hierarchy (sql/021_vsl_strict_land_hierarchy.sql):
  // deleting an estate deletes its blocks, deleting a block deletes its plots,
  // and everything recorded against them goes too, in one atomic delete.
  // These helpers only work out what will be removed so the window can show it.
  function deleteImpactFor(level, rec) {
    let blocks = [], plots = [];
    if (level === 'estate') {
      blocks = DATA.blocks.filter(b => b.estate === rec.name);
      const blockUuids = new Set(blocks.map(b => b._uuid));
      plots = DATA.plots.filter(p => blockUuids.has(p._blockUuid));
    } else {
      plots = DATA.plots.filter(p => p._blockUuid === rec._uuid);
    }
    const blockUuids = new Set(blocks.map(b => b._uuid));
    if (level === 'block') blockUuids.add(rec._uuid);
    const plotUuids = new Set(plots.map(p => p._uuid));
    const activities = DATA.activities.filter(a =>
      plotUuids.has(a._parcelId) || blockUuids.has(a._blockId) ||
      (level === 'estate' && a._estateId != null && String(a._estateId) === String(rec._id)));
    const seasons = (DATA.seasons || []).filter(x => plotUuids.has(x.parcelId));
    const alerts  = (DATA.alerts  || []).filter(x => x.targetId && plotUuids.has(x.targetId));
    return { blocks: blocks.length, plots: plots.length, activities: activities.length, seasons: seasons.length, alerts: alerts.length };
  }

  function deleteImpactHTML(level, impact) {
    const items = [];
    if (level === 'estate') items.push(['Blocks', impact.blocks]);
    items.push(['Plots', impact.plots], ['Activities', impact.activities], ['Seasons', impact.seasons], ['Alerts', impact.alerts]);
    return `<div class="delete-impact">${items.map(([label, n]) => `
      <div class="delete-impact__item"><div class="delete-impact__num">${n}</div><div class="delete-impact__label">${label}</div></div>`).join('')}
    </div>`;
  }

  function escapeAttr(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])); }

  // Shared confirm window. Because this removes a whole branch of the land
  // hierarchy, the user types the record's name to unlock the Delete button
  // whenever anything sits underneath it.
  function showCascadeDeleteModal({ level, label, impact, onConfirm }) {
    const levelWord = level === 'estate' ? 'Estate' : 'Block';
    const hasChildren = impact.blocks + impact.plots + impact.activities + impact.seasons + impact.alerts > 0;
    const childText = level === 'estate'
      ? 'every block in this estate, every plot in those blocks, and all records logged against them'
      : 'every plot in this block and all records logged against them';
    showModal(`
      <div class="modal-title">Delete ${levelWord}</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:12px">
        You are about to permanently delete <strong>${label}</strong>${hasChildren ? `, together with ${childText}` : ''}.
      </p>
      ${hasChildren ? deleteImpactHTML(level, impact) : ''}
      <div class="modal-note danger"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>
        <span>No block or plot can exist without its parent, so nothing underneath is kept. This cannot be undone.</span></div>
      ${hasChildren ? `
      <div class="form-group" style="margin-bottom:4px">
        <label class="form-label" for="cd-confirm">Type <strong>${label}</strong> to confirm</label>
        <input class="form-input" id="cd-confirm" autocomplete="off" data-expected="${escapeAttr(label)}">
      </div>` : ''}
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" id="cd-submit" ${hasChildren ? 'disabled' : ''}>Delete ${levelWord}${hasChildren ? ' and Everything In It' : ''}</button>
      </div>`);
    const input = document.getElementById('cd-confirm');
    const btn = document.getElementById('cd-submit');
    if (input) {
      const sync = () => {
        btn.disabled = input.value.trim().toLowerCase() !== input.dataset.expected.trim().toLowerCase();
      };
      input.addEventListener('input', sync);
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && !btn.disabled) btn.click(); });
      setTimeout(() => input.focus(), 0);
    }
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Deleting…';
      await onConfirm();
    });
  }

  // Foreign key (23503) = the database still has the old "no action" rules,
  // i.e. sql/021_vsl_strict_land_hierarchy.sql hasn't been run yet.
  function cascadeDeleteErrorText(err) {
    if (err && err.code === '23503') return 'records underneath are blocking the delete — run the database update sql/021_vsl_strict_land_hierarchy.sql';
    return err && err.message ? err.message : 'unknown error';
  }

  window.confirmDeleteEstate = function(id, name) {
    const e = DATA.estates.find(x=>x.id===id);
    if (!e) return;
    showCascadeDeleteModal({
      level: 'estate',
      label: e.name || name,
      impact: deleteImpactFor('estate', e),
      onConfirm: () => submitDeleteEstate(e._id),
    });
  };

  window.submitDeleteEstate = async function(estateDbId) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_estate').delete().eq('id', estateDbId);
      if (error) throw error;
      closeModal();
      showToast('Estate and everything in it deleted', 'red');
      viewingEstateId = null; viewingBlockId = null; viewingPlotId = null; selectedBlock = null; selectedEstate = '';
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      closeModal();
      showToast('Failed to delete estate: ' + cascadeDeleteErrorText(err), 'red');
    }
  };

  // ── MANAGER LINKING ──
  // Estate / Block / Plot: one manager each, stored as a direct FK
  // (vsl_estate.manager_id / vsl_blocks.manager_id / vsl_parcels.manager_id
  // → vsl_profiles). Plots don't have a manager concept — only estate/block do.
  const MANAGER_TABLE_BY_SCOPE = { estate: 'vsl_estate', block: 'vsl_blocks' };
  const MANAGER_MODAL_TITLE_BY_SCOPE = { estate: 'Assign Estate Manager', block: 'Assign Block Manager' };

  window.showLinkManagerModal = function(scopeType, scopeId, scopeLabel) {
    showModal(`
      <div class="modal-title">${MANAGER_MODAL_TITLE_BY_SCOPE[scopeType] || 'Assign Manager'} — ${scopeLabel}</div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">User</label>
        <select class="form-input" id="lm-user">
          ${DATA.users.map(u=>`<option value="${u.id}">${u.name} (${u.email})</option>`).join('')}
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAssignManager('${scopeType}','${scopeId}')">Assign Manager</button>
      </div>`);
  };

  // Estate/Block/Plot: assign (set manager_id), remove (clear manager_id), and
  // view details of the currently-assigned manager.
  window.submitAssignManager = async function(scopeType, scopeId) {
    const userId = document.getElementById('lm-user').value;
    if (!userId) { showToast('Select a user', 'red'); return; }
    try {
      const client = getSbClient();
      const table = MANAGER_TABLE_BY_SCOPE[scopeType];
      // .select() so we get the updated row(s) back — an RLS policy blocking
      // the write doesn't error, it just matches 0 rows, so without this
      // check a blocked update would silently report "success".
      const { data, error } = await client.from(table).update({ manager_id: userId }).eq('id', scopeId).select();
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error('No record was updated — you may not be signed in, or your account lacks permission to edit this record.');
      }
      closeModal();
      showToast('Manager assigned successfully');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to assign manager: ' + err.message, 'red');
    }
  };

  window.confirmUnassignManager = function(scopeType, scopeId, managerName) {
    showModal(`
      <div class="modal-title">Remove Manager</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">Remove <strong>${managerName}</strong> as the assigned manager for this ${scopeType}?</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="submitUnassignManager('${scopeType}','${scopeId}')">Yes, Remove</button>
      </div>`);
  };

  window.submitUnassignManager = async function(scopeType, scopeId) {
    try {
      const client = getSbClient();
      const table = MANAGER_TABLE_BY_SCOPE[scopeType];
      const { data, error } = await client.from(table).update({ manager_id: null }).eq('id', scopeId).select();
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error('No record was updated — you may not be signed in, or your account lacks permission to edit this record.');
      }
      closeModal();
      showToast('Manager removed', 'red');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to remove manager: ' + err.message, 'red');
    }
  };

  window.viewManagerDetail = function(scopeType, scopeId) {
    const scope = scopeType === 'estate'
      ? DATA.estates.find(x => String(x._id) === String(scopeId))
      : DATA.blocks.find(x => x._uuid === scopeId);
    if (!scope || !scope.managerId) return;
    const prof = DATA.users.find(u => String(u.id) === String(scope.managerId));
    const name = prof ? prof.name : (scope.assignedManagerName || 'Unknown user');
    const avatarUrl = prof ? prof.avatarUrl : scope.assignedManagerAvatarUrl;
    showModal(`
      <div class="modal-title" style="display:flex;align-items:center;gap:10px">${avatarHTML(name, avatarUrl, 40, 'square')}<span>Manager — ${name}</span></div>
      <div class="table-wrap" style="margin-bottom:16px">
        <table><tbody>
          <tr><td style="font-weight:600;width:35%">Name</td><td>${name}</td></tr>
          <tr><td style="font-weight:600">Email</td><td>${prof?.email || scope.assignedManagerEmail || '—'}</td></tr>
          <tr><td style="font-weight:600">Phone</td><td>${prof?.phone || scope.assignedManagerPhone || '—'}</td></tr>
          <tr><td style="font-weight:600">Title</td><td>${prof?.title || scope.assignedManagerTitle || '—'}</td></tr>
          <tr><td style="font-weight:600">Role</td><td>${prof?.role || '—'}</td></tr>
        </tbody></table>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal();confirmUnassignManager('${scopeType}','${scopeId}','${(name||'').replace(/'/g,"")}')">Remove Manager</button>
        <button class="btn btn-primary" onclick="closeModal();showLinkManagerModal('${scopeType}','${scopeId}','${(name||'').replace(/'/g,"")}')">Change Manager</button>
      </div>`);
  };

  // ── BLOCK MODALS ──
  window.showAddBlockModal = function() {
    showModal(`
      <div class="modal-title">Add New Block</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Block Code</label><input class="form-input" id="ab-code" placeholder="e.g. BLOCK21"></div>
        <div class="form-group"><label class="form-label">Estate *</label>
          <select class="form-input" id="ab-estate"><option value="">— Select estate —</option>${DATA.estates.map(e=>`<option value="${e._id}">${e.name}</option>`).join('')}</select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Expected Area (acres)</label><input class="form-input" id="ab-area" type="number" placeholder="0.00"></div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddBlock()">Save Block</button>
      </div>`);
  };

  window.submitAddBlock = async function() {
    const code = document.getElementById('ab-code').value.trim();
    const estateId = document.getElementById('ab-estate').value;
    const area = document.getElementById('ab-area').value;
    if (!code) { showToast('Block code is required','red'); return; }
    if (!estateId) { showToast('Every block must belong to an estate — pick one','red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_blocks').insert([{
        block_code: code, block_name: code, estate_id: estateId || null,
        area_acres: area || null,
      }]);
      if (error) throw error;
      closeModal();
      showToast('Block added successfully');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to add block: ' + err.message, 'red');
    }
  };

  window.showEditBlockModal = function(id) {
    const b = DATA.blocks.find(x=>x.id===id);
    if (!b) return;
    showModal(`
      <div class="modal-title">Edit Block — ${b.name || b.id}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Block Code</label><input class="form-input" id="eb-code" value="${b.id}"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Expected Area (acres)</label>
        <input class="form-input" id="eb-area" type="number" value="${b.areaHa ? (b.areaHa/0.404686).toFixed(3) : ''}"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitEditBlock('${b._uuid}')">Save Changes</button>
      </div>`);
  };

  window.submitEditBlock = async function(blockDbId) {
    const code = document.getElementById('eb-code').value.trim();
    const area = document.getElementById('eb-area').value;
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_blocks').update({
        block_code: code, block_name: code, area_acres: area || null,
      }).eq('id', blockDbId);
      if (error) throw error;
      closeModal();
      showToast('Block updated successfully');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to update block: ' + err.message, 'red');
    }
  };

  window.confirmDeleteBlock = function(id) {
    const b = DATA.blocks.find(x=>x.id===id);
    if (!b) return;
    showCascadeDeleteModal({
      level: 'block',
      label: b.name || b.id,
      impact: deleteImpactFor('block', b),
      onConfirm: () => submitDeleteBlock(b._uuid),
    });
  };

  window.submitDeleteBlock = async function(blockDbId) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_blocks').delete().eq('id', blockDbId);
      if (error) throw error;
      closeModal();
      showToast('Block and its plots deleted', 'red');
      const wasViewing = DATA.blocks.find(x => x._uuid === blockDbId);
      if (wasViewing && (viewingBlockId === wasViewing.id || selectedBlock === wasViewing.id)) {
        viewingBlockId = null; selectedBlock = null;
      }
      viewingPlotId = null;
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      closeModal();
      showToast('Failed to delete block: ' + cascadeDeleteErrorText(err), 'red');
    }
  };

  // ── PLOT (PARCEL) MODALS ──
  window.showAddPlotModal = function() {
    showModal(`
      <div class="modal-title">Add New Plot</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Plot Code</label><input class="form-input" id="ap-code" placeholder="e.g. P-25"></div>
        <div class="form-group"><label class="form-label">Block *</label>
          <select class="form-input" id="ap-block"><option value="">— Select block —</option>${DATA.blocks.map(b=>`<option value="${b._uuid}">${b.name || b.id} (${b.estate})</option>`).join('')}</select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Expected Area (acres)</label><input class="form-input" id="ap-area" type="number" placeholder="0.00"></div>
        <div class="form-group"><label class="form-label">Ratoon Number</label><input class="form-input" id="ap-ratoon" type="number" value="0"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Planting Date</label><input class="form-input" id="ap-planted" type="date"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddPlot()">Save Plot</button>
      </div>`);
  };

  window.submitAddPlot = async function() {
    const code = document.getElementById('ap-code').value.trim();
    const blockId = document.getElementById('ap-block').value;
    const area = document.getElementById('ap-area').value;
    const ratoon = document.getElementById('ap-ratoon').value;
    const planted = document.getElementById('ap-planted').value;
    if (!code) { showToast('Plot code is required','red'); return; }
    if (!blockId) { showToast('Every plot must belong to a block — pick one','red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_parcels').insert([{
        block_id: blockId, parcel_code: code, parcel_name: code,
        area_acres: area || null, ratoon_number: ratoon || 0,
        planting_date: planted || null,
        cultivation_status: 'vacant',
      }]);
      if (error) throw error;
      closeModal();
      showToast('Plot added successfully');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to add plot: ' + err.message, 'red');
    }
  };

  // Every editable vsl_parcels column is exposed here except: id (plot ID),
  // parcel_code, geom, created_by/updated_by, created_at/updated_at,
  // geometry_status, and area_acres (all excluded per request) —
  // plus current_activity_id/current_activity_name and current_season_id,
  // which are trigger-maintained cache pointers (vsl_sync_parcel_current_activity /
  // vsl_sync_parcel_season), and cultivation_updated_at/by, which are
  // auto-stamped alongside cultivation_status — none of those are meant to
  // be hand-edited.
  window.showEditPlotModal = function(id) {
    const p = DATA.plots.find(x=>x.id===id);
    if (!p) return;
    showModal(`
      <div class="modal-title">Edit Plot — ${p.parcelName || p.id}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Plot Name</label><input class="form-input" id="ep-name" value="${p.parcelName||''}"></div>
        <div class="form-group"><label class="form-label">Estate</label>
          <select class="form-input" id="ep-estate" onchange="onEditPlotEstateChange(this.value)">
            ${DATA.estates.map(e=>`<option value="${e.name}" ${e.name===p.estate?'selected':''}>${e.name}</option>`).join('')}
          </select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Block</label>
          <select class="form-input" id="ep-block">
            ${DATA.blocks.filter(b=>b.estate===p.estate).map(b=>`<option value="${b._uuid}" ${b._uuid===p._blockUuid?'selected':''}>${b.name || b.id}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Cultivation Status</label>
          <select class="form-input" id="ep-status">
            <option value="vacant" ${p.cultivationStatus==='vacant'?'selected':''}>Vacant</option>
            <option value="prepared" ${p.cultivationStatus==='prepared'?'selected':''}>Prepared</option>
            <option value="planted" ${p.cultivationStatus==='planted'?'selected':''}>Planted</option>
            <option value="ratoon" ${p.cultivationStatus==='ratoon'?'selected':''}>Ratoon</option>
            <option value="ratoon" ${p.cultivationStatus==='ratoon'?'selected':''}>Ratoon</option>
            <option value="harvested" ${p.cultivationStatus==='harvested'?'selected':''}>Harvested</option>
          </select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Ratoon Number</label><input class="form-input" id="ep-ratoon" type="number" value="${p.ratoon||0}"></div>
        <div class="form-group"><label class="form-label">Planting Date</label><input class="form-input" id="ep-planted" type="date" value="${p.planted||''}"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Ratoon Start Date</label><input class="form-input" id="ep-ratoon-start" type="date" value="${p.ratoonStartDate||''}"></div>
        <div class="form-group"><label class="form-label">Expected Harvest</label><input class="form-input" id="ep-harvest" type="date" value="${p.expectedHarvest||''}"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Cultivation Notes</label>
        <textarea class="form-input" id="ep-notes" rows="2">${p.cultivationNotes||''}</textarea></div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Harvest Tonnage (if harvested)</label>
        <input class="form-input" id="ep-yield" type="number" value="${p.yield||''}"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitEditPlot('${p._uuid}')">Save Changes</button>
      </div>`);
  };

  // Re-populates the Block select when the Estate select changes, so the
  // block list only ever shows blocks that belong to the chosen estate
  // instead of one long combined "Block (Estate)" list.
  window.onEditPlotEstateChange = function(estateName) {
    const blockSelect = document.getElementById('ep-block');
    if (!blockSelect) return;
    blockSelect.innerHTML = DATA.blocks
      .filter(b => b.estate === estateName)
      .map(b => `<option value="${b._uuid}">${b.name || b.id}</option>`)
      .join('');
  };

  window.submitEditPlot = async function(parcelDbId) {
    const name = document.getElementById('ep-name').value.trim();
    const blockId = document.getElementById('ep-block').value;
    const status = document.getElementById('ep-status').value;
    const ratoon = document.getElementById('ep-ratoon').value;
    const planted = document.getElementById('ep-planted').value;
    const ratoonStart = document.getElementById('ep-ratoon-start').value;
    const harvest = document.getElementById('ep-harvest').value;
    const notes = document.getElementById('ep-notes').value.trim();
    const yieldT = document.getElementById('ep-yield').value;
    if (!blockId) { showToast('Select a block', 'red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_parcels').update({
        parcel_name: name || null,
        block_id: blockId,
        cultivation_status: status, ratoon_number: ratoon || 0,
        planting_date: planted || null, ratoon_start_date: ratoonStart || null,
        expected_harvest_date: harvest || null,
        cultivation_notes: notes || null,
      }).eq('id', parcelDbId);
      if (error) throw error;
      // Harvest tonnage now lives in the vsl_harvests history table, not a flat parcel column
      if (yieldT) {
        const { error: hErr } = await client.from('vsl_harvests').insert([{
          parcel_id: parcelDbId,
          harvest_date: harvest || new Date().toISOString().slice(0, 10),
          gross_weight_tonnes: yieldT,
        }]);
        if (hErr) console.error('Failed to record harvest:', hErr);
      }
      closeModal();
      showToast('Plot updated successfully');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to update plot: ' + err.message, 'red');
    }
  };

  window.confirmDeletePlot = function(id) {
    const p = DATA.plots.find(x=>x.id===id);
    showModal(`
      <div class="modal-title">Delete Plot</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">Delete plot <strong>${p?.parcelName || id}</strong>? This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="submitDeletePlot('${p?._uuid}')">Yes, Delete</button>
      </div>`);
  };

  window.submitDeletePlot = async function(parcelDbId) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_parcels').delete().eq('id', parcelDbId);
      if (error) throw error;
      closeModal();
      showToast('Plot deleted', 'red');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to delete plot: ' + err.message, 'red');
    }
  };
}

// ══════════════════════════════════════
//  PAGE: PRODUCTION
// ══════════════════════════════════════

function renderProduction(el) {
  // Latest harvest first.
  const harvestedParcels = DATA.plots.filter(p => p.yield && parseFloat(p.yield) > 0)
    .sort((a,b) => new Date(b.lastHarvestDate || 0) - new Date(a.lastHarvestDate || 0));
  const totalHarvested = harvestedParcels.reduce((s,p) => s + parseFloat(p.yield), 0);

  // Build per-estate harvest rollup for bar chart
  const estateYields = DATA.estates.map(e => ({
    name: e.name,
    tonnes: harvestedParcels.filter(p => p.estate === e.name).reduce((s, p) => s + parseFloat(p.yield), 0),
  }));

  // Plots due for harvest — computed in supabase-client.js from each estate's
  // configured harvest_period_months, counted from planting_date (plant crop) or
  // ratoon_start_date (ratooned crop). See computeHarvestDue()/isHarvestDue there.
  const allDuePlots = DATA.plots.filter(p => p.isHarvestDue);
  const totalDueExpectedYield = allDuePlots.reduce((s,p) => s + (p.expectedYieldTons || 0), 0);

  // ── Harvests Due filters (estate / block / plot) — closure state, reset on page open ──
  let hdEstFilter = '', hdBlockFilter = '';

  function dueFiltersHTML() {
    const blocksForFilter = DATA.blocks.filter(b => !hdEstFilter || b.estate === hdEstFilter);
    return `
      <input class="form-input" style="max-width:180px" placeholder="Search plot…" id="hd-plot-search" oninput="filterHarvestDuePlotSearch(this.value)">
      <select class="form-input" style="width:150px" id="hd-estate-filter" onchange="filterHarvestDueEstate(this.value)">
        <option value="">All Estates</option>
        ${DATA.estates.map(e=>`<option value="${e.name}" ${hdEstFilter===e.name?'selected':''}>${e.name}</option>`).join('')}
      </select>
      <select class="form-input" style="width:160px" id="hd-block-filter" onchange="filterHarvestDueBlock(this.value)">
        <option value="">All Blocks</option>
        ${blocksForFilter.map(b=>`<option value="${b._uuid}" ${hdBlockFilter===b._uuid?'selected':''}>${b.name || b.id}</option>`).join('')}
      </select>`;
  }

  function dueTableHTML() {
    const rows = DATA.plots.filter(p => p.isHarvestDue
      && (!hdEstFilter || p.estate === hdEstFilter)
      && (!hdBlockFilter || p._blockUuid === hdBlockFilter)
    ).sort((a,b) => (b.monthsPastDue||0) - (a.monthsPastDue||0));
    return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Plot</th><th>Block</th><th>Estate</th><th>Ratoon</th>
        <th>Reference Date</th><th>Due Since</th><th>Area</th><th>Expected Yield</th><th>Actions</th></tr></thead>
        <tbody id="harvest-due-tbody">
          ${rows.length ? rows.map(p=>`
            <tr>
              <td><strong>${p.parcelName || p.id}</strong></td>
              <td>${p.blockName || p.block}</td>
              <td>${p.estate}</td>
              <td>${p.ratoon===0 ? 'Plant Crop' : 'Ratoon ' + p.ratoon}</td>
              <td>${p.harvestReferenceDate || '—'}<br><span style="font-size:10px;color:var(--gray-500)">${p.harvestReferenceType==='ratoon' ? 'ratoon start' : 'planting date'}</span></td>
              <td>${p.monthsPastDue > 0 ? pill(p.monthsPastDue + ' mo overdue', p.monthsPastDue>=3?'red':'amber') : pill('Due now','blue')}</td>
              <td>${fmtHa(p.areaHa)}</td>
              <td>${p.expectedYieldTons!=null ? fmt(p.expectedYieldTons)+' t' : '—'}</td>
              <td><button class="btn btn-primary btn-sm" onclick="showLogHarvestModal('${p._uuid}')">Log Harvest</button></td>
            </tr>`).join('') : `<tr><td colspan="9" style="text-align:center;color:var(--gray-500);padding:24px">No plots currently due for harvest</td></tr>`}
        </tbody>
      </table>
    </div>`;
  }

  el.innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-header-title">Harvest Tracking</div>
      <div class="page-header-sub">Harvest records from live plot data${DATA.isLive ? '' : ' · placeholder data'}</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-outline btn-sm btn-header-action" onclick="showHarvestSettingsModal()">⚙ Configure</button>
      <button class="btn btn-primary btn-xl btn-header-action" onclick="showLogHarvestModal()">+ Log Harvest</button>
    </div>
  </div>
  <div class="grid-4">
    <div class="stat-card green"><div class="stat-label">Total Harvested</div>
      <div class="stat-value">${fmt(totalHarvested.toFixed(1))}<span style="font-size:14px"> t</span></div>
      <div class="stat-meta">${pct(totalHarvested, DATA.stats.targetYieldTonnes)}% of estimated target</div></div>
    <div class="stat-card amber"><div class="stat-label">Plots Due for Harvest</div>
      <div class="stat-value">${allDuePlots.length}</div>
      <div class="stat-meta">${fmt(totalDueExpectedYield.toFixed(1))} t expected yield</div></div>
    <div class="stat-card blue"><div class="stat-label">Plots Harvested</div>
      <div class="stat-value">${harvestedParcels.length}</div>
      <div class="stat-meta">of ${DATA.plots.length} total plots</div></div>
    <div class="stat-card green"><div class="stat-label">Avg Yield / Ac</div>
      <div class="stat-value">${DATA.stats.avgYieldPerHa}<span style="font-size:14px"> t</span></div>
      <div class="stat-meta">Across harvested plots</div></div>
  </div>

  <div class="grid-2" style="margin-bottom:20px">
    <div class="card">
      <div class="card-header"><div class="card-title">Monthly Harvest Trend</div>
        <div style="font-size:11px;color:var(--gray-500)">Actual harvest tonnage · last 12 months</div></div>
      <div class="chart-box"><canvas id="chart-harvest-trend"></canvas></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Harvest by Estate</div></div>
      <div class="chart-box"><canvas id="chart-harvest-estate"></canvas></div>
      <div style="margin-top:10px">
        ${estateYields.map((e,i)=>`
          <div class="legend-row">
            <span class="legend-dot" style="background:${DATA.productionByEstate.colors[i]||'#4a9e6e'}"></span>
            <span>${e.name}</span>
            <span class="legend-val">${fmt(e.tonnes.toFixed(1))} t</span>
          </div>`).join('')}
      </div>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px">
    <div class="card-header"><div class="card-title">Harvests Due</div>
      <div style="font-size:11px;color:var(--gray-500)">Plots past their configured harvest maturity period</div></div>
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:flex-end" id="harvest-due-filters">
      ${dueFiltersHTML()}
    </div>
    <div id="harvest-due-table">${dueTableHTML()}</div>
  </div>

  <div class="card">
    <div class="card-header"><div class="card-title">Harvest Log</div>
      <div style="font-size:11px;color:var(--gray-500)">Sourced from vsl_harvests (latest per plot)</div></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Plot</th><th>Block</th><th>Estate</th><th>Last Harvest Date</th>
        <th>Harvest Tonnage</th><th>Area</th><th>Yield/Ac</th></tr></thead>
        <tbody>
          ${harvestedParcels.length ? harvestedParcels.map(p=>`
            <tr style="cursor:pointer" onclick="viewHarvestDetail('${p.id}')">
              <td><strong>${p.parcelName || p.id}</strong></td><td>${p.blockName || p.block}</td><td>${p.estate}</td>
              <td>${p.lastHarvestDate || '—'}</td>
              <td>${p.yield} t</td>
              <td>${fmtHa(p.areaHa)}</td>
              <td>${p.areaHa ? (p.yield/(p.areaHa*2.47105)).toFixed(2) : '—'} t/ac</td>
            </tr>`).join('') : `<tr><td colspan="7" style="text-align:center;color:var(--gray-500);padding:24px">No harvest records yet</td></tr>`}
        </tbody>
      </table>
    </div>
    <div style="font-size:12px;color:var(--gray-500);margin-top:10px">
      💡 Click any row to view full harvest details
    </div>
  </div>`;

  // ── Harvests Due filter handlers ──
  window.filterHarvestDueEstate = function(val) {
    hdEstFilter = val; hdBlockFilter = '';
    document.getElementById('harvest-due-filters').innerHTML = dueFiltersHTML();
    document.getElementById('harvest-due-table').innerHTML = dueTableHTML();
  };
  window.filterHarvestDueBlock = function(val) {
    hdBlockFilter = val;
    document.getElementById('harvest-due-table').innerHTML = dueTableHTML();
  };
  // Plain text row filter (like the Land Management plot search) — toggles row
  // visibility instead of re-rendering, so the input never loses focus while typing.
  window.filterHarvestDuePlotSearch = function(val) {
    document.querySelectorAll('#harvest-due-tbody tr').forEach(r => {
      r.style.display = r.textContent.toLowerCase().includes(val.toLowerCase()) ? '' : 'none';
    });
  };

  // ── Log Harvest modal (admin enters the harvest directly — records vsl_harvests +
  // a matching vsl_activities "Harvesting" entry, marks the plot's ratoon shifted) ──
  window.showLogHarvestModal = function(plotUuid) {
    const preselected = plotUuid ? DATA.plots.find(p => p._uuid === plotUuid) : null;
    const today = new Date().toISOString().slice(0,10);
    showModal(`
      <div class="modal-title">Log Harvest</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Estate</label>
          <select class="form-input" id="lh-estate" onchange="onLogHarvestEstateChange()">
            <option value="">Select estate…</option>
            ${DATA.estates.map(e=>`<option value="${e.name}" ${preselected&&preselected.estate===e.name?'selected':''}>${e.name}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Block</label>
          <select class="form-input" id="lh-block" onchange="onLogHarvestBlockChange()">
            <option value="">Select block…</option>
            ${(preselected ? DATA.blocks.filter(b=>b.estate===preselected.estate) : []).map(b=>`<option value="${b._uuid}" ${preselected&&preselected._blockUuid===b._uuid?'selected':''}>${b.name || b.id}</option>`).join('')}
          </select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Plot</label>
          <select class="form-input" id="lh-plot" onchange="onLogHarvestPlotChange()">
            <option value="">Select plot…</option>
            ${(preselected ? DATA.plots.filter(p=>p._blockUuid===preselected._blockUuid) : []).map(p=>`<option value="${p._uuid}" ${preselected&&preselected._uuid===p._uuid?'selected':''}>${p.parcelName || p.id}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Harvest Date</label>
          <input class="form-input" id="lh-date" type="date" value="${today}"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Harvest Tonnage (t)</label>
          <input class="form-input" id="lh-tonnage" type="number" min="0" step="0.01" placeholder="e.g. 145.5"></div>
        <div class="form-group"><label class="form-label">Current Ratoon</label>
          <input class="form-input" id="lh-ratoon" type="text" value="${preselected ? (preselected.ratoon===0?'Plant Crop (0)':'Ratoon '+preselected.ratoon) : '—'}" disabled></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Comments</label>
        <textarea class="form-input" id="lh-comments" rows="2" placeholder="Optional notes"></textarea></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitLogHarvest()">Save Harvest</button>
      </div>`);
  };

  window.onLogHarvestEstateChange = function() {
    const estName = document.getElementById('lh-estate').value;
    const blockSel = document.getElementById('lh-block');
    blockSel.innerHTML = `<option value="">Select block…</option>` +
      DATA.blocks.filter(b => !estName || b.estate === estName).map(b=>`<option value="${b._uuid}">${b.name || b.id}</option>`).join('');
    document.getElementById('lh-plot').innerHTML = `<option value="">Select plot…</option>`;
    document.getElementById('lh-ratoon').value = '—';
  };
  window.onLogHarvestBlockChange = function() {
    const blockId = document.getElementById('lh-block').value;
    const plotSel = document.getElementById('lh-plot');
    plotSel.innerHTML = `<option value="">Select plot…</option>` +
      DATA.plots.filter(p => p._blockUuid === blockId).map(p=>`<option value="${p._uuid}">${p.parcelName || p.id}</option>`).join('');
    document.getElementById('lh-ratoon').value = '—';
  };
  window.onLogHarvestPlotChange = function() {
    const plotUuid = document.getElementById('lh-plot').value;
    const p = DATA.plots.find(x => x._uuid === plotUuid);
    document.getElementById('lh-ratoon').value = p ? (p.ratoon===0?'Plant Crop (0)':'Ratoon '+p.ratoon) : '—';
  };

  window.submitLogHarvest = async function() {
    const plotUuid = document.getElementById('lh-plot').value;
    const dateVal = document.getElementById('lh-date').value;
    const tonnage = document.getElementById('lh-tonnage').value;
    const comments = document.getElementById('lh-comments').value.trim();
    if (!plotUuid) { showToast('Select a plot', 'red'); return; }
    if (!dateVal) { showToast('Harvest date is required', 'red'); return; }
    if (!tonnage || parseFloat(tonnage) <= 0) { showToast('Enter a valid harvest tonnage', 'red'); return; }
    const plot = DATA.plots.find(p => p._uuid === plotUuid);
    if (!plot) { showToast('Plot not found', 'red'); return; }
    const estateRow = DATA.estates.find(e => e.name === plot.estate);
    const currentRatoon = plot.ratoon || 0;
    const nextRatoon = currentRatoon + 1;
    const nextExpectedHarvest = addMonthsToDateStr(dateVal, estateRow ? estateRow.harvestPeriodMonths : 18);
    try {
      const client = getSbClient();
      const uid = await getCurrentUserId();

      const { error: hErr } = await client.from('vsl_harvests').insert([{
        parcel_id: plotUuid, harvest_date: dateVal, gross_weight_tonnes: tonnage,
        ratoon_at_harvest: currentRatoon, created_by: uid,
      }]);
      if (hErr) throw hErr;

      const { error: aErr } = await client.from('vsl_activities').insert([{
        activity_name: 'Harvesting', activity_date: dateVal,
        parcel_id: plotUuid, block_id: plot._blockUuid, estate_id: estateRow ? estateRow._id : null,
        completion_value: 100, comments: comments || null, created_by: uid,
      }]);
      if (aErr) throw aErr;

      // Mark the plot harvested and shift it onto the next ratoon cycle.
      const { error: pErr } = await client.from('vsl_parcels').update({
        ratoon_number: nextRatoon, ratoon_start_date: dateVal,
        expected_harvest_date: nextExpectedHarvest, cultivation_status: 'ratoon',
      }).eq('id', plotUuid);
      if (pErr) throw pErr;

      closeModal();
      showToast(`Harvest logged — ${plot.parcelName || plot.id} shifted to Ratoon ${nextRatoon}`);
      await retryLiveDataLoad();
      renderTabIfCurrent('production');
    } catch (err) {
      console.error(err);
      showToast('Failed to log harvest: ' + err.message, 'red');
    }
  };

  // ── Harvest Settings modal (admin-configurable per estate) — one editable
  // table covering every estate at once, saved together. ──
  window.showHarvestSettingsModal = function() {
    showModal(`
      <div class="modal-title">Harvest Settings</div>
      <div class="table-wrap">
        <table style="min-width:0;table-layout:fixed">
          <thead><tr>
            <th style="width:38%">Estate</th>
            <th style="width:31%;white-space:normal">Harvest Period<br>(months)</th>
            <th style="width:31%;white-space:normal">Yield per Acre<br>(t/ac)</th>
          </tr></thead>
          <tbody>
            ${DATA.estates.map(e=>`
              <tr>
                <td style="overflow-wrap:break-word"><strong>${e.name}</strong></td>
                <td><input class="form-input" style="width:100%;box-sizing:border-box" type="number" min="1" step="1" id="hs-period-${e._id}" value="${e.harvestPeriodMonths}"></td>
                <td><input class="form-input" style="width:100%;box-sizing:border-box" type="number" min="0" step="0.1" id="hs-yield-${e._id}" value="${e.yieldPerAcreTons}"></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitHarvestSettings()">Save Settings</button>
      </div>`);
  };
  window.submitHarvestSettings = async function() {
    const updates = [];
    for (const e of DATA.estates) {
      const period = parseInt(document.getElementById(`hs-period-${e._id}`).value, 10);
      const yieldAc = parseFloat(document.getElementById(`hs-yield-${e._id}`).value);
      if (!period || period <= 0) { showToast(`Enter a valid harvest period for ${e.name}`, 'red'); return; }
      if (!yieldAc || yieldAc <= 0) { showToast(`Enter a valid yield per acre for ${e.name}`, 'red'); return; }
      if (period !== e.harvestPeriodMonths || yieldAc !== e.yieldPerAcreTons) {
        updates.push({ id: e._id, harvest_period_months: period, yield_per_acre_tons: yieldAc });
      }
    }
    if (!updates.length) { closeModal(); return; }
    try {
      const client = getSbClient();
      const results = await Promise.all(updates.map(u => client.from('vsl_estate').update({
        harvest_period_months: u.harvest_period_months, yield_per_acre_tons: u.yield_per_acre_tons,
      }).eq('id', u.id)));
      const firstError = results.find(r => r.error);
      if (firstError) throw firstError.error;
      closeModal();
      showToast('Harvest settings saved');
      await retryLiveDataLoad();
      renderTabIfCurrent('production');
    } catch (err) {
      console.error(err);
      showToast('Failed to save harvest settings: ' + err.message, 'red');
    }
  };

  window.viewHarvestDetail = function(plotId) {
    const p = DATA.plots.find(x => x.id === plotId);
    if (!p) return;
    const attrs = [
      ['Plot Name',           p.parcelName || p.id],
      ['Block',               p.blockName || p.block],
      ['Estate',              p.estate],
      ['Area (ac)',           fmtHa(p.areaHa)],
      ['Cane Variety',        p.variety || '— (no season record yet)'],
      ['Ratoon Number',       p.ratoon===0 ? 'Plant Crop (0)' : 'Ratoon ' + p.ratoon],
      ['Growth Stage',        p.stage],
      ['Health Status',       p.health.charAt(0).toUpperCase()+p.health.slice(1)],
      ['Planting Date',       p.planted || '—'],
      ['Last Harvest Date',   p.lastHarvestDate || '—'],
      ['Ratoon at Last Harvest', p.lastHarvestRatoon != null ? p.lastHarvestRatoon : '—'],
      ['Harvest Tonnage',     p.yield ? p.yield + ' t' : '—'],
      ['Yield per Ac',        p.yield && p.areaHa ? (p.yield/(p.areaHa*2.47105)).toFixed(2) + ' t/ac' : '—'],
      ['Logged By',           p.lastHarvestLoggedByName || '—'],
      ['Cultivation Notes',   p.cultivationNotes || '—'],
    ];
    showModal(`
      <div class="modal-title">Harvest Details — ${p.parcelName || p.id}</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:40%">Attribute</th><th>Value</th></tr></thead>
          <tbody>
            ${attrs.map(([attr,val],i)=>`
              <tr style="background:${i%2===0?'var(--gray-50)':'var(--white)'}">
                <td style="font-weight:600;color:var(--gray-700);font-size:12px">${attr}</td>
                <td style="color:var(--gray-900);font-size:13px">${val}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal();openPanel('estates',null);setTimeout(()=>viewPlotDetail('${p.id}'),0)">View Full Plot Record</button>
      </div>`);
  };
}

// ══════════════════════════════════════
//  PAGE: SEASONS
//  Manages public.vsl_parcel_seasons — the append-only planting/crop-cycle
//  history per plot (cane variety, ratoon, planting/harvest dates, yield,
//  status). Most fields are trigger-maintained on the DB side by
//  vsl_sync_parcel_season(), which fires whenever a vsl_parcels row changes:
//  a changed planting_date inserts a fresh season row and points the
//  parcel's current_season_id at it; any other change just updates the
//  latest season row in place. "Log New Season" below works *with* that
//  trigger (it updates vsl_parcels, then patches the manual-only fields —
//  season name, cane variety, target yield — the trigger never touches).
//  "Edit" on an existing row updates vsl_parcel_seasons directly, which is
//  always safe since none of those writes touch vsl_parcels.
// ══════════════════════════════════════

const SEASON_STATUSES = ['planned', 'planted', 'growing', 'harvested', 'failed'];
const SEASON_STATUS_COLORS = { planned: 'gray', planted: 'blue', growing: 'green', harvested: 'green', failed: 'red' };
function seasonStatusPill(s) {
  if (!s) return pill('—', 'gray');
  return pill(titleCaseLocal(s), SEASON_STATUS_COLORS[s] || 'gray');
}

function renderSeasons(el) {
  let sEstFilter = '', sBlockFilter = '', sStatusFilter = '';

  function filteredSeasons() {
    return DATA.seasons.filter(s =>
      (!sEstFilter || s.estate === sEstFilter) &&
      (!sBlockFilter || s.blockUuid === sBlockFilter) &&
      (!sStatusFilter || s.status === sStatusFilter)
    );
  }

  const totalSeasons = DATA.seasons.length;
  const growingCount = DATA.seasons.filter(s => s.status === 'growing').length;
  const plannedCount = DATA.seasons.filter(s => s.status === 'planned' || s.status === 'planted').length;
  const varietyCount = new Set(DATA.seasons.map(s => s.caneVariety).filter(Boolean)).size;
  const knownVarieties = [...new Set(DATA.seasons.map(s => s.caneVariety).filter(Boolean))].sort();

  function filtersHTML() {
    const blocksForFilter = DATA.blocks.filter(b => !sEstFilter || b.estate === sEstFilter);
    return `
      <input class="form-input" style="max-width:180px" placeholder="Search plot…" id="season-plot-search" oninput="filterSeasonPlotSearch(this.value)">
      <select class="form-input" style="width:150px" id="season-estate-filter" onchange="filterSeasonsEstate(this.value)">
        <option value="">All Estates</option>
        ${DATA.estates.map(e=>`<option value="${e.name}" ${sEstFilter===e.name?'selected':''}>${e.name}</option>`).join('')}
      </select>
      <select class="form-input" style="width:160px" id="season-block-filter" onchange="filterSeasonsBlock(this.value)">
        <option value="">All Blocks</option>
        ${blocksForFilter.map(b=>`<option value="${b._uuid}" ${sBlockFilter===b._uuid?'selected':''}>${b.name || b.id}</option>`).join('')}
      </select>
      <select class="form-input" style="width:140px" id="season-status-filter" onchange="filterSeasonsStatus(this.value)">
        <option value="">All Statuses</option>
        ${SEASON_STATUSES.map(s=>`<option value="${s}" ${sStatusFilter===s?'selected':''}>${titleCaseLocal(s)}</option>`).join('')}
      </select>`;
  }

  function tableHTML() {
    const rows = filteredSeasons();
    return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Plot</th><th>Block</th><th>Estate</th><th>Season</th><th>Variety</th>
        <th>Ratoon</th><th>Planting Date</th><th>Expected Harvest</th><th>Status</th><th>Target Yield</th><th>Actions</th></tr></thead>
        <tbody id="seasons-tbody">
          ${rows.length ? rows.map(s=>`
            <tr style="cursor:pointer" onclick="viewSeasonDetail('${s.id}')">
              <td><strong>${s.plot}</strong>${s.isCurrent ? ' '+pill('Current','green') : ''}</td>
              <td>${s.block}</td>
              <td>${s.estate}</td>
              <td>${s.seasonName || '—'}</td>
              <td>${s.caneVariety || '—'}</td>
              <td>${s.ratoonNumber===0 ? 'Plant Crop' : 'Ratoon '+s.ratoonNumber}</td>
              <td>${s.plantingDate || '—'}</td>
              <td>${s.expectedHarvestDate || '—'}</td>
              <td>${seasonStatusPill(s.status)}</td>
              <td>${s.targetYieldTonnes!=null ? fmt(s.targetYieldTonnes)+' t' : '—'}</td>
              <td onclick="event.stopPropagation()"><div style="display:flex;gap:4px">
                <button class="icon-btn" onclick="showEditSeasonModal('${s.id}')" title="Edit">✎</button>
                <button class="icon-btn danger" onclick="confirmDeleteSeason('${s.id}')" title="Delete">🗑</button>
              </div></td>
            </tr>`).join('') : `<tr><td colspan="11" style="text-align:center;color:var(--gray-500);padding:24px">No season records yet</td></tr>`}
        </tbody>
      </table>
    </div>`;
  }

  el.innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-header-title">Seasons</div>
      <div class="page-header-sub">Planting &amp; crop-cycle history per plot${DATA.isLive ? '' : ' · placeholder data'}</div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary btn-xl btn-header-action" onclick="showLogSeasonModal()">+ Log New Season</button>
    </div>
  </div>
  <div class="grid-4">
    <div class="stat-card blue"><div class="stat-label">Total Season Records</div>
      <div class="stat-value">${totalSeasons}</div>
      <div class="stat-meta">Across ${DATA.plots.length} plots</div></div>
    <div class="stat-card green"><div class="stat-label">Currently Growing</div>
      <div class="stat-value">${growingCount}</div></div>
    <div class="stat-card amber"><div class="stat-label">Planned / Planted</div>
      <div class="stat-value">${plannedCount}</div></div>
    <div class="stat-card green"><div class="stat-label">Cane Varieties in Use</div>
      <div class="stat-value">${varietyCount}</div></div>
  </div>

  <div class="grid-2" style="margin-bottom:20px">
    <div class="card">
      <div class="card-header"><div class="card-title">Seasons by Status</div></div>
      <div class="chart-box"><canvas id="chart-season-status"></canvas></div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Plots by Cane Variety</div></div>
      <div class="chart-box"><canvas id="chart-season-variety"></canvas></div>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><div class="card-title">Season Records</div>
      <div style="font-size:11px;color:var(--gray-500)">Sourced from vsl_parcel_seasons</div></div>
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:flex-end" id="seasons-filters">
      ${filtersHTML()}
    </div>
    <div id="seasons-table">${tableHTML()}</div>
  </div>`;

  // ── Filter handlers ──
  window.filterSeasonsEstate = function(val) {
    sEstFilter = val; sBlockFilter = '';
    document.getElementById('seasons-filters').innerHTML = filtersHTML();
    document.getElementById('seasons-table').innerHTML = tableHTML();
  };
  window.filterSeasonsBlock = function(val) { sBlockFilter = val; document.getElementById('seasons-table').innerHTML = tableHTML(); };
  window.filterSeasonsStatus = function(val) { sStatusFilter = val; document.getElementById('seasons-table').innerHTML = tableHTML(); };
  // Plain text row filter (matches the Harvests Due search) — toggles row
  // visibility instead of re-rendering, so the input never loses focus while typing.
  window.filterSeasonPlotSearch = function(val) {
    document.querySelectorAll('#seasons-tbody tr').forEach(r => {
      r.style.display = r.textContent.toLowerCase().includes(val.toLowerCase()) ? '' : 'none';
    });
  };

  // ── Season detail modal ──
  window.viewSeasonDetail = function(id) {
    const s = DATA.seasons.find(x => x.id === id);
    if (!s) return;
    const attrs = [
      ['Plot', s.plot], ['Block', s.block], ['Estate', s.estate],
      ['Season Name', s.seasonName || '—'],
      ['Cane Variety', s.caneVariety || '—'],
      ['Ratoon', s.ratoonNumber===0 ? 'Plant Crop (0)' : 'Ratoon '+s.ratoonNumber],
      ['Planting Date', s.plantingDate || '—'],
      ['Expected Harvest', s.expectedHarvestDate || '—'],
      ['Actual Harvest', s.actualHarvestDate || '—'],
      ['Growth Stage', s.growthStage || '—'],
      ['Status', titleCaseLocal(s.status)],
      ['Target Yield', s.targetYieldTonnes!=null ? s.targetYieldTonnes+' t' : '—'],
      ['Actual Yield', s.actualYieldTonnes!=null ? s.actualYieldTonnes+' t' : '—'],
      ['Yield / Ha', s.yieldPerHectare!=null ? s.yieldPerHectare+' t/ha' : '—'],
      ['Failure Reason', s.failureReason || '—'],
      ['Notes', s.notes || '—'],
      ['Logged By', s.createdByName || '—'],
      ['Logged', s.createdAt ? s.createdAt.replace('T',' ').slice(0,16) : '—'],
    ];
    showModal(`
      <div class="modal-title">Season — ${s.plot}${s.isCurrent ? ' '+pill('Current','green') : ''}</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:40%">Attribute</th><th>Value</th></tr></thead>
          <tbody>
            ${attrs.map(([k,v],i)=>`
              <tr style="background:${i%2===0?'var(--gray-50)':'var(--white)'}">
                <td style="font-weight:600;color:var(--gray-700);font-size:12px">${k}</td>
                <td style="color:var(--gray-900);font-size:13px">${v}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal();showEditSeasonModal('${s.id}')">✎ Edit</button>
        <button class="btn btn-danger" onclick="closeModal();confirmDeleteSeason('${s.id}')">🗑 Delete</button>
      </div>`);
  };

  // ── Log New Season modal — starts a new planting/crop cycle for a plot. ──
  window.showLogSeasonModal = function(plotUuid) {
    const preselected = plotUuid ? DATA.plots.find(p => p._uuid === plotUuid) : null;
    const today = new Date().toISOString().slice(0,10);
    showModal(`
      <div class="modal-title">Log New Season</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Estate</label>
          <select class="form-input" id="ls-estate" onchange="onLogSeasonEstateChange()">
            <option value="">Select estate…</option>
            ${DATA.estates.map(e=>`<option value="${e.name}" ${preselected&&preselected.estate===e.name?'selected':''}>${e.name}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Block</label>
          <select class="form-input" id="ls-block" onchange="onLogSeasonBlockChange()">
            <option value="">Select block…</option>
            ${(preselected ? DATA.blocks.filter(b=>b.estate===preselected.estate) : []).map(b=>`<option value="${b._uuid}" ${preselected&&preselected._blockUuid===b._uuid?'selected':''}>${b.name || b.id}</option>`).join('')}
          </select></div>
      </div>
      <div style="margin-bottom:12px">
        <div class="form-group"><label class="form-label">Plot</label>
          <select class="form-input" id="ls-plot">
            <option value="">Select plot…</option>
            ${(preselected ? DATA.plots.filter(p=>p._blockUuid===preselected._blockUuid) : []).map(p=>`<option value="${p._uuid}" ${preselected&&preselected._uuid===p._uuid?'selected':''}>${p.parcelName || p.id}</option>`).join('')}
          </select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Season Name</label>
          <input class="form-input" id="ls-name" placeholder="e.g. 2026-A"></div>
        <div class="form-group"><label class="form-label">Cane Variety</label>
          <input class="form-input" id="ls-variety" list="ls-variety-list" placeholder="e.g. CH24X">
          <datalist id="ls-variety-list">${knownVarieties.map(v=>`<option value="${v}">`).join('')}</datalist></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Ratoon Number</label>
          <input class="form-input" id="ls-ratoon" type="number" min="0" step="1" value="0"></div>
        <div class="form-group"><label class="form-label">Planting Date</label>
          <input class="form-input" id="ls-planting" type="date" value="${today}"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Expected Harvest Date</label>
          <input class="form-input" id="ls-expected" type="date"></div>
        <div class="form-group"><label class="form-label">Target Yield (t)</label>
          <input class="form-input" id="ls-target" type="number" min="0" step="0.1" placeholder="e.g. 120"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Notes</label>
        <textarea class="form-input" id="ls-notes" rows="2" placeholder="Optional notes"></textarea></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitLogSeason()">Save Season</button>
      </div>`);
  };

  window.onLogSeasonEstateChange = function() {
    const estName = document.getElementById('ls-estate').value;
    const blockSel = document.getElementById('ls-block');
    blockSel.innerHTML = `<option value="">Select block…</option>` +
      DATA.blocks.filter(b => !estName || b.estate === estName).map(b=>`<option value="${b._uuid}">${b.name || b.id}</option>`).join('');
    document.getElementById('ls-plot').innerHTML = `<option value="">Select plot…</option>`;
  };
  window.onLogSeasonBlockChange = function() {
    const blockId = document.getElementById('ls-block').value;
    const plotSel = document.getElementById('ls-plot');
    plotSel.innerHTML = `<option value="">Select plot…</option>` +
      DATA.plots.filter(p => p._blockUuid === blockId).map(p=>`<option value="${p._uuid}">${p.parcelName || p.id}</option>`).join('');
  };

  window.submitLogSeason = async function() {
    const plotUuid = document.getElementById('ls-plot').value;
    const seasonName = document.getElementById('ls-name').value.trim();
    const variety = document.getElementById('ls-variety').value.trim();
    const ratoon = document.getElementById('ls-ratoon').value;
    const planting = document.getElementById('ls-planting').value;
    const expected = document.getElementById('ls-expected').value;
    const target = document.getElementById('ls-target').value;
    const notes = document.getElementById('ls-notes').value.trim();
    if (!plotUuid) { showToast('Select a plot', 'red'); return; }
    if (!planting) { showToast('Planting date is required', 'red'); return; }
    try {
      const client = getSbClient();
      // 1. Update the parcel — the vsl_sync_parcel_season DB trigger reads this
      // change and inserts a fresh vsl_parcel_seasons row, pointing
      // current_season_id at it (or updates the latest row in place if the
      // planting date didn't actually change).
      const { data: updatedParcel, error: pErr } = await client.from('vsl_parcels').update({
        planting_date: planting,
        ratoon_number: ratoon ? parseInt(ratoon, 10) : 0,
        expected_harvest_date: expected || null,
        cultivation_status: 'planted',
        cultivation_notes: notes || null,
      }).eq('id', plotUuid).select('current_season_id').single();
      if (pErr) throw pErr;

      // 2. Patch the resulting season row with the manual-only fields the
      // trigger doesn't set (season name, cane variety, target yield).
      const newSeasonId = updatedParcel?.current_season_id;
      if (newSeasonId) {
        const { error: sErr } = await client.from('vsl_parcel_seasons').update({
          season_name: seasonName || null,
          cane_variety: variety || null,
          target_yield_tonnes: target || null,
        }).eq('id', newSeasonId);
        if (sErr) throw sErr;
      }

      closeModal();
      showToast('Season logged');
      await retryLiveDataLoad();
      renderTabIfCurrent('seasons');
    } catch (err) {
      console.error(err);
      showToast('Failed to log season: ' + err.message, 'red');
    }
  };

  // ── Edit Season modal — direct edit of a vsl_parcel_seasons row. Safe for
  // any field here since none of these writes touch vsl_parcels/the trigger. ──
  window.showEditSeasonModal = function(id) {
    const s = DATA.seasons.find(x => x.id === id);
    if (!s) return;
    showModal(`
      <div class="modal-title">Edit Season — ${s.plot}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Season Name</label>
          <input class="form-input" id="es-name" value="${s.seasonName||''}"></div>
        <div class="form-group"><label class="form-label">Cane Variety</label>
          <input class="form-input" id="es-variety" list="es-variety-list" value="${s.caneVariety||''}">
          <datalist id="es-variety-list">${knownVarieties.map(v=>`<option value="${v}">`).join('')}</datalist></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Growth Stage</label>
          <select class="form-input" id="es-stage">
            <option value="">—</option>
            ${STAGE_ORDER.map(st=>`<option value="${st}" ${s.growthStage===st?'selected':''}>${st}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Status</label>
          <select class="form-input" id="es-status">
            ${SEASON_STATUSES.map(st=>`<option value="${st}" ${s.status===st?'selected':''}>${titleCaseLocal(st)}</option>`).join('')}
          </select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Target Yield (t)</label>
          <input class="form-input" id="es-target" type="number" min="0" step="0.1" value="${s.targetYieldTonnes ?? ''}"></div>
        <div class="form-group"><label class="form-label">Actual Yield (t)</label>
          <input class="form-input" id="es-actual" type="number" min="0" step="0.1" value="${s.actualYieldTonnes ?? ''}"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Actual Harvest Date</label>
          <input class="form-input" id="es-actual-harvest" type="date" value="${s.actualHarvestDate||''}"></div>
        <div class="form-group"><label class="form-label">Failure Reason</label>
          <input class="form-input" id="es-failure" value="${s.failureReason||''}" placeholder="If status is Failed"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Notes</label>
        <textarea class="form-input" id="es-notes" rows="2">${s.notes||''}</textarea></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitEditSeason('${s.id}')">Save Changes</button>
      </div>`);
  };

  window.submitEditSeason = async function(id) {
    const seasonName = document.getElementById('es-name').value.trim();
    const variety = document.getElementById('es-variety').value.trim();
    const stage = document.getElementById('es-stage').value;
    const status = document.getElementById('es-status').value;
    const target = document.getElementById('es-target').value;
    const actual = document.getElementById('es-actual').value;
    const actualHarvest = document.getElementById('es-actual-harvest').value;
    const failure = document.getElementById('es-failure').value.trim();
    const notes = document.getElementById('es-notes').value.trim();
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_parcel_seasons').update({
        season_name: seasonName || null,
        cane_variety: variety || null,
        growth_stage: stage || null,
        season_status: status,
        target_yield_tonnes: target || null,
        actual_yield_tonnes: actual || null,
        actual_harvest_date: actualHarvest || null,
        failure_reason: failure || null,
        notes: notes || null,
      }).eq('id', id);
      if (error) throw error;
      closeModal();
      showToast('Season updated');
      await retryLiveDataLoad();
      renderTabIfCurrent('seasons');
    } catch (err) {
      console.error(err);
      showToast('Failed to update season: ' + err.message, 'red');
    }
  };

  window.confirmDeleteSeason = function(id) {
    showModal(`
      <div class="modal-title">Delete Season Record</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">Delete this season record? This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="submitDeleteSeason('${id}')">Yes, Delete</button>
      </div>`);
  };

  window.submitDeleteSeason = async function(id) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_parcel_seasons').delete().eq('id', id);
      if (error) throw error;
      closeModal();
      showToast('Season record deleted', 'red');
      await retryLiveDataLoad();
      renderTabIfCurrent('seasons');
    } catch (err) {
      console.error(err);
      showToast('Failed to delete season: ' + err.message, 'red');
    }
  };
}

// ══════════════════════════════════════
//  PAGE: ACTIVITIES
// ══════════════════════════════════════

// Activity names + Completion enum are now fetched from the DB catalog
// (vsl_activity_types / vsl_activity_common_fields, see supabase-client.js
// loadLiveData) instead of being hardcoded here — this used to be its own
// separate 17-name array that had drifted from the webmap's copy in
// map-app.js (e.g. Completion was a free 0-100 number here vs. an enum
// there). ACTIVITY_TYPES() below always reflects whatever's live in DATA.
function ACTIVITY_TYPES() { return DATA.activityTypes && DATA.activityTypes.length ? DATA.activityTypes : ['Bush Clearing','Ploughing','Harrow','Ripping','Ridging','Furrowing','Lime Application','Planting','Manuring','Fertilization','Weeding','Spraying','Irrigation','Harvesting','Loading','Trash Lining','Trash Collection']; }

// Completion enum + labels — falls back to this if vsl_activity_common_fields
// hasn't been seeded yet (see DATA.activityCommonFields).
const COMPLETION_OPTIONS_FALLBACK = { options: ['0','20','50','75','100'], optionLabels: ['0%','20%','50%','75%','100%'] };
function completionOptions() {
  const f = (DATA.activityCommonFields || []).find(f => f.key === 'completion_value');
  return f && f.options ? { options: f.options, optionLabels: f.optionLabels || f.options.map(o => o + '%') } : COMPLETION_OPTIONS_FALLBACK;
}

function renderActivities(el) {
  let estFilter = '';
  // Latest first — activity_date desc, falling back to logged-at (createdAt) desc
  // as a tiebreaker for same-date rows or rows with no date set.
  const acts = () => DATA.activities
    .filter(a => !estFilter || a.estate === estFilter)
    .sort((a,b) => (new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0))
      || (new Date(b.createdAt || 0) - new Date(a.createdAt || 0)));

  const oneWeekAgo = Date.now() - 7*24*60*60*1000;
  const thisWeek = DATA.activities.filter(a => a.date && new Date(a.date).getTime() >= oneWeekAgo).length;
  const distinctTypes = new Set(DATA.activities.map(a => a.name)).size;
  const linkedCost = DATA.costs.filter(c => DATA.activities.some(a => a.id === c.activityId))
    .reduce((s,c) => s + c.amount, 0);

  function table() {
    const rows = acts();
    return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Date</th><th>Activity</th><th>Estate</th><th>Block</th><th>Plot</th>
        <th>Logged By</th><th>Team</th><th>Completion</th><th>Actions</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(a=>`
            <tr style="cursor:pointer" onclick="viewActivityDetail('${a.id}')">
              <td>${a.date || '—'}</td>
              <td><strong>${a.name}</strong></td>
              <td>${a.estate}</td>
              <td>${a.block}</td>
              <td>${a.parcel || '—'}</td>
              <td>${a.createdByName || '—'}</td>
              <td>${a.teamSize ?? '—'}</td>
              <td>${a.completionValue != null ? `
                <div style="display:flex;align-items:center;gap:6px">
                  <div class="progress-bar-wrap" style="width:70px">
                    <div class="progress-bar ${a.completionValue>75?'green':a.completionValue>50?'amber':'red'}"
                         style="width:${Math.min(100,a.completionValue)}%"></div>
                  </div>
                  <span style="font-size:11px;font-weight:700">${a.completionValue}%</span>
                </div>` : '—'}</td>
              <td onclick="event.stopPropagation()"><div style="display:flex;gap:4px">
                <button class="icon-btn" onclick="showEditActivityModal('${a.id}')" title="Edit">✎</button>
                <button class="icon-btn danger" onclick="confirmDeleteActivity('${a.id}')" title="Delete">🗑</button>
              </div></td>
            </tr>`).join('') : `<tr><td colspan="9" style="text-align:center;color:var(--gray-500);padding:24px">No activities logged yet</td></tr>`}
        </tbody>
      </table>
    </div>`;
  }

  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">Field Activities</div>
    <div class="page-header-sub">${DATA.activities.length} activities logged${DATA.isLive ? '' : ' · placeholder data'}</div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <select class="form-input" style="width:160px" id="act-estate-filter" onchange="filterActivitiesEstate(this.value)">
        <option value="">All Estates</option>
        ${DATA.estates.map(e=>`<option>${e.name}</option>`).join('')}
      </select>
      <button class="btn btn-primary btn-xl btn-header-action" onclick="showAddActivityModal()">+ Log Activity</button>
    </div>
  </div>
  <div class="grid-4">
    <div class="stat-card green"><div class="stat-label">Total Logged</div><div class="stat-value">${DATA.activities.length}</div></div>
    <div class="stat-card blue"><div class="stat-label">Last 7 Days</div><div class="stat-value">${thisWeek}</div></div>
    <div class="stat-card amber"><div class="stat-label">Activity Types Used</div><div class="stat-value">${distinctTypes}</div><div class="stat-meta">of ${ACTIVITY_TYPES().length} defined</div></div>
    <div class="stat-card green"><div class="stat-label">Linked Cost</div><div class="stat-value" style="font-size:20px">${fmtUGX(linkedCost)}</div></div>
  </div>
  <div class="card"><div class="card-header"><div class="card-title">Activity Log</div></div>
  <div id="activities-table">${table()}</div></div>`;

  window.filterActivitiesEstate = function(val) { estFilter = val; document.getElementById('activities-table').innerHTML = table(); };

  window.viewActivityDetail = function(id) {
    const a = DATA.activities.find(x => x.id === id);
    if (!a) return;
    const attrs = [
      ['Activity', a.name],
      ['Date', a.date || '—'],
      ['Estate', a.estate],
      ['Block', a.block],
      ['Plot', a.parcel || '— (whole block)'],
      ['Assigned To', a.assignedTo || '—'],
      ['Team Size', a.teamSize ?? '—'],
      ['Machines', a.machines ?? '—'],
      ['Completion', a.completionValue != null ? a.completionValue + '%' : '—'],
      ['Area Covered (ac)', a.areaCoveredAcres ?? '—'],
      ['Comments', a.comments || '—'],
      ['Logged By', a.createdByName || '—'],
      ['Logged', a.createdAt ? a.createdAt.replace('T',' ').slice(0,16) : '—'],
    ];
    // Flatten activity_properties (vsl_activities.activity_properties jsonb)
    // using the labels from the same catalog the Log Activity form itself
    // reads (DATA.activityPropertyDefs) — this used to just be dropped on
    // the floor here even though it was already being fetched into
    // a.properties, so anything logged beyond the shared columns (variety,
    // fuel used, weather condition, yield, etc) was invisible in this modal.
    // typeName, not name: for an 'Other' activity `name` is the typed
    // one-off description, which is no key into the catalogue.
    const defs = (DATA.activityPropertyDefs && DATA.activityPropertyDefs[a.typeName || a.name]) || [];
    const labelByKey = {};
    defs.forEach(d => { labelByKey[d.key] = d.label; });
    labelByKey.ratoon_number = labelByKey.ratoon_number || 'Ratoon Number';
    labelByKey.expected_germination_date = labelByKey.expected_germination_date || 'Expected Germination Date';
    Object.entries(a.properties || {}).forEach(([key, value]) => {
      if (value === '' || value == null) return;
      attrs.push([labelByKey[key] || titleCase(key), value]);
    });
    showModal(`
      <div class="modal-title">Activity — ${a.name}</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:40%">Attribute</th><th>Value</th></tr></thead>
          <tbody>
            ${attrs.map(([k,v],i)=>`
              <tr style="background:${i%2===0?'var(--gray-50)':'var(--white)'}">
                <td style="font-weight:600;color:var(--gray-700);font-size:12px">${k}</td>
                <td style="color:var(--gray-900);font-size:13px">${v}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal();showEditActivityModal('${a.id}')">✎ Edit</button>
        <button class="btn btn-danger" onclick="closeModal();confirmDeleteActivity('${a.id}')">🗑 Delete</button>
      </div>`);
  };

}

// ══════════════════════════════════════
//  SHARED ACTIVITY MODALS
//  Used by the Activities page AND the Land → Plots "Log Activity" row
//  action, so these live at top level (they used to be defined inside
//  renderActivities() and only existed after that page had been opened).
// ══════════════════════════════════════

  // Estate → Block → Plot cascade, same pattern as the Log Harvest modal.
  // This used to be Block-only — with no Estate field at all, the only way
  // to scope an activity to an estate (with no specific block) was to leave
  // Block on "— None (estate-level) —", which then had no estate to attach
  // to either (submitAddActivity derived estate_id purely from the chosen
  // block, so "estate-level" logging silently saved with a null estate_id).
  // Estate is now the primary filter: it narrows the Block list, and
  // provides the estate on its own even when no block is picked.
  function scopePickerHTML(prefix, estateVal, blockVal, parcelVal) {
    return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Estate</label>
          <select class="form-input" id="${prefix}-estate" onchange="onActivityEstateChange('${prefix}')">
            <option value="">— All Estates —</option>
            ${DATA.estates.map(e=>`<option value="${e.name}" ${e.name===estateVal?'selected':''}>${e.name}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Block</label>
          <select class="form-input" id="${prefix}-block" onchange="onActivityBlockChange('${prefix}')">
            <option value="">— None (estate-level) —</option>
            ${DATA.blocks.filter(b=>!estateVal || b.estate===estateVal).map(b=>`<option value="${b._uuid}" ${b._uuid===blockVal?'selected':''}>${b.name || b.id}${estateVal?'':' ('+b.estate+')'}</option>`).join('')}
          </select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Plot (optional)</label>
          <select class="form-input" id="${prefix}-parcel">
            <option value="">— Whole block —</option>
            ${DATA.plots.filter(p=>p._blockUuid===blockVal).map(p=>`<option value="${p._uuid}" ${p._uuid===parcelVal?'selected':''}>${p.parcelName || p.id}</option>`).join('')}
          </select></div>
      </div>`;
  }
  window.onActivityEstateChange = function(prefix) {
    const estName = document.getElementById(`${prefix}-estate`).value;
    const blockSel = document.getElementById(`${prefix}-block`);
    blockSel.innerHTML = `<option value="">— None (estate-level) —</option>` +
      DATA.blocks.filter(b => !estName || b.estate === estName).map(b=>`<option value="${b._uuid}">${b.name || b.id}${estName?'':' ('+b.estate+')'}</option>`).join('');
    document.getElementById(`${prefix}-parcel`).innerHTML = `<option value="">— Whole block —</option>`;
  };
  window.onActivityBlockChange = function(prefix) {
    const blockVal = document.getElementById(`${prefix}-block`).value;
    const parcelSel = document.getElementById(`${prefix}-parcel`);
    parcelSel.innerHTML = `<option value="">— Whole block —</option>` +
      DATA.plots.filter(p=>p._blockUuid===blockVal).map(p=>`<option value="${p._uuid}">${p.parcelName || p.id}</option>`).join('');
    // Keep the Estate filter in sync if a block was picked directly without
    // an estate chosen first (block list falls back to showing every block
    // with its estate in parentheses when Estate is blank — see above).
    const estateSel = document.getElementById(`${prefix}-estate`);
    if (estateSel && !estateSel.value && blockVal) {
      const block = DATA.blocks.find(b => b._uuid === blockVal);
      if (block) estateSel.value = block.estate;
    }
  };

  // Completion + Area Covered share the same enum/behaviour as the webmap's
  // Log Activity form: Progress is picked from the fixed 0/20/50/75/100
  // options (DATA.activityCommonFields / completionOptions() above), and
  // Area Covered only makes sense — so is only shown — while Progress isn't
  // 100%. `prefix` is 'aa' (add) or 'ea' (edit).
  function completionFieldHTML(prefix, completionVal, areaVal) {
    const { options, optionLabels } = completionOptions();
    return `
        <div class="form-group"><label class="form-label">Completion (%)</label>
          <select class="form-input" id="${prefix}-completion" onchange="onActivityCompletionChange('${prefix}')">
            <option value="">—</option>
            ${options.map((o,i)=>`<option value="${o}" ${String(completionVal ?? '')===o?'selected':''}>${optionLabels[i]}</option>`).join('')}
          </select></div>
        <div class="form-group" id="${prefix}-area-wrap" ${String(completionVal ?? '')==='100'?'hidden':''}>
          <label class="form-label">Area Covered (ac)</label>
          <input class="form-input" id="${prefix}-area" type="number" min="0" step="0.01" value="${areaVal ?? ''}"></div>`;
  }
  window.onActivityCompletionChange = function(prefix) {
    const val = document.getElementById(`${prefix}-completion`).value;
    const wrap = document.getElementById(`${prefix}-area-wrap`);
    if (wrap) wrap.hidden = (val === '100');
  };

  // ── Activity-specific property fields ──
  // Log/Edit Activity used to only ever show the columns every activity
  // shares (team size, completion, area covered, comments) — none of the
  // per-activity extras (e.g. Bush Clearing's vegetation density/disposal
  // method, Harvesting's yield/brix, Spraying's chemical type, etc) had
  // anywhere to be entered from the dashboard at all, even though the
  // webmap's Log Activity form has always collected them into
  // activity_properties. These now render from the same DB-driven catalog
  // (DATA.activityPropertyDefs, keyed by activity name) the webmap reads,
  // and re-render whenever the Activity Type dropdown changes.
  function activityPropFieldHTML(def, value) {
    const val = value != null ? String(value) : '';
    const escVal = escapeActivityPropVal(val);
    if (def.type === 'select') {
      const opts = (def.options || []).map((o, i) => {
        const label = def.optionLabels ? def.optionLabels[i] : o;
        return `<option value="${o}" ${val === o ? 'selected' : ''}>${label}</option>`;
      }).join('');
      return `<div class="form-group"><label class="form-label">${def.label}</label>
        <select class="form-input" data-prop-key="${def.key}"><option value="">—</option>${opts}</select></div>`;
    }
    if (def.type === 'textarea') {
      return `<div class="form-group"><label class="form-label">${def.label}</label>
        <textarea class="form-input" data-prop-key="${def.key}" rows="2">${escVal}</textarea></div>`;
    }
    const inputType = def.type === 'number' ? 'number' : (def.type === 'date' ? 'date' : 'text');
    return `<div class="form-group"><label class="form-label">${def.label}</label>
      <input class="form-input" data-prop-key="${def.key}" type="${inputType}" ${inputType === 'number' ? 'min="0"' : ''} value="${escVal}"></div>`;
  }
  function escapeActivityPropVal(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }
  function activityPropsSectionHTML(prefix, activityName, existingProps) {
    const defs = (DATA.activityPropertyDefs && DATA.activityPropertyDefs[activityName]) || [];
    if (!defs.length) return `<div id="${prefix}-props-wrap"></div>`;
    return `<div id="${prefix}-props-wrap">
      <div class="form-label" style="margin:4px 0 8px;font-weight:700">${activityName} — activity-specific details</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        ${defs.map(d => activityPropFieldHTML(d, existingProps ? existingProps[d.key] : null)).join('')}
      </div>
    </div>`;
  }
  // The catch-all activity type. activity_name is an FK to
  // vsl_activity_types so it stays 'Other'; what the work actually was goes
  // in vsl_activities.custom_activity_name, which a check constraint
  // requires for 'Other' and forbids for everything else. Same arrangement
  // as the webmap's Log Activity window (see OTHER_ACTIVITY in js/map-app.js).
  const OTHER_ACTIVITY = 'Other';

  // The "what was it?" box. Hidden unless the type is 'Other', in which case
  // it is mandatory.
  function customActivityNameHTML(prefix, value) {
    return `
      <div class="form-group activity-custom-name" id="${prefix}-custom-wrap" ${value ? '' : 'hidden'}>
        <label class="form-label" for="${prefix}-custom-name">Activity Name</label>
        <input class="form-input" id="${prefix}-custom-name" type="text" maxlength="80"
               placeholder="Type the activity name" value="${value ? String(value).replace(/"/g, '&quot;') : ''}">
      </div>`;
  }

  /** The typed name, or '' when the selected type isn't 'Other'. */
  function readCustomActivityName(prefix) {
    const sel = document.getElementById(`${prefix}-name`);
    if (!sel || sel.value !== OTHER_ACTIVITY) return '';
    return (document.getElementById(`${prefix}-custom-name`)?.value || '').trim();
  }

  window.onActivityTypeChange = function(prefix) {
    const name = document.getElementById(`${prefix}-name`).value;
    const wrap = document.getElementById(`${prefix}-props-wrap`);
    if (wrap) wrap.outerHTML = activityPropsSectionHTML(prefix, name, null);
    const customWrap = document.getElementById(`${prefix}-custom-wrap`);
    if (customWrap) {
      const isOther = name === OTHER_ACTIVITY;
      customWrap.hidden = !isOther;
      // Clear on the way out, so a name typed for a one-off can't be sent
      // along with a real activity type and trip the check constraint.
      if (!isOther) {
        const input = document.getElementById(`${prefix}-custom-name`);
        if (input) input.value = '';
      }
    }
  };
  function readActivityPropsFromForm(prefix) {
    const props = {};
    document.querySelectorAll(`#${prefix}-props-wrap [data-prop-key]`).forEach(el => {
      const v = (el.value ?? '').trim();
      if (v !== '') props[el.dataset.propKey] = v;
    });
    return props;
  }

  // Called after a successful save from the Add Activity modal. The Activities
  // page re-renders itself; other callers (e.g. Land → Plots) pass their own.
  let activityOnSaved = null;

  // Read-only "where" summary shown instead of the Estate/Block/Plot pickers
  // when the modal is opened from a specific plot — the scope is fixed there.
  function lockedScopeHTML(prefix, plot) {
    return `
      <div class="locked-scope" style="margin-bottom:12px">
        <div class="locked-scope__item"><span class="locked-scope__label">Estate</span><span class="locked-scope__value">${plot.estate || '—'}</span></div>
        <div class="locked-scope__item"><span class="locked-scope__label">Block</span><span class="locked-scope__value">${plot.blockName || plot.block || '—'}</span></div>
        <div class="locked-scope__item"><span class="locked-scope__label">Plot</span><span class="locked-scope__value">${plot.parcelName || plot.id}</span></div>
        <input type="hidden" id="${prefix}-estate" value="${plot.estate || ''}">
        <input type="hidden" id="${prefix}-block" value="${plot._blockUuid || ''}">
        <input type="hidden" id="${prefix}-parcel" value="${plot._uuid || ''}">
      </div>`;
  }

  // opts (all optional): { plotId, onSaved }
  //   plotId  — plot's display id (DATA.plots[].id); locks the scope to that plot
  //   onSaved — callback run after a successful save instead of re-rendering Activities
  window.showAddActivityModal = function(opts) {
    opts = opts || {};
    const plot = opts.plotId ? DATA.plots.find(x => x.id === opts.plotId) : null;
    activityOnSaved = typeof opts.onSaved === 'function' ? opts.onSaved : null;
    const firstType = ACTIVITY_TYPES()[0];
    showModal(`
      <div class="modal-title">Log Activity${plot ? ' — ' + (plot.parcelName || plot.id) : ''}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Activity Type</label>
          <select class="form-input" id="aa-name" onchange="onActivityTypeChange('aa')">${ACTIVITY_TYPES().map(t=>`<option>${t}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Date</label>
          <input class="form-input" id="aa-date" type="date" value="${new Date().toISOString().slice(0,10)}"></div>
      </div>
      ${customActivityNameHTML('aa', '')}
      ${plot ? lockedScopeHTML('aa', plot) : scopePickerHTML('aa','','','')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Team Size</label><input class="form-input" id="aa-team" type="number" min="0"></div>
        ${completionFieldHTML('aa', null, null)}
      </div>
      ${activityPropsSectionHTML('aa', firstType, null)}
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Comments</label><textarea class="form-input" id="aa-comments" rows="2"></textarea></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddActivity()">Save Activity</button>
      </div>`);
  };

  window.submitAddActivity = async function() {
    const name = document.getElementById('aa-name').value;
    const date = document.getElementById('aa-date').value || null;
    const estateName = document.getElementById('aa-estate').value || null;
    const blockId = document.getElementById('aa-block').value || null;
    const parcelId = document.getElementById('aa-parcel').value || null;
    const team = document.getElementById('aa-team').value;
    const completion = document.getElementById('aa-completion').value;
    const areaCovered = completion !== '100' ? document.getElementById('aa-area').value : '';
    const comments = document.getElementById('aa-comments').value.trim();
    const customName = readCustomActivityName('aa');
    const properties = readActivityPropsFromForm('aa');
    if (name === OTHER_ACTIVITY && !customName) {
      showToast('Type a name for this activity', 'red');
      return;
    }
    try {
      const client = getSbClient();
      // Estate is the primary source of estate_id now — it's picked
      // directly, not just inferred from a block — but fall back to the
      // block's own estate if for some reason a block was set without one
      // (e.g. programmatically) so estate_id is never silently left null
      // while a block is attached.
      const block = DATA.blocks.find(b => b._uuid === blockId);
      const estateRow = DATA.estates.find(e => e.name === estateName)
        || (block ? DATA.estates.find(e => e.name === block.estate) : null);
      const uid = await getCurrentUserId();
      const { error } = await client.from('vsl_activities').insert([{
        activity_name: name, activity_date: date,
        custom_activity_name: name === OTHER_ACTIVITY ? customName : null,
        block_id: blockId, parcel_id: parcelId, estate_id: estateRow ? estateRow._id : null,
        team_size: team || null, completion_value: completion || null,
        area_covered_acres: areaCovered || null,
        comments: comments || null,
        activity_properties: properties,
        created_by: uid,
      }]);
      if (error) throw error;
      closeModal();
      showToast('Activity logged');
      await retryLiveDataLoad();
      const after = activityOnSaved;
      activityOnSaved = null;
      if (after) after(); else renderTabIfCurrent('activities');
    } catch (err) {
      console.error(err);
      showToast('Failed to log activity: ' + err.message, 'red');
    }
  };

  window.showEditActivityModal = function(id) {
    const a = DATA.activities.find(x => x.id === id);
    if (!a) return;
    showModal(`
      <div class="modal-title">Edit Activity — ${a.name}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Activity Type</label>
          <select class="form-input" id="ea-name" onchange="onActivityTypeChange('ea')">${ACTIVITY_TYPES().map(t=>`<option ${t===(a.typeName||a.name)?'selected':''}>${t}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Date</label><input class="form-input" id="ea-date" type="date" value="${a.date||''}"></div>
      </div>
      ${customActivityNameHTML('ea', a.customName || '')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Team Size</label><input class="form-input" id="ea-team" type="number" value="${a.teamSize ?? ''}"></div>
        ${completionFieldHTML('ea', a.completionValue, a.areaCoveredAcres)}
      </div>
      ${activityPropsSectionHTML('ea', a.typeName || a.name, a.properties)}
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Comments</label><textarea class="form-input" id="ea-comments" rows="2">${a.comments||''}</textarea></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitEditActivity('${a.id}')">Save Changes</button>
      </div>`);
  };

  window.submitEditActivity = async function(id) {
    const a = DATA.activities.find(x => x.id === id);
    const name = document.getElementById('ea-name').value;
    const date = document.getElementById('ea-date').value || null;
    const team = document.getElementById('ea-team').value;
    const completion = document.getElementById('ea-completion').value;
    const areaCovered = completion !== '100' ? document.getElementById('ea-area').value : '';
    const comments = document.getElementById('ea-comments').value.trim();
    const customName = readCustomActivityName('ea');
    if (name === OTHER_ACTIVITY && !customName) {
      showToast('Type a name for this activity', 'red');
      return;
    }
    // Merge onto the existing activity_properties rather than replacing it
    // outright — anything computed elsewhere and not rendered as a form
    // field here (e.g. ratoon_number/expected_germination_date, stamped in
    // by the webmap's Planting/Harvesting write-back) should survive an
    // edit made from the dashboard.
    const properties = { ...((a && a.properties) || {}) };
    document.querySelectorAll('#ea-props-wrap [data-prop-key]').forEach(el => {
      const key = el.dataset.propKey;
      const v = (el.value ?? '').trim();
      if (v !== '') properties[key] = v; else delete properties[key];
    });
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_activities').update({
        activity_name: name, activity_date: date, team_size: team || null,
        // Always sent, so switching an activity's type away from 'Other'
        // clears the stale one-off name instead of leaving the pair
        // contradicting each other (the check constraint would refuse it).
        custom_activity_name: name === OTHER_ACTIVITY ? customName : null,
        completion_value: completion || null, area_covered_acres: areaCovered || null,
        comments: comments || null,
        activity_properties: properties,
      }).eq('id', id);
      if (error) throw error;
      closeModal();
      showToast('Activity updated');
      await retryLiveDataLoad();
      renderTabIfCurrent('activities');
    } catch (err) {
      console.error(err);
      showToast('Failed to update activity: ' + err.message, 'red');
    }
  };

  window.confirmDeleteActivity = function(id) {
    showModal(`
      <div class="modal-title">Delete Activity</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">Delete this activity record? This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="submitDeleteActivity('${id}')">Yes, Delete</button>
      </div>`);
  };

  window.submitDeleteActivity = async function(id) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_activities').delete().eq('id', id);
      if (error) throw error;
      closeModal();
      showToast('Activity deleted', 'red');
      await retryLiveDataLoad();
      renderTabIfCurrent('activities');
    } catch (err) {
      console.error(err);
      showToast('Failed to delete activity: ' + err.message, 'red');
    }
  };

// Re-render a page only if it's still the one currently on screen (avoids clobbering
// the user's view if they navigated away while an async save was in flight).
function renderTabIfCurrent(page) {
  if (currentPage === page) openPanel(page, document.querySelector('.nav-item.active'));
}

// ══════════════════════════════════════
//  PAGE: COSTS
// ══════════════════════════════════════

const COST_TYPES = ['Land Prep','Planting','Inputs','Labour','Irrigation','Harvest','Transport','Other'];

function renderCosts(el) {
  let estFilter = '';
  const rows = () => DATA.costs.filter(c => !estFilter || c.estate === estFilter);
  const totalCost = () => rows().reduce((s,c) => s + c.amount, 0);
  const byType = () => {
    const m = {};
    rows().forEach(c => { m[c.costType] = (m[c.costType]||0) + c.amount; });
    return m;
  };

  function table() {
    const r = rows();
    return `<div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Activity</th><th>Type</th><th>Estate</th><th>Block</th><th>Plot</th><th>Amount</th><th>Actions</th></tr></thead>
      <tbody>${r.length ? r.map(c=>`
        <tr>
          <td>${c.createdAt ? c.createdAt.slice(0,10) : '—'}</td>
          <td>${c.activityName}</td>
          <td>${pill(c.costType,'blue')}</td>
          <td>${c.estate}</td><td>${c.block}</td><td>${c.parcel}</td>
          <td><strong>${fmtUGX(c.amount)}</strong></td>
          <td><button class="icon-btn danger" onclick="confirmDeleteCost('${c.id}')" title="Delete">🗑</button></td>
        </tr>`).join('') : `<tr><td colspan="8" style="text-align:center;color:var(--gray-500);padding:24px">No cost entries yet</td></tr>`}
      </tbody></table></div>`;
  }

  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">Costs</div>
    <div class="page-header-sub">${DATA.costs.length} entries logged against activities${DATA.isLive ? '' : ' · placeholder data'}</div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <select class="form-input" style="width:160px" id="cost-estate-filter" onchange="filterCostsEstate(this.value)">
        <option value="">All Estates</option>
        ${DATA.estates.map(e=>`<option>${e.name}</option>`).join('')}
      </select>
      <button class="btn btn-outline btn-sm btn-header-action" onclick="showAddCostModal()">+ Log New</button>
      <button class="btn btn-primary btn-xl btn-header-action" onclick="showAddCostFromActivityModal()">+ Log From Activity</button>
    </div>
  </div>
  <div class="grid-4">
    <div class="stat-card red"><div class="stat-label">Total Cost</div><div class="stat-value" style="font-size:20px">${fmtUGX(totalCost())}</div></div>
    <div class="stat-card amber"><div class="stat-label">Entries</div><div class="stat-value">${rows().length}</div></div>
    <div class="stat-card blue"><div class="stat-label">Cost / Planted Ac</div><div class="stat-value" style="font-size:20px">${DATA.stats.plantedAreaHa ? fmtUGX(Math.round(totalCost()/(DATA.stats.plantedAreaHa*2.47105))) : '—'}</div></div>
    <div class="stat-card green"><div class="stat-label">Top Category</div><div class="stat-value" style="font-size:16px">${(() => { const bt = byType(); const k = Object.keys(bt).sort((a,b)=>bt[b]-bt[a])[0]; return k || '—'; })()}</div></div>
  </div>
  <div class="card" id="costs-table">${table()}</div>`;

  window.filterCostsEstate = function(val) { estFilter = val; document.getElementById('costs-table').innerHTML = table(); };

  // "Log New" — a standalone cost entry with no activity/plot link at all
  // (general estate overheads, admin costs, etc). This used to have an
  // "optional" Related Activity dropdown bolted on, which mixed two
  // different workflows into one form; that dropdown moved to its own
  // "Log From Activity" flow below, which requires an activity and gives
  // you Estate/Block/Plot filters to find it instead of one flat list of
  // every activity ever logged.
  window.showAddCostModal = function() {
    showModal(`
      <div class="modal-title">Log New Cost</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Cost Type</label>
          <select class="form-input" id="ac-type">${COST_TYPES.map(t=>`<option>${t}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Amount (UGX)</label><input class="form-input" id="ac-amount" type="number" min="0"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Description</label><input class="form-input" id="ac-desc" placeholder="Optional note"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddCost()">Save Cost</button>
      </div>`);
  };

  window.submitAddCost = async function() {
    const costType = document.getElementById('ac-type').value;
    const amount = document.getElementById('ac-amount').value;
    const desc = document.getElementById('ac-desc').value.trim();
    if (!amount || Number(amount) <= 0) { showToast('Enter a valid amount', 'red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_activity_costs').insert([{
        activity_id: null, cost_type: costType, amount,
        description: desc || null, block_id: null, parcel_id: null,
      }]);
      if (error) throw error;
      closeModal();
      showToast('Cost logged');
      await retryLiveDataLoad();
      renderTabIfCurrent('costs');
    } catch (err) {
      console.error(err);
      showToast('Failed to log cost: ' + err.message, 'red');
    }
  };

  // "Log From Activity" — Estate → Block → Plot narrows down which
  // activities show up in the Activity dropdown (DATA.activities can run
  // into the hundreds, so picking straight from one flat list was painful);
  // an activity is required here, and its block/plot get carried onto the
  // cost row same as before.
  window.showAddCostFromActivityModal = function() {
    showModal(`
      <div class="modal-title">Log Cost From Activity</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Estate</label>
          <select class="form-input" id="acfa-estate" onchange="onCostActivityEstateChange()">
            <option value="">— All Estates —</option>
            ${DATA.estates.map(e=>`<option value="${e.name}">${e.name}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Block</label>
          <select class="form-input" id="acfa-block" onchange="onCostActivityBlockChange()">
            <option value="">— All Blocks —</option>
            ${DATA.blocks.map(b=>`<option value="${b._uuid}">${b.name || b.id} (${b.estate})</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Plot</label>
          <select class="form-input" id="acfa-plot" onchange="onCostActivityFilterChange()">
            <option value="">— All Plots —</option>
            ${DATA.plots.map(p=>`<option value="${p._uuid}">${p.parcelName || p.id}</option>`).join('')}
          </select></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Activity *</label>
        <select class="form-input" id="acfa-activity">${costActivityOptionsHTML()}</select></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Cost Type</label>
          <select class="form-input" id="acfa-type">${COST_TYPES.map(t=>`<option>${t}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Amount (UGX)</label><input class="form-input" id="acfa-amount" type="number" min="0"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Description</label><input class="form-input" id="acfa-desc" placeholder="Optional note"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddCostFromActivity()">Save Cost</button>
      </div>`);
  };

  function costActivityOptionsHTML() {
    const estName = document.getElementById('acfa-estate')?.value || '';
    const blockId = document.getElementById('acfa-block')?.value || '';
    const plotId = document.getElementById('acfa-plot')?.value || '';
    const filtered = DATA.activities.filter(a =>
      (!estName || a.estate === estName) &&
      (!blockId || a._blockId === blockId) &&
      (!plotId || a._parcelId === plotId));
    if (!filtered.length) return `<option value="">— No matching activities —</option>`;
    return `<option value="">— Select an activity —</option>` +
      filtered.map(a=>`<option value="${a.id}">${a.name} — ${a.estate}${a.parcel && a.parcel!=='—' ? ' · '+a.parcel : ''} ${a.date?('· '+a.date):''}</option>`).join('');
  }
  window.onCostActivityEstateChange = function() {
    const estName = document.getElementById('acfa-estate').value;
    const blockSel = document.getElementById('acfa-block');
    blockSel.innerHTML = `<option value="">— All Blocks —</option>` +
      DATA.blocks.filter(b => !estName || b.estate === estName).map(b=>`<option value="${b._uuid}">${b.name || b.id}</option>`).join('');
    document.getElementById('acfa-plot').innerHTML = `<option value="">— All Plots —</option>` +
      DATA.plots.filter(p => !estName || p.estate === estName).map(p=>`<option value="${p._uuid}">${p.parcelName || p.id}</option>`).join('');
    onCostActivityFilterChange();
  };
  window.onCostActivityBlockChange = function() {
    const blockId = document.getElementById('acfa-block').value;
    document.getElementById('acfa-plot').innerHTML = `<option value="">— All Plots —</option>` +
      DATA.plots.filter(p => !blockId || p._blockUuid === blockId).map(p=>`<option value="${p._uuid}">${p.parcelName || p.id}</option>`).join('');
    onCostActivityFilterChange();
  };
  window.onCostActivityFilterChange = function() {
    const activitySel = document.getElementById('acfa-activity');
    if (activitySel) activitySel.innerHTML = costActivityOptionsHTML();
  };

  window.submitAddCostFromActivity = async function() {
    const activityId = document.getElementById('acfa-activity').value;
    const costType = document.getElementById('acfa-type').value;
    const amount = document.getElementById('acfa-amount').value;
    const desc = document.getElementById('acfa-desc').value.trim();
    if (!activityId) { showToast('Select an activity', 'red'); return; }
    if (!amount || Number(amount) <= 0) { showToast('Enter a valid amount', 'red'); return; }
    try {
      const client = getSbClient();
      const activity = DATA.activities.find(a => a.id === activityId);
      const { error } = await client.from('vsl_activity_costs').insert([{
        activity_id: activityId, cost_type: costType, amount,
        description: desc || null,
        block_id: activity ? activity._blockId : null,
        parcel_id: activity ? activity._parcelId : null,
      }]);
      if (error) throw error;
      closeModal();
      showToast('Cost logged');
      await retryLiveDataLoad();
      renderTabIfCurrent('costs');
    } catch (err) {
      console.error(err);
      showToast('Failed to log cost: ' + err.message, 'red');
    }
  };

  window.confirmDeleteCost = function(id) {
    showModal(`
      <div class="modal-title">Delete Cost Entry</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">Delete this cost entry? This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="submitDeleteCost('${id}')">Yes, Delete</button>
      </div>`);
  };

  window.submitDeleteCost = async function(id) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_activity_costs').delete().eq('id', id);
      if (error) throw error;
      closeModal();
      showToast('Cost entry deleted', 'red');
      await retryLiveDataLoad();
      renderTabIfCurrent('costs');
    } catch (err) {
      console.error(err);
      showToast('Failed to delete cost entry: ' + err.message, 'red');
    }
  };
}

// ══════════════════════════════════════
//  PAGE: DOCUMENTS & MEDIA
// ══════════════════════════════════════

function renderDocuments(el) {
  let activeTab = 'documents';

  function docsTable() {
    return `<div class="table-wrap"><table>
      <thead><tr><th>Title</th><th>Type</th><th>Linked To</th><th>Uploaded</th><th>Link</th><th>Actions</th></tr></thead>
      <tbody>${DATA.documents.length ? DATA.documents.map(d=>`
        <tr>
          <td><strong>${d.title}</strong>${d.description ? `<br><span style="font-size:11px;color:var(--gray-500)">${d.description}</span>` : ''}</td>
          <td>${pill(d.docType,'blue')}</td>
          <td>${entityTypeLabel(d.entityType)}: ${d.entityLabel}</td>
          <td>${d.uploadDate || '—'}</td>
          <td>${d.fileUrl ? `<a href="${d.fileUrl}" target="_blank" rel="noopener">Open ↗</a>` : '—'}</td>
          <td><button class="icon-btn danger" onclick="confirmDeleteDocument('${d.id}')" title="Delete">🗑</button></td>
        </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--gray-500);padding:24px">No documents yet</td></tr>`}
      </tbody></table></div>`;
  }
  function mediaTable() {
    return `<div class="table-wrap"><table>
      <thead><tr><th>Caption</th><th>Type</th><th>Linked To</th><th>Captured</th><th>Link</th><th>Actions</th></tr></thead>
      <tbody>${DATA.media.length ? DATA.media.map(m=>`
        <tr>
          <td>${m.caption || '—'}</td>
          <td>${pill(m.mediaType,'green')}</td>
          <td>${entityTypeLabel(m.entityType)}: ${m.entityLabel}</td>
          <td>${m.capturedAt ? m.capturedAt.replace('T',' ').slice(0,16) : '—'}</td>
          <td>${m.fileUrl ? `<a href="${m.fileUrl}" target="_blank" rel="noopener">Open ↗</a>` : '—'}</td>
          <td><button class="icon-btn danger" onclick="confirmDeleteMedia('${m.id}')" title="Delete">🗑</button></td>
        </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--gray-500);padding:24px">No media yet</td></tr>`}
      </tbody></table></div>`;
  }

  function renderTab() {
    document.getElementById('docmedia-content').innerHTML = activeTab === 'documents' ? docsTable() : mediaTable();
  }

  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">Documents &amp; Media</div>
    <div class="page-header-sub">${DATA.documents.length} documents · ${DATA.media.length} media files</div></div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary btn-xl btn-header-action" onclick="showAddDocumentModal()">+ Add Document</button>
      <button class="btn btn-outline btn-sm btn-header-action" onclick="showAddMediaModal()">+ Add Media</button>
    </div>
  </div>
  <div class="tab-bar">
    <button class="tab-btn active" data-tab="documents" onclick="switchDocMediaTab('documents',this)">Documents (${DATA.documents.length})</button>
    <button class="tab-btn" data-tab="media" onclick="switchDocMediaTab('media',this)">Media (${DATA.media.length})</button>
  </div>
  <div class="card" id="docmedia-content">${docsTable()}</div>`;

  window.switchDocMediaTab = function(tab, btn) {
    activeTab = tab;
    document.querySelectorAll('.tab-bar .tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    renderTab();
  };

  function entityPickerHTML(prefix) {
    return `
      <div class="form-group"><label class="form-label">Linked To</label>
        <select class="form-input" id="${prefix}-entity-type" onchange="onEntityTypeChange('${prefix}')">
          <option value="estate">Estate</option><option value="block">Block</option><option value="parcel">Plot</option>
        </select></div>
      <div class="form-group"><label class="form-label">&nbsp;</label>
        <select class="form-input" id="${prefix}-entity-id"></select></div>`;
  }
  window.onEntityTypeChange = function(prefix) {
    const type = document.getElementById(`${prefix}-entity-type`).value;
    const sel = document.getElementById(`${prefix}-entity-id`);
    if (type === 'estate') sel.innerHTML = DATA.estates.map(e=>`<option value="${e._id}">${e.name}</option>`).join('');
    else if (type === 'block') sel.innerHTML = DATA.blocks.map(b=>`<option value="${b._uuid}">${b.name || b.id} (${b.estate})</option>`).join('');
    else sel.innerHTML = DATA.plots.map(p=>`<option value="${p._uuid}">${p.parcelName || p.id}</option>`).join('');
  };

  window.showAddDocumentModal = function() {
    showModal(`
      <div class="modal-title">Add Document</div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Title</label><input class="form-input" id="ad-title" placeholder="e.g. Land Title Deed"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Document Type</label><input class="form-input" id="ad-type" placeholder="e.g. Title, Survey Plan"></div>
        <div class="form-group"><label class="form-label">File URL</label><input class="form-input" id="ad-url" placeholder="https://..."></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">${entityPickerHTML('ad')}</div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Description</label><textarea class="form-input" id="ad-desc" rows="2"></textarea></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddDocument()">Save Document</button>
      </div>`);
    onEntityTypeChange('ad');
  };

  window.submitAddDocument = async function() {
    const title = document.getElementById('ad-title').value.trim();
    const docType = document.getElementById('ad-type').value.trim();
    const url = document.getElementById('ad-url').value.trim();
    const entityType = document.getElementById('ad-entity-type').value;
    const entityId = document.getElementById('ad-entity-id').value;
    const desc = document.getElementById('ad-desc').value.trim();
    if (!title || !url) { showToast('Title and file URL are required', 'red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_documents').insert([{
        document_title: title, doc_type: docType || null, file_url: url,
        entity_type: entityType, entity_id: String(entityId), description: desc || null,
      }]);
      if (error) throw error;
      closeModal();
      showToast('Document added');
      await retryLiveDataLoad();
      renderTabIfCurrent('documents');
    } catch (err) {
      console.error(err);
      showToast('Failed to add document: ' + err.message, 'red');
    }
  };

  window.confirmDeleteDocument = function(id) {
    showModal(`
      <div class="modal-title">Delete Document</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">Delete this document record? This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="submitDeleteDocument('${id}')">Yes, Delete</button>
      </div>`);
  };
  window.submitDeleteDocument = async function(id) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_documents').delete().eq('id', id);
      if (error) throw error;
      closeModal();
      showToast('Document deleted', 'red');
      await retryLiveDataLoad();
      renderTabIfCurrent('documents');
    } catch (err) {
      console.error(err);
      showToast('Failed to delete document: ' + err.message, 'red');
    }
  };

  window.showAddMediaModal = function() {
    showModal(`
      <div class="modal-title">Add Media</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Media Type</label>
          <select class="form-input" id="am-type"><option value="photo">Photo</option><option value="video">Video</option></select></div>
        <div class="form-group"><label class="form-label">File URL</label><input class="form-input" id="am-url" placeholder="https://..."></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">${entityPickerHTML('am')}</div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Caption</label><input class="form-input" id="am-caption"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddMedia()">Save Media</button>
      </div>`);
    onEntityTypeChange('am');
  };

  window.submitAddMedia = async function() {
    const mediaType = document.getElementById('am-type').value;
    const url = document.getElementById('am-url').value.trim();
    const entityType = document.getElementById('am-entity-type').value;
    const entityId = document.getElementById('am-entity-id').value;
    const caption = document.getElementById('am-caption').value.trim();
    if (!url) { showToast('File URL is required', 'red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_media').insert([{
        media_type: mediaType, file_url: url,
        entity_type: entityType, entity_id: String(entityId), caption: caption || null,
      }]);
      if (error) throw error;
      closeModal();
      showToast('Media added');
      await retryLiveDataLoad();
      renderTabIfCurrent('documents');
    } catch (err) {
      console.error(err);
      showToast('Failed to add media: ' + err.message, 'red');
    }
  };

  window.confirmDeleteMedia = function(id) {
    showModal(`
      <div class="modal-title">Delete Media</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">Delete this media record? This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="submitDeleteMedia('${id}')">Yes, Delete</button>
      </div>`);
  };
  window.submitDeleteMedia = async function(id) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_media').delete().eq('id', id);
      if (error) throw error;
      closeModal();
      showToast('Media deleted', 'red');
      await retryLiveDataLoad();
      renderTabIfCurrent('documents');
    } catch (err) {
      console.error(err);
      showToast('Failed to delete media: ' + err.message, 'red');
    }
  };
}

// ══════════════════════════════════════
//  PAGE: MESSAGES (stub — DB table & delivery logic coming later)
// ══════════════════════════════════════

function renderMessages(el) {
  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">Messages</div>
    <div class="page-header-sub">Broadcast messages to users of the map/dashboard</div></div>
  </div>
  <div class="card">
    <div class="card-header"><div class="card-title">Coming Soon</div></div>
    <p style="font-size:13px;color:var(--gray-600);line-height:1.6">
      This section will let an admin write, edit and delete short messages/announcements shown to users
      inside the webmap and dashboard (e.g. maintenance notices, season updates). The database table and
      delivery logic haven't been built yet — this page is a placeholder for that upcoming feature.
      <span class="placeholder-tag">Planned</span>
    </p>
  </div>`;
}

// ══════════════════════════════════════
//  PAGE: USERS
// ══════════════════════════════════════

// Real permission roles, per vsl_profiles' check constraint / RLS policies.
// NB: the stored value stays "MANAGMENT" (misspelled, per the DB check
// constraint and RLS); only the label people see says "Manager".
const ROLE_LABEL_MAP = { ADMIN: 'Admin', MANAGMENT: 'Manager', SURVEYOR: 'Surveyor' };
const ROLE_COLOR_MAP = { Admin: 'red', Surveyor: 'blue', Manager: 'green' };
const DEFAULT_NEW_USER_ROLE = 'MANAGMENT';

// Where invitation / reset emails send people: <app root>/set-password.html
// (the dashboard lives in /dashboard/, so go one level up).
function setPasswordUrl() {
  return new URL('../set-password.html', window.location.href).href;
}

// Call the vsl-admin-users Edge Function with the current admin's session token.
async function callAdminUsersFn(action, payload) {
  const client = getSbClient();
  const { data: sess } = await client.auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) throw new Error('You must be signed in.');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/vsl-admin-users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ action, ...payload }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

function renderUsers(el) {
  if (viewingUserId) {
    el.innerHTML = buildUserDetail(viewingUserId);
    window.clearUserDetail = function() { viewingUserId = null; renderTabIfCurrent('users'); };
    return;
  }

  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">User Management</div></div>
    <button class="btn btn-primary btn-xl btn-header-action" onclick="showAddUserModal()">+ Add User</button>
  </div>
  <div class="grid-4">
    ${[['Total Users',DATA.users.length,'blue'],
       ['Admins',DATA.users.filter(u=>u.roleRaw==='ADMIN').length,'red'],
       ['Active',DATA.users.filter(u=>u.status==='active').length,'green'],
       ['Inactive',DATA.users.filter(u=>u.status==='inactive').length,'amber']].map(([l,v,c])=>`
      <div class="stat-card ${c}"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`).join('')}
  </div>
  <div class="card">
    <div class="card-header"><div class="card-title">All Users</div>
      <div class="users-filter-row">
        <select class="form-input users-filter-role" onchange="filterUsersByRole(this.value)">
          <option value="">All Roles</option>
          ${Object.values(ROLE_LABEL_MAP).map(r=>`<option>${r}</option>`).join('')}
        </select>
        <input class="form-input users-filter-search" placeholder="Search users..."
               oninput="filterUsers(this.value)">
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>User</th><th>Role</th><th>Title</th><th>Estate</th><th>Status</th><th>Last Login</th><th>Actions</th></tr></thead>
        <tbody id="users-tbody">
          ${DATA.users.map(u=>`
            <tr data-role="${u.role}" style="cursor:pointer" onclick="viewUserDetail('${u.id}')">
              <td><div class="user-info">
                ${avatarHTML(u.name, u.avatarUrl, 32)}
                <div><div class="user-name">${u.name}</div><div class="user-email">${u.email}</div></div>
              </div></td>
              <td>${pill(u.role,ROLE_COLOR_MAP[u.role]||'gray')}</td>
              <td style="font-size:12px;color:var(--gray-500)">${u.title || '—'}</td>
              <td>${u.estate}</td>
              <td>${pill(u.status==='active'?'Active':'Inactive',u.status==='active'?'green':'gray')}</td>
              <td style="font-size:12px;color:var(--gray-500)">${u.lastLogin === '—' ? '<span class="invite-pending">Not signed in yet</span>' : u.lastLogin}</td>
              <td onclick="event.stopPropagation()"><div style="display:flex;gap:4px;flex-wrap:wrap">
                ${!isSelf(u.id) ? `<button class="icon-btn" onclick="showEditEmailModal('${u.id}')" title="Edit Email / Resend Link" aria-label="Edit Email / Resend Link"><i class="fas fa-envelope" aria-hidden="true"></i></button>` : ''}
                <button class="icon-btn" onclick="showEditUserModal('${u.id}')" title="Edit">✎</button>
                ${isSelf(u.id) ? '' : u.status==='active'
                  ? `<button class="icon-btn" onclick="toggleUserActive('${u.id}',false)" title="Deactivate">⏸</button>`
                  : `<button class="icon-btn primary" onclick="toggleUserActive('${u.id}',true)" title="Reactivate">▶</button>`}
                ${isSelf(u.id) ? '' : `<button class="icon-btn danger" onclick="confirmDeleteUser('${u.id}','${u.name}')" title="Delete">🗑</button>`}
              </div></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="font-size:12px;color:var(--gray-500);margin-top:10px">
      💡 Click any user row to view full profile details
    </div>
  </div>`;

  window.viewUserDetail = function(id) { viewingUserId = id; renderTabIfCurrent('users'); };

  window.filterUsers = function(val) {
    document.querySelectorAll('#users-tbody tr').forEach(r=>{
      r.style.display = r.textContent.toLowerCase().includes(val.toLowerCase()) ? '' : 'none';
    });
  };
  window.filterUsersByRole = function(val) {
    document.querySelectorAll('#users-tbody tr').forEach(r=>{
      r.style.display = (!val||r.dataset.role===val) ? '' : 'none';
    });
  };

  function estateOptions(selectedId) {
    return `<option value="">All Estates</option>` +
      DATA.estates.map(e=>`<option value="${e._id}" ${String(e._id)===String(selectedId)?'selected':''}>${e.name}</option>`).join('');
  }

  window.showAddUserModal = function() {
    showModal(`
      <div class="modal-title">Add New User</div>
      <div class="form-row-2">
        <div class="form-group"><label class="form-label">Full Name *</label><input class="form-input" id="au-name" placeholder="e.g. Jane Doe" required></div>
        <div class="form-group"><label class="form-label">Email *</label><input class="form-input" id="au-email" type="email" placeholder="user@example.com" required></div>
      </div>
      <div class="form-row-2">
        <div class="form-group"><label class="form-label">Role *</label>
          <select class="form-input" id="au-role">${Object.entries(ROLE_LABEL_MAP).map(([k,v])=>`<option value="${k}" ${k===DEFAULT_NEW_USER_ROLE?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Phone *</label><input class="form-input" id="au-phone" placeholder="07XXXXXXXX" required></div>
      </div>
      <div class="form-row-2">
        <div class="form-group"><label class="form-label">Title / Position <span class="form-label-note">(display only)</span></label>
          <input class="form-input" id="au-title" placeholder="e.g. Field Officer, Agronomist"></div>
        <div class="form-group"><label class="form-label">Home Estate</label>
          <select class="form-input" id="au-estate">${estateOptions('')}</select></div>
      </div>
      <p class="modal-footnote">* Required</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="au-submit" onclick="submitAddUser()"><i class="fas fa-paper-plane" aria-hidden="true"></i> Send Invitation</button>
      </div>`);
  };

  // Validates the Add User form and returns the values, or null (after a
  // toast) if something is missing.
  function readAddUserForm() {
    const v = {
      full_name: document.getElementById('au-name').value.trim(),
      email: document.getElementById('au-email').value.trim(),
      role: document.getElementById('au-role').value,
      title: document.getElementById('au-title').value.trim(),
      phone: document.getElementById('au-phone').value.trim(),
      estate_id: document.getElementById('au-estate').value || null,
    };
    // Full Name, Email, Role, and Phone are all required. There is no password
    // here on purpose — the invited user sets their own from the email link.
    if (!v.full_name) { showToast('Full Name is required','red'); return null; }
    if (!v.email || !/^[^@]+@[^@]+\.[^@]+$/.test(v.email)) { showToast('Please enter a valid email','red'); return null; }
    if (!v.role) { showToast('Role is required','red'); return null; }
    if (!v.phone) { showToast('Phone is required','red'); return null; }
    return v;
  }

  // Add User → (Admin only) confirm window → send. Creating an Admin hands
  // over full dashboard rights, so it needs an explicit second yes.
  let pendingNewUser = null;
  window.submitAddUser = async function() {
    const v = readAddUserForm();
    if (!v) return;
    if (v.role === 'ADMIN') { showConfirmAdminModal(v); return; }
    await sendInvitation(v);
  };

  function showConfirmAdminModal(v) {
    pendingNewUser = v;
    const safeEmail = v.email.replace(/[<>&"]/g, '');
    showModal(`
      <div class="modal-title">Create Admin User?</div>
      <div class="modal-note danger"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i>
        <span>You are attempting to create an <strong>Admin</strong> user, <strong>${safeEmail}</strong>. This user will be able to:</span></div>
      <ol class="modal-warning-list">
        <li>Access this dashboard</li>
        <li>Create, edit, deactivate and delete users</li>
        <li>Use all admin rights across the system</li>
      </ol>
      <p class="modal-text">Are you sure you want to continue? An invitation link will still be sent to this email so they can set their own password.</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="cancelConfirmAdmin()">Go Back</button>
        <button class="btn btn-danger" id="au-confirm-admin" onclick="confirmCreateAdmin()">Yes, Create Admin</button>
      </div>`);
  }
  // Going back re-opens the form with what they'd typed.
  window.cancelConfirmAdmin = function() {
    const v = pendingNewUser;
    showAddUserModal();
    if (!v) return;
    document.getElementById('au-name').value = v.full_name;
    document.getElementById('au-email').value = v.email;
    document.getElementById('au-role').value = v.role;
    document.getElementById('au-phone').value = v.phone;
    document.getElementById('au-title').value = v.title;
    document.getElementById('au-estate').value = v.estate_id || '';
  };
  window.confirmCreateAdmin = async function() {
    if (!pendingNewUser) return;
    const btn = document.getElementById('au-confirm-admin');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    await sendInvitation(pendingNewUser, 'au-confirm-admin');
  };

  async function sendInvitation(v, btnId) {
    const btn = document.getElementById(btnId || 'au-submit');
    const resetLabel = btnId ? 'Yes, Create Admin' : '<i class="fas fa-paper-plane" aria-hidden="true"></i> Send Invitation';
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      await callAdminUsersFn('invite', { ...v, redirect_to: setPasswordUrl() });
      pendingNewUser = null;
      await retryLiveDataLoad();
      renderTabIfCurrent('users');
      showInviteSentModal(v.full_name, v.email);
    } catch (err) {
      console.error(err);
      if (btn) { btn.disabled = false; btn.innerHTML = resetLabel; }
      showToast('Failed to invite user: ' + err.message, 'red');
    }
  }

  // Confirmation window after an invite goes out.
  function showInviteSentModal(name, email) {
    showModal(`
      <div class="modal-title">Invitation Sent</div>
      <div style="text-align:center;padding:6px 0 4px">
        <div style="width:54px;height:54px;border-radius:50%;background:var(--green-50);color:var(--green-700);display:flex;align-items:center;justify-content:center;font-size:22px;margin:0 auto 12px"><i class="fas fa-envelope-circle-check" aria-hidden="true"></i></div>
        <p style="font-size:14px;color:var(--gray-700);margin-bottom:6px"><strong>${name}</strong> has been invited.</p>
        <p style="font-size:13px;color:var(--gray-500)">An email with a secure link was sent to <strong>${email}</strong>. Their account becomes usable once they open it and choose a password.</p>
      </div>
      <div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">Done</button></div>`);
  }

  // Resend the invitation (or, for someone who already set a password, a
  // "choose a new password" link) — both land on set-password.html.
  // Edit Email / Resend Link: one window for two jobs. Leave the email as it
  // is to just resend the link; change it to move the account to a new
  // address — either way a link to set-password.html is sent to that address.
  window.showEditEmailModal = function(id) {
    const u = DATA.users.find(x => x.id === id); if (!u) return;
    const safeName = String(u.name || '').replace(/[<>&"]/g, '');
    showModal(`
      <div class="modal-title">Edit Email / Resend Link</div>
      <p class="modal-text">Update <strong>${safeName}</strong>'s email address, or keep it and just resend the link.</p>
      <div class="form-group form-group-tight"><label class="form-label" for="ee-email">Email</label>
        <input class="form-input" id="ee-email" type="email" autocomplete="off"></div>
      <div class="modal-note info"><i class="fas fa-circle-info" aria-hidden="true"></i>
        <span>A link to set their password is sent to this address. Any earlier link stops working.</span></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="ee-submit" onclick="submitEditEmail('${u.id}')"><i class="fas fa-paper-plane" aria-hidden="true"></i> Save &amp; Send Link</button>
      </div>`);
    // Set via the DOM so odd characters in an address can't break the markup.
    document.getElementById('ee-email').value = u.email || '';
  };
  window.submitEditEmail = async function(id) {
    const u = DATA.users.find(x => x.id === id); if (!u) return;
    const email = document.getElementById('ee-email').value.trim();
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) { showToast('Please enter a valid email', 'red'); return; }
    const btn = document.getElementById('ee-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      const res = await callAdminUsersFn('change_email', { id, email, redirect_to: setPasswordUrl() });
      closeModal();
      showToast(res.changed ? 'Email updated — link sent to ' + email : 'Link sent to ' + email);
      if (res.changed) { await retryLiveDataLoad(); renderTabIfCurrent('users'); }
    } catch (err) {
      console.error(err);
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane" aria-hidden="true"></i> Save &amp; Send Link'; }
      showToast('Failed: ' + err.message, 'red');
    }
  };

  window.showEditUserModal = function(id) {
    const u = DATA.users.find(x=>x.id===id); if (!u) return;
    const self = isSelf(u.id);
    showModal(`
      <div class="modal-title">${self ? 'Edit Profile' : 'Edit User — ' + u.name}</div>
      ${self ? `
      <div class="profile-photo-edit">
        <div class="profile-photo-edit__circle" id="eu-photo-circle">${avatarHTML(u.name, u.avatarUrl, 96)}</div>
        <input class="form-input profile-photo-edit__input" id="eu-photo" type="file" accept="image/*" aria-label="Profile photo">
      </div>` : ''}
      <div class="form-row-2">
        <div class="form-group"><label class="form-label">Full Name</label><input class="form-input" id="eu-name" value="${u.name}"></div>
        <div class="form-group"><label class="form-label">Role</label>
          <div class="${self ? 'role-field role-field--locked' : 'role-field'}">
            <select class="form-input" id="eu-role" ${self ? 'disabled' : ''}>${Object.entries(ROLE_LABEL_MAP).map(([k,v])=>`<option value="${k}" ${k===u.roleRaw?'selected':''}>${v}</option>`).join('')}</select>
            ${self ? '<div class="role-lock-hint">You can\'t change your own role.</div>' : ''}
          </div></div>
      </div>
      <div class="form-row-2">
        <div class="form-group"><label class="form-label">Title / Position</label><input class="form-input" id="eu-title" value="${u.title||''}"></div>
        <div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="eu-phone" value="${u.phone||''}"></div>
      </div>
      <div class="form-group form-group-tight"><label class="form-label">Home Estate</label>
        <select class="form-input" id="eu-estate">${estateOptions(u.estateId)}</select></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitEditUser('${u.id}')">Save Changes</button>
      </div>`);
    if (self) wireProfilePhotoPreview('eu-photo', 'eu-photo-circle');
  };

  // Shows the picked image in the circle straight away (it's only uploaded
  // when Save Changes is pressed).
  function wireProfilePhotoPreview(inputId, circleId) {
    const input = document.getElementById(inputId);
    const circle = document.getElementById(circleId);
    if (!input || !circle) return;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const img = document.createElement('img');
        img.className = 'profile-photo-edit__img';
        img.alt = 'Selected profile photo';
        img.src = reader.result;
        circle.replaceChildren(img);
      };
      reader.readAsDataURL(file);
    });
  }

  window.submitEditUser = async function(id) {
    const full_name = document.getElementById('eu-name').value.trim();
    // Never take your own role from the form — it's locked in the UI, and
    // this keeps it locked even if the field were re-enabled in devtools.
    const existing = DATA.users.find(x => x.id === id);
    const role = isSelf(id) && existing ? existing.roleRaw : document.getElementById('eu-role').value;
    const title = document.getElementById('eu-title').value.trim();
    const phone = document.getElementById('eu-phone').value.trim();
    const estate_id = document.getElementById('eu-estate').value || null;
    try {
      const payload = { id, full_name, role, title, phone, estate_id };
      // Only your own profile has the photo picker.
      const photoInput = document.getElementById('eu-photo');
      const photoFile = photoInput && photoInput.files ? photoInput.files[0] : null;
      if (photoFile) payload.avatar_url = await uploadAvatarFile(photoFile);
      await callAdminUsersFn('update', payload);
      closeModal();
      showToast('User updated successfully');
      await retryLiveDataLoad();
      renderTabIfCurrent('users');
    } catch (err) {
      console.error(err);
      showToast('Failed to update user: ' + err.message, 'red');
    }
  };

  window.toggleUserActive = async function(id, activate) {
    try {
      await callAdminUsersFn(activate ? 'reactivate' : 'deactivate', { id });
      showToast(activate ? 'User reactivated' : 'User deactivated');
      await retryLiveDataLoad();
      renderTabIfCurrent('users');
    } catch (err) {
      console.error(err);
      showToast('Failed: ' + err.message, 'red');
    }
  };

  window.confirmDeleteUser = function(id, name) {
    showModal(`
      <div class="modal-title">Delete User</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">Permanently delete <strong>${name}</strong>'s account? This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="submitDeleteUser('${id}')">Yes, Delete</button>
      </div>`);
  };

  window.submitDeleteUser = async function(id) {
    try {
      await callAdminUsersFn('delete', { id });
      closeModal();
      showToast('User deleted', 'red');
      await retryLiveDataLoad();
      renderTabIfCurrent('users');
    } catch (err) {
      console.error(err);
      showToast('Failed to delete user: ' + err.message, 'red');
    }
  };

  // ── USER DETAIL VIEW (full-page drill-down, same pattern as Plot/Block/Estate detail) ──
  function buildUserDetail(userId) {
    const u = DATA.users.find(x => x.id === userId);
    if (!u) return '<p>User not found.</p>';

    const attrs = [
      ['Email',        u.email],
      ['Role',         pill(u.role, ROLE_COLOR_MAP[u.role] || 'gray')],
      ['Title / Position', u.title || '—'],
      ['Phone',        u.phone || '—'],
      ['Home Estate',  u.estate],
      ['Status',       pill(u.status==='active'?'Active':'Inactive', u.status==='active'?'green':'gray')],
      ['Last Login',   u.lastLogin],
      ['Date Created', u.createdAt ? u.createdAt.replace('T',' ').slice(0,16) : '—'],
      ['User ID',      u.id],
    ];

    return `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-outline btn-sm btn-back-accent" onclick="clearUserDetail()">← Back to Users</button>
      <div style="font-size:13px;color:var(--gray-500)">Full User Profile — <strong>${u.name}</strong></div>
      <div style="margin-left:auto;display:flex;gap:8px">
        ${isSelf(u.id) ? `
        <button class="btn btn-outline btn-sm" onclick="showEditUserModal('${u.id}')">&#9998; Edit Profile</button>
        <button class="btn btn-outline btn-sm" onclick="showChangePasswordModal()">&#128273; Change Password</button>
        <button class="btn btn-danger btn-sm" onclick="confirmLogout()">Log Out</button>` : `
        <button class="btn btn-outline btn-sm" onclick="showEditEmailModal('${u.id}')"><i class="fas fa-envelope" aria-hidden="true"></i> Edit Email / Resend Link</button>
        <button class="btn btn-outline btn-sm" onclick="showEditUserModal('${u.id}')">✏ Edit User</button>
        ${u.status==='active'
          ? `<button class="btn btn-outline btn-sm" onclick="toggleUserActive('${u.id}',false)">⏸ Deactivate</button>`
          : `<button class="btn btn-outline btn-sm" onclick="toggleUserActive('${u.id}',true)">▶ Reactivate</button>`}
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteUser('${u.id}','${(u.name||'').replace(/'/g,"")}')">🗑 Delete</button>
        `}
      </div>
    </div>
    <div class="card" style="margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:16px;padding:8px 4px">
        ${avatarHTML(u.name, u.avatarUrl, 72)}
        <div>
          <div style="font-size:18px;font-weight:700">${u.name}</div>
          <div style="font-size:13px;color:var(--gray-500)">${u.email}</div>
        </div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">All Profile Attributes</div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:40%">Attribute</th><th>Value</th></tr></thead>
          <tbody>
            ${attrs.map(([attr,val],i)=>`
              <tr style="background:${i%2===0?'var(--gray-50)':'var(--white)'}">
                <td style="font-weight:600;color:var(--gray-700);font-size:12px">${attr}</td>
                <td style="color:var(--gray-900);font-size:13px">${val}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  PAGE: EMAIL NOTIFICATIONS
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

function renderNotifications(el) {
  let subscribers = [...DATA.emailSubscribers];

  function estatesLabel(estates) {
    if (!estates || !estates.length || estates.includes('All Estates')) return 'All Estates';
    return estates.join(', ');
  }

  function renderSubList() {
    if (!subscribers.length) return '<div class="empty-state">No subscribers yet.</div>';
    // One flattened row per subscriber — Report Type and Estate(s) are each
    // a single comma-separated summary across that subscriber's enabled
    // reports (the old per-report "Type @ Estate — Frequency" lines were
    // confusing to scan). The fine-grained per-report breakdown is still
    // there to edit, just in the Edit Subscriber modal rather than this list.
    return `<div class="table-wrap"><table>
      <thead><tr><th>Recipient</th><th>Report Type</th><th>Estate(s)</th><th>Last Sent</th><th>Actions</th></tr></thead>
      <tbody>${subscribers.map(s => {
        const active = (s.reports || []).filter(r => r.enabled);
        // Show bundle labels (REPORT_GROUPS), not raw report_type values —
        // a subscriber row created before Land Status and Summary were
        // merged into one bundle still has separate enabled rows for both,
        // and listing them raw would show both names for what is now a
        // single toggle. A group counts as active if any of its underlying
        // types is enabled, matching showEditSubscriberModal's logic.
        const typesLabel = REPORT_GROUPS
          .filter(g => g.types.some(t => active.some(r => r.reportType === t)))
          .map(g => g.label)
          .join(', ');
        const allEstates = active.some(r => (r.estates || []).includes('All Estates'));
        const estateNames = [...new Set(active.flatMap(r => r.estates || []).filter(e => e !== 'All Estates'))];
        const estatesText = allEstates ? 'All Estates' : estateNames.join(', ');
        return `
        <tr id="sub-${s.id}">
          <td>
            <div class="subscriber-cell">
              <div class="user-avatar ua-sm">${s.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}</div>
              <div class="subscriber-identity">
                <div class="user-name">${s.name}</div>
                <div class="user-email">${s.email}</div>
              </div>
            </div>
          </td>
          <td>${active.length ? typesLabel : '<span class="email-off">All reports off</span>'}</td>
          <td>${active.length ? estatesText : '—'}</td>
          <td>${s.lastSent}</td>
          <td>
            <div class="row-icon-actions">
              <button class="icon-btn" onclick="showEditSubscriberModal('${s.id}')" title="Edit">✎</button>
              <button class="icon-btn primary" onclick="sendEmailNow('${s.id}','${s.email}')" title="Send Now">📤</button>
              <button class="icon-btn danger" onclick="confirmRemoveSubscriber('${s.id}')" title="Remove">🗑</button>
            </div>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  }

  // Frequency is no longer admin-settable — each bundle below always goes
  // out on its own fixed cadence, so Add/Edit Subscriber only switches a
  // bundle on/off and picks estates. REPORT_TYPES stays the list of
  // vsl_report_subscriptions.report_type values — one DB row per type,
  // unchanged, so the render/send backend's per-type queries don't need to
  // change. REPORT_GROUPS is the UI-facing grouping: one row per group,
  // each expanding onto one or more REPORT_TYPES rows with that group's
  // fixed frequency baked in (see expandDraftReportsToRows below).
  const REPORT_TYPES = ['Land Status Reports','Activity Reports','Harvests Reports','Summary Report'];
  const REPORT_GROUPS = [
    { key: 'landStatusSummary', label: 'Land status report', frequency: 'Monthly', types: ['Land Status Reports','Summary Report'] },
    { key: 'harvest',           label: 'Harvest Reports',              frequency: 'Weekly',  types: ['Harvests Reports'] },
    { key: 'activity',          label: 'Activity Reports',             frequency: 'Daily',   types: ['Activity Reports'] },
  ];

  // ── DRAFT STATE for the Add/Edit Subscriber modal ──
  // Fixed 3-row toggle table: always exactly one entry per REPORT_GROUPS, in
  // order, so duplicate rows are impossible by construction (there is no
  // add/remove any more). Toggling a row off ("enabled: false") never
  // clears its estates — those are preserved so re-enabling later restores
  // them, and the row is always written to the DB either way (see
  // addSubscriber/submitEditSubscriber below). Frequency isn't part of the
  // draft at all any more — it's fixed per group.
  let draftReports    = [];   // [{ groupKey, enabled, estates: [] }]
  let draftName       = '';
  let draftEmail      = '';
  let draftEditingId  = null; // recipient id when editing, null when adding

  function defaultDraftReports() {
    return REPORT_GROUPS.map(g => ({
      groupKey: g.key,
      enabled: true,
      estates: ['All Estates'],
    }));
  }

  // Expands the 3 UI groups into one DB row per underlying report_type —
  // vsl_report_subscriptions keeps the shape it always had (one row per
  // report_type, with a `frequencies` array), so the fixed frequency just
  // gets baked in here instead of coming from an admin-picked value.
  function expandDraftReportsToRows(recipientId) {
    return draftReports.flatMap(r => {
      const group = REPORT_GROUPS.find(g => g.key === r.groupKey);
      return group.types.map(t => ({
        recipient_id: recipientId,
        report_type: t,
        enabled: r.enabled,
        estates: r.estates,
        frequencies: [group.frequency],
      }));
    });
  }

  function refreshReportsTable(prefix) {
    const tableEl = document.getElementById(`${prefix}-reports-table`);
    if (tableEl) tableEl.innerHTML = reportsTableHTML(prefix);
  }

  function reportsTableHTML(prefix) {
    const rows = draftReports.map((r, idx) => {
      const disabled = !r.enabled;
      const group = REPORT_GROUPS.find(g => g.key === r.groupKey);
      const estateOptions = [
        `<label class="estate-opt"><input type="checkbox" value="All Estates" ${r.estates.includes('All Estates')?'checked':''} ${disabled?'disabled':''} onchange="onEstateOptionToggle('${prefix}',${idx},'All Estates',this.checked)"> All Estates</label>`,
        ...DATA.estates.map(e => `<label class="estate-opt"><input type="checkbox" value="${e.name}" ${r.estates.includes(e.name)?'checked':''} ${disabled?'disabled':''} onchange="onEstateOptionToggle('${prefix}',${idx},'${e.name}',this.checked)"> ${e.name}</label>`),
      ].join('');
      return `
      <div class="report-toggle-row${disabled ? ' is-disabled' : ''}">
        <div class="rtcol-toggle">
          <label class="toggle-switch">
            <input type="checkbox" ${r.enabled?'checked':''} onchange="onReportEnabledToggle('${prefix}',${idx},this.checked)">
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="rtcol-type"><span class="rtr-type-text">${group.label}</span></div>
        <div class="rtcol-estate">
          <details class="estate-multiselect">
            <summary id="${prefix}-est-summary-${idx}" class="estate-multiselect-summary">${estatesLabel(r.estates)}</summary>
            <div class="estate-multiselect-panel" id="${prefix}-est-panel-${idx}">${estateOptions}</div>
          </details>
        </div>
        <div class="rtcol-freq"><span class="freq-pill is-selected is-fixed">${group.frequency}</span></div>
      </div>`;
    }).join('');
    return `
    <div class="reports-toggle-table">
      <div class="rtt-head">
        <span class="rtcol-toggle"></span>
        <span class="rtcol-type">REPORT TYPE</span>
        <span class="rtcol-estate">ESTATE(S)</span>
        <span class="rtcol-freq">FREQUENCY</span>
      </div>
      ${rows}
    </div>`;
  }

  // Close any open Estate dropdown when clicking outside it (a native
  // <details> element doesn't do this on its own). Bound once per page load.
  if (!window.__estateMultiselectCloserBound) {
    window.__estateMultiselectCloserBound = true;
    document.addEventListener('click', e => {
      document.querySelectorAll('details.estate-multiselect[open]').forEach(d => {
        if (!d.contains(e.target)) d.removeAttribute('open');
      });
    });
  }

  window.onReportEnabledToggle = function(prefix, idx, checked) {
    // Flipping the toggle only edits this row's enabled flag \u2014 the
    // estate/frequency choices already on the row are left exactly as they
    // are, not cleared, so switching back on restores them.
    draftReports[idx].enabled = checked;
    refreshReportsTable(prefix);
  };

  window.onEstateOptionToggle = function(prefix, idx, value, checked) {
    const r = draftReports[idx];
    if (value === 'All Estates') {
      r.estates = checked ? ['All Estates'] : [];
    } else if (checked) {
      r.estates = [...r.estates.filter(e => e !== 'All Estates'), value];
    } else {
      r.estates = r.estates.filter(e => e !== value);
    }
    if (!r.estates.length) r.estates = ['All Estates']; // never allow an empty selection
    // Update just the summary label + the checkboxes already in the open
    // panel, in place \u2014 a full table re-render would close the dropdown
    // after every single click, which defeats picking several estates at once.
    const summaryEl = document.getElementById(`${prefix}-est-summary-${idx}`);
    if (summaryEl) summaryEl.textContent = estatesLabel(r.estates);
    const panel = document.getElementById(`${prefix}-est-panel-${idx}`);
    if (panel) panel.querySelectorAll('input[type=checkbox]').forEach(cb => { cb.checked = r.estates.includes(cb.value); });
  };

  function subscriberFormFields(prefix) {
    return `
      <div class="form-group form-group-tight">
        <label class="form-label">Select Existing User (optional)</label>
        <select class="form-input" id="${prefix}-user" onchange="onSubscriberUserPick('${prefix}')">
          <option value="">— Enter details manually —</option>
          ${DATA.users.map(u=>`<option value="${u.id}" data-name="${u.name}" data-email="${u.email}">${u.name} (${u.email})</option>`).join('')}
        </select>
      </div>
      <div class="form-grid-2">
        <div class="form-group"><label class="form-label">Full Name</label>
          <input class="form-input" id="${prefix}-name" placeholder="Recipient name" value="${draftName||''}"></div>
        <div class="form-group"><label class="form-label">Email Address</label>
          <input class="form-input" id="${prefix}-email" type="email" placeholder="email@example.com" value="${draftEmail||''}"></div>
      </div>
      <div class="form-group form-group-tight">
        <label class="form-label">Reports</label>
        <div id="${prefix}-reports-table">${reportsTableHTML(prefix)}</div>
      </div>`;
  }

  window.onSubscriberUserPick = function(prefix) {
    const sel = document.getElementById(`${prefix}-user`);
    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value) return;
    document.getElementById(`${prefix}-name`).value = opt.dataset.name || '';
    document.getElementById(`${prefix}-email`).value = opt.dataset.email || '';
  };

  // Renders the Add/Edit Subscriber modal from current draft state.
  function renderSubscriberModal(prefix) {
    if (prefix === 'nsub') {
      showModal(`
        <div class="modal-title">Add Subscriber</div>
        ${subscriberFormFields('nsub')}
        <div class="modal-actions">
          <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="addSubscriber()">Save Subscriber</button>
        </div>`, { size: 'md' });
    } else {
      showModal(`
        <div class="modal-title">Edit Subscriber \u2014 ${draftName}</div>
        ${subscriberFormFields('esub')}
        <div class="modal-actions">
          <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
          <button class="btn btn-primary" onclick="submitEditSubscriber('${draftEditingId}')">Save Changes</button>
        </div>`, { size: 'md' });
    }
  }

  window.showAddSubscriberModal = function() {
    // New subscribers start with every report type ON and set to All
    // Estates, per the fixed-table default.
    draftReports = defaultDraftReports();
    draftName = '';
    draftEmail = '';
    draftEditingId = null;
    renderSubscriberModal('nsub');
  };

  window.showEditSubscriberModal = function(id) {
    const s = subscribers.find(x => x.id === id);
    if (!s) return;
    // A group is "on" if any of its underlying report_type rows is enabled;
    // its estates come from that enabled row (every row in a group is
    // always written with the same enabled/estates pair — see
    // submitEditSubscriber — so this just reads back what was saved).
    draftReports = REPORT_GROUPS.map(g => {
      const rows = (s.reports || []).filter(r => g.types.includes(r.reportType));
      const active = rows.find(r => r.enabled) || rows[0];
      return active
        ? { groupKey: g.key, enabled: active.enabled, estates: [...active.estates] }
        : { groupKey: g.key, enabled: false, estates: ['All Estates'] };
    });
    draftName = s.name;
    draftEmail = s.email;
    draftEditingId = id;
    renderSubscriberModal('esub');
  };

  window.submitEditSubscriber = async function(id) {
    const name  = document.getElementById('esub-name').value.trim();
    const email = document.getElementById('esub-email').value.trim();
    if (!name || !email) { showToast('Please fill in name and email','red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_report_recipients').update({ name, email }).eq('id', id);
      if (error) throw error;
      // Reconcile subscriptions by replacing the full set \u2014 this is a small
      // per-recipient child table, so a diff-free delete+reinsert is simpler
      // and safer than matching rows up one by one.
      const { error: delErr } = await client.from('vsl_report_subscriptions').delete().eq('recipient_id', id);
      if (delErr) throw delErr;
      const { error: subErr } = await client.from('vsl_report_subscriptions').insert(
        expandDraftReportsToRows(id)
      );
      if (subErr) throw subErr;
      closeModal();
      showToast('Subscriber updated');
      await retryLiveDataLoad();
      subscribers.length = 0;
      DATA.emailSubscribers.forEach(s => subscribers.push(s));
      const subListEl = document.getElementById('subscribers-list');
      if (subListEl) subListEl.innerHTML = renderSubList();
    } catch (err) {
      console.error(err);
      showToast('Failed to update subscriber: ' + err.message, 'red');
    }
  };

  // Fixed cadence per bundle (set in REPORT_GROUPS above) means this panel
  // no longer needs a per-frequency on/off switch — day/time are the only
  // admin-settable things left, and they're saved together with one button
  // in the modal footer rather than one Save per row.
  const DOW_LABELS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  function scheduleSettingsRowsHTML() {
    const rows = ['Daily','Weekly','Monthly'].map(freq =>
      DATA.reportScheduleSettings.find(r => r.frequency === freq) || { frequency: freq, dayOfWeek: 1, dayOfMonth: 1, timeOfDay: '07:00' });
    return `<div class="sched-table">${rows.map(r => `
      <div class="sched-row">
        <div class="sched-cell-label">${r.frequency}</div>
        ${r.frequency === 'Weekly' ? `
        <select class="form-input sched-input" id="sched-${r.frequency}-day">
          ${DOW_LABELS.map((d,i)=>`<option value="${i}" ${i===r.dayOfWeek?'selected':''}>${d}</option>`).join('')}
        </select>` : r.frequency === 'Monthly' ? `
        <select class="form-input sched-input" id="sched-${r.frequency}-day">
          ${Array.from({length:31},(_,i)=>i+1).map(d=>`<option value="${d}" ${d===r.dayOfMonth?'selected':''}>Day ${d}</option>`).join('')}
        </select>` : `<div></div>`}
        <input class="form-input sched-input" type="time" id="sched-${r.frequency}-time" value="${r.timeOfDay}">
      </div>`).join('')}</div>`;
  }
  window.saveAllReportSchedules = async function() {
    try {
      const client = getSbClient();
      const uid = await getCurrentUserId();
      for (const freq of ['Daily','Weekly','Monthly']) {
        const timeOfDay = document.getElementById(`sched-${freq}-time`).value || '07:00';
        const dayEl = document.getElementById(`sched-${freq}-day`);
        const dayVal = dayEl ? Number(dayEl.value) : null;
        const { error } = await client.from('vsl_report_schedule_settings').update({
          enabled: true, time_of_day: timeOfDay,
          day_of_week: freq === 'Weekly' ? dayVal : null,
          day_of_month: freq === 'Monthly' ? dayVal : null,
          updated_at: new Date().toISOString(), updated_by: uid,
        }).eq('frequency', freq);
        if (error) throw error;
      }
      closeModal();
      showToast('Schedule updated');
      await retryLiveDataLoad();
    } catch (err) {
      console.error(err);
      showToast('Failed to update schedule: ' + err.message, 'red');
    }
  };

  window.showScheduleSettingsModal = function() {
    showModal(`
      <div class="modal-title">Automated Schedule Settings</div>
      <p class="modal-subtitle">When each subscription frequency actually goes out</p>
      ${scheduleSettingsRowsHTML()}
      <div class="modal-actions">
        <button class="btn btn-primary" onclick="saveAllReportSchedules()">Save Schedule</button>
      </div>`, { size: 'md' });
  };

  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">Reports</div>
    <div class="page-header-sub">Manage automated report distribution</div></div>
    <div class="header-actions">
      <button class="btn btn-primary btn-xl btn-header-action" onclick="showAddSubscriberModal()">+ Add Subscriber</button>
      <button class="btn btn-outline btn-sm btn-header-action" onclick="showScheduleSettingsModal()">⚙️ Settings</button>
    </div>
  </div>

  <div class="grid-3">
    <div class="stat-card blue"><div class="stat-label">Subscribers</div>
      <div class="stat-value" id="sub-count">${subscribers.length}</div>
      <div class="stat-meta">Active recipients</div></div>
    <div class="stat-card green"><div class="stat-label">Last Batch Sent</div>
      <div class="stat-value stat-value-sm">—</div><div class="stat-meta">Not yet sent</div></div>
    <div class="stat-card amber"><div class="stat-label">Next Scheduled</div>
      <div class="stat-value stat-value-sm">—</div><div class="stat-meta">Delivery backend coming soon</div></div>
  </div>

  <!-- SUBSCRIBER LIST -->
  <div class="card">
    <div class="card-header">
      <div class="card-title">Subscriber List</div>
      <button class="btn btn-amber btn-sm btn-header-action" onclick="sendAllEmails()">📤 Send Report to All</button>
    </div>
    <div id="subscribers-list">${renderSubList()}</div>
  </div>`;

  window.addSubscriber = async function() {
    const name  = document.getElementById('nsub-name').value.trim();
    const email = document.getElementById('nsub-email').value.trim();
    if (!name || !email) { showToast('Please fill in name and email','red'); return; }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) { showToast('Invalid email address','red'); return; }
    try {
      const client = getSbClient();
      const { data, error } = await client.from('vsl_report_recipients').insert([{ email, name }]).select();
      if (error) throw error;
      const recipientId = data[0].id;
      const { error: subErr } = await client.from('vsl_report_subscriptions').insert(
        expandDraftReportsToRows(recipientId)
      );
      if (subErr) throw subErr;
      closeModal();
      showToast(`${email} added to report list`);
      await retryLiveDataLoad();
      // Sync local closure array from freshly-loaded DATA, then refresh the list
      subscribers.length = 0;
      DATA.emailSubscribers.forEach(s => subscribers.push(s));
      const subListEl = document.getElementById('subscribers-list');
      const countEl   = document.getElementById('sub-count');
      if (subListEl) subListEl.innerHTML = renderSubList();
      if (countEl)   countEl.textContent = subscribers.length;
    } catch (err) {
      console.error(err);
      showToast('Failed to add subscriber: ' + err.message, 'red');
    }
  };

  window.confirmRemoveSubscriber = function(id) {
    const s = subscribers.find(x => x.id === id);
    if (!s) return;
    const name = String(s.name || '').replace(/[<>&"]/g, '');
    const email = String(s.email || '').replace(/[<>&"]/g, '');
    showModal(`
      <div class="modal-title">Remove Subscriber</div>
      <p class="modal-text">Remove <strong>${name}</strong> (${email}) from the subscriber list? They will stop receiving all reports. This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="removeSubscriber('${s.id}')">Yes, Remove</button>
      </div>`);
  };

  window.removeSubscriber = async function(id) {
    closeModal();
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_report_recipients').delete().eq('id', id);
      if (error) throw error;
      showToast('Subscriber removed','amber');
      await retryLiveDataLoad();
      // Sync local closure array from freshly-loaded DATA, then refresh the list
      subscribers.length = 0;
      DATA.emailSubscribers.forEach(s => subscribers.push(s));
      const subListEl = document.getElementById('subscribers-list');
      const countEl   = document.getElementById('sub-count');
      if (subListEl) subListEl.innerHTML = renderSubList();
      if (countEl)   countEl.textContent = subscribers.length;
    } catch (err) {
      console.error(err);
      showToast('Failed to remove subscriber: ' + err.message, 'red');
    }
  };

  window.sendEmailNow = async function(id, email) {
    try {
      const client = getSbClient();
      const { data, error } = await client.functions.invoke('vsl-report-now', { body: { recipient_id: id } });
      if (error) throw error;
      if (!data || data.success === false) throw new Error(data?.error || 'Unknown error');
      const scopes = data.scopes || [];
      const totals = data.totals || { sent: 0, failed: 0 };
      if (!scopes.length) {
        showToast(data.note || `${email} has no enabled report subscriptions`, 'amber');
      } else if (totals.failed > 0) {
        showToast(`Sent to ${email}, but ${totals.failed} dispatch(es) failed — check the log`, 'amber');
      } else {
        showToast(`Report sent to ${email} ✓`);
      }
    } catch (err) {
      console.error(err);
      showToast('Failed to send report: ' + (err.message || err), 'red');
    }
  };

  // A simple yes/no confirm, not a form — who gets it and with what
  // estates/frequency is already decided per-subscriber, so the only real
  // choice left here is which of the 3 report bundles to include in this
  // one-off dispatch. Every bundle defaults to on.
  window.sendAllEmails = function() {
    showModal(`
      <div class="modal-title">Send Report to All Subscribers</div>
      <p class="modal-intro-text">Dispatch a report to all <strong>${subscribers.length} subscribers</strong> now.</p>
      <div class="form-group form-group-tight">
        <label class="form-label">Reports to send</label>
        <div class="reports-toggle-table">
          ${REPORT_GROUPS.map(g => `
          <div class="report-toggle-row">
            <div class="rtcol-toggle">
              <label class="toggle-switch">
                <input type="checkbox" id="sendall-${g.key}" checked>
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div class="rtcol-type"><span class="rtr-type-text">${g.label}</span></div>
          </div>`).join('')}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="confirmSendAllEmails()">Send Now</button>
      </div>`, { size: 'sm' });
  };

  window.confirmSendAllEmails = async function() {
    const selected = REPORT_GROUPS.filter(g => document.getElementById(`sendall-${g.key}`).checked);
    if (!selected.length) { showToast('Select at least one report to send', 'red'); return; }
    closeModal();
    showToast(`Sending ${selected.map(g => g.label).join(', ')}…`, 'amber');
    try {
      const client = getSbClient();
      const { data, error } = await client.functions.invoke('vsl-report-now', { body: { bundles: selected.map(g => g.key) } });
      if (error) throw error;
      if (!data || data.success === false) throw new Error(data?.error || 'Unknown error');
      const scopes = data.scopes || [];
      const totals = data.totals || { sent: 0, failed: 0 };
      if (!scopes.length) {
        showToast(data.note || 'No enabled subscribers for the selected report(s)', 'amber');
      } else if (totals.failed > 0) {
        showToast(`Sent to ${totals.sent} recipient(s), ${totals.failed} failed — check the dispatch log`, 'amber');
      } else {
        showToast(`${selected.map(g => g.label).join(', ')} sent to ${totals.sent} recipient(s) ✓`);
      }
    } catch (err) {
      console.error(err);
      showToast('Failed to send reports: ' + (err.message || err), 'red');
    }
  };
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  PAGE: ALERTS
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

function renderAlerts(el) {
  const severityIcon = t => t==='critical' ? '\ud83d\udea8' : t==='warning' ? '\u26a0\ufe0f' : '\u2139\ufe0f';
  const openRows     = () => DATA.alerts.filter(a => !a.isReal || a.status !== 'resolved');
  const resolvedRows = () => DATA.alerts.filter(a => a.isReal && a.status === 'resolved');

  function openTable() {
    const rows = openRows();
    return `<div class="table-wrap"><table>
      <thead><tr><th>Severity</th><th>Alert</th><th>Scope</th><th>Note</th><th>Raised</th><th>Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map(a=>`
        <tr style="cursor:pointer" onclick="viewAlertDetail('${a.id}')">
          <td>${severityIcon(a.type)} ${pill(titleCaseLocal(a.type),a.type==='critical'?'red':a.type==='warning'?'amber':'blue')}</td>
          <td><strong>${a.title}</strong></td>
          <td>${a.estate}${a.layerType ? `<br><span style="font-size:11px;color:var(--gray-500)">${titleCaseLocal(a.layerType)}</span>` : ''}</td>
          <td style="max-width:220px">${a.desc || '\u2014'}</td>
          <td style="font-size:12px;color:var(--gray-500)">${a.time}</td>
          <td onclick="event.stopPropagation()">
            <div style="display:flex;gap:4px">
              <button class="icon-btn" onclick="viewAlertDetail('${a.id}')" title="View">\ud83d\udc41</button>
              ${a.isReal ? `
              <button class="icon-btn primary" onclick="openResolveAlertModal('${a.id}')" title="Resolve">\u2713</button>
              <button class="icon-btn danger" onclick="confirmDeleteAlert('${a.id}')" title="Delete">\ud83d\uddd1</button>` : ''}
            </div></td>
        </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--gray-500);padding:24px">No open alerts \ud83c\udf89</td></tr>`}
      </tbody></table></div>`;
  }

  function resolvedTable() {
    const rows = resolvedRows();
    return `<div class="table-wrap"><table>
      <thead><tr><th>Severity</th><th>Alert</th><th>Scope</th><th>Resolution</th><th>Resolved</th><th>Actions</th></tr></thead>
      <tbody>${rows.length ? rows.map(a=>`
        <tr style="cursor:pointer" onclick="viewAlertDetail('${a.id}')">
          <td>${severityIcon(a.type)} ${pill(titleCaseLocal(a.type),a.type==='critical'?'red':a.type==='warning'?'amber':'blue')}</td>
          <td><strong>${a.title}</strong></td>
          <td>${a.estate}</td>
          <td style="max-width:220px">${a.resolutionNote || '<span style="color:var(--gray-500)">\u2014</span>'}</td>
          <td style="font-size:12px;color:var(--gray-500)">${a.resolvedTime || '\u2014'}</td>
          <td onclick="event.stopPropagation()">
            <div style="display:flex;gap:4px">
              <button class="icon-btn" onclick="viewAlertDetail('${a.id}')" title="View">\ud83d\udc41</button>
              <button class="icon-btn primary" onclick="confirmReopenAlert('${a.id}')" title="Raise Again">\u21ba</button>
              <button class="icon-btn danger" onclick="confirmDeleteAlert('${a.id}')" title="Delete">\ud83d\uddd1</button>
            </div></td>
        </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--gray-500);padding:24px">No resolved alerts yet</td></tr>`}
      </tbody></table></div>`;
  }

  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">Alerts &amp; Notifications</div>
    <div class="page-header-sub">${DATA.alerts.filter(a=>a.type==='critical').length} critical \u00b7 ${DATA.alerts.filter(a=>a.type==='warning').length} warnings</div></div>
    <button class="btn btn-primary btn-xl btn-header-action" onclick="showAddAlertModal()">+ New Alert</button>
  </div>
  <div class="grid-3" style="margin-bottom:20px">
    <div class="stat-card red"><div class="stat-label">Critical</div><div class="stat-value">${DATA.alerts.filter(a=>a.type==='critical').length}</div></div>
    <div class="stat-card amber"><div class="stat-label">Warnings</div><div class="stat-value">${DATA.alerts.filter(a=>a.type==='warning').length}</div></div>
    <div class="stat-card blue"><div class="stat-label">Info</div><div class="stat-value">${DATA.alerts.filter(a=>a.type==='info').length}</div></div>
  </div>
  <div class="card" style="margin-bottom:20px">
    <div class="card-header"><div class="card-title">Open Alerts</div><div style="font-size:11px;color:var(--gray-500)">${openRows().length} open</div></div>
    <div id="alerts-open-table">${openTable()}</div>
  </div>
  <div class="card">
    <div class="card-header"><div class="card-title">Resolved Alerts</div><div style="font-size:11px;color:var(--gray-500)">${resolvedRows().length} resolved</div></div>
    <div id="alerts-resolved-table">${resolvedTable()}</div>
  </div>`;

  function refresh() {
    document.getElementById('alerts-open-table').innerHTML = openTable();
    document.getElementById('alerts-resolved-table').innerHTML = resolvedTable();
  }

  window.viewAlertDetail = function(id) {
    const a = DATA.alerts.find(x => x.id === id);
    if (!a) return;
    const isResolved = a.isReal && a.status === 'resolved';
    const attrs = [
      ['Severity', titleCaseLocal(a.type)],
      ['Alert', a.title],
      ['Scope', a.estate + (a.layerType ? ' · ' + titleCaseLocal(a.layerType) : '')],
      ['Note', a.desc || '—'],
      ['Raised', a.time],
      ['Logged By', a.createdByName || '—'],
      ['Status', isResolved ? 'Resolved' : 'Open'],
      ...(isResolved ? [
        ['Resolution', a.resolutionNote || '—'],
        ['Resolved', a.resolvedTime || '—'],
        ['Resolved By', a.resolvedByName || '—'],
      ] : []),
    ];
    showModal(`
      <div class="modal-title">${severityIcon(a.type)} ${a.title}</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th style="width:35%">Attribute</th><th>Value</th></tr></thead>
          <tbody>
            ${attrs.map(([k,v],i)=>`
              <tr style="background:${i%2===0?'var(--gray-50)':'var(--white)'}">
                <td style="font-weight:600;color:var(--gray-700);font-size:12px">${k}</td>
                <td style="color:var(--gray-900);font-size:13px">${v}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${a.isReal && !isResolved ? `
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal();openResolveAlertModal('${a.id}')">✓ Resolve</button>
        <button class="btn btn-danger" onclick="closeModal();confirmDeleteAlert('${a.id}')">🗑 Delete</button>
      </div>` : a.isReal ? `
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal();confirmReopenAlert('${a.id}')">↺ Raise Again</button>
        <button class="btn btn-danger" onclick="closeModal();confirmDeleteAlert('${a.id}')">🗑 Delete</button>
      </div>` : ''}`);
  };

  window.confirmReopenAlert = function(id) {
    const a = DATA.alerts.find(x => x.id === id);
    if (!a) return;
    showModal(`
      <div class="modal-title">Raise Alert Again</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">Re-open "${a.title}"? It will move back to Open Alerts and its resolution note will be cleared.</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitReopenAlert('${id}')">Yes, Raise Again</button>
      </div>`);
  };

  window.submitReopenAlert = async function(id) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_alerts').update({
        status: 'open', resolved_at: null, resolved_by: null, resolution_note: null,
      }).eq('id', id);
      if (error) throw error;
      closeModal();
      showToast('Alert raised again');
      await retryLiveDataLoad();
      refresh();
    } catch (err) {
      console.error(err);
      showToast('Failed to raise alert: ' + err.message, 'red');
    }
  };

  function scopePickerHTML() {
    return `
      <div class="form-group"><label class="form-label">Scope</label>
        <select class="form-input" id="aal-scope" onchange="onAlertScopeChange()">
          <option value="ESTATE">Estate</option><option value="BLOCKS">Block</option><option value="PARCELS">Plot</option>
        </select></div>
      <div class="form-group"><label class="form-label">&nbsp;</label><select class="form-input" id="aal-target"></select></div>`;
  }
  window.onAlertScopeChange = function() {
    const scope = document.getElementById('aal-scope').value;
    const sel = document.getElementById('aal-target');
    if (scope === 'ESTATE') sel.innerHTML = DATA.estates.map(e=>`<option value="${e._id}">${e.name}</option>`).join('');
    else if (scope === 'BLOCKS') sel.innerHTML = DATA.blocks.map(b=>`<option value="${b._uuid}">${b.name || b.id} (${b.estate})</option>`).join('');
    else sel.innerHTML = DATA.plots.map(p=>`<option value="${p._uuid}">${p.parcelName || p.id}</option>`).join('');
  };

  window.showAddAlertModal = function() {
    showModal(`
      <div class="modal-title">New Alert</div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Alert Name</label><input class="form-input" id="aal-name" placeholder="e.g. Pest scouting overdue"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Severity</label>
          <select class="form-input" id="aal-severity"><option value="information">Information</option><option value="warning">Warning</option><option value="critical">Critical</option></select></div>
        <div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">${scopePickerHTML()}</div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Note</label><textarea class="form-input" id="aal-note" rows="3"></textarea></div>
      <div class="modal-actions">
        <button class="btn btn-primary" onclick="submitAddAlert()">Create Alert</button>
      </div>`);
    onAlertScopeChange();
  };

  window.submitAddAlert = async function() {
    const name = document.getElementById('aal-name').value.trim();
    const severity = document.getElementById('aal-severity').value;
    const layerType = document.getElementById('aal-scope').value;
    const targetId = document.getElementById('aal-target').value;
    const note = document.getElementById('aal-note').value.trim();
    if (!name) { showToast('Alert name is required', 'red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_alerts').insert([{
        alert_name: name, severity, layer_type: layerType, target_id: String(targetId), note: note || null,
      }]);
      if (error) throw error;
      closeModal();
      showToast('Alert created');
      await retryLiveDataLoad();
      refresh();
    } catch (err) {
      console.error(err);
      showToast('Failed to create alert: ' + err.message, 'red');
    }
  };

  // \u2500\u2500 Resolve flow: dedicated dashboard/windows/resolve-alert-modal.html
  // window (not the generic showModal shell) \u2014 captures a resolution note
  // before marking the alert resolved. The row moves from the Open table to
  // the Resolved table; it is never deleted by this action.
  window.openResolveAlertModal = function(id) {
    const a = DATA.alerts.find(x => x.id === id);
    if (!a) return;
    const overlay = document.getElementById('resolveAlertOverlay');
    if (!overlay) { showToast('Resolve window not loaded', 'red'); return; }
    document.getElementById('resolveAlertSummary').innerHTML = `
      <div class="ras-title">${severityIcon(a.type)} ${a.title}</div>
      <div>${a.desc || 'No description provided.'}</div>
      <div class="ras-meta">${a.estate} \u00b7 Raised ${a.time}</div>`;
    document.getElementById('resolveAlertNote').value = '';
    const submitBtn = document.getElementById('resolveAlertSubmitBtn');
    submitBtn.onclick = () => submitResolveAlert(id);
    overlay.hidden = false;
  };

  async function submitResolveAlert(id) {
    const note = document.getElementById('resolveAlertNote').value.trim();
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_alerts').update({
        status: 'resolved', resolved_at: new Date().toISOString(), resolution_note: note || null,
      }).eq('id', id);
      if (error) throw error;
      closeModal();
      showToast('Alert marked resolved');
      await retryLiveDataLoad();
      refresh();
    } catch (err) {
      console.error(err);
      showToast('Failed to resolve alert: ' + err.message, 'red');
    }
  }

  window.confirmDeleteAlert = function(id) {
    showModal(`
      <div class="modal-title">Delete Alert</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">Delete this alert? This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-danger" onclick="submitDeleteAlert('${id}')">Yes, Delete</button>
      </div>`);
  };
  window.submitDeleteAlert = async function(id) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_alerts').delete().eq('id', id);
      if (error) throw error;
      closeModal();
      showToast('Alert deleted', 'red');
      await retryLiveDataLoad();
      refresh();
    } catch (err) {
      console.error(err);
      showToast('Failed to delete alert: ' + err.message, 'red');
    }
  };
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  PAGE: SETTINGS
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

function renderSettings(el) {
  el.innerHTML = `
  <div class="page-header"><div class="page-header-title">System Settings</div></div>
  <div class="grid-2">
    <div>
      <div class="card" style="margin-bottom:20px">
        <div class="settings-section-title">General</div>
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">System Name</label>
          <input class="form-input" value="Victoria Sugar Management System">
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">Active Season</label>
          <select class="form-input"><option selected>2024-B</option><option>2024-A</option><option>2025-A</option></select>
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">Currency</label>
          <select class="form-input"><option>UGX \u2014 Ugandan Shilling</option><option>USD</option></select>
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label class="form-label">Timezone</label>
          <select class="form-input"><option>Africa/Kampala (UTC+3)</option></select>
        </div>
        <button class="btn btn-primary" onclick="showToast('General settings saved')">Save General Settings</button>
      </div>
      <div class="card">
        <div class="settings-section-title">Integrations</div>
        ${[
          ['Google Maps API','Connected','green'],
          ['Weather API (OpenWeather)','Connected','green'],
          ['Twilio SMS','Not connected','gray'],
          ['QGIS GIS Export','Connected','green'],
        ].map(([n,s,c])=>`
          <div class="settings-row">
            <div class="settings-label">${n}</div>
            <div style="display:flex;align-items:center;gap:10px">
              ${pill(s,c)}
              <button class="btn btn-outline btn-sm" onclick="showToast('${s==='Connected'?'Disconnected':'Connecting...'}')">${s==='Connected'?'Disconnect':'Connect'}</button>
            </div>
          </div>`).join('')}
      </div>
    </div>
    <div>
      <div class="card" style="margin-bottom:20px">
        <div class="settings-section-title">Notifications</div>
        ${[
          ['Email alerts on critical events','Send email to admin on critical alerts',true],
          ['SMS notifications','Send SMS via Twilio for harvest milestones',false],
          ['Weekly digest to all managers','Auto-send weekly report to land managers',true],
          ['Investor portal updates','Notify investors on new production data',true],
        ].map(([l,d,on])=>`
          <div class="settings-row">
            <div><div class="settings-label">${l}</div><div class="settings-desc">${d}</div></div>
            <label class="toggle-switch">
              <input type="checkbox" ${on?'checked':''} onchange="showToast('Setting saved')">
              <span class="toggle-slider"></span>
            </label>
          </div>`).join('')}
      </div>
      <div class="card">
        <div class="settings-section-title">Account</div>
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">Admin Name</label>
          <input class="form-input" value="Admin Moses">
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label class="form-label">Admin Email</label>
          <input class="form-input" value="moses@sugarestate.ug">
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label class="form-label">New Password</label>
          <input class="form-input" type="password" placeholder="Leave blank to keep current">
        </div>
        <button class="btn btn-primary" onclick="showToast('Account updated successfully')">Update Account</button>
      </div>
    </div>
  </div>`;
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  MODAL SYSTEM
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

// Icon shown in the modal header, guessed from the (legacy) title text so call
// sites don't each have to specify one.
function guessModalIcon(title) {
  const t = (title || '').toLowerCase();
  if (t.startsWith('delete') || t.startsWith('remove')) return '🗑';
  if (t.startsWith('resolve')) return '✓';
  if (t.startsWith('edit')) return '✎';
  if (t.startsWith('add') || t.startsWith('log') || t.startsWith('new') || t.startsWith('create')) return '+';
  return '◈';
}

// Populates the shared dashboard/windows/modal-shell.html shell and shows it.
// `html` follows the existing convention: a leading `<div class="modal-title">…`
// element (moved into the header) and a trailing `<div class="modal-actions">…`
// element (moved into the footer band, with any "Cancel" button stripped —
// closing now happens via the header ✕, the backdrop, or Escape only).
function showModal(html, opts) {
  const overlay = document.getElementById('modalOverlay');
  if (!overlay) { console.error('dashboard/windows/modal-shell.html did not load'); return; }

  // Every modal shares one box (#modalBox), so without this a differently
  // sized modal would leave the box that size for whatever opens next.
  // Removing every size class and re-adding at most one each call keeps
  // them independent — pass {size:'sm'} for a narrower confirm-style
  // modal (e.g. Send Report to All), {size:'md'} for one that just needs
  // a bit more room (e.g. Add/Edit Subscriber, Schedule Settings), or
  // {size:'wide'} for one with fields that want to sit side by side;
  // everything else stays the normal (460px) size.
  const box = document.getElementById('modalBox');
  if (box) {
    box.classList.remove('modal-sm', 'modal-md', 'modal-wide');
    const size = opts && opts.size;
    if (size === 'sm' || size === 'md' || size === 'wide') box.classList.add(`modal-${size}`);
  }

  const body = document.getElementById('modalBody');
  body.innerHTML = html;

  const titleEl = body.querySelector('.modal-title');
  const titleText = titleEl ? titleEl.textContent.trim() : '';
  document.getElementById('modalTitle').textContent = titleText;
  document.getElementById('modalIcon').textContent = guessModalIcon(titleText);
  if (titleEl) titleEl.remove();

  const actionsEl = body.querySelector('.modal-actions');
  const footer = document.getElementById('modalFooter');
  footer.innerHTML = '';
  if (actionsEl) {
    [...actionsEl.querySelectorAll('button')].forEach(btn => {
      if (btn.getAttribute('onclick') === 'closeModal()' || /^cancel$/i.test(btn.textContent.trim())) btn.remove();
    });
    footer.appendChild(actionsEl);
    actionsEl.className = ''; // was "modal-actions" (margin/justify); footer band now owns that layout
  }
  footer.hidden = !footer.children.length || !footer.querySelector('button');

  overlay.hidden = false;
}

function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.hidden = true;
  const resolveOverlay = document.getElementById('resolveAlertOverlay');
  if (resolveOverlay) resolveOverlay.hidden = true;
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  closeModal();
});

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
//  CHART INITIALISATION
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

function initCharts(page) {
  const defaults  = { responsive:true, maintainAspectRatio:true, plugins:{ legend:{ display:false } } };
  const gridColor = 'rgba(0,0,0,.05)';
  const tickColor = '#6b7776';
  function reg(c) { activeCharts.push(c); }

  if (page === 'dashboard') {
    const pm = DATA.productionMonthly;

    const c1 = document.getElementById('chart-prod-monthly');
    if (c1) reg(new Chart(c1, {
      type: 'bar',
      data: { labels: pm.labels, datasets: [
        { label:'Actual', data:pm.actual, backgroundColor:'#2e6647', borderRadius:4 },
      ]},
      options: { ...defaults,
        plugins: { legend:{ display:true, position:'bottom', labels:{ boxWidth:12, font:{ size:11 } } } },
        scales: {
          y: { grid:{ color:gridColor }, ticks:{ color:tickColor, font:{ size:11 } } },
          x: { grid:{ display:false }, ticks:{ color:tickColor, font:{ size:11 } } },
        },
      },
    }));

    const pe = DATA.productionByEstate;
    const c2 = document.getElementById('chart-prod-estate');
    if (c2) reg(new Chart(c2, {
      type: 'doughnut',
      data: { labels:pe.labels, datasets:[{ data:pe.values, backgroundColor:pe.colors, borderWidth:2, borderColor:'#fff' }] },
      options: { ...defaults, cutout:'65%' },
    }));

    // Real growth-stage counts (Stage is derived from cultivation_status —
    // see stageFromCultivationStatus() in supabase-client.js).
    const c3 = document.getElementById('chart-plot-status');
    if (c3) {
      const sd = plotStageDistribution();
      reg(new Chart(c3, {
        type: 'bar',
        data: {
          labels: sd.labels,
          datasets: [{ data: sd.values, backgroundColor: sd.colors, borderRadius:4 }],
        },
        options: { ...defaults, indexAxis:'y',
          scales: {
            x: { grid:{ color:gridColor }, ticks:{ color:tickColor, font:{ size:11 }, precision:0 } },
            y: { grid:{ display:false }, ticks:{ color:tickColor, font:{ size:11 } } },
          },
        },
      }));
    }

    // Real planted vs fallow area split (both rolled up from live block data —
    // see loadLiveData() in supabase-client.js). No "reserved" placeholder slice.
    const c4 = document.getElementById('chart-area-util');
    if (c4) reg(new Chart(c4, {
      type: 'doughnut',
      data: {
        labels: ['Planted','Fallow'],
        datasets: [{ data:[DATA.stats.plantedAreaHa, DATA.stats.fallowAreaHa], backgroundColor:['#4a9e6e','#e8a020'], borderWidth:2, borderColor:'#fff' }],
      },
      options: { ...defaults, cutout:'60%', plugins:{ legend:{ display:true, position:'bottom', labels:{ boxWidth:12, font:{ size:11 } } } } },
    }));
  }

  if (page === 'analytics') {
    const c5 = document.getElementById('chart-yield-variety');
    if (c5) reg(new Chart(c5, {
      type: 'bar',
      data: { labels:DATA.yieldByVariety.labels, datasets:[{ data:DATA.yieldByVariety.values, backgroundColor:'#2e6647', borderRadius:4 }] },
      options: { ...defaults, scales:{ y:{ min:5, grid:{ color:gridColor }, ticks:{ color:tickColor } }, x:{ grid:{ display:false }, ticks:{ color:tickColor } } } },
    }));

    const c6 = document.getElementById('chart-cost-break');
    // DATA.costBreakdown is computed straight from real vsl_activity_costs rows
    // (see loadLiveData() in supabase-client.js) — empty doughnut until costs are logged.
    if (c6) reg(new Chart(c6, {
      type: 'doughnut',
      data: { labels:DATA.costBreakdown.labels, datasets:[{ data:DATA.costBreakdown.values, backgroundColor:['#1a3d2b','#2e6647','#4a9e6e','#e8a020','#f4c56a','#c0392b','#9fd4b8'], borderWidth:2, borderColor:'#fff' }] },
      options: { ...defaults, cutout:'55%', plugins:{ legend:{ display:true, position:'bottom', labels:{ boxWidth:10, font:{ size:10 } } } } },
    }));

    const c7 = document.getElementById('chart-stage-dist');
    if (c7) {
      const sd2 = plotStageDistribution();
      reg(new Chart(c7, {
        type: 'doughnut',
        data: {
          labels: sd2.labels,
          datasets: [{ data: sd2.values, backgroundColor: sd2.colors, borderWidth:2, borderColor:'#fff' }],
        },
        options: { ...defaults, cutout:'55%', plugins:{ legend:{ display:true, position:'bottom', labels:{ boxWidth:10, font:{ size:10 } } } } },
      }));
    }
  }

  if (page === 'production') {
    const c8 = document.getElementById('chart-harvest-trend');
    if (c8) reg(new Chart(c8, {
      type: 'line',
      data: { labels:DATA.productionMonthly.labels, datasets: [
        { label:'Actual Harvest', data:DATA.productionMonthly.actual, borderColor:'#2e6647', backgroundColor:'rgba(46,102,71,.12)', fill:true, tension:.3, pointRadius:4 },
      ]},
      options: { ...defaults,
        plugins: { legend:{ display:true, position:'bottom', labels:{ boxWidth:12, font:{ size:11 } } } },
        scales: {
          y: { grid:{ color:gridColor }, ticks:{ color:tickColor } },
          x: { grid:{ display:false }, ticks:{ color:tickColor } },
        },
      },
    }));

    const c9 = document.getElementById('chart-harvest-estate');
    if (c9) {
      const pe = DATA.productionByEstate;
      reg(new Chart(c9, {
        type: 'bar',
        data: { labels:pe.labels, datasets:[{ data:pe.values, backgroundColor:pe.colors, borderRadius:4 }] },
        options: { ...defaults,
          scales: {
            y: { grid:{ color:gridColor }, ticks:{ color:tickColor } },
            x: { grid:{ display:false }, ticks:{ color:tickColor } },
          },
        },
      }));
    }
  }

  if (page === 'seasons') {
    const seasonStatusColors = { planned:'#9ca3af', planted:'#60a5fa', growing:'#4a9e6e', harvested:'#2e6647', failed:'#c0392b' };
    const statusCounts = {};
    DATA.seasons.forEach(s => { statusCounts[s.status] = (statusCounts[s.status] || 0) + 1; });
    const statusLabels = SEASON_STATUSES.filter(s => statusCounts[s]);
    const c10 = document.getElementById('chart-season-status');
    if (c10) reg(new Chart(c10, {
      type: 'doughnut',
      data: {
        labels: statusLabels.map(titleCaseLocal),
        datasets: [{ data: statusLabels.map(s => statusCounts[s]), backgroundColor: statusLabels.map(s => seasonStatusColors[s]), borderWidth:2, borderColor:'#fff' }],
      },
      options: { ...defaults, cutout:'55%', plugins:{ legend:{ display:true, position:'bottom', labels:{ boxWidth:10, font:{ size:10 } } } } },
    }));

    const varietyCounts = {};
    DATA.seasons.forEach(s => { if (s.caneVariety) varietyCounts[s.caneVariety] = (varietyCounts[s.caneVariety] || 0) + 1; });
    const vLabels = Object.keys(varietyCounts);
    const c11 = document.getElementById('chart-season-variety');
    if (c11) reg(new Chart(c11, {
      type: 'bar',
      data: { labels: vLabels, datasets: [{ data: vLabels.map(v => varietyCounts[v]), backgroundColor:'#2e6647', borderRadius:4 }] },
      options: { ...defaults, indexAxis:'y',
        scales: {
          x: { grid:{ color:gridColor }, ticks:{ color:tickColor, font:{ size:11 }, precision:0 } },
          y: { grid:{ display:false }, ticks:{ color:tickColor, font:{ size:11 } } },
        },
      },
    }));
  }
}

// ══════════════════════════════════════
//  TOPBAR ALERT BADGE (populated from live data)
// ══════════════════════════════════════

function refreshTopbarAlertBadge() {
  const badge = document.getElementById('topbar-alert-count');
  if (badge) badge.textContent = (DATA.alerts || []).filter(a => !a.isReal || a.status !== 'resolved').length;
}

// ── Activity badge ──
// Counts activities logged by someone else since this admin last looked at
// the Activities page. "Last looked" is a timestamp kept per signed-in user
// in localStorage; it moves forward when the Activities page opens (via the
// badge or the sidebar), which is what resets the count to zero. The very
// first time on a browser it starts at "now", so a long history doesn't
// show up as hundreds of "new" items.
function activitySeenKey() { return 'vsl_activity_seen_' + (window.CURRENT_USER_ID || 'anon'); }
function getActivitySeenAt() {
  try {
    const raw = localStorage.getItem(activitySeenKey());
    if (raw !== null && !isNaN(Number(raw))) return Number(raw);
    const now = Date.now();
    localStorage.setItem(activitySeenKey(), String(now));
    return now;
  } catch (e) { return Date.now(); }
}
function refreshTopbarActivityBadge() {
  const badge = document.getElementById('topbar-activity-count');
  if (!badge) return;
  const seenAt = getActivitySeenAt();
  const me = window.CURRENT_USER_ID;
  const n = (DATA.activities || []).filter(a =>
    a.createdAt && Date.parse(a.createdAt) > seenAt && !(me && a.createdById === me)
  ).length;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.hidden = n === 0;
}
function markActivitiesSeen() {
  try {
    const newest = (DATA.activities || []).reduce((m, a) => Math.max(m, a.createdAt ? Date.parse(a.createdAt) || 0 : 0), 0);
    localStorage.setItem(activitySeenKey(), String(Math.max(Date.now(), newest)));
  } catch (e) { /* storage unavailable — badge just won't persist */ }
  refreshTopbarActivityBadge();
}

// ── Own account ──
function isSelf(userId) { return !!window.CURRENT_USER_ID && String(userId) === String(window.CURRENT_USER_ID); }

function confirmLogout() {
  showModal(`
    <div class="modal-title">Log Out</div>
    <p class="modal-text">Sign out of the dashboard?</p>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitLogout()">Log Out</button>
    </div>`);
}
function showChangePasswordModal() {
  showModal(`
    <div class="modal-title">Change Password</div>
    <div class="form-group form-group-tight"><label class="form-label" for="cp-current">Current Password</label>
      <input class="form-input" id="cp-current" type="password" autocomplete="current-password"></div>
    <div class="form-group form-group-tight"><label class="form-label" for="cp-new">New Password</label>
      <input class="form-input" id="cp-new" type="password" autocomplete="new-password">
      <div class="modal-hint">At least 8 characters.</div></div>
    <div class="form-group form-group-tight"><label class="form-label" for="cp-confirm">Confirm New Password</label>
      <input class="form-input" id="cp-confirm" type="password" autocomplete="new-password"></div>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="submitChangePassword()">Update Password</button>
    </div>`);
}
async function submitChangePassword() {
  const current = document.getElementById('cp-current').value;
  const next = document.getElementById('cp-new').value;
  const confirm = document.getElementById('cp-confirm').value;
  if (!current || !next || !confirm) { showToast('Please fill in all fields', 'red'); return; }
  if (next.length < 8) { showToast('New password must be at least 8 characters', 'red'); return; }
  if (next !== confirm) { showToast('New passwords do not match', 'red'); return; }
  if (next === current) { showToast('New password must be different from the current one', 'red'); return; }
  try {
    const client = getSbClient();
    const { data: sess } = await client.auth.getSession();
    const email = sess?.session?.user?.email;
    if (!email) throw new Error('No active session');
    // Re-check the current password first so a left-open session can't be
    // used to lock the real owner out.
    const { error: verifyErr } = await client.auth.signInWithPassword({ email, password: current });
    if (verifyErr) { showToast('Current password is incorrect', 'red'); return; }
    const { error } = await client.auth.updateUser({ password: next });
    if (error) throw error;
    closeModal();
    showToast('Password updated');
  } catch (err) {
    console.error(err);
    showToast('Failed to update password: ' + err.message, 'red');
  }
}
async function submitLogout() {
  try {
    const { error } = await getSbClient().auth.signOut();
    if (error) throw error;
    // auth-gate.js's onAuthStateChange listener redirects to the login page.
  } catch (err) {
    console.error(err);
    showToast('Failed to log out: ' + err.message, 'red');
  }
}

// ══════════════════════════════════════
//  DATA SOURCE BANNER (shown if live load fails)
// ══════════════════════════════════════

function showDataSourceBanner(message) {
  let banner = document.getElementById('data-source-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'data-source-banner';
    banner.className = 'data-source-banner';
    document.body.appendChild(banner);
  }
  banner.innerHTML = `⚠ ${message} <button onclick="retryLiveDataLoad()">Retry</button>`;
  banner.classList.add('show');
}
function hideDataSourceBanner() {
  const banner = document.getElementById('data-source-banner');
  if (banner) banner.classList.remove('show');
}

async function retryLiveDataLoad() {
  hideDataSourceBanner();
  const overlay = document.getElementById('data-loading-overlay');
  if (overlay) overlay.classList.remove('hidden');
  await initLiveData();
}

// Resolves the signed-in admin's own vsl_profiles row (once DATA.users is
// populated) and renders their photo/initials into the topbar avatar —
// clicking it jumps straight to their own full user detail page.
async function refreshTopbarAvatar() {
  const topbarAvatarEl = document.getElementById('topbar-avatar');
  if (!topbarAvatarEl) return;
  try {
    const client = getSbClient();
    const { data: sess } = await client.auth.getSession();
    const uid = sess?.session?.user?.id;
    if (!uid) return;
    const me = DATA.users.find(u => String(u.id) === String(uid));
    if (!me) return;
    topbarAvatarEl.innerHTML = avatarHTML(me.name, me.avatarUrl, 32);
    topbarAvatarEl.title = me.name + ' - My profile';
    topbarAvatarEl.onclick = () => { openPanel('users', null); if (typeof window.viewUserDetail === 'function') window.viewUserDetail(me.id); };
  } catch (err) {
    console.error('Failed to resolve current user for topbar avatar:', err);
  }
}

// ══════════════════════════════════════
//  BOOT
// ══════════════════════════════════════

// Popup window HTML fragments (see dashboard/windows/) — fetched once at boot
// and appended to <body>, same pattern the main webmap uses for its windows/*.html.
const WINDOW_FRAGMENTS = [
  './windows/modal-shell.html',
  './windows/resolve-alert-modal.html',
];
async function loadWindowFragments() {
  await Promise.all(WINDOW_FRAGMENTS.map(async url => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const html = await res.text();
      const wrap = document.createElement('div');
      wrap.innerHTML = html.trim();
      [...wrap.children].forEach(child => document.body.appendChild(child));
    } catch (err) {
      console.error(`Failed to load window fragment ${url}:`, err);
    }
  }));
}

document.addEventListener('DOMContentLoaded', async () => {
  // ── Admin-only gate ──
  // dashboard/auth-gate.js has already asked the database for the signed-in
  // user's role; nothing below runs until it says ADMIN. Anyone else has had
  // the page replaced with an explanation by the time this resolves, so we
  // just stop — no fragments fetched, no Supabase data loaded, no render.
  //
  // A missing gate script denies rather than defaults open: if the script
  // tag in index.html were ever dropped, the dashboard should refuse to
  // start, not quietly open itself to everyone.
  if (typeof window.VSL_DASHBOARD_ACCESS === 'undefined') {
    console.error('Dashboard access gate (auth-gate.js) did not load — refusing to boot.');
    return;
  }
  if (!(await window.VSL_DASHBOARD_ACCESS)) return;

  try {
    const { data: sess } = await getSbClient().auth.getSession();
    window.CURRENT_USER_ID = sess?.session?.user?.id || null;
  } catch (e) { window.CURRENT_USER_ID = null; }

  await loadWindowFragments();

  // Remap the "Plots & Blocks" nav link to the renamed "estates" page
  document.querySelectorAll('.nav-item').forEach(item => {
    const oc = item.getAttribute('onclick') || '';
    if (oc.includes("openPanel('plots'")) {
      item.setAttribute('onclick', oc.replace("openPanel('plots'", "openPanel('estates'"));
      const lbl = item.querySelector('.nav-label');
      if (lbl) lbl.textContent = ' Estates';
    }
  });

  // Wire the now-loaded modal shells' close buttons / backdrop-click / Escape
  const overlay = document.getElementById('modalOverlay');
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  const closeBtn = document.getElementById('modalCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  const resolveOverlay = document.getElementById('resolveAlertOverlay');
  if (resolveOverlay) resolveOverlay.addEventListener('click', e => { if (e.target === resolveOverlay) closeModal(); });
  const resolveCloseBtn = document.getElementById('resolveAlertCloseBtn');
  if (resolveCloseBtn) resolveCloseBtn.addEventListener('click', closeModal);

  refreshTopbarAlertBadge();
  refreshTopbarActivityBadge();

  // Kick off live Supabase data load (defined in supabase-client.js)
  if (typeof initLiveData === 'function') {
    initLiveData();
  } else {
    console.error('initLiveData() not found — supabase-client.js may have failed to load');
    const overlay2 = document.getElementById('data-loading-overlay');
    if (overlay2) overlay2.classList.add('hidden');
  }

  // The dashboard IS the page now — land straight on the Dashboard view.
  openPanel('dashboard', null);
});

// Fired by supabase-client.js once live data has successfully replaced DATA
document.addEventListener('sugarestate:data-ready', () => {
  const overlay = document.getElementById('data-loading-overlay');
  if (overlay) overlay.classList.add('hidden');
  hideDataSourceBanner();
  refreshTopbarAlertBadge();
  refreshTopbarActivityBadge();
  // Re-render whatever page is currently showing with the fresh live data
  if (currentPage) {
    const activeNav = document.querySelector('.nav-item.active');
    openPanel(currentPage, activeNav);
  }
  refreshTopbarAvatar();
  showToast('Live estate data loaded');
});

// Fired by supabase-client.js if the live fetch fails — fallback/placeholder data stays in place
document.addEventListener('sugarestate:data-error', () => {
  const overlay = document.getElementById('data-loading-overlay');
  if (overlay) overlay.classList.add('hidden');
  refreshTopbarAlertBadge();
  refreshTopbarActivityBadge();
  showDataSourceBanner('Could not reach Supabase — showing placeholder data.');
});
