// Prompts sent to Claude, and code that turns its answers into planner rules.
import { norm, makeTerms, buildGraph, emptyRules } from "./planner.js";

const SHAPE = `{"program":"short program name","courses":[{"code":"ME 3370","name":"Fluids","hours":3,"status":"remaining","prereqs":["ME 2322","ME 2301"],"coreqs":[],"hard":false,"easy":false,"offered":"any","kind":"core","check":""}]}`;

const FIELD_RULES = `Field rules:
- code: as printed, like "ME 3370". For a slot with no number (an elective), invent a short unique code such as "DEPT ELEC 1", "HIST ELEC 1", "CREATIVE ARTS".
- name: the course title as printed, expanded from abbreviations when obvious.
- hours: printed credit hours if shown. Otherwise, for 4 digit US course numbers where the second digit is the credit hours (3370 gives 3, 2207 gives 2), use that. Otherwise 3.
- status: "done", "current" (in progress now) or "remaining", following the student's legend.
- prereqs: the course codes listed as prerequisites (often "PR:") or shown by arrows into the box, written exactly as those courses' codes appear in your list.
- coreqs: prerequisites the chart says "may be taken concurrently" with this course. Put those here instead of prereqs.
- hard: true only when the legend says how hard classes are marked and this box is marked that way.
- easy: true only when the student's easy list or legend covers this class.
- offered: "fall" or "spring" only if the chart or the student says the class is only offered then; otherwise "any".
- kind: "core" for courses in the major, "elective" for elective slots and minor classes, "gen" for general education and required courses outside the major.
- check: leave "" when sure. When a box is blurry, cut off, or its color or prerequisites are unclear, write a few words saying what to check.`;

export function readPrompt(settings, imageCount) {
  const s = settings;
  return `You are reading a university student's degree flowchart from ${imageCount} image(s). The images may overlap; list each course once.
The student's current semester is ${s.season} ${s.year}.
${s.legend ? `How the student says to read the chart: ${s.legend}` : `The student gave no legend. Infer status from marks such as grades, checkmarks or highlight colors if the chart has a key; if unsure, use "remaining".`}
${s.easyTxt ? `Classes the student considers easy: ${s.easyTxt}` : ""}

List EVERY course box on the chart, including elective slots and placeholders.
Reply with only JSON in exactly this shape:
${SHAPE}
${FIELD_RULES}
Work carefully: go row by row, left to right, and read every "PR:" line in full. Do not invent courses that are not on the chart.`;
}

export function checkPrompt(settings, list) {
  const slim = list.map(({ code, name, hours, status, prereqs, coreqs, hard, easy, offered, kind, check }) =>
    ({ code, name, hours, status, prereqs, coreqs, hard, easy, offered, kind, check }));
  return `You are checking a list of courses that was read from the attached degree flowchart image(s). Compare it against the images box by box.
Fix: missing course boxes, courses that are not on the chart, wrong codes or names, wrong credit hours, wrong or missing prerequisites (reread every "PR:" line), wrong status by color using this legend: ${settings.legend || "none given"}.
${FIELD_RULES}
Reply with only the corrected JSON: {"courses":[...same shape...],"changes":["short note for each fix"]}. If nothing needs fixing, return the list unchanged with "changes": [].

The list to check:
${JSON.stringify({ courses: slim })}`;
}

export function requestsPrompt(state, text) {
  const T = makeTerms(state.settings);
  const classes = state.courses.filter((c) => c.status !== "done")
    .map((c) => `${c.code}: ${c.name}${c.hard ? " (hard)" : ""}${c.status === "current" ? " (taking now)" : ""}`).join("\n");
  return `A student is planning their remaining semesters. Turn their requests into planner rules.
Their classes (code: name):
${classes}
Semesters in the plan, in order: ${T.map((t) => t.t).join(", ")}. The first one is the current semester and cannot change. "Next semester" means ${(T[1] || T[0]).t}. "Last semester" means ${T[T.length - 1].t}.

The student's requests:
"""${text}"""

Reply with only JSON in this shape:
{"pins":[{"code":"ME 3311","term":"Spring 2027"}],"apart":[{"codes":["ME 2302","ME 3370","ME 3322"],"max":2}],"termLimits":[{"term":"Spring 2029","maxClasses":3,"maxHours":null}],"settings":{"maxHard":null,"semMax":null},"notUnderstood":[]}
Rules:
- Use only codes from the list and semester names exactly as listed. Match classes by name or nickname ("thermo 2" is Thermo II, "dynamics" is the Dynamics class).
- pins: a class the student wants in a specific semester.
- apart: classes that must not all be in the same semester. "max" is how many of them may share a semester (for "not these three together" use 2, for "never together" or "one per semester" use 1).
- termLimits: limits on classes or hours in one semester.
- settings: only fill if the student changes a general rule (max hard classes per semester, max hours per semester). Otherwise null.
- notUnderstood: short phrases for anything you could not turn into a rule.`;
}

/**
 * Apply Claude's parsed requests to the state (replacing earlier typed requests,
 * keeping classes the student dragged). Returns notes about anything skipped.
 */
export function applyRequests(state, r) {
  const T = makeTerms(state.settings), names = new Set(T.slice(1).map((t) => t.t)), { by } = buildGraph(state.courses), notes = [];
  state.pins ||= {}; state.pinSrc ||= {};
  Object.keys(state.pinSrc).forEach((k) => { if (state.pinSrc[k] === "ask") { delete state.pins[k]; delete state.pinSrc[k]; } });
  for (const p of r?.pins || []) {
    const k = norm(p?.code);
    if (!by[k]) { if (k) notes.push(`${k} isn't in your class list`); continue; }
    if (by[k].status !== "remaining") { notes.push(`${k} isn't a class you still need`); continue; }
    if (!names.has(p.term)) { notes.push(`${p.term} isn't one of your upcoming semesters`); continue; }
    state.pins[k] = p.term; state.pinSrc[k] = "ask";
  }
  const rules = emptyRules();
  for (const g of r?.apart || []) {
    const codes = [...new Set((g?.codes || []).map(norm).filter((k) => by[k]))];
    if (codes.length > 1) rules.apart.push({ codes, max: Math.max(1, parseInt(g.max, 10) || 1) });
  }
  for (const x of r?.termLimits || []) {
    if (!x || !names.has(x.term)) continue;
    const maxClasses = x.maxClasses != null && Number.isFinite(+x.maxClasses) ? Math.max(1, parseInt(x.maxClasses, 10)) : null;
    const maxHours = x.maxHours != null && Number.isFinite(+x.maxHours) ? Math.max(0, parseInt(x.maxHours, 10)) : null;
    if (maxClasses != null || maxHours != null) rules.termLimits.push({ term: x.term, maxClasses, maxHours });
  }
  state.rules = rules;
  const so = r?.settings || {};
  if (so.maxHard != null && +so.maxHard > 0) state.settings.maxHard = +so.maxHard;
  if (so.semMax != null && +so.semMax > 0) state.settings.semMax = +so.semMax;
  (r?.notUnderstood || []).forEach((x) => notes.push(`didn't understand "${x}"`));
  return notes;
}
