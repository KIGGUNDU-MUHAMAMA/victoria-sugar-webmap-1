/**
 * Shared confirm/prompt popup — one small, reusable dialog (popups/
 * popup.html shell + popups/popup.css) instead of every caller building
 * its own ad-hoc overlay/modal DOM from scratch with inline styles (the
 * old pattern across survey-import.js's promptForCrs/promptForStartingId
 * and manage-estates.js's promptEstateName/showDangerPopup).
 *
 * showPopup() is the single primitive; confirmDanger()/promptText()/
 * promptSelect() below are thin, common-case wrappers around it so most
 * call sites don't need to build the `buttons` array by hand.
 */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/**
 * @param {object} opts
 * @param {"default"|"danger"} [opts.theme="default"]
 * @param {string} [opts.icon] - Font Awesome class, e.g. "fa-trash". Defaults
 *   to fa-circle-info (default theme) / fa-triangle-exclamation (danger).
 * @param {string} [opts.title]
 * @param {string} [opts.message]
 * @param {{type:"text"|"select", value?:string, placeholder?:string, options?:{value:string,label:string}[]}} [opts.field]
 *   A single unlabelled field (estate name, CRS picker, starting-ID prompt).
 * @param {{key:string, label?:string, type?:"text"|"textarea"|"select", value?:string,
 *          placeholder?:string, required?:boolean, half?:boolean,
 *          disabled?:boolean,
 *          options?:{value:string,label:string}[]}[]} [opts.fields]
 *   Several labelled fields instead — used by the Select window's Modify
 *   action, which edits a couple of properties at once. A `readField`
 *   button then resolves with an OBJECT keyed by each field's `key`
 *   (rather than a bare string), and `required` is enforced per field.
 *   Ignored when `field` is given; the two are alternatives.
 * @param {{label:string, value?:*, variant?:"primary"|"danger"|"ghost", primary?:boolean, readField?:boolean, required?:boolean}[]} [opts.buttons]
 *   Defaults to a single "OK" button. `readField: true` resolves with the
 *   field's current value instead of `value`; `required: true` blocks the
 *   click (and refocuses the field) if it's empty. `primary: true` marks
 *   which button Enter triggers.
 * @returns {Promise<*>} resolves with whatever the clicked button resolves
 *   (or null on Escape/backdrop click/no popup shell loaded).
 */
export function showPopup({
  theme = "default",
  icon,
  title = "",
  message = "",
  field = null,
  fields = null,
  buttons = null
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("vslPopupOverlay");
    const card = document.getElementById("vslPopupCard");
    const iconEl = document.getElementById("vslPopupIcon");
    const titleEl = document.getElementById("vslPopupTitle");
    const messageEl = document.getElementById("vslPopupMessage");
    const fieldEl = document.getElementById("vslPopupField");
    const actionsEl = document.getElementById("vslPopupActions");

    if (!overlay || !card) {
      // popups/popup.html didn't load (shouldn't happen — see app-boot.js)
      console.error("[Victoria Survey] Popup shell not found in DOM.");
      resolve(null);
      return;
    }

    card.dataset.theme = theme;
    const defaultIcon = theme === "danger" ? "fa-triangle-exclamation" : "fa-circle-info";
    iconEl.innerHTML = `<i class="fas ${icon || defaultIcon}" aria-hidden="true"></i>`;
    titleEl.textContent = title;
    messageEl.textContent = message;
    messageEl.hidden = !message;

    const multi = !field && Array.isArray(fields) && fields.length > 0;
    fieldEl.innerHTML = "";
    fieldEl.hidden = !field && !multi;
    let inputEl = null;
    /** key -> element, for the multi-field form. */
    const multiInputs = new Map();

    if (multi) {
      fields.forEach((f) => {
        const row = document.createElement("label");
        // `half: true` puts a field on the same line as its neighbour —
        // the container is a flex-wrap row, so two consecutive halves
        // share a line and anything full-width forces a new one.
        row.className = "vsl-popup-formrow" + (f.half ? " vsl-popup-formrow--half" : "");
        if (f.label) {
          const lab = document.createElement("span");
          lab.className = "vsl-popup-formrow__label";
          lab.textContent = f.label;
          row.appendChild(lab);
        }
        let el;
        if (f.type === "select") {
          el = document.createElement("select");
          el.className = "vsl-popup-select";
          (f.options || []).forEach((o) => {
            const opt = document.createElement("option");
            opt.value = o.value;
            opt.textContent = o.label;
            if (String(o.value) === String(f.value ?? "")) opt.selected = true;
            el.appendChild(opt);
          });
        } else if (f.type === "textarea") {
          el = document.createElement("textarea");
          el.className = "vsl-popup-input vsl-popup-textarea";
          el.rows = 3;
          el.placeholder = f.placeholder || "";
          el.value = f.value || "";
        } else {
          el = document.createElement("input");
          el.type = "text";
          el.className = "vsl-popup-input";
          el.placeholder = f.placeholder || "";
          el.value = f.value || "";
        }
        if (f.disabled) {
          el.disabled = true;
          row.classList.add("vsl-popup-formrow--disabled");
        }
        const clearInvalid = () =>
          el.classList.remove("vsl-popup-input--invalid", "vsl-popup-select--invalid");
        el.addEventListener("input", clearInvalid);
        el.addEventListener("change", clearInvalid);
        row.appendChild(el);
        fieldEl.appendChild(row);
        // Disabled fields still report their value, but never block submit
        // on `required` — there's nothing the person could do about it.
        multiInputs.set(f.key, { el, required: !!f.required && !f.disabled });
      });
    } else if (field) {
      if (field.type === "select") {
        inputEl = document.createElement("select");
        inputEl.className = "vsl-popup-select";
        (field.options || []).forEach((o) => {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.label;
          if (o.value === field.value) opt.selected = true;
          inputEl.appendChild(opt);
        });
      } else {
        inputEl = document.createElement("input");
        inputEl.type = "text";
        inputEl.className = "vsl-popup-input";
        inputEl.placeholder = field.placeholder || "";
        inputEl.value = field.value || "";
      }
      // Clear the red "you left this blank" state (set below, in the
      // required-and-empty branch) the moment they start fixing it. Select
      // elements don't reliably fire "input" in every browser, so also
      // listen for "change".
      const clearInvalid = () => inputEl.classList.remove("vsl-popup-input--invalid", "vsl-popup-select--invalid");
      inputEl.addEventListener("input", clearInvalid);
      inputEl.addEventListener("change", clearInvalid);
      fieldEl.appendChild(inputEl);
    }

    actionsEl.innerHTML = "";
    const effectiveButtons = buttons?.length ? buttons : [{ label: "OK", value: true, variant: "primary", primary: true }];
    let primaryBtnEl = null;

    function cleanup() {
      overlay.hidden = true;
      document.removeEventListener("keydown", onKey);
      overlay.removeEventListener("click", onBackdrop);
    }
    function finish(value) {
      cleanup();
      resolve(value);
    }
    function onKey(e) {
      if (e.key === "Escape") finish(null);
      else if (e.key === "Enter") primaryBtnEl?.click();
    }
    function onBackdrop(e) {
      if (e.target === overlay) finish(null);
    }

    effectiveButtons.forEach((b) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `vsl-popup-btn vsl-popup-btn--${b.variant || "ghost"}`;
      btn.textContent = b.label;
      btn.addEventListener("click", () => {
        if (b.readField && multi) {
          // Validate every required field before resolving, focusing the
          // first offender rather than failing on all of them at once.
          const out = {};
          let firstBad = null;
          multiInputs.forEach(({ el, required }, key) => {
            const raw = el.tagName === "SELECT" ? el.value : el.value.trim();
            if (required && !raw && !firstBad) firstBad = el;
            out[key] = raw;
          });
          if (firstBad) {
            firstBad.classList.add(
              firstBad.tagName === "SELECT" ? "vsl-popup-select--invalid" : "vsl-popup-input--invalid"
            );
            firstBad.focus();
            return;
          }
          finish(out);
        } else if (b.readField && inputEl) {
          const raw = inputEl.tagName === "SELECT" ? inputEl.value : inputEl.value.trim();
          if (b.required && !raw) {
            inputEl.classList.add(inputEl.tagName === "SELECT" ? "vsl-popup-select--invalid" : "vsl-popup-input--invalid");
            inputEl.focus();
            return;
          }
          // Not `raw || null` — that would turn a deliberately-submitted
          // empty string (allowed when the button isn't `required`) into
          // null, indistinguishable from Escape/Cancel. Only Escape/
          // backdrop-click/Cancel resolve null; a field-reading button
          // click always resolves what's actually in the field.
          finish(raw);
        } else {
          finish(b.value ?? true);
        }
      });
      if (b.primary) primaryBtnEl = btn;
      actionsEl.appendChild(btn);
    });

    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", onBackdrop);

    overlay.hidden = false;
    (inputEl || primaryBtnEl)?.focus();
    inputEl?.select?.();
  });
}

/**
 * Danger-themed confirmation. Pass `confirmLabel` for an actual "are you
 * sure" (Cancel + red confirm button, resolves true/false); omit it for a
 * plain informational notice (single OK button — used e.g. for "can't
 * delete, it's still in use").
 */
export function confirmDanger({ title, message, confirmLabel, icon }) {
  return showPopup({
    theme: "danger",
    icon,
    title,
    message,
    buttons: confirmLabel
      ? [
          { label: "Cancel", value: false, variant: "ghost" },
          { label: confirmLabel, value: true, variant: "danger", primary: true }
        ]
      : [{ label: "OK", value: true, variant: "danger", primary: true }]
  }).then((v) => !!v);
}

/** Free-text prompt (rename/create-by-name, etc). Resolves the trimmed
 * string (possibly "" if `required: false` and left blank — e.g. "use the
 * default numbering"), or null if cancelled via Escape/backdrop/Cancel. */
export function promptText({ title, message, placeholder, value, confirmLabel = "Save", required = true }) {
  return showPopup({
    theme: "default",
    title,
    message,
    field: { type: "text", placeholder, value },
    buttons: [
      { label: "Cancel", value: null, variant: "ghost" },
      { label: confirmLabel, readField: true, required, variant: "primary", primary: true }
    ]
  });
}

/** Single-choice dropdown prompt (CRS picker, etc). Resolves the chosen
 * option's value, or null if cancelled. */
export function promptSelect({ title, message, options, value, confirmLabel = "OK" }) {
  return showPopup({
    theme: "default",
    title,
    message,
    field: { type: "select", options, value },
    buttons: [
      { label: "Cancel", value: null, variant: "ghost" },
      { label: confirmLabel, readField: true, variant: "primary", primary: true }
    ]
  });
}

/** Small labelled form in a popup — several fields edited at once, e.g.
 *  the Select window's Modify action (a plot's name/estate/block).
 *  Resolves an object keyed by each field's `key`, or null if cancelled.
 *
 *  @param {{key:string,label?:string,type?:"text"|"textarea"|"select",
 *           value?:string,placeholder?:string,required?:boolean,
 *           options?:{value:string,label:string}[]}[]} fields
 */
export function promptFields({ title, message, fields, icon, confirmLabel = "Save" }) {
  return showPopup({
    theme: "default",
    icon,
    title,
    message,
    fields,
    buttons: [
      { label: "Cancel", value: null, variant: "ghost" },
      { label: confirmLabel, readField: true, variant: "primary", primary: true }
    ]
  });
}

// escapeHtml isn't currently needed outside this module (all content is
// set via textContent, not innerHTML), but exported in case a future
// caller wants it for a custom field/message.
export { escapeHtml };
