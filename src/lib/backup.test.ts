import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildBackup, parseBackup, restoreBackup } from "./backup";
import { loadIdeas, saveIdea, type Idea } from "./ideas";

const sample: Idea[] = [{ id: "x1", text: "نص", createdAt: 5, articleTitle: "ع", articleBody: "ب", updatedAt: 6 }];

describe("backup", () => {
  it("round-trips ideas", () => {
    expect(parseBackup(buildBackup(sample))).toEqual(sample);
  });
  it("accepts a wrapped exported backup (synthetic fixture)", () => {
    const raw = readFileSync("src/test/fixtures/sample-backup.json", "utf8");
    expect(parseBackup(raw)).toHaveLength(3);
  });
  it("accepts a bare array of ideas", () => {
    expect(parseBackup(JSON.stringify(sample))).toHaveLength(1);
  });
  it.each([
    ["not json", "ليس نسخة احتياطية صالحة"],
    ['{"app":"other","ideas":[]}', "ليس نسخة احتياطية من"],
    ['{"app":"afkari","ideas":[{"x":1}]}', "لم نجد أفكارًا صالحة"],
  ])("rejects %s", (raw, message) => {
    expect(() => parseBackup(raw)).toThrow(message);
  });
  it("drops malformed entries but keeps valid ones", () => {
    const raw = JSON.stringify({ app: "afkari", version: 1, ideas: [...sample, { nope: true }] });
    expect(parseBackup(raw)).toHaveLength(1);
  });
  it("round-trips version history, dropping malformed version entries", () => {
    const withVersions: Idea[] = [{
      ...sample[0]!,
      versions: [
        { at: 10, text: "قديم", title: "ع قديم", source: "improve" },
        { at: 9, text: "أقدم", source: "merge" },
      ],
    }];
    expect(parseBackup(buildBackup(withVersions))).toEqual(withVersions);
    const dirty = JSON.stringify({
      app: "afkari", version: 1,
      ideas: [{
        ...sample[0],
        versions: [
          { at: "x", text: "تالف", source: "improve" },
          { at: 3, text: "", source: "clean" },
          { at: 2, text: "مصدر مجهول", source: "bogus" },
          { at: 1, text: "سليم", source: "restore" },
        ],
      }],
    });
    expect(parseBackup(dirty)[0]?.versions).toEqual([{ at: 1, text: "سليم", source: "restore" }]);
  });
  it("restore adds only missing ideas and reports the count", () => {
    const before = loadIdeas().length;
    expect(restoreBackup(sample)).toBe(1);
    expect(loadIdeas()).toHaveLength(before + 1);
    expect(restoreBackup(sample)).toBe(0);
  });
  it("restore never overwrites a newer local edit", () => {
    const mine = saveIdea("local");
    restoreBackup([{ ...mine, text: "stale", updatedAt: (mine.updatedAt ?? 0) - 1 }]);
    expect(loadIdeas().find((i) => i.id === mine.id)!.text).toBe("local");
  });
  it("restore fires the ideas-changed event so open screens refresh", () => {
    let fired = 0;
    const on = () => fired++;
    window.addEventListener("afkari:ideas-changed", on);
    restoreBackup(sample);
    window.removeEventListener("afkari:ideas-changed", on);
    expect(fired).toBe(1);
  });
  it("round-trips a hand-pinned topic", () => {
    const pinned: Idea[] = [{ id: "p1", text: "نص", createdAt: 5, topic: "موضوعي", topicManual: true }];
    expect(parseBackup(buildBackup(pinned))).toEqual(pinned);
  });
  it("round-trips a library pin", () => {
    const pinned: Idea[] = [{ id: "p9", text: "نص", createdAt: 5, pinned: true }];
    expect(parseBackup(buildBackup(pinned))).toEqual(pinned);
  });
  it("round-trips medical section membership", () => {
    const medical: Idea[] = [{ id: "m1", text: "نص طبي", createdAt: 5, medical: true }];
    expect(parseBackup(buildBackup(medical))).toEqual(medical);
  });
  it("drops a pin flag that arrives without its topic", () => {
    const raw = JSON.stringify([{ id: "p2", text: "نص", createdAt: 5, topicManual: true }]);
    expect(parseBackup(raw)[0]).not.toHaveProperty("topicManual");
  });
  it("restore brings a hand-pinned topic onto an existing unpinned article", () => {
    const mine = saveIdea("نص محلي");
    restoreBackup([{ ...mine, topic: "موضوعي", topicManual: true }]);
    expect(loadIdeas().find((i) => i.id === mine.id)).toMatchObject({ topic: "موضوعي", topicManual: true });
  });
  it("round-trips a liked article with its source and accumulated sources", () => {
    const liked: Idea[] = [{ id: "l1", text: "نص خارجي", createdAt: 5, liked: true, source: "مجلة الفكر", sources: ["موقع آخر", "كاتب ضيف"] }];
    expect(parseBackup(buildBackup(liked))).toEqual(liked);
  });
  it("drops malformed attribution entries but keeps the liked flag and clean sources", () => {
    const raw = JSON.stringify([{ id: "l2", text: "نص", createdAt: 5, liked: true, source: 42, sources: ["صالح", 7, "", null] }]);
    const [parsed] = parseBackup(raw);
    expect(parsed).toMatchObject({ liked: true, sources: ["صالح"] });
    expect(parsed).not.toHaveProperty("source");
  });
});
