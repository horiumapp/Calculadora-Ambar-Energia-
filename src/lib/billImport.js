import { createWorker, PSM } from "tesseract.js";
import workerPath from "tesseract.js/dist/worker.min.js?url";
import corePath from "tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url";
import { mergeParsedResults, parseBillText } from "./billParser.js";

let workerPromise = null;

function formatImportError(error) {
  const raw = String(error?.message || error || "").trim();
  if (!raw) return "Não foi possível ler a fatura.";
  if (/networkerror|failed to fetch|importscripts|cdn\.jsdelivr/i.test(raw)) {
    return "Falha ao iniciar o leitor de fatura. Recarregue a página e tente de novo.";
  }
  if (/wasm|webassembly/i.test(raw)) {
    return "Este navegador não conseguiu iniciar o OCR. Tente em outro navegador ou atualize o atual.";
  }
  return raw;
}

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      onProgress?.("Carregando leitor de fatura…");
      const worker = await createWorker("por+eng", 1, {
        workerPath,
        corePath,
        logger: (message) => {
          if (!onProgress) return;
          if (message.status === "loading language traineddata") {
            onProgress("Baixando dicionário OCR (1ª vez)…");
            return;
          }
          if (message.status === "initializing tesseract") {
            onProgress("Inicializando OCR…");
            return;
          }
          if (message.status === "recognizing text") {
            const pct = Math.round((message.progress || 0) * 100);
            onProgress(`Lendo fatura… ${pct}%`);
          }
        },
      });
      return worker;
    })().catch((error) => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

function neutralizeOrangeAndContrast(imageData, { hardBin = false } = {}) {
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];
    if (r > 170 && g > 70 && g < 210 && b < 140) {
      r = g = b = 255;
    }
    let gray = r * 0.299 + g * 0.587 + b * 0.114;
    gray = Math.max(0, Math.min(255, (gray - 35) * (255 / 185)));
    const v = hardBin ? (gray < 155 ? 0 : 255) : gray;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
  return imageData;
}

async function fileToBaseCanvas(file, onProgress) {
  const type = String(file.type || "").toLowerCase();
  const name = String(file.name || "").toLowerCase();
  const isPdf = type === "application/pdf" || name.endsWith(".pdf");

  if (isPdf) {
    onProgress?.("Convertendo PDF…");
    const pdfjs = await import("pdfjs-dist/build/pdf.mjs");
    const workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2.4 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    return canvas;
  }

  onProgress?.("Preparando imagem…");
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const maxSide = 2400;
  const minSide = 1600;
  const longest = Math.max(bitmap.width, bitmap.height);
  let scale = 1;
  if (longest > maxSide) scale = maxSide / longest;
  else if (longest < minSide) scale = minSide / longest;
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas;
}

function cloneProcessedCanvas(sourceCanvas, { hardBin = false } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(sourceCanvas, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  neutralizeOrangeAndContrast(image, { hardBin });
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function cropCanvasRegion(sourceCanvas, y0, y1) {
  const top = Math.max(0, Math.floor(sourceCanvas.height * y0));
  const bottom = Math.min(sourceCanvas.height, Math.ceil(sourceCanvas.height * y1));
  const height = Math.max(1, bottom - top);
  const canvas = document.createElement("canvas");
  canvas.width = sourceCanvas.width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    sourceCanvas,
    0,
    top,
    sourceCanvas.width,
    height,
    0,
    0,
    sourceCanvas.width,
    height,
  );
  return canvas;
}

async function recognizeCanvas(worker, sourceCanvas, { hardBin = false, psm = PSM.AUTO } = {}) {
  const canvas = cloneProcessedCanvas(sourceCanvas, { hardBin });
  await worker.setParameters({
    tessedit_pageseg_mode: psm,
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const result = await worker.recognize(canvas);
  return String(result?.data?.text || "").trim();
}

async function recognizePasses(baseCanvas, worker, onProgress) {
  // Regiões típicas da fatura Amazonas: cabeçalho (mês/total/consumo),
  // meio (leituras) e rodapé (COSIP / A R$).
  const regions = [
    { label: "página inteira", y0: 0, y1: 1, hardBin: false, psm: PSM.AUTO },
    { label: "cabeçalho", y0: 0, y1: 0.42, hardBin: false, psm: PSM.SPARSE_TEXT },
    { label: "medições", y0: 0.22, y1: 0.72, hardBin: true, psm: PSM.SPARSE_TEXT },
    { label: "valores", y0: 0.48, y1: 1, hardBin: false, psm: PSM.AUTO },
  ];

  const texts = [];
  const parsedList = [];
  const total = regions.length;

  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];
    onProgress?.(`Lendo ${region.label}… ${i + 1}/${total}`);
    const source = region.y0 === 0 && region.y1 === 1
      ? baseCanvas
      : cropCanvasRegion(baseCanvas, region.y0, region.y1);
    const text = await recognizeCanvas(worker, source, {
      hardBin: region.hardBin,
      psm: region.psm,
    });
    if (!text) continue;
    texts.push(text);
    parsedList.push(parseBillText(text));
  }

  return { texts, parsedList };
}

/**
 * Lê imagem/PDF da fatura e devolve campos parseados.
 * @param {File} file
 * @param {(status: string) => void} [onProgress]
 */
export async function importBillFromFile(file, onProgress) {
  if (!file) throw new Error("Selecione uma foto ou PDF da fatura.");

  try {
    const baseCanvas = await fileToBaseCanvas(file, onProgress);
    onProgress?.("Iniciando OCR…");
    const worker = await getWorker(onProgress);
    const { texts, parsedList } = await recognizePasses(baseCanvas, worker, onProgress);
    if (!parsedList.length) {
      throw new Error("Não foi possível ler texto na fatura. Tente uma foto mais nítida ou um PDF.");
    }

    const combinedText = texts.join("\n");
    const parsed = mergeParsedResults(parsedList, combinedText);
    parsed.rawPreview = combinedText.slice(0, 800);

    const trustedCore = [
      parsed.trust?.monthKey && parsed.monthKey,
      parsed.trust?.previous && parsed.previous,
      parsed.trust?.current && parsed.current,
      parsed.trust?.rate && parsed.rate,
    ].filter(Boolean).length;

    // Aceita também 2 campos brutos se trust ainda estiver fraco (foto ruim).
    const rawCore = [parsed.monthKey, parsed.previous, parsed.current, parsed.rate]
      .filter((v) => v != null).length;

    if (trustedCore < 1 && rawCore < 2) {
      const err = new Error(
        "A imagem foi lida, mas não deu para identificar os dados com segurança. Tente foto reta e nítida, ou PDF.",
      );
      err.parsed = parsed;
      throw err;
    }
    return parsed;
  } catch (error) {
    if (error?.parsed || /Poucos dados|Não foi possível ler texto|não deu para identificar/i.test(String(error?.message || ""))) {
      throw error;
    }
    throw new Error(formatImportError(error));
  }
}

export async function terminateBillImportWorker() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {
    // ignore
  } finally {
    workerPromise = null;
  }
}
