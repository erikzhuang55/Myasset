export const PROVIDER_429_RETRY_DELAYS_MS = Object.freeze([2000, 5000, 10000]);

export function isProvider429Error(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || "");
  return status === 429
    || code === "HTTP_429"
    || code.startsWith("HTTP_429_")
    || /API Error 429|HTTP 429/i.test(message);
}

export function classifyProvider429Error(error) {
  if (!isProvider429Error(error)) return "not_429";
  const text = `${error?.message || ""}\n${error?.responseText || ""}`;
  if (/insufficient[_\s-]*(?:balance|quota)|exceeded\s+(?:your\s+)?current\s+quota|current\s+quota.{0,30}(?:exceed|exhaust)|billing\s+details/i.test(text)) {
    return "quota_exhausted";
  }
  if (/queue.{0,30}(?:overload|full|limit|busy)|(?:overload|full).{0,30}queue/i.test(text)) {
    return "queue_overloaded";
  }
  if (/rate\s*limit|too\s+many\s+requests|requests?\s+per\s+(?:minute|second)|\bRPM\b|频率.{0,10}(?:限制|超限)|请求过于频繁/i.test(text)) {
    return "rate_limited";
  }
  return "unknown_429";
}

async function callHookSafely(hook, payload) {
  if (typeof hook !== "function") return;
  try {
    await hook(payload);
  } catch (_) {}
}

function defaultWait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function runWithProvider429Backoff(runAttempt, options = {}) {
  if (typeof runAttempt !== "function") throw new TypeError("runAttempt must be a function");
  const delaysMs = Array.isArray(options.delaysMs)
    ? options.delaysMs.map((value) => Math.max(0, Number(value || 0)))
    : [...PROVIDER_429_RETRY_DELAYS_MS];
  const wait = typeof options.wait === "function" ? options.wait : defaultWait;
  const maxAttempts = delaysMs.length + 1;
  let firstError = null;
  let recoveryStartedAt = 0;
  let appliedDelayMs = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    try {
      const result = await runAttempt({ attempt, maxAttempts });
      if (firstError) {
        await callHookSafely(options.onRecovered, {
          attempt,
          maxAttempts,
          firstError,
          result,
          appliedDelayMs,
          attemptDurationMs: Date.now() - attemptStartedAt,
          recoveryDurationMs: recoveryStartedAt ? Date.now() - recoveryStartedAt : 0
        });
      }
      return result;
    } catch (error) {
      if (!isProvider429Error(error)) throw error;
      if (typeof options.shouldRetry === "function" && options.shouldRetry(error) === false) throw error;
      if (!firstError) firstError = error;
      const exhausted = attempt >= maxAttempts;
      const nextDelayMs = exhausted ? 0 : delaysMs[attempt - 1];
      await callHookSafely(options.onRateLimit, {
        attempt,
        maxAttempts,
        error,
        firstError,
        exhausted,
        appliedDelayMs,
        nextDelayMs,
        attemptDurationMs: Date.now() - attemptStartedAt,
        recoveryDurationMs: recoveryStartedAt ? Date.now() - recoveryStartedAt : 0
      });
      if (exhausted) throw error;
      appliedDelayMs = nextDelayMs;
      recoveryStartedAt = Date.now();
      await wait(nextDelayMs, { attempt, maxAttempts, error });
    }
  }

  throw firstError || new Error("Provider 429 retry exhausted");
}
