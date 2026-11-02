import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

type BillRow = {
  id: string;
  user_id: string;
  month_key: string;
  total: number;
  due_date: string;
  status: string;
};

const ALERT_COOLDOWN_HOURS = 8;

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
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceRole);

    const cronSecret = req.headers.get("x-cron-secret");
    const expectedCron = Deno.env.get("CRON_SECRET");
    const isCron = Boolean(expectedCron && cronSecret === expectedCron);

    if (!isCron) {
      return new Response(JSON.stringify({
        error: "Alertas são automáticos. Use o cron com header x-cron-secret.",
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const daysAhead = Number(body?.days_ahead ?? 30);

    await admin.rpc("refresh_overdue_bills");

    const today = new Date();
    const limit = new Date(today);
    limit.setDate(limit.getDate() + daysAhead);
    const todayIso = today.toISOString().slice(0, 10);
    const limitIso = limit.toISOString().slice(0, 10);
    const cooldownIso = new Date(today.getTime() - ALERT_COOLDOWN_HOURS * 3600 * 1000).toISOString();

    const { data: bills, error: billsError } = await admin
      .from("bills")
      .select("id,user_id,month_key,total,due_date,status")
      .in("status", ["pending", "overdue"])
      .lte("due_date", limitIso);

    if (billsError) throw billsError;

    const targets = (bills || []) as BillRow[];
    const results: Array<Record<string, unknown>> = [];

    for (const bill of targets) {
      const { data: userData, error: userError } = await admin.auth.admin.getUserById(bill.user_id);
      if (userError || !userData?.user?.email) {
        results.push({ bill_id: bill.id, skipped: true, reason: "Cliente sem e-mail." });
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
        results.push({
          bill_id: bill.id,
          skipped: true,
          reason: `Já alertado nas últimas ${ALERT_COOLDOWN_HOURS}h.`,
        });
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
        const { error: logError } = await admin.from("alert_logs").insert({
          user_id: bill.user_id,
          bill_id: bill.id,
          phone: email,
          message: text,
          provider_sid: messageId,
        });
        if (logError) throw logError;
        results.push({ bill_id: bill.id, sent: true, email, channel: "email" });
      } catch (sendError) {
        results.push({
          bill_id: bill.id,
          sent: false,
          email,
          reason: sendError instanceof Error ? sendError.message : "Falha no e-mail",
        });
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      channel: "email",
      cooldown_hours: ALERT_COOLDOWN_HOURS,
      count: results.length,
      results,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro interno";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
