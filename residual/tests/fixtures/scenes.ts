/** Procedural test scenes rendered as luminance frames (0..1), with sensor-like noise. */
import type { LumaFrame } from '../../src/camera/analysis';
import { seededRng } from '../../src/util/rng';

type Pt = [number, number];

export class Canvas {
  readonly data: Float32Array;
  constructor(readonly w = 160, readonly h = 120, fill = 0.5) {
    this.data = new Float32Array(w * h).fill(fill);
  }
  /** fill a polygon given in normalised coordinates with a value or a function of (x,y) */
  poly(points: Pt[], value: number | ((x: number, y: number) => number)): this {
    const { w, h } = this;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = (x + 0.5) / w, py = (y + 0.5) / h;
      let inside = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i], [xj, yj] = points[j];
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) this.data[y * w + x] = typeof value === 'number' ? value : value(px, py);
    }
    return this;
  }
  rect(x: number, y: number, rw: number, rh: number, value: number | ((x: number, y: number) => number)): this {
    return this.poly([[x, y], [x + rw, y], [x + rw, y + rh], [x, y + rh]], value);
  }
  noise(amount = 0.02, seed = 1): LumaFrame {
    const rng = seededRng(seed);
    const data = new Float32Array(this.data.length);
    for (let i = 0; i < data.length; i++) data[i] = Math.min(1, Math.max(0, this.data[i] + (rng.next() - 0.5) * 2 * amount));
    return { w: this.w, h: this.h, data };
  }
}

const wall = (x: number, y: number) => 0.5 + 0.08 * (1 - y) - 0.05 * Math.abs(x - 0.5);

export const scenes = {
  /** an open doorway into a dark room, right of centre */
  doorway: () => new Canvas().poly([[0, 0], [1, 0], [1, 1], [0, 1]], wall).rect(0.55, 0.12, 0.2, 0.88, 0.1).rect(0, 0.85, 1, 0.15, 0.36),
  /** a door ajar: lit door slab on the left, a dark gap beside it */
  ajar: () =>
    new Canvas().poly([[0, 0], [1, 0], [1, 1], [0, 1]], wall).rect(0.3, 0.08, 0.16, 0.92, 0.62).rect(0.46, 0.08, 0.07, 0.92, 0.08),
  /** looking down a hallway; the far end is dark */
  hallway: () => {
    const c = new Canvas(160, 120, 0.3);
    const vp: Pt = [0.52, 0.45];
    c.poly([[0, 0], [1, 0], [vp[0] + 0.06, vp[1] - 0.09], [vp[0] - 0.06, vp[1] - 0.09]], 0.62); // ceiling
    c.poly([[0, 1], [1, 1], [vp[0] + 0.06, vp[1] + 0.08], [vp[0] - 0.06, vp[1] + 0.08]], 0.4); // floor
    c.poly([[0, 0], [vp[0] - 0.06, vp[1] - 0.09], [vp[0] - 0.06, vp[1] + 0.08], [0, 1]], 0.5); // left wall
    c.poly([[1, 0], [vp[0] + 0.06, vp[1] - 0.09], [vp[0] + 0.06, vp[1] + 0.08], [1, 1]], 0.46); // right wall
    c.rect(vp[0] - 0.06, vp[1] - 0.09, 0.12, 0.17, 0.08); // dark far end
    return c;
  },
  /** a room whose upper-left corner falls into shadow */
  corner: () => {
    const c = new Canvas().poly([[0, 0], [1, 0], [1, 1], [0, 1]], (x, y) => 0.58 * Math.min(1, Math.hypot(x, y) * 1.15));
    return c;
  },
  /** a chair back in front of a shadowed wall */
  chair: () => new Canvas().poly([[0, 0], [1, 0], [1, 1], [0, 1]], (_x, y) => 0.28 + 0.06 * y).rect(0.3, 0.55, 0.3, 0.45, 0.6).rect(0, 0.9, 1, 0.1, 0.4),
  stairs: () => {
    const c = new Canvas(160, 120, 0.45);
    for (let i = 0; i < 7; i++) {
      const y = 0.35 + i * 0.09;
      c.rect(0.25, y, 0.5, 0.045, 0.62);
      c.rect(0.25, y + 0.045, 0.5, 0.045, 0.3);
    }
    return c;
  },
  /** nothing but a softly lit wall */
  blank: () => new Canvas().poly([[0, 0], [1, 0], [1, 1], [0, 1]], (x, y) => 0.5 + 0.05 * (1 - y) + 0.02 * x),
};
