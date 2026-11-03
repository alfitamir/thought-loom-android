import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { cleanFull } from "@/lib/article-ai";
import { resolveEngine } from "@/lib/ai-engine";
import { articleTopic, deleteIdea, getArticle, loadIdeas, matchesArticle, needsPolish, updateArticle, type Idea } from "@/lib/ideas";
import { deleteIdeaCloud, pushIdea, syncNow } from "@/lib/sync";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { deleteSongAudio, listArticleIdsWithAudio } from "@/lib/article-audio";
import { deleteSongDriveCopy } from "@/lib/song-drive";
import { ArticleEditor } from "@/components/article-editor";
import { MergeBanner } from "@/components/merge-banner";
import { LikedDialog } from "@/components/liked-dialog";
import { AskDialog } from "@/components/ask-dialog";
import { InsightsDialog } from "@/components/insights-dialog";
import { labelAll, labelFor, loadLabels, unlabeled } from "@/lib/ai-labels";
import { ArrowRight, ChevronDown, ChevronUp, Feather, Heart, Lightbulb, MessageCircleQuestion, MoreHorizontal, Search, Sparkles, Square, Tags, X } from "lucide-react";
import { countOccurrences } from "@/lib/search-highlight";

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
  const [currentMatch, setCurrentMatch] = useState<number | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const [likedOpen, setLikedOpen] = useState(false);
  const [likedOnly, setLikedOnly] = useState(false);
  const [labels, setLabels] = useState(loadLabels);
  // Articles with generated audio cached on this device (one store pass per
  // ideas change) — drives the «صوت» badge on article cards.
  const [audioIds, setAudioIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let alive = true;
    listArticleIdsWithAudio().then((ids) => { if (alive) setAudioIds(ids); }).catch(() => {});
    return () => { alive = false; };
  }, [ideas]);
  const [labeling, setLabeling] = useState<{ done: number; total: number } | null>(null);
  const [labelError, setLabelError] = useState("");
  const refresh = () => { setIdeas(loadIdeas()); setLabels(loadLabels()); };
  const stale = unlabeled(ideas).length;
  const classifyAll = async () => {
    setLabelError(""); setLabeling({ done: 0, total: stale });
    try { await labelAll(ideas, { onProgress: (done, total) => setLabeling({ done, total }) }); }
    catch (e) { setLabelError(e instanceof Error ? e.message : "تعذّر التصنيف."); }
    finally { setLabeling(null); refresh(); }
  };
  const pick = (title: string) => { setQuery(title); setSearchOpen(true); };
  const polishAll = async () => {
    setBulkMsg("");
    const engine = await resolveEngine();
    if (typeof engine === "string") { setBulkMsg(engine); return; }
    // Songs are never polished: their text is the author's own lyrics, and
    // no AI pass may rewrite them.
    const queue = loadIdeas().filter((i) => !i.song && needsPolish(i));
    if (!queue.length) { setBulkMsg("كل المقالات مضبوطة ✓"); return; }
    const controller = new AbortController(); bulkAbort.current = controller;
    let done = 0, skipped = 0; setBulk({ done, total: queue.length });
    try {
      for (const idea of queue) {
        if (controller.signal.aborted || !navigator.onLine) break;
        try {
          const result = await cleanFull(getArticle(idea), engine, controller.signal, () => {});
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
    window.addEventListener("afkari:labels-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("online", connect); window.removeEventListener("offline", disconnect);
      window.removeEventListener("afkari:ideas-changed", refresh); window.removeEventListener("afkari:labels-changed", refresh); window.removeEventListener("storage", refresh);
    };
  }, []);

  const likedCount = ideas.filter((i) => i.liked).length;
  const groups: Record<string, Idea[]> = {};
  ideas.filter((i) => matchesArticle(i, query) && (!likedOnly || i.liked)).forEach((i) => (groups[articleTopic(i)] ??= []).push(i));

  // Search-highlight accounting, in the exact order articles render below
  // (topic groups in order, title occurrences before body occurrences), so a
  // global match index identifies one rendered <mark data-match-idx="…">.
  const queryActive = !!query.trim();
  const matchStarts = new Map<string, number>();
  let totalMatches = 0;
  if (queryActive) {
    for (const list of Object.values(groups)) {
      for (const i of list) {
        const a = getArticle(i);
        matchStarts.set(i.id, totalMatches);
        totalMatches += countOccurrences(a.title, query) + countOccurrences(a.body, query);
      }
    }
  }
  const articlesCount = Object.values(groups).reduce((n, l) => n + l.length, 0);
  const safeCurrent = currentMatch !== null && totalMatches > 0 ? Math.min(currentMatch, totalMatches - 1) : null;
  const goToMatch = (delta: number) => {
    if (!totalMatches) return;
    setCurrentMatch((prev) => (prev === null ? (delta > 0 ? 0 : totalMatches - 1) : (prev + delta + totalMatches) % totalMatches));
  };
  useEffect(() => { setCurrentMatch(null); }, [query]);
  useEffect(() => {
    if (safeCurrent === null) return;
    const raf = requestAnimationFrame(() => {
      document.querySelector(`mark[data-match-idx="${safeCurrent}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [safeCurrent]);

  return (
    <main dir="rtl" className="paper min-h-screen px-5 pb-24 pt-6"><div className="mx-auto max-w-3xl">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-3xl text-foreground">مقالاتي{ideas.length > 0 && <span className="text-xl text-muted-foreground"> ({ideas.length})</span>}</h1>
        <div className="flex gap-2">
          {/* Cleanup now lives in the tools row's «المزيد» menu; while a bulk
              cleanup runs, its stop control stays here in the header. */}
          {online && ideas.length > 0 && bulk
            ? <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="إيقاف الضبط" title="إيقاف الضبط" onClick={() => bulkAbort.current?.abort()}><Square /></Button>
            : null}
          <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="بحث في المقالات" title="بحث في المقالات" onClick={() => { setSearchOpen(!searchOpen); setQuery(""); }}><Search /></Button>
          <Button asChild variant="ghost" size="icon" className="[&_svg]:size-5"><Link to="/" aria-label="رجوع" title="رجوع"><ArrowRight /></Link></Button>
        </div>
      </header>
      {(bulk || bulkMsg) && <p role="status" className="mb-4 text-sm text-muted-foreground">{bulk ? `جارٍ الضبط… تم ${bulk.done} من ${bulk.total}` : bulkMsg}</p>}
      {ideas.length > 0 && <div className="mb-4 flex flex-wrap gap-2">
        <button onClick={() => setAskOpen(true)} className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"><MessageCircleQuestion className="size-5" />اسأل أفكاري</button>
        <button onClick={() => setInsightsOpen(true)} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-medium text-foreground hover:bg-accent"><Lightbulb className="size-5" />رؤى</button>
        {likedCount > 0 && (
          <button onClick={() => setLikedOnly(!likedOnly)} aria-pressed={likedOnly} className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium ${likedOnly ? "bg-rose-500 text-white hover:opacity-90" : "border border-border bg-card text-foreground hover:bg-accent"}`}><Heart className="size-5" />أعجبني ({likedCount})</button>
        )}
        <DropdownMenu dir="rtl">
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label="المزيد" className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-sm font-medium text-foreground hover:bg-accent"><MoreHorizontal className="size-5" />المزيد</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-64">
            <DropdownMenuItem aria-label="إضافة مقال أعجبني" onSelect={() => setLikedOpen(true)} className="[&>svg]:size-5"><Heart />مقال أعجبني — إضافة مقال من مصدر آخر</DropdownMenuItem>
            <DropdownMenuItem aria-label="تنظيف كل المقالات (حذف الشوائب وضبط الإملاء والترقيم فقط)" disabled={!online || !!bulk} onSelect={() => void polishAll()} className="[&>svg]:size-5"><Sparkles />تنظيف كل المقالات (حذف الشوائب وضبط الإملاء والترقيم فقط)</DropdownMenuItem>
            {stale > 0 && (
              <DropdownMenuItem aria-label="صنّف بالذكاء الاصطناعي" disabled={!online || !!labeling} onSelect={() => void classifyAll()} className="[&>svg]:size-5">
                <Tags />{labeling ? `جارٍ التصنيف ${labeling.done}/${labeling.total}…` : `صنّف بالذكاء الاصطناعي (${stale})`}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>}
      {labelError && <p role="alert" className="mb-4 text-sm text-destructive">{labelError}</p>}
      <MergeBanner ideas={ideas} online={online} onChange={refresh} />
      <AskDialog open={askOpen} onOpenChange={setAskOpen} ideas={ideas} online={online} onPick={pick} />
      <LikedDialog open={likedOpen} onOpenChange={setLikedOpen} onSaved={refresh} />
      <InsightsDialog open={insightsOpen} onOpenChange={setInsightsOpen} ideas={ideas} online={online} onChange={refresh} onPick={pick} />
      {searchOpen && <div className="mb-6">
        <div className="flex items-center gap-2 border-b border-border pb-3">
          <Search className="size-5 shrink-0 text-muted-foreground" />
          <input autoFocus type="search" aria-label="كلمة البحث" placeholder="ابحث بكلمة…" value={query} onChange={(e) => setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-lg outline-none" />
          <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="إغلاق البحث" onClick={() => { setSearchOpen(false); setQuery(""); }}><X /></Button>
        </div>
        {queryActive && <div className="flex items-center gap-2 pt-2">
          {totalMatches > 0 && <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">{totalMatches} مرة في {articlesCount} مقالة</span>}
          {totalMatches === 0 && articlesCount > 0 && <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">لا نتائج</span>}
          {safeCurrent !== null && <span className="shrink-0 whitespace-nowrap text-sm font-medium text-foreground">{safeCurrent + 1} من {totalMatches}</span>}
          <span className="ms-auto flex items-center gap-2">
            <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="النتيجة السابقة" title="النتيجة السابقة" disabled={!totalMatches} onClick={() => goToMatch(-1)}><ChevronUp /></Button>
            <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="النتيجة التالية" title="النتيجة التالية" disabled={!totalMatches} onClick={() => goToMatch(1)}><ChevronDown /></Button>
          </span>
        </div>}
      </div>}
      {ideas.length === 0 && !query.trim() && (
        <div className="mt-20 flex flex-col items-center gap-4 text-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-secondary text-primary"><Feather className="size-8" /></span>
          <p className="max-w-sm font-article text-xl leading-relaxed text-foreground">لسه مفيش مقالات هنا… كل مقال عظيم بدأ بفكرة واحدة اتقالت في لحظة.</p>
          <Button asChild className="rounded-full px-5"><Link to="/">سجّل فكرتك الأولى</Link></Button>
        </div>
      )}
      {Object.keys(groups).length === 0 && (ideas.length > 0 || !!query.trim()) && <p className="mt-16 text-center text-muted-foreground">لا نتائج — لا توجد مقالات تحتوي على هذه الكلمة.</p>}
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
                {list.map((i) => {
                  const tags = labelFor(i, labels).tags;
                  return <div key={i.id}>
                    {tags.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-4">
                        {tags.map((t) => (
                          <button key={t} onClick={() => pick(t)} className="rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground hover:opacity-80">#{t}</button>
                        ))}
                      </div>
                    )}
                    <ArticleEditor idea={i} topic={topic} online={online} hasAudio={audioIds.has(i.id)} onChange={refresh} onDelete={() => { deleteIdea(i.id); if (i.song) { void deleteSongAudio(i.id).catch(() => {}); void deleteSongDriveCopy(i).catch(() => {}); } void deleteIdeaCloud(i.id).catch(() => {}); refresh(); }}
                      searchQuery={queryActive ? query : undefined} matchStartIndex={matchStarts.get(i.id)} currentMatchIndex={safeCurrent} />
                  </div>;
                })}
              </div>
            )}
          </section>
        ))}
      </div>
    </div></main>
  );
}
