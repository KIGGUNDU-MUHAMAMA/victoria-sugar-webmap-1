-- GeoJSON for block polygon (EPSG:4326) — used by Edge Function vsl-sentinel-statistics
-- so geometry is always valid JSON even when PostgREST returns EWKB/hex in some clients.
-- RLS: SECURITY INVOKER (same as direct table read).

create or replace function public.vsl_block_geojson_for_stats(p_block_id uuid)
returns json
language sql
stable
security invoker
set search_path = public
as $$
  select (st_asgeojson(b.geom::geometry))::json
  from public.vsl_blocks b
  where b.id = p_block_id
    and b.geom is not null;
$$;

revoke all on function public.vsl_block_geojson_for_stats(uuid) from public;
grant execute on function public.vsl_block_geojson_for_stats(uuid) to authenticated;
grant execute on function public.vsl_block_geojson_for_stats(uuid) to anon;
