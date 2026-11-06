-- 032: Support for the print tool's "Automatic selection" (pick an estate,
-- then switch individual blocks off).
--
-- 1. PARCELS features carried block_code but not block_id, so a plot could
--    only be tied back to its block by code — and a code is only unique
--    within an estate, so "Block 6" in two estates would collide. Printing
--    filters plots by the blocks the user left switched on, which has to be
--    exact. Adding the id is additive: nothing reads a property it doesn't
--    know about.
--
-- 2. The map's blocks layer only holds what's in the current viewport (see
--    the bbox loader), so the window cannot list an estate's blocks from it
--    — pan away and half of them are missing. vsl_estate_blocks_geojson
--    returns them all, with geometry, so the selection box can be fitted to
--    blocks that were never on screen.
--
-- The full body of vsl_get_features_bbox is reproduced here (it is a
-- CREATE OR REPLACE, not a patch); the only change is the 'block_id' line
-- in the PARCELS branch, marked below.

create or replace function public.vsl_get_features_bbox(
  p_min_lon double precision, p_min_lat double precision,
  p_max_lon double precision, p_max_lat double precision)
returns table(layer_type text, feature_id uuid, properties jsonb, geojson jsonb)
language sql
stable security definer
set search_path to 'public'
as $function$
  select
    'BLOCKS'::text as layer_type,
    b.id as feature_id,
    jsonb_build_object(
      'block_code', b.block_code,
      'block_name', b.block_name,
      'estate_id', b.estate_id,
      'estate_name', e.estate_name,
      'area_acres', b.area_acres,
      'geometry_status', b.geometry_status,
      'location_address', b.location_address,
      'soil_type', b.soil_type,
      'irrigation_type', b.irrigation_type,
      'soil_ph', b.soil_ph,
      'ownership', b.ownership,
      'harvest_tonnes', lh.harvest_tonnes,
      'last_harvest_date', lh.last_harvest_date,
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
  left join public.vsl_estate e on e.id = b.estate_id
  left join public.vsl_block_stats s on s.block_id = b.id
  left join public.v_block_last_harvest lh on lh.block_id = b.id
  where b.geom is not null
    and st_intersects(b.geom, st_makeenvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326))
  union all
  select
    'PARCELS'::text as layer_type,
    p.id as feature_id,
    jsonb_build_object(
      'block_code', bk.block_code,
      -- Added: the exact parent, for the print tool's block filter.
      'block_id', p.block_id,
      'parcel_code', p.parcel_code,
      'parcel_name', p.parcel_name,
      'area_acres', p.area_acres,
      'geometry_status', p.geometry_status,
      'cultivation_status', p.cultivation_status,
      'cultivation_notes', p.cultivation_notes,
      'cultivation_updated_at', p.cultivation_updated_at,
      'ratoon_number', p.ratoon_number,
      'planting_date', p.planting_date,
      'expected_harvest_date', p.expected_harvest_date,
      'current_activity_name', p.current_activity_name,
      'harvest_tonnes', ph.harvest_tonnes,
      'last_harvest_date', ph.last_harvest_date
    ) as properties,
    st_asgeojson(p.geom)::jsonb as geojson
  from public.vsl_parcels p
  join public.vsl_blocks bk on bk.id = p.block_id
  left join public.v_parcel_last_harvest ph on ph.parcel_id = p.id
  where p.geom is not null
    and st_intersects(p.geom, st_makeenvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326))
  union all
  select
    'TITLES'::text as layer_type,
    t.id as feature_id,
    jsonb_build_object(
      'title_name', t.title_name,
      'area_acres', t.area_acres,
      'document_url', t.document_url
    ) as properties,
    st_asgeojson(t.geom)::jsonb as geojson
  from public.vsl_title t
  where t.geom is not null
    and st_intersects(t.geom, st_makeenvelope(p_min_lon, p_min_lat, p_max_lon, p_max_lat, 4326));
$function$;

create or replace function public.vsl_estate_blocks_geojson(p_estate_id bigint)
returns table(id uuid, block_code text, block_name text, area_acres numeric, geojson jsonb)
language sql
stable security definer
set search_path to 'public'
as $function$
  select b.id, b.block_code, b.block_name, b.area_acres,
         st_asgeojson(b.geom)::jsonb
  from public.vsl_blocks b
  where b.estate_id = p_estate_id
    and b.geom is not null
  order by
    -- Numeric codes sort as numbers ("2" before "10"); anything else falls
    -- back to text, matching how the Search window orders blocks.
    case when b.block_code ~ '^[0-9]+$' then lpad(b.block_code, 12, '0') else b.block_code end;
$function$;

grant execute on function public.vsl_estate_blocks_geojson(bigint) to anon, authenticated;
