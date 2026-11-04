import { useEffect, useState } from "react";

/**
 * Appearance (المظهر): a DEVICE-LOCAL display preference — light, dark,
 * or follow-the-device. Like reading comfort it is NOT article data:
 * nothing here syncs, backs up or migrates; it lives only in this
 * browser's localStorage, under its own key.
 *
 * The styling system (src/styles.css) is token-based with a complete
 * `.dark` variable set and a class dark variant, so applying a theme is
 * exactly one thing: toggling the `dark` class on <html>. The app's
 * warm light palette is scoped to `:root:not(.dark)` so it can never
 * override the dark tokens.
 */
export const THEME_KEY = "afkari.theme";

export type ThemeMode = "light" | "dark" | "system";

/** The untouched default follows the device, as the app effectively did
 *  before this preference existed on devices set to light. */
export const DEFAULT_THEME_MODE: ThemeMode = "system";

export const THEME_MODES: readonly { mode: ThemeMode; label: string }[] = [
  { mode: "light", label: "فاتح" },
  { mode: "dark", label: "ليلي" },
  { mode: "system", label: "حسب الجهاز" },
];

const isThemeMode = (v: unknown): v is ThemeMode => v === "light" || v === "dark" || v === "system";

/** Load the stored preference. Anything missing or malformed falls back
 *  to the default — the stored value is one JSON string, validated whole. */
export function loadThemeMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (!raw) return DEFAULT_THEME_MODE;
    const parsed: unknown = JSON.parse(raw);
    return isThemeMode(parsed) ? parsed : DEFAULT_THEME_MODE;
  } catch {
    return DEFAULT_THEME_MODE;
  }
}

export function saveThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(mode));
  } catch {
    // Private mode / quota: the in-memory state still applies this session.
  }
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function systemPrefersDark(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(DARK_QUERY).matches
      : false;
  } catch {
    return false;
  }
}

/** Pure mode → darkness resolution; the one place the rule lives. */
export function resolveThemeDark(mode: ThemeMode, systemDark: boolean): boolean {
  return mode === "dark" || (mode === "system" && systemDark);
}

/** Apply a mode to the document now: `dark` class on <html> iff dark. */
export function applyThemeMode(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveThemeDark(mode, systemPrefersDark()));
}

const CHANGE_EVENT = "afkari:theme-changed";

/**
 * App-shell wiring (called once from the root component): apply the
 * stored mode immediately, re-apply when the preference changes anywhere
 * in the tab, and follow live device changes while in system mode.
 * Returns the teardown.
 */
export function initTheme(): () => void {
  applyThemeMode(loadThemeMode());
  const onChange = () => applyThemeMode(loadThemeMode());
  window.addEventListener(CHANGE_EVENT, onChange);
  let media: MediaQueryList | null = null;
  const onMedia = () => {
    if (loadThemeMode() === "system") applyThemeMode("system");
  };
  try {
    if (typeof window.matchMedia === "function") {
      media = window.matchMedia(DARK_QUERY);
      media.addEventListener?.("change", onMedia);
    }
  } catch {
    media = null;
  }
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    media?.removeEventListener?.("change", onMedia);
  };
}

/** React binding for the stored preference, mirroring useReadingPrefs:
 *  every holder keeps its own state, synced through a window event (a
 *  same-tab localStorage write fires no `storage` event of its own). */
export function useTheme(): { mode: ThemeMode; setMode: (next: ThemeMode) => void } {
  const [mode, setModeState] = useState<ThemeMode>(loadThemeMode);
  useEffect(() => {
    const onChange = () => setModeState(loadThemeMode());
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);
  const setMode = (next: ThemeMode) => {
    setModeState(next);
    saveThemeMode(next);
    applyThemeMode(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  return { mode, setMode };
}
