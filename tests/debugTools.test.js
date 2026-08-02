import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const content = readFileSync(new URL("../content.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../background.js", import.meta.url), "utf8");

describe("developer tools panel", () => {
  it("keeps the debug-only navigation entry in its existing position", () => {
    expect(content).toMatch(
      /\{ id: "real"[\s\S]*\{ id: "debug", file: "settings\.png", slot: "top", label: "测试" \}[\s\S]*\{ id: "copy"/,
    );
    expect(content).toContain('if (item.id === "debug" && !isDebugLoggingEnabled()) return false;');
  });

  it("organizes tools into overview, scenarios, logs, and state", () => {
    expect(content).toContain('["overview", "概览"]');
    expect(content).toContain('["scenarios", "场景测试"]');
    expect(content).toContain('["logs", "日志"]');
    expect(content).toContain('["state", "状态"]');
    expect(content).toContain('data-action="debug-switch-tab"');
  });

  it("uses a selectable error preview and labels costly live tests", () => {
    expect(content).toContain('id="debug-error-code"');
    expect(content).toContain('id="debug-error-target"');
    expect(content).toContain('data-action="debug-run-error-demo"');
    expect(content).toContain("真实调用当前 AI Provider，可能产生 API 费用");
  });

  it("offers real summary-empty and segment-truncation retry tests", () => {
    expect(content).toContain('data-action="debug-run-summary-empty-retry-test"');
    expect(content).toContain('data-action="debug-run-segments-truncation-retry-test"');
    expect(content).toContain('runtimeAction: "RUN_SUMMARY_EMPTY_RETRY_TEST"');
    expect(content).toContain('runtimeAction: "RUN_SEGMENTS_TRUNCATION_RETRY_TEST"');
    expect(content).toContain('expanded_tokens: "提高输出上限重试"');
    expect(background).toContain('msg.action === "RUN_SUMMARY_EMPTY_RETRY_TEST"');
    expect(background).toContain('msg.action === "RUN_SEGMENTS_TRUNCATION_RETRY_TEST"');
    expect(background).toContain("debugForceFirstSummaryEmpty: true");
    expect(background).toContain("debugForceFirstSegmentsTruncation: true");
  });

  it("keeps summary retries on the original request transport", () => {
    expect(background).toContain('mode: "single",\n                requestStream: false');
    expect(background).toContain('mode: "quality",\n                        requestStream: true');
    expect(background).toContain('mode: "efficiency",\n                    requestStream: true');
    expect(background).toContain("const aiRes = requestStream");
    expect(background).toContain("? await callAIWithTimeoutStream(settings, messages");
    expect(background).toContain(": await callAIWithTimeout(settings, messages");
  });

  it("judges live retry scenarios from their final task status", () => {
    expect(content).toContain("const finalStatuses = test.tasks.map");
    expect(content).toContain('const passed = finalStatuses.every((item) => item.status === "done")');
    expect(content).toContain('status: passed ? "passed" : "failed"');
  });

  it("merges ASR UI traces into the filterable log view", () => {
    expect(content).toContain('module: "asr_ui"');
    expect(content).toContain('id="debug-log-level"');
    expect(content).toContain('id="debug-log-module"');
    expect(content).toContain('id="debug-log-only-failures"');
    expect(content).toContain("formatDebugTimelineEntry");
  });

  it("shows provider queue and request timing in the debug timeline", () => {
    expect(content).toContain("`queue=${Number(detail.queue_wait_ms)}ms`");
    expect(content).toContain("`request=${Number(detail.provider_request_ms)}ms`");
    expect(content).toContain("`first=${Number(detail.first_response_ms)}ms`");
    expect(content).toContain("`phase=${detail.timeout_phase}`");
  });
});
