import { parseBillText, mergeParsedResults } from "../src/lib/billParser.js";
import assert from "node:assert/strict";

const amazonasSample = `
CHAVE DE ACESSO
1326 1002 3414 6700 0120 6600 1122 0510 5210 2051 0524
CONTA MES OUTUBRO/2026 VENCIMENTO 05/11/2026 CONSUMO (KWH) 333 TOTAL A PAGAR (R$) 321,61
DATAS DA LEITURA
Atual 09/10/2026 Anterior 08/09/2026
DADOS DA LEITURA (KWH)
Desc. da Grandeza Leit. Atual Leit. Anterior Constante Residuo Medido Faturado
En Ativa Total 14978 14645 1,000 0 333 333
DESCRICAO DA CONTA
CONSUMO 333 A R$ 0,875710 = 291,61
CONTR. ILUMINACAO PUB. (COSIP) 30,00
`;

const noisyOcr = `
QUTUBRO/2026
05/11/2020
333
321,61
En Ativa Total
14978
14645
|, Bd
333
333
CONTR ILUMINACAO PUB. (COSIP)
30,00
`;

const clean = parseBillText(amazonasSample);
assert.equal(clean.monthKey, "2026-10");
assert.equal(clean.previous, 14645);
assert.equal(clean.current, 14978);
assert.equal(clean.factor, 1);
assert.equal(clean.rate, 0.87571);
assert.equal(clean.extras, 30);

const noisy = parseBillText(noisyOcr);
assert.equal(noisy.monthKey, "2026-10", "QUTUBRO deve virar OUTUBRO/2026");
assert.equal(noisy.previous, 14645);
assert.equal(noisy.current, 14978);
assert.equal(noisy.extras, 30);
assert.equal(noisy.factor, 1);

const merged = mergeParsedResults([
  parseBillText("QUTUBRO/2026\n14978\n14645"),
  parseBillText("CONSUMO 333 A R$ 0,875710 = 291,61\nCOSIP 30,00"),
]);
assert.equal(merged.monthKey, "2026-10");
assert.equal(merged.rate, 0.87571);
assert.equal(merged.extras, 30);

console.log("OK parser Amazonas + OCR ruidoso + merge");
console.log({ clean, noisy, merged });
