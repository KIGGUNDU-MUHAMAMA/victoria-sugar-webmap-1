-- Per-plot parent blocks for the survey import commit.
--
-- vsl_survey_batch_upsert used to resolve ONE block for the whole batch from
-- p_parent_block_code, which is fine when the user picks a block by hand but
-- not when "Automatically Choose Block" has resolved a different block per
-- plot (see sql/016_vsl_resolve_parcel_blocks.sql).
--
-- This version reads an optional "block_id" off each item in p_items and
-- uses it in preference to p_parent_block_code. Both paths still work:
--
--   p_parent_block_code set, no per-item block_id  -> old behaviour, unchanged
--   per-item block_id set                          -> that block wins
--   neither                                        -> that one item is rejected
--                                                     into the errors array
--                                                     (the rest still commit)
--
-- Only the PARCELS branch changed. The BLOCKS branch, estate resolution,
-- area conversion, code auto-numbering and the on-conflict upsert are all
-- carried over verbatim from the live function.

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
set search_path to 'public'
as $function$
declare
  v_item jsonb;
  v_block_id uuid;          -- batch-level fallback, from p_parent_block_code
  v_item_block_id uuid;     -- per-item override, from v_item->>'block_id'
  v_has_item_blocks boolean := false;
  v_parcel_code text;
  v_geom geometry;
  v_inserted int := 0;
  v_errors jsonb := '[]'::jsonb;
  v_block_code_text text;
  v_estate_name text;
  v_estate_id bigint;
begin
  if p_layer_type is null or p_layer_type not in ('BLOCKS', 'PARCELS') then
    return jsonb_build_object('success', false, 'error', 'Invalid layer type');
  end if;

  -- Does the payload carry its own per-item blocks? If so a batch-level
  -- parent block is no longer required (the auto-select path never has one).
  select exists (
    select 1
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as t(elem)
    where nullif(trim(coalesce(t.elem->>'block_id', '')), '') is not null
  ) into v_has_item_blocks;

  if p_layer_type = 'PARCELS'
     and not v_has_item_blocks
     and (p_parent_block_code is null or trim(p_parent_block_code) = '') then
    return jsonb_build_object('success', false, 'error', 'Parent block is required for PARCELS');
  end if;

  if p_layer_type = 'PARCELS'
     and p_parent_block_code is not null
     and trim(p_parent_block_code) <> '' then
    select id into v_block_id from public.vsl_blocks where block_code = trim(p_parent_block_code);
    if v_block_id is null then
      return jsonb_build_object('success', false, 'error', format('Block not found for code: %s', trim(p_parent_block_code)));
    end if;
  end if;

  v_estate_name := case
    when trim(coalesce(p_project_name, '')) <> '' then left(trim(p_project_name), 500)
    else left(trim(coalesce(p_additional_info, '')), 500)
  end;
  if v_estate_name = '' then
    v_estate_name := null;
  end if;

  if v_estate_name is not null then
    select id into v_estate_id from public.vsl_estate where lower(trim(estate_name)) = lower(v_estate_name) limit 1;
    if v_estate_id is null then
      insert into public.vsl_estate(estate_name, status) values (v_estate_name, 'active') returning id into v_estate_id;
    end if;
  end if;

  for v_item in
    select elem from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) as t(elem)
  loop
    begin
      v_geom := st_setsrid(st_geomfromgeojson((v_item->'geometry')::text), 4326);
      if v_geom is null or geometrytype(v_geom) <> 'POLYGON' then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('parcel', v_item->>'csv_parcel_id', 'error', 'Invalid or non-polygon geometry'));
        continue;
      end if;

      if p_layer_type = 'BLOCKS' then
        v_block_code_text := coalesce(nullif(trim(v_item->>'csv_parcel_id'), ''), public.vsl_next_block_code(v_estate_id));
        insert into public.vsl_blocks (block_code, block_name, estate_id, expected_area_acres, geom, created_by, updated_by)
        values (
          v_block_code_text, v_block_code_text, v_estate_id,
          case when v_item ? 'area_hectares' and (v_item->>'area_hectares') ~ '^-?[0-9]+\.?[0-9]*$'
               then (v_item->>'area_hectares')::numeric * 2.4710538146717 else null end,
          v_geom, null, null
        );
        v_inserted := v_inserted + 1;
      else
        -- Per-item block wins; fall back to the batch-level parent block.
        -- Cast defensively — a malformed uuid from the client should reject
        -- this one row, not abort the whole commit.
        v_item_block_id := null;
        if nullif(trim(coalesce(v_item->>'block_id', '')), '') is not null then
          begin
            v_item_block_id := trim(v_item->>'block_id')::uuid;
          exception when others then
            v_item_block_id := null;
          end;
        end if;
        v_item_block_id := coalesce(v_item_block_id, v_block_id);

        if v_item_block_id is null then
          v_errors := v_errors || jsonb_build_array(jsonb_build_object(
            'parcel', v_item->>'csv_parcel_id',
            'error', 'No parent block resolved for this plot'
          ));
          continue;
        end if;

        if not exists (select 1 from public.vsl_blocks b where b.id = v_item_block_id) then
          v_errors := v_errors || jsonb_build_array(jsonb_build_object(
            'parcel', v_item->>'csv_parcel_id',
            'error', format('Block not found: %s', v_item_block_id)
          ));
          continue;
        end if;

        v_parcel_code := coalesce(nullif(trim(v_item->>'csv_parcel_id'), ''), public.vsl_next_parcel_code(v_item_block_id));

        insert into public.vsl_parcels (block_id, parcel_code, parcel_name, expected_area_acres, geom, created_by, updated_by)
        values (
          v_item_block_id, v_parcel_code,
          coalesce(nullif(trim(v_item->>'descriptions'), ''), nullif(trim(v_item->>'csv_parcel_id'), ''), v_parcel_code),
          case when v_item ? 'area_hectares' and (v_item->>'area_hectares') ~ '^-?[0-9]+\.?[0-9]*$'
               then (v_item->>'area_hectares')::numeric * 2.4710538146717 else null end,
          v_geom, null, null
        )
        on conflict (block_id, parcel_code) do update set
          geom = excluded.geom,
          parcel_name = excluded.parcel_name,
          expected_area_acres = coalesce(excluded.expected_area_acres, vsl_parcels.expected_area_acres),
          updated_at = now();
        v_inserted := v_inserted + 1;
      end if;
    exception
      when others then
        v_errors := v_errors || jsonb_build_array(jsonb_build_object('parcel', v_item->>'csv_parcel_id', 'error', sqlerrm));
    end;
  end loop;

  return jsonb_build_object('success', true, 'inserted', v_inserted, 'errors', v_errors);
end;
$function$;

comment on function public.vsl_survey_batch_upsert(text, text, text, text, text, jsonb) is
  'Survey import commit. For PARCELS, p_items[].block_id (optional) overrides p_parent_block_code so a batch can span multiple blocks.';
