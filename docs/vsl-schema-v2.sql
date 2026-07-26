-- =========================================================================
-- VSL Estate Intelligence Platform — Schema v2 (proposed)
-- Generated from: live Supabase project 'victoriasugar' (knhgliyghacvkeeptsfl)
-- + activities.md, plot-details.md, plot-details-v2.md, block-details.md,
--   estate-details.md, VSL_System_Schema_and_Features_v4.md
--
-- This is a migration-style script: ALTER TABLE ... ADD COLUMN IF NOT EXISTS
-- for tables that already exist live, CREATE TABLE for genuinely new tables,
-- CREATE OR REPLACE VIEW for every rollup used by block-details.md /
-- estate-details.md. Nothing here has been applied to Supabase — review first.
--
-- NOT FIXED (flagged only, per your instruction not to change anything yet):
--   * public.spatial_ref_sys has Row Level Security DISABLED (Supabase advisory).
--     Remediation: ALTER TABLE public.spatial_ref_sys ENABLE ROW LEVEL SECURITY;
--   * vsl_estate.nanager_name is a typo for manager_name.
--   * vsl_profiles role check constraint has 'MANAGMENT' (typo for MANAGEMENT).
-- =========================================================================

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------
-- vsl_estate  [existing (extended)]
-- Top of the hierarchy. Currently the thinnest table in the live DB — no geometry, no location br
-- eakdown, no area. Extended here with everything estate-details.md called out as estate-only (re
-- gistration, location, ownership, climate anchors).
-- ---------------------------------------------------------------
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS estate_code text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS registration_number text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS region text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS district text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS sub_county text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS parish text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS village text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS geom geometry(Polygon,4326);
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS gps_centroid geometry(Point,4326);
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS total_area_hectares numeric;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS elevation_min_m numeric;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS elevation_max_m numeric;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS average_rainfall_mm numeric;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS primary_soil_type text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS water_sources text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS established_date date;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS ownership_type text CHECK (ownership_type IN ('owned','leased','other'));
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS owner_name text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS owner_contact_phone text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS owner_contact_email text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS estate_manager_id uuid;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS status text DEFAULT 'active' CHECK (status IN ('active','inactive'));
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS created_by uuid;
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.vsl_estate ADD COLUMN IF NOT EXISTS updated_by uuid;
ALTER TABLE public.vsl_estate ADD CONSTRAINT vsl_estate_estate_manager_id_fkey FOREIGN KEY (estate_manager_id) REFERENCES public.vsl_profiles(id);
ALTER TABLE public.vsl_estate ADD CONSTRAINT vsl_estate_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.vsl_estate ADD CONSTRAINT vsl_estate_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);

-- ---------------------------------------------------------------
-- vsl_blocks  [existing (extended)]
-- Already fairly rich live (cultivation_status enum, geom, soil/irrigation fields). Extended with
--  a proper estate_id FK (currently only a denormalized estate_name text) and a few block-details
-- .md fields not yet present.
-- ---------------------------------------------------------------
ALTER TABLE public.vsl_blocks ADD COLUMN IF NOT EXISTS estate_id bigint;
ALTER TABLE public.vsl_blocks ADD COLUMN IF NOT EXISTS gps_centroid geometry(Point,4326);
ALTER TABLE public.vsl_blocks ADD COLUMN IF NOT EXISTS water_source text;
ALTER TABLE public.vsl_blocks ADD COLUMN IF NOT EXISTS elevation_m numeric;
ALTER TABLE public.vsl_blocks ADD COLUMN IF NOT EXISTS access_road text;
ALTER TABLE public.vsl_blocks ADD COLUMN IF NOT EXISTS average_slope_pct numeric;
ALTER TABLE public.vsl_blocks ADD COLUMN IF NOT EXISTS drainage_class text;
ALTER TABLE public.vsl_blocks ADD CONSTRAINT vsl_blocks_estate_id_fkey FOREIGN KEY (estate_id) REFERENCES public.vsl_estate(id);
-- Deprecated columns kept for backward compatibility, not dropped: estate_name, harvest_tonnes, last_harvest_date

-- ---------------------------------------------------------------
-- vsl_parcels  [existing (extended)]
-- The 'plot' table (live naming is parcels — matches your original wording 'parcel/plot'). Alread
-- y has geom + agronomy_data jsonb, which is exactly the flexible-property pattern plot-details-v
-- 2.md needed. Extended with the full land-state field set that syncs from activities.md, plus fi
-- elds that were simply missing (current_variety!).
-- ---------------------------------------------------------------
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS gps_centroid geometry(Point,4326);
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS perimeter_m numeric;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS slope_pct numeric;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS aspect_direction text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS elevation_m numeric;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS dominant_soil_type text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS drainage_class text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS water_source text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS irrigation_type text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS ownership_type text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS health_status text CHECK (health_status IN ('good','watch','critical','unplanted','not_in_cane'));
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS current_variety text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS current_growth_stage text CHECK (current_growth_stage IN ('germination','tillering','grand_growth','ripening','mature'));
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS actual_harvest_date date;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS earliest_safe_harvest_date date;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS last_brix_reading numeric;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS current_season_id uuid;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS soil_moisture_current text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS soil_compaction_current text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS soil_ph_field_current numeric;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS target_soil_ph numeric;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS soil_tilth_condition text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS last_amendment_type text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS last_amendment_date date;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS last_npk_ratio_applied text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS current_row_spacing_m numeric;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS current_ridge_height_cm numeric;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS current_ridge_width_cm numeric;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS current_furrow_depth_cm numeric;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS current_weed_pressure text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS dominant_weed_type text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS current_pest_disease_pressure text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS residue_management_state text;
ALTER TABLE public.vsl_parcels ADD COLUMN IF NOT EXISTS land_status_marker text;
ALTER TABLE public.vsl_parcels ADD CONSTRAINT vsl_parcels_current_season_id_fkey FOREIGN KEY (current_season_id) REFERENCES public.vsl_parcel_seasons(id);
-- Deprecated columns kept for backward compatibility, not dropped: harvest_tonnes, last_harvest_date, estate_name

-- ---------------------------------------------------------------
-- vsl_parcel_seasons  [new]
-- History of planting cycles per parcel. Today vsl_parcels only stores the CURRENT ratoon_number/
-- planting_date/variety with no history — replanting overwrites the previous cycle with no trace.
--  This table is what makes planting history queryable, and what current_season_id on vsl_parcels
--  points at.
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_parcel_seasons (
    id uuid DEFAULT gen_random_uuid(),
    parcel_id uuid NOT NULL,
    season_name text,
    cane_variety text,
    ratoon_number integer DEFAULT 0,
    planting_date date,
    expected_harvest_date date,
    actual_harvest_date date,
    growth_stage text,
    target_yield_tonnes numeric,
    actual_yield_tonnes numeric,
    yield_per_hectare numeric,
    season_status text CHECK (season_status IN ('planned','planted','growing','harvested','failed')),
    failure_reason text,
    notes text,
    created_by uuid,
    created_at timestamptz DEFAULT now(),
    PRIMARY KEY (id)
);
ALTER TABLE public.vsl_parcel_seasons ADD CONSTRAINT vsl_parcel_seasons_parcel_id_fkey FOREIGN KEY (parcel_id) REFERENCES public.vsl_parcels(id);
ALTER TABLE public.vsl_parcel_seasons ADD CONSTRAINT vsl_parcel_seasons_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);

-- ---------------------------------------------------------------
-- vsl_activities  [existing (extended)]
-- Live table only has type/name/status_percent/assigned_to — none of the 18 activity types' speci
-- fic fields from activities.md have anywhere to live. Extended with the shared execution fields 
-- (team size, cost, challenges...) as typed columns and an activity_properties jsonb for the per-
-- type fields (plough depth, chemical type, ridge height, etc.), same pattern as vsl_parcels.agro
-- nomy_data.
-- ---------------------------------------------------------------
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS block_id uuid;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS plot_season_id uuid;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS task_description text;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS status text DEFAULT 'planned' CHECK (status IN ('planned','in_progress','completed','cancelled'));
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS completion_unit text CHECK (completion_unit IN ('acres','percent'));
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS completion_value numeric;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS team_size integer;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS method text;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS number_of_machines integer;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS assigned_to uuid;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS due_date date;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS completed_date date;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS estimated_cost numeric;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS actual_cost numeric;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS currency text;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS challenges text;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS comments text;
ALTER TABLE public.vsl_activities ADD COLUMN IF NOT EXISTS activity_properties jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.vsl_activities ADD CONSTRAINT vsl_activities_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.vsl_blocks(id);
ALTER TABLE public.vsl_activities ADD CONSTRAINT vsl_activities_plot_season_id_fkey FOREIGN KEY (plot_season_id) REFERENCES public.vsl_parcel_seasons(id);
ALTER TABLE public.vsl_activities ADD CONSTRAINT vsl_activities_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.vsl_profiles(id);
-- Deprecated columns kept for backward compatibility, not dropped: status_percent, assigned_to_name

-- ---------------------------------------------------------------
-- vsl_harvests  [existing (extended)]
-- Live table only tracks date/gross weight/ratoon. Extended with the quality and logistics fields
--  from the Harvest group in plot-details.md/v2 and block-details.md's Harvests rollup.
-- ---------------------------------------------------------------
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS plot_season_id uuid;
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS tare_weight_tonnes numeric;
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS net_weight_tonnes numeric;
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS yield_per_hectare numeric;
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS brix_reading numeric;
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS sucrose_pct numeric;
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS fiber_pct numeric;
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS pol_purity numeric;
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS cutting_crew text;
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS transport_vehicle text;
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS mill_destination text;
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS delivery_ticket_no text;
ALTER TABLE public.vsl_harvests ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.vsl_harvests ADD CONSTRAINT vsl_harvests_plot_season_id_fkey FOREIGN KEY (plot_season_id) REFERENCES public.vsl_parcel_seasons(id);

-- ---------------------------------------------------------------
-- vsl_parcel_soil_tests  [new]
-- Lab-tested soil history. Today soil_ph is a single flat value on vsl_blocks only — no per-parce
-- l lab history at all. This is the 'Soil & Land — lab-tested baseline' group from plot-details-v
-- 2.md.
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_parcel_soil_tests (
    id uuid DEFAULT gen_random_uuid(),
    parcel_id uuid NOT NULL,
    plot_season_id uuid,
    soil_ph numeric,
    nitrogen numeric,
    phosphorus numeric,
    potassium numeric,
    organic_matter_pct numeric,
    texture text,
    sample_date date,
    sampled_by uuid,
    lab_name text,
    results_url text,
    created_at timestamptz DEFAULT now(),
    PRIMARY KEY (id)
);
ALTER TABLE public.vsl_parcel_soil_tests ADD CONSTRAINT vsl_parcel_soil_tests_parcel_id_fkey FOREIGN KEY (parcel_id) REFERENCES public.vsl_parcels(id);
ALTER TABLE public.vsl_parcel_soil_tests ADD CONSTRAINT vsl_parcel_soil_tests_plot_season_id_fkey FOREIGN KEY (plot_season_id) REFERENCES public.vsl_parcel_seasons(id);
ALTER TABLE public.vsl_parcel_soil_tests ADD CONSTRAINT vsl_parcel_soil_tests_sampled_by_fkey FOREIGN KEY (sampled_by) REFERENCES public.vsl_profiles(id);

-- ---------------------------------------------------------------
-- vsl_parcel_land_state_log  [new]
-- Answers the open tracking question: the 'current_*' land-state fields on vsl_parcels (soil mois
-- ture, weed pressure, pest pressure, etc.) get overwritten every time a new activity is logged. 
-- Without this table you can see the LATEST value but never a trend. One row per change, so analy
-- tics can chart e.g. soil moisture or weed pressure over time per parcel.
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_parcel_land_state_log (
    id bigint,
    parcel_id uuid NOT NULL,
    source_activity_id uuid,
    field_name text NOT NULL,
    old_value text,
    new_value text,
    recorded_at timestamptz DEFAULT now(),
    PRIMARY KEY (id)
);
ALTER TABLE public.vsl_parcel_land_state_log ADD CONSTRAINT vsl_parcel_land_state_log_parcel_id_fkey FOREIGN KEY (parcel_id) REFERENCES public.vsl_parcels(id);
ALTER TABLE public.vsl_parcel_land_state_log ADD CONSTRAINT vsl_parcel_land_state_log_source_activity_id_fkey FOREIGN KEY (source_activity_id) REFERENCES public.vsl_activities(id);

-- ---------------------------------------------------------------
-- vsl_alerts  [renamed + extended (was vsl_flags)]
-- Unifies the plot-level Warning Flag + Alerts groups per the earlier conversation. Live vsl_flag
-- s has NO severity field at all today (only status open/resolved) — severity is the single most 
-- important addition here. layer_type is widened from BLOCKS/PARCELS to include ESTATE.
-- ---------------------------------------------------------------
ALTER TABLE public.vsl_flags RENAME TO vsl_alerts;
ALTER TABLE public.vsl_alerts ADD COLUMN IF NOT EXISTS severity text DEFAULT 'information' CHECK (severity IN ('information','warning','critical'));
ALTER TABLE public.vsl_alerts ADD COLUMN IF NOT EXISTS alert_type text CHECK (alert_type IN ('pest','disease','general','other'));
ALTER TABLE public.vsl_alerts ADD COLUMN IF NOT EXISTS alert_name text;
ALTER TABLE public.vsl_alerts ADD COLUMN IF NOT EXISTS source text CHECK (source IN ('scouting','satellite','manual'));
ALTER TABLE public.vsl_alerts DROP CONSTRAINT IF EXISTS vsl_flags_layer_type_check;
ALTER TABLE public.vsl_alerts ADD CONSTRAINT vsl_alerts_layer_type_check CHECK (layer_type IN ('ESTATE','BLOCKS','PARCELS'));
ALTER TABLE public.vsl_alerts DROP CONSTRAINT IF EXISTS vsl_flags_status_check;
ALTER TABLE public.vsl_alerts ADD CONSTRAINT vsl_alerts_status_check CHECK (status IN ('open','investigating','resolved'));

-- ---------------------------------------------------------------
-- vsl_media  [new]
-- Polymorphic photo/video table backing the Media group on all three panels (estate/block/parcel)
-- , per the schema doc's own suggestion to collapse repeated per-level tables into one entity_typ
-- e+entity_id table. vsl_drone_images stays separate (untargeted drone library) unless you want i
-- t folded in later.
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_media (
    id uuid DEFAULT gen_random_uuid(),
    entity_type text NOT NULL CHECK (entity_type IN ('estate','block','parcel')),
    entity_id text NOT NULL,
    scout_activity_id uuid,
    media_type text CHECK (media_type IN ('photo','video')),
    file_url text NOT NULL,
    caption text,
    gps_lat numeric,
    gps_lng numeric,
    captured_by uuid,
    captured_at timestamptz DEFAULT now(),
    PRIMARY KEY (id)
);
ALTER TABLE public.vsl_media ADD CONSTRAINT vsl_media_scout_activity_id_fkey FOREIGN KEY (scout_activity_id) REFERENCES public.vsl_activities(id);
ALTER TABLE public.vsl_media ADD CONSTRAINT vsl_media_captured_by_fkey FOREIGN KEY (captured_by) REFERENCES public.vsl_profiles(id);

-- ---------------------------------------------------------------
-- vsl_documents  [new]
-- Polymorphic documents table backing the Documents group on all three panels (survey plans, titl
-- e extracts, lease agreements, reports).
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_documents (
    id uuid DEFAULT gen_random_uuid(),
    entity_type text NOT NULL CHECK (entity_type IN ('estate','block','parcel')),
    entity_id text NOT NULL,
    doc_type text,
    document_title text NOT NULL,
    file_url text NOT NULL,
    uploaded_by uuid,
    upload_date date DEFAULT CURRENT_DATE,
    description text,
    PRIMARY KEY (id)
);
ALTER TABLE public.vsl_documents ADD CONSTRAINT vsl_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.vsl_profiles(id);

-- ---------------------------------------------------------------
-- vsl_comments  [new]
-- Polymorphic threaded comments backing the Comments group on all three panels.
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_comments (
    id uuid DEFAULT gen_random_uuid(),
    entity_type text NOT NULL CHECK (entity_type IN ('estate','block','parcel')),
    entity_id text NOT NULL,
    user_id uuid NOT NULL,
    comment_text text NOT NULL,
    comment_type text CHECK (comment_type IN ('observation','issue','recommendation','approval')),
    is_resolved boolean DEFAULT false,
    resolved_by uuid,
    resolved_at timestamptz,
    created_at timestamptz DEFAULT now(),
    PRIMARY KEY (id)
);
ALTER TABLE public.vsl_comments ADD CONSTRAINT vsl_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.vsl_profiles(id);
ALTER TABLE public.vsl_comments ADD CONSTRAINT vsl_comments_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.vsl_profiles(id);

-- ---------------------------------------------------------------
-- vsl_infrastructure  [new]
-- Polymorphic infrastructure table backing the Infrastructure groups on the estate/block panels (
-- roads, weighbridges, pump houses, factory buildings).
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_infrastructure (
    id uuid DEFAULT gen_random_uuid(),
    entity_type text NOT NULL CHECK (entity_type IN ('estate','block')),
    entity_id text NOT NULL,
    infra_type text,
    infra_name text,
    geom geometry(Point,4326),
    condition text,
    construction_date date,
    last_maintained date,
    notes text,
    PRIMARY KEY (id)
);

-- ---------------------------------------------------------------
-- vsl_profiles  [existing (unchanged)]
-- Users/roles table, already exists and is Supabase-Auth-integrated. Flagging one thing: the role
--  check constraint has a typo — 'MANAGMENT' should be 'MANAGEMENT'. Not fixed here since you sai
-- d no changes yet.
-- ---------------------------------------------------------------
-- (no new columns proposed for vsl_profiles)

-- ---------------------------------------------------------------
-- vsl_drone_images  [existing (unchanged)]
-- Untargeted drone image library.
-- ---------------------------------------------------------------
-- (no new columns proposed for vsl_drone_images)

-- ---------------------------------------------------------------
-- vsl_import_batches  [existing (unchanged)]
-- CSV/data import staging — batch header.
-- ---------------------------------------------------------------
-- (no new columns proposed for vsl_import_batches)

-- ---------------------------------------------------------------
-- vsl_import_rows  [existing (unchanged)]
-- CSV/data import staging — row detail.
-- ---------------------------------------------------------------
-- (no new columns proposed for vsl_import_rows)

-- ---------------------------------------------------------------
-- vsl_report_recipients  [existing (unchanged)]
-- Scheduled report subscriber list.
-- ---------------------------------------------------------------
-- (no new columns proposed for vsl_report_recipients)

-- =========================================================================
-- VIEWS — every rollup table in block-details.md / estate-details.md
-- (Status, Ratoon Number, Activities, Alerts, Top 5 Varieties, Harvests,
-- Planting). Query-time, not stored counter columns — see the earlier
-- discussion on why per-category columns on vsl_blocks/vsl_estate were
-- rejected (open-ended category sets, sync-drift risk).
-- =========================================================================

CREATE OR REPLACE VIEW v_block_status_counts AS
SELECT block_id, cultivation_status, COUNT(*) AS plot_count
FROM public.vsl_parcels
GROUP BY block_id, cultivation_status;

CREATE OR REPLACE VIEW v_block_ratoon_counts AS
SELECT block_id,
       CASE WHEN ratoon_number >= 5 THEN '5+' ELSE ratoon_number::text END AS ratoon_bucket,
       COUNT(*) AS plot_count
FROM public.vsl_parcels
GROUP BY block_id, CASE WHEN ratoon_number >= 5 THEN '5+' ELSE ratoon_number::text END;

CREATE OR REPLACE VIEW v_block_activity_counts AS
WITH latest_activity AS (
  SELECT DISTINCT ON (parcel_id) parcel_id, block_id, activity_type
  FROM public.vsl_activities
  WHERE status IN ('planned','in_progress')
  ORDER BY parcel_id, activity_date DESC, created_at DESC
)
SELECT block_id, activity_type, COUNT(*) AS plot_count
FROM latest_activity
GROUP BY block_id, activity_type;

CREATE OR REPLACE VIEW v_block_alert_counts AS
SELECT p.block_id, a.severity, COUNT(DISTINCT a.target_id) AS plot_count
FROM public.vsl_alerts a
JOIN public.vsl_parcels p ON p.id::text = a.target_id AND a.layer_type = 'PARCELS'
WHERE a.status != 'resolved'
GROUP BY p.block_id, a.severity;

CREATE OR REPLACE VIEW v_block_variety_counts AS
SELECT block_id, current_variety, COUNT(*) AS plot_count,
       RANK() OVER (PARTITION BY block_id ORDER BY COUNT(*) DESC) AS variety_rank
FROM public.vsl_parcels
WHERE current_variety IS NOT NULL
GROUP BY block_id, current_variety;
-- app queries: SELECT * FROM v_block_variety_counts WHERE block_id = :id AND variety_rank <= 5;

CREATE OR REPLACE VIEW v_block_harvest_summary AS
SELECT p.block_id,
       COUNT(h.id) AS total_harvests,
       COUNT(DISTINCT h.parcel_id) AS total_plots_harvested,
       SUM(h.gross_weight_tonnes) AS total_gross_weight_tonnes,
       SUM(h.net_weight_tonnes) AS total_net_weight_tonnes,
       AVG(h.yield_per_hectare) AS avg_yield_per_hectare,
       AVG(h.brix_reading) AS avg_brix_reading,
       MAX(h.harvest_date) AS last_harvest_date
FROM public.vsl_harvests h
JOIN public.vsl_parcels p ON p.id = h.parcel_id
GROUP BY p.block_id;

CREATE OR REPLACE VIEW v_block_planting_summary AS
WITH planted_parcels AS (
  SELECT DISTINCT ON (s.parcel_id) s.parcel_id, s.planting_date, p.block_id, p.expected_area_acres
  FROM public.vsl_parcel_seasons s
  JOIN public.vsl_parcels p ON p.id = s.parcel_id
  WHERE s.season_status IN ('planted','growing')
  ORDER BY s.parcel_id, s.planting_date DESC
)
SELECT block_id,
       COUNT(*) AS total_plots_planted,
       SUM(expected_area_acres) AS total_area_planted_acres,
       MIN(planting_date) AS earliest_planting_date,
       MAX(planting_date) AS latest_planting_date
FROM planted_parcels
GROUP BY block_id;

CREATE OR REPLACE VIEW v_estate_status_counts AS
SELECT b.estate_id, p.cultivation_status, COUNT(*) AS plot_count
FROM public.vsl_parcels p
JOIN public.vsl_blocks b ON b.id = p.block_id
GROUP BY b.estate_id, p.cultivation_status;

CREATE OR REPLACE VIEW v_estate_ratoon_counts AS
SELECT b.estate_id,
       CASE WHEN p.ratoon_number >= 5 THEN '5+' ELSE p.ratoon_number::text END AS ratoon_bucket,
       COUNT(*) AS plot_count
FROM public.vsl_parcels p
JOIN public.vsl_blocks b ON b.id = p.block_id
GROUP BY b.estate_id, CASE WHEN p.ratoon_number >= 5 THEN '5+' ELSE p.ratoon_number::text END;

CREATE OR REPLACE VIEW v_estate_activity_counts AS
WITH latest_activity AS (
  SELECT DISTINCT ON (a.parcel_id) a.parcel_id, b.estate_id, a.activity_type
  FROM public.vsl_activities a
  JOIN public.vsl_blocks b ON b.id = a.block_id
  WHERE a.status IN ('planned','in_progress')
  ORDER BY a.parcel_id, a.activity_date DESC, a.created_at DESC
)
SELECT estate_id, activity_type, COUNT(*) AS plot_count
FROM latest_activity
GROUP BY estate_id, activity_type;

CREATE OR REPLACE VIEW v_estate_alert_counts AS
SELECT b.estate_id, a.severity, COUNT(DISTINCT a.target_id) AS plot_count
FROM public.vsl_alerts a
JOIN public.vsl_parcels p ON p.id::text = a.target_id AND a.layer_type = 'PARCELS'
JOIN public.vsl_blocks b ON b.id = p.block_id
WHERE a.status != 'resolved'
GROUP BY b.estate_id, a.severity;

CREATE OR REPLACE VIEW v_estate_variety_counts AS
SELECT b.estate_id, p.current_variety, COUNT(*) AS plot_count,
       RANK() OVER (PARTITION BY b.estate_id ORDER BY COUNT(*) DESC) AS variety_rank
FROM public.vsl_parcels p
JOIN public.vsl_blocks b ON b.id = p.block_id
WHERE p.current_variety IS NOT NULL
GROUP BY b.estate_id, p.current_variety;

CREATE OR REPLACE VIEW v_estate_block_summary AS
SELECT b.estate_id, b.id AS block_id, b.block_name,
       COUNT(p.id) AS plot_count,
       SUM(p.expected_area_acres) AS area_acres,
       MODE() WITHIN GROUP (ORDER BY p.cultivation_status) AS dominant_status,
       COUNT(*) FILTER (WHERE a.severity = 'critical' AND a.status != 'resolved') AS critical_alerts,
       COUNT(*) FILTER (WHERE a.severity = 'warning' AND a.status != 'resolved') AS warning_alerts
FROM public.vsl_blocks b
LEFT JOIN public.vsl_parcels p ON p.block_id = b.id
LEFT JOIN public.vsl_alerts a ON a.target_id = p.id::text AND a.layer_type = 'PARCELS'
GROUP BY b.estate_id, b.id, b.block_name;

CREATE OR REPLACE VIEW v_estate_harvest_summary AS
SELECT b.estate_id,
       COUNT(h.id) AS total_harvests,
       COUNT(DISTINCT h.parcel_id) AS total_plots_harvested,
       SUM(h.gross_weight_tonnes) AS total_gross_weight_tonnes,
       SUM(h.net_weight_tonnes) AS total_net_weight_tonnes,
       AVG(h.yield_per_hectare) AS avg_yield_per_hectare,
       AVG(h.brix_reading) AS avg_brix_reading,
       MAX(h.harvest_date) AS last_harvest_date
FROM public.vsl_harvests h
JOIN public.vsl_parcels p ON p.id = h.parcel_id
JOIN public.vsl_blocks b ON b.id = p.block_id
GROUP BY b.estate_id;

CREATE OR REPLACE VIEW v_estate_planting_summary AS
WITH planted_parcels AS (
  SELECT DISTINCT ON (s.parcel_id) s.parcel_id, s.planting_date, b.estate_id, p.expected_area_acres
  FROM public.vsl_parcel_seasons s
  JOIN public.vsl_parcels p ON p.id = s.parcel_id
  JOIN public.vsl_blocks b ON b.id = p.block_id
  WHERE s.season_status IN ('planted','growing')
  ORDER BY s.parcel_id, s.planting_date DESC
)
SELECT estate_id,
       COUNT(*) AS total_plots_planted,
       SUM(expected_area_acres) AS total_area_planted_acres,
       MIN(planting_date) AS earliest_planting_date,
       MAX(planting_date) AS latest_planting_date
FROM planted_parcels
GROUP BY estate_id;
