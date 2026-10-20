-- 022: blocks no longer have a cultivation status (it derives from their plots).
-- Applied as migration "drop_block_cultivation_status": removed the block keys from
-- vsl_get_features_bbox, the BLOCKS branch from vsl_set_cultivation_status, then:
ALTER TABLE public.vsl_blocks DROP COLUMN cultivation_status;
ALTER TABLE public.vsl_blocks DROP COLUMN cultivation_notes;
ALTER TABLE public.vsl_blocks DROP COLUMN cultivation_updated_at;
ALTER TABLE public.vsl_blocks DROP COLUMN cultivation_updated_by;
