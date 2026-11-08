/**
 * Environment analysis: finds places in the camera frame where something could believably be
 * partly hidden — doorways, door edges, the far end of a hallway, dark corners, shadowed gaps,
 * the top edge of furniture, windows, the top of a staircase.
 *
 * Works on a small luminance image (~160x120) in normalised frame coordinates (0..1 on both
 * axes, same space as the video texture). Lines come from a gradient-directed Hough transform;
 * regions from thresholded connected components. Everything is heuristic and cheap enough to
 * run a few times a second on a phone.
 */
import { clamp } from '../util/rng';

export interface LumaFrame {
  w: number;
  h: number;
  /** luminance 0..1, row-major */
  data: Float32Array;
}

export type SiteKind = 'doorway' | 'door-edge' | 'hallway' | 'dark-corner' | 'shadow' | 'furniture' | 'window' | 'stairs';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An edge something can hide behind. `open` is the side on which a hidden thing would show. */
export interface Occluder {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  orientation: 'vertical' | 'horizontal';
  /** vertical: -1 open to the left, +1 open to the right. horizontal: -1 open above. */
  open: -1 | 1;
}

export interface Site {
  id: string;
  kind: SiteKind;
  box: Box;
  occluder?: Occluder;
  /** normalised frame-height units per metre at this site's depth */
  scale: number;
  /** y (normalised) of the floor at this site, if it can be estimated */
  floorY: number;
  /** 0..1 how dark the site is relative to the frame */
  darkness: number;
  /** 0..1 detection strength */
  score: number;
  /** mean luminance inside the site box (0..1), filled in after detection */
  meanLum?: number;
  /** consecutive analyses this site has been seen in */
  persistence: number;
  /** coarse cell mask for region sites (dark corners, shadows), cellsX x cellsY */
  region?: { cellsX: number; cellsY: number; cells: Uint8Array; bx: number; by: number; bw: number; bh: number };
}

interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** pixels */
  length: number;
  /** line normal angle in degrees, 0..180 */
  theta: number;
  strength: number;
}

export interface AnalysisResult {
  sites: Site[];
  segments: Segment[];
  mean: number;
  std: number;
  /** normalised global shift since the previous frame */
  motion: { dx: number; dy: number; magnitude: number };
  /** 0..1 frame-to-frame change within dark sites beyond sensor noise */
  irregularity: number;
}

const DOOR_HEIGHT_M = 2.03;

export function lumaFromRgba(rgba: Uint8ClampedArray, w: number, h: number, out?: Float32Array): LumaFrame {
  const data = out && out.length === w * h ? out : new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) data[i] = (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) / 255;
  return { w, h, data };
}

function boxBlur3(src: Float32Array, w: number, h: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = src[y * w + Math.max(0, x - 1)];
      const r = src[y * w + Math.min(w - 1, x + 1)];
      tmp[y * w + x] = (l + src[y * w + x] + r) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w;
    const dn = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) out[y * w + x] = (tmp[up + x] + tmp[y * w + x] + tmp[dn + x]) / 3;
  }
  return out;
}

function meanIn(img: Float32Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): number {
  const ax = clamp(Math.floor(Math.min(x0, x1)), 0, w - 1);
  const bx = clamp(Math.ceil(Math.max(x0, x1)), 0, w - 1);
  const ay = clamp(Math.floor(Math.min(y0, y1)), 0, h - 1);
  const by = clamp(Math.ceil(Math.max(y0, y1)), 0, h - 1);
  let s = 0;
  let n = 0;
  for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
    s += img[y * w + x];
    n++;
  }
  return n ? s / n : 0;
}

/** Mean luminance in a strip of width `wpx` beside a segment, on side -1 (left/above) or +1. */
function sideMean(img: Float32Array, w: number, h: number, s: Segment, side: -1 | 1, wpx: number): number {
  const steps = Math.max(4, Math.round(s.length / 3));
  const dx = s.x1 - s.x0;
  const dy = s.y1 - s.y0;
  const len = Math.hypot(dx, dy) || 1;
  // unit normal pointing to "side": for vertical-ish segments +1 = right, for horizontal +1 = below
  let nx = -dy / len;
  let ny = dx / len;
  if (Math.abs(nx) > Math.abs(ny) ? nx < 0 : ny < 0) {
    nx = -nx;
    ny = -ny;
  }
  let sum = 0;
  let n = 0;
  for (let i = 0; i <= steps; i++) {
    const t = 0.1 + 0.8 * (i / steps);
    const px = s.x0 + dx * t;
    const py = s.y0 + dy * t;
    for (let k = 2; k <= wpx + 1; k++) {
      const x = Math.round(px + nx * k * side);
      const y = Math.round(py + ny * k * side);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      sum += img[y * w + x];
      n++;
    }
  }
  return n ? sum / n : NaN;
}

function percentile(values: Float32Array, p: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.min(255, Math.floor(values[i] * 255))]++;
  const target = values.length * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) if ((acc += hist[i]) >= target) return i / 255;
  return 1;
}

/** Gradient-directed Hough transform returning straight segments. */
function detectSegments(img: Float32Array, w: number, h: number, sensitivity: number): Segment[] {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = img[i - w - 1], b = img[i - w], c = img[i - w + 1];
      const d = img[i - 1], f = img[i + 1];
      const g = img[i + w - 1], hh = img[i + w], k = img[i + w + 1];
      const sx = c + 2 * f + k - (a + 2 * d + g);
      const sy = g + 2 * hh + k - (a + 2 * b + c);
      gx[i] = sx;
      gy[i] = sy;
      mag[i] = Math.hypot(sx, sy);
    }
  }
  const magSorted = percentile(new Float32Array(mag.map((m) => Math.min(1, m / 4))), 0.86) * 4;
  const threshold = Math.max(0.05, magSorted * (1.25 - sensitivity * 0.5));

  const THETA_STEP = 2;
  const NT = 180 / THETA_STEP;
  const diag = Math.ceil(Math.hypot(w, h));
  const NR = diag * 2 + 1;
  const acc = new Float32Array(NT * NR);
  const cos = new Float32Array(NT);
  const sin = new Float32Array(NT);
  for (let t = 0; t < NT; t++) {
    const a = (t * THETA_STEP * Math.PI) / 180;
    cos[t] = Math.cos(a);
    sin[t] = Math.sin(a);
  }
  const edge = new Uint8Array(w * h);
  const edgeTheta = new Int16Array(w * h);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      if (mag[i] < threshold) continue;
      edge[i] = 1;
      let phi = (Math.atan2(gy[i], gx[i]) * 180) / Math.PI;
      if (phi < 0) phi += 180;
      const tc = Math.round(phi / THETA_STEP) % NT;
      edgeTheta[i] = tc;
      for (let dt = -3; dt <= 3; dt++) {
        const t = (tc + dt + NT) % NT;
        const r = Math.round(x * cos[t] + y * sin[t]) + diag;
        acc[t * NR + r] += mag[i];
      }
    }
  }

  // Peaks with non-maximum suppression.
  const peaks: { t: number; r: number; v: number }[] = [];
  const minVotes = threshold * Math.min(w, h) * 0.22 * 3;
  for (let t = 0; t < NT; t++) {
    for (let r = 1; r < NR - 1; r++) {
      const v = acc[t * NR + r];
      if (v < minVotes) continue;
      let isMax = true;
      for (let dt = -2; dt <= 2 && isMax; dt++) {
        const tt = (t + dt + NT) % NT;
        for (let dr = -3; dr <= 3; dr++) {
          if (!dt && !dr) continue;
          const rr = r + dr;
          if (rr < 0 || rr >= NR) continue;
          if (acc[tt * NR + rr] > v) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ t, r, v });
    }
  }
  peaks.sort((a, b) => b.v - a.v);

  const segments: Segment[] = [];
  for (const p of peaks.slice(0, 40)) {
    const ct = cos[p.t];
    const st = sin[p.t];
    const rho = p.r - diag;
    // Walk along the line direction (-sin, cos) through the frame.
    const x0 = ct * rho;
    const y0 = st * rho;
    const dx = -st;
    const dy = ct;
    let best = { a: 0, b: -1 };
    let runStart = -1;
    let lastHit = -999;
    for (let k = -diag; k <= diag; k++) {
      const fx = x0 + dx * k;
      const fy = y0 + dy * k;
      const x = Math.round(fx);
      const y = Math.round(fy);
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      let hit = false;
      for (let o = -1; o <= 1 && !hit; o++) {
        const xx = Math.round(fx + ct * o);
        const yy = Math.round(fy + st * o);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const i = yy * w + xx;
        if (edge[i] && Math.abs(((edgeTheta[i] - p.t + NT + NT / 2) % NT) - NT / 2) <= 4) hit = true;
      }
      if (hit) {
        if (k - lastHit > 4) runStart = k;
        lastHit = k;
        if (k - runStart > best.b - best.a) best = { a: runStart, b: k };
      }
    }
    const length = best.b - best.a;
    if (length < Math.min(w, h) * 0.18) continue;
    segments.push({
      x0: x0 + dx * best.a,
      y0: y0 + dy * best.a,
      x1: x0 + dx * best.b,
      y1: y0 + dy * best.b,
      length,
      theta: p.t * THETA_STEP,
      strength: p.v / (length * threshold * 7),
    });
  }
  // Drop near-duplicates (same line found at adjacent rho/theta).
  return segments.filter((s, i) =>
    !segments.slice(0, i).some((o) => Math.abs(o.theta - s.theta) <= 6 && Math.hypot((o.x0 + o.x1) / 2 - (s.x0 + s.x1) / 2, (o.y0 + o.y1) / 2 - (s.y0 + s.y1) / 2) < 5),
  );
}

const isVertical = (s: Segment) => s.theta <= 14 || s.theta >= 166;
const isHorizontal = (s: Segment) => Math.abs(s.theta - 90) <= 12;
const isDiagonal = (s: Segment) => !isVertical(s) && !isHorizontal(s) && s.theta > 20 && s.theta < 160;

/** Orients a vertical segment top-to-bottom, horizontal left-to-right. */
function orient(s: Segment): Segment {
  const swap = isVertical(s) ? s.y0 > s.y1 : s.x0 > s.x1;
  return swap ? { ...s, x0: s.x1, y0: s.y1, x1: s.x0, y1: s.y0 } : s;
}

interface Components {
  cellsX: number;
  cellsY: number;
  labels: Int32Array;
  comps: { id: number; count: number; minX: number; minY: number; maxX: number; maxY: number; sum: number }[];
}

function components(img: Float32Array, w: number, h: number, test: (v: number) => boolean, cell = 4): Components {
  const cellsX = Math.ceil(w / cell);
  const cellsY = Math.ceil(h / cell);
  const on = new Uint8Array(cellsX * cellsY);
  const val = new Float32Array(cellsX * cellsY);
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      let hit = 0;
      let n = 0;
      let s = 0;
      for (let y = cy * cell; y < Math.min(h, (cy + 1) * cell); y++) for (let x = cx * cell; x < Math.min(w, (cx + 1) * cell); x++) {
        const v = img[y * w + x];
        s += v;
        n++;
        if (test(v)) hit++;
      }
      on[cy * cellsX + cx] = hit >= n * 0.6 ? 1 : 0;
      val[cy * cellsX + cx] = s / n;
    }
  }
  const labels = new Int32Array(cellsX * cellsY).fill(-1);
  const comps: Components['comps'] = [];
  const stack: number[] = [];
  for (let i = 0; i < on.length; i++) {
    if (!on[i] || labels[i] >= 0) continue;
    const c = { id: comps.length, count: 0, minX: 1e9, minY: 1e9, maxX: -1, maxY: -1, sum: 0 };
    labels[i] = c.id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % cellsX;
      const y = (j / cellsX) | 0;
      c.count++;
      c.sum += val[j];
      c.minX = Math.min(c.minX, x);
      c.maxX = Math.max(c.maxX, x);
      c.minY = Math.min(c.minY, y);
      c.maxY = Math.max(c.maxY, y);
      const nb = [x > 0 ? j - 1 : -1, x < cellsX - 1 ? j + 1 : -1, y > 0 ? j - cellsX : -1, y < cellsY - 1 ? j + cellsX : -1];
      for (const k of nb) if (k >= 0 && on[k] && labels[k] < 0) {
        labels[k] = c.id;
        stack.push(k);
      }
    }
    comps.push(c);
  }
  return { cellsX, cellsY, labels, comps };
}

function intersect(a: Segment, b: Segment): { x: number; y: number } | undefined {
  const d = (a.x0 - a.x1) * (b.y0 - b.y1) - (a.y0 - a.y1) * (b.x0 - b.x1);
  if (Math.abs(d) < 1e-6) return undefined;
  const t = ((a.x0 - b.x0) * (b.y0 - b.y1) - (a.y0 - b.y0) * (b.x0 - b.x1)) / d;
  return { x: a.x0 + t * (a.x1 - a.x0), y: a.y0 + t * (a.y1 - a.y0) };
}

let siteSeq = 0;

export class EnvironmentAnalyzer {
  private prev?: Float32Array;
  private prevSites: Site[] = [];
  private irregularity = 0;

  analyze(frame: LumaFrame, sensitivity: number): AnalysisResult {
    const { w, h } = frame;
    const img = boxBlur3(frame.data, w, h);
    let sum = 0;
    for (let i = 0; i < img.length; i++) sum += img[i];
    const mean = sum / img.length;
    let v = 0;
    for (let i = 0; i < img.length; i++) v += (img[i] - mean) ** 2;
    const std = Math.sqrt(v / img.length);

    const segments = detectSegments(img, w, h, sensitivity).map(orient);
    const found: Omit<Site, 'id' | 'persistence'>[] = [];
    const nx = (x: number) => x / w;
    const ny = (y: number) => y / h;
    const contrastMin = 0.035 + 0.06 * (1 - sensitivity);

    const vert = segments.filter((s) => isVertical(s) && s.length >= h * 0.3);
    const horiz = segments.filter((s) => isHorizontal(s) && s.length >= w * 0.1);
    const diag = segments.filter((s) => isDiagonal(s) && s.length >= Math.hypot(w, h) * 0.15);
    const usedV = new Set<Segment>();
    const strip = Math.max(3, Math.round(w * 0.05));

    // --- doorways: two vertical edges enclosing a darker interior -------------------------
    for (let i = 0; i < vert.length; i++) {
      for (let j = 0; j < vert.length; j++) {
        const a = vert[i];
        const b = vert[j];
        const ax = (a.x0 + a.x1) / 2;
        const bx = (b.x0 + b.x1) / 2;
        if (bx <= ax) continue;
        const sep = (bx - ax) / w;
        if (sep < 0.08 || sep > 0.55) continue;
        const top = Math.max(a.y0, b.y0);
        const bot = Math.min(a.y1, b.y1);
        const overlap = bot - top;
        if (overlap < Math.min(a.length, b.length) * 0.6) continue;
        // Door openings are tall and reach well above the middle of the frame; a dark
        // object between two edges low in the frame (a chair, a cabinet) is not a doorway.
        if (top > h * 0.45 || overlap < h * 0.35) continue;
        const inside = meanIn(img, w, h, ax + 2, top, bx - 2, bot);
        const leftOut = sideMean(img, w, h, a, -1, strip);
        const rightOut = sideMean(img, w, h, b, 1, strip);
        const outside = Math.min(isNaN(leftOut) ? 1 : leftOut, isNaN(rightOut) ? 1 : rightOut);
        const contrast = outside - inside;
        if (contrast < contrastMin) continue;
        const height = overlap / h;
        const scale = Math.max(height, Math.max(a.length, b.length) / h) / DOOR_HEIGHT_M;
        found.push({
          kind: 'doorway',
          box: { x: nx(ax), y: ny(top), w: sep, h: height },
          occluder: chooseJamb(a, b, w, h),
          scale,
          floorY: Math.min(1.2, ny(Math.min(a.y0, b.y0)) + DOOR_HEIGHT_M * scale),
          darkness: clamp((mean - inside) / (std + 0.02) * 0.5 + 0.5, 0, 1),
          score: clamp(contrast * 4 + height * 0.5, 0, 1),
        });
        usedV.add(a);
        usedV.add(b);
      }
    }

    // --- door edges: one strong vertical edge with a dark gap on one side -----------------
    for (const s of vert) {
      if (usedV.has(s)) continue;
      // A door's edge is tall and reaches high in the frame. Short edges low down are usually
      // furniture, whose dark side is the near object, not a gap behind it.
      if (s.y0 > h * 0.4 || s.length < h * 0.45) continue;
      const left = sideMean(img, w, h, s, -1, strip);
      const right = sideMean(img, w, h, s, 1, strip);
      if (isNaN(left) || isNaN(right)) continue;
      const open: -1 | 1 = left < right ? -1 : 1;
      const dark = Math.min(left, right);
      const contrast = Math.abs(left - right);
      if (contrast < contrastMin * 1.4 || dark > mean - 0.15 * std) continue;
      const x = (s.x0 + s.x1) / 2;
      const scale = Math.max(s.length / h, 0.45) / DOOR_HEIGHT_M;
      const gapW = 0.13;
      found.push({
        kind: 'door-edge',
        box: { x: open < 0 ? nx(x) - gapW : nx(x), y: ny(s.y0), w: gapW, h: s.length / h },
        occluder: { x0: nx(s.x0), y0: ny(s.y0), x1: nx(s.x1), y1: ny(s.y1), orientation: 'vertical', open },
        scale,
        floorY: Math.min(1.2, ny(s.y0) + DOOR_HEIGHT_M * scale),
        darkness: clamp((mean - dark) / (std + 0.02) * 0.5 + 0.4, 0, 1),
        score: clamp(contrast * 3 + (s.length / h) * 0.4, 0, 1),
      });
    }

    // --- hallways: converging diagonals give a vanishing point ----------------------------
    if (diag.length >= 2) {
      const votes = new Map<string, { x: number; y: number; wsum: number; n: number }>();
      for (let i = 0; i < diag.length; i++) for (let j = i + 1; j < diag.length; j++) {
        const a = diag[i];
        const b = diag[j];
        if ((a.theta < 90) === (b.theta < 90)) continue; // need opposite slopes
        const p = intersect(a, b);
        if (!p || p.x < w * 0.12 || p.x > w * 0.88 || p.y < h * 0.12 || p.y > h * 0.88) continue;
        const key = `${Math.floor(p.x / (w / 10))},${Math.floor(p.y / (h / 8))}`;
        const cur = votes.get(key) ?? { x: 0, y: 0, wsum: 0, n: 0 };
        const wt = a.length * b.length;
        cur.x += p.x * wt;
        cur.y += p.y * wt;
        cur.wsum += wt;
        cur.n++;
        votes.set(key, cur);
      }
      const best = [...votes.values()].sort((a, b) => b.wsum - a.wsum)[0];
      if (best && (best.n >= 2 || best.wsum > (w * h) * 0.06)) {
        const vx = best.x / best.wsum;
        const vy = best.y / best.wsum;
        const bw = w * 0.16;
        const bh = h * 0.26;
        const inside = meanIn(img, w, h, vx - bw / 2, vy - bh * 0.6, vx + bw / 2, vy + bh * 0.4);
        if (inside < mean + 0.25 * std) {
          const scale = (bh / h) / 2.4;
          // The far end's own door frame, if one is visible near the vanishing point.
          const nearV = vert
            .filter((s) => Math.abs((s.x0 + s.x1) / 2 - vx) < bw * 0.7 && s.y0 < vy + bh * 0.3 && s.y1 > vy - bh * 0.3)
            .sort((a, b) => Math.abs((a.x0 + a.x1) / 2 - vx) - Math.abs((b.x0 + b.x1) / 2 - vx))[0];
          const occ: Occluder | undefined = nearV
            ? { x0: nx(nearV.x0), y0: ny(nearV.y0), x1: nx(nearV.x1), y1: ny(nearV.y1), orientation: 'vertical', open: (nearV.x0 + nearV.x1) / 2 > vx ? -1 : 1 }
            : undefined;
          found.push({
            kind: 'hallway',
            box: { x: nx(vx - bw / 2), y: ny(vy - bh * 0.6), w: bw / w, h: bh / h },
            occluder: occ,
            scale,
            floorY: ny(vy + bh * 0.4),
            darkness: clamp((mean - inside) / (std + 0.02) * 0.5 + 0.5, 0, 1),
            score: clamp(0.35 + best.n * 0.12, 0, 1),
          });
        }
      }
    }

    // --- stairs: a run of parallel horizontal edges with regular spacing ------------------
    const hs = segments.filter((s) => (isHorizontal(s) || Math.abs(s.theta - 90) <= 18) && s.length >= w * 0.12).sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    let run: Segment[] = [];
    const stairLines = new Set<Segment>();
    const flushRun = () => {
      if (run.length >= 4) {
        run.forEach((r) => stairLines.add(r));
        const top = run[0];
        const gaps = run.slice(1).map((s, i) => (s.y0 + s.y1) / 2 - (run[i].y0 + run[i].y1) / 2);
        const spacing = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const scale = spacing / h / 0.18;
        const ty = (top.y0 + top.y1) / 2;
        found.push({
          kind: 'stairs',
          box: { x: nx(Math.min(top.x0, top.x1)), y: Math.max(0, ny(ty) - 0.25), w: top.length / w, h: Math.min(0.25, ny(ty)) },
          occluder: { x0: nx(top.x0), y0: ny(top.y0), x1: nx(top.x1), y1: ny(top.y1), orientation: 'horizontal', open: -1 },
          scale: clamp(scale, 0.05, 0.6),
          floorY: ny(ty),
          darkness: 0.5,
          score: clamp(0.3 + run.length * 0.1, 0, 1),
        });
      }
      run = [];
    };
    for (const s of hs) {
      if (!run.length) {
        run = [s];
        continue;
      }
      const prev = run[run.length - 1];
      const overlap = Math.min(prev.x1, s.x1) - Math.max(prev.x0, s.x0);
      const gap = (s.y0 + s.y1) / 2 - (prev.y0 + prev.y1) / 2;
      const prevGap = run.length >= 2 ? (prev.y0 + prev.y1) / 2 - (run[run.length - 2].y0 + run[run.length - 2].y1) / 2 : gap;
      if (overlap > Math.min(prev.length, s.length) * 0.5 && gap > 2 && gap < h * 0.18 && gap / prevGap > 0.55 && gap / prevGap < 1.8) run.push(s);
      else {
        flushRun();
        run = [s];
      }
    }
    flushRun();

    // --- furniture: a bounded horizontal top edge with space behind it --------------------
    for (const s of horiz) {
      if (stairLines.has(s)) continue;
      const y = (s.y0 + s.y1) / 2;
      if (y < h * 0.3 || y > h * 0.92) continue;
      if (s.length > w * 0.75) continue; // floor/wall junctions run the full width
      const above = sideMean(img, w, h, s, -1, Math.round(h * 0.08));
      const below = sideMean(img, w, h, s, 1, Math.round(h * 0.08));
      if (isNaN(above) || isNaN(below) || Math.abs(above - below) < contrastMin) continue;
      const scale = (s.length / h) / 0.9;
      found.push({
        kind: 'furniture',
        box: { x: nx(s.x0), y: Math.max(0, ny(y) - 0.2), w: s.length / w, h: Math.min(0.2, ny(y)) },
        occluder: { x0: nx(s.x0), y0: ny(s.y0), x1: nx(s.x1), y1: ny(s.y1), orientation: 'horizontal', open: -1 },
        scale: clamp(scale, 0.08, 0.6),
        floorY: Math.min(1.2, ny(y) + 0.75 * scale),
        darkness: clamp((mean - above) / (std + 0.02) * 0.5 + 0.5, 0, 1),
        score: clamp(Math.abs(above - below) * 3 + (s.length / w) * 0.5, 0, 1),
      });
    }

    // --- dark regions: corners and shadow pockets -----------------------------------------
    // Relative to the frame, but with an absolute floor so gentle lighting falloff on a plain
    // wall never reads as a "dark corner".
    const minDarkContrast = 0.07 + 0.06 * (1 - sensitivity);
    const darkT = Math.min(mean - (0.35 + 0.45 * (1 - sensitivity)) * std, percentile(img, 0.3), mean - minDarkContrast);
    const dark = components(img, w, h, (val) => val < darkT);
    const totalCells = dark.cellsX * dark.cellsY;
    for (const c of dark.comps) {
      if (c.count < totalCells * 0.012 || c.count > totalCells * 0.45) continue;
      const touchL = c.minX === 0;
      const touchR = c.maxX === dark.cellsX - 1;
      const touchT = c.minY === 0;
      const touchB = c.maxY === dark.cellsY - 1;
      const corner = (touchL || touchR) && (touchT || touchB);
      const avg = c.sum / c.count;
      if (mean - avg < minDarkContrast * 1.4) continue;
      const cells = new Uint8Array(totalCells);
      for (let i = 0; i < totalCells; i++) if (dark.labels[i] === c.id) cells[i] = 1;
      const box = {
        x: (c.minX * 4) / w,
        y: (c.minY * 4) / h,
        w: ((c.maxX - c.minX + 1) * 4) / w,
        h: ((c.maxY - c.minY + 1) * 4) / h,
      };
      found.push({
        kind: corner ? 'dark-corner' : 'shadow',
        box,
        scale: 0.25,
        floorY: box.y + box.h,
        darkness: clamp((mean - avg) / (std + 0.02) * 0.4 + 0.4, 0, 1),
        score: clamp((mean - avg) * 3 + (c.count / totalCells) * 2, 0, 1),
        region: { cellsX: dark.cellsX, cellsY: dark.cellsY, cells, bx: c.minX, by: c.minY, bw: c.maxX - c.minX + 1, bh: c.maxY - c.minY + 1 },
      });
    }

    // --- windows: bright, roughly rectangular regions --------------------------------------
    const brightT = mean + Math.max(0.16, 1.1 * std);
    const bright = components(img, w, h, (val) => val > brightT);
    for (const c of bright.comps) {
      const bw = c.maxX - c.minX + 1;
      const bh = c.maxY - c.minY + 1;
      const rect = c.count / (bw * bh);
      if (c.count < totalCells * 0.02 || c.count > totalCells * 0.35 || rect < 0.62) continue;
      const box = { x: (c.minX * 4) / w, y: (c.minY * 4) / h, w: (bw * 4) / w, h: (bh * 4) / h };
      // A pane has a hard frame: it must be clearly brighter than a ring just outside it.
      // Light falling off across a wall is gradual and fails this.
      const inner = meanIn(img, w, h, c.minX * 4 + 2, c.minY * 4 + 2, (c.maxX + 1) * 4 - 3, (c.maxY + 1) * 4 - 3);
      const ring = 4;
      const sides = [
        meanIn(img, w, h, c.minX * 4 - ring - 1, c.minY * 4, c.minX * 4 - 2, (c.maxY + 1) * 4),
        meanIn(img, w, h, (c.maxX + 1) * 4 + 1, c.minY * 4, (c.maxX + 1) * 4 + ring, (c.maxY + 1) * 4),
        meanIn(img, w, h, c.minX * 4, c.minY * 4 - ring - 1, (c.maxX + 1) * 4, c.minY * 4 - 2),
        meanIn(img, w, h, c.minX * 4, (c.maxY + 1) * 4 + 1, (c.maxX + 1) * 4, (c.maxY + 1) * 4 + ring),
      ];
      const framed = sides.filter((v) => inner - v > 0.12).length;
      if (framed < 3) continue;
      found.push({ kind: 'window', box, scale: box.h / 1.2, floorY: box.y + box.h + 0.9 * (box.h / 1.2), darkness: 0, score: clamp(rect, 0, 1) });
    }

    // --- motion & irregularity -------------------------------------------------------------
    const motion = this.prev && this.prev.length === img.length ? estimateShift(this.prev, img, w, h) : { dx: 0, dy: 0, magnitude: 0 };
    if (this.prev && this.prev.length === img.length && motion.magnitude < 0.01) {
      let base = 0;
      for (let i = 0; i < img.length; i++) base += Math.abs(img[i] - this.prev[i]);
      base /= img.length;
      let siteChange = 0;
      let n = 0;
      for (const s of found) {
        if (s.kind !== 'dark-corner' && s.kind !== 'shadow' && s.kind !== 'doorway' && s.kind !== 'hallway') continue;
        const x0 = s.box.x * w, y0 = s.box.y * h, x1 = (s.box.x + s.box.w) * w, y1 = (s.box.y + s.box.h) * h;
        for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, y1); y++) for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, x1); x++) {
          siteChange += Math.abs(img[y * w + x] - this.prev[y * w + x]);
          n++;
        }
      }
      const raw = n ? clamp((siteChange / n - base * 1.15) / (base + 0.004), 0, 1) : 0;
      this.irregularity = this.irregularity * 0.7 + raw * 0.3;
    } else {
      this.irregularity *= 0.8;
    }
    this.prev = img;

    for (const f of found) f.meanLum = meanIn(img, w, h, f.box.x * w, f.box.y * h, (f.box.x + f.box.w) * w - 1, (f.box.y + f.box.h) * h - 1);
    const sites = this.track(dedupe(found));
    return { sites, segments, mean, std, motion, irregularity: this.irregularity };
  }

  reset(): void {
    this.prev = undefined;
    this.prevSites = [];
    this.irregularity = 0;
  }

  /** Matches sites across frames so only persistent ones can host anomalies. */
  private track(found: Omit<Site, 'id' | 'persistence'>[]): Site[] {
    const out: Site[] = [];
    const used = new Set<Site>();
    for (const f of found) {
      const match = this.prevSites.find((p) => !used.has(p) && p.kind === f.kind && iou(p.box, f.box) > 0.3);
      if (match) {
        used.add(match);
        out.push({ ...f, id: match.id, persistence: match.persistence + 1 });
      } else out.push({ ...f, id: `site${siteSeq++}`, persistence: 1 });
    }
    // Keep briefly-missed sites for one frame so flicker in detection doesn't reset them.
    for (const p of this.prevSites) if (!used.has(p) && p.persistence > 2) out.push({ ...p, persistence: Math.floor(p.persistence / 2) });
    this.prevSites = out.filter((s) => s.persistence > 0);
    return out;
  }
}

/** Non-maximum suppression among same-kind sites. */
function dedupe<T extends { kind: SiteKind; box: Box; score: number }>(sites: T[]): T[] {
  const sorted = [...sites].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  for (const s of sorted) if (!kept.some((k) => k.kind === s.kind && iou(k.box, s.box) > 0.45)) kept.push(s);
  return kept;
}

function chooseJamb(a: Segment, b: Segment, w: number, h: number): Occluder {
  // Use the longer, cleaner jamb. Left jamb: interior opens to its right.
  const useA = a.length * a.strength >= b.length * b.strength;
  const s = useA ? a : b;
  return { x0: s.x0 / w, y0: s.y0 / h, x1: s.x1 / w, y1: s.y1 / h, orientation: 'vertical', open: useA ? 1 : -1 };
}

export function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/** Global translation between frames by SAD search on a half-resolution image. */
export function estimateShift(a: Float32Array, b: Float32Array, w: number, h: number): { dx: number; dy: number; magnitude: number } {
  const R = 5;
  let best = { dx: 0, dy: 0, sad: Infinity };
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      let sad = 0;
      let n = 0;
      for (let y = R; y < h - R; y += 2) for (let x = R; x < w - R; x += 2) {
        sad += Math.abs(a[y * w + x] - b[(y + dy) * w + (x + dx)]);
        n++;
      }
      sad /= n;
      if (sad < best.sad) best = { dx, dy, sad };
    }
  }
  const ndx = best.dx / w;
  const ndy = best.dy / h;
  return { dx: ndx, dy: ndy, magnitude: Math.hypot(ndx, ndy) };
}
