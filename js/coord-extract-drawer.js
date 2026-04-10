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

export function initCoordExtractDrawer({ map, parcelsLayer, setStatus, statusEl }) {
  const drawer = document.getElementById("coordExtractDrawer");
  const toggleBtn = document.getElementById("coordExtractorMainBtn");
  const closeBtn = document.getElementById("coordExtractCloseBtn");
  const crsSelect = document.getElementById("coordExtractCrsSelect");
  const exportCsv = document.getElementById("coordExtractCsv");
  const exportDxf = document.getElementById("coordExtractDxf");

  if (!drawer || !toggleBtn) {
    return { closeDrawer: () => {} };
  }

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
  let selectInteraction = null;

  async function ensureProj4() {
    if (proj4lib) return proj4lib;
    const mod = await import("https://esm.sh/proj4@2.11.0");
    proj4lib = mod.default;
    registerProj4Defs(proj4lib);
    return proj4lib;
  }

  function closeDrawer() {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    toggleBtn.classList.remove("active");
    if (selectInteraction) {
      map.removeInteraction(selectInteraction);
      selectInteraction = null;
    }
  }

  function openDrawer() {
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    toggleBtn.classList.add("active");

    document.getElementById("surveyDrawer")?.classList.remove("open");
    document.getElementById("surveyPanelBtn")?.classList.remove("active");
    document.getElementById("coordSearchDrawer")?.classList.remove("open");
    document.getElementById("coordSearchBtn")?.classList.remove("active");

    if (!selectInteraction) {
      selectInteraction = new ol.interaction.Select({
        layers: [parcelsLayer],
        style: new ol.style.Style({
          stroke: new ol.style.Stroke({ color: "#ff9800", width: 3 }),
          fill: new ol.style.Fill({ color: "rgba(255, 152, 0, 0.12)" })
        })
      });
      selectInteraction.on("select", async (e) => {
        const picked = e.selected[0];
        selectInteraction.getFeatures().clear();
        if (!picked) return;

        const wantCsv = exportCsv?.checked;
        const wantDxf = exportDxf?.checked;
        if (!wantCsv && !wantDxf) {
          setStatus(statusEl, "Enable CSV and/or DXF export.", true);
          return;
        }

        const crs = crsSelect?.value;
        if (!crs) {
          setStatus(statusEl, "Choose an export coordinate system.", true);
          return;
        }

        const geom = picked.getGeometry();
        if (!geom) return;

        const rings3857 = getExteriorRings3857(geom);
        if (!rings3857.length) {
          setStatus(statusEl, "Selected feature has no polygon geometry.", true);
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
          setStatus(statusEl, `Downloaded ${parts.join(" + ")} (${rows.length} corner point(s), ${crs}).`);
        } catch (err) {
          setStatus(statusEl, err.message || "Export failed", true);
        }
      });
      map.addInteraction(selectInteraction);
    }
  }

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

  return { closeDrawer };
}
