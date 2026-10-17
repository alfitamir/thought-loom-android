import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { classify, deleteIdea, loadIdeas, toArticle, type Idea } from "@/lib/ideas";
import { deleteIdeaCloud } from "@/lib/sync";

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
  useEffect(() => setIdeas(loadIdeas()), []);

  const groups: Record<string, Idea[]> = {};
  ideas.forEach((i) => (groups[classify(i.text)] ??= []).push(i));

  return (
    <main dir="rtl" className="paper min-h-screen px-5 py-6">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-3xl text-foreground">مقالاتي</h1>
        <Link to="/" className="icon-btn" aria-label="رجوع">→</Link>
      </header>
      {ideas.length === 0 && <p className="mt-20 text-center text-muted-foreground">لا توجد أفكار بعد.</p>}
      <div className="space-y-3">
        {Object.entries(groups).map(([topic, list]) => (
          <section key={topic} className="rounded-2xl border border-border bg-card">
            <button onClick={() => setOpenTopic(openTopic === topic ? null : topic)}
              className="flex w-full items-center justify-between p-4 text-start">
              <span className="font-display text-xl text-card-foreground">{topic}</span>
              <span className="rounded-full bg-accent px-3 py-1 text-sm text-accent-foreground">{list.length}</span>
            </button>
            {openTopic === topic && (
              <div className="space-y-6 border-t border-border p-4">
                {list.map((i) => {
                  const a = toArticle(i.text);
                  return (
                    <article key={i.id}>
                      <h2 className="font-display text-lg text-primary">{a.title}</h2>
                      <p className="mb-2 text-xs text-muted-foreground">{new Date(i.createdAt).toLocaleDateString("ar")}</p>
                      {a.paragraphs.map((p, k) => <p key={k} className="mb-2 font-article text-lg leading-loose text-card-foreground">{p}</p>)}
                      <button onClick={() => { deleteIdea(i.id); deleteIdeaCloud(i.id); setIdeas(loadIdeas()); }} className="text-xs text-destructive">حذف</button>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        ))}
      </div>
    </main>
  );
}
