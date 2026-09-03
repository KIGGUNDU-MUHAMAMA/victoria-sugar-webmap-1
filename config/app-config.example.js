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
  SUPABASE_URL: "https://knhgliyghacvkeeptsfl.supabase.co",
  // Use the publishable key (sb_publishable_...) from Project Settings → API
  SUPABASE_ANON_KEY: "sb_publishable_W2kx87RbvH0Qd1HkPPXlIg_6GAy0HAV",
  APP_NAME: "Victoria Sugar Webmap",
  DEFAULT_CENTER: [32.59, 0.35],
  DEFAULT_ZOOM: 11,
  AREA_TOLERANCE_PERCENT: 5,
  // Drone tile Worker (see worker/). Serves .pmtiles from the vsl-tiles R2
  // bucket and accepts uploads. No credential here — the Worker holds the
  // bucket binding and checks the caller's Supabase token.
  TILES_API_BASE: "https://tiles.victoriasugar.ug",
  // Field media Worker (workers/media) — photos/videos on activities and
  // alerts, in the vsl-farms-media bucket. A different worker and bucket
  // from the tiles above; see workers/README.md for why.
  MEDIA_API_BASE: "https://farmsmedia.victoriasugar.ug",
  // Optional: must match Edge Function secret if you set SURVEY_IMPORT_SECRET in Supabase.
  // SURVEY_IMPORT_SECRET: "your-shared-secret",
  // SURVEY_FUNCTION_NAME: "quick-api",
  // Set true only for a public demo without login (layers need sql/004 + 005 for anon reads).
  // ALLOW_GUEST_PREVIEW: false
  // Verbose console logging for vsl_get_features_bbox (default off).
  // DEBUG_MAP_RPC: false
  // Copernicus Data Space WMS (public; no auth in the browser). Use the exact instance URL for your project.
  // SENTINEL_HUB_WMS_BASE: "https://sh.dataspace.copernicus.eu/ogc/wms/<configuration-instance-uuid>"
  // If the DEM WMS LAYERS name in your CDSE configuration is not "DEM", set it here (see GetCapabilities).
  // SENTINEL_DEM_WMS_LAYER: "COPERNICUS_DEM",
  // The app sends SHOWLOGO=false on WMS; you can also turn off the per-tile logo in the CDSE
  // Sentinel Hub Configuration (dashboard) for the instance. Watermarks in tiles are a CDSE product rule.
  // Block report: URL is …/functions/v1/<name>. Default is vsl-sentinel-statistics (not quick-responder).
  // Deploy: supabase functions deploy vsl-sentinel-statistics
  // Or, if the stats code is deployed under another name, set e.g. SENTINEL_STATS_FUNCTION: "my-stats-fn"
  // SENTINEL_STATS_FUNCTION: "vsl-sentinel-statistics",
  // YYYY-MM-DD list for the time slider (extend or replace with catalog API).
  // SENTINEL_TIMELINE: ["2024-10-15", "2024-06-01", "2023-12-01"]
};
