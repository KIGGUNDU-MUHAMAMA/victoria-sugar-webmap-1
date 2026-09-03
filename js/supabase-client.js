const fallbackCfg = {
  SUPABASE_URL: "https://knhgliyghacvkeeptsfl.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_W2kx87RbvH0Qd1HkPPXlIg_6GAy0HAV",
  APP_NAME: "Victoria Sugar Webmap",
  DEFAULT_CENTER: [32.59, 0.35],
  DEFAULT_ZOOM: 11,
  AREA_TOLERANCE_PERCENT: 5,
  /**
   * Drone tile Worker (see worker/). Serves .pmtiles out of the vsl-tiles R2
   * bucket and accepts uploads. Not a credential — the Worker holds the
   * bucket binding and checks the caller's Supabase token on every request.
   */
  TILES_API_BASE: "https://tiles.victoriasugar.ug",
  /**
   * Field media Worker (see workers/media/). Serves photos and videos out
   * of the vsl-farms-media R2 bucket and accepts uploads. A different
   * worker, bucket and domain from the tiles above — see that worker's
   * header for why. Not a credential: the Worker holds the bucket binding
   * and checks the caller's Supabase token on every request.
   */
  MEDIA_API_BASE: "https://farmsmedia.victoriasugar.ug",
  // false = webmap requires sign-in (recommended so RLS applies and layers load reliably).
  // Override with ALLOW_GUEST_PREVIEW: true in config/app-config.js for public demo only.
  ALLOW_GUEST_PREVIEW: false,
  // When true, logs bbox RPC details to the browser console (verbose).
  DEBUG_MAP_RPC: false,
  /**
   * Copernicus Data Space OGC WMS (configured instance; public tiles — no client auth in browser).
   * Do not change the path without updating the CDSE configuration.
   */
  SENTINEL_HUB_WMS_BASE: "https://sh.dataspace.copernicus.eu/ogc/wms/ab8b1162-e45e-4405-9db6-aa882b920217",
  /**
   * CDSE WMS LAYERS name for Copernicus DEM in your instance (GetCapabilities or dashboard).
   * If blank, the app uses "DEM". Set this if your configuration uses e.g. COPERNICUS_DEM.
   */
  SENTINEL_DEM_WMS_LAYER: "",
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
  /**
   * Name segment in URL: …/functions/v1/&lt;THIS&gt; — must match a deployed function with the vsl-sentinel-statistics code.
   * It is NOT "quick-responder" unless you set this to "quick-responder" and deploy that same stats code there.
   */
  SENTINEL_STATS_FUNCTION: "vsl-sentinel-statistics",
  ...(window.VSL_CONFIG || {})
};

export function createSupabaseClient() {
  if (window.supabaseClient) {
    return window.supabaseClient;
  }
  if (!window.supabase?.createClient) {
    throw new Error("Supabase library failed to load.");
  }
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    throw new Error("Missing Supabase configuration.");
  }
  window.supabaseClient = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true
    }
  });
  return window.supabaseClient;
}

export function getConfig() {
  return cfg;
}
