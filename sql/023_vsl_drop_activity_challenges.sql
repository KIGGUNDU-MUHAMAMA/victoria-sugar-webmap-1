-- ---------------------------------------------------------------------------
-- 023 — Drop the activity "Challenges" field
--
-- Log Activity used to show two free-text boxes, Comments and Challenges. In
-- practice whatever went wrong was typed into Comments anyway, so Challenges
-- is gone: out of the webmap form (js/map-app.js
-- LOG_ACTIVITY_COMMON_FIELDS), out of the dashboard's add/edit activity
-- modals and detail view, out of the field catalogue that drives the form,
-- and out of vsl_activities itself.
--
-- Safe to run: vsl_activities held 0 rows (and 0 non-null challenges values)
-- when this was applied, and no view, function or trigger read the column.
-- The seed in 013_vsl_activity_catalog.sql was edited in the same change so
-- re-running that script can't re-insert the catalogue row.
-- ---------------------------------------------------------------------------

-- 1. The catalogue row — this table, not the JS literal, is what the form
--    actually renders from (loadActivityCatalogFromDb in js/map-app.js).
delete from public.vsl_activity_common_fields where key = 'challenges';

-- 2. The column itself.
alter table public.vsl_activities drop column if exists challenges;

-- 3. While here: Area covered still carried its original show_when (hide at
--    100% complete), which the DB-driven form obeyed even though the webmap
--    was changed to keep the field visible and lock it with the plot's own
--    area instead (applyAreaCoveredLock in js/map-app.js). Clearing it makes
--    the catalogue match the form's actual behaviour; 013's seed was edited
--    to match so re-running it can't put the show_when back.
update public.vsl_activity_common_fields set show_when = null
where key = 'area_covered_acres';
