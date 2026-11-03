import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";

// Google Drive copies of song recordings, served by /api/drive/song-audio.
// Authorization is exactly the backup sync's (drive-sync.server.ts): the
// Lovable Drive connector reaches the APP OWNER's Drive with the server-only
// keys below, and only the owner's signed-in account (DRIVE_OWNER_USER_ID)
// may use it — the browser never holds a Drive token or a Drive scope.
// Recordings live as ordinary files in a regular My Drive folder,
// «أفكاري — الأغاني», visible in the owner's Drive app; each file carries
// appProperties { afkari: 'song', songId } so it can be found again by the
// song it belongs to (re-uploads after a lost response adopt it instead).

const GATEWAY = "https://connector-gateway.lovable.dev/google_drive";
export const SONGS_FOLDER_NAME = "أفكاري — الأغاني";
const FOLDER_MARK = { key: "afkari", value: "songs-folder" };

/** One raw Drive API call through the connector gateway. */
export type DriveFetch = (path: string, init?: RequestInit) => Promise<Response>;

class DriveError extends Error {
  constructor(public status: number, body: string) { super(`Drive request failed [${status}]: ${body}`); }
}

/**
 * The Drive operations for song audio, built over an injected Drive fetch
 * so they can be tested without the gateway. The folder is found or
 * created once per ops instance and then remembered.
 */
export function createSongDriveOps(drive: DriveFetch) {
  const search = async (q: string): Promise<{ id: string }[]> => {
    const res = await drive(`drive/v3/files?spaces=drive&orderBy=modifiedTime%20desc&fields=files(id)&q=${encodeURIComponent(q)}`);
    return ((await res.json()).files ?? []) as { id: string }[];
  };

  let folderId: Promise<string> | null = null;
  const ensureFolder = (): Promise<string> => {
    folderId ??= (async () => {
      const [found] = await search(
        `mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='${FOLDER_MARK.key}' and value='${FOLDER_MARK.value}' }`,
      );
      if (found) return found.id;
      const res = await drive("drive/v3/files?fields=id", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({
          name: SONGS_FOLDER_NAME,
          mimeType: "application/vnd.google-apps.folder",
          parents: ["root"],
          appProperties: { afkari: FOLDER_MARK.value },
          description: "تسجيلات أغاني أفكاري — نسخ احتياطية تلقائية من التطبيق",
        }),
      });
      return ((await res.json()) as { id: string }).id;
    })();
    return folderId;
  };

  /** The Drive file already holding this song's recording, if there is one. */
  const findSongFile = async (songId: string): Promise<string | null> => {
    const [found] = await search(`trashed=false and appProperties has { key='songId' and value='${songId}' }`);
    return found?.id ?? null;
  };

  /** Upload one recording into the songs folder; returns the new file id. */
  const uploadSong = async (input: { songId: string; name: string; blob: Blob; mime: string }): Promise<string> => {
    const folder = await ensureFolder();
    const boundary = `afkari${crypto.randomUUID()}`;
    const metadata = {
      name: input.name,
      parents: [folder],
      appProperties: { afkari: "song", songId: input.songId },
      description: "تسجيلة أغنية من تطبيق أفكاري",
    };
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${input.mime}\r\n\r\n`;
    const body = new Blob([head, input.blob, `\r\n--${boundary}--`], { type: `multipart/related; boundary=${boundary}` });
    const res = await drive("upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return ((await res.json()) as { id: string }).id;
  };

  /** The recording's bytes, for a device downloading its copy on demand. */
  const downloadSong = async (fileId: string): Promise<Response> =>
    drive(`drive/v3/files/${fileId}?alt=media`);

  /** Permanently delete one recording's Drive file. */
  const deleteSongFile = async (fileId: string): Promise<void> => {
    await drive(`drive/v3/files/${fileId}`, { method: "DELETE" });
  };

  return { ensureFolder, findSongFile, uploadSong, downloadSong, deleteSongFile };
}

export type SongDriveOps = ReturnType<typeof createSongDriveOps>;

const jsonBody = z.object({
  action: z.enum(["find", "download", "delete"]),
  songId: z.string().min(1).max(100).optional(),
  fileId: z.string().min(1).max(200).optional(),
});

export async function driveSongAudio(request: Request): Promise<Response> {
  const fail = (message: string, status: number) => Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const driveKey = process.env["GOOGLE_DRIVE_API_KEY"];
  const owner = process.env["DRIVE_OWNER_USER_ID"];
  if (!url || !key || !lovableKey || !driveKey || !owner) return fail("المزامنة مع Google Drive غير مهيأة الآن.", 503);

  const bearer = request.headers.get("Authorization");
  if (!bearer?.startsWith("Bearer ")) return fail("سجّل الدخول أولاً لتفعيل المزامنة مع Google Drive.", 401);
  const cloud = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("apikey", key);
      return fetch(input, { ...init, headers });
    } },
  });
  const { data: auth, error: authError } = await cloud.auth.getUser(bearer.slice(7));
  if (authError || !auth.user) return fail("سجّل الدخول مجددًا لتفعيل المزامنة مع Google Drive.", 401);
  // The Drive belongs to the app owner; nobody else may read or write it.
  if (auth.user.id !== owner) return fail("المزامنة مع Google Drive متاحة لصاحب التطبيق فقط.", 403);

  const drive: DriveFetch = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${lovableKey}`);
    headers.set("X-Connection-Api-Key", driveKey);
    const res = await fetch(`${GATEWAY}/${path}`, { ...init, headers });
    if (!res.ok) {
      const body = await res.text();
      console.error(`Drive request failed [${res.status}]: ${body}`);
      throw new DriveError(res.status, body);
    }
    return res;
  };
  const ops = createSongDriveOps(drive);

  try {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData().catch(() => null);
      const file = form?.get("file");
      const songId = form?.get("songId");
      const name = form?.get("name");
      if (form?.get("action") !== "upload" || typeof songId !== "string" || !songId || typeof name !== "string" || !name || !(file instanceof Blob)) {
        return fail("بيانات الرفع غير صالحة.", 400);
      }
      const fileId = await ops.uploadSong({ songId, name, blob: file, mime: file.type || "audio/webm" });
      return Response.json({ fileId }, { headers: { "Cache-Control": "no-store" } });
    }

    const parsed = jsonBody.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return fail("بيانات الطلب غير صالحة.", 400);
    const { action, songId, fileId } = parsed.data;
    if (action === "find") {
      if (!songId) return fail("بيانات الطلب غير صالحة.", 400);
      return Response.json({ fileId: await ops.findSongFile(songId) }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!fileId) return fail("بيانات الطلب غير صالحة.", 400);
    if (action === "delete") {
      await ops.deleteSongFile(fileId);
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    const res = await ops.downloadSong(fileId);
    return new Response(res.body, {
      headers: {
        "Content-Type": res.headers.get("Content-Type") ?? "audio/webm",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof DriveError) {
      if (error.status === 401 || error.status === 403) return fail("انقطع الربط مع Google Drive. أعد ربطه ثم حاول مرة أخرى.", 502);
      if (error.status === 429) return fail("Google Drive مشغول الآن. سنحاول مرة أخرى لاحقًا.", 503);
      return fail(`تعذّرت المزامنة مع Google Drive الآن (${error.status}).`, 502);
    }
    console.error("Drive song audio failed", error);
    return fail("تعذّرت المزامنة مع Google Drive الآن.", 502);
  }
}
