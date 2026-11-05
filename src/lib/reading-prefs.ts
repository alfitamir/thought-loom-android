import { useEffect, useState, type CSSProperties } from "react";

/**
 * Reading comfort (راحة القراءة): a DEVICE-LOCAL display preference —
 * text size and line spacing for the long-form reading surfaces in the
 * article editor. It is NOT article data: nothing here syncs, backs up
 * or migrates; it lives only in this browser's localStorage, under its
 * own key, and the listen/TTS pipeline never sees it (it reads text).
 */
export const READING_PREFS_KEY = "afkari.readingPrefs";

export type FontSizeStep = 0 | 1 | 2;
export type LineHeightStep = 0 | 1;
export type BgTintStep = 0 | 1;

export interface ReadingPrefs {
  fontSize: FontSizeStep;
  lineHeight: LineHeightStep;
  /** Warm paper tint behind the reading surfaces (step 0 = none). */
  bgTint: BgTintStep;
}

/** Step 0 IS the app's long-standing rendering, so the untouched default
 *  can never look different from before this feature existed. */
export const DEFAULT_READING_PREFS: ReadingPrefs = { fontSize: 0, lineHeight: 0, bgTint: 0 };

export const FONT_SIZE_STEPS: readonly { step: FontSizeStep; label: string }[] = [
  { step: 0, label: "عادي" },
  { step: 1, label: "كبير" },
  { step: 2, label: "أكبر" },
];

export const LINE_HEIGHT_STEPS: readonly { step: LineHeightStep; label: string }[] = [
  { step: 0, label: "مريحة" },
  { step: 1, label: "واسعة" },
];

export const BG_TINT_STEPS: readonly { step: BgTintStep; label: string }[] = [
  { step: 0, label: "خلفية عادية" },
  { step: 1, label: "خلفية دافئة" },
];

// Step 0 reproduces the classes the reading surfaces always carried:
// text-xl = font-size 1.25rem, leading-loose = line-height 2.
const FONT_SIZE_VALUES = ["1.25rem", "1.5rem", "1.75rem"] as const;
const LINE_HEIGHT_VALUES = ["2", "2.4"] as const;
// Step 0 = transparent (today's look: the page shows through). Step 1
// defers to --reading-bg-warm in styles.css, which carries a light warm
// paper value and a warm-dark value under .dark — one var, both themes.
const BG_TINT_VALUES = ["transparent", "var(--reading-bg-warm)"] as const;

const isFontSizeStep = (v: unknown): v is FontSizeStep => v === 0 || v === 1 || v === 2;
const isLineHeightStep = (v: unknown): v is LineHeightStep => v === 0 || v === 1;
const isBgTintStep = (v: unknown): v is BgTintStep => v === 0 || v === 1;

/** Load the stored preference. Anything missing, malformed or out of
 *  range falls back to the defaults WHOLESALE — never a half-valid mix.
 *  One exception: a value stored before the tint existed has no bgTint
 *  field at all; absent means step 0, not corruption. */
export function loadReadingPrefs(): ReadingPrefs {
  try {
    const raw = localStorage.getItem(READING_PREFS_KEY);
    if (!raw) return { ...DEFAULT_READING_PREFS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_READING_PREFS };
    const { fontSize, lineHeight, bgTint } = parsed as {
      fontSize?: unknown;
      lineHeight?: unknown;
      bgTint?: unknown;
    };
    if (!isFontSizeStep(fontSize) || !isLineHeightStep(lineHeight))
      return { ...DEFAULT_READING_PREFS };
    if (bgTint !== undefined && !isBgTintStep(bgTint)) return { ...DEFAULT_READING_PREFS };
    return { fontSize, lineHeight, bgTint: bgTint ?? 0 };
  } catch {
    return { ...DEFAULT_READING_PREFS };
  }
}

export function saveReadingPrefs(prefs: ReadingPrefs): void {
  try {
    localStorage.setItem(READING_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode / quota: the in-memory state still applies this session.
  }
}

/** The CSS variables the editor's root carries; the reading surfaces
 *  (article body, edit box, song lyrics and their edit box) consume them
 *  through Tailwind arbitrary values whose fallbacks are today's exact
 *  rendering, so an unset variable can never change the look. */
export function readingStyleVars(prefs: ReadingPrefs): CSSProperties {
  return {
    "--reading-font-size": FONT_SIZE_VALUES[prefs.fontSize],
    "--reading-line-height": LINE_HEIGHT_VALUES[prefs.lineHeight],
    "--reading-bg": BG_TINT_VALUES[prefs.bgTint],
  } as CSSProperties;
}

const CHANGE_EVENT = "afkari:reading-prefs-changed";

/** React binding for the stored preference. Every editor on screen holds
 *  its own state, so a change notifies the others through a window event
 *  (a same-tab localStorage write fires no `storage` event of its own). */
export function useReadingPrefs(): { prefs: ReadingPrefs; setPrefs: (next: ReadingPrefs) => void } {
  const [prefs, setPrefsState] = useState<ReadingPrefs>(loadReadingPrefs);
  useEffect(() => {
    const onChange = () => setPrefsState(loadReadingPrefs());
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  const setPrefs = (next: ReadingPrefs) => {
    setPrefsState(next);
    saveReadingPrefs(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  return { prefs, setPrefs };
}
