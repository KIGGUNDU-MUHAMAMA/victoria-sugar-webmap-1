-- Migration: 014_vsl_reports_alerts_settings.sql
-- Purpose: (1) Report recipients can now be subscribed to multiple report
--          types (checkboxes in the dashboard instead of one dropdown), so
--          report_type (single text) is superseded by report_types (text[]);
--          (2) a real, persisted schedule-settings table replaces the old
--          hardcoded/session-only "Automated Schedule Settings" toggle list.
--
-- Applied directly against the live "victoriasugar" Supabase project
-- (knhgliyghacvkeeptsfl) via the Supabase MCP; recorded here so the sql/
-- folder stays a faithful history of the schema.

-- ── 1. Report recipients — multiple report types ────────────────────────
alter table public.vsl_report_recipients add column if not exists report_types text[] not null default '{}';

update public.vsl_report_recipients set report_types = ARRAY[
  case report_type
    when 'Harvest Log' then 'Harvests Reports'
    when 'Weekly Field Update' then 'Activity Reports'
    when 'Agronomic Scouting Report' then 'Land Status Reports'
    else 'Summary Report'
  end
] where report_types = '{}';

alter table public.vsl_report_recipients alter column report_type drop not null;

comment on column public.vsl_report_recipients.report_types is
  'Report types this recipient receives — subset of Land Status Reports / Activity Reports / Harvests Reports / Summary Report.';
comment on column public.vsl_report_recipients.report_type is
  'Deprecated — superseded by report_types (array, supports multiple selections). Left populated for historical rows only.';

-- ── 2. Automated report schedule settings ───────────────────────────────
create table if not exists public.vsl_report_schedule_settings (
  frequency text primary key check (frequency in ('Daily','Weekly','Monthly')),
  enabled boolean not null default true,
  day_of_week integer check (day_of_week between 0 and 6), -- 0=Sunday .. 6=Saturday; Weekly only
  day_of_month integer check (day_of_month between 1 and 31), -- Monthly only
  time_of_day time not null default '07:00',
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

insert into public.vsl_report_schedule_settings (frequency, enabled, day_of_week, day_of_month, time_of_day) values
  ('Daily', true, null, null, '07:00'),
  ('Weekly', true, 1, null, '07:00'),
  ('Monthly', true, null, 1, '07:00')
on conflict (frequency) do nothing;

alter table public.vsl_report_schedule_settings enable row level security;
create policy "report_schedule read authenticated" on public.vsl_report_schedule_settings for select to authenticated using (true);
create policy "report_schedule write admin" on public.vsl_report_schedule_settings for all to authenticated
  using (vsl_is_role('ADMIN')) with check (vsl_is_role('ADMIN'));

-- Note: no schema change was needed for Alerts (logged-by/resolved-by
-- "raise again") — vsl_alerts.created_by/resolved_by already existed, the
-- dashboard just wasn't joining them against vsl_profiles for display.
