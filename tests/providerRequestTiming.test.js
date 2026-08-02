import { describe, expect, it, vi } from "vitest";
import { createProviderRequestTiming } from "../utils/providerRequestTiming.js";

describe("provider request timing", () => {
  it("does not consume provider timeout while waiting in the queue", () => {
    vi.useFakeTimers();
    let nowMs = 0;
    const controller = new AbortController();
    const timing = createProviderRequestTiming({
      controller,
      timeoutMs: 60000,
      now: () => nowMs
    });

    nowMs = 45000;
    vi.advanceTimersByTime(45000);
    expect(controller.signal.aborted).toBe(false);

    timing.startRequest();
    expect(timing.snapshot().queueWaitMs).toBe(45000);

    nowMs = 104999;
    vi.advanceTimersByTime(59999);
    expect(controller.signal.aborted).toBe(false);

    nowMs = 105000;
    vi.advanceTimersByTime(1);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe("timeout");
    expect(timing.snapshot().providerRequestMs).toBe(60000);
    vi.useRealTimers();
  });

  it("records first response time and clears the stream first-response timeout", () => {
    vi.useFakeTimers();
    let nowMs = 1000;
    const controller = new AbortController();
    const timing = createProviderRequestTiming({
      controller,
      timeoutMs: 60000,
      stopTimeoutOnFirstResponse: true,
      now: () => nowMs
    });

    nowMs = 4000;
    timing.startRequest();
    nowMs = 5500;
    timing.markFirstResponse();
    expect(timing.snapshot()).toMatchObject({
      queueWaitMs: 3000,
      providerRequestMs: 1500,
      firstResponseMs: 1500
    });

    vi.advanceTimersByTime(60000);
    expect(controller.signal.aborted).toBe(false);
    vi.useRealTimers();
  });
});
