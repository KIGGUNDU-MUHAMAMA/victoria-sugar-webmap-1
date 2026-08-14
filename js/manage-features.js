/**
 * Manage Features modal (windows/manage-features-panel.html) — CRUD over
 * vsl_feature_type, opened from the pencil button next to the Survey
 * window's Draw tab Feature dropdown (js/survey-draw.js).
 *
 * List view: 3 collapsible <details> sections (Point/Line/Polygon), each a
 * compact row-per-feature table — same "narrow list, not a wide form-heavy
 * grid" idea as the Estates tab (js/manage-estates.js) — instead of the old
 * single wide flat list.
 *
 * Exposes window.openManageFeaturesPanel() so survey-draw.js doesn't need
 * a direct import (keeps the two modules independently loadable, same
 * pattern as the other window.* hooks already in this app).
 */

// A curated, known-good set of Font Awesome 6 Free solid icons — enough
// variety to cover most point/line/polygon features without needing an
// upload/asset pipeline. Anyone can still type to filter this grid.
const ICON_LIBRARY = [
  "fa-house", "fa-house-chimney", "fa-tree", "fa-leaf", "fa-seedling",
  "fa-droplet", "fa-water", "fa-database", "fa-gears", "fa-cloud-sun",
  "fa-sun", "fa-wind", "fa-fire", "fa-location-crosshairs", "fa-map-pin",
  "fa-flag", "fa-tower-broadcast", "fa-bolt", "fa-weight-scale",
  "fa-industry", "fa-warehouse", "fa-building", "fa-car-side",
  "fa-gas-pump", "fa-truck", "fa-tractor", "fa-door-open", "fa-road",
  "fa-shoe-prints", "fa-ruler", "fa-grip-lines", "fa-grip-lines-vertical",
  "fa-school", "fa-draw-polygon", "fa-vector-square", "fa-square-parking",
  "fa-mountain", "fa-dumpster", "fa-recycle", "fa-ban", "fa-cow",
  "fa-circle-dot", "fa-minus", "fa-camera", "fa-signal", "fa-wifi",
  "fa-person-digging", "fa-hammer", "fa-screwdriver-wrench", "fa-toolbox",
  "fa-triangle-exclamation"
];

const KIND_META = {
  point: { label: "Point", icon: "fa-location-dot" },
  line: { label: "Line", icon: "fa-slash" },
  polygon: { label: "Polygon", icon: "fa-draw-polygon" }
};
const KIND_ORDER = ["point", "line", "polygon"];

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function initManageFeatures({ cfg, supabase, setStatus, statusEl }) {
  const overlay = document.getElementById("manageFeaturesModal");
  const closeBtn = document.getElementById("manageFeaturesCloseBtn");
  const cancelBtn = document.getElementById("manageFeaturesCancelBtn");
  const sectionsEl = document.getElementById("mfSections");
  const addBtn = document.getElementById("mfAddBtn");
  const form = document.getElementById("mfForm");
  const editIdInput = document.getElementById("mfEditId");
  const nameInput = document.getElementById("mfNameInput");
  const kindSelect = document.getElementById("mfKindSelect");
  const pointParams = document.getElementById("mfPointParams");
  const iconSizeInput = document.getElementById("mfIconSizeInput");
  const rotationInput = document.getElementById("mfRotationInput");
  const linetypeRow = document.getElementById("mfLinetypeRow");
  const linetypeSelect = document.getElementById("mfLinetypeSelect");
  const weightInput = document.getElementById("mfWeightInput");
  const colorInput = document.getElementById("mfColorInput");
  const iconPreview = document.getElementById("mfIconPreview");
  const iconSearch = document.getElementById("mfIconSearch");
  const iconGrid = document.getElementById("mfIconGrid");
  const iconInput = document.getElementById("mfIconInput");
  const displayNameCb = document.getElementById("mfDisplayNameCb");
  const displayAreaRow = document.getElementById("mfDisplayAreaRow");
  const displayAreaCb = document.getElementById("mfDisplayAreaCb");
  const displayLengthRow = document.getElementById("mfDisplayLengthRow");
  const displayLengthCb = document.getElementById("mfDisplayLengthCb");
  const activeCb = document.getElementById("mfActiveCb");
  const formError = document.getElementById("mfFormError");
  const listActions = document.getElementById("mfListActions");
  const formActions = document.getElementById("mfFormActions");
  const formCancelBtn = document.getElementById("mfFormCancelBtn");
  const deleteBtn = document.getElementById("mfDeleteBtn");

  if (!overlay) return null;

  let rows = [];

  function restHeaders() {
    return {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
      Accept: "application/json"
    };
  }

  async function fetchRows() {
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_feature_type?select=*&order=geometry_kind.asc,sort_order.asc`;
      const res = await fetch(url, { headers: restHeaders() });
      if (!res.ok) throw new Error("Failed to load feature types");
      rows = await res.json();
    } catch (e) {
      console.error("[Victoria Survey] Error fetching feature types:", e);
      rows = [];
    }
  }

  const DISPLAY_PARAM_LABELS = { name: "Name", area: "Area", length: "Length" };
  function displayBadges(r) {
    const params = Array.isArray(r.display_params) ? r.display_params : [];
    if (!params.length) return '<span class="mf-row__display-badge mf-row__display-badge--none">Off</span>';
    return params.map((p) => `<span class="mf-row__display-badge">${DISPLAY_PARAM_LABELS[p] || p}</span>`).join("");
  }

  function rowHtml(r) {
    return `
      <div class="mf-row" data-id="${r.id}">
        <span class="mf-row__swatch" style="background:${escapeHtml(r.color || "#3f8f3f")}">
          <i class="fas ${escapeHtml(r.icon || "fa-circle-dot")}" aria-hidden="true"></i>
        </span>
        <span class="mf-row__name">
          ${escapeHtml(r.name)}
          ${r.is_system ? '<span class="mf-row__badge">System</span>' : ""}
        </span>
        <span class="mf-row__display">${displayBadges(r)}</span>
        <button type="button" class="mf-row__edit" data-edit="${r.id}" aria-label="Edit ${escapeHtml(r.name)}">
          <i class="fas fa-pen" aria-hidden="true"></i>
        </button>
      </div>`;
  }

  function renderSections() {
    sectionsEl.innerHTML = KIND_ORDER.map((kind) => {
      const items = rows.filter((r) => r.geometry_kind === kind);
      const meta = KIND_META[kind];
      return `
        <details class="mf-section" open>
          <summary class="mf-section__head">
            <i class="fas ${meta.icon}" aria-hidden="true"></i>
            <span class="mf-section__label">${meta.label}</span>
            <span class="mf-section__count">${items.length}</span>
            <i class="fas fa-chevron-down mf-section__chevron" aria-hidden="true"></i>
          </summary>
          <div class="mf-section__body">
            ${items.length ? items.map(rowHtml).join("") : '<p class="mf-list-empty">No features yet.</p>'}
          </div>
        </details>`;
    }).join("");
  }

  function renderIconGrid(filterText) {
    const q = (filterText || "").trim().toLowerCase();
    const list = q ? ICON_LIBRARY.filter((i) => i.replace("fa-", "").includes(q)) : ICON_LIBRARY;
    iconGrid.innerHTML = list
      .map(
        (i) =>
          `<button type="button" class="mf-icon-grid__btn${i === iconInput.value ? " mf-icon-grid__btn--active" : ""}" data-icon="${i}" title="${i}">
            <i class="fas ${i}" aria-hidden="true"></i>
          </button>`
      )
      .join("");
  }

  iconGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-icon]");
    if (!btn) return;
    iconInput.value = btn.dataset.icon;
    iconPreview.innerHTML = `<i class="fas ${btn.dataset.icon}" aria-hidden="true"></i>`;
    renderIconGrid(iconSearch.value);
  });
  iconSearch.addEventListener("input", () => renderIconGrid(iconSearch.value));

  // Point/Line/Polygon each expose a different subset of params — see the
  // module doc comment and the vsl_feature_type_style_params migration.
  function updateKindVisibility() {
    const kind = kindSelect.value;
    pointParams.hidden = kind !== "point";
    linetypeRow.hidden = kind === "point";
    displayAreaRow.hidden = kind !== "polygon";
    displayLengthRow.hidden = kind !== "line";
    if (kind !== "polygon") displayAreaCb.checked = false;
    if (kind !== "line") displayLengthCb.checked = false;
  }
  kindSelect.addEventListener("change", updateKindVisibility);

  // Line is capped at 1 display param (vsl_feature_type_display_params_max),
  // and now has two options to choose from (Name/Length) instead of just
  // one — enforce that cap client-side by making them mutually exclusive,
  // only when Line is the current kind (Polygon's Name+Area can both be on).
  displayNameCb.addEventListener("change", () => {
    if (kindSelect.value === "line" && displayNameCb.checked) displayLengthCb.checked = false;
  });
  displayLengthCb.addEventListener("change", () => {
    if (displayLengthCb.checked) displayNameCb.checked = false;
  });

  function showList() {
    document.getElementById("mfListWrap").hidden = false;
    form.hidden = true;
    listActions.hidden = false;
    formActions.hidden = true;
    formError.hidden = true;
  }

  function showForm(row) {
    document.getElementById("mfListWrap").hidden = true;
    form.hidden = false;
    listActions.hidden = true;
    formActions.hidden = false;
    formError.hidden = true;

    editIdInput.value = row?.id ?? "";
    nameInput.value = row?.name ?? "";
    kindSelect.value = row?.geometry_kind ?? "point";
    // Changing geometry kind on an existing type would desync it from any
    // already-drawn instances (and, for Plot/Block, from the Draw tab's
    // special-cased routing) — only free on brand-new rows.
    kindSelect.disabled = !!row;

    linetypeSelect.value = row?.linetype ?? "solid";
    weightInput.value = row?.line_weight ?? 2;
    iconSizeInput.value = row?.icon_size ?? 10;
    rotationInput.value = row?.icon_rotation ?? 0;
    colorInput.value = row?.color ?? "#3f8f3f";
    iconInput.value = row?.icon ?? "fa-circle-dot";
    iconPreview.innerHTML = `<i class="fas ${iconInput.value}" aria-hidden="true"></i>`;
    iconSearch.value = "";

    const dp = Array.isArray(row?.display_params) ? row.display_params : [];
    displayNameCb.checked = dp.includes("name");
    displayAreaCb.checked = dp.includes("area");
    displayLengthCb.checked = dp.includes("length");

    activeCb.checked = row?.is_active !== false;
    updateKindVisibility();
    renderIconGrid("");

    const isSystem = !!row?.is_system;
    // Plot/Block are load-bearing (Draw tab checks code === 'plot'/'block'
    // and the name shows up in save-confirmation text) — lock name/kind,
    // still allow re-styling them and toggling active.
    nameInput.disabled = isSystem;
    deleteBtn.hidden = !row || isSystem;
  }

  addBtn.addEventListener("click", () => showForm(null));

  sectionsEl.addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit]");
    if (!editBtn) return;
    const row = rows.find((r) => String(r.id) === editBtn.dataset.edit);
    if (row) showForm(row);
  });

  formCancelBtn.addEventListener("click", showList);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError.hidden = true;
    const name = nameInput.value.trim();
    if (!name) {
      formError.textContent = "Name is required.";
      formError.hidden = false;
      return;
    }
    const editId = editIdInput.value;
    const kind = kindSelect.value;
    const displayParams = [];
    if (displayNameCb.checked) displayParams.push("name");
    if (kind === "polygon" && displayAreaCb.checked) displayParams.push("area");
    if (kind === "line" && displayLengthCb.checked) displayParams.push("length");

    const payload = {
      name,
      geometry_kind: kind,
      linetype: kind === "point" ? null : linetypeSelect.value,
      line_weight: kind === "point" ? 2 : (Number(weightInput.value) || 2),
      icon_size: kind === "point" ? (Number(iconSizeInput.value) || 10) : 10,
      icon_rotation: kind === "point" ? (Number(rotationInput.value) || 0) : 0,
      color: colorInput.value,
      icon: iconInput.value || null,
      display_params: displayParams,
      is_active: activeCb.checked
    };
    try {
      let error;
      if (editId) {
        ({ error } = await supabase.from("vsl_feature_type").update(payload).eq("id", editId));
      } else {
        ({ error } = await supabase.from("vsl_feature_type").insert(payload));
      }
      if (error) throw error;
      await fetchRows();
      renderSections();
      showList();
      window.dispatchEvent(new CustomEvent("vsl-feature-types-changed"));
      setStatus?.(statusEl, editId ? "Feature updated." : "Feature added.");
    } catch (err) {
      formError.textContent = err.message;
      formError.hidden = false;
    }
  });

  deleteBtn.addEventListener("click", async () => {
    const editId = editIdInput.value;
    if (!editId) return;
    if (!window.confirm("Delete this feature type? Features already drawn with it are unaffected, but it will disappear from the Draw tab list.")) {
      return;
    }
    try {
      const { error } = await supabase.from("vsl_feature_type").delete().eq("id", editId);
      if (error) throw error;
      await fetchRows();
      renderSections();
      showList();
      window.dispatchEvent(new CustomEvent("vsl-feature-types-changed"));
    } catch (err) {
      formError.textContent = err.message;
      formError.hidden = false;
    }
  });

  async function open() {
    overlay.hidden = false;
    await fetchRows();
    renderSections();
    showList();
  }
  function close() {
    overlay.hidden = true;
  }

  closeBtn?.addEventListener("click", close);
  cancelBtn?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  window.openManageFeaturesPanel = open;

  return { open, close };
}
