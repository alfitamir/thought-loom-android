import { articleTopic, getArticle, type Idea } from "./ideas";

/**
 * «تجميع في مستند» — compile a hand-picked set of articles into ONE clean
 * document the owner can keep or print: a Markdown download, or a
 * print-styled HTML page (browser print → PDF). Entirely browser-side,
 * no server, and NO AI ever touches the text: article bodies pass through
 * byte-for-byte, exactly as stored.
 *
 * The composition (grouping, ordering, table of contents, attribution)
 * is pure and unit-tested here; the delivery functions stay thin.
 *
 * Attribution is absolute, as everywhere in this app: a liked article
 * always carries its «المصدر: …» line directly under its title, and one
 * of the author's own articles that absorbed a liked one through a
 * manual merge carries «يتضمن مقالًا من: …». The wording mirrors
 * share-card.ts so a card and a document never disagree.
 */

export const DOCUMENT_AUTHOR_LINE = "د. تامر رشدي الألفي";
export const DOCUMENT_APP_LINE = "أفكاري";

export type DocumentGroup = { topic: string; ideas: Idea[] };

/**
 * Group the selection by each article's own derived topic. Groups are
 * ordered busiest first (ties by Arabic topic name — the same order the
 * manual topic picker uses); inside a group, articles run oldest →
 * newest by creation date.
 */
export function documentGroups(ideas: Idea[]): DocumentGroup[] {
  const byTopic = new Map<string, Idea[]>();
  for (const idea of ideas) {
    const topic = articleTopic(idea);
    const list = byTopic.get(topic);
    if (list) list.push(idea);
    else byTopic.set(topic, [idea]);
  }
  return [...byTopic.entries()]
    .map(([topic, list]) => ({ topic, ideas: [...list].sort((a, b) => a.createdAt - b.createdAt) }))
    .sort((a, b) => b.ideas.length - a.ideas.length || a.topic.localeCompare(b.topic, "ar"));
}

/** The attribution line an article carries into the document, if any.
 *  A liked article ALWAYS has one — its own source, else the sources it
 *  accumulated, else the honest external-source fallback. */
export function documentAttribution(idea: Idea): string | undefined {
  const own = (idea.source ?? "").trim();
  const merged = (idea.sources ?? []).map((s) => s.trim()).filter(Boolean);
  if (idea.liked) {
    if (own) return `المصدر: ${own}`;
    if (merged.length) return `المصدر: ${merged.join("، ")}`;
    return "مقال من مصدر خارجي";
  }
  if (merged.length) return `يتضمن مقالًا من: ${merged.join("، ")}`;
  return undefined;
}

/** The date line format the article cards themselves use. */
export const documentDate = (ts: number): string => new Date(ts).toLocaleDateString("ar");

/** The per-article meta line: creation date + its topic. */
export const documentMetaLine = (idea: Idea): string => `${documentDate(idea.createdAt)} · ${articleTopic(idea)}`;

const pluralArticles = (n: number): string => (n === 1 ? "مقالة واحدة" : n === 2 ? "مقالتان" : `${n} مقالات`);

/**
 * Compose the selection into one Markdown document:
 *
 *   # أفكاري — د. تامر رشدي الألفي
 *   مستند مُجمّع في {date} · {n} مقالات
 *
 *   ## المحتويات            (table of contents, grouped by topic)
 *
 *   # {topic}               (one group heading per topic)
 *   ## {title}              (one heading per article)
 *   {date} · {topic}        (meta line)
 *   {attribution line}      (when the article carries one)
 *   {full text, verbatim}
 *
 * An empty selection yields the header only — the views never offer the
 * compile action with nothing selected, so this is just the safe floor.
 */
export function composeDocument(ideas: Idea[], generatedAt: Date = new Date()): string {
  const groups = documentGroups(ideas);
  const lines: string[] = [
    `# ${DOCUMENT_APP_LINE} — ${DOCUMENT_AUTHOR_LINE}`,
    "",
    `مستند مُجمّع في ${documentDate(generatedAt.getTime())} · ${pluralArticles(ideas.length)}`,
  ];
  if (!groups.length) return lines.join("\n") + "\n";

  lines.push("", "## المحتويات", "");
  for (const group of groups) {
    lines.push(`- ${group.topic} (${group.ideas.length})`);
    for (const idea of group.ideas) lines.push(`  - ${getArticle(idea).title}`);
  }
  for (const group of groups) {
    lines.push("", "---", "", `# ${group.topic}`);
    for (const idea of group.ideas) {
      const article = getArticle(idea);
      const attribution = documentAttribution(idea);
      lines.push("", `## ${article.title}`, "", documentMetaLine(idea));
      if (attribution) lines.push("", attribution);
      lines.push("", article.body);
    }
  }
  return lines.join("\n") + "\n";
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const PRINT_CSS = `
  * { box-sizing: border-box; }
  body { font-family: "Amiri", "Traditional Arabic", serif; color: #1c1a17; margin: 0; padding: 32px 28px; line-height: 1.9; }
  header.doc { text-align: center; margin-bottom: 8px; }
  header.doc h1 { font-family: "Tajawal", sans-serif; font-size: 26px; margin: 0 0 4px; }
  header.doc p { margin: 0; color: #6b675f; font-size: 14px; }
  nav.toc { border: 1px solid #ddd6c8; border-radius: 12px; padding: 16px 22px; margin: 24px 0 8px; }
  nav.toc h2 { font-family: "Tajawal", sans-serif; font-size: 18px; margin: 0 0 8px; }
  nav.toc ul { margin: 0; padding-inline-start: 20px; }
  nav.toc a { color: inherit; text-decoration: none; }
  section.group > h2 { font-family: "Tajawal", sans-serif; font-size: 21px; border-bottom: 2px solid #c9a227; padding-bottom: 6px; margin: 28px 0 4px; }
  article h3 { font-family: "Tajawal", sans-serif; font-size: 19px; margin: 18px 0 2px; }
  article p.meta { margin: 0 0 2px; color: #6b675f; font-size: 13.5px; }
  article p.source { margin: 0 0 6px; font-weight: bold; font-size: 15px; }
  article .body p { margin: 0 0 10px; font-size: 17.5px; text-align: justify; }
  @media print {
    body { padding: 0; }
    nav.toc { break-after: page; }
    article { break-before: page; }
    section.group:first-of-type article:first-of-type { break-before: auto; }
  }
`;

/**
 * The same document as one self-contained print-styled HTML page:
 * readable Arabic RTL, a table of contents linking to each article,
 * and a page break before every article when printed. The page prints
 * itself on load, so opening it IS the «طباعة / PDF» action.
 */
export function composeDocumentHtml(ideas: Idea[], generatedAt: Date = new Date()): string {
  const groups = documentGroups(ideas);
  let n = 0;
  const anchor = () => `doc-${n++}`;
  const toc: string[] = [];
  const sections: string[] = [];
  for (const group of groups) {
    const items: string[] = [];
    const articles: string[] = [];
    for (const idea of group.ideas) {
      const article = getArticle(idea);
      const id = anchor();
      const attribution = documentAttribution(idea);
      items.push(`<li><a href="#${id}">${escapeHtml(article.title)}</a></li>`);
      const paragraphs = article.body
        .split(/\n\s*\n/)
        .map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
        .join("");
      articles.push(
        `<article id="${id}"><h3>${escapeHtml(article.title)}</h3>` +
          `<p class="meta">${escapeHtml(documentMetaLine(idea))}</p>` +
          (attribution ? `<p class="source">${escapeHtml(attribution)}</p>` : "") +
          `<div class="body">${paragraphs}</div></article>`,
      );
    }
    toc.push(`<li>${escapeHtml(group.topic)} (${group.ideas.length})<ul>${items.join("")}</ul></li>`);
    sections.push(`<section class="group"><h2>${escapeHtml(group.topic)}</h2>${articles.join("")}</section>`);
  }
  return [
    "<!doctype html>",
    '<html lang="ar" dir="rtl">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${DOCUMENT_APP_LINE} — مستند مُجمّع</title>`,
    `<style>${PRINT_CSS}</style>`,
    "</head>",
    "<body>",
    `<header class="doc"><h1>${DOCUMENT_APP_LINE} — ${DOCUMENT_AUTHOR_LINE}</h1>` +
      `<p>مستند مُجمّع في ${documentDate(generatedAt.getTime())} · ${pluralArticles(ideas.length)}</p></header>`,
    groups.length ? `<nav class="toc"><h2>المحتويات</h2><ul>${toc.join("")}</ul></nav>` : "",
    ...sections,
    "<script>window.addEventListener('load', function () { setTimeout(function () { window.print(); }, 150); });</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

/** The document's download name, dated like the app's other downloads
 *  are titled: `أفكاري-مستند-2026-11-04.md`. */
export function documentFileName(generatedAt: Date = new Date()): string {
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${DOCUMENT_APP_LINE}-مستند-${generatedAt.getFullYear()}-${pad(generatedAt.getMonth() + 1)}-${pad(generatedAt.getDate())}.md`;
}

/** Download the composed Markdown as a .md file (the same anchor
 *  download pattern the card/audio shares fall back to). */
export function downloadDocument(ideas: Idea[]): void {
  const blob = new Blob([composeDocument(ideas)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = documentFileName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Open the print-styled HTML in a new tab; it prints itself on load,
 *  and the browser's print dialog is where the owner saves a PDF.
 *  Returns false when the popup was blocked. */
export function printDocument(ideas: Idea[]): boolean {
  const blob = new Blob([composeDocumentHtml(ideas)], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return !!win;
}

/** Selection-mode membership: songs are recordings, not document
 *  material — they are never selectable. Everything else (his own
 *  articles and liked ones alike) is. */
export const isSelectable = (idea: Idea): boolean => !idea.song;

/** Toggle one id in the selection set (pure — returns a new set). */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The selected ideas, in the order the view lists them, pruned to ids
 *  that still exist (and are still selectable) — a deletion inside the
 *  undo window must never leak into a compiled document. */
export function selectedIdeas(ideas: Idea[], selected: ReadonlySet<string>): Idea[] {
  return ideas.filter((i) => selected.has(i.id) && isSelectable(i));
}
