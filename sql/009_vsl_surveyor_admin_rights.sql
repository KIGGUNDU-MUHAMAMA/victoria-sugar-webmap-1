-- 009_vsl_surveyor_admin_rights.sql
-- This migration ensures SURVEYOR has the exact same rights as ADMIN on all functionality.

-- 1. Elevate SURVEYOR to manage vsl_profiles just like ADMIN
drop policy if exists "profiles self read" on public.vsl_profiles;
create policy "profiles self read" on public.vsl_profiles
  for select to authenticated
  using (id = auth.uid() or public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));

drop policy if exists "profiles self update" on public.vsl_profiles;
create policy "profiles self update" on public.vsl_profiles
  for update to authenticated
  using (id = auth.uid() or public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'))
  with check (id = auth.uid() or public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));

drop policy if exists "profiles admin delete" on public.vsl_profiles;
create policy "profiles admin delete" on public.vsl_profiles
  for delete to authenticated
  using (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));

-- 2. Explicitly define DELETE privileges for vsl_blocks and vsl_parcels for SURVEYOR
--    (The 'for all' policy in 001 covers this, but adding an explicit 'for delete' policy 
--    ensures that no previous configuration or policy limits this capability)
drop policy if exists "blocks delete by admin_surveyor" on public.vsl_blocks;
create policy "blocks delete by admin_surveyor" on public.vsl_blocks
  for delete to authenticated
  using (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));

drop policy if exists "parcels delete by admin_surveyor" on public.vsl_parcels;
create policy "parcels delete by admin_surveyor" on public.vsl_parcels
  for delete to authenticated
  using (public.vsl_is_role('ADMIN') or public.vsl_is_role('SURVEYOR'));
