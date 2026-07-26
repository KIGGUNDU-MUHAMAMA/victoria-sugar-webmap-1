# Block Detail Panel — Full Field Inventory (grouped for collapsible sections)

Mirrors `plot-details-v2.md` one level up. A block is a rollup of its plots, so most groups here are aggregates/tables (counts, sums, breakdowns) rather than single stored values — computed from the plot-level records, not entered directly, unless marked otherwise. Backed by `blocks`, `block_managers`, `block_soil_profiles`, `block_season_summary`, `block_infrastructure`, `block_documents` (`VSL_System_Schema_and_Features_v4.md`, Part 3.2), plus rollups off `plots`, `plot_tasks`, and plot alerts.

Numbers of properties from Plots shall be fetched from the database plots table at query time from plots/plot_tasks, exposed as views.

## Details
- Block code
- Block name
- Estate name
- Number of plots (total_plots)
- Total area — sum of all plot areas (ha)
- Planted area / Fallow area / Reserved area (ha)
- Average plot size (ha)
- Dominant soil type
- Average slope %
- Irrigation type
- Water source
- Block manager
- Status (active/inactive)
- Location Link (Generated as a google link from the centroid cordinates)
- Notes
- Last updated by

## Status
Table — plot count by lifecycle status across the block:

| Status | Number of Plots |
|---|---|
| Vacant / Fallow | — |
| Planted | — |
| Growing | — |
| Regrowing (ratoon) | — |
| Harvested | — |
| Failed | — |

Rolled up from `plots.status` / `plot_seasons.growth_stage` for every plot in the block.

*Computed, not stored — query-time view (`v_block_status_counts`) grouping `plots.status` by `block_id`, not a counter column on `blocks`. Fixed small enum, so it could be a stored column too, but should be view/trigger-backed rather than updated manually — see schema doc Part 3.11.*

## Ratoon Number
Table — plot count by current ratoon number across the block:

| Ratoon Number | Number of Plots |
|---|---|
| 0 (Plant crop) | — |
| 1 | — |
| 2 | — |
| 3 | — |
| 4 | — |
| 5+ | — |

*Computed, not stored — query-time view (`v_block_ratoon_counts`) grouping `plots.current_ratoon_number` by `block_id`. Open-ended dimension (a plot can ratoon indefinitely), so no per-number counter columns — bucket 5+ to keep the table from growing every season.*

## Activities
Table — current activity load across the block, one row per activity type from `activities.md`:

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

Counts distinct plots in the block with an open/most-recent `plot_tasks.task_type` of each kind — same 18-item enum as Appendix A of the schema doc.

*Computed, not stored — query-time view (`v_block_activity_counts`) grouping `plot_tasks.task_type` by `block_id`. No counter columns: the activity list can grow, and per-category columns would need a migration + manual update logic every time one is added.*

## Alerts
Table — plot count by alert severity across the block. Unifies the former separate Flags and Alerts groups: every plot-level concern — pest/disease-sourced or manually raised — is now one Alert with one of these 3 severities.

| Alert Severity | Number of Plots |
|---|---|
| Critical | — |
| Warning | — |
| Information | — |

*Computed, not stored — query-time view (`v_block_alert_counts`) grouping each plot's current open alert severity by `block_id`. Alert type/source (pest/disease/scouting/satellite/manual) and full detail stay on the individual plot's Alerts group; this table is block-level triage only.*

## Season Summary
From `block_season_summary` — plan-vs-actual for the current season:

- Total plots in season / Planted plots / Harvested plots / Failed plots
- Target yield (tonnes) / Actual yield (tonnes)
- Total area planted (ha) / Total area harvested (ha)
- Average yield per hectare
- Total input cost / Total labor cost / Total harvest cost / Total cost
- Total revenue
- Gross profit
- Computed at

### Harvests
Rolled up from `plot_harvest` for plots in this block, current season:

- Total harvests logged (count of `plot_harvest` records)
- Total plots harvested (distinct plots)
- Total gross weight / Total net weight (tonnes)
- Average yield per hectare (harvested plots only)
- Average brix reading / sucrose %
- Last harvest date
- Next scheduled harvest date `(from harvest_schedule, if used)`

*Computed, not stored — query-time aggregate over `plot_harvest` filtered by `block_id` + `season_id`.*

### Planting
Rolled up from `plot_seasons` / `plot_tasks` (task_type = Planting) for this block, current season:

- Total plots planted
- Total area planted (ha)
- Planting date range (earliest → latest)
- Plots pending planting (fallow, not yet planted this season)
- Total cost of setts

*Computed, not stored — query-time aggregate over `plot_seasons` filtered by `block_id` + `season_id`.*

### Top 5 Cane Varieties
Table — most common current cane variety across plots in the block:

| Rank | Variety | Number of Plots |
|---|---|---|
| 1 | — | — |
| 2 | — | — |
| 3 | — | — |
| 4 | — | — |
| 5 | — | — |

*Computed, not stored — query-time view (`v_block_variety_counts`) grouping `plots.current_variety` (or `plot_seasons.cane_variety` for the active season) by `block_id`, ordered by count descending, limited to 5. Same reasoning as Activities/Alerts: variety names are an open set, so no per-variety counter columns.*

## Soil & Land
From `block_soil_profiles` — representative/composite sample for the block (distinct from the per-plot lab tests in each plot's Soil & Land group):

- Soil type, soil pH, nitrogen, phosphorus, potassium, organic matter %, texture, drainage class
- Tested by, test date, lab name, report link

## Manager
From `block_managers`:

- Manager name, role
- Assigned from / Assigned to
- Is active

## Infrastructure
From `block_infrastructure` — roads, pump houses, storage, etc. within the block:

- Infrastructure type, name
- Condition
- Notes

## Media
- Photos/videos — caption, GPS tag, captured by, captured date (block-level, or roll-up view of plot media across the block)

## Documents
From `block_documents`:

- Document type, title, file link, uploaded by, upload date

## Comments
Threaded comments at block level — author, text, type (observation/issue/recommendation/approval), resolved status, resolved by/at.

## History / Audit
- Change log — field changed, old/new value, changed by, changed at
- Plot-transfer history — plot moved in/out of this block, changed by, reason

---

Note: Estate detail panel can follow the same pattern one level up again — swapping block-level tables for `estate_financial_summary`, `estate_seasons`, `estate_soil_profiles`, `estate_infrastructure`, `estate_documents`, with block status/ratoon/activity/alert tables rolled up to estate scope.
