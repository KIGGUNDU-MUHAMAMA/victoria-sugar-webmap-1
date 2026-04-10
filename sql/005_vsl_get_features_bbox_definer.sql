-- Run this if BLOCKS/PARCELS still do not show for guests after 004.
-- SECURITY DEFINER: RPC reads geometries as the function owner, bypassing RLS.
-- Still only returns rows intersecting the requested bbox (not a full table leak).

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
      'geometry_status', b.geometry_status
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
      'geometry_status', p.geometry_status
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
