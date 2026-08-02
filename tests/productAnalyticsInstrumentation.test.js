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
    expect(background).toContain('strategy: "summary_empty_retry"');
    expect(background).toContain('strategy: "local_json_extract"');
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
    expect(background).toContain('provider: String(context?.provider || errorInput?.provider || settings?.provider || "")');
    expect(background).toContain('reason: "provider_auth_failed_metric"');
  });

  it("reports summary success only after a non-empty result", () => {
    expect(background).toContain('if (task !== "summary") {\n        await reportFeatureUsage(task, bvid, settings, aiRes.metrics);');
    expect(background).toMatch(/if \(task === "summary"\)[\s\S]*?if \(!summaryText\)[\s\S]*?await reportFeatureUsage\(task, bvid, settings, aiRes\.metrics\);[\s\S]*?return summaryText;/);
  });

  it("records response metadata when a summary is empty", () => {
    expect(background).toContain('logAI.warn("summary_empty_response"');
    expect(background).toContain("finish_reason:");
    expect(background).toContain("content_state:");
    expect(background).toContain("reasoning_chars:");
    expect(background).toContain("raw_response:");
    expect(background).toContain('source: "summary_retry_empty"');
  });
});
