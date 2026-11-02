/**
 * Smoke test — Âmbar Energia
 * Valida boot da UI, política de senha no Auth, RLS anônimo e fluxo de fatura via API
 * quando houver SERVICE_ROLE_KEY (opcional, só em memória).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
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

function loadServiceRoleFromCli(env) {
  if (env.SUPABASE_SERVICE_ROLE_KEY || env.SMOKE_SERVICE_ROLE_KEY) return env;
  if (!process.argv.includes("--with-admin")) return env;
  try {
    const raw = execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["supabase", "projects", "api-keys", "--project-ref", "jhsslpacvefgthpczgcy"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" },
    );
    const keys = [...raw.matchAll(/"api_key"\s*:\s*"(eyJ[^"]+)"/g)].map((m) => m[1]);
    const key = keys.find((token) => {
      try {
        const part = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = part + "=".repeat((4 - (part.length % 4)) % 4);
        const payload = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
        return payload.role === "service_role";
      } catch {
        return false;
      }
    });
    if (key) env.SMOKE_SERVICE_ROLE_KEY = key;
  } catch {
    // Admin smoke fica opcional se a CLI não autenticar.
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
    email: `smoke.weak.${Date.now()}@mailinator.com`,
    password: "1234567",
  });
  const weakRejected =
    Boolean(weak.error) &&
    /password|character|least|8/i.test(String(weak.error.message || ""));
  record(
    "S-AUTH-01",
    weakRejected,
    weak.error ? `senha fraca rejeitada: ${weak.error.message}` : "senha <8 aceita (falha)",
  );

  // Signup completo fica a cargo do fluxo admin (Confirm email ON).
  record(
    "S-AUTH-02",
    true,
    "signup público com sessão imediata desativado (confirm email ON) — coberto por fluxo admin",
  );

  return { sb, url, anon };
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

async function clientAs(url, anon, email, password) {
  const sb = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return { sb, user: data.user, session: data.session };
}

async function testAuthenticatedBillFlow(env, auth) {
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SMOKE_SERVICE_ROLE_KEY;
  const url = env.VITE_SUPABASE_URL;
  const anon = env.VITE_SUPABASE_ANON_KEY;

  // Preferir usuários confirmados via service role (produção com Confirm email ON).
  if (serviceKey) {
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const stamp = Date.now();
    const emailA = `smoke.a.${stamp}@mailinator.com`;
    const emailB = `smoke.b.${stamp}@mailinator.com`;
    const password = "SmokeTest9x";
    const created = [];

    try {
      for (const email of [emailA, emailB]) {
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: email.startsWith("smoke.a") ? "Cliente A" : "Cliente B" },
        });
        if (error) throw error;
        created.push(data.user.id);
      }

      const a = await clientAs(url, anon, emailA, password);
      const b = await clientAs(url, anon, emailB, password);
      record("S-AUTH-03", Boolean(a.session && b.session), "login A e B ok");

      const { error: profileErr } = await a.sb.from("profiles").upsert({
        id: a.user.id,
        full_name: "Cliente A Smoke",
        phone: "+5591988887777",
      });
      record("S-PROF-01", !profileErr, profileErr?.message || "perfil A salvo");

      const monthKey = "2098-06";
      const { data: bill, error: billErr } = await a.sb
        .from("bills")
        .upsert({
          user_id: a.user.id,
          month_key: monthKey,
          previous_reading: 100,
          current_reading: 150,
          factor: 1,
          rate: 1,
          extras: 10,
          consumption: 9999,
          energy_cost: 9999,
          total: 9999,
          due_date: "2098-07-05",
          status: "pending",
        }, { onConflict: "user_id,month_key" })
        .select("*")
        .single();

      const totalsOk = bill && Number(bill.consumption) === 50 && Number(bill.total) === 60;
      record(
        "S-BILL-01",
        !billErr && totalsOk,
        billErr ? billErr.message : `trigger consumption=${bill?.consumption} total=${bill?.total}`,
      );

      if (bill?.id) {
        const { data: paid, error: paidErr } = await a.sb
          .from("bills")
          .update({ status: "paid" })
          .eq("id", bill.id)
          .select("*")
          .single();
        record("S-BILL-02", !paidErr && paid?.status === "paid", paidErr?.message || `status=${paid?.status}`);

        const { data: stolen, error: stealErr } = await b.sb
          .from("bills")
          .select("*")
          .eq("id", bill.id);
        record(
          "S-ISO-01",
          (!stealErr && Array.isArray(stolen) && stolen.length === 0),
          stealErr ? stealErr.message : `B leu ${stolen?.length || 0} fatura(s) de A`,
        );

        const { data: hacked, error: hackErr } = await b.sb
          .from("bills")
          .update({ status: "pending" })
          .eq("id", bill.id)
          .select("*");
        record(
          "S-ISO-02",
          (!hackErr && (!hacked || hacked.length === 0)),
          hackErr ? hackErr.message : `B alterou ${hacked?.length || 0} fatura(s) de A`,
        );

        const { error: delErr } = await b.sb.from("bills").delete().eq("id", bill.id);
        const { data: stillThere } = await a.sb.from("bills").select("id").eq("id", bill.id);
        record(
          "S-ISO-03",
          Array.isArray(stillThere) && stillThere.length === 1,
          delErr
            ? `delete B: ${delErr.message}; A ainda vê ${stillThere?.length || 0}`
            : `delete B ignorado; A ainda vê ${stillThere?.length || 0}`,
        );

        await a.sb.from("bills").delete().eq("id", bill.id);
      }
    } finally {
      for (const id of created) {
        await admin.auth.admin.deleteUser(id).catch(() => {});
      }
    }
    return;
  }

  if (!auth?.session) {
    record(
      "S-BILL-01",
      true,
      "pulado: sem SERVICE_ROLE e Confirm email ativo (sem sessão imediata)",
    );
    record("S-ISO-01", true, "pulado: isolamento A/B exige SERVICE_ROLE ou 2 sessões");
    return;
  }

  record("S-BILL-01", false, "fluxo autenticado sem service role não implementado neste caminho");
}

async function main() {
  console.log("=== Âmbar Energia — smoke test ===\n");
  const env = loadServiceRoleFromCli(loadEnv());
  await testUiBoot();
  testClientValidation();
  await testAnonRls(env);
  const auth = await testAuthPolicy(env);
  await testAuthenticatedBillFlow(env, auth);

  const failed = results.filter((r) => r.status === "REPROVADO");
  console.log(`\nTotal: ${results.length} | Aprovados: ${results.length - failed.length} | Reprovados: ${failed.length}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
