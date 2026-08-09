export const MODELSCOPE_QUOTA_LEDGER_STORAGE_KEY = "modelScopeQuotaLedger";

export function isStrictModelScopeProvider(settings = {}) {
  return String(settings?.provider || "").trim().toLowerCase() === "modelscope";
}

function cleanText(value, maxLength = 200) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanCount(value) {
  if (value === null || value === undefined || value === "") return null;
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : null;
}

export function getShanghaiDateKey(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Number(now) || Date.now()));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function normalizeModelScopeQuotaLedger(raw = {}, now = Date.now()) {
  const date = getShanghaiDateKey(now);
  if (!raw || typeof raw !== "object" || raw.date !== date) {
    return { date, models: {}, user: { limit: null, remaining: null, updatedAt: 0 } };
  }
  const models = raw.models && typeof raw.models === "object" && !Array.isArray(raw.models)
    ? Object.fromEntries(Object.entries(raw.models).map(([model, entry]) => [
        cleanText(model),
        {
          limit: cleanCount(entry?.limit),
          remaining: cleanCount(entry?.remaining),
          unavailable: entry?.unavailable === true,
          reason: cleanText(entry?.reason, 80),
          source: cleanText(entry?.source, 40),
          updatedAt: Math.max(0, Number(entry?.updatedAt || 0) || 0),
        },
      ]).filter(([model]) => model))
    : {};
  return {
    date,
    models,
    user: {
      limit: cleanCount(raw.user?.limit),
      remaining: cleanCount(raw.user?.remaining),
      updatedAt: Math.max(0, Number(raw.user?.updatedAt || 0) || 0),
    },
  };
}

export function updateModelScopeQuotaLedger(raw, model, rateLimitInfo = {}, now = Date.now()) {
  const ledger = normalizeModelScopeQuotaLedger(raw, now);
  const modelName = cleanText(model);
  const updatedAt = Math.max(0, Number(now) || Date.now());
  if (modelName) {
    const previous = ledger.models[modelName] || {};
    ledger.models[modelName] = {
      limit: cleanCount(rateLimitInfo.modelLimit) ?? previous.limit ?? null,
      remaining: cleanCount(rateLimitInfo.modelRemaining) ?? previous.remaining ?? null,
      unavailable: false,
      reason: "",
      source: "response_header",
      updatedAt,
    };
  }
  const userLimit = cleanCount(rateLimitInfo.userLimit);
  const userRemaining = cleanCount(rateLimitInfo.userRemaining);
  if (userLimit !== null || userRemaining !== null) {
    ledger.user = {
      limit: userLimit ?? ledger.user.limit ?? null,
      remaining: userRemaining ?? ledger.user.remaining ?? null,
      updatedAt,
    };
  }
  return ledger;
}

export function markModelScopeModelUnavailable(raw, model, reason = "unavailable", now = Date.now()) {
  const ledger = normalizeModelScopeQuotaLedger(raw, now);
  const modelName = cleanText(model);
  if (!modelName) return ledger;
  const previous = ledger.models[modelName] || {};
  const quotaExhausted = reason === "quota_exhausted";
  ledger.models[modelName] = {
    limit: previous.limit ?? null,
    remaining: quotaExhausted ? 0 : previous.remaining ?? null,
    unavailable: !quotaExhausted,
    reason: cleanText(reason, 80),
    source: "request_error",
    updatedAt: Math.max(0, Number(now) || Date.now()),
  };
  return ledger;
}

function findModelEntry(ledger, model) {
  const target = cleanText(model).toLowerCase();
  if (!target) return null;
  const match = Object.entries(ledger?.models || {}).find(([key]) => key.toLowerCase() === target);
  return match?.[1] || null;
}

export function selectModelScopeFallbackModel({
  currentModel,
  task = "summary",
  availableModels = [],
  fallbackConfig = {},
  ledger: rawLedger = {},
  excludedModels = [],
  now = Date.now(),
} = {}) {
  const ledger = normalizeModelScopeQuotaLedger(rawLedger, now);
  const currentKey = cleanText(currentModel).toLowerCase();
  const excludedKeys = new Set((Array.isArray(excludedModels) ? excludedModels : [])
    .map((model) => cleanText(model).toLowerCase())
    .filter(Boolean));
  const available = [...new Set((Array.isArray(availableModels) ? availableModels : [])
    .map((model) => cleanText(model))
    .filter(Boolean))];
  const availableByKey = new Map(available.map((model) => [model.toLowerCase(), model]));
  const configured = Array.isArray(fallbackConfig?.tasks?.[task])
    ? fallbackConfig.tasks[task]
    : (Array.isArray(fallbackConfig?.tasks?.default) ? fallbackConfig.tasks.default : []);
  const queue = configured.length ? configured : available;
  for (const requestedModel of queue) {
    const requestedKey = cleanText(requestedModel).toLowerCase();
    const model = availableByKey.get(requestedKey);
    if (!model || requestedKey === currentKey || excludedKeys.has(requestedKey)) continue;
    const entry = findModelEntry(ledger, model);
    if (entry?.remaining === 0 || entry?.unavailable === true) continue;
    return model;
  }
  return null;
}

export function classifyModelScopeFallbackError(error, ledger = {}, { currentModel = "" } = {}) {
  const code = cleanText(error?.code, 80).toUpperCase();
  const status = Number(error?.status || 0);
  const message = `${error?.message || ""}\n${error?.responseText || ""}`;
  if (code === "ABORTED" || status === 401 || status === 403 || code === "HTTP_401" || code === "HTTP_403") return null;
  if (["AI_RESPONSE_TIMEOUT", "AI_STREAM_TIMEOUT", "HTTP_5XX"].includes(code) || /^HTTP_5\d\d$/.test(code) || status >= 500) {
    return { eligible: true, reason: status >= 500 || code === "HTTP_5XX" || /^HTTP_5\d\d$/.test(code) ? "provider_5xx" : "timeout" };
  }
  if ([
    "SUMMARY_EMPTY_RESPONSE",
    "SEGMENTS_JSON_PARSE_FAILED",
    "SEGMENTS_INVALID_SCHEMA",
    "SEGMENTS_EMPTY_LIST",
    "SEGMENTS_MISSING_PROTOCOL"
  ].includes(code)) {
    return {
      eligible: true,
      reason: code === "SUMMARY_EMPTY_RESPONSE" ? "summary_empty" : "structured_output_invalid",
    };
  }
  if (code === "MODEL_NOT_FOUND" || code === "INVALID_MODEL_ID" || code === "HTTP_402_MODEL_UNAVAILABLE") {
    return { eligible: true, reason: "model_unavailable", markUnavailable: true };
  }
  if (status === 404 || code === "HTTP_404") {
    return { eligible: true, reason: "model_unavailable", markUnavailable: true };
  }
  if ((status === 400 || code === "HTTP_400")
    && /model.{0,100}(?:not found|does not exist|not available|unsupported|offline|invalid|has no provider supported|no provider supported|不存在|不可用|不支持|已下线|无效)/i.test(message)) {
    return { eligible: true, reason: "model_unavailable", markUnavailable: true };
  }
  if ((status === 429 || code.startsWith("HTTP_429"))
    && /insufficient[_\s-]*(?:balance|quota)|exceeded\s+(?:your\s+)?current\s+quota|current\s+quota.{0,30}(?:exceed|exhaust)|billing\s+details/i.test(message)) {
    return { eligible: true, reason: "quota_exhausted", markQuotaExhausted: true, immediate: true };
  }
  const normalizedLedger = normalizeModelScopeQuotaLedger(ledger);
  const modelRemaining = findModelEntry(normalizedLedger, currentModel)?.remaining ?? null;
  const modelQuotaMessage = /rate\s+limit\s+you\s+for\s+model|model.{0,60}(?:quota|limit|额度|配额).{0,30}(?:exceed|exhaust|used up|用尽|耗尽|不足)|(?:quota|limit|额度|配额).{0,60}model/i.test(message);
  if ((status === 429 || code.startsWith("HTTP_429"))
    && (modelQuotaMessage || modelRemaining === 0)) {
    return { eligible: true, reason: "model_quota_exhausted", markQuotaExhausted: true, immediate: true };
  }
  if (status === 429 || code.startsWith("HTTP_429")) {
    if (code === "HTTP_429_QUEUE_EXCEEDED" || /queue.{0,30}(?:overload|full|limit|busy)|(?:overload|full).{0,30}queue/i.test(message)) {
      return { eligible: true, reason: "queue_overloaded" };
    }
    if (code === "HTTP_429_RATE_LIMIT" || /rate\s*limit|too\s+many\s+requests|请求过于频繁/i.test(message)) {
      return { eligible: true, reason: "rate_limited" };
    }
    return { eligible: true, reason: "unknown_429" };
  }
  return null;
}

export function shouldUseImmediateModelScopeFallback(error) {
  const classification = classifyModelScopeFallbackError(error);
  return classification?.reason === "quota_exhausted"
    || classification?.reason === "model_quota_exhausted"
    || classification?.reason === "model_unavailable";
}
