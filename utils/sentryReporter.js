import { PROVIDERS } from "./providerAdapter.js";

const SENSITIVE_KEY_PATTERN = /(api[_-]?key|authorization|token|secret|password|cookie|prompt|subtitle|content|message|messages|base[_-]?url|download[_-]?url|dsn|url)/i;
const UNFILTERED_RAW_KEYS = new Set([
  "ai_response_raw",
  "ai_provider_response_raw",
  "response_text",
  "provider_response",
  "subtitle_chars",
  "subtitleCount",
  "subtitle_line_count",
  "subtitle_total_chars",
  "video_duration_sec",
  "video_duration_text"
]);
const MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 5;
const IGNORED_ERROR_PATTERNS = [
  /api\s*key/i,
  /请先配置/i,
  /未配置/i,
  /配置.*(缺失|不完整|失败)/i,
  /当前视频暂无字幕/i,
  /无字幕可供分析/i,
  /暂无\s*raw\s*字幕/i,
  /用户取消/i,
  /user\s*cancel/i,
  /已停止生成/i,
  /本次未完成授权/i,
  /未授权访问该自定义\s*api\s*域名/i,
  /缺少自定义\s*api\s*地址/i,
  /自定义\s*provider\s*需要填写\s*base\s*url/i,
  /base\s*url.*(?:格式不正确|必须使用\s*https|invalid)/i,
  /自定义\s*(?:api\s*)?地址必须使用\s*https/i,
  /failed to construct ['"]url['"]:\s*invalid url/i,
  /未获取到视频字幕/i,
  /file_error_no_space/i,
  /resource::kquotabytes quota exceeded/i,
  /a listener indicated an asynchronous response.*message channel closed/i,
  /could not establish connection\. receiving end does not exist/i,
  /sentry\s*dsn/i,
  /ResizeObserver loop completed with undelivered notifications/i
];

const IGNORED_ERROR_CODES = new Set([
  "ABORTED",
  "USER_CANCELLED",
  "CONFIG_REQUIRED",
  "VALIDATION_ERROR",
  "MISSING_API_KEY",
  "MISSING_SUBTITLE",
  "HTTP_401"
]);

export function shouldReportToSentry(errorInput, context = {}) {
  const message = getErrorMessage(errorInput);
  const code = String(errorInput?.code || context?.code || "").trim().toUpperCase();
  const status = Number(errorInput?.status || context?.status || 0);
  if (code === "HTTP_401" || status === 401 || /\b(?:HTTP|API Error)\s*401\b/i.test(message)) return false;
  if (IGNORED_ERROR_CODES.has(code)) return false;
  return !IGNORED_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function parseSentryDsn(dsn) {
  const raw = String(dsn || "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const projectId = url.pathname.split("/").filter(Boolean).pop();
    const publicKey = url.username;
    if (!url.protocol.startsWith("http") || !url.host || !projectId || !publicKey) return null;
    return {
      dsn: raw,
      endpoint: `${url.origin}/api/${encodeURIComponent(projectId)}/envelope/?sentry_key=${encodeURIComponent(publicKey)}&sentry_version=7`,
      projectId,
      publicKey
    };
  } catch (_) {
    return null;
  }
}

export function sanitizeForSentry(value, depth = 0, key = "") {
  const normalizedKey = String(key || "");
  if (UNFILTERED_RAW_KEYS.has(normalizedKey)) return value;
  if (SENSITIVE_KEY_PATTERN.test(normalizedKey)) return "[Filtered]";
  if (value == null) return value;
  if (depth >= MAX_DEPTH) return "[MaxDepth]";
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeForSentry(item, depth + 1, key));
  }
  if (typeof value === "object") {
    const result = {};
    Object.entries(value).slice(0, 50).forEach(([childKey, childValue]) => {
      result[childKey] = sanitizeForSentry(childValue, depth + 1, childKey);
    });
    return result;
  }
  return String(value);
}

export function createSentryEvent(errorInput, context = {}, runtime = {}) {
  const error = normalizeError(errorInput);
  const safeContext = sanitizeForSentry(context);
  const errorMeta = resolveErrorMeta(errorInput, safeContext);
  const extensionVersion = String(runtime.extensionVersion || safeContext.extensionVersion || "").trim();
  const sentryUserId = String(runtime.userId || safeContext.userId || "").trim() || "anonymous";
  const provider = String(safeContext.provider || "").trim();
  const model = String(safeContext.model || "").trim();
  const task = String(safeContext.task || "").trim();
  const taskId = String(safeContext.task_id || safeContext.taskId || "").trim();
  const bvid = String(safeContext.bvid || "").trim();
  const pageType = String(safeContext.pageType || "").trim();

  return {
    event_id: createEventId(),
    timestamp: new Date().toISOString(),
    platform: "javascript",
    level: "error",
    release: extensionVersion ? `bilitato@${extensionVersion}` : undefined,
    environment: String(runtime.environment || "production"),
    tags: removeEmpty({
      extension_version: extensionVersion,
      provider,
      model,
      task,
      task_id: taskId,
      bvid,
      code: errorMeta.code,
      status: errorMeta.status,
      page_type: pageType,
      source: safeContext.source,
      timeout_phase: safeContext.timeout_phase,
      request_stream: typeof safeContext.request_stream === "boolean"
        ? String(safeContext.request_stream)
        : undefined,
      manifest_version: runtime.manifestVersion
    }),
    user: {
      id: sentryUserId
    },
    contexts: {
      runtime: removeEmpty({
        extensionVersion,
        manifestVersion: runtime.manifestVersion,
        language: runtime.language,
        userAgent: runtime.userAgent
      }),
      platform: removeEmpty(runtime.platform || {})
    },
    extra: {
      ...safeContext,
      code: errorMeta.code || safeContext.code,
      status: errorMeta.status || safeContext.status,
      retryAfterSec: errorMeta.retryAfterSec || safeContext.retryAfterSec
    },
    exception: {
      values: [{
        type: error.name || "Error",
        value: error.message || "Unknown error",
        stacktrace: error.stack ? { frames: parseStackFrames(error.stack) } : undefined
      }]
    }
  };
}

export async function reportToSentry(settings, errorInput, context = {}, runtime = {}, fetchImpl = globalThis.fetch) {
  const enabled = !!settings?.sentryEnabled;
  const parsed = parseSentryDsn(settings?.sentryDsn);
  if (!enabled || !parsed || typeof fetchImpl !== "function") {
    return { sent: false, reason: enabled ? "invalid_dsn" : "disabled" };
  }
  if (!shouldReportToSentry(errorInput, context)) {
    return { sent: false, reason: "ignored" };
  }
  const errorDerivedContext = pickErrorContext(errorInput);
  const providerTarget = resolveProviderTargetContext(settings, {
    ...errorDerivedContext,
    ...(context && typeof context === "object" ? context : {})
  });
  const enrichedContext = {
    ...errorDerivedContext,
    ...(context && typeof context === "object" ? context : {}),
    provider: context?.provider || settings?.provider || "",
    model: context?.model || settings?.model || "",
    pref_mode: context?.pref_mode || settings?.prefMode || "",
    custom_protocol: context?.custom_protocol || settings?.customProtocol || "",
    ...providerTarget
  };
  const event = createSentryEvent(errorInput, enrichedContext, runtime);
  const envelope = buildEnvelope(parsed.dsn, event);
  const res = await fetchImpl(parsed.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-sentry-envelope" },
    body: envelope,
    keepalive: true
  });
  return { sent: !!res?.ok, status: Number(res?.status || 0), eventId: event.event_id };
}

function buildEnvelope(dsn, event) {
  return [
    JSON.stringify({ dsn, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event)
  ].join("\n");
}

function normalizeError(errorInput) {
  if (errorInput instanceof Error) {
    const error = new Error(scrubText(errorInput.message || "Unknown error"));
    error.name = errorInput.name || "Error";
    if (errorInput.stack) error.stack = scrubText(errorInput.stack);
    return error;
  }
  if (errorInput && typeof errorInput === "object") {
    const error = new Error(scrubText(errorInput.message || errorInput.error || "Unknown error"));
    error.name = String(errorInput.name || "Error");
    if (errorInput.stack) error.stack = scrubText(errorInput.stack);
    return error;
  }
  return new Error(scrubText(errorInput || "Unknown error"));
}

function resolveErrorMeta(errorInput, context = {}) {
  const status = Number(errorInput?.status || context?.status || 0) || undefined;
  const retryAfterSec = Number(errorInput?.retryAfterSec || context?.retryAfterSec || 0) || undefined;
  const explicitCode = String(errorInput?.code || context?.code || "").trim();
  const inferredCode = explicitCode || inferCodeFromMessage(getErrorMessage(errorInput));
  return {
    code: inferredCode,
    status,
    retryAfterSec
  };
}

function inferCodeFromMessage(message) {
  const text = String(message || "");
  const httpMatch = text.match(/\bHTTP\s+([0-9]{3})\b|API Error\s+([0-9]{3})/i);
  if (httpMatch) {
    const status = Number(httpMatch[1] || httpMatch[2] || 0);
    if (status >= 500) return "HTTP_5XX";
    return status > 0 ? `HTTP_${status}` : "";
  }
  if (/模型长时间没有开始返回内容|stream timeout|first token timeout/i.test(text)) return "AI_STREAM_TIMEOUT";
  if (/模型请求超时|ai request timeout|provider timeout/i.test(text)) return "AI_RESPONSE_TIMEOUT";
  if (/转录请求超时|asr timeout|transcription timeout/i.test(text)) return "ASR_REQUEST_TIMEOUT";
  if (/Groq.*(?:Forbidden|拒绝了当前网络请求)|ASR_GROQ_ACCESS_BLOCKED/i.test(text)) return "ASR_GROQ_ACCESS_BLOCKED";
  if (/无法连接\s*Groq\s*服务器|Groq.*(?:unreachable|connectivity)|ASR_GROQ_UNREACHABLE/i.test(text)) return "ASR_GROQ_UNREACHABLE";
  if (/网络请求超时|request timeout/i.test(text)) return "NETWORK_REQUEST_TIMEOUT";
  if (/timeout|超时/i.test(text)) return "TIMEOUT";
  if (/反馈服务暂时不可用|feedback_(?:select|mark_seen)_unavailable/i.test(text)) return "FEEDBACK_SERVICE_UNAVAILABLE";
  if (/模型服务连接失败|provider network error/i.test(text)) return "PROVIDER_NETWORK_ERROR";
  if (/network|failed to fetch|网络/i.test(text)) return "NETWORK_ERROR";
  if (/JSON\s*解析失败|json_parse|JSON Parse/i.test(text)) return "JSON_PARSE_ERROR";
  if (/限流|rate limit/i.test(text) && /groq|转录/i.test(text)) return "ASR_RATE_LIMIT";
  if (/文件大小超出限制|音频过大|too large/i.test(text)) return "ASR_FILE_TOO_LARGE";
  return "";
}

function getErrorMessage(errorInput) {
  if (errorInput instanceof Error) return String(errorInput.message || "");
  if (errorInput && typeof errorInput === "object") return String(errorInput.message || errorInput.error || "");
  return String(errorInput || "");
}

function scrubText(value) {
  return String(value || "")
    .replace(/(sk|gsk|sk-proj)-[A-Za-z0-9_-]{8,}/g, "$1-[Filtered]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [Filtered]")
    .replace(/https?:\/\/\S+/gi, "[FilteredUrl]");
}

function parseStackFrames(stack) {
  return String(stack || "")
    .split("\n")
    .slice(1, 30)
    .map((line) => ({ function: line.trim() }))
    .reverse();
}

function createEventId() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(0, 32).padEnd(32, "0");
}

function removeEmpty(value) {
  return Object.fromEntries(
    Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== "")
  );
}

function pickErrorContext(errorInput) {
  if (!errorInput || typeof errorInput !== "object") return {};
  return removeEmpty({
    provider: String(errorInput.provider || "").trim(),
    model: String(errorInput.model || "").trim(),
    provider_endpoint: String(errorInput.requestEndpoint || errorInput.provider_endpoint || "").trim(),
    provider_host: String(errorInput.requestHost || errorInput.provider_host || "").trim(),
    provider_api_protocol: String(errorInput.requestProtocol || errorInput.provider_api_protocol || "").trim(),
    is_custom_provider: typeof errorInput.isCustomProvider === "boolean"
      ? errorInput.isCustomProvider
      : errorInput.is_custom_provider,
    request_stream: typeof errorInput.requestStream === "boolean"
      ? errorInput.requestStream
      : errorInput.request_stream,
    request_method: String(errorInput.requestMethod || errorInput.request_method || "").trim(),
    request_entry: String(errorInput.requestEntry || errorInput.request_entry || "").trim(),
    request_phase: String(errorInput.requestPhase || errorInput.request_phase || "").trim(),
    request_attempt: Number(errorInput.requestAttempt || errorInput.request_attempt || 0) || undefined,
    request_max_attempts: Number(errorInput.requestMaxAttempts || errorInput.request_max_attempts || 0) || undefined,
    retry_delays_ms: Array.isArray(errorInput.retryDelaysMs || errorInput.retry_delays_ms)
      ? (errorInput.retryDelaysMs || errorInput.retry_delays_ms)
      : undefined,
    retry_strategy: String(errorInput.retryStrategy || errorInput.retry_strategy || "").trim()
  });
}

function resolveProviderTargetContext(settings = {}, context = {}) {
  const explicitEndpoint = String(context?.provider_endpoint || context?.requestEndpoint || "").trim();
  const explicitHost = String(context?.provider_host || context?.requestHost || "").trim();
  const explicitProtocol = String(context?.provider_api_protocol || context?.requestProtocol || "").trim();
  const explicitCustom = typeof context?.is_custom_provider === "boolean" ? context.is_custom_provider : undefined;
  if (explicitEndpoint || explicitHost || explicitProtocol || explicitCustom !== undefined) {
    return removeEmpty({
      provider_endpoint: explicitEndpoint,
      provider_host: explicitHost,
      provider_api_protocol: explicitProtocol,
      is_custom_provider: explicitCustom
    });
  }

  const providerKey = String(settings?.provider || "").trim().toLowerCase();
  const isCustom = providerKey === "custom";
  const customProtocol = String(settings?.customProtocol || "openai").trim().toLowerCase() === "claude" ? "claude" : "openai";
  const baseUrl = isCustom
    ? String(settings?.customBaseUrl || "").trim()
    : String(PROVIDERS?.[providerKey]?.baseUrl || "").trim();
  return removeEmpty({
    provider_endpoint: baseUrl,
    provider_host: safeHost(baseUrl),
    provider_api_protocol: isCustom ? customProtocol : resolveProviderApiProtocol(providerKey),
    is_custom_provider: isCustom
  });
}

function resolveProviderApiProtocol(providerKey = "") {
  const key = String(providerKey || "").trim().toLowerCase();
  if (key === "claude") return "claude";
  if (key === "gemini") return "google";
  return "openai";
}

function safeHost(url) {
  const text = String(url || "").trim();
  if (!text) return "";
  try {
    return new URL(text).host || "";
  } catch (_) {
    return "";
  }
}
