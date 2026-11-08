import { describe, expect, it } from 'vitest';
import { EnvironmentAnalyzer, type Site } from '../src/camera/analysis';
import { scenes } from './fixtures/scenes';

function sitesFor(scene: keyof typeof scenes, sensitivity = 0.5, frames = 4): Site[] {
  const a = new EnvironmentAnalyzer();
  let sites: Site[] = [];
  for (let i = 0; i < frames; i++) sites = a.analyze(scenes[scene]().noise(0.015, i + 1), sensitivity).sites;
  return sites;
}

const kinds = (s: Site[]) => s.map((x) => x.kind);

describe('environment analysis', () => {
  it('finds an open doorway with an occluding jamb', () => {
    const sites = sitesFor('doorway');
    const door = sites.find((s) => s.kind === 'doorway');
    expect(door, JSON.stringify(kinds(sites))).toBeTruthy();
    expect(door!.box.x).toBeGreaterThan(0.5);
    expect(door!.box.x).toBeLessThan(0.6);
    expect(door!.box.w).toBeGreaterThan(0.15);
    expect(door!.occluder?.orientation).toBe('vertical');
    // the open side of the jamb faces into the doorway
    const jx = door!.occluder!.x0;
    expect(jx + door!.occluder!.open * 0.05).toBeGreaterThan(door!.box.x);
    expect(jx + door!.occluder!.open * 0.05).toBeLessThan(door!.box.x + door!.box.w);
    expect(door!.persistence).toBeGreaterThanOrEqual(3);
  });

  it('finds the dark gap beside a door left ajar', () => {
    const sites = sitesFor('ajar');
    const edge = sites.find((s) => s.kind === 'door-edge' || s.kind === 'doorway');
    expect(edge, JSON.stringify(kinds(sites))).toBeTruthy();
    if (edge!.kind === 'door-edge') {
      expect(edge!.occluder!.open).toBe(1); // gap is to the right of the door's edge
      expect(edge!.occluder!.x0).toBeGreaterThan(0.43);
      expect(edge!.occluder!.x0).toBeLessThan(0.49);
    }
  });

  it('finds the far end of a hallway near the vanishing point', () => {
    const sites = sitesFor('hallway');
    const hall = sites.find((s) => s.kind === 'hallway');
    expect(hall, JSON.stringify(kinds(sites))).toBeTruthy();
    const cx = hall!.box.x + hall!.box.w / 2;
    const cy = hall!.box.y + hall!.box.h / 2;
    expect(Math.abs(cx - 0.52)).toBeLessThan(0.08);
    expect(Math.abs(cy - 0.45)).toBeLessThan(0.12);
    expect(hall!.scale).toBeLessThan(0.15); // far away -> small
  });

  it('finds a dark corner', () => {
    const sites = sitesFor('corner');
    const c = sites.find((s) => s.kind === 'dark-corner');
    expect(c, JSON.stringify(kinds(sites))).toBeTruthy();
    expect(c!.box.x).toBeLessThan(0.05);
    expect(c!.box.y).toBeLessThan(0.05);
    expect(c!.region).toBeTruthy();
  });

  it('finds the top edge of furniture with space behind it', () => {
    const sites = sitesFor('chair');
    const f = sites.find((s) => s.kind === 'furniture');
    expect(f, JSON.stringify(kinds(sites))).toBeTruthy();
    expect(Math.abs(f!.occluder!.y0 - 0.55)).toBeLessThan(0.04);
    expect(f!.occluder!.open).toBe(-1);
  });

  it('finds a staircase', () => {
    const sites = sitesFor('stairs');
    expect(kinds(sites)).toContain('stairs');
  });

  it('finds nothing to hide behind on a plain wall', () => {
    const sites = sitesFor('blank', 0.8);
    expect(sites.filter((s) => s.persistence >= 3)).toEqual([]);
  });

  it('reports camera motion between shifted frames', () => {
    const a = new EnvironmentAnalyzer();
    const base = scenes.doorway();
    a.analyze(base.noise(0.01, 1), 0.5);
    const shifted = scenes.doorway();
    // shift by 3 px to the right
    const src = base.noise(0.01, 2);
    const moved = { ...src, data: new Float32Array(src.data.length) };
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) moved.data[y * src.w + x] = src.data[y * src.w + Math.max(0, x - 3)];
    void shifted;
    const r = a.analyze(moved, 0.5);
    expect(Math.round(r.motion.dx * src.w)).toBe(3);
  });
});
