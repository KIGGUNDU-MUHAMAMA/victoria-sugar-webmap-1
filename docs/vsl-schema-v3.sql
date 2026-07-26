-- ============================================================
-- Victoria Sugar Webmap — Schema v3
-- Live introspection of Supabase project knhgliyghacvkeeptsfl (victoriasugar) on 2026-07-26, after migrations v3_m1 through v3_m8
-- This file documents the schema as actually implemented live.
-- It is a readable reference, not a from-scratch migration script
-- (it omits triggers/functions/RLS policies for brevity — see
-- the sql/ migration folder and Supabase dashboard for those).
-- ============================================================

-- ---------------------------------------------------------------
-- Table: vsl_profiles
-- App user profile, 1:1 with auth.users. role is ADMIN / SURVEYOR / MANAGMENT (sic - typo pre-existing in live check constraint).
-- RLS enabled: True   |   rows at export: 6
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_profiles (
    id                         uuid NOT NULL,
    email                      text NOT NULL,
    role                       text NOT NULL CHECK (role = ANY (ARRAY['ADMIN'::text, 'SURVEYOR'::text, 'MANAGMENT'::text])),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_profiles ADD CONSTRAINT vsl_profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id);

-- ---------------------------------------------------------------
-- Table: vsl_blocks
-- A block groups parcels within an estate. estate_name (free text) replaced by estate_id FK in v3. geometry_status is now a generated column.
-- RLS enabled: True   |   rows at export: 28
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_blocks (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    block_code                 text NOT NULL,
    block_name                 text NOT NULL,
    expected_area_acres        numeric,
    geom                       geometry,
    created_by                 uuid,
    updated_by                 uuid,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    cultivation_status         text NOT NULL DEFAULT 'not_in_cane'::text CHECK (cultivation_status = ANY (ARRAY['not_in_cane'::text, 'prepared'::text, 'planted'::text, 'standing'::text, 'harvested'::text, 'replant_renovation'::text])),
    cultivation_notes          text,
    cultivation_updated_at     timestamptz,
    cultivation_updated_by     uuid,
    location_address           text,
    soil_type                  text,
    irrigation_type            text CHECK ((irrigation_type = ANY (ARRAY['drip'::text, 'furrow'::text, 'overhead'::text, 'rainfed'::text, ''::text])) OR irrigation_type IS NULL),
    soil_ph                    numeric,
    manager_name               text,
    manager_phone              text,
    ownership                  text CHECK ((ownership = ANY (ARRAY['bought'::text, 'rented'::text, ''::text])) OR ownership IS NULL),
    estate_id                  bigint,
    geometry_status            text GENERATED ALWAYS AS (CASE     WHEN (geom IS NOT NULL) THEN 'captured'::text     ELSE 'pending'::text END) STORED,
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_blocks ADD CONSTRAINT vsl_blocks_estate_id_fkey FOREIGN KEY (estate_id) REFERENCES public.vsl_estate(id);
ALTER TABLE public.vsl_blocks ADD CONSTRAINT vsl_blocks_cultivation_updated_by_fkey FOREIGN KEY (cultivation_updated_by) REFERENCES auth.users(id);
ALTER TABLE public.vsl_blocks ADD CONSTRAINT vsl_blocks_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.vsl_blocks ADD CONSTRAINT vsl_blocks_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);

-- ---------------------------------------------------------------
-- Table: vsl_parcels
-- The core land unit ("plot"). v3: parcel_label -> parcel_name; parcel_no dropped, parcel_code is now independently auto-numbered (not derived); agronomy_notes/agronomy_data/harvest_tonnes/last_harvest_date/estate_name dropped; current_activity_id/current_activity_name and current_season_id added as trigger-maintained read caches.
-- RLS enabled: True   |   rows at export: 719
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_parcels (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    block_id                   uuid NOT NULL,
    parcel_code                text NOT NULL,
    parcel_name                text,
    expected_area_acres        numeric,
    geom                       geometry,
    created_by                 uuid,
    updated_by                 uuid,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    updated_at                 timestamptz NOT NULL DEFAULT now(),
    cultivation_status         text NOT NULL DEFAULT 'not_in_cane'::text CHECK (cultivation_status = ANY (ARRAY['not_in_cane'::text, 'prepared'::text, 'planted'::text, 'standing'::text, 'harvested'::text, 'replant_renovation'::text])),
    cultivation_notes          text,
    cultivation_updated_at     timestamptz,
    cultivation_updated_by     uuid,
    ratoon_number              integer DEFAULT 0,
    planting_date              date,
    expected_harvest_date      date,
    geometry_status            text GENERATED ALWAYS AS (CASE     WHEN (geom IS NOT NULL) THEN 'captured'::text     ELSE 'pending'::text END) STORED,
    current_activity_id        uuid,
    current_activity_name      text,
    current_season_id          uuid,
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_parcels ADD CONSTRAINT vsl_parcels_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.vsl_blocks(id);
ALTER TABLE public.vsl_parcels ADD CONSTRAINT vsl_parcels_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.vsl_parcels ADD CONSTRAINT vsl_parcels_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE public.vsl_parcels ADD CONSTRAINT vsl_parcels_cultivation_updated_by_fkey FOREIGN KEY (cultivation_updated_by) REFERENCES auth.users(id);
ALTER TABLE public.vsl_parcels ADD CONSTRAINT vsl_parcels_current_activity_id_fkey FOREIGN KEY (current_activity_id) REFERENCES public.vsl_activities(id);
ALTER TABLE public.vsl_parcels ADD CONSTRAINT vsl_parcels_current_season_id_fkey FOREIGN KEY (current_season_id) REFERENCES public.vsl_parcel_seasons(id);

-- ---------------------------------------------------------------
-- Table: vsl_alerts
-- Renamed from vsl_flags in v3. Unifies the old "warning flag" and "alert" concepts into one table with a severity field (information/warning/critical).
-- RLS enabled: True   |   rows at export: 0
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_alerts (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    layer_type                 text NOT NULL CHECK (layer_type = ANY (ARRAY['ESTATE'::text, 'BLOCKS'::text, 'PARCELS'::text])),
    target_id                  text NOT NULL,
    note                       text NOT NULL,
    status                     text NOT NULL DEFAULT 'open'::text CHECK (status = ANY (ARRAY['open'::text, 'investigating'::text, 'resolved'::text])),
    created_by                 uuid,
    resolved_by                uuid,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    resolved_at                timestamptz,
    severity                   text NOT NULL DEFAULT 'information'::text CHECK (severity = ANY (ARRAY['information'::text, 'warning'::text, 'critical'::text])),
    alert_type                 text CHECK (alert_type = ANY (ARRAY['pest'::text, 'disease'::text, 'general'::text, 'other'::text])),
    alert_name                 text,
    source                     text CHECK (source = ANY (ARRAY['scouting'::text, 'satellite'::text, 'manual'::text])),
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_alerts ADD CONSTRAINT vsl_flags_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth.users(id);
ALTER TABLE public.vsl_alerts ADD CONSTRAINT vsl_flags_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);

-- ---------------------------------------------------------------
-- Table: vsl_import_batches
-- One row per CSV/GPX survey import run.
-- RLS enabled: True   |   rows at export: 0
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_import_batches (
    id                         bigint NOT NULL DEFAULT nextval('vsl_import_batches_id_seq'::regclass),
    source_file_name           text NOT NULL,
    row_count                  integer NOT NULL DEFAULT 0,
    status                     text NOT NULL DEFAULT 'processing'::text CHECK (status = ANY (ARRAY['processing'::text, 'completed'::text, 'failed'::text])),
    imported_by                uuid,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    completed_at               timestamptz,
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_import_batches ADD CONSTRAINT vsl_import_batches_imported_by_fkey FOREIGN KEY (imported_by) REFERENCES auth.users(id);

-- ---------------------------------------------------------------
-- Table: vsl_import_rows
-- One row per raw imported record within an import batch, for audit/replay.
-- RLS enabled: True   |   rows at export: 0
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_import_rows (
    id                         bigint NOT NULL DEFAULT nextval('vsl_import_rows_id_seq'::regclass),
    batch_id                   bigint NOT NULL,
    row_number                 integer NOT NULL,
    raw_payload                jsonb NOT NULL,
    status                     text NOT NULL DEFAULT 'queued'::text CHECK (status = ANY (ARRAY['queued'::text, 'imported'::text, 'failed'::text])),
    error_message              text,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_import_rows ADD CONSTRAINT vsl_import_rows_batch_id_fkey FOREIGN KEY (batch_id) REFERENCES public.vsl_import_batches(id);

-- ---------------------------------------------------------------
-- Table: vsl_drone_images
-- Uploaded drone/orthomosaic image references (URL + name).
-- RLS enabled: True   |   rows at export: 2
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_drone_images (
    id                         bigint NOT NULL GENERATED BY DEFAULT AS IDENTITY,
    url                        text NOT NULL,
    name                       text NOT NULL,
    uploaded_at                timestamptz DEFAULT now(),
    PRIMARY KEY (id)
);

-- ---------------------------------------------------------------
-- Table: vsl_harvests
-- Append-only harvest history per parcel. Source of truth for harvest_tonnes/last_harvest_date, now surfaced via v_parcel_last_harvest / v_block_last_harvest views instead of flat columns.
-- RLS enabled: True   |   rows at export: 1
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_harvests (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    parcel_id                  uuid NOT NULL,
    harvest_date               date NOT NULL,
    gross_weight_tonnes        numeric NOT NULL,
    ratoon_at_harvest          integer,
    created_by                 uuid,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_harvests ADD CONSTRAINT vsl_harvests_parcel_id_fkey FOREIGN KEY (parcel_id) REFERENCES public.vsl_parcels(id);
ALTER TABLE public.vsl_harvests ADD CONSTRAINT vsl_harvests_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);

-- ---------------------------------------------------------------
-- Table: vsl_activities
-- v3 overhaul: activity_type + activity_name merged into a single activity_name column (18 canonical values). Added block_id/estate_id (denormalized for fast rollups), status/completion tracking, cost tracking, and activity_properties (jsonb) for type-specific fields (replaces ~150 sparse typed columns). Old free-text assigned_to preserved as assigned_to_legacy; new assigned_to is a uuid FK to vsl_profiles.
-- RLS enabled: True   |   rows at export: 1
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_activities (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    parcel_id                  uuid NOT NULL,
    activity_name              text NOT NULL CHECK (activity_name = ANY (ARRAY['Bush Clearing'::text, 'Ploughing'::text, 'Harrow'::text, 'Ripping'::text, 'Ridging'::text, 'Furrowing'::text, 'Lime Application'::text, 'Planting'::text, 'Manuring'::text, 'Fertilization'::text, 'Weeding'::text, 'Cultivator'::text, 'Spraying'::text, 'Irrigation'::text, 'Harvesting'::text, 'Loading'::text, 'Trash Lining'::text, 'Trash Collection'::text])),
    assigned_to_legacy         text,
    activity_date              date DEFAULT CURRENT_DATE,
    created_by                 uuid,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    block_id                   uuid,
    estate_id                  bigint,
    plot_season_id             uuid,
    task_description           text,
    status                     text DEFAULT 'planned'::text CHECK (status = ANY (ARRAY['planned'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text])),
    completion_unit            text CHECK (completion_unit = ANY (ARRAY['acres'::text, 'percent'::text])),
    completion_value           numeric,
    team_size                  integer,
    method                     text,
    number_of_machines         integer,
    due_date                   date,
    completed_date             date,
    estimated_cost             numeric,
    actual_cost                numeric,
    currency                   text,
    challenges                 text,
    comments                   text,
    activity_properties        jsonb DEFAULT '{}'::jsonb,
    assigned_to                uuid,
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_activities ADD CONSTRAINT vsl_activities_plot_season_id_fkey FOREIGN KEY (plot_season_id) REFERENCES public.vsl_parcel_seasons(id);
ALTER TABLE public.vsl_activities ADD CONSTRAINT vsl_activities_parcel_id_fkey FOREIGN KEY (parcel_id) REFERENCES public.vsl_parcels(id);
ALTER TABLE public.vsl_activities ADD CONSTRAINT vsl_activities_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
ALTER TABLE public.vsl_activities ADD CONSTRAINT vsl_activities_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.vsl_blocks(id);
ALTER TABLE public.vsl_activities ADD CONSTRAINT vsl_activities_estate_id_fkey FOREIGN KEY (estate_id) REFERENCES public.vsl_estate(id);
ALTER TABLE public.vsl_activities ADD CONSTRAINT vsl_activities_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.vsl_profiles(id);

-- ---------------------------------------------------------------
-- Table: vsl_report_recipients
-- Email recipients for the scheduled agronomy PDF report.
-- RLS enabled: True   |   rows at export: 1
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_report_recipients (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    email                      text NOT NULL,
    name                       text,
    created_by                 uuid,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    freq                       USER-DEFINED,
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_report_recipients ADD CONSTRAINT vsl_report_recipients_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);

-- ---------------------------------------------------------------
-- Table: vsl_estate
-- Top-level estate record. Address/geo/ownership fields added in v3; manager assignment now lives in vsl_estate_managers (not flat columns).
-- RLS enabled: True   |   rows at export: 4
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_estate (
    id                         bigint NOT NULL GENERATED BY DEFAULT AS IDENTITY,
    estate_name                text NOT NULL,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    estate_code                text,
    registration_number        text,
    country                    text,
    region                     text,
    district                   text,
    address                    text,
    geom                       geometry,
    gps_centroid               geometry,
    elevation_min_m            numeric,
    elevation_max_m            numeric,
    average_rainfall_mm        numeric,
    primary_soil_type          text,
    water_sources              text,
    established_date           date,
    ownership_type             text,
    owner_name                 text,
    owner_contact_phone        text,
    owner_contact_email        text,
    status                     text DEFAULT 'active'::text CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text])),
    notes                      text,
    created_by                 uuid,
    updated_at                 timestamptz DEFAULT now(),
    updated_by                 uuid,
    location_link              text GENERATED ALWAYS AS (CASE     WHEN (gps_centroid IS NOT NULL) THEN ((('https://maps.google.com/?q='::text || (st_y(gps_centroid))::text) || ','::text) || (st_x(gps_centroid))::text)     ELSE NULL::text END) STORED,
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_estate ADD CONSTRAINT vsl_estate_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);
ALTER TABLE public.vsl_estate ADD CONSTRAINT vsl_estate_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);

-- ---------------------------------------------------------------
-- Table: vsl_estate_managers
-- NEW in v3. Junction table linking a vsl_profiles user to an estate and/or a specific block as a manager/agronomist/supervisor.
-- RLS enabled: True   |   rows at export: 0
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_estate_managers (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    user_id                    uuid NOT NULL,
    estate_id                  bigint,
    block_id                   uuid,
    role                       text NOT NULL DEFAULT 'manager'::text,
    assigned_from              date DEFAULT CURRENT_DATE,
    assigned_to                date,
    is_active                  boolean NOT NULL DEFAULT true,
    created_by                 uuid,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_estate_managers ADD CONSTRAINT vsl_estate_managers_block_id_fkey FOREIGN KEY (block_id) REFERENCES public.vsl_blocks(id);
ALTER TABLE public.vsl_estate_managers ADD CONSTRAINT vsl_estate_managers_estate_id_fkey FOREIGN KEY (estate_id) REFERENCES public.vsl_estate(id);
ALTER TABLE public.vsl_estate_managers ADD CONSTRAINT vsl_estate_managers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.vsl_profiles(id);
ALTER TABLE public.vsl_estate_managers ADD CONSTRAINT vsl_estate_managers_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);

-- ---------------------------------------------------------------
-- Table: vsl_parcel_seasons
-- NEW in v3. Append-only planting/season history per parcel (one row per crop cycle). Auto-populated by a trigger on vsl_parcels (no app changes required to start capturing history).
-- RLS enabled: True   |   rows at export: 16
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_parcel_seasons (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    parcel_id                  uuid NOT NULL,
    season_name                text,
    cane_variety               text,
    ratoon_number              integer DEFAULT 0,
    planting_date              date,
    expected_harvest_date      date,
    actual_harvest_date        date,
    growth_stage               text,
    target_yield_tonnes        numeric,
    actual_yield_tonnes        numeric,
    yield_per_hectare          numeric,
    season_status              text CHECK (season_status = ANY (ARRAY['planned'::text, 'planted'::text, 'growing'::text, 'harvested'::text, 'failed'::text])),
    failure_reason             text,
    notes                      text,
    created_by                 uuid,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_parcel_seasons ADD CONSTRAINT vsl_parcel_seasons_parcel_id_fkey FOREIGN KEY (parcel_id) REFERENCES public.vsl_parcels(id);
ALTER TABLE public.vsl_parcel_seasons ADD CONSTRAINT vsl_parcel_seasons_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);

-- ---------------------------------------------------------------
-- Table: vsl_parcel_soil_tests
-- NEW in v3. Lab/field soil sample history per parcel (optionally tied to a season).
-- RLS enabled: True   |   rows at export: 0
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_parcel_soil_tests (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    parcel_id                  uuid NOT NULL,
    plot_season_id             uuid,
    soil_ph                    numeric,
    nitrogen                   numeric,
    phosphorus                 numeric,
    potassium                  numeric,
    organic_matter_pct         numeric,
    texture                    text,
    sample_date                date,
    sampled_by                 uuid,
    lab_name                   text,
    results_url                text,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_parcel_soil_tests ADD CONSTRAINT vsl_parcel_soil_tests_parcel_id_fkey FOREIGN KEY (parcel_id) REFERENCES public.vsl_parcels(id);
ALTER TABLE public.vsl_parcel_soil_tests ADD CONSTRAINT vsl_parcel_soil_tests_plot_season_id_fkey FOREIGN KEY (plot_season_id) REFERENCES public.vsl_parcel_seasons(id);
ALTER TABLE public.vsl_parcel_soil_tests ADD CONSTRAINT vsl_parcel_soil_tests_sampled_by_fkey FOREIGN KEY (sampled_by) REFERENCES public.vsl_profiles(id);

-- ---------------------------------------------------------------
-- Table: vsl_parcel_land_state_log
-- NEW in v3. Generic audit trail of land-state field changes on a parcel, optionally attributed to the activity that caused the change.
-- RLS enabled: True   |   rows at export: 0
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_parcel_land_state_log (
    id                         bigint NOT NULL DEFAULT nextval('vsl_parcel_land_state_log_id_seq'::regclass),
    parcel_id                  uuid NOT NULL,
    source_activity_id         uuid,
    field_name                 text NOT NULL,
    old_value                  text,
    new_value                  text,
    recorded_at                timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_parcel_land_state_log ADD CONSTRAINT vsl_parcel_land_state_log_parcel_id_fkey FOREIGN KEY (parcel_id) REFERENCES public.vsl_parcels(id);
ALTER TABLE public.vsl_parcel_land_state_log ADD CONSTRAINT vsl_parcel_land_state_log_source_activity_id_fkey FOREIGN KEY (source_activity_id) REFERENCES public.vsl_activities(id);

-- ---------------------------------------------------------------
-- Table: vsl_media
-- NEW in v3. Polymorphic photo/video attachments for estate/block/parcel via entity_type + entity_id.
-- RLS enabled: True   |   rows at export: 0
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_media (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    entity_type                text NOT NULL CHECK (entity_type = ANY (ARRAY['estate'::text, 'block'::text, 'parcel'::text])),
    entity_id                  text NOT NULL,
    scout_activity_id          uuid,
    media_type                 text CHECK (media_type = ANY (ARRAY['photo'::text, 'video'::text])),
    file_url                   text NOT NULL,
    caption                    text,
    gps_lat                    numeric,
    gps_lng                    numeric,
    captured_by                uuid,
    captured_at                timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_media ADD CONSTRAINT vsl_media_captured_by_fkey FOREIGN KEY (captured_by) REFERENCES public.vsl_profiles(id);
ALTER TABLE public.vsl_media ADD CONSTRAINT vsl_media_scout_activity_id_fkey FOREIGN KEY (scout_activity_id) REFERENCES public.vsl_activities(id);

-- ---------------------------------------------------------------
-- Table: vsl_documents
-- NEW in v3. Polymorphic document attachments for estate/block/parcel.
-- RLS enabled: True   |   rows at export: 0
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_documents (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    entity_type                text NOT NULL CHECK (entity_type = ANY (ARRAY['estate'::text, 'block'::text, 'parcel'::text])),
    entity_id                  text NOT NULL,
    doc_type                   text,
    document_title             text NOT NULL,
    file_url                   text NOT NULL,
    uploaded_by                uuid,
    upload_date                date DEFAULT CURRENT_DATE,
    description                text,
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_documents ADD CONSTRAINT vsl_documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.vsl_profiles(id);

-- ---------------------------------------------------------------
-- Table: vsl_comments
-- NEW in v3. Polymorphic threaded comments/observations for estate/block/parcel.
-- RLS enabled: True   |   rows at export: 0
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_comments (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    entity_type                text NOT NULL CHECK (entity_type = ANY (ARRAY['estate'::text, 'block'::text, 'parcel'::text])),
    entity_id                  text NOT NULL,
    user_id                    uuid NOT NULL,
    comment_text               text NOT NULL,
    comment_type               text CHECK (comment_type = ANY (ARRAY['observation'::text, 'issue'::text, 'recommendation'::text, 'approval'::text])),
    is_resolved                boolean NOT NULL DEFAULT false,
    resolved_by                uuid,
    resolved_at                timestamptz,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
);

ALTER TABLE public.vsl_comments ADD CONSTRAINT vsl_comments_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.vsl_profiles(id);
ALTER TABLE public.vsl_comments ADD CONSTRAINT vsl_comments_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.vsl_profiles(id);

-- ---------------------------------------------------------------
-- Table: vsl_infrastructure
-- NEW in v3. Physical infrastructure (roads, canals, stores, etc.) tied to an estate or block, with optional geometry.
-- RLS enabled: True   |   rows at export: 0
-- ---------------------------------------------------------------
CREATE TABLE public.vsl_infrastructure (
    id                         uuid NOT NULL DEFAULT gen_random_uuid(),
    entity_type                text NOT NULL CHECK (entity_type = ANY (ARRAY['estate'::text, 'block'::text])),
    entity_id                  text NOT NULL,
    infra_type                 text,
    infra_name                 text,
    geom                       geometry,
    condition                  text,
    construction_date          date,
    last_maintained            date,
    notes                      text,
    PRIMARY KEY (id)
);

-- ============================================================
-- VIEWS
-- ============================================================

-- v_block_last_harvest: Harvest rollup per block (sum of tonnes, max date across all parcels in the block), joined through vsl_parcels. Added in v3 for the same reason as v_parcel_last_harvest.
CREATE OR REPLACE VIEW public.v_block_last_harvest AS
SELECT p.block_id,
    max(h.harvest_date) AS last_harvest_date,
    sum(h.gross_weight_tonnes) AS harvest_tonnes
   FROM (vsl_harvests h
     JOIN vsl_parcels p ON ((p.id = h.parcel_id)))
  GROUP BY p.block_id;

-- v_parcel_last_harvest: Latest harvest per parcel (DISTINCT ON). Added in v3 so the app can keep reading harvest_tonnes/last_harvest_date after those flat columns were dropped from vsl_parcels.
CREATE OR REPLACE VIEW public.v_parcel_last_harvest AS
SELECT DISTINCT ON (parcel_id) parcel_id,
    harvest_date AS last_harvest_date,
    gross_weight_tonnes AS harvest_tonnes
   FROM vsl_harvests
  ORDER BY parcel_id, harvest_date DESC, created_at DESC;

-- vsl_block_stats: Pre-existing block-level rollup view (plot counts/areas by cultivation status + centroid). Unaffected by v3 except that its parcel join still works against the renamed columns.
CREATE OR REPLACE VIEW public.vsl_block_stats AS
SELECT b.id AS block_id,
    count(p.id) AS total_plots,
    COALESCE(sum(p.expected_area_acres), (0)::numeric) AS total_parcel_area_acres,
    COALESCE(sum(p.expected_area_acres) FILTER (WHERE (p.cultivation_status = 'harvested'::text)), (0)::numeric) AS harvested_plots_area_acres,
    COALESCE(sum(p.expected_area_acres) FILTER (WHERE ((p.cultivation_status = 'standing'::text) OR (p.cultivation_status = 'planted'::text) OR (p.cultivation_status = 'prepared'::text) OR (p.cultivation_status = 'replant_renovation'::text))), (0)::numeric) AS cultivated_plots_area_acres,
    count(p.id) FILTER (WHERE (p.cultivation_status = 'not_in_cane'::text)) AS idle_plots_count,
        CASE
            WHEN (b.geom IS NOT NULL) THEN st_y(st_centroid(b.geom))
            ELSE NULL::double precision
        END AS centroid_lat,
        CASE
            WHEN (b.geom IS NOT NULL) THEN st_x(st_centroid(b.geom))
            ELSE NULL::double precision
        END AS centroid_lon
   FROM (vsl_blocks b
     LEFT JOIN vsl_parcels p ON ((p.block_id = b.id)))
  GROUP BY b.id, b.geom;
