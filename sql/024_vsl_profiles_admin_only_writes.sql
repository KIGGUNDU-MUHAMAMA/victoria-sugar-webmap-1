-- ---------------------------------------------------------------------------
-- 024 — vsl_profiles: only ADMIN may change other people's accounts, and
--       nobody may promote themselves
--
-- Three problems with the old policies:
--
--   1. SURVEYOR could UPDATE and DELETE any profile row. Surveyors edit
--      land, not accounts — one of them could rename, re-role or delete
--      every user in the system.
--
--   2. "profiles self update" allowed `id = auth.uid()` with no restriction
--      on WHICH columns. RLS cannot restrict columns, so any signed-in user
--      could run
--          update vsl_profiles set role = 'ADMIN' where id = auth.uid();
--      and become an administrator — which then satisfies vsl_is_role('ADMIN')
--      in every other policy in the database. That is full privilege
--      escalation from any account, and it is what the trigger below closes.
--
--   3. "profiles self insert" let the inserted row name its own role, so a
--      user whose profile row was missing could create it as ADMIN.
--
-- Who legitimately writes to this table:
--   • each user, to their own row — full_name / title / phone / avatar_url
--     from the map's "My profile" window (js/map-app.js), and last_login_at
--     stamped at sign-in (js/auth.js). All kept working.
--   • admins, to anyone's row — but always through the vsl-admin-users edge
--     function, which runs on the service role and checks the caller is
--     ADMIN itself (supabase/functions/vsl-admin-users/index.ts). The
--     service role bypasses RLS, so it is unaffected by the policies here;
--     the trigger exempts it explicitly, since triggers are NOT bypassed.
--
-- SELECT is left exactly as it was. Narrowing it would blank out the manager
-- and "logged by" names the map shows, which is a display question, not a
-- privilege one — worth revisiting separately.
-- ---------------------------------------------------------------------------

-- ── 1. UPDATE — your own row, or an admin ───────────────────────────────
drop policy if exists "profiles self update" on public.vsl_profiles;

create policy "profiles update self or admin"
  on public.vsl_profiles for update to authenticated
  using ((id = auth.uid()) or public.vsl_is_role('ADMIN'))
  with check ((id = auth.uid()) or public.vsl_is_role('ADMIN'));

-- ── 2. DELETE — admins only ─────────────────────────────────────────────
-- (The dashboard deletes accounts through the edge function, which removes
-- the auth user and lets the FK cascade take the profile. This policy is the
-- floor, not the route.)
drop policy if exists "profiles admin delete" on public.vsl_profiles;

create policy "profiles delete admin"
  on public.vsl_profiles for delete to authenticated
  using (public.vsl_is_role('ADMIN'));

-- ── 3. INSERT — your own row, and you don't get to pick a privileged role ──
-- Normal signup doesn't use this path at all: the vsl_handle_new_auth_user
-- trigger inserts the row as SECURITY DEFINER with the role from the invite.
-- This policy only covers a client-side self-heal, so MANAGMENT is the
-- ceiling unless an admin is doing it.
drop policy if exists "profiles self insert" on public.vsl_profiles;

create policy "profiles insert self unprivileged"
  on public.vsl_profiles for insert to authenticated
  with check (
    id = auth.uid()
    and (role = 'MANAGMENT' or public.vsl_is_role('ADMIN'))
  );

-- ── 4. The column guard ─────────────────────────────────────────────────
-- RLS decides WHICH ROWS you may update; it has nothing to say about which
-- COLUMNS. Self-service editing and self-promotion are the same UPDATE as
-- far as a policy is concerned, so the distinction has to be made here.
--
-- Whitelist, not blacklist: a non-admin may change only the handful of
-- presentation fields the app actually offers them. Any column added to
-- this table in future is therefore protected by default rather than
-- silently writable.
-- SECURITY INVOKER (the default) on purpose. As SECURITY DEFINER this
-- function runs as its owner, which makes current_user the owner's name for
-- every caller — so a "is the caller a privileged DB role?" test matches
-- always and the guard never fires. It needs no elevated rights anyway:
-- vsl_is_role() is itself SECURITY DEFINER.
create or replace function public.vsl_profiles_guard_self_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- The service role (edge functions) is trusted: it is server-side, and
  -- vsl-admin-users checks the caller is ADMIN before it writes. The service
  -- role bypasses RLS but NOT triggers, so without this an admin editing a
  -- user through the dashboard would trip the guard below.
  if coalesce(current_setting('request.jwt.claims', true)::json ->> 'role', '') = 'service_role' then
    return new;
  end if;

  -- No end-user identity at all: a migration, a psql session, the SQL
  -- editor, a SECURITY DEFINER routine. Nothing for this guard to police.
  if auth.uid() is null then
    return new;
  end if;

  if public.vsl_is_role('ADMIN') then
    return new;
  end if;

  -- Everyone else: these columns must come back unchanged.
  if new.id              is distinct from old.id
     or new.role         is distinct from old.role
     or new.email        is distinct from old.email
     or new.estate_id    is distinct from old.estate_id
     or new.is_active    is distinct from old.is_active
     or new.created_at   is distinct from old.created_at then
    raise exception
      'Only an administrator can change account settings (role, email, estate, active status). You may edit your own name, title, phone and photo.'
      using errcode = '42501'; -- insufficient_privilege
  end if;

  return new;
end;
$$;

drop trigger if exists vsl_profiles_guard_self_update on public.vsl_profiles;

create trigger vsl_profiles_guard_self_update
  before update on public.vsl_profiles
  for each row execute function public.vsl_profiles_guard_self_update();
