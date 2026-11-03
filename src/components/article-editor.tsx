import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, ChevronDown, Copy, Download, Facebook, Heart, HelpCircle, ListPlus, Lock, Merge, Music, Pencil, Play, PlusCircle, Quote, RefreshCw, Share2, ShieldAlert, Sparkles, Square, Trash2, Volume2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EvidenceDialog } from "@/components/evidence-dialog";
import { ManualMergeDialog } from "@/components/manual-merge-dialog";
import { getArticleEnrichment, getFacebookPost, type ArticleEnrichment } from "@/lib/ai-features";
import { HighlightedText } from "@/components/highlighted-text";
import { countOccurrences } from "@/lib/search-highlight";
import { articleTopic, clearArticleTopic, getArticle, loadIdeas, setArticleTopic, topicOptions, updateArticle, updateSong, type Idea } from "@/lib/ideas";
import { pushIdea } from "@/lib/sync";
import { improveFull } from "@/lib/article-ai";
import { resolveEngine } from "@/lib/ai-engine";
import { getGeminiKey } from "@/lib/gemini";
import { blobToBytes, concatPcm, createTtsSession, GEMINI_TTS_VOICE, mapWithConcurrency, modelForVoiceKey, pcmToWav, speakWithDevice, splitForSpeech, synthesizeGeminiChunkWithModel, toSpeechText, type DeviceSpeech, type TtsEngine } from "@/lib/tts";
import { audioFileName, deleteArticleAudioForVoice, findCachedAudioForVoice, getAudioChunk, getSongAudio, PCM_CHUNK_MIME, saveAudioChunk, saveAudioManifest, type ArticleAudioRecord, type ChunkedAudioManifest, type SongAudioRecord } from "@/lib/article-audio";
import { effectiveListenVoice, getMyVoiceProfile, isMyVoicePublic } from "@/lib/my-voice";
import { deriveSongAudioState, songDurationLabel, songRecordedLabel } from "@/lib/songs";
import { downloadSongAudio } from "@/lib/song-drive";
import { applySongLyrics, decideLyricsApplication, isSongLyricsPending, onSongLyricsPendingChange, transcribeSong } from "@/lib/song-lyrics";

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Arabic reading-time label at ~180 words per minute, with plural agreement. */
const readingTimeLabel = (text: string) => {
  const mins = Math.max(1, Math.round(countWords(text) / 180));
  if (mins === 1) return "قراءة دقيقة";
  if (mins === 2) return "قراءة دقيقتان";
  if (mins <= 10) return `قراءة ${mins} دقائق`;
  return `قراءة ${mins} دقيقة`;
};

export function ArticleEditor({ idea, topic, online, onChange, onDelete, searchQuery, matchStartIndex, currentMatchIndex, hasAudio }: {
  idea: Idea; topic?: string; online: boolean; onChange: () => void; onDelete: () => void;
  /** True when this device holds generated audio for the article (the library
   *  computes the set once per load); shows the «صوت» badge by the topic chip. */
  hasAudio?: boolean;
  /** Active library search: highlight occurrences in view mode. matchStartIndex is this
   *  article's first global match index (title matches come before body matches). */
  searchQuery?: string | undefined; matchStartIndex?: number | undefined; currentMatchIndex?: number | null | undefined;
}) {
  const article = getArticle(idea);
  const isSong = !!idea.song;
  const isLiked = !!idea.liked;
  const durationLabel = songDurationLabel(idea);
  const hlQuery = searchQuery?.trim() ? searchQuery : "";
  const bodyMatchStart = (matchStartIndex ?? 0) + (hlQuery ? countOccurrences(article.title, hlQuery) : 0);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(article.title);
  const [body, setBody] = useState(article.body);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState("");
  const [suggestion, setSuggestion] = useState<{ title: string; body: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Enrichment (Additions, Quotes, and Questions) state
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [enrichBusy, setEnrichBusy] = useState(false);
  const [enrichment, setEnrichment] = useState<ArticleEnrichment | null>(null);
  const [enrichTab, setEnrichTab] = useState<"additions" | "quotes" | "questions">("quotes");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  // Facebook post suggestion state (one post, copy-only; cached while the editor stays open)
  const [fbOpen, setFbOpen] = useState(false);
  const [fbBusy, setFbBusy] = useState(false);
  const [fbPost, setFbPost] = useState<string | null>(null);
  const [fbVariation, setFbVariation] = useState(0);
  const [fbError, setFbError] = useState("");
  const [fbStatus, setFbStatus] = useState("");
  const [listenOpen, setListenOpen] = useState(false);
  // Manual topic picker state (the new-topic draft lives here, not in the dialog)
  const [topicOpen, setTopicOpen] = useState(false);
  const [newTopic, setNewTopic] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const version = useRef(idea.updatedAt ?? 0);
  useEffect(() => () => abort.current?.abort(), []);

  const save = (newTitle: string, newBody: string, polished = false) => {
    const updated = updateArticle(idea.id, newTitle, newBody, polished);
    if (!updated) return;
    onChange();
    void pushIdea(updated).catch(() => {});
    setEditing(false); setPreviewOpen(false); setSuggestion(null); setMessage("حُفظ المقال ✓");
  };
  const chooseTopic = (name: string) => {
    const before = topic;
    const updated = setArticleTopic(idea.id, name);
    setTopicOpen(false);
    if (!updated) return;
    onChange();
    void pushIdea(updated).catch(() => {});
    if (articleTopic(updated) !== before) setMessage(`نُقل المقال إلى تصنيف «${articleTopic(updated)}» وضُبط يدويًا ✓`);
  };
  const unlockTopic = () => {
    const updated = clearArticleTopic(idea.id);
    setTopicOpen(false);
    if (!updated) return;
    onChange();
    void pushIdea(updated).catch(() => {});
    setMessage("أُلغي الضبط اليدوي؛ سيعود المقال إلى التصنيف التلقائي ✓");
  };
  const share = async () => {
    setMessage("");
    const full = `${article.title}\n\n${article.body}`;
    const copy = async () => {
      if (navigator.clipboard) { await navigator.clipboard.writeText(full); setMessage("نُسخ المقال كاملًا للمشاركة ✓"); }
      else setMessage("النسخ غير متاح هنا؛ يمكنك تحديد نص المقال ونسخه.");
    };
    try {
      if (navigator.share) await navigator.share({ text: full });
      else await copy();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      await copy().catch(() => setMessage("تعذّرت المشاركة الآن."));
    }
  };
  const improve = async () => {
    setMessage("");
    if (!navigator.onLine) { setMessage("تحسين المقال يحتاج اتصالًا بالإنترنت."); return; }
    const engine = await resolveEngine();
    if (typeof engine === "string") { setMessage(engine); return; }
    const controller = new AbortController(); abort.current = controller;
    version.current = idea.updatedAt ?? 0;
    setPreview(""); setSuggestion(null); setPreviewOpen(true); setBusy(true);
    try {
      // Style samples are the author's own voice: liked articles are other
      // people's writing and never stand in for it.
      const samples = loadIdeas().filter((i) => i.id !== idea.id && !i.liked).slice(0, 3).map((i) => i.text.slice(0, 2000));
      setSuggestion(await improveFull(article, idea.text, samples, engine, controller.signal, setPreview));
    } catch (error) {
      setMessage(controller.signal.aborted ? "توقف التحسين؛ مقالك لم يتغير." : error instanceof Error ? error.message : "تعذّر الاتصال بخدمة تحسين المقالات.");
    } finally { setBusy(false); abort.current = null; }
  };

  const openEnrichment = async () => {
    setMessage("");
    if (!navigator.onLine) { setMessage("اقتراح الإضافات يحتاج اتصالًا بالإنترنت."); return; }
    setEnrichOpen(true);
    if (enrichment) return;
    setEnrichBusy(true);
    try {
      const data = await getArticleEnrichment(article);
      setEnrichment(data);
    } catch (err: any) {
      setMessage(err?.message || "تعذّر جلب مقترحات الإثراء.");
      setEnrichOpen(false);
    } finally {
      setEnrichBusy(false);
    }
  };

  const loadFacebookPost = async (variation: number) => {
    setFbBusy(true);
    setFbError("");
    setFbStatus("");
    try {
      const post = await getFacebookPost(article, { variation });
      setFbPost(post);
      setFbVariation(variation);
    } catch (err: any) {
      setFbError(err?.message || "تعذّر إعداد المنشور المقترح.");
    } finally {
      setFbBusy(false);
    }
  };

  const openFacebook = () => {
    setMessage("");
    if (!navigator.onLine) { setMessage("اقتراح المنشور يحتاج اتصالًا بالإنترنت."); return; }
    setFbOpen(true);
    if (fbPost) return;
    void loadFacebookPost(0);
  };

  const copyFacebookPost = async () => {
    if (!fbPost) return;
    try {
      if (navigator.clipboard) { await navigator.clipboard.writeText(fbPost); setMessage("نُسخ المنشور ✓"); setFbStatus("نُسخ المنشور ✓"); }
      else setFbStatus("النسخ غير متاح هنا؛ يمكنك تحديد نص المنشور ونسخه.");
    } catch {
      setFbStatus("تعذّرت النسخ الآن.");
    }
  };

  const insertTextIntoArticle = (textToAppend: string, notice: string) => {
    const updatedBody = `${article.body.trim()}\n\n${textToAppend.trim()}`;
    save(article.title, updatedBody);
    setMessage(notice);
    setEnrichOpen(false);
  };

  return <article className="border-b border-border py-6 last:border-0">
    {editing ? <div className="space-y-3">
      <input aria-label="عنوان المقال" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-md border border-input bg-card px-3 py-2 font-display text-lg outline-none focus:ring-2 focus:ring-ring" />
      <textarea aria-label="نص المقال" value={body} onChange={(e) => setBody(e.target.value)} rows={10} className="w-full rounded-md border border-input bg-card p-3 font-article text-xl leading-loose outline-none focus:ring-2 focus:ring-ring" />
      <p className="text-xs text-muted-foreground">عدد الكلمات: {countWords(body)}</p>
      <div className="flex gap-2">
        <Button onClick={() => save(title, body)} disabled={!title.trim() || !body.trim()}><Check />حفظ</Button>
        <Button variant="ghost" onClick={() => setEditing(false)}><X />إلغاء</Button>
      </div>
    </div> : <>
      <h2 className="break-words font-display text-xl text-primary">{hlQuery
        ? <HighlightedText text={article.title} query={hlQuery} startIndex={matchStartIndex} currentIndex={currentMatchIndex} />
        : article.title}</h2>
      {(topic || hasAudio || isSong || isLiked || idea.sources?.length) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {isSong && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
              <Music className="size-3.5" />أغنية{durationLabel && <> · <span dir="ltr">{durationLabel}</span></>}
            </span>
          )}
          {isLiked && (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium text-rose-600 dark:text-rose-400">
              <Heart className="size-3.5" />أعجبني
            </span>
          )}
          {(idea.sources ?? []).map((s) => (
            <span key={s} className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground" title={`يتضمن مقالًا من: ${s}`}>
              يتضمن مقالًا من: {s}
            </span>
          ))}
          {topic && (
            <button type="button" aria-label={`التصنيف: ${topic} — تغيير التصنيف`} title="تغيير التصنيف"
              onClick={() => { setNewTopic(""); setTopicOpen(true); }}
              className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground hover:opacity-80">
              التصنيف: {topic}
              {idea.topicManual && <Lock className="size-3" />}
              <Pencil className="size-3" />
            </button>
          )}
          {hasAudio && !isSong && <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground"><Volume2 className="size-3.5" />صوت</span>}
        </div>
      )}
      <p className="mb-1 mt-1 text-xs text-muted-foreground">{new Date(idea.createdAt).toLocaleDateString("ar")}{isSong
        ? (durationLabel && <> · <span dir="ltr">{durationLabel}</span></>)
        : <> · {readingTimeLabel(article.body)}</>}</p>
      {isLiked && <>
        {idea.source && <p className="mb-1 break-words text-sm text-foreground">المصدر: {idea.source}</p>}
        <p className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Lock className="size-3.5" />مقال من مصدر خارجي — الذكاء الاصطناعي لا يعدّله</p>
      </>}
      {isSong ? (
        <SongSection idea={idea} onChange={onChange} onDeleteRequest={() => setConfirmDelete(true)}
          hlQuery={hlQuery} bodyMatchStart={bodyMatchStart} currentMatchIndex={currentMatchIndex} />
      ) : <>
      {(() => {
        const flat = article.body.replace(/\s+/g, " ").trim();
        if (!flat) return null;
        const preview = flat.length > 90 ? `${flat.slice(0, 90)}…` : flat;
        // Visual highlight only: the preview echoes the body's opening, so its
        // marks carry no global index and navigation targets the body itself.
        return <p className="mb-4 line-clamp-1 text-sm text-muted-foreground">{hlQuery
          ? <HighlightedText text={preview} query={hlQuery} />
          : preview}</p>;
      })()}
      <p className="whitespace-pre-wrap break-words font-article text-xl leading-loose text-foreground">{hlQuery
        ? <HighlightedText text={article.body} query={hlQuery} startIndex={bodyMatchStart} currentIndex={currentMatchIndex} />
        : article.body}</p>
      <p className="mt-2 text-xs text-muted-foreground">عدد الكلمات: {countWords(article.body)}</p>
      {!isLiked && <div className="mt-4">
        <DropdownMenu dir="rtl">
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="أدوات ذكية" className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-medium text-foreground hover:bg-accent"><Sparkles className="size-5" />أدوات ذكية<ChevronDown className="size-4" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-52">
            <DropdownMenuItem aria-label="تحسين بالذكاء الاصطناعي" title={online ? "تحسين بالذكاء الاصطناعي" : "التحسين يحتاج الإنترنت"} disabled={!online || busy} onSelect={improve} className="[&>svg]:size-5"><Sparkles />تحسين</DropdownMenuItem>
            <DropdownMenuItem aria-label="شواهد من القرآن والسنة" title={online ? "شواهد من القرآن والسنة وكتب العلماء مع التحقق من النص" : "الشواهد تحتاج الإنترنت"} disabled={!online} onSelect={() => setEvidenceOpen(true)} className="[&>svg]:size-5"><BookOpen className="text-emerald-600" />شواهد</DropdownMenuItem>
            <DropdownMenuItem aria-label="اقتراحات واقتباسات للإثراء" title={online ? "اقتراحات واقتباسات من كبار المفكرين لتطوير المقال" : "الإثراء يحتاج الإنترنت"} disabled={!online || enrichBusy} onSelect={openEnrichment} className="[&>svg]:size-5"><ListPlus className="text-amber-500" />إثراء</DropdownMenuItem>
            <DropdownMenuItem aria-label="منشور فيسبوك" title={online ? "اقتراح منشور فيسبوك من هذا المقال" : "المنشور يحتاج الإنترنت"} disabled={!online || fbBusy} onSelect={openFacebook} className="[&>svg]:size-5"><Facebook className="text-[#1877F2]" />منشور فيسبوك</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="تعديل المقال" title="تعديل المقال" onClick={() => { setTitle(article.title); setBody(article.body); setEditing(true); setMessage(""); }}><Pencil /></Button>
        <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="استمع للمقال" title="استمع للمقال" onClick={() => setListenOpen(true)}><Volume2 /></Button>
        <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="مشاركة المقال" title="مشاركة المقال" onClick={share}><Share2 /></Button>
        <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="دمج يدوي مع مقال آخر" title="دمج يدوي مع مقال آخر (بدون ذكاء اصطناعي)" onClick={() => setMergeOpen(true)}><Merge /></Button>
        <Button variant="ghost" size="icon" className="ms-auto bg-destructive/10 text-destructive hover:bg-destructive/20 [&_svg]:size-5" aria-label="حذف المقال" title="حذف المقال" onClick={() => setConfirmDelete(true)}><Trash2 /></Button>
      </div>
      </>}
    </>}
    {message && <p role="status" className="mt-3 break-words text-sm text-muted-foreground">{message}</p>}
    {mergeOpen && <ManualMergeDialog idea={idea} onClose={(done) => { setMergeOpen(false); if (done) { onChange(); setMessage("دُمج المقالان يدويًا ✓"); } }} />}
    <ListenDialog open={listenOpen} onOpenChange={setListenOpen} articleId={idea.id} title={article.title} body={article.body} />
    <EvidenceDialog open={evidenceOpen} onOpenChange={setEvidenceOpen} title={article.title} body={article.body} online={online}
      onInsert={(snippet) => {
        const latest = loadIdeas().find((i) => i.id === idea.id);
        const current = latest ? getArticle(latest) : article;
        const updated = updateArticle(idea.id, current.title, `${current.body}\n\n${snippet}`);
        if (updated) { onChange(); void pushIdea(updated).catch(() => {}); setMessage("أُدرج الشاهد في نهاية المقال ✓"); }
      }} />
    {/* Intellectual Enrichment Dialog: Additions, Quotes, and Questions */}
    <Dialog open={enrichOpen} onOpenChange={setEnrichOpen}>
      <DialogContent dir="rtl" className="max-h-[88dvh] overflow-y-auto">
        <DialogTitle className="text-start font-display flex items-center gap-2">
          <ListPlus className="size-5 text-amber-500" />
          <span>تطوير وإثراء المقال بذكاء</span>
        </DialogTitle>
        <p className="text-xs text-muted-foreground">
          اقتراحات فكرية واقتباسات وأسئلة مستلهمة من فكر الكاتب ومراجعه الحضارية (مالك بن نبي، المسيري، ابن خلدون، ابن تيمية) لتعميق أطروحة المقال:
        </p>

        {enrichBusy ? (
          <div className="py-8 text-center space-y-3">
            <div className="inline-block size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">جارٍ استخراج الزوايا الفكرية والاقتباسات والأسئلة الكاشفة عبر Gemini…</p>
          </div>
        ) : enrichment ? (
          <div className="space-y-4">
            <div className="flex rounded-lg border border-border p-1 bg-muted/30">
              <button
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all flex items-center justify-center gap-1.5 ${enrichTab === "quotes" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setEnrichTab("quotes")}
              >
                <Quote className="size-3.5" />
                <span>اقتباسات ومراجع ({enrichment.quotes?.length || 0})</span>
              </button>
              <button
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all flex items-center justify-center gap-1.5 ${enrichTab === "additions" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setEnrichTab("additions")}
              >
                <PlusCircle className="size-3.5" />
                <span>زوايا فكرية ({enrichment.additions?.length || 0})</span>
              </button>
              <button
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all flex items-center justify-center gap-1.5 ${enrichTab === "questions" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                onClick={() => setEnrichTab("questions")}
              >
                <HelpCircle className="size-3.5" />
                <span>أسئلة كاشفة ({enrichment.questions?.length || 0})</span>
              </button>
            </div>

            {enrichTab === "quotes" && (
              <div className="space-y-3">
                <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
                  هذه الاقتباسات مولّدة بالذكاء الاصطناعي وغير موثّقة من المصادر — تحقق منها قبل الاستشهاد بها.
                </p>
                {enrichment.quotes?.length ? enrichment.quotes.map((q, idx) => (
                  <div key={idx} className="rounded-xl border border-border bg-card p-3.5 space-y-2">
                    <p className="font-article text-lg leading-relaxed text-foreground">
                      «{q.quote}»
                    </p>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground pt-1 border-t border-border/50">
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="font-semibold text-primary">{q.author}</span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"><ShieldAlert className="size-3.5" />غير موثّق</span>
                      </span>
                      <span className="truncate max-w-[220px]" title={q.context}>{q.context}</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full text-xs h-8 mt-2 justify-center gap-1.5"
                      onClick={() => insertTextIntoArticle(`وكما قال ${q.author}: «${q.quote}».`, "أُدرج الاقتباس في المقال وحُفظ بنجاح ✓")}
                    >
                      <PlusCircle className="size-3.5 text-primary" />
                      <span>إدراج الاقتباس في نهاية المقال</span>
                    </Button>
                  </div>
                )) : (
                  <p className="text-xs text-muted-foreground py-4 text-center">لا توجد اقتباسات محددة لهذا المقال.</p>
                )}
              </div>
            )}

            {enrichTab === "additions" && (
              <div className="space-y-3">
                {enrichment.additions?.length ? enrichment.additions.map((add, idx) => (
                  <div key={idx} className="rounded-xl border border-border bg-card p-3.5 space-y-2.5">
                    <p className="text-sm leading-relaxed text-foreground">{add}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full text-xs h-8 justify-center gap-1.5"
                      onClick={() => insertTextIntoArticle(add, "أُضيفت الفكرة للمقال وحُفظت بنجاح ✓")}
                    >
                      <PlusCircle className="size-3.5 text-primary" />
                      <span>إدراج هذه الزاوية في المقال</span>
                    </Button>
                  </div>
                )) : (
                  <p className="text-xs text-muted-foreground py-4 text-center">لا توجد إضافات حالياً.</p>
                )}
              </div>
            )}

            {enrichTab === "questions" && (
              <div className="space-y-3">
                {enrichment.questions?.length ? enrichment.questions.map((quest, idx) => (
                  <div key={idx} className="rounded-xl border border-border bg-card p-3.5 space-y-2.5">
                    <p className="text-sm font-medium leading-relaxed text-foreground">؟ {quest}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full text-xs h-8 justify-center gap-1.5"
                      onClick={() => insertTextIntoArticle(quest, "أُدرج السؤال في خاتمة المقال وحُفظ بنجاح ✓")}
                    >
                      <PlusCircle className="size-3.5 text-primary" />
                      <span>إدراج كسؤال خاتمة كاشف</span>
                    </Button>
                  </div>
                )) : (
                  <p className="text-xs text-muted-foreground py-4 text-center">لا توجد أسئلة حالياً.</p>
                )}
              </div>
            )}
          </div>
        ) : null}

        <div className="flex justify-end pt-2">
          <Button variant="ghost" onClick={() => setEnrichOpen(false)}>إغلاق</Button>
        </div>
      </DialogContent>
    </Dialog>
    {/* Facebook post suggestion dialog: one post in the author's voice, copy-only —
        the app never posts to Facebook; the author pastes the text himself. */}
    <Dialog open={fbOpen} onOpenChange={setFbOpen}>
      <DialogContent dir="rtl" className="max-h-[88dvh] overflow-y-auto">
        <DialogTitle className="text-start font-display flex items-center gap-2">
          <Facebook className="size-5 text-[#1877F2]" />
          <span>منشور فيسبوك مقترح</span>
        </DialogTitle>
        <p className="text-xs text-muted-foreground">
          منشور واحد قصير بصوتك، مأخوذ من هذا المقال وحده. انسخه والصقه في فيسبوك بنفسك — التطبيق لا ينشر نيابة عنك.
        </p>

        {fbBusy ? (
          <div className="py-8 text-center space-y-3">
            <div className="inline-block size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">جارٍ إعداد المنشور…</p>
          </div>
        ) : fbPost ? (
          <div className="space-y-2">
            <div className="whitespace-pre-wrap break-words rounded-xl border border-border bg-card p-4 font-article text-lg leading-relaxed text-foreground">{fbPost}</div>
            {fbVariation > 0 && <p className="text-xs text-muted-foreground">اقتراح رقم {fbVariation + 1}</p>}
          </div>
        ) : null}

        {fbError && <p role="alert" className="text-sm text-destructive">{fbError}</p>}
        {fbStatus && <p role="status" className="text-sm text-muted-foreground">{fbStatus}</p>}

        <div className="flex flex-wrap gap-2 pt-2">
          <Button disabled={!fbPost || fbBusy} onClick={copyFacebookPost}><Copy />نسخ المنشور</Button>
          <Button variant="outline" disabled={fbBusy} onClick={() => void loadFacebookPost(fbPost ? fbVariation + 1 : fbVariation)}><RefreshCw />اقتراح آخر</Button>
          <Button variant="ghost" onClick={() => setFbOpen(false)}>إغلاق</Button>
        </div>
      </DialogContent>
    </Dialog>
    {/* Manual topic picker: move this article to another classification by hand.
        A hand-set topic is pinned — AI classification skips the article until the
        user hands it back with «إلغاء الضبط اليدوي». */}
    <Dialog open={topicOpen} onOpenChange={setTopicOpen}>
      <DialogContent dir="rtl" className="max-h-[88dvh] overflow-y-auto">
        <DialogTitle className="text-start font-display">تصنيف المقال</DialogTitle>
        {idea.topicManual && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-secondary px-3 py-2">
            <span className="inline-flex items-center gap-1.5 text-sm text-secondary-foreground"><Lock className="size-4" />التصنيف مضبوط يدويًا</span>
            <Button size="sm" variant="ghost" onClick={unlockTopic}>إلغاء الضبط اليدوي</Button>
          </div>
        )}
        <div className="space-y-1.5">
          {topicOpen && topicOptions(loadIdeas()).map(({ topic: name, count }) => (
            <button key={name} type="button" onClick={() => chooseTopic(name)}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-start hover:bg-accent">
              <span className="text-sm font-medium text-foreground">{name}</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {count}
                {name === topic && <Check className="size-4 text-primary" />}
              </span>
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input aria-label="تصنيف جديد" value={newTopic} onChange={(e) => setNewTopic(e.target.value)} placeholder="تصنيف جديد…"
            onKeyDown={(e) => { if (e.key === "Enter" && newTopic.trim()) chooseTopic(newTopic); }}
            className="min-w-0 flex-1 rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring" />
          <Button disabled={!newTopic.trim()} onClick={() => chooseTopic(newTopic)}>حفظ</Button>
        </div>
        <div className="flex justify-end pt-1">
          <Button variant="ghost" onClick={() => setTopicOpen(false)}>إغلاق</Button>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={previewOpen} onOpenChange={(open) => { if (!open) abort.current?.abort(); setPreviewOpen(open); }}>
      <DialogContent dir="rtl" className="max-h-[85dvh] overflow-y-auto">
        <DialogTitle className="text-start font-display">مراجعة التحسين</DialogTitle>
        <p className="text-sm text-muted-foreground">{busy ? "جارٍ ضبط اللغة والأسلوب…" : suggestion ? "النسخة المقترحة" : "لم يكتمل التحسين"}</p>
        <div aria-live="polite" className="whitespace-pre-wrap break-words font-article text-xl leading-loose">{preview}</div>
        {message && <p role="status" className="break-words text-sm text-muted-foreground">{message}</p>}
        <div className="flex flex-wrap gap-2">
          {busy ? <Button variant="outline" onClick={() => abort.current?.abort()}><Square />إيقاف</Button> : <Button disabled={!suggestion} onClick={() => {
            const latest = loadIdeas().find((i) => i.id === idea.id);
            if (!latest || (latest.updatedAt ?? 0) !== version.current) { setMessage("تغير المقال أثناء التحسين. لم نستبدل تعديلاتك."); setSuggestion(null); return; }
            if (suggestion) save(suggestion.title, suggestion.body, true);
          }}><Check />اعتماد التحسين</Button>}
          <Button variant="ghost" onClick={() => { abort.current?.abort(); setPreviewOpen(false); }}>إلغاء</Button>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <DialogContent dir="rtl"><DialogTitle className="text-start">حذف المقال؟</DialogTitle>
        <div className="flex gap-2"><Button variant="destructive" onClick={onDelete}><Trash2 />حذف</Button><Button variant="ghost" onClick={() => setConfirmDelete(false)}>إلغاء</Button></div>
      </DialogContent>
    </Dialog>
  </article>;
}

/**
 * A song in the library: the recording IS the content. On the device that
 * recorded it there is a native player and a share button for the real
 * A song in the library: the recording IS the content. On the device that
 * recorded it there is a native player and a share button for the real
 * audio file; on any other device the recording waits in the «أفكاري —
 * الأغاني» folder on Google Drive and one tap downloads it into this
 * device's store and plays it — only when no Drive copy exists either
 * does a calm note say the recording lives on the device that made it.
 * No smart tools and no «استمع»: the voice is already the author's own.
 * The one deliberate AI touch is lyrics extraction (here and as a
 * background post-save pass): the sung words written onto the song,
 * never a rewrite. The lyrics are the idea's text, edited plainly.
 */
function SongSection({ idea, onChange, onDeleteRequest, hlQuery, bodyMatchStart, currentMatchIndex }: {
  idea: Idea; onChange: () => void; onDeleteRequest: () => void;
  /** Active library search, for highlighting the lyrics (the same global
   *  match indexing the article body uses). */
  hlQuery?: string; bodyMatchStart?: number; currentMatchIndex?: number | null | undefined;
}) {
  const article = getArticle(idea);
  const [record, setRecord] = useState<SongAudioRecord | null | undefined>(undefined);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [extracting, setExtracting] = useState(() => isSongLyricsPending(idea.id));
  const [preview, setPreview] = useState<string | null>(null);
  const state = deriveSongAudioState(record, !!idea.driveFileId);
  const recordedLabel = songRecordedLabel(idea);

  // The background post-save pass also extracts: mirror the shared pending
  // registry so its run shows here (and its finish re-renders the lyrics).
  useEffect(() => onSongLyricsPendingChange(() => setExtracting(isSongLyricsPending(idea.id))), [idea.id]);

  /** Pull the Drive copy into this device's store; the player takes over. */
  const downloadFromDrive = async () => {
    setDownloading(true);
    setStatus("");
    try {
      const rec = await downloadSongAudio(idea);
      setRecord(rec);
      setUrl(URL.createObjectURL(rec.blob));
    } catch {
      setStatus("تعذّر تنزيل التسجيل من Google Drive الآن — حاول مرة أخرى عند الاتصال.");
    } finally {
      setDownloading(false);
    }
  };

  /** Extract the sung words. Empty lyrics fill directly; written lyrics are
   *  never replaced silently — the extraction waits in a preview panel
   *  until the user picks «استخدامها بدل الحالية» or dismisses it. */
  const runExtract = async () => {
    setStatus("");
    setPreview(null);
    try {
      const text = await transcribeSong(idea.id);
      const decision = decideLyricsApplication(idea.text, text);
      if (decision === "none") { setStatus("لم نسمع كلمات واضحة في التسجيل."); return; }
      if (decision === "confirm") { setPreview(text); return; }
      const updated = applySongLyrics(idea.id, text, "fill-if-empty");
      if (updated) {
        onChange();
        void pushIdea(updated).catch(() => {});
        setStatus("استُخرجت الكلمات ✓");
      }
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "تعذّر استخراج الكلمات الآن. حاول مرة أخرى.");
    }
  };

  const usePreview = () => {
    if (!preview) return;
    const updated = applySongLyrics(idea.id, preview, "replace");
    setPreview(null);
    if (updated) {
      onChange();
      void pushIdea(updated).catch(() => {});
      setStatus("استُخرجت الكلمات ✓");
    }
  };

  useEffect(() => {
    let alive = true;
    let objUrl = "";
    setRecord(undefined);
    setUrl("");
    getSongAudio(idea.id)
      .then((rec) => {
        if (!alive) return;
        setRecord(rec);
        if (rec) { objUrl = URL.createObjectURL(rec.blob); setUrl(objUrl); }
      })
      .catch(() => { if (alive) setRecord(null); });
    return () => { alive = false; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [idea.id]);

  /** Share the real recording file, exactly like generated article audio:
   *  the system share sheet when files are shareable, a download otherwise. */
  const shareSong = async () => {
    if (!record) return;
    setStatus("");
    const file = new File([record.blob], audioFileName(article.title, record.mime), { type: record.mime });
    let canFiles = false;
    try { canFiles = !!navigator.canShare?.({ files: [file] }); } catch { canFiles = false; }
    if (canFiles) {
      try { await navigator.share({ files: [file], title: article.title }); return; }
      catch (e) { if (e instanceof Error && e.name === "AbortError") return; }
    }
    const objUrl = URL.createObjectURL(record.blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
    setStatus("نُزّل ملف الأغنية ✓");
  };

  const saveLyrics = () => {
    const updated = updateSong(idea.id, title, lyrics);
    if (!updated) return;
    onChange();
    void pushIdea(updated).catch(() => {});
    setEditing(false);
    setStatus("حُفظت الأغنية ✓");
  };

  if (editing) {
    return <div className="space-y-3">
      <input aria-label="عنوان الأغنية" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-md border border-input bg-card px-3 py-2 font-display text-lg outline-none focus:ring-2 focus:ring-ring" />
      <textarea aria-label="كلمات الأغنية" value={lyrics} onChange={(e) => setLyrics(e.target.value)} rows={10} placeholder="اكتب كلمات الأغنية هنا…" className="w-full rounded-md border border-input bg-card p-3 font-article text-xl leading-loose outline-none focus:ring-2 focus:ring-ring" />
      <div className="flex gap-2">
        <Button onClick={saveLyrics} disabled={!title.trim()}><Check />حفظ</Button>
        <Button variant="ghost" onClick={() => setEditing(false)}><X />إلغاء</Button>
      </div>
    </div>;
  }

  return <div className="space-y-3">
    {state === "checking" && <p className="text-sm text-muted-foreground">جارٍ التحقق من التسجيل…</p>}
    {state === "ready" && url && <audio controls src={url} className="w-full" aria-label="تشغيل الأغنية" />}
    {state === "drive" && (
      <div className="space-y-2 rounded-lg bg-secondary px-3 py-2">
        <p className="text-sm leading-relaxed text-secondary-foreground">
          التسجيل محفوظ في Google Drive — نزّله إلى هذا الجهاز لتشغيله هنا.
        </p>
        <Button variant="outline" className="[&_svg]:size-5" onClick={() => void downloadFromDrive()} disabled={downloading}>
          <Download />{downloading ? "جارٍ التنزيل…" : "تنزيل وتشغيل"}
        </Button>
      </div>
    )}
    {state === "missing" && (
      <p className="rounded-lg bg-secondary px-3 py-2 text-sm leading-relaxed text-secondary-foreground">
        التسجيل الصوتي على الجهاز اللي سجّلته عليه — المزامنة تنقل العنوان والكلمات والتصنيف، لا الصوت نفسه.
      </p>
    )}
    {recordedLabel && <p className="text-xs text-muted-foreground">{recordedLabel}</p>}
    {preview !== null && (
      <div className="space-y-2 rounded-lg border border-input bg-card p-3">
        <p className="text-sm font-medium">الكلمات المستخرجة من الغنا:</p>
        <p className="whitespace-pre-wrap break-words font-article text-lg leading-loose">{preview}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={usePreview}><Check />استخدامها بدل الحالية</Button>
          <Button size="sm" variant="ghost" onClick={() => setPreview(null)}><X />تجاهل</Button>
        </div>
      </div>
    )}
    {idea.text.trim() ? (
      <p className="whitespace-pre-wrap break-words font-article text-xl leading-loose text-foreground">{hlQuery
        ? <HighlightedText text={idea.text} query={hlQuery} startIndex={bodyMatchStart} currentIndex={currentMatchIndex} />
        : idea.text}</p>
    ) : (
      <p className="text-sm text-muted-foreground">لا توجد كلمات مكتوبة بعد — اضغط «تعديل» لإضافة كلمات الأغنية.</p>
    )}
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="تعديل الأغنية" title="تعديل الأغنية" onClick={() => { setTitle(article.title); setLyrics(idea.text); setEditing(true); setStatus(""); }}><Pencil /></Button>
      {state === "ready" && (
        extracting
          ? <Button variant="outline" size="sm" disabled>جارٍ استخراج الكلمات…</Button>
          : <Button variant="outline" size="sm" onClick={() => void runExtract()}><Sparkles />استخرج الكلمات من الغنا</Button>
      )}
      {state === "ready" && (
        <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="مشاركة الصوت" title="مشاركة الصوت" onClick={() => void shareSong()}><Share2 /></Button>
      )}
      <Button variant="ghost" size="icon" className="ms-auto bg-destructive/10 text-destructive hover:bg-destructive/20 [&_svg]:size-5" aria-label="حذف الأغنية" title="حذف الأغنية" onClick={onDeleteRequest}><Trash2 /></Button>
    </div>
    {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}
  </div>;
}

const SPEECH_RATES = [0.75, 1, 1.25, 1.5];

/**
 * Listen to an article. Two engines: the device voice (heard live, no file —
 * so nothing to share) and Gemini TTS with the author's personal key.
 * Gemini synthesis runs chunk by chunk in parallel; every finished chunk is
 * cached on this phone immediately and playback starts with the first chunk
 * while the rest are still generating. A half-finished generation keeps its
 * chunks and can be completed later; sharing stitches the chunks back into
 * one WAV file. Audio saved by the first listen release (a single combined
 * WAV) still plays and shares as before. One generation always comes from
 * ONE Gemini TTS model (the session resolves it on the first chunk), and
 * its cache entry is keyed by that model — a cached generation is played,
 * shared, and completed as-is, never mixed with another model's audio.
 * The Gemini engine additionally offers the author's own replicated voice
 * («صوتي», created in Settings): cache entries are scoped per voice, so a
 * default-voice generation and a my-voice generation of the same article
 * coexist and are loaded, resumed, shared, and deleted independently.
 */
function ListenDialog({ open, onOpenChange, articleId, title, body }: {
  open: boolean; onOpenChange: (open: boolean) => void; articleId: string; title: string; body: string;
}) {
  const [engine, setEngine] = useState<TtsEngine>("device");
  const [hasKey, setHasKey] = useState(false);
  // Which voice the Gemini engine speaks in: the prebuilt default, or the
  // user's own replicated voice («صوتي», created in Settings). Each voice
  // has its own cached generation per article — they never mix.
  const [voiceChoice, setVoiceChoice] = useState<"default" | "mine">("default");
  const [myVoiceId, setMyVoiceId] = useState("");
  /** «صوتي» is temporarily hidden (MY_VOICE_PUBLIC): while off, the voice
   * toggle is not rendered and every choice routes to the default voice. */
  const myVoiceShown = isMyVoicePublic();
  /** The voice half of the cache voice key all cache operations apply to:
   * the prebuilt voice name, or the replicated voice id when «صوتي» is on. */
  const voicePartRef = useRef<string>(GEMINI_TTS_VOICE);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  // Device playback
  const [speaking, setSpeaking] = useState(false);
  const [chunkLabel, setChunkLabel] = useState("");
  const speechRef = useRef<DeviceSpeech | null>(null);
  // Gemini file mode. Playback order is driven through refs because chunk
  // completions arrive asynchronously, outside React's render cycle.
  const [cacheState, setCacheState] = useState<"checking" | "none" | "ready">("checking");
  const [legacy, setLegacy] = useState<ArticleAudioRecord | null>(null);
  const [legacyFresh, setLegacyFresh] = useState(true);
  const [manifest, setManifest] = useState<ChunkedAudioManifest | null>(null);
  const [manifestFresh, setManifestFresh] = useState(true);
  const [readyCount, setReadyCount] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [playIndex, setPlayIndex] = useState(-1);
  const [waiting, setWaiting] = useState(false);
  const [audioUrl, setAudioUrl] = useState("");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const genAbort = useRef<AbortController | null>(null);
  const generatingRef = useRef(false);
  const readyPcm = useRef<Map<number, Uint8Array>>(new Map());
  const readyIdx = useRef<Set<number>>(new Set());
  const chunkUrls = useRef<Map<number, string>>(new Map());
  const legacyUrl = useRef("");
  const playIndexRef = useRef(-1);
  const waitingRef = useRef(false);
  const legacyRef = useRef<ArticleAudioRecord | null>(null);
  /** Voice key of the generation currently loaded or being generated; it
   * embeds the producing model, and chunks are saved/loaded under it. */
  const voiceKeyRef = useRef("");
  const totalRef = useRef(0);
  const pendingPlay = useRef(false);
  const rateRef = useRef(1);
  rateRef.current = rate;

  const text = toSpeechText(title, body);
  const complete = !!manifest && totalChunks > 0 && readyCount >= totalChunks;
  const stale = legacy ? !legacyFresh : manifest ? !manifestFresh : false;
  const hasPlayable = !!legacy || readyCount > 0;

  const revokeChunkUrls = () => {
    for (const u of chunkUrls.current.values()) URL.revokeObjectURL(u);
    chunkUrls.current.clear();
  };

  const chunkUrl = (i: number): string | null => {
    const hit = chunkUrls.current.get(i);
    if (hit) return hit;
    const pcm = readyPcm.current.get(i);
    if (!pcm) return null;
    const url = URL.createObjectURL(new Blob([pcmToWav(pcm) as BlobPart], { type: "audio/wav" }));
    chunkUrls.current.set(i, url);
    return url;
  };

  /** Start playing chunk i (chunks only ever start in index order). */
  const playChunk = (i: number) => {
    const url = chunkUrl(i);
    if (!url) return;
    playIndexRef.current = i;
    setPlayIndex(i);
    waitingRef.current = false;
    setWaiting(false);
    pendingPlay.current = true;
    setAudioUrl(url);
  };

  // Kick playback once React has applied the new src.
  useEffect(() => {
    if (!pendingPlay.current || !audioUrl) return;
    pendingPlay.current = false;
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = rateRef.current;
    void el.play().catch(() => {});
  }, [audioUrl]);

  const maybeStartPlayback = () => {
    if (playIndexRef.current === -1 && readyIdx.current.has(0)) playChunk(0);
  };

  const handleEnded = () => {
    if (legacyRef.current) return; // a legacy file is a single item
    const next = playIndexRef.current + 1;
    if (readyIdx.current.has(next)) { playChunk(next); return; }
    if (generatingRef.current && next < totalRef.current) {
      waitingRef.current = true;
      setWaiting(true);
    }
  };

  /** A chunk finished generating: cache it at once, then feed the player. */
  const handleChunkReady = (i: number, pcm: Uint8Array) => {
    readyPcm.current.set(i, pcm);
    readyIdx.current.add(i);
    setReadyCount(readyIdx.current.size);
    void saveAudioChunk({
      articleId, engine: "gemini", voiceKey: voiceKeyRef.current, index: i,
      pcm: new Blob([pcm as BlobPart], { type: PCM_CHUNK_MIME }),
    }).catch(() => {});
    if (playIndexRef.current === -1) maybeStartPlayback();
    else if (waitingRef.current && i === playIndexRef.current + 1) playChunk(i);
  };

  const loadCache = async () => {
    setCacheState("checking");
    readyPcm.current.clear();
    readyIdx.current.clear();
    revokeChunkUrls();
    playIndexRef.current = -1;
    setPlayIndex(-1);
    waitingRef.current = false;
    setWaiting(false);
    setLegacy(null); legacyRef.current = null;
    setManifest(null);
    setReadyCount(0);
    setTotalChunks(0); totalRef.current = 0;
    if (legacyUrl.current) { URL.revokeObjectURL(legacyUrl.current); legacyUrl.current = ""; }
    setAudioUrl("");
    voiceKeyRef.current = "";
    const cached = await findCachedAudioForVoice(articleId, "gemini", voicePartRef.current, title, body).catch(() => null);
    if (!cached) { setCacheState("none"); return; }
    if (cached.kind === "legacy") {
      setLegacy(cached.record); legacyRef.current = cached.record;
      voiceKeyRef.current = cached.record.voiceKey;
      setLegacyFresh(cached.fresh);
      const url = URL.createObjectURL(cached.blob);
      legacyUrl.current = url;
      setAudioUrl(url);
      setCacheState("ready");
      return;
    }
    setManifest(cached.manifest);
    voiceKeyRef.current = cached.manifest.voiceKey;
    setManifestFresh(cached.fresh);
    setTotalChunks(cached.manifest.chunkCount);
    totalRef.current = cached.manifest.chunkCount;
    for (const i of cached.readyIndexes) {
      const blob = await getAudioChunk(articleId, "gemini", cached.manifest.voiceKey, i).catch(() => null);
      if (blob) {
        readyPcm.current.set(i, await blobToBytes(blob));
        readyIdx.current.add(i);
      }
    }
    setReadyCount(readyIdx.current.size);
    setCacheState(readyIdx.current.size > 0 ? "ready" : "none");
  };

  useEffect(() => {
    if (!open) return;
    const key = getGeminiKey();
    setHasKey(!!key);
    setEngine(key ? "gemini" : "device");
    const profile = getMyVoiceProfile();
    setMyVoiceId(profile?.voiceId ?? "");
    setVoiceChoice("default");
    voicePartRef.current = GEMINI_TTS_VOICE;
    setError(""); setStatus("");
    void loadCache();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  const stopDevice = () => {
    speechRef.current?.stop();
    speechRef.current = null;
    setSpeaking(false);
    setChunkLabel("");
  };

  useEffect(() => () => {
    speechRef.current?.stop();
    genAbort.current?.abort();
    revokeChunkUrls();
    if (legacyUrl.current) URL.revokeObjectURL(legacyUrl.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = (next: boolean) => {
    if (!next) {
      stopDevice();
      genAbort.current?.abort();
      audioRef.current?.pause();
      playIndexRef.current = -1;
      setPlayIndex(-1);
      revokeChunkUrls();
      if (legacyUrl.current) { URL.revokeObjectURL(legacyUrl.current); legacyUrl.current = ""; }
      setAudioUrl("");
    }
    onOpenChange(next);
  };

  const startDevice = (r = rate) => {
    setError("");
    try {
      speechRef.current?.stop();
      const speech = speakWithDevice(text, {
        rate: r,
        onChunk: (i, total) => setChunkLabel(`جزء ${i + 1} من ${total}`),
      });
      speechRef.current = speech;
      setSpeaking(true);
      void speech.done.finally(() => {
        if (speechRef.current === speech) { speechRef.current = null; setSpeaking(false); setChunkLabel(""); }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "صوت الجهاز غير متاح على هذا الجهاز.");
    }
  };

  /**
   * Generate (or complete) the Gemini audio and start playing it. With a
   * fresh manifest this synthesizes only the missing chunks — always with
   * the model that started that generation. Otherwise — and always when
   * `force` is set — it starts over: a session resolves one current model
   * on the first chunk, and the new manifest is written under that model's
   * voice key the moment the model is known.
   */
  const generate = async (force = false) => {
    if (generatingRef.current) return;
    setError(""); setStatus("");
    if (!navigator.onLine) { setError("توليد الصوت يحتاج اتصالًا بالإنترنت."); return; }
    const key = getGeminiKey();
    if (!key) { setError("أضف مفتاح Gemini من الإعدادات ⚙️ لتوليد الصوت."); return; }
    const chunks = splitForSpeech(text);
    if (!chunks.length) { setError("لا يوجد نص للقراءة."); return; }
    const activeVoiceId = voicePartRef.current !== GEMINI_TTS_VOICE ? voicePartRef.current : undefined;
    const resumeManifest = !force && !legacy && manifestFresh ? manifest : null;
    const session = resumeManifest ? null : createTtsSession(key, { ...(activeVoiceId ? { voiceId: activeVoiceId } : {}) });
    if (!resumeManifest) {
      await deleteArticleAudioForVoice(articleId, "gemini", voicePartRef.current).catch(() => {});
      readyPcm.current.clear();
      readyIdx.current.clear();
      revokeChunkUrls();
      playIndexRef.current = -1;
      setPlayIndex(-1);
      setReadyCount(0);
      setLegacy(null); legacyRef.current = null;
      voiceKeyRef.current = "";
      setManifest(null);
      if (legacyUrl.current) { URL.revokeObjectURL(legacyUrl.current); legacyUrl.current = ""; }
      setAudioUrl("");
    }
    setTotalChunks(chunks.length);
    totalRef.current = chunks.length;
    const missing = chunks.map((_, i) => i).filter((i) => !readyIdx.current.has(i));
    maybeStartPlayback();
    if (!missing.length) { setStatus("الصوت مكتمل ومحفوظ على هذا الهاتف ✓"); return; }
    // A fresh generation's manifest can only be written once the session
    // has resolved its model (on the first successful chunk); every worker
    // awaits the same one-time write before caching its chunk.
    let manifestWrite: Promise<void> | null = null;
    const ensureManifest = async () => {
      if (!session) return;
      manifestWrite ??= (async () => {
        voiceKeyRef.current = session.voiceKey;
        const mf = await saveAudioManifest({
          articleId, engine: "gemini", voiceKey: session.voiceKey, modelId: session.model,
          title, body, chunkCount: chunks.length,
        });
        setManifest(mf);
        setManifestFresh(true);
      })();
      await manifestWrite;
    };
    const controller = new AbortController();
    genAbort.current = controller;
    generatingRef.current = true;
    setGenerating(true);
    try {
      await mapWithConcurrency(missing, 3, async (i) => {
        const chunk = chunks[i] as string;
        const pcm = resumeManifest
          ? await synthesizeGeminiChunkWithModel(chunk, key, modelForVoiceKey(resumeManifest.voiceKey), controller.signal, activeVoiceId)
          : await (session as NonNullable<typeof session>).synthesizeChunk(chunk, controller.signal);
        await ensureManifest();
        handleChunkReady(i, pcm);
      }, controller.signal);
      setStatus("حُفظ الصوت على هذا الهاتف ✓");
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "تعذّر توليد الصوت الآن.");
    } finally {
      generatingRef.current = false;
      setGenerating(false);
      genAbort.current = null;
    }
  };

  const canShareFiles = () => {
    try { return !!navigator.canShare?.({ files: [new File([], "a.wav", { type: "audio/wav" })] }); }
    catch { return false; }
  };

  const shareAudio = async () => {
    setStatus("");
    let blob: Blob;
    let mime = "audio/wav";
    if (legacy) {
      blob = legacy.blob;
      mime = legacy.mime;
    } else if (manifest && complete) {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < manifest.chunkCount; i++) {
        let pcm = readyPcm.current.get(i);
        if (!pcm) {
          const stored = await getAudioChunk(articleId, "gemini", manifest.voiceKey, i).catch(() => null);
          if (stored) pcm = await blobToBytes(stored);
        }
        if (!pcm) { setError("تعذّر تجهيز ملف الصوت للمشاركة."); return; }
        parts.push(pcm);
      }
      blob = new Blob([pcmToWav(concatPcm(parts)) as BlobPart], { type: "audio/wav" });
    } else return;
    const file = new File([blob], audioFileName(title, mime), { type: mime });
    if (canShareFiles()) {
      try { await navigator.share({ files: [file], title }); return; }
      catch (e) { if (e instanceof Error && e.name === "AbortError") return; }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = file.name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("نُزّل ملف الصوت ✓");
  };

  const removeSaved = async () => {
    genAbort.current?.abort();
    audioRef.current?.pause();
    await deleteArticleAudioForVoice(articleId, "gemini", voicePartRef.current).catch(() => {});
    voiceKeyRef.current = "";
    readyPcm.current.clear();
    readyIdx.current.clear();
    revokeChunkUrls();
    playIndexRef.current = -1;
    setPlayIndex(-1);
    setLegacy(null); legacyRef.current = null;
    setManifest(null);
    setReadyCount(0);
    setTotalChunks(0); totalRef.current = 0;
    if (legacyUrl.current) { URL.revokeObjectURL(legacyUrl.current); legacyUrl.current = ""; }
    setAudioUrl("");
    setCacheState("none");
    setStatus("حُذف الصوت المحفوظ.");
  };

  const pickEngine = (next: TtsEngine) => {
    if (next !== engine) {
      if (speaking) stopDevice();
      if (next === "device") {
        genAbort.current?.abort();
        audioRef.current?.pause();
      }
    }
    setEngine(next);
    setError("");
  };

  /** Switch the Gemini voice: each voice keeps its own cached generation,
   * so switching reloads the cache scoped to the newly picked voice. */
  const pickVoice = (next: "default" | "mine") => {
    // Route through the feature gate: while «صوتي» is hidden, a "mine"
    // choice collapses to the default voice instead of erroring.
    const routed = effectiveListenVoice(next);
    if (routed === voiceChoice) return;
    if (routed === "mine" && !myVoiceId) return;
    genAbort.current?.abort();
    audioRef.current?.pause();
    setVoiceChoice(routed);
    voicePartRef.current = routed === "mine" ? myVoiceId : GEMINI_TTS_VOICE;
    setError(""); setStatus("");
    void loadCache();
  };

  const rateSelect = (onRate: (r: number) => void) => (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      السرعة
      <select aria-label="سرعة القراءة" value={rate} onChange={(e) => onRate(Number(e.target.value))}
        className="rounded-md border border-input bg-card px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring">
        {SPEECH_RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
      </select>
    </label>
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent dir="rtl" className="max-h-[88dvh] overflow-y-auto">
        <DialogTitle className="text-start font-display flex items-center gap-2">
          <Volume2 className="size-5 text-primary" />
          <span>استمع للمقال</span>
        </DialogTitle>
        <p className="truncate text-xs text-muted-foreground" title={title}>{title}</p>

        <div className="flex rounded-lg border border-border p-1 bg-muted/30">
          <button type="button" onClick={() => pickEngine("device")}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${engine === "device" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            صوت الجهاز
          </button>
          <button type="button" onClick={() => pickEngine("gemini")}
            className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${engine === "gemini" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            صوت Gemini
          </button>
        </div>

        {engine === "device" && (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">
              يقرأ هاتفك المقال بصوته مباشرة. صوت الجهاز يُسمَع في الحال ولا يُحفَظ كملف، لذلك لا يمكن مشاركته — للمشاركة استخدم صوت Gemini.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => startDevice()} disabled={speaking}><Play />تشغيل</Button>
              <Button variant="outline" onClick={stopDevice} disabled={!speaking}><Square />إيقاف</Button>
              {rateSelect((r) => { setRate(r); if (speaking) startDevice(r); })}
            </div>
            {speaking && chunkLabel && <p role="status" className="text-sm text-muted-foreground">جارٍ القراءة… {chunkLabel}</p>}
          </div>
        )}

        {engine === "gemini" && (
          <div className="space-y-3">
            {hasKey && myVoiceShown && (
              <>
                <div className="flex rounded-lg border border-border p-1 bg-muted/30">
                  <button type="button" onClick={() => pickVoice("default")}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${voiceChoice === "default" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                    الصوت الافتراضي
                  </button>
                  <button type="button" onClick={() => pickVoice("mine")} disabled={!myVoiceId}
                    className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${voiceChoice === "mine" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"} disabled:opacity-50`}>
                    صوتي
                  </button>
                </div>
                {!myVoiceId && (
                  <p className="text-xs text-muted-foreground">أنشئ صوتك من الإعدادات ⚙️ ليقرأ Gemini المقالات بصوتك أنت.</p>
                )}
                {voiceChoice === "mine" && (
                  <p className="text-xs text-muted-foreground">هذه القراءة بصوتك المُستنسخ — ولكل صوت نسخته المحفوظة الخاصة.</p>
                )}
              </>
            )}
            {!hasKey ? (
              <p className="text-sm leading-relaxed text-muted-foreground">
                أضف مفتاح Gemini من الإعدادات ⚙️ لتوليد صوت لهذا المقال — نفس مفتاح الضبط والدمج. الصوت المولّد ملف حقيقي: يُحفَظ على هاتفك ويُشارَك مثل المقال تمامًا.
              </p>
            ) : cacheState === "checking" ? (
              <div className="py-6 text-center space-y-3">
                <div className="inline-block size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                <p className="text-sm text-muted-foreground">جارٍ التحقق من الصوت المحفوظ…</p>
              </div>
            ) : (
              <>
                {stale && (
                  <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
                    النص تغيّر منذ توليد هذا الصوت — ما تسمعه الآن هو النسخة السابقة. أعد التوليد لسماع النص الحالي.
                  </p>
                )}
                {/* The element stays mounted in Gemini mode so progressive
                    playback can start the moment the first chunk lands. */}
                <audio ref={audioRef} src={audioUrl || undefined} controls={hasPlayable}
                  className={hasPlayable ? "w-full" : "hidden"}
                  onEnded={handleEnded}
                  onLoadedMetadata={() => { if (audioRef.current) audioRef.current.playbackRate = rate; }} />
                {!legacy && playIndex >= 0 && (
                  <p className="text-sm text-muted-foreground">الجزء {playIndex + 1} من {totalChunks}</p>
                )}
                {!legacy && playIndex < 0 && (generating || readyCount > 0) && (
                  <p className="text-sm text-muted-foreground">تم توليد {readyCount} من {totalChunks} جزء</p>
                )}
                {waiting && <p role="status" className="text-sm text-muted-foreground">جارٍ التوليد…</p>}
                {generating ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="outline" onClick={() => genAbort.current?.abort()}><Square />إيقاف التوليد</Button>
                    <span className="text-sm text-muted-foreground">يبدأ التشغيل مع أول جزء ويستمر التوليد في الخلفية</span>
                  </div>
                ) : !legacy && !complete ? (
                  <div className="space-y-3">
                    {!manifest && (
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        لا يوجد صوت محفوظ لهذا المقال على هذا الهاتف بعد. ولّد الصوت مرة واحدة وسيُحفَظ هنا للاستماع والمشاركة في أي وقت.
                      </p>
                    )}
                    <Button onClick={() => void generate()}>
                      <Volume2 />{manifest || readyCount > 0 ? "إكمال التوليد" : "توليد وتشغيل"}
                    </Button>
                  </div>
                ) : null}
                {hasPlayable && !generating && (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      {rateSelect((r) => { setRate(r); if (audioRef.current) audioRef.current.playbackRate = r; })}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={shareAudio} disabled={!!manifest && !complete}>
                        {canShareFiles() ? <><Share2 />مشاركة الصوت</> : <><Download />تنزيل الصوت</>}
                      </Button>
                      <Button variant="outline" onClick={() => void generate(true)}><RefreshCw />إعادة التوليد</Button>
                      <Button variant="ghost" className="text-destructive" onClick={removeSaved}><Trash2 />حذف الصوت المحفوظ</Button>
                    </div>
                    {!!manifest && !complete && (
                      <p className="text-xs text-muted-foreground">اكتمال التوليد أولًا للمشاركة</p>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {status && <p role="status" className="text-sm text-muted-foreground">{status}</p>}

        <div className="flex justify-end pt-2">
          <Button variant="ghost" onClick={() => close(false)}>إغلاق</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
