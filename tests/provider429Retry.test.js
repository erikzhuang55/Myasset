import { describe, expect, it, vi } from "vitest";
import {
  PROVIDER_429_RETRY_DELAYS_MS,
  classifyProvider429Error,
  isProvider429Error,
  resolveProviderRetryAfterMs,
  runWithProvider429Backoff
} from "../utils/provider429Retry.js";

function create429Error(message = "API Error 429: rate limited") {
  const error = new Error(message);
  error.code = "HTTP_429";
  error.status = 429;
  return error;
}

describe("provider 429 retry", () => {
  it("recognizes status, code, and message based 429 errors", () => {
    expect(isProvider429Error({ status: 429 })).toBe(true);
    expect(isProvider429Error({ code: "HTTP_429_RATE_LIMIT" })).toBe(true);
    expect(isProvider429Error(new Error("API Error 429: insufficient balance"))).toBe(true);
    expect(isProvider429Error({ status: 500, code: "HTTP_500" })).toBe(false);
  });

  it("separates account quota, model quota, credit, queue, and temporary rate limits", () => {
    expect(classifyProvider429Error(create429Error("You exceeded your current quota"))).toBe("quota_exhausted");
    expect(classifyProvider429Error(create429Error("We have to rate limit you for model deepseek-ai/DeepSeek-V4-Pro"))).toBe("model_quota_exhausted");
    expect(classifyProvider429Error(create429Error("Credit balance exhausted"))).toBe("credit_balance_exhausted");
    expect(classifyProvider429Error(create429Error("Provider queue is full"))).toBe("queue_overloaded");
    expect(classifyProvider429Error(create429Error("Too many requests"))).toBe("rate_limited");
  });

  it("reads Gemini retry-after from headers or error text", () => {
    expect(resolveProviderRetryAfterMs({ retryAfterSec: 2.5 })).toBe(2500);
    expect(resolveProviderRetryAfterMs({ responseHeaders: new Headers({ "retry-after": "4" }) })).toBe(4000);
    expect(resolveProviderRetryAfterMs(create429Error("Please retry in 3.725s"))).toBe(3725);
  });

  it("supports a provider supplied retry delay", async () => {
    const waits = [];
    let attempts = 0;
    const result = await runWithProvider429Backoff(async () => {
      attempts += 1;
      if (attempts === 1) throw create429Error("Please retry in 3.725s");
      return "ok";
    }, {
      delaysMs: [0],
      getNextDelayMs: (error) => resolveProviderRetryAfterMs(error),
      wait: async (delayMs) => waits.push(delayMs)
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(waits).toEqual([3725]);
  });

  it("waits 2s, 5s, and 10s before succeeding without exposing intermediate failures", async () => {
    const waits = [];
    const rateLimits = [];
    const recovered = vi.fn();
    let attempts = 0;
    const result = await runWithProvider429Backoff(async () => {
      attempts += 1;
      if (attempts <= 3) throw create429Error();
      return "ok";
    }, {
      wait: async (delayMs) => waits.push(delayMs),
      onRateLimit: async (event) => rateLimits.push(event),
      onRecovered: recovered
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(4);
    expect(waits).toEqual(PROVIDER_429_RETRY_DELAYS_MS);
    expect(rateLimits.map((event) => event.nextDelayMs)).toEqual(PROVIDER_429_RETRY_DELAYS_MS);
    expect(recovered).toHaveBeenCalledOnce();
    expect(recovered.mock.calls[0][0]).toMatchObject({ attempt: 4, appliedDelayMs: 10000 });
  });

  it("returns the fourth 429 only after all three retries are exhausted", async () => {
    const waits = [];
    const rateLimits = [];
    const error = create429Error("API Error 429: insufficient balance");

    await expect(runWithProvider429Backoff(async () => {
      throw error;
    }, {
      wait: async (delayMs) => waits.push(delayMs),
      onRateLimit: async (event) => rateLimits.push(event)
    })).rejects.toBe(error);

    expect(waits).toEqual([2000, 5000, 10000]);
    expect(rateLimits).toHaveLength(4);
    expect(rateLimits.at(-1)).toMatchObject({ attempt: 4, exhausted: true, nextDelayMs: 0 });
  });

  it("can hand permanent quota errors to a provider fallback without waiting", async () => {
    const wait = vi.fn();
    const error = create429Error("API Error 429: insufficient_quota");
    let attempts = 0;

    await expect(runWithProvider429Backoff(async () => {
      attempts += 1;
      throw error;
    }, {
      wait,
      shouldRetry: () => false
    })).rejects.toBe(error);

    expect(attempts).toBe(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("does not retry non-429 failures", async () => {
    const wait = vi.fn();
    const error = Object.assign(new Error("server error"), { status: 500, code: "HTTP_500" });
    await expect(runWithProvider429Backoff(async () => {
      throw error;
    }, { wait })).rejects.toBe(error);
    expect(wait).not.toHaveBeenCalled();
  });
});
