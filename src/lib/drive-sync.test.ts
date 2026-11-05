import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDriveFile, parseDriveFile } from "./drive-merge";
import { driveSync } from "./drive-sync.server";
import type { Idea } from "./ideas";

// The Drive sync handler, exercised end to end with the two network edges
// doubled: Supabase auth (the caller is the app owner) and the Drive
// gateway fetch (an existing sync file, then the rewrite upload).
const h = vi.hoisted(() => ({ uploads: [] as string[] }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "owner-1" } }, error: null }) },
  }),
}));

const likedIdea: Idea = {
  id: "liked-1",
  text: "نص المقال كما نُشر",
  createdAt: 100,
  articleTitle: "مقال أعجبني",
  articleBody: "نص المقال كما نُشر",
  updatedAt: 1000,
  liked: true,
  source: "مجلة الفكر",
  sources: ["موقع آخر", "مدوّنة الناقد"],
};

describe("driveSync (server)", () => {
  beforeEach(() => {
    process.env["SUPABASE_URL"] = "https://example.supabase.co";
    process.env["SUPABASE_PUBLISHABLE_KEY"] = "publishable-key";
    process.env["LOVABLE_API_KEY"] = "lovable-key";
    process.env["GOOGLE_DRIVE_API_KEY"] = "drive-key";
    process.env["DRIVE_OWNER_USER_ID"] = "owner-1";
    h.uploads.length = 0;
    const emptyDriveFile = buildDriveFile({ ideas: [], deleted: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.includes("alt=media")) return new Response(emptyDriveFile, { status: 200 });
        if (url.includes("upload/drive/v3/files")) {
          h.uploads.push(String(init?.body ?? ""));
          return new Response("{}", { status: 200 });
        }
        return Response.json({ files: [{ id: "drive-file-1" }] });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a liked article's flag and attribution through the whole Drive round-trip", async () => {
    const request = new Request("http://localhost/api/drive/sync", {
      method: "POST",
      headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
      body: JSON.stringify({ ideas: [likedIdea], deleted: [], revived: [] }),
    });
    const res = await driveSync(request);
    expect(res.status).toBe(200);
    // The merged state the handler answers with…
    const body = (await res.json()) as { ideas: Idea[]; deleted: string[] };
    expect(body.ideas).toHaveLength(1);
    expect(body.ideas[0]).toMatchObject({
      liked: true,
      source: "مجلة الفكر",
      sources: ["موقع آخر", "مدوّنة الناقد"],
    });
    // …and the file actually written back to Drive both carry the three
    // fields — a restore from it must never un-like the article.
    expect(h.uploads).toHaveLength(1);
    const written = parseDriveFile(h.uploads[0] ?? "");
    expect(written.ideas[0]).toMatchObject({
      liked: true,
      source: "مجلة الفكر",
      sources: ["موقع آخر", "مدوّنة الناقد"],
    });
  });
});
