import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_KEY, useTheme } from "@/lib/theme";

// Keep the settings dialog away from the cloud/drive plumbing (same
// stubs as my-voice-gating.test.tsx).
vi.mock("@/lib/sync", () => ({ syncNow: vi.fn(async () => ({ ok: true as const, restored: 0 })), lastCloudSync: () => 0, lastCloudSyncError: () => "" }));
vi.mock("@/lib/drive-sync", () => ({
  lastDriveSync: () => 0,
  syncDrive: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("@/lib/my-voice", async (orig) => ({
  ...(await orig<typeof import("@/lib/my-voice")>()),
  isMyVoicePublic: () => false,
}));

import { SettingsDialog } from "@/components/settings-dialog";

function ThemeProbe({ id }: { id: string }) {
  const { mode, setMode } = useTheme();
  return (
    <div>
      <span data-testid={`mode-${id}`}>{mode}</span>
      <button onClick={() => setMode("dark")}>وضع {id} ليلي</button>
    </div>
  );
}

const isDark = () => document.documentElement.classList.contains("dark");

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  vi.clearAllMocks();
});

describe("appearance (المظهر)", () => {
  it("useTheme holders stay in sync through the window event", () => {
    render(<><ThemeProbe id="a" /><ThemeProbe id="b" /></>);
    expect(screen.getByTestId("mode-a").textContent).toBe("system");
    expect(screen.getByTestId("mode-b").textContent).toBe("system");
    fireEvent.click(screen.getByRole("button", { name: "وضع a ليلي" }));
    expect(screen.getByTestId("mode-a").textContent).toBe("dark");
    expect(screen.getByTestId("mode-b").textContent).toBe("dark");
    expect(isDark()).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe('"dark"');
  });

  it("the Settings «المظهر» section renders the three modes with the stored one active", () => {
    localStorage.setItem(THEME_KEY, '"dark"');
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.getByRole("heading", { name: "المظهر" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /ليلي/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /فاتح/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: /حسب الجهاز/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("choosing a mode in Settings applies immediately and persists", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(isDark()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /ليلي/ }));
    expect(isDark()).toBe(true);
    expect(localStorage.getItem(THEME_KEY)).toBe('"dark"');
    expect(screen.getByRole("button", { name: /ليلي/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /فاتح/ }));
    expect(isDark()).toBe(false);
    expect(localStorage.getItem(THEME_KEY)).toBe('"light"');
    fireEvent.click(screen.getByRole("button", { name: /حسب الجهاز/ }));
    expect(localStorage.getItem(THEME_KEY)).toBe('"system"');
    // setup.ts matchMedia reports a light device, so system = light here.
    expect(isDark()).toBe(false);
  });
});
