import { useEffect, useRef, useState } from "react";
import { Check, Copy, Lightbulb, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { deleteIdea, getArticle, loadIdeas, saveArticleIdea, type Idea } from "@/lib/ideas";
import { deleteIdeaCloud, pushIdea } from "@/lib/sync";
import { getGeminiKey } from "@/lib/gemini";
import {
  dismissSuggestion, findMerges, fingerprint, liveSuggestions, loadSuggestionCache, mergeArticles, saveSuggestionCache,
  type MergeSuggestion,
} from "@/lib/merge";

export function MergeBanner({ ideas, online, onChange }: { ideas: Idea[]; online: boolean; onChange: () => void }) {
  const [list, setList] = useState<MergeSuggestion[]>([]);
  const [hasKey, setHasKey] = useState(false);
  const [active, setActive] = useState<MergeSuggestion | null>(null);
  const tried = useRef(new Set<string>());

  useEffect(() => {
    const read = () => setHasKey(!!getGeminiKey());
    read();
    window.addEventListener("afkari:settings-changed", read);
    return () => window.removeEventListener("afkari:settings-changed", read);
  }, []);

  useEffect(() => {
    const cache = loadSuggestionCache();
    setList(liveSuggestions(cache?.list ?? [], ideas));
    const key = getGeminiKey();
    const fp = fingerprint(ideas);
    if (!online || !key || ideas.length < 2 || cache?.fp === fp || tried.current.has(fp)) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      tried.current.add(fp);
      try {
        const found = await findMerges(ideas, key, controller.signal);
        saveSuggestionCache(fp, found);
        setList(liveSuggestions(found, loadIdeas()));
      } catch { /* suggestions are optional; try again after the next change */ }
    }, 2500);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [ideas, online, hasKey]);

  const current = list[0];
  if (!current || !hasKey) return null;
  return <>
    <div role="note" className="mb-5 flex items-start gap-3 rounded-xl border border-border bg-card p-4">
      <Lightbulb className="mt-0.5 size-5 shrink-0 text-primary" />
      <button className="min-w-0 flex-1 text-start" onClick={() => setActive(current)}>
        <span className="block text-foreground">نقترح دمج {current.ids.length} مقالات في مقال واحد: «{current.title}»</span>
        {current.reason && <span className="mt-1 block text-sm text-muted-foreground">{current.reason}</span>}
        <span className="mt-1 block text-sm text-primary underline">اضغط للمعاينة</span>
      </button>
      <Button variant="ghost" size="icon" aria-label="تجاهل الاقتراح" title="تجاهل الاقتراح" onClick={() => { dismissSuggestion(current.ids); setList(list.slice(1)); }}><X /></Button>
    </div>
    {active && <MergeDialog suggestion={active} online={online} onClose={(done) => {
      setActive(null);
      if (done) { setList((l) => l.filter((s) => s !== active)); onChange(); }
    }} />}
  </>;
}

function MergeDialog({ suggestion, online, onClose }: { suggestion: MergeSuggestion; online: boolean; onClose: (done: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const [result, setResult] = useState<{ title: string; body: string } | null>(null);
  const [message, setMessage] = useState("");
  const abort = useRef<AbortController | null>(null);
  const versions = useRef(new Map<string, number>());
  const sources = suggestion.ids.map((id) => loadIdeas().find((i) => i.id === id)).filter((i): i is Idea => !!i);

  const run = async () => {
    const key = getGeminiKey();
    if (!key) { setMessage("أضف مفتاح Gemini من الإعدادات ⚙️."); return; }
    if (!navigator.onLine) { setMessage("الدمج يحتاج اتصالًا بالإنترنت."); return; }
    const controller = new AbortController(); abort.current = controller;
    versions.current = new Map(sources.map((s) => [s.id, s.updatedAt ?? 0]));
    setBusy(true); setMessage(""); setResult(null); setPreview("");
    try {
      setResult(await mergeArticles(sources.map(getArticle), key, controller.signal, setPreview));
    } catch (error) {
      setMessage(controller.signal.aborted ? "توقف الدمج؛ مقالاتك لم تتغير." : error instanceof Error ? error.message : "تعذّر الدمج الآن.");
    } finally { setBusy(false); abort.current = null; }
  };
  useEffect(() => { void run(); return () => abort.current?.abort(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = (removeOriginals: boolean) => {
    if (!result || !result.title.trim() || !result.body.trim()) return;
    const latest = loadIdeas();
    const changed = sources.some((s) => {
      const now = latest.find((i) => i.id === s.id);
      return !now || (now.updatedAt ?? 0) !== versions.current.get(s.id);
    });
    if (changed) { setMessage("تغيرت إحدى المقالات أثناء الدمج. لم نغير شيئًا."); return; }
    const merged = saveArticleIdea(sources.map((s) => s.text).join("\n\n"), result.title, result.body);
    if (removeOriginals) sources.forEach((s) => { deleteIdea(s.id); void deleteIdeaCloud(s.id).catch(() => {}); });
    dismissSuggestion(suggestion.ids);
    void pushIdea(merged).catch(() => {});
    onClose(true);
  };

  return <Dialog open onOpenChange={(open) => { if (!open) { abort.current?.abort(); onClose(false); } }}>
    <DialogContent dir="rtl" className="max-h-[90dvh] overflow-y-auto">
      <DialogTitle className="text-start font-display">معاينة الدمج</DialogTitle>
      <div className="text-sm text-muted-foreground">
        <p>المقالات الأصلية:</p>
        <ul className="mt-1 list-inside list-disc">{sources.map((s) => <li key={s.id}>{getArticle(s).title}</li>)}</ul>
      </div>
      {result ? <div className="space-y-3">
        <input aria-label="عنوان المقال المدمج" value={result.title} onChange={(e) => setResult({ ...result, title: e.target.value })}
          className="w-full rounded-md border border-input bg-card px-3 py-2 font-display text-lg outline-none focus:ring-2 focus:ring-ring" />
        <textarea aria-label="نص المقال المدمج" value={result.body} onChange={(e) => setResult({ ...result, body: e.target.value })} rows={12}
          className="w-full rounded-md border border-input bg-card p-3 font-article text-xl leading-loose outline-none focus:ring-2 focus:ring-ring" />
      </div> : <div aria-live="polite" className="whitespace-pre-wrap break-words font-article text-xl leading-loose">{busy ? preview || "جارٍ الدمج بأسلوبك…" : ""}</div>}
      {message && <p role="status" className="break-words text-sm text-muted-foreground">{message}</p>}
      <div className="flex flex-wrap gap-2">
        {busy ? <Button variant="outline" onClick={() => abort.current?.abort()}><Square />إيقاف</Button>
          : result ? <>
            <Button onClick={() => approve(true)} disabled={!result.title.trim() || !result.body.trim()}><Check />اعتماد وحذف الأصول</Button>
            <Button variant="outline" onClick={() => approve(false)} disabled={!result.title.trim() || !result.body.trim()}><Copy />حفظه كمقال جديد</Button>
          </> : <Button variant="outline" disabled={!online} onClick={run}>إعادة المحاولة</Button>}
        <Button variant="ghost" onClick={() => { abort.current?.abort(); onClose(false); }}>إلغاء</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
