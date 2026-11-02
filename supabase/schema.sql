-- Âmbar Energia — schema multi-cliente (hardening de segurança)
-- Rode no SQL Editor do Supabase (projetos novos).
-- Projetos existentes: use também supabase/migrations/20261102_security_hardening.sql

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '',
  phone text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_full_name_len check (char_length(full_name) <= 120),
  constraint profiles_phone_len check (char_length(phone) <= 32)
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
  unique (user_id, month_key),
  constraint bills_month_key_format check (month_key ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  constraint bills_readings_nonneg check (previous_reading >= 0 and current_reading >= 0),
  constraint bills_readings_order check (current_reading >= previous_reading),
  constraint bills_factor_positive check (factor > 0 and factor <= 1000),
  constraint bills_rate_bounds check (rate >= 0 and rate <= 100),
  constraint bills_extras_bounds check (extras >= 0 and extras <= 100000),
  constraint bills_total_bounds check (total >= 0 and total <= 10000000)
);

create table if not exists public.alert_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  bill_id uuid not null references public.bills (id) on delete cascade,
  phone text not null,
  message text not null,
  provider_sid text,
  cooldown_key text,
  sent_at timestamptz not null default now(),
  constraint alert_logs_phone_len check (char_length(phone) <= 320),
  constraint alert_logs_message_len check (char_length(message) <= 4000)
);

create unique index if not exists alert_logs_cooldown_key_uidx
  on public.alert_logs (cooldown_key)
  where cooldown_key is not null;

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

create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_insert_own" on public.profiles
  for insert with check (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

create policy "bills_select_own" on public.bills
  for select using (auth.uid() = user_id);
create policy "bills_insert_own" on public.bills
  for insert with check (auth.uid() = user_id);
create policy "bills_update_own" on public.bills
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bills_delete_own" on public.bills
  for delete using (auth.uid() = user_id);

-- Clientes podem ler próprios logs; inserts só via service role (Edge Function).
create policy "alert_logs_select_own" on public.alert_logs
  for select using (auth.uid() = user_id);

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
    left(coalesce(new.raw_user_meta_data->>'full_name', ''), 120),
    left(coalesce(new.raw_user_meta_data->>'phone', ''), 32)
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
set search_path = public
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

create or replace function public.enforce_bill_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'user_id da fatura é imutável';
  end if;

  -- Sessão de usuário autenticado: força o dono; service_role (auth.uid nulo) preserva user_id.
  if auth.uid() is not null then
    new.user_id := auth.uid();
  end if;

  if new.month_key is null or new.month_key !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'month_key inválido';
  end if;

  if new.previous_reading < 0 or new.current_reading < 0 then
    raise exception 'leituras não podem ser negativas';
  end if;
  if new.current_reading < new.previous_reading then
    raise exception 'leitura atual menor que a anterior';
  end if;
  if new.factor is null or new.factor <= 0 or new.factor > 1000 then
    raise exception 'fator inválido';
  end if;
  if new.rate is null or new.rate < 0 or new.rate > 100 then
    raise exception 'tarifa inválida';
  end if;
  if new.extras is null or new.extras < 0 or new.extras > 100000 then
    raise exception 'extras inválidos';
  end if;

  -- Recalcula totais no servidor (não confia no cliente).
  new.consumption := (new.current_reading - new.previous_reading) * new.factor;
  new.energy_cost := new.consumption * new.rate;
  new.total := new.energy_cost + new.extras;

  if new.total < 0 or new.total > 10000000 then
    raise exception 'total fora do limite';
  end if;

  -- Vencimento derivado do mês (dia 5 do mês seguinte).
  new.due_date := (
    make_date(
      split_part(new.month_key, '-', 1)::int,
      split_part(new.month_key, '-', 2)::int,
      1
    ) + interval '1 month' + interval '4 days'
  )::date;

  if new.status is null or new.status not in ('pending', 'paid', 'overdue') then
    new.status := 'pending';
  end if;

  if new.status <> 'paid' then
    if new.due_date < current_date then
      new.status := 'overdue';
    else
      new.status := 'pending';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists bills_enforce_integrity on public.bills;
create trigger bills_enforce_integrity
  before insert or update on public.bills
  for each row execute function public.enforce_bill_integrity();

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

revoke all on function public.refresh_overdue_bills() from public;
revoke all on function public.refresh_overdue_bills() from anon, authenticated;
grant execute on function public.refresh_overdue_bills() to service_role;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon, authenticated;

revoke all on function public.enforce_bill_integrity() from public;
revoke all on function public.enforce_bill_integrity() from anon, authenticated;
