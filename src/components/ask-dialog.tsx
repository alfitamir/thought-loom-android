import { useEffect, useRef, useState } from "react";
import { MessageCircleQuestion, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { askIdeas } from "@/lib/ai-features";
import type { AskAnswer } from "@/lib/ai-prompts";
import type { Idea } from "@/lib/ideas";
import { getArticle } from "@/lib/ideas";

const EXAMPLES = [
  "ما موقفي من علاقة الدين بالدولة؟",
  "أين تناقضت أفكاري؟",
  "ما الذي كتبته عن الأسرة والتربية؟",
];

export function AskDialog({
  open,
  onOpenChange,
  ideas,
  online,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ideas: Idea[];
  online: boolean;
  onPick: (title: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<AskAnswer | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      abort.current?.abort();
      setBusy(false);
    }
  }, [open]);
  useEffect(() => () => abort.current?.abort(), []);

  const ask = async (q = question) => {
    const text = q.trim();
    if (!text || busy) return;
    setQuestion(text);
    setError("");
    setResult(null);
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      setResult(await askIdeas(text, ideas, { signal: controller.signal }));
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "تعذّر الحصول على جواب.");
    } finally {
      if (abort.current === controller) setBusy(false);
    }
  };

  const titleOf = (id: string) => {
    const i = ideas.find((x) => x.id === id);
    return i ? getArticle(i).title : "";
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-h-[85dvh] overflow-y-auto">
        <DialogTitle className="flex items-center gap-2">
          <MessageCircleQuestion className="size-4 text-primary" />
          اسأل أفكاري
        </DialogTitle>
        <p className="text-sm text-muted-foreground">
          اسأل عن موقفك أو ما كتبته؛ الجواب يعتمد على مقالاتك وحدها ومعه المقالات التي اعتمد عليها.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
          className="space-y-2"
        >
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="اكتب سؤالك…"
            className="w-full rounded-xl border border-border bg-card p-3 text-card-foreground outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex gap-2">
            <Button type="submit" disabled={!online || busy || !question.trim()} className="flex-1">
              {busy ? "جارٍ البحث في مقالاتك…" : "اسأل"}
            </Button>
            {busy && (
              <Button
                type="button"
                variant="outline"
                onClick={() => abort.current?.abort()}
                aria-label="إيقاف"
              >
                <Square />
              </Button>
            )}
          </div>
          {!online && <p className="text-xs text-muted-foreground">يلزم الاتصال بالإنترنت.</p>}
        </form>
        {!result && !busy && !error && (
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((q) => (
              <button
                key={q}
                onClick={() => void ask(q)}
                disabled={!online}
                className="inline-flex min-h-11 items-center rounded-full bg-secondary px-3 py-1.5 text-xs text-secondary-foreground hover:opacity-80 disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {result && (
          <div className="space-y-3">
            <p className="whitespace-pre-wrap leading-8">{result.answer}</p>
            {result.sources.length > 0 && (
              <div className="space-y-1.5 border-t border-border pt-3">
                <p className="text-xs font-semibold text-muted-foreground">
                  المقالات التي اعتمد عليها
                </p>
                {result.sources.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      onPick(titleOf(s.id));
                      onOpenChange(false);
                    }}
                    className="block w-full rounded-lg border border-border p-2.5 text-right hover:bg-accent"
                  >
                    <span className="block text-sm font-medium">{titleOf(s.id)}</span>
                    {s.note && (
                      <span className="block text-xs text-muted-foreground">{s.note}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
