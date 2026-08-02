import { describe, expect, it } from "vitest";
import {
  buildCompactSegmentsPrompt,
  buildMergedSummarySegmentsPrompt,
  buildPrompt,
  extractFirstProtocolSection,
  extractProtocolSection,
  formatDurationAsClock,
  normalizePromptSettings
} from "../utils/promptBuilder.js";

describe("promptBuilder", () => {
  it("normalizes guided prompt settings", () => {
    expect(normalizePromptSettings({
      mode: "unknown",
      guided: { tone: "casual", detail: "detailed" }
    })).toMatchObject({
      mode: "guided",
      guided: { tone: "casual", detail: "detailed" }
    });
  });

  it("builds a single task prompt with subtitle and duration hard rule", () => {
    const prompt = buildPrompt({
      type: "segments",
      subtitle: "[0:00] 开场",
      guided: { tone: "balanced", detail: "normal" },
      taskContext: { videoDuration: { totalSeconds: 1200, formattedTime: "20:00" } }
    });

    expect(prompt).toContain("【字幕内容】");
    expect(prompt).toContain("[0:00] 开场");
    expect(prompt).toContain("视频总时长 1200 秒");
    expect(prompt).toContain("最后一个章节的 start 必须大于 900 秒");
    expect(prompt).toContain("只输出 JSON 数组");
    expect(prompt).not.toContain("一段精炼的内容概述");
    expect(prompt).not.toContain("输出 3-4 个加粗小标题");
  });

  it("builds merged summary and segments prompt with protocol tags", () => {
    const prompt = buildMergedSummarySegmentsPrompt({
      subtitle: "[0:00] 内容",
      guided: { tone: "professional", detail: "brief" }
    });

    expect(prompt).toContain("<<<SUMMARY_START>>>");
    expect(prompt).toContain("<<<SEGMENTS_START>>>");
    expect(prompt).toContain("【任务1：视频总结】");
    expect(prompt).toContain("【任务1输出风格要求】");
    expect(prompt).toContain("【任务2：视频分段】");
  });

  it("builds compact segment retry prompt without start/end seconds", () => {
    const prompt = buildCompactSegmentsPrompt({
      subtitle: "#0 开场\n#9 结尾",
      taskContext: { videoDuration: { totalSeconds: 560, formattedTime: "09:20" } }
    });

    expect(prompt).toContain("极简格式");
    expect(prompt).toContain("禁止输出 start/end 秒数");
    expect(prompt).toContain("\"start_line\"");
    expect(prompt).toContain("#9 结尾");
    expect(prompt).not.toContain("最后一个章节的 start 必须大于");
  });

  it("asks rumor checks to return timestamp_sec as integer seconds", () => {
    const prompt = buildPrompt({
      type: "rumors",
      subtitle: "[15:27] 关键说法",
      guided: { tone: "balanced", detail: "normal" }
    });

    expect(prompt).toContain("\"timestamp_sec\":秒数整数");
    expect(prompt).toContain("15:27 输出 927");
    expect(prompt).toContain("禁止输出 15:27");
  });

  it("extracts protocol sections", () => {
    const text = "x<<<A>>> hello <<<B>>>y";

    expect(extractProtocolSection(text, "<<<A>>>", "<<<B>>>")).toEqual({
      found: true,
      content: "hello"
    });
    expect(extractFirstProtocolSection(text, [["missing", "nope"], ["<<<A>>>", "<<<B>>>"]])).toEqual({
      found: true,
      content: "hello"
    });
  });

  it("formats durations", () => {
    expect(formatDurationAsClock(59)).toBe("00:59");
    expect(formatDurationAsClock(65)).toBe("01:05");
    expect(formatDurationAsClock(3661)).toBe("01:01:01");
  });
});
