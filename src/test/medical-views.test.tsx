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
// VIEWS' partition contract, so a stub renders each card's title.
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
const general = mk({ articleTitle: "فكرة عامة فريدة", articleBody: "محتوى عام عن الصبر والتأمل", topic: "موضوع عام", topicManual: true });
const medical = mk({ articleTitle: "مقالة طبية سرية", articleBody: "محتوى طبي عن الجراحة والفتق", topic: "موضوع طبي", topicManual: true, medical: true });

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

describe("main library partition", () => {
  it("never shows medical articles — and its door card carries the medical count", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([general, medical]));
    render(<Library />);
    // The entry card to the medical section, with its count.
    expect(screen.getByText("القسم الطبي")).toBeTruthy();
    expect(screen.getByText(/1 مقالة طبية/)).toBeTruthy();
    // The general topic group renders; the medical one does not exist here.
    expect(screen.getByText("موضوع عام")).toBeTruthy();
    expect(screen.queryByText("موضوع طبي")).toBeNull();
    expect(screen.queryByText("مقالة طبية سرية")).toBeNull();
    // Expanding the general group shows the general article only.
    fireEvent.click(screen.getByRole("button", { name: /موضوع عام/ }));
    expect(screen.getByText("فكرة عامة فريدة")).toBeTruthy();
    expect(screen.queryByText("مقالة طبية سرية")).toBeNull();
  });

  it("search in the main library cannot reach medical content", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([general, medical]));
    render(<Library />);
    fireEvent.click(screen.getByRole("button", { name: "بحث في المقالات" }));
    fireEvent.change(screen.getByLabelText("كلمة البحث"), { target: { value: "الجراحة" } });
    expect(screen.getByText(/لا نتائج/)).toBeTruthy();
    expect(screen.queryByText("مقالة طبية سرية")).toBeNull();
  });
});

describe("medical section view", () => {
  it("shows only medical articles, grouped by topic, with capture buttons", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([general, medical]));
    render(<MedicalSection />);
    expect(screen.getByRole("heading", { name: /القسم الطبي/ })).toBeTruthy();
    expect(screen.getAllByText("سجّل فكرة طبية").length).toBeGreaterThan(0);
    expect(screen.getAllByText("اكتب فكرة طبية").length).toBeGreaterThan(0);
    // Only the medical group exists here.
    expect(screen.getByText("موضوع طبي")).toBeTruthy();
    expect(screen.queryByText("موضوع عام")).toBeNull();
    expect(screen.queryByText("فكرة عامة فريدة")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /موضوع طبي/ }));
    expect(screen.getByText("مقالة طبية سرية")).toBeTruthy();
    expect(screen.queryByText("فكرة عامة فريدة")).toBeNull();
  });

  it("search in the medical view reaches medical content only", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([general, medical]));
    render(<MedicalSection />);
    fireEvent.click(screen.getByRole("button", { name: "بحث في القسم الطبي" }));
    fireEvent.change(screen.getByLabelText("كلمة البحث في القسم الطبي"), { target: { value: "الصبر" } });
    expect(screen.queryByText("مقالة طبية سرية")).toBeNull();
    fireEvent.change(screen.getByLabelText("كلمة البحث في القسم الطبي"), { target: { value: "الجراحة" } });
    expect(screen.getByText("مقالة طبية سرية")).toBeTruthy();
  });

  it("empty state is one warm line plus the two capture buttons", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([general]));
    render(<MedicalSection />);
    expect(screen.getByText(/القسم الطبي فاضي لسه/)).toBeTruthy();
    expect(screen.getAllByText("سجّل فكرة طبية").length).toBe(2);
    expect(screen.getAllByText("اكتب فكرة طبية").length).toBe(2);
    expect(screen.queryByText("مقالة طبية سرية")).toBeNull();
  });
});
