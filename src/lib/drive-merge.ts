// Browser- and server-safe rules for the Google Drive backup file.
import { parseBackup } from "./backup";
import { mergeIdeas, type Idea } from "./ideas";

export type DriveState = { ideas: Idea[]; deleted: string[] };

/** Read a Drive backup: this app's file, an exported backup, or a plain list of ideas. */
export function parseDriveFile(raw: string): DriveState {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { ideas: [], deleted: [] }; }
  const wrapped = Array.isArray(data) ? { app: "afkari", ideas: data } : data;
  let ideas: Idea[] = [];
  try { ideas = parseBackup(JSON.stringify(wrapped)); } catch { ideas = []; }
  const list = (wrapped as { deleted?: unknown })?.deleted;
  const deleted = Array.isArray(list) ? list.filter((d): d is string => typeof d === "string") : [];
  return { ideas, deleted };
}

/**
 * Combine the Drive file with this device: newer editions win, deletions from any
 * device win, and ideas the user explicitly restored come back.
 */
export function mergeDriveState(drive: DriveState, local: Idea[], deleted: string[], revived: string[]): DriveState {
  const revive = new Set(revived);
  const tombstones = [...new Set([...drive.deleted.filter((id) => !revive.has(id)), ...deleted])];
  return { ideas: mergeIdeas(local, drive.ideas, tombstones), deleted: tombstones };
}

export const buildDriveFile = (state: DriveState, exportedAt = Date.now()) =>
  JSON.stringify({ app: "afkari", version: 1, exportedAt, ideas: state.ideas, deleted: state.deleted }, null, 2);
