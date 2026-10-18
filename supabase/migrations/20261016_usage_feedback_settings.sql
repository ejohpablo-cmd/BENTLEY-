-- Run this once in Supabase -> SQL Editor. It only ADDS things; nothing existing is changed or deleted.

-- New setting: Bentley's personality (the old voice columns stay in the table, just unused).
alter table public.user_settings
  add column if not exists personality text not null default 'friendly'
    check (personality in ('friendly','professional','playful','direct'));

-- Usage counters for the "4 pictures / 3M tokens" cycle and the 1h 30m rest.
create table if not exists public.user_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tokens_used bigint not null default 0,
  images_used integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.user_usage enable row level security;
drop policy if exists "read own usage" on public.user_usage;
create policy "read own usage" on public.user_usage
  for select to authenticated using (user_id = auth.uid());
-- No insert/update policy on purpose: only the chat Edge Function (service role) writes it.

-- Feedback sent from Settings -> Feedback.
create table if not exists public.app_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null check (char_length(message) between 1 and 2000),
  created_at timestamptz not null default now()
);
alter table public.app_feedback enable row level security;
drop policy if exists "insert own app feedback" on public.app_feedback;
create policy "insert own app feedback" on public.app_feedback
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "read own app feedback" on public.app_feedback;
create policy "read own app feedback" on public.app_feedback
  for select to authenticated using (user_id = auth.uid());
