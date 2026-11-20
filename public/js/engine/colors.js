// Color helpers for the reading engine: Excel color formats, naming, and grouping similar colors.

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
export const rgbToHex = ([r, g, b]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();
export const hexToRgb = (h) => {
  const m = String(h || "").replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
};
export const colorDistance = (a, b) => {
  const [r1, g1, b1] = a, [r2, g2, b2] = b, rm = (r1 + r2) / 2;
  // "redmean" distance: close to how different two colors look to people
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
};
export const isNearWhite = (rgb) => rgb && Math.min(...rgb) >= 236;

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** Plain English name for a color, so students recognize it ("yellow", "light pink"). */
export function colorName(hexOrRgb) {
  const rgb = Array.isArray(hexOrRgb) ? hexOrRgb : hexToRgb(hexOrRgb);
  if (!rgb) return "no color";
  const [h, s, l] = rgbToHsl(rgb);
  if (s < 0.14 || (s < 0.25 && (l > 0.9 || l < 0.15))) return l > 0.92 ? "white" : l < 0.18 ? "black" : l > 0.6 ? "light gray" : "gray";
  let name =
    h < 12 || h >= 345 ? "red" : h < 40 ? "orange" : h < 68 ? "yellow" : h < 160 ? "green" : h < 195 ? "teal" : h < 255 ? "blue" : h < 290 ? "purple" : "pink";
  if (name === "red" && l > 0.72) name = "pink";
  if (name === "orange" && l < 0.32) name = "brown";
  if (name === "orange" && l > 0.8) name = "peach";
  const shade = l > 0.8 && name !== "pink" && name !== "peach" ? "light " : l < 0.3 && name !== "brown" ? "dark " : "";
  return shade + name;
}

/** Group colors that look alike. Returns [{hex, name, members:[index]}], biggest group first. */
export function clusterColors(hexes, threshold = 60) {
  const groups = [];
  hexes.forEach((hex, i) => {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    let g = groups.find((x) => colorDistance(x.rgb, rgb) < threshold);
    if (!g) { g = { rgb, sum: [0, 0, 0], members: [] }; groups.push(g); }
    g.members.push(i);
    g.sum = g.sum.map((v, k) => v + rgb[k]);
    g.rgb = g.sum.map((v) => v / g.members.length);
  });
  return groups
    .map((g) => ({ hex: rgbToHex(g.rgb), name: colorName(g.rgb), members: g.members }))
    .sort((a, b) => b.members.length - a.members.length);
}

/* ---------- Excel colors ---------- */
// Excel's default "Office" theme, in the order styles refer to it (light 1, dark 1, light 2, dark 2, accents 1 to 6).
const OFFICE_THEME = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"];
// The classic 64 color palette used by "indexed" colors.
const INDEXED = ("000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF " +
  "800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF " +
  "000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 " +
  "3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333").split(" ");

/** Read the workbook's own theme colors, falling back to the Office defaults. */
export function themeFromXml(xml) {
  if (!xml) return OFFICE_THEME;
  const pick = (tag) => {
    const m = xml.match(new RegExp(`<a:${tag}>\\s*<a:(?:srgbClr val|sysClr[^>]*lastClr)="([0-9A-Fa-f]{6})"`));
    return m ? m[1].toUpperCase() : null;
  };
  const t = [pick("lt1"), pick("dk1"), pick("lt2"), pick("dk2"), ...[1, 2, 3, 4, 5, 6].map((n) => pick(`accent${n}`))];
  return t.map((v, i) => v || OFFICE_THEME[i]);
}

function applyTint(rgb, tint) {
  if (!tint) return rgb;
  return rgb.map((c) => (tint < 0 ? c * (1 + tint) : c + (255 - c) * tint));
}

/** Turn an ExcelJS color object ({argb} or {theme, tint} or {indexed}) into "#RRGGBB", or null. */
export function excelColor(c, theme = OFFICE_THEME) {
  if (!c) return null;
  let hex = null;
  if (typeof c.argb === "string") hex = c.argb.slice(-6);
  else if (Number.isInteger(c.theme)) hex = theme[c.theme] || null;
  else if (Number.isInteger(c.indexed)) hex = c.indexed === 64 ? null : INDEXED[c.indexed] || null;
  const rgb = hexToRgb(hex);
  return rgb ? rgbToHex(applyTint(rgb, c.tint || 0)) : null;
}
