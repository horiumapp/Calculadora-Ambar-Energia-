import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "";
const ALERT_COOLDOWN_HOURS = 8;
const MIN_DAYS_AHEAD = 1;
const MAX_DAYS_AHEAD = 60;
const MAX_BODY_BYTES = 4_096;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = 10;

type BillRow = {
  id: string;
  user_id: string;
  month_key: string;
  total: number;
  due_date: string;
  status: string;
};

type RateEntry = { count: number; resetAt: number };
const rateBuckets = new Map<string, RateEntry>();

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  if (ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  } else if (!ALLOWED_ORIGIN) {
    // Cron/server-to-server: sem CORS permissivo.
    headers["Access-Control-Allow-Origin"] = "null";
  }
  return headers;
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
  origin: string | null,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length === bBytes.length ? 0 : 1;
  for (let i = 0; i < len; i++) {
    const av = i < aBytes.length ? aBytes[i] : 0;
    const bv = i < bBytes.length ? bBytes[i] : 0;
    diff |= av ^ bv;
  }
  return diff === 0;
}

function clientKey(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function allowRequest(key: string): boolean {
  const now = Date.now();
  const entry = rateBuckets.get(key);
  if (!entry || now >= entry.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_MAX_REQUESTS) return false;
  entry.count += 1;
  return true;
}

function formatMonthShort(monthKey: string) {
  const months = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month) return monthKey;
  return `${months[month - 1]}/${String(year).slice(-2)}`;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function formatDateBr(isoDate: string) {
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

function cooldownBucket(nowMs = Date.now()): number {
  return Math.floor(nowMs / (ALERT_COOLDOWN_HOURS * 3600 * 1000));
}

async function sendResendEmail(to: string, subject: string, text: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("RESEND_FROM") || "Ambar Energia <onboarding@resend.dev>";
  if (!apiKey) throw new Error("RESEND_API_KEY não configurada.");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject,
      text,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.message || "Falha ao enviar e-mail via Resend.");
  }
  return data.id as string;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }

  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Método não permitido." }, origin);
  }

  if (!allowRequest(clientKey(req))) {
    return jsonResponse(429, { error: "Muitas requisições. Tente novamente mais tarde." }, origin);
  }

  try {
    const expectedCron = Deno.env.get("CRON_SECRET") || "";
    const cronSecret = req.headers.get("x-cron-secret") || "";
    if (!expectedCron || !timingSafeEqual(cronSecret, expectedCron)) {
      return jsonResponse(403, { error: "Não autorizado." }, origin);
    }

    const raw = await req.arrayBuffer();
    if (raw.byteLength > MAX_BODY_BYTES) {
      return jsonResponse(413, { error: "Corpo da requisição muito grande." }, origin);
    }

    let body: Record<string, unknown> = {};
    if (raw.byteLength > 0) {
      try {
        const parsed = JSON.parse(new TextDecoder().decode(raw));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        } else {
          return jsonResponse(400, { error: "JSON inválido." }, origin);
        }
      } catch {
        return jsonResponse(400, { error: "JSON inválido." }, origin);
      }
    }

    const daysAheadRaw = Number(body.days_ahead ?? 30);
    if (!Number.isFinite(daysAheadRaw)) {
      return jsonResponse(400, { error: "days_ahead inválido." }, origin);
    }
    const daysAhead = Math.min(MAX_DAYS_AHEAD, Math.max(MIN_DAYS_AHEAD, Math.trunc(daysAheadRaw)));

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRole) {
      console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return jsonResponse(500, { error: "Configuração incompleta." }, origin);
    }

    const admin = createClient(supabaseUrl, serviceRole);

    await admin.rpc("refresh_overdue_bills");

    const today = new Date();
    const limit = new Date(today);
    limit.setDate(limit.getDate() + daysAhead);
    const todayIso = today.toISOString().slice(0, 10);
    const limitIso = limit.toISOString().slice(0, 10);
    const cooldownIso = new Date(today.getTime() - ALERT_COOLDOWN_HOURS * 3600 * 1000).toISOString();
    const bucket = cooldownBucket(today.getTime());

    const { data: bills, error: billsError } = await admin
      .from("bills")
      .select("id,user_id,month_key,total,due_date,status")
      .in("status", ["pending", "overdue"])
      .lte("due_date", limitIso);

    if (billsError) {
      console.error("bills query failed", billsError.message);
      return jsonResponse(500, { error: "Falha ao processar alertas." }, origin);
    }

    const targets = (bills || []) as BillRow[];
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const bill of targets) {
      const { data: userData, error: userError } = await admin.auth.admin.getUserById(bill.user_id);
      if (userError || !userData?.user?.email) {
        skipped += 1;
        continue;
      }

      const email = userData.user.email;
      const { data: profile } = await admin
        .from("profiles")
        .select("full_name")
        .eq("id", bill.user_id)
        .maybeSingle();

      const { data: recent } = await admin
        .from("alert_logs")
        .select("id")
        .eq("bill_id", bill.id)
        .gte("sent_at", cooldownIso)
        .limit(1);

      if (recent && recent.length > 0) {
        skipped += 1;
        continue;
      }

      const dueLabel = formatDateBr(bill.due_date);
      const monthLabel = formatMonthShort(bill.month_key);
      const statusWord = bill.due_date < todayIso ? "está vencida desde" : "vence em";
      const name = profile?.full_name?.trim() || "cliente";
      const subject = `Ambar Energia — conta ${monthLabel} ${bill.status === "overdue" ? "vencida" : "pendente"}`;
      const text =
        `Olá, ${name}.\n\n` +
        `Sua conta de energia de ${monthLabel} ${statusWord} ${dueLabel}.\n` +
        `Total: ${formatMoney(Number(bill.total))}.\n\n` +
        `Enquanto estiver pendente, você receberá este aviso automaticamente a cada ${ALERT_COOLDOWN_HOURS} horas.\n` +
        `Quando marcar a fatura como paga no app, os alertas param.\n\n` +
        `Ambar Energia`;

      try {
        const messageId = await sendResendEmail(email, subject, text);
        const cooldownKey = `${bill.id}:${bucket}`;
        const { error: logError } = await admin.from("alert_logs").insert({
          user_id: bill.user_id,
          bill_id: bill.id,
          phone: email,
          message: text,
          provider_sid: messageId,
          cooldown_key: cooldownKey,
        });

        if (logError) {
          // Concorrência: outro worker já registrou o alerta desta janela.
          if (String(logError.code) === "23505" || /duplicate|unique/i.test(logError.message || "")) {
            skipped += 1;
            continue;
          }
          throw logError;
        }
        sent += 1;
      } catch (sendError) {
        failed += 1;
        console.error("alert send failed", bill.id, sendError instanceof Error ? sendError.message : "error");
      }
    }

    return jsonResponse(200, {
      ok: true,
      channel: "email",
      cooldown_hours: ALERT_COOLDOWN_HOURS,
      days_ahead: daysAhead,
      processed: targets.length,
      sent,
      skipped,
      failed,
    }, origin);
  } catch (error) {
    console.error("send-due-alerts fatal", error instanceof Error ? error.message : "unknown");
    return jsonResponse(500, { error: "Erro interno." }, origin);
  }
});
