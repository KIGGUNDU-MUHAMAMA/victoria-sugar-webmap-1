# Plot / Parcel Detail Panel — v2 (Land-State Properties Linked to Activities)

Base structure carried over from `plot-details.md`. What's new: every activity in `activities.md` was checked for properties that describe the **land itself** rather than **how the work was done**. Land-state properties get written back to the plot record when that activity is logged (so the panel always reflects current conditions without opening the activity log). Execution-only properties (team size, machinery, fuel, labor, cost breakdown, challenges, comments) stay in the activity/task record and are not duplicated here.

Each field below marked `← Activity Name` is populated automatically from that activity's log entry, not entered directly on the plot.

---

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
- Location Link (Generated as a google link from the centroid cordinates)
- Notes
- Last Updated by:

## Alerts
Unifies the former separate Warning Flag and Alerts groups — every plot-level concern, whether pest/disease-sourced from scouting/satellite or manually raised, is one Alert record with one of 3 severities. This is the plot-level source for the block panel's Alerts count table.

- Alert severity (Information / Warning / Critical)
- Alert type (Pest / Disease / General / Other)
- Alert name / description
- Source (Scouting / Satellite / Manual) `← Spraying, Scouting`
- Detected/Flagged date
- Detected/Flagged by
- Status (Open / Investigating / Resolved)
- Resolved by
- Resolved at
- Resolution notes

## Current Crop Cycle
- Current season name
- Current cane variety `← Planting`
- Current ratoon number (0 = plant crop, 1 = first ratoon, 2 = second ratoon, etc.) `← Planting`
- Growth stage (germination / tillering / grand growth / ripening / mature)
- Crop age — months and days since planting (computed from planting date, not a stored field)
- Planting date `← Planting`
- Planting method (manual/mechanical), seed source/variety, row spacing, planted by, planting cost — *(activity-only, stays in Planting log)*
- Current row / sett spacing `← Planting, Ridging, Furrowing, Cultivator` (whichever was logged most recently)
- Row orientation/direction `← Ridging`
- Expected germination date `← Planting`
- Expected harvest date
- Actual harvest date (filled once harvested) `← Harvesting`
- Earliest safe harvest date (spray date + withholding period) `← Spraying`
- Season status (planned/planted/growing/harvested/failed)
- Last Updated By:

## Activity (chronological log of field work)
- Current activity name
- Tasks / description.
- Date Started
- Progress (%)
- Activity History (A table showing at least 3 past activites and dates)
- Number of labour. *(activity-only)*
- Manager Name. *(activity-only)*
- Comment *(activity-only)*
- Challenges *(activity-only)*
- Logged By:
- Activity History (Table Showing Activities (Activity name and date))

## Harvest
- Harvest Date
- Harvest Weight (Tonnes)
- Harvest method
- Yield estimates
- Last Brix reading `← Harvesting`
- Logged By:
- Harvest History (Table Showing harvests (Harvest date and yield))

## Soil & Land
Lab-tested baseline (unchanged, from `plot_soil_tests`):
- pH, nitrogen, phosphorus, potassium, organic matter %, texture, lab name, report link, date tested

Field-observed current condition (updated by activity logs, not lab tests):
- Soil moisture (current) `← Ploughing, Harrow, Irrigation`
- Soil compaction level (current) `← Ripping`
- Soil pH (last field reading) `← Lime Application`
- Target soil pH `← Lime Application`
- Soil tilth / clod condition `← Harrow`
- Last soil amendment applied — type + date (lime / manure / fertilizer) `← Lime Application, Manuring, Fertilization`
- Last NPK ratio applied `← Fertilization`
- Current row/ridge/furrow profile (height, width, depth) `← Ridging, Furrowing`
- Current weed pressure `← Weeding, Spraying`
- Dominant weed type `← Weeding`
- Current pest/disease pressure (also raises an Alert) `← Spraying, Scouting`
- Residue management state (trashed/burnt/cleared) `← Trash Lining, Trash Collection`
- Land status marker (new land / fallow reclamation) `← Bush Clearing`

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

## Appendix — Activity-to-Land property map

For each activity in `activities.md`: which properties sync to the plot record (land state) vs. stay in the activity log only (execution detail).

| # | Activity | Land-linked (→ plot field) | Activity-only (stays in log) |
|---|---|---|---|
| 1 | Bush Clearing | Land type → Land status marker | Team size, Method, Machine type, Number of machines, Vegetation density, Clearing depth, Disposal method, Fuel used, Hours worked, Safety incidents, Challenges, Comments, Completion |
| 2 | Ploughing | Soil moisture condition → Soil moisture (current) | Plough type, Team size, Method, Number of machines, Implement used, Plough depth, Tractor horsepower, Number of passes, Fuel used, Hours worked, Operator name, Challenges, Comments, Completion |
| 3 | Harrow | Soil moisture condition → Soil moisture (current); Clod size before→after → Soil tilth | Type, Team size, Method, Number of machines, Harrow depth, Number of passes, Fuel used, Hours worked, Operator name, Challenges, Comments, Completion |
| 4 | Ripping | Soil compaction level (before) → Soil compaction (current) | Team size, Method, Number of machines, Ripping depth, Rip line spacing, Number of tynes/shanks, Tractor horsepower, Fuel used, Hours worked, Operator name, Challenges, Comments, Completion |
| 5 | Ridging | Spacing → Current row spacing; Ridge height/width → Current ridge profile; Row orientation → Row orientation | Team size, Method, Number of machines, Number of ridges formed, Implement used, Fuel used, Hours worked, Operator name, Challenges, Comments, Completion |
| 6 | Furrowing | Furrow depth → Current furrow profile; Furrow spacing → Current row spacing | Team size, Method, Number of machines, Number of furrows opened, Total furrow length, Implement used, Fuel used, Hours worked, Operator name, Challenges, Comments, Completion |
| 7 | Lime Application | Soil pH before → Soil pH (current); Target soil pH → Target soil pH; Lime type/name → Last soil amendment | Team size, Lime quantity, Application method, Application rate, Number of machines, Incorporation method, Supplier, Cost, Challenges, Comments, Completion |
| 8 | Planting | Cane variety → Current cane variety; Ratoon number → Current ratoon number; Row/sett spacing → Current row spacing; Planting date → Planting date; Expected germination date → Expected germination date | Team size, Number of setts, Method, Number of machines, Sett source, Planting depth, Seed rate, Basal fertilizer applied (y/n), Cost of setts, Weather condition, Challenges, Comments, Completion |
| 9 | Manuring | Manure type → Last soil amendment (manure); Manure source → amendment source | Team size, Quantity, Application rate, Method, Number of machines, Incorporation method, Cost, Supplier, Challenges, Comments, Completion |
| 10 | Fertilization | Fertilizer name → Last soil amendment (fertilizer); NPK ratio → Last NPK ratio applied | Team size, Quantity, Method, Number of machines, Application rate, Application type, Timing, Incorporation method, Cost, Supplier, Weather condition, Challenges, Comments, Completion |
| 11 | Weeding | Weed pressure → Current weed pressure; Dominant weed type → Dominant weed type | Team size, Method, Number of machines, Weeding round, Tools used, Labor productivity, Cost, Challenges, Comments, Completion |
| 12 | Cultivator | Row spacing → Current row spacing (confirm/adjust) | Team size, Method, Number of machines, Cultivation depth, Implement type, Number of passes, Fuel used, Hours worked, Operator name, Challenges, Comments, Completion |
| 13 | Spraying | Target pest/disease/weed → Current pest/disease pressure; Withholding period → Earliest safe harvest date | Team size, Medicine name, Quantity, Method, Number of machines, Chemical type, Active ingredient, Dilution rate, Water volume used, Application equipment, Weather condition, PPE used, Supplier, Batch/expiry date, Cost, Challenges, Comments, Completion |
| 14 | Irrigation | Soil moisture before/after → Soil moisture (current); Water source → Water source | Team size, Method, Litres pumped, Duration, Pump type/fuel used, Flow rate, Cost, Operator name, Challenges, Comments, Completion |
| 15 | Harvesting | Cane variety / Ratoon number → confirm current values; Actual harvest date → Actual harvest date; Brix reading → Last Brix reading | Team size, Method, Number of machines, Cutting method, Burnt/Green cane, Cutting crew name, Gross/Net weight, Yield (tonnes), Transport vehicle, Mill destination, Delivery ticket number, Weather condition, Challenges, Comments, Completion |
| 16 | Loading | — none — | Team size, Method, Number of machines, Loading equipment, Number of trucks/trailers, Truck registration, Transport company/driver, Load weight, Waiting time, Destination, Cost, Challenges, Comments, Completion |
| 17 | Trash Lining | Purpose → Residue management state | Team size, Method, Number of machines, Row spacing for trash lines, Trash quantity/coverage, Challenges, Comments, Completion |
| 18 | Trash Collection | Purpose → Residue management state | Team size, Method, Number of machines, Disposal method, Quantity collected, Transport vehicle, Cost, Challenges, Comments, Completion |

Fields repeated as "activity-only" across nearly every row (Team size, Method, Number of machines, Fuel used, Hours worked, Operator name, Challenges, Comments, Cost, Completion) match the "Candidate global properties" list already called out at the bottom of `activities.md` — confirms those belong on the shared activity/task component, not the plot record.

## Implementation notes (v3, as actually live in Supabase)

- Table: `vsl_parcels`. **Plot code** → `parcel_code` (independently auto-numbered); **Plot name** → `parcel_name` (from the imported description). `parcel_no`/`parcel_label` no longer exist.
- **Estate name** comes via `vsl_blocks.estate_id → vsl_estate`, not a stored column on the parcel or block.
- **Current Activity** → `parcels.current_activity_name`/`current_activity_id`, trigger-synced from `vsl_activities` on every insert/update/delete.
- Every `← Activity Name` land-linked field in this doc is written back to the plot by the app when that activity is logged, exactly as designed here; the activity-only fields on the right of the Appendix table live in `vsl_activities.activity_properties` (jsonb) — see `activities.md` for the implementation note on that table.
- **Current Crop Cycle** (ratoon number, planting date, cane variety, season status) is backed by `vsl_parcel_seasons`, an append-only history table auto-populated by a trigger — a new season row is created automatically when planting_date changes to a new value (replant), otherwise the current row is updated in place.
- **Harvest**: source of truth is `vsl_harvests` (append-only); latest-value fields in this panel are served by the `v_parcel_last_harvest` view.
- **Alerts**: table `vsl_alerts` (renamed from `vsl_flags`) with `severity`/`alert_type`/`alert_name`/`source`.
- `agronomy_notes`/`agronomy_data` were dropped from `vsl_parcels` — no properties here map to them.
