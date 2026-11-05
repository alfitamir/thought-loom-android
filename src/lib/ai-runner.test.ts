import { describe, expect, it, vi } from "vitest";
import {
  classify,
  createCache,
  createRateLimiter,
  DEFAULT_MODELS,
  GeminiError,
  modelChain,
  runWithFallback,
} from "./ai-runner";

const err = (status: number, message = "x") => Object.assign(new Error(message), { status });
const opts = (over = {}) => ({ models: ["m1", "m2", "m3"], sleep: async () => {}, ...over });

describe("modelChain", () => {
  it("puts overrides first, keeps defaults, removes duplicates", () => {
    expect(modelChain({ GEMINI_MODEL: "custom", GEMINI_MODELS: "a, b ,custom" })).toEqual([
      "custom",
      "a",
      "b",
      ...DEFAULT_MODELS,
    ]);
    expect(modelChain({})).toEqual(DEFAULT_MODELS);
  });
});

describe("classify", () => {
  it.each([
    [err(401), "auth"],
    [err(403), "auth"],
    [err(400, "API key not valid"), "auth"],
    [err(429), "quota"],
    [err(503), "busy"],
    [err(404), "model"],
    [err(400, "thinking not supported"), "model"],
    [Object.assign(new Error("t"), { name: "TimeoutError" }), "timeout"],
    [new Error("weird"), "other"],
  ])("%#", (e, kind) => expect(classify(e)).toBe(kind));
});

describe("runWithFallback", () => {
  it("returns the first model's answer when it works", async () => {
    const call = vi.fn(async () => "ok");
    expect(await runWithFallback(call, opts())).toEqual({ text: "ok", model: "m1" });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("falls back to the next model when a model does not exist (the unverified-model-name case)", async () => {
    const call = vi.fn(async (m: string) => {
      if (m === "m1") throw err(404, "model not found");
      return "from-" + m;
    });
    expect(await runWithFallback(call, opts())).toEqual({ text: "from-m2", model: "m2" });
  });
  it("retries a busy model once with backoff before moving on", async () => {
    const sleep = vi.fn(async () => {});
    const call = vi.fn().mockRejectedValueOnce(err(503)).mockResolvedValueOnce("recovered");
    expect(await runWithFallback(call, opts({ sleep }))).toEqual({
      text: "recovered",
      model: "m1",
    });
    expect(sleep).toHaveBeenCalledTimes(1);
  });
  it("moves to the next model after retries are exhausted", async () => {
    const call = vi.fn(async (m: string) => {
      if (m !== "m3") throw err(503);
      return "third";
    });
    expect((await runWithFallback(call, opts())).model).toBe("m3");
    expect(call).toHaveBeenCalledTimes(5); // m1 x2, m2 x2, m3 x1
  });
  it("stops immediately on auth errors instead of burning every model", async () => {
    const call = vi.fn(async () => {
      throw err(403, "permission denied");
    });
    await expect(runWithFallback(call, opts())).rejects.toMatchObject({ kind: "auth" });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("treats an empty answer as a failure and tries again", async () => {
    const call = vi.fn().mockResolvedValueOnce("  ").mockResolvedValueOnce("real");
    expect((await runWithFallback(call, opts())).text).toBe("real");
  });
  it("throws an Arabic, user-facing GeminiError when everything fails", async () => {
    const call = vi.fn(async () => {
      throw err(429);
    });
    const e = await runWithFallback(call, opts()).catch((x) => x);
    expect(e).toBeInstanceOf(GeminiError);
    expect(e.kind).toBe("quota");
    expect(e.message).toMatch(/[؀-ۿ]/);
  });
  it("passes an abort signal that fires at the timeout", async () => {
    const call = vi.fn(
      (_m: string, signal: AbortSignal) =>
        new Promise<string>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        ),
    );
    const e = await runWithFallback(
      call,
      opts({ models: ["m1"], timeoutMs: 20, retries: 0 }),
    ).catch((x) => x);
    expect(e.kind).toBe("timeout");
  });
});

describe("createCache", () => {
  it("expires entries after the TTL", () => {
    let t = 0;
    const c = createCache<string>(10, 100, () => t);
    c.set("a", "1");
    t = 50;
    expect(c.get("a")).toBe("1");
    t = 200;
    expect(c.get("a")).toBeUndefined();
  });
  it("evicts the least recently used entry", () => {
    const c = createCache<string>(2);
    c.set("a", "1");
    c.set("b", "2");
    c.get("a");
    c.set("c", "3");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe("1");
    expect(c.size).toBe(2);
  });
});

describe("createRateLimiter", () => {
  it("allows up to the limit per window, per key, then recovers", () => {
    let t = 0;
    const ok = createRateLimiter(2, 1000, () => t);
    expect([ok("ip1"), ok("ip1"), ok("ip1"), ok("ip2")]).toEqual([true, true, false, true]);
    t = 1500;
    expect(ok("ip1")).toBe(true);
  });
});
