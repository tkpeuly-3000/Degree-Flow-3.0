// Tests for the free reading engine: the rules that turn chart text into classes and prerequisites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { leadingCode, codesIn, parsePrereqText, readCourses } from "../public/js/engine/parse.js";
import { colorName, clusterColors, excelColor, themeFromXml } from "../public/js/engine/colors.js";
import { mergePages } from "../public/js/engine/index.js";

const cells = JSON.parse(readFileSync(new URL("./fixtures/sample-flowchart-cells.json", import.meta.url)));
const { courses, palette } = readCourses(cells, { units: "cells" });
const by = Object.fromEntries(courses.map((c) => [c.code, c]));

test("course codes are found at the start of a box, but not term labels", () => {
  assert.deepEqual(leadingCode("ME 3370 (FLUIDS)"), { code: "ME 3370", fixed: false });
  assert.deepEqual(leadingCode("ME 33O3"), { code: "ME 3303", fixed: true }, "letter O read as zero");
  assert.equal(leadingCode("Fall 2026"), null);
  assert.equal(leadingCode("(CAL I)"), null);
});

test("prerequisite lines: shared departments, slashes and 'may be taken concurrently'", () => {
  assert.deepEqual(codesIn("PR: ME 3303, 3370"), ["ME 3303", "ME 3370"]);
  assert.deepEqual(codesIn("PR:CHEM 1307/1107"), ["CHEM 1307", "CHEM 1107"]);
  assert.deepEqual(parsePrereqText("PR: ME 3311, 2302, 3365 PR: ME 3371 (May be taken concurrently)"),
    { prereqs: ["ME 3311", "ME 2302", "ME 3365"], coreqs: ["ME 3371"] });
  assert.deepEqual(parsePrereqText("PR: ME 2301 (May be taken as FNDL Student)"), { prereqs: ["ME 2301"], coreqs: [] });
  assert.deepEqual(parsePrereqText("PR MATH 1451"), { prereqs: ["MATH 1451"], coreqs: [] }, "colon missing");
});

test("the sample flowchart reads all 45 boxes", () => {
  assert.equal(courses.length, 45);
  for (const code of ["MATH 1451", "ME 2302", "ME 4371", "POLS 2306", "ORAL/SPCH ELEC", "CREATIVE ARTS ELECTIVE", "DEPT ELECTIVE 4", "HIST ELEC 2"])
    assert.ok(by[code], `${code} found`);
  assert.ok(!courses.some((c) => /2026|AEROSPACE|STUDENT/i.test(c.code)), "no labels or notes read as classes");
});

test("names, hours, bold and colors come from the boxes", () => {
  assert.equal(by["ME 3370"].name, "FLUIDS");
  assert.equal(by["MATH 1451"].hours, 4);
  assert.equal(by["ME 2207"].hours, 2);
  assert.equal(by["ME 3370"].bold, true);
  assert.equal(by["ME 3311"].bold, false);
  assert.equal(colorName(by["MATH 1451"].color), "yellow");
  assert.equal(colorName(by["ME 2322"].color), "orange");
  assert.equal(colorName(by["ME 2302"].color), "red");
  assert.equal(colorName(by["ME 3370"].color), "pink");
  assert.equal(by["ME 3365"].color, null, "white boxes have no color");
  assert.deepEqual(palette.map((p) => p.name), ["yellow", "pink", "orange", "red"]);
});

test("prerequisites, including ones split over two lines", () => {
  assert.deepEqual(by["ME 2315"].prereqs, ["ENGR 1330", "MATH 1452", "PHYS 1408"]);
  assert.deepEqual(by["ME 3333"].prereqs, ["MATH 3350", "PHYS 2401", "ME 2315", "ME 2302"]);
  assert.deepEqual(by["ME 4370"].prereqs, ["ME 3311", "ME 2302", "ME 3365"]);
  assert.deepEqual(by["ME 4370"].coreqs, ["ME 3371"]);
  assert.deepEqual(by["ME 4234"].coreqs, ["ME 4334"]);
  assert.deepEqual(by["ME 4251"].prereqs, ["ME 3370", "ME 3322", "ME 3371"]);
  assert.deepEqual(by["MATH 2450"].prereqs, ["MATH 1452"], "the 'Fall 2026' label under it is not a prerequisite");
});

test("electives and class types", () => {
  assert.equal(by["DEPT ELECTIVE 1"].kind, "elective");
  assert.equal(by["ME 3370"].kind, "core");
  assert.equal(by["MATH 1451"].kind, "gen");
});

test("colors: names, grouping, and Excel's theme and tint colors", () => {
  assert.equal(colorName("#FFFF00"), "yellow");
  assert.equal(colorName("#FFC7CE"), "pink");
  assert.equal(colorName("#E26B0A"), "orange");
  assert.equal(colorName("#FFFFFF"), "white");
  assert.equal(clusterColors(["#FFFF00", "#FEFE05", "#FF0000"]).length, 2, "near identical shades group together");
  assert.equal(excelColor({ argb: "FFFFFF00" }), "#FFFF00");
  assert.equal(excelColor({ theme: 5 }), "#ED7D31", "Office accent 2");
  assert.equal(excelColor({ theme: 0, tint: -0.5 }), "#808080");
  assert.equal(themeFromXml('<a:accent2><a:srgbClr val="123456"/></a:accent2>')[5], "123456");
});

test("overlapping screenshots: the same class on two pages is one class", () => {
  const page = (list) => ({ courses: list.map(([code, y, kind = "core"]) => ({ code, kind, prereqs: [], coreqs: [], fill: null, where: { y0: y, y1: y + 10 } })) });
  const out = mergePages([
    page([["ME 2301", 10], ["ME 3370", 50], ["DEPT ELECTIVE", 80, "elective"]]),
    page([["ME 3370", 5], ["DEPT ELECTIVE", 6, "elective"], ["ME 4371", 60], ["DEPT ELECTIVE", 70, "elective"]]),
  ]);
  assert.deepEqual(out.courses.map((c) => c.code), ["ME 2301", "ME 3370", "DEPT ELECTIVE 1", "ME 4371", "DEPT ELECTIVE 2"]);
});
