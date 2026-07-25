# Sugarcane Estate Intelligence Platform — Full Feature Set & Schema (v3)

Fair complaint — last round I anchored on the live `vsl_*` database and treated your fuller CSV spec as reference notes instead of the source of truth, so things like `estate_seasons`, `estate_financial_summary`, `block_season_summary`, `estate_soil_profiles`, `estate_infrastructure`, and `estate_documents` got dropped. This round starts clean: every table below is either yours verbatim (marked accordingly) or new. Nothing from your spec is cut. The current live webmap is set aside entirely — this is the target design for what the product should be, built fresh around GIS, remote sensing, project management, administration, and planning, not just retrofitted onto what exists.

## Part 1 — Confirming what you already specified (26 tables, all retained)

**Estate (6 tables):** `estates`, `estate_soil_profiles`, `estate_infrastructure`, `estate_documents`, `estate_seasons`, `estate_financial_summary`
**Block (6 tables):** `blocks`, `block_managers`, `block_soil_profiles`, `block_season_summary`, `block_infrastructure`, `block_documents`
**Plot (14 tables):** `plots`, `plot_ownership`, `plot_seasons`, `plot_soil_tests`, `plot_inputs`, `plot_irrigation`, `plot_scouting`, `plot_tasks`, `plot_harvest`, `plot_yield_estimates`, `plot_costs`, `plot_comments`, `plot_media`, `plot_documents`

Full field lists for all 26 are reproduced in Part 3 exactly as you specified — no field dropped or renamed.

## Part 2 — What was genuinely missing

Reading your schema against the brief ("GIS, mapping, remote sensing, project management, administration, planning, vast analytics"), six things weren't represented anywhere:

1. **No `users`/roles table exists** — every table references `user_id`, `created_by`, `estate_manager_id`, `block_manager_id`, `assigned_to`, etc., but the table those FKs point to was never defined, and there's no way to scope which estate/block a given user is even allowed to see.
2. **No revenue/sales transactions** — `estate_financial_summary` and `block_season_summary` both have a `total_revenue` field, but there's no underlying transaction table generating that number. You can't audit or trust a rollup that has no ledger behind it. Same asymmetry as before: costs are tracked line-by-line, revenue isn't.
3. **Nothing for project management** — capital projects (new block development, irrigation installation, road building, factory/weighbridge upgrades) are a different animal from `plot_tasks` (day-to-day field work). There's no milestone tracking, no budget-vs-actual on a project, no timeline.
4. **Nothing for administration** — no audit trail, no notifications, no system settings, no access-control table.
5. **Nothing for planning** — everything in your schema is *recording what happened* (scouting, harvest, costs). Nothing represents *what's planned* ahead of a season: budgets, replanting/ratoon-cycle scheduling, harvest logistics scheduling, labor/equipment planning.
6. **Nothing for remote sensing**, despite it being named explicitly in the brief — no satellite/NDVI table, no drone flight table, no weather station data, even though `plot_yield_estimates.method` already allows `'remote sensing'` as a value with nowhere for that data to live.

Part 3 fills all six without touching any of your 26.

## Part 3 — Complete schema catalog

### 3.1 Estate (yours, verbatim)

**estates** — `estate_id, estate_code, estate_name, registration_number, country, region, district, sub_county, parish, village, gps_centroid (POINT,4326), boundary_geom (POLYGON,4326), total_area_hectares, planted_area_hectares, fallow_area_hectares, reserved_area_hectares, total_blocks, total_plots, active_blocks, inactive_blocks, elevation_min_m, elevation_max_m, average_rainfall_mm, primary_soil_type, water_sources, established_date, current_season, ownership_type, owner_name, owner_contact_phone, owner_contact_email, estate_manager_id, status, notes, created_by, created_at, updated_at`

**estate_soil_profiles** — `soil_profile_id, estate_id, soil_type, soil_ph, organic_matter_pct, nitrogen_level, phosphorus_level, potassium_level, texture, drainage_class, tested_by, test_date, lab_name, results_url`

**estate_infrastructure** — `infra_id, estate_id, infra_type, infra_name, geom, condition, construction_date, last_maintained, notes`

**estate_documents** — `doc_id, estate_id, doc_type, document_title, file_url, uploaded_by, upload_date, description`

**estate_seasons** — `season_id, estate_id, season_name, season_type, start_date, expected_end_date, actual_end_date, target_yield_tonnes, actual_yield_tonnes, status, notes`

**estate_financial_summary** — `summary_id, estate_id, season_id, total_input_cost, total_labor_cost, total_irrigation_cost, total_harvest_cost, total_operational_cost, total_revenue, gross_profit, cost_per_tonne, revenue_per_tonne, currency, recorded_at`

### 3.2 Block (yours, verbatim)

**blocks** — `block_id, block_code, block_name, estate_id, boundary_geom, gps_centroid, total_area_hectares, planted_area_hectares, fallow_area_hectares, reserved_area_hectares, total_plots, active_plots, fallow_plots, harvested_plots, planted_plots, average_plot_size_ha, dominant_soil_type, average_slope_pct, irrigation_type, water_source, elevation_m, access_road, current_season_id, block_manager_id, status, notes, created_by, created_at, updated_at`

**block_managers** — `assignment_id, block_id, user_id, role, assigned_from, assigned_to, is_active`

**block_soil_profiles** — `soil_profile_id, block_id, soil_type, soil_ph, organic_matter_pct, nitrogen_level, phosphorus_level, potassium_level, texture, drainage_class, tested_by, test_date, lab_name, results_url`

**block_season_summary** — `summary_id, block_id, season_id, total_plots_in_season, planted_plots, harvested_plots, failed_plots, target_yield_tonnes, actual_yield_tonnes, total_area_planted_ha, total_area_harvested_ha, average_yield_per_ha, total_input_cost, total_labor_cost, total_harvest_cost, total_cost, total_revenue, gross_profit, computed_at`

**block_infrastructure** — `infra_id, block_id, infra_type, infra_name, geom, condition, notes`

**block_documents** — `doc_id, block_id, doc_type, document_title, file_url, uploaded_by, upload_date, description`

### 3.3 Plot (yours, verbatim)

**plots** — `plot_id, plot_code, plot_name, block_id, estate_id, boundary_geom, gps_centroid, area_hectares, perimeter_m, slope_pct, aspect_direction, elevation_m, soil_type, drainage_class, irrigation_type, water_source, ownership_type, owner_id, current_season_id, current_growth_stage, current_ratoon_number, current_variety, planting_date, expected_harvest_date, health_status, last_scouted_date, last_activity_date, status, notes, created_by, created_at, updated_at`

**plot_ownership** — `ownership_id, plot_id, owner_type, owner_full_name, national_id, contact_phone, contact_email, lease_start, lease_end, lease_rate_per_ha, currency, lease_terms, document_url, is_current, created_at`

**plot_seasons** — `plot_season_id, plot_id, season_id, block_id, cane_variety, ratoon_number, planting_date, expected_harvest_date, actual_harvest_date, growth_stage, target_yield_tonnes, actual_yield_tonnes, yield_per_hectare, season_status, failure_reason, notes`

**plot_soil_tests** — `test_id, plot_id, plot_season_id, soil_ph, nitrogen, phosphorus, potassium, organic_matter_pct, texture, sample_date, sampled_by, lab_name, results_url`

**plot_inputs** — `input_id, plot_id, plot_season_id, input_type, product_name, quantity, unit, application_method, applied_by, application_date, cost, currency, supplier, notes`

**plot_irrigation** — `irrigation_id, plot_id, plot_season_id, irrigation_type, water_source, volume_m3, duration_hours, irrigated_by, irrigation_date, cost, currency, notes`

**plot_scouting** — `scout_id, plot_id, plot_season_id, scouted_by, scout_date, growth_stage_observed, canopy_cover_pct, pest_present, pest_type, pest_severity, disease_present, disease_type, disease_severity, weed_pressure, health_rating, recommendations, gps_lat, gps_lng, created_at`

**plot_tasks** — `task_id, plot_id, plot_season_id, block_id, task_type, task_description, assigned_to, assigned_by, due_date, completed_date, status, estimated_cost, actual_cost, currency, notes, created_at`

**plot_harvest** — `harvest_id, plot_id, plot_season_id, harvest_date, gross_weight_tonnes, tare_weight_tonnes, net_weight_tonnes, yield_per_hectare, brix_reading, sucrose_pct, fiber_pct, pol_purity, cutting_crew, transport_vehicle, mill_destination, delivery_ticket_no, harvested_by, notes, created_at`

**plot_yield_estimates** — `estimate_id, plot_id, plot_season_id, estimated_by, estimate_date, method, estimated_yield_tonnes, confidence_level, notes`

**plot_costs** — `cost_id, plot_id, plot_season_id, cost_category, amount, currency, cost_date, recorded_by, reference_no, notes, created_at`

**plot_comments** — `comment_id, plot_id, plot_season_id, user_id, comment_text, comment_type, is_resolved, resolved_by, resolved_at, created_at`

**plot_media** — `media_id, plot_id, plot_season_id, scout_id, media_type, file_url, caption, gps_lat, gps_lng, captured_by, captured_at`

**plot_documents** — `doc_id, plot_id, doc_type, document_title, file_url, uploaded_by, upload_date, description`

### 3.4 Users & Administration *(new — the platform has no identity/access layer without this)*

**users** — `user_id, full_name, email, phone, role (ADMIN/ESTATE_MANAGER/BLOCK_MANAGER/AGRONOMIST/SURVEYOR/FIELD_OFFICER/FINANCE/INVESTOR/VIEWER), job_title, is_active, last_login_at, created_at`

**user_estate_access** — scopes who can see/edit which estate or block, so an investor or manager only sees their assigned scope: `access_id, user_id, estate_id (nullable), block_id (nullable), access_level (view/edit/admin), granted_by, granted_at`

**audit_log** — `log_id, table_name, record_id, action (insert/update/delete), changed_by, changed_at, old_values (jsonb), new_values (jsonb)`

**notifications** — `notification_id, user_id, type (task_due/harvest_due/comment_posted/budget_variance/pest_alert/project_milestone), message, related_entity_type, related_entity_id, is_read, created_at`

**system_settings** — `setting_key, setting_value, description, updated_by, updated_at` — currency defaults, units (ha vs acres), alert thresholds (e.g. soil pH flag range), season naming convention.

### 3.5 Project Management *(new — capital/infrastructure work, distinct from field-level `plot_tasks`)*

**projects** — `project_id, project_name, project_type (land_development/irrigation_installation/road_construction/building/equipment_acquisition/research), estate_id, block_id (nullable), description, planned_start_date, planned_end_date, actual_start_date, actual_end_date, budget_amount, actual_spend, currency, status (proposed/approved/in_progress/on_hold/completed/cancelled), project_manager_id, created_by, created_at`

**project_milestones** — `milestone_id, project_id, milestone_name, due_date, completed_date, status (pending/completed/delayed), notes`

**project_tasks** — `project_task_id, project_id, task_name, description, assigned_to, predecessor_task_id (nullable, for dependency chains), planned_start_date, planned_end_date, actual_start_date, actual_end_date, percent_complete, status, created_at`

**project_costs** — `cost_id, project_id, cost_category, amount, currency, cost_date, recorded_by, reference_no, notes`

### 3.6 Planning & Forecasting *(new — everything forward-looking, as opposed to the recording-only tables you had)*

**season_budgets** — plan-vs-actual at any level: `budget_id, estate_id, block_id (nullable), plot_id (nullable), season_id, cost_category, budgeted_amount, currency, approved_by, created_at`

**replanting_schedule** — sugarcane loses yield after several ratoon cycles, so replanting has to be planned ahead: `schedule_id, plot_id, current_ratoon_number, recommended_replant_season_id, recommended_reason (yield_decline/soil_depletion/disease), planned_replant_date, status (recommended/scheduled/completed), created_by`

**harvest_schedule** — logistics planning across many plots competing for the same cutting crews/vehicles: `schedule_id, plot_id, planned_harvest_date, assigned_crew, assigned_vehicle, assigned_mill, sequence_priority, status (scheduled/in_progress/completed/rescheduled), notes`

**labor_plan** — `plan_id, block_id, season_id, week_starting, planned_workers, planned_activity, notes`

### 3.7 Remote Sensing & Weather *(new — named explicitly in your brief, currently has zero tables)*

**satellite_imagery_index** — `index_id, plot_id (nullable), block_id (nullable), estate_id, capture_date, source (Sentinel-2/Landsat/PlanetScope), ndvi_avg, ndvi_min, ndvi_max, evi_avg, moisture_index, cloud_cover_pct, image_url, processed_at`

**drone_survey_flights** — `flight_id, block_id, flight_date, pilot, altitude_m, resolution_cm_per_px, orthomosaic_url, ndvi_map_url, notes`

**weather_station_readings** — `reading_id, estate_id, station_name, reading_date, rainfall_mm, temp_min_c, temp_max_c, humidity_pct, wind_speed_kmh, solar_radiation_mj`

**pest_disease_alerts** — surfaces `plot_scouting` findings and imagery anomalies as actionable alerts rather than buried rows: `alert_id, plot_id, source (scouting/satellite/manual), alert_type, severity, detected_at, status (open/investigating/resolved), resolved_by, resolved_at`

### 3.8 Financial Depth *(new — closes the revenue-ledger gap noted in Part 2)*

**plot_revenue** — the transaction table that should actually generate `total_revenue` in your summary tables: `revenue_id, plot_id, plot_season_id, harvest_id (FK, nullable), buyer_name, quantity_tonnes, price_per_tonne, total_amount, currency, payment_status (pending/partial/paid), sale_date, reference_no`

**mill_delivery_reconciliation** — closes the loop between what left the field and what the mill paid for: `reconciliation_id, harvest_id (FK), mill_weighbridge_ticket_no, mill_net_weight_tonnes, mill_grade, price_per_tonne, payment_reference, payment_date, variance_tonnes, notes`

**investment_register** — capital investment tracked separately from operational cost, so "investment monitoring" means something concrete: `investment_id, estate_id, block_id (nullable), project_id (nullable, FK), investment_type (land_acquisition/equipment/infrastructure/research), amount, currency, funding_source, invested_by, invested_at, expected_roi_pct, notes`

### 3.9 Equipment & Labor *(new)*

**equipment** — `equipment_id, name, type (tractor/harvester/irrigation_pump/vehicle), current_block_id (nullable), status (operational/maintenance/retired), purchase_date, purchase_cost, currency, notes`

**equipment_maintenance_log** — `log_id, equipment_id, service_date, service_type, cost, currency, performed_by, next_service_due, notes`

**labor_records** — `labor_id, plot_id, plot_season_id, task_id (FK, nullable), worker_name, worker_id_no, role, hours_worked, wage_rate, wage_amount, currency, work_date, recorded_by`

### 3.10 Collaboration Expansion *(new)*

You had `plot_comments` but nothing at estate or block level — stakeholders (investors, estate managers) usually comment at a higher level than a single plot:

**estate_comments** — `comment_id, estate_id, user_id, comment_text, comment_type, is_resolved, resolved_by, resolved_at, created_at`
**block_comments** — `comment_id, block_id, user_id, comment_text, comment_type, is_resolved, resolved_by, resolved_at, created_at`

(If you'd rather not triple the table count, these can collapse into one polymorphic `comments` table with `entity_type` + `entity_id` — trades a bit of query simplicity for a lot less schema repetition.)

### 3.11 Analytics Views *(new — computed, not stored, so summary fields never drift from the ledger)*

Your `estates`/`blocks` tables store `total_blocks`, `total_plots`, `active_plots`, etc. as plain columns, and `estate_financial_summary`/`block_season_summary` store rollups too. Recommendation: keep those columns for fast reads, but populate them from views/triggers rather than manual updates, so they can never silently go stale:

- `v_estate_rollup` — recomputes everything in `estate_financial_summary` plus land-use breakdown, live from `plot_costs`, `plot_revenue`, `plot_harvest`, `plots.status`.
- `v_block_rollup` — same shape as `block_season_summary`, live-computed.
- `v_plot_performance` — yield vs estimate accuracy, cost/ha, revenue/ha, margin, days-to-harvest, per plot per season.

## Part 4 — Feature list by pillar

**GIS & Mapping** — three-tier drill-down map (estate → block → plot), boundary capture/editing tools, layer toggling (soil type, irrigation type, health status, cultivation status), measurement and coordinate tools, basemap switching, offline-capable field capture.

**Remote Sensing** — NDVI/EVI overlays per plot and block, time-series vegetation health charts, drone orthomosaic viewer, automated pest/disease anomaly flagging from imagery, weather correlation with growth stage.

**Agronomy & Field Operations** — season lifecycle per plot (planned → planted → growing → harvested/failed), input/irrigation/scouting logging, task assignment and completion tracking, ratoon cycle tracking with replanting recommendations.

**Project Management** — capital project register with milestones, task dependencies and percent-complete tracking, project budget vs actual, Gantt-style timeline view.

**Administration** — role-based access scoped to estate/block, full audit trail on every write, notification center, configurable system settings (units, currency, alert thresholds).

**Planning & Forecasting** — season budgeting per plot/block/estate, replanting scheduling, harvest logistics scheduling (crew/vehicle/mill assignment), labor planning by week.

**Financial & Investment** — cost and revenue ledgers at plot level rolling up to block and estate, mill payment reconciliation, capital investment register with expected ROI, budget-vs-actual variance.

**Collaboration** — threaded, resolvable comments at estate/block/plot level, role-scoped visibility, notification on new comments/mentions.

**Reporting & Export** — PDF/Excel exports at any level, scheduled report generation, custom date-range reports.

## Part 5 — Analytics & dashboard specification

**Company-wide dashboard**: total estates/blocks/plots, total and planted area, production trailing-12-months, investment vs revenue vs profit, map colored by health status across all plots, open alerts/flags count.

**Estate dashboard**: land-use donut (planted/fallow/reserved), block comparison bar chart (yield/ha), cost category breakdown pie, revenue vs cost trend line by season, budget-vs-actual bars, upcoming harvest calendar, active projects timeline (Gantt).

**Block dashboard**: same shapes scoped down, plus soil profile summary cards and infrastructure condition list.

**Plot dashboard**: season timeline (planting → scouting events → harvest markers), NDVI trend line, yield-estimate-vs-actual comparison, cost breakdown pie, comment/activity feed, health rating history.

**Cross-cutting chart types to build**: KPI cards, line/area trend charts (yield, cost, revenue, NDVI over time), bar charts (block/plot comparison), donut/pie (land use, cost category), choropleth map (health/cultivation status), Gantt chart (projects), calendar/heatmap (harvest and task scheduling), scatter plot (yield vs rainfall or vs soil pH, to test agronomic hypotheses).

## Part 6 — Roles & permissions matrix

| Role | Estate/Block/Plot data | Agronomy entries | Costs/Revenue | Projects | Comments | Admin |
|---|---|---|---|---|---|---|
| ADMIN | full | full | full | full | full | full |
| ESTATE_MANAGER | edit own estate | full | full | full (own estate) | full | — |
| BLOCK_MANAGER | edit assigned blocks | full | view + own entries | view | full | — |
| AGRONOMIST | view | full | view | — | full | — |
| SURVEYOR | geometry capture only | — | — | — | comment | — |
| FIELD_OFFICER | view | create (tasks/scouting/inputs) | — | — | comment | — |
| FINANCE | view | view | full | view | comment | — |
| INVESTOR | view (scoped) | view | view (read-only) | view | comment | — |
| VIEWER | view (scoped) | view | — | — | — | — |

## Part 7 — Suggested phasing

**Phase 1**: Core hierarchy + all supporting tables from your original spec, users/access control, basic map.
**Phase 2**: Financial depth (revenue ledger, mill reconciliation, investment register), analytics views, dashboards.
**Phase 3**: Remote sensing integration (satellite/drone/weather), planning tables (budgets, replanting, harvest scheduling).
**Phase 4**: Project management module, equipment/labor tracking, notifications, audit trail, mobile offline capture.

This is a genuinely large system — six major pillars, 45+ tables. Phasing it out loud is what supports pricing it as a real platform rather than a one-off map.
