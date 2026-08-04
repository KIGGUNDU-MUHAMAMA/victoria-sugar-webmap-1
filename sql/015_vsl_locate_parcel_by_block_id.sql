-- Make vsl_locate_parcel unambiguous when multiple blocks across different
-- estates share the same block_code/block_name (e.g. two "BLOCK1"s — one
-- under KAAYA, one under Mazzi — which used to make the Estate -> Block ->
-- Parcel search zoom to the wrong estate).
--
-- Adds:
--   p_block_id  uuid    - when provided, looks the block up directly by its
--                         primary key instead of fuzzy-matching text. This is
--                         what the Estate -> Block -> Parcel dropdown search
--                         now sends, so it can never cross-match into the
--                         wrong estate.
--   p_estate_id bigint  - optional scope for the legacy free-text search path
--                         (p_block_query), so a duplicate code/name in a
--                         different estate isn't picked when an estate is
--                         known.
--
-- The old 2-argument overload (text, text) is dropped and replaced by this
-- 4-argument version (all new args have defaults, so existing callers that
-- only pass p_block_query/p_parcel_code keep working unchanged).
--
-- NOTE: the live schema had already drifted from sql/007_vsl_locate_parcel.sql
-- (that file still shows an older p_parcel_no-integer / vsl_blocks.estate_name
-- shape) — this migration builds on the function as it actually exists in
-- production today (p_block_query text, p_parcel_code text, joined to
-- vsl_estate via vsl_blocks.estate_id).

drop function if exists public.vsl_locate_parcel(text, text);

create or replace function public.vsl_locate_parcel(
  p_block_query text default null,
  p_parcel_code text default null,
  p_block_id uuid default null,
  p_estate_id bigint default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_block record;
  v_parcel record;
  v_q text;
begin
  if p_block_id is not null then
    select b.id, b.block_code, b.block_name, e.estate_name, b.expected_area_acres,
           st_asgeojson(b.geom)::jsonb as geojson
    into v_block
    from public.vsl_blocks b
    left join public.vsl_estate e on e.id = b.estate_id
    where b.id = p_block_id
      and b.geom is not null;
  else
    v_q := trim(coalesce(p_block_query, ''));
    if v_q = '' then
      return jsonb_build_object('success', false, 'error', 'Enter a block code or block name.');
    end if;

    select b.id, b.block_code, b.block_name, e.estate_name, b.expected_area_acres,
           st_asgeojson(b.geom)::jsonb as geojson
    into v_block
    from public.vsl_blocks b
    left join public.vsl_estate e on e.id = b.estate_id
    where b.geom is not null
      and (p_estate_id is null or b.estate_id = p_estate_id)
      and (
        trim(b.block_code) = v_q
        or lower(trim(b.block_name)) = lower(v_q)
        or b.block_name ilike '%' || v_q || '%'
        or b.block_code ilike '%' || v_q || '%'
      )
    order by
      case when trim(b.block_code) = v_q then 0
           when lower(trim(b.block_name)) = lower(v_q) then 1
           else 2 end,
      length(coalesce(b.block_name, ''))
    limit 1;
  end if;

  if v_block.id is null then
    return jsonb_build_object(
      'success', false,
      'error',
      case when p_block_id is not null then 'That block could not be found.'
           else 'No block matched that code or name.' end
    );
  end if;

  -- Block-only search: fly to block, no parcel.
  if p_parcel_code is null or trim(p_parcel_code) = '' then
    return jsonb_build_object(
      'success', true,
      'search_mode', 'block',
      'block', jsonb_build_object(
        'id', v_block.id,
        'block_code', v_block.block_code,
        'block_name', v_block.block_name,
        'estate_name', v_block.estate_name,
        'expected_area_acres', v_block.expected_area_acres,
        'geojson', v_block.geojson
      ),
      'parcel', null
    );
  end if;

  select p.id, p.block_id, p.parcel_code, p.parcel_name, p.expected_area_acres,
         st_asgeojson(p.geom)::jsonb as geojson
  into v_parcel
  from public.vsl_parcels p
  where p.block_id = v_block.id
    and trim(p.parcel_code) = trim(p_parcel_code)
    and p.geom is not null;

  if v_parcel.id is null then
    return jsonb_build_object(
      'success', false,
      'error',
      format('Plot %s was not found in block %s.', p_parcel_code, v_block.block_code)
    );
  end if;

  return jsonb_build_object(
    'success', true,
    'search_mode', 'parcel',
    'block', jsonb_build_object(
      'id', v_block.id,
      'block_code', v_block.block_code,
      'block_name', v_block.block_name,
      'estate_name', v_block.estate_name,
      'expected_area_acres', v_block.expected_area_acres,
      'geojson', v_block.geojson
    ),
    'parcel', jsonb_build_object(
      'id', v_parcel.id,
      'parcel_code', v_parcel.parcel_code,
      'parcel_name', v_parcel.parcel_name,
      'expected_area_acres', v_parcel.expected_area_acres,
      'geojson', v_parcel.geojson
    )
  );
end;
$function$;

revoke all on function public.vsl_locate_parcel(text, text, uuid, bigint) from public;
grant execute on function public.vsl_locate_parcel(text, text, uuid, bigint) to anon;
grant execute on function public.vsl_locate_parcel(text, text, uuid, bigint) to authenticated;
grant execute on function public.vsl_locate_parcel(text, text, uuid, bigint) to service_role;
