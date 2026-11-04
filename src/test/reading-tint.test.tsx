import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Idea } from "@/lib/ideas";
import { READING_PREFS_KEY } from "@/lib/reading-prefs";

// Same leaf-module stubs as reading-mode.test.tsx: this suite covers the
// warm background tint — the third reading-comfort axis — on the same
// surfaces the size/spacing steps serve.
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

describe("reading background tint (خلفية القراءة)", () => {
  it("the untouched default is transparent and the body carries no tint classes", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    const { root } = renderEditor(article);
    expect(varOf(root, "--reading-bg")).toBe("transparent");
    expect(bodyEl().className).not.toContain("bg-[var(--reading-bg)]");
  });

  it("choosing «خلفية دافئة» in the reading menu tints the body and persists", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    const { root } = renderEditor(article);
    fireEvent.keyDown(screen.getByRole("button", { name: "راحة القراءة" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitem", { name: "خلفية القراءة: خلفية دافئة" }));
    expect(varOf(root, "--reading-bg")).toBe("var(--reading-bg-warm)");
    expect(bodyEl().className).toContain("bg-[var(--reading-bg)]");
    expect(JSON.parse(localStorage.getItem(READING_PREFS_KEY)!)).toEqual({ fontSize: 0, lineHeight: 0, bgTint: 1 });
    // …and back to عادية restores today's exact rendering.
    fireEvent.keyDown(screen.getByRole("button", { name: "راحة القراءة" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitem", { name: "خلفية القراءة: خلفية عادية" }));
    expect(varOf(root, "--reading-bg")).toBe("transparent");
    expect(bodyEl().className).not.toContain("bg-[var(--reading-bg)]");
  });

  it("a stored tint applies on open, and the edit box is tinted too", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    localStorage.setItem(READING_PREFS_KEY, JSON.stringify({ fontSize: 0, lineHeight: 0, bgTint: 1 }));
    renderEditor(article);
    expect(bodyEl().className).toContain("bg-[var(--reading-bg)]");
    fireEvent.click(screen.getByRole("button", { name: "تعديل المقال" }));
    const box = screen.getByLabelText("نص المقال") as HTMLTextAreaElement;
    // .reading-tinted (styles.css) paints it with var(--reading-bg).
    expect(box.className).toContain("reading-tinted");
  });

  it("a legacy stored value without bgTint opens untinted", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    localStorage.setItem(READING_PREFS_KEY, JSON.stringify({ fontSize: 1, lineHeight: 1 }));
    const { root } = renderEditor(article);
    expect(varOf(root, "--reading-bg")).toBe("transparent");
    expect(bodyEl().className).not.toContain("bg-[var(--reading-bg)]");
  });

  it("song lyrics get the tint on the same preference", () => {
    const song: Idea = { id: "s1", text: "كلمات الأغنية كاملة هنا", createdAt: 1000, updatedAt: 5000, articleTitle: "أغنية", song: true };
    localStorage.setItem("afkari.ideas", JSON.stringify([song]));
    localStorage.setItem(READING_PREFS_KEY, JSON.stringify({ fontSize: 0, lineHeight: 0, bgTint: 1 }));
    renderEditor(song);
    const lyrics = screen.getByText(/كلمات الأغنية كاملة/);
    expect(lyrics.className).toContain("bg-[var(--reading-bg)]");
  });
});
