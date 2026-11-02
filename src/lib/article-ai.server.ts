import { z } from "zod";
import { jsonFail, NOT_PROVIDER_DENIAL, verifyAiCaller } from "./ai-caller.server";
import { createResponsesCall } from "./ai/responses.server";
import { TASK_INSTRUCTIONS } from "./ai-prompts";
import { getLovableAiGatewayResponseHeaders } from "./ai/run-id.ts";

const inputSchema = z.object({
  task: z.enum(["improve", "merge", "suggest", "ask", "classify", "insights", "evidence"]),
  payload: z.string().min(2).max(200000),
});

export async function improveArticle(request: Request): Promise<Response> {
  const fail = jsonFail;
  const caller = await verifyAiCaller(request);
  if (caller instanceof Response) return caller;
  const parsed = inputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return fail("المقال فارغ أو أطول من الحد المتاح للمعالجة.", 400);

  let upstreamStatus = 200;
  let upstreamMessage = "تعذّر تحسين المقال الآن. مقالك الأصلي محفوظ.";
  let upstreamHeaders = new Headers();
  const call = createResponsesCall(request,
    { baseURL: "https://ai.gateway.lovable.dev/v1", apiKey: caller.aiKey, model: "openai/gpt-6-astra" },
    [{ role: "user", content: parsed.data.payload }], TASK_INSTRUCTIONS[parsed.data.task],
    async (response) => {
      upstreamHeaders = response.headers;
      upstreamStatus = response.status;
      if (response.ok) return;
      const error = await response.clone().json().catch(() => ({}));
      upstreamMessage = error.message ?? error.error?.message ?? upstreamMessage;
      const type = error.type ?? error.error?.type;
      if (response.status === 403 && !NOT_PROVIDER_DENIAL.includes(type)) {
        await caller.rememberDenial(upstreamMessage);
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