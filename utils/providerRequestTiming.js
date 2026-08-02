export function createProviderRequestTiming({
  controller,
  timeoutMs,
  stopTimeoutOnFirstResponse = false,
  now = () => globalThis.performance?.now?.() ?? Date.now()
} = {}) {
  const enqueuedAt = now();
  let requestStartedAt = null;
  let firstResponseAt = null;
  let timeoutId = null;

  function clearRequestTimeout() {
    if (timeoutId === null) return;
    clearTimeout(timeoutId);
    timeoutId = null;
  }

  function startRequest() {
    if (requestStartedAt !== null) return snapshot();
    requestStartedAt = now();
    timeoutId = setTimeout(() => {
      controller?.abort?.("timeout");
    }, Math.max(0, Number(timeoutMs || 0)));
    return snapshot();
  }

  function markFirstResponse() {
    if (firstResponseAt === null) firstResponseAt = now();
    if (stopTimeoutOnFirstResponse) clearRequestTimeout();
    return snapshot();
  }

  function snapshot() {
    const current = now();
    return {
      queueWaitMs: requestStartedAt === null
        ? undefined
        : Math.max(0, Math.round(requestStartedAt - enqueuedAt)),
      providerRequestMs: requestStartedAt === null
        ? undefined
        : Math.max(0, Math.round(current - requestStartedAt)),
      firstResponseMs: requestStartedAt === null || firstResponseAt === null
        ? undefined
        : Math.max(0, Math.round(firstResponseAt - requestStartedAt))
    };
  }

  return {
    startRequest,
    markFirstResponse,
    snapshot,
    finish: clearRequestTimeout
  };
}
