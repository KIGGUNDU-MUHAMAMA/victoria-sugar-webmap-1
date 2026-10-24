/**
 * Survey "Edit" tab — the three things you can do to an object that already
 * exists on the map, one mode each (see MODE below):
 *
 *   Edit Nodes       reshape the boundary. Click any number of plots,
 *                    blocks or drawn features, drag their nodes, then Save
 *                    writes every one of them back to the right table
 *                    (vsl_parcels / vsl_blocks / vsl_feature) in one go.
 *   Edit Properties  click an object to open the same Modify form the
 *                    Select window uses — name, parent, status.
 *   Delete Object    click objects to mark them, then the footer's Delete
 *                    (the Save button, relabelled) removes them.
 *
 * Only one mode runs at a time; the other two buttons disable while one is
 * active. All three select from the same three layers and all three put the
 * map into drafting mode. The rest of this file is mostly about Edit Nodes,
 * which is the only one holding unsaved state.
 *
 * Only ONE feature is actively "focused" (highlighted + draggable) at a
 * time, but selecting a different feature does NOT discard the one you
 * were just on — it stays exactly as you left it (reshaped, unhighlighted,
 * un-draggable until re-selected) as a *pending* edit, so several features
 * can be reshaped across a session and saved together. Only Cancel/Stop/
 * leave-with-discard reverts everything back to its true original shape.
 *
 * That was always the intent, but it did not hold in practice: the land
 * layers are bbox-loaded and reload on every `moveend`, and that reload
 * REPLACES the ol.Feature objects this module is holding. Panning to the
 * next block — the ordinary way to reach it — therefore detached the edit
 * just made to the previous one, and what you saw was the old shape back
 * where it started. A session now suspends that reload for its duration
 * (window.vslSuspendLandReload, map-app.js) and lifts it after a save.
 *
 * While a feature is pending, its pre-session shape is also drawn as a
 * dashed blue outline (originalLayer below) so the new position can be read
 * against the old one rather than the two being the same colour.
 */

import { confirmDanger } from "../popups/popup.js";
import { computeUtmCartesianAreaAcres } from "./utils.js";

// Green — both the always-visible "here are this feature's nodes" resting
// markers, and the cursor's "click here to insert a new node" indicator
// when hovering a segment instead of a vertex.
const INSERT_VERTEX_COLOR = "#2e7d32";
// Red — hovering an existing vertex. A plain click here deletes that node
// (dragging still moves it — see the deleteCondition/style wiring below).
const DELETE_VERTEX_COLOR = "#c62828";
// Amber — bold outline drawn around whichever feature is currently focused
// (the one Modify is actively acting on), same "highlighted" color
// language as blocksLayer/parcelsLayer's own `hi` search/status styling
// elsewhere in this app.
const OUTLINE_COLOR = "#ff8f00";
// Blue, dashed — where the shape was BEFORE this session touched it. Drawn
// for every pending edit, so a dragged boundary can be read against where it
// used to run instead of the two being indistinguishable. Deliberately not
// any colour a real layer uses (blocks are red, plots take status colours,
// titles purple, the focused outline amber).
const ORIGINAL_COLOR = "#1565c0";

// How many past geometry states each pending edit keeps, for the Snap
// widget's Undo button (see performEditUndo/MAX_UNDO_STEPS usage below).
// Oldest state drops off once a feature's been reshaped more than this many
// times in one session — undo depth is bounded to keep memory sane on a
// long editing session, not because 10 is otherwise meaningful.
const MAX_UNDO_STEPS = 10;

// Amber — "this object is selected", the same colour the Select window uses
// for its own picks (HIGHLIGHT_COLOR in js/survey-draw.js). Shared by both
// of the modes below that select rather than reshape:
//
//   Delete Object    the objects marked for deletion
//   Edit Properties  the object whose form is open
//
// Deliberately NOT red. Being selected is the same state whichever window
// you are in, so it should look the same; red would also be the only colour
// on the map claiming "danger" for something that is still just a selection
// and still cancellable.
const SELECTION_COLOR = "#ffb300";

/**
 * The three things this tab can be doing. Exactly one at a time, or none.
 *
 *   NODES       reshape geometry (what this tab did when it was the only
 *               mode and the button said "Start Editing")
 *   PROPERTIES  click an object, open its Modify form
 *   DELETE      mark objects, then delete them
 *
 * All three put the map into drafting mode and select from the same three
 * layers; they differ in what a click DOES, what the footer's Save button
 * means, and whether there is unsaved work to protect on the way out.
 */
const MODE = Object.freeze({ NODES: "nodes", PROPERTIES: "properties", DELETE: "delete" });

/** What the hint box says per mode. It is the only instruction on screen,
 *  so each list has to describe the mode actually running. */
const MODE_HINTS = Object.freeze({
  [MODE.NODES]: [
    "Click an object to start editing it",
    "Drag a node to move it",
    "Click an edge to add a node",
    "Click a node to delete it",
    "Edits are kept as you move between objects — Save writes them all"
  ],
  [MODE.PROPERTIES]: [
    "Click an object to open its details",
    "Change what you need, then Save in that popup",
    "Click another object to edit that one too",
    "Press Stop when you're finished"
  ],
  [MODE.DELETE]: [
    "Click the objects you want to delete",
    "Click one again to take it off the list",
    "Press Delete to remove them permanently",
    "Cancel leaves everything as it is"
  ]
});

export function initSurveyEdit({
  map,
  cfg,
  supabase,
  setStatus,
  statusEl,
  blocksLayer,
  parcelsLayer,
  blocksSource,
  parcelsSource,
  getFeaturesLayer,
  refreshFeaturesLayer,
  loadLayersFromDb,
  refreshEstateBoundaries,
  attachSnap,
  detachSnap
}) {
  const selectBtn = document.getElementById("editSelectFeatureBtn");
  const propertiesBtn = document.getElementById("editPropertiesBtn");
  const deleteObjectBtn = document.getElementById("editDeleteObjectBtn");
  const hintList = document.getElementById("editHintList");
  const saveBtn = document.getElementById("editSaveBtn");
  const cancelBtn = document.getElementById("editCancelBtn");
  const tabPanel = document.getElementById("uamTabEdit");
  const busyOverlay = document.getElementById("surveyBusyOverlay");
  const busyOverlayText = document.getElementById("surveyBusyOverlayText");

  if (!selectBtn || !tabPanel) return null;

  // Generic ".popWinBody is busy" overlay — see survey-panel.html's
  // #surveyBusyOverlay. Exposed on window in case another survey-*.js
  // module wants the same treatment later.
  window.vslSurveyBusy = function (on, text) {
    if (!busyOverlay) return;
    if (busyOverlayText && text) busyOverlayText.textContent = text;
    busyOverlay.hidden = !on;
  };

  // ── Coordinate-array helpers (for the static per-vertex markers below —
  // OL geometry coordinate arrays nest one level per Multi*/Polygon-ring, so
  // this walks generically down to the [x, y] leaves). ──
  function isCoordPair(c) {
    return Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number";
  }
  function ringIsClosed(ring) {
    if (!Array.isArray(ring) || ring.length < 2) return false;
    const a = ring[0], b = ring[ring.length - 1];
    return isCoordPair(a) && isCoordPair(b) && a[0] === b[0] && a[1] === b[1];
  }
  // Every [x, y] leaf in a (possibly nested) coordinate array, skipping a
  // closed ring's duplicated last point (same spot as its first) so it
  // doesn't get two overlapping markers.
  function flattenVertices(coords) {
    const out = [];
    (function walk(node) {
      if (Array.isArray(node) && node.length && isCoordPair(node[0])) {
        const closed = ringIsClosed(node);
        const upto = closed ? node.length - 1 : node.length;
        for (let i = 0; i < upto; i++) out.push(node[i]);
        return;
      }
      node.forEach((child) => walk(child));
    })(coords);
    return out;
  }

  function feedback(msg, isError) {
    if (msg) setStatus?.(statusEl, msg, isError);
  }

  // Block/parcel area, recomputed live from geometry as it's reshaped —
  // same UTM-cartesian algorithm map-app.js's own surveyFeatureAreaAcresText
  // uses (via computeUtmCartesianAreaAcres, imported from the same shared
  // utils.js both modules already pull from), so the number matches exactly
  // what the rest of the app would compute for this shape. Kept in sync
  // onto the feature's own "area_acres" property while editing
  // (see modifyend below) — that property is what blocksLayer/parcelsLayer
  // in map-app.js *prefers* over live computation for their on-map label,
  // so without this, dragging a node would leave that label showing the
  // stale pre-edit area until a full page reload.
  function liveAreaAcres(geometry) {
    if (!geometry) return null;
    try {
      const type = geometry.getType();
      let areaAcres = 0;
      if (type === "Polygon") {
        const ring = geometry.getLinearRing(0);
        if (ring) {
          const lonLats = ring.getCoordinates().map((pt) => ol.proj.transform(pt, "EPSG:3857", "EPSG:4326"));
          areaAcres = computeUtmCartesianAreaAcres(lonLats);
        }
      } else if (type === "MultiPolygon") {
        for (const poly of geometry.getPolygons()) {
          const ring = poly.getLinearRing(0);
          if (ring) {
            const lonLats = ring.getCoordinates().map((pt) => ol.proj.transform(pt, "EPSG:3857", "EPSG:4326"));
            areaAcres += computeUtmCartesianAreaAcres(lonLats);
          }
        }
      } else {
        return null;
      }
      // Rounded once here so the number shown live while dragging and the
      // one eventually persisted on Save (see saveBtn below, which just
      // reads this same property back off the feature) are always
      // identical — no separate rounding step anywhere else.
      return Math.round(areaAcres * 100) / 100;
    } catch {
      return null;
    }
  }

  // ── Highlight layer — bold amber outline over the currently *focused*
  // feature, plus a small green marker at each of its vertices so they
  // stay visible even without hovering. Added by *reference*, not cloned —
  // the same ol.Feature the Modify interaction drags nodes on, so this
  // stays in sync with zero extra bookkeeping. Only ever holds at most one
  // feature (the focused one) — everything else pending just renders
  // through its own normal layer (blocksLayer/parcelsLayer/features
  // layer), already showing its reshaped geometry since that's the same
  // live feature object, just with no special styling once unfocused. ──
  const highlightSource = new ol.source.Vector();
  const outlineFillStyle = new ol.style.Style({
    stroke: new ol.style.Stroke({ color: OUTLINE_COLOR, width: 4 }),
    fill: new ol.style.Fill({ color: "rgba(255, 143, 0, 0.16)" })
  });
  function vertexMarker(coord, color, glyph, radius) {
    return new ol.style.Style({
      geometry: new ol.geom.Point(coord),
      image: new ol.style.Circle({
        radius,
        fill: new ol.style.Fill({ color }),
        stroke: new ol.style.Stroke({ color: "#fff", width: 2 })
      }),
      text: glyph
        ? new ol.style.Text({ text: glyph, font: "bold 10px sans-serif", fill: new ol.style.Fill({ color: "#fff" }) })
        : undefined
    });
  }
  const highlightLayer = new ol.layer.Vector({
    source: highlightSource,
    style: (feature) => {
      const type = feature.getGeometry().getType();
      const styles = [outlineFillStyle];
      if (type === "Point" || type === "MultiPoint") return styles; // nothing to show as separate "nodes"
      for (const xy of flattenVertices(feature.getGeometry().getCoordinates())) {
        styles.push(vertexMarker(xy, INSERT_VERTEX_COLOR, null, 5));
      }
      return styles;
    },
    zIndex: 960
  });
  highlightLayer.set("displayInLayerSwitcher", false);
  map.addLayer(highlightLayer);

  // ── "Where it was" layer ──
  // One CLONE of each pending edit's pre-session geometry, dashed and blue.
  // Clones, not references: this has to stay still while the real feature
  // moves under the cursor — that contrast is the entire point of it.
  //
  // Every pending edit gets one, not just the focused feature, so after
  // reshaping three blocks you can still see what each of the three
  // originally looked like.
  //
  // zIndex 958 puts it above the land layers and the block outlines (915 in
  // map-app.js) so it reads over the plot fills, and just below the
  // highlight layer (960) so the live nodes you are dragging are never
  // covered by the ghost of where they used to be.
  const originalSource = new ol.source.Vector();
  const originalLayer = new ol.layer.Vector({
    source: originalSource,
    style: new ol.style.Style({
      stroke: new ol.style.Stroke({ color: ORIGINAL_COLOR, width: 2.5, lineDash: [7, 6] }),
      // Points have no outline to dash, so they get a hollow blue ring in
      // the old position instead.
      image: new ol.style.Circle({
        radius: 7,
        stroke: new ol.style.Stroke({ color: ORIGINAL_COLOR, width: 2.5 }),
        fill: null
      })
    }),
    zIndex: 958
  });
  originalLayer.set("displayInLayerSwitcher", false);
  map.addLayer(originalLayer);

  // ── "Selected" layer ──
  // Holds whatever the current mode has picked, by reference (so it tracks
  // the real feature), in the app's standard selection amber:
  //
  //   Delete Object    every object marked for deletion — several at once
  //   Edit Properties  the one object whose form is open
  //
  // 959: above the ghost outlines, below the node-editing highlight.
  const selectionSource = new ol.source.Vector();
  const selectionLayer = new ol.layer.Vector({
    source: selectionSource,
    style: (feature) => {
      const type = feature.getGeometry()?.getType();
      // A point has no outline to thicken, so it gets a filled halo behind
      // it instead — same approach as survey-draw.js's highlightStyle.
      if (type === "Point" || type === "MultiPoint") {
        return new ol.style.Style({
          image: new ol.style.Circle({
            radius: 14,
            fill: new ol.style.Fill({ color: "rgba(255, 179, 0, 0.35)" }),
            stroke: new ol.style.Stroke({ color: SELECTION_COLOR, width: 3 })
          })
        });
      }
      return new ol.style.Style({
        stroke: new ol.style.Stroke({ color: SELECTION_COLOR, width: 5 }),
        fill: new ol.style.Fill({ color: "rgba(255, 179, 0, 0.25)" })
      });
    },
    zIndex: 959
  });
  selectionLayer.set("displayInLayerSwitcher", false);
  map.addLayer(selectionLayer);

  // Which mode is running, or null for none. Replaces the old boolean —
  // sessionActive is now simply "is sessionMode set".
  let sessionMode = null;
  let selectInteraction = null;
  let modifyInteraction = null;
  // Snaps a dragged/inserted node onto other already-drawn custom features
  // (trees, roads, walls, …) — separate from attachSnap/detachSnap (map-
  // app.js), which cover snapping onto existing blocks/parcels.
  let featuresSnapInteraction = null;
  const sessionActive = () => sessionMode !== null;

  // Objects marked for deletion in Delete Object mode, keyed the same
  // "kind:id" way as pendingEdits. Nothing is written until the footer's
  // Delete is pressed, so this is only a selection — abandoning it costs
  // nothing, which is why leaving Delete mode needs no "discard?" prompt.
  const pendingDeletes = new Map();

  // One entry per feature touched this session, keyed by "kind:id" (ids are
  // UUIDs per table, but the prefix keeps this collision-proof regardless).
  // Every entry stays — geometry and all — until Save or a revert (Cancel/
  // Stop/leave-with-discard) clears it. modifyFeatures/highlightSource only
  // ever contain the single *focused* entry; the rest just sit here with
  // their already-reshaped geometry, unhighlighted, until re-selected.
  const pendingEdits = new Map();
  let focusedKey = null;
  const modifyFeatures = new ol.Collection();

  // Pre-drag snapshot of the focused feature, taken on "modifystart" and
  // consumed (pushed onto that feature's undoStack) on the paired
  // "modifyend" — see the Modify interaction setup in startSession().
  let modifyStartSnapshot = null;

  // Side channel written by the Modify style function (see below) so
  // deleteCondition knows whether the pointer is currently sitting on an
  // existing vertex, without reaching into OL's private internals for that
  // specific check (only the existing/insert distinction is internal —
  // see the snappedToVertex_ note further down).
  let hoveredVertexCoord = null;

  // ── "Apply to" — what a map click may pick ──
  // The chip group above the three mode buttons (see the Edit tab in
  // windows/survey-panel.html). Same job as the Select window's
  // Parcels/Blocks/Feature tabs, except several can be on at once.

  const FILTER_LABELS = { parcel: "plots", block: "blocks", feature: "features" };
  const pickFilterRadios = Array.from(
    document.querySelectorAll('#editPickFilter input[name="editPickFilter"]')
  );

  /**
   * The chosen filter: "any" | "parcel" | "block" | "feature".
   *
   * Radios, so there is always exactly one — the "nothing selected" state
   * that multi-select chips made possible cannot occur here.
   */
  function currentPickFilter() {
    return pickFilterRadios.find((r) => r.checked)?.value || "any";
  }

  /** The filter as a kind, or null for "any" (pick whatever is clicked). */
  function filterKind() {
    const value = currentPickFilter();
    return value === "any" ? null : value;
  }

  /**
   * Whether the Select interaction should consider a layer, read fresh on
   * every click.
   *
   * Handed to ol.interaction.Select as its `layers` FUNCTION rather than as
   * an array, which is what makes the chips live: changing one applies to
   * the very next click with no interaction to tear down and rebuild.
   *
   * Narrowing is not only about avoiding mistakes — it is how you reach
   * something underneath. Plots cover their block almost completely, so on
   * Any a click inside one can only ever pick the plot; choose Block and
   * the same click reaches the block.
   */
  function layerAllowedForFilter(layer) {
    const featuresLayer = getFeaturesLayer?.();
    switch (currentPickFilter()) {
      case "parcel": return layer === parcelsLayer;
      case "block": return layer === blocksLayer;
      case "feature": return !!featuresLayer && layer === featuresLayer;
      default:
        return layer === blocksLayer || layer === parcelsLayer || (!!featuresLayer && layer === featuresLayer);
    }
  }

  // Changing the filter mid-session is allowed and affects the next click.
  // Nothing already picked is thrown away by it: pending reshapes and
  // delete marks are about objects, not about how they were chosen.
  pickFilterRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!sessionActive()) return;
      const kind = filterKind();
      feedback(
        kind ? `Now picking ${FILTER_LABELS[kind]} only.` : "Now picking plots, blocks or features.",
        false
      );
    });
  });

  function sourceKindFor(feature) {
    if (feature.get("_source") === "vsl_feature") return "feature";
    if (feature.getId() != null && blocksSource?.getFeatureById(feature.getId())) return "block";
    if (feature.getId() != null && parcelsSource?.getFeatureById(feature.getId())) return "parcel";
    return null;
  }

  function labelFor(feature, kind) {
    if (kind === "block") return `Block ${feature.get("block_code") ?? feature.getId()}`;
    if (kind === "parcel") return `Plot ${feature.get("parcel_code") ?? feature.getId()}`;
    if (kind === "feature") return feature.get("_name") ? `${feature.get("_name")}` : "Custom feature";
    return "Feature";
  }

  function pendingKey(feature, kind) {
    return `${kind}:${feature.getId()}`;
  }

  // Switches which single feature Modify/the highlight layer are acting
  // on. The previously-focused feature (if any) is left exactly as it
  // is — still in pendingEdits with whatever shape it was dragged into —
  // just removed from the "active" layer/collection so it renders through
  // its normal layer again (plain boundary-line style, no nodes).
  function focusFeature(feature, kind) {
    const key = pendingKey(feature, kind);
    if (focusedKey === key) return; // already the one being edited

    if (focusedKey) {
      const prev = pendingEdits.get(focusedKey);
      if (prev) {
        modifyFeatures.remove(prev.feature);
        highlightSource.removeFeature(prev.feature);
      }
    }

    if (!pendingEdits.has(key)) {
      const originalGeom = feature.getGeometry().clone();
      // The dashed blue "this is where it was" outline. Added the moment a
      // feature becomes pending — before it has been dragged at all, so it
      // sits exactly under the real one until the first node moves.
      const ghost = new ol.Feature({ geometry: originalGeom.clone() });
      originalSource.addFeature(ghost);
      pendingEdits.set(key, {
        feature,
        kind,
        ghost,
        originalGeom,
        // Only meaningful for block/parcel (see liveAreaAcres/modifyend
        // below) — snapshotted so Cancel/discard can put the true original
        // value back, not whatever it got live-recomputed to mid-edit.
        originalExpectedArea: kind === "block" || kind === "parcel" ? feature.get("area_acres") : undefined,
        // The custom-feature equivalent: _areaAc mirrors vsl_feature.area_ac
        // (see js/survey-draw.js areaAcresText), which the map label and the
        // PDF both display verbatim. Dragging a node has to keep it honest,
        // and Cancel has to put the database's own value back rather than
        // whatever it got live-recomputed to mid-edit.
        originalAreaAc: kind === "feature" ? feature.get("_areaAc") : undefined,
        // Undo history for this one feature — see performEditUndo() and the
        // modifystart/modifyend pair below that fill it. Capped at
        // MAX_UNDO_STEPS, oldest dropped first.
        undoStack: []
      });
    }
    modifyFeatures.push(feature);
    highlightSource.addFeature(feature);
    focusedKey = key;
    hoveredVertexCoord = null;
    syncSaveEnabled();
  }

  function clearPending({ restore }) {
    for (const { feature, kind, originalGeom, originalExpectedArea, originalAreaAc } of pendingEdits.values()) {
      if (restore) {
        feature.setGeometry(originalGeom.clone());
        if (kind === "block" || kind === "parcel") {
          feature.set("area_acres", originalExpectedArea);
        }
        if (kind === "feature") {
          feature.set("_areaAc", originalAreaAc);
        }
      }
    }
    pendingEdits.clear();
    modifyFeatures.clear();
    highlightSource.clear();
    originalSource.clear();
    focusedKey = null;
    hoveredVertexCoord = null;
    syncSaveEnabled();
  }

  // The three mode buttons. Whichever mode is running turns red and offers
  // to stop; the other two go disabled, which is what enforces "one mode at
  // a time" — there is no state in which two of these are armed.
  //
  // .uam-btn--active and .uam-btn--danger both set `background` at equal
  // specificity — combining them wouldn't give the red "Stop" look
  // (whichever is declared later in styles.css wins the whole property), so
  // this swaps --primary/--danger only, not --active.
  // `idleClass` is each button's own resting colour: green for the two
  // modes that change things, orange for the one that destroys them.
  const MODE_BUTTONS = [
    { btn: selectBtn, mode: MODE.NODES, idleClass: "uam-btn--primary",
      idle: '<i class="fas fa-circle-play" aria-hidden="true"></i> Edit Nodes',
      stop: '<i class="fas fa-stop-circle" aria-hidden="true"></i> Stop Editing' },
    { btn: propertiesBtn, mode: MODE.PROPERTIES, idleClass: "uam-btn--primary",
      idle: '<i class="fas fa-pen-to-square" aria-hidden="true"></i> Edit Properties',
      stop: '<i class="fas fa-stop-circle" aria-hidden="true"></i> Stop Editing' },
    { btn: deleteObjectBtn, mode: MODE.DELETE, idleClass: "uam-btn--warn",
      idle: '<i class="fas fa-trash-can" aria-hidden="true"></i> Delete Object',
      stop: '<i class="fas fa-stop-circle" aria-hidden="true"></i> Stop Deleting' }
  ];

  function setModeButtons(mode) {
    for (const { btn, mode: own, idle, stop, idleClass } of MODE_BUTTONS) {
      if (!btn) continue;
      const active = mode === own;
      btn.classList.toggle("uam-btn--danger", active);
      btn.classList.toggle(idleClass, !active);
      btn.innerHTML = active ? stop : idle;
      btn.disabled = mode !== null && !active;
    }
  }

  /**
   * The footer's Save button, which is a different action per mode.
   *
   * Delete Object turns it into a red "Delete" — the one button that
   * destroys something should not look like the one that saves. Cancel is
   * left exactly as it is in every mode: it ends the session and keeps
   * nothing, which is the same meaning throughout.
   */
  function setFooterForMode(mode) {
    if (!saveBtn) return;
    const deleting = mode === MODE.DELETE;
    saveBtn.classList.toggle("btn-add", !deleting);
    saveBtn.classList.toggle("btn-clear", deleting);
    saveBtn.classList.toggle("futuristic-icon-btn--danger", deleting);
    saveBtn.innerHTML = deleting
      ? '<i class="fas fa-trash-can" aria-hidden="true"></i>Delete'
      : '<i class="fas fa-floppy-disk" aria-hidden="true"></i>Save';
  }

  /** Save/Delete is enabled only when its mode has something to act on.
   *  Edit Properties never uses it — that mode saves through the popup. */
  function syncSaveEnabled() {
    if (!saveBtn) return;
    if (sessionMode === MODE.NODES) saveBtn.disabled = pendingEdits.size === 0;
    else if (sessionMode === MODE.DELETE) saveBtn.disabled = pendingDeletes.size === 0;
    else saveBtn.disabled = true;
  }

  function renderHints(mode) {
    if (!hintList) return;
    const lines = MODE_HINTS[mode] || [];
    hintList.innerHTML = lines.map((line) => `<li>${line}</li>`).join("");
    hintList.hidden = lines.length === 0;
  }

  // Arms/disarms this tab's own custom-feature snap target (already-saved
  // vsl_feature polygons/lines/points) in step with the Snap master toggle.
  // Separate from attachSnap/detachSnap (map-app.js's blocks/parcels/survey
  // snap): that source is local to this tab, not part of the shared
  // mechanism, but it must obey the same on/off switch rather than snapping
  // unconditionally regardless of it. Called both when starting a session
  // and live, mid-session, via window.vslDraftingSnapSync (see the
  // enterDraftingMode() call below and its click handler in map-app.js).
  function syncFeatureSnap(on) {
    if (on) {
      if (featuresSnapInteraction) return;
      const layer = getFeaturesLayer?.();
      if (layer?.getSource) {
        featuresSnapInteraction = new ol.interaction.Snap({ source: layer.getSource(), pixelTolerance: 12 });
        map.addInteraction(featuresSnapInteraction);
      }
    } else if (featuresSnapInteraction) {
      map.removeInteraction(featuresSnapInteraction);
      featuresSnapInteraction = null;
    }
  }

  function startSession(mode) {
    if (sessionActive()) return;
    sessionMode = mode;
    setModeButtons(mode);
    setFooterForMode(mode);
    renderHints(mode);
    syncSaveEnabled();
    // Suppress the plain-click parcel/block selection toolbar for the
    // whole session — see window.vslSetParcelClickEnabled (map-app.js).
    // Otherwise clicking a plot to edit it would also pop that up.
    window.vslSetParcelClickEnabled?.(false);
    // Stop the land layers being rebuilt under us. They reload on every
    // `moveend`, and that rebuild replaces the very ol.Feature objects this
    // session is holding and reshaping — so panning to the next block you
    // wanted to edit threw away the edit you had just made to the last one.
    // See window.vslSuspendLandReload in map-app.js for the full account.
    //
    // Nodes mode only. The other two hold no unsaved geometry, and both end
    // in a write that has to be followed by exactly that reload to show its
    // result — suspending it there would leave a renamed or deleted object
    // looking untouched until something else refreshed the map.
    if (mode === MODE.NODES) window.vslSuspendLandReload?.();
    // Undo belongs to node dragging; there is nothing to undo in the other
    // two modes, so the Snap widget's Undo button gets a no-op rather than
    // a button that silently does nothing recognisable.
    window.vslEnterDraftingMode?.(mode === MODE.NODES ? performEditUndo : () => {}, syncFeatureSnap);
    feedback(
      mode === MODE.DELETE
        ? "Click the objects to delete, then press Delete…"
        : mode === MODE.PROPERTIES
          ? "Click a plot, block, or feature to edit its details…"
          : "Click a plot, block, or feature on the map to edit it…",
      false
    );

    // A filter function, not a fixed list — see layerAllowedForFilter: it
    // is consulted per click, so the "Apply to" radios work mid-session.
    selectInteraction = new ol.interaction.Select({ layers: layerAllowedForFilter });
    map.addInteraction(selectInteraction);

    selectInteraction.on("select", (evt) => {
      const feature = evt.selected?.[0];
      // We render our own highlight/vertex styling on our own layers — no
      // need for (and don't want to fight with) ol.interaction.Select's own
      // default styling, so immediately clear its internal selection.
      selectInteraction.getFeatures().clear();
      if (!feature) return;
      const kind = sourceKindFor(feature);
      if (!kind) {
        feedback("That object can't be edited here.", true);
        return;
      }
      // The layer filter above should already have made this impossible;
      // kept because sourceKindFor decides a kind from the feature itself,
      // and the two disagreeing should fail loudly rather than quietly act
      // on something "Apply to" says is off limits.
      const wanted = filterKind();
      if (wanted && wanted !== kind) {
        feedback(`"Apply to" is set to ${FILTER_LABELS[wanted]} — that is a ${kind}.`, true);
        return;
      }
      if (sessionMode === MODE.PROPERTIES) onPickForProperties(feature, kind);
      else if (sessionMode === MODE.DELETE) onPickForDelete(feature, kind);
      else onPickForNodes(feature, kind);
    });

    // Everything below belongs to node editing: the Modify interaction, its
    // snapping, and the undo snapshots. Edit Properties and Delete Object
    // only need the Select interaction above.
    if (mode !== MODE.NODES) return;

    modifyInteraction = new ol.interaction.Modify({
      features: modifyFeatures,
      // OL 7.3 (this app's pinned version, see webmap.html) predates the
      // documented `existing` flag on the style function's sketch-point
      // feature (added in later OL releases) — the closest available
      // signal is Modify's own internal snappedToVertex_ flag, which is
      // exactly what it uses to decide drag-an-existing-vertex vs.
      // insert-a-new-one in the first place, so reading it here (a plain,
      // if underscore-named/undocumented, instance property — nothing
      // about it is a true JS private field) stays perfectly in sync with
      // actual behaviour. Revisit if the OL version ever changes.
      style: (feature) => {
        if (!feature.get("features")) return vertexMarker(feature.getGeometry().getCoordinates(), DELETE_VERTEX_COLOR, "✕", 7);
        const coord = feature.getGeometry().getCoordinates();
        const existing = !!modifyInteraction?.snappedToVertex_;
        hoveredVertexCoord = existing ? coord : null;
        // Hovering an existing vertex: a plain click deletes it (dragging
        // still moves it, handled entirely separately by OL's own
        // click-vs-drag classification) — red+✕ signals that. Hovering a
        // segment: click inserts a new node there — green+"+".
        return existing
          ? vertexMarker(coord, DELETE_VERTEX_COLOR, "✕", 7)
          : vertexMarker(coord, INSERT_VERTEX_COLOR, "+", 7);
      },
      // A plain (non-drag) click on an existing vertex removes it — one
      // step, no confirmation, matching the red+✕ cue above. A genuine
      // drag never reaches here: OL only fires the "singleclick" this
      // checks for when the pointer didn't move between down and up.
      deleteCondition: (evt) => ol.events.condition.singleClick(evt) && !!hoveredVertexCoord
    });
    map.addInteraction(modifyInteraction);

    // Re-syncs the focused block/parcel's "area_acres" to its
    // just-reshaped geometry after every discrete Modify action (a drag,
    // an inserted vertex, or a deleted one all fire this) — see
    // liveAreaAcres's comment above for why that property specifically.
    // Custom vsl_feature polygons/lines need no equivalent: their area/
    // length labels (js/survey-draw.js styleForFeature) are computed fresh
    // from geometry on every render already, nothing cached to go stale.
    // Snapshot the focused feature's pre-drag state so the paired
    // "modifyend" below has something to push onto its undoStack — this is
    // what performEditUndo() pops from (see the Snap widget's Undo button).
    modifyInteraction.on("modifystart", () => {
      if (!focusedKey) {
        modifyStartSnapshot = null;
        return;
      }
      const entry = pendingEdits.get(focusedKey);
      if (!entry) {
        modifyStartSnapshot = null;
        return;
      }
      modifyStartSnapshot = {
        geometry: entry.feature.getGeometry().clone(),
        expectedArea: entry.feature.get("area_acres"),
        // Custom features label from _areaAc, so undoing a drag has to walk
        // that back alongside the geometry or the shape and its acreage
        // would disagree (see modifyend below).
        areaAc: entry.feature.get("_areaAc")
      };
    });

    modifyInteraction.on("modifyend", () => {
      if (!focusedKey) return;
      const entry = pendingEdits.get(focusedKey);
      if (!entry) return;
      if (modifyStartSnapshot) {
        entry.undoStack.push(modifyStartSnapshot);
        if (entry.undoStack.length > MAX_UNDO_STEPS) entry.undoStack.shift();
        modifyStartSnapshot = null;
      }
      const areaAcres = liveAreaAcres(entry.feature.getGeometry());
      if (areaAcres == null) return;
      if (entry.kind === "block" || entry.kind === "parcel") {
        entry.feature.set("area_acres", areaAcres);
      } else if (entry.kind === "feature") {
        // Same reason as the two above: the map label (and the PDF) read
        // _areaAc in preference to computing, so without this a dragged
        // polygon would keep showing its pre-drag acreage. The database's
        // own value is rewritten by the vsl_feature_before_write trigger on
        // save, and comes back on the next layer refresh.
        entry.feature.set("_areaAc", areaAcres);
      }
    });

    // Snap-to-existing-features while dragging a node — same shared
    // mechanism the Draw tab uses (blocks/parcels via map-app.js's
    // attachSnap), plus this session's own custom-features layer. Both
    // must be added *after* modifyInteraction above for OL to actually
    // apply the snap while a node is being dragged.
    attachSnap?.();
    syncFeatureSnap(window.vslIsSnapMasterOn?.() !== false);
  }

  /** Edit Nodes — make this the focused feature and leave every other
   *  pending edit exactly as it is. */
  function onPickForNodes(feature, kind) {
    focusFeature(feature, kind);
    feedback(
      `Editing ${labelFor(feature, kind)} (${pendingEdits.size} pending). Drag its nodes, click another object, or Save.`,
      false
    );
  }

  /**
   * Edit Properties — hand the clicked object to the same Modify form the
   * Select window uses (window.vslOpenModifyPopup in map-app.js), rather
   * than this module growing its own copy of a form that already exists in
   * two flavours per record type.
   *
   * The popup does its own writing and its own map refresh, so there is
   * nothing pending here and nothing for the footer's Save to do — the
   * session just stays armed for the next object.
   */
  async function onPickForProperties(feature, kind) {
    if (typeof window.vslOpenModifyPopup !== "function") {
      feedback("The details form isn't available.", true);
      return;
    }
    // Show it as picked for as long as its form is open — one object at a
    // time here, unlike Delete Object, so the previous pick comes off
    // first. Without this the popup appears with nothing on the map saying
    // which object it belongs to.
    selectionSource.clear();
    selectionSource.addFeature(feature);
    feedback(`Editing the details of ${labelFor(feature, kind)}…`, false);
    try {
      await window.vslOpenModifyPopup(feature, kind);
    } finally {
      // Whether it was saved or cancelled, the form is closed and the
      // highlight has nothing left to explain. Guarded because the session
      // may have been stopped while the popup was open.
      if (sessionMode === MODE.PROPERTIES) selectionSource.clear();
    }
    if (sessionActive()) {
      feedback("Click another object to edit its details, or press Stop.", false);
    }
  }

  /** Delete Object — add to (or take off) the list of objects to delete.
   *  Nothing is written until the footer's Delete is pressed. */
  function onPickForDelete(feature, kind) {
    const key = pendingKey(feature, kind);
    if (pendingDeletes.has(key)) {
      pendingDeletes.delete(key);
      selectionSource.removeFeature(feature);
      feedback(`${labelFor(feature, kind)} taken off the list (${pendingDeletes.size} marked).`, false);
    } else {
      pendingDeletes.set(key, { feature, kind });
      selectionSource.addFeature(feature);
      feedback(`${labelFor(feature, kind)} marked for deletion (${pendingDeletes.size} marked).`, false);
    }
    syncSaveEnabled();
  }

  // Tears down the session's interactions and toolbar suppression.
  // `restore: true` reverts every pending edit's geometry first (Cancel,
  // Stop-with-discard, leaving the tab/closing the window with unsaved
  // work); `restore: false` just clears the tracking (used right after a
  // successful Save, where the new geometry should stick).
  async function stopSession({ restore }) {
    if (!sessionActive()) return;
    if (selectInteraction) {
      map.removeInteraction(selectInteraction);
      selectInteraction = null;
    }
    if (modifyInteraction) {
      map.removeInteraction(modifyInteraction);
      modifyInteraction = null;
    }
    if (featuresSnapInteraction) {
      map.removeInteraction(featuresSnapInteraction);
      featuresSnapInteraction = null;
    }
    detachSnap?.();
    clearPending({ restore });
    // Marks are only a selection — nothing was written, so there is nothing
    // to restore, just the red highlighting to take off the map.
    pendingDeletes.clear();
    selectionSource.clear();
    // Nothing unsaved left to protect. Idempotent, so the save path having
    // already lifted this (it must, to refresh) is not a problem.
    window.vslResumeLandReload?.();
    sessionMode = null;
    setModeButtons(null);
    setFooterForMode(null);
    if (hintList) {
      hintList.hidden = true;
      hintList.innerHTML = "";
    }
    syncSaveEnabled();
    feedback("", false);
    window.vslSetParcelClickEnabled?.(true);
    window.vslExitDraftingMode?.();
  }

  // Reached via the Snap widget's Undo button (window.vslDraftingUndo, set
  // by enterDraftingMode() above). Pops the focused feature's most recent
  // pre-drag snapshot and restores it — one step per click, up to
  // MAX_UNDO_STEPS steps deep. No-op if nothing's focused yet or its
  // history is empty (e.g. right after Edit Nodes starts, before any drag).
  function performEditUndo() {
    if (!focusedKey) return;
    const entry = pendingEdits.get(focusedKey);
    if (!entry || !entry.undoStack.length) return;
    const snapshot = entry.undoStack.pop();
    entry.feature.setGeometry(snapshot.geometry.clone());
    if (entry.kind === "block" || entry.kind === "parcel") {
      entry.feature.set("area_acres", snapshot.expectedArea);
    } else if (entry.kind === "feature") {
      entry.feature.set("_areaAc", snapshot.areaAc);
    }
    feedback(`Undid last change to ${labelFor(entry.feature, entry.kind)}.`, false);
  }

  function confirmDiscardChanges() {
    return confirmDanger({
      title: "Discard Unsaved Edits?",
      message: `You have ${pendingEdits.size} unsaved edit${pendingEdits.size === 1 ? "" : "s"}. Leaving now will discard ${pendingEdits.size === 1 ? "it" : "them"}.`,
      confirmLabel: "Discard"
    });
  }

  /**
   * One handler for all three mode buttons: press to start that mode, press
   * the same button again to stop it.
   *
   * The other two buttons are disabled while a mode runs, so this can only
   * ever be called for the running mode or from a standing start — there is
   * no "switch straight from one mode to another" path to get wrong.
   */
  function wireModeButton(btn, mode) {
    btn?.addEventListener("click", async () => {
      if (!sessionActive()) {
        startSession(mode);
        return;
      }
      if (sessionMode !== mode) return; // disabled anyway; belt and braces
      // Only node editing holds unsaved work worth warning about.
      if (sessionMode === MODE.NODES && pendingEdits.size > 0) {
        const discard = await confirmDiscardChanges();
        if (!discard) return;
      }
      await stopSession({ restore: true });
    });
  }
  wireModeButton(selectBtn, MODE.NODES);
  wireModeButton(propertiesBtn, MODE.PROPERTIES);
  wireModeButton(deleteObjectBtn, MODE.DELETE);

  // Explicit Cancel (footer button) — confirms first, same as the
  // Start/Stop toggle's stop branch, since this discards every pending
  // edit too.
  cancelBtn?.addEventListener("click", async () => {
    if (pendingEdits.size > 0) {
      const discard = await confirmDiscardChanges();
      if (!discard) return;
    }
    await stopSession({ restore: true });
  });

  /**
   * Delete Object's footer button (the same button, relabelled — see
   * setFooterForMode).
   *
   * The deleting itself goes through window.vslDeleteLandFeatures
   * (map-app.js), the same code path the Select window's Delete uses, so
   * both honour the same guard: a block that still has plots in it is
   * refused with a message naming how many, never cascaded.
   *
   * One call per kind, because that guard is per-kind — a mixed bag of two
   * blocks and a plot is two calls, and each is confirmed on its own.
   */
  async function runPendingDeletes() {
    if (!pendingDeletes.size) return;
    if (typeof window.vslDeleteLandFeatures !== "function") {
      feedback("Deleting isn't available.", true);
      return;
    }

    const byKind = new Map();
    for (const { feature, kind } of pendingDeletes.values()) {
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(feature);
    }

    let allDone = true;
    for (const [kind, features] of byKind) {
      const ok = await window.vslDeleteLandFeatures(features, kind);
      if (!ok) allDone = false;
    }

    if (!allDone) {
      // Something was refused or failed. The marks stay on whatever is
      // still there, so what didn't go is exactly what is still red, and
      // the session stays open to deal with it.
      //
      // Checked against the live sources by id — not by the feature's own
      // properties, which survive deletion perfectly well on a detached
      // object and would keep a gone-but-marked shape on the map.
      const stillOnMap = (feature, kind) => {
        const id = feature.getId();
        if (kind === "block") return !!blocksSource?.getFeatureById?.(id);
        if (kind === "parcel") return !!parcelsSource?.getFeatureById?.(id);
        return !!getFeaturesLayer?.()?.getSource?.()?.getFeatureById?.(id);
      };
      for (const [key, entry] of [...pendingDeletes.entries()]) {
        if (stillOnMap(entry.feature, entry.kind)) continue;
        selectionSource.removeFeature(entry.feature);
        pendingDeletes.delete(key);
      }
      syncSaveEnabled();
      return;
    }

    await stopSession({ restore: false });
  }

  saveBtn?.addEventListener("click", async () => {
    // One button, two meanings — Delete Object relabels it (setFooterForMode).
    if (sessionMode === MODE.DELETE) {
      await runPendingDeletes();
      return;
    }
    if (!pendingEdits.size) return;
    if (!supabase) {
      feedback("Can't save — Supabase client not available.", true);
      return;
    }

    const gj = new ol.format.GeoJSON();
    const entries = [...pendingEdits.values()];
    const errors = [];
    let savedCount = 0;
    let savedAnyBlock = false;

    window.vslSurveyBusy?.(true, "Saving…");
    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id ?? null;

      for (const { feature, kind } of entries) {
        const geoJsonGeom = gj.writeGeometryObject(feature.getGeometry(), {
          featureProjection: "EPSG:3857",
          dataProjection: "EPSG:4326"
        });
        const id = feature.getId();
        try {
          if (kind === "block") {
            const { error } = await supabase.rpc("vsl_update_block_geom", {
              p_block_id: id,
              p_geojson: geoJsonGeom,
              p_user_id: userId
            });
            if (error) throw error;
            savedAnyBlock = true;
            // vsl_update_block_geom only touches geom — persist the area
            // already recomputed onto the feature live while it was being
            // dragged (see modifyend above) with a plain follow-up update,
            // same pattern the Draw tab uses for block_name/parcel_name.
            const areaAcres = feature.get("area_acres");
            if (areaAcres != null) {
              await supabase.from("vsl_blocks").update({ area_acres: areaAcres }).eq("id", id);
            }
          } else if (kind === "parcel") {
            const { error } = await supabase.rpc("vsl_update_parcel_geom", {
              p_parcel_id: id,
              p_geojson: geoJsonGeom,
              p_user_id: userId
            });
            if (error) throw error;
            const areaAcres = feature.get("area_acres");
            if (areaAcres != null) {
              await supabase.from("vsl_parcels").update({ area_acres: areaAcres }).eq("id", id);
            }
          } else {
            const { error } = await supabase.rpc("vsl_update_feature_geom", {
              p_feature_id: id,
              p_geojson: geoJsonGeom,
              p_user_id: userId
            });
            if (error) throw error;
          }
          savedCount += 1;
        } catch (err) {
          console.error("[Victoria Survey] Edit save failed for one feature:", err);
          errors.push(`${labelFor(feature, kind)}: ${err.message}`);
        }
      }

      // Every write is done, so the layers may be rebuilt again — and they
      // have to be, since that rebuild is what pulls the saved geometry
      // back. Lifted here rather than in stopSession because stopSession
      // runs after this refresh.
      window.vslResumeLandReload?.();
      await loadLayersFromDb?.();
      await refreshFeaturesLayer?.();
      // A block's geom/estate_id feeds a DB trigger that recomputes the
      // parent estate's bounding envelope — pull that fresh geometry into
      // the map's estate-outline layer if any block was among the saves.
      if (savedAnyBlock) await refreshEstateBoundaries?.();

      if (errors.length) {
        feedback(`Saved ${savedCount}/${entries.length}. Errors: ${errors.join("; ")}`, true);
      } else {
        feedback(`Saved ${savedCount} feature(s).`, false);
      }
    } catch (e) {
      console.error("[Victoria Survey] Edit save failed:", e);
      feedback(`Save failed: ${e.message}`, true);
      // The session and its pending edits live on, so they need protecting
      // again — this covers the window between resuming above and the
      // refresh that follows it throwing.
      window.vslSuspendLandReload?.();
      return; // keep the session + pending edits — nothing was confirmed lost
    } finally {
      window.vslSurveyBusy?.(false);
    }

    // Whatever's now on the map is what got saved — clear tracking without
    // reverting, and end the session (matches Cancel's session-ending
    // symmetry rather than silently staying in edit mode).
    await stopSession({ restore: false });
  });

  // The single choke point unified-menu.js calls before closing this
  // window or switching to any other tab (see window.vslConfirmSurveyClose
  // in unified-menu.js's confirmLeaveIfEditing()). Resolving true means
  // "go ahead"; this function is also responsible for actually tearing the
  // session down (with or without reverting) before returning.
  //
  // survey-draw.js sets this same hook for its own pending-shapes queue and
  // initializes *before* this module (see map-app.js's init call order) —
  // wrap whatever it left here instead of overwriting it outright, so both
  // tabs' unsaved work gets guarded regardless of which is active when the
  // user tries to navigate away.
  const previousConfirmSurveyClose = window.vslConfirmSurveyClose;
  window.vslConfirmSurveyClose = async () => {
    if (typeof previousConfirmSurveyClose === "function") {
      if (!(await previousConfirmSurveyClose())) return false;
    }
    if (!sessionActive()) return true;
    if (pendingEdits.size > 0) {
      const discard = await confirmDiscardChanges();
      if (!discard) return false;
    }
    await stopSession({ restore: true });
    return true;
  };

  // Safety net only — window.vslConfirmSurveyClose above is what actually
  // gates leaving the tab now, so by the time this fires (tab already
  // hidden) sessionActive should already be false. Covers any path that
  // hides the tab without going through unified-menu.js's switchTab.
  const observer = new MutationObserver(() => {
    if (tabPanel.hidden && sessionActive()) stopSession({ restore: true });
  });
  observer.observe(tabPanel, { attributes: true, attributeFilter: ["hidden"] });

  return {
    hasPendingEdits: () => pendingEdits.size > 0
  };
}
