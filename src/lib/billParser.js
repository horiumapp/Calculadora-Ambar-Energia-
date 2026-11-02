const MONTH_NAMES = {
  janeiro: 1, jan: 1,
  fevereiro: 2, fev: 2,
  marco: 3, mar: 3,
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
  let value = String(raw).trim().replace(/[^\d.,-]/g, "");
  if (!value || value === "-" || value === "." || value === ",") return null;

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

function currentYear() {
  return new Date().getFullYear();
}

function isPlausibleBillYear(year) {
  const y = Number(year);
  const now = currentYear();
  return y >= now - 2 && y <= now + 1;
}

function toMonthKey(year, month) {
  if (!year || !month || month < 1 || month > 12) return null;
  if (!isPlausibleBillYear(year)) return null;
  return `${Number(year)}-${String(month).padStart(2, "0")}`;
}

function looksLikeYear(num) {
  return Number.isInteger(num) && num >= 2000 && num <= 2100;
}

function extractNumberTokens(line) {
  return String(line).match(
    /-?\d{1,3}(?:[.\s]\d{3})+(?:,\d+)?|-?\d+[.,]\d{2,6}|-?\d{4,}|-?\d+/g,
  ) || [];
}

function extractMonthKey(text) {
  const normalized = normalizeText(text).toLowerCase();

  const patterns = [
    /(?:referencia|mes\s*\/?\s*ano|conta\s*mes|periodo|ref\.?)[^\n]{0,48}?((?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*)[\/\-\s.]+(\d{4}|\d{2})/i,
    /\b((?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[a-z]*)[\/\-](\d{4}|\d{2})\b/i,
  ];

  for (const re of patterns) {
    const match = normalized.match(re);
    if (!match) continue;
    const monthToken = match[1].slice(0, 3);
    const month = MONTH_NAMES[monthToken] || MONTH_NAMES[match[1]];
    let year = Number(match[2]);
    if (year < 100) year += 2000;
    const key = toMonthKey(year, month);
    if (key) return key;
  }

  const labeledNumeric = normalized.match(
    /(?:referencia|mes\s*\/?\s*ano|conta\s*mes|periodo)[^\n]{0,40}?\b(0?[1-9]|1[0-2])[\/\-](\d{4})\b/i,
  );
  if (labeledNumeric) {
    const key = toMonthKey(labeledNumeric[2], Number(labeledNumeric[1]));
    if (key) return key;
  }

  return null;
}

function findCandidatesNear(labelRe, text, filterFn) {
  const lines = text.split(/\n+/);
  const found = [];

  for (let i = 0; i < lines.length; i++) {
    const line = normalizeText(lines[i]);
    if (!labelRe.test(line)) continue;

    const scan = [line];
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
      scan.push(normalizeText(lines[j]));
    }

    for (const candidateLine of scan) {
      for (const token of extractNumberTokens(candidateLine)) {
        const num = parseBrNumber(token);
        if (num == null) continue;
        if (filterFn && !filterFn(num, token, candidateLine)) continue;
        found.push({ num, token, line: candidateLine });
      }
    }
  }

  return found;
}

function extractReadings(text) {
  const readingFilter = (num, token) => {
    if (!Number.isFinite(num) || num < 0 || num > 1_000_000_000) return false;
    // Anos (ex.: 2026) quase nunca são leitura de medidor isolada.
    if (looksLikeYear(num)) return false;
    // Leituras costumam ter pelo menos 3 dígitos (ou milhar com ponto).
    const digits = String(token).replace(/\D/g, "");
    return digits.length >= 3;
  };

  const previousHits = findCandidatesNear(
    /leitura\s+anterior|leitura\s+ant\.?|anterior\s+do\s+medidor/i,
    text,
    readingFilter,
  );
  const currentHits = findCandidatesNear(
    /leitura\s+atual|leitura\s+do\s+mes|atual\s+do\s+medidor/i,
    text,
    readingFilter,
  );

  // Evita o rótulo genérico "anterior/atual" sozinho — pega demais lixo do OCR.
  let previous = previousHits[0]?.num ?? null;
  let current = currentHits[0]?.num ?? null;

  if (previous == null || current == null) {
    const pair = normalizeText(text).match(
      /leitura\s+anterior[^\d]{0,24}(\d{1,3}(?:[.\s]\d{3})+|\d{3,9})[^\d]{0,40}leitura\s+atual[^\d]{0,24}(\d{1,3}(?:[.\s]\d{3})+|\d{3,9})/i,
    );
    if (pair) {
      previous = parseBrNumber(pair[1]);
      current = parseBrNumber(pair[2]);
    }
  }

  if (previous == null || current == null) {
    const table = normalizeText(text).match(
      /(?:anterior|atual).{0,80}?(\d{1,3}(?:[.\s]\d{3})+|\d{4,9}).{0,40}?(\d{1,3}(?:[.\s]\d{3})+|\d{4,9})/i,
    );
    if (table) {
      const a = parseBrNumber(table[1]);
      const b = parseBrNumber(table[2]);
      if (a != null && b != null && !looksLikeYear(a) && !looksLikeYear(b) && b >= a) {
        previous = previous ?? a;
        current = current ?? b;
      }
    }
  }

  if (previous != null && current != null && current < previous) {
    return { previous: null, current: null };
  }

  return { previous, current };
}

function extractRate(text) {
  const rateFilter = (num, token) => {
    if (!(num > 0.05 && num < 5)) return false;
    // Tarifa BR quase sempre tem casas decimais (ex.: 0,875710). Inteiro 2/5 é lixo de OCR.
    return /[.,]\d{2,}/.test(token);
  };

  const hits = findCandidatesNear(
    /(?:tarifa|preco\s*unit(?:ario)?|valor\s*unitario|te\b|tusd|r\$\s*\/\s*kwh)/i,
    text,
    rateFilter,
  );
  if (hits.length) return hits[0].num;

  const match = normalizeText(text).match(
    /(\d+[.,]\d{4,6})\s*(?:\/\s*)?kwh/i,
  );
  return match ? parseBrNumber(match[1]) : null;
}

function extractExtras(text) {
  const hits = findCandidatesNear(
    /cosip|cip\b|iluminacao\s+publica|contrib(?:uicao)?[^\n]{0,20}ilumin/i,
    text,
    (num, token) => {
      if (!(num >= 0 && num <= 5000)) return false;
      // Preferir valores monetários com decimais; aceitar inteiro só se >= 5.
      return /[.,]\d{2}/.test(token) || num >= 5;
    },
  );
  return hits[0]?.num ?? null;
}

function extractFactor(text) {
  const hits = findCandidatesNear(
    /constante(?:\s+do\s+medidor)?|multiplicador|fator\s+(?:do\s+)?medidor/i,
    text,
    (num) => num > 0 && num <= 1000,
  );
  // Só preenche se achou rótulo explícito. Senão null (UI pode assumir 1 depois).
  return hits[0]?.num ?? null;
}

function sanitizeParsed(parsed) {
  const next = { ...parsed };

  if (next.monthKey) {
    const year = Number(String(next.monthKey).slice(0, 4));
    if (!isPlausibleBillYear(year)) next.monthKey = null;
  }

  if (looksLikeYear(next.previous)) next.previous = null;
  if (looksLikeYear(next.current)) next.current = null;

  if (next.previous != null && next.current != null && next.current < next.previous) {
    next.previous = null;
    next.current = null;
  }

  if (next.rate != null && (!(next.rate > 0.05 && next.rate < 5) || Number.isInteger(next.rate))) {
    next.rate = null;
  }

  if (next.factor != null && (!(next.factor > 0 && next.factor <= 1000))) {
    next.factor = null;
  }

  if (next.extras != null && (!(next.extras >= 0 && next.extras <= 5000))) {
    next.extras = null;
  }

  return next;
}

/**
 * Extrai campos úteis de texto OCR de fatura de energia (BR).
 */
export function parseBillText(ocrText) {
  const text = String(ocrText || "");
  const raw = {
    monthKey: extractMonthKey(text),
    ...extractReadings(text),
    rate: extractRate(text),
    extras: extractExtras(text),
    factor: extractFactor(text),
  };

  const parsed = sanitizeParsed(raw);
  const core = [parsed.monthKey, parsed.previous, parsed.current, parsed.rate];
  const found = core.filter((v) => v != null).length;
  const confidence = found / core.length;

  return {
    ...parsed,
    confidence,
    warnings: [],
    rawPreview: text.slice(0, 600),
  };
}
