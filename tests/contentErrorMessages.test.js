import { describe, expect, it } from "vitest";
import "../content/contentUtils.js";
import "../content/contentErrorMessages.js";

const messages = globalThis.BilitatoContentErrorMessages;

describe("contentErrorMessages", () => {
  it("maps http auth errors to settings guidance", () => {
    const view = messages.mapErrorToView({ code: "HTTP_401", message: "API Error 401" });

    expect(view).toMatchObject({
      title: "API Key 无效",
      action: "goto-setup-guide",
      presentation: "modal"
    });
  });

  it("adds ModelScope account binding guidance and retry for auth errors", () => {
    const view = messages.mapErrorToView(
      { code: "HTTP_401", message: "API Error 401" },
      "请求失败",
      { provider: "modelscope" }
    );
    const html = messages.renderErrorPanel(view, "run-summary");

    expect(view.extraMessage).toContain("ModelScope");
    expect(view.extraMessage).toContain("阿里云");
    expect(view.secondaryAction).toBe("retry");
    expect(html).toContain("请务必确保您的 ModelScope 账号已绑定阿里云");
    expect(html).toContain("修改 API");
    expect(html).toContain("https://modelscope.cn/my/settings/account");
    expect(html).toContain("assets/ui/aliyun.png");
    expect(html).toContain("ModelScope 绑定阿里云账号示意");
    expect(html).toContain('data-action="goto-setup-guide"');
    expect(html).toContain('data-action="run-summary"');
    expect(html).toContain('data-action="go-summary"');
  });

  it("maps retryable errors to panel guidance", () => {
    const view = messages.mapErrorToView({ code: "TIMEOUT", message: "timeout" });

    expect(view).toMatchObject({
      title: "请求超时",
      action: "retry",
      presentation: "panel"
    });
  });

  it("maps invalid custom provider responses to Base URL guidance", () => {
    const view = messages.mapErrorToView({
      code: "PROVIDER_INVALID_RESPONSE",
      message: "模型服务返回了网页内容"
    });

    expect(view).toMatchObject({
      title: "Provider 地址返回的不是 API 数据",
      action: "goto-setup-guide",
      secondaryAction: "retry",
      presentation: "panel"
    });
  });

  it("maps generic 429 and 5xx to panel retry guidance", () => {
    expect(messages.mapErrorToView({ code: "HTTP_429", message: "API Error 429" })).toMatchObject({
      title: "请求太频繁",
      action: "retry",
      presentation: "panel"
    });
    expect(messages.mapErrorToView({ code: "HTTP_5XX", message: "API Error 503" })).toMatchObject({
      title: "模型服务暂时不可用",
      action: "retry",
      presentation: "panel"
    });
  });

  it("refines 402 and 429 provider errors into clearer panel guidance", () => {
    expect(messages.mapErrorToView({
      message: 'API Error 402: {"error":{"message":"Insufficient Balance","code":"invalid_request_error"}}'
    })).toMatchObject({
      code: "HTTP_402_INSUFFICIENT_BALANCE",
      title: "余额或额度已用尽",
      action: "goto-setup-guide",
      secondaryAction: "retry",
      presentation: "panel"
    });
    expect(messages.mapErrorToView({
      message: 'API Error 429: {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}'
    }).code).toBe("HTTP_429_INSUFFICIENT_QUOTA");
    expect(messages.mapErrorToView({
      message: 'API Error 429: {"error":{"code":"queue_exceeded","message":"queue_exceeded"}}'
    }).code).toBe("HTTP_429_QUEUE_EXCEEDED");
    expect(messages.mapErrorToView({
      message: 'API Error 429: {"error":{"message":"Too many requests","type":"limitation"}}'
    }).code).toBe("HTTP_429_RATE_LIMIT");
  });

  it("maps unsupported API user location to provider guidance", () => {
    const view = messages.mapErrorToView({ message: "User location is not supported for the API use." });
    const html = messages.renderErrorPanel(view, "run-summary");

    expect(view).toMatchObject({
      code: "API_LOCATION_UNSUPPORTED",
      title: "当前地区暂不支持",
      action: "goto-setup-guide",
      secondaryAction: "retry",
      presentation: "panel"
    });
    expect(html).toContain("当前用户所在地不支持");
  });

  it("maps unsupported location inside 400 responses before generic bad request", () => {
    const view = messages.mapErrorToView({
      message: 'API Error 400: {"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}'
    });

    expect(view).toMatchObject({
      code: "API_LOCATION_UNSUPPORTED",
      title: "当前地区暂不支持"
    });
  });

  it("maps specific timeout variants to clearer retry guidance", () => {
    expect(messages.mapErrorToView({ code: "AI_RESPONSE_TIMEOUT", message: "模型请求超时，请重试" })).toMatchObject({
      title: "模型请求超时",
      action: "retry",
      secondaryAction: "goto-setup-guide"
    });
    expect(messages.mapErrorToView({ code: "AI_STREAM_TIMEOUT", message: "模型长时间没有开始返回内容，请重试" }).title).toBe("模型迟迟没有开始返回内容");
    expect(messages.mapErrorToView({ code: "ASR_REQUEST_TIMEOUT", message: "转录请求超时，请稍后重试" }).title).toBe("转录请求超时");
    expect(messages.mapErrorToView({ code: "NETWORK_REQUEST_TIMEOUT", message: "网络请求超时，请稍后重试" }).title).toBe("网络请求超时");
  });

  it("maps aliyun real-name verification errors before generic 403", () => {
    const view = messages.mapErrorToView({
      message: 'API Error 403: {"error":{"message":"To use API-Inference, please make sure your associated Aliyun account is real-name verified."}}'
    });
    const html = messages.renderErrorPanel(view, "run-summary");

    expect(view).toMatchObject({
      code: "ALIYUN_REALNAME_REQUIRED",
      title: "阿里云账号未实名",
      action: "goto-setup-guide",
      presentation: "panel"
    });
    expect(view.helper?.type).toBe("modelscope-bind");
    expect(view.secondaryAction).toBe("retry");
    expect(html).toContain("查看实名引导");
    expect(html).toContain("打开 ModelScope 账号设置");
    expect(html).toContain('data-action="run-summary"');
  });

  it("maps missing segment output to a retryable format error", () => {
    const view = messages.mapErrorToView({ message: "分段输出缺失" });
    const html = messages.renderErrorPanel(view, "run-summary");

    expect(view).toMatchObject({
      code: "SEGMENTS_MISSING_PROTOCOL",
      action: "retry",
      presentation: "panel"
    });
    expect(html).toContain("模型漏掉了分段部分");
    expect(html).toContain('data-action="run-summary"');
  });

  it("maps empty segment responses to a model switching hint", () => {
    const view = messages.mapErrorToView({ code: "SEGMENTS_EMPTY_RESPONSE", message: "模型没有返回分段内容" });
    const html = messages.renderErrorPanel(view, "run-summary");

    expect(view).toMatchObject({
      title: "模型没有返回分段内容",
      action: "retry",
      secondaryAction: "goto-setup-guide",
      presentation: "panel"
    });
    expect(html).toContain("切换模型");
    expect(html).toContain('data-action="run-summary"');
    expect(html).toContain('data-action="goto-setup-guide"');
  });

  it("maps long segment inputs to settings guidance", () => {
    const view = messages.mapErrorToView({ message: "context length exceeded" });
    const html = messages.renderErrorPanel(view, "run-summary");

    expect(view).toMatchObject({
      code: "SEGMENTS_CONTEXT_TOO_LONG",
      action: "goto-setup-guide",
      secondaryAction: "retry",
      presentation: "panel"
    });
    expect(html).toContain("字幕内容过长");
    expect(html).toContain('data-action="goto-setup-guide"');
    expect(html).toContain('data-action="run-summary"');
  });

  it("maps segment truncation to a retryable long output hint", () => {
    const view = messages.mapErrorToView({ code: "SEGMENTS_OUTPUT_TRUNCATED" });
    const html = messages.renderErrorPanel(view, "run-summary");

    expect(view.title).toBe("分段输出被截断");
    expect(html).toContain("切换更长输出模型");
    expect(html).toContain('data-action="run-summary"');
  });

  it("maps empty summary responses to model guidance", () => {
    const view = messages.mapErrorToView({ message: "总结生成为空" });
    const html = messages.renderErrorPanel(view, "run-summary");

    expect(view).toMatchObject({
      code: "SUMMARY_EMPTY_RESPONSE",
      action: "retry",
      secondaryAction: "goto-setup-guide",
      presentation: "panel"
    });
    expect(html).toContain("模型没有返回总结内容");
    expect(html).toContain('data-action="run-summary"');
  });

  it("keeps generic JSON errors separate from task-specific errors", () => {
    expect(messages.mapErrorToView({ message: "验真 JSON 解析失败" }).code).toBe("RUMORS_JSON_PARSE_FAILED");
    expect(messages.mapErrorToView({ message: "分段 JSON 解析失败" }).code).toBe("SEGMENTS_JSON_PARSE_FAILED");
  });

  it("adds retry to non-toast setting-style errors", () => {
    const view = messages.mapErrorToView({ code: "HTTP_404", message: "not found" });
    const html = messages.renderErrorPanel(view, "run-summary");

    expect(view.secondaryAction).toBe("retry");
    expect(html).toContain('data-action="goto-setup-guide"');
    expect(html).toContain('data-action="run-summary"');
  });

  it("maps invalid model 400 errors to panel guidance with retry", () => {
    const view = messages.mapErrorToView({ message: 'API Error 400: {"error":{"message":"Invalid model id: GLM-5.1"}}' });
    const html = messages.renderErrorPanel(view, "run-summary");

    expect(view).toMatchObject({
      code: "INVALID_MODEL_ID",
      title: "模型 ID 不可用",
      action: "goto-setup-guide",
      secondaryAction: "retry",
      presentation: "panel"
    });
    expect(html).toContain("模型 ID");
    expect(html).toContain('data-action="goto-setup-guide"');
    expect(html).toContain('data-action="run-summary"');
  });

  it("maps model-private 403 errors to model-access guidance", () => {
    const view = messages.mapErrorToView({ message: 'API Error 403: {"error":{"message":"Model is private. You can not access it"}}' });

    expect(view).toMatchObject({
      code: "MODEL_ACCESS_DENIED",
      title: "模型没有访问权限",
      action: "goto-setup-guide",
      presentation: "panel"
    });
  });

  it("maps transcription forbidden errors to asr guidance", () => {
    const view = messages.mapErrorToView({ message: "Groq 转录失败（403）：Illegal operation" });

    expect(view).toMatchObject({
      code: "ASR_FORBIDDEN",
      title: "当前转录服务不可用",
      action: "goto-setup-guide",
      presentation: "panel"
    });
  });

  it("maps Groq connectivity failures to retryable asr guidance", () => {
    const view = messages.mapErrorToView({
      code: "ASR_GROQ_UNREACHABLE",
      message: "无法连接 Groq 服务器，请检查设备是否能正常访问国际互联网。"
    });
    const html = messages.renderErrorPanel(view, "transcription-start");

    expect(view).toMatchObject({
      code: "ASR_GROQ_UNREACHABLE",
      title: "无法连接 Groq 服务器",
      action: "retry",
      presentation: "panel"
    });
    expect(html).toContain("请检查设备是否能正常访问国际互联网");
    expect(html).toContain('data-action="transcription-start"');
  });

  it("maps Groq forbidden preflight responses to network access guidance", () => {
    const view = messages.mapErrorToView({
      code: "ASR_GROQ_ACCESS_BLOCKED",
      message: "Groq 服务器拒绝了当前网络请求（Forbidden），请检查代理或设备是否能正常访问国际互联网后重试。"
    });
    const html = messages.renderErrorPanel(view, "transcription-start");

    expect(view).toMatchObject({
      code: "ASR_GROQ_ACCESS_BLOCKED",
      title: "Groq 拒绝了当前网络请求",
      action: "retry",
      secondaryAction: "goto-setup-guide",
      presentation: "panel"
    });
    expect(html).toContain("Groq 返回 Forbidden");
    expect(html).toContain('data-action="transcription-start"');
    expect(html).toContain('data-action="goto-setup-guide"');
  });

  it("maps API key failures inside 400 responses to auth guidance", () => {
    const view = messages.mapErrorToView({ message: 'API Error 400: {"error":{"message":"Invalid API key"}}' });
    const html = messages.renderErrorPanel(view, "run-summary");

    expect(view).toMatchObject({
      code: "HTTP_401",
      title: "API Key 无效",
      action: "goto-setup-guide"
    });
    expect(html).toContain("API Key 无效");
    expect(html).toContain('data-action="goto-setup-guide"');
  });

  it("keeps unknown errors retryable when rendered in a task panel", () => {
    const view = messages.mapErrorToView(
      { message: "context is not defined" },
      "任务失败",
      { surface: "panel" }
    );
    const html = messages.renderErrorPanel(view, "run-rumors");

    expect(view).toMatchObject({
      code: "UNKNOWN",
      presentation: "panel",
      secondaryAction: "retry"
    });
    expect(html).toContain("context is not defined");
    expect(html).toContain('data-action="run-rumors"');
  });

  it("maps missing subtitles to refresh guidance", () => {
    const view = messages.mapErrorToView({ message: "未获取到视频字幕" });
    const html = messages.renderErrorPanel(view, "run-summary");

    expect(view).toMatchObject({
      code: "SUBTITLE_MISSING",
      title: "请求失败",
      action: "refresh-page",
      presentation: "panel"
    });
    expect(html).toContain("未获取到视频字幕");
    expect(html).toContain('data-action="refresh-page"');
  });

  it("infers http code from raw message", () => {
    expect(messages.inferErrorCode("API Error 503: down")).toBe("HTTP_5XX");
  });

  it("renders error panel with retry action", () => {
    const html = messages.renderErrorPanel(messages.mapErrorToView({ code: "TIMEOUT" }), "run-summary");

    expect(html).toContain("请求超时");
    expect(html).toContain('data-action="run-summary"');
  });

  it("upgrades generic HTTP_403 codes when message is more specific", () => {
    const view = messages.mapErrorToView({
      code: "HTTP_403",
      message: 'API Error 403: {"error":{"message":"To use API-Inference, please make sure your associated Aliyun account is real-name verified."}}'
    });

    expect(view.code).toBe("ALIYUN_REALNAME_REQUIRED");
  });

  it("upgrades generic HTTP_400 codes when message says invalid model", () => {
    const view = messages.mapErrorToView({
      code: "HTTP_400",
      message: 'API Error 400: {"error":{"message":"Invalid model id: GLM-5.1"}}'
    });

    expect(view.code).toBe("INVALID_MODEL_ID");
  });

  it("upgrades generic network and parse codes when message is more specific", () => {
    expect(messages.mapErrorToView({
      code: "NETWORK_ERROR",
      message: "provider network error: failed to fetch"
    }).code).toBe("PROVIDER_NETWORK_ERROR");
    expect(messages.mapErrorToView({
      code: "JSON_PARSE_ERROR",
      message: "验真 JSON 解析失败"
    }).code).toBe("RUMORS_JSON_PARSE_FAILED");
    expect(messages.mapErrorToView({
      code: "TIMEOUT",
      message: "模型请求超时，请重试"
    }).code).toBe("AI_RESPONSE_TIMEOUT");
  });

  it("falls back retry buttons to refresh when no task retry action is provided", () => {
    const html = messages.renderErrorPanel(messages.mapErrorToView({ code: "TIMEOUT" }));

    expect(html).toContain('data-action="refresh-page"');
  });
});
