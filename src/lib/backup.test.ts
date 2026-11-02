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
});
