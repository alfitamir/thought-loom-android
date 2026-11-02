import { describe, expect, it } from "vitest";
import { parseImprovedArticle, readArticleStream } from "./article-ai";

describe("AI proofreading", () => {
  it("separates the proposed title and body without rewriting the response", () => {
    expect(parseImprovedArticle("الصبر\n\nأنا شايف إن الصبر مهم." )).toEqual({ title: "الصبر", body: "أنا شايف إن الصبر مهم." });
  });
  it("rejects incomplete proofreading rather than applying an empty article", () => {
    expect(() => parseImprovedArticle("عنوان فقط")).toThrow();
  });
  it("reads split streaming chunks into the full article", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({ start(c) {
      c.enqueue(encoder.encode('{"type":"text","text":"الص'));
      c.enqueue(encoder.encode('بر\\n\\n"}\n{"type":"text","text":"مهم."}\n{"type":"done"}\n'));
      c.close();
    } });
    expect(await readArticleStream(new Response(stream), () => {})).toBe("الصبر\n\nمهم.");
  });
  it("surfaces a terminal credit failure without retrying", async () => {
    await expect(readArticleStream(Response.json({ message: "نفدت أرصدة الذكاء الاصطناعي" }, { status: 402 }), () => {})).rejects.toThrow("نفدت أرصدة الذكاء الاصطناعي");
  });
  it("rejects an interrupted stream before applying the result", async () => {
    await expect(readArticleStream(new Response('{"type":"text","text":"غير مكتمل"}\n'), () => {})).rejects.toThrow("انقطع الاتصال");
  });
});
import { isComplete, splitChunks } from "./article-ai";
describe("content preservation", () => {
  const src = "أنا شايف إن الصبر مهم جدًا في الحياة. والنجاح بييجي مع الوقت والتعب والاجتهاد المستمر كل يوم.";
  it("accepts a proofread version that keeps every sentence", () => {
    expect(isComplete(src, "أنا شايف إن الصبر مهم جدًا في الحياة، والنجاح بييجي مع الوقت والتعب والاجتهاد المستمر كل يوم.")).toBe(true);
  });
  it("rejects a version whose last lines were dropped", () => {
    expect(isComplete(src, "أنا شايف إن الصبر مهم جدًا في الحياة.")).toBe(false);
  });
  it("splits long articles on paragraph boundaries without losing text", () => {
    const body = Array.from({ length: 5 }, (_, i) => `فقرة ${i} ` + "كلمة ".repeat(600)).join("\n\n");
    const chunks = splitChunks(body);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n\n")).toBe(body);
  });
});

import { afterEach, beforeEach, vi } from "vitest";
import { cleanFull } from "./article-ai";
import { TASK_INSTRUCTIONS } from "./ai-prompts";

const geminiStream = vi.fn();
vi.mock("./gemini", async (orig) => ({ ...(await orig<typeof import("./gemini")>()), geminiStream: (...a: unknown[]) => geminiStream(...a) }));

describe("cleanFull (library bulk cleanup dispatch)", () => {
  const srcBody = "أنا شايف إن الصبر مهم جدًا في الحياة. والنجاح بييجي مع الوقت والتعب والاجتهاد المستمر كل يوم.";
  const cleaned = "الصبر\n\nأنا شايف إن الصبر مهم جدًا في الحياة، والنجاح بييجي مع الوقت والتعب والاجتهاد المستمر كل يوم.";
  const article = { title: "الصبر", body: srcBody };
  const fetchMock = vi.fn();
  beforeEach(() => { geminiStream.mockReset(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => vi.unstubAllGlobals());
  const ndjson = (text: string) => new Response(
    `${JSON.stringify({ type: "text", text })}\n${JSON.stringify({ type: "done" })}\n`,
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } });

  it("uses the clean task on the cloud route and sends no samples or original", async () => {
    fetchMock.mockResolvedValue(ndjson(cleaned));
    const out = await cleanFull(article, { kind: "cloud", token: "T" }, new AbortController().signal, () => {});
    expect(out.title).toBe("الصبر");
    expect(out.body).toContain("مهم جدًا في الحياة، والنجاح");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/articles/improve");
    const sent = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sent.task).toBe("clean");
    const payload = JSON.parse(sent.payload);
    expect(payload.title).toBe("الصبر");
    expect(payload.body).toBe(srcBody);
    expect(payload).not.toHaveProperty("samples");
    expect(payload).not.toHaveProperty("original");
  });

  it("uses the clean task with the bare cleanup instructions on the personal Gemini key", async () => {
    geminiStream.mockResolvedValue(cleaned);
    const out = await cleanFull(article, { kind: "gemini", key: "K" }, new AbortController().signal, () => {});
    expect(out.body).toContain("مهم جدًا في الحياة، والنجاح");
    expect(fetchMock).not.toHaveBeenCalled();
    const [, instructions, payload] = geminiStream.mock.calls[0]!;
    expect(instructions).toBe(TASK_INSTRUCTIONS.clean);
    expect(instructions).not.toContain("ملف صوت المؤلف");
    expect(JSON.parse(payload as string)).not.toHaveProperty("samples");
  });

  it("rejects a cleaned version that dropped content instead of applying it", async () => {
    geminiStream.mockResolvedValue("الصبر\n\nأنا شايف إن الصبر مهم.");
    await expect(cleanFull(article, { kind: "gemini", key: "K" }, new AbortController().signal, () => {}))
      .rejects.toThrow("النسخة المقترحة ناقصة");
  });
});
