import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Idea } from "@/lib/ideas";

// Router links render as anchors carrying their `to`/`search` as data
// attributes, so a deep link can be asserted without standing up a router.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children, to, search, ...props }: Record<string, unknown>) => (
      <a data-to={to as string} data-search={JSON.stringify(search)} {...props}>{children as React.ReactNode}</a>
    ),
  };
});
// The editor card is a heavy surface of its own; these tests cover where
// the FAB lives, so a stub renders each card's title (same as the views'
// own test files).
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

import { buildRecordSearch, RecordFab } from "@/components/record-fab";
import { Library } from "@/routes/library";
import { MedicalSection } from "@/routes/medical";

const mk = (over: Partial<Idea>): Idea => ({
  id: Math.random().toString(36).slice(2),
  text: "نص",
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});
const medical = mk({ articleTitle: "مقالة طبية", articleBody: "محتوى طبي", topic: "موضوع طبي", topicManual: true, medical: true });

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

const fabSearch = (label: string) => {
  const el = screen.getByLabelText(label);
  return { to: el.getAttribute("data-to"), search: JSON.parse(el.getAttribute("data-search") ?? "{}") as { record?: number; section?: string } };
};

describe("buildRecordSearch — the recorder deep-link builder", () => {
  it("carries the medical context when the section asks for it", () => {
    expect(buildRecordSearch("medical", 1234567890)).toEqual({ record: 1234567890, section: "medical" });
  });

  it("is a bare nonce without a section", () => {
    expect(buildRecordSearch(undefined, 42)).toEqual({ record: 42 });
  });

  it("asks the clock anew on every call — two calls, two nonces", () => {
    let tick = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => (tick += 1000));
    const first = buildRecordSearch("medical");
    const second = buildRecordSearch("medical");
    expect(first.record).not.toBe(second.record);
    expect(second.record).toBeGreaterThan(first.record ?? 0);
  });
});

describe("RecordFab", () => {
  it("deep-links home with a fresh record nonce and the medical context", () => {
    vi.spyOn(Date, "now").mockReturnValue(987654321);
    render(<RecordFab section="medical" />);
    const { to, search } = fabSearch("سجّل فكرة طبية");
    expect(to).toBe("/");
    expect(search).toEqual({ record: 987654321, section: "medical" });
  });

  it("without a section it is the plain record deep link", () => {
    vi.spyOn(Date, "now").mockReturnValue(123456789);
    render(<RecordFab />);
    const { to, search } = fabSearch("سجّل فكرة");
    expect(to).toBe("/");
    expect(search).toEqual({ record: 123456789 });
  });

  it("every mount mints a new nonce — nothing is cached between taps", () => {
    let tick = 5000;
    vi.spyOn(Date, "now").mockImplementation(() => (tick += 500));
    const first = render(<RecordFab section="medical" />);
    const firstNonce = fabSearch("سجّل فكرة طبية").search.record;
    first.unmount();
    render(<RecordFab section="medical" />);
    const secondNonce = fabSearch("سجّل فكرة طبية").search.record;
    expect(secondNonce).not.toBe(firstNonce);
  });
});

describe("where the FAB lives", () => {
  it("renders on /medical, carrying the section's context", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([medical]));
    render(<MedicalSection />);
    const { to, search } = fabSearch("سجّل فكرة طبية");
    expect(to).toBe("/");
    expect(search.section).toBe("medical");
    expect(typeof search.record).toBe("number");
    expect(search.record ?? 0).toBeGreaterThan(0);
  });

  it("is absent from the library — the bottom nav owns record there", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([medical]));
    render(<Library />);
    expect(screen.queryByLabelText("سجّل فكرة طبية")).toBeNull();
    expect(screen.queryByLabelText("سجّل فكرة")).toBeNull();
  });
});
