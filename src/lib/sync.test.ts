import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadIdeas, replaceIdeas, type Idea } from "./ideas";
import { syncNow } from "./sync";

// The Supabase sync, exercised end to end with the client doubled: a
// chainable stub that serves the seeded cloud rows and records every
// row the sync tries to upsert.
const h = vi.hoisted(() => {
  const state = {
    ideasRows: [] as Record<string, unknown>[],
    deletionRows: [] as { idea_id: string }[],
    ideaUpserts: [] as Record<string, unknown>[],
  };
  type Chain = {
    select: () => Chain;
    delete: () => Chain;
    upsert: (rows: Record<string, unknown>[]) => Chain;
    eq: () => Chain;
    in: () => Chain;
    then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => Promise<unknown>;
  };
  const chain = (table: string): Chain => {
    let op = "";
    const result = () => {
      if (op === "select" && table === "ideas") return { data: state.ideasRows, error: null };
      if (op === "select" && table === "idea_deletions") return { data: state.deletionRows, error: null };
      return { data: null, error: null };
    };
    const self: Chain = {
      select: () => { op = "select"; return self; },
      delete: () => { op = "delete"; return self; },
      upsert: (rows) => {
        op = "upsert";
        if (table === "ideas") state.ideaUpserts.push(...rows);
        return self;
      },
      eq: () => self,
      in: () => self,
      then: (onOk, onErr) => Promise.resolve(result()).then(onOk, onErr),
    };
    return self;
  };
  return { state, chain };
});

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: "user-1" } } } }) },
    from: (table: string) => h.chain(table),
  },
}));
vi.mock("./drive-sync", () => ({ syncDrive: async () => ({ ok: true, restored: 0 }) }));

/** A cloud row as PostgREST serves it, every column present. */
const cloudRow = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "a", text: "نص المقال", created_at: 100, article_title: null, article_body: null,
  updated_at: 1000, ai_polished_at: null, merged_from: null, topic: null, topic_manual: false,
  song: false, song_duration: null, drive_file_id: null, liked: false, source: null, sources: null,
  pinned: false, medical: false, project: null, versions: null,
  ...patch,
});

const localIdea = (patch: Partial<Idea> = {}): Idea => ({
  id: "a", text: "نص المقال", createdAt: 100, updatedAt: 1000, ...patch,
});

describe("Supabase sync — aiPolishedAt", () => {
  beforeEach(() => {
    localStorage.clear();
    h.state.ideasRows = [];
    h.state.deletionRows = [];
    h.state.ideaUpserts = [];
  });

  it("brings the cloud polish stamp onto a device that never polished", async () => {
    h.state.ideasRows = [cloudRow({ ai_polished_at: 700 })];
    await syncNow();
    expect(loadIdeas()).toHaveLength(1);
    expect(loadIdeas()[0]?.aiPolishedAt).toBe(700);
    // Nothing differs from the cloud edition, so nothing is written back.
    expect(h.state.ideaUpserts).toEqual([]);
  });

  it("uploads an idea whose only change is the polish stamp", async () => {
    replaceIdeas([localIdea({ aiPolishedAt: 500 })]);
    h.state.ideasRows = [cloudRow({ ai_polished_at: null })];
    await syncNow();
    expect(h.state.ideaUpserts).toHaveLength(1);
    expect(h.state.ideaUpserts[0]).toMatchObject({ id: "a", ai_polished_at: 500 });
  });

  it("writes nothing when the polish stamp already matches the cloud", async () => {
    replaceIdeas([localIdea({ aiPolishedAt: 500 })]);
    h.state.ideasRows = [cloudRow({ ai_polished_at: 500 })];
    await syncNow();
    expect(h.state.ideaUpserts).toEqual([]);
  });
});
