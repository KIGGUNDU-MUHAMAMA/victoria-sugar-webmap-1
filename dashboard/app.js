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
function managerCellHTML(scopeType, scopeId, scopeLabel, managerId, managerName, managerAvatarUrl) {
  if (managerId) {
    return `<button type="button" onclick="viewManagerDetail('${scopeType}','${scopeId}')"
              style="background:none;border:none;padding:0;cursor:pointer;display:inline-flex;align-items:center;line-height:0">
              ${avatarHTML(managerName, managerAvatarUrl, 32, 'square')}
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
  document.getElementById('panel-title').textContent = PAGE_TITLES[page] || page;

  destroyCharts();
  const body = document.getElementById('panel-body');
  body.innerHTML = '';

  const pages = {
    dashboard:     renderDashboard,
    analytics:     renderAnalytics,
    estates:       renderEstatesPage,
    production:    renderProduction,
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
                  ${managerCellHTML('parcel', p._uuid, p.parcelName || p.id, p.managerId, p.assignedManagerName, p.assignedManagerAvatarUrl)}
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
      ['Assigned Manager',    managerCellHTML('parcel', p._uuid, p.parcelName || p.id, p.managerId, p.assignedManagerName, p.assignedManagerAvatarUrl)],
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
      ['Assigned Manager',  managerCellHTML('estate', e._id, e.name, e.managerId, e.assignedManagerName, e.assignedManagerAvatarUrl)],
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
      ['Assigned Manager',   managerCellHTML('block', b._uuid, b.name || b.id, b.managerId, b.assignedManagerName, b.assignedManagerAvatarUrl)],
      ['Manager Name (legacy)',  b.managerName || '—'],
      ['Manager Phone (legacy)', b.managerPhone || '—'],
      ['Soil Type',          b.soilType || '—'],
      ['Soil pH',            b.soilPh || '—'],
      ['Irrigation Type',    b.irrigationType || '—'],
      ['Ownership',          b.ownership || '—'],
      ['Geometry Status',    b.geometryStatus ? titleCaseLocal(b.geometryStatus) : '—'],
      ['Cultivation Status', b.cultivationStatus ? titleCaseLocal(b.cultivationStatus) : '—'],
      ['Last Harvest Date',  b.lastHarvestDate || '—'],
      ['Harvest Tonnes',     b.harvestTonnes ? b.harvestTonnes + ' t' : '—'],
      ['Cultivation Notes',  b.cultivationNotes || '—'],
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

  window.confirmDeleteEstate = function(id, name) {
    const e = DATA.estates.find(x=>x.id===id);
    showModal(`
      <div class="modal-title">Delete Estate</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">
        Are you sure you want to delete <strong>${name}</strong>? Blocks and plots referencing this estate name will remain but lose their estate link. This action cannot be undone.
      </p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="submitDeleteEstate('${e?._id}')">Yes, Delete</button>
      </div>`);
  };

  window.submitDeleteEstate = async function(estateDbId) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_estate').delete().eq('id', estateDbId);
      if (error) throw error;
      closeModal();
      showToast('Estate deleted', 'red');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to delete estate: ' + err.message, 'red');
    }
  };

  // ── MANAGER LINKING ──
  // Estate / Block / Plot: one manager each, stored as a direct FK
  // (vsl_estate.manager_id / vsl_blocks.manager_id / vsl_parcels.manager_id
  // → vsl_profiles). All three scopes share the same assign/remove/view flow.
  const MANAGER_TABLE_BY_SCOPE = { estate: 'vsl_estate', block: 'vsl_blocks', parcel: 'vsl_parcels' };
  const MANAGER_MODAL_TITLE_BY_SCOPE = { estate: 'Assign Estate Manager', block: 'Assign Block Manager', parcel: 'Assign Plot Manager' };

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
      : scopeType === 'block'
      ? DATA.blocks.find(x => x._uuid === scopeId)
      : DATA.plots.find(x => x._uuid === scopeId);
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
        <div class="form-group"><label class="form-label">Estate</label>
          <select class="form-input" id="ab-estate">${DATA.estates.map(e=>`<option value="${e._id}">${e.name}</option>`).join('')}</select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Expected Area (acres)</label><input class="form-input" id="ab-area" type="number" placeholder="0.00"></div>
        <div class="form-group"><label class="form-label">Cultivation Status</label>
          <select class="form-input" id="ab-status"><option value="not_in_cane">Not in Cane</option><option value="planted">Planted</option><option value="replant_renovation">Replant / Renovation</option></select></div>
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
    const status = document.getElementById('ab-status').value;
    if (!code) { showToast('Block code is required','red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_blocks').insert([{
        block_code: code, block_name: code, estate_id: estateId || null,
        expected_area_acres: area || null, cultivation_status: status,
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
        <div class="form-group"><label class="form-label">Cultivation Status</label>
          <select class="form-input" id="eb-status">
            <option value="not_in_cane" ${b.cultivationStatus==='not_in_cane'?'selected':''}>Not in Cane</option>
            <option value="planted" ${b.cultivationStatus==='planted'?'selected':''}>Planted</option>
            <option value="replant_renovation" ${b.cultivationStatus==='replant_renovation'?'selected':''}>Replant / Renovation</option>
          </select></div>
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
    const status = document.getElementById('eb-status').value;
    const area = document.getElementById('eb-area').value;
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_blocks').update({
        block_code: code, block_name: code, cultivation_status: status, expected_area_acres: area || null,
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
    showModal(`
      <div class="modal-title">Delete Block</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">
        Delete <strong>${b?.name || id}</strong>? Plots referencing this block will lose their block link. This cannot be undone.
      </p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="submitDeleteBlock('${b?._uuid}')">Yes, Delete</button>
      </div>`);
  };

  window.submitDeleteBlock = async function(blockDbId) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_blocks').delete().eq('id', blockDbId);
      if (error) throw error;
      closeModal();
      showToast('Block deleted', 'red');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to delete block: ' + err.message, 'red');
    }
  };

  // ── PLOT (PARCEL) MODALS ──
  window.showAddPlotModal = function() {
    showModal(`
      <div class="modal-title">Add New Plot</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Plot Code</label><input class="form-input" id="ap-code" placeholder="e.g. P-25"></div>
        <div class="form-group"><label class="form-label">Block</label>
          <select class="form-input" id="ap-block">${DATA.blocks.map(b=>`<option value="${b._uuid}">${b.name || b.id} (${b.estate})</option>`).join('')}</select></div>
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
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_parcels').insert([{
        block_id: blockId, parcel_code: code, parcel_name: code,
        expected_area_acres: area || null, ratoon_number: ratoon || 0,
        planting_date: planted || null,
        cultivation_status: 'not_in_cane',
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

  window.showEditPlotModal = function(id) {
    const p = DATA.plots.find(x=>x.id===id);
    if (!p) return;
    showModal(`
      <div class="modal-title">Edit Plot — ${p.parcelName || p.id}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Cultivation Status</label>
          <select class="form-input" id="ep-status">
            <option value="not_in_cane" ${p.cultivationStatus==='not_in_cane'?'selected':''}>Not in Cane</option>
            <option value="planted" ${p.cultivationStatus==='planted'?'selected':''}>Planted</option>
            <option value="ratoon" ${p.cultivationStatus==='ratoon'?'selected':''}>Ratoon</option>
            <option value="replant_renovation" ${p.cultivationStatus==='replant_renovation'?'selected':''}>Replant / Renovation</option>
          </select></div>
        <div class="form-group"><label class="form-label">Ratoon Number</label><input class="form-input" id="ep-ratoon" type="number" value="${p.ratoon||0}"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Planting Date</label><input class="form-input" id="ep-planted" type="date" value="${p.planted||''}"></div>
        <div class="form-group"><label class="form-label">Expected Harvest</label><input class="form-input" id="ep-harvest" type="date" value="${p.expectedHarvest||''}"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Harvest Tonnage (if harvested)</label>
        <input class="form-input" id="ep-yield" type="number" value="${p.yield||''}"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitEditPlot('${p._uuid}')">Save Changes</button>
      </div>`);
  };

  window.submitEditPlot = async function(parcelDbId) {
    const status = document.getElementById('ep-status').value;
    const ratoon = document.getElementById('ep-ratoon').value;
    const planted = document.getElementById('ep-planted').value;
    const harvest = document.getElementById('ep-harvest').value;
    const yieldT = document.getElementById('ep-yield').value;
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_parcels').update({
        cultivation_status: status, ratoon_number: ratoon || 0,
        planting_date: planted || null, expected_harvest_date: harvest || null,
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
  const harvestedParcels = DATA.plots.filter(p => p.yield && parseFloat(p.yield) > 0);
  const totalHarvested = harvestedParcels.reduce((s,p) => s + parseFloat(p.yield), 0);

  // Build per-estate harvest rollup for bar chart
  const estateYields = DATA.estates.map(e => ({
    name: e.name,
    tonnes: harvestedParcels.filter(p => p.estate === e.name).reduce((s, p) => s + parseFloat(p.yield), 0),
  }));

  el.innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-header-title">Harvest Tracking</div>
      <div class="page-header-sub">Harvest records from live plot data${DATA.isLive ? '' : ' · placeholder data'}</div>
    </div>
  </div>
  <div class="grid-4">
    <div class="stat-card green"><div class="stat-label">Total Harvested</div>
      <div class="stat-value">${fmt(totalHarvested.toFixed(1))}<span style="font-size:14px"> t</span></div>
      <div class="stat-meta">${pct(totalHarvested, DATA.stats.targetYieldTonnes)}% of estimated target</div></div>
    <div class="stat-card amber"><div class="stat-label">Estimated Target</div>
      <div class="stat-value">${fmt(DATA.stats.targetYieldTonnes)}<span style="font-size:14px"> t</span></div>
      <div class="stat-meta">~3.2 t/ac placeholder estimate <span class="placeholder-tag">Est.</span></div></div>
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
      ['Harvest Tonnage',     p.yield ? p.yield + ' t' : '—'],
      ['Yield per Ac',        p.yield && p.areaHa ? (p.yield/(p.areaHa*2.47105)).toFixed(2) + ' t/ac' : '—'],
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
//  PAGE: ACTIVITIES
// ══════════════════════════════════════

const ACTIVITY_TYPES = ['Bush Clearing','Ploughing','Harrow','Ripping','Ridging','Furrowing',
  'Lime Application','Planting','Manuring','Fertilization','Weeding','Spraying','Irrigation',
  'Harvesting','Loading','Trash Lining','Trash Collection'];

function renderActivities(el) {
  let estFilter = '';
  const acts = () => DATA.activities.filter(a => !estFilter || a.estate === estFilter);

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
        <th>Assigned To</th><th>Team</th><th>Completion</th><th>Actions</th></tr></thead>
        <tbody>
          ${rows.length ? rows.map(a=>`
            <tr style="cursor:pointer" onclick="viewActivityDetail('${a.id}')">
              <td>${a.date || '—'}</td>
              <td><strong>${a.name}</strong></td>
              <td>${a.estate}</td>
              <td>${a.block}</td>
              <td>${a.parcel || '—'}</td>
              <td>${a.assignedTo || '—'}</td>
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
      <button class="btn btn-primary btn-sm" onclick="showAddActivityModal()">+ Log Activity</button>
    </div>
  </div>
  <div class="grid-4">
    <div class="stat-card green"><div class="stat-label">Total Logged</div><div class="stat-value">${DATA.activities.length}</div></div>
    <div class="stat-card blue"><div class="stat-label">Last 7 Days</div><div class="stat-value">${thisWeek}</div></div>
    <div class="stat-card amber"><div class="stat-label">Activity Types Used</div><div class="stat-value">${distinctTypes}</div><div class="stat-meta">of ${ACTIVITY_TYPES.length} defined</div></div>
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
      ['Challenges', a.challenges || '—'],
      ['Comments', a.comments || '—'],
      ['Logged', a.createdAt ? a.createdAt.replace('T',' ').slice(0,16) : '—'],
    ];
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

  function scopePickerHTML(prefix, blockVal, parcelVal) {
    return `
      <div class="form-group"><label class="form-label">Block</label>
        <select class="form-input" id="${prefix}-block" onchange="onActivityBlockChange('${prefix}')">
          <option value="">— None (estate-level) —</option>
          ${DATA.blocks.map(b=>`<option value="${b._uuid}" ${b._uuid===blockVal?'selected':''}>${b.name || b.id} (${b.estate})</option>`).join('')}
        </select></div>
      <div class="form-group"><label class="form-label">Plot (optional)</label>
        <select class="form-input" id="${prefix}-parcel">
          <option value="">— Whole block —</option>
          ${DATA.plots.filter(p=>p._blockUuid===blockVal).map(p=>`<option value="${p._uuid}" ${p._uuid===parcelVal?'selected':''}>${p.parcelName || p.id}</option>`).join('')}
        </select></div>`;
  }
  window.onActivityBlockChange = function(prefix) {
    const blockVal = document.getElementById(`${prefix}-block`).value;
    const parcelSel = document.getElementById(`${prefix}-parcel`);
    parcelSel.innerHTML = `<option value="">— Whole block —</option>` +
      DATA.plots.filter(p=>p._blockUuid===blockVal).map(p=>`<option value="${p._uuid}">${p.parcelName || p.id}</option>`).join('');
  };

  window.showAddActivityModal = function() {
    showModal(`
      <div class="modal-title">Log New Activity</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Activity Type</label>
          <select class="form-input" id="aa-name">${ACTIVITY_TYPES.map(t=>`<option>${t}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Date</label>
          <input class="form-input" id="aa-date" type="date" value="${new Date().toISOString().slice(0,10)}"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        ${scopePickerHTML('aa','','')}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Team Size</label><input class="form-input" id="aa-team" type="number" min="0"></div>
        <div class="form-group"><label class="form-label">Completion (%)</label><input class="form-input" id="aa-completion" type="number" min="0" max="100" step="1"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Challenges</label><textarea class="form-input" id="aa-challenges" rows="2"></textarea></div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Comments</label><textarea class="form-input" id="aa-comments" rows="2"></textarea></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddActivity()">Save Activity</button>
      </div>`);
  };

  window.submitAddActivity = async function() {
    const name = document.getElementById('aa-name').value;
    const date = document.getElementById('aa-date').value || null;
    const blockId = document.getElementById('aa-block').value || null;
    const parcelId = document.getElementById('aa-parcel').value || null;
    const team = document.getElementById('aa-team').value;
    const completion = document.getElementById('aa-completion').value;
    const challenges = document.getElementById('aa-challenges').value.trim();
    const comments = document.getElementById('aa-comments').value.trim();
    try {
      const client = getSbClient();
      const block = DATA.blocks.find(b => b._uuid === blockId);
      const estateRow = block ? DATA.estates.find(e => e.name === block.estate) : null;
      const { error } = await client.from('vsl_activities').insert([{
        activity_name: name, activity_date: date,
        block_id: blockId, parcel_id: parcelId, estate_id: estateRow ? estateRow._id : null,
        team_size: team || null, completion_value: completion || null,
        challenges: challenges || null, comments: comments || null,
      }]);
      if (error) throw error;
      closeModal();
      showToast('Activity logged');
      await retryLiveDataLoad();
      renderTabIfCurrent('activities');
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
          <select class="form-input" id="ea-name">${ACTIVITY_TYPES.map(t=>`<option ${t===a.name?'selected':''}>${t}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Date</label><input class="form-input" id="ea-date" type="date" value="${a.date||''}"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Team Size</label><input class="form-input" id="ea-team" type="number" value="${a.teamSize ?? ''}"></div>
        <div class="form-group"><label class="form-label">Completion</label><input class="form-input" id="ea-completion" type="number" step="0.01" value="${a.completionValue ?? ''}"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Challenges</label><textarea class="form-input" id="ea-challenges" rows="2">${a.challenges||''}</textarea></div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Comments</label><textarea class="form-input" id="ea-comments" rows="2">${a.comments||''}</textarea></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitEditActivity('${a.id}')">Save Changes</button>
      </div>`);
  };

  window.submitEditActivity = async function(id) {
    const name = document.getElementById('ea-name').value;
    const date = document.getElementById('ea-date').value || null;
    const team = document.getElementById('ea-team').value;
    const completion = document.getElementById('ea-completion').value;
    const challenges = document.getElementById('ea-challenges').value.trim();
    const comments = document.getElementById('ea-comments').value.trim();
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_activities').update({
        activity_name: name, activity_date: date, team_size: team || null,
        completion_value: completion || null, challenges: challenges || null, comments: comments || null,
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
}

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
      <button class="btn btn-primary btn-sm" onclick="showAddCostModal()">+ Log Cost</button>
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

  window.showAddCostModal = function() {
    showModal(`
      <div class="modal-title">Log New Cost</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Cost Type</label>
          <select class="form-input" id="ac-type">${COST_TYPES.map(t=>`<option>${t}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Amount (UGX)</label><input class="form-input" id="ac-amount" type="number" min="0"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Related Activity (optional)</label>
        <select class="form-input" id="ac-activity">
          <option value="">— No specific activity —</option>
          ${DATA.activities.map(a=>`<option value="${a.id}">${a.name} — ${a.estate} ${a.date?('· '+a.date):''}</option>`).join('')}
        </select></div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Description</label><input class="form-input" id="ac-desc" placeholder="Optional note"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddCost()">Save Cost</button>
      </div>`);
  };

  window.submitAddCost = async function() {
    const costType = document.getElementById('ac-type').value;
    const amount = document.getElementById('ac-amount').value;
    const activityId = document.getElementById('ac-activity').value || null;
    const desc = document.getElementById('ac-desc').value.trim();
    if (!amount || Number(amount) <= 0) { showToast('Enter a valid amount', 'red'); return; }
    try {
      const client = getSbClient();
      const activity = activityId ? DATA.activities.find(a => a.id === activityId) : null;
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
      <button class="btn btn-primary btn-sm" onclick="showAddDocumentModal()">+ Add Document</button>
      <button class="btn btn-outline btn-sm" onclick="showAddMediaModal()">+ Add Media</button>
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
const ROLE_LABEL_MAP = { ADMIN: 'Admin', SURVEYOR: 'Surveyor', MANAGMENT: 'Management' };
const ROLE_COLOR_MAP = { Admin: 'red', Surveyor: 'blue', Management: 'green' };

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
    <div><div class="page-header-title">User Management</div>
    <div class="page-header-sub">${DATA.users.length} registered users · admin-only account creation${DATA.isLive ? '' : ' · placeholder data'}</div></div>
    <button class="btn btn-primary btn-sm" onclick="showAddUserModal()">+ Add User</button>
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
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <input class="form-input" style="max-width:200px" placeholder="Search users..."
               oninput="filterUsers(this.value)">
        <select class="form-input" style="width:140px" onchange="filterUsersByRole(this.value)">
          <option value="">All Roles</option>
          ${Object.values(ROLE_LABEL_MAP).map(r=>`<option>${r}</option>`).join('')}
        </select>
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
              <td style="font-size:12px;color:var(--gray-500)">${u.lastLogin}</td>
              <td onclick="event.stopPropagation()"><div style="display:flex;gap:4px;flex-wrap:wrap">
                <button class="icon-btn" onclick="showEditUserModal('${u.id}')" title="Edit">✎</button>
                ${u.status==='active'
                  ? `<button class="icon-btn" onclick="toggleUserActive('${u.id}',false)" title="Deactivate">⏸</button>`
                  : `<button class="icon-btn primary" onclick="toggleUserActive('${u.id}',true)" title="Reactivate">▶</button>`}
                <button class="icon-btn danger" onclick="confirmDeleteUser('${u.id}','${u.name}')" title="Delete">🗑</button>
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

  // Wires a file input's change event to preview the picked image inline
  // (before it's uploaded — upload only happens on form submit).
  function wireAvatarPreview(inputId, previewId) {
    const input = document.getElementById(inputId);
    const preview = document.getElementById(previewId);
    if (!input || !preview) return;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { preview.src = reader.result; preview.style.display = ''; };
      reader.readAsDataURL(file);
    });
  }

  window.showAddUserModal = function() {
    showModal(`
      <div class="modal-title">Add New User</div>
      <p style="font-size:12px;color:var(--gray-500);margin-bottom:12px">
        Creates a real sign-in account and profile. Only admins can do this.
      </p>
      <div class="form-group" style="margin-bottom:12px;display:flex;align-items:center;gap:12px">
        <img id="au-photo-preview" style="width:56px;height:56px;border-radius:50%;object-fit:cover;display:none;flex-shrink:0">
        <div style="flex:1"><label class="form-label">Profile Photo <span style="font-weight:400;color:var(--gray-500)">(optional)</span></label>
          <input class="form-input" id="au-photo" type="file" accept="image/*"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Full Name</label><input class="form-input" id="au-name" placeholder="e.g. Jane Doe"></div>
        <div class="form-group"><label class="form-label">Email</label><input class="form-input" id="au-email" type="email" placeholder="user@example.com"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Temporary Password</label><input class="form-input" id="au-password" type="text" placeholder="At least 8 characters"></div>
        <div class="form-group"><label class="form-label">Role</label>
          <select class="form-input" id="au-role">${Object.entries(ROLE_LABEL_MAP).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Title / Position <span style="font-weight:400;color:var(--gray-500)">(display only)</span></label>
          <input class="form-input" id="au-title" placeholder="e.g. Field Officer, Agronomist"></div>
        <div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="au-phone" placeholder="07XXXXXXXX"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Home Estate</label>
        <select class="form-input" id="au-estate">${estateOptions('')}</select></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddUser()">Create User</button>
      </div>`);
    wireAvatarPreview('au-photo', 'au-photo-preview');
  };

  window.submitAddUser = async function() {
    const full_name = document.getElementById('au-name').value.trim();
    const email = document.getElementById('au-email').value.trim();
    const password = document.getElementById('au-password').value;
    const role = document.getElementById('au-role').value;
    const title = document.getElementById('au-title').value.trim();
    const phone = document.getElementById('au-phone').value.trim();
    const estate_id = document.getElementById('au-estate').value || null;
    const photoFile = document.getElementById('au-photo').files[0] || null;
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) { showToast('Please enter a valid email','red'); return; }
    if (!password || password.length < 8) { showToast('Password must be at least 8 characters','red'); return; }
    try {
      const avatar_url = photoFile ? await uploadAvatarFile(photoFile) : null;
      await callAdminUsersFn('create', { email, password, role, full_name, phone, title, estate_id, avatar_url });
      closeModal();
      showToast('User created successfully');
      await retryLiveDataLoad();
      renderTabIfCurrent('users');
    } catch (err) {
      console.error(err);
      showToast('Failed to add user: ' + err.message, 'red');
    }
  };

  window.showEditUserModal = function(id) {
    const u = DATA.users.find(x=>x.id===id); if (!u) return;
    showModal(`
      <div class="modal-title">Edit User — ${u.name}</div>
      <div class="form-group" style="margin-bottom:12px;display:flex;align-items:center;gap:12px">
        <img id="eu-photo-preview" src="${u.avatarUrl || ''}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;${u.avatarUrl ? '' : 'display:none;'}flex-shrink:0">
        <div style="flex:1"><label class="form-label">Profile Photo</label>
          <input class="form-input" id="eu-photo" type="file" accept="image/*"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Full Name</label><input class="form-input" id="eu-name" value="${u.name}"></div>
        <div class="form-group"><label class="form-label">Role</label>
          <select class="form-input" id="eu-role">${Object.entries(ROLE_LABEL_MAP).map(([k,v])=>`<option value="${k}" ${k===u.roleRaw?'selected':''}>${v}</option>`).join('')}</select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Title / Position</label><input class="form-input" id="eu-title" value="${u.title||''}"></div>
        <div class="form-group"><label class="form-label">Phone</label><input class="form-input" id="eu-phone" value="${u.phone||''}"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Home Estate</label>
        <select class="form-input" id="eu-estate">${estateOptions(u.estateId)}</select></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitEditUser('${u.id}')">Save Changes</button>
      </div>`);
    wireAvatarPreview('eu-photo', 'eu-photo-preview');
  };

  window.submitEditUser = async function(id) {
    const full_name = document.getElementById('eu-name').value.trim();
    const role = document.getElementById('eu-role').value;
    const title = document.getElementById('eu-title').value.trim();
    const phone = document.getElementById('eu-phone').value.trim();
    const estate_id = document.getElementById('eu-estate').value || null;
    const photoFile = document.getElementById('eu-photo').files[0] || null;
    try {
      const payload = { id, full_name, role, title, phone, estate_id };
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
        <button class="btn btn-outline btn-sm" onclick="showEditUserModal('${u.id}')">✏ Edit User</button>
        ${u.status==='active'
          ? `<button class="btn btn-outline btn-sm" onclick="toggleUserActive('${u.id}',false)">⏸ Deactivate</button>`
          : `<button class="btn btn-outline btn-sm" onclick="toggleUserActive('${u.id}',true)">▶ Reactivate</button>`}
        <button class="btn btn-danger btn-sm" onclick="confirmDeleteUser('${u.id}','${(u.name||'').replace(/'/g,"")}')">🗑 Delete</button>
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

  function renderSubList() {
    if (!subscribers.length) return '<div style="padding:20px;text-align:center;color:var(--gray-500)">No subscribers yet.</div>';
    return subscribers.map(s=>`
      <div class="email-row" id="sub-${s.id}">
        <div class="user-avatar" style="font-size:10px;flex-shrink:0">
          ${s.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px">${s.name}</div>
          <div style="font-size:11px;color:var(--gray-500)">${s.email}</div>
        </div>
        <div style="font-size:11px;min-width:80px">${pill(s.frequency,s.frequency==='Weekly'?'blue':s.frequency==='Monthly'?'green':'amber')}</div>
        <div style="font-size:11px;color:var(--gray-500);min-width:100px">${s.estate||'All Estates'}</div>
        <div style="font-size:11px;color:var(--gray-500);min-width:110px">${s.reportType||'Season Summary'}</div>
        <div style="font-size:11px;color:var(--gray-500);min-width:90px">Sent: ${s.lastSent}</div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="icon-btn" onclick="showEditSubscriberModal('${s.id}')" title="Edit">\u270e</button>
          <button class="icon-btn primary" onclick="sendEmailNow('${s.id}','${s.email}')" title="Send Now">\ud83d\udce4</button>
          <button class="icon-btn danger" onclick="removeSubscriber('${s.id}')" title="Remove">\ud83d\uddd1</button>
        </div>
      </div>`).join('');
  }

  const REPORT_TYPES = ['Season Summary Report','Weekly Field Update','Financial Dashboard','Harvest Log','Agronomic Scouting Report','Quarterly Investor Briefing'];

  function subscriberFormFields(prefix, s) {
    return `
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Select Existing User (optional)</label>
        <select class="form-input" id="${prefix}-user" onchange="onSubscriberUserPick('${prefix}')">
          <option value="">\u2014 Enter details manually \u2014</option>
          ${DATA.users.map(u=>`<option value="${u.id}" data-name="${u.name}" data-email="${u.email}">${u.name} (${u.email})</option>`).join('')}
        </select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Full Name</label>
          <input class="form-input" id="${prefix}-name" placeholder="Recipient name" value="${s?.name||''}"></div>
        <div class="form-group"><label class="form-label">Email Address</label>
          <input class="form-input" id="${prefix}-email" type="email" placeholder="email@example.com" value="${s?.email||''}"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Frequency</label>
          <select class="form-input" id="${prefix}-freq">
            ${['Daily','Weekly','Monthly'].map(f=>`<option ${s?.frequency===f?'selected':''}>${f}</option>`).join('')}
          </select></div>
        <div class="form-group"><label class="form-label">Estate</label>
          <select class="form-input" id="${prefix}-estate">
            <option value="All Estates" ${!s||s.estate==='All Estates'?'selected':''}>All Estates</option>
            ${DATA.estates.map(e=>`<option ${s?.estate===e.name?'selected':''}>${e.name}</option>`).join('')}
          </select></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Report Type</label>
        <select class="form-input" id="${prefix}-type">
          ${REPORT_TYPES.map(t=>`<option ${s?.reportType===t?'selected':''}>${t}</option>`).join('')}
        </select></div>`;
  }

  window.onSubscriberUserPick = function(prefix) {
    const sel = document.getElementById(`${prefix}-user`);
    const opt = sel.options[sel.selectedIndex];
    if (!opt || !opt.value) return;
    document.getElementById(`${prefix}-name`).value = opt.dataset.name || '';
    document.getElementById(`${prefix}-email`).value = opt.dataset.email || '';
  };

  window.showAddSubscriberModal = function() {
    showModal(`
      <div class="modal-title">Add Subscriber</div>
      ${subscriberFormFields('nsub', null)}
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="addSubscriber()">Save Subscriber</button>
      </div>`);
  };

  window.showEditSubscriberModal = function(id) {
    const s = subscribers.find(x => x.id === id);
    if (!s) return;
    showModal(`
      <div class="modal-title">Edit Subscriber \u2014 ${s.name}</div>
      ${subscriberFormFields('esub', s)}
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitEditSubscriber('${s.id}')">Save Changes</button>
      </div>`);
  };

  window.submitEditSubscriber = async function(id) {
    const name       = document.getElementById('esub-name').value.trim();
    const email      = document.getElementById('esub-email').value.trim();
    const freq       = document.getElementById('esub-freq').value;
    const estate     = document.getElementById('esub-estate').value;
    const reportType = document.getElementById('esub-type').value;
    if (!name || !email) { showToast('Please fill in name and email','red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_report_recipients').update({
        name, email, freq, estate: estate || 'All Estates', report_type: reportType || 'Season Summary Report',
      }).eq('id', id);
      if (error) throw error;
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

  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">Reports</div>
    <div class="page-header-sub">Manage automated report distribution</div></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="showAddSubscriberModal()">+ Add Subscriber</button>
      <button class="btn btn-amber btn-sm" onclick="sendAllEmails()">\ud83d\udce4 Send Report to All</button>
    </div>
  </div>

  <div class="grid-3" style="margin-bottom:20px">
    <div class="stat-card blue"><div class="stat-label">Subscribers</div>
      <div class="stat-value" id="sub-count">${subscribers.length}</div>
      <div class="stat-meta">Active recipients</div></div>
    <div class="stat-card green"><div class="stat-label">Last Batch Sent</div>
      <div class="stat-value" style="font-size:18px">\u2014</div><div class="stat-meta">Not yet sent</div></div>
    <div class="stat-card amber"><div class="stat-label">Next Scheduled</div>
      <div class="stat-value" style="font-size:18px">\u2014</div><div class="stat-meta">Delivery backend coming soon</div></div>
  </div>

  <!-- SUBSCRIBER LIST -->
  <div class="card" style="margin-bottom:20px">
    <div class="card-header">
      <div class="card-title">Subscriber List</div>
      <div style="font-size:12px;color:var(--gray-500)">Click Send Now to dispatch a report immediately</div>
    </div>
    <div style="display:flex;padding:8px 12px;background:var(--gray-50);border-radius:var(--radius-sm);font-size:10px;font-weight:700;color:var(--gray-500);gap:10px;letter-spacing:.6px;margin-bottom:4px;flex-wrap:wrap">
      <span style="width:32px"></span>
      <span style="flex:1">RECIPIENT</span>
      <span style="min-width:80px">FREQUENCY</span>
      <span style="min-width:100px">ESTATE</span>
      <span style="min-width:110px">REPORT TYPE</span>
      <span style="min-width:90px">LAST SENT</span>
      <span style="min-width:130px">ACTIONS</span>
    </div>
    <div id="subscribers-list">${renderSubList()}</div>
  </div>

  <!-- SCHEDULE SETTINGS -->
  <div class="card">
    <div class="card-header"><div class="card-title">Automated Schedule Settings</div></div>
    ${[
      ['Weekly Field Update','Sent every Monday 07:00 AM to field officers','wt',true],
      ['Monthly Estate Summary','Sent 1st of each month to land managers','mt',true],
      ['Harvest Alert Report','Sent immediately when a harvest is recorded','ht',true],
      ['Low Yield Alert','Sent when yield drops 15% below target','yt',false],
      ['Quarterly Investor Report','Sent quarterly to investors only','qt',true],
      ['Pest & Disease Alert','Sent when scouting flags high-severity issue','pt',true],
    ].map(([l,d,id,on])=>`
      <div class="settings-row">
        <div><div class="settings-label">${l}</div><div class="settings-desc">${d}</div></div>
        <label class="toggle-switch">
          <input type="checkbox" id="${id}" ${on?'checked':''} onchange="showToast('Schedule updated')">
          <span class="toggle-slider"></span>
        </label>
      </div>`).join('')}
  </div>`;

  window.addSubscriber = async function() {
    const name       = document.getElementById('nsub-name').value.trim();
    const email      = document.getElementById('nsub-email').value.trim();
    const freq       = document.getElementById('nsub-freq').value;
    const estate     = document.getElementById('nsub-estate').value;
    const reportType = document.getElementById('nsub-type').value;
    if (!name || !email) { showToast('Please fill in name and email','red'); return; }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) { showToast('Invalid email address','red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_report_recipients').insert([{
        email,
        name,
        freq, // 'Daily' | 'Weekly' | 'Monthly' — matches the vsl_report_recipients.freq enum's Title Case labels
        estate: estate || 'All Estates',
        report_type: reportType || 'Season Summary Report',
      }]);
      if (error) throw error;
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

  window.removeSubscriber = async function(id) {
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

  window.sendEmailNow = function(id, email) {
    showToast(`Report dispatched to ${email}`);
  };

  window.sendAllEmails = function() {
    showModal(`
      <div class="modal-title">Send Report to All Subscribers</div>
      <p style="font-size:13px;color:var(--gray-700);margin-bottom:14px">
        Dispatch a report to all <strong>${subscribers.length} subscribers</strong> now.
      </p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Report Type</label>
          <select class="form-input">
            <option>Season Summary Report</option>
            <option>Weekly Field Update</option>
            <option>Financial Dashboard</option>
            <option>Harvest Log</option>
            <option>Agronomic Scouting Report</option>
            <option>Quarterly Investor Briefing</option>
          </select></div>
        <div class="form-group"><label class="form-label">Estate Filter</label>
          <select class="form-input">
            <option>All Estates</option>
            ${DATA.estates.map(e=>`<option>${e.name}</option>`).join('')}
          </select></div>
      </div>
      <div class="form-group" style="margin-bottom:14px">
        <label class="form-label">Additional Note (Optional)</label>
        <textarea class="form-input" rows="3" placeholder="Add a note to include in the email..."></textarea>
      </div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-amber" onclick="closeModal();showToast('Report sent to ${subscribers.length} subscribers \u2713')">Send Now</button>
      </div>`);
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
              <button class="icon-btn danger" onclick="confirmDeleteAlert('${a.id}')" title="Delete">\ud83d\uddd1</button>
            </div></td>
        </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--gray-500);padding:24px">No resolved alerts yet</td></tr>`}
      </tbody></table></div>`;
  }

  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">Alerts &amp; Notifications</div>
    <div class="page-header-sub">${DATA.alerts.filter(a=>a.type==='critical').length} critical \u00b7 ${DATA.alerts.filter(a=>a.type==='warning').length} warnings</div></div>
    <button class="btn btn-primary btn-sm" onclick="showAddAlertModal()">+ New Alert</button>
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
      ['Status', isResolved ? 'Resolved' : 'Open'],
      ...(isResolved ? [['Resolution', a.resolutionNote || '—'], ['Resolved', a.resolvedTime || '—']] : []),
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
        <button class="btn btn-danger" onclick="closeModal();confirmDeleteAlert('${a.id}')">🗑 Delete</button>
      </div>` : ''}`);
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
function showModal(html) {
  const overlay = document.getElementById('modalOverlay');
  if (!overlay) { console.error('dashboard/windows/modal-shell.html did not load'); return; }

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

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

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
}

// ══════════════════════════════════════
//  SIDEBAR ESTATE HEALTH (populated from live data)
// ══════════════════════════════════════

function renderSidebarEstateHealth() {
  const el = document.getElementById('sidebar-estate-health-list');
  if (!el) return;
  if (!DATA.estates || DATA.estates.length === 0) {
    el.innerHTML = `<div class="estate-status-row"><span class="dot gray"></span><span class="nav-label">No estates found</span></div>`;
    return;
  }
  const dotClass = h => h === 'good' ? 'green' : h === 'watch' ? 'amber' : 'red';
  const labelText = h => h === 'good' ? 'Good' : h === 'watch' ? 'Watch' : 'Alert';
  el.innerHTML = DATA.estates.map(e => `
    <div class="estate-status-row">
      <span class="dot ${dotClass(e.health)}"></span>
      <span class="nav-label">${e.name}</span>
      <span class="ml-auto nav-label">${labelText(e.health)}</span>
    </div>`).join('');

  const badge = document.getElementById('topbar-alert-count');
  if (badge) badge.textContent = (DATA.alerts || []).filter(a => !a.isReal || a.status !== 'resolved').length;
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
    topbarAvatarEl.title = me.name + ' — View my profile';
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

  // Show placeholder sidebar health immediately, then refresh once live data lands
  renderSidebarEstateHealth();

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
  renderSidebarEstateHealth();
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
  renderSidebarEstateHealth();
  showDataSourceBanner('Could not reach Supabase — showing placeholder data.');
});
