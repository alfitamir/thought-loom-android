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