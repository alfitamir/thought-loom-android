import { useRef, useState } from "react";
import { Check, Copy, Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { deleteIdea, getArticle, loadIdeas, mergeAttributions, saveArticleIdea, type Idea } from "@/lib/ideas";
import { loadVisibleIdeas } from "@/lib/pending-deletes";
import { pushIdea } from "@/lib/sync";

/**
 * Manual merge: the user picks a partner article and the two are combined by
 * plain concatenation — title and combined body stay editable before saving,
 * and NO AI is involved at any step. This is the only merge path open to
 * liked articles (the AI suggestion/merge flow excludes them entirely), and
 * it preserves attribution: `mergeAttributions` carries every consumed liked
 * article's source into the result, and an all-liked merge stays liked.
 * Songs are excluded both ways — a recording is not mergeable text.
 */
export function ManualMergeDialog({ idea, onClose }: { idea: Idea; onClose: (done: boolean) => void }) {
  const mine = getArticle(idea);
  const [partner, setPartner] = useState<Idea | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [message, setMessage] = useState("");
  const versions = useRef(new Map<string, number>());
  // Partners live in the SAME section as this article: a medical article
  // merges inside the medical section, a general one never sees medical
  // partners — so the merged result's section is never ambiguous.
  const partners = loadVisibleIdeas().filter((i) => i.id !== idea.id && !i.song && !!i.medical === !!idea.medical);

  const pick = (p: Idea) => {
    versions.current = new Map([[idea.id, idea.updatedAt ?? 0], [p.id, p.updatedAt ?? 0]]);
    setPartner(p);
    setTitle(mine.title);
    setBody(`${mine.body}\n\n${getArticle(p).body}`);
    setMessage("");
  };

  const approve = (removeOriginals: boolean) => {
    if (!partner || !title.trim() || !body.trim()) return;
    const latest = loadIdeas();
    const changed = [idea, partner].some((s) => {
      const now = latest.find((i) => i.id === s.id);
      return !now || (now.updatedAt ?? 0) !== versions.current.get(s.id);
    });
    if (changed) { setMessage("تغيّر أحد المقالين أثناء الدمج. لم نغيّر شيئًا."); return; }
    const consumed = [idea, partner];
    const origins = [...new Set(consumed.flatMap((s) => [s.id, ...(s.mergedFrom ?? [])]))];
    const merged = saveArticleIdea(consumed.map((s) => s.text).join("\n\n"), title, body, origins, { ...mergeAttributions(consumed), ...(idea.medical ? { medical: true } : {}) });
    if (removeOriginals) consumed.forEach((s) => deleteIdea(s.id));
    void pushIdea(merged).catch(() => {});
    onClose(true);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(false); }}>
      <DialogContent dir="rtl" className="max-h-[90dvh] overflow-y-auto">
        <DialogTitle className="text-start font-display">دمج يدوي — بدون ذكاء اصطناعي</DialogTitle>
        {!partner ? <>
          <p className="text-sm text-muted-foreground">اختر المقال الذي تريد دمجه مع «{mine.title}». سيُجمع النصان كما هما، وتبقى نسبة أي مقال خارجي محفوظة في المقال الناتج.</p>
          <div className="space-y-1.5">
            {partners.map((p) => (
              <button key={p.id} type="button" onClick={() => pick(p)}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-start hover:bg-accent">
                <span className="min-w-0 truncate text-sm font-medium text-foreground">{getArticle(p).title}</span>
                {p.liked && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-xs font-medium text-rose-600 dark:text-rose-400"><Heart className="size-3" />أعجبني</span>}
              </button>
            ))}
            {!partners.length && <p className="py-4 text-center text-sm text-muted-foreground">لا توجد مقالات أخرى للدمج معها.</p>}
          </div>
        </> : <div className="space-y-3">
          <p className="text-sm text-muted-foreground">المقالان الأصليان: «{mine.title}» + «{getArticle(partner).title}»</p>
          <input aria-label="عنوان المقال المدمج" value={title} onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-input bg-card px-3 py-2 font-display text-lg outline-none focus:ring-2 focus:ring-ring" />
          <textarea aria-label="نص المقال المدمج" value={body} onChange={(e) => setBody(e.target.value)} rows={12}
            className="w-full rounded-md border border-input bg-card p-3 font-article text-xl leading-loose outline-none focus:ring-2 focus:ring-ring" />
        </div>}
        {message && <p role="status" className="break-words text-sm text-muted-foreground">{message}</p>}
        <div className="flex flex-wrap gap-2">
          {partner && <>
            <Button onClick={() => approve(true)} disabled={!title.trim() || !body.trim()}><Check />اعتماد وحذف الأصلين</Button>
            <Button variant="outline" onClick={() => approve(false)} disabled={!title.trim() || !body.trim()}><Copy />حفظه كمقال جديد</Button>
          </>}
          <Button variant="ghost" onClick={() => onClose(false)}>إلغاء</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
