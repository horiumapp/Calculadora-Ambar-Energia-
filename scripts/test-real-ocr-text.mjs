import { parseBillText, mergeParsedResults } from "../src/lib/billParser.js";
import assert from "node:assert/strict";

// Texto real capturado do OCR da foto Amazonas (cabeçalho sujo).
const softHeader = `
OUTUBRO, [2026    05/11/2026      333     321 81
IV PADRE toa S DO NASCIMENTO
En Ativa Total      14978          4045
`;

const values = `
CONSUMO 333 A R$ 0,875710 = 291,61
CONTR. ILUMINACAO PUB. (COSIP) 30,00
`;

const a = parseBillText(softHeader);
console.log("header", a);

assert.equal(a.monthKey, "2026-10", "mês a partir de OUTUBRO, [2026");
assert.equal(a.consumptionHint, 333, "consumo 333 mesmo com total 321 81");
assert.equal(a.totalHint, 321.81); // OCR leu 81 em vez de 61 — aceitável no teste de captura
assert.equal(a.current, 14978);
assert.equal(a.previous, 14645, "recalcula anterior com consumo");

const merged = mergeParsedResults([a, parseBillText(values)], `${softHeader}\n${values}`);
console.log("merged", merged);

assert.equal(merged.monthKey, "2026-10");
assert.equal(merged.previous, 14645);
assert.equal(merged.current, 14978);
assert.equal(merged.extras, 30);
assert.ok(merged.rate != null && merged.rate > 0.8 && merged.rate < 0.9);
assert.equal(merged.trust.previous, true);
assert.equal(merged.trust.current, true);
assert.equal(merged.trust.rate, true);

console.log("OK real OCR text recovery");
