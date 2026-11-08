/**
 * Local persistence. Everything stays on the device, in IndexedDB. When IndexedDB is not
 * available (some private-browsing modes) the store keeps data in memory for the visit and
 * says so, rather than failing.
 */
import type { ClipRecord, LogEvent, MediaRecord, SessionRecord } from './types';

type StoreName = 'sessions' | 'events' | 'clips' | 'media';
type RecordOf<S extends StoreName> = S extends 'sessions'
  ? SessionRecord
  : S extends 'events'
    ? LogEvent
    : S extends 'clips'
      ? ClipRecord
      : MediaRecord;

const DB_NAME = 'residual';
const VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export class Store {
  private db?: IDBDatabase;
  private memory = new Map<StoreName, Map<string, unknown>>();
  persistent = false;

  async open(): Promise<void> {
    try {
      if (!('indexedDB' in globalThis)) throw new Error('no indexedDB');
      const open = indexedDB.open(DB_NAME, VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        db.createObjectStore('sessions', { keyPath: 'id' });
        db.createObjectStore('events', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
        db.createObjectStore('clips', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
        db.createObjectStore('media', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
      };
      this.db = await req(open);
      this.persistent = true;
      // Ask the browser not to evict recordings under storage pressure.
      navigator.storage?.persist?.().catch(() => undefined);
    } catch {
      this.db = undefined;
      this.persistent = false;
    }
  }

  async put<S extends StoreName>(store: S, value: RecordOf<S>): Promise<void> {
    if (!this.db) {
      this.mem(store).set((value as { id: string }).id, value);
      return;
    }
    try {
      const tx = this.db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('[residual] storage write failed; keeping in memory', err);
      this.mem(store).set((value as { id: string }).id, value);
    }
  }

  async get<S extends StoreName>(store: S, id: string): Promise<RecordOf<S> | undefined> {
    const m = this.mem(store).get(id) as RecordOf<S> | undefined;
    if (m || !this.db) return m;
    return req(this.db.transaction(store).objectStore(store).get(id)) as Promise<RecordOf<S> | undefined>;
  }

  async all<S extends StoreName>(store: S): Promise<RecordOf<S>[]> {
    const mem = [...this.mem(store).values()] as RecordOf<S>[];
    if (!this.db) return mem;
    const rows = (await req(this.db.transaction(store).objectStore(store).getAll())) as RecordOf<S>[];
    return [...rows, ...mem];
  }

  async bySession<S extends Exclude<StoreName, 'sessions'>>(store: S, sessionId: string): Promise<RecordOf<S>[]> {
    const mem = ([...this.mem(store).values()] as RecordOf<S>[]).filter((r) => (r as { sessionId: string }).sessionId === sessionId);
    if (!this.db) return mem;
    const idx = this.db.transaction(store).objectStore(store).index('sessionId');
    const rows = (await req(idx.getAll(sessionId))) as RecordOf<S>[];
    return [...rows, ...mem];
  }

  async deleteSession(sessionId: string): Promise<void> {
    for (const store of ['events', 'clips', 'media'] as const) {
      const rows = await this.bySession(store, sessionId);
      for (const r of rows) await this.delete(store, (r as { id: string }).id);
    }
    await this.delete('sessions', sessionId);
  }

  async delete(store: StoreName, id: string): Promise<void> {
    this.mem(store).delete(id);
    if (!this.db) return;
    const tx = this.db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(id);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async usage(): Promise<{ used: number; quota: number } | undefined> {
    try {
      const est = await navigator.storage?.estimate?.();
      return est ? { used: est.usage ?? 0, quota: est.quota ?? 0 } : undefined;
    } catch {
      return undefined;
    }
  }

  private mem(store: StoreName): Map<string, unknown> {
    let m = this.memory.get(store);
    if (!m) this.memory.set(store, (m = new Map()));
    return m;
  }
}
