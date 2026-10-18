import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { improveFull } from "@/lib/article-ai";
import { classify, deleteIdea, getArticle, loadIdeas, matchesArticle, needsPolish, updateArticle, type Idea } from "@/lib/ideas";
import { deleteIdeaCloud, pushIdea, syncNow } from "@/lib/sync";
import { Button } from "@/components/ui/button";
import { ArticleEditor } from "@/components/article-editor";
import { ArrowRight, ChevronDown, Search, Sparkles, Square, X } from "lucide-react";

export const Route = createFileRoute("/library")({
  head: () => ({
    meta: [
      { title: "مقالاتي المبوبة — أفكاري" },
      { name: "description", content: "أفكارك مرتبة في مقالات بسيطة حسب الموضوع." },
      { property: "og:title", content: "مقالاتي المبوبة — أفكاري" },
      { property: "og:description", content: "أفكارك مرتبة في مقالات بسيطة حسب الموضوع." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Library,
});

function Library() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [online, setOnline] = useState(true);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);
  const [bulkMsg, setBulkMsg] = useState("");
  const bulkAbort = useRef<AbortController | null>(null);
  const refresh = () => setIdeas(loadIdeas());
  const polishAll = async () => {
    setBulkMsg("");
    const { data } = await supabase.auth.getSession();
    if (!data.session) { setBulkMsg("سجّل الدخول من الصفحة الرئيسية لتفعيل الضبط."); return; }
    const queue = loadIdeas().filter(needsPolish);
    if (!queue.length) { setBulkMsg("كل المقالات مضبوطة ✓"); return; }
    const controller = new AbortController(); bulkAbort.current = controller;
    let done = 0, skipped = 0; setBulk({ done, total: queue.length });
    try {
      for (const idea of queue) {
        if (controller.signal.aborted || !navigator.onLine) break;
        const samples = loadIdeas().filter((i) => i.id !== idea.id).slice(0, 3).map((i) => i.text.slice(0, 2000));
        try {
          const result = await improveFull(getArticle(idea), idea.text, samples, data.session.access_token, controller.signal, () => {});
          const latest = loadIdeas().find((i) => i.id === idea.id);
          if (latest && (latest.updatedAt ?? 0) === (idea.updatedAt ?? 0)) {
            const updated = updateArticle(idea.id, result.title, result.body, true);
            if (updated) void pushIdea(updated).catch(() => {});
          }
        } catch (error) {
          if (controller.signal.aborted) break;
          const msg = error instanceof Error ? error.message : "";
          if (msg.includes("ناقصة")) { skipped++; } else { setBulkMsg(msg || "توقف الضبط. يمكنك المتابعة لاحقًا."); break; }
        }
        done++; setBulk({ done, total: queue.length }); refresh();
      }
    } finally {
      bulkAbort.current = null; setBulk(null); refresh();
      setBulkMsg((m) => m || (controller.signal.aborted || done < queue.length ? `توقف الضبط بعد ${done} من ${queue.length}. اضغط لاحقًا للمتابعة.` : `تم ضبط المقالات ✓${skipped ? ` (تُرك ${skipped} كما هو لأن النسخة المقترحة كانت ناقصة)` : ""}`));
    }
  };
  useEffect(() => {
    refresh(); setOnline(navigator.onLine);
    const connect = () => { setOnline(true); void syncNow().catch(() => {}); };
    const disconnect = () => setOnline(false);
    void syncNow().catch(() => {});
    window.addEventListener("online", connect);
    window.addEventListener("offline", disconnect);
    window.addEventListener("afkari:ideas-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("online", connect); window.removeEventListener("offline", disconnect);
      window.removeEventListener("afkari:ideas-changed", refresh); window.removeEventListener("storage", refresh);
    };
  }, []);

  const groups: Record<string, Idea[]> = {};
  ideas.filter((i) => matchesArticle(i, query)).forEach((i) => (groups[classify(getArticle(i).body)] ??= []).push(i));

  return (
    <main dir="rtl" className="paper min-h-screen px-5 py-6"><div className="mx-auto max-w-3xl">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-3xl text-foreground">مقالاتي</h1>
        <div className="flex gap-2">
          {online && ideas.length > 0 && (bulk
            ? <Button variant="ghost" size="icon" aria-label="إيقاف الضبط" title="إيقاف الضبط" onClick={() => bulkAbort.current?.abort()}><Square /></Button>
            : <Button variant="ghost" size="icon" aria-label="ضبط كل المقالات" title="ضبط كل المقالات" onClick={polishAll}><Sparkles /></Button>)}
          <Button variant="ghost" size="icon" aria-label="بحث في المقالات" title="بحث في المقالات" onClick={() => { setSearchOpen(!searchOpen); setQuery(""); }}><Search /></Button>
          <Button asChild variant="ghost" size="icon"><Link to="/" aria-label="رجوع" title="رجوع"><ArrowRight /></Link></Button>
        </div>
      </header>
      {(bulk || bulkMsg) && <p role="status" className="mb-4 text-sm text-muted-foreground">{bulk ? `جارٍ الضبط… تم ${bulk.done} من ${bulk.total}` : bulkMsg}</p>}
      {searchOpen && <div className="mb-6 flex items-center gap-2 border-b border-border pb-3">
        <Search className="size-5 shrink-0 text-muted-foreground" />
        <input autoFocus type="search" aria-label="كلمة البحث" placeholder="ابحث بكلمة…" value={query} onChange={(e) => setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-lg outline-none" />
        <Button variant="ghost" size="icon" aria-label="إغلاق البحث" onClick={() => { setSearchOpen(false); setQuery(""); }}><X /></Button>
      </div>}
      {ideas.length === 0 && <p className="mt-20 text-center text-muted-foreground">لا توجد أفكار بعد.</p>}
      {ideas.length > 0 && Object.keys(groups).length === 0 && <p className="mt-16 text-center text-muted-foreground">لا توجد مقالات تحتوي على هذه الكلمة.</p>}
      <div className="space-y-3">
        {Object.entries(groups).map(([topic, list]) => (
          <section key={topic}>
            <Button variant="ghost" onClick={() => setOpenTopic(openTopic === topic ? null : topic)} aria-expanded={!!query.trim() || openTopic === topic}
              className="h-auto w-full justify-between border-b border-border px-0 py-4 text-start">
              <span className="whitespace-normal font-display text-xl text-foreground">{topic}</span>
              <span className="flex items-center gap-3 text-muted-foreground">{list.length}<ChevronDown className={openTopic === topic ? "rotate-180" : ""} /></span>
            </Button>
            {(query.trim() || openTopic === topic) && (
              <div>
                {list.map((i) => <ArticleEditor key={i.id} idea={i} online={online} onChange={refresh} onDelete={() => { deleteIdea(i.id); void deleteIdeaCloud(i.id).catch(() => {}); refresh(); }} />)}
              </div>
            )}
          </section>
        ))}
      </div>
    </div></main>
  );
}
