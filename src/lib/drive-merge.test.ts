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
  it("round-trips a hand-pinned topic through the Drive file", () => {
    const pinned: Idea = { ...idea("a"), topic: "موضوعي", topicManual: true };
    const back = parseDriveFile(buildDriveFile({ ideas: [pinned], deleted: [] }));
    expect(back.ideas[0]).toMatchObject({ topic: "موضوعي", topicManual: true });
  });
  it("round-trips a library pin through the Drive file", () => {
    const pinned: Idea = { ...idea("a"), pinned: true };
    const back = parseDriveFile(buildDriveFile({ ideas: [pinned], deleted: [] }));
    expect(back.ideas[0]).toMatchObject({ pinned: true });
  });
  it("round-trips medical section membership through the Drive file", () => {
    const medical: Idea = { ...idea("a"), medical: true };
    const back = parseDriveFile(buildDriveFile({ ideas: [medical], deleted: [] }));
    expect(back.ideas[0]).toMatchObject({ medical: true });
  });
  it("keeps medical membership when the Drive edition of the text is newer", () => {
    const local: Idea = { ...idea("a", 2), medical: true };
    const merged = mergeDriveState({ ideas: [idea("a", 5, "drive")], deleted: [] }, [local], [], []);
    expect(merged.ideas[0]).toMatchObject({ articleBody: "drive", medical: true });
  });
  it("keeps a hand-pinned topic when the Drive edition of the text is newer", () => {
    const local: Idea = { ...idea("a", 2), topic: "موضوعي", topicManual: true };
    const merged = mergeDriveState({ ideas: [idea("a", 5, "drive")], deleted: [] }, [local], [], []);
    expect(merged.ideas[0]).toMatchObject({ articleBody: "drive", topic: "موضوعي", topicManual: true });
  });
  it("round-trips a liked article with its attribution through the Drive file", () => {
    const liked: Idea = { ...idea("a"), liked: true, source: "مجلة الفكر", sources: ["موقع آخر"] };
    const back = parseDriveFile(buildDriveFile({ ideas: [liked], deleted: [] }));
    expect(back.ideas[0]).toMatchObject({ liked: true, source: "مجلة الفكر", sources: ["موقع آخر"] });
  });
  it("keeps liked + attribution when the Drive edition of the text is newer", () => {
    const local: Idea = { ...idea("a", 2), liked: true, source: "مصدر محلي", sources: ["واحد"] };
    const merged = mergeDriveState({ ideas: [idea("a", 5, "drive")], deleted: [] }, [local], [], []);
    expect(merged.ideas[0]).toMatchObject({ articleBody: "drive", liked: true, source: "مصدر محلي", sources: ["واحد"] });
  });
});
