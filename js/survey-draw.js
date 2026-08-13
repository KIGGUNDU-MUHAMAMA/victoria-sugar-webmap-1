/**
 * Survey "Draw" tab.
 *
 * Entity type (point/line/polygon) -> Feature (from vsl_feature_type) ->
 * click Start Drawing -> click the map -> saved automatically on finish.
 *
 * Plot and Block are "system" feature types (vsl_feature_type.is_system):
 * drawing one of these still creates a row in vsl_parcels/vsl_blocks (via
 * vsl_draw_create_parcel/vsl_draw_create_block), scoped by the Estate/Block
 * filter dropdowns shown only for those two types. Every other feature type
 * (trees, boreholes, roads, walls, …) saves straight into the generic
 * vsl_feature table against its vsl_feature_type row.
 */

const OL_TYPE_BY_ENTITY = { point: "Point", line: "LineString", polygon: "Polygon", block: "Polygon", plot: "Polygon" };
// "block"/"plot" are direct drawEntityTypeSelect values that map straight to
// their vsl_feature_type system row — see isSystemEntity()/currentFeatureType().
const SYSTEM_ENTITY_VALUES = ["block", "plot"];

export function initSurveyDraw({ map, cfg, supabase, setStatus, statusEl, loadLayersFromDb, refreshEstateBoundaries }) {
  const entitySelect = document.getElementById("drawEntityTypeSelect");
  const featureRow = document.getElementById("drawFeatureRow");
  const featureSelect = document.getElementById("drawFeatureSelect");
  const manageBtn = document.getElementById("drawManageFeaturesBtn");
  const plotBlockFields = document.getElementById("drawPlotBlockFields");
  const automaticRow = document.getElementById("drawAutomaticRow");
  const automaticCb = document.getElementById("drawAutomaticCb");
  const estateSelect = document.getElementById("drawEstateSelect");
  const blockFilterRow = document.getElementById("drawBlockFilterRow");
  const blockSelect = document.getElementById("drawBlockSelect");
  const startBtn = document.getElementById("drawStartBtn");
  const startBtnIcon = document.getElementById("drawStartBtnIcon");
  const startBtnLabel = document.getElementById("drawStartBtnLabel");
  const feedbackEl = document.getElementById("drawToolsFeedback");
  const clearBtn = document.getElementById("clearDrawingsBtn");
  const stopBtn = document.getElementById("stopDrawBtn");

  if (!entitySelect || !featureSelect) return null;

  function restHeaders() {
    return {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
      Accept: "application/json"
    };
  }

  // Plain blue instructional text now (matches survey-import.js's
  // #surveySummary) — not a bordered/error-styled box, so there's no more
  // error-state class to toggle here. Errors still surface through the
  // global status bar below exactly as before.
  function feedback(msg, isError) {
    if (feedbackEl) {
      feedbackEl.textContent = msg || "";
      feedbackEl.hidden = !msg;
    }
    if (msg) setStatus?.(statusEl, msg, isError);
  }

  // Start/Stop toggle — same look/behaviour as the Edit tab's
  // editSelectFeatureBtn (js/survey-edit.js setToggleButtonState): a play
  // icon + primary color at rest, a stop-circle icon + danger color while a
  // drawing session is active.
  function setDrawToggleState(active) {
    startBtn.classList.toggle("uam-btn--danger", active);
    startBtn.classList.toggle("uam-btn--primary", !active);
    if (startBtnIcon) startBtnIcon.className = active ? "fas fa-stop-circle" : "fas fa-play";
    if (startBtnLabel) startBtnLabel.textContent = active ? "Stop Drawing" : "Start Drawing";
  }

  // Live preview of whatever's currently being sketched — cleared as soon
  // as the shape is saved (or the drawing is cancelled/cleared).
  const sketchSource = new ol.source.Vector();
  const sketchLayer = new ol.layer.Vector({
    source: sketchSource,
    style: new ol.style.Style({
      stroke: new ol.style.Stroke({ color: "#0d47a1", width: 2 }),
      fill: new ol.style.Fill({ color: "rgba(13, 71, 161, 0.15)" }),
      image: new ol.style.Circle({
        radius: 5,
        fill: new ol.style.Fill({ color: "#0d47a1" }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 1.5 })
      })
    }),
    zIndex: 950
  });
  sketchLayer.set("displayInLayerSwitcher", false);
  map.addLayer(sketchLayer);

  // Persistent layer showing every already-saved custom feature (trees,
  // boreholes, roads, walls, …) — separate from sketchLayer, which only
  // ever holds the shape currently being drawn. Styled per-row from its
  // feature type's color; also what the Edit tab selects from.
  const featuresSource = new ol.source.Vector();
  const featuresLayer = new ol.layer.Vector({
    source: featuresSource,
    style: (feature) => styleForFeature(feature),
    zIndex: 910
  });
  featuresLayer.set("displayInLayerSwitcher", false);
  map.addLayer(featuresLayer);

  // Font Awesome icons (vsl_feature_type.icon, e.g. "fa-tree") are just CSS
  // classes — OL can't use a class directly, so this resolves the actual
  // glyph character Font Awesome's stylesheet assigns to that class (via a
  // throwaway <i> element's computed `::before` content) once, then reuses
  // it as plain text in an ol.style.Text with the Font Awesome font family.
  // No hardcoded icon->codepoint table to keep in sync with ICON_LIBRARY in
  // manage-features.js this way — works for any icon class, not just the
  // curated list there.
  const faGlyphCache = new Map();
  function faGlyph(iconClass) {
    if (!iconClass) return null;
    if (faGlyphCache.has(iconClass)) return faGlyphCache.get(iconClass);
    const el = document.createElement("i");
    el.className = `fas ${iconClass}`;
    el.style.cssText = "position:absolute;left:-9999px;visibility:hidden;";
    document.body.appendChild(el);
    const content = getComputedStyle(el, "::before").content;
    document.body.removeChild(el);
    const glyph = content && content !== "none" && content !== "normal" ? content.replace(/^["']|["']$/g, "") : null;
    faGlyphCache.set(iconClass, glyph);
    return glyph;
  }
  // The glyph *character* resolves immediately (it just reads a CSS rule —
  // see faGlyph above), but actually painting it needs the Font Awesome
  // webfont file itself loaded, or canvas silently falls back to a
  // tofu/blank box. Re-paint once it's confirmed ready.
  document.fonts?.ready?.then(() => {
    featuresLayer.changed();
    sketchLayer.changed();
  });

  // Live area for a polygon feature, in hectares — used only for the
  // optional "Area" on-map label (display_params), computed client-side
  // from the already-loaded geometry rather than round-tripping to the DB.
  function areaHectares(geometry) {
    // Matches the { projection: "EPSG:3857" } convention map-app.js's own
    // ol.sphere.getArea() calls use everywhere else in this app.
    const m2 = ol.sphere.getArea(geometry, { projection: "EPSG:3857" });
    return (m2 / 10000).toFixed(2);
  }

  // "Show on map" text label(s), built from whichever of name/area this
  // feature type has checked (vsl_feature_type.display_params, max 1 for
  // point/line, max 2 for polygon — see manage-features.js's form and the
  // vsl_feature_type_display_params_max DB constraint). Offset below the
  // marker/shape so it doesn't sit on top of the icon/stroke.
  function displayLabelStyle(feature, offsetY) {
    const params = feature.get("_display");
    if (!Array.isArray(params) || !params.length) return null;
    const lines = [];
    if (params.includes("name") && feature.get("_name")) lines.push(feature.get("_name"));
    if (params.includes("area")) lines.push(`${areaHectares(feature.getGeometry())} ha`);
    if (!lines.length) return null;
    return new ol.style.Style({
      text: new ol.style.Text({
        text: lines.join("\n"),
        font: "600 11px sans-serif",
        fill: new ol.style.Fill({ color: "#1d2a1d" }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 3 }),
        offsetY,
        textAlign: "center"
      })
    });
  }

  function styleForFeature(feature) {
    const color = feature.get("_color") || "#3f8f3f";
    const geomType = feature.getGeometry()?.getType();
    if (geomType === "Point" || geomType === "MultiPoint") {
      const glyph = faGlyph(feature.get("_icon"));
      const radius = Math.max(3, Number(feature.get("_iconSize")) || 10);
      const rotationDeg = Number(feature.get("_iconRotation")) || 0;
      const styles = [
        new ol.style.Style({
          image: new ol.style.Circle({
            radius,
            rotation: (rotationDeg * Math.PI) / 180,
            fill: new ol.style.Fill({ color }),
            stroke: new ol.style.Stroke({ color: "#fff", width: 1.5 })
          })
        })
      ];
      if (glyph) {
        styles.push(
          new ol.style.Style({
            text: new ol.style.Text({
              text: glyph,
              font: `900 ${Math.round(radius * 1.1)}px "Font Awesome 6 Free"`,
              rotation: (rotationDeg * Math.PI) / 180,
              fill: new ol.style.Fill({ color: "#fff" }),
              textAlign: "center",
              textBaseline: "middle"
            })
          })
        );
      }
      const label = displayLabelStyle(feature, -(radius + 10));
      if (label) styles.push(label);
      return styles;
    }
    const weight = Math.max(1, Number(feature.get("_weight")) || (geomType?.includes("Line") ? 3 : 2));
    if (geomType === "LineString" || geomType === "MultiLineString") {
      const styles = [new ol.style.Style({ stroke: new ol.style.Stroke({ color, width: weight }) })];
      const label = displayLabelStyle(feature, -10);
      if (label) styles.push(label);
      return styles;
    }
    const styles = [
      new ol.style.Style({
        stroke: new ol.style.Stroke({ color, width: weight }),
        fill: new ol.style.Fill({ color: hexToRgba(color, 0.18) })
      })
    ];
    const label = displayLabelStyle(feature, 0);
    if (label) styles.push(label);
    return styles;
  }

  function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
    if (!m) return `rgba(63,143,63,${alpha})`;
    const [r, g, b] = m.slice(1).map((h) => parseInt(h, 16));
    return `rgba(${r},${g},${b},${alpha})`;
  }

  let featureTypes = [];
  let drawInteraction = null;

  async function fetchFeatureTypes() {
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_feature_type?select=*&is_active=eq.true&order=sort_order.asc`;
      const res = await fetch(url, { headers: restHeaders() });
      if (!res.ok) throw new Error("Failed to load feature types");
      featureTypes = await res.json();
    } catch (e) {
      console.error("[Victoria Survey] Error fetching feature types:", e);
      featureTypes = [];
    }
  }

  async function refreshFeaturesLayer() {
    try {
      // Plain table reads return PostGIS geometry as hex EWKB, not GeoJSON —
      // this RPC does the ST_AsGeoJSON() conversion server-side (same
      // pattern as vsl_get_features_bbox for blocks/parcels).
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/vsl_list_features`;
      const res = await fetch(url, {
        method: "POST",
        headers: { ...restHeaders(), "Content-Type": "application/json" },
        body: "{}"
      });
      if (!res.ok) throw new Error("Failed to load features");
      const rows = await res.json();
      const gj = new ol.format.GeoJSON();
      featuresSource.clear(true);
      for (const row of rows) {
        if (!row.geom) continue;
        const olFeature = gj.readFeature(
          { type: "Feature", geometry: row.geom, properties: {} },
          { dataProjection: "EPSG:4326", featureProjection: "EPSG:3857" }
        );
        olFeature.setId(row.id);
        olFeature.set("_source", "vsl_feature");
        olFeature.set("_name", row.name || row.feature_type_name || "");
        olFeature.set("_color", row.color || "#3f8f3f");
        olFeature.set("_icon", row.icon || "");
        olFeature.set("_iconSize", row.icon_size);
        olFeature.set("_iconRotation", row.icon_rotation);
        olFeature.set("_weight", row.line_weight);
        olFeature.set("_display", Array.isArray(row.display_params) ? row.display_params : []);
        featuresSource.addFeature(olFeature);
      }
    } catch (e) {
      console.error("[Victoria Survey] Error loading features layer:", e);
    }
  }

  window.addEventListener("vsl-features-changed", refreshFeaturesLayer);

  function isSystemEntity() {
    return SYSTEM_ENTITY_VALUES.includes(entitySelect.value);
  }

  function currentFeatureType() {
    if (isSystemEntity()) {
      return featureTypes.find((f) => f.is_system && f.code === entitySelect.value) || null;
    }
    const id = featureSelect.value;
    if (!id) return null;
    return featureTypes.find((f) => String(f.id) === String(id)) || null;
  }

  function isPlotBlockSelected() {
    const ft = currentFeatureType();
    return !!ft?.is_system && (ft.code === "plot" || ft.code === "block");
  }

  function populateFeatureSelect() {
    if (isSystemEntity()) {
      // Block/Plot are chosen directly via drawEntityTypeSelect now — no
      // separate Feature pick needed, and no longer offered from the
      // generic Polygon list below either (see the filter there).
      if (featureRow) featureRow.hidden = true;
      updatePlotBlockVisibility();
      return;
    }
    if (featureRow) featureRow.hidden = false;
    const kind = entitySelect.value;
    const keep = featureSelect.value;
    const rows = featureTypes.filter(
      (f) => f.geometry_kind === kind && !(f.is_system && (f.code === "plot" || f.code === "block"))
    );
    featureSelect.innerHTML =
      '<option value="">Feature…</option>' +
      rows.map((f) => `<option value="${f.id}">${f.name}</option>`).join("");
    if (keep && rows.some((f) => String(f.id) === keep)) {
      featureSelect.value = keep;
    }
    updatePlotBlockVisibility();
  }

  function updatePlotBlockVisibility() {
    const show = isPlotBlockSelected();
    if (plotBlockFields) plotBlockFields.hidden = !show;
    if (!show) return;
    const ft = currentFeatureType();
    const isPlot = ft?.code === "plot";
    if (blockFilterRow) blockFilterRow.hidden = !isPlot;
    // "Automatically Choose Block" is Plot-only — a Block has no geometry
    // to resolve an Estate *from*, so it always needs one picked manually.
    if (automaticRow) automaticRow.hidden = !isPlot;
    if (!isPlot && automaticCb) automaticCb.checked = false;
    applyDrawAutoState();
  }

  // Mirrors survey-import.js's applyAutoSelectState() for the Import tab's
  // "Automatically Choose Block" — same idea, same relabelled/disabled
  // placeholders, just for the Draw tab's single Estate/Block pair.
  function applyDrawAutoState() {
    const ft = currentFeatureType();
    const auto = ft?.code === "plot" && !!automaticCb?.checked;
    if (estateSelect) {
      estateSelect.disabled = auto;
      if (auto) {
        estateSelect.innerHTML = '<option value="">— Auto Estate —</option>';
        estateSelect.value = "";
      } else {
        refreshDrawEstateOptions();
      }
    }
    if (blockSelect) {
      if (auto) {
        blockSelect.innerHTML = '<option value="">— Auto Block —</option>';
        blockSelect.value = "";
        blockSelect.disabled = true;
      } else {
        refreshDrawBlockOptions(estateSelect?.value || "");
      }
    }
  }
  automaticCb?.addEventListener("change", applyDrawAutoState);

  async function refreshDrawEstateOptions() {
    if (!estateSelect) return;
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_estate?select=id,estate_name&order=estate_name.asc`;
      const res = await fetch(url, { headers: restHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const keep = estateSelect.value;
      estateSelect.innerHTML =
        '<option value="">— Select Estate —</option>' +
        data.map((e) => `<option value="${e.id}">${e.estate_name}</option>`).join("");
      if (keep && [...estateSelect.options].some((o) => o.value === keep)) {
        estateSelect.value = keep;
      }
    } catch (e) {
      console.error("[Victoria Survey] Error fetching estates:", e);
    }
  }

  async function refreshDrawBlockOptions(estateId) {
    if (!blockSelect) return;
    if (!estateId) {
      blockSelect.innerHTML = '<option value="">— Select Estate first —</option>';
      blockSelect.disabled = true;
      return;
    }
    blockSelect.disabled = false;
    blockSelect.innerHTML = '<option value="">Loading blocks…</option>';
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_blocks?select=id,block_code&estate_id=eq.${estateId}&order=block_code.asc`;
      const res = await fetch(url, { headers: restHeaders() });
      if (!res.ok) throw new Error("Failed to fetch blocks");
      const data = await res.json();
      blockSelect.innerHTML =
        '<option value="">— Select Block —</option>' +
        data.map((b) => `<option value="${b.id}">Block ${b.block_code}</option>`).join("");
    } catch (e) {
      console.error("[Victoria Survey] Error fetching blocks:", e);
      blockSelect.innerHTML = '<option value="">Error loading blocks</option>';
    }
  }

  entitySelect.addEventListener("change", populateFeatureSelect);
  featureSelect.addEventListener("change", updatePlotBlockVisibility);
  estateSelect?.addEventListener("change", () => refreshDrawBlockOptions(estateSelect.value));

  // Manage Estates (js/manage-estates.js) dispatches this after any
  // add/rename/delete so this dropdown doesn't go stale while open.
  window.addEventListener("vsl-estates-changed", () => refreshDrawEstateOptions());

  manageBtn?.addEventListener("click", () => {
    window.openManageFeaturesPanel?.();
  });

  // The manage-features window fires this after any create/edit/delete so
  // the feature dropdown here stays in sync without a manual refresh.
  window.addEventListener("vsl-feature-types-changed", async () => {
    await fetchFeatureTypes();
    populateFeatureSelect();
  });

  function stopDrawing() {
    if (drawInteraction) {
      map.removeInteraction(drawInteraction);
      drawInteraction = null;
      // Re-enable the map-click parcel/block selection (and its
      // .parcel-action-toolbar) that was suppressed for the duration of
      // this drawing session — see window.vslSetParcelClickEnabled
      // (map-app.js) and the matching disable call in startBtn's handler.
      window.vslSetParcelClickEnabled?.(true);
    }
    sketchSource.clear(true);
    setDrawToggleState(false);
    feedback("", false);
  }

  // Auto-stop if the user switches away from the Draw tab mid-session —
  // same pattern survey-edit.js uses for its own tab.
  const tabPanel = document.getElementById("uamTabDraw");
  if (tabPanel) {
    const drawTabObserver = new MutationObserver(() => {
      if (tabPanel.hidden) stopDrawing();
    });
    drawTabObserver.observe(tabPanel, { attributes: true, attributeFilter: ["hidden"] });
  }

  // Shared with the Measure tool (map-app.js already wires these two IDs to
  // stopActiveTool()/measureSource.clear()) — we additionally tear down our
  // own sketch layer/interaction here.
  clearBtn?.addEventListener("click", () => sketchSource.clear(true));
  stopBtn?.addEventListener("click", stopDrawing);

  startBtn?.addEventListener("click", () => {
    if (drawInteraction) {
      stopDrawing();
      return;
    }
    const ft = currentFeatureType();
    if (!ft) {
      feedback(isSystemEntity() ? "That system feature type wasn't found — check Manage Features." : "Choose a feature before drawing.", true);
      return;
    }
    if (isPlotBlockSelected()) {
      const isPlot = ft.code === "plot";
      const auto = isPlot && !!automaticCb?.checked;
      // Blocks always need their Estate picked manually; Plots only need
      // it when "Automatically Choose Block" is off (on = resolved after
      // drawing, from the shape itself — see saveDrawnPlot below).
      if (!auto) {
        if (!estateSelect.value) {
          feedback("Select an Estate before drawing.", true);
          return;
        }
        if (isPlot && !blockSelect.value) {
          feedback("Select a Block before drawing a plot.", true);
          return;
        }
      }
    }

    const olType = OL_TYPE_BY_ENTITY[ft.geometry_kind];
    sketchSource.clear(true);
    drawInteraction = new ol.interaction.Draw({ source: sketchSource, type: olType });
    map.addInteraction(drawInteraction);
    // Suppress the plain-click parcel/block selection toolbar for the
    // duration of this drawing session — otherwise clicking to place a
    // vertex on top of an existing plot/block would also pop that up.
    window.vslSetParcelClickEnabled?.(false);
    drawInteraction.on("drawend", async (evt) => {
      map.removeInteraction(drawInteraction);
      drawInteraction = null;
      window.vslSetParcelClickEnabled?.(true);
      setDrawToggleState(false);
      await saveDrawnFeature(ft, evt.feature);
      sketchSource.clear(true);
    });
    setDrawToggleState(true);
    feedback(
      olType === "Point"
        ? `Click the map to place the ${ft.name.toLowerCase()}.`
        : `Click to add vertices, double-click to finish the ${ft.name.toLowerCase()}.`,
      false
    );
  });

  async function saveDrawnFeature(ft, olFeature) {
    const gj = new ol.format.GeoJSON();
    const geoJsonGeom = gj.writeGeometryObject(olFeature.getGeometry(), {
      featureProjection: "EPSG:3857",
      dataProjection: "EPSG:4326"
    });

    if (ft.is_system && (ft.code === "plot" || ft.code === "block")) {
      await savePlotOrBlock(ft, geoJsonGeom);
      return;
    }

    if (!supabase) {
      feedback("Can't save — Supabase client not available.", true);
      return;
    }
    try {
      const { data: userData } = await supabase.auth.getUser();
      // geom is a PostGIS column — PostgREST can't cast a plain GeoJSON
      // body to it directly, so this goes through an RPC that does
      // ST_GeomFromGeoJSON() server-side (see vsl_create_feature).
      const { error } = await supabase.rpc("vsl_create_feature", {
        p_feature_type_id: ft.id,
        p_geojson: geoJsonGeom,
        p_user_id: userData?.user?.id ?? null
      });
      if (error) throw error;
      feedback(`${ft.name} saved.`, false);
      await refreshFeaturesLayer();
      window.dispatchEvent(new CustomEvent("vsl-features-changed"));
    } catch (e) {
      console.error("[Victoria Survey] Failed to save feature:", e);
      feedback(`Failed to save: ${e.message}`, true);
    }
  }

  // Same RPC + response shape the Import tab's "Automatically Choose Block"
  // uses for a whole batch (survey-import.js runAutoAssign) — just a single-
  // entry p_features array here, for the one shape that was just drawn.
  async function resolveBlockForGeometry(geoJsonGeom) {
    try {
      const base = cfg.SUPABASE_URL.replace(/\/$/, "");
      const res = await fetch(`${base}/rest/v1/rpc/vsl_resolve_parcel_blocks`, {
        method: "POST",
        headers: { ...restHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ p_features: [{ parcel_id: "draw-tmp", geometry: geoJsonGeom }] })
      });
      const data = await res.json();
      if (!res.ok || !data?.success) return null;
      const match = Array.isArray(data.matches) ? data.matches[0] : null;
      return match?.block_id || null;
    } catch (e) {
      console.error("[Victoria Survey] resolveBlockForGeometry failed:", e);
      return null;
    }
  }

  async function savePlotOrBlock(ft, geoJsonGeom) {
    if (!supabase) {
      feedback("Can't save — Supabase client not available.", true);
      return;
    }
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id ?? null;

      if (ft.code === "block") {
        const estateId = Number(estateSelect.value);
        const { error } = await supabase.rpc("vsl_draw_create_block", {
          p_estate_id: estateId,
          p_geojson: geoJsonGeom,
          p_user_id: userId
        });
        if (error) throw error;
        feedback("Block saved.", false);
        await refreshDrawBlockOptions(estateSelect.value);
        // Same DB trigger as CSV import — recomputes the parent estate's
        // boundary from its blocks. Pull the fresh geometry into the map.
        await refreshEstateBoundaries?.();
      } else {
        let blockId = blockSelect.value;
        if (automaticCb?.checked) {
          feedback("Matching plot to a block…", false);
          blockId = await resolveBlockForGeometry(geoJsonGeom);
          if (!blockId) {
            feedback("This plot doesn't fall inside any existing block — turn off \"Automatically Choose Block\" and pick one manually, then draw it again.", true);
            return;
          }
        }
        if (!blockId) {
          feedback("Select a Block before drawing a plot.", true);
          return;
        }
        const { error } = await supabase.rpc("vsl_draw_create_parcel", {
          p_block_id: blockId,
          p_geojson: geoJsonGeom,
          p_user_id: userId
        });
        if (error) throw error;
        feedback("Plot saved.", false);
      }
      await loadLayersFromDb?.();
    } catch (e) {
      console.error("[Victoria Survey] Failed to save plot/block:", e);
      feedback(`Failed to save: ${e.message}`, true);
    }
  }

  (async () => {
    await fetchFeatureTypes();
    populateFeatureSelect();
    await refreshFeaturesLayer();
  })();

  return {
    refreshFeatureTypes: async () => {
      await fetchFeatureTypes();
      populateFeatureSelect();
    },
    getFeaturesLayer: () => featuresLayer,
    getFeaturesSource: () => featuresSource,
    refreshFeaturesLayer
  };
}
