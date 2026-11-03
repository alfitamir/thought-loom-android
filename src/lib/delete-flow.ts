// The live wiring for undoable deletion (pending-deletes.ts holds the pure
// state machine): the real side effects, the user's two gestures — delete
// (requestDelete) and «تراجع» (undoDelete) — and the timers that finalize a
// deletion when its grace window closes, including the startup sweep that
// settles deletions left pending by an app close.
import { deleteIdea } from "./ideas";
import { deleteSongAudio } from "./article-audio";
import { deleteSongDriveCopy } from "./song-drive";
import { deleteIdeaCloud } from "./sync";
import {
  beginPendingDelete, cancelPendingDelete, loadPendingDeletes, sweepPendingDeletes,
  type DeleteEffects, type PendingDelete,
} from "./pending-deletes";

/** The side effects the old immediate delete ran — unchanged, just deferred
 *  to finalization. Every one is fire-and-forget with its own retry story
 *  (cloud deletions ride the tombstone lists; a failed Drive-file delete is
 *  tombstoned by song-drive and retried by the next upload pass). */
export const realDeleteEffects: DeleteEffects = {
  removeRecord: (id) => deleteIdea(id),
  deleteSongAudio: (id) => { void deleteSongAudio(id).catch(() => {}); },
  deleteSongDriveCopy: (idea) => { void deleteSongDriveCopy(idea).catch(() => {}); },
  deleteCloud: (id) => { void deleteIdeaCloud(id).catch(() => {}); },
};

const notify = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event("afkari:ideas-changed")); };

let timer: ReturnType<typeof setTimeout> | null = null;

/** (Re)arm the single finalization timer at the earliest pending deadline. */
function armTimer() {
  if (timer) { clearTimeout(timer); timer = null; }
  const list = loadPendingDeletes();
  if (!list.length) return;
  const next = Math.min(...list.map((e) => e.deadline));
  timer = setTimeout(() => {
    timer = null;
    sweepPendingDeletes(realDeleteEffects);
    armTimer();
    notify();
  }, Math.max(0, next - Date.now()));
}

/** Delete gesture: mark the idea pending (it vanishes from every surface
 *  at once) and arm its finalization. Nothing is removed yet. */
export function requestDelete(id: string): PendingDelete {
  const entry = beginPendingDelete(id);
  armTimer();
  notify();
  return entry;
}

/** «تراجع»: lift the pending mark inside the grace window. The record, the
 *  song blob and the Drive copy were never touched, so the idea returns
 *  exactly as it was. Returns whether there was anything to undo. */
export function undoDelete(id: string): boolean {
  const restored = cancelPendingDelete(id);
  if (restored) { armTimer(); notify(); }
  return restored;
}

/**
 * App-startup settlement, called once from the root component: deletions
 * whose window closed while the app was away finalize NOW (never silently
 * resurrect, never linger), and any still inside their window get their
 * finalization timer armed for when it closes.
 */
export function initPendingDeletes() {
  const finalized = sweepPendingDeletes(realDeleteEffects);
  armTimer();
  if (finalized.length) notify();
}
