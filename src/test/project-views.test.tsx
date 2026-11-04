import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadIdeas, type Idea } from "@/lib/ideas";

// Router links render as plain anchors; routing itself is covered elsewhere.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children, ...props }: Record<string, unknown>) => <a {...props}>{children as React.ReactNode}</a>,
  };
});
// The editor card is a heavy surface of its own; these tests cover the
// VIEWS' project contract, so a stub renders each card's title.
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
import { ProjectView } from "@/routes/project";

const mk = (over: Partial<Idea>): Idea => ({
  id: Math.random().toString(36).slice(2),
  text: "نص",
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});
const inBook = mk({ articleTitle: "فصل في الكتاب", articleBody: "متن", topic: "موضوع أ", topicManual: true, project: "كتابي" });
const inBook2 = mk({ articleTitle: "فصل ثانٍ", articleBody: "متن", topic: "موضوع ب", topicManual: true, project: "كتابي" });
const noProject = mk({ articleTitle: "مقالة حرة", articleBody: "متن", topic: "موضوع أ", topicManual: true });
const medSameName = mk({ articleTitle: "فصل طبي بنفس الاسم", articleBody: "متن", topic: "موضوع طبي", topicManual: true, project: "كتابي", medical: true });
const medProject = mk({ articleTitle: "مقالة الملف الطبي", articleBody: "متن", topic: "موضوع طبي", topicManual: true, project: "ملف طبي", medical: true });

const seed = (ideas: Idea[]) => localStorage.setItem("afkari.ideas", JSON.stringify(ideas));

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

describe("projects strip discovery", () => {
  it("the library strip lists the MAIN partition's projects with counts — never the medical ones", () => {
    seed([inBook, inBook2, noProject, medSameName, medProject]);
    render(<Library />);
    expect(screen.getByText("المشاريع")).toBeTruthy();
    // The general «كتابي» counts its two general members only — the
    // medical article with the same project name is a different project.
    const chip = screen.getByText("كتابي").closest("a");
    expect(chip?.textContent).toContain("2");
    expect(screen.queryByText("ملف طبي")).toBeNull();
  });

  it("no strip at all when the partition has no projects", () => {
    seed([noProject]);
    render(<Library />);
    expect(screen.queryByText("المشاريع")).toBeNull();
  });

  it("the medical strip lists medical projects only", () => {
    seed([inBook, medProject, medSameName]);
    render(<MedicalSection />);
    expect(screen.getByText("المشاريع")).toBeTruthy();
    expect(screen.getByText("ملف طبي")).toBeTruthy();
    // The medical «كتابي» chip counts its single medical member.
    const chip = screen.getByText("كتابي").closest("a");
    expect(chip?.textContent).toContain("1");
  });
});

describe("project view", () => {
  it("shows only its own partition's members, grouped by topic", () => {
    seed([inBook, inBook2, noProject, medSameName]);
    render(<ProjectView project="كتابي" medical={false} />);
    expect(screen.getByRole("heading", { name: /كتابي/ })).toBeTruthy();
    expect(screen.getByText("موضوع أ")).toBeTruthy();
    expect(screen.getByText("موضوع ب")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /موضوع أ/ }));
    expect(screen.getByText("فصل في الكتاب")).toBeTruthy();
    // Same topic but no project: not a member. Medical same-name: another project.
    expect(screen.queryByText("مقالة حرة")).toBeNull();
    expect(screen.queryByText("فصل طبي بنفس الاسم")).toBeNull();
  });

  it("offers whole-project compile with both document deliveries", () => {
    seed([inBook, inBook2]);
    render(<ProjectView project="كتابي" medical={false} />);
    fireEvent.click(screen.getByRole("button", { name: /تجميع المشروع في مستند/ }));
    expect(screen.getByRole("button", { name: /تنزيل Markdown/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /طباعة \/ PDF/ })).toBeTruthy();
  });

  it("rename moves only this partition's members and reports the new name", () => {
    const g = mk({ articleTitle: "عام", project: "ملف" });
    const m = mk({ articleTitle: "طبي", project: "ملف", medical: true });
    seed([g, m]);
    const onRenamed = vi.fn();
    render(<ProjectView project="ملف" medical={false} onRenamed={onRenamed} />);
    fireEvent.click(screen.getByRole("button", { name: /إعادة تسمية المشروع/ }));
    fireEvent.change(screen.getByLabelText("اسم المشروع الجديد"), { target: { value: "الملف الجديد" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ الاسم الجديد" }));
    const all = loadIdeas();
    expect(all.find((i) => i.id === g.id)?.project).toBe("الملف الجديد");
    expect(all.find((i) => i.id === m.id)?.project).toBe("ملف");
    expect(onRenamed).toHaveBeenCalledWith("الملف الجديد");
  });

  it("delete dissolves the project — members unassigned, articles untouched", () => {
    const g = mk({ articleTitle: "عام", articleBody: "متن كامل", project: "ملف" });
    const m = mk({ articleTitle: "طبي", project: "ملف", medical: true });
    seed([g, m]);
    const onDeleted = vi.fn();
    render(<ProjectView project="ملف" medical={false} onDeleted={onDeleted} />);
    fireEvent.click(screen.getByRole("button", { name: "حذف المشروع" }));
    const confirm = screen.getAllByRole("button", { name: "حذف المشروع" }).at(-1)!;
    fireEvent.click(confirm);
    const all = loadIdeas();
    expect(all.find((i) => i.id === g.id)).not.toHaveProperty("project");
    expect(all.find((i) => i.id === g.id)?.articleBody).toBe("متن كامل");
    expect(all.find((i) => i.id === m.id)?.project).toBe("ملف");
    expect(onDeleted).toHaveBeenCalled();
  });

  it("an unknown project name shows the empty state", () => {
    seed([inBook]);
    render(<ProjectView project="وهمي" medical={false} />);
    expect(screen.getByText(/لا يوجد مشروع بهذا الاسم/)).toBeTruthy();
  });
});
