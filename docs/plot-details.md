# Plot / Parcel Detail Panel — Full Field Inventory (grouped for collapsible sections)

Your current popup shows 4 fields (plot label, block code, expected area, cultivation status). Below is everything the schema in `VSL_System_Schema_and_Features_v3.md` can support for this panel, organized into collapsible groups. Pick what you want — this is the full menu, not a recommendation to show all of it at once.

## Details
- Plot code
- Plot name
- Block name
- Estate name
- Current Activity
- Status (active/fallow/abandoned/under-prep)
- Crop Health status (good/watch/critical/unplanted/not in cane)
- Surveyed area (ha/ac)
- Perimeter (m)
- Slope %
- Aspect direction
- Elevation (m)
- Dominant soil type
- Drainage class
- Notes
- Last Updated by:

## Alerts
Unifies the former separate Warning Flag and Alerts groups — every plot-level concern, whether pest/disease-sourced from scouting/satellite or manually raised, is one Alert record with one of 3 severities.

- Alert severity (Information / Warning / Critical)
- Alert type (Pest / Disease / General / Other)
- Alert name / description
- Source (Scouting / Satellite / Manual)
- Detected/Flagged date
- Detected/Flagged by
- Status (Open / Investigating / Resolved)
- Resolved by
- Resolved at
- Resolution notes

## Current Crop Cycle
- Current season name
- Current cane variety
- Current ratoon number (0 = plant crop, 1 = first ratoon, 2 = second ratoon, etc.)
- Growth stage (germination / tillering / grand growth / ripening / mature)
- Crop age — months and days since planting (computed from planting date, not a stored field)
- Planting date 
- Planting method (manual/mechanical), 
- seed source/variety, 
- row spacing, planted by, 
- planting cost
- Expected harvest date, 
- Actual harvest date (filled once harvested)
- Season status (planned/planted/growing/harvested/failed)
- Last Updated By:

## Activity (chronological log of field work)
- Current activity name
- Tasks / description.
- Date Started
- Progress (%)
- Activity History (A table showing at least 3 past activites and dates)
- Number of labour.
- Manager Name.
- Comment
- Challenges
- Logged By:
- Activity History (Table Showing Activities (Activity name and date))

## Harvest
- Harvest Date
- Harvest Weight (Tonnes)
- Harvest method
- Yield estimates
- Logged By:
- Harvest History (Table Showing harvests (Harvest date and yield))

## Soil & Land
- pH, 
- nitrogen, 
- phosphorus, 
- potassium, 
- organic matter %, 
- texture, 
- lab name,
- report link
- Date tested.

## Media
- Photos/videos — caption, GPS tag, captured by, captured date

## Documents
- Survey plan, title extract, lease agreement, other — document type, title, file link, uploaded by, upload date

## Comments
- Threaded comments — author, text, type (observation/issue/recommendation/approval), resolved status, resolved by/at

## History / Audit
- Change log — field changed, old/new value, changed by, changed at
- Block-transfer history — old block, new block, changed by, reason

---

Note: Block and Estate detail panels can mirror this same grouped/collapsible pattern one level up — swapping plot-level tables for `block_season_summary`/`block_soil_profiles`/etc. and `estate_financial_summary`/`estate_seasons`/etc.

## Implementation notes (v3, as actually live in Supabase)

- Table: `vsl_parcels`. **Plot code** → `parcel_code` (independently auto-numbered via `vsl_next_parcel_code`, no longer derived from a parcel number). **Plot name** → `parcel_name` (populated from the exact imported description value on survey/CSV import). The old `parcel_no` and `parcel_label` columns are gone.
- **Estate name** is not a column on the plot or block anymore — `vsl_blocks.estate_id` links to `vsl_estate`, and the name is resolved via that join.
- **Current Activity** → `parcels.current_activity_name` (+ `current_activity_id`), kept in sync by a trigger whenever a row is inserted/updated/deleted in `vsl_activities`.
- `agronomy_notes` and `agronomy_data` were dropped — nothing in this panel maps to them; use the **Soil & Land** / **Current Crop Cycle** groups instead.
- **Alerts**: table `vsl_alerts` (renamed from `vsl_flags`), with `severity` (information/warning/critical), `alert_type`, `alert_name`, `source`.
- **Harvest**: `vsl_harvests` is the append-only source of truth (one row per harvest event); "Harvest Date"/"Harvest Weight" for the *latest* harvest are also exposed via the `v_parcel_last_harvest` view for places that just need the current snapshot.
- **Current Crop Cycle / ratoon number / planting date**: sourced from `vsl_parcel_seasons` (append-only, one row per crop cycle), auto-populated by a trigger whenever `vsl_parcels.planting_date`/`ratoon_number`/etc. change — no extra app writes needed.
- **Manager Name** under Activity is the person who executed/oversaw that specific task, i.e. `vsl_activities.assigned_to` (uuid → `vsl_profiles`); it is not the same as an estate/block manager (see `vsl_estate_managers` in `estate-details.md`).
