-- ---------------------------------------------------------------------------
-- 030 — When each plot is next due to be cut
--
-- Two different sums, because a plant crop and a ratoon are not the same
-- clock:
--
--   plant crop (ratoon 0)  planting date      + crop_period_months
--   ratoon     (ratoon 1+) last harvest date  + ratoon_period_months
--
-- A ratoon with no harvest recorded yet falls back to the plant-crop sum —
-- better than nothing for a plot imported mid-cycle. Anything missing its
-- variety, its period or its start date yields NULL rather than a guess: a
-- blank "estimated harvest" is honest, an invented date is not.
--
-- last_harvest_date comes from the real harvest records (v_parcel_last_
-- harvest over vsl_harvests), not from the season's actual_harvest_date, so
-- it reflects what was actually weighed in.
--
-- Read by the plot Info panel (and its PDF export) and by the dashboard.
-- Applied as migration "vsl_parcel_harvest_forecast".
-- ---------------------------------------------------------------------------
create or replace view public.vsl_parcel_harvest_forecast
with (security_invoker = on) as
select
  p.id                                   as parcel_id,
  p.cultivation_status,
  p.ratoon_number,
  p.planting_date,
  lh.last_harvest_date,
  v.id                                   as cane_variety_id,
  v.name                                 as cane_variety,
  v.crop_period_months,
  v.ratoon_period_months,
  v.expected_yield_tons_per_acre,
  case when v.expected_yield_tons_per_acre is not null and p.area_acres is not null
       then round(v.expected_yield_tons_per_acre * p.area_acres, 1)
  end                                    as expected_yield_tonnes,
  case
    when coalesce(p.ratoon_number, 0) >= 1
         and lh.last_harvest_date is not null
         and v.ratoon_period_months is not null
      then (lh.last_harvest_date + (v.ratoon_period_months || ' months')::interval)::date
    when p.planting_date is not null and v.crop_period_months is not null
      then (p.planting_date + (v.crop_period_months || ' months')::interval)::date
  end                                    as estimated_harvest_date
from public.vsl_parcels p
left join public.vsl_parcel_seasons s on s.id = p.current_season_id
left join public.vsl_cane_variety v on v.id = s.cane_variety_id
left join public.v_parcel_last_harvest lh on lh.parcel_id = p.id;

grant select on public.vsl_parcel_harvest_forecast to anon, authenticated, service_role;
