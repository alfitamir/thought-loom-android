import { describe, it, expect } from "vitest";
import { classify, toArticle, OTHER } from "./ideas";

describe("ideas", () => {
  it("classifies by topic keywords", () => {
    expect(classify("فكرة عن النجاح في العمل")).toBe("العمل والنجاح");
    expect(classify("كلام عام بلا موضوع")).toBe(OTHER);
  });
  it("removes fillers and ends with punctuation", () => {
    const a = toArticle("امم الصبر مفتاح الفرج");
    expect(a.paragraphs[0]).toBe("الصبر مفتاح الفرج.");
  });
});
