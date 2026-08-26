/**
 * Toast component.
 * -----------------------------------------------------------------------
 * A toast is a transient status message: it shows text and disappears on
 * its own after a while. This is deliberately kept separate from the
 * popup-window system in windows/ (see windows/pop-window-template.html) —
 * a toast has no head/icon/tabs/body/action-buttons, it's just a message
 * that appears and then goes away by itself, nothing the user opens or
 * closes manually.
 *
 * js/utils.js's setStatus()/clearStatus() (used by ~120 call sites across
 * the app) delegate to showToast()/hideToast() here for any element using
 * the .toast class (see toast/toast.css) — everything else keeps its old,
 * non-auto-hiding behavior (e.g. login.html's inline form status message).
 */

// How long a toast stays visible before auto-hiding, in ms.
export const TOAST_DEFAULT_DURATION_MS = 4000;
export const TOAST_ERROR_DURATION_MS = 6000; // errors get a little longer to read

// One pending hide-timer per toast element, so a second call on the same
// element restarts the clock instead of stacking multiple hides.
const hideTimers = new WeakMap();

/**
 * Show a message on `el` and schedule it to auto-hide.
 * @param {HTMLElement} el - element with class="toast" (see toast/toast.css)
 * @param {string} message
 * @param {{isError?: boolean, duration?: number}} [options]
 *   duration overrides the default/error timing, in ms. Pass `duration: 0`
 *   to show indefinitely (caller is then responsible for calling
 *   hideToast()/clearStatus() themselves).
 */
export function showToast(el, message, { isError = false, duration } = {}) {
  if (!el) return;

  const existing = hideTimers.get(el);
  if (existing) clearTimeout(existing);

  el.hidden = false;
  el.textContent = message;
  el.classList.toggle("error", Boolean(isError));

  const ms = duration ?? (isError ? TOAST_ERROR_DURATION_MS : TOAST_DEFAULT_DURATION_MS);
  if (ms > 0) {
    const timer = setTimeout(() => hideToast(el), ms);
    hideTimers.set(el, timer);
  } else {
    hideTimers.delete(el);
  }
}

/** Hide a toast immediately and cancel any pending auto-hide timer. */
export function hideToast(el) {
  if (!el) return;
  const existing = hideTimers.get(el);
  if (existing) {
    clearTimeout(existing);
    hideTimers.delete(el);
  }
  el.hidden = true;
  el.textContent = "";
  el.classList.remove("error");
}
