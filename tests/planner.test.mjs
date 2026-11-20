import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanCourses, makeTerms, buildGraph, findLoop, schedule, moveProblem, planProblems, pinIssues, totals, reconcile,
  EXAMPLE_COURSES, EXAMPLE_SETTINGS, DEFAULT_SETTINGS, norm, unknownPrereqs,
} from "../public/js/planner.js";
import { applyRequests } from "../public/js/prompts.js";
import { parseJSON } from "../public/js/ai.js";

const example = (extra = {}) => ({ settings: { ...EXAMPLE_SETTINGS }, courses: structuredClone(EXAMPLE_COURSES), pins: {}, pinSrc: {}, rules: { apart: [], termLimits: [] }, ...extra });
const termsOf = (state, place) => { const T = makeTerms(state.settings); const out = {}; Object.entries(place).forEach(([k, i]) => (out[k] = T[i]?.t ?? "unplaced")); return out; };

test("norm tidies course codes", () => {
  assert.equal(norm(" me-3370 "), "ME 3370");
  assert.equal(norm("math–3350"), "MATH 3350");
});

test("cleanCourses fixes bad input and de-duplicates codes", () => {
  const list = cleanCourses([
    { code: "me 3370", name: "Fluids", hours: "3", status: "remaining", prereqs: "ME 2322, me-2301", offered: "Fall" },
    { code: "ME 3370", name: "Fluids again" },
    { code: "", name: "no code" },
    { code: "X 1", hours: 99, status: "weird", kind: "nope", prereqs: ["X 1"] },
  ]);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0].prereqs, ["ME 2322", "ME 2301"]);
  assert.equal(list[0].offered, "fall");
  assert.equal(list[1].code, "ME 3370 2");
  assert.equal(list[2].hours, 3);
  assert.equal(list[2].status, "remaining");
  assert.equal(list[2].kind, "core");
  assert.deepEqual(list[2].prereqs, [], "a class can't need itself");
});

test("makeTerms builds semesters with and without summers", () => {
  const withSummer = makeTerms({ ...DEFAULT_SETTINGS, season: "Fall", year: 2026, left: 3, summers: true });
  assert.deepEqual(withSummer.map((t) => t.t), ["Fall 2026", "Spring 2027", "Summer 2027", "Fall 2027", "Spring 2028"]);
  assert.equal(withSummer[0].cur, true);
  const noSummer = makeTerms({ ...DEFAULT_SETTINGS, season: "Spring", year: 2027, left: 2, summers: false });
  assert.deepEqual(noSummer.map((t) => t.t), ["Spring 2027", "Fall 2027", "Spring 2028"]);
  const fromSummer = makeTerms({ ...DEFAULT_SETTINGS, season: "Summer", year: 2027, left: 1, summers: true });
  assert.deepEqual(fromSummer.map((t) => t.t), ["Summer 2027", "Fall 2027"]);
});

test("findLoop catches classes that need each other", () => {
  const loop = findLoop(cleanCourses([{ code: "A 1", prereqs: ["B 1"] }, { code: "B 1", prereqs: ["A 1"] }]));
  assert.ok(loop);
  assert.equal(findLoop(EXAMPLE_COURSES), null);
});

test("unknownPrereqs lists prerequisites missing from the class list", () => {
  assert.deepEqual(unknownPrereqs(cleanCourses([{ code: "A 1", prereqs: ["Z 9"] }])), { "A 1": ["Z 9"] });
});

test("auto mode places every class and never breaks a prerequisite", () => {
  const s = example();
  const place = schedule(s);
  const T = makeTerms(s.settings);
  const remaining = s.courses.filter((c) => c.status !== "done");
  for (const c of remaining) assert.ok(place[c.code] != null, `${c.code} has a place`);
  assert.ok(remaining.every((c) => place[c.code] < T.length), "everything fits in the example");
  assert.deepEqual(planProblems(s, place), []);
});

test("auto mode mixes easy and hard classes and respects the hard limit", () => {
  const s = example();
  const place = schedule(s);
  const T = makeTerms(s.settings);
  const by = Object.fromEntries(s.courses.map((c) => [c.code, c]));
  for (const t of T.slice(1)) {
    if (t.s === "Summer") continue;
    const ks = Object.keys(place).filter((k) => place[k] === t.i);
    if (!ks.length) continue;
    assert.ok(ks.filter((k) => by[k].hard).length <= s.settings.maxHard, `${t.t} has at most ${s.settings.maxHard} hard classes`);
    assert.ok(ks.some((k) => by[k].easy), `${t.t} has an easy class`);
  }
  // with a limit of 1, no semester gets two hard classes
  const s1 = example({ settings: { ...EXAMPLE_SETTINGS, maxHard: 1, left: 6 } });
  const p1 = schedule(s1);
  makeTerms(s1.settings).slice(1).forEach((t) => {
    assert.ok(Object.keys(p1).filter((k) => p1[k] === t.i && by[k].hard).length <= 1, `${t.t} has one hard class at most`);
  });
});

test("fall only and spring only classes land in the right season", () => {
  const s = example();
  const where = termsOf(s, schedule(s));
  assert.match(where["MINOR 1"], /^Fall/);
  assert.match(where["MINOR 2"], /^Spring/);
});

test("summer only takes electives and easy classes, within the summer cap", () => {
  const s = example();
  const place = schedule(s);
  const T = makeTerms(s.settings);
  const by = Object.fromEntries(s.courses.map((c) => [c.code, c]));
  for (const t of T.filter((x) => x.s === "Summer")) {
    const ks = Object.keys(place).filter((k) => place[k] === t.i);
    assert.ok(ks.every((k) => by[k].kind !== "core" || by[k].easy), `${t.t} holds no core classes`);
    assert.ok(ks.reduce((a, k) => a + by[k].hours, 0) <= s.settings.summerMax);
  }
});

test("pinned classes stay exactly where the student put them", () => {
  const s = example({ pins: { "ME 3311": "Spring 2027", "ME 3370": "Fall 2027" } });
  const where = termsOf(s, schedule(s));
  assert.equal(where["ME 3311"], "Spring 2027");
  assert.equal(where["ME 3370"], "Fall 2027");
  assert.deepEqual(planProblems(s, schedule(s)), []);
});

test("keep apart groups and per semester limits are followed", () => {
  const s = example({
    rules: { apart: [{ codes: ["ME 2302", "ME 3370", "ME 3322"], max: 1 }], termLimits: [{ term: "Spring 2029", maxClasses: 3, maxHours: null }] },
    settings: { ...EXAMPLE_SETTINGS, left: 6 },
  });
  const place = schedule(s);
  const set = new Set(["ME 2302", "ME 3370", "ME 3322"].map((k) => place[k]));
  assert.equal(set.size, 3, "the three classes are in three different semesters");
  const T = makeTerms(s.settings), sp29 = T.find((t) => t.t === "Spring 2029");
  assert.ok(Object.keys(place).filter((k) => place[k] === sp29.i).length <= 3);
});

test("classes that can't fit go to the 'doesn't fit yet' column", () => {
  const s = example({ settings: { ...EXAMPLE_SETTINGS, left: 2, summers: false } });
  const place = schedule(s);
  const N = makeTerms(s.settings).length;
  assert.ok(Object.values(place).some((i) => i === N));
  assert.deepEqual(planProblems(s, place), []);
});

test("pins that clash with prerequisites are reported", () => {
  const s = example({ pins: { "ME 3371": "Spring 2027" } }); // needs Fluids first, which can't come before
  const issues = pinIssues(s, schedule(s));
  assert.ok(issues.some((x) => x.includes("ME 3371")));
});

test("moveProblem blocks moves that break prerequisites and explains why", () => {
  const s = example();
  const place = schedule(s);
  const terms = makeTerms(s.settings), graph = buildGraph(s.courses), ctx = { terms, graph, place };
  assert.match(moveProblem(ctx, "ME 3371", 1), /needs/);
  assert.match(moveProblem(ctx, "ME 2315", 0), /locked/);
  assert.match(moveProblem(ctx, "MINOR 1", 1), /only offered in the fall/);
  const legal = terms.findIndex((t, i) => i > place["ME 4371"] && t.s !== "Summer");
  assert.equal(moveProblem(ctx, "ME 4371", legal), "");
  // Design I can share a semester with Heat Transfer (same term OK)
  assert.equal(moveProblem({ ...ctx, place: { ...place, "ME 4370": place["ME 3371"] + 1 } }, "ME 4370", place["ME 3371"]), "");
});

test("totals adds hours per semester and per academic year", () => {
  const s = example();
  const { perTerm, years } = totals(s, schedule(s));
  assert.equal(perTerm[0], 14, "Fall 2026 classes in progress");
  assert.equal(years[0].label, "2026/27");
  assert.equal(years.at(-1).final, true);
  assert.ok(years.slice(0, -1).every((y) => y.met), "each full year reaches 30 hours");
});

test("reconcile keeps saved moves and fixes stale entries", () => {
  const s = example();
  const place = schedule(s);
  place["ME 3311"] = 1;
  place["GONE 1"] = 2;
  const out = reconcile(s, place);
  assert.equal(out["ME 3311"], 1);
  assert.equal(out["GONE 1"], undefined);
  assert.equal(out["ME 2322"], 0);
});

test("typed requests turn into pins and rules, and bad ones are reported", () => {
  const s = example();
  const notes = applyRequests(s, {
    pins: [{ code: "me 3311", term: "Spring 2027" }, { code: "ME 2322", term: "Fall 2027" }, { code: "ME 3370", term: "Fall 2040" }],
    apart: [{ codes: ["ME 2302", "ME 3370", "NOPE 1"], max: 1 }],
    termLimits: [{ term: "Spring 2029", maxClasses: "3" }],
    settings: { maxHard: 1 },
    notUnderstood: ["something odd"],
  });
  assert.equal(s.pins["ME 3311"], "Spring 2027");
  assert.equal(s.pinSrc["ME 3311"], "ask");
  assert.equal(s.pins["ME 2322"], undefined, "a class in progress can't be pinned");
  assert.deepEqual(s.rules.apart, [{ codes: ["ME 2302", "ME 3370"], max: 1 }]);
  assert.deepEqual(s.rules.termLimits, [{ term: "Spring 2029", maxClasses: 3, maxHours: null }]);
  assert.equal(s.settings.maxHard, 1);
  assert.equal(notes.length, 3);
});

test("parseJSON reads plain, fenced and wrapped JSON", () => {
  assert.deepEqual(parseJSON('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJSON('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJSON('Here you go: {"a":3} done'), { a: 3 });
  assert.throws(() => parseJSON("no json here"), (e) => e.code === "invalid_json");
});
