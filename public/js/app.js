// Degree Flow page: the three steps (flowchart, classes, plan) and the drag and drop board.
import {
  DEFAULT_SETTINGS, EXAMPLE_COURSES, EXAMPLE_SETTINGS, emptyRules, norm, cleanCourses, makeTerms,
  buildGraph, findLoop, schedule, moveProblem, pinIssues, totals, reconcile,
} from "./planner.js";
import { readPrompt, checkPrompt, requestsPrompt, applyRequests } from "./prompts.js";
import { connectAI, AI_ERRORS } from "./ai.js";
import { isPdf, pdfToImages } from "./pdf.js";

/* ---------- state ---------- */
const KEY = "degree-flow-v2";
const fresh = () => ({ settings: { ...DEFAULT_SETTINGS }, courses: [], place: null, pins: {}, pinSrc: {}, rules: emptyRules(), requests: "", reqDone: "", example: false, step: 1, lastChanges: [] });
const example = () => ({ ...fresh(), settings: { ...EXAMPLE_SETTINGS }, courses: structuredClone(EXAMPLE_COURSES), example: true, step: 3 });

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && s.settings && Array.isArray(s.courses)) {
      const st = { ...fresh(), ...s };
      st.settings = { ...DEFAULT_SETTINGS, ...s.settings };
      st.rules = { ...emptyRules(), ...(s.rules || {}) };
      st.courses = cleanCourses(s.courses);
      return st;
    }
  } catch {}
  return null;
}
let S = load() || example();
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }

let AI = null;
let images = [];

/* ---------- helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let toastTimer;
function toast(msg, bad) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}
/** Friendly message plus the technical detail, so problems can be diagnosed from a screenshot. */
function errorText(e) {
  const base = AI_ERRORS[e?.code];
  if (!base) return "";
  const detail = [e?.status ? `status ${e.status}` : "", e?.message && e.message !== base ? e.message : ""].filter(Boolean).join(", ");
  return detail ? `${base} (${detail})` : base;
}
function setStatus(id, msg, err, busy) {
  const el = $(id);
  el.className = "status" + (err ? " err" : "");
  el.textContent = "";
  if (busy) { const sp = document.createElement("span"); sp.className = "spin"; el.append(sp, " "); }
  el.append(msg);
}

/* ---------- steps ---------- */
function go(step) {
  if (step === 3) S.place = reconcile(S, S.place);
  S.step = step;
  save();
  [1, 2, 3].forEach((n) => { $("s" + n).hidden = n !== step; });
  document.querySelectorAll("nav.steps button").forEach((b) => {
    if (+b.dataset.step === step) b.setAttribute("aria-current", "step"); else b.removeAttribute("aria-current");
    if (+b.dataset.step > 1) b.disabled = !S.courses.length;
  });
  $("exBanner").hidden = !S.example;
  if (step === 1) fillSetup();
  if (step === 2) renderTable();
  if (step === 3) renderPlan();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll("nav.steps button").forEach((b) => {
  b.onclick = () => { if (S.step === 2) commitTable(); if (S.step === 1) readSetup(); go(+b.dataset.step); };
});
function startOver() { S = fresh(); save(); images = []; renderThumbs(); setStatus("readStatus", ""); go(1); }
$("exStart").onclick = startOver;
$("startOver").onclick = () => { if (confirm("Clear your classes and plan and start over?")) startOver(); };

/* ---------- step 1: flowchart and settings ---------- */
const FIELDS = ["curSeason", "curYear", "left", "summers", "summerMax", "semMax", "yearTarget", "earned", "maxHard", "legendTxt", "easyTxt"];
function fillSetup() {
  const s = S.settings;
  $("curSeason").value = s.season; $("curYear").value = s.year; $("left").value = s.left; $("summers").checked = !!s.summers;
  $("summerMax").value = s.summerMax; $("semMax").value = s.semMax; $("yearTarget").value = s.yearTarget; $("earned").value = s.earned;
  $("maxHard").value = s.maxHard; $("legendTxt").value = s.legend; $("easyTxt").value = s.easyTxt; $("reqTxt1").value = S.requests || "";
}
function readSetup() {
  const n = (id, d, lo, hi) => { const v = parseInt($(id).value, 10); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
  const s = S.settings;
  s.season = $("curSeason").value;
  s.year = n("curYear", s.year, 2000, 2100);
  s.left = n("left", s.left, 1, 12);
  s.summers = $("summers").checked;
  s.summerMax = n("summerMax", 6, 0, 15);
  s.semMax = n("semMax", 18, 6, 24);
  s.yearTarget = n("yearTarget", 30, 0, 60);
  s.earned = n("earned", 0, 0, 60);
  s.maxHard = n("maxHard", 2, 1, 6);
  s.legend = $("legendTxt").value.trim();
  s.easyTxt = $("easyTxt").value.trim();
}
FIELDS.forEach((id) => $(id).addEventListener("change", () => {
  const was = JSON.stringify(S.settings);
  readSetup();
  if (was !== JSON.stringify(S.settings)) { S.place = null; save(); }
}));
$("reqTxt1").addEventListener("input", (e) => { S.requests = e.target.value; save(); });

function renderThumbs() {
  const box = $("thumbs");
  box.innerHTML = "";
  images.forEach((f, i) => {
    const d = document.createElement("div"); d.className = "thumb";
    const img = document.createElement("img"); img.alt = f.name || `Flowchart image ${i + 1}`; img.src = URL.createObjectURL(f); img.title = f.name || "";
    const b = document.createElement("button"); b.type = "button"; b.textContent = "Remove";
    b.onclick = () => { images.splice(i, 1); renderThumbs(); };
    d.append(img, b); box.append(d);
  });
}
async function addFiles(list) {
  const max = AI?.maxImages || 6;
  for (const f of [...list]) {
    if (images.length >= max) { toast(`Up to ${max} images or PDF pages at a time.`, true); break; }
    if (isPdf(f)) {
      if (f.size > 30 * 1024 * 1024) { toast(`${f.name} is over 30 MB.`, true); continue; }
      setStatus("readStatus", `Opening ${f.name}.`, false, true);
      try {
        const room = max - images.length;
        const { pages, total } = await pdfToImages(f, room);
        images.push(...pages);
        setStatus("readStatus", total > pages.length
          ? `Added ${pages.length} of ${total} pages from ${f.name}. Only ${max} pages fit at once, so remove extra pages or split the PDF.`
          : `Added ${pages.length} page${pages.length > 1 ? "s" : ""} from ${f.name}.`, total > pages.length);
      } catch {
        setStatus("readStatus", `Couldn't open ${f.name}. If it has a password, remove it, or take screenshots instead.`, true);
      }
      renderThumbs();
      continue;
    }
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(f.type)) { toast(`${f.name} isn't a PDF or a PNG, JPG or WebP image.`, true); continue; }
    if (f.size > 15 * 1024 * 1024) { toast(`${f.name} is over 15 MB.`, true); continue; }
    images.push(f);
  }
  renderThumbs();
}
$("drop").onclick = () => $("file").click();
$("drop").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); } };
$("file").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
["dragenter", "dragover"].forEach((ev) => $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.remove("over"); }));
$("drop").addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
document.addEventListener("paste", (e) => {
  if (S.step !== 1) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/") || isPdf(f));
  if (files.length) addFiles(files);
});

let readCtl = null;
$("readBtn").onclick = async () => {
  readSetup(); save();
  if (!images.length) return setStatus("readStatus", "Add at least one flowchart image first.", true);
  if (!AI) return setStatus("readStatus", "The AI reader isn't available here. Use “Type my classes instead”.", true);
  readCtl = new AbortController();
  $("readBtn").disabled = true; $("stopBtn").hidden = false;
  setStatus("readStatus", "Reading your flowchart. This can take a minute.", false, true);
  try {
    const out = await AI.json(readPrompt(S.settings, images.length), { images, signal: readCtl.signal, purpose: "read" });
    let list = cleanCourses(out?.courses);
    if (!list.length) throw { code: "invalid_json" };
    S.lastChanges = [];
    if ($("verify").checked) {
      setStatus("readStatus", `Found ${list.length} classes. Double checking them against your chart.`, false, true);
      try {
        const fix = await AI.json(checkPrompt(S.settings, list), { images, signal: readCtl.signal, purpose: "check" });
        const fixed = cleanCourses(fix?.courses);
        if (fixed.length >= Math.ceil(list.length * 0.6)) { list = fixed; S.lastChanges = (fix.changes || []).slice(0, 30).map(String); }
      } catch (e) { if (e?.code === "cancelled") throw e; }
    }
    Object.assign(S, { courses: list, place: null, example: false, pins: {}, pinSrc: {}, rules: emptyRules(), reqDone: "" });
    save();
    setStatus("readStatus", `Found ${list.length} classes.`);
    go(2);
  } catch (e) {
    if (e?.code === "cancelled") setStatus("readStatus", "Stopped.");
    else setStatus("readStatus", errorText(e) || "Something went wrong reading the images. Try again.", true);
  } finally {
    $("readBtn").disabled = false; $("stopBtn").hidden = true;
  }
};
$("stopBtn").onclick = () => readCtl?.abort();
$("manualBtn").onclick = () => {
  readSetup();
  if (S.example) Object.assign(S, { courses: [], place: null, example: false, pins: {}, pinSrc: {}, rules: emptyRules() });
  if (!S.courses.length) S.courses = cleanCourses([{ code: "NEW 1000", name: "First class", hours: 3, status: "remaining" }]);
  save(); go(2);
};

/* ---------- step 2: check classes ---------- */
function rowHTML(c, i) {
  const sel = (name, label, opts, v) => `<select data-f="${name}" aria-label="${label}">${opts.map(([val, lab]) => `<option value="${val}"${val === v ? " selected" : ""}>${lab}</option>`).join("")}</select>`;
  return `<tr class="${c.status === "done" ? "done" : ""}" data-i="${i}">
   <td><input type="text" data-f="code" value="${esc(c.code)}" aria-label="Code" style="width:110px"${c.check ? ` class="warn" title="Check: ${esc(c.check)}"` : ""}>${c.check ? `<div class="checknote">Check: ${esc(c.check)}</div>` : ""}</td>
   <td><input type="text" data-f="name" value="${esc(c.name)}" aria-label="Name" style="min-width:180px"></td>
   <td><input type="number" data-f="hours" value="${c.hours}" min="0" max="12" aria-label="Hours" style="width:58px"></td>
   <td>${sel("status", "Status", [["done", "Done"], ["current", "Taking now"], ["remaining", "Still need"]], c.status)}</td>
   <td><input type="text" data-f="prereqs" value="${esc(c.prereqs.join(", "))}" aria-label="Needs first" style="min-width:150px"></td>
   <td><input type="text" data-f="coreqs" value="${esc(c.coreqs.join(", "))}" aria-label="Same term OK" style="min-width:110px"></td>
   <td class="c"><input type="checkbox" data-f="hard"${c.hard ? " checked" : ""} aria-label="Hard"></td>
   <td class="c"><input type="checkbox" data-f="easy"${c.easy ? " checked" : ""} aria-label="Easy"></td>
   <td>${sel("offered", "Offered", [["any", "Any term"], ["fall", "Fall only"], ["spring", "Spring only"]], c.offered)}</td>
   <td>${sel("kind", "Type", [["core", "Major"], ["elective", "Elective"], ["gen", "Other"]], c.kind)}</td>
   <td><button class="btn sm danger" type="button" data-del="${i}" aria-label="Delete ${esc(c.code)}">Delete</button></td></tr>`;
}
function renderTable() {
  $("tbl").tBodies[0].innerHTML = S.courses.map(rowHTML).join("");
  markUnknown(); renderCounts();
  const ch = S.lastChanges || [];
  $("changesBox").hidden = !ch.length;
  $("changes").innerHTML = ch.map((x) => `<li>${esc(x)}</li>`).join("");
}
function renderCounts() {
  const by = (st) => S.courses.filter((c) => c.status === st), hrs = (a) => a.reduce((s, c) => s + c.hours, 0);
  const nCheck = S.courses.filter((c) => c.check).length;
  $("counts").innerHTML = (nCheck ? `<span class="chip warnchip">${nCheck} to check</span>` : "") +
    `<span class="chip">${S.courses.length} classes</span><span class="chip">${by("done").length} done</span><span class="chip">${by("current").length} taking now</span><span class="chip">${by("remaining").length} still needed · ${hrs(by("remaining"))} hrs</span>`;
}
function markUnknown() {
  const codes = new Set([...$("tbl").querySelectorAll('input[data-f="code"]')].map((i) => norm(i.value)));
  $("tbl").querySelectorAll('input[data-f="prereqs"],input[data-f="coreqs"]').forEach((inp) => {
    const bad = inp.value.split(",").map(norm).filter((x) => x && !codes.has(x));
    inp.classList.toggle("warn", bad.length > 0);
    inp.title = bad.length ? `Not in your list, so it's treated as done: ${bad.join(", ")}` : "";
  });
}
function commitTable() {
  if (S.step !== 2) return;
  const rows = [...$("tbl").tBodies[0].rows];
  const list = rows.map((r) => {
    const g = (f) => r.querySelector(`[data-f="${f}"]`);
    const old = S.courses[+r.dataset.i] || {};
    return {
      code: g("code").value, name: g("name").value, hours: parseFloat(g("hours").value), status: g("status").value,
      prereqs: g("prereqs").value.split(","), coreqs: g("coreqs").value.split(","),
      check: norm(g("code").value) === old.code ? old.check : "",
      hard: g("hard").checked, easy: g("easy").checked, offered: g("offered").value, kind: g("kind").value,
    };
  });
  const next = cleanCourses(list);
  if (JSON.stringify(next) !== JSON.stringify(S.courses)) { S.courses = next; S.place = null; S.example = false; }
  save();
}
$("tbl").addEventListener("input", (e) => { if (e.target.matches('[data-f="code"],[data-f="prereqs"],[data-f="coreqs"]')) markUnknown(); });
$("tbl").addEventListener("change", (e) => {
  if (e.target.matches('[data-f="status"]')) e.target.closest("tr").classList.toggle("done", e.target.value === "done");
  commitTable(); renderCounts();
});
$("tbl").addEventListener("click", (e) => {
  const b = e.target.closest("[data-del]");
  if (!b) return;
  commitTable();
  S.courses.splice(+b.dataset.del, 1);
  S.place = null; save(); renderTable();
});
$("addRow").onclick = () => {
  commitTable();
  let n = S.courses.length + 1;
  while (S.courses.some((c) => c.code === "NEW " + n)) n++;
  S.courses.push(...cleanCourses([{ code: "NEW " + n, name: "New class", hours: 3, status: "remaining" }]));
  S.place = null; save(); renderTable();
  const inp = $("tbl").tBodies[0].lastElementChild.querySelector("input");
  inp.focus(); inp.select();
};
$("buildBtn").onclick = async () => {
  commitTable();
  const loop = findLoop(S.courses);
  if (loop) return setStatus("buildStatus", `${loop[0]} and ${loop[1]} need each other first. Fix one of them.`, true);
  if (!S.courses.some((c) => c.status !== "done")) return setStatus("buildStatus", "Every class is marked done, so there's nothing to plan.", true);
  const b = $("buildBtn");
  b.disabled = true;
  const ok = await runRequests("buildStatus");
  b.disabled = false;
  if (!ok) return;
  S.place = schedule(S); save();
  go(3);
  const iss = pinIssues(S, S.place);
  if (iss.length) toast(iss.join(". ") + ".", true);
};

/* ---------- typed requests ---------- */
async function runRequests(statusId) {
  const text = (S.requests || "").trim();
  if (!text) {
    Object.keys(S.pinSrc).forEach((k) => { if (S.pinSrc[k] === "ask") { delete S.pins[k]; delete S.pinSrc[k]; } });
    S.rules = emptyRules(); S.reqDone = ""; save();
    return true;
  }
  if (text === S.reqDone) return true;
  if (!AI) { setStatus(statusId, "Typed requests need the AI reader, which isn't available here. Drag classes to pin them instead.", true); return false; }
  setStatus(statusId, "Reading your requests.", false, true);
  try {
    const r = await AI.json(requestsPrompt(S, text), { purpose: "requests" });
    const notes = applyRequests(S, r || {});
    S.reqDone = text; save();
    setStatus(statusId, notes.length ? `Done, but ${notes.join("; ")}.` : "Done. Your requests are in the plan.", notes.length > 0);
    return true;
  } catch (e) {
    setStatus(statusId, errorText(e) || "Couldn't read your requests. Try rewording them.", true);
    return false;
  }
}
$("reqTxt").addEventListener("input", (e) => { S.requests = e.target.value; save(); });
$("applyReq").onclick = async () => {
  const b = $("applyReq");
  b.disabled = true;
  S.requests = $("reqTxt").value; S.reqDone = "";
  const ok = await runRequests("reqStatus");
  b.disabled = false;
  if (!ok) return;
  S.place = schedule(S); save(); renderPlan();
  const iss = pinIssues(S, S.place);
  if (iss.length) toast(iss.join(". ") + ". Look in the last column.", true);
};
function renderRules() {
  const box = $("rules"), items = [];
  Object.entries(S.pins).forEach(([k, t]) => {
    if (G.by[k]) items.push([`<b>${esc(k)}</b> in ${esc(t)}${S.pinSrc[k] === "ask" ? " (asked)" : " (moved)"}`, () => { delete S.pins[k]; delete S.pinSrc[k]; }]);
  });
  (S.rules.apart || []).forEach((g, i) => items.push([`${g.max === 1 ? "Never together" : `At most ${g.max} together`}: <b>${esc(g.codes.join(", "))}</b>`, () => S.rules.apart.splice(i, 1)]));
  (S.rules.termLimits || []).forEach((x, i) => items.push([`<b>${esc(x.term)}</b>: ${[x.maxClasses != null ? `${x.maxClasses} classes max` : "", x.maxHours != null ? `${x.maxHours} hrs max` : ""].filter(Boolean).join(", ")}`, () => S.rules.termLimits.splice(i, 1)]));
  items.push([`Up to <b>${S.settings.maxHard}</b> hard and at least one easy class per semester when possible`, null]);
  box.innerHTML = "";
  items.forEach(([html, rm]) => {
    const c = document.createElement("span"); c.className = "rchip"; c.innerHTML = html;
    if (rm) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = "×"; b.setAttribute("aria-label", "Remove this rule");
      b.onclick = () => { rm(); S.reqDone = S.requests; S.place = schedule(S); save(); renderPlan(); toast("Removed. Plan rebuilt."); };
      c.append(b);
    } else c.style.paddingRight = "10px";
    box.append(c);
  });
}

/* ---------- step 3: plan board ---------- */
const NS = "http://www.w3.org/2000/svg", board = $("board"), svg = $("wires"), scroller = $("scroller");
let T = [], G = { by: {}, edges: [] }, cards = {}, cols = [], sel = null;
const kindClass = (c) => (c.status === "current" ? "nowc" : c.easy ? "easy" : c.kind);
const ctx = () => ({ terms: T, graph: G, place: S.place });
const PIN_SVG = '<svg viewBox="0 0 12 14" aria-hidden="true"><path d="M3 1h6l-1 4 2 3H2l2-3z"/><path d="M6 8v5"/></svg>';
const GRIP_SVG = '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';

function renderPlan() {
  T = makeTerms(S.settings); G = buildGraph(S.courses); S.place = reconcile(S, S.place);
  const order = S.courses.map((c) => c.code).filter((k) => S.place[k] != null);
  const unsched = order.some((k) => S.place[k] === T.length);
  const ncol = T.length + (unsched ? 1 : 0);
  const { perTerm } = totals(S, S.place);
  board.style.gridTemplateColumns = `repeat(${ncol},minmax(180px,1fr))`;
  board.style.minWidth = ncol * 240 + "px";
  board.querySelectorAll(".col").forEach((n) => n.remove());
  cards = {}; cols = [];
  const st = S.settings;
  for (let ti = 0; ti < ncol; ti++) {
    const isU = ti === T.length, term = T[ti] || { t: "Doesn't fit yet", s: "" };
    const ks = order.filter((k) => S.place[k] === ti);
    const hrs = isU ? ks.reduce((a, k) => a + G.by[k].hours, 0) : perTerm[ti];
    const hard = ks.filter((k) => G.by[k].hard).length, easy = ks.some((k) => G.by[k].easy);
    const col = document.createElement("section");
    col.className = "col" + (term.cur ? " now" : "") + (ti === 1 ? " next" : "") + (term.s === "Summer" ? " summer" : "") + (isU ? " unsched" : "");
    col.dataset.ti = ti;
    col.setAttribute("aria-label", term.t);
    let pills = "";
    if (isU) pills = `<span class="pill warn">Add a semester or move these</span>`;
    else if (ks.length && !term.cur) {
      if (hard) pills += `<span class="pill ${hard > st.maxHard ? "warn" : "hardp"}">${hard} hard</span>`;
      if (easy) pills += `<span class="pill easyp">Easy class</span>`;
      const cap = term.s === "Summer" ? st.summerMax : st.semMax;
      if (hrs > cap) pills += `<span class="pill warn">Over ${cap} hrs</span>`;
      else if (term.s !== "Summer" && hrs < 12) pills += `<span class="pill warn">Under full time</span>`;
    }
    col.innerHTML = `<div class="colhead"><div class="hr"><h3>${esc(term.t)}</h3><span class="hrs">${hrs} hrs</span></div><div class="colstat">${ti === 1 ? '<span class="next-tag">Register next</span>' : ""}${term.cur ? '<span class="pill">Now · locked</span>' : ""}${pills}</div></div>`;
    if (!ks.length) col.insertAdjacentHTML("beforeend", `<div class="empty">Drop a class here</div>`);
    ks.forEach((code) => {
      const c = G.by[code], lock = !!term.cur, pinned = !lock && S.pins[code] != null;
      const el = document.createElement("div");
      el.className = "card " + kindClass(c) + (lock ? " locked" : "") + (pinned ? " pinned" : "");
      el.tabIndex = 0; el.dataset.code = code;
      el.setAttribute("aria-label", `${code} ${c.name}, ${term.t}${pinned ? ", pinned" : ""}`);
      const tags = (c.hard ? '<span class="tag hard">Hard</span>' : "") + (c.easy ? '<span class="tag">Easy</span>' : "") + (c.offered !== "any" ? `<span class="tag">${c.offered === "fall" ? "Fall" : "Spring"} only</span>` : "");
      const pre = G.edges.filter((e) => e[1] === code).map((e) => e[0] + (e[2] ? " (same term OK)" : ""));
      el.innerHTML = `<div class="code"><span>${esc(code)}</span><span class="hrs">${c.hours}</span></div><div class="name">${esc(c.name)}</div>${tags ? `<div class="tags">${tags}</div>` : ""}${pre.length ? `<span class="needs">Needs ${esc(pre.join(", "))}</span>` : ""}` +
        (lock ? "" : `<button class="pinbtn" type="button" data-pin="${esc(code)}" aria-pressed="${pinned}" aria-label="${pinned ? "Unpin " + esc(code) : "Pin " + esc(code) + " to " + esc(term.t)}" title="${pinned ? "Pinned here. Tap to let auto mode move it" : "Pin to this semester"}">${PIN_SVG}</button><span class="grip" title="Hold to drag">${GRIP_SVG}</span>`);
      col.appendChild(el); cards[code] = el;
    });
    board.appendChild(col); cols.push(col);
  }
  $("reqTxt").value = S.requests || "";
  renderRules(); renderBar();
  requestAnimationFrame(draw);
}
function renderBar() {
  const { years } = totals(S, S.place), target = S.settings.yearTarget;
  $("bar").innerHTML = years.map((y) => `<div class="year ${y.final ? "fin" : y.met ? "good" : "short"}"><span class="lbl">${y.label}${y.final ? " · final" : ""}</span><span class="num">${y.hours} hrs</span><span class="st">${y.final ? "Final year" : y.met ? `${target} met` : `Short by ${y.short}`}</span></div>`).join("");
}

/* prerequisite wires */
function wireColor(f) { const srcs = [...new Set(G.edges.map((e) => e[0]))]; return `var(--e${srcs.indexOf(f) % 8})`; }
function roundPath(pts, r = 7) {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1], [x, y] = pts[i], [x1, y1] = pts[i + 1];
    const a = Math.min(r, Math.hypot(x - x0, y - y0) / 2), c = Math.min(r, Math.hypot(x1 - x, y1 - y) / 2);
    const ux = Math.sign(x - x0), uy = Math.sign(y - y0), vx = Math.sign(x1 - x), vy = Math.sign(y1 - y);
    d += ` L${x - ux * a},${y - uy * a} Q${x},${y} ${x + vx * c},${y + vy * c}`;
  }
  const l = pts[pts.length - 1];
  return d + ` L${l[0]},${l[1]}`;
}
function draw() {
  if ($("s3").hidden) return;
  const P = S.place, edges = G.edges.filter(([f, t]) => cards[f] && cards[t]);
  const span = (f, t) => P[t] - P[f];
  const longs = edges.filter((e) => span(e[0], e[1]) > 1).sort((x, y) => P[x[0]] - P[y[0]] || P[x[1]] - P[y[1]]);
  board.style.paddingBottom = 40 + longs.length * 7 + "px";
  const b = board.getBoundingClientRect(), R = {};
  Object.entries(cards).forEach(([k, c]) => { const r = c.getBoundingClientRect(); R[k] = { l: r.left - b.left, r: r.right - b.left, t: r.top - b.top, b: r.bottom - b.top, cy: r.top - b.top + r.height / 2 }; });
  if (!Object.keys(R).length) { svg.innerHTML = ""; return; }
  const colRight = (i) => cols[i].getBoundingClientRect().right - b.left - 6;
  const outP = {}, inP = {};
  Object.keys(cards).forEach((k) => {
    const sortBy = (end) => (x, y) => (span(x[0], x[1]) > 1) - (span(y[0], y[1]) > 1) || R[x[end]].cy - R[y[end]].cy;
    const o = edges.filter((e) => e[0] === k && span(e[0], e[1]) > 0).sort(sortBy(1));
    const i = edges.filter((e) => e[1] === k && span(e[0], e[1]) > 0).sort(sortBy(0));
    const h = R[k].b - R[k].t;
    o.forEach((e, n) => { outP[e[0] + ">" + e[1]] = R[k].t + h * (o.length === 1 ? 0.5 : 0.22 + (0.56 * n) / (o.length - 1)); });
    i.forEach((e, n) => { inP[e[0] + ">" + e[1]] = R[k].t + h * (i.length === 1 ? 0.5 : 0.22 + (0.56 * n) / (i.length - 1)); });
  });
  const laneBase = Math.max(...Object.values(R).map((r) => r.b)) + 22, gut = {};
  const slot = (g, k) => { (gut[g] ||= []); if (!gut[g].includes(k)) gut[g].push(k); return gut[g].indexOf(k); };
  longs.forEach(([f, t]) => slot(P[f], "o" + f + ">" + t));
  longs.forEach(([f, t]) => slot(P[t] - 1, "i" + f + ">" + t));
  const srcs = [...new Set(G.edges.map((e) => e[0]))];
  svg.innerHTML = "<defs>" + srcs.map((c, n) => `<marker id="ah${n}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="fill:${wireColor(c)}"/></marker>`).join("") + "</defs>";
  edges.forEach(([f, t]) => {
    const n = srcs.indexOf(f), color = wireColor(f), k = f + ">" + t, sp = span(f, t);
    let d, sx, sy;
    if (sp <= 0) { sx = R[f].l + 14; sy = R[f].b; const ty = R[t].t; if (ty < sy) return; d = `M${sx},${sy} L${sx},${ty - 2}`; }
    else if (sp === 1) { sx = R[f].r; sy = outP[k]; const x2 = R[t].l - 3, y2 = inP[k], m = (x2 - sx) * 0.5; d = `M${sx},${sy} C${sx + m},${sy} ${x2 - m},${y2} ${x2},${y2}`; }
    else {
      sx = R[f].r; sy = outP[k];
      const lane = laneBase + longs.findIndex((e) => e[0] === f && e[1] === t) * 7;
      const g1 = colRight(P[f]) + 12 + slot(P[f], "o" + k) * 5, g2 = colRight(P[t] - 1) + 12 + slot(P[t] - 1, "i" + k) * 5, gx2 = Math.max(g2, g1 + 12);
      d = roundPath([[sx, sy], [g1, sy], [g1, lane], [gx2, lane], [gx2, inP[k]], [R[t].l - 3, inP[k]]]);
    }
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d); p.setAttribute("class", "w" + (sp <= 0 ? " co" : "")); p.style.stroke = color; p.setAttribute("marker-end", `url(#ah${n})`);
    p.dataset.f = f; p.dataset.t = t; svg.appendChild(p);
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", sx); dot.setAttribute("cy", sy); dot.setAttribute("r", 3); dot.setAttribute("class", "port"); dot.style.fill = color;
    dot.dataset.f = f; dot.dataset.t = t; svg.appendChild(dot);
  });
  if (sel && cards[sel]) focusChain(sel);
}
function chain(code, dir, set = new Set()) {
  G.edges.forEach(([f, t]) => { const n = dir > 0 ? (f === code ? t : null) : (t === code ? f : null); if (n && !set.has(n)) { set.add(n); chain(n, dir, set); } });
  return set;
}
function focusChain(code) {
  sel = code; board.classList.add("focus");
  const lit = new Set([code, ...chain(code, 1), ...chain(code, -1)]);
  Object.entries(cards).forEach(([k, c]) => { c.classList.toggle("lit", lit.has(k)); c.classList.toggle("sel", k === code); });
  svg.querySelectorAll("path.w,circle.port").forEach((p) => p.classList.toggle("lit", lit.has(p.dataset.f) && lit.has(p.dataset.t)));
}
function clearFocus() {
  sel = null; board.classList.remove("focus");
  Object.values(cards).forEach((c) => c.classList.remove("lit", "sel"));
  svg.querySelectorAll(".lit").forEach((p) => p.classList.remove("lit"));
}

/* moving classes */
function moveTo(code, ti) {
  if (S.place[code] === ti) return false;
  const why = moveProblem(ctx(), code, ti);
  if (why) { toast(why, true); return false; }
  S.place[code] = ti;
  if (ti < T.length) { S.pins[code] = T[ti].t; S.pinSrc[code] = "drag"; } else { delete S.pins[code]; delete S.pinSrc[code]; }
  save(); renderPlan();
  toast(ti >= T.length ? `Moved ${code} out of the plan.` : `Moved ${code} to ${T[ti].t} and pinned it there.`);
  return true;
}
let drag = null, ghost = null, raf = null, justDragged = false;
board.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".pinbtn")) return;
  const card = e.target.closest(".card");
  if (!card || card.classList.contains("locked")) return;
  const onGrip = !!e.target.closest(".grip");
  if (e.pointerType !== "mouse" && !onGrip) return; // on touch screens, drag by the grip so the board can still scroll
  if (e.button) return;
  drag = { code: card.dataset.code, x: e.clientX, y: e.clientY, el: card, started: false, px: e.clientX, py: e.clientY };
  if (onGrip) e.preventDefault();
});
function colAt(x, y) { const el = document.elementFromPoint(x, y); const c = el?.closest?.(".col"); return c ? +c.dataset.ti : null; }
function startDrag() {
  drag.started = true; clearFocus(); focusChain(drag.code);
  board.classList.add("dragging"); drag.el.classList.add("moving");
  cols.forEach((c, i) => { const ok = S.place[drag.code] === i || !moveProblem(ctx(), drag.code, i); c.classList.toggle("ok", ok); c.classList.toggle("no", !ok); });
  ghost = drag.el.cloneNode(true); ghost.classList.remove("moving", "sel", "lit"); ghost.classList.add("ghost"); document.body.appendChild(ghost);
  const loop = () => {
    if (!drag) return;
    const r = scroller.getBoundingClientRect();
    if (drag.px < r.left + 70) scroller.scrollLeft -= 14; else if (drag.px > r.right - 70) scroller.scrollLeft += 14;
    const ti = colAt(drag.px, drag.py);
    cols.forEach((c, i) => c.classList.toggle("over", i === ti));
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
}
window.addEventListener("pointermove", (e) => {
  if (!drag) return;
  drag.px = e.clientX; drag.py = e.clientY;
  if (!drag.started) { if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return; startDrag(); }
  e.preventDefault();
  ghost.style.left = e.clientX - 90 + "px"; ghost.style.top = e.clientY - 20 + "px";
}, { passive: false });
function endDrag(e, cancel) {
  if (!drag) return;
  const d = drag; drag = null; cancelAnimationFrame(raf);
  if (ghost) { ghost.remove(); ghost = null; }
  if (!d.started) return;
  justDragged = true; setTimeout(() => (justDragged = false), 0);
  board.classList.remove("dragging"); cols.forEach((c) => c.classList.remove("ok", "no", "over")); d.el.classList.remove("moving");
  const ti = cancel ? null : colAt(e.clientX, e.clientY);
  clearFocus();
  if (ti != null && ti !== S.place[d.code]) moveTo(d.code, ti);
}
window.addEventListener("pointerup", (e) => endDrag(e));
window.addEventListener("pointercancel", (e) => endDrag(e, true));
board.addEventListener("click", (e) => {
  if (justDragged) return;
  const pb = e.target.closest(".pinbtn");
  if (pb) {
    const k = pb.dataset.pin;
    if (S.pins[k] != null) { delete S.pins[k]; delete S.pinSrc[k]; toast(`Unpinned ${k}. Auto suggest can move it now.`); }
    else { S.pins[k] = T[S.place[k]].t; S.pinSrc[k] = "drag"; toast(`Pinned ${k} to ${S.pins[k]}.`); }
    save(); renderPlan();
    requestAnimationFrame(() => board.querySelector(`.pinbtn[data-pin="${CSS.escape(k)}"]`)?.focus());
    return;
  }
  const c = e.target.closest(".card");
  if (!c) return clearFocus();
  c.dataset.code === sel ? clearFocus() : focusChain(c.dataset.code);
});
board.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return clearFocus();
  const c = e.target.closest?.(".card");
  if (!c || e.target.closest(".pinbtn")) return;
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); c.click(); return; }
  if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !c.classList.contains("locked")) {
    e.preventDefault();
    const code = c.dataset.code, ti = S.place[code] + (e.key === "ArrowRight" ? 1 : -1);
    if (ti < 0 || ti > cols.length - 1) return;
    if (moveTo(code, ti)) { const n = cards[code]; n?.focus(); n?.scrollIntoView({ block: "nearest", inline: "nearest" }); }
  }
});
$("addSem").onclick = () => {
  const oldN = T.length;
  S.settings.extra = (+S.settings.extra || 0) + 1;
  const newN = makeTerms(S.settings).length;
  Object.keys(S.place).forEach((k) => { if (S.place[k] >= oldN) S.place[k] = newN; });
  save(); renderPlan(); toast("Added a semester. Drag classes into it, or press Auto suggest again.");
};
$("rebuild").onclick = () => {
  S.place = schedule(S); save(); renderPlan();
  const iss = pinIssues(S, S.place);
  toast(iss.length ? iss.join(". ") + "." : "New suggestion ready. Your pinned classes stayed put.", iss.length > 0);
};
new ResizeObserver(() => requestAnimationFrame(draw)).observe(board);

/* ---------- save and open copies ---------- */
$("exportBtn").onclick = () => {
  const data = JSON.stringify({ app: "degree-flow", v: 2, settings: S.settings, courses: S.courses, place: S.place, pins: S.pins, pinSrc: S.pinSrc, rules: S.rules, requests: S.requests }, null, 2);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  a.download = "degree-flow-plan.json";
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("Saved degree-flow-plan.json.");
};
$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!d || d.app !== "degree-flow" || !Array.isArray(d.courses) || !d.settings) throw 0;
    S = {
      ...fresh(), settings: { ...DEFAULT_SETTINGS, ...d.settings }, courses: cleanCourses(d.courses),
      place: d.place && typeof d.place === "object" ? d.place : null,
      pins: d.pins && typeof d.pins === "object" ? d.pins : {}, pinSrc: d.pinSrc && typeof d.pinSrc === "object" ? d.pinSrc : {},
      rules: { ...emptyRules(), ...(d.rules || {}) }, requests: String(d.requests || ""), reqDone: String(d.requests || ""), step: 3,
    };
    save(); go(3); toast("Opened your saved plan.");
  } catch { toast("That file isn't a Degree Flow plan.", true); }
};

/* ---------- start ---------- */
$("exportBtn").hidden = false;
go(S.step || 3);
document.fonts?.ready.then(() => requestAnimationFrame(draw));
connectAI().then((ai) => {
  AI = ai;
  const note = $("aiNote"), drop = $("dropNote");
  if (!AI) {
    drop.textContent = "The AI reader isn't set up here. You can still type your classes.";
    note.textContent = "AI reader: off. Typed requests are off too, but dragging and pinning work.";
    $("readBtn").disabled = true;
  } else {
    drop.textContent = `A PDF, or PNG, JPG or WebP screenshots. Up to ${AI.maxImages} images or pages. You can also paste a screenshot.`;
    note.textContent = AI.source === "claude.ai" ? "AI reader: on, using your Claude account." : `AI reader: on${AI.model ? ` (${AI.model})` : ""}.`;
  }
});
