import { z } from "zod";
import type { Idea } from "./ideas";

/**
 * The ONE canonical zod schema for the Idea shape.
 *
 * Every path that validates idea data arriving from outside the app's own
 * storage derives from this module — the Drive sync route extends it with
 * payload caps (drive-sync.server.ts) and the backup parser validates
 * field-by-field against it (backup.ts, which also reads Drive files via
 * drive-merge.ts). The field list lives HERE and nowhere else.
 *
 * Why: three integrity bugs were the same accident — a field added to two
 * persistence paths and missed in the third. The Drive schema silently
 * stripped `liked`/`source`/`sources` for months (audit F-3.1) and
 * `aiPolishedAt` never reached the Supabase serializer (F-3.2). The parity
 * test in idea-schema.test.ts fails the suite if a field is ever added to
 * the `Idea` type without landing here too.
 *
 * This module is browser-safe on purpose: it imports only zod and the
 * `Idea` TYPE (erased at runtime), never supabase or server code, so
 * ideas.ts's import-light seam is untouched.
 */
export const versionSourceSchema = z.enum(["improve", "clean", "merge", "restore"]);

export const ideaVersionSchema = z.object({
  at: z.number(),
  text: z.string(),
  title: z.string().optional(),
  source: versionSourceSchema,
});

export const ideaSchema = z.object({
  id: z.string(),
  text: z.string(),
  createdAt: z.number(),
  articleTitle: z.string().optional(),
  articleBody: z.string().optional(),
  updatedAt: z.number().optional(),
  aiPolishedAt: z.number().optional(),
  mergedFrom: z.array(z.string()).optional(),
  topic: z.string().optional(),
  topicManual: z.boolean().optional(),
  song: z.boolean().optional(),
  songDuration: z.number().optional(),
  liked: z.boolean().optional(),
  source: z.string().optional(),
  sources: z.array(z.string()).optional(),
  driveFileId: z.string().optional(),
  pinned: z.boolean().optional(),
  medical: z.boolean().optional(),
  project: z.string().optional(),
  versions: z.array(ideaVersionSchema).optional(),
});

/** Every Idea field name, as known by the schema — the single field list. */
export const IDEA_FIELDS = Object.keys(ideaSchema.shape) as (keyof Idea)[];

// Compile-time tripwire (the runtime half lives in idea-schema.test.ts):
// if a field is added to the `Idea` type but not to the schema above,
// `_MissingIdeaFields` names it and `true` stops being assignable here,
// so `tsc` fails before the omission can ship.
type _MissingIdeaFields = Exclude<keyof Idea, keyof typeof ideaSchema.shape>;
const _schemaCoversIdea: _MissingIdeaFields extends never ? true : false = true;
void _schemaCoversIdea;
