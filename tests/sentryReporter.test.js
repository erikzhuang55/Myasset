import { describe, expect, it, vi } from "vitest";
import {
  createSentryEvent,
  parseSentryDsn,
  reportToSentry,
  sanitizeForSentry,
  shouldReportToSentry
} from "../utils/sentryReporter.js";

describe("sentryReporter", () => {
  it("filters provider authentication failures from Sentry", () => {
    expect(shouldReportToSentry(Object.assign(new Error("API Error 401"), {
      code: "HTTP_401",
      status: 401
    }))).toBe(false);
    expect(shouldReportToSentry(new Error("API Error 401: unauthorized"))).toBe(false);
  });

  it("parses sentry dsn into envelope endpoint", () => {
    const parsed = parseSentryDsn("https://public123@example.ingest.sentry.io/456");

    expect(parsed.endpoint).toBe("https://example.ingest.sentry.io/api/456/envelope/?sentry_key=public123&sentry_version=7");
  });

  it("filters sensitive fields before sending", () => {
    const sanitized = sanitizeForSentry({
      apiKey: "sk-secret",
      groqApiKey: "gsk-secret",
      prompt: "完整 Prompt",
      subtitle: "完整字幕",
      customBaseUrl: "https://api.example.com/v1",
      bvid: "BV1"
    });

    expect(sanitized).toMatchObject({
      apiKey: "[Filtered]",
      groqApiKey: "[Filtered]",
      prompt: "[Filtered]",
      subtitle: "[Filtered]",
      customBaseUrl: "[Filtered]",
      bvid: "BV1"
    });
  });

  it("keeps raw ai response when explicitly allowed", () => {
    const rawText = "模型原始返回 {" + "x".repeat(1200) + "}";
    const providerRaw = JSON.stringify({ choices: [{ message: { content: rawText } }] });
    const sanitized = sanitizeForSentry({
      ai_response_raw: rawText,
      ai_provider_response_raw: providerRaw,
      prompt: "完整 Prompt"
    });

    expect(sanitized.ai_response_raw).toBe(rawText);
    expect(sanitized.ai_provider_response_raw).toBe(providerRaw);
    expect(sanitized.prompt).toBe("[Filtered]");

    const event = createSentryEvent(new Error("分段格式解析失败"), {
      task: "segments",
      ai_response_raw: rawText,
      ai_provider_response_raw: providerRaw,
      ai_response_attempts: [{
        attempt: 1,
        response_text: rawText,
        provider_response: providerRaw
      }]
    });
    expect(event.extra.ai_response_raw).toBe(rawText);
    expect(event.extra.ai_provider_response_raw).toBe(providerRaw);
    expect(event.extra.ai_response_attempts[0].response_text).toBe(rawText);
    expect(event.extra.ai_response_attempts[0].provider_response).toBe(providerRaw);
  });

  it("keeps subtitle and duration stats while still filtering subtitle text", () => {
    const sanitized = sanitizeForSentry({
      subtitle: "完整字幕",
      subtitle_total_chars: 12345,
      subtitle_line_count: 321,
      video_duration_sec: 987
    });

    expect(sanitized.subtitle).toBe("[Filtered]");
    expect(sanitized.subtitle_total_chars).toBe(12345);
    expect(sanitized.subtitle_line_count).toBe(321);
    expect(sanitized.video_duration_sec).toBe(987);
  });

  it("keeps useful runtime environment fields", () => {
    const event = createSentryEvent(new Error("boom"), {
      task: "summary",
      task_id: "summary_task_123",
      provider: "deepseek",
      model: "deepseek-chat",
      bvid: "BV1",
      code: "HTTP_401",
      status: 401,
      pageType: "video"
    }, {
      extensionVersion: "1.0.0",
      manifestVersion: 3,
      language: "zh-CN",
      userAgent: "Chrome Test",
      platform: { os: "win", arch: "x86-64" }
    });

    expect(event.release).toBe("bilitato@1.0.0");
    expect(event.tags).toMatchObject({
      task: "summary",
      provider: "deepseek",
      model: "deepseek-chat",
      bvid: "BV1",
      code: "HTTP_401",
      status: 401,
      page_type: "video",
      extension_version: "1.0.0"
    });
    expect(event.extra).toMatchObject({
      code: "HTTP_401",
      status: 401
    });
    expect(event.contexts.runtime.userAgent).toBe("Chrome Test");
    expect(event.contexts.platform.os).toBe("win");
  });

  it("tags timeout phase and stream mode while keeping timing values in extra", () => {
    const event = createSentryEvent(new Error("模型长时间没有开始返回内容，请重试"), {
      task: "summary",
      task_id: "summary_task_123",
      provider: "custom",
      model: "LongCat-2.0",
      timeout_phase: "first_response",
      request_stream: true,
      queue_wait_ms: 2300,
      provider_request_ms: 60012,
      first_response_ms: undefined,
      timeout_ms: 60000
    }, {
      extensionVersion: "1.5.2"
    });

    expect(event.tags).toMatchObject({
      timeout_phase: "first_response",
      request_stream: "true",
      extension_version: "1.5.2"
    });
    expect(event.extra).toMatchObject({
      queue_wait_ms: 2300,
      provider_request_ms: 60012,
      timeout_ms: 60000
    });
    expect(event.tags).not.toHaveProperty("queue_wait_ms");
    expect(event.tags).not.toHaveProperty("provider_request_ms");
  });

  it("fills provider and model from settings when context is missing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await reportToSentry(
      {
        sentryEnabled: true,
        sentryDsn: "https://public123@example.ingest.sentry.io/456",
        provider: "deepseek",
        model: "deepseek-chat"
      },
      new Error("boom"),
      { task: "summary" },
      { extensionVersion: "1.0.0" },
      fetchImpl
    );

    const [, options] = fetchImpl.mock.calls[0];
    expect(options.body).toContain('"provider":"deepseek"');
    expect(options.body).toContain('"model":"deepseek-chat"');
  });

  it("includes provider target and mode context from settings", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await reportToSentry(
      {
        sentryEnabled: true,
        sentryDsn: "https://public123@example.ingest.sentry.io/456",
        provider: "custom",
        model: "deepseek-chat",
        customBaseUrl: "https://api.example.com/v1",
        customProtocol: "claude",
        prefMode: "efficiency"
      },
      new Error("boom"),
      { task: "summary" },
      { extensionVersion: "1.0.0" },
      fetchImpl
    );

    const [, options] = fetchImpl.mock.calls[0];
    expect(options.body).toContain('"provider_host":"api.example.com"');
    expect(options.body).toContain('"provider_api_protocol":"claude"');
    expect(options.body).toContain('"pref_mode":"efficiency"');
  });

  it("keeps provider request location from error metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const error = new Error("模型服务连接失败，请稍后重试");
    error.code = "PROVIDER_NETWORK_ERROR";
    error.provider = "deepseek";
    error.model = "deepseek-chat";
    error.requestEndpoint = "https://api.deepseek.com/chat/completions";
    error.requestHost = "api.deepseek.com";
    error.requestProtocol = "openai";
    error.requestStream = true;
    error.requestMethod = "POST";
    error.requestEntry = "callAIStream";
    error.requestPhase = "initial_fetch";

    await reportToSentry(
      {
        sentryEnabled: true,
        sentryDsn: "https://public123@example.ingest.sentry.io/456"
      },
      error,
      { task: "summary" },
      { extensionVersion: "1.0.0" },
      fetchImpl
    );

    const [, options] = fetchImpl.mock.calls[0];
    expect(options.body).toContain('"request_entry":"callAIStream"');
    expect(options.body).toContain('"request_phase":"initial_fetch"');
    expect(options.body).toContain('"provider_host":"api.deepseek.com"');
  });

  it("includes retry metadata from provider request errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const error = new Error("模型服务连接失败，请稍后重试");
    error.code = "PROVIDER_NETWORK_ERROR";
    error.requestEntry = "callAI";
    error.requestPhase = "initial_fetch";
    error.requestAttempt = 3;
    error.requestMaxAttempts = 3;
    error.retryDelaysMs = [700, 1600];
    error.retryStrategy = "provider_network_backoff";

    await reportToSentry(
      {
        sentryEnabled: true,
        sentryDsn: "https://public123@example.ingest.sentry.io/456"
      },
      error,
      { task: "summary" },
      { extensionVersion: "1.0.0" },
      fetchImpl
    );

    const [, options] = fetchImpl.mock.calls[0];
    expect(options.body).toContain('"request_attempt":3');
    expect(options.body).toContain('"request_max_attempts":3');
    expect(options.body).toContain('"retry_strategy":"provider_network_backoff"');
  });

  it("promotes error code and retry metadata from error objects", () => {
    const error = new Error("Groq 限流，请稍后重试");
    error.code = "ASR_RATE_LIMIT";
    error.status = 429;
    error.retryAfterSec = 9;

    const event = createSentryEvent(error, { task: "asr" }, {});

    expect(event.tags).toMatchObject({
      code: "ASR_RATE_LIMIT",
      status: 429,
      task: "asr"
    });
    expect(event.extra.retryAfterSec).toBe(9);
  });

  it("does not send when disabled or dsn is invalid", async () => {
    const fetchImpl = vi.fn();

    expect(await reportToSentry({ sentryEnabled: false, sentryDsn: "" }, new Error("boom"), {}, {}, fetchImpl)).toMatchObject({
      sent: false,
      reason: "disabled"
    });
    expect(await reportToSentry({ sentryEnabled: true, sentryDsn: "bad" }, new Error("boom"), {}, {}, fetchImpl)).toMatchObject({
      sent: false,
      reason: "invalid_dsn"
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ignores user configuration and validation errors", async () => {
    const fetchImpl = vi.fn();

    expect(shouldReportToSentry(new Error("请先配置 API Key"))).toBe(false);
    expect(shouldReportToSentry(new Error("当前视频暂无字幕，无法生成总结"))).toBe(false);
    expect(shouldReportToSentry({ message: "用户取消授权", code: "USER_CANCELLED" })).toBe(false);
    expect(shouldReportToSentry({ message: "已停止生成", code: "ABORTED" })).toBe(false);
    expect(shouldReportToSentry(new Error("自定义 API 地址必须使用 https"))).toBe(false);
    expect(shouldReportToSentry(new Error("Failed to construct 'URL': Invalid URL"))).toBe(false);
    expect(shouldReportToSentry(new Error("未获取到视频字幕"))).toBe(false);
    expect(shouldReportToSentry(new Error("IO error: FILE_ERROR_NO_SPACE"))).toBe(false);
    expect(shouldReportToSentry(new Error("A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received"))).toBe(false);
    expect(shouldReportToSentry(new Error("Could not establish connection. Receiving end does not exist."))).toBe(false);
    expect(shouldReportToSentry({ message: "Groq 网络不可达", code: "ASR_GROQ_ACCESS_BLOCKED" })).toBe(false);
    expect(shouldReportToSentry({ message: "请求频率超限", code: "HTTP_429", status: 429 })).toBe(true);
    expect(shouldReportToSentry({ message: "Invalid model id: retired-model", code: "INVALID_MODEL_ID", status: 400 })).toBe(true);
    expect(shouldReportToSentry({ message: "model not found", code: "HTTP_404", status: 404 })).toBe(true);
    expect(shouldReportToSentry(new Error("Cannot read properties of undefined"))).toBe(true);

    const result = await reportToSentry(
      { sentryEnabled: true, sentryDsn: "https://public123@example.ingest.sentry.io/456" },
      new Error("请先配置 API Key"),
      {},
      {},
      fetchImpl
    );

    expect(result).toMatchObject({ sent: false, reason: "ignored" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("splits final 429 issues by normalized failure reason", () => {
    const quotaEvent = createSentryEvent({
      message: "API Error 429: insufficient_balance",
      code: "HTTP_429",
      status: 429,
    }, { task: "summary_segments_merged", provider: "modelscope" });
    const rateLimitEvent = createSentryEvent({
      message: "API Error 429: too many requests",
      code: "HTTP_429",
      status: 429,
    }, { task: "summary_segments_merged", provider: "modelscope" });

    expect(quotaEvent.fingerprint).toEqual([
      "bilitato-429",
      "summary_segments_merged",
      "modelscope",
      "quota_exhausted",
    ]);
    expect(quotaEvent.tags.failure_reason).toBe("quota_exhausted");
    expect(rateLimitEvent.fingerprint.at(-1)).toBe("rate_limited");
  });

  it("sends sentry envelope when enabled", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await reportToSentry(
      { sentryEnabled: true, sentryDsn: "https://public123@example.ingest.sentry.io/456" },
      new Error("provider failed with sk-1234567890 https://secret.example/path"),
      { task: "chat", apiKey: "sk-secret" },
      { extensionVersion: "1.0.0" },
      fetchImpl
    );

    expect(result.sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, options] = fetchImpl.mock.calls[0];
    expect(options.body).toContain("chat");
    expect(options.body).toContain("[Filtered]");
    expect(options.body).not.toContain("sk-secret");
    expect(options.body).not.toContain("secret.example");
  });
});
