/**
 * Survey "Edit" tab — select a Plot, Block, or drawn feature on the map and
 * drag its nodes to reshape it, then Save writes the new geometry back to
 * the right table (vsl_parcels / vsl_blocks / vsl_feature).
 */

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
  refreshEstateBoundaries
}) {
  const selectBtn = document.getElementById("editSelectFeatureBtn");
  const infoEl = document.getElementById("editSelectedInfo");
  const feedbackEl = document.getElementById("editToolsFeedback");
  const saveBtn = document.getElementById("editSaveBtn");
  const cancelBtn = document.getElementById("editCancelBtn");
  const tabPanel = document.getElementById("uamTabEdit");

  if (!selectBtn || !tabPanel) return null;

  function feedback(msg, isError) {
    if (feedbackEl) {
      feedbackEl.textContent = msg || "";
      feedbackEl.classList.toggle("draw-tools__feedback--error", !!isError);
    }
    if (msg) setStatus?.(statusEl, msg, isError);
  }

  function showInfo(text) {
    if (!infoEl) return;
    infoEl.hidden = !text;
    infoEl.textContent = text || "";
  }

  let selectInteraction = null;
  let modifyInteraction = null;
  let selectedFeature = null;
  let selectedKind = null; // "block" | "parcel" | "feature"
  let originalGeom = null;

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

  function stopSelectMode() {
    if (selectInteraction) {
      map.removeInteraction(selectInteraction);
      selectInteraction = null;
    }
    selectBtn.classList.remove("uam-btn--active");
  }

  function stopEditing({ restore } = {}) {
    if (modifyInteraction) {
      map.removeInteraction(modifyInteraction);
      modifyInteraction = null;
    }
    if (restore && selectedFeature && originalGeom) {
      selectedFeature.setGeometry(originalGeom.clone());
    }
    selectedFeature = null;
    selectedKind = null;
    originalGeom = null;
    saveBtn.disabled = true;
    showInfo("");
  }

  function fullReset({ restore } = {}) {
    stopSelectMode();
    stopEditing({ restore });
    feedback("", false);
  }

  // Auto-cancel if the user switches away from the Edit tab mid-session.
  const observer = new MutationObserver(() => {
    if (tabPanel.hidden) fullReset({ restore: true });
  });
  observer.observe(tabPanel, { attributes: true, attributeFilter: ["hidden"] });

  selectBtn.addEventListener("click", () => {
    if (selectInteraction) {
      stopSelectMode();
      feedback("", false);
      return;
    }
    stopEditing({ restore: true });

    const layers = [blocksLayer, parcelsLayer, getFeaturesLayer?.()].filter(Boolean);
    selectInteraction = new ol.interaction.Select({ layers });
    map.addInteraction(selectInteraction);
    selectBtn.classList.add("uam-btn--active");
    feedback("Click a plot, block, or feature on the map…", false);

    selectInteraction.on("select", (evt) => {
      const feature = evt.selected?.[0];
      if (!feature) return;
      const kind = sourceKindFor(feature);
      if (!kind) {
        feedback("That feature can't be edited here.", true);
        selectInteraction.getFeatures().clear();
        return;
      }
      stopSelectMode();
      selectedFeature = feature;
      selectedKind = kind;
      originalGeom = feature.getGeometry().clone();

      modifyInteraction = new ol.interaction.Modify({
        features: new ol.Collection([feature])
      });
      map.addInteraction(modifyInteraction);

      showInfo(`Editing: ${labelFor(feature, kind)}. Drag its nodes, then Save.`);
      feedback("", false);
      saveBtn.disabled = false;
    });
  });

  cancelBtn?.addEventListener("click", () => {
    fullReset({ restore: true });
  });

  saveBtn?.addEventListener("click", async () => {
    if (!selectedFeature || !selectedKind) return;
    if (!supabase) {
      feedback("Can't save — Supabase client not available.", true);
      return;
    }
    const gj = new ol.format.GeoJSON();
    const geoJsonGeom = gj.writeGeometryObject(selectedFeature.getGeometry(), {
      featureProjection: "EPSG:3857",
      dataProjection: "EPSG:4326"
    });

    try {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id ?? null;
      const id = selectedFeature.getId();

      if (selectedKind === "block") {
        const { error } = await supabase.rpc("vsl_update_block_geom", {
          p_block_id: id,
          p_geojson: geoJsonGeom,
          p_user_id: userId
        });
        if (error) throw error;
        await loadLayersFromDb?.();
        // Reshaping a block also moves its parent estate's bounding
        // envelope (recomputed by the same DB trigger CSV/Draw block saves
        // rely on) — refresh the map's estate-outline layer to match.
        await refreshEstateBoundaries?.();
      } else if (selectedKind === "parcel") {
        const { error } = await supabase.rpc("vsl_update_parcel_geom", {
          p_parcel_id: id,
          p_geojson: geoJsonGeom,
          p_user_id: userId
        });
        if (error) throw error;
        await loadLayersFromDb?.();
      } else {
        const { error } = await supabase.rpc("vsl_update_feature_geom", {
          p_feature_id: id,
          p_geojson: geoJsonGeom,
          p_user_id: userId
        });
        if (error) throw error;
        await refreshFeaturesLayer?.();
      }

      feedback("Saved.", false);
      fullReset();
    } catch (e) {
      console.error("[Victoria Survey] Edit save failed:", e);
      feedback(`Save failed: ${e.message}`, true);
    }
  });

  return { reset: () => fullReset({ restore: true }) };
}
