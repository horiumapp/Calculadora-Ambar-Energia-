import { createWorker, PSM } from "tesseract.js";
import { readFileSync, writeFileSync } from "fs";
import jpeg from "jpeg-js";
import { mergeParsedResults, parseBillText } from "../src/lib/billParser.js";

const raw = jpeg.decode(readFileSync("scripts/scan-bill.jpg"), { useTArray: true });

function sample(raw, fx, fy) {
  const x = Math.min(raw.width - 1, Math.max(0, Math.floor(fx)));
  const y = Math.min(raw.height - 1, Math.max(0, Math.floor(fy)));
  const i = (y * raw.width + x) * 4;
  return [raw.data[i], raw.data[i + 1], raw.data[i + 2]];
}

function processRegion(raw, y0, y1, { scale = 2, harden = true, thicken = 1 } = {}) {
  const sy0 = Math.floor(raw.height * y0);
  const sh = Math.ceil(raw.height * (y1 - y0));
  const w = Math.round(raw.width * scale);
  const h = Math.round(sh * scale);
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let [r, g, b] = sample(raw, x / scale, sy0 + y / scale);
      if (r > 160 && g > 60 && g < 220 && b < 150 && r > b + 40) {
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        gray[y * w + x] = lum > 190 ? 0 : 255;
        continue;
      }
      let v = r * 0.299 + g * 0.587 + b * 0.114;
      v = Math.max(0, Math.min(255, (v - 35) * (255 / 175)));
      gray[y * w + x] = harden ? (v < 148 ? 0 : 255) : v;
    }
  }
  let out = gray;
  if (thicken > 0) {
    let cur = out;
    for (let t = 0; t < thicken; t++) {
      const next = new Float32Array(w * h);
      next.fill(255);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          let black = false;
          for (let dy = -1; dy <= 1 && !black; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (cur[(y + dy) * w + (x + dx)] < 128) black = true;
            }
          }
          next[y * w + x] = black ? 0 : 255;
        }
      }
      cur = next;
    }
    out = cur;
  }
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = out[i];
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data: rgba, width: w, height: h }, 95).data;
}

const regions = [
  { label: "header", y0: 0.03, y1: 0.18, harden: false, thicken: 0, scale: 2 },
  { label: "headerBin", y0: 0.03, y1: 0.18, harden: true, thicken: 1, scale: 2.2 },
  { label: "readings", y0: 0.55, y1: 0.78, harden: true, thicken: 1, scale: 2.5 },
  { label: "readingsSoft", y0: 0.55, y1: 0.78, harden: false, thicken: 0, scale: 2.2 },
  { label: "readingsLine", y0: 0.58, y1: 0.72, harden: true, thicken: 1, scale: 3 },
  { label: "cosip", y0: 0.68, y1: 0.92, harden: true, thicken: 1, scale: 2 },
];

const worker = await createWorker("por+eng");
const texts = [];
const parsed = [];
for (const region of regions) {
  const img = processRegion(raw, region.y0, region.y1, region);
  writeFileSync(`scripts/_pipe-${region.label}.jpg`, img);
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const { data: { text } } = await worker.recognize(img);
  console.log(`\n=== ${region.label} ===\n${text}`);
  texts.push(text);
  parsed.push(parseBillText(text));
}

const merged = mergeParsedResults(parsed, texts.join("\n"));
console.log("\nMERGED", {
  monthKey: merged.monthKey,
  previous: merged.previous,
  current: merged.current,
  factor: merged.factor,
  rate: merged.rate,
  extras: merged.extras,
  consumptionHint: merged.consumptionHint,
  totalHint: merged.totalHint,
  trust: merged.trust,
});

await worker.terminate();

const ok = merged.monthKey === "2026-10"
  && merged.current === 14978
  && merged.previous === 14645
  && merged.factor === 1
  && merged.rate === 0.87571
  && merged.extras === 30;
console.log(ok ? "\nPASS scan pipeline" : "\nFAIL scan pipeline");
process.exit(ok ? 0 : 1);
