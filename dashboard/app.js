// ══════════════════════════════════════
//  SUGARESTATE ADMIN — APP.JS
// ══════════════════════════════════════

let activeCharts = [];
let sidebarCollapsed = false;
let panelOpen = false;
let currentPage = null;

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
function fmtHa(n)   { return n != null ? Number(n).toFixed(1) + ' ha' : '—'; }
function pct(a, b)  { return b ? Math.round((a / b) * 100) : 0; }
function titleCaseLocal(str) {
  if (!str) return str;
  return String(str).replace(/_/g, ' ').replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
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

// ── SIDEBAR TOGGLE ──────────────────────

function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  const panel = document.getElementById('panel');
  sidebarCollapsed = !sidebarCollapsed;
  sb.classList.toggle('collapsed', sidebarCollapsed);
  // Shift panel left edge
  const w = sidebarCollapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)';
  panel.style.left = w;
  document.getElementById('panel-backdrop').style.left = w;
}

// ── PANEL OPEN / CLOSE ────────────────────

const PAGE_TITLES = {
  dashboard:     'Dashboard',
  analytics:     'Estate Analytics',
  estates:       'Estates, Blocks & Plots',
  production:    'Production',
  activities:    'Activities',
  users:         'Users',
  notifications: 'Email Reports',
  alerts:        'Alerts & Notifications',
  settings:      'Settings',
};

function openPanel(page, navEl) {
  // Update active nav item
  if (navEl) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    navEl.classList.add('active');
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
    users:         renderUsers,
    notifications: renderNotifications,
    alerts:        renderAlerts,
    settings:      renderSettings,
  };
  if (pages[page]) pages[page](body);

  // Open the panel
  const panel = document.getElementById('panel');
  const backdrop = document.getElementById('panel-backdrop');
  panel.classList.add('open');
  backdrop.classList.add('visible');
  panelOpen = true;

  // Set left offset based on sidebar state
  const w = sidebarCollapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)';
  panel.style.left = w;
  backdrop.style.left = w;

  setTimeout(() => initCharts(page), 60);
}

function closePanel() {
  const panel    = document.getElementById('panel');
  const backdrop = document.getElementById('panel-backdrop');
  panel.classList.remove('open');
  backdrop.classList.remove('visible');
  panelOpen = false;
  destroyCharts();
  // Deactivate nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
}

// Keyboard ESC closes panel
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && panelOpen) closePanel();
});

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
          <div class="card-sub">Actual vs Target · Season 2024-B</div>
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
    <div class="card-header"><div class="card-title">Quality &amp; Efficiency Indicators</div></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));border:1px solid var(--gray-100);border-radius:var(--radius-sm);overflow:hidden">
      ${[
        ['Avg Brix',s.avgBrix+'%','Sugar content'],
        ['Avg Sucrose',s.avgSucrose+'%','Pol purity'],
        ['Yield / Ha',s.avgYieldPerHa+' t','Season avg'],
        ['Active Blocks',18,'Of '+s.totalBlocks],
        ['Estates',s.totalEstates,'Operational'],
        ['Harvest Ready','14 plots','Next 30 days'],
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
  el.innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-header-title">Estate Analytics</div>
      <div class="page-header-sub">Comprehensive estate performance data</div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <select class="form-input" style="width:140px">
        <option>All Estates</option>
        ${DATA.estates.map(e=>`<option>${e.name}</option>`).join('')}
      </select>
      <select class="form-input" style="width:120px">
        <option>Season 2024-B</option><option>Season 2024-A</option><option>Season 2023-B</option>
      </select>
      <button class="btn btn-primary btn-sm">Export PDF</button>
    </div>
  </div>

  <div class="card" style="margin-bottom:20px">
    <div class="card-header">
      <div class="card-title">Area Status by Block</div>
      <div style="display:flex;gap:14px;font-size:11px;color:var(--gray-500);flex-wrap:wrap">
        <span><span style="display:inline-block;width:10px;height:10px;background:var(--green-400);border-radius:2px;margin-right:4px"></span>Planted</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:var(--amber-300);border-radius:2px;margin-right:4px"></span>Fallow</span>
        <span><span style="display:inline-block;width:10px;height:10px;background:var(--gray-300);border-radius:2px;margin-right:4px"></span>Reserved</span>
      </div>
    </div>
    ${DATA.blocks.map(b=>{
      const fallow   = b.areaHa - b.plantedHa;
      const reserved = b.areaHa * 0.05;
      const pPct = pct(b.plantedHa, b.areaHa);
      const fPct = pct(fallow - reserved, b.areaHa);
      const rPct = pct(reserved, b.areaHa);
      return `
      <div class="area-block">
        <div class="area-block-header">
          <div class="area-block-name">${b.id} <span style="font-weight:400;color:var(--gray-500)">· ${b.estate}</span></div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="area-block-ha">${fmtHa(b.plantedHa)} / ${fmtHa(b.areaHa)}</span>
            ${healthPill(b.status)}
          </div>
        </div>
        <div class="area-segment-row">
          <div class="area-seg" style="width:${pPct}%;background:var(--green-400)"></div>
          <div class="area-seg" style="width:${fPct}%;background:var(--amber-300)"></div>
          <div class="area-seg" style="width:${rPct}%;background:var(--gray-300)"></div>
        </div>
        <div style="display:flex;gap:16px;font-size:11px;color:var(--gray-500);flex-wrap:wrap">
          <span>Planted: <strong>${pPct}%</strong></span>
          <span>Fallow: <strong>${fPct}%</strong></span>
          <span>Avg Yield: <strong>${b.avgYield} t/ha</strong></span>
          <span>Plots: <strong>${b.plots}</strong></span>
        </div>
      </div>`;
    }).join('')}
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
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Estate</th><th>District</th><th>Manager</th><th>Blocks</th><th>Plots</th>
          <th>Total Area</th><th>Planted</th><th>Utilisation</th><th>Health</th></tr>
        </thead>
        <tbody>
          ${DATA.estates.map(e=>`
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
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <div class="grid-4" style="margin-bottom:20px">
    <div class="stat-card green">
      <div class="stat-label">Total Revenue</div>
      <div class="stat-value" style="font-size:20px">${fmtUGX(DATA.stats.totalRevenue)}</div>
      <div class="stat-meta">Season 2024-B</div>
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
            <th>Plots</th><th>Total Area</th><th>Planted Ha</th>
            <th>Fallow Ha</th><th>Utilisation</th><th>Health</th><th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${estatesData.filter(e=>!selectedEstate||e.name===selectedEstate).map(e=>{
            const st = estateStats(e.name);
            return `
            <tr>
              <td>
                <div style="font-weight:700">${e.name}</div>
                <div style="font-size:11px;color:var(--gray-500)">${e.id}</div>
              </td>
              <td>${e.district}</td>
              <td>${e.manager}</td>
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
              <td>${healthPill(e.health)}</td>
              <td>
                <div style="display:flex;gap:4px">
                  <button class="btn btn-outline btn-sm" onclick="showEditEstateModal('${e.id}')">Edit</button>
                  <button class="btn btn-danger btn-sm" onclick="confirmDeleteEstate('${e.id}','${e.name}')">Delete</button>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
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
      <select class="form-input" style="width:130px" id="blk-status-filter"
              onchange="filterBlocksByStatus(this.value)">
        <option value="">All Statuses</option>
        <option>active</option><option>watch</option><option>alert</option>
      </select>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" onclick="showAddBlockModal()">+ Add Block</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Block ID</th><th>Estate</th><th>Plots</th><th>Total Area</th>
          <th>Planted</th><th>Utilisation</th><th>Avg Yield</th><th>Season</th>
          <th>Status</th><th>Actions</th></tr>
        </thead>
        <tbody id="blocks-tbody">
          ${filtered.map(b=>`
            <tr class="blk-row" data-estate="${b.estate}" data-status="${b.status}"
                style="cursor:pointer" onclick="drillIntoBlock('${b.id}')">
              <td><strong>${b.id}</strong></td>
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
              <td><strong>${b.avgYield}</strong> t/ha</td>
              <td>${b.season}</td>
              <td>${healthPill(b.status)}</td>
              <td onclick="event.stopPropagation()">
                <div style="display:flex;gap:4px">
                  <button class="btn btn-outline btn-sm" onclick="showEditBlockModal('${b.id}')">Edit</button>
                  <button class="btn btn-danger btn-sm" onclick="confirmDeleteBlock('${b.id}')">Del</button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="font-size:12px;color:var(--gray-500);margin-top:10px">
      💡 Click any block row to view all plots inside that block
    </div>`;
  }

  // ── TAB: PLOTS (all plots or filtered by block) ──
  function buildPlotsTab(blockId) {
    const filtered = DATA.plots.filter(p =>
      (!selectedEstate || p.estate === selectedEstate) &&
      (!blockId || p.block === blockId)
    );
    const blockLabel = blockId ? ` — Block ${blockId}` : '';
    return `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:flex-end">
      <input class="form-input" style="max-width:180px" placeholder="Search plots..." id="plt-search"
             oninput="filterPlotRows(this.value)">
      <select class="form-input" style="width:150px" onchange="applyEstFilter(this.value)">
        <option value="">All Estates</option>
        ${DATA.estates.map(e=>`<option value="${e.name}" ${selectedEstate===e.name?'selected':''}>${e.name}</option>`).join('')}
      </select>
      <select class="form-input" style="width:140px" id="plt-stage-filter"
              onchange="filterPlotsByStage(this.value)">
        <option value="">All Stages</option>
        <option>Germination</option><option>Tillering</option><option>Grand Growth</option>
        <option>Ripening</option><option>Harvested</option><option>Fallow</option>
      </select>
      <select class="form-input" style="width:130px" id="plt-health-filter"
              onchange="filterPlotsByHealth(this.value)">
        <option value="">All Health</option>
        <option value="good">Good</option><option value="watch">Watch</option>
        <option value="alert">Alert</option>
      </select>
      <div style="margin-left:auto;display:flex;gap:8px">
        ${blockId ? `<button class="btn btn-outline btn-sm" onclick="clearBlockDrill()">← All Blocks</button>` : ''}
        <button class="btn btn-primary btn-sm" onclick="showAddPlotModal()">+ Add Plot</button>
      </div>
    </div>
    ${blockId ? `<div style="padding:8px 12px;background:var(--blue-100);border-radius:var(--radius-sm);margin-bottom:14px;font-size:12px;color:var(--blue-500);font-weight:600">Showing plots in <strong>${blockId}</strong></div>` : ''}
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Plot ID</th><th>Block</th><th>Estate</th><th>Area</th>
          <th>Variety</th><th>Ratoon</th><th>Stage</th><th>Health</th>
          <th>Planted</th><th>Est. Harvest</th><th>Actions</th></tr>
        </thead>
        <tbody id="plots-tbody">
          ${filtered.map(p=>`
            <tr class="plt-row" data-stage="${p.stage}" data-health="${p.health}"
                style="cursor:pointer" onclick="viewPlotDetail('${p.id}')">
              <td><strong style="color:var(--green-700)">${p.id}</strong></td>
              <td>${p.block}</td>
              <td>${p.estate}</td>
              <td>${fmtHa(p.areaHa)}</td>
              <td>${p.variety}</td>
              <td>${p.ratoon===0?'Plant Crop':'Ratoon '+p.ratoon}</td>
              <td>${stagePill(p.stage)}</td>
              <td>${healthPill(p.health)}</td>
              <td>${p.planted||'—'}</td>
              <td>${p.expectedHarvest||'—'}</td>
              <td onclick="event.stopPropagation()">
                <div style="display:flex;gap:4px">
                  <button class="btn btn-outline btn-sm btn-icon" onclick="showEditPlotModal('${p.id}')" title="Edit">✏</button>
                  <button class="btn btn-danger btn-sm btn-icon" onclick="confirmDeletePlot('${p.id}')" title="Delete">🗑</button>
                </div>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="font-size:12px;color:var(--gray-500);margin-top:10px">
      💡 Click any plot row to view full plot details
    </div>`;
  }

  // ── PLOT DETAIL VIEW ──
  function buildPlotDetail(plotId) {
    const p = DATA.plots.find(x=>x.id===plotId) || DATA.plots[0];
    if (!p) return '<p>Plot not found.</p>';

    const ph = p._placeholders || {}; // placeholder agronomy fields when running on live data
    const tag = ' <span class="placeholder-tag">Not yet recorded</span>';

    const attrs = [
      ['Plot ID',             p.id],
      ['Plot Code',           p.parcelLabel || p.id],
      ['Parcel No.',          p.parcelNo ?? '—'],
      ['Block',               p.block],
      ['Estate',               p.estate],
      ['Area (ha)',           fmtHa(p.areaHa)],
      ['Geometry Status',     p.geometryStatus ? titleCaseLocal(p.geometryStatus) : '—'],
      ['Cultivation Status',  p.cultivationStatus ? titleCaseLocal(p.cultivationStatus) : '—'],
      ['Cane Variety',        (p.variety || '—') + (DATA.isLive ? tag : '')],
      ['Ratoon Number',       p.ratoon===0 ? 'Plant Crop (0)' : 'Ratoon ' + p.ratoon],
      ['Planting Date',       p.planted || '—'],
      ['Expected Harvest',    p.expectedHarvest || '—'],
      ['Growth Stage',        p.stage],
      ['Health Status',       p.health.charAt(0).toUpperCase()+p.health.slice(1)],
      ['Actual Harvest (t)',  p.yield ? p.yield + ' t' : 'Pending harvest'],
      ['Yield per Ha',        p.yield ? (p.yield/p.areaHa).toFixed(2) + ' t/ha' : '—'],
      ['Last Harvest Date',   p.lastHarvestDate || '—'],
      ['Soil Type',           (ph.soilType || '—') + (DATA.isLive ? tag : '')],
      ['Soil pH',             (ph.soilPh || '—') + (DATA.isLive ? tag : '')],
      ['Irrigation Type',     (ph.irrigationType || '—') + (DATA.isLive ? tag : '')],
      ['Drainage Class',      (ph.drainageClass || '—') + (DATA.isLive ? tag : '')],
      ['Brix Reading',        p.yield ? (ph.brix || '—') + '%' + (DATA.isLive ? tag : '') : '—'],
      ['Sucrose (%)',         p.yield ? (ph.sucrose || '—') + '%' + (DATA.isLive ? tag : '') : '—'],
      ['Cultivation Notes',   p.cultivationNotes || '—'],
      ['Agronomy Notes',      p.agronomyNotes || '—'],
      ['Date Created',        p.createdAt ? p.createdAt.replace('T',' ').slice(0,16) : '—'],
      ['Last Updated',        p.updatedAt ? p.updatedAt.replace('T',' ').slice(0,16) : '—'],
      ['Record ID (UUID)',    p._uuid || '—'],
    ];

    return `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-outline btn-sm" onclick="clearPlotDetail()">← Back to Plots</button>
      <div style="font-size:13px;color:var(--gray-500)">Full Plot Record — <strong>${p.id}</strong></div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-outline btn-sm" onclick="showEditPlotModal('${p.id}')">✏ Edit Plot</button>
        <button class="btn btn-danger btn-sm" onclick="confirmDeletePlot('${p.id}')">🗑 Delete Plot</button>
      </div>
    </div>
    <div class="grid-4" style="margin-bottom:20px">
      <div class="stat-card green"><div class="stat-label">Area</div><div class="stat-value" style="font-size:20px">${fmtHa(p.areaHa)}</div></div>
      <div class="stat-card blue"><div class="stat-label">Growth Stage</div><div class="stat-value" style="font-size:16px">${p.stage}</div></div>
      <div class="stat-card amber"><div class="stat-label">Variety</div><div class="stat-value" style="font-size:16px">${p.variety}</div></div>
      <div class="stat-card ${p.health==='good'?'green':p.health==='watch'?'amber':'red'}">
        <div class="stat-label">Health</div>
        <div class="stat-value" style="font-size:16px">${p.health.charAt(0).toUpperCase()+p.health.slice(1)}</div>
      </div>
    </div>
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

  // ── RENDER CONTAINER ──
  function renderTabContent() {
    const container = document.getElementById('estates-tab-content');
    if (!container) return;
    container.innerHTML =
      viewingPlotId  ? buildPlotDetail(viewingPlotId) :
      activeTab==='estates' ? buildEstatesTab() :
      activeTab==='blocks'  ? buildBlocksTab() :
      buildPlotsTab(selectedBlock);
    rebindHelpers();
  }

  // ── RENDER FULL PAGE ──
  el.innerHTML = `
  <div class="page-header">
    <div>
      <div class="page-header-title">Estates, Blocks &amp; Plots</div>
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
    window.filterBlocksByStatus = function(val) {
      document.querySelectorAll('.blk-row').forEach(r=>{
        r.style.display = (!val||r.dataset.status===val) ? '' : 'none';
      });
    };
    window.filterPlotRows = function(val) {
      document.querySelectorAll('#plots-tbody tr').forEach(r=>{
        r.style.display = r.textContent.toLowerCase().includes(val.toLowerCase()) ? '' : 'none';
      });
    };
    window.filterPlotsByStage = function(val) {
      document.querySelectorAll('.plt-row').forEach(r=>{
        r.style.display = (!val||r.dataset.stage===val) ? '' : 'none';
      });
    };
    window.filterPlotsByHealth = function(val) {
      document.querySelectorAll('.plt-row').forEach(r=>{
        r.style.display = (!val||r.dataset.health===val) ? '' : 'none';
      });
    };
    window.drillIntoBlock = function(blockId) {
      selectedBlock = blockId;
      activeTab = 'plots';
      document.querySelectorAll('.tab-btn').forEach(b=>{
        b.classList.toggle('active', b.dataset.tab==='plots');
      });
      renderTabContent();
    };
    window.clearBlockDrill = function() {
      selectedBlock = null;
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
  }

  rebindHelpers();

  window.switchEBPTab = function(tab, btn) {
    activeTab = tab;
    viewingPlotId = null;
    if (tab !== 'plots') selectedBlock = null;
    document.querySelectorAll('#estates-tabs .tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    renderTabContent();
  };

  window.applyEstFilter = function(val) {
    selectedEstate = val;
    renderTabContent();
  };

  // ── ESTATE MODALS ──
  window.showAddEstateModal = function() {
    showModal(`
      <div class="modal-title">Add New Estate</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Estate Name</label><input class="form-input" id="ae-name" placeholder="e.g. Buyala"></div>
        <div class="form-group"><label class="form-label">Manager Name</label><input class="form-input" id="ae-manager" placeholder="e.g. Musa Kaalo"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Manager Phone</label><input class="form-input" id="ae-phone" placeholder="07XXXXXXXX"></div>
        <div class="form-group"><label class="form-label">Location</label><input class="form-input" id="ae-location" placeholder="e.g. Kalere, Wakiso"></div>
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
        estate_name: name, nanager_name: manager || null, manager_phone: phone || null, location: location || null,
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
        <div class="form-group"><label class="form-label">Manager Name</label><input class="form-input" id="ee-manager" value="${e.manager||''}"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Manager Phone</label><input class="form-input" id="ee-phone" value="${e.managerPhone||''}"></div>
        <div class="form-group"><label class="form-label">Location</label><input class="form-input" id="ee-location" value="${e.location||''}"></div>
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
        estate_name: name, nanager_name: manager || null, manager_phone: phone || null, location: location || null,
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
        Are you sure you want to delete <strong>${name}</strong>? Blocks and parcels referencing this estate name will remain but lose their estate link. This action cannot be undone.
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

  // ── BLOCK MODALS ──
  window.showAddBlockModal = function() {
    showModal(`
      <div class="modal-title">Add New Block</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Block Code</label><input class="form-input" id="ab-code" placeholder="e.g. BLOCK21"></div>
        <div class="form-group"><label class="form-label">Estate</label>
          <select class="form-input" id="ab-estate">${DATA.estates.map(e=>`<option>${e.name}</option>`).join('')}</select></div>
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
    const estate = document.getElementById('ab-estate').value;
    const area = document.getElementById('ab-area').value;
    const status = document.getElementById('ab-status').value;
    if (!code) { showToast('Block code is required','red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_blocks').insert([{
        block_code: code, block_name: code, estate_name: estate,
        expected_area_acres: area || null, cultivation_status: status,
        geometry_status: 'pending',
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
      <div class="modal-title">Edit Block — ${b.id}</div>
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
        Delete <strong>${id}</strong>? Parcels referencing this block will lose their block link. This cannot be undone.
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
      <div class="modal-title">Add New Parcel</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Parcel Code</label><input class="form-input" id="ap-code" placeholder="e.g. P-25"></div>
        <div class="form-group"><label class="form-label">Block</label>
          <select class="form-input" id="ap-block">${DATA.blocks.map(b=>`<option value="${b._uuid}">${b.id} (${b.estate})</option>`).join('')}</select></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px">
        <div class="form-group"><label class="form-label">Expected Area (acres)</label><input class="form-input" id="ap-area" type="number" placeholder="0.00"></div>
        <div class="form-group"><label class="form-label">Ratoon Number</label><input class="form-input" id="ap-ratoon" type="number" value="0"></div>
      </div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Planting Date</label><input class="form-input" id="ap-planted" type="date"></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddPlot()">Save Parcel</button>
      </div>`);
  };

  window.submitAddPlot = async function() {
    const code = document.getElementById('ap-code').value.trim();
    const blockId = document.getElementById('ap-block').value;
    const area = document.getElementById('ap-area').value;
    const ratoon = document.getElementById('ap-ratoon').value;
    const planted = document.getElementById('ap-planted').value;
    if (!code) { showToast('Parcel code is required','red'); return; }
    const parentBlock = DATA.blocks.find(b => b._uuid === blockId);
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_parcels').insert([{
        block_id: blockId, parcel_code: code, parcel_label: code,
        expected_area_acres: area || null, ratoon_number: ratoon || 0,
        planting_date: planted || null, estate_name: parentBlock ? parentBlock.estate : null,
        cultivation_status: 'not_in_cane', geometry_status: 'pending',
      }]);
      if (error) throw error;
      closeModal();
      showToast('Parcel added successfully');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to add parcel: ' + err.message, 'red');
    }
  };

  window.showEditPlotModal = function(id) {
    const p = DATA.plots.find(x=>x.id===id);
    if (!p) return;
    showModal(`
      <div class="modal-title">Edit Parcel — ${p.id}</div>
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
        harvest_tonnes: yieldT || null,
      }).eq('id', parcelDbId);
      if (error) throw error;
      closeModal();
      showToast('Parcel updated successfully');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to update parcel: ' + err.message, 'red');
    }
  };

  window.confirmDeletePlot = function(id) {
    const p = DATA.plots.find(x=>x.id===id);
    showModal(`
      <div class="modal-title">Delete Parcel</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">Delete parcel <strong>${id}</strong>? This cannot be undone.</p>
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
      showToast('Parcel deleted', 'red');
      await retryLiveDataLoad();
      renderTabContent();
    } catch (err) {
      console.error(err);
      showToast('Failed to delete parcel: ' + err.message, 'red');
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
      <div class="page-header-title">Production Tracking</div>
      <div class="page-header-sub">Harvest records from live parcel data${DATA.isLive ? '' : ' · placeholder data'}</div>
    </div>
  </div>
  <div class="grid-4">
    <div class="stat-card green"><div class="stat-label">Total Harvested</div>
      <div class="stat-value">${fmt(totalHarvested.toFixed(1))}<span style="font-size:14px"> t</span></div>
      <div class="stat-meta">${pct(totalHarvested, DATA.stats.targetYieldTonnes)}% of estimated target</div></div>
    <div class="stat-card amber"><div class="stat-label">Estimated Target</div>
      <div class="stat-value">${fmt(DATA.stats.targetYieldTonnes)}<span style="font-size:14px"> t</span></div>
      <div class="stat-meta">8 t/ha placeholder estimate <span class="placeholder-tag">Est.</span></div></div>
    <div class="stat-card blue"><div class="stat-label">Parcels Harvested</div>
      <div class="stat-value">${harvestedParcels.length}</div>
      <div class="stat-meta">of ${DATA.plots.length} total parcels</div></div>
    <div class="stat-card green"><div class="stat-label">Avg Yield / Ha</div>
      <div class="stat-value">${DATA.stats.avgYieldPerHa}<span style="font-size:14px"> t</span></div>
      <div class="stat-meta">Across harvested parcels</div></div>
  </div>

  <div class="grid-2" style="margin-bottom:20px">
    <div class="card">
      <div class="card-header"><div class="card-title">Monthly Harvest Trend</div>
        <div style="font-size:11px;color:var(--gray-500)">Actual vs Target · current season</div></div>
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
      <div style="font-size:11px;color:var(--gray-500)">Sourced from vsl_parcels.harvest_tonnes</div></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Parcel</th><th>Block</th><th>Estate</th><th>Last Harvest Date</th>
        <th>Harvest Tonnage</th><th>Area</th><th>Yield/Ha</th><th>Status</th></tr></thead>
        <tbody>
          ${harvestedParcels.length ? harvestedParcels.map(p=>`
            <tr>
              <td><strong>${p.id}</strong></td><td>${p.block}</td><td>${p.estate}</td>
              <td>${p.lastHarvestDate || '—'}</td>
              <td>${p.yield} t</td>
              <td>${fmtHa(p.areaHa)}</td>
              <td>${p.areaHa ? (p.yield/p.areaHa).toFixed(2) : '—'} t/ha</td>
              <td>${stagePill(p.stage)}</td>
            </tr>`).join('') : `<tr><td colspan="8" style="text-align:center;color:var(--gray-500);padding:24px">No harvest records yet</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}

// ══════════════════════════════════════
//  PAGE: ACTIVITIES
// ══════════════════════════════════════

function renderActivities(el) {
  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">Field Activities</div>
    <div class="page-header-sub">Task tracking — not yet captured as a dedicated table in the database</div></div>
  </div>
  <div class="card" style="margin-bottom:20px">
    <div class="card-header">
      <div class="card-title">Recent Field Updates</div>
      <div style="font-size:11px;color:var(--gray-500)">Derived from parcel record changes</div>
    </div>
    ${DATA.recentActivity && DATA.recentActivity.length ? DATA.recentActivity.map(a=>`
      <div class="activity-item">
        <div class="activity-dot ${a.color}">${a.icon}</div>
        <div class="activity-content">
          <div class="activity-text">${a.text}</div>
          <div class="activity-meta">${a.meta}</div>
        </div>
      </div>`).join('') : `<div style="text-align:center;color:var(--gray-500);padding:24px">No recent activity</div>`}
  </div>
  <div class="card">
    <div class="card-header"><div class="card-title">Task Management</div></div>
    <p style="font-size:13px;color:var(--gray-600);line-height:1.6">
      A dedicated field-activity / task table (e.g. <code>vsl_tasks</code>) has not yet been added to the database.
      Once available, this page will show fertilizer applications, weeding, irrigation, and scouting logs per parcel
      with assignment, cost, and completion tracking. <span class="placeholder-tag">Pending schema addition</span>
    </p>
  </div>`;
}

// ══════════════════════════════════════
//  PAGE: USERS
// ══════════════════════════════════════

function renderUsers(el) {
  const roleColors = {Admin:'red','Land Manager':'green','Field Officer':'blue',
                      Investor:'amber',Surveyor:'blue',Agronomist:'green',Stakeholder:'gray'};
  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">User Management</div>
    <div class="page-header-sub">${DATA.users.length} registered users${DATA.isLive ? '' : ' · placeholder data'}</div></div>
    <button class="btn btn-primary btn-sm" onclick="showAddUserModal()">+ Add User</button>
  </div>
  <div class="grid-4">
    ${[['Total Users',DATA.users.length,'blue'],
       ['Admins',DATA.users.filter(u=>u.role==='Admin').length,'red'],
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
          ${['Admin','Land Manager','Field Officer','Investor','Surveyor','Agronomist','Stakeholder'].map(r=>`<option>${r}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>User</th><th>Role</th><th>Estate</th><th>Status</th><th>Last Updated</th><th>Actions</th></tr></thead>
        <tbody id="users-tbody">
          ${DATA.users.map(u=>`
            <tr data-role="${u.role}">
              <td><div class="user-info">
                <div class="user-avatar">${u.avatar}</div>
                <div><div class="user-name">${u.name}</div><div class="user-email">${u.email}</div></div>
              </div></td>
              <td>${pill(u.role,roleColors[u.role]||'gray')}</td>
              <td>${u.estate}</td>
              <td>${pill(u.status==='active'?'Active':'Inactive',u.status==='active'?'green':'gray')}</td>
              <td style="font-size:12px;color:var(--gray-500)">${u.lastLogin}</td>
              <td><div style="display:flex;gap:4px">
                <button class="btn btn-outline btn-sm" onclick="showEditUserModal('${u.id}')">Edit</button>
                <button class="btn btn-danger btn-sm" onclick="confirmDeleteUser('${u.id}','${u.name}')">Remove</button>
              </div></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;

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

  // Map UI role label → real DB role value (vsl_profiles.role)
  const ROLE_TO_DB = {
    'Admin': 'ADMIN',
    'Land Manager': 'MANAGMENT', // NB: matches the misspelled value already used in the DB
    'Surveyor': 'SURVEYOR',
    'Field Officer': 'SURVEYOR',   // closest existing DB role until a dedicated role is added
    'Investor': 'MANAGMENT',
    'Agronomist': 'MANAGMENT',
    'Stakeholder': 'MANAGMENT',
  };

  window.showAddUserModal = function() {
    showModal(`
      <div class="modal-title">Add New User</div>
      <p style="font-size:12px;color:var(--gray-500);margin-bottom:12px">
        This creates a profile record. The user must already have (or separately be issued) a Supabase auth account using the same email for login to work.
      </p>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Email</label>
        <input class="form-input" id="au-email" type="email" placeholder="user@example.com"></div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Role</label>
        <select class="form-input" id="au-role">${Object.keys(ROLE_TO_DB).map(r=>`<option>${r}</option>`).join('')}</select></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitAddUser()">Create User</button>
      </div>`);
  };

  window.submitAddUser = async function() {
    const email = document.getElementById('au-email').value.trim();
    const roleLabel = document.getElementById('au-role').value;
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) { showToast('Please enter a valid email','red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_profiles').insert([{
        email, role: ROLE_TO_DB[roleLabel] || 'MANAGMENT',
      }]);
      if (error) throw error;
      closeModal();
      showToast('User profile created successfully');
      await retryLiveDataLoad();
    } catch (err) {
      console.error(err);
      showToast('Failed to add user: ' + err.message, 'red');
    }
  };

  window.showEditUserModal = function(id) {
    const u = DATA.users.find(x=>x.id===id); if (!u) return;
    showModal(`
      <div class="modal-title">Edit User — ${u.name}</div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Email</label>
        <input class="form-input" id="eu-email" value="${u.email}"></div>
      <div class="form-group" style="margin-bottom:12px"><label class="form-label">Role</label>
        <select class="form-input" id="eu-role">${Object.keys(ROLE_TO_DB).map(r=>`<option ${r===u.role?'selected':''}>${r}</option>`).join('')}</select></div>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitEditUser('${u.id}')">Save Changes</button>
      </div>`);
  };

  window.submitEditUser = async function(profileId) {
    const email = document.getElementById('eu-email').value.trim();
    const roleLabel = document.getElementById('eu-role').value;
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_profiles').update({
        email, role: ROLE_TO_DB[roleLabel] || 'MANAGMENT',
      }).eq('id', profileId);
      if (error) throw error;
      closeModal();
      showToast('User updated successfully');
      await retryLiveDataLoad();
    } catch (err) {
      console.error(err);
      showToast('Failed to update user: ' + err.message, 'red');
    }
  };

  window.confirmDeleteUser = function(id, name) {
    showModal(`
      <div class="modal-title">Remove User</div>
      <p style="font-size:14px;color:var(--gray-700);margin-bottom:20px">Remove <strong>${name}</strong>? This deletes their profile record. This cannot be undone.</p>
      <div class="modal-actions">
        <button class="btn btn-outline" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="submitDeleteUser('${id}')">Yes, Remove</button>
      </div>`);
  };

  window.submitDeleteUser = async function(profileId) {
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_profiles').delete().eq('id', profileId);
      if (error) throw error;
      closeModal();
      showToast('User removed', 'red');
      await retryLiveDataLoad();
    } catch (err) {
      console.error(err);
      showToast('Failed to remove user: ' + err.message, 'red');
    }
  };
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
          <button class="btn btn-amber btn-sm" onclick="sendEmailNow('${s.id}','${s.email}')">Send Now</button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="removeSubscriber('${s.id}')" title="Remove">\u2715</button>
        </div>
      </div>`).join('');
  }

  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">Email Reports</div>
    <div class="page-header-sub">Manage automated report distribution</div></div>
    <button class="btn btn-amber" onclick="sendAllEmails()">\ud83d\udce4 Send Report to All</button>
  </div>

  <div class="grid-3" style="margin-bottom:20px">
    <div class="stat-card blue"><div class="stat-label">Subscribers</div>
      <div class="stat-value" id="sub-count">${subscribers.length}</div>
      <div class="stat-meta">Active recipients</div></div>
    <div class="stat-card green"><div class="stat-label">Last Batch Sent</div>
      <div class="stat-value" style="font-size:18px">Oct 7</div><div class="stat-meta">Weekly report</div></div>
    <div class="stat-card amber"><div class="stat-label">Next Scheduled</div>
      <div class="stat-value" style="font-size:18px">Oct 14</div><div class="stat-meta">Weekly \u2014 auto-send</div></div>
  </div>

  <!-- ADD SUBSCRIBER -->
  <div class="card" style="margin-bottom:20px">
    <div class="card-header"><div class="card-title">Add Email Subscriber</div></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:12px">
      <div class="form-group">
        <label class="form-label">Full Name</label>
        <input class="form-input" id="new-sub-name" placeholder="Recipient name">
      </div>
      <div class="form-group">
        <label class="form-label">Email Address</label>
        <input class="form-input" id="new-sub-email" type="email" placeholder="email@example.com">
      </div>
      <div class="form-group">
        <label class="form-label">Frequency</label>
        <select class="form-input" id="new-sub-freq">
          <option>Weekly</option><option>Monthly</option><option>Quarterly</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Estate</label>
        <select class="form-input" id="new-sub-estate">
          <option value="All Estates">All Estates</option>
          ${DATA.estates.map(e=>`<option>${e.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Report Type</label>
        <select class="form-input" id="new-sub-type">
          <option>Season Summary Report</option>
          <option>Weekly Field Update</option>
          <option>Financial Dashboard</option>
          <option>Harvest Log</option>
          <option>Agronomic Scouting Report</option>
          <option>Quarterly Investor Briefing</option>
        </select>
      </div>
    </div>
    <button class="btn btn-primary" onclick="addSubscriber()">+ Add Subscriber</button>
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
    const name       = document.getElementById('new-sub-name').value.trim();
    const email      = document.getElementById('new-sub-email').value.trim();
    const freq       = document.getElementById('new-sub-freq').value;
    const estate     = document.getElementById('new-sub-estate').value;
    const reportType = document.getElementById('new-sub-type').value;
    if (!name || !email) { showToast('Please fill in name and email','red'); return; }
    if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) { showToast('Invalid email address','red'); return; }
    try {
      const client = getSbClient();
      const { error } = await client.from('vsl_report_recipients').insert([{
        email,
        name,
        freq: freq.toLowerCase(),
        estate: estate || 'All Estates',
        report_type: reportType || 'Season Summary Report',
      }]);
      if (error) throw error;
      document.getElementById('new-sub-name').value = '';
      document.getElementById('new-sub-email').value = '';
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
  el.innerHTML = `
  <div class="page-header">
    <div><div class="page-header-title">Alerts &amp; Notifications</div>
    <div class="page-header-sub">${DATA.alerts.filter(a=>a.type==='critical').length} critical \u00b7 ${DATA.alerts.filter(a=>a.type==='warning').length} warnings</div></div>
    <button class="btn btn-outline btn-sm" onclick="showToast('All alerts marked as read')">Mark all read</button>
  </div>
  <div class="grid-3" style="margin-bottom:20px">
    <div class="stat-card red"><div class="stat-label">Critical</div><div class="stat-value">${DATA.alerts.filter(a=>a.type==='critical').length}</div></div>
    <div class="stat-card amber"><div class="stat-label">Warnings</div><div class="stat-value">${DATA.alerts.filter(a=>a.type==='warning').length}</div></div>
    <div class="stat-card blue"><div class="stat-label">Info</div><div class="stat-value">${DATA.alerts.filter(a=>a.type==='info').length}</div></div>
  </div>
  <div style="margin-bottom:20px">
    ${DATA.alerts.map(a=>`
      <div class="alert-item ${a.type}">
        <div class="alert-icon">${a.type==='critical'?'\ud83d\udea8':a.type==='warning'?'\u26a0\ufe0f':'\u2139\ufe0f'}</div>
        <div style="flex:1">
          <div class="alert-title">${a.title}</div>
          <div class="alert-desc">${a.desc}</div>
          <div class="alert-time">${a.estate} \u00b7 ${a.time}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:flex-start;flex-shrink:0">
          <button class="btn btn-outline btn-sm" onclick="showToast('Alert resolved')">Resolve</button>
          <button class="btn btn-outline btn-sm btn-icon" onclick="showToast('Alert dismissed')">\u2715</button>
        </div>
      </div>`).join('')}
  </div>
  <div class="card">
    <div class="card-header"><div class="card-title">Alert Thresholds &amp; Rules</div></div>
    ${[
      ['Pest scouting overdue','21 days since last scouting','warning'],
      ['Yield below target','15% below season target','warning'],
      ['Planting rate critical','Below 50% of plots planted by mid-season','critical'],
      ['Harvest overdue','14 days past expected harvest date','critical'],
      ['Soil test reminder','90-day cycle per plot','info'],
    ].map(([l,d,t])=>`
      <div class="settings-row">
        <div><div class="settings-label">${l}</div><div class="settings-desc">${d}</div></div>
        ${pill(t.charAt(0).toUpperCase()+t.slice(1), t==='critical'?'red':t==='warning'?'amber':'blue')}
      </div>`).join('')}
  </div>`;
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
          <input class="form-input" value="SugarEstate Management System">
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

function showModal(html) {
  closeModal();
  const bd = document.createElement('div');
  bd.className = 'modal-backdrop';
  bd.id = 'active-modal';
  bd.innerHTML = `<div class="modal-box">${html}</div>`;
  bd.addEventListener('click', e => { if (e.target === bd) closeModal(); });
  document.body.appendChild(bd);
}

function closeModal() {
  const m = document.getElementById('active-modal');
  if (m) m.remove();
}

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
        { label:'Actual', data:pm.actual, backgroundColor:'#2e6647', borderRadius:4, order:2 },
        { label:'Target', data:pm.target, type:'line', borderColor:'#e8a020', borderWidth:2, pointRadius:3, fill:false, tension:.3, order:1 },
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

    const c3 = document.getElementById('chart-plot-status');
    if (c3) reg(new Chart(c3, {
      type: 'bar',
      data: {
        labels: ['Germination','Tillering','Grand Growth','Ripening','Harvested','Fallow','Under Prep'],
        datasets: [{ data:[18,32,48,22,26,38,14], backgroundColor:['#60a5fa','#2563eb','#4a9e6e','#e8a020','#16a34a','#c8d0ce','#f4c56a'], borderRadius:4 }],
      },
      options: { ...defaults, indexAxis:'y',
        scales: {
          x: { grid:{ color:gridColor }, ticks:{ color:tickColor, font:{ size:11 } } },
          y: { grid:{ display:false }, ticks:{ color:tickColor, font:{ size:11 } } },
        },
      },
    }));

    const c4 = document.getElementById('chart-area-util');
    if (c4) reg(new Chart(c4, {
      type: 'doughnut',
      data: {
        labels: ['Planted','Fallow','Reserved'],
        datasets: [{ data:[DATA.stats.plantedAreaHa, DATA.stats.fallowAreaHa, DATA.stats.reservedAreaHa], backgroundColor:['#4a9e6e','#e8a020','#c8d0ce'], borderWidth:2, borderColor:'#fff' }],
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
    if (c6) reg(new Chart(c6, {
      type: 'doughnut',
      data: { labels:DATA.costBreakdown.labels, datasets:[{ data:DATA.costBreakdown.values, backgroundColor:['#1a3d2b','#2e6647','#4a9e6e','#e8a020','#f4c56a','#c0392b','#9fd4b8'], borderWidth:2, borderColor:'#fff' }] },
      options: { ...defaults, cutout:'55%', plugins:{ legend:{ display:true, position:'bottom', labels:{ boxWidth:10, font:{ size:10 } } } } },
    }));

    const c7 = document.getElementById('chart-stage-dist');
    if (c7) reg(new Chart(c7, {
      type: 'doughnut',
      data: {
        labels: ['Germination','Tillering','Grand Growth','Ripening','Harvested','Fallow'],
        datasets: [{ data:[18,32,48,22,26,68], backgroundColor:['#60a5fa','#3b82f6','#4a9e6e','#e8a020','#16a34a','#c8d0ce'], borderWidth:2, borderColor:'#fff' }],
      },
      options: { ...defaults, cutout:'55%', plugins:{ legend:{ display:true, position:'bottom', labels:{ boxWidth:10, font:{ size:10 } } } } },
    }));
  }

  if (page === 'production') {
    const c8 = document.getElementById('chart-harvest-trend');
    if (c8) reg(new Chart(c8, {
      type: 'line',
      data: { labels:DATA.productionMonthly.labels, datasets: [
        { label:'Actual Harvest', data:DATA.productionMonthly.actual, borderColor:'#2e6647', backgroundColor:'rgba(46,102,71,.12)', fill:true, tension:.3, pointRadius:4 },
        { label:'Target', data:DATA.productionMonthly.target, borderColor:'#e8a020', borderDash:[5,4], fill:false, tension:.3, pointRadius:2 },
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

// ══════════════════════════════════════
//  BOOT
// ══════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  // Remap the "Plots & Blocks" nav link to the renamed "estates" page
  document.querySelectorAll('.nav-item').forEach(item => {
    const oc = item.getAttribute('onclick') || '';
    if (oc.includes("openPanel('plots'")) {
      item.setAttribute('onclick', oc.replace("openPanel('plots'", "openPanel('estates'"));
      const lbl = item.querySelector('.nav-label');
      if (lbl) lbl.textContent = ' Estates';
    }
  });

  // Show placeholder sidebar health immediately, then refresh once live data lands
  renderSidebarEstateHealth();

  // Kick off live Supabase data load (defined in supabase-client.js)
  if (typeof initLiveData === 'function') {
    initLiveData();
  } else {
    console.error('initLiveData() not found — supabase-client.js may have failed to load');
    const overlay = document.getElementById('data-loading-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  // Dashboard starts closed — the map background is the home screen
  // Users can click any sidebar item to open the panel
});

// Fired by supabase-client.js once live data has successfully replaced DATA
document.addEventListener('sugarestate:data-ready', () => {
  const overlay = document.getElementById('data-loading-overlay');
  if (overlay) overlay.classList.add('hidden');
  hideDataSourceBanner();
  renderSidebarEstateHealth();
  // If a panel is currently open, re-render it with the fresh live data
  if (panelOpen && currentPage) {
    const activeNav = document.querySelector('.nav-item.active');
    openPanel(currentPage, activeNav);
  }
  showToast('Live estate data loaded');
});

// Fired by supabase-client.js if the live fetch fails — fallback/placeholder data stays in place
document.addEventListener('sugarestate:data-error', () => {
  const overlay = document.getElementById('data-loading-overlay');
  if (overlay) overlay.classList.add('hidden');
  renderSidebarEstateHealth();
  showDataSourceBanner('Could not reach Supabase — showing placeholder data.');
});
