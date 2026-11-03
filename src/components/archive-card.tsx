import { useEffect, useState } from "react";
import { Archive, Heart, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { ArticleEditor } from "@/components/article-editor";
import { articleTopic, getArticle, type Idea } from "@/lib/ideas";
import { loadVisibleIdeas, PENDING_DELETE_GRACE_MS } from "@/lib/pending-deletes";
import { requestDelete, undoDelete } from "@/lib/delete-flow";
import {
  archiveAgeLabel, archiveDayKey, archivePool, isArchiveDismissed,
  parseArchiveCycle, pickArchiveIdea, serializeArchiveCycle,
} from "@/lib/archive-pick";

// «من أرشيفك»: one old idea resurfaces on the home screen each day (the
// pick logic lives in archive-pick.ts). The dismiss and the «واحدة تانية»
// offset live in localStorage keyed by the calendar day — both reset on
// their own tomorrow, no cleanup pass needed.
const DISMISS_KEY = "afkari.archiveDismissed";
const CYCLE_KEY = "afkari.archiveCycle";

const readLocal = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const writeLocal = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* private mode: the card just forgets */ }
};

export function ArchiveCard() {
  // Surfaces read the VISIBLE ideas: anything pending deletion (inside its
  // undo window) is already gone from here, exactly as in the library.
  const [ideas, setIdeas] = useState<Idea[]>(() => loadVisibleIdeas());
  const [online, setOnline] = useState(() => navigator.onLine);
  const [offset, setOffset] = useState(() => parseArchiveCycle(readLocal(CYCLE_KEY)));
  const [dismissed, setDismissed] = useState(() => isArchiveDismissed(readLocal(DISMISS_KEY)));
  const [openedId, setOpenedId] = useState<string | null>(null);

  const refresh = () => setIdeas(loadVisibleIdeas());
  useEffect(() => {
    refresh();
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    window.addEventListener("afkari:ideas-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.removeEventListener("afkari:ideas-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  /** Same undoable delete as the library: gone now, «تراجع» for the grace
   *  window, real removal only when it expires. */
  const handleDelete = (idea: Idea) => {
    requestDelete(idea.id);
    toast(idea.song ? "حُذفت الأغنية" : "حُذف المقال", {
      duration: PENDING_DELETE_GRACE_MS,
      action: { label: "تراجع", onClick: () => { undoDelete(idea.id); } },
    });
    if (openedId === idea.id) setOpenedId(null);
    refresh();
  };

  // An opened idea stays open on its fresh record even after an edit makes
  // it too "new" for the pool — closing it by hand is the only way out.
  const opened = openedId ? ideas.find((i) => i.id === openedId) : undefined;
  if (openedId && opened) {
    return (
      <section className="w-full max-w-md rounded-2xl border border-border bg-card p-4 text-start shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <Archive className="size-4" />من أرشيفك
          </span>
          <button type="button" aria-label="إغلاق المقال" title="إغلاق المقال" onClick={() => setOpenedId(null)}
            className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>
        <ArticleEditor idea={opened} topic={articleTopic(opened)} online={online} onChange={refresh} onDelete={() => handleDelete(opened)} />
      </section>
    );
  }

  if (dismissed) return null;
  const picked = pickArchiveIdea(ideas, Date.now(), offset);
  if (!picked) return null; // small or fresh library: no card, no placeholder

  const article = getArticle(picked);
  const flat = article.body.replace(/\s+/g, " ").trim();
  const preview = flat.length > 110 ? `${flat.slice(0, 110)}…` : flat;
  const poolSize = archivePool(ideas).length;

  const cycle = () => {
    const next = offset + 1;
    setOffset(next);
    writeLocal(CYCLE_KEY, serializeArchiveCycle(next));
  };
  const dismiss = () => {
    writeLocal(DISMISS_KEY, archiveDayKey());
    setDismissed(true);
  };

  return (
    <section className="w-full max-w-md rounded-2xl border border-border bg-card p-4 text-start shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <Archive className="size-4" />من أرشيفك
        </span>
        <button type="button" aria-label="إخفاء البطاقة اليوم" title="إخفاء البطاقة اليوم" onClick={dismiss}
          className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
      <button type="button" onClick={() => setOpenedId(picked.id)} className="block w-full text-start" aria-label={`فتح: ${article.title}`}>
        <h2 className="break-words font-display text-lg leading-snug text-primary">{article.title}</h2>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground">
            التصنيف: {articleTopic(picked)}
          </span>
          {picked.liked && (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium text-rose-600 dark:text-rose-400">
              <Heart className="size-3.5" />أعجبني
            </span>
          )}
          {(picked.sources ?? []).map((s) => (
            <span key={s} className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground" title={`يتضمن مقالًا من: ${s}`}>
              يتضمن مقالًا من: {s}
            </span>
          ))}
        </div>
        {picked.liked && picked.source && (
          <p className="mt-1.5 break-words text-sm text-foreground">المصدر: {picked.source}</p>
        )}
        {preview && <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted-foreground">{preview}</p>}
      </button>
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{archiveAgeLabel(picked)}</span>
        {poolSize > 1 && (
          <button type="button" onClick={cycle}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground hover:bg-accent">
            <RefreshCw className="size-3.5" />واحدة تانية
          </button>
        )}
      </div>
    </section>
  );
}
