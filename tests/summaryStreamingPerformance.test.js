import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const background = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const content = readFileSync(new URL("../content.js", import.meta.url), "utf8");
const sidepanel = readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");

describe("summary streaming performance", () => {
  it("keeps high-frequency summary deltas out of the video cache write queue", () => {
    const qualityStart = background.indexOf("async function runSummarySegmentsInQuality");
    const qualityEnd = background.indexOf("async function runSummarySegmentsInEfficiency", qualityStart);
    const qualitySource = background.slice(qualityStart, qualityEnd);
    const streamWriterStart = qualitySource.indexOf("function writeStreamingSummaryPartial");
    const streamWriterEnd = qualitySource.indexOf("function clearStreamingSummaryPartial", streamWriterStart);
    const streamWriter = qualitySource.slice(streamWriterStart, streamWriterEnd);

    expect(streamWriter).toContain('action: "SUMMARY_STREAM_UPDATE"');
    expect(streamWriter).toContain("SUMMARY_DRAFT_PERSIST_INTERVAL_MS");
    expect(streamWriter).toContain("chrome.storage.local.set({ [key]: draft })");
    expect(streamWriter).not.toContain("mergeCacheByBvid");
    expect(qualitySource).not.toContain("partialWritePromise");
  });

  it("handles transient draft storage without running the full cache listener", () => {
    expect(content).toContain("function handleSummaryDraftStorageChanges");
    expect(content).toContain("if (handleSummaryDraftStorageChanges(changes)) return;");
    expect(content).toContain("function renderSummaryStreamOnly");
    expect(content).toContain('action === "SUMMARY_STREAM_UPDATE"');
    expect(content).toContain('action === "SUMMARY_STREAM_CLEAR"');
    expect(content).toContain("const streamDraft = appState.summaryStreamDraft");
    expect(sidepanel).toContain("const streamDraft = state.summaryStreamDraft");
    expect(sidepanel).toContain('action === "SUMMARY_STREAM_UPDATE"');
    expect(sidepanel).toContain('action === "SUMMARY_STREAM_CLEAR"');
  });

  it("queues metrics, usage, and cloud persistence outside the main task result", () => {
    expect(background).toContain('queueBackgroundOperation("cache_metrics"');
    expect(background).toContain('queueBackgroundOperation("usage_report"');
    expect(background).toContain('queueBackgroundOperation("cloud_feature_cache"');
    expect(background).toContain('queueBackgroundOperation("cloud_subtitle_cache"');
    expect(background).not.toContain("await persistCloudFeaturePatch(");
    expect(background).not.toContain("await persistCloudSubtitlePatch(");
  });

  it("publishes the final summary and segments status before background work", () => {
    const taskStart = background.indexOf("async function runSummarySegmentsTasks");
    const taskEnd = background.indexOf("async function runChatForTab", taskStart);
    const taskSource = background.slice(taskStart, taskEnd);
    const finalizeIndex = taskSource.indexOf("await finalizeSummarySegmentsTaskState");
    const cloudIndex = taskSource.indexOf('queueBackgroundOperation("cloud_feature_cache"');

    expect(finalizeIndex).toBeGreaterThan(-1);
    expect(cloudIndex).toBeGreaterThan(finalizeIndex);
    expect(background).toContain("async function finalizeSummarySegmentsTaskState");
    expect(background).toContain('statusMap[task] = "done"');
    expect(background).toContain("await flushTabStateNow(tabId)");
  });
});
