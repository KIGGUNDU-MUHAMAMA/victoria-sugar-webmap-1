-- ============================================================
-- Parcel → Block assignment: audit first, commit second
-- Project: victoriasugar (PostGIS 3.3.7, SRID 4326)
--
--   vsl_parcels.block_id (uuid)  →  vsl_blocks.id (uuid)
--
-- Run sections 0–3 (read-only) before anything in section 5.
-- ============================================================


-- ------------------------------------------------------------
-- 0. Indexes — run once. Everything below depends on these.
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS vsl_blocks_geom_gix  ON vsl_blocks  USING GIST (geom);
CREATE INDEX IF NOT EXISTS vsl_parcels_geom_gix ON vsl_parcels USING GIST (geom);
ANALYZE vsl_blocks;
ANALYZE vsl_parcels;


-- ------------------------------------------------------------
-- 1. DRY RUN — summary counts. Read-only.
--
-- ST_PointOnSurface is used instead of ST_Centroid because a
-- centroid can fall outside its own polygon when the shape is
-- concave. PointOnSurface is guaranteed to be inside.
-- ------------------------------------------------------------
SELECT
  count(*)                                                AS total_parcels,
  count(*) FILTER (WHERE p.geom IS NULL)                   AS null_geometry,
  count(*) FILTER (WHERE m.n = 1)                          AS matched_one_block,
  count(*) FILTER (WHERE m.n = 0 AND p.geom IS NOT NULL)   AS matched_no_block,
  count(*) FILTER (WHERE m.n > 1)                          AS matched_multiple,
  count(*) FILTER (WHERE m.n = 1
                     AND p.block_id IS DISTINCT FROM m.block_id) AS would_change
FROM vsl_parcels p
LEFT JOIN LATERAL (
  SELECT count(*) AS n, (array_agg(b.id))[1] AS block_id
  FROM vsl_blocks b
  WHERE ST_Contains(b.geom, ST_PointOnSurface(p.geom))
) m ON true;

-- Last known result (668 parcels):
--   matched_one_block 667 | matched_no_block 1 | matched_multiple 0
--   would_change 27   <-- investigate these before updating


-- ------------------------------------------------------------
-- 2. The orphans — parcels inside no block at all.
--    Nearest block + distance in metres helps you judge whether
--    it is a digitising sliver or genuinely outside.
-- ------------------------------------------------------------
SELECT
  p.id,
  p.parcel_code,
  p.parcel_name,
  ST_AsText(ST_PointOnSurface(p.geom))          AS test_point,
  n.block_code                                   AS nearest_block,
  round(n.dist_m::numeric, 2)                    AS metres_away
FROM vsl_parcels p
LEFT JOIN LATERAL (
  SELECT b.block_code,
         ST_Distance(b.geom::geography,
                     ST_PointOnSurface(p.geom)::geography) AS dist_m
  FROM vsl_blocks b
  ORDER BY b.geom <-> ST_PointOnSurface(p.geom)
  LIMIT 1
) n ON true
WHERE p.geom IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM vsl_blocks b
    WHERE ST_Contains(b.geom, ST_PointOnSurface(p.geom))
  );


-- ------------------------------------------------------------
-- 3. The disagreements — stored block_id vs. geometry.
--    Review before running section 5.
-- ------------------------------------------------------------
SELECT
  p.id,
  p.parcel_code,
  old_b.block_code AS currently_assigned,
  new_b.block_code AS geometry_says
FROM vsl_parcels p
JOIN vsl_blocks new_b
  ON ST_Contains(new_b.geom, ST_PointOnSurface(p.geom))
LEFT JOIN vsl_blocks old_b
  ON old_b.id = p.block_id
WHERE p.block_id IS DISTINCT FROM new_b.id
ORDER BY p.parcel_code;


-- ------------------------------------------------------------
-- 4. Data-quality check on the block layer itself.
--    2 of 28 blocks currently sit outside every estate polygon.
-- ------------------------------------------------------------
SELECT b.id, b.block_code, b.block_name, b.estate_id
FROM vsl_blocks b
WHERE NOT EXISTS (
  SELECT 1 FROM vsl_estate e WHERE ST_Intersects(e.geom, b.geom)
);

-- Overlapping blocks would cause matched_multiple > 0 in section 1.
SELECT a.block_code AS block_a,
       b.block_code AS block_b,
       round(ST_Area(ST_Intersection(a.geom, b.geom)::geography)::numeric, 1) AS overlap_m2
FROM vsl_blocks a
JOIN vsl_blocks b ON a.id < b.id AND ST_Overlaps(a.geom, b.geom);


-- ------------------------------------------------------------
-- 5. COMMIT — only after sections 1–4 look right.
-- ------------------------------------------------------------
UPDATE vsl_parcels p
SET block_id   = b.id,
    updated_at = now()
FROM vsl_blocks b
WHERE ST_Contains(b.geom, ST_PointOnSurface(p.geom))
  AND p.block_id IS DISTINCT FROM b.id;


-- ============================================================
-- 6. IMPORT WORKFLOW for new plots (~200)
--    Land raw -> resolve -> audit -> promote.
--    Live data is never touched until the final INSERT.
-- ============================================================

CREATE TABLE IF NOT EXISTS staging_parcels (
  parcel_code         text,
  parcel_name         text,
  expected_area_acres numeric,
  geom                geometry(Polygon, 4326),
  block_id            uuid,          -- filled in by 6b
  reject_reason       text           -- filled in by 6c
);

-- 6a. Load the 200 rows into staging_parcels here.
--     (COPY, Supabase import, ogr2ogr, whatever suits.)
--     Confirm the SRID survived the trip:
--        SELECT DISTINCT ST_SRID(geom) FROM staging_parcels;  -- expect 4326

-- 6b. Resolve blocks inside staging only.
UPDATE staging_parcels s
SET block_id = b.id
FROM vsl_blocks b
WHERE ST_Contains(b.geom, ST_PointOnSurface(s.geom));

-- 6c. Flag anything that cannot be promoted.
UPDATE staging_parcels s
SET reject_reason = CASE
  WHEN s.geom IS NULL                                        THEN 'no geometry'
  WHEN NOT ST_IsValid(s.geom)                                THEN 'invalid geometry'
  WHEN s.block_id IS NULL                                    THEN 'outside all blocks'
  WHEN EXISTS (SELECT 1 FROM vsl_parcels p
               WHERE p.parcel_code = s.parcel_code)          THEN 'duplicate parcel_code'
END;

-- 6d. AUDIT. This is the go / no-go gate.
SELECT coalesce(reject_reason, 'OK — ready to import') AS status,
       count(*)
FROM staging_parcels
GROUP BY 1
ORDER BY 2 DESC;

-- Sanity-check digitised area against what was declared (>10% drift).
SELECT parcel_code,
       expected_area_acres                                       AS declared,
       round((ST_Area(geom::geography) / 4046.86)::numeric, 3)    AS computed_acres
FROM staging_parcels
WHERE expected_area_acres IS NOT NULL
  AND abs(ST_Area(geom::geography) / 4046.86 - expected_area_acres)
      > 0.1 * expected_area_acres;

-- 6e. Promote the clean rows.
INSERT INTO vsl_parcels (parcel_code, parcel_name, expected_area_acres, geom, block_id)
SELECT parcel_code, parcel_name, expected_area_acres, geom, block_id
FROM staging_parcels
WHERE reject_reason IS NULL;

-- 6f. Rejects stay behind for manual fixing. Inspect, correct,
--     re-run 6b–6e, and drop the table when finished.
SELECT * FROM staging_parcels WHERE reject_reason IS NOT NULL;
-- DROP TABLE staging_parcels;


-- ============================================================
-- NOTE ON UNITS
-- SRID 4326 is degrees. ST_Contains is topological so degrees are
-- fine there, but ST_Area / ST_Distance in 4326 return square
-- degrees and degrees — meaningless on the ground. Always cast to
-- ::geography for metres, as done above. 1 acre = 4046.86 m2.
-- ============================================================
