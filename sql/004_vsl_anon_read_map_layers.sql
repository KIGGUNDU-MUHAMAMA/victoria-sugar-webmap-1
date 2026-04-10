-- Allow anonymous (guest) map users to READ geometries for display.
-- Without this, vsl_get_features_bbox returns no rows when called with the anon key
-- (RLS previously allowed SELECT only for role "authenticated").

drop policy if exists "blocks read anon map" on public.vsl_blocks;
drop policy if exists "parcels read anon map" on public.vsl_parcels;

create policy "blocks read anon map" on public.vsl_blocks
  for select to anon
  using (true);

create policy "parcels read anon map" on public.vsl_parcels
  for select to anon
  using (true);

grant execute on function public.vsl_get_features_bbox(
  double precision,
  double precision,
  double precision,
  double precision
) to anon;
