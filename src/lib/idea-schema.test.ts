import { describe, expect, it } from "vitest";
import { IDEA_FIELDS, ideaSchema } from "./idea-schema";
import type { Idea } from "./ideas";

/**
 * The parity guard for the shared idea schema (audit F-3.1/F-3.2 class of
 * bug: a field added to the Idea type but missed by one persistence path).
 *
 * This fixture is typed `Record<keyof Idea, true>`, so `tsc` itself fails
 * if a field is added to — or removed from — the `Idea` type without this
 * list being updated; the test then fails if the schema's field list and
 * the type's field list drift apart in either direction.
 */
const EVERY_IDEA_FIELD: Record<keyof Idea, true> = {
  id: true,
  text: true,
  createdAt: true,
  articleTitle: true,
  articleBody: true,
  updatedAt: true,
  aiPolishedAt: true,
  mergedFrom: true,
  topic: true,
  topicManual: true,
  song: true,
  songDuration: true,
  liked: true,
  source: true,
  sources: true,
  driveFileId: true,
  pinned: true,
  medical: true,
  project: true,
  versions: true,
};

/** One idea with EVERY field populated — the round-trip guinea pig. */
const FULL_IDEA: Idea = {
  id: "full-1",
  text: "كلمات الأغنية أو نص الفكرة",
  createdAt: 1000,
  articleTitle: "عنوان",
  articleBody: "متن المقال",
  updatedAt: 2000,
  aiPolishedAt: 2000,
  mergedFrom: ["old-1", "old-2"],
  topic: "جراحة",
  topicManual: true,
  song: true,
  songDuration: 42,
  liked: true,
  source: "د. فلان — موقع كذا",
  sources: ["المصدر الأول", "المصدر الثاني"],
  driveFileId: "drive-file-1",
  pinned: true,
  medical: true,
  project: "كتابي",
  versions: [
    { at: 1500, text: "نسخة سابقة", title: "عنوان سابق", source: "improve" },
    { at: 1200, text: "أقدم", source: "restore" },
  ],
};

describe("idea schema parity", () => {
  it("covers exactly the Idea type's fields — no more, no fewer", () => {
    expect([...IDEA_FIELDS].sort()).toEqual(Object.keys(EVERY_IDEA_FIELD).sort());
  });

  it("round-trips a fully populated idea without stripping a single field", () => {
    const parsed = ideaSchema.parse(FULL_IDEA);
    expect(parsed).toEqual(FULL_IDEA);
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(EVERY_IDEA_FIELD).sort());
  });

  it("rejects an idea whose core identity is mistyped", () => {
    expect(ideaSchema.safeParse({ ...FULL_IDEA, createdAt: "1000" }).success).toBe(false);
    expect(
      ideaSchema.safeParse({ ...FULL_IDEA, versions: [{ at: 1, text: "x", source: "bogus" }] })
        .success,
    ).toBe(false);
  });
});
