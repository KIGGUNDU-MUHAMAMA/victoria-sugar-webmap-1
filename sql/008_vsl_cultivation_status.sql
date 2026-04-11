-- Cultivation / crop-cycle status on blocks and parcels (map colours + optional harvest fields).
-- Run after 001–007. Updates vsl_get_features_bbox properties; adds vsl_set_cultivation_status RPC.

-- Parcels -------------------------------------------------------------------
alter table public.vsl_parcels
  add column if not exists cultivation_status text default 'not_in_cane',
  add column if not exists harvest_tonnes numeric(14, 3),
  add column if not exists last_harvest_date date,
  add column if not exists cultivation_notes text,
  add column if not exists cultivation_updated_at timestamptz,
  add column if not exists cultivation_updated_by uuid references auth.users (id) on delete set null;

update public.vsl_parcels
set cultivation_status = 'not_in_cane'
where cultivation_status is null or trim(cultivation_status) = '';

alter table public.vsl_parcels alter column cultivation_status set default 'not_in_cane';
alter table public.vsl_parcels alter column cultivation_status set not null;

alter table public.vsl_parcels drop constraint if exists vsl_parcels_cultivation_status_chk;
alter table public.vsl_parcels add constraint vsl_parcels_cultivation_status_chk check (
  cultivation_status in (
    'not_in_cane',
    'prepared',
    'planted',
    'standing',
    'harvested',
    'replant_renovation'
  )
);

-- Blocks --------------------------------------------------------------------
alter table public.vsl_blocks
  add column if not exists cultivation_status text default 'not_in_cane',
  add column if not exists harvest_tonnes numeric(14, 3),
  add column if not exists last_harvest_date date,
  add column if not exists cultivation_notes text,
  add column if not exists cultivation_updated_at timestamptz,
  add column if not exists cultivation_updated_by uuid references auth.users (id) on delete set null;

update public.vsl_blocks
set cultivation_status = 'not_in_cane'
where cultivation_status is null or trim(cultivation_status) = '';

alter table public.vsl_blocks alter column cultivation_status set default 'not_in_cane';
alter table public.vsl_blocks alter column cultivation_status set not null;

alter table public.vsl_blocks drop constraint if exists vsl_blocks_cultivation_status_chk;
alter table public.vsl_blocks add constraint vsl_blocks_cultivation_status_chk check (
  cultivation_status in (
    'not_in_cane',
    'prepared',
    'planted',
    'standing',
    'harvested',
    'replant_renovation'
  )
);

-- Bbox feed includes status fields for map styling --------------------------------
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
  with bbox as (
    select st_makeenvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326) as g
  )
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
      'cultivation_updated_at', b.cultivation_updated_at
    ) as properties,
    st_asgeojson(b.geom)::jsonb as geojson
  from public.vsl_blocks b, bbox
  where b.geom is not null and st_intersects(b.geom, bbox.g)
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
      'cultivation_updated_at', p.cultivation_updated_at
    ) as properties,
    st_asgeojson(p.geom)::jsonb as geojson
  from public.vsl_parcels p
  join public.vsl_blocks bk on bk.id = p.block_id, bbox
  where p.geom is not null and st_intersects(p.geom, bbox.g);
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

-- Write status (ADMIN + SURVEYOR only; uses auth.uid()) ---------------------------
create or replace function public.vsl_set_cultivation_status(
  p_layer_type text,
  p_feature_id uuid,
  p_status text,
  p_harvest_tonnes double precision,
  p_last_harvest_date date,
  p_notes text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  if auth.uid() is null then
    return jsonb_build_object('success', false, 'error', 'Sign in required.');
  end if;

  if not (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR')) then
    return jsonb_build_object('success', false, 'error', 'Your role cannot update cultivation status.');
  end if;

  if p_status is null
     or p_status not in (
       'not_in_cane',
       'prepared',
       'planted',
       'standing',
       'harvested',
       'replant_renovation'
     ) then
    return jsonb_build_object('success', false, 'error', 'Invalid cultivation status.');
  end if;

  if p_layer_type = 'PARCELS' then
    update public.vsl_parcels p
    set
      cultivation_status = p_status,
      harvest_tonnes = p_harvest_tonnes,
      last_harvest_date = p_last_harvest_date,
      cultivation_notes = nullif(trim(coalesce(p_notes, '')), ''),
      cultivation_updated_at = now(),
      cultivation_updated_by = auth.uid(),
      updated_at = now(),
      updated_by = auth.uid()
    where p.id = p_feature_id;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      return jsonb_build_object('success', false, 'error', 'Parcel not found.');
    end if;
  elsif p_layer_type = 'BLOCKS' then
    update public.vsl_blocks b
    set
      cultivation_status = p_status,
      harvest_tonnes = p_harvest_tonnes,
      last_harvest_date = p_last_harvest_date,
      cultivation_notes = nullif(trim(coalesce(p_notes, '')), ''),
      cultivation_updated_at = now(),
      cultivation_updated_by = auth.uid(),
      updated_at = now(),
      updated_by = auth.uid()
    where b.id = p_feature_id;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then
      return jsonb_build_object('success', false, 'error', 'Block not found.');
    end if;
  else
    return jsonb_build_object('success', false, 'error', 'layer_type must be BLOCKS or PARCELS.');
  end if;

  return jsonb_build_object('success', true);
end;
$$;

revoke all on function public.vsl_set_cultivation_status(text, uuid, text, double precision, date, text) from public;
grant execute on function public.vsl_set_cultivation_status(text, uuid, text, double precision, date, text) to authenticated;
grant execute on function public.vsl_set_cultivation_status(text, uuid, text, double precision, date, text) to service_role;
