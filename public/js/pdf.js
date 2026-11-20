// Turns PDF flowcharts into page images in the browser, so they go through the same
// compression and AI reading as screenshots. pdf.js only loads when a PDF is added.
// pdf.js 4.4.168 (Mozilla, Apache 2.0) is bundled in public/vendor/pdfjs, so no outside download is needed.
const PDFJS = new URL("../vendor/pdfjs/", import.meta.url);
let lib = null;

async function loadPdfJs() {
  if (lib) return lib;
  lib = await import(new URL("pdf.min.mjs", PDFJS).href);
  lib.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", PDFJS).href;
  return lib;
}

export const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");

/**
 * Render up to maxPages pages of a PDF as PNG files, about 2000 px on the long side.
 * Returns { pages: File[], total } so the page can say when pages were skipped.
 */
export async function pdfToImages(file, maxPages = 6, longSide = 2000) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  const base = (file.name || "flowchart.pdf").replace(/\.pdf$/i, "");
  for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
    const page = await doc.getPage(n);
    const v1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, longSide / Math.max(v1.width, v1.height)) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
    pages.push(new File([blob], `${base} page ${n}.png`, { type: "image/png" }));
    page.cleanup();
  }
  const total = doc.numPages;
  await doc.destroy();
  return { pages, total };
}
