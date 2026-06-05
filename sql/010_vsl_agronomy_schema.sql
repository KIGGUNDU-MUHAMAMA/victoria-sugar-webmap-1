-- Migration: 010_vsl_agronomy_schema.sql
-- Purpose: Expand blocks and parcels with agronomy properties, add historical tables, and create stats view.

-- 1. Add fields to vsl_blocks
alter table public.vsl_blocks
  add column if not exists location_address text,
  add column if not exists soil_type text,
  add column if not exists irrigation_type text check (irrigation_type in ('drip', 'furrow', 'overhead', 'rainfed', '') or irrigation_type is null),
  add column if not exists soil_ph numeric,
  add column if not exists manager_name text,
  add column if not exists manager_phone text,
  add column if not exists ownership text check (ownership in ('bought', 'rented', '') or ownership is null);

-- 2. Add fields to vsl_parcels
alter table public.vsl_parcels
  add column if not exists ratoon_number integer default 0,
  add column if not exists planting_date date,
  add column if not exists expected_harvest_date date,
  add column if not exists agronomy_data jsonb default '{}'::jsonb;

-- 3. Create historical Harvests table
create table if not exists public.vsl_harvests (
  id uuid primary key default gen_random_uuid(),
  parcel_id uuid not null references public.vsl_parcels(id) on delete cascade,
  harvest_date date not null,
  gross_weight_tonnes numeric(10, 2) not null,
  ratoon_at_harvest integer,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- 4. Create historical Activities table
create table if not exists public.vsl_activities (
  id uuid primary key default gen_random_uuid(),
  parcel_id uuid not null references public.vsl_parcels(id) on delete cascade,
  activity_type text not null,
  activity_name text,
  status_percent integer default 0 check (status_percent >= 0 and status_percent <= 100),
  assigned_to text,
  activity_date date default current_date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Indexes for performance
create index if not exists idx_vsl_harvests_parcel on public.vsl_harvests(parcel_id);
create index if not exists idx_vsl_activities_parcel on public.vsl_activities(parcel_id);

-- RLS for new tables
alter table public.vsl_harvests enable row level security;
alter table public.vsl_activities enable row level security;

drop policy if exists "harvests read all" on public.vsl_harvests;
create policy "harvests read all" on public.vsl_harvests for select to authenticated using (true);

drop policy if exists "harvests write admin_surveyor" on public.vsl_harvests;
create policy "harvests write admin_surveyor" on public.vsl_harvests for all to authenticated
using (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'))
with check (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));

drop policy if exists "activities read all" on public.vsl_activities;
create policy "activities read all" on public.vsl_activities for select to authenticated using (true);

drop policy if exists "activities write admin_surveyor" on public.vsl_activities;
create policy "activities write admin_surveyor" on public.vsl_activities for all to authenticated
using (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'))
with check (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));

-- 5. Create Block Statistics View
drop view if exists public.vsl_block_stats;
create view public.vsl_block_stats as
select 
  b.id as block_id,
  count(p.id) as total_plots,
  coalesce(sum(p.expected_area_acres), 0) as total_parcel_area_acres,
  coalesce(sum(p.expected_area_acres) filter (where p.cultivation_status = 'harvested'), 0) as harvested_plots_area_acres,
  coalesce(sum(p.expected_area_acres) filter (where p.cultivation_status = 'standing' or p.cultivation_status = 'planted' or p.cultivation_status = 'prepared' or p.cultivation_status = 'replant_renovation'), 0) as cultivated_plots_area_acres,
  count(p.id) filter (where p.cultivation_status = 'not_in_cane') as idle_plots_count,
  case 
    when b.geom is not null then st_y(st_centroid(b.geom)) 
    else null 
  end as centroid_lat,
  case 
    when b.geom is not null then st_x(st_centroid(b.geom)) 
    else null 
  end as centroid_lon
from public.vsl_blocks b
left join public.vsl_parcels p on p.block_id = b.id
group by b.id, b.geom;

-- 6. Update vsl_get_features_bbox to return all agronomy data
create or replace function public.vsl_get_features_bbox(
  p_min_lon double precision,
  p_min_lat double precision,
  p_max_lon double precision,
  p_max_lat double precision
)
returns table (
  layer_type text,
  feature_id uuid,
  properties jsonb,
  geojson jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  select
    'BLOCKS'::text as layer_type,
    b.id as feature_id,
    jsonb_build_object(
      'block_code', b.block_code,
      'block_name', b.block_name,
      'estate_name', b.estate_name,
      'expected_area_acres', b.expected_area_acres,
      'geometry_status', b.geometry_status,
      'cultivation_status', b.cultivation_status,
      'harvest_tonnes', b.harvest_tonnes,
      'last_harvest_date', b.last_harvest_date,
      'cultivation_notes', b.cultivation_notes,
      'cultivation_updated_at', b.cultivation_updated_at,
      'location_address', b.location_address,
      'soil_type', b.soil_type,
      'irrigation_type', b.irrigation_type,
      'soil_ph', b.soil_ph,
      'manager_name', b.manager_name,
      'manager_phone', b.manager_phone,
      'ownership', b.ownership,
      'total_plots', s.total_plots,
      'total_parcel_area_acres', s.total_parcel_area_acres,
      'harvested_plots_area_acres', s.harvested_plots_area_acres,
      'cultivated_plots_area_acres', s.cultivated_plots_area_acres,
      'idle_plots_count', s.idle_plots_count,
      'centroid_lat', s.centroid_lat,
      'centroid_lon', s.centroid_lon
    ) as properties,
    st_asgeojson(b.geom)::jsonb as geojson
  from public.vsl_blocks b
  left join public.vsl_block_stats s on s.block_id = b.id
  where b.geom is not null 
    and st_intersects(b.geom, st_makeenvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326))
  union all
  select
    'PARCELS'::text as layer_type,
    p.id as feature_id,
    jsonb_build_object(
      'block_code', bk.block_code,
      'parcel_no', p.parcel_no,
      'parcel_code', p.parcel_code,
      'parcel_label', p.parcel_label,
      'expected_area_acres', p.expected_area_acres,
      'geometry_status', p.geometry_status,
      'cultivation_status', p.cultivation_status,
      'harvest_tonnes', p.harvest_tonnes,
      'last_harvest_date', p.last_harvest_date,
      'cultivation_notes', p.cultivation_notes,
      'cultivation_updated_at', p.cultivation_updated_at,
      'ratoon_number', p.ratoon_number,
      'planting_date', p.planting_date,
      'expected_harvest_date', p.expected_harvest_date,
      'agronomy_data', p.agronomy_data
    ) as properties,
    st_asgeojson(p.geom)::jsonb as geojson
  from public.vsl_parcels p
  join public.vsl_blocks bk on bk.id = p.block_id
  where p.geom is not null 
    and st_intersects(p.geom, st_makeenvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326));
$$;

grant execute on function public.vsl_get_features_bbox(
  double precision,
  double precision,
  double precision,
  double precision
) to anon;
grant execute on function public.vsl_get_features_bbox(
  double precision,
  double precision,
  double precision,
  double precision
) to authenticated;
grant execute on function public.vsl_get_features_bbox(
  double precision,
  double precision,
  double precision,
  double precision
) to service_role;
