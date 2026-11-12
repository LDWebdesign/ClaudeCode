/**
 * Visual anomaly engine.
 *
 * Every completed scan rolls a tier table (default 85% normal / 10% subtle / 4% unusual /
 * 1% uncanny). A non-normal roll only produces something if the camera is steady and the
 * environment analysis has found a persistent, compatible location; otherwise the scan is
 * normal. After any anomaly comes a quiet period, and long dormant stretches occur at random.
 *
 * Anomalies are drawn into a low-resolution density mask in frame coordinates; the camera
 * shader darkens and softens the image under the mask, before grain and tone mapping, so an
 * anomaly is lit, exposed and noisy exactly like the scene around it. Shapes are sized from the
 * site's physical scale (a door is ~2 m tall) and clipped by its occluding edge, so they sit
 * behind door jambs and furniture rather than float in front of them.
 */
import type { ResidualConfig } from '../config';
import { Emitter } from '../util/emitter';
import { type Rng, between, chance, clamp, inRange, pickBy, pickWeighted, smoothstep } from '../util/rng';
import type { Occluder, Site, SiteKind } from './analysis';

export type Tier = 'subtle' | 'unusual' | 'uncanny';
export type AnomalyType =
  | 'densify' | 'pool' | 'edge-creep'
  | 'crown' | 'shoulder' | 'brim' | 'rise' | 'hall-figure' | 'window-shape' | 'stair-figure'
  | 'partial-figure' | 'lean';

type Range = readonly [number, number];
type Pt = [number, number];

interface Pose {
  /** metres */
  dx: number;
  dy: number;
  rot: number;
  /** extra visibility multiplier */
  vis: number;
}

interface Def {
  type: AnomalyType;
  tier: Tier;
  /**
   * shadow: pure darkening (deepening shadows, silhouettes against light).
   * body: an object with its own dim luminance at partial opacity — darker than a lit wall,
   * slightly lighter than a black doorway it stands in (it catches spill light from the room).
   */
  layer: 'shadow' | 'body';
  weight: number;
  sites: SiteKind[];
  duration: Range;
  fade: Range;
  density: Range;
  /** edge softness: metres at the site's scale for shaped anomalies, mask px (at 320 wide) for region ones */
  feather: Range;
  /** 0..1 how readily the log "notices" it */
  detect: number;
  /** allowed to be shortened to a few frames */
  footage: boolean;
  /** placement in normalised coords; undefined if this site can't host it */
  place(site: Site, rng: Rng): Placement | undefined;
  motion(t: number, p: Placement, movement: number): Pose;
  shape: ShapeFn;
}

interface Placement {
  /** anchor in normalised frame coords */
  ax: number;
  ay: number;
  /** clip polygon in normalised coords (visible region); undefined = no clip */
  clip?: Pt[];
  /** metres -> normalised height */
  scale: number;
  /** -1/1: the side the shape withdraws toward (behind its occluder) */
  hide: number;
  /** free parameters for shape variety */
  k: number[];
}

export interface ActiveAnomaly {
  id: number;
  def: Def;
  site: Site;
  placement: Placement;
  t0: number;
  t1: number;
  fade: number;
  density: number;
  feather: number;
  footageOnly: boolean;
  /** accumulated camera-motion compensation, normalised */
  offset: Pt;
  confidence: number;
  peakAt: number;
  /** forced from the Test menu: held longer, never logged */
  test: boolean;
}

export interface ForceOptions {
  footageOnly?: boolean;
  /** keep it on screen at least this many seconds */
  hold?: number;
  test?: boolean;
}

export type ScanResult = 'normal' | 'anomaly' | 'refractory' | 'dormant' | 'unstable' | 'no-site' | 'busy';

export interface AnomalyEvents extends Record<string, unknown> {
  scan: { count: number; result: ScanResult; tier?: Tier | 'normal'; at: number };
  start: ActiveAnomaly;
  peak: ActiveAnomaly;
  end: ActiveAnomaly;
}

type ShapeFn = (ctx: CanvasRenderingContext2D, p: Placement) => void;

// --- shapes (drawn in metres, origin at anchor, y down) ---------------------------------

const headPath = (ctx: CanvasRenderingContext2D, w: number, h: number, y = 0) => {
  ctx.moveTo(0, y);
  ctx.bezierCurveTo(w * 0.55, y, w * 0.52, y + h * 0.62, w * 0.36, y + h * 0.86);
  ctx.quadraticCurveTo(0, y + h * 1.04, -w * 0.36, y + h * 0.86);
  ctx.bezierCurveTo(-w * 0.52, y + h * 0.62, -w * 0.55, y, 0, y);
  ctx.closePath();
};

const bust: ShapeFn = (ctx, p) => {
  const [hw, hh, slope] = [0.15 + p.k[0] * 0.03, 0.22 + p.k[1] * 0.03, 0.05 + p.k[2] * 0.06];
  headPath(ctx, hw, hh);
  // neck and shoulders
  ctx.moveTo(-0.055, hh * 0.8);
  ctx.lineTo(0.055, hh * 0.8);
  ctx.lineTo(0.06, hh + 0.06);
  ctx.quadraticCurveTo(0.2, hh + 0.07 + slope * 0.4, 0.22, hh + 0.1 + slope);
  ctx.lineTo(0.24, hh + 0.8);
  ctx.lineTo(-0.24, hh + 0.8);
  ctx.lineTo(-0.22, hh + 0.1 + slope);
  ctx.quadraticCurveTo(-0.2, hh + 0.07 + slope * 0.4, -0.06, hh + 0.06);
  ctx.closePath();
};

const crown: ShapeFn = (ctx, p) => headPath(ctx, 0.15 + p.k[0] * 0.03, 0.23);

const shoulder: ShapeFn = (ctx, p) => {
  const r = 0.12 + p.k[0] * 0.04;
  ctx.moveTo(-r, 0.08);
  ctx.quadraticCurveTo(-r * 0.9, 0, 0, -0.005);
  ctx.quadraticCurveTo(r * 0.9, 0, r, 0.09);
  ctx.lineTo(r * 1.05, 0.75);
  ctx.lineTo(-r * 1.05, 0.75);
  ctx.closePath();
};

const hat: ShapeFn = (ctx, p) => {
  const cw = 0.16 + p.k[0] * 0.03;
  const ch = 0.09 + p.k[1] * 0.05;
  const bw = 0.17 + p.k[2] * 0.05;
  // crown with a slight pinch
  ctx.moveTo(-cw / 2, ch);
  ctx.lineTo(-cw * 0.46, ch * 0.18);
  ctx.quadraticCurveTo(0, -ch * 0.12, cw * 0.46, ch * 0.18);
  ctx.lineTo(cw / 2, ch);
  ctx.closePath();
  // brim
  ctx.ellipse(0, ch, bw, 0.02, 0, 0, Math.PI * 2);
  // the faint head beneath it
  ctx.moveTo(-0.075, ch);
  ctx.lineTo(0.075, ch);
  ctx.lineTo(0.065, ch + 0.17);
  ctx.lineTo(-0.065, ch + 0.17);
  ctx.closePath();
};

const column: ShapeFn = (ctx, p) => {
  const height = 1.62 + p.k[0] * 0.2;
  const w = 0.36 + p.k[1] * 0.1;
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(0.09, 0, 0.1, 0.16, 0.06, 0.24);
  ctx.quadraticCurveTo(w / 2, 0.3, w / 2, 0.5);
  ctx.lineTo(w * 0.42, height);
  ctx.lineTo(-w * 0.42, height);
  ctx.lineTo(-w / 2, 0.5);
  ctx.quadraticCurveTo(-w / 2, 0.3, -0.06, 0.24);
  ctx.bezierCurveTo(-0.1, 0.16, -0.09, 0, 0, 0);
  ctx.closePath();
};

const blob: ShapeFn = (ctx, p) => {
  const rx = 0.25 + p.k[0] * 0.25;
  const ry = 0.45 + p.k[1] * 0.4;
  const n = 28;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const wobble = 1 + 0.18 * Math.sin(a * 3 + p.k[2] * 6) + 0.1 * Math.sin(a * 5 + p.k[3] * 6);
    const x = Math.cos(a) * rx * wobble;
    const y = Math.sin(a) * ry * wobble;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
};

// --- placement helpers -----------------------------------------------------------------

/** x of a (possibly tilted) occluder line at height y. */
const lineX = (o: Occluder, y: number) => o.x0 + ((o.x1 - o.x0) * (y - o.y0)) / ((o.y1 - o.y0) || 1e-6);
const lineY = (o: Occluder, x: number) => o.y0 + ((o.y1 - o.y0) * (x - o.x0)) / ((o.x1 - o.x0) || 1e-6);

/**
 * Visible half-plane beside an occluding edge. The edge is located on a ~160 px analysis
 * image, so the clip is inset slightly toward the open side: a shape must never spill onto
 * the near surface (door trim, furniture top) that is supposed to be hiding it.
 */
const CLIP_INSET = 0.004;
function clipBeside(o: Occluder): Pt[] {
  if (o.orientation === 'vertical') {
    const far = o.open > 0 ? 3 : -2;
    const d = o.open * CLIP_INSET;
    return [[lineX(o, -2) + d, -2], [lineX(o, 3) + d, 3], [far, 3], [far, -2]];
  }
  const d = -CLIP_INSET * 1.6;
  return [[-2, lineY(o, -2) + d], [3, lineY(o, 3) + d], [3, -2], [-2, -2]];
}

/** Places a shape so that only a sliver (`visible` of its width) shows past a vertical edge. */
function besideEdge(site: Site, rng: Rng, heightAboveFloorM: number, widthM: number, visible: Range): Placement | undefined {
  const o = site.occluder;
  if (!o || o.orientation !== 'vertical') return undefined;
  const ay = site.floorY - heightAboveFloorM * site.scale;
  if (ay < 0.02 || ay > 0.85) return undefined;
  // keep it within the vertical extent of the edge that hides it
  if (ay < Math.min(o.y0, o.y1) - 0.03 || ay > Math.max(o.y0, o.y1)) return undefined;
  const f = inRange(rng, visible);
  // anchor on the (inset) clip line; the shape is offset in metres at draw time so that
  // fraction `f` of its width shows past the edge
  const ax = lineX(o, ay) + o.open * CLIP_INSET;
  return {
    ax,
    ay,
    clip: clipBeside(o),
    scale: site.scale,
    hide: -o.open,
    k: [rng.next(), rng.next(), rng.next(), rng.next(), o.open * (f - 0.5) * widthM],
  };
}

const offsetX = (p: Placement) => p.k[4] ?? 0;

/** Darkening is invisible where the scene is already black; those effects need some light. */
const canDarken = (site: Site) => (site.meanLum ?? 0.2) > 0.08;

// --- definitions -----------------------------------------------------------------------

const DEFS: Def[] = [
  {
    type: 'densify', layer: 'shadow', tier: 'subtle', weight: 3, sites: ['dark-corner', 'shadow'],
    duration: [3, 9], fade: [1.2, 2.6], density: [0.1, 0.2], feather: [6, 10], detect: 0.25, footage: false,
    place: (site, rng) => (site.region && canDarken(site) ? { ax: 0, ay: 0, scale: site.scale, hide: 0, k: [rng.next(), rng.next(), 1] } : undefined),
    motion: () => ({ dx: 0, dy: 0, rot: 0, vis: 1 }),
    shape: () => undefined, // region-drawn
  },
  {
    type: 'edge-creep', layer: 'shadow', tier: 'subtle', weight: 1.5, sites: ['dark-corner', 'shadow'],
    duration: [2, 4.5], fade: [0.8, 1.4], density: [0.08, 0.15], feather: [5, 8], detect: 0.2, footage: false,
    place: (site, rng) => (site.region && canDarken(site) ? { ax: 0, ay: 0, scale: site.scale, hide: 0, k: [rng.next(), rng.next(), 1.06 + rng.next() * 0.05] } : undefined),
    motion: () => ({ dx: 0, dy: 0, rot: 0, vis: 1 }),
    shape: () => undefined,
  },
  {
    type: 'pool', layer: 'shadow', tier: 'subtle', weight: 2, sites: ['doorway', 'hallway', 'shadow'],
    duration: [2, 5], fade: [0.8, 1.5], density: [0.12, 0.22], feather: [0.06, 0.1], detect: 0.3, footage: false,
    place: (site, rng) => canDarken(site) ? ({
      ax: site.box.x + site.box.w * between(rng, 0.3, 0.7),
      ay: site.box.y + site.box.h * between(rng, 0.35, 0.65),
      scale: Math.min(site.scale, 0.35),
      hide: 0,
      k: [rng.next(), rng.next(), rng.next(), rng.next()],
    }) : undefined,
    motion: (t, _p, m) => ({ dx: Math.sin(t * Math.PI) * 0.04 * m, dy: 0, rot: 0, vis: 1 }),
    shape: blob,
  },
  {
    type: 'crown', layer: 'body', tier: 'unusual', weight: 3, sites: ['doorway', 'door-edge'],
    duration: [0.5, 1.8], fade: [0.12, 0.3], density: [0.3, 0.5], feather: [0.012, 0.025], detect: 0.45, footage: true,
    place: (site, rng) => besideEdge(site, rng, between(rng, 1.62, 1.82), 0.16, [0.24, 0.45]),
    motion: (t, p, m) => ({ dx: p.hide * (smoothstep(0.65, 1, t) * 0.06 - Math.sin(t * Math.PI) * 0.015) * m * 2, dy: Math.sin(t * Math.PI) * 0.008 * m, rot: 0, vis: 1 }),
    shape: crown,
  },
  {
    type: 'shoulder', layer: 'body', tier: 'unusual', weight: 2, sites: ['doorway', 'door-edge'],
    duration: [1, 3], fade: [0.2, 0.4], density: [0.28, 0.45], feather: [0.015, 0.03], detect: 0.35, footage: true,
    place: (site, rng) => besideEdge(site, rng, between(rng, 1.38, 1.5), 0.26, [0.24, 0.4]),
    motion: (t, p, m) => ({ dx: p.hide * smoothstep(0.55, 1, t) * 0.08 * m * 2, dy: 0, rot: 0, vis: 1 }),
    shape: shoulder,
  },
  {
    type: 'brim', layer: 'body', tier: 'unusual', weight: 1, sites: ['doorway', 'door-edge'],
    duration: [0.4, 1.2], fade: [0.05, 0.18], density: [0.32, 0.5], feather: [0.01, 0.02], detect: 0.4, footage: true,
    place: (site, rng) => besideEdge(site, rng, between(rng, 1.8, 1.92), 0.34, [0.3, 0.48]),
    motion: (t, p, m) => ({ dx: p.hide * smoothstep(0.75, 1, t) * 0.05 * m * 2, dy: 0, rot: 0, vis: 1 }),
    shape: hat,
  },
  {
    type: 'rise', layer: 'body', tier: 'unusual', weight: 2, sites: ['furniture'],
    duration: [0.8, 2.4], fade: [0.15, 0.35], density: [0.25, 0.42], feather: [0.012, 0.025], detect: 0.35, footage: true,
    place: (site, rng) => {
      const o = site.occluder;
      if (!o) return undefined;
      const x = o.x0 + (o.x1 - o.x0) * between(rng, 0.25, 0.75);
      const y = lineY(o, x);
      if (y < 0.15) return undefined;
      return { ax: x, ay: y, clip: clipBeside(o), scale: site.scale, hide: 1, k: [rng.next(), between(rng, 0.05, 0.12)] };
    },
    // the top of a head comes up just past the edge, then settles back
    motion: (t, p, m) => ({ dx: 0, dy: 0.01 - p.k[1] * (0.6 + 0.8 * m) * Math.sin(Math.min(1, t * 1.15) * Math.PI), rot: 0, vis: 1 }),
    shape: crown,
  },
  {
    type: 'hall-figure', layer: 'body', tier: 'unusual', weight: 3, sites: ['hallway'],
    duration: [1.5, 4.5], fade: [0.4, 0.9], density: [0.25, 0.42], feather: [0.04, 0.07], detect: 0.4, footage: true,
    place: (site, rng) => ({
      ax: site.box.x + site.box.w * between(rng, 0.35, 0.65),
      ay: site.floorY - 1.7 * site.scale,
      clip: site.occluder ? clipBeside(site.occluder) : [[site.box.x, site.box.y], [site.box.x + site.box.w, site.box.y], [site.box.x + site.box.w, site.box.y + site.box.h], [site.box.x, site.box.y + site.box.h]],
      scale: site.scale,
      hide: site.occluder ? -site.occluder.open : chance(rng, 0.5) ? 1 : -1,
      k: [rng.next(), rng.next(), chance(rng, 0.5) ? 1 : 0],
    }),
    // either drifts very slightly, or steps aside out of view
    motion: (t, p, m) => ({ dx: p.k[2] ? p.hide * smoothstep(0.5, 1, t) * 0.5 * m * 2 : Math.sin(t * Math.PI) * 0.08 * m, dy: 0, rot: 0, vis: 1 }),
    shape: column,
  },
  {
    type: 'window-shape', layer: 'shadow', tier: 'unusual', weight: 1, sites: ['window'],
    duration: [1, 3], fade: [0.35, 0.7], density: [0.1, 0.18], feather: [0.05, 0.08], detect: 0.3, footage: false,
    place: (site, rng) => ({
      ax: site.box.x + site.box.w * between(rng, 0.3, 0.7),
      ay: site.box.y + site.box.h * between(rng, 0.25, 0.45),
      clip: [[site.box.x, site.box.y], [site.box.x + site.box.w, site.box.y], [site.box.x + site.box.w, site.box.y + site.box.h], [site.box.x, site.box.y + site.box.h]],
      scale: site.scale,
      hide: 0,
      k: [rng.next(), rng.next(), rng.next()],
    }),
    motion: (t, _p, m) => ({ dx: Math.sin(t * Math.PI) * 0.03 * m, dy: 0, rot: 0, vis: 1 }),
    shape: bust,
  },
  {
    type: 'stair-figure', layer: 'body', tier: 'unusual', weight: 2, sites: ['stairs'],
    duration: [1, 3], fade: [0.3, 0.6], density: [0.25, 0.4], feather: [0.03, 0.06], detect: 0.35, footage: true,
    place: (site, rng) => {
      const o = site.occluder;
      if (!o) return undefined;
      const x = o.x0 + (o.x1 - o.x0) * between(rng, 0.3, 0.7);
      const floor = lineY(o, x);
      return { ax: x, ay: floor - 1.7 * site.scale, clip: clipBeside(o), scale: site.scale, hide: 0, k: [rng.next(), rng.next()] };
    },
    motion: (t, _p, m) => ({ dx: 0, dy: Math.sin(t * Math.PI) * 0.02 * m, rot: 0, vis: 1 }),
    shape: column,
  },
  {
    type: 'partial-figure', layer: 'body', tier: 'uncanny', weight: 2, sites: ['doorway', 'door-edge', 'hallway'],
    duration: [0.15, 0.6], fade: [0, 0.03], density: [0.5, 0.72], feather: [0.008, 0.015], detect: 0.55, footage: true,
    place: (site, rng) =>
      site.kind === 'hallway'
        ? { ax: site.box.x + site.box.w * between(rng, 0.35, 0.65), ay: site.floorY - 1.72 * site.scale, clip: site.occluder ? clipBeside(site.occluder) : undefined, scale: site.scale, hide: 0, k: [rng.next(), rng.next(), rng.next(), rng.next()] }
        : besideEdge(site, rng, between(rng, 1.64, 1.82), 0.44, [0.28, 0.46]),
    motion: () => ({ dx: 0, dy: 0, rot: 0, vis: 1 }),
    shape: bust,
  },
  {
    type: 'lean', layer: 'body', tier: 'uncanny', weight: 1.5, sites: ['doorway', 'door-edge'],
    duration: [0.6, 1.3], fade: [0.04, 0.1], density: [0.45, 0.68], feather: [0.01, 0.02], detect: 0.5, footage: true,
    place: (site, rng) => besideEdge(site, rng, between(rng, 1.64, 1.8), 0.44, [0.15, 0.3]),
    // leans out from behind the edge, then back
    motion: (t, p, m) => {
      const out = Math.sin(Math.min(1, t * 1.1) * Math.PI);
      return { dx: -p.hide * out * 0.09 * (0.6 + m), dy: out * 0.01, rot: -p.hide * out * 0.12, vis: 1 };
    },
    shape: bust,
  },
];

export const ANOMALY_TYPES = DEFS.map((d) => d.type);

export function definitionsFor(tier: Tier): Def[] {
  return DEFS.filter((d) => d.tier === tier);
}

let anomalySeq = 0;

export class AnomalyEngine extends Emitter<AnomalyEvents> {
  active?: ActiveAnomaly;
  scans = 0;
  /** part of the frame actually on screen (normalised); anomalies are only placed inside it */
  visible = { x: 0, y: 0, w: 1, h: 1 };
  private nextScanAt: number;
  private scanStartedAt: number;
  private refractoryUntil = 0;
  private dormantUntil = 0;
  private peakSent = false;

  constructor(
    private readonly config: () => ResidualConfig,
    private readonly rng: Rng,
    now = 0,
  ) {
    super();
    this.scanStartedAt = now;
    this.nextScanAt = now + inRange(rng, config().camera.scanIntervalSec);
  }

  reset(now: number): void {
    this.active = undefined;
    this.scans = 0;
    this.refractoryUntil = 0;
    this.dormantUntil = 0;
    this.scanStartedAt = now;
    this.nextScanAt = now + inRange(this.rng, this.config().camera.scanIntervalSec);
  }

  scanProgress(now: number): number {
    return clamp((now - this.scanStartedAt) / Math.max(0.1, this.nextScanAt - this.scanStartedAt), 0, 1);
  }

  /** Call every frame with the latest analysis. `stillness` is 0..1. */
  update(now: number, sites: readonly Site[], stillness: number): void {
    const a = this.active;
    if (a) {
      if (!this.peakSent && now >= a.peakAt) {
        this.peakSent = true;
        this.emit('peak', a);
      }
      if (now >= a.t1) {
        this.active = undefined;
        this.emit('end', a);
      }
    }
    if (now >= this.nextScanAt) {
      this.completeScan(now, sites, stillness);
      this.scanStartedAt = now;
      this.nextScanAt = now + inRange(this.rng, this.config().camera.scanIntervalSec);
    }
  }

  /** Camera moved: keep the anomaly attached to the scene, or let it go if tracking is lost. */
  applyShift(dx: number, dy: number): void {
    const a = this.active;
    if (!a) return;
    a.offset[0] += dx;
    a.offset[1] += dy;
    if (Math.hypot(a.offset[0], a.offset[1]) > 0.05) this.abort();
  }

  abort(): void {
    const a = this.active;
    if (!a) return;
    this.active = undefined;
    this.emit('end', a);
  }

  /** Spawns one of the given anomaly types now, if a compatible on-screen site exists. */
  force(now: number, sites: readonly Site[], types?: AnomalyType | readonly AnomalyType[], opts: ForceOptions = {}): ActiveAnomaly | undefined {
    const wanted = types === undefined ? undefined : new Set<AnomalyType>(typeof types === 'string' ? [types] : types);
    const defs = wanted ? DEFS.filter((d) => wanted.has(d.type)) : DEFS;
    return this.spawnFrom(now, defs, sites, !!opts.footageOnly, opts);
  }

  private completeScan(now: number, sites: readonly Site[], stillness: number): void {
    const cfg = this.config().camera;
    this.scans++;
    const report = (result: ScanResult, tier?: Tier | 'normal') => this.emit('scan', { count: this.scans, result, tier, at: now });
    if (this.active) return report('busy');
    if (now < this.dormantUntil) return report('dormant');
    if (now < this.refractoryUntil) return report('refractory');

    const tier = pickWeighted(this.rng, cfg.tiers) ?? 'normal';
    if (tier === 'normal') {
      if (chance(this.rng, cfg.dormancyChance)) this.dormantUntil = now + inRange(this.rng, cfg.dormancySec);
      return report('normal', 'normal');
    }
    if (stillness < cfg.detection.stillnessRequired) return report('unstable', tier);
    const spawned = this.spawnFrom(now, definitionsFor(tier), sites, chance(this.rng, cfg.footageOnlyChance));
    report(spawned ? 'anomaly' : 'no-site', tier);
  }

  private spawnFrom(now: number, defs: Def[], sites: readonly Site[], footageOnly: boolean, opts: ForceOptions = {}): ActiveAnomaly | undefined {
    const cfg = this.config().camera;
    const v = this.visible;
    const inView = (x: number, y: number, m = 0.03) => x > v.x + m && x < v.x + v.w - m && y > v.y + m && y < v.y + v.h - m;
    const eligible = sites.filter((s) => s.persistence >= cfg.detection.minPersistence && inView(s.box.x + s.box.w / 2, s.box.y + s.box.h / 2, 0));
    const options: { def: Def; site: Site; placement: Placement }[] = [];
    for (const def of defs) for (const site of eligible) {
      if (!def.sites.includes(site.kind)) continue;
      const placement = def.place(site, this.rng);
      if (!placement) continue;
      // the shape itself (not just its site) has to land on screen
      if (site.region ? !inView(site.box.x + site.box.w / 2, site.box.y + site.box.h / 2, 0) : !inView(placement.ax, placement.ay)) continue;
      options.push({ def, site, placement });
    }
    const choice = pickBy(this.rng, options, (o) => o.def.weight * (0.3 + o.site.score) * (0.5 + o.site.darkness));
    if (!choice) return undefined;

    const { def, site, placement } = choice;
    const short = footageOnly && def.footage;
    const duration = short ? between(this.rng, 0.06, 0.1) : Math.max(inRange(this.rng, def.duration), opts.hold ?? 0);
    const vis = cfg.visibility * 2;
    const density = clamp(inRange(this.rng, def.density) * vis, 0, 0.92);
    const a: ActiveAnomaly = {
      id: anomalySeq++,
      def,
      site,
      placement,
      t0: now,
      t1: now + duration,
      fade: short ? 0 : Math.min(inRange(this.rng, def.fade), duration * 0.4),
      density,
      feather: inRange(this.rng, def.feather),
      footageOnly: short,
      offset: [0, 0],
      confidence: clamp(def.detect * (density / def.density[1]) * between(this.rng, 0.55, 1.15) * (short ? 0.5 : 1), 0.05, 0.78),
      peakAt: now + duration * between(this.rng, 0.35, 0.6),
      test: !!opts.test,
    };
    this.active = a;
    this.peakSent = false;
    this.refractoryUntil = a.t1 + inRange(this.rng, cfg.refractorySec[def.tier]);
    this.emit('start', a);
    return a;
  }

  /**
   * Draws the active anomaly into a mask canvas (alpha = darkening density).
   * Returns false when there is nothing to draw.
   */
  draw(ctx: CanvasRenderingContext2D, now: number): boolean {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const a = this.active;
    if (!a || now < a.t0 || now > a.t1) return false;
    const dur = a.t1 - a.t0;
    const t = (now - a.t0) / dur;
    const env = a.fade > 0 ? Math.min(1, (now - a.t0) / a.fade, (a.t1 - now) / a.fade) : 1;
    if (env <= 0) return false;
    const pose = a.def.motion(t, a.placement, this.config().camera.movement);
    const p = a.placement;
    const [ox, oy] = a.offset;
    const featherPx = Math.max(0.6, a.site.region ? a.feather * (W / 320) : a.feather * p.scale * H);

    // Feathered fill: draw the shape far off-canvas and keep only its blurred shadow.
    const OFF = W * 4;
    ctx.save();
    // red channel = shadow layer, green channel = body layer (read premultiplied by the shader)
    const alpha = (a.density * env * pose.vis).toFixed(3);
    ctx.shadowColor = a.def.layer === 'shadow' ? `rgba(255,0,0,${alpha})` : `rgba(0,255,0,${alpha})`;
    ctx.shadowBlur = featherPx;
    ctx.shadowOffsetX = OFF;
    ctx.fillStyle = '#fff';

    if (p.clip) {
      ctx.beginPath();
      p.clip.forEach(([x, y], i) => (i ? ctx.lineTo((x + ox) * W, (y + oy) * H) : ctx.moveTo((x + ox) * W, (y + oy) * H)));
      ctx.closePath();
      ctx.clip();
    }

    ctx.beginPath();
    if (a.def.type === 'densify' || a.def.type === 'edge-creep') {
      const r = a.site.region!;
      const cw = W / r.cellsX;
      const ch = H / r.cellsY;
      const grow = p.k[2];
      const cx = (r.bx + r.bw / 2) * cw;
      const cy = (r.by + r.bh / 2) * ch;
      ctx.translate(-OFF, 0);
      ctx.translate(cx + ox * W, cy + oy * H);
      ctx.scale(grow, grow);
      ctx.translate(-cx, -cy);
      for (let y = r.by; y < r.by + r.bh; y++) for (let x = r.bx; x < r.bx + r.bw; x++) {
        if (r.cells[y * r.cellsX + x]) ctx.rect(x * cw - 0.5, y * ch - 0.5, cw + 1, ch + 1);
      }
    } else {
      const s = p.scale * H; // px per metre
      ctx.translate(-OFF, 0);
      ctx.translate((p.ax + ox) * W + (offsetX(p) + pose.dx) * s, (p.ay + oy) * H + pose.dy * s);
      ctx.rotate(pose.rot);
      ctx.scale(s, s);
      a.def.shape(ctx, p);
    }
    ctx.fill();
    ctx.restore();
    return true;
  }
}

export const SITE_LABEL: Record<SiteKind, string> = {
  doorway: 'near doorway',
  'door-edge': 'at edge of door',
  hallway: 'far end of hallway',
  'dark-corner': 'in corner',
  shadow: 'in shadowed area',
  furniture: 'behind furniture',
  window: 'at window',
  stairs: 'top of stairs',
};

export function describeAnomaly(a: ActiveAnomaly): { title: string; detail: string } {
  const loc = SITE_LABEL[a.site.kind];
  const c = a.confidence;
  const moving = a.def.type === 'hall-figure' || a.def.type === 'lean' || a.def.type === 'shoulder';
  const lead =
    a.def.tier === 'subtle'
      ? 'Visual irregularity'
      : c < 0.32
        ? 'Low-confidence visual anomaly'
        : moving
          ? 'Possible movement'
          : 'Unidentified shape';
  const level = c < 0.32 ? 'Low confidence' : c < 0.55 ? 'Moderate confidence' : 'Elevated confidence';
  return { title: `${lead} ${loc}`, detail: `${level} · ${(a.t1 - a.t0).toFixed(1)} s` };
}
