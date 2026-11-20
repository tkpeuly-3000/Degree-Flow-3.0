// Optional: typed plan requests ("put Material Science in Spring 2027") turned into planner rules by Claude.
// Only used when the site owner turns the AI on; the app works fully without it.
import { norm, makeTerms, buildGraph, emptyRules } from "./planner.js";

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
