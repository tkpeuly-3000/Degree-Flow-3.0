// Degree Flow planner: pure logic with no DOM, so it runs in the browser and in Node tests.
//
// A plan "state" looks like:
// {
//   settings: { season, year, left, summers, summerMax, semMax, yearTarget, earned, maxHard, legend, easyTxt, extra },
//   courses:  [{ code, name, hours, status: "done"|"current"|"remaining", prereqs:[], coreqs:[], hard, easy, offered: "any"|"fall"|"spring", kind: "core"|"elective"|"gen", check }],
//   pins:     { [code]: "Spring 2027" },           // classes the student placed on purpose
//   rules:    { apart: [{codes, max}], termLimits: [{term, maxClasses, maxHours}] }
// }
// A "place" maps each class code to a semester index: 0 is the current semester,
// terms.length means "doesn't fit yet".

export const DEFAULT_SETTINGS = Object.freeze({
  season: "Fall", year: new Date().getFullYear(), left: 5, summers: true, summerMax: 6, semMax: 18,
  yearTarget: 30, earned: 0, maxHard: 2, easyTxt: "", extra: 0, degreeTotal: 0,
});

export const emptyRules = () => ({ apart: [], termLimits: [] });

/** Uppercase a course code and collapse dashes and spaces: "me-3370 " becomes "ME 3370". */
export const norm = (s) => String(s ?? "").toUpperCase().replace(/[‐-―-]/g, " ").replace(/\s+/g, " ").trim();

/** Validate and tidy a course list from the AI, a file, or the edit table. */
export function cleanCourses(list) {
  const seen = new Set(), out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== "object") continue;
    const code = norm(c.code);
    if (!code) continue;
    let k = code, i = 2;
    while (seen.has(k)) k = `${code} ${i++}`;
    seen.add(k);
    const status = ["done", "current", "remaining"].includes(c.status) ? c.status : "remaining";
    const off = String(c.offered ?? "").toLowerCase();
    const h = Number(c.hours);
    const codes = (v) => [...new Set((Array.isArray(v) ? v : String(v ?? "").split(",")).map(norm).filter(Boolean))].filter((x) => x !== k);
    out.push({
      code: k,
      name: String(c.name ?? "").trim() || k,
      hours: Number.isFinite(h) && h >= 0 && h <= 12 ? h : 3,
      status,
      prereqs: codes(c.prereqs),
      coreqs: codes(c.coreqs),
      hard: !!c.hard,
      easy: !!c.easy,
      offered: off === "fall" || off === "spring" ? off : "any",
      kind: ["core", "elective", "gen"].includes(c.kind) ? c.kind : "core",
      check: String(c.check ?? "").slice(0, 160),
      tag: String(c.tag ?? "").trim().slice(0, 40),
    });
  }
  return out;
}

/** The semesters on the board: the current one, then fall/spring (and summers if allowed). */
export function makeTerms(settings) {
  const st = { ...DEFAULT_SETTINGS, ...settings };
  const terms = [{ s: st.season, y: +st.year, cur: true }];
  let s = st.season, y = +st.year, reg = 0;
  const want = Math.max(0, (+st.left || 0) + (+st.extra || 0));
  while (reg < want) {
    if (s === "Fall") { s = "Spring"; y++; }
    else if (s === "Spring") s = st.summers ? "Summer" : "Fall";
    else s = "Fall";
    terms.push({ s, y });
    if (s !== "Summer") reg++;
  }
  return terms.map((t, i) => ({ ...t, cur: !!t.cur, t: `${t.s} ${t.y}`, i }));
}

/** Academic year a semester belongs to (Fall 2026, Spring 2027 and Summer 2027 are all 2026). */
export const academicYear = (t) => (t.s === "Fall" ? t.y : t.y - 1);
export const academicYearLabel = (k) => `${k}/${String((k + 1) % 100).padStart(2, "0")}`;

/** Prerequisite edges between classes still on the board: [needs, unlocks, sameTermOK]. */
export function buildGraph(courses) {
  const by = {};
  courses.forEach((c) => { by[c.code] = c; });
  const onBoard = (c) => c && c.status !== "done";
  const edges = [];
  courses.filter(onBoard).forEach((c) => {
    c.prereqs.forEach((p) => { if (onBoard(by[p]) && p !== c.code) edges.push([p, c.code, false]); });
    c.coreqs.forEach((p) => { if (onBoard(by[p]) && p !== c.code) edges.push([p, c.code, true]); });
  });
  return { by, edges };
}

/** Prerequisite codes that are not on the student's list (treated as already done). */
export function unknownPrereqs(courses) {
  const codes = new Set(courses.map((c) => c.code)), out = {};
  courses.forEach((c) => {
    const miss = [...c.prereqs, ...c.coreqs].filter((p) => !codes.has(p));
    if (miss.length) out[c.code] = miss;
  });
  return out;
}

/** Find a prerequisite loop (A needs B, B needs A). Returns [a, b] or null. */
export function findLoop(courses) {
  const { by, edges } = buildGraph(courses);
  const next = {};
  edges.forEach(([f, t, co]) => { if (!co) (next[f] ||= []).push(t); });
  const state = {};
  let loop = null;
  const visit = (k) => {
    state[k] = 1;
    for (const t of next[k] || []) {
      if (state[t] === 1) { loop = [k, t]; return true; }
      if (!state[t] && visit(t)) return true;
    }
    state[k] = 2;
    return false;
  };
  Object.keys(by).some((k) => !state[k] && visit(k));
  return loop;
}

/**
 * Auto mode. Places every remaining class into a semester:
 * 1. Pinned classes go exactly where the student put them.
 * 2. Prerequisites always come first (same term only where allowed).
 * 3. Classes on long prerequisite chains start early so nothing spills past graduation.
 * 4. Each semester mixes at least one easy class with hard classes spread evenly, up to the hard limit.
 * 5. It tries to reach the yearly credit target, and respects hour caps, "keep apart" groups and per-semester limits.
 * Anything that can't fit lands in index terms.length ("doesn't fit yet").
 */
export function schedule(state) {
  const st = { ...DEFAULT_SETTINGS, ...state.settings };
  const T = makeTerms(st), N = T.length;
  const { by, edges } = buildGraph(state.courses);
  const rules = { ...emptyRules(), ...(state.rules || {}) };
  const place = {};
  const tIdx = Object.fromEntries(T.map((t) => [t.t, t.i]));

  state.courses.filter((c) => c.status === "current").forEach((c) => { place[c.code] = 0; });
  const rem = state.courses.filter((c) => c.status === "remaining").map((c) => c.code);
  const elig = (k, i) => {
    const c = by[k], t = T[i];
    if (!t || t.cur) return false;
    if (c.offered !== "any" && c.offered !== t.s.toLowerCase()) return false;
    if (t.s === "Summer" && c.kind === "core" && !c.easy) return false; // summers hold electives and easy classes
    return true;
  };

  Object.entries(state.pins || {}).forEach(([k, term]) => {
    const i = tIdx[term];
    if (by[k] && by[k].status === "remaining" && i >= 1) place[k] = i;
  });

  const succ = {};
  edges.forEach(([f, t, co]) => (succ[f] ||= []).push([t, co]));
  const depthMemo = {};
  const depth = (k) => {
    if (depthMemo[k] != null) return depthMemo[k];
    depthMemo[k] = 0;
    let d = 0;
    (succ[k] || []).forEach(([t, co]) => { d = Math.max(d, depth(t) + (co ? 0 : 1)); });
    return (depthMemo[k] = d);
  };
  rem.forEach(depth);

  // Latest semester each class can take and still leave room for everything after it.
  const latest = {};
  const L = (k) => {
    if (latest[k] != null) return latest[k];
    latest[k] = -1;
    if (place[k] != null) return (latest[k] = place[k]);
    let b = N - 1;
    for (const [t, co] of succ[k] || []) { const lt = L(t); b = Math.min(b, co ? lt : lt - 1); }
    while (b >= 1 && !elig(k, b)) b--;
    return (latest[k] = b);
  };
  rem.forEach(L);

  const left = new Set(rem.filter((k) => place[k] == null));
  const perSem = Math.min(+st.semMax || 18, Math.max(12, Math.ceil((+st.yearTarget || 30) / 2)));
  const hardCap = Math.max(1, +st.maxHard || 2);
  const groups = (rules.apart || []).filter((g) => g.codes && g.codes.length > 1);
  const regAfter = (ti) => T.filter((t) => t.i > ti && t.s !== "Summer").length;
  const hoursIn = (i) => Object.keys(place).filter((k) => place[k] === i && by[k]).reduce((a, k) => a + by[k].hours, 0);
  const firstAy = academicYear(T[0]), lastAy = academicYear(T[N - 1]);

  for (let ti = 1; ti < N; ti++) {
    const term = T[ti], summer = term.s === "Summer";
    const lim = (rules.termLimits || []).find((x) => x.term === term.t) || {};
    const maxHrs = lim.maxHours != null ? +lim.maxHours : summer ? (+st.summerMax || 0) : (+st.semMax || 18);
    const softCap = Math.min(maxHrs, summer ? (+st.summerMax || 0) : perSem);
    const maxCls = lim.maxClasses != null ? +lim.maxClasses : 99;
    if (maxHrs <= 0) continue;
    const regLeft = regAfter(ti) + (summer ? 0 : 1);

    // How much this semester should carry so its academic year reaches the credit target.
    const ay = academicYear(term), ayTerms = T.filter((t) => academicYear(t) === ay);
    const before = ayTerms.filter((t) => t.i < ti).reduce((a, t) => a + hoursIn(t.i), 0) + (ay === firstAy ? +st.earned || 0 : 0);
    const laterReg = ayTerms.filter((t) => t.i > ti && t.s !== "Summer").length;
    const needT = summer || ay === lastAy ? 0 : Math.min(maxHrs, Math.ceil(((+st.yearTarget || 0) - before) / (laterReg + 1)));

    for (;;) {
      const ks = Object.keys(place).filter((k) => place[k] === ti && by[k]);
      const hrs = ks.reduce((a, k) => a + by[k].hours, 0);
      const hard = ks.filter((k) => by[k].hard).length, easy = ks.filter((k) => by[k].easy).length;
      const unHard = [...left].filter((k) => by[k].hard).length, unEasy = [...left].filter((k) => by[k].easy).length;
      const hardTarget = summer ? 0 : Math.min(hardCap, Math.ceil((unHard + hard) / Math.max(1, regLeft)));
      const easyTarget = summer ? 0 : Math.max(unEasy + easy > 0 ? 1 : 0, Math.ceil((unEasy + easy) / Math.max(1, regLeft)));
      const easySurplus = unEasy - regAfter(ti);

      const fits = (k) => {
        const c = by[k];
        if (!elig(k, ti)) return false;
        if (hrs + c.hours > maxHrs || ks.length >= maxCls) return false;
        if (c.hard && hard >= hardCap) return false;
        if (groups.some((g) => g.codes.includes(k) && g.codes.filter((x) => place[x] === ti).length >= Math.max(1, +g.max || 1))) return false;
        return edges.every(([f, t, co]) => t !== k || (place[f] != null && (co ? place[f] <= ti : place[f] < ti)));
      };
      const cand = [...left].filter(fits);
      if (!cand.length) break;
      const best = (a) => a.sort((x, y) => latest[x] - latest[y] || depth(y) - depth(x) || by[y].hours - by[x].hours || x.localeCompare(y))[0];
      const urgent = cand.filter((k) => latest[k] <= ti);
      const cap = Math.max(softCap, needT), fill = Math.max(12, needT);
      let k = null;
      if (urgent.length) k = best(urgent);
      else if (hrs < cap) {
        const e = cand.filter((x) => by[x].easy), h = cand.filter((x) => by[x].hard && !by[x].easy), o = cand.filter((x) => !by[x].hard && !by[x].easy);
        if (summer) k = easySurplus > 0 && e.length ? best(e) : o.length ? best(o) : null;
        else if (easy < easyTarget && e.length) k = best(e);
        else if (hard < hardTarget && h.length) k = best(h);
        else if (o.length) k = best(o);
        else if (h.length && hrs < fill) k = best(h);
        else if (e.length && (easySurplus > 0 || hrs < fill)) k = best(e);
      }
      if (!k) break;
      place[k] = ti;
      left.delete(k);
    }
  }
  left.forEach((k) => { place[k] = N; });
  return place;
}

/** Why a class can't move to semester ti, or "" if the move is fine. */
export function moveProblem({ terms, graph, place }, code, ti) {
  const c = graph.by[code];
  const N = terms.length;
  if (!c) return "That class isn't in your list.";
  if (ti < N && terms[ti].cur) return `${terms[ti].t} is your current semester and is locked.`;
  if (ti < N && c.offered !== "any" && c.offered !== terms[ti].s.toLowerCase()) return `${code} is only offered in the ${c.offered}.`;
  for (const [f, t, co] of graph.edges) {
    if (t === code) {
      const p = place[f];
      if (p != null && (co ? p > ti : p >= ti))
        return `${code} needs ${f} ${co ? "in the same semester or earlier" : "finished first"}, and ${f} is ${p >= N ? "not placed yet" : "in " + terms[p].t}.`;
    }
    if (f === code && ti < N) {
      const p = place[t];
      if (p != null && p < N && (co ? ti > p : ti >= p))
        return `${t} in ${terms[p].t} needs ${code} ${co ? "by then" : "before it"}. Move ${t} later first.`;
    }
  }
  return "";
}

/** Every prerequisite rule the current placement breaks (empty when the plan is valid). */
export function planProblems(state, place) {
  const terms = makeTerms(state.settings), graph = buildGraph(state.courses), N = terms.length, out = [];
  graph.edges.forEach(([f, t, co]) => {
    const a = place[f], b = place[t];
    if (a == null || b == null || b >= N) return;
    if (co ? a > b : a >= b) out.push(`${t} is before ${f}, which it needs`);
  });
  return [...new Set(out)];
}

/** Pinned classes whose prerequisites could not be placed before them. */
export function pinIssues(state, place) {
  const { edges } = buildGraph(state.courses), out = [];
  Object.keys(state.pins || {}).forEach((k) => {
    edges.forEach(([f, t, co]) => {
      if (t === k && place[f] != null && place[k] != null && (co ? place[f] > place[k] : place[f] >= place[k])) out.push(`${f} can't fit before ${k}`);
    });
  });
  return [...new Set(out)];
}

/** Hours per semester and per academic year. */
export function totals(state, place) {
  const st = { ...DEFAULT_SETTINGS, ...state.settings };
  const terms = makeTerms(st), { by } = buildGraph(state.courses);
  const perTerm = terms.map((t) => Object.keys(place).filter((k) => place[k] === t.i && by[k]).reduce((a, k) => a + by[k].hours, 0));
  const groups = {};
  terms.forEach((t) => { (groups[academicYear(t)] ||= []).push(t.i); });
  const keys = Object.keys(groups).map(Number).sort((a, b) => a - b);
  const years = keys.map((k, idx) => {
    const hours = groups[k].reduce((a, i) => a + perTerm[i], 0) + (k === academicYear(terms[0]) ? +st.earned || 0 : 0);
    const final = idx === keys.length - 1 && keys.length > 1;
    return { year: k, label: academicYearLabel(k), hours, final, met: hours >= st.yearTarget, short: Math.max(0, st.yearTarget - hours) };
  });
  return { perTerm, years };
}

/** Graduation progress: hours done, in progress, planned, and the semester the plan finishes. */
export function progress(state, place) {
  const terms = makeTerms(state.settings), N = terms.length;
  const sum = (list) => list.reduce((a, c) => a + c.hours, 0);
  const done = sum(state.courses.filter((c) => c.status === "done"));
  const current = sum(state.courses.filter((c) => c.status === "current"));
  const remaining = state.courses.filter((c) => c.status === "remaining");
  const planned = sum(remaining.filter((c) => place?.[c.code] != null && place[c.code] < N));
  const unplaced = sum(remaining) - planned;
  const total = +state.settings?.degreeTotal || done + current + sum(remaining);
  const lastIdx = Math.max(0, ...state.courses.filter((c) => c.status !== "done" && place?.[c.code] != null && place[c.code] < N).map((c) => place[c.code]));
  return { done, current, planned, unplaced, total, finish: unplaced ? null : terms[lastIdx]?.t || null, fromChart: !+state.settings?.degreeTotal };
}

/** Keep a saved placement valid after the course list or settings change. */
export function reconcile(state, place) {
  const terms = makeTerms(state.settings), N = terms.length, { by } = buildGraph(state.courses);
  const needs = state.courses.filter((c) => c.status !== "done").map((c) => c.code);
  if (!place || needs.some((k) => place[k] == null)) return schedule(state);
  const out = {};
  Object.entries(place).forEach(([k, i]) => { if (by[k] && by[k].status !== "done") out[k] = Math.min(Math.max(0, +i || 0), N); });
  state.courses.forEach((c) => {
    if (c.status === "current") out[c.code] = 0;
    else if (out[c.code] === 0) out[c.code] = Math.min(1, N);
  });
  return out;
}

/** The example plan shown to first time visitors (a Mechanical Engineering degree). */
export const EXAMPLE_COURSES = cleanCourses([
  ["MATH 3350", "Higher Math for Engineers", 3, "current"], ["ME 2207", "Design Graphics", 2, "current"],
  ["ME 3303", "Solids", 3, "current", [], [], 1], ["ME 2322", "Thermo I", 3, "current", [], [], 1],
  ["ENGL 1302", "Adv College Rhetoric", 3, "current", [], [], 0, 0, "any", "gen"],
  ["ENGR 2392", "Engineering Ethics", 3, "remaining", [], [], 0, 1, "any", "gen"], ["ME 2315", "Computer Aided Analysis", 3, "remaining"],
  ["ME 2302", "Dynamics", 3, "remaining", [], [], 1], ["ME 3311", "Material Science", 3, "remaining"],
  ["ME 3365", "Intro to Design", 3, "remaining", ["ME 3303"]], ["HIST ELEC", "History elective", 3, "remaining", [], [], 0, 1, "any", "gen"],
  ["POLS 2306", "Texas Politics", 3, "remaining", [], [], 0, 1, "any", "gen"], ["ME 3322", "Thermo II", 3, "remaining", ["ME 2322"], [], 1],
  ["ME 3370", "Fluids", 3, "remaining", ["ME 2322"], [], 1], ["ME 3228", "Materials & Mech Lab", 2, "remaining", ["ME 3311"]],
  ["MINOR 1", "Robotics minor class", 3, "remaining", [], [], 0, 0, "fall", "elective"],
  ["SPCH ELEC", "Oral / Speech Elective", 3, "remaining", [], [], 0, 1, "any", "gen"],
  ["ME 3371", "Heat Transfer", 3, "remaining", ["ME 3370", "ME 2315"], [], 1],
  ["ME 3264", "Computational Techniques", 2, "remaining", ["ME 3303", "ME 3370"]],
  ["MATH 3342", "Math Stats for Engineers", 3, "remaining", [], [], 0, 0, "any", "gen"],
  ["DEPT ELEC 1", "Dept Elective", 3, "remaining", [], [], 0, 0, "any", "elective"],
  ["MINOR 2", "Robotics minor class", 3, "remaining", [], [], 0, 0, "spring", "elective"],
  ["CREATIVE", "Creative Arts Elective", 3, "remaining", [], [], 0, 1, "any", "gen"],
  ["ME 3333", "Systems & Vibrations", 3, "remaining", ["MATH 3350", "ME 2315", "ME 2302"], [], 1],
  ["ME 4370", "Design I", 3, "remaining", ["ME 2302", "ME 3311", "ME 3365"], ["ME 3371"]],
  ["ME 4251", "Thermal Fluids Lab", 2, "remaining", ["ME 3370", "ME 3322", "ME 3371"]],
  ["DEPT ELEC 2", "Dept Elective", 3, "remaining", [], [], 0, 0, "any", "elective"],
  ["ME 4334", "Control of Dynamic Systems", 3, "remaining", ["ME 3333"], [], 1],
  ["ME 4234", "Systems & Controls Lab", 2, "remaining", [], ["ME 4334"]], ["ME 4371", "Design II", 3, "remaining", ["ME 4370"]],
].map(([code, name, hours, status, prereqs = [], coreqs = [], hard = 0, easy = 0, offered = "any", kind = "core"]) =>
  ({ code, name, hours, status, prereqs, coreqs, hard, easy, offered, kind })));

export const EXAMPLE_SETTINGS = Object.freeze({ ...DEFAULT_SETTINGS, season: "Fall", year: 2026 });
