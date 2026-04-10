-- Victoria Sugar Limited isolated schema for a dedicated Supabase project.
create extension if not exists postgis;
create extension if not exists pgcrypto;

create table if not exists public.vsl_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  role text not null check (role in ('ADMIN', 'SURVEYOR', 'MANAGMENT')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vsl_blocks (
  id uuid primary key default gen_random_uuid(),
  block_code text not null unique,
  block_name text not null,
  estate_name text,
  expected_area_acres numeric(12, 3),
  geometry_status text not null default 'pending' check (geometry_status in ('pending', 'captured')),
  geom geometry(Polygon, 4326),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vsl_parcels (
  id uuid primary key default gen_random_uuid(),
  block_id uuid not null references public.vsl_blocks(id) on delete cascade,
  parcel_no integer not null,
  parcel_code text generated always as ('P-' || parcel_no::text) stored,
  parcel_label text,
  expected_area_acres numeric(12, 3),
  geometry_status text not null default 'pending' check (geometry_status in ('pending', 'captured')),
  geom geometry(Polygon, 4326),
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (block_id, parcel_no)
);

create table if not exists public.vsl_flags (
  id uuid primary key default gen_random_uuid(),
  layer_type text not null check (layer_type in ('BLOCKS', 'PARCELS')),
  target_id text not null,
  note text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_by uuid references auth.users(id),
  resolved_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists public.vsl_import_batches (
  id bigserial primary key,
  source_file_name text not null,
  row_count integer not null default 0,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  imported_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.vsl_import_rows (
  id bigserial primary key,
  batch_id bigint not null references public.vsl_import_batches(id) on delete cascade,
  row_number integer not null,
  raw_payload jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'imported', 'failed')),
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists idx_vsl_blocks_geom on public.vsl_blocks using gist (geom);
create index if not exists idx_vsl_parcels_geom on public.vsl_parcels using gist (geom);
create index if not exists idx_vsl_parcels_block_id on public.vsl_parcels(block_id);
create index if not exists idx_vsl_import_rows_batch_id on public.vsl_import_rows(batch_id);

create or replace function public.vsl_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
begin
  v_role := coalesce(new.raw_user_meta_data->>'role', 'MANAGMENT');
  if v_role not in ('ADMIN', 'SURVEYOR', 'MANAGMENT') then
    v_role := 'MANAGMENT';
  end if;

  insert into public.vsl_profiles(id, email, role)
  values (new.id, coalesce(new.email, ''), v_role)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_vsl on auth.users;
create trigger on_auth_user_created_vsl
after insert on auth.users
for each row execute procedure public.vsl_handle_new_auth_user();

create or replace function public.vsl_current_role()
returns text
language sql
stable
as $$
  select role from public.vsl_profiles where id = auth.uid();
$$;

create or replace function public.vsl_is_role(p_role text)
returns boolean
language sql
stable
as $$
  select exists(
    select 1 from public.vsl_profiles p
    where p.id = auth.uid() and p.role = p_role
  );
$$;

create or replace function public.vsl_next_parcel_no(p_block_id uuid)
returns integer
language sql
as $$
  select coalesce(max(parcel_no), 0) + 1
  from public.vsl_parcels
  where block_id = p_block_id;
$$;

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
      'block_code', b.block_code,
      'parcel_no', p.parcel_no,
      'parcel_code', p.parcel_code,
      'parcel_label', p.parcel_label,
      'expected_area_acres', p.expected_area_acres,
      'geometry_status', p.geometry_status
    ) as properties,
    st_asgeojson(p.geom)::jsonb as geojson
  from public.vsl_parcels p
  join public.vsl_blocks b on b.id = p.block_id, bbox
  where p.geom is not null and st_intersects(p.geom, bbox.g);
$$;

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

  insert into public.vsl_blocks(block_code, block_name, geometry_status, created_by, updated_by)
  values (p_block_code, p_block_code, 'pending', p_user_id, p_user_id)
  on conflict (block_code) do update
    set updated_by = excluded.updated_by,
        updated_at = now()
  returning id into v_block_id;

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
      on conflict (block_code) do update
        set block_name = excluded.block_name,
            estate_name = excluded.estate_name,
            expected_area_acres = excluded.expected_area_acres,
            updated_at = now()
      returning id into v_block_id;

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

alter table public.vsl_profiles enable row level security;
alter table public.vsl_blocks enable row level security;
alter table public.vsl_parcels enable row level security;
alter table public.vsl_flags enable row level security;
alter table public.vsl_import_batches enable row level security;
alter table public.vsl_import_rows enable row level security;

create policy "profiles self read" on public.vsl_profiles
  for select to authenticated
  using (id = auth.uid() or public.vsl_is_role('ADMIN'));

create policy "profiles self insert" on public.vsl_profiles
  for insert to authenticated
  with check (
    id = auth.uid()
    and role in ('ADMIN', 'SURVEYOR', 'MANAGMENT')
  );

create policy "profiles self update" on public.vsl_profiles
  for update to authenticated
  using (id = auth.uid() or public.vsl_is_role('ADMIN'))
  with check (id = auth.uid() or public.vsl_is_role('ADMIN'));

create policy "profiles admin delete" on public.vsl_profiles
  for delete to authenticated
  using (public.vsl_is_role('ADMIN'));

create policy "blocks read all" on public.vsl_blocks
  for select to authenticated using (true);

create policy "blocks edit by admin_surveyor" on public.vsl_blocks
  for all to authenticated
  using (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'))
  with check (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));

create policy "parcels read all" on public.vsl_parcels
  for select to authenticated using (true);

create policy "parcels edit by admin_surveyor" on public.vsl_parcels
  for all to authenticated
  using (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'))
  with check (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));

create policy "flags read all" on public.vsl_flags
  for select to authenticated using (true);

create policy "flags write admin_surveyor" on public.vsl_flags
  for insert to authenticated
  with check (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));

create policy "flags resolve admin_surveyor" on public.vsl_flags
  for update to authenticated
  using (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'))
  with check (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));

create policy "imports admin_surveyor" on public.vsl_import_batches
  for all to authenticated
  using (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'))
  with check (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));

create policy "import_rows admin_surveyor" on public.vsl_import_rows
  for all to authenticated
  using (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'))
  with check (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));
