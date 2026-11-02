/**
 * user-settings.js — what the app remembers about how you left it.
 *
 * Where you were on the map, which layers were on, what the print setup was
 * set to, the last thing you searched for. Reopening the site puts it back
 * instead of starting from the default view every time.
 *
 * ── localStorage, not cookies ──
 * Cookies are capped at about 4KB per domain and are sent to the server with
 * every single request — including every map tile and every Supabase call.
 * Map state and print settings are neither small enough nor the server's
 * business. localStorage is the same persistence (survives a close, lives on
 * the device) with none of that, and is read synchronously so the saved view
 * is available before the first paint.
 *
 * ── One object, one key ──
 * Everything lives under a single key as one JSON object. A key per setting
 * would mean a dozen reads at boot and no way to version the whole thing;
 * with one object, SCHEMA_VERSION lets a future change discard a shape it no
 * longer understands rather than crashing on it.
 *
 * ── Nothing here is load-bearing ──
 * Every read falls back to a default and every write is wrapped: private
 * browsing, a full quota or a locked-down profile all throw on access, and
 * none of that should cost more than the convenience it was providing. It
 * also holds no personal data and no credentials — a device preference
 * store, nothing more, which is why it can be wiped wholesale by "Restore
 * default settings" without asking anything else.
 */

const STORAGE_KEY = "vsl.settings.v1";
const SCHEMA_VERSION = 1;

/**
 * The shape, and the values the app uses when nothing has been saved.
 *
 * Also the list "Restore default settings" restores to — it clears the
 * store, so defaults come from here rather than from whatever the DOM
 * happened to hold at the time.
 */
export const DEFAULT_SETTINGS = Object.freeze({
  version: SCHEMA_VERSION,
  /** Where the map was looking. null = use the app's own startup view. */
  view: null, // { center: [x, y], zoom: number }
  layers: {
    /** Title of the chosen basemap, as shown in the Layers panel. */
    basemap: null,
    /** { "Blocks": true, "Land Titles": false, … } — only layers the
     *  person actually toggled are listed; anything absent keeps its own
     *  default, so a new layer added later starts however it was built. */
    visible: {},
    /** Feature TYPE ids switched off in the FEATURES group. */
    hiddenFeatureTypes: []
  },
  /** The print Setup window's settings, saved whole (see js/print-tool.js). */
  print: null,
  search: {
    /** Which tab the Search window was last on. */
    tab: null,
    /** The Estate/Block/Plot tab's last picks, by id. */
    estateId: null,
    blockId: null,
    parcelCode: null
  },
  appearance: {
    /**
     * How opaque the gap is inside a double or triple line, 0–100.
     *
     * Those parallel lines are drawn by painting one wide stroke in the
     * feature's colour and knocking its middle back out with a narrower
     * stroke — the way cased roads have always been drawn. The knockout
     * used to be hard-coded opaque white, which on satellite imagery is the
     * brightest thing on the map.
     *
     * 100 is that white. Lower blends it toward the line's own colour, so
     * the gap reads as a pale stripe instead of a glare. 0 removes the
     * knockout altogether, which leaves ONE thick solid line — the double
     * and triple symbols stop being distinguishable, and roads crossing
     * each other show their overlaps.
     *
     * A truly transparent gap (showing the imagery through it) is not
     * possible this way: the knockout is painted OVER the casing, and paint
     * cannot erase. It would need real offset geometry per line.
     */
    lineGapOpacity: 70
  }
});

/** Deep-ish merge of a stored object onto the defaults, so a saved file
 *  missing a key (older version, hand-edited) still yields a complete
 *  settings object rather than undefined holes. */
function withDefaults(stored) {
  const base = structuredCloneSafe(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== "object") return base;
  for (const [key, value] of Object.entries(stored)) {
    if (!(key in base)) continue; // drop keys this version doesn't know
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      base[key] = { ...base[key], ...value };
    } else {
      base[key] = value;
    }
  }
  return base;
}

/** structuredClone isn't in every browser this app targets. */
function structuredCloneSafe(obj) {
  try {
    return typeof structuredClone === "function" ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
  } catch {
    return JSON.parse(JSON.stringify(obj));
  }
}

let cache = null;

/** The whole settings object. Cached, because this is read during boot and
 *  on the map's moveend. */
export function readSettings() {
  if (cache) return cache;
  let stored = null;
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // A version we don't recognise is discarded rather than guessed at.
      if (parsed?.version === SCHEMA_VERSION) stored = parsed;
    }
  } catch {
    stored = null;
  }
  cache = withDefaults(stored);
  return cache;
}

function persist() {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* quota, private mode, disabled storage — the app carries on */
  }
}

/**
 * Merges a patch into one top-level section and saves.
 *
 *   patchSettings("search", { estateId: 3 })
 *
 * Section-level rather than a free path so callers can't invent keys the
 * defaults don't describe — anything unknown would be dropped on the next
 * read anyway, and silently losing a write is worse than not offering it.
 */
export function patchSettings(section, patch) {
  const settings = readSettings();
  if (!(section in settings)) return settings;
  if (patch && typeof patch === "object" && !Array.isArray(patch) && settings[section] && typeof settings[section] === "object" && !Array.isArray(settings[section])) {
    settings[section] = { ...settings[section], ...patch };
  } else {
    settings[section] = patch;
  }
  persist();
  return settings;
}

/** Replaces one section outright (the print settings, the saved view). */
export function setSetting(section, value) {
  const settings = readSettings();
  if (!(section in settings)) return settings;
  settings[section] = value;
  persist();
  return settings;
}

/**
 * Forgets everything and returns the defaults.
 *
 * Used by "Restore default settings". Only this store is touched — the
 * signed-in profile cache (js/role-store.js) and the offline land cache are
 * separate concerns and are left alone, so restoring settings never signs
 * anyone out or forces a re-download of the boundaries.
 */
export function clearSettings() {
  try {
    window.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to clear if storage is unavailable */
  }
  cache = structuredCloneSafe(DEFAULT_SETTINGS);
  return cache;
}

/** Whether anything has actually been saved — so the Settings window can
 *  say "nothing remembered yet" instead of offering to restore defaults
 *  that are already in force. */
export function hasSavedSettings() {
  try {
    return !!window.localStorage?.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
}

/** Calls that run on every map move, every layer toggle and every keystroke
 *  in a print setting don't each need a write to disk. */
export function debounce(fn, ms = 400) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}
