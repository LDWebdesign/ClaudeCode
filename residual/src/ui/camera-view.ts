/** Visual anomaly scanner panel. */
import { type AnomalyType, SITE_LABEL } from '../camera/anomalies';
import type { CameraController, CameraState } from '../camera/controller';
import type { ConfigStore } from '../config';
import type { Session } from '../session/session';
import type { Store } from '../session/store';
import type { LogEvent } from '../session/types';
import { clamp } from '../util/rng';
import { clockTime, timecode, uid } from '../util/time';
import { h, toast } from './dom';

/** What the Test menu can force, and what each needs in view. */
const TESTS: { label: string; types?: AnomalyType[]; needs: string }[] = [
  { label: 'Figure', types: ['partial-figure', 'lean', 'hall-figure', 'stair-figure', 'window-shape'], needs: 'a doorway, a door edge, a hallway, stairs or a window' },
  { label: 'Head', types: ['crown', 'rise'], needs: 'a doorway, a door edge or the top of a chair or sofa' },
  { label: 'Shoulder', types: ['shoulder'], needs: 'a doorway or a door edge' },
  { label: 'Hat', types: ['brim'], needs: 'a doorway or a door edge' },
  { label: 'Shadow', types: ['densify', 'edge-creep', 'pool'], needs: 'a dim corner or shadow (not pitch black)' },
  { label: 'Any', needs: 'a doorway, a door edge, furniture or a dim corner' },
];
const TEST_HOLD_SEC = 4;

const SITE_COLORS: Record<string, string> = {
  doorway: '#c99047', 'door-edge': '#d6b37a', hallway: '#8fb5a0', 'dark-corner': '#7f8fb0', shadow: '#6d7690', furniture: '#b08f7f', window: '#cfd6dd', stairs: '#a0a68a',
};

export class CameraView {
  readonly el: HTMLElement;
  readonly feed = h('canvas.feed');
  private diag = h('canvas.diag');
  private tl = h('div.tl');
  private tc = h('span');
  private recMark = h('span.recmark', null, '● REC');
  private scanFill = h('i');
  private scanText = h('span');
  private confBars: HTMLElement[] = [];
  private confText = h('span');
  private msg = h('div.cam-msg');
  private flash = h('div.flash');
  private history = h('div.history');
  private expVal = h('span.val');
  private nvBtn: HTMLButtonElement;
  private lampBtn: HTMLButtonElement;
  private exp: HTMLInputElement;
  private testBtn: HTMLButtonElement;
  private testMenu = h('div.test-menu.hidden', { role: 'menu', 'aria-label': 'Force a test anomaly' });
  private session?: Session;
  private lastScan = 0;
  private visible = false;
  private recording = false;

  constructor(
    private readonly camera: CameraController,
    private readonly config: ConfigStore,
    private readonly store: Store,
  ) {
    for (let i = 0; i < 10; i++) this.confBars.push(h('i'));
    this.exp = h('input', { type: 'range', min: -1.5, max: 3, step: 0.1, 'aria-label': 'Exposure' }) as HTMLInputElement;
    this.exp.addEventListener('input', () => {
      this.config.update((c) => (c.camera.image.exposureEv = Number(this.exp.value)));
      void this.camera.applyExposure();
    });
    this.nvBtn = h('button.btn', { type: 'button', 'aria-pressed': 'false', onclick: () => this.config.update((c) => (c.camera.image.nightVision = !c.camera.image.nightVision)) }, 'NV');
    this.lampBtn = h('button.btn.hidden', { type: 'button', 'aria-pressed': 'false', onclick: async () => {
      await this.camera.setTorch(!this.camera.torchOn);
      this.lampBtn.setAttribute('aria-pressed', String(this.camera.torchOn));
    } }, 'Lamp');
    const flip = h('button.btn', { type: 'button', onclick: () => void this.camera.flip(this.feed) }, 'Flip');
    const shutter = h('button.shutter', { type: 'button', 'aria-label': 'Capture frame', onclick: () => void this.captureStill() });

    this.testBtn = h('button.btn', { type: 'button', 'aria-expanded': 'false', 'aria-haspopup': 'menu', onclick: () => this.toggleTestMenu() }, 'Test');
    this.testMenu.append(
      h('span.label', null, 'Force a test anomaly'),
      ...TESTS.map((t) => h('button.btn', { type: 'button', role: 'menuitem', onclick: () => this.runTest(t) }, t.label)),
    );

    this.el = h('div.panel.cam', { 'data-active': 'false', role: 'tabpanel', 'aria-label': 'Visual scanner' },
      h('div.viewport', null,
        this.feed,
        this.diag,
        this.flash,
        h('div.hud', { 'aria-hidden': 'true' },
          this.tl,
          h('div.tr', null, this.tc, h('br'), this.recMark),
          h('div.bl', null, h('div.scanbar', null, this.scanFill), this.scanText),
          h('div.br', null, h('div.conf', null, ...this.confBars), this.confText),
        ),
        this.testMenu,
        this.msg,
      ),
      h('label.exp', null, h('span.label', null, 'EV'), this.exp, this.expVal),
      h('div.cam-controls', null,
        h('div.left', null, this.nvBtn, this.lampBtn),
        shutter,
        h('div.right', null, this.testBtn, flip),
      ),
      this.history,
    );

    this.camera.on('state', ({ state, message }) => this.showState(state, message));
    this.camera.on('frame', ({ t }) => this.hud(t));
    this.camera.on('scan', ({ count }) => (this.lastScan = count));
    this.config.subscribe(() => this.sync());
    this.sync();
    this.showState('off');
  }

  attach(session: Session): void {
    this.session = session;
    this.history.replaceChildren();
    session.on('event', (ev) => this.onEvent(ev));
    session.on('changed', (ev) => this.onEvent(ev));
  }

  setRecording(on: boolean): void {
    this.recording = on;
    this.recMark.classList.toggle('on', on);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.el.dataset.active = String(v);
    if (v) {
      this.el.classList.remove('acquire');
      void this.el.offsetWidth;
      this.el.classList.add('acquire');
      void this.camera.start(this.feed);
    } else {
      this.toggleTestMenu(false);
      this.camera.stop();
    }
  }

  private toggleTestMenu(open = this.testMenu.classList.contains('hidden')): void {
    this.testMenu.classList.toggle('hidden', !open);
    this.testBtn.setAttribute('aria-expanded', String(open));
    this.testBtn.setAttribute('aria-pressed', String(open));
  }

  /** Forces an anomaly of the chosen kind and holds it long enough to look at. */
  private runTest(t: (typeof TESTS)[number]): void {
    this.toggleTestMenu(false);
    if (this.camera.state !== 'live') {
      toast('The camera isn’t running yet');
      return;
    }
    const a = this.camera.force(t.types, { hold: TEST_HOLD_SEC, test: true });
    if (!a) {
      toast(`Nowhere to place it yet. Point at ${t.needs}, and hold still for a second.`);
      return;
    }
    toast(`${t.label === 'Any' ? 'Anomaly' : t.label} placed ${SITE_LABEL[a.site.kind]} — it’s faint, hold still`);
  }

  private sync(): void {
    const img = this.config.value.camera.image;
    this.exp.value = String(img.exposureEv);
    this.expVal.textContent = `${img.exposureEv >= 0 ? '+' : ''}${img.exposureEv.toFixed(1)}`;
    this.nvBtn.setAttribute('aria-pressed', String(img.nightVision));
    this.testBtn.classList.toggle('hidden', !this.config.value.camera.testControls);
    if (!this.config.value.camera.testControls) this.toggleTestMenu(false);
    if (!this.config.value.diagnostics) {
      const ctx = this.diag.getContext('2d');
      ctx?.clearRect(0, 0, this.diag.width, this.diag.height);
    }
  }

  private showState(state: CameraState, message?: string): void {
    this.lampBtn.classList.toggle('hidden', !(state === 'live' && this.camera.caps.torch));
    if (state === 'live') {
      this.msg.classList.add('hidden');
      return;
    }
    this.msg.classList.remove('hidden');
    const retry = h('button.btn', { type: 'button', onclick: () => void this.camera.start(this.feed) }, 'Try again');
    const text: Record<CameraState, string> = {
      off: 'Camera idle.',
      starting: 'Requesting camera…',
      live: '',
      denied: message ?? 'Camera permission was refused.',
      unavailable: message ?? 'No camera available.',
      error: message ?? 'The camera could not start.',
    };
    const canRetry = state === 'denied' || state === 'error' || state === 'unavailable';
    this.msg.replaceChildren(h('span.label', null, state === 'starting' ? 'Camera' : state === 'off' ? 'Standby' : 'Camera unavailable'), h('p', null, text[state]), ...(canRetry ? [retry] : []));
  }

  private hud(t: number): void {
    if (!this.visible) return;
    const img = this.config.value.camera.image;
    const ev = img.exposureEv;
    this.tl.textContent = '';
    this.tl.append(`CH1 · ${img.nightVision ? 'NV' : 'LL'}${this.camera.facing === 'user' ? ' · FRONT' : ''}`, h('br'), `EV ${ev >= 0 ? '+' : ''}${ev.toFixed(1)}${this.camera.hardwareExposure ? '' : ' (digital)'}`);
    this.tc.textContent = timecode(t);
    this.scanFill.style.transform = `scaleX(${this.camera.anomalies.scanProgress(t).toFixed(3)})`;
    this.scanText.textContent = `SCAN ${String(this.lastScan + 1).padStart(3, '0')} · ${this.camera.stillness > 0.6 ? 'STABLE' : 'MOTION'}`;
    const c = clamp(this.camera.confidence, 0, 1);
    const lit = Math.round(c * 10);
    this.confBars.forEach((b, i) => {
      b.classList.toggle('lit', i < Math.max(1, lit));
      b.classList.toggle('warm', i >= 6 && i < lit);
    });
    this.confText.textContent = `IRREG ${c < 0.32 ? 'LOW' : c < 0.55 ? 'MOD' : 'ELEV'}`;
    if (this.config.value.diagnostics) this.drawDiagnostics();
  }

  private drawDiagnostics(): void {
    const r = this.camera.renderer;
    if (!r) return;
    const c = this.diag;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr);
    const hh = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== hh) {
      c.width = w;
      c.height = hh;
    }
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, hh);
    const mirror = this.camera.facing === 'user';
    const map = (x: number, y: number): [number, number] => {
      const [vx, vy] = r.frameToView(x, y, mirror);
      return [vx * w, vy * hh];
    };
    ctx.lineWidth = dpr;
    ctx.font = `${10 * dpr}px ui-monospace, monospace`;
    for (const s of this.camera.sites) {
      const color = SITE_COLORS[s.kind] ?? '#fff';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = s.persistence >= this.config.value.camera.detection.minPersistence ? 0.9 : 0.35;
      const [x0, y0] = map(s.box.x, s.box.y);
      const [x1, y1] = map(s.box.x + s.box.w, s.box.y + s.box.h);
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeRect(Math.min(x0, x1), y0, Math.abs(x1 - x0), y1 - y0);
      ctx.setLineDash([]);
      if (s.occluder) {
        const [a, b] = map(s.occluder.x0, s.occluder.y0);
        const [cc, d] = map(s.occluder.x1, s.occluder.y1);
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        ctx.moveTo(a, b);
        ctx.lineTo(cc, d);
        ctx.stroke();
        ctx.lineWidth = dpr;
      }
      ctx.fillText(`${s.kind} ${s.score.toFixed(2)} ×${s.persistence}`, Math.min(x0, x1) + 3 * dpr, y0 + 12 * dpr);
    }
    ctx.globalAlpha = 1;
    const a = this.camera.anomalies.active;
    ctx.fillStyle = '#e8e2d4';
    ctx.fillText(
      `still ${this.camera.stillness.toFixed(2)} · irreg ${(this.camera.lastAnalysis?.irregularity ?? 0).toFixed(2)}${a ? ` · ACTIVE ${a.def.type}${a.footageOnly ? ' (3f)' : ''}` : ''}`,
      12 * dpr,
      hh - 70 * dpr,
    );
  }

  private async captureStill(): Promise<void> {
    const session = this.session;
    if (!session || this.camera.state !== 'live') return;
    this.flash.classList.remove('go');
    void this.flash.offsetWidth;
    this.flash.classList.add('go');
    const blob = await this.camera.capture();
    if (!blob) return;
    const id = uid('m');
    await this.store.put('media', { id, sessionId: session.id, t: Date.now(), kind: 'still', blob });
    session.log({ type: 'capture', mode: 'camera', title: 'Frame captured', detail: this.recording ? 'During recording' : undefined, mediaId: id });
  }

  private async onEvent(ev: LogEvent): Promise<void> {
    if (!ev.mediaId || (ev.type !== 'visual' && ev.type !== 'capture')) return;
    if (ev.hidden && !this.config.value.diagnostics) return;
    if (this.history.querySelector(`[data-id="${ev.id}"]`)) return;
    const rec = await this.store.get('media', ev.mediaId);
    if (!rec) return;
    const url = URL.createObjectURL(rec.blob);
    const label = ev.type === 'capture' ? 'Capture' : ev.title.replace(/^(Low-confidence visual anomaly|Visual irregularity|Possible movement|Unidentified shape)\s*/i, '');
    const item = h('button', { type: 'button', 'data-id': ev.id, onclick: () => openLightbox(url, `${clockTime(ev.t, true)} · ${ev.title}`) },
      h('img', { src: url, alt: ev.title }),
      h('span', null, `${clockTime(ev.t)} · ${label || 'Visual'}`),
    );
    this.history.prepend(item);
  }
}

export function openLightbox(url: string, caption: string): void {
  const close = () => box.remove();
  const box = h('div.sheet', { role: 'dialog', 'aria-label': caption, onclick: close, style: 'background:rgba(0,0,0,.94);justify-content:center;align-items:center;padding:16px;gap:10px' },
    h('img', { src: url, alt: caption, style: 'max-width:100%;max-height:82dvh;filter:brightness(1.25)' }),
    h('span.mono.dim', { style: 'font-size:11px' }, caption),
  );
  document.body.append(box);
}
