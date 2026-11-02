import { createWorker } from "tesseract.js";
import workerPath from "tesseract.js/dist/worker.min.js?url";
import corePath from "tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url";
import { parseBillText } from "./billParser.js";

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
        // Idioma: tesseract busca sozinho em cdn.jsdelivr.net/@tesseract.js-data (connect-src).
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
    await page.render({ canvasContext: context, viewport, canvas }).promise;
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
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
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

  try {
    const source = await fileToImageSource(file, onProgress);
    onProgress?.("Iniciando OCR…");
    const worker = await getWorker(onProgress);
    const result = await worker.recognize(source);
    const text = result?.data?.text || "";
    if (!text.trim()) {
      throw new Error("Não foi possível ler texto na fatura. Tente uma foto mais nítida ou um PDF.");
    }

    const parsed = parseBillText(text);
    const coreFound = [parsed.monthKey, parsed.previous, parsed.current, parsed.rate]
      .filter((v) => v != null).length;
    if (coreFound < 2) {
      const err = new Error(
        "A imagem foi lida, mas não deu para identificar os dados com segurança. Veja o texto reconhecido e preencha manualmente o que faltar.",
      );
      err.parsed = parsed;
      err.ocrText = text.slice(0, 600);
      throw err;
    }
    return parsed;
  } catch (error) {
    if (error?.parsed || /Poucos dados|Não foi possível ler texto/i.test(String(error?.message || ""))) {
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
