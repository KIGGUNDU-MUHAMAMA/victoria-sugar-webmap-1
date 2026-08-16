/**
 * Feature Type editor window (windows/feature-type-editor.html).
 *
 * Opened from the Manage Features window's edit pencil / Add Feature button
 * — it replaced the form that used to sit underneath that list. One window
 * serves all three geometry kinds, showing only the fields that kind
 * actually has:
 *
 *   point   — icon (picked from the SVG library), color, icon size, rotation
 *   line    — line type, line style, default width, color, label direction
 *   polygon — line type, color
 *
 * plus a name and a framed Labels group whose checkboxes vary by kind
 * (Name for point; Name/Length for line; Name/Area for polygon — matching
 * the vsl_feature_type_display_params_max constraint, which caps non-polygon
 * kinds at one label and polygon at two).
 *
 * Exposes window.openFeatureTypeEditor(row | null) so manage-features.js can
 * open it without importing this module directly — same window.* hook
 * pattern used between survey-draw.js and manage-features.js.
 */

// Kept in sync with the DB's vsl_feature_type_code_band CHECK and the
// vsl_feature_type_assign_code() trigger. Only used to preview the code a
// new type will get; the database still assigns the real one.
const CODE_BANDS = {
  point: { min: 1, max: 99 },
  line: { min: 100, max: 199 },
  polygon: { min: 200, max: 299 }
};

// Which on-map labels each kind can offer.
const LABEL_OPTIONS = { point: ["name"], line: ["name", "length"], polygon: ["name", "area"] };
const LABEL_NAMES = { name: "Name", length: "Length", area: "Area" };
// point/line are capped at one label by the DB constraint; polygon allows two.
const LABELS_EXCLUSIVE = { point: true, line: true, polygon: false };

const ICON_MANIFEST_URL = "./icons/icons.json";
const ICON_DIR = "./icons";

/** Nominal scale for drawing line_spacing_m in a swatch, which has no map
 *  resolution to work from. Purely so the preview responds to the number —
 *  on the map and in the PDF the spacing is true ground metres. */
const SWATCH_PX_PER_M = 1.2;

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/** CSS dash pattern for a line type, as used by both the preview swatches
 *  here and the feature list's. "none" has no stroke at all. */
export function dashArrayFor(linetype, weight) {
  const w = Math.max(1, Number(weight) || 2);
  if (linetype === "dashed") return `${w * 3} ${w * 2}`;
  if (linetype === "dotted") return `${w} ${w * 2}`;
  return "";
}

/**
 * The shared swatch: an inline SVG showing exactly what a feature type looks
 * like on the map. Used by this editor's live preview and by the Manage
 * Features list's first column, so the two can't drift apart.
 *
 * point   — the icon's SVG file on a color chip
 * line    — one/two/three parallel strokes in the type's color and dash
 * polygon — a filled rectangle with the type's outline
 */
export function featureTypeSwatchHtml(row, { width = 34, height = 26 } = {}) {
  const color = row.color || "#3f8f3f";
  const kind = row.geometry_kind;

  if (kind === "point") {
    const icon = row.icon || "fa-circle-dot";
    return `
      <span class="fts fts--point" style="background:${escapeHtml(color)}">
        <img src="${ICON_DIR}/${encodeURIComponent(icon)}.svg" alt="" aria-hidden="true">
      </span>`;
  }

  const weight = Math.max(1, Number(row.line_weight) || 2);
  const linetype = row.linetype || "solid";
  const dash = dashArrayFor(linetype, weight);
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : "";

  if (kind === "line") {
    if (linetype === "none") {
      return `<span class="fts fts--empty" title="No line">—</span>`;
    }
    // Parallel strokes for double/triple. The swatch isn't a map, so the
    // metre spacing can't be shown at true scale — it's drawn at a nominal
    // px-per-metre and clamped, so changing the number visibly changes the
    // preview without a wide road bursting out of a 26px-tall box.
    const count = row.line_style === "triple" ? 3 : row.line_style === "double" ? 2 : 1;
    const spacingM = Number(row.line_spacing_m) || 3;
    const gap = Math.max(weight, Math.min(SWATCH_PX_PER_M * spacingM, (height - weight * count) / 2));
    const step = gap + weight;
    const mid = height / 2;
    const offsets = count === 1 ? [0] : count === 2 ? [-step / 2, step / 2] : [-step, 0, step];
    const lines = offsets
      .map((o, i) => {
        // Triple lines have a dotted centre — the convention for a road
        // centreline, and what the map and the PDF both draw.
        const isCentre = count === 3 && i === 1;
        const strokeDash = isCentre ? dashArrayFor("dotted", weight) : dash;
        const attr = strokeDash ? ` stroke-dasharray="${strokeDash}"` : "";
        return `<line x1="2" y1="${mid + o}" x2="${width - 2}" y2="${mid + o}" stroke="${escapeHtml(color)}" stroke-width="${weight}"${attr} stroke-linecap="butt"/>`;
      })
      .join("");
    return `<span class="fts"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${lines}</svg></span>`;
  }

  // Polygon — fill at the same 18% alpha the map layer uses.
  const strokeAttr =
    linetype === "none"
      ? ""
      : `stroke="${escapeHtml(color)}" stroke-width="${weight}"${dashAttr}`;
  return `<span class="fts"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
      <rect x="3" y="4" width="${width - 6}" height="${height - 8}" rx="2"
            fill="${escapeHtml(color)}" fill-opacity="0.18" ${strokeAttr}/>
    </svg></span>`;
}

export function initFeatureTypeEditor({ cfg, supabase, setStatus, statusEl }) {
  const overlay = document.getElementById("featureTypeEditorModal");
  if (!overlay) return null;

  const titleEl = document.getElementById("fteTitle");
  const form = document.getElementById("fteForm");
  const idInput = document.getElementById("fteId");
  const nameInput = document.getElementById("fteName");
  const codeInput = document.getElementById("fteCode");
  const kindRow = document.getElementById("fteKindRow");
  const kindSelect = document.getElementById("fteKind");

  const pointBox = document.getElementById("ftedPoint");
  const iconPreview = document.getElementById("fteIconPreview");
  const iconPickBtn = document.getElementById("fteIconPickBtn");
  const iconInput = document.getElementById("fteIcon");
  const iconSizeInput = document.getElementById("fteIconSize");
  const rotationInput = document.getElementById("fteRotation");

  const lineBox = document.getElementById("ftedLine");
  const linetypeSelect = document.getElementById("fteLinetype");
  const lineStyleSelect = document.getElementById("fteLineStyle");
  const widthInput = document.getElementById("fteWidth");
  const spacingInput = document.getElementById("fteSpacing");

  const polygonBox = document.getElementById("ftedPolygon");
  const polyLinetypeSelect = document.getElementById("ftePolyLinetype");
  const polyWidthInput = document.getElementById("ftePolyWidth");

  const colorInput = document.getElementById("fteColor");
  const previewEl = document.getElementById("ftePreview");

  const labelOptionsEl = document.getElementById("fteLabelOptions");
  const labelDirRow = document.getElementById("fteLabelDirRow");
  const labelDirHorizontal = document.getElementById("fteLabelDirHorizontal");
  const labelDirAlong = document.getElementById("fteLabelDirAlong");

  const errorEl = document.getElementById("fteError");
  const closeBtn = document.getElementById("fteCloseBtn");
  const cancelBtn = document.getElementById("fteCancelBtn");

  const pickerOverlay = document.getElementById("iconPickerModal");
  const pickerGrid = document.getElementById("iconPickerGrid");
  const pickerSearch = document.getElementById("iconPickerSearch");
  const pickerError = document.getElementById("iconPickerError");
  const pickerCloseBtn = document.getElementById("iconPickerCloseBtn");

  let editingId = null;
  let editingRow = null;
  let onSaved = null;
  let iconLibrary = null; // lazily loaded from icons/icons.json

  function restHeaders() {
    return {
      apikey: cfg.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${cfg.SUPABASE_ANON_KEY}`,
      Accept: "application/json"
    };
  }

  function setError(msg) {
    errorEl.textContent = msg || "";
    errorEl.hidden = !msg;
  }

  // ── Icon picker ──────────────────────────────────────────────────────
  // The browser can't list a directory, so the library is whatever
  // icons/icons.json says it is. Adding an icon = drop the SVG in /icons
  // and add its name to that file.
  async function loadIconLibrary() {
    if (iconLibrary) return iconLibrary;
    try {
      const res = await fetch(ICON_MANIFEST_URL, { cache: "no-cache" });
      if (!res.ok) throw new Error(`icons.json (${res.status})`);
      const data = await res.json();
      iconLibrary = Array.isArray(data) ? data : Array.isArray(data?.icons) ? data.icons : [];
    } catch (e) {
      console.error("[Victoria Survey] Couldn't load the icon library:", e);
      iconLibrary = [];
    }
    return iconLibrary;
  }

  function renderIconGrid(filterText) {
    const q = (filterText || "").trim().toLowerCase();
    const list = (iconLibrary || []).filter((name) =>
      q ? name.replace(/^fa-/, "").includes(q) : true
    );
    if (!list.length) {
      pickerGrid.innerHTML = "";
      pickerError.textContent = (iconLibrary || []).length
        ? "No icons match that search."
        : "No icons found — check icons/icons.json.";
      pickerError.hidden = false;
      return;
    }
    pickerError.hidden = true;
    pickerGrid.innerHTML = list
      .map(
        (name) => `
        <button type="button" class="fte-icon-grid__btn${name === iconInput.value ? " fte-icon-grid__btn--active" : ""}"
                data-icon="${escapeHtml(name)}" title="${escapeHtml(name)}" role="option"
                aria-selected="${name === iconInput.value}">
          <img src="${ICON_DIR}/${encodeURIComponent(name)}.svg" alt="${escapeHtml(name)}" loading="lazy">
        </button>`
      )
      .join("");
  }

  function setIcon(name) {
    iconInput.value = name || "";
    iconPreview.innerHTML = name
      ? `<img src="${ICON_DIR}/${encodeURIComponent(name)}.svg" alt="">`
      : "";
    renderPreview();
  }

  async function openIconPicker() {
    await loadIconLibrary();
    pickerSearch.value = "";
    renderIconGrid("");
    pickerOverlay.hidden = false;
    pickerSearch.focus();
  }
  function closeIconPicker() {
    pickerOverlay.hidden = true;
  }

  iconPickBtn?.addEventListener("click", openIconPicker);
  pickerCloseBtn?.addEventListener("click", closeIconPicker);
  pickerOverlay?.addEventListener("click", (e) => {
    if (e.target === pickerOverlay) closeIconPicker();
  });
  pickerSearch?.addEventListener("input", () => renderIconGrid(pickerSearch.value));
  pickerGrid?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-icon]");
    if (!btn) return;
    setIcon(btn.dataset.icon);
    closeIconPicker();
  });

  // ── Form state ───────────────────────────────────────────────────────
  function currentKind() {
    return kindSelect.value;
  }

  // ── Labels ───────────────────────────────────────────────────────────
  // Point and line can only ever show one label (the
  // vsl_feature_type_display_params_max constraint caps them at 1), so they
  // get radios plus a None to switch labelling off — a set of checkboxes
  // where ticking one silently unticks another reads like a bug. Polygon's
  // cap is 2 and Name + Area are genuinely combinable, so it keeps
  // checkboxes.
  function renderLabelOptions(kind, selected) {
    const opts = LABEL_OPTIONS[kind] || [];
    const exclusive = LABELS_EXCLUSIVE[kind];
    const rows = [];
    if (exclusive) {
      const none = !opts.some((p) => selected.includes(p));
      rows.push(`
        <label class="mf-checkbox-row">
          <input type="radio" name="fteLabel" value="" ${none ? "checked" : ""}>
          <span>None</span>
        </label>`);
    }
    for (const p of opts) {
      const on = selected.includes(p);
      rows.push(`
        <label class="mf-checkbox-row">
          <input type="${exclusive ? "radio" : "checkbox"}" name="fteLabel" value="${p}" ${on ? "checked" : ""}>
          <span>${LABEL_NAMES[p]}</span>
        </label>`);
    }
    labelOptionsEl.innerHTML = rows.join("");
  }

  function readLabelOptions() {
    return [...labelOptionsEl.querySelectorAll("input:checked")]
      .map((el) => el.value)
      .filter(Boolean);
  }

  /** The row as the form currently describes it — used for the live preview
   *  and as the basis of the save payload. */
  function readForm() {
    const kind = currentKind();
    const displayParams = readLabelOptions();

    return {
      name: nameInput.value.trim(),
      geometry_kind: kind,
      color: colorInput.value,
      icon: kind === "point" ? iconInput.value || null : null,
      icon_size: kind === "point" ? Number(iconSizeInput.value) || 10 : 10,
      icon_rotation: kind === "point" ? Number(rotationInput.value) || 0 : 0,
      linetype:
        kind === "line" ? linetypeSelect.value : kind === "polygon" ? polyLinetypeSelect.value : null,
      line_style: kind === "line" ? lineStyleSelect.value : "single",
      // Stroke thickness in screen pixels — line and polygon each have their
      // own input; a point has no stroke, so it keeps the column's default.
      line_weight:
        kind === "line"
          ? Number(widthInput.value) || 2
          : kind === "polygon"
            ? Number(polyWidthInput.value) || 2
            : Number(editingRow?.line_weight) || 2,
      // Ground metres between parallel strokes. Only a double/triple line
      // uses it, but it's kept on the row either way so switching styles
      // back and forth doesn't lose the number.
      line_spacing_m: kind === "line" ? Number(spacingInput.value) || 3 : Number(editingRow?.line_spacing_m) || 3,
      display_params: displayParams,
      label_direction: kind === "line" && labelDirAlong.checked ? "along" : "horizontal"
      // is_active is deliberately not in here — there's no control for it any
      // more, so new rows take the column's `true` default and existing rows
      // keep whatever they had.
    };
  }

  function renderPreview() {
    if (!previewEl) return;
    previewEl.innerHTML = featureTypeSwatchHtml(readForm(), { width: 90, height: 34 });
  }

  /** Shows the field set for `kind` and hides the other two. */
  function applyKind(kind) {
    pointBox.hidden = kind !== "point";
    lineBox.hidden = kind !== "line";
    polygonBox.hidden = kind !== "polygon";

    // Carry across whatever is currently ticked — switching kind on a new
    // type shouldn't silently drop a label the new kind also supports.
    renderLabelOptions(kind, readLabelOptions());

    // Direction only means anything for a line label.
    labelDirRow.hidden = kind !== "line";

    applySpacingState();
    if (!editingId) updateCodePreview(kind);
    renderPreview();
  }

  // Spacing describes the gap between parallel strokes, so it means nothing
  // for a single line — greyed rather than hidden, so it's clear the setting
  // exists and what unlocks it.
  function applySpacingState() {
    const usesSpacing = currentKind() === "line" && lineStyleSelect.value !== "single";
    spacingInput.disabled = !usesSpacing;
    spacingInput.title = usesSpacing
      ? "Ground distance between the parallel lines"
      : "Only used by double and triple lines";
  }

  async function updateCodePreview(kind) {
    const band = CODE_BANDS[kind];
    if (!band || !codeInput) return;
    codeInput.value = "…";
    try {
      const url = `${cfg.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/vsl_feature_type?select=code&geometry_kind=eq.${encodeURIComponent(kind)}&order=code.desc&limit=1`;
      const res = await fetch(url, { headers: restHeaders() });
      if (!res.ok) throw new Error("code lookup failed");
      const rows = await res.json();
      const last = Number(rows?.[0]?.code);
      const next = Number.isFinite(last) ? last + 1 : band.min;
      codeInput.value = next > band.max ? "band full" : String(next);
    } catch (e) {
      console.error("[Victoria Survey] Couldn't preview the next code:", e);
      codeInput.value = "auto";
    }
  }

  kindSelect.addEventListener("change", () => applyKind(currentKind()));
  lineStyleSelect.addEventListener("change", applySpacingState);
  [
    colorInput, linetypeSelect, lineStyleSelect, widthInput, spacingInput,
    polyLinetypeSelect, polyWidthInput, iconSizeInput
  ].forEach((el) => el?.addEventListener("input", renderPreview));

  // ── Open / close ─────────────────────────────────────────────────────
  /**
   * @param {object|null} row      existing vsl_feature_type row, or null to create
   * @param {object}      options  { kind } seeds the geometry for a new type
   *                               (the Manage Features tab that was open),
   *                               { onSaved } runs after a successful write
   */
  function open(row, options = {}) {
    setError("");
    editingId = row?.id ?? null;
    editingRow = row || null;
    onSaved = options.onSaved || null;

    idInput.value = row?.id ?? "";
    titleEl.textContent = row ? `Edit ${row.name}` : "New Feature Type";
    nameInput.value = row?.name ?? "";
    // Geometry is fixed once a type exists: it decides the code band and how
    // every already-drawn feature of this type is rendered.
    kindSelect.value = row?.geometry_kind ?? options.kind ?? "point";
    kindSelect.disabled = !!row;
    kindRow.hidden = !!row;
    codeInput.value = row?.code != null ? String(row.code) : "";

    setIcon(row?.icon ?? "fa-circle-dot");
    iconSizeInput.value = row?.icon_size ?? 10;
    rotationInput.value = row?.icon_rotation ?? 0;

    const linetype = row?.linetype ?? "solid";
    linetypeSelect.value = linetype;
    polyLinetypeSelect.value = linetype;
    lineStyleSelect.value = row?.line_style ?? "single";
    widthInput.value = row?.line_weight ?? 2;
    polyWidthInput.value = row?.line_weight ?? 2;
    spacingInput.value = row?.line_spacing_m ?? 3;
    colorInput.value = row?.color ?? "#3f8f3f";

    const dp = Array.isArray(row?.display_params) ? row.display_params : [];
    renderLabelOptions(kindSelect.value, dp);

    if ((row?.label_direction ?? "horizontal") === "along") labelDirAlong.checked = true;
    else labelDirHorizontal.checked = true;

    // A protected row (is_system) keeps its name — nothing ships as one
    // today, but the flag is still honoured.
    nameInput.disabled = !!row?.is_system;

    applyKind(kindSelect.value);
    overlay.hidden = false;
    nameInput.focus();
  }

  function close() {
    closeIconPicker();
    overlay.hidden = true;
  }

  closeBtn?.addEventListener("click", close);
  cancelBtn?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    setError("");
    const payload = readForm();
    if (!payload.name) {
      setError("Type name is required.");
      nameInput.focus();
      return;
    }
    if (payload.geometry_kind === "point" && !payload.icon) {
      setError("Choose an icon for this point type.");
      return;
    }

    try {
      let error;
      if (editingId) {
        // geometry_kind and code are immutable on an existing type.
        const { geometry_kind, ...updatable } = payload;
        ({ error } = await supabase.from("vsl_feature_type").update(updatable).eq("id", editingId));
      } else {
        // code is left out on purpose — the vsl_feature_type_set_code
        // trigger assigns the next free one in the kind's band.
        ({ error } = await supabase.from("vsl_feature_type").insert(payload));
      }
      if (error) throw error;

      close();
      window.dispatchEvent(new CustomEvent("vsl-feature-types-changed"));
      window.dispatchEvent(new CustomEvent("vsl-features-changed"));
      setStatus?.(statusEl, editingId ? "Feature type updated." : "Feature type added.");
      await onSaved?.(payload.geometry_kind);
    } catch (err) {
      console.error("[Victoria Survey] Failed to save feature type:", err);
      setError(
        /duplicate key/i.test(err.message)
          ? "Another feature type of this geometry already uses that name."
          : err.message
      );
    }
  });

  window.openFeatureTypeEditor = open;

  return { open, close };
}
