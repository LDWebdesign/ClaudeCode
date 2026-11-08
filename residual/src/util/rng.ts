/** Random source abstraction so every engine can be driven deterministically in tests. */
export interface Rng {
  /** uniform in [0, 1) */
  next(): number;
}

export const mathRng: Rng = { next: () => Math.random() };

/** Small, fast seeded PRNG (mulberry32). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export function between(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng.next();
}

export function inRange(rng: Rng, range: readonly [number, number]): number {
  return between(rng, range[0], range[1]);
}

export function chance(rng: Rng, p: number): boolean {
  return rng.next() < p;
}

export function intBetween(rng: Rng, min: number, maxInclusive: number): number {
  return Math.floor(between(rng, min, maxInclusive + 1));
}

/** Picks a key from a table of relative weights. Returns undefined when all weights are zero. */
export function pickWeighted<K extends string>(rng: Rng, table: Partial<Record<K, number>>): K | undefined {
  let total = 0;
  for (const w of Object.values(table) as number[]) total += Math.max(0, w || 0);
  if (total <= 0) return undefined;
  let r = rng.next() * total;
  let last: K | undefined;
  for (const [k, w] of Object.entries(table) as [K, number][]) {
    const weight = Math.max(0, w || 0);
    if (weight <= 0) continue;
    last = k;
    if ((r -= weight) < 0) return k;
  }
  return last;
}

/** Picks an item using a weight accessor. Returns undefined for an empty or zero-weight list. */
export function pickBy<T>(rng: Rng, items: readonly T[], weight: (item: T) => number): T | undefined {
  let total = 0;
  const weights = items.map((it) => {
    const w = Math.max(0, weight(it) || 0);
    total += w;
    return w;
  });
  if (total <= 0) return undefined;
  let r = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    if ((r -= weights[i]) < 0) return items[i];
  }
  for (let i = items.length - 1; i >= 0; i--) if (weights[i] > 0) return items[i];
  return undefined;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng.next() * items.length)];
}

/** Approximately normal sample (sum of uniforms), mean 0, sd ~1. */
export function gaussian(rng: Rng): number {
  return (rng.next() + rng.next() + rng.next() + rng.next() - 2) * 1.732;
}

/** Exponential waiting time for a Poisson process with the given rate per second. */
export function exponential(rng: Rng, ratePerSec: number): number {
  if (ratePerSec <= 0) return Infinity;
  return -Math.log(1 - rng.next()) / ratePerSec;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
