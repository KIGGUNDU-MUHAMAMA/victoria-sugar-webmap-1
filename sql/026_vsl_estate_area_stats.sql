-- ---------------------------------------------------------------------------
-- 026 — Estate area and total plots area, read from the database
--
-- The estate Info window used to add these up in the browser: fetch every
-- block, fetch every plot, sum them in JavaScript. Two problems with that.
-- It ships hundreds of rows to compute two numbers, and — worse — it makes
-- every client its own authority on what an estate's area is, so the webmap,
-- the dashboard and a PDF export can each disagree.
--
-- The hierarchy is now summed where the rows live:
--
--     plot area            vsl_parcels.area_acres   (geometry, per plot)
--     block area           vsl_blocks.area_acres    (geometry, per block)
--     ESTATE AREA          sum of its blocks        } vsl_estate_stats
--     TOTAL PLOTS AREA     sum of its plots         }
--
-- Three parts below: the trigger that guarantees area_acres really is the
-- geometric area, a backfill for rows where it wasn't, and the view.
-- ---------------------------------------------------------------------------

-- ── 1. Geometry is the source of truth, on edit as well as on create ─────
-- The old version of this trigger only recomputed on UPDATE if the geometry
-- had changed AND the client hadn't also sent an area_acres of its own:
--
--     IF NEW.area_acres IS NULL
--        OR (NEW.geom IS DISTINCT FROM OLD.geom
--            AND NEW.area_acres IS NOT DISTINCT FROM OLD.area_acres)
--
-- so a client that posted both a reshaped polygon and its own area figure
-- had its figure kept, and the column quietly stopped matching the shape.
-- Now: if there is geometry, the area is computed from it, always. The only
-- case where a supplied number survives is a block with no geometry at all
-- (one exists — a block whose boundary hasn't been captured yet), where
-- there is nothing to compute from.
--
-- Shared by vsl_blocks and vsl_parcels (trg_vsl_blocks_fill_area /
-- trg_vsl_parcels_fill_area, both BEFORE INSERT OR UPDATE FOR EACH ROW), so
-- plots and blocks cannot drift apart in how their area is defined — which
-- matters now that the Info window shows an estate's block area and plot
-- area side by side, where any difference in method reads as a real gap
-- between the two.
create or replace function public.vsl_fill_area_acres()
returns trigger
language plpgsql
as $function$
begin
  if new.geom is not null then
    new.area_acres := public.vsl_geom_area_acres(new.geom);
  elsif tg_op = 'INSERT' then
    new.area_acres := coalesce(new.area_acres, 0);
  else
    -- No geometry to measure: keep whatever figure is on the row (a manual
    -- estimate for an uncaptured boundary), rather than zeroing it.
    new.area_acres := coalesce(new.area_acres, old.area_acres, 0);
  end if;
  return new;
end;
$function$;

-- ── 2. Backfill the rows that had drifted ───────────────────────────────
-- At the time of writing: 10 of 47 blocks were off by more than 0.01 ac and
-- 53 of 835 plots by rounding only. Every block was stored LARGER than its
-- geometry by a consistent ~0.75%, which is the signature of an import that
-- measured on the spheroid rather than in UTM 36N — not random error. The
-- project's one definition of area is vsl_geom_area_acres (EPSG:32636,
-- which is the zone Uganda sits in), used by every plot and by the trigger
-- above, so these are brought onto it. The affected blocks therefore report
-- slightly smaller areas than before (largest: BLOCK450, 483.27 → 479.68).
--
-- The UPDATE re-fires the trigger, which recomputes the same value — this
-- is idempotent, and it also bumps vsl_sync_version so clients holding a
-- cached copy of the land data refetch it.
update public.vsl_blocks
set area_acres = public.vsl_geom_area_acres(geom)
where geom is not null
  and area_acres is distinct from public.vsl_geom_area_acres(geom);

update public.vsl_parcels
set area_acres = public.vsl_geom_area_acres(geom)
where geom is not null
  and area_acres is distinct from public.vsl_geom_area_acres(geom);

-- ── 3. vsl_estate_stats — one row per estate ────────────────────────────
-- The two sides are aggregated in SEPARATE subqueries and then joined, not
-- in one estate→block→plot join. In a single join each block's area_acres
-- would repeat once per plot in that block, and summing it would multiply
-- the estate's area by the average plots-per-block. (The same reason
-- vsl_block_stats can group by b.id, b.geom — it only sums the plot side.)
--
-- security_invoker = on so the view reads under the caller's own RLS rather
-- than the view owner's, matching vsl_parcel_stats. All three underlying
-- tables are readable by authenticated and anon ("blocks read all",
-- "parcels read all", "Enable read access for all users"), so this grants
-- nobody anything new — it just stops the view from being a way around RLS
-- if those policies are ever tightened.
--
-- Rounded to 3 decimals, the same precision vsl_geom_area_acres returns;
-- the UI formats to 2.
create or replace view public.vsl_estate_stats
with (security_invoker = on) as
select
  e.id                                            as estate_id,
  coalesce(b.total_blocks, 0)                     as total_blocks,
  -- "Estate area": the sum of its blocks' geometric areas.
  round(coalesce(b.block_area_acres, 0), 3)       as block_area_acres,
  coalesce(p.total_plots, 0)                      as total_plots,
  -- "Total plots area": the sum of its plots' geometric areas. Normally
  -- smaller than the block area above — the difference is roads, headlands,
  -- waterways and anything else inside a block that isn't a plot.
  round(coalesce(p.plot_area_acres, 0), 3)        as plot_area_acres,
  round(coalesce(p.planted_plots_area_acres, 0), 3) as planted_plots_area_acres
from public.vsl_estate e
left join (
  select
    estate_id,
    count(*)                      as total_blocks,
    sum(coalesce(area_acres, 0))  as block_area_acres
  from public.vsl_blocks
  where estate_id is not null
  group by estate_id
) b on b.estate_id = e.id
left join (
  select
    bl.estate_id,
    count(pa.id)                     as total_plots,
    sum(coalesce(pa.area_acres, 0))  as plot_area_acres,
    sum(coalesce(pa.area_acres, 0)) filter (
      where pa.cultivation_status is not null
        and pa.cultivation_status <> 'vacant'
    )                                as planted_plots_area_acres
  from public.vsl_parcels pa
  join public.vsl_blocks bl on bl.id = pa.block_id
  where bl.estate_id is not null
  group by bl.estate_id
) p on p.estate_id = e.id;

comment on view public.vsl_estate_stats is
  'Per-estate totals for the Info window: block_area_acres (the estate area, summed from vsl_blocks.area_acres) and plot_area_acres (summed from vsl_parcels.area_acres via their blocks). Both sides are aggregated separately before joining so block area is not repeated per plot.';

grant select on public.vsl_estate_stats to anon, authenticated, service_role;
