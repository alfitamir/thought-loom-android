import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { saveIdea } from "@/lib/ideas";
import { supabase } from "@/integrations/supabase/client";
import { pushIdea, syncNow } from "@/lib/sync";
import { createVoiceRecorder, type VoiceRecorder } from "@/lib/voice-recorder";

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

function Index() {
  const { record } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [listening, setListening] = useState(false);
  const [msg, setMsg] = useState("");
  const [cloud, setCloud] = useState<"off" | "on" | "syncing">("off");
  const recRef = useRef<VoiceRecorder | null>(null);

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

  const toggleMic = async () => {
    if (recRef.current?.isRecording()) { await recRef.current.stop(); return; }
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
    if (recRef.current?.isRecording()) await recRef.current.stop();
    const body = textRef.current.trim();
    if (!body) return;
    const idea = saveIdea(body);
    textRef.current = "";
    setText(""); setOpen(false); setMsg("حُفظت الفكرة ✓");
    pushIdea(idea);
  };

  const cancel = () => { recRef.current?.cancel(); setOpen(false); };

  return (
    <main dir="rtl" className="paper flex min-h-screen flex-col items-center justify-center gap-10 px-6 pb-24">
      <h1 className="font-display text-4xl text-foreground">أفكاري</h1>
      {!open ? (
        <button onClick={() => setOpen(true)} className="record-btn">سجّل فكرة</button>
      ) : (
        <div className="w-full max-w-md space-y-4">
          <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={8}
            placeholder="اكتب أو تكلم..." className="w-full rounded-2xl border border-border bg-card p-4 text-lg leading-relaxed text-card-foreground outline-none focus:ring-2 focus:ring-ring" />
          {listening && <p className="text-center text-sm text-destructive">● جاري التسجيل… لن يتوقف إلا بضغطك على «إيقاف التسجيل»</p>}
          <div className="flex gap-3">
            <button onClick={toggleMic} aria-pressed={listening} className={`flex-1 rounded-full py-3 font-semibold ${listening ? "bg-destructive text-destructive-foreground animate-pulse" : "bg-secondary text-secondary-foreground"}`}>
              {listening ? "■ إيقاف التسجيل" : "🎙 ابدأ التسجيل"}
            </button>
            <button onClick={save} className="flex-1 rounded-full bg-primary py-3 font-semibold text-primary-foreground">حفظ</button>
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
