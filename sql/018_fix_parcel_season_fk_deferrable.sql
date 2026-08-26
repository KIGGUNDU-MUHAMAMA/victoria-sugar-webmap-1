-- BUG FIX — inserting ANY plot into vsl_parcels currently fails.
--
-- Reproduce (on the schema as it stood before this migration):
--
--   insert into vsl_parcels (block_id, parcel_code, parcel_name, geom)
--   values ('<any real block>', 'X', 'X', '<any polygon>');
--
--   ERROR:  insert or update on table "vsl_parcel_seasons" violates foreign
--           key constraint "vsl_parcel_seasons_parcel_id_fkey"
--   DETAIL: Key (parcel_id)=(...) is not present in table "vsl_parcels".
--
-- Why: trg_vsl_sync_parcel_season is a BEFORE INSERT trigger, and its
-- function inserts a matching row into vsl_parcel_seasons referencing
-- new.id. On INSERT that parent row does not exist yet — BEFORE means the
-- vsl_parcels tuple has not been written — so the immediate foreign key
-- check fails every time. It has to be BEFORE, not AFTER, because it also
-- assigns new.current_season_id, which is only possible before the row is
-- written.
--
-- In the survey import this surfaced as the RPC's per-row error handler
-- swallowing it: vsl_survey_batch_upsert returned success:true with
-- inserted:0 and the failure buried in its errors array, which the UI shows
-- as "Nothing was saved (0 rows)".
--
-- Fix: defer the foreign key to the end of the transaction. By commit time
-- the vsl_parcels row exists, so the check passes. This keeps the trigger's
-- logic (and its current_season_id assignment) exactly as-is, and does not
-- weaken the constraint — an orphaned season row still aborts the
-- transaction, just at commit rather than mid-statement.
--
-- ON DELETE CASCADE is preserved.

alter table public.vsl_parcel_seasons
  drop constraint vsl_parcel_seasons_parcel_id_fkey;

alter table public.vsl_parcel_seasons
  add constraint vsl_parcel_seasons_parcel_id_fkey
  foreign key (parcel_id) references public.vsl_parcels(id)
  on delete cascade
  deferrable initially deferred;
