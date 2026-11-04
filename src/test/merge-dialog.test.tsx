import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadIdeas, type Idea } from "@/lib/ideas";
import { fingerprint, saveSuggestionCache } from "@/lib/merge";

// The dialog's contract under test: a proposal that fails the completeness
// guard is shown WITH its missing lines and can only be applied through the
// explicit «قبول رغم النقص» (which keeps the originals); after two failed AI
// attempts the lossless manual concatenation is offered and completes.
vi.mock("@/lib/sync", () => ({ pushIdea: vi.fn(async () => {}) }));
vi.mock("@/lib/ai-engine", () => ({ resolveEngine: vi.fn(async () => ({ kind: "cloud", token: "T" })) }));
vi.mock("@/lib/gemini", () => ({ getGeminiKey: () => "test-key" }));
vi.mock("@/lib/article-audio", () => ({ deleteSongAudio: vi.fn(async () => {}) }));
vi.mock("@/lib/song-drive", () => ({ deleteSongDriveCopy: vi.fn(async () => {}) }));
vi.mock("@/components/evidence-dialog", () => ({ EvidenceDialog: () => null }));
vi.mock("@/lib/article-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/article-ai")>();
  return { ...actual, runAi: vi.fn() };
});

import { MergeBanner } from "@/components/merge-banner";
import { runAi } from "@/lib/article-ai";

const runAiMock = vi.mocked(runAi);

const bodyA = "الدولة القوية تبني مؤسسات عادلة تحفظ للناس حقوقهم وكرامتهم دائمًا. والمجتمع الواعي يراقب الأداء العام ويحاسب المقصرين بلا تردد.";
const bodyB = "المقاومة فكرة تبدأ من رفض الظلم وتنتهي ببناء الإنسان الحر القادر. والأمة التي تنسى تاريخها تفقد بوصلتها نحو المستقبل القريب.";
const ideaA: Idea = { id: "a", text: bodyA, createdAt: 1, updatedAt: 10, articleTitle: "مقال الدولة", articleBody: bodyA };
const ideaB: Idea = { id: "b", text: bodyB, createdAt: 2, updatedAt: 10, articleTitle: "مقال المقاومة", articleBody: bodyB };
const ideas = [ideaA, ideaB];

const scriptMerge = (text: string) =>
  runAiMock.mockImplementation(async () => text);

function openDialog(onChange = vi.fn()) {
  localStorage.setItem("afkari.ideas", JSON.stringify(ideas));
  saveSuggestionCache(fingerprint(ideas), [{ ids: ["a", "b"], title: "مقال مدمج", reason: "تشابه" }]);
  render(<MergeBanner ideas={ideas} online onChange={onChange} />);
  fireEvent.click(screen.getByText(/نقترح دمج/));
  return onChange;
}

beforeEach(() => {
  localStorage.clear();
  runAiMock.mockReset();
});

describe("MergeDialog completeness states", () => {
  it("shows the missing lines and only the explicit accept-despite action when the proposal is incomplete", async () => {
    scriptMerge(`مدمج\n\n${bodyA}`);
    openDialog();
    expect(await screen.findByText(/الأسطر غير الموجودة في النسخة المقترحة \(2\)/)).toBeTruthy();
    expect(screen.getByText("المقاومة فكرة تبدأ من رفض الظلم وتنتهي ببناء الإنسان الحر القادر.")).toBeTruthy();
    expect(screen.getByText("قبول رغم النقص")).toBeTruthy();
    // The normal one-tap approvals must NOT be reachable in this state.
    expect(screen.queryByText("اعتماد وحذف الأصول")).toBeNull();
    expect(screen.queryByText("حفظه كمقال جديد")).toBeNull();
    // And the fallback is not offered after a single failure.
    expect(screen.queryByText("دمج يدوي بالتتابع")).toBeNull();
  });

  it("accept-despite saves the proposal as a new article and KEEPS the originals", async () => {
    scriptMerge(`مدمج\n\n${bodyA}`);
    const onChange = openDialog();
    fireEvent.click(await screen.findByText("قبول رغم النقص"));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const all = loadIdeas();
    expect(all.map((i) => i.id)).toEqual(expect.arrayContaining(["a", "b"]));
    const merged = all.find((i) => i.id !== "a" && i.id !== "b");
    expect(merged?.articleBody).toBe(bodyA);
    expect(merged?.mergedFrom).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("after the 2nd failed attempt offers the manual sequential merge, which completes losslessly", async () => {
    scriptMerge(`مدمج\n\n${bodyA}`);
    const onChange = openDialog();
    expect(await screen.findByText("قبول رغم النقص")).toBeTruthy();
    fireEvent.click(screen.getByText("إعادة المحاولة"));
    expect(await screen.findByText("دمج يدوي بالتتابع")).toBeTruthy();
    fireEvent.click(screen.getByText("دمج يدوي بالتتابع"));
    const area = await screen.findByLabelText("نص المقال المدمج");
    expect((area as HTMLTextAreaElement).value).toBe(`${bodyA}\n\n${bodyB}`);
    fireEvent.click(screen.getByText("اعتماد وحذف الأصول"));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const all = loadIdeas();
    expect(all.map((i) => i.id)).not.toContain("a");
    expect(all.map((i) => i.id)).not.toContain("b");
    const merged = all.find((i) => i.mergedFrom?.includes("a"));
    expect(merged?.articleBody).toBe(`${bodyA}\n\n${bodyB}`);
    expect(merged?.mergedFrom).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("a complete proposal still applies in one tap, as before", async () => {
    scriptMerge(`مدمج\n\n${bodyA}\n\n${bodyB}`);
    const onChange = openDialog();
    fireEvent.click(await screen.findByText("اعتماد وحذف الأصول"));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const all = loadIdeas();
    expect(all).toHaveLength(1);
    expect(all[0]?.articleBody).toBe(`${bodyA}\n\n${bodyB}`);
    expect(screen.queryByText("قبول رغم النقص")).toBeNull();
  });
});
