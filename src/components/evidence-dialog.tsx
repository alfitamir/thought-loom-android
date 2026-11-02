import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, Copy, PlusCircle, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getEvidence } from "@/lib/ai-features";
import type { EvidenceItem, EvidenceResult } from "@/lib/evidence";

const KIND = { quran: "من القرآن الكريم", hadith: "من السنة النبوية", writing: "من كتب العلماء والمفكرين" } as const;

/** Text to paste into an article for a verified item (writings are paraphrased ideas, never inserted as quotes). */
export const snippetFor = (i: EvidenceItem) => (i.kind === "writing" || i.status !== "verified" ? "" : `${i.text}\n— ${i.ref}`);

function Badge({ item }: { item: EvidenceItem }) {
  if (item.status === "verified") return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-400"><ShieldCheck className="size-3.5" />نص موثّق من المصدر</span>;
  if (item.status === "unverified") return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"><ShieldAlert className="size-3.5" />لم نتمكن من التحقق (تعذّر الوصول للمصدر)</span>;
  return <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400"><ShieldAlert className="size-3.5" />مرجع مقترح — راجع الكتاب قبل الاستشهاد</span>;
}

export function EvidenceDialog({ open, onOpenChange, title, body, online, onInsert }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; body: string; online: boolean; onInsert?: (snippet: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<EvidenceResult | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const abort = useRef<AbortController | null>(null);

  const run = async () => {
    setBusy(true); setError(""); setResult(null); setDone(new Set());
    const controller = new AbortController();
    abort.current = controller;
    try { setResult(await getEvidence({ title, body }, { signal: controller.signal })); }
    catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "تعذّر جلب الشواهد."); }
    finally { if (abort.current === controller) setBusy(false); }
  };

  useEffect(() => {
    if (!open) { abort.current?.abort(); setBusy(false); return; }
    if (online) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => abort.current?.abort(), []);

  const mark = (id: string) => { setDone((d) => new Set(d).add(id)); setTimeout(() => setDone((d) => { const n = new Set(d); n.delete(id); return n; }), 1800); };
  const copy = async (id: string, text: string) => { try { await navigator.clipboard.writeText(text); mark(id); } catch { /* clipboard blocked */ } };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-h-[88dvh] overflow-y-auto">
        <DialogTitle className="flex items-center gap-2 text-start font-display"><BookOpen className="size-5 text-primary" />شواهد لأطروحات المقال</DialogTitle>
        <p className="text-xs leading-6 text-muted-foreground">يقترح الذكاء الاصطناعي المواضع، ثم يجلب التطبيق نص الآية أو الحديث من مصدر موثوق ويتحقق من تطابقه؛ فلا يظهر لك نصٌّ كتبه النموذج من ذاكرته.</p>
        {!online && <p className="text-sm text-muted-foreground">يلزم الاتصال بالإنترنت.</p>}
        {busy && (
          <div className="py-8 text-center">
            <div className="inline-block size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="mt-2 text-sm text-muted-foreground">جارٍ البحث عن الشواهد والتحقق منها في المصادر…</p>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {result && (
          <div className="space-y-3">
            {result.items.map((item, n) => {
              const id = `${n}`;
              const snippet = snippetFor(item);
              return (
                <article key={id} className="space-y-2 rounded-xl border border-border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">{KIND[item.kind]}</span>
                    <Badge item={item} />
                  </div>
                  <p className="font-semibold">{item.ref}</p>
                  {item.kind !== "writing" && item.text && <p className="whitespace-pre-wrap font-article text-xl leading-loose">{item.text}</p>}
                  {item.kind === "hadith" && item.grade && <p className="text-xs text-muted-foreground">الدرجة: {item.grade}</p>}
                  {item.kind === "writing" && <p className="text-sm leading-7">{item.idea}<span className="mt-1 block text-xs text-muted-foreground">هذه صياغة للفكرة لا نصٌّ منقول، والثقة في المرجع: {item.confidence === "high" ? "عالية" : "متوسطة"}.</span></p>}
                  {item.claim && <p className="text-sm text-muted-foreground">يدعم: «{item.claim}»</p>}
                  {item.why && <p className="text-sm leading-7 text-muted-foreground">{item.why}</p>}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => void copy(id, snippet || `${item.ref}${item.kind === "writing" ? `: ${item.idea}` : ""}`)}>
                      {done.has(id) ? <Check /> : <Copy />}{done.has(id) ? "نُسخ" : "نسخ"}
                    </Button>
                    {onInsert && snippet && <Button size="sm" variant="outline" onClick={() => { onInsert(snippet); mark(`i${id}`); }}><PlusCircle />{done.has(`i${id}`) ? "أُدرج ✓" : "أدرجه في المقال"}</Button>}
                  </div>
                </article>
              );
            })}
            {result.dropped > 0 && <p className="text-xs text-muted-foreground">أُسقط {result.dropped} اقتراحًا لم يتطابق مع نص المصدر أو لم يوجد فيه.</p>}
            <p className="text-xs leading-6 text-muted-foreground">مناسبة الشاهد للدعوى اجتهاد من الذكاء الاصطناعي؛ راجع وجه الاستدلال، وخرّج الأحاديث التي تحتاج تخريجًا قبل النشر.</p>
          </div>
        )}
        {!busy && online && (error || result) && <Button variant="ghost" size="sm" onClick={() => void run()}><RefreshCw />إعادة البحث</Button>}
      </DialogContent>
    </Dialog>
  );
}
