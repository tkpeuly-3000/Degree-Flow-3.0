// The reading rules. Turns text pieces from any file (Excel cells, PDF text, recognized image text)
// into classes, the way a person reads a degree flowchart:
//   a box starting with a course code (or an elective title) is a class,
//   the other text in that box is its name,
//   "PR:" lines right under the box are its prerequisites ("may be taken concurrently" means same term OK).
//
// A block is { text, x0, y0, x1, y1, page, fill: "#RRGGBB" | null, bold: bool, box: id | null }.
// Units: Excel blocks use columns and rows; PDF and image blocks use pixels.
import { clusterColors, colorDistance, hexToRgb } from "./colors.js";

const DEPT = "[A-Z]{2,5}";
// OCR sometimes reads 0 as O, 1 as I or l, 5 as S. Accept those inside course numbers and fix them.
const NUM = "[0-9OoIlS]{4}";
const CODE_START = new RegExp(`^[\\s*•(]*(${DEPT})\\s*[-–]?\\s*(${NUM})(?![0-9])`);
const CODE_ANY = new RegExp(`\\b(${DEPT})?\\s*[-–]?\\s*(${NUM})(?![0-9])`, "g");
const PR_START = /^\s*(p\s*\.?\s*r\s*\.?\s*[:;.]|pr\s+(?=[A-Z]{2,5}\s*[-–]?\s*[0-9OIlS]{4})|pre\s*-?\s*req(uisite)?s?\b|prereq)/i;
const GRADE = /^\s*[A-DF][+-]?\s*$/;
const ELECTIVE = /ELEC(?:TIVE)?S?\b/i;
const NOT_A_TITLE = /^\s*([({\[]|choose|select|pick|students?\b|\*|note|see\b|may\b|one of)/i;
const FIX_DIGIT = { O: "0", o: "0", I: "1", l: "1", S: "5" };
const TERM_LABEL = /^\s*(fall|spring|summer|winter)\s*'?\d{2,4}\b/i;

const cleanNum = (n) => n.replace(/[OoIlS]/g, (c) => FIX_DIGIT[c]);
const isRealNum = (n) => /\d/.test(n) && /^\d{4}$/.test(cleanNum(n));
/** Two fills match if both are empty or they look like the same color. */
const sameFill = (f, g) => (!f && !g) || (!!f && !!g && colorDistance(hexToRgb(f), hexToRgb(g)) < 60);
const squash = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** Course code at the start of a line, like "ME 3370" from "ME 3370 (FLUIDS)". */
export function leadingCode(text) {
  const m = squash(text).match(CODE_START);
  if (!m || !isRealNum(m[2])) return null;
  const n = cleanNum(m[2]);
  if (/^(19|20)\d\d$/.test(n) && /^(FALL|SPRING|SUMMER|WINTER|SPR|FA|SP|SU|FAL|SUM|YEAR|CLASS|AY)$/i.test(m[1])) return null; // "Fall 2026"
  return { code: `${m[1].toUpperCase()} ${n}`, fixed: n !== m[2] };
}

/**
 * Course codes in a prerequisite line. A bare number borrows the department before it:
 * "ME 3303, 3370" gives ME 3303 and ME 3370; "CHEM 1307/1107" gives CHEM 1307 and CHEM 1107.
 */
export function codesIn(text, lastDept = null) {
  const out = [];
  const t = squash(text).replace(/\bPR\s*[:;.]?/gi, " ");
  for (const m of t.matchAll(CODE_ANY)) {
    const [, dept, num] = m;
    if (!isRealNum(num)) continue;
    const d = dept ? dept.toUpperCase() : lastDept;
    if (!d) continue;
    if (dept && /^(OR|AND|THE|FROM|WITH|TAKE|MAY|BE|EITHER|ANY)$/i.test(dept)) { if (lastDept) out.push(`${lastDept} ${cleanNum(num)}`); continue; }
    out.push(`${d} ${cleanNum(num)}`);
    lastDept = d;
  }
  return out;
}

/** Split prerequisite text into normal and "same term OK" codes. */
export function parsePrereqText(text) {
  const prereqs = [], coreqs = [];
  // Each "PR:" starts a new rule; "(may be taken concurrently)" applies to its own rule only.
  const parts = squash(text).split(/\bP\s*\.?\s*R\s*\.?\s*[:;]|\bPR\s+(?=[A-Z]{2,5}\s*\d)/i).map(squash).filter(Boolean);
  let dept = null;
  for (const part of parts.length ? parts : [squash(text)]) {
    const same = /concurren|same\s+(term|semester)|co-?req/i.test(part);
    const codes = codesIn(part.replace(/\(may be taken as [^)]*\)/gi, " "), dept);
    if (codes.length) dept = codes[codes.length - 1].split(" ")[0];
    (same ? coreqs : prereqs).push(...codes);
  }
  return { prereqs: [...new Set(prereqs)], coreqs: [...new Set(coreqs.filter((c) => !prereqs.includes(c)))] };
}

const overlapX = (a, b) => {
  const o = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  return o / Math.max(1, Math.min(a.x1 - a.x0, b.x1 - b.x0));
};
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** Name text for a class: drop parentheses and the code, keep it readable. */
function cleanName(lines, code) {
  let t = squash(lines.join(" "));
  if (code) t = t.replace(new RegExp(`^${code.replace(" ", "\\s*[-–]?\\s*")}`, "i"), "");
  t = squash(t.replace(/^[\s(]+|[\s)]+$/g, "").replace(/\)\s*\(/g, ", "));
  return t || code || "";
}

/**
 * Read classes out of blocks.
 * @param {Array} blocks
 * @param {object} opts  { units: "cells" | "pixels" }
 * @returns {{ courses: Array, palette: Array, notes: string[] }}
 */
export function readCourses(blocks, { units = "pixels" } = {}) {
  const B = blocks
    .map((b, i) => ({ ...b, i, text: squash(b.text), page: b.page || 0 }))
    .filter((b) => b.text || b.fill);
  const lineH = units === "cells" ? 1 : Math.max(6, median(B.filter((b) => b.text).map((b) => b.y1 - b.y0)) || 12);
  const contGap = units === "cells" ? 0.01 : lineH * 1.1; // gap allowed between lines of the same box
  const prGap = units === "cells" ? 1.01 : lineH * 3.2; // how far below a box its "PR:" line may start
  const below = (a, b, gap) => b.page === a.page && b.y0 >= a.y1 - lineH * 0.3 && b.y0 - a.y1 <= gap && overlapX(a, b) >= 0.3;
  /** True when a code line has its own name under it, so it starts a new class (cells touching, or close text). */
  const hasNameBelow = (c) => B.some((b) => b !== c && b.page === c.page && b.kind === "text" && !/\d{4}/.test(b.text) && !TERM_LABEL.test(b.text) &&
    !PR_START.test(b.text) && overlapX(c, b) >= 0.5 && b.y0 >= c.y1 - lineH * 0.3 &&
    (units === "cells" ? b.y0 - c.y1 <= contGap : (b.boxRect && c.boxRect ? b.boxRect.y0 - c.boxRect.y1 <= lineH * 0.6 && b.y0 - c.y1 <= lineH * 3 : b.y0 - c.y1 <= lineH * 2.2)));

  const kindOf = (b) => {
    if (!b.text || GRADE.test(b.text)) return "empty";
    if (PR_START.test(b.text)) return "pr";
    const lc = leadingCode(b.text);
    if (lc && b.text.length <= 80) return "code";
    if (ELECTIVE.test(b.text) && !NOT_A_TITLE.test(b.text) && b.text.length <= 48 && !codesIn(b.text).length &&
      !/^[a-z]/.test(b.text) && !/\b(will|need|must|from the|available|qualifying|wishing|required|approved)\b/i.test(b.text)) return "elective";
    return "text";
  };
  B.forEach((b) => { b.kind = kindOf(b); });
  const used = new Set();
  const courses = [], notes = [];
  const titleOrder = [...B].filter((b) => b.kind === "code" || b.kind === "elective").sort((a, b) => a.page - b.page || a.y0 - b.y0 || a.x0 - b.x0);

  for (const a of titleOrder) {
    if (used.has(a.i)) continue;
    // 1. The box: text sharing the detected box, or lines stacked right under the title.
    let members;
    if (a.box != null) {
      members = B.filter((b) => b.page === a.page && b.box === a.box && b.kind !== "pr");
      // Another title inside the same box (e.g. "HIST 2300" in "Choose from HIST 2300...") is description, not a class.
    } else {
      members = [a];
      let cur = a;
      for (;;) {
        const next = B.filter((b) => !used.has(b.i) && b !== cur && below(cur, b, contGap) && overlapX(a, b) >= 0.5)
          .sort((x, y) => x.y0 - y.y0)[0];
        if (!next || next.kind === "pr" || next.kind === "code" || (next.kind === "elective" && !a.fill) || !sameFill(next.fill, a.fill)) break;
        members.push(next); cur = next;
      }
    }
    members = members.filter((b) => b.y0 >= a.y0 - lineH * 0.6 && !used.has(b.i));
    if (!members.includes(a)) members.unshift(a);
    members.forEach((b) => used.add(b.i));
    // The name can sit in its own cell right under the code (common in PDFs exported from Excel).
    const sameColor = (b) => sameFill(b.fill, a.fill);
    const nameGap = units === "cells" ? contGap : lineH * 2.2;
    const addWithBox = (n) => {
      const extra = n.box != null ? B.filter((b) => b.box === n.box && b.page === n.page && !used.has(b.i) && b.kind !== "pr" && b.kind !== "code") : [n];
      if (!extra.includes(n)) extra.push(n);
      extra.forEach((b) => { used.add(b.i); members.push(b); });
    };
    // When cells are detected, touching cells count as close no matter how far apart their text is.
    const top = (b) => (b.boxRect ? b.boxRect.y0 : b.y0), bot = (b) => (b.boxRect ? b.boxRect.y1 : b.y1);
    for (let guard = 0; guard < 6; guard++) {
      const bottom = members.reduce((m, b) => (b.y1 > m.y1 ? b : m), a);
      const near = (b) => (b.boxRect && bottom.boxRect ? top(b) - bot(bottom) <= lineH * 0.6 : b.y0 - bottom.y1 <= nameGap);
      const next = B.filter((b) => !used.has(b.i) && b.page === a.page && b.y0 >= bottom.y1 - lineH * 0.3 && near(b) && overlapX(a, b) >= 0.5)
        .sort((x, y) => x.y0 - y.y0)[0];
      if (!next || next.kind !== "text" || !sameColor(next) || TERM_LABEL.test(next.text) || /^\s*(choose|select)\b/i.test(next.text) && a.kind === "code") break;
      addWithBox(next);
    }
    // An elective title can wrap: "CREATIVE ARTS" above "ELECTIVE" in the same box.
    let titleText = a.text;
    if (a.kind === "elective") {
      const above = B.filter((b) => !used.has(b.i) && b.page === a.page && b.kind === "text" && sameColor(b) && b.y1 <= a.y0 + lineH * 0.3 &&
        a.y0 - b.y1 <= (units === "cells" ? contGap : lineH * 0.9) && overlapX(a, b) >= 0.5 && (a.box == null || b.box === a.box) && b.text.length <= 30 && !TERM_LABEL.test(b.text));
      above.sort((x, y) => x.y0 - y.y0).forEach((b) => { used.add(b.i); titleText = `${b.text} ${titleText}`; });
    }
    members.sort((x, y) => x.y0 - y.y0 || x.x0 - y.x0);
    const box = {
      page: a.page,
      x0: Math.min(...members.map((b) => b.x0)), x1: Math.max(...members.map((b) => b.x1)),
      y0: Math.min(...members.map((b) => b.y0)), y1: Math.max(...members.map((b) => (b.boxRect && b.box != null ? Math.max(b.y1, b.boxRect.y1) : b.y1))),
    };
    if (a.box != null && a.boxRect && members.every((b) => b.box === a.box)) Object.assign(box, a.boxRect);

    // 2. Prerequisites: "PR:" lines just under the box, plus lines that continue them.
    const prLines = [];
    let first = B.filter((b) => b.kind === "pr" && !used.has(b.i) && below(box, b, prGap)).sort((x, y) => x.y0 - y.y0)[0];
    // A "PR:" label can get lost in a picture. A bare code line right under the box, with no color and
    // no name of its own, is still a prerequisite.
    if (!first && units === "pixels") {
      const cand = B.filter((b) => b.kind === "code" && !used.has(b.i) && !b.fill && below(box, b, lineH * 1.6)).sort((x, y) => x.y0 - y.y0)[0];
      if (cand && !hasNameBelow(cand)) first = cand;
    }
    if (first) {
      let cur = first;
      prLines.push(cur); used.add(cur.i);
      for (;;) {
        const next = B.filter((b) => !used.has(b.i) && below(cur, b, contGap * 1.2) && overlapX(first, b) >= 0.3 && !b.fill)
          .sort((x, y) => x.y0 - y.y0)[0];
        if (!next || next.kind === "elective" || TERM_LABEL.test(next.text)) break;
        // Plain text continues a rule only if it holds course numbers or the "concurrently" note.
        if (next.kind === "text" && !/\d{4}|concurren|taken|may be|same (term|semester)/i.test(next.text)) break;
        // A line starting with a code continues the rule ("PHYS 1408" on its own line)
        // unless it starts a new box: it has a color, its own box, or a name right under it.
        if (next.kind === "code" && (next.fill || hasNameBelow(next))) break;
        prLines.push(next); used.add(next.i); cur = next;
      }
    }

    const all = members.map((b) => b.text).join(" ");
    let code, name, hours, kind, fixed = false;
    if (a.kind === "code") {
      const lc = leadingCode(titleText);
      code = lc.code; fixed = lc.fixed;
      const rest = members.map((b) => (b === a ? b.text.replace(CODE_START, "") : b.text)).filter((t) => squash(t) && !/^choose|^select/i.test(t));
      name = cleanName(rest, null) || code;
      const d = +code.split(" ")[1][1];
      hours = d >= 1 && d <= 6 ? d : 3;
    } else {
      const title = squash(titleText.replace(/[()]/g, " "));
      code = title.toUpperCase().replace(/[^A-Z0-9/& ]/g, "").replace(/\s+/g, " ").trim();
      const desc = members.filter((b) => b !== a).map((b) => b.text).join(" ");
      // The card already shows the title as its code, so the name carries the helpful part.
      const choose = desc.match(/(choose|select|pick)[^)]*/i);
      name = choose ? squash(choose[0]) : squash(desc.replace(/[()]/g, "")) || title;
      hours = 3;
      kind = "elective";
    }
    const pr = parsePrereqText(prLines.map((b) => b.text).join(" "));
    const offered = /fall\s+only|offered\s+(in\s+)?fall\b/i.test(all) ? "fall" : /spring\s+only|offered\s+(in\s+)?spring\b/i.test(all) ? "spring" : "any";
    const check = [
      fixed ? "code was hard to read" : "",
      prLines.length && !pr.prereqs.length && !pr.coreqs.length && /\d/.test(prLines.map((b) => b.text).join(" ")) ? "prerequisites unclear" : "",
      a.lowConfidence ? "code was hard to read" : "",
      members.some((b) => b !== a && b.lowConfidence) ? "name may be misread" : "",
    ].filter(Boolean).join(", ");
    courses.push({
      code, name, hours, prereqs: pr.prereqs, coreqs: pr.coreqs, offered, kind: kind || null,
      fill: a.fill || members.find((b) => b.fill)?.fill || null, bold: !!a.bold, check,
      where: { page: box.page, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1 },
    });
  }

  // Number repeated elective slots: DEPT ELECTIVE 1, DEPT ELECTIVE 2...
  const counts = {};
  courses.forEach((c) => { counts[c.code] = (counts[c.code] || 0) + 1; });
  const seen = {};
  courses.forEach((c) => {
    if (counts[c.code] > 1) {
      seen[c.code] = (seen[c.code] || 0) + 1;
      if (c.kind === "elective") c.code = `${c.code} ${seen[c.code]}`;
      else if (seen[c.code] > 1) { c.code = `${c.code} ${seen[c.code]}`; c.check = [c.check, "same code as another class: check the number"].filter(Boolean).join(", "); }
    }
  });

  // Major = the department with the most classes; its classes are "core", others "gen".
  const depts = {};
  courses.filter((c) => c.kind !== "elective").forEach((c) => { const d = c.code.split(" ")[0]; depts[d] = (depts[d] || 0) + 1; });
  const major = Object.entries(depts).sort((a, b) => b[1] - a[1])[0]?.[0];
  courses.forEach((c) => { if (!c.kind) c.kind = c.code.split(" ")[0] === major ? "core" : "gen"; });

  // Colors used by classes, grouped so near identical shades count as one.
  const filled = courses.map((c, i) => [c.fill, i]).filter(([f]) => f);
  const palette = clusterColors(filled.map(([f]) => f)).map((g) => ({
    hex: g.hex, name: g.name, courses: g.members.map((m) => courses[filled[m][1]].code),
  }));
  courses.forEach((c) => {
    c.color = c.fill ? palette.find((p) => p.courses.includes(c.code))?.hex || null : null;
  });
  if (!courses.length) notes.push("No classes were found. Check that the file shows course codes like ME 3370.");
  return { courses, palette, notes };
}
