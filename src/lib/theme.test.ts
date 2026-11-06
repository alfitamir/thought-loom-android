import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  THEME_COLOR_DARK,
  THEME_COLOR_LIGHT,
  THEME_KEY,
  applyThemeMode,
  initTheme,
  loadThemeMode,
  resolveThemeDark,
  saveThemeMode,
  themeColorFor,
} from "@/lib/theme";

// A controllable prefers-color-scheme: `systemDark` is the device state,
// fireMediaChange() delivers the change event the OS would send.
let systemDark = false;
type MediaListener = (e: { matches: boolean; media: string }) => void;
let mediaListeners: MediaListener[] = [];
const fireMediaChange = () => {
  for (const l of [...mediaListeners])
    l({ matches: systemDark, media: "(prefers-color-scheme: dark)" });
};

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.head.querySelector('meta[name="theme-color"]')?.remove();
  systemDark = false;
  mediaListeners = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === "(prefers-color-scheme: dark)" ? systemDark : false;
    },
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_: string, l: MediaListener) => mediaListeners.push(l),
    removeEventListener: (_: string, l: MediaListener) => {
      mediaListeners = mediaListeners.filter((x) => x !== l);
    },
    dispatchEvent: () => false,
  }));
});

const isDark = () => document.documentElement.classList.contains("dark");

describe("theme preference (device-local appearance)", () => {
  it("defaults to «حسب الجهاز» (system) when nothing is stored", () => {
    expect(loadThemeMode()).toBe("system");
  });

  it("round-trips a saved mode under its own key as one JSON string", () => {
    saveThemeMode("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe('"dark"');
    expect(loadThemeMode()).toBe("dark");
    saveThemeMode("light");
    expect(loadThemeMode()).toBe("light");
  });

  it("falls back to the default on corrupt or unknown values", () => {
    for (const bad of ["{not json", '"blue"', "42", "null", "{}"]) {
      localStorage.setItem(THEME_KEY, bad);
      expect(loadThemeMode(), bad).toBe("system");
    }
  });

  it("resolves the mode → darkness rule in exactly one place", () => {
    expect(resolveThemeDark("dark", false)).toBe(true);
    expect(resolveThemeDark("dark", true)).toBe(true);
    expect(resolveThemeDark("light", false)).toBe(false);
    expect(resolveThemeDark("light", true)).toBe(false);
    expect(resolveThemeDark("system", false)).toBe(false);
    expect(resolveThemeDark("system", true)).toBe(true);
  });

  it("applyThemeMode toggles the dark class on <html>", () => {
    applyThemeMode("dark");
    expect(isDark()).toBe(true);
    applyThemeMode("light");
    expect(isDark()).toBe(false);
    systemDark = true;
    applyThemeMode("system");
    expect(isDark()).toBe(true);
    applyThemeMode("dark");
    systemDark = false;
    applyThemeMode("light");
    expect(isDark()).toBe(false);
  });

  it("themeColorFor pairs the chrome color with the resolved theme", () => {
    expect(themeColorFor(true)).toBe(THEME_COLOR_DARK);
    expect(themeColorFor(false)).toBe(THEME_COLOR_LIGHT);
    // The dark chrome color is the brand navy the meta always carried.
    expect(THEME_COLOR_DARK).toBe("#1F243D");
    expect(THEME_COLOR_LIGHT).not.toBe(THEME_COLOR_DARK);
  });

  it("applyThemeMode keeps the theme-color meta in sync with the theme", () => {
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", THEME_COLOR_DARK);
    document.head.appendChild(meta);
    applyThemeMode("light");
    expect(meta.getAttribute("content")).toBe(THEME_COLOR_LIGHT);
    applyThemeMode("dark");
    expect(meta.getAttribute("content")).toBe(THEME_COLOR_DARK);
    systemDark = true;
    applyThemeMode("system");
    expect(meta.getAttribute("content")).toBe(THEME_COLOR_DARK);
    // A missing meta is not an error — nothing to sync.
    meta.remove();
    applyThemeMode("light");
    expect(document.head.querySelector('meta[name="theme-color"]')).toBeNull();
  });

  it("initTheme applies the stored mode immediately", () => {
    saveThemeMode("dark");
    const stop = initTheme();
    expect(isDark()).toBe(true);
    stop();
  });

  it("in system mode, initTheme follows live device changes", () => {
    saveThemeMode("system");
    const stop = initTheme();
    expect(isDark()).toBe(false);
    systemDark = true;
    fireMediaChange();
    expect(isDark()).toBe(true);
    systemDark = false;
    fireMediaChange();
    expect(isDark()).toBe(false);
    stop();
    // After teardown the shell no longer reacts.
    systemDark = true;
    fireMediaChange();
    expect(isDark()).toBe(false);
  });

  it("a manual mode ignores device changes entirely", () => {
    saveThemeMode("dark");
    const stop = initTheme();
    expect(isDark()).toBe(true);
    systemDark = true;
    fireMediaChange();
    systemDark = false;
    fireMediaChange();
    expect(isDark()).toBe(true);
    stop();
  });

  it("a preference saved elsewhere in the tab re-applies through initTheme", () => {
    const stop = initTheme();
    expect(isDark()).toBe(false);
    saveThemeMode("dark");
    window.dispatchEvent(new Event("afkari:theme-changed"));
    expect(isDark()).toBe(true);
    stop();
  });
});
