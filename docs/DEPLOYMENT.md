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

## Survey import (Edge Function)

1. Install [Supabase CLI](https://supabase.com/docs/guides/cli), then from the repo root:

   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase functions deploy vsl-survey-import
   ```

2. Optional hardening: in Supabase Dashboard → Edge Functions → `vsl-survey-import` → Secrets, set `SURVEY_IMPORT_SECRET` to a random string. Add the same value to `config/app-config.js` as `SURVEY_IMPORT_SECRET` so the browser sends header `x-vsl-survey-secret`. If the secret is **not** set, the function accepts requests with only the anon key (fine for internal testing; tighten for production).

3. `supabase/config.toml` sets `verify_jwt = false` for this function so **guest / anon** callers can preview and commit without signing in (writes use the service role inside the function, not the user’s session).

4. CSV format for survey points: see `docs/survey_points_template.csv`.
3. In Supabase Auth settings, set Site URL:
   - `https://victoriasugarltd.xyz`
4. Add Redirect URLs:
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
