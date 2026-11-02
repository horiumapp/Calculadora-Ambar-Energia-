-- Âmbar Energia — schema multi-cliente
-- Rode no SQL Editor do Supabase

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  phone text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  month_key text not null,
  previous_reading numeric not null default 0,
  current_reading numeric not null default 0,
  factor numeric not null default 1,
  rate numeric not null default 0,
  extras numeric not null default 0,
  consumption numeric not null default 0,
  energy_cost numeric not null default 0,
  total numeric not null default 0,
  due_date date not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'overdue')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, month_key)
);

create table if not exists public.alert_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  bill_id uuid not null references public.bills (id) on delete cascade,
  phone text not null,
  message text not null,
  provider_sid text,
  sent_at timestamptz not null default now()
);

create index if not exists bills_user_month_idx on public.bills (user_id, month_key);
create index if not exists bills_due_status_idx on public.bills (due_date, status);
create index if not exists alert_logs_bill_day_idx on public.alert_logs (bill_id, sent_at);

alter table public.profiles enable row level security;
alter table public.bills enable row level security;
alter table public.alert_logs enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_insert_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "bills_select_own" on public.bills;
drop policy if exists "bills_insert_own" on public.bills;
drop policy if exists "bills_update_own" on public.bills;
drop policy if exists "bills_delete_own" on public.bills;
drop policy if exists "alert_logs_select_own" on public.alert_logs;
drop policy if exists "alert_logs_insert_own" on public.alert_logs;

create policy "profiles_select_own" on public.profiles for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update using (auth.uid() = id);

create policy "bills_select_own" on public.bills for select using (auth.uid() = user_id);
create policy "bills_insert_own" on public.bills for insert with check (auth.uid() = user_id);
create policy "bills_update_own" on public.bills for update using (auth.uid() = user_id);
create policy "bills_delete_own" on public.bills for delete using (auth.uid() = user_id);

create policy "alert_logs_select_own" on public.alert_logs for select using (auth.uid() = user_id);
create policy "alert_logs_insert_own" on public.alert_logs for insert with check (auth.uid() = user_id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'phone', '')
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists bills_touch on public.bills;
create trigger bills_touch before update on public.bills
for each row execute function public.touch_updated_at();

create or replace function public.refresh_overdue_bills()
returns void
language sql
security definer
set search_path = public
as $$
  update public.bills
  set status = 'overdue'
  where status = 'pending'
    and due_date < current_date;
$$;
