/** Application shell: screens, session lifecycle, permissions, recording. */
import { AudioEngine } from './audio/engine';
import { type VoiceBank, loadVoiceBank } from './audio/voicebank';
import { CameraController } from './camera/controller';
import { ConfigStore } from './config';
import { ClipRecorder, recordingSupported } from './session/recorder';
import { Session } from './session/session';
import { Store } from './session/store';
import type { Mode, SessionRecord } from './session/types';
import { SpiritBox } from './spiritbox/controller';
import { Listener } from './spiritbox/listener';
import { CalibrationView } from './ui/calibration-view';
import { CameraView } from './ui/camera-view';
import { h, icon, installGrain, toast } from './ui/dom';
import { LogView } from './ui/log-view';
import { ReviewView } from './ui/review-view';
import { SevenSeg } from './ui/sevenseg';
import { SpiritBoxView } from './ui/spiritbox-view';
import { clockTime, elapsed, longDate } from './util/time';

interface WakeLockLike {
  release(): Promise<void>;
}

export class App {
  readonly config = new ConfigStore();
  readonly store = new Store();
  readonly camera: CameraController;
  readonly listener: Listener;
  readonly recorder = new ClipRecorder();
  readonly calibration: CalibrationView;
  readonly review: ReviewView;
  engine?: AudioEngine;
  bank?: VoiceBank;
  spiritBox?: SpiritBox;
  session?: Session;
  mode: Mode = 'spiritbox';
  private micStream?: MediaStream;
  private root: HTMLElement;
  private intro?: HTMLElement;
  private screen?: HTMLElement;
  private sbView?: SpiritBoxView;
  private camView?: CameraView;
  private logView?: LogView;
  private timer = 0;
  private wake?: WakeLockLike;
  private recBtn?: HTMLButtonElement;
  private recording = false;
  private pendingVideoRec = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.camera = new CameraController(this.config, this.store);
    this.listener = new Listener(() => this.config.value, () => this.session?.clock() ?? 0);
    this.calibration = new CalibrationView(this.config);
    this.review = new ReviewView(this.store, this.config);
    this.review.onClose = () => {
      if (!this.session) void this.showIntro();
    };
    document.body.append(this.calibration.el, this.review.el);
    this.camera.on('state', ({ state }) => {
      if (state === 'live' && this.pendingVideoRec) void this.startClip();
    });
    this.config.subscribe((c) => {
      this.listener.setTranscription(c.spiritBox.listener.transcription && !!this.micStream);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !this.session) return;
      void this.requestWakeLock();
      // phones suspend audio when the screen locks
      void this.engine?.resume().catch(() => undefined);
    });
    // ...and some only allow resuming from a gesture
    document.addEventListener('pointerdown', () => {
      if (this.session && this.engine && this.engine.ctx.state !== 'running') void this.engine.resume().catch(() => undefined);
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.recording) e.preventDefault();
    });
  }

  async boot(): Promise<void> {
    installGrain();
    await this.store.open();
    await this.showIntro();
    if (new URLSearchParams(location.search).has('debug')) (window as unknown as { residual: App }).residual = this;
  }

  // --- intro -----------------------------------------------------------------------------

  async showIntro(): Promise<void> {
    this.screen?.remove();
    this.screen = undefined;
    const sessions = (await this.store.all('sessions')).sort((a, b) => b.startedAt - a.startedAt).slice(0, 8);
    const input = h('input', { type: 'text', id: 'loc', placeholder: 'e.g. Basement, east wing', autocomplete: 'off', maxlength: 80, enterkeyhint: 'go' }) as HTMLInputElement;
    const go = h('button.btn.btn-primary', { type: 'submit' }, 'Begin session');
    const lcd = new SevenSeg(4);
    lcd.set('---.-');
    const form = h('form.begin', {
      onsubmit: (e: Event) => {
        e.preventDefault();
        go.disabled = true;
        void this.begin(input.value).finally(() => (go.disabled = false));
      },
    }, h('label.label', { for: 'loc' }, 'Location'), input, go);

    const list = h('ul');
    for (const s of sessions) list.append(this.recentItem(s));

    this.intro?.remove();
    this.intro = h('section.screen.intro', null,
      h('div.intro-inner', null,
        h('div.brand', null, h('span.wordmark', null, 'RESIDUAL'), h('span.ver', null, 'FIELD KIT 1.0')),
        h('div.intro-hero', null,
          h('div.lcd', { style: 'padding:22px 16px 16px' }, h('div.lcd-tags', null, h('span', null, 'STANDBY'), h('span.off', null, 'SCAN')), h('div.lcd-freq', null, lcd.el, h('span.unit', null, 'MHz'))),
          h('p.lede', null, 'Spirit box and visual anomaly scanner for field investigations.'),
        ),
        form,
        h('ul.facts', null,
          h('li', null, h('b', null, 'MIC'), h('span', null, 'Hears your questions. Speak normally, then wait.')),
          h('li', null, h('b', null, 'CAM'), h('span', null, 'Used only in Visual mode. Hold the device still near doorways and dark corners.')),
          h('li', null, h('b', null, 'LOCAL'), h('span', null, 'Logs, footage and audio stay on this device.')),
        ),
        sessions.length ? h('section.recent', null, h('h2.label', null, 'Previous sessions'), list) : null,
        h('footer.intro-foot', null,
          h('p', null, 'An investigation experience. Residual synthesizes what it plays and shows; nothing it produces is evidence.'),
          h('button.btn.btn-quiet', { type: 'button', onclick: () => this.calibration.open() }, 'Calibration'),
        ),
      ),
    );
    this.root.replaceChildren(this.intro);
  }

  private recentItem(s: SessionRecord): HTMLLIElement {
    const dur = s.endedAt ? elapsed((s.endedAt - s.startedAt) / 1000) : '—';
    return h('li', null, h('button', { type: 'button', onclick: () => void this.review.open(s.id) },
      h('span.r-name', null, s.name),
      h('span.r-when', null, `${longDate(s.startedAt)} · ${clockTime(s.startedAt)} · ${dur}`),
      h('span.r-counts', null, `${s.counts.fragments} audio`, h('br'), `${s.counts.visual} visual`),
    ));
  }

  // --- session ---------------------------------------------------------------------------

  async begin(name: string): Promise<void> {
    // Audio must be created and resumed inside the user gesture (iOS).
    if (!this.engine) this.engine = new AudioEngine();
    const engine = this.engine;
    const resumed = engine.resume();
    engine.setVolume(0);
    await resumed;

    if (!this.bank) {
      try {
        this.bank = await loadVoiceBank(engine.ctx);
      } catch (err) {
        console.error(err);
        toast('Voice bank failed to load; the spirit box will play static only');
      }
    }
    if (!this.spiritBox) {
      this.spiritBox = new SpiritBox(engine, this.config, this.listener);
      if (this.bank) this.spiritBox.setBank(this.bank);
    }

    this.session = await Session.begin(this.store, name);
    this.spiritBox.attach(this.session);
    this.camera.attach(this.session);
    this.buildSessionScreen();
    this.setMode('spiritbox');

    // Fade the receiver in rather than blasting static.
    this.spiritBox.setScanning(true);
    engine.master.gain.cancelScheduledValues(engine.now);
    engine.master.gain.setValueAtTime(0, engine.now);
    engine.master.gain.linearRampToValueAtTime(this.config.value.spiritBox.audio.masterVolume, engine.now + 2.2);

    void this.requestMic();
    void this.requestWakeLock();
    this.timer = window.setInterval(() => this.tickHeader(), 500);
  }

  private async requestMic(): Promise<void> {
    const engine = this.engine!;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.sbView?.setMicStatus('unavailable');
      this.session?.log({ type: 'system', title: 'Microphone unavailable', detail: 'This page needs to be served over https to use the microphone.' });
      return;
    }
    this.sbView?.setMicStatus('requesting');
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
        video: false,
      });
    } catch (err) {
      const denied = (err as DOMException).name === 'NotAllowedError';
      this.sbView?.setMicStatus(denied ? 'denied' : 'unavailable');
      this.session?.log({ type: 'system', title: denied ? 'Microphone blocked' : 'Microphone unavailable', detail: 'Questions can still be typed.' });
      return;
    }
    if (!this.session) {
      this.micStream.getTracks().forEach((t) => t.stop());
      return;
    }
    const analyser = engine.attachMic(this.micStream);
    this.listener.start(analyser);
    this.sbView?.setMicStatus('granted');
  }

  private buildSessionScreen(): void {
    const session = this.session!;
    const engine = this.engine!;
    this.sbView = new SpiritBoxView(engine, this.spiritBox!, this.listener, this.config);
    this.camView = new CameraView(this.camera, this.config, this.store);
    this.logView = new LogView(this.store, this.config);
    this.camView.attach(session);
    this.logView.attach(session);

    this.recBtn = h('button.rec', { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Record', onclick: () => void this.toggleRecording() }, h('span.dot'), 'REC');
    if (!recordingSupported()) this.recBtn.disabled = true;
    const modes = h('nav.modes', { role: 'tablist', 'data-mode': 'spiritbox' },
      h('button', { type: 'button', role: 'tab', 'aria-selected': 'true', 'data-mode': 'spiritbox', onclick: () => this.setMode('spiritbox') }, 'Spirit box'),
      h('button', { type: 'button', role: 'tab', 'aria-selected': 'false', 'data-mode': 'camera', onclick: () => this.setMode('camera') }, 'Visual'),
      h('span.ind'),
    );
    this.screen = h('section.screen.session', null,
      h('header.bar', null,
        h('button.icon-btn', { type: 'button', 'aria-label': 'End session', onclick: () => void this.end() }, icon('back')),
        h('div.bar-title', null, h('span.name', null, session.record.name), h('span.meta', null, `Started ${clockTime(session.record.startedAt)}`)),
        h('div.bar-right', null,
          h('span.timer.mono', { 'data-timer': '' }, '00:00'),
          this.recBtn,
          h('button.icon-btn', { type: 'button', 'aria-label': 'Calibration', onclick: () => this.calibration.open() }, icon('dial')),
        ),
      ),
      modes,
      h('div.workspace', null, h('main.instrument', null, this.sbView.el, this.camView.el), this.logView.el),
    );
    this.intro?.remove();
    this.root.replaceChildren(this.screen);
  }

  setMode(mode: Mode): void {
    if (!this.screen) return;
    const changed = mode !== this.mode;
    this.mode = mode;
    const nav = this.screen.querySelector<HTMLElement>('.modes')!;
    nav.dataset.mode = mode;
    nav.querySelectorAll<HTMLButtonElement>('button[role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
    this.sbView?.setVisible(mode === 'spiritbox');
    this.camView?.setVisible(mode === 'camera');
    if (changed && this.recording) void this.restartClip();
  }

  private tickHeader(): void {
    if (!this.session || !this.screen) return;
    const t = this.screen.querySelector('[data-timer]');
    if (t) t.textContent = elapsed(this.session.clock());
  }

  // --- recording -------------------------------------------------------------------------

  async toggleRecording(): Promise<void> {
    if (this.recording) await this.stopClip(false);
    else {
      this.recording = true;
      await this.startClip();
    }
    this.syncRec();
  }

  private syncRec(): void {
    this.recBtn?.setAttribute('aria-pressed', String(this.recording));
    this.camView?.setRecording(this.recording);
  }

  private async startClip(): Promise<void> {
    const engine = this.engine;
    if (!engine || !this.session || !this.recording) return;
    try {
      if (this.mode === 'camera') {
        const video = this.camera.state === 'live' ? this.camera.canvasStream : undefined;
        if (!video) {
          this.pendingVideoRec = true;
          return;
        }
        this.pendingVideoRec = false;
        const stream = new MediaStream([...video.getVideoTracks(), ...engine.recordDest.stream.getAudioTracks()]);
        this.recorder.start(stream, 'video', 'camera');
      } else {
        this.recorder.start(engine.recordDest.stream, 'audio', 'spiritbox');
      }
    } catch (err) {
      console.error(err);
      this.recording = false;
      this.syncRec();
      toast('Recording is not supported in this browser');
    }
  }

  private async stopClip(keepGoing: boolean): Promise<void> {
    if (!keepGoing) this.recording = false;
    this.pendingVideoRec = false;
    const session = this.session;
    if (!session) return;
    const clip = await this.recorder.stop(session.id);
    if (!clip) return;
    await this.store.put('clips', clip);
    session.log({
      t: clip.startedAt,
      type: 'clip',
      mode: clip.mode,
      title: clip.kind === 'video' ? 'Footage recorded' : 'Audio recorded',
      detail: `${elapsed((clip.endedAt - clip.startedAt) / 1000)} · ${(clip.size / 1e6).toFixed(1)} MB`,
      clipId: clip.id,
    });
  }

  private async restartClip(): Promise<void> {
    await this.stopClip(true);
    await this.startClip();
  }

  // --- teardown --------------------------------------------------------------------------

  async end(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (!confirm('End this session? The log and any recordings are saved on this device.')) return;
    if (this.recording) await this.stopClip(false);
    this.syncRec();
    window.clearInterval(this.timer);
    this.camView?.setVisible(false);
    this.sbView?.setVisible(false);
    this.listener.stop();
    this.spiritBox?.detach();
    this.engine?.detachMic();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = undefined;
    await session.end();
    this.session = undefined;
    void this.wake?.release().catch(() => undefined);
    this.wake = undefined;
    await this.showIntro();
    await this.review.open(session.id);
  }

  private async requestWakeLock(): Promise<void> {
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockLike> } };
    try {
      this.wake = await nav.wakeLock?.request('screen');
    } catch {
      /* not allowed (battery saver, unsupported) */
    }
  }
}
