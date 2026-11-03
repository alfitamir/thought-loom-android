import { describe, it, expect, beforeEach, vi } from "vitest";
import { deleteIdea, loadIdeas, replaceIdeas, saveIdea, type Idea } from "./ideas";
import {
  PENDING_DELETE_GRACE_MS, beginPendingDelete, cancelPendingDelete, finalizePendingDelete,
  isPendingDelete, loadPendingDeletes, loadVisibleIdeas, pendingDeleteIds, sweepPendingDeletes,
  type DeleteEffects,
} from "./pending-deletes";

/** Spy effects whose record removal is the REAL one, so storage assertions
 *  mean something; the audio/Drive/cloud side effects are observed, not run. */
const makeEffects = (): DeleteEffects => ({
  removeRecord: vi.fn((id: string) => deleteIdea(id)),
  deleteSongAudio: vi.fn(),
  deleteSongDriveCopy: vi.fn(),
  deleteCloud: vi.fn(),
});

const seedSong = (extra: Partial<Idea> = {}): Idea => {
  const song: Idea = { id: "song-1", text: "كلمات الأغنية", createdAt: 10, song: true, articleTitle: "أغنيتي", driveFileId: "drive-file-1", ...extra };
  replaceIdeas([song, ...loadIdeas()]);
  return song;
};

describe("pending deletes", () => {
  beforeEach(() => localStorage.clear());

  it("marks an idea pending with a grace deadline and persists the mark", () => {
    const idea = saveIdea("فكرة");
    const entry = beginPendingDelete(idea.id, 1000);
    expect(entry).toEqual({ id: idea.id, deadline: 1000 + PENDING_DELETE_GRACE_MS });
    // A fresh read (what a restarted app sees) carries the same pending mark.
    expect(loadPendingDeletes()).toEqual([entry]);
    expect(isPendingDelete(idea.id)).toBe(true);
    expect(pendingDeleteIds()).toEqual(new Set([idea.id]));
  });

  it("re-deleting an already-pending idea keeps the original deadline", () => {
    const idea = saveIdea("فكرة");
    beginPendingDelete(idea.id, 1000);
    const again = beginPendingDelete(idea.id, 5000);
    expect(again.deadline).toBe(1000 + PENDING_DELETE_GRACE_MS);
    expect(loadPendingDeletes()).toHaveLength(1);
  });

  it("hides a pending idea from visible ideas while its record stays untouched", () => {
    const gone = saveIdea("ستختفي مؤقتًا");
    const kept = saveIdea("باقية");
    beginPendingDelete(gone.id, 0);
    expect(loadVisibleIdeas().map((i) => i.id)).toEqual([kept.id]);
    // The record itself is still in storage, byte for byte — undo can be exact.
    expect(loadIdeas().find((i) => i.id === gone.id)).toEqual(gone);
  });

  it("undo inside the window restores the idea exactly and nothing is ever removed", () => {
    const song = seedSong();
    beginPendingDelete(song.id, 0);
    expect(cancelPendingDelete(song.id)).toBe(true);
    expect(cancelPendingDelete(song.id)).toBe(false);
    const effects = makeEffects();
    // Even a sweep long after the would-be deadline finds nothing to do.
    expect(sweepPendingDeletes(effects, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(effects.removeRecord).not.toHaveBeenCalled();
    expect(effects.deleteSongAudio).not.toHaveBeenCalled();
    expect(effects.deleteSongDriveCopy).not.toHaveBeenCalled();
    expect(effects.deleteCloud).not.toHaveBeenCalled();
    expect(loadVisibleIdeas().map((i) => i.id)).toContain(song.id);
  });

  it("a sweep before the deadline finalizes nothing and keeps the entry", () => {
    const idea = saveIdea("فكرة");
    beginPendingDelete(idea.id, 1000);
    const effects = makeEffects();
    expect(sweepPendingDeletes(effects, 1000 + PENDING_DELETE_GRACE_MS - 1)).toEqual([]);
    expect(effects.removeRecord).not.toHaveBeenCalled();
    expect(isPendingDelete(idea.id)).toBe(true);
    expect(loadIdeas().map((i) => i.id)).toContain(idea.id);
  });

  it("expiry finalizes a plain article: record removed, cloud told, no song side effects", () => {
    const idea = saveIdea("فكرة");
    beginPendingDelete(idea.id, 0);
    const effects = makeEffects();
    expect(sweepPendingDeletes(effects, PENDING_DELETE_GRACE_MS)).toEqual([idea.id]);
    expect(effects.removeRecord).toHaveBeenCalledWith(idea.id);
    expect(effects.deleteCloud).toHaveBeenCalledWith(idea.id);
    expect(effects.deleteSongAudio).not.toHaveBeenCalled();
    expect(effects.deleteSongDriveCopy).not.toHaveBeenCalled();
    expect(loadIdeas()).toEqual([]);
    expect(loadPendingDeletes()).toEqual([]);
  });

  it("expiry finalizes a song with its blob and Drive side effects, using the current record", () => {
    const song = seedSong();
    beginPendingDelete(song.id, 0);
    // The Drive upload pass stamps a NEWER file id during the grace window;
    // finalization must kill the copy that id names, not a stale snapshot.
    replaceIdeas(loadIdeas().map((i) => (i.id === song.id ? { ...i, driveFileId: "drive-file-2" } : i)));
    const effects = makeEffects();
    expect(sweepPendingDeletes(effects, PENDING_DELETE_GRACE_MS)).toEqual([song.id]);
    expect(effects.deleteSongAudio).toHaveBeenCalledWith(song.id);
    expect(effects.deleteSongDriveCopy).toHaveBeenCalledWith(expect.objectContaining({ id: song.id, driveFileId: "drive-file-2" }));
    expect(effects.deleteCloud).toHaveBeenCalledWith(song.id);
    expect(loadIdeas()).toEqual([]);
  });

  it("the startup sweep finalizes a deletion whose window closed while the app was away", () => {
    const idea = saveIdea("فكرة");
    // What a previous session persisted before closing mid-window.
    localStorage.setItem("afkari.pendingDeletes", JSON.stringify([{ id: idea.id, deadline: 500 }]));
    const effects = makeEffects();
    expect(sweepPendingDeletes(effects, 10_000)).toEqual([idea.id]);
    expect(effects.removeRecord).toHaveBeenCalledWith(idea.id);
    expect(loadIdeas()).toEqual([]);
  });

  it("several pending deletions finalize independently as each deadline passes", () => {
    const a = saveIdea("أ");
    const b = saveIdea("ب");
    beginPendingDelete(a.id, 0);
    beginPendingDelete(b.id, 60_000);
    const effects = makeEffects();
    expect(sweepPendingDeletes(effects, PENDING_DELETE_GRACE_MS)).toEqual([a.id]);
    // b is still inside its window: hidden everywhere, record intact.
    expect(isPendingDelete(b.id)).toBe(true);
    expect(loadVisibleIdeas()).toEqual([]);
    expect(loadIdeas().map((i) => i.id)).toEqual([b.id]);
    expect(sweepPendingDeletes(effects, 60_000 + PENDING_DELETE_GRACE_MS)).toEqual([b.id]);
    expect(loadIdeas()).toEqual([]);
  });

  it("finalize runs the record removal even if the record is already gone", () => {
    const effects = makeEffects();
    expect(finalizePendingDelete("ghost", effects)).toBe(false);
    expect(effects.removeRecord).toHaveBeenCalledWith("ghost");
    expect(effects.deleteCloud).toHaveBeenCalledWith("ghost");
    expect(effects.deleteSongAudio).not.toHaveBeenCalled();
  });
});
