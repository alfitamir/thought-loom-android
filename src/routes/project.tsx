import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  articleTopic,
  clearProject,
  getArticle,
  matchesArticle,
  partitionIdeas,
  renameProject,
  sortWithPinnedFirst,
  type Idea,
} from "@/lib/ideas";
import { syncNow } from "@/lib/sync";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { listArticleIdsWithAudio } from "@/lib/article-audio";
import { loadVisibleIdeas, PENDING_DELETE_GRACE_MS } from "@/lib/pending-deletes";
import { requestDelete, undoDelete } from "@/lib/delete-flow";
import { toast } from "sonner";
import { ArticleEditor } from "@/components/article-editor";
import { CompileBar } from "@/components/compile-bar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  downloadDocument,
  isSelectable,
  printDocument,
  selectedIdeas,
  toggleSelected,
} from "@/lib/document";
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  FileDown,
  FileText,
  FolderOpen,
  ListChecks,
  Pencil,
  Printer,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { countOccurrences } from "@/lib/search-highlight";
import { arabicNumber } from "@/lib/format";

export const Route = createFileRoute("/project")({
  // `?project=<name>` names the project; `&section=medical` scopes it to
  // the medical partition (the house pattern for route state — projects
  // are (section, name) pairs, and the name itself rides in the URL).
  validateSearch: (search: Record<string, unknown>): { project?: string; section?: "medical" } => ({
    ...(typeof search["project"] === "string" && search["project"].trim()
      ? { project: search["project"].trim() }
      : {}),
    ...(search["section"] === "medical" ? { section: "medical" as const } : {}),
  }),
  head: () => ({
    meta: [
      { title: "المشروع — أفكاري" },
      {
        name: "description",
        content: "مقالات مشروع واحد — كتاب أو سلسلة أو ملف موضوع — في مكان واحد.",
      },
      { property: "og:title", content: "المشروع — أفكاري" },
      {
        property: "og:description",
        content: "مقالات مشروع واحد — كتاب أو سلسلة أو ملف موضوع — في مكان واحد.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ProjectRoute,
});

function ProjectRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const medical = search.section === "medical";
  return (
    <ProjectView
      project={search.project ?? ""}
      medical={medical}
      onRenamed={(next) =>
        void navigate({
          search: { project: next, ...(medical ? { section: "medical" as const } : {}) },
        })
      }
      onDeleted={() => void navigate({ to: medical ? "/medical" : "/library" })}
    />
  );
}

/**
 * A project's own page: ONLY its member articles, inside ONE partition —
 * the general library's project and the medical section's same-named
 * project are different projects and never mix here. The list machinery
 * is the library's (topic groups, pinned-first, search with highlights,
 * selection compile, undoable delete); on top of it the project carries
 * its three housekeeping actions: compile the WHOLE project into one
 * document, rename it (this section's members only), or dissolve it
 * (members are unassigned — the articles themselves are never touched).
 */
export function ProjectView({
  project,
  medical,
  onRenamed,
  onDeleted,
}: {
  project: string;
  medical: boolean;
  onRenamed?: (next: string) => void;
  onDeleted?: () => void;
}) {
  const [name, setName] = useState(project);
  useEffect(() => {
    setName(project);
  }, [project]);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [openTopic, setOpenTopic] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [online, setOnline] = useState(true);
  const [currentMatch, setCurrentMatch] = useState<number | null>(null);
  // Selection mode for «تجميع في مستند» — the shared machinery, over the
  // project's members only. Leaving the mode clears the picks.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const exitSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };
  const [compileOpen, setCompileOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Articles with generated audio cached on this device — the «صوت» badge.
  const [audioIds, setAudioIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let alive = true;
    listArticleIdsWithAudio()
      .then((ids) => {
        if (alive) setAudioIds(ids);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ideas]);

  const refresh = () => setIdeas(partitionIdeas(loadVisibleIdeas())[medical ? "medical" : "main"]);
  const members = ideas.filter((i) => i.project === name);
  const chosen = selectedIdeas(members, selected);
  /** Same undoable delete as the library: gone now, «تراجع» for the
   *  grace window, real removal only when it expires. */
  const handleDelete = (idea: Idea) => {
    requestDelete(idea.id);
    toast(idea.song ? "حُذفت الأغنية" : "حُذف المقال", {
      duration: PENDING_DELETE_GRACE_MS,
      action: {
        label: "تراجع",
        onClick: () => {
          undoDelete(idea.id);
        },
      },
    });
    refresh();
  };
  useEffect(() => {
    refresh();
    setOnline(navigator.onLine);
    const connect = () => {
      setOnline(true);
      void syncNow();
    };
    const disconnect = () => setOnline(false);
    void syncNow();
    window.addEventListener("online", connect);
    window.addEventListener("offline", disconnect);
    window.addEventListener("afkari:ideas-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("online", connect);
      window.removeEventListener("offline", disconnect);
      window.removeEventListener("afkari:ideas-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [medical]);

  const announce = () => {
    window.dispatchEvent(new Event("afkari:ideas-changed"));
    void syncNow();
  };
  const doRename = () => {
    const next = renameDraft.trim();
    const n = renameProject(medical, name, next);
    setRenameOpen(false);
    if (!n) return;
    setName(next);
    refresh();
    announce();
    onRenamed?.(next);
    toast(`أُعيدت تسمية المشروع إلى «${next}» ✓`);
  };
  const doDeleteProject = () => {
    const n = clearProject(medical, name);
    setDeleteOpen(false);
    if (!n) return;
    refresh();
    announce();
    toast("حُذف المشروع — المقالات نفسها لم تُمسّ ✓");
    onDeleted?.();
  };
  const printAll = () => {
    if (!printDocument(members)) {
      toast("المتصفح منع فتح نافذة الطباعة — اسمح بالنوافذ المنبثقة وحاول مجددًا.");
      return;
    }
    setCompileOpen(false);
  };
  const downloadAll = () => {
    downloadDocument(members);
    setCompileOpen(false);
  };

  const queryActive = !!query.trim();
  // Memoized list model (same scheme as the library, audit F-5.1).
  const { groups, matchStarts, totalMatches, articlesCount } = useMemo(() => {
    const groups: Record<string, Idea[]> = {};
    members
      .filter((i) => matchesArticle(i, query))
      .forEach((i) => (groups[articleTopic(i)] ??= []).push(i));
    // Hand-pinned articles ride to the top of their own topic group.
    for (const list of Object.values(groups)) {
      const sorted = sortWithPinnedFirst(list);
      list.splice(0, list.length, ...sorted);
    }
    // Search-highlight accounting, in the exact order articles render
    // below (same scheme as the library and the medical section).
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
    return { groups, matchStarts, totalMatches, articlesCount };
  }, [members, query, queryActive]);
  const safeCurrent =
    currentMatch !== null && totalMatches > 0 ? Math.min(currentMatch, totalMatches - 1) : null;
  const goToMatch = (delta: number) => {
    if (!totalMatches) return;
    setCurrentMatch((prev) =>
      prev === null
        ? delta > 0
          ? 0
          : totalMatches - 1
        : (prev + delta + totalMatches) % totalMatches,
    );
  };
  useEffect(() => {
    setCurrentMatch(null);
  }, [query]);
  useEffect(() => {
    if (safeCurrent === null) return;
    const raf = requestAnimationFrame(() => {
      document
        .querySelector(`mark[data-match-idx="${safeCurrent}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(raf);
  }, [safeCurrent]);

  const backTo = medical ? "/medical" : "/library";

  return (
    <main dir="rtl" className="paper min-h-screen px-5 pb-24 pt-6">
      <div className="mx-auto max-w-3xl">
        <header className="mb-6 flex items-center justify-between">
          <h1 className="flex min-w-0 items-center gap-2.5 font-display text-3xl text-foreground">
            <FolderOpen className="size-8 shrink-0 text-primary" />
            <span className="min-w-0 truncate">{name}</span>
            {members.length > 0 && (
              <span className="shrink-0 text-xl text-muted-foreground">
                {" "}
                ({arabicNumber(members.length)})
              </span>
            )}
          </h1>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="[&_svg]:size-5"
              aria-label="بحث في المشروع"
              title="بحث في المشروع"
              onClick={() => {
                setSearchOpen(!searchOpen);
                setQuery("");
              }}
            >
              <Search />
            </Button>
            <Button asChild variant="ghost" size="icon" className="[&_svg]:size-5">
              <Link to={backTo} aria-label="رجوع" title="رجوع">
                <ArrowRight />
              </Link>
            </Button>
          </div>
        </header>
        {members.length > 0 && (
          <div className="mb-5 flex flex-wrap gap-2">
            <Button className="rounded-full px-4" onClick={() => setCompileOpen(true)}>
              <FileText />
              تجميع المشروع في مستند
            </Button>
            <Button
              variant="outline"
              className="rounded-full px-4"
              onClick={() => {
                setRenameDraft(name);
                setRenameOpen(true);
              }}
            >
              <Pencil />
              إعادة تسمية المشروع
            </Button>
            <Button
              variant="outline"
              className="rounded-full px-4 text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 />
              حذف المشروع
            </Button>
            <Button
              variant={selecting ? "default" : "outline"}
              className="rounded-full px-4"
              aria-pressed={selecting}
              onClick={() => (selecting ? exitSelection() : setSelecting(true))}
            >
              <ListChecks />
              اختيار
            </Button>
          </div>
        )}
        {searchOpen && (
          <div className="mb-6">
            <div className="flex items-center gap-2 border-b border-border pb-3">
              <Search className="size-5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                type="search"
                aria-label="كلمة البحث في المشروع"
                placeholder="ابحث بكلمة…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-0 flex-1 bg-transparent py-2 text-lg outline-none"
              />
              <Button
                variant="ghost"
                size="icon"
                className="[&_svg]:size-5"
                aria-label="إغلاق البحث"
                onClick={() => {
                  setSearchOpen(false);
                  setQuery("");
                }}
              >
                <X />
              </Button>
            </div>
            {queryActive && (
              <div className="flex items-center gap-2 pt-2">
                {totalMatches > 0 && (
                  <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">
                    {arabicNumber(totalMatches)} مرة في {arabicNumber(articlesCount)} مقالة
                  </span>
                )}
                {totalMatches === 0 && articlesCount > 0 && (
                  <span className="shrink-0 whitespace-nowrap text-sm text-muted-foreground">
                    لا نتائج
                  </span>
                )}
                {safeCurrent !== null && (
                  <span className="shrink-0 whitespace-nowrap text-sm font-medium text-foreground">
                    {arabicNumber(safeCurrent + 1)} من {arabicNumber(totalMatches)}
                  </span>
                )}
                <span className="ms-auto flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="[&_svg]:size-5"
                    aria-label="النتيجة السابقة"
                    title="النتيجة السابقة"
                    disabled={!totalMatches}
                    onClick={() => goToMatch(-1)}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="[&_svg]:size-5"
                    aria-label="النتيجة التالية"
                    title="النتيجة التالية"
                    disabled={!totalMatches}
                    onClick={() => goToMatch(1)}
                  >
                    <ChevronDown />
                  </Button>
                </span>
              </div>
            )}
          </div>
        )}
        {members.length === 0 && !query.trim() && (
          <div className="mt-16 flex flex-col items-center gap-4 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-secondary text-primary">
              <FolderOpen className="size-8" />
            </span>
            <p className="max-w-sm font-article text-xl leading-relaxed text-foreground">
              لا يوجد مشروع بهذا الاسم في هذا القسم — ربما حُذف أو غُيّر اسمه.
            </p>
            <Button asChild className="rounded-full px-5">
              <Link to={backTo}>رجوع إلى {medical ? "القسم الطبي" : "المكتبة"}</Link>
            </Button>
          </div>
        )}
        {Object.keys(groups).length === 0 && members.length > 0 && (
          <p className="mt-16 text-center text-muted-foreground">
            لا نتائج — لا توجد مقالات في المشروع تحتوي على هذه الكلمة.
          </p>
        )}
        <div className="space-y-3">
          {Object.entries(groups).map(([topic, list]) => (
            <section key={topic}>
              <Button
                variant="ghost"
                onClick={() => setOpenTopic(openTopic === topic ? null : topic)}
                aria-expanded={!!query.trim() || openTopic === topic}
                className="h-auto w-full justify-between border-b border-border px-0 py-4 text-start"
              >
                <span className="whitespace-normal font-display text-xl text-foreground">
                  {topic}
                </span>
                <span className="flex items-center gap-3 text-muted-foreground">
                  {arabicNumber(list.length)}
                  <ChevronDown className={openTopic === topic ? "rotate-180" : ""} />
                </span>
              </Button>
              {(query.trim() || openTopic === topic) && (
                <div>
                  {list.map((i) => {
                    const selectable = selecting && isSelectable(i);
                    return (
                      <div
                        key={i.id}
                        className={selectable ? "flex items-start gap-2.5" : undefined}
                      >
                        {selectable && (
                          <Checkbox
                            checked={selected.has(i.id)}
                            onCheckedChange={() => setSelected((s) => toggleSelected(s, i.id))}
                            aria-label={`اختيار مقالة: ${getArticle(i).title}`}
                            className="mt-7 size-5 shrink-0 [&_svg]:size-4"
                          />
                        )}
                        <div className={selectable ? "min-w-0 flex-1" : undefined}>
                          <ArticleEditor
                            idea={i}
                            topic={topic}
                            online={online}
                            hasAudio={audioIds.has(i.id)}
                            onChange={refresh}
                            onDelete={() => handleDelete(i)}
                            searchQuery={queryActive ? query : undefined}
                            matchStartIndex={matchStarts.get(i.id)}
                            currentMatchIndex={safeCurrent}
                          />
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
        {/* Compile the WHOLE project: the same two document deliveries as
          the selection compile, over every member article. */}
        <Dialog open={compileOpen} onOpenChange={setCompileOpen}>
          <DialogContent dir="rtl" className="max-h-[88dvh] overflow-y-auto">
            <DialogTitle className="flex items-center gap-2 text-start font-display">
              <FileText className="size-5 text-primary" />
              <span>تجميع مشروع «{name}» في مستند واحد</span>
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              {arabicNumber(members.length)} {members.length === 1 ? "مقالة" : "مقالات"} — المستند
              مرتّب حسب الموضوع، والمقالات الأقدم أولًا داخل كل موضوع، والنصوص كما هي تمامًا دون أي
              تعديل.
            </p>
            <div className="flex flex-col gap-2 pt-1">
              <Button className="w-full rounded-full" onClick={downloadAll}>
                <FileDown />
                تنزيل Markdown
              </Button>
              <Button variant="outline" className="w-full rounded-full" onClick={printAll}>
                <Printer />
                طباعة / PDF
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
          <DialogContent dir="rtl" className="max-h-[88dvh] overflow-y-auto">
            <DialogTitle className="text-start font-display">إعادة تسمية المشروع</DialogTitle>
            <input
              aria-label="اسم المشروع الجديد"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              placeholder="اسم المشروع…"
              onKeyDown={(e) => {
                if (e.key === "Enter" && renameDraft.trim() && renameDraft.trim() !== name)
                  doRename();
              }}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-sm text-muted-foreground">
              سيتغيّر الاسم عند مقالات هذا القسم فقط — مشروع بنفس الاسم في القسم الآخر لا يتأثر.
            </p>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setRenameOpen(false)}>
                إلغاء
              </Button>
              <Button
                disabled={!renameDraft.trim() || renameDraft.trim() === name}
                onClick={doRename}
              >
                حفظ الاسم الجديد
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent dir="rtl" className="max-h-[88dvh] overflow-y-auto">
            <DialogTitle className="text-start font-display">حذف مشروع «{name}»؟</DialogTitle>
            <p className="text-sm text-muted-foreground">
              ستُزال مقالات هذا القسم من المشروع فقط — المقالات نفسها لا تُحذف ولا يتغيّر فيها أي
              شيء.
            </p>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
                إلغاء
              </Button>
              <Button variant="destructive" onClick={doDeleteProject}>
                حذف المشروع
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </main>
  );
}
