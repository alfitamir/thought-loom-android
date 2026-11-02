import { Fragment, useMemo, type ReactNode } from "react";
import { splitByQuery } from "@/lib/search-highlight";

/**
 * Renders `text` with every occurrence of `query` wrapped in a <mark>.
 * When `startIndex` is given, match marks receive sequential global indices
 * (data-match-idx, starting at startIndex) so the library search can style
 * and scroll to the "current" occurrence (currentIndex). Without
 * `startIndex` the highlight is visual only (used for the card preview,
 * whose truncated text echoes the body and must not consume indices).
 * Only React text nodes are rendered — never raw HTML.
 */
export function HighlightedText({ text, query, startIndex, currentIndex }: {
  text: string;
  query: string;
  startIndex?: number | undefined;
  currentIndex?: number | null | undefined;
}): ReactNode {
  const segments = useMemo(() => splitByQuery(text, query), [text, query]);
  let next = startIndex ?? 0;
  return (
    <>
      {segments.map((seg, i) => {
        if (!seg.match) return <Fragment key={i}>{seg.text}</Fragment>;
        const idx = startIndex === undefined ? undefined : next++;
        const isCurrent = idx !== undefined && currentIndex === idx;
        return (
          <mark
            key={i}
            data-match-idx={idx}
            className={isCurrent
              ? "rounded-sm bg-orange-400 px-px text-black ring-1 ring-orange-500"
              : "rounded-sm bg-amber-200/70 px-px text-inherit dark:bg-amber-400/30"}
          >
            {seg.text}
          </mark>
        );
      })}
    </>
  );
}
