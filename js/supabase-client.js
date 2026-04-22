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
   * Manual YYYY-MM-DD list (newest first recommended). Replace later with catalog API results.
   * Dates must have Sentinel-2 coverage for your area of interest.
   */
  SENTINEL_TIMELINE: [
    "2024-10-15",
    "2024-08-20",
    "2024-06-01",
    "2024-04-10",
    "2023-12-01"
  ]
};

const cfg = {
  ...fallbackCfg,
  /** Must match the function name in Supabase (e.g. quick-api or vsl-survey-import). */
  SURVEY_FUNCTION_NAME: "quick-api",
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
