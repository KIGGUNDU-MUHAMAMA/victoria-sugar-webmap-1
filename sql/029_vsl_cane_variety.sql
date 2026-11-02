-- ---------------------------------------------------------------------------
-- 029 — Cane varieties as records
--
-- Crop period and expected yield were settings on the ESTATE
-- (vsl_estate.harvest_period_months / yield_per_acre_tons, edited from the
-- dashboard's "Harvest Settings" modal). That is the wrong thing to hang
-- them on: how long cane takes to mature and how much it yields are
-- properties of the VARIETY. An estate growing two varieties had one figure
-- covering both.
--
-- The variety itself was free text typed per season, so it could carry no
-- figures at all and was spelt however each person typed it.
--
-- Nothing was lost in the changeover: all 1,068 season rows had a blank
-- cane_variety, so there was no text to convert.
--
-- Applied to the database as migration "vsl_cane_variety". This file is the
-- reviewable copy.
-- ---------------------------------------------------------------------------

create table if not exists public.vsl_cane_variety (
  id                           uuid primary key default gen_random_uuid(),
  name                         text not null,
  -- Plant crop: planting to first harvest.
  crop_period_months           numeric,
  -- Each ratoon after that: harvest to the next harvest. Usually shorter
  -- than the plant crop, which is why it is its own figure.
  ratoon_period_months         numeric,
  expected_yield_tons_per_acre numeric,
  notes                        text,
  -- Retired rather than deleted, so a variety still referenced by a season
  -- can be taken out of the dropdown without breaking that record.
  is_active                    boolean not null default true,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  created_by                   uuid references auth.users(id),
  updated_by                   uuid references auth.users(id),
  constraint vsl_cane_variety_name_not_blank check (btrim(name) <> ''),
  constraint vsl_cane_variety_periods_positive check (
    (crop_period_months   is null or crop_period_months   > 0) and
    (ratoon_period_months is null or ratoon_period_months > 0) and
    (expected_yield_tons_per_acre is null or expected_yield_tons_per_acre >= 0)
  )
);

-- Case-insensitive: "Co 421" and "CO 421" are the same variety, and letting
-- both exist is how a dropdown ends up with duplicates.
create unique index if not exists idx_vsl_cane_variety_name_unique
  on public.vsl_cane_variety (lower(btrim(name)));

alter table public.vsl_parcel_seasons
  add column if not exists cane_variety_id uuid references public.vsl_cane_variety(id);

create index if not exists idx_vsl_parcel_seasons_variety
  on public.vsl_parcel_seasons (cane_variety_id);

-- The old free-text column stays, maintained by this trigger as a copy of
-- the chosen variety's name. Two reasons: every existing reader (the
-- webmap's info panel, the dashboard's seasons table and variety counts)
-- keeps working untouched, and because the copy is written FROM the foreign
-- key it cannot drift from it.
create or replace function public.vsl_parcel_seasons_sync_variety_name()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if new.cane_variety_id is null then
    -- Leave hand-typed text alone when no variety is chosen, so this can be
    -- adopted gradually rather than wiping anything already written.
    return new;
  end if;
  select v.name into new.cane_variety
  from public.vsl_cane_variety v
  where v.id = new.cane_variety_id;
  return new;
end;
$function$;

drop trigger if exists trg_vsl_parcel_seasons_sync_variety_name on public.vsl_parcel_seasons;
create trigger trg_vsl_parcel_seasons_sync_variety_name
  before insert or update of cane_variety_id on public.vsl_parcel_seasons
  for each row execute function public.vsl_parcel_seasons_sync_variety_name();

-- ── Security: a catalogue, same shape as vsl_feature_type ──
alter table public.vsl_cane_variety enable row level security;

drop policy if exists "cane_variety read all" on public.vsl_cane_variety;
create policy "cane_variety read all"
  on public.vsl_cane_variety for select to authenticated, anon using (true);

-- Admin only, unlike feature types (which surveyors also maintain): crop
-- period and yield feed harvest forecasting, which is management's number.
drop policy if exists "cane_variety write admin" on public.vsl_cane_variety;
create policy "cane_variety write admin"
  on public.vsl_cane_variety for all to authenticated
  using (public.vsl_is_role('ADMIN'))
  with check (public.vsl_is_role('ADMIN'));

grant select on public.vsl_cane_variety to anon, authenticated;
grant insert, update, delete on public.vsl_cane_variety to authenticated;
