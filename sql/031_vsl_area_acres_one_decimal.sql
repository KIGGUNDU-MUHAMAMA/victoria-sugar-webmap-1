-- 031: Areas are stored to 1 decimal place everywhere.
--
-- vsl_geom_area_acres() already rounds, so every area DERIVED FROM GEOMETRY
-- was already 1dp. Two paths bypassed it:
--
--   1. vsl_fill_area_acres() only recomputes when a geometry is present. A
--      row inserted with no geom (vsl_process_import_batch, and the
--      area_hectares * 2.4710538146717 conversion in
--      vsl_survey_batch_upsert) kept whatever was supplied, unrounded.
--   2. vsl_activities.area_covered_acres is typed by hand and had no
--      rounding at all.
--
-- Rounding at the trigger rather than by narrowing the columns to
-- numeric(12,1). Narrowing would be self-enforcing and is lossless now that
-- the data is rounded (Postgres ROUNDS on scale coercion — it does not
-- truncate), but vsl_block_stats and vsl_estate_stats are views over these
-- columns, and ALTER COLUMN TYPE is refused while a view depends on the
-- column. Doing it would mean dropping and recreating both views, which is
-- a lot more breakage risk than this buys.
--
-- Consequence worth knowing: vsl_parcels/vsl_blocks.area_acres stay
-- numeric(12,3), so a direct SQL query shows 55.600 rather than 55.6. The
-- stored value is 1dp; the column is just padding it.

create or replace function public.vsl_fill_area_acres()
returns trigger
language plpgsql
as $function$
begin
  if new.geom is not null then
    -- Already 1dp — vsl_geom_area_acres rounds.
    new.area_acres := public.vsl_geom_area_acres(new.geom);
  elsif tg_op = 'INSERT' then
    new.area_acres := round(coalesce(new.area_acres, 0), 1);
  else
    new.area_acres := round(coalesce(new.area_acres, old.area_acres, 0), 1);
  end if;
  return new;
end;
$function$;

create or replace function public.vsl_activities_round_area()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  new.area_covered_acres := round(new.area_covered_acres, 1);
  return new;
end;
$function$;

drop trigger if exists trg_vsl_activities_round_area on public.vsl_activities;
create trigger trg_vsl_activities_round_area
  before insert or update on public.vsl_activities
  for each row execute function public.vsl_activities_round_area();

-- Backfill. The title rows were written before vsl_geom_area_acres gained
-- its round(), and the trigger only fires on write, so they kept the old
-- full-precision values.
update public.vsl_title
   set area_acres = round(area_acres, 1)
 where area_acres is not null and area_acres <> round(area_acres, 1);

update public.vsl_parcels
   set area_acres = round(area_acres, 1)
 where area_acres is not null and area_acres <> round(area_acres, 1);

update public.vsl_blocks
   set area_acres = round(area_acres, 1)
 where area_acres is not null and area_acres <> round(area_acres, 1);

update public.vsl_feature
   set area_ac = round(area_ac, 1)
 where area_ac is not null and area_ac <> round(area_ac, 1);

update public.vsl_activities
   set area_covered_acres = round(area_covered_acres, 1)
 where area_covered_acres is not null and area_covered_acres <> round(area_covered_acres, 1);
