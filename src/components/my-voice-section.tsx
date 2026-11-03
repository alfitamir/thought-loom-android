import { useEffect, useRef, useState } from "react";
import { Mic, Square, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getGeminiKey } from "@/lib/gemini";
import { MIC_DENIED, pickMime } from "@/lib/audio-recorder";
import {
  blobToWav24k, clearMyVoiceProfile, CONSENT_STATEMENT_AR, createMyVoice, deleteMyVoice,
  getMyVoiceProfile, MAX_SAMPLE_SECONDS, MIN_SAMPLE_SECONDS, prepareUploadedAudio, READING_SAMPLE_AR,
  sampleDurationState, saveMyVoiceProfile, type MyVoiceProfile,
} from "@/lib/my-voice";

type Clip = { blob: Blob; seconds: number; url: string; trimmed?: boolean };
type RecordingKind = "sample" | "consent";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * Settings section «صوتي»: create the user's replicated voice from two
 * short recordings — a natural reading sample (10–30s) and the verbatim
 * consent statement Google requires — then articles can be read aloud in
 * his own voice from «استمع». Only the returned voice id is kept on the
 * phone; the recordings go to Google once, at creation, and are discarded.
 */
export function MyVoiceSection() {
  const [profile, setProfile] = useState<MyVoiceProfile | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [sample, setSample] = useState<Clip | null>(null);
  const [consent, setConsent] = useState<Clip | null>(null);
  const [recording, setRecording] = useState<RecordingKind | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const sampleFileRef = useRef<HTMLInputElement | null>(null);
  const consentFileRef = useRef<HTMLInputElement | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedRef = useRef(0);
  const kindRef = useRef<RecordingKind>("sample");
  const sampleRef = useRef<Clip | null>(null);
  const consentRef = useRef<Clip | null>(null);
  sampleRef.current = sample;
  consentRef.current = consent;

  useEffect(() => {
    setProfile(getMyVoiceProfile());
    setHasKey(!!getGeminiKey());
    const update = () => { setProfile(getMyVoiceProfile()); setHasKey(!!getGeminiKey()); };
    window.addEventListener("afkari:settings-changed", update);
    return () => window.removeEventListener("afkari:settings-changed", update);
  }, []);

  // Elapsed timer + auto-stop at the sample window's upper bound.
  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const s = Math.floor((Date.now() - startedRef.current) / 1000);
      setElapsed(s);
      if (s >= MAX_SAMPLE_SECONDS) stopRecording();
    }, 250);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (sampleRef.current) URL.revokeObjectURL(sampleRef.current.url);
    if (consentRef.current) URL.revokeObjectURL(consentRef.current.url);
  }, []);

  const startRecording = async (kind: RecordingKind) => {
    setError(""); setMsg("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("التسجيل الصوتي غير متاح على هذا الجهاز.");
      return;
    }
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      setError(MIC_DENIED);
      return;
    }
    const mime = pickMime((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(streamRef.current, {
      ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 128000,
    });
    chunksRef.current = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunksRef.current.push(e.data); };
    rec.onstop = () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const seconds = Math.max(1, Math.round((Date.now() - startedRef.current) / 1000));
      const blob = new Blob(chunksRef.current, { type: mime || "audio/webm" });
      const clip: Clip = { blob, seconds, url: URL.createObjectURL(blob) };
      const prev = kindRef.current === "sample" ? sampleRef.current : consentRef.current;
      if (prev) URL.revokeObjectURL(prev.url);
      if (kindRef.current === "sample") setSample(clip); else setConsent(clip);
      setRecording(null);
    };
    recorderRef.current = rec;
    kindRef.current = kind;
    startedRef.current = Date.now();
    setElapsed(0);
    setRecording(kind);
    rec.start(250);
  };

  const stopRecording = () => {
    try { recorderRef.current?.stop(); } catch { setRecording(null); }
  };

  /**
   * An uploaded file as a take: the same decode → 24 kHz mono WAV
   * conversion as a recording (see prepareUploadedAudio), so the clip
   * that reaches «إنشاء صوتي» is indistinguishable from a recorded one —
   * playback check included. A long reference file keeps its first 30s.
   */
  const onFile = async (kind: RecordingKind, file: File | undefined) => {
    if (!file) return;
    setError(""); setMsg("");
    try {
      const prep = await prepareUploadedAudio(file, kind === "sample");
      const blob = new Blob([prep.wav.buffer as ArrayBuffer], { type: "audio/wav" });
      const clip: Clip = { blob, seconds: prep.seconds, url: URL.createObjectURL(blob), trimmed: prep.trimmed };
      const prev = kind === "sample" ? sampleRef.current : consentRef.current;
      if (prev) URL.revokeObjectURL(prev.url);
      if (kind === "sample") setSample(clip); else setConsent(clip);
    } catch {
      setError("تعذّرت قراءة الملف الصوتي — جرّب ملفًا آخر (mp3 أو wav أو m4a).");
    }
  };

  const sampleState = sample ? sampleDurationState(sample.seconds) : null;
  const canCreate = !!sample && sampleState === "ok" && !!consent && hasKey && !creating;

  const create = async () => {
    if (!sample || !consent) return;
    const key = getGeminiKey();
    if (!key) { setError("أضف مفتاح Gemini أعلاه أولًا."); return; }
    setCreating(true); setError(""); setMsg("جارٍ إنشاء صوتك… تُرسل التسجيلتان إلى Google للتحقق من الموافقة وإنشاء الصوت.");
    try {
      const [sourceWav, consentWav] = await Promise.all([blobToWav24k(sample.blob), blobToWav24k(consent.blob)]);
      const voiceId = await createMyVoice(key, sourceWav, consentWav);
      setProfile(saveMyVoiceProfile(voiceId));
      if (sampleRef.current) URL.revokeObjectURL(sampleRef.current.url);
      if (consentRef.current) URL.revokeObjectURL(consentRef.current.url);
      setSample(null); setConsent(null);
      setMsg("صار صوتك جاهزًا ✓ من «استمع» في أي مقال اختر «صوتي» لتسمعه بصوتك.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذّر إنشاء الصوت الآن.");
      setMsg("");
    } finally {
      setCreating(false);
    }
  };

  const remove = async () => {
    const key = getGeminiKey();
    if (profile && key) await deleteMyVoice(key, profile.voiceId);
    clearMyVoiceProfile();
    setProfile(null);
    setMsg("حُذف صوتك من هذا الهاتف ومن Google.");
    setError("");
  };

  const recordRow = (kind: RecordingKind, clip: Clip | null) => (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {recording === kind ? (
          <Button variant="outline" className="[&_svg]:size-5" onClick={stopRecording}>
            <Square />إيقاف ({fmt(elapsed)})
          </Button>
        ) : (
          <Button variant="outline" className="[&_svg]:size-5" onClick={() => void startRecording(kind)} disabled={recording !== null || creating}>
            <Mic />{clip ? "إعادة التسجيل" : "تسجيل"}
          </Button>
        )}
        {recording !== kind && (
          <>
            <Button
              variant="outline" className="[&_svg]:size-5" disabled={recording !== null || creating}
              onClick={() => (kind === "sample" ? sampleFileRef : consentFileRef).current?.click()}
            >
              <Upload />رفع ملف صوتي
            </Button>
            <input
              ref={kind === "sample" ? sampleFileRef : consentFileRef}
              type="file" accept="audio/*" className="hidden"
              onChange={(e) => { void onFile(kind, e.target.files?.[0]); e.target.value = ""; }}
            />
          </>
        )}
        {clip && recording !== kind && <span className="text-xs text-muted-foreground">المدة: {fmt(clip.seconds)}</span>}
      </div>
      {clip?.trimmed && (
        <p className="text-xs text-muted-foreground">الملف أطول من {MAX_SAMPLE_SECONDS} ثانية — هنستخدم أول {MAX_SAMPLE_SECONDS} ثانية بس.</p>
      )}
      {kind === "consent" && (
        <p className="text-xs text-muted-foreground">سواء سجّلت أو رفعت ملفًا: لازم يكون بصوتك إنت، وبتقول فيه الجملة اللي فوق بالنص.</p>
      )}
      {clip && recording !== kind && <audio src={clip.url} controls className="w-full" />}
    </div>
  );

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center gap-2">
        <Mic className="size-5 text-primary" />
        <h3 className="font-display text-lg">صوتي</h3>
        <span className={`ms-auto text-xs ${profile ? "text-primary" : "text-muted-foreground"}`}>
          {profile ? "جاهز" : "غير مُعدّ"}
        </span>
      </div>
      {profile ? (
        <>
          <p className="text-sm text-muted-foreground">
            صوتك المُستنسخ جاهز منذ {new Date(profile.createdAt).toLocaleDateString("ar-EG", { dateStyle: "medium" })}.
            من «استمع» في أي مقال، اختر «صوتي» لتوليد القراءة بصوتك ومشاركتها.
          </p>
          <p className="text-sm text-muted-foreground">
            لو الصوت مش شبهك، امسحه وسجّل من جديد بالإرشادات دي — جودة العيّنة هي أكبر عامل.
          </p>
          <Button variant="ghost" className="text-destructive [&_svg]:size-5" onClick={() => void remove()}>
            <Trash2 />حذف صوتي
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-muted-foreground">
            سجّل عيّنة قصيرة من قراءتك، وسيقرأ Gemini مقالاتك بصوتك أنت بدل الصوت الافتراضي.
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            تُرسل التسجيلتان إلى Google لإنشاء الصوت والتحقق من الموافقة، وفق شروط حسابك في Google AI — ولا يبقى منهما شيء على هذا الهاتف بعد الإنشاء.
          </p>
          {!hasKey && (
            <p className="text-sm text-muted-foreground">أضف مفتاح Gemini أعلاه أولًا — إنشاء الصوت يتم بمفتاحك.</p>
          )}
          <div className="space-y-1 rounded-lg bg-muted/40 px-3 py-2">
            <p className="text-sm font-medium">لأقرب شبه لصوتك الحقيقي</p>
            <ul className="list-disc space-y-0.5 ps-4 text-xs leading-relaxed text-muted-foreground">
              <li>أوضة هادية وباب مقفول، بعيد عن أي دوشة.</li>
              <li>الموبايل على بعد ٢٠–٣٠ سم من بقك.</li>
              <li>اتكلم طبيعي بلهجتك، كأنك بتشرح لصاحبك — مش قراءة رسمية.</li>
              <li>نوّع نبرتك: كلام عادي، وسؤال، وتأكيد على كلمة مهمة.</li>
              <li>كمّل لآخر الوقت المتاح (٣٠ ثانية) — كل ثانية زيادة بتفرق.</li>
              <li>التسجيلان بنفس الميكروفون وفي نفس المكان.</li>
            </ul>
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-medium">١. عيّنة القراءة ({MIN_SAMPLE_SECONDS}–{MAX_SAMPLE_SECONDS} ثانية)</h4>
            <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm leading-loose">{READING_SAMPLE_AR}</p>
            <p className="text-xs text-muted-foreground">اقرأ النص بصوتك الطبيعي في مكان هادئ، وبالميكروفون نفسه الذي ستسجل به الموافقة.</p>
            {recordRow("sample", sample)}
            {sampleState === "short" && <p className="text-xs text-destructive">العيّنة أقصر من {MIN_SAMPLE_SECONDS} ثوانٍ — أعد التسجيل واقرأ النص كاملًا.</p>}
            {sampleState === "ok" && <p className="text-xs text-primary">العيّنة مناسبة ✓</p>}
          </div>
          <div className="space-y-2">
            <h4 className="text-sm font-medium">٢. الموافقة (اقرأها كما هي تمامًا)</h4>
            <p className="rounded-lg bg-muted/40 px-3 py-2 text-sm leading-loose">{CONSENT_STATEMENT_AR}</p>
            {recordRow("consent", consent)}
          </div>
          <Button className="[&_svg]:size-5" onClick={() => void create()} disabled={!canCreate}>
            <Mic />إنشاء صوتي
          </Button>
        </>
      )}
      {msg && <p role="status" className="break-words text-sm text-muted-foreground">{msg}</p>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    </section>
  );
}
