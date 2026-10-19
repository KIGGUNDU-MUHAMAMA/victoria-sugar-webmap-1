/**
 * role-store.js — who is signed in, what they may reach, and the local cache
 * that keeps the map from asking the database on every page load.
 *
 * ── The cache ──
 * The role used to be fetched from vsl_profiles on every boot, before the
 * map could decide which tools to show. That is a round trip in front of the
 * first paint, every single time, for a value that changes perhaps twice a
 * year. Sign-in now writes the profile here, and the map reads it straight
 * back — then revalidates quietly in the background and re-applies if it has
 * actually changed.
 *
 * ── What the cache is NOT ──
 * It decides which BUTTONS are shown. It decides nothing else. Every real
 * permission is enforced by Postgres row-level security and by the Cloudflare
 * workers, both of which read the role from the database on the authority of
 * the user's own Supabase token — neither has any idea this cache exists.
 * So the worst a tampered cache achieves is a button that errors when
 * pressed. Hiding a control is a courtesy to the person using the app, never
 * a security boundary.
 *
 * Stored under the user's id, so a second account signing in on the same
 * browser can never inherit the first one's role.
 */

const CACHE_PREFIX = "vsl.profile.";

/** Every role in vsl_profiles.role. MANAGMENT's spelling matches the
 *  database column — do not "fix" it here without migrating the data. */
export const ROLES = Object.freeze({
  ADMIN: "ADMIN",
  SURVEYOR: "SURVEYOR",
  MANAGMENT: "MANAGMENT"
});

const EVERYONE = Object.freeze([ROLES.ADMIN, ROLES.SURVEYOR, ROLES.MANAGMENT]);
const LAND_EDITORS = Object.freeze([ROLES.ADMIN, ROLES.SURVEYOR]);

/**
 * Which roles see which tool in the map's left-hand stack.
 *
 * One table, so "who can do what" is answerable by reading nine lines rather
 * than by grepping for disabled flags scattered through the boot sequence.
 * Keys map to button ids in TOOL_BUTTON_IDS below.
 */
export const TOOL_ROLES = Object.freeze({
  /** The admin dashboard — user management, settings, the lot. */
  dashboard: [ROLES.ADMIN],

  /** Read-only lookups. No data changes, so no reason to restrict them. */
  information: EVERYONE,
  search: EVERYONE,

  /** Measuring draws nothing and saves nothing — it is a ruler. */
  measure: EVERYONE,

  /** These three create, reshape or export land records. */
  survey: LAND_EDITORS,
  select: LAND_EDITORS,
  print: LAND_EDITORS,

  /** Anyone in the field can record what they did; RLS lets any signed-in
   *  user INSERT an activity while reserving edits and deletes. */
  logActivity: EVERYONE
});

/** Tool key → the button's DOM id in webmap.html. */
export const TOOL_BUTTON_IDS = Object.freeze({
  dashboard: "mapDashboardBtn",
  information: "mapFeatureInfoBtn",
  search: "searchPanelBtn",
  survey: "toolsTopBtn",
  measure: "measureTopBtn",
  select: "parcelStatusBtn",
  print: "printTopBtn",
  logActivity: "mapLogActivityBtn"
});

/** True when `role` may use `tool`. Unknown tools are denied rather than
 *  allowed, so a typo hides a button instead of exposing one. */
export function canUseTool(role, tool) {
  const allowed = TOOL_ROLES[tool];
  return Array.isArray(allowed) && allowed.includes(role);
}

/** Convenience for the two checks the app makes most often. */
export function isLandEditor(role) {
  return LAND_EDITORS.includes(role);
}

/**
 * Hides every tool button this role may not use, and shows the rest.
 *
 * Idempotent, because it runs twice on a normal load: once immediately from
 * the cached role, then again if the background revalidation finds the role
 * has changed since.
 */
export function applyToolVisibility(role) {
  for (const [tool, id] of Object.entries(TOOL_BUTTON_IDS)) {
    const btn = document.getElementById(id);
    if (btn) btn.hidden = !canUseTool(role, tool);
  }
}

// ── Cache ────────────────────────────────────────────────────────────────

/** Everything worth keeping. Deliberately not the whole profile row: no
 *  reason to leave a phone number sitting in localStorage. */
function pickCacheable(profile) {
  return {
    id: profile.id,
    role: profile.role,
    email: profile.email ?? null,
    full_name: profile.full_name ?? null,
    title: profile.title ?? null,
    avatar_url: profile.avatar_url ?? null
  };
}

/**
 * Saves the profile for later boots.
 *
 * localStorage (not sessionStorage) on purpose: a surveyor in the field
 * reopening the app should get their tools immediately, not after another
 * round trip. Every access is guarded — a locked-down or private browsing
 * context throws on access, and a failure here must only cost the
 * optimisation, never the login.
 */
export function cacheProfile(profile) {
  if (!profile?.id || !profile?.role) return;
  try {
    window.localStorage?.setItem(
      CACHE_PREFIX + profile.id,
      JSON.stringify(pickCacheable(profile))
    );
  } catch { /* storage unavailable — carry on without the cache */ }
}

/**
 * The cached profile for this user id, or null.
 *
 * Keyed by id and re-checked against it, so a stale entry belonging to
 * someone else can never be handed back for the current session.
 */
export function readCachedProfile(userId) {
  if (!userId) return null;
  try {
    const raw = window.localStorage?.getItem(CACHE_PREFIX + userId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.role || parsed.id !== userId) return null;
    // A role that is no longer one of ours means the app has moved on since
    // this was written — refetch rather than trust it.
    if (!Object.values(ROLES).includes(parsed.role)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Clears cached profiles. Called on sign-out so a shared machine doesn't
 *  hand the next person a pre-populated toolbar. */
export function clearCachedProfiles() {
  try {
    const store = window.localStorage;
    if (!store) return;
    for (let i = store.length - 1; i >= 0; i--) {
      const key = store.key(i);
      if (key && key.startsWith(CACHE_PREFIX)) store.removeItem(key);
    }
  } catch { /* nothing to clear if storage is unavailable */ }
}
