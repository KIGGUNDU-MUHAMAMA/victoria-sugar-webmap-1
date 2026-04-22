const fallbackCfg = {
  SUPABASE_URL: "https://knhgliyghacvkeeptsfl.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_W2kx87RbvH0Qd1HkPPXlIg_6GAy0HAV",
  APP_NAME: "Victoria Sugar Webmap",
  DEFAULT_CENTER: [32.59, 0.35],
  DEFAULT_ZOOM: 11,
  AREA_TOLERANCE_PERCENT: 5,
  // false = webmap requires sign-in (recommended so RLS applies and layers load reliably).
  // Override with ALLOW_GUEST_PREVIEW: true in config/app-config.js for public demo only.
  ALLOW_GUEST_PREVIEW: false,
  // When true, logs bbox RPC details to the browser console (verbose).
  DEBUG_MAP_RPC: false,
  /** Sentinel Hub OGC WMS (instance in dashboard). Override in app-config.js if needed. */
  SENTINEL_HUB_WMS_BASE: "https://services.sentinel-hub.com/ogc/wms/03c5e367-bc3d-46bc-8deb-fa7e280926b6",
  /**
   * Optional manual YYYY-MM-DD list, newest first. If empty or omitted, dates are auto-generated
   * (every SENTINEL_TIMELINE_STEP_DAYS) from today back SENTINEL_TIMELINE_MONTHS_BACK.
   */
  SENTINEL_TIMELINE: [],
  SENTINEL_TIMELINE_STEP_DAYS: 14,
  SENTINEL_TIMELINE_MONTHS_BACK: 24,
  /** Sentinel Hub WMS: max mean cloud % (0–100). */
  SENTINEL_MAX_CLOUD_COVER: 25,
  /** Sentinel Hub WMS: mostRecent | leastCC | leastRecent | leastTimeDifference | maximumViewingElevation */
  SENTINEL_TILE_PRIORITY: "leastCC"
};

const cfg = {
  ...fallbackCfg,
  /** Must match the function name in Supabase (e.g. quick-api or vsl-survey-import). */
  SURVEY_FUNCTION_NAME: "quick-api",
  /** Block Sentinel statistics (NDVI/NDMI). Deploy: supabase functions deploy vsl-sentinel-statistics */
  SENTINEL_STATS_FUNCTION: "vsl-sentinel-statistics",
  ...(window.VSL_CONFIG || {})
};

export function createSupabaseClient() {
  if (!window.supabase?.createClient) {
    throw new Error("Supabase library failed to load.");
  }
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    throw new Error("Missing Supabase configuration.");
  }
  return window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true
    }
  });
}

export function getConfig() {
  return cfg;
}
