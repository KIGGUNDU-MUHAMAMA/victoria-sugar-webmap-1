/**
 * Manage Features window (windows/manage-features-panel.html) — the list of
 * vsl_feature_type, opened from the pencil button next to the Survey
 * window's Draw tab Feature dropdown (js/survey-draw.js).
 *
 * This module is only the list: one tab per geometry kind, a row per type,
 * and add/delete. All editing happens in the separate Feature Type editor
 * window (js/feature-type-editor.js), reached through the global hook
 * window.openFeatureTypeEditor() — the form that used to sit underneath this
 * list is gone, because point/line/polygon each need a different set of
 * fields and cramming all three into one inline form made none of them
 * clear.
 *
 * Columns: Icon (a live swatch of how the type renders — the icon for a
 * point, its parallel strokes for a line, fill + outline for a polygon,
 * built by featureTypeSwatchHtml so the list, the editor preview and the
 * legend all agree), Type (name + numeric code), Labels (read-only: which
 * on-map labels are on — changed in the editor, not by clicking here), and
 * Actions.
 *
 * Codes are banded by kind — 1-99 point, 100-199 line, 200-299 polygon — and
 * assigned by the vsl_feature_type_set_code database trigger on insert.
 *
 * Exposes window.openManageFeaturesPanel() so survey-draw.js doesn't need a
 * direct import (keeps the two modules independently loadable, same pattern
 * as the other window.* hooks already in this app).
 */

import { confirmDanger } from "../popups/popup.js";
import { featureTypeSwatchHtml } from "./feature-type-editor.js";

const KIND_META = {
  point: { label: "Point", icon: "fa-location-dot" },
  line: { label: "Line", icon: "fa-slash" },
  polygon: { label: "Polygon", icon: "fa-draw-polygon" }
};

// Which on-map labels each kind can offer, in display order. Mirrors the
// editor's own list (and, behind it, the vsl_feature_type_display_params_max
// constraint) — here it only decides which chips the Labels column shows.
const LABEL_OPTIONS = { point: ["name"], line: ["name", "length"], polygon: ["name", "area"] };
const DISPLAY_PARAM_LABELS = { name: "Name", area: "Area", length: "Dist" };

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function initManageFeatures({ cfg, supabase, setStatus, statusEl }) {
  const overlay = document.getElementById("manageFeaturesModal");
  const closeBtn = document.getElementById("manageFeaturesCloseBtn");
  const tabsEl = document.getElementById("mfTabs");
  const listEl = document.getElementById("mfList");
  const listError = document.getElementById("mfListError");
  const addBtn = document.getElementById("mfAddBtn");

  if (!overlay || !listEl) return null;

  // Only the active tab's kind is held here — switching tabs refetches.
  let activeKind = "point";
  let rows = [];
  // vsl_feature_type id -> how many drawn features use it. Drives the
  // "can't delete a type that's still in use" guard below.
  let featureCounts = new Map();

  function restHeaders() {
    return {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
      Accept: "application/json"
    };
  }

  function showListError(msg) {
    if (!listError) return;
    listError.textContent = msg || "";
    listError.hidden = !msg;
  }

  async function fetchRows(kind) {
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_feature_type?select=*&geometry_kind=eq.${encodeURIComponent(kind)}&order=code.asc`;
      const res = await fetch(url, { headers: restHeaders() });
      if (!res.ok) throw new Error("Failed to load feature types");
      rows = await res.json();
    } catch (e) {
      console.error("[Victoria Survey] Error fetching feature types:", e);
      rows = [];
      showListError("Couldn't load feature types.");
    }
  }

  // One flat read tallied client-side — same shape as manage-estates.js's
  // block counts, and cheap enough to run on every refresh.
  async function fetchFeatureCounts() {
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_feature?select=feature_type_id`;
      const res = await fetch(url, { headers: restHeaders() });
      if (!res.ok) throw new Error("Failed to load feature counts");
      const data = await res.json();
      const map = new Map();
      for (const row of data) {
        if (row.feature_type_id == null) continue;
        map.set(row.feature_type_id, (map.get(row.feature_type_id) || 0) + 1);
      }
      featureCounts = map;
    } catch (e) {
      console.error("[Victoria Survey] Error fetching feature counts:", e);
      featureCounts = new Map();
    }
  }

  // Authoritative, right-now count for one type — the tally above can be
  // stale if someone else drew a feature since this window last refreshed,
  // and deleting a type out from under real features would break them.
  // PostgREST returns the total in Content-Range when asked for an exact
  // count, so this stays a single small request.
  async function fetchLiveFeatureCount(typeId) {
    const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_feature?select=id&feature_type_id=eq.${encodeURIComponent(typeId)}&limit=1`;
    const res = await fetch(url, { headers: { ...restHeaders(), Prefer: "count=exact" } });
    if (!res.ok) throw new Error("Couldn't check whether this feature type is in use.");
    const range = res.headers.get("content-range") || "";
    const total = Number(range.split("/")[1]);
    return Number.isFinite(total) ? total : null;
  }

  // The Labels cell: every label this kind can show, with the ones actually
  // switched on highlighted. Deliberately inert — no hover state, no click
  // handler — so the column reads as a status readout of display_params.
  // Changing it happens in the editor window.
  function labelChipsHtml(r) {
    const params = Array.isArray(r.display_params) ? r.display_params : [];
    const options = LABEL_OPTIONS[r.geometry_kind] || [];
    if (!options.length) return "";
    return options
      .map((p) => {
        const on = params.includes(p);
        return `<span class="mf-label-tag${on ? " mf-label-tag--on" : ""}">${DISPLAY_PARAM_LABELS[p]}</span>`;
      })
      .join("");
  }

  function rowHtml(r) {
    const inUse = featureCounts.get(r.id) || 0;
    return `
      <div class="mf-trow" data-id="${r.id}">
        <span class="mf-trow__icon">${featureTypeSwatchHtml(r)}</span>
        <span class="mf-trow__type">
          <span class="mf-trow__name">
            ${escapeHtml(r.name)}
            ${r.is_active === false ? '<span class="mf-trow__badge">Hidden</span>' : ""}
          </span>
          <span class="mf-trow__code">Code ${escapeHtml(r.code ?? "—")}${inUse ? ` · ${inUse} drawn` : ""}</span>
        </span>
        <span class="mf-trow__labels">${labelChipsHtml(r)}</span>
        <span class="mf-trow__actions">
          <button type="button" class="mf-trow__btn" data-edit="${r.id}" aria-label="Edit ${escapeHtml(r.name)}">
            <i class="fas fa-pen" aria-hidden="true"></i>
          </button>
          <button type="button" class="mf-trow__btn mf-trow__btn--danger" data-delete="${r.id}" aria-label="Delete ${escapeHtml(r.name)}">
            <i class="fas fa-trash" aria-hidden="true"></i>
          </button>
        </span>
      </div>`;
  }

  function renderList() {
    const meta = KIND_META[activeKind];
    listEl.innerHTML = rows.length
      ? rows.map(rowHtml).join("")
      : `<p class="mf-list-empty">No ${meta.label.toLowerCase()} features yet.</p>`;
  }

  function setActiveKind(kind) {
    if (!KIND_META[kind]) return;
    activeKind = kind;
    tabsEl?.querySelectorAll("[data-kind]").forEach((btn) => {
      btn.setAttribute("aria-selected", String(btn.dataset.kind === kind));
    });
  }

  // Refetches this kind's rows plus the in-use counts — called on open, on
  // tab switch, and after the editor saves or a row is deleted.
  async function refreshList() {
    showListError("");
    await Promise.all([fetchRows(activeKind), fetchFeatureCounts()]);
    renderList();
  }

  tabsEl?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-kind]");
    if (!btn || btn.dataset.kind === activeKind) return;
    setActiveKind(btn.dataset.kind);
    refreshList();
  });

  // Both entry points into the editor window. onSaved lands the list on the
  // kind that was just saved, which for a new type may not be the open tab.
  function openEditor(row) {
    window.openFeatureTypeEditor?.(row, {
      kind: activeKind,
      onSaved: async (savedKind) => {
        setActiveKind(savedKind || activeKind);
        await refreshList();
      }
    });
  }

  addBtn?.addEventListener("click", () => openEditor(null));

  async function deleteFeatureType(row) {
    showListError("");
    // A feature type that still has features drawn with it can't go — those
    // features would lose the row that gives them their icon, color and
    // labels (and the FK would refuse the delete anyway). Checked live
    // rather than from the cached tally, in case someone drew one just now.
    let inUse = featureCounts.get(row.id) || 0;
    try {
      const live = await fetchLiveFeatureCount(row.id);
      if (live != null) inUse = live;
    } catch (e) {
      console.error("[Victoria Survey] Feature count check failed:", e);
      showListError(e.message);
      return;
    }
    if (inUse > 0) {
      await confirmDanger({
        title: "Can't Delete Feature Type",
        message: `"${row.name}" is used by ${inUse} drawn feature${inUse === 1 ? "" : "s"}. Delete or re-type ${inUse === 1 ? "it" : "them"} on the map first.`
      });
      return;
    }

    const confirmed = await confirmDanger({
      title: "Delete Feature Type",
      message: `Delete "${row.name}" (code ${row.code})? It will disappear from the Draw tab list. This can't be undone.`,
      confirmLabel: "Delete"
    });
    if (!confirmed) return;

    try {
      const { error } = await supabase.from("vsl_feature_type").delete().eq("id", row.id);
      if (error) throw error;
      await refreshList();
      window.dispatchEvent(new CustomEvent("vsl-feature-types-changed"));
      setStatus?.(statusEl, `Feature type "${row.name}" deleted.`);
    } catch (err) {
      console.error("[Victoria Survey] Failed to delete feature type:", err);
      showListError(
        /foreign key|violates/i.test(err.message)
          ? "This feature type is still used by drawn features — remove those first."
          : err.message
      );
    }
  }

  listEl.addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit]");
    if (editBtn) {
      const row = rows.find((r) => String(r.id) === editBtn.dataset.edit);
      if (row) openEditor(row);
      return;
    }
    const delBtn = e.target.closest("[data-delete]");
    if (delBtn) {
      const row = rows.find((r) => String(r.id) === delBtn.dataset.delete);
      if (row) deleteFeatureType(row);
    }
  });

  async function open() {
    overlay.hidden = false;
    await refreshList();
  }
  function close() {
    overlay.hidden = true;
  }

  closeBtn?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  window.openManageFeaturesPanel = open;

  return { open, close, refresh: refreshList };
}
