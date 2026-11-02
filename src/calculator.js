import {
  money, moneyPlain, kwh, parseMonth, formatMonthLong, formatMonthShort,
  dueDateFromMonth, formatDateBr, shiftMonthKey, statusLabel, daysUntil
} from "./lib/format.js";
import { fetchBills, upsertBill, setBillPaid, clearBills } from "./lib/bills.js";
import { computeBillTotals, validateBillInputs } from "./lib/validation.js";

const $ = (id) => document.getElementById(id);
const number = (id) => Number($(id).value);

let latest = null;
let selectedMonthKey = null;
let monthDrafts = {};
let billsCache = [];
let currentUserId = null;

export function getLatest() {
  return latest;
}

export function getBillsCache() {
  return billsCache;
}

function syncMonthLabels() {
  const key = $("bill-month-input").value;
  $("bill-month").textContent = formatMonthLong(key);
  $("due-date").textContent = formatDateBr(dueDateFromMonth(key));
}

function calculate() {
  const previous = number("previous");
  const current = number("current");
  const factor = number("factor");
  const rate = number("rate");
  const extras = number("extras");
  const month = parseMonth($("bill-month-input").value);
  if (!month) { alert("Informe o mês da conta."); return null; }

  const errors = validateBillInputs({
    previous, current, factor, rate, extras, monthKey: month.key,
  });
  if (errors.length) { alert(errors[0]); return null; }

  let totals;
  try {
    totals = computeBillTotals({ previous, current, factor, rate, extras });
  } catch (error) {
    alert(error.message || "Não foi possível calcular a conta.");
    return null;
  }

  const { consumption, energy, total } = totals;
  const dueDate = dueDateFromMonth(month.key);
  const existing = billsCache.find((item) => item.monthKey === month.key);

  latest = {
    id: existing?.id || null,
    monthKey: month.key,
    monthLabel: formatMonthShort(month.key),
    date: new Date().toLocaleDateString("pt-BR"),
    previous, current, factor, consumption, energy, extras, total, rate,
    dueDate,
    status: existing?.status === "paid" ? "paid" : existing?.status || "pending",
  };

  syncMonthLabels();
  $("total").textContent = money(total);
  $("summary-total").textContent = moneyPlain(total);
  $("summary-consumption").textContent = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(consumption);
  $("consumption").textContent = kwh(consumption);
  $("energy-cost").textContent = moneyPlain(energy);
  $("extra-cost").textContent = moneyPlain(extras);
  $("rate-label").textContent = rate.toLocaleString("pt-BR", { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  updateStatusPanel(latest);
  return latest;
}

function readFormDraft() {
  return {
    previous: $("previous").value,
    current: $("current").value,
    factor: $("factor").value,
    rate: $("rate").value,
    extras: $("extras").value,
  };
}

function writeFormDraft(draft) {
  if (!draft) return;
  $("previous").value = draft.previous ?? "";
  $("current").value = draft.current ?? "";
  if (draft.factor != null && draft.factor !== "") $("factor").value = draft.factor;
  if (draft.rate != null && draft.rate !== "") $("rate").value = draft.rate;
  if (draft.extras != null && draft.extras !== "") $("extras").value = draft.extras;
}

function snapshotMonthDraft(monthKey) {
  if (!monthKey) return;
  monthDrafts[monthKey] = readFormDraft();
}

function draftFromSaved(item) {
  if (!item) return null;
  if (!Number.isFinite(Number(item.previous)) || !Number.isFinite(Number(item.current))) return null;
  return {
    previous: String(item.previous),
    current: String(item.current),
    factor: item.factor != null ? String(item.factor) : $("factor").value,
    rate: item.rate != null ? String(item.rate) : $("rate").value,
    extras: item.extras != null ? String(item.extras) : $("extras").value,
  };
}

function applyMonthSwitch(fromMonthKey, toMonthKey, fallbackCurrent) {
  const savedTarget = billsCache.find((item) => item.monthKey === toMonthKey);
  const savedDraft = draftFromSaved(savedTarget);
  if (savedDraft) {
    writeFormDraft(savedDraft);
    monthDrafts[toMonthKey] = savedDraft;
    latest = { ...savedTarget };
    updateStatusPanel(savedTarget);
    return "restored";
  }

  if (monthDrafts[toMonthKey]) {
    writeFormDraft(monthDrafts[toMonthKey]);
    updateStatusPanel(null);
    return "draft";
  }

  const isNextMonth = fromMonthKey && toMonthKey === shiftMonthKey(fromMonthKey, 1);
  if (isNextMonth) {
    const savedPrevious = billsCache.find((item) => item.monthKey === fromMonthKey);
    let carry = null;
    if (savedPrevious && Number.isFinite(Number(savedPrevious.current))) carry = Number(savedPrevious.current);
    else if (Number.isFinite(fallbackCurrent) && fallbackCurrent > 0) carry = fallbackCurrent;
    else if (latest && latest.monthKey === fromMonthKey && Number.isFinite(Number(latest.current))) carry = Number(latest.current);

    if (carry != null) {
      const draft = {
        previous: String(carry),
        current: "",
        factor: $("factor").value,
        rate: $("rate").value,
        extras: $("extras").value,
      };
      writeFormDraft(draft);
      monthDrafts[toMonthKey] = draft;
      updateStatusPanel(null);
      $("current").focus();
      return "carry";
    }
  }

  updateStatusPanel(null);
  return "unchanged";
}

function refreshResultFromForm() {
  if ($("previous").value !== "" && $("current").value !== "") calculate();
  else {
    latest = null;
    $("summary-consumption").textContent = "—";
    $("summary-total").textContent = "—";
    $("consumption").textContent = "—";
    $("energy-cost").textContent = "—";
    $("extra-cost").textContent = "—";
    $("total").textContent = "—";
    updateStatusPanel(null);
  }
}

function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function buildMonthWindow(savedItems) {
  const byKey = Object.fromEntries(savedItems.map((item) => [item.monthKey, item]));
  const anchor = $("bill-month-input").value || currentMonthKey();
  const sortedKeys = savedItems.map((item) => item.monthKey).sort();
  const firstSaved = sortedKeys[0] || null;
  const lastSaved = sortedKeys[sortedKeys.length - 1] || null;

  // Não inventa histórico antes da 1ª fatura salva (sistema novo / início do cliente).
  let startKey = shiftMonthKey(anchor, -8);
  if (firstSaved && firstSaved > startKey) startKey = firstSaved;
  if (anchor < startKey) startKey = anchor;

  let endKey = shiftMonthKey(anchor, 3);
  if (lastSaved && lastSaved > endKey) endKey = lastSaved;
  const minEnd = shiftMonthKey(startKey, 11);
  if (endKey < minEnd) endKey = minEnd;

  const series = [];
  for (
    let cursor = startKey;
    cursor <= endKey && series.length < 12;
    cursor = shiftMonthKey(cursor, 1)
  ) {
    const saved = byKey[cursor];
    series.push({
      monthKey: cursor,
      monthLabel: formatMonthShort(cursor),
      consumption: saved ? Number(saved.consumption) : null,
      saved: Boolean(saved),
    });
  }
  return series;
}

function drawChart(savedItems) {
  const series = buildMonthWindow(savedItems);
  const canvas = $("history-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 900;
  const cssHeight = 260;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const pad = { top: 24, right: 12, bottom: 42, left: 44 };
  const plotW = cssWidth - pad.left - pad.right;
  const plotH = cssHeight - pad.top - pad.bottom;
  const values = series.map((item) => item.consumption).filter((value) => value != null);
  const max = Math.max(...values, 1);
  const gap = 6;
  const barW = Math.max(14, (plotW - gap * (series.length + 1)) / series.length);

  ctx.strokeStyle = "#d7e0ec";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(cssWidth - pad.right, y);
    ctx.stroke();
    ctx.fillStyle = "#7a8698";
    ctx.font = "11px IBM Plex Sans, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(String(Math.round(max - (max * i) / 4)), pad.left - 8, y + 4);
  }

  series.forEach((item, index) => {
    const x = pad.left + gap + index * (barW + gap);
    if (item.saved) {
      const h = (item.consumption / max) * plotH;
      const y = pad.top + plotH - h;
      const gradient = ctx.createLinearGradient(0, y, 0, y + h);
      gradient.addColorStop(0, "#ffd39a");
      gradient.addColorStop(1, "#b7c9e6");
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, barW, Math.max(h, 2));
      ctx.strokeStyle = "#e8c48a";
      ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, Math.max(h, 2) - 1);
      ctx.fillStyle = "#8a9bb3";
      ctx.font = "600 10px IBM Plex Mono, monospace";
      ctx.textAlign = "center";
      ctx.fillText(String(Math.round(item.consumption)), x + barW / 2, y - 6);
    } else {
      const y = pad.top + plotH - 4;
      ctx.fillStyle = "#edf1f6";
      ctx.fillRect(x, y, barW, 4);
      ctx.strokeStyle = "#d7dee8";
      ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, 3);
    }
    ctx.fillStyle = item.saved ? "#5d7399" : "#a0a8b4";
    ctx.font = "10px IBM Plex Sans, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(item.monthLabel, x + barW / 2, cssHeight - 16);
  });
}

function updateStatusPanel(bill) {
  const badge = $("bill-status-badge");
  const alertBox = $("due-alert");
  const markPaidBtn = $("mark-paid");
  const actionHint = $("bill-action-hint");
  if (!badge) return;

  // Só Pendente/Paga/Vencida para fatura realmente salva — cálculo solto não conta.
  if (!bill || !bill.monthKey || !bill.id) {
    badge.textContent = "Sem fatura salva";
    badge.className = "status-badge status-muted";
    alertBox.hidden = true;
    markPaidBtn.disabled = false;
    markPaidBtn.title = "Salve a fatura antes";
    markPaidBtn.textContent = "Marcar como paga";
    if (actionHint) {
      actionHint.hidden = false;
      actionHint.textContent = "Salve a fatura no histórico. Alertas por e-mail só valem para faturas salvas e pendentes.";
    }
    return;
  }

  const status = bill.status || "pending";
  badge.textContent = statusLabel(status);
  badge.className = `status-badge status-${status}`;
  markPaidBtn.disabled = false;
  markPaidBtn.title = "";
  markPaidBtn.textContent = status === "paid" ? "Marcar como pendente" : "Marcar como paga";
  if (actionHint) {
    if (status === "paid") {
      actionHint.hidden = false;
      actionHint.textContent = "Fatura paga: o sistema não envia mais alertas desta conta.";
    } else {
      actionHint.hidden = false;
      actionHint.textContent = "Pendente/vencida: o sistema envia alerta por e-mail automaticamente a cada 8 horas.";
    }
  }

  const days = daysUntil(bill.dueDate);
  if (status === "paid") {
    alertBox.hidden = true;
  } else if (days != null && days < 0) {
    alertBox.hidden = false;
    alertBox.className = "due-alert due-alert-danger";
    alertBox.textContent = `Fatura vencida há ${Math.abs(days)} dia(s) (${formatDateBr(bill.dueDate)}).`;
  } else if (days != null && days <= 3) {
    alertBox.hidden = false;
    alertBox.className = "due-alert due-alert-warn";
    alertBox.textContent = days === 0
      ? `Atenção: a fatura vence hoje (${formatDateBr(bill.dueDate)}).`
      : `Atenção: a fatura vence em ${days} dia(s) (${formatDateBr(bill.dueDate)}).`;
  } else {
    alertBox.hidden = true;
  }
}

function renderDashboard() {
  const items = billsCache;
  const hasData = items.length > 0;
  const clearBtn = $("clear-history");
  $("history-empty").hidden = hasData;
  $("history-table").hidden = !hasData;
  $("kpi-months").textContent = String(items.length);
  // Só libera limpar histórico a partir de 12 faturas salvas.
  if (clearBtn) clearBtn.hidden = items.length < 12;

  if (!hasData) {
    $("kpi-avg").textContent = "—";
    $("kpi-peak").textContent = "—";
    $("kpi-spend").textContent = "—";
    $("history-body").innerHTML = "";
    requestAnimationFrame(() => drawChart([]));
    return;
  }

  const avg = items.reduce((sum, item) => sum + item.consumption, 0) / items.length;
  const peak = items.reduce((best, item) => (item.consumption > best.consumption ? item : best), items[0]);
  const spend = items.reduce((sum, item) => sum + item.total, 0);
  $("kpi-avg").textContent = kwh(avg);
  $("kpi-peak").textContent = `${kwh(peak.consumption)} · ${peak.monthLabel}`;
  $("kpi-spend").textContent = money(spend);

  $("history-body").innerHTML = "";
  [...items].reverse().forEach((item) => {
    const tr = document.createElement("tr");
    [
      item.monthLabel,
      kwh(item.consumption),
      Number(item.rate).toLocaleString("pt-BR", { minimumFractionDigits: 6, maximumFractionDigits: 6 }),
      money(item.total),
      statusLabel(item.status),
      formatDateBr(item.dueDate),
    ].forEach((value) => {
      const td = document.createElement("td");
      td.textContent = value;
      if (value === "Vencida") td.className = "cell-danger";
      if (value === "Paga") td.className = "cell-ok";
      tr.appendChild(td);
    });
    $("history-body").appendChild(tr);
  });

  requestAnimationFrame(() => drawChart(items));
}

export async function reloadBills(userId = currentUserId) {
  if (!userId) return;
  currentUserId = userId;
  billsCache = await fetchBills(userId);
  billsCache.forEach((item) => {
    const draft = draftFromSaved(item);
    if (draft) monthDrafts[item.monthKey] = draft;
  });
  const current = billsCache.find((item) => item.monthKey === selectedMonthKey);
  if (current) {
    latest = current;
    updateStatusPanel(current);
  }
  renderDashboard();
}

export function initCalculator(userId) {
  currentUserId = userId;
  selectedMonthKey = $("bill-month-input").value;
  syncMonthLabels();
  calculate();
  snapshotMonthDraft(selectedMonthKey);

  $("calc-form").addEventListener("submit", (e) => {
    e.preventDefault();
    calculate();
    snapshotMonthDraft(selectedMonthKey);
  });

  $("bill-month-input").addEventListener("change", () => {
    const fromMonthKey = selectedMonthKey;
    const toMonthKey = $("bill-month-input").value;
    const fallbackCurrent = number("current");
    snapshotMonthDraft(fromMonthKey);
    selectedMonthKey = toMonthKey;
    syncMonthLabels();
    applyMonthSwitch(fromMonthKey, toMonthKey, fallbackCurrent);
    refreshResultFromForm();
    const saved = billsCache.find((item) => item.monthKey === toMonthKey);
    // Status Pendente/Paga só com fatura salva; mês vazio fica "Sem fatura salva".
    updateStatusPanel(saved || null);
    renderDashboard();
  });

  ["previous", "current", "factor", "rate", "extras"].forEach((id) => {
    $(id).addEventListener("change", () => snapshotMonthDraft(selectedMonthKey));
  });

  $("save").addEventListener("click", async () => {
    if (!latest) calculate();
    if (!latest) return;
    try {
      $("save").disabled = true;
      $("save").textContent = "Salvando...";
      const saved = await upsertBill(currentUserId, latest);
      latest = saved;
      snapshotMonthDraft(saved.monthKey);
      await reloadBills(currentUserId);
      updateStatusPanel(saved);
      alert("Fatura salva no histórico mensal.");
    } catch (error) {
      alert(error.message || "Não foi possível salvar a fatura.");
    } finally {
      $("save").disabled = false;
      $("save").textContent = "Salvar no histórico mensal";
    }
  });

  $("clear-history").addEventListener("click", async () => {
    if (billsCache.length < 12) return;
    if (!confirm("Deseja apagar todo o histórico mensal da sua conta?")) return;
    try {
      await clearBills(currentUserId);
      billsCache = [];
      monthDrafts = {};
      latest = null;
      updateStatusPanel(null);
      renderDashboard();
    } catch (error) {
      alert(error.message || "Não foi possível limpar o histórico.");
    }
  });

  $("mark-paid").addEventListener("click", async () => {
    const bill = billsCache.find((item) => item.monthKey === selectedMonthKey) || latest;
    if (!bill?.id) return alert("Salve a fatura antes de alterar o status.");
    try {
      const paid = bill.status !== "paid";
      const updated = await setBillPaid(bill.id, paid);
      latest = updated;
      await reloadBills(currentUserId);
      updateStatusPanel(updated);
    } catch (error) {
      alert(error.message || "Não foi possível atualizar o status.");
    }
  });

  window.addEventListener("resize", () => {
    if (billsCache.length) drawChart(billsCache);
  });

  return reloadBills(userId);
}
