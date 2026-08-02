(function initLogger(global) {
    const ALLOWED_MODULES = new Set([
        "inject",
        "content",
        "background",
        "cache",
        "ai",
        "ui",
        "settings",
        "subtitle",
        "download",
        "asr",
        "cloud",
        "sentry"
    ]);
    const LEVELS = new Set(["info", "warn", "error", "debug"]);
    const PREFIX = "[AI-PLUGIN]";
    const MAX_STRING_LENGTH = 300;
    const MAX_ARRAY_LENGTH = 20;
    const MAX_DEPTH = 5;
    const SENSITIVE_KEY_PATTERN = /(api[_-]?key|authorization|token|secret|password|cookie|prompt|subtitle|content|message|messages|base[_-]?url|download[_-]?url|sentry[_-]?dsn|dsn|url|filename)/i;
    const COMMON_FIELDS = new Set([
        "task",
        "source",
        "bvid",
        "cid",
        "tid",
        "tab_id",
        "trace_id",
        "task_id",
        "attempt_id",
        "page_type",
        "pageType",
        "provider",
        "model",
        "code",
        "status",
        "retryable",
        "fallback",
        "duration_ms",
        "latency_ms",
        "latencyMs"
    ]);

    function safeDetail(detail) {
        if (detail && typeof detail === "object") return detail;
        if (detail === undefined) return {};
        return { value: detail };
    }

    function sanitizeValue(value, depth = 0, key = "") {
        if (SENSITIVE_KEY_PATTERN.test(String(key || ""))) return "[Filtered]";
        if (value == null) return value;
        if (depth >= MAX_DEPTH) return "[MaxDepth]";
        if (typeof value === "string") {
            return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...[Truncated]` : value;
        }
        if (typeof value === "number" || typeof value === "boolean") return value;
        if (Array.isArray(value)) {
            const items = value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitizeValue(item, depth + 1, key));
            if (value.length > MAX_ARRAY_LENGTH) items.push(`...[${value.length - MAX_ARRAY_LENGTH} more]`);
            return items;
        }
        if (typeof value === "object") {
            const result = {};
            Object.entries(value).slice(0, 50).forEach(([childKey, childValue]) => {
                result[childKey] = sanitizeValue(childValue, depth + 1, childKey);
            });
            return result;
        }
        return String(value);
    }

    function toNumberOrZero(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : 0;
    }

    function normalizePageType(detail) {
        return String(detail.page_type || detail.pageType || "").trim();
    }

    function defaultSource(moduleName) {
        if (moduleName === "inject") return "inject";
        if (moduleName === "content" || moduleName === "ui" || moduleName === "settings" || moduleName === "subtitle" || moduleName === "download") return "content";
        return "background";
    }

    function buildEntry(level, moduleName, eventName, rawDetail) {
        const detailInput = safeDetail(rawDetail);
        const detail = {};
        Object.entries(detailInput).forEach(([key, value]) => {
            if (key !== "detail" && !COMMON_FIELDS.has(key)) detail[key] = value;
        });
        if (detailInput.detail && typeof detailInput.detail === "object" && !Array.isArray(detailInput.detail)) {
            Object.assign(detail, detailInput.detail);
        }
        return {
            time: new Date().toISOString(),
            level,
            module: moduleName,
            event: normalizeEvent(eventName),
            task: String(detailInput.task || "").trim(),
            task_id: String(detailInput.task_id || "").trim(),
            trace_id: String(detailInput.trace_id || "").trim(),
            attempt_id: String(detailInput.attempt_id || "").trim(),
            source: String(detailInput.source || defaultSource(moduleName)).trim(),
            bvid: String(detailInput.bvid || "").trim(),
            cid: toNumberOrZero(detailInput.cid),
            tid: String(detailInput.tid || "").trim(),
            tab_id: toNumberOrZero(detailInput.tab_id),
            page_type: normalizePageType(detailInput),
            provider: String(detailInput.provider || "").trim(),
            model: String(detailInput.model || "").trim(),
            code: String(detailInput.code || "").trim(),
            status: toNumberOrZero(detailInput.status),
            retryable: typeof detailInput.retryable === "boolean" ? detailInput.retryable : null,
            fallback: String(detailInput.fallback || "").trim(),
            duration_ms: toNumberOrZero(detailInput.duration_ms ?? detailInput.latency_ms ?? detailInput.latencyMs),
            detail: sanitizeValue(detail)
        };
    }

    function normalizeModule(moduleName) {
        const value = String(moduleName || "").trim().toLowerCase();
        return ALLOWED_MODULES.has(value) ? value : "ui";
    }

    function normalizeEvent(eventName) {
        const raw = String(eventName || "").trim();
        if (!raw) return "unknown_event";
        return raw
            .replace(/\s+/g, "_")
            .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
            .replace(/[^a-zA-Z0-9_]/g, "_")
            .replace(/_+/g, "_")
            .replace(/^_+|_+$/g, "")
            .toLowerCase() || "unknown_event";
    }

    function shouldPrint(level, debugMode) {
        return !!debugMode;
    }

    function shouldStore(level, debugMode) {
        return level !== "debug" || !!debugMode;
    }

    function toConsole(entry) {
        const text = `${PREFIX}[${entry.module}][${entry.event}]`;
        if (entry.level === "error") {
            console.error(text, entry.detail);
            return;
        }
        if (entry.level === "warn") {
            console.warn(text, entry.detail);
            return;
        }
        if (entry.level === "debug") {
            console.debug(text, entry.detail);
            return;
        }
        console.log(text, entry.detail);
    }

    function postToBackground(entry) {
        if (!global.chrome?.runtime?.sendMessage) return;
        try {
            const result = global.chrome.runtime.sendMessage({ action: "LOG_ENTRY", entry });
            if (result && typeof result.catch === "function") result.catch(() => {});
        } catch (_) {}
    }

    function create(moduleName, options = {}) {
        const fixedModule = normalizeModule(moduleName);
        const getDebugMode = typeof options.getDebugMode === "function" ? options.getDebugMode : () => true;
        const onEntry = typeof options.onEntry === "function" ? options.onEntry : postToBackground;
        const printConsole = options.printConsole !== false;

        function write(levelName, eventName, detail) {
            const level = LEVELS.has(levelName) ? levelName : "info";
            const debugMode = !!getDebugMode();
            const entry = buildEntry(level, fixedModule, eventName, detail);
            if (shouldStore(level, debugMode)) {
                try {
                    onEntry(entry);
                } catch (_) {}
            }
            if (printConsole && shouldPrint(level, debugMode)) {
                toConsole(entry);
            }
            return entry;
        }

        return {
            info(eventName, detail) {
                return write("info", eventName, detail);
            },
            warn(eventName, detail) {
                return write("warn", eventName, detail);
            },
            error(eventName, detail) {
                return write("error", eventName, detail);
            },
            debug(eventName, detail) {
                return write("debug", eventName, detail);
            }
        };
    }

    global.AIPluginLogger = {
        create,
        normalizeEvent,
        sanitizeValue,
        isDebugEnabled() {
            return !!global.__AI_PLUGIN_DEBUG__;
        },
        setDebugEnabled(value) {
            global.__AI_PLUGIN_DEBUG__ = !!value;
        }
    };
    if (typeof global.__AI_PLUGIN_DEBUG__ === "undefined") {
        global.__AI_PLUGIN_DEBUG__ = false;
    }
})(globalThis);
