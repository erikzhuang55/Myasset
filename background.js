import SubtitleProcessor from "./utils/subtitleProcessor.js";
import { robustJSONParse } from "./utils/jsonParse.js";
import { callAI, callAIStream, PROVIDERS, resolveProviderScopedModel } from "./utils/providerAdapter.js";
import {
    DEFAULT_REMOTE_CONFIG,
    isRemoteConfigCacheFresh,
    buildEffectiveProviderCatalog,
    isRemoteFeatureEnabled,
    normalizeRemoteConfigRow
} from "./utils/remoteConfig.js";
import {
    MODELSCOPE_QUOTA_LEDGER_STORAGE_KEY,
    classifyModelScopeFallbackError,
    markModelScopeModelUnavailable,
    normalizeModelScopeQuotaLedger,
    selectModelScopeFallbackModel,
    updateModelScopeQuotaLedger,
    shouldUseImmediateModelScopeFallback,
    isStrictModelScopeProvider
} from "./utils/modelScopeFallback.js";
import {
    MAX_SEGMENTS_REPAIR_INPUT_CHARS,
    buildSegmentsAIRepairPrompt,
    shouldAttemptSegmentsAIRepair
} from "./utils/segmentsRepair.js";
import {
    buildGroqQuotaLine,
    buildGroqTranscriptionPrompt,
    parseGroqQuotaHeaders,
    parseRetryAfterSeconds
} from "./utils/asrTranscription.js";
import {
    DEFAULT_GROQ_BASE_URL,
    buildAsrEndpoint,
    ensureHttpsUrlPrefix,
    normalizeAsrBaseUrl
} from "./utils/asrEndpoints.js";
import {
    DEFAULT_ASR_CHUNK_OVERLAP_SECONDS,
    mergeTimestampedChunkRows
} from "./utils/asrChunking.js";
import { getAsrAudioCandidateUrls } from "./utils/asrAudioCandidates.js";
import {
    MIMO_ASR_MODEL
} from "./utils/mimoAsr.js";
import {
    DEFAULT_PROMPT_SETTINGS,
    buildCompactSegmentsPrompt,
    buildMergedSummarySegmentsPrompt,
    buildPrompt,
    extractFirstProtocolSection,
    extractProtocolSection,
    normalizePromptSettings
} from "./utils/promptBuilder.js";
import { normalizeRumors as normalizeRumorsResult, normalizeSegments as normalizeSegmentsResult } from "./utils/resultNormalize.js";
import { reportToSentry } from "./utils/sentryReporter.js";
import { createAppError, createHttpError, serializeAppError } from "./utils/appError.js";
import { isSupabaseEnabled, supabaseRpc, supabaseSelect, supabaseWrite } from "./utils/supabaseClient.js";
import { reportUsageEvent } from "./utils/usageEvents.js";
import { createProviderRequestTiming } from "./utils/providerRequestTiming.js";
import {
    classifyProvider429Error,
    resolveProviderRetryAfterMs,
    runWithProvider429Backoff
} from "./utils/provider429Retry.js";
import "./logger.js";

let IS_DEBUG_MODE = false;
const cacheWriteLocks = new Map();
const taskStateWriteLocks = new Map();
const TIMEOUT_ERROR_CODES = new Set([
    "TIMEOUT",
    "AI_RESPONSE_TIMEOUT",
    "AI_STREAM_TIMEOUT",
    "ASR_REQUEST_TIMEOUT",
    "NETWORK_REQUEST_TIMEOUT"
]);
const STREAM_INITIAL_RETRY_DELAY_MS = 700;
const ASR_PAGE_FETCH_CHUNK_BYTES = 2 * 1024 * 1024;
const ASR_PAGE_FETCH_MAX_CHUNKS = 512;
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const FIREFOX_OFFSCREEN_IFRAME_ID = "bilitato-firefox-offscreen-document";
let offscreenDocumentPromise = null;
let firefoxActionClickRegistered = false;
const MAX_ASR_BOUNDARY_DIAGNOSTICS = 8;
const USAGE_EVENT_SESSION_ID = createUsageEventSessionId();
const VERSION_CHECK_STORAGE_KEY = "latestVersionState";
const VERSION_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const SEGMENTS_REPAIR_SOURCE = Symbol("segmentsRepairSource");
const capturedSentryTaskIds = new Set();

function syncRuntimeDebugFlag(enabled) {
    IS_DEBUG_MODE = !!enabled;
    globalThis.AIPluginLogger?.setDebugEnabled?.(!!enabled);
}

async function captureBackgroundError(errorInput, context = {}) {
    try {
        if (errorInput?.__sentryCaptured) return { sent: false, reason: "already_captured" };
        const mergedContext = {
            ...(errorInput?.sentryContext && typeof errorInput.sentryContext === "object" ? errorInput.sentryContext : {}),
            ...(context && typeof context === "object" ? context : {})
        };
        const taskId = String(mergedContext?.task_id || mergedContext?.taskId || "").trim();
        if (taskId && capturedSentryTaskIds.has(taskId)) return { sent: false, reason: "task_already_captured" };
        if (!await hasTechnicalDataConsent()) {
            return { sent: false, reason: "technical_data_permission_denied" };
        }
        const settings = await getResolvedSettings();
        const errorCode = String(errorInput?.code || mergedContext?.code || "").trim().toUpperCase();
        const errorStatus = Number(errorInput?.status || mergedContext?.status || 0);
        const errorMessage = String(errorInput?.message || errorInput || "");
        if (taskId) {
            capturedSentryTaskIds.add(taskId);
            if (capturedSentryTaskIds.size > 500) {
                capturedSentryTaskIds.delete(capturedSentryTaskIds.values().next().value);
            }
        }
        if (errorInput && typeof errorInput === "object") errorInput.__sentryCaptured = true;
        if (errorCode === "HTTP_401" || errorStatus === 401 || /\b(?:HTTP|API Error)\s*401\b/i.test(errorMessage)) {
            await reportClientUsageEvent({
                eventName: "provider_auth_failed",
                featureName: String(mergedContext?.task || "provider"),
                status: "failed",
                errorCode: "HTTP_401",
                provider: String(mergedContext?.provider || errorInput?.provider || settings?.provider || ""),
                model: String(mergedContext?.model || errorInput?.model || settings?.model || ""),
                bvid: String(mergedContext?.bvid || ""),
                tabId: Number(mergedContext?.tabId || 0) || undefined,
                metadata: { source: String(mergedContext?.source || "provider_request") }
            }, settings);
            return { sent: false, reason: "provider_auth_failed_metric" };
        }
        const runtime = await getSentryRuntimeContext();
        return await reportToSentry(settings, errorInput, mergedContext, runtime);
    } catch (_) {
        return { sent: false, reason: "report_failed" };
    }
}

function attachSentryContext(errorInput, context = {}) {
    if (!errorInput || typeof errorInput !== "object") return errorInput;
    const repairSource = context?.[SEGMENTS_REPAIR_SOURCE];
    if (repairSource) {
        Object.defineProperty(errorInput, SEGMENTS_REPAIR_SOURCE, {
            value: repairSource,
            configurable: true,
            writable: true
        });
    }
    errorInput.sentryContext = {
        ...(errorInput.sentryContext && typeof errorInput.sentryContext === "object" ? errorInput.sentryContext : {}),
        ...(context && typeof context === "object" ? context : {})
    };
    return errorInput;
}

async function captureTaskFailureToSentry(errorInput, context = {}) {
    if (!errorInput || typeof errorInput !== "object") return { sent: false, reason: "invalid_error" };
    const baseContext = {
        ...(errorInput.sentryContext && typeof errorInput.sentryContext === "object" ? errorInput.sentryContext : {}),
        ...(context && typeof context === "object" ? context : {})
    };
    const failureContext = buildSegmentsFailureSentrySummary(errorInput, baseContext);
    const mergedContext = await enrichTaskFailureContext(failureContext);
    return captureBackgroundError(errorInput, mergedContext);
}

function isTimeoutError(errorInput) {
    const code = String(errorInput?.code || "").trim();
    return TIMEOUT_ERROR_CODES.has(code);
}

function buildAIResponseSentryContext({
    task,
    bvid,
    provider,
    model,
    mode,
    source,
    responseText,
    responseMeta,
    metrics,
    extra = {}
} = {}) {
    if (String(task || "") === "segments") {
        const responseValue = String(responseText || "");
        const trimmedValue = responseValue.trim();
        const isNormalizeFailure = String(source || "").includes("normalize");
        const isMissingProtocol = String(source || "").includes("missing");
        const parsedItemCount = Number(extra?.parsed_item_count || 0) || 0;
        const contextExtra = extra && typeof extra === "object" ? { ...extra } : {};
        delete contextExtra.parsed_item_count;
        const responseTextSnapshot = truncateSentryResponseText(responseValue, 8000, 4000);
        const providerResponseSnapshot = !trimmedValue
            ? truncateSentryResponseText(String(responseMeta?.rawResponse || ""), 5000, 3000)
            : { text: "", truncated: false };
        const result = {
            task: "segments",
            bvid: String(bvid || ""),
            provider: String(provider || ""),
            model: String(model || ""),
            ai_response_mode: String(mode || ""),
            ai_response_attempts: [{
                attempt: 1,
                strategy: resolveSegmentsAttemptStrategy(source, mode),
                finish_reason: String(responseMeta?.finishReason || ""),
                content_state: String(responseMeta?.contentState || (trimmedValue ? "text" : "empty")),
                output_tokens: Number(metrics?.outputTokens || 0) || 0,
                response_chars: responseValue.length,
                reasoning_chars: Number(responseMeta?.reasoningChars || 0) || 0,
                parse_result: isNormalizeFailure ? "valid_json" : (trimmedValue && !isMissingProtocol ? "invalid_json" : "not_run"),
                normalize_result: isNormalizeFailure
                    ? (parsedItemCount === 0 ? "empty_list" : "invalid_schema")
                    : "not_run",
                parsed_item_count: isNormalizeFailure ? parsedItemCount : undefined,
                valid_segment_count: isNormalizeFailure ? 0 : undefined,
                response_text_truncated: responseTextSnapshot.truncated,
                response_text: responseTextSnapshot.text,
                provider_response_truncated: providerResponseSnapshot.text ? providerResponseSnapshot.truncated : undefined,
                provider_response: providerResponseSnapshot.text || undefined
            }],
            ...contextExtra
        };
        if (responseValue && responseValue.length <= MAX_SEGMENTS_REPAIR_INPUT_CHARS) {
            Object.defineProperty(result, SEGMENTS_REPAIR_SOURCE, { value: responseValue });
        }
        return result;
    }
    return {
        task: String(task || ""),
        bvid: String(bvid || ""),
        provider: String(provider || ""),
        model: String(model || ""),
        source: String(source || "ai_parse_failure"),
        ai_response_mode: String(mode || ""),
        ai_response_raw: String(responseText || ""),
        ai_provider_response_raw: String(responseMeta?.rawResponse || ""),
        ai_response_content_state: String(responseMeta?.contentState || ""),
        ai_response_finish_reason: String(responseMeta?.finishReason || ""),
        ai_response_choice_count: Number(responseMeta?.choiceCount || 0) || 0,
        ai_response_reasoning_chars: Number(responseMeta?.reasoningChars || 0) || 0,
        ...getSegmentsResponseDiagnostics(responseText, metrics),
        ...(extra && typeof extra === "object" ? extra : {})
    };
}

function truncateSentryResponseText(value, headChars, tailChars) {
    const text = String(value || "");
    const maxChars = Math.max(0, Number(headChars || 0) + Number(tailChars || 0));
    if (!maxChars || text.length <= maxChars) return { text, truncated: false };
    return {
        text: `${text.slice(0, headChars)}\n...[中间内容已截断，原始响应共 ${text.length} 字符]...\n${text.slice(-tailChars)}`,
        truncated: true
    };
}

function resolveSegmentsAttemptStrategy(source, mode) {
    const value = String(source || "");
    if (value.includes("ai_json_repair")) return "ai_json_repair";
    if (value.includes("compact_retry")) return "compact_retry";
    if (value.includes("primary_retry")) return "primary_retry";
    if (value.includes("merged_fallback")) return "fallback";
    if (value.includes("merged")) return "merged_primary";
    if (value.includes("compact_primary") || String(mode || "").includes("compact")) return "compact_primary";
    return "primary";
}

function mergeSegmentsResponseAttempts(nextError, previousError) {
    if (!nextError || typeof nextError !== "object") return nextError;
    const previousAttempts = Array.isArray(previousError?.sentryContext?.ai_response_attempts)
        ? previousError.sentryContext.ai_response_attempts
        : [];
    const nextAttempts = Array.isArray(nextError?.sentryContext?.ai_response_attempts)
        ? nextError.sentryContext.ai_response_attempts
        : [];
    if (!previousAttempts.length) return nextError;
    let attempts = [...previousAttempts, ...nextAttempts];
    if (attempts.length > 4) attempts = [attempts[0], ...attempts.slice(-3)];
    attempts = attempts.map((attempt, index) => ({ ...attempt, attempt: index + 1 }));
    return attachSentryContext(nextError, { ai_response_attempts: attempts });
}

function buildSegmentsFailureSentrySummary(errorInput, context = {}) {
    const attempts = Array.isArray(context?.ai_response_attempts) ? context.ai_response_attempts : [];
    if (String(context?.task || "") !== "segments" || !attempts.length) return context;
    const code = String(errorInput?.code || "");
    const summaryByCode = {
        SEGMENTS_EMPTY_RESPONSE: ["empty_response", "模型没有返回可解析的正文"],
        SEGMENTS_OUTPUT_TRUNCATED: ["output_truncated", "模型输出被截断"],
        SEGMENTS_JSON_PARSE_FAILED: ["json_parse", "模型正文不是合法的分段 JSON"],
        SEGMENTS_INVALID_SCHEMA: ["schema_validation", "JSON 解析成功，但字段结构不符合分段要求"],
        SEGMENTS_EMPTY_LIST: ["empty_list", "模型返回了空分段数组"],
        SEGMENTS_MISSING_PROTOCOL: ["missing_protocol", "联合生成结果中缺少分段标记"]
    };
    const [failureStage, failureReason] = summaryByCode[code] || ["segments_processing", errorInput?.message || "分段处理失败"];
    return {
        ...context,
        failure_stage: failureStage,
        failure_reason: failureReason,
        failed_attempt: attempts.length,
        attempt_count: attempts.length
    };
}

function buildProviderRequestTelemetry(settings, timeoutMs, options = {}) {
    return {
        provider: String(settings?.provider || ""),
        model: String(settings?.model || ""),
        pref_mode: String(settings?.prefMode || ""),
        custom_protocol: String(settings?.customProtocol || ""),
        is_custom_provider: String(settings?.provider || "").toLowerCase() === "custom",
        timeout_ms: Number(timeoutMs || 0) || undefined,
        request_stream: !!options.stream,
        request_entry: options.stream ? "callAIStream" : "callAI",
        request_phase: options.requestPhase || "provider_request",
        bypass_queue: !!options.bypassQueue,
        queue_size_at_start: Number(options.queueSizeAtStart || 0),
        active_count_at_start: Number(options.activeCountAtStart || 0),
        queue_wait_ms: Number(options.queueWaitMs || 0) || 0,
        provider_request_ms: Number(options.providerRequestMs || 0) || undefined,
        first_response_ms: Number(options.firstResponseMs || 0) || undefined,
        timeout_phase: String(options.timeoutPhase || ""),
        first_response_received: options.firstResponseReceived === undefined ? undefined : !!options.firstResponseReceived
    };
}

function shouldRetryInitialStreamFailure(error, firstResponseReceived, attempt, maxAttempts) {
    return String(error?.code || "") === "PROVIDER_NETWORK_ERROR"
        && !firstResponseReceived
        && attempt < maxAttempts;
}

function decorateStreamRetryMetadata(error, attempt, maxAttempts, retryDelaysMs = []) {
    if (!error || typeof error !== "object") return error;
    error.requestAttempt = Number(attempt || 0);
    error.requestMaxAttempts = Number(maxAttempts || 0);
    error.retryDelaysMs = Array.isArray(retryDelaysMs) ? [...retryDelaysMs] : [];
    error.retryStrategy = "stream_initial_network_backoff";
    return error;
}

function waitForAbortableDelay(delayMs, signal) {
    if (!delayMs) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let timeoutId = 0;
        let cleanup = () => {};
        const handleAbort = () => {
            cleanup();
            reject(createUserAbortedError());
        };
        cleanup = () => {
            clearTimeout(timeoutId);
            signal?.removeEventListener?.("abort", handleAbort);
        };
        timeoutId = setTimeout(() => {
            cleanup();
            resolve();
        }, delayMs);
        if (signal?.aborted) {
            handleAbort();
            return;
        }
        signal?.addEventListener?.("abort", handleAbort, { once: true });
    });
}

async function enrichTaskFailureContext(context = {}) {
    const merged = context && typeof context === "object" ? { ...context } : {};
    const taskContext = merged.taskContext && typeof merged.taskContext === "object" ? merged.taskContext : {};
    const bvid = normalizeBvid(merged.bvid);
    if (!bvid) {
        return { ...merged, ...buildSubtitleStatsContext(null, taskContext) };
    }
    try {
        const directory = await getCache(bvid);
        const cache = getPartCacheForContext(directory, bvid, taskContext);
        return { ...merged, ...buildSubtitleStatsContext(cache, taskContext) };
    } catch (_) {
        return { ...merged, ...buildSubtitleStatsContext(null, taskContext) };
    }
}

function buildSubtitleStatsContext(cache = {}, taskContext = {}) {
    const rawRows = Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle : [];
    const processedRows = Array.isArray(cache?.processedSubtitle) ? cache.processedSubtitle : [];
    const rows = rawRows.length ? rawRows : processedRows;
    const subtitleTotalChars = rows.reduce((sum, row) => sum + String(row?.text || "").length, 0);
    const taskDuration = taskContext?.videoDuration && typeof taskContext.videoDuration === "object"
        ? taskContext.videoDuration
        : {};
    const videoDurationSec = Number(taskDuration.totalSeconds) > 0
        ? Math.floor(Number(taskDuration.totalSeconds))
        : Math.floor(resolveVideoDurationFromCache(cache));
    return removeEmptyValues({
        video_duration_sec: videoDurationSec > 0 ? videoDurationSec : undefined,
        video_duration_text: String(taskDuration.formattedTime || "").trim() || undefined,
        subtitle_line_count: rows.length || undefined,
        subtitle_total_chars: subtitleTotalChars || undefined
    });
}

function resolveVideoDurationFromCache(cache = {}) {
    const rows = Array.isArray(cache?.rawSubtitle) && cache.rawSubtitle.length
        ? cache.rawSubtitle
        : (Array.isArray(cache?.processedSubtitle) ? cache.processedSubtitle : []);
    let maxSec = 0;
    rows.forEach((row) => {
        const end = Number(row?.end);
        const start = Number(row?.start);
        const candidate = Number.isFinite(end) && end > 0
            ? end
            : (Number.isFinite(start) && start > 0 ? start : 0);
        if (candidate > maxSec) maxSec = candidate;
    });
    return maxSec;
}

function removeEmptyValues(value = {}) {
    return Object.fromEntries(
        Object.entries(value || {}).filter(([, item]) => item !== undefined && item !== null && item !== "")
    );
}

function formatPlaybackTime(totalSeconds = 0) {
    const safe = Math.max(0, Number(totalSeconds || 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = Math.floor(safe % 60);
    const hh = hours > 0 ? `${String(hours).padStart(2, "0")}:` : "";
    return `${hh}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function shouldCaptureRuntimeMessageError(msg, error) {
    const action = String(msg?.action || "").trim();
    if (action === "RUN_TASKS") return false;
    if (isBenignAbortError(error)) return false;
    return true;
}

function isBenignAbortError(error) {
    const name = String(error?.name || "").trim();
    const code = String(error?.code || "").trim();
    const message = String(error?.message || error || "").trim();
    return (
        name === "AbortError" ||
        code === "20" ||
        code === "ABORT_ERR" ||
        /signal is aborted without reason|bodystreambuffer was aborted|operation was aborted|the operation was aborted/i.test(message)
    );
}

async function getSentryRuntimeContext() {
    let platform = {};
    try {
        if (chrome?.runtime?.getPlatformInfo) {
            platform = await chrome.runtime.getPlatformInfo();
        }
    } catch (_) {}
    const manifest = chrome.runtime.getManifest();
    let userId = "";
    try {
        userId = await getOrCreateAnonymousUserId();
    } catch (_) {}
    return {
        extensionVersion: manifest.version || "",
        manifestVersion: manifest.manifest_version || 3,
        language: navigator.language || "",
        userAgent: navigator.userAgent || "",
        platform,
        userId
    };
}

function createUsageEventSessionId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `usage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

function createUsageTaskId(featureName = "task") {
    const feature = String(featureName || "task").toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    if (crypto?.randomUUID) return `${feature}_${crypto.randomUUID()}`;
    return `${feature}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

async function getUsageUserHash() {
    const userId = await getOrCreateAnonymousUserId();
    return sha256Hex(`usage:${userId}`);
}

function buildUsageEventMetadata(payload = {}) {
    return {
        ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
        event_schema_version: 2,
        task_id: String(payload.taskId || "").trim() || undefined,
        tab_id: payload.tabId || undefined
    };
}

function buildUsageErrorPayload(error, fallback = {}) {
    const status = String(fallback.status || "").trim()
        || (error?.code === "ABORTED" ? "cancelled" : resolveUsageStatusByError(error));
    return {
        status,
        errorCode: resolveUsageErrorCode(error, fallback.errorCode || "TASK_FAILED"),
        durationMs: Math.max(0, Date.now() - Number(fallback.startedAt || Date.now())),
        metadata: {
            message: String(error?.message || "").slice(0, 300),
            outcome_category: resolveTaskOutcomeCategory(error, status),
            ...(fallback.metadata && typeof fallback.metadata === "object" ? fallback.metadata : {})
        }
    };
}

async function sendClientUsageEvent(payload = {}, settingsInput = null) {
    try {
        if (!await hasTechnicalDataConsent()) {
            return { sent: false, reason: "technical_data_permission_denied" };
        }
        const settings = settingsInput || await getResolvedSettings();
        const manifest = chrome.runtime.getManifest();
        return await reportUsageEvent(settings, {
            ...payload,
            userHash: await getUsageUserHash(),
            sessionId: USAGE_EVENT_SESSION_ID,
            extensionVersion: manifest.version || "",
            metadata: buildUsageEventMetadata(payload)
        });
    } catch (error) {
        logBackground.warn("usage_event_report_failed", {
            task: "usage_event",
            code: error?.code || "",
            detail: { message: error?.message || "" }
        });
        return { sent: false, reason: "error" };
    }
}

function createFeedbackClientId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

async function getFeedbackClientId() {
    const key = "feedbackClientId";
    const stored = await chrome.storage.local.get([key]);
    const existing = String(stored?.[key] || "").trim();
    if (existing.length >= 16) return existing;
    const next = createFeedbackClientId();
    await chrome.storage.local.set({ [key]: next });
    return next;
}

function getFeedbackHeaders(clientId) {
    return { "x-feedback-client-id": String(clientId || "") };
}

function sanitizeFeedbackText(value, maxLength) {
    return String(value || "").trim().slice(0, maxLength);
}

async function hasTechnicalDataConsent() {
    const manifest = chrome.runtime.getManifest();
    const declaredPermissions = manifest?.browser_specific_settings?.gecko?.data_collection_permissions;
    if (!declaredPermissions) return true;
    try {
        const permissions = await chrome.permissions.getAll();
        return Array.isArray(permissions?.data_collection)
            && permissions.data_collection.includes("technicalAndInteraction");
    } catch (_) {
        return false;
    }
}

function reportClientUsageEvent(payload = {}, settingsInput = null) {
    void sendClientUsageEvent(payload, settingsInput).catch((error) => {
        logBackground.warn("usage_event_queue_failed", {
            task: "usage_event",
            code: error?.code || "USAGE_EVENT_QUEUE_FAILED",
            detail: { message: error?.message || "usage event queue failed" }
        });
    });
    return { sent: false, reason: "queued" };
}

function getUsageRecoveryState(taskContext = {}, component = "task") {
    if (!taskContext || typeof taskContext !== "object") return null;
    if (!taskContext.usageRecoveryState || typeof taskContext.usageRecoveryState !== "object") {
        taskContext.usageRecoveryState = {};
    }
    const key = String(component || "task").trim() || "task";
    if (!taskContext.usageRecoveryState[key] || typeof taskContext.usageRecoveryState[key] !== "object") {
        taskContext.usageRecoveryState[key] = {
            initialFailed: false,
            attempts: 0,
            succeeded: false,
            strategies: []
        };
    }
    return taskContext.usageRecoveryState[key];
}

function buildTaskRecoveryMetadata(taskContext = {}) {
    const states = taskContext?.usageRecoveryState && typeof taskContext.usageRecoveryState === "object"
        ? Object.values(taskContext.usageRecoveryState)
        : [];
    const attempts = states.reduce((total, state) => total + Math.max(0, Number(state?.attempts || 0)), 0);
    const strategies = [...new Set(states.flatMap((state) => Array.isArray(state?.strategies) ? state.strategies : []).filter(Boolean))];
    const fallbackModels = taskContext?.modelFallbackModels && typeof taskContext.modelFallbackModels === "object"
        ? Object.entries(taskContext.modelFallbackModels)
            .map(([task, model]) => `${task}=${String(model || "").trim()}`)
            .filter((item) => !item.endsWith("="))
            .join(",")
        : "";
    return {
        recovered: states.some((state) => state?.succeeded === true),
        recovery_attempts: attempts,
        recovery_strategies: strategies.join(","),
        model_fallback_used: !!fallbackModels,
        model_fallback_models: fallbackModels
    };
}

function getSettingsForTaskResult(settings, taskContext = {}, task = "default") {
    const models = taskContext?.modelFallbackModels && typeof taskContext.modelFallbackModels === "object"
        ? taskContext.modelFallbackModels
        : {};
    const fallbackModel = String(models[task] || models.default || "").trim();
    return fallbackModel ? { ...settings, model: fallbackModel } : settings;
}

async function reportTaskInitialFailure({ settings, taskContext, component, bvid, error, durationMs = 0 } = {}) {
    const state = getUsageRecoveryState(taskContext, component);
    if (!state || state.initialFailed) return false;
    state.initialFailed = true;
    await reportClientUsageEvent({
        eventName: "task_attempt_failed",
        featureName: taskContext?.usageFeatureName || component || "task",
        taskId: taskContext?.usageTaskId || "",
        status: "failed",
        errorCode: resolveUsageErrorCode(error),
        provider: settings?.provider || "",
        model: settings?.model || "",
        bvid,
        durationMs: Math.max(0, Number(durationMs || 0)),
        tabId: taskContext?.tabId,
        metadata: {
            component: String(component || "task"),
            attempt_no: 1,
            is_initial: true
        }
    }, settings);
    return true;
}

async function reportTaskRecoveryFinished({
    settings,
    taskContext,
    component,
    bvid,
    strategy,
    triggerError,
    resultError = null,
    success = false,
    durationMs = 0,
    metrics = {},
    metadata = {}
} = {}) {
    const state = getUsageRecoveryState(taskContext, component);
    if (!state) return false;
    state.attempts += 1;
    state.succeeded = state.succeeded || success;
    const normalizedStrategy = String(strategy || "unknown").trim() || "unknown";
    if (!state.strategies.includes(normalizedStrategy)) state.strategies.push(normalizedStrategy);
    await reportClientUsageEvent({
        eventName: "task_recovery_finished",
        featureName: taskContext?.usageFeatureName || component || "task",
        taskId: taskContext?.usageTaskId || "",
        status: success ? "success" : "failed",
        errorCode: success ? "" : resolveUsageErrorCode(resultError || triggerError),
        provider: settings?.provider || "",
        model: settings?.model || "",
        bvid,
        durationMs: Math.max(0, Number(durationMs || 0)),
        tokenCount: Math.max(0, Number(metrics?.tokens || 0)),
        tabId: taskContext?.tabId,
        metadata: {
            component: String(component || "task"),
            attempt_no: state.attempts + 1,
            strategy: normalizedStrategy,
            trigger_error_code: resolveUsageErrorCode(triggerError),
            ...(metadata && typeof metadata === "object" ? metadata : {})
        }
    }, settings);
    return true;
}

async function reportProvider429RetryAttempt(settings, options, event = {}) {
    const taskContext = options?.taskContext && typeof options.taskContext === "object" ? options.taskContext : null;
    const component = String(options?.component || taskContext?.usageFeatureName || "ai").trim() || "ai";
    const bvid = normalizeBvid(options?.bvid || taskContext?.bvid || "");
    const taskId = String(taskContext?.usageTaskId || options?.provider429TaskId || "").trim() || createUsageTaskId(component);
    if (options && typeof options === "object" && !options.provider429TaskId) options.provider429TaskId = taskId;
    const durationMs = Math.max(0, Number(event?.attempt === 1 ? event?.attemptDurationMs : event?.recoveryDurationMs || 0));
    if (taskContext) {
        if (Number(event?.attempt || 0) === 1) {
            await reportTaskInitialFailure({
                settings,
                taskContext,
                component,
                bvid,
                error: event.error,
                durationMs
            });
            return;
        }
        await reportTaskRecoveryFinished({
            settings,
            taskContext,
            component,
            bvid,
            strategy: "provider_429_backoff",
            triggerError: event.firstError,
            resultError: event.error,
            success: false,
            durationMs,
            metadata: {
                retry_attempt: Number(event.attempt || 0) - 1,
                max_retries: Math.max(0, Number(event.maxAttempts || 0) - 1),
                applied_delay_ms: Number(event.appliedDelayMs || 0),
                next_delay_ms: Number(event.nextDelayMs || 0),
                exhausted: !!event.exhausted
            }
        });
        return;
    }
    reportClientUsageEvent({
        eventName: Number(event?.attempt || 0) === 1 ? "task_attempt_failed" : "task_recovery_finished",
        featureName: component,
        taskId,
        status: "failed",
        errorCode: resolveUsageErrorCode(event.error, "HTTP_429"),
        provider: settings?.provider || "",
        model: settings?.model || "",
        bvid,
        durationMs,
        tabId: options?.tabId,
        metadata: {
            component,
            strategy: "provider_429_backoff",
            attempt_no: Number(event.attempt || 0),
            max_attempts: Number(event.maxAttempts || 0),
            applied_delay_ms: Number(event.appliedDelayMs || 0),
            next_delay_ms: Number(event.nextDelayMs || 0),
            exhausted: !!event.exhausted
        }
    }, settings);
}

async function reportProvider429Recovered(settings, options, event = {}, metrics = {}) {
    const taskContext = options?.taskContext && typeof options.taskContext === "object" ? options.taskContext : null;
    const component = String(options?.component || taskContext?.usageFeatureName || "ai").trim() || "ai";
    const bvid = normalizeBvid(options?.bvid || taskContext?.bvid || "");
    const taskId = String(taskContext?.usageTaskId || options?.provider429TaskId || "").trim() || createUsageTaskId(component);
    if (options && typeof options === "object" && !options.provider429TaskId) options.provider429TaskId = taskId;
    const durationMs = Math.max(0, Number(event?.recoveryDurationMs || 0));
    if (taskContext) {
        await reportTaskRecoveryFinished({
            settings,
            taskContext,
            component,
            bvid,
            strategy: "provider_429_backoff",
            triggerError: event.firstError,
            success: true,
            durationMs,
            metrics,
            metadata: {
                retry_attempt: Number(event.attempt || 0) - 1,
                max_retries: Math.max(0, Number(event.maxAttempts || 0) - 1),
                applied_delay_ms: Number(event.appliedDelayMs || 0)
            }
        });
        return;
    }
    reportClientUsageEvent({
        eventName: "task_recovery_finished",
        featureName: component,
        taskId,
        status: "success",
        errorCode: "",
        provider: settings?.provider || "",
        model: settings?.model || "",
        bvid,
        durationMs,
        tokenCount: Math.max(0, Number(metrics?.tokens || 0)),
        tabId: options?.tabId,
        metadata: {
            component,
            strategy: "provider_429_backoff",
            attempt_no: Number(event.attempt || 0),
            max_attempts: Number(event.maxAttempts || 0),
            applied_delay_ms: Number(event.appliedDelayMs || 0)
        }
    }, settings);
}

function isMeaningfulFeedbackText(value) {
    const normalized = String(value || "").trim().replace(/[。.!！?？]+$/g, "").trim();
    return !!normalized && !/^(无|暂无|没有|无内容|没内容|不知道|不清楚)$/i.test(normalized);
}

function normalizeFeedbackRow(row = {}) {
    return {
        id: String(row.id || ""),
        type: String(row.type || "bug"),
        title: String(row.title || ""),
        content: String(row.content || ""),
        status: String(row.status || "open"),
        reply: String(row.reply || ""),
        bvid: String(row.bvid || ""),
        createdAt: String(row.created_at || row.createdAt || ""),
        updatedAt: String(row.updated_at || row.updatedAt || ""),
        seenAt: String(row.seen_at || row.seenAt || "")
    };
}

function isFeedbackDiagnosticLog(entry = {}) {
    const level = String(entry.level || "").toLowerCase();
    if (level === "warn" || level === "error") return true;
    const event = String(entry.event || "").toLowerCase();
    const code = String(entry.code || "").toLowerCase();
    return /error|failed|fail|timeout|exception|abort|denied|invalid/.test(event)
        || /error|failed|fail|timeout|exception|abort|denied|invalid/.test(code);
}

function getFeedbackUnreadCount(rows = []) {
    return rows.filter((row) => {
        const updatedAt = Date.parse(row.updatedAt || "");
        const seenAt = Date.parse(row.seenAt || "");
        if (!Number.isFinite(updatedAt)) return false;
        return !Number.isFinite(seenAt) || updatedAt > seenAt + 1000;
    }).length;
}

async function readCachedFeedbackState(clientId) {
    try {
        const stored = await chrome.storage.local.get([FEEDBACK_CACHE_STORAGE_KEY]);
        const cache = stored?.[FEEDBACK_CACHE_STORAGE_KEY];
        if (!cache || String(cache.clientId || "") !== String(clientId || "")) return null;
        return {
            rows: Array.isArray(cache.rows) ? cache.rows.map((row) => ({ ...row })) : [],
            unreadCount: Number(cache.unreadCount || 0),
            clientId: String(clientId || ""),
            enabled: true,
            errorText: "",
            statusText: "",
            fetchedAt: Number(cache.fetchedAt || 0)
        };
    } catch (_) {
        return null;
    }
}

async function writeCachedFeedbackState(state) {
    try {
        await chrome.storage.local.set({
            [FEEDBACK_CACHE_STORAGE_KEY]: {
                clientId: String(state?.clientId || ""),
                rows: Array.isArray(state?.rows) ? state.rows : [],
                unreadCount: Number(state?.unreadCount || 0),
                fetchedAt: Number(state?.fetchedAt || Date.now())
            }
        });
    } catch (_) {}
}

function normalizeAnnouncementRow(row = {}) {
    const key = String(row.announcement_key || row.key || "").trim().toLowerCase();
    const linkUrl = String(row.link_url || row.linkUrl || "").trim();
    return {
        key: /^[a-z0-9][a-z0-9_-]{0,79}$/.test(key) ? key : "",
        title: String(row.title || "").trim().slice(0, 120),
        summary: String(row.summary || "").trim().slice(0, 240),
        content: String(row.content || "").trim().slice(0, 5000),
        linkUrl: /^https:\/\//i.test(linkUrl) ? linkUrl.slice(0, 500) : "",
        linkLabel: String(row.link_label || row.linkLabel || "").trim().slice(0, 60),
        showBanner: row.show_banner !== false && row.showBanner !== false,
        publishedAt: String(row.published_at || row.publishedAt || ""),
        updatedAt: String(row.updated_at || row.updatedAt || "")
    };
}

async function readCachedAnnouncementState() {
    try {
        const stored = await chrome.storage.local.get([ANNOUNCEMENT_CACHE_STORAGE_KEY]);
        const cache = stored?.[ANNOUNCEMENT_CACHE_STORAGE_KEY];
        if (!cache) return null;
        return {
            rows: Array.isArray(cache.rows) ? cache.rows.map(normalizeAnnouncementRow).filter((row) => row.key && row.title && row.content) : [],
            fetchedAt: Number(cache.fetchedAt || 0),
            enabled: true,
            errorText: ""
        };
    } catch (_) {
        return null;
    }
}

async function writeCachedAnnouncementState(state) {
    try {
        await chrome.storage.local.set({
            [ANNOUNCEMENT_CACHE_STORAGE_KEY]: {
                rows: Array.isArray(state?.rows) ? state.rows : [],
                fetchedAt: Number(state?.fetchedAt || Date.now())
            }
        });
    } catch (_) {}
}

async function fetchAnnouncementState(settings, { force = false } = {}) {
    const cached = await readCachedAnnouncementState();
    const cacheFresh = cached && Date.now() - Number(cached.fetchedAt || 0) < ANNOUNCEMENT_CACHE_TTL_MS;
    if (!force && cacheFresh) return cached;
    if (!isSupabaseEnabled(settings)) {
        return cached || { rows: [], fetchedAt: 0, enabled: false, errorText: "公告服务暂时不可用" };
    }
    try {
        const rows = await supabaseSelect(settings, SUPABASE_ANNOUNCEMENTS_TABLE, {
            select: "announcement_key,title,summary,content,link_url,link_label,show_banner,published_at,updated_at",
            is_published: "eq.true",
            published_at: `lte.${new Date().toISOString()}`,
            order: "published_at.desc"
        }, {
            requestName: "supabase_select:extension_announcements",
            errorMessage: "读取公告失败"
        });
        const state = {
            rows: rows.map(normalizeAnnouncementRow).filter((row) => row.key && row.title && row.content),
            fetchedAt: Date.now(),
            enabled: true,
            errorText: ""
        };
        await writeCachedAnnouncementState(state);
        return state;
    } catch (error) {
        logBackground.warn("announcement_select_unavailable", {
            task: "announcement",
            code: error?.code || "",
            detail: { error_message: error?.message || "读取公告失败" }
        });
        return cached
            ? { ...cached, errorText: "公告更新暂时不可用，已显示本地记录" }
            : { rows: [], fetchedAt: 0, enabled: false, errorText: "公告服务暂时不可用" };
    }
}

async function fetchFeedbackState(settings, { markSeen = false, force = false } = {}) {
    if (!isSupabaseEnabled(settings)) {
        return { rows: [], unreadCount: 0, clientId: "", enabled: false };
    }
    const clientId = await getFeedbackClientId();
    const table = settings.supabaseFeedbackTable || SUPABASE_DEFAULT_FEEDBACK_TABLE;
    const cached = await readCachedFeedbackState(clientId);
    const cacheFresh = cached && Date.now() - Number(cached.fetchedAt || 0) < FEEDBACK_CACHE_TTL_MS;
    if (!force && !markSeen && cacheFresh) return cached;
    let rows = [];
    if (markSeen && cached) {
        rows = cached.rows;
    } else {
        try {
            rows = await supabaseSelect(settings, table, {
                select: "id,type,title,content,status,reply,bvid,created_at,updated_at,seen_at",
                client_id: `eq.${clientId}`,
                order: "updated_at.desc",
                limit: 20
            }, {
                headers: getFeedbackHeaders(clientId),
                requestName: "feedback_select",
                errorMessage: "读取反馈失败"
            });
        } catch (error) {
            logBackground.warn("feedback_select_unavailable", {
                task: "feedback",
                code: error?.code || "",
                detail: {
                    error_message: error?.message || "读取反馈失败"
                }
            });
            if (cached) return { ...cached, errorText: "反馈服务暂时不可用" };
            return {
                rows: [],
                unreadCount: 0,
                clientId,
                enabled: false,
                errorText: "反馈服务暂时不可用",
                statusText: ""
            };
        }
    }
    const normalizedRows = rows.map(normalizeFeedbackRow);
    if (markSeen && normalizedRows.length) {
        const seenAt = new Date().toISOString();
        try {
            await supabaseWrite(settings, table, { seen_at: seenAt }, {
                method: "PATCH",
                params: { client_id: `eq.${clientId}` },
                headers: getFeedbackHeaders(clientId),
                requestName: "feedback_mark_seen",
                errorMessage: "标记反馈已读失败"
            });
            normalizedRows.forEach((row) => {
                row.seenAt = seenAt;
            });
        } catch (error) {
            logBackground.warn("feedback_mark_seen_unavailable", {
                task: "feedback",
                code: error?.code || "",
                detail: {
                    error_message: error?.message || "标记反馈已读失败"
                }
            });
        }
    }
    const state = {
        rows: normalizedRows,
        unreadCount: getFeedbackUnreadCount(normalizedRows),
        clientId,
        enabled: true,
        errorText: "",
        statusText: "",
        fetchedAt: markSeen && cached ? Number(cached.fetchedAt || Date.now()) : Date.now()
    };
    await writeCachedFeedbackState(state);
    return state;
}

async function submitFeedbackFromContent(msg, sender) {
    const settings = await getResolvedSettings();
    if (!isSupabaseEnabled(settings)) throw new Error("反馈服务暂不可用，请稍后重试");
    const clientId = await getFeedbackClientId();
    const tabId = msg.tabId || sender?.tab?.id || 0;
    const tabState = tabId ? await getTabState(tabId).catch(() => null) : null;
    const manifest = chrome.runtime.getManifest();
    const type = ["bug", "suggestion", "question"].includes(String(msg.type || "bug")) ? String(msg.type || "bug") : "bug";
    const title = sanitizeFeedbackText(msg.title, 120);
    const content = sanitizeFeedbackText(msg.content, 3000);
    if (!isMeaningfulFeedbackText(title)) throw new Error("标题不能为空哦");
    if (!isMeaningfulFeedbackText(content)) throw new Error("内容不能为空哦");
    const includeLogs = msg.includeLogs !== false;
    const contentLogs = Array.isArray(msg.logs) ? msg.logs.filter(isFeedbackDiagnosticLog).slice(-80) : [];
    const backgroundLogs = globalLogs.filter(isFeedbackDiagnosticLog).slice(-120);
    const logs = includeLogs ? dedupeFeedbackLogs([...backgroundLogs, ...contentLogs], 160) : null;
    const now = new Date().toISOString();
    const table = settings.supabaseFeedbackTable || SUPABASE_DEFAULT_FEEDBACK_TABLE;
    await supabaseWrite(settings, table, {
        client_id: clientId,
        extension_version: manifest.version || "",
        provider: String(settings.provider || ""),
        model: getTaskModelName(settings),
        bvid: normalizeBvid(msg.bvid || tabState?.activeBvid || ""),
        type,
        title,
        content,
        logs,
        metadata: {
            tab_id: tabId || 0,
            url: sender?.tab?.url || "",
            user_agent: navigator.userAgent || "",
            route_context: msg?.diagnosticContext && typeof msg.diagnosticContext === "object"
                ? msg.diagnosticContext
                : {},
            background_context: {
                active_bvid: normalizeBvid(tabState?.activeBvid || ""),
                active_cid: Number(tabState?.activeCid || 0),
                active_tid: String(tabState?.activeTid || ""),
                active_part_count: Number(tabState?.activePartCount || 0),
                task_status: tabState?.taskStatus || {},
                task_errors: tabState?.taskErrors || {},
                last_error: String(tabState?.lastError || "")
            }
        },
        seen_at: now
    }, {
        headers: getFeedbackHeaders(clientId),
        requestName: "feedback_submit",
        errorMessage: "提交反馈失败"
    });
    return fetchFeedbackState(settings, { force: true });
}

const MAX_GLOBAL_CONCURRENCY = 1;
const TASK_TIMEOUT_MS = 60000;
const ASR_TASK_TIMEOUT_MS = 120000;
const EFFICIENCY_TASK_TIMEOUT_MS = 120000;
const EXPANDED_SEGMENTS_MAX_OUTPUT_TOKENS = 8192;
const MAX_SUBTITLE_CHARS = 36000;
const MAX_SEGMENTS_SUBTITLE_CHARS = 120000;
const SILICONFLOW_AUDIO_TRANSCRIBE_URL = "https://api.siliconflow.cn/v1/audio/transcriptions";
const GROQ_MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const SILICONFLOW_MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const MIMO_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const GROQ_CONNECTIVITY_TIMEOUT_MS = 6000;
const DOWNLOAD_HEADER_RULE_ID = 910001;
const pendingDownloadFilenames = new Map();
const BILI_PLAYURL_API = "https://api.bilibili.com/x/player/playurl";
const SUPABASE_DEFAULT_VIDEO_CACHE_TABLE = "video_cache";
const SUPABASE_DEFAULT_FEEDBACK_TABLE = "feedback";
const FEEDBACK_CACHE_STORAGE_KEY = "feedbackStateCache";
const FEEDBACK_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SUPABASE_ANNOUNCEMENTS_TABLE = "extension_announcements";
const ANNOUNCEMENT_CACHE_STORAGE_KEY = "announcementStateCache";
const ANNOUNCEMENT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SUPABASE_DEFAULT_USAGE_DAILY_RPC = "increment_feature_usage_daily";
const SUPABASE_DEFAULT_VERSION_TABLE = "extension_versions";
const SUPABASE_REMOTE_CONFIG_TABLE = "extension_remote_config";
const REMOTE_CONFIG_STORAGE_KEY = "remoteConfigState";
const REMOTE_CONFIG_KEY = "production";
const DEFAULT_SENTRY_DSN = "https://440bce86f646672341586eb09c859631@o4511769099501568.ingest.de.sentry.io/4511769123029072";
const LEGACY_SENTRY_DSNS = new Set([
    "https://04879b2bd5fc72eba741a402e26c4790@o4511384082055168.ingest.de.sentry.io/4511384299634768"
]);
const TASK_KEYS = ["summary", "segments", "rumors"];
const CLOUD_CACHE_KEYS = ["subtitle", ...TASK_KEYS];
const CLOUD_READ_DISABLED_BVIDS_KEY = "cloudReadDisabledBvids";
const CLOUD_TASK_FIELD_MAP = {
    summary: ["summary", "summary_model", "summary_upvotes", "summary_downvotes"],
    segments: ["segments", "segments_model", "segments_upvotes", "segments_downvotes"],
    rumors: ["rumors", "rumors_model", "rumors_upvotes", "rumors_downvotes"]
};
const DEFAULT_SETTINGS = {
    provider: "modelscope",
    model: "Qwen/Qwen3-30B-A3B-Instruct-2507",
    apiKey: "",
    providerApiKeys: {},
    providerModels: {},
    customBaseUrl: "",
    customModel: "",
    customProtocol: "openai",
    asrProvider: "groq",
    groqApiKey: "",
    groqModel: "whisper-large-v3-turbo",
    groqBaseUrl: DEFAULT_GROQ_BASE_URL,
    siliconFlowApiKey: "",
    siliconFlowAsrModel: "FunAudioLLM/SenseVoiceSmall",
    mimoApiKey: "",
    mimoAsrModel: MIMO_ASR_MODEL,
    supabaseUrl: "https://qdksdauixnbgrgkilgac.supabase.co",
    supabaseAnonKey: "sb_publishable_55zwbZc_sQ0k4EDJBgpxsQ_1F86l1vT",
    supabaseVideoCacheTable: SUPABASE_DEFAULT_VIDEO_CACHE_TABLE,
    supabaseFeedbackTable: SUPABASE_DEFAULT_FEEDBACK_TABLE,
    supabaseUsageDailyRpcName: SUPABASE_DEFAULT_USAGE_DAILY_RPC,
    supabaseVersionTable: SUPABASE_DEFAULT_VERSION_TABLE,
    themeMode: "system",
    prefMode: "quality",
    pluginDisplayMode: "collapsed",
    pluginDisplayFeatureSeen: true,
    debugMode: false,
    sentryEnabled: true,
    sentryDsn: DEFAULT_SENTRY_DSN,
    disableCloudCacheRead: false
};
const LEGACY_MODELSCOPE_MODELS = new Set([
    "moonshotai/Kimi-K2.5",
    "moonshotai/Kimi-K2.6",
    "MiniMax/MiniMax-M2.5",
    "ZhipuAI/GLM-5.1",
    "ZhipuAI/GLM-4.7-Flash",
    "Qwen/Qwen3.5-27B",
    "Qwen/Qwen2.5-72B-Instruct",
    "deepseek-ai/DeepSeek-V4-Flash"
]);

const queue = [];
let activeCount = 0;
const inFlight = new Map();
const globalLogs = [];
const MAX_LOGS = 2000;
const lastSubtitleSync = new Map();
const chatAbortControllers = new Map();
const tabOperationAbortControllers = new Map();
const tabStateCache = new Map();
const tabStateWriteTimers = new Map();
const cacheMemory = new Map();
const VIDEO_CACHE_SCHEMA_VERSION = 3;
const SINGLE_PART_PENDING_SUFFIX = "single-pending";
const SUMMARY_DRAFT_TTL_MS = 10 * 60 * 1000;
const recentAsrAudioFingerprints = new Map();
let currentDebugMode = false;
let remoteConfigMemory = { ...DEFAULT_REMOTE_CONFIG };
let remoteConfigLoaded = false;
let remoteConfigLoadPromise = null;
let remoteConfigRefreshPromise = null;
let remoteConfigFetchedAt = 0;
let remoteConfigFetchedVersion = "";
let modelScopeQuotaLedgerMemory = null;
let modelScopeQuotaLedgerLoadPromise = null;
let modelScopeQuotaLedgerWritePromise = Promise.resolve();
const fallbackLoggerFactory = {
    create() {
        return {
            info() {},
            warn() {},
            error() {},
            debug() {}
        };
    }
};
const loggerFactory = globalThis.AIPluginLogger?.create ? globalThis.AIPluginLogger : fallbackLoggerFactory;
const logBackground = loggerFactory.create("background", {
    getDebugMode: () => currentDebugMode,
    onEntry: (entry) => {
        pushGlobalLog(entry);
    }
});
const partScopeDiagnosticSignatures = new Map();

function buildPartScopeCacheMeta(cache = {}) {
    return {
        cacheBvid: normalizeBvid(cache?.bvid || ""),
        cacheCid: Number(cache?.cid || 0),
        cacheTid: String(cache?.tid || ""),
        hasSummary: !!String(cache?.summary || "").trim(),
        segmentsCount: Array.isArray(cache?.segments) ? cache.segments.length : 0,
        hasRumors: !!normalizeRumors(cache?.rumors),
        historyCount: Array.isArray(cache?.history) ? cache.history.length : 0,
        summarySource: String(cache?.summaryCacheSource || ""),
        segmentsSource: String(cache?.segmentsCacheSource || ""),
        rumorsSource: String(cache?.rumorsCacheSource || ""),
        partsCount: cache?.parts && typeof cache.parts === "object" ? Object.keys(cache.parts).length : 0,
        availablePartKeys: cache?.parts && typeof cache.parts === "object" ? Object.keys(cache.parts).slice(0, 50) : []
    };
}

function buildCacheDirectoryDiagnostic(cache = {}) {
    const parts = cache?.parts && typeof cache.parts === "object" ? cache.parts : {};
    return {
        topLevelKeys: Object.keys(cache || {}).sort(),
        bvid: normalizeBvid(cache?.bvid || ""),
        schemaVersion: Number(cache?.schemaVersion || 0),
        updatedAt: Number(cache?.updatedAt || 0),
        partCount: Object.keys(parts).length,
        parts: Object.entries(parts).map(([partKey, part]) => ({
            partKey,
            cid: Number(part?.cid || 0),
            tid: String(part?.tid || ""),
            title: String(part?.title || ""),
            subtitleRows: Array.isArray(part?.rawSubtitle) ? part.rawSubtitle.length : 0,
            subtitleVariants: part?.subtitleVariants && typeof part.subtitleVariants === "object"
                ? Object.keys(part.subtitleVariants).length
                : 0,
            hasSummary: !!String(part?.summary || "").trim(),
            segmentsCount: Array.isArray(part?.segments) ? part.segments.length : 0,
            hasRumors: !!normalizeRumors(part?.rumors),
            historyCount: Array.isArray(part?.history) ? part.history.length : 0,
            metricsCount: Array.isArray(part?.metrics) ? part.metrics.length : 0,
            updatedAt: Number(part?.updatedAt || 0)
        }))
    };
}

function logCacheDirectorySnapshot(cache = {}, source = "") {
    logPartScopeDiagnostic("cache_directory_snapshot", {
        source,
        directory: buildCacheDirectoryDiagnostic(cache)
    }, `directory:${normalizeBvid(cache?.bvid || "")}:${source}`);
}

function logPartScopeDiagnostic(event, detail = {}, dedupeKey = "") {
    if (!currentDebugMode) return;
    const payload = { event, ts: Date.now(), layer: "background", ...detail };
    if (dedupeKey) {
        const signature = JSON.stringify(payload, (key, value) => key === "ts" ? undefined : value);
        if (partScopeDiagnosticSignatures.get(dedupeKey) === signature) return;
        partScopeDiagnosticSignatures.set(dedupeKey, signature);
    }
    console.log("[PART_SCOPE_DIAG]", payload);
}
const logAI = loggerFactory.create("ai", {
    getDebugMode: () => currentDebugMode,
    onEntry: (entry) => {
        pushGlobalLog(entry);
    }
});
const logCache = loggerFactory.create("cache", {
    getDebugMode: () => currentDebugMode,
    onEntry: (entry) => {
        pushGlobalLog(entry);
    }
});
const logDownload = loggerFactory.create("download", {
    getDebugMode: () => currentDebugMode,
    onEntry: (entry) => {
        pushGlobalLog(entry);
    }
});
const logASR = loggerFactory.create("asr", {
    getDebugMode: () => currentDebugMode,
    onEntry: (entry) => {
        pushGlobalLog(entry);
    }
});
const logSubtitle = loggerFactory.create("subtitle", {
    getDebugMode: () => currentDebugMode,
    onEntry: (entry) => {
        pushGlobalLog(entry);
    }
});

function createMissingSubtitleError(message = "无字幕可供分析") {
    return createAppError("MISSING_SUBTITLE", message);
}

function registerTabAbortController(tabId, controller) {
    const id = Number(tabId || 0);
    if (!id || !controller) return () => {};
    const set = tabOperationAbortControllers.get(id) || new Set();
    set.add(controller);
    tabOperationAbortControllers.set(id, set);
    return () => {
        const current = tabOperationAbortControllers.get(id);
        if (!current) return;
        current.delete(controller);
        if (!current.size) tabOperationAbortControllers.delete(id);
    };
}

function abortTabOperations(tabId, reason = "aborted") {
    const id = Number(tabId || 0);
    if (!id) return 0;
    let count = 0;
    const set = tabOperationAbortControllers.get(id);
    if (set) {
        [...set].forEach((controller) => {
            try {
                controller.abort(reason);
                count += 1;
            } catch (_) {}
        });
        tabOperationAbortControllers.delete(id);
    }
    [...chatAbortControllers.entries()].forEach(([key, controller]) => {
        if (!String(key).startsWith(`${id}:`)) return;
        try {
            controller.abort(reason);
            count += 1;
        } catch (_) {}
        chatAbortControllers.delete(key);
    });
    return count;
}

syncDebugModeFromStorage();
initializeRemoteConfigSync().catch((error) => {
    logBackground.warn("remote_config_init_failed", { error: error?.message || String(error) });
});

async function ensureRemoteConfigLoaded() {
    if (remoteConfigLoaded) return remoteConfigMemory;
    if (!remoteConfigLoadPromise) {
        remoteConfigLoadPromise = chrome.storage.local.get([REMOTE_CONFIG_STORAGE_KEY])
            .then((stored) => {
                if (stored?.[REMOTE_CONFIG_STORAGE_KEY]) {
                    const cached = stored[REMOTE_CONFIG_STORAGE_KEY];
                    remoteConfigMemory = normalizeRemoteConfigRow(cached);
                    remoteConfigFetchedAt = Number(cached?.fetchedAt || 0);
                    remoteConfigFetchedVersion = String(cached?.fetchedVersion || "");
                }
                remoteConfigLoaded = true;
                return remoteConfigMemory;
            })
            .catch(() => {
                remoteConfigLoaded = true;
                return remoteConfigMemory;
            });
    }
    return remoteConfigLoadPromise;
}

function dedupeFeedbackLogs(entries = [], limit = 160) {
    const seen = new Set();
    return entries.filter((entry) => {
        const key = JSON.stringify([
            entry?.time || entry?.ts || "",
            entry?.module || entry?.source || "",
            entry?.event || "",
            entry?.task_id || entry?.taskId || "",
            entry?.bvid || "",
            entry?.code || "",
            entry?.detail || null
        ]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(-Math.max(1, Number(limit || 160)));
}

async function notifyRemoteConfigUpdated(config) {
    const tabs = await chrome.tabs.query({}).catch(() => []);
    await Promise.all((tabs || []).map((tab) => {
        if (!tab?.id) return Promise.resolve();
        return chrome.tabs.sendMessage(tab.id, {
            action: "REMOTE_CONFIG_UPDATED",
            revision: Number(config?.revision || 0)
        }).catch(() => {});
    }));
}

async function applyRemoteConfigRow(row, source = "rest") {
    const next = normalizeRemoteConfigRow(row);
    if (next.configKey !== REMOTE_CONFIG_KEY) return remoteConfigMemory;
    if (next.revision < Number(remoteConfigMemory?.revision || 0)) return remoteConfigMemory;
    const changed = JSON.stringify(next) !== JSON.stringify(remoteConfigMemory);
    remoteConfigMemory = next;
    remoteConfigLoaded = true;
    if (!changed) return remoteConfigMemory;
    logBackground.info("remote_config_applied", {
        source,
        revision: next.revision,
        provider_count: Object.keys(next.providers || {}).length
    });
    await notifyRemoteConfigUpdated(next);
    return remoteConfigMemory;
}

async function persistRemoteConfigFetchState() {
    remoteConfigFetchedAt = Date.now();
    remoteConfigFetchedVersion = chrome.runtime.getManifest().version;
    await chrome.storage.local.set({
        [REMOTE_CONFIG_STORAGE_KEY]: {
            ...remoteConfigMemory,
            fetchedAt: remoteConfigFetchedAt,
            fetchedVersion: remoteConfigFetchedVersion
        }
    });
}

async function refreshRemoteConfig(settingsInput = null, source = "rest") {
    if (remoteConfigRefreshPromise) return remoteConfigRefreshPromise;
    remoteConfigRefreshPromise = (async () => {
        await ensureRemoteConfigLoaded();
        const settings = settingsInput || normalizeSettings((await chrome.storage.local.get(["settings"])).settings);
        if (!isSupabaseEnabled(settings)) return remoteConfigMemory;
        const rows = await supabaseSelect(settings, SUPABASE_REMOTE_CONFIG_TABLE, {
            select: "config_key,revision,enabled,payload,updated_at",
            config_key: `eq.${REMOTE_CONFIG_KEY}`,
            enabled: "eq.true",
            limit: "1"
        }, {
            requestName: "supabase_select:extension_remote_config",
            errorMessage: "远程配置暂不可用"
        });
        if (rows[0]) await applyRemoteConfigRow(rows[0], source);
        await persistRemoteConfigFetchState();
        return remoteConfigMemory;
    })().catch((error) => {
        logBackground.warn("remote_config_refresh_failed", { source, error: error?.message || String(error) });
        return remoteConfigMemory;
    }).finally(() => {
        remoteConfigRefreshPromise = null;
    });
    return remoteConfigRefreshPromise;
}

async function initializeRemoteConfigSync() {
    await ensureRemoteConfigLoaded();
    const { settings: storedSettings } = await chrome.storage.local.get(["settings"]);
    const settings = normalizeSettings(storedSettings);
    const currentVersion = chrome.runtime.getManifest().version;
    if (remoteConfigFetchedVersion === currentVersion && isRemoteConfigCacheFresh(remoteConfigFetchedAt)) {
        logBackground.debug("remote_config_cache_hit", {
            fetched_at: remoteConfigFetchedAt,
            version: currentVersion
        });
        return remoteConfigMemory;
    }
    await refreshRemoteConfig(settings, "service_worker_start");
}

let latestModelScopeRateLimitInfo = null;

function captureModelScopeRateLimitHeaders(details = {}) {
    const headers = Array.isArray(details.responseHeaders) ? details.responseHeaders : [];
    const getHeader = (name) => {
        const target = String(name || "").toLowerCase();
        const item = headers.find((header) => String(header?.name || "").toLowerCase() === target);
        return item?.value ?? null;
    };
    const getAnyHeader = (...names) => {
        for (const name of names) {
            const value = getHeader(name);
            if (value !== null && value !== undefined && value !== "") return value;
        }
        return null;
    };
    const info = {
        modelLimit: parseHeaderNumber(getAnyHeader("modelscope-ratelimit-model-requests-limit", "x-modelscope-ratelimit-model-requests-limit", "x-ratelimit-model-requests-limit")),
        modelRemaining: parseHeaderNumber(getAnyHeader("modelscope-ratelimit-model-requests-remaining", "x-modelscope-ratelimit-model-requests-remaining", "x-ratelimit-model-requests-remaining")),
        userLimit: parseHeaderNumber(getAnyHeader("modelscope-ratelimit-requests-limit", "x-modelscope-ratelimit-requests-limit", "x-ratelimit-requests-limit", "ratelimit-limit")),
        userRemaining: parseHeaderNumber(getAnyHeader("modelscope-ratelimit-requests-remaining", "x-modelscope-ratelimit-requests-remaining", "x-ratelimit-requests-remaining", "ratelimit-remaining")),
        capturedAt: Date.now()
    };
    if ([info.modelLimit, info.modelRemaining, info.userLimit, info.userRemaining].some((value) => value !== null)) {
        latestModelScopeRateLimitInfo = info;
    }
}

function registerModelScopeRateLimitObserver() {
    if (!chrome.webRequest?.onHeadersReceived) return;
    chrome.webRequest.onHeadersReceived.addListener(
        captureModelScopeRateLimitHeaders,
        { urls: ["https://api-inference.modelscope.cn/*"] },
        ["responseHeaders"]
    );
}

registerModelScopeRateLimitObserver();

function serializeSafeResponseHeaders(headers) {
    const blocked = /^(?:set-cookie|set-cookie2|authorization|proxy-authorization)$/i;
    const rows = [];
    if (headers && typeof headers.forEach === "function") {
        headers.forEach((value, name) => {
            if (blocked.test(String(name || ""))) return;
            rows.push({
                name: String(name || "").toLowerCase(),
                value: String(value || "").slice(0, 500)
            });
        });
    }
    return rows.sort((left, right) => left.name.localeCompare(right.name));
}

function responseHeadersToJson(headers) {
    return Object.fromEntries(serializeSafeResponseHeaders(headers).map((item) => [item.name, item.value]));
}

async function testModelScopeResponseHeaders() {
    const settings = await getResolvedSettings();
    if (String(settings?.provider || "").toLowerCase() !== "modelscope") {
        throw createAppError("CONFIG_REQUIRED", "请先在设置中选择 ModelScope，再运行响应头测试");
    }
    if (!String(settings?.apiKey || "").trim()) {
        throw createAppError("MISSING_API_KEY", "请先填写 ModelScope API Token");
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort("timeout"), 30000);
    const startedAt = Date.now();
    try {
        const result = await callAI("modelscope", {
            ...settings,
            maxOutputTokens: 16
        }, [{ role: "user", content: "Reply with OK only." }], controller.signal);
        const rateLimit = resolveRateLimitInfo(settings, result?.headers, { allowObservedFallback: false });
        if (hasModelScopeRateLimitInfo(rateLimit)) await rememberModelScopeRateLimit(settings, rateLimit);
        return {
            provider: "modelscope",
            model: String(settings?.model || ""),
            status: 200,
            durationMs: Date.now() - startedAt,
            headers: serializeSafeResponseHeaders(result?.headers),
            rawHeaders: responseHeadersToJson(result?.headers),
            rateLimit,
            usage: result?.usage || null
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

async function getModelScopeQuotaLedger() {
    if (modelScopeQuotaLedgerMemory) {
        modelScopeQuotaLedgerMemory = normalizeModelScopeQuotaLedger(modelScopeQuotaLedgerMemory);
        return modelScopeQuotaLedgerMemory;
    }
    if (!modelScopeQuotaLedgerLoadPromise) {
        modelScopeQuotaLedgerLoadPromise = chrome.storage.local
            .get([MODELSCOPE_QUOTA_LEDGER_STORAGE_KEY])
            .then((stored) => {
                modelScopeQuotaLedgerMemory = normalizeModelScopeQuotaLedger(stored?.[MODELSCOPE_QUOTA_LEDGER_STORAGE_KEY]);
                return modelScopeQuotaLedgerMemory;
            })
            .finally(() => {
                modelScopeQuotaLedgerLoadPromise = null;
            });
    }
    return modelScopeQuotaLedgerLoadPromise;
}

function persistModelScopeQuotaLedger(ledger) {
    modelScopeQuotaLedgerMemory = normalizeModelScopeQuotaLedger(ledger);
    const snapshot = structuredClone(modelScopeQuotaLedgerMemory);
    modelScopeQuotaLedgerWritePromise = modelScopeQuotaLedgerWritePromise
        .catch(() => {})
        .then(() => chrome.storage.local.set({ [MODELSCOPE_QUOTA_LEDGER_STORAGE_KEY]: snapshot }))
        .catch((error) => {
            logBackground.warn("modelscope_quota_ledger_write_failed", {
                error: error?.message || String(error)
            });
        });
}

async function rememberModelScopeRateLimit(settings, rateLimitInfo) {
    if (String(settings?.provider || "").toLowerCase() !== "modelscope" || !rateLimitInfo) return null;
    const ledger = updateModelScopeQuotaLedger(
        await getModelScopeQuotaLedger(),
        settings?.model || "",
        rateLimitInfo
    );
    persistModelScopeQuotaLedger(ledger);
    return ledger;
}

function getModelScopeFallbackTask(options = {}) {
    const component = String(options?.component || options?.taskContext?.usageFeatureName || "default").trim().toLowerCase();
    if (component.includes("summary") && component.includes("segment")) return "default";
    if (component.includes("segment")) return "segments";
    if (component.includes("summary")) return "summary";
    if (component.includes("rumor")) return "rumors";
    if (component.includes("chat")) return "chat";
    return "default";
}

function getModelScopeAvailableModels(settings = {}) {
    const configured = settings?.providerCatalog?.modelscope?.models;
    if (Array.isArray(configured) && configured.length) return configured;
    return Array.isArray(PROVIDERS.modelscope?.models) ? PROVIDERS.modelscope.models : [];
}

async function reportModelScopeFallbackInitial(settings, options, error, fallbackModel, reason) {
    const taskContext = options?.taskContext;
    const component = getModelScopeFallbackTask(options);
    const bvid = normalizeBvid(options?.bvid || taskContext?.bvid || "");
    if (taskContext) {
        await reportTaskInitialFailure({ settings, taskContext, component, bvid, error });
        return;
    }
    const taskId = String(options?.provider429TaskId || "").trim() || createUsageTaskId(component);
    reportClientUsageEvent({
        eventName: "task_attempt_failed",
        featureName: component,
        taskId,
        status: "failed",
        errorCode: resolveUsageErrorCode(error),
        provider: settings?.provider || "",
        model: settings?.model || "",
        bvid,
        tabId: options?.tabId,
        metadata: {
            component,
            strategy: "model_fallback",
            fallback_model: fallbackModel,
            trigger_reason: reason
        }
    }, settings);
}

async function reportModelScopeFallbackFinished(settings, options, triggerError, resultError, result, fallbackModel, reason) {
    const taskContext = options?.taskContext;
    const component = getModelScopeFallbackTask(options);
    const bvid = normalizeBvid(options?.bvid || taskContext?.bvid || "");
    const success = !resultError;
    const metadata = {
        from_model: String(settings?.model || ""),
        to_model: fallbackModel,
        trigger_reason: reason
    };
    if (taskContext) {
        await reportTaskRecoveryFinished({
            settings: { ...settings, model: fallbackModel },
            taskContext,
            component,
            bvid,
            strategy: "model_fallback",
            triggerError,
            resultError,
            success,
            durationMs: Number(result?.metrics?.latencyMs || 0),
            metrics: result?.metrics || {},
            metadata
        });
        return;
    }
    const taskId = String(options?.provider429TaskId || "").trim() || createUsageTaskId(component);
    reportClientUsageEvent({
        eventName: "task_recovery_finished",
        featureName: component,
        taskId,
        status: success ? "success" : "failed",
        errorCode: success ? "" : resolveUsageErrorCode(resultError),
        provider: settings?.provider || "",
        model: fallbackModel,
        bvid,
        durationMs: Number(result?.metrics?.latencyMs || 0),
        tokenCount: Number(result?.metrics?.tokens || 0),
        tabId: options?.tabId,
        metadata: { component, strategy: "model_fallback", ...metadata }
    }, { ...settings, model: fallbackModel });
}

async function tryModelScopeFallback(settings, options, triggerError, runFallback) {
    if (options?.disableModelFallback
        || !isStrictModelScopeProvider(settings)
        || !isRemoteFeatureEnabled(remoteConfigMemory, "modelscope_model_fallback", true)
        || remoteConfigMemory?.modelFallback?.enabled === false) {
        return null;
    }
    const errorRateLimitInfo = resolveRateLimitInfo(settings, triggerError?.responseHeaders, { allowObservedFallback: false });
    let ledger = hasModelScopeRateLimitInfo(errorRateLimitInfo)
        ? await rememberModelScopeRateLimit(settings, errorRateLimitInfo)
        : await getModelScopeQuotaLedger();
    const classification = classifyModelScopeFallbackError(triggerError, ledger, {
        currentModel: settings?.model || ""
    });
    if (!classification?.eligible) return null;
    if (classification.markUnavailable || classification.markQuotaExhausted) {
        ledger = markModelScopeModelUnavailable(
            ledger,
            settings?.model || "",
            classification.markQuotaExhausted ? "quota_exhausted" : classification.reason
        );
        persistModelScopeQuotaLedger(ledger);
    }
    const component = getModelScopeFallbackTask(options);
    if (options && typeof options === "object" && !options.provider429TaskId) {
        options.provider429TaskId = String(options?.taskContext?.usageTaskId || "").trim() || createUsageTaskId(component);
    }
    const fallbackModel = selectModelScopeFallbackModel({
        currentModel: settings?.model || "",
        task: component,
        availableModels: getModelScopeAvailableModels(settings),
        fallbackConfig: remoteConfigMemory?.modelFallback,
        ledger
    });
    if (!fallbackModel) {
        logAI.warn("model_fallback_skipped", {
            task: component,
            provider: settings?.provider || "",
            model: settings?.model || "",
            code: resolveUsageErrorCode(triggerError),
            detail: {
                reason: ledger?.user?.remaining === 0 ? "user_quota_exhausted" : "no_eligible_model"
            }
        });
        return null;
    }
    const fallbackSettings = {
        ...settings,
        model: fallbackModel,
        providerModels: {
            ...(settings?.providerModels || {}),
            modelscope: fallbackModel
        }
    };
    await reportModelScopeFallbackInitial(settings, options, triggerError, fallbackModel, classification.reason);
    if (["quota_exhausted", "model_quota_exhausted"].includes(classification.reason)) {
        try {
            await chrome.tabs.sendMessage(options?.tabId, {
                action: "SHOW_TOAST",
                text: "当前模型当日额度已经耗尽，已自动切换到其他可用模型",
                durationMs: 4200
            });
        } catch (_) {}
    }
    logAI.warn("model_fallback_started", {
        task: component,
        provider: "modelscope",
        model: settings?.model || "",
        code: resolveUsageErrorCode(triggerError),
        detail: { fallback_model: fallbackModel, trigger_reason: classification.reason }
    });
    try {
        const result = await runFallback(fallbackSettings);
        if (result?.metrics) {
            result.metrics = {
                ...result.metrics,
                modelFallback: true,
                fallbackFromModel: String(settings?.model || ""),
                fallbackTrigger: classification.reason
            };
        }
        if (options?.taskContext) {
            options.taskContext.modelFallbackModels = {
                ...(options.taskContext.modelFallbackModels || {}),
                [component]: fallbackModel
            };
        }
        await reportModelScopeFallbackFinished(settings, options, triggerError, null, result, fallbackModel, classification.reason);
        logAI.info("model_fallback_succeeded", {
            task: component,
            provider: "modelscope",
            model: fallbackModel,
            duration_ms: Number(result?.metrics?.latencyMs || 0),
            detail: { from_model: settings?.model || "", trigger_reason: classification.reason }
        });
        return result;
    } catch (fallbackError) {
        const fallbackRateLimitInfo = resolveRateLimitInfo(fallbackSettings, fallbackError?.responseHeaders, { allowObservedFallback: false });
        const latestLedger = hasModelScopeRateLimitInfo(fallbackRateLimitInfo)
            ? await rememberModelScopeRateLimit(fallbackSettings, fallbackRateLimitInfo)
            : await getModelScopeQuotaLedger();
        const fallbackClassification = classifyModelScopeFallbackError(fallbackError, latestLedger, {
            currentModel: fallbackModel
        });
        if (fallbackClassification?.markUnavailable || fallbackClassification?.markQuotaExhausted) {
            persistModelScopeQuotaLedger(markModelScopeModelUnavailable(
                latestLedger,
                fallbackModel,
                fallbackClassification.markQuotaExhausted ? "quota_exhausted" : fallbackClassification.reason
            ));
        }
        attachSentryContext(fallbackError, {
            model_fallback_from: String(settings?.model || ""),
            model_fallback_to: fallbackModel,
            model_fallback_trigger: classification.reason,
            model_fallback_original_code: resolveUsageErrorCode(triggerError)
        });
        await reportModelScopeFallbackFinished(settings, options, triggerError, fallbackError, null, fallbackModel, classification.reason);
        logAI.warn("model_fallback_failed", {
            task: component,
            provider: "modelscope",
            model: fallbackModel,
            code: resolveUsageErrorCode(fallbackError),
            detail: { from_model: settings?.model || "", trigger_reason: classification.reason }
        });
        throw fallbackError;
    }
}

function enableSidePanelActionClick() {
    if (chrome.sidePanel?.setPanelBehavior) {
        chrome.sidePanel
            .setPanelBehavior({ openPanelOnActionClick: true })
            .catch((error) => logBackground.warn("side_panel_action_behavior_failed", { error: error?.message || String(error) }));
        return;
    }
    if (!chrome.sidebarAction?.open || !chrome.action?.onClicked || firefoxActionClickRegistered) return;
    firefoxActionClickRegistered = true;
    chrome.action.onClicked.addListener(() => {
        chrome.sidebarAction.open()
            .catch((error) => logBackground.warn("sidebar_action_open_failed", { error: error?.message || String(error) }));
    });
}

enableSidePanelActionClick();

chrome.runtime.onInstalled.addListener(async (details = {}) => {
    enableSidePanelActionClick();
    const { settings } = await chrome.storage.local.get(["settings"]);
    const normalized = normalizeSettings(settings);
    await chrome.storage.local.set({ settings: normalized });
    const promptSettings = await getPromptSettingsFromSync();
    await chrome.storage.sync.set({ promptSettings });
    currentDebugMode = !!normalized.debugMode;
    syncRuntimeDebugFlag(currentDebugMode);
    logBackground.info("storage_update", { source: "on_installed", debug_mode: currentDebugMode });
    await refreshRemoteConfig(normalized, `extension_${details.reason || "installed"}`);
    if (details.reason === "install") {
        await reportClientUsageEvent({
            eventName: "extension_installed",
            featureName: "extension",
            status: "installed",
            metadata: { install_source: "unknown" }
        }, normalized);
    }
});

chrome.tabs.onRemoved?.addListener((tabId) => {
    abortTabOperations(tabId, "aborted");
});

chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo?.status === "loading") {
        abortTabOperations(tabId, "aborted");
    }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    logBackground.debug("storage_listener_trigger", { keys: Object.keys(changes || {}) });
    if (changes.settings?.newValue) {
        currentDebugMode = !!changes.settings.newValue.debugMode;
        syncRuntimeDebugFlag(currentDebugMode);
    }
    Object.keys(changes || {}).forEach((key) => {
        const change = changes[key];
        if (!change) return;
        if (key.startsWith("tabState_")) {
            if (change.newValue) tabStateCache.set(key, cloneData(change.newValue));
            else tabStateCache.delete(key);
            return;
        }
        if (key.startsWith("cache_")) {
            const bvid = normalizeBvid(key.replace(/^cache_/i, ""));
            if (!bvid) return;
            if (change.newValue) cacheMemory.set(bvid, normalizeVideoCacheDirectory(change.newValue, bvid));
            else cacheMemory.delete(bvid);
        }
    });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.action === "OFFSCREEN_CHUNK_AUDIO_PROGRESS") {
        handleOffscreenChunkProgress(msg?.payload || {}).catch(() => {});
        sendResponse({ ok: true });
        return false;
    }
    if (/^OFFSCREEN_CHUNK_AUDIO/.test(String(msg?.action || ""))) return false;
    handleMessage(msg, sender)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => {
            if (shouldCaptureRuntimeMessageError(msg, error)) {
                captureBackgroundError(error, {
                    source: "runtime_message",
                    action: msg?.action || "",
                    tabId: sender?.tab?.id || 0
                });
            } else {
                logBackground.debug("runtime_message_capture_skipped", {
                    action: msg?.action || "",
                    code: error?.code || "",
                    message: error?.message || "unknown"
                });
            }
            sendResponse({ ok: false, error: error.message || "未知错误", ...serializeAppError(error) });
        });
    return true;
});

chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== "chat-stream") return;
    port.onMessage.addListener((msg) => {
        if (msg?.action === "ABORT_CHAT_STREAM") {
            abortChatForPort(port, msg);
            return;
        }
        if (msg?.action !== "RUN_CHAT_STREAM") return;
        runChatForPort(port, msg).catch((error) => {
            captureBackgroundError(error, {
                source: "chat_stream_port",
                task: "chat",
                messageId: msg?.messageId || ""
            });
            safePortPost(port, {
                type: "error",
                messageId: String(msg?.messageId || ""),
                error: error.message || "聊天失败",
                ...serializeAppError(error)
            });
        });
    });
});

globalThis.addEventListener?.("error", (event) => {
    captureBackgroundError(event.error || event.message, {
        source: "background_global_error",
        task: "global_error"
    });
});

globalThis.addEventListener?.("unhandledrejection", (event) => {
    captureBackgroundError(event.reason || "Unhandled rejection", {
        source: "background_unhandled_rejection",
        task: "global_rejection"
    });
});

chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state && delta.state.current) {
        if (delta.state.current === "interrupted") {
            logDownload.error("download_interrupted", {
                task: "download",
                code: "DOWNLOAD_INTERRUPTED",
                detail: {
                    download_id: delta.id,
                    reason: delta.error?.current || "unknown"
                }
            });
        } else if (delta.state.current === "complete") {
            logDownload.info("download_complete", {
                task: "download",
                detail: { download_id: delta.id }
            });
        } else {
            logDownload.debug("download_state_changed", {
                task: "download",
                detail: {
                    download_id: delta.id,
                    state: delta.state.current
                }
            });
        }
    }
});

chrome.downloads.onDeterminingFilename?.addListener((item, suggest) => {
    const matchedUrl = [item?.url, item?.finalUrl]
        .map((value) => String(value || "").trim())
        .find((value) => pendingDownloadFilenames.has(value));
    if (!matchedUrl) return;
    const filename = pendingDownloadFilenames.get(matchedUrl);
    pendingDownloadFilenames.delete(matchedUrl);
    suggest({ filename, conflictAction: "uniquify" });
});

async function handleMessage(msg, sender) {
    if (msg.action === "OPEN_SIDE_PANEL") {
        const tabId = Number(msg.tabId || sender?.tab?.id || 0);
        if (!tabId) throw new Error("无法确定当前标签页");
        if (chrome.sidePanel?.open) {
            return chrome.sidePanel.open({ tabId }).then(() => ({ tabId }));
        }
        if (chrome.sidebarAction?.open) {
            return { tabId, requiresToolbarAction: true };
        }
        throw new Error("当前浏览器不支持侧边栏");
    }
    if (msg.action === "OPEN_EXTENSION_MANAGEMENT") {
        const url = chrome.sidebarAction ? "about:addons" : "chrome://extensions/";
        await chrome.tabs.create({ url, active: true });
        return {};
    }
    if (msg.action === "CHECK_LATEST_VERSION") {
        const settings = await getResolvedSettings();
        return { versionState: await getLatestVersionState(settings, { force: !!msg.force }) };
    }
    if (msg.action === "REPORT_ERROR") {
        await captureBackgroundError(msg.error || "Content error", {
            ...(msg.context || {}),
            source: msg.context?.source || "content_report",
            tabId: sender?.tab?.id || 0
        });
        return {};
    }
    if (msg.action === "DOWNLOAD_STREAM") {
        const { url, filename } = msg.payload || {};
        const tabId = msg.tabId || sender.tab?.id;
        if (!url) throw new Error("URL is required");
        const settings = await getResolvedSettings();
        const startedAt = Date.now();
        const urlMeta = getUrlMeta(url);
        const fileExt = getFileExtension(filename || "download.mp4");
        logDownload.info("download_chrome_api_start", {
            task: "download",
            source: "background",
            detail: {
                tab_id: tabId || 0,
                has_url: !!url,
                url_host: urlMeta.host,
                file_ext: fileExt,
                save_as: true,
                conflict_action: "uniquify"
            }
        });

        try {
            const status = tabId
                ? await probeUrlStatusForTab(tabId, url)
                : await probeUrlStatus(url);
            if (status === "expired") {
                const error = createAppError(
                    "DOWNLOAD_URL_UNVERIFIED",
                    "下载链接已失效，请刷新后重试"
                );
                error.status = status;
                throw error;
            }
            await ensureDownloadHeaderRule(url);
            const responseMeta = await probeDownloadContentType(url);
            if (responseMeta && (
                responseMeta.isHtml
                || responseMeta.status === 401
                || responseMeta.status === 403
                || responseMeta.status >= 400
            )) {
                const error = createAppError(
                    "DOWNLOAD_URL_EXPIRED",
                    responseMeta.isHtml
                        ? "下载地址返回了网页而不是媒体文件，请刷新后重试"
                        : `下载地址请求失败：HTTP ${responseMeta.status}`
                );
                error.status = responseMeta.status;
                throw error;
            }
            const requestedFilename = filename || "download.mp4";
            pendingDownloadFilenames.set(url, requestedFilename);
            let downloadId;
            try {
                downloadId = await chrome.downloads.download({
                    url,
                    filename: requestedFilename,
                    conflictAction: "uniquify",
                    saveAs: true
                });
            } catch (error) {
                pendingDownloadFilenames.delete(url);
                throw error;
            }
            if (!downloadId && chrome.runtime.lastError) {
                throw new Error(chrome.runtime.lastError.message);
            }
            logDownload.info("download_chrome_api_success", {
                task: "download",
                source: "background",
                detail: {
                    tab_id: tabId || 0,
                    download_id: downloadId,
                    file_ext: fileExt,
                    url_host: urlMeta.host
                }
            });
            return { success: true, downloadId };

        } catch (error) {
            const tabState = tabId ? await getTabState(tabId) : null;
            const usageContext = await getUsageVideoContext(tabState?.activeBvid || "", {
                title: tabState?.title || ""
            });
            await reportDailyFeatureUsage("download", settings, {
                durationMs: Date.now() - startedAt,
                tokens: 0
            }, resolveUsageStatusByError(error), resolveUsageErrorCode(error, "DOWNLOAD_CHROME_API_FAILED"), usageContext);
            logDownload.error("download_chrome_api_failed", {
                task: "download",
                source: "background",
                code: "DOWNLOAD_CHROME_API_FAILED",
                detail: {
                    tab_id: tabId || 0,
                    url_host: urlMeta.host,
                    file_ext: fileExt,
                    reason: error.message || "download failed"
                }
            });
            throw error;
        }
    }
    if (msg.action === "PROBE_URL") {
        const url = String(msg?.payload?.url || "").trim();
        if (!url) return { status: "unknown" };
        const tabId = Number(msg.tabId || sender.tab?.id || 0);
        const status = tabId ? await probeUrlStatusForTab(tabId, url) : await probeUrlStatus(url);
        return { status };
    }
    if (msg.action === "GET_COMPAT_PLAYURL") {
        if (!sender.tab?.id && !msg.tabId) throw new Error("tabId 缺失");
        const result = await getCompatPlayUrlForTab(msg.tabId || sender.tab.id, msg.payload || {});
        return result;
    }
    if (msg.action === "LOG_ENTRY") {
        if (msg.entry && typeof msg.entry === "object") {
            pushGlobalLog(msg.entry);
        }
        return {};
    }
    if (msg.action === "GET_LOGS") {
        return { logs: [...globalLogs] };
    }
    if (msg.action === "CLEAR_LOGS") {
        globalLogs.length = 0;
        return { cleared: true };
    }
    if (msg.action === "GET_FEEDBACK") {
        const settings = await getResolvedSettings();
        return { feedback: await fetchFeedbackState(settings, { markSeen: !!msg.markSeen, force: !!msg.force }) };
    }
    if (msg.action === "SUBMIT_FEEDBACK") {
        return { feedback: await submitFeedbackFromContent(msg, sender) };
    }
    if (msg.action === "MARK_FEEDBACK_SEEN") {
        const settings = await getResolvedSettings();
        return { feedback: await fetchFeedbackState(settings, { markSeen: true }) };
    }
    if (msg.action === "REPORT_USAGE_EVENT") {
        const settings = await getResolvedSettings();
        return await reportClientUsageEvent({
            ...(msg.payload && typeof msg.payload === "object" ? msg.payload : {}),
            tabId: msg.tabId || sender.tab?.id || 0
        }, settings);
    }
    if (msg.action === "SET_RUNTIME_DEBUG") {
        currentDebugMode = !!msg.enabled;
        syncRuntimeDebugFlag(currentDebugMode);
        if (currentDebugMode) {
            logBackground.info("runtime_debug_enabled", {
                task: "debug",
                detail: { source: msg.source || "content" }
            });
        }
        return { enabled: currentDebugMode };
    }
    const tabId = msg.tabId || sender.tab?.id;
    if (msg.action === "SUBTITLE_CAPTURED") {
        await handleSubtitleCaptured(tabId, msg.payload);
        return {};
    }
    if (msg.action === "SET_ACTIVE_PART") {
        if (!tabId) return {};
        const bvid = normalizeBvid(msg?.bvid);
        if (!bvid) return {};
        const cid = Number(msg?.cid || 0);
        await updateTabState(tabId, {
            activeBvid: bvid,
            activeCid: Number.isFinite(cid) && cid > 0 ? cid : 0,
            activeTid: String(msg?.tid || "").trim() || null,
            activePartCount: Math.max(0, Math.floor(Number(msg?.partCount || 0))),
            updatedAt: Date.now()
        });
        if (Number.isFinite(cid) && cid > 0 && Number(msg?.partCount || 0) === 1 && !String(msg?.tid || "").trim()) {
            await promotePendingSinglePartCache(bvid, cid).catch(() => {});
            await promotePendingSinglePartTaskState(tabId, bvid, cid).catch(() => {});
        }
        return {};
    }
    if (msg.action === "RUN_TRANSCRIBE_FALLBACK" || msg.action === "GET_AUDIO_URL") {
        if (!tabId) throw new Error("tabId 缺失");
        const result = await ContentProvider.transcribeFallback(tabId, msg.payload || {});
        return result;
    }
    if (msg.action === "ABORT_TAB_OPERATIONS") {
        const count = abortTabOperations(tabId, "aborted");
        if (tabId) {
            const current = await getTabState(tabId).catch(() => null);
            await setTaskStatus(tabId, TASK_KEYS, "idle", "", {
                bvid: current?.activeBvid || "",
                cid: Number(current?.activeCid || 0),
                tid: String(current?.activeTid || "")
            }).catch(() => {});
            await updateTabState(tabId, { transcriptionProgress: 0, updatedAt: Date.now() }).catch(() => {});
        }
        logBackground.info("tab_operations_aborted", { tab_id: tabId || 0, detail: { controller_count: count } });
        return { aborted: count };
    }
    if (msg.action === "CLEAR_SUBTITLE_CACHE") {
        const bvid = normalizeBvid(msg.bvid);
        if (!bvid) return {};
        const cid = Number(msg.cid || 0);
        if (!(cid > 0)) throw createAppError("PART_IDENTITY_PENDING", "正在识别当前分 P，请稍候再试");
        await mergeCacheByBvid(bvid, {
            cid,
            tid: String(msg.tid || ""),
            rawSubtitle: [],
            processedSubtitle: [],
            rawHash: "",
            processedHash: "",
            updatedAt: Date.now()
        });
        if (tabId) {
            await updateTabState(tabId, {
                subtitleSource: "",
                transcriptionProgress: 0,
                updatedAt: Date.now()
            });
        }
        return {};
    }
    if (msg.action === "DELETE_VIDEO_CACHE") {
        const bvid = normalizeBvid(msg.bvid);
        if (!bvid) return { deleted: 0 };
        const current = await getCache(bvid);
        if (!current || !Object.keys(current).length) return { deleted: 0 };
        await mergeCacheByBvid(bvid, buildDerivedCacheClearPatch(current));
        return { deleted: 1 };
    }
    if (msg.action === "DELETE_ALL_VIDEO_CACHE") {
        const data = await chrome.storage.local.get(null);
        const entries = Object.entries(data || {}).filter(([key, value]) => key.startsWith("cache_") && value && typeof value === "object");
        const seen = new Set();
        await Promise.all(entries.map(async ([key, value]) => {
            const bvid = normalizeBvid(value?.bvid || key.replace(/^cache_/i, ""));
            if (!bvid || seen.has(bvid)) return;
            seen.add(bvid);
            const directory = normalizeVideoCacheDirectory(value, bvid);
            await mergeCacheByBvid(bvid, buildDerivedCacheClearPatch(directory));
        }));
        return { deleted: seen.size };
    }
    if (msg.action === "SET_CLOUD_CACHE_READ_PREF") {
        const scope = String(msg.scope || "").toLowerCase();
        const disabled = !!msg.disabled;
        if (scope === "all") {
            const settings = await mergeSettings({ disableCloudCacheRead: disabled });
            return { settings, cloudCachePrefs: await getCloudCacheReadPrefs(msg.bvid, settings) };
        }
        if (scope === "current") {
            const bvid = normalizeBvid(msg.bvid);
            if (!bvid) throw new Error("未获取到当前视频");
            const data = await chrome.storage.local.get([CLOUD_READ_DISABLED_BVIDS_KEY]);
            const map = data?.[CLOUD_READ_DISABLED_BVIDS_KEY] && typeof data[CLOUD_READ_DISABLED_BVIDS_KEY] === "object"
                ? { ...data[CLOUD_READ_DISABLED_BVIDS_KEY] }
                : {};
            if (disabled) map[bvid] = true;
            else delete map[bvid];
            await chrome.storage.local.set({ [CLOUD_READ_DISABLED_BVIDS_KEY]: map });
            return { cloudCachePrefs: await getCloudCacheReadPrefs(bvid) };
        }
        return { cloudCachePrefs: await getCloudCacheReadPrefs(msg.bvid) };
    }
    if (msg.action === "GET_CLOUD_CACHE_READ_PREFS") {
        return { cloudCachePrefs: await getCloudCacheReadPrefs(msg.bvid) };
    }
    if (msg.action === "GET_BOOTSTRAP") {
        if (!tabId) return { tabState: null, cache: null };
        const tabState = await getTabState(tabId);
        const settings = await getResolvedSettings();
        if (tabState?.activeBvid && msg?.skipCloud !== true) {
            await hydrateCloudCacheIfNeeded(tabState.activeBvid, CLOUD_CACHE_KEYS, settings, {
                cid: Number(tabState?.activeCid || 0),
                tid: String(tabState?.activeTid || ""),
                partCount: Number(tabState?.activePartCount || 0)
            });
        }
        const rawCache = tabState?.activeBvid ? await getCache(tabState.activeBvid) : null;
        const cache = selectCachePart(rawCache, {
            bvid: tabState?.activeBvid || "",
            cid: Number(tabState?.activeCid || 0),
            tid: String(tabState?.activeTid || ""),
            partCount: Number(tabState?.activePartCount || 0)
        });
        const feedback = await fetchFeedbackState(settings, { force: !!msg.refreshFeedback }).catch(() => ({ rows: [], unreadCount: 0, enabled: false }));
        const cloudCachePrefs = await getCloudCacheReadPrefs(tabState?.activeBvid, settings);
        logPartScopeDiagnostic("ui_cache_response", {
            channel: "bootstrap",
            requestedBvid: normalizeBvid(tabState?.activeBvid || ""),
            requestedCid: Number(tabState?.activeCid || 0),
            selected: !!cache,
            ...(cache ? buildPartScopeCacheMeta(cache) : {})
        }, `bootstrap:${tabId}:${tabState?.activeBvid || ""}:${tabState?.activeCid || 0}`);
        return { tabId, tabState, cache, settings, providers: settings.providerCatalog || PROVIDERS, feedback, cloudCachePrefs };
    }
    if (msg.action === "GET_CACHE") {
        const expected = normalizeBvid(msg.bvid);
        if (!expected) {
            if (!tabId) return { bvid: "", cache: null, tabState: null };
            const tabState = await getTabState(tabId);
            const bvid = normalizeBvid(tabState?.activeBvid);
            const settings = await getResolvedSettings();
            if (bvid && msg?.skipCloud !== true) {
                await hydrateCloudCacheIfNeeded(bvid, CLOUD_CACHE_KEYS, settings, {
                    cid: Number(tabState?.activeCid || 0),
                    tid: String(tabState?.activeTid || ""),
                    partCount: Number(tabState?.activePartCount || 0)
                });
            }
            const rawCache = bvid ? await getCache(bvid) : null;
            const cache = selectCachePart(rawCache, {
                bvid,
                cid: Number(tabState?.activeCid || 0),
                tid: String(tabState?.activeTid || ""),
                partCount: Number(tabState?.activePartCount || 0)
            });
            logPartScopeDiagnostic("ui_cache_response", {
                channel: "get_cache_active",
                requestedBvid: bvid,
                requestedCid: Number(tabState?.activeCid || 0),
                selected: !!cache,
                ...(cache ? buildPartScopeCacheMeta(cache) : {})
            }, `get-active:${tabId}:${bvid}:${tabState?.activeCid || 0}`);
            return { bvid, cache, tabState, cloudCachePrefs: await getCloudCacheReadPrefs(bvid, settings) };
        }
        const settings = await getResolvedSettings();
        const tabState = tabId ? await getTabState(tabId) : null;
        const hasExplicitCid = Object.prototype.hasOwnProperty.call(msg || {}, "cid");
        const cacheContext = {
            cid: Number(hasExplicitCid ? msg.cid : (tabState?.activeCid || 0)),
            tid: String(msg.tid || tabState?.activeTid || ""),
            partCount: Number(msg.partCount || tabState?.activePartCount || 0)
        };
        if (msg?.skipCloud !== true) {
            await hydrateCloudCacheIfNeeded(expected, CLOUD_CACHE_KEYS, settings, cacheContext);
        }
        const rawCache = await getCache(expected);
        const cache = selectCachePart(rawCache, {
            bvid: expected,
            cid: cacheContext.cid,
            tid: cacheContext.tid,
            partCount: cacheContext.partCount
        });
        logPartScopeDiagnostic("ui_cache_response", {
            channel: "get_cache_explicit",
            requestedBvid: expected,
            requestedCid: cacheContext.cid,
            requestedTid: cacheContext.tid,
            rootCid: Number(rawCache?.cid || 0),
            selected: !!cache,
            ...(cache ? buildPartScopeCacheMeta(cache) : {})
        }, `get-explicit:${tabId || 0}:${expected}:${cacheContext.cid}`);
        return { bvid: expected, cache, tabState, cloudCachePrefs: await getCloudCacheReadPrefs(expected, settings) };
    }
    if (msg.action === "RUN_TASKS") {
        if (!tabId) throw new Error("tabId 缺失");
        const tasks = Array.isArray(msg.tasks) ? msg.tasks.filter((task) => TASK_KEYS.includes(task)) : [];
        if (!tasks.length) throw new Error("任务为空");
        const requestedBvid = normalizeBvid(msg.bvid);
        logBackground.info("task_enqueue", { tab_id: tabId, bvid: requestedBvid, tasks, force: msg.force !== false });
        const taskResults = await runTasksForTab(tabId, tasks, msg.force !== false, normalizeTaskContext(msg.taskContext), requestedBvid);
        return { taskResults };
    }
    if (msg.action === "RUN_SEGMENTS_RETRY_TEST") {
        if (!tabId) throw new Error("tabId 缺失");
        const requestedBvid = normalizeBvid(msg.bvid);
        logBackground.info("segments_retry_test_start", {
            tab_id: tabId,
            bvid: requestedBvid
        });
        await runTasksForTab(tabId, ["segments"], true, {
            ...normalizeTaskContext(msg.taskContext),
            debugForceFirstSegmentsFailure: true
        }, requestedBvid);
        return {};
    }
    if (msg.action === "GET_ANNOUNCEMENTS") {
        const settings = await getResolvedSettings();
        return { announcements: await fetchAnnouncementState(settings, { force: !!msg.force }) };
    }
    if (msg.action === "TEST_MODELSCOPE_RESPONSE_HEADERS") {
        return { result: await testModelScopeResponseHeaders() };
    }
    if (msg.action === "RUN_SEGMENTS_TRUNCATION_RETRY_TEST") {
        if (!tabId) throw new Error("tabId 缺失");
        const requestedBvid = normalizeBvid(msg.bvid);
        logBackground.info("segments_truncation_retry_test_start", { tab_id: tabId, bvid: requestedBvid });
        await runTasksForTab(tabId, ["segments"], true, {
            ...normalizeTaskContext(msg.taskContext),
            debugForceFirstSegmentsTruncation: true
        }, requestedBvid);
        return {};
    }
    if (msg.action === "RUN_PROVIDER_429_RETRY_TEST") {
        if (!tabId) throw new Error("tabId 缺失");
        const requestedBvid = normalizeBvid(msg.bvid);
        logBackground.info("provider_429_retry_test_start", { tab_id: tabId, bvid: requestedBvid });
        await recordSegmentsDebugState(tabId, {
            status: "running",
            stage: "provider_429_wait",
            strategy: "provider_429_backoff",
            attempt: 0,
            total: 4,
            code: "HTTP_429",
            message: "测试模式：准备模拟 Provider 429"
        }, "测试模式：将依次等待 2 秒、5 秒、10 秒后重试", { resetEvents: true });
        await runTasksForTab(tabId, ["segments"], true, {
            ...normalizeTaskContext(msg.taskContext),
            debugForceProvider429Retries: true
        }, requestedBvid);
        return {};
    }
    if (msg.action === "RUN_SUMMARY_EMPTY_RETRY_TEST") {
        if (!tabId) throw new Error("tabId 缺失");
        const requestedBvid = normalizeBvid(msg.bvid);
        logBackground.info("summary_empty_retry_test_start", { tab_id: tabId, bvid: requestedBvid });
        await recordSummaryRetryDebugState(tabId, {
            status: "running",
            stage: "forced_empty",
            attempt: 0,
            total: 1,
            code: "SUMMARY_EMPTY_RESPONSE",
            message: "测试模式：等待首轮响应后模拟总结为空"
        }, "测试模式：准备模拟首轮总结为空", { resetEvents: true });
        await runTasksForTab(tabId, ["summary"], true, {
            ...normalizeTaskContext(msg.taskContext),
            debugForceFirstSummaryEmpty: true
        }, requestedBvid);
        return {};
    }
    if (msg.action === "RUN_CHAT") {
        if (!tabId) throw new Error("tabId 缺失");
        const text = String(msg.text || "").trim();
        const messageId = String(msg.messageId || "");
        if (!text || !messageId) throw new Error("聊天参数不完整");
        const result = await runChatForTab(tabId, text, messageId, normalizeBvid(msg.bvid), normalizeTaskContext(msg.taskContext));
        return { answer: result.answer, metrics: result.metrics };
    }
    if (msg.action === "ABORT_TRANSCRIPTION") {
        const count = abortTabOperations(tabId, "aborted");
        if (tabId) await updateTabState(tabId, { transcriptionProgress: 0, updatedAt: Date.now() }).catch(() => {});
        logBackground.info("transcription_aborted", { tab_id: tabId || 0, detail: { controller_count: count } });
        return { aborted: count };
    }
    if (msg.action === "CLEAR_TASK_ERRORS") {
        if (!tabId) return {};
        const tasks = (Array.isArray(msg.tasks) ? msg.tasks : []).filter((task) => TASK_KEYS.includes(task));
        if (!tasks.length) return {};
        const current = await getTabState(tabId);
        await setTaskStatus(tabId, tasks, "idle", "", {
            bvid: current?.activeBvid || "",
            cid: Number(current?.activeCid || 0),
            tid: String(current?.activeTid || "")
        });
        return {};
    }
    if (msg.action === "SAVE_SETTINGS") {
        const incoming = msg.settings || {};
        const merged = await mergeSettings(incoming);
        currentDebugMode = !!merged.debugMode;
        syncRuntimeDebugFlag(currentDebugMode);
        logBackground.info("storage_update", { source: "save_settings", debug_mode: currentDebugMode });
        return { settings: merged };
    }
    if (msg.action === "GET_SETTINGS") {
        const settings = await getResolvedSettings();
        return { settings, providers: settings.providerCatalog || PROVIDERS };
    }
    if (msg.action === "ENSURE_OPTIONAL_ORIGIN_PERMISSION") {
        const baseUrl = String(msg?.baseUrl || "").trim();
        if (!baseUrl) throw new Error("缺少自定义 API 地址");
        let origin;
        try {
            const url = new URL(baseUrl);
            if (url.protocol !== "https:") {
                throw new Error("自定义 API 地址必须使用 https");
            }
            origin = url.origin;
        } catch (error) {
            throw new Error(error?.message || "自定义 API 地址格式无效");
        }
        const pattern = `${origin}/*`;
        const contains = await chrome.permissions.contains({ origins: [pattern] });
        if (contains) {
            return { granted: true, pattern };
        }
        if (msg?.request !== true) {
            return { granted: false, pattern };
        }
        const granted = await chrome.permissions.request({ origins: [pattern] });
        return { granted: !!granted, pattern };
    }
    if (msg.action === "OPEN_PERMISSION_REQUEST_PAGE") {
        const baseUrl = String(msg?.baseUrl || "").trim();
        if (!baseUrl) throw new Error("缺少自定义 API 地址");
        const authUrl = chrome.runtime.getURL(`permission-request.html?baseUrl=${encodeURIComponent(baseUrl)}`);
        if (chrome.windows?.create) {
            const created = await chrome.windows.create({
                url: authUrl,
                type: "popup",
                width: 420,
                height: 560,
                focused: true
            });
            return { ok: true, windowId: created?.id || null };
        }
        const createdTab = await chrome.tabs.create({ url: authUrl, active: true });
        return { ok: true, tabId: createdTab?.id || null };
    }
    throw new Error("未知 action");
}

function getUrlMeta(url) {
    try {
        const parsed = new URL(String(url || ""));
        return { host: parsed.host || "", protocol: parsed.protocol || "" };
    } catch (_) {
        return { host: "", protocol: "" };
    }
}

function bytesToHex(bytes) {
    return Array.from(bytes || [])
        .map((value) => Number(value || 0).toString(16).padStart(2, "0"))
        .join("");
}

async function sha256Hex(input) {
    try {
        const bytes = input instanceof ArrayBuffer
            ? input
            : new TextEncoder().encode(String(input || "")).buffer;
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return bytesToHex(new Uint8Array(digest));
    } catch (_) {
        return "";
    }
}

async function summarizeMediaLocator(locator) {
    const raw = String(locator || "").trim();
    if (!raw) return { audio_host: "", audio_path_sha256: "", audio_query_key_count: 0 };
    try {
        const parsed = new URL(raw);
        const queryKeys = [...parsed.searchParams.keys()].sort();
        return {
            audio_host: parsed.host || "",
            audio_protocol: parsed.protocol || "",
            audio_path_sha256: (await sha256Hex(`${parsed.pathname || ""}?${parsed.search || ""}`)).slice(0, 16),
            audio_query_key_count: queryKeys.length,
            audio_query_keys_sha256: (await sha256Hex(queryKeys.join("|"))).slice(0, 16)
        };
    } catch (_) {
        return {
            audio_host: "",
            audio_protocol: "",
            audio_path_sha256: (await sha256Hex(raw)).slice(0, 16),
            audio_query_key_count: 0,
            audio_query_keys_sha256: ""
        };
    }
}

async function summarizeAudioBlob(blob) {
    if (!blob) return { audio_sha256: "", audio_head_tail_sha256: "", audio_bytes: 0, audio_mime: "" };
    const size = Number(blob.size || 0);
    const mime = String(blob.type || "");
    try {
        const buffer = await blob.arrayBuffer();
        const fullHash = await sha256Hex(buffer);
        const bytes = new Uint8Array(buffer);
        const sampleSize = Math.min(65536, bytes.length);
        const sample = new Uint8Array(sampleSize * 2);
        sample.set(bytes.slice(0, sampleSize), 0);
        sample.set(bytes.slice(Math.max(0, bytes.length - sampleSize)), sampleSize);
        return {
            audio_sha256: fullHash.slice(0, 24),
            audio_head_tail_sha256: (await sha256Hex(sample.buffer)).slice(0, 24),
            audio_bytes: size,
            audio_mime: mime
        };
    } catch (_) {
        return { audio_sha256: "", audio_head_tail_sha256: "", audio_bytes: size, audio_mime: mime };
    }
}

function assertAsrAudioNotReused(bvid, audioDigest, context = {}) {
    const normalizedBvid = normalizeBvid(bvid);
    const audioHash = String(audioDigest?.audio_sha256 || "").trim();
    if (!normalizedBvid || !audioHash) return;
    const prev = recentAsrAudioFingerprints.get(audioHash);
    if (prev?.bvid && prev.bvid !== normalizedBvid) {
        logASR.error("asr_audio_reuse_blocked", {
            bvid: normalizedBvid,
            task: "asr",
            provider: context.provider || "",
            model: context.model || "",
            code: "ASR_AUDIO_REUSED_ACROSS_BVID",
            detail: {
                run_id: context.runId || "",
                previous_bvid: prev.bvid,
                previous_run_id: prev.runId || "",
                audio_sha256: audioHash,
                audio_bytes: Number(audioDigest?.audio_bytes || 0),
                audio_host: context.audioHost || ""
            }
        });
        throw createAppError("ASR_AUDIO_REUSED_ACROSS_BVID", "检测到当前视频音频和上一个视频重复，已阻止转录。请刷新页面后重试");
    }
    recentAsrAudioFingerprints.set(audioHash, {
        bvid: normalizedBvid,
        runId: context.runId || "",
        at: Date.now()
    });
    if (recentAsrAudioFingerprints.size > 30) {
        const entries = [...recentAsrAudioFingerprints.entries()].sort((a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0));
        entries.slice(0, recentAsrAudioFingerprints.size - 30).forEach(([key]) => recentAsrAudioFingerprints.delete(key));
    }
}

function isAsrSubtitleSource(source) {
    const value = String(source || "").toLowerCase();
    return value === "groq" || value === "whisper" || value === "siliconflow" || value === "funasr" || value === "mimo" || value === "custom_asr";
}

function isNoTimestampSubtitleSource(source) {
    const value = String(source || "").toLowerCase();
    return value === "siliconflow" || value === "funasr" || value === "mimo";
}

function isNoTimestampSubtitleCache(cache = {}) {
    if (isNoTimestampSubtitleSource(cache?.subtitleSource)) return true;
    const raw = Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle : [];
    if (!raw.length) return false;
    return raw.some((item) => item?.noTimestamp === true)
        || raw.every((item) => {
            const start = Number(item?.from ?? item?.start);
            const end = Number(item?.to ?? item?.end);
            return !Number.isFinite(start) && !Number.isFinite(end);
        });
}

function splitTranscriptionTextByPunctuation(text) {
    const normalized = stripEmojiFromText(text)
        .replace(/\s+/g, " ")
        .trim();
    if (!normalized) return [];
    const pieces = normalized.match(/[^。！？!?；;，,、\n]+[。！？!?；;，,、]?/g) || [normalized];
    const rows = [];
    let buffer = "";
    const flush = () => {
        const value = buffer.trim();
        if (value) rows.push(value);
        buffer = "";
    };
    pieces.forEach((piece) => {
        const value = String(piece || "").trim();
        if (!value) return;
        if (!buffer) {
            buffer = value;
            if (/[。！？!?；;]$/.test(value) || value.length >= 80) flush();
            return;
        }
        if ((buffer + value).length <= 80 && !/[。！？!?；;]$/.test(buffer)) {
            buffer += value;
        } else {
            flush();
            buffer = value;
        }
        if (/[。！？!?；;]$/.test(buffer) || buffer.length >= 80) flush();
    });
    flush();
    return rows.length ? rows : [normalized];
}

function stripEmojiFromText(text) {
    return String(text || "")
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
        .replace(/[\uFE0E\uFE0F\u200D]/g, "")
        .trim();
}

function getFileExtension(filename) {
    const match = String(filename || "").toLowerCase().match(/\.([a-z0-9]{1,8})(?:$|\?)/);
    return match ? match[1] : "";
}

function getBiliQualityDesc(quality) {
    const id = Number(quality || 0);
    const map = {
        6: "240P 极速",
        16: "360P 流畅",
        32: "480P 清晰",
        64: "720P 高清",
        74: "720P60 高帧率",
        80: "1080P 高清",
        112: "1080P+ 高码率",
        116: "1080P60 高帧率",
        120: "4K 超清",
        125: "HDR 真彩",
        126: "杜比视界",
        127: "8K 超高清"
    };
    return map[id] || (id ? `${id} 清晰度` : "默认清晰度");
}

function pickBiliQualityDesc(quality, acceptQuality = [], acceptDescription = []) {
    const id = Number(quality || 0);
    const index = Array.isArray(acceptQuality) ? acceptQuality.findIndex((item) => Number(item) === id) : -1;
    const fromApi = index >= 0 && Array.isArray(acceptDescription) ? String(acceptDescription[index] || "").trim() : "";
    return fromApi || getBiliQualityDesc(id);
}

function normalizeBiliUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    return raw.startsWith("//") ? `https:${raw}` : raw;
}

async function getCurrentBiliVideoIdentity(tabId, fallback = {}) {
    const fallbackBvid = normalizeBvid(fallback?.bvid);
    const fallbackCid = Number(fallback?.cid || 0);
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (fallbackData) => {
                const state = globalThis.__INITIAL_STATE__ || {};
                const videoData = state.videoData || state?.reduxAsyncConnect?.videoData || {};
                const pages = Array.isArray(videoData.pages) ? videoData.pages : [];
                const params = new URLSearchParams(String(location?.search || ""));
                const pageIndex = Math.max(1, Number(params.get("p") || state.p || fallbackData.page || 1) || 1);
                const page = pages.find((item) => Number(item?.page || 0) === pageIndex)
                    || pages[pageIndex - 1]
                    || pages.find((item) => Number(item?.cid || 0) === Number(fallbackData.cid || 0))
                    || pages[0]
                    || {};
                const href = String(location?.href || "");
                const routeBvid = href.match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1] || "";
                const title = String(videoData.title || document?.title || "").replace(/_哔哩哔哩_bilibili\s*$/i, "").trim();
                return {
                    aid: Number(videoData.aid || fallbackData.aid || 0),
                    bvid: String(videoData.bvid || routeBvid || fallbackData.bvid || "").trim(),
                    cid: Number(page.cid || 0),
                    page: pageIndex,
                    title
                };
            },
            args: [{
                bvid: fallbackBvid,
                cid: fallbackCid,
                aid: Number(fallback?.aid || 0),
                page: Number(fallback?.page || fallback?.tid || 1) || 1
            }]
        });
        const identity = results?.[0]?.result || {};
        return {
            aid: Number(identity.aid || fallback?.aid || 0),
            rawBvid: String(identity.bvid || fallback?.bvid || "").trim(),
            bvid: normalizeBvid(identity.bvid || fallbackBvid),
            cid: Number(identity.cid || fallbackCid || 0),
            page: Number(identity.page || fallback?.page || 1),
            title: String(identity.title || fallback?.title || "").trim()
        };
    } catch (_) {
        return {
            aid: Number(fallback?.aid || 0),
            rawBvid: String(fallback?.bvid || "").trim(),
            bvid: fallbackBvid,
            cid: fallbackCid,
            page: Number(fallback?.page || 1),
            title: String(fallback?.title || "").trim()
        };
    }
}

async function fetchBiliPlayUrl(identity, options = {}) {
    const cid = Number(identity?.cid || 0);
    const aid = Number(identity?.aid || 0);
    const bvid = normalizeBvid(identity?.bvid || "");
    const rawBvid = String(identity?.rawBvid || identity?.bvid || "").trim();
    if (!cid || (!aid && !bvid)) {
        throw createAppError("DOWNLOAD_PLAYINFO_MISSING", "缺少当前视频 aid/cid，无法获取兼容下载链接");
    }
    const params = new URLSearchParams({
        otype: "json",
        platform: "html5",
        cid: String(cid),
        fnver: "0",
        high_quality: "1",
        fnval: String(options.fnval || 1)
    });
    if (aid) params.set("avid", String(aid));
    if (rawBvid) params.set("bvid", rawBvid);
    if (Number(options.qn || 0)) params.set("qn", String(Number(options.qn)));
    const response = await fetch(`${BILI_PLAYURL_API}?${params.toString()}`, {
        method: "GET",
        credentials: "include"
    });
    if (!response.ok) {
        const error = createHttpError(response.status, `B站播放接口请求失败：HTTP ${response.status}`);
        error.code = "DOWNLOAD_PLAYURL_API_FAILED";
        throw error;
    }
    const json = await response.json();
    if (Number(json?.code || 0) !== 0) {
        throw createAppError("DOWNLOAD_PLAYURL_API_FAILED", String(json?.message || "B站播放接口返回失败"));
    }
    return json?.data || {};
}

async function fetchBiliPlayUrlForTab(tabId, identity, options = {}) {
    const cid = Number(identity?.cid || 0);
    const aid = Number(identity?.aid || 0);
    const bvid = normalizeBvid(identity?.bvid || "");
    const rawBvid = String(identity?.rawBvid || identity?.bvid || "").trim();
    if (!tabId || !cid || (!aid && !bvid)) {
        throw createAppError("DOWNLOAD_PLAYINFO_MISSING", "缺少当前视频 aid/cid，无法获取兼容下载链接");
    }
    const params = {
        otype: "json",
        platform: "html5",
        cid: String(cid),
        fnver: "0",
        high_quality: "1",
        fnval: String(options.fnval || 1)
    };
    if (aid) params.avid = String(aid);
    if (rawBvid) params.bvid = rawBvid;
    if (Number(options.qn || 0)) params.qn = String(Number(options.qn));
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (baseUrl, query) => new Promise((resolve, reject) => {
            const callbackName = `__bilitatoPlayurl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const script = document.createElement("script");
            const timeoutId = setTimeout(() => finish(new Error("B站播放接口请求超时")), 8000);
            const finish = (error, value) => {
                clearTimeout(timeoutId);
                script.remove();
                try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
                if (error) reject(error);
                else resolve(value);
            };
            window[callbackName] = (value) => finish(null, value);
            script.onerror = () => finish(new Error("B站播放接口加载失败"));
            const params = new URLSearchParams({ ...query, callback: callbackName, jsonp: "jsonp" });
            script.src = `${baseUrl}?${params.toString()}`;
            (document.head || document.documentElement).appendChild(script);
        }),
        args: [BILI_PLAYURL_API, params]
    });
    const json = results?.[0]?.result || {};
    if (Number(json?.code || 0) !== 0) {
        throw createAppError("DOWNLOAD_PLAYURL_API_FAILED", String(json?.message || "B站播放接口返回失败"));
    }
    return json?.data || {};
}

function buildCompatVideoPayload(data, identity, selectedQn = 0) {
    const acceptQuality = Array.isArray(data?.accept_quality) ? data.accept_quality.map(Number).filter(Boolean) : [];
    const acceptDescription = Array.isArray(data?.accept_description) ? data.accept_description : [];
    const qualities = acceptQuality.length
        ? acceptQuality.map((quality) => ({
            quality,
            desc: pickBiliQualityDesc(quality, acceptQuality, acceptDescription)
        }))
        : [Number(data?.quality || selectedQn || 80)].filter(Boolean).map((quality) => ({
            quality,
            desc: pickBiliQualityDesc(quality, acceptQuality, acceptDescription)
        }));
    const durlList = Array.isArray(data?.durl) ? data.durl : [];
    const first = durlList.find((item) => normalizeBiliUrl(item?.url)) || durlList[0] || null;
    const primaryUrl = normalizeBiliUrl(first?.url || "");
    const backupUrls = Array.isArray(first?.backup_url) ? first.backup_url : (Array.isArray(first?.backupUrl) ? first.backupUrl : []);
    const quality = Number(data?.quality || selectedQn || qualities[0]?.quality || 0);
    return {
        identity,
        qualities,
        stream: primaryUrl ? {
            quality,
            desc: pickBiliQualityDesc(quality, acceptQuality, acceptDescription),
            url: primaryUrl,
            urls: [primaryUrl, ...backupUrls.map(normalizeBiliUrl)].filter(Boolean),
            format: String(data?.format || "mp4").trim() || "mp4",
            type: "MP4_COMPAT"
        } : null
    };
}

function buildCompatAudioPayload(data, identity) {
    const audioList = Array.isArray(data?.dash?.audio) ? data.dash.audio : [];
    const streams = audioList
        .map((item) => {
            const primaryUrl = normalizeBiliUrl(item?.baseUrl || item?.base_url || item?.url || "");
            const backupUrls = Array.isArray(item?.backupUrl) ? item.backupUrl : (Array.isArray(item?.backup_url) ? item.backup_url : []);
            const bandwidth = Number(item?.bandwidth || 0);
            return {
                id: Number(item?.id || 0),
                desc: bandwidth ? `${Math.round(bandwidth / 1000)}kbps` : (item?.id ? `Audio ${item.id}` : "音频"),
                url: primaryUrl,
                urls: [primaryUrl, ...backupUrls.map(normalizeBiliUrl)].filter(Boolean),
                bandwidth,
                codecName: "m4a",
                type: "DASH_AUDIO_COMPAT"
            };
        })
        .filter((item) => item.url)
        .sort((a, b) => Number(b.bandwidth || 0) - Number(a.bandwidth || 0));
    return { identity, streams };
}

async function getCompatPlayUrlForTab(tabId, payload = {}) {
    const type = String(payload?.type || "video") === "audio" ? "audio" : "video";
    const qn = Number(payload?.qn || 0);
    const identity = await getCurrentBiliVideoIdentity(tabId, payload);
    const data = await fetchBiliPlayUrlForTab(tabId, identity, {
        fnval: type === "audio" ? 16 : 1,
        qn: type === "video" ? (qn || 80) : 0
    });
    const result = type === "audio"
        ? buildCompatAudioPayload(data, identity)
        : buildCompatVideoPayload(data, identity, qn);
    logDownload.info("download_compat_playurl_success", {
        task: "download",
        bvid: identity.bvid,
        detail: {
            type,
            qn: type === "video" ? Number(qn || data?.quality || 0) : 0,
            cid: identity.cid,
            has_stream: type === "video" ? !!result.stream?.url : Array.isArray(result.streams) && result.streams.length > 0,
            quality_count: Array.isArray(result.qualities) ? result.qualities.length : 0,
            audio_stream_count: Array.isArray(result.streams) ? result.streams.length : 0
        }
    });
    return { ok: true, type, ...result };
}

async function probeUrlStatusForTab(tabId, url) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: async (target) => {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 4000);
                try {
                    const response = await fetch(target, {
                        method: "GET",
                        headers: { Range: "bytes=0-0" },
                        credentials: "omit",
                        cache: "no-store",
                        signal: controller.signal
                    });
                    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
                    if (contentType.includes("text/html") || response.status === 401 || response.status === 403) return "expired";
                    if (response.ok || response.status === 206) return "ok";
                    return "unknown";
                } catch (_) {
                    return "unknown";
                } finally {
                    clearTimeout(timeoutId);
                }
            },
            args: [url]
        });
        return String(results?.[0]?.result || "unknown");
    } catch (_) {
        return "unknown";
    }
}

async function ensureDownloadHeaderRule(url) {
    if (!chrome.declarativeNetRequest?.updateSessionRules) return false;
    const meta = getUrlMeta(url);
    const host = String(meta.host || "").toLowerCase();
    if (!host || !/(bilivideo|hdslb|bilibili)\.(com|cn)$/.test(host)) return false;
    try {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [DOWNLOAD_HEADER_RULE_ID],
            addRules: [{
                id: DOWNLOAD_HEADER_RULE_ID,
                priority: 1,
                action: {
                    type: "modifyHeaders",
                    requestHeaders: [
                        { header: "Referer", operation: "set", value: "https://www.bilibili.com/" }
                    ]
                },
                condition: {
                    urlFilter: `||${host}/`,
                    resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest", "media", "other"]
                }
            }]
        });
        logDownload.info("download_header_rule_enabled", {
            task: "download",
            detail: { url_host: host }
        });
        return true;
    } catch (error) {
        logDownload.warn("download_header_rule_failed", {
            task: "download",
            code: "DOWNLOAD_HEADER_RULE_FAILED",
            detail: {
                url_host: host,
                error: error.message || "failed to enable download headers"
            }
        });
        return false;
    }
}

async function probeDownloadContentType(url) {
    const target = String(url || "").trim();
    if (!target) return null;
    const tryFetch = async (method, headers) => {
        const response = await fetch(target, {
            method,
            headers: headers || undefined,
            redirect: "follow",
            cache: "no-store",
            credentials: "omit"
        });
        return response;
    };
    try {
        const res = await tryFetch("GET", { Range: "bytes=0-0" });
        if (res.type === "opaque") return null;
        const ct = String(res.headers.get("content-type") || "").toLowerCase();
        return { isHtml: ct.includes("text/html") || ct.includes("application/xhtml+xml"), contentType: ct, status: res.status };
    } catch (_) {
        try {
            const res = await tryFetch("HEAD");
            if (res.type === "opaque") return null;
            const ct = String(res.headers.get("content-type") || "").toLowerCase();
            return { isHtml: ct.includes("text/html") || ct.includes("application/xhtml+xml"), contentType: ct, status: res.status };
        } catch (_) {
            return null;
        }
    }
}

async function probeUrlStatus(url) {
    const target = String(url || "").trim();
    if (!target) return "unknown";
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    try {
        const htmlExtReg = /\.(s?html?|xhtml|mhtml)(?:$|[?#])/i;
        const isHtmlLikeResponse = (res) => {
            const ct = String(res.headers.get("content-type") || "").toLowerCase();
            const cd = String(res.headers.get("content-disposition") || "").toLowerCase();
            const finalUrl = String(res.url || "").toLowerCase();
            if (
                ct.includes("text/html")
                || ct.includes("application/xhtml+xml")
                || ct.includes("text/xhtml")
                || ct.includes("application/html")
            ) return true;
            if (htmlExtReg.test(finalUrl)) return true;
            if (htmlExtReg.test(cd)) return true;
            return false;
        };
        const evaluate = (res) => {
            if (isHtmlLikeResponse(res)) return "expired";
            if (res.status === 401 || res.status === 403) return "expired";
            if (res.ok || res.status === 206) return "ok";
            return "unknown";
        };
        const baseInit = {
            method: "GET",
            headers: { Range: "bytes=0-0" },
            referrer: "https://www.bilibili.com/",
            referrerPolicy: "strict-origin-when-cross-origin",
            redirect: "follow",
            cache: "no-store",
            credentials: "omit",
            signal: controller.signal
        };
        try {
            const res = await fetch(target, {
                ...baseInit,
                headers: {
                    ...baseInit.headers,
                    Referer: "https://www.bilibili.com/"
                }
            });
            return evaluate(res);
        } catch (_) {
            const res = await fetch(target, baseInit);
            return evaluate(res);
        }
    } catch (_) {
        return "unknown";
    } finally {
        clearTimeout(timeoutId);
    }
}

async function mergeSettings(patch) {
    const { settings } = await chrome.storage.local.get(["settings"]);
    const base = normalizeSettings(settings);
    const patchObject = patch && typeof patch === "object" ? patch : {};
    const mergedRaw = {
        ...base,
        ...patchObject
    };
    delete mergedRaw.prompts;
    delete mergedRaw.promptSettings;
    const merged = normalizeSettings(mergedRaw);
    const currentPromptSettings = await getPromptSettingsFromSync();
    let nextPromptSettings = currentPromptSettings;
    if (patchObject.promptSettings && typeof patchObject.promptSettings === "object") {
        nextPromptSettings = normalizePromptSettings(patchObject.promptSettings);
    } else if (patchObject.prompts && typeof patchObject.prompts === "object") {
        nextPromptSettings = normalizePromptSettings({
            mode: "custom",
            guided: currentPromptSettings.guided,
            custom: {
                ...currentPromptSettings.custom,
                ...patchObject.prompts
            }
        });
    }
    await chrome.storage.local.set({ settings: merged });
    await chrome.storage.sync.set({ promptSettings: nextPromptSettings });
    return getResolvedSettings();
}

class ContentProvider {
    static async transcribeFallback(tabId, payload) {
        const tabState = await getTabState(tabId);
        const bvid = normalizeBvid(payload?.bvid || tabState?.activeBvid);
        if (!bvid) throw new Error("未找到视频标识，无法转录");
        const cid = Number(payload?.cid || tabState?.activeCid || 0);
        const tid = payload?.tid || tabState?.activeTid || null;
        const title = String(payload?.title || "").trim();
        const normalizedSettings = await getResolvedSettings();
        const requestedAsrProvider = String(normalizedSettings.asrProvider || "groq").toLowerCase();
        const asrProvider = ["groq", "siliconflow", "mimo"].includes(requestedAsrProvider) ? requestedAsrProvider : "groq";
        const asrApiKey = asrProvider === "siliconflow"
            ? String(normalizedSettings.siliconFlowApiKey || "").trim()
            : asrProvider === "mimo"
                ? String(normalizedSettings.mimoApiKey || "").trim()
                : String(normalizedSettings.groqApiKey || "").trim();
        const asrModel = asrProvider === "siliconflow"
            ? (String(normalizedSettings.siliconFlowAsrModel || "").trim() || "FunAudioLLM/SenseVoiceSmall")
            : asrProvider === "mimo"
                ? MIMO_ASR_MODEL
                : (String(normalizedSettings.groqModel || "").trim() || "whisper-large-v3-turbo");
        const asrBaseUrl = normalizeAsrBaseUrl(normalizedSettings.groqBaseUrl, DEFAULT_GROQ_BASE_URL);
        const asrMaxAudioBytes = asrProvider === "siliconflow"
            ? SILICONFLOW_MAX_AUDIO_BYTES
            : (asrProvider === "mimo" ? MIMO_MAX_AUDIO_BYTES : GROQ_MAX_AUDIO_BYTES);
        const asrDisplayName = asrProvider === "siliconflow" ? "硅基流动" : (asrProvider === "mimo" ? "小米 MiMo" : "Groq");
        const subtitleSource = asrProvider;
        const startedAt = Date.now();
        if (!asrApiKey) {
            const asrPromptName = asrProvider === "siliconflow" ? "硅基流动" : (asrProvider === "mimo" ? "Mimo" : "Groq");
            const error = createAppError("MISSING_API_KEY", `请先填写${asrPromptName}的API Key，再开始转录`);
            await reportClientUsageEvent({
                eventName: "transcribe_preflight_blocked",
                featureName: "transcribe",
                status: "blocked",
                errorCode: "MISSING_API_KEY",
                provider: asrProvider,
                model: asrModel,
                bvid,
                title,
                tabId,
                metadata: { reason: "missing_api_key", outcome_category: "usage_blocked" }
            }, normalizedSettings);
            error.__usageEventReported = true;
            throw error;
        }
        const taskId = createUsageTaskId("transcribe");
        await reportClientUsageEvent({
            eventName: "task_started",
            featureName: "transcribe",
            taskId,
            status: "started",
            provider: asrProvider,
            model: asrModel,
            bvid,
            title,
            tabId
        }, normalizedSettings);
        const asrRunId = String(payload?.asrRunId || `asr_${bvid}_${startedAt.toString(36)}`).trim();
        const payloadAudioSummary = await summarizeMediaLocator(payload?.audioUrl || "");
        const operationController = new AbortController();
        const unregisterAbort = registerTabAbortController(tabId, operationController);
        try {
            logASR.info("asr_start", {
                bvid,
                task: "asr",
                provider: asrProvider,
                model: asrModel,
                detail: {
                    run_id: asrRunId,
                    tab_id: tabId,
                    cid: Number.isFinite(cid) ? cid : 0,
                    has_payload_audio_locator: !!payload?.audioUrl,
                    ...payloadAudioSummary
                }
            });
            await updateTabState(tabId, {
                activeBvid: bvid,
                activeCid: Number.isFinite(cid) ? cid : 0,
                activeTid: tid || null,
                subtitleSource,
                transcriptionProgress: 5,
                updatedAt: Date.now()
            });
            await notifyTranscribeStatus(tabId, { stage: "start", level: "info", text: "检测到无字幕，正在转录音轨...", progress: 5, bvid });
            if (asrProvider === "groq") {
                await updateTabState(tabId, { activeBvid: bvid, transcriptionProgress: 12, updatedAt: Date.now() });
                await notifyTranscribeStatus(tabId, { stage: "connectivity_check", level: "info", text: "正在检查 Groq 服务器连接...", progress: 12, bvid });
                await this.ensureGroqConnectivity(asrApiKey, tabId, bvid, operationController.signal, asrBaseUrl);
            }
            const media = await this.extractAudioSourceFromTab(tabId, { ...payload, asrProvider });
            if (!media?.url) throw new Error("未提取到音轨地址，可能是付费视频、CDN 限制或页面未完成加载");
            const effectiveCid = Number(media?.cid || media?.pageCid || cid || 0);
            const effectiveTid = media?.tid || media?.page || tid || null;
            const mediaSummary = await summarizeMediaLocator(media.url);
            const mediaPageBvid = normalizeBvid(media?.pageBvid || "");
            logASR.info("asr_audio_source_selected", {
                bvid,
                task: "asr",
                provider: asrProvider,
                model: asrModel,
                detail: {
                    run_id: asrRunId,
                    tab_id: tabId,
                    media_source: String(media?.source || ""),
                    media_page_bvid: mediaPageBvid,
                    media_cid: effectiveCid,
                    media_page: media?.page || null,
                    expected_bvid: bvid,
                    source_bvid_matched: !mediaPageBvid || mediaPageBvid === bvid,
                    ...mediaSummary
                }
            });
            if (mediaPageBvid && mediaPageBvid !== bvid) {
                logASR.warn("asr_audio_source_bvid_mismatch", {
                    bvid,
                    task: "asr",
                    provider: asrProvider,
                    model: asrModel,
                    code: "ASR_AUDIO_SOURCE_BVID_MISMATCH",
                    detail: {
                        run_id: asrRunId,
                        media_page_bvid: mediaPageBvid,
                        expected_bvid: bvid,
                        media_source: String(media?.source || "")
                    }
                });
            }
            await updateTabState(tabId, {
                activeBvid: bvid,
                activeCid: Number.isFinite(effectiveCid) ? effectiveCid : 0,
                activeTid: effectiveTid,
                transcriptionProgress: 20,
                updatedAt: Date.now()
            });
            await notifyTranscribeStatus(tabId, { stage: "download", level: "info", text: "正在下载音轨...", progress: 20, bvid });
            const audioFetchStartedAt = Date.now();
            const shouldAllowOversizeDownload = true;
            const audioFetchResult = await this.fetchAudioResourceWithFallback(
                media,
                tabId,
                bvid,
                shouldAllowOversizeDownload,
                asrMaxAudioBytes,
                operationController.signal,
                { provider: asrProvider, model: asrModel, runId: asrRunId }
            );
            const audioBlob = audioFetchResult.blob;
            const selectedAudioUrl = audioFetchResult.url;
            await updateTabState(tabId, { activeBvid: bvid, transcriptionProgress: 56, updatedAt: Date.now() });
            await notifyTranscribeStatus(tabId, { stage: "prepare_upload", level: "info", text: `下载完成，正在准备上传到 ${asrDisplayName}...`, progress: 56, bvid });
            const audioFetchMs = Date.now() - audioFetchStartedAt;
            const audioDigest = await summarizeAudioBlob(audioBlob);
            assertAsrAudioNotReused(bvid, audioDigest, {
                runId: asrRunId,
                provider: asrProvider,
                model: asrModel,
                audioHost: getUrlMeta(selectedAudioUrl).host
            });
            logASR.info("asr_audio_fetch_success", {
                bvid,
                task: "asr",
                provider: asrProvider,
                model: asrModel,
                duration_ms: audioFetchMs,
                detail: {
                    run_id: asrRunId,
                    media_source: String(media?.source || ""),
                    ...audioDigest,
                    audio_host: getUrlMeta(selectedAudioUrl).host,
                    audio_host_attempt: audioFetchResult.attempt
                }
            });
            let transcription;
            const asrRequestStartedAt = Date.now();
            if (asrProvider === "mimo" || audioBlob.size >= asrMaxAudioBytes) {
                await updateTabState(tabId, { activeBvid: bvid, transcriptionProgress: 58, updatedAt: Date.now() });
                await notifyTranscribeStatus(tabId, {
                    stage: "chunk_prepare",
                    level: "info",
                    text: asrProvider === "mimo"
                        ? "正在转换为小米 MiMo 支持的 MP3 音频..."
                        : "音轨较大，正在切片后分段转录...",
                    progress: 58,
                    bvid
                });
                transcription = asrProvider === "siliconflow"
                    ? await this.requestSiliconFlowChunkedTranscription(audioBlob, {
                        tabId,
                        bvid,
                        asrApiKey,
                        asrModel,
                        maxAudioBytes: asrMaxAudioBytes,
                        audioUrl: selectedAudioUrl,
                        signal: operationController.signal
                    })
                    : await this.requestGroqChunkedTranscription(audioBlob, {
                        tabId,
                        bvid,
                        videoTitle: title || media.title || "",
                        groqApiKey: asrApiKey,
                        groqModel: asrModel,
                        baseUrl: asrBaseUrl,
                        provider: asrProvider,
                        maxAudioBytes: asrMaxAudioBytes,
                        audioUrl: selectedAudioUrl,
                        signal: operationController.signal
                    });
            } else {
                const audioFile = new File([audioBlob], "audio.m4a", { type: audioBlob.type || "audio/mp4" });
                await updateTabState(tabId, { activeBvid: bvid, transcriptionProgress: 55, updatedAt: Date.now() });

                let fakeProgress = 55;
                await notifyTranscribeStatus(tabId, { stage: "upload", level: "info", text: `正在上传音轨到 ${asrDisplayName}...`, progress: fakeProgress, bvid });

                let uploadStageActive = true;
                const progressTimer = setInterval(() => {
                    if (!uploadStageActive || operationController.signal.aborted) return;
                    const inc = 2 + Math.floor(Math.random() * 2);
                    fakeProgress = Math.min(88, fakeProgress + inc);
                    updateTabState(tabId, { activeBvid: bvid, transcriptionProgress: fakeProgress, updatedAt: Date.now() }).catch(() => {});
                    notifyTranscribeStatus(tabId, {
                        stage: "upload",
                        level: "info",
                        text: `正在上传音轨到 ${asrDisplayName}...`,
                        progress: fakeProgress,
                        bvid
                    }).catch(() => {});
                }, 2000);

                try {
                    transcription = asrProvider === "siliconflow"
                        ? await this.requestSiliconFlowTranscription(audioFile, asrApiKey, asrModel, tabId, bvid, operationController.signal)
                        : await this.requestGroqTranscription(audioFile, asrApiKey, asrModel, tabId, bvid, title || media.title || "", operationController.signal, asrBaseUrl);
                } finally {
                    uploadStageActive = false;
                    clearInterval(progressTimer);
                }
            }
            logASR.info("asr_request_success", {
                bvid,
                task: "asr",
                provider: asrProvider,
                model: asrModel,
                duration_ms: Date.now() - asrRequestStartedAt,
                detail: {
                    run_id: asrRunId,
                    audio_bytes: audioBlob.size || 0,
                    audio_sha256: audioDigest.audio_sha256,
                    quota: buildGroqQuotaLine(transcription.quota),
                    chunked: !!transcription?.meta?.chunked,
                    chunk_count: Number(transcription?.meta?.chunkCount || 0) || undefined
                }
            });

            await notifyTranscribeStatus(tabId, { stage: "parse", level: "info", text: `${asrDisplayName} 正在解析中文字幕...`, progress: 90, bvid });
            await updateTabState(tabId, { activeBvid: bvid, transcriptionProgress: 90, updatedAt: Date.now() });
            const rows = this.mapTranscriptionToRows(transcription.data, { noTimestamp: asrProvider === "siliconflow" || asrProvider === "mimo" });
            if (!rows.length) throw new Error("转录返回为空，未生成可用字幕");
            await handleSubtitleCaptured(tabId, {
                bvid,
                cid: Number.isFinite(effectiveCid) ? effectiveCid : 0,
                tid: effectiveTid,
                title: title || media.title || "",
                subtitle: rows,
                source: subtitleSource
            });
            await updateTabState(tabId, {
                activeBvid: bvid,
                activeCid: Number.isFinite(effectiveCid) ? effectiveCid : 0,
                activeTid: effectiveTid,
                subtitleSource,
                transcriptionProgress: 100,
                updatedAt: Date.now()
            });
            await notifyTranscribeStatus(tabId, {
                stage: "done",
                level: "success",
                text: "转录成功，已写入字幕",
                progress: 100,
                quotaLine: buildGroqQuotaLine(transcription.quota),
                bvid
            });
            logASR.info("asr_success", {
                bvid,
                task: "asr",
                provider: asrProvider,
                model: asrModel,
                duration_ms: Date.now() - startedAt,
                detail: {
                    run_id: asrRunId,
                    rows: rows.length,
                    audio_bytes: audioBlob.size || 0,
                    audio_sha256: audioDigest.audio_sha256
                }
            });
            await reportFeatureUsage("transcribe", bvid, normalizedSettings, {
                tokens: 0,
                latencyMs: Math.max(0, Date.now() - startedAt),
                provider: asrProvider,
                model: asrModel,
                title: title || media.title || ""
            });
            await reportClientUsageEvent({
                eventName: "task_success",
                featureName: "transcribe",
                taskId,
                status: "success",
                provider: asrProvider,
                model: asrModel,
                bvid,
                title: title || media.title || "",
                durationMs: Date.now() - startedAt,
                tabId,
                metadata: {
                    rows: rows.length,
                    chunked: !!transcription?.meta?.chunked,
                    chunk_count: Number(transcription?.meta?.chunkCount || 0) || undefined
                }
            }, normalizedSettings);
            return { rows: rows.length, quota: transcription.quota };
        } catch (error) {
            const usageBlocked = isNonSoftwareTaskBlocker(error);
            attachSentryContext(error, {
                task: "transcribe",
                task_id: taskId,
                tabId,
                bvid,
                provider: asrProvider,
                model: asrModel
            });
            if (!error?.__usageEventReported) {
                await reportClientUsageEvent({
                    eventName: error?.code === "ABORTED" ? "task_cancelled" : (usageBlocked ? "task_blocked" : "task_failed"),
                    featureName: "transcribe",
                    taskId,
                    provider: asrProvider,
                    model: asrModel,
                    bvid,
                    title,
                    tabId,
                    ...buildUsageErrorPayload(error, {
                        startedAt,
                        errorCode: "ASR_FAILED",
                        status: usageBlocked ? "blocked" : "",
                        metadata: usageBlocked ? { outcome_category: "usage_blocked" } : {}
                    })
                }, normalizedSettings);
            }
            await updateTabState(tabId, { activeBvid: bvid, transcriptionProgress: 0, updatedAt: Date.now() });
            await notifyTranscribeStatus(tabId, {
                stage: "error",
                level: "error",
                text: error?.message || "转录失败，请重试",
                progress: 0,
                bvid
            });
            await reportDailyFeatureUsage("transcribe", normalizedSettings, {
                durationMs: Date.now() - startedAt,
                tokens: 0
            }, usageBlocked ? "blocked" : resolveUsageStatusByError(error), resolveUsageErrorCode(error, "ASR_FAILED"), {
                bvid,
                title: title || media.title || ""
            });
            const failureLog = buildFailureLog(error, {
                bvid,
                task: "asr",
                provider: asrProvider,
                model: asrModel,
                duration_ms: Date.now() - startedAt,
                detail: {
                    run_id: asrRunId,
                    tab_id: tabId,
                    cid: Number.isFinite(cid) ? cid : 0
                }
            });
            if (usageBlocked) logASR.warn("asr_blocked", failureLog);
            else logASR.error("asr_failed", failureLog);
            throw error;
        } finally {
            unregisterAbort();
        }
    }

    static async extractAudioSourceFromTab(tabId, payload) {
        const requestedProvider = String(payload?.asrProvider || "").toLowerCase();
        const provider = ["groq", "siliconflow", "mimo"].includes(requestedProvider) ? requestedProvider : "groq";
        let identityMismatchError = null;
        // 优先按当前 tab 的 aid/cid 主动请求 B 站 playurl，避免 SPA 页面缓存音频串线。
        try {
            const result = await getCompatPlayUrlForTab(tabId, {
                ...payload,
                type: "audio"
            });
            const expectedBvid = normalizeBvid(payload?.bvid || "");
            const identityBvid = normalizeBvid(result?.identity?.bvid || "");
            const audio = Array.isArray(result?.streams) ? result.streams[0] : null;
            if (audio?.url && (!expectedBvid || !identityBvid || expectedBvid === identityBvid)) {
                return {
                    url: audio.url,
                    urls: audio.urls,
                    title: String(result?.identity?.title || payload?.title || "").trim(),
                    source: "playurl_api_audio",
                    pageBvid: identityBvid || expectedBvid,
                    cid: Number(result?.identity?.cid || payload?.cid || 0),
                    page: Number(result?.identity?.page || payload?.tid || 0) || null,
                    tid: result?.identity?.page ? String(result.identity.page) : (payload?.tid || null)
                };
            }
            if (expectedBvid && identityBvid && expectedBvid !== identityBvid) {
                logASR.warn("asr_playurl_identity_mismatch", {
                    bvid: expectedBvid,
                    task: "asr",
                    provider,
                    code: "ASR_PLAYURL_IDENTITY_MISMATCH",
                    detail: {
                        playurl_bvid: identityBvid,
                        expected_bvid: expectedBvid
                    }
                });
                identityMismatchError = createAppError("ASR_AUDIO_SOURCE_BVID_MISMATCH", "当前视频状态已变化，请等待页面刷新后重试");
            }
        } catch (error) {
            logASR.warn("asr_playurl_audio_fetch_failed", {
                bvid: normalizeBvid(payload?.bvid || ""),
                task: "asr",
                provider,
                code: error?.code || "ASR_PLAYURL_AUDIO_FETCH_FAILED",
                detail: {
                    reason: error?.message || "playurl audio fetch failed"
                }
            });
        }

        if (identityMismatchError) throw identityMismatchError;

        // 降级使用 content.js 传来的音频地址。
        if (payload?.audioUrl) {
            const title = String(payload.title || "").trim();
            return {
                url: payload.audioUrl,
                title,
                source: "content_payload",
                pageBvid: normalizeBvid(payload?.bvid || ""),
                cid: Number(payload?.cid || 0),
                page: Number(payload?.tid || 0) || null,
                tid: payload?.tid || null
            };
        }
        // 降级：executeScript 读 __playinfo__（兜底，SPA 下可能是旧视频数据）
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (fallbackData) => {
                const playinfo = globalThis.__playinfo__ || globalThis.window?.__playinfo__;
                const state = globalThis.__INITIAL_STATE__ || {};
                const videoData = state.videoData || state?.reduxAsyncConnect?.videoData || {};
                const pages = Array.isArray(videoData.pages) ? videoData.pages : [];
                const params = new URLSearchParams(String(location?.search || ""));
                const pageIndex = Math.max(1, Number(params.get("p") || state.p || fallbackData.page || 1) || 1);
                const page = pages.find((item) => Number(item?.page || 0) === pageIndex)
                    || pages[pageIndex - 1]
                    || pages.find((item) => Number(item?.cid || 0) === Number(fallbackData.cid || 0))
                    || {};
                const data = playinfo?.data || {};
                const dash = data?.dash || {};
                const audioList = Array.isArray(dash?.audio) ? dash.audio : [];
                const first = audioList.find((item) => item?.baseUrl || item?.base_url) || audioList[0] || null;
                const title = String(document?.title || "").replace(/_哔哩哔哩_bilibili\s*$/i, "").trim();
                const match = String(location?.href || "").match(/\/video\/(BV[a-zA-Z0-9]+)/i);
                return {
                    url: first?.baseUrl || first?.base_url || "",
                    title,
                    source: "main_world_playinfo",
                    pageBvid: match ? match[1] : "",
                    cid: Number(page?.cid || fallbackData.cid || 0),
                    page: pageIndex,
                    tid: String(pageIndex)
                };
            },
            args: [{ cid: Number(payload?.cid || 0), page: Number(payload?.tid || payload?.page || 1) || 1 }]
        });
        return results?.[0]?.result || null;
    }

    static async fetchResourceToBlob(url, tabId, bvid = "", skipSizeCheck = false, maxBytes = GROQ_MAX_AUDIO_BYTES, signal = null) {
        const response = await fetch(url, {
            method: "GET",
            credentials: "omit",
            mode: "cors",
            headers: {
                "Referer": "https://www.bilibili.com/",
                "User-Agent": navigator.userAgent
            },
            signal
        });
        if (!response.ok) {
            if (response.status === 403) throw createAppError("DOWNLOAD_FAILED", "资源下载失败：CDN 返回 403，可能是付费/受限内容", { status: 403 });
            throw createAppError("DOWNLOAD_FAILED", `资源下载失败：HTTP ${response.status}`, { status: response.status });
        }
        const total = Number(response.headers.get("content-length") || 0);
        const responseLocator = await summarizeMediaLocator(response.url || url);
        logASR.info("asr_audio_response_headers", {
            bvid,
            task: "asr",
            status: response.status,
            detail: {
                tab_id: tabId,
                byte_length_header: Number.isFinite(total) ? total : 0,
                mime_header: String(response.headers.get("content-type") || ""),
                range_supported: String(response.headers.get("accept-ranges") || ""),
                final_audio_host: responseLocator.audio_host,
                final_audio_path_sha256: responseLocator.audio_path_sha256
            }
        });
        if (!skipSizeCheck && Number.isFinite(total) && total >= maxBytes) {
            const limitMb = Math.floor(maxBytes / 1024 / 1024);
            throw createAppError("ASR_FILE_TOO_LARGE", `该文件大小超出限制（>=${limitMb}MB），目前暂不支持`);
        }
        const reader = response.body?.getReader?.();
        if (!reader) {
            const blob = await response.blob();
            if (!skipSizeCheck) await notifyTranscribeStatus(tabId, { stage: "download", level: "info", text: "下载进度：100%", progress: 55, bvid });
            return blob;
        }
        const chunks = [];
        let loaded = 0;
        let nextMark = 10;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                chunks.push(value);
                loaded += value.length;
            }
            if (!skipSizeCheck && total > 0) {
                const pct = Math.floor((loaded / total) * 100);
                if (pct >= nextMark) {
                    const clamped = Math.min(100, pct);
                    const progress = 20 + Math.round(clamped * 0.35);
                    await notifyTranscribeStatus(tabId, { stage: "download", level: "info", text: `下载进度：${clamped}%`, progress, bvid });
                    nextMark += 10;
                }
            }
            if (!skipSizeCheck && loaded >= maxBytes) {
                const limitMb = Math.floor(maxBytes / 1024 / 1024);
                throw createAppError("ASR_FILE_TOO_LARGE", `该文件大小超出限制（>=${limitMb}MB），目前暂不支持`);
            }
        }
        const blob = new Blob(chunks, { type: response.headers.get("content-type") || "application/octet-stream" });
        if (!skipSizeCheck) await notifyTranscribeStatus(tabId, { stage: "download", level: "info", text: "下载进度：100%", progress: 55, bvid });
        return blob;
    }

    static async fetchResourceToBlobFromTab(url, tabId, bvid = "", skipSizeCheck = false, maxBytes = GROQ_MAX_AUDIO_BYTES, signal = null) {
        if (!Number(tabId) || !chrome.scripting?.executeScript) {
            throw createAppError("ASR_PAGE_FETCH_UNAVAILABLE", "当前页面无法代为读取音轨");
        }
        const chunks = [];
        let loaded = 0;
        let mime = "application/octet-stream";
        let completed = false;
        for (let index = 0; index < ASR_PAGE_FETCH_MAX_CHUNKS; index += 1) {
            if (signal?.aborted) throw createUserAbortedError();
            const start = index * ASR_PAGE_FETCH_CHUNK_BYTES;
            const end = start + ASR_PAGE_FETCH_CHUNK_BYTES - 1;
            const results = await chrome.scripting.executeScript({
                target: { tabId: Number(tabId) },
                world: "MAIN",
                func: async ({ targetUrl, rangeStart, rangeEnd }) => {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort("timeout"), 20000);
                    try {
                        const response = await fetch(targetUrl, {
                            method: "GET",
                            headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
                            credentials: "omit",
                            cache: "no-store",
                            signal: controller.signal
                        });
                        const contentType = String(response.headers.get("content-type") || "").toLowerCase();
                        if (response.status === 416) {
                            return { ok: true, status: 416, byteLength: 0, contentType, dataBase64: "" };
                        }
                        if (!(response.ok || response.status === 206)) {
                            return { ok: false, status: response.status, byteLength: 0, contentType, reason: `HTTP ${response.status}` };
                        }
                        if (contentType.includes("text/html")) {
                            return { ok: false, status: response.status, byteLength: 0, contentType, reason: "CDN 返回了 HTML" };
                        }
                        const bytes = new Uint8Array(await response.arrayBuffer());
                        let binary = "";
                        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
                            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
                        }
                        return {
                            ok: true,
                            status: response.status,
                            byteLength: bytes.length,
                            contentType,
                            dataBase64: btoa(binary)
                        };
                    } catch (error) {
                        return {
                            ok: false,
                            status: 0,
                            byteLength: 0,
                            contentType: "",
                            reason: error?.name === "AbortError" ? "页面分块下载超时" : String(error?.message || error || "页面分块下载失败")
                        };
                    } finally {
                        clearTimeout(timeoutId);
                    }
                },
                args: [{ targetUrl: url, rangeStart: start, rangeEnd: end }]
            });
            const result = results?.[0]?.result;
            if (!result?.ok) {
                const error = createAppError(
                    "ASR_PAGE_AUDIO_FETCH_FAILED",
                    String(result?.reason || "页面分块下载音轨失败"),
                    { status: Number(result?.status || 0) || undefined }
                );
                error.status = Number(result?.status || 0) || undefined;
                throw error;
            }
            if (result.status === 416) {
                completed = true;
                break;
            }
            const base64 = String(result.dataBase64 || "");
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let offset = 0; offset < binary.length; offset += 1) bytes[offset] = binary.charCodeAt(offset);
            if (!bytes.length) throw createAppError("ASR_PAGE_AUDIO_EMPTY_CHUNK", "页面返回了空音轨分块");
            chunks.push(bytes);
            loaded += bytes.length;
            mime = String(result.contentType || mime || "application/octet-stream");
            if (!skipSizeCheck && loaded >= maxBytes) {
                const limitMb = Math.floor(maxBytes / 1024 / 1024);
                throw createAppError("ASR_FILE_TOO_LARGE", `该文件大小超出限制（>=${limitMb}MB），目前暂不支持`);
            }
            if (result.status === 200 || bytes.length < ASR_PAGE_FETCH_CHUNK_BYTES) {
                completed = true;
                break;
            }
        }
        if (!chunks.length) throw createAppError("ASR_PAGE_AUDIO_EMPTY", "页面未返回可用音轨数据");
        if (!completed) throw createAppError("ASR_PAGE_AUDIO_TOO_MANY_CHUNKS", "音轨分块数量超过安全上限");
        logASR.info("asr_audio_page_fetch_success", {
            bvid,
            task: "asr",
            detail: { tab_id: Number(tabId), audio_bytes: loaded, chunk_count: chunks.length }
        });
        return new Blob(chunks, { type: mime });
    }

    static async fetchAudioResourceWithFallback(media, tabId, bvid = "", skipSizeCheck = false, maxBytes = GROQ_MAX_AUDIO_BYTES, signal = null, context = {}) {
        const candidateUrls = getAsrAudioCandidateUrls(media);
        if (!candidateUrls.length) throw new Error("未找到可用音轨地址");
        let lastError = null;
        for (let index = 0; index < candidateUrls.length; index += 1) {
            const url = candidateUrls[index];
            const locator = await summarizeMediaLocator(url);
            const attempt = index + 1;
            try {
                // Refresh any legacy session rule before fetching. Rewriting Origin would
                // make Chrome compare the Bilibili ACAO value with the immutable extension origin.
                await ensureDownloadHeaderRule(url);
                logASR.info("asr_audio_fetch_host_attempt", {
                    bvid,
                    task: "asr",
                    provider: String(context?.provider || ""),
                    model: String(context?.model || ""),
                    detail: {
                        run_id: String(context?.runId || ""),
                        attempt,
                        candidate_count: candidateUrls.length,
                        audio_host: locator.audio_host,
                        audio_path_sha256: locator.audio_path_sha256
                    }
                });
                let blob;
                try {
                    blob = await this.fetchResourceToBlob(url, tabId, bvid, skipSizeCheck, maxBytes, signal);
                } catch (extensionError) {
                    if (signal?.aborted || extensionError?.code === "ABORTED") throw extensionError;
                    logASR.warn("asr_audio_extension_fetch_failed", {
                        bvid,
                        task: "asr",
                        provider: String(context?.provider || ""),
                        model: String(context?.model || ""),
                        code: String(extensionError?.code || "ASR_EXTENSION_AUDIO_FETCH_FAILED"),
                        status: Number(extensionError?.status || 0) || undefined,
                        detail: {
                            run_id: String(context?.runId || ""),
                            attempt,
                            audio_host: locator.audio_host,
                            reason: String(extensionError?.message || extensionError || "extension audio fetch failed"),
                            fallback: "page_fetch"
                        }
                    });
                    blob = await this.fetchResourceToBlobFromTab(url, tabId, bvid, skipSizeCheck, maxBytes, signal);
                }
                return { blob, url, attempt };
            } catch (error) {
                if (signal?.aborted || error?.code === "ABORTED") throw error;
                lastError = error;
                logASR.warn("asr_audio_fetch_host_failed", {
                    bvid,
                    task: "asr",
                    provider: String(context?.provider || ""),
                    model: String(context?.model || ""),
                    code: String(error?.code || "ASR_AUDIO_FETCH_FAILED"),
                    status: Number(error?.status || 0) || undefined,
                    detail: {
                        run_id: String(context?.runId || ""),
                        attempt,
                        candidate_count: candidateUrls.length,
                        audio_host: locator.audio_host,
                        audio_path_sha256: locator.audio_path_sha256,
                        reason: String(error?.message || error || "audio fetch failed")
                    }
                });
            }
        }
        throw lastError || new Error("所有音轨 CDN 均下载失败");
    }

    static async ensureGroqConnectivity(groqApiKey, tabId, bvid = "", externalSignal = null, baseUrl = DEFAULT_GROQ_BASE_URL) {
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(externalSignal?.reason || "aborted");
        if (externalSignal) {
            if (externalSignal.aborted) forwardAbort();
            else externalSignal.addEventListener("abort", forwardAbort, { once: true });
        }
        const timeoutId = setTimeout(() => controller.abort("timeout"), GROQ_CONNECTIVITY_TIMEOUT_MS);
        const startedAt = Date.now();
        try {
            const response = await fetch(buildAsrEndpoint(baseUrl, "models", DEFAULT_GROQ_BASE_URL), {
                method: "GET",
                headers: { Authorization: `Bearer ${groqApiKey}` },
                signal: controller.signal
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => "");
                if (response.status === 401) {
                    throw createAppError("HTTP_401", "Groq API Key 无效，请检查设置中的 Groq API Key。", { status: response.status });
                }
                if (response.status === 403) {
                    throw createAppError(
                        "ASR_GROQ_ACCESS_BLOCKED",
                        "Groq 服务器拒绝了当前网络请求（Forbidden），请检查代理或设备是否能正常访问国际互联网后重试。",
                        { status: response.status, detail: detail.slice(0, 180) }
                    );
                }
                throw createHttpError(response.status, `Groq 连接预检失败（HTTP ${response.status}）${detail ? `：${detail.slice(0, 180)}` : ""}`);
            }
            logASR.info("groq_connectivity_check_success", {
                bvid,
                task: "asr",
                provider: "groq",
                status: response.status,
                duration_ms: Date.now() - startedAt
            });
            return response.status;
        } catch (error) {
            if (error?.code && error.code !== "ASR_GROQ_UNREACHABLE") throw error;
            if (controller.signal.aborted && controller.signal.reason !== "timeout") throw createUserAbortedError();
            const appError = createAppError(
                "ASR_GROQ_UNREACHABLE",
                "无法连接 Groq 服务器，请检查设备是否能正常访问国际互联网。"
            );
            attachSentryContext(appError, {
                provider: "groq_asr",
                request_name: "groq_connectivity_check",
                timeout_ms: GROQ_CONNECTIVITY_TIMEOUT_MS,
                elapsed_ms: Date.now() - startedAt,
                network_error: String(error?.message || error || "")
            });
            logASR.warn("groq_connectivity_check_failed", {
                bvid,
                task: "asr",
                provider: "groq",
                code: appError.code,
                duration_ms: Date.now() - startedAt,
                detail: {
                    reason: error?.message || "connectivity check failed",
                    aborted: !!controller.signal.aborted,
                    abort_reason: String(controller.signal.reason || "")
                }
            });
            await notifyTranscribeStatus(tabId, {
                stage: "error",
                level: "error",
                text: appError.message,
                progress: 0,
                bvid
            });
            throw appError;
        } finally {
            if (externalSignal) externalSignal.removeEventListener("abort", forwardAbort);
            clearTimeout(timeoutId);
        }
    }

    static async requestGroqTranscription(audioFile, groqApiKey, groqModel, tabId, bvid = "", videoTitle = "", externalSignal = null, baseUrl = DEFAULT_GROQ_BASE_URL) {
        const providerLabel = "Groq";
        const formData = new FormData();
        formData.append("file", audioFile);
        formData.append("model", groqModel);
        formData.append("response_format", "verbose_json");
        formData.append("prompt", buildGroqTranscriptionPrompt(videoTitle));
        formData.append("timestamp_granularities[]", "segment");
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(externalSignal?.reason || "aborted");
        if (externalSignal) {
            if (externalSignal.aborted) forwardAbort();
            else externalSignal.addEventListener("abort", forwardAbort, { once: true });
        }
        const timeoutId = setTimeout(() => controller.abort("timeout"), ASR_TASK_TIMEOUT_MS);
        let response;
        try {
            response = await fetch(buildAsrEndpoint(baseUrl, "audio/transcriptions", DEFAULT_GROQ_BASE_URL), {
                method: "POST",
                headers: { Authorization: `Bearer ${groqApiKey}` },
                body: formData,
                signal: controller.signal
            });
        } catch (error) {
            if (controller.signal.aborted) {
                if (controller.signal.reason === "timeout") {
                    const timeoutError = createTaskTimeoutError("ASR_REQUEST_TIMEOUT", "转录请求超时，请稍后重试");
                    attachSentryContext(timeoutError, {
                        provider: "groq_asr",
                        model: String(groqModel || ""),
                        timeout_ms: ASR_TASK_TIMEOUT_MS,
                        request_stream: false,
                        bypass_queue: true
                    });
                    throw timeoutError;
                }
                throw createUserAbortedError();
            }
            throw error;
        } finally {
            if (externalSignal) externalSignal.removeEventListener("abort", forwardAbort);
            clearTimeout(timeoutId);
        }
        const quota = parseGroqQuotaHeaders(response.headers);
        await updateTabState(tabId, {
            quotaInfo: {
                ...quota,
                at: Date.now(),
                status: response.status
            },
            updatedAt: Date.now()
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            if (response.status === 429) {
                const retryAfterSec = parseRetryAfterSeconds(response.headers.get("retry-after"), detail);
                await updateTabState(tabId, {
                    quotaInfo: {
                        ...quota,
                        retryAfterSec,
                        at: Date.now(),
                        status: response.status
                    },
                    updatedAt: Date.now()
                });
                await notifyTranscribeStatus(tabId, {
                    stage: "error",
                    level: "error",
                    text: retryAfterSec > 0 ? `${providerLabel} 限流，请等待 ${retryAfterSec} 秒后重试` : `${providerLabel} 限流，请稍后重试`,
                    progress: 0,
                    retryAfterSec,
                    quotaLine: buildGroqQuotaLine(quota),
                    bvid
                });
                throw createAppError("ASR_RATE_LIMIT", retryAfterSec > 0 ? `${providerLabel} 限流，请等待 ${retryAfterSec} 秒后重试` : `${providerLabel} 限流，请稍后重试`, { status: response.status, retryAfterSec });
            }
            throw createHttpError(response.status, `${providerLabel} 转录失败（${response.status}）${detail ? `：${detail.slice(0, 180)}` : ""}`);
        }
        await notifyTranscribeStatus(tabId, {
            stage: "upload",
            level: "info",
            text: "上传进度：100%",
            progress: 70,
            quotaLine: buildGroqQuotaLine(quota),
            bvid
        });
        const data = await response.json().catch(() => null);
        return { data, quota };
    }

    static async requestGroqChunkedTranscription(audioBlob, options = {}) {
        const tabId = Number(options.tabId || 0);
        const bvid = normalizeBvid(options.bvid || "");
        const videoTitle = String(options.videoTitle || "").trim();
        const groqApiKey = String(options.groqApiKey || "").trim();
        const groqModel = String(options.groqModel || "").trim() || "whisper-large-v3-turbo";
        const provider = String(options.provider || "groq").toLowerCase() === "mimo" ? "mimo" : "groq";
        const maxAudioBytes = Number(options.maxAudioBytes || GROQ_MAX_AUDIO_BYTES);
        const signal = options.signal || null;
        if (signal?.aborted) throw createUserAbortedError();
        let chunkSessionId = "";
        try {
            const chunked = await requestOffscreenAudioChunkingPrepare({
                audioBlob,
                audioUrl: String(options.audioUrl || "").trim(),
                mimeType: audioBlob.type || "audio/mp4",
                maxAudioBytes,
                signal,
                bvid,
                provider,
                model: groqModel
            });
            chunkSessionId = String(chunked?.sessionId || "").trim();
            logASR.info("asr_chunk_plan_created", {
                bvid,
                task: "asr",
                provider,
                model: groqModel,
                detail: {
                    total_audio_bytes: audioBlob.size,
                    duration_sec: Number(chunked?.durationSec || 0),
                    chunk_seconds: Number(chunked?.chunkSeconds || 0),
                    overlap_seconds: Number(chunked?.overlapSeconds || DEFAULT_ASR_CHUNK_OVERLAP_SECONDS),
                    chunk_count: Number(chunked?.chunkCount || 0)
                }
            });
            const chunks = Array.isArray(chunked?.chunks) ? chunked.chunks : [];
            if (chunks.some((chunk) => chunk.bytes >= maxAudioBytes)) {
                throw createAppError("ASR_CHUNKING_UNSUPPORTED", "自动切片后单段音轨仍超出限制，请稍后再试");
            }
            await updateTabState(tabId, { activeBvid: bvid, transcriptionProgress: 68, updatedAt: Date.now() });
            await notifyTranscribeStatus(tabId, {
                stage: "upload",
                level: "info",
                text: `正在转录 ${chunks.length} 段音轨...`,
                progress: 68,
                bvid
            });
            const chunkResult = await requestOffscreenChunkTranscriptionAll({
                sessionId: chunkSessionId,
                provider,
                tabId,
                bvid,
                apiKey: groqApiKey,
                model: groqModel,
                baseUrl: String(options.baseUrl || DEFAULT_GROQ_BASE_URL),
                videoTitle
            });
            const mergedRows = Array.isArray(chunkResult?.rows) ? chunkResult.rows : [];
            const quota = chunkResult?.quota || null;
            await recordAsrChunkingDebugState(tabId, chunkResult?.diagnostics || null);
            return {
                data: {
                    text: mergedRows.map((row) => row.text).join(" ").trim(),
                    segments: mergedRows.map((row) => ({
                        start: row.start,
                        end: row.end,
                        text: row.text
                    }))
                },
                quota,
                meta: {
                    chunked: true,
                    chunkCount: chunks.length,
                    durationSec: Number(chunked?.durationSec || 0),
                    chunkSeconds: Number(chunked?.chunkSeconds || 0)
                }
            };
        } catch (error) {
            if (typeof error === "string" && /ffmpeg/i.test(error)) {
                throw createAppError("ASR_CHUNKING_FAILED", "音轨切片失败，请稍后重试");
            }
            throw error;
        } finally {
            if (chunkSessionId) {
                await releaseOffscreenAudioChunkSession(chunkSessionId).catch(() => {});
            }
        }
    }

    static async requestSiliconFlowChunkedTranscription(audioBlob, options = {}) {
        const tabId = Number(options.tabId || 0);
        const bvid = normalizeBvid(options.bvid || "");
        const asrApiKey = String(options.asrApiKey || "").trim();
        const asrModel = String(options.asrModel || "").trim() || "FunAudioLLM/SenseVoiceSmall";
        const maxAudioBytes = Number(options.maxAudioBytes || SILICONFLOW_MAX_AUDIO_BYTES);
        const signal = options.signal || null;
        if (signal?.aborted) throw createUserAbortedError();
        let chunkSessionId = "";
        try {
            const chunked = await requestOffscreenAudioChunkingPrepare({
                audioBlob,
                audioUrl: String(options.audioUrl || "").trim(),
                mimeType: audioBlob.type || "audio/mp4",
                maxAudioBytes,
                signal,
                bvid,
                provider: "siliconflow",
                model: asrModel
            });
            chunkSessionId = String(chunked?.sessionId || "").trim();
            logASR.info("asr_chunk_plan_created", {
                bvid,
                task: "asr",
                provider: "siliconflow",
                model: asrModel,
                detail: {
                    total_audio_bytes: audioBlob.size,
                    duration_sec: Number(chunked?.durationSec || 0),
                    chunk_seconds: Number(chunked?.chunkSeconds || 0),
                    overlap_seconds: Number(chunked?.overlapSeconds || DEFAULT_ASR_CHUNK_OVERLAP_SECONDS),
                    chunk_count: Number(chunked?.chunkCount || 0)
                }
            });
            const chunks = Array.isArray(chunked?.chunks) ? chunked.chunks : [];
            if (chunks.some((chunk) => chunk.bytes >= maxAudioBytes)) {
                throw createAppError("ASR_CHUNKING_UNSUPPORTED", "自动切片后单段音轨仍超出限制，请稍后再试");
            }
            await updateTabState(tabId, { activeBvid: bvid, transcriptionProgress: 68, updatedAt: Date.now() });
            await notifyTranscribeStatus(tabId, {
                stage: "upload",
                level: "info",
                text: `正在转录 ${chunks.length} 段音轨...`,
                progress: 68,
                bvid
            });
            const chunkResult = await requestOffscreenChunkTranscriptionAll({
                sessionId: chunkSessionId,
                provider: "siliconflow",
                tabId,
                bvid,
                apiKey: asrApiKey,
                model: asrModel
            });
            const mergedRows = Array.isArray(chunkResult?.rows) ? chunkResult.rows : [];
            await recordAsrChunkingDebugState(tabId, chunkResult?.diagnostics || null);
            return {
                data: {
                    text: mergedRows.map((row) => row.text).join(" ").trim()
                },
                quota: null,
                meta: {
                    chunked: true,
                    chunkCount: chunks.length,
                    durationSec: Number(chunked?.durationSec || 0),
                    chunkSeconds: Number(chunked?.chunkSeconds || 0)
                }
            };
        } catch (error) {
            if (typeof error === "string" && /ffmpeg/i.test(error)) {
                throw createAppError("ASR_CHUNKING_FAILED", "音轨切片失败，请稍后重试");
            }
            throw error;
        } finally {
            if (chunkSessionId) {
                await releaseOffscreenAudioChunkSession(chunkSessionId).catch(() => {});
            }
        }
    }

    static async requestSiliconFlowTranscription(audioFile, apiKey, model, tabId, bvid = "", externalSignal = null) {
        const formData = new FormData();
        formData.append("file", audioFile);
        formData.append("model", model || "FunAudioLLM/SenseVoiceSmall");
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(externalSignal?.reason || "aborted");
        if (externalSignal) {
            if (externalSignal.aborted) forwardAbort();
            else externalSignal.addEventListener("abort", forwardAbort, { once: true });
        }
        const timeoutId = setTimeout(() => controller.abort("timeout"), ASR_TASK_TIMEOUT_MS);
        let response;
        try {
            response = await fetch(SILICONFLOW_AUDIO_TRANSCRIBE_URL, {
                method: "POST",
                headers: { Authorization: `Bearer ${apiKey}` },
                body: formData,
                signal: controller.signal
            });
        } catch (error) {
            if (controller.signal.aborted) {
                if (controller.signal.reason === "timeout") {
                    const timeoutError = createTaskTimeoutError("ASR_REQUEST_TIMEOUT", "转录请求超时，请稍后重试");
                    attachSentryContext(timeoutError, {
                        provider: "siliconflow_asr",
                        model: String(model || ""),
                        timeout_ms: ASR_TASK_TIMEOUT_MS,
                        request_stream: false,
                        bypass_queue: true
                    });
                    throw timeoutError;
                }
                throw createUserAbortedError();
            }
            throw error;
        } finally {
            if (externalSignal) externalSignal.removeEventListener("abort", forwardAbort);
            clearTimeout(timeoutId);
        }
        if (!response.ok) {
            const detail = await response.text().catch(() => "");
            if (response.status === 429) {
                throw createAppError("ASR_RATE_LIMIT", "硅基流动限流，请稍后重试", { status: response.status });
            }
            const error = createHttpError(response.status, `硅基流动转录失败（${response.status}）${detail ? `：${detail.slice(0, 180)}` : ""}`);
            error.code = "ASR_SILICONFLOW_FAILED";
            throw error;
        }
        await notifyTranscribeStatus(tabId, {
            stage: "upload",
            level: "info",
            text: "上传进度：100%",
            progress: 70,
            bvid
        });
        const data = await response.json().catch(() => null);
        return { data, quota: null };
    }

    static mapTranscriptionToRows(data, options = {}) {
        if (options?.noTimestamp) {
            const plain = String(data?.text || data?.result || data?.data?.text || "").trim();
            if (!plain) return [];
            return splitTranscriptionTextByPunctuation(plain).map((text, index) => ({
                start: null,
                end: null,
                text,
                index,
                noTimestamp: true
            }));
        }
        const segments = Array.isArray(data?.segments) ? data.segments : [];
        if (segments.length) {
            return segments
                .map((item, index) => {
                    const start = Number(item?.start ?? 0);
                    const endRaw = Number(item?.end ?? start + 3);
                    const end = Number.isFinite(endRaw) ? endRaw : start + 3;
                    const text = String(item?.text || "").trim();
                    if (!text) return null;
                    return {
                        start: Number.isFinite(start) ? start : 0,
                        end: Math.max(Number.isFinite(start) ? start : 0, end),
                        text,
                        index
                    };
                })
                .filter(Boolean);
        }
        const plain = String(data?.text || "").trim();
        if (!plain) return [];
        return [{ start: 0, end: 10, text: plain, index: 0 }];
    }
}

async function notifyTranscribeStatus(tabId, payload) {
    if (!tabId) return;
    const message = { action: "TRANSCRIBE_STATUS", ...payload };
    try {
        await chrome.tabs.sendMessage(tabId, message);
    } catch (_) {}
    logBackground.info("transcribe_status", {
        tab_id: tabId,
        stage: payload?.stage || "",
        level: payload?.level || "",
        text: String(payload?.text || ""),
        quota: String(payload?.quotaLine || ""),
        retry_after: Number(payload?.retryAfterSec || 0)
    });
    if (Number(payload?.retryAfterSec || 0) > 0) {
        startRetryCountdown(tabId, Number(payload.retryAfterSec), payload?.bvid || "");
    }
}

function startRetryCountdown(tabId, retryAfterSec, bvid = "") {
    const maxSeconds = Math.max(0, Math.floor(retryAfterSec || 0));
    if (!maxSeconds) return;
    let remain = maxSeconds;
    const timer = setInterval(async () => {
        remain -= 1;
        if (remain <= 0) {
            clearInterval(timer);
            try {
                await chrome.tabs.sendMessage(tabId, {
                    action: "TRANSCRIBE_STATUS",
                    stage: "retry_countdown",
                    level: "info",
                    text: "可以重试转录了",
                    retryAfterSec: 0,
                    bvid
                });
            } catch (_) {}
            return;
        }
        try {
            await chrome.tabs.sendMessage(tabId, {
                action: "TRANSCRIBE_STATUS",
                stage: "retry_countdown",
                level: "info",
                text: `请等待 ${remain} 秒后重试`,
                retryAfterSec: remain,
                bvid
            });
        } catch (_) {
            clearInterval(timer);
        }
    }, 1000);
}

async function handleSubtitleCaptured(tabId, payload) {
    if (!tabId) return;
    const bvid = normalizeBvid(payload?.bvid);
    if (!bvid) {
        logBackground.error("task_abort", {
            task: "subtitle_capture",
            code: "MISSING_BVID",
            detail: {
                tab_id: tabId,
                reason: "missing_bvid_in_payload"
            }
        });
        return;
    }
    const cid = Number(payload.cid || 0);
    const tid = payload.tid || null;
    const partCount = Math.max(0, Math.floor(Number(payload?.partCount || 0)));
    const subtitleSource = String(payload?.source || "official");
    const subtitleLanguage = String(payload?.subtitleLanguage || "").trim();
    const subtitleLanguageLabel = String(payload?.subtitleLanguageLabel || subtitleLanguage || "").trim();
    const clearDerived = payload?.clearDerived === true;
    logBackground.info("subtitle_detected", { tab_id: tabId, bvid, cid, tid });
    const existing = await getCache(bvid);
    const existingPart = selectCachePart(existing, { bvid, cid, tid, partCount }) || {};
    const rawSubtitle = normalizeRawSubtitle(payload.subtitle || []);
    const rawHash = makeSubtitleHash(rawSubtitle);
    if (existingPart?.rawHash && existingPart.rawHash === rawHash) {
        logBackground.debug("subtitle_duplicate_ignore", { bvid, tab_id: tabId, raw_hash: rawHash });
        const existingSource = String(existingPart?.subtitleSource || "");
        const existingLanguage = String(existingPart?.subtitleLanguage || "");
        const existingCid = Number(existingPart?.cid || 0);
        const existingTid = String(existingPart?.tid || "").trim();
        const nextTid = String(tid || "").trim();
        let nextCache = existing;
        if (
            (subtitleSource && existingSource !== subtitleSource)
            || (subtitleLanguage && existingLanguage !== subtitleLanguage)
            || (Number.isFinite(cid) && cid > 0 && existingCid !== cid)
            || (nextTid && existingTid !== nextTid)
        ) {
            await mergeCacheByBvid(bvid, {
                cid: Number.isFinite(cid) ? cid : 0,
                tid,
                partCount,
                title: payload.title || existingPart?.title || "",
                subtitleSource,
                subtitleLanguage,
                subtitleLanguageLabel,
                subtitleUrl: String(payload?.subtitleUrl || existingPart?.subtitleUrl || ""),
                ...(clearDerived ? {
                    summary: "",
                    segments: [],
                    rumors: [],
                    history: []
                } : {}),
                updatedAt: Date.now()
            });
            nextCache = await getCache(bvid);
        }
        await updateTabState(tabId, {
            activeBvid: bvid,
            activeCid: Number.isFinite(cid) ? cid : 0,
            activeTid: tid,
            subtitleSource,
            subtitleLanguage,
            subtitleLanguageLabel,
            transcriptionProgress: isAsrSubtitleSource(subtitleSource) ? 100 : 0,
            updatedAt: Date.now()
        });
        if (isAsrSubtitleSource(subtitleSource)) {
            const settings = await getResolvedSettings();
            await persistCloudSubtitlePatch(bvid, settings, nextCache, {
                title: payload.title || "",
                subtitleSource,
                cid,
                tid
            });
        }
        const nextPartCache = selectCachePart(nextCache, { bvid, cid, tid, partCount });
        if (nextPartCache) await pushSubtitleSyncToTab(tabId, bvid, nextPartCache, "duplicate");
        return;
    }
    const processedSubtitle = isNoTimestampSubtitleSource(subtitleSource)
        ? rawSubtitle
        : SubtitleProcessor.process(rawSubtitle);
    const processedHash = makeSubtitleHash(processedSubtitle);
    if (rawSubtitle.length > 0 && processedSubtitle.length === 0) {
        const first = rawSubtitle[0] || {};
        logBackground.warn("subtitle_parsed", {
            bvid,
            reason: "processed_empty",
            raw_count: rawSubtitle.length,
            sample_start: first.start ?? null,
            sample_end: first.end ?? null,
            sample_text_len: String(first.text || "").length
        });
    }
    logBackground.info("subtitle_parsed", { bvid, raw_count: rawSubtitle.length, processed_count: processedSubtitle.length });
    await mergeCacheByBvid(bvid, {
        bvid,
        cid: Number.isFinite(cid) ? cid : 0,
        tid,
        partCount,
        title: payload.title || "",
        subtitleSource,
        subtitleLanguage,
        subtitleLanguageLabel,
        subtitleUrl: String(payload?.subtitleUrl || ""),
        rawSubtitle,
        processedSubtitle,
        rawHash,
        processedHash,
        ...(clearDerived ? {
            summary: "",
            segments: [],
            rumors: [],
            history: []
        } : {}),
        updatedAt: Date.now()
    });
    await updateTabState(tabId, {
        activeBvid: bvid,
        activeCid: Number.isFinite(cid) ? cid : 0,
        activeTid: tid,
        subtitleSource,
        subtitleLanguage,
        subtitleLanguageLabel,
        transcriptionProgress: isAsrSubtitleSource(subtitleSource) ? 100 : 0,
        lastError: "",
        taskStatus: {
            summary: "idle",
            segments: "idle",
            rumors: "idle",
            chat: "idle"
        },
        taskErrors: {},
        updatedAt: Date.now()
    });
    const latestCache = await getCache(bvid);
    const latestPartCache = selectCachePart(latestCache, { bvid, cid, tid, partCount });
    if (isAsrSubtitleSource(subtitleSource)) {
        const settings = await getResolvedSettings();
        await persistCloudSubtitlePatch(bvid, settings, latestCache, {
            title: payload.title || "",
            subtitleSource,
            cid,
            tid
        });
    }
    if (latestPartCache) await pushSubtitleSyncToTab(tabId, bvid, latestPartCache, "fresh");
}

async function pushSubtitleSyncToTab(tabId, bvid, cache, reason) {
    if (!tabId || !bvid) return;
    const key = String(tabId);
    const normalizedBvid = normalizeBvid(bvid);
    const prev = lastSubtitleSync.get(key);
    if (reason !== "duplicate" && prev && prev.bvid === normalizedBvid && Date.now() - Number(prev.at || 0) < 300) return;
    lastSubtitleSync.set(key, { bvid: normalizedBvid, at: Date.now() });
    const tabState = await getTabState(tabId);
    try {
        const action = reason === "duplicate" ? "UPDATE_STATE" : "SUBTITLE_READY";
        const safeCache = normalizeCacheForUI(cache, normalizedBvid);
        await chrome.tabs.sendMessage(tabId, {
            action,
            bvid: normalizedBvid,
            cache: safeCache,
            subtitle: Array.isArray(safeCache?.rawSubtitle) ? safeCache.rawSubtitle : [],
            tabState: tabState || null,
            reason
        });
    } catch (_) {}
}

function normalizeCacheForUI(cache, bvid) {
    if (!cache || typeof cache !== "object") return null;
    const rawSubtitle = normalizeRawSubtitle(Array.isArray(cache.rawSubtitle) ? cache.rawSubtitle : []);
    const processedSubtitle = normalizeRawSubtitle(Array.isArray(cache.processedSubtitle) ? cache.processedSubtitle : []);
    return {
        ...cache,
        bvid: normalizeBvid(cache.bvid || bvid),
        rawSubtitle,
        processedSubtitle
    };
}

function normalizeRawSubtitle(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map((item) => {
            if (item && typeof item === "string") {
                return { start: 0, end: null, text: item.trim() };
            }
            const start = Number(item.from ?? item.start ?? 0);
            const endRaw = Number(item.to ?? item.end ?? NaN);
            const end = Number.isFinite(endRaw) ? endRaw : null;
        const text = stripEmojiFromText(item.content ?? item.text ?? "");
            return { start, end, text };
        })
        .filter((item) => item.text);
}

function normalizeBvid(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const matched = raw.match(/BV[0-9A-Za-z]+/i);
    if (!matched) return "";
    return matched[0].toLowerCase();
}

function normalizeTaskContext(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const duration = source.videoDuration && typeof source.videoDuration === "object" ? source.videoDuration : {};
    const totalSeconds = Number(duration.totalSeconds);
    const formattedTime = String(duration.formattedTime || "").trim();
    const cid = Number(source.cid || 0);
    const bvid = normalizeBvid(source.bvid || "");
    const partCount = Math.max(0, Math.floor(Number(source.partCount || 0)));
    const tid = String(source.tid || "").trim();
    const partKey = createVideoCachePartKeyForContext(bvid, { cid, tid, partCount });
    return {
        bvid,
        cid: Number.isFinite(cid) && cid > 0 ? cid : 0,
        tid,
        partCount,
        partKey,
        videoDuration: {
            totalSeconds: Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0,
            formattedTime
        }
    };
}

function isCacheForTaskContext(cache = {}, taskContext = {}) {
    const contextCid = Number(taskContext?.cid || 0);
    const cacheCid = Number(cache?.cid || 0);
    if (contextCid > 0 && cacheCid > 0 && contextCid !== cacheCid) return false;
    const contextTid = String(taskContext?.tid || "").trim();
    const cacheTid = String(cache?.tid || "").trim();
    if (contextTid && cacheTid && contextTid !== cacheTid) return false;
    return true;
}

function createVideoCachePartKey(bvid, cid) {
    const normalizedBvid = normalizeBvid(bvid);
    const normalizedCid = String(cid || "").trim();
    return normalizedBvid && normalizedCid ? `${normalizedBvid}::${normalizedCid}` : "";
}

function isPendingSinglePartContext(context = {}) {
    return !(Number(context?.cid || 0) > 0)
        && Number(context?.partCount || 0) === 1
        && !String(context?.tid || "").trim();
}

function createVideoCachePartKeyForContext(bvid, context = {}) {
    const normalKey = createVideoCachePartKey(bvid, context?.cid);
    if (normalKey) return normalKey;
    const normalizedBvid = normalizeBvid(context?.bvid || bvid);
    return normalizedBvid && isPendingSinglePartContext(context)
        ? `${normalizedBvid}::${SINGLE_PART_PENDING_SUFFIX}`
        : "";
}

function resolvePartContext(bvid, context = {}) {
    const normalizedBvid = normalizeBvid(context?.bvid || bvid);
    const cid = Number(context?.cid || 0);
    const normalizedCid = Number.isFinite(cid) && cid > 0 ? cid : 0;
    const identity = {
        bvid: normalizedBvid,
        cid: normalizedCid,
        tid: String(context?.tid || "").trim(),
        partCount: Math.max(0, Math.floor(Number(context?.partCount || 0)))
    };
    return {
        ...identity,
        pendingSinglePart: isPendingSinglePartContext(identity),
        partKey: createVideoCachePartKeyForContext(normalizedBvid, identity)
    };
}

function createSubtitleCacheKey({ bvid, cid, language = "default" } = {}) {
    return [
        normalizeBvid(bvid),
        String(cid || "").trim(),
        String(language || "default").trim()
    ].join("::");
}

function getPartCacheFields(cache = {}) {
    const directoryFields = new Set(["parts", "schemaVersion"]);
    return Object.entries(cache || {}).reduce((acc, [key, value]) => {
        if (!directoryFields.has(key)) acc[key] = cloneData(value);
        return acc;
    }, {});
}

function selectCachePart(cache = {}, context = {}) {
    if (!cache || typeof cache !== "object") return cache;
    const cid = Number(context?.cid || 0);
    if (!(cid > 0)) {
        if (Number(context?.partCount || 0) !== 1 || String(context?.tid || "").trim()) return null;
        const pendingPartKey = createVideoCachePartKeyForContext(cache.bvid || context.bvid, context);
        const pendingPart = pendingPartKey && cache.parts && typeof cache.parts === "object"
            ? cache.parts[pendingPartKey]
            : null;
        if (pendingPart && typeof pendingPart === "object") {
            return { ...cache, ...cloneData(pendingPart), parts: cache.parts, subtitleVariants: cache.subtitleVariants };
        }
        const parts = cache.parts && typeof cache.parts === "object"
            ? Object.values(cache.parts).filter((part) => part && Number(part.cid || 0) > 0)
            : [];
        if (parts.length === 1) {
            return { ...cache, ...cloneData(parts[0]), parts: cache.parts, subtitleVariants: cache.subtitleVariants };
        }
        const hasRootSubtitle = Array.isArray(cache?.rawSubtitle) && cache.rawSubtitle.length
            || Array.isArray(cache?.processedSubtitle) && cache.processedSubtitle.length;
        return parts.length === 0 && (Number(cache.cid || 0) > 0 || hasRootSubtitle)
            ? { ...cache, cid: Number(cache.cid || 0), pendingSinglePart: !(Number(cache.cid || 0) > 0) }
            : null;
    }
    const partKey = createVideoCachePartKey(cache.bvid || context.bvid, cid);
    const part = partKey && cache.parts && typeof cache.parts === "object" ? cache.parts[partKey] : null;
    if (part && typeof part === "object") {
        return { ...cache, ...cloneData(part), parts: cache.parts, subtitleVariants: cache.subtitleVariants };
    }
    return null;
}

function getPartCacheForContext(cache = {}, bvid = "", context = {}) {
    const identity = resolvePartContext(bvid, context);
    const selected = selectCachePart(cache, identity);
    if (!selected || !isCacheForTaskContext(selected, identity)) return null;
    return selected;
}

function makeSubtitleHash(list) {
    if (!Array.isArray(list) || !list.length) return "empty";
    const first = list[0];
    const last = list[list.length - 1];
    return `${list.length}|${first.start}|${last.end ?? last.start}|${first.text.slice(0, 24)}|${last.text.slice(0, 24)}`;
}

function resolveRunTasksFeatureName(tasks = []) {
    if (tasks.includes("summary") && tasks.includes("segments")) return "summary_segments_merged";
    return tasks.length === 1 ? String(tasks[0] || "task") : tasks.join("_");
}

async function runTasksForTab(tabId, tasks, force, taskContext = {}, requestedBvid = "", settingsOverride = null) {
    const task = resolveRunTasksFeatureName(tasks);
    const taskId = String(taskContext?.sentryTaskId || "").trim() || createUsageTaskId(task);
    const finalTaskContext = { ...taskContext, sentryTaskId: taskId };
    let resolvedSettings = settingsOverride;
    try {
        resolvedSettings = resolvedSettings || await getResolvedSettings();
        return await executeTasksForTab(tabId, tasks, force, finalTaskContext, requestedBvid, resolvedSettings);
    } catch (error) {
        await captureTaskFailureToSentry(error, {
            source: "task_final_failure",
            task,
            task_id: taskId,
            tabId,
            bvid: normalizeBvid(requestedBvid || ""),
            provider: resolvedSettings?.provider || "",
            model: resolvedSettings?.model || ""
        });
        throw error;
    }
}

async function executeTasksForTab(tabId, tasks, force, taskContext = {}, requestedBvid = "", settingsOverride = null) {
    const tabState = await getTabState(tabId);
    const bvid = normalizeBvid(requestedBvid || tabState?.activeBvid);
    if (!bvid) throw new Error("未获取到视频字幕");
    const requestIdentity = resolvePartContext(bvid, taskContext);
    if (!requestIdentity.partKey) throw createAppError("PART_IDENTITY_PENDING", "正在识别当前分 P，请稍候再试");
    logPartScopeDiagnostic("task_request_identity", {
        tabId,
        feature: tasks.join(","),
        requestedBvid: requestIdentity.bvid,
        requestedCid: requestIdentity.cid,
        requestedTid: requestIdentity.tid,
        requestedPartKey: requestIdentity.partKey,
        activeBvid: normalizeBvid(tabState?.activeBvid || ""),
        activeCid: Number(tabState?.activeCid || 0),
        activeTid: String(tabState?.activeTid || "")
    });
    const resolvedSettings = settingsOverride || await getResolvedSettings();
    const hydrateTasks = [...new Set([
        ...tasks,
        ...(tasks.some((task) => ["summary", "segments", "rumors"].includes(task)) ? ["subtitle"] : [])
    ])];
    await hydrateCloudCacheIfNeeded(bvid, hydrateTasks, resolvedSettings, taskContext);
    const hasSummarySegments = tasks.includes("summary") && tasks.includes("segments");
    const otherTasks = tasks.filter((task) => !(hasSummarySegments && (task === "summary" || task === "segments")));
    const taskResults = {};

    if (hasSummarySegments) {
        await setTaskStatus(tabId, ["summary", "segments"], "processing", "", taskContext);
        const pairedResults = await runSummarySegmentsTasks(tabId, bvid, force, resolvedSettings, taskContext);
        taskResults.summary = !!pairedResults?.summary?.ok;
        taskResults.segments = !!pairedResults?.segments?.ok;
    }

    if (otherTasks.length) {
        await setTaskStatus(tabId, otherTasks, "processing", "", taskContext);
        await Promise.all(otherTasks.map((task) => runSingleTask(tabId, bvid, task, force, resolvedSettings, taskContext)));
        await setTaskStatus(tabId, otherTasks, "done", "", taskContext);
        otherTasks.forEach((task) => {
            taskResults[task] = true;
        });
    }

    logBackground.info("task_finish", { tab_id: tabId, bvid, tasks });
    return taskResults;
}

async function runSingleTask(tabId, bvid, task, force, settings, taskContext = {}) {
    const identity = resolvePartContext(bvid, taskContext);
    if (!force) {
        await hydrateCloudCacheIfNeeded(bvid, [task], settings, identity);
    }
    const rawCache = await getCache(bvid);
    const cache = getPartCacheForContext(rawCache, bvid, identity);
    logPartScopeDiagnostic("task_local_read", {
        feature: task,
        requestedPartKey: identity.partKey,
        requestedCid: identity.cid,
        rootCid: Number(rawCache?.cid || 0),
        selected: !!cache,
        ...(cache ? buildPartScopeCacheMeta(cache) : {})
    });
    if (!cache) throw createMissingSubtitleError();
    if (!force && cache?.[task]) return cache[task];
    const key = `${identity.partKey || bvid}|${task}`;
    const startedAt = Date.now();
    const taskId = String(taskContext?.sentryTaskId || "").trim() || createUsageTaskId(task);
    const usageTaskContext = {
        ...taskContext,
        ...identity,
        tabId,
        usageTaskId: taskId,
        usageFeatureName: task,
        usageRecoveryState: {}
    };
    logBackground.info("task_start", { tab_id: tabId, bvid, task });
    await reportClientUsageEvent({
        eventName: "task_started",
        featureName: task,
        taskId,
        status: "started",
        provider: settings?.provider || "",
        model: settings?.model || "",
        bvid,
        title: cache?.title || "",
        tabId
    }, settings);
    try {
        const result = await runWithDedup(key, () => requestTaskResult(bvid, task, settings, usageTaskContext));
        await mergeCacheByBvid(bvid, {
            cid: identity.cid,
            tid: identity.tid,
            partCount: identity.partCount,
            [task]: result,
            ...buildTaskSourcePatch([task], "local"),
            updatedAt: Date.now()
        });
        await promotePendingSinglePartCacheForTab(bvid, tabId);
        const resultSettings = getSettingsForTaskResult(settings, usageTaskContext, task);
        await persistCloudFeaturePatch(bvid, resultSettings, { [task]: result }, identity);
        await reportClientUsageEvent({
            eventName: "task_success",
            featureName: task,
            taskId,
            status: "success",
            provider: resultSettings?.provider || "",
            model: resultSettings?.model || "",
            bvid,
            title: cache?.title || "",
            durationMs: Date.now() - startedAt,
            tabId,
            metadata: buildTaskRecoveryMetadata(usageTaskContext)
        }, resultSettings);
        return result;
    } catch (error) {
        attachSentryContext(error, {
            task,
            task_id: taskId,
            tabId,
            bvid,
            provider: settings?.provider || "",
            model: settings?.model || ""
        });
        const status = isTimeoutError(error) ? "timeout" : "error";
        await reportDailyFeatureUsage(task, settings, {
            durationMs: Date.now() - startedAt,
            tokens: 0
        }, resolveUsageStatusByError(error), resolveUsageErrorCode(error), {
            bvid,
            title: cache?.title || ""
        });
        await reportClientUsageEvent({
            eventName: "task_failed",
            featureName: task,
            taskId,
            provider: settings?.provider || "",
            model: settings?.model || "",
            bvid,
            title: cache?.title || "",
            tabId,
            ...buildUsageErrorPayload(error, {
                startedAt,
                metadata: buildTaskRecoveryMetadata(usageTaskContext)
            })
        }, settings);
        if (status === "timeout") {
            logBackground.error("task_timeout", buildFailureLog(error, { tab_id: tabId, bvid, task, code: error?.code || "TIMEOUT" }));
        } else {
            logBackground.error("task_abort", buildFailureLog(error, { tab_id: tabId, bvid, task }));
        }
        await setTaskStatus(tabId, [task], status, error.message || "任务失败", identity);
        throw error;
    }
}

async function runSummarySegmentsTasks(tabId, bvid, force, settings, taskContext = {}) {
    const identity = resolvePartContext(bvid, taskContext);
    if (!force) {
        await hydrateCloudCacheIfNeeded(bvid, ["summary", "segments"], settings, identity);
    }
    const rawCache = await getCache(bvid);
    const cache = getPartCacheForContext(rawCache, bvid, identity);
    logPartScopeDiagnostic("task_local_read", {
        feature: "summary_segments",
        requestedPartKey: identity.partKey,
        requestedCid: identity.cid,
        rootCid: Number(rawCache?.cid || 0),
        selected: !!cache,
        ...(cache ? buildPartScopeCacheMeta(cache) : {})
    });
    if (!cache) throw createMissingSubtitleError();
    if (!force && cache?.summary && Array.isArray(cache?.segments) && cache.segments.length) {
        await setTaskStatus(tabId, ["summary", "segments"], "done", "", identity);
        return {
            summary: { ok: true, data: cache.summary || "", error: null },
            segments: { ok: true, data: cache.segments, error: null }
        };
    }
    const key = `${identity.partKey || bvid}|summary_segments`;
    const startedAt = Date.now();
    const taskId = String(taskContext?.sentryTaskId || "").trim() || createUsageTaskId("summary_segments_merged");
    const usageTaskContext = {
        ...taskContext,
        ...identity,
        tabId,
        usageTaskId: taskId,
        usageFeatureName: "summary_segments_merged",
        usageRecoveryState: {}
    };
    await mergeCacheByBvid(bvid, {
        cid: identity.cid,
        tid: identity.tid,
        partCount: identity.partCount,
        summaryDraft: null,
        updatedAt: Date.now()
    });
    logBackground.info("task_start", { tab_id: tabId, bvid, task: "summary_segments", mode: settings.prefMode });
    await reportClientUsageEvent({
        eventName: "task_started",
        featureName: "summary_segments_merged",
        taskId,
        status: "started",
        provider: settings?.provider || "",
        model: settings?.model || "",
        bvid,
        title: cache?.title || "",
        tabId,
        metadata: { pref_mode: settings?.prefMode || "" }
    }, settings);
    const runner = settings.prefMode === "efficiency"
        ? () => runSummarySegmentsInEfficiency(tabId, bvid, force, settings, usageTaskContext)
        : () => runSummarySegmentsInQuality(tabId, bvid, force, settings, usageTaskContext);
    let results;
    try {
        results = await runWithDedup(key, runner);
    } catch (error) {
        await reportClientUsageEvent({
            eventName: "task_failed",
            featureName: "summary_segments_merged",
            taskId,
            provider: settings?.provider || "",
            model: settings?.model || "",
            bvid,
            title: cache?.title || "",
            tabId,
            ...buildUsageErrorPayload(error, {
                startedAt,
                errorCode: "SUMMARY_SEGMENTS_FAILED",
                metadata: buildTaskRecoveryMetadata(usageTaskContext)
            })
        }, settings);
        throw error;
    }
    const cloudPatch = {};
    if (results?.summary?.ok) cloudPatch.summary = results.summary.data;
    if (results?.segments?.ok) cloudPatch.segments = results.segments.data;
    if (Object.keys(cloudPatch).length) {
        const summarySettings = getSettingsForTaskResult(settings, usageTaskContext, "summary");
        const segmentsSettings = getSettingsForTaskResult(settings, usageTaskContext, "segments");
        if (cloudPatch.summary && cloudPatch.segments && summarySettings.model !== segmentsSettings.model) {
            await persistCloudFeaturePatch(bvid, summarySettings, { summary: cloudPatch.summary }, identity);
            await persistCloudFeaturePatch(bvid, segmentsSettings, { segments: cloudPatch.segments }, identity);
        } else {
            await persistCloudFeaturePatch(
                bvid,
                cloudPatch.summary ? summarySettings : segmentsSettings,
                cloudPatch,
                identity
            );
        }
    }
    const summaryOk = !!results?.summary?.ok;
    const segmentsOk = !!results?.segments?.ok;
    if (!summaryOk && !segmentsOk) {
        const error = pickSummarySegmentsFailureError(results);
        await reportDailyFeatureUsage("summary_segments_merged", settings, {
            durationMs: Date.now() - startedAt,
            tokens: 0
        }, resolveUsageStatusByError(error), resolveUsageErrorCode(error, "SUMMARY_SEGMENTS_FAILED"), {
            bvid,
            title: cache?.title || ""
        });
        await reportClientUsageEvent({
            eventName: "task_failed",
            featureName: "summary_segments_merged",
            taskId,
            provider: settings?.provider || "",
            model: settings?.model || "",
            bvid,
            title: cache?.title || "",
            tabId,
            ...buildUsageErrorPayload(error, {
                startedAt,
                errorCode: "SUMMARY_SEGMENTS_FAILED",
                metadata: buildTaskRecoveryMetadata(usageTaskContext)
            })
        }, settings);
        throw error;
    }
    await reportClientUsageEvent({
        eventName: summaryOk && segmentsOk ? "task_success" : "task_partial",
        featureName: "summary_segments_merged",
        taskId,
        status: summaryOk && segmentsOk ? "success" : "partial",
        provider: settings?.provider || "",
        model: settings?.model || "",
        bvid,
        title: cache?.title || "",
        durationMs: Date.now() - startedAt,
        tabId,
        metadata: {
            summary_ok: summaryOk,
            segments_ok: segmentsOk,
            outcome_category: summaryOk && segmentsOk ? "success" : "partial_success",
            ...buildTaskRecoveryMetadata(usageTaskContext)
        }
    }, settings);
    return results;
}

async function runChatForTab(tabId, text, messageId, requestedBvid = "", taskContext = {}) {
    const tabState = await getTabState(tabId);
    const bvid = normalizeBvid(requestedBvid || tabState?.activeBvid);
    if (!bvid) throw new Error("未获取到视频字幕");
    const identity = resolvePartContext(bvid, taskContext);
    if (!identity.partKey) throw createAppError("PART_IDENTITY_PENDING", "正在识别当前分 P，请稍候再试");
    await setTaskStatus(tabId, ["chat"], "processing", "", identity);
    const resolvedSettings = await getResolvedSettings();
    await hydrateCloudCacheIfNeeded(bvid, ["subtitle"], resolvedSettings, identity);
    const rawCache = await getCache(bvid);
    const cache = getPartCacheForContext(rawCache, bvid, identity);
    logPartScopeDiagnostic("task_local_read", {
        feature: "chat",
        requestedPartKey: identity.partKey,
        requestedCid: identity.cid,
        rootCid: Number(rawCache?.cid || 0),
        selected: !!cache,
        ...(cache ? buildPartScopeCacheMeta(cache) : {})
    });
    if (!cache) throw createMissingSubtitleError();
    const history = Array.isArray(cache.history) ? cache.history : [];
    const key = `${identity.partKey}|chat|${messageId}`;
    const startedAt = Date.now();
    const taskId = createUsageTaskId("chat");
    logBackground.info("task_enqueue", { tab_id: tabId, bvid, tasks: ["chat"] });
    logBackground.info("task_start", { tab_id: tabId, bvid, task: "chat" });
    await reportClientUsageEvent({
        eventName: "task_started",
        featureName: "chat",
        taskId,
        status: "started",
        provider: resolvedSettings?.provider || "",
        model: resolvedSettings?.model || "",
        bvid,
        title: cache?.title || "",
        tabId
    }, resolvedSettings);
    try {
        let lastMetrics = null;
        const answer = await runWithDedup(key, async () => {
            const subtitleText = getSubtitlePayload(cache);
            if (!subtitleText) throw createMissingSubtitleError();
            const recent = history.slice(-8);
            const conversation = recent.map((item) => `${item.role === "assistant" ? "助手" : "用户"}：${item.content}`).join("\n");
            const prompt = `你是 B 站视频助手。基于字幕回答用户的问题，回答要准确、简洁。\n字幕：\n${subtitleText}\n历史：\n${conversation}\n用户问题：${text}`;
            logAIPromptBuilt({ bvid, task: "chat", provider: resolvedSettings.provider, mode: "chat", prompt, promptSettings: resolvedSettings.promptSettings });
            const aiRes = await callAIWithTimeout(resolvedSettings, [{ role: "user", content: prompt }], TASK_TIMEOUT_MS, { tabId, component: "chat", bvid });
            lastMetrics = aiRes.metrics || null;
            await appendMetrics(bvid, tabId, "chat", aiRes.metrics, identity);
            await reportFeatureUsage("chat", bvid, resolvedSettings, aiRes.metrics);
            return aiRes.text.trim();
        });
        const mergedHistory = [
            ...history,
            { id: `u_${messageId}`, role: "user", content: text, createdAt: Date.now() },
            { id: `a_${messageId}`, role: "assistant", content: answer, metrics: lastMetrics || null, createdAt: Date.now() }
        ];
        await mergeCacheByBvid(bvid, { cid: identity.cid, tid: identity.tid, partCount: identity.partCount, history: mergedHistory, updatedAt: Date.now() });
        await promotePendingSinglePartCacheForTab(bvid, tabId);
        await setTaskStatus(tabId, ["chat"], "done", "", identity);
        await reportClientUsageEvent({
            eventName: "task_success",
            featureName: "chat",
            taskId,
            status: "success",
            provider: resolvedSettings?.provider || "",
            model: resolvedSettings?.model || "",
            bvid,
            title: cache?.title || "",
            durationMs: Date.now() - startedAt,
            tokenCount: lastMetrics?.totalTokens || 0,
            tabId
        }, resolvedSettings);
        logBackground.info("task_finish", { tab_id: tabId, bvid, tasks: ["chat"] });
        return { answer, metrics: lastMetrics || null };
    } catch (error) {
        const status = isTimeoutError(error) ? "timeout" : "error";
        await reportDailyFeatureUsage("chat", resolvedSettings, {
            durationMs: Date.now() - startedAt,
            tokens: 0
        }, resolveUsageStatusByError(error), resolveUsageErrorCode(error, "CHAT_FAILED"), {
            bvid,
            title: cache?.title || ""
        });
        await reportClientUsageEvent({
            eventName: "task_failed",
            featureName: "chat",
            taskId,
            provider: resolvedSettings?.provider || "",
            model: resolvedSettings?.model || "",
            bvid,
            title: cache?.title || "",
            tabId,
            ...buildUsageErrorPayload(error, { startedAt, errorCode: "CHAT_FAILED" })
        }, resolvedSettings);
        if (status === "timeout") {
            logBackground.error("task_timeout", buildFailureLog(error, { tab_id: tabId, bvid, task: "chat", code: error?.code || "TIMEOUT" }));
        } else {
            logBackground.error("task_abort", buildFailureLog(error, { tab_id: tabId, bvid, task: "chat" }));
        }
        await setTaskStatus(tabId, ["chat"], status, error.message || "聊天失败", identity);
        throw error;
    }
}

async function runChatForPort(port, msg) {
    const tabId = Number(msg?.tabId || port?.sender?.tab?.id || 0);
    if (!tabId) throw new Error("tabId 缺失");
    const text = String(msg?.text || "").trim();
    const messageId = String(msg?.messageId || "");
    if (!text || !messageId) throw new Error("聊天参数不完整");
    const tabState = await getTabState(tabId);
    const bvid = normalizeBvid(msg?.bvid || tabState?.activeBvid);
    if (!bvid) throw new Error("未获取到视频字幕");
    const identity = resolvePartContext(bvid, normalizeTaskContext(msg?.taskContext));
    if (!identity.partKey) throw createAppError("PART_IDENTITY_PENDING", "正在识别当前分 P，请稍候再试");
    await setTaskStatus(tabId, ["chat"], "processing", "", identity);
    const resolvedSettings = await getResolvedSettings();
    await hydrateCloudCacheIfNeeded(bvid, ["subtitle"], resolvedSettings, identity);
    const rawCache = await getCache(bvid);
    const cache = getPartCacheForContext(rawCache, bvid, identity);
    logPartScopeDiagnostic("task_local_read", {
        feature: "chat_stream",
        requestedPartKey: identity.partKey,
        requestedCid: identity.cid,
        rootCid: Number(rawCache?.cid || 0),
        selected: !!cache,
        ...(cache ? buildPartScopeCacheMeta(cache) : {})
    });
    if (!cache) throw createMissingSubtitleError();
    const history = Array.isArray(cache.history) ? cache.history : [];
    const key = `${identity.partKey}|chat_stream|${messageId}`;
    const abortKey = `${tabId}|${messageId}`;
    const abortController = new AbortController();
    chatAbortControllers.set(abortKey, abortController);
    const startedAt = Date.now();
    const taskId = createUsageTaskId("chat");
    logBackground.info("task_enqueue", { tab_id: tabId, bvid, tasks: ["chat_stream"] });
    logBackground.info("task_start", { tab_id: tabId, bvid, task: "chat_stream" });
    await reportClientUsageEvent({
        eventName: "task_started",
        featureName: "chat",
        taskId,
        status: "started",
        provider: resolvedSettings?.provider || "",
        model: resolvedSettings?.model || "",
        bvid,
        title: cache?.title || "",
        tabId,
        metadata: { stream: true }
    }, resolvedSettings);
    try {
        let lastMetrics = null;
        const answer = await runWithDedup(key, async () => {
            const subtitleText = getSubtitlePayload(cache);
            if (!subtitleText) throw createMissingSubtitleError();
            const recent = history.slice(-8);
            const conversation = recent.map((item) => `${item.role === "assistant" ? "助手" : "用户"}：${item.content}`).join("\n");
            const prompt = `你是 B 站视频助手。基于字幕回答用户的问题，回答要准确、简洁。\n字幕：\n${subtitleText}\n历史：\n${conversation}\n用户问题：${text}`;
            logAIPromptBuilt({ bvid, task: "chat_stream", provider: resolvedSettings.provider, mode: "chat", prompt, promptSettings: resolvedSettings.promptSettings });
            let streamedAnswerText = "";
            const aiRes = await callAIWithTimeoutStream(resolvedSettings, [{ role: "user", content: prompt }], TASK_TIMEOUT_MS, (delta) => {
                const chunk = String(delta || "");
                streamedAnswerText += chunk;
                safePortPost(port, { type: "delta", messageId, partKey: identity.partKey, delta: chunk });

            }, abortController, { tabId, component: "chat", bvid });
            lastMetrics = aiRes.metrics || null;
            await appendMetrics(bvid, tabId, "chat", aiRes.metrics, identity);
            await reportFeatureUsage("chat", bvid, resolvedSettings, aiRes.metrics);
            return String(aiRes.text || streamedAnswerText || "").trim();
        });
        const mergedHistory = [
            ...history,
            { id: `u_${messageId}`, role: "user", content: text, createdAt: Date.now() },
            { id: `a_${messageId}`, role: "assistant", content: answer, metrics: lastMetrics || null, createdAt: Date.now() }
        ];
        await mergeCacheByBvid(bvid, { cid: identity.cid, tid: identity.tid, partCount: identity.partCount, history: mergedHistory, updatedAt: Date.now() });
        await promotePendingSinglePartCacheForTab(bvid, tabId);
        await setTaskStatus(tabId, ["chat"], "done", "", identity);
        await reportClientUsageEvent({
            eventName: "task_success",
            featureName: "chat",
            taskId,
            status: "success",
            provider: resolvedSettings?.provider || "",
            model: resolvedSettings?.model || "",
            bvid,
            title: cache?.title || "",
            durationMs: Date.now() - startedAt,
            tokenCount: lastMetrics?.totalTokens || 0,
            tabId,
            metadata: { stream: true }
        }, resolvedSettings);
        safePortPost(port, { type: "done", messageId, partKey: identity.partKey, answer, metrics: lastMetrics || null });
        logBackground.info("task_finish", { tab_id: tabId, bvid, tasks: ["chat_stream"] });
    } catch (error) {
        attachSentryContext(error, {
            task: "chat",
            task_id: taskId,
            tabId,
            bvid,
            provider: resolvedSettings?.provider || "",
            model: resolvedSettings?.model || ""
        });
        if (error?.code === "ABORTED") {
            await reportDailyFeatureUsage("chat", resolvedSettings, {
                durationMs: Date.now() - startedAt,
                tokens: 0
            }, "cancelled", "ABORTED", {
                bvid,
                title: cache?.title || ""
            });
            await reportClientUsageEvent({
                eventName: "task_cancelled",
                featureName: "chat",
                taskId,
                provider: resolvedSettings?.provider || "",
                model: resolvedSettings?.model || "",
                bvid,
                title: cache?.title || "",
                tabId,
                ...buildUsageErrorPayload(error, { startedAt, errorCode: "ABORTED", metadata: { stream: true } })
            }, resolvedSettings);
            await setTaskStatus(tabId, ["chat"], "done", "", identity);
            safePortPost(port, { type: "aborted", messageId, partKey: identity.partKey });
            return;
        }
        const status = isTimeoutError(error) ? "timeout" : "error";
        await reportDailyFeatureUsage("chat", resolvedSettings, {
            durationMs: Date.now() - startedAt,
            tokens: 0
        }, resolveUsageStatusByError(error), resolveUsageErrorCode(error, "CHAT_STREAM_FAILED"), {
            bvid,
            title: cache?.title || ""
        });
        await reportClientUsageEvent({
            eventName: "task_failed",
            featureName: "chat",
            taskId,
            provider: resolvedSettings?.provider || "",
            model: resolvedSettings?.model || "",
            bvid,
            title: cache?.title || "",
            tabId,
            ...buildUsageErrorPayload(error, { startedAt, errorCode: "CHAT_STREAM_FAILED", metadata: { stream: true } })
        }, resolvedSettings);
        if (status === "timeout") {
            logBackground.error("task_timeout", buildFailureLog(error, { tab_id: tabId, bvid, task: "chat_stream", code: error?.code || "TIMEOUT" }));
        } else {
            logBackground.error("task_abort", buildFailureLog(error, { tab_id: tabId, bvid, task: "chat_stream" }));
        }
        await setTaskStatus(tabId, ["chat"], status, error.message || "聊天失败", identity);
        safePortPost(port, { type: "error", messageId, partKey: identity.partKey, error: error.message || "聊天失败" });
        throw error;
    } finally {
        chatAbortControllers.delete(abortKey);
    }
}

async function requestTaskResult(bvid, task, settings, taskContext = {}) {
    const cloudTasks = ["summary", "segments", "rumors"].includes(task) ? ["subtitle", task] : [task];
    await hydrateCloudCacheIfNeeded(bvid, cloudTasks, settings, taskContext);
    const rawCache = await getCache(bvid);
    const cache = getPartCacheForContext(rawCache, bvid, taskContext);
    if (!cache) throw createMissingSubtitleError();
    const subtitlePayloadOptions = task === "segments"
        ? { purpose: "segments", mode: "quality" }
        : { purpose: "general" };
    const subtitleText = getSubtitlePayload(cache, subtitlePayloadOptions);
    if (!subtitleText) throw createMissingSubtitleError();
    const promptTaskContext = { ...taskContext, noSubtitleTimestamps: isNoTimestampSubtitleCache(cache) };
    logSubtitlePayloadSelection(bvid, task, cache, subtitleText, subtitlePayloadOptions);
    const segmentPromptPlan = task === "segments"
        ? buildPrimarySegmentsPrompt({
            settings,
            cache,
            subtitleText,
            mode: settings.promptSettings?.mode || "guided",
            guided: settings.promptSettings?.guided || {},
            customPrompts: settings.promptSettings?.custom || {},
            taskContext,
            promptTaskContext
        })
        : null;
    const prompt = segmentPromptPlan?.prompt || buildPrompt({
            type: task,
            subtitle: subtitleText,
            mode: settings.promptSettings?.mode || "guided",
            guided: settings.promptSettings?.guided || {},
            customPrompts: settings.promptSettings?.custom || {},
            taskContext: promptTaskContext
        });
    logAIPromptBuilt({
        bvid,
        task,
        mode: "single",
        provider: settings.provider,
        prompt,
        promptSettings: settings.promptSettings
    });
    logAI.info("ai_request_start", {
        bvid,
        task,
        provider: settings.provider,
        model: settings.model || "",
        detail: {
            subtitle_chars: (segmentPromptPlan?.subtitleText || subtitleText).length,
            prompt_chars: prompt.length,
            prompt_mode: settings.promptSettings?.mode || "guided",
            pref_mode: settings.prefMode || "",
            compact_segments: !!segmentPromptPlan?.compact
        }
    });
    if (task === "segments") {
        await recordSegmentsDebugState(taskContext?.tabId || null, {
            status: "running",
            stage: "primary_request",
            strategy: segmentPromptPlan?.compact ? "compact" : "primary",
            attempt: 0,
            total: 2,
            code: "",
            mode: "single",
            message: segmentPromptPlan?.compact ? "保守 Prompt 主请求生成中" : "原 Prompt 主请求生成中"
        }, "开始分段主请求", { resetEvents: true });
        const forcedSegmentsErrorCode = consumeDebugForceFirstSegmentsTruncation(taskContext)
            ? "SEGMENTS_OUTPUT_TRUNCATED"
            : (consumeDebugForceFirstSegmentsFailure(taskContext) ? "SEGMENTS_INVALID_SCHEMA" : "");
        if (forcedSegmentsErrorCode) {
            const forcedMessage = forcedSegmentsErrorCode === "SEGMENTS_OUTPUT_TRUNCATED"
                ? "分段输出被截断"
                : "分段字段不完整";
            const forcedError = attachSentryContext(
                createAppError(forcedSegmentsErrorCode, forcedMessage),
                buildAIResponseSentryContext({
                    task: "segments",
                    bvid,
                    provider: settings.provider,
                    model: settings.model || "",
                    mode: "single",
                    source: "segments_single_forced_retry_test",
                    responseText: "",
                    metrics: {},
                    extra: {
                        debug_forced_failure: true,
                        debug_forced_truncation: forcedSegmentsErrorCode === "SEGMENTS_OUTPUT_TRUNCATED"
                    }
                })
            );
            await recordSegmentsDebugState(taskContext?.tabId || null, {
                status: "retrying",
                stage: "forced_failure",
                mode: "single",
                code: forcedError.code || "",
                message: forcedSegmentsErrorCode === "SEGMENTS_OUTPUT_TRUNCATED"
                    ? "测试模式：模拟输出截断"
                    : "测试模式：首轮主请求已强制失败"
            }, forcedSegmentsErrorCode === "SEGMENTS_OUTPUT_TRUNCATED"
                ? "测试模式：模拟分段输出截断，准备提高输出上限"
                : "测试模式：首轮分段主请求强制失败，准备进入自动重试");
            return await retrySegmentsWithAutoFallbacks({
                tabId: taskContext?.tabId || null,
                bvid,
                cache,
                settings,
                taskContext,
                subtitleText,
                promptMode: settings.promptSettings?.mode || "guided",
                guided: settings.promptSettings?.guided || {},
                customPrompts: settings.promptSettings?.custom || {},
                mode: "single",
                originalError: forcedError
            });
        }
    }
    let aiRes = await callAIWithTimeout(settings, [{ role: "user", content: prompt }], TASK_TIMEOUT_MS, {
        tabId: taskContext.tabId,
        taskContext,
        component: task,
        bvid
    });
    logAI.info("ai_request_success", {
        bvid,
        task,
        provider: settings.provider,
        model: settings.model || "",
        duration_ms: aiRes.metrics?.latencyMs || 0,
        detail: {
            tokens: aiRes.metrics?.tokens || 0,
            input_tokens: aiRes.metrics?.inputTokens || 0,
            output_tokens: aiRes.metrics?.outputTokens || 0,
            subtitle_chars: subtitleText.length,
            prompt_chars: prompt.length,
            output_chars: String(aiRes.text || "").length
        }
    });
    await appendMetrics(bvid, null, task, aiRes.metrics, taskContext);
    if (task !== "summary") {
        await reportFeatureUsage(task, bvid, settings, aiRes.metrics);
    }
    if (task === "summary") {
        let summaryText = sanitizeSummaryOutput(aiRes.text);
        if (consumeDebugForceFirstSummaryEmpty(taskContext)) {
            summaryText = "";
            aiRes = {
                ...aiRes,
                responseMeta: {
                    ...(aiRes.responseMeta || {}),
                    finishReason: "stop",
                    contentState: "empty"
                }
            };
            await recordSummaryRetryDebugState(taskContext.tabId, {
                status: "retrying",
                stage: "empty_detected",
                attempt: 0,
                total: 1,
                code: "SUMMARY_EMPTY_RESPONSE",
                message: "测试模式：首轮总结已强制判定为空"
            }, "测试模式：首轮总结判定为空，准备自动重试");
        }
        if (!summaryText || shouldDisableDeepSeekV4ThinkingForRetry(settings, aiRes)) {
            const retried = await retryEmptySummaryOnce({
                settings,
                prompt,
                tabId: taskContext.tabId,
                bvid,
                mode: "single",
                requestStream: false,
                taskContext,
                initialAIResponse: aiRes,
                initialDurationMs: aiRes.metrics?.latencyMs || 0
            });
            aiRes = retried.aiRes;
            summaryText = retried.summaryText;
            await appendMetrics(bvid, null, task, aiRes.metrics, taskContext);
        }
        await reportFeatureUsage(task, bvid, settings, aiRes.metrics);
        return summaryText;
    }
    if (task === "segments") {
        await recordSegmentsDebugState(taskContext?.tabId || null, {
            status: "running",
            stage: "parsing",
            mode: "single",
            message: "主响应已返回，正在解析分段"
        }, "主响应已返回，开始解析分段");
        const parsed = isLikelyTruncatedSegmentOutput(aiRes.text, aiRes.metrics, aiRes.responseMeta)
            ? null
            : parseSegmentsJSON(aiRes.text, settings);
        let finalParsed = parsed;
        let compactRetryNormalized = null;
        if (finalParsed) {
            logBackground.info("json_parse_success", { task: "segments", bvid });
        } else {
            const parseError = attachSentryContext(
                createSegmentsParseError(aiRes.text, aiRes.metrics, aiRes.responseMeta),
                buildAIResponseSentryContext({
                    task: "segments",
                    bvid,
                    provider: settings.provider,
                    model: settings.model || "",
                    mode: "single",
                    source: "segments_single_parse",
                    responseText: aiRes.text,
                    responseMeta: aiRes.responseMeta,
                    metrics: aiRes.metrics
                })
            );
            logAI.error("json_parse_error", {
                task: "segments",
                bvid,
                code: parseError?.code || "JSON_PARSE_ERROR",
                detail: {
                    reason: "empty_result",
                    ...getSegmentsResponseDiagnostics(aiRes.text, aiRes.metrics)
                }
            });
            compactRetryNormalized = await retrySegmentsWithAutoFallbacks({
                tabId: taskContext?.tabId || null,
                bvid,
                cache,
                settings,
                taskContext,
                subtitleText,
                promptMode: settings.promptSettings?.mode || "guided",
                guided: settings.promptSettings?.guided || {},
                customPrompts: settings.promptSettings?.custom || {},
                mode: "single",
                originalError: parseError,
                initialDurationMs: aiRes.metrics?.latencyMs || 0
            });
        }
        const normalized = compactRetryNormalized || normalizeSegments(finalParsed, cache, { bvid, task: "segments", mode: "single", allowLineOnly: shouldUseCompactSegmentsFirst(settings) });
        if (!normalized.length) {
            const normalizeError = attachSentryContext(
                createSegmentsNormalizeError(parsed),
                buildAIResponseSentryContext({
                    task: "segments",
                    bvid,
                    provider: settings.provider,
                    model: settings.model || "",
                    mode: "single",
                    source: "segments_single_normalize",
                    responseText: aiRes.text,
                    responseMeta: aiRes.responseMeta,
                    metrics: aiRes.metrics,
                    extra: { parsed_item_count: getSegmentCandidateList(parsed)?.length || 0 }
                })
            );
            return await retrySegmentsWithAutoFallbacks({
                tabId: taskContext?.tabId || null,
                bvid,
                cache,
                settings,
                taskContext,
                subtitleText,
                promptMode: settings.promptSettings?.mode || "guided",
                guided: settings.promptSettings?.guided || {},
                customPrompts: settings.promptSettings?.custom || {},
                mode: "single",
                originalError: normalizeError,
                initialDurationMs: aiRes.metrics?.latencyMs || 0
            });
        }
        await recordSegmentsDebugState(taskContext?.tabId || null, {
            status: "done",
            stage: "complete",
            mode: "single",
            segmentCount: normalized.length,
            message: "分段生成完成"
        }, `分段生成成功，共 ${normalized.length} 段`);
        logSegmentQualitySummary(bvid, normalized, cache, { task: "segments", mode: "single", subtitlePayload: getSubtitlePayloadMeta(cache, subtitleText, subtitlePayloadOptions) });
        return normalized;
    }
    const parsed = robustJSONParse(aiRes.text);
    if (parsed) {
        logBackground.info("json_parse_success", { task: "rumors", bvid });
    } else {
        logAI.error("json_parse_error", { task: "rumors", bvid, code: "JSON_PARSE_ERROR", detail: { reason: "empty_result" } });
    }
    const normalized = normalizeRumors(parsed, cache);
    if (!normalized) {
        throw attachSentryContext(
            createAppError("JSON_PARSE_ERROR", "验真 JSON 解析失败"),
            buildAIResponseSentryContext({
                task: "rumors",
                bvid,
                provider: settings.provider,
                model: settings.model || "",
                mode: "single",
                source: "rumors_parse",
                responseText: aiRes.text,
                responseMeta: aiRes.responseMeta,
                metrics: aiRes.metrics
            })
        );
    }
    logRumorsQualitySummary(bvid, normalized, { mode: "single", outputChars: String(aiRes.text || "").length });
    return normalized;
}

function createSummarySegmentsResult() {
    return {
        summary: { ok: false, data: null, error: null },
        segments: { ok: false, data: null, error: null }
    };
}

function sanitizeSummaryOutput(text) {
    let value = String(text || "").trim();
    if (!value) return "";
    value = value
        .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
        .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "")
        .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
        .replace(/<thinking\b[^>]*>[\s\S]*$/gi, "")
        .replace(/^\s*(?:思考过程|思考|推理过程|推理|Reasoning|Thinking)\s*[:：][\s\S]*?(?=\n{2,}|(?:\*\*[^*\n]{2,40}\*\*)|(?:#{1,6}\s+\S)|$)/i, "")
        .replace(/<<<\s*SUMMARY_START\s*>>>/gi, "")
        .replace(/<<<\s*SUMMARY_END\s*>>>/gi, "")
        .replace(/<<<\s*SEGMENTS_START\s*>>>[\s\S]*$/gi, "")
        .replace(/【\s*SUMMARY_START\s*】/gi, "")
        .replace(/【\s*SUMMARY_END\s*】/gi, "")
        .trim();
    const firstBoldHeading = value.search(/\*\*[^*\n]{2,40}\*\*/);
    const leading = firstBoldHeading > 0 ? value.slice(0, firstBoldHeading) : "";
    const hasPlanningPreamble = /让我|我将|需要输出|下面(?:是|为)|根据字幕|视频的核心观点|先来分析|我来梳理/.test(leading);
    if (hasPlanningPreamble) {
        value = value.slice(firstBoldHeading).trim();
    }
    return value;
}

function isLikelyContextTooLongError(error) {
    const message = String(error?.message || error || "");
    return /context length|maximum context|max context|too many tokens|prompt too long|input too long|context_length_exceeded|上下文|提示词.*长|内容.*过长/i.test(message);
}

function isOutputLengthFinishReason(responseMeta = {}) {
    const reason = String(responseMeta?.finishReason || "").trim().toLowerCase();
    return ["length", "max_tokens", "max_output_tokens", "max_tokens_reached", "token_limit"].includes(reason);
}

function isDeepSeekV4ModelName(model) {
    return /(?:^|\/)deepseek-v4(?:-|$)/i.test(String(model || "").trim());
}

function getDeepSeekV4RetryDiagnostics(response = {}) {
    if (response?.responseMeta) {
        return {
            finishReason: String(response.responseMeta.finishReason || ""),
            reasoningChars: Number(response.responseMeta.reasoningChars || 0) || 0,
            contentState: String(response.responseMeta.contentState || ""),
            responseChars: String(response.text || "").length
        };
    }
    const attempts = Array.isArray(response?.sentryContext?.ai_response_attempts)
        ? response.sentryContext.ai_response_attempts
        : [];
    const attempt = attempts[attempts.length - 1] || {};
    return {
        finishReason: String(attempt.finish_reason || ""),
        reasoningChars: Number(attempt.reasoning_chars || 0) || 0,
        contentState: String(attempt.content_state || ""),
        responseChars: Number(attempt.response_chars || 0) || 0
    };
}

function shouldDisableDeepSeekV4ThinkingForRetry(settings = {}, response = {}) {
    if (!isDeepSeekV4ModelName(settings?.model)) return false;
    const diagnostics = getDeepSeekV4RetryDiagnostics(response);
    if (!isOutputLengthFinishReason({ finishReason: diagnostics.finishReason })) return false;
    if (!(diagnostics.reasoningChars > 0)) return false;
    const contentEmpty = ["", "missing", "null", "empty"].includes(diagnostics.contentState.toLowerCase())
        && !(diagnostics.responseChars > 0);
    const contentTruncated = diagnostics.responseChars > 0;
    return contentEmpty || contentTruncated;
}

function buildDeepSeekV4RetrySettings(settings = {}, response = {}) {
    if (!shouldDisableDeepSeekV4ThinkingForRetry(settings, response)) return settings;
    return { ...settings, deepSeekV4ThinkingDisabled: true };
}

function isLikelyTruncatedSegmentOutput(text, metrics = {}, responseMeta = {}) {
    const value = String(text || "").trim();
    if (isOutputLengthFinishReason(responseMeta)) return true;
    const outputTokens = Number(metrics?.outputTokens || metrics?.output_tokens || 0);
    const maxOutputTokens = Number(metrics?.maxOutputTokens || 4096);
    if (outputTokens >= Math.max(1, maxOutputTokens - 96)) return true;
    if (!value) return false;
    const opens = (value.match(/[\[{]/g) || []).length;
    const closes = (value.match(/[\]}]/g) || []).length;
    if (opens > closes) return true;
    if (/<<<\s*SEGMENTS_START\s*>>>/i.test(value) && !/<<<\s*SEGMENTS_END\s*>>>/i.test(value)) return true;
    if (/SEGMENTS_START/i.test(value) && !/SEGMENTS_END/i.test(value)) return true;
    return false;
}

function getSegmentCandidateList(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || typeof parsed !== "object") return null;
    const candidates = [
        parsed.segments,
        parsed.chapters,
        parsed.sections,
        parsed.items,
        parsed.data,
        parsed.result,
        parsed.分段,
        parsed.章节
    ];
    for (const candidate of candidates) {
        if (Array.isArray(candidate)) return candidate;
        const nested = getSegmentCandidateList(candidate);
        if (nested) return nested;
    }
    return null;
}

function createSegmentsParseError(text, metrics = {}, responseMeta = {}) {
    const value = String(text || "").trim();
    if (isOutputLengthFinishReason(responseMeta)) {
        return createAppError("SEGMENTS_OUTPUT_TRUNCATED", "分段输出被截断");
    }
    if (!value) {
        return createAppError("SEGMENTS_EMPTY_RESPONSE", "模型没有返回分段内容");
    }
    if (isLikelyTruncatedSegmentOutput(value, metrics, responseMeta)) {
        return createAppError("SEGMENTS_OUTPUT_TRUNCATED", "分段输出被截断");
    }
    return createAppError("SEGMENTS_JSON_PARSE_FAILED", "分段格式解析失败");
}

function getSegmentsResponseDiagnostics(text, metrics = {}) {
    const value = String(text || "");
    const trimmed = value.trim();
    return {
        response_chars: value.length,
        trimmed_chars: trimmed.length,
        line_count: trimmed ? trimmed.split(/\r?\n/).filter(Boolean).length : 0,
        output_tokens: Number(metrics?.outputTokens || 0) || 0,
        has_json_array_hint: /\[\s*\{/.test(trimmed),
        has_json_object_hint: /^\s*\{/.test(trimmed),
        has_protocol_markers: /SEGMENTS_START|SEGMENTS_END|<<<SEGMENTS_START>>>|<<<SEGMENTS_END>>>|【SEGMENTS_START】|【SEGMENTS_END】/i.test(trimmed),
        preview_head: trimmed.slice(0, 180),
        preview_tail: trimmed.length > 180 ? trimmed.slice(-180) : trimmed
    };
}

function createSegmentsNormalizeError(parsed) {
    const candidateList = getSegmentCandidateList(parsed);
    if (Array.isArray(candidateList) && candidateList.length === 0) {
        return createAppError("SEGMENTS_EMPTY_LIST", "模型没有生成有效分段");
    }
    return createAppError("SEGMENTS_INVALID_SCHEMA", "分段字段不完整");
}

function createSegmentsMissingProtocolError(fullText, metrics = {}, responseMeta = {}) {
    if (isLikelyTruncatedSegmentOutput(fullText, metrics, responseMeta)) {
        return createAppError("SEGMENTS_OUTPUT_TRUNCATED", "分段输出被截断");
    }
    return createAppError("SEGMENTS_MISSING_PROTOCOL", "模型漏掉了分段部分");
}

function normalizeSegmentsTaskError(error) {
    if (isLikelyContextTooLongError(error)) {
        return createAppError("SEGMENTS_CONTEXT_TOO_LONG", "字幕内容过长，模型装不下", {
            cause: error
        });
    }
    return error;
}

function getSummaryEmptyResponseDiagnostics(aiRes = {}) {
    const rawResponseSnapshot = truncateSentryResponseText(String(aiRes?.responseMeta?.rawResponse || ""), 5000, 3000);
    return {
        finish_reason: String(aiRes?.responseMeta?.finishReason || ""),
        content_state: String(aiRes?.responseMeta?.contentState || ""),
        reasoning_chars: Number(aiRes?.responseMeta?.reasoningChars || 0) || 0,
        raw_response: rawResponseSnapshot.text,
        raw_response_truncated: rawResponseSnapshot.truncated
    };
}

function isModelScopeStoppedEmptySummary(settings = {}, aiRes = {}) {
    if (!isStrictModelScopeProvider(settings)) return false;
    const diagnostics = getSummaryEmptyResponseDiagnostics(aiRes);
    return diagnostics.finish_reason.trim().toLowerCase() === "stop"
        && diagnostics.content_state.trim().toLowerCase() === "empty";
}

function logSummaryEmptyResponse({ settings, bvid, mode, source, aiRes } = {}) {
    logAI.warn("summary_empty_response", {
        bvid,
        task: "summary",
        code: "SUMMARY_EMPTY_RESPONSE",
        provider: settings?.provider || "",
        model: settings?.model || "",
        detail: {
            mode: String(mode || ""),
            source: String(source || ""),
            ...getSummaryEmptyResponseDiagnostics(aiRes)
        }
    });
}

function createSummaryEmptyError({ settings, bvid, mode, source, aiRes } = {}) {
    const diagnostics = getSummaryEmptyResponseDiagnostics(aiRes);
    return attachSentryContext(
        createAppError("SUMMARY_EMPTY_RESPONSE", "模型没有返回总结内容"),
        buildAIResponseSentryContext({
            task: "summary",
            bvid,
            provider: settings?.provider || "",
            model: settings?.model || "",
            mode,
            source,
            responseText: aiRes?.text || "",
            responseMeta: aiRes?.responseMeta,
            metrics: aiRes?.metrics,
            extra: diagnostics
        })
    );
}

function createSummaryTruncatedError({ settings, bvid, mode, source, aiRes } = {}) {
    return attachSentryContext(
        createAppError("SUMMARY_OUTPUT_TRUNCATED", "总结输出被截断"),
        buildAIResponseSentryContext({
            task: "summary",
            bvid,
            provider: settings?.provider || "",
            model: settings?.model || "",
            mode,
            source,
            responseText: aiRes?.text || "",
            responseMeta: aiRes?.responseMeta,
            metrics: aiRes?.metrics
        })
    );
}

async function retryEmptySummaryOnce({ settings, prompt, tabId, bvid, mode, requestStream = false, taskContext = {}, initialAIResponse = null, initialDurationMs = 0 }) {
    const retrySettings = buildDeepSeekV4RetrySettings(settings, initialAIResponse);
    const thinkingDisabledForRetry = retrySettings !== settings;
    const retryStrategy = thinkingDisabledForRetry ? "deepseek_v4_no_thinking_retry" : "summary_empty_retry";
    const triggerError = thinkingDisabledForRetry
        ? createSummaryTruncatedError({ settings, bvid, mode, source: "summary_initial_truncated", aiRes: initialAIResponse })
        : createSummaryEmptyError({ settings, bvid, mode, source: "summary_initial_empty", aiRes: initialAIResponse });
    if (thinkingDisabledForRetry) {
        logAI.warn("summary_output_truncated", {
            bvid,
            task: "summary",
            code: "SUMMARY_OUTPUT_TRUNCATED",
            provider: settings?.provider || "",
            model: settings?.model || "",
            detail: { mode, ...getSummaryEmptyResponseDiagnostics(initialAIResponse), thinking_disabled_on_retry: true }
        });
    } else {
        logSummaryEmptyResponse({ settings, bvid, mode, source: "initial", aiRes: initialAIResponse });
    }
    if (!isRemoteFeatureEnabled(settings?.remoteConfig, "summary_empty_retry", true)) throw triggerError;
    const runSummaryRequest = async (requestSettings, requestOptions = {}) => {
        let streamedSummaryText = "";
        const messages = [{ role: "user", content: prompt }];
        const aiRes = requestStream
            ? await callAIWithTimeoutStream(requestSettings, messages, TASK_TIMEOUT_MS, (delta) => {
                streamedSummaryText += String(delta || "");
            }, null, { tabId, taskContext, component: "summary", bvid, ...requestOptions })
            : await callAIWithTimeout(requestSettings, messages, TASK_TIMEOUT_MS, {
                bypassQueue: true,
                tabId,
                taskContext,
                component: "summary",
                bvid,
                ...requestOptions
            });
        return {
            aiRes,
            summaryText: sanitizeSummaryOutput(aiRes.text || streamedSummaryText)
        };
    };
    if (!thinkingDisabledForRetry && isModelScopeStoppedEmptySummary(settings, initialAIResponse)) {
        await recordSummaryRetryDebugState(tabId, {
            status: "retrying",
            stage: "model_fallback",
            attempt: 1,
            total: 1,
            code: triggerError.code || "SUMMARY_EMPTY_RESPONSE",
            mode,
            message: "总结正文为空，正在切换 ModelScope 备用模型"
        }, "总结正文为空，直接切换 ModelScope 备用模型").catch(() => {});
        try {
            const fallbackResult = await tryModelScopeFallback(
                settings,
                { tabId, taskContext, component: "summary", bvid },
                triggerError,
                async (fallbackSettings) => {
                    const retried = await runSummaryRequest(fallbackSettings, {
                        disableModelFallback: true,
                        disableProvider429Retry: true
                    });
                    if (!retried.summaryText) {
                        throw createSummaryEmptyError({
                            settings: fallbackSettings,
                            bvid,
                            mode,
                            source: "summary_model_fallback_empty",
                            aiRes: retried.aiRes
                        });
                    }
                    return { ...retried.aiRes, text: retried.summaryText };
                }
            );
            if (fallbackResult) {
                const summaryText = sanitizeSummaryOutput(fallbackResult.text);
                await recordSummaryRetryDebugState(tabId, {
                    status: "recovered",
                    stage: "recovered",
                    attempt: 1,
                    total: 1,
                    code: "",
                    mode,
                    message: "备用模型已生成总结"
                }, "ModelScope 备用模型已修复总结空响应").catch(() => {});
                return { aiRes: fallbackResult, summaryText };
            }
        } catch (error) {
            await recordSummaryRetryDebugState(tabId, {
                status: "retry_failed",
                stage: "retry_failed",
                attempt: 1,
                total: 1,
                code: String(error?.code || "SUMMARY_EMPTY_RESPONSE"),
                mode,
                message: error?.message || "备用模型仍未返回总结"
            }, `ModelScope 备用模型重试失败：${String(error?.code || "SUMMARY_EMPTY_RESPONSE")}`).catch(() => {});
            throw error;
        }
    }
    await reportTaskInitialFailure({
        settings,
        taskContext,
        component: "summary",
        bvid,
        error: triggerError,
        durationMs: initialDurationMs
    });
    logAI.warn("summary_empty_retry_start", {
        bvid,
        task: "summary",
        provider: settings.provider,
        model: settings.model || "",
        detail: {
            mode,
            attempt: 1,
            max_attempts: 1,
            prompt_chars: prompt.length,
            request_stream: requestStream,
            thinking_disabled: thinkingDisabledForRetry
        }
    });
    await recordSummaryRetryDebugState(tabId, {
        status: "retrying",
        stage: "summary_retry",
        attempt: 1,
        total: 1,
        code: triggerError.code || "SUMMARY_EMPTY_RESPONSE",
        mode,
        message: thinkingDisabledForRetry ? "总结输出被截断，正在关闭思考重试" : "总结为空，正在自动重试"
    }, thinkingDisabledForRetry ? "DeepSeek V4 输出截断，关闭思考进行第 1/1 次重试" : "开始第 1/1 次总结空响应自动重试").catch(() => {});
    const recoveryStartedAt = Date.now();
    try {
        const retried = await runSummaryRequest(retrySettings);
        const { aiRes, summaryText } = retried;
        if (!summaryText) {
            logSummaryEmptyResponse({ settings, bvid, mode, source: "retry", aiRes });
            throw createSummaryEmptyError({
                settings,
                bvid,
                mode,
                source: "summary_retry_empty",
                aiRes
            });
        }
        await reportTaskRecoveryFinished({
            settings,
            taskContext,
            component: "summary",
            bvid,
            strategy: retryStrategy,
            triggerError,
            success: true,
            durationMs: Date.now() - recoveryStartedAt,
            metrics: aiRes.metrics
        });
        await recordSummaryRetryDebugState(tabId, {
            status: "recovered",
            stage: "recovered",
            attempt: 1,
            total: 1,
            code: "",
            mode,
            message: "总结重试成功"
        }, "总结空响应自动重试成功").catch(() => {});
        logAI.info("summary_empty_retry_success", {
            bvid,
            task: "summary",
            provider: settings.provider,
            model: settings.model || "",
            detail: { mode, output_chars: summaryText.length }
        });
        return { aiRes, summaryText };
    } catch (error) {
        await reportTaskRecoveryFinished({
            settings,
            taskContext,
            component: "summary",
            bvid,
            strategy: retryStrategy,
            triggerError,
            resultError: error,
            success: false,
            durationMs: Date.now() - recoveryStartedAt
        });
        await recordSummaryRetryDebugState(tabId, {
            status: "retry_failed",
            stage: "retry_failed",
            attempt: 1,
            total: 1,
            code: String(error?.code || "SUMMARY_EMPTY_RESPONSE"),
            mode,
            message: error?.message || "总结重试失败"
        }, `总结空响应自动重试失败：${String(error?.code || "SUMMARY_EMPTY_RESPONSE")}`).catch(() => {});
        throw error;
    }
}

function pickSummarySegmentsFailureError(results) {
    const summaryError = results?.summary?.error || null;
    const segmentsError = results?.segments?.error || null;
    const segmentsCode = String(segmentsError?.code || "");
    if (segmentsCode.startsWith("SEGMENTS_")) return segmentsError;
    return summaryError || segmentsError || new Error("生成失败");
}

function shouldUseCompactSegmentsFirst(settings = {}) {
    const provider = String(settings?.provider || "").toLowerCase();
    if (provider === "modelscope") return true;
    return provider === "openrouter" && String(settings?.model || "").toLowerCase() === "openrouter/free";
}

const AUTO_RETRY_SEGMENT_ERROR_CODES = new Set([
    "SEGMENTS_JSON_PARSE_FAILED",
    "SEGMENTS_INVALID_SCHEMA",
    "SEGMENTS_EMPTY_RESPONSE",
    "SEGMENTS_OUTPUT_TRUNCATED",
    "SEGMENTS_EMPTY_LIST",
    "SEGMENTS_MISSING_PROTOCOL"
]);

function shouldAutoRetrySegmentsError(error) {
    return AUTO_RETRY_SEGMENT_ERROR_CODES.has(String(error?.code || ""));
}

function parseSegmentsJSON(responseText, settings = {}) {
    if (!isStrictModelScopeProvider(settings)) return robustJSONParse(responseText);
    const content = String(responseText || "")
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
    if (!content) return null;
    try {
        return JSON.parse(content);
    } catch (_) {
        return null;
    }
}

function canRepairSegmentsResponseWithAI(error) {
    const source = String(error?.[SEGMENTS_REPAIR_SOURCE] || "").trim();
    return shouldAttemptSegmentsAIRepair(error?.code, source);
}

function hasAttemptedSegmentsAIRepair(taskContext = {}) {
    return taskContext?.segmentsAIJsonRepairAttempted === true;
}

function markSegmentsAIRepairAttempted(taskContext = {}) {
    if (taskContext && typeof taskContext === "object") taskContext.segmentsAIJsonRepairAttempted = true;
}

async function ensureOffscreenDocument() {
    const targetUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
    if (offscreenDocumentPromise) return offscreenDocumentPromise;
    offscreenDocumentPromise = (async () => {
        try {
            if (chrome.offscreen?.createDocument && chrome.runtime.getContexts) {
                const contexts = await chrome.runtime.getContexts({
                    contextTypes: ["OFFSCREEN_DOCUMENT"],
                    documentUrls: [targetUrl]
                });
                if (Array.isArray(contexts) && contexts.length) return;
            }
            if (chrome.offscreen?.createDocument) {
                await chrome.offscreen.createDocument({
                    url: OFFSCREEN_DOCUMENT_PATH,
                    reasons: ["WORKERS"],
                    justification: "Use ffmpeg workers to split oversized audio before Groq transcription"
                });
                return;
            }
            if (typeof document === "undefined") {
                throw new Error("当前浏览器无法创建音频处理文档");
            }
            const existingFrame = document.getElementById(FIREFOX_OFFSCREEN_IFRAME_ID);
            if (existingFrame) return;
            await new Promise((resolve, reject) => {
                const frame = document.createElement("iframe");
                frame.id = FIREFOX_OFFSCREEN_IFRAME_ID;
                frame.hidden = true;
                frame.src = targetUrl;
                frame.addEventListener("load", resolve, { once: true });
                frame.addEventListener("error", () => reject(new Error("音频处理文档加载失败")), { once: true });
                (document.body || document.documentElement).appendChild(frame);
            });
        } catch (error) {
            const message = String(error?.message || error || "");
            if (!/Only a single offscreen document may be created|already exists/i.test(message)) {
                offscreenDocumentPromise = null;
                throw error;
            }
        }
    })();
    return offscreenDocumentPromise;
}

async function requestOffscreenAudioChunkingPrepare(payload = {}) {
    await ensureOffscreenDocument();
    if (payload?.audioBlob instanceof Blob) {
        return requestOffscreenAudioChunkingPrepareFromBlob(payload);
    }
    const audioUrl = String(payload?.audioUrl || "").trim();
    if (audioUrl) {
        const response = await chrome.runtime.sendMessage({
            action: "OFFSCREEN_CHUNK_AUDIO_PREPARE",
            payload: {
                audioUrl,
                mimeType: String(payload?.mimeType || "audio/mp4"),
                maxAudioBytes: Number(payload?.maxAudioBytes || 0),
                provider: String(payload?.provider || "groq")
            }
        });
        if (response?.ok) return response.result || {};
        throw createAppError(
            response?.code || "ASR_CHUNKING_FAILED",
            response?.error || "音轨切片失败，请稍后重试"
        );
    }
    return requestOffscreenAudioChunkingPrepareFromBlob(payload);
}

async function requestOffscreenAudioChunkingPrepareFromBlob(payload = {}) {
    await ensureOffscreenDocument();
    const audioBlob = payload?.audioBlob instanceof Blob ? payload.audioBlob : null;
    if (!audioBlob) {
        throw createAppError("ASR_CHUNKING_FAILED", "缺少已下载音轨，无法切片");
    }
    const signal = payload?.signal || null;
    let uploadId = "";
    let finished = false;
    try {
        const started = await chrome.runtime.sendMessage({
            action: "OFFSCREEN_CHUNK_AUDIO_UPLOAD_START",
            payload: {
                expectedBytes: audioBlob.size,
                mimeType: String(payload?.mimeType || audioBlob.type || "audio/mp4"),
                maxAudioBytes: Number(payload?.maxAudioBytes || 0),
                provider: String(payload?.provider || "groq")
            }
        });
        if (!started?.ok) {
            throw createAppError(started?.code || "ASR_CHUNKING_FAILED", started?.error || "音轨切片准备失败");
        }
        uploadId = String(started?.result?.uploadId || "").trim();
        if (!uploadId) throw createAppError("ASR_CHUNKING_FAILED", "音轨切片会话创建失败");

        for (let offset = 0; offset < audioBlob.size; offset += ASR_PAGE_FETCH_CHUNK_BYTES) {
            if (signal?.aborted) throw createUserAbortedError();
            const buffer = await audioBlob.slice(offset, offset + ASR_PAGE_FETCH_CHUNK_BYTES).arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = "";
            for (let index = 0; index < bytes.length; index += 0x8000) {
                binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
            }
            const appended = await chrome.runtime.sendMessage({
                action: "OFFSCREEN_CHUNK_AUDIO_UPLOAD_APPEND",
                payload: { uploadId, dataBase64: btoa(binary) }
            });
            if (!appended?.ok) {
                throw createAppError(appended?.code || "ASR_CHUNKING_FAILED", appended?.error || "音轨分块传输失败");
            }
        }

        const response = await chrome.runtime.sendMessage({
            action: "OFFSCREEN_CHUNK_AUDIO_UPLOAD_FINISH",
            payload: { uploadId }
        });
        if (!response?.ok) {
            throw createAppError(
                response?.code || "ASR_CHUNKING_FAILED",
                response?.error || "音轨切片失败，请稍后重试"
            );
        }
        finished = true;
        return response.result || {};
    } finally {
        if (uploadId && !finished) {
            await chrome.runtime.sendMessage({
                action: "OFFSCREEN_CHUNK_AUDIO_UPLOAD_RELEASE",
                payload: { uploadId }
            }).catch(() => {});
        }
    }
}

async function requestOffscreenGroqChunkTranscription(payload = {}) {
    await ensureOffscreenDocument();
    const response = await chrome.runtime.sendMessage({
        action: "OFFSCREEN_CHUNK_AUDIO_TRANSCRIBE_ALL",
        payload
    });
    if (!response?.ok) {
        throw createAppError(
            response?.code || "ASR_CHUNKING_FAILED",
            response?.error || "音轨切片失败，请稍后重试"
        );
    }
    return response.result || {};
}

async function requestOffscreenChunkTranscriptionAll(payload = {}) {
    return requestOffscreenGroqChunkTranscription(payload);
}

async function releaseOffscreenAudioChunkSession(sessionId) {
    if (!sessionId) return;
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
        action: "OFFSCREEN_CHUNK_AUDIO_RELEASE",
        payload: { sessionId }
    }).catch(() => {});
}

async function handleOffscreenChunkProgress(payload = {}) {
    const tabId = Number(payload?.tabId || 0);
    const bvid = normalizeBvid(payload?.bvid || "");
    const chunkIndex = Math.max(1, Number(payload?.chunkIndex || 1));
    const chunkCount = Math.max(chunkIndex, Number(payload?.chunkCount || chunkIndex));
    if (!tabId || !bvid) return;
    const progress = 62 + Math.min(24, Math.round((chunkIndex / Math.max(1, chunkCount)) * 24));
    const rangeText = `${formatPlaybackTime(Number(payload?.startSec || 0))}-${formatPlaybackTime(Number(payload?.endSec || 0))}`;
    await updateTabState(tabId, { activeBvid: bvid, transcriptionProgress: progress, updatedAt: Date.now() });
    await notifyTranscribeStatus(tabId, {
        stage: "upload",
        level: "info",
        text: `正在转录第 ${chunkIndex}/${chunkCount} 段音轨...`,
        progress,
        bvid
    });
    await recordAsrChunkingProgressState(tabId, {
        chunkIndex,
        chunkCount,
        rangeText
    });
}

async function recordAsrChunkingProgressState(tabId, patch = {}) {
    if (!tabId) return;
    const current = await getTabState(tabId);
    const taskRetryState = { ...(current?.taskRetryState || {}) };
    const previous = taskRetryState.asrChunking && typeof taskRetryState.asrChunking === "object"
        ? taskRetryState.asrChunking
        : {};
    taskRetryState.asrChunking = {
        ...previous,
        ...patch,
        updatedAt: Date.now()
    };
    await updateTabState(tabId, { taskRetryState, updatedAt: Date.now() });
}

function consumeDebugForceFirstSegmentsFailure(taskContext = {}) {
    if (!taskContext || taskContext.debugForceFirstSegmentsFailure !== true) return false;
    taskContext.debugForceFirstSegmentsFailure = false;
    return true;
}

async function recordSegmentsDebugState(tabId, patch = {}, eventText = "", options = {}) {
    if (!tabId) return;
    const current = await getTabState(tabId);
    const taskRetryState = { ...(current?.taskRetryState || {}) };
    const previous = taskRetryState.segments && typeof taskRetryState.segments === "object"
        ? taskRetryState.segments
        : {};
    const events = options.resetEvents ? [] : (Array.isArray(previous.events) ? previous.events.slice(-7) : []);
    if (eventText) {
        events.push({
            at: Date.now(),
            text: String(eventText || "")
        });
    }
    taskRetryState.segments = {
        ...previous,
        ...patch,
        events,
        updatedAt: Date.now()
    };
    await updateTabState(tabId, { taskRetryState, updatedAt: Date.now() });
}

async function clearSegmentsDebugState(tabId) {
    if (!tabId) return;
    const current = await getTabState(tabId);
    const taskRetryState = { ...(current?.taskRetryState || {}) };
    if (!taskRetryState.segments) return;
    delete taskRetryState.segments;
    await updateTabState(tabId, { taskRetryState, updatedAt: Date.now() });
}

async function recordAsrChunkingDebugState(tabId, diagnostics = null) {
    if (!tabId) return;
    const current = await getTabState(tabId);
    const taskRetryState = { ...(current?.taskRetryState || {}) };
    const boundaries = Array.isArray(diagnostics?.boundaries)
        ? diagnostics.boundaries.slice(0, MAX_ASR_BOUNDARY_DIAGNOSTICS)
        : [];
    taskRetryState.asrChunking = {
        boundaries,
        updatedAt: Date.now()
    };
    await updateTabState(tabId, { taskRetryState, updatedAt: Date.now() });
}

function buildPrimarySegmentsPrompt({ settings, cache, subtitleText, mode, guided, customPrompts, taskContext, promptTaskContext, forceFull = false }) {
    if (!forceFull && shouldUseCompactSegmentsFirst(settings)) {
        const compactSubtitle = buildCompactSegmentsSubtitlePayload(cache, MAX_SEGMENTS_SUBTITLE_CHARS) || subtitleText;
        return {
            prompt: buildCompactSegmentsPrompt({ subtitle: compactSubtitle, taskContext: promptTaskContext }),
            subtitleText: compactSubtitle,
            compact: true
        };
    }
    return {
        prompt: buildPrompt({ type: "segments", subtitle: subtitleText, mode, guided, customPrompts, taskContext: promptTaskContext }),
        subtitleText,
        compact: false
    };
}

async function retrySegmentsWithCompactPrompt({ tabId, bvid, cache, settings, taskContext, mode, originalError, disableModelFallback = false }) {
    const compactSubtitle = buildCompactSegmentsSubtitlePayload(cache, MAX_SEGMENTS_SUBTITLE_CHARS);
    if (!compactSubtitle) throw originalError || createSegmentsParseError("");
    const promptTaskContext = { ...taskContext, noSubtitleTimestamps: isNoTimestampSubtitleCache(cache) };
    const compactPrompt = buildCompactSegmentsPrompt({ subtitle: compactSubtitle, taskContext: promptTaskContext });
    logAI.warn("segments_compact_retry_start", {
        bvid,
        task: "segments",
        provider: settings.provider,
        model: settings.model || "",
        code: originalError?.code || "",
        detail: {
            mode,
            subtitle_chars: compactSubtitle.length,
            prompt_chars: compactPrompt.length
        }
    });
    const aiRes = await callAIWithTimeout(settings, [{ role: "user", content: compactPrompt }], TASK_TIMEOUT_MS, {
        bypassQueue: true,
        tabId,
        taskContext,
        component: "segments",
        bvid,
        disableModelFallback
    });
    const parsed = isLikelyTruncatedSegmentOutput(aiRes.text, aiRes.metrics, aiRes.responseMeta)
        ? null
            : parseSegmentsJSON(aiRes.text, settings);
    if (!parsed) {
        const parseError = attachSentryContext(
            createSegmentsParseError(aiRes.text, aiRes.metrics, aiRes.responseMeta),
            buildAIResponseSentryContext({
                task: "segments",
                bvid,
                provider: settings.provider,
                model: settings.model || "",
                mode: `${mode}_compact_retry`,
                source: "segments_compact_retry_parse",
                responseText: aiRes.text,
                responseMeta: aiRes.responseMeta,
                metrics: aiRes.metrics
            })
        );
        logAI.error("segments_compact_retry_parse_error", {
            bvid,
            task: "segments",
            code: parseError?.code || "JSON_PARSE_ERROR",
            detail: {
                mode,
                ...getSegmentsResponseDiagnostics(aiRes.text, aiRes.metrics)
            }
        });
        throw parseError;
    }
    const normalized = normalizeSegments(parsed, cache, { bvid, task: "segments", mode: `${mode}_compact_retry`, allowLineOnly: true });
    if (!normalized.length) {
        throw attachSentryContext(
            createSegmentsNormalizeError(parsed),
            buildAIResponseSentryContext({
                task: "segments",
                bvid,
                provider: settings.provider,
                model: settings.model || "",
                mode: `${mode}_compact_retry`,
                source: "segments_compact_retry_normalize",
                responseText: aiRes.text,
                responseMeta: aiRes.responseMeta,
                metrics: aiRes.metrics,
                extra: { parsed_item_count: getSegmentCandidateList(parsed)?.length || 0 }
            })
        );
    }
    logSegmentQualitySummary(bvid, normalized, cache, {
        task: "segments",
        mode: `${mode}_compact_retry`,
        subtitlePayload: {
            source: "raw_indexed_compact_retry",
            purpose: "segments",
            mode,
            payload_chars: compactSubtitle.length,
            max_chars: MAX_SEGMENTS_SUBTITLE_CHARS,
            no_timestamp: isNoTimestampSubtitleCache(cache),
            raw_count: Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle.length : 0,
            processed_count: Array.isArray(cache?.processedSubtitle) ? cache.processedSubtitle.length : 0
        }
    });
    await applySummarySegmentsResults(tabId, bvid, {
        segments: { ok: true, data: normalized, error: null }
    }, { taskContext });
    await appendMetrics(bvid, null, "segments", aiRes.metrics, taskContext);
    await reportFeatureUsage("segments", bvid, settings, aiRes.metrics);
    logAI.info("segments_compact_retry_success", {
        bvid,
        task: "segments",
        provider: settings.provider,
        model: settings.model || "",
        duration_ms: aiRes.metrics?.latencyMs || 0,
        detail: {
            mode,
            output_chars: String(aiRes.text || "").length,
            segment_count: normalized.length
        }
    });
    return normalized;
}

async function retrySegmentsWithAIRepair({ tabId, bvid, cache, settings, mode, originalError }) {
    const responseText = String(originalError?.[SEGMENTS_REPAIR_SOURCE] || "").trim();
    if (!responseText) throw originalError;
    const repairPrompt = buildSegmentsAIRepairPrompt(responseText);
    logAI.warn("segments_ai_json_repair_start", {
        bvid,
        task: "segments",
        provider: settings.provider,
        model: settings.model || "",
        code: originalError?.code || "",
        detail: {
            mode,
            response_chars: responseText.length,
            prompt_chars: repairPrompt.length
        }
    });
    const aiRes = await callAIWithTimeout(
        settings,
        [{ role: "user", content: repairPrompt }],
        TASK_TIMEOUT_MS,
        { bypassQueue: true, tabId, taskContext, component: "segments", bvid }
    );
    const parsed = isLikelyTruncatedSegmentOutput(aiRes.text, aiRes.metrics, aiRes.responseMeta)
        ? null
        : parseSegmentsJSON(aiRes.text, settings);
    if (!parsed) {
        throw attachSentryContext(
            createSegmentsParseError(aiRes.text, aiRes.metrics, aiRes.responseMeta),
            buildAIResponseSentryContext({
                task: "segments",
                bvid,
                provider: settings.provider,
                model: settings.model || "",
                mode: `${mode}_ai_json_repair`,
                source: "segments_ai_json_repair_parse",
                responseText: aiRes.text,
                responseMeta: aiRes.responseMeta,
                metrics: aiRes.metrics
            })
        );
    }
    const normalized = normalizeSegments(parsed, cache, {
        bvid,
        task: "segments",
        mode: `${mode}_ai_json_repair`,
        allowLineOnly: true
    });
    if (!normalized.length) {
        throw attachSentryContext(
            createSegmentsNormalizeError(parsed),
            buildAIResponseSentryContext({
                task: "segments",
                bvid,
                provider: settings.provider,
                model: settings.model || "",
                mode: `${mode}_ai_json_repair`,
                source: "segments_ai_json_repair_normalize",
                responseText: aiRes.text,
                responseMeta: aiRes.responseMeta,
                metrics: aiRes.metrics,
                extra: { parsed_item_count: getSegmentCandidateList(parsed)?.length || 0 }
            })
        );
    }
    logAI.info("segments_ai_json_repair_success", {
        bvid,
        task: "segments",
        provider: settings.provider,
        model: settings.model || "",
        duration_ms: aiRes.metrics?.latencyMs || 0,
        detail: {
            mode,
            source_chars: responseText.length,
            output_chars: String(aiRes.text || "").length,
            segment_count: normalized.length
        }
    });
    return { segments: normalized, metrics: aiRes.metrics || {} };
}

async function retrySegmentsWithPrimaryPrompt({
    tabId,
    bvid,
    cache,
    settings,
    taskContext,
    subtitleText,
    promptMode,
    guided,
    customPrompts,
    mode,
    originalError
}) {
    const promptTaskContext = { ...taskContext, noSubtitleTimestamps: isNoTimestampSubtitleCache(cache) };
    const segmentPromptPlan = buildPrimarySegmentsPrompt({
        settings,
        cache,
        subtitleText,
        mode: promptMode,
        guided,
        customPrompts,
        taskContext,
        promptTaskContext,
        forceFull: shouldUseCompactSegmentsFirst(settings)
    });
    logAI.warn("segments_primary_retry_start", {
        bvid,
        task: "segments",
        provider: settings.provider,
        model: settings.model || "",
        code: originalError?.code || "",
        detail: {
            mode,
            subtitle_chars: (segmentPromptPlan?.subtitleText || subtitleText).length,
            prompt_chars: segmentPromptPlan.prompt.length,
            compact_segments: !!segmentPromptPlan.compact
        }
    });
    const aiRes = await callAIWithTimeout(settings, [{ role: "user", content: segmentPromptPlan.prompt }], TASK_TIMEOUT_MS, { bypassQueue: true, tabId, taskContext, component: "segments", bvid });
    const parsed = isLikelyTruncatedSegmentOutput(aiRes.text, aiRes.metrics, aiRes.responseMeta)
        ? null
        : parseSegmentsJSON(aiRes.text, settings);
    if (!parsed) {
        const parseError = attachSentryContext(
            createSegmentsParseError(aiRes.text, aiRes.metrics, aiRes.responseMeta),
            buildAIResponseSentryContext({
                task: "segments",
                bvid,
                provider: settings.provider,
                model: settings.model || "",
                mode: `${mode}_primary_retry`,
                source: "segments_primary_retry_parse",
                    responseText: aiRes.text,
                    responseMeta: aiRes.responseMeta,
                    metrics: aiRes.metrics,
                    extra: {
                    compact_segments: !!segmentPromptPlan.compact
                }
            })
        );
        throw parseError;
    }
    const normalized = normalizeSegments(parsed, cache, {
        bvid,
        task: "segments",
        mode: `${mode}_primary_retry`,
        allowLineOnly: !!segmentPromptPlan.compact
    });
    if (!normalized.length) {
        throw attachSentryContext(
            createSegmentsNormalizeError(parsed),
            buildAIResponseSentryContext({
                task: "segments",
                bvid,
                provider: settings.provider,
                model: settings.model || "",
                mode: `${mode}_primary_retry`,
                source: "segments_primary_retry_normalize",
                responseText: aiRes.text,
                responseMeta: aiRes.responseMeta,
                metrics: aiRes.metrics,
                extra: {
                    compact_segments: !!segmentPromptPlan.compact,
                    parsed_item_count: getSegmentCandidateList(parsed)?.length || 0
                }
            })
        );
    }
    logAI.info("segments_primary_retry_success", {
        bvid,
        task: "segments",
        provider: settings.provider,
        model: settings.model || "",
        duration_ms: aiRes.metrics?.latencyMs || 0,
        detail: {
            mode,
            output_chars: String(aiRes.text || "").length,
            segment_count: normalized.length,
            compact_segments: !!segmentPromptPlan.compact
        }
    });
    return normalized;
}

async function retrySegmentsWithAutoFallbacks({
    tabId,
    bvid,
    cache,
    settings,
    taskContext,
    subtitleText,
    promptMode,
    guided,
    customPrompts,
    mode,
    originalError,
    initialDurationMs = 0
}) {
    let latestError = normalizeSegmentsTaskError(originalError);
    if (!shouldAutoRetrySegmentsError(latestError)) throw latestError;
    await reportTaskInitialFailure({
        settings,
        taskContext,
        component: "segments",
        bvid,
        error: latestError,
        durationMs: initialDurationMs
    });
    const structuredOutputError = [
        "SEGMENTS_JSON_PARSE_FAILED",
        "SEGMENTS_INVALID_SCHEMA",
        "SEGMENTS_EMPTY_LIST",
        "SEGMENTS_MISSING_PROTOCOL"
    ].includes(String(latestError?.code || ""));
    if (structuredOutputError && isStrictModelScopeProvider(settings)) {
        await recordSegmentsDebugState(tabId, {
            status: "retrying",
            stage: "model_fallback",
            strategy: "model_fallback",
            attempt: 1,
            total: 1,
            code: String(latestError?.code || ""),
            mode,
            message: "分段格式异常，正在切换备用模型重试"
        }, "分段 JSON/字段异常，直接切换 ModelScope 备用模型");
        const fallbackResult = await tryModelScopeFallback(
            settings,
            { tabId, taskContext, component: "segments", bvid },
            latestError,
            (fallbackSettings) => retrySegmentsWithCompactPrompt({
                tabId,
                bvid,
                cache,
                settings: fallbackSettings,
                taskContext,
                mode,
                originalError: latestError,
                disableModelFallback: true
            })
        );
        if (Array.isArray(fallbackResult) && fallbackResult.length) {
            await recordSegmentsDebugState(tabId, {
                status: "recovered",
                stage: "recovered",
                strategy: "model_fallback",
                message: "备用模型已生成有效分段"
            }, "ModelScope 备用模型重试成功");
            return fallbackResult;
        }
        throw latestError;
    }
    let primaryUsed = false;
    let expandedTokensUsed = false;
    let compactUsed = false;
    let aiJsonRepairUsed = hasAttemptedSegmentsAIRepair(taskContext);
    let attempt = 0;
    while (true) {
        let strategy = "";
        let retryStep = null;
        if (!aiJsonRepairUsed
            && canRepairSegmentsResponseWithAI(latestError)
            && isRemoteFeatureEnabled(settings?.remoteConfig, "segments_ai_json_repair", true)) {
            strategy = "ai_json_repair";
            aiJsonRepairUsed = true;
            markSegmentsAIRepairAttempted(taskContext);
            retryStep = () => retrySegmentsWithAIRepair({
                tabId,
                bvid,
                cache,
                settings,
                mode,
                originalError: latestError
            });
        } else if (String(latestError?.code || "") === "SEGMENTS_OUTPUT_TRUNCATED"
            && !expandedTokensUsed
            && isRemoteFeatureEnabled(settings?.remoteConfig, "segments_expanded_tokens_retry", true)) {
            strategy = "expanded_tokens";
            expandedTokensUsed = true;
            primaryUsed = true;
            const expandedRetrySettings = buildDeepSeekV4RetrySettings(settings, latestError);
            retryStep = () => retrySegmentsWithPrimaryPrompt({
                tabId,
                bvid,
                cache,
                settings: { ...expandedRetrySettings, maxOutputTokens: EXPANDED_SEGMENTS_MAX_OUTPUT_TOKENS },
                taskContext,
                subtitleText,
                promptMode,
                guided,
                customPrompts,
                mode,
                originalError: latestError
            });
        } else if (!primaryUsed && isRemoteFeatureEnabled(settings?.remoteConfig, "segments_primary_retry", true)) {
            strategy = "primary";
            primaryUsed = true;
            retryStep = () => retrySegmentsWithPrimaryPrompt({
                tabId,
                bvid,
                cache,
                settings,
                taskContext,
                subtitleText,
                promptMode,
                guided,
                customPrompts,
                mode,
                originalError: latestError
            });
        } else if (!compactUsed && isRemoteFeatureEnabled(settings?.remoteConfig, "segments_compact_retry", true)) {
            strategy = "compact";
            compactUsed = true;
            retryStep = () => retrySegmentsWithCompactPrompt({
                tabId,
                bvid,
                cache,
                settings,
                taskContext,
                mode,
                originalError: latestError
            });
        } else {
            throw latestError;
        }
        attempt += 1;
        const strategyLabel = strategy === "ai_json_repair"
            ? "AI JSON 修复"
            : strategy === "expanded_tokens"
            ? "提高输出上限"
            : (strategy === "primary" ? "原 Prompt" : "保守 Prompt");
        await recordSegmentsDebugState(tabId, {
            status: "retrying",
            stage: strategy === "ai_json_repair"
                ? "ai_json_repair"
                : (strategy === "expanded_tokens" ? "expanded_tokens_retry" : (strategy === "primary" ? "primary_retry" : "compact_retry")),
            attempt,
            total: 4,
            strategy,
            code: String(latestError?.code || ""),
            mode,
            startedAt: Date.now(),
            maxOutputTokens: strategy === "expanded_tokens" ? EXPANDED_SEGMENTS_MAX_OUTPUT_TOKENS : undefined,
            thinkingDisabled: strategy === "expanded_tokens" && shouldDisableDeepSeekV4ThinkingForRetry(settings, latestError),
            message: `${strategyLabel}自动重试中`
        }, `开始第 ${attempt} 次自动重试：${strategyLabel}`);
        const recoveryStartedAt = Date.now();
        const triggerError = latestError;
        try {
            const outcome = await retryStep();
            const result = Array.isArray(outcome) ? outcome : outcome?.segments;
            const recoveryMetrics = Array.isArray(outcome) ? {} : (outcome?.metrics || {});
            if (!Array.isArray(result) || !result.length) throw createSegmentsNormalizeError(result);
            await reportTaskRecoveryFinished({
                settings,
                taskContext,
                component: "segments",
                bvid,
                strategy: strategy === "primary" ? "primary_retry" : (strategy === "compact" ? "compact_retry" : strategy),
                triggerError,
                success: true,
                durationMs: Date.now() - recoveryStartedAt,
                metrics: recoveryMetrics
            });
            await recordSegmentsDebugState(tabId, {
                status: "recovered",
                stage: "recovered",
                strategy,
                message: `${strategyLabel}重试成功`
            }, `自动重试成功：${strategyLabel}`);
            return result;
        } catch (retryError) {
            latestError = mergeSegmentsResponseAttempts(normalizeSegmentsTaskError(retryError), latestError);
            await reportTaskRecoveryFinished({
                settings,
                taskContext,
                component: "segments",
                bvid,
                strategy: strategy === "primary" ? "primary_retry" : (strategy === "compact" ? "compact_retry" : strategy),
                triggerError,
                resultError: latestError,
                success: false,
                durationMs: Date.now() - recoveryStartedAt
            });
            logAI.warn("segments_auto_retry_failed", buildFailureLog(latestError, {
                task: "segments",
                bvid,
                provider: settings.provider,
                model: settings.model || "",
                detail: {
                    mode,
                    retry_attempt: attempt,
                    retry_strategy: strategy,
                    max_output_tokens: strategy === "expanded_tokens" ? EXPANDED_SEGMENTS_MAX_OUTPUT_TOKENS : undefined
                }
            }));
            await recordSegmentsDebugState(tabId, {
                status: "retry_failed",
                stage: "retry_failed",
                strategy,
                code: String(latestError?.code || ""),
                message: latestError?.message || "自动重试失败"
            }, `自动重试失败：${strategyLabel} · ${String(latestError?.code || "") || "UNKNOWN"}`);
            if (!shouldAutoRetrySegmentsError(latestError)) throw latestError;
        }
    }
}

function consumeDebugForceFirstSegmentsTruncation(taskContext = {}) {
    if (!taskContext || taskContext.debugForceFirstSegmentsTruncation !== true) return false;
    taskContext.debugForceFirstSegmentsTruncation = false;
    return true;
}

function consumeDebugForceFirstSummaryEmpty(taskContext = {}) {
    if (!taskContext || taskContext.debugForceFirstSummaryEmpty !== true) return false;
    taskContext.debugForceFirstSummaryEmpty = false;
    return true;
}

async function recordSummaryRetryDebugState(tabId, patch = {}, eventText = "", options = {}) {
    if (!tabId) return;
    const current = await getTabState(tabId);
    const taskRetryState = { ...(current?.taskRetryState || {}) };
    const previous = taskRetryState.summary && typeof taskRetryState.summary === "object"
        ? taskRetryState.summary
        : {};
    const events = options.resetEvents ? [] : (Array.isArray(previous.events) ? previous.events.slice(-5) : []);
    if (eventText) events.push({ at: Date.now(), text: String(eventText || "") });
    taskRetryState.summary = {
        ...previous,
        ...patch,
        events,
        updatedAt: Date.now()
    };
    await updateTabState(tabId, { taskRetryState, updatedAt: Date.now() });
}

function resolveStatusByError(error) {
    return isTimeoutError(error) ? "timeout" : "error";
}

function resolveUsageStatusByError(error) {
    if (error?.code === "ABORTED" || error?.code === "USER_CANCELLED") return "cancelled";
    if (isTimeoutError(error)) return "timeout";
    return "failed";
}

function resolveUsageErrorCode(error, fallback = "UNKNOWN") {
    const originalCode = String(error?.code || fallback || "UNKNOWN").trim() || "UNKNOWN";
    const normalizedCode = originalCode.toUpperCase();
    if (normalizedCode.startsWith("HTTP_429_")) return originalCode;
    if (normalizedCode !== "HTTP_429" && Number(error?.status || 0) !== 429) return originalCode;
    const reason = classifyProvider429Error(error);
    return ({
        credit_balance_exhausted: "HTTP_429_CREDIT_EXHAUSTED",
        model_quota_exhausted: "HTTP_429_MODEL_QUOTA_EXHAUSTED",
        quota_exhausted: "HTTP_429_INSUFFICIENT_QUOTA",
        queue_overloaded: "HTTP_429_QUEUE_EXCEEDED",
        rate_limited: "HTTP_429_RATE_LIMIT",
        unknown_429: "HTTP_429_UNKNOWN"
    })[reason] || originalCode;
}

function isNonSoftwareTaskBlocker(error) {
    const code = resolveUsageErrorCode(error, "UNKNOWN").toUpperCase();
    const status = Number(error?.status || 0);
    return [
        "MISSING_API_KEY",
        "HTTP_401",
        "HTTP_402",
        "HTTP_403",
        "HTTP_429",
        "ASR_FORBIDDEN",
        "ASR_GROQ_ACCESS_BLOCKED",
        "ASR_GROQ_UNREACHABLE",
        "ASR_RATE_LIMIT",
        "CUSTOM_PROVIDER_AUTH_REQUIRED",
        "CUSTOM_PROVIDER_BASE_URL_REQUIRED"
    ].includes(code) || code.startsWith("HTTP_429_") || [401, 402, 403, 429].includes(status);
}

function resolveTaskOutcomeCategory(error, status = "") {
    const normalizedStatus = String(status || resolveUsageStatusByError(error)).toLowerCase();
    const code = resolveUsageErrorCode(error, "UNKNOWN").toUpperCase();
    const message = String(error?.message || "");
    if (normalizedStatus === "cancelled" || ["ABORTED", "USER_CANCELLED"].includes(code)) return "cancelled";
    if (normalizedStatus === "blocked" || isNonSoftwareTaskBlocker(error)) return "usage_blocked";
    if ([
        "MISSING_API_KEY",
        "CONFIG_REQUIRED",
        "VALIDATION_ERROR",
        "HTTP_401",
        "CUSTOM_PROVIDER_AUTH_REQUIRED",
        "CUSTOM_PROVIDER_BASE_URL_REQUIRED"
    ].includes(code) || /API Key|Token.*(?:无效|失效)|Base URL|未授权访问该自定义/i.test(message)) {
        return "user_config_failed";
    }
    if (/^(?:HTTP_|AI_|ASR_|PROVIDER_|NETWORK_|MODEL_|SUMMARY_EMPTY|SEGMENTS_(?:EMPTY|PARSE|NORMALIZE)|JSON_)|TIMEOUT/.test(code)) {
        return "provider_service_failed";
    }
    return "plugin_logic_failed";
}

async function setTaskStatusMap(tabId, statusMap, lastError = "", errorMap = {}, partContext = {}) {
    return runWithTaskStateLock(tabId, async () => {
        const current = await getTabState(tabId);
        const identity = resolvePartContext(current?.activeBvid || "", partContext);
        const partState = getTaskStateForPart(current, identity);
        const taskStatus = { ...partState.taskStatus };
        const taskErrors = { ...partState.taskErrors };
        for (const task of Object.keys(statusMap || {})) {
            const status = statusMap[task];
            if (!status) continue;
            taskStatus[task] = status;
            if (status === "error" || status === "timeout") {
                const taskError = errorMap?.[task];
                taskErrors[task] = taskError ? serializeAppError(taskError) : {
                    message: String(lastError || "任务失败"),
                    code: "",
                    status: undefined,
                    retryAfterSec: undefined
                };
            } else {
                delete taskErrors[task];
            }
        }
        await writeTaskStateForPart(tabId, current, identity, { taskStatus, taskErrors, taskRetryState: partState.taskRetryState, lastError });
    });
}

async function applySummarySegmentsResults(tabId, bvid, results, options = {}) {
    const summaryResult = results?.summary;
    const segmentsResult = results?.segments;
    const keepProcessingTasks = new Set(Array.isArray(options.keepProcessingTasks) ? options.keepProcessingTasks : []);
    const statusMap = {};
    const errorMap = {};
    const cachePatch = {};
    const tabState = tabId ? await getTabState(tabId).catch(() => null) : null;
    const identity = resolvePartContext(bvid, {
        cid: Number(options?.taskContext?.cid || tabState?.activeCid || 0),
        tid: String(options?.taskContext?.tid || tabState?.activeTid || "").trim(),
        partCount: Number(options?.taskContext?.partCount || tabState?.activePartCount || 0)
    });
    if (!identity.partKey) throw createAppError("PART_IDENTITY_PENDING", "当前分 P 身份未就绪");
    cachePatch.cid = identity.cid;
    cachePatch.tid = identity.tid;
    cachePatch.partCount = identity.partCount;
    let lastError = "";

    if (summaryResult) {
        if (summaryResult.ok) {
            cachePatch.summary = String(summaryResult.data || "");
            cachePatch.summaryDraft = null;
            cachePatch.summaryCacheSource = "local";
            statusMap.summary = "done";
        } else if (keepProcessingTasks.has("summary")) {
            statusMap.summary = "processing";
        } else if (summaryResult.error) {
            cachePatch.summaryDraft = null;
            statusMap.summary = resolveStatusByError(summaryResult.error);
            errorMap.summary = summaryResult.error;
            lastError = lastError || summaryResult.error.message || "任务失败";
        }
    }

    if (segmentsResult) {
        if (segmentsResult.ok) {
            cachePatch.segments = Array.isArray(segmentsResult.data) ? segmentsResult.data : [];
            cachePatch.segmentsCacheSource = "local";
            statusMap.segments = "done";
        } else if (keepProcessingTasks.has("segments")) {
            statusMap.segments = "processing";
        } else if (segmentsResult.error) {
            statusMap.segments = resolveStatusByError(segmentsResult.error);
            errorMap.segments = segmentsResult.error;
            lastError = lastError || segmentsResult.error.message || "任务失败";
        }
    }

    if (Object.keys(cachePatch).length) {
        await mergeCacheByBvid(bvid, { ...cachePatch, updatedAt: Date.now() });
        await promotePendingSinglePartCacheForTab(bvid, tabId);
    }
    if (Object.keys(statusMap).length) {
        await setTaskStatusMap(tabId, statusMap, lastError, errorMap, identity);
    }
}

async function runSummarySegmentsInQuality(tabId, bvid, force, settings, taskContext = {}) {
    const rawCache = await getCache(bvid);
    const cache = getPartCacheForContext(rawCache, bvid, taskContext);
    if (!cache) throw createMissingSubtitleError();
    const summarySubtitleOptions = { purpose: "general" };
    const segmentsSubtitleOptions = { purpose: "segments", mode: "quality" };
    const summarySubtitleText = getSubtitlePayload(cache, summarySubtitleOptions);
    const segmentsSubtitleText = getSubtitlePayload(cache, segmentsSubtitleOptions);
    if (!summarySubtitleText && !segmentsSubtitleText) throw createMissingSubtitleError();
    const promptTaskContext = { ...taskContext, noSubtitleTimestamps: isNoTimestampSubtitleCache(cache) };
    logSubtitlePayloadSelection(bvid, "summary", cache, summarySubtitleText, summarySubtitleOptions);
    logSubtitlePayloadSelection(bvid, "segments", cache, segmentsSubtitleText, segmentsSubtitleOptions);
    const mode = settings.promptSettings?.mode || "guided";
    const guided = settings.promptSettings?.guided || {};
    const customPrompts = settings.promptSettings?.custom || {};
    const results = createSummarySegmentsResult();
    async function writeStreamingSummaryPartial(text, state, forceWrite = false) {
        const value = sanitizeSummaryOutput(text);
        if (!value) return;
        const now = Date.now();
        if (!forceWrite && now - Number(state.lastWriteAt || 0) < 350) return;
        state.lastWriteAt = now;
        await mergeCacheByBvid(bvid, {
            cid: Number(taskContext.cid || 0),
            tid: String(taskContext.tid || ""),
            partCount: Number(taskContext.partCount || 0),
            summaryDraft: {
                taskId: String(taskContext?.usageTaskId || taskContext?.sentryTaskId || ""),
                attempt: 1,
                text: value,
                updatedAt: now
            },
            updatedAt: now
        });
    }
    const summaryExists = !force && String(cache?.summary || "").trim();
    const segmentsExists = !force && Array.isArray(cache?.segments) && cache.segments.length > 0;
    if (summaryExists || segmentsExists) {
        if (summaryExists) {
            results.summary = { ok: true, data: String(cache.summary || ""), error: null };
        }
        if (segmentsExists) {
            results.segments = { ok: true, data: cache.segments, error: null };
        }
        const keepProcessingTasks = [];
        if (!summaryExists) keepProcessingTasks.push("summary");
        if (!segmentsExists) keepProcessingTasks.push("segments");
        await applySummarySegmentsResults(
            tabId,
            bvid,
            {
                summary: summaryExists ? results.summary : null,
                segments: segmentsExists ? results.segments : null
            },
            { keepProcessingTasks, taskContext }
        );
    }

    const tasks = [];
    if (summaryExists) {
        results.summary = { ok: true, data: String(cache.summary || ""), error: null };
    } else {
        const summaryPrompt = buildPrompt({ type: "summary", subtitle: summarySubtitleText, mode, guided, customPrompts, taskContext: promptTaskContext });
        logAIPromptBuilt({ bvid, task: "summary", provider: settings.provider, mode: "quality", prompt: summaryPrompt, promptSettings: settings.promptSettings });
        tasks.push((async () => {
            try {
                logAI.info("ai_request_start", {
                    bvid,
                    task: "summary",
                    provider: settings.provider,
                    model: settings.model || "",
                    detail: {
                        mode: "quality",
                        subtitle_chars: summarySubtitleText.length,
                        prompt_chars: summaryPrompt.length,
                        prompt_mode: mode,
                        pref_mode: settings.prefMode || ""
                    }
                });
                let streamedSummaryText = "";
                let partialWritePromise = Promise.resolve();
                const partialState = { lastWriteAt: 0 };
                let aiRes = await callAIWithTimeoutStream(settings, [{ role: "user", content: summaryPrompt }], TASK_TIMEOUT_MS, (delta) => {
                    const chunk = String(delta || "");
                    if (!chunk) return;
                    streamedSummaryText += chunk;
                    partialWritePromise = partialWritePromise
                        .catch(() => {})
                        .then(() => writeStreamingSummaryPartial(streamedSummaryText, partialState, false));
                }, null, { tabId, taskContext, component: "summary", bvid });
                await partialWritePromise.catch(() => {});
                let summaryText = sanitizeSummaryOutput(aiRes.text || streamedSummaryText);
                if (!summaryText || shouldDisableDeepSeekV4ThinkingForRetry(settings, aiRes)) {
                    const retried = await retryEmptySummaryOnce({
                        settings,
                        prompt: summaryPrompt,
                        tabId,
                        bvid,
                        mode: "quality",
                        requestStream: true,
                        taskContext,
                        initialAIResponse: aiRes,
                        initialDurationMs: aiRes.metrics?.latencyMs || 0
                    });
                    aiRes = retried.aiRes;
                    summaryText = retried.summaryText;
                }
                await writeStreamingSummaryPartial(summaryText, partialState, true);
                results.summary = { ok: true, data: summaryText, error: null };
                await applySummarySegmentsResults(tabId, bvid, { summary: results.summary }, { taskContext });
                logSummaryQualitySummary(bvid, summaryText, {
                    subtitleChars: summarySubtitleText.length,
                    promptChars: summaryPrompt.length,
                    promptMode: mode,
                    fromCache: false
                });
                await appendMetrics(bvid, null, "summary", aiRes.metrics, taskContext);
                await reportFeatureUsage("summary", bvid, settings, aiRes.metrics);
                logAI.info("ai_request_success", {
                    bvid,
                    task: "summary",
                    provider: settings.provider,
                    model: settings.model || "",
                    duration_ms: aiRes.metrics?.latencyMs || 0,
                    detail: {
                        mode: "quality",
                        tokens: aiRes.metrics?.tokens || 0,
                        input_tokens: aiRes.metrics?.inputTokens || 0,
                        output_tokens: aiRes.metrics?.outputTokens || 0,
                        subtitle_chars: summarySubtitleText.length,
                        prompt_chars: summaryPrompt.length,
                        output_chars: summaryText.length
                    }
                });
            } catch (error) {
                results.summary = { ok: false, data: null, error };
                await applySummarySegmentsResults(tabId, bvid, { summary: results.summary }, { taskContext });
                logAI.error("ai_request_failed", buildFailureLog(error, {
                    task: "summary",
                    bvid,
                    provider: settings.provider,
                    model: settings.model || "",
                    detail: {
                        mode: "quality",
                        subtitle_chars: summarySubtitleText.length,
                        prompt_chars: summaryPrompt.length,
                        prompt_mode: mode
                    }
                }));
            }
        })());
    }

    if (segmentsExists) {
        results.segments = { ok: true, data: cache.segments, error: null };
    } else {
        const segmentPromptPlan = buildPrimarySegmentsPrompt({
            settings,
            cache,
            subtitleText: segmentsSubtitleText || summarySubtitleText,
            mode,
            guided,
            customPrompts,
            taskContext,
            promptTaskContext
        });
        const segmentsPrompt = segmentPromptPlan.prompt;
        const effectiveSegmentsSubtitleText = segmentPromptPlan.subtitleText || segmentsSubtitleText || summarySubtitleText;
        logAIPromptBuilt({ bvid, task: "segments", provider: settings.provider, mode: "quality", prompt: segmentsPrompt, promptSettings: settings.promptSettings });
        tasks.push((async () => {
            let initialAttemptDurationMs = 0;
            try {
                logAI.info("ai_request_start", {
                    bvid,
                    task: "segments",
                    provider: settings.provider,
                    model: settings.model || "",
                    detail: {
                        mode: "quality",
                        subtitle_chars: effectiveSegmentsSubtitleText.length,
                        prompt_chars: segmentsPrompt.length,
                        prompt_mode: mode,
                        pref_mode: settings.prefMode || "",
                        compact_segments: !!segmentPromptPlan.compact
                    }
                });
                await recordSegmentsDebugState(tabId, {
                    status: "running",
                    stage: "primary_request",
                    strategy: segmentPromptPlan.compact ? "compact" : "primary",
                    attempt: 0,
                    total: 2,
                    code: "",
                    mode: "quality",
                    message: segmentPromptPlan.compact ? "保守 Prompt 主请求生成中" : "原 Prompt 主请求生成中"
                }, "开始 quality 分段主请求", { resetEvents: true });
                const aiRes = await callAIWithTimeout(settings, [{ role: "user", content: segmentsPrompt }], TASK_TIMEOUT_MS, { bypassQueue: true, tabId, taskContext, component: "segments", bvid });
                initialAttemptDurationMs = aiRes.metrics?.latencyMs || 0;
                await recordSegmentsDebugState(tabId, {
                    status: "running",
                    stage: "parsing",
                    mode: "quality",
                    message: "主响应已返回，正在解析分段"
                }, "quality 主响应已返回，开始解析分段");
                const parsed = isLikelyTruncatedSegmentOutput(aiRes.text, aiRes.metrics, aiRes.responseMeta)
                    ? null
                    : parseSegmentsJSON(aiRes.text, settings);
                if (!parsed) {
                    throw attachSentryContext(
                        createSegmentsParseError(aiRes.text, aiRes.metrics, aiRes.responseMeta),
                        buildAIResponseSentryContext({
                            task: "segments",
                            bvid,
                            provider: settings.provider,
                            model: settings.model || "",
                            mode: "quality",
                            source: segmentPromptPlan.compact ? "segments_quality_compact_primary_parse" : "segments_quality_parse",
                            responseText: aiRes.text,
                            responseMeta: aiRes.responseMeta,
                            metrics: aiRes.metrics,
                            extra: {
                                compact_segments: !!segmentPromptPlan.compact
                            }
                        })
                    );
                }
                const normalized = normalizeSegments(parsed, cache, { bvid, task: "segments", mode: "quality", allowLineOnly: !!segmentPromptPlan.compact });
                if (!normalized.length) {
                    throw attachSentryContext(
                        createSegmentsNormalizeError(parsed),
                        buildAIResponseSentryContext({
                            task: "segments",
                            bvid,
                            provider: settings.provider,
                            model: settings.model || "",
                            mode: "quality",
                            source: segmentPromptPlan.compact ? "segments_quality_compact_primary_normalize" : "segments_quality_normalize",
                            responseText: aiRes.text,
                            responseMeta: aiRes.responseMeta,
                            metrics: aiRes.metrics,
                            extra: {
                                compact_segments: !!segmentPromptPlan.compact,
                                parsed_item_count: getSegmentCandidateList(parsed)?.length || 0
                            }
                        })
                    );
                }
                await recordSegmentsDebugState(tabId, {
                    status: "done",
                    stage: "complete",
                    mode: "quality",
                    segmentCount: normalized.length,
                    message: "分段生成完成"
                }, `quality 分段成功，共 ${normalized.length} 段`);
                logSegmentQualitySummary(bvid, normalized, cache, {
                    task: "segments",
                    mode: segmentPromptPlan.compact ? "quality_compact_primary" : "quality",
                    subtitlePayload: segmentPromptPlan.compact
                        ? {
                            source: "raw_indexed_compact_primary",
                            purpose: "segments",
                            mode: "quality",
                            payload_chars: effectiveSegmentsSubtitleText.length,
                            max_chars: MAX_SEGMENTS_SUBTITLE_CHARS,
                            no_timestamp: isNoTimestampSubtitleCache(cache),
                            raw_count: Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle.length : 0,
                            processed_count: Array.isArray(cache?.processedSubtitle) ? cache.processedSubtitle.length : 0
                        }
                        : getSubtitlePayloadMeta(cache, segmentsSubtitleText || summarySubtitleText, segmentsSubtitleOptions)
                });
                results.segments = { ok: true, data: normalized, error: null };
                await applySummarySegmentsResults(tabId, bvid, { segments: results.segments }, { taskContext });
                await appendMetrics(bvid, null, "segments", aiRes.metrics, taskContext);
                await reportFeatureUsage("segments", bvid, settings, aiRes.metrics);
                logAI.info("ai_request_success", {
                    bvid,
                    task: "segments",
                    provider: settings.provider,
                    model: settings.model || "",
                    duration_ms: aiRes.metrics?.latencyMs || 0,
                    detail: {
                        mode: "quality",
                        tokens: aiRes.metrics?.tokens || 0,
                        input_tokens: aiRes.metrics?.inputTokens || 0,
                        output_tokens: aiRes.metrics?.outputTokens || 0,
                        subtitle_chars: effectiveSegmentsSubtitleText.length,
                        prompt_chars: segmentsPrompt.length,
                        output_chars: String(aiRes.text || "").length,
                        compact_segments: !!segmentPromptPlan.compact
                    }
                });
            } catch (error) {
                let segmentError = normalizeSegmentsTaskError(error);
                if (shouldAutoRetrySegmentsError(segmentError)) {
                    try {
                        const normalized = await retrySegmentsWithAutoFallbacks({
                            tabId,
                            bvid,
                            cache,
                            settings,
                            taskContext,
                            subtitleText: effectiveSegmentsSubtitleText,
                            promptMode: mode,
                            guided,
                            customPrompts,
                            mode: "quality",
                            originalError: segmentError,
                            initialDurationMs: initialAttemptDurationMs
                        });
                        results.segments = { ok: true, data: normalized, error: null };
                        await applySummarySegmentsResults(tabId, bvid, { segments: results.segments }, { taskContext });
                        return;
                    } catch (retryError) {
                        segmentError = normalizeSegmentsTaskError(retryError);
                        logAI.warn("segments_compact_retry_failed", buildFailureLog(segmentError, {
                            task: "segments",
                            bvid,
                            provider: settings.provider,
                            model: settings.model || "",
                            detail: {
                                mode: "quality"
                            }
                        }));
                    }
                }
                results.segments = { ok: false, data: null, error: segmentError };
                await applySummarySegmentsResults(tabId, bvid, { segments: results.segments }, { taskContext });
                logAI.error("ai_request_failed", buildFailureLog(segmentError, {
                    task: "segments",
                    bvid,
                    provider: settings.provider,
                    model: settings.model || "",
                    detail: {
                        mode: "quality",
                        subtitle_chars: (segmentsSubtitleText || summarySubtitleText).length,
                        prompt_chars: segmentsPrompt.length,
                        prompt_mode: mode
                    }
                }));
            }
        })());
    }

    if (tasks.length) {
        await Promise.allSettled(tasks);
        if (results.summary?.error) {
            await reportDailyFeatureUsage("summary", settings, { tokens: 0 }, resolveUsageStatusByError(results.summary.error), resolveUsageErrorCode(results.summary.error, "SUMMARY_FAILED"), {
                bvid,
                title: cache?.title || ""
            });
        }
        if (results.segments?.error) {
            await reportDailyFeatureUsage("segments", settings, { tokens: 0 }, resolveUsageStatusByError(results.segments.error), resolveUsageErrorCode(results.segments.error, "SEGMENTS_FAILED"), {
                bvid,
                title: cache?.title || ""
            });
        }
    } else {
        await applySummarySegmentsResults(tabId, bvid, results, { taskContext });
    }
    return results;
}

async function runSummarySegmentsInEfficiency(tabId, bvid, force, settings, taskContext = {}) {
    const rawCache = await getCache(bvid);
    const cache = getPartCacheForContext(rawCache, bvid, taskContext);
    if (!cache) throw createMissingSubtitleError();
    const subtitlePayloadOptions = { purpose: "segments", mode: "efficiency" };
    const subtitleText = getSubtitlePayload(cache, subtitlePayloadOptions);
    if (!subtitleText) throw createMissingSubtitleError();
    const promptTaskContext = { ...taskContext, noSubtitleTimestamps: isNoTimestampSubtitleCache(cache) };
    logSubtitlePayloadSelection(bvid, "summary_segments_merged", cache, subtitleText, subtitlePayloadOptions);
    if (!force && String(cache?.summary || "").trim() && Array.isArray(cache?.segments) && cache.segments.length) {
        const cached = {
            summary: { ok: true, data: String(cache.summary || ""), error: null },
            segments: { ok: true, data: cache.segments, error: null }
        };
        await applySummarySegmentsResults(tabId, bvid, cached, { taskContext });
        return cached;
    }

    const mode = settings.promptSettings?.mode || "guided";
    const guided = settings.promptSettings?.guided || {};
    const customPrompts = settings.promptSettings?.custom || {};
    const prompt = buildMergedSummarySegmentsPrompt({
        subtitle: subtitleText,
        mode,
        guided,
        customPrompts,
        taskContext: promptTaskContext,
        segmentsPromptOverride: ""
    });
    logAIPromptBuilt({
        bvid,
        task: "summary_segments_merged",
        provider: settings.provider,
        mode: "efficiency",
        prompt,
        promptSettings: settings.promptSettings
    });
    await recordSegmentsDebugState(tabId, {
        status: "running",
        stage: "merged_request",
        strategy: "merged",
        attempt: 0,
        total: 2,
        code: "",
        mode: "efficiency",
        message: "省流模式联合请求生成中"
    }, "开始 efficiency 联合请求", { resetEvents: true });

    const results = createSummarySegmentsResult();
    let streamBuffer = "";
    let summaryApplied = false;
    let summaryApplyPromise = Promise.resolve();
    const requestStartedAt = Date.now();
    let firstChunkMs = 0;
    try {
        logAI.info("ai_request_start", {
            bvid,
            task: "summary_segments_merged",
            provider: settings.provider,
            model: settings.model || "",
            detail: {
                mode: "efficiency",
                subtitle_chars: subtitleText.length,
                prompt_chars: prompt.length,
                prompt_mode: mode,
                pref_mode: settings.prefMode || ""
            }
        });
        const aiRes = await callAIWithTimeoutStream(settings, [{ role: "user", content: prompt }], EFFICIENCY_TASK_TIMEOUT_MS, (delta) => {
            if (!firstChunkMs) {
                firstChunkMs = Date.now() - requestStartedAt;
                logAI.info("ai_first_chunk", {
                    bvid,
                    task: "summary_segments_merged",
                    provider: settings.provider,
                    model: settings.model || "",
                    duration_ms: firstChunkMs,
                    detail: {
                        mode: "efficiency"
                    }
                });
            }
            streamBuffer += String(delta || "");
            if (summaryApplied) return;
            const section = extractProtocolSection(streamBuffer, "<<<SUMMARY_START>>>", "<<<SUMMARY_END>>>");
            if (!section.found) return;
            const summaryText = sanitizeSummaryOutput(section.content);
            if (!summaryText) return;
            summaryApplied = true;
            results.summary = { ok: true, data: summaryText, error: null };
            summaryApplyPromise = applySummarySegmentsResults(tabId, bvid, { summary: results.summary }, { keepProcessingTasks: ["segments"], taskContext });
        }, null, { tabId, taskContext, component: "summary_segments_merged", bvid });
        await summaryApplyPromise;
        const fullText = String(streamBuffer || aiRes.text || "");
        logAI.debug("ai_stream_buffer_summary", {
            bvid,
            task: "summary_segments_merged",
            detail: {
                stream_buffer_chars: streamBuffer.length,
                response_text_chars: String(aiRes?.text || "").length,
                full_text_chars: fullText.length
            }
        });
        const summarySection = extractProtocolSection(fullText, "<<<SUMMARY_START>>>", "<<<SUMMARY_END>>>");
        if (!results.summary.ok && summarySection.found) {
            const summaryText = sanitizeSummaryOutput(summarySection.content);
            if (summaryText) {
                results.summary = { ok: true, data: summaryText, error: null };
                await applySummarySegmentsResults(tabId, bvid, { summary: results.summary }, { keepProcessingTasks: ["segments"], taskContext });
            }
        }
        const segmentsSection = extractFirstProtocolSection(fullText, [
            ["<<<SEGMENTS_START>>>", "<<<SEGMENTS_END>>>"],
            ["SEGMENTS_START", "SEGMENTS_END"],
            ["【SEGMENTS_START】", "【SEGMENTS_END】"]
        ]);
        let segmentsResolved = false;
        let segmentsFailureError = null;
        if (segmentsSection && segmentsSection.found) {
            await recordSegmentsDebugState(tabId, {
                status: "running",
                stage: "parsing",
                mode: "efficiency",
                message: "联合响应已返回，正在解析分段"
            }, "efficiency 联合响应已返回，开始解析分段");
            const parsed = isLikelyTruncatedSegmentOutput(segmentsSection.content, aiRes.metrics, aiRes.responseMeta)
                ? null
                : parseSegmentsJSON(segmentsSection.content, settings);
            if (!parsed) {
                segmentsFailureError = attachSentryContext(
                    createSegmentsParseError(segmentsSection.content, aiRes.metrics, aiRes.responseMeta),
                    buildAIResponseSentryContext({
                        task: "segments",
                        bvid,
                        provider: settings.provider,
                        model: settings.model || "",
                        mode: "efficiency",
                        source: "segments_merged_protocol_section_parse",
                        responseText: segmentsSection.content,
                        responseMeta: aiRes.responseMeta,
                        metrics: aiRes.metrics
                    })
                );
                logAI.error("segments_merged_section_parse_error", {
                    bvid,
                    task: "segments",
                    code: segmentsFailureError?.code || "JSON_PARSE_ERROR",
                    detail: {
                        mode: "efficiency",
                        source: "protocol_section",
                        ...getSegmentsResponseDiagnostics(segmentsSection.content, aiRes.metrics)
                    }
                });
            } else {
                const normalized = normalizeSegments(parsed, cache, { bvid, task: "segments", mode: "efficiency" });
                if (normalized.length) {
                    results.segments = { ok: true, data: normalized, error: null };
                    segmentsResolved = true;
                    segmentsFailureError = null;
                    logSegmentQualitySummary(bvid, normalized, cache, {
                        task: "segments",
                        mode: "efficiency",
                        subtitlePayload: getSubtitlePayloadMeta(cache, subtitleText, subtitlePayloadOptions)
                    });
                } else {
                    segmentsFailureError = attachSentryContext(
                        createSegmentsNormalizeError(parsed),
                        buildAIResponseSentryContext({
                            task: "segments",
                            bvid,
                            provider: settings.provider,
                            model: settings.model || "",
                            mode: "efficiency",
                            source: "segments_merged_protocol_section_normalize",
                            responseText: segmentsSection.content,
                            responseMeta: aiRes.responseMeta,
                            metrics: aiRes.metrics,
                            extra: { parsed_item_count: getSegmentCandidateList(parsed)?.length || 0 }
                        })
                    );
                }
            }
        }
        if (!segmentsResolved && !segmentsFailureError) {
            segmentsFailureError = attachSentryContext(
                createSegmentsMissingProtocolError(fullText, aiRes.metrics, aiRes.responseMeta),
                buildAIResponseSentryContext({
                    task: "segments",
                    bvid,
                    provider: settings.provider,
                    model: settings.model || "",
                    mode: "efficiency",
                    source: "segments_merged_protocol_missing",
                    responseText: fullText,
                    responseMeta: aiRes.responseMeta,
                    metrics: aiRes.metrics
                })
            );
            logAI.error("segments_merged_protocol_missing", {
                bvid,
                task: "segments",
                code: segmentsFailureError?.code || "SEGMENTS_MISSING_PROTOCOL",
                detail: {
                    mode: "efficiency",
                    source: "merged_output",
                    ...getSegmentsResponseDiagnostics(fullText, aiRes.metrics)
                }
            });
        }
        if (!segmentsResolved
            && !hasAttemptedSegmentsAIRepair(taskContext)
            && !isStrictModelScopeProvider(settings)
            && canRepairSegmentsResponseWithAI(segmentsFailureError)
            && isRemoteFeatureEnabled(settings?.remoteConfig, "segments_ai_json_repair", true)) {
            await reportTaskInitialFailure({
                settings,
                taskContext,
                component: "segments",
                bvid,
                error: segmentsFailureError,
                durationMs: aiRes.metrics?.latencyMs || 0
            });
            markSegmentsAIRepairAttempted(taskContext);
            const repairStartedAt = Date.now();
            const repairTriggerError = segmentsFailureError;
            await recordSegmentsDebugState(tabId, {
                status: "retrying",
                stage: "ai_json_repair",
                strategy: "ai_json_repair",
                code: String(segmentsFailureError?.code || ""),
                mode: "efficiency",
                message: "正在用 AI 修复分段 JSON/字段结构"
            }, "开始专用 AI JSON/结构修复");
            try {
                const repaired = await retrySegmentsWithAIRepair({
                    tabId,
                    bvid,
                    cache,
                    settings,
                    mode: "efficiency",
                    originalError: segmentsFailureError
                });
                results.segments = { ok: true, data: repaired.segments, error: null };
                segmentsResolved = true;
                segmentsFailureError = null;
                await applySummarySegmentsResults(tabId, bvid, { segments: results.segments }, { taskContext });
                await appendMetrics(bvid, null, "segments", repaired.metrics, taskContext);
                await reportFeatureUsage("segments", bvid, settings, repaired.metrics);
                await reportTaskRecoveryFinished({
                    settings,
                    taskContext,
                    component: "segments",
                    bvid,
                    strategy: "ai_json_repair",
                    triggerError: repairTriggerError,
                    success: true,
                    durationMs: Date.now() - repairStartedAt,
                    metrics: repaired.metrics
                });
                await recordSegmentsDebugState(tabId, {
                    status: "recovered",
                    stage: "recovered",
                    strategy: "ai_json_repair",
                    message: "AI JSON/结构修复成功"
                }, "专用 AI JSON/结构修复成功");
            } catch (repairError) {
                segmentsFailureError = mergeSegmentsResponseAttempts(
                    normalizeSegmentsTaskError(repairError),
                    segmentsFailureError
                );
                await reportTaskRecoveryFinished({
                    settings,
                    taskContext,
                    component: "segments",
                    bvid,
                    strategy: "ai_json_repair",
                    triggerError: repairTriggerError,
                    resultError: segmentsFailureError,
                    success: false,
                    durationMs: Date.now() - repairStartedAt
                });
                await recordSegmentsDebugState(tabId, {
                    status: "retry_failed",
                    stage: "retry_failed",
                    strategy: "ai_json_repair",
                    code: String(segmentsFailureError?.code || ""),
                    message: segmentsFailureError?.message || "AI JSON/结构修复失败"
                }, "专用 AI JSON/结构修复失败，继续尝试整份分段重试");
            }
        }
        if (!segmentsResolved
            && String(segmentsFailureError?.code || "") !== "SEGMENTS_OUTPUT_TRUNCATED"
            && !isStrictModelScopeProvider(settings)
            && isRemoteFeatureEnabled(settings?.remoteConfig, "segments_primary_retry", true)) {
            await reportTaskInitialFailure({
                settings,
                taskContext,
                component: "segments",
                bvid,
                error: segmentsFailureError,
                durationMs: aiRes.metrics?.latencyMs || 0
            });
            const fallbackStartedAt = Date.now();
            const fallbackTriggerError = segmentsFailureError;
            let fallbackRecoverySuccess = false;
            let fallbackRecoveryError = null;
            let fallbackRecoveryMetrics = {};
            try {
                const fallbackPrompt = buildPrompt({ type: "segments", subtitle: subtitleText, mode, guided, customPrompts, taskContext: promptTaskContext });
                logAI.warn("segments_merged_parse_fallback_start", {
                    bvid,
                    task: "segments",
                    provider: settings.provider,
                    model: settings.model || "",
                    detail: {
                        mode: "efficiency",
                        prompt_chars: fallbackPrompt.length,
                        merged_output_chars: fullText.length
                    }
                });
                const fallbackRes = await callAIWithTimeout(settings, [{ role: "user", content: fallbackPrompt }], TASK_TIMEOUT_MS, { bypassQueue: true, tabId, taskContext, component: "segments", bvid });
                fallbackRecoveryMetrics = fallbackRes.metrics || {};
                const parsed = isLikelyTruncatedSegmentOutput(fallbackRes.text, fallbackRes.metrics, fallbackRes.responseMeta)
                    ? null
                    : parseSegmentsJSON(fallbackRes.text, settings);
                if (!parsed) {
                    const fallbackParseError = attachSentryContext(
                        createSegmentsParseError(fallbackRes.text, fallbackRes.metrics, fallbackRes.responseMeta),
                        buildAIResponseSentryContext({
                            task: "segments",
                            bvid,
                            provider: settings.provider,
                            model: settings.model || "",
                            mode: "efficiency_fallback",
                            source: "segments_merged_fallback_parse",
                            responseText: fallbackRes.text,
                            responseMeta: fallbackRes.responseMeta,
                            metrics: fallbackRes.metrics
                        })
                    );
                    fallbackRecoveryError = fallbackParseError;
                    segmentsFailureError = mergeSegmentsResponseAttempts(fallbackParseError, segmentsFailureError);
                    logAI.error("segments_merged_fallback_parse_error", {
                        bvid,
                        task: "segments",
                        code: segmentsFailureError?.code || "JSON_PARSE_ERROR",
                        detail: {
                            mode: "efficiency_fallback",
                            source: "fallback_prompt",
                            ...getSegmentsResponseDiagnostics(fallbackRes.text, fallbackRes.metrics)
                        }
                    });
                } else {
                    const normalized = normalizeSegments(parsed, cache, { bvid, task: "segments", mode: "efficiency_fallback" });
                    if (normalized.length) {
                        results.segments = { ok: true, data: normalized, error: null };
                        segmentsResolved = true;
                        segmentsFailureError = null;
                        fallbackRecoverySuccess = true;
                        logSegmentQualitySummary(bvid, normalized, cache, {
                            task: "segments",
                            mode: "efficiency_fallback",
                            subtitlePayload: getSubtitlePayloadMeta(cache, subtitleText, subtitlePayloadOptions)
                        });
                        await applySummarySegmentsResults(tabId, bvid, { segments: results.segments }, { taskContext });
                        await appendMetrics(bvid, null, "segments", fallbackRes.metrics, taskContext);
                        await reportFeatureUsage("segments", bvid, settings, fallbackRes.metrics);
                        logAI.info("segments_merged_parse_fallback_success", {
                            bvid,
                            task: "segments",
                            provider: settings.provider,
                            model: settings.model || "",
                            duration_ms: fallbackRes.metrics?.latencyMs || 0,
                            detail: {
                                mode: "efficiency_fallback",
                                output_chars: String(fallbackRes.text || "").length,
                                segment_count: normalized.length
                            }
                        });
                    } else {
                        const fallbackNormalizeError = attachSentryContext(
                            createSegmentsNormalizeError(parsed),
                            buildAIResponseSentryContext({
                                task: "segments",
                                bvid,
                                provider: settings.provider,
                                model: settings.model || "",
                                mode: "efficiency_fallback",
                                source: "segments_merged_fallback_normalize",
                                responseText: fallbackRes.text,
                                responseMeta: fallbackRes.responseMeta,
                                metrics: fallbackRes.metrics,
                                extra: { parsed_item_count: getSegmentCandidateList(parsed)?.length || 0 }
                            })
                        );
                        fallbackRecoveryError = fallbackNormalizeError;
                        segmentsFailureError = mergeSegmentsResponseAttempts(fallbackNormalizeError, segmentsFailureError);
                    }
                }
            } catch (fallbackError) {
                fallbackRecoveryError = fallbackError;
                segmentsFailureError = mergeSegmentsResponseAttempts(normalizeSegmentsTaskError(fallbackError), segmentsFailureError);
                logAI.warn("segments_merged_parse_fallback_failed", buildFailureLog(fallbackError, {
                    task: "segments",
                    bvid,
                    provider: settings.provider,
                    model: settings.model || "",
                    detail: {
                        mode: "efficiency_fallback"
                    }
                }));
            }
            await reportTaskRecoveryFinished({
                settings,
                taskContext,
                component: "segments",
                bvid,
                strategy: "primary_retry",
                triggerError: fallbackTriggerError,
                resultError: fallbackRecoveryError || segmentsFailureError,
                success: fallbackRecoverySuccess,
                durationMs: Date.now() - fallbackStartedAt,
                metrics: fallbackRecoveryMetrics
            });
        }
        if (!segmentsResolved) {
            if (shouldAutoRetrySegmentsError(segmentsFailureError)) {
                const retriedSegments = await retrySegmentsWithAutoFallbacks({
                    tabId,
                    bvid,
                    cache,
                    settings,
                    taskContext,
                    subtitleText,
                    promptMode: mode,
                    guided,
                    customPrompts,
                    mode: "efficiency",
                    originalError: segmentsFailureError,
                    initialDurationMs: aiRes.metrics?.latencyMs || 0
                });
                results.segments = { ok: true, data: retriedSegments, error: null };
                segmentsResolved = true;
                segmentsFailureError = null;
            }
        }
        if (!segmentsResolved) {
            await recordSegmentsDebugState(tabId, {
                status: "error",
                stage: "final_error",
                mode: "efficiency",
                code: String(segmentsFailureError?.code || ""),
                message: segmentsFailureError?.message || "分段最终失败"
            }, `efficiency 分段最终失败：${String(segmentsFailureError?.code || "") || "UNKNOWN"}`);
            logAI.error("segments_parse_failed", {
                bvid,
                task: "segments",
                code: segmentsFailureError?.code || "SEGMENTS_MISSING_PROTOCOL",
                detail: {
                    mode: "efficiency",
                    full_text_chars: fullText.length,
                    segments_start_index: fullText.indexOf("<<<SEGMENTS_START>>>"),
                    segments_end_index: fullText.indexOf("<<<SEGMENTS_END>>>")
                }
            });
            throw (segmentsFailureError || createAppError("SEGMENTS_MISSING_PROTOCOL", "模型漏掉了分段部分"));
        }
        await recordSegmentsDebugState(tabId, {
            status: "done",
            stage: "complete",
            mode: "efficiency",
            segmentCount: Array.isArray(results?.segments?.data) ? results.segments.data.length : 0,
            message: "分段生成完成"
        }, `efficiency 分段成功，共 ${Array.isArray(results?.segments?.data) ? results.segments.data.length : 0} 段`);
        if (!results.summary.ok) {
            const summaryPrompt = buildPrompt({
                type: "summary",
                subtitle: subtitleText,
                mode,
                guided,
                customPrompts,
                taskContext: promptTaskContext
            });
            try {
                const retried = await retryEmptySummaryOnce({
                    settings,
                    prompt: summaryPrompt,
                    tabId,
                    bvid,
                    mode: "efficiency",
                    requestStream: true,
                    taskContext,
                    initialAIResponse: aiRes,
                    initialDurationMs: aiRes.metrics?.latencyMs || 0
                });
                results.summary = { ok: true, data: retried.summaryText, error: null };
                await applySummarySegmentsResults(tabId, bvid, { summary: results.summary }, { taskContext });
                await appendMetrics(bvid, null, "summary", retried.aiRes.metrics, taskContext);
                await reportFeatureUsage("summary", bvid, settings, retried.aiRes.metrics);
            } catch (summaryError) {
                results.summary = { ok: false, data: null, error: summaryError };
                await applySummarySegmentsResults(tabId, bvid, { summary: results.summary }, { taskContext });
            }
        }
        if (results.summary.ok) {
            logSummaryQualitySummary(bvid, String(results.summary.data || ""), {
                subtitleChars: subtitleText.length,
                promptChars: prompt.length,
                promptMode: mode,
                fromCache: false
            });
        }
        await applySummarySegmentsResults(tabId, bvid, results, { taskContext });
        await appendMetrics(bvid, null, "summary", aiRes.metrics, taskContext);
        await appendMetrics(bvid, null, "segments", aiRes.metrics, taskContext);
        await reportFeatureUsage("summary_segments_merged", bvid, settings, aiRes.metrics);
        logAI.info("ai_request_success", {
            bvid,
            task: "summary_segments_merged",
            provider: settings.provider,
            model: settings.model || "",
            duration_ms: aiRes.metrics?.latencyMs || 0,
            detail: {
                mode: "efficiency",
                first_chunk_ms: firstChunkMs,
                tokens: aiRes.metrics?.tokens || 0,
                input_tokens: aiRes.metrics?.inputTokens || 0,
                output_tokens: aiRes.metrics?.outputTokens || 0,
                subtitle_chars: subtitleText.length,
                prompt_chars: prompt.length,
                output_chars: String(aiRes.text || streamBuffer || "").length
            }
        });
    } catch (error) {
        const finalError = normalizeSegmentsTaskError(error);
        await summaryApplyPromise.catch(() => {});
        if (!results.summary.ok) {
            results.summary = { ok: false, data: null, error: finalError };
        }
        results.segments = { ok: false, data: null, error: finalError };
        await applySummarySegmentsResults(tabId, bvid, results, { taskContext });
        await reportDailyFeatureUsage("summary_segments_merged", settings, {
            durationMs: Date.now() - requestStartedAt,
            tokens: 0
        }, resolveUsageStatusByError(finalError), resolveUsageErrorCode(finalError, "SUMMARY_SEGMENTS_FAILED"), {
            bvid,
            title: cache?.title || ""
        });
        logAI.error("ai_request_failed", buildFailureLog(finalError, {
            task: "summary_segments_merged",
            bvid,
            provider: settings.provider,
            model: settings.model || "",
            duration_ms: Date.now() - requestStartedAt,
            detail: {
                mode: "efficiency",
                first_chunk_ms: firstChunkMs,
                subtitle_chars: subtitleText.length,
                prompt_chars: prompt.length,
                prompt_mode: mode
            }
        }));
    }
    return results;
}

function buildRawSubtitlePayload(cache, maxChars = MAX_SUBTITLE_CHARS) {
    const raw = Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle : [];
    if (!raw.length) return "";
    const noTimestamp = isNoTimestampSubtitleCache(cache);
    const text = raw.map((item) => {
        const content = String(item.content ?? item.text ?? "").trim();
        if (!content) return null;
        if (noTimestamp) return content;
        const sec = Number(item.from ?? item.start ?? 0);
        const min = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `[${String(min).padStart(2, "0")}:${String(s).padStart(2, "0")}] ${content}`;
    }).filter(Boolean).join("\n");
    return text ? text.slice(0, maxChars) : "";
}

function formatSubtitleClock(totalSeconds) {
    const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function buildIndexedRawSubtitlePayload(cache, maxChars = MAX_SUBTITLE_CHARS) {
    const raw = Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle : [];
    if (!raw.length) return "";
    const noTimestamp = isNoTimestampSubtitleCache(cache);
    const lines = [];
    let usedChars = 0;
    for (let index = 0; index < raw.length; index += 1) {
        const item = raw[index] || {};
        const content = String(item.content ?? item.text ?? "").replace(/\s+/g, " ").trim();
        if (!content) continue;
        let line = `#${index} ${content}`;
        if (!noTimestamp) {
            const start = Number(item.from ?? item.start ?? 0);
            const end = Number(item.to ?? item.end ?? NaN);
            const time = Number.isFinite(end) && end > start
                ? `[${formatSubtitleClock(start)}-${formatSubtitleClock(end)}]`
                : `[${formatSubtitleClock(start)}]`;
            line = `#${index} ${time} ${content}`;
        }
        if (usedChars + line.length + 1 > maxChars) break;
        lines.push(line);
        usedChars += line.length + 1;
    }
    return lines.join("\n");
}

function buildProcessedSubtitlePayload(cache, maxChars = MAX_SUBTITLE_CHARS) {
    const processed = Array.isArray(cache?.processedSubtitle) ? cache.processedSubtitle : [];
    if (processed.length) {
        // processedSubtitle 的 text 已含内嵌时间戳，直接拼接
        const text = processed.map((item) => String(item.text || "").trim()).filter(Boolean).join("\n");
        if (text) return text.slice(0, maxChars);
    }
    return "";
}

function normalizeSubtitleLanguageKeyForCache(value = {}) {
    const text = [
        value?.language,
        value?.subtitleLanguage,
        value?.languageLabel,
        value?.subtitleLanguageLabel,
        value?.id,
        value?.label
    ].filter(Boolean).join(" ").toLowerCase();
    if (/中文|汉语|简体|繁體|繁体|chinese|zh-cn|zh-tw|zh-hans|zh_hans|zh-hant|zh_hant|\bzh\b|\bchi\b|\bzho\b/.test(text)) return "zh";
    return text.replace(/[（(].*?[）)]/g, "").replace(/\s+/g, "").trim();
}

function createSubtitleVariantKeyForCache({ bvid, cid, language = "default" } = {}) {
    return [
        normalizeBvid(bvid),
        String(cid || "").trim(),
        String(language || "default").trim()
    ].join("::");
}

function getChineseSubtitleCache(cache = {}) {
    if (!cache || typeof cache !== "object") return cache;
    const bvid = normalizeBvid(cache?.bvid || "");
    const cid = Number(cache?.cid || 0);
    const variants = cache.subtitleVariants && typeof cache.subtitleVariants === "object" ? cache.subtitleVariants : {};
    const zhKey = createSubtitleVariantKeyForCache({ bvid, cid, language: "zh" });
    const direct = variants[zhKey];
    const picked = direct || Object.values(variants).find((entry) => (
        entry &&
        typeof entry === "object" &&
        Number(entry.cid || 0) === cid &&
        normalizeSubtitleLanguageKeyForCache(entry) === "zh" &&
        Array.isArray(entry.rawSubtitle) &&
        entry.rawSubtitle.length
    ));
    if (picked?.rawSubtitle?.length) {
        return {
            ...cache,
            rawSubtitle: cloneData(picked.rawSubtitle),
            processedSubtitle: Array.isArray(picked.processedSubtitle) ? cloneData(picked.processedSubtitle) : [],
            subtitleLanguage: "zh",
            subtitleLanguageLabel: String(picked.languageLabel || picked.subtitleLanguageLabel || "中文"),
            subtitleUrl: String(picked.subtitleUrl || cache.subtitleUrl || "")
        };
    }
    return cache;
}

function buildRawAdEvidencePayload(cache, maxChars = 8000) {
    const raw = Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle : [];
    if (!raw.length) return "";
    const noTimestamp = isNoTimestampSubtitleCache(cache);
    const selected = new Set();
    raw.forEach((item, index) => {
        const text = String(item.content ?? item.text ?? "").trim();
        const matched = AD_DIAGNOSTIC_KEYWORDS.some((keyword) => text.toLowerCase().includes(String(keyword).toLowerCase()));
        if (!matched) return;
        for (let offset = -2; offset <= 2; offset += 1) {
            const nextIndex = index + offset;
            if (nextIndex >= 0 && nextIndex < raw.length) selected.add(nextIndex);
        }
    });
    if (!selected.size) return "";
    const lines = [...selected]
        .sort((a, b) => a - b)
        .slice(0, 140)
        .map((index) => {
            const item = raw[index] || {};
            const content = String(item.content ?? item.text ?? "").trim();
            if (!content) return "";
            if (noTimestamp) return `#${index} ${content}`;
            const start = Number(item.from ?? item.start ?? 0);
            const end = Number(item.to ?? item.end ?? NaN);
            const time = Number.isFinite(end) && end > start
                ? `[${formatSubtitleClock(start)}-${formatSubtitleClock(end)}]`
                : `[${formatSubtitleClock(start)}]`;
            return `#${index} ${time} ${content}`;
        })
        .filter(Boolean);
    return lines.join("\n").slice(0, maxChars);
}

function buildCompactSegmentsSubtitlePayload(cache, maxChars = MAX_SEGMENTS_SUBTITLE_CHARS) {
    const raw = Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle : [];
    if (!raw.length) return "";
    const lines = [];
    let usedChars = 0;
    for (let index = 0; index < raw.length; index += 1) {
        const item = raw[index] || {};
        const content = String(item.content ?? item.text ?? "").trim().replace(/\s+/g, " ").slice(0, 56);
        if (!content) continue;
        const line = `#${index} ${content}`;
        if (usedChars + line.length + 1 > maxChars) {
            const lastIndex = raw.length - 1;
            if (index < lastIndex) {
                const last = raw[lastIndex] || {};
                const lastContent = String(last.content ?? last.text ?? "").trim().replace(/\s+/g, " ").slice(0, 56);
                if (lastContent) lines.push(`#${lastIndex} ${lastContent}`);
            }
            break;
        }
        lines.push(line);
        usedChars += line.length + 1;
    }
    return [
        "【分段与广告逐句字幕（极简）】",
        "说明：每行开头 #数字 是 line_id。请只用这些 line_id 输出 start_line/end_line；不要逐句分段。",
        lines.join("\n")
    ].filter(Boolean).join("\n");
}

function getSegmentsSubtitlePayload(cache, options = {}) {
    const mode = String(options?.mode || "efficiency");
    const indexedRawText = buildIndexedRawSubtitlePayload(cache, MAX_SEGMENTS_SUBTITLE_CHARS);
    if (indexedRawText) {
        if (isNoTimestampSubtitleCache(cache)) {
            return [
                "【分段与广告逐句字幕（无真实时间轴）】",
                "说明：每行开头的 #数字 是 line_id。本字幕没有真实 start/end 秒数，禁止把所有行当作 00:00；普通分段和广告识别都必须基于 line_id。",
                "输出时 start_line/end_line/ad_start_line/ad_end_line 必须来自这些 #编号；start/end 可填写对应行号作为兼容字段，系统会按 line_id 生成无时间轴分段。",
                indexedRawText
            ].join("\n").slice(0, MAX_SEGMENTS_SUBTITLE_CHARS);
        }
        return [
            "【分段与广告逐句字幕】",
            "说明：每行开头的 #数字 是 line_id。普通分段和广告识别都必须基于这些逐句字幕；广告段必须输出 ad_start_line/ad_end_line，值必须来自这些 #编号。",
            indexedRawText
        ].join("\n").slice(0, MAX_SEGMENTS_SUBTITLE_CHARS);
    }
    return buildRawSubtitlePayload(cache, MAX_SEGMENTS_SUBTITLE_CHARS);
}

function getSubtitlePayload(cache, options = {}) {
    const aiCache = getChineseSubtitleCache(cache);
    if (options?.purpose === "segments") return getSegmentsSubtitlePayload(aiCache, options);
    const processedText = buildProcessedSubtitlePayload(aiCache);
    if (processedText) return processedText;
    return buildRawSubtitlePayload(aiCache);
}

function getSubtitlePayloadMeta(cache, text, options = {}) {
    const rawCount = Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle.length : 0;
    const processedCount = Array.isArray(cache?.processedSubtitle) ? cache.processedSubtitle.length : 0;
    const mode = String(options?.mode || "");
    const noTimestamp = isNoTimestampSubtitleCache(cache);
    const adEvidenceText = options?.purpose === "segments" ? buildRawAdEvidencePayload(cache, 8000) : "";
    const maxChars = options?.purpose === "segments" ? MAX_SEGMENTS_SUBTITLE_CHARS : MAX_SUBTITLE_CHARS;
    const payloadLines = String(text || "").split("\n");
    const indexedLines = payloadLines
        .map((line) => String(line || "").match(/^#(\d+)\s+\[([^\]]+)\]/))
        .filter(Boolean);
    const lastIndexedLine = indexedLines.length ? indexedLines[indexedLines.length - 1] : null;
    const source = options?.purpose === "segments"
        ? (rawCount ? "raw_indexed_full_segments_diagnostic" : "none")
        : (processedCount ? "processed" : (rawCount ? "raw_indexed" : "none"));
    return {
        source,
        purpose: String(options?.purpose || "general"),
        mode,
        no_timestamp: noTimestamp,
        raw_count: rawCount,
        processed_count: processedCount,
        ad_evidence_chars: adEvidenceText.length,
        ad_evidence_line_count: adEvidenceText ? adEvidenceText.split("\n").filter(Boolean).length : 0,
        payload_chars: String(text || "").length,
        max_chars: maxChars,
        indexed_line_count: indexedLines.length,
        last_indexed_line_id: lastIndexedLine ? Number(lastIndexedLine[1]) : null,
        last_indexed_time: lastIndexedLine ? String(lastIndexedLine[2] || "") : "",
        truncated: String(text || "").length >= maxChars
    };
}

function logSubtitlePayloadSelection(bvid, task, cache, subtitleText, options = {}) {
    logAI.info("subtitle_payload_selected", {
        bvid,
        task,
        detail: getSubtitlePayloadMeta(cache, subtitleText, options)
    });
}

function normalizeSegments(value, cache = {}, context = {}) {
    const noTimestamp = isNoTimestampSubtitleCache(cache);
    const normalized = normalizeSegmentsResult(value, {
        allowLineOnly: noTimestamp || context?.allowLineOnly === true,
        onFuzzyHit(fuzzyHits, totalCount) {
            logBackground.debug("segments_normalize_fuzzy_hit", {
                hit_count: fuzzyHits.length,
                total_count: totalCount,
                sample: fuzzyHits.slice(0, 5)
            });
        },
        onDrop(dropped, totalCount) {
            logBackground.debug("segments_normalize_drop", {
                dropped_count: dropped.length,
                total_count: totalCount,
                sample: dropped.slice(0, 3)
            });
        }
    });
    return applyLineRangesToSegments(normalized, cache, context);
}

function resolveSubtitleLine(rawRows, lineId) {
    const id = Number(lineId);
    if (!Array.isArray(rawRows) || !rawRows.length || !Number.isInteger(id)) return null;
    if (id >= 0 && id < rawRows.length) return { row: rawRows[id], index: id, adjusted: false };
    const fallback = id - 1;
    if (fallback >= 0 && fallback < rawRows.length) return { row: rawRows[fallback], index: fallback, adjusted: true };
    return null;
}

function getSubtitleEndTime(row, fallbackStart = 0) {
    const end = Number(row?.to ?? row?.end ?? NaN);
    if (Number.isFinite(end) && end > fallbackStart) return end;
    const start = Number(row?.from ?? row?.start ?? fallbackStart);
    if (Number.isFinite(start) && start > fallbackStart) return start;
    return fallbackStart;
}

function applyLineRangesToSegments(segments, cache = {}, context = {}) {
    const list = Array.isArray(segments) ? segments : [];
    const rawRows = Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle : [];
    const noTimestamp = isNoTimestampSubtitleCache(cache);
    if (!list.length) return removeAdOverlapFromContentSegments(list, context);
    if (!rawRows.length) {
        const safeList = noTimestamp ? list : list.filter((seg) => !seg?.no_timestamp && !seg?.virtual_time);
        return removeAdOverlapFromContentSegments(dedupeRepeatedLineOnlyContentSegments(safeList, context), context);
    }
    const mapped = list.map((seg) => {
        const startLineId = Number(seg?.type === "ad" ? (seg.ad_start_line ?? seg.start_line) : seg.start_line);
        const endLineId = Number(seg?.type === "ad" ? (seg.ad_end_line ?? seg.end_line) : seg.end_line);
        if (!Number.isInteger(startLineId) || !Number.isInteger(endLineId)) return seg;
        const startLine = resolveSubtitleLine(rawRows, startLineId);
        const endLine = resolveSubtitleLine(rawRows, endLineId);
        if (!startLine || !endLine) {
            logAI.warn("segment_line_mapping_failed", {
                bvid: context.bvid || "",
                task: context.task || "segments",
                code: "SEGMENT_LINE_MAPPING_FAILED",
                detail: {
                    mode: context.mode || "",
                    type: String(seg.type || "content"),
                    label: String(seg.label || "").slice(0, 60),
                    start_line: Number.isFinite(startLineId) ? startLineId : null,
                    end_line: Number.isFinite(endLineId) ? endLineId : null,
                    raw_count: rawRows.length,
                    ai_start: Number(seg.start || 0),
                    ai_end: Number(seg.end || 0)
                }
            });
            return noTimestamp || (!seg?.no_timestamp && !seg?.virtual_time) ? seg : null;
        }
        if (noTimestamp) {
            const virtualStart = Math.max(0, startLine.index);
            const virtualEnd = Math.max(virtualStart + 1, endLine.index + 1);
            const next = {
                ...seg,
                start: virtualStart,
                end: virtualEnd,
                start_line: startLine.index,
                end_line: endLine.index,
                ad_start_line: startLine.index,
                ad_end_line: endLine.index,
                line_mapped: true,
                no_timestamp: true,
                virtual_time: true
            };
            if (seg?.type !== "ad") {
                delete next.ad_start_line;
                delete next.ad_end_line;
            } else {
                next.ad_line_mapped = true;
            }
            logAI.info(seg?.type === "ad" ? "ad_line_range_mapped" : "segment_line_range_mapped", {
                bvid: context.bvid || "",
                task: context.task || "segments",
                detail: {
                    mode: context.mode || "",
                    type: String(seg.type || "content"),
                    label: String(seg.label || "").slice(0, 60),
                    no_timestamp: true,
                    mapped_start_line: startLine.index,
                    mapped_end_line: endLine.index,
                    adjusted_line_id: !!(startLine.adjusted || endLine.adjusted),
                    start_text: getSubtitleSnippet(startLine.row),
                    end_text: getSubtitleSnippet(endLine.row)
                }
            });
            return next;
        }
        const start = Number(startLine.row?.from ?? startLine.row?.start ?? 0);
        const endBase = Number(endLine.row?.from ?? endLine.row?.start ?? start);
        const end = getSubtitleEndTime(endLine.row, endBase);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            return !seg?.no_timestamp && !seg?.virtual_time ? seg : null;
        }
        const next = {
            ...seg,
            start,
            end,
            start_line: startLine.index,
            end_line: endLine.index,
            ad_start_line: startLine.index,
            ad_end_line: endLine.index,
            line_mapped: true
        };
        if (seg?.type !== "ad") {
            delete next.ad_start_line;
            delete next.ad_end_line;
        } else {
            next.ad_line_mapped = true;
        }
        delete next.no_timestamp;
        delete next.virtual_time;
        logAI.info(seg?.type === "ad" ? "ad_line_range_mapped" : "segment_line_range_mapped", {
            bvid: context.bvid || "",
            task: context.task || "segments",
            detail: {
                mode: context.mode || "",
                type: String(seg.type || "content"),
                label: String(seg.label || "").slice(0, 60),
                ai_start: Number(seg.start || 0),
                ai_end: Number(seg.end || 0),
                mapped_start: start,
                mapped_end: end,
                start_line: startLine.index,
                end_line: endLine.index,
                adjusted_line_id: !!(startLine.adjusted || endLine.adjusted),
                start_text: getSubtitleSnippet(startLine.row),
                end_text: getSubtitleSnippet(endLine.row)
            }
        });
        return next;
    }).filter(Boolean);
    return removeAdOverlapFromContentSegments(dedupeRepeatedLineOnlyContentSegments(mapped, context), context);
}

function cloneContentSegmentWithRange(seg, start, end, suffix = "") {
    const nextStart = Number(start);
    const nextEnd = Number(end);
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd) || nextEnd - nextStart < 2) return null;
    return {
        start: nextStart,
        end: nextEnd,
        label: suffix ? `${String(seg.label || "内容").trim()}${suffix}` : String(seg.label || "内容").trim(),
        type: "content"
    };
}

function normalizeSegmentLabelForDedupe(label) {
    return String(label || "").replace(/\s+/g, "").trim().toLowerCase();
}

function dedupeRepeatedLineOnlyContentSegments(segments, context = {}) {
    const list = Array.isArray(segments) ? segments : [];
    const seen = new Set();
    const output = [];
    let droppedCount = 0;
    for (const seg of list) {
        const isLineOnlyContent = seg?.type !== "ad" && (seg?.no_timestamp || seg?.virtual_time);
        const key = isLineOnlyContent ? normalizeSegmentLabelForDedupe(seg?.label) : "";
        if (isLineOnlyContent && key && seen.has(key)) {
            droppedCount += 1;
            continue;
        }
        if (isLineOnlyContent && key) seen.add(key);
        output.push(seg);
    }
    if (droppedCount > 0) {
        logAI.warn("segments_duplicate_line_labels_removed", {
            bvid: context.bvid || "",
            task: context.task || "segments",
            code: "SEGMENTS_DUPLICATE_LINE_LABELS_REMOVED",
            detail: {
                mode: context.mode || "",
                dropped_count: droppedCount,
                segment_count_before: list.length,
                segment_count_after: output.length
            }
        });
    }
    return output;
}

function removeAdOverlapFromContentSegments(segments, context = {}) {
    const list = Array.isArray(segments) ? segments : [];
    const ads = list
        .filter((seg) => seg?.type === "ad")
        .map((seg) => ({ ...seg, start: Number(seg.start || 0), end: Number(seg.end || 0) }))
        .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
        .sort((a, b) => a.start - b.start);
    if (!ads.length) {
        return list.sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
    }
    const output = [];
    let adjustedCount = 0;
    for (const seg of list) {
        if (seg?.type === "ad") {
            output.push(seg);
            continue;
        }
        const start = Number(seg?.start || 0);
        const end = Number(seg?.end || 0);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        let ranges = [{ start, end }];
        for (const ad of ads) {
            const overlaps = ranges.some((range) => ad.start < range.end && ad.end > range.start);
            if (!overlaps) continue;
            const nextRanges = [];
            for (const range of ranges) {
                if (ad.end <= range.start || ad.start >= range.end) {
                    nextRanges.push(range);
                    continue;
                }
                adjustedCount += 1;
                if (ad.start > range.start) nextRanges.push({ start: range.start, end: Math.min(ad.start, range.end) });
                if (ad.end < range.end) nextRanges.push({ start: Math.max(ad.end, range.start), end: range.end });
            }
            ranges = nextRanges;
        }
        ranges.forEach((range, index) => {
            const suffix = ranges.length > 1 ? (index === 0 ? "" : "（续）") : "";
            const clipped = cloneContentSegmentWithRange(seg, range.start, range.end, suffix);
            if (clipped) output.push(clipped);
        });
    }
    output.sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
    if (adjustedCount > 0) {
        logAI.info("segments_ad_overlap_resolved", {
            bvid: context.bvid || "",
            task: context.task || "segments",
            detail: {
                mode: context.mode || "",
                ad_count: ads.length,
                adjusted_overlap_count: adjustedCount,
                segment_count_before: list.length,
                segment_count_after: output.length
            }
        });
    }
    return smoothSegmentContinuity(output, context);
}

function smoothSegmentContinuity(segments, context = {}) {
    const list = Array.isArray(segments)
        ? segments
            .map((seg) => ({
                ...seg,
                start: Number(seg.start || 0),
                end: Number(seg.end || 0)
            }))
            .filter((seg) => Number.isFinite(seg.start) && Number.isFinite(seg.end) && seg.end > seg.start)
            .sort((a, b) => a.start - b.start)
        : [];
    if (list.length < 2) return list;
    let adjustedCount = 0;
    let gapToPreviousContentCount = 0;
    let gapToNextContentCount = 0;
    let contentGapCount = 0;
    for (let index = 0; index < list.length - 1; index += 1) {
        const current = list[index];
        const next = list[index + 1];
        const gap = next.start - current.end;
        if (!Number.isFinite(gap) || gap <= 2) continue;
        if (current.type === "ad" && next.type !== "ad") {
            next.start = current.end;
            gapToNextContentCount += 1;
            adjustedCount += 1;
            continue;
        }
        if (current.type !== "ad" && next.type === "ad") {
            current.end = next.start;
            gapToPreviousContentCount += 1;
            adjustedCount += 1;
            continue;
        }
        if (current.type !== "ad" && next.type !== "ad") {
            current.end = next.start;
            contentGapCount += 1;
            adjustedCount += 1;
        }
    }
    if (adjustedCount > 0) {
        logAI.info("segments_continuity_smoothed", {
            bvid: context.bvid || "",
            task: context.task || "segments",
            detail: {
                mode: context.mode || "",
                adjusted_gap_count: adjustedCount,
                gap_to_previous_content_count: gapToPreviousContentCount,
                gap_to_next_content_count: gapToNextContentCount,
                content_gap_count: contentGapCount,
                strategy: "semantic_ad_boundary_preserved",
                segment_count: list.length
            }
        });
    }
    return list;
}

function normalizeRumors(value, cache = {}) {
    const normalized = normalizeRumorsResult(value);
    if (!normalized || !isNoTimestampSubtitleCache(cache)) return normalized;
    return {
        ...normalized,
        no_timestamp: true,
        claims: (normalized.claims || []).map((claim) => ({
            ...claim,
            timestamp_sec: 0,
            no_timestamp: true
        }))
    };
}

function buildFailureLog(error, base = {}) {
    const detail = {
        ...(base.detail || {}),
        error_name: String(error?.name || "Error"),
        error_message: String(error?.message || error || "请求失败"),
        stack_preview: String(error?.stack || "").split("\n").slice(0, 3).join("\n")
    };
    return {
        ...base,
        code: String(error?.code || base.code || ""),
        status: Number(error?.status || base.status || 0) || 0,
        detail
    };
}

function getSubtitleLineCount(cache = {}) {
    const processed = Array.isArray(cache?.processedSubtitle) ? cache.processedSubtitle : [];
    if (processed.length) return processed.length;
    const raw = Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle : [];
    return raw.length;
}

function getSubtitleRowsForDiagnostics(cache = {}) {
    const raw = Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle : [];
    if (raw.length) return raw;
    return Array.isArray(cache?.processedSubtitle) ? cache.processedSubtitle : [];
}

function countSubtitleMatchesForRange(rows, start, end) {
    return rows.filter((item) => {
        const time = Number(item?.from ?? item?.start ?? 0);
        return Number.isFinite(time) && time >= start && time <= end;
    }).length;
}

const AD_DIAGNOSTIC_KEYWORDS = [
    "广告", "赞助", "推广", "优惠", "购买", "下单", "链接", "注册", "扫码", "口令",
    "会员", "课程", "APP", "app下载", "下载", "品牌", "产品", "推荐", "试试", "支持"
];

function getSubtitleTime(row) {
    const time = Number(row?.from ?? row?.start ?? 0);
    return Number.isFinite(time) ? time : 0;
}

function getSubtitleSnippet(row) {
    const text = String(row?.content ?? row?.text ?? "").replace(/\s+/g, " ").trim();
    return text.length > 48 ? `${text.slice(0, 48)}...` : text;
}

function findNearestSubtitleLine(rows, targetTime) {
    const target = Number(targetTime);
    if (!Array.isArray(rows) || !rows.length || !Number.isFinite(target)) return null;
    let best = null;
    rows.forEach((row, index) => {
        const time = getSubtitleTime(row);
        const delta = Math.abs(time - target);
        if (!best || delta < best.delta_sec) {
            best = {
                index,
                time,
                delta_sec: Math.round(delta),
                snippet: getSubtitleSnippet(row)
            };
        }
    });
    return best;
}

function findAdEvidenceRows(rows, start, end) {
    const startSec = Number(start);
    const endSec = Number(end);
    if (!Array.isArray(rows) || !rows.length || !Number.isFinite(startSec) || !Number.isFinite(endSec)) return [];
    return rows
        .map((row, index) => {
            const time = getSubtitleTime(row);
            const text = getSubtitleSnippet(row);
            const keywordHits = AD_DIAGNOSTIC_KEYWORDS.filter((keyword) => text.toLowerCase().includes(String(keyword).toLowerCase()));
            return { index, time, text, keywordHits };
        })
        .filter((item) => item.time >= startSec - 20 && item.time <= endSec + 20 && item.keywordHits.length)
        .slice(0, 8);
}

function buildAdDecisionDiagnostics(segments, subtitleRows) {
    const list = Array.isArray(segments) ? segments : [];
    const rows = Array.isArray(subtitleRows) ? subtitleRows : [];
    return list
        .filter((seg) => seg?.type === "ad")
        .slice(0, 10)
        .map((seg) => {
            const start = Number(seg.start || 0);
            const end = Number(seg.end || 0);
            const startLine = findNearestSubtitleLine(rows, start);
            const endLine = findNearestSubtitleLine(rows, end);
            const evidence = findAdEvidenceRows(rows, start, end);
            const startDelta = Number(startLine?.delta_sec ?? 999);
            const endDelta = Number(endLine?.delta_sec ?? 999);
            const confidence = evidence.length && startDelta <= 10 && endDelta <= 10
                ? "high"
                : (evidence.length ? "medium" : "low");
            return {
                label: String(seg.label || "").slice(0, 40),
                start,
                end,
                duration_sec: Math.max(0, Math.round(end - start)),
                decision: "ad",
                confidence,
                ad_start_line: Number.isInteger(Number(seg.ad_start_line)) ? Number(seg.ad_start_line) : null,
                ad_end_line: Number.isInteger(Number(seg.ad_end_line)) ? Number(seg.ad_end_line) : null,
                ad_line_mapped: !!seg.ad_line_mapped,
                start_boundary: startLine,
                end_boundary: endLine,
                evidence
            };
        });
}

function logSummaryQualitySummary(bvid, summaryText, context = {}) {
    const outputChars = String(summaryText || "").length;
    const subtitleChars = Number(context.subtitleChars || 0);
    const isTooShort = subtitleChars > 3000 && outputChars < 120;
    const event = isTooShort ? "summary_quality_warning" : "summary_quality_check";
    logAI[isTooShort ? "warn" : "info"](event, {
        bvid,
        task: "summary",
        code: isTooShort ? "SUMMARY_TOO_SHORT" : "",
        detail: {
            subtitle_chars: subtitleChars,
            prompt_chars: Number(context.promptChars || 0),
            output_chars: outputChars,
            prompt_mode: context.promptMode || "",
            from_cache: !!context.fromCache
        }
    });
}

function logSegmentQualitySummary(bvid, segments, cache = {}, context = {}) {
    const list = Array.isArray(segments) ? segments : [];
    const subtitleRows = getSubtitleRowsForDiagnostics(cache);
    const adSegments = list.filter((seg) => seg?.type === "ad");
    const adDecisionDiagnostics = buildAdDecisionDiagnostics(list, subtitleRows);
    const adRanges = adSegments.slice(0, 10).map((seg) => {
        const start = Number(seg.start || 0);
        const end = Number(seg.end || 0);
        const matchCount = countSubtitleMatchesForRange(subtitleRows, start, end);
        return {
            start,
            end,
            matched: matchCount > 0,
            subtitle_line_count: matchCount
        };
    });
    const matchedAdCount = adRanges.filter((item) => item.matched).length;
    const unmatchedAdCount = Math.max(0, adSegments.length - matchedAdCount);
    logAI.info("ad_detection_summary", {
        bvid,
        task: context.task || "segments",
        detail: {
            mode: context.mode || "",
            fallback: context.fallback || "",
            segment_count: list.length,
            ad_segment_count: adSegments.length,
            subtitle_line_count: getSubtitleLineCount(cache),
            subtitle_payload: context.subtitlePayload || null,
            matched_ad_count: matchedAdCount,
            unmatched_ad_count: unmatchedAdCount,
            match_strategy: "time_range",
            ad_ranges: adRanges,
            ad_decisions: adDecisionDiagnostics
        }
    });
    if (!list.length || unmatchedAdCount > 0) {
        logAI.warn("segments_quality_warning", {
            bvid,
            task: context.task || "segments",
            code: !list.length ? "SEGMENTS_EMPTY" : "AD_MATCH_WEAK",
            detail: {
                mode: context.mode || "",
                segment_count: list.length,
                ad_segment_count: adSegments.length,
                unmatched_ad_count: unmatchedAdCount
            }
        });
    }
}

function logRumorsQualitySummary(bvid, rumors, context = {}) {
    const claims = Array.isArray(rumors?.claims) ? rumors.claims : [];
    const missingEvidenceCount = claims.filter((claim) => {
        const analysis = String(claim?.analysis || "").trim();
        const claimText = String(claim?.claim || "").trim();
        return !analysis || !claimText;
    }).length;
    logAI[missingEvidenceCount ? "warn" : "info"]("rumors_quality_check", {
        bvid,
        task: "rumors",
        code: missingEvidenceCount ? "RUMORS_MISSING_EVIDENCE" : "",
        detail: {
            mode: context.mode || "",
            claim_count: claims.length,
            missing_evidence_count: missingEvidenceCount,
            has_overview: !!String(rumors?.overview || "").trim(),
            output_chars: Number(context.outputChars || 0),
            parse_retry_count: Number(context.parseRetryCount || 0)
        }
    });
}

function createTaskTimeoutError(code = "AI_RESPONSE_TIMEOUT", message = "模型请求超时，请重试") {
    return createAppError(code, message);
}

function createUserAbortedError() {
    const error = new Error("已停止生成");
    error.code = "ABORTED";
    return error;
}

async function waitForProvider429RetryDelay(delayMs, tabId) {
    const controller = new AbortController();
    const unregister = registerTabAbortController(tabId, controller);
    try {
        await waitForAbortableDelay(delayMs, controller.signal);
    } finally {
        unregister();
    }
}

async function runAIRequestWith429Backoff(settings, options, runAttempt) {
    const isDebugSimulation = options?.taskContext?.debugForceProvider429Retries === true;
    const provider = String(settings?.provider || "").toLowerCase();
    const isGeminiRetryAfterFlow = provider === "gemini" && !isDebugSimulation;
    const isModelScopeRetryFlow = isStrictModelScopeProvider(settings) && !isDebugSimulation;
    if (options?.disableProvider429Retry) {
        return runAttempt({ attempt: 1, maxAttempts: 1 });
    }
    return runWithProvider429Backoff(async (attemptContext) => {
        if (isDebugSimulation && Number(attemptContext?.attempt || 0) <= 3) {
            throw createAppError("HTTP_429", "测试模式：模拟 Provider 返回 429", { status: 429 });
        }
        if (isDebugSimulation && options?.taskContext) {
            options.taskContext.debugForceProvider429Retries = false;
        }
        return runAttempt(attemptContext);
    }, {
        delaysMs: isGeminiRetryAfterFlow ? [0] : (isModelScopeRetryFlow ? [2000] : undefined),
        shouldRetry: (error) => {
            if (provider === "modelscope" && shouldUseImmediateModelScopeFallback(error)) return false;
            if (isGeminiRetryAfterFlow) return resolveProviderRetryAfterMs(error) > 0;
            return true;
        },
        getNextDelayMs: isGeminiRetryAfterFlow
            ? (error) => resolveProviderRetryAfterMs(error)
            : undefined,
        wait: (delayMs) => waitForProvider429RetryDelay(delayMs, options?.tabId),
        onRateLimit: async (event) => {
            if (event?.error && typeof event.error === "object") {
                event.error.requestAttempt = Number(event.attempt || 0);
                event.error.requestMaxAttempts = Number(event.maxAttempts || 0);
                event.error.retryDelaysMs = isGeminiRetryAfterFlow
                    ? [Number(event?.nextDelayMs || 0)]
                    : (isModelScopeRetryFlow ? [2000] : [2000, 5000, 10000]);
                event.error.retryStrategy = isGeminiRetryAfterFlow ? "gemini_retry_after" : "provider_429_backoff";
            }
            logAI.warn("provider_429_retry", {
                task: String(options?.component || "ai"),
                bvid: normalizeBvid(options?.bvid || options?.taskContext?.bvid || ""),
                provider: settings?.provider || "",
                model: settings?.model || "",
                code: resolveUsageErrorCode(event?.error, "HTTP_429"),
                detail: {
                    attempt: Number(event?.attempt || 0),
                    max_attempts: Number(event?.maxAttempts || 0),
                    next_delay_ms: Number(event?.nextDelayMs || 0),
                    exhausted: !!event?.exhausted
                }
            });
            if (isDebugSimulation) {
                await recordSegmentsDebugState(options?.tabId, {
                    status: event?.exhausted ? "retry_failed" : "retrying",
                    stage: event?.exhausted ? "provider_429_exhausted" : "provider_429_wait",
                    strategy: "provider_429_backoff",
                    attempt: Number(event?.attempt || 0),
                    total: Number(event?.maxAttempts || 4),
                    code: "HTTP_429",
                    message: event?.exhausted
                        ? "429 自动重试已耗尽"
                        : `第 ${Number(event?.attempt || 0)} 次收到 429，${Number(event?.nextDelayMs || 0) / 1000} 秒后重试`
                }, event?.exhausted
                    ? "模拟 429 自动重试已耗尽"
                    : `模拟第 ${Number(event?.attempt || 0)} 次 429，等待 ${Number(event?.nextDelayMs || 0) / 1000} 秒`);
                return;
            }
            if (isGeminiRetryAfterFlow && !event?.exhausted && Number(event?.nextDelayMs || 0) > 0) {
                const waitSeconds = Math.max(1, Math.ceil(Number(event.nextDelayMs) / 1000));
                try {
                    await chrome.tabs.sendMessage(options?.tabId, {
                        action: "SHOW_TOAST",
                        text: `当前模型触发限流，将在 ${waitSeconds} 秒后自动重试`,
                        durationMs: Math.min(5000, Math.max(1800, Number(event.nextDelayMs)))
                    });
                } catch (_) {}
            }
            await reportProvider429RetryAttempt(settings, options, event);
        },
        onRecovered: async (event) => {
            logAI.info("provider_429_recovered", {
                task: String(options?.component || "ai"),
                bvid: normalizeBvid(options?.bvid || options?.taskContext?.bvid || ""),
                provider: settings?.provider || "",
                model: settings?.model || "",
                duration_ms: Number(event?.recoveryDurationMs || 0),
                detail: {
                    successful_attempt: Number(event?.attempt || 0),
                    retry_count: Math.max(0, Number(event?.attempt || 0) - 1),
                    applied_delay_ms: Number(event?.appliedDelayMs || 0)
                }
            });
            if (isDebugSimulation) {
                await recordSegmentsDebugState(options?.tabId, {
                    status: "recovered",
                    stage: "provider_429_recovered",
                    strategy: "provider_429_backoff",
                    attempt: Number(event?.attempt || 0),
                    total: Number(event?.maxAttempts || 4),
                    code: "HTTP_429",
                    message: "429 自动重试成功，任务继续执行"
                }, `第 ${Number(event?.attempt || 0)} 次请求成功，429 已自动恢复`);
                return;
            }
            await reportProvider429Recovered(settings, options, event, event?.result?.metrics || {});
        }
    });
}

async function callAIWithTimeout(settings, messages, timeoutMs, options = {}) {
    const runRequest = (requestSettings, requestOptions = options) => runAIRequestWith429Backoff(
        requestSettings,
        requestOptions,
        () => callAIWithTimeoutOnce(requestSettings, messages, timeoutMs, {
            ...requestOptions,
            suppress429FailureLog: true
        })
    );
    try {
        return await runRequest(settings);
    } catch (error) {
        const fallbackResult = await tryModelScopeFallback(settings, options, error, (fallbackSettings) => runRequest(
            fallbackSettings,
            { ...options, disableModelFallback: true, disableProvider429Retry: true }
        ));
        if (fallbackResult) return fallbackResult;
        throw error;
    }
}

async function callAIWithTimeoutOnce(settings, messages, timeoutMs, options = {}) {
    const controller = new AbortController();
    const unregister = registerTabAbortController(options?.tabId, controller);
    const queueSizeAtStart = queue.length;
    const activeCountAtStart = activeCount;
    const timing = createProviderRequestTiming({ controller, timeoutMs });
    try {
        const requestRunner = () => {
            const requestTiming = timing.startRequest();
            logAI.debug("provider_request_start", {
                task: "ai",
                provider: settings.provider,
                model: settings.model || "",
                duration_ms: requestTiming.queueWaitMs || 0,
                detail: {
                    queue_wait_ms: requestTiming.queueWaitMs || 0,
                    queue_size_at_start: queueSizeAtStart,
                    active_count_at_start: activeCountAtStart,
                    bypass_queue: !!options?.bypassQueue
                }
            });
            return callAI(settings.provider, settings, messages, controller.signal);
        };
        const res = options?.bypassQueue ? await requestRunner() : await runQueued(requestRunner);
        const requestTiming = timing.snapshot();
        const latencyMs = requestTiming.providerRequestMs || 0;
        const tokenInfo = resolveTokenInfo(res.usage, res.text, messages);
        const rateLimitInfo = resolveRateLimitInfo(settings, res.headers);
        void rememberModelScopeRateLimit(settings, rateLimitInfo);
        logAI.debug("provider_response", {
            provider: settings.provider,
            model: settings.model || "",
            duration_ms: latencyMs,
            detail: {
                ...tokenInfo,
                has_text: !!res.text,
                rate_limit: rateLimitInfo,
                queue_wait_ms: requestTiming.queueWaitMs || 0,
                provider_request_ms: latencyMs
            }
        });
        logAIResponseText({
            provider: settings.provider,
            model: settings.model || "",
            durationMs: latencyMs,
            text: res.text || ""
        });
        return {
            text: res.text || "",
            metrics: buildRequestMetrics(settings, tokenInfo, latencyMs, rateLimitInfo),
            responseMeta: res.responseMeta || null
        };
    } catch (error) {
        const requestTiming = timing.snapshot();
        logAI[options?.suppress429FailureLog && Number(error?.status || 0) === 429 ? "warn" : "error"]("ai_request_failed", buildFailureLog(error, {
            task: "ai",
            provider: settings.provider,
            model: settings.model || "",
            detail: {
                queue_wait_ms: requestTiming.queueWaitMs || 0,
                provider_request_ms: requestTiming.providerRequestMs
            }
        }));
        if (controller.signal.aborted) {
            if (controller.signal.reason === "aborted") {
                throw createUserAbortedError();
            }
            const timeoutError = createTaskTimeoutError("AI_RESPONSE_TIMEOUT", "模型请求超时，请重试");
            attachSentryContext(timeoutError, buildProviderRequestTelemetry(settings, timeoutMs, {
                stream: false,
                bypassQueue: !!options?.bypassQueue,
                queueSizeAtStart,
                activeCountAtStart,
                ...requestTiming,
                timeoutPhase: "provider_request"
            }));
            logAI.error("ai_request_timeout", buildFailureLog(timeoutError, {
                task: "ai",
                provider: settings.provider,
                model: settings.model || "",
                code: timeoutError.code || "AI_RESPONSE_TIMEOUT",
                detail: {
                    queue_wait_ms: requestTiming.queueWaitMs || 0,
                    provider_request_ms: requestTiming.providerRequestMs,
                    first_response_ms: requestTiming.firstResponseMs,
                    timeout_phase: "provider_request",
                    timeout_ms: timeoutMs
                }
            }));
            throw timeoutError;
        }
        attachSentryContext(error, buildProviderRequestTelemetry(settings, timeoutMs, {
            stream: false,
            bypassQueue: !!options?.bypassQueue,
            queueSizeAtStart,
            activeCountAtStart,
            ...requestTiming
        }));
        throw error;
    } finally {
        unregister();
        timing.finish();
    }
}

async function callAIWithTimeoutStream(settings, messages, timeoutMs, onDelta, externalController, options = {}) {
    let emittedChars = 0;
    const trackedOnDelta = (delta) => {
        emittedChars += String(delta || "").length;
        if (typeof onDelta === "function") onDelta(delta);
    };
    const runRequest = (requestSettings, requestOptions = options) => runAIRequestWith429Backoff(
        requestSettings,
        requestOptions,
        () => callAIWithTimeoutStreamOnce(
            requestSettings,
            messages,
            timeoutMs,
            trackedOnDelta,
            externalController,
            requestOptions
        )
    );
    try {
        return await runRequest(settings);
    } catch (error) {
        if (emittedChars > 0 || externalController?.signal?.aborted) throw error;
        const fallbackResult = await tryModelScopeFallback(settings, options, error, (fallbackSettings) => runRequest(
            fallbackSettings,
            { ...options, disableModelFallback: true, disableProvider429Retry: true }
        ));
        if (fallbackResult) return fallbackResult;
        throw error;
    }
}

async function callAIWithTimeoutStreamOnce(settings, messages, timeoutMs, onDelta, externalController, options = {}) {
    const controller = externalController || new AbortController();
    const unregister = externalController ? () => {} : registerTabAbortController(options?.tabId, controller);
    let firstResponseReceived = false;
    const retryDelaysMs = [STREAM_INITIAL_RETRY_DELAY_MS];
    const maxAttempts = retryDelaysMs.length + 1;
    const queueSizeAtStart = queue.length;
    const activeCountAtStart = activeCount;
    const timing = createProviderRequestTiming({
        controller,
        timeoutMs,
        stopTimeoutOnFirstResponse: true
    });
    try {
        const wrappedOnDelta = (delta) => {
            if (!firstResponseReceived) {
                firstResponseReceived = true;
                timing.markFirstResponse();
            }
            if (typeof onDelta === "function") onDelta(delta);
        };
        let res = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            try {
                res = await runQueued(() => {
                    const requestTiming = timing.startRequest();
                    if (attempt === 1) {
                        logAI.debug("provider_request_start", {
                            task: "ai",
                            provider: settings.provider,
                            model: settings.model || "",
                            duration_ms: requestTiming.queueWaitMs || 0,
                            detail: {
                                request_stream: true,
                                queue_wait_ms: requestTiming.queueWaitMs || 0,
                                queue_size_at_start: queueSizeAtStart,
                                active_count_at_start: activeCountAtStart
                            }
                        });
                    }
                    return callAIStream(settings.provider, settings, messages, controller.signal, wrappedOnDelta);
                });
                break;
            } catch (error) {
                decorateStreamRetryMetadata(error, attempt, maxAttempts, retryDelaysMs);
                if (controller.signal.aborted) throw error;
                if (!shouldRetryInitialStreamFailure(error, firstResponseReceived, attempt, maxAttempts)) throw error;
                const delayMs = retryDelaysMs[attempt - 1] || 0;
                logAI.warn("ai_stream_initial_retry", {
                    task: "ai",
                    provider: settings.provider,
                    model: settings.model || "",
                    code: error?.code || "",
                    detail: {
                        attempt,
                        max_attempts: maxAttempts,
                        next_delay_ms: delayMs,
                        first_response_received: firstResponseReceived
                    }
                });
                await waitForAbortableDelay(delayMs, controller.signal);
            }
        }
        const requestTiming = timing.snapshot();
        const latencyMs = requestTiming.providerRequestMs || 0;
        const tokenInfo = resolveTokenInfo(res.usage, res.text, messages);
        const rateLimitInfo = resolveRateLimitInfo(settings, res.headers);
        void rememberModelScopeRateLimit(settings, rateLimitInfo);
        logAI.debug("provider_response", {
            provider: settings.provider,
            model: settings.model || "",
            duration_ms: latencyMs,
            detail: {
                request_stream: true,
                queue_wait_ms: requestTiming.queueWaitMs || 0,
                provider_request_ms: latencyMs,
                first_response_ms: requestTiming.firstResponseMs,
                first_response_received: firstResponseReceived,
                ...tokenInfo
            }
        });
        logAIResponseText({
            provider: settings.provider,
            model: settings.model || "",
            durationMs: latencyMs,
            text: res.text || ""
        });
        return {
            text: res.text || "",
            metrics: buildRequestMetrics(settings, tokenInfo, latencyMs, rateLimitInfo),
            responseMeta: res.responseMeta || null
        };
    } catch (error) {
        const requestTiming = timing.snapshot();
        if (controller.signal.aborted) {
            if (controller.signal.reason === "aborted") {
                throw createUserAbortedError();
            }
            const timeoutError = createTaskTimeoutError("AI_STREAM_TIMEOUT", "模型长时间没有开始返回内容，请重试");
            attachSentryContext(timeoutError, buildProviderRequestTelemetry(settings, timeoutMs, {
                stream: true,
                bypassQueue: false,
                queueSizeAtStart,
                activeCountAtStart,
                ...requestTiming,
                timeoutPhase: "first_response",
                firstResponseReceived
            }));
            logAI.error("ai_request_timeout", buildFailureLog(timeoutError, {
                task: "ai",
                provider: settings.provider,
                model: settings.model || "",
                code: timeoutError.code || "AI_STREAM_TIMEOUT",
                detail: {
                    queue_wait_ms: requestTiming.queueWaitMs || 0,
                    provider_request_ms: requestTiming.providerRequestMs,
                    first_response_ms: requestTiming.firstResponseMs,
                    timeout_phase: "first_response",
                    timeout_ms: timeoutMs,
                    first_response_received: firstResponseReceived
                }
            }));
            throw timeoutError;
        }
        attachSentryContext(error, buildProviderRequestTelemetry(settings, timeoutMs, {
            stream: true,
            bypassQueue: false,
            queueSizeAtStart,
            activeCountAtStart,
            ...requestTiming,
            firstResponseReceived
        }));
        throw error;
    } finally {
        unregister();
        timing.finish();
    }
}

function readHeaderNumber(headers, name) {
    const value = headers?.get?.(name);
    return parseHeaderNumber(value);
}

function readAnyHeaderNumber(headers, names = []) {
    for (const name of names) {
        const value = readHeaderNumber(headers, name);
        if (value !== null) return value;
    }
    return null;
}

function parseHeaderNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function hasModelScopeRateLimitInfo(info) {
    return !!info && [info.modelLimit, info.modelRemaining, info.userLimit, info.userRemaining]
        .some((value) => value !== null && value !== undefined);
}

function resolveRateLimitInfo(settings, headers, { allowObservedFallback = true } = {}) {
    if (String(settings?.provider || "").toLowerCase() !== "modelscope") return null;
    const direct = {
        modelLimit: readAnyHeaderNumber(headers, ["modelscope-ratelimit-model-requests-limit", "x-modelscope-ratelimit-model-requests-limit", "x-ratelimit-model-requests-limit"]),
        modelRemaining: readAnyHeaderNumber(headers, ["modelscope-ratelimit-model-requests-remaining", "x-modelscope-ratelimit-model-requests-remaining", "x-ratelimit-model-requests-remaining"]),
        userLimit: readAnyHeaderNumber(headers, ["modelscope-ratelimit-requests-limit", "x-modelscope-ratelimit-requests-limit", "x-ratelimit-requests-limit", "ratelimit-limit"]),
        userRemaining: readAnyHeaderNumber(headers, ["modelscope-ratelimit-requests-remaining", "x-modelscope-ratelimit-requests-remaining", "x-ratelimit-requests-remaining", "ratelimit-remaining"])
    };
    if ([direct.modelLimit, direct.modelRemaining, direct.userLimit, direct.userRemaining].some((value) => value !== null)) {
        return direct;
    }
    if (allowObservedFallback && latestModelScopeRateLimitInfo && Date.now() - Number(latestModelScopeRateLimitInfo.capturedAt || 0) < 30000) {
        return { ...latestModelScopeRateLimitInfo };
    }
    return direct;
}

function getModelScopeDailyRequestLimit(model) {
    const key = String(model || "").trim().toLowerCase();
    const limits = {
        "qwen/qwen3-30b-a3b-instruct-2507": 200,
        "qwen/qwen3-235b-a22b-instruct-2507": 50,
        "qwen/qwen3-coder-30b-a3b-instruct": 100,
        "qwen/qwen3-30b-a3b": 200,
        "deepseek-ai/deepseek-v4-pro": 20,
        "deepseek-ai/deepseek-v4-flash-0731": 50
    };
    return limits[key] || null;
}

function buildRequestMetrics(settings, tokenInfo, latencyMs, rateLimitInfo = null) {
    const provider = String(settings?.provider || "");
    const model = String(settings?.model || "");
    const fallbackModelLimit = provider.toLowerCase() === "modelscope" ? getModelScopeDailyRequestLimit(model) : null;
    return {
        latencyMs,
        tokens: tokenInfo.total,
        inputTokens: tokenInfo.input,
        outputTokens: tokenInfo.output,
        maxOutputTokens: Number(settings?.maxOutputTokens || 4096),
        provider,
        model,
        modelScopeRemaining: rateLimitInfo?.modelRemaining ?? null,
        modelScopeModelLimit: rateLimitInfo?.modelLimit ?? fallbackModelLimit,
        modelScopeUserRemaining: rateLimitInfo?.userRemaining ?? null,
        modelScopeUserLimit: rateLimitInfo?.userLimit ?? null
    };
}

function resolveTokenInfo(usage, text, messages) {
    // Try to get explicit input/output
    const input = Number(usage?.prompt_tokens || usage?.input_tokens || usage?.promptTokens || 0);
    const output = Number(usage?.completion_tokens || usage?.output_tokens || usage?.completionTokens || 0);
    
    if (input > 0 || output > 0) {
        const total = Number.isFinite(Number(usage?.total_tokens || usage?.totalTokens || usage?.token_count || usage?.tokens)) 
            ? Number(usage?.total_tokens || usage?.totalTokens || usage?.token_count || usage?.tokens) 
            : (input + output);
        return { total, input, output };
    }

    // Fallback: estimate
    const inText = Array.isArray(messages) ? messages.map((m) => String(m?.content || "")).join("\n") : "";
    const outText = String(text || "");
    const inChars = inText.replace(/\s+/g, "");
    const outChars = outText.replace(/\s+/g, "");
    
    const estInput = Math.max(1, Math.round(inChars.length / 2));
    const estOutput = Math.max(1, Math.round(outChars.length / 2));
    
    return { total: estInput + estOutput, input: estInput, output: estOutput };
}

function abortChatForPort(port, msg) {
    const tabId = Number(msg?.tabId || port?.sender?.tab?.id || 0);
    const messageId = String(msg?.messageId || "");
    if (!tabId || !messageId) return;
    const abortKey = `${tabId}|${messageId}`;
    const controller = chatAbortControllers.get(abortKey);
    if (!controller) return;
    try {
        controller.abort("aborted");
    } catch (_) {}
}

function safePortPost(port, payload) {
    try {
        port.postMessage(payload);
    } catch (_) {}
}

function runQueued(taskFn) {
    return new Promise((resolve, reject) => {
        queue.push({ taskFn, resolve, reject });
        logBackground.debug("task_enqueue", { queue_size: queue.length, active_count: activeCount });
        flushQueue();
    });
}

function flushQueue() {
    while (activeCount < MAX_GLOBAL_CONCURRENCY && queue.length) {
        const next = queue.shift();
        activeCount += 1;
        Promise.resolve()
            .then(() => next.taskFn())
            .then((result) => next.resolve(result))
            .catch((error) => next.reject(error))
            .finally(() => {
                activeCount -= 1;
                flushQueue();
            });
    }
}

function runWithDedup(key, runner) {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = Promise.resolve().then(runner).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
}

function createIdleTaskStatus() {
    return { summary: "idle", segments: "idle", rumors: "idle", chat: "idle" };
}

function getTaskStateForPart(tabState = {}, context = {}) {
    const identity = resolvePartContext(context?.bvid || tabState?.activeBvid || "", context);
    const stored = identity.partKey && tabState?.taskStateByPart?.[identity.partKey];
    if (stored && typeof stored === "object") {
        return {
            taskStatus: { ...createIdleTaskStatus(), ...(stored.taskStatus || {}) },
            taskErrors: { ...(stored.taskErrors || {}) },
            taskRetryState: { ...(stored.taskRetryState || {}) },
            lastError: String(stored.lastError || "")
        };
    }
    const activePartKey = createVideoCachePartKeyForContext(tabState?.activeBvid, {
        cid: tabState?.activeCid,
        tid: tabState?.activeTid,
        partCount: tabState?.activePartCount
    });
    const isActivePart = identity.partKey && identity.partKey === activePartKey;
    return {
        taskStatus: isActivePart ? { ...createIdleTaskStatus(), ...(tabState?.taskStatus || {}) } : createIdleTaskStatus(),
        taskErrors: isActivePart ? { ...(tabState?.taskErrors || {}) } : {},
        taskRetryState: isActivePart ? { ...(tabState?.taskRetryState || {}) } : {},
        lastError: isActivePart ? String(tabState?.lastError || "") : ""
    };
}

async function writeTaskStateForPart(tabId, current, identity, nextState) {
    if (!identity?.partKey) {
        await updateTabState(tabId, { ...nextState, updatedAt: Date.now() });
        return;
    }
    const latest = await getTabState(tabId);
    const taskStateByPart = {
        ...(latest?.taskStateByPart || current?.taskStateByPart || {}),
        [identity.partKey]: { ...nextState, updatedAt: Date.now() }
    };
    const activePartKey = createVideoCachePartKeyForContext(latest?.activeBvid, {
        cid: latest?.activeCid,
        tid: latest?.activeTid,
        partCount: latest?.activePartCount
    });
    const visiblePatch = activePartKey === identity.partKey ? nextState : {};
    await updateTabState(tabId, { taskStateByPart, ...visiblePatch, updatedAt: Date.now() });
}

function runWithTaskStateLock(tabId, runner) {
    const key = String(tabId || 0);
    const previous = taskStateWriteLocks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(runner);
    taskStateWriteLocks.set(key, next);
    return next.finally(() => {
        if (taskStateWriteLocks.get(key) === next) taskStateWriteLocks.delete(key);
    });
}

async function setTaskStatus(tabId, tasks, status, lastError = "", partContext = {}) {
    return runWithTaskStateLock(tabId, async () => {
        const current = await getTabState(tabId);
        const identity = resolvePartContext(current?.activeBvid || "", partContext);
        const partState = getTaskStateForPart(current, identity);
        const taskStatus = { ...partState.taskStatus };
        const taskErrors = { ...partState.taskErrors };
        const taskRetryState = { ...partState.taskRetryState };
        tasks.forEach((task) => {
            taskStatus[task] = status;
            if (status === "error" || status === "timeout") {
                taskErrors[task] = {
                    message: String(lastError || "任务失败"),
                    code: "",
                    status: undefined,
                    retryAfterSec: undefined
                };
            } else {
                delete taskErrors[task];
            }
            if (status === "idle") {
                delete taskRetryState[task];
            }
        });
        await writeTaskStateForPart(tabId, current, identity, { taskStatus, taskErrors, taskRetryState, lastError });
    });
}

async function appendMetrics(bvid, tabId, task, metrics, partContext = {}) {
    const rawCache = await getCache(bvid);
    const identity = resolvePartContext(bvid, partContext);
    const cache = getPartCacheForContext(rawCache, bvid, identity) || {};
    const cacheMetrics = Array.isArray(cache.metrics) ? cache.metrics : [];
    const entry = { task, ...metrics, at: Date.now() };
    await mergeCacheByBvid(bvid, {
        cid: identity.cid,
        tid: identity.tid,
        partCount: identity.partCount,
        metrics: [...cacheMetrics, entry].slice(-30),
        updatedAt: Date.now()
    });
    if (tabId) {
        const tabState = await getTabState(tabId);
        const tabMetrics = Array.isArray(tabState.metrics) ? tabState.metrics : [];
        await updateTabState(tabId, { metrics: [...tabMetrics, entry].slice(-20), updatedAt: Date.now() });
    }
}

async function getTabState(tabId) {
    const key = `tabState_${tabId}`;
    if (tabStateCache.has(key)) {
        return cloneData(tabStateCache.get(key));
    }
    const data = await chrome.storage.local.get([key]);
    if (data[key]) {
        tabStateCache.set(key, cloneData(data[key]));
    }
    logCache.debug("cache_read", { key, found: !!data[key] });
    return data[key] || null;
}

async function updateTabState(tabId, patch) {
    const key = `tabState_${tabId}`;
    const current = await getTabState(tabId);
    const merged = {
        tabId,
        activeBvid: null,
        activeCid: 0,
        activeTid: null,
        activePartCount: 0,
        taskStatus: createIdleTaskStatus(),
        taskErrors: {},
        taskRetryState: {},
        lastError: "",
        metrics: [],
        ...current,
        ...patch
    };
    const routeIdentityChanged = Object.prototype.hasOwnProperty.call(patch || {}, "activeBvid")
        || Object.prototype.hasOwnProperty.call(patch || {}, "activeCid");
    if (routeIdentityChanged) {
        const nextPartKey = createVideoCachePartKeyForContext(merged.activeBvid, {
            cid: merged.activeCid,
            tid: merged.activeTid,
            partCount: merged.activePartCount
        });
        const previousPartKey = createVideoCachePartKeyForContext(current?.activeBvid, {
            cid: current?.activeCid,
            tid: current?.activeTid,
            partCount: current?.activePartCount
        });
        const stored = nextPartKey && merged.taskStateByPart?.[nextPartKey];
        const hasExplicitTaskState = Object.prototype.hasOwnProperty.call(patch || {}, "taskStatus");
        const projected = hasExplicitTaskState
            ? {
                taskStatus: { ...createIdleTaskStatus(), ...(merged.taskStatus || {}) },
                taskErrors: { ...(merged.taskErrors || {}) },
                taskRetryState: { ...(merged.taskRetryState || {}) },
                lastError: String(merged.lastError || "")
            }
            : stored
            ? getTaskStateForPart(merged, { bvid: merged.activeBvid, cid: merged.activeCid, tid: merged.activeTid })
            : nextPartKey && nextPartKey === previousPartKey
                ? {
                    taskStatus: { ...createIdleTaskStatus(), ...(merged.taskStatus || {}) },
                    taskErrors: { ...(merged.taskErrors || {}) },
                    taskRetryState: { ...(merged.taskRetryState || {}) },
                    lastError: String(merged.lastError || "")
                }
                : {
                    taskStatus: createIdleTaskStatus(),
                    taskErrors: {},
                    taskRetryState: {},
                    lastError: ""
                };
        merged.taskStatus = projected.taskStatus;
        merged.taskErrors = projected.taskErrors;
        merged.taskRetryState = projected.taskRetryState;
        merged.lastError = projected.lastError;
        if (hasExplicitTaskState && nextPartKey) {
            merged.taskStateByPart = {
                ...(merged.taskStateByPart || {}),
                [nextPartKey]: { ...projected, updatedAt: Date.now() }
            };
        }
    }
    if (isEqualJSON(current, merged)) {
        tabStateCache.set(key, cloneData(merged));
        return merged;
    }
    tabStateCache.set(key, cloneData(merged));
    debounceFlushTabState(key, merged, tabId);
    return merged;
}

function debounceFlushTabState(key, tabState, tabId) {
    const prev = tabStateWriteTimers.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(async () => {
        tabStateWriteTimers.delete(key);
        const latest = tabStateCache.get(key) || tabState;
        await chrome.storage.local.set({ [key]: latest });
        logCache.debug("cache_write", { key: `tabState_${tabId}` });
        logBackground.debug("storage_update", { key: `tabState_${tabId}` });
    }, 500);
    tabStateWriteTimers.set(key, timer);
}

async function getCache(bvid) {
    const normalized = normalizeBvid(bvid);
    if (!normalized) return {};
    if (cacheMemory.has(normalized)) {
        const cached = cacheMemory.get(normalized);
        const refreshed = normalizeVideoCacheDirectory(cached, normalized);
        if (!isEqualJSON(cached, refreshed)) {
            cacheMemory.set(normalized, cloneData(refreshed));
            await chrome.storage.local.set({ [`cache_${normalized}`]: refreshed });
        }
        return cloneData(refreshed);
    }
    const key = `cache_${normalized}`;
    const legacyKey = `cache_${String(bvid || "").toUpperCase()}`;
    const keys = legacyKey !== key ? [key, legacyKey] : [key];
    const data = await chrome.storage.local.get(keys);
    const storedValue = data[key] || data[legacyKey] || {};
    const value = normalizeVideoCacheDirectory(storedValue, normalized);
    if (value && typeof value === "object") cacheMemory.set(normalized, cloneData(value));
    logCache.debug("cache_read", { key, found: !!value });
    if (!isEqualJSON(storedValue, value) || (!data[key] && data[legacyKey])) {
        await chrome.storage.local.set({ [key]: value });
        if (legacyKey !== key && data[legacyKey]) await chrome.storage.local.remove(legacyKey);
        logCache.info("cache_schema_migrated", { key, schema_version: VIDEO_CACHE_SCHEMA_VERSION });
        logCacheDirectorySnapshot(value, "migration");
    }
    return value;
}

const DERIVED_PART_CACHE_FIELDS = [
    "summary", "summaryDraft", "segments", "rumors", "history", "metrics",
    "summaryCacheSource", "segmentsCacheSource", "rumorsCacheSource",
    "summaryModel", "segmentsModel", "rumorsModel",
    "summaryUpdatedAt", "segmentsUpdatedAt", "rumorsUpdatedAt"
];

const LEGACY_ROOT_PART_FIELDS = [
    "cid", "tid", "title",
    "rawSubtitle", "processedSubtitle", "rawHash", "processedHash",
    "subtitleSource", "subtitleLanguage", "subtitleLanguageLabel", "subtitleUrl",
    "cloudSyncedAt", "updatedAt"
];

const TOP_LEVEL_SUBTITLE_CACHE_FIELDS = [
    "cid", "tid", "title",
    "rawSubtitle", "processedSubtitle", "rawHash", "processedHash",
    "subtitleSource", "subtitleLanguage", "subtitleLanguageLabel", "subtitleUrl",
    "cloudSyncedAt"
];

function clearDerivedPartCacheFields(part = {}) {
    const next = cloneData(part || {});
    DERIVED_PART_CACHE_FIELDS.forEach((field) => delete next[field]);
    return next;
}

function normalizeVideoCacheDirectory(cache = {}, bvid = "") {
    const normalizedBvid = normalizeBvid(cache?.bvid || bvid);
    if (!normalizedBvid) return {};
    const storedSchemaVersion = Number(cache?.schemaVersion || 0);
    const hasTrustedPartScope = storedSchemaVersion >= 2;
    const rawParts = cache?.parts && typeof cache.parts === "object" ? cache.parts : {};
    const parts = {};
    Object.entries(rawParts).forEach(([storedKey, rawPart]) => {
        if (!rawPart || typeof rawPart !== "object") return;
        const cid = Number(rawPart.cid || String(storedKey).split("::").pop() || 0);
        const isPendingSinglePart = !(cid > 0)
            && String(storedKey).endsWith(`::${SINGLE_PART_PENDING_SUFFIX}`)
            && (rawPart.pendingSinglePart === true || Number(rawPart.partCount || 0) === 1);
        if (!(cid > 0) && !isPendingSinglePart) return;
        const partKey = cid > 0
            ? createVideoCachePartKey(normalizedBvid, cid)
            : `${normalizedBvid}::${SINGLE_PART_PENDING_SUFFIX}`;
        const source = hasTrustedPartScope ? cloneData(rawPart) : clearDerivedPartCacheFields(rawPart);
        const summaryDraft = normalizeSummaryDraft(source.summaryDraft);
        if (summaryDraft) source.summaryDraft = summaryDraft;
        else delete source.summaryDraft;
        parts[partKey] = {
            ...source,
            bvid: normalizedBvid,
            cid: cid > 0 ? cid : 0,
            ...(isPendingSinglePart ? { pendingSinglePart: true, partCount: 1 } : {}),
            updatedAt: Number(source.updatedAt || cache.updatedAt || Date.now())
        };
    });

    if (!hasTrustedPartScope) {
        const rootCid = Number(cache?.cid || 0);
        if (rootCid > 0) {
            const partKey = createVideoCachePartKey(normalizedBvid, rootCid);
            const rootPart = LEGACY_ROOT_PART_FIELDS.reduce((acc, field) => {
                if (Object.prototype.hasOwnProperty.call(cache, field)) acc[field] = cloneData(cache[field]);
                return acc;
            }, {});
            parts[partKey] = {
                ...(parts[partKey] || {}),
                ...rootPart,
                bvid: normalizedBvid,
                cid: rootCid,
                updatedAt: Number(rootPart.updatedAt || parts[partKey]?.updatedAt || Date.now())
            };
        }
    }

    const rootSubtitle = TOP_LEVEL_SUBTITLE_CACHE_FIELDS.reduce((acc, field) => {
        if (Object.prototype.hasOwnProperty.call(cache, field)) acc[field] = cloneData(cache[field]);
        return acc;
    }, {});
    const hasRootSubtitle = Array.isArray(rootSubtitle.rawSubtitle) && rootSubtitle.rawSubtitle.length
        || Array.isArray(rootSubtitle.processedSubtitle) && rootSubtitle.processedSubtitle.length;
    if (!hasRootSubtitle) {
        const latestSubtitlePart = Object.values(parts)
            .filter((part) => (
                Array.isArray(part?.rawSubtitle) && part.rawSubtitle.length
                || Array.isArray(part?.processedSubtitle) && part.processedSubtitle.length
            ))
            .sort((left, right) => Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0))[0];
        if (latestSubtitlePart) {
            TOP_LEVEL_SUBTITLE_CACHE_FIELDS.forEach((field) => {
                if (Object.prototype.hasOwnProperty.call(latestSubtitlePart, field)) {
                    rootSubtitle[field] = cloneData(latestSubtitlePart[field]);
                }
            });
        }
    }

    const subtitleVariants = cache?.subtitleVariants && typeof cache.subtitleVariants === "object"
        ? cloneData(cache.subtitleVariants)
        : {};
    Object.values(parts).forEach((part) => {
        if (!part?.subtitleVariants || typeof part.subtitleVariants !== "object") return;
        Object.assign(subtitleVariants, cloneData(part.subtitleVariants));
    });

    return {
        bvid: normalizedBvid,
        schemaVersion: VIDEO_CACHE_SCHEMA_VERSION,
        ...rootSubtitle,
        subtitleVariants,
        updatedAt: Number(cache?.updatedAt || Date.now()),
        parts
    };
}

function buildDerivedCacheClearPatch(cache = {}) {
    const parts = cache?.parts && typeof cache.parts === "object"
        ? Object.fromEntries(Object.entries(cache.parts).map(([partKey, part]) => [
            partKey,
            {
                ...(part || {}),
                summary: "",
                segments: [],
                rumors: null,
                history: [],
                metrics: [],
                summaryCacheSource: "",
                segmentsCacheSource: "",
                rumorsCacheSource: "",
                summaryModel: "",
                segmentsModel: "",
                rumorsModel: "",
                updatedAt: Date.now()
            }
        ]))
        : undefined;
    return { ...(parts ? { parts } : {}), updatedAt: Date.now() };
}

function compareSemver(left, right) {
    const parse = (value) => String(value || "").trim().replace(/^v/i, "").split(".").map((part) => {
        const num = Number(String(part || "").match(/\d+/)?.[0] || 0);
        return Number.isFinite(num) ? num : 0;
    });
    const a = parse(left);
    const b = parse(right);
    for (let i = 0; i < Math.max(a.length, b.length, 3); i++) {
        const delta = Number(a[i] || 0) - Number(b[i] || 0);
        if (delta !== 0) return delta > 0 ? 1 : -1;
    }
    return 0;
}

function normalizeVersionState(raw = {}) {
    const manifest = chrome.runtime.getManifest();
    const currentVersion = String(manifest?.version || "").trim();
    const latestVersion = String(raw.latestVersion || raw.latest_version || raw.version || "").trim();
    return {
        currentVersion,
        latestVersion,
        hasUpdate: !!latestVersion && compareSemver(latestVersion, currentVersion) > 0,
        releaseUrl: String(raw.releaseUrl || raw.release_url || "").trim(),
        checkedAt: Number(raw.checkedAt || raw.checked_at || 0) || 0
    };
}

async function fetchLatestVersionState(settings) {
    if (!isSupabaseEnabled(settings)) return normalizeVersionState({ checkedAt: Date.now() });
    const table = String(settings.supabaseVersionTable || SUPABASE_DEFAULT_VERSION_TABLE).trim() || SUPABASE_DEFAULT_VERSION_TABLE;
    const rows = await supabaseSelect(settings, table, {
        select: "id,latest_version,version,release_url,enabled",
        id: "eq.bilitato",
        limit: "1"
    }, {
        requestName: "extension_version_fetch",
        errorMessage: "版本信息查询失败"
    });
    const row = Array.isArray(rows) && rows.length ? rows[0] : {};
    if (row?.enabled === false) return normalizeVersionState({ checkedAt: Date.now() });
    return normalizeVersionState({
        latestVersion: row?.latest_version || row?.version || "",
        releaseUrl: row?.release_url || "",
        checkedAt: Date.now()
    });
}

async function getLatestVersionState(settings, { force = false } = {}) {
    const cached = await chrome.storage.local.get([VERSION_CHECK_STORAGE_KEY]);
    const cachedState = normalizeVersionState(cached?.[VERSION_CHECK_STORAGE_KEY] || {});
    const freshEnough = cachedState.checkedAt && Date.now() - cachedState.checkedAt < VERSION_CHECK_INTERVAL_MS;
    if (!force && freshEnough) return cachedState;
    try {
        const nextState = await fetchLatestVersionState(settings);
        await chrome.storage.local.set({ [VERSION_CHECK_STORAGE_KEY]: nextState });
        return nextState;
    } catch (error) {
        logBackground.warn("extension_version_fetch_failed", {
            task: "version",
            error: error?.message || String(error)
        });
        const fallback = {
            ...cachedState,
            checkedAt: cachedState.checkedAt || Date.now()
        };
        return fallback;
    }
}

async function getCloudCacheReadPrefs(bvid, settingsInput = null) {
    const normalizedBvid = normalizeBvid(bvid);
    const settings = settingsInput || await getResolvedSettings();
    const data = await chrome.storage.local.get([CLOUD_READ_DISABLED_BVIDS_KEY]);
    const map = data?.[CLOUD_READ_DISABLED_BVIDS_KEY] && typeof data[CLOUD_READ_DISABLED_BVIDS_KEY] === "object"
        ? data[CLOUD_READ_DISABLED_BVIDS_KEY]
        : {};
    return {
        all: !!settings?.disableCloudCacheRead,
        current: !!(normalizedBvid && map[normalizedBvid])
    };
}

async function shouldSkipCloudCacheRead(bvid, settingsInput = null) {
    const prefs = await getCloudCacheReadPrefs(bvid, settingsInput);
    return !!(prefs.all || prefs.current);
}

function isStorageQuotaError(error) {
    const message = String(error?.message || "");
    return /QUOTA_BYTES|quota exceeded/i.test(message);
}

function buildQuotaSafeCacheFallback(current = {}, merged = {}) {
    const parts = merged?.parts && typeof merged.parts === "object" ? merged.parts : {};
    let changed = false;
    const safeParts = Object.fromEntries(Object.entries(parts).map(([partKey, part]) => {
        const rawSubtitle = Array.isArray(part?.rawSubtitle) ? part.rawSubtitle : [];
        const processedSubtitle = Array.isArray(part?.processedSubtitle) ? part.processedSubtitle : [];
        if (!rawSubtitle.length || !processedSubtitle.length) return [partKey, part];
        changed = true;
        return [partKey, { ...part, processedSubtitle: [], processedHash: "", updatedAt: Date.now() }];
    }));
    const rootRawSubtitle = Array.isArray(merged?.rawSubtitle) ? merged.rawSubtitle : [];
    const rootProcessedSubtitle = Array.isArray(merged?.processedSubtitle) ? merged.processedSubtitle : [];
    const dropRootProcessed = rootRawSubtitle.length > 0 && rootProcessedSubtitle.length > 0;
    if (!changed && !dropRootProcessed) return null;
    return {
        ...merged,
        ...(dropRootProcessed ? { processedSubtitle: [], processedHash: "" } : {}),
        parts: safeParts,
        updatedAt: Date.now()
    };
}

async function mergeCacheByBvid(bvid, patch) {
    const normalized = normalizeBvid(bvid);
    if (!normalized) return {};
    const previous = cacheWriteLocks.get(normalized) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
        const key = `cache_${normalized}`;
        const current = normalizeVideoCacheDirectory(await getCache(normalized), normalized);
        const parts = current.parts && typeof current.parts === "object" ? cloneData(current.parts) : {};
        const patchCid = Object.prototype.hasOwnProperty.call(patch || {}, "cid")
            ? Number(patch?.cid || 0)
            : 0;
        const patchIdentity = resolvePartContext(normalized, {
            cid: patchCid,
            tid: String(patch?.tid || ""),
            partCount: Number(patch?.partCount || 0)
        });
        const subtitleWriteFields = [
            "rawSubtitle", "processedSubtitle", "rawHash", "processedHash",
            "subtitleSource", "subtitleLanguage", "subtitleLanguageLabel", "subtitleUrl"
        ];
        const hasSubtitlePatch = subtitleWriteFields.some((field) => Object.prototype.hasOwnProperty.call(patch || {}, field));
        const rootSubtitlePatch = hasSubtitlePatch
            ? TOP_LEVEL_SUBTITLE_CACHE_FIELDS.reduce((acc, field) => {
                if (Object.prototype.hasOwnProperty.call(patch || {}, field)) acc[field] = cloneData(patch[field]);
                return acc;
            }, {})
            : {};
        const aiFields = ["summary", "summaryDraft", "segments", "rumors", "history"].filter((field) => Object.prototype.hasOwnProperty.call(patch || {}, field));
        if (aiFields.length) {
            logPartScopeDiagnostic("cache_write_target", {
                bvid: normalized,
                patchCid,
                partKey: patchIdentity.partKey,
                aiFields,
                patchSummaryLength: String(patch?.summary || "").length,
                patchSegmentsCount: Array.isArray(patch?.segments) ? patch.segments.length : null,
                patchRumorsPresent: Object.prototype.hasOwnProperty.call(patch || {}, "rumors") ? !!normalizeRumors(patch.rumors) : null,
                patchHistoryCount: Array.isArray(patch?.history) ? patch.history.length : null
            });
        }
        if (patchIdentity.partKey) {
            const partKey = patchIdentity.partKey;
            const currentPart = parts[partKey] && typeof parts[partKey] === "object" ? parts[partKey] : {};
            const partPatch = getPartCacheFields(patch);
            const currentRootCid = Number(current?.cid || 0);
            const inheritedRootSubtitle = (hasSubtitlePatch || patchIdentity.pendingSinglePart)
                && (currentRootCid === 0 || currentRootCid === patchCid)
                ? TOP_LEVEL_SUBTITLE_CACHE_FIELDS.reduce((acc, field) => {
                    if (Object.prototype.hasOwnProperty.call(current, field)) acc[field] = cloneData(current[field]);
                    return acc;
                }, {})
                : {};
            parts[partKey] = {
                ...currentPart,
                ...inheritedRootSubtitle,
                ...partPatch,
                bvid: normalized,
                cid: patchCid,
                ...(patchIdentity.pendingSinglePart ? { pendingSinglePart: true, partCount: 1 } : {}),
                tid: Object.prototype.hasOwnProperty.call(patch, "tid") ? patch.tid : (currentPart.tid || null),
                updatedAt: Number(patch?.updatedAt || Date.now())
            };
            if (patchCid > 0 && Array.isArray(patch?.rawSubtitle) && patch.rawSubtitle.length) {
                const language = String(patch.subtitleLanguage || parts[partKey].subtitleLanguage || "default").trim() || "default";
                const subtitleKey = createSubtitleCacheKey({ bvid: normalized, cid: patchCid, language });
                const variants = current.subtitleVariants && typeof current.subtitleVariants === "object"
                    ? cloneData(current.subtitleVariants)
                    : {};
                variants[subtitleKey] = {
                    bvid: normalized,
                    cid: patchCid,
                    language,
                    languageLabel: String(patch.subtitleLanguageLabel || parts[partKey].subtitleLanguageLabel || language),
                    subtitleUrl: String(patch.subtitleUrl || ""),
                    rawSubtitle: cloneData(patch.rawSubtitle),
                    processedSubtitle: cloneData(Array.isArray(parts[partKey].processedSubtitle) ? parts[partKey].processedSubtitle : []),
                    rawHash: String(parts[partKey].rawHash || ""),
                    processedHash: String(parts[partKey].processedHash || ""),
                    updatedAt: Date.now()
                };
                rootSubtitlePatch.subtitleVariants = variants;
            }
        } else if (patch?.parts && typeof patch.parts === "object") {
            Object.keys(parts).forEach((partKey) => delete parts[partKey]);
            Object.assign(parts, cloneData(patch.parts));
        } else if (!hasSubtitlePatch) {
            throw new Error("写入分 P 缓存时缺少 cid");
        }
        const merged = {
            ...current,
            ...rootSubtitlePatch,
            bvid: normalized,
            schemaVersion: VIDEO_CACHE_SCHEMA_VERSION,
            subtitleVariants: rootSubtitlePatch.subtitleVariants || current.subtitleVariants || {},
            updatedAt: Number(patch?.updatedAt || Date.now()),
            parts
        };
        if (isEqualJSON(current, merged)) {
            cacheMemory.set(normalized, cloneData(merged));
            return merged;
        }
        try {
            await chrome.storage.local.set({ [key]: merged });
            cacheMemory.set(normalized, cloneData(merged));
            logCache.debug("cache_write", { key });
            logCache.info("cache_merge", { key, fields: Object.keys(patch || {}) });
            logBackground.debug("storage_update", { key });
            logCacheDirectorySnapshot(merged, "write");
            return merged;
        } catch (error) {
            if (!isStorageQuotaError(error)) throw error;
            const fallback = buildQuotaSafeCacheFallback(current, merged);
            if (!fallback) throw error;
            await chrome.storage.local.set({ [key]: fallback });
            cacheMemory.set(normalized, cloneData(fallback));
            logCache.warn("cache_write_quota_fallback", {
                key,
                fields: Object.keys(patch || {}),
                dropped_fields: ["processedSubtitle", "processedHash"],
                part_count: Object.keys(fallback.parts || {}).length
            });
            logBackground.warn("storage_quota_fallback", {
                bvid: normalized,
                reason: "drop_processed_subtitle"
            });
            return fallback;
        }
    });
    cacheWriteLocks.set(normalized, next);
    try {
        return await next;
    } finally {
        if (cacheWriteLocks.get(normalized) === next) {
            cacheWriteLocks.delete(normalized);
        }
    }
}

function cloneData(value) {
    if (value == null) return value;
    try {
        return structuredClone(value);
    } catch (_) {
        return JSON.parse(JSON.stringify(value));
    }
}

function isEqualJSON(a, b) {
    try {
        return JSON.stringify(a) === JSON.stringify(b);
    } catch (_) {
        return false;
    }
}

function normalizeSettings(settings, providerCatalog = PROVIDERS) {
    const base = settings && typeof settings === "object" ? { ...settings } : {};
    delete base.remoteConfig;
    delete base.providerCatalog;
    delete base.segmentPromptVariant;
    delete base.customAsrBaseUrl;
    delete base.customAsrApiKey;
    delete base.customAsrModel;
    const customProtocol = String(base.customProtocol || "openai").toLowerCase() === "claude" ? "claude" : "openai";
    const customBaseUrl = ensureHttpsUrlPrefix(base.customBaseUrl);
    const customModel = String(base.customModel || "").trim();
    const provider = String(base.provider || DEFAULT_SETTINGS.provider || "modelscope").trim() || "modelscope";
    const providerApiKeysRaw = base.providerApiKeys && typeof base.providerApiKeys === "object" ? base.providerApiKeys : {};
    const providerApiKeys = Object.fromEntries(Object.entries(providerApiKeysRaw).map(([key, value]) => [
        String(key || "").trim(),
        String(value || "").trim()
    ]).filter(([key]) => key));
    const providerModelsRaw = base.providerModels && typeof base.providerModels === "object" ? base.providerModels : {};
    const providerModels = Object.fromEntries(Object.entries(providerModelsRaw).map(([key, value]) => [
        String(key || "").trim(),
        String(value || "").trim()
    ]).filter(([key]) => key));
    const rawModel = String(base.model || DEFAULT_SETTINGS.model || "").trim();
    const legacyNormalizedModel = provider === "modelscope" && LEGACY_MODELSCOPE_MODELS.has(rawModel)
        ? DEFAULT_SETTINGS.model
        : rawModel;
    if (LEGACY_MODELSCOPE_MODELS.has(String(providerModels.modelscope || "").trim())) {
        providerModels.modelscope = DEFAULT_SETTINGS.model;
    }
    const resolvedProviderModel = resolveProviderScopedModel(provider, {
        ...base,
        model: legacyNormalizedModel,
        providerModels
    }, providerCatalog);
    const model = resolvedProviderModel.model;
    const requestedAsrProvider = String(base.asrProvider || DEFAULT_SETTINGS.asrProvider || "groq").toLowerCase();
    const asrProvider = ["groq", "siliconflow", "mimo"].includes(requestedAsrProvider) ? requestedAsrProvider : "groq";
    const apiKey = String(providerApiKeys[provider] || base.apiKey || "").trim();
    if (apiKey) providerApiKeys[provider] = apiKey;
    const groqApiKey = String(base.groqApiKey || "").trim();
    const groqModel = String(base.groqModel || DEFAULT_SETTINGS.groqModel || "whisper-large-v3-turbo").trim() || "whisper-large-v3-turbo";
    let groqBaseUrl = DEFAULT_GROQ_BASE_URL;
    try {
        groqBaseUrl = normalizeAsrBaseUrl(base.groqBaseUrl, DEFAULT_GROQ_BASE_URL);
    } catch (_) {}
    const siliconFlowApiKey = String(base.siliconFlowApiKey || "").trim();
    const siliconFlowAsrModel = String(base.siliconFlowAsrModel || DEFAULT_SETTINGS.siliconFlowAsrModel || "FunAudioLLM/SenseVoiceSmall").trim() || "FunAudioLLM/SenseVoiceSmall";
    const mimoApiKey = String(base.mimoApiKey || "").trim();
    const mimoAsrModel = MIMO_ASR_MODEL;
    const supabaseUrl = String(base.supabaseUrl || DEFAULT_SETTINGS.supabaseUrl || "").trim().replace(/\/+$/, "");
    const supabaseAnonKey = String(base.supabaseAnonKey || DEFAULT_SETTINGS.supabaseAnonKey || "").trim();
    const supabaseVideoCacheTable = String(base.supabaseVideoCacheTable || DEFAULT_SETTINGS.supabaseVideoCacheTable || SUPABASE_DEFAULT_VIDEO_CACHE_TABLE).trim() || SUPABASE_DEFAULT_VIDEO_CACHE_TABLE;
    const supabaseFeedbackTable = String(base.supabaseFeedbackTable || DEFAULT_SETTINGS.supabaseFeedbackTable || SUPABASE_DEFAULT_FEEDBACK_TABLE).trim() || SUPABASE_DEFAULT_FEEDBACK_TABLE;
    const supabaseUsageDailyRpcName = String(base.supabaseUsageDailyRpcName || DEFAULT_SETTINGS.supabaseUsageDailyRpcName || SUPABASE_DEFAULT_USAGE_DAILY_RPC).trim() || SUPABASE_DEFAULT_USAGE_DAILY_RPC;
    const supabaseVersionTable = String(base.supabaseVersionTable || DEFAULT_SETTINGS.supabaseVersionTable || SUPABASE_DEFAULT_VERSION_TABLE).trim() || SUPABASE_DEFAULT_VERSION_TABLE;
    const prefModeRaw = String(base.prefMode || DEFAULT_SETTINGS.prefMode || "quality").toLowerCase();
    const prefMode = prefModeRaw === "efficiency" ? "efficiency" : "quality";
    const themeModeRaw = String(base.themeMode || DEFAULT_SETTINGS.themeMode || "system").toLowerCase();
    const themeMode = ["system", "light", "dark"].includes(themeModeRaw) ? themeModeRaw : "system";
    const pluginDisplayFallback = Object.keys(base).length > 0 ? "expanded" : DEFAULT_SETTINGS.pluginDisplayMode;
    const pluginDisplayMode = String(base.pluginDisplayMode || pluginDisplayFallback || "collapsed").toLowerCase() === "collapsed"
        ? "collapsed"
        : "expanded";
    const pluginDisplayFeatureSeen = Object.prototype.hasOwnProperty.call(base, "pluginDisplayFeatureSeen")
        ? !!base.pluginDisplayFeatureSeen
        : Object.keys(base).length === 0;
    const storedSentryDsn = String(base.sentryDsn || "").trim();
    const sentryDsn = !storedSentryDsn || LEGACY_SENTRY_DSNS.has(storedSentryDsn)
        ? DEFAULT_SENTRY_DSN
        : storedSentryDsn;
    const sentryEnabled = Object.prototype.hasOwnProperty.call(base, "sentryEnabled")
        ? !!base.sentryEnabled
        : !!DEFAULT_SETTINGS.sentryEnabled;
    const disableCloudCacheRead = Object.prototype.hasOwnProperty.call(base, "disableCloudCacheRead")
        ? !!base.disableCloudCacheRead
        : !!DEFAULT_SETTINGS.disableCloudCacheRead;
    return {
        ...DEFAULT_SETTINGS,
        ...base,
        provider,
        debugMode: !!base.debugMode,
        apiKey,
        providerApiKeys,
        providerModels: resolvedProviderModel.providerModels,
        model,
        sentryEnabled,
        sentryDsn,
        customBaseUrl,
        customProtocol,
        customModel,
        asrProvider,
        groqApiKey,
        groqModel,
        groqBaseUrl,
        siliconFlowApiKey,
        siliconFlowAsrModel,
        mimoApiKey,
        mimoAsrModel,
        supabaseUrl,
        supabaseAnonKey,
        supabaseVideoCacheTable,
        supabaseFeedbackTable,
        supabaseUsageDailyRpcName,
        supabaseVersionTable,
        themeMode,
        prefMode,
        pluginDisplayMode,
        pluginDisplayFeatureSeen,
        disableCloudCacheRead
    };
}

function hasTaskResult(cache, task) {
    if (!cache || typeof cache !== "object") return false;
    if (task === "subtitle") {
        return (Array.isArray(cache.rawSubtitle) && cache.rawSubtitle.length > 0)
            || (Array.isArray(cache.processedSubtitle) && cache.processedSubtitle.length > 0);
    }
    if (task === "summary") return !!String(cache.summary || "").trim();
    if (task === "segments") return Array.isArray(cache.segments) && cache.segments.length > 0;
    if (task === "rumors") return !!normalizeRumors(cache.rumors);
    return false;
}

function getTaskModelName(settings) {
    const configured = String(settings?.model || "").trim();
    if (configured) return configured;
    const provider = settings?.providerCatalog?.[settings?.provider] || PROVIDERS[settings?.provider] || {};
    return String(provider.model || "").trim();
}

function buildCloudSelectColumns(tasks) {
    const columns = new Set(["bvid", "cid", "updated_at"]);
    (Array.isArray(tasks) ? tasks : []).forEach((task) => {
        if (task === "subtitle") {
            [
                "title",
                "subtitle_source",
                "raw_subtitle",
                "processed_subtitle",
                "subtitle_upload_count",
                "subtitle_uploaded_at"
            ].forEach((field) => columns.add(field));
            return;
        }
        (CLOUD_TASK_FIELD_MAP[task] || []).forEach((field) => columns.add(field));
    });
    return [...columns];
}

function buildCloudPatchFromRow(row, tasks) {
    const patch = {
        cloudUpdatedAt: String(row?.updated_at || "").trim()
    };
    (Array.isArray(tasks) ? tasks : []).forEach((task) => {
        if (task === "subtitle") {
            const rawSubtitle = normalizeRawSubtitle(Array.isArray(row?.raw_subtitle) ? row.raw_subtitle : []);
            const processedSubtitle = normalizeRawSubtitle(Array.isArray(row?.processed_subtitle) ? row.processed_subtitle : []);
            if (!rawSubtitle.length && !processedSubtitle.length) return;
            patch.title = String(row?.title || "");
            patch.rawSubtitle = rawSubtitle;
            patch.processedSubtitle = processedSubtitle;
            patch.rawHash = makeSubtitleHash(rawSubtitle);
            patch.processedHash = makeSubtitleHash(processedSubtitle);
            patch.subtitleSource = String(row?.subtitle_source || "");
            patch.subtitleUploadCount = Math.max(0, Number(row?.subtitle_upload_count || 0));
            patch.subtitleUploadedAt = String(row?.subtitle_uploaded_at || "");
            return;
        }
        if (task === "summary") {
            const summary = String(row?.summary || "").trim();
            if (!summary) return;
            patch.summary = summary;
            patch.summaryModel = String(row?.summary_model || "");
            patch.summaryUpvotes = Number(row?.summary_upvotes || 0);
            patch.summaryDownvotes = Number(row?.summary_downvotes || 0);
            return;
        }
        if (task === "segments") {
            const segments = normalizeSegments(row?.segments);
            if (!segments.length) return;
            patch.segments = segments;
            patch.segmentsModel = String(row?.segments_model || "");
            patch.segmentsUpvotes = Number(row?.segments_upvotes || 0);
            patch.segmentsDownvotes = Number(row?.segments_downvotes || 0);
            return;
        }
        if (task === "rumors") {
            const rumors = normalizeRumors(row?.rumors);
            if (!rumors) return;
            patch.rumors = rumors;
            patch.rumorsModel = String(row?.rumors_model || "");
            patch.rumorsUpvotes = Number(row?.rumors_upvotes || 0);
            patch.rumorsDownvotes = Number(row?.rumors_downvotes || 0);
        }
    });
    return patch;
}

function buildTaskSourcePatch(tasks, source) {
    const patch = {};
    (Array.isArray(tasks) ? tasks : []).forEach((task) => {
        if (task === "subtitle") patch.subtitleCacheSource = source;
        if (task === "summary") patch.summaryCacheSource = source;
        if (task === "segments") patch.segmentsCacheSource = source;
        if (task === "rumors") patch.rumorsCacheSource = source;
    });
    return patch;
}

function buildCloudPartFilter(bvid, partContext = {}) {
    const identity = resolvePartContext(bvid, partContext);
    return {
        identity,
        params: {
            bvid: `eq.${identity.bvid}`,
            cid: identity.cid > 0 ? `eq.${identity.cid}` : "is.null"
        }
    };
}

async function fetchCloudVideoCacheRow(bvid, tasks, settings, partContext = {}) {
    if (!isSupabaseEnabled(settings)) return null;
    const { identity, params } = buildCloudPartFilter(bvid, partContext);
    const allowPendingSinglePartCid = !(identity.cid > 0) && identity.partCount === 1 && !identity.tid;
    if (!identity.bvid || (!(identity.cid > 0) && !allowPendingSinglePartCid)) return null;
    logPartScopeDiagnostic("cloud_read_query", {
        bvid: identity.bvid,
        cid: identity.cid || null,
        partCount: identity.partCount,
        partKey: identity.partKey,
        tasks,
        filters: params
    });
    const table = settings.supabaseVideoCacheTable || SUPABASE_DEFAULT_VIDEO_CACHE_TABLE;
    const select = buildCloudSelectColumns(tasks).join(",");
    let rows = await supabaseSelect(settings, table, {
        select,
        ...(allowPendingSinglePartCid ? {
            bvid: `eq.${identity.bvid}`,
            cid: "not.is.null",
            order: "updated_at.desc"
        } : params),
        limit: "1"
    }, {
        requestName: "cloud_video_cache_fetch",
        errorMessage: "Supabase 查询失败"
    });
    let source = allowPendingSinglePartCid ? "single_part_latest_cid" : "exact_cid";
    if ((!Array.isArray(rows) || !rows.length) && identity.partCount === 1) {
        source = "legacy_bvid";
        logPartScopeDiagnostic("cloud_read_legacy_fallback", {
            bvid: identity.bvid,
            requestedCid: identity.cid,
            partCount: identity.partCount,
            tasks
        });
        rows = await supabaseSelect(settings, table, {
            select,
            bvid: `eq.${identity.bvid}`,
            cid: "is.null",
            limit: "1"
        }, {
            requestName: "cloud_video_cache_legacy_fetch",
            errorMessage: "Supabase 旧缓存查询失败"
        });
    }
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    logPartScopeDiagnostic("cloud_read_result", {
        bvid: identity.bvid,
        requestedCid: identity.cid || null,
        returnedCid: Number(row?.cid || 0) || null,
        matched: !!row,
        source,
        partCount: identity.partCount,
        tasks,
        ...(row ? buildPartScopeCacheMeta(buildCloudPatchFromRow(row, tasks)) : {})
    });
    return row;
}

async function hydrateCloudCacheIfNeeded(bvid, tasks, settings, partContext = {}) {
    const identity = resolvePartContext(bvid, partContext);
    const allowPendingSinglePartCid = !(identity.cid > 0) && identity.partCount === 1 && !identity.tid;
    if (!(identity.cid > 0) && !allowPendingSinglePartCid) {
        logPartScopeDiagnostic("cloud_hydrate_deferred", {
            bvid: identity.bvid,
            reason: "route_cid_pending",
            requestedTasks: Array.isArray(tasks) ? tasks : []
        }, `hydrate-deferred:${identity.bvid}`);
        return { hydratedTasks: [], cache: null };
    }
    const rawCache = await getCache(bvid);
    const current = selectCachePart(rawCache, identity) || {};
    if (!isSupabaseEnabled(settings)) return { hydratedTasks: [], cache: current };
    if (await shouldSkipCloudCacheRead(bvid, settings)) return { hydratedTasks: [], cache: current };
    const requestedTasks = Array.isArray(tasks) ? tasks : [];
    const missingTasks = requestedTasks.filter((task) => !hasTaskResult(current, task));
    logPartScopeDiagnostic("cloud_hydrate_decision", {
        bvid: identity.bvid,
        cid: identity.cid || null,
        partCount: identity.partCount,
        partKey: identity.partKey,
        requestedTasks,
        missingTasks,
        ...buildPartScopeCacheMeta(current)
    }, `hydrate:${identity.partKey || identity.bvid}:${requestedTasks.join(",")}`);
    if (!missingTasks.length) return { hydratedTasks: [], cache: current };
    try {
        const row = await fetchCloudVideoCacheRow(bvid, missingTasks, settings, identity);
        if (!row) return { hydratedTasks: [], cache: current };
        const patch = buildCloudPatchFromRow(row, missingTasks);
        const hydratedTasks = missingTasks.filter((task) => hasTaskResult(patch, task));
        if (!hydratedTasks.length) return { hydratedTasks: [], cache: current };
        const resolvedCid = Number(row?.cid || identity.cid || 0);
        await mergeCacheByBvid(bvid, {
            ...(resolvedCid > 0 ? { cid: resolvedCid } : {}),
            ...(identity.tid ? { tid: identity.tid } : {}),
            ...patch,
            ...buildTaskSourcePatch(hydratedTasks, "cloud"),
            cloudSyncedAt: Date.now(),
            updatedAt: Date.now()
        });
        logCache.info("cloud_cache_backfill", { bvid: normalizeBvid(bvid), tasks: hydratedTasks });
        const latest = await getCache(bvid);
        return {
            hydratedTasks,
            cache: selectCachePart(latest, {
                ...identity,
                cid: resolvedCid
            }) || {}
        };
    } catch (error) {
        logBackground.error("cloud_cache_fetch_fail", {
            bvid: normalizeBvid(bvid),
            tasks: missingTasks,
            error: error.message || "cloud fetch failed"
        });
        return { hydratedTasks: [], cache: current };
    }
}

function buildSupabaseVideoPatch(bvid, settings, patch, partContext = {}) {
    const row = { bvid: normalizeBvid(bvid) };
    const identity = resolvePartContext(bvid, partContext);
    if (identity.cid > 0) row.cid = identity.cid;
    const modelName = getTaskModelName(settings);
    if (Object.prototype.hasOwnProperty.call(patch, "title")) {
        const title = String(patch.title || "").trim();
        if (title) row.title = title;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "rawSubtitle")) {
        row.raw_subtitle = normalizeRawSubtitle(Array.isArray(patch.rawSubtitle) ? patch.rawSubtitle : []);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "processedSubtitle")) {
        row.processed_subtitle = normalizeRawSubtitle(Array.isArray(patch.processedSubtitle) ? patch.processedSubtitle : []);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "subtitleSource")) {
        row.subtitle_source = String(patch.subtitleSource || "");
    }
    if (Object.prototype.hasOwnProperty.call(patch, "subtitleUploadedAt")) {
        row.subtitle_uploaded_at = String(patch.subtitleUploadedAt || "");
    }
    if (Object.prototype.hasOwnProperty.call(patch, "summary")) {
        row.summary = String(patch.summary || "");
        row.summary_model = modelName;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "segments")) {
        row.segments = Array.isArray(patch.segments) ? patch.segments : [];
        row.segments_model = modelName;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "rumors")) {
        row.rumors = patch.rumors && typeof patch.rumors === "object" ? JSON.stringify(patch.rumors) : null;
        row.rumors_model = modelName;
    }
    return row;
}

function hasEnoughSubtitleRows(list, minRows = 10) {
    return Array.isArray(list) && list.length >= minRows;
}

function hasEnoughSummaryText(text, minLength = 100) {
    return String(text || "").trim().length >= minLength;
}

function hasEnoughSegments(list, minCount = 3) {
    return Array.isArray(list) && list.length >= minCount;
}

function hasEnoughRumorsContent(value, minLength = 100) {
    if (!value || typeof value !== "object") return false;
    return String(JSON.stringify(value) || "").length >= minLength;
}

function filterCloudFeaturePatch(patch) {
    const next = {};
    if (Object.prototype.hasOwnProperty.call(patch, "summary") && hasEnoughSummaryText(patch.summary)) {
        next.summary = patch.summary;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "segments") && hasEnoughSegments(patch.segments)) {
        next.segments = patch.segments;
    }
    if (Object.prototype.hasOwnProperty.call(patch, "rumors") && hasEnoughRumorsContent(patch.rumors)) {
        next.rumors = patch.rumors;
    }
    return next;
}

function getVideoCacheUploadFields(row) {
    return Object.keys(row || {}).filter((key) => key !== "bvid" && key !== "cid" && key !== "updated_at");
}

async function saveVideoCacheRow(bvid, settings, row) {
    const normalizedBvid = normalizeBvid(bvid);
    if (!isSupabaseEnabled(settings) || !normalizedBvid || !row || typeof row !== "object") return false;
    const rowCid = Number(row?.cid || 0);
    const fields = getVideoCacheUploadFields(row);
    logCache.info("cloud_cache_upload_start", {
        task: "cloud",
        bvid: normalizedBvid,
        detail: {
            rpc: "upsert_video_cache_controlled",
            fields
        }
    });
    logPartScopeDiagnostic("cloud_write_target", {
        bvid: normalizedBvid,
        cid: rowCid || null,
        partKey: createVideoCachePartKey(normalizedBvid, rowCid),
        method: "RPC",
        fields
    });
    try {
        await supabaseRpc(settings, "upsert_video_cache_controlled", { p_payload: { ...row, bvid: normalizedBvid } }, {
            requestName: "video_cache_controlled_upsert",
            errorMessage: "video_cache 受控写入失败"
        });
        logCache.info("cloud_cache_upload_success", {
            task: "cloud",
            bvid: normalizedBvid,
            detail: {
                rpc: "upsert_video_cache_controlled",
                fields
            }
        });
    } catch (error) {
        logBackground.error("cloud_cache_upload_failed", {
            task: "cloud",
            bvid: normalizedBvid,
            code: "SUPABASE_VIDEO_CACHE_UPLOAD_FAILED",
            detail: {
                rpc: "upsert_video_cache_controlled",
                fields,
                error_message: error.message || "video_cache upload failed"
            }
        });
        throw error;
    }
    return true;
}

async function persistCloudSubtitlePatch(bvid, settings, cache, extra = {}) {
    if (!isSupabaseEnabled(settings)) return false;
    const identity = resolvePartContext(bvid, {
        cid: Number(extra?.cid || cache?.cid || 0),
        tid: String(extra?.tid || cache?.tid || "")
    });
    if (!identity.bvid || !(identity.cid > 0)) return false;
    const partCache = selectCachePart(cache, identity);
    if (!partCache) return false;
    const rawSubtitle = Array.isArray(partCache?.rawSubtitle) ? partCache.rawSubtitle : [];
    const processedSubtitle = Array.isArray(partCache?.processedSubtitle) ? partCache.processedSubtitle : [];
    const subtitleSource = String(extra.subtitleSource || partCache?.subtitleSource || "");
    const minRows = isAsrSubtitleSource(subtitleSource) ? 1 : 10;
    if (!hasEnoughSubtitleRows(rawSubtitle, minRows) || !hasEnoughSubtitleRows(processedSubtitle, minRows)) {
        logCache.info("cloud_subtitle_skip", {
            bvid: identity.bvid,
            cid: identity.cid,
            raw_count: rawSubtitle.length,
            processed_count: processedSubtitle.length,
            reason: "subtitle_too_short",
            subtitle_source: subtitleSource,
            min_rows: minRows
        });
        return false;
    }
    try {
        const row = buildSupabaseVideoPatch(identity.bvid, settings, {
            title: String(extra.title || partCache?.title || ""),
            rawSubtitle,
            processedSubtitle,
            subtitleSource,
            subtitleUploadedAt: new Date().toISOString()
        }, identity);
        row.increment_subtitle_upload_count = true;
        const meaningfulKeys = getVideoCacheUploadFields(row);
        if (!meaningfulKeys.length) return false;
        logCache.info("cloud_subtitle_write_start", {
            task: "cloud",
            bvid: identity.bvid,
            cid: identity.cid,
            detail: {
                fields: meaningfulKeys,
                raw_count: rawSubtitle.length,
                processed_count: processedSubtitle.length,
                subtitle_source: subtitleSource,
                increment_upload_count: true
            }
        });
        await saveVideoCacheRow(identity.bvid, settings, row);
        logCache.info("cloud_subtitle_write", {
            task: "cloud",
            bvid: identity.bvid,
            cid: identity.cid,
            detail: {
                fields: meaningfulKeys,
                raw_count: rawSubtitle.length,
                processed_count: processedSubtitle.length,
                subtitle_source: subtitleSource,
                increment_upload_count: true
            }
        });
        return true;
    } catch (error) {
        logBackground.error("cloud_subtitle_write_fail", {
            bvid: identity.bvid,
            cid: identity.cid,
            error: error.message || "cloud subtitle write failed"
        });
        return false;
    }
}

async function persistCloudFeaturePatch(bvid, settings, patch, partContext = {}) {
    if (!isSupabaseEnabled(settings)) return false;
    const identity = resolvePartContext(bvid, partContext);
    if (!identity.bvid || !(identity.cid > 0)) return false;
    const filteredPatch = filterCloudFeaturePatch(patch || {});
    const rawCache = await getCache(bvid);
    const cache = getPartCacheForContext(rawCache, bvid, identity) || {};
    const title = String(cache?.title || "").trim();
    const row = buildSupabaseVideoPatch(bvid, settings, {
        ...filteredPatch,
        ...(title ? { title } : {})
    }, identity);
    Object.keys(filteredPatch).forEach((task) => {
        if (["summary", "segments", "rumors"].includes(task)) {
            row[`increment_${task}_call_count`] = true;
        }
    });
    const meaningfulKeys = getVideoCacheUploadFields(row);
    if (!row.bvid || !meaningfulKeys.length) {
        logCache.info("cloud_cache_skip", {
            bvid: normalizeBvid(bvid),
            fields: Object.keys(patch || {}),
            reason: "content_too_short"
        });
        return false;
    }
    try {
        logCache.info("cloud_feature_write_start", {
            task: "cloud",
            bvid: row.bvid,
            cid: identity.cid,
            detail: {
                fields: meaningfulKeys,
                feature_fields: Object.keys(filteredPatch)
            }
        });
        await saveVideoCacheRow(row.bvid, settings, row);
        logCache.info("cloud_cache_write", {
            task: "cloud",
            bvid: row.bvid,
            cid: identity.cid,
            detail: {
                fields: meaningfulKeys,
                feature_fields: Object.keys(filteredPatch)
            }
        });
        return true;
    } catch (error) {
        logBackground.error("cloud_cache_write_fail", {
            bvid: row.bvid,
            cid: identity.cid,
            fields: meaningfulKeys,
            error: error.message || "cloud write failed"
        });
        return false;
    }
}

async function getOrCreateAnonymousUserId() {
    const { anonymousUserId } = await chrome.storage.local.get(["anonymousUserId"]);
    const existing = String(anonymousUserId || "").trim();
    if (existing) return existing;
    const created = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await chrome.storage.local.set({ anonymousUserId: created });
    return created;
}

function normalizeUsageTitle(value) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, 200);
}

async function getUsageVideoContext(bvid, metrics = {}) {
    const normalizedBvid = normalizeBvid(bvid || metrics?.bvid || "");
    let title = normalizeUsageTitle(metrics?.title || "");
    if (normalizedBvid && !title) {
        try {
            const directory = await getCache(normalizedBvid);
            const cache = selectCachePart(directory, { bvid: normalizedBvid, cid: Number(metrics?.cid || 0) });
            title = normalizeUsageTitle(cache?.title || "");
        } catch (_) {}
    }
    return {
        bvid: normalizedBvid,
        title
    };
}

function shouldRetryUsageDailyLegacy(error) {
    const text = `${error?.message || ""}\n${error?.responseText || ""}`;
    if (!text) return false;
    return /Could not find the function|schema cache|PGRST202|parameter|v_bvid|v_title/i.test(text);
}

async function reportFeatureUsage(featureName, bvid, settings, metrics) {
    if (!isSupabaseEnabled(settings)) return false;
    const tokenCount = Math.max(0, Number(metrics?.tokens || 0));
    const normalizedFeature = String(featureName || "").trim();
    if (!normalizedFeature) return false;
    try {
        const usageContext = await getUsageVideoContext(bvid, metrics);
        reportDailyFeatureUsage(normalizedFeature, settings, metrics, "success", "", usageContext);
        logAI.debug("usage_report_queued", {
            feature: normalizedFeature,
            bvid: normalizeBvid(bvid),
            tokens: tokenCount
        });
        return true;
    } catch (error) {
        logBackground.error("usage_report_fail", {
            feature: String(featureName || ""),
            bvid: normalizeBvid(bvid),
            error: error.message || "usage report failed"
        });
        return false;
    }
}

async function promotePendingSinglePartTaskState(tabId, bvid, cid) {
    const pendingKey = createVideoCachePartKeyForContext(bvid, { cid: 0, partCount: 1, tid: "" });
    const resolvedKey = createVideoCachePartKey(bvid, cid);
    const current = await getTabState(tabId);
    const pendingState = pendingKey && current?.taskStateByPart?.[pendingKey];
    if (!pendingState || !resolvedKey) return false;
    const taskStateByPart = { ...(current.taskStateByPart || {}), [resolvedKey]: cloneData(pendingState) };
    delete taskStateByPart[pendingKey];
    await updateTabState(tabId, { taskStateByPart, ...pendingState, updatedAt: Date.now() });
    return true;
}

async function promotePendingSinglePartCache(bvid, cid) {
    const normalizedBvid = normalizeBvid(bvid);
    const resolvedCid = Number(cid || 0);
    if (!normalizedBvid || !(resolvedCid > 0)) return false;
    const directory = await getCache(normalizedBvid);
    const parts = directory?.parts && typeof directory.parts === "object" ? cloneData(directory.parts) : {};
    const pendingKey = `${normalizedBvid}::${SINGLE_PART_PENDING_SUFFIX}`;
    const resolvedKey = createVideoCachePartKey(normalizedBvid, resolvedCid);
    const pendingPart = parts[pendingKey];
    if (!pendingPart || !resolvedKey) return false;
    const resolvedPart = parts[resolvedKey] && typeof parts[resolvedKey] === "object" ? parts[resolvedKey] : {};
    const promotedPart = { ...cloneData(pendingPart), ...cloneData(resolvedPart), bvid: normalizedBvid, cid: resolvedCid };
    DERIVED_PART_CACHE_FIELDS.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(pendingPart, field)) promotedPart[field] = cloneData(pendingPart[field]);
    });
    delete promotedPart.pendingSinglePart;
    delete promotedPart.partCount;
    parts[resolvedKey] = promotedPart;
    delete parts[pendingKey];
    await mergeCacheByBvid(normalizedBvid, { parts, updatedAt: Date.now() });
    return true;
}

async function promotePendingSinglePartCacheForTab(bvid, tabId) {
    if (!tabId) return false;
    const tabState = await getTabState(tabId).catch(() => null);
    if (normalizeBvid(tabState?.activeBvid || "") !== normalizeBvid(bvid)
        || !(Number(tabState?.activeCid || 0) > 0)
        || Number(tabState?.activePartCount || 0) !== 1
        || String(tabState?.activeTid || "").trim()) return false;
    return promotePendingSinglePartCache(bvid, Number(tabState.activeCid));
}

function normalizeSummaryDraft(value, now = Date.now()) {
    if (!value || typeof value !== "object") return null;
    const text = String(value.text || "").trim();
    const updatedAt = Number(value.updatedAt || 0);
    if (!text || !updatedAt || now - updatedAt >= SUMMARY_DRAFT_TTL_MS) return null;
    return {
        taskId: String(value.taskId || ""),
        attempt: Math.max(1, Math.floor(Number(value.attempt || 1))),
        text,
        updatedAt
    };
}

function reportDailyFeatureUsage(featureName, settings, metrics = {}, status = "success", errorCode = "", usageContext = {}) {
    void sendDailyFeatureUsage(featureName, settings, metrics, status, errorCode, usageContext).catch((error) => {
        logBackground.warn("usage_daily_queue_failed", {
            task: "usage",
            code: error?.code || "USAGE_DAILY_QUEUE_FAILED",
            detail: { message: error?.message || "daily usage queue failed" }
        });
    });
    return true;
}

async function sendDailyFeatureUsage(featureName, settings, metrics = {}, status = "success", errorCode = "", usageContext = {}) {
    if (!isSupabaseEnabled(settings)) return false;
    if (!await hasTechnicalDataConsent()) return false;
    const normalizedFeature = String(featureName || "").trim();
    if (!normalizedFeature) return false;
    try {
        const manifest = chrome.runtime.getManifest();
        const userId = await getOrCreateAnonymousUserId();
        const normalizedContext = await getUsageVideoContext(usageContext?.bvid || metrics?.bvid || "", {
            title: usageContext?.title || metrics?.title || ""
        });
        const rpcName = settings.supabaseUsageDailyRpcName || SUPABASE_DEFAULT_USAGE_DAILY_RPC;
        const legacyPayload = {
            f_name: normalizedFeature,
            f_status: String(status || "success"),
            e_code: String(errorCode || ""),
            p_provider: String(metrics?.provider || settings.provider || ""),
            p_model: String(metrics?.model || getTaskModelName(settings) || settings.model || ""),
            ext_version: String(manifest.version || ""),
            t_count: Math.max(0, Number(metrics?.tokens || 0)),
            d_ms: Math.max(0, Number(metrics?.latencyMs || metrics?.durationMs || 0)),
            u_id: userId
        };
        const nextPayload = {
            ...legacyPayload,
            v_bvid: normalizedContext.bvid,
            v_title: normalizedContext.title
        };
        logAI.info("usage_daily_report_start", {
            task: "usage",
            bvid: normalizedContext.bvid,
            detail: {
                feature: normalizedFeature,
                status: String(status || "success"),
                error_code: String(errorCode || ""),
                provider: legacyPayload.p_provider,
                model: legacyPayload.p_model,
                extension_version: legacyPayload.ext_version,
                title: normalizedContext.title,
                tokens: legacyPayload.t_count,
                duration_ms: legacyPayload.d_ms
            }
        });
        try {
            await supabaseRpc(settings, rpcName, nextPayload, {
                requestName: "usage_daily_report",
                errorMessage: "Supabase daily usage RPC 失败"
            });
        } catch (error) {
            if (!shouldRetryUsageDailyLegacy(error)) throw error;
            await supabaseRpc(settings, rpcName, legacyPayload, {
                requestName: "usage_daily_report_legacy",
                errorMessage: "Supabase daily usage legacy RPC 失败"
            });
            logBackground.warn("usage_daily_legacy_payload", {
                task: "usage",
                bvid: normalizedContext.bvid,
                detail: {
                    feature: normalizedFeature,
                    reason: "rpc_schema_not_upgraded"
                }
            });
        }
        logAI.info("usage_daily_reported", {
            task: "usage",
            bvid: normalizedContext.bvid,
            detail: {
                feature: normalizedFeature,
                status: String(status || "success"),
                error_code: String(errorCode || ""),
                provider: legacyPayload.p_provider,
                model: legacyPayload.p_model,
                extension_version: legacyPayload.ext_version,
                title: normalizedContext.title,
                tokens: Math.max(0, Number(metrics?.tokens || 0)),
                duration_ms: legacyPayload.d_ms
            }
        });
        return true;
    } catch (error) {
        logBackground.error("usage_daily_report_fail", {
            task: "usage",
            code: "USAGE_DAILY_REPORT_FAILED",
            bvid: normalizeBvid(usageContext?.bvid || metrics?.bvid || ""),
            detail: {
                feature: normalizedFeature,
                status: String(status || "success"),
                error_code: String(errorCode || ""),
                error_message: error.message || "daily usage report failed"
            }
        });
        return false;
    }
}

async function getPromptSettingsFromSync() {
    const { promptSettings } = await chrome.storage.sync.get(["promptSettings"]);
    return normalizePromptSettings(promptSettings || DEFAULT_PROMPT_SETTINGS);
}

function withPromptSettings(settings, promptSettings) {
    const normalizedPromptSettings = normalizePromptSettings(promptSettings);
    return {
        ...settings,
        promptSettings: normalizedPromptSettings,
        prompts: {
            summary: normalizedPromptSettings.custom.summary,
            segments: normalizedPromptSettings.custom.segments,
            rumors: normalizedPromptSettings.custom.rumors
        }
    };
}

async function getResolvedSettings() {
    const remoteConfig = await ensureRemoteConfigLoaded();
    const { settings } = await chrome.storage.local.get(["settings"]);
    const provider = String(settings?.provider || DEFAULT_SETTINGS.provider || "modelscope").trim() || "modelscope";
    const providerCatalog = buildEffectiveProviderCatalog(PROVIDERS, remoteConfig, provider);
    const normalizedSettings = normalizeSettings(settings, providerCatalog);
    const storedProviderModel = String(settings?.providerModels?.[provider] || "").trim();
    if (String(settings?.model || "").trim() !== normalizedSettings.model
        || storedProviderModel !== String(normalizedSettings.providerModels?.[provider] || "").trim()) {
        await chrome.storage.local.set({ settings: normalizedSettings });
        logBackground.info("storage_update", {
            source: "provider_model_repair",
            provider,
            model: normalizedSettings.model
        });
    }
    const { promptSettings } = await chrome.storage.sync.get(["promptSettings"]);
    let normalizedPromptSettings = normalizePromptSettings(promptSettings || DEFAULT_PROMPT_SETTINGS);
    if (!promptSettings && settings?.prompts && typeof settings.prompts === "object") {
        normalizedPromptSettings = normalizePromptSettings({
            mode: "custom",
            guided: DEFAULT_PROMPT_SETTINGS.guided,
            custom: settings.prompts
        });
        await chrome.storage.sync.set({ promptSettings: normalizedPromptSettings });
    }
    return withPromptSettings({
        ...normalizedSettings,
        remoteConfig,
        providerCatalog
    }, normalizedPromptSettings);
}

function logAIPromptBuilt({ bvid, task, provider, mode, prompt, promptSettings }) {
    const text = String(prompt || "");
    const promptMeta = summarizePromptSettings(promptSettings);
    const safePromptMeta = {
        setting_mode: promptMeta.prompt_mode,
        tone: promptMeta.tone,
        detail_level: promptMeta.detail_level,
        custom_enabled: promptMeta.custom_prompt_enabled,
        custom_summary_chars: promptMeta.custom_summary_prompt_chars,
        custom_segments_chars: promptMeta.custom_segments_prompt_chars,
        custom_rumors_chars: promptMeta.custom_rumors_prompt_chars
    };
    logAI.info("ai_prompt_built", {
        bvid,
        task,
        provider,
        mode,
        detail: {
            prompt_chars: text.length,
            ...promptMeta
        }
    });
    logAI.info("ai_request_text_built", {
        bvid,
        task,
        provider,
        mode,
        detail: {
            request_chars: text.length,
            ...safePromptMeta
        }
    });
    if (!currentDebugMode) return;
    const chunkSize = 260;
    const chunks = [];
    for (let index = 0; index < text.length; index += chunkSize) {
        chunks.push(text.slice(index, index + chunkSize));
    }
    const total = Math.max(1, chunks.length);
    (chunks.length ? chunks : [""]).forEach((chunk, index) => {
        logAI.info("ai_request_text_chunk", {
            bvid,
            task,
            provider,
            mode,
            detail: {
                chunk_index: index + 1,
                chunk_total: total,
                chars_total: text.length,
                chunk_text: chunk
            }
        });
    });
}

function logAIResponseText({ provider, model, durationMs, text }) {
    const source = String(text || "");
    logAI.info("ai_response_text_built", {
        provider,
        model,
        duration_ms: durationMs,
        detail: {
            response_chars: source.length
        }
    });
    const chunkSize = 260;
    const chunks = [];
    for (let index = 0; index < source.length; index += chunkSize) {
        chunks.push(source.slice(index, index + chunkSize));
    }
    const total = Math.max(1, chunks.length);
    (chunks.length ? chunks : [""]).forEach((chunk, index) => {
        logAI.info("ai_response_text_chunk", {
            provider,
            model,
            duration_ms: durationMs,
            detail: {
                chunk_index: index + 1,
                chunk_total: total,
                chars_total: source.length,
                reply_chunk: chunk
            }
        });
    });
}

function summarizePromptSettings(promptSettings = {}) {
    const normalized = normalizePromptSettings(promptSettings || {});
    const mode = normalized.mode === "custom" ? "custom" : "guided";
    const custom = normalized.custom || {};
    return {
        prompt_mode: mode,
        tone: normalized.guided?.tone || "",
        detail_level: normalized.guided?.detail || "",
        custom_prompt_enabled: mode === "custom",
        custom_summary_prompt_chars: String(custom.summary || "").length,
        custom_segments_prompt_chars: String(custom.segments || "").length,
        custom_rumors_prompt_chars: String(custom.rumors || "").length
    };
}

function pushGlobalLog(entry) {
    if (!entry || typeof entry !== "object") return;
    globalLogs.push(entry);
    if (globalLogs.length > MAX_LOGS) {
        globalLogs.splice(0, globalLogs.length - MAX_LOGS);
    }
}

async function syncDebugModeFromStorage() {
    try {
        const { settings } = await chrome.storage.local.get(["settings"]);
        const normalized = normalizeSettings(settings);
        currentDebugMode = !!normalized.debugMode;
        syncRuntimeDebugFlag(currentDebugMode);
    } catch (_) {}
}
