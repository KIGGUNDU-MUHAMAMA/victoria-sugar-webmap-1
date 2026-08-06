-- Drop global unique constraint on block_code and enable block codes to be unique per estate.
-- Run this script in the Supabase SQL Editor.

-- 1. Drop the legacy global unique constraint/index on vsl_blocks(block_code)
alter table public.vsl_blocks drop constraint if exists vsl_blocks_block_code_key;

-- 2. Create a unique constraint/index on (estate_name, block_code) when estate_name is set
drop index if exists public.idx_vsl_blocks_estate_block_code_unique;
create unique index idx_vsl_blocks_estate_block_code_unique 
on public.vsl_blocks (estate_name, block_code) 
where estate_name is not null;

-- 3. Create a unique constraint/index on block_code alone when estate_name is null
drop index if exists public.idx_vsl_blocks_no_estate_block_code_unique;
create unique index idx_vsl_blocks_no_estate_block_code_unique 
on public.vsl_blocks (block_code) 
where estate_name is null;


-- 4. Redefine vsl_upsert_geometry to avoid ON CONFLICT on block_code
create or replace function public.vsl_upsert_geometry(
  p_layer_type text,
  p_block_code text,
  p_parcel_no integer,
  p_geojson jsonb,
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_block_id uuid;
  v_parcel_id uuid;
  v_geom geometry;
begin
  v_geom := st_setsrid(st_geomfromgeojson(p_geojson::text), 4326);
  if geometrytype(v_geom) <> 'POLYGON' then
    raise exception 'Only Polygon geometries are allowed';
  end if;

  select id into v_block_id from public.vsl_blocks where block_code = trim(p_block_code) limit 1;
  if v_block_id is null then
    insert into public.vsl_blocks(block_code, block_name, geometry_status, created_by, updated_by)
    values (p_block_code, p_block_code, 'pending', p_user_id, p_user_id)
    returning id into v_block_id;
  else
    update public.vsl_blocks
    set updated_by = p_user_id,
        updated_at = now()
    where id = v_block_id;
  end if;

  if p_layer_type = 'BLOCKS' then
    update public.vsl_blocks
    set geom = v_geom,
        geometry_status = 'captured',
        updated_by = p_user_id,
        updated_at = now()
    where id = v_block_id;
    return v_block_id;
  elsif p_layer_type = 'PARCELS' then
    if p_parcel_no is null then
      p_parcel_no := public.vsl_next_parcel_no(v_block_id);
    end if;

    insert into public.vsl_parcels(block_id, parcel_no, geometry_status, created_by, updated_by, geom)
    values (v_block_id, p_parcel_no, 'captured', p_user_id, p_user_id, v_geom)
    on conflict (block_id, parcel_no) do update
      set geom = excluded.geom,
          geometry_status = 'captured',
          updated_by = excluded.updated_by,
          updated_at = now()
    returning id into v_parcel_id;
    return v_parcel_id;
  else
    raise exception 'Invalid layer type: %', p_layer_type;
  end if;
end;
$$;


-- 5. Redefine vsl_process_import_batch to avoid ON CONFLICT on block_code
create or replace function public.vsl_process_import_batch(p_batch_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
  v_block_id uuid;
  v_parcel_no integer;
begin
  for rec in
    select * from public.vsl_import_rows where batch_id = p_batch_id order by row_number
  loop
    begin
      select id into v_block_id 
      from public.vsl_blocks 
      where block_code = rec.raw_payload->>'block_code'
        and (
          (estate_name is null and (rec.raw_payload->>'estate_name') is null) or
          (estate_name = rec.raw_payload->>'estate_name')
        )
      limit 1;

      if v_block_id is null then
        insert into public.vsl_blocks(
          block_code,
          block_name,
          estate_name,
          expected_area_acres,
          geometry_status,
          created_by,
          updated_by
        )
        values (
          rec.raw_payload->>'block_code',
          rec.raw_payload->>'block_name',
          rec.raw_payload->>'estate_name',
          nullif(rec.raw_payload->>'expected_area_acres', '')::numeric,
          'pending',
          auth.uid(),
          auth.uid()
        )
        returning id into v_block_id;
      else
        update public.vsl_blocks
        set block_name = rec.raw_payload->>'block_name',
            estate_name = rec.raw_payload->>'estate_name',
            expected_area_acres = nullif(rec.raw_payload->>'expected_area_acres', '')::numeric,
            updated_at = now()
        where id = v_block_id;
      end if;

      v_parcel_no := public.vsl_next_parcel_no(v_block_id);
      insert into public.vsl_parcels(
        block_id,
        parcel_no,
        parcel_label,
        expected_area_acres,
        geometry_status,
        created_by,
        updated_by
      )
      values (
        v_block_id,
        v_parcel_no,
        coalesce(rec.raw_payload->>'parcel_label', 'Imported parcel'),
        nullif(rec.raw_payload->>'expected_area_acres', '')::numeric,
        'pending',
        auth.uid(),
        auth.uid()
      );

      update public.vsl_import_rows
      set status = 'imported',
          error_message = null
      where id = rec.id;
    exception when others then
      update public.vsl_import_rows
      set status = 'failed',
          error_message = sqlerrm
      where id = rec.id;
    end;
  end loop;

  update public.vsl_import_batches
  set status = 'completed',
      completed_at = now()
  where id = p_batch_id;
end;
$$;
