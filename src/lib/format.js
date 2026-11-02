export const MONTHS_PT = ["JANEIRO","FEVEREIRO","MARÇO","ABRIL","MAIO","JUNHO","JULHO","AGOSTO","SETEMBRO","OUTUBRO","NOVEMBRO","DEZEMBRO"];
export const MONTHS_SHORT = ["JAN","FEV","MAR","ABR","MAI","JUN","JUL","AGO","SET","OUT","NOV","DEZ"];

export const money = (value) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
export const moneyPlain = (value) => new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
export const kwh = (value) => `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 }).format(value)} kWh`;

export function parseMonth(value) {
  const [year, month] = String(value || "").split("-").map(Number);
  if (!year || !month) return null;
  return { year, month, key: `${year}-${String(month).padStart(2, "0")}` };
}

export function formatMonthLong(key) {
  const parsed = parseMonth(key);
  if (!parsed) return "—";
  return `${MONTHS_PT[parsed.month - 1]}/${parsed.year}`;
}

export function formatMonthShort(key) {
  const parsed = parseMonth(key);
  if (!parsed) return "—";
  return `${MONTHS_SHORT[parsed.month - 1]}/${String(parsed.year).slice(-2)}`;
}

export function dueDateFromMonth(key) {
  const parsed = parseMonth(key);
  if (!parsed) return null;
  const due = new Date(parsed.year, parsed.month, 5);
  const yyyy = due.getFullYear();
  const mm = String(due.getMonth() + 1).padStart(2, "0");
  const dd = String(due.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function formatDateBr(isoOrDate) {
  if (!isoOrDate) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoOrDate)) {
    const [y, m, d] = isoOrDate.split("-");
    return `${d}/${m}/${y}`;
  }
  return new Date(isoOrDate).toLocaleDateString("pt-BR");
}

export function shiftMonthKey(key, delta) {
  const parsed = parseMonth(key);
  if (!parsed) return key;
  const date = new Date(parsed.year, parsed.month - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function computeStatus(dueDateIso, status) {
  if (status === "paid") return "paid";
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (dueDateIso && dueDateIso < todayIso) return "overdue";
  return "pending";
}

export function statusLabel(status) {
  if (status === "paid") return "Paga";
  if (status === "overdue") return "Vencida";
  return "Pendente";
}

export function daysUntil(dueDateIso) {
  if (!dueDateIso) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${dueDateIso}T00:00:00`);
  return Math.round((due - today) / 86400000);
}

export function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("55") && digits.length >= 12) return `+${digits}`;
  if (digits.length >= 10 && digits.length <= 11) return `+55${digits}`;
  return raw.startsWith("+") ? raw : `+${digits}`;
}
