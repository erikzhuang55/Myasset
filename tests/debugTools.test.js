import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const content = readFileSync(new URL("../content.js", import.meta.url), "utf8");

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
