/**
 * Loads the pre-rendered voice bank (see tools/build-voicebank.py) into a single AudioBuffer.
 * Fragments are played as slices of it, so cutting a word short or splicing two together is
 * just a matter of offsets.
 */
import bankUrl from './voicebank.bin?inline';
import { decodeImaAdpcm } from './adpcm';

export interface Take {
  entry: number;
  voice: number;
  /** seconds into the bank buffer */
  start: number;
  duration: number;
}

export interface VoiceBank {
  buffer: AudioBuffer;
  takes: Take[];
  byEntry: Map<number, Take[]>;
  /** same audio, time-reversed (used for unintelligible fragments) */
  reversed: AudioBuffer;
}

interface Header {
  rate: number;
  codec: string;
  clips: [entry: number, voice: number, byteOffset: number, samples: number][];
}

export async function parseVoiceBank(bytes: ArrayBuffer, ctx: BaseAudioContext): Promise<VoiceBank> {
  const view = new DataView(bytes);
  const magic = String.fromCharCode(...new Uint8Array(bytes, 0, 4));
  if (magic !== 'RVB1') throw new Error('voice bank: bad magic');
  const headerLen = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 8, headerLen))) as Header;
  const dataStart = 8 + headerLen;
  const total = header.clips.reduce((s, c) => s + c[3], 0);
  // 20 ms of silence between takes so slices never bleed into neighbours.
  const pad = Math.round(header.rate * 0.02);
  const length = total + pad * (header.clips.length + 1);
  const buffer = ctx.createBuffer(1, length, header.rate);
  const reversed = ctx.createBuffer(1, length, header.rate);
  const pcm = new Float32Array(length);
  const takes: Take[] = [];
  let cursor = pad;
  for (const [entry, voice, offset, samples] of header.clips) {
    const bytesLen = Math.ceil(samples / 2);
    decodeImaAdpcm(new Uint8Array(bytes, dataStart + offset, bytesLen), samples, pcm, cursor);
    takes.push({ entry, voice, start: cursor / header.rate, duration: samples / header.rate });
    cursor += samples + pad;
  }
  buffer.copyToChannel(pcm, 0);
  pcm.reverse();
  reversed.copyToChannel(pcm, 0);
  const byEntry = new Map<number, Take[]>();
  for (const t of takes) {
    const list = byEntry.get(t.entry) ?? [];
    list.push(t);
    byEntry.set(t.entry, list);
  }
  return { buffer, takes, byEntry, reversed };
}

export async function loadVoiceBank(ctx: BaseAudioContext): Promise<VoiceBank> {
  const res = await fetch(bankUrl);
  return parseVoiceBank(await res.arrayBuffer(), ctx);
}

/** Position of a take inside the reversed buffer. */
export function reversedStart(bank: VoiceBank, take: Take): number {
  return bank.buffer.duration - take.start - take.duration;
}
