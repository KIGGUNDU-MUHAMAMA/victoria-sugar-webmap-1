/**
 * Block report (one block) — database agronomics + Sentinel-2 (NDVI, NDMI) from Edge Function.
 * UI lives inside #sentinelAnalyticsPanel. PDF: jspdf + autotable, html2canvas, Chart.js.
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

let statsChart = null;
let lastStats = null;
let lastKpis = { ndvi: null, ndmi: null };

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

  function invokeStatsErrorHelp(msg) {
    const m = (msg || "").toLowerCase();
    const isFetch = m.includes("failed to send") || m.includes("failed to fetch") || m.includes("networkerror");
    let s = functionsUrl
      ? ` Request URL: ${functionsUrl}.`
      : " ";
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

  function kpiText(ndvi, ndmi) {
    if (!ndvi && !ndmi) return "Load satellite stats to see NDVI and NDMI.";
    const n = (arr) => (arr && arr.length ? arr[arr.length - 1] : null);
    const nv = n(ndvi);
    const nm = n(ndmi);
    lastKpis = { ndvi: nv?.mean ?? null, ndmi: nm?.mean ?? null };
    return `Latest period (chronological order): NDVI mean ${nv?.mean != null ? fmtNum(nv.mean, 3) : "—"} — canopy vigour. NDMI mean ${nm?.mean != null ? fmtNum(nm.mean, 3) : "—"} — relative moisture (NIR–SWIR; interpret with field checks). Cloud–masked S2 L2A, ${fnName}.`;
  }

  function alignSeries(a, b) {
    const toKey = (r) => String((r && (r.to || r.from)) || "");
    const bmap = new Map((b || []).map((r) => [toKey(r), r]));
    const labels = [];
    const yN = [];
    const yM = [];
    for (const r of a || []) {
      const k = toKey(r);
      labels.push(k ? k.slice(0, 10) : "—");
      yN.push(r && r.mean != null && Number.isFinite(r.mean) ? r.mean : null);
      const o = bmap.get(k);
      yM.push(o && o.mean != null && Number.isFinite(o.mean) ? o.mean : null);
    }
    return { labels, yN, yM };
  }

  function drawChart(ndvi, ndmi) {
    if (!chartCanvas) return;
    const Chart = window.Chart;
    if (!Chart) {
      if (previewText) previewText.textContent = "Chart.js not loaded; stats table still available in PDF.";
      return;
    }
    const { labels, yN, yM } = alignSeries(ndvi, ndmi);
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
            label: "NDVI (vigour)",
            data: yN,
            borderColor: "rgb(34, 100, 34)",
            backgroundColor: "rgba(34, 100, 34, 0.12)",
            spanGaps: true,
            tension: 0.15,
            yAxisID: "y"
          },
          {
            label: "NDMI (moisture index)",
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
          y: { type: "linear", position: "left", title: { display: true, text: "NDVI" }, min: -0.2, max: 1 },
          y1: { type: "linear", position: "right", title: { display: true, text: "NDMI" }, min: -1, max: 1, grid: { drawOnChartArea: false } }
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
    if (setStatus) setStatus(statusEl, "Requesting satellite statistics (Sentinel Hub)…");
    if (btnStats) btnStats.disabled = true;
    try {
      const { data, error } = await supabase.functions.invoke(fnName, {
        body: {
          block_id: bid,
          date_from: df,
          date_to: dt,
          interval: interval
        }
      });
      if (error) {
        let extra = "";
        if (data && typeof data === "object" && data !== null && "error" in data) {
          extra = ` — ${String(/** @type {{ error: string }} */ (data).error)}`;
        } else {
          const body = (error && typeof error === "object" && "context" in error && (/** @type {{ context?: { body?: string } }} */ (error).context))?.body;
          if (body && typeof body === "string") {
            try {
              const j = JSON.parse(body);
              if (j && j.error) extra = ` — ${j.error}`;
            } catch {
              if (body.length < 400) extra = ` — ${body}`;
            }
          }
        }
        const msg = (error && error.message) || String(error);
        if (setStatus) {
          setStatus(statusEl, `Satellite stats: ${msg}${extra}${invokeStatsErrorHelp(msg)}`, true);
        }
        if (typeof console !== "undefined" && console.error) {
          console.error("[vsl block report] functions.invoke failed", { fnName, functionsUrl, error, data });
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
      const ndmi = data.ndmi_intervals || [];
      if (previewKpi) previewKpi.textContent = kpiText(ndvi, ndmi);
      if (previewText) {
        previewText.textContent = `Block ${data.block?.block_code || "—"} · ${ndvi.length} time step(s) · Interval ${data.interval || interval} · S2 L2A (cloud-filtered, SCL).`;
      }
      drawChart(ndvi, ndmi);
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
      map.once("rendercomplete", () => {
        window.setTimeout(() => {
          const el = map.getTargetElement();
          if (!el) {
            resolve(null);
            return;
          }
          html2canvas(el, {
            useCORS: true,
            allowTaint: true,
            scale: Math.min(1, 1200 / Math.max(el.offsetWidth, 1)),
            logging: false
          })
            .then((canvas) => resolve(canvas.toDataURL("image/jpeg", 0.82)))
            .catch(() => resolve(null));
        }, 400);
      });
      map.renderSync();
    });
  }

  function fitToBlockId(id) {
    if (!map || !blocksSource) return;
    const f = blocksSource.getFeatures().find((x) => String(x.getId()) === String(id));
    if (!f) return;
    const g = f.getGeometry();
    if (!g) return;
    const ext = ol.extent.createEmpty();
    ol.extent.extend(ext, g.getExtent());
    if (ol.extent.isEmpty(ext)) return;
    map.getView().fit(ext, { padding: [36, 36, 36, 36], maxZoom: 17, duration: 500 });
  }

  function addHeaderFooter(doc, title) {
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 14;
    doc.setFillColor(22, 56, 22);
    doc.rect(0, 0, pageW, 18, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(11);
    doc.setFont(undefined, "bold");
    doc.text("Victoria Sugar Ltd — land intelligence", margin, 12);
    doc.setTextColor(40, 40, 40);
    doc.setFontSize(9);
    doc.setFont(undefined, "normal");
    doc.text(String(title), margin, 28);

    const footY = pageH - 10;
    doc.setDrawColor(200, 210, 200);
    doc.setLineWidth(0.2);
    doc.line(margin, footY - 2, pageW - margin, footY - 2);
    doc.setFontSize(7.5);
    doc.setTextColor(100, 100, 100);
    const genAt = new Date().toLocaleString();
    const user = getCurrentUser?.();
    const who = user?.email || user?.role || "Map user";
    doc.text(`Generated ${genAt} · ${who} · For internal management use.`, margin, footY);
    doc.text("Page " + String(doc.getNumberOfPages()), pageW - margin - 8, footY, { align: "right" });
  }

  async function generateReportPdf() {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) {
      if (setStatus) setStatus(statusEl, "PDF engine not loaded.", true);
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

      fitToBlockId(bid);
      const mapImg = await captureMapDataUrl();
      const chartPng = chartToPng();

      const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
      const pageW = doc.internal.pageSize.getWidth();
      const margin = 14;
      const contentW = pageW - margin * 2;

      addHeaderFooter(doc, `Block ${bl.block_code} — summary`);
      let y0 = 36;
      doc.setFontSize(8.5);
      doc.setTextColor(50, 50, 50);
      doc.text(
        `Block ${bl.block_code} — ${String(bl.block_name || "—")} · Estate: ${String(bl.estate_name || "—")}`,
        margin,
        y0
      );
      y0 += 5;
      {
        const h = sumHarvestTonnes(parcels);
        doc.text(
          `Expected area (block): ${fmtNum(bl.expected_area_acres, 1)} ac · Plots: ${
            parcels.length
          } · Harvest (plots, where entered): ${h.n > 0 ? fmtNum(h.sum, 2) + " t" : "—"}`,
          margin,
          y0
        );
      }
      y0 += 8;
      if (mapImg) {
        try {
          doc.addImage(mapImg, "JPEG", margin, y0, contentW, 88);
        } catch {
          doc.text("Map image could not be embedded.", margin, y0);
        }
        y0 += 94;
      } else {
        doc.setFontSize(8);
        doc.text("Map capture unavailable.", margin, y0);
        y0 += 8;
      }
      doc.setFontSize(7.5);
      doc.setTextColor(90, 90, 90);
      doc.text("Map extent: selected block. Sentinel statistics use the block polygon (EPSG:4326).", margin, y0);
      y0 += 8;

      doc.addPage();
      addHeaderFooter(doc, "Cultivation & Sentinel-2 indices");
      y0 = 36;
      const pCounts = countByKey(parcels, "cultivation_status");
      const pBody = Object.keys(pCounts)
        .sort()
        .map((k) => [CULTIVATION_LABELS[k] || k, String(pCounts[k])]);
      doc.setFontSize(9);
      doc.setTextColor(30, 30, 30);
      doc.text("Parcels — cultivation status (count)", margin, y0);
      y0 += 4;
      doc.autoTable({
        startY: y0,
        head: [["Status", "Plot count"]],
        body: pBody.length ? pBody : [["—", "0"]],
        margin: { left: margin, right: margin },
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [34, 78, 34] }
      });
      y0 = doc.lastAutoTable.finalY + 8;

      doc.setFontSize(8);
      doc.text(
        `Sentinel-2 L2A · ${String(statPayload.time_range?.from || "").slice(0, 10)} → ${String(
          statPayload.time_range?.to || ""
        ).slice(0, 10)} · Step ${String(statPayload.interval || "P16D")} · SCL cloud/veg mask; NDMI = (B8A−B11)/(B8A+B11).`,
        margin,
        y0,
        { maxWidth: contentW }
      );
      y0 += 10;

      const ndmiByTo = new Map(
        (statPayload.ndmi_intervals || []).map((r) => [String((r && r.to) || r.from || ""), r])
      );
      const rows = (statPayload.ndvi_intervals || []).map((r) => {
        const k = String((r && r.to) || r.from || "");
        const o = ndmiByTo.get(k) || {};
        return [
          k ? k.slice(0, 10) : "—",
          r.mean != null ? fmtNum(r.mean, 3) : "—",
          o.mean != null ? fmtNum(o.mean, 3) : "—"
        ];
      });
      doc.autoTable({
        startY: y0,
        head: [["Period end (UTC)", "NDVI mean", "NDMI mean"]],
        body: rows.length
          ? rows
          : [["—", "—", "—"]],
        margin: { left: margin, right: margin },
        styles: { fontSize: 7.5, cellPadding: 1.5 },
        headStyles: { fillColor: [22, 70, 22] }
      });
      y0 = doc.lastAutoTable.finalY + 6;
      if (chartPng) {
        try {
          doc.addImage(chartPng, "PNG", margin, y0, contentW, 70);
        } catch {
          /* */
        }
        y0 += 75;
      }
      doc.setFontSize(7.5);
      doc.setTextColor(60, 60, 60);
      doc.text(
        "NDVI indicates green biomass; NDMI is sensitive to moisture—compare with weather, irrigation, and field scouting.",
        margin,
        y0,
        { maxWidth: contentW }
      );
      y0 += 10;

      doc.addPage();
      addHeaderFooter(doc, `Block ${bl.block_code} — plots`);
      y0 = 36;
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
        styles: { fontSize: 7.5, cellPadding: 1.5 },
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
