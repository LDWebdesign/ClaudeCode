/**
 * Visual anomaly scanner: camera stream, frame loop, environment analysis, anomaly engine,
 * motion tracking and logging.
 */
import type { ConfigStore } from '../config';
import type { Session } from '../session/session';
import type { Store } from '../session/store';
import { Emitter } from '../util/emitter';
import { type Rng, between, chance, clamp, inRange, mathRng } from '../util/rng';
import { uid } from '../util/time';
import { type AnalysisResult, EnvironmentAnalyzer, type Site, estimateShift, lumaFromRgba } from './analysis';
import { type ActiveAnomaly, type AnomalyType, AnomalyEngine, type ForceOptions, type ScanResult, describeAnomaly } from './anomalies';
import { CameraRenderer } from './renderer';

export type CameraState = 'off' | 'starting' | 'live' | 'denied' | 'unavailable' | 'error';

export interface CameraEvents extends Record<string, unknown> {
  state: { state: CameraState; message?: string };
  scan: { count: number; result: ScanResult };
  frame: { t: number };
}

interface TrackCaps {
  torch?: boolean;
  exposureCompensation?: { min: number; max: number; step: number };
}

const ANALYSIS_LONG_SIDE = 160;
const TRACK_LONG_SIDE = 72;

export class CameraController extends Emitter<CameraEvents> {
  readonly video: HTMLVideoElement;
  readonly analyzer = new EnvironmentAnalyzer();
  readonly anomalies: AnomalyEngine;
  renderer?: CameraRenderer;
  state: CameraState = 'off';
  sites: Site[] = [];
  lastAnalysis?: AnalysisResult;
  stillness = 0;
  /** 0..1 displayed anomaly confidence (mostly genuine frame irregularity) */
  confidence = 0;
  facing: 'environment' | 'user' = 'environment';
  caps: TrackCaps = {};
  torchOn = false;

  private stream?: MediaStream;
  private session?: Session;
  private raf = 0;
  private vfc = 0;
  private mask: HTMLCanvasElement;
  private maskCtx: CanvasRenderingContext2D;
  private probe: HTMLCanvasElement;
  private probeCtx: CanvasRenderingContext2D;
  private track: HTMLCanvasElement;
  private trackCtx: CanvasRenderingContext2D;
  private prevTrack?: Float32Array;
  private lastAnalysisAt = 0;
  private captureWaiters: ((b: Blob | null) => void)[] = [];
  private loggedIds = new Map<number, { logged: boolean; thumb?: Promise<string | undefined> }>();
  private t0 = performance.now();

  constructor(
    private readonly config: ConfigStore,
    private readonly store: Store,
    private readonly rng: Rng = mathRng,
  ) {
    super();
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.setAttribute('playsinline', '');
    this.mask = document.createElement('canvas');
    this.maskCtx = this.mask.getContext('2d')!;
    this.probe = document.createElement('canvas');
    this.probeCtx = this.probe.getContext('2d', { willReadFrequently: true })!;
    this.track = document.createElement('canvas');
    this.trackCtx = this.track.getContext('2d', { willReadFrequently: true })!;
    this.anomalies = new AnomalyEngine(() => this.config.value, rng, this.clock());
    this.anomalies.on('scan', (s) => this.emit('scan', { count: s.count, result: s.result }));
    this.anomalies.on('start', (a) => this.onAnomalyStart(a));
    this.anomalies.on('peak', (a) => this.onAnomalyPeak(a));
    this.anomalies.on('end', (a) => this.onAnomalyEnd(a));
  }

  private clock(): number {
    return this.session ? this.session.clock() : (performance.now() - this.t0) / 1000;
  }

  attach(session: Session): void {
    this.session = session;
    this.anomalies.reset(session.clock());
    this.analyzer.reset();
  }

  async start(canvas: HTMLCanvasElement): Promise<void> {
    if (this.state === 'live' || this.state === 'starting') return;
    this.setState('starting');
    if (!navigator.mediaDevices?.getUserMedia) {
      this.setState('unavailable', 'This browser cannot access a camera here. Camera access needs a secure (https) page.');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: this.facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
    } catch (err) {
      const name = (err as DOMException).name;
      if (name === 'NotAllowedError' || name === 'SecurityError') this.setState('denied', 'Camera permission was refused. Allow camera access for this site in your browser settings, then try again.');
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') this.setState('unavailable', 'No camera was found on this device.');
      else this.setState('error', (err as Error).message);
      return;
    }
    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch {
      /* autoplay restrictions: muted inline video should still play */
    }
    try {
      this.renderer = new CameraRenderer(canvas);
    } catch (err) {
      this.stopStream();
      this.setState('error', `The camera view needs WebGL: ${(err as Error).message}`);
      return;
    }
    this.readCaps();
    this.anomalies.reset(this.clock());
    this.analyzer.reset();
    this.setState('live');
    this.loop();
    this.applyExposure();
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    const v = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
    if (this.vfc) v.cancelVideoFrameCallback?.(this.vfc);
    this.vfc = 0;
    this.anomalies.abort();
    this.stopStream();
    this.renderer = undefined;
    this.setState('off');
  }

  async flip(canvas: HTMLCanvasElement): Promise<void> {
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    this.stop();
    await this.start(canvas);
  }

  async setTorch(on: boolean): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || !this.caps.torch) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
      this.torchOn = on;
    } catch {
      this.torchOn = false;
    }
  }

  /** Applies exposure compensation in hardware where the camera supports it (the shader applies the rest). */
  async applyExposure(): Promise<void> {
    const ec = this.caps.exposureCompensation;
    const track = this.stream?.getVideoTracks()[0];
    if (!ec || !track) return;
    const ev = clamp(this.config.value.camera.image.exposureEv, ec.min, ec.max);
    try {
      await track.applyConstraints({ advanced: [{ exposureCompensation: ev } as MediaTrackConstraintSet] });
    } catch {
      /* unsupported at runtime */
    }
  }

  get hardwareExposure(): boolean {
    return !!this.caps.exposureCompensation;
  }

  /** The rendered (processed) frame as a JPEG. */
  capture(): Promise<Blob | null> {
    return new Promise((resolve) => this.captureWaiters.push(resolve));
  }

  get canvasStream(): MediaStream | undefined {
    const c = this.renderer?.canvas as (HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }) | undefined;
    return c?.captureStream?.(30);
  }

  /** Shows one of the given anomaly types now, if the scene has somewhere to put it. */
  force(types?: AnomalyType | readonly AnomalyType[], opts: ForceOptions = {}): ActiveAnomaly | undefined {
    this.anomalies.abort();
    return this.anomalies.force(this.clock(), this.sites, types, opts);
  }

  // --- internals ------------------------------------------------------------------------

  private setState(state: CameraState, message?: string): void {
    this.state = state;
    this.emit('state', { state, message });
  }

  private stopStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.video.srcObject = null;
    this.torchOn = false;
  }

  private readCaps(): void {
    const track = this.stream?.getVideoTracks()[0];
    const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean; exposureCompensation?: { min: number; max: number; step: number } };
    this.caps = { torch: !!caps.torch, exposureCompensation: caps.exposureCompensation };
  }

  private loop = (): void => {
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (this.state !== 'live') return;
    try {
      this.frame();
    } catch (err) {
      // never let one bad frame stop the feed
      console.error('[residual] camera frame failed', err);
      this.anomalies.abort();
    }
    if (v.requestVideoFrameCallback) this.vfc = v.requestVideoFrameCallback(this.loop);
    else this.raf = requestAnimationFrame(this.loop);
  };

  private frame(): void {
    const r = this.renderer;
    const v = this.video;
    if (!r || v.readyState < 2 || !v.videoWidth) return;
    const cfg = this.config.value.camera;
    const now = this.clock();
    const vw = v.videoWidth;
    const vh = v.videoHeight;

    if (performance.now() - this.lastAnalysisAt >= cfg.detection.analysisIntervalMs) {
      this.lastAnalysisAt = performance.now();
      this.analyze(vw, vh);
    }
    if (this.anomalies.active) this.trackMotion(vw, vh);
    this.anomalies.update(now, this.sites, this.stillness);

    // mask sized to the frame aspect
    const mw = 480;
    const mh = Math.round((mw * vh) / vw);
    if (this.mask.width !== mw || this.mask.height !== mh) {
      this.mask.width = mw;
      this.mask.height = mh;
    }
    const drew = this.anomalies.draw(this.maskCtx, now);

    r.resize(vw, vh);
    const crop = r.crop;
    this.anomalies.visible = { x: crop.ox, y: crop.oy, w: crop.sx, h: crop.sy };
    r.render(v, vw, vh, drew ? this.mask : null, {
      exposure: 2 ** cfg.image.exposureEv * (this.hardwareExposure ? 0.85 : 1),
      grain: cfg.image.grain,
      saturation: cfg.image.saturation,
      nightVision: cfg.image.nightVision,
      mirror: this.facing === 'user',
      time: now,
    });

    if (this.captureWaiters.length) {
      const waiters = this.captureWaiters.splice(0);
      r.canvas.toBlob((b) => waiters.forEach((w) => w(b)), 'image/jpeg', 0.88);
    }

    this.updateConfidence(now);
    this.emit('frame', { t: now });
  }

  private analyze(vw: number, vh: number): void {
    const scale = ANALYSIS_LONG_SIDE / Math.max(vw, vh);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (this.probe.width !== w || this.probe.height !== h) {
      this.probe.width = w;
      this.probe.height = h;
    }
    this.probeCtx.drawImage(this.video, 0, 0, w, h);
    const frame = lumaFromRgba(this.probeCtx.getImageData(0, 0, w, h).data, w, h);
    const res = this.analyzer.analyze(frame, this.config.value.camera.detection.sensitivity);
    this.lastAnalysis = res;
    this.sites = res.sites;
    const steady = clamp(1 - res.motion.magnitude / 0.012, 0, 1);
    this.stillness = this.stillness * 0.5 + steady * 0.5;
  }

  /** Keeps an active anomaly registered to the scene under small hand movement. */
  private trackMotion(vw: number, vh: number): void {
    const scale = TRACK_LONG_SIDE / Math.max(vw, vh);
    const w = Math.round(vw * scale);
    const h = Math.round(vh * scale);
    if (this.track.width !== w || this.track.height !== h) {
      this.track.width = w;
      this.track.height = h;
      this.prevTrack = undefined;
    }
    this.trackCtx.drawImage(this.video, 0, 0, w, h);
    const cur = lumaFromRgba(this.trackCtx.getImageData(0, 0, w, h).data, w, h).data;
    if (this.prevTrack) {
      const s = estimateShift(this.prevTrack, cur, w, h);
      // content moved by (dx,dy) in the frame: move the anomaly with it
      if (s.magnitude > 0.045) this.anomalies.abort();
      else if (s.magnitude > 0) this.anomalies.applyShift(s.dx, s.dy);
    }
    this.prevTrack = cur;
  }

  private updateConfidence(now: number): void {
    const real = this.lastAnalysis?.irregularity ?? 0;
    const a = this.anomalies.active;
    let injected = 0;
    if (a && !a.footageOnly && this.loggedIds.get(a.id)?.logged) {
      const t = (now - a.t0) / Math.max(0.01, a.t1 - a.t0);
      injected = a.confidence * Math.sin(Math.PI * clamp(t, 0, 1)) * between(this.rng, 0.7, 1.1);
    }
    const target = clamp(real * 0.55 + injected + (this.rng.next() - 0.5) * 0.02, 0, 1);
    // rises quickly, decays slowly, like a meter with a peak hold
    this.confidence = target > this.confidence ? this.confidence * 0.7 + target * 0.3 : this.confidence * 0.985 + target * 0.015;
  }

  private onAnomalyStart(a: ActiveAnomaly): void {
    this.prevTrack = undefined;
    // test anomalies are for looking at, not for the investigation log
    if (a.test) return;
    const logChance = this.config.value.camera.logChance[a.def.tier];
    this.loggedIds.set(a.id, { logged: chance(this.rng, a.footageOnly ? logChance * 0.4 : logChance) });
  }

  private onAnomalyPeak(a: ActiveAnomaly): void {
    const entry = this.loggedIds.get(a.id);
    if (!entry || !this.session) return;
    const session = this.session;
    entry.thumb = this.capture().then(async (blob) => {
      if (!blob) return undefined;
      const id = uid('m');
      await this.store.put('media', { id, sessionId: session.id, t: Date.now(), kind: 'thumb', blob });
      return id;
    });
  }

  private onAnomalyEnd(a: ActiveAnomaly): void {
    const entry = this.loggedIds.get(a.id);
    this.loggedIds.delete(a.id);
    const session = this.session;
    if (!session || !entry) return;
    const { title, detail } = describeAnomaly(a);
    const meta = { type: a.def.type, tier: a.def.tier, site: a.site.kind, footageOnly: a.footageOnly, density: +a.density.toFixed(2) };
    const at = session.epoch(a.t0);
    window.setTimeout(async () => {
      if (this.session !== session) return;
      const mediaId = await entry.thumb;
      session.log({
        t: at,
        type: 'visual',
        mode: 'camera',
        title,
        detail,
        confidence: +a.confidence.toFixed(2),
        hidden: !entry.logged,
        mediaId: entry.logged ? mediaId : undefined,
        meta,
      });
    }, inRange(this.rng, [1, 3.5]) * 1000);
  }
}
