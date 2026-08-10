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

const OL_TYPE_BY_ENTITY = { point: "Point", line: "LineString", polygon: "Polygon" };

export function initSurveyDraw({ map, cfg, supabase, setStatus, statusEl, loadLayersFromDb, refreshEstateBoundaries }) {
  const entitySelect = document.getElementById("drawEntityTypeSelect");
  const featureSelect = document.getElementById("drawFeatureSelect");
  const manageBtn = document.getElementById("drawManageFeaturesBtn");
  const plotBlockFields = document.getElementById("drawPlotBlockFields");
  const estateSelect = document.getElementById("drawEstateSelect");
  const blockFilterRow = document.getElementById("drawBlockFilterRow");
  const blockSelect = document.getElementById("drawBlockSelect");
  const startBtn = document.getElementById("drawStartBtn");
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

  function feedback(msg, isError) {
    if (feedbackEl) {
      feedbackEl.textContent = msg || "";
      feedbackEl.classList.toggle("draw-tools__feedback--error", !!isError);
    }
    if (msg) setStatus?.(statusEl, msg, isError);
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

  function styleForFeature(feature) {
    const color = feature.get("_color") || "#3f8f3f";
    const geomType = feature.getGeometry()?.getType();
    if (geomType === "Point" || geomType === "MultiPoint") {
      return new ol.style.Style({
        image: new ol.style.Circle({
          radius: 6,
          fill: new ol.style.Fill({ color }),
          stroke: new ol.style.Stroke({ color: "#fff", width: 1.5 })
        })
      });
    }
    if (geomType === "LineString" || geomType === "MultiLineString") {
      return new ol.style.Style({
        stroke: new ol.style.Stroke({ color, width: 3 })
      });
    }
    return new ol.style.Style({
      stroke: new ol.style.Stroke({ color, width: 2 }),
      fill: new ol.style.Fill({ color: hexToRgba(color, 0.18) })
    });
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
        featuresSource.addFeature(olFeature);
      }
    } catch (e) {
      console.error("[Victoria Survey] Error loading features layer:", e);
    }
  }

  window.addEventListener("vsl-features-changed", refreshFeaturesLayer);

  function currentFeatureType() {
    const id = featureSelect.value;
    if (!id) return null;
    return featureTypes.find((f) => String(f.id) === String(id)) || null;
  }

  function isPlotBlockSelected() {
    const ft = currentFeatureType();
    return !!ft?.is_system && (ft.code === "plot" || ft.code === "block");
  }

  function populateFeatureSelect() {
    const kind = entitySelect.value;
    const keep = featureSelect.value;
    const rows = featureTypes.filter((f) => f.geometry_kind === kind);
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
    if (show) {
      refreshDrawEstateOptions();
      const ft = currentFeatureType();
      if (blockFilterRow) blockFilterRow.hidden = ft?.code !== "plot";
    }
  }

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
    }
    sketchSource.clear(true);
    startBtnLabel.textContent = "Start Drawing";
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
      feedback("Choose a feature before drawing.", true);
      return;
    }
    if (isPlotBlockSelected()) {
      if (!estateSelect.value) {
        feedback("Select an Estate before drawing.", true);
        return;
      }
      if (ft.code === "plot" && !blockSelect.value) {
        feedback("Select a Block before drawing a plot.", true);
        return;
      }
    }

    const olType = OL_TYPE_BY_ENTITY[ft.geometry_kind];
    sketchSource.clear(true);
    drawInteraction = new ol.interaction.Draw({ source: sketchSource, type: olType });
    map.addInteraction(drawInteraction);
    drawInteraction.on("drawend", async (evt) => {
      map.removeInteraction(drawInteraction);
      drawInteraction = null;
      startBtnLabel.textContent = "Start Drawing";
      await saveDrawnFeature(ft, evt.feature);
      sketchSource.clear(true);
    });
    startBtnLabel.textContent = "Stop Drawing";
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
        const blockId = blockSelect.value;
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
