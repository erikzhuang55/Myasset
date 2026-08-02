(function () {
    const IGNORED_ERROR_PATTERNS = [
        /api\s*key/i,
        /请先配置/i,
        /未配置/i,
        /配置.*(缺失|不完整|失败)/i,
        /当前视频暂无字幕/i,
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
        "MISSING_SUBTITLE"
    ]);

    function normalizeError(errorInput) {
        if (errorInput instanceof Error) {
            return {
                name: errorInput.name || "Error",
                message: errorInput.message || "Unknown error",
                code: String(errorInput.code || ""),
                status: Number(errorInput.status || 0) || undefined,
                retryAfterSec: Number(errorInput.retryAfterSec || 0) || undefined,
                stack: errorInput.stack || ""
            };
        }
        if (errorInput && typeof errorInput === "object") {
            return {
                name: String(errorInput.name || "Error"),
                message: String(errorInput.message || errorInput.error || "Unknown error"),
                code: String(errorInput.code || ""),
                status: Number(errorInput.status || 0) || undefined,
                retryAfterSec: Number(errorInput.retryAfterSec || 0) || undefined,
                stack: String(errorInput.stack || "")
            };
        }
        return {
            name: "Error",
            message: String(errorInput || "Unknown error"),
            stack: ""
        };
    }

    function shouldReportContentError(errorInput, context = {}) {
        const normalized = normalizeError(errorInput);
        const code = String(errorInput?.code || context?.code || "").trim().toUpperCase();
        if (IGNORED_ERROR_CODES.has(code)) return false;
        if (isClearlyThirdPartyExtensionError(normalized.stack, context)) return false;
        return !IGNORED_ERROR_PATTERNS.some((pattern) => pattern.test(normalized.message));
    }

    function isClearlyThirdPartyExtensionError(stackInput, context = {}) {
        const source = String(context?.source || "");
        if (!["content_window_error", "content_unhandled_rejection"].includes(source)) return false;

        const stack = String(stackInput || "");
        const extensionOrigins = [...stack.matchAll(/\b(?:chrome|moz)-extension:\/\/([^/\s)]+)/gi)]
            .map((match) => String(match?.[1] || "").toLowerCase())
            .filter(Boolean);
        if (!extensionOrigins.length) return false;

        const runtime = globalThis.chrome?.runtime;
        if (typeof runtime?.getURL !== "function") return false;
        try {
            const ownOriginMatch = String(runtime.getURL(""))
                .match(/^(?:chrome|moz)-extension:\/\/([^/]+)/i);
            const ownExtensionOrigin = String(ownOriginMatch?.[1] || "").toLowerCase();
            if (!ownExtensionOrigin) return false;
            return !extensionOrigins.includes(ownExtensionOrigin);
        } catch (_) {
            return false;
        }
    }

    function buildPageContext(extra = {}) {
        const state = globalThis.BilitatoAppState || {};
        const cache = state.cache || {};
        const path = String(globalThis.location?.pathname || "");
        const rawSubtitle = Array.isArray(cache.rawSubtitle) ? cache.rawSubtitle : [];
        const subtitleTotalChars = rawSubtitle.reduce((sum, row) => sum + String(row?.text || "").length, 0);
        const videoDurationSec = resolveVideoDurationSeconds(cache);
        return {
            source: "content",
            pageType: path.includes("/list/") ? "list" : "video",
            bvid: state.injectBvid || state.tabState?.activeBvid || "",
            provider: state.settings?.provider || "",
            model: state.settings?.model || "",
            hasSubtitle: rawSubtitle.length > 0,
            subtitleCount: rawSubtitle.length,
            subtitle_total_chars: subtitleTotalChars || undefined,
            video_duration_sec: videoDurationSec || undefined,
            asrEnabled: !!String(state.settings?.groqApiKey || "").trim(),
            ...extra
        };
    }

    function resolveVideoDurationSeconds(cache = {}) {
        const video = globalThis.document?.querySelector?.("video");
        const fromVideo = Number(video?.duration || 0);
        if (Number.isFinite(fromVideo) && fromVideo > 0) return Math.floor(fromVideo);
        const rows = Array.isArray(cache.rawSubtitle) ? cache.rawSubtitle : [];
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

    function reportContentError(errorInput, context = {}) {
        try {
            if (!shouldReportContentError(errorInput, context)) {
                return Promise.resolve({ ok: false, ignored: true });
            }
            const runtime = globalThis.chrome?.runtime;
            if (!runtime?.sendMessage) return Promise.resolve({ ok: false });
            return runtime.sendMessage({
                action: "REPORT_ERROR",
                error: normalizeError(errorInput),
                context: buildPageContext(context)
            }).catch(() => ({ ok: false }));
        } catch (_) {
            return Promise.resolve({ ok: false });
        }
    }

    if (globalThis.window?.addEventListener) {
        window.addEventListener("error", (event) => {
            reportContentError(event.error || event.message, {
                task: "global_error",
                source: "content_window_error"
            });
        });

        window.addEventListener("unhandledrejection", (event) => {
            reportContentError(event.reason || "Unhandled rejection", {
                task: "global_rejection",
                source: "content_unhandled_rejection"
            });
        });
    }

    globalThis.BilitatoContentErrorReporter = {
        buildPageContext,
        normalizeError,
        reportContentError,
        shouldReportContentError
    };
})();
