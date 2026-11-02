// Real voice recording: the microphone audio itself is saved on the phone every second
// (no speech recognition, so no auto-stop, no beeps, no dropped words).
// Only stop() or cancel() ends a recording. Long recordings are split into
// complete files every few minutes so each one can be turned into text on its own.
import type { Segment, VoiceStore } from "./voice-store";

export const MIC_DENIED = "اسمح للتطبيق باستخدام المايكروفون من إعدادات الهاتف.";
export const NO_RECORDING = "التسجيل الصوتي غير متاح على هذا الجهاز، اكتب فكرتك.";

type Recorder = {
  state: string;
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
};
export type RecorderDeps = {
  getStream: () => Promise<MediaStream>;
  createRecorder: (stream: MediaStream, mime: string) => Recorder;
  mime: string;
  store: VoiceStore;
  segmentMs?: number;
  keepAwake?: () => Promise<{ release(): Promise<void> } | null>;
};
export type AudioEvents = {
  onRecording: (on: boolean) => void;
  onMessage: (msg: string) => void;
  onElapsed?: (seconds: number) => void;
};

export function pickMime(isSupported: (m: string) => boolean): string {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find(isSupported) ?? "";
}

export function createAudioRecorder(deps: RecorderDeps, events: AudioEvents) {
  const segmentMs = deps.segmentMs ?? 5 * 60 * 1000;
  let want = false, stream: MediaStream | null = null, rec: Recorder | null = null;
  let session = "", seq = 0, startedAt = 0;
  let rotateTimer: ReturnType<typeof setTimeout> | undefined, tick: ReturnType<typeof setInterval> | undefined;
  let lock: { release(): Promise<void> } | null = null;
  let writes: Promise<unknown> = Promise.resolve();
  let segmentDone: Promise<void> = Promise.resolve();

  const releaseStream = () => { stream?.getTracks().forEach((t) => t.stop()); stream = null; };

  const acquire = async () => {
    stream = await deps.getStream();
    // A phone call or another app can take the mic: reconnect and keep going.
    stream.getAudioTracks().forEach((t) => t.addEventListener("ended", () => { if (want) void reconnect(); }));
  };

  const beginSegment = () => {
    if (!stream || !want) return;
    const id = crypto.randomUUID();
    const seg: Segment = { id, session, seq: seq++, mime: deps.mime.split(";")[0] || "audio/webm", createdAt: Date.now() };
    const r = deps.createRecorder(stream, deps.mime);
    rec = r;
    writes = writes.then(() => deps.store.addSegment(seg));
    let finish: () => void = () => {};
    segmentDone = new Promise<void>((res) => { finish = res; });
    r.ondataavailable = (e) => { if (e.data?.size) writes = writes.then(() => deps.store.appendChunk(id, e.data)).catch(() => {}); };
    r.onstop = () => finish();
    r.onerror = () => { finish(); if (want) void reconnect(); };
    r.start(1000);
    clearTimeout(rotateTimer);
    rotateTimer = setTimeout(rotate, segmentMs);
  };

  const endSegment = async () => {
    clearTimeout(rotateTimer);
    const r = rec; rec = null;
    if (r && r.state !== "inactive") { try { r.stop(); } catch { /* already stopped */ } }
    await segmentDone;
    await writes;
  };

  const rotate = async () => {
    if (!want) return;
    await endSegment();
    beginSegment();
  };

  let reconnecting = false;
  const reconnect = async () => {
    if (reconnecting) return;
    reconnecting = true;
    try {
      await endSegment();
      releaseStream();
      for (let i = 0; want && !stream; i++) {
        try { await acquire(); } catch { await new Promise((r) => setTimeout(r, Math.min(3000, 500 * (i + 1)))); }
      }
      beginSegment();
    } finally { reconnecting = false; }
  };

  const awake = async () => { try { lock = (await deps.keepAwake?.()) ?? null; } catch { lock = null; } };
  const onVisible = () => { if (want && typeof document !== "undefined" && document.visibilityState === "visible") void awake(); };

  return {
    isRecording: () => want,
    session: () => session,
    async start(existingSession?: string): Promise<boolean> {
      if (want) return true;
      try { await acquire(); } catch {
        events.onMessage(MIC_DENIED);
        return false;
      }
      want = true; session = existingSession ?? crypto.randomUUID(); seq = 0; startedAt = Date.now();
      events.onRecording(true); events.onMessage("");
      beginSegment();
      void awake();
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
      tick = setInterval(() => events.onElapsed?.(Math.floor((Date.now() - startedAt) / 1000)), 1000);
      return true;
    },
    /** Stop on the user's press; resolves when every second of audio is saved. Returns the session id. */
    async stop(): Promise<string> {
      if (!want) return session;
      want = false;
      clearInterval(tick);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      await endSegment();
      releaseStream();
      await lock?.release().catch(() => {}); lock = null;
      events.onRecording(false);
      return session;
    },
    /** Stop and throw the recording away. */
    async cancel() {
      const id = await this.stop();
      if (!id) return;
      const segs = (await deps.store.listSegments()).filter((s) => s.session === id);
      await Promise.all(segs.map((s) => deps.store.deleteSegment(s.id)));
    },
  };
}
export type AudioRecorder = ReturnType<typeof createAudioRecorder>;

/** Browser wiring for the real microphone. Returns null when recording isn't possible here. */
export function browserRecorderDeps(store: VoiceStore): RecorderDeps | null {
  if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return null;
  const mime = pickMime((m) => MediaRecorder.isTypeSupported(m));
  return {
    mime: mime || "audio/webm",
    store,
    getStream: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
    createRecorder: (stream, m) => new MediaRecorder(stream, { ...(m ? { mimeType: m } : {}), audioBitsPerSecond: 32000 }) as unknown as Recorder,
    keepAwake: async () => {
      const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
      return wl ? wl.request("screen") : null;
    },
  };
}
