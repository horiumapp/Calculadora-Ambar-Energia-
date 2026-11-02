import { parseBillText } from "../src/lib/billParser.js";

const sample = `
Companhia de Energia
Referencia OUT/2025
Leitura Anterior 14645
Leitura Atual 14978
Tarifa 0,875710 R$/kWh
COSIP 30,00
Constante 1
`;

console.log(parseBillText(sample));
