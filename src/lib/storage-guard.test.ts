import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAST_GOOD_KEY,
  QUARANTINE_KEY,
  StorageWriteError,
  lastStorageWriteError,
  loadIdeas,
  onStorageWriteError,
  replaceIdeas,
  saveIdea,
  storedIdeasBytes,
  storedMirrorBytes,
  type Idea,
} from "./ideas";

// Audit F-3.3: the library lives in ONE localStorage value with a ~5 MB
// quota shared with everything else. These tests pin the safety net:
// a last-good mirror, typed write errors instead of silent loss, and a
// corruption fallback that never reads a damaged library as "empty".
const MAIN_KEY = "afkari.ideas";
const idea = (patch: Partial<Idea> = {}): Idea => ({
  id: "a",
  text: "نص محفوظ",
  createdAt: 1,
  ...patch,
});

const quotaError = () => new DOMException("The quota has been exceeded.", "QuotaExceededError");

/** Make Storage.setItem throw for the keys `failFor` approves; everything else writes through. */
const stubSetItem = (failFor: (key: string) => Error | null) => {
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    const err = failFor(key);
    if (err) throw err;
    return original.call(this, key, value);
  });
};

beforeEach(() => {
  localStorage.clear();
  // Reset the module's failure-streak state with one healthy write, then
  // start each test from a pristine store.
  replaceIdeas([]);
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("storage guard — last-good mirror", () => {
  it("mirrors every successful write byte for byte", () => {
    replaceIdeas([idea()]);
    expect(localStorage.getItem(LAST_GOOD_KEY)).toBe(localStorage.getItem(MAIN_KEY));
    expect(loadIdeas()).toEqual([idea()]);
  });
});

describe("storage guard — refused writes", () => {
  it("a quota refusal surfaces a typed error and leaves main + mirror untouched", () => {
    replaceIdeas([idea()]);
    const seedJson = localStorage.getItem(MAIN_KEY);
    const seen: StorageWriteError[] = [];
    const off = onStorageWriteError((e) => seen.push(e));
    stubSetItem((key) => (key === MAIN_KEY ? quotaError() : null));

    expect(() => replaceIdeas([idea({ id: "b", text: "جديد" })])).not.toThrow();
    off();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(StorageWriteError);
    expect(seen[0]?.quota).toBe(true);
    expect(seen[0]?.message).toContain("امتلأت");
    expect(lastStorageWriteError()).toBe(seen[0]);
    // Nothing was lost or half-written: the previous library is intact.
    expect(localStorage.getItem(MAIN_KEY)).toBe(seedJson);
    expect(localStorage.getItem(LAST_GOOD_KEY)).toBe(seedJson);
    expect(loadIdeas()).toEqual([idea()]);
  });

  it("only the first failure of a streak is broadcast; a success re-arms it", () => {
    const seen: StorageWriteError[] = [];
    const off = onStorageWriteError((e) => seen.push(e));
    stubSetItem((key) => (key === MAIN_KEY ? quotaError() : null));
    replaceIdeas([idea()]);
    replaceIdeas([idea()]);
    expect(seen).toHaveLength(1);
    expect(lastStorageWriteError()).not.toBeNull();

    vi.restoreAllMocks();
    replaceIdeas([idea()]);
    expect(lastStorageWriteError()).toBeNull();

    stubSetItem((key) => (key === MAIN_KEY ? quotaError() : null));
    replaceIdeas([idea()]);
    expect(seen).toHaveLength(2);
    off();
  });

  it("a non-quota refusal is typed as such, with the cautious message", () => {
    const seen: StorageWriteError[] = [];
    const off = onStorageWriteError((e) => seen.push(e));
    stubSetItem((key) => (key === MAIN_KEY ? new Error("storage blocked") : null));
    replaceIdeas([idea()]);
    off();
    expect(seen[0]?.quota).toBe(false);
    expect(seen[0]?.message).toContain("تعذّر الحفظ");
  });

  it("saveIdea routes through the same guard", () => {
    const seen: StorageWriteError[] = [];
    const off = onStorageWriteError((e) => seen.push(e));
    stubSetItem((key) => (key === MAIN_KEY ? quotaError() : null));
    expect(() => saveIdea("فكرة جديدة")).not.toThrow();
    off();
    expect(seen).toHaveLength(1);
  });
});

describe("storage guard — corruption fallback", () => {
  it("corrupt main JSON loads the last-good mirror and repairs the main value", () => {
    const good = [idea(), idea({ id: "b", text: "ثانية" })];
    const goodJson = JSON.stringify(good);
    localStorage.setItem(LAST_GOOD_KEY, goodJson);
    localStorage.setItem(MAIN_KEY, "{not json");
    expect(loadIdeas()).toEqual(good);
    expect(localStorage.getItem(MAIN_KEY)).toBe(goodJson);
  });

  it("a non-array main value counts as corruption too", () => {
    const good = [idea()];
    localStorage.setItem(LAST_GOOD_KEY, JSON.stringify(good));
    localStorage.setItem(MAIN_KEY, "42");
    expect(loadIdeas()).toEqual(good);
  });

  it("corrupt main AND mirror: quarantines both raw strings, reads empty, never throws", () => {
    localStorage.setItem(MAIN_KEY, "{bad main");
    localStorage.setItem(LAST_GOOD_KEY, "{bad mirror");
    expect(loadIdeas()).toEqual([]);
    const quarantined = JSON.parse(localStorage.getItem(QUARANTINE_KEY) ?? "[]") as Array<{
      key: string;
      raw: string;
    }>;
    expect(quarantined.map((q) => q.raw)).toContain("{bad main");
    expect(quarantined.map((q) => q.raw)).toContain("{bad mirror");
    // The store still works afterwards — the next write starts clean.
    replaceIdeas([idea()]);
    expect(loadIdeas()).toEqual([idea()]);
  });
});

describe("storage diet — slim mirror + version budget (Wave F)", () => {
  const enc = (s: string) => new TextEncoder().encode(s).length;
  // Deterministic fixture: 30 long articles, 5 frozen versions each.
  // Current bodies ~6 KB, version texts ~7 KB — history alone is ~1 MB,
  // over the 800,000-byte budget, so the write path must prune it.
  const fixture = (): Idea[] =>
    Array.from({ length: 30 }, (_, i) => ({
      id: `f${i}`,
      text: `raw-${i}`,
      createdAt: 1_000 + i,
      articleTitle: `مقال ${i}`,
      articleBody: `current-${i}-` + "c".repeat(6_000),
      versions: Array.from({ length: 5 }, (_, j) => ({
        at: 5_000 + i * 100 + (5 - j),
        text: `version-${i}-${j}-` + "v".repeat(7_000),
        title: `title-${i}-${j}`,
        source: "improve" as const,
      })),
    }));
  const versionBytesOf = (all: Idea[]) =>
    all.reduce(
      (sum, i) =>
        sum + (i.versions ?? []).reduce((s, e) => s + enc(e.text) + enc(e.title ?? ""), 0),
      0,
    );

  it("the mirror is slim: articles and current texts intact, versions stripped", () => {
    const ideas = fixture().slice(0, 3);
    replaceIdeas(ideas);
    const mirror = JSON.parse(localStorage.getItem(LAST_GOOD_KEY) ?? "[]") as Idea[];
    expect(mirror).toHaveLength(3);
    for (const [k, m] of mirror.entries()) {
      expect(m.articleBody).toBe(ideas[k]?.articleBody);
      expect(m).not.toHaveProperty("versions");
    }
    // Main still carries the history; the mirror gauge reports the slim size.
    const main = JSON.parse(localStorage.getItem(MAIN_KEY) ?? "[]") as Idea[];
    expect(main[0]?.versions).toHaveLength(5);
    expect(storedMirrorBytes()).toBe(enc(localStorage.getItem(LAST_GOOD_KEY) ?? ""));
    expect(storedMirrorBytes()).toBeLessThan(storedIdeasBytes());
  });

  it("a first save after the update replaces a fat legacy mirror with the slim one", () => {
    const ideas = fixture().slice(0, 2);
    localStorage.setItem(LAST_GOOD_KEY, JSON.stringify(ideas)); // legacy byte-for-byte shape
    replaceIdeas(ideas);
    const mirror = JSON.parse(localStorage.getItem(LAST_GOOD_KEY) ?? "[]") as Idea[];
    expect(mirror[0]).not.toHaveProperty("versions");
  });

  it("MEASUREMENT: budget holds after a write and the total footprint drops by at least 45%", () => {
    const ideas = fixture();
    const legacyBytes = 2 * enc(JSON.stringify(ideas)); // 2 × full JSON, uncapped versions
    replaceIdeas(ideas);
    const mainRaw = localStorage.getItem(MAIN_KEY) ?? "";
    const mirrorRaw = localStorage.getItem(LAST_GOOD_KEY) ?? "";
    const persisted = JSON.parse(mainRaw) as Idea[];
    // (a) the library-wide version budget holds in what was actually stored
    expect(versionBytesOf(persisted)).toBeLessThanOrEqual(800_000);
    // (b) main + mirror is at least 45% smaller than the legacy scheme
    const newBytes = enc(mainRaw) + enc(mirrorRaw);
    expect(newBytes).toBeLessThanOrEqual(Math.floor(legacyBytes * 0.55));
    // (c) every article's newest version survived the pruning
    for (const [i, p] of persisted.entries()) {
      expect(p.versions?.some((e) => e.at === 5_000 + i * 100 + 5)).toBe(true);
    }
  });

  it("mirror-restore returns every article with its current text, versions absent", () => {
    const ideas = fixture();
    replaceIdeas(ideas);
    localStorage.setItem(MAIN_KEY, "{corrupt");
    const restored = loadIdeas();
    expect(restored).toHaveLength(30);
    for (const [i, r] of restored.entries()) {
      expect(r.articleBody).toBe(ideas[i]?.articleBody);
      expect(r.versions).toBeUndefined();
    }
  });

  it("a legacy full mirror still restores WITH its versions", () => {
    const legacy = fixture().slice(0, 2);
    localStorage.setItem(LAST_GOOD_KEY, JSON.stringify(legacy));
    localStorage.setItem(MAIN_KEY, "{corrupt");
    const restored = loadIdeas();
    expect(restored).toEqual(legacy);
    expect(restored[0]?.versions).toHaveLength(5);
  });
});
