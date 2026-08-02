import { beforeEach, describe, expect, it, vi } from "vitest";
import "../content/contentErrorReporter.js";

const reporter = globalThis.BilitatoContentErrorReporter;

describe("contentErrorReporter", () => {
  beforeEach(() => {
    globalThis.BilitatoAppState = {
      injectBvid: "BV1",
      settings: {
        provider: "deepseek",
        model: "deepseek-chat",
        groqApiKey: "gsk-secret"
      },
      cache: {
        rawSubtitle: [{ text: "字幕" }, { text: "字幕2" }]
      }
    };
  });

  it("builds safe page context", () => {
    const context = reporter.buildPageContext({ task: "summary" });

    expect(context).toMatchObject({
      source: "content",
      pageType: "video",
      bvid: "BV1",
      provider: "deepseek",
      model: "deepseek-chat",
      hasSubtitle: true,
      subtitleCount: 2,
      subtitle_total_chars: 5,
      asrEnabled: true,
      task: "summary"
    });
    expect(context.video_duration_sec).toBeUndefined();
  });

  it("forwards normalized errors to background", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    globalThis.chrome = {
      runtime: { sendMessage }
    };

    await reporter.reportContentError(new Error("boom"), { task: "chat" });

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: "REPORT_ERROR",
      error: expect.objectContaining({ message: "boom" }),
      context: expect.objectContaining({ task: "chat", bvid: "BV1" })
    }));
  });

  it("filters provider authentication failures before forwarding", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    globalThis.chrome = {
      runtime: { sendMessage }
    };
    const error = new Error("API Error 401");
    error.code = "HTTP_401";
    error.status = 401;

    const result = await reporter.reportContentError(error, { task: "summary" });

    expect(result).toMatchObject({ ignored: true });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not forward user configuration errors", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    globalThis.chrome = {
      runtime: { sendMessage }
    };

    const result = await reporter.reportContentError(new Error("请先配置 API Key"), { task: "summary" });

    expect(result).toMatchObject({ ignored: true });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(reporter.shouldReportContentError(new Error("Cannot read properties of undefined"))).toBe(true);
  });

  it("ignores cancellation, configuration, storage, and closed-tab noise", () => {
    const ignored = [
      Object.assign(new Error("已停止生成"), { code: "ABORTED" }),
      new Error("本次未完成授权，可以重新点击授权当前域名"),
      new Error("自定义 API 地址必须使用 https"),
      new Error("Failed to construct 'URL': Invalid URL"),
      new Error("未获取到视频字幕"),
      new Error("IO error: FILE_ERROR_NO_SPACE"),
      new Error("A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received"),
      new Error("Could not establish connection. Receiving end does not exist.")
    ];

    ignored.forEach((error) => {
      expect(reporter.shouldReportContentError(error)).toBe(false);
    });
    expect(reporter.shouldReportContentError(new Error("Network request failed"))).toBe(true);
  });

  it("ignores global errors that clearly come from another extension", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    globalThis.chrome = {
      runtime: {
        sendMessage,
        getURL: () => "moz-extension://bilitato-uuid/"
      }
    };
    const error = new Error("can't access property \"filter\", e.path is undefined");
    error.stack = [
      "blindSilentOpen@moz-extension://another-extension/inject.js:459:26",
      "listener@moz-extension://another-extension/inject.js:488:10"
    ].join("\n");

    const result = await reporter.reportContentError(error, {
      task: "global_error",
      source: "content_window_error"
    });

    expect(result).toMatchObject({ ignored: true });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps global errors when the stack contains Bilitato code", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: true });
    globalThis.chrome = {
      runtime: {
        sendMessage,
        getURL: () => "moz-extension://bilitato-uuid/"
      }
    };
    const error = new Error("Cannot read properties of undefined");
    error.stack = [
      "runTasks@moz-extension://bilitato-uuid/content.js:6112:34",
      "listener@moz-extension://another-extension/inject.js:488:10"
    ].join("\n");

    await reporter.reportContentError(error, {
      task: "global_error",
      source: "content_window_error"
    });

    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("keeps page errors when no third-party extension origin is present", () => {
    globalThis.chrome = {
      runtime: {
        getURL: () => "chrome-extension://bilitato-id/"
      }
    };
    const error = new Error("Page script failed");
    error.stack = "handler@https://www.bilibili.com/video/BV1:1:1";

    expect(reporter.shouldReportContentError(error, {
      task: "global_error",
      source: "content_window_error"
    })).toBe(true);
  });

  it("ignores unattributed global Worker Blob import errors", () => {
    globalThis.chrome = {
      runtime: { getURL: () => "chrome-extension://bilitato-id/" }
    };
    const error = new Error("Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'blob:https://www.bilibili.com/worker' failed to load.");
    error.stack = "normalizeError@chrome-extension://bilitato-id/content/contentErrorReporter.js:40:20";

    expect(reporter.shouldReportContentError(error, {
      task: "global_error",
      source: "content_window_error"
    })).toBe(false);
  });

  it("keeps Worker Blob errors with a Bilitato functional stack", () => {
    globalThis.chrome = {
      runtime: { getURL: () => "chrome-extension://bilitato-id/" }
    };
    const error = new Error("Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at 'blob:https://www.bilibili.com/worker' failed to load.");
    error.stack = "startTranscriptionFromCapsule@chrome-extension://bilitato-id/content.js:6112:34";

    expect(reporter.shouldReportContentError(error, {
      task: "global_error",
      source: "content_window_error"
    })).toBe(true);
  });
});
