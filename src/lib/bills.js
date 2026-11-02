import { supabase } from "./supabase.js";
import { computeStatus, dueDateFromMonth, formatMonthShort } from "./format.js";
import { computeBillTotals, validateBillInputs } from "./validation.js";

export function mapBillRow(row) {
  if (!row) return null;
  const status = computeStatus(row.due_date, row.status);
  return {
    id: row.id,
    monthKey: row.month_key,
    monthLabel: formatMonthShort(row.month_key),
    previous: Number(row.previous_reading),
    current: Number(row.current_reading),
    factor: Number(row.factor),
    rate: Number(row.rate),
    extras: Number(row.extras),
    consumption: Number(row.consumption),
    energy: Number(row.energy_cost),
    total: Number(row.total),
    dueDate: row.due_date,
    status,
    date: row.updated_at ? new Date(row.updated_at).toLocaleDateString("pt-BR") : "—",
  };
}

export async function fetchBills(userId) {
  const { data: sessionData } = await supabase.auth.getSession();
  const sessionUserId = sessionData.session?.user?.id;
  if (!sessionUserId || sessionUserId !== userId) {
    throw new Error("Sessão inválida para carregar faturas.");
  }

  const { data, error } = await supabase
    .from("bills")
    .select("*")
    .eq("user_id", sessionUserId)
    .order("month_key", { ascending: true });
  if (error) throw error;

  const updates = [];
  for (const row of data || []) {
    const next = computeStatus(row.due_date, row.status);
    if (row.status !== "paid" && next === "overdue" && row.status !== "overdue") {
      updates.push(
        supabase
          .from("bills")
          .update({ status: "overdue" })
          .eq("id", row.id)
          .eq("user_id", sessionUserId),
      );
      row.status = "overdue";
    }
  }
  if (updates.length) await Promise.all(updates);
  return (data || []).map(mapBillRow);
}

export async function upsertBill(userId, payload) {
  const { data: sessionData } = await supabase.auth.getSession();
  const sessionUserId = sessionData.session?.user?.id;
  if (!sessionUserId || sessionUserId !== userId) {
    throw new Error("Sessão inválida para salvar fatura.");
  }

  const errors = validateBillInputs({
    previous: payload.previous,
    current: payload.current,
    factor: payload.factor,
    rate: payload.rate,
    extras: payload.extras,
    monthKey: payload.monthKey,
  });
  if (errors.length) throw new Error(errors[0]);

  const totals = computeBillTotals({
    previous: payload.previous,
    current: payload.current,
    factor: payload.factor,
    rate: payload.rate,
    extras: payload.extras,
  });

  const dueDate = dueDateFromMonth(payload.monthKey);
  const status = payload.status === "paid" ? "paid" : computeStatus(dueDate, "pending");

  // Totais recalculados localmente; o trigger Postgres recalcula de novo no servidor.
  const row = {
    user_id: sessionUserId,
    month_key: payload.monthKey,
    previous_reading: payload.previous,
    current_reading: payload.current,
    factor: payload.factor,
    rate: payload.rate,
    extras: payload.extras,
    consumption: totals.consumption,
    energy_cost: totals.energy,
    total: totals.total,
    due_date: dueDate,
    status,
  };

  const { data, error } = await supabase
    .from("bills")
    .upsert(row, { onConflict: "user_id,month_key" })
    .select("*")
    .single();
  if (error) throw error;
  return mapBillRow(data);
}

export async function setBillPaid(billId, paid = true) {
  const { data: sessionData } = await supabase.auth.getSession();
  const sessionUserId = sessionData.session?.user?.id;
  if (!sessionUserId) throw new Error("Sessão inválida.");

  const { data: current, error: readError } = await supabase
    .from("bills")
    .select("*")
    .eq("id", billId)
    .eq("user_id", sessionUserId)
    .single();
  if (readError) throw readError;

  const status = paid ? "paid" : computeStatus(current.due_date, "pending");
  const { data, error } = await supabase
    .from("bills")
    .update({ status })
    .eq("id", billId)
    .eq("user_id", sessionUserId)
    .select("*")
    .single();
  if (error) throw error;
  return mapBillRow(data);
}

export async function clearBills(userId) {
  const { data: sessionData } = await supabase.auth.getSession();
  const sessionUserId = sessionData.session?.user?.id;
  if (!sessionUserId || sessionUserId !== userId) {
    throw new Error("Sessão inválida para limpar histórico.");
  }

  const { error } = await supabase.from("bills").delete().eq("user_id", sessionUserId);
  if (error) throw error;
}
