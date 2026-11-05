import { jsonFail, NOT_PROVIDER_DENIAL, verifyAiCaller } from "./ai-caller.server";
import { getLovableAiGatewayResponseHeaders } from "./ai/run-id.ts";

const MAX_BYTES = 20 * 1024 * 1024;
const MODEL = "openai/gpt-transcribe";

/** Signed-in fallback when there is no personal Gemini key: forwards one recorded piece to the gateway. */
export async function transcribeVoice(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("Content-Length") ?? 0);
  if (declared > MAX_BYTES + 512 * 1024) return jsonFail("التسجيل أكبر من الحد المسموح.", 413);
  const caller = await verifyAiCaller(request);
  if (caller instanceof Response) return caller;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (
    !(file instanceof File) ||
    !file.size ||
    file.size > MAX_BYTES ||
    !file.type.startsWith("audio/")
  ) {
    return jsonFail("ملف الصوت فارغ أو غير صالح.", 400);
  }
  // A song recording is transcribed as sung lyrics (one line per phrase),
  // never as dictation — the client flags it, the prompt stays server-side.
  const song = form?.get("song") === "1";
  const upstream = new FormData();
  upstream.append("model", MODEL);
  upstream.append("file", file, file.name || "voice.webm");
  upstream.append("response_format", "json");
  upstream.append("stream", "true");
  upstream.append(
    "prompt",
    song
      ? "تسجيل غنائي بالعربية (فصحى ولهجات عربية) لصاحبه يغنّي أغنية من تأليفه. فرّغ الكلمات المغناة فقط كما غُنّيت، سطرًا لكل عبارة مغناة، دون أي تعليق أو وصف."
      : "تسجيل صوتي بالعربية (لهجة مصرية وفصحى) لكاتب يملي أفكاره. فرّغه حرفيًا.",
  );
  let response: Response;
  try {
    response = await fetch("https://ai.gateway.lovable.dev/v1/audio/transcriptions", {
      method: "POST",
      body: upstream,
      signal: request.signal,
      headers: { Authorization: `Bearer ${caller.aiKey}`, "X-Lovable-AIG-SDK": "fetch" },
    });
  } catch {
    return jsonFail(
      "تعذّر الوصول إلى خدمة تحويل الصوت. التسجيل محفوظ على هاتفك.",
      request.signal.aborted ? 499 : 502,
    );
  }
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const message =
      error.message ??
      error.error?.message ??
      "تعذّر تحويل الصوت إلى نص الآن. التسجيل محفوظ على هاتفك.";
    const type = error.type ?? error.error?.type;
    if (response.status === 403 && !NOT_PROVIDER_DENIAL.includes(type))
      await caller.rememberDenial(message);
    return jsonFail(message, response.status);
  }
  return new Response(response.body, {
    status: response.status,
    headers: getLovableAiGatewayResponseHeaders(response.headers, {
      "Content-Type": response.headers.get("Content-Type") ?? "text/event-stream",
      "Cache-Control": "no-store, no-transform",
    }),
  });
}
