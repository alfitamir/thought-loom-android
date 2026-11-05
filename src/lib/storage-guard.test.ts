import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAST_GOOD_KEY, QUARANTINE_KEY, StorageWriteError, lastStorageWriteError, loadIdeas, onStorageWriteError, replaceIdeas, saveIdea, type Idea,
} from "./ideas";

// Audit F-3.3: the library lives in ONE localStorage value with a ~5 MB
// quota shared with everything else. These tests pin the safety net:
// a last-good mirror, typed write errors instead of silent loss, and a
// corruption fallback that never reads a damaged library as "empty".
const MAIN_KEY = "afkari.ideas";
const idea = (patch: Partial<Idea> = {}): Idea => ({ id: "a", text: "نص محفوظ", createdAt: 1, ...patch });

const quotaError = () => new DOMException("The quota has been exceeded.", "QuotaExceededError");

/** Make Storage.setItem throw for the keys `failFor` approves; everything else writes through. */
const stubSetItem = (failFor: (key: string) => Error | null) => {
  const original = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
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
afterEach(() => { vi.restoreAllMocks(); });

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
    const quarantined = JSON.parse(localStorage.getItem(QUARANTINE_KEY) ?? "[]") as Array<{ key: string; raw: string }>;
    expect(quarantined.map((q) => q.raw)).toContain("{bad main");
    expect(quarantined.map((q) => q.raw)).toContain("{bad mirror");
    // The store still works afterwards — the next write starts clean.
    replaceIdeas([idea()]);
    expect(loadIdeas()).toEqual([idea()]);
  });
});
