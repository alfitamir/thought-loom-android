import { describe, expect, it } from "vitest";
import { buildDriveFile, mergeDriveState, parseDriveFile } from "./drive-merge";
import type { Idea } from "./ideas";

const idea = (id: string, updatedAt = 1, body = id): Idea => ({ id, text: id, createdAt: 1, articleTitle: id, articleBody: body, updatedAt });

describe("Google Drive backup merge", () => {
  it("keeps the newer edition of an article from either side", () => {
    const merged = mergeDriveState({ ideas: [idea("a", 5, "drive")], deleted: [] }, [idea("a", 3, "phone")], [], []);
    expect(merged.ideas.map((i) => i.articleBody)).toEqual(["drive"]);
  });
  it("removes an idea deleted on another device", () => {
    const merged = mergeDriveState({ ideas: [], deleted: ["a"] }, [idea("a"), idea("b")], [], []);
    expect(merged.ideas.map((i) => i.id)).toEqual(["b"]);
  });
  it("brings back an idea the user restored from a backup file", () => {
    const merged = mergeDriveState({ ideas: [], deleted: ["a"] }, [idea("a")], [], ["a"]);
    expect(merged.ideas.map((i) => i.id)).toEqual(["a"]);
    expect(merged.deleted).toEqual([]);
  });
  it("records deletions made on this phone in the Drive file", () => {
    const merged = mergeDriveState({ ideas: [idea("a")], deleted: [] }, [], ["a"], []);
    expect(merged.ideas).toEqual([]);
    expect(parseDriveFile(buildDriveFile(merged)).deleted).toEqual(["a"]);
  });
  it("reads an older backup saved as a plain list of ideas", () => {
    expect(parseDriveFile(JSON.stringify([idea("a")])).ideas.map((i) => i.id)).toEqual(["a"]);
  });
});
