-- Settles what each import column means, for BLOCKS and PLOTS alike.
--
--   parcel_id    grouping key only. Marks where one polygon's ring starts and
--                ends in the CSV. NEVER stored — it used to be written into
--                parcel_code/block_code, which meant a surveyor's throwaway
--                "P001" became the permanent database code.
--   eastings /   geometry, area and edge lengths (handled in the edge
--   northings    function, which reprojects to WGS84 before this RPC sees it).
--   description  the NAME. Goes to vsl_parcels.parcel_name and
--                vsl_blocks.block_name.
--   code         always generated here: vsl_next_parcel_code(block) for plots,
--                vsl_next_block_code(estate) for blocks. Both are max+1 over
--                existing numeric codes in that scope.
--
-- What changed from the previous version:
--
--   BLOCKS   block_code  was csv_parcel_id, now always auto-numbered
--            block_name  was a copy of block_code, now the description
--   PARCELS  parcel_code was csv_parcel_id, now always auto-numbered
--            parcel_name was description -> csv_parcel_id -> code;
--                        now description -> code (csv_parcel_id never used)
--
-- CONSEQUENCE — re-importing the same file now DUPLICATES rather than
-- updates. The old `on conflict (block_id, parcel_code) do update` only ever
-- fired because parcel_code was the stable csv_parcel_id. Auto-numbering
-- hands out max+1 every time, so the conflict target can never collide and
-- the upsert is now effectively an insert. That is inherent to "the code is
-- an auto-number"; the clause is kept below purely as a guard against a
-- concurrent race, not as a re-import path.
--
-- The per-item block_id behaviour from 017 is carried over unchanged.

-- Stale overload: filters on vsl_blocks.estate_name, a column dropped when
-- estates became their own table. Any call would fail outright. Removing it
-- also stops it competing for overload resolution with the bigint version.
drop function if exists public.vsl_next_block_code(text);

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
  v_block_id uuid;
  v_item_block_id uuid;
  v_has_item_blocks boolean := false;
  v_parcel_code text;
  v_geom geometry;
  v_inserted int := 0;
  v_errors jsonb := '[]'::jsonb;
  v_block_code_text text;
  v_name text;
  v_estate_name text;
  v_estate_id bigint;
begin
  if p_layer_type is null or p_layer_type not in ('BLOCKS', 'PARCELS') then
    return jsonb_build_object('success', false, 'error', 'Invalid layer type');
  end if;

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

      -- The name, straight from the description column. Deliberately does NOT
      -- fall back to csv_parcel_id: that is a grouping key, not a name.
      v_name := nullif(trim(coalesce(v_item->>'descriptions', '')), '');

      if p_layer_type = 'BLOCKS' then
        v_block_code_text := public.vsl_next_block_code(v_estate_id);

        insert into public.vsl_blocks (block_code, block_name, estate_id, expected_area_acres, geom, created_by, updated_by)
        values (
          v_block_code_text,
          coalesce(v_name, v_block_code_text),
          v_estate_id,
          case when v_item ? 'area_hectares' and (v_item->>'area_hectares') ~ '^-?[0-9]+\.?[0-9]*$'
               then (v_item->>'area_hectares')::numeric * 2.4710538146717 else null end,
          v_geom, null, null
        );
        v_inserted := v_inserted + 1;
      else
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

        -- Always generated, scoped to the parent block. Re-queried per item so
        -- successive plots in the same batch pick up 1, 2, 3 … — rows inserted
        -- earlier in this transaction are visible to it.
        v_parcel_code := public.vsl_next_parcel_code(v_item_block_id);

        insert into public.vsl_parcels (block_id, parcel_code, parcel_name, expected_area_acres, geom, created_by, updated_by)
        values (
          v_item_block_id,
          v_parcel_code,
          coalesce(v_name, v_parcel_code),
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
  'Survey import commit. Codes are auto-numbered; names come from the CSV description column; csv_parcel_id is a grouping key only. p_items[].block_id overrides p_parent_block_code.';
