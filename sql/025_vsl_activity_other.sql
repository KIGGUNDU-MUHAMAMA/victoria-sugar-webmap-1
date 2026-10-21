-- ---------------------------------------------------------------------------
-- 025 — "Other": logging an activity that isn't in the catalogue
--
-- The 17 activity types cover the normal cycle, but field work throws up
-- one-offs (a fence repair, a drain cleared) that people were previously
-- forced to file under whichever listed activity was closest — which is
-- worse than no record, because the report then says something untrue.
--
-- ── Why the typed name is NOT written to activity_name ──
-- vsl_activities.activity_name is a FOREIGN KEY to vsl_activity_types(name),
-- which is what keeps the catalogue and the logged rows from drifting apart
-- (and what lets the per-activity property definitions be looked up by
-- name). A free-typed value would simply violate it.
--
-- The alternative — inserting each typed name into vsl_activity_types on the
-- fly — was rejected: the dropdown is shared by everyone, so one person's
-- typo ("Ploughin") would become a permanent option for the whole company,
-- and the catalogue would stop being a controlled list.
--
-- So 'Other' is one real catalogue row, and the words the person typed go in
-- their own column. Reporting can group every one-off under 'Other' and
-- still read what each actually was, and because 'Other' has no rows in
-- vsl_activity_type_properties, the form shows it no extra fields — only the
-- general details, which is exactly the intent.
-- ---------------------------------------------------------------------------

-- ── 1. The catalogue row ────────────────────────────────────────────────
-- sort_order 999 so it stays at the bottom of the dropdown no matter how
-- many real activities are added above it.
insert into public.vsl_activity_types (name, sort_order)
values ('Other', 999)
on conflict (name) do update set sort_order = excluded.sort_order;

-- ── 2. Where the typed name lives ───────────────────────────────────────
-- Its own column, not a key inside activity_properties: it is the row's
-- identity, so it has to be groupable and searchable in SQL.
alter table public.vsl_activities
  add column if not exists custom_activity_name text;

comment on column public.vsl_activities.custom_activity_name is
  'What the activity actually was, typed by the user. Required when activity_name = ''Other'', and null otherwise.';

-- ── 3. Keep the pair honest ─────────────────────────────────────────────
-- Required for 'Other' (an unnamed one-off is an unusable record) and
-- forbidden otherwise (so a stale typed name can never contradict a real
-- activity_name).
alter table public.vsl_activities
  drop constraint if exists vsl_activities_custom_name_chk;

alter table public.vsl_activities
  add constraint vsl_activities_custom_name_chk check (
    (activity_name = 'Other' and custom_activity_name is not null
       and btrim(custom_activity_name) <> '')
    or (activity_name <> 'Other' and custom_activity_name is null)
  );

-- ── 4. The parcel's "Current activity" should read the real thing ───────
-- This trigger stamps vsl_parcels.current_activity_name from the newest
-- activity row, and it is what the map popup and the plot details panel
-- show. Left alone it would display "Other" to everyone and throw the
-- typed name away, so it now prefers the typed name when there is one.
create or replace function public.vsl_sync_parcel_current_activity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_parcel_id uuid;
  v_latest record;
begin
  v_parcel_id := coalesce(new.parcel_id, old.parcel_id);

  select id,
         case
           when activity_name = 'Other' and coalesce(btrim(custom_activity_name), '') <> ''
             then custom_activity_name
           else activity_name
         end as display_name
  into v_latest
  from public.vsl_activities
  where parcel_id = v_parcel_id
  order by activity_date desc nulls last, created_at desc
  limit 1;

  update public.vsl_parcels
  set current_activity_id = v_latest.id,
      current_activity_name = v_latest.display_name
  where id = v_parcel_id;

  return coalesce(new, old);
end;
$function$;
