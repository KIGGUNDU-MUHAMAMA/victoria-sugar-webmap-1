-- 021: expected_area_acres -> area_acres (vsl_parcels, vsl_blocks, vsl_title),
-- backfill, and guarantee it is always filled. Applied to the live DB via
-- migrations "rename_expected_area_acres_to_area_acres" and
-- "area_acres_always_from_geometry_on_insert".

ALTER TABLE public.vsl_parcels RENAME COLUMN expected_area_acres TO area_acres;
ALTER TABLE public.vsl_blocks  RENAME COLUMN expected_area_acres TO area_acres;
ALTER TABLE public.vsl_title   RENAME COLUMN expected_area_acres TO area_acres;

-- Rewrite functions that referenced the old name
-- (vsl_process_import_batch, vsl_survey_batch_upsert, vsl_get_features_bbox, vsl_locate_parcel).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
    WHERE s.nspname = 'public' AND p.prokind = 'f'
      AND pg_get_functiondef(p.oid) LIKE '%expected_area_acres%'
  LOOP
    EXECUTE replace(pg_get_functiondef(r.oid), 'expected_area_acres', 'area_acres');
  END LOOP;
END $$;

-- Planar area in acres on UTM 36N (same method as computeUtmCartesianAreaAcres in js/utils.js)
CREATE OR REPLACE FUNCTION public.vsl_geom_area_acres(g geometry)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN g IS NULL THEN NULL
    ELSE round((ST_Area(ST_Transform(ST_SetSRID(g, 4326), 32636)) / 4046.8564224)::numeric, 3) END
$$;

UPDATE public.vsl_parcels SET area_acres = public.vsl_geom_area_acres(geom) WHERE area_acres IS NULL AND geom IS NOT NULL;
UPDATE public.vsl_blocks  SET area_acres = COALESCE(public.vsl_geom_area_acres(geom), 0) WHERE area_acres IS NULL;
UPDATE public.vsl_title   SET area_acres = public.vsl_geom_area_acres(geom) WHERE area_acres IS NULL AND geom IS NOT NULL;

CREATE OR REPLACE FUNCTION public.vsl_fill_area_acres() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.geom IS NOT NULL THEN
      NEW.area_acres := public.vsl_geom_area_acres(NEW.geom);
    ELSE
      NEW.area_acres := COALESCE(NEW.area_acres, 0);
    END IF;
  ELSE
    IF NEW.area_acres IS NULL
       OR (NEW.geom IS DISTINCT FROM OLD.geom AND NEW.area_acres IS NOT DISTINCT FROM OLD.area_acres) THEN
      NEW.area_acres := COALESCE(public.vsl_geom_area_acres(NEW.geom), 0);
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_vsl_parcels_fill_area BEFORE INSERT OR UPDATE ON public.vsl_parcels FOR EACH ROW EXECUTE FUNCTION public.vsl_fill_area_acres();
CREATE TRIGGER trg_vsl_blocks_fill_area  BEFORE INSERT OR UPDATE ON public.vsl_blocks  FOR EACH ROW EXECUTE FUNCTION public.vsl_fill_area_acres();
CREATE TRIGGER trg_vsl_title_fill_area   BEFORE INSERT OR UPDATE ON public.vsl_title   FOR EACH ROW EXECUTE FUNCTION public.vsl_fill_area_acres();

ALTER TABLE public.vsl_parcels ALTER COLUMN area_acres SET NOT NULL;
ALTER TABLE public.vsl_blocks  ALTER COLUMN area_acres SET NOT NULL;
ALTER TABLE public.vsl_title   ALTER COLUMN area_acres SET NOT NULL;
