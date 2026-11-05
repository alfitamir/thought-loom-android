import { describe, expect, it } from "vitest";
import { isMergeComplete, mergeUnits, missingMergeLines, normalizeForCompare } from "./article-ai";

// The merge guard compares NORMALIZED lines/sentences: spelling-convention
// differences (ة/ه، ي/ى، hamza forms, markdown, punctuation, tatweel) must not
// fail a merge that kept the content, while a genuinely dropped sentence must
// still fail — and be reported verbatim so the owner can see the loss.
describe("normalizeForCompare", () => {
  it("unifies ة/ه and ى/ي spellings", () => {
    expect(normalizeForCompare("المدرسة الكبيرة على الكرسي")).toBe(
      normalizeForCompare("المدرسه الكبيره علي الكرسي"),
    );
  });
  it("unifies hamza forms (أ/إ/آ، ؤ/و، ئ/ي)", () => {
    expect(normalizeForCompare("الأمة تؤمن بالقراءة")).toBe(
      normalizeForCompare("الامة تومن بالقراءه"),
    );
    expect(normalizeForCompare("القارئ المسؤول")).toBe(normalizeForCompare("القاري المسوول"));
  });
  it("ignores markdown markers, punctuation and tatweel", () => {
    expect(normalizeForCompare("## **المهم:** أنْ نفهمَ الكتـــاب")).toBe(
      normalizeForCompare("المهم ان نفهم الكتاب"),
    );
  });
});

describe("merge completeness (normalized)", () => {
  const a =
    "الدولة القوية تبني مؤسسات عادلة تحفظ للناس حقوقهم وكرامتهم دائمًا. والمجتمع الواعي يراقب الأداء العام ويحاسب المقصرين بلا تردد.";
  const b =
    "المقاومة فكرة تبدأ من رفض الظلم وتنتهي ببناء الإنسان الحر القادر. والأمة التي تنسى تاريخها تفقد بوصلتها نحو المستقبل القريب.";

  it("accepts a verbatim merge of both sources", () => {
    expect(isMergeComplete([a, b], `${a}\n\n${b}`)).toBe(true);
    expect(missingMergeLines([a, b], `${a}\n\n${b}`)).toEqual([]);
  });

  it("accepts the same content respelled in the other Arabic convention (ة→ه، ى→ي، hamza dropped)", () => {
    const respelled =
      "الدوله القويه تبني موسسات عادله تحفظ للناس حقوقهم وكرامتهم دايما. والمجتمع الواعي يراقب الاداء العام ويحاسب المقصرين بلا تردد.\n\nالمقاومه فكره تبدا من رفض الظلم وتنتهي ببناء الانسان الحر القادر. والامه التي تنسي تاريخها تفقد بوصلتها نحو المستقبل القريب.";
    expect(isMergeComplete([a, b], respelled)).toBe(true);
  });

  it("accepts a lightly rephrased line (one word swapped in a long sentence)", () => {
    const rephrased = a.replace("يراقب الأداء العام", "يتابع الأداء العام");
    expect(isMergeComplete([a], rephrased)).toBe(true);
  });

  it("rejects a merge that drops a middle sentence — and reports it verbatim", () => {
    const dropped = "المقاومة فكرة تبدأ من رفض الظلم وتنتهي ببناء الإنسان الحر القادر.";
    const out = `${a}\n\nوالأمة التي تنسى تاريخها تفقد بوصلتها نحو المستقبل القريب.`;
    expect(isMergeComplete([a, b], out)).toBe(false);
    expect(missingMergeLines([a, b], out)).toEqual([dropped]);
  });

  it("reports every unit of a wholly dropped source, once each", () => {
    expect(missingMergeLines([a, b], a)).toEqual([
      "المقاومة فكرة تبدأ من رفض الظلم وتنتهي ببناء الإنسان الحر القادر.",
      "والأمة التي تنسى تاريخها تفقد بوصلتها نحو المستقبل القريب.",
    ]);
    expect(missingMergeLines([b, b], a)).toHaveLength(2);
  });

  it("ignores tiny fragments so they can neither fail nor pass a merge", () => {
    expect(isMergeComplete([`${a}\nنعم.`], a)).toBe(true);
    expect(mergeUnits("نعم. حسنا إذن")).toEqual([]);
  });

  it("splits paragraphs into sentence units", () => {
    expect(mergeUnits(a)).toEqual([
      "الدولة القوية تبني مؤسسات عادلة تحفظ للناس حقوقهم وكرامتهم دائمًا.",
      "والمجتمع الواعي يراقب الأداء العام ويحاسب المقصرين بلا تردد.",
    ]);
  });
});
