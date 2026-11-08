/** Session review: timeline, recorded clips with frame-accurate playback, exports. */
import type { ConfigStore } from '../config';
import type { Store } from '../session/store';
import type { ClipRecord, LogEvent, SessionRecord } from '../session/types';
import { clockTime, elapsed, longDate } from '../util/time';
import { h, icon, toast } from './dom';
import { renderEntry } from './log-view';

const FRAME = 1 / 30;

function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';

export function logAsText(record: SessionRecord, events: LogEvent[]): string {
  const end = record.endedAt ?? events[events.length - 1]?.t ?? record.startedAt;
  const lines = [
    'RESIDUAL — Investigation log',
    record.name,
    `${longDate(record.startedAt)} · ${clockTime(record.startedAt)} – ${clockTime(end)} (${elapsed((end - record.startedAt) / 1000)})`,
    '',
  ];
  for (const e of events.filter((x) => !x.hidden).sort((a, b) => a.t - b.t)) {
    const when = clockTime(e.t, true).padEnd(12);
    let body = '';
    if (e.type === 'question' || e.type === 'remark') body = `${e.type === 'question' ? 'Question' : 'Investigator'}: ${e.text ? `“${e.text}”` : '[untranscribed]'}`;
    else if (e.text) body = `${e.title}: “${e.text}”${e.alternates?.length ? ` (alt. ${e.alternates.join(', ')})` : ''}`;
    else body = e.title;
    if (e.detail) body += ` — ${e.detail}`;
    lines.push(`${when}${body}`);
  }
  lines.push('', 'Residual synthesizes its signal fragments and visual irregularities. Nothing in this log is evidence.');
  return lines.join('\n');
}

export class ReviewView {
  readonly el: HTMLElement;
  private body = h('div.sheet-inner');
  private urls: string[] = [];
  onClose?: () => void;

  constructor(
    private readonly store: Store,
    private readonly config: ConfigStore,
  ) {
    this.el = h('section.sheet', { hidden: true, role: 'dialog', 'aria-label': 'Session review' },
      h('header.sheet-head', null, h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: () => this.close() }, icon('back')), h('h2', null, 'Session review')),
      h('div.sheet-body', null, this.body),
    );
  }

  close(): void {
    this.el.hidden = true;
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    this.body.replaceChildren();
    this.onClose?.();
  }

  async open(sessionId: string): Promise<void> {
    const record = await this.store.get('sessions', sessionId);
    if (!record) return;
    const events = (await this.store.bySession('events', sessionId)).sort((a, b) => a.t - b.t);
    const clips = (await this.store.bySession('clips', sessionId)).sort((a, b) => a.startedAt - b.startedAt);
    const diagnostics = this.config.value.diagnostics;
    const end = record.endedAt ?? events[events.length - 1]?.t ?? record.startedAt;
    const visible = events.filter((e) => !e.hidden || diagnostics);

    const playerHost = h('div');
    let player: Player | undefined;
    const clipList = h('ul.clips');
    const pick = (clip: ClipRecord, at?: number) => {
      player?.destroy();
      const url = URL.createObjectURL(clip.blob);
      this.urls.push(url);
      player = new Player(clip, url, events.filter((e) => !e.hidden || diagnostics));
      playerHost.replaceChildren(player.el);
      clipList.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.id === clip.id)));
      if (at !== undefined) player.seekEpoch(at);
    };
    for (const c of clips) {
      clipList.append(h('li', null, h('button', { type: 'button', 'data-id': c.id, onclick: () => pick(c) },
        h('span', null, `${c.kind === 'video' ? 'Footage' : 'Audio'} · ${clockTime(c.startedAt)}`),
        h('span', null, `${elapsed((c.endedAt - c.startedAt) / 1000)} · ${(c.size / 1e6).toFixed(1)} MB`),
      )));
    }

    const jump = (ev: LogEvent) => {
      const clip = clips.find((c) => ev.t >= c.startedAt - 500 && ev.t <= c.endedAt);
      if (!clip) return toast('No recording covers this moment');
      pick(clip, ev.t - 1500);
      playerHost.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const timeline = h('ol.log-list', { style: 'padding:0;overflow:visible' }, ...visible.map((e) => renderEntry(e, this.store, diagnostics, clips.length ? jump : undefined)));
    const c = record.counts;
    this.body.replaceChildren(
      h('div.review-top', null,
        h('h3', null, record.name),
        h('span.sub', null, `${longDate(record.startedAt)} · ${clockTime(record.startedAt)} – ${clockTime(end)} · ${elapsed((end - record.startedAt) / 1000)}`),
        h('span.sub', null, `${c.questions} questions · ${c.fragments} audio events · ${c.visual} visual · ${c.clips} recordings`),
      ),
      h('div.review-actions', null,
        h('button.btn', { type: 'button', onclick: () => download(new Blob([logAsText(record, events)], { type: 'text/plain' }), `residual-${slug(record.name)}.txt`) }, 'Export log'),
        h('button.btn', { type: 'button', onclick: () => download(new Blob([JSON.stringify({ session: record, events }, null, 2)], { type: 'application/json' }), `residual-${slug(record.name)}.json`) }, 'Export data'),
        h('button.btn.btn-quiet', { type: 'button', onclick: async () => {
          if (!confirm(`Delete “${record.name}” and its recordings from this device?`)) return;
          await this.store.deleteSession(record.id);
          this.close();
        } }, 'Delete'),
      ),
      clips.length ? h('div', null, h('div.label.section-label', null, 'Recordings'), playerHost, clipList) : h('p.dim', { style: 'font-size:13px' }, 'No recordings in this session. Use REC during an investigation to keep footage and audio.'),
      h('div.label.section-label', null, 'Timeline'),
      timeline,
    );
    this.el.hidden = false;
    if (clips[0]) pick(clips[0]);
  }
}

class Player {
  readonly el: HTMLElement;
  private media: HTMLVideoElement | HTMLAudioElement;
  private range: HTMLInputElement;
  private time = h('span.t.mono');
  private playBtn: HTMLButtonElement;
  private raf = 0;

  constructor(private readonly clip: ClipRecord, url: string, events: LogEvent[]) {
    const isVideo = clip.kind === 'video';
    this.media = isVideo ? h('video', { src: url, playsinline: true, preload: 'auto' }) : h('audio', { src: url, preload: 'auto' });
    this.range = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: 0, 'aria-label': 'Position' }) as HTMLInputElement;
    this.range.addEventListener('input', () => {
      const d = this.duration;
      if (d) this.media.currentTime = (Number(this.range.value) / 1000) * d;
    });
    const span = (clip.endedAt - clip.startedAt) / 1000;
    const marks = h('div.marks', null,
      ...events
        .filter((e) => e.t >= clip.startedAt && e.t <= clip.endedAt && ['visual', 'fragment', 'audio-event', 'question', 'capture'].includes(e.type))
        .map((e) => h('i', { class: e.type === 'question' ? 'q' : undefined, style: `left:${(((e.t - clip.startedAt) / 1000 / span) * 100).toFixed(2)}%`, title: e.title })),
    );
    this.playBtn = h('button.icon-btn', { type: 'button', 'aria-label': 'Play', onclick: () => (this.media.paused ? void this.media.play() : this.media.pause()) }, icon('play'));
    this.media.addEventListener('play', () => this.playBtn.replaceChildren(icon('pause')));
    this.media.addEventListener('pause', () => this.playBtn.replaceChildren(icon('play')));
    const step = (d: number) => () => {
      this.media.pause();
      this.media.currentTime = Math.max(0, this.media.currentTime + d);
    };
    const speeds = h('div.seg', { role: 'group', 'aria-label': 'Speed' });
    for (const s of [1, 0.5, 0.25]) {
      speeds.append(h('button', { type: 'button', 'aria-pressed': String(s === 1), onclick: (e: Event) => {
        this.media.playbackRate = s;
        speeds.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
      } }, s === 1 ? '1×' : s === 0.5 ? '½×' : '¼×'));
    }
    const enhance = h('button.btn', { type: 'button', 'aria-pressed': 'false', onclick: () => {
      const on = !this.media.classList.contains('enhance');
      this.media.classList.toggle('enhance', on);
      enhance.setAttribute('aria-pressed', String(on));
    } }, 'Enhance');
    const dl = h('button.btn.btn-quiet', { type: 'button', onclick: () => download(clip.blob, `residual-${clip.kind}-${new Date(clip.startedAt).toISOString().replace(/[:.]/g, '-')}.${clip.mime.includes('mp4') ? 'mp4' : 'webm'}`) }, 'Download');

    this.el = h('div.player', null,
      this.media,
      h('div.player-bar', null,
        this.playBtn,
        isVideo ? h('button.icon-btn', { type: 'button', 'aria-label': 'Previous frame', onclick: step(-FRAME) }, icon('stepBack')) : null,
        isVideo ? h('button.icon-btn', { type: 'button', 'aria-label': 'Next frame', onclick: step(FRAME) }, icon('stepFwd')) : null,
        this.time,
        h('span.grow'),
        speeds,
        isVideo ? enhance : null,
        dl,
      ),
      h('div.scrub', null, this.range, marks),
    );
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      const d = this.duration;
      if (d) this.range.value = String(Math.round((this.media.currentTime / d) * 1000));
      const wall = clip.startedAt + this.media.currentTime * 1000;
      this.time.textContent = `${elapsed(this.media.currentTime)}.${String(Math.floor((this.media.currentTime % 1) * 30)).padStart(2, '0')} · ${clockTime(wall, true)}`;
    };
    tick();
  }

  /** MediaRecorder webm files often report Infinity until fully scanned; fall back to wall-clock span. */
  get duration(): number {
    const d = this.media.duration;
    return Number.isFinite(d) && d > 0 ? d : (this.clip.endedAt - this.clip.startedAt) / 1000;
  }

  seekEpoch(t: number): void {
    const go = () => (this.media.currentTime = Math.max(0, (t - this.clip.startedAt) / 1000));
    if (this.media.readyState >= 1) go();
    else this.media.addEventListener('loadedmetadata', go, { once: true });
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.media.pause();
  }
}
