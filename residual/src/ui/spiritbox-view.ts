/** Spirit box instrument panel. Everything shown is driven by the live audio graph. */
import type { AudioEngine } from '../audio/engine';
import type { ConfigStore } from '../config';
import type { SpiritBox } from '../spiritbox/controller';
import type { Listener, TranscriptionStatus } from '../spiritbox/listener';
import { clamp } from '../util/rng';
import { h } from './dom';
import { SevenSeg } from './sevenseg';

export type MicState = 'idle' | 'requesting' | 'granted' | 'denied' | 'unavailable';

const TRANSCRIPTION_TEXT: Record<TranscriptionStatus, [string, 'ok' | 'warn' | '']> = {
  active: ['Transcribing', 'ok'],
  starting: ['Starting transcription', ''],
  unavailable: ['No transcription in this browser — speech is logged untranscribed', ''],
  offline: ['Transcription offline — speech is logged untranscribed', 'warn'],
  denied: ['Transcription blocked — speech is logged untranscribed', 'warn'],
  off: ['Transcription off', ''],
};

function lut(): Uint8ClampedArray {
  const stops: [number, [number, number, number]][] = [
    [0, [10, 10, 9]],
    [0.45, [17, 17, 15]],
    [0.62, [36, 35, 32]],
    [0.76, [82, 79, 72]],
    [0.88, [164, 157, 143]],
    [1, [212, 156, 85]],
  ];
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let j = 0;
    while (j < stops.length - 2 && v > stops[j + 1][0]) j++;
    const [a, ca] = stops[j];
    const [b, cb] = stops[j + 1];
    const t = clamp((v - a) / (b - a), 0, 1);
    for (let k = 0; k < 3; k++) out[i * 3 + k] = ca[k] + (cb[k] - ca[k]) * t;
  }
  return out;
}

export class SpiritBoxView {
  readonly el: HTMLElement;
  private seg = new SevenSeg(4);
  private needle = h('i.needle');
  private scope = h('canvas.scope');
  private waterfall = h('canvas.waterfall');
  private sigBars: HTMLElement[] = [];
  private micBars: HTMLElement[] = [];
  private vox = h('span.lamp', null, 'VOX');
  private scanBtn: HTMLButtonElement;
  private bandBtns: Record<'FM' | 'AM', HTMLButtonElement>;
  private sweepVal = h('span', null, '');
  private statusBand = h('span.on', null, 'FM');
  private statusSweep = h('span', null, '');
  private unit = h('span.unit', null, 'MHz');
  private tagScan = h('span.off', null, 'SCAN');
  private tagVox = h('span.off', null, 'RX');
  private micState = h('div.state');
  private interim = h('p.interim', { 'aria-live': 'polite' });
  private scaleNums = h('div.nums');
  private askForm: HTMLFormElement;
  private raf = 0;
  private visible = false;
  private colors = lut();
  private freqBuf?: Uint8Array<ArrayBuffer>;
  private timeBuf?: Float32Array<ArrayBuffer>;
  private voxBuf = new Float32Array(512);
  private interimTimer = 0;
  private fragmentUntil = 0;
  micStatus: MicState = 'idle';

  constructor(
    private readonly engine: AudioEngine,
    private readonly box: SpiritBox,
    private readonly listener: Listener,
    private readonly config: ConfigStore,
  ) {
    for (let i = 0; i < 5; i++) this.sigBars.push(h('i'));
    for (let i = 0; i < 18; i++) this.micBars.push(h('i'));

    this.scanBtn = h('button.btn.scan', { type: 'button', 'aria-pressed': 'false', onclick: () => this.box.setScanning(!this.box.scanning) }, h('span.pip'), 'Scan');
    const band = (b: 'FM' | 'AM') =>
      h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => this.config.update((c) => (c.spiritBox.sweep.band = b)) }, b);
    this.bandBtns = { FM: band('FM'), AM: band('AM') };

    const step = (d: number) => () =>
      this.config.update((c) => (c.spiritBox.sweep.stepMs = clamp(c.spiritBox.sweep.stepMs + d, 50, 350)));
    const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.01, 'aria-label': 'Output volume' }) as HTMLInputElement;
    vol.value = String(this.config.value.spiritBox.audio.masterVolume);
    vol.addEventListener('input', () => {
      const v = Number(vol.value);
      this.engine.setVolume(v);
      this.config.update((c) => (c.spiritBox.audio.masterVolume = v));
    });

    const input = h('input', { type: 'text', placeholder: 'Type a question', 'aria-label': 'Type a question', autocomplete: 'off', enterkeyhint: 'send' }) as HTMLInputElement;
    this.askForm = h('form.ask.hidden', {
      onsubmit: (e: Event) => {
        e.preventDefault();
        const q = input.value.trim();
        if (!q) return;
        this.box.ask(q);
        input.value = '';
      },
    }, input, h('button.btn', { type: 'submit' }, 'Ask'));
    const askToggle = h('button.ask-toggle', {
      type: 'button',
      onclick: () => {
        this.askForm.classList.toggle('hidden');
        askToggle.classList.add('hidden');
        input.focus();
      },
    }, 'Type a question instead');

    this.el = h('div.panel.sb', { 'data-active': 'true', role: 'tabpanel', 'aria-label': 'Spirit box' },
      h('div.sb-status.mono', null, h('span', null, 'RX·1'), this.statusBand, this.statusSweep, h('span.grow'), h('span', null, 'SIG'), h('span.sig', { 'aria-hidden': 'true' }, ...this.sigBars)),
      h('div.lcd', null,
        h('div.lcd-tags', null, h('span', null, this.tagScan, ' ', this.tagVox), h('span', null, 'STEP 0.2')),
        h('div.lcd-freq', null, this.seg.el, this.unit),
        h('div.scale', { 'aria-hidden': 'true' }, h('div.ticks'), this.needle, this.scaleNums),
        this.scope,
      ),
      h('div.out', null,
        h('div.out-head', null, h('span.label', null, 'Output'), h('span.mono.dim', { style: 'font-size:10px' }, '0–4 kHz'), h('span.grow'), this.vox),
        this.waterfall,
        h('div.out-foot', null, h('span', null, '−6 s'), h('span', null, '−3 s'), h('span', null, 'now')),
      ),
      h('div.mic', null, h('span.label', null, 'Mic'), h('div.meter', { 'aria-hidden': 'true' }, ...this.micBars), this.micState, this.interim),
      h('div.controls', null,
        this.scanBtn,
        h('div.stepper', { role: 'group', 'aria-label': 'Sweep rate' }, h('button', { type: 'button', 'aria-label': 'Faster sweep', onclick: step(-10) }, '−'), this.sweepVal, h('button', { type: 'button', 'aria-label': 'Slower sweep', onclick: step(10) }, '+')),
        h('div.seg', { role: 'group', 'aria-label': 'Band' }, this.bandBtns.FM, this.bandBtns.AM),
        h('label.vol', null, h('span.label', null, 'Vol'), vol),
      ),
      askToggle,
      this.askForm,
    );

    this.box.on('scanning', () => this.syncControls());
    this.box.on('fragment', ({ start, duration }) => (this.fragmentUntil = start + duration));
    this.config.subscribe(() => this.syncControls());
    this.listener.on('status', () => this.syncMic());
    this.listener.on('interim', ({ text }) => {
      this.interim.textContent = `“${text}”`;
      this.interim.classList.add('show');
      window.clearTimeout(this.interimTimer);
      this.interimTimer = window.setTimeout(() => this.interim.classList.remove('show'), 2600);
    });
    this.listener.on('utterance', ({ text }) => {
      if (!text) return;
      this.interim.textContent = `“${text}”`;
      this.interim.classList.add('show');
      window.clearTimeout(this.interimTimer);
      this.interimTimer = window.setTimeout(() => this.interim.classList.remove('show'), 2200);
    });
    this.syncControls();
    this.syncMic();
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.dataset.active = String(v);
    cancelAnimationFrame(this.raf);
    if (v) this.raf = requestAnimationFrame(this.draw);
  }

  setMicStatus(s: MicState): void {
    this.micStatus = s;
    this.syncMic();
  }

  private syncControls(): void {
    const cfg = this.config.value.spiritBox;
    const on = this.box.scanning;
    this.scanBtn.setAttribute('aria-pressed', String(on));
    this.tagScan.className = on ? '' : 'off';
    this.bandBtns.FM.setAttribute('aria-pressed', String(cfg.sweep.band === 'FM'));
    this.bandBtns.AM.setAttribute('aria-pressed', String(cfg.sweep.band === 'AM'));
    this.sweepVal.textContent = `${cfg.sweep.stepMs} ms`;
    this.statusBand.textContent = cfg.sweep.band;
    this.statusSweep.textContent = `SWEEP ${cfg.sweep.stepMs} ms ${cfg.sweep.direction === 'up' ? '▲' : '▼'}`;
    this.unit.textContent = cfg.sweep.band === 'FM' ? 'MHz' : 'kHz';
    const nums = cfg.sweep.band === 'FM' ? ['88', '92', '96', '100', '104', '108'] : ['530', '800', '1000', '1200', '1400', '1700'];
    this.scaleNums.replaceChildren(...nums.map((n) => h('span', null, n)));
    if (!on) this.seg.set(cfg.sweep.band === 'FM' ? '---.-' : '----');
  }

  private syncMic(): void {
    const parts: [string, string][] = [];
    if (this.micStatus === 'granted') parts.push(['Listening', 'ok']);
    else if (this.micStatus === 'requesting') parts.push(['Waiting for microphone permission', '']);
    else if (this.micStatus === 'denied') parts.push(['Microphone blocked — allow it in site settings to ask questions aloud', 'warn']);
    else if (this.micStatus === 'unavailable') parts.push(['No microphone available', 'warn']);
    else parts.push(['Microphone off', '']);
    if (this.micStatus === 'granted') {
      const [text, cls] = TRANSCRIPTION_TEXT[this.listener.status];
      parts.push([text, cls]);
    }
    this.micState.replaceChildren(...parts.map(([t, c]) => h('span', { class: c || undefined }, t)));
  }

  private draw = (): void => {
    if (!this.visible) return;
    this.raf = requestAnimationFrame(this.draw);
    const now = this.engine.now;
    const step = this.box.scanning ? this.box.sweep.current() : undefined;

    if (step) {
      const band = this.box.sweep.band;
      this.seg.set(this.box.sweep.formatFreq(step.freq));
      const f = clamp((step.freq - band.min) / (band.max - band.min), 0, 1);
      this.needle.style.transform = `translateX(${(f * (this.needle.parentElement?.clientWidth ?? 0)).toFixed(1)}px)`;
    }

    // signal strength
    let sig = step ? step.level : 0;
    if (now < this.fragmentUntil) sig = Math.max(sig, 0.75);
    const lit = Math.round(sig * 5);
    this.sigBars.forEach((b, i) => b.classList.toggle('lit', i < lit));

    // vocal-band activity (fragments and broadcast bleed alike)
    const vox = this.engine.voxLevel(this.voxBuf);
    const voxOn = vox > 0.018;
    this.vox.classList.toggle('on', voxOn);
    this.tagVox.className = voxOn ? '' : 'off';

    // mic meter
    const db = this.listener.level;
    const thr = this.listener.thresholdDb;
    const n = Math.round(clamp((db + 72) / 62, 0, 1) * this.micBars.length);
    const thrIdx = Math.round(clamp((thr + 72) / 62, 0, 1) * this.micBars.length);
    this.micBars.forEach((b, i) => {
      b.classList.toggle('lit', i < n && this.micStatus === 'granted');
      b.classList.toggle('hot', i >= thrIdx);
    });

    this.drawScope();
    this.drawWaterfall();
  };

  private fit(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr);
    const hh = Math.round(c.clientHeight * dpr);
    if (!w || !hh) return null;
    if (c.width !== w || c.height !== hh) {
      c.width = w;
      c.height = hh;
    }
    return c.getContext('2d');
  }

  private drawScope(): void {
    const ctx = this.fit(this.scope);
    if (!ctx) return;
    const a = this.engine.outputAnalyser;
    if (!this.timeBuf || this.timeBuf.length !== a.fftSize) this.timeBuf = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(this.timeBuf);
    const { width: w, height: hh } = ctx.canvas;
    ctx.clearRect(0, 0, w, hh);
    ctx.strokeStyle = 'rgba(212,156,85,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, hh / 2);
    ctx.lineTo(w, hh / 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(212,156,85,0.78)';
    ctx.lineWidth = Math.max(1, w / 600);
    ctx.beginPath();
    const buf = this.timeBuf;
    const len = Math.min(buf.length, 1024);
    for (let i = 0; i < len; i++) {
      const x = (i / (len - 1)) * w;
      const y = hh / 2 - buf[i] * hh * 0.42;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  private drawWaterfall(): void {
    const ctx = this.fit(this.waterfall);
    if (!ctx) return;
    const a = this.engine.outputAnalyser;
    a.minDecibels = -96;
    a.maxDecibels = -22;
    if (!this.freqBuf || this.freqBuf.length !== a.frequencyBinCount) this.freqBuf = new Uint8Array(a.frequencyBinCount);
    a.getByteFrequencyData(this.freqBuf);
    const { width: w, height: hh } = ctx.canvas;
    const col = Math.max(1, Math.round(w / 360));
    ctx.drawImage(ctx.canvas, -col, 0);
    const maxHz = 4000;
    const binHz = this.engine.ctx.sampleRate / 2 / a.frequencyBinCount;
    const img = ctx.createImageData(col, hh);
    for (let y = 0; y < hh; y++) {
      const hz = ((hh - 1 - y) / (hh - 1)) * maxHz;
      const bin = Math.min(this.freqBuf.length - 1, Math.round(hz / binHz));
      const v = this.freqBuf[bin];
      for (let x = 0; x < col; x++) {
        const o = (y * col + x) * 4;
        img.data[o] = this.colors[v * 3];
        img.data[o + 1] = this.colors[v * 3 + 1];
        img.data[o + 2] = this.colors[v * 3 + 2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, w - col, 0);
  }
}
