// Recorded voice is saved on the phone, second by second, until it has become text.
// Nothing here talks to the network.

export type Segment = {
  id: string;
  session: string;
  seq: number;
  mime: string;
  createdAt: number;
  transcript?: string;
};

export interface VoiceStore {
  addSegment(seg: Segment): Promise<void>;
  appendChunk(segId: string, chunk: Blob): Promise<void>;
  setTranscript(segId: string, text: string): Promise<void>;
  listSegments(): Promise<Segment[]>;
  segmentAudio(segId: string): Promise<Blob>;
  deleteSegment(segId: string): Promise<void>;
}

const sortSegs = (a: Segment, b: Segment) => a.createdAt - b.createdAt || a.seq - b.seq;

/** In-memory store (tests, or browsers without IndexedDB). */
export function memoryVoiceStore(): VoiceStore {
  const segs = new Map<string, Segment>();
  const chunks = new Map<string, Blob[]>();
  return {
    async addSegment(seg) { segs.set(seg.id, { ...seg }); chunks.set(seg.id, []); },
    async appendChunk(id, c) { chunks.get(id)?.push(c); },
    async setTranscript(id, text) { const s = segs.get(id); if (s) s.transcript = text; },
    async listSegments() { return [...segs.values()].map((s) => ({ ...s })).sort(sortSegs); },
    async segmentAudio(id) { return new Blob(chunks.get(id) ?? [], { type: segs.get(id)?.mime ?? "audio/webm" }); },
    async deleteSegment(id) { segs.delete(id); chunks.delete(id); },
  };
}

const DB = "afkari-voice";
const req = <T,>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore("segments", { keyPath: "id" });
      const c = db.createObjectStore("chunks", { autoIncrement: true });
      c.createIndex("seg", "seg");
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function indexedDbVoiceStore(): VoiceStore {
  let dbp: Promise<IDBDatabase> | null = null;
  const db = () => (dbp ??= openDb());
  const tx = async (stores: string[], mode: IDBTransactionMode) => (await db()).transaction(stores, mode);
  const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
  return {
    async addSegment(seg) { const t = await tx(["segments"], "readwrite"); t.objectStore("segments").put(seg); await done(t); },
    async appendChunk(seg, blob) { const t = await tx(["chunks"], "readwrite"); t.objectStore("chunks").add({ seg, blob }); await done(t); },
    async setTranscript(id, text) {
      const t = await tx(["segments"], "readwrite");
      const s = t.objectStore("segments");
      const cur = await req(s.get(id));
      if (cur) s.put({ ...cur, transcript: text });
      await done(t);
    },
    async listSegments() {
      const t = await tx(["segments"], "readonly");
      return ((await req(t.objectStore("segments").getAll())) as Segment[]).sort(sortSegs);
    },
    async segmentAudio(id) {
      const t = await tx(["segments", "chunks"], "readonly");
      const seg = (await req(t.objectStore("segments").get(id))) as Segment | undefined;
      const rows = (await req(t.objectStore("chunks").index("seg").getAll(id))) as { blob: Blob }[];
      return new Blob(rows.map((r) => r.blob), { type: seg?.mime ?? "audio/webm" });
    },
    async deleteSegment(id) {
      const t = await tx(["segments", "chunks"], "readwrite");
      t.objectStore("segments").delete(id);
      const keys = await req(t.objectStore("chunks").index("seg").getAllKeys(id));
      keys.forEach((k) => t.objectStore("chunks").delete(k));
      await done(t);
    },
  };
}

let shared: VoiceStore | null = null;
export const voiceStore = (): VoiceStore =>
  (shared ??= typeof indexedDB !== "undefined" ? indexedDbVoiceStore() : memoryVoiceStore());
