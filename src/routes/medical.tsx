import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { articleTopic, getArticle, matchesArticle, partitionIdeas, sortWithPinnedFirst, type Idea } from "@/lib/ideas";
import { syncNow } from "@/lib/sync";
import { Button } from "@/components/ui/button";
import { listArticleIdsWithAudio } from "@/lib/article-audio";
import { loadVisibleIdeas, PENDING_DELETE_GRACE_MS } from "@/lib/pending-deletes";
import { requestDelete, undoDelete } from "@/lib/delete-flow";
import { toast } from "sonner";
import { ArticleEditor } from "@/components/article-editor";
import { CompileBar } from "@/components/compile-bar";
import { RecordFab } from "@/components/record-fab";
import { Checkbox } from "@/components/ui/checkbox";
import { isSelectable, selectedIdeas, toggleSelected } from "@/lib/document";
import { ArrowRight, ChevronDown, ChevronUp, ListChecks, Mic, PenLine, Search, Stethoscope, X } from "lucide-react";
import { countOccurrences } from "@/lib/search-highlight";

export const Route = createFileRoute("/medical")({
  head: () => ({
    meta: [
      { title: "القسم الطبي — أفكاري" },
      { name: "description", content: "مقالاتك الطبية في قسم مستقل، مرتبة حسب الموضوع." },
      { property: "og:title", content: "القسم الطبي — أفكاري" },
      { property: "og:description", content: "مقالاتك الطبية في قسم مستقل، مرتبة حسب الموضوع." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: MedicalSection,
});

/**
 * «القسم الطبي»: a section entirely its own. It reads ONLY the medical
 * partition of the visible ideas and reuses the library's machinery —
 * topic groups with hand-pinned topics, pinned-first order, the same
 * article cards, the same search with highlighting, the same undoable
 * delete — while the main library never shows a single medical article.
 * Capture is section-first: both buttons deep-link to the home recorder
 * carrying the medical context, so anything dictated or written there is
 * born inside this section.
 */
export function MedicalSection() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [online, setOnline] = useState(true);
  const [currentMatch, setCurrentMatch] = useState<number | null>(null);
  // Selection mode for «تجميع في مستند» — the same machinery as the main
  // library, over the medical partition only. Leaving clears the picks.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const exitSelection = () => { setSelecting(false); setSelected(new Set()); };
  const chosen = selectedIdeas(ideas, selected);
  // Articles with generated audio cached on this device — drives the
  // «صوت» badge on article cards, exactly as in the library.
  const [audioIds, setAudioIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let alive = true;
    listArticleIdsWithAudio().then((ids) => { if (alive) setAudioIds(ids); }).catch(() => {});
    return () => { alive = false; };
  }, [ideas]);

  const refresh = () => setIdeas(partitionIdeas(loadVisibleIdeas()).medical);
  /** Same undoable delete as the library: gone now, «تراجع» for the
   *  grace window, real removal only when it expires. */
  const handleDelete = (idea: Idea) => {
    requestDelete(idea.id);
    toast("حُذف المقال", {
      duration: PENDING_DELETE_GRACE_MS,
      action: { label: "تراجع", onClick: () => { undoDelete(idea.id); } },
    });
    refresh();
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
  ideas.filter((i) => matchesArticle(i, query)).forEach((i) => (groups[articleTopic(i)] ??= []).push(i));
  // Hand-pinned articles ride to the top of their own topic group.
  for (const list of Object.values(groups)) {
    const sorted = sortWithPinnedFirst(list);
    list.splice(0, list.length, ...sorted);
  }

  // Search-highlight accounting, in the exact order articles render below
  // (same scheme as the library, over the medical partition only).
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

  // Both capture paths land on the home form with the medical context:
  // the recorder opens there and everything saved from it is born medical.
  const captureSearch = { record: Date.now(), section: "medical" as const };

  return (
    <main dir="rtl" className="paper min-h-screen px-5 pb-24 pt-6"><div className="mx-auto max-w-3xl">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="flex items-center gap-2.5 font-display text-3xl text-foreground">
          <Stethoscope className="size-8 text-primary" />القسم الطبي{ideas.length > 0 && <span className="text-xl text-muted-foreground"> ({ideas.length})</span>}
        </h1>
        <div className="flex gap-2">
          <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="بحث في القسم الطبي" title="بحث في القسم الطبي" onClick={() => { setSearchOpen(!searchOpen); setQuery(""); }}><Search /></Button>
          <Button asChild variant="ghost" size="icon" className="[&_svg]:size-5"><Link to="/library" aria-label="رجوع إلى المكتبة" title="رجوع إلى المكتبة"><ArrowRight /></Link></Button>
        </div>
      </header>
      <div className="mb-5 flex flex-wrap gap-2">
        <Button asChild className="rounded-full px-4"><Link to="/" search={captureSearch}><Mic />سجّل فكرة طبية</Link></Button>
        <Button asChild variant="outline" className="rounded-full px-4"><Link to="/" search={captureSearch}><PenLine />اكتب فكرة طبية</Link></Button>
        <Button variant={selecting ? "default" : "outline"} className="rounded-full px-4" aria-pressed={selecting} onClick={() => (selecting ? exitSelection() : setSelecting(true))}><ListChecks />اختيار</Button>
      </div>
      {searchOpen && <div className="mb-6">
        <div className="flex items-center gap-2 border-b border-border pb-3">
          <Search className="size-5 shrink-0 text-muted-foreground" />
          <input autoFocus type="search" aria-label="كلمة البحث في القسم الطبي" placeholder="ابحث بكلمة…" value={query} onChange={(e) => setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-lg outline-none" />
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
        <div className="mt-16 flex flex-col items-center gap-4 text-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-secondary text-primary"><Stethoscope className="size-8" /></span>
          <p className="max-w-sm font-article text-xl leading-relaxed text-foreground">القسم الطبي فاضي لسه — مقالاتك الطبية هتعيش هنا لوحدها، بعيدًا عن بقية أفكارك.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild className="rounded-full px-5"><Link to="/" search={captureSearch}><Mic />سجّل فكرة طبية</Link></Button>
            <Button asChild variant="outline" className="rounded-full px-5"><Link to="/" search={captureSearch}><PenLine />اكتب فكرة طبية</Link></Button>
          </div>
        </div>
      )}
      {Object.keys(groups).length === 0 && (ideas.length > 0 || !!query.trim()) && <p className="mt-16 text-center text-muted-foreground">لا نتائج — لا توجد مقالات طبية تحتوي على هذه الكلمة.</p>}
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
                  const selectable = selecting && isSelectable(i);
                  return (
                    <div key={i.id} className={selectable ? "flex items-start gap-2.5" : undefined}>
                      {selectable && (
                        <Checkbox checked={selected.has(i.id)} onCheckedChange={() => setSelected((s) => toggleSelected(s, i.id))}
                          aria-label={`اختيار مقالة: ${getArticle(i).title}`} className="mt-7 size-5 shrink-0 [&_svg]:size-4" />
                      )}
                      <div className={selectable ? "min-w-0 flex-1" : undefined}>
                        <ArticleEditor idea={i} topic={topic} online={online} hasAudio={audioIds.has(i.id)} onChange={refresh} onDelete={() => handleDelete(i)}
                          searchQuery={queryActive ? query : undefined} matchStartIndex={matchStarts.get(i.id)} currentMatchIndex={safeCurrent} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ))}
      </div>
      {selecting && <CompileBar ideas={chosen} onCancel={exitSelection} />}
      {/* The bottom navigation (and its record button) never reaches this
          route, so the section carries its own floating record action —
          same deep link as the capture buttons above, medical context on. */}
      <RecordFab section="medical" />
    </div></main>
  );
}
