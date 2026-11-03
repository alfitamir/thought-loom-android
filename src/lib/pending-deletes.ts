// Undoable deletion: a delete the user confirms does NOT remove anything yet.
// The idea is marked pending — a small persisted list of { id, deadline },
// the same localStorage pending-list pattern as the Drive deletion marks in
// ideas.ts and the song-Drive tombstones in song-drive.ts — and every surface
// reads ideas through `loadVisibleIdeas`, so the item vanishes instantly
// (library, search, ask/insights corpora, merge candidates, style samples)
// while its record, its song blob and its Drive copy stay exactly where they
// were. Only when the grace window expires does finalization run the real
// removal and ALL its side effects. Undo inside the window is therefore
// trivially exact: un-mark, and nothing was ever touched.
//
// Persistence is the safety net for the app closing mid-window: the list
// survives the restart, the startup sweep (`sweepPendingDeletes`, driven by
// delete-flow.ts on app mount) finalizes anything already due instead of
// resurrecting it, and an entry still inside its window simply stays hidden
// until its own deadline passes.
import { loadIdeas, type Idea } from "./ideas";

/** How long a deleted item waits before its removal becomes real. */
export const PENDING_DELETE_GRACE_MS = 8000;

export type PendingDelete = { id: string; deadline: number };

const KEY = "afkari.pendingDeletes";

export const loadPendingDeletes = (): PendingDelete[] => {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]") as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((e): e is PendingDelete =>
      !!e && typeof e === "object" && typeof (e as PendingDelete).id === "string" && typeof (e as PendingDelete).deadline === "number");
  } catch { return []; }
};
const writePendingDeletes = (list: PendingDelete[]) =>
  localStorage.setItem(KEY, JSON.stringify(list));

export const pendingDeleteIds = (): Set<string> => new Set(loadPendingDeletes().map((e) => e.id));
export const isPendingDelete = (id: string): boolean => loadPendingDeletes().some((e) => e.id === id);

/** Every idea except the ones pending deletion — what all surfaces read. */
export const loadVisibleIdeas = (): Idea[] => {
  const pending = pendingDeleteIds();
  return loadIdeas().filter((i) => !pending.has(i.id));
};

/**
 * Mark an idea pending deletion with a fresh grace deadline. Idempotent:
 * an already-pending idea keeps its ORIGINAL deadline (re-deleting must
 * never extend the window or resurrect side effects).
 */
export function beginPendingDelete(id: string, now = Date.now()): PendingDelete {
  const list = loadPendingDeletes();
  const existing = list.find((e) => e.id === id);
  if (existing) return existing;
  const entry: PendingDelete = { id, deadline: now + PENDING_DELETE_GRACE_MS };
  writePendingDeletes([...list, entry]);
  return entry;
}

/** Undo: lift the pending mark. The record was never touched, so the idea
 *  comes back exactly as it was. Returns whether it had been pending. */
export function cancelPendingDelete(id: string): boolean {
  const list = loadPendingDeletes();
  if (!list.some((e) => e.id === id)) return false;
  writePendingDeletes(list.filter((e) => e.id !== id));
  return true;
}

/** The deletion side effects, injected so the state machine stays testable
 *  and free of storage/Drive imports. delete-flow.ts wires the real ones. */
export interface DeleteEffects {
  /** Remove the record itself (ideas.deleteIdea: local store + the cloud and
   *  Drive deletion marks that propagate the removal to every device). */
  removeRecord(id: string): void;
  /** Remove a song's local recording blob. */
  deleteSongAudio(id: string): void;
  /** Remove a song's Google Drive copy (tombstoned + retried on failure). */
  deleteSongDriveCopy(idea: Idea): void;
  /** Propagate the removal to the cloud backup now. */
  deleteCloud(id: string): void;
}

/**
 * Run the real deletion for one idea: the current record is read first
 * (a song's Drive id may have been stamped during the grace window, and the
 * Drive copy that must die is the one that id names), then the record
 * removal and every side effect run — the exact set the old immediate
 * delete ran, just deferred to here.
 */
export function finalizePendingDelete(id: string, effects: DeleteEffects): boolean {
  const idea = loadIdeas().find((i) => i.id === id);
  effects.removeRecord(id);
  if (idea?.song) {
    effects.deleteSongAudio(id);
    effects.deleteSongDriveCopy(idea);
  }
  effects.deleteCloud(id);
  return !!idea;
}

/**
 * Claim every entry whose deadline has passed and finalize it. Entries are
 * removed from the persisted list BEFORE their effects run, so an effect
 * that throws can never wedge the sweep into retrying forever — the record
 * removal inside finalize is idempotent and the Drive deletion carries its
 * own tombstone retry. Returns the finalized ids.
 */
export function sweepPendingDeletes(effects: DeleteEffects, now = Date.now()): string[] {
  const list = loadPendingDeletes();
  const due = list.filter((e) => e.deadline <= now);
  if (!due.length) return [];
  writePendingDeletes(list.filter((e) => e.deadline > now));
  for (const entry of due) finalizePendingDelete(entry.id, effects);
  return due.map((e) => e.id);
}
