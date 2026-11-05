import { describe, expect, it } from "vitest";
import {
  composeXPost,
  xCharCount,
  X_DISCLAIMER,
  X_POST_LIMIT,
  type XPostInput,
} from "@/lib/x-post";

const hashtags = (post: string) => post.match(/#/g)?.length ?? 0;

describe("xCharCount", () => {
  it("counts characters the way X weighs them: one per BMP char, two for emoji", () => {
    expect(xCharCount("")).toBe(0);
    expect(xCharCount("abc")).toBe(3);
    expect(xCharCount("سلام")).toBe(4);
    expect(xCharCount("a😀b")).toBe(4);
    expect(xCharCount("سطر\nسطر")).toBe(7);
  });
});

describe("composeXPost — the 280 guarantee", () => {
  it("never exceeds the limit across a property-style sweep of shapes", () => {
    const cases: XPostInput[] = [];
    for (const titleLen of [0, 10, 100, 200, 279, 280, 281, 400, 800]) {
      for (const bodyLen of [0, 50, 500, 3000]) {
        cases.push({
          title: "ت".repeat(titleLen),
          body: "نص ".repeat(Math.ceil(bodyLen / 3)).slice(0, bodyLen),
          medical: titleLen % 2 === 0,
          topic: "جراحة",
        });
      }
    }
    // Word-boundary-friendly long texts, Latin text, emoji in the body.
    cases.push({
      title: "كلمة ".repeat(90).trim(),
      body: "جملة ".repeat(400).trim(),
      medical: true,
      topic: "جراحة",
    });
    cases.push({
      title: "A very long English title ".repeat(20).trim(),
      body: "Some English sentence. ".repeat(200),
      medical: false,
    });
    cases.push({
      title: "عنوان فيه إيموجي 😀",
      body: "نص 😀😀😀 ".repeat(300),
      medical: true,
      topic: "صحة",
    });
    for (const input of cases) {
      const post = composeXPost(input);
      expect(xCharCount(post)).toBeLessThanOrEqual(X_POST_LIMIT);
      expect(hashtags(post)).toBeLessThanOrEqual(2);
      if (input.title.trim()) expect(post.length).toBeGreaterThan(0);
    }
  });

  it("empty input composes to an empty post", () => {
    expect(composeXPost({ title: "", body: "" })).toBe("");
    expect(composeXPost({ title: "   ", body: "  " })).toBe("");
  });

  it("a title alone is the whole post when the body adds nothing", () => {
    expect(composeXPost({ title: "عنوان وحده", body: "" })).toBe("عنوان وحده");
    expect(
      composeXPost({ title: "", body: "الجملة الأولى هنا. والثانية بعدها." }).split("\n")[0],
    ).toBe("الجملة الأولى هنا.");
  });
});

describe("composeXPost — the hook", () => {
  it("preserves the hook verbatim while a huge body is trimmed around it", () => {
    const title = "هل كل حصوة مرارة تعني عملية؟";
    const post = composeXPost({ title, body: "جملة طويلة جدًا ".repeat(300) });
    expect(post.split("\n")[0]).toBe(title);
    expect(xCharCount(post)).toBeLessThanOrEqual(X_POST_LIMIT);
  });

  it("restores the question mark on a question-word title that lost it", () => {
    const post = composeXPost({ title: "هل كل حصوة مرارة تعني عملية", body: "النص هنا." });
    expect(post.split("\n")[0]).toBe("هل كل حصوة مرارة تعني عملية؟");
  });

  it("passes a misconception-correction title through untouched", () => {
    const title = "ليس كل حصوة مرارة تعني عملية";
    const post = composeXPost({ title, body: "التفصيل في المقال. ".repeat(30) });
    expect(post.split("\n")[0]).toBe(title);
  });

  it("trims the hook itself only when it alone overflows the limit", () => {
    const title = "كلمة ".repeat(120).trim(); // ~599 chars
    const post = composeXPost({ title, body: "أي نص" });
    expect(xCharCount(post)).toBeLessThanOrEqual(X_POST_LIMIT);
    expect(post.split("\n")[0]!.endsWith("…")).toBe(true);
    expect(post).not.toContain("أي نص");
  });
});

describe("composeXPost — the insight", () => {
  it("takes the body's first sentence, skipping one that repeats the hook", () => {
    const post = composeXPost({
      title: "العنوان",
      body: "العنوان الكبير يبدأ هنا. الجملة الثانية المفيدة. وثالثة لا تلزم.",
    });
    expect(post.split("\n")[1]).toBe("الجملة الثانية المفيدة.");
  });

  it("trims a long insight at a word boundary with an ellipsis", () => {
    const sentence = `${Array.from({ length: 60 }, () => "كلمة").join(" ")} أخيرة.`;
    const post = composeXPost({ title: "عنوان قصير", body: sentence });
    const insight = post.split("\n")[1]!;
    expect(insight.endsWith("…")).toBe(true);
    const kept = insight.slice(0, -1);
    expect(sentence.startsWith(kept)).toBe(true);
    expect(sentence[kept.length]).toBe(" "); // cut fell on a boundary, never mid-word
    expect(xCharCount(post)).toBeLessThanOrEqual(X_POST_LIMIT);
  });

  it("drops the insight when only a stub would fit, keeping the hook whole", () => {
    const title = "ع".repeat(260);
    const post = composeXPost({ title, body: "جملة مفيدة طويلة ".repeat(50) });
    expect(post).toBe(title);
  });
});

describe("composeXPost — the medical disclaimer", () => {
  it("closes a medical post with the disclaimer when space allows", () => {
    const post = composeXPost({
      title: "ما علاج الفتق الإربي؟",
      body: "العلاج يختلف بحسب الحالة.",
      medical: true,
    });
    expect(post.split("\n").at(-1)).toBe(X_DISCLAIMER);
  });

  it("never adds the disclaimer to a non-medical post", () => {
    const post = composeXPost({
      title: "ما علاج الفتق الإربي؟",
      body: "العلاج يختلف بحسب الحالة.",
    });
    expect(post).not.toContain(X_DISCLAIMER);
  });

  it("reserves the disclaimer's room: the insight is trimmed, the close survives", () => {
    const post = composeXPost({ title: "أ".repeat(200), body: "جملة ".repeat(200), medical: true });
    expect(post.split("\n").at(-1)).toBe(X_DISCLAIMER);
    expect(xCharCount(post)).toBeLessThanOrEqual(X_POST_LIMIT);
  });

  it("drops the disclaimer when there is genuinely no room for it", () => {
    const post = composeXPost({ title: "ع".repeat(260), body: "نص", medical: true });
    expect(post).not.toContain(X_DISCLAIMER);
    expect(xCharCount(post)).toBeLessThanOrEqual(X_POST_LIMIT);
  });
});

describe("composeXPost — hashtags stay rare and capped", () => {
  it("adds at most one tag, from a single-word topic", () => {
    const post = composeXPost({ title: "عنوان", body: "نص المقال.", topic: "جراحة" });
    expect(post.split("\n").at(-1)).toBe("#جراحة");
    expect(hashtags(post)).toBe(1);
  });

  it("adds none for phrase topics, the misc bucket, or no topic", () => {
    expect(composeXPost({ title: "عنوان", body: "نص.", topic: "الإيمان والروح" })).not.toContain(
      "#",
    );
    expect(composeXPost({ title: "عنوان", body: "نص.", topic: "متفرقات" })).not.toContain("#");
    expect(composeXPost({ title: "عنوان", body: "نص." })).not.toContain("#");
  });

  it("sacrifices the hashtag first when space runs out", () => {
    const post = composeXPost({ title: "ب".repeat(240), body: "", medical: true, topic: "جراحة" });
    expect(post.split("\n").at(-1)).toBe(X_DISCLAIMER); // the close kept its room
    expect(post).not.toContain("#");
    expect(xCharCount(post)).toBeLessThanOrEqual(X_POST_LIMIT);
  });
});
