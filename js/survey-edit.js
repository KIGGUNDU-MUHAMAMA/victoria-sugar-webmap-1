/**
 * Survey "Edit" tab — toggle an editing session on ("Start Editing"), click
 * any number of plots/blocks/drawn features to reshape them (drag their
 * nodes, click an edge to add a node, click a node to delete it), then Save
 * writes every one of them back to the right table (vsl_parcels /
 * vsl_blocks / vsl_feature) in one go.
 *
 * Only ONE feature is actively "focused" (highlighted + draggable) at a
 * time, but selecting a different feature does NOT discard the one you
 * were just on — it stays exactly as you left it (reshaped, unhighlighted,
 * un-draggable until re-selected) as a *pending* edit, so several features
 * can be reshaped across a session and saved together. Only Cancel/Stop/
 * leave-with-discard reverts everything back to its true original shape.
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

// How many past geometry states each pending edit keeps, for the Snap
// widget's Undo button (see performEditUndo/MAX_UNDO_STEPS usage below).
// Oldest state drops off once a feature's been reshaped more than this many
// times in one session — undo depth is bounded to keep memory sane on a
// long editing session, not because 10 is otherwise meaningful.
const MAX_UNDO_STEPS = 10;

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
  // onto the feature's own "expected_area_acres" property while editing
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

  let selectInteraction = null;
  let modifyInteraction = null;
  // Snaps a dragged/inserted node onto other already-drawn custom features
  // (trees, roads, walls, …) — separate from attachSnap/detachSnap (map-
  // app.js), which cover snapping onto existing blocks/parcels.
  let featuresSnapInteraction = null;
  let sessionActive = false;

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
      pendingEdits.set(key, {
        feature,
        kind,
        originalGeom: feature.getGeometry().clone(),
        // Only meaningful for block/parcel (see liveAreaAcres/modifyend
        // below) — snapshotted so Cancel/discard can put the true original
        // value back, not whatever it got live-recomputed to mid-edit.
        originalExpectedArea: kind === "block" || kind === "parcel" ? feature.get("expected_area_acres") : undefined,
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
    saveBtn.disabled = false;
  }

  function clearPending({ restore }) {
    for (const { feature, kind, originalGeom, originalExpectedArea } of pendingEdits.values()) {
      if (restore) {
        feature.setGeometry(originalGeom.clone());
        if (kind === "block" || kind === "parcel") {
          feature.set("expected_area_acres", originalExpectedArea);
        }
      }
    }
    pendingEdits.clear();
    modifyFeatures.clear();
    highlightSource.clear();
    focusedKey = null;
    hoveredVertexCoord = null;
    saveBtn.disabled = true;
  }

  // .uam-btn--active and .uam-btn--danger both set `background` at equal
  // specificity — combining them wouldn't give the red "Stop Editing"
  // look (whichever is declared later in styles.css wins the whole
  // property), so this swaps --primary/--danger only, not --active.
  function setToggleButtonState(active) {
    selectBtn.classList.toggle("uam-btn--danger", active);
    selectBtn.classList.toggle("uam-btn--primary", !active);
    selectBtn.innerHTML = active
      ? '<i class="fas fa-stop-circle" aria-hidden="true"></i> Stop Editing'
      : '<i class="fas fa-circle-play" aria-hidden="true"></i> Start Editing';
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

  function startSession() {
    if (sessionActive) return;
    sessionActive = true;
    setToggleButtonState(true);
    if (hintList) hintList.hidden = false;
    // Suppress the plain-click parcel/block selection toolbar for the
    // whole session — see window.vslSetParcelClickEnabled (map-app.js).
    // Otherwise clicking a plot to edit it would also pop that up.
    window.vslSetParcelClickEnabled?.(false);
    window.vslEnterDraftingMode?.(performEditUndo, syncFeatureSnap);
    feedback("Click a plot, block, or feature on the map to edit it…", false);

    const layers = [blocksLayer, parcelsLayer, getFeaturesLayer?.()].filter(Boolean);
    selectInteraction = new ol.interaction.Select({ layers });
    map.addInteraction(selectInteraction);

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

    // Re-syncs the focused block/parcel's "expected_area_acres" to its
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
        expectedArea: entry.feature.get("expected_area_acres")
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
      if (entry.kind !== "block" && entry.kind !== "parcel") return;
      const areaAcres = liveAreaAcres(entry.feature.getGeometry());
      if (areaAcres != null) entry.feature.set("expected_area_acres", areaAcres);
    });

    // Snap-to-existing-features while dragging a node — same shared
    // mechanism the Draw tab uses (blocks/parcels via map-app.js's
    // attachSnap), plus this session's own custom-features layer. Both
    // must be added *after* modifyInteraction above for OL to actually
    // apply the snap while a node is being dragged.
    attachSnap?.();
    syncFeatureSnap(window.vslIsSnapMasterOn?.() !== false);

    selectInteraction.on("select", (evt) => {
      const feature = evt.selected?.[0];
      // We render our own highlight/vertex styling on highlightLayer — no
      // need for (and don't want to fight with) ol.interaction.Select's
      // own default styling, so immediately clear its internal selection.
      selectInteraction.getFeatures().clear();
      if (!feature) return;
      const kind = sourceKindFor(feature);
      if (!kind) {
        feedback("That feature can't be edited here.", true);
        return;
      }
      focusFeature(feature, kind);
      feedback(
        `Editing ${labelFor(feature, kind)} (${pendingEdits.size} pending). Drag its nodes, click another feature, or Save.`,
        false
      );
    });
  }

  // Tears down the session's interactions and toolbar suppression.
  // `restore: true` reverts every pending edit's geometry first (Cancel,
  // Stop-with-discard, leaving the tab/closing the window with unsaved
  // work); `restore: false` just clears the tracking (used right after a
  // successful Save, where the new geometry should stick).
  async function stopSession({ restore }) {
    if (!sessionActive) return;
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
    sessionActive = false;
    setToggleButtonState(false);
    if (hintList) hintList.hidden = true;
    feedback("", false);
    window.vslSetParcelClickEnabled?.(true);
    window.vslExitDraftingMode?.();
  }

  // Reached via the Snap widget's Undo button (window.vslDraftingUndo, set
  // by enterDraftingMode() above). Pops the focused feature's most recent
  // pre-drag snapshot and restores it — one step per click, up to
  // MAX_UNDO_STEPS steps deep. No-op if nothing's focused yet or its
  // history is empty (e.g. right after Start Editing, before any drag).
  function performEditUndo() {
    if (!focusedKey) return;
    const entry = pendingEdits.get(focusedKey);
    if (!entry || !entry.undoStack.length) return;
    const snapshot = entry.undoStack.pop();
    entry.feature.setGeometry(snapshot.geometry.clone());
    if (entry.kind === "block" || entry.kind === "parcel") {
      entry.feature.set("expected_area_acres", snapshot.expectedArea);
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

  // Start/Stop toggle.
  selectBtn.addEventListener("click", async () => {
    if (!sessionActive) {
      startSession();
      return;
    }
    if (pendingEdits.size > 0) {
      const discard = await confirmDiscardChanges();
      if (!discard) return;
    }
    await stopSession({ restore: true });
  });

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

  saveBtn?.addEventListener("click", async () => {
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
            const areaAcres = feature.get("expected_area_acres");
            if (areaAcres != null) {
              await supabase.from("vsl_blocks").update({ expected_area_acres: areaAcres }).eq("id", id);
            }
          } else if (kind === "parcel") {
            const { error } = await supabase.rpc("vsl_update_parcel_geom", {
              p_parcel_id: id,
              p_geojson: geoJsonGeom,
              p_user_id: userId
            });
            if (error) throw error;
            const areaAcres = feature.get("expected_area_acres");
            if (areaAcres != null) {
              await supabase.from("vsl_parcels").update({ expected_area_acres: areaAcres }).eq("id", id);
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
    if (!sessionActive) return true;
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
    if (tabPanel.hidden && sessionActive) stopSession({ restore: true });
  });
  observer.observe(tabPanel, { attributes: true, attributeFilter: ["hidden"] });

  return {
    hasPendingEdits: () => pendingEdits.size > 0
  };
}
