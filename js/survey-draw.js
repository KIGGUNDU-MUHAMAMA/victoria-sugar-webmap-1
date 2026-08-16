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
 * Plot and Block are "system" entity types: drawing one of these creates a
 * row in vsl_parcels/vsl_blocks (via vsl_draw_create_parcel/
 * vsl_draw_create_block), scoped by the Estate/Block filter dropdowns shown
 * only for those two. They deliberately have NO vsl_feature_type row — that
 * table is now purely the catalog of things that end up in vsl_feature, with
 * banded numeric codes (1-99 point, 100-199 line, 200-299 polygon). Plot and
 * Block are defined in code instead, see SYSTEM_FEATURE_TYPES below. Every
 * other feature type (trees, boreholes, roads, walls, …) saves straight into
 * the generic vsl_feature table against its vsl_feature_type row.
 */

import { promptText, confirmDanger } from "../popups/popup.js";
import { featureTypeSwatchHtml } from "./feature-type-editor.js";

const OL_TYPE_BY_ENTITY = { point: "Point", line: "LineString", polygon: "Polygon", block: "Polygon", plot: "Polygon" };
// "block"/"plot" are direct drawEntityTypeSelect values — see
// isSystemEntity()/currentFeatureType().
const SYSTEM_ENTITY_VALUES = ["block", "plot"];

// Stand-ins for what used to be the two is_system rows in vsl_feature_type.
// Same shape as a real row where the rest of this module reads from it
// (name/geometry_kind/color/icon/… for the sketch + pending styles), minus
// `id` — nothing ever writes these to vsl_feature, the save path branches on
// `code` and calls the parcel/block RPCs instead.
const SYSTEM_FEATURE_TYPES = {
  block: {
    id: null,
    code: "block",
    name: "Block",
    geometry_kind: "polygon",
    color: "#c45c1a",
    icon: "fa-vector-square",
    icon_size: 10,
    icon_rotation: 0,
    line_weight: 2,
    linetype: null,
    display_params: [],
    is_system: true
  },
  plot: {
    id: null,
    code: "plot",
    name: "Plot",
    geometry_kind: "polygon",
    color: "#28a745",
    icon: "fa-draw-polygon",
    icon_size: 10,
    icon_rotation: 0,
    line_weight: 2,
    linetype: null,
    display_params: [],
    is_system: true
  }
};

export function initSurveyDraw({ map, cfg, supabase, setStatus, statusEl, loadLayersFromDb, refreshEstateBoundaries, attachSnap, detachSnap }) {
  const entitySelect = document.getElementById("drawEntityTypeSelect");
  const entityIconPreview = document.getElementById("drawEntityIconPreview");
  const featureRow = document.getElementById("drawFeatureRow");
  const featureSelect = document.getElementById("drawFeatureSelect");
  const featurePreview = document.getElementById("drawFeaturePreview");
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
    // Every caller sets sessionActive before calling this, so the enabled
    // state can be recomputed straight from it here.
    updateStartButtonState();
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
    style: (feature, resolution) => styleForFeature(feature, resolution),
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

  // Point icons come from the SVG files in /icons — the same files the
  // Feature Type editor's picker lists (icons/icons.json) and the print tool
  // rasterises. Rendering them from the files rather than from the Font
  // Awesome webfont means any icon added to that folder works on the map
  // too; a font-glyph render would only ever cover icons that happen to
  // exist in Font Awesome.
  //
  // OL needs a synchronous style, so each icon is fetched once, recoloured
  // white (FA's SVGs carry no fill, so they'd paint black on the colored
  // chip — same fill injection print-tool.js's loadIconPng does) and cached
  // as a data URI. A miss returns null and schedules a repaint for when the
  // fetch lands, so the first frame just shows the bare chip.
  const ICON_DIR = "./icons";
  const ICON_PX = 64; // data-URI render box; scale is derived from this
  const svgIconCache = new Map(); // "fa-tree" -> data URI | null
  const svgIconPending = new Set();

  function svgIconUrl(iconName) {
    if (!iconName) return null;
    if (svgIconCache.has(iconName)) return svgIconCache.get(iconName);
    if (svgIconPending.has(iconName)) return null;

    svgIconPending.add(iconName);
    (async () => {
      let url = null;
      try {
        const res = await fetch(`${ICON_DIR}/${encodeURIComponent(iconName)}.svg`);
        if (res.ok) {
          const svgText = await res.text();
          // Fixed width/height (viewBox is left alone, so the glyph stays
          // centred and un-stretched) makes the rendered size predictable,
          // which is what lets the scale below be a plain division.
          const colored = svgText.replace(
            /<svg\b/,
            `<svg fill="#ffffff" width="${ICON_PX}" height="${ICON_PX}"`
          );
          url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(colored);
        }
      } catch (e) {
        console.error(`[Victoria Survey] Couldn't load icon ${iconName}:`, e);
      }
      svgIconCache.set(iconName, url);
      svgIconPending.delete(iconName);
      featuresLayer.changed();
      pendingLayer.changed();
    })();
    return null;
  }

  /** The white glyph sitting on a point's colored chip, or null while its
   *  file is still loading (or missing entirely). */
  function iconImageStyle(iconName, radius, rotationDeg) {
    const url = svgIconUrl(iconName);
    if (!url) return null;
    return new ol.style.Style({
      image: new ol.style.Icon({
        src: url,
        scale: (radius * 1.25) / ICON_PX,
        rotation: (rotationDeg * Math.PI) / 180
      })
    });
  }

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
  // on line-kind feature types (the Length checkbox in the Feature Type
  // editor, js/feature-type-editor.js).
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
  // A point's label sits to the RIGHT of its marker, vertically centred on
  // it, rather than centred underneath — a marker is a single spot, so the
  // text reads as an annotation pointing at it (and two nearby points don't
  // stack their labels on top of each other). Lines and polygons keep their
  // centred labels, where the text belongs to the whole shape.
  function displayLabelStyle(feature, offsetY, offsetX) {
    const params = feature.get("_display");
    if (!Array.isArray(params) || !params.length) return null;
    const lines = [];
    if (params.includes("name") && feature.get("_name")) lines.push(feature.get("_name"));
    if (params.includes("area")) lines.push(`${areaHectares(feature.getGeometry())} ha`);
    if (params.includes("length")) lines.push(lengthText(feature.getGeometry()));
    if (!lines.length) return null;

    // "Along the line" (vsl_feature_type.label_direction) hands placement to
    // OL, which repeats the text along the geometry and rotates it to follow
    // each segment. It only works on line geometries, and it can't render a
    // multi-line string, so the parts are joined with a separator instead of
    // a newline in that mode.
    const along =
      feature.get("_labelDir") === "along" &&
      /LineString/.test(feature.getGeometry()?.getType() || "");

    const textOpts = {
      text: along ? lines.join("  ·  ") : lines.join("\n"),
      font: "600 11px sans-serif",
      fill: new ol.style.Fill({ color: "#1d2a1d" }),
      stroke: new ol.style.Stroke({ color: "#fff", width: 3 }),
      textAlign: offsetX ? "left" : "center"
    };
    if (offsetX) {
      textOpts.offsetX = offsetX;
      textOpts.textBaseline = "middle";
    }
    if (along) {
      textOpts.placement = "line";
      textOpts.overflow = true;
      // Lift it just clear of the stroke it's sitting on.
      textOpts.offsetY = -2;
    } else {
      textOpts.offsetY = offsetY;
    }
    return new ol.style.Style({ text: new ol.style.Text(textOpts) });
  }

  // Feature ids the Search window's Feature tab is currently pointing at —
  // drawn with an extra halo underneath so a searched-for feature is
  // obvious once the map finishes zooming to it. Cleared by the search
  // panel's Clear button (see setHighlightedFeatures below).
  const highlightedIds = new Set();
  const HIGHLIGHT_COLOR = "#ffb300";
  function highlightStyle(feature) {
    const geomType = feature.getGeometry()?.getType();
    if (geomType === "Point" || geomType === "MultiPoint") {
      const radius = Math.max(3, Number(feature.get("_iconSize")) || 10);
      return new ol.style.Style({
        image: new ol.style.Circle({
          radius: radius + 7,
          fill: new ol.style.Fill({ color: hexToRgba(HIGHLIGHT_COLOR, 0.35) }),
          stroke: new ol.style.Stroke({ color: HIGHLIGHT_COLOR, width: 3 })
        }),
        zIndex: -1
      });
    }
    const weight = Math.max(1, Number(feature.get("_weight")) || 2);
    return new ol.style.Style({
      stroke: new ol.style.Stroke({ color: hexToRgba(HIGHLIGHT_COLOR, 0.85), width: weight + 8 }),
      zIndex: -1
    });
  }

  // vsl_feature_type.linetype -> an OL lineDash array (undefined = solid).
  // Scaled by the stroke width so a thick dashed line doesn't look like a
  // solid one with nicks in it.
  function lineDashFor(linetype, weight) {
    const w = Math.max(1, Number(weight) || 2);
    if (linetype === "dashed") return [w * 3, w * 2];
    if (linetype === "dotted") return [w, w * 2];
    return undefined;
  }

  // Ground metres -> screen pixels at the current view resolution.
  //
  // `resolution` is map units (EPSG:3857) per pixel, and a Web-Mercator unit
  // is only a true metre at the equator — it stretches by 1/cos(latitude)
  // going north or south. Dividing by that factor turns a real-world
  // measurement (line_spacing_m: the gap between a road's two edges) into
  // the right number of pixels, so a double line keeps its true width on the
  // ground as the map zooms instead of being a fixed pixel gap.
  function metersToPixels(meters, resolution, feature) {
    const m = Number(meters);
    if (!Number.isFinite(m) || !resolution) return 0;
    let cosLat = 1;
    try {
      const c = ol.extent.getCenter(feature.getGeometry().getExtent());
      const lat = ol.proj.toLonLat(c)[1];
      cosLat = Math.cos((lat * Math.PI) / 180) || 1;
    } catch {
      cosLat = 1;
    }
    return m / cosLat / resolution;
  }

  // vsl_feature_type.line_style -> the stroke stack that draws one, two or
  // three parallel lines, `spacingPx` apart, each `weight` px thick.
  //
  // OpenLayers can't offset a stroke from its geometry, so parallel lines
  // are done the way cartographers have always drawn cased roads: paint one
  // wide stroke in the feature's color, then knock the middle back out with
  // a narrower stroke in the "paper" color. The arithmetic is just the
  // total across the bundle —
  //   double: 2 strokes + 1 gap  -> outer 2w+s, knockout s
  //   triple: 3 strokes + 2 gaps -> outer 3w+2s, knockout w+2s, then the
  //           centre stroke painted back on top
  // — which leaves exactly `weight`-thick lines with `spacingPx` between
  // them. The triple's centre line is dotted, the usual road-centreline
  // convention, regardless of the type's own line type.
  const LINE_GAP_COLOR = "#ffffff";
  function lineStrokeStyles(color, weight, dash, lineStyle, spacingPx) {
    const w = Math.max(1, Number(weight) || 2);
    // A sub-pixel gap would render as one blurred thick line, so never let
    // the bundle collapse below something visibly separated.
    const s = Math.max(1, Number(spacingPx) || 0);
    const stroke = (strokeColor, width, strokeDash) =>
      new ol.style.Style({
        stroke: new ol.style.Stroke({ color: strokeColor, width, lineDash: strokeDash })
      });

    if (lineStyle === "double") {
      return [stroke(color, 2 * w + s, dash), stroke(LINE_GAP_COLOR, s)];
    }
    if (lineStyle === "triple") {
      return [
        stroke(color, 3 * w + 2 * s, dash),
        stroke(LINE_GAP_COLOR, w + 2 * s),
        stroke(color, w, lineDashFor("dotted", w))
      ];
    }
    return [stroke(color, w, dash)];
  }

  // `resolution` is handed in by OL (see featuresLayer's style option) and is
  // needed to turn line_spacing_m's ground metres into pixels.
  function styleForFeature(feature, resolution) {
    const halo = highlightedIds.has(String(feature.getId())) ? highlightStyle(feature) : null;
    if (halo) {
      // Prepend the halo so it paints under the feature's own style — the
      // per-kind branches below each return their own array, so this wraps
      // whichever one applies rather than duplicating all three.
      const base = styleWithoutHighlight(feature, resolution);
      return [halo, ...(Array.isArray(base) ? base : [base])];
    }
    return styleWithoutHighlight(feature, resolution);
  }

  function styleWithoutHighlight(feature, resolution) {
    const color = feature.get("_color") || "#3f8f3f";
    const geomType = feature.getGeometry()?.getType();
    if (geomType === "Point" || geomType === "MultiPoint") {
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
      const iconStyle = iconImageStyle(feature.get("_icon"), radius, rotationDeg);
      if (iconStyle) styles.push(iconStyle);
      const label = displayLabelStyle(feature, 0, radius + 6);
      if (label) styles.push(label);
      return styles;
    }
    const weight = Math.max(1, Number(feature.get("_weight")) || (geomType?.includes("Line") ? 3 : 2));
    const linetype = feature.get("_linetype") || "solid";
    const dash = lineDashFor(linetype, weight);

    if (geomType === "LineString" || geomType === "MultiLineString") {
      // "No line" draws nothing but still gets its label — useful for a
      // route or boundary that should only be annotated, not outlined.
      const spacingPx = metersToPixels(feature.get("_lineSpacingM"), resolution, feature);
      const styles =
        linetype === "none"
          ? []
          : lineStrokeStyles(color, weight, dash, feature.get("_lineStyle"), spacingPx);
      const label = displayLabelStyle(feature, -10);
      if (label) styles.push(label);
      return styles;
    }

    const styles = [
      new ol.style.Style({
        stroke:
          linetype === "none"
            ? undefined
            : new ol.style.Stroke({ color, width: weight, lineDash: dash }),
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
  function nameLabelStyle(text, offsetY, offsetX) {
    if (!text) return null;
    return new ol.style.Style({
      text: new ol.style.Text({
        text,
        font: "600 11px sans-serif",
        fill: new ol.style.Fill({ color: "#1d2a1d" }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 3 }),
        offsetY,
        // Same right-of-the-marker placement as a saved point's label.
        offsetX: offsetX || 0,
        textAlign: offsetX ? "left" : "center",
        textBaseline: offsetX ? "middle" : "alphabetic"
      })
    });
  }
  function stylePendingFeature(feature) {
    const color = feature.get("_color") || "#3f8f3f";
    const label = feature.get("_pendingLabel") || "";
    const geomType = feature.getGeometry()?.getType();
    if (geomType === "Point") {
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
      const iconStyle = iconImageStyle(feature.get("_icon"), radius, 0);
      if (iconStyle) styles.push(iconStyle);
      const nl = nameLabelStyle(label, 0, radius + 6);
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
        // Feature TYPE (as distinct from _name, which is this feature's own
        // label). The print tool groups by type — to list only the types
        // actually in use in its Features tab, and to build the legend's
        // Features group. vsl_list_features already returns both.
        olFeature.set("_typeId", row.feature_type_id ?? null);
        olFeature.set("_typeName", row.feature_type_name || "");
        olFeature.set("_linetype", row.linetype ?? null);
        olFeature.set("_lineStyle", row.line_style || "single");
        olFeature.set("_lineSpacingM", row.line_spacing_m ?? 3);
        olFeature.set("_labelDir", row.label_direction || "horizontal");
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
      return SYSTEM_FEATURE_TYPES[entitySelect.value] || null;
    }
    const id = featureSelect.value;
    if (!id) return null;
    return featureTypes.find((f) => String(f.id) === String(id)) || null;
  }

  function isPlotBlockSelected() {
    const ft = currentFeatureType();
    return !!ft?.is_system && (ft.code === "plot" || ft.code === "block");
  }

  // How the picked feature type will actually draw — the exact swatch the
  // Manage Features list shows (icon on a colored chip for a point, the real
  // strokes for a line, fill + outline for a polygon), so what's configured
  // there is visible right here before anything is drawn.
  function updateFeaturePreview() {
    if (!featurePreview) return;
    const ft = isSystemEntity() ? null : currentFeatureType();
    featurePreview.innerHTML = ft ? featureTypeSwatchHtml(ft, { width: 26, height: 20 }) : "";
  }

  function populateFeatureSelect() {
    if (isSystemEntity()) {
      // Block/Plot are chosen directly via drawEntityTypeSelect — no
      // separate Feature pick needed, and they're not in vsl_feature_type
      // at all so they can't show up in the generic Polygon list below.
      if (featureRow) featureRow.hidden = true;
      updatePlotBlockVisibility();
      updateStartButtonState();
      return;
    }
    if (featureRow) featureRow.hidden = false;
    const kind = entitySelect.value;
    const keep = featureSelect.value;
    const rows = featureTypes.filter((f) => f.geometry_kind === kind);
    featureSelect.innerHTML =
      '<option value="">— Select Feature —</option>' +
      rows.map((f) => `<option value="${f.id}">${f.name}</option>`).join("");
    if (keep && rows.some((f) => String(f.id) === keep)) {
      featureSelect.value = keep;
    }
    updateFeaturePreview();
    updatePlotBlockVisibility();
    updateStartButtonState();
  }

  // Start Drawing only makes sense once there's something to draw: a feature
  // type picked, and — for Plot/Block — the Estate/Block it belongs to,
  // unless a Plot is set to resolve its block automatically. Same rules as
  // validateEntityRequirements(), which stays as the on-click backstop for
  // anything that changes without a change event firing.
  function updateStartButtonState() {
    if (!startBtn) return;
    // Mid-session the button is "Finish Drawing" and must always work.
    if (sessionActive) {
      startBtn.disabled = false;
      startBtn.removeAttribute("title");
      return;
    }
    const problem = validateEntityRequirements(currentFeatureType());
    startBtn.disabled = !!problem;
    if (problem) startBtn.title = problem;
    else startBtn.removeAttribute("title");
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
    updateStartButtonState();
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
    updateFeaturePreview();
    updatePlotBlockVisibility();
    updateStartButtonState();
    rearmIfActive();
  });
  estateSelect?.addEventListener("change", () => {
    refreshDrawBlockOptions(estateSelect.value);
    updateStartButtonState();
    rearmIfActive();
  });
  blockSelect?.addEventListener("change", () => {
    updateStartButtonState();
    rearmIfActive();
  });

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
      return isSystemEntity() ? "Unknown entity type selected." : "Choose a feature before drawing.";
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
  // Disabled until the feature types have loaded and something is picked.
  updateStartButtonState();

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
    refreshFeaturesLayer,
    // Used by the Search window's Feature tab and the Select window's
    // Feature tab (both in map-app.js) — pass the ids to halo, or nothing/an
    // empty list to clear. One highlight set, deliberately: searching for a
    // feature and selecting one are both "show me this", and having two
    // competing halos on the same layer would just be confusing.
    setHighlightedFeatures: (ids) => {
      highlightedIds.clear();
      for (const id of ids || []) highlightedIds.add(String(id));
      featuresLayer.changed();
    }
  };
}
