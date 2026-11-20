// Reads flowcharts that are pictures: images and PDF pages.
// PDFs with real text use that text directly. Images and scanned PDFs use Tesseract (free, runs in the browser).
import { analyzeCanvas, markBoldByInk, cleanForOcr } from "./boxes.js";
import { leadingCode } from "./parse.js";

const VENDOR = new URL("../../vendor/", import.meta.url);

/* ---------- text recognition (Tesseract) ---------- */
let workerPromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.append(s);
  });
}
async function ocrWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = (async () => {
      if (!globalThis.Tesseract) await loadScript(new URL("tesseract/tesseract.min.js", VENDOR).href);
      return globalThis.Tesseract.createWorker("eng", 1, {
        workerPath: new URL("tesseract/worker.min.js", VENDOR).href,
        corePath: new URL("tesseract/core/", VENDOR).href,
        langPath: new URL("tesseract/lang", VENDOR).href,
        gzip: false,
        logger: (m) => { if (m.status === "recognizing text" && progressHook) progressHook(m.progress); },
      });
    })().catch((e) => { workerPromise = null; throw e; });
  }
  progressHook = onProgress;
  return workerPromise;
}
let progressHook = null;

/** Recognize text and return lines, split wherever there's a wide gap (different boxes on one row). */
async function recognizeLines(canvas, onProgress) {
  const worker = await ocrWorker(onProgress);
  const { canvas: clean, scale } = cleanForOcr(canvas);
  await worker.setParameters({ tessedit_pageseg_mode: "11", preserve_interword_spaces: "1" }); // sparse text: find text anywhere
  const { data } = await worker.recognize(clean, {}, { blocks: true, text: false });
  const words = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) {
    const t = (wd.text || "").trim();
    if (!t) continue;
    words.push({ text: t, conf: wd.confidence, x0: wd.bbox.x0 / scale, y0: wd.bbox.y0 / scale, x1: wd.bbox.x1 / scale, y1: wd.bbox.y1 / scale });
  }
  return wordsToLines(words);
}

/** Specks and border bits that the recognizer reads as letters. */
const isNoise = (w) => {
  const t = w.text.trim();
  if (!t) return true;
  if (/^[^A-Za-z0-9(]+$/.test(t)) return true; // only symbols: | _ — ■
  if (/^[(]?[IVXl1|]{1,3}[)]?$/.test(t)) return false; // roman numerals like "II)" are real text
  if ((w.conf ?? 90) < 35 && t.length <= 3 && !/^\d{4}$/.test(t)) return true;
  return false;
};

/** Join words into lines: same height band, small gaps. Returns [{text, x0,y0,x1,y1, conf}]. */
export function wordsToLines(words) {
  const clean = words.filter((w) => !isNoise(w));
  const heights = clean.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const mh = heights[Math.floor(heights.length / 2)] || 10;
  const sorted = [...clean].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0);
  const rows = [];
  for (const w of sorted) {
    const cy = (w.y0 + w.y1) / 2, hgt = Math.min(w.y1 - w.y0, mh * 1.6);
    const row = rows.find((r) => Math.abs(r.cy - cy) < Math.min(hgt, r.h) * 0.5);
    if (row) { row.items.push(w); row.cy = (row.cy * (row.items.length - 1) + cy) / row.items.length; row.h = Math.max(row.h, hgt); }
    else rows.push({ cy, h: hgt, items: [w] });
  }
  const lines = [];
  for (const r of rows) {
    r.items.sort((a, b) => a.x0 - b.x0);
    let cur = null;
    for (const w of r.items) {
      const gap = cur ? w.x0 - cur.x1 : Infinity;
      if (cur && gap < Math.min(r.h, mh * 1.3) * 1.1) {
        cur.text += (gap > r.h * 0.12 ? " " : "") + w.text;
        cur.x1 = Math.max(cur.x1, w.x1); cur.y0 = Math.min(cur.y0, w.y0); cur.y1 = Math.max(cur.y1, w.y1);
        cur.confs.push(w.conf ?? 90);
      } else {
        cur = { text: w.text, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, confs: [w.conf ?? 90], bold: !!w.bold };
        lines.push(cur);
      }
    }
  }
  return lines.map((l) => ({ ...l, text: fixOcrText(l.text), conf: l.confs.reduce((a, b) => a + b, 0) / l.confs.length }));
}

/** Common recognition slips in flowcharts: roman numerals and stray marks. */
export function fixOcrText(t) {
  return t
    .replace(/[|]/g, " ")
    .replace(/\b(CAL|PHYS|CHEM|THERMO|DESIGN|CALC|CALCULUS|PHYSICS|CHEMISTRY|ENGL|COMP|ORGANIC|STATICS|DYNAMICS)\s*([Il1|!ti]{1,3})(?=[)\s]|$)/gi,
      (m, word, num) => `${word} ${"I".repeat(Math.min(3, num.length))}`)
    .replace(/\bPR[.,;]\s/g, "PR: ")
    .replace(/([A-Z])(ELEC(?:TIVE)?S?)\b/g, "$1 $2")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Text lines plus their boxes, colors and bold, as engine blocks. */
function linesToBlocks(lines, canvas, page, boldKnown) {
  const { locate } = analyzeCanvas(canvas);
  const blocks = lines.map((l) => {
    const where = locate(l);
    const title = !!leadingCode(l.text);
    return {
      text: l.text, page, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1,
      fill: where.fill, box: where.box != null ? `p${page}b${where.box}` : null, boxRect: where.boxRect,
      ink: where.ink, title, bold: boldKnown ? !!l.bold : false, lowConfidence: l.conf != null && l.conf < 70,
    };
  });
  if (!boldKnown) markBoldByInk(blocks);
  return blocks;
}

/* ---------- images ---------- */
export const isImage = (f) => /^image\/(png|jpe?g|webp|gif|bmp)$/.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name || "");

async function fileToCanvas(file, maxSide = 3600) {
  const img = await createImageBitmap(file);
  const sc = Math.min(1, maxSide / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

export async function readImage(file, page, onProgress) {
  const canvas = await fileToCanvas(file);
  const lines = await recognizeLines(canvas, onProgress);
  return { blocks: linesToBlocks(lines, canvas, page, false), units: "pixels", preview: canvas };
}

/* ---------- PDFs ---------- */
export const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
let pdfjs = null;
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import(new URL("pdfjs/pdf.min.mjs", VENDOR).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs/pdf.worker.min.mjs", VENDOR).href;
  return pdfjs;
}

export async function readPdf(file, firstPage, onProgress, maxPages = 6) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const results = [];
  const pages = Math.min(doc.numPages, maxPages);
  for (let n = 1; n <= pages; n++) {
    const page = await doc.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, 2400 / Math.max(v1.width, v1.height)) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const content = await page.getTextContent();
    const items = content.items.filter((it) => it.str && it.str.trim());
    let lines, boldKnown = false;
    if (items.reduce((a, it) => a + it.str.trim().length, 0) < 30) {
      lines = await recognizeLines(canvas, (p) => onProgress?.((n - 1 + p) / pages)); // scanned page: no real text
    } else {
      const fontIsBold = (name) => {
        try { const f = page.commonObjs.get(name); return /bold|black|heavy|semibold|demi/i.test(`${f?.name || ""} ${f?.loadedName || ""}`); } catch { return null; }
      };
      const words = items.map((it) => {
        const t = it.transform, fh = Math.hypot(t[2], t[3]) * viewport.scale;
        const [x, y] = viewport.convertToViewportPoint(t[4], t[5]);
        const style = content.styles[it.fontName] || {};
        const bold = fontIsBold(it.fontName) ?? /bold/i.test(style.fontFamily || "");
        return { text: it.str.trim(), x0: x, y0: y - fh * 0.85, x1: x + it.width * viewport.scale, y1: y + fh * 0.15, bold, conf: 99 };
      });
      boldKnown = words.some((w) => w.bold);
      lines = wordsToLines(words).map((l) => ({ ...l, bold: words.some((w) => w.bold && w.x0 >= l.x0 - 1 && w.x1 <= l.x1 + 1 && w.y0 >= l.y0 - 2 && w.y1 <= l.y1 + 2 && leadingCode(w.text)) || false }));
      onProgress?.(n / pages);
    }
    results.push({ blocks: linesToBlocks(lines, canvas, firstPage + n - 1, boldKnown), units: "pixels", preview: canvas, page: firstPage + n - 1 });
    page.cleanup();
  }
  const total = doc.numPages;
  await doc.destroy();
  return { pages: results, total };
}
