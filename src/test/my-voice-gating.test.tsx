import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SettingsDialog } from "@/components/settings-dialog";

// The gate is a module-level const; mock just the gate function so the
// test can exercise both states, everything else in the module stays real.
const gate = vi.hoisted(() => ({ public: false }));
vi.mock("@/lib/my-voice", async (orig) => ({
  ...(await orig<typeof import("@/lib/my-voice")>()),
  isMyVoicePublic: () => gate.public,
}));
// Keep the dialog render away from the cloud/drive plumbing.
vi.mock("@/lib/sync", () => ({
  syncNow: vi.fn(async () => ({ ok: true as const, restored: 0 })),
  lastCloudSync: () => 0,
  lastCloudSyncError: () => "",
}));
vi.mock("@/lib/drive-sync", () => ({
  lastDriveSync: () => 0,
  syncDrive: vi.fn(async () => ({ ok: true as const })),
}));

describe("Settings «صوتي» section gating (MY_VOICE_PUBLIC)", () => {
  it("does not render the my-voice section while the feature is hidden", () => {
    gate.public = false;
    render(<SettingsDialog open onOpenChange={() => {}} />);
    // The rest of Settings is unaffected…
    expect(screen.getByRole("heading", { name: "مفتاح Gemini الخاص بك" })).toBeTruthy();
    // …but no «صوتي» section, heading or entry point anywhere.
    expect(screen.queryByRole("heading", { name: "صوتي" })).toBeNull();
    expect(screen.queryByText("إنشاء صوتي")).toBeNull();
  });

  it("renders the my-voice section when the feature is public", () => {
    gate.public = true;
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(screen.getByRole("heading", { name: "صوتي" })).toBeTruthy();
  });
});
