import { createWorker, PSM } from "tesseract.js";
import { readFileSync, writeFileSync } from "fs";
import jpeg from "jpeg-js";
import { mergeParsedResults, parseBillText } from "../src/lib/billParser.js";

const path = process.argv[2] || "scripts/scan-bill.jpg";
const buf = readFileSync(path);
const raw = jpeg.decode(buf, { useTArray: true });
console.log("image", raw.width, "x", raw.height);

function sample(raw, fx, fy) {
  const x = Math.min(raw.width - 1, Math.max(0, Math.floor(fx)));
  const y = Math.min(raw.height - 1, Math.max(0, Math.floor(fy)));
  const i = (y * raw.width + x) * 4;
  return [raw.data[i], raw.data[i + 1], raw.data[i + 2]];
}

function processRegion(raw, x0, y0, x1, y1, {
  scale = 4,
  thicken = 1,
  invertOrange = true,
  bin = true,
} = {}) {
  const sx0 = Math.floor(raw.width * x0);
  const sy0 = Math.floor(raw.height * y0);
  const sw = Math.ceil(raw.width * (x1 - x0));
  const sh = Math.ceil(raw.height * (y1 - y0));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const gray = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = sx0 + x / scale;
      const fy = sy0 + y / scale;
      let [r, g, b] = sample(raw, fx, fy);
      if (invertOrange && r > 160 && g > 60 && g < 220 && b < 150 && r > b + 40) {
        // texto branco em barra laranja → preto no branco
        const lum = r * 0.299 + g * 0.587 + b * 0.114;
        const v = lum > 200 ? 0 : 255;
        gray[y * w + x] = v;
        continue;
      }
      let v = r * 0.299 + g * 0.587 + b * 0.114;
      // contraste
      v = Math.max(0, Math.min(255, (v - 40) * (255 / 170)));
      gray[y * w + x] = v;
    }
  }

  let outGray = gray;
  if (bin) {
    outGray = new Float32Array(w * h);
    for (let i = 0; i < gray.length; i++) outGray[i] = gray[i] < 145 ? 0 : 255;
  }

  // Engrossa traços pretos (fonte fina da fatura).
  if (thicken > 0) {
    const src = outGray;
    const dst = new Float32Array(w * h);
    dst.set(src);
    for (let t = 0; t < thicken; t++) {
      const cur = t === 0 ? src : dst;
      const next = new Float32Array(w * h);
      next.fill(255);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          let black = false;
          for (let dy = -1; dy <= 1 && !black; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (cur[(y + dy) * w + (x + dx)] < 128) {
                black = true;
                break;
              }
            }
          }
          next[y * w + x] = black ? 0 : 255;
        }
      }
      dst.set(next);
    }
    outGray = dst;
  }

  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = outGray[i];
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return { jpeg: jpeg.encode({ data: rgba, width: w, height: h }, 95).data, w, h };
}

const crops = {
  headerValues: [0.02, 0.12, 0.98, 0.20],
  readingRow: [0.02, 0.52, 0.98, 0.62],
  cosipRow: [0.02, 0.62, 0.98, 0.78],
  topLabels: [0.02, 0.05, 0.98, 0.14],
};

const worker = await createWorker("eng+por");
const texts = [];
const parsedList = [];

for (const [name, box] of Object.entries(crops)) {
  for (const mode of [
    { tag: "thick", thicken: 2, bin: true, scale: 4 },
    { tag: "soft", thicken: 0, bin: false, scale: 3.5 },
  ]) {
    const { jpeg: img } = processRegion(raw, ...box, mode);
    writeFileSync(`scripts/_scan-${name}-${mode.tag}.jpg`, img);
    const whitelist = name === "headerValues" || name === "readingRow"
      ? "0123456789.,/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz "
      : "";
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
      ...(whitelist ? { tessedit_char_whitelist: whitelist } : { tessedit_char_whitelist: "" }),
    });
    const { data: { text } } = await worker.recognize(img);
    console.log(`\n=== ${name}/${mode.tag} ===`);
    console.log(text);
    texts.push(text);
    parsedList.push(parseBillText(text));
  }
}

// full soft
{
  const { jpeg: img } = processRegion(raw, 0, 0, 1, 1, { scale: 2.2, thicken: 1, bin: false });
  writeFileSync("scripts/_scan-full-thick.jpg", img);
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.AUTO,
    tessedit_char_whitelist: "",
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const { data: { text } } = await worker.recognize(img);
  console.log("\n=== full/thick ===");
  console.log(text.slice(0, 1200));
  texts.push(text);
  parsedList.push(parseBillText(text));
}

const merged = mergeParsedResults(parsedList, texts.join("\n"));
console.log("\nMERGED", merged);
await worker.terminate();
