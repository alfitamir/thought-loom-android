import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { classify, deleteIdea, getArticle, loadIdeas, matchesArticle, type Idea } from "@/lib/ideas";
import { deleteIdeaCloud, syncNow } from "@/lib/sync";
import { Button } from "@/components/ui/button";
import { ArticleEditor } from "@/components/article-editor";
import { ArrowRight, ChevronDown, Search, X } from "lucide-react";

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
  const refresh = () => setIdeas(loadIdeas());
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
          <Button variant="ghost" size="icon" aria-label="بحث في المقالات" title="بحث في المقالات" onClick={() => { setSearchOpen(!searchOpen); setQuery(""); }}><Search /></Button>
          <Button asChild variant="ghost" size="icon"><Link to="/" aria-label="رجوع" title="رجوع"><ArrowRight /></Link></Button>
        </div>
      </header>
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
