/**
 * Central configuration for every probabilistic or perceptual behaviour in Residual.
 *
 * Nothing else in the codebase hardcodes a probability, delay, or intensity: engines receive
 * the live config object and read from it at decision time, so changes made in the
 * Calibration sheet (persisted to localStorage) apply immediately.
 *
 * Weight tables are relative weights, not percentages; they are normalised when drawn.
 */

export type Range = readonly [min: number, max: number];

export interface DelayBand {
  weight: number;
  /** seconds after the investigator stops speaking */
  range: Range;
}

export interface SpiritBoxConfig {
  sweep: {
    band: 'FM' | 'AM';
    /** milliseconds the receiver dwells on each frequency step */
    stepMs: number;
    /** random variation applied to each step, as a fraction of stepMs */
    stepJitter: number;
    direction: 'up' | 'down';
  };
  correlation: {
    /** relative weights for how a fragment relates to what was asked */
    weights: { unrelated: number; loose: number; relevant: number; uncanny: number };
    /** seconds for a question's concepts to lose half their influence */
    memoryHalfLifeSec: number;
    /** how strongly the most recent question is preferred over older ones (0 = no preference) */
    recencyBias: number;
    /** within the uncanny tier: chance of echoing a word from an older question */
    delayedEchoChance: number;
    /** minimum age (s) of a question before its words can be echoed back */
    delayedEchoMinAgeSec: number;
  };
  response: {
    /** chance a question gets no response at all */
    silenceChance: number;
    delays: DelayBand[];
    /** multiplies every delay band (0.5 = twice as quick, 2 = twice as slow) */
    delayScale: number;
    /** chance a scheduled response is pulled forward to land while the investigator is talking */
    interruptChance: number;
    /** chance a response is a short burst of two fragments */
    burstChance: number;
    /** unprompted fragments per minute of investigator silence */
    spontaneousPerMinute: number;
    /** seconds of investigator silence before spontaneous fragments may occur */
    spontaneousAfterSilenceSec: number;
    /** minimum seconds between any two fragments */
    minGapSec: number;
    /** chance a response is a non-vocal audio event (knock, breath, carrier) instead of a voice */
    audioEventChance: number;
  };
  /** relative weights for the physical form a vocal fragment takes */
  forms: { word: number; partial: number; syllable: number; pseudo: number; unintelligible: number };
  repetition: {
    /** a vocabulary entry cannot recur within this many fragments */
    cooldownFragments: number;
    /** ...or within this many seconds */
    cooldownSec: number;
  };
  audio: {
    masterVolume: number;
    staticLevel: number;
    voiceLevel: number;
    /** 0..1 saturation/bit-reduction applied to vocal fragments */
    distortion: number;
    /** 0..1 overall intelligibility; lower = more gating, narrower band, more dropouts */
    clarity: number;
    /** 0..1 how often distant broadcast fragments bleed through the sweep */
    radioBleed: number;
  };
  log: {
    /** fragments below this clarity are logged without an interpretation */
    interpretClarity: number;
    /** chance a low-clarity fragment goes unlogged (only audible on the recording) */
    unloggedLowClarityChance: number;
    /** seconds after playback before an interpretation appears in the log */
    interpretDelaySec: Range;
  };
  listener: {
    /** dB above the adaptive noise floor that counts as speech */
    vadThresholdDb: number;
    /** ms of continuous energy before speech is considered started */
    vadAttackMs: number;
    /** ms of quiet before an utterance is considered finished */
    vadReleaseMs: number;
    /** use the browser speech recogniser for transcription when available */
    transcription: boolean;
  };
}

export interface CameraConfig {
  /** seconds per scan cycle; each completed scan rolls the anomaly table once */
  scanIntervalSec: Range;
  /** relative weights for what a completed scan produces */
  tiers: { normal: number; subtle: number; unusual: number; uncanny: number };
  /** quiet period after an anomaly, in seconds, during which scans always come back normal */
  refractorySec: { subtle: Range; unusual: Range; uncanny: Range };
  /** chance of a long dormant stretch beginning after any scan */
  dormancyChance: number;
  dormancySec: Range;
  /** 0..1 global multiplier on anomaly density/opacity */
  visibility: number;
  /** 0..1 global multiplier on anomaly motion amplitude */
  movement: number;
  /** chance an unusual/uncanny anomaly lasts only a few frames (visible mainly on review) */
  footageOnlyChance: number;
  /** chance a completed anomaly is written to the investigation log */
  logChance: { subtle: number; unusual: number; uncanny: number };
  detection: {
    /** 0..1; higher finds more (and weaker) candidate locations */
    sensitivity: number;
    analysisIntervalMs: number;
    /** consecutive analyses a location must persist before it can host an anomaly */
    minPersistence: number;
    /** 0..1 camera steadiness required before an anomaly may appear */
    stillnessRequired: number;
  };
  image: {
    exposureEv: number;
    grain: number;
    /** 0..1 colour retained in low-light mode */
    saturation: number;
    nightVision: boolean;
  };
}

export interface ResidualConfig {
  spiritBox: SpiritBoxConfig;
  camera: CameraConfig;
  /** shows engine decisions and detected locations; for tuning only */
  diagnostics: boolean;
}

export const DEFAULT_CONFIG: ResidualConfig = {
  spiritBox: {
    sweep: { band: 'FM', stepMs: 115, stepJitter: 0.35, direction: 'up' },
    correlation: {
      weights: { unrelated: 65, loose: 25, relevant: 9, uncanny: 1 },
      memoryHalfLifeSec: 75,
      recencyBias: 0.45,
      delayedEchoChance: 0.45,
      delayedEchoMinAgeSec: 25,
    },
    response: {
      silenceChance: 0.34,
      delays: [
        { weight: 26, range: [1, 3] },
        { weight: 34, range: [5, 8] },
        { weight: 28, range: [10, 16] },
        { weight: 12, range: [18, 40] },
      ],
      delayScale: 1,
      interruptChance: 0.07,
      burstChance: 0.08,
      spontaneousPerMinute: 0.22,
      spontaneousAfterSilenceSec: 25,
      minGapSec: 3.5,
      audioEventChance: 0.07,
    },
    forms: { word: 52, partial: 18, syllable: 12, pseudo: 10, unintelligible: 8 },
    repetition: { cooldownFragments: 60, cooldownSec: 900 },
    audio: {
      masterVolume: 0.7,
      staticLevel: 0.4,
      voiceLevel: 0.75,
      distortion: 0.5,
      clarity: 0.5,
      radioBleed: 0.45,
    },
    log: {
      interpretClarity: 0.42,
      unloggedLowClarityChance: 0.4,
      interpretDelaySec: [1.2, 3.5],
    },
    listener: {
      vadThresholdDb: 11,
      vadAttackMs: 160,
      vadReleaseMs: 750,
      transcription: true,
    },
  },
  camera: {
    scanIntervalSec: [8, 13],
    tiers: { normal: 85, subtle: 10, unusual: 4, uncanny: 1 },
    refractorySec: { subtle: [40, 90], unusual: [90, 180], uncanny: [240, 480] },
    dormancyChance: 0.05,
    dormancySec: [120, 300],
    visibility: 0.5,
    movement: 0.5,
    footageOnlyChance: 0.2,
    logChance: { subtle: 0.2, unusual: 0.5, uncanny: 0.45 },
    detection: {
      sensitivity: 0.5,
      analysisIntervalMs: 450,
      minPersistence: 3,
      stillnessRequired: 0.6,
    },
    image: { exposureEv: 0.2, grain: 0.5, saturation: 0.3, nightVision: false },
  },
  diagnostics: false,
};

const STORAGE_KEY = 'residual.config.v1';

/** Deep-merges `patch` onto `base`, keeping only keys that exist in `base` and matching types. */
export function mergeConfig<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!(key in out)) continue;
    const current = out[key];
    if (Array.isArray(current)) {
      if (Array.isArray(value) && value.length === current.length) out[key] = value;
    } else if (current !== null && typeof current === 'object') {
      out[key] = mergeConfig(current, value);
    } else if (typeof value === typeof current) {
      out[key] = value;
    }
  }
  return out as T;
}

export function cloneConfig(config: ResidualConfig): ResidualConfig {
  return JSON.parse(JSON.stringify(config)) as ResidualConfig;
}

type Listener = (config: ResidualConfig) => void;

/** Holds the live configuration and notifies subscribers when the Calibration sheet changes it. */
export class ConfigStore {
  private current: ResidualConfig;
  private listeners = new Set<Listener>();

  constructor(initial?: unknown) {
    this.current = mergeConfig(cloneConfig(DEFAULT_CONFIG), initial ?? this.load());
  }

  get value(): ResidualConfig {
    return this.current;
  }

  update(mutator: (draft: ResidualConfig) => void): void {
    const draft = cloneConfig(this.current);
    mutator(draft);
    this.current = mergeConfig(cloneConfig(DEFAULT_CONFIG), draft);
    this.save();
    for (const fn of this.listeners) fn(this.current);
  }

  reset(): void {
    this.current = cloneConfig(DEFAULT_CONFIG);
    this.save();
    for (const fn of this.listeners) fn(this.current);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private load(): unknown {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  private save(): void {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      /* storage unavailable (private mode); config still applies for this visit */
    }
  }
}
