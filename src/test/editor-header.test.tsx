import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadIdeas, type Idea } from "@/lib/ideas";

// Leaf modules the editor only touches on demand (audio stores, AI engines,
// dialogs) are stubbed: this suite covers the editor's LAYOUT contract —
// what sits beside the title, what stayed at the bottom, and the rules
// that hide pieces per article kind — plus the section move action.
vi.mock("@/lib/sync", () => ({ pushIdea: vi.fn(async () => {}), syncNow: vi.fn(async () => 0), deleteIdeaCloud: vi.fn(async () => {}) }));
vi.mock("@/lib/ai-features", () => ({ getArticleEnrichment: vi.fn(), getFacebookPost: vi.fn(), getEvidence: vi.fn() }));
vi.mock("@/lib/ai-engine", () => ({ resolveEngine: vi.fn(async () => "x") }));
vi.mock("@/lib/article-ai", () => ({ improveFull: vi.fn(), cleanFull: vi.fn() }));
vi.mock("@/lib/gemini", () => ({ getGeminiKey: () => "" }));
vi.mock("@/lib/tts", () => ({
  GEMINI_TTS_VOICE: "Charon",
  blobToBytes: vi.fn(), concatPcm: vi.fn(), createTtsSession: vi.fn(), mapWithConcurrency: vi.fn(),
  modelForVoiceKey: vi.fn(), pcmToWav: vi.fn(), speakWithDevice: vi.fn(), splitForSpeech: () => [],
  synthesizeGeminiChunkWithModel: vi.fn(), toSpeechText: (t: string) => t,
}));
vi.mock("@/lib/article-audio", () => ({
  PCM_CHUNK_MIME: "audio/pcm",
  audioFileName: (t: string) => `${t}.wav`,
  deleteArticleAudioForVoice: vi.fn(), deleteSongAudio: vi.fn(async () => {}),
  findCachedAudioForVoice: vi.fn(async () => null), getAudioChunk: vi.fn(async () => null),
  getSongAudio: vi.fn(async () => null), listArticleIdsWithAudio: vi.fn(async () => new Set<string>()),
  saveAudioChunk: vi.fn(async () => {}), saveAudioManifest: vi.fn(async () => {}),
  saveSongAudio: vi.fn(async () => {}), songAudioStore: vi.fn(),
}));
vi.mock("@/lib/my-voice", () => ({
  effectiveListenVoice: (c: string) => c, getMyVoiceProfile: () => null, isMyVoicePublic: () => false,
}));
vi.mock("@/lib/song-drive", () => ({ downloadSongAudio: vi.fn(), deleteSongDriveCopy: vi.fn(async () => {}) }));
vi.mock("@/lib/song-lyrics", () => ({
  applySongLyrics: vi.fn(), decideLyricsApplication: () => "none",
  isSongLyricsPending: () => false, onSongLyricsPendingChange: () => () => {}, transcribeSong: vi.fn(),
}));
vi.mock("@/lib/share-card", () => ({
  deliverCardImage: vi.fn(async () => "shared"), renderShareCardPng: vi.fn(async () => new Blob()),
  shareCardModel: () => ({}),
}));
vi.mock("@/components/evidence-dialog", () => ({ EvidenceDialog: () => null }));
vi.mock("@/components/manual-merge-dialog", () => ({ ManualMergeDialog: () => null }));

import { ArticleEditor } from "@/components/article-editor";
import { composeXPost, xCharCount, X_DISCLAIMER, X_POST_LIMIT } from "@/lib/x-post";

const FOLLOWS = 4; // Node.DOCUMENT_POSITION_FOLLOWING
const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & FOLLOWS) !== 0;

const article: Idea = {
  id: "a1", text: "نص المقال الأصلي", createdAt: 1000, updatedAt: 5000,
  articleTitle: "عنوان المقال", articleBody: "متن المقال الطويل الذي يقرأه القارئ هنا بسطور كثيرة",
};
const renderEditor = (idea: Idea, onChange = vi.fn()) =>
  render(<ArticleEditor idea={idea} topic="متفرقات" online={false} onChange={onChange} onDelete={vi.fn()} />);

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

describe("editor header layout (Part B)", () => {
  it("share, share-as-image and smart tools sit beside/under the title — the bottom row no longer carries them", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    renderEditor(article);
    const share = screen.getByRole("button", { name: "مشاركة المقال" });
    const shareImage = screen.getByRole("button", { name: "مشاركة المقال كصورة" });
    const tools = screen.getByRole("button", { name: "أدوات ذكية" });
    // The body text appears twice: a one-line preview echo and the full
    // body paragraph — the paragraph (last match) is the anchor.
    const body = screen.getAllByText(/متن المقال الطويل/).at(-1)!;
    // All three are ABOVE the body text now.
    expect(before(share, body)).toBe(true);
    expect(before(shareImage, body)).toBe(true);
    expect(before(tools, body)).toBe(true);
    // Exactly one of each in the whole card (moved, not duplicated).
    expect(screen.getAllByRole("button", { name: "مشاركة المقال" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "مشاركة المقال كصورة" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "أدوات ذكية" })).toHaveLength(1);
    // The bottom row still carries edit, listen, merge, pin and the
    // isolated delete — all of them below the body.
    for (const name of ["تعديل المقال", "استمع للمقال", "دمج يدوي مع مقال آخر", "تثبيت المقال", "حذف المقال"]) {
      const btn = screen.getByRole("button", { name });
      expect(before(body, btn)).toBe(true);
    }
    // The topic chip is still up by the title.
    expect(screen.getByRole("button", { name: /التصنيف:/ })).toBeTruthy();
  });

  it("liked articles keep the AI lock at the new location: no smart tools, share still at the top", () => {
    const liked: Idea = { ...article, id: "l1", liked: true, source: "مجلة الفكر" };
    localStorage.setItem("afkari.ideas", JSON.stringify([liked]));
    renderEditor(liked);
    expect(screen.queryByRole("button", { name: "أدوات ذكية" })).toBeNull();
    expect(screen.getByText(/الذكاء الاصطناعي لا يعدّله/)).toBeTruthy();
    const share = screen.getByRole("button", { name: "مشاركة المقال" });
    expect(before(share, screen.getAllByText(/متن المقال الطويل/).at(-1)!)).toBe(true);
  });

  it("songs: no smart tools, and share-as-image sits at the top of the song section, before delete", () => {
    const song: Idea = { id: "s1", text: "كلمات الأغنية", createdAt: 1000, updatedAt: 5000, articleTitle: "أغنية", song: true };
    localStorage.setItem("afkari.ideas", JSON.stringify([song]));
    renderEditor(song);
    expect(screen.queryByRole("button", { name: "أدوات ذكية" })).toBeNull();
    expect(screen.queryByRole("button", { name: "مشاركة المقال" })).toBeNull();
    const shareImage = screen.getByRole("button", { name: "مشاركة الأغنية كصورة" });
    const del = screen.getByRole("button", { name: "حذف الأغنية" });
    expect(before(shareImage, del)).toBe(true);
    // No local recording on this device → no audio-share button anywhere.
    expect(screen.queryByRole("button", { name: "مشاركة الصوت" })).toBeNull();
  });
});

describe("section move action (Part A)", () => {
  it("moves a general article into the medical section without bumping updatedAt", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    const onChange = vi.fn();
    renderEditor(article, onChange);
    fireEvent.click(screen.getByRole("button", { name: "نقل إلى القسم الطبي" }));
    const stored = loadIdeas().find((i) => i.id === article.id);
    expect(stored?.medical).toBe(true);
    expect(stored?.updatedAt).toBe(article.updatedAt);
    expect(onChange).toHaveBeenCalled();
    expect(screen.getByText(/نُقل المقال إلى القسم الطبي/)).toBeTruthy();
  });

  it("a medical article carries the section badge and can be moved back out", () => {
    const med: Idea = { ...article, id: "m1", medical: true };
    localStorage.setItem("afkari.ideas", JSON.stringify([med]));
    renderEditor(med);
    expect(screen.getByText("القسم الطبي")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "إخراج إلى المكتبة العامة" }));
    expect(loadIdeas().find((i) => i.id === med.id)).not.toHaveProperty("medical");
  });

  it("songs never offer the move — a song is not a medical article", () => {
    const song: Idea = { id: "s1", text: "", createdAt: 1000, updatedAt: 5000, articleTitle: "أغنية", song: true };
    localStorage.setItem("afkari.ideas", JSON.stringify([song]));
    renderEditor(song);
    expect(screen.queryByRole("button", { name: "نقل إلى القسم الطبي" })).toBeNull();
  });
});

describe("X post chip (feature 5)", () => {
  beforeEach(() => {
    // Radix menus/dialogs reach for pointer capture and scrollIntoView,
    // which jsdom does not implement.
    const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
    proto["hasPointerCapture"] ??= () => false;
    proto["setPointerCapture"] ??= () => {};
    proto["releasePointerCapture"] ??= () => {};
    proto["scrollIntoView"] ??= () => {};
  });

  const openToolsMenu = () => {
    // Radix opens its menu on ArrowDown; pointer gestures are not
    // recognised under jsdom (no real pointer capture).
    fireEvent.keyDown(screen.getByRole("button", { name: "أدوات ذكية" }), { key: "ArrowDown" });
  };

  it("sits beside the Facebook item in the smart-tools menu and copies a locally composed post, offline", async () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
    renderEditor(article); // online={false}: the X item must still work — it composes on-device
    openToolsMenu();
    expect(screen.getByRole("menuitem", { name: "منشور فيسبوك" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "منشور X" }));
    // The dialog previews exactly what the pure composer builds, with its count.
    const expected = composeXPost({ title: article.articleTitle!, body: article.articleBody!, medical: false, topic: "متفرقات" });
    expect(screen.getByText("منشور X مقترح")).toBeTruthy();
    expect(screen.getByText((_, el) => el?.tagName === "DIV" && el.textContent === expected)).toBeTruthy();
    expect(xCharCount(expected)).toBeLessThanOrEqual(X_POST_LIMIT);
    expect(screen.getByText(/عدد الحروف/).textContent).toContain(`/ ${X_POST_LIMIT}`);
    // Copy mirrors the Facebook chip's confirmation, in the dialog and the editor.
    fireEvent.click(screen.getByRole("button", { name: "نسخ المنشور" }));
    expect(await screen.findAllByText("نُسخ المنشور ✓")).not.toHaveLength(0);
    expect(writeText).toHaveBeenCalledWith(expected);
  });

  it("a medical article's preview closes with the disclaimer", () => {
    const med: Idea = { ...article, id: "m9", medical: true };
    localStorage.setItem("afkari.ideas", JSON.stringify([med]));
    renderEditor(med);
    openToolsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "منشور X" }));
    const expected = composeXPost({ title: med.articleTitle!, body: med.articleBody!, medical: true, topic: "متفرقات" });
    expect(expected.endsWith(X_DISCLAIMER)).toBe(true);
    expect(screen.getByText((_, el) => el?.tagName === "DIV" && el.textContent === expected)).toBeTruthy();
  });

  it("mirrors the Facebook chip's exclusions: liked articles and songs never reach it", () => {
    const liked: Idea = { ...article, id: "l9", liked: true, source: "مجلة الفكر" };
    localStorage.setItem("afkari.ideas", JSON.stringify([liked]));
    const { unmount } = renderEditor(liked);
    expect(screen.queryByRole("button", { name: "أدوات ذكية" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "منشور X" })).toBeNull();
    unmount();
    const song: Idea = { id: "s9", text: "كلمات الأغنية", createdAt: 1000, updatedAt: 5000, articleTitle: "أغنية", song: true };
    localStorage.setItem("afkari.ideas", JSON.stringify([song]));
    renderEditor(song);
    expect(screen.queryByRole("button", { name: "أدوات ذكية" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "منشور X" })).toBeNull();
  });
});

describe("version history (الإصدارات السابقة)", () => {
  it("the entry sits beside the title for the author's own articles", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    renderEditor(article);
    const entry = screen.getByRole("button", { name: "الإصدارات السابقة" });
    const body = screen.getAllByText(/متن المقال الطويل/).at(-1)!;
    expect(before(entry, body)).toBe(true);
  });

  it("never renders for liked articles or songs — their texts are never AI-replaced", () => {
    const liked: Idea = { ...article, id: "l5", liked: true, source: "مجلة الفكر" };
    localStorage.setItem("afkari.ideas", JSON.stringify([liked]));
    const { unmount } = renderEditor(liked);
    expect(screen.queryByRole("button", { name: "الإصدارات السابقة" })).toBeNull();
    unmount();
    const song: Idea = { id: "s5", text: "كلمات الأغنية", createdAt: 1000, updatedAt: 5000, articleTitle: "أغنية", song: true };
    localStorage.setItem("afkari.ideas", JSON.stringify([song]));
    renderEditor(song);
    expect(screen.queryByRole("button", { name: "الإصدارات السابقة" })).toBeNull();
  });

  it("an article with no history shows the calm empty state", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    renderEditor(article);
    fireEvent.click(screen.getByRole("button", { name: "الإصدارات السابقة" }));
    expect(screen.getByText(/لا إصدارات سابقة بعد/)).toBeTruthy();
  });

  it("lists frozen versions and restores one — freezing the current text in turn", async () => {
    const withHistory: Idea = {
      ...article,
      versions: [{ at: 4000, text: "النص القديم المجمد قبل التحسين", title: "العنوان القديم", source: "improve" }],
    };
    localStorage.setItem("afkari.ideas", JSON.stringify([withHistory]));
    const onChange = vi.fn();
    renderEditor(withHistory, onChange);
    fireEvent.click(screen.getByRole("button", { name: "الإصدارات السابقة" }));
    // The row names the operation that froze it and the title it carried.
    expect(screen.getByText("تحسين")).toBeTruthy();
    expect(screen.getByText("العنوان القديم")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "استرجاع" }));
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الاسترجاع" }));
    expect(onChange).toHaveBeenCalled();
    const saved = loadIdeas().find((i) => i.id === withHistory.id)!;
    expect(saved.articleTitle).toBe("العنوان القديم");
    expect(saved.articleBody).toBe("النص القديم المجمد قبل التحسين");
    // The pre-restore text was frozen as a 'restore' version — no one-way door.
    expect(saved.versions?.[0]).toMatchObject({ text: article.articleBody, source: "restore" });
    expect(await screen.findByText(/استُرجعت النسخة السابقة/)).toBeTruthy();
  });
});
