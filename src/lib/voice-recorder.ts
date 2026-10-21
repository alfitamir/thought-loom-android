// Voice recorder that stays on until the user presses stop.
// Android ends speech recognition after short silences, errors, or screen changes;
// every such end is followed by a fresh session, and nothing but stop()/cancel()
// (or a mic permission the phone truly refuses) ends the recording.

export type RecorderEvents = {
  onText: (text: string) => void;
  onListening: (on: boolean) => void;
  onMessage: (msg: string) => void;
};

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
};

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as any),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as any),
};

export const MIC_DENIED = "اسمح للتطبيق باستخدام المايكروفون من إعدادات الهاتف.";
export const LANG_MISSING = "نزّل اللغة العربية للتعرف على الصوت من إعدادات الهاتف.";
export const RECOGNITION_TROUBLE = "التعرف على الصوت يتعثر، التسجيل مستمر. تأكد من تنزيل اللغة العربية للتعرف دون اتصال.";

export function restartDelay(fails: number) {
  return Math.min(150 * 2 ** Math.max(0, fails), 3000);
}

export function createVoiceRecorder(SR: any, ev: RecorderEvents, lang = "ar-SA", timers: Timers = defaultTimers) {
  let want = false;
  let current: any = null;
  let active = false;
  let everStarted = false;
  let fails = 0;
  let warned = false;
  let restartId: unknown = null;
  let watchdogId: unknown = null;
  let endWaiters: Array<() => void> = [];

  const flushWaiters = () => { const w = endWaiters; endWaiters = []; w.forEach((f) => f()); };

  const schedule = (ms: number) => {
    if (!want || restartId !== null) return;
    restartId = timers.setTimeout(() => { restartId = null; if (want && !active) open(); }, ms);
  };

  const finish = (msg?: string) => {
    want = false;
    if (restartId !== null) { timers.clearTimeout(restartId); restartId = null; }
    if (watchdogId !== null) { timers.clearInterval(watchdogId); watchdogId = null; }
    if (msg) ev.onMessage(msg);
    ev.onListening(false);
  };

  const open = () => {
    const rec = new SR();
    rec.lang = lang;
    rec.continuous = false; // Android duplicates text in continuous mode
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    let interim = "";
    const commit = (s: string) => { const t = s.trim(); if (t) ev.onText(t); };

    rec.onstart = () => { everStarted = true; };
    rec.onaudiostart = () => { everStarted = true; };
    rec.onresult = (e: any) => {
      let finals = "";
      let pending = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals += r[0].transcript + " ";
        else pending += r[0].transcript + " ";
      }
      if (finals.trim()) { commit(finals); interim = ""; fails = 0; }
      else interim = pending;
    };
    rec.onerror = (e: any) => {
      if (rec !== current) return;
      const err = e?.error;
      if (err === "language-not-supported") { finish(LANG_MISSING); return; }
      if ((err === "not-allowed" || err === "service-not-allowed") && !everStarted) { finish(MIC_DENIED); return; }
      if (err === "no-speech" || err === "aborted") return;
      fails++;
      if (fails >= 4 && !warned) { warned = true; ev.onMessage(RECOGNITION_TROUBLE); }
    };
    rec.onend = () => {
      if (rec !== current) return;
      // Keep words Android cut off before they became final.
      if (interim.trim()) { commit(interim); interim = ""; }
      active = false;
      current = null;
      if (!want) { flushWaiters(); return; }
      schedule(restartDelay(fails));
    };

    current = rec;
    try {
      rec.start();
      active = true;
    } catch {
      current = null;
      active = false;
      fails++;
      schedule(restartDelay(fails));
    }
  };

  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState === "visible" && want && !active) {
      if (restartId !== null) { timers.clearTimeout(restartId); restartId = null; }
      open();
    }
  };

  return {
    isRecording: () => want,
    start() {
      if (want) return;
      want = true; fails = 0; warned = false;
      ev.onMessage("");
      ev.onListening(true);
      // Safety net: if Android ever ends a session without telling us, start again.
      watchdogId = timers.setInterval(() => { if (want && !active) schedule(0); }, 4000);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
      open();
    },
    /** Stops at the user's request and resolves once the last spoken words arrive. */
    stop(): Promise<void> {
      const rec = current;
      finish();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (!rec || !active) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let done = false;
        const end = () => { if (!done) { done = true; resolve(); } };
        endWaiters.push(end);
        timers.setTimeout(end, 1500);
        try { rec.stop(); } catch { end(); }
      });
    },
    /** Stops and discards anything still pending. */
    cancel() {
      const rec = current;
      current = null; active = false;
      finish();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      flushWaiters();
      try { rec?.abort?.(); } catch { /* already closed */ }
    },
  };
}

export type VoiceRecorder = ReturnType<typeof createVoiceRecorder>;
