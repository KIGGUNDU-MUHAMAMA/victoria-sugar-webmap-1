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

## Harvest
- Harvest Date
- Harvest Weight (Tonnes)
- Harvest method
- Yield estimates
- Logged By:

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

## Remote Sensing & Weather
- Latest NDVI/EVI value, capture date, source (Sentinel-2/drone)
- NDVI trend across the season
- Satellite image thumbnail
- Rainfall, temperature range, humidity for this season

## Media
- Photos/videos — caption, GPS tag, captured by, captured date

## Documents
- Survey plan, title extract, lease agreement, other — document type, title, file link, uploaded by, upload date

## Comments
- Threaded comments — author, text, type (observation/issue/recommendation/approval), resolved status, resolved by/at

## Alerts
- Pest/disease alerts — type, severity, source (scouting/satellite/manual), detected date, status, resolution notes

## History / Audit
- Change log — field changed, old/new value, changed by, changed at
- Block-transfer history — old block, new block, changed by, reason

---

Note: Block and Estate detail panels can mirror this same grouped/collapsible pattern one level up — swapping plot-level tables for `block_season_summary`/`block_soil_profiles`/etc. and `estate_financial_summary`/`estate_seasons`/etc.
