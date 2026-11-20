// Reads Excel flowcharts cell by cell: exact text, fill color, bold, and merged cells.
// ExcelJS (MIT) is bundled in public/vendor/exceljs and only loads when a spreadsheet is added.
import { excelColor, themeFromXml, isNearWhite, hexToRgb } from "./colors.js";

let loading = null;
function loadExcelJS() {
  if (globalThis.ExcelJS) return Promise.resolve(globalThis.ExcelJS);
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("../../vendor/exceljs/exceljs.min.js", import.meta.url).href;
    s.onload = () => resolve(globalThis.ExcelJS);
    s.onerror = () => { loading = null; reject(new Error("Couldn't load the spreadsheet reader")); };
    document.head.append(s);
  });
  return loading;
}

export const isExcel = (f) => /\.xlsx$/i.test(f.name || "") || f.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const isOldExcel = (f) => /\.xls$/i.test(f.name || "") || f.type === "application/vnd.ms-excel";
export const isCsv = (f) => /\.csv$/i.test(f.name || "") || f.type === "text/csv";

const rangeOf = (ref) => {
  const m = String(ref).match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!m) return null;
  const col = (s) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  return { c0: col(m[1]), r0: +m[2], c1: col(m[3]), r1: +m[4] };
};

function cellText(cell) {
  try {
    const t = cell.text;
    if (t != null && String(t).trim()) return String(t);
  } catch {}
  const v = cell.value;
  if (v && typeof v === "object" && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  return v == null ? "" : String(v);
}

/** Blocks from an ExcelJS workbook (works in the browser and in Node tests). */
export function blocksFromWorkbook(wb) {
  const themeXml = wb._themes && Object.values(wb._themes)[0];
  const theme = themeFromXml(typeof themeXml === "string" ? themeXml : null);
  const blocks = [];
  let page = 0;
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== "visible") return;
    const merges = (ws.model?.merges || []).map(rangeOf).filter(Boolean);
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        const inMerge = merges.find((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1);
        if (inMerge && (inMerge.r0 !== r || inMerge.c0 !== c)) return; // only the top left cell of a merged area holds the content
        const text = cellText(cell).replace(/\r/g, "");
        const f = cell.fill;
        let fill = f && f.type === "pattern" && f.pattern && f.pattern !== "none" ? excelColor(f.fgColor, theme) : null;
        if (fill && isNearWhite(hexToRgb(fill))) fill = null;
        if (!text.trim()) return;
        const span = inMerge || { c0: c, r0: r, c1: c, r1: r };
        // A cell can hold several lines; each becomes its own block, stacked inside the cell.
        const lines = text.split("\n").map((t) => t.trim()).filter(Boolean);
        const h = (span.r1 - span.r0 + 1) / lines.length;
        lines.forEach((t, k) => blocks.push({
          text: t, page, fill, bold: !!cell.font?.bold,
          x0: span.c0, x1: span.c1 + 1, y0: span.r0 + k * h, y1: span.r0 + (k + 1) * h,
          box: lines.length > 1 ? `p${page}r${r}c${c}` : null,
        }));
      });
    });
    page++;
  });
  return blocks;
}

export async function readExcel(file) {
  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  return { blocks: blocksFromWorkbook(wb), units: "cells" };
}

/** CSV has no colors; each cell becomes a block on a grid. */
export async function readCsv(file) {
  const text = await file.text();
  const blocks = [];
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  rows.forEach((r, ri) => r.forEach((t, ci) => {
    t.split("\n").map((x) => x.trim()).filter(Boolean).forEach((line, k, all) => blocks.push({
      text: line, page: 0, fill: null, bold: false, x0: ci + 1, x1: ci + 2, y0: ri + 1 + k / all.length, y1: ri + 1 + (k + 1) / all.length, box: all.length > 1 ? `r${ri}c${ci}` : null,
    }));
  }));
  return { blocks, units: "cells" };
}
