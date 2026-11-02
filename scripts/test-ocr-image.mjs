import { createWorker, PSM } from "tesseract.js";
import { mergeParsedResults, parseBillText } from "../src/lib/billParser.js";
import { readFileSync, writeFileSync } from "fs";
import jpeg from "jpeg-js";

const imgPath = process.argv[2];
if (!imgPath) {
  console.error("Uso: node scripts/test-ocr-image.mjs <imagem.jpg>");
  process.exit(1);
}

function preprocessJpeg(buf, { scaleFactor = 2.4, hardBin = false } = {}) {
  const raw = jpeg.decode(buf, { useTArray: true });
  const scale = Math.max(scaleFactor, 1800 / Math.max(raw.width, raw.height));
  const w = Math.round(raw.width * scale);
  const h = Math.round(raw.height * scale);
  const out = new Uint8Array(w * h * 4);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(raw.width - 1, Math.floor(x / scale));
      const sy = Math.min(raw.height - 1, Math.floor(y / scale));
      const si = (sy * raw.width + sx) * 4;
      let r = raw.data[si];
      let g = raw.data[si + 1];
      let b = raw.data[si + 2];
      if (r > 170 && g > 70 && g < 210 && b < 140) r = g = b = 255;
      let gray = r * 0.299 + g * 0.587 + b * 0.114;
      gray = Math.max(0, Math.min(255, (gray - 35) * (255 / 185)));
      const v = hardBin ? (gray < 155 ? 0 : 255) : gray;
      const di = (y * w + x) * 4;
      out[di] = v;
      out[di + 1] = v;
      out[di + 2] = v;
      out[di + 3] = 255;
    }
  }

  return jpeg.encode({ data: out, width: w, height: h }, 92).data;
}

const original = readFileSync(imgPath);
const worker = await createWorker("por+eng");
const results = [];

for (const mode of [
  { name: "soft-auto", hardBin: false, psm: PSM.AUTO },
  { name: "bin-sparse", hardBin: true, psm: PSM.SPARSE_TEXT },
]) {
  const processed = preprocessJpeg(original, { hardBin: mode.hardBin, scaleFactor: 2.5 });
  writeFileSync(`scripts/_ocr-${mode.name}.jpg`, processed);
  await worker.setParameters({
    tessedit_pageseg_mode: mode.psm,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const { data: { text } } = await worker.recognize(processed);
  const parsed = parseBillText(text);
  results.push(parsed);
  console.log(`\n=== ${mode.name} ===`);
  console.log(parsed);
}

await worker.terminate();
const merged = mergeParsedResults(results);
console.log("\n=== MERGED ===");
console.log(merged);
