/**
 * Hears the investigator.
 *
 * Two layers:
 *  - a voice-activity detector on the microphone with an adaptive noise floor. It always
 *    works (offline too) and gives accurate speech start/end times.
 *  - the browser speech recogniser (Web Speech API) for transcripts, where available. Some
 *    browsers process this audio on a server; when it is unavailable or offline, questions are
 *    still detected and logged, just without words, and the correlation engine falls back to
 *    unrelated fragments.
 */
import type { ResidualConfig } from '../config';
import { Emitter } from '../util/emitter';

export type TranscriptionStatus = 'active' | 'starting' | 'unavailable' | 'offline' | 'denied' | 'off';

export interface ListenerEvents extends Record<string, unknown> {
  speechstart: { at: number };
  interim: { text: string };
  utterance: { id: string; at: number; text: string | null; durationSec: number };
  /** a transcript arrived late for an utterance already emitted without one */
  amend: { id: string; text: string };
  status: { transcription: TranscriptionStatus };
}

interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type RecognitionCtor = new () => RecognitionLike;

export function recognitionAvailable(): boolean {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

let seq = 0;
const nextId = () => `u${Date.now().toString(36)}${(seq++).toString(36)}`;

export class Listener extends Emitter<ListenerEvents> {
  private analyser?: AnalyserNode;
  private buf = new Float32Array(1024);
  private timer?: number;
  private floorDb = -60;
  private speaking = false;
  private aboveSince: number | null = null;
  private belowSince: number | null = null;
  private onsetAt = 0;
  private suppressedUntil = 0;
  private recognition?: RecognitionLike;
  private recogActive = false;
  private restarts: number[] = [];
  private awaiting?: { id: string; at: number; durationSec: number; timer: number };
  private lastEmitted?: { id: string; at: number; transcribed: boolean };
  private recentFragments: string[] = [];
  level = -100;
  status: TranscriptionStatus = 'off';

  constructor(
    private readonly config: () => ResidualConfig,
    /** session clock, seconds */
    private readonly clock: () => number,
  ) {
    super();
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Threshold, in dB, currently required to count as speech. */
  get thresholdDb(): number {
    return this.floorDb + this.config().spiritBox.listener.vadThresholdDb + (this.clock() < this.suppressedUntil ? 9 : 0);
  }

  start(analyser: AnalyserNode): void {
    this.stop();
    this.analyser = analyser;
    this.buf = new Float32Array(analyser.fftSize);
    this.timer = window.setInterval(() => this.poll(), 20);
    if (this.config().spiritBox.listener.transcription) this.startRecognition();
    else this.setStatus('off');
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
    this.analyser = undefined;
    this.stopRecognition();
    this.speaking = false;
  }

  setTranscription(on: boolean): void {
    if (on && !this.recogActive && this.analyser) this.startRecognition();
    if (!on) {
      this.stopRecognition();
      this.setStatus('off');
    }
  }

  /** Raise the speech threshold while the app itself is making sound. */
  suppress(untilSec: number, fragmentText?: string): void {
    this.suppressedUntil = Math.max(this.suppressedUntil, untilSec);
    if (fragmentText) {
      this.recentFragments.unshift(fragmentText.toLowerCase());
      this.recentFragments.length = Math.min(this.recentFragments.length, 6);
    }
  }

  /** Inject an utterance directly (typed question, or tests). */
  inject(text: string): void {
    const at = this.clock();
    const id = nextId();
    this.lastEmitted = { id, at, transcribed: true };
    this.emit('utterance', { id, at, text, durationSec: 0 });
  }

  // --- voice activity ---------------------------------------------------------------------

  private poll(): void {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.buf);
    let s = 0;
    for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    const db = 20 * Math.log10(Math.sqrt(s / this.buf.length) + 1e-9);
    this.level = db;

    // Adaptive floor: falls quickly, rises slowly (so sustained speech doesn't become "floor").
    if (db < this.floorDb) this.floorDb += (db - this.floorDb) * 0.2;
    else this.floorDb += (db - this.floorDb) * (this.speaking ? 0.0004 : 0.003);
    this.floorDb = Math.max(-95, Math.min(-25, this.floorDb));

    const now = this.clock();
    const cfg = this.config().spiritBox.listener;
    const above = db > this.thresholdDb;

    if (!this.speaking) {
      if (above) {
        this.aboveSince ??= now;
        if ((now - this.aboveSince) * 1000 >= cfg.vadAttackMs) {
          this.speaking = true;
          this.onsetAt = this.aboveSince;
          this.belowSince = null;
          this.emit('speechstart', { at: this.onsetAt });
        }
      } else this.aboveSince = null;
    } else if (!above) {
      this.belowSince ??= now;
      if ((now - this.belowSince) * 1000 >= cfg.vadReleaseMs) {
        this.speaking = false;
        this.aboveSince = null;
        const end = this.belowSince;
        const durationSec = end - this.onsetAt;
        if (durationSec >= 0.35) this.vadUtterance(end, durationSec);
      }
    } else this.belowSince = null;
  }

  private vadUtterance(at: number, durationSec: number): void {
    if (this.status !== 'active' && this.status !== 'starting') {
      const id = nextId();
      this.lastEmitted = { id, at, transcribed: false };
      this.emit('utterance', { id, at, text: null, durationSec });
      return;
    }
    // Give the recogniser a moment to deliver its transcript.
    if (this.awaiting) this.flushAwaiting();
    const id = nextId();
    const timer = window.setTimeout(() => this.flushAwaiting(), 2600);
    this.awaiting = { id, at, durationSec, timer };
  }

  private flushAwaiting(): void {
    const a = this.awaiting;
    if (!a) return;
    window.clearTimeout(a.timer);
    this.awaiting = undefined;
    this.lastEmitted = { id: a.id, at: a.at, transcribed: false };
    this.emit('utterance', { id: a.id, at: a.at, text: null, durationSec: a.durationSec });
  }

  private onFinalTranscript(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    const now = this.clock();
    // Ignore the recogniser hearing our own fragments through the speaker.
    if (now < this.suppressedUntil + 1.5 && this.recentFragments.some((f) => clean.toLowerCase() === f)) return;

    if (this.awaiting) {
      const a = this.awaiting;
      window.clearTimeout(a.timer);
      this.awaiting = undefined;
      this.lastEmitted = { id: a.id, at: a.at, transcribed: true };
      this.emit('utterance', { id: a.id, at: a.at, text: clean, durationSec: a.durationSec });
      return;
    }
    const last = this.lastEmitted;
    if (last && !last.transcribed && now - last.at < 8) {
      last.transcribed = true;
      this.emit('amend', { id: last.id, text: clean });
      return;
    }
    // Recogniser heard speech the VAD missed (quiet voice).
    const id = nextId();
    this.lastEmitted = { id, at: now, transcribed: true };
    this.emit('utterance', { id, at: now, text: clean, durationSec: 0 });
  }

  // --- recognition ------------------------------------------------------------------------

  private setStatus(s: TranscriptionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', { transcription: s });
  }

  private startRecognition(): void {
    const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) {
      this.setStatus('unavailable');
      return;
    }
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || 'en-US';
    r.onstart = () => this.setStatus('active');
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) this.onFinalTranscript(res[0].transcript);
        else interim += res[0].transcript;
      }
      if (interim) {
        if (!this.speaking) this.emit('speechstart', { at: this.clock() });
        this.emit('interim', { text: interim.trim() });
      }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.recogActive = false;
        this.setStatus('denied');
      } else if (e.error === 'network') {
        this.setStatus('offline');
      } else if (e.error === 'audio-capture') {
        this.recogActive = false;
        this.setStatus('unavailable');
      }
    };
    r.onend = () => {
      if (!this.recogActive) return;
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 10_000);
      this.restarts.push(now);
      const wait = this.status === 'offline' ? 15_000 : this.restarts.length > 5 ? 5000 : 250;
      window.setTimeout(() => {
        if (!this.recogActive) return;
        try {
          r.start();
        } catch {
          /* already started */
        }
      }, wait);
    };
    this.recognition = r;
    this.recogActive = true;
    this.setStatus('starting');
    // Some browsers expose the API but never start it; carry on without transcripts.
    window.setTimeout(() => {
      if (this.recogActive && this.status === 'starting') this.setStatus('unavailable');
    }, 6000);
    try {
      r.start();
    } catch {
      this.setStatus('unavailable');
    }
  }

  private stopRecognition(): void {
    this.recogActive = false;
    if (this.awaiting) this.flushAwaiting();
    try {
      this.recognition?.abort();
    } catch {
      /* ignore */
    }
    this.recognition = undefined;
  }
}
