import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Idea } from "@/lib/ideas";
import { READING_PREFS_KEY } from "@/lib/reading-prefs";

// Same leaf-module stubs as editor-header.test.tsx: this suite covers the
// reading-comfort contract — the header control, the CSS variables it
// drives on the editor root, and the surfaces that consume them.
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

const FOLLOWS = 4; // Node.DOCUMENT_POSITION_FOLLOWING
const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & FOLLOWS) !== 0;

const article: Idea = {
  id: "a1", text: "نص المقال الأصلي", createdAt: 1000, updatedAt: 5000,
  articleTitle: "عنوان المقال", articleBody: "متن المقال الطويل الذي يقرأه القارئ هنا بسطور كثيرة",
};
const renderEditor = (idea: Idea) => {
  const utils = render(<ArticleEditor idea={idea} topic="متفرقات" online={false} onChange={vi.fn()} onDelete={vi.fn()} />);
  const root = utils.container.querySelector("article")!;
  return { ...utils, root };
};
const varOf = (el: Element, name: string) => (el as HTMLElement).style.getPropertyValue(name);
const bodyEl = () => screen.getAllByText(/متن المقال الطويل/).at(-1)!;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  // Radix menus reach for pointer capture and scrollIntoView under jsdom.
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto["hasPointerCapture"] ??= () => false;
  proto["setPointerCapture"] ??= () => {};
  proto["releasePointerCapture"] ??= () => {};
  proto["scrollIntoView"] ??= () => {};
});

describe("reading comfort (وضع القراءة المريح)", () => {
  it("the untouched default carries today's exact values — 1.25rem / 2 — and the body consumes the variables", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    const { root } = renderEditor(article);
    expect(varOf(root, "--reading-font-size")).toBe("1.25rem"); // = text-xl
    expect(varOf(root, "--reading-line-height")).toBe("2"); // = leading-loose
    const body = bodyEl();
    expect(body.className).toContain("text-[length:var(--reading-font-size,1.25rem)]");
    expect(body.className).toContain("leading-[var(--reading-line-height,2)]");
    expect(body.className).not.toContain("text-xl");
    // The control itself sits in the header, above the body.
    expect(before(screen.getByRole("button", { name: "راحة القراءة" }), body)).toBe(true);
  });

  it("stepping the menu updates the applied variables and persists the choice", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    const { root } = renderEditor(article);
    const openMenu = () => fireEvent.keyDown(screen.getByRole("button", { name: "راحة القراءة" }), { key: "ArrowDown" });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "حجم النص: أكبر" }));
    expect(varOf(root, "--reading-font-size")).toBe("1.75rem");
    expect(JSON.parse(localStorage.getItem(READING_PREFS_KEY)!)).toEqual({ fontSize: 2, lineHeight: 0 });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "تباعد الأسطر: واسعة" }));
    expect(varOf(root, "--reading-line-height")).toBe("2.4");
    expect(JSON.parse(localStorage.getItem(READING_PREFS_KEY)!)).toEqual({ fontSize: 2, lineHeight: 1 });
  });

  it("a stored choice applies on open, without touching the article data", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    localStorage.setItem(READING_PREFS_KEY, JSON.stringify({ fontSize: 1, lineHeight: 1 }));
    const { root } = renderEditor(article);
    expect(varOf(root, "--reading-font-size")).toBe("1.5rem");
    expect(varOf(root, "--reading-line-height")).toBe("2.4");
  });

  it("the edit box reads with the same variables", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    localStorage.setItem(READING_PREFS_KEY, JSON.stringify({ fontSize: 2, lineHeight: 1 }));
    renderEditor(article);
    fireEvent.click(screen.getByRole("button", { name: "تعديل المقال" }));
    const box = screen.getByLabelText("نص المقال");
    expect(box.className).toContain("text-[length:var(--reading-font-size,1.25rem)]");
    expect(box.className).toContain("leading-[var(--reading-line-height,2)]");
  });

  it("songs inherit the preference on their lyrics — and still get the control", () => {
    const song: Idea = { id: "s1", text: "كلمات الأغنية كاملة هنا", createdAt: 1000, updatedAt: 5000, articleTitle: "أغنية", song: true };
    localStorage.setItem("afkari.ideas", JSON.stringify([song]));
    localStorage.setItem(READING_PREFS_KEY, JSON.stringify({ fontSize: 2, lineHeight: 0 }));
    const { root } = renderEditor(song);
    expect(varOf(root, "--reading-font-size")).toBe("1.75rem");
    expect(screen.getByRole("button", { name: "راحة القراءة" })).toBeTruthy();
    const lyrics = screen.getByText(/كلمات الأغنية كاملة/);
    expect(lyrics.className).toContain("text-[length:var(--reading-font-size,1.25rem)]");
    expect(lyrics.className).toContain("leading-[var(--reading-line-height,2)]");
  });
});
