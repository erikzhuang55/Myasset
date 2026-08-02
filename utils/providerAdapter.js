import { createAppError, createHttpError } from "./appError.js";

export const PROVIDERS = {
    modelscope: {
        name: "ModelScope (魔搭)",
        baseUrl: "https://api-inference.modelscope.cn/v1/",
        model: "deepseek-ai/DeepSeek-V4-Flash",
        headerKey: "Authorization",
        tokenPrefix: "Bearer ",
        regUrl: "https://modelscope.cn/my/myaccesstoken"
    },
    zhipu: {
        name: "智谱 AI",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
        model: "glm-4-flash",
        headerKey: "Authorization",
        tokenPrefix: "Bearer ",
        regUrl: "https://open.bigmodel.cn/usercenter/apikeys"
    },
    gemini: {
        name: "Google Gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
        model: "gemini-2.0-flash",
        type: "google",
        regUrl: "https://aistudio.google.com/apikey"
    },
    openai: {
        name: "OpenAI / 兼容",
        baseUrl: "https://api.openai.com/v1/",
        model: "gpt-4o-mini",
        headerKey: "Authorization",
        tokenPrefix: "Bearer ",
        regUrl: "https://platform.openai.com/api-keys"
    },
    openrouter: {
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1/",
        model: "openrouter/auto",
        headerKey: "Authorization",
        tokenPrefix: "Bearer ",
        regUrl: "https://openrouter.ai/settings/keys"
    },
    deepseek: {
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/",
        model: "deepseek-chat",
        headerKey: "Authorization",
        tokenPrefix: "Bearer ",
        regUrl: "https://platform.deepseek.com/api_keys"
    },
    kimi: {
        name: "Moonshot (Kimi)",
        baseUrl: "https://api.moonshot.cn/v1/",
        model: "moonshot-v1-8k",
        headerKey: "Authorization",
        tokenPrefix: "Bearer ",
        regUrl: "https://platform.moonshot.cn/console/api-keys"
    },
    mimo: {
        name: "小米 MiMo",
        baseUrl: "https://api.xiaomimimo.com/v1/",
        model: "mimo-v2.5-pro",
        headerKey: "api-key",
        tokenPrefix: "",
        regUrl: "https://mimo.mi.com/platform"
    },
    claude: {
        name: "Claude",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-4-6",
        type: "claude",
        regUrl: "https://console.anthropic.com/settings/keys"
    },
    custom: {
        name: "自定义",
        baseUrl: "",
        model: "",
        headerKey: "Authorization",
        tokenPrefix: "Bearer ",
        regUrl: ""
    }
};

const DEFAULT_PROVIDER_RETRY_DELAYS_MS = [700, 1600];
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

function resolveMaxOutputTokens(config = {}) {
    const value = Math.floor(Number(config?.maxOutputTokens || 0));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_OUTPUT_TOKENS;
}

function isDebugEnabled() {
    return !!globalThis.AIPluginLogger?.isDebugEnabled?.();
}

function getProviderLogger() {
    return globalThis.AIPluginLogger?.create?.("ai", {
        getDebugMode: isDebugEnabled,
        onEntry: () => {},
        printConsole: true
    });
}

function getProviderRetryDelays(config = {}) {
    if (Array.isArray(config?.providerRetryDelaysMs) && config.providerRetryDelaysMs.length) {
        return config.providerRetryDelaysMs
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value >= 0);
    }
    return [...DEFAULT_PROVIDER_RETRY_DELAYS_MS];
}

function shouldRetryProviderRequest(error, attempt, maxAttempts) {
    return String(error?.code || "") === "PROVIDER_NETWORK_ERROR" && attempt < maxAttempts;
}

function decorateRetryMetadata(error, attempt, maxAttempts, retryDelaysMs = []) {
    if (!error || typeof error !== "object") return error;
    error.requestAttempt = Number(attempt || 0);
    error.requestMaxAttempts = Number(maxAttempts || 0);
    error.retryDelaysMs = Array.isArray(retryDelaysMs) ? [...retryDelaysMs] : [];
    error.retryStrategy = "provider_network_backoff";
    return error;
}

function createRetryAbortError(signal) {
    const error = new Error("provider retry aborted");
    if (signal?.reason === "aborted") error.code = "ABORTED";
    return error;
}

function sleepWithSignal(delayMs, signal) {
    if (!delayMs) return Promise.resolve();
    return new Promise((resolve, reject) => {
        let timeoutId = 0;
        let cleanup = () => {};
        const handleAbort = () => {
            cleanup();
            reject(createRetryAbortError(signal));
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

function isQwenModel(model) {
    return /qwen/i.test(String(model || ""));
}

function shouldUseJsonResponseFormat(messages) {
    const text = Array.isArray(messages)
        ? messages.map((item) => String(item?.content || "")).join("\n")
        : "";
    return /json|json_object|json数组|json 对象|只输出\s*json/i.test(text);
}

function appendJsonFormatHint(messages) {
    const list = Array.isArray(messages) ? messages.map((item) => ({ ...item })) : [];
    if (!list.length) return list;
    const hint = "Please output in JSON format.";
    const lastUserIndex = [...list].reverse().findIndex((item) => String(item?.role || "") === "user");
    const index = lastUserIndex >= 0 ? list.length - 1 - lastUserIndex : list.length - 1;
    const target = list[index] || { role: "user", content: "" };
    target.content = `${String(target.content || "").trim()}\n${hint}`.trim();
    list[index] = target;
    return list;
}

function shouldIncludeStreamUsage(providerKey, isCustom, protocol) {
    if (isCustom && protocol === "claude") return false;
    const normalized = String(providerKey || "").toLowerCase();
    return normalized === "openai" || normalized === "deepseek" || normalized === "custom";
}

function isClaudeRequest(req) {
    return req?.provider?.type === "claude" || (req?.isCustom && req?.protocol === "claude");
}

function isOpenRouterProvider(providerKey, config, provider, baseUrl) {
    const key = String(providerKey || config?.provider || "").toLowerCase();
    const url = String(baseUrl || provider?.baseUrl || "").toLowerCase();
    return key === "openrouter" || url.includes("openrouter.ai");
}

function normalizeTextContent(content) {
    if (Array.isArray(content)) {
        return content.map((item) => {
            if (typeof item === "string") return item;
            return item?.text || "";
        }).join("");
    }
    return String(content || "");
}

function extractGeminiText(data) {
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    return candidates.map((candidate) => {
        const parts = candidate?.content?.parts;
        if (Array.isArray(parts)) return parts.map((part) => part?.text || "").join("");
        return "";
    }).join("");
}

function extractOpenAIMessageText(data) {
    return normalizeTextContent(data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "");
}

const MAX_PROVIDER_RESPONSE_DEBUG_CHARS = 100000;
const MAX_INVALID_RESPONSE_PREVIEW_CHARS = 300;

function getResponseContentType(response) {
    return String(response?.headers?.get?.("content-type") || "").toLowerCase();
}

function looksLikeHtmlResponse(value) {
    return /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(String(value || ""));
}

function createInvalidProviderResponseError(req, response, rawResponse = "", requestStream = false) {
    const contentType = getResponseContentType(response);
    const isHtml = contentType.includes("text/html") || looksLikeHtmlResponse(rawResponse);
    const message = isHtml
        ? "模型服务返回了网页内容，请检查自定义 Provider 的 Base URL 是否填写为 API 地址。"
        : "模型服务返回的内容不是有效 JSON，请检查自定义 Provider 的接口兼容性。";
    return createAppError("PROVIDER_INVALID_RESPONSE", message, {
        provider: req?.isCustom ? "custom" : "",
        model: req?.model || "",
        status: Number(response?.status || 0) || undefined,
        responseContentType: contentType,
        responseKind: isHtml ? "html" : "invalid_json",
        responsePreview: String(rawResponse || "").slice(0, MAX_INVALID_RESPONSE_PREVIEW_CHARS),
        requestEndpoint: req?.finalUrl || "",
        requestHost: safeUrlHost(req?.finalUrl),
        requestProtocol: req?.protocol || "",
        isCustomProvider: !!req?.isCustom,
        requestStream: !!requestStream,
        requestMethod: "POST",
        requestEntry: requestStream ? "callAIStream" : "callAI",
        requestPhase: "parse_response"
    });
}

async function parseProviderJsonResponse(response, req, requestStream = false) {
    const rawResponse = await response.text();
    if (getResponseContentType(response).includes("text/html") || looksLikeHtmlResponse(rawResponse)) {
        throw createInvalidProviderResponseError(req, response, rawResponse, requestStream);
    }
    try {
        return JSON.parse(rawResponse);
    } catch (_) {
        throw createInvalidProviderResponseError(req, response, rawResponse, requestStream);
    }
}

function serializeProviderResponseForDebug(data) {
    try {
        const serialized = JSON.stringify(data);
        if (serialized.length <= MAX_PROVIDER_RESPONSE_DEBUG_CHARS) return serialized;
        return `${serialized.slice(0, MAX_PROVIDER_RESPONSE_DEBUG_CHARS)}...[truncated]`;
    } catch (_) {
        return String(data || "").slice(0, MAX_PROVIDER_RESPONSE_DEBUG_CHARS);
    }
}

function getResponseContentState(content) {
    if (content === undefined) return "missing";
    if (content === null) return "null";
    return normalizeTextContent(content).trim() ? "text" : "empty";
}

function buildProviderResponseMeta(data, req, text = "") {
    if (req.provider.type === "google") {
        const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
        return {
            rawResponse: serializeProviderResponseForDebug(data),
            contentState: String(text || "").trim() ? "text" : (candidates.length ? "empty" : "missing"),
            finishReason: String(candidates[0]?.finishReason || ""),
            choiceCount: candidates.length,
            reasoningChars: 0
        };
    }
    if (isClaudeRequest(req)) {
        const content = data?.content;
        return {
            rawResponse: serializeProviderResponseForDebug(data),
            contentState: getResponseContentState(content),
            finishReason: String(data?.stop_reason || ""),
            choiceCount: Array.isArray(content) ? content.length : 0,
            reasoningChars: 0
        };
    }
    const choices = Array.isArray(data?.choices) ? data.choices : [];
    const message = choices[0]?.message;
    const content = message && Object.prototype.hasOwnProperty.call(message, "content")
        ? message.content
        : choices[0]?.text;
    return {
        rawResponse: serializeProviderResponseForDebug(data),
        contentState: getResponseContentState(content),
        finishReason: String(choices[0]?.finish_reason || ""),
        choiceCount: choices.length,
        reasoningChars: String(message?.reasoning_content || message?.reasoning || "").length
    };
}

function splitSseEvents(buffer) {
    const parts = String(buffer || "").split(/\r?\n\r?\n/);
    return {
        events: parts.slice(0, -1),
        rest: parts[parts.length - 1] || ""
    };
}

function getSseDataPayloads(part) {
    const payloads = String(part || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
    if (!payloads.length) return [];
    if (payloads.length === 1) return payloads;
    const everyLineIsStandalonePayload = payloads.every((payload) => {
        if (payload === "[DONE]") return true;
        try {
            JSON.parse(payload);
            return true;
        } catch (_) {
            return false;
        }
    });
    return everyLineIsStandalonePayload ? payloads : [payloads.join("\n").trim()].filter(Boolean);
}

function resolveProviderRequest(providerKey, config, messages, streaming) {
    const providerCatalog = config?.providerCatalog && typeof config.providerCatalog === "object"
        ? config.providerCatalog
        : {};
    const provider = providerCatalog[providerKey]
        || providerCatalog[config.provider]
        || PROVIDERS[providerKey]
        || PROVIDERS[config.provider]
        || PROVIDERS.modelscope
        || PROVIDERS.default;
    const isCustom = (providerKey || config.provider) === "custom";
    const protocol = String(config.customProtocol || "openai").toLowerCase() === "claude" ? "claude" : "openai";
    const baseUrl = isCustom
        ? String(config.customBaseUrl || "").trim()
        : (provider.baseUrl || "").trim();
    const model = (config.model && config.model.trim() !== "") ? config.model : provider.model;
    const apiKey = config.apiKey || "";
    if (!baseUrl) throw new Error("自定义 Provider 需要填写 Base URL");
    if (!model) throw new Error("请填写模型名称");

    let finalUrl = baseUrl;
    if (provider.type === "google") {
        if (!finalUrl.includes(":generateContent") && !finalUrl.includes(":streamGenerateContent")) {
             finalUrl = finalUrl.replace(/\/+$/, "") + `/models/${model}:${streaming ? "streamGenerateContent" : "generateContent"}`;
        } else if (streaming && finalUrl.includes(":generateContent")) {
            finalUrl = finalUrl.replace(":generateContent", ":streamGenerateContent");
        } else if (!streaming && finalUrl.includes(":streamGenerateContent")) {
            finalUrl = finalUrl.replace(":streamGenerateContent", ":generateContent");
        }
    } else if (provider.type === "claude" || (isCustom && protocol === "claude")) {
        if (!/\/v1\/messages$/.test(finalUrl)) {
            finalUrl = finalUrl.replace(/\/+$/, "") + "/v1/messages";
        }
    } else {
        if (!finalUrl.includes('/chat/completions')) {
             finalUrl = finalUrl.replace(/\/+$/, '') + '/chat/completions';
        }
    }

    getProviderLogger()?.debug("provider_request_resolved", {
        task: "ai",
        provider: providerKey || config.provider,
        model,
        detail: {
            provider_name: provider.name,
            protocol,
            is_custom: isCustom,
            url_host: safeUrlHost(finalUrl)
        }
    });

    const headers = {
        "Content-Type": "application/json"
    };

    if (provider.type === "claude" || (isCustom && protocol === "claude")) {
        headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
    } else if (provider.headerKey && provider.type !== "google") {
        headers[provider.headerKey] = (provider.tokenPrefix || "") + apiKey;
    }

    const maxOutputTokens = resolveMaxOutputTokens(config);
    let body = {};
    if (provider.type === "google") {
        body = {
            contents: [{ parts: [{ text: messages[messages.length-1].content }] }],
            generationConfig: { maxOutputTokens }
        };
        const urlObj = new URL(finalUrl);
        urlObj.searchParams.set('key', apiKey);
        if (streaming) urlObj.searchParams.set("alt", "sse");
        return {
            provider,
            isCustom,
            protocol,
            model,
            headers,
            body,
            finalUrl: urlObj.toString()
        };
    } else if (provider.type === "claude" || (isCustom && protocol === "claude")) {
        body = {
            model,
            max_tokens: maxOutputTokens,
            messages: (messages || []).map((item) => ({
                role: item.role === "assistant" ? "assistant" : "user",
                content: String(item.content || "")
            }))
        };
        if (streaming) body.stream = true;
        return {
            provider,
            isCustom,
            protocol,
            model,
            headers,
            body,
            finalUrl
        };
    } else {
        const qwenModel = isQwenModel(model);
        const jsonMode = shouldUseJsonResponseFormat(messages);
        const normalizedMessages = qwenModel && jsonMode ? appendJsonFormatHint(messages) : messages;
        const isOpenRouter = isOpenRouterProvider(providerKey, config, provider, baseUrl);
        body = {
            model: model,
            messages: normalizedMessages,
            temperature: 0.3,
            max_tokens: maxOutputTokens,
            stream: !!streaming
        };
        if (isOpenRouter) {
            body.reasoning = { effort: "none", exclude: true };
        }
        if (streaming && shouldIncludeStreamUsage(providerKey || config.provider, isCustom, protocol)) {
            body.stream_options = { include_usage: true };
        }
        return {
            provider,
            isCustom,
            protocol,
            model,
            headers,
            body,
            finalUrl
        };
    }
}

export async function callAI(providerKey, config, messages, signal) {
    const req = resolveProviderRequest(providerKey, config, messages, false);
    const requestBody = req.body || {};
    const retryDelaysMs = getProviderRetryDelays(config);
    const maxAttempts = retryDelaysMs.length + 1;
    getProviderLogger()?.debug("provider_request_body_built", {
        task: "ai",
        provider: providerKey,
        model: requestBody.model || "",
        detail: {
            message_count: Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
            max_tokens: Number(requestBody.max_tokens || 0),
            stream: !!requestBody.stream
        }
    });
    let res;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            res = await fetch(req.finalUrl, {
                method: "POST",
                headers: req.headers,
                body: JSON.stringify(req.body),
                signal
            });
            break;
        } catch (error) {
            const wrappedError = error?.code ? error : createAppError("PROVIDER_NETWORK_ERROR", "模型服务连接失败，请稍后重试", {
                cause: error,
                provider: providerKey,
                model: req.model || "",
                requestEndpoint: req.finalUrl,
                requestHost: safeUrlHost(req.finalUrl),
                requestProtocol: req.protocol,
                isCustomProvider: !!req.isCustom,
                requestStream: false,
                requestMethod: "POST",
                requestEntry: "callAI",
                requestPhase: "initial_fetch"
            });
            decorateRetryMetadata(wrappedError, attempt, maxAttempts, retryDelaysMs);
            if (!shouldRetryProviderRequest(wrappedError, attempt, maxAttempts)) throw wrappedError;
            const delayMs = retryDelaysMs[attempt - 1] || 0;
            getProviderLogger()?.warn("provider_request_retry", {
                task: "ai",
                provider: providerKey,
                model: req.model || "",
                code: wrappedError.code || "",
                detail: {
                    attempt,
                    max_attempts: maxAttempts,
                    next_delay_ms: delayMs,
                    request_entry: "callAI",
                    request_phase: "initial_fetch",
                    url_host: safeUrlHost(req.finalUrl)
                }
            });
            await sleepWithSignal(delayMs, signal);
        }
    }
    if (!res.ok) {
        const errText = await res.text();
        if (req.isCustom && (getResponseContentType(res).includes("text/html") || looksLikeHtmlResponse(errText))) {
            throw createInvalidProviderResponseError(req, res, errText, false);
        }
        throw createHttpError(res.status, `API Error ${res.status}: ${errText}`, {
            provider: providerKey,
            model: req.model || "",
            requestEndpoint: req.finalUrl,
            requestHost: safeUrlHost(req.finalUrl),
            requestProtocol: req.protocol,
            isCustomProvider: !!req.isCustom,
            requestStream: false,
            requestMethod: "POST",
            requestEntry: "callAI",
            requestPhase: "initial_fetch"
        });
    }
    const data = await parseProviderJsonResponse(res, req, false);
    if (req.provider.type === "google") {
        const text = extractGeminiText(data);
        return {
            text,
            headers: res.headers,
            responseMeta: buildProviderResponseMeta(data, req, text)
        };
    }
    if (isClaudeRequest(req)) {
        const text = Array.isArray(data.content)
            ? data.content.map((item) => item?.text || "").join("\n").trim()
            : "";
        return {
            text,
            headers: res.headers,
            usage: data.usage,
            responseMeta: buildProviderResponseMeta(data, req, text)
        };
    }
    const text = extractOpenAIMessageText(data);
    return {
        text,
        headers: res.headers,
        usage: data.usage,
        responseMeta: buildProviderResponseMeta(data, req, text)
    };
}

export async function callAIStream(providerKey, config, messages, signal, onDelta) {
    const req = resolveProviderRequest(providerKey, config, messages, true);
    const requestBody = req.body || {};
    getProviderLogger()?.debug("provider_request_body_built", {
        task: "ai",
        provider: providerKey,
        model: requestBody.model || "",
        detail: {
            message_count: Array.isArray(requestBody.messages) ? requestBody.messages.length : 0,
            max_tokens: Number(requestBody.max_tokens || 0),
            stream: !!requestBody.stream
        }
    });
    let res;
    try {
        res = await fetch(req.finalUrl, {
            method: "POST",
            headers: req.headers,
            body: JSON.stringify(req.body),
            signal
        });
    } catch (error) {
        if (error?.code) throw error;
        throw createAppError("PROVIDER_NETWORK_ERROR", "模型服务连接失败，请稍后重试", {
            cause: error,
            provider: providerKey,
            model: req.model || "",
            requestEndpoint: req.finalUrl,
            requestHost: safeUrlHost(req.finalUrl),
            requestProtocol: req.protocol,
            isCustomProvider: !!req.isCustom,
            requestStream: true,
            requestMethod: "POST",
            requestEntry: "callAIStream",
            requestPhase: "initial_fetch"
        });
    }
    if (!res.ok) {
        const errText = await res.text();
        if (req.isCustom && (getResponseContentType(res).includes("text/html") || looksLikeHtmlResponse(errText))) {
            throw createInvalidProviderResponseError(req, res, errText, true);
        }
        throw createHttpError(res.status, `API Error ${res.status}: ${errText}`, {
            provider: providerKey,
            model: req.model || "",
            requestEndpoint: req.finalUrl,
            requestHost: safeUrlHost(req.finalUrl),
            requestProtocol: req.protocol,
            isCustomProvider: !!req.isCustom,
            requestStream: true,
            requestMethod: "POST",
            requestEntry: "callAIStream",
            requestPhase: "initial_fetch"
        });
    }
    if (getResponseContentType(res).includes("text/html")) {
        const rawResponse = typeof res.text === "function" ? await res.text().catch(() => "") : "";
        throw createInvalidProviderResponseError(req, res, rawResponse, true);
    }
    const reader = res.body?.getReader?.();
    if (!reader) {
        const data = await parseProviderJsonResponse(res, req, true);
        let text = extractOpenAIMessageText(data);
        if (req.provider.type === "google") text = extractGeminiText(data);
        if (isClaudeRequest(req)) {
            text = Array.isArray(data.content)
                ? data.content.map((item) => item?.text || "").join("\n").trim()
                : "";
        }
        if (typeof onDelta === "function" && text) onDelta(text);
        return { text, headers: res.headers, usage: data.usage, responseMeta: buildProviderResponseMeta(data, req, text) };
    }
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullText = "";
    let usage = null;
    let rawResponse = "";
    let finishReason = "";
    let choiceCount = 0;
    let reasoningChars = 0;
    const appendRawResponse = (value) => {
        if (rawResponse.length >= MAX_PROVIDER_RESPONSE_DEBUG_CHARS) return;
        const next = `${rawResponse ? "\n" : ""}${String(value || "")}`;
        rawResponse += next.slice(0, MAX_PROVIDER_RESPONSE_DEBUG_CHARS - rawResponse.length);
    };
    const emitToken = (token) => {
        const text = String(token || "");
        if (!text) return;
        fullText += text;
        if (typeof onDelta === "function") onDelta(text);
    };
    const consumeOpenAISsePart = (part) => {
        for (const dataPart of getSseDataPayloads(part)) {
            if (!dataPart || dataPart === "[DONE]") continue;
            let parsed;
            try {
                parsed = JSON.parse(dataPart);
            } catch (_) {
                continue;
            }
            appendRawResponse(dataPart);
            if (parsed?.usage) usage = parsed.usage;
            choiceCount = Math.max(choiceCount, Array.isArray(parsed?.choices) ? parsed.choices.length : 0);
            finishReason = String(parsed?.choices?.[0]?.finish_reason || finishReason || "");
            const delta = parsed?.choices?.[0]?.delta || parsed?.choices?.[0]?.message || {};
            const content = delta?.content ?? delta?.text ?? "";
            reasoningChars += String(delta?.reasoning_content || delta?.reasoning || "").length;
            if (delta?.reasoning_content && delta?.content == null && delta?.text == null) {
                getProviderLogger()?.debug("provider_stream_reasoning_delta_ignored", {
                    task: "ai",
                    provider: providerKey,
                    model: req.model || "",
                    detail: {
                        reasoning_chars: String(delta.reasoning_content || "").length
                    }
                });
                continue;
            }
            if (delta?.content == null && delta?.text == null) {
                getProviderLogger()?.debug("provider_stream_empty_delta", {
                    task: "ai",
                    provider: providerKey,
                    model: req.model || "",
                    detail: {
                        has_usage: !!parsed?.usage,
                        choice_count: Array.isArray(parsed?.choices) ? parsed.choices.length : 0
                    }
                });
            }
            const token = normalizeTextContent(content);
            emitToken(token);
        }
    };
    const consumeGeminiSsePart = (part) => {
        for (const dataPart of getSseDataPayloads(part)) {
            if (!dataPart || dataPart === "[DONE]") continue;
            let parsed;
            try {
                parsed = JSON.parse(dataPart);
            } catch (_) {
                continue;
            }
            appendRawResponse(dataPart);
            const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
            choiceCount = Math.max(choiceCount, candidates.length);
            finishReason = String(candidates[0]?.finishReason || finishReason || "");
            if (parsed?.usageMetadata) {
                usage = {
                    prompt_tokens: parsed.usageMetadata.promptTokenCount,
                    completion_tokens: parsed.usageMetadata.candidatesTokenCount,
                    total_tokens: parsed.usageMetadata.totalTokenCount
                };
            }
            emitToken(extractGeminiText(parsed));
        }
    };
    const consumeClaudeSsePart = (part) => {
        const event = {};
        String(part || "").split("\n").forEach((line) => {
            const value = String(line || "").trim();
            if (!value) return;
            if (value.startsWith("event:")) event.type = value.slice(6).trim();
            if (value.startsWith("data:")) event.data = `${event.data || ""}${value.slice(5).trim()}`;
        });
        if (!event.data || event.data === "[DONE]") return;
        let parsed;
        try {
            parsed = JSON.parse(event.data);
        } catch (_) {
            return;
        }
        appendRawResponse(event.data);
        finishReason = String(parsed?.stop_reason || parsed?.delta?.stop_reason || finishReason || "");
        if (Array.isArray(parsed?.content)) choiceCount = Math.max(choiceCount, parsed.content.length);
        if (parsed?.type === "message_start" && parsed?.message?.usage) usage = parsed.message.usage;
        if (parsed?.type === "message_delta" && parsed?.usage) usage = { ...(usage || {}), ...parsed.usage };
        const text = parsed?.type === "content_block_delta" && parsed?.delta?.type === "text_delta"
            ? parsed.delta.text
            : "";
        emitToken(text);
    };
    const consumeSsePart = (part) => {
        if (req.provider.type === "google") {
            consumeGeminiSsePart(part);
            return;
        }
        if (isClaudeRequest(req)) {
            consumeClaudeSsePart(part);
            return;
        }
        consumeOpenAISsePart(part);
    };
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            if (!fullText && looksLikeHtmlResponse(buffer)) {
                throw createInvalidProviderResponseError(req, res, buffer, true);
            }
            const { events, rest } = splitSseEvents(buffer);
            buffer = rest;
            for (const part of events) {
                consumeSsePart(part);
            }
        }
    if (buffer.trim()) consumeSsePart(buffer);
    return {
        text: fullText,
        headers: res.headers,
        usage,
        responseMeta: {
            rawResponse,
            contentState: fullText.trim() ? "text" : (rawResponse ? "empty" : "missing"),
            finishReason,
            choiceCount,
            reasoningChars
        }
    };
}

function safeUrlHost(url) {
    try {
        return new URL(String(url || "")).host;
    } catch (_) {
        return "";
    }
}
