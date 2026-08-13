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
 *   At most one field — every current use case (estate name, CRS picker,
 *   starting-ID prompt) only ever needs one.
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

    fieldEl.innerHTML = "";
    fieldEl.hidden = !field;
    let inputEl = null;
    if (field) {
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
        if (b.readField && inputEl) {
          const raw = inputEl.tagName === "SELECT" ? inputEl.value : inputEl.value.trim();
          if (b.required && !raw) {
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

// escapeHtml isn't currently needed outside this module (all content is
// set via textContent, not innerHTML), but exported in case a future
// caller wants it for a custom field/message.
export { escapeHtml };
