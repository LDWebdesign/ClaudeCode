/** Investigation log: chronological entries, like a field notebook. */
import type { ConfigStore } from '../config';
import type { Session } from '../session/session';
import type { Store } from '../session/store';
import type { LogEvent } from '../session/types';
import { clockTime } from '../util/time';
import { openLightbox } from './camera-view';
import { h, icon } from './dom';

const KIND: Partial<Record<LogEvent['type'], string>> = {
  question: 'Question',
  remark: 'Investigator',
  fragment: 'Audio',
  'audio-event': 'Audio',
  visual: 'Visual',
  capture: 'Capture',
  clip: 'Recording',
  note: 'Note',
  session: 'Session',
  system: 'System',
};

const thumbUrls = new Map<string, string>();

async function thumb(store: Store, id: string): Promise<string | undefined> {
  const hit = thumbUrls.get(id);
  if (hit) return hit;
  const rec = await store.get('media', id);
  if (!rec) return undefined;
  const url = URL.createObjectURL(rec.blob);
  thumbUrls.set(id, url);
  return url;
}

/** Entry kind class, prefixed so it can never collide with layout classes. */
export function entryClass(ev: LogEvent): string {
  if (ev.type === 'fragment') return ev.title === 'Possible EVP' ? 'k-evp' : 'k-fragment';
  if (ev.type === 'audio-event') return 'k-event';
  return `k-${ev.type}`;
}

/** One log entry. `diagnostics` reveals engine-only entries and decision details. */
export function renderEntry(ev: LogEvent, store: Store, diagnostics: boolean, onTime?: (ev: LogEvent) => void): HTMLLIElement {
  const li = h('li.entry', { 'data-id': ev.id, class: `${entryClass(ev)}${ev.hidden ? ' engine' : ''}` });
  fillEntry(li, ev, store, diagnostics, onTime);
  return li;
}

export function fillEntry(li: HTMLElement, ev: LogEvent, store: Store, diagnostics: boolean, onTime?: (ev: LogEvent) => void): void {
  const kind = ev.type === 'fragment' || ev.type === 'audio-event' ? ev.title : KIND[ev.type] ?? ev.type;
  const when = onTime
    ? h('button.when', { type: 'button', onclick: () => onTime(ev), title: 'Jump to this moment' }, clockTime(ev.t))
    : h('span.when', null, clockTime(ev.t));
  const parts: (HTMLElement | null)[] = [when, h('span.kind', null, kind)];

  if (ev.type === 'question' || ev.type === 'remark') {
    parts.push(h('span.body', null, ev.text ? `“${ev.text}”` : h('span.dim', null, '[speech, untranscribed]')));
  } else if (ev.type === 'fragment' || ev.type === 'audio-event') {
    if (ev.text) {
      parts.push(h('span.body', null, h('span.quote', null, `“${ev.text}”`), ev.alternates?.length ? h('span.alt', null, `  alt. ${ev.alternates.map((a) => `“${a}”`).join(', ')}`) : null));
    }
  } else if (ev.type === 'visual') {
    parts.push(h('span.body', null, ev.title));
  } else if (ev.type === 'session') {
    parts.push(h('span.body', null, ev.title + (ev.detail ? ` — ${ev.detail}` : '')));
  } else if (ev.text || ev.title) {
    parts.push(h('span.body', null, ev.text ?? ev.title));
  }
  if (ev.detail && ev.type !== 'session') parts.push(h('span.detail', null, ev.detail));
  if (diagnostics && ev.meta) {
    parts.push(h('span.meta', null, Object.entries(ev.meta).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')));
  }
  if (ev.mediaId) {
    const wrap = h('span.thumb');
    parts.push(wrap);
    void thumb(store, ev.mediaId).then((url) => {
      if (!url) return;
      wrap.append(h('button', { type: 'button', onclick: () => openLightbox(url, `${clockTime(ev.t, true)} · ${ev.title}`), 'aria-label': 'View frame' }, h('img', { src: url, alt: '' })));
    });
  }
  li.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
}

export class LogView {
  readonly el: HTMLElement;
  private list = h('ol.log-list', { 'aria-live': 'polite' });
  private peekTime = h('span.t');
  private peekText = h('span.x', null, 'Investigation log');
  private toggle: HTMLButtonElement;
  private session?: Session;
  private unsub: (() => void)[] = [];

  constructor(
    private readonly store: Store,
    private readonly config: ConfigStore,
  ) {
    const noteInput = h('input', { type: 'text', placeholder: 'Add a note to the log', 'aria-label': 'Note', autocomplete: 'off' }) as HTMLInputElement;
    const noteForm = h('form.note-form', {
      onsubmit: (e: Event) => {
        e.preventDefault();
        const t = noteInput.value.trim();
        if (!t || !this.session) return;
        this.session.log({ type: 'note', title: 'Note', text: t });
        noteInput.value = '';
      },
    }, noteInput, h('button.btn', { type: 'submit' }, 'Add'));
    this.toggle = h('button.icon-btn.toggle', { type: 'button', 'aria-label': 'Open log', 'aria-expanded': 'false' }, icon('up'));
    const head = h('header.log-head', { onclick: () => this.setOpen(!this.el.classList.contains('open')) },
      h('span.grip'),
      h('span.peek', null, this.peekTime, this.peekText),
      h('span.label.title', null, 'Investigation log'),
      this.toggle,
    );
    this.el = h('aside.log', { 'aria-label': 'Investigation log' }, head, this.list, noteForm);
    this.config.subscribe(() => this.rerender());
  }

  setOpen(open: boolean): void {
    if (window.matchMedia('(min-width: 960px)').matches) return;
    this.el.classList.toggle('open', open);
    this.toggle.setAttribute('aria-expanded', String(open));
    this.toggle.replaceChildren(icon(open ? 'down' : 'up'));
    if (open) this.list.scrollTop = this.list.scrollHeight;
  }

  attach(session: Session): void {
    this.unsub.forEach((u) => u());
    this.session = session;
    this.rerender();
    this.unsub = [
      session.on('event', (ev) => this.add(ev)),
      session.on('changed', (ev) => {
        const li = this.list.querySelector<HTMLElement>(`[data-id="${ev.id}"]`);
        if (li) fillEntry(li, ev, this.store, this.config.value.diagnostics);
        this.updatePeek();
      }),
    ];
  }

  private visible(ev: LogEvent): boolean {
    return !ev.hidden || this.config.value.diagnostics;
  }

  private rerender(): void {
    if (!this.session) return;
    this.list.replaceChildren(...this.session.events.filter((e) => this.visible(e)).map((e) => renderEntry(e, this.store, this.config.value.diagnostics)));
    this.updatePeek();
  }

  private add(ev: LogEvent): void {
    if (!this.visible(ev)) return;
    const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
    // entries can arrive slightly out of order (interpretation delay); keep them chronological
    const li = renderEntry(ev, this.store, this.config.value.diagnostics);
    const after = [...this.list.children].find((c) => {
      const other = this.session?.events.find((e) => e.id === (c as HTMLElement).dataset.id);
      return other && other.t > ev.t;
    });
    if (after) this.list.insertBefore(li, after);
    else this.list.append(li);
    if (nearBottom) this.list.scrollTop = this.list.scrollHeight;
    this.updatePeek();
  }

  private updatePeek(): void {
    const last = [...(this.session?.events ?? [])].reverse().find((e) => !e.hidden && e.type !== 'session');
    if (!last) {
      this.peekTime.textContent = '';
      this.peekText.textContent = 'Investigation log';
      return;
    }
    this.peekTime.textContent = clockTime(last.t);
    const body =
      last.type === 'question' || last.type === 'remark'
        ? last.text ? `“${last.text}”${last.detail?.includes('No response') ? ' — no response' : ''}` : 'Speech (untranscribed)'
        : last.text ? `${last.title}: “${last.text}”` : last.title;
    this.peekText.textContent = body;
  }
}
