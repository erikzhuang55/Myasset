import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const content = readFileSync(new URL("../content.js", import.meta.url), "utf8");
const background = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const contentCss = readFileSync(new URL("../content.css", import.meta.url), "utf8");

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

  it("offers a real ModelScope response header test with safe header output", () => {
    expect(content).toContain('data-action="debug-test-modelscope-response-headers"');
    expect(content).toContain('action: "TEST_MODELSCOPE_RESPONSE_HEADERS"');
    expect(content).toContain("原始响应头");
    expect(content).toContain("原始响应头 JSON");
    expect(content).toContain('data-action="debug-copy-modelscope-response-headers"');
    expect(background).toContain('msg.action === "TEST_MODELSCOPE_RESPONSE_HEADERS"');
    expect(background).toContain("serializeSafeResponseHeaders");
    expect(background).toContain("rawHeaders: responseHeadersToJson");
    expect(background).toContain("set-cookie|set-cookie2|authorization|proxy-authorization");
  });

  it("can clear local announcement read state for repeated UI testing", () => {
    expect(content).toContain('data-action="debug-clear-announcement-read-state"');
    expect(content).toContain('key.startsWith("topAnnouncementDismissed:")');
    expect(content).toContain("appState.dismissedAnnouncementKeys.clear()");
  });

  it("offers a Provider 429 backoff simulation without analytics pollution", () => {
    expect(content).toContain('data-action="debug-run-provider-429-retry-test"');
    expect(content).toContain('runtimeAction: "RUN_PROVIDER_429_RETRY_TEST"');
    expect(content).toContain('provider_429_backoff: "Provider 429 退避重试"');
    expect(background).toContain('msg.action === "RUN_PROVIDER_429_RETRY_TEST"');
    expect(background).toContain("debugForceProvider429Retries: true");
    expect(background).toContain("if (isDebugSimulation)");
    expect(background).toContain("await reportProvider429RetryAttempt(settings, options, event)");
    expect(background).toContain("return;\n            }\n            await reportProvider429Recovered");
  });

  it("wraps retry test actions instead of overflowing the debug card", () => {
    expect(contentCss).toMatch(/\.debug-card-actions\s*\{[\s\S]*?flex-wrap:\s*wrap/);
    expect(contentCss).toMatch(/\.debug-card-actions \.panel-btn\s*\{[\s\S]*?flex:\s*1 1 calc\(50% - 4px\)/);
    expect(contentCss).toMatch(/\.debug-card-actions \.panel-btn\s*\{[\s\S]*?white-space:\s*normal/);
  });

  it("previews the model quota fallback toast without a network request", () => {
    expect(content).toContain('data-action="debug-preview-model-fallback-toast"');
    expect(content).toContain("当前模型当日额度已经耗尽，已自动切换到其他可用模型");
    expect(background).toContain("当前模型当日额度已经耗尽，已自动切换到其他可用模型");
  });

  it("previews the Gemini Retry-After toast without a network request", () => {
    expect(content).toContain('data-action="debug-preview-gemini-retry-after-toast"');
    expect(content).toContain("当前模型触发限流，将在 12 秒后自动重试");
    expect(background).toContain("当前模型触发限流，将在 ${waitSeconds} 秒后自动重试");
  });

  it("keeps summary retries on the original request transport", () => {
    expect(background).toContain('mode: "single",\n                requestStream: false');
    expect(background).toContain('mode: "quality",\n                        requestStream: true');
    expect(background).toContain('mode: "efficiency",\n                    requestStream: true');
    expect(background).toContain("const aiRes = requestStream");
    expect(background).toContain("? await callAIWithTimeoutStream(requestSettings, messages");
    expect(background).toContain(": await callAIWithTimeout(requestSettings, messages");
    expect(background).toContain("isModelScopeStoppedEmptySummary(settings, initialAIResponse)");
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
