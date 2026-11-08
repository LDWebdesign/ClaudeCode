/**
 * Audio graph shared by the spirit box and the recorder.
 *
 *   sweep static ─┐
 *   broadcast bleed ─┼─> master ─> limiter ─> speakers
 *   vocal fragments ─┤                  └──> output analyser (waveform, signal)
 *   audio events ───┘                  └──> record bus <── microphone (not to speakers)
 */
export interface Buses {
  static: GainNode;
  bleed: GainNode;
  voice: GainNode;
  event: GainNode;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly buses: Buses;
  readonly outputAnalyser: AnalyserNode;
  /** listens only to vocal-band sources (fragments and broadcast bleed) */
  readonly voxAnalyser: AnalyserNode;
  readonly recordDest: MediaStreamAudioDestinationNode;
  readonly noise: AudioBuffer;
  private micSource?: MediaStreamAudioSourceNode;
  private micRec?: GainNode;
  micAnalyser?: AnalyserNode;

  constructor() {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    const ctx = this.ctx;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 3;
    limiter.ratio.value = 14;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.16;
    // keeps limiter overshoot below full scale (no clipping in recordings)
    const trim = ctx.createGain();
    trim.gain.value = 0.8;

    this.master = ctx.createGain();
    this.master.connect(limiter);
    limiter.connect(trim);
    trim.connect(ctx.destination);

    this.outputAnalyser = ctx.createAnalyser();
    this.outputAnalyser.fftSize = 2048;
    this.outputAnalyser.smoothingTimeConstant = 0.2;
    trim.connect(this.outputAnalyser);

    this.recordDest = ctx.createMediaStreamDestination();
    trim.connect(this.recordDest);

    this.voxAnalyser = ctx.createAnalyser();
    this.voxAnalyser.fftSize = 512;

    const bus = () => {
      const g = ctx.createGain();
      g.connect(this.master);
      return g;
    };
    this.buses = { static: bus(), bleed: bus(), voice: bus(), event: bus() };
    this.buses.voice.connect(this.voxAnalyser);
    this.buses.bleed.connect(this.voxAnalyser);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Must be called from a user gesture on iOS/Safari. */
  async resume(): Promise<void> {
    // The audio session is left on automatic: forcing play-and-record on iOS can route output
    // to the earpiece instead of the speaker.
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setVolume(v: number): void {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  attachMic(stream: MediaStream): AnalyserNode {
    this.detachMic();
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micAnalyser = this.ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.micAnalyser.smoothingTimeConstant = 0;
    this.micSource.connect(this.micAnalyser);
    // The investigator's voice goes to recordings only, never back out of the speaker.
    this.micRec = this.ctx.createGain();
    this.micRec.gain.value = 0.6;
    this.micSource.connect(this.micRec);
    this.micRec.connect(this.recordDest);
    return this.micAnalyser;
  }

  detachMic(): void {
    this.micSource?.disconnect();
    this.micRec?.disconnect();
    this.micSource = undefined;
    this.micRec = undefined;
    this.micAnalyser = undefined;
  }

  /** RMS level of the vocal-band sources, 0..1. */
  voxLevel(scratch: Float32Array<ArrayBuffer>): number {
    this.voxAnalyser.getFloatTimeDomainData(scratch);
    let s = 0;
    for (let i = 0; i < scratch.length; i++) s += scratch[i] * scratch[i];
    return Math.sqrt(s / scratch.length);
  }
}

const curveCache = new Map<string, Float32Array<ArrayBuffer>>();

/** Soft saturation followed by bit-depth reduction, in one waveshaper curve. */
export function radioCurve(distortion: number): Float32Array<ArrayBuffer> {
  const key = distortion.toFixed(2);
  const hit = curveCache.get(key);
  if (hit) return hit;
  const n = 2048;
  const curve = new Float32Array(n);
  const k = 1 + distortion * 18;
  const levels = Math.round(2 ** (10 - distortion * 5.5)); // ~10 bits clean -> ~4.5 bits crushed
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const sat = ((1 + k) * x) / (1 + k * Math.abs(x));
    curve[i] = Math.round(sat * levels) / levels;
  }
  curveCache.set(key, curve);
  return curve;
}

/** Band-limited, saturated "through a cheap receiver" chain. */
export function radioChain(
  ctx: BaseAudioContext,
  opts: { highpass: number; lowpass: number; presence: number; distortion: number },
): { input: AudioNode; output: AudioNode } {
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = opts.highpass;
  hp.Q.value = 0.9;
  const peak = ctx.createBiquadFilter();
  peak.type = 'peaking';
  peak.frequency.value = opts.presence;
  peak.Q.value = 1.1;
  peak.gain.value = 6;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = opts.lowpass;
  lp.Q.value = 1.2;
  const drive = ctx.createGain();
  drive.gain.value = 1 + opts.distortion * 2.2;
  const shaper = ctx.createWaveShaper();
  shaper.curve = radioCurve(opts.distortion);
  shaper.oversample = 'none';
  hp.connect(peak).connect(lp).connect(drive).connect(shaper);
  return { input: hp, output: shaper };
}
