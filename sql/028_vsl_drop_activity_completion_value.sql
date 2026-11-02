-- ---------------------------------------------------------------------------
-- 028 — Drop "Progress (%)" from activities
--
-- Log Activity asked twice how much of a plot was worked: "Progress (%)",
-- an enum of 0/20/50/75/100, and "Area covered (ac)". The percentage was
-- the weaker of the two — a percentage of what, when the plot's area is
-- already known to the acre? — and it carried a special case where picking
-- 100% auto-filled and locked the area field, which is a lot of machinery
-- for a question already answered by the field next to it.
--
-- The area stays and keeps a plain "Whole plot (12.4 ac)" tick beside it,
-- which fills in the plot's or block's own area and locks the input. Same
-- outcome as 100% used to have, without a second field to keep in step.
-- See renderLogActivityFields in js/map-app.js.
--
-- One of the three activity rows in the table carried a progress value when
-- this ran; that figure is lost. Its area_covered_acres is untouched.
--
-- Removed alongside this, in the same change:
--   js/map-app.js            the field, the enum constants, the save
--                            payloads, the "Progress" column in the plot's
--                            activity history and its PDF mirror
--   dashboard/app.js         the Completion select, the progress-bar column
--                            in the Activities table (now Area (ac)), the
--                            detail row, and completionOptions()
--   dashboard/supabase-client.js  the completionValue mapping
-- ---------------------------------------------------------------------------

-- The catalogue row is what actually drives the form (see
-- loadActivityCatalogFromDb) — the JS array is only a fallback.
delete from public.vsl_activity_common_fields where key = 'completion_value';

alter table public.vsl_activities
  drop constraint if exists vsl_activities_completion_value_chk;

alter table public.vsl_activities
  drop column if exists completion_value;
