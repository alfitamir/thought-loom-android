import { beforeEach, describe, expect, it } from "vitest";
import {
  clearProject,
  loadIdeas,
  mergeIdeas,
  projectOptions,
  renameProject,
  replaceIdeas,
  saveIdea,
  setProject,
  updateArticle,
  type Idea,
} from "./ideas";
import { buildBackup, parseBackup } from "./backup";
import { buildDriveFile, parseDriveFile } from "./drive-merge";
import { composeDocument } from "./document";

describe("project assignment", () => {
  beforeEach(() => localStorage.clear());

  it("assigns and clears a project without ever bumping updatedAt", () => {
    const idea = saveIdea("فكرة للمشروع");
    const edited = updateArticle(idea.id, "عنوان", "نص المقال") ?? idea;
    const stamp = edited.updatedAt;
    const filed = setProject(idea.id, "كتاب الجراحة");
    expect(filed?.project).toBe("كتاب الجراحة");
    expect(filed?.updatedAt).toBe(stamp);
    expect(loadIdeas().find((i) => i.id === idea.id)?.project).toBe("كتاب الجراحة");
    const cleared = setProject(idea.id, null);
    expect(cleared).not.toHaveProperty("project");
    expect(cleared?.updatedAt).toBe(stamp);
  });

  it("trims names, treats an empty name as a clear, and no-ops on the current assignment", () => {
    const idea = saveIdea("فكرة");
    expect(setProject(idea.id, "  مشروعي  ")?.project).toBe("مشروعي");
    expect(setProject(idea.id, "مشروعي")?.project).toBe("مشروعي");
    expect(setProject(idea.id, "   ")).not.toHaveProperty("project");
    expect(setProject(idea.id, null)).not.toHaveProperty("project");
    expect(setProject("missing-id", "س")).toBeUndefined();
  });

  it("derives project lists with counts, busiest first, ignoring unassigned and blank names", () => {
    const ideas: Idea[] = [
      { id: "1", text: "أ", createdAt: 1, project: "ب" },
      { id: "2", text: "ب", createdAt: 2, project: "أ" },
      { id: "3", text: "ج", createdAt: 3, project: "ب" },
      { id: "4", text: "د", createdAt: 4 },
      { id: "5", text: "هـ", createdAt: 5, project: "  " },
    ];
    expect(projectOptions(ideas)).toEqual([
      { project: "ب", count: 2 },
      { project: "أ", count: 1 },
    ]);
    expect(projectOptions([])).toEqual([]);
  });

  it("an edition without a project never un-files the winner; the winner keeps its own project", () => {
    const local: Idea = {
      id: "1",
      text: "الأصل",
      createdAt: 1,
      updatedAt: 2,
      articleBody: "محلي",
      project: "كتابي",
    };
    const [winner] = mergeIdeas(
      [local],
      [{ id: "1", text: "الأصل", createdAt: 1, updatedAt: 3, articleBody: "سحابي" }],
      [],
    );
    expect(winner?.articleBody).toBe("سحابي");
    expect(winner?.project).toBe("كتابي");
    // Winner already filed: a different project on the losing edition does not move it.
    const [kept] = mergeIdeas(
      [{ ...local, updatedAt: 5, articleBody: "الأحدث" }],
      [{ ...local, updatedAt: 4, project: "مشروع آخر" }],
      [],
    );
    expect(kept?.project).toBe("كتابي");
    // Unfiled winner adopts the other edition's project.
    const bare: Idea = { id: "2", text: "س", createdAt: 1, updatedAt: 9, articleBody: "محلي" };
    const [adopted] = mergeIdeas([bare], [{ ...bare, updatedAt: 1, project: "سلسلة" }], []);
    expect(adopted?.project).toBe("سلسلة");
  });
});

describe("project rename and dissolve (partition-scoped)", () => {
  beforeEach(() => localStorage.clear());
  const seed = () =>
    replaceIdeas([
      { id: "g1", text: "أ", createdAt: 1, updatedAt: 7, project: "ملف" },
      { id: "g2", text: "ب", createdAt: 2, updatedAt: 7, project: "ملف" },
      { id: "m1", text: "ج", createdAt: 3, updatedAt: 7, project: "ملف", medical: true },
      { id: "g3", text: "د", createdAt: 4, updatedAt: 7, project: "آخر" },
    ]);

  it("renames only the members of its own partition — the same name elsewhere is untouched", () => {
    seed();
    expect(renameProject(false, "ملف", "الملف الجديد")).toBe(2);
    const all = loadIdeas();
    expect(all.find((i) => i.id === "g1")?.project).toBe("الملف الجديد");
    expect(all.find((i) => i.id === "g2")?.project).toBe("الملف الجديد");
    expect(all.find((i) => i.id === "m1")?.project).toBe("ملف");
    // Metadata only: no timestamp moved anywhere.
    expect(all.every((i) => i.updatedAt === 7)).toBe(true);
    // And the medical side renames independently.
    expect(renameProject(true, "ملف", "ملف طبي")).toBe(1);
    expect(loadIdeas().find((i) => i.id === "m1")?.project).toBe("ملف طبي");
  });

  it("renaming onto an existing name in the partition merges the two projects", () => {
    seed();
    expect(renameProject(false, "ملف", "آخر")).toBe(2);
    expect(projectOptions(loadIdeas().filter((i) => !i.medical))).toEqual([
      { project: "آخر", count: 3 },
    ]);
  });

  it("rename no-ops on an empty or unchanged name", () => {
    seed();
    expect(renameProject(false, "ملف", "ملف")).toBe(0);
    expect(renameProject(false, "ملف", "   ")).toBe(0);
    expect(renameProject(false, "غير موجود", "جديد")).toBe(0);
  });

  it("dissolving unassigns the partition's members and never touches the articles", () => {
    seed();
    expect(clearProject(true, "ملف")).toBe(1);
    const all = loadIdeas();
    expect(all.find((i) => i.id === "m1")).not.toHaveProperty("project");
    expect(all.find((i) => i.id === "g1")?.project).toBe("ملف");
    // The article itself survives intact — same id, same text.
    expect(all.find((i) => i.id === "m1")?.text).toBe("ج");
    expect(clearProject(false, "ملف")).toBe(2);
    expect(loadIdeas().filter((i) => i.project === "ملف")).toEqual([]);
  });
});

describe("project plumbing round-trips", () => {
  beforeEach(() => localStorage.clear());

  it("survives a backup export/restore round trip", () => {
    const idea: Idea = { id: "p1", text: "نص", createdAt: 5, project: "كتابي" };
    const [back] = parseBackup(buildBackup([idea]));
    expect(back).toMatchObject({ id: "p1", project: "كتابي" });
  });

  it("survives the Google Drive file round trip", () => {
    const idea: Idea = { id: "p1", text: "نص", createdAt: 5, project: "سلسلة محاضرات" };
    const back = parseDriveFile(buildDriveFile({ ideas: [idea], deleted: [] }));
    expect(back.ideas[0]).toMatchObject({ project: "سلسلة محاضرات" });
  });

  it("a malformed project value in a backup is dropped, not guessed", () => {
    const raw = JSON.stringify({
      app: "afkari",
      version: 1,
      ideas: [{ id: "p1", text: "نص", createdAt: 5, project: 42 }],
    });
    const [back] = parseBackup(raw);
    expect(back).not.toHaveProperty("project");
  });
});

describe("whole-project compile content", () => {
  it("composes exactly the member set, with a liked member's attribution intact", () => {
    const members: Idea[] = [
      {
        id: "1",
        text: "نص",
        createdAt: 1,
        articleTitle: "فصل أول",
        articleBody: "متن الفصل الأول",
        project: "كتابي",
        topic: "موضوع",
        topicManual: true,
      },
      {
        id: "2",
        text: "نص",
        createdAt: 2,
        articleTitle: "فصل مقتبس",
        articleBody: "متن مقتبس",
        project: "كتابي",
        topic: "موضوع",
        topicManual: true,
        liked: true,
        source: "مجلة الجراحة",
      },
    ];
    const outsider: Idea = {
      id: "3",
      text: "نص",
      createdAt: 3,
      articleTitle: "مقالة خارجية",
      articleBody: "ليست في المشروع",
      topic: "موضوع",
      topicManual: true,
    };
    const doc = composeDocument(members);
    expect(doc).toContain("فصل أول");
    expect(doc).toContain("فصل مقتبس");
    expect(doc).toContain("المصدر: مجلة الجراحة");
    expect(doc).not.toContain(outsider.articleTitle);
  });
});
