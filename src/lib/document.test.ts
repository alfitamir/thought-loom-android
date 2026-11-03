import { describe, expect, it } from "vitest";
import type { Idea } from "./ideas";
import {
  composeDocument,
  composeDocumentHtml,
  documentAttribution,
  documentFileName,
  documentGroups,
  documentMetaLine,
  isSelectable,
  selectedIdeas,
  toggleSelected,
} from "./document";

const mk = (over: Partial<Idea>): Idea => ({ id: "x", text: "نص", createdAt: 1000, ...over });

// Topics are hand-pinned (topicManual) so classification never interferes.
const healthOld = mk({ id: "h-old", topic: "الصحة", topicManual: true, articleTitle: "عن النوم", articleBody: "النوم أولًا.\n\nثم كل شيء.", createdAt: 1000 });
const healthNew = mk({ id: "h-new", topic: "الصحة", topicManual: true, articleTitle: "عن المشي", articleBody: "المشي اليومي علاج.", createdAt: 3000 });
const workOne = mk({ id: "w-1", topic: "العمل", topicManual: true, articleTitle: "عن الفريق", articleBody: "الفريق قبل الخطة.", createdAt: 2000 });
const liked = mk({ id: "l-1", topic: "الصحة", topicManual: true, liked: true, source: "مدونة الدكتور س", articleTitle: "مقال أعجبني عن الغذاء", articleBody: "نص الغير كما هو حرفيًا.", createdAt: 1500 });

describe("documentGroups", () => {
  it("groups by derived topic, busiest group first, oldest → newest inside", () => {
    const groups = documentGroups([healthNew, workOne, liked, healthOld]);
    expect(groups.map((g) => g.topic)).toEqual(["الصحة", "العمل"]);
    expect(groups[0]?.ideas.map((i) => i.id)).toEqual(["h-old", "l-1", "h-new"]);
    expect(groups[1]?.ideas.map((i) => i.id)).toEqual(["w-1"]);
  });

  it("breaks group-size ties by Arabic topic name", () => {
    const groups = documentGroups([workOne, healthOld]);
    expect(groups.map((g) => g.topic)).toEqual(["الصحة", "العمل"]);
  });

  it("returns no groups for an empty selection", () => {
    expect(documentGroups([])).toEqual([]);
  });
});

describe("documentAttribution", () => {
  it("a liked article carries its own source", () => {
    expect(documentAttribution(liked)).toBe("المصدر: مدونة الدكتور س");
  });

  it("a liked article without a source falls back to its accumulated sources, then the external line", () => {
    expect(documentAttribution(mk({ liked: true, sources: ["موقع ص", "مجلة ع"] }))).toBe("المصدر: موقع ص، مجلة ع");
    expect(documentAttribution(mk({ liked: true }))).toBe("مقال من مصدر خارجي");
  });

  it("his own article that absorbed a liked one carries «يتضمن مقالًا من»", () => {
    expect(documentAttribution(mk({ sources: ["مدونة الدكتور س"] }))).toBe("يتضمن مقالًا من: مدونة الدكتور س");
  });

  it("a plain article carries no attribution", () => {
    expect(documentAttribution(healthOld)).toBeUndefined();
  });
});

describe("composeDocument", () => {
  const at = new Date(2026, 10, 4); // 4 Nov 2026, local
  const doc = composeDocument([healthNew, workOne, liked, healthOld], at);

  it("opens with the branded header and the generation line", () => {
    expect(doc.startsWith("# أفكاري — د. تامر رشدي الألفي\n")).toBe(true);
    expect(doc).toContain(`مستند مُجمّع في ${at.toLocaleDateString("ar")} · 4 مقالات`);
  });

  it("has a table of contents grouped by topic with every title", () => {
    const toc = doc.slice(doc.indexOf("## المحتويات"), doc.indexOf("# الصحة"));
    expect(toc).toContain("- الصحة (3)");
    expect(toc).toContain("- العمل (1)");
    for (const title of ["عن النوم", "عن المشي", "عن الفريق", "مقال أعجبني عن الغذاء"]) expect(toc).toContain(`  - ${title}`);
    // TOC order inside the busiest group is oldest → newest too.
    expect(toc.indexOf("عن النوم")).toBeLessThan(toc.indexOf("مقال أعجبني عن الغذاء"));
    expect(toc.indexOf("مقال أعجبني عن الغذاء")).toBeLessThan(toc.indexOf("عن المشي"));
  });

  it("renders each article as ## title + meta line + verbatim body, oldest first in its group", () => {
    const healthSection = doc.slice(doc.indexOf("# الصحة", doc.indexOf("## المحتويات")));
    expect(healthSection.indexOf("## عن النوم")).toBeLessThan(healthSection.indexOf("## عن المشي"));
    expect(doc).toContain(`## عن النوم\n\n${documentMetaLine(healthOld)}\n\nالنوم أولًا.\n\nثم كل شيء.`);
    expect(doc).toContain(`## عن الفريق\n\n${documentMetaLine(workOne)}\n\nالفريق قبل الخطة.`);
    // Meta line = date + topic.
    expect(documentMetaLine(healthOld)).toBe(`${new Date(1000).toLocaleDateString("ar")} · الصحة`);
  });

  it("places the liked attribution directly under the liked article's meta line", () => {
    expect(doc).toContain(`## مقال أعجبني عن الغذاء\n\n${documentMetaLine(liked)}\n\nالمصدر: مدونة الدكتور س\n\nنص الغير كما هو حرفيًا.`);
  });

  it("an empty selection is the header only — no contents, no groups", () => {
    const empty = composeDocument([], at);
    expect(empty).toContain("# أفكاري — د. تامر رشدي الألفي");
    expect(empty).not.toContain("المحتويات");
    expect(empty).not.toContain("## ");
    expect(empty.trim().split("\n")).toHaveLength(3);
  });
});

describe("composeDocumentHtml", () => {
  const html = composeDocumentHtml([healthOld, liked], new Date(2026, 10, 4));

  it("is a standalone RTL Arabic page with print CSS and a page break per article", () => {
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain("break-before: page");
    expect(html).toContain("window.print()");
  });

  it("carries the TOC with anchors, the meta line, the attribution and the verbatim paragraphs", () => {
    expect(html).toContain("المحتويات");
    expect(html).toContain('href="#doc-0"');
    expect(html).toContain(`<p class="meta">${documentMetaLine(healthOld)}</p>`);
    expect(html).toContain('<p class="source">المصدر: مدونة الدكتور س</p>');
    expect(html).toContain("<p>النوم أولًا.</p>");
    expect(html).toContain("<p>ثم كل شيء.</p>");
    expect(html).toContain("<p>نص الغير كما هو حرفيًا.</p>");
  });

  it("escapes HTML in titles and bodies", () => {
    const evil = mk({ topic: "الصحة", topicManual: true, articleTitle: 'عنوان <script>alert(1)</script>', articleBody: "نص & رموز <b>", createdAt: 5 });
    const out = composeDocumentHtml([evil]);
    expect(out).not.toContain("<script>alert(1)</script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("نص &amp; رموز &lt;b&gt;");
  });
});

describe("selection helpers", () => {
  it("songs are never selectable; articles and liked articles are", () => {
    expect(isSelectable(mk({ song: true }))).toBe(false);
    expect(isSelectable(mk({}))).toBe(true);
    expect(isSelectable(mk({ liked: true }))).toBe(true);
  });

  it("toggleSelected adds then removes, without mutating the input set", () => {
    const start = new Set<string>(["a"]);
    const added = toggleSelected(start, "b");
    expect([...added].sort()).toEqual(["a", "b"]);
    expect([...start]).toEqual(["a"]);
    expect([...toggleSelected(added, "a")]).toEqual(["b"]);
  });

  it("selectedIdeas keeps view order and prunes missing ids and songs", () => {
    const song = mk({ id: "s-1", song: true });
    const out = selectedIdeas([healthNew, song, healthOld], new Set(["h-old", "s-1", "gone", "h-new"]));
    expect(out.map((i) => i.id)).toEqual(["h-new", "h-old"]);
  });
});

describe("documentFileName", () => {
  it("is dated and Markdown-suffixed", () => {
    expect(documentFileName(new Date(2026, 10, 4))).toBe("أفكاري-مستند-2026-11-04.md");
    expect(documentFileName(new Date(2026, 0, 9))).toBe("أفكاري-مستند-2026-01-09.md");
  });
});
