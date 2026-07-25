# Victoria Sugar Limited — Full System Schema & Feature Spec (v2)

Your table list was strong — the season-anchor idea for `parcel_seasons` in particular is exactly right, and I'm keeping it as the backbone of the whole operational model. This version builds on it and closes the gaps that were making the system feel thin: there was no revenue/sales side (only costs — you can't monitor "investment" with costs alone), no remote sensing hook despite you already having Sentinel/drone code in the repo, no audit trail, no notifications, and no formal roles/permissions matrix. Those five additions are what turn this from "a map with some tables" into something a company pays real money for.

## 1. Hierarchy & anchoring principle

```
Estate (1) ──< Block (many) ──< Parcel/Plot (many) ──< Season (many, per parcel)
```

`parcel_seasons` is the anchor row for a growing cycle. Inputs, irrigation, scouting, media, costs, revenue, harvest and yield estimates all key off `(parcel_id, season_id)` together — this is what lets you compare season-over-season performance and roll numbers up cleanly to block and estate.

Note on terminology: your live database already uses `vsl_parcels` as the plot-level table. I'm keeping "parcel" as the table name and treating "Plot" as the UI-facing label for it — renaming a live production table is riskier than just aliasing it in the interface.

Unit convention: your estate schema commits to hectares. Your live DB currently stores `expected_area_acres`. Pick one before building further — I'd standardize on hectares (matches your new schema, matches how larger Ugandan sugar estates report land) and convert existing acre values on migration (1 acre = 0.4047 ha). Flag this as a decision to confirm before running the migration.

## 2. Design conventions

- PostGIS on every geometry column, stored in EPSG:4326 (WGS84) — required for web map compatibility.
- UUID primary keys throughout.
- Every table gets `created_by`, `created_at`, `updated_at` at minimum; anything financial or status-changing also gets covered by the audit log (section 3.11).
- Cost/revenue columns: use `amount` + a `currency` column defaulted to `UGX`, rather than baking the currency into the column name (`cost_ugx`) — cheaper to extend later if you ever price inputs in USD.
- Soft status fields (`active/inactive`, `planned/active/harvested/failed`, etc.) everywhere state matters — never hard-delete agronomic or financial history.

## 3. Complete table catalog

### 3.1 Core Hierarchy

**estates**
`estate_id, estate_code, estate_name, registration_number, country, region, district, sub_county, parish, village, gps_centroid (POINT,4326), boundary_geom (POLYGON,4326), total_area_hectares, planted_area_hectares, fallow_area_hectares, reserved_area_hectares, elevation_min_m, elevation_max_m, average_rainfall_mm, primary_soil_type, water_sources, established_date, current_season, ownership_type, owner_name, owner_contact_phone, owner_contact_email, estate_manager_id (FK users), status, notes, created_by, created_at, updated_at`

(`total_blocks`, `total_plots`, `active_blocks`, `inactive_blocks` from your draft move to the `estate_stats` view in 3.12 — computed values shouldn't live in the base table or they'll drift out of sync.)

**blocks**
`block_id, block_code, block_name, estate_id (FK), total_area_hectares, district, sub_county, parish, village, gps_centroid, boundary_geom, elevation_m, status (active/inactive), created_by, created_at, updated_at`

**parcels** (Plots)
`parcel_id, parcel_code, block_id (FK), parcel_name, area_hectares, boundary_geom, gps_centroid, perimeter_m, slope_pct, aspect_direction, status (active/fallow/abandoned), created_by, created_at, updated_at`

**parcel_seasons** — anchor table
`season_id, parcel_id, season_name, cane_variety, ratoon_number, planting_date, expected_harvest_date, actual_harvest_date, growth_stage, season_status (planned/active/harvested/failed), created_by, created_at`

### 3.2 Land & Physical Characteristics

**block_soil_profiles** — `soil_profile_id, block_id, soil_type, soil_ph, organic_matter_pct, nitrogen_level, phosphorus_level, potassium_level, texture, drainage_class, tested_by, test_date`

**parcel_soil_tests** — `test_id, parcel_id, season_id, soil_ph, nitrogen, phosphorus, potassium, organic_matter_pct, sampled_by, sample_date, lab_name, results_url`

**block_infrastructure** — `infra_id, block_id, infra_type (road/canal/water point/storage), name, geom, condition, notes`

### 3.3 People, Roles & Assignments

**profiles** (extend existing `vsl_profiles`) — add `full_name, phone, role` expanded to: `ADMIN, ESTATE_MANAGER, BLOCK_MANAGER, SURVEYOR, AGRONOMIST, FIELD_OFFICER, FINANCE, INVESTOR, VIEWER`

**block_managers** — `assignment_id, block_id, user_id, role (manager/supervisor/agronomist), assigned_from, assigned_to, is_active`

**parcel_ownership** — `ownership_id, parcel_id, owner_type (company/outgrower/leased), owner_name, national_id, contact_phone, lease_start, lease_end, lease_terms, document_url`

**equipment** — `equipment_id, name, type (tractor/harvester/irrigation pump/vehicle), block_id (nullable, current assignment), status (operational/maintenance/retired), purchase_date, purchase_cost, notes`

**equipment_maintenance_log** — `log_id, equipment_id, service_date, service_type, cost, performed_by, next_service_due, notes`

**labor_records** — `labor_id, parcel_id, season_id, task_id (FK, nullable), worker_name, worker_id_no, role, hours_worked, wage_rate, wage_amount, work_date, recorded_by`

### 3.4 Agronomy Operations

**parcel_inputs** — `input_id, parcel_id, season_id, input_type (fertilizer/herbicide/pesticide/lime), product_name, quantity, unit, application_method, applied_by, application_date, cost_amount, currency, supplier`

**parcel_irrigation** — `irrigation_id, parcel_id, season_id, irrigation_type, water_source, volume_m3, duration_hours, irrigated_by, irrigation_date, cost_amount, currency`

**parcel_scouting** — `scout_id, parcel_id, season_id, scouted_by, scout_date, growth_stage_observed, pest_present, pest_type, disease_present, disease_type, weed_pressure, canopy_cover_pct, health_rating (1-5), recommendations, gps_location`

**parcel_tasks** — `task_id, parcel_id, season_id, task_type, description, assigned_to, assigned_by, due_date, completed_date, status (pending/in_progress/completed/cancelled), cost_amount, currency, notes`

### 3.5 Harvest, Yield & Production

**parcel_harvest** — `harvest_id, parcel_id, season_id, harvest_date, gross_weight_tonnes, tare_weight_tonnes, net_weight_tonnes, brix_reading, sucrose_pct, fiber_pct, pol_purity, cutting_crew, transport_vehicle, mill_destination, delivery_ticket_no, harvested_by, notes`

**parcel_yield_estimates** — `estimate_id, parcel_id, season_id, estimated_by, estimate_date, method (visual/formula/remote_sensing), estimated_yield_tonnes, confidence_level, notes`

**mill_delivery_reconciliation** *(new)* — closes the loop between what left the field and what the mill actually paid for: `reconciliation_id, harvest_id (FK), mill_weighbridge_ticket_no, mill_net_weight_tonnes, mill_grade, price_per_tonne, payment_reference, payment_date, variance_tonnes (net_weight vs mill weight), notes`

### 3.6 Financial & Investment *(the section your draft was missing — this is the "investment monitoring" half of the brief)*

**parcel_costs** — `cost_id, parcel_id, season_id, cost_category (land_prep/planting/inputs/labor/irrigation/harvest/transport/equipment), amount, currency, recorded_by, cost_date, reference_no, notes`

**parcel_revenue** *(new)* — `revenue_id, parcel_id, season_id, harvest_id (FK, nullable), source (mill sale/direct sale/other), buyer_name, quantity_tonnes, price_per_tonne, total_amount, currency, payment_status (pending/partial/paid), sale_date, reference_no`

**season_budgets** *(new)* — plan-vs-actual is what makes "investment monitoring" credible to a client: `budget_id, parcel_id (nullable, can be block-level), block_id (nullable), season_id, cost_category, budgeted_amount, currency, approved_by, created_at`

**estate_stats / block_stats / parcel_season_stats** — see 3.12, these views compute cost, revenue, and profit rollups automatically rather than storing them.

### 3.7 Remote Sensing & Field Imagery *(new — you already have `sentinel-analytics.js` and `drone-image.js` in the repo; give them a real table instead of ad hoc calls)*

**satellite_imagery_index** — `index_id, parcel_id or block_id, capture_date, source (Sentinel-2/other), ndvi_avg, ndvi_min, ndvi_max, cloud_cover_pct, image_url, processed_at`

**drone_survey_flights** — `flight_id, block_id, flight_date, pilot, altitude_m, resolution_cm_per_px, orthomosaic_url, notes`

### 3.8 Media & Documents

**block_documents** — `doc_id, block_id, doc_type (survey certificate/title deed/map), file_url, uploaded_by, upload_date, description`

**parcel_documents** — `doc_id, parcel_id, doc_type (survey plan/title/agreement), file_url, uploaded_by, upload_date, description`

**parcel_media** — `media_id, parcel_id, season_id, scout_id (nullable), media_type (photo/video), file_url, caption, gps_lat, gps_lng, captured_by, captured_at`

### 3.9 Collaboration & Workflow

**parcel_comments** — `comment_id, parcel_id, season_id (nullable), user_id, comment_text, comment_type (observation/issue/recommendation/approval), is_resolved, resolved_by, resolved_at, created_at`

For estate- and block-level discussion, either add matching `estate_comments` / `block_comments` tables, or generalize into one polymorphic `comments` table with `entity_type` + `entity_id` — cleaner long-term, marginally more work in queries.

**notifications** *(new)* — `notification_id, user_id, type (task_due/harvest_due/comment_posted/flag_raised/low_soil_ph/budget_variance), message, related_entity_type, related_entity_id, is_read, created_at`

**vsl_flags** (existing — keep, extend to reference parcel/block/estate explicitly rather than the current generic `target_id text`)

### 3.10 Linking / History

**block_parcel_history** — `history_id, parcel_id, old_block_id, new_block_id, changed_by, changed_at, reason`

### 3.11 Audit Trail *(new — every enterprise system a client pays for has this)*

**audit_log** — `log_id, table_name, record_id, action (insert/update/delete), changed_by, changed_at, old_values (jsonb), new_values (jsonb)`

Populate via triggers on the tables that matter most first: `parcels`, `parcel_seasons`, `parcel_costs`, `parcel_revenue`, `parcel_harvest`.

### 3.12 Analytics Views (materialized for dashboard speed)

- `estate_stats` — total blocks, total plots, total/planted/fallow area, active vs inactive blocks, total production (tonnes), total cost, total revenue, profit, avg yield/ha, last harvest date.
- `block_stats` — same shape, one level down (you already have a version of this — extend it with cost/revenue/profit).
- `parcel_season_stats` — per-season yield/ha, cost/ha, revenue/ha, margin, days to harvest.

## 4. Roles & permissions matrix

| Role | Estates/Blocks/Parcels | Agronomy entries | Costs/Revenue | Comments | Admin |
|---|---|---|---|---|---|
| ADMIN | full | full | full | full | full |
| ESTATE_MANAGER | edit own estate | full | full | full | — |
| BLOCK_MANAGER | edit assigned blocks | full | view + own entries | full | — |
| SURVEYOR | geometry capture only | — | — | comment | — |
| AGRONOMIST | view | full | view | full | — |
| FIELD_OFFICER | view | create (tasks/scouting/inputs) | — | comment | — |
| FINANCE | view | view | full | comment | — |
| INVESTOR | view | view | view (read-only) | comment | — |
| VIEWER | view | view | — | — | — |

## 5. Dashboard specification

- **Estate level**: total area, planted vs fallow, block count, production (tonnes, trailing 12 months), total investment vs revenue vs profit, avg yield/ha trend, map colored by cultivation status, upcoming harvest calendar, open flags/tasks count.
- **Block level**: same shape scoped down, plus soil profile summary and infrastructure condition.
- **Parcel level**: season timeline (planting → scouting events → harvest), cost breakdown pie, yield vs estimate accuracy, NDVI trend if imagery available, comment/activity feed.

## 6. Feature list by module

GIS/Webmap (have it — extend to 3-tier drill-down), Estate/Block/Parcel management with rollups, Season & agronomy tracking, Harvest & mill reconciliation, Financial/investment tracking with budget-vs-actual, Remote sensing integration, Equipment & labor tracking, Stakeholder collaboration (comments, notifications, role-scoped visibility), Document/media library, Audit trail, Reporting & export (you have the start of this — `export-tools.js`, `farm-reports.js`), Mobile/offline field data capture.

## 7. Suggested phasing (also useful for pricing the work)

**Phase 1 (have mostly)**: auth/roles, blocks/parcels, geometry capture, CSV import, cultivation status, basic harvest/activity logging.
**Phase 2**: Estate tier + rollup views, financial tables (costs/revenue/budgets), roles expansion, audit log.
**Phase 3**: remote sensing tables + dashboard analytics, notifications, mill reconciliation.
**Phase 4**: equipment/labor tracking, mobile offline capture, compliance/certification tracking.

Phasing this explicitly is what usually justifies a bigger contract — it shows the client you're not underscoping a system this size into a flat fee.

## 8. Migration notes from the current live schema

- Add `vsl_estates`; add `estate_id` FK to `vsl_blocks`, backfill from the existing `estate_name` text, then drop that column once confirmed.
- Decide acres vs hectares before writing the migration (see section 1) — this touches every existing area column.
- `vsl_harvests` and `vsl_activities` map into `parcel_harvest` and `parcel_tasks`/`parcel_scouting` — rename/extend rather than duplicate.
- `vsl_flags` stays, gets `entity_type`/`entity_id` tightened up to match the new polymorphic comment pattern.
