import { useEffect, useRef, useState } from "react";
import { Lightbulb, PlusCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getInsights } from "@/lib/ai-features";
import type { Insights } from "@/lib/ai-prompts";
import { getArticle, saveIdea, type Idea } from "@/lib/ideas";
import { fingerprint } from "@/lib/merge";

const CACHE = "afkari.insights";
const readCache = (): { fp: string; data: Insights } | null => {
  try { return JSON.parse(localStorage.getItem(CACHE) || "null"); } catch { return null; }
};

export function InsightsDialog({ open, onOpenChange, ideas, online, onChange, onPick }: {
  open: boolean; onOpenChange: (open: boolean) => void; ideas: Idea[]; online: boolean; onChange: () => void; onPick: (title: string) => void;
}) {
  const fp = fingerprint(ideas);
  const [data, setData] = useState<Insights | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const abort = useRef<AbortController | null>(null);

  const run = async () => {
    setBusy(true); setError("");
    const controller = new AbortController();
    abort.current = controller;
    try {
      const out = await getInsights(ideas, { signal: controller.signal });
      setData(out);
      try { localStorage.setItem(CACHE, JSON.stringify({ fp, data: out })); } catch { /* storage full: still show the result */ }
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "تعذّر استخراج الرؤى.");
    } finally { if (abort.current === controller) setBusy(false); }
  };

  useEffect(() => {
    if (!open) { abort.current?.abort(); setBusy(false); return; }
    const cached = readCache();
    if (cached?.fp === fp) { setData(cached.data); setError(""); }
    else { setData(null); if (online && ideas.length >= 3) void run(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => () => abort.current?.abort(), []);

  const titleOf = (id: string) => { const i = ideas.find((x) => x.id === id); return i ? getArticle(i).title : ""; };
  const keep = (title: string, angle: string) => {
    saveIdea(`${title}. ${angle}`.trim());
    setSaved((s) => new Set(s).add(title));
    onChange();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-h-[85dvh] overflow-y-auto">
        <DialogTitle className="flex items-center gap-2"><Lightbulb className="size-4 text-primary" />رؤى من كتاباتك</DialogTitle>
        {ideas.length < 3 && <p className="text-sm text-muted-foreground">سجّل ثلاث أفكار على الأقل لتظهر الرؤى.</p>}
        {busy && (
          <div className="py-8 text-center">
            <div className="inline-block size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="mt-2 text-sm text-muted-foreground">جارٍ قراءة مقالاتك واستخراج محاورها…</p>
          </div>
        )}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!online && !data && <p className="text-sm text-muted-foreground">يلزم الاتصال بالإنترنت.</p>}
        {data && (
          <div className="space-y-5">
            {data.themes.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-muted-foreground">المحاور المتكررة</h3>
                {data.themes.map((t) => (
                  <div key={t.name} className="rounded-xl border border-border p-3">
                    <p className="font-semibold">{t.name} <span className="text-xs font-normal text-muted-foreground">({t.ids.length} مقالات)</span></p>
                    {t.summary && <p className="mt-1 text-sm leading-7 text-muted-foreground">{t.summary}</p>}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {t.ids.map((id) => titleOf(id) && (
                        <button key={id} onClick={() => { onPick(titleOf(id)); onOpenChange(false); }} className="rounded-full bg-secondary px-2.5 py-1 text-xs text-secondary-foreground hover:opacity-80">{titleOf(id)}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            )}
            {data.prompts.length > 0 && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold text-muted-foreground">مقالات مقترحة لتكتبها</h3>
                {data.prompts.map((p) => (
                  <div key={p.title} className="rounded-xl border border-border p-3">
                    <p className="font-semibold">{p.title}</p>
                    {p.angle && <p className="mt-1 text-sm leading-7 text-muted-foreground">{p.angle}</p>}
                    <Button size="sm" variant="outline" className="mt-2" disabled={saved.has(p.title)} onClick={() => keep(p.title, p.angle)}>
                      <PlusCircle />{saved.has(p.title) ? "حُفظت كفكرة ✓" : "احفظها كفكرة"}
                    </Button>
                  </div>
                ))}
              </section>
            )}
            <Button variant="ghost" size="sm" onClick={() => void run()} disabled={busy || !online}><RefreshCw />تحديث الرؤى</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
