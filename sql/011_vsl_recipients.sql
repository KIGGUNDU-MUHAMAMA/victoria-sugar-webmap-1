-- Migration: 011_vsl_recipients.sql
-- Purpose: Add a shared table for report recipient emails.

create table if not exists public.vsl_report_recipients (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_vsl_report_recipients_email on public.vsl_report_recipients(email);

-- Enable RLS
alter table public.vsl_report_recipients enable row level security;

-- Policies: Shared access for ADMIN, SURVEYOR, MANAGER
-- Read access
drop policy if exists "recipients read all" on public.vsl_report_recipients;
create policy "recipients read all" on public.vsl_report_recipients for select to authenticated using (true);

-- Write access
drop policy if exists "recipients write admin_surveyor_manager" on public.vsl_report_recipients;
create policy "recipients write admin_surveyor_manager" on public.vsl_report_recipients for all to authenticated
using (
  public.vsl_is_role('ADMIN') or 
  public.vsl_is_role('SURVEYOR') or 
  public.vsl_is_role('MANAGER')
)
with check (
  public.vsl_is_role('ADMIN') or 
  public.vsl_is_role('SURVEYOR') or 
  public.vsl_is_role('MANAGER')
);
