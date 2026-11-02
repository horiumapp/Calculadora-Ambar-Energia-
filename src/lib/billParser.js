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

function collectMeterCandidates(text) {
  const normalized = normalizeText(text);
  const seen = new Set();
  const out = [];
  for (const match of normalized.matchAll(/\b(\d{4,6})\b/g)) {
    const num = parseBrNumber(match[1]);
    if (num == null || looksLikeYear(num) || num < 1000) continue;
    // Evita medidor/UC típicos se aparecerem isolados demais; ainda entram no pareamento.
    if (seen.has(num)) continue;
    seen.add(num);
    out.push(num);
  }
  return out;
}

function pickReadingPair(candidates, consumptionHint) {
  if (!candidates.length) return null;
  const pairs = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      const current = candidates[i];
      const previous = candidates[j];
      if (current <= previous) continue;
      const delta = current - previous;
      if (delta < 30 || delta > 8000) continue;
      let score = 0;
      // Números próximos na lista (mesma linha OCR) valem mais.
      score -= Math.abs(i - j) * 15;
      // Prefere leituras com 5 dígitos (comum em medidores AM).
      score += String(current).length >= 5 ? 20 : 0;
      score += String(previous).length >= 5 ? 20 : 0;
      if (consumptionHint != null) {
        const err = Math.abs(delta - consumptionHint);
        score -= err;
        if (err <= 3) score += 500;
        else if (err <= 10) score += 120;
      } else if (delta >= 80 && delta <= 900) {
        score += 40; // faixa residencial comum
      }
      pairs.push({ previous, current, delta, score });
    }
  }
  if (!pairs.length) return null;
  pairs.sort((a, b) => b.score - a.score);
  return pairs[0];
}

function extractReadings(text, consumptionHint = null) {
  const normalized = normalizeText(text);
  let previous = null;
  let current = null;
  let source = null;

  // Linha Amazonas (mesmo com OCR ruído): En Ativa Total 14978 14645 ...
  const compact = normalized.match(
    /en\s*[a-z]{0,12}\s*total[^\d]{0,30}(\d{4,6})\s+(\d{4,6})/i,
  );
  if (compact) {
    current = parseBrNumber(compact[1]);
    previous = parseBrNumber(compact[2]);
    if (
      current != null && previous != null
      && !looksLikeYear(current) && !looksLikeYear(previous)
      && current >= previous
    ) {
      source = "ativa-total";
    } else {
      previous = null;
      current = null;
    }
  }

  // Multilinha (SPARSE OCR): En Ativa Total \n 14978 \n 14645
  if (previous == null || current == null) {
    const multi = normalized.match(
      /en\s*[a-z]{0,12}\s*total\D{0,40}?(\d{4,6})\D{0,20}?(\d{4,6})/i,
    );
    if (multi) {
      const cur = parseBrNumber(multi[1]);
      const prev = parseBrNumber(multi[2]);
      if (
        cur != null && prev != null
        && !looksLikeYear(cur) && !looksLikeYear(prev)
        && cur >= prev
        && String(cur).length >= 4
        && String(prev).length >= 4
      ) {
        current = cur;
        previous = prev;
        source = "ativa-multi";
      }
    }
  }

  // Cabeçalho Leit. Atual ... Leit. Anterior ... depois dois números grandes
  if (previous == null || current == null) {
    const labeledPair = normalized.match(
      /leit\.?\s*atual[\s\S]{0,80}?leit\.?\s*anterior[\s\S]{0,120}?(\d{4,6})\D+(\d{4,6})/i,
    );
    if (labeledPair) {
      const cur = parseBrNumber(labeledPair[1]);
      const prev = parseBrNumber(labeledPair[2]);
      if (
        cur != null && prev != null
        && !looksLikeYear(cur) && !looksLikeYear(prev)
        && cur >= prev
      ) {
        current = cur;
        previous = prev;
        source = "leit-labels";
      }
    }
  }

  if (previous == null || current == null) {
    const currentMatch = normalized.match(
      /leit\.?\s*atual(?:\s*kwh)?[^\d]{0,24}(\d{4,6})(?!\s*[\/.\-]\d)/i,
    );
    const previousMatch = normalized.match(
      /leit\.?\s*anterior(?:\s*kwh)?[^\d]{0,24}(\d{4,6})(?!\s*[\/.\-]\d)/i,
    );
    const cur = currentMatch ? parseBrNumber(currentMatch[1]) : null;
    const prev = previousMatch ? parseBrNumber(previousMatch[1]) : null;
    if (cur != null) current = cur;
    if (prev != null) previous = prev;
    if (current != null && previous != null) source = "leit-single";
  }

  const candidates = collectMeterCandidates(text);

  // Pareamento por consumo: recupera OCR que cortou dígitos (14978 + 1404).
  const pair = pickReadingPair(candidates, consumptionHint);
  if (pair) {
    const currentDelta = previous != null && current != null ? current - previous : null;
    const currentMismatch = consumptionHint != null
      && currentDelta != null
      && Math.abs(currentDelta - consumptionHint) > Math.max(8, consumptionHint * 0.08);
    if (previous == null || current == null || currentMismatch) {
      // Só troca se o novo par for claramente melhor.
      if (
        consumptionHint == null
        || Math.abs(pair.delta - consumptionHint) <= Math.max(8, consumptionHint * 0.08)
        || currentMismatch
      ) {
        previous = pair.previous;
        current = pair.current;
        source = "pair-search";
      }
    }
  }

  // Foto ruim: só a leitura atual sai íntegra; anterior vem truncada e o par falha.
  // Com consumo conhecido: atual - kWh.
  if (consumptionHint != null && consumptionHint > 0) {
    const deltaNow = previous != null && current != null ? current - previous : null;
    const mismatch = deltaNow == null
      || Math.abs(deltaNow - consumptionHint) > Math.max(8, consumptionHint * 0.08);
    if (mismatch) {
      const big = candidates
        .filter((n) => String(n).length >= 5)
        .sort((a, b) => b - a);
      for (const cur of big) {
        const prev = cur - consumptionHint;
        if (!Number.isInteger(prev) || prev < 1000) continue;
        if (looksLikeYear(prev) || looksLikeYear(cur)) continue;
        previous = prev;
        current = cur;
        source = "current-minus-kwh";
        break;
      }
    }
  }

  if (looksLikeYear(previous)) previous = null;
  if (looksLikeYear(current)) current = null;
  if (previous != null && current != null && current < previous) {
    return { previous: null, current: null, source: null };
  }
  return { previous, current, source };
}

function extractTotalHint(text) {
  const normalized = normalizeText(text);
  const labeled = normalized.match(
    /total\s*a\s*pagar[^\d]{0,20}(\d{1,5}[.,]\d{2})/i,
  );
  if (labeled) return parseBrNumber(labeled[1]);
  // Cabeçalho OCR: consumo + total (333 321,61)
  const pair = normalized.match(/\b(\d{2,4})\s+(\d{2,4}[.,]\d{2})(?!\d)/);
  if (pair) {
    const money = parseBrNumber(pair[2]);
    if (money != null && money >= 30 && money < 100000) return money;
  }
  return null;
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
  // OCR sparse no cabeçalho: "333" + "321,61"
  const nearTotal = normalized.match(
    /\b(\d{2,4})\s+(\d{2,4}[.,]\d{2})(?!\d)/,
  );
  if (nearTotal) {
    const kwh = parseBrNumber(nearTotal[1]);
    const money = parseBrNumber(nearTotal[2]);
    if (kwh != null && money != null && kwh >= 50 && kwh <= 5000 && money >= 30) {
      return kwh;
    }
  }
  return null;
}

function readingsMatchConsumption(previous, current, factor, consumptionHint) {
  if (previous == null || current == null || consumptionHint == null) return false;
  const delta = (current - previous) * (factor || 1);
  return Math.abs(delta - consumptionHint) <= Math.max(5, consumptionHint * 0.05);
}

function buildFieldTrust(parsed, rateEstimated = false) {
  const trust = {
    monthKey: parsed.monthKey != null,
    previous: false,
    current: false,
    rate: false,
    extras: parsed.extras != null,
    factor: parsed.factor != null,
  };

  const readingsOk = parsed.previous != null && parsed.current != null
    && parsed.current > parsed.previous
    && String(parsed.current).length >= 4
    && String(parsed.previous).length >= 4;

  if (readingsOk) {
    if (parsed.consumptionHint != null) {
      const match = readingsMatchConsumption(
        parsed.previous,
        parsed.current,
        parsed.factor || 1,
        parsed.consumptionHint,
      );
      trust.previous = match;
      trust.current = match;
    } else {
      // Sem consumo: só confia se ambos tiverem 5 dígitos (menos truncamento).
      const solid = String(parsed.previous).length >= 5 && String(parsed.current).length >= 5;
      trust.previous = solid;
      trust.current = solid;
    }
  }

  // Tarifa estimada não entra no formulário (evita confusão); só a lida no texto.
  trust.rate = parsed.rate != null && !rateEstimated;

  return trust;
}

/**
 * Extrai campos úteis de texto OCR de fatura de energia (BR / Amazonas Energia).
 */
export function parseBillText(ocrText) {
  const text = String(ocrText || "");
  const consumptionHint = extractConsumptionHint(text);
  const totalHint = extractTotalHint(text);
  const readings = extractReadings(text, consumptionHint);
  const raw = {
    monthKey: extractMonthKey(text),
    previous: readings.previous,
    current: readings.current,
    rate: extractRate(text),
    extras: extractExtras(text),
    factor: extractFactor(text),
    consumptionHint,
    totalHint,
  };

  let rateEstimated = false;

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

  // Fallback de tarifa: (total - COSIP) / consumo — marcado como estimado.
  if (
    raw.rate == null
    && raw.consumptionHint
    && raw.totalHint
    && raw.extras != null
    && raw.consumptionHint > 0
  ) {
    const estimated = (raw.totalHint - raw.extras) / raw.consumptionHint;
    if (estimated > 0.05 && estimated < 5) {
      raw.rate = Number(estimated.toFixed(6));
      rateEstimated = true;
    }
  }

  const parsed = sanitizeParsed(raw);
  parsed.consumptionHint = raw.consumptionHint;
  parsed.totalHint = raw.totalHint;
  const trust = buildFieldTrust(parsed, rateEstimated);
  const core = [trust.monthKey, trust.previous, trust.current, trust.rate];
  const found = core.filter(Boolean).length;
  const confidence = found / core.length;

  return {
    ...parsed,
    consumptionHint: raw.consumptionHint,
    totalHint: raw.totalHint,
    rateEstimated,
    trust,
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
export function mergeParsedResults(results, combinedText = "") {
  const list = (results || []).filter(Boolean);
  const consumptionHint = list.map((item) => item.consumptionHint).find((v) => v != null) ?? null;
  const totalHint = list.map((item) => item.totalHint).find((v) => v != null) ?? null;

  // Reparse do texto concatenado: junta cabeçalho + medições de regiões diferentes.
  const fromCombined = combinedText
    ? parseBillText(combinedText)
    : null;

  const readingCandidate = [...list, fromCombined]
    .filter((item) => item?.previous != null && item?.current != null)
    .sort((a, b) => readingError(a, consumptionHint) - readingError(b, consumptionHint))[0] || null;

  let rateEstimated = false;
  const merged = {
    monthKey: fromCombined?.monthKey ?? null,
    previous: readingCandidate?.previous ?? null,
    current: readingCandidate?.current ?? null,
    factor: readingCandidate?.factor ?? null,
    rate: null,
    extras: null,
    rawPreview: combinedText.slice(0, 600) || "",
    consumptionHint: fromCombined?.consumptionHint ?? consumptionHint,
    totalHint: fromCombined?.totalHint ?? totalHint,
  };

  for (const item of list) {
    if (merged.monthKey == null && item.monthKey != null) merged.monthKey = item.monthKey;
    if (merged.extras == null && item.extras != null) merged.extras = item.extras;
    if (merged.factor == null && item.factor != null) merged.factor = item.factor;
    if (!merged.rawPreview && item.rawPreview) merged.rawPreview = item.rawPreview;
  }

  // Preferir tarifa lida no OCR (não estimada).
  for (const item of [fromCombined, ...list]) {
    if (!item?.rate) continue;
    if (item.rateEstimated) continue;
    merged.rate = item.rate;
    rateEstimated = false;
    break;
  }

  if (
    merged.rate == null
    && merged.consumptionHint
    && merged.totalHint
    && merged.extras != null
    && merged.consumptionHint > 0
  ) {
    const estimated = (merged.totalHint - merged.extras) / merged.consumptionHint;
    if (estimated > 0.05 && estimated < 5) {
      merged.rate = Number(estimated.toFixed(6));
      rateEstimated = true;
    }
  }

  // Recalcula anterior se consumo e atual forem confiáveis.
  if (
    merged.current != null
    && merged.consumptionHint != null
    && merged.consumptionHint > 0
  ) {
    const factor = merged.factor || 1;
    const expectedPrevious = merged.current - (merged.consumptionHint / factor);
    if (Number.isInteger(expectedPrevious) && expectedPrevious >= 0) {
      const mismatch = merged.previous == null
        || Math.abs((merged.current - merged.previous) * factor - merged.consumptionHint)
          > Math.max(5, merged.consumptionHint * 0.05);
      if (mismatch) merged.previous = expectedPrevious;
    }
  }

  const sanitized = sanitizeParsed({
    ...merged,
    confidence: 0,
    warnings: [],
    rawPreview: merged.rawPreview,
  });
  sanitized.consumptionHint = merged.consumptionHint;
  sanitized.totalHint = merged.totalHint;
  sanitized.rateEstimated = rateEstimated;
  sanitized.trust = buildFieldTrust(sanitized, rateEstimated);
  const core = [
    sanitized.trust.monthKey,
    sanitized.trust.previous,
    sanitized.trust.current,
    sanitized.trust.rate,
  ];
  sanitized.confidence = core.filter(Boolean).length / core.length;
  return sanitized;
}
