import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Idea } from "@/lib/ideas";

// The editor is a heavy surface of its own; the card's contract is only
// that tapping opens it for the picked idea — a stub stands in for it.
vi.mock("@/components/article-editor", () => ({
  ArticleEditor: ({ idea }: { idea: Idea }) => <div data-testid="editor-stub">{idea.id}</div>,
}));
// Deletion plumbing is not under test here.
vi.mock("@/lib/delete-flow", () => ({
  requestDelete: vi.fn(),
  undoDelete: vi.fn(() => true),
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));

import { ArchiveCard } from "@/components/archive-card";

const DAY = 24 * 60 * 60 * 1000;
const old = (id: string, title: string, over: Partial<Idea> = {}): Idea => ({
  id,
  text: `نص ${title} الكامل هنا`,
  articleTitle: title,
  articleBody: `نص ${title} الكامل هنا`,
  createdAt: Date.now() - 90 * DAY,
  updatedAt: Date.now() - 90 * DAY,
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("ArchiveCard («من أرشيفك»)", () => {
  it("renders nothing when nothing is old enough", () => {
    localStorage.setItem(
      "afkari.ideas",
      JSON.stringify([
        old("fresh", "فكرة جديدة", { createdAt: Date.now() - DAY, updatedAt: Date.now() - DAY }),
      ]),
    );
    const { container } = render(<ArchiveCard />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("من أرشيفك")).toBeNull();
  });

  it("shows one old idea with its topic and age, and «واحدة تانية» cycles to the next", () => {
    localStorage.setItem(
      "afkari.ideas",
      JSON.stringify([old("a", "المقال الأول"), old("b", "المقال الثاني")]),
    );
    const first = render(<ArchiveCard />);
    expect(screen.getByText("من أرشيفك")).toBeTruthy();
    const firstShown = screen.queryByText("المقال الأول") ? "المقال الأول" : "المقال الثاني";
    const other = firstShown === "المقال الأول" ? "المقال الثاني" : "المقال الأول";
    expect(screen.getByText(firstShown)).toBeTruthy();
    expect(screen.getByText(/منذ/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /واحدة تانية/ }));
    expect(screen.getByText(other)).toBeTruthy();
    expect(screen.queryByText(firstShown)).toBeNull();
    first.unmount();
    // The cycle offset survives a reload within the day.
    render(<ArchiveCard />);
    expect(screen.getByText(other)).toBeTruthy();
  });

  it("shows the source marker for a liked article", () => {
    localStorage.setItem(
      "afkari.ideas",
      JSON.stringify([old("liked-1", "مقال أعجبني", { liked: true, source: "مدونة النور" })]),
    );
    render(<ArchiveCard />);
    expect(screen.getByText("أعجبني")).toBeTruthy();
    expect(screen.getByText("المصدر: مدونة النور")).toBeTruthy();
  });

  it("opens the picked idea in the editor on tap", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([old("a", "المقال الأول")]));
    render(<ArchiveCard />);
    fireEvent.click(screen.getByRole("button", { name: /فتح: المقال الأول/ }));
    expect(screen.getByTestId("editor-stub").textContent).toBe("a");
  });

  it("dismiss hides the card for the rest of the day, across remounts", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([old("a", "المقال الأول")]));
    const first = render(<ArchiveCard />);
    fireEvent.click(screen.getByRole("button", { name: "إخفاء البطاقة اليوم" }));
    expect(screen.queryByText("من أرشيفك")).toBeNull();
    first.unmount();
    render(<ArchiveCard />);
    expect(screen.queryByText("من أرشيفك")).toBeNull();
  });

  it("never resurfaces an idea pending deletion", () => {
    localStorage.setItem("afkari.ideas", JSON.stringify([old("a", "المقال الأول")]));
    localStorage.setItem(
      "afkari.pendingDeletes",
      JSON.stringify([{ id: "a", deadline: Date.now() + 60_000 }]),
    );
    const { container } = render(<ArchiveCard />);
    expect(container.firstChild).toBeNull();
  });
});
