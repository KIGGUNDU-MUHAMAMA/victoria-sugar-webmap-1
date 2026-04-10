import { CRS_OPTIONS, registerProj4Defs, toProjectedFromWgs84 } from "./crs-definitions.js";

function downloadText(filename, text, mime = "text/plain;charset=utf-8") {
  const bom = filename.endsWith(".csv") ? "\uFEFF" : "";
  const blob = new Blob([bom + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeCsv(s) {
  const t = String(s ?? "");
  if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
  return t;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sameCoord(a, b, eps = 1e-5) {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

function ringWithoutDuplicateClose(ring) {
  if (ring.length >= 2 && sameCoord(ring[0], ring[ring.length - 1])) {
    return ring.slice(0, -1);
  }
  return ring;
}

function getExteriorRings3857(geometry) {
  const t = geometry.getType();
  if (t === "Polygon") {
    return [ringWithoutDuplicateClose(geometry.getLinearRing(0).getCoordinates())];
  }
  if (t === "MultiPolygon") {
    return geometry.getPolygons().map((poly) =>
      ringWithoutDuplicateClose(poly.getLinearRing(0).getCoordinates())
    );
  }
  return [];
}

function buildCsvRows(rings3857, proj4lib, crs, blockCode, parcelCode) {
  const rows = [];
  rings3857.forEach((ring, ri) => {
    ring.forEach((xy, pi) => {
      const [lon, lat] = ol.proj.transform(xy, "EPSG:3857", "EPSG:4326");
      const [x, y] = toProjectedFromWgs84(proj4lib, crs, lon, lat);
      rows.push({
        ring: ri + 1,
        pt: pi + 1,
        block: blockCode,
        parcel: parcelCode,
        crs,
        x,
        y
      });
    });
  });
  return rows;
}

function buildCsvContent(rows, crs) {
  const geo = crs === "EPSG:4326";
  const h1 = geo ? "longitude" : "easting";
  const h2 = geo ? "latitude" : "northing";
  const lines = [
    `ring_index,point_index,block_code,parcel_code,crs,${h1},${h2}`,
    ...rows.map((r) =>
      `${r.ring},${r.pt},${escapeCsv(r.block)},${escapeCsv(r.parcel)},${escapeCsv(r.crs)},${r.x},${r.y}`
    )
  ];
  return lines.join("\n");
}

function buildDxfFromRings(projectedRings) {
  const lines = [];
  const push = (a, b) => {
    lines.push(String(a));
    lines.push(String(b));
  };
  push(0, "SECTION");
  push(2, "HEADER");
  push(9, "$ACADVER");
  push(1, "AC1018");
  push(0, "ENDSEC");
  push(0, "SECTION");
  push(2, "TABLES");
  push(0, "TABLE");
  push(2, "LAYER");
  push(5, "2");
  push(100, "AcDbSymbolTable");
  push(70, "1");
  push(0, "LAYER");
  push(5, "10");
  push(100, "AcDbSymbolTableRecord");
  push(100, "AcDbLayerTableRecord");
  push(2, "PARCEL");
  push(70, "0");
  push(62, "5");
  push(6, "CONTINUOUS");
  push(0, "ENDTAB");
  push(0, "ENDSEC");
  push(0, "SECTION");
  push(2, "ENTITIES");

  let handle = 0x50;
  projectedRings.forEach((pts) => {
    const h = (handle++).toString(16).toUpperCase();
    push(0, "LWPOLYLINE");
    push(5, h);
    push(100, "AcDbEntity");
    push(8, "PARCEL");
    push(100, "AcDbPolyline");
    push(90, String(pts.length));
    push(70, "1");
    pts.forEach(([x, y]) => {
      push(10, x);
      push(20, y);
    });
  });

  push(0, "ENDSEC");
  push(0, "EOF");
  return lines.join("\r\n");
}

function sanitizeFilenamePart(s) {
  return String(s ?? "parcel").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "parcel";
}

export function initCoordExtractDrawer({
  map,
  parcelsLayer,
  blocksLayer,
  setStatus,
  statusEl,
  stopActiveTool
}) {
  const drawer = document.getElementById("coordExtractDrawer");
  const toggleBtn = document.getElementById("coordExtractorMainBtn");
  const closeBtn = document.getElementById("coordExtractCloseBtn");
  const crsSelect = document.getElementById("coordExtractCrsSelect");
  const exportCsv = document.getElementById("coordExtractCsv");
  const exportDxf = document.getElementById("coordExtractDxf");
  const pickBtn = document.getElementById("coordExtractPickBtn");
  const cancelPickBtn = document.getElementById("coordExtractCancelPickBtn");
  const hintEl = document.getElementById("coordExtractHint");
  const lastExportEl = document.getElementById("coordExtractLastExport");

  if (!drawer || !toggleBtn) {
    return { closeDrawer: () => {} };
  }

  const hitOpts = {
    hitTolerance: 14,
    layerFilter: (layer) => layer === parcelsLayer
  };

  CRS_OPTIONS.forEach((o) => {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    crsSelect?.appendChild(opt);
  });
  if (crsSelect) crsSelect.value = "EPSG:32636";
  if (exportCsv) exportCsv.checked = true;
  if (exportDxf) exportDxf.checked = true;

  let proj4lib = null;
  let pickingArmed = false;

  async function ensureProj4() {
    if (proj4lib) return proj4lib;
    const mod = await import("https://esm.sh/proj4@2.11.0");
    proj4lib = mod.default;
    registerProj4Defs(proj4lib);
    return proj4lib;
  }

  function setPickingUi(armed) {
    pickingArmed = armed;
    drawer.dataset.picking = armed ? "1" : "";
    pickBtn?.classList.toggle("btn-pick-parcel--armed", armed);
    if (cancelPickBtn) cancelPickBtn.hidden = !armed;
  }

  function setHint(html) {
    if (hintEl) hintEl.innerHTML = html;
  }

  function resetIdleHint() {
    setHint(
      "Choose CRS and formats, then press <strong>Select parcel on map</strong> and click a <strong>parcel</strong> polygon (blue fill)."
    );
  }

  async function runExportForFeature(picked) {
    const wantCsv = exportCsv?.checked;
    const wantDxf = exportDxf?.checked;
    if (!wantCsv && !wantDxf) {
      setStatus(statusEl, "Enable CSV and/or DXF export.", true);
      disarmPicking();
      return;
    }

    const crs = crsSelect?.value;
    if (!crs) {
      setStatus(statusEl, "Choose an export coordinate system.", true);
      disarmPicking();
      return;
    }

    const geom = picked.getGeometry();
    if (!geom) {
      disarmPicking();
      return;
    }

    const rings3857 = getExteriorRings3857(geom);
    if (!rings3857.length) {
      setStatus(statusEl, "Selected feature has no polygon geometry.", true);
      disarmPicking();
      return;
    }

    try {
      const p4 = await ensureProj4();
      const props = picked.getProperties();
      const blockCode = props.block_code ?? "";
      const parcelCode = props.parcel_code ?? props.parcel_no ?? "";

      const rows = buildCsvRows(rings3857, p4, crs, blockCode, parcelCode);
      const projectedRings = [];
      for (const ring of rings3857) {
        const pts = ring.map((xy) => {
          const [lon, lat] = ol.proj.transform(xy, "EPSG:3857", "EPSG:4326");
          return toProjectedFromWgs84(p4, crs, lon, lat);
        });
        projectedRings.push(pts);
      }

      const base = sanitizeFilenamePart(parcelCode || blockCode || picked.getId() || "export");
      const crsTag = crs.replace(":", "_");

      if (wantCsv) {
        const csv = buildCsvContent(rows, crs);
        downloadText(`${base}_${crsTag}_corners.csv`, csv, "text/csv;charset=utf-8");
      }
      if (wantDxf) {
        const dxf = buildDxfFromRings(projectedRings);
        downloadText(`${base}_${crsTag}_parcel.dxf`, dxf, "image/vnd.dxf");
      }

      const parts = [];
      if (wantCsv) parts.push("CSV");
      if (wantDxf) parts.push("DXF");
      const summary = `${parts.join(" + ")} · ${rows.length} corner(s) · ${crs}`;
      setStatus(statusEl, `Exported: ${summary}.`);

      if (lastExportEl) {
        lastExportEl.hidden = false;
        lastExportEl.innerHTML = `<strong>Last export</strong><br>${escapeHtml(String(parcelCode || base))} · ${escapeHtml(crs)} · ${escapeHtml(summary)}`;
      }

      disarmPicking({ preserveHint: true });
      setHint(
        "<strong>Export complete.</strong> Change CRS or formats if needed, then press <strong>Select parcel on map</strong> for another parcel."
      );
    } catch (err) {
      setStatus(statusEl, err.message || "Export failed", true);
      setHint(`<span class="extract-hint--warn">${escapeHtml(err.message || "Export failed")}</span>`);
      disarmPicking();
    }
  }

  function onExtractSingleClick(evt) {
    if (!pickingArmed || drawer.dataset.picking !== "1") return;

    let picked = null;
    map.forEachFeatureAtPixel(
      evt.pixel,
      (feature, layer) => {
        if (layer === parcelsLayer) {
          picked = feature;
          return true;
        }
      },
      hitOpts
    );

    if (!picked && blocksLayer) {
      let hitBlock = false;
      map.forEachFeatureAtPixel(
        evt.pixel,
        () => {
          hitBlock = true;
          return true;
        },
        {
          hitTolerance: hitOpts.hitTolerance,
          layerFilter: (layer) => layer === blocksLayer
        }
      );
      if (hitBlock) {
        setStatus(
          statusEl,
          "That is a block outline (red). Export needs a parcel — click inside a blue parcel polygon.",
          true
        );
        setHint(
          "<span class=\"extract-hint--warn\">You clicked a <strong>block</strong> (red line). Turn on PARCELS in the layer list and click a <strong>parcel</strong> (blue).</span>"
        );
        return;
      }
    }

    if (!picked) {
      setStatus(
        statusEl,
        "No parcel at this location. Zoom in, confirm PARCELS is visible, then click inside a parcel.",
        true
      );
      return;
    }

    void runExportForFeature(picked);
  }

  function disarmPicking(opts = {}) {
    setPickingUi(false);
    if (!opts.preserveHint) resetIdleHint();
  }

  function armPicking() {
    const wantCsv = exportCsv?.checked;
    const wantDxf = exportDxf?.checked;
    if (!wantCsv && !wantDxf) {
      setStatus(statusEl, "Choose at least one export format (CSV or DXF).", true);
      return;
    }
    if (!crsSelect?.value) {
      setStatus(statusEl, "Choose an export coordinate system.", true);
      return;
    }

    stopActiveTool?.();

    setPickingUi(true);
    setHint(
      "<strong>Picking active.</strong> Click a <strong>parcel</strong> polygon on the map. Downloads start as soon as a parcel is selected. Press <strong>Cancel picking</strong> to stop."
    );
    setStatus(statusEl, "Click a parcel on the map to export.");
  }

  map.on("singleclick", onExtractSingleClick);

  function closeDrawer() {
    disarmPicking();
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    toggleBtn.classList.remove("active");
    drawer.dataset.picking = "";
  }

  function openDrawer() {
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    toggleBtn.classList.add("active");

    document.getElementById("surveyDrawer")?.classList.remove("open");
    document.getElementById("surveyPanelBtn")?.classList.remove("active");
    document.getElementById("coordSearchDrawer")?.classList.remove("open");
    document.getElementById("coordSearchBtn")?.classList.remove("active");

    resetIdleHint();
    disarmPicking();
  }

  pickBtn?.addEventListener("click", () => {
    if (pickingArmed) {
      disarmPicking();
      setStatus(statusEl, "Picking cancelled.");
      return;
    }
    armPicking();
  });

  cancelPickBtn?.addEventListener("click", () => {
    disarmPicking();
    setStatus(statusEl, "Picking cancelled.");
  });

  toggleBtn.addEventListener("click", () => {
    if (drawer.classList.contains("open")) {
      closeDrawer();
    } else {
      openDrawer();
    }
  });

  closeBtn?.addEventListener("click", closeDrawer);

  function onForceClose() {
    if (drawer.classList.contains("open")) closeDrawer();
  }
  window.addEventListener("vsl-force-close-extract-drawer", onForceClose);

  window.addEventListener("vsl-open-extract-drawer", () => {
    document.getElementById("surveyDrawer")?.classList.remove("open");
    document.getElementById("surveyPanelBtn")?.classList.remove("active");
    document.getElementById("coordSearchDrawer")?.classList.remove("open");
    document.getElementById("coordSearchBtn")?.classList.remove("active");
    if (drawer.classList.contains("open")) {
      resetIdleHint();
      disarmPicking();
      return;
    }
    openDrawer();
  });

  return { closeDrawer };
}
