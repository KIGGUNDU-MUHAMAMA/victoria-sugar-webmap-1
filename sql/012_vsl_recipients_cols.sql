-- Migration: 012_vsl_recipients_cols.sql
-- Purpose: Add freq, estate, report_type, last_sent columns to vsl_report_recipients
--          so the dashboard Email Reports page can save all subscriber fields.

alter table public.vsl_report_recipients
  add column if not exists freq text not null default 'weekly'
    check (freq in ('weekly','monthly','quarterly')),
  add column if not exists estate text not null default 'All Estates',
  add column if not exists report_type text not null default 'Season Summary Report',
  add column if not exists last_sent timestamptz;

-- Index on freq for filtering
create index if not exists idx_vsl_report_recipients_freq
  on public.vsl_report_recipients(freq);

-- Comment
comment on column public.vsl_report_recipients.freq        is 'Report dispatch frequency: weekly | monthly | quarterly';
comment on column public.vsl_report_recipients.estate       is 'Estate scope for the report, e.g. "All Estates" or a specific estate name';
comment on column public.vsl_report_recipients.report_type  is 'Report type label, e.g. "Season Summary Report"';
comment on column public.vsl_report_recipients.last_sent    is 'Timestamp of the last email dispatch to this recipient';
