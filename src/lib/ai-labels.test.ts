import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Idea } from "./ideas";

const classifyBatch = vi.fn();
vi.mock("./ai-features", () => ({ classifyBatch: (...a: unknown[]) => classifyBatch(...a) }));
import { labelAll, labelFor, loadLabels, unlabeled } from "./ai-labels";

const idea = (id: string, updatedAt = 1, text = "غزة والمقاومة"): Idea => ({ id, text, createdAt: 1, updatedAt });
// Afkari's shared test setup cleared localStorage around every test; Thought Loom's does
// not, so this suite (whose storage is its subject) clears it locally instead.
beforeEach(() => { classifyBatch.mockReset(); localStorage.clear(); });

describe("ai labels", () => {
  it("falls back to the offline keyword topic before any AI label exists", () => {
    const l = labelFor(idea("a"));
    expect(l).toMatchObject({ ai: false, tags: [] });
    expect(l.topic).toBe("الأمة والعالم");
  });
  it("stores labels, then reports them as fresh", async () => {
    classifyBatch.mockResolvedValue({ a: { topic: "الصحة", tags: ["نوم"] } });
    expect(await labelAll([idea("a")])).toBe(1);
    expect(labelFor(idea("a"))).toEqual({ topic: "الصحة", tags: ["نوم"], ai: true });
    expect(unlabeled([idea("a")])).toEqual([]);
  });
  it("invalidates a label when the article is edited", async () => {
    classifyBatch.mockResolvedValue({ a: { topic: "الصحة", tags: ["نوم"] } });
    await labelAll([idea("a", 1)]);
    expect(labelFor(idea("a", 2)).ai).toBe(false);
    expect(unlabeled([idea("a", 2)])).toHaveLength(1);
  });
  it("batches, reports progress, and only sends stale ideas", async () => {
    const many = Array.from({ length: 65 }, (_, i) => idea(`i${i}`));
    classifyBatch.mockImplementation(async (chunk: Idea[]) => Object.fromEntries(chunk.map((c) => [c.id, { topic: "الصحة", tags: [] }])));
    const progress: number[] = [];
    await labelAll(many, { onProgress: (d) => progress.push(d) });
    expect(classifyBatch.mock.calls.map((c) => c[0].length)).toEqual([30, 30, 5]);
    expect(progress).toEqual([30, 60, 65]);
    classifyBatch.mockClear();
    expect(await labelAll(many)).toBe(0);
    expect(classifyBatch).not.toHaveBeenCalled();
  });
  it("keeps progress from earlier batches when a later batch fails", async () => {
    const many = Array.from({ length: 40 }, (_, i) => idea(`i${i}`));
    classifyBatch
      .mockImplementationOnce(async (chunk: Idea[]) => Object.fromEntries(chunk.map((c) => [c.id, { topic: "الصحة", tags: [] }])))
      .mockRejectedValueOnce(new Error("quota"));
    await expect(labelAll(many)).rejects.toThrow("quota");
    expect(Object.keys(loadLabels())).toHaveLength(30);
    expect(unlabeled(many)).toHaveLength(10);
  });
  it("survives corrupted storage", () => {
    localStorage.setItem("afkari.aiLabels", "{broken");
    expect(labelFor(idea("a")).ai).toBe(false);
  });
});
