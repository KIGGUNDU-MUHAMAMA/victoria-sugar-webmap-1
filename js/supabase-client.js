const fallbackCfg = {
  SUPABASE_URL: "https://knhgliyghacvkeeptsfl.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_W2kx87RbvH0Qd1HkPPXlIg_6GAy0HAV",
  APP_NAME: "Victoria Sugar Webmap",
  DEFAULT_CENTER: [32.59, 0.35],
  DEFAULT_ZOOM: 11,
  AREA_TOLERANCE_PERCENT: 5,
  // false = webmap requires sign-in (recommended so RLS applies and layers load reliably).
  // Override with ALLOW_GUEST_PREVIEW: true in config/app-config.js for public demo only.
  ALLOW_GUEST_PREVIEW: false
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
