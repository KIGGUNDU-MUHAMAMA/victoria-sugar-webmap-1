# Estate Detail Panel — Full Field Inventory (grouped for collapsible sections)

Mirrors `block-details.md` one level up — but an estate isn't just a rollup like a block is. It carries its own direct properties (registration, location, ownership, climate) that don't exist at block or plot level, backed by `estates` itself rather than aggregated from below. Groups are split accordingly: **direct estate fields** (Details, Soil & Land, Climate & Remote Sensing, Manager & Access, Projects & Investment, Infrastructure, Media, Documents, Comments) vs. **rollups from every block/plot under this estate** (Status, Ratoon Number, Activities, Alerts, Blocks, Season Summary). Backed by `estates`, `estate_soil_profiles`, `estate_infrastructure`, `estate_documents`, `estate_seasons`, `estate_financial_summary` (`VSL_System_Schema_and_Features_v4.md`, Part 3.1), plus the admin/planning/remote-sensing/financial-depth tables from Part 2–3 that attach to `estate_id`.

Rollup tables use the same query-time view approach as the block panel — no per-category counter columns, computed from `plots`/`plot_tasks` filtered up through `blocks.estate_id`, not stored and manually kept in sync.

## Details
- Estate code
- Estate name
- Registration number
- Country / Region / District / Sub-county / Parish / Village
- Number of blocks (total_blocks) / Active blocks / Inactive blocks
- Number of plots (total_plots)
- Total area — sum of block areas (ha)
- Planted area / Fallow area / Reserved area (ha)
- Elevation range (min–max, m)
- Average rainfall (mm)
- Primary soil type
- Water sources
- Established date
- Current season
- Ownership type
- Owner name / Owner contact phone / Owner contact email
- Estate manager
- Status (active/inactive)
- Location Link (Generated as a google link from the centroid cordinates)
- Notes
- Last updated by

## Status
Table — plot count by lifecycle status across the whole estate:

| Status | Number of Plots |
|---|---|
| Vacant / Fallow | — |
| Planted | — |
| Growing | — |
| Regrowing (ratoon) | — |
| Harvested | — |
| Failed | — |

*Computed, not stored — query-time view (`v_estate_status_counts`), same shape as the block panel's Status table but grouped by `estate_id` across every block.*

## Ratoon Number
Table — plot count by current ratoon number across the whole estate:

| Ratoon Number | Number of Plots |
|---|---|
| 0 (Plant crop) | — |
| 1 | — |
| 2 | — |
| 3 | — |
| 4 | — |
| 5+ | — |

*Computed, not stored — query-time view (`v_estate_ratoon_counts`), estate-wide version of the block panel's Ratoon Number table.*

## Activities
Table — current activity load across the estate, one row per activity type from `activities.md`:

| Activity | Number of Plots |
|---|---|
| Bush Clearing | — |
| Ploughing | — |
| Harrow | — |
| Ripping | — |
| Ridging | — |
| Furrowing | — |
| Lime Application | — |
| Planting | — |
| Manuring | — |
| Fertilization | — |
| Weeding | — |
| Cultivator | — |
| Spraying | — |
| Irrigation | — |
| Harvesting | — |
| Loading | — |
| Trash Lining | — |
| Trash Collection | — |

*Computed, not stored — query-time view (`v_estate_activity_counts`), estate-wide version of the block panel's Activities table.*

## Alerts
Table — plot count by alert severity across the estate:

| Alert Severity | Number of Plots |
|---|---|
| Critical | — |
| Warning | — |
| Information | — |

*Computed, not stored — query-time view (`v_estate_alert_counts`), estate-wide version of the block panel's Alerts table.*

## Blocks
Table — every block in the estate with its key rollup stats, so the estate panel can drill down without opening each block individually:

| Block Name | Plots | Area (ha) | Dominant Status | Critical Alerts | Warning Alerts |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

*Computed, not stored — query-time view (`v_estate_block_summary`) joining `blocks` with the same Status/Alert rollups used in `block-details.md`, one row per block.*

## Season Summary
From `estate_seasons` + `estate_financial_summary` — plan-vs-actual for the current season, estate-wide:

- Season name / Season type
- Start date / Expected end date / Actual end date
- Target yield (tonnes) / Actual yield (tonnes)
- Season status
- Total input cost / Total labor cost / Total irrigation cost / Total harvest cost / Total operational cost
- Total revenue
- Gross profit
- Cost per tonne / Revenue per tonne
- Currency
- Recorded at

### Harvests
Rolled up from `plot_harvest` across every block in this estate, current season:

- Total harvests logged
- Total plots harvested (distinct plots)
- Total gross weight / Total net weight (tonnes)
- Average yield per hectare (harvested plots only)
- Average brix reading / sucrose %
- Last harvest date

*Computed, not stored — estate-wide version of the block panel's Harvests subsection.*

### Planting
Rolled up from `plot_seasons` across every block in this estate, current season:

- Total plots planted
- Total area planted (ha)
- Planting date range (earliest → latest)
- Plots pending planting (fallow, not yet planted this season)
- Total cost of setts

*Computed, not stored — estate-wide version of the block panel's Planting subsection.*

### Top 5 Cane Varieties
Table — most common current cane variety across every plot in the estate:

| Rank | Variety | Number of Plots |
|---|---|---|
| 1 | — | — |
| 2 | — | — |
| 3 | — | — |
| 4 | — | — |
| 5 | — | — |

*Computed, not stored — query-time view (`v_estate_variety_counts`), estate-wide version of the block panel's Top 5 Cane Varieties table.*

## Soil & Land
From `estate_soil_profiles` — a representative/composite sample for the estate as a whole (distinct from the per-block and per-plot soil tests):

- Soil type, soil pH, nitrogen, phosphorus, potassium, organic matter %, texture, drainage class
- Tested by, test date, lab name, report link

## Climate & Remote Sensing
Estate-only group — no block or plot equivalent. From `weather_station_readings` and `satellite_imagery_index` (`estate_id`):

- Weather station name
- Latest rainfall (mm), temp min/max (°C), humidity %, wind speed (km/h), solar radiation
- NDVI avg / min / max (estate-wide composite)
- EVI avg, moisture index
- Cloud cover %
- Last satellite image capture date / image link
- Drone survey — last flight date, orthomosaic link *(if flown at estate scope rather than per-block)*

## Manager & Access
- Estate manager (name, contact)
- User access list — who has view/edit/admin scope on this estate `(from user_estate_access)`

## Projects & Investment
Estate-only group — capital work and investment tracking, distinct from day-to-day `plot_tasks`. From `projects`, `project_milestones`, `investment_register` (`estate_id`):

- Active projects — table: project name, type, status, budget, actual spend, % complete, next milestone due
- Total capital invested (by investment type: land acquisition / equipment / infrastructure / research)
- Expected ROI %
- Funding source

## Infrastructure
From `estate_infrastructure` — estate-wide roads, weighbridges, factory buildings, major irrigation works, etc.:

- Infrastructure type, name
- Condition
- Construction date / Last maintained
- Notes

## Media
- Photos/videos — caption, GPS tag, captured by, captured date (estate-level, or roll-up view of block/plot media)

## Documents
From `estate_documents`:

- Document type, title, file link, uploaded by, upload date

## Comments
Threaded comments at estate level — author, text, type (observation/issue/recommendation/approval), resolved status, resolved by/at.

## History / Audit
- Change log — field changed, old/new value, changed by, changed at
- Block additions/removals — block added/removed from estate, changed by, date
- Ownership change history — old owner, new owner, changed by, date

---

Note: same drill-down convention as `block-details.md` — every rollup table here (Status, Ratoon Number, Activities, Alerts, Blocks, Harvests, Planting, Top 5 Cane Varieties) is a query-time view over `plots`/`plot_tasks`/`plot_harvest` joined up through `blocks.estate_id`, matching the `v_estate_rollup` recommendation in the schema doc's Part 3.11 (Analytics Views) — kept fast to read but never manually written, so it can't drift from the underlying plot data.
