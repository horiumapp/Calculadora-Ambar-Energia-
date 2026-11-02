const MONTH_KEY_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const BILL_LIMITS = {
  maxReading: 1_000_000_000,
  maxFactor: 1_000,
  maxRate: 100,
  maxExtras: 100_000,
  maxTotal: 10_000_000,
  minPasswordLength: 8,
};

export function isValidMonthKey(value) {
  return MONTH_KEY_RE.test(String(value || ""));
}

export function validateBillInputs({
  previous,
  current,
  factor,
  rate,
  extras,
  monthKey,
}) {
  const errors = [];
  if (!isValidMonthKey(monthKey)) errors.push("Mês da fatura inválido.");
  if (![previous, current, factor, rate, extras].every(Number.isFinite)) {
    errors.push("Informe apenas números válidos.");
    return errors;
  }
  if (previous < 0 || current < 0) errors.push("Leituras não podem ser negativas.");
  if (previous > BILL_LIMITS.maxReading || current > BILL_LIMITS.maxReading) {
    errors.push("Leitura fora do limite permitido.");
  }
  if (current < previous) errors.push("A leitura atual não pode ser menor que a anterior.");
  if (!(factor > 0) || factor > BILL_LIMITS.maxFactor) {
    errors.push("Constante do medidor inválida.");
  }
  if (rate < 0 || rate > BILL_LIMITS.maxRate) errors.push("Tarifa fora do limite permitido.");
  if (extras < 0 || extras > BILL_LIMITS.maxExtras) {
    errors.push("Valor de extras fora do limite permitido.");
  }
  return errors;
}

export function computeBillTotals({ previous, current, factor, rate, extras }) {
  const consumption = (current - previous) * factor;
  const energy = consumption * rate;
  const total = energy + extras;
  if (!Number.isFinite(total) || total < 0 || total > BILL_LIMITS.maxTotal) {
    throw new Error("Total calculado fora do limite permitido.");
  }
  return { consumption, energy, total };
}

export function sanitizeAuthError(error, mode = "login") {
  const raw = String(error?.message || "").toLowerCase();
  if (raw.includes("rate") || raw.includes("too many") || raw.includes("security purposes")) {
    return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";
  }
  if (mode === "signup") {
    if (raw.includes("password") && (raw.includes("weak") || raw.includes("least") || raw.includes("short"))) {
      return `Use uma senha com pelo menos ${BILL_LIMITS.minPasswordLength} caracteres.`;
    }
    return "Não foi possível criar a conta. Verifique os dados e tente novamente.";
  }
  if (mode === "reset") {
    return "Se o e-mail existir, enviaremos instruções de recuperação.";
  }
  return "E-mail ou senha inválidos.";
}
