# Cloudflare + GitHub Deployment

## 1) Create New Repository

From `victoria-sugar-webmap` directory:

```bash
git init
git add .
git commit -m "Initial Victoria Sugar webmap scaffold"
gh repo create victoria-sugar-webmap --public --source=. --push
```

## 2) Configure Supabase

1. Create new Supabase project for Victoria Sugar.
2. Run SQL files in order:
   - `sql/001_vsl_schema.sql`
   - `sql/002_vsl_survey_batch.sql` (batch polygon upsert for Survey import; **Edge Function only**)
   - `sql/004_vsl_anon_read_map_layers.sql` (lets **guest / anon** users see BLOCKS and PARCELS on the map; without it, saves work but the map stays empty when not logged in)
   - `sql/005_vsl_get_features_bbox_definer.sql` (recommended: makes `vsl_get_features_bbox` **SECURITY DEFINER** so guest map load works even if RLS policies are easy to misconfigure; safe because results are still limited to the map viewport bbox)
   - `sql/010_vsl_block_geojson_for_stats.sql` (**required** for **vsl-sentinel-statistics**: returns `st_asgeojson(geom)` so the Edge Function always gets valid GeoJSON for the block polygon)
3. **Survey import (Edge Function):**
   - Install [Supabase CLI](https://supabase.com/docs/guides/cli), then from the repo root:

     ```bash
     supabase login
     supabase link --project-ref YOUR_PROJECT_REF
     supabase functions deploy vsl-survey-import
     ```

   - If you deploy under another name (e.g. Dashboard **quick-api**), set in `config/app-config.js`:

     ```js
     SURVEY_FUNCTION_NAME: "quick-api"
     ```

     The built-in fallback in `js/supabase-client.js` defaults to **`quick-api`** so GitHub Pages works without a local config file.

   - Optional hardening: Dashboard → Edge Functions → your function → Secrets → `SURVEY_IMPORT_SECRET`. Mirror it in `config/app-config.js` as `SURVEY_IMPORT_SECRET` (header `x-vsl-survey-secret`). If unset, the anon key alone is enough for testing.

   - For **guest / anon** Survey preview and save, turn **off** JWT verification for that function (Dashboard → Edge Functions → your function → Settings). Writes still use the **service role** inside the function.

   - CSV format: `docs/survey_points_template.csv`.
3. **Block report + Sentinel statistics (Edge Function `vsl-sentinel-statistics`):**
   - The webmap calls **`https://<project>.supabase.co/functions/v1/vsl-sentinel-statistics`** (not `quick-responder`). The dashboard “sample” `quick-responder` is a different function; a successful curl to `quick-responder` does **not** prove the report works.
   - Deploy: `supabase functions deploy vsl-sentinel-statistics`
   - Dashboard → Edge Functions → `vsl-sentinel-statistics` → **Secrets** (never commit these):
     - `SENTINEL_HUB_CLIENT_ID` and `SENTINEL_HUB_CLIENT_SECRET` — **Copernicus Data Space (CDSE)** OAuth client (machine / client credentials), from your CDSE dashboard — **not** a user Bearer token, not User ID, not Account ID, and not the WMS path instance id by itself. See **§ CDSE (below)**.
     - Optional overrides (defaults target **CDSE** in code):
       - `SENTINEL_HUB_TOKEN_URL` — default: `https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token`
       - `SENTINEL_HUB_STATISTICS_URL` — default: `https://sh.dataspace.copernicus.eu/api/v1/statistics`  
     - Legacy **Planet** `services.sentinel-hub.com`: set both URL secrets to the `services.sentinel-hub.com` token + statistics hosts and use Planet OAuth client credentials.
   - The function validates the **Supabase** user in code; you may set **Verify JWT** off on this function if the Supabase gateway rejects ES256 session tokens (see `supabase/config.toml`).
   - Override the function name in `config/app-config.js` if needed: `SENTINEL_STATS_FUNCTION: "vsl-sentinel-statistics"` (matches the built-in default in `js/supabase-client.js`).

### Copernicus Data Space (CDSE) — keys for the webmap and for `vsl-sentinel-statistics`

- **WMS** in `config/app-config.js`: `SENTINEL_HUB_WMS_BASE` = `https://sh.dataspace.copernicus.eu/ogc/wms/<configuration-instance-id>` (the id is in the OGC / Dashboard URL, **not** the OAuth client id).
- **DEM underlay:** set `SENTINEL_DEM_WMS_LAYER` to the **WMS `LAYERS` name** for a DEM/relief layer defined in the same configuration (use **GetCapabilities** or the CDSE “configuration” / processing UI). Without this, the Satellite panel only shows a short hint; no DEM is requested.
- **Block report (Edge Function):** use the **client id + client secret** of a CDSE **OAuth client** that can use the **Statistics** API. The **Bearer** token in “Request preview” in the browser is a **short-lived user token**; do **not** paste that into Supabase. Use the same client credentials flow the Edge Function implements (`grant_type=client_credentials` against `SENTINEL_HUB_TOKEN_URL` default above).

### Planet / Insights (`https://insights.planet.com/`) — legacy `services.sentinel-hub.com` only

The webmap’s **WMS** layer uses a public **Configuration / instance** id in the OGC URL (e.g. `…/wms/03c5e367-…` on the old host). That id is **not** the same as M2M OAuth credentials.

- **Planet API key** (`PLAK…`) is for **`api.planet.com`**. It does **not** authenticate requests to **`services.sentinel-hub.com`** (where `POST /api/v1/statistics` lives), per [Planet: Authentication](https://docs.planet.com/develop/authentication/).

For **`vsl-sentinel-statistics`**, the Edge Function uses **OAuth2 client credentials** against:

`https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token`  

1. Open **[Planet Account — OAuth clients](https://insights.planet.com/account/#/)** (same account as Insights; sign in if prompted).
2. Find **OAuth Clients** (or open the **Account** app from Insights and go to the OAuth / M2M section).
3. Use **Create New** (or equivalent). Name the client (e.g. `vsl-supabase-stats`).
4. Set **expiration** (or “never” if you accept the extra risk) and any SPA / origin options as appropriate for a **server-side** (Supabase) secret.
5. **Create** the client, then **copy the Client ID and Client secret** when shown. The secret is often only shown **once** — store it in Supabase Edge Function **Secrets** only.
6. In Supabase: **Project → Edge Functions → `vsl-sentinel-statistics` → Secrets** set:
   - `SENTINEL_HUB_CLIENT_ID` = Client ID
   - `SENTINEL_HUB_CLIENT_SECRET` = Client secret  
7. Redeploy the function if your workflow requires secrets to be picked up, then test **Load satellite stats** from the map while signed in.

**Smoke test (machine):** (replace placeholders)

```bash
curl -sS -X POST "https://services.sentinel-hub.com/auth/realms/main/protocol/openid-connect/token" \
  -H "content-type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=client_credentials" \
  --data-urlencode "client_id=YOUR_OAUTH_CLIENT_ID" \
  --data-urlencode "client_secret=YOUR_OAUTH_CLIENT_SECRET"
```

A JSON response with `access_token` means the same credentials the function needs are valid. If this fails, fix OAuth client permissions or contact Planet support before changing app code.

4. In Supabase Auth settings, set Site URL:
   - `https://victoriasugarltd.xyz`
5. Add Redirect URLs:
   - `https://victoriasugarltd.xyz/login.html`
   - `https://victoriasugarltd.xyz/webmap.html`

## 3) Configure App Secrets

Update `config/app-config.js`:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`

## 4) Cloudflare Pages

1. Connect the new GitHub repository.
2. Build command: (leave blank for static site)
3. Build output directory: `/`
4. Custom domain: `victoriasugarltd.xyz`

## 5) Post-Deploy Smoke Test

- Login as ADMIN.
- Confirm basemap switcher works.
- Confirm `BLOCKS` and `PARCELS` render.
- Import sample CSV from `docs/csv_template.csv`.
- Draw one block + one parcel geometry and save.
- Search, locate, print, coordinate tools, and flags all operational.
