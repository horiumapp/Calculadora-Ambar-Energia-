import { parseBillText, mergeParsedResults } from "../src/lib/billParser.js";
import assert from "node:assert/strict";

const wa = `
OUTUBRO/2026
333
321,61
14978 1404
COSIP 30,00
`;

const header = `
CONTA MES OUTUBRO/2026
CONSUMO 333
TOTAL 321,61
`;

const mid = `
En Ativa Total
14978
1404
`;

const a = parseBillText(wa);
const b = parseBillText(header);
const c = parseBillText(mid);
const combined = [wa, header, mid].join("\n");
const m = mergeParsedResults([a, b, c], combined);

console.log({ a, c, m });

assert.equal(a.current, 14978, "texto curto tambem recupera atual");
assert.equal(a.previous, 14645, "texto curto recalcula anterior");
assert.equal(m.monthKey, "2026-10");
assert.equal(m.current, 14978);
assert.equal(m.previous, 14645, "deve recalcular anterior com consumo 333");
assert.equal(m.trust.previous, true);
assert.equal(m.trust.current, true);
assert.equal(m.rate, 0.87571, "tarifa Amazonas fixa");
assert.equal(m.factor, 1, "constante Amazonas fixa");

console.log("OK whatsapp-like OCR recovery");
