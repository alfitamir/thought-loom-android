import { useEffect, useRef, useState } from "react";
import { Check, Pencil, Share2, Sparkles, Square, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getArticle, loadIdeas, updateArticle, type Idea } from "@/lib/ideas";
import { pushIdea } from "@/lib/sync";
import { supabase } from "@/integrations/supabase/client";
import { parseImprovedArticle, readArticleStream } from "@/lib/article-ai";

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
  const abort = useRef<AbortController | null>(null);
  const version = useRef(idea.updatedAt ?? 0);
  useEffect(() => () => abort.current?.abort(), []);

  const save = (newTitle: string, newBody: string) => {
    const updated = updateArticle(idea.id, newTitle, newBody);
    if (!updated) return;
    onChange();
    void pushIdea(updated).catch(() => {});
    setEditing(false); setPreviewOpen(false); setSuggestion(null); setMessage("حُفظ المقال ✓");
  };
  const share = async () => {
    setMessage("");
    try {
      if (navigator.share) await navigator.share({ title: article.title, text: `${article.title}\n\n${article.body}` });
      else if (navigator.clipboard) { await navigator.clipboard.writeText(`${article.title}\n\n${article.body}`); setMessage("نُسخ المقال للمشاركة ✓"); }
      else setMessage("النسخ غير متاح هنا؛ يمكنك تحديد نص المقال ونسخه.");
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) setMessage("تعذّرت المشاركة الآن.");
    }
  };
  const improve = async () => {
    setMessage("");
    if (!navigator.onLine) { setMessage("تحسين المقال يحتاج اتصالًا بالإنترنت."); return; }
    const { data } = await supabase.auth.getSession();
    if (!data.session) { setMessage("سجّل الدخول من الصفحة الرئيسية لتفعيل التحسين."); return; }
    const controller = new AbortController(); abort.current = controller;
    version.current = idea.updatedAt ?? 0;
    setPreview(""); setSuggestion(null); setPreviewOpen(true); setBusy(true);
    try {
      const response = await fetch("/api/articles/improve", {
        method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ ...article, original: idea.text.slice(0, 40000), samples: loadIdeas().filter((i) => i.id !== idea.id).slice(0, 3).map((i) => i.text.slice(0, 2000)) }),
      });
      const output = await readArticleStream(response, setPreview);
      setSuggestion(parseImprovedArticle(output));
    } catch (error) {
      setMessage(controller.signal.aborted ? "توقف التحسين؛ مقالك لم يتغير." : error instanceof Error ? error.message : "تعذّر الاتصال بخدمة تحسين المقالات.");
    } finally { setBusy(false); abort.current = null; }
  };

  return <article className="border-b border-border py-6 last:border-0">
    {editing ? <div className="space-y-3">
      <input aria-label="عنوان المقال" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded-md border border-input bg-card px-3 py-2 font-display text-lg outline-none focus:ring-2 focus:ring-ring" />
      <textarea aria-label="نص المقال" value={body} onChange={(e) => setBody(e.target.value)} rows={10} className="w-full rounded-md border border-input bg-card p-3 font-article text-xl leading-loose outline-none focus:ring-2 focus:ring-ring" />
      <div className="flex gap-2">
        <Button onClick={() => save(title, body)} disabled={!title.trim() || !body.trim()}><Check />حفظ</Button>
        <Button variant="ghost" onClick={() => setEditing(false)}><X />إلغاء</Button>
      </div>
    </div> : <>
      <h2 className="break-words font-display text-xl text-primary">{article.title}</h2>
      <p className="mb-4 mt-1 text-xs text-muted-foreground">{new Date(idea.createdAt).toLocaleDateString("ar")}</p>
      <p className="whitespace-pre-wrap break-words font-article text-xl leading-loose text-foreground">{article.body}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="icon" aria-label="تعديل المقال" title="تعديل المقال" onClick={() => { setTitle(article.title); setBody(article.body); setEditing(true); setMessage(""); }}><Pencil /></Button>
        <Button variant="ghost" size="icon" aria-label="مشاركة المقال" title="مشاركة المقال" onClick={share}><Share2 /></Button>
        <Button variant="ghost" size="icon" aria-label="تحسين بالذكاء الاصطناعي" title={online ? "تحسين بالذكاء الاصطناعي" : "التحسين يحتاج الإنترنت"} disabled={!online || busy} onClick={improve}><Sparkles /></Button>
        <Button variant="ghost" size="icon" className="text-destructive" aria-label="حذف المقال" title="حذف المقال" onClick={() => setConfirmDelete(true)}><Trash2 /></Button>
      </div>
    </>}
    {message && <p role="status" className="mt-3 break-words text-sm text-muted-foreground">{message}</p>}
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
            if (suggestion) save(suggestion.title, suggestion.body);
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