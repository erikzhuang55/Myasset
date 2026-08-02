import { describe, expect, it } from "vitest";
import "../logger.js";

describe("AIPluginLogger", () => {
  it("normalizes event names and promotes common fields", () => {
    const entries = [];
    const logger = globalThis.AIPluginLogger.create("download", {
      getDebugMode: () => true,
      onEntry: (entry) => entries.push(entry),
      printConsole: false
    });

    logger.info("Download URL Prepare Success", {
      task: "download",
      task_id: "download_123",
      trace_id: "trace_123",
      attempt_id: "attempt_1",
      tab_id: 42,
      bvid: "BV123",
      cid: 456,
      provider: "bilibili",
      status: 200,
      retryable: true,
      fallback: "page_fetch",
      latency_ms: 123,
      detail: {
        asset_type: "video",
        quality: "1080P"
      }
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "info",
      module: "download",
      event: "download_url_prepare_success",
      task: "download",
      task_id: "download_123",
      trace_id: "trace_123",
      attempt_id: "attempt_1",
      tab_id: 42,
      source: "content",
      bvid: "BV123",
      cid: 456,
      provider: "bilibili",
      status: 200,
      retryable: true,
      fallback: "page_fetch",
      duration_ms: 123,
      detail: {
        asset_type: "video",
        quality: "1080P"
      }
    });
  });

  it("filters sensitive fields and truncates large values", () => {
    const entries = [];
    const logger = globalThis.AIPluginLogger.create("ai", {
      getDebugMode: () => true,
      onEntry: (entry) => entries.push(entry),
      printConsole: false
    });

    logger.error("ai_request_failed", {
      task: "summary",
      apiKey: "sk-secret",
      detail: {
        prompt: "please summarize this",
        subtitle: "long subtitle",
        response_preview: "x".repeat(400),
        ranges: Array.from({ length: 25 }, (_, index) => ({ index }))
      }
    });

    const detail = entries[0].detail;
    expect(detail.apiKey).toBe("[Filtered]");
    expect(detail.prompt).toBe("[Filtered]");
    expect(detail.subtitle).toBe("[Filtered]");
    expect(detail.response_preview).toContain("[Truncated]");
    expect(detail.ranges).toHaveLength(21);
    expect(detail.ranges.at(-1)).toBe("...[5 more]");
  });

  it("stores info/warn/error by default but keeps debug gated", () => {
    const entries = [];
    const logger = globalThis.AIPluginLogger.create("ai", {
      getDebugMode: () => false,
      onEntry: (entry) => entries.push(entry),
      printConsole: false
    });

    logger.info("ai_request_start", { task: "summary" });
    logger.warn("summary_quality_warning", { task: "summary" });
    logger.error("ai_request_failed", { task: "summary" });
    logger.debug("provider_response", { task: "summary" });

    expect(entries.map((entry) => entry.level)).toEqual(["info", "warn", "error"]);
  });
});
