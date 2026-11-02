import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, HelpCircle, Pencil, PlusCircle, Quote, Share2, ShieldAlert, Sparkles, Square, Trash2, WandSparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EvidenceDialog } from "@/components/evidence-dialog";
import { getArticleEnrichment, type ArticleEnrichment } from "@/lib/ai-features";
import { getArticle, loadIdeas, updateArticle, type Idea } from "@/lib/ideas";
import { pushIdea } from "@/lib/sync";
import { improveFull } from "@/lib/article-ai";
import { resolveEngine } from "@/lib/ai-engine";

const countWords = (text: string) => text.split(/\s+/).filter(Boolean).length;

export function ArticleEditor({ idea, online, onChange, onDelete }: {
  idea: Idea; online: boolean; onChange: () => void; onDelete: () => void;
}) {
  const article = getArticle(idea);
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
      const samples = loadIdeas().filter((i) => i.id !== idea.id).slice(0, 3).map((i) => i.text.slice(0, 2000));
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
      <h2 className="break-words font-display text-xl text-primary">{article.title}</h2>
      <p className="mb-4 mt-1 text-xs text-muted-foreground">{new Date(idea.createdAt).toLocaleDateString("ar")}</p>
      <p className="whitespace-pre-wrap break-words font-article text-xl leading-loose text-foreground">{article.body}</p>
      <p className="mt-2 text-xs text-muted-foreground">عدد الكلمات: {countWords(article.body)}</p>
      <div className="mt-4">
        <p className="mb-2 text-xs font-medium text-muted-foreground">أدوات ذكية</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" aria-label="تحسين بالذكاء الاصطناعي" title={online ? "تحسين بالذكاء الاصطناعي" : "التحسين يحتاج الإنترنت"} disabled={!online || busy} onClick={improve} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"><Sparkles className="size-4" />تحسين</button>
          <button type="button" aria-label="شواهد من القرآن والسنة" title={online ? "شواهد من القرآن والسنة وكتب العلماء مع التحقق من النص" : "الشواهد تحتاج الإنترنت"} disabled={!online} onClick={() => setEvidenceOpen(true)} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"><BookOpen className="size-4 text-emerald-600" />شواهد</button>
          <button type="button" aria-label="اقتراحات واقتباسات للإثراء" title={online ? "اقتراحات واقتباسات من كبار المفكرين لتطوير المقال" : "الإثراء يحتاج الإنترنت"} disabled={!online || enrichBusy} onClick={openEnrichment} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50"><WandSparkles className="size-4 text-amber-500" />إثراء</button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="تعديل المقال" title="تعديل المقال" onClick={() => { setTitle(article.title); setBody(article.body); setEditing(true); setMessage(""); }}><Pencil /></Button>
        <Button variant="ghost" size="icon" aria-label="مشاركة المقال" title="مشاركة المقال" onClick={share}><Share2 /></Button>
        <Button variant="ghost" size="icon" className="text-destructive" aria-label="حذف المقال" title="حذف المقال" onClick={() => setConfirmDelete(true)}><Trash2 /></Button>
      </div>
    </>}
    {message && <p role="status" className="mt-3 break-words text-sm text-muted-foreground">{message}</p>}
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
          <WandSparkles className="size-5 text-amber-500" />
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