import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Mic, Music, Square } from "lucide-react";
import { saveIdea } from "@/lib/ideas";
import { supabase } from "@/integrations/supabase/client";
import { pushIdea, syncNow } from "@/lib/sync";
import { createVoiceRecorder, type VoiceRecorder } from "@/lib/voice-recorder";
import { browserRecorderDeps, createAudioRecorder, NO_RECORDING, type AudioRecorder } from "@/lib/audio-recorder";
import { songVoiceStore, voiceStore } from "@/lib/voice-store";
import { deleteSession, processPending, transcribeSession } from "@/lib/transcribe";
import { transcribeAudio } from "@/lib/ai-features";
import { resolveEngine } from "@/lib/ai-engine";
import type { Engine } from "@/lib/article-ai";
import { formatElapsed, joinTranscript, transcribeFinished } from "@/lib/voice-session";
import { recoverPendingSongs, saveRecordedSong } from "@/lib/songs";

export const Route = createFileRoute("/")({
  // `?record=<nonce>` is the bottom navigation's "open the recorder" signal:
  // each tap sends a fresh nonce so repeated taps retrigger the effect below.
  validateSearch: (search: Record<string, unknown>): { record?: number } => {
    const raw = search["record"];
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isFinite(value) && value > 0 ? { record: value } : {};
  },
  head: () => ({
    meta: [
      { title: "أفكاري — سجّل فكرتك" },
      { name: "description", content: "سجّل أفكارك بالصوت أو الكتابة لتتحول إلى مقالات مبوبة." },
      { property: "og:title", content: "أفكاري — سجّل فكرتك" },
      { property: "og:description", content: "سجّل أفكارك بالصوت أو الكتابة لتتحول إلى مقالات مبوبة." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

async function engineOrThrow(): Promise<Engine> {
  const engine = await resolveEngine();
  if (typeof engine === "string") throw new Error(engine);
  return engine;
}

function Index() {
  const { record } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [msg, setMsg] = useState("");
  const [cloud, setCloud] = useState<"off" | "on" | "syncing">("off");
  const [elapsed, setElapsed] = useState(0);
  const [mediaMode, setMediaMode] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Recorder mode: «فكرة» (the dictation pipeline, unchanged) or «أغنية»
  // (song mode — the same microphone pipeline, but the audio is kept as a
  // recording and never transcribed). The kind is captured into a ref when
  // a recording starts so stop/cancel always route by what was recorded,
  // not by the toggle's current position.
  const [recMode, setRecMode] = useState<"idea" | "song">("idea");
  const recKindRef = useRef<"idea" | "song">("idea");
  const elapsedRef = useRef(0);
  const recRef = useRef<VoiceRecorder | null>(null);
  const audioRef = useRef<AudioRecorder | null>(null);
  const modeRef = useRef<"media" | "sr" | null>(null);
  const sessionRef = useRef("");
  const baseTextRef = useRef("");
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const drainTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const drainBusyRef = useRef(false);
  const resumedRef = useRef(false);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      const { data } = await supabase.auth.getSession();
      if (!alive) return;
      if (data.session) {
        setCloud("syncing");
        await syncNow();
        if (alive) setCloud("on");
      } else {
        setCloud("off");
      }
    };
    check();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") check();
    });
    window.addEventListener("online", check);
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
      window.removeEventListener("online", check);
    };
  }, []);

  // Bottom-nav «سجّل فكرة» deep link: open the recorder form (never auto-start
  // the mic — that still needs the «ابدأ التسجيل» tap), then clear the param
  // with replace so re-renders and the back button don't reopen it.
  useEffect(() => {
    // The router merges raw URL params into the match search, so a hand-typed
    // junk value can arrive here as a string despite the declared type —
    // only a positive number (the nonce the bottom nav sends) may open it.
    if (typeof record !== "number" || !Number.isFinite(record) || record <= 0) return;
    setOpen(true);
    navigate({ to: "/", search: {}, replace: true });
  }, [record, navigate]);

  // Recording runs until the user presses stop (see createVoiceRecorder).
  const textRef = useRef("");
  useEffect(() => { textRef.current = text; }, [text]);
  useEffect(() => () => { recRef.current?.cancel(); }, []);
  useEffect(() => () => {
    abortRef.current?.abort();
    if (drainTimerRef.current) clearInterval(drainTimerRef.current);
    // Release the microphone; the audio saved so far stays on the phone for the resume pass.
    void audioRef.current?.stop().catch(() => {});
  }, []);

  // Recordings left on the phone by an earlier session (their transcription was
  // interrupted) become ideas on a later open — the pipeline's resume pass.
  useEffect(() => {
    const resume = async () => {
      if (resumedRef.current) return;
      resumedRef.current = true;
      try {
        const engine = await resolveEngine();
        if (typeof engine === "string") { resumedRef.current = false; return; }
        const made = await processPending(voiceStore(), engine, new AbortController().signal, "", (t) => {
          pushIdea(saveIdea(t));
        });
        if (made > 0) setMsg("تمت استعادة تسجيل محفوظ وتحويله إلى فكرة ✓");
      } catch {
        resumedRef.current = false; // audio stays on the phone; retried on the next open/online
      }
    };
    void resume();
    window.addEventListener("online", resume);
    return () => window.removeEventListener("online", resume);
  }, []);

  // Song recordings whose save was interrupted (the app closed mid-stop)
  // become songs on a later open — song mode's own resume pass. It reads
  // ONLY the song store, so it can never touch a dictation, and no audio
  // is ever transcribed here.
  const songResumedRef = useRef(false);
  useEffect(() => {
    const recover = async () => {
      if (songResumedRef.current) return;
      songResumedRef.current = true;
      try {
        const made = await recoverPendingSongs({ store: songVoiceStore() });
        if (made.length) {
          made.forEach((idea) => pushIdea(idea));
          setMsg("تمت استعادة أغنية مسجلة على هاتفك ✓");
        }
      } catch {
        songResumedRef.current = false; // audio stays on the phone; retried on the next open
      }
    };
    void recover();
  }, []);

  const setTextBoth = (next: string | ((cur: string) => string)) => {
    setText((cur) => {
      const value = typeof next === "function" ? next(cur) : next;
      textRef.current = value;
      return value;
    });
  };

  // While the microphone records, finished minute-long segments are transcribed
  // as they close and their text lands in the box in order, piece by piece.
  const drainOnce = async () => {
    const session = sessionRef.current;
    if (!session || drainBusyRef.current) return;
    drainBusyRef.current = true;
    try {
      const engine = await engineOrThrow().catch(() => null);
      if (!engine) return; // no key/login yet — the stop pass below will say so
      const texts = await transcribeFinished(voiceStore(), session, (audio) => transcribeAudio(audio, { engine }));
      if (texts.length) setTextBoth((cur) => joinTranscript(cur, texts.join(" ")));
    } catch {
      // A failed piece keeps no text and is retried by the stop pass, which reports it.
    } finally {
      drainBusyRef.current = false;
    }
  };
  const startDrain = () => {
    if (drainTimerRef.current) clearInterval(drainTimerRef.current);
    drainTimerRef.current = setInterval(() => { void drainOnce(); }, 5000);
  };
  const stopDrain = () => {
    if (drainTimerRef.current) { clearInterval(drainTimerRef.current); drainTimerRef.current = null; }
  };

  // After stop: transcribe whatever is left and rebuild the box as
  // (text written before recording) + (the whole session, in order) — the same
  // segments the drain already showed, so nothing is ever duplicated.
  const finishTranscription = async (session: string) => {
    if (!session) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setTranscribing(true);
    try {
      const engine = await engineOrThrow();
      const full = await transcribeSession(voiceStore(), session, engine, ctrl.signal,
        (blob, _mime, eng, signal) => transcribeAudio(blob, { engine: eng, signal }));
      setTextBoth(joinTranscript(baseTextRef.current, full));
      await deleteSession(voiceStore(), session);
      sessionRef.current = "";
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setMsg(e instanceof Error ? e.message : "تعذّر تحويل الصوت إلى نص الآن. التسجيل محفوظ على هاتفك.");
      }
      // The audio stays in the store: the resume pass turns it into an idea later.
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setTranscribing(false);
    }
  };

  // After stop in song mode: assemble the session into one audio file and
  // save it as a song. No transcription, no engine, no key — the recording
  // itself is the result. If assembly fails the segments stay in the song
  // store and the recovery pass above saves the song on a later open.
  const finishSong = async (session: string, durationSeconds: number) => {
    if (!session) return;
    try {
      const idea = await saveRecordedSong({ store: songVoiceStore(), session, durationSeconds });
      sessionRef.current = "";
      if (idea) {
        pushIdea(idea);
        setOpen(false);
        setMsg("حُفظت أغنيتك بصوتك ✓ — ستجدها في المكتبة، ويمكنك إضافة كلماتها من هناك");
      } else {
        setMsg("لم يُحفظ من التسجيل شيء.");
      }
    } catch {
      setMsg("تعذّر حفظ الأغنية الآن؛ التسجيل محفوظ على هاتفك وسيظهر لاحقًا.");
    }
  };

  const stopActive = async () => {
    if (modeRef.current === "media" && audioRef.current) {
      stopDrain();
      const rec = audioRef.current;
      audioRef.current = null;
      modeRef.current = null;
      const kind = recKindRef.current;
      const duration = elapsedRef.current;
      recKindRef.current = "idea";
      elapsedRef.current = 0;
      const session = await rec.stop();
      setMediaMode(false);
      setElapsed(0);
      if (kind === "song") { await finishSong(session, duration); return; }
      await finishTranscription(session);
      return;
    }
    if (recRef.current?.isRecording()) await recRef.current.stop();
  };
  const runStop = () => {
    const p = stopActive();
    stopPromiseRef.current = p;
    void p.finally(() => { if (stopPromiseRef.current === p) stopPromiseRef.current = null; });
    return p;
  };

  const toggleMic = async () => {
    if (transcribing) return;
    if (listening) { await runStop(); return; }
    // Primary path: record the microphone itself (MediaRecorder). There is no
    // recognition session for Android to kill, so recording runs until «إيقاف».
    // Song mode records into its own store and never starts the transcription
    // drain; idea mode is exactly as before.
    const kind = recMode;
    const deps = browserRecorderDeps(kind === "song" ? songVoiceStore() : voiceStore());
    if (deps) {
      recRef.current?.cancel();
      baseTextRef.current = textRef.current;
      const rec = createAudioRecorder({ ...deps, segmentMs: 60_000 }, {
        onRecording: setListening,
        onMessage: setMsg,
        onElapsed: (s) => { elapsedRef.current = s; setElapsed(s); },
      });
      audioRef.current = rec;
      modeRef.current = "media";
      recKindRef.current = kind;
      setElapsed(0);
      elapsedRef.current = 0;
      setMediaMode(true);
      const ok = await rec.start();
      if (!ok) { // mic refused — MIC_DENIED was already shown
        audioRef.current = null;
        modeRef.current = null;
        recKindRef.current = "idea";
        setMediaMode(false);
        return;
      }
      sessionRef.current = rec.session();
      if (kind === "idea") startDrain();
      return;
    }
    // Song mode has no speech-recognition fallback: recognition would turn
    // the singing into text, and a song must stay audio.
    if (kind === "song") { setMsg(NO_RECORDING); return; }
    // Fallback: the browser's speech recognition, as before.
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { setMsg("التسجيل الصوتي غير متاح على هذا الجهاز، اكتب فكرتك."); return; }
    recRef.current?.cancel();
    recRef.current = createVoiceRecorder(SR, {
      onText: (s) => setText((t) => { const n = (t + " " + s).trim(); textRef.current = n; return n; }),
      onListening: setListening,
      onMessage: setMsg,
    });
    recRef.current.start();
  };

  const save = async () => {
    if (stopPromiseRef.current) await stopPromiseRef.current;
    // In song mode there is no text to save: stopping the recording saves
    // the song itself (see finishSong).
    if (recMode === "song") { if (listening) await runStop(); return; }
    if (listening) await runStop();
    const body = textRef.current.trim();
    if (!body) return;
    const idea = saveIdea(body);
    textRef.current = "";
    setText(""); setOpen(false); setMsg("حُفظت الفكرة ✓");
    pushIdea(idea);
  };

  const cancel = async () => {
    abortRef.current?.abort();
    if (recKindRef.current === "song" && modeRef.current === "media" && audioRef.current) {
      // A cancelled song recording is thrown away entirely — unlike a
      // dictation there is no transcript to salvage, so nothing is kept
      // for a resume pass.
      const rec = audioRef.current;
      audioRef.current = null;
      modeRef.current = null;
      recKindRef.current = "idea";
      setMediaMode(false);
      setElapsed(0);
      elapsedRef.current = 0;
      await rec.cancel().catch(() => {});
      setListening(false);
      sessionRef.current = "";
      setOpen(false);
      return;
    }
    if (modeRef.current === "media" && audioRef.current) {
      stopDrain();
      const rec = audioRef.current;
      audioRef.current = null;
      modeRef.current = null;
      setMediaMode(false);
      setElapsed(0);
      const session = await rec.stop().catch(() => sessionRef.current);
      setListening(false);
      // The form's text is discarded, as before — so pieces whose text already
      // reached the screen go with it. Pieces never transcribed stay on the
      // phone for the resume pass instead of being silently deleted.
      if (session) {
        const store = voiceStore();
        const segs = (await store.listSegments()).filter((s) => s.session === session);
        await Promise.all(segs.filter((s) => s.transcript !== undefined).map((s) => store.deleteSegment(s.id)));
      }
      sessionRef.current = "";
    } else {
      recRef.current?.cancel();
    }
    setOpen(false);
  };

  return (
    <main dir="rtl" className="paper flex min-h-screen flex-col items-center justify-center gap-10 px-6 pb-24">
      <h1 className="font-display text-4xl text-foreground">أفكاري</h1>
      {!open ? (
        <button onClick={() => setOpen(true)} className="record-btn">سجّل فكرة</button>
      ) : (
        <div className="w-full max-w-md space-y-4">
          <div className="flex rounded-lg border border-border bg-muted/30 p-1" role="group" aria-label="وضع التسجيل">
            <button type="button" aria-pressed={recMode === "idea"} disabled={listening || transcribing} onClick={() => setRecMode("idea")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition-all disabled:opacity-50 ${recMode === "idea" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              <Mic className="size-4" />فكرة
            </button>
            <button type="button" aria-pressed={recMode === "song"} disabled={listening || transcribing} onClick={() => setRecMode("song")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition-all disabled:opacity-50 ${recMode === "song" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              <Music className="size-4" />أغنية
            </button>
          </div>
          {recMode === "idea" ? (
            <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={8}
              placeholder="اكتب أو تكلم..." className="w-full rounded-2xl border border-border bg-card p-4 text-lg leading-relaxed text-card-foreground outline-none focus:ring-2 focus:ring-ring" />
          ) : (
            <p className="rounded-2xl border border-border bg-card p-4 text-center leading-relaxed text-muted-foreground">
              غنِّ أغنيتك كاملة — ستُحفظ بصوتك كما هي، من غير أن تتحول إلى نص. الكلمات يمكنك إضافتها لاحقًا من المكتبة.
            </p>
          )}
          {listening && (
            <p className="text-center text-sm text-destructive">
              ● جاري التسجيل…{mediaMode && <> <span dir="ltr">{formatElapsed(elapsed)}</span> —</>} لن يتوقف إلا بضغطك على «إيقاف التسجيل»
            </p>
          )}
          {transcribing && <p className="text-center text-sm text-muted-foreground">جارٍ تحويل الصوت إلى نص…</p>}
          <div className="flex gap-3">
            <button onClick={toggleMic} disabled={transcribing} aria-pressed={listening} className={`inline-flex flex-1 items-center justify-center gap-2 rounded-full py-3 font-semibold ${listening ? "bg-destructive text-destructive-foreground animate-pulse" : "bg-secondary text-secondary-foreground"}`}>
              {listening ? <Square className="size-5" /> : <Mic className="size-5" />}
              {transcribing ? "جارٍ التحويل…" : listening ? "إيقاف التسجيل" : "ابدأ التسجيل"}
            </button>
            {recMode === "idea" && <button onClick={save} className="flex-1 rounded-full bg-primary py-3 font-semibold text-primary-foreground">حفظ</button>}
          </div>
          <button onClick={cancel} className="w-full text-sm text-muted-foreground">إلغاء</button>
        </div>
      )}
      {msg && <p className="text-center text-sm text-muted-foreground">{msg}</p>}
      {cloud === "on" ? (
        <p className="text-center text-sm text-muted-foreground">☁️ أفكارك محفوظة في السحابة</p>
      ) : cloud === "syncing" ? (
        <p className="text-center text-sm text-muted-foreground">☁️ جاري مزامنة أفكارك...</p>
      ) : (
        <Link to="/auth" className="text-center text-sm text-primary underline">☁️ فعّل الحفظ في السحابة</Link>
      )}
    </main>
  );
}
