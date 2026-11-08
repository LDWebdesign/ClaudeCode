export type Mode = 'spiritbox' | 'camera';

export type EventType =
  | 'session'
  | 'question'
  | 'remark'
  | 'response-none'
  | 'fragment'
  | 'audio-event'
  | 'visual'
  | 'capture'
  | 'clip'
  | 'note'
  | 'system';

export interface LogEvent {
  id: string;
  sessionId: string;
  /** epoch ms */
  t: number;
  type: EventType;
  mode?: Mode;
  title: string;
  /** quoted speech or a fragment reading */
  text?: string;
  detail?: string;
  alternates?: string[];
  /** 0..1 */
  confidence?: number;
  /** engine-only record (e.g. an unlogged fragment or footage-only anomaly); shown only in diagnostics */
  hidden?: boolean;
  /** engine decision details, for diagnostics and export */
  meta?: Record<string, unknown>;
  mediaId?: string;
  clipId?: string;
  /** utterance this event belongs to (questions are amended when a transcript arrives late) */
  utteranceId?: string;
}

export interface SessionRecord {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  counts: { questions: number; fragments: number; visual: number; clips: number };
}

export interface ClipRecord {
  id: string;
  sessionId: string;
  kind: 'video' | 'audio';
  mode: Mode;
  mime: string;
  startedAt: number;
  endedAt: number;
  size: number;
  blob: Blob;
}

export interface MediaRecord {
  id: string;
  sessionId: string;
  t: number;
  kind: 'still' | 'thumb';
  blob: Blob;
}
