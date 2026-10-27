import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { mergeIdeas } from "./ideas";
import { buildDriveFile, mergeDriveState, parseDriveFile, type DriveState } from "./drive-merge";

const GATEWAY = "https://connector-gateway.lovable.dev/google_drive";
const FILE_NAME = "afkari-sync.json";
const LEGACY_NAME = "afkari-backup.json";

const idea = z.object({
  id: z.string().min(1).max(100),
  text: z.string().max(200000),
  createdAt: z.number(),
  articleTitle: z.string().max(5000).optional(),
  articleBody: z.string().max(400000).optional(),
  updatedAt: z.number().optional(),
  aiPolishedAt: z.number().optional(),
});
const inputSchema = z.object({
  ideas: z.array(idea).max(10000),
  deleted: z.array(z.string().max(100)).max(10000),
  revived: z.array(z.string().max(100)).max(10000),
});

class DriveError extends Error {
  constructor(public status: number, body: string) { super(`Drive request failed [${status}]: ${body}`); }
}

export async function driveSync(request: Request): Promise<Response> {
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

  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("بيانات المزامنة غير صالحة.", 400);

  const drive = async (path: string, init: RequestInit = {}) => {
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
  const search = async (q: string) => {
    const res = await drive(`drive/v3/files?spaces=drive&orderBy=modifiedTime%20desc&fields=files(id)&q=${encodeURIComponent(q)}`);
    return ((await res.json()).files ?? []) as { id: string }[];
  };
  const download = async (id: string) => parseDriveFile(await (await drive(`drive/v3/files/${id}?alt=media`)).text());

  try {
    const [own] = await search(`name='${FILE_NAME}' and trashed=false and appProperties has { key='afkari' and value='sync' }`);
    let current: DriveState = { ideas: [], deleted: [] };
    if (own) current = await download(own.id);
    else {
      // First sync: bring in older backups already in Drive (e.g. from another copy of the app).
      for (const file of (await search(`name='${LEGACY_NAME}' and trashed=false`)).slice(0, 5)) {
        const legacy = await download(file.id).catch(() => null);
        if (legacy) current = { ideas: mergeIdeas(current.ideas, legacy.ideas, []), deleted: current.deleted };
      }
    }
    const { deleted, revived } = parsed.data;
    const ideas = parseDriveFile(JSON.stringify(parsed.data.ideas)).ideas;
    const merged = mergeDriveState(current, ideas, deleted, revived);
    const content = buildDriveFile(merged);
    if (own) {
      await drive(`upload/drive/v3/files/${own.id}?uploadType=media`, {
        method: "PATCH", headers: { "Content-Type": "application/json; charset=UTF-8" }, body: content,
      });
    } else {
      const boundary = `afkari${crypto.randomUUID()}`;
      const metadata = { name: FILE_NAME, mimeType: "application/json", appProperties: { afkari: "sync" }, description: "نسخة أفكاري التلقائية — لا تحذفها" };
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
      await drive("upload/drive/v3/files?uploadType=multipart", {
        method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
      });
    }
    return Response.json(merged, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof DriveError) {
      if (error.status === 401 || error.status === 403) return fail("انقطع الربط مع Google Drive. أعد ربطه ثم حاول مرة أخرى.", 502);
      if (error.status === 429) return fail("Google Drive مشغول الآن. سنحاول مرة أخرى لاحقًا.", 503);
      return fail(`تعذّرت المزامنة مع Google Drive الآن (${error.status}). أفكارك محفوظة على الهاتف.`, 502);
    }
    console.error("Drive sync failed", error);
    return fail("تعذّرت المزامنة مع Google Drive الآن. أفكارك محفوظة على الهاتف.", 502);
  }
}
