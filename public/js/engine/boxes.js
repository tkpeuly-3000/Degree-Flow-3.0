// Finds the colored box behind each piece of text in a picture, and whether text is bold.
// Works on a canvas (a rendered PDF page or an uploaded image).
import { rgbToHex, colorDistance, isNearWhite } from "./colors.js";

const WORK = 1400; // analysis size; big enough for boxes, small enough to be fast

export function analyzeCanvas(canvas) {
  const sc = Math.min(1, WORK / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * sc)), h = Math.max(1, Math.round(canvas.height * sc));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(canvas, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data;
  const region = new Int32Array(w * h).fill(-1);
  const regions = [];
  const at = (x, y) => { const i = (y * w + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };

  /** Most common color in the ring just outside a rectangle (the background the text sits on). */
  function backgroundAround(x0, y0, x1, y1) {
    const counts = new Map();
    const pad = 3;
    const visit = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const [r, gg, b] = at(x, y);
      const k = ((r >> 4) << 8) | ((gg >> 4) << 4) | (b >> 4);
      const e = counts.get(k) || { n: 0, x, y, sum: [0, 0, 0] };
      e.n++; e.sum[0] += r; e.sum[1] += gg; e.sum[2] += b;
      counts.set(k, e);
    };
    for (let x = x0 - pad; x <= x1 + pad; x++) { visit(x, y0 - pad); visit(x, y1 + pad); visit(x, y0 - 1); visit(x, y1 + 1); }
    for (let y = y0 - pad; y <= y1 + pad; y++) { visit(x0 - pad, y); visit(x1 + pad, y); visit(x0 - 1, y); visit(x1 + 1, y); }
    // also the gaps between letters
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) visit(x, y);
    let best = null;
    for (const e of counts.values()) if (!best || e.n > best.n) best = e;
    return best ? { rgb: best.sum.map((v) => v / best.n), seed: [best.x, best.y] } : null;
  }

  /** Paint bucket fill from a seed, comparing every pixel to the seed color (no drifting through borders). */
  function fill(seed, rgb) {
    const id = regions.length, stack = [seed[1] * w + seed[0]];
    let n = 0, minX = w, minY = h, maxX = 0, maxY = 0;
    while (stack.length) {
      const p = stack.pop();
      if (region[p] !== -1) continue;
      const x = p % w, y = (p / w) | 0;
      if (colorDistance(at(x, y), rgb) > 70) continue;
      region[p] = id; n++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0) stack.push(p - 1); if (x < w - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - w); if (y < h - 1) stack.push(p + w);
    }
    const r = { id, area: n, x0: minX / sc, y0: minY / sc, x1: (maxX + 1) / sc, y1: (maxY + 1) / sc, rgb };
    // The page itself, not a box: it covers too much.
    r.isPage = n > w * h * 0.25 || (maxX - minX) > w * 0.6 || (maxY - minY) > h * 0.5;
    regions.push(r);
    return r;
  }

  /** For a text rectangle in canvas pixels: its box (or null), fill color, and how much ink it has. */
  function locate(rect) {
    const x0 = Math.max(0, Math.floor(rect.x0 * sc)), y0 = Math.max(0, Math.floor(rect.y0 * sc));
    const x1 = Math.min(w - 1, Math.ceil(rect.x1 * sc)), y1 = Math.min(h - 1, Math.ceil(rect.y1 * sc));
    const bg = backgroundAround(x0, y0, x1, y1);
    if (!bg) return { box: null, fill: null, ink: 0 };
    const [sx, sy] = bg.seed;
    let r = region[sy * w + sx] >= 0 ? regions[region[sy * w + sx]] : fill(bg.seed, bg.rgb);
    // ink: share of pixels in the text rectangle that clearly differ from the background
    let ink = 0, tot = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { tot++; if (colorDistance(at(x, y), bg.rgb) > 160) ink++; }
    const white = isNearWhite(bg.rgb);
    return {
      box: r.isPage ? null : r.id,
      boxRect: r.isPage ? null : { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 },
      fill: white ? null : rgbToHex(bg.rgb),
      ink: tot ? ink / tot : 0,
    };
  }
  return { locate };
}

/**
 * Mark bold text from ink density: titles drawn noticeably heavier than other titles of the same size are bold.
 * Only used for pictures, where fonts aren't known.
 */
export function markBoldByInk(blocks) {
  const titles = blocks.filter((b) => b.title && b.ink > 0);
  if (titles.length < 4) return;
  const byHeight = (b) => Math.round((b.y1 - b.y0) / 3);
  const groups = {};
  titles.forEach((b) => (groups[byHeight(b)] ||= []).push(b));
  const all = titles.map((b) => b.ink).sort((a, b) => a - b);
  const low = all[Math.floor(all.length * 0.25)];
  titles.forEach((b) => {
    const g = groups[byHeight(b)];
    const ref = g.length >= 3 ? g.map((x) => x.ink).sort((a, c) => a - c)[Math.floor(g.length * 0.25)] : low;
    b.bold = b.ink > ref * 1.28;
  });
}

/**
 * Make text easier to recognize on colored boxes. First find the big areas of one color (box fills and
 * the page). Each other pixel is compared with the area just to its left: if it is clearly different
 * or much darker it is ink (black), otherwise it is background (white). Black text on yellow and dark
 * red text on a red box both become black on white, and light grid lines disappear.
 */
export function cleanForOcr(src, targetWidth = 2600) {
  const sc = Math.min(3, Math.max(1, targetWidth / src.width));
  const w = Math.round(src.width * sc), h = Math.round(src.height * sc), N = w * h;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, w, h);
  const img = g.getImageData(0, 0, w, h), d = img.data;
  const lum = (i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const dist = (i, rgb) => colorDistance([d[i], d[i + 1], d[i + 2]], rgb);

  // 1. Big single color areas (paint bucket from a grid of seeds).
  const label = new Int32Array(N).fill(-1); // -1 unvisited, -2 small area, >= 0 big area id
  const colors = [];
  const minArea = Math.max(400, N * 0.0006);
  const stack = new Int32Array(N);
  const visit = [];
  for (let sy = 2; sy < h; sy += 6) for (let sx = 2; sx < w; sx += 6) {
    const s0 = sy * w + sx;
    if (label[s0] !== -1) continue;
    const si = s0 * 4, seed = [d[si], d[si + 1], d[si + 2]];
    let top = 0, n = 0, sum = [0, 0, 0];
    stack[top++] = s0; label[s0] = -3; visit.length = 0;
    while (top) {
      const p = stack[--top], i = p * 4;
      visit.push(p); n++; sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2];
      const x = p % w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < N - w ? p + w : -1];
      for (const q of nb) if (q >= 0 && label[q] === -1 && dist(q * 4, seed) < 45) { label[q] = -3; stack[top++] = q; }
    }
    const id = n >= minArea ? colors.length : -2;
    if (id >= 0) colors.push([sum[0] / n, sum[1] / n, sum[2] / n]);
    for (const p of visit) label[p] = id;
  }

  // 2. Ink or background, judged against the nearest big area to the left (or above).
  const out = new Uint8ClampedArray(N);
  for (let y = 0; y < h; y++) {
    let bg = y > 0 ? null : [255, 255, 255];
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      if (label[p] >= 0) { bg = colors[label[p]]; out[p] = 255; continue; }
      if (!bg) { // nothing to the left yet: look up
        for (let yy = y - 1; yy >= 0; yy--) if (label[yy * w + x] >= 0) { bg = colors[label[yy * w + x]]; break; }
        bg ||= [255, 255, 255];
      }
      const bl = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
      const ink = dist(i, bg) > 135 || lum(i) < bl * 0.68;
      out[p] = ink ? 0 : 255;
    }
  }
  // 3. Erase lines and solid bars (borders, grid lines, column gaps): letters never have ink runs this long.
  const L = Math.round(Math.max(40, 26 * sc));
  const erase = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x <= w; x++) {
      if (x < w && out[y * w + x] === 0) { run++; continue; }
      if (run >= L) for (let k = x - run; k < x; k++) erase[y * w + k] = 1;
      run = 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let run = 0;
    for (let y = 0; y <= h; y++) {
      if (y < h && out[y * w + x] === 0) { run++; continue; }
      if (run >= L) for (let k = y - run; k < y; k++) erase[k * w + x] = 1;
      run = 0;
    }
  }
  for (let p = 0; p < N; p++) if (erase[p]) out[p] = 255;
  for (let p = 0, i = 0; p < N; p++, i += 4) d[i] = d[i + 1] = d[i + 2] = out[p];
  g.putImageData(img, 0, 0);
  return { canvas: c, scale: sc };
}
