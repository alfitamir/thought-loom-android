import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { articleTopic, getArticle, matchesArticle, partitionIdeas, sortWithPinnedFirst, type Idea } from "@/lib/ideas";
import { syncNow } from "@/lib/sync";
import { Button } from "@/components/ui/button";
import { loadVisibleIdeas, PENDING_DELETE_GRACE_MS } from "@/lib/pending-deletes";
import { requestDelete, undoDelete } from "@/lib/delete-flow";
import { toast } from "sonner";
import { ArticleEditor } from "@/components/article-editor";
import { ArrowRight, ChevronDown, ChevronUp, Music, Search, X } from "lucide-react";
import { countOccurrences } from "@/lib/search-highlight";

export const Route = createFileRoute("/songs")({
  head: () => ({
    meta: [
      { title: "الأغاني — أفكاري" },
      { name: "description", content: "أغانيك المسجلة بصوتك في قسم مستقل، بعيدًا عن مقالاتك." },
      { property: "og:title", content: "الأغاني — أفكاري" },
      { property: "og:description", content: "أغانيك المسجلة بصوتك في قسم مستقل، بعيدًا عن مقالاتك." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: SongsSection,
});

/**
 * «الأغاني»: the songs' own section, a partition exactly like the
 * medical one. It reads ONLY the songs side of the visible ideas and
 * reuses the library's card machinery — the same song editor (player,
 * Drive state, share, lyrics), the same search with highlighting, the
 * same undoable delete — while the main library never shows a single
 * song. Songs are born from the home recorder's song mode; this section
 * is where they live, not where they are captured, and they are never
 * selectable for document compile or offered to any merge.
 */
export function SongsSection() {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [online, setOnline] = useState(true);
  const [currentMatch, setCurrentMatch] = useState<number | null>(null);

  const refresh = () => setIdeas(partitionIdeas(loadVisibleIdeas()).songs);
  /** Same undoable delete as everywhere: gone now, «تراجع» for the
   *  grace window, real removal (recording + Drive copy too) only when
   *  it expires. */
  const handleDelete = (idea: Idea) => {
    requestDelete(idea.id);
    toast("حُذفت الأغنية", {
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

  // A flat list — songs are recordings, not topic material — with
  // hand-pinned songs riding to the top, as in every other view.
  const visible = sortWithPinnedFirst(ideas.filter((i) => matchesArticle(i, query)));

  // Search-highlight accounting, in the exact order songs render below
  // (same scheme as the library and the medical section, over the songs
  // partition only — a match counts title occurrences before lyrics).
  const queryActive = !!query.trim();
  const matchStarts = new Map<string, number>();
  let totalMatches = 0;
  if (queryActive) {
    for (const i of visible) {
      const a = getArticle(i);
      matchStarts.set(i.id, totalMatches);
      totalMatches += countOccurrences(a.title, query) + countOccurrences(a.body, query);
    }
  }
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
        <h1 className="flex items-center gap-2.5 font-display text-3xl text-foreground">
          <Music className="size-8 text-primary" />الأغاني{ideas.length > 0 && <span className="text-xl text-muted-foreground"> ({ideas.length})</span>}
        </h1>
        <div className="flex gap-2">
          <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="بحث في الأغاني" title="بحث في الأغاني" onClick={() => { setSearchOpen(!searchOpen); setQuery(""); }}><Search /></Button>
          <Button asChild variant="ghost" size="icon" className="[&_svg]:size-5"><Link to="/library" aria-label="رجوع إلى المكتبة" title="رجوع إلى المكتبة"><ArrowRight /></Link></Button>
        </div>
      </header>
      {searchOpen && <div className="mb-6">
        <div className="flex items-center gap-2 border-b border-border pb-3">
          <Search className="size-5 shrink-0 text-muted-foreground" />
          <input autoFocus type="search" aria-label="كلمة البحث في الأغاني" placeholder="ابحث بكلمة…" value={query} onChange={(e) => setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent py-2 text-lg outline-none" />
          <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="إغلاق البحث" onClick={() => { setSearchOpen(false); setQuery(""); }}><X /></Button>
        </div>
        {queryActive && <div className="flex items-center gap-2 pt-2">
          {totalMatches > 0 && <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">{totalMatches} مرة في {visible.length} أغنية</span>}
          {totalMatches === 0 && visible.length > 0 && <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">لا نتائج</span>}
          {safeCurrent !== null && <span className="shrink-0 whitespace-nowrap text-sm font-medium text-foreground">{safeCurrent + 1} من {totalMatches}</span>}
          <span className="ms-auto flex items-center gap-2">
            <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="النتيجة السابقة" title="النتيجة السابقة" disabled={!totalMatches} onClick={() => goToMatch(-1)}><ChevronUp /></Button>
            <Button variant="ghost" size="icon" className="[&_svg]:size-5" aria-label="النتيجة التالية" title="النتيجة التالية" disabled={!totalMatches} onClick={() => goToMatch(1)}><ChevronDown /></Button>
          </span>
        </div>}
      </div>}
      {ideas.length === 0 && !query.trim() && (
        <div className="mt-16 flex flex-col items-center gap-4 text-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-secondary text-primary"><Music className="size-8" /></span>
          <p className="max-w-sm font-article text-xl leading-relaxed text-foreground">لسه مفيش أغاني هنا — سجّل أغنيتك بصوتك من الشاشة الرئيسية (وضع «أغنية»)، وهتعيش هنا لوحدها، بعيدًا عن مقالاتك.</p>
          <Button asChild className="rounded-full px-5"><Link to="/">سجّل أغنية</Link></Button>
        </div>
      )}
      {visible.length === 0 && (ideas.length > 0 || !!query.trim()) && <p className="mt-16 text-center text-muted-foreground">لا نتائج — لا توجد أغاني تحتوي على هذه الكلمة.</p>}
      <div className="space-y-3">
        {visible.map((i) => (
          <ArticleEditor key={i.id} idea={i} topic={articleTopic(i)} online={online} onChange={refresh} onDelete={() => handleDelete(i)}
            searchQuery={queryActive ? query : undefined} matchStartIndex={matchStarts.get(i.id)} currentMatchIndex={safeCurrent} />
        ))}
      </div>
    </div></main>
  );
}
