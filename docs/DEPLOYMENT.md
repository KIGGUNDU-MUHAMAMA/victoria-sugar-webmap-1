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
2. Run SQL file `sql/001_vsl_schema.sql`.
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
