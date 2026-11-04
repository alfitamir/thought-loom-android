import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadIdeas, type Idea } from "@/lib/ideas";

// Same stub set as editor-header.test.tsx: leaf modules the editor only
// touches on demand are stubbed — this suite covers the PROJECT PICKER's
// contract (assign new/existing, clear, partition scoping, per-kind
// visibility), not the editor's other surfaces.
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
  articleTitle: "عنوان المقال", articleBody: "متن المقال الطويل الذي يقرأه القارئ هنا",
};
const renderEditor = (idea: Idea, onChange = vi.fn()) =>
  render(<ArticleEditor idea={idea} topic="متفرقات" online={false} onChange={onChange} onDelete={vi.fn()} />);

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

describe("project picker", () => {
  it("creates a brand-new project from the dialog and files the article under it", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    renderEditor(article);
    fireEvent.click(screen.getByRole("button", { name: "إضافة المقال إلى مشروع" }));
    expect(screen.getByText("مشروع المقال")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("مشروع جديد"), { target: { value: "كتاب الجراحة" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ" }));
    expect(loadIdeas().find((i) => i.id === "a1")?.project).toBe("كتاب الجراحة");
  });

  it("assigns an existing project from the list, scoped to the article's own section", () => {
    const filed: Idea = { ...article, id: "a2", project: "سلسلة" };
    const medicalFiled: Idea = { ...article, id: "a3", project: "طبي فقط", medical: true };
    localStorage.setItem("afkari.ideas", JSON.stringify([article, filed, medicalFiled]));
    renderEditor(article);
    fireEvent.click(screen.getByRole("button", { name: "إضافة المقال إلى مشروع" }));
    // The other section's project is a different project — never listed here.
    expect(screen.queryByRole("button", { name: /طبي فقط/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /سلسلة/ }));
    expect(loadIdeas().find((i) => i.id === "a1")?.project).toBe("سلسلة");
  });

  it("clears the assignment via «بدون مشروع»", () => {
    const filed: Idea = { ...article, project: "كتابي" };
    localStorage.setItem("afkari.ideas", JSON.stringify([filed]));
    renderEditor(filed);
    fireEvent.click(screen.getByRole("button", { name: "المشروع: كتابي — تغيير المشروع" }));
    fireEvent.click(screen.getByRole("button", { name: /بدون مشروع/ }));
    expect(loadIdeas().find((i) => i.id === "a1")).not.toHaveProperty("project");
  });

  it("never renders for songs — a recording is not project material", () => {
    const song: Idea = { id: "s1", text: "كلمات الأغنية", createdAt: 1000, updatedAt: 5000, articleTitle: "أغنية", song: true };
    localStorage.setItem("afkari.ideas", JSON.stringify([song]));
    renderEditor(song);
    expect(screen.queryByRole("button", { name: /إضافة المقال إلى مشروع/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /المشروع:/ })).toBeNull();
  });

  it("renders for liked articles — source readers get filed into projects too", () => {
    const liked: Idea = { ...article, id: "l1", liked: true, source: "مجلة" };
    localStorage.setItem("afkari.ideas", JSON.stringify([liked]));
    renderEditor(liked);
    expect(screen.getByRole("button", { name: "إضافة المقال إلى مشروع" })).toBeTruthy();
  });
});
