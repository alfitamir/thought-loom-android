import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_READING_PREFS,
  READING_PREFS_KEY,
  loadReadingPrefs,
  readingStyleVars,
  saveReadingPrefs,
} from "@/lib/reading-prefs";

beforeEach(() => localStorage.clear());

describe("reading prefs (device-local display preference)", () => {
  it("defaults to step 0 for both axes when nothing is stored", () => {
    expect(loadReadingPrefs()).toEqual({ fontSize: 0, lineHeight: 0 });
    expect(loadReadingPrefs()).toEqual(DEFAULT_READING_PREFS);
  });

  it("round-trips a saved choice under its own key", () => {
    saveReadingPrefs({ fontSize: 2, lineHeight: 1 });
    expect(localStorage.getItem(READING_PREFS_KEY)).toBe('{"fontSize":2,"lineHeight":1}');
    expect(loadReadingPrefs()).toEqual({ fontSize: 2, lineHeight: 1 });
    saveReadingPrefs({ fontSize: 1, lineHeight: 0 });
    expect(loadReadingPrefs()).toEqual({ fontSize: 1, lineHeight: 0 });
  });

  it("falls back to the defaults wholesale on corrupt or out-of-range values", () => {
    for (const bad of [
      "{not json",
      '"just a string"',
      "42",
      "null",
      '{"fontSize":3,"lineHeight":0}',
      '{"fontSize":0,"lineHeight":2}',
      '{"fontSize":-1,"lineHeight":0}',
      '{"fontSize":1.5,"lineHeight":0}',
      '{"fontSize":1}',
      '{"lineHeight":1}',
      "{}",
    ]) {
      localStorage.setItem(READING_PREFS_KEY, bad);
      expect(loadReadingPrefs(), bad).toEqual(DEFAULT_READING_PREFS);
    }
  });

  it("step 0 renders exactly as the app always did (text-xl / leading-loose)", () => {
    const vars = readingStyleVars(DEFAULT_READING_PREFS) as unknown as Record<string, string>;
    expect(vars["--reading-font-size"]).toBe("1.25rem"); // text-xl
    expect(vars["--reading-line-height"]).toBe("2"); // leading-loose
  });

  it("maps every step to its size/spacing values", () => {
    const at = (fontSize: 0 | 1 | 2, lineHeight: 0 | 1) =>
      readingStyleVars({ fontSize, lineHeight }) as unknown as Record<string, string>;
    expect(at(1, 0)["--reading-font-size"]).toBe("1.5rem");
    expect(at(2, 0)["--reading-font-size"]).toBe("1.75rem");
    expect(at(0, 1)["--reading-line-height"]).toBe("2.4");
    expect(at(2, 1)).toEqual({ "--reading-font-size": "1.75rem", "--reading-line-height": "2.4" });
  });
});
