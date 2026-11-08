/** Records investigation footage (camera mode) or audio (spirit-box mode) with MediaRecorder. */
import { uid } from '../util/time';
import type { ClipRecord, Mode } from './types';

const VIDEO_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
const AUDIO_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];

export function recordingSupported(): boolean {
  return typeof MediaRecorder !== 'undefined';
}

function pickType(kind: 'video' | 'audio'): string {
  const list = kind === 'video' ? VIDEO_TYPES : AUDIO_TYPES;
  for (const t of list) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return '';
}

export class ClipRecorder {
  private rec?: MediaRecorder;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private kind: 'video' | 'audio' = 'audio';
  private mode: Mode = 'spiritbox';

  get active(): boolean {
    return this.rec?.state === 'recording';
  }

  get since(): number {
    return this.startedAt;
  }

  start(stream: MediaStream, kind: 'video' | 'audio', mode: Mode): void {
    if (this.active) return;
    const mimeType = pickType(kind);
    this.rec = new MediaRecorder(stream, {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: kind === 'video' ? 2_500_000 : undefined,
      audioBitsPerSecond: 96_000,
    });
    this.kind = kind;
    this.mode = mode;
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.startedAt = Date.now();
    this.rec.start(1000);
  }

  stop(sessionId: string): Promise<ClipRecord | undefined> {
    const rec = this.rec;
    if (!rec || rec.state === 'inactive') return Promise.resolve(undefined);
    return new Promise((resolve) => {
      rec.onstop = () => {
        const mime = rec.mimeType || (this.kind === 'video' ? 'video/webm' : 'audio/webm');
        const blob = new Blob(this.chunks, { type: mime });
        this.chunks = [];
        this.rec = undefined;
        if (!blob.size) return resolve(undefined);
        resolve({
          id: uid('c'),
          sessionId,
          kind: this.kind,
          mode: this.mode,
          mime,
          startedAt: this.startedAt,
          endedAt: Date.now(),
          size: blob.size,
          blob,
        });
      };
      rec.stop();
    });
  }
}
