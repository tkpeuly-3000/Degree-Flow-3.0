// Degree Flow reading engine: reads flowcharts from Excel, CSV, PDF and image files, for free, in the browser.
import { readCourses } from "./parse.js";
import { clusterColors } from "./colors.js";
import { isExcel, isOldExcel, isCsv, readExcel, readCsv } from "./excel.js";
import { isPdf, isImage, readPdf, readImage } from "./picture.js";

export { isExcel, isOldExcel, isCsv, isPdf, isImage };
export const isSupported = (f) => isExcel(f) || isCsv(f) || isPdf(f) || isImage(f);

/**
 * Merge classes read from several pages or screenshots. The same code on two pages is one class.
 * Screenshots often overlap: electives in the overlapping strip of a later page are the same slots again.
 */
export function mergePages(results) {
  const out = [], byCode = new Map();
  results.forEach((res, idx) => {
    const repeats = res.courses.filter((c) => byCode.has(c.code) && c.kind !== "elective");
    const overlapBottom = repeats.length ? Math.max(...repeats.map((c) => c.where.y1)) : -Infinity;
    for (const c of res.courses) {
      if (c.kind === "elective" && idx > 0 && c.where.y1 <= overlapBottom + 2) continue;
      const base = c.kind === "elective" ? c.code.replace(/\s\d+$/, "") : c.code;
      if (c.kind !== "elective" && byCode.has(base)) {
        const old = byCode.get(base);
        old.prereqs = [...new Set([...old.prereqs, ...c.prereqs])];
        old.coreqs = [...new Set([...old.coreqs, ...c.coreqs])].filter((x) => !old.prereqs.includes(x));
        if (!old.fill && c.fill) old.fill = c.fill;
        old.bold ||= c.bold;
        continue;
      }
      const copy = { ...c, code: base };
      out.push(copy);
      if (c.kind !== "elective") byCode.set(base, copy);
    }
  });
  // renumber electives across pages
  const counts = {}, seen = {};
  out.forEach((c) => { if (c.kind === "elective") counts[c.code] = (counts[c.code] || 0) + 1; });
  out.forEach((c) => { if (c.kind === "elective" && counts[c.code] > 1) { seen[c.code] = (seen[c.code] || 0) + 1; c.code = `${c.code} ${seen[c.code]}`; } });
  // shared color groups across all pages
  const filled = out.map((c, i) => [c.fill, i]).filter(([f]) => f);
  const palette = clusterColors(filled.map(([f]) => f)).map((g) => ({ hex: g.hex, name: g.name, courses: g.members.map((m) => out[filled[m][1]].code) }));
  out.forEach((c) => { c.color = c.fill ? palette.find((p) => p.courses.includes(c.code))?.hex || null : null; });
  return { courses: out, palette };
}

/**
 * Read one or more files. onProgress(message, fraction) reports what's happening.
 * Returns { courses, palette, previews, notes }.
 */
export async function readFlowchart(files, onProgress = () => {}) {
  const results = [], previews = [], notes = [];
  let page = 0;
  const list = [...files];
  for (let i = 0; i < list.length; i++) {
    const f = list[i], label = f.name || `file ${i + 1}`;
    const step = (p) => onProgress(`Reading ${label}`, (i + Math.max(0, Math.min(1, p))) / list.length);
    step(0);
    if (isOldExcel(f) && !isExcel(f)) { notes.push(`${label} is an old .xls file. Open it in Excel or Google Sheets and save it as .xlsx, then add it again.`); continue; }
    if (isExcel(f) || isCsv(f)) {
      const { blocks } = await (isExcel(f) ? readExcel(f) : readCsv(f));
      const sheets = [...new Set(blocks.map((b) => b.page))];
      for (const s of sheets) {
        const r = readCourses(blocks.filter((b) => b.page === s), { units: "cells" });
        if (r.courses.length) results.push(r);
      }
      step(1);
    } else if (isPdf(f)) {
      const { pages, total } = await readPdf(f, page, step);
      pages.forEach((p) => { results.push(readCourses(p.blocks, { units: "pixels" })); previews.push(p.preview); });
      page += pages.length;
      if (total > pages.length) notes.push(`${label} has ${total} pages; only the first ${pages.length} were read.`);
    } else if (isImage(f)) {
      onProgress(`Recognizing text in ${label}. The first time takes a little longer.`, i / list.length);
      const r = await readImage(f, page, step);
      results.push(readCourses(r.blocks, { units: "pixels" }));
      previews.push(r.preview);
      page++;
    } else {
      notes.push(`${label} isn't a PDF, Excel, CSV or image file.`);
    }
  }
  const merged = mergePages(results.filter((r) => r.courses.length));
  if (!merged.courses.length) notes.push("No classes were found. The chart needs course codes like ME 3370 or MATH 1451.");
  onProgress("Done", 1);
  return { ...merged, previews, notes };
}
