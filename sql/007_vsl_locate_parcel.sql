-- Locate a block alone (parcel null) or a parcel within a block (block + parcel number).
-- p_parcel_no NULL → return block geometry only (search_mode = block).
-- p_parcel_no set  → must find parcel (search_mode = parcel).

create or replace function public.vsl_locate_parcel(
  p_block_query text,
  p_parcel_no integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_block record;
  v_parcel record;
  v_q text;
begin
  v_q := trim(coalesce(p_block_query, ''));
  if v_q = '' then
    return jsonb_build_object('success', false, 'error', 'Enter a block code or block name.');
  end if;

  if p_parcel_no is not null and p_parcel_no < 1 then
    return jsonb_build_object('success', false, 'error', 'Plot number must be 1 or greater.');
  end if;

  select b.id, b.block_code, b.block_name, b.estate_name, b.expected_area_acres,
         st_asgeojson(b.geom)::jsonb as geojson
  into v_block
  from public.vsl_blocks b
  where b.geom is not null
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

  if v_block.id is null then
    return jsonb_build_object('success', false, 'error', 'No block matched that code or name.');
  end if;

  -- Block-only search: fly to block, no parcel.
  if p_parcel_no is null then
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

  select p.id, p.block_id, p.parcel_no, p.parcel_code, p.parcel_label, p.expected_area_acres,
         st_asgeojson(p.geom)::jsonb as geojson
  into v_parcel
  from public.vsl_parcels p
  where p.block_id = v_block.id
    and p.parcel_no = p_parcel_no
    and p.geom is not null;

  if v_parcel.id is null then
    return jsonb_build_object(
      'success', false,
      'error',
      format('Plot %s was not found in block %s.', p_parcel_no, v_block.block_code)
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
      'parcel_no', v_parcel.parcel_no,
      'parcel_code', v_parcel.parcel_code,
      'expected_area_acres', v_parcel.expected_area_acres,
      'geojson', v_parcel.geojson
    )
  );
end;
$$;

-- Signature includes default; grants target the (text, integer) overload used by RPC.
revoke all on function public.vsl_locate_parcel(text, integer) from public;
grant execute on function public.vsl_locate_parcel(text, integer) to anon;
grant execute on function public.vsl_locate_parcel(text, integer) to authenticated;
grant execute on function public.vsl_locate_parcel(text, integer) to service_role;
