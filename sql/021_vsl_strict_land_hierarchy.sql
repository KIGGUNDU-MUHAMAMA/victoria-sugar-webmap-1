-- 021_vsl_strict_land_hierarchy.sql
-- Enforces the land hierarchy Estate -> Block -> Plot (parcel):
--   * a Block can never exist without an Estate
--   * a Plot can never exist without a Block (vsl_parcels.block_id is already NOT NULL)
--   * deleting an Estate deletes all its Blocks, which deletes all their Plots
--   * every record hanging off those (activities, costs, harvests, seasons,
--     soil tests, land-state log, alerts, media, documents, comments) goes too
-- NOTE: files already uploaded to the media bucket are not removed by the
-- database; only their database records are.

begin;

-- 1. Block -> Estate: cascade on delete
alter table public.vsl_blocks drop constraint if exists vsl_blocks_estate_id_fkey;
alter table public.vsl_blocks
  add constraint vsl_blocks_estate_id_fkey
  foreign key (estate_id) references public.vsl_estate(id) on delete cascade;

-- 2. Block must have an Estate. NOT VALID = enforced for every new/edited row,
--    without failing on any legacy row that has no estate yet. Once those are
--    fixed or removed, run:
--      alter table public.vsl_blocks validate constraint vsl_blocks_estate_required;
alter table public.vsl_blocks drop constraint if exists vsl_blocks_estate_required;
alter table public.vsl_blocks
  add constraint vsl_blocks_estate_required check (estate_id is not null) not valid;

-- 3. Plot -> Block is already NOT NULL + ON DELETE CASCADE (re-stated to be safe)
alter table public.vsl_parcels drop constraint if exists vsl_parcels_block_id_fkey;
alter table public.vsl_parcels
  add constraint vsl_parcels_block_id_fkey
  foreign key (block_id) references public.vsl_blocks(id) on delete cascade;

-- 4. Records scoped to a Block or Estate go with it (these used to have no
--    ON DELETE action, which made the delete fail outright)
alter table public.vsl_activities drop constraint if exists vsl_activities_block_id_fkey;
alter table public.vsl_activities
  add constraint vsl_activities_block_id_fkey
  foreign key (block_id) references public.vsl_blocks(id) on delete cascade;

alter table public.vsl_activities drop constraint if exists vsl_activities_estate_id_fkey;
alter table public.vsl_activities
  add constraint vsl_activities_estate_id_fkey
  foreign key (estate_id) references public.vsl_estate(id) on delete cascade;

alter table public.vsl_activity_costs drop constraint if exists vsl_activity_costs_block_id_fkey;
alter table public.vsl_activity_costs
  add constraint vsl_activity_costs_block_id_fkey
  foreign key (block_id) references public.vsl_blocks(id) on delete cascade;

-- 5. Polymorphic records (entity_type/entity_id, layer_type/target_id) have
--    no foreign key, so clean them up with a trigger.
create or replace function public.vsl_cleanup_entity_refs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity_type text := tg_argv[0];   -- 'estate' | 'block' | 'parcel'
  v_layer_type  text := tg_argv[1];   -- 'ESTATE' | 'BLOCKS' | 'PARCELS'
  v_id          text := old.id::text;
begin
  delete from public.vsl_media     where entity_type = v_entity_type and entity_id = v_id;
  delete from public.vsl_documents where entity_type = v_entity_type and entity_id = v_id;
  delete from public.vsl_comments  where entity_type = v_entity_type and entity_id = v_id;
  delete from public.vsl_alerts    where layer_type  = v_layer_type  and target_id = v_id;
  return old;
end;
$$;

drop trigger if exists trg_vsl_estate_cleanup_refs  on public.vsl_estate;
drop trigger if exists trg_vsl_blocks_cleanup_refs  on public.vsl_blocks;
drop trigger if exists trg_vsl_parcels_cleanup_refs on public.vsl_parcels;

create trigger trg_vsl_estate_cleanup_refs  after delete on public.vsl_estate
  for each row execute function public.vsl_cleanup_entity_refs('estate', 'ESTATE');
create trigger trg_vsl_blocks_cleanup_refs  after delete on public.vsl_blocks
  for each row execute function public.vsl_cleanup_entity_refs('block',  'BLOCKS');
create trigger trg_vsl_parcels_cleanup_refs after delete on public.vsl_parcels
  for each row execute function public.vsl_cleanup_entity_refs('parcel', 'PARCELS');

commit;
