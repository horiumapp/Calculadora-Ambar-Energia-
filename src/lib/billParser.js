const MONTH_NAMES = {
  janeiro: 1, jan: 1,
  fevereiro: 2, fev: 2,
  marco: 3, março: 3, mar: 3,
  abril: 4, abr: 4,
  maio: 5, mai: 5,
  junho: 6, jun: 6,
  julho: 7, jul: 7,
  agosto: 8, ago: 8,
  setembro: 9, set: 9,
  outubro: 10, out: 10,
  novembro: 11, nov: 11,
  dezembro: 12, dez: 12,
};

function normalizeText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[|]/g, "I")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

function parseBrNumber(raw) {
  if (raw == null) return null;
  let value = String(raw).trim();
  if (!value) return null;
  value = value.replace(/[^\d.,-]/g, "");
  if (!value) return null;

  const hasComma = value.includes(",");
  const hasDot = value.includes(".");
  if (hasComma && hasDot) {
    if (value.lastIndexOf(",") > value.lastIndexOf(".")) {
      value = value.replace(/\./g, "").replace(",", ".");
    } else {
      value = value.replace(/,/g, "");
    }
  } else if (hasComma) {
    value = value.replace(",", ".");
  }

  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toMonthKey(year, month) {
  if (!year || !month || month < 1 || month > 12) return null;
  const y = Number(year);
  if (y < 2000 || y > 2100) return null;
  return `${y}-${String(month).padStart(2, "0")}`;
}

function extractMonthKey(text) {
  const normalized = normalizeText(text).toLowerCase();

  const refMatch = normalized.match(
    /(?:referencia|mes\s*\/?\s*ano|conta\s*mes|periodo)[^\n]{0,40}?((?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*)[\/\-\s]+(\d{4}|\d{2})/i,
  );
  if (refMatch) {
    const month = MONTH_NAMES[refMatch[1].slice(0, 3)] || MONTH_NAMES[refMatch[1]];
    let year = Number(refMatch[2]);
    if (year < 100) year += 2000;
    const key = toMonthKey(year, month);
    if (key) return key;
  }

  const slashMatch = normalized.match(
    /\b((?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*)[\/\-](\d{4}|\d{2})\b/i,
  );
  if (slashMatch) {
    const month = MONTH_NAMES[slashMatch[1].slice(0, 3)] || MONTH_NAMES[slashMatch[1]];
    let year = Number(slashMatch[2]);
    if (year < 100) year += 2000;
    const key = toMonthKey(year, month);
    if (key) return key;
  }

  const numeric = normalized.match(/\b(0?[1-9]|1[0-2])[\/\-](\d{4})\b/);
  if (numeric) return toMonthKey(numeric[2], Number(numeric[1]));

  const iso = normalized.match(/\b(20\d{2})[\/\-](0[1-9]|1[0-2])\b/);
  if (iso) return toMonthKey(iso[1], Number(iso[2]));

  return null;
}

function extractNumberTokens(line) {
  const matches = String(line).match(
    /-?\d{1,3}(?:[.\s]\d{3})+(?:,\d+)?|-?\d+[.,]\d+|-?\d+/g,
  ) || [];
  // Prefer tokens longos/completos para evitar cortar 14645 em 146.
  return [...matches].sort((a, b) => b.length - a.length);
}

function findNumberNear(labelRe, text, { min = 0, max = Infinity, decimalsOk = true } = {}) {
  const lines = text.split(/\n+/);
  for (let i = 0; i < lines.length; i++) {
    const line = normalizeText(lines[i]);
    if (!labelRe.test(line)) continue;

    const scanLines = [line];
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
      scanLines.push(normalizeText(lines[j]));
    }

    for (const candidateLine of scanLines) {
      const tokens = extractNumberTokens(candidateLine);
      for (const token of tokens) {
        const num = parseBrNumber(token);
        if (num == null) continue;
        if (!decimalsOk && !Number.isInteger(num)) continue;
        if (num >= min && num <= max) return num;
      }
    }
  }
  return null;
}

function extractReadings(text) {
  const previous = findNumberNear(
    /leitura\s+anterior|anterior\s+do\s+medidor|\banterior\b/i,
    text,
    { min: 0, max: 1_000_000_000 },
  );
  const current = findNumberNear(
    /leitura\s+atual|atual\s+do\s+medidor|\batual\b|leitura\s+do\s+mes/i,
    text,
    { min: 0, max: 1_000_000_000 },
  );

  if (previous != null && current != null) return { previous, current };

  const pair = text.match(
    /(?:leituras?|medidor)[^\d]{0,40}(\d{3,9})[^\d]{1,20}(\d{3,9})/i,
  );
  if (pair) {
    const a = parseBrNumber(pair[1]);
    const b = parseBrNumber(pair[2]);
    if (a != null && b != null && b >= a) return { previous: a, current: b };
  }

  return { previous, current };
}

function extractRate(text) {
  const labeled = findNumberNear(
    /tarifa|te\s*\/?\s*tusd|preco\s*unit|r\$\s*\/\s*kwh|valor\s*unitario/i,
    text,
    { min: 0.01, max: 100 },
  );
  if (labeled != null) return labeled;

  const match = normalizeText(text).match(
    /(?:r\$\s*)?(\d+[.,]\d{4,6})\s*(?:\/\s*)?kwh/i,
  );
  return match ? parseBrNumber(match[1]) : null;
}

function extractExtras(text) {
  const cosip = findNumberNear(
    /cosip|cip\b|iluminacao\s+publica|contrib(?:uicao)?\s+.*ilumin/i,
    text,
    { min: 0, max: 100_000 },
  );
  return cosip;
}

function extractFactor(text) {
  const factor = findNumberNear(
    /constante|multiplicador|fator\s+do\s+medidor/i,
    text,
    { min: 0.001, max: 1000 },
  );
  return factor == null ? 1 : factor;
}

/**
 * Extrai campos úteis de texto OCR de fatura de energia (BR).
 * @param {string} ocrText
 * @returns {{ monthKey: string|null, previous: number|null, current: number|null, factor: number|null, rate: number|null, extras: number|null, confidence: number, rawPreview: string }}
 */
export function parseBillText(ocrText) {
  const text = String(ocrText || "");
  const monthKey = extractMonthKey(text);
  const { previous, current } = extractReadings(text);
  const rate = extractRate(text);
  const extras = extractExtras(text);
  const factor = extractFactor(text);

  const found = [monthKey, previous, current, rate, extras].filter((v) => v != null).length;
  const confidence = found / 5;

  return {
    monthKey,
    previous,
    current,
    factor,
    rate,
    extras,
    confidence,
    rawPreview: text.slice(0, 400),
  };
}
