import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const background = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const content = readFileSync(new URL("../content.js", import.meta.url), "utf8");

describe("product analytics instrumentation", () => {
  it("adds a task id and schema version to task event metadata", () => {
    expect(background).toContain("function createUsageTaskId");
    expect(background).toContain("event_schema_version: 2");
    expect(background).toContain('task_id: String(payload.taskId || "").trim() || undefined');
    expect(background).toContain('eventName: "task_attempt_failed"');
    expect(background).toContain('eventName: "task_recovery_finished"');
    expect(background).toContain('"summary_empty_retry"');
    expect(background).not.toContain('strategy: "local_json_extract"');
    expect(background).not.toContain('"segments_local_json_repair"');
    expect(background).toContain("function parseSegmentsJSON");
    expect(background).toContain("if (!isStrictModelScopeProvider(settings)) return robustJSONParse(responseText)");
    expect(background).toContain('"分段 JSON/字段异常，直接切换 ModelScope 备用模型"');
    expect(background).toContain('strategy = "ai_json_repair"');
    expect(background).toContain("markSegmentsAIRepairAttempted(taskContext)");
    expect(background).toContain('strategy: strategy === "primary" ? "primary_retry"');

    const taskEventCount = [...background.matchAll(/eventName:\s*["']task_[a-z_]+["']/g)].length;
    const correlatedEventCount = [...background.matchAll(/^\s+taskId,$/gm)].length;
    expect(taskEventCount).toBeGreaterThan(10);
    expect(correlatedEventCount).toBeGreaterThanOrEqual(taskEventCount);
  });

  it("records installation and meaningful feature views", () => {
    expect(background).toContain('eventName: "extension_installed"');
    expect(background).toContain('install_source: "unknown"');
    expect(content).toContain('eventName: "feature_viewed"');
    expect(content).toContain('reportActiveFeatureViewed("bootstrap")');
    expect(content).toContain('reportActiveFeatureViewed("navigation")');
  });

  it("routes provider authentication failures to product analytics instead of Sentry", () => {
    expect(background).toContain('eventName: "provider_auth_failed"');
    expect(background).toContain('errorCode: "HTTP_401"');
    expect(background).toContain('provider: String(mergedContext?.provider || errorInput?.provider || settings?.provider || "")');
    expect(background).toContain('reason: "provider_auth_failed_metric"');
  });

  it("captures a generated task only once at its final failure boundary", () => {
    expect(background).toContain('source: "task_final_failure"');
    expect(background).toContain('task_id: taskId');
    expect(background).toContain('reason: "task_already_captured"');
    expect(background).toContain('if (errorInput?.__sentryCaptured) return { sent: false, reason: "already_captured" }');
    expect(background).toMatch(/task: "transcribe",\s*task_id: taskId/);
    expect(background).toMatch(/task: "chat",\s*task_id: taskId/);
    expect(background).not.toContain('source: "task_status_update"');
    expect(content).not.toContain('reportContentError?.(error, { task: tasks.join(","), source: "run_tasks" })');
  });

  it("queues Supabase telemetry without blocking task execution", () => {
    expect(background).toContain("function reportClientUsageEvent");
    expect(background).toContain("void sendClientUsageEvent(payload, settingsInput)");
    expect(background).toContain("function reportDailyFeatureUsage");
    expect(background).toContain("void sendDailyFeatureUsage(featureName, settings, metrics, status, errorCode, usageContext)");
  });

  it("classifies terminal failures for the dashboard", () => {
    expect(background).toContain("function resolveTaskOutcomeCategory");
    expect(background).toContain('return "plugin_logic_failed"');
    expect(background).toContain('return "provider_service_failed"');
    expect(background).toContain('return "user_config_failed"');
    expect(background).toContain('return "cancelled"');
    expect(background).toContain('outcome_category: summaryOk && segmentsOk ? "success" : "partial_success"');
  });

  it("reports summary success only after a non-empty result", () => {
    expect(background).toMatch(/if \(task !== "summary"\) \{\r?\n\s*await reportFeatureUsage\(task, bvid, settings, aiRes\.metrics\);/);
    expect(background).toMatch(/if \(task === "summary"\)[\s\S]*?if \(!summaryText \|\| shouldDisableDeepSeekV4ThinkingForRetry\(settings, aiRes\)\)[\s\S]*?await reportFeatureUsage\(task, bvid, settings, aiRes\.metrics\);[\s\S]*?return summaryText;/);
  });

  it("records response metadata when a summary is empty", () => {
    expect(background).toContain('logAI.warn("summary_empty_response"');
    expect(background).toContain("finish_reason:");
    expect(background).toContain("content_state:");
    expect(background).toContain("reasoning_chars:");
    expect(background).toContain("raw_response:");
    expect(background).toContain('source: "summary_retry_empty"');
    expect(background).toContain("function isModelScopeStoppedEmptySummary");
    expect(background).toContain('diagnostics.finish_reason.trim().toLowerCase() === "stop"');
    expect(background).toContain('diagnostics.content_state.trim().toLowerCase() === "empty"');
    expect(background).toContain('"总结正文为空，直接切换 ModelScope 备用模型"');
  });

  it("turns off DeepSeek V4 thinking only for a length-truncated reasoning retry", () => {
    expect(background).toContain("function shouldDisableDeepSeekV4ThinkingForRetry");
    expect(background).toContain("if (!isDeepSeekV4ModelName(settings?.model)) return false");
    expect(background).toContain("if (!isOutputLengthFinishReason({ finishReason: diagnostics.finishReason })) return false");
    expect(background).toContain("if (!(diagnostics.reasoningChars > 0)) return false");
    expect(background).toContain("return { ...settings, deepSeekV4ThinkingDisabled: true }");
    expect(background).toContain('strategy: retryStrategy');
    expect(background).toContain('const expandedRetrySettings = buildDeepSeekV4RetrySettings(settings, latestError)');
  });
});
