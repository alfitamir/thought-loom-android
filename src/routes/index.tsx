import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Mic, Music, Square, Stethoscope } from "lucide-react";
import { partitionIdeas, saveIdea } from "@/lib/ideas";
import { loadVisibleIdeas } from "@/lib/pending-deletes";
import { supabase } from "@/integrations/supabase/client";
import { pushIdea, syncNow } from "@/lib/sync";
import { createVoiceRecorder, type VoiceRecorder } from "@/lib/voice-recorder";
import {
  browserRecorderDeps,
  createAudioRecorder,
  NO_RECORDING,
  type AudioRecorder,
} from "@/lib/audio-recorder";
import { songVoiceStore, voiceStore } from "@/lib/voice-store";
import { deleteSession, processPending, transcribeSession } from "@/lib/transcribe";
import { transcribeAudio } from "@/lib/ai-features";
import { resolveEngine } from "@/lib/ai-engine";
import type { Engine } from "@/lib/article-ai";
import { formatElapsed, joinTranscript, transcribeFinished } from "@/lib/voice-session";
import { ArchiveCard } from "@/components/archive-card";
import { recoverPendingSongs, saveRecordedSong } from "@/lib/songs";
import { syncSongAudio } from "@/lib/song-drive";

export const Route = createFileRoute("/")({
  // `?record=<nonce>` is the bottom navigation's "open the recorder" signal:
  // each tap sends a fresh nonce so repeated taps retrigger the effect below.
  // `&section=medical` rides along from the «القسم الطبي» capture buttons:
  // the recorder opens in medical context and everything it saves is born
  // inside the medical section.
  validateSearch: (search: Record<string, unknown>): { record?: number; section?: "medical" } => {
    const raw = search["record"];
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return {
      ...(Number.isFinite(value) && value > 0 ? { record: value } : {}),
      ...(search["section"] === "medical" ? { section: "medical" as const } : {}),
    };
  },
  head: () => ({
    meta: [
      { title: "أفكاري — سجّل فكرتك" },
      { name: "description", content: "سجّل أفكارك بالصوت أو الكتابة لتتحول إلى مقالات مبوبة." },
      { property: "og:title", content: "أفكاري — سجّل فكرتك" },
      {
        property: "og:description",
        content: "سجّل أفكارك بالصوت أو الكتابة لتتحول إلى مقالات مبوبة.",
      },
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
  const { record, section } = Route.useSearch();
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
  // Medical context: set only by the «القسم الطبي» capture deep link. While
  // it is up, the form shows a «القسم الطبي» chip and an IDEA saved from
  // this session is created medical. Song mode is unaffected — a song is
  // never a medical article, whatever context the form was opened in.
  const [medicalCtx, setMedicalCtx] = useState(false);
  // The home doors to the medical section and the songs section, with
  // their counts — each section is a world of its own off this screen.
  const [medicalCount, setMedicalCount] = useState(
    () => partitionIdeas(loadVisibleIdeas()).medical.length,
  );
  const [songsCount, setSongsCount] = useState(
    () => partitionIdeas(loadVisibleIdeas()).songs.length,
  );
  useEffect(() => {
    const recount = () => {
      const parts = partitionIdeas(loadVisibleIdeas());
      setMedicalCount(parts.medical.length);
      setSongsCount(parts.songs.length);
    };
    recount();
    window.addEventListener("afkari:ideas-changed", recount);
    window.addEventListener("storage", recount);
    return () => {
      window.removeEventListener("afkari:ideas-changed", recount);
      window.removeEventListener("storage", recount);
    };
  }, []);
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
  // with replace so re-renders and the back button don't reopen it. The
  // medical capture buttons send the same nonce plus `section=medical`,
  // which additionally raises the medical context for this session.
  useEffect(() => {
    // The router merges raw URL params into the match search, so a hand-typed
    // junk value can arrive here as a string despite the declared type —
    // only a positive number (the nonce the bottom nav sends) may open it.
    if (typeof record !== "number" || !Number.isFinite(record) || record <= 0) return;
    setOpen(true);
    setMedicalCtx(section === "medical");
    navigate({ to: "/", search: {}, replace: true });
  }, [record, section, navigate]);

  // Recording runs until the user presses stop (see createVoiceRecorder).
  const textRef = useRef("");
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  useEffect(
    () => () => {
      recRef.current?.cancel();
    },
    [],
  );
  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (drainTimerRef.current) clearInterval(drainTimerRef.current);
      // Release the microphone; the audio saved so far stays on the phone for the resume pass.
      void audioRef.current?.stop().catch(() => {});
    },
    [],
  );

  // Recordings left on the phone by an earlier session (their transcription was
  // interrupted) become ideas on a later open — the pipeline's resume pass.
  useEffect(() => {
    const resume = async () => {
      if (resumedRef.current) return;
      resumedRef.current = true;
      try {
        const engine = await resolveEngine();
        if (typeof engine === "string") {
          resumedRef.current = false;
          return;
        }
        const made = await processPending(
          voiceStore(),
          engine,
          new AbortController().signal,
          "",
          (t) => {
            pushIdea(saveIdea(t));
          },
        );
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
          void syncSongAudio().catch(() => {});
          setMsg("تمت استعادة أغنية مسجلة على هاتفك ✓");
          // No lyrics pass here: words are extracted only when he asks,
          // from the song's own editor button.
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
      const texts = await transcribeFinished(voiceStore(), session, (audio) =>
        transcribeAudio(audio, { engine }),
      );
      if (texts.length) setTextBoth((cur) => joinTranscript(cur, texts.join(" ")));
    } catch {
      // A failed piece keeps no text and is retried by the stop pass, which reports it.
    } finally {
      drainBusyRef.current = false;
    }
  };
  const startDrain = () => {
    if (drainTimerRef.current) clearInterval(drainTimerRef.current);
    drainTimerRef.current = setInterval(() => {
      void drainOnce();
    }, 5000);
  };
  const stopDrain = () => {
    if (drainTimerRef.current) {
      clearInterval(drainTimerRef.current);
      drainTimerRef.current = null;
    }
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
      const full = await transcribeSession(
        voiceStore(),
        session,
        engine,
        ctrl.signal,
        (blob, _mime, eng, signal) => transcribeAudio(blob, { engine: eng, signal }),
      );
      setTextBoth(joinTranscript(baseTextRef.current, full));
      await deleteSession(voiceStore(), session);
      sessionRef.current = "";
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setMsg(
          e instanceof Error
            ? e.message
            : "تعذّر تحويل الصوت إلى نص الآن. التسجيل محفوظ على هاتفك.",
        );
      }
      // The audio stays in the store: the resume pass turns it into an idea later.
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
      setTranscribing(false);
    }
  };

  // After stop in song mode: assemble the session into one audio file and
  // save it as a song. The recording itself is the result; if assembly
  // fails the segments stay in the song store and the recovery pass above
  // saves the song on a later open. Nothing transcribes it — the sung
  // words are written onto the song only when he asks, from the song's
  // own editor button in «الأغاني».
  const finishSong = async (session: string, durationSeconds: number) => {
    if (!session) return;
    try {
      const idea = await saveRecordedSong({ store: songVoiceStore(), session, durationSeconds });
      sessionRef.current = "";
      if (idea) {
        pushIdea(idea);
        void syncSongAudio().catch(() => {});
        setOpen(false);
        setMsg("حُفظت أغنيتك بصوتك ✓ — ستجدها في قسم الأغاني، ويمكنك إضافة كلماتها من هناك");
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
      if (kind === "song") {
        await finishSong(session, duration);
        return;
      }
      await finishTranscription(session);
      return;
    }
    if (recRef.current?.isRecording()) await recRef.current.stop();
  };
  const runStop = () => {
    const p = stopActive();
    stopPromiseRef.current = p;
    void p.finally(() => {
      if (stopPromiseRef.current === p) stopPromiseRef.current = null;
    });
    return p;
  };

  const toggleMic = async () => {
    if (transcribing) return;
    if (listening) {
      await runStop();
      return;
    }
    // Primary path: record the microphone itself (MediaRecorder). There is no
    // recognition session for Android to kill, so recording runs until «إيقاف».
    // Song mode records into its own store and never starts the transcription
    // drain; idea mode is exactly as before.
    const kind = recMode;
    const deps = browserRecorderDeps(kind === "song" ? songVoiceStore() : voiceStore());
    if (deps) {
      recRef.current?.cancel();
      baseTextRef.current = textRef.current;
      const rec = createAudioRecorder(
        { ...deps, segmentMs: 60_000 },
        {
          onRecording: setListening,
          onMessage: setMsg,
          onElapsed: (s) => {
            elapsedRef.current = s;
            setElapsed(s);
          },
        },
      );
      audioRef.current = rec;
      modeRef.current = "media";
      recKindRef.current = kind;
      setElapsed(0);
      elapsedRef.current = 0;
      setMediaMode(true);
      const ok = await rec.start();
      if (!ok) {
        // mic refused — MIC_DENIED was already shown
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
    if (kind === "song") {
      setMsg(NO_RECORDING);
      return;
    }
    // Fallback: the browser's speech recognition, as before.
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setMsg("التسجيل الصوتي غير متاح على هذا الجهاز، اكتب فكرتك.");
      return;
    }
    recRef.current?.cancel();
    recRef.current = createVoiceRecorder(SR, {
      onText: (s) =>
        setText((t) => {
          const n = (t + " " + s).trim();
          textRef.current = n;
          return n;
        }),
      onListening: setListening,
      onMessage: setMsg,
    });
    recRef.current.start();
  };

  const save = async () => {
    if (stopPromiseRef.current) await stopPromiseRef.current;
    // In song mode there is no text to save: stopping the recording saves
    // the song itself (see finishSong).
    if (recMode === "song") {
      if (listening) await runStop();
      return;
    }
    if (listening) await runStop();
    const body = textRef.current.trim();
    if (!body) return;
    const idea = saveIdea(body, medicalCtx ? { medical: true } : undefined);
    textRef.current = "";
    setText("");
    setOpen(false);
    setMedicalCtx(false);
    setMsg(medicalCtx ? "حُفظت الفكرة في القسم الطبي ✓" : "حُفظت الفكرة ✓");
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
      setMedicalCtx(false);
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
        await Promise.all(
          segs.filter((s) => s.transcript !== undefined).map((s) => store.deleteSegment(s.id)),
        );
      }
      sessionRef.current = "";
    } else {
      recRef.current?.cancel();
    }
    // Leaving the recorder clears the medical context with it: the next
    // session starts general unless it arrives through the section again.
    setOpen(false);
    setMedicalCtx(false);
  };

  return (
    <main
      dir="rtl"
      className="paper flex min-h-screen flex-col items-center justify-center gap-10 px-6 pb-24"
    >
      <h1 className="font-display text-4xl text-foreground">أفكاري</h1>
      {!open ? (
        <button
          onClick={() => {
            setMedicalCtx(false);
            setOpen(true);
          }}
          className="record-btn"
        >
          سجّل فكرة
        </button>
      ) : (
        <div className="w-full max-w-md space-y-4">
          <div
            className="flex rounded-lg border border-border bg-muted/30 p-1"
            role="group"
            aria-label="وضع التسجيل"
          >
            <button
              type="button"
              aria-pressed={recMode === "idea"}
              disabled={listening || transcribing}
              onClick={() => setRecMode("idea")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition-all disabled:opacity-50 ${recMode === "idea" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Mic className="size-4" />
              فكرة
            </button>
            <button
              type="button"
              aria-pressed={recMode === "song"}
              disabled={listening || transcribing}
              onClick={() => setRecMode("song")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-sm font-medium transition-all disabled:opacity-50 ${recMode === "song" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              <Music className="size-4" />
              أغنية
            </button>
          </div>
          {medicalCtx && recMode === "idea" && (
            <p className="flex items-center justify-center gap-1.5 text-center text-sm font-medium text-primary">
              <Stethoscope className="size-4" />
              القسم الطبي — الفكرة دي هتتحفظ في القسم الطبي
            </p>
          )}
          {recMode === "idea" ? (
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder="اكتب أو تكلم..."
              className="w-full rounded-2xl border border-border bg-card p-4 text-lg leading-relaxed text-card-foreground outline-none focus:ring-2 focus:ring-ring"
            />
          ) : (
            <p className="rounded-2xl border border-border bg-card p-4 text-center leading-relaxed text-muted-foreground">
              غنِّ أغنيتك كاملة — ستُحفظ بصوتك كما هي، من غير أن تتحول إلى نص. الكلمات يمكنك إضافتها
              لاحقًا من المكتبة.
            </p>
          )}
          {listening && (
            <p className="text-center text-sm text-destructive">
              ● جاري التسجيل…
              {mediaMode && (
                <>
                  {" "}
                  <span dir="ltr">{formatElapsed(elapsed)}</span> —
                </>
              )}{" "}
              لن يتوقف إلا بضغطك على «إيقاف التسجيل»
            </p>
          )}
          {transcribing && (
            <p className="text-center text-sm text-muted-foreground">جارٍ تحويل الصوت إلى نص…</p>
          )}
          <div className="flex gap-3">
            <button
              onClick={toggleMic}
              disabled={transcribing}
              aria-pressed={listening}
              className={`inline-flex flex-1 items-center justify-center gap-2 rounded-full py-3 font-semibold ${listening ? "bg-destructive text-destructive-foreground animate-pulse" : "bg-secondary text-secondary-foreground"}`}
            >
              {listening ? <Square className="size-5" /> : <Mic className="size-5" />}
              {transcribing ? "جارٍ التحويل…" : listening ? "إيقاف التسجيل" : "ابدأ التسجيل"}
            </button>
            {recMode === "idea" && (
              <button
                onClick={save}
                className="flex-1 rounded-full bg-primary py-3 font-semibold text-primary-foreground"
              >
                حفظ
              </button>
            )}
          </div>
          <button onClick={cancel} className="w-full text-sm text-muted-foreground">
            إلغاء
          </button>
        </div>
      )}
      {!open && (
        <Link
          to="/medical"
          className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 text-start shadow-sm transition-colors hover:bg-accent"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Stethoscope className="size-6" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-lg text-foreground">القسم الطبي</span>
            <span className="block text-sm text-muted-foreground">
              {medicalCount > 0
                ? `${medicalCount} ${medicalCount === 1 ? "مقالة طبية" : "مقالات طبية"} في قسم مستقل`
                : "قسم مستقل لمقالاتك الطبية"}
            </span>
          </span>
          <ChevronLeft className="size-5 shrink-0 text-muted-foreground" />
        </Link>
      )}
      {/* The songs door: songs live in their own section now, never in the
          article library — this card appears once a first song exists. */}
      {!open && songsCount > 0 && (
        <Link
          to="/songs"
          className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 text-start shadow-sm transition-colors hover:bg-accent"
        >
          <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Music className="size-6" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-display text-lg text-foreground">الأغاني</span>
            <span className="block text-sm text-muted-foreground">{`${songsCount} ${songsCount === 1 ? "أغنية مسجلة" : "أغاني مسجلة"} في قسم مستقل`}</span>
          </span>
          <ChevronLeft className="size-5 shrink-0 text-muted-foreground" />
        </Link>
      )}
      {!open && <ArchiveCard />}
      {msg && <p className="text-center text-sm text-muted-foreground">{msg}</p>}
      {cloud === "on" ? (
        <p className="text-center text-sm text-muted-foreground">☁️ أفكارك محفوظة في السحابة</p>
      ) : cloud === "syncing" ? (
        <p className="text-center text-sm text-muted-foreground">☁️ جاري مزامنة أفكارك...</p>
      ) : (
        <Link to="/auth" className="text-center text-sm text-primary underline">
          ☁️ فعّل الحفظ في السحابة
        </Link>
      )}
    </main>
  );
}
