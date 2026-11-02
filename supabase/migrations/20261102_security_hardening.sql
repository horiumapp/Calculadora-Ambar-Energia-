-- Migration aditiva de hardening — Âmbar Energia
-- ANTES DE APLICAR NO PROJETO REMOTO:
-- 1) Faça backup (Table Editor → Export CSV ou pg_dump) de profiles, bills, alert_logs
-- 2) Rode no SQL Editor do Supabase em horário de baixo uso
-- 3) Se algum CHECK falhar por dados legados, corrija as linhas e rode de novo

-- Coluna de idempotência para alertas concorrentes
alter table public.alert_logs
  add column if not exists cooldown_key text;

create unique index if not exists alert_logs_cooldown_key_uidx
  on public.alert_logs (cooldown_key)
  where cooldown_key is not null;

alter table public.profiles
  drop constraint if exists profiles_full_name_len;
alter table public.profiles
  add constraint profiles_full_name_len check (char_length(full_name) <= 120);

alter table public.profiles
  drop constraint if exists profiles_phone_len;
alter table public.profiles
  add constraint profiles_phone_len check (char_length(phone) <= 32);

alter table public.alert_logs
  drop constraint if exists alert_logs_phone_len;
alter table public.alert_logs
  add constraint alert_logs_phone_len check (char_length(phone) <= 320);

alter table public.alert_logs
  drop constraint if exists alert_logs_message_len;
alter table public.alert_logs
  add constraint alert_logs_message_len check (char_length(message) <= 4000);

-- Constraints de integridade financeira (falham se houver dados inválidos)
alter table public.bills drop constraint if exists bills_month_key_format;
alter table public.bills
  add constraint bills_month_key_format check (month_key ~ '^\d{4}-(0[1-9]|1[0-2])$');

alter table public.bills drop constraint if exists bills_readings_nonneg;
alter table public.bills
  add constraint bills_readings_nonneg check (previous_reading >= 0 and current_reading >= 0);

alter table public.bills drop constraint if exists bills_readings_order;
alter table public.bills
  add constraint bills_readings_order check (current_reading >= previous_reading);

alter table public.bills drop constraint if exists bills_factor_positive;
alter table public.bills
  add constraint bills_factor_positive check (factor > 0 and factor <= 1000);

alter table public.bills drop constraint if exists bills_rate_bounds;
alter table public.bills
  add constraint bills_rate_bounds check (rate >= 0 and rate <= 100);

alter table public.bills drop constraint if exists bills_extras_bounds;
alter table public.bills
  add constraint bills_extras_bounds check (extras >= 0 and extras <= 100000);

alter table public.bills drop constraint if exists bills_total_bounds;
alter table public.bills
  add constraint bills_total_bounds check (total >= 0 and total <= 10000000);

-- Remove insert de alert_logs por usuários comuns (somente service role)
drop policy if exists "alert_logs_insert_own" on public.alert_logs;

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "bills_update_own" on public.bills;
create policy "bills_update_own" on public.bills
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

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
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.enforce_bill_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
    raise exception 'user_id da fatura é imutável';
  end if;

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

  new.consumption := (new.current_reading - new.previous_reading) * new.factor;
  new.energy_cost := new.consumption * new.rate;
  new.total := new.energy_cost + new.extras;

  if new.total < 0 or new.total > 10000000 then
    raise exception 'total fora do limite';
  end if;

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
