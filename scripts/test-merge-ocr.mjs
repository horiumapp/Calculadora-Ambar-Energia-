import { parseBillText, mergeParsedResults } from "../src/lib/billParser.js";
import assert from "node:assert/strict";

const soft = `
BT: 05/11/2026
En Ativa Total          14978          4545 — 1,000         0       331       333
CONTR. ILUMINACAO PUB. (COSIP) |
`;

const sparse = `
QUTUBRO/2026
333
321,61
En Ativa Total
14978
14545
333
333
CONTR.
ILUMINACAO PUB.
(COSIP)
30,00
`;

const a = parseBillText(soft);
const b = parseBillText(sparse);
const merged = mergeParsedResults([a, b]);

console.log({ a, b, merged });

assert.equal(a.consumptionHint, 333);
assert.equal(a.previous, 14645, "recalcula anterior a partir do consumo");
assert.equal(a.current, 14978);
assert.equal(merged.monthKey, "2026-10");
assert.equal(merged.previous, 14645);
assert.equal(merged.current, 14978);
assert.equal(merged.extras, 30);
assert.equal(merged.factor, 1);
assert.ok(merged.rate != null && Math.abs(merged.rate - 0.87571) < 0.01, "tarifa estimada");

console.log("OK merge com correcao de leitura");
