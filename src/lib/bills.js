import { supabase } from "./supabase.js";
import { computeStatus, dueDateFromMonth, formatMonthShort } from "./format.js";

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
  const { data, error } = await supabase
    .from("bills")
    .select("*")
    .eq("user_id", userId)
    .order("month_key", { ascending: true });
  if (error) throw error;

  const updates = [];
  for (const row of data || []) {
    const next = computeStatus(row.due_date, row.status);
    if (row.status !== "paid" && next === "overdue" && row.status !== "overdue") {
      updates.push(supabase.from("bills").update({ status: "overdue" }).eq("id", row.id));
      row.status = "overdue";
    }
  }
  if (updates.length) await Promise.all(updates);
  return (data || []).map(mapBillRow);
}

export async function upsertBill(userId, payload) {
  const dueDate = payload.dueDate || dueDateFromMonth(payload.monthKey);
  const status = payload.status === "paid" ? "paid" : computeStatus(dueDate, "pending");
  const row = {
    user_id: userId,
    month_key: payload.monthKey,
    previous_reading: payload.previous,
    current_reading: payload.current,
    factor: payload.factor,
    rate: payload.rate,
    extras: payload.extras,
    consumption: payload.consumption,
    energy_cost: payload.energy,
    total: payload.total,
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
  const { data: current, error: readError } = await supabase
    .from("bills")
    .select("*")
    .eq("id", billId)
    .single();
  if (readError) throw readError;

  const status = paid ? "paid" : computeStatus(current.due_date, "pending");
  const { data, error } = await supabase
    .from("bills")
    .update({ status })
    .eq("id", billId)
    .select("*")
    .single();
  if (error) throw error;
  return mapBillRow(data);
}

export async function clearBills(userId) {
  const { error } = await supabase.from("bills").delete().eq("user_id", userId);
  if (error) throw error;
}

