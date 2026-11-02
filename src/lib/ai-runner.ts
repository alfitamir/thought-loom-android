/**
 * Reliability layer for server-side Gemini calls: model fallback, timeouts, retries with backoff,
 * a small response cache and a rate limiter. Pure (SDK call injected) so it is fully unit-testable.
 */

/** Same fast-first chain the browser client uses; GEMINI_MODEL / GEMINI_MODELS prepend overrides. */
export const DEFAULT_MODELS = [
  "gemini-3.6-flash", "gemini-3-flash-preview", "gemini-flash-lite-latest",
  // stable fallback if preview names disappear
  "gemini-2.5-flash",
];

export function modelChain(env: { GEMINI_MODEL?: string; GEMINI_MODELS?: string } = {}): string[] {
  const extra = [env.GEMINI_MODEL, ...(env.GEMINI_MODELS?.split(",") ?? [])].map((m) => m?.trim()).filter((m): m is string => !!m);
  return [...new Set([...extra, ...DEFAULT_MODELS])];
}

export type Failure = "auth" | "quota" | "busy" | "model" | "timeout" | "other";

export function classify(error: unknown): Failure {
  const e = error as { status?: number; code?: number; message?: string; name?: string };
  const status = Number(e?.status ?? e?.code ?? 0);
  const msg = String(e?.message ?? "");
  if (e?.name === "TimeoutError") return "timeout";
  if (status === 401 || status === 403 || /api key|permission denied|unauthenticated/i.test(msg)) return "auth";
  if (status === 429 || /resource_exhausted|quota|rate limit/i.test(msg)) return "quota";
  if (status === 500 || status === 502 || status === 503 || status === 504 || /unavailable|overloaded|deadline/i.test(msg)) return "busy";
  if (status === 404 || status === 400 || /not found|not supported|unsupported|invalid argument/i.test(msg)) return "model";
  return "other";
}

export const arabicMessage = (kind: Failure): string => ({
  auth: "مفتاح Gemini على الخادم غير صالح أو غير مفعّل. أضف مفتاحك الشخصي من الإعدادات ⚙️.",
  quota: "تجاوز الخادم الحد المؤقت لـ Gemini. حاول بعد دقيقة، أو استخدم مفتاحك الشخصي من الإعدادات ⚙️.",
  busy: "Gemini مشغول الآن. حاول بعد قليل؛ لم يتغير شيء في مقالاتك.",
  timeout: "تأخر Gemini في الرد. حاول مرة أخرى؛ لم يتغير شيء في مقالاتك.",
  model: "تعذّر تشغيل نموذج Gemini المطلوب. حاول مرة أخرى.",
  other: "تعذّر إكمال الطلب عبر Gemini الآن. حاول مرة أخرى.",
}[kind]);

export type RunOptions = {
  models: string[];
  timeoutMs?: number;
  /** Extra attempts on the same model after a transient failure (busy/quota/timeout). */
  retries?: number;
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onAttempt?: (info: { model: string; attempt: number; failure?: Failure }) => void;
};

export class GeminiError extends Error {
  constructor(message: string, public kind: Failure, public override cause?: unknown) { super(message); }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Try each model in order. Auth errors stop immediately (every model would fail the same way);
 * transient errors retry the same model with backoff once, then move to the next model.
 */
export async function runWithFallback(
  call: (model: string, signal: AbortSignal) => Promise<string>, opts: RunOptions,
): Promise<{ text: string; model: string }> {
  const { models, timeoutMs = 60000, retries = 1, backoffMs = 400, sleep = defaultSleep, onAttempt } = opts;
  let last: GeminiError = new GeminiError(arabicMessage("other"), "other");
  for (const model of models) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const text = await call(model, AbortSignal.timeout(timeoutMs));
        if (!text || !text.trim()) throw Object.assign(new Error("empty response"), { status: 503 });
        onAttempt?.({ model, attempt });
        return { text, model };
      } catch (error) {
        const kind = classify(error);
        onAttempt?.({ model, attempt, failure: kind });
        last = new GeminiError(arabicMessage(kind), kind, error);
        if (kind === "auth") throw last;
        const transient = kind === "busy" || kind === "quota" || kind === "timeout";
        if (transient && attempt < retries) { await sleep(backoffMs * 2 ** attempt + Math.floor(Math.random() * 100)); continue; }
        break; // next model
      }
    }
  }
  throw last;
}

/** Tiny LRU+TTL cache for idempotent AI results (classification, insights, suggestions). */
export function createCache<V>(max = 200, ttlMs = 60 * 60 * 1000, now: () => number = Date.now) {
  const map = new Map<string, { v: V; at: number }>();
  return {
    get(key: string): V | undefined {
      const hit = map.get(key);
      if (!hit) return undefined;
      if (now() - hit.at > ttlMs) { map.delete(key); return undefined; }
      map.delete(key); map.set(key, hit); // refresh recency
      return hit.v;
    },
    set(key: string, v: V) {
      map.delete(key); map.set(key, { v, at: now() });
      while (map.size > max) map.delete(map.keys().next().value as string);
    },
    get size() { return map.size; },
  };
}

/** Sliding-window limiter: allows `limit` hits per `windowMs` per key. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (recent.length >= limit) { hits.set(key, recent); return false; }
    recent.push(t); hits.set(key, recent);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((x) => t - x < windowMs)) hits.delete(k);
    return true;
  };
}
