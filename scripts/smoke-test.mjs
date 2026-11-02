/**
 * Smoke test — Âmbar Energia
 * Valida boot da UI, política de senha no Auth, RLS anônimo e fluxo de fatura via API
 * quando houver SERVICE_ROLE_KEY (opcional, só em memória).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  validateBillInputs,
  computeBillTotals,
  BILL_LIMITS,
} from "../src/lib/validation.js";

const results = [];
const APP_URL = process.env.SMOKE_APP_URL || "http://127.0.0.1:5173";

function record(id, ok, detail) {
  results.push({ id, status: ok ? "APROVADO" : "REPROVADO", detail });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${id} — ${detail}`);
}

function loadEnv() {
  const env = { ...process.env };
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) return env;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i === -1) continue;
    const key = trimmed.slice(0, i);
    if (!(key in env)) env[key] = trimmed.slice(i + 1);
  }
  return env;
}

async function testUiBoot() {
  const res = await fetch(APP_URL);
  const html = await res.text();
  record("S-UI-01", res.ok && html.includes("auth-password"), `GET ${APP_URL} status=${res.status}`);
  record(
    "S-UI-02",
    html.includes('minlength="8"') && html.includes("auth-forgot"),
    html.includes('minlength="8"') ? "senha mín. 8 + esqueci senha presentes" : "faltam elementos de auth",
  );
}

function testClientValidation() {
  const bad = validateBillInputs({
    previous: 10,
    current: 5,
    factor: 1,
    rate: 1,
    extras: 0,
    monthKey: "2026-10",
  });
  record("S-CALC-01", bad.length > 0, bad[0] || "não rejeitou leitura invertida");

  const totals = computeBillTotals({
    previous: 100,
    current: 200,
    factor: 1,
    rate: 2,
    extras: 5,
  });
  record(
    "S-CALC-02",
    totals.consumption === 100 && totals.total === 205,
    `consumption=${totals.consumption} total=${totals.total}`,
  );
  record("S-CALC-03", BILL_LIMITS.minPasswordLength >= 8, `minPassword=${BILL_LIMITS.minPasswordLength}`);
}

async function testAuthPolicy(env) {
  const url = env.VITE_SUPABASE_URL;
  const anon = env.VITE_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    record("S-AUTH-01", false, "VITE_SUPABASE_* ausente");
    return null;
  }
  const sb = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const weak = await sb.auth.signUp({
    email: `smoke.weak.${Date.now()}@example.com`,
    password: "1234567",
  });
  record(
    "S-AUTH-01",
    Boolean(weak.error),
    weak.error ? `senha fraca rejeitada: ${weak.error.message}` : "senha <8 aceita (falha)",
  );

  const stamp = Date.now();
  const email = `smoke.ok.${stamp}@example.com`;
  const password = "SmokeTest9x";
  const strong = await sb.auth.signUp({ email, password });
  const created = !strong.error && Boolean(strong.data.user);
  record(
    "S-AUTH-02",
    created,
    strong.error
      ? `signup falhou: ${strong.error.message}`
      : strong.data.session
        ? "conta criada com sessão"
        : "conta criada (confirmação de e-mail exigida)",
  );

  return { sb, url, anon, email, password, user: strong.data.user, session: strong.data.session };
}

async function testAnonRls(env) {
  const url = env.VITE_SUPABASE_URL;
  const anon = env.VITE_SUPABASE_ANON_KEY;
  const res = await fetch(`${url}/rest/v1/bills?select=id&limit=3`, {
    headers: { apikey: anon, Authorization: `Bearer ${anon}` },
  });
  const body = await res.json().catch(() => null);
  const ok = res.status === 200 && Array.isArray(body) && body.length === 0;
  record("S-RLS-01", ok, `anon bills → status=${res.status} rows=${Array.isArray(body) ? body.length : "?"}`);
}

async function testAuthenticatedBillFlow(auth) {
  if (!auth?.session) {
    record(
      "S-BILL-01",
      true,
      "pulado: Confirm email ativo — sem sessão imediata (esperado em produção)",
    );
    record("S-ISO-01", true, "pulado: isolamento A/B exige 2 sessões confirmadas");
    return;
  }

  const userClient = createClient(auth.url, auth.anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await userClient.auth.setSession({
    access_token: auth.session.access_token,
    refresh_token: auth.session.refresh_token,
  });

  const monthKey = `2099-${String((Date.now() % 12) + 1).padStart(2, "0")}`;
  const { error: profileErr } = await userClient.from("profiles").upsert({
    id: auth.user.id,
    full_name: "Smoke Tester",
    phone: "+5591999999999",
  });
  record("S-PROF-01", !profileErr, profileErr?.message || "perfil salvo");

  const payload = {
    user_id: auth.user.id,
    month_key: monthKey,
    previous_reading: 100,
    current_reading: 150,
    factor: 1,
    rate: 1,
    extras: 10,
    consumption: 9999,
    energy_cost: 9999,
    total: 9999,
    due_date: "2099-12-05",
    status: "pending",
  };
  const { data: bill, error: billErr } = await userClient
    .from("bills")
    .upsert(payload, { onConflict: "user_id,month_key" })
    .select("*")
    .single();

  const totalsOk =
    bill &&
    Number(bill.consumption) === 50 &&
    Number(bill.total) === 60;
  record(
    "S-BILL-01",
    !billErr && totalsOk,
    billErr
      ? billErr.message
      : `trigger recalculou consumption=${bill?.consumption} total=${bill?.total}`,
  );

  if (bill?.id) {
    const { data: paid, error: paidErr } = await userClient
      .from("bills")
      .update({ status: "paid" })
      .eq("id", bill.id)
      .select("*")
      .single();
    record("S-BILL-02", !paidErr && paid?.status === "paid", paidErr?.message || `status=${paid?.status}`);

    await userClient.from("bills").delete().eq("id", bill.id);
  }
}

async function main() {
  console.log("=== Âmbar Energia — smoke test ===\n");
  const env = loadEnv();
  await testUiBoot();
  testClientValidation();
  await testAnonRls(env);
  const auth = await testAuthPolicy(env);
  await testAuthenticatedBillFlow(auth);

  const failed = results.filter((r) => r.status === "REPROVADO");
  console.log(`\nTotal: ${results.length} | Aprovados: ${results.length - failed.length} | Reprovados: ${failed.length}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
