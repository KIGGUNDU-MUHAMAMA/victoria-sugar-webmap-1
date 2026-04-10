/**
 * Copy to app-config.js (git-ignored) for overrides. Do not commit real keys.
 *
 * What you have in the Supabase dashboard maps like this:
 *
 * - sb_publishable_...  → SUPABASE_ANON_KEY (safe for browser / GitHub Pages)
 * - Project ref (e.g. knhgliyghacvkeeptsfl) → SUPABASE_URL = https://<ref>.supabase.co
 * - sb_secret_... OR legacy "service_role" JWT → NOT here. Only in Edge Function secrets
 *   as SUPABASE_SERVICE_ROLE_KEY (never in webmap.html or public JS).
 * - "JWT signing" key id + legacy JWT secret → Supabase Auth internals only; do not paste
 *   into this file or webmap.html.
 */
window.VSL_CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT_REF.supabase.co",
  // Use the publishable key (sb_publishable_...) from Project Settings → API
  SUPABASE_ANON_KEY: "YOUR_PUBLISHABLE_OR_ANON_KEY",
  APP_NAME: "Victoria Sugar Webmap",
  DEFAULT_CENTER: [32.59, 0.35],
  DEFAULT_ZOOM: 11,
  AREA_TOLERANCE_PERCENT: 5,
  // Optional: must match Edge Function secret if you set SURVEY_IMPORT_SECRET in Supabase.
  // SURVEY_IMPORT_SECRET: "your-shared-secret",
  // SURVEY_FUNCTION_NAME: "quick-api",
  // Set true only for a public demo without login (layers need sql/004 + 005 for anon reads).
  // ALLOW_GUEST_PREVIEW: false
};
