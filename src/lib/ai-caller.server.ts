import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export const jsonFail = (message: string, status: number) =>
  Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });

/** Workspace-level blocks that pause work but are not a provider denial for this user. */
export const NOT_PROVIDER_DENIAL = [
  "credit_limit_reached",
  "ai_disabled",
  "provider_not_available_in_region",
  "model_requires_retention_consent",
  "model_vendor_not_enabled",
];

/**
 * Verify the signed-in caller and that AI work isn't blocked for them.
 * Returns the AI key and a way to persist a terminal provider denial, or a ready error response.
 */
export async function verifyAiCaller(
  request: Request,
): Promise<
  { userId: string; aiKey: string; rememberDenial: (message: string) => Promise<void> } | Response
> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  const aiKey = process.env["LOVABLE_API_KEY"];
  if (!url || !key || !aiKey) return jsonFail("خدمة الذكاء الاصطناعي غير مهيأة الآن.", 503);
  const bearer = request.headers.get("Authorization");
  if (!bearer?.startsWith("Bearer ")) return jsonFail("سجّل الدخول لتفعيل هذه الخدمة.", 401);
  const cloud = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { Authorization: bearer },
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("apikey", key);
        return fetch(input, { ...init, headers });
      },
    },
  });
  const { data: auth, error } = await cloud.auth.getUser(bearer.slice(7));
  if (error || !auth.user) return jsonFail("سجّل الدخول مجددًا لتفعيل هذه الخدمة.", 401);
  const { data: blocked, error: stateError } = await cloud
    .from("ai_access_state")
    .select("status,message")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (stateError) return jsonFail("تعذّر التحقق من إتاحة الخدمة الآن.", 503);
  if (blocked) return jsonFail(blocked.message, blocked.status);
  const userId = auth.user.id;
  return {
    userId,
    aiKey,
    rememberDenial: async (message) => {
      // Privileged write only after the caller was verified above.
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error: e } = await supabaseAdmin
        .from("ai_access_state")
        .upsert({ user_id: userId, status: 403, message });
      if (e) console.error("Unable to persist AI denial", e.code);
    },
  };
}
