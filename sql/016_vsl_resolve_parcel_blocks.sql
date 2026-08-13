-- Import tab -> "Automatically Choose Block" (#surveyAutoSelectCb).
--
-- After the preview step has produced polygon geometry for each plot, the
-- client sends them here and gets back, per plot, the block it falls inside
-- (or null). Nothing is written — this is a pure lookup so the user can
-- review/override the assignments in the table before saving.
--
-- Point-in-polygon rule: ST_PointOnSurface, not ST_Centroid. A centroid can
-- fall outside its own polygon when the plot is concave or L-shaped;
-- PointOnSurface is guaranteed to be inside it.
--
-- The response also carries a catalog of every block and estate, so the
-- client can build the Estate/Block override dropdowns from the same round
-- trip instead of issuing separate REST reads per row.

-- ------------------------------------------------------------------
-- ST_PointOnSurface throws on some malformed rings. Imported survey
-- geometry is exactly where malformed rings come from, and one bad plot
-- must not abort the lookup for the other 199 — so wrap it: try the
-- geometry as-is, repair it, then fall back to a centroid, and give up
-- with null rather than raising.
-- ------------------------------------------------------------------
create or replace function public.vsl_safe_point_on_surface(g geometry)
returns geometry
language plpgsql
immutable
parallel safe
as $function$
begin
  if g is null then
    return null;
  end if;
  begin
    return st_pointonsurface(case when st_isvalid(g) then g else st_makevalid(g) end);
  exception when others then
    begin
      return st_centroid(g);
    exception when others then
      return null;
    end;
  end;
end;
$function$;

comment on function public.vsl_safe_point_on_surface(geometry) is
  'ST_PointOnSurface with makevalid/centroid fallbacks; returns null instead of raising on unrecoverable geometry.';


create or replace function public.vsl_resolve_parcel_blocks(p_features jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_matches jsonb;
  v_blocks  jsonb;
  v_estates jsonb;
begin
  if p_features is null or jsonb_typeof(p_features) <> 'array' then
    return jsonb_build_object('success', false, 'error', 'p_features must be a JSON array');
  end if;

  with feats as (
    select
      f.ord,
      nullif(trim(f.elem->>'parcel_id'), '')          as parcel_id,
      case
        when f.elem ? 'geometry' and jsonb_typeof(f.elem->'geometry') = 'object'
        then st_setsrid(st_geomfromgeojson((f.elem->'geometry')::text), 4326)
      end                                              as geom
    from jsonb_array_elements(p_features) with ordinality as f(elem, ord)
  ),
  pts as (
    select ord, parcel_id, geom, public.vsl_safe_point_on_surface(geom) as pt
    from feats
  ),
  hits as (
    select
      p.ord,
      p.parcel_id,
      (p.geom is null)   as bad_geometry,
      hit.id             as block_id,
      hit.block_code,
      hit.block_name,
      hit.estate_id,
      est.estate_name
    from pts p
    -- Smallest containing block wins. Blocks should not overlap, but if two
    -- ever do (see the ST_Overlaps check in parcel_block_assignment.sql), the
    -- tighter one is the better answer and the result stays deterministic
    -- rather than depending on scan order.
    left join lateral (
      select b.id, b.block_code, b.block_name, b.estate_id
      from public.vsl_blocks b
      where p.pt is not null
        and b.geom is not null
        and st_contains(b.geom, p.pt)
      order by st_area(b.geom) asc, b.id
      limit 1
    ) hit on true
    left join public.vsl_estate est on est.id = hit.estate_id
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'ord',          h.ord,
             'parcel_id',    coalesce(h.parcel_id, 'Feature ' || h.ord::text),
             'matched',      (h.block_id is not null),
             'bad_geometry', h.bad_geometry,
             'block_id',     h.block_id,
             'block_code',   h.block_code,
             'block_name',   h.block_name,
             'estate_id',    h.estate_id,
             'estate_name',  h.estate_name
           ) order by h.ord
         ), '[]'::jsonb)
  into v_matches
  from hits h;

  -- Catalog for the override dropdowns. estate_id is nullable on vsl_blocks
  -- (there are blocks that belong to no estate), so those are returned with
  -- a null estate_id and the client files them under a "No estate" group —
  -- otherwise they would be unreachable from an estate-first cascade.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',          b.id,
             'block_code',  b.block_code,
             'block_name',  b.block_name,
             'estate_id',   b.estate_id,
             'estate_name', e.estate_name
           ) order by e.estate_name nulls last, b.block_code
         ), '[]'::jsonb)
  into v_blocks
  from public.vsl_blocks b
  left join public.vsl_estate e on e.id = b.estate_id
  where b.geom is not null;

  select coalesce(jsonb_agg(
           jsonb_build_object('id', e.id, 'estate_name', e.estate_name)
           order by e.estate_name
         ), '[]'::jsonb)
  into v_estates
  from public.vsl_estate e;

  return jsonb_build_object(
    'success', true,
    'matches', v_matches,
    'blocks',  v_blocks,
    'estates', v_estates
  );
end;
$function$;

comment on function public.vsl_resolve_parcel_blocks(jsonb) is
  'Read-only: for each previewed plot geometry, returns the block containing its ST_PointOnSurface, plus a block/estate catalog for override dropdowns.';

revoke all on function public.vsl_resolve_parcel_blocks(jsonb) from public;
grant execute on function public.vsl_resolve_parcel_blocks(jsonb) to anon;
grant execute on function public.vsl_resolve_parcel_blocks(jsonb) to authenticated;
grant execute on function public.vsl_resolve_parcel_blocks(jsonb) to service_role;

-- The lookup is a bbox-prefiltered spatial join; without this index it
-- degrades to a full scan of vsl_blocks per plot.
create index if not exists vsl_blocks_geom_gix on public.vsl_blocks using gist (geom);
