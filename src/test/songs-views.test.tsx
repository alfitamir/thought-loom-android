import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Idea } from "@/lib/ideas";

// Router links render as plain anchors; routing itself is covered elsewhere.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children, ...props }: Record<string, unknown>) => <a {...props}>{children as React.ReactNode}</a>,
  };
});
// The editor card is a heavy surface of its own; these tests cover the
// VIEWS' partition contract, so a stub renders each card's title and
// exposes its delete gesture.
vi.mock("@/components/article-editor", () => ({
  ArticleEditor: ({ idea, onDelete }: { idea: Idea; onDelete?: () => void }) => (
    <div data-testid="card">
      <span>{idea.articleTitle ?? idea.text}</span>
      <button onClick={onDelete}>حذف بطاقة {idea.id}</button>
    </div>
  ),
}));
vi.mock("@/components/merge-banner", () => ({ MergeBanner: () => null }));
vi.mock("@/components/ask-dialog", () => ({ AskDialog: () => null }));
vi.mock("@/components/insights-dialog", () => ({ InsightsDialog: () => null }));
vi.mock("@/components/liked-dialog", () => ({ LikedDialog: () => null }));
vi.mock("@/lib/sync", () => ({ pushIdea: vi.fn(), syncNow: vi.fn(async () => 0), deleteIdeaCloud: vi.fn() }));
vi.mock("@/lib/article-ai", () => ({ cleanFull: vi.fn(), improveFull: vi.fn() }));
vi.mock("@/lib/ai-engine", () => ({ resolveEngine: vi.fn(async () => "x") }));
vi.mock("@/lib/ai-labels", () => ({
  loadLabels: () => ({}),
  labelFor: () => ({ topic: "", tags: [], ai: false }),
  unlabeled: () => [],
  labelAll: vi.fn(async () => 0),
}));
vi.mock("@/lib/article-audio", () => ({ listArticleIdsWithAudio: vi.fn(async () => new Set<string>()) }));
vi.mock("@/lib/delete-flow", () => ({ requestDelete: vi.fn(), undoDelete: vi.fn(() => true) }));
vi.mock("sonner", () => ({ toast: vi.fn() }));

import { Library } from "@/routes/library";
import { SongsSection } from "@/routes/songs";
import { requestDelete, undoDelete } from "@/lib/delete-flow";
import { toast } from "sonner";

const mk = (over: Partial<Idea>): Idea => ({
  id: Math.random().toString(36).slice(2),
  text: "نص",
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});
const general = mk({ articleTitle: "فكرة عامة فريدة", articleBody: "محتوى عام عن الصبر والتأمل", topic: "موضوع عام", topicManual: true });
const medical = mk({ articleTitle: "مقالة طبية سرية", articleBody: "محتوى طبي عن الجراحة والفتق", topic: "موضوع طبي", topicManual: true, medical: true });
const song1 = mk({ id: "song-1", articleTitle: "أغنيتي الأولى", text: "كلمات عن الليل والسهر", song: true, songDuration: 95 });
const song2 = mk({ id: "song-2", articleTitle: "أغنيتي الثانية", text: "كلمات عن البحر والموج", song: true, songDuration: 60 });

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

describe("main library: songs are out", () => {
  it("never shows songs — not in the list, the groups, or the header count — and its door card carries the song count", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([general, medical, song1, song2]));
    render(<Library />);
    // The songs door, with its count.
    expect(screen.getByText("الأغاني")).toBeTruthy();
    expect(screen.getByText(/2 أغاني مسجلة/)).toBeTruthy();
    // The general topic group renders; no song appears anywhere here.
    expect(screen.getByText("موضوع عام")).toBeTruthy();
    expect(screen.queryByText("أغنيتي الأولى")).toBeNull();
    expect(screen.queryByText("أغنيتي الثانية")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /موضوع عام/ }));
    expect(screen.getByText("فكرة عامة فريدة")).toBeTruthy();
    expect(screen.queryByText("أغنيتي الأولى")).toBeNull();
  });

  it("search in the main library cannot reach song lyrics", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([general, song1]));
    render(<Library />);
    fireEvent.click(screen.getByRole("button", { name: "بحث في المقالات" }));
    fireEvent.change(screen.getByLabelText("كلمة البحث"), { target: { value: "السهر" } });
    expect(screen.getByText(/لا نتائج/)).toBeTruthy();
    expect(screen.queryByText("أغنيتي الأولى")).toBeNull();
  });

  it("no songs, no door", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([general, medical]));
    render(<Library />);
    expect(screen.queryByText("الأغاني")).toBeNull();
  });
});

describe("songs section view", () => {
  it("shows only songs — general and medical ideas never appear", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([general, medical, song1, song2]));
    render(<SongsSection />);
    expect(screen.getByRole("heading", { name: /الأغاني/ })).toBeTruthy();
    expect(screen.getByText("أغنيتي الأولى")).toBeTruthy();
    expect(screen.getByText("أغنيتي الثانية")).toBeTruthy();
    expect(screen.queryByText("فكرة عامة فريدة")).toBeNull();
    expect(screen.queryByText("مقالة طبية سرية")).toBeNull();
  });

  it("search in the songs view reaches lyrics, inside the songs partition only", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([general, song1, song2]));
    render(<SongsSection />);
    fireEvent.click(screen.getByRole("button", { name: "بحث في الأغاني" }));
    fireEvent.change(screen.getByLabelText("كلمة البحث في الأغاني"), { target: { value: "الموج" } });
    expect(screen.getByText("أغنيتي الثانية")).toBeTruthy();
    expect(screen.queryByText("أغنيتي الأولى")).toBeNull();
    // A word that lives only in a general article finds nothing here.
    fireEvent.change(screen.getByLabelText("كلمة البحث في الأغاني"), { target: { value: "الصبر" } });
    expect(screen.queryByText("أغنيتي الثانية")).toBeNull();
    expect(screen.getByText(/لا نتائج/)).toBeTruthy();
  });

  it("delete is the shared undoable flow: requestDelete plus a «تراجع» toast", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([song1, song2]));
    render(<SongsSection />);
    fireEvent.click(screen.getByRole("button", { name: "حذف بطاقة song-1" }));
    expect(vi.mocked(requestDelete)).toHaveBeenCalledWith("song-1");
    const toastMock = vi.mocked(toast);
    expect(toastMock).toHaveBeenCalledWith("حُذفت الأغنية", expect.objectContaining({
      action: expect.objectContaining({ label: "تراجع" }),
    }));
    // The toast's undo action restores through the same shared flow.
    const action = (toastMock.mock.calls[0]?.[1] as unknown as { action: { onClick: () => void } }).action;
    action.onClick();
    expect(vi.mocked(undoDelete)).toHaveBeenCalledWith("song-1");
  });

  it("empty state is one warm line plus the way to record a first song", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([general]));
    render(<SongsSection />);
    expect(screen.getByText(/لسه مفيش أغاني هنا/)).toBeTruthy();
    expect(screen.getByText("سجّل أغنية")).toBeTruthy();
    expect(screen.queryByText("أغنيتي الأولى")).toBeNull();
  });
});
