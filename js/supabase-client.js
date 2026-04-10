const cfg = window.VSL_CONFIG || {};

export function createSupabaseClient() {
  if (!window.supabase?.createClient) {
    throw new Error("Supabase library failed to load.");
  }
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    throw new Error("Missing Supabase configuration in config/app-config.js");
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
