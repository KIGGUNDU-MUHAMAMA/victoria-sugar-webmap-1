/**
 * Farm intelligence PDF reports — Victoria Sugar Ltd
 * Block multi-select, lightweight Supabase reads (vsl_blocks / vsl_parcels), client aggregations, multi-page PDF.
 * Dependencies (globals): window.jspdf.jsPDF, autotable on jsPDF, window.html2canvas
 */

/* global ol — OpenLayers from CDN in webmap.html */

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

/**
 * @param {object} opts
 * @param {import("ol/Map").default} opts.map
 * @param {ReturnType<import("@supabase/supabase-js")["createClient"]>} opts.supabase
 * @param {import("ol/source/Vector").default} opts.blocksSource
 * @param {function(string, boolean=): void} [opts.setStatus]
 * @param {HTMLElement} [opts.statusEl]
 * @param {() => { email?: string, role?: string } | null} [opts.getCurrentUser]
 * @param {() => void} [opts.onOpenPanel]
 * @param {() => void} [opts.onClosePanel]
 */
export function initFarmReports(opts) {
  const { map, supabase, blocksSource, setStatus, statusEl, getCurrentUser, onOpenPanel, onClosePanel } = opts;

  const panel = document.getElementById("farmReportPanel");
  const panelBtn = document.getElementById("farmReportPanelBtn");
  const closeBtn = document.getElementById("farmReportPanelCloseBtn");
  const listEl = document.getElementById("farmReportBlockList");
  const filterInput = document.getElementById("farmReportBlockFilter");
  const summaryEl = document.getElementById("farmReportSummary");
  const genBtn = document.getElementById("farmReportGenerateBtn");
  const selectAllBtn = document.getElementById("farmReportSelectAll");
  const clearBtn = document.getElementById("farmReportClearSelection");
  const refreshBtn = document.getElementById("farmReportRefreshList");

  let blockRows = [];
  let filterText = "";
  let panelOpen = false;
  let outsideHandler = null;
  let escapeHandler = null;

  /** @type {Set<string>} */
  const selectedIds = new Set();

  function setPanelOpen(open) {
    panelOpen = open;
    if (panel) panel.hidden = !open;
    panelBtn?.classList.toggle("active", open);
    panelBtn?.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) onOpenPanel?.();
    else onClosePanel?.();
    map?.updateSize();
  }

  function closePanel() {
    if (escapeHandler) {
      document.removeEventListener("keydown", escapeHandler, true);
      escapeHandler = null;
    }
    if (outsideHandler) {
      document.removeEventListener("pointerdown", outsideHandler, true);
      outsideHandler = null;
    }
    setPanelOpen(false);
  }

  function openPanel() {
    if (!panel) return;
    setPanelOpen(true);
    void loadBlockList();
    escapeHandler = (ev) => {
      if (ev.key === "Escape" && panelOpen) {
        ev.preventDefault();
        closePanel();
      }
    };
    document.addEventListener("keydown", escapeHandler, true);
    outsideHandler = (ev) => {
      if (!panelOpen) return;
      if (panel?.contains(ev.target) || panelBtn?.contains(ev.target)) return;
      closePanel();
    };
    document.addEventListener("pointerdown", outsideHandler, true);
  }

  function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
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

  function renderList() {
    if (!listEl) return;
    const rows = blockRows.filter(matchesFilter);
    if (rows.length === 0) {
      listEl.innerHTML = `<p class="farm-report__empty">No blocks match. Try refreshing or clear the filter.</p>`;
      return;
    }
    listEl.innerHTML = rows
      .map(
        (r) => `
      <label class="farm-report__row">
        <input type="checkbox" class="farm-report__cb" data-block-id="${String(r.id)}" ${
          selectedIds.has(String(r.id)) ? "checked" : ""
        }>
        <span class="farm-report__row-txt">
          <strong>${escapeHtml(String(r.block_code))}</strong>
          <span class="farm-report__muted"> — ${escapeHtml(String(r.block_name ?? "—"))}</span>
        </span>
      </label>`
      )
      .join("");
    listEl.querySelectorAll(".farm-report__cb").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.getAttribute("data-block-id");
        if (!id) return;
        if (cb.checked) selectedIds.add(id);
        else selectedIds.delete(id);
        updateSummary();
      });
    });
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function updateSummary() {
    if (!summaryEl) return;
    const n = selectedIds.size;
    if (n === 0) {
      summaryEl.textContent = "Select one or more blocks, then generate the PDF.";
      return;
    }
    const sel = blockRows.filter((r) => selectedIds.has(String(r.id)));
    const ac = sel.reduce((a, r) => a + (Number(r.expected_area_acres) || 0), 0);
    summaryEl.textContent = `${n} block(s) selected — ${fmtNum(ac, 1)} ac expected (DB). Report will add parcel-level cultivation and harvest totals.`;
  }

  async function loadBlockList() {
    if (!listEl) return;
    listEl.innerHTML = `<p class="farm-report__empty">Loading blocks…</p>`;
    const { data, error } = await supabase
      .from("vsl_blocks")
      .select("id, block_code, block_name, estate_name, expected_area_acres, cultivation_status, geometry_status")
      .order("block_code", { ascending: true });
    if (error) {
      listEl.innerHTML = `<p class="farm-report__error">Could not load blocks: ${escapeHtml(error.message)}</p>`;
      if (setStatus) setStatus(statusEl, `Report: ${error.message}`, true);
      return;
    }
    blockRows = data || [];
    renderList();
    updateSummary();
  }

  filterInput?.addEventListener("input", () => {
    filterText = filterInput.value?.trim() ?? "";
    renderList();
  });

  selectAllBtn?.addEventListener("click", () => {
    for (const r of blockRows.filter(matchesFilter)) {
      selectedIds.add(String(r.id));
    }
    renderList();
    updateSummary();
  });

  clearBtn?.addEventListener("click", () => {
    selectedIds.clear();
    renderList();
    updateSummary();
  });

  refreshBtn?.addEventListener("click", () => void loadBlockList());

  panelBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePanel();
  });
  closeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closePanel();
  });

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

  function fitToSelectedBlockFeatures(ids) {
    if (!map || !blocksSource) return;
    const want = new Set(ids.map(String));
    const feats = blocksSource.getFeatures().filter((f) => want.has(String(f.getId())));
    if (feats.length === 0) return;
    const ext = ol.extent.createEmpty();
    for (const f of feats) {
      const g = f.getGeometry();
      if (g) ol.extent.extend(ext, g.getExtent());
    }
    if (ol.extent.isEmpty(ext)) return;
    map.getView().fit(ext, { padding: [36, 36, 36, 36], maxZoom: 17, duration: 500 });
  }

  /**
   * @param {import("jspdf").jsPDF} doc
   * @param {string} title
   */
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

  genBtn?.addEventListener("click", () => void generateReportPdf());

  async function generateReportPdf() {
    const { jsPDF } = window.jspdf || {};
    if (!jsPDF) {
      if (setStatus) setStatus(statusEl, "PDF engine not loaded.", true);
      return;
    }
    const ids = [...selectedIds];
    if (ids.length === 0) {
      if (setStatus) setStatus(statusEl, "Select at least one block for the report.", true);
      return;
    }
    genBtn.disabled = true;
    if (setStatus) setStatus(statusEl, "Building report…");

    try {
      const { data: blockData, error: e1 } = await supabase
        .from("vsl_blocks")
        .select(
          "id, block_code, block_name, estate_name, expected_area_acres, geometry_status, cultivation_status, harvest_tonnes, last_harvest_date, cultivation_updated_at"
        )
        .in("id", ids);
      if (e1) throw e1;
      const blocks = blockData || [];
      const { data: parcelData, error: e2 } = await supabase
        .from("vsl_parcels")
        .select("block_id, parcel_no, expected_area_acres, cultivation_status, harvest_tonnes, last_harvest_date, geometry_status")
        .in("block_id", ids);
      if (e2) throw e2;
      const parcels = parcelData || [];

      fitToSelectedBlockFeatures(ids);
      const mapImg = await captureMapDataUrl();

      const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
      const pageW = doc.internal.pageSize.getWidth();
      const margin = 14;
      const contentW = pageW - margin * 2;

      addHeaderFooter(doc, "Agronomic summary (selected blocks)");
      let y0 = 36;

      doc.setFontSize(8.5);
      doc.setTextColor(50, 50, 50);
      const idList = blocks
        .map((b) => b.block_code)
        .filter(Boolean)
        .join(", ");
      doc.text(`Blocks: ${idList || "—"}`, margin, y0);
      y0 += 5;
      const totalAc = blocks.reduce((a, b) => a + (Number(b.expected_area_acres) || 0), 0);
      const pAc = parcels.reduce((a, p) => a + (Number(p.expected_area_acres) || 0), 0);
      const harvest = sumHarvestTonnes(parcels);
      doc.text(
        `Expected area (blocks): ${fmtNum(totalAc, 1)} ac · Plots in scope: ${parcels.length} · Sum expected plot acres: ${fmtNum(pAc, 1)} ac`,
        margin,
        y0
      );
      y0 += 5;
      doc.text(
        `Recorded harvest (plots, where entered): ${harvest.n > 0 ? fmtNum(harvest.sum, 2) + " t across " + harvest.n + " plot(s)" : "—"}`,
        margin,
        y0
      );
      y0 += 8;

      if (mapImg) {
        const imgW = contentW;
        const imgH = 95;
        try {
          doc.addImage(mapImg, "JPEG", margin, y0, imgW, imgH);
        } catch {
          doc.text("Map image could not be embedded.", margin, y0);
        }
        y0 += imgH + 6;
      } else {
        doc.setFontSize(8);
        doc.text("Map capture unavailable (tiles may block snapshot).", margin, y0);
        y0 += 8;
      }

      doc.setFontSize(7.5);
      doc.setTextColor(90, 90, 90);
      doc.text("Map extent zooms to selected blocks when geometries are loaded in the current session.", margin, y0);
      y0 += 6;

      doc.addPage();
      addHeaderFooter(doc, "Cultivation overview");
      y0 = 36;

      const pCounts = countByKey(parcels, "cultivation_status");
      const pBody = Object.keys(pCounts)
        .sort()
        .map((k) => [CULTIVATION_LABELS[k] || k, String(pCounts[k])]);
      doc.setFontSize(9);
      doc.setTextColor(30, 30, 30);
      doc.text("Parcels in selection — cultivation status (count)", margin, y0);
      y0 += 4;
      doc.autoTable({
        startY: y0,
        head: [["Status", "Parcel count"]],
        body: pBody.length ? pBody : [["—", "0"]],
        margin: { left: margin, right: margin },
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [34, 78, 34] }
      });
      y0 = doc.lastAutoTable.finalY + 10;

      doc.setFontSize(9);
      doc.text("Key interpretation (sugarcane operations)", margin, y0);
      y0 += 4;
      doc.setFontSize(7.5);
      doc.setTextColor(60, 60, 60);
      const bullets = [
        "Standing / harvested shares indicate crop cycle position for the selected area.",
        "Replant or renovation flags areas needing follow-up in the field and in planning.",
        "Use harvest tonnes only where they have been recorded at plot level; gaps are normal early in the season."
      ];
      for (const b of bullets) {
        doc.text("• " + b, margin, y0, { maxWidth: contentW });
        y0 += 5;
      }
      y0 += 4;

      /** Per-block */
      for (const bl of blocks.sort((a, b) => String(a.block_code).localeCompare(String(b.block_code), undefined, { numeric: true }))) {
        const bParcels = parcels.filter((p) => String(p.block_id) === String(bl.id));
        doc.addPage();
        addHeaderFooter(doc, `Block ${bl.block_code}`);
        y0 = 36;
        doc.setFontSize(9);
        doc.setTextColor(20, 20, 20);
        doc.text(`Name: ${String(bl.block_name || "—")} · Estate: ${String(bl.estate_name || "—")}`, margin, y0);
        y0 += 5;
        doc.setFontSize(7.5);
        doc.setTextColor(60, 60, 60);
        doc.text(
          `Block cultiv.: ${CULTIVATION_LABELS[bl.cultivation_status] || bl.cultivation_status} · Block harvest (if any): ${
            bl.harvest_tonnes != null ? fmtNum(bl.harvest_tonnes, 2) + " t" : "—"
          }`,
          margin,
          y0
        );
        y0 += 6;
        doc.autoTable({
          startY: y0,
          head: [["Plot", "Area (ac)", "Cultivation", "Harvest (t)", "Last harvest"]],
          body: bParcels.length
            ? bParcels
                .sort((a, b) => (Number(a.parcel_no) || 0) - (Number(b.parcel_no) || 0))
                .map((p) => [
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
      }

      const fname = `VSL_farm_report_${new Date().toISOString().slice(0, 10)}.pdf`;
      doc.save(fname);
      if (setStatus) setStatus(statusEl, "Report downloaded.");
    } catch (e) {
      if (setStatus) setStatus(statusEl, (e && e.message) || "Report failed", true);
    } finally {
      genBtn.disabled = false;
    }
  }

  return { close: closePanel, open: openPanel };
}
