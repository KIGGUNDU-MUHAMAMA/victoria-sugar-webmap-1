# Survey import — beginner setup (after SQL + Edge Function)

Follow these in order. Use your **real** project URL and keys from the Supabase dashboard (not the short hex “fingerprints” the secrets list sometimes shows after saving).

Your project URL looks like: `https://knhgliyghacvkeeptsfl.supabase.co`  
(Replace with yours if different.)

---

## Step 1 — Confirm the database function exists

1. Open [Supabase Dashboard](https://supabase.com/dashboard) and select your **Victoria Sugar** project.
2. Click **SQL Editor** in the left sidebar.
3. Run this check:

```sql
select proname from pg_proc
where proname = 'vsl_survey_batch_upsert';
```

4. You should see one row. If you see **no rows**, open the file `sql/002_vsl_survey_batch.sql` from this repository, copy **all** of it, paste into SQL Editor, and click **Run**.

5. If saves failed with **missing FROM-clause entry for table "v_item"**, your database still has an old `002` definition. Copy the **latest** `sql/002_vsl_survey_batch.sql` from GitHub (`main` branch), paste into SQL Editor, and **Run** again (this replaces the function safely).

---

## Step 2 — Edge Function secrets (so “Save to database” can write)

The function `quick-api` runs on Supabase’s servers. It needs permission to talk to your database using the **service role** key.

1. In the dashboard, go to **Project Settings** (gear icon) → **API**.
2. Find:
   - **Project URL** — copy it (example: `https://knhgliyghacvkeeptsfl.supabase.co`).
   - **service_role** key — click **Reveal** and copy the long secret (starts with `eyJ` or similar). **Never** paste this into GitHub or into `webmap.html`.

3. Go to **Edge Functions** → click your function (**quick-api**) → **Secrets** (or **Manage secrets**).

4. Add or update these secrets (names must match exactly):

| Name | Value |
|------|--------|
| `SUPABASE_URL` | Your **Project URL** from step 2 (must start with `https://`) |
| `SUPABASE_SERVICE_ROLE_KEY` | The **service_role** key you copied |

5. Save. If the UI shows a **hash** instead of the value, that is normal — it means the secret is stored.

6. **Redeploy** the function after changing secrets (Dashboard **Deploy** again, or CLI `supabase functions deploy quick-api` from your project folder).

---

## Step 3 — Turn off JWT verification (for guest / no-login use)

1. **Edge Functions** → **quick-api** → open **Details** or **Settings**.
2. Find **Enforce JWT verification** (or similar) and turn it **OFF**.
3. Save.

This allows the **browser** to call the function with only the **anon** key. The function still uses the **service role** **inside** the server to run `vsl_survey_batch_upsert`, so writes do not depend on the user being logged in.

---

## Step 4 — Quick test from your computer (optional but useful)

Replace `YOUR_ANON_KEY` with the **anon public** key from **Settings → API** (safe for browsers; not the service role).

**PowerShell (Windows):**

```powershell
$body = '{"action":"preview_batch","crs":"EPSG:4326","rows":[{"parcel_id":"T1","point_number":1,"eastings":32.5,"northings":0.4,"description":""},{"parcel_id":"T1","point_number":2,"eastings":32.51,"northings":0.4,"description":""},{"parcel_id":"T1","point_number":3,"eastings":32.51,"northings":0.41,"description":""}]}'
Invoke-RestMethod -Uri "https://knhgliyghacvkeeptsfl.supabase.co/functions/v1/quick-api" -Method Post -Headers @{ Authorization = "Bearer YOUR_ANON_KEY"; apikey = "YOUR_ANON_KEY"; "Content-Type" = "application/json" } -Body $body
```

You should see JSON with `"success": true` and a `summary`.  
If you see **“Missing Supabase environment variables”**, repeat **Step 2** and redeploy.

---

## Step 5 — Saving **PARCELS** in the webmap

Preview can work even when save fails. The most common reason save does nothing for **PARCELS**:

1. **Parent block code** in the Survey panel must be **exactly** the same as an existing row in the database table **`vsl_blocks`**, column **`block_code`** (same spelling, same capitals).
2. Create that block first (draw a block on the map and save, or import a **BLOCKS** survey, or insert a row in **Table Editor → vsl_blocks**).

**BLOCKS** import uses each CSV `parcel_id` as the new `block_code` — no parent block is needed.

---

## Step 6 — If something still fails

1. Open the map in Chrome or Edge.
2. Press **F12** → **Console** tab.
3. Click **Save to database** again.
4. Look for lines starting with **`[Victoria Survey]`** — they include the real error and HTTP status.

---

## Step 7 — Deploy the latest website

After pulling the newest code from GitHub, your host (e.g. GitHub Pages) will pick up:

- Button label **Save to database**
- Clearer console messages for debugging

No change to `webmap.html` is required for the function name if `js/supabase-client.js` already sets `SURVEY_FUNCTION_NAME` / default `quick-api`.
