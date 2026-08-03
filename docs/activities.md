# Activity Log — Activities & Properties (draft, for pruning)

> **Superseded as of the activity-catalog migration.** The 17 activities actually
> live in vsl_activities, their extra properties in vsl_activity_type_properties
> is the current source of truth for what's actually implemented — both the
> webmap's Log Activity form and the dashboard's Add/Edit Activity forms read
> the catalog from those tables, not from this file. This document is kept only
> as historical/design context; several fields mentioned below (completion_unit,
> an 18th "Cultivator" activity, per-property cost fields, etc.) were never
> implemented and don't exist in the live schema — see the "Implementation
> notes" section right below for what's actually live.

Source: Appendix A of `VSL_System_Schema_and_Features_v4.md` (18 finalized `plot_tasks.task_type` values), expanded with your supplied base properties plus additional candidate properties per activity. Auto-captured fields (date/time logged, logged-by user, plot/block/estate context) are excluded, as you noted.

Every activity shares four properties by default — Team size, Completion, Challenges, Comments — plus Completion always works the same way: a dropdown for unit (**Acres** / **%**) and a numeric input for the value. These are repeated per activity below so each one reads standalone; delete the ones you don't want per activity.

## Implementation notes (v3, as actually live in Supabase)

- The canonical activity table is `vsl_activities`, not `plot_tasks`. The 18 values below live in a single column, **`activity_name`** (text, CHECK-constrained to exactly these 18 Title-Case strings) — there is no separate `activity_type` column; the two were merged per your instruction.
- The shared fields (Team size → `team_size`, Completion → `completion_unit` + `completion_value`, Challenges → `challenges`, Comments → `comments`) are real typed columns on `vsl_activities`, along with `status`, `method`, `number_of_machines`, `due_date`, `completed_date`, `estimated_cost`, `actual_cost`, `currency`, `task_description`.
- Every other activity-specific property listed per activity below (plough type, machine type, vegetation density, chemical type, etc.) is stored in one flexible column: **`activity_properties`** (jsonb), keyed by the property name — not as ~150 individual sparse columns.
- `assigned_to` is now a `uuid` FK to `vsl_profiles`; the old free-text assignee value is preserved separately as `assigned_to_legacy`.
- Logging an activity also updates `vsl_parcels.current_activity_id` / `current_activity_name` (trigger-maintained) and, for land-linked properties, syncs into the plot record per the map in `plot-details-v2.md`.

---

## 1. Bush Clearing
Clearing vegetation/undergrowth on new or fallow land before ploughing.

- Team size
- Completion (Acres / %)
- Method —  Machinery / Slashing / Manual cutting / Burning
- Machine type — Bulldozer / Brush cutter / Tractor + slasher / Excavator
- Number of machines
- Vegetation density — Light / Medium / Heavy
- Clearing depth — Surface clearing only / Includes stump & root removal
- Disposal method — Burning / Piling / Mulching in place / Hauled away
- Land type — New land / Fallow reclamation
- Fuel used (litres)
- Hours worked
- Safety incidents (y/n + note)
- Challenges
- Comments

## 2. Ploughing
Primary tillage, turning over the soil.

- Plough type — First / Second / Third
- Team size
- Completion (Acres / %)
- Method — Machinery / Ox-drawn / Manual
- Number of machines
- Implement used — Disc plough / Moldboard plough / Chisel plough
- Plough depth (cm)
- Tractor horsepower
- Soil moisture condition — Dry / Moist / Wet
- Number of passes
- Fuel used (litres)
- Hours worked
- Operator name
- Challenges
- Comments

## 3. Harrow
Secondary tillage, breaking clods after ploughing.

- Type — Disc harrow / Spike-tooth harrow / Tine harrow / Rotary harrow
- Team size
- Completion (Acres / %)
- Method — Machinery / Manual
- Number of machines
- Harrow depth (cm)
- Number of passes
- Clod size before → after
- Soil moisture condition
- Fuel used (litres)
- Hours worked
- Operator name
- Challenges
- Comments

## 4. Ripping
Sub-soil ripping to break compacted soil layers.

- Team size
- Completion (Acres / %)
- Method — Machinery / Manual
- Number of machines
- Ripping depth (cm)
- Rip line spacing (m)
- Number of tynes/shanks
- Soil compaction level observed (before)
- Tractor horsepower
- Fuel used (litres)
- Hours worked
- Operator name
- Challenges
- Comments

## 5. Ridging
Forming raised beds/ridges ahead of planting.

- Team size
- Spacing (meters)
- Completion (Acres / %)
- Method — Machinery / Manual
- Number of machines
- Ridge height (cm)
- Ridge width (cm)
- Row orientation/direction
- Number of ridges formed
- Implement used (ridger)
- Fuel used (litres)
- Hours worked
- Operator name
- Challenges
- Comments

## 6. Furrowing
Opening furrows/trenches for laying setts.

- Team size
- Completion (Acres / %)
- Method — Machinery / Manual / Ox-drawn
- Number of machines (if applicable)
- Furrow depth (cm)
- Furrow spacing (m)
- Number of furrows opened
- Total furrow length (m)
- Implement used
- Fuel used (litres)
- Hours worked
- Operator name
- Challenges
- Comments

## 7. Lime Application
Applying agricultural lime to correct soil acidity.

- Team size
- Lime quantity (kg)
- Lime type/name
- Completion (Acres / %)
- Application method — Manual broadcast / Mechanical spreader
- Application rate (kg/acre or kg/ha)
- Number of machines
- Soil pH before application
- Target soil pH
- Incorporation method — Ploughed in / Harrowed in / Left on surface
- Supplier
- Cost of lime
- Challenges
- Comments

## 8. Planting
Laying sugarcane setts into furrows and covering them.

- Team size
- Number of setts
- Cane variety
- Completion (Acres / %)
- Method — Machinery / Manual
- Number of machines (if applicable)
- Sett source — Own nursery / Purchased / Certified seed cane
- Row/sett spacing (m)
- Planting depth (cm)
- Seed rate (setts/acre or tonnes/ha)
- Ratoon number (0 = plant crop)
- Basal fertilizer applied at planting (y/n)
- Cost of setts
- Expected germination date
- Weather condition
- Challenges
- Comments

## 9. Manuring
Applying organic manure/compost.

- Team size
- Manure type — Farmyard manure / Compost / Poultry manure / Green manure
- Quantity
- Completion (Acres / %)
- Method — Machinery / Manual / Broadcast
- Number of machines
- Application rate (kg or tonnes/acre)
- Manure source
- Incorporation method
- Cost
- Supplier
- Challenges
- Comments

## 10. Fertilization
Applying inorganic fertilizer (basal or top dressing).

- Team size
- Fertilizer name
- Quantity
- Completion (Acres / %)
- Method — Machinery / Manual / Broadcast
- Number of machines
- Application type — Basal / Top dressing / Foliar
- Application rate (kg/acre)
- NPK ratio
- Timing relative to planting/growth stage
- Incorporation method
- Cost
- Supplier
- Weather condition
- Challenges
- Comments

## 11. Weeding
Manual or hand removal of weeds.

- Team size
- Completion (Acres / %)
- Method — Manual hand-pulling / Hoeing / Machinery (inter-row cultivator)
- Number of machines
- Weeding round — 1st / 2nd / 3rd+
- Weed pressure — Light / Medium / Heavy
- Dominant weed type
- Tools used — Hoe / Machete / Cultivator
- Labor productivity (acres per person per day)
- Cost
- Challenges
- Comments

## 12. Cultivator
Mechanical inter-row cultivation to loosen soil and control weeds between rows. *(This was in the finalized 18-item Appendix A list but not in your message above — including it for completeness; drop if not needed.)*

- Team size
- Completion (Acres / %)
- Method — Machinery / Manual
- Number of machines
- Cultivation depth (cm)
- Row spacing
- Implement type
- Number of passes
- Fuel used (litres)
- Hours worked
- Operator name
- Challenges
- Comments

## 13. Spraying
Pesticide/fungicide/herbicide application.

- Team size
- Medicine name (chemical/product)
- Quantity
- Completion (Acres / %)
- Method — Machinery / Manual (knapsack) / Drone
- Number of machines
- Chemical type — Herbicide / Pesticide / Fungicide
- Active ingredient
- Target pest/disease/weed
- Dilution rate
- Water volume used (litres)
- Application equipment — Knapsack sprayer / Boom sprayer / Drone / Tractor-mounted
- Weather condition (wind speed, rain forecast)
- PPE used (y/n)
- Pre-harvest/withholding period (days)
- Supplier
- Batch/expiry date
- Cost
- Challenges
- Comments

## 14. Irrigation
Watering the crop (furrow/drip/sprinkler).

- Team size
- Completion (Acres / %)
- Method — Furrow / Drip / Sprinkler / Flood / Hand-watering
- Litres pumped
- Water source
- Duration (hours)
- Pump type/fuel used
- Flow rate
- Soil moisture before/after
- Cost (fuel/electricity)
- Operator name
- Challenges
- Comments

## 15. Harvesting
Cutting and gathering mature cane.

- Team size
- Yield (Tonnes)
- Completion (Acres / %)
- Method — Machinery / Manual
- Number of machines
- Cutting method — Manual / Mechanical harvester
- Cane variety
- Ratoon number
- Brix reading
- Burnt cane / Green cane
- Cutting crew name
- Gross weight / Net weight (tonnes)
- Transport vehicle
- Mill destination
- Delivery ticket number
- Weather condition
- Challenges
- Comments

## 16. Loading
Loading harvested cane onto trucks/trailers for transport.

- Team size
- Completion (Acres / %)
- Method — Machinery / Manual
- Number of machines
- Loading equipment — Grab loader / Crane / Manual
- Number of trucks/trailers loaded
- Truck registration number
- Transport company/driver
- Load weight (tonnes)
- Waiting time
- Destination (mill name)
- Cost
- Challenges
- Comments

## 17. Trash Lining
Laying cut cane trash/residue in rows between planted rows after harvest.

- Team size
- Completion (Acres / %)
- Method — Machinery / Manual
- Number of machines
- Row spacing for trash lines
- Trash quantity/coverage
- Purpose — Moisture retention / Weed suppression / Nutrient recycling
- Challenges
- Comments

## 18. Trash Collection
Gathering/removing trash from the field.

- Team size
- Completion (Acres / %)
- Method — Machinery / Manual
- Number of machines
- Disposal method — Burning / Composting / Baling / Hauled away / Mulching
- Quantity collected (tonnes/bales)
- Purpose — Land prep for next season / Sale / Biomass use
- Transport vehicle (if removed)
- Cost
- Challenges
- Comments

---

## Candidate global properties (apply to any/all activities)
Fields that showed up across almost every activity above and could be pulled into a shared component instead of re-listed per activity:

- Team size
- Completion (unit dropdown: Acres / % + value)
- Method
- Number of machines
- Challenges
- Comments
- Supervisor/foreman name
- Weather condition
- Labor cost / Machinery cost

Not included per your note: date logged, logged-by user, plot/block/estate context — these come from session metadata, not user input.
