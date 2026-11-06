import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, Copy, Layers, Lightbulb, Square, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { EvidenceDialog } from "@/components/evidence-dialog";
import {
  deleteIdea,
  getArticle,
  loadIdeas,
  mergeAttributions,
  mergeSourceVersions,
  saveArticleIdea,
  type Idea,
} from "@/lib/ideas";
import { MergeIncompleteError, missingMergeLines } from "@/lib/article-ai";
import { loadVisibleIdeas } from "@/lib/pending-deletes";
import { deleteSongAudio } from "@/lib/article-audio";
import { deleteSongDriveCopy } from "@/lib/song-drive";
import { pushIdea } from "@/lib/sync";
import { getGeminiKey } from "@/lib/gemini";
import { resolveEngine } from "@/lib/ai-engine";
import { arabicNumber } from "@/lib/format";
import {
  dismissSuggestion,
  findMerges,
  fingerprint,
  liveSuggestions,
  loadSuggestionCache,
  mergeArticles,
  saveSuggestionCache,
  type MergeSuggestion,
} from "@/lib/merge";

export function MergeBanner({
  ideas,
  online,
  onChange,
}: {
  ideas: Idea[];
  online: boolean;
  onChange: () => void;
}) {
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
        // Automatic suggestions use only the free personal key, never platform credits.
        const found = await findMerges(ideas, { kind: "gemini", key }, controller.signal);
        saveSuggestionCache(fp, found);
        setList(liveSuggestions(found, loadVisibleIdeas()));
      } catch {
        /* suggestions are optional; try again after the next change */
      }
    }, 2500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [ideas, online, hasKey]);

  const current = list[0];
  if (!current || !hasKey) return null;
  return (
    <>
      <div
        role="note"
        className="mb-5 flex items-start gap-3 rounded-xl border border-border bg-card p-4"
      >
        <Lightbulb className="mt-0.5 size-5 shrink-0 text-primary" />
        <button className="min-w-0 flex-1 text-start" onClick={() => setActive(current)}>
          <span className="block text-foreground">
            نقترح دمج{" "}
            {current.ids.length === 2 ? "مقالين" : `${arabicNumber(current.ids.length)} مقالات`} في
            مقال واحد: «{current.title}»
          </span>
          {current.reason && (
            <span className="mt-1 block text-sm text-muted-foreground">{current.reason}</span>
          )}
          <span className="mt-1 block text-sm text-primary underline">اضغط للمعاينة</span>
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="تجاهل الاقتراح"
          title="تجاهل الاقتراح"
          onClick={() => {
            dismissSuggestion(current.ids);
            setList(list.slice(1));
          }}
        >
          <X />
        </Button>
      </div>
      {active && (
        <MergeDialog
          suggestion={active}
          online={online}
          onClose={(done) => {
            setActive(null);
            if (done) {
              setList((l) => l.filter((s) => s !== active));
              onChange();
            }
          }}
        />
      )}
    </>
  );
}

function MergeDialog({
  suggestion,
  online,
  onClose,
}: {
  suggestion: MergeSuggestion;
  online: boolean;
  onClose: (done: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const [result, setResult] = useState<{ title: string; body: string } | null>(null);
  // A proposal that failed the completeness guard: shown WITH the exact lines
  // it dropped, and applicable only via the explicit «قبول رغم النقص» action.
  const [incomplete, setIncomplete] = useState<{
    title: string;
    body: string;
    missing: string[];
  } | null>(null);
  // Consecutive failed AI attempts in this session; after 2, the guaranteed
  // manual concatenation fallback is offered.
  const [failures, setFailures] = useState(0);
  const [manual, setManual] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualBody, setManualBody] = useState("");
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [message, setMessage] = useState("");
  const abort = useRef<AbortController | null>(null);
  const versions = useRef(new Map<string, number>());
  const manualVersions = useRef(new Map<string, number>());
  const sources = suggestion.ids
    .map((id) => loadVisibleIdeas().find((i) => i.id === id))
    .filter((i): i is Idea => !!i);
  const sourceBodies = sources.map((s) => getArticle(s).body);

  const run = async () => {
    if (!navigator.onLine) {
      setMessage("الدمج يحتاج اتصالًا بالإنترنت.");
      return;
    }
    const engine = await resolveEngine();
    if (typeof engine === "string") {
      setMessage(engine);
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    versions.current = new Map(sources.map((s) => [s.id, s.updatedAt ?? 0]));
    setBusy(true);
    setMessage("");
    setResult(null);
    setIncomplete(null);
    setManual(false);
    setPreview("");
    const mine = () => abort.current === controller;
    try {
      const merged = await mergeArticles(
        sources.map(getArticle),
        engine,
        controller.signal,
        (t) => {
          if (mine()) setPreview(t);
        },
      );
      if (mine()) {
        setResult(merged);
        setFailures(0);
      }
    } catch (error) {
      if (!mine()) return;
      if (controller.signal.aborted) {
        setMessage("توقف الدمج؛ مقالاتك لم تتغير.");
        return;
      }
      setFailures((f) => f + 1);
      if (error instanceof MergeIncompleteError) {
        setIncomplete({
          title: error.proposal.title,
          body: error.proposal.body,
          missing: error.missing,
        });
        setMessage(error.message);
      } else {
        setMessage(error instanceof Error ? error.message : "تعذّر الدمج الآن.");
      }
    } finally {
      if (mine()) {
        setBusy(false);
        abort.current = null;
      }
    }
  };
  useEffect(() => {
    void run();
    return () => abort.current?.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = (proposal: { title: string; body: string }, removeOriginals: boolean) => {
    if (!proposal.title.trim() || !proposal.body.trim()) return;
    const latest = loadIdeas();
    const changed = sources.some((s) => {
      const now = latest.find((i) => i.id === s.id);
      return !now || (now.updatedAt ?? 0) !== versions.current.get(s.id);
    });
    if (changed) {
      setMessage("تغيرت إحدى المقالات أثناء الدمج. لم نغير شيئًا.");
      return;
    }
    const origins = [...new Set(sources.flatMap((s) => [s.id, ...(s.mergedFrom ?? [])]))];
    // When the originals are about to be consumed, their full texts are
    // frozen onto the merged article as 'merge' versions first (read from
    // the freshest records) — the merge can never make a text vanish.
    // When the originals stay, they ARE the record; no copies are made.
    const frozenSources = removeOriginals
      ? mergeSourceVersions(sources.map((s) => latest.find((i) => i.id === s.id) ?? s))
      : undefined;
    const merged = saveArticleIdea(
      sources.map((s) => s.text).join("\n\n"),
      proposal.title,
      proposal.body,
      origins,
      frozenSources ? { versions: frozenSources } : undefined,
    );
    if (removeOriginals)
      sources.forEach((s) => {
        deleteIdea(s.id);
        if (s.song) {
          void deleteSongAudio(s.id).catch(() => {});
          void deleteSongDriveCopy(s).catch(() => {});
        }
      });
    dismissSuggestion(suggestion.ids);
    void pushIdea(merged).catch(() => {});
    onClose(true);
  };

  /** Editing an incomplete proposal re-checks it live: paste the lines back and it becomes a normal, complete result. */
  const editIncomplete = (patch: Partial<{ title: string; body: string }>) => {
    if (!incomplete) return;
    const next = { ...incomplete, ...patch };
    const missing = missingMergeLines(sourceBodies, next.body);
    if (!missing.length) {
      setResult({ title: next.title, body: next.body });
      setIncomplete(null);
      setMessage("");
    } else setIncomplete({ ...next, missing });
  };

  /** Guaranteed fallback: plain sequential concatenation — zero loss, attribution preserved, section preserved. */
  const enterManual = () => {
    manualVersions.current = new Map(sources.map((s) => [s.id, s.updatedAt ?? 0]));
    setManualTitle(suggestion.title || (sources[0] ? getArticle(sources[0]).title : ""));
    setManualBody(sourceBodies.join("\n\n"));
    setManual(true);
    setMessage("");
  };

  const approveManual = (removeOriginals: boolean) => {
    if (!manualTitle.trim() || !manualBody.trim()) return;
    const latest = loadIdeas();
    const changed = sources.some((s) => {
      const now = latest.find((i) => i.id === s.id);
      return !now || (now.updatedAt ?? 0) !== manualVersions.current.get(s.id);
    });
    if (changed) {
      setMessage("تغيّرت إحدى المقالات أثناء الدمج. لم نغيّر شيئًا.");
      return;
    }
    const origins = [...new Set(sources.flatMap((s) => [s.id, ...(s.mergedFrom ?? [])]))];
    const merged = saveArticleIdea(
      sources.map((s) => s.text).join("\n\n"),
      manualTitle,
      manualBody,
      origins,
      { ...mergeAttributions(sources), ...(sources[0]?.medical ? { medical: true } : {}) },
    );
    if (removeOriginals)
      sources.forEach((s) => {
        deleteIdea(s.id);
        if (s.song) {
          void deleteSongAudio(s.id).catch(() => {});
          void deleteSongDriveCopy(s).catch(() => {});
        }
      });
    dismissSuggestion(suggestion.ids);
    void pushIdea(merged).catch(() => {});
    onClose(true);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          abort.current?.abort();
          onClose(false);
        }
      }}
    >
      <DialogContent dir="rtl" className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0">
        <div className="shrink-0 px-6 pt-6">
          <DialogTitle className="text-start font-display">معاينة الدمج</DialogTitle>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="text-sm text-muted-foreground">
            <p>المقالات الأصلية:</p>
            <ul className="mt-1 list-inside list-disc">
              {sources.map((s) => (
                <li key={s.id}>{getArticle(s).title}</li>
              ))}
            </ul>
          </div>
          {manual ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                دمج يدوي بالتتابع: النصوص مجمّعة كما هي بالترتيب، بلا أي حذف — حرّر العنوان أو النص
                إن أردت قبل الحفظ.
              </p>
              <input
                aria-label="عنوان المقال المدمج"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                className="w-full rounded-md border border-input bg-card px-3 py-2 font-display text-lg outline-none focus:ring-2 focus:ring-ring"
              />
              <textarea
                aria-label="نص المقال المدمج"
                value={manualBody}
                onChange={(e) => setManualBody(e.target.value)}
                rows={12}
                className="w-full rounded-md border border-input bg-card p-3 font-article text-xl leading-loose outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          ) : result ? (
            <div className="space-y-3">
              <input
                aria-label="عنوان المقال المدمج"
                value={result.title}
                onChange={(e) => setResult({ ...result, title: e.target.value })}
                className="w-full rounded-md border border-input bg-card px-3 py-2 font-display text-lg outline-none focus:ring-2 focus:ring-ring"
              />
              <textarea
                aria-label="نص المقال المدمج"
                value={result.body}
                onChange={(e) => setResult({ ...result, body: e.target.value })}
                rows={12}
                className="w-full rounded-md border border-input bg-card p-3 font-article text-xl leading-loose outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          ) : incomplete ? (
            <div className="space-y-3">
              <input
                aria-label="عنوان المقال المدمج"
                value={incomplete.title}
                onChange={(e) => editIncomplete({ title: e.target.value })}
                className="w-full rounded-md border border-input bg-card px-3 py-2 font-display text-lg outline-none focus:ring-2 focus:ring-ring"
              />
              <textarea
                aria-label="نص المقال المدمج"
                value={incomplete.body}
                onChange={(e) => editIncomplete({ body: e.target.value })}
                rows={12}
                className="w-full rounded-md border border-input bg-card p-3 font-article text-xl leading-loose outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-400">
                  <TriangleAlert className="size-4 shrink-0" />
                  الأسطر غير الموجودة في النسخة المقترحة ({arabicNumber(incomplete.missing.length)}
                  ):
                </p>
                <ul className="mt-2 max-h-40 list-inside list-disc space-y-1 overflow-y-auto text-sm text-foreground">
                  {incomplete.missing.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  يمكنك لصق الأسطر الناقصة في النص أعلاه بنفسك — ستُعاد مراجعتها فورًا. وإن قبلت رغم
                  النقص يُحفظ المقال المدمج جديدًا وتبقى مقالاتك الأصلية كما هي دون حذف.
                </p>
              </div>
            </div>
          ) : (
            <div
              aria-live="polite"
              className="whitespace-pre-wrap break-words font-article text-xl leading-loose"
            >
              {busy ? preview || "جارٍ الدمج بأسلوبك…" : ""}
            </div>
          )}
          {message && (
            <p role="status" className="break-words text-sm text-muted-foreground">
              {message}
            </p>
          )}
        </div>
        {result && (
          <EvidenceDialog
            open={evidenceOpen}
            onOpenChange={setEvidenceOpen}
            title={result.title}
            body={result.body}
            online={online}
            onInsert={(snippet) =>
              setResult((r) => (r ? { ...r, body: `${r.body}\n\n${snippet}` } : r))
            }
          />
        )}
        <div className="flex shrink-0 flex-wrap gap-2 border-t border-border px-6 py-4">
          {busy ? (
            <Button variant="outline" onClick={() => abort.current?.abort()}>
              <Square />
              إيقاف
            </Button>
          ) : manual ? (
            <>
              <Button
                onClick={() => approveManual(true)}
                disabled={!manualTitle.trim() || !manualBody.trim()}
              >
                <Check />
                اعتماد وحذف الأصول
              </Button>
              <Button
                variant="outline"
                onClick={() => approveManual(false)}
                disabled={!manualTitle.trim() || !manualBody.trim()}
              >
                <Copy />
                حفظه كمقال جديد
              </Button>
              <Button variant="ghost" onClick={() => setManual(false)}>
                رجوع
              </Button>
            </>
          ) : result ? (
            <>
              <Button
                onClick={() => approve(result, true)}
                disabled={!result.title.trim() || !result.body.trim()}
              >
                <Check />
                اعتماد وحذف الأصول
              </Button>
              <Button
                variant="outline"
                onClick={() => approve(result, false)}
                disabled={!result.title.trim() || !result.body.trim()}
              >
                <Copy />
                حفظه كمقال جديد
              </Button>
              <Button
                variant="outline"
                onClick={() => setEvidenceOpen(true)}
                disabled={!online || !result.body.trim()}
              >
                <BookOpen />
                شواهد للمقال
              </Button>
            </>
          ) : (
            <>
              {incomplete && (
                <Button
                  onClick={() => approve(incomplete, false)}
                  disabled={!incomplete.title.trim() || !incomplete.body.trim()}
                >
                  <TriangleAlert />
                  قبول رغم النقص
                </Button>
              )}
              <Button variant="outline" disabled={!online} onClick={run}>
                إعادة المحاولة
              </Button>
              {failures >= 2 && (
                <Button variant="outline" onClick={enterManual}>
                  <Layers />
                  دمج يدوي بالتتابع
                </Button>
              )}
            </>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              abort.current?.abort();
              onClose(false);
            }}
          >
            إلغاء
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
