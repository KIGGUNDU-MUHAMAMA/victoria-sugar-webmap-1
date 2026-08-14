/**
 * Survey "Draw" tab.
 *
 * Entity type (point/line/polygon) -> Feature (from vsl_feature_type) ->
 * click Start Drawing -> click the map to place shapes, one after another,
 * until Finish Drawing. Nothing saves automatically: every finished shape
 * goes into a *pending* queue (shown on the map in a dashed "not yet saved"
 * style, name prompted via the shared popup) and only actually reaches the
 * database when the footer's Save button is clicked — Cancel discards the
 * whole queue instead, same two-button shape as the Edit tab's Save/Cancel.
 * The entity-type/feature dropdowns can be changed mid-session (re-arms the
 * live Draw interaction for the new type) without losing anything already
 * queued.
 *
 * Plot and Block are "system" feature types (vsl_feature_type.is_system):
 * drawing one of these still creates a row in vsl_parcels/vsl_blocks (via
 * vsl_draw_create_parcel/vsl_draw_create_block), scoped by the Estate/Block
 * filter dropdowns shown only for those two types. Every other feature type
 * (trees, boreholes, roads, walls, …) saves straight into the generic
 * vsl_feature table against its vsl_feature_type row.
 */

import { promptText, confirmDanger } from "../popups/popup.js";

const OL_TYPE_BY_ENTITY = { point: "Point", line: "LineString", polygon: "Polygon", block: "Polygon", plot: "Polygon" };
// "block"/"plot" are direct drawEntityTypeSelect values that map straight to
// their vsl_feature_type system row — see isSystemEntity()/currentFeatureType().
const SYSTEM_ENTITY_VALUES = ["block", "plot"];

export function initSurveyDraw({ map, cfg, supabase, setStatus, statusEl, loadLayersFromDb, refreshEstateBoundaries, attachSnap, detachSnap }) {
  const entitySelect = document.getElementById("drawEntityTypeSelect");
  const entityIconPreview = document.getElementById("drawEntityIconPreview");
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
  const hintList = document.getElementById("drawHintList");
  const saveBtn = document.getElementById("drawSaveBtn");
  const cancelBtn = document.getElementById("drawCancelBtn");

  if (!entitySelect || !featureSelect) return null;

  function restHeaders() {
    return {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
      Accept: "application/json"
    };
  }

  // Errors/status now go through the global status bar only — same split
  // as the Edit tab (see survey-edit.js's own feedback()): #drawHintList
  // below is a purely static "how to" list, shown only while a drawing
  // session is active.
  function feedback(msg, isError) {
    if (msg) setStatus?.(statusEl, msg, isError);
  }

  // Same 3-line "how to" shape as the Edit tab's #editHintList, but
  // templated per geometry kind — a point has no "close the shape" step,
  // a line can only be finished by double-click (no click-first-vertex-to-
  // close, that's a polygon-only OL behaviour), a polygon/plot/block gets
  // all three lines.
  function hintItemsFor(olType, name) {
    if (olType === "Point") return [`Click on the map to add ${name}`];
    if (olType === "LineString") return [`Click on the map to add ${name}`, "Double click to finish"];
    return [
      `Click on the map to add ${name}`,
      "Double click to close and finish",
      "Click the starting node to finish"
    ];
  }
  function showHint(olType, name) {
    if (!hintList) return;
    hintList.innerHTML = hintItemsFor(olType, name).map((t) => `<li>${t}</li>`).join("");
    hintList.hidden = false;
  }
  function hideHint() {
    if (hintList) hintList.hidden = true;
  }

  // Start/Finish toggle — same look/behaviour as the Edit tab's
  // editSelectFeatureBtn (js/survey-edit.js setToggleButtonState): a play
  // icon + primary color at rest, a stop-circle icon + danger color while a
  // drawing session is active. "Finish Drawing" only stops *placing new
  // shapes* — anything already queued stays put for Save/Cancel below.
  function setDrawToggleState(active) {
    startBtn.classList.toggle("uam-btn--danger", active);
    startBtn.classList.toggle("uam-btn--primary", !active);
    if (startBtnIcon) startBtnIcon.className = active ? "fas fa-stop-circle" : "fas fa-play";
    if (startBtnLabel) startBtnLabel.textContent = active ? "Finish Drawing" : "Start Drawing";
  }

  // Live sketch preview color — also used to mark the very first vertex
  // placed for a polygon (a bigger, lighter-blue ring) so it's obvious
  // where to click back to close it, matching the "Click the starting node
  // to finish" hint line below. Lines skip this marker entirely — a line
  // can only be finished by double-click, there's no "click the start to
  // close" behaviour for it. Passed as the Draw interaction's own `style`
  // option (NOT sketchLayer's — the actively-moving sketch is rendered by
  // the interaction itself; sketchLayer only ever shows what's already
  // committed to sketchSource, which is cleared immediately at drawend).
  const SKETCH_COLOR = "#0d47a1";
  const START_VERTEX_COLOR = "#42a5f5";
  function sketchDrawStyle(feature) {
    const geom = feature.getGeometry();
    const type = geom?.getType();
    if (!type || type === "Point") {
      // The moving cursor marker while placing vertices — also what an
      // actual Point-type draw looks like throughout, since a point has no
      // separate outline/start-vertex concept.
      return new ol.style.Style({
        image: new ol.style.Circle({
          radius: 5,
          fill: new ol.style.Fill({ color: SKETCH_COLOR }),
          stroke: new ol.style.Stroke({ color: "#fff", width: 1.5 })
        })
      });
    }
    const styles = [
      new ol.style.Style({
        stroke: new ol.style.Stroke({ color: SKETCH_COLOR, width: 2 }),
        fill: new ol.style.Fill({ color: "rgba(13, 71, 161, 0.15)" })
      })
    ];
    if (type === "Polygon") {
      const firstCoord = geom.getCoordinates()[0]?.[0];
      if (firstCoord) {
        styles.push(
          new ol.style.Style({
            geometry: new ol.geom.Point(firstCoord),
            image: new ol.style.Circle({
              radius: 7,
              fill: new ol.style.Fill({ color: START_VERTEX_COLOR }),
              stroke: new ol.style.Stroke({ color: "#fff", width: 2 })
            })
          })
        );
      }
    }
    return styles;
  }

  // Live preview of whatever's currently mid-sketch — cleared the instant
  // each shape finishes (it moves into pendingSource below, not this one).
  const sketchSource = new ol.source.Vector();
  const sketchLayer = new ol.layer.Vector({
    source: sketchSource,
    style: sketchDrawStyle,
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

  // Finished-but-not-yet-saved shapes this session (see pendingDrawn Map
  // below) — dashed outline + always-on name label so it's visually clear
  // these haven't hit the database yet. Cleared on Save (they're safely
  // persisted by then) or Cancel (discarded).
  const pendingSource = new ol.source.Vector();
  const pendingLayer = new ol.layer.Vector({
    source: pendingSource,
    style: (feature) => stylePendingFeature(feature),
    zIndex: 945
  });
  pendingLayer.set("displayInLayerSwitcher", false);
  map.addLayer(pendingLayer);

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
    pendingLayer.changed();
    sketchLayer.changed();
  });

  // Live area for a polygon feature, in hectares — used only for the
  // optional "Area" on-map label (display_params), computed client-side
  // from the already-loaded geometry rather than round-tripping to the DB.
  // Nothing here is cached on the feature, so this — and every label built
  // from it below — recomputes fresh on every single render call, which is
  // exactly what keeps the label live/correct while the Edit tab drags this
  // same feature's nodes around (no stale-cache bug to worry about, unlike
  // blocksLayer/parcelsLayer's own area label in map-app.js).
  function areaHectares(geometry) {
    // Matches the { projection: "EPSG:3857" } convention map-app.js's own
    // ol.sphere.getArea() calls use everywhere else in this app.
    const m2 = ol.sphere.getArea(geometry, { projection: "EPSG:3857" });
    return (m2 / 10000).toFixed(2);
  }

  // Live ground length for a line feature, in meters/km — the "Length"
  // counterpart to areaHectares above, used for the optional Length label
  // on line-kind feature types (see manage-features.js's mfDisplayLengthCb).
  // Same km-once-it's-1000m+ formatting convention as map-app.js's own
  // Measure tool (formatGroundLengthM), kept local here since map-app.js
  // doesn't export its helpers to other modules.
  function lengthText(geometry) {
    const m = ol.sphere.getLength(geometry, { projection: "EPSG:3857" });
    if (!Number.isFinite(m)) return "";
    if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
    return `${m.toFixed(1)} m`;
  }

  // "Show on map" text label(s), built from whichever of name/area/length
  // this feature type has checked (vsl_feature_type.display_params, max 1
  // for point/line — Name and Length are mutually exclusive for line, see
  // manage-features.js — max 2 for polygon — see manage-features.js's form
  // and the vsl_feature_type_display_params_max DB constraint). Offset
  // below the marker/shape so it doesn't sit on top of the icon/stroke.
  function displayLabelStyle(feature, offsetY) {
    const params = feature.get("_display");
    if (!Array.isArray(params) || !params.length) return null;
    const lines = [];
    if (params.includes("name") && feature.get("_name")) lines.push(feature.get("_name"));
    if (params.includes("area")) lines.push(`${areaHectares(feature.getGeometry())} ha`);
    if (params.includes("length")) lines.push(lengthText(feature.getGeometry()));
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

  // Same shapes/colors as styleForFeature above, but dashed (still-pending,
  // not yet in the database) and always showing a name label — the entered
  // name if any, else the feature type's own name as a placeholder — so
  // it's obvious *what's* queued regardless of that type's normal
  // display_params setting.
  function nameLabelStyle(text, offsetY) {
    if (!text) return null;
    return new ol.style.Style({
      text: new ol.style.Text({
        text,
        font: "600 11px sans-serif",
        fill: new ol.style.Fill({ color: "#1d2a1d" }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 3 }),
        offsetY,
        textAlign: "center"
      })
    });
  }
  function stylePendingFeature(feature) {
    const color = feature.get("_color") || "#3f8f3f";
    const label = feature.get("_pendingLabel") || "";
    const geomType = feature.getGeometry()?.getType();
    if (geomType === "Point") {
      const glyph = faGlyph(feature.get("_icon"));
      const radius = Math.max(3, Number(feature.get("_iconSize")) || 10);
      const styles = [
        new ol.style.Style({
          image: new ol.style.Circle({
            radius,
            fill: new ol.style.Fill({ color: hexToRgba(color, 0.55) }),
            stroke: new ol.style.Stroke({ color: "#fff", width: 1.5, lineDash: [2, 2] })
          })
        })
      ];
      if (glyph) {
        styles.push(
          new ol.style.Style({
            text: new ol.style.Text({
              text: glyph,
              font: `900 ${Math.round(radius * 1.1)}px "Font Awesome 6 Free"`,
              fill: new ol.style.Fill({ color: "#fff" }),
              textAlign: "center",
              textBaseline: "middle"
            })
          })
        );
      }
      const nl = nameLabelStyle(label, -(radius + 10));
      if (nl) styles.push(nl);
      return styles;
    }
    const weight = Math.max(1, Number(feature.get("_weight")) || (geomType?.includes("Line") ? 3 : 2));
    if (geomType === "LineString") {
      const styles = [
        new ol.style.Style({ stroke: new ol.style.Stroke({ color, width: weight, lineDash: [8, 5] }) })
      ];
      const nl = nameLabelStyle(label, -10);
      if (nl) styles.push(nl);
      return styles;
    }
    const styles = [
      new ol.style.Style({
        stroke: new ol.style.Stroke({ color, width: weight, lineDash: [8, 5] }),
        fill: new ol.style.Fill({ color: hexToRgba(color, 0.12) })
      })
    ];
    const nl = nameLabelStyle(label, 0);
    if (nl) styles.push(nl);
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
  // Snaps new vertices onto other already-drawn custom features (trees,
  // roads, walls, …) — separate from attachSnap/detachSnap (map-app.js),
  // which cover snapping onto existing blocks/parcels. Two interactions,
  // not one, since ol.interaction.Snap only ever takes a single source:
  // featuresSnapInteraction covers already-saved features, pendingSnap-
  // Interaction covers shapes drawn earlier *this session* that haven't
  // been saved yet (still visible/snappable even though they're only in
  // pendingSource so far).
  let featuresSnapInteraction = null;
  let pendingSnapInteraction = null;
  let sessionActive = false;
  let tmpIdCounter = 0;
  // One entry per shape finished this session, keyed by a throwaway tmp id
  // — none of this exists in the database yet. Cleared on Save (once every
  // entry has actually been persisted) or Cancel (discarded outright).
  const pendingDrawn = new Map();

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

  // Shape preview next to drawEntityTypeSelect — Block/Plot are geometry-
  // kind "polygon" underneath (see OL_TYPE_BY_ENTITY), so they get the
  // same polygon glyph as the generic Polygon option.
  function updateEntityIconPreview() {
    if (!entityIconPreview) return;
    const olType = OL_TYPE_BY_ENTITY[entitySelect.value];
    if (olType === "Point") {
      entityIconPreview.innerHTML = '<span class="uam-icon-preview__dot"></span>';
    } else if (olType === "LineString") {
      entityIconPreview.innerHTML = '<i class="fas fa-slash" aria-hidden="true"></i>';
    } else {
      entityIconPreview.innerHTML = '<i class="fas fa-draw-polygon" aria-hidden="true"></i>';
    }
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
    // Not force-unchecked when hidden for Block — applyDrawAutoState()/
    // validateEntityRequirements() both already gate on ft.code === "plot"
    // before ever reading it, and leaving it alone means it stays checked
    // (its default) the next time Plot is picked, instead of the person
    // having to re-check it every time.
    if (automaticRow) automaticRow.hidden = !isPlot;
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
  automaticCb?.addEventListener("change", () => {
    applyDrawAutoState();
    rearmIfActive();
  });

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

  // Re-arms the live Draw interaction for whatever's now selected, but only
  // while a session is actually active — safe/no-op to call from any
  // dropdown's change handler regardless of session state.
  function rearmIfActive() {
    if (sessionActive) armInteraction();
  }

  entitySelect.addEventListener("change", () => {
    populateFeatureSelect();
    updateEntityIconPreview();
    rearmIfActive();
  });
  featureSelect.addEventListener("change", () => {
    updatePlotBlockVisibility();
    rearmIfActive();
  });
  estateSelect?.addEventListener("change", () => {
    refreshDrawBlockOptions(estateSelect.value);
    rearmIfActive();
  });
  blockSelect?.addEventListener("change", rearmIfActive);

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

  // What's required before the *next* shape can be placed, given the
  // current dropdown selections — same checks whether this is the very
  // first shape (Start Drawing) or a mid-session type switch. Returns an
  // error string, or null when everything needed is in place.
  function validateEntityRequirements(ft) {
    if (!ft) {
      return isSystemEntity() ? "That system feature type wasn't found — check Manage Features." : "Choose a feature before drawing.";
    }
    if (ft.is_system && (ft.code === "plot" || ft.code === "block")) {
      const isPlot = ft.code === "plot";
      const auto = isPlot && !!automaticCb?.checked;
      // Blocks always need their Estate picked manually; Plots only need
      // it when "Automatically Choose Block" is off (on = resolved after
      // drawing, from the shape itself — see handleShapeFinished below).
      if (!auto) {
        if (!estateSelect.value) return "Select an Estate before drawing.";
        if (isPlot && !blockSelect.value) return "Select a Block before drawing a plot.";
      }
    }
    return null;
  }

  // Tears down whatever Draw/snap interaction is currently armed, without
  // touching the pending queue or sessionActive itself — used both by a
  // genuine stop and by armInteraction() when re-arming for a new type.
  function disarmInteraction() {
    if (drawInteraction) {
      map.removeInteraction(drawInteraction);
      drawInteraction = null;
    }
    if (featuresSnapInteraction) {
      map.removeInteraction(featuresSnapInteraction);
      featuresSnapInteraction = null;
    }
    if (pendingSnapInteraction) {
      map.removeInteraction(pendingSnapInteraction);
      pendingSnapInteraction = null;
    }
    detachSnap?.();
  }

  // (Re)arms a fresh Draw interaction for whatever's currently selected —
  // called on Start, and again whenever the entity/feature dropdowns
  // change while a session is already active (switching what's being
  // drawn without stopping the session). Any in-progress, not-yet-finished
  // sketch is discarded when switching — changing what you're drawing
  // mid-shape isn't a supported combination.
  function armInteraction() {
    disarmInteraction();
    sketchSource.clear(true);
    if (!sessionActive) return;

    const ft = currentFeatureType();
    const problem = validateEntityRequirements(ft);
    if (problem) {
      hideHint();
      feedback(problem, true);
      return;
    }

    const olType = OL_TYPE_BY_ENTITY[ft.geometry_kind];
    drawInteraction = new ol.interaction.Draw({ source: sketchSource, type: olType, style: sketchDrawStyle });
    map.addInteraction(drawInteraction);
    // Snap-to-existing-features: blocks/parcels via the shared mechanism
    // (map-app.js), this tab's own already-saved custom features, AND
    // whatever's already been drawn earlier *this session* but isn't saved
    // yet (pendingSource) — all three must be added *after* the Draw
    // interaction above for OL to actually apply the snap while placing a
    // vertex.
    attachSnap?.();
    featuresSnapInteraction = new ol.interaction.Snap({ source: featuresSource, pixelTolerance: 12 });
    map.addInteraction(featuresSnapInteraction);
    pendingSnapInteraction = new ol.interaction.Snap({ source: pendingSource, pixelTolerance: 12 });
    map.addInteraction(pendingSnapInteraction);
    // No removal/re-creation here on drawend — a source-backed Draw
    // interaction is immediately ready for the *next* shape of the same
    // type on its own, which is exactly the "keep drawing until Finish"
    // behaviour asked for. Only switching type (via this same
    // armInteraction(), above) tears it down and rebuilds it.
    drawInteraction.on("drawend", (evt) => {
      sketchSource.clear(true);
      handleShapeFinished(ft, evt.feature);
    });
    showHint(olType, ft.name.toLowerCase());
  }

  // Runs once per finished shape: shows it immediately in the pending
  // style (so it doesn't vanish from the map while the name prompt below
  // is open), resolves/snapshots Estate+Block for a Plot/Block, prompts
  // for a name, then — if not cancelled/failed — files it into
  // pendingDrawn for the footer's Save button to actually persist.
  async function handleShapeFinished(ft, olFeature) {
    olFeature.set("_color", ft.color || "#3f8f3f");
    olFeature.set("_icon", ft.icon || "");
    olFeature.set("_iconSize", ft.icon_size);
    olFeature.set("_weight", ft.line_weight);
    olFeature.set("_pendingLabel", ft.name);
    pendingSource.addFeature(olFeature);

    let estateId = null;
    let blockId = null;
    if (ft.is_system && (ft.code === "plot" || ft.code === "block")) {
      if (ft.code === "block") {
        estateId = estateSelect.value;
      } else if (automaticCb?.checked) {
        feedback("Matching plot to a block…", false);
        const gj = new ol.format.GeoJSON();
        const geoJsonGeom = gj.writeGeometryObject(olFeature.getGeometry(), {
          featureProjection: "EPSG:3857",
          dataProjection: "EPSG:4326"
        });
        blockId = await resolveBlockForGeometry(geoJsonGeom);
        if (!blockId) {
          pendingSource.removeFeature(olFeature);
          feedback(
            "This plot doesn't fall inside any existing block — it wasn't added. Turn off \"Automatically Choose Block\" and pick one manually, then draw it again.",
            true
          );
          return;
        }
      } else {
        blockId = blockSelect.value;
      }
    }

    const name = await promptText({
      title: "Name",
      message: `Enter a name for this ${ft.name.toLowerCase()} (Required)`,
      placeholder: `${ft.name} name`,
      required: true,
      confirmLabel: "Add"
    });
    if (name === null) {
      pendingSource.removeFeature(olFeature);
      feedback("Shape discarded.", false);
      return;
    }

    const trimmedName = name.trim();
    olFeature.set("_pendingLabel", trimmedName || ft.name);
    pendingSource.changed();

    const tmpId = `tmp-${++tmpIdCounter}`;
    pendingDrawn.set(tmpId, { tmpId, ft, olFeature, name: trimmedName, estateId, blockId });
    updateFooterState();
    feedback(`${pendingDrawn.size} shape${pendingDrawn.size === 1 ? "" : "s"} queued. Keep drawing or click Save.`, false);
  }

  function updateFooterState() {
    if (saveBtn) saveBtn.disabled = pendingDrawn.size === 0;
  }

  function confirmDiscardChanges() {
    return confirmDanger({
      title: "Discard Drawn Shapes?",
      message: `You have ${pendingDrawn.size} unsaved shape${pendingDrawn.size === 1 ? "" : "s"}. Leaving now will discard ${pendingDrawn.size === 1 ? "it" : "them"}.`,
      confirmLabel: "Discard"
    });
  }

  // Full teardown — armed interaction AND the whole pending queue. Used by
  // Cancel, the close-confirmation hook, and the tab-hide safety net. NOT
  // used by a successful Save (see the Save handler below), which needs to
  // reset the toggle/interaction the same way but without wiping a queue
  // that's already been safely written to the database.
  function endSession() {
    disarmInteraction();
    sketchSource.clear(true);
    pendingSource.clear(true);
    pendingDrawn.clear();
    sessionActive = false;
    setDrawToggleState(false);
    hideHint();
    updateFooterState();
    window.vslSetParcelClickEnabled?.(true);
    feedback("", false);
  }

  // Start/Finish toggle.
  startBtn?.addEventListener("click", () => {
    if (sessionActive) {
      // "Finish Drawing" — stop placing new shapes, but keep whatever's
      // already queued; Save/Cancel below decide what happens to it next.
      disarmInteraction();
      sketchSource.clear(true);
      sessionActive = false;
      setDrawToggleState(false);
      hideHint();
      window.vslSetParcelClickEnabled?.(true);
      feedback(pendingDrawn.size ? `${pendingDrawn.size} shape(s) ready — Save or Cancel below.` : "", false);
      return;
    }
    const ft = currentFeatureType();
    const problem = validateEntityRequirements(ft);
    if (problem) {
      feedback(problem, true);
      return;
    }
    sessionActive = true;
    setDrawToggleState(true);
    // Suppress the plain-click parcel/block selection toolbar for the
    // whole session — otherwise clicking to place a vertex on top of an
    // existing plot/block would also pop that up.
    window.vslSetParcelClickEnabled?.(false);
    armInteraction();
  });

  saveBtn?.addEventListener("click", async () => {
    if (!pendingDrawn.size) return;
    if (!supabase) {
      feedback("Can't save — Supabase client not available.", true);
      return;
    }

    const entries = [...pendingDrawn.values()];
    const errors = [];
    let savedCount = 0;
    let savedAnyBlock = false;

    window.vslSurveyBusy?.(true, "Saving…");
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id ?? null;
      const gj = new ol.format.GeoJSON();

      for (const entry of entries) {
        const { ft, olFeature, name, estateId, blockId } = entry;
        const geoJsonGeom = gj.writeGeometryObject(olFeature.getGeometry(), {
          featureProjection: "EPSG:3857",
          dataProjection: "EPSG:4326"
        });
        try {
          if (ft.code === "block") {
            const { data: newId, error } = await supabase.rpc("vsl_draw_create_block", {
              p_estate_id: Number(estateId),
              p_geojson: geoJsonGeom,
              p_user_id: userId
            });
            if (error) throw error;
            // block_name defaults to the auto-generated block_code server-
            // side — only overwrite it when the user actually typed one
            // (same plain PostgREST-update pattern the "Edit Details"
            // rename flow already uses for this exact column).
            if (name && newId) {
              await supabase.from("vsl_blocks").update({ block_name: name }).eq("id", newId);
            }
            savedAnyBlock = true;
          } else if (ft.code === "plot") {
            const { data: newId, error } = await supabase.rpc("vsl_draw_create_parcel", {
              p_block_id: blockId,
              p_geojson: geoJsonGeom,
              p_user_id: userId
            });
            if (error) throw error;
            if (name && newId) {
              await supabase.from("vsl_parcels").update({ parcel_name: name }).eq("id", newId);
            }
          } else {
            // vsl_create_feature already takes the name directly.
            const { error } = await supabase.rpc("vsl_create_feature", {
              p_feature_type_id: ft.id,
              p_geojson: geoJsonGeom,
              p_name: name || null,
              p_user_id: userId
            });
            if (error) throw error;
          }
          savedCount += 1;
        } catch (err) {
          console.error("[Victoria Survey] Draw save failed for one shape:", err);
          errors.push(`${name || ft.name}: ${err.message}`);
        }
      }

      await loadLayersFromDb?.();
      await refreshFeaturesLayer();
      window.dispatchEvent(new CustomEvent("vsl-features-changed"));
      // Same DB trigger as CSV import — recomputes the parent estate's
      // boundary from its blocks. Pull the fresh geometry into the map.
      if (savedAnyBlock) await refreshEstateBoundaries?.();

      if (errors.length) {
        feedback(`Saved ${savedCount}/${entries.length}. Errors: ${errors.join("; ")}`, true);
      } else {
        feedback(`Saved ${savedCount} shape(s).`, false);
      }
    } catch (e) {
      console.error("[Victoria Survey] Draw save failed:", e);
      feedback(`Save failed: ${e.message}`, true);
      return; // keep the queue + session — nothing confirmed lost
    } finally {
      window.vslSurveyBusy?.(false);
    }

    // Whatever just got saved is safely in the database — clear the queue
    // and end the session (mirrors Edit tab's Save, which also ends its
    // session rather than silently staying in edit mode).
    disarmInteraction();
    sketchSource.clear(true);
    pendingSource.clear(true);
    pendingDrawn.clear();
    sessionActive = false;
    setDrawToggleState(false);
    hideHint();
    updateFooterState();
    window.vslSetParcelClickEnabled?.(true);
  });

  // Explicit Cancel (footer button) — this click *is* the "discard"
  // confirmation when there's anything queued, no extra popup on top.
  cancelBtn?.addEventListener("click", async () => {
    if (pendingDrawn.size > 0) {
      const discard = await confirmDiscardChanges();
      if (!discard) return;
    }
    endSession();
  });

  // Same composable "expose a global hook" pattern survey-edit.js uses for
  // its own close-confirmation — this module initializes first (see
  // map-app.js's initSurveyDraw/initSurveyEdit call order), so it sets the
  // hook directly; survey-edit.js *wraps* whatever's already here instead
  // of overwriting it, so both tabs' unsaved work gets guarded regardless
  // of which is active when the user tries to navigate away.
  window.vslConfirmSurveyClose = async () => {
    if (!sessionActive && !pendingDrawn.size) return true;
    if (pendingDrawn.size > 0) {
      const discard = await confirmDiscardChanges();
      if (!discard) return false;
    }
    endSession();
    return true;
  };

  // Safety net only — window.vslConfirmSurveyClose above is what actually
  // gates leaving the tab now, so by the time this fires (tab already
  // hidden) there should be nothing left pending. Covers any path that
  // hides the tab without going through it.
  const tabPanel = document.getElementById("uamTabDraw");
  if (tabPanel) {
    const drawTabObserver = new MutationObserver(() => {
      if (tabPanel.hidden && (sessionActive || pendingDrawn.size)) endSession();
    });
    drawTabObserver.observe(tabPanel, { attributes: true, attributeFilter: ["hidden"] });
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

  updateFooterState();
  updateEntityIconPreview();

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
