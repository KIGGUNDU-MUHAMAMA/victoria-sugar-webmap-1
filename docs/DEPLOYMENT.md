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
