import { describe, expect, it } from 'vitest';
import { EnvironmentAnalyzer, type Site } from '../src/camera/analysis';
import { type ActiveAnomaly, AnomalyEngine, type ScanResult } from '../src/camera/anomalies';
import { DEFAULT_CONFIG, type ResidualConfig, cloneConfig } from '../src/config';
import { seededRng } from '../src/util/rng';
import { scenes } from './fixtures/scenes';

function sitesFor(scene: keyof typeof scenes): Site[] {
  const a = new EnvironmentAnalyzer();
  let sites: Site[] = [];
  for (let i = 0; i < 4; i++) sites = a.analyze(scenes[scene]().noise(0.015, i + 1), 0.5).sites;
  return sites;
}

function simulate(sites: Site[], hours: number, opts: { stillness?: number; config?: (c: ResidualConfig) => void; seed?: number } = {}) {
  const c = cloneConfig(DEFAULT_CONFIG);
  opts.config?.(c);
  const engine = new AnomalyEngine(() => c, seededRng(opts.seed ?? 42));
  const started: ActiveAnomaly[] = [];
  const scans: ScanResult[] = [];
  engine.on('start', (a) => started.push(a));
  engine.on('scan', (s) => scans.push(s.result));
  for (let t = 0; t < hours * 3600; t += 0.1) engine.update(t, sites, opts.stillness ?? 1);
  return { started, scans };
}

describe('anomaly engine', () => {
  const rich = [...sitesFor('doorway'), ...sitesFor('hallway'), ...sitesFor('corner'), ...sitesFor('chair')];

  it('has rich test sites', () => {
    const kinds = new Set(rich.map((s) => s.kind));
    expect(kinds.has('doorway') && kinds.has('hallway') && kinds.has('dark-corner') && kinds.has('furniture')).toBe(true);
  });

  it('keeps the overwhelming majority of scans normal, with long quiet stretches', () => {
    const { started, scans } = simulate(rich, 6);
    const anomalyShare = scans.filter((s) => s === 'anomaly').length / scans.length;
    expect(anomalyShare).toBeGreaterThan(0.01);
    expect(anomalyShare).toBeLessThan(0.08);
    // no anomaly starts within 30 s of the previous one ending
    for (let i = 1; i < started.length; i++) expect(started[i].t0 - started[i - 1].t1).toBeGreaterThan(30);
    // there is at least one stretch of 8+ minutes with nothing at all
    const gaps = started.slice(1).map((a, i) => a.t0 - started[i].t1);
    expect(Math.max(...gaps)).toBeGreaterThan(480);
    const perHour = started.length / 6;
    expect(perHour).toBeLessThan(25);
  });

  it('makes figure-like anomalies rare', () => {
    const { started } = simulate(rich, 12, { seed: 7 });
    const byTier = (t: string) => started.filter((a) => a.def.tier === t).length;
    expect(byTier('subtle')).toBeGreaterThan(byTier('unusual'));
    expect(byTier('unusual')).toBeGreaterThan(byTier('uncanny'));
    expect(byTier('uncanny') / 12).toBeLessThan(3); // per hour
    // uncanny partial figures are brief
    for (const a of started.filter((x) => x.def.tier === 'uncanny')) expect(a.t1 - a.t0).toBeLessThan(1.4);
  });

  it('never produces anything without a believable location', () => {
    expect(simulate([], 4).started).toEqual([]);
    expect(simulate(sitesFor('blank'), 4).started).toEqual([]);
  });

  it('never produces anything while the camera is moving', () => {
    expect(simulate(rich, 4, { stillness: 0.2 }).started).toEqual([]);
  });

  it('places edge anomalies on the occluding edge, mostly hidden behind it', () => {
    const { started } = simulate(sitesFor('doorway'), 40, {
      config: (c) => (c.camera.tiers = { normal: 0, subtle: 0, unusual: 1, uncanny: 1 }),
    });
    const edge = started.filter((a) => ['crown', 'shoulder', 'brim', 'lean', 'partial-figure'].includes(a.def.type));
    expect(edge.length).toBeGreaterThan(20);
    for (const a of edge) {
      const o = a.site.occluder!;
      const y = a.placement.ay;
      const lx = o.x0 + ((o.x1 - o.x0) * (y - o.y0)) / (o.y1 - o.y0);
      // anchored on the occluding edge, nudged a hair toward the open side (clip inset)
      expect(Math.abs(a.placement.ax - (lx + o.open * 0.004))).toBeLessThan(0.002);
      // shape centre sits on the hidden side (offset points away from the open side)
      expect(Math.sign(a.placement.k[4])).toBe(-o.open);
      // and never in the middle of the frame, floating free
      expect(a.placement.clip).toBeTruthy();
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(0.86);
    }
  });

  it('places hallway figures far away (small) near the vanishing point', () => {
    const hall = sitesFor('hallway');
    const { started } = simulate(hall, 30, { config: (c) => (c.camera.tiers = { normal: 0, subtle: 0, unusual: 1, uncanny: 0 }) });
    const figs = started.filter((a) => a.def.type === 'hall-figure');
    expect(figs.length).toBeGreaterThan(5);
    for (const f of figs) {
      expect(f.placement.scale).toBeLessThan(0.15);
      expect(Math.abs(f.placement.ax - 0.52)).toBeLessThan(0.1);
    }
  });

  it('forces a held test figure on demand, only where it can be placed', () => {
    const engine = new AnomalyEngine(() => cloneConfig(DEFAULT_CONFIG), seededRng(5));
    const figures = ['partial-figure', 'lean', 'hall-figure', 'stair-figure', 'window-shape'] as const;
    const a = engine.force(0, sitesFor('doorway'), figures, { hold: 4, test: true });
    expect(a).toBeTruthy();
    expect(figures).toContain(a!.def.type);
    expect(a!.test).toBe(true);
    expect(a!.t1 - a!.t0).toBeGreaterThanOrEqual(4);
    // nothing to hide a figure behind on a plain wall
    expect(new AnomalyEngine(() => cloneConfig(DEFAULT_CONFIG), seededRng(5)).force(0, sitesFor('blank'), figures, { hold: 4, test: true })).toBeUndefined();
  });

  it('can make anomalies that last only a few frames', () => {
    const { started } = simulate(rich, 12, { config: (c) => (c.camera.footageOnlyChance = 1) });
    const short = started.filter((a) => a.footageOnly);
    expect(short.length).toBeGreaterThan(0);
    for (const a of short) expect(a.t1 - a.t0).toBeLessThan(0.11);
  });
});
