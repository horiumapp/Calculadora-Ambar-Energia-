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

const MONTH_FULL = [
  "janeiro", "fevereiro", "marco", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

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

function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  const dp = Array.from({ length: s.length + 1 }, () => Array(t.length + 1).fill(0));
  for (let i = 0; i <= s.length; i++) dp[i][0] = i;
  for (let j = 0; j <= t.length; j++) dp[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[s.length][t.length];
}

/** Corrige OCR tipo QUTUBRO → outubro. */
function resolveMonthName(raw) {
  let token = String(raw || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!token) return null;
  token = token.replace(/^q/, "o").replace(/0/g, "o");
  if (MONTH_NAMES[token]) return MONTH_NAMES[token];
  if (token.length >= 3 && MONTH_NAMES[token.slice(0, 3)]) return MONTH_NAMES[token.slice(0, 3)];
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < MONTH_FULL.length; i++) {
    const name = MONTH_FULL[i];
    const dist = editDistance(token, name);
    const maxAllowed = token.length <= 4 ? 1 : 2;
    if (dist <= maxAllowed && dist < bestDist) {
      bestDist = dist;
      best = i + 1;
    }
  }
  return best;
}

function extractMonthKey(text) {
  const normalized = normalizeText(text).toLowerCase();

  const candidates = [
    ...normalized.matchAll(
      /(?:conta\s*mes|referencia|mes\s*\/?\s*ano|periodo)?[^\n]{0,40}?([a-z]{3,12})\s*[\/\-]\s*(\d{4}|\d{2})/gi,
    ),
  ];

  for (const match of candidates) {
    const month = resolveMonthName(match[1]);
    if (!month) continue;
    let year = Number(match[2]);
    if (year < 100) year += 2000;
    // OCR às vezes troca 2026→2028/2025; se mês ok e ano perto, corrige para ano atual/próximo.
    if (!isPlausibleBillYear(year)) {
      const now = currentYear();
      if (Math.abs(year - now) <= 3) year = now;
      else continue;
    }
    const key = toMonthKey(year, month);
    if (key) return key;
  }

  // Só o nome do mês (ex.: linha "QUTUBRO/2026" quebrada).
  const loose = normalized.match(/\b([a-z]{5,12})\s*[\/\-]\s*(20\d{2})\b/i);
  if (loose) {
    const month = resolveMonthName(loose[1]);
    let year = Number(loose[2]);
    if (!isPlausibleBillYear(year) && Math.abs(year - currentYear()) <= 3) year = currentYear();
    const key = toMonthKey(year, month);
    if (key) return key;
  }

  return null;
}

function extractReadings(text) {
  const normalized = normalizeText(text);

  // Linha Amazonas (mesmo com OCR ruído): En Ativa Total 14978 14645 ...
  const compact = normalized.match(
    /en\s*[a-z]{0,12}\s*total[^\d]{0,30}(\d{4,6})\s+(\d{4,6})/i,
  );
  if (compact) {
    const current = parseBrNumber(compact[1]);
    const previous = parseBrNumber(compact[2]);
    if (
      current != null && previous != null
      && !looksLikeYear(current) && !looksLikeYear(previous)
      && current >= previous
    ) {
      return { previous, current };
    }
  }

  // Multilinha (SPARSE OCR): En Ativa Total \n 14978 \n 14645
  const multi = normalized.match(
    /en\s*[a-z]{0,12}\s*total\D{0,40}?(\d{4,6})\D{0,20}?(\d{4,6})/i,
  );
  if (multi) {
    const current = parseBrNumber(multi[1]);
    const previous = parseBrNumber(multi[2]);
    if (
      current != null && previous != null
      && !looksLikeYear(current) && !looksLikeYear(previous)
      && current >= previous
      && String(current).length >= 4
      && String(previous).length >= 4
    ) {
      return { previous, current };
    }
  }

  // Cabeçalho Leit. Atual ... Leit. Anterior ... depois dois números grandes
  const labeledPair = normalized.match(
    /leit\.?\s*atual[\s\S]{0,80}?leit\.?\s*anterior[\s\S]{0,120}?(\d{4,6})\D+(\d{4,6})/i,
  );
  if (labeledPair) {
    const current = parseBrNumber(labeledPair[1]);
    const previous = parseBrNumber(labeledPair[2]);
    if (
      current != null && previous != null
      && !looksLikeYear(current) && !looksLikeYear(previous)
      && current >= previous
    ) {
      return { previous, current };
    }
  }

  const currentMatch = normalized.match(
    /leit\.?\s*atual(?:\s*kwh)?[^\d]{0,24}(\d{4,6})(?!\s*[\/.\-]\d)/i,
  );
  const previousMatch = normalized.match(
    /leit\.?\s*anterior(?:\s*kwh)?[^\d]{0,24}(\d{4,6})(?!\s*[\/.\-]\d)/i,
  );

  let current = currentMatch ? parseBrNumber(currentMatch[1]) : null;
  let previous = previousMatch ? parseBrNumber(previousMatch[1]) : null;

  if (previous == null) {
    const m = normalized.match(
      /leitura\s+anterior[^\d]{0,24}(\d{1,3}(?:[.\s]\d{3})+|\d{4,9})(?!\s*[\/.\-]\d)/i,
    );
    previous = m ? parseBrNumber(m[1]) : null;
  }
  if (current == null) {
    const m = normalized.match(
      /leitura\s+atual[^\d]{0,24}(\d{1,3}(?:[.\s]\d{3})+|\d{4,9})(?!\s*[\/.\-]\d)/i,
    );
    current = m ? parseBrNumber(m[1]) : null;
  }

  if (looksLikeYear(previous)) previous = null;
  if (looksLikeYear(current)) current = null;
  if (previous != null && current != null && current < previous) {
    return { previous: null, current: null };
  }
  return { previous, current };
}

function extractRate(text) {
  const normalized = normalizeText(text);

  const am = normalized.match(
    /consumo[^\n]{0,60}?a\s*r\$\s*(\d+[.,]\d{4,6})/i,
  );
  if (am) {
    const rate = parseBrNumber(am[1]);
    if (rate != null && rate > 0.05 && rate < 5) return rate;
  }

  // OCR às vezes: "333 A R$ 0,875710" sem a palavra consumo junta
  const aReais = normalized.match(
    /\b\d{2,5}\s*a\s*r\$\s*(\d+[.,]\d{4,6})/i,
  );
  if (aReais) {
    const rate = parseBrNumber(aReais[1]);
    if (rate != null && rate > 0.05 && rate < 5) return rate;
  }

  const generic = normalized.match(
    /(?:tarifa|preco\s*unit|r\$\s*\/\s*kwh)[^\d]{0,20}(\d+[.,]\d{4,6})/i,
  );
  if (generic) {
    const rate = parseBrNumber(generic[1]);
    if (rate != null && rate > 0.05 && rate < 5) return rate;
  }

  const kwh = normalized.match(/(\d+[.,]\d{4,6})\s*(?:\/\s*)?kwh/i);
  if (kwh) {
    const rate = parseBrNumber(kwh[1]);
    if (rate != null && rate > 0.05 && rate < 5) return rate;
  }

  return null;
}

function extractExtras(text) {
  const normalized = normalizeText(text);
  const cosip = normalized.match(
    /(?:contr\.?\s*iluminacao\s*pub\.?|iluminacao\s*publica|\bcosip\b)[^\d]{0,40}(\d{1,4}[.,]\d{2}|\d{1,4})(?!\d)/i,
  );
  if (cosip) {
    const value = parseBrNumber(cosip[1]);
    if (value != null && value >= 0 && value <= 5000) return value;
  }
  return null;
}

function extractFactor(text) {
  const normalized = normalizeText(text);
  // Constante residencial é tipicamente 1 ou 1,000 — nunca centenas (isso é consumo).
  const isPlausibleFactor = (num) => num != null && num > 0 && num <= 100;

  const row = normalized.match(
    /en\s*[a-z]{0,12}\s*total\s+(\d{4,6})\s+(\d{4,6})\s+(\d+[.,]\d{1,3}|\d+(?!\d))/i,
  );
  if (row) {
    const factor = parseBrNumber(row[3]);
    if (isPlausibleFactor(factor)) return factor;
  }

  const labeled = normalized.match(
    /constante(?:\s+do\s+medidor)?[^\d]{0,20}(\d+[.,]\d{1,3}|\d+)/i,
  );
  if (labeled) {
    const factor = parseBrNumber(labeled[1]);
    if (isPlausibleFactor(factor)) return factor;
  }

  return null;
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

  // Constante quase sempre 1 nestas contas residenciais se leituras ok.
  if (next.factor == null && next.previous != null && next.current != null) {
    next.factor = 1;
  }

  if (next.extras != null && (!(next.extras >= 0 && next.extras <= 5000))) {
    next.extras = null;
  }

  return next;
}

function extractConsumptionHint(text) {
  const normalized = normalizeText(text);
  const labeled = normalized.match(
    /consumo\s*\(?\s*kwh\s*\)?[^\d]{0,20}(\d{2,5})/i,
  );
  if (labeled) {
    const value = parseBrNumber(labeled[1]);
    if (value != null && value > 0 && value < 100000) return value;
  }
  // Pares medido/faturado no fim da linha En Ativa (ex.: 331 333 ou 333 333).
  const pairs = [...normalized.matchAll(/\b(\d{2,4})\s+(\d{2,4})\b/g)];
  for (const pair of pairs) {
    const a = parseBrNumber(pair[1]);
    const b = parseBrNumber(pair[2]);
    if (a == null || b == null) continue;
    if (a < 30 || a > 8000 || b < 30 || b > 8000) continue;
    if (Math.abs(a - b) <= 5) return Math.max(a, b);
  }
  // OCR sparse: "333" seguido de valor em R$ (321,61)
  const nearTotal = normalized.match(
    /\b(\d{2,4})\b[^\d]{0,24}(\d{2,4}[.,]\d{2})\b/,
  );
  if (nearTotal) {
    const kwh = parseBrNumber(nearTotal[1]);
    const money = parseBrNumber(nearTotal[2]);
    if (kwh != null && money != null && kwh >= 50 && kwh <= 5000 && money > 20) {
      return kwh;
    }
  }
  return null;
}

/**
 * Extrai campos úteis de texto OCR de fatura de energia (BR / Amazonas Energia).
 */
export function parseBillText(ocrText) {
  const text = String(ocrText || "");
  const raw = {
    monthKey: extractMonthKey(text),
    ...extractReadings(text),
    rate: extractRate(text),
    extras: extractExtras(text),
    factor: extractFactor(text),
    consumptionHint: extractConsumptionHint(text),
  };

  // Se a leitura atual e o consumo batem, recalcula a anterior (OCR costuma errar 1 dígito).
  if (
    raw.current != null
    && raw.consumptionHint != null
    && raw.consumptionHint > 0
  ) {
    const factor = raw.factor || 1;
    const expectedPrevious = raw.current - (raw.consumptionHint / factor);
    if (Number.isInteger(expectedPrevious) && expectedPrevious >= 0) {
      const mismatch = raw.previous == null
        || Math.abs((raw.current - raw.previous) * factor - raw.consumptionHint) > Math.max(5, raw.consumptionHint * 0.05);
      if (mismatch) raw.previous = expectedPrevious;
    }
  }

  const parsed = sanitizeParsed(raw);
  const core = [parsed.monthKey, parsed.previous, parsed.current, parsed.rate];
  const found = core.filter((v) => v != null).length;
  const confidence = found / core.length;

  return {
    ...parsed,
    consumptionHint: raw.consumptionHint,
    confidence,
    warnings: [],
    rawPreview: text.slice(0, 600),
  };
}

function readingError(item, consumptionHint) {
  if (item?.previous == null || item?.current == null) return Infinity;
  if (item.current < item.previous) return Infinity;
  const factor = item.factor || 1;
  const delta = (item.current - item.previous) * factor;
  if (consumptionHint == null) {
    // Prefere leituras com mais dígitos (menos truncamento OCR).
    return 1000 - (String(item.previous).length + String(item.current).length) * 10;
  }
  return Math.abs(delta - consumptionHint);
}

/** Mescla vários resultados OCR, preferindo campos preenchidos e leituras coerentes. */
export function mergeParsedResults(results) {
  const list = (results || []).filter(Boolean);
  const consumptionHint = list.map((item) => item.consumptionHint).find((v) => v != null) ?? null;

  const readingCandidate = [...list]
    .filter((item) => item.previous != null && item.current != null)
    .sort((a, b) => readingError(a, consumptionHint) - readingError(b, consumptionHint))[0] || null;

  const merged = {
    monthKey: null,
    previous: readingCandidate?.previous ?? null,
    current: readingCandidate?.current ?? null,
    factor: readingCandidate?.factor ?? null,
    rate: null,
    extras: null,
    rawPreview: "",
  };

  for (const item of list) {
    if (merged.monthKey == null && item.monthKey != null) merged.monthKey = item.monthKey;
    if (merged.rate == null && item.rate != null) merged.rate = item.rate;
    if (merged.extras == null && item.extras != null) merged.extras = item.extras;
    if (merged.factor == null && item.factor != null) merged.factor = item.factor;
    if (!merged.rawPreview && item.rawPreview) merged.rawPreview = item.rawPreview;
  }

  const sanitized = sanitizeParsed({
    ...merged,
    confidence: 0,
    warnings: [],
    rawPreview: merged.rawPreview,
  });
  sanitized.consumptionHint = consumptionHint;
  return sanitized;
}
