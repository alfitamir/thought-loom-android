import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Idea } from "@/lib/ideas";

// Same stubbing scheme as medical-views.test.tsx: router links are plain
// anchors and the editor card is a title stub — these tests cover the
// VIEWS' selection-mode contract and the shared CompileBar, not the card.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children, ...props }: Record<string, unknown>) => <a {...props}>{children as React.ReactNode}</a>,
  };
});
vi.mock("@/components/article-editor", () => ({
  ArticleEditor: ({ idea }: { idea: Idea }) => <div data-testid="card">{idea.articleTitle ?? idea.text}</div>,
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
import { MedicalSection } from "@/routes/medical";

const mk = (over: Partial<Idea>): Idea => ({
  id: Math.random().toString(36).slice(2),
  text: "نص",
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});
const article = mk({ articleTitle: "مقالة للتجميع", articleBody: "محتوى المقالة", topic: "موضوع عام", topicManual: true });
const song = mk({ articleTitle: "أغنية مسجلة", text: "كلمات الأغنية", topic: "موضوع عام", topicManual: true, song: true });
const liked = mk({ articleTitle: "مقالة أعجبتني", articleBody: "نص خارجي", topic: "موضوع عام", topicManual: true, liked: true, source: "مدونة ما" });
const medical = mk({ articleTitle: "مقالة طبية للتجميع", articleBody: "محتوى طبي", topic: "موضوع طبي", topicManual: true, medical: true });

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

describe("library selection mode", () => {
  it("checkboxes on articles and liked — never on songs — and the bar counts, compiles and cancels", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article, song, liked]));
    render(<Library />);
    // No bar and no checkboxes before selection mode.
    expect(screen.queryByText("تجميع في مستند")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "اختيار" }));
    fireEvent.click(screen.getByRole("button", { name: /موضوع عام/ }));
    expect(screen.getByRole("checkbox", { name: "اختيار مقالة: مقالة للتجميع" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "اختيار مقالة: مقالة أعجبتني" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /أغنية مسجلة/ })).toBeNull();
    expect(screen.getByText("لم تُختر مقالات بعد")).toBeTruthy();
    // The compile action stays disabled until something is picked.
    expect((screen.getByRole("button", { name: /تجميع في مستند/ }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole("checkbox", { name: "اختيار مقالة: مقالة للتجميع" }));
    expect(screen.getByText("تم اختيار 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "اختيار مقالة: مقالة أعجبتني" }));
    expect(screen.getByText("تم اختيار 2")).toBeTruthy();
    // Unchecking drops the count again.
    fireEvent.click(screen.getByRole("checkbox", { name: "اختيار مقالة: مقالة للتجميع" }));
    expect(screen.getByText("تم اختيار 1")).toBeTruthy();

    // The compile dialog offers both deliveries.
    fireEvent.click(screen.getByRole("button", { name: /تجميع في مستند/ }));
    expect(screen.getByRole("button", { name: /تنزيل Markdown/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /طباعة \/ PDF/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    // إلغاء exits the mode and clears the picks and the checkboxes.
    fireEvent.click(screen.getByRole("button", { name: /إلغاء/ }));
    expect(screen.queryByText(/تم اختيار/)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("toggling «اختيار» off also clears an in-progress selection", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article]));
    render(<Library />);
    fireEvent.click(screen.getByRole("button", { name: "اختيار" }));
    fireEvent.click(screen.getByRole("button", { name: /موضوع عام/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "اختيار مقالة: مقالة للتجميع" }));
    expect(screen.getByText("تم اختيار 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "اختيار" }));
    expect(screen.queryByText(/تم اختيار/)).toBeNull();
    // Back in selection mode, the count starts from zero again.
    fireEvent.click(screen.getByRole("button", { name: "اختيار" }));
    expect(screen.getByText("لم تُختر مقالات بعد")).toBeTruthy();
  });
});

describe("medical selection mode", () => {
  it("offers the same selection + compile bar over the medical partition", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([article, medical]));
    render(<MedicalSection />);
    fireEvent.click(screen.getByRole("button", { name: "اختيار" }));
    fireEvent.click(screen.getByRole("button", { name: /موضوع طبي/ }));
    expect(screen.getByRole("checkbox", { name: "اختيار مقالة: مقالة طبية للتجميع" })).toBeTruthy();
    // The general article never appears here, so neither does its checkbox.
    expect(screen.queryByRole("checkbox", { name: /مقالة للتجميع/ })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "اختيار مقالة: مقالة طبية للتجميع" }));
    expect(screen.getByText("تم اختيار 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /إلغاء/ }));
    expect(screen.queryByText(/تم اختيار/)).toBeNull();
  });
});
