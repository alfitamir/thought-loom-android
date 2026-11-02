import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { Database } from "@/integrations/supabase/types";
import { createResponsesCall } from "./ai/responses.server";
import { TASK_INSTRUCTIONS } from "./ai-prompts";
import { getLovableAiGatewayResponseHeaders } from "./ai/run-id.ts";

const inputSchema = z.object({
  task: z.enum(["improve", "merge", "suggest"]),
  payload: z.string().min(2).max(200000),
});

export async function improveArticle(request: Request): Promise<Response> {
  const fail = (message: string, status: number) => Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  const aiKey = process.env["LOVABLE_API_KEY"];
  if (!url || !key || !aiKey) return fail("خدمة تحسين المقالات غير مهيأة الآن.", 503);
  const bearer = request.headers.get("Authorization");
  if (!bearer?.startsWith("Bearer ")) return fail("سجّل الدخول لتفعيل تحسين المقالات.", 401);
  const token = bearer.slice(7);
  const cloud = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: bearer }, fetch: (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("apikey", key);
      return fetch(input, { ...init, headers });
    } },
  });
  const { data: auth, error: authError } = await cloud.auth.getUser(token);
  if (authError || !auth.user) return fail("سجّل الدخول مجددًا لتفعيل تحسين المقالات.", 401);
  const { data: blocked, error: stateError } = await cloud.from("ai_access_state").select("status,message").eq("user_id", auth.user.id).maybeSingle();
  if (stateError) return fail("تعذّر التحقق من إتاحة التحسين الآن.", 503);
  if (blocked) return fail(blocked.message, blocked.status);
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("المقال فارغ أو أطول من الحد المتاح للمعالجة.", 400);

  let upstreamStatus = 200;
  let upstreamMessage = "تعذّر تحسين المقال الآن. مقالك الأصلي محفوظ.";
  let upstreamHeaders = new Headers();
  const rememberDenial = async (message: string) => {
    // Only privileged persistence, after verifying the caller; reads above use their RLS client.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("ai_access_state").upsert({ user_id: auth.user.id, status: 403, message });
    if (error) console.error("Unable to persist AI denial", error.code);
  };
  const call = createResponsesCall(request,
    { baseURL: "https://ai.gateway.lovable.dev/v1", apiKey: aiKey, model: "openai/gpt-6-astra" },
    [{ role: "user", content: parsed.data.payload }], TASK_INSTRUCTIONS[parsed.data.task],
    async (response) => {
      upstreamHeaders = response.headers;
      upstreamStatus = response.status;
      if (response.ok) return;
      const error = await response.clone().json().catch(() => ({}));
      upstreamMessage = error.message ?? error.error?.message ?? upstreamMessage;
      const type = error.type ?? error.error?.type;
      if (response.status === 403 && !["credit_limit_reached", "ai_disabled", "provider_not_available_in_region", "model_requires_retention_consent", "model_vendor_not_enabled"].includes(type)) {
        await rememberDenial(upstreamMessage);
      }
    });
  const iterator = call.result.fullStream[Symbol.asyncIterator]();
  let first;
  try {
    first = await iterator.next();
  } catch {
    return fail(upstreamMessage, request.signal.aborted ? 499 : upstreamStatus === 200 ? 502 : upstreamStatus);
  }
  if (upstreamStatus >= 400) {
    await iterator.return?.();
    return fail(upstreamMessage, upstreamStatus);
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: object) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      let text = "", failed = false;
      try {
        let next = first;
        while (!next.done) {
          const part = next.value;
          if (part.type === "text-delta") { text += part.text; emit({ type: "text", text: part.text }); }
          if (part.type === "error") { failed = true; emit({ type: "error", message: upstreamMessage }); break; }
          next = await iterator.next();
        }
        if (!failed) {
          const reason = await call.result.finishReason;
          if (reason === "length") emit({ type: "error", message: "النسخة المقترحة ناقصة، لم نغير مقالك." });
          else if (reason === "content-filter" || !text.trim()) emit({ type: "error", message: "لم تُتح خدمة الذكاء الاصطناعي تحسين هذا المقال. لم يتغير النص الأصلي." });
          else emit({ type: "done" });
        }
      } catch {
        if (!request.signal.aborted) emit({ type: "error", message: upstreamMessage });
      } finally { controller.close(); }
    },
    async cancel() { await iterator.return?.(); },
  });
  return new Response(stream, { headers: getLovableAiGatewayResponseHeaders(upstreamHeaders, {
    "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform",
  }) });
}