/** The live investigation: an append-only event log, persisted as it grows. */
import { Emitter } from '../util/emitter';
import { uid } from '../util/time';
import type { Store } from './store';
import type { LogEvent, SessionRecord } from './types';

export interface SessionEvents extends Record<string, unknown> {
  event: LogEvent;
  changed: LogEvent;
  record: SessionRecord;
}

export class Session extends Emitter<SessionEvents> {
  readonly events: LogEvent[] = [];
  /** performance.now() at start, for the monotonic session clock */
  private readonly t0 = performance.now();

  constructor(
    readonly record: SessionRecord,
    private readonly store: Store,
  ) {
    super();
  }

  get id(): string {
    return this.record.id;
  }

  static async begin(store: Store, name: string): Promise<Session> {
    const record: SessionRecord = {
      id: uid('s'),
      name: name.trim() || 'Untitled investigation',
      startedAt: Date.now(),
      counts: { questions: 0, fragments: 0, visual: 0, clips: 0 },
    };
    await store.put('sessions', record);
    const s = new Session(record, store);
    s.log({ type: 'session', title: 'Session started', detail: record.name });
    return s;
  }

  /** Seconds since the session began (monotonic). */
  clock(): number {
    return (performance.now() - this.t0) / 1000;
  }

  /** Epoch ms for a session-clock time. */
  epoch(sessionSec: number): number {
    return this.record.startedAt + sessionSec * 1000;
  }

  log(partial: Omit<LogEvent, 'id' | 'sessionId' | 't'> & { t?: number }): LogEvent {
    const ev: LogEvent = { id: uid('e'), sessionId: this.record.id, t: partial.t ?? Date.now(), ...partial };
    this.events.push(ev);
    const c = this.record.counts;
    if (!ev.hidden) {
      if (ev.type === 'question') c.questions++;
      if (ev.type === 'fragment' || ev.type === 'audio-event') c.fragments++;
      if (ev.type === 'visual') c.visual++;
      if (ev.type === 'clip') c.clips++;
    }
    void this.store.put('events', ev);
    void this.store.put('sessions', this.record);
    this.emit('event', ev);
    return ev;
  }

  update(id: string, patch: Partial<LogEvent>): void {
    const ev = this.events.find((e) => e.id === id);
    if (!ev) return;
    Object.assign(ev, patch);
    void this.store.put('events', ev);
    this.emit('changed', ev);
  }

  findByUtterance(utteranceId: string): LogEvent | undefined {
    return this.events.find((e) => e.utteranceId === utteranceId && (e.type === 'question' || e.type === 'remark'));
  }

  async end(): Promise<void> {
    this.record.endedAt = Date.now();
    this.log({ type: 'session', title: 'Session ended' });
    await this.store.put('sessions', this.record);
    this.emit('record', this.record);
  }
}
