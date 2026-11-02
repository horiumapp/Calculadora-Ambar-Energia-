import { parseBillText } from "../src/lib/billParser.js";

const samples = [
  {
    name: "fatura limpa",
    text: `
Companhia de Energia
Referencia OUT/2025
Leitura Anterior 14645
Leitura Atual 14978
Tarifa 0,875710 R$/kWh
COSIP 30,00
Constante do medidor 1
`,
  },
  {
    name: "lixo tipo OCR ruim",
    text: `
OUT 2086
2026
tarifa 2
constante 5
algo atual
`,
  },
];

for (const sample of samples) {
  console.log("\n===", sample.name, "===");
  console.log(parseBillText(sample.text));
}
