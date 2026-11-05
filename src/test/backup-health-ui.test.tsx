import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Idea } from "@/lib/ideas";

// Keep the settings dialog away from the real cloud plumbing; the two
// sync getters read the same localStorage keys the real ones record to,
// so seeded records behave exactly like production ones.
vi.mock("@/lib/sync", () => ({
  syncNow: vi.fn(async () => ({ ok: true as const, restored: 0 })),
  lastCloudSync: () => Number(localStorage.getItem("afkari.lastCloudSync")) || 0,
  lastCloudSyncError: () => localStorage.getItem("afkari.lastCloudSyncError") ?? "",
}));
vi.mock("@/lib/drive-sync", () => ({
  lastDriveSync: () => Number(localStorage.getItem("afkari.driveSyncedAt")) || 0,
  syncDrive: vi.fn(async () => ({ ok: true as const, restored: 0 })),
}));
vi.mock("@/lib/my-voice", async (orig) => ({
  ...(await orig<typeof import("@/lib/my-voice")>()),
  isMyVoicePublic: () => false,
}));

import { SettingsDialog } from "@/components/settings-dialog";

const sectionText = (heading: string) =>
  screen.getByRole("heading", { name: heading }).closest("section")?.textContent ?? "";

const seedIdeas = (ideas: Idea[]) => localStorage.setItem("afkari.ideas", JSON.stringify(ideas));
const song = (patch: Partial<Idea> = {}): Idea => ({ id: "s", text: "كلمات", createdAt: 1, song: true, ...patch });

beforeEach(() => { localStorage.clear(); });

describe("«حالة النسخ الاحتياطي» in Settings (F-8.6)", () => {
  it("on a fresh device every gauge states its never-yet plainly", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    const text = sectionText("حالة النسخ الاحتياطي");
    expect(text).toContain("لم تتم مزامنة ناجحة بعد");
    expect(text).toContain("لم تتم المزامنة بعد على هذا الهاتف");
    expect(text).toContain("لا توجد عناصر معلّقة بانتظار الترحيل");
    expect(text).toContain("حجم مكتبتك على هذا الهاتف");
    expect(text).not.toContain("آخر محاولة سحابية لم تنجح");
  });

  it("shows the recorded cloud success and the last failure side by side", () => {
    localStorage.setItem("afkari.lastCloudSync", String(Date.now()));
    localStorage.setItem("afkari.lastCloudSyncError", "تعذّرت المزامنة السحابية الآن.");
    render(<SettingsDialog open onOpenChange={() => {}} />);
    const text = sectionText("حالة النسخ الاحتياطي");
    expect(text).toContain("آخر مزامنة ناجحة");
    expect(text).toContain("آخر محاولة سحابية لم تنجح");
    expect(text).toContain("تعذّرت المزامنة السحابية الآن.");
  });

  it("counts deletions still waiting to be carried to a backup", () => {
    localStorage.setItem("afkari.deleted", JSON.stringify(["x"]));
    localStorage.setItem("afkari.driveDeleted", JSON.stringify(["y", "z"]));
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(sectionText("حالة النسخ الاحتياطي")).toContain("عناصر حذف بانتظار الترحيل: ٣");
  });
});

describe("the Drive song line states the songs' real backup state (audit §4)", () => {
  it("no songs yet — says so instead of claiming a state", () => {
    localStorage.setItem("afkari.driveSyncedAt", String(Date.now()));
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(sectionText("Google Drive")).toContain("لا توجد أغانٍ مسجّلة على هذا الهاتف بعد");
  });

  it("a Drive sync timestamp alone never claims songs are backed up", () => {
    seedIdeas([song({ id: "s1" }), song({ id: "s2", driveFileId: "file-2" })]);
    localStorage.setItem("afkari.driveSyncedAt", String(Date.now()));
    render(<SettingsDialog open onOpenChange={() => {}} />);
    const text = sectionText("Google Drive");
    expect(text).toContain("١ من ٢ أغنية محفوظة");
    expect(text).not.toContain("مفعّل — كل الأغاني");
  });

  it("all songs stamped — the enabled claim is earned", () => {
    seedIdeas([song({ id: "s1", driveFileId: "f1" }), song({ id: "s2", driveFileId: "f2" })]);
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(sectionText("Google Drive")).toContain("مفعّل — كل الأغاني (٢) محفوظة");
  });
});
