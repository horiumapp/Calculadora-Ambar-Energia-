import { createWorker } from "tesseract.js";
import { parseBillText } from "./billParser.js";

let workerPromise = null;

async function getWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      const worker = await createWorker("por+eng", 1, {
        logger: (message) => {
          if (!onProgress || message.status !== "recognizing text") return;
          const pct = Math.round((message.progress || 0) * 100);
          onProgress(`Lendo fatura… ${pct}%`);
        },
      });
      return worker;
    })();
  }
  return workerPromise;
}

async function fileToImageSource(file, onProgress) {
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
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas;
  }

  onProgress?.("Preparando imagem…");
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const maxSide = 2000;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas;
}

/**
 * Lê imagem/PDF da fatura e devolve campos parseados.
 * @param {File} file
 * @param {(status: string) => void} [onProgress]
 */
export async function importBillFromFile(file, onProgress) {
  if (!file) throw new Error("Selecione uma foto ou PDF da fatura.");

  const source = await fileToImageSource(file, onProgress);
  onProgress?.("Iniciando OCR…");
  const worker = await getWorker(onProgress);
  const result = await worker.recognize(source);
  const text = result?.data?.text || "";
  if (!text.trim()) {
    throw new Error("Não foi possível ler texto na fatura. Tente uma foto mais nítida.");
  }

  const parsed = parseBillText(text);
  if (parsed.confidence < 0.2) {
    throw new Error("Poucos dados reconhecidos. Confira a foto ou preencha manualmente.");
  }
  return parsed;
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
