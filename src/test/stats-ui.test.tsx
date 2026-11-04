import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Idea } from "@/lib/ideas";

// Keep the settings dialog away from the cloud/drive plumbing (same
// stubs as theme-ui.test.tsx).
vi.mock("@/lib/sync", () => ({ syncNow: vi.fn(async () => {}) }));
vi.mock("@/lib/drive-sync", () => ({
  lastDriveSync: () => 0,
  syncDrive: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("@/lib/my-voice", async (orig) => ({
  ...(await orig<typeof import("@/lib/my-voice")>()),
  isMyVoicePublic: () => false,
}));

import { SettingsDialog } from "@/components/settings-dialog";

const daysAgoAtNoon = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(12, 0, 0, 0); return d.getTime(); };

let seq = 0;
const mk = (over: Partial<Idea> = {}): Idea => {
  seq += 1;
  return { id: `idea-${seq}`, text: `نص ${seq}`, createdAt: daysAgoAtNoon(0), ...over };
};

const seed = (ideas: Idea[], pending: string[] = []) => {
  localStorage.setItem("afkari.ideas", JSON.stringify(ideas));
  if (pending.length) {
    localStorage.setItem("afkari.pendingDeletes", JSON.stringify(pending.map((id) => ({ id, deadline: Date.now() + 60_000 }))));
  }
};

const statsText = () => screen.getByRole("heading", { name: "إحصائياتي" }).closest("section")?.textContent ?? "";

beforeEach(() => { seq = 0; localStorage.clear(); });

describe("«إحصائياتي» in Settings", () => {
  it("renders the section right after «المظهر»", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    const appearance = screen.getByRole("heading", { name: "المظهر" });
    const stats = screen.getByRole("heading", { name: "إحصائياتي" });
    expect(appearance.compareDocumentPosition(stats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows this month, the totals and the top topics in Arabic-Indic digits", () => {
    seed([
      mk({ articleBody: "واحد اثنان", topic: "جراحة", topicManual: true }), // today, 2 words
      mk({ articleBody: "واحد اثنان ثلاثة", topic: "جراحة", topicManual: true }), // today, 3 words
      mk({ song: true, text: "غنا", createdAt: daysAgoAtNoon(40) }),
      mk({ liked: true, createdAt: daysAgoAtNoon(40) }),
      mk({ medical: true, createdAt: daysAgoAtNoon(40) }),
    ]);
    render(<SettingsDialog open onOpenChange={() => {}} />);
    const text = statsText();
    expect(text).toContain("هذا الشهر: ٢ مقالة · ٥ كلمة");
    expect(text).toContain("مقالات٣"); // the two above + the older medical article
    expect(text).toContain("أغاني١");
    expect(text).toContain("مقالات أعجبتني١");
    expect(text).toContain("القسم الطبي١");
    expect(text).toContain("أكثر المواضيع");
    expect(text).toContain("جراحة٢");
  });

  it("shows the writing streak across today and yesterday", () => {
    seed([mk(), mk({ createdAt: daysAgoAtNoon(1) })]);
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(statsText()).toContain("سلسلة الكتابة: الحالي ٢ يوم · الأطول ٢ يوم");
  });

  it("an idea inside its undo window is not counted", () => {
    const kept = mk({ articleBody: "واحد" });
    const pending = mk({ articleBody: "واحد اثنان ثلاثة أربعة" });
    seed([kept, pending], [pending.id]);
    render(<SettingsDialog open onOpenChange={() => {}} />);
    expect(statsText()).toContain("هذا الشهر: ١ مقالة · ١ كلمة");
  });

  it("an empty library renders graceful zeros", () => {
    render(<SettingsDialog open onOpenChange={() => {}} />);
    const text = statsText();
    expect(text).toContain("هذا الشهر: ٠ مقالة · ٠ كلمة");
    expect(text).toContain("سلسلة الكتابة: الحالي ٠ يوم · الأطول ٠ يوم");
    expect(text).not.toContain("أكثر المواضيع");
  });
});
