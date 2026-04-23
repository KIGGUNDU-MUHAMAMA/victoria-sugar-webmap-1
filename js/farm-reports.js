/**
 * Block report — database agronomics + Sentinel-2 (NDVI, NDRE, NDMI) from Edge Function.
 * UI: #sentinelAnalyticsPanel. PDF: jspdf, autotable, html2canvas, Chart.js.
 */

/* global ol, Chart, window — globals from webmap */

const CULTIVATION_LABELS = {
  not_in_cane: "Not in cane",
  prepared: "Prepared",
  planted: "Planted",
  standing: "Standing",
  harvested: "Harvested",
  replant_renovation: "Replant / renovation"
};

function fmtNum(n, d = 2) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
}

function countByKey(rows, key) {
  const o = {};
  for (const r of rows) {
    const k = r[key] && String(r[key]) ? String(r[key]) : "not_in_cane";
    o[k] = (o[k] || 0) + 1;
  }
  return o;
}

function sumHarvestTonnes(parcels) {
  let s = 0;
  let n = 0;
  for (const p of parcels) {
    const t = p.harvest_tonnes;
    if (t != null && Number.isFinite(Number(t))) {
      s += Number(t);
      n += 1;
    }
  }
  return { sum: s, n };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function seriesNumericMeans(arr) {
  return (arr || [])
    .map((r) => (r && r.mean != null && Number.isFinite(r.mean) ? r.mean : null))
    .filter((x) => x != null);
}

function minMaxOf(nums) {
  if (!nums || !nums.length) return { min: null, max: null };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

function meanOf(nums) {
  if (!nums || !nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function stdevOf(nums) {
  if (!nums || nums.length < 2) return null;
  const m = meanOf(nums);
  return Math.sqrt(nums.reduce((s, x) => s + (x - m) ** 2, 0) / (nums.length - 1));
}

/** 0.15–0.85 → 0–100 heuristic for “field health” from mean NDVI. */
function fieldHealthScoreFromNdvi(ndvi) {
  if (ndvi == null || !Number.isFinite(ndvi)) return null;
  const t = (ndvi - 0.15) / 0.7;
  return Math.round(100 * Math.max(0, Math.min(1, t)));
}

function zoneFromNdvi(n) {
  if (n == null || !Number.isFinite(n)) return { label: "—", note: "No data" };
  if (n < 0.3) return { label: "Poor", note: "Low vigor / stress" };
  if (n < 0.5) return { label: "Moderate", note: "Below target canopy" };
  if (n < 0.7) return { label: "Good", note: "Healthy canopy" };
  return { label: "Excellent", note: "Strong growth" };
}

/** Field-mean NDRE (B8/B5) — relative commentary only; calibrate to your site. */
function ndreNarrative(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 0.1) return "Red-edge response is low (review canopy / density / N strategy).";
  if (n < 0.2) return "Moderate red-edge (typical for dense ratoon; compare with same period last year).";
  return "Strong red-edge response (favourable chlorophyll signal in dense crop).";
}

/** Field-mean NDMI — relative moisture / stress hint (compare with weather and irrigation). */
function ndmiNarrative(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < -0.05) return "Drier index for this pass — check irrigation and soil moisture in weak plots.";
  if (n < 0.1) return "Transitional / mixed moisture signal (good for follow-up with field walks).";
  return "Wetter / lower stress signal in this pass — still validate low spots in the field.";
}

function buildVslLogoPlaceholderPng() {
  try {
    const c = document.createElement("canvas");
    c.width = 220;
    c.height = 40;
    const g = c.getContext("2d");
    if (!g) return null;
    g.fillStyle = "#1a4d1f";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#e8f5e9";
    g.font = "600 16px system-ui, Segoe UI, sans-serif";
    g.textBaseline = "middle";
    g.fillText("VICTORIA SUGAR", 12, c.height / 2);
    return c.toDataURL("image/png");
  } catch {
    return null;
  }
}

async function loadVslLogoDataUrl() {
  const toDataUrl = (blob) =>
    new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(/** @type {string} */ (r.result));
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });

  for (const name of ["victoria-sugar-logo.png", "victoria-sugar-logo.jpg"]) {
    try {
      const u = new URL(`./assets/${name}`, window.location.href).href;
      const res = await fetch(u);
      if (!res.ok) continue;
      const b = await res.blob();
      const dataUrl = await toDataUrl(b);
      if (dataUrl) return dataUrl;
    } catch {
      /* try next */
    }
  }
  return buildVslLogoPlaceholderPng();
}

/** jspdf@2 UMD: constructor is `window.jspdf.jsPDF` (see webmap.html script order). */
function getJsPDFConstructor() {
  if (typeof window === "undefined" || !window.jspdf || typeof window.jspdf.jsPDF !== "function") {
    return null;
  }
  return window.jspdf.jsPDF;
}

/**
 * @param {unknown} error - e.g. FunctionsHttpError: `context` is the fetch Response, not `{ body: string }`.
 * @returns {Promise<{ httpStatus: number | null, detail: string }>}
 */
async function readFunctionInvokeErrorDetail(error) {
  const ex = error && typeof error === "object" ? error : null;
  if (!ex || !("context" in ex)) {
    return { httpStatus: null, detail: "" };
  }
  const ctx = /** @type {{ context?: unknown }} */ (ex).context;
  if (ctx == null) {
    return { httpStatus: null, detail: "" };
  }
  if (typeof ctx === "object" && ctx !== null && "body" in ctx) {
    const b = /** @type {{ body?: string; status?: number }} */ (ctx).body;
    if (typeof b === "string" && b) {
      const httpStatus =
        typeof (/** @type {{ status?: number }} */ (ctx)).status === "number"
          ? (/** @type {{ status: number }} */ (ctx)).status
          : null;
      let detail = b;
      try {
        const j = /** @type {{ error?: string; message?: string }} */ (JSON.parse(b));
        if (j && typeof j === "object") {
          if (typeof j.error === "string" && j.error) detail = j.error;
          else if (typeof j.message === "string" && j.message) detail = j.message;
        }
      } catch { /* not JSON */ }
      return { httpStatus, detail };
    }
  }
  const r = /** @type {Response} */ (ctx);
  if (typeof r.status !== "number") {
    return { httpStatus: null, detail: "" };
  }
  const httpStatus = r.status;
  if (typeof r.text !== "function" && typeof r.json !== "function") {
    return { httpStatus, detail: "" };
  }
  let raw = "";
  try {
    raw = r.clone && typeof r.clone === "function" ? await r.clone().text() : await r.text();
  } catch {
    return { httpStatus, detail: "" };
  }
  if (!raw) return { httpStatus, detail: "" };
  let detail = "";
  try {
    const j = /** @type {{ error?: string; message?: string }} */ (JSON.parse(raw));
    if (j && typeof j === "object") {
      if (typeof j.error === "string" && j.error) detail = j.error;
      else if (typeof j.message === "string" && j.message) detail = j.message;
    }
  } catch { /* not JSON */ }
  if (!detail && raw.length < 800) detail = raw;
  return { httpStatus, detail };
}

let statsChart = null;
let lastStats = null;
let lastKpis = { ndvi: null, ndre: null, ndmi: null };

/**
 * @param {object} opts
 * @param {import("ol/Map").default} opts.map
 * @param {import("@supabase/supabase-js").SupabaseClient} opts.supabase
 * @param {import("ol/source/Vector").default} opts.blocksSource
 * @param {function(string, boolean=): void} [opts.setStatus]
 * @param {HTMLElement} [opts.statusEl]
 * @param {() => { email?: string, role?: string } | null} [opts.getCurrentUser]
 * @param {object} [opts.cfg] - expects SENTINEL_STATS_FUNCTION name
 */
export function initFarmReports(opts) {
  const { map, supabase, blocksSource, setStatus, statusEl, getCurrentUser, cfg } = opts;

  const blockSelect = document.getElementById("sentinelReportBlockSelect");
  const blockFilter = document.getElementById("sentinelReportBlockFilter");
  const dateFromIn = document.getElementById("sentinelReportDateFrom");
  const dateToIn = document.getElementById("sentinelReportDateTo");
  const btnPreset3m = document.getElementById("sentinelReportPreset3m");
  const btnPreset6m = document.getElementById("sentinelReportPreset6m");
  const btnPreset12m = document.getElementById("sentinelReportPreset12m");
  const intervalSel = document.getElementById("sentinelReportInterval");
  const btnStats = document.getElementById("sentinelReportLoadStatsBtn");
  const btnPdf = document.getElementById("sentinelReportPdfBtn");
  const previewKpi = document.getElementById("sentinelReportKpi");
  const previewText = document.getElementById("sentinelReportPreviewText");
  const chartCanvas = document.getElementById("sentinelReportChart");
  const chartWrap = document.getElementById("sentinelReportChartWrap");
  const refreshBlocksBtn = document.getElementById("sentinelReportRefreshBlocks");

  const fnName = (cfg && cfg.SENTINEL_STATS_FUNCTION) || "vsl-sentinel-statistics";
  const supabaseBase = (cfg && cfg.SUPABASE_URL) ? String(cfg.SUPABASE_URL).replace(/\/$/, "") : "";
  const functionsUrl = supabaseBase ? `${supabaseBase}/functions/v1/${fnName}` : "";

  const endpointHintEl = document.getElementById("sentinelReportEndpointHint");
  if (endpointHintEl) {
    endpointHintEl.textContent = functionsUrl
      ? `Report calls: ${functionsUrl} (set SENTINEL_STATS_FUNCTION in app-config if you used a different function name).`
      : "Configure SUPABASE_URL in app-config to show the function endpoint.";
  }

  async function getAccessTokenForFunctions() {
    let {
      data: { session }
    } = await supabase.auth.getSession();
    if (!session?.access_token) {
      const { data: ref } = await supabase.auth.refreshSession();
      session = ref.session;
    }
    return session?.access_token || null;
  }

  function invokeStatsErrorHelp(msg, httpStatus, bodyDetail) {
    const m = (msg || "").toLowerCase();
    const d = (bodyDetail || "").toLowerCase();
    const isFetch = m.includes("failed to send") || m.includes("failed to fetch") || m.includes("networkerror");
    let s = functionsUrl
      ? ` Request URL: ${functionsUrl}.`
      : " ";
    if (d.includes("datamask") || m.includes("datamask")) {
      s +=
        " The Copernicus Statistical API is rejecting the current Edge Function build. Redeploy the function from the latest project code: in the folder with supabase/, run: supabase functions deploy vsl-sentinel-statistics (or deploy via the Supabase dashboard from the bundle in the repo).";
    }
    if (typeof httpStatus === "number" && !Number.isNaN(httpStatus)) {
      if (httpStatus === 401) {
        s +=
          " 401: session/JWT not accepted. Sign in again, or the Edge Function is set to verify JWT and you are not sending a user session. For local tests only, you can set verify_jwt = false in config.toml (not for production).";
      } else if (httpStatus === 400) {
        s += " 400: bad request (missing fields, or block/geometry not found).";
      } else if (httpStatus === 404) {
        s += " 404: function name or project URL may be wrong (see SENTINEL_STATS_FUNCTION / SUPABASE_URL).";
      } else if (httpStatus === 502) {
        s +=
          " 502: upstream failed (Copernicus CDSE / Statistics API or OAuth). Check SENTINEL_HUB_CLIENT_* secrets and function logs in Supabase.";
      } else if (httpStatus === 500) {
        s += " 500: function threw or missing env/DB. Read the error text above and check Edge Function logs.";
      } else if (httpStatus >= 400) {
        s += ` ${httpStatus}: see error text and Edge Function logs.`;
      }
    }
    if (isFetch) {
      s +=
        " This usually means the browser could not reach that URL: the function is missing (404 deploy), a firewall/ad-blocker blocked it, CORS, or the site is offline. It is not the same as quick-responder — deploy vsl-sentinel-statistics from this repo, or set SENTINEL_STATS_FUNCTION to the function name you actually deployed (with the stats code inside).";
    }
    return s;
  }

  let blockRows = [];
  let filterText = "";
  const selectedBlockId = { current: null };

  function setDatesMonthsBack(m) {
    const end = new Date();
    const start = new Date(end.getTime());
    start.setMonth(start.getMonth() - m);
    if (dateFromIn) dateFromIn.value = start.toISOString().slice(0, 10);
    if (dateToIn) dateToIn.value = end.toISOString().slice(0, 10);
  }
  if (dateFromIn && !dateFromIn.value && dateToIn && !dateToIn.value) {
    setDatesMonthsBack(6);
  }

  function currentBlockId() {
    if (blockSelect && blockSelect.value) return String(blockSelect.value);
    return selectedBlockId.current;
  }

  function matchesFilter(row) {
    if (!filterText) return true;
    const t = filterText.toLowerCase();
    return (
      String(row.block_code ?? "")
        .toLowerCase()
        .includes(t) ||
      String(row.block_name ?? "")
        .toLowerCase()
        .includes(t) ||
      String(row.estate_name ?? "")
        .toLowerCase()
        .includes(t)
    );
  }

  function renderBlockOptions() {
    if (!blockSelect) return;
    const rows = blockRows.filter(matchesFilter);
    const cur = currentBlockId();
    blockSelect.innerHTML =
      `<option value="">${rows.length ? "— Choose one block —" : "No blocks (check filter)"}</option>` +
      rows
        .map(
          (r) =>
            `<option value="${escapeHtml(String(r.id))}" ${
              String(r.id) === cur ? "selected" : ""
            }>${escapeHtml(String(r.block_code))} — ${escapeHtml(
              String(r.block_name ?? "—")
            )}</option>`
        )
        .join("");
  }

  async function loadBlockList() {
    const { data, error } = await supabase
      .from("vsl_blocks")
      .select("id, block_code, block_name, estate_name, expected_area_acres, geometry_status, cultivation_status")
      .order("block_code", { ascending: true });
    if (error) {
      if (setStatus) setStatus(statusEl, `Report blocks: ${error.message}`, true);
      return;
    }
    blockRows = data || [];
    renderBlockOptions();
  }

  blockSelect?.addEventListener("change", () => {
    selectedBlockId.current = blockSelect.value || null;
  });
  blockFilter?.addEventListener("input", () => {
    filterText = (blockFilter.value || "").trim().toLowerCase();
    renderBlockOptions();
  });
  refreshBlocksBtn?.addEventListener("click", () => void loadBlockList());
  btnPreset3m?.addEventListener("click", () => setDatesMonthsBack(3));
  btnPreset6m?.addEventListener("click", () => setDatesMonthsBack(6));
  btnPreset12m?.addEventListener("click", () => setDatesMonthsBack(12));

  function kpiText(ndvi, ndre, ndmi) {
    const empty = (a) => !a || !a.length;
    if (empty(ndvi) && empty(ndre) && empty(ndmi)) {
      return "Load stats to see NDVI, NDRE, and NDMI.";
    }
    const n = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
    const nv = n(ndvi);
    const nr = n(ndre);
    const nm = n(ndmi);
    lastKpis = { ndvi: nv?.mean ?? null, ndre: nr?.mean ?? null, ndmi: nm?.mean ?? null };
    return `Latest period: NDVI ${nv?.mean != null ? fmtNum(nv.mean, 3) : "—"} (vigour) · NDRE ${
      nr?.mean != null ? fmtNum(nr.mean, 3) : "—"
    } (red-edge) · NDMI ${nm?.mean != null ? fmtNum(nm.mean, 3) : "—"} (moisture / NIR–SWIR). S2 L2A SCL-masked, ${fnName}.`;
  }

  function alignThreeSeries(ndvi, ndre, ndmi) {
    const toKey = (r) => String((r && (r.to || r.from)) || "");
    const rmap = new Map((ndre || []).map((r) => [toKey(r), r]));
    const mmap = new Map((ndmi || []).map((r) => [toKey(r), r]));
    const labels = [];
    const yN = [];
    const yR = [];
    const yM = [];
    for (const r of ndvi || []) {
      const k = toKey(r);
      labels.push(k ? k.slice(0, 10) : "—");
      yN.push(r && r.mean != null && Number.isFinite(r.mean) ? r.mean : null);
      const rr = rmap.get(k);
      yR.push(rr && rr.mean != null && Number.isFinite(rr.mean) ? rr.mean : null);
      const mo = mmap.get(k);
      yM.push(mo && mo.mean != null && Number.isFinite(mo.mean) ? mo.mean : null);
    }
    return { labels, yN, yR, yM };
  }

  function drawChart(ndvi, ndre, ndmi) {
    if (!chartCanvas) return;
    const Chart = window.Chart;
    if (!Chart) {
      if (previewText) previewText.textContent = "Chart.js not loaded; stats table still available in PDF.";
      return;
    }
    const { labels, yN, yR, yM } = alignThreeSeries(ndvi, ndre, ndmi);
    if (statsChart) {
      statsChart.destroy();
      statsChart = null;
    }
    if (labels.length === 0) {
      if (chartWrap) chartWrap.style.display = "none";
      return;
    }
    if (chartWrap) chartWrap.style.display = "block";
    const ctx = chartCanvas.getContext("2d");
    if (!ctx) return;
    statsChart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "NDVI",
            data: yN,
            borderColor: "rgb(34, 100, 34)",
            backgroundColor: "rgba(34, 100, 34, 0.1)",
            spanGaps: true,
            tension: 0.15,
            yAxisID: "y"
          },
          {
            label: "NDRE",
            data: yR,
            borderColor: "rgb(13, 115, 51)",
            backgroundColor: "rgba(13, 115, 51, 0.08)",
            borderDash: [4, 2],
            spanGaps: true,
            tension: 0.15,
            yAxisID: "y"
          },
          {
            label: "NDMI (moisture)",
            data: yM,
            borderColor: "rgb(21, 101, 192)",
            backgroundColor: "rgba(21, 101, 192, 0.08)",
            spanGaps: true,
            tension: 0.15,
            yAxisID: "y1"
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" } },
        scales: {
          y: {
            type: "linear",
            position: "left",
            title: { display: true, text: "NDVI / NDRE" },
            min: -0.2,
            max: 1
          },
          y1: {
            type: "linear",
            position: "right",
            title: { display: true, text: "NDMI" },
            min: -1,
            max: 1,
            grid: { drawOnChartArea: false }
          }
        }
      }
    });
  }

  function chartToPng() {
    if (!chartCanvas) return null;
    try {
      return chartCanvas.toDataURL("image/png", 0.9);
    } catch {
      return null;
    }
  }

  async function runStats() {
    const bid = currentBlockId();
    if (!bid) {
      if (setStatus) setStatus(statusEl, "Choose one block for the report.", true);
      return;
    }
    const df = dateFromIn?.value;
    const dt = dateToIn?.value;
    if (!df || !dt) {
      if (setStatus) setStatus(statusEl, "Set date from / to for Sentinel statistics.", true);
      return;
    }
    const interval = (intervalSel && intervalSel.value) || "P16D";
    lastStats = null;
    if (setStatus) setStatus(statusEl, "Requesting satellite statistics (Copernicus)…");
    if (btnStats) btnStats.disabled = true;
    try {
      const accessToken = await getAccessTokenForFunctions();
      if (!accessToken) {
        if (setStatus) setStatus(statusEl, "Sign in to load satellite statistics.", true);
        return;
      }
      const { data, error } = await supabase.functions.invoke(fnName, {
        body: {
          block_id: bid,
          date_from: df,
          date_to: dt,
          interval: interval
        },
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (error) {
        const { httpStatus, detail: bodyDetail } = await readFunctionInvokeErrorDetail(error);
        const fromData =
          data && typeof data === "object" && data !== null && "error" in data
            ? String(/** @type {{ error: string }} */ (data).error)
            : "";
        const errMsg = (error && error.message) || String(error);
        const serverText = (bodyDetail || fromData).trim();
        const display = serverText
          ? (httpStatus != null ? `${serverText} (HTTP ${httpStatus})` : serverText)
          : httpStatus != null
            ? `${errMsg} (HTTP ${httpStatus})`
            : errMsg;
        if (setStatus) {
          setStatus(
            statusEl,
            `Satellite stats: ${display}${invokeStatsErrorHelp(errMsg, httpStatus, serverText)}`,
            true
          );
        }
        if (typeof console !== "undefined" && console.error) {
          console.error("[vsl block report] functions.invoke failed", {
            fnName,
            functionsUrl,
            error,
            data,
            httpStatus,
            bodyDetail: bodyDetail || null
          });
        }
        return;
      }
      if (data && data.success === false) {
        if (setStatus) setStatus(statusEl, (data && data.error) || "Stats failed", true);
        return;
      }
      if (!data || !Array.isArray(data.ndvi_intervals)) {
        if (setStatus) setStatus(statusEl, "Unexpected response from stats function.", true);
        return;
      }
      lastStats = data;
      const ndvi = data.ndvi_intervals || [];
      const ndre = data.ndre_intervals || [];
      const ndmi = data.ndmi_intervals || [];
      if (previewKpi) previewKpi.textContent = kpiText(ndvi, ndre, ndmi);
      if (previewText) {
        previewText.textContent = `Block ${data.block?.block_code || "—"} · ${ndvi.length} time step(s) · NDVI + NDRE + NDMI · Interval ${data.interval || interval} · S2 L2A (SCL).`;
      }
      drawChart(ndvi, ndre, ndmi);
      if (setStatus) setStatus(statusEl, "Satellite statistics loaded.");
    } catch (e) {
      if (setStatus) setStatus(statusEl, (e && e.message) || "Stats request failed", true);
    } finally {
      if (btnStats) btnStats.disabled = false;
    }
  }

  async function captureMapDataUrl() {
    const html2canvas = window.html2canvas;
    if (!map || !html2canvas) return null;
    return new Promise((resolve) => {
      const el = map.getTargetElement();
      if (!el) {
        resolve(null);
        return;
      }
      try {
        map.updateSize();
      } catch { /* */ }
      let done = false;
      const cap = () => {
        if (done) return;
        done = true;
        const w0 = el.offsetWidth;
        const scale = Math.min(1.5, 1800 / Math.max(w0, 1));
        window.setTimeout(() => {
          try {
            map.updateSize();
          } catch { /* */ }
          html2canvas(el, {
            useCORS: true,
            allowTaint: true,
            scale,
            logging: false,
            foreignObjectRendering: false,
            backgroundColor: null
          })
            .then((c) => resolve(c.toDataURL("image/jpeg", 0.92)))
            .catch(() => resolve(null));
        }, 400);
      };
      map.once("rendercomplete", cap);
      map.renderSync();
      window.setTimeout(cap, 2400);
    });
  }

  function fitToBlockId(id) {
    return new Promise((resolve) => {
      if (!map || !blocksSource) {
        resolve();
        return;
      }
      const f = blocksSource.getFeatures().find((x) => String(x.getId()) === String(id));
      if (!f) {
        resolve();
        return;
      }
      const g = f.getGeometry();
      if (!g) {
        resolve();
        return;
      }
      const ext = ol.extent.createEmpty();
      ol.extent.extend(ext, g.getExtent());
      if (ol.extent.isEmpty(ext)) {
        resolve();
        return;
      }
      map.getView().fit(ext, { padding: [64, 64, 64, 64], maxZoom: 16, duration: 650 });
      map.once("moveend", () => {
        try {
          map.updateSize();
        } catch { /* */ }
        window.setTimeout(resolve, 820);
      });
    });
  }

  /**
   * @param {import("jspdf").default} doc
   * @param {string} title
   * @param {string | null} [logoDataUrl]
   * @param {string} [subtitle]
   */
  function addHeaderFooter(doc, title, logoDataUrl, subtitle) {
    doc.setFont("helvetica", "normal");
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 14;
    doc.setFillColor(22, 56, 22);
    doc.rect(0, 0, pageW, 20, "F");
    if (logoDataUrl) {
      const tryAdd = (fmt) => {
        try {
          doc.addImage(logoDataUrl, fmt, margin, 3, 20, 14);
          return true;
        } catch {
          return false;
        }
      };
      if (!tryAdd("PNG") && !tryAdd("JPEG")) { /* */ }
    }
    const textX = margin + (logoDataUrl ? 25 : 0);
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(10.5);
    doc.setFont("helvetica", "bold");
    doc.text("VICTORIA SUGAR LTD", textX, 9);
    doc.setFontSize(7.2);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(235, 245, 232);
    doc.text("Land intelligence — sugarcane blocks & parcels", textX, 15);
    doc.setTextColor(40, 40, 40);
    doc.setFontSize(9.2);
    doc.setFont("helvetica", "bold");
    doc.text(String(title), margin, 30);
    if (subtitle) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.2);
      doc.setTextColor(70, 80, 70);
      doc.text(String(subtitle), margin, 36);
    }
    const footY = pageH - 8.5;
    doc.setDrawColor(200, 210, 200);
    doc.setLineWidth(0.2);
    doc.line(margin, footY - 2, pageW - margin, footY - 2);
    doc.setFontSize(7.2);
    doc.setTextColor(100, 100, 100);
    const genAt = new Date().toLocaleString();
    const user = getCurrentUser?.();
    const who = user?.email || user?.role || "Map user";
    doc.text(`Generated ${genAt} · ${who} · Internal use only.`, margin, footY);
    doc.text("Page " + String(doc.getNumberOfPages()), pageW - margin, footY, { align: "right" });
  }

  /** @returns {number} y position just below the image (mm) */
  function addRasterFit(doc, dataUrl, fmt, x, y, maxW, maxH) {
    try {
      const p = doc.getImageProperties(dataUrl);
      if (!p || !p.width) {
        doc.setFillColor(250, 252, 250);
        doc.roundedRect(x - 0.5, y - 0.5, maxW + 1, maxH + 1, 1.2, 1.2, "F");
        doc.setDrawColor(200, 210, 200);
        doc.setLineWidth(0.3);
        doc.roundedRect(x - 0.5, y - 0.5, maxW + 1, maxH + 1, 1.2, 1.2, "S");
        doc.addImage(dataUrl, fmt, x, y, maxW, maxH);
        return y + maxH + 2;
      }
      const ar = p.height / p.width;
      let w = maxW;
      let h = w * ar;
      if (h > maxH) {
        h = maxH;
        w = h / ar;
      }
      const x0 = x + (maxW - w) / 2;
      doc.setFillColor(250, 252, 250);
      doc.roundedRect(x - 0.5, y - 0.5, maxW + 1, maxH + 1, 1.2, 1.2, "F");
      doc.setDrawColor(200, 210, 200);
      doc.setLineWidth(0.3);
      doc.roundedRect(x - 0.5, y - 0.5, maxW + 1, maxH + 1, 1.2, 1.2, "S");
      doc.addImage(dataUrl, fmt, x0, y, w, h);
      return y + h + 3;
    } catch {
      try {
        doc.setFillColor(250, 252, 250);
        doc.roundedRect(x - 0.5, y - 0.5, maxW + 1, maxH + 1, 1.2, 1.2, "F");
        doc.setDrawColor(200, 210, 200);
        doc.setLineWidth(0.3);
        doc.roundedRect(x - 0.5, y - 0.5, maxW + 1, maxH + 1, 1.2, 1.2, "S");
        doc.addImage(dataUrl, fmt, x, y, maxW, maxH);
      } catch { /* */ }
      return y + maxH + 2;
    }
  }

  async function generateReportPdf() {
    const jsPDF = getJsPDFConstructor();
    if (!jsPDF) {
      if (setStatus) {
        setStatus(
          statusEl,
          "PDF engine not loaded (check jspdf + jspdf-autotable scripts before map-app on the page).",
          true
        );
      }
      return;
    }
    const bid = currentBlockId();
    if (!bid) {
      if (setStatus) setStatus(statusEl, "Choose one block.", true);
      return;
    }
    if (btnPdf) btnPdf.disabled = true;
    if (setStatus) setStatus(statusEl, "Building report…");
    try {
      const { data: blockData, error: e1 } = await supabase
        .from("vsl_blocks")
        .select(
          "id, block_code, block_name, estate_name, expected_area_acres, geometry_status, cultivation_status, harvest_tonnes, last_harvest_date, cultivation_updated_at"
        )
        .eq("id", bid)
        .single();
      if (e1) throw e1;
      const bl = blockData;
      if (!bl) throw new Error("Block not found");
      const { data: parcelData, error: e2 } = await supabase
        .from("vsl_parcels")
        .select("block_id, parcel_no, expected_area_acres, cultivation_status, harvest_tonnes, last_harvest_date, geometry_status")
        .eq("block_id", bid);
      if (e2) throw e2;
      const parcels = parcelData || [];

      if (!lastStats || !lastStats.ndvi_intervals) {
        await runStats();
      }
      const statPayload = lastStats;
      if (!statPayload || !Array.isArray(statPayload.ndvi_intervals)) {
        if (setStatus) {
          setStatus(
            statusEl,
            "No satellite data in the response. Sign in, run SQL 010 (GeoJSON), set SENTINEL_HUB_* on the function, and pick a block with saved geometry. Then try Load stats again.",
            true
          );
        }
        return;
      }

      const logo = await loadVslLogoDataUrl();
      await fitToBlockId(bid);
      const mapImg = await captureMapDataUrl();
      const chOldH = chartWrap ? chartWrap.style.height : "";
      if (chartWrap) chartWrap.style.height = "360px";
      if (statsChart) statsChart.resize();
      const chartPng = chartToPng();
      if (chartWrap) chartWrap.style.height = chOldH || "200px";
      if (statsChart) statsChart.resize();

      const doc = new jsPDF({ unit: "mm", format: "a4", compress: false });
      doc.setFont("helvetica", "normal");
      if (typeof doc.autoTable !== "function") {
        if (setStatus) {
          setStatus(
            statusEl,
            "jspdf-autotable not loaded. Load jspdf, then jspdf.plugin.autotable, before map-app (see webmap.html).",
            true
          );
        }
        return;
      }
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 14;
      const contentW = pageW - margin * 2;
      const ndviS = seriesNumericMeans(statPayload.ndvi_intervals);
      const ndreS = seriesNumericMeans(statPayload.ndre_intervals);
      const ndmiS = seriesNumericMeans(statPayload.ndmi_intervals);
      const lastNd = ndviS.length ? ndviS[ndviS.length - 1] : null;
      const lastRe = ndreS.length ? ndreS[ndreS.length - 1] : null;
      const lastMi = ndmiS.length ? ndmiS[ndmiS.length - 1] : null;
      const mmN = minMaxOf(ndviS);
      const mmRe = minMaxOf(ndreS);
      const mmMi = minMaxOf(ndmiS);
      const zone = zoneFromNdvi(lastNd);
      const hScore = fieldHealthScoreFromNdvi(lastNd);
      const cvN =
        meanOf(ndviS) && stdevOf(ndviS) && Math.abs(meanOf(ndviS)) > 1e-6
          ? stdevOf(ndviS) / meanOf(ndviS)
          : null;
      const nSteps = (statPayload.ndvi_intervals || []).length;
      const trendN =
        nSteps >= 2 && lastNd != null
          ? lastNd - (statPayload.ndvi_intervals[0].mean != null ? statPayload.ndvi_intervals[0].mean : lastNd)
          : null;

      addHeaderFooter(
        doc,
        `Block ${bl.block_code} — overview & map`,
        logo,
        "Sugarcane intelligence · block extent below is fitted to the polygon (proportional capture)"
      );
      let y0 = 40;
      doc.setFontSize(9.2);
      doc.setTextColor(28, 40, 28);
      doc.setFont("helvetica", "bold");
      doc.text(`Block ${bl.block_code} — ${String(bl.block_name || "—")}`, margin, y0);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(55, 60, 55);
      y0 += 4;
      {
        const h = sumHarvestTonnes(parcels);
        const sub = `Estate: ${String(
          bl.estate_name || "—"
        )} · ${String(statPayload.time_range?.from || "").slice(0, 10)} → ${String(
          statPayload.time_range?.to || ""
        ).slice(0, 10)} · ${String(statPayload.interval || "P16D")} · SCL mask · ${
          fmtNum(bl.expected_area_acres, 1)
        } ac · ${parcels.length} plots${
          h.n > 0 ? ` · ${fmtNum(h.sum, 2)} t (plots)` : ""
        } · Health ${hScore != null ? String(hScore) + "/100" : "—"} · ${zone.label}`;
        doc.text(sub, margin, y0, { maxWidth: contentW });
        y0 += 7;
      }

      y0 += 1;
      if (mapImg) {
        const capMaxH = Math.min((pageH - 22) * 0.75, pageH - y0 - 18);
        try {
          y0 = addRasterFit(doc, mapImg, "JPEG", margin, y0, contentW, capMaxH);
        } catch {
          doc.text("Map image could not be embedded.", margin, y0);
          y0 += 8;
        }
      } else {
        doc.setFontSize(8);
        doc.setTextColor(120, 0, 0);
        doc.text("Map capture unavailable. Fit the block on screen, then try again.", margin, y0);
        y0 += 8;
      }
      doc.setFontSize(6.9);
      doc.setTextColor(88, 90, 88);
      doc.text(
        "Map — fitted to the block geometry (WGS 84), screenshot keeps aspect (no stretch). " +
          "DEM/relief: use the WMS DEM layer in the app (set SENTINEL_DEM_WMS_LAYER if your layer name is not “DEM”). " +
          "Table statistics are field-mean time series, not a pixel zonation map.",
        margin,
        y0,
        { maxWidth: contentW }
      );
      y0 += 9;

      doc.addPage();
      addHeaderFooter(
        doc,
        "Vegetation indices, cultivation & time series",
        logo,
        "Field-mean NDVI / NDRE / NDMI — compare with last season, rain, and fertiliser / irrigation"
      );
      y0 = 40;
      doc.setFontSize(7.2);
      doc.setTextColor(45, 55, 45);
      doc.setFont("helvetica", "normal");
      doc.text(
        "NDVI: canopy greenness. NDRE: red-edge (N / chlorophyll in dense cane). NDMI: moisture stress signal. " +
          "Zonal maps, DEM slope, and pixel analytics require a raster service — here we use robust block means.",
        margin,
        y0,
        { maxWidth: contentW }
      );
      y0 += 8;

      if (nSteps > 0) {
        doc.setFillColor(240, 248, 240);
        doc.roundedRect(margin, y0, contentW, 32, 1, 1, "F");
        doc.setFontSize(7.2);
        doc.setTextColor(32, 70, 35);
        doc.text(
          `Uniformity (temporal CV of mean NDVI): ${
            cvN != null ? fmtNum(cvN, 2) : "—"
          }  ·  Trend (latest − first NDVI): ${
            trendN != null ? (trendN >= 0 ? "+" : "") + fmtNum(trendN, 3) : "—"
          }`,
          margin + 2,
          y0 + 5.5,
          { maxWidth: contentW - 4 }
        );
        doc.setFontSize(6.8);
        doc.setTextColor(40, 75, 44);
        doc.text(
          `NDRE: ${ndreNarrative(lastRe)}  NDMI: ${ndmiNarrative(lastMi)}`,
          margin + 2,
          y0 + 13.5,
          { maxWidth: contentW - 4 }
        );
        y0 += 36;
      }
      const pCounts = countByKey(parcels, "cultivation_status");
      const pBody = Object.keys(pCounts)
        .sort()
        .map((k) => [CULTIVATION_LABELS[k] || k, String(pCounts[k])]);
      doc.setFontSize(8.3);
      doc.setTextColor(30, 30, 30);
      doc.setFont("helvetica", "bold");
      doc.text("Cultivation (plot count by status)", margin, y0);
      doc.setFont("helvetica", "normal");
      y0 += 4;
      doc.autoTable({
        startY: y0,
        head: [["Status", "Plot count"]],
        body: pBody.length ? pBody : [["—", "0"]],
        margin: { left: margin, right: margin },
        styles: { fontSize: 8, cellPadding: 1.6 },
        headStyles: { fillColor: [34, 78, 34] }
      });
      y0 = doc.lastAutoTable.finalY + 7;

      doc.setFontSize(7.2);
      doc.setTextColor(55, 60, 55);
      doc.text(
        "Field-mean health bands (illustrative, from last NDVI in series):  <0.3 Poor  ·  0.3–0.5 Moderate  ·  0.5–0.7 Good  ·  >0.7 Excellent",
        margin,
        y0,
        { maxWidth: contentW }
      );
      y0 += 5;
      doc.text(
        `Latest period: NDVI ${lastNd != null ? fmtNum(lastNd, 3) : "—"} · NDRE ${
          lastRe != null ? fmtNum(lastRe, 3) : "—"
        } (nutrient / chlorophyll) · NDMI ${lastMi != null ? fmtNum(lastMi, 3) : "—"} (moisture stress).`,
        margin,
        y0,
        { maxWidth: contentW }
      );
      y0 += 8;

      doc.autoTable({
        startY: y0,
        head: [
          [
            "Metric (series)",
            "Min",
            "Max",
            "Latest"
          ]
        ],
        body: [
          [
            "NDVI (vigour)",
            mmN.min != null ? fmtNum(mmN.min, 3) : "—",
            mmN.max != null ? fmtNum(mmN.max, 3) : "—",
            lastNd != null ? fmtNum(lastNd, 3) : "—"
          ],
          [
            "NDRE (N / red-edge)",
            mmRe.min != null ? fmtNum(mmRe.min, 3) : "—",
            mmRe.max != null ? fmtNum(mmRe.max, 3) : "—",
            lastRe != null ? fmtNum(lastRe, 3) : "—"
          ],
          [
            "NDMI (moisture)",
            mmMi.min != null ? fmtNum(mmMi.min, 3) : "—",
            mmMi.max != null ? fmtNum(mmMi.max, 3) : "—",
            lastMi != null ? fmtNum(lastMi, 3) : "—"
          ]
        ],
        margin: { left: margin, right: margin },
        styles: { fontSize: 7.5, cellPadding: 1.3 },
        headStyles: { fillColor: [26, 72, 28] }
      });
      y0 = doc.lastAutoTable.finalY + 5;

      const ndreByTo = new Map(
        (statPayload.ndre_intervals || []).map((r) => [String((r && r.to) || r.from || ""), r])
      );
      const ndmiByTo = new Map(
        (statPayload.ndmi_intervals || []).map((r) => [String((r && r.to) || r.from || ""), r])
      );
      const rows = (statPayload.ndvi_intervals || []).map((r) => {
        const k = String((r && r.to) || r.from || "");
        const re = ndreByTo.get(k) || {};
        const o = ndmiByTo.get(k) || {};
        return [
          k ? k.slice(0, 10) : "—",
          r.mean != null ? fmtNum(r.mean, 3) : "—",
          re.mean != null ? fmtNum(re.mean, 3) : "—",
          o.mean != null ? fmtNum(o.mean, 3) : "—"
        ];
      });
      doc.autoTable({
        startY: y0,
        head: [["Period end (UTC)", "NDVI", "NDRE", "NDMI"]],
        body: rows.length
          ? rows
          : [["—", "—", "—", "—"]],
        margin: { left: margin, right: margin },
        styles: { fontSize: 7.2, cellPadding: 1.2 },
        headStyles: { fillColor: [22, 70, 22] }
      });
      y0 = doc.lastAutoTable.finalY + 4;

      doc.setFontSize(6.8);
      doc.setTextColor(80, 80, 80);
      doc.text("NDRE = (B8−B5)/(B8+B5);  NDMI = (B8A−B11)/(B8A+B11).  Spatial zonation and DEM slope require a raster service (not included here).", margin, y0, { maxWidth: contentW });
      y0 += 7;

      doc.addPage();
      addHeaderFooter(doc, "Sentinel-2 time series (chart)", logo, null);
      y0 = 40;
      if (chartPng) {
        const chartMaxH = Math.min((pageH - 20) * 0.8, pageH - y0 - 20);
        y0 = addRasterFit(doc, chartPng, "PNG", margin, y0, contentW, chartMaxH);
      } else {
        doc.setFontSize(8);
        doc.text("No chart in session — use Load stats before PDF.", margin, y0);
        y0 += 8;
      }
      doc.setFontSize(6.8);
      doc.setTextColor(60, 60, 60);
      doc.text(
        "Use this chart for growth stage, fertiliser / irrigation response, and seasonal comparison with the same block in prior seasons.",
        margin,
        y0,
        { maxWidth: contentW }
      );
      y0 += 8;

      doc.addPage();
      addHeaderFooter(doc, `Block ${bl.block_code} — plot register`, logo, null);
      y0 = 40;
      doc.setFontSize(7.5);
      doc.setTextColor(60, 60, 60);
      doc.text(
        `Block cultiv.: ${CULTIVATION_LABELS[bl.cultivation_status] || bl.cultivation_status} · Block harvest: ${
          bl.harvest_tonnes != null ? fmtNum(bl.harvest_tonnes, 2) + " t" : "—"
        }`,
        margin,
        y0
      );
      y0 += 6;
      const bParcels = parcels
        .slice()
        .sort((a, b) => (Number(a.parcel_no) || 0) - (Number(b.parcel_no) || 0));
      doc.autoTable({
        startY: y0,
        head: [["Plot", "Area (ac)", "Cultivation", "Harvest (t)", "Last harvest"]],
        body: bParcels.length
          ? bParcels.map((p) => [
              String(p.parcel_no),
              fmtNum(p.expected_area_acres, 2),
              CULTIVATION_LABELS[p.cultivation_status] || p.cultivation_status,
              p.harvest_tonnes != null ? fmtNum(p.harvest_tonnes, 2) : "—",
              p.last_harvest_date != null ? String(p.last_harvest_date).slice(0, 10) : "—"
            ])
          : [["—", "—", "—", "—", "—"]],
        margin: { left: margin, right: margin },
        styles: { fontSize: 7.2, cellPadding: 1.2 },
        headStyles: { fillColor: [46, 90, 46] }
      });

      const fname = `VSL_block_${String(bl.block_code).replace(/[^\w.-]+/g, "_")}_${
        new Date().toISOString().slice(0, 10)
      }.pdf`;
      doc.save(fname);
      if (setStatus) setStatus(statusEl, "Report downloaded.");
    } catch (e) {
      if (setStatus) setStatus(statusEl, (e && e.message) || "Report failed", true);
    } finally {
      if (btnPdf) btnPdf.disabled = false;
    }
  }

  btnStats?.addEventListener("click", () => void runStats());
  btnPdf?.addEventListener("click", () => void generateReportPdf());
  void loadBlockList();

  return { close: () => {}, open: () => {} };
}
