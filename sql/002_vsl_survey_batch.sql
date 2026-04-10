-- Batch upsert for survey CSV polygons (called from Edge Function with service role only).

create or replace function public.vsl_survey_batch_upsert(
  p_layer_type text,
  p_parent_block_code text,
  p_project_name text,
  p_coordinate_system text,
  p_additional_info text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_block_id uuid;
  v_parcel_no integer;
  v_geom geometry;
  v_inserted int := 0;
  v_errors jsonb := '[]'::jsonb;
  v_name text;
  v_estate text;
begin
  if p_layer_type is null or p_layer_type not in ('BLOCKS', 'PARCELS') then
    return jsonb_build_object('success', false, 'error', 'Invalid layer type');
  end if;

  if p_layer_type = 'PARCELS' and (p_parent_block_code is null or trim(p_parent_block_code) = '') then
    return jsonb_build_object('success', false, 'error', 'Parent block code is required for PARCELS');
  end if;

  if p_layer_type = 'PARCELS' then
    select id into v_block_id from public.vsl_blocks where block_code = trim(p_parent_block_code);
    if v_block_id is null then
      return jsonb_build_object(
        'success', false,
        'error', format('Block not found for code: %s', trim(p_parent_block_code))
      );
    end if;
  end if;

  v_estate := left(trim(coalesce(p_additional_info, '')), 500);
  if v_estate = '' then
    v_estate := null;
  end if;

  -- Loop variable v_item is each jsonb object from the array (not a record with .elem).
  for v_item in
    select elem from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as t(elem)
  loop
    begin
      v_geom := st_setsrid(st_geomfromgeojson((v_item->'geometry')::text), 4326);
      if v_geom is null or geometrytype(v_geom) <> 'POLYGON' then
        v_errors := v_errors || jsonb_build_array(
          jsonb_build_object('parcel', v_item->>'csv_parcel_id', 'error', 'Invalid or non-polygon geometry')
        );
        continue;
      end if;

      if p_layer_type = 'BLOCKS' then
        v_name := coalesce(nullif(trim(p_project_name), ''), trim(v_item->>'csv_parcel_id'));
        insert into public.vsl_blocks (
          block_code,
          block_name,
          estate_name,
          expected_area_acres,
          geometry_status,
          geom,
          created_by,
          updated_by
        )
        values (
          trim(v_item->>'csv_parcel_id'),
          v_name,
          v_estate,
          case
            when v_item ? 'area_hectares' and (v_item->>'area_hectares') ~ '^-?[0-9]+\.?[0-9]*$'
            then (v_item->>'area_hectares')::numeric * 2.4710538146717
            else null
          end,
          'captured',
          v_geom,
          null,
          null
        )
        on conflict (block_code) do update set
          geom = excluded.geom,
          geometry_status = 'captured',
          block_name = excluded.block_name,
          estate_name = coalesce(excluded.estate_name, vsl_blocks.estate_name),
          expected_area_acres = coalesce(excluded.expected_area_acres, vsl_blocks.expected_area_acres),
          updated_at = now();
        v_inserted := v_inserted + 1;
      else
        if (v_item->>'csv_parcel_id') ~ '^[0-9]+$' then
          v_parcel_no := (v_item->>'csv_parcel_id')::integer;
        else
          v_parcel_no := public.vsl_next_parcel_no(v_block_id);
        end if;

        insert into public.vsl_parcels (
          block_id,
          parcel_no,
          parcel_label,
          expected_area_acres,
          geometry_status,
          geom,
          created_by,
          updated_by
        )
        values (
          v_block_id,
          v_parcel_no,
          left(trim(coalesce(v_item->>'descriptions', '')), 500),
          case
            when v_item ? 'area_hectares' and (v_item->>'area_hectares') ~ '^-?[0-9]+\.?[0-9]*$'
            then (v_item->>'area_hectares')::numeric * 2.4710538146717
            else null
          end,
          'captured',
          v_geom,
          null,
          null
        )
        on conflict (block_id, parcel_no) do update set
          geom = excluded.geom,
          geometry_status = 'captured',
          parcel_label = coalesce(
            nullif(trim(excluded.parcel_label), ''),
            vsl_parcels.parcel_label
          ),
          expected_area_acres = coalesce(excluded.expected_area_acres, vsl_parcels.expected_area_acres),
          updated_at = now();
        v_inserted := v_inserted + 1;
      end if;
    exception
      when others then
        v_errors := v_errors || jsonb_build_array(
          jsonb_build_object('parcel', v_item->>'csv_parcel_id', 'error', sqlerrm)
        );
    end;
  end loop;

  return jsonb_build_object(
    'success', true,
    'inserted', v_inserted,
    'errors', v_errors
  );
end;
$$;

revoke all on function public.vsl_survey_batch_upsert(text, text, text, text, text, jsonb) from public;
grant execute on function public.vsl_survey_batch_upsert(text, text, text, text, text, jsonb) to service_role;
