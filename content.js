let IS_DEBUG_MODE = false;
const DEBUG_PANEL_BUILD_STAMP = "2026-06-07 03:34 Asia/Shanghai";
const {
    escapeHtml,
    escapeHtmlAttr,
    escapeRegExp,
    formatTime,
    formatTimelineTime,
    formatUtc8DateTime,
    getBvidFromUrl,
    getTidFromUrl,
    normalizeBvidCase,
    resolveDefaultOpenPage,
    serializeTimelineDetail,
    shouldIsolateChatInputKey,
    sleep,
    toNumberOrNaN,
    toSrtTime
} = globalThis.BilitatoContentUtils || {};
const {
    downloadTextFile,
    hasUsablePlayInfoForBvid,
    normalizeIncomingPlayInfo,
    sanitizeDownloadFileName
} = globalThis.BilitatoContentDownload || {};
const {
    DEFAULT_PROMPT_SETTINGS,
    TASK_PROMPTS_DEFAULT,
    normalizePromptSettingsState
} = globalThis.BilitatoContentSettings || {};
const {
    flashButtonState,
    renderSkeletonLines,
    showToast
} = globalThis.BilitatoContentUi || {};

function isNoTimestampSubtitleCache(cache = {}) {
    const source = String(cache?.subtitleSource || "").toLowerCase();
    if (source === "siliconflow" || source === "funasr" || source === "mimo") return true;
    const raw = Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle : [];
    if (!raw.length) return false;
    return raw.some((item) => item?.noTimestamp === true);
}

function resolveSubtitleLineForSegment(rawRows, lineId) {
    const id = Number(lineId);
    if (!Array.isArray(rawRows) || !rawRows.length || !Number.isInteger(id)) return null;
    if (id >= 0 && id < rawRows.length) return rawRows[id];
    const fallback = id - 1;
    if (fallback >= 0 && fallback < rawRows.length) return rawRows[fallback];
    return null;
}

function getSegmentSubtitleEndTime(row, fallbackStart = 0) {
    const end = Number(row?.to ?? row?.end ?? NaN);
    if (Number.isFinite(end) && end > fallbackStart) return end;
    const start = Number(row?.from ?? row?.start ?? fallbackStart);
    if (Number.isFinite(start) && start > fallbackStart) return start;
    return fallbackStart;
}

function resolveSegmentTimelineRange(item, cache = {}) {
    if (isNoTimestampSubtitleCache(cache)) return null;
    const start = Number(item?.start);
    const end = Number(item?.end);
    if (!item?.no_timestamp && !item?.virtual_time && Number.isFinite(start) && Number.isFinite(end) && end > start) {
        return { start, end };
    }
    const rawRows = Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle : [];
    const startLineId = Number(item?.type === "ad" ? (item?.ad_start_line ?? item?.start_line) : item?.start_line);
    const endLineId = Number(item?.type === "ad" ? (item?.ad_end_line ?? item?.end_line) : item?.end_line);
    const startLine = resolveSubtitleLineForSegment(rawRows, startLineId);
    const endLine = resolveSubtitleLineForSegment(rawRows, endLineId);
    if (!startLine || !endLine) return null;
    const mappedStart = Number(startLine.from ?? startLine.start ?? NaN);
    const endBase = Number(endLine.from ?? endLine.start ?? mappedStart);
    const mappedEnd = getSegmentSubtitleEndTime(endLine, endBase);
    if (!Number.isFinite(mappedStart) || !Number.isFinite(mappedEnd) || mappedEnd <= mappedStart) return null;
    return { start: mappedStart, end: mappedEnd };
}

function normalizeSegmentLabelForDedupe(label) {
    return String(label || "").replace(/\s+/g, "").trim().toLowerCase();
}

function dedupeDisplayedLineOnlyContentSegments(segments, cache = {}) {
    const list = Array.isArray(segments) ? segments : [];
    if (!isNoTimestampSubtitleCache(cache)) return list;
    const seen = new Set();
    return list.filter((item) => {
        if (item?.type === "ad") return true;
        const key = normalizeSegmentLabelForDedupe(item?.label);
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function getProviderModelOptions(providerKey) {
    const key = String(providerKey || "").toLowerCase();
    const remoteModels = appState?.providers?.[key]?.models;
    if (Array.isArray(remoteModels) && remoteModels.length) {
        return [...new Set(remoteModels.map((model) => String(model || "").trim()).filter(Boolean))];
    }
    const options = {
        modelscope: [
            "deepseek-ai/DeepSeek-V4-Flash",
            "deepseek-ai/DeepSeek-V4-Pro",
            "deepseek-ai/DeepSeek-V3.2",
            "ZhipuAI/GLM-5.2",
            "stepfun-ai/Step-3.7-Flash"
        ],
        zhipu: [
            "glm-5.1",
            "glm-5",
            "glm-5-turbo",
            "glm-4.7",
            "glm-4.6",
            "glm-4.5"
        ],
        gemini: [
            "gemini-3.5-flash",
            "gemini-3.1-pro-preview",
            "gemini-3-flash-preview",
            "gemini-3.1-flash-lite",
            "gemini-2.5-pro",
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite"
        ],
        openai: [
            "gpt-5.5",
            "gpt-5.5-pro",
            "gpt-5.4",
            "gpt-5.4-pro",
            "gpt-5.4-mini",
            "gpt-5.4-nano",
            "gpt-5.2",
            "gpt-5.2-pro",
            "gpt-5.1",
            "gpt-5",
            "gpt-5-pro",
            "gpt-5-mini",
            "gpt-5-nano",
            "gpt-4.1",
            "gpt-4.1-mini",
            "gpt-4o",
            "gpt-4o-mini"
        ],
        openrouter: [
            "openrouter/free",
            "openrouter/auto",
            "~openai/gpt-latest",
            "~openai/gpt-mini-latest",
            "openai/gpt-5.5",
            "openai/gpt-chat-latest",
            "~anthropic/claude-sonnet-latest",
            "anthropic/claude-opus-4.7",
            "anthropic/claude-opus-4.7-fast",
            "~google/gemini-pro-latest",
            "~google/gemini-flash-latest",
            "google/gemini-3.5-flash",
            "qwen/qwen3.7-max",
            "x-ai/grok-4.3",
            "x-ai/grok-build-0.1",
            "moonshotai/kimi-k2.6",
            "deepseek/deepseek-v4-pro",
            "deepseek/deepseek-v3.2",
            "z-ai/glm-5.1",
            "openrouter/owl-alpha"
        ],
        deepseek: [
            "deepseek-v4-flash",
            "deepseek-v4-pro"
        ],
        kimi: [
            "kimi-k2.6",
            "kimi-k2.5",
            "kimi-k2-turbo-preview",
            "kimi-k2-thinking",
            "kimi-k2-thinking-turbo",
            "moonshot-v1-8k",
            "moonshot-v1-32k",
            "moonshot-v1-128k"
        ],
        mimo: [
            "mimo-v2.5-pro",
            "mimo-v2.5",
            "mimo-v2-pro",
            "mimo-v2-omni",
            "mimo-v2-flash"
        ],
        claude: [
            "claude-opus-4-5",
            "claude-sonnet-4-6",
            "claude-sonnet-4-5",
            "claude-haiku-4-5"
        ]
    };
    return options[key] || [];
}

function getDefaultProviderModel(providerKey) {
    const options = getProviderModelOptions(providerKey);
    return options[0] || "";
}

function resolveProviderModelValue(providerKey, model) {
    const key = String(providerKey || "").toLowerCase();
    const value = String(model || "").trim();
    if (key !== "modelscope") return value;
    const legacyModelScopeModels = new Set([
        "moonshotai/Kimi-K2.5",
        "moonshotai/Kimi-K2.6",
        "MiniMax/MiniMax-M2.5",
        "ZhipuAI/GLM-5.1",
        "ZhipuAI/GLM-4.7-Flash",
        "Qwen/Qwen3.5-27B",
        "Qwen/Qwen2.5-72B-Instruct"
    ]);
    return legacyModelScopeModels.has(value) ? getDefaultProviderModel("modelscope") : value;
}

function getSortedProviderKeys(providers = {}) {
    const keys = Object.keys(providers || {});
    return keys.sort((left, right) => {
        if (left === "custom") return 1;
        if (right === "custom") return -1;
        const leftName = String(providers[left]?.name || left);
        const rightName = String(providers[right]?.name || right);
        const byName = leftName.localeCompare(rightName, "en", { sensitivity: "base" });
        if (byName !== 0) return byName;
        return left.localeCompare(right, "en", { sensitivity: "base" });
    });
}

function getProviderFreeQuotaText(providerKey) {
    const key = String(providerKey || "").toLowerCase();
    const quotaText = {
        modelscope: [
            "ModelScope 免费额度",
            "DeepSeek-V4-Flash：50次/天",
            "DeepSeek-V4-Pro：以官网为准",
            "DeepSeek-V3.2：20次/天",
            "GLM-5.2：50次/天",
            "Step-3.7-Flash：50次/天",
            "RPM：每个模型约5-20"
        ],
        gemini: [
            "Gemini 免费额度",
            "3.5 Flash：5 RPM / 250K TPM / 20 RPD",
            "2.5 Flash：5 RPM / 250K TPM / 20 RPD",
            "3.1 Flash Lite：15 RPM / 250K TPM / 500 RPD",
            "2.5 Flash Lite：10 RPM / 250K TPM / 20 RPD"
        ],
        openrouter: [
            "OpenRouter 免费额度",
            "openrouter/free 自动路由免费模型",
            "限额：20 RPM",
            "未购买credits：约50 RPD",
            "购买 >= $10 credits：约1000 RPD"
        ]
    };
    return quotaText[key]?.join("\n") || "";
}
const {
    buildCacheTagHtml,
    getTaskCacheSource
} = globalThis.BilitatoContentCache || {};
const {
    renderRichContent
} = globalThis.BilitatoContentRichText || {};
const {
    formatMetricText,
    renderAssistantBubble: renderAssistantBubbleHtml,
    renderChatHistoryItem: renderChatHistoryItemHtml
} = globalThis.BilitatoContentChat || {};
const {
    buildPlaybackSubtitleCues,
    buildSrtContent,
    buildTimestampedSubtitleText,
    getActiveSubtitleIndex,
    getRawSubtitlePlainText: getRawSubtitlePlainTextFromCache,
    getRawSubtitleRows: getRawSubtitleRowsFromCache
} = globalThis.BilitatoContentSubtitle || {};
const {
    buildChatProgressTaskId,
    buildTasksProgressTaskId,
    canRunTasksWithCache,
    createChatMessageId,
    createPendingChatMessages,
    needsSubtitleForTasks
} = globalThis.BilitatoContentAi || {};
const {
    createCloudReadState,
    hasSubtitle: hasSubtitleInCache,
    isCloudReadLoadingForVideo,
    shouldAttemptCloudReadForPage: shouldAttemptCloudReadForPageState,
    shouldAttemptCloudReadForVideo: shouldAttemptCloudReadForVideoState
} = globalThis.BilitatoContentCloud || {};
const {
    cleanBilibiliTitle,
    isStorageChangeStateDirty: isStorageChangeStateDirtyFromPage,
    normalizeSubtitleOptions: normalizeSubtitleOptionsFromPage,
    pickSubtitle: pickSubtitleFromPage,
    resolveCurrentBvidFromState
} = globalThis.BilitatoContentPage || {};
const {
    reportContentError
} = globalThis.BilitatoContentErrorReporter || {};
const {
    mapErrorToView,
    renderErrorPanel
} = globalThis.BilitatoContentErrorMessages || {};

const DEBUG_LOG_DISPLAY_LIMIT = 2000;
const DEFAULT_GROQ_ASR_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_SILICONFLOW_ASR_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MIMO_ASR_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_MIMO_ASR_MODEL = "mimo-v2.5-asr";

const SETUP_PREVIEW_VIDEO_URL = "https://www.bilibili.com/video/BV1ojfDBSEPv/?spm_id_from=333.337.search-card.all.click&vd_source=3f5a30216e0108cea18aa63a3bff11b8";
const SETUP_PREVIEW_BVID = normalizeBvidCase(getBvidFromUrl?.(SETUP_PREVIEW_VIDEO_URL) || "BV1ojfDBSEPv");
const SETUP_PREVIEW_STORAGE_KEY = "setupGuidePreviewTarget";
const SETUP_PREVIEW_MAX_AGE_MS = 10 * 60 * 1000;

function isDebugLoggingEnabled() {
    return !!(IS_DEBUG_MODE || appState?.settings?.debugMode);
}

function syncInjectDebugMode() {
    window.postMessage({ type: "BILI_SET_DEBUG_MODE", enabled: isDebugLoggingEnabled() }, "*");
}

function abortBackgroundOperations(reason = "page_unload") {
    try {
        chrome.runtime.sendMessage({ action: "ABORT_TAB_OPERATIONS", reason }).catch?.(() => {});
    } catch (_) {}
}

window.addEventListener("pagehide", () => abortBackgroundOperations("pagehide"));
window.addEventListener("beforeunload", () => abortBackgroundOperations("beforeunload"));

const UI_ICON_BASE_DIR = "assets/ui";
const FOLLOW_RESUME_MS = 5000;
const SUBTITLE_CHECK_DELAY_MS = 1000;
const SUBTITLE_DETECT_TIMEOUT_MS = 5000;
const CACHE_SYNC_THROTTLE_MS = 500;
const SUBTITLE_OBSERVE_GRACE_MS = 3500;
const STEP_PROGRESS_TIMEOUT_MS = 60000;
const CLOUD_READ_TIMEOUT_MS = 1000;
const FEEDBACK_SUBMITTED_STORAGE_KEY = "feedbackSubmitted";
const FEEDBACK_PENDING_REPLY_TEXT = "感谢你的反馈！我会尽量在24小时内回复。";
const appState = {
    tabId: null,
    activePage: "CC",
    tabState: null,
    cache: null,
    settings: null,
    providers: null,
    followEnabled: true,
    followPausedAt: 0,
    followCurrentIndex: -1,
    renderedSubtitleIndex: -1,
    videoSubtitleEnabled: false,
    videoSubtitleTrack: null,
    videoSubtitleVideo: null,
    videoSubtitleSignature: "",
    subtitleCapturedBvid: "",
    injectBvid: "",
    injectCid: 0,
    injectPartCount: 0,
    logPollTimer: null,
    injectReady: false,
    injectRetryTimer: null,
    chatGuideHidden: false,
    chatPending: [],
    chatStreamingId: "",
    chatStreamTimer: null,
    chatPort: null,
    chatActiveMessageId: "",
    debugLogPollTimer: null,
    debugToolsTab: "overview",
    debugLogLevel: "all",
    debugLogModule: "all",
    debugLogQuery: "",
    debugLogOnlyFailures: false,
    debugLogView: "timeline",
    debugScenarioResult: null,
    asrRateLimitRetryAfterSec: 0,
    asrUiTraceLogs: [],
    chatAutoScrollPausedUntil: 0,
    pendingSubtitle: null,
    timelineSearchTerm: "",
    timelineSearchDebounceTimer: null,
    ccSearchTerm: "",
    cloudReadState: {
        bvid: "",
        status: "idle",
        requestId: 0,
        startedAt: 0
    },
    ccSearchDebounceTimer: null,
    subtitleFallbackTimer: null,
    lastSubtitleForwardAt: 0,
    routeWatchTimer: null,
    routeWatchBvid: "",
    routeWatchKey: "",
    subtitleTimeline: [],
    subtitleOptions: [],
    subtitleOptionsBvid: "",
    activeSubtitleId: "",
    pendingSubtitleLanguageSwitch: null,
    transcription: {
        phase: "idle",
        bvid: "",
        progress: 0,
        statusText: ""
    },
    asrSession: {
        active: false,
        bvid: "",
        runId: "",
        stage: "",
        progress: 0,
        statusText: "",
        startedAt: 0
    },
    asrRequestDispatched: false,
    transcriptionDeclinedBvid: "",
    transcriptionSuppressUntil: 0,
    transcriptionSuppressBvid: "",
    transcribeCountdownTimer: null,
    subtitleCheckDelayTimer: null,
    subtitleCheckTargetBvid: "",
    transcriptionCapsuleVisible: false,
    transcriptionCapsuleMeta: null,
    lastCacheSyncTime: 0,
    lastCacheSyncBvid: "",
    isStateDirty: true,
    subtitleObserver: null,
    subtitleObserveUntil: 0,
    subtitleDomDetected: false,
    injectBvidChangedAt: Date.now(),
    progressTaskId: "",
    progressLastTick: 0,
    progressLastPercent: 0,
    progressTimeoutTimer: null,
    progressResetTimer: null,
    progressFadeTimer: null,
    pseudoProgressTaskId: "",
    pseudoProgressValue: 0,
    pseudoProgressStartedAt: 0,
    pseudoProgressTimer: null,
    visibleProgressCompletedTaskIds: new Set(),
    saveStatusTimer: null,
    navActionActive: "",
    navActionActiveTimer: null,
    segmentsFloatDragging: null,
    segmentsMarkerTickAt: 0,
    sessionGeneratedTasks: new Set(),
    summaryExpanded: false,
    summaryRatio: 0.7,
    summaryRatioManuallyAdjusted: false,
    panelMaxHeight: 0,
    expandedSummaryHeight: 0,
    isCollapsed: false,
    collapseHintShown: false,
    segmentsCollapsed: false,
    localPending: {
        tasks: {},
        transcription: false
    },
    feedback: {
        rows: [],
        unreadCount: 0,
        enabled: true,
        loading: false,
        submitting: false,
        statusText: "",
        errorText: "",
        loadedAt: 0
    },
    feedbackDraft: {
        type: "bug",
        title: "",
        content: "",
        includeLogs: true
    },
    feedbackHasSubmission: false,
    feedbackSeenTimer: null,
    feedbackVisibleUnreadIds: new Set(),
    cloudCachePrefs: { all: false, current: false },
    versionState: null,
    versionCheckTimer: null,
    lastSettingsUsageEventSignature: "",
    playInfo: null,
    playInfoUpdatedAt: 0,
    isPlayInfoReady: false,
    playerApiDisabledLogKey: "",
    panelErrors: {}
};
globalThis.BilitatoAppState = appState;

function getSubtitleDiagnosticRowsMeta(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const preview = (row) => String(row?.text ?? row?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    return {
        rowCount: list.length,
        firstThreeLines: list.slice(0, 3).map(preview).join("\\n"),
        firstLine: preview(list[0]),
        secondLine: preview(list[1]),
        thirdLine: preview(list[2])
    };
}

function logSubtitleDiagnostic(event, detail = {}) {
    if (!isDebugLoggingEnabled()) return;
    try {
        console.log("[SUBTITLE_DIAG]", {
            event,
            ts: Date.now(),
            routeBvid: String(getBvidFromUrl(location.href) || ""),
            routeP: String(new URL(location.href).searchParams.get("p") || ""),
            ...detail
        });
    } catch (_) {}
}

const partScopeDiagnosticSignatures = new Map();

function buildPartScopeUiMeta(cache = appState.cache) {
    return {
        routeBvid: normalizeBvidCase(resolveCurrentBvid() || "").toLowerCase(),
        routeP: String(getRoutePartId() || ""),
        routeCid: Number(resolveCid() || 0),
        tabStateBvid: normalizeBvidCase(appState.tabState?.activeBvid || "").toLowerCase(),
        tabStateCid: Number(appState.tabState?.activeCid || 0),
        tabStateTid: String(appState.tabState?.activeTid || ""),
        cacheBvid: normalizeBvidCase(cache?.bvid || "").toLowerCase(),
        cacheCid: Number(cache?.cid || 0),
        cacheTid: String(cache?.tid || ""),
        hasSummary: !!String(cache?.summary || "").trim(),
        segmentsCount: Array.isArray(cache?.segments) ? cache.segments.length : 0,
        hasRumors: !!(cache?.rumors && (String(cache.rumors?.overview || "").trim() || Array.isArray(cache.rumors?.claims) && cache.rumors.claims.length)),
        historyCount: Array.isArray(cache?.history) ? cache.history.length : 0,
        summarySource: String(cache?.summaryCacheSource || ""),
        segmentsSource: String(cache?.segmentsCacheSource || ""),
        rumorsSource: String(cache?.rumorsCacheSource || ""),
        availablePartKeys: cache?.parts && typeof cache.parts === "object" ? Object.keys(cache.parts).slice(0, 50) : []
    };
}

function logPartScopeDiagnostic(event, detail = {}, dedupeKey = "") {
    if (!isDebugLoggingEnabled()) return;
    const payload = { event, ts: Date.now(), layer: "content", ...buildPartScopeUiMeta(), ...detail };
    if (dedupeKey) {
        const signature = JSON.stringify(payload, (key, value) => key === "ts" ? undefined : value);
        if (partScopeDiagnosticSignatures.get(dedupeKey) === signature) return;
        partScopeDiagnosticSignatures.set(dedupeKey, signature);
    }
    console.log("[PART_SCOPE_DIAG]", payload);
}

const subtitleUiCoordinator = {
    routeKey: "",
    phase: "idle",
    generation: 0,
    rows: [],
    rowsRouteKey: "",
    rowsSource: "",
    rowsCid: 0,
    stateVersion: 0,
    renderedStateSignature: "",
    renderScheduled: false,
    initialAlignmentPending: false,
    timeoutTimer: null,
    lastCacheApplySignature: "",
    scrollUnlockAt: 0,
    displaySource: "",
    pendingRequestUrls: new Set(),
    controlProbeTimer: null,
    controlProbeObserver: null,
    lastRouteSwitchKey: "",
    lastRouteSwitchAt: 0
};
const playInfoWaiters = new Set();

function getCurrentSubtitleRouteKey() {
    return `${String(getBvidFromUrl(location.href) || "").toLowerCase()}|${String(getRoutePartId() || "")}`;
}

function getCurrentSubtitleStateRows() {
    const routeKey = getCurrentSubtitleRouteKey();
    if (subtitleUiCoordinator.rowsRouteKey === routeKey) {
        return Array.isArray(subtitleUiCoordinator.rows) ? subtitleUiCoordinator.rows : [];
    }
    return [];
}

function getSubtitleRowsStateDigest(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return makeShortDigest(list.map((row) => [
        Number(row?.start ?? row?.from ?? 0),
        Number(row?.end ?? row?.to ?? 0),
        String(row?.text ?? row?.content ?? "")
    ].join("\u0001")).join("\u0002"));
}

function getSubtitlePresentationSignature() {
    const rows = getCurrentSubtitleStateRows();
    const rowsMeta = getSubtitleDiagnosticRowsMeta(rows);
    const transcription = getTranscriptionState();
    return [
        getCurrentSubtitleRouteKey(),
        subtitleUiCoordinator.generation,
        subtitleUiCoordinator.stateVersion,
        subtitleUiCoordinator.phase,
        rowsMeta.rowCount,
        getSubtitleRowsStateDigest(rows),
        subtitleUiCoordinator.rowsSource,
        String(appState.tabState?.subtitleSource || ""),
        String(appState.tabState?.subtitleLanguage || ""),
        String(appState.activeSubtitleId || ""),
        Array.isArray(appState.subtitleOptions) ? appState.subtitleOptions.length : 0,
        String(transcription.phase || ""),
        Number(transcription.progress || 0),
        String(transcription.statusText || ""),
        !!appState.asrSession?.active,
        Number(appState.asrSession?.progress || 0),
        String(appState.asrSession?.statusText || "")
    ].join("|");
}

function renderSubtitleIfNeeded(container, reason = "state_change") {
    if (!container || appState.activePage !== "CC") return false;
    const signature = getSubtitlePresentationSignature();
    const hasPanel = !!container.querySelector?.(".cc-panel");
    const rows = getCurrentSubtitleStateRows();
    const domMatchesState = rows.length > 0
        ? doesCcDomMatchRows(container, rows)
        : (isSubtitleUiLoading() ? doesCcDomMatchLoading(container) : hasPanel);
    if (hasPanel && domMatchesState && subtitleUiCoordinator.renderedStateSignature === signature) return false;
    renderCC(container);
    subtitleUiCoordinator.renderedStateSignature = signature;
    logSubtitleDiagnostic("ui_rendered", {
        source: reason,
        routeKey: subtitleUiCoordinator.routeKey,
        phase: subtitleUiCoordinator.phase,
        rowCount: getCurrentSubtitleStateRows().length,
        stateVersion: subtitleUiCoordinator.stateVersion
    });
    if (subtitleUiCoordinator.initialAlignmentPending
        && subtitleUiCoordinator.scrollUnlockAt <= Date.now()
        && getCurrentSubtitleStateRows().length > 0) {
        subtitleUiCoordinator.initialAlignmentPending = false;
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => scrollToCurrentSubtitle(true, "auto"));
        } else {
            scrollToCurrentSubtitle(true, "auto");
        }
    }
    return true;
}

function scheduleSubtitleRender(reason = "state_change") {
    if (subtitleUiCoordinator.renderScheduled) return;
    subtitleUiCoordinator.renderScheduled = true;
    const run = () => {
        subtitleUiCoordinator.renderScheduled = false;
        const container = panelShadowRoot?.getElementById?.("page-CC");
        renderSubtitleIfNeeded(container, reason);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else Promise.resolve().then(run);
}

function markSubtitleStateChanged(reason, detail = {}) {
    subtitleUiCoordinator.stateVersion += 1;
    subtitleUiCoordinator.renderedStateSignature = "";
    logSubtitleDiagnostic("state_changed", {
        source: reason,
        routeKey: subtitleUiCoordinator.routeKey,
        phase: subtitleUiCoordinator.phase,
        rowCount: Array.isArray(subtitleUiCoordinator.rows) ? subtitleUiCoordinator.rows.length : 0,
        stateVersion: subtitleUiCoordinator.stateVersion,
        ...detail
    });
    scheduleSubtitleRender(reason);
}

function commitSubtitleRows(rows, options = {}) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return false;
    const currentBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
    const currentP = Number(getRoutePartId() || 1);
    const incomingBvid = normalizeBvidCase(options.bvid || currentBvid || "");
    const incomingP = Number(options.p || currentP || 0);
    const incomingCid = Number(options.cid || 0);
    const currentCid = Number(resolveCid() || 0);
    if ((currentBvid && incomingBvid && currentBvid !== incomingBvid)
        || (currentP > 0 && incomingP > 0 && currentP !== incomingP)
        || (currentCid > 0 && incomingCid > 0 && currentCid !== incomingCid)) {
        logSubtitleDiagnostic("state_update_rejected", {
            source: String(options.source || "unknown"),
            reason: "route_identity_mismatch",
            incomingBvid,
            incomingP,
            incomingCid,
            currentBvid,
            currentP,
            currentCid
        });
        return false;
    }
    const routeKey = getCurrentSubtitleRouteKey();
    const existingRows = subtitleUiCoordinator.rowsRouteKey === routeKey && Array.isArray(subtitleUiCoordinator.rows)
        ? subtitleUiCoordinator.rows
        : [];
    const source = String(options.source || "unknown");
    const replace = options.replace === true || source === "inject" || source === "language_switch" || !existingRows.length;
    if (!replace) {
        logSubtitleDiagnostic("state_update_skipped", {
            source,
            reason: "current_rows_already_authoritative",
            routeKey,
            incomingRowCount: list.length,
            currentRowCount: existingRows.length
        });
        return false;
    }
    const previousMeta = getSubtitleDiagnosticRowsMeta(existingRows);
    const nextMeta = getSubtitleDiagnosticRowsMeta(list);
    const unchanged = previousMeta.rowCount === nextMeta.rowCount
        && getSubtitleRowsStateDigest(existingRows) === getSubtitleRowsStateDigest(list)
        && subtitleUiCoordinator.rowsRouteKey === routeKey;
    subtitleUiCoordinator.rows = list;
    subtitleUiCoordinator.rowsRouteKey = routeKey;
    subtitleUiCoordinator.rowsSource = source;
    subtitleUiCoordinator.rowsCid = incomingCid || currentCid || 0;
    subtitleUiCoordinator.phase = "ready";
    subtitleUiCoordinator.displaySource = source;
    if (!existingRows.length || subtitleUiCoordinator.initialAlignmentPending) {
        subtitleUiCoordinator.initialAlignmentPending = true;
    }
    if (unchanged) return false;
    markSubtitleStateChanged(source, { rowCount: list.length });
    return true;
}

function isDuplicateSubtitleRouteSwitch(bvid, p) {
    const key = `${String(bvid || "").toLowerCase()}|${String(p || "")}`;
    const now = Date.now();
    if (subtitleUiCoordinator.lastRouteSwitchKey === key && now - subtitleUiCoordinator.lastRouteSwitchAt < 1500) {
        logSubtitleDiagnostic("route_switch_ignored", { routeKey: key, reason: "duplicate_route_event" });
        return true;
    }
    subtitleUiCoordinator.lastRouteSwitchKey = key;
    subtitleUiCoordinator.lastRouteSwitchAt = now;
    return false;
}

function beginSubtitleUiCycle(bvid = "", p = "") {
    const routeKey = `${String(bvid || getBvidFromUrl(location.href) || "").toLowerCase()}|${String(p || getRoutePartId() || "")}`;
    if (["probing", "loading", "requesting"].includes(subtitleUiCoordinator.phase) && subtitleUiCoordinator.routeKey === routeKey) {
        return;
    }
    subtitleUiCoordinator.routeKey = routeKey;
    subtitleUiCoordinator.phase = "probing";
    subtitleUiCoordinator.generation += 1;
    subtitleUiCoordinator.rows = [];
    subtitleUiCoordinator.rowsRouteKey = routeKey;
    subtitleUiCoordinator.rowsSource = "";
    subtitleUiCoordinator.rowsCid = 0;
    subtitleUiCoordinator.initialAlignmentPending = true;
    subtitleUiCoordinator.lastCacheApplySignature = "";
    subtitleUiCoordinator.scrollUnlockAt = Number.POSITIVE_INFINITY;
    subtitleUiCoordinator.displaySource = "";
    subtitleUiCoordinator.pendingRequestUrls = new Set();
    const generation = subtitleUiCoordinator.generation;
    appState.followCurrentIndex = -1;
    appState.renderedSubtitleIndex = -1;
    disableVideoSubtitleTrack();
    const list = panelShadowRoot?.getElementById?.("cc-list");
    if (list) list.scrollTop = 0;
    armSubtitleScrollAlignment(routeKey, generation);
    startSubtitleControlProbe(routeKey, generation);
    logSubtitleDiagnostic("ui_phase_changed", { phase: "probing", routeKey, generation });
    markSubtitleStateChanged("route_cycle_started");
}

function armSubtitleScrollAlignment(routeKey, generation) {
    const initialVideo = document.querySelector("video");
    const initialSrc = String(initialVideo?.currentSrc || initialVideo?.src || "");
    const initialTime = Number(initialVideo?.currentTime);
    let fallbackTimer = null;

    const cleanup = () => {
        document.removeEventListener("loadedmetadata", onMediaEvent, true);
        document.removeEventListener("durationchange", onMediaEvent, true);
        document.removeEventListener("timeupdate", onMediaEvent, true);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        fallbackTimer = null;
    };
    const unlock = (source, shouldAlign = true) => {
        if (subtitleUiCoordinator.generation !== generation || subtitleUiCoordinator.routeKey !== routeKey) {
            cleanup();
            return;
        }
        subtitleUiCoordinator.scrollUnlockAt = 0;
        cleanup();
        logSubtitleDiagnostic("scroll_alignment_ready", { source, routeKey, generation });
        if (shouldAlign && scrollToCurrentSubtitle(true, "auto")) {
            subtitleUiCoordinator.initialAlignmentPending = false;
        }
    };
    const onMediaEvent = (event) => {
        const video = event.target;
        if (!video || String(video.tagName || "").toLowerCase() !== "video") return;
        if (subtitleUiCoordinator.generation !== generation || subtitleUiCoordinator.routeKey !== routeKey) {
            cleanup();
            return;
        }
        if (event.type === "loadedmetadata" || event.type === "durationchange") {
            unlock(event.type);
            return;
        }
        const currentSrc = String(video.currentSrc || video.src || "");
        const currentTime = Number(video.currentTime);
        const sourceChanged = !!currentSrc && currentSrc !== initialSrc;
        const timeReset = Number.isFinite(initialTime) && Number.isFinite(currentTime) && currentTime + 2 < initialTime;
        if (sourceChanged || timeReset) unlock(sourceChanged ? "source_changed" : "time_reset");
    };

    document.addEventListener("loadedmetadata", onMediaEvent, true);
    document.addEventListener("durationchange", onMediaEvent, true);
    document.addEventListener("timeupdate", onMediaEvent, true);
    fallbackTimer = setTimeout(() => unlock("fallback", false), 5000);
}

function scheduleSubtitleUiDeadline(routeKey, generation, timeoutMs, nextPhase) {
    if (subtitleUiCoordinator.timeoutTimer) clearTimeout(subtitleUiCoordinator.timeoutTimer);
    subtitleUiCoordinator.timeoutTimer = setTimeout(() => {
        if (subtitleUiCoordinator.generation !== generation || subtitleUiCoordinator.routeKey !== routeKey) return;
        subtitleUiCoordinator.timeoutTimer = null;
        subtitleUiCoordinator.phase = nextPhase;
        logSubtitleDiagnostic("ui_phase_changed", { phase: nextPhase, routeKey, generation, source: "deadline" });
        markSubtitleStateChanged("deadline", { nextPhase });
    }, Math.max(100, Number(timeoutMs || SUBTITLE_DETECT_TIMEOUT_MS || 5000)));
}

function stopSubtitleControlProbe() {
    if (subtitleUiCoordinator.controlProbeTimer) {
        clearInterval(subtitleUiCoordinator.controlProbeTimer);
        subtitleUiCoordinator.controlProbeTimer = null;
    }
    if (subtitleUiCoordinator.controlProbeObserver) {
        subtitleUiCoordinator.controlProbeObserver.disconnect();
        subtitleUiCoordinator.controlProbeObserver = null;
    }
}

function isSubtitlePlayerReady() {
    const video = document.querySelector("video");
    return !!video && Number(video.readyState || 0) >= 1;
}

function isSubtitleControlBarReady() {
    return !!document.querySelector([
        ".bpx-player-control-bottom",
        ".bilibili-player-video-control-bottom",
        ".bpx-player-ctrl-play",
        ".bilibili-player-video-btn-start"
    ].join(", "));
}

function isUsableSubtitleControl(node) {
    if (!node || !node.isConnected) return false;
    if (node.hidden || node.getAttribute?.("aria-hidden") === "true") return false;
    if (node.hasAttribute?.("disabled") || node.getAttribute?.("aria-disabled") === "true") return false;
    if (/disabled|hidden/i.test(String(node.className || ""))) return false;
    const style = globalThis.getComputedStyle?.(node);
    if (style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)) return false;
    if (typeof node.getClientRects === "function" && node.getClientRects().length === 0) return false;
    return true;
}

function startSubtitleControlProbe(routeKey, generation) {
    stopSubtitleControlProbe();
    const startedAt = Date.now();
    let controlBarReadyAt = 0;
    const evaluate = () => {
        if (subtitleUiCoordinator.generation !== generation || subtitleUiCoordinator.routeKey !== routeKey) {
            stopSubtitleControlProbe();
            return;
        }
        const subtitleButton = document.querySelector(".bpx-player-ctrl-subtitle, .bilibili-player-video-btn-subtitle");
        if (isUsableSubtitleControl(subtitleButton)) {
            subtitleUiCoordinator.phase = "loading";
            stopSubtitleControlProbe();
            scheduleSubtitleUiDeadline(routeKey, generation, 500, "unavailable");
            logSubtitleDiagnostic("ui_phase_changed", { phase: "loading", routeKey, generation, source: "subtitle_control_found" });
            markSubtitleStateChanged("subtitle_control_found");
            return;
        }
        if (isSubtitlePlayerReady() && isSubtitleControlBarReady()) {
            if (!controlBarReadyAt) {
                controlBarReadyAt = Date.now();
                logSubtitleDiagnostic("subtitle_probe_started", { routeKey, generation, stableWindowMs: 500 });
            }
            if (Date.now() - controlBarReadyAt >= 500) {
                subtitleUiCoordinator.phase = "unavailable";
                stopSubtitleControlProbe();
                logSubtitleDiagnostic("ui_phase_changed", { phase: "unavailable", routeKey, generation, source: "subtitle_control_absent" });
                markSubtitleStateChanged("subtitle_control_absent");
            }
            return;
        }
        controlBarReadyAt = 0;
        if (Date.now() - startedAt >= 2000) {
            subtitleUiCoordinator.phase = "probe_failed";
            stopSubtitleControlProbe();
            logSubtitleDiagnostic("ui_phase_changed", { phase: "probe_failed", routeKey, generation, source: "player_not_ready" });
            markSubtitleStateChanged("player_not_ready");
        }
    };
    subtitleUiCoordinator.controlProbeTimer = setInterval(evaluate, 100);
    if (typeof MutationObserver === "function") {
        subtitleUiCoordinator.controlProbeObserver = new MutationObserver(evaluate);
        subtitleUiCoordinator.controlProbeObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    evaluate();
}

function isSubtitleRequestForCurrentRoute(detail = {}) {
    const meta = detail?.requestMeta || {};
    const currentBvid = String(getBvidFromUrl(location.href) || "").toLowerCase();
    const currentP = Number(new URL(location.href).searchParams.get("p") || 1);
    const requestBvid = String(meta?.bvid || "").toLowerCase();
    const requestP = Number(meta?.p || 0);
    if (requestBvid && currentBvid && requestBvid !== currentBvid) return false;
    if (requestP > 0 && currentP > 0 && requestP !== currentP) return false;
    return true;
}

function extendSubtitleUiLoadingForRequest(detail = {}) {
    if (!["probing", "loading", "requesting", "unavailable", "probe_failed"].includes(subtitleUiCoordinator.phase)) return;
    if (!isSubtitleRequestForCurrentRoute(detail)) return;
    stopSubtitleControlProbe();
    const routeKey = subtitleUiCoordinator.routeKey;
    const generation = subtitleUiCoordinator.generation;
    const requestUrl = String(detail?.url || "unknown");
    subtitleUiCoordinator.pendingRequestUrls.add(requestUrl);
    subtitleUiCoordinator.phase = "requesting";
    scheduleSubtitleUiDeadline(routeKey, generation, 10000, "timeout");
    logSubtitleDiagnostic("ui_loading_extended", { source: detail?.source || "inject", routeKey, generation, timeoutMs: 10000, pendingRequests: subtitleUiCoordinator.pendingRequestUrls.size });
    markSubtitleStateChanged("subtitle_request_observed");
}

function completeSubtitleUiRequest(detail = {}) {
    if (subtitleUiCoordinator.phase !== "requesting") return;
    if (!isSubtitleRequestForCurrentRoute(detail)) return;
    const requestUrl = String(detail?.url || "unknown");
    subtitleUiCoordinator.pendingRequestUrls.delete(requestUrl);
    if (subtitleUiCoordinator.pendingRequestUrls.size > 0) return;
    scheduleSubtitleUiDeadline(subtitleUiCoordinator.routeKey, subtitleUiCoordinator.generation, 1500, "unavailable");
    logSubtitleDiagnostic("ui_request_completed", { source: detail?.source || "inject", routeKey: subtitleUiCoordinator.routeKey, graceMs: 1500 });
}

function markSubtitleUiReady(source = "unknown", bvid = "", p = "") {
    const routeKey = `${String(bvid || getBvidFromUrl(location.href) || "").toLowerCase()}|${String(p || getRoutePartId() || "")}`;
    if (subtitleUiCoordinator.routeKey && subtitleUiCoordinator.routeKey !== routeKey) return;
    const alreadyReadyForRoute = subtitleUiCoordinator.phase === "ready" && subtitleUiCoordinator.routeKey === routeKey;
    subtitleUiCoordinator.routeKey = routeKey;
    subtitleUiCoordinator.phase = "ready";
    stopSubtitleControlProbe();
    subtitleUiCoordinator.pendingRequestUrls.clear();
    if (!alreadyReadyForRoute || source === "language_switch") subtitleUiCoordinator.displaySource = source;
    if (subtitleUiCoordinator.timeoutTimer) {
        clearTimeout(subtitleUiCoordinator.timeoutTimer);
        subtitleUiCoordinator.timeoutTimer = null;
    }
    logSubtitleDiagnostic("ui_phase_changed", { phase: "ready", source, routeKey, generation: subtitleUiCoordinator.generation });
    if (!alreadyReadyForRoute || source === "language_switch") {
        markSubtitleStateChanged("subtitle_ready", { readySource: source });
    }
}

function isSubtitleUiLoading() {
    const routeKey = getCurrentSubtitleRouteKey();
    return ["probing", "loading", "requesting"].includes(subtitleUiCoordinator.phase) && subtitleUiCoordinator.routeKey === routeKey;
}

function doesCcDomMatchRows(panel, rows) {
    if (!panel?.querySelector) return false;
    const expectedCount = Array.isArray(rows) ? rows.length : 0;
    const actualRows = panel.querySelectorAll?.("#cc-list .cc-row") || [];
    const actualCount = actualRows.length || 0;
    const expectedFirst = String(rows?.[0]?.text ?? rows?.[0]?.content ?? "").replace(/\s+/g, " ").trim();
    const expectedLast = String(rows?.[expectedCount - 1]?.text ?? rows?.[expectedCount - 1]?.content ?? "").replace(/\s+/g, " ").trim();
    const actualFirst = String(actualRows?.[0]?.querySelector?.(".cc-text")?.textContent || "").replace(/\s+/g, " ").trim();
    const actualLast = String(actualRows?.[actualCount - 1]?.querySelector?.(".cc-text")?.textContent || "").replace(/\s+/g, " ").trim();
    return expectedCount > 0
        && actualCount === expectedCount
        && actualFirst === expectedFirst
        && actualLast === expectedLast
        && !panel.querySelector(".subtitle-empty-container");
}

function doesCcDomMatchLoading(panel) {
    if (!panel?.querySelector) return false;
    const hasRows = !!panel.querySelector("#cc-list .cc-row");
    const statusText = String(panel.querySelector(".cc-transcribe-status")?.textContent || "");
    const tipText = String(panel.querySelector(".subtitle-empty-container .action-tip")?.textContent || "");
    return !hasRows && (statusText.includes("正在读取字幕") || tipText.includes("正在读取字幕"));
}

function retrySubtitleLoad() {
    const bvid = getBvidFromUrl(location.href) || "";
    const p = new URL(location.href).searchParams.get("p") || "";
    beginSubtitleUiCycle(bvid, p);
    logSubtitleDiagnostic("ui_retry_requested", {
        routeKey: subtitleUiCoordinator.routeKey,
        generation: subtitleUiCoordinator.generation
    });
    scheduleSubtitleRender("retry_requested");
    window.postMessage({ type: "BILI_RETRY_SUBTITLE_CAPTURE" }, "*");
}

function getFeedbackState() {
    return {
        rows: [],
        unreadCount: 0,
        enabled: true,
        loading: false,
        submitting: false,
        statusText: "",
        errorText: "",
        loadedAt: 0,
        ...(appState.feedback || {})
    };
}

function normalizeCloudCachePrefs(value = {}) {
    return {
        all: !!value?.all,
        current: !!value?.current
    };
}

function renderVersionUpdateBadge() {
    const state = appState.versionState || {};
    if (!state.hasUpdate) return "";
    return `<button type="button" class="version-update-badge" data-action="open-extension-management" data-button-tooltip="跳转插件页后请在左上角找到“更新”按钮以更新插件">有可用版本更新</button>`;
}

function showDebugVersionUpdateBadge() {
    appState.versionState = {
        currentVersion: globalThis.chrome?.runtime?.getManifest?.()?.version || "1.4.3",
        latestVersion: "1.4.4-test",
        hasUpdate: true,
        releaseUrl: "",
        checkedAt: Date.now()
    };
    const badgeHost = panelShadowRoot?.querySelector(".plugin-brand-title");
    if (badgeHost) {
        badgeHost.querySelector(".version-update-badge")?.remove();
        badgeHost.insertAdjacentHTML("beforeend", renderVersionUpdateBadge());
    } else {
        renderApp();
    }
    showToast("已显示可用版本更新入口");
}

async function checkLatestVersionAvailability({ force = false } = {}) {
    try {
        const res = await chrome.runtime.sendMessage({ action: "CHECK_LATEST_VERSION", force });
        if (!res?.ok) return;
        appState.versionState = res.versionState || null;
        const badgeHost = panelShadowRoot?.querySelector(".plugin-brand-title");
        if (badgeHost) badgeHost.querySelector(".version-update-badge")?.remove();
        if (badgeHost && appState.versionState?.hasUpdate) {
            badgeHost.insertAdjacentHTML("beforeend", renderVersionUpdateBadge());
        }
    } catch (_) {}
}

function scheduleVersionAvailabilityCheck() {
    if (appState.versionCheckTimer) return;
    checkLatestVersionAvailability();
    appState.versionCheckTimer = setInterval(() => {
        checkLatestVersionAvailability();
    }, 12 * 60 * 60 * 1000);
}

function reportUsageEvent(payload = {}) {
    try {
        const settings = appState.settings || {};
        const bvid = normalizeBvidCase(payload.bvid || resolveCurrentBvid() || appState.tabState?.activeBvid || "");
        const provider = String(payload.provider || settings.provider || "").trim();
        const providerModels = settings.providerModels && typeof settings.providerModels === "object" ? settings.providerModels : {};
        const model = String(payload.model || providerModels[provider] || settings.model || "").trim();
        const result = chrome.runtime?.sendMessage?.({
            action: "REPORT_USAGE_EVENT",
            payload: {
                ...payload,
                provider,
                model,
                bvid,
                title: payload.title || cleanBilibiliTitle(document.title),
                metadata: {
                    active_page: appState.activePage || "",
                    ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {})
                }
            }
        });
        if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {}
}

function reportActiveFeatureViewed(entryPoint = "navigation") {
    const featureName = String(appState.activePage || "").trim();
    if (!["CC", "summary", "chat", "real", "settings"].includes(featureName)) return;
    const cache = appState.cache && typeof appState.cache === "object" ? appState.cache : {};
    const metadata = {
        entry_point: entryPoint,
        has_content: false,
        result_source: ""
    };
    if (featureName === "summary") {
        metadata.has_content = !!String(cache.summary || "").trim()
            || (Array.isArray(cache.segments) && cache.segments.length > 0);
        metadata.result_source = getTaskCacheSource(cache, "summary")
            || getTaskCacheSource(cache, "segments")
            || "";
    } else if (featureName === "CC") {
        metadata.has_content = (Array.isArray(cache.rawSubtitle) && cache.rawSubtitle.length > 0)
            || (Array.isArray(cache.processedSubtitle) && cache.processedSubtitle.length > 0);
        metadata.result_source = String(cache.subtitleSource || appState.tabState?.subtitleSource || "");
    } else if (featureName === "chat") {
        metadata.has_content = Array.isArray(cache.history) && cache.history.length > 0;
    } else if (featureName === "real") {
        metadata.has_content = !!cache.rumors;
        metadata.result_source = getTaskCacheSource(cache, "rumors") || "";
    } else if (featureName === "settings") {
        metadata.has_content = true;
    }
    reportUsageEvent({
        eventName: "feature_viewed",
        featureName,
        status: metadata.has_content ? "content" : "empty",
        metadata
    });
}

async function setFeedbackSubmissionState(submitted) {
    const nextValue = !!submitted;
    appState.feedbackHasSubmission = nextValue;
    try {
        await chrome.storage.local.set({ [FEEDBACK_SUBMITTED_STORAGE_KEY]: nextValue });
    } catch (_) {}
}

async function loadFeedbackSubmissionState(feedback = null) {
    const hasRows = Array.isArray(feedback?.rows) && feedback.rows.length > 0;
    if (hasRows) {
        await setFeedbackSubmissionState(true);
        return true;
    }
    try {
        const stored = await chrome.storage.local.get([FEEDBACK_SUBMITTED_STORAGE_KEY]);
        const submitted = stored?.[FEEDBACK_SUBMITTED_STORAGE_KEY] === true;
        appState.feedbackHasSubmission = submitted;
        return submitted;
    } catch (_) {
        appState.feedbackHasSubmission = false;
        return false;
    }
}

function setFeedbackState(patch = {}) {
    appState.feedback = {
        ...getFeedbackState(),
        ...(patch || {})
    };
}

function hasFeedbackUnread() {
    return Number(getFeedbackState().unreadCount || 0) > 0;
}

function isFeedbackRowUnread(row = {}) {
    const updatedAt = Date.parse(row.updatedAt || "");
    const seenAt = Date.parse(row.seenAt || "");
    if (!Number.isFinite(updatedAt)) return false;
    return !Number.isFinite(seenAt) || updatedAt > seenAt + 1000;
}

function getUnreadFeedbackIds(rows = []) {
    return new Set((Array.isArray(rows) ? rows : []).filter(isFeedbackRowUnread).map((row) => String(row.id || "")).filter(Boolean));
}

function shouldShowFeedbackItemDot(row = {}) {
    const id = String(row.id || "");
    return !!id && (isFeedbackRowUnread(row) || appState.feedbackVisibleUnreadIds?.has?.(id));
}

function getDefaultTranscriptionState() {
    return {
        phase: "idle",
        bvid: "",
        progress: 0,
        statusText: ""
    };
}

function getTranscriptionState() {
    return {
        ...getDefaultTranscriptionState(),
        ...(appState.transcription || {})
    };
}

function getStableCurrentBvid() {
    return normalizeBvidCase(
        resolveCurrentBvid() ||
        getBvidFromUrl(location.href) ||
        appState.injectBvid ||
        appState.tabState?.activeBvid ||
        appState.cache?.bvid ||
        ""
    );
}

function isAsrSessionActiveForCurrent(targetBvid = "") {
    const session = appState.asrSession || {};
    if (!session.active) return false;
    const currentBvid = normalizeBvidCase(targetBvid || getStableCurrentBvid() || "");
    const sessionBvid = normalizeBvidCase(session.bvid || "");
    return !currentBvid || !sessionBvid || currentBvid === sessionBvid;
}

function beginAsrSession({ bvid = "", runId = "", statusText = "正在请求转录...", progress = 0, stage = "start" } = {}) {
    const normalizedBvid = normalizeBvidCase(bvid || getStableCurrentBvid() || "");
    appState.asrSession = {
        active: true,
        bvid: normalizedBvid,
        runId: String(runId || ""),
        stage: String(stage || "start"),
        progress: Math.max(0, Math.min(100, Number(progress) || 0)),
        statusText: String(statusText || "正在请求转录..."),
        startedAt: Date.now()
    };
    setLocalPendingTranscription(true, normalizedBvid);
    logAsrUiTrace("session_begin", {
        bvid: normalizedBvid,
        run_id: appState.asrSession.runId,
        stage: appState.asrSession.stage,
        progress: appState.asrSession.progress,
        status_text: appState.asrSession.statusText
    });
    return appState.asrSession;
}

function updateAsrSession(patch = {}) {
    const current = appState.asrSession || {};
    const patchBvid = normalizeBvidCase(patch.bvid || "");
    const currentBvid = normalizeBvidCase(current.bvid || "");
    if (!current.active && !patchBvid && !currentBvid) return current;
    if (current.active && patchBvid && currentBvid && patchBvid !== currentBvid) return current;
    const incomingProgress = Number(patch.progress);
    const nextProgress = Number.isFinite(incomingProgress)
        ? Math.max(Number(current.progress || 0), Math.max(0, Math.min(100, incomingProgress)))
        : Number(current.progress || 0);
    appState.asrSession = {
        active: patch.active ?? current.active ?? true,
        bvid: patchBvid || currentBvid || getStableCurrentBvid(),
        runId: String(patch.runId ?? current.runId ?? ""),
        stage: String(patch.stage ?? current.stage ?? ""),
        progress: nextProgress,
        statusText: String(patch.statusText ?? current.statusText ?? ""),
        startedAt: Number(current.startedAt || Date.now())
    };
    if (appState.asrSession.active) setLocalPendingTranscription(true, appState.asrSession.bvid);
    logAsrUiTrace("session_update", {
        patch,
        before: {
            active: !!current.active,
            bvid: current.bvid || "",
            stage: current.stage || "",
            progress: Number(current.progress || 0),
            status_text: current.statusText || ""
        },
        after: {
            active: !!appState.asrSession.active,
            bvid: appState.asrSession.bvid || "",
            stage: appState.asrSession.stage || "",
            progress: Number(appState.asrSession.progress || 0),
            status_text: appState.asrSession.statusText || ""
        }
    });
    return appState.asrSession;
}

function clearAsrSession() {
    const before = { ...(appState.asrSession || {}) };
    appState.asrSession = {
        active: false,
        bvid: "",
        runId: "",
        stage: "",
        progress: 0,
        statusText: "",
        startedAt: 0
    };
    setLocalPendingTranscription(false);
    logAsrUiTrace("session_clear", {
        before: {
            active: !!before.active,
            bvid: before.bvid || "",
            stage: before.stage || "",
            progress: Number(before.progress || 0),
            status_text: before.statusText || ""
        }
    });
}

function logAsrUiTrace(event, detail = {}) {
    const entry = {
        time: new Date().toISOString(),
        event: String(event || "asr_ui_trace"),
        detail: detail && typeof detail === "object" ? detail : { value: detail }
    };
    const nextLogs = Array.isArray(appState.asrUiTraceLogs) ? [...appState.asrUiTraceLogs, entry] : [entry];
    appState.asrUiTraceLogs = nextLogs.slice(-300);
    if (appState.activePage === "debug" && appState.debugToolsTab === "logs") {
        renderRealtimeLogData();
    }
}

function patchTranscriptionState(patch = {}) {
    const current = getTranscriptionState();
    const nextPatch = { ...(patch || {}) };
    if (Object.prototype.hasOwnProperty.call(nextPatch, "progress")) {
        const currentProgress = Number(current.progress || 0);
        const incomingProgress = Math.max(0, Math.min(100, Number(nextPatch.progress) || 0));
        const sameTask = !nextPatch.bvid || !current.bvid || normalizeBvidCase(nextPatch.bvid) === normalizeBvidCase(current.bvid);
        const stillRunning = current.phase === "running" || nextPatch.phase === "running";
        const startsNewRun = nextPatch.phase === "running" && current.phase !== "running" && incomingProgress <= 10;
        nextPatch.progress = !startsNewRun && sameTask && stillRunning && incomingProgress < currentProgress
            ? currentProgress
            : incomingProgress;
    }
    appState.transcription = {
        ...current,
        ...nextPatch
    };
    return appState.transcription;
}

function resetTranscriptionState(patch = {}) {
    appState.transcription = {
        ...getDefaultTranscriptionState(),
        ...(patch || {})
    };
    return appState.transcription;
}

function getTranscriptionBvid() {
    return normalizeBvidCase(getTranscriptionState().bvid || "");
}

function isLocalPendingTranscriptionForCurrent(targetBvid = "") {
    const value = appState.localPending?.transcription;
    if (!value) return false;
    if (value === true) return true;
    const currentBvid = normalizeBvidCase(targetBvid || getStableCurrentBvid() || "");
    const pendingBvid = normalizeBvidCase(value || "");
    return !currentBvid || !pendingBvid || currentBvid === pendingBvid;
}

function isTranscriptionRunning() {
    const state = getTranscriptionState();
    return isAsrSessionActiveForCurrent() || isLocalPendingTranscriptionForCurrent() || state.phase === "running";
}

function hasLocalPendingTask(task) {
    const value = appState.localPending?.tasks?.[task];
    if (!value) return false;
    if (value === true) return true;
    const currentBvid = normalizeBvidCase(resolveCurrentBvid() || "");
    const pendingBvid = normalizeBvidCase(value || "");
    return !currentBvid || !pendingBvid || currentBvid === pendingBvid;
}

function hasLocalPendingTasks(tasks) {
    return (Array.isArray(tasks) ? tasks : []).some((task) => hasLocalPendingTask(task));
}

function setLocalPendingTasks(tasks, value) {
    const nextTasks = { ...(appState.localPending?.tasks || {}) };
    const pendingBvid = normalizeBvidCase(resolveCurrentBvid() || "") || true;
    (Array.isArray(tasks) ? tasks : []).forEach((task) => {
        if (!task) return;
        if (value) nextTasks[task] = pendingBvid;
        else delete nextTasks[task];
    });
    appState.localPending = {
        ...(appState.localPending || {}),
        tasks: nextTasks
    };
}

function setLocalPendingTranscription(value, bvid = "") {
    appState.localPending = {
        ...(appState.localPending || {}),
        transcription: value ? (normalizeBvidCase(bvid || resolveCurrentBvid() || "") || true) : false
    };
}

function mergeIncomingTabState(incomingTabState) {
    if (!incomingTabState || typeof incomingTabState !== "object") return;
    const incomingBvid = normalizeBvidCase(incomingTabState?.activeBvid || "");
    const runningBvid = normalizeBvidCase(appState.asrSession?.bvid || getTranscriptionBvid() || appState.injectBvid || "");
    const keepRunningTranscriptionState = isTranscriptionRunning()
        && runningBvid
        && (!incomingBvid || incomingBvid === runningBvid);
    if (!keepRunningTranscriptionState) {
        appState.tabState = incomingTabState;
        return;
    }
    const currentProgress = Math.max(
        Number(appState.tabState?.transcriptionProgress || 0),
        Number(getTranscriptionState().progress || 0),
        Number(appState.asrSession?.progress || 0)
    );
    const incomingProgress = Number(incomingTabState?.transcriptionProgress || 0);
    appState.tabState = {
        ...incomingTabState,
        activeBvid: incomingBvid || runningBvid,
        transcriptionProgress: Math.max(currentProgress, incomingProgress)
    };
    logAsrUiTrace("tab_state_preserved_during_asr", {
        incoming_bvid: incomingBvid,
        preserved_bvid: appState.tabState.activeBvid,
        incoming_progress: incomingProgress,
        preserved_progress: appState.tabState.transcriptionProgress
    });
}
function toErrorInput(error, fallbackMessage = "请求失败") {
    return {
        message: String(error?.message || error?.error || fallbackMessage),
        code: String(error?.code || ""),
        status: Number(error?.status || 0) || undefined,
        retryAfterSec: Number(error?.retryAfterSec || appState.asrRateLimitRetryAfterSec || 0) || undefined
    };
}

function setPanelError(page, error, fallbackMessage = "请求失败") {
    const view = mapErrorToView ? mapErrorToView(toErrorInput(error, fallbackMessage), fallbackMessage, {
        provider: appState.settings?.provider || "",
        surface: "panel"
    }) : null;
    if (!view) return null;
    appState.panelErrors = {
        ...(appState.panelErrors || {}),
        [page]: view
    };
    return view;
}

function clearPanelError(page) {
    if (!appState.panelErrors?.[page]) return;
    appState.panelErrors = {
        ...(appState.panelErrors || {}),
        [page]: null
    };
}

function notifyMappedError(error, fallbackMessage = "请求失败") {
    const view = mapErrorToView ? mapErrorToView(toErrorInput(error, fallbackMessage), fallbackMessage, {
        provider: appState.settings?.provider || ""
    }) : null;
    showToast(view?.message || fallbackMessage);
    return view;
}

function runErrorDisplayDemo(code, target = "summary") {
    const normalizedCode = String(code || "UNKNOWN").trim();
    const page = String(target || "summary");
    recordDebugScenarioResult({
        id: `error_${normalizedCode.toLowerCase()}`,
        title: `错误展示 · ${normalizedCode}`,
        status: "passed",
        expected: `在${page === "chat" ? "聊天" : page === "real" ? "验真" : page === "CC" ? "字幕" : "总结"}页面展示对应错误`,
        actual: `已注入 ${normalizedCode}`,
        durationMs: 0
    });
    logUI.info("debug_error_demo", {
        task: "debug",
        code: normalizedCode,
        detail: { target: page }
    });
    const error = {
        code: normalizedCode,
        status: normalizedCode.match(/^HTTP_(\d{3})$/)?.[1] ? Number(normalizedCode.match(/^HTTP_(\d{3})$/)?.[1]) : undefined,
        message: normalizedCode,
        provider: appState.settings?.provider || ""
    };
    const view = mapErrorToView ? mapErrorToView(error, "测试错误", {
        provider: appState.settings?.provider || ""
    }) : null;
    if (!view) return;
    if (view.presentation === "toast") {
        showToast(view.message);
        return;
    }
    const targetPage = ["summary", "chat", "real", "CC"].includes(page) ? page : "summary";
    appState.panelErrors = {
        ...(appState.panelErrors || {}),
        [targetPage]: view
    };
    appState.activePage = targetPage;
    renderNav();
    renderContent();
}
const logContent = globalThis.AIPluginLogger.create("content", {
    getDebugMode: () => isDebugLoggingEnabled()
});
const logUI = globalThis.AIPluginLogger.create("ui", {
    getDebugMode: () => isDebugLoggingEnabled()
});
const logDownload = globalThis.AIPluginLogger.create("download", {
    getDebugMode: () => isDebugLoggingEnabled()
});
const logInject = globalThis.AIPluginLogger.create("inject", {
    getDebugMode: () => isDebugLoggingEnabled()
});
let logWindowVisible = false;

bootstrap();


async function bootstrap() {
    injectScriptBridge();
    scheduleInjectRetry();
    window.addEventListener("message", onInjectMessage, false);
    chrome.runtime.onMessage.addListener(onBackgroundMessage);
    chrome.runtime.onMessage.addListener(onSidePanelMessage);
    window.addEventListener("keydown", isolateChatInputKeyboardEvent, true);
    window.addEventListener("keydown", onGlobalShortcut, true);
    window.addEventListener("resize", syncPanelHeightMode);
    chrome.storage.onChanged.addListener(onStorageChanged);
    startRouteWatcher();
    await waitPanelMount();
    await loadBootstrapData();
    reportUsageEvent({
        eventName: "extension_started",
        featureName: "extension",
        status: "started",
        metadata: { route_key: getCurrentRouteVideoKey() }
    });
    globalThis.AIPluginLogger?.setDebugEnabled?.(isDebugLoggingEnabled());
    syncInjectDebugMode();
    appState.injectBvid = normalizeBvidCase(getBvidFromUrl(location.href) || appState.tabState?.activeBvid || "");
    appState.injectBvidChangedAt = Date.now();
    beginSubtitleObservation(appState.injectBvid);
    startSubtitleCheckTimer();
    await syncCacheFromBackground(getBvidFromUrl(location.href) || appState.tabState?.activeBvid);
    evaluateSubtitleFallback();
    setInterval(evaluateSubtitleFallback, 3500);
    renderApp();
    reportActiveFeatureViewed("bootstrap");
    startFocusTicker();
    Object.defineProperty(window, '__biliDebug', { get: () => appState });
}

function injectScriptBridge() {
    if (appState.injectReady) return;
    if (document.getElementById("bili-ai-inject-bridge")) return;
    const script = document.createElement("script");
    script.id = "bili-ai-inject-bridge";
    script.src = chrome.runtime.getURL("inject.js");
    script.async = false;
    script.onload = () => {
        script.remove();
    };
    script.onerror = () => {
        script.remove();
        appState.injectReady = true;
        logContent.error("inject_load_error", {
            task: "subtitle",
            code: "INJECT_LOAD_FAILED",
            detail: { has_src: !!script.src }
        });
        scheduleInjectRetry();
    };
    (document.head || document.documentElement).appendChild(script);
}

async function onInjectMessage(event) {
    const msgType = String(event?.data?.type || "");
    if (!msgType.startsWith("BILI_")) return;
    if (msgType === "BILI_SUBTITLE_DATA") {
        logSubtitleDiagnostic("source_received", {
            source: "inject",
            bvid: String(event.data?.bvid || ""),
            p: String(event.data?.p || event.data?.tid || ""),
            cid: Number(event.data?.cid || 0),
            subtitleUrl: String(event.data?.subtitleUrl || ""),
            ...getSubtitleDiagnosticRowsMeta(event.data?.data)
        });
        if (Array.isArray(event.data?.data) && event.data.data.length) {
            markSubtitleUiReady("inject", event.data?.bvid, event.data?.p || event.data?.tid);
        }
    }
    if (msgType === "BILI_INJECT_READY" || msgType === "BILI_SUBTITLE_HANDSHAKE") {
        appState.injectReady = true;
        beginSubtitleObservation(appState.injectBvid || resolveCurrentBvid());
        if (appState.injectRetryTimer) {
            clearInterval(appState.injectRetryTimer);
            appState.injectRetryTimer = null;
        }
        if (msgType === "BILI_SUBTITLE_HANDSHAKE") {
            const partCount = Number(event?.data?.partCount || 0);
            if (partCount > 0) appState.injectPartCount = partCount;
            pushSubtitleTimeline("handshake", {
                bvid: String(event?.data?.bvid || "").trim(),
                cid: Number(event?.data?.cid || 0)
            });
            scheduleTranscriptionAvailabilityCheck("handshake");
            flushPendingSubtitleIfReady();
        } else {
            pushSubtitleTimeline("inject_ready");
            logContent.info("subtitle_detected", { source: "inject_ready" });
        }
        return;
    }
    if (msgType === "BILI_INJECT_LOG") {
        appState.injectReady = true;
        logInject.debug(event.data.event || "subtitle_detected", event.data.detail || {});
        if (event.data.event === "subtitle_request_start") {
            extendSubtitleUiLoadingForRequest(event.data?.detail || {});
        } else if (event.data.event === "subtitle_response_done") {
            completeSubtitleUiRequest(event.data?.detail || {});
        }
        if (event.data.event === "subtitle_detected") {
            pushSubtitleTimeline("inject_detected", {
                source: String(event?.data?.detail?.source || "")
            });
            scheduleTranscriptionAvailabilityCheck("inject_log");
        }
        return;
    }
    if (msgType === "BILI_PLAYINFO_DATA") {
        if (event.data?.info) {
            const normalizedInfo = normalizeIncomingPlayInfo(event.data.info);
            const pageBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
            const infoBvid = normalizeBvidCase(normalizedInfo?._bvid || "");
            if (normalizedInfo && (!pageBvid || !infoBvid || infoBvid === pageBvid)) {
                const partCount = Number(normalizedInfo?._partCount || 0);
                if (partCount > 0) appState.injectPartCount = partCount;
                acceptConfirmedRouteCid(infoBvid || pageBvid, Number(normalizedInfo?._cid || 0), "playinfo");
                appState.playInfo = normalizedInfo;
                appState.playInfoUpdatedAt = Date.now();
                appState.isPlayInfoReady = hasUsablePlayInfoForBvid(normalizedInfo, pageBvid || infoBvid);
                resolvePlayInfoWaiters(normalizedInfo);
                logContent.info("playinfo_received", {
                    bvid: infoBvid,
                    video_count: normalizedInfo.video?.length || 0,
                    audio_count: normalizedInfo.audio?.length || 0,
                    ready: appState.isPlayInfoReady
                });
                const exportMenu = panelShadowRoot ? panelShadowRoot.getElementById("export-option-menu") : null;
                if (exportMenu?.dataset?.streamLoading === "video" || exportMenu?.dataset?.streamLoading === "audio") {
                    renderQualityList(exportMenu, exportMenu.dataset.streamLoading);
                } else if (exportMenu && exportMenu.querySelector('[data-action="download-video"]')) {
                    renderExportMainMenu(exportMenu);
                }
            }
        }
        return;
    }
    if (msgType === "BILI_ROUTE_SWITCH") {
        // Notify background to abort ongoing transcription for previous BVID
        chrome.runtime.sendMessage({ action: "ABORT_TRANSCRIPTION", bvid: getTranscriptionBvid() }).catch(() => {});
        const routeBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
        const routeP = String(getRoutePartId() || event.data?.p || event.data?.tid || "");
        if (isDuplicateSubtitleRouteSwitch(routeBvid, routeP)) return;
        resetAllState();
        const routeCid = Number(event.data?.cid || 0);
        const routePartCount = Number(event.data?.partCount || 0);
        beginSubtitleUiCycle(routeBvid, routeP);
        appState.routeWatchBvid = routeBvid;
        appState.routeWatchKey = getCurrentRouteVideoKey();
        appState.injectBvid = routeBvid;
        appState.injectCid = Number.isFinite(routeCid) && routeCid > 0 ? routeCid : 0;
        appState.injectPartCount = Number.isFinite(routePartCount) && routePartCount > 0 ? routePartCount : 0;
        appState.tabState = {
            ...(appState.tabState || {}),
            activeBvid: routeBvid || appState.tabState?.activeBvid || "",
            activeCid: appState.injectCid,
            activeTid: getRoutePartId() || null,
            activePartCount: appState.injectPartCount,
            updatedAt: Date.now()
        };
        chrome.runtime.sendMessage({
            action: "SET_ACTIVE_PART",
            bvid: routeBvid,
            cid: appState.injectCid,
            tid: getRoutePartId() || null,
            partCount: appState.injectPartCount
        }).catch(() => {});
        clearCCListImmediately();
        renderContent();
        waitForAlignedPlayInfo(routeBvid).catch(() => {});
        return;
    }
    if (msgType !== "BILI_SUBTITLE_DATA") return;
    appState.subtitleDomDetected = true;
    pushSubtitleTimeline("inject_data_received", {
        count: Array.isArray(event.data?.data) ? event.data.data.length : 0
    });
    scheduleTranscriptionAvailabilityCheck("subtitle_data");
    const subtitles = Array.isArray(event.data?.data) ? event.data.data : [];
    if (!subtitles.length) {
        logContent.warn("subtitle_detected", { source: "inject_message_empty" });
        return;
    }
    const bvid = normalizeBvidCase(event.data?.bvid) || normalizeBvidCase(resolveCurrentBvid());
    const cid = Number(event.data?.cid || 0);
    const partCount = Number(event.data?.partCount || 0);
    if (partCount > 0) appState.injectPartCount = partCount;
    const currentUrlBvid = normalizeBvidCase(getBvidFromUrl(location.href));
    if (bvid && currentUrlBvid && bvid !== currentUrlBvid) {
        pushSubtitleTimeline("drop_mismatch_bvid", { payloadBvid: bvid, currentBvid: currentUrlBvid });
        return;
    }
    const payloadP = Number(event.data?.p || event.data?.tid || 0);
    const currentUrlP = Number(getRoutePartId() || 1);
    if ((!payloadP || !currentUrlP || payloadP === currentUrlP) && cid > 0) {
        acceptConfirmedRouteCid(bvid || currentUrlBvid, cid, "subtitle_payload");
    }
    const payloadRouteKey = `${String(bvid || currentUrlBvid || "").toLowerCase()}|${String(payloadP || currentUrlP || "")}`;
    const canDirectRenderCurrentRoute = (!payloadP || !currentUrlP || payloadP === currentUrlP)
        && (!subtitleUiCoordinator.routeKey || subtitleUiCoordinator.routeKey === payloadRouteKey);
    const pendingPayload = {
        bvid,
        cid: Number.isFinite(cid) && cid > 0 ? cid : (appState.injectCid || 0),
        tid: getTidFromUrl(location.href),
        title: cleanBilibiliTitle(document.title),
        subtitle: subtitles,
        p: Number(event.data?.p || 0) || undefined,
        part: String(event.data?.part || ""),
        duration: Number(event.data?.duration || 0) || 0,
        partCount: Number(event.data?.partCount || 0) || 0,
        subtitleLanguage: String(event.data?.language || ""),
        subtitleLanguageLabel: String(event.data?.languageLabel || ""),
        subtitleUrl: String(event.data?.subtitleUrl || "")
    };
    const languageSwitch = appState.pendingSubtitleLanguageSwitch;
    if (languageSwitch && (!languageSwitch.bvid || normalizeBvidCase(languageSwitch.bvid) === bvid)) {
        pendingPayload.source = "official";
        pendingPayload.subtitleLanguage = String(languageSwitch.id || "");
        pendingPayload.subtitleLanguageLabel = String(languageSwitch.label || "");
        pendingPayload.clearDerived = true;
        appState.activeSubtitleId = String(languageSwitch.id || "");
    } else {
        const selectedSubtitleOption = findSubtitleOption(appState.subtitleOptions, appState.activeSubtitleId)
            || pickSubtitle(appState.subtitleOptions);
        pendingPayload.source = "official";
        pendingPayload.subtitleLanguage = "zh";
        pendingPayload.subtitleLanguageLabel = "中文";
        pendingPayload.subtitleUrl = selectedSubtitleOption?.url || pendingPayload.subtitleUrl;
        appState.activeSubtitleId = "zh";
    }
    if (!pendingPayload.bvid) {
        appState.pendingSubtitle = pendingPayload;
        logContent.info("subtitle_detected", { source: "pending_subtitle_set", count: subtitles.length, bvid: currentUrlBvid || "" });
        pushSubtitleTimeline("pending_wait_bvid", { count: subtitles.length });
        logContent.warn("subtitle_detected", { source: "inject_message_pending_bvid", count: subtitles.length });
        scheduleTranscriptionAvailabilityCheck("pending_bvid");
        return;
    }
    const immediateContainer = panelShadowRoot?.getElementById("page-CC") || document.getElementById("page-CC");
    if (immediateContainer && canDirectRenderCurrentRoute) {
        logSubtitleDiagnostic("direct_render", {
            source: "inject",
            bvid: pendingPayload.bvid,
            p: String(pendingPayload.p || pendingPayload.tid || ""),
            cid: Number(pendingPayload.cid || 0),
            ...getSubtitleDiagnosticRowsMeta(subtitles)
        });
        commitSubtitleRows(subtitles, {
            source: languageSwitch ? "language_switch" : "inject",
            bvid: pendingPayload.bvid,
            p: pendingPayload.p || currentUrlP,
            cid: pendingPayload.cid,
            replace: true
        });
    } else if (immediateContainer) {
        logSubtitleDiagnostic("direct_render_skipped", {
            source: "inject",
            reason: payloadP && currentUrlP && payloadP !== currentUrlP ? "payload_p_mismatch" : "route_state_not_aligned",
            payloadRouteKey,
            coordinatorRouteKey: subtitleUiCoordinator.routeKey
        });
    }
    await forwardSubtitlePayload(pendingPayload, "inject_message_forwarded");
    if (!languageSwitch) {
        applyOfficialSubtitleVariantToLocalCache({
            bvid,
            option: { id: "zh", label: "中文", url: pendingPayload.subtitleUrl || "" },
            rows: subtitles,
            languageKey: "zh"
        });
    }
    if (languageSwitch) appState.pendingSubtitleLanguageSwitch = null;
    const currentBvid = normalizeBvidCase(resolveCurrentBvid() || "");
    const currentCid = resolveCid();
    if ((currentBvid && normalizeBvidCase(pendingPayload.bvid) !== currentBvid) || (currentCid > 0 && pendingPayload.cid > 0 && currentCid !== pendingPayload.cid)) {
        logContent.warn("subtitle_detected", {
            source: "stale_ui_skip",
            bvid: pendingPayload.bvid,
            cid: pendingPayload.cid,
            current_bvid: currentBvid,
            current_cid: currentCid
        });
        return;
    }
    commitSubtitleRows(subtitles, {
        source: languageSwitch ? "language_switch" : "inject",
        bvid: pendingPayload.bvid,
        p: pendingPayload.p || currentUrlP,
        cid: pendingPayload.cid,
        replace: true
    });
}

function onStorageChanged(changes, areaName) {
    if (areaName !== "local") return;
    logContent.debug("storage_listener_trigger", { keys: Object.keys(changes || {}) });
    logAsrUiTrace("storage_changed", {
        keys: Object.keys(changes || {}),
        tab_state_key: getTabStateKey(),
        active_bvid_before: normalizeBvidCase(appState.tabState?.activeBvid || ""),
        tab_progress_before: Number(appState.tabState?.transcriptionProgress || 0),
        session: {
            active: !!appState.asrSession?.active,
            bvid: appState.asrSession?.bvid || "",
            stage: appState.asrSession?.stage || "",
            progress: Number(appState.asrSession?.progress || 0)
        }
    });
    const beforeBvid = normalizeBvidCase(appState.tabState?.activeBvid);
    const beforeCid = Number(appState.tabState?.activeCid || 0);
    const routeBvid = normalizeBvidCase(getBvidFromUrl(location.href));
    const tabStateBefore = appState.tabState;
    if (changes.settings?.newValue) {
        const previousDisplayMode = resolvePluginDisplayMode(changes.settings.oldValue || appState.settings || {});
        appState.settings = changes.settings.newValue;
        appState.cloudCachePrefs = {
            ...normalizeCloudCachePrefs(appState.cloudCachePrefs),
            all: !!changes.settings.newValue.disableCloudCacheRead
        };
        globalThis.AIPluginLogger?.setDebugEnabled?.(isDebugLoggingEnabled());
        syncInjectDebugMode();
        if (previousDisplayMode !== resolvePluginDisplayMode(appState.settings)) {
            resetPanelCollapseForCurrentPart();
        }
    }
    if (changes.cloudReadDisabledBvids) {
        const target = normalizeBvidCase(resolveCurrentBvid() || appState.cache?.bvid || "");
        const map = changes.cloudReadDisabledBvids.newValue && typeof changes.cloudReadDisabledBvids.newValue === "object"
            ? changes.cloudReadDisabledBvids.newValue
            : {};
        appState.cloudCachePrefs = {
            ...normalizeCloudCachePrefs(appState.cloudCachePrefs),
            current: !!(target && map[target])
        };
    }
    if (changes.providers?.newValue) appState.providers = changes.providers.newValue;
    const newKey = String(changes.settings?.newValue?.apiKey || "").trim();
    const prevKey = String(changes.settings?.oldValue?.apiKey || "").trim();
    if (!prevKey && newKey) {
        if (panelShadowRoot?.getElementById("setup-guide-overlay")) {
            closeSetupGuide();
            showToast("配置成功，AI 功能已解锁 🎉");
        }
    }
    const tabKey = getTabStateKey();
    if (tabKey && changes[tabKey]?.newValue) {
        mergeIncomingTabState(changes[tabKey].newValue);
        syncStepProgressByTaskState(appState.tabState);
    }
    const afterBvid = normalizeBvidCase(appState.tabState?.activeBvid);
    const activeCid = Number(appState.tabState?.activeCid || 0);
    if (beforeCid > 0 && activeCid > 0 && beforeCid !== activeCid) {
        resetPanelCollapseForCurrentPart();
    }
    const routeMismatch = !!(routeBvid && afterBvid && String(afterBvid) !== routeBvid);
    const runningBvid = normalizeBvidCase(appState.asrSession?.bvid || getTranscriptionBvid() || "");
    const switched = !!(beforeBvid && afterBvid && beforeBvid !== afterBvid);
    const switchedIntoRunningBvid = !!(switched && runningBvid && afterBvid === runningBvid);
    const shouldResetForSwitch = switched && !switchedIntoRunningBvid;
    if (shouldResetForSwitch) {
        pushSubtitleTimeline("bvid_switch", { from: beforeBvid, to: afterBvid || "" });
        resetPageStateByBvidSwitch();
        clearStreamCache();
        
        appState.activePage = resolveDefaultOpenPage(appState.settings?.defaultOpenPage);
        renderNav();
        clearCCListImmediately();
    }
    const candidateCacheKeys = [...new Set([beforeBvid, afterBvid, routeBvid].filter(Boolean).map((bvid) => `cache_${bvid}`))];
    if (!shouldResetForSwitch && !routeMismatch) {
        const currentRoute = normalizeBvidCase(getBvidFromUrl(location.href));
        const storageCandidates = candidateCacheKeys
            .map((key) => {
                const directory = changes[key]?.newValue;
                if (directory) logCacheDirectoryStructure(directory, key);
                return {
                    key,
                    directory,
                    cache: selectCacheDirectoryPart(
                        directory,
                        currentRoute || afterBvid || beforeBvid,
                        getCurrentRouteCid()
                    )
                };
            })
            .filter((item) => item.cache);
        storageCandidates.forEach(({ key, cache }) => {
            logPartScopeDiagnostic("storage_cache_candidate", {
                storageKey: key,
                currentRoute: currentRoute.toLowerCase(),
                candidateBvid: normalizeBvidCase(cache?.bvid || "").toLowerCase(),
                candidateCid: Number(cache?.cid || 0),
                candidateTid: String(cache?.tid || ""),
                acceptedByRouteCheck: isCacheForCurrentRouteVideo(cache, currentRoute || afterBvid || beforeBvid),
                candidateHasSummary: !!String(cache?.summary || "").trim(),
                candidateSegmentsCount: Array.isArray(cache?.segments) ? cache.segments.length : 0,
                candidateHasRumors: !!cache?.rumors,
                candidateHistoryCount: Array.isArray(cache?.history) ? cache.history.length : 0
            }, `storage-candidate:${key}:${Number(cache?.cid || 0)}:${String(cache?.tid || "")}`);
        });
        const nextCache = storageCandidates
            .map((item) => item.cache)
            .find((cache) => {
                const cacheBvid = normalizeBvidCase(cache?.bvid || "");
                return cacheBvid && (!currentRoute || cacheBvid === currentRoute) && isCacheForCurrentRouteVideo(cache, currentRoute || afterBvid || beforeBvid);
            });
        if (nextCache) {
            const previousSubtitleSignature = getSubtitleCacheApplySignature(appState.cache);
            const nextSubtitleSignature = getSubtitleCacheApplySignature(nextCache);
            appState.cache = nextCache;
            logPartScopeDiagnostic("storage_cache_accepted", {
                selectedCid: Number(nextCache?.cid || 0),
                selectedTid: String(nextCache?.tid || "")
            }, `storage-accepted:${normalizeBvidCase(nextCache?.bvid || "")}:${Number(nextCache?.cid || 0)}:${String(nextCache?.tid || "")}`);
            if (previousSubtitleSignature !== nextSubtitleSignature) {
                applyCacheSubtitleState(appState.cache, currentRoute || afterBvid || beforeBvid);
            }
        }
    }
    if (routeMismatch) {
        appState.cache = null;
    }
    if (afterBvid && appState.cache?.bvid && normalizeBvidCase(appState.cache.bvid) !== afterBvid) {
        appState.cache = null;
    }
    if (routeBvid && appState.cache?.bvid && normalizeBvidCase(appState.cache.bvid) !== routeBvid) {
        appState.cache = null;
    }
    if (afterBvid && hasUsableSubtitleCache(appState.cache, afterBvid)) {
        appState.subtitleCapturedBvid = afterBvid;
    }
    pruneChatPendingByHistory(appState.cache?.history);
    const injectBefore = normalizeBvidCase(appState.injectBvid || "");
    if (routeBvid) appState.injectBvid = routeBvid;
    else if (afterBvid) appState.injectBvid = afterBvid;
    if (normalizeBvidCase(appState.injectBvid || "") !== injectBefore) {
        appState.injectBvidChangedAt = Date.now();
        startSubtitleCheckTimer();
    }
    if (isStorageChangeStateDirty(changes, shouldResetForSwitch, routeMismatch, afterBvid)) {
        appState.isStateDirty = true;
    }
    const confirmedRouteCid = getCurrentRouteCid();
    if (confirmedRouteCid > 0) appState.injectCid = confirmedRouteCid;
    beginSubtitleObservation(appState.injectBvid || afterBvid || routeBvid);
    flushPendingSubtitleIfReady();
    renderContent();
    const tabStateChanged = tabStateBefore !== appState.tabState;
    const syncTarget = routeBvid || afterBvid || "";
    if ((tabStateChanged || shouldResetForSwitch || routeMismatch) && syncTarget && !changes[`cache_${syncTarget}`]?.newValue) {
        syncActiveCacheByBvid(syncTarget);
    }
}

let panelShadowRoot = null;
let playerResizeObserver = null;

function getPanelRoot() {
    return panelShadowRoot;
}

async function waitPanelMount() {
    // 等页面完全加载完毕再动 DOM
    if (document.readyState !== "complete") {
        await new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
    }
    // 额外等待 2000ms，确保 B 站各组件初始化完成
    await sleep(2000);

    // 寻找挂载目标：右侧栏 sticky 容器
    const rightContainer = document.querySelector(".right-container-inner.scroll-sticky") 
        || document.querySelector(".right-container-inner") 
        || document.querySelector(".right-container");

    if (!rightContainer) {
        // 如果找不到右侧栏，尝试再次等待
        await sleep(1000);
        if (!document.querySelector(".right-container")) {
             logUI.warn("mount_target_missing", { task: "ui", detail: { selector: "right-container" } });
             return;
        }
    }

    // 检查根容器是否已存在
    let rootHost = document.getElementById("__bili_ai_plugin_root__");
    if (!rootHost) {
        rootHost = document.createElement("div");
        rootHost.id = "__bili_ai_plugin_root__";
        rootHost.className = "ai-summary-plugin-host";
        rootHost.style.opacity = "0";
        rootHost.style.transition = "opacity 0.2s ease-in-out";
        
        // 创建 Shadow DOM
        panelShadowRoot = rootHost.attachShadow({ mode: "open" });
        
        // 注入样式
        const styleLink = document.createElement("link");
        styleLink.rel = "stylesheet";
        styleLink.href = chrome.runtime.getURL("content.css");
        const revealHost = () => {
            rootHost.style.opacity = "1";
        };
        styleLink.addEventListener("load", revealHost, { once: true });
        styleLink.addEventListener("error", revealHost, { once: true });
        panelShadowRoot.appendChild(styleLink);
        
        // 创建面板容器
        const panel = document.createElement("section");
        panel.className = "ai-summary-plugin-box";
        const logoIconSrc = chrome.runtime.getURL(`assets/icons/icon38.png`);
        const usageIconSrc = chrome.runtime.getURL(`${UI_ICON_BASE_DIR}/default/usage.png`);
        const sidebarDefaultIconSrc = chrome.runtime.getURL(`${UI_ICON_BASE_DIR}/default/sidebar.png`);
        const sidebarActiveIconSrc = chrome.runtime.getURL(`${UI_ICON_BASE_DIR}/active/sidebar.png`);
        panel.innerHTML = `
            <div class="plugin-top-logo">
                <div class="plugin-brand-title">
                    <img src="${logoIconSrc}" style="width:38px;height:38px;object-fit:contain;" />
                    <span class="logo-title">Bilitato B站视频小助手</span>
                    ${renderVersionUpdateBadge()}
                </div>
                <div class="plugin-top-actions">
                    <div class="logo-remaining-container" data-button-tooltip="Checking...">
                        <img src="${usageIconSrc}" class="logo-info-icon" />
                        <div class="logo-remaining-tooltip" id="logo-remaining">Checking...</div>
                    </div>
                    <button type="button" class="collapsed-summary-btn" data-action="run-summary"><span class="collapsed-summary-label">生成总结</span></button>
                    <button type="button" class="native-side-panel-btn" id="native-side-panel-btn" data-button-tooltip="打开浏览器侧边栏" aria-label="打开浏览器侧边栏">
                        <img class="sidebar-icon-default" src="${sidebarDefaultIconSrc}" alt="">
                        <img class="sidebar-icon-active" src="${sidebarActiveIconSrc}" alt="">
                    </button>
                </div>
                <div class="progress-container"><div id="step-progress-bar" class="progress-bar"></div></div>
            </div>
            <div class="plugin-main-container">
                <nav class="plugin-side-nav">
                    <div class="nav-group" id="nav-top"></div>
                    <div class="nav-group" id="nav-bottom"></div>
                </nav>
                <main class="plugin-content-panel" id="panel-body"></main>
            </div>
        `;
        panelShadowRoot.appendChild(panel);
        const logoEl = panel.querySelector(".plugin-top-logo");
        if (logoEl) {
            // Click on logo icon to take screenshot
            const logoImg = logoEl.querySelector("img");
            if (logoImg) {
                logoImg.onclick = (e) => {
                    e.stopPropagation();
                    if (!IS_DEBUG_MODE) return;
                    if (typeof html2canvas === 'undefined') {
                        showToast("截图组件尚未加载完成，请稍后再试");
                        return;
                    }
                    takePanelScreenshot();
                };
                refreshLogoDebugCaptureState();
            }

            // Click on other parts of the top area to collapse/expand
            logoEl.onclick = (e) => {
                if (e.target === logoImg || e.target.closest(".plugin-top-actions")) return;
                const shouldCollapse = !appState.isCollapsed;
                setPanelCollapsed(shouldCollapse, { showHint: shouldCollapse });
            };
        }
        panel.querySelector("#native-side-panel-btn")?.addEventListener("click", async (event) => {
            event.stopPropagation();
            const result = await chrome.runtime.sendMessage({ action: "OPEN_SIDE_PANEL" });
            if (!result?.ok) showToast(result?.error || "无法打开浏览器侧边栏");
            else if (result.requiresToolbarAction) showToast("请点击 Firefox 工具栏中的 Bilitato 图标打开侧边栏");
        });

        // Ensure progress bar is hidden initially
        const bar = panel.querySelector("#step-progress-bar");
        if (bar) {
            bar.classList.remove("loading", "error");
            bar.style.opacity = "0";
            bar.style.transform = "scaleX(0)";
        }
        
        // Initialize ResizeObserver for dynamic height
        initResizeObserver();
    }

    // 挂载到 DOM
    // 严禁使用 innerHTML 操作 B 站节点
    // 使用 prepend 插入到 rightContainer
    if (rightContainer && !rightContainer.contains(rootHost)) {
        // 尝试插到 up-panel-container 之后，或者作为第一个/最后一个子元素
        const upPanel = rightContainer.querySelector(".up-panel-container");
        if (upPanel) {
            upPanel.after(rootHost);
        } else {
            // 如果没有 up 面板，插到最前面，确保在推荐列表上方
            rightContainer.prepend(rootHost);
        }
    } else {
         // 兜底：如果找不到右侧栏，挂到 body
        if (!document.body.contains(rootHost)) {
            document.body.appendChild(rootHost);
            rootHost.style.position = "fixed";
            rootHost.style.top = "100px";
            rootHost.style.right = "20px";
            rootHost.style.zIndex = "10001";
        }
    }
    
    // Initial height sync
    setTimeout(syncPluginHeight, 500);
    setTimeout(() => {
        if (rootHost.style.opacity !== "1") rootHost.style.opacity = "1";
    }, 800);
}

function initResizeObserver() {
    if (playerResizeObserver) {
        playerResizeObserver.disconnect();
    }
    
    // Observe video player container
    const playerContainer = document.querySelector("#bilibili-player") || document.querySelector(".player-container");
    const videoArea = document.querySelector(".bpx-player-video-area");
    
    playerResizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(syncPluginHeight);
    });
    
    if (playerContainer) playerResizeObserver.observe(playerContainer);
    if (videoArea) playerResizeObserver.observe(videoArea);
    
    // Also observe window resize
    window.addEventListener("resize", () => requestAnimationFrame(syncPluginHeight));
}

function syncPluginHeight() {
    if (appState.isCollapsed) return;
    const box = panelShadowRoot ? panelShadowRoot.querySelector(".ai-summary-plugin-box") : null;
    if (!box) return;

    // 1. Video Player Area
    const videoArea = document.querySelector(".bpx-player-video-area") || document.querySelector(".video-container-v1") || document.querySelector("#bilibili-player");
    // 2. Sending Bar
    const sendingBar = document.querySelector(".bpx-player-sending-bar") || document.querySelector(".player-sending-bar");
    // 3. Toolbar (below sending bar)
    const toolbar = document.querySelector(".video-toolbar-container") || document.querySelector("#arc_toolbar_report");

    let totalHeight = 0;
    
    if (videoArea) totalHeight += videoArea.getBoundingClientRect().height;
    if (sendingBar) totalHeight += sendingBar.getBoundingClientRect().height;
    if (toolbar) totalHeight += toolbar.getBoundingClientRect().height;

    // Fallback default if detection fails or height is too small
    if (totalHeight < 300) {
        totalHeight = 600; // Reasonable default
    }
    appState.panelMaxHeight = totalHeight;

    box.style.height = `${totalHeight}px`;
    box.style.maxHeight = `${totalHeight}px`;
    if (appState.activePage === "summary") {
        const summaryPanel = panelShadowRoot ? panelShadowRoot.getElementById("page-summary") : null;
        if (summaryPanel) {
            if (appState.segmentsCollapsed) {
                requestAnimationFrame(() => applyExpandedSegmentsLayout(summaryPanel));
            } else {
                requestAnimationFrame(() => applySummaryRatio(summaryPanel));
            }
        }
    }
}

function resolvePluginDisplayMode(settings = appState.settings || {}) {
    return String(settings.pluginDisplayMode || "expanded").toLowerCase() === "collapsed" ? "collapsed" : "expanded";
}

function shouldShowPluginDisplayFeatureDot() {
    return appState.settings?.pluginDisplayFeatureSeen === false;
}

function markPluginDisplayFeatureSeen() {
    if (!shouldShowPluginDisplayFeatureDot()) return;
    const nextSettings = { ...(appState.settings || {}), pluginDisplayFeatureSeen: true };
    appState.settings = nextSettings;
    panelShadowRoot?.querySelectorAll(".settings-feature-dot").forEach((node) => node.remove());
    renderNav();
    chrome.runtime.sendMessage({ action: "SAVE_SETTINGS", settings: nextSettings }).then((res) => {
        if (res?.settings) appState.settings = res.settings;
    }).catch(() => {});
}

function syncCollapsedHeaderControls() {
    const box = panelShadowRoot ? panelShadowRoot.querySelector(".ai-summary-plugin-box") : null;
    const summaryButton = box?.querySelector(".collapsed-summary-btn");
    const summaryLabel = summaryButton?.querySelector(".collapsed-summary-label");
    if (!summaryButton || !summaryLabel) return;
    const taskStatus = isTabStateForCurrentVideo() ? (appState.tabState?.taskStatus || {}) : {};
    const running = taskStatus.summary === "processing"
        || taskStatus.segments === "processing"
        || !!appState.localPending?.tasks?.summary;
    const currentBvid = normalizeBvidCase(resolveCurrentBvid() || "");
    const hasSummary = !!currentBvid
        && isCacheForCurrentRouteVideo(appState.cache, currentBvid)
        && !!String(appState.cache?.summary || "").trim();
    const failed = taskStatus.summary === "error" || taskStatus.summary === "timeout";
    summaryButton.disabled = running;
    summaryButton.dataset.action = hasSummary && !running ? "view-summary" : "run-summary";
    summaryLabel.textContent = running
        ? "总结中..."
        : hasSummary
            ? "查看总结"
            : failed
                ? "重试总结"
                : "生成总结";
    summaryButton.setAttribute("aria-label", summaryLabel.textContent);
}

let collapseLandingTimer = null;
let collapseLandingCleanupTimer = null;
let collapseHintTimer = null;

function clearCollapseFeedback(box) {
    if (collapseLandingTimer) window.clearTimeout(collapseLandingTimer);
    if (collapseLandingCleanupTimer) window.clearTimeout(collapseLandingCleanupTimer);
    if (collapseHintTimer) window.clearTimeout(collapseHintTimer);
    collapseLandingTimer = null;
    collapseLandingCleanupTimer = null;
    collapseHintTimer = null;
    box?.classList.remove("collapse-landed");
    box?.querySelector(".plugin-top-logo")?.classList.remove("has-collapse-hint");
    box?.querySelector(".collapse-location-hint")?.remove();
}

function showCollapseLocationHint(box) {
    if (!box || appState.collapseHintShown) return;
    appState.collapseHintShown = true;
    const header = box.querySelector(".plugin-top-logo");
    if (!header) return;
    const hint = document.createElement("span");
    hint.className = "collapse-location-hint";
    hint.textContent = "已收起，点击标题栏展开";
    header.appendChild(hint);
    header.classList.add("has-collapse-hint");
    collapseHintTimer = window.setTimeout(() => {
        header.classList.remove("has-collapse-hint");
        hint.remove();
        collapseHintTimer = null;
    }, 1800);
}

function setPanelCollapsed(collapsed, options = {}) {
    const nextCollapsed = !!collapsed;
    const wasCollapsed = appState.isCollapsed;
    appState.isCollapsed = nextCollapsed;
    const box = panelShadowRoot ? panelShadowRoot.querySelector(".ai-summary-plugin-box") : null;
    clearCollapseFeedback(box);
    if (box) box.classList.toggle("is-collapsed", nextCollapsed);
    if (box && nextCollapsed && !wasCollapsed) {
        collapseLandingTimer = window.setTimeout(() => {
            collapseLandingTimer = null;
            if (!appState.isCollapsed) return;
            box.classList.add("collapse-landed");
            if (options?.showHint) showCollapseLocationHint(box);
            collapseLandingCleanupTimer = window.setTimeout(() => {
                box.classList.remove("collapse-landed");
                collapseLandingCleanupTimer = null;
            }, 520);
        }, 240);
    }
    syncCollapsedHeaderControls();
    if (!nextCollapsed) syncPluginHeight();
}

function resetPanelCollapseForCurrentPart() {
    setPanelCollapsed(resolvePluginDisplayMode() === "collapsed");
}

function expandPanelAfterSummaryCompletion() {
    if (resolvePluginDisplayMode() !== "collapsed" || !appState.isCollapsed) return;
    appState.activePage = "summary";
    setPanelCollapsed(false);
    renderNav();
    renderContent();
}

function recordDebugScenarioResult(result = {}) {
    const nextResult = {
        id: String(result.id || "debug_scenario"),
        title: String(result.title || "调试场景"),
        status: ["running", "passed", "failed", "cancelled", "needs_config"].includes(String(result.status || ""))
            ? String(result.status)
            : "passed",
        expected: String(result.expected || ""),
        actual: String(result.actual || ""),
        durationMs: Math.max(0, Number(result.durationMs || 0)),
        traceId: String(result.traceId || `debug_${Date.now().toString(36)}`),
        updatedAt: Date.now()
    };
    appState.debugScenarioResult = nextResult;
    try {
        logUI.info(`debug_scenario_${nextResult.status}`, {
            task: "debug",
            trace_id: nextResult.traceId,
            duration_ms: nextResult.durationMs,
            detail: {
                scenario_id: nextResult.id,
                title: nextResult.title,
                actual: nextResult.actual
            }
        });
    } catch (_) {}
}

function setEmbeddedPanelVisible(visible = true) {
    const root = document.getElementById("__bili_ai_plugin_root__");
    if (!root) return;
    root.style.display = visible ? "" : "none";
}

// 移除 syncPanelPosition 相关逻辑，因为不再需要 fixed 定位同步
function waitForElement(selector, timeoutMs = 5000) {
    return new Promise((resolve) => {
        if (document.querySelector(selector)) { resolve(); return; }
        const observer = new MutationObserver(() => {
            if (document.querySelector(selector)) {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { observer.disconnect(); resolve(); }, timeoutMs);
    });
}

function showStepProgress(percent) {
    updateProgress(percent, appState.progressTaskId || "manual");
}

function resetStepProgressBar(bar) {
    if (!bar) return;
    bar.classList.remove("loading", "error");
    bar.style.transition = "none";
    bar.style.opacity = "0";
    bar.style.transform = "scaleX(0)";
    void bar.offsetWidth;
    bar.style.transition = "";
}

function clearStepProgressTimers() {
    if (appState.progressTimeoutTimer) {
        clearTimeout(appState.progressTimeoutTimer);
        appState.progressTimeoutTimer = null;
    }
    if (appState.progressResetTimer) {
        clearTimeout(appState.progressResetTimer);
        appState.progressResetTimer = null;
    }
    if (appState.progressFadeTimer) {
        clearTimeout(appState.progressFadeTimer);
        appState.progressFadeTimer = null;
    }
}

function clearPseudoProgressTicker() {
    if (appState.pseudoProgressTimer) {
        clearInterval(appState.pseudoProgressTimer);
        appState.pseudoProgressTimer = null;
    }
}

function startAsymptoticPseudoProgress(taskId, initialPercent) {
    const nextTaskId = String(taskId || "tasks:unknown");
    const initial = Math.max(5, Math.min(60, Number(initialPercent) || 12));
    if (appState.pseudoProgressTaskId !== nextTaskId) {
        clearPseudoProgressTicker();
        appState.pseudoProgressTaskId = nextTaskId;
        appState.pseudoProgressValue = initial;
        appState.pseudoProgressStartedAt = Date.now();
        updateProgress(appState.pseudoProgressValue, nextTaskId);
    } else if (appState.pseudoProgressValue < initial) {
        appState.pseudoProgressValue = initial;
        updateProgress(appState.pseudoProgressValue, nextTaskId);
    }
    if (appState.pseudoProgressTimer) return;
    appState.pseudoProgressTimer = setInterval(() => {
        if (appState.pseudoProgressTaskId !== nextTaskId) {
            clearPseudoProgressTicker();
            return;
        }
        const elapsedSec = Math.max(0, (Date.now() - Number(appState.pseudoProgressStartedAt || Date.now())) / 1000);
        const asymptote = 92;
        const base = asymptote - (asymptote - initial) * Math.exp(-elapsedSec / 6);
        const next = Math.max(appState.pseudoProgressValue, Math.min(asymptote, base));
        if (next > appState.pseudoProgressValue) {
            appState.pseudoProgressValue = next;
            updateProgress(appState.pseudoProgressValue, nextTaskId);
        }
    }, 450);
}

function finishAsymptoticPseudoProgress(taskId, failed) {
    const activeTaskId = String(taskId || appState.pseudoProgressTaskId || appState.progressTaskId || "tasks:unknown");
    clearPseudoProgressTicker();
    appState.pseudoProgressTaskId = "";
    appState.pseudoProgressValue = 0;
    appState.pseudoProgressStartedAt = 0;
    if (failed) {
        updateProgress(100, activeTaskId, { error: true });
        return;
    }
    if (activeTaskId.startsWith("tasks:")) appState.visibleProgressCompletedTaskIds.add(activeTaskId);
    updateProgress(100, activeTaskId);
}

function scheduleStepProgressTimeout(taskId) {
    if (appState.progressTimeoutTimer) {
        clearTimeout(appState.progressTimeoutTimer);
    }
    appState.progressTimeoutTimer = setTimeout(() => {
        if (appState.progressTaskId !== taskId) return;
        if (String(taskId || "").startsWith("transcribe:") && isAsrSessionActiveForCurrent()) return;
        updateProgress(0, taskId, { force: true });
    }, STEP_PROGRESS_TIMEOUT_MS);
}

function scheduleProgressFadeOut(taskId) {
    const bar = panelShadowRoot ? panelShadowRoot.getElementById("step-progress-bar") : null;
    if (!bar) return;
    const nextTaskId = String(taskId || "global");
    if (appState.progressResetTimer) clearTimeout(appState.progressResetTimer);
    appState.progressResetTimer = setTimeout(() => {
        if (appState.progressTaskId !== nextTaskId) return;
        bar.style.opacity = "0";
        appState.progressFadeTimer = setTimeout(() => {
            if (appState.progressTaskId !== nextTaskId) return;
            bar.style.transition = "none";
            bar.style.transform = "scaleX(0)";
            void bar.offsetWidth;
            bar.style.transition = "";
            appState.progressTaskId = "";
            appState.progressLastTick = 0;
            appState.progressLastPercent = 0;
            
        }, 520);
    }, 2000);
}

function updateProgress(percent, taskId, options) {
    const bar = panelShadowRoot ? panelShadowRoot.getElementById("step-progress-bar") : null;

    const opts = options && typeof options === "object" ? options : {};
    const nextTaskId = String(taskId || "global");
    const previousTaskId = String(appState.progressTaskId || "");
    const previousPercent = Number(appState.progressLastPercent || 0);

    if (!bar) {
        logAsrUiTrace("progress_skip_no_bar", {
            requested_percent: Number(percent) || 0,
            task_id: nextTaskId,
            options: opts,
            previous_task_id: previousTaskId,
            previous_percent: previousPercent
        });
        return;
    }

    let clamped = Math.max(0, Math.min(100, Number(percent) || 0));

    const hasActiveTask = !!appState.progressTaskId;
    const sameTask = appState.progressTaskId === nextTaskId;

    // 核心修复：同一个任务进行中，进度只允许前进，不允许回退
    // 例如 Groq 可能回传 10 → 45 → 30 → 70
    // UI 应该显示为 10 → 45 → 45 → 70
    if (
        sameTask &&
        !opts.force &&
        !opts.error &&
        clamped > 0 &&
        clamped < 100 &&
        Number(appState.progressLastPercent || 0) > clamped
    ) {
        clamped = Number(appState.progressLastPercent || clamped);
    }

    logAsrUiTrace("progress_update", {
        requested_percent: Number(percent) || 0,
        final_percent: clamped,
        task_id: nextTaskId,
        previous_task_id: previousTaskId,
        previous_percent: previousPercent,
        same_task: sameTask,
        has_active_task: hasActiveTask,
        options: opts,
        task_status: appState.tabState?.taskStatus || {},
        last_error: appState.tabState?.lastError || "",
        session: {
            active: !!appState.asrSession?.active,
            bvid: appState.asrSession?.bvid || "",
            stage: appState.asrSession?.stage || "",
            progress: Number(appState.asrSession?.progress || 0)
        }
    });

    // 记录当前任务的最大进度
    appState.progressTaskId = nextTaskId;
    appState.progressLastPercent = clamped;
    appState.progressLastTick = Date.now();

    if (appState.pseudoProgressTaskId && appState.pseudoProgressTaskId !== nextTaskId) {
        clearPseudoProgressTicker();
        appState.pseudoProgressTaskId = "";
        appState.pseudoProgressValue = 0;
        appState.pseudoProgressStartedAt = 0;
    }

    if (hasActiveTask && appState.progressTaskId !== nextTaskId) {
        resetStepProgressBar(bar);
        appState.progressLastPercent = 0;
    }

    clearStepProgressTimers();

    if (clamped <= 0) {
        if (!opts.force && hasActiveTask && appState.progressTaskId !== nextTaskId) return;

        resetStepProgressBar(bar);
        appState.progressTaskId = "";
        appState.progressLastTick = 0;
        appState.progressLastPercent = 0;
        return;
    }

    appState.progressTaskId = nextTaskId;
    appState.progressLastTick = Date.now();

    bar.classList.remove("error");
    bar.style.opacity = "1";
    bar.style.transform = `scaleX(${clamped / 100})`;

    if (opts.error) {
        bar.classList.remove("loading");
        bar.classList.add("error");
        scheduleProgressFadeOut(nextTaskId);
        return;
    }

    if (clamped < 100) {
        bar.classList.add("loading");
        scheduleStepProgressTimeout(nextTaskId);
        return;
    }

    bar.classList.remove("loading");
    scheduleProgressFadeOut(nextTaskId);
}


function syncStepProgressByTaskState(tabState) {
    const currentBvid = normalizeBvidCase(resolveCurrentBvid() || "");
    const stateBvid = normalizeBvidCase(tabState?.activeBvid || "");
    
    if (currentBvid && stateBvid && currentBvid !== stateBvid) return;
    
    if (String(appState.progressTaskId || "").startsWith("transcribe:")) return;
    const rawTaskStatus = tabState?.taskStatus || {};
    const taskStatus = Object.fromEntries(
        Object.entries(rawTaskStatus).filter(([key]) => key !== "chat")
    );
    const entries = Object.entries(taskStatus);
    if (!entries.length) return;
    const processingTasks = entries
        .filter(([, value]) => value === "processing")
        .map(([key]) => key)
        .sort();
    const activeTaskId = appState.pseudoProgressTaskId
        || (String(appState.progressTaskId || "").startsWith("tasks:") ? appState.progressTaskId : "");
    if (processingTasks.length) {
        if (!activeTaskId) return;
        startAsymptoticPseudoProgress(activeTaskId, 18);
        return;
    }
    const hasError = entries.some(([, value]) => value === "error" || value === "timeout");
    if (hasError) {
        if (!activeTaskId) return;
        finishAsymptoticPseudoProgress(activeTaskId, true);
        return;
    }
    const hasDone = entries.some(([, value]) => value === "done");
    if (hasDone) {
        if (!activeTaskId) return;
        finishAsymptoticPseudoProgress(activeTaskId, false);
    }
}

async function loadBootstrapData() {
    const res = await chrome.runtime.sendMessage({ action: "GET_BOOTSTRAP", skipCloud: true });
    if (!res?.ok) {
        showToast(res?.error || "初始化失败");
        return;
    }
    appState.tabId = res?.tabId || null;
    appState.tabState = res?.tabState || null;
    const routeBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
    const bootstrapBvid = normalizeBvidCase(routeBvid || appState.tabState?.activeBvid || "");
    if (routeBvid) {
        appState.tabState = {
            ...(appState.tabState || {}),
            activeBvid: routeBvid
        };
    }
    const bootstrapCache = res?.cache || null;
    appState.cache = bootstrapCache
        && normalizeBvidCase(bootstrapCache?.bvid || "") === bootstrapBvid
        && isCacheForCurrentRouteVideo(bootstrapCache, bootstrapBvid)
        ? bootstrapCache
        : null;
    appState.settings = res?.settings || null;
    resetPanelCollapseForCurrentPart();
    appState.providers = res?.providers || null;
    appState.cloudCachePrefs = normalizeCloudCachePrefs(res?.cloudCachePrefs);
    if (res?.feedback) {
        setFeedbackState({
            ...res.feedback,
            loadedAt: Date.now(),
            loading: false,
            submitting: false,
            statusText: "",
            errorText: ""
        });
        await loadFeedbackSubmissionState(res.feedback);
    } else {
        await loadFeedbackSubmissionState(null);
    }
    let previewTarget = null;
    try {
        const previewRes = await chrome.storage.local.get([SETUP_PREVIEW_STORAGE_KEY]);
        previewTarget = previewRes?.[SETUP_PREVIEW_STORAGE_KEY] || null;
    } catch (_) {}
    const previewBvid = normalizeBvidCase(previewTarget?.bvid || "");
    const previewFresh = Date.now() - Number(previewTarget?.createdAt || 0) < SETUP_PREVIEW_MAX_AGE_MS;
    if (previewFresh && previewBvid && previewBvid === bootstrapBvid) {
        appState.activePage = "summary";
        try {
            await chrome.storage.local.remove([SETUP_PREVIEW_STORAGE_KEY]);
        } catch (_) {}
    } else {
        appState.activePage = resolveDefaultOpenPage(appState.settings?.defaultOpenPage);
    }
}

function resolveThemeMode(settings = appState.settings || {}) {
    const mode = String(settings.themeMode || "system").toLowerCase();
    if (mode === "dark" || mode === "light") return mode;
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function applyThemeMode() {
    const theme = resolveThemeMode();
    const box = panelShadowRoot ? panelShadowRoot.querySelector(".ai-summary-plugin-box") : null;
    if (box) box.dataset.theme = theme;
    if (panelShadowRoot?.host) panelShadowRoot.host.dataset.theme = theme;
    const guideOverlay = panelShadowRoot?.getElementById("setup-guide-overlay");
    if (guideOverlay) guideOverlay.dataset.theme = theme;
    const releaseOverlay = panelShadowRoot?.querySelector(".release-notice-overlay");
    if (releaseOverlay) releaseOverlay.dataset.theme = theme;
}

window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
    if (String(appState.settings?.themeMode || "system") === "system") applyThemeMode();
});

function renderApp() {
    bindPanelDelegatedEvents();
    applyThemeMode();
    renderNav();
    renderContent();
    renderTopRemaining();
    scheduleVersionAvailabilityCheck();
    maybeAutoShowSetupGuideOnFirstRun();
    globalThis.BilitatoReleaseNotice?.maybeShowReleaseNotice({
        root: panelShadowRoot,
        ...createEmbeddedReleaseNoticeHooks(),
    });
}

function createEmbeddedReleaseNoticeHooks() {
    let restoreCollapsed = false;
    return {
        onOpen: () => {
            restoreCollapsed = appState.isCollapsed;
            if (restoreCollapsed) setPanelCollapsed(false);
        },
        onClose: () => {
            if (restoreCollapsed) setPanelCollapsed(true);
        },
    };
}

// Backdoor mechanism
let logoClickCount = 0;
let logoClickTimer = null;

function refreshLogoDebugCaptureState() {
    if (!panelShadowRoot) return;
    const logoImg = panelShadowRoot.querySelector(".plugin-top-logo img:not(.logo-info-icon)");
    if (!logoImg) return;
    logoImg.style.cursor = IS_DEBUG_MODE ? "pointer" : "default";
    logoImg.title = IS_DEBUG_MODE ? "点击截图当前面板" : "";
}

function hideProviderQuotaTooltip() {
    panelShadowRoot?.getElementById("provider-quota-tooltip")?.remove();
}

function hideButtonTooltip() {
    panelShadowRoot?.getElementById("button-tooltip")?.remove();
}

function showButtonTooltip(target) {
    if (!target || !panelShadowRoot) return;
    const text = String(target.dataset.buttonTooltip || "").trim();
    if (!text) return;
    let tooltip = panelShadowRoot.getElementById("button-tooltip");
    if (!tooltip) {
        tooltip = document.createElement("div");
        tooltip.id = "button-tooltip";
        tooltip.className = "button-tooltip";
        panelShadowRoot.appendChild(tooltip);
    }
    tooltip.textContent = text;
    const rect = target.getBoundingClientRect();
    const margin = 7;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    let placement;
    let left;
    let top;

    if (target.classList.contains("side-nav-item")) {
        placement = "right";
        left = rect.right + margin;
        if (left + tooltipWidth + margin > viewportWidth) {
            placement = "left";
            left = rect.left - tooltipWidth - margin;
        }
        top = rect.top + ((rect.height - tooltipHeight) / 2);
    } else {
        placement = target.classList.contains("follow-fab") ? "top" : "bottom";
        left = rect.left + ((rect.width - tooltipWidth) / 2);
        top = placement === "top"
            ? rect.top - tooltipHeight - margin
            : rect.bottom + margin;
        if (placement === "bottom" && top + tooltipHeight + margin > viewportHeight) {
            placement = "top";
            top = rect.top - tooltipHeight - margin;
        } else if (placement === "top" && top < margin) {
            placement = "bottom";
            top = rect.bottom + margin;
        }
    }
    tooltip.dataset.placement = placement;
    tooltip.style.left = `${Math.round(Math.max(margin, Math.min(left, viewportWidth - tooltipWidth - margin)))}px`;
    tooltip.style.top = `${Math.round(Math.max(margin, Math.min(top, viewportHeight - tooltipHeight - margin)))}px`;
}

function showProviderQuotaTooltip(target) {
    if (!target || !panelShadowRoot) return;
    const text = String(target.dataset.tooltip || "").trim();
    if (!text) return;
    let tooltip = panelShadowRoot.getElementById("provider-quota-tooltip");
    if (!tooltip) {
        tooltip = document.createElement("div");
        tooltip.id = "provider-quota-tooltip";
        tooltip.className = "provider-quota-tooltip";
        panelShadowRoot.appendChild(tooltip);
    }
    tooltip.textContent = text;
    const rect = target.getBoundingClientRect();
    const tooltipWidth = 220;
    const margin = 8;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    let left = rect.right + margin;
    if (left + tooltipWidth + margin > viewportWidth) {
        left = rect.left - tooltipWidth - margin;
    }
    left = Math.max(margin, Math.min(left, Math.max(margin, viewportWidth - tooltipWidth - margin)));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(Math.max(margin, Math.min(rect.top - 8, viewportHeight - tooltip.offsetHeight - margin)))}px`;
}

function syncRuntimeDebugModeToBackground() {
    try {
        const result = chrome.runtime?.sendMessage?.({
            action: "SET_RUNTIME_DEBUG",
            enabled: isDebugLoggingEnabled(),
            source: "content_debug_toggle"
        });
        if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {}
}

function bindPanelDelegatedEvents() {
    const panelRoot = panelShadowRoot ? panelShadowRoot.querySelector(".ai-summary-plugin-box") : null;
    if (!panelRoot || panelRoot.dataset.bound === "1") return;
    panelRoot.dataset.bound = "1";
    panelRoot.addEventListener("click", (event) => {
        const inCopyMenu = event.target.closest(".copy-menu-overlay");
        if (!inCopyMenu && !event.target.closest('[data-nav="copy"]')) {
            closeCopyMenu();
        }
        if (!event.target.closest(".provider-free-badge")) {
            hideProviderQuotaTooltip();
        }
        const navNode = event.target.closest("[data-nav]");
        if (navNode && navNode.dataset.nav === "settings") {
            logoClickCount++;
            if (logoClickTimer) clearTimeout(logoClickTimer);
            logoClickTimer = setTimeout(() => {
                logoClickCount = 0;
            }, 2000);
            
            if (logoClickCount >= 5) {
                IS_DEBUG_MODE = !IS_DEBUG_MODE;
                globalThis.AIPluginLogger?.setDebugEnabled?.(isDebugLoggingEnabled());
                syncRuntimeDebugModeToBackground();
                showToast(`Debug Mode ${IS_DEBUG_MODE ? "Enabled" : "Disabled"}`);
                logoClickCount = 0;
                refreshLogoDebugCaptureState();
                if (!IS_DEBUG_MODE && appState.activePage === "debug") {
                    appState.activePage = "settings";
                }
                renderNav();
                renderContent();
                // Sync to inject script if possible (optional)
            }
        }
        
        const logoTitleNode = event.target.closest(".logo-title");
        if (navNode) {
            const navId = navNode.dataset.nav;
            if (navId === "copy") {
                const hadMenu = !!document.getElementById("copy-option-menu");
                handleSmartCopy(navNode);
                const hasMenu = !!document.getElementById("copy-option-menu");
                if (appState.activePage === "CC" && (hadMenu || hasMenu)) {
                    setNavActionActive(hasMenu ? "copy" : "");
                } else {
                    setNavActionActive("copy", 900);
                }
                return;
            }
            if (navId === "export") {
                toggleExportMenu(navNode);
                return;
            }
            logUI.info("ui_tab_switch", { tab: navId });
            if (navId === "chat") {
                appState.chatJustSwitched = true;
                const chatPanel = panelShadowRoot ? panelShadowRoot.getElementById("page-chat") : null;
                if (chatPanel) chatPanel.dataset.lastSignature = "";
            }
            if (navId === "debug" && appState.activePage !== "debug") {
                logUI.info("debug_page_open", { task: "debug" });
            }
            if (navId !== "settings" && appState.feedbackVisibleUnreadIds?.size) {
                appState.feedbackVisibleUnreadIds.clear();
            }
            if (navId !== "settings" && (getFeedbackState().statusText || getFeedbackState().errorText)) {
                setFeedbackState({ statusText: "", errorText: "" });
            }
            appState.activePage = navId;
            reportUsageEvent({
                eventName: "panel_opened",
                featureName: navId,
                status: "opened"
            });
            setNavActionActive("");
            renderNav();
            renderContent();
            return;
        }
        const transcribeNode = event.target.closest("#start-groq-transcribe");
        if (transcribeNode) {
            reportRetryClickIfNeeded(["transcribe"], "start_transcribe");
            startTranscriptionFromCapsule();
            return;
        }
        const actionNode = event.target.closest("[data-action]");
        if (!actionNode) return;
        const action = actionNode.dataset.action;
        if (action === "subtitle-load-retry") {
            retrySubtitleLoad();
            return;
        }
        if (action === "view-summary") {
            appState.activePage = "summary";
            setPanelCollapsed(false);
            renderNav();
            renderContent();
            reportActiveFeatureViewed("navigation");
            return;
        }
        if (action === "run-summary") {
            logUI.info("ui_generate_summary", { tab_id: appState.tabId || null });
            logUI.info("ui_generate_segments", { tab_id: appState.tabId || null });
            reportRetryClickIfNeeded(["summary", "segments"], action);
            runTasks(["summary", "segments"]);
            return;
        }
        if (action === "run-segments") {
            logUI.info("ui_generate_segments", { tab_id: appState.tabId || null });
            reportRetryClickIfNeeded(["segments"], action);
            runTasks(["segments"]);
            return;
        }
        if (action === "run-rumors") {
            logUI.info("ui_generate_rumor", { tab_id: appState.tabId || null });
            reportRetryClickIfNeeded(["rumors"], action);
            runTasks(["rumors"]);
            return;
        }
        if (action === "go-summary") {
            appState.activePage = "summary";
            chrome.runtime.sendMessage({ action: "CLEAR_TASK_ERRORS", tasks: ["summary", "segments"] }).catch(() => {});
            appState.panelErrors = {
                ...(appState.panelErrors || {}),
                summary: null,
                segments: null
            };
            if (appState.tabState?.taskStatus) {
                appState.tabState = {
                    ...(appState.tabState || {}),
                    taskStatus: {
                        ...(appState.tabState.taskStatus || {}),
                        summary: "idle",
                        segments: "idle"
                    },
                    taskErrors: {
                        ...(appState.tabState.taskErrors || {}),
                        summary: null,
                        segments: null
                    }
                };
            }
            renderNav();
            renderContent();
            return;
        }
        if (action === "summary-copy") {
            handleCopySummaryText(actionNode);
            return;
        }
        if (action === "segment-jump") {
            jumpTo(Number(actionNode.dataset.start || 0));
            return;
        }
        if (action === "chat-copy") {
            const text = String(actionNode.dataset.text || "").trim();
            if (!text) return;
            navigator.clipboard.writeText(text).then(() => {
                showToast("已复制");
            }).catch(() => {
                showToast("复制失败");
            });
            return;
        }
        if (action === "copy-with-time") {
            closeCopyMenu();
            handleCopySubtitleWithTimestamp();
            return;
        }
        if (action === "copy-without-time") {
            closeCopyMenu();
            handleCopyRawSubtitle();
            return;
        }
        if (action === "copy-all") {
            handleCopyRawSubtitle(actionNode);
            return;
        }
        if (action === "cc-language-menu") {
            toggleSubtitleLanguageMenu(actionNode);
            return;
        }
        if (action === "cc-switch-language") {
            closeSubtitleLanguageMenu();
            switchOfficialSubtitleLanguage(actionNode.dataset.languageId).catch((error) => {
                showToast(error?.message || "切换字幕失败");
            });
            return;
        }
        if (action === "settings-delete-current-cache") {
            deleteCurrentVideoCacheFromPanel();
            return;
        }
        if (action === "settings-delete-all-cache") {
            deleteAllVideoCacheFromPanel();
            return;
        }
        if (action === "open-extension-management") {
            chrome.runtime.sendMessage({ action: "OPEN_EXTENSION_MANAGEMENT" }).catch(() => {
                showToast("请打开浏览器扩展管理页更新");
            });
            return;
        }
        if (action === "export-srt") {
            handleExportSrt(actionNode);
            return;
        }
        if (action === "download-video") {
            handleDownloadMedia("video", actionNode);
            return;
        }
        if (action === "download-audio") {
            handleDownloadMedia("audio", actionNode);
            return;
        }
        if (action === "summary-expand") {
            const panel = panelShadowRoot ? panelShadowRoot.getElementById("page-summary") : null;
            const summaryCard = panel ? panel.querySelector(".summary-card-fixed") : null;
            if (summaryCard && !appState.segmentsCollapsed) {
                appState.expandedSummaryHeight = summaryCard.getBoundingClientRect().height;
            }
            appState.segmentsCollapsed = !appState.segmentsCollapsed;
            if (!appState.segmentsCollapsed) {
                appState.expandedSummaryHeight = 0;
                // 收起时恢复正常高度
                if (panel) {
                    panel.dataset.lastSignature = "";
                    renderSummary(panel);
                }
                syncPluginHeight();
            } else {
                // 展开时只让 applyExpandedSegmentsLayout 负责高度
                if (panel) {
                    panel.dataset.lastSignature = "";
                    renderSummary(panel);
                }
                requestAnimationFrame(() => {
                    const summaryPanel = panelShadowRoot ? panelShadowRoot.getElementById("page-summary") : null;
                    if (summaryPanel) applyExpandedSegmentsLayout(summaryPanel);
                });
            }
            return;
        }
        if (action === "settings-save") {
            saveSettingsFromPanel();
            return;
        }
        if (action === "summary-mode-notice-dismiss") {
            const nextSettings = { ...(appState.settings || {}), summaryModeNoticeSeen: true };
            appState.settings = nextSettings;
            chrome.storage.local.set({ settings: nextSettings }).catch?.(() => {});
            const notice = actionNode.closest(".summary-mode-notice");
            if (notice) notice.remove();
            const panel = panelShadowRoot ? panelShadowRoot.getElementById("page-summary") : null;
            if (panel) panel.dataset.lastSignature = "";
            renderContent();
            return;
        }
        if (action === "summary-refresh-subtitle-cache") {
            const target = normalizeBvidCase(resolveCurrentBvid() || "");
            if (target) {
                appState.cloudReadState = createCloudReadState(target, "idle", Number(appState.cloudReadState?.requestId || 0) + 1);
                startCloudReadForCurrentVideo({ bvid: target, silent: false });
            }
            return;
        }
        if (action === "goto-cc-tab") {
            appState.activePage = "CC";
            renderNav();
            renderContent();
            return;
        }
        if (action === "settings-toggle-secret") {
            const targetId = String(actionNode.dataset.target || "").trim();
            const input = targetId && panelShadowRoot ? panelShadowRoot.getElementById(targetId) : null;
            if (input) {
                const nextVisible = input.type === "password";
                input.type = nextVisible ? "text" : "password";
                actionNode.textContent = nextVisible ? "隐藏" : "显示";
                actionNode.setAttribute("aria-label", nextVisible ? "隐藏密钥明文" : "显示密钥明文");
            }
            return;
        }
        if (action === "feedback-submit") {
            submitFeedbackFromPanel();
            return;
        }
        if (action === "open-help") {
            window.open("https://ncnp7ti79hnh.feishu.cn/wiki/AMVswpIdZiufLukZ3x0cMTWJnge#share-JpZDddCK5oZWcyxlbJJcijLBnIe", "_blank", "noopener,noreferrer");
            return;
        }
        if (action === "open-review") {
            const reviewUrl = globalThis.BILITATO_STORE_CONFIG?.reviewUrl || "https://chromewebstore.google.com/detail/bilitato-ai%E9%99%AA%E4%BD%A0%E7%9C%8Bb%E7%AB%99/ggddcgdafeeoijoaohcffinbefcbpcga/reviews";
            window.open(reviewUrl, "_blank", "noopener,noreferrer");
            return;
        }
        if (action === "settings-authorize-custom-origin") {
            authorizeCustomOriginFromPanel();
            return;
        }
        if (action === "settings-edit-groq-base-url") {
            const input = panelShadowRoot?.getElementById("settings-groq-base-url");
            if (!input) return;
            if (input.readOnly) {
                input.readOnly = false;
                actionNode.textContent = "保存";
                input.focus();
                input.select();
                return;
            }
            try {
                input.value = normalizeAsrBaseUrlInput(input.value, DEFAULT_GROQ_ASR_BASE_URL);
            } catch (error) {
                showToast(error?.message || "Base URL 格式不正确");
                input.focus();
                return;
            }
            input.readOnly = true;
            actionNode.textContent = "修改";
            saveSettingsFromPanel(false, { requestGroqPermission: true }).then((saved) => {
                if (saved) return;
                input.readOnly = false;
                actionNode.textContent = "保存";
                input.focus();
            });
            return;
        }
        if (action === "settings-reset-groq-base-url") {
            const input = panelShadowRoot?.getElementById("settings-groq-base-url");
            if (!input) return;
            input.value = DEFAULT_GROQ_ASR_BASE_URL;
            input.readOnly = true;
            panelShadowRoot?.querySelector('[data-action="settings-edit-groq-base-url"]')?.replaceChildren("修改");
            saveSettingsFromPanel(true);
            return;
        }
        if (action === "settings-open-reg") {
            const url = String(actionNode.dataset.url || "").trim();
            if (url) window.open(url, "_blank", "noopener,noreferrer");
            return;
        }
        if (action === "open-external-url") {
            const url = String(actionNode.dataset.url || "").trim();
            if (url) window.open(url, "_blank", "noopener,noreferrer");
            return;
        }
        if (action === "refresh-page") {
            window.location.reload();
            return;
        }
        if (action === "settings-open-guide") {
            showSetupGuide();
            return;
        }
        if (action === "goto-setup-guide") {
            appState.activePage = "settings";
            renderNav();
            renderContent();
            showSetupGuide();
            return;
        }
        if (action === "settings-reset-prompts") {
            const settingsPanel = panelShadowRoot ? panelShadowRoot.getElementById("page-settings") : null;
            const mode = String(settingsPanel?.querySelector("#settings-prompt-mode")?.value || "guided");
            if (mode === "custom") {
                const summaryInput = settingsPanel?.querySelector("#settings-prompt-summary");
                const segmentsInput = settingsPanel?.querySelector("#settings-prompt-segments");
                const rumorsInput = settingsPanel?.querySelector("#settings-prompt-rumors");
                if (summaryInput) summaryInput.value = TASK_PROMPTS_DEFAULT.summary;
                if (segmentsInput) segmentsInput.value = TASK_PROMPTS_DEFAULT.segments;
                if (rumorsInput) rumorsInput.value = TASK_PROMPTS_DEFAULT.rumors;
            } else {
                const toneSelect = settingsPanel?.querySelector("#settings-prompt-tone");
                const detailSelect = settingsPanel?.querySelector("#settings-prompt-detail");
                if (toneSelect) toneSelect.value = "1";
                if (detailSelect) detailSelect.value = "1";
            }
            syncPromptSettingsDraft(settingsPanel);
            saveSettingsFromPanel(true);
            return;
        }
        if (action === "debug-switch-tab") {
            const nextTab = String(actionNode.dataset.tab || "overview");
            appState.debugToolsTab = ["overview", "scenarios", "logs", "state"].includes(nextTab) ? nextTab : "overview";
            renderContent();
            return;
        }
        if (action === "debug-run-error-demo") {
            const debugPanel = panelShadowRoot?.getElementById("page-debug");
            const code = String(debugPanel?.querySelector("#debug-error-code")?.value || "HTTP_429");
            const target = String(debugPanel?.querySelector("#debug-error-target")?.value || "summary");
            runErrorDisplayDemo(code, target);
            return;
        }
        if (action === "debug-log-view") {
            appState.debugLogView = actionNode.dataset.view === "raw" ? "raw" : "timeline";
            renderContent();
            return;
        }
        if (action === "debug-copy-diagnostics") {
            copyDebugDiagnosticReport();
            return;
        }
        if (action === "debug-clear-session") {
            clearDebugSession();
            return;
        }
        if (action === "debug-error-demo") {
            runErrorDisplayDemo(actionNode.dataset.code || "", actionNode.dataset.target || "summary");
            return;
        }
        if (action === "debug-clear-errors") {
            logUI.info("debug_clear_errors", { task: "debug" });
            appState.panelErrors = {};
            renderContent();
            showToast("已清空错误测试状态");
            return;
        }
        if (action === "debug-show-release-notice") {
            recordDebugScenarioResult({
                id: "release_notice",
                title: "更新导览",
                status: "passed",
                expected: "显示当前版本更新导览",
                actual: "已打开更新导览"
            });
            globalThis.BilitatoReleaseNotice?.renderReleaseNotice?.({
                root: panelShadowRoot,
                version: globalThis.chrome?.runtime?.getManifest?.()?.version || "1.4.3",
                ...createEmbeddedReleaseNoticeHooks(),
            });
            return;
        }
        if (action === "debug-show-version-update") {
            recordDebugScenarioResult({
                id: "version_update",
                title: "新版本入口",
                status: "passed",
                expected: "显示可用版本更新入口",
                actual: "已显示更新入口"
            });
            showDebugVersionUpdateBadge();
            return;
        }
        if (action === "debug-simulate-first-install") {
            logUI.info("debug_simulate_first_install", { task: "debug" });
            recordDebugScenarioResult({
                id: "first_install",
                title: "首次安装体验",
                status: "passed",
                expected: "显示首次安装引导",
                actual: "已打开首次安装引导"
            });
            showSetupGuide({ simulateFirstInstall: true });
            return;
        }
        if (action === "follow-now") {
            appState.followEnabled = true;
            appState.followPausedAt = 0;
            scrollToCurrentSubtitle(true);
            toggleFollowButton();
            return;
        }
        if (action === "chat-send") {
            logUI.info("ui_chat_send", { tab_id: appState.tabId || null });
            dismissChatGuide();
            hideChatGuideNodes(document.getElementById("page-chat"));
            handleSendChat();
            return;
        }
        if (action === "chat-stop") {
            handleStopChat();
            return;
        }
        if (action === "chat-suggest") {
            const panel = panelShadowRoot ? panelShadowRoot.getElementById("page-chat") : null;
            const input = panel?.querySelector("#chat-input");
            const text = String(actionNode.dataset.text || "").trim();
            if (input && text) {
                input.value = text;
                input.focus();
                input.setSelectionRange(input.value.length, input.value.length);
                dismissChatGuide();
                hideChatGuideNodes(panel);
            }
            return;
        }
        if (action === "logs-refresh") {
            renderLogWindowData();
            return;
        }
        if (action === "logs-copy") {
            copyLogWindowData();
            return;
        }
        if (action === "logs-close") {
            closeLogWindow();
            return;
        }
        if (action === "cc-regenerate-transcribe") {
            handleRegenerateGroqSubtitle();
            return;
        }
        if (action === "cc-toggle-video-subtitle") {
            toggleVideoSubtitleTrack();
            return;
        }
        if (action === "transcription-start") {
            startTranscriptionFromCapsule();
        }
    });
    panelRoot.addEventListener("mouseover", (event) => {
        const tooltipButton = event.target.closest("[data-button-tooltip]");
        if (tooltipButton) showButtonTooltip(tooltipButton);
        const badge = event.target.closest(".provider-free-badge");
        if (badge) showProviderQuotaTooltip(badge);
        const infoIcon = event.target.closest(".custom-option-info");
        if (infoIcon) showProviderQuotaTooltip(infoIcon);
    });
    panelRoot.addEventListener("mouseout", (event) => {
        const tooltipButton = event.target.closest("[data-button-tooltip]");
        if (tooltipButton && !tooltipButton.contains(event.relatedTarget)) hideButtonTooltip();
        const badge = event.target.closest(".provider-free-badge");
        if (badge && !badge.contains(event.relatedTarget)) hideProviderQuotaTooltip();
        const infoIcon = event.target.closest(".custom-option-info");
        if (infoIcon && !infoIcon.contains(event.relatedTarget)) hideProviderQuotaTooltip();
    });
    panelRoot.addEventListener("focusin", (event) => {
        const tooltipButton = event.target.closest("[data-button-tooltip]");
        if (tooltipButton) showButtonTooltip(tooltipButton);
    });
    panelRoot.addEventListener("focusout", (event) => {
        const tooltipButton = event.target.closest("[data-button-tooltip]");
        if (tooltipButton && !tooltipButton.contains(event.relatedTarget)) hideButtonTooltip();
    });
}

function setNavActionActive(navId, durationMs) {
    const nextId = String(navId || "");
    if (appState.navActionActiveTimer) {
        clearTimeout(appState.navActionActiveTimer);
        appState.navActionActiveTimer = null;
    }
    if (appState.navActionActive !== nextId) {
        appState.navActionActive = nextId;
        renderNav();
    }
    const timeoutMs = Number(durationMs || 0);
    if (!nextId || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    appState.navActionActiveTimer = setTimeout(() => {
        appState.navActionActiveTimer = null;
        if (appState.navActionActive !== nextId) return;
        appState.navActionActive = "";
        renderNav();
    }, timeoutMs);
}

function renderNav() {
    if (!panelShadowRoot) return;
    const top = panelShadowRoot.getElementById("nav-top");
    const bottom = panelShadowRoot.getElementById("nav-bottom");
    if (!top || !bottom) return;

    const items = [
        { id: "CC", file: "CC.png", slot: "top", label: "字幕" },
        { id: "summary", file: "summary.png", slot: "top", label: "总结" },
        { id: "chat", file: "chat.png", slot: "top", label: "聊天" },
        { id: "real", file: "real.png", slot: "top", label: "验真" },
        { id: "debug", file: "settings.png", slot: "top", label: "测试" },
        { id: "copy", file: "copy.png", slot: "bottom", label: "复制" },
        { id: "export", file: "download.png", slot: "bottom", label: "导出" },
        { id: "settings", file: "settings.png", slot: "bottom", label: "设置" }
    ];

    const renderedNavIds = new Set();

    items.forEach((item) => {
        const shouldRender = (() => {
            if (item.id === "debug" && !isDebugLoggingEnabled()) return false;
            if (appState.activePage === "summary") {
                return item.id !== "copy" && item.id !== "export";
            }
            if (appState.activePage === "chat" || appState.activePage === "real" || appState.activePage === "debug") {
                return item.id !== "copy" && item.id !== "export";
            }
            if (appState.activePage === "settings") {
                return item.id !== "copy" && item.id !== "export";
            }
            return true;
        })();

        if (!shouldRender) return;
        renderedNavIds.add(item.id);

        const activeVisual = appState.activePage === item.id || appState.navActionActive === item.id;
        const iconSrc = chrome.runtime.getURL(`${UI_ICON_BASE_DIR}/${activeVisual ? "active" : "default"}/${item.file}`);
        const container = item.slot === "top" ? top : bottom;
        let node = container.querySelector(`[data-nav='${item.id}']`);

        if (node) {
            // Update existing node
            node.className = `side-nav-item ${activeVisual ? "active" : ""}`;
            const img = node.querySelector("img");
            if (img && img.src !== iconSrc) {
                img.src = iconSrc;
            }
        } else {
            // Create new node
            node = document.createElement("button");
            node.type = "button";
            node.className = `side-nav-item ${activeVisual ? "active" : ""}`;
            node.dataset.id = item.id;
            node.dataset.nav = item.id;

            const img = document.createElement("img");
            img.src = iconSrc;
            img.alt = item.id;
            img.onload = () => img.classList.add("loaded");
            img.onerror = () => img.classList.add("loaded");
            node.appendChild(img);

            const fallback = document.createElement("span");
            fallback.className = "nav-fallback";
            fallback.textContent = item.label || item.id;
            node.appendChild(fallback);

            container.appendChild(node);
        }
        node.dataset.buttonTooltip = item.label || item.id;
        node.setAttribute("aria-label", item.label || item.id);
        const existingDot = node.querySelector(".nav-red-dot");
        if (item.id === "settings" && (hasFeedbackUnread() || shouldShowPluginDisplayFeatureDot())) {
            if (!existingDot) {
                const dot = document.createElement("span");
                dot.className = "nav-red-dot";
                node.appendChild(dot);
            }
        } else if (existingDot) {
            existingDot.remove();
        }
    });

    // Remove obsolete buttons
    [...top.children, ...bottom.children].forEach(node => {
        const navId = node.dataset.nav;
        if (navId && !renderedNavIds.has(navId)) {
            node.remove();
        }
    });

    // Enforce order by appending nodes again
    items.forEach((item) => {
        if (!renderedNavIds.has(item.id)) return;
        const container = item.slot === "top" ? top : bottom;
        const node = container.querySelector(`[data-nav='${item.id}']`);
        if (node) {
            container.appendChild(node);
        }
    });
}

function renderContent() {
    const panel = panelShadowRoot ? panelShadowRoot.getElementById("panel-body") : null;
    if (!panel) return;
    if (appState.activePage !== "debug") stopRealtimeLogPolling();
    if (appState.activePage !== "settings" && appState.feedbackVisibleUnreadIds?.size) {
        appState.feedbackVisibleUnreadIds.clear();
    }
    renderTopRemaining();
    syncCollapsedHeaderControls();
    ensureCloudReadForActivePage();

    const pages = ["CC", "summary", "chat", "real", "debug", "settings"];
    pages.forEach((id) => {
        if (id === "debug" && !isDebugLoggingEnabled()) {
            if (appState.activePage === "debug") appState.activePage = "settings";
            return;
        }
        let container = panelShadowRoot.getElementById(`page-${id}`);
        if (!container) {
            container = document.createElement("div");
            container.id = `page-${id}`;
            container.className = "plugin-page-container";
            container.style.display = "none";
            panel.appendChild(container);
        }

        if (appState.activePage === id) {
            container.style.display = "flex";
            if (id === "CC") renderSubtitleIfNeeded(container, "content_render");
            else if (id === "chat") renderChat(container);
            else if (id === "summary") renderSummary(container);
            else if (id === "real") renderReal(container);
            else if (id === "debug") renderDebugPanel(container);
            else if (id === "settings") renderSettings(container);
        } else {
            container.style.display = "none";
        }
    });
    
    syncPanelHeightMode();
    renderSubtitleTimelinePanel(panel);
    renderSegmentsFloatWindow();
    renderSegmentsProgressMarkers();
    ensureSegmentsVideoEvents();
}

function getFeedbackStatusLabel(status) {
    const map = {
        open: "已收到",
        investigating: "处理中",
        fixed: "已解决",
        need_more_info: "需补充",
        rejected: "已关闭"
    };
    return map[String(status || "open")] || "已收到";
}

function getFeedbackTypeLabel(type) {
    const map = {
        bug: "问题",
        suggestion: "建议",
        question: "咨询"
    };
    return map[String(type || "bug")] || "问题";
}

function formatFeedbackTime(value) {
    const time = Date.parse(value || "");
    if (!Number.isFinite(time)) return "";
    const date = new Date(time);
    const pad = (num) => String(num).padStart(2, "0");
    return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function collectFeedbackLogs() {
    const debugLogs = Array.isArray(appState.asrUiTraceLogs) ? appState.asrUiTraceLogs.slice(-80) : [];
    return debugLogs.filter((item) => {
        const event = String(item?.event || "").toLowerCase();
        const detail = JSON.stringify(item?.detail || {}).toLowerCase();
        return /error|failed|fail|timeout|exception|abort|invalid|denied/.test(event)
            || /error|failed|fail|timeout|exception|abort|invalid|denied/.test(detail);
    }).map((item) => ({
        source: "asr_ui",
        level: "warn",
        time: item.time || "",
        event: item.event || "",
        detail: item.detail || null
    }));
}

async function refreshFeedbackState({ markSeen = false, silent = false } = {}) {
    if (getFeedbackState().loading) return;
    if (appState.feedbackSeenTimer) {
        clearTimeout(appState.feedbackSeenTimer);
        appState.feedbackSeenTimer = null;
    }
    const beforeRows = getFeedbackState().rows || [];
    const beforeUnreadIds = getUnreadFeedbackIds(beforeRows);
    setFeedbackState({ loading: true, errorText: "", statusText: silent ? getFeedbackState().statusText : "正在读取反馈..." });
    if (!silent) renderContent();
    try {
        const res = await chrome.runtime.sendMessage({ action: "GET_FEEDBACK", markSeen });
        if (!res?.ok) throw new Error(res?.error || "读取反馈失败");
        if (markSeen && appState.activePage === "settings") {
            const idsToKeep = beforeUnreadIds.size ? beforeUnreadIds : getUnreadFeedbackIds(res.feedback?.rows || []);
            appState.feedbackVisibleUnreadIds = new Set([
                ...(appState.feedbackVisibleUnreadIds || []),
                ...idsToKeep
            ]);
        }
        setFeedbackState({
            ...(res.feedback || {}),
            loading: false,
            loadedAt: Date.now(),
            statusText: String(res.feedback?.statusText || ""),
            errorText: String(res.feedback?.errorText || "")
        });
        renderNav();
        renderContent();
    } catch (error) {
        setFeedbackState({
            loading: false,
            errorText: error?.message || "读取反馈失败",
            statusText: ""
        });
        renderContent();
    }
}

function ensureFeedbackLoadedForSettings() {
    const state = getFeedbackState();
    if (state.loading) return;
    if (Date.now() - Number(state.loadedAt || 0) < 15000) return;
    refreshFeedbackState({ markSeen: false, silent: true });
}

function refreshFeedbackAfterVideoSwitch() {
    if (!appState.feedbackHasSubmission) return;
    refreshFeedbackState({ markSeen: false, silent: true });
}

function scheduleFeedbackSeenAfterDisplay() {
    if (appState.activePage !== "settings") return;
    const rows = getFeedbackState().rows || [];
    const unreadIds = getUnreadFeedbackIds(rows);
    if (!unreadIds.size || appState.feedbackSeenTimer) return;
    appState.feedbackVisibleUnreadIds = new Set([
        ...(appState.feedbackVisibleUnreadIds || []),
        ...unreadIds
    ]);
    appState.feedbackSeenTimer = setTimeout(() => {
        appState.feedbackSeenTimer = null;
        if (appState.activePage !== "settings") return;
        refreshFeedbackState({ markSeen: true, silent: true });
    }, 800);
}

async function submitFeedbackFromPanel() {
    const panel = panelShadowRoot ? panelShadowRoot.getElementById("page-settings") : null;
    const titleInput = panel?.querySelector("#feedback-title");
    const contentInput = panel?.querySelector("#feedback-content");
    const typeInput = panel?.querySelector("#feedback-type");
    const includeLogsInput = panel?.querySelector("#feedback-include-logs");
    const title = String(titleInput?.value || "").trim();
    const content = String(contentInput?.value || "").trim();
    appState.feedbackDraft = {
        type: String(typeInput?.value || "bug"),
        title,
        content,
        includeLogs: includeLogsInput?.checked !== false
    };
    if (!isMeaningfulFeedbackText(title)) {
        setFeedbackState({ errorText: "标题不能为空哦", statusText: "" });
        renderContent();
        return;
    }
    if (!isMeaningfulFeedbackText(content)) {
        setFeedbackState({ errorText: "内容不能为空哦", statusText: "" });
        renderContent();
        return;
    }
    setFeedbackState({ submitting: true, errorText: "", statusText: "正在提交反馈..." });
    renderContent();
    try {
        const res = await chrome.runtime.sendMessage({
            action: "SUBMIT_FEEDBACK",
            type: String(typeInput?.value || "bug"),
            title,
            content,
            bvid: resolveCurrentBvid() || appState.tabState?.activeBvid || "",
            includeLogs: includeLogsInput?.checked !== false,
            logs: collectFeedbackLogs()
        });
        if (!res?.ok) throw new Error(res?.error || "提交反馈失败");
        setFeedbackState({
            ...(res.feedback || {}),
            submitting: false,
            loadedAt: Date.now(),
            statusText: FEEDBACK_PENDING_REPLY_TEXT,
            errorText: ""
        });
        await setFeedbackSubmissionState(true);
        appState.feedbackDraft = { type: "bug", title: "", content: "", includeLogs: true };
        showToast("反馈已提交");
        renderNav();
        renderContent();
    } catch (error) {
        setFeedbackState({
            submitting: false,
            errorText: error?.message || "提交反馈失败",
            statusText: ""
        });
        renderContent();
    }
}

function isMeaningfulFeedbackText(value) {
    const normalized = String(value || "").trim().replace(/[。.!！?？]+$/g, "").trim();
    return !!normalized && !/^(无|暂无|没有|无内容|没内容|不知道|不清楚)$/i.test(normalized);
}

function renderFeedbackCenter() {
    const feedback = getFeedbackState();
    const draft = {
        type: "bug",
        title: "",
        content: "",
        includeLogs: true,
        ...(appState.feedbackDraft || {})
    };
    const rows = Array.isArray(feedback.rows) ? feedback.rows : [];
    const statusText = feedback.errorText || feedback.statusText || (feedback.loading ? "正在读取反馈..." : "");
    scheduleFeedbackSeenAfterDisplay();
    const listHtml = rows.length ? rows.map((row) => {
        const message = row.reply || "";
        const showDot = shouldShowFeedbackItemDot(row);
        return `
            <div class="feedback-item ${showDot ? "has-update" : ""}">
                <div class="feedback-item-head">
                    <span class="feedback-item-title">${showDot ? `<span class="feedback-item-dot"></span>` : ""}${escapeHtml(row.title || "未命名反馈")}</span>
                    <span class="feedback-status">${escapeHtml(getFeedbackStatusLabel(row.status))}</span>
                </div>
                <div class="feedback-item-meta">${escapeHtml(getFeedbackTypeLabel(row.type))} · ${escapeHtml(formatFeedbackTime(row.updatedAt || row.createdAt))}</div>
                <div class="feedback-item-content">${escapeHtml(row.content || "")}</div>
                ${message ? `<div class="feedback-reply">${escapeHtml(message)}</div>` : ""}
            </div>
        `;
    }).join("") : `<div class="feedback-empty">暂无反馈记录。</div>`;
    return `
        <div class="feedback-card">
            <div class="feedback-card-head">
                <div>
                    <div class="feedback-title">反馈中心</div>
                    <div class="feedback-subtitle">我非常重视你和你的意见。</div>
                </div>
            </div>
            ${renderFeedbackTypeSelect(draft.type)}
            <input id="feedback-title" data-feedback-field="true" type="text" maxlength="120" value="${escapeHtmlAttr(draft.title)}" placeholder="一句话说说遇到了什么问题～">
            <textarea id="feedback-content" data-feedback-field="true" maxlength="3000" placeholder="告诉我你具体遇到了什么问题">${escapeHtml(draft.content)}</textarea>
            <label class="feedback-check">
                <input id="feedback-include-logs" data-feedback-field="true" type="checkbox" ${draft.includeLogs === false ? "" : "checked"}>
                <span>默认附带异常日志，便于定位问题</span>
            </label>
            <div class="feedback-actions">
                <button type="button" class="panel-btn primary feedback-submit-btn" data-action="feedback-submit" ${feedback.submitting ? "disabled" : ""}>${feedback.submitting ? "提交中..." : "提交反馈"}</button>
            </div>
            ${statusText ? `<div class="feedback-status-line ${feedback.errorText ? "error" : ""}">${escapeHtml(statusText)}</div>` : ""}
            <div class="feedback-list">${listHtml}</div>
        </div>
    `;
}

function renderFeedbackTypeSelect(selectedValue = "bug") {
    const items = [
        { value: "bug", label: "问题反馈" },
        { value: "suggestion", label: "功能建议" },
        { value: "question", label: "使用咨询" }
    ];
    const selected = items.find((item) => item.value === selectedValue) || items[0];
    const arrowIcon = `<svg class="custom-select-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    return `
        <select id="feedback-type" class="settings-native-select-hidden" data-feedback-field="true">
            ${items.map((item) => `<option value="${escapeHtmlAttr(item.value)}" ${item.value === selected.value ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}
        </select>
        <div class="custom-select-container settings-custom-select" data-target-select="feedback-type">
            <div class="custom-select-trigger">
                <span class="current-value">${escapeHtml(selected.label)}</span>
                ${arrowIcon}
            </div>
            <div class="custom-select-options">
                ${items.map((item) => `<div class="custom-option ${item.value === selected.value ? "selected" : ""}" data-value="${escapeHtmlAttr(item.value)}">${escapeHtml(item.label)}</div>`).join("")}
            </div>
        </div>
    `;
}

async function takePanelScreenshot() {
    const pluginBox = panelShadowRoot ? panelShadowRoot.querySelector(".ai-summary-plugin-box") : null;
    if (!pluginBox) {
        showToast("无法找到插件容器");
        return;
    }
    const screenshotFn = globalThis.html2canvas;
    if (typeof screenshotFn !== "function") {
        showToast("截图组件未加载，当前版本暂不支持截图");
        return;
    }

    try {
        const oldOverflow = pluginBox.style.overflow;
        const oldMaxHeight = pluginBox.style.maxHeight;
        
        // Temporarily adjust styles to capture full content if it scrolls
        pluginBox.style.overflow = 'visible';
        pluginBox.style.maxHeight = 'none';
        
        // We capture the whole plugin box, so no need to find the specific page body.
        
        const canvas = await screenshotFn(pluginBox, {
            backgroundColor: null,
            scale: 2,
            useCORS: true,
            logging: false,
            // Add padding to ensure box-shadow is not cropped (e.g. 10px on all sides)
            windowWidth: pluginBox.scrollWidth + 20,
            windowHeight: pluginBox.scrollHeight + 20,
            x: -10, // Offset to capture the shadow
            y: -10,
            width: pluginBox.offsetWidth + 20,
            height: pluginBox.offsetHeight + 20
        });
        
        // Restore styles
        pluginBox.style.overflow = oldOverflow;
        pluginBox.style.maxHeight = oldMaxHeight;

        const dataUrl = canvas.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = dataUrl;
        a.download = `Snapshot-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showToast("截图已保存");
    } catch (err) {
        logUI.error("screenshot_failed", {
            task: "ui",
            code: "SCREENSHOT_FAILED",
            detail: { error_message: err.message || "截图失败" }
        });
        showToast("截图失败");
    }
}

function renderSummary(panel) {
    const debugErrorView = appState.panelErrors?.summary;
    if (debugErrorView && renderErrorPanel) {
        panel.classList.remove("summary-no-apikey");
        panel.classList.remove("is-segments-expanded");
        panel.dataset.lastSignature = "";
        panel.innerHTML = `
            <div class="page-header">
                <h3>总结</h3>
            </div>
            ${renderErrorPanel(debugErrorView, "run-summary")}
        `;
        return;
    }
    const summary = appState.cache?.summary || "";
    const segments = dedupeDisplayedLineOnlyContentSegments(appState.cache?.segments, appState.cache);
    const summaryStatus = getCurrentVideoTaskStatus("summary");
    const segmentsStatus = getCurrentVideoTaskStatus("segments");
    logPartScopeDiagnostic("ui_render_read", {
        feature: "summary_segments",
        summaryStatus,
        segmentsStatus,
        accepted: isCacheForCurrentRouteVideo(appState.cache, resolveCurrentBvid())
    }, "render:summary_segments");
    const summaryTaskErrorView = (summaryStatus === "error" || summaryStatus === "timeout")
        ? getCurrentVideoTaskErrorView("summary")
        : null;
    const segmentsTaskErrorView = (segmentsStatus === "error" || segmentsStatus === "timeout")
        ? getCurrentVideoTaskErrorView("segments")
        : null;
    const isLoading = summaryStatus === "processing" || segmentsStatus === "processing";
    const hasContent = !!String(summary || "").trim() || segments.length > 0;
    const apiKey = String(appState.settings?.apiKey || "").trim();
    if (!apiKey && !hasContent) {
        panel.classList.add("summary-no-apikey");
        panel.classList.remove("is-segments-expanded");
        panel.dataset.lastSignature = "";
        if (isCloudReadLoadingForCurrentVideo()) {
            panel.innerHTML = renderCloudLoadingState("总结", "正在读取云端演示内容...");
            return;
        }
        panel.innerHTML = `
            <div class="no-apikey-notice">
                <div class="no-apikey-icon">🔑</div>
                <div class="no-apikey-text">暂未配置 API Key<br>请去设置里填写哦~</div>
                <button class="no-apikey-btn" data-action="goto-setup-guide">点此配置 →</button>
            </div>
        `;
        panel.scrollTop = 0;
        return;
    }
    panel.classList.remove("summary-no-apikey");

    const signature = JSON.stringify({
        summary,
        segmentsLength: segments.length,
        summaryStatus,
        segmentsStatus,
        summaryErrorCode: summaryTaskErrorView?.code || "",
        summaryErrorMessage: summaryTaskErrorView?.rawMessage || "",
        segmentsErrorCode: segmentsTaskErrorView?.code || "",
        segmentsErrorMessage: segmentsTaskErrorView?.rawMessage || "",
        cacheBvid: normalizeBvidCase(appState.cache?.bvid || ""),
        rawSubtitleLength: Array.isArray(appState.cache?.rawSubtitle) ? appState.cache.rawSubtitle.length : 0,
        processedSubtitleLength: Array.isArray(appState.cache?.processedSubtitle) ? appState.cache.processedSubtitle.length : 0,
        cloudReadStatus: String(appState.cloudReadState?.status || ""),
        subtitleSource: String(appState.cache?.subtitleSource || ""),
        summarySource: getTaskCacheSource(appState.cache, "summary"),
        segmentsSource: getTaskCacheSource(appState.cache, "segments"),
        sessionFresh: appState.sessionGeneratedTasks.has("summary") || appState.sessionGeneratedTasks.has("segments")
    });

    if (panel.dataset.lastSignature === signature && panel.innerHTML.trim()) return;
    panel.dataset.lastSignature = signature;

    const isFresh = appState.sessionGeneratedTasks.has("summary") || appState.sessionGeneratedTasks.has("segments");
    const segmentsNoTimestamp = isNoTimestampSubtitleCache(appState.cache);
    const cacheTag = buildCacheTagHtml(appState.cache, ["summary", "segments"], hasContent, isLoading, isFresh);
    const showModeNotice = !appState.settings?.summaryModeNoticeSeen && !isFresh;
    const isFastMode = (appState.settings?.prefMode || "quality") === "quality";
    const modeNoticeHtml = showModeNotice ? `
        <div class="summary-mode-notice">
            <div class="summary-mode-notice-text">
                <strong>当前为「${isFastMode ? "高速模式" : "省流模式"}」</strong>
                <span>${isFastMode
                    ? "会同时生成总结和分段，速度更快，但每次会消耗 2 次模型调用次数，你可以在设置中切换。"
                    : "本次会消耗 1 次模型调用，同时生成总结和分段。速度较慢、更省次数，你可以在设置中切换。"}</span>
            </div>
            <button type="button" class="summary-mode-notice-btn" data-action="summary-mode-notice-dismiss">知道了</button>
        </div>
    ` : "";
    const headerHtml = `
        <div class="page-header">
            <h3>总结 <div class="header-tags">${cacheTag}</div></h3>
        </div>
        ${modeNoticeHtml}
    `;

    if (!isLoading && (!hasContent || isTranscriptionRunning())) {
        panel.classList.remove("is-segments-expanded");
        const errorView = appState.panelErrors?.summary;
        if (errorView && renderErrorPanel) {
            panel.innerHTML = `
                ${headerHtml}
                ${renderErrorPanel(errorView, "run-summary")}
            `;
            return;
        }
        const hasSubtitle = hasUsableSubtitleCache(appState.cache, resolveCurrentBvid());
        const isCheckingSubtitleCache = !hasSubtitle && isCloudReadLoadingForCurrentVideo();
        let btnDisabled = isTranscriptionRunning() ? "disabled" : "";
        let tipText = hasSubtitle ? "去除噪音，抓住重点。" : "点击后将先检查字幕缓存。";
        let btnOpacity = isTranscriptionRunning() ? "0.5" : "1";
        let btnText = isCheckingSubtitleCache ? "检查并生成" : "生成 AI 总结";
        let extraActionsHtml = "";

        if (isTranscriptionRunning()) {
            btnDisabled = "disabled";
            tipText = "正在生成字幕，请稍候...";
            btnOpacity = "0.5";
            btnText = "生成 AI 总结";
        } else if (isCheckingSubtitleCache) {
            tipText = "正在检查字幕缓存，也可以直接点击生成重试。";
        } else if (!hasSubtitle) {
            panel.innerHTML = `
                ${headerHtml}
                ${renderMissingSubtitleState()}
            `;
            return;
        }
        
        panel.innerHTML = `
            ${headerHtml}
            <div class="page-body subtitle-empty-container">
                <div class="action-container">
                    <p class="action-tip">${tipText}</p>
                    <button class="action-btn" data-action="run-summary" ${btnDisabled} style="opacity: ${btnOpacity}">${btnText}</button>
                    ${extraActionsHtml}
                </div>
            </div>
        `;
        return;
    }

    const summarySkeleton = renderSkeletonLines(4, "summary-skeleton");
    const segmentsSkeleton = renderSkeletonLines(5, "segments-skeleton");
    const summaryIsLoading = summaryStatus === "processing";
    const segmentsIsLoading = segmentsStatus === "processing";
    const shouldHoldSegmentsLoading = !segments.length
        && !segmentsTaskErrorView
        && (
            segmentsIsLoading
            || summaryIsLoading
            || isFresh
            || !!String(summary || "").trim()
        );
    const summaryBody = summary
        ? `<div class="result-text summary-result-text">${renderRichContent(summary)}</div>`
        : (summaryIsLoading
            ? summarySkeleton
            : (summaryTaskErrorView && renderErrorPanel
                ? renderErrorPanel(summaryTaskErrorView, "run-summary")
                : `<div class="empty-text">尚未生成总结</div>`));
    
    const copyIconSrc = chrome.runtime.getURL(`${UI_ICON_BASE_DIR}/default/copy2.png`);
    const refreshIconSrc = chrome.runtime.getURL(`${UI_ICON_BASE_DIR}/default/refresh.png`);
    const actionButton = `<button class="panel-icon-btn" data-action="run-summary" data-button-tooltip="重新生成" aria-label="重新生成"><img src="${refreshIconSrc}" style="width:16px;height:16px;object-fit:contain;transform:scale(0.9);"></button>`;
    const copyBtn = summary ? `<button class="panel-icon-btn" data-action="summary-copy" data-button-tooltip="复制" aria-label="复制"><img src="${copyIconSrc}" style="width:16px;height:16px;object-fit:contain;transform:scale(1);"></button>` : "";

    const isExpanded = !!appState.segmentsCollapsed;
    panel.classList.toggle("is-segments-expanded", isExpanded);

    const chevron = `<svg class="toggle-chevron" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
        style="width:12px;height:12px;">
        <polyline points="6 9 12 15 18 9"></polyline>
    </svg>`;

    const hasSegments = segments.length > 0 || segmentsIsLoading;
    const toggleBtn = hasSegments ? `
        <button class="segments-toggle-btn ${isExpanded ? "is-expanded" : ""}"
                data-action="summary-expand"
                title="${isExpanded ? "收起" : "展开完整分段"}">
            ${isExpanded ? "收起" : "展开"} ${chevron}
        </button>
    ` : "";

    const segmentListHtml = segments.length
        ? `<div class="segment-list">${segments.map((item) => {
                const timelineRange = resolveSegmentTimelineRange(item, appState.cache);
                const itemNoTimestamp = segmentsNoTimestamp || !timelineRange;
                const lineStart = Number(item.start_line ?? item.ad_start_line);
                const lineEnd = Number(item.end_line ?? item.ad_end_line);
                const timeText = itemNoTimestamp
                    ? (Number.isInteger(lineStart) && Number.isInteger(lineEnd) ? `行 ${lineStart}-${lineEnd}` : "无时间轴")
                    : `${formatTime(timelineRange.start)}-${formatTime(timelineRange.end)}`;
                const actionAttrs = itemNoTimestamp
                    ? `disabled title="该字幕没有真实时间轴，无法跳转到具体时间"`
                    : `data-action="segment-jump" data-start="${timelineRange.start}"`;
                return `
                <button class="segment-card ${item.type === "ad" ? "ad" : ""} ${itemNoTimestamp ? "no-timestamp" : ""}"
                        ${actionAttrs}>
                    <span class="seg-time">${escapeHtml(timeText)}</span>
                    <span class="seg-label">${escapeHtml(item.label)}</span>
                    ${item.type === "ad" ? '<span class="ad-tag">广告片段</span>' : ""}
                </button>`;
            }).join("")}
              </div>`
        : (shouldHoldSegmentsLoading
        ? segmentsSkeleton
        : (segmentsTaskErrorView && renderErrorPanel
            ? renderErrorPanel(segmentsTaskErrorView, "run-segments")
            : `<div class="empty-text">尚未生成分段</div>`));

    panel.innerHTML = `
        <div class="page-header">
            <h3>总结 <div class="header-tags">${cacheTag}</div></h3>
            <div class="summary-header-actions" style="display:flex;gap:6px;">
                ${copyBtn}
                ${actionButton}
            </div>
        </div>
        <div class="page-body">
            <div class="summary-card-fixed">
                ${summaryBody}
            </div>
            <div class="summary-resize-divider" id="summary-resize-divider"></div>
            <div class="summary-card-segments">
                <div class="segments-section-header">
                    <span class="segments-section-title">视频分段</span>
                    ${toggleBtn}
                </div>
                <div class="segments-body">
                    ${segmentListHtml}
                </div>
            </div>
        </div>
        ${renderMetricsBox()}
    `;
    const summaryCard = panel.querySelector(".summary-card-fixed");
    if (isExpanded && summaryCard) {
        const lockedSummaryHeight = appState.expandedSummaryHeight > 0
            ? appState.expandedSummaryHeight
            : summaryCard.getBoundingClientRect().height;
        if (lockedSummaryHeight > 0) {
            appState.expandedSummaryHeight = lockedSummaryHeight;
            summaryCard.style.height = `${Math.round(lockedSummaryHeight)}px`;
        } else {
            summaryCard.style.height = "";
        }
        requestAnimationFrame(() => applyExpandedSegmentsLayout(panel));
    } else {
        if (summaryCard) {
            // Recover from expanded mode first to avoid summary area occupying the whole page.
            summaryCard.style.height = "";
        }
        const segmentsBody = panel.querySelector(".segments-body");
        if (segmentsBody) {
            segmentsBody.style.maxHeight = "";
            segmentsBody.style.overflowY = "";
        }
        applySummaryRatio(panel);
    }
    bindSummaryResizeDivider(panel);
}

function applyExpandedSegmentsLayout(panel) {
    if (!appState.segmentsCollapsed) return;
    const box = panelShadowRoot ? panelShadowRoot.querySelector(".ai-summary-plugin-box") : null;
    const pageBody = panel.querySelector(".page-body");
    const summaryCard = panel.querySelector(".summary-card-fixed");
    const divider = panel.querySelector("#summary-resize-divider");
    const segmentsHeader = panel.querySelector(".segments-section-header");
    const segmentsBody = panel.querySelector(".segments-body");
    if (!box || !pageBody || !summaryCard || !segmentsBody || !segmentsHeader) return;

    const segmentList = segmentsBody.querySelector(".segment-list");
    const boxRect = box.getBoundingClientRect();
    const pageBodyRect = pageBody.getBoundingClientRect();
    const fixedOutsideBody = Math.max(0, pageBodyRect.top - boxRect.top);
    const capturedSummaryHeight = Math.max(0, Number(appState.expandedSummaryHeight || parseFloat(summaryCard.style.height || "0") || 0));
    const dividerHeight = divider ? (divider.getBoundingClientRect().height || 8) : 8;
    const segmentsHeaderHeight = segmentsHeader.getBoundingClientRect().height || 0;
    const segmentContentHeight = segmentList ? segmentList.scrollHeight : segmentsBody.scrollHeight;
    const bodyStyle = window.getComputedStyle(pageBody);
    const gap = Math.max(0, parseFloat(bodyStyle.rowGap || bodyStyle.gap || "0") || 0);
    const gapCount = 2; // summary -> divider -> segments

    const neededBodyHeight = capturedSummaryHeight + dividerHeight + segmentsHeaderHeight + segmentContentHeight + (gap * gapCount);
    const neededBoxHeight = fixedOutsideBody + neededBodyHeight;
    const panelHeightLimit = Math.max(320, Number(appState.panelMaxHeight || boxRect.height || 0));
    const targetBoxHeight = Math.max(320, Math.min(Math.ceil(neededBoxHeight), Math.ceil(panelHeightLimit)));
    box.style.height = `${targetBoxHeight}px`;
    box.style.maxHeight = `${targetBoxHeight}px`;

    const availableBodyHeight = Math.max(0, targetBoxHeight - fixedOutsideBody);
    const expandedSummaryRatio = 0.6;
    const minimumSummaryHeight = availableBodyHeight * expandedSummaryRatio;
    const maximumSummaryHeight = Math.max(80, availableBodyHeight - dividerHeight - segmentsHeaderHeight - (gap * gapCount) - 80);
    const summaryHeight = Math.min(maximumSummaryHeight, Math.max(capturedSummaryHeight, minimumSummaryHeight));
    appState.expandedSummaryHeight = summaryHeight;
    summaryCard.style.height = `${Math.round(summaryHeight)}px`;

    const maxSegmentsBodyHeight = targetBoxHeight - fixedOutsideBody - summaryHeight - dividerHeight - segmentsHeaderHeight - (gap * gapCount);
    segmentsBody.style.maxHeight = `${Math.max(80, Math.floor(maxSegmentsBodyHeight))}px`;
    segmentsBody.style.overflowY = "auto";
}

function applySummaryRatio(panel) {
    if (appState.segmentsCollapsed) return;
    const pageBody = panel.querySelector(".page-body");
    const summaryCard = panel.querySelector(".summary-card-fixed");
    if (!pageBody || !summaryCard) return;
    const ratio = Math.max(0.15, Math.min(0.85, Number(appState.summaryRatio) || 0.7));

    const tryApply = () => {
        const bodyHeight = pageBody.getBoundingClientRect().height;
        if (bodyHeight < 100) return false;
        const dividerH = 8;
        const availableH = Math.max(0, bodyHeight - dividerH);
        let summaryHeight = availableH * ratio;
        if (!appState.summaryRatioManuallyAdjusted) {
            const segmentsHeader = panel.querySelector(".segments-section-header");
            const segmentList = panel.querySelector(".segments-body .segment-list");
            if (segmentsHeader && segmentList) {
                const naturalSegmentsHeight = segmentsHeader.getBoundingClientRect().height + segmentList.scrollHeight;
                const maxSummaryHeight = availableH * 0.85;
                const adaptiveSummaryHeight = Math.min(maxSummaryHeight, availableH - naturalSegmentsHeight);
                summaryHeight = Math.max(summaryHeight, adaptiveSummaryHeight);
            }
        }
        summaryCard.style.height = `${Math.round(summaryHeight)}px`;
        return true;
    };

    if (!tryApply()) {
        // Fallback height to prevent segments pane from disappearing while waiting for layout.
        const panelHeight = panel.getBoundingClientRect().height;
        if (panelHeight >= 160) {
            const fallbackAvailable = Math.max(120, panelHeight - 64);
            summaryCard.style.height = `${Math.round(fallbackAvailable * ratio)}px`;
        }
        requestAnimationFrame(() => {
            if (tryApply()) return;
            requestAnimationFrame(() => {
                tryApply();
            });
        });
    }
}

function bindSummaryResizeDivider(panel) {
    const divider = panel.querySelector("#summary-resize-divider");
    const pageBody = panel.querySelector(".page-body");
    const summaryCard = panel.querySelector(".summary-card-fixed");
    if (!divider || !pageBody || !summaryCard) return;

    let startY = 0;
    let startHeight = 0;

    const onMouseMove = (e) => {
        const bodyRect = pageBody.getBoundingClientRect();
        const dividerH = 8;
        const availableH = bodyRect.height - dividerH;
        const delta = e.clientY - startY;
        const newSummaryH = Math.max(60, Math.min(availableH - 60, startHeight + delta));
        const newRatio = newSummaryH / availableH;
        appState.summaryRatio = Math.max(0.15, Math.min(0.85, newRatio));
        appState.summaryRatioManuallyAdjusted = true;
        summaryCard.style.height = `${newSummaryH}px`;
        if (appState.segmentsCollapsed) {
            appState.expandedSummaryHeight = newSummaryH;
            applyExpandedSegmentsLayout(panel);
        }
    };

    const onMouseUp = () => {
        divider.classList.remove("dragging");
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
    };

    divider.addEventListener("mousedown", (e) => {
        e.preventDefault();
        startY = e.clientY;
        startHeight = summaryCard.getBoundingClientRect().height;
        divider.classList.add("dragging");
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
    });
}

function renderCC(panel) {
    logSubtitleDiagnostic("render_called", {
        source: "subtitle_state",
        ...getSubtitleDiagnosticRowsMeta(getCurrentSubtitleStateRows())
    });
    const transcription = getTranscriptionState();
    const sessionBvid = normalizeBvidCase(appState.asrSession?.active ? appState.asrSession?.bvid : "");
    const transcriptionBvid = normalizeBvidCase(transcription.phase === "running" ? transcription.bvid : "");
    const routeOrStateBvid = normalizeBvidCase(resolveCurrentBvid() || appState.injectBvid || appState.tabState?.activeBvid || "");
    const currentBvid = sessionBvid || transcriptionBvid || routeOrStateBvid;
    const cacheBvid = normalizeBvidCase(appState.cache?.bvid || "");
    const cacheReadyForCurrent = !!currentBvid && cacheBvid === currentBvid;
    const rows = getCurrentSubtitleStateRows();
    if (isSubtitleUiLoading() && rows.length === 0) {
        const routeKey = subtitleUiCoordinator.routeKey;
        const existingPanel = panel.querySelector?.(".cc-panel");
        if (existingPanel) {
            const statusNode = existingPanel.querySelector(".cc-transcribe-status");
            const listNode = existingPanel.querySelector("#cc-list");
            if (statusNode) statusNode.textContent = "正在读取字幕，请稍候...";
            if (listNode) {
                listNode.innerHTML = "";
                listNode.scrollTop = 0;
            }
            const emptyTip = existingPanel.querySelector(".subtitle-empty-container .action-tip");
            const emptyButton = existingPanel.querySelector(".subtitle-empty-container .action-btn");
            if (emptyTip) emptyTip.textContent = "正在读取字幕，请稍候...";
            if (emptyButton) {
                emptyButton.textContent = "检测中...";
                emptyButton.disabled = true;
            }
            delete panel.dataset.subtitleDiagRenderSignature;
            logSubtitleDiagnostic("loading_updated_in_place", { routeKey });
            return;
        }
    }
    if (cacheBvid && currentBvid && cacheBvid !== currentBvid) {
        logContent.warn("cc_cache_mismatch_drop", {
            task: "subtitle",
            bvid: currentBvid,
            code: "CC_CACHE_BVID_MISMATCH",
            detail: {
                cache_bvid: cacheBvid,
                row_count: getRawSubtitleRowsFromCache(appState.cache).length
            }
        });
    }
    const subtitleSource = String(appState.cache?.subtitleSource || appState.tabState?.subtitleSource || "").toLowerCase();

    const currentBvidForProgress = normalizeBvidCase(currentBvid || getStableCurrentBvid() || "");
    const tabStateBvidForProgress = normalizeBvidCase(appState.tabState?.activeBvid || "");
    const transcriptionBvidForProgress = normalizeBvidCase(transcription.bvid || "");
    const pendingTranscriptionForCurrent = isLocalPendingTranscriptionForCurrent(currentBvidForProgress);
    const asrSessionForCurrent = isAsrSessionActiveForCurrent(currentBvidForProgress);

    const tabProgressBelongsToCurrent =
        !!currentBvidForProgress &&
        !!tabStateBvidForProgress &&
        currentBvidForProgress === tabStateBvidForProgress;

    const localProgressBelongsToCurrent =
        !!currentBvidForProgress &&
        (
            (!!transcriptionBvidForProgress && currentBvidForProgress === transcriptionBvidForProgress) ||
            pendingTranscriptionForCurrent
        );

    const stateProgress = tabProgressBelongsToCurrent
        ? Math.max(0, Math.min(100, Number(appState.tabState?.transcriptionProgress ?? 0)))
        : 0;

    const localProgress = localProgressBelongsToCurrent
        ? Math.max(0, Math.min(100, Number(transcription.progress ?? 0)))
        : 0;

    const running = asrSessionForCurrent || ((isTranscriptionRunning() || pendingTranscriptionForCurrent) && localProgressBelongsToCurrent);
    const sessionProgress = asrSessionForCurrent
        ? Math.max(0, Math.min(100, Number(appState.asrSession?.progress ?? 0)))
        : 0;
    const progress = running ? Math.max(stateProgress, localProgress, sessionProgress) : 0;

    const isAsrSubtitle = subtitleSource === "groq" || subtitleSource === "whisper" || subtitleSource === "siliconflow" || subtitleSource === "funasr" || subtitleSource === "mimo" || subtitleSource === "custom_asr";
    const isNoTimestampSubtitle = subtitleSource === "siliconflow" || subtitleSource === "funasr" || subtitleSource === "mimo";
    const shouldShowRegenerate = rows.length > 0 && isAsrSubtitle && !running;
    const playbackCues = (subtitleSource === "groq" || subtitleSource === "whisper" || subtitleSource === "custom_asr")
        ? buildPlaybackSubtitleCues(rows)
        : [];
    const canShowVideoSubtitle = playbackCues.length > 0 && !running;

    const subtitleCacheSource = String(appState.cache?.subtitleCacheSource || "").toLowerCase();
    const subtitlePhase = subtitleUiCoordinator.phase;
    const subtitleTimedOut = subtitlePhase === "timeout";
    const subtitleUnavailable = subtitlePhase === "unavailable";
    const subtitleLoadFailed = subtitlePhase === "trigger_failed" || subtitlePhase === "probe_failed";
    const sourceText = running
        ? (appState.asrSession?.statusText || transcription.statusText || "正在转录音轨...")
        : rows.length
        ? (subtitleCacheSource === "cloud" ? "云端缓存" : (isAsrSubtitle ? "ASR转录生成" : "官方AI字幕"))
        : isSubtitleUiLoading()
        ? "正在读取字幕"
        : subtitleTimedOut
        ? "字幕加载超时"
        : subtitleLoadFailed
        ? "字幕加载失败"
        : "未检测到字幕";
    const refreshIconSrc = chrome.runtime.getURL(`${UI_ICON_BASE_DIR}/default/refresh.png`);
    const languageIconSrc = chrome.runtime.getURL(`${UI_ICON_BASE_DIR}/default/language.png`);
    const languageActiveIconSrc = chrome.runtime.getURL(`${UI_ICON_BASE_DIR}/active/language.png`);
    const canSwitchOfficialSubtitle = rows.length > 0 && !isAsrSubtitle && !running;
    const languageBtnHtml = canSwitchOfficialSubtitle
        ? `<button class="panel-icon-btn cc-language-btn" data-action="cc-language-menu" data-button-tooltip="切换字幕语言" aria-label="切换字幕语言"><img class="icon-default" src="${languageIconSrc}" alt=""><img class="icon-active" src="${languageActiveIconSrc}" alt=""></button>`
        : "";
    const regenBtnHtml = shouldShowRegenerate ? `<button class="panel-icon-btn" data-action="cc-regenerate-transcribe" data-button-tooltip="重新转录" aria-label="重新转录"><img src="${refreshIconSrc}" style="width:16px;height:16px;object-fit:contain;transform:scale(0.9);"></button>` : "";
    const videoSubtitleBtnHtml = canShowVideoSubtitle
        ? `<button type="button" class="cc-video-subtitle-btn${appState.videoSubtitleEnabled ? " is-active" : ""}" data-action="cc-toggle-video-subtitle" aria-pressed="${appState.videoSubtitleEnabled ? "true" : "false"}" data-button-tooltip="${appState.videoSubtitleEnabled ? "关闭视频内字幕" : "在视频画面中显示字幕"}">视频字幕</button>`
        : "";
    const searchBoxHtml = `<div class="cc-search-container"><input type="text" id="cc-search-input" class="cc-search-input" placeholder="搜索字幕..." /><button type="button" class="cc-search-clear" data-button-tooltip="清空搜索" aria-label="清空搜索">×</button></div>`;
    const progressBarHtml = '';

    const controlCenterHtml = `<div class="transcription-control-center"><div class="cc-transcribe-head">${searchBoxHtml}<div class="cc-header-right"><div class="cc-transcribe-status">${escapeHtml(sourceText)}</div><div class="cc-transcribe-actions">${videoSubtitleBtnHtml}${languageBtnHtml}${regenBtnHtml}</div></div></div>${(rows.length > 0 || running) ? progressBarHtml : ''}</div>`;

    if (appState.videoSubtitleEnabled) syncVideoSubtitleTrack(playbackCues);

    if (rows.length > 0) {
        logAsrUiTrace("cc_render", {
            mode: "rows",
            rows: rows.length,
            current_bvid: currentBvidForProgress,
            cache_bvid: cacheBvid,
            running,
            progress,
            button_disabled: true,
            button_text: "字幕列表",
            source_text: sourceText,
            tab_progress: stateProgress,
            local_progress: localProgress,
            session_progress: sessionProgress,
            session_active: asrSessionForCurrent,
            transcription_bvid: transcriptionBvidForProgress,
            tab_state_bvid: tabStateBvidForProgress
        });
        const rowsHtml = rows.map((row, index) => {
            const start = Number(row?.start ?? row?.from ?? 0);
            const end = row?.end ?? row?.to ?? "";
            const text = String(row?.text ?? row?.content ?? "解析失败");
            const hasTimestamp = !isNoTimestampSubtitle && Number.isFinite(start) && start >= 0;
            const timeHtml = hasTimestamp
                ? `<button class="cc-time cc-time-btn" data-action="cc-jump" data-sec="${start}">${formatTime(start)}</button>`
                : `<span class="cc-time" aria-hidden="true" style="cursor:default;color:transparent;">--</span>`;
            return `<div class="cc-row" data-index="${index}" data-start="${hasTimestamp ? start : ""}" data-end="${hasTimestamp ? end : ""}">${timeHtml}<span class="cc-text">${escapeHtml(text)}</span><button class="cc-copy-btn" data-action="cc-copy">复制</button></div>`;
        }).join("");

        const existingCcPanel = panel.querySelector?.(".cc-panel");
        const existingList = existingCcPanel?.querySelector("#cc-list");
        if (existingCcPanel && existingList) {
            if (!doesCcDomMatchRows(panel, rows)) {
                const previousScrollTop = existingList.scrollTop;
                existingList.innerHTML = rowsHtml;
                if (!subtitleUiCoordinator.initialAlignmentPending) {
                    existingList.scrollTop = previousScrollTop;
                }
            }
            const statusNode = existingCcPanel.querySelector(".cc-transcribe-status");
            const actionsNode = existingCcPanel.querySelector(".cc-transcribe-actions");
            if (statusNode) statusNode.textContent = sourceText;
            if (actionsNode) actionsNode.innerHTML = `${videoSubtitleBtnHtml}${languageBtnHtml}${regenBtnHtml}`;
            bindCCSearch(panel);
            logSubtitleDiagnostic("rows_updated_in_place", {
                source: "subtitle_state",
                rowCount: rows.length,
                routeKey: subtitleUiCoordinator.routeKey
            });
            return;
        }

        panel.innerHTML = `
            <section class="cc-panel">
                ${controlCenterHtml}
                <div class="cc-viewport">
                    <div class="cc-list" id="cc-list">${rowsHtml}</div>
                    <button class="follow-fab direction-down" id="btn-follow-now" data-action="follow-now" data-button-tooltip="回到当前" aria-label="回到当前" style="display:none;">
                        <img class="follow-fab-icon" src="${chrome.runtime.getURL(`${UI_ICON_BASE_DIR}/default/up.png`)}" alt="回到当前">
                    </button>
                </div>
            </section>
        `;
    } else {
        const detectElapsedMs = Date.now() - Number(appState.injectBvidChangedAt || 0);
        const detectTimeoutReached = detectElapsedMs >= SUBTITLE_DETECT_TIMEOUT_MS;
        const isDetectingSubtitle = !running && isSubtitleUiLoading();
        const capsuleDisabled = (running || isDetectingSubtitle) ? "disabled" : "";
        const asrPanelError = appState.panelErrors?.CC;
        if (asrPanelError && !running && !isDetectingSubtitle && renderErrorPanel) {
            panel.innerHTML = `
            <section class="cc-panel">
                ${controlCenterHtml}
                ${renderErrorPanel(asrPanelError, "transcription-start")}
            </section>
        `;
            bindCCSearch(panel);
            return;
        }
        const statusText = isDetectingSubtitle
            ? "正在读取字幕，请稍候..."
            : subtitleTimedOut
            ? "字幕加载超时，请重试"
            : subtitleLoadFailed
            ? "字幕加载失败，请重试"
            : ((running && (appState.asrSession?.statusText || transcription.statusText))
                ? escapeHtml(appState.asrSession?.statusText || transcription.statusText)
                : "未检测到字幕，可开启在线转录");
        const retryableSubtitleLoad = subtitleTimedOut || subtitleLoadFailed;
        const buttonText = running ? "转录中..." : (isDetectingSubtitle ? "检测中..." : (retryableSubtitleLoad ? "重试" : "开始在线转录"));
        const buttonAction = retryableSubtitleLoad ? "subtitle-load-retry" : "transcription-start";
        logAsrUiTrace("cc_render", {
            mode: "empty",
            rows: rows.length,
            current_bvid: currentBvidForProgress,
            cache_bvid: cacheBvid,
            cache_ready_for_current: cacheReadyForCurrent,
            running,
            progress,
            is_detecting_subtitle: isDetectingSubtitle,
            detect_elapsed_ms: detectElapsedMs,
            detect_timeout_reached: detectTimeoutReached,
            button_disabled: !!capsuleDisabled,
            button_text: buttonText,
            status_text: statusText.replace(/<[^>]*>/g, ""),
            source_text: sourceText,
            tab_progress: stateProgress,
            local_progress: localProgress,
            session_progress: sessionProgress,
            session_active: asrSessionForCurrent,
            session: {
                active: !!appState.asrSession?.active,
                bvid: appState.asrSession?.bvid || "",
                stage: appState.asrSession?.stage || "",
                progress: Number(appState.asrSession?.progress || 0),
                status_text: appState.asrSession?.statusText || ""
            },
            transcription: {
                phase: transcription.phase || "",
                bvid: transcriptionBvidForProgress,
                progress: Number(transcription.progress || 0),
                status_text: transcription.statusText || ""
            },
            tab_state_bvid: tabStateBvidForProgress
        });
            
        const capsuleHtml = `<div class="subtitle-empty-container">
            <div class="action-container">
                <p class="action-tip">${statusText}</p>
                <button ${retryableSubtitleLoad ? "" : 'id="start-groq-transcribe"'} class="action-btn" data-action="${buttonAction}" ${capsuleDisabled}>${buttonText}</button>
            </div>
        </div>`;
        panel.innerHTML = `
            <section class="cc-panel">
                ${controlCenterHtml}
                ${capsuleHtml}
            </section>
        `;
    }

    bindCCSearch(panel);
    const list = panel.querySelector("#cc-list");
    if (list) {
        const pauseFollow = () => {
            appState.followEnabled = false;
            appState.followPausedAt = Date.now();
            toggleFollowButton();
            updateFollowButtonDirection();
        };

        const onCCListClick = async (event) => {
            const jumpBtn = event.target.closest('[data-action="cc-jump"]');
            if (jumpBtn) {
                event.preventDefault();
                event.stopPropagation();
                jumpTo(Number(jumpBtn.dataset.sec || 0));
                return;
            }
            const button = event.target.closest('[data-action="cc-copy"]');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            const row = button.closest(".cc-row");
            const text = String(row?.querySelector(".cc-text")?.textContent || "").trim();
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                const origin = button.dataset.originText || button.textContent || "复制";
                button.dataset.originText = origin;
                button.textContent = "OK";
                button.classList.add("copied");
                row?.classList.add("copied");
                showToast("已复制");
                setTimeout(() => {
                    button.textContent = origin;
                    button.classList.remove("copied");
                    row?.classList.remove("copied");
                }, 1000);
            } catch (_) {
                showToast("复制失败");
            }
        };
        list.addEventListener("wheel", pauseFollow);
        list.addEventListener("touchmove", pauseFollow, { passive: true });
        list.addEventListener("scroll", updateFollowButtonDirection, { passive: true });
        list.addEventListener("click", onCCListClick);

    }
}

function bindCCSearch(panel) {
    const searchInput = panel.querySelector("#cc-search-input");
    const clearButton = panel.querySelector(".cc-search-clear");
    if (!searchInput || !clearButton) return;
    const term = String(appState.ccSearchTerm || "");
    if (searchInput.value !== term) searchInput.value = term;
    applyCCSearchFilter(panel, term);
    searchInput.oninput = () => {
        const nextTerm = String(searchInput.value || "");
        if (appState.ccSearchDebounceTimer) {
            clearTimeout(appState.ccSearchDebounceTimer);
            appState.ccSearchDebounceTimer = null;
        }
        appState.ccSearchDebounceTimer = setTimeout(() => {
            appState.ccSearchDebounceTimer = null;
            applyCCSearchFilter(panel, nextTerm);
        }, 100);
    };
    clearButton.onclick = () => {
        if (appState.ccSearchDebounceTimer) {
            clearTimeout(appState.ccSearchDebounceTimer);
            appState.ccSearchDebounceTimer = null;
        }
        searchInput.value = "";
        applyCCSearchFilter(panel, "");
        searchInput.focus();
    };
}

function applyCCSearchFilter(panel, rawTerm) {
    const term = String(rawTerm || "").trim();
    appState.ccSearchTerm = term;
    const normalized = term.toLowerCase();
    const clearButton = panel.querySelector(".cc-search-clear");
    if (clearButton) {
        clearButton.classList.toggle("visible", term.length > 0);
    }
    const allRows = panel.querySelectorAll(".cc-row");
    allRows.forEach((row) => {
        const textNode = row.querySelector(".cc-text");
        if (!textNode) return;
        const rawText = String(textNode.textContent || "");
        const matched = !normalized || rawText.toLowerCase().includes(normalized);
        row.style.display = matched ? "flex" : "none";
        if (matched) {
            textNode.innerHTML = highlightTimelineSearchText(rawText, normalized);
        }
    });
}

function renderChat(panel) {
    const debugErrorView = appState.panelErrors?.chat;
    if (debugErrorView && renderErrorPanel) {
        panel.dataset.lastSignature = "";
        panel.innerHTML = `
            <div class="page-header">
                <h3>聊天</h3>
            </div>
            ${renderErrorPanel(debugErrorView, "chat-send")}
        `;
        return;
    }
    const apiKey = String(appState.settings?.apiKey || "").trim();
    if (!apiKey) {
        panel.dataset.lastSignature = "";
        panel.innerHTML = `
            <div class="no-apikey-notice">
                <div class="no-apikey-icon">🔑</div>
                <div class="no-apikey-text">暂未配置 API Key<br>请去设置里填写哦~</div>
                <button class="no-apikey-btn" data-action="goto-setup-guide">点此配置 →</button>
            </div>
        `;
        return;
    }
    const history = Array.isArray(appState.cache?.history) ? appState.cache.history : [];
    const pending = Array.isArray(appState.chatPending) ? appState.chatPending : [];
    logPartScopeDiagnostic("ui_render_read", {
        feature: "chat",
        historyCount: history.length,
        pendingCount: pending.length,
        accepted: isCacheForCurrentRouteVideo(appState.cache, resolveCurrentBvid())
    }, "render:chat");
    
    const signature = JSON.stringify({
        cacheBvid: normalizeBvidCase(appState.cache?.bvid || ""),
        rawSubtitleLength: Array.isArray(appState.cache?.rawSubtitle) ? appState.cache.rawSubtitle.length : 0,
        processedSubtitleLength: Array.isArray(appState.cache?.processedSubtitle) ? appState.cache.processedSubtitle.length : 0,
        cloudReadStatus: String(appState.cloudReadState?.status || ""),
        h: history.length,
        hLast: history[history.length - 1]?.content?.length,
        p: pending.length,
        last: pending[pending.length-1]?.content?.length,
        s: appState.chatStreamingId
    });
    
    // Always check for existing list first
    const listExisting = panel.querySelector("#chat-list");

    // Force render if pending messages changed (even if just status) to ensure loading state shows
    // We only skip if signature matches exactly AND we have content
    const alreadyRendered = !appState.chatJustSwitched && panel.dataset.lastSignature === signature && listExisting;
    panel.dataset.lastSignature = signature;

    if (alreadyRendered) {
        if (appState.chatJustSwitched) {
             listExisting.style.opacity = "0";
             listExisting.scrollTop = listExisting.scrollHeight;
             scrollChatToBottom(listExisting);
             requestAnimationFrame(() => {
                 listExisting.style.opacity = "1";
                 appState.chatJustSwitched = false;
             });
        }
        return;
    }

    const shouldHideGuide = appState.chatGuideHidden || history.length > 0;
    const guideSection = shouldHideGuide ? "" : `
        <div class="chat-greeting">Hello, Ask me anything!</div>
        <div class="chat-suggest-list">
            <button type="button" class="chat-suggest-link" data-action="chat-suggest" data-text="帮我生成视频大纲">帮我生成视频大纲</button>
            <button type="button" class="chat-suggest-link" data-action="chat-suggest" data-text="作者讲了哪些主要观点">作者讲了哪些主要观点</button>
            <button type="button" class="chat-suggest-link" data-action="chat-suggest" data-text="帮我翻译成英文稿">帮我翻译成英文稿</button>
            <button type="button" class="chat-suggest-link" data-action="chat-suggest" data-text="这个视频片段出自哪里？">这个视频片段出自哪里？</button>
        </div>
    `;
    const isGenerating = !!appState.chatStreamingId;
    const sendAction = isGenerating ? "chat-stop" : "chat-send";
    const sendLabel = isGenerating ? "■" : "↑";
    const sendAria = isGenerating ? "停止" : "发送";
    const chatRowsHtml = renderChatRows(history);

    // If chat structure exists, just update content to prevent scroll jump
    if (listExisting) {
        // Save scroll position
        const prevScrollTop = listExisting.scrollTop;
        const wasAtBottom = listExisting.scrollHeight - listExisting.scrollTop <= listExisting.clientHeight + 50;

        // Update guide visibility
        const guideNode = panel.querySelector(".chat-greeting");
        const suggestNode = panel.querySelector(".chat-suggest-list");
        if (shouldHideGuide) {
            if (guideNode) guideNode.style.display = "none";
            if (suggestNode) suggestNode.style.display = "none";
        }

        // Pre-hide to avoid flash
        if (appState.chatJustSwitched) {
            listExisting.style.opacity = "0";
        }

        listExisting.innerHTML = chatRowsHtml;
        
        // IMMEDIATE: Handle tab switching scroll first
        if (appState.chatJustSwitched) {
             listExisting.scrollTop = listExisting.scrollHeight;
             scrollChatToBottom(listExisting);
             requestAnimationFrame(() => {
                 listExisting.style.opacity = "1";
             });
             appState.chatJustSwitched = false;
        } else {
             // If not switching, restore position to prevent jump-to-top first
             if (prevScrollTop > 0) listExisting.scrollTop = prevScrollTop;
        }

        // Update footer button state
        const sendBtn = panel.querySelector(".chat-send-btn");
        if (sendBtn) {
            sendBtn.dataset.action = sendAction;
            sendBtn.ariaLabel = sendAria;
            sendBtn.textContent = sendLabel;
            sendBtn.className = `chat-send-btn ${isGenerating ? "stopping" : ""}`;
        }

        // Handle auto-scroll logic (if needed)
        if (shouldAutoScrollChat() || wasAtBottom) {
            scrollChatToBottom(listExisting);
        }
        return;
    }

    appState.chatJustSwitched = false;
    const initialStyle = '';


    panel.innerHTML = `
        <section class="chat-page">
            ${guideSection}
            <div class="chat-display-area" id="chat-list"${initialStyle}>${chatRowsHtml}</div>
            <div class="chat-footer">
                <div class="chat-input-wrap">
                    <textarea id="chat-input" placeholder="有咩想问的？"></textarea>
                    <button class="chat-send-btn ${isGenerating ? "stopping" : ""}" data-action="${sendAction}" aria-label="${sendAria}">${sendLabel}</button>
                </div>
            </div>
        </section>
    `;
    const input = panel.querySelector("#chat-input");
    input?.addEventListener("input", () => {
        if (!String(input.value || "").trim()) return;
        dismissChatGuide();
        hideChatGuideNodes(panel);
    });
    input?.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" || event.isComposing) return;
        if (event.ctrlKey) return;
        event.preventDefault();
        dismissChatGuide();
        hideChatGuideNodes(panel);
        handleSendChat();
    });
    const list = panel.querySelector("#chat-list");
    bindChatListAutoScroll(list);
    if (list) {
        // 先同步设置，防止浏览器渲染第一帧时从顶部开始
        list.scrollTop = list.scrollHeight;
        // 再用 requestAnimationFrame 等布局完成后修正
        requestAnimationFrame(() => {
            list.scrollTop = list.scrollHeight;
            if (appState.chatJustSwitched) {
                appState.chatJustSwitched = false;
            }
            list.style.opacity = "1";
        });
    }
}

function renderReal(panel) {
    const debugErrorView = appState.panelErrors?.real;
    if (debugErrorView && renderErrorPanel) {
        panel.dataset.lastSignature = "";
        panel.innerHTML = `
            <div class="page-header">
                <h3>验真助手 <div class="header-tags"><span class="beta-tag">Beta</span></div></h3>
            </div>
            ${renderErrorPanel(debugErrorView, "run-rumors")}
        `;
        return;
    }
    const apiKey = String(appState.settings?.apiKey || "").trim();
    if (!apiKey) {
        panel.dataset.lastSignature = "";
        panel.innerHTML = `
            <div class="no-apikey-notice">
                <div class="no-apikey-icon">🔑</div>
                <div class="no-apikey-text">暂未配置 API Key<br>请去设置里填写哦~</div>
                <button class="no-apikey-btn" data-action="goto-setup-guide">点此配置 →</button>
            </div>
        `;
        return;
    }
    const rumors = appState.cache?.rumors;
    const claims = Array.isArray(rumors?.claims) ? rumors.claims : [];
    const rumorsStatus = getCurrentVideoTaskStatus("rumors");
    logPartScopeDiagnostic("ui_render_read", {
        feature: "rumors",
        rumorsStatus,
        claimsCount: claims.length,
        accepted: isCacheForCurrentRouteVideo(appState.cache, resolveCurrentBvid())
    }, "render:rumors");
    const hasRumorsCache = !!String(rumors?.overview || "").trim() || claims.length > 0;
    const rumorsNoTimestamp = isNoTimestampSubtitleCache(appState.cache) || rumors?.no_timestamp || claims.some((item) => item?.no_timestamp);
    
    // Sort claims by timestamp
    const sortedClaims = [...claims].sort((a, b) => {
        return (Number(a.timestamp_sec) || 0) - (Number(b.timestamp_sec) || 0);
    });

    const signature = JSON.stringify({
        overview: rumors?.overview,
        claimsLength: sortedClaims.length,
        rumorsStatus,
        cacheBvid: normalizeBvidCase(appState.cache?.bvid || ""),
        rawSubtitleLength: Array.isArray(appState.cache?.rawSubtitle) ? appState.cache.rawSubtitle.length : 0,
        processedSubtitleLength: Array.isArray(appState.cache?.processedSubtitle) ? appState.cache.processedSubtitle.length : 0,
        subtitleSource: String(appState.cache?.subtitleSource || ""),
        cloudReadStatus: String(appState.cloudReadState?.status || ""),
        rumorsSource: getTaskCacheSource(appState.cache, "rumors"),
        sessionFresh: appState.sessionGeneratedTasks.has("rumors")
    });

    if (panel.dataset.lastSignature === signature && panel.innerHTML.trim()) return;
    panel.dataset.lastSignature = signature;
    
    const isFresh = appState.sessionGeneratedTasks.has("rumors");
    const rumorsCacheTag = buildCacheTagHtml(appState.cache, ["rumors"], hasRumorsCache, rumorsStatus === "processing", isFresh);
    const realNoticeHtml = `
    <div class="real-notice">
        提示：当前内置大模型暂无联网能力，无法对时事新闻作出实时评判；验真结果仅基于历史事实、科学常识、通用知识和视频上下文，仅供参考。
    </div>
    `;
    
    if (rumorsStatus === "processing") {
        const rumorsSkeleton = renderSkeletonLines(6, "summary-skeleton");
        const claimsSkeleton = renderSkeletonLines(5, "segments-skeleton");
        const refreshIconSrc = chrome.runtime.getURL(`${UI_ICON_BASE_DIR}/default/refresh.png`);
    
        panel.innerHTML = `
            <div class="page-header">
                <h3>验真助手 <div class="header-tags"><span class="beta-tag">Beta</span>${rumorsCacheTag}</div></h3>
                <div class="summary-header-actions" style="display:flex;gap:6px;">
                    <button class="panel-icon-btn" data-button-tooltip="正在验真" aria-label="正在验真" disabled>
                        <img src="${refreshIconSrc}" style="width:16px;height:16px;object-fit:contain;transform:scale(0.9);opacity:0.5;">
                    </button>
                </div>
            </div>
            ${realNoticeHtml}
            <div class="page-body">
                <div class="result-text" style="margin-bottom:12px;">
                    ${rumorsSkeleton}
                </div>
                <div class="claim-list">
                    ${claimsSkeleton}
                </div>
            </div>
        `;
        return;
    }

    const claimListHtml = sortedClaims.map((item) => {
        // Determine style class based on verdict/credibility
        let statusClass = "unknown"; // Default (灰色)
        let verdictLabel = "未知";
        let tooltipText = "AI 暂时无法获取外部资料进行验证，或视频内容属于主观观点（无法验证对错）。";
        
        const verdict = String(item.verdict || "").toLowerCase();
        
        if (verdict.includes("false") || verdict.includes("fake") || verdict.includes("谣言") || verdict.includes("不实") || verdict.includes("不可信")) {
            statusClass = "fake";
            verdictLabel = "不可信";
            tooltipText = "信息与事实严重不符，或属于明显的误导/谣言。";
        } else if (verdict.includes("doubt") || verdict.includes("suspicious") || verdict.includes("存疑") || verdict.includes("有待核实")) {
            statusClass = "doubt";
            verdictLabel = "存疑";
            tooltipText = "证据不足，或存在逻辑上的矛盾点，需要用户自行甄别。";
        } else if (verdict.includes("basic") || verdict.includes("partially") || verdict.includes("基本可信") || verdict.includes("基本真实")) {
            statusClass = "basic";
            verdictLabel = "基本可信";
            tooltipText = "核心观点正确，但在细节描述上可能存在细微偏差。";
        } else if (verdict.includes("true") || verdict.includes("real") || verdict.includes("真实") || verdict.includes("可信")) {
            statusClass = "real";
            verdictLabel = "可信";
            tooltipText = "信息有明确出处或符合客观事实。";
        } else {
             // Fallback for unknown
             statusClass = "unknown";
             verdictLabel = "未知";
             tooltipText = "AI 暂时无法获取外部资料进行验证，或视频内容属于主观观点（无法验证对错）。";
        }

        const itemNoTimestamp = rumorsNoTimestamp || item?.no_timestamp;
        const timeLabel = itemNoTimestamp ? "无时间轴" : formatTime(item.timestamp_sec || 0);
        const timeControl = itemNoTimestamp
            ? `<span class="claim-time-btn claim-time-static" title="该字幕没有真实时间轴">${timeLabel}</span>`
            : `<button class="claim-time-btn" data-action="seek-video" data-time="${item.timestamp_sec}">${timeLabel}</button>`;
        
        return `
            <div class="claim-card ${statusClass}">
                <div class="claim-header">
                    ${timeControl}
                    <div class="claim-status-tag ${statusClass}" data-tooltip="${tooltipText}">
                        ${verdictLabel}
                    </div>
                </div>
                <div class="claim-content">${escapeHtml(item.claim)}</div>
                <div class="claim-analysis">${escapeHtml(item.analysis)}</div>
            </div>
        `;
    }).join("");

    const refreshIconSrc = chrome.runtime.getURL(`${UI_ICON_BASE_DIR}/default/refresh.png`);
    const actionButton = rumorsStatus === "processing" 
        ? `<button class="panel-icon-btn" data-button-tooltip="正在验真" aria-label="正在验真" disabled><img src="${refreshIconSrc}" style="width:16px;height:16px;object-fit:contain;transform:scale(0.9);opacity:0.5;"></button>`
        : `<button class="panel-icon-btn" data-action="run-rumors" data-button-tooltip="${hasRumorsCache ? "重新验真" : "开始验真"}" aria-label="${hasRumorsCache ? "重新验真" : "开始验真"}"><img src="${refreshIconSrc}" style="width:16px;height:16px;object-fit:contain;transform:scale(0.9);"></button>`;

    if (!hasRumorsCache && rumorsStatus !== "processing") {
        const errorView = appState.panelErrors?.real;
        if (errorView && renderErrorPanel) {
            panel.innerHTML = `
                <div class="page-header">
                    <h3>验真助手 <div class="header-tags"><span class="beta-tag">Beta</span>${rumorsCacheTag}</div></h3>
                </div>
                ${realNoticeHtml}
                ${renderErrorPanel(errorView, "run-rumors")}
            `;
            return;
        }
        panel.innerHTML = `
            <div class="page-header">
                <h3>验真助手 <div class="header-tags"><span class="beta-tag">Beta</span>${rumorsCacheTag}</div></h3>
            </div>
            ${realNoticeHtml}
            <div class="page-body subtitle-empty-container">
                <div class="action-container">
                    <p class="action-tip">先问是不是，再问为什么。</p>
                    <button class="action-btn" data-action="run-rumors">开始验真</button>
                </div>
            </div>
        `;
        return;
    }

    panel.innerHTML = `
        <div class="page-header">
            <h3>验真助手 <div class="header-tags"><span class="beta-tag">Beta</span>${rumorsCacheTag}</div></h3>
            <div class="summary-header-actions" style="display:flex;gap:6px;">
                ${actionButton}
            </div>
        </div>
        ${realNoticeHtml}
        <div class="page-body">
            <div class="result-text" style="margin-bottom:12px;">${escapeHtml(rumors?.overview || "")}</div>
            <div class="claim-list">${claimListHtml}</div>
        </div>
    `;
    
    // Bind seek events locally for this render
    panel.querySelectorAll(".claim-time-btn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const time = Number(e.target.dataset.time);
            if (!isNaN(time)) {
                const player = document.querySelector("video");
                if (player) {
                    player.currentTime = time;
                    player.play().catch(() => {});
                }
            }
        });
    });

    // Re-bind main button action if needed (though delegated events handle it usually)
    const runBtn = panel.querySelector('[data-action="run-rumors"]');
    if (runBtn) {
        // Just rely on global delegation
    }
}

let _guideStep = 1;
let _guideRestoreCollapsed = false;
let _guidePreviousPage = "";
let _guideSimulatesFirstInstall = false;

function showSetupGuide(options = {}) {
    if (!panelShadowRoot) return;
    if (panelShadowRoot.getElementById("setup-guide-overlay")) return;
    _guideSimulatesFirstInstall = options?.simulateFirstInstall === true;
    _guideRestoreCollapsed = _guideSimulatesFirstInstall || appState.isCollapsed;
    _guidePreviousPage = appState.activePage;
    if (_guideRestoreCollapsed) setPanelCollapsed(false);
    appState.activePage = "settings";
    renderNav();
    renderContent();
    const settingsScrollBody = panelShadowRoot.querySelector("#page-settings .settings-scroll-body");
    if (settingsScrollBody) settingsScrollBody.scrollTop = 0;
    _guideStep = 1;
    const overlay = document.createElement("div");
    overlay.id = "setup-guide-overlay";
    overlay.dataset.theme = resolveThemeMode();
    const box = panelShadowRoot.querySelector(".ai-summary-plugin-box");
    if (!box) return;
    box.appendChild(overlay);
    renderGuideStep(1);
}

function renderGuideStep(step) {
    _guideStep = step;
    const overlay = panelShadowRoot.getElementById("setup-guide-overlay");
    if (!overlay) return;
    overlay.innerHTML = "";

    const highlight = (selector) => {
        const target = panelShadowRoot.querySelector(selector);
        if (!target) return;
        const boxEl = panelShadowRoot.querySelector(".ai-summary-plugin-box");
        if (!boxEl) return;
        const tRect = target.getBoundingClientRect();
        const bRect = boxEl.getBoundingClientRect();
        const ring = document.createElement("div");
        ring.className = "guide-highlight-ring";
        ring.style.top = `${tRect.top - bRect.top - 4}px`;
        ring.style.left = `${tRect.left - bRect.left - 4}px`;
        ring.style.width = `${tRect.width + 8}px`;
        ring.style.height = `${tRect.height + 8}px`;
        ring.style.pointerEvents = "none";
        overlay.appendChild(ring);
    };

    const totalSteps = 4;
    const pluginDisplayGuideImageSrc = chrome.runtime.getURL("assets/ui/plugin-display-collapsed.png");
    const dots = (current, total) => Array.from({ length: total }, (_, i) => `<span class="guide-dot ${i + 1 === current ? "active" : ""}"></span>`).join("");

    const actions = (hasPrev) => `
        <div class="guide-card-actions">
            <button class="guide-btn-skip" data-guide="skip">跳过引导</button>
            <div class="guide-btn-group">
                ${hasPrev ? `<button class="guide-btn-secondary" data-guide="prev">← 上一步</button>` : ""}
                <button class="guide-btn-primary" data-guide="next">
                    ${step === totalSteps ? "完成 ✓" : "下一步 →"}
                </button>
            </div>
        </div>
    `;

    if (step === 1) {
        highlight('[data-action="settings-open-reg"]');
        overlay.insertAdjacentHTML("beforeend", `
            <div class="guide-card">
                <div class="guide-steps-dots">${dots(1, totalSteps)}</div>
                <div class="guide-card-title">🔗 第一步：注册并获取 API Key</div>
                <div class="guide-card-desc">
                    点击高亮的「注册」按钮跳转到平台申请免费 Key。<br>
                    不确定怎么操作？看这里：<br>
                    <a class="guide-doc-link"
                       href="https://ncnp7ti79hnh.feishu.cn/wiki/AMVswpIdZiufLukZ3x0cMTWJnge#share-JpZDddCK5oZWcyxlbJJcijLBnIe"
                       target="_blank" rel="noopener noreferrer">
                        📖 二年级小朋友都会 · 5 分钟学会如何配置
                    </a>
                </div>
                ${actions(false)}
            </div>
        `);
    }

    if (step === 2) {
        if (appState.activePage !== "settings") {
            appState.activePage = "settings";
            renderNav();
            renderContent();
        }
        highlight("#settings-api-key");
        highlight("#settings-model");
        overlay.insertAdjacentHTML("beforeend", `
            <div class="guide-card">
                <div class="guide-steps-dots">${dots(2, totalSteps)}</div>
                <div class="guide-card-title">✏️ 第二步：填写 Key 和模型名</div>
                <div class="guide-card-desc">
                    将获取到的 API Key 填入高亮的输入框。<br>
                    模型名称可留空，将自动使用默认模型。<br>
                    填写后点「保存设置」，AI 功能即刻解锁 🎉
                </div>
                ${actions(true)}
            </div>
        `);
    }

    if (step === 3) {
        overlay.insertAdjacentHTML("beforeend", `
            <div class="guide-card">
                <div class="guide-steps-dots">${dots(3, totalSteps)}</div>
                <div class="guide-card-title">👀 第三步：先看看效果</div>
                <div class="guide-card-desc">
                    还没配置也没关系。这里有一个已生成云端缓存的视频。
                    点击后会跳到 B 站视频，并自动打开总结页展示效果。
                </div>
                <div class="guide-preview-row">
                    <button class="guide-btn-primary guide-preview-btn" data-guide="preview">预览总结效果</button>
                </div>
                ${actions(true)}
            </div>
        `);
    }

    if (step === 4) {
        overlay.insertAdjacentHTML("beforeend", `
            <div class="guide-card">
                <div class="guide-steps-dots">${dots(4, totalSteps)}</div>
                <div class="guide-card-title">Tips：你可以自定义插件显示效果</div>
                <img class="guide-display-tip-image" src="${pluginDisplayGuideImageSrc}" alt="插件显示设置为默认缩起">
                <div class="guide-display-tip-desc">
                    Bilitato 现在默认是收起状态，只在你需要的时候出现。如需默认展开，请前往设置—<strong>调用与显示模式 → 插件显示</strong>里更改哟。你也可以<strong>点击 Bilitato 的标题栏来展开/收起</strong>。
                </div>
                ${actions(true)}
            </div>
        `);
    }

    const card = overlay.querySelector(".guide-card");
    card?.querySelector("[data-guide='skip']")?.addEventListener("click", () => {
        closeSetupGuide();
    });
    card?.querySelector("[data-guide='prev']")?.addEventListener("click", () => {
        renderGuideStep(step - 1);
    });
    card?.querySelector("[data-guide='next']")?.addEventListener("click", () => {
        if (step < totalSteps) {
            renderGuideStep(step + 1);
        } else {
            closeSetupGuide();
        }
    });
    card?.querySelector("[data-guide='preview']")?.addEventListener("click", async () => {
        try {
            await chrome.storage.local.set({
                [SETUP_PREVIEW_STORAGE_KEY]: {
                    bvid: SETUP_PREVIEW_BVID,
                    page: "summary",
                    createdAt: Date.now()
                }
            });
        } catch (_) {}
        closeSetupGuide();
        window.location.href = SETUP_PREVIEW_VIDEO_URL;
    });
}

function closeSetupGuide() {
    const overlay = panelShadowRoot?.getElementById("setup-guide-overlay");
    if (overlay) overlay.remove();
    const shouldRestoreCollapsed = _guideRestoreCollapsed
        && (_guideSimulatesFirstInstall || resolvePluginDisplayMode() === "collapsed");
    const previousPage = _guidePreviousPage;
    _guideRestoreCollapsed = false;
    _guidePreviousPage = "";
    _guideSimulatesFirstInstall = false;
    if (["CC", "summary", "chat", "real", "debug", "settings"].includes(previousPage)) {
        appState.activePage = previousPage;
    }
    if (shouldRestoreCollapsed) setPanelCollapsed(true, { showHint: true });
    renderNav();
    renderContent();
}

function maybeAutoShowSetupGuideOnFirstRun() {
    const settings = appState.settings || {};
    if (settings.setupGuideAutoShown) return;
    const nextSettings = { ...settings, setupGuideAutoShown: true };
    appState.settings = nextSettings;
    chrome.storage.local.set({ settings: nextSettings });
    const apiKey = String(nextSettings.apiKey || "").trim();
    if (!apiKey) {
        showSetupGuide();
    }
}

function renderSettings(panel) {
    const settings = appState.settings || {};
    const feedbackState = getFeedbackState();
    const signature = JSON.stringify({
        settings,
        feedback: {
            rows: feedbackState.rows,
            unreadCount: feedbackState.unreadCount,
            loading: feedbackState.loading,
            submitting: feedbackState.submitting,
            statusText: feedbackState.statusText,
            errorText: feedbackState.errorText
        }
    });
    if (panel.dataset.lastSignature === signature && panel.innerHTML.trim()) return;
    const prevScrollBody = panel.querySelector(".settings-scroll-body");
    const prevScrollTop = Number(prevScrollBody?.scrollTop || 0);
    const activeElement = document.activeElement;
    const shouldRestoreFocus = !!(activeElement && panel.contains(activeElement));
    const activeId = shouldRestoreFocus ? String(activeElement.id || "") : "";
    const activeSelectionStart = shouldRestoreFocus && typeof activeElement.selectionStart === "number" ? Number(activeElement.selectionStart) : -1;
    const activeSelectionEnd = shouldRestoreFocus && typeof activeElement.selectionEnd === "number" ? Number(activeElement.selectionEnd) : -1;
    panel.dataset.lastSignature = signature;

    const providers = { ...(appState.providers || {}) };
    if (!providers.custom) {
        providers.custom = { name: "自定义", baseUrl: "", regUrl: "" };
    }
    const providerKey = settings.provider || "modelscope";
    const provider = providers[providerKey] || {};
    const keys = getSortedProviderKeys(providers);
    const freeQuotaProviderKeys = new Set(["gemini", "modelscope", "openrouter"]);
    const optionsHtml = keys.map((key) => {
        const item = providers[key] || {};
        const isSelected = key === providerKey;
        const quotaText = getProviderFreeQuotaText(key);
        const badge = freeQuotaProviderKeys.has(key)
            ? `<span class="provider-free-badge" data-tooltip="${escapeHtmlAttr(quotaText)}">免费额度</span>`
            : "";
        return `<div class="custom-option ${isSelected ? "selected" : ""}" data-value="${escapeHtml(key)}"><span class="provider-option-main"><span>${escapeHtml(item.name || key)}</span>${badge}</span></div>`;
    }).join("");
    
    const currentProviderName = providers[providerKey]?.name || providerKey;
    const arrowIcon = `<svg class="custom-select-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
    const renderCustomSelect = (id, items, selectedValue) => {
        const selected = items.find((item) => String(item.value) === String(selectedValue)) || items[0] || { value: "", label: "" };
        return `
            <select id="${escapeHtmlAttr(id)}" class="settings-native-select-hidden">
                ${items.map((item) => `<option value="${escapeHtmlAttr(item.value)}" ${String(item.value) === String(selected.value) ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}
            </select>
            <div class="custom-select-container settings-custom-select" data-target-select="${escapeHtmlAttr(id)}">
                <div class="custom-select-trigger">
                    <span class="current-value">${escapeHtml(selected.label)}</span>
                    ${arrowIcon}
                </div>
                <div class="custom-select-options">
                    ${items.map((item) => `<div class="custom-option ${String(item.value) === String(selected.value) ? "selected" : ""}" data-value="${escapeHtmlAttr(item.value)}" data-label="${escapeHtmlAttr(item.label)}"><span class="custom-option-main"><span>${escapeHtml(item.label)}</span>${item.tooltip ? `<span class="settings-info-icon custom-option-info" data-no-select="true" data-tooltip="${escapeHtmlAttr(item.tooltip)}">i</span>` : ""}</span></div>`).join("")}
                </div>
            </div>
        `;
    };
    const renderSecretInput = (id, value, placeholder, errorText = "API Key 不能包含中文或空格，首尾空格会自动清理") => `
        <div class="settings-secret-field">
            <input id="${escapeHtmlAttr(id)}" data-secret-input="true" type="password" value="${escapeHtml(value || "")}" placeholder="${escapeHtmlAttr(placeholder)}" autocomplete="off" spellcheck="false">
            <button type="button" class="settings-secret-toggle" data-action="settings-toggle-secret" data-target="${escapeHtmlAttr(id)}" aria-label="显示密钥明文">显示</button>
        </div>
        <div class="error-message" id="${escapeHtmlAttr(id)}-error">${escapeHtml(errorText)}</div>
    `;
    const promptSettings = normalizePromptSettingsState(appState.settingsPromptDraft || settings.promptSettings);
    appState.settingsPromptDraft = promptSettings;
    const promptMode = promptSettings.mode === "custom" ? "custom" : "guided";
    const promptSummary = String(promptSettings.custom.summary || "");
    const promptSegments = String(promptSettings.custom.segments || "");
    const promptRumors = String(promptSettings.custom.rumors || "");
    const customProtocol = String(settings.customProtocol || "openai").toLowerCase() === "claude" ? "claude" : "openai";
    const defaultOpenPage = resolveDefaultOpenPage(settings.defaultOpenPage);
    const providerModelOptions = getProviderModelOptions(providerKey);
    const hasProviderModelSelect = providerKey !== "custom" && providerModelOptions.length > 0;
    const currentModel = String(providerKey === "custom"
        ? (settings.customModel || settings.model || "")
        : resolveProviderModelValue(providerKey, settings.model || getDefaultProviderModel(providerKey) || "")
    ).trim();
    const providerModelSelectValue = hasProviderModelSelect && providerModelOptions.includes(currentModel) ? currentModel : "custom";
    const providerModelWrapVisible = hasProviderModelSelect ? "" : "settings-hidden";
    const providerCustomModelVisible = hasProviderModelSelect && providerModelSelectValue === "custom" ? "" : "settings-hidden";
    const plainModelVisible = hasProviderModelSelect ? "settings-hidden" : "";
    const showOpenRouterFreeHint = providerKey === "openrouter" && currentModel === "openrouter/free";
    const modelScopeModelInfo = "ModelScope官网近期下线了对部分模型的平台调用支持，本插件会动态更新可直接使用的模型列表。";
    const modelLabelInfo = providerKey === "modelscope"
        ? `<span class="settings-info-icon" data-tooltip="${escapeHtmlAttr(modelScopeModelInfo)}">i</span>`
        : "";
    const cloudCachePrefs = normalizeCloudCachePrefs(appState.cloudCachePrefs);
    const currentBvid = normalizeBvidCase(resolveCurrentBvid() || "");
    const allCloudDisabledOn = !!(cloudCachePrefs.all || settings.disableCloudCacheRead);
    const currentCloudDisabled = (allCloudDisabledOn || cloudCachePrefs.current) ? "checked" : "";
    const allCloudDisabled = (cloudCachePrefs.all || settings.disableCloudCacheRead) ? "checked" : "";
    const currentCloudDisabledAttr = currentBvid && !allCloudDisabledOn ? "" : "disabled";
    const currentCloudLabel = allCloudDisabledOn ? "本视频不拉取云端缓存（已由所有视频设置覆盖）" : "本视频不拉取云端缓存";
    const requestedAsrProvider = String(settings.asrProvider || "groq").toLowerCase();
    const asrProviderKey = ["groq", "siliconflow", "mimo"].includes(requestedAsrProvider) ? requestedAsrProvider : "groq";
    const asrProviderDefaults = {
        groq: {
            name: "Groq",
            note: "需科学上网",
            regUrl: "https://console.groq.com/keys"
        },
        siliconflow: {
            name: "硅基流动",
            note: "无字幕时间戳",
            regUrl: "https://cloud.siliconflow.cn/account/ak"
        },
        mimo: {
            name: "小米 MiMo",
            note: "无字幕时间戳",
            regUrl: "https://platform.xiaomimimo.com/"
        }
    };
    const remoteAsrProviders = settings.remoteConfig?.asr && typeof settings.remoteConfig.asr === "object"
        ? settings.remoteConfig.asr
        : {};
    const asrProviders = Object.fromEntries(Object.entries(asrProviderDefaults).map(([key, item]) => {
        const remote = remoteAsrProviders[key] || {};
        if (remote.enabled === false && key !== asrProviderKey) return null;
        return [key, {
            ...item,
            ...(remote.name ? { name: remote.name } : {}),
            ...(remote.regUrl ? { regUrl: remote.regUrl } : {}),
            models: Array.isArray(remote.models) ? remote.models : []
        }];
    }).filter(Boolean));
    const asrProvider = asrProviders[asrProviderKey] || asrProviders.groq;
    const asrOptionsHtml = Object.entries(asrProviders).map(([key, item]) => {
        const isSelected = key === asrProviderKey;
        const tooltip = key === "groq" ? GROQ_ASR_LIMIT_TOOLTIP : "";
        return `<div class="custom-option ${isSelected ? "selected" : ""}" data-value="${escapeHtmlAttr(key)}" data-label="${escapeHtmlAttr(item.name)}"><span class="custom-option-main"><span>${escapeHtml(item.name)}</span>${tooltip ? `<span class="settings-info-icon custom-option-info" data-no-select="true" data-tooltip="${escapeHtmlAttr(tooltip)}">i</span>` : ""}</span><span class="custom-option-note">${escapeHtml(item.note)}</span></div>`;
    }).join("");
    const groqModel = String(settings.groqModel || "whisper-large-v3-turbo");
    const groqBaseUrl = String(settings.groqBaseUrl || DEFAULT_GROQ_ASR_BASE_URL);
    const siliconFlowAsrModel = String(settings.siliconFlowAsrModel || "FunAudioLLM/SenseVoiceSmall");
    const renderModelDatalist = (id, models) => Array.isArray(models) && models.length
        ? `<datalist id="${escapeHtmlAttr(id)}">${models.map((model) => `<option value="${escapeHtmlAttr(model)}"></option>`).join("")}</datalist>`
        : "";
    const customVisible = providerKey === "custom" ? "" : "settings-hidden";
    const groqVisible = asrProviderKey === "groq" ? "" : "settings-hidden";
    const siliconFlowVisible = asrProviderKey === "siliconflow" ? "" : "settings-hidden";
    const mimoVisible = asrProviderKey === "mimo" ? "" : "settings-hidden";
    const guidedVisible = promptMode === "guided" ? "" : "settings-hidden";
    const customPromptVisible = promptMode === "custom" ? "" : "settings-hidden";
    panel.innerHTML = `
        <div class="page-header">
            <h3>设置（自动保存）</h3>
            <div id="save-status"></div>
        </div>
        <div class="settings-scroll-body">
            <div class="settings-grid">
                <div class="settings-group-title-row">
                    <div class="settings-group-title">主模型配置</div>
                    <button type="button" class="panel-btn ghost settings-guide-btn" data-action="settings-open-guide">查看引导</button>
                </div>
                <label>Provider</label>
                <div class="settings-provider-row">
                    <div class="custom-select-container" id="settings-provider-select">
                        <div class="custom-select-trigger">
                            <span class="current-value">${escapeHtml(currentProviderName)}</span>
                            ${arrowIcon}
                        </div>
                        <div class="custom-select-options">
                            ${optionsHtml}
                        </div>
                    </div>
                    <button class="panel-btn ghost" data-action="settings-open-reg" data-url="${escapeHtml(provider.regUrl || "")}">注册</button>
                </div>
                <div class="settings-provider-url">${escapeHtml(provider.baseUrl || "-")}</div>
                <label>API Key</label>
                ${renderSecretInput("settings-api-key", settings.apiKey || "", "示例：sk-xxxxx")}
                <label class="settings-label-with-info">Model${modelLabelInfo}</label>
                <div id="settings-provider-model-wrap" class="${providerModelWrapVisible}">
                    ${renderCustomSelect("settings-provider-model", [
                        ...providerModelOptions.map((model) => ({ value: model, label: model, tooltip: providerKey === "modelscope" ? (MODELSCOPE_MODEL_LIMIT_TOOLTIPS[model] || "") : "" })),
                        { value: "custom", label: "自定义" }
                    ], providerModelSelectValue)}
                    <input id="settings-provider-custom-model" class="${providerCustomModelVisible}" type="text" value="${escapeHtml(currentModel)}" placeholder="请输入模型名">
                </div>
                <input id="settings-model" class="${plainModelVisible}" type="text" value="${escapeHtml(currentModel)}" placeholder="示例：gpt-4o-mini / deepseek-chat / glm-4-flash">
                <div id="settings-openrouter-free-hint" class="settings-model-hint ${showOpenRouterFreeHint ? "" : "settings-hidden"}">免费路由输出上限较低，分段可能失败，如无法正常生成重试即可。</div>
                <div class="settings-custom-only ${customVisible}">
                    <label>自定义地址协议</label>
                    <select id="settings-custom-protocol">
                        <option value="openai" ${customProtocol === "openai" ? "selected" : ""}>OpenAI 协议</option>
                        <option value="claude" ${customProtocol === "claude" ? "selected" : ""}>Claude 协议</option>
                    </select>
                    <label>Base URL</label>
                    <input id="settings-base-url" type="text" value="${escapeHtml(settings.customBaseUrl || "")}" placeholder="示例：https://api.example.com/v1">
                    <button type="button" class="panel-btn ghost" data-action="settings-authorize-custom-origin">授权当前域名</button>
                </div>
                <div class="settings-group-title">ASR（音频识别）模型配置</div>
                <label>ASR Provider</label>
                <div class="settings-provider-row">
                    <select id="settings-asr-provider" class="settings-native-select-hidden">
                        <option value="groq" ${asrProviderKey === "groq" ? "selected" : ""}>Groq</option>
                        <option value="siliconflow" ${asrProviderKey === "siliconflow" ? "selected" : ""}>硅基流动</option>
                        <option value="mimo" ${asrProviderKey === "mimo" ? "selected" : ""}>小米 MiMo</option>
                    </select>
                    <div class="custom-select-container settings-custom-select" id="settings-asr-provider-select" data-target-select="settings-asr-provider">
                        <div class="custom-select-trigger">
                            <span class="current-value">${escapeHtml(asrProvider.name)}</span>
                            ${arrowIcon}
                        </div>
                        <div class="custom-select-options">
                            ${asrOptionsHtml}
                        </div>
                    </div>
                    <button class="panel-btn ghost" data-action="settings-open-reg" data-register-kind="asr" data-url="${escapeHtml(asrProvider.regUrl || "")}">注册</button>
                </div>
                <div id="settings-asr-groq-wrap" class="settings-asr-provider-fields ${groqVisible}">
                    <label>Base URL</label>
                    <div class="settings-asr-base-url-row">
                        <input id="settings-groq-base-url" data-manual-save="true" type="text" value="${escapeHtml(groqBaseUrl)}" readonly>
                        <button type="button" class="panel-btn ghost" data-action="settings-edit-groq-base-url">修改</button>
                        <button type="button" class="panel-btn ghost" data-action="settings-reset-groq-base-url">重置</button>
                    </div>
                    <label>Groq API Key</label>
                    ${renderSecretInput("settings-groq-api-key", settings.groqApiKey || "", "示例：gsk_xxxxx")}
                    <label>ASR 模型</label>
                    <input id="settings-groq-model" type="text" list="settings-groq-model-options" value="${escapeHtml(groqModel)}" placeholder="示例：whisper-large-v3-turbo">
                    ${renderModelDatalist("settings-groq-model-options", asrProviders.groq?.models)}
                </div>
                <div id="settings-asr-siliconflow-wrap" class="settings-asr-provider-fields ${siliconFlowVisible}">
                    <div class="settings-provider-url">${DEFAULT_SILICONFLOW_ASR_BASE_URL}</div>
                    <label>硅基流动 API Key</label>
                    ${renderSecretInput("settings-siliconflow-api-key", settings.siliconFlowApiKey || "", "示例：sk-xxxxx")}
                    <label>ASR 模型</label>
                    <input id="settings-siliconflow-asr-model" type="text" list="settings-siliconflow-model-options" value="${escapeHtml(siliconFlowAsrModel)}" placeholder="示例：FunAudioLLM/SenseVoiceSmall">
                    ${renderModelDatalist("settings-siliconflow-model-options", asrProviders.siliconflow?.models)}
                </div>
                <div id="settings-asr-mimo-wrap" class="settings-asr-provider-fields ${mimoVisible}">
                    <div class="settings-provider-url">${DEFAULT_MIMO_ASR_BASE_URL}</div>
                    <label>小米 MiMo API Key</label>
                    ${renderSecretInput("settings-mimo-api-key", settings.mimoApiKey || "", "示例：sk-xxxxx")}
                    <label>ASR 模型</label>
                    <input id="settings-mimo-asr-model" type="text" value="${DEFAULT_MIMO_ASR_MODEL}" readonly>
                </div>
                <div class="settings-group-title">个性化</div>
                <label>修改模式</label>
                ${renderCustomSelect("settings-prompt-mode", [
                    { value: "guided", label: "简单模式" },
                    { value: "custom", label: "专业模式" }
                ], promptMode)}
                <div id="settings-prompt-guided-wrap" class="${guidedVisible}">
                    <label>语言风格</label>
                    <div class="slider-group">
                        <div class="slider-labels">
                            <span>轻松</span>
                            <span>平衡</span>
                            <span>专业</span>
                        </div>
                        <input id="settings-prompt-tone" type="range" min="0" max="2" step="1" 
                            value="${promptSettings.guided.tone === 'casual' ? 0 : (promptSettings.guided.tone === 'professional' ? 2 : 1)}">
                    </div>
                    
                    <label>详略程度</label>
                    <div class="slider-group">
                        <div class="slider-labels">
                            <span>简略</span>
                            <span>标准</span>
                            <span>详实</span>
                        </div>
                        <input id="settings-prompt-detail" type="range" min="0" max="2" step="1"
                            value="${promptSettings.guided.detail === 'brief' ? 0 : (promptSettings.guided.detail === 'detailed' ? 2 : 1)}">
                    </div>
                </div>
                <div id="settings-prompt-custom-wrap" class="${customPromptVisible}">
                    <div class="prompt-field-group">
                        <label class="prompt-field-label">总结 Prompt</label>
                        <textarea id="settings-prompt-summary" maxlength="1000">${escapeHtml(promptSummary)}</textarea>
                        <div class="prompt-char-count" id="count-summary">${promptSummary.length}/1000</div>
                    </div>
                    <div class="prompt-field-group">
                        <label class="prompt-field-label">分段 Prompt</label>
                        <textarea id="settings-prompt-segments" maxlength="1000">${escapeHtml(promptSegments)}</textarea>
                        <div class="prompt-char-count" id="count-segments">${promptSegments.length}/1000</div>
                    </div>
                    <div class="prompt-field-group">
                        <label class="prompt-field-label">验真 Prompt</label>
                        <textarea id="settings-prompt-rumors" maxlength="1000">${escapeHtml(promptRumors)}</textarea>
                        <div class="prompt-char-count" id="count-rumors">${promptRumors.length}/1000</div>
                    </div>
                </div>
                <button type="button" class="panel-btn ghost" data-action="settings-reset-prompts">恢复默认</button>
                <div class="settings-group-title">调用与显示模式</div>
                <label class="settings-feature-label">插件显示${shouldShowPluginDisplayFeatureDot() ? '<span class="settings-feature-dot" aria-label="新增功能"></span>' : ""}</label>
                ${renderCustomSelect("settings-plugin-display-mode", [
                    { value: "expanded", label: "默认展开" },
                    { value: "collapsed", label: "默认缩起" }
                ], _guideSimulatesFirstInstall ? "collapsed" : resolvePluginDisplayMode(settings))}
                <label>深/浅模式</label>
                ${renderCustomSelect("settings-theme-mode", [
                    { value: "system", label: "跟随系统" },
                    { value: "light", label: "浅色模式" },
                    { value: "dark", label: "深色模式" }
                ], ["system", "light", "dark"].includes(String(settings.themeMode || "system")) ? String(settings.themeMode || "system") : "system")}
                <label>默认开屏页</label>
                ${renderCustomSelect("settings-default-open-page", [
                    { value: "CC", label: "字幕" },
                    { value: "summary", label: "总结" },
                    { value: "chat", label: "聊天" },
                    { value: "real", label: "验真" }
                ], defaultOpenPage)}
                <label class="settings-label-with-info">
                    <span>调用模式</span>
                    <span class="settings-info-icon" data-tooltip="高速：总结和分段分别调用，速度更快但消耗 2 次。省流：一次调用同时生成总结和分段，更省次数。">i</span>
                </label>
                ${renderCustomSelect("settings-pref-mode", [
                    { value: "quality", label: "高速模式" },
                    { value: "efficiency", label: "省流模式" }
                ], settings.prefMode === "quality" ? "quality" : "efficiency")}
                <div class="settings-group-title">异常诊断</div>
                <label>允许上报异常</label>
                ${renderCustomSelect("settings-sentry-enabled", [
                    { value: "false", label: "关闭" },
                    { value: "true", label: "开启" }
                ], settings.sentryEnabled ? "true" : "false")}
                <div class="settings-group-title">缓存管理</div>
                <div class="settings-action-row">
                    <button type="button" class="panel-btn ghost" data-action="settings-delete-current-cache">删除当前视频 AI 结果缓存</button>
                    <button type="button" class="panel-btn ghost" data-action="settings-delete-all-cache">删除所有视频 AI 结果缓存</button>
                </div>
                <div class="settings-check-grid">
                    <label class="settings-check-row">
                        <input id="settings-disable-cloud-current" class="settings-cache-checkbox" type="checkbox" ${currentCloudDisabled} ${currentCloudDisabledAttr}>
                        <span>${escapeHtml(currentCloudLabel)}</span>
                    </label>
                    <label class="settings-check-row">
                        <input id="settings-disable-cloud-all" class="settings-cache-checkbox" type="checkbox" ${allCloudDisabled}>
                        <span>所有视频不拉取云端缓存</span>
                    </label>
                </div>
                <!--
                <label>Debug</label>
                <select id="settings-debug-mode">
                    <option value="false" ${settings.debugMode ? "" : "selected"}>false</option>
                    <option value="true" ${settings.debugMode ? "selected" : ""}>true</option>
                </select>
                -->
                <div class="settings-group-title">帮助与反馈</div>
                <div class="settings-action-row">
                    <button type="button" class="panel-btn ghost" data-action="open-help">帮助文档</button>
                    <button type="button" class="panel-btn ghost" data-action="open-review">去好评</button>
                </div>
                ${renderFeedbackCenter()}
            </div>
        </div>
    `;
    
    // Bind custom select logic
    const selectContainer = panel.querySelector("#settings-provider-select");
    const selectTrigger = selectContainer?.querySelector(".custom-select-trigger");
    const selectOptions = selectContainer?.querySelector(".custom-select-options");
    
    if (selectContainer && selectTrigger && selectOptions) {
        selectTrigger.addEventListener("click", (e) => {
            e.stopPropagation();
            const isOpen = selectContainer.classList.contains("open");
            // Close all other selects if any (future proofing)
            panel.querySelectorAll(".custom-select-container.open").forEach(el => {
                if(el !== selectContainer) el.classList.remove("open");
            });
            selectContainer.classList.toggle("open");
        });

        selectOptions.querySelectorAll(".custom-option").forEach(option => {
            option.addEventListener("click", (e) => {
                e.stopPropagation();
                const val = option.dataset.value;
                if(val && val !== providerKey) {
                    syncPromptSettingsDraft(panel);
                    // Update UI immediately for responsiveness
                    selectContainer.querySelector(".current-value").textContent = option.textContent;
                    selectContainer.classList.remove("open");
                    // Update internal state
                    if(!appState.settings) appState.settings = {};
                    const previousProvider = String(appState.settings.provider || providerKey || "modelscope");
                    const currentApiKey = String(panel.querySelector("#settings-api-key")?.value || "").trim();
                    const currentModelValue = String(panel.querySelector("#settings-provider-model")?.value || "").trim();
                    const previousModel = currentModelValue === "custom"
                        ? String(panel.querySelector("#settings-provider-custom-model")?.value || "").trim()
                        : String(panel.querySelector("#settings-model")?.value || currentModelValue || appState.settings.model || "").trim();
                    appState.settings.providerApiKeys = {
                        ...(appState.settings.providerApiKeys || {}),
                        ...(currentApiKey ? { [previousProvider]: currentApiKey } : {})
                    };
                    appState.settings.providerModels = {
                        ...(appState.settings.providerModels || {}),
                        ...(previousModel ? { [previousProvider]: previousModel } : {})
                    };
                    appState.settings.provider = val;
                    appState.settings.apiKey = String(appState.settings.providerApiKeys?.[val] || "").trim();
                    const providerOptions = getProviderModelOptions(val);
                    if (val === "custom") {
                        appState.settings.model = String(appState.settings.customModel || appState.settings.model || "").trim();
                    } else if (appState.settings.providerModels?.[val]) {
                        appState.settings.model = String(appState.settings.providerModels[val] || "").trim();
                    } else if (providerOptions.length && !providerOptions.includes(String(appState.settings.model || "").trim())) {
                        appState.settings.model = providerOptions[0];
                    }
                    
                    // Update selection visual
                    selectOptions.querySelectorAll(".custom-option").forEach(opt => opt.classList.remove("selected"));
                    option.classList.add("selected");
                    
                    // Trigger hints update
                    renderSettings(panel);

                    // Trigger save
                    saveSettingsFromPanel(true, { requestProviderPermission: true });
                } else {
                    selectContainer.classList.remove("open");
                }
            });
        });

        // Global click listener to close dropdown is handled in bindPanelDelegatedEvents or via document listener
        // But since renderSettings can be called multiple times, we should attach a document listener once or handle it locally.
        // A simple way is to add a click listener to the panel or document that closes this specific dropdown.
        // To avoid multiple listeners, we can rely on the global listener in bindPanelDelegatedEvents if we add one there, 
        // OR we can add a one-time listener here that removes itself when the element is removed.
        // For simplicity and robustness, let's add a document click handler that checks if the click is outside.
        
        const closeDropdown = (e) => {
             if (!selectContainer.contains(e.target)) {
                selectContainer.classList.remove("open");
            }
        };
        
        // Remove previous listener if exists (tricky without reference), so we use a named function attached to the element
        if(selectContainer._closeHandler) {
            document.removeEventListener("click", selectContainer._closeHandler);
        }
        selectContainer._closeHandler = closeDropdown;
        document.addEventListener("click", closeDropdown);
    }
    bindSettingsCustomSelects(panel);

    panel.querySelector("#settings-base-url")?.addEventListener("input", () => updateSettingsProviderHint(panel));
    ["#settings-base-url"].forEach((selector) => {
        panel.querySelector(selector)?.addEventListener("blur", (event) => {
            const prefixed = ensureHttpsUrlPrefixInput(event.currentTarget.value);
            if (prefixed) event.currentTarget.value = prefixed;
        });
    });
    updateSettingsProviderHint(panel);
    const asrProviderSelect = panel.querySelector("#settings-asr-provider");
    if (asrProviderSelect) {
        asrProviderSelect.addEventListener("change", () => {
            syncPromptSettingsDraft(panel);
            updateSettingsAsrProviderHint(panel);
        });
    }
    updateSettingsAsrProviderHint(panel);

    // Dynamic Slider Fill Logic
    const updateSliderFill = (slider) => {
        const min = Number(slider.min ?? 0);
        const max = Number(slider.max ?? 2);
        const val = Number(slider.value ?? 1);
        const pct = ((val - min) / (max - min)) * 100;
        slider.style.background = `linear-gradient(to right, #fb7299 ${pct}%, #e3e8ec ${pct}%)`;
    };

    // Auto-save & Validation Logic
    const debounce = (func, wait) => {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => func(...args), wait);
        };
    };

    const triggerAutoSave = () => saveSettingsFromPanel(true);
    const debouncedSave = debounce(triggerAutoSave, 500);

    // Initialize all sliders
    panel.querySelectorAll("input[type='range']").forEach(slider => {
        updateSliderFill(slider);
        slider.addEventListener("input", () => {
            updateSliderFill(slider);
            syncPromptSettingsDraft(panel);
            debouncedSave();
        });
    });

    const promptModeSelect = panel.querySelector("#settings-prompt-mode");
    const promptGuidedWrap = panel.querySelector("#settings-prompt-guided-wrap");
    const promptCustomWrap = panel.querySelector("#settings-prompt-custom-wrap");
    const providerModelSelect = panel.querySelector("#settings-provider-model");
    const providerCustomModelInput = panel.querySelector("#settings-provider-custom-model");
    const applyProviderModelVisibility = () => {
        if (providerCustomModelInput) {
            providerCustomModelInput.classList.toggle("settings-hidden", String(providerModelSelect?.value || "") !== "custom");
        }
        updateSettingsProviderHint(panel);
    };
    if (providerModelSelect) {
        providerModelSelect.addEventListener("change", () => {
            applyProviderModelVisibility();
            triggerAutoSave();
        });
    }
    applyProviderModelVisibility();
    panel.querySelector("#settings-disable-cloud-current")?.addEventListener("change", (event) => {
        updateCloudCacheReadPref("current", !!event.target.checked).catch((error) => {
            event.target.checked = !event.target.checked;
            showToast(error?.message || "保存失败");
        });
    });
    panel.querySelector("#settings-disable-cloud-all")?.addEventListener("change", (event) => {
        updateCloudCacheReadPref("all", !!event.target.checked).catch((error) => {
            event.target.checked = !event.target.checked;
            showToast(error?.message || "保存失败");
        });
    });
    const applyPromptModeVisibility = () => {
        const mode = String(promptModeSelect?.value || "guided") === "custom" ? "custom" : "guided";
        if (promptGuidedWrap) promptGuidedWrap.classList.toggle("settings-hidden", mode !== "guided");
        if (promptCustomWrap) promptCustomWrap.classList.toggle("settings-hidden", mode !== "custom");
    };
    if (promptModeSelect) {
        promptModeSelect.addEventListener("change", () => {
            syncPromptSettingsDraft(panel);
            applyPromptModeVisibility();
            triggerAutoSave();
        });
    }
    applyPromptModeVisibility();

    const secretInputs = Array.from(panel.querySelectorAll("[data-secret-input]"));
    const normalizeSecretInput = (input) => {
        if (!input) return "";
        const trimmed = String(input.value || "").trim();
        if (input.value !== trimmed) input.value = trimmed;
        return trimmed;
    };
    const validateSecretInput = (input, shouldTrim = false) => {
        if (!input) return true;
        const val = shouldTrim ? normalizeSecretInput(input) : String(input.value || "");
        const invalid = /[\s\u4e00-\u9fa5]/.test(val);
        const errorNode = panel.querySelector(`#${input.id}-error`);
        if (invalid) {
            input.classList.add("input-error");
            if (errorNode) errorNode.classList.add("show");
            return false;
        }
        input.classList.remove("input-error");
        if (errorNode) errorNode.classList.remove("show");
        return true;
    };

    const inputs = panel.querySelectorAll("input, textarea");
    inputs.forEach(input => {
        if (input.type === "range") return;
        if (input.dataset.feedbackField === "true") return;
        if (input.dataset.manualSave === "true") return;
        if (input.dataset.secretInput === "true") {
            input.addEventListener("input", () => {
                validateSecretInput(input, false);
            });
        }
        input.addEventListener("blur", () => {
            if (input.dataset.secretInput === "true" && !validateSecretInput(input, true)) return;
            triggerAutoSave();
        });
    });

    ["summary", "segments", "rumors"].forEach(key => {
        const textarea = panel.querySelector(`#settings-prompt-${key}`);
        const counter = panel.querySelector(`#count-${key}`);
        if (!textarea || !counter) return;
        
        const updateCount = () => {
            const len = textarea.value.length;
            counter.textContent = `${len}/1000`;
            counter.classList.toggle("over-limit", len > 400);
        };
        
        updateCount();
        textarea.addEventListener("input", () => {
            updateCount();
            syncPromptSettingsDraft(panel);
        });
    });

    const selects = panel.querySelectorAll("select");
    selects.forEach(select => {
        if (select.dataset.feedbackField === "true") return;
        select.addEventListener("change", triggerAutoSave);
    });
    panel.querySelectorAll("[data-feedback-field='true']").forEach((node) => {
        const syncDraft = () => {
            appState.feedbackDraft = {
                type: String(panel.querySelector("#feedback-type")?.value || "bug"),
                title: String(panel.querySelector("#feedback-title")?.value || ""),
                content: String(panel.querySelector("#feedback-content")?.value || ""),
                includeLogs: panel.querySelector("#feedback-include-logs")?.checked !== false
            };
        };
        node.addEventListener("input", syncDraft);
        node.addEventListener("change", syncDraft);
    });
    const nextScrollBody = panel.querySelector(".settings-scroll-body");
    if (nextScrollBody) nextScrollBody.scrollTop = prevScrollTop;
    if (activeId) {
        const nextActive = panel.querySelector(`#${activeId}`);
        if (nextActive && typeof nextActive.focus === "function") {
            try {
                nextActive.focus({ preventScroll: true });
            } catch (_) {
                nextActive.focus();
            }
            if (typeof nextActive.setSelectionRange === "function" && activeSelectionStart >= 0 && activeSelectionEnd >= 0) {
                const max = String(nextActive.value || "").length;
                const start = Math.max(0, Math.min(max, activeSelectionStart));
                const end = Math.max(0, Math.min(max, activeSelectionEnd));
                nextActive.setSelectionRange(start, end);
            }
        }
    }
    ensureFeedbackLoadedForSettings();
}

function renderErrorDemoControls() {
    const panelErrors = [
        ["HTTP_401", "401 Key 无效", "summary"],
        ["ALIYUN_REALNAME_REQUIRED", "阿里云未实名", "summary"],
        ["HTTP_403", "403 无权限", "summary"],
        ["HTTP_402_INSUFFICIENT_BALANCE", "402 余额不足", "summary"],
        ["HTTP_402_MODEL_UNAVAILABLE", "402 配置不可用", "summary"],
        ["MODEL_ACCESS_DENIED", "模型无权限", "summary"],
        ["ASR_FORBIDDEN", "转录 403", "summary"],
        ["INVALID_MODEL_ID", "模型 ID 无效", "summary"],
        ["HTTP_404", "404 模型/接口", "summary"],
        ["HTTP_429_INSUFFICIENT_QUOTA", "429 配额耗尽", "summary"],
        ["HTTP_429_RATE_LIMIT", "429 频率限制", "summary"],
        ["HTTP_429_QUEUE_EXCEEDED", "429 队列拥堵", "summary"],
        ["HTTP_429", "429 通用", "summary"],
        ["HTTP_5XX", "5XX 服务异常", "summary"],
        ["TIMEOUT", "超时", "summary"],
        ["AI_RESPONSE_TIMEOUT", "模型请求超时", "summary"],
        ["AI_STREAM_TIMEOUT", "模型流超时", "summary"],
        ["NETWORK_REQUEST_TIMEOUT", "网络请求超时", "summary"],
        ["ASR_REQUEST_TIMEOUT", "转录请求超时", "summary"],
        ["NETWORK_ERROR", "网络失败", "summary"],
        ["PROVIDER_NETWORK_ERROR", "模型服务网络失败", "summary"],
        ["FEEDBACK_SERVICE_UNAVAILABLE", "反馈服务不可用", "summary"],
        ["JSON_PARSE_ERROR", "JSON 格式", "summary"],
        ["RUMORS_JSON_PARSE_FAILED", "验真 JSON 坏", "real"],
        ["SEGMENTS_EMPTY_RESPONSE", "分段返回为空", "summary"],
        ["SEGMENTS_JSON_PARSE_FAILED", "分段 JSON 坏", "summary"],
        ["SEGMENTS_EMPTY_LIST", "分段空数组", "summary"],
        ["SEGMENTS_INVALID_SCHEMA", "分段字段缺失", "summary"],
        ["SEGMENTS_CONTEXT_TOO_LONG", "字幕太长", "summary"],
        ["SEGMENTS_OUTPUT_TRUNCATED", "分段被截断", "summary"],
        ["SEGMENTS_MISSING_PROTOCOL", "漏掉分段区块", "summary"],
        ["SEGMENTS_LINE_MAPPING_FAILED", "行号映射失败", "summary"],
        ["ASR_FILE_TOO_LARGE", "音频过大", "summary"],
        ["SUBTITLE_MISSING", "未获取到字幕", "summary"],
        ["HTTP_401", "聊天 401", "chat"],
        ["JSON_PARSE_ERROR", "验真 JSON", "real"]
    ];
    const toastErrors = [
        ["ASR_RATE_LIMIT", "ASR 限流"],
        ["CLOUD_FAILED", "云缓存失败"],
        ["DOWNLOAD_FAILED", "下载失败"]
    ];
    const renderOption = ([code, label]) => `<option value="${escapeHtml(code)}">${escapeHtml(label)} · ${escapeHtml(code)}</option>`;
    return `
        <section class="debug-tool-card">
            <div class="debug-tool-card-head">
                <div>
                    <strong>错误展示预览</strong>
                    <span>选择错误和展示页面，不再平铺全部按钮</span>
                </div>
                <span class="debug-risk-badge safe">安全预览</span>
            </div>
            <label class="debug-field-label" for="debug-error-code">错误类型</label>
            <select id="debug-error-code">
                <optgroup label="面板错误">${panelErrors.map(renderOption).join("")}</optgroup>
                <optgroup label="Toast 错误">${toastErrors.map(renderOption).join("")}</optgroup>
            </select>
            <label class="debug-field-label" for="debug-error-target">展示位置</label>
            <select id="debug-error-target">
                <option value="summary">总结页</option>
                <option value="chat">聊天页</option>
                <option value="real">验真页</option>
                <option value="CC">字幕页</option>
            </select>
            <div class="debug-card-actions">
                <button type="button" class="panel-btn primary" data-action="debug-run-error-demo">运行预览</button>
                <button type="button" class="panel-btn ghost" data-action="debug-clear-errors">清空错误状态</button>
            </div>
        </section>
    `;
}

function renderLifecycleDemoControls() {
    const currentVersion = globalThis.chrome?.runtime?.getManifest?.()?.version || "1.4.3";
    return `
        <section class="debug-tool-card">
            <div class="debug-tool-card-head">
                <div>
                    <strong>安装与更新</strong>
                    <span>预览安装、升级和版本入口</span>
                </div>
                <span class="debug-risk-badge reversible">可恢复状态</span>
            </div>
            <div class="debug-scenario-list">
                <button type="button" class="debug-scenario-row" data-action="debug-show-release-notice">
                    <span><strong>更新导览</strong><small>显示 v${escapeHtml(currentVersion)} 更新内容</small></span><b>运行</b>
                </button>
                <button type="button" class="debug-scenario-row" data-action="debug-show-version-update">
                    <span><strong>新版本入口</strong><small>显示可用版本更新提示</small></span><b>运行</b>
                </button>
                <button type="button" class="debug-scenario-row" data-action="debug-simulate-first-install">
                    <span><strong>首次安装体验</strong><small>打开首次安装引导</small></span><b>运行</b>
                </button>
            </div>
        </section>
    `;
}

async function deleteCurrentVideoCacheFromPanel() {
    const bvid = normalizeBvidCase(resolveCurrentBvid() || appState.cache?.bvid || "");
    if (!bvid) {
        showToast("未获取到当前视频");
        return;
    }
    const ok = window.confirm("确定删除当前视频的 AI 结果缓存吗？会清除总结、分段、聊天记录和验真结果，本地字幕缓存会保留。");
    if (!ok) return;
    const res = await chrome.runtime.sendMessage({ action: "DELETE_VIDEO_CACHE", bvid });
    if (!res?.ok) {
        showToast(res?.error || "删除失败");
        return;
    }
    appState.cache = null;
    resetTaskUiForDeletedCache();
    await updateCloudCacheReadPref("current", true, { silent: true, render: false });
    const currentCheckbox = panelShadowRoot?.getElementById("settings-disable-cloud-current");
    if (currentCheckbox) currentCheckbox.checked = true;
    await syncCacheFromBackground(bvid, { preserveCacheOnMiss: false, force: true, skipCloud: true }).catch(() => {});
    renderContent();
    showToast("已删除当前视频 AI 结果缓存，并已关闭本视频云端缓存拉取");
}

async function deleteAllVideoCacheFromPanel() {
    const ok = window.confirm("确定删除所有视频的 AI 结果缓存吗？会清除总结、分段、聊天记录和验真结果，本地字幕缓存会保留。");
    if (!ok) return;
    const res = await chrome.runtime.sendMessage({ action: "DELETE_ALL_VIDEO_CACHE" });
    if (!res?.ok) {
        showToast(res?.error || "删除失败");
        return;
    }
    appState.cache = null;
    resetTaskUiForDeletedCache();
    await updateCloudCacheReadPref("all", true, { silent: true, render: false });
    const allCheckbox = panelShadowRoot?.getElementById("settings-disable-cloud-all");
    if (allCheckbox) allCheckbox.checked = true;
    const currentBvid = normalizeBvidCase(resolveCurrentBvid() || "");
    if (currentBvid) {
        await syncCacheFromBackground(currentBvid, { preserveCacheOnMiss: false, force: true, skipCloud: true }).catch(() => {});
    }
    renderContent();
    showToast(`已删除 ${Number(res.deleted || 0)} 条 AI 结果缓存，并已关闭所有视频云端缓存拉取`);
}

async function updateCloudCacheReadPref(scope, disabled, options = {}) {
    const bvid = normalizeBvidCase(resolveCurrentBvid() || appState.cache?.bvid || "");
    const res = await chrome.runtime.sendMessage({
        action: "SET_CLOUD_CACHE_READ_PREF",
        scope,
        disabled,
        bvid
    });
    if (!res?.ok) throw new Error(res?.error || "保存失败");
    if (res.settings) appState.settings = res.settings;
    appState.cloudCachePrefs = normalizeCloudCachePrefs(res.cloudCachePrefs);
    if (disabled && (scope === "all" || scope === "current")) {
        appState.cloudReadState = createCloudReadState(bvid, "failed", Number(appState.cloudReadState?.requestId || 0) + 1);
    } else {
        appState.cloudReadState = createCloudReadState(bvid, "idle", Number(appState.cloudReadState?.requestId || 0) + 1);
    }
    if (options.render !== false) renderContent();
    if (!options.silent) showToast("缓存设置已保存");
}

function resetTaskUiForDeletedCache() {
    appState.chatPending = [];
    appState.timelineSearchTerm = "";
    appState.activeSubtitleId = "";
    appState.subtitleOptions = [];
    appState.subtitleOptionsBvid = "";
    appState.panelErrors = {};
}

function renderSubtitleEmptyDemoControls() {
    return `
        <section class="debug-tool-card">
            <div class="debug-tool-card-head">
                <div><strong>字幕空状态</strong><span>总结页无字幕提示组件预览</span></div>
                <span class="debug-risk-badge safe">安全预览</span>
            </div>
            <div class="debug-state-preview">
                ${renderMissingSubtitleState()}
            </div>
        </section>
    `;
}

function renderDebugSettingsControls() {
    const debugEnabled = !!appState.settings?.debugMode;
    return `
        <section class="debug-tool-card">
            <div class="debug-tool-card-head">
                <div><strong>调试日志</strong><span>控制开发者工具的诊断日志</span></div>
                <span class="debug-risk-badge reversible">持久设置</span>
            </div>
            <label class="debug-field-label" for="debug-mode-inline">调试日志</label>
            <select id="debug-mode-inline">
                <option value="false" ${debugEnabled ? "" : "selected"}>关闭</option>
                <option value="true" ${debugEnabled ? "selected" : ""}>开启</option>
            </select>
            <div class="debug-field-help">关闭后开发者工具入口会隐藏并返回设置页。开启后会记录脱敏后的 Prompt 分块信息。</div>
        </section>
    `;
}

function renderTaskRetryDebugPanel() {
    const retryState = appState.tabState?.taskRetryState?.segments || null;
    const taskStatus = String(appState.tabState?.taskStatus?.segments || "idle");
    const taskError = appState.tabState?.taskErrors?.segments || null;
    const events = Array.isArray(retryState?.events) ? retryState.events : [];
    const strategyMap = {
        merged: "省流联合请求",
        primary: "原 Prompt 重试",
        expanded_tokens: "提高输出上限重试",
        compact: "保守 Prompt 重试"
    };
    const statusMap = {
        idle: "空闲",
        processing: "处理中",
        done: "完成",
        error: "失败",
        timeout: "超时",
        running: "运行中",
        retrying: "重试中",
        retry_failed: "重试失败",
        recovered: "已恢复"
    };
    const strategyLabel = strategyMap[String(retryState?.strategy || "")] || "未重试";
    const code = String(retryState?.code || "");
    const mode = String(retryState?.mode || "");
    const stage = String(retryState?.stage || "");
    const updatedAt = Number(retryState?.updatedAt || 0);
    const updatedText = updatedAt ? new Date(updatedAt).toLocaleTimeString() : "-";
    const eventListHtml = events.length
        ? `<div class="debug-state-preview" style="margin-top:8px;">${events.map((item) => {
            const at = Number(item?.at || 0);
            const time = at ? new Date(at).toLocaleTimeString() : "--:--:--";
            return `<div style="margin-bottom:6px;"><strong>${escapeHtml(time)}</strong> · ${escapeHtml(String(item?.text || ""))}</div>`;
        }).join("")}</div>`
        : `<div class="empty-text" style="margin-top:8px;">当前还没有分段阶段事件。</div>`;
    return `
        <section class="debug-tool-card">
            <div class="debug-tool-card-head">
                <div><strong>分段自动重试</strong><span>真实调用模型并验证恢复策略</span></div>
                <span class="debug-risk-badge network">真实请求 · 可能计费</span>
            </div>
            <div class="debug-card-actions">
                <button type="button" class="panel-btn ghost" data-action="debug-run-segments-retry-test">测试字段结构错误</button>
                <button type="button" class="panel-btn ghost" data-action="debug-run-segments-truncation-retry-test">测试截断后提高至 8192</button>
            </div>
            <div class="debug-state-grid">
                <div><strong>任务状态：</strong>${escapeHtml(statusMap[taskStatus] || taskStatus)}</div>
                <div><strong>运行阶段：</strong>${escapeHtml(statusMap[String(retryState?.status || "")] || String(retryState?.status || "未开始"))}</div>
                <div><strong>当前策略：</strong>${escapeHtml(strategyLabel)}</div>
                <div><strong>内部阶段：</strong>${escapeHtml(stage || "-")}</div>
                <div><strong>次数：</strong>${retryState ? `第 ${Number(retryState.attempt || 0)}/${Number(retryState.total || 0)} 次` : "-"}</div>
                <div><strong>触发错误：</strong>${escapeHtml(code || String(taskError?.code || "-"))}</div>
                <div><strong>任务模式：</strong>${escapeHtml(mode || "-")}</div>
                <div><strong>当前文案：</strong>${escapeHtml(String(retryState?.message || "-"))}</div>
                <div><strong>分段数量：</strong>${Number(retryState?.segmentCount || 0) || (Array.isArray(appState.cache?.segments) ? appState.cache.segments.length : 0)}</div>
                <div><strong>最后更新：</strong>${escapeHtml(updatedText)}</div>
            </div>
            <details class="debug-details">
                <summary>最近阶段事件</summary>
                ${eventListHtml}
            </details>
        </section>
    `;
}

function renderSummaryRetryDebugPanel() {
    const retryState = appState.tabState?.taskRetryState?.summary || null;
    const taskStatus = String(appState.tabState?.taskStatus?.summary || "idle");
    const events = Array.isArray(retryState?.events) ? retryState.events : [];
    const statusMap = {
        idle: "空闲",
        processing: "处理中",
        done: "完成",
        error: "失败",
        timeout: "超时",
        running: "运行中",
        retrying: "重试中",
        retry_failed: "重试失败",
        recovered: "已恢复"
    };
    const eventListHtml = events.length
        ? `<div class="debug-state-preview" style="margin-top:8px;">${events.map((item) => {
            const at = Number(item?.at || 0);
            const time = at ? new Date(at).toLocaleTimeString() : "--:--:--";
            return `<div style="margin-bottom:6px;"><strong>${escapeHtml(time)}</strong> · ${escapeHtml(String(item?.text || ""))}</div>`;
        }).join("")}</div>`
        : `<div class="empty-text" style="margin-top:8px;">当前还没有总结重试事件。</div>`;
    return `
        <section class="debug-tool-card">
            <div class="debug-tool-card-head">
                <div><strong>总结空响应重试</strong><span>首轮完成后强制判空，再真实请求一次</span></div>
                <span class="debug-risk-badge network">真实请求 · 可能计费</span>
            </div>
            <button type="button" class="panel-btn ghost" data-action="debug-run-summary-empty-retry-test">测试总结为空后重试</button>
            <div class="debug-state-grid">
                <div><strong>任务状态：</strong>${escapeHtml(statusMap[taskStatus] || taskStatus)}</div>
                <div><strong>重试状态：</strong>${escapeHtml(statusMap[String(retryState?.status || "")] || String(retryState?.status || "未开始"))}</div>
                <div><strong>内部阶段：</strong>${escapeHtml(String(retryState?.stage || "-"))}</div>
                <div><strong>次数：</strong>${retryState ? `第 ${Number(retryState.attempt || 0)}/${Number(retryState.total || 1)} 次` : "-"}</div>
                <div><strong>触发错误：</strong>${escapeHtml(String(retryState?.code || "-"))}</div>
                <div><strong>当前文案：</strong>${escapeHtml(String(retryState?.message || "-"))}</div>
            </div>
            <details class="debug-details">
                <summary>最近阶段事件</summary>
                ${eventListHtml}
            </details>
        </section>
    `;
}

function renderAsrChunkingStatePanel() {
    const boundaries = Array.isArray(appState.tabState?.taskRetryState?.asrChunking?.boundaries)
        ? appState.tabState.taskRetryState.asrChunking.boundaries
        : [];
    const renderRows = (rows = []) => {
        if (!rows.length) return `<div class="empty-text">无</div>`;
        return rows.map((row) => {
            const hasTimeline = Number.isFinite(Number(row?.start)) && Number.isFinite(Number(row?.end));
            const label = hasTimeline ? `${formatTime(Number(row.start))}-${formatTime(Number(row.end))}` : "无时间轴";
            return `<div class="debug-boundary-row"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(String(row?.text || ""))}</span></div>`;
        }).join("");
    };
    const content = boundaries.length
        ? boundaries.map((item) => `
            <details class="debug-details">
                <summary>Chunk ${Number(item?.chunkIndex || 0)}/${Number(item?.chunkCount || 0)} · ${formatTime(Number(item?.startSec || 0))}-${formatTime(Number(item?.endSec || 0))}</summary>
                <div class="debug-boundary-group"><b>本片开头</b>${renderRows(item?.sourceHead || [])}</div>
                <div class="debug-boundary-group"><b>本片结尾</b>${renderRows(item?.sourceTail || [])}</div>
                <div class="debug-boundary-group"><b>合并前上一片尾部</b>${renderRows(item?.mergedTailBefore || [])}</div>
                <div class="debug-boundary-group"><b>合并后尾部</b>${renderRows(item?.mergedTailAfter || [])}</div>
            </details>
        `).join("")
        : `<div class="empty-text">当前还没有 ASR 切片边界诊断数据。</div>`;
    return `
        <section class="debug-tool-card">
            <div class="debug-tool-card-head">
                <div><strong>ASR 切片边界</strong><span>${boundaries.length} 个边界诊断</span></div>
                <span class="debug-risk-badge state">状态快照</span>
            </div>
            ${content}
        </section>
    `;
}

function renderDebugPanel(panel) {
    panel.dataset.lastSignature = "debug";
    const manifestVersion = globalThis.chrome?.runtime?.getManifest?.()?.version || "";
    const buildText = manifestVersion
        ? `${DEBUG_PANEL_BUILD_STAMP} · v${manifestVersion}`
        : DEBUG_PANEL_BUILD_STAMP;
    const activeTab = ["overview", "scenarios", "logs", "state"].includes(appState.debugToolsTab)
        ? appState.debugToolsTab
        : "overview";
    appState.debugToolsTab = activeTab;
    stopRealtimeLogPolling();
    const tabContent = activeTab === "scenarios"
        ? renderDebugScenariosPanel()
        : activeTab === "logs"
            ? renderRealtimeLogPanel()
            : activeTab === "state"
                ? renderDebugStatePanel()
                : renderDebugOverviewPanel();
    panel.innerHTML = `
        <div class="page-header debug-tools-header">
            <div class="debug-tools-title">
                <div>
                    <h3>开发者工具</h3>
                    <div class="empty-text">${escapeHtml(buildText)}</div>
                </div>
                <span class="debug-runtime-badge"><i></i>Debug 已开启</span>
            </div>
            <div class="debug-header-actions">
                <button type="button" class="panel-btn ghost" data-action="debug-copy-diagnostics">复制诊断</button>
                <button type="button" class="panel-btn ghost" data-action="debug-clear-session">清空会话</button>
            </div>
        </div>
        <nav class="debug-tools-tabs" aria-label="开发者工具页签">
            ${[
                ["overview", "概览"],
                ["scenarios", "场景测试"],
                ["logs", "日志"],
                ["state", "状态"]
            ].map(([id, label]) => `<button type="button" class="${activeTab === id ? "active" : ""}" data-action="debug-switch-tab" data-tab="${id}">${label}</button>`).join("")}
        </nav>
        <div class="page-body debug-page-body">
            ${tabContent}
        </div>
    `;
    if (activeTab === "scenarios") bindSegmentPromptDebugControls(panel);
    if (activeTab === "logs") {
        bindRealtimeLogPanel(panel);
        renderRealtimeLogData();
        startRealtimeLogPolling();
    }
}

function renderDebugScenarioResult() {
    const result = appState.debugScenarioResult;
    if (!result) {
        return `<div class="debug-empty-card">尚未运行场景。进入“场景测试”后选择一个测试开始。</div>`;
    }
    const statusLabel = {
        running: "运行中",
        passed: "通过",
        failed: "失败",
        cancelled: "已取消",
        needs_config: "需要配置"
    }[result.status] || "完成";
    return `
        <article class="debug-result-card ${escapeHtml(result.status)}">
            <div class="debug-result-head">
                <span><i></i>${escapeHtml(statusLabel)}</span>
                <time>${escapeHtml(formatTimelineTime(result.updatedAt))}</time>
            </div>
            <strong>${escapeHtml(result.title)}</strong>
            ${result.expected ? `<p><b>预期：</b>${escapeHtml(result.expected)}</p>` : ""}
            ${result.actual ? `<p><b>实际：</b>${escapeHtml(result.actual)}</p>` : ""}
            <div class="debug-result-meta">
                <span>Trace ${escapeHtml(result.traceId)}</span>
                ${result.durationMs ? `<span>${Math.round(result.durationMs)} ms</span>` : ""}
            </div>
        </article>
    `;
}

function renderDebugOverviewPanel() {
    const bvid = normalizeBvidCase(resolveCurrentBvid() || appState.cache?.bvid || "") || "-";
    const cid = Number(resolveCid() || appState.cache?.cid || 0);
    const tid = String(getTidFromUrl(location.href) || "");
    const taskStatus = appState.tabState?.taskStatus || {};
    const taskRows = [
        ["Summary", taskStatus.summary || "idle"],
        ["Segments", taskStatus.segments || "idle"],
        ["Real-time", taskStatus.rumors || "idle"],
        ["ASR", isTranscriptionRunning() ? "processing" : "idle"]
    ];
    return `
        <section class="debug-overview-hero">
            <div><span>当前视频</span><strong>${escapeHtml(bvid)}</strong><small>${cid ? `CID ${cid}` : "CID 未知"}${tid ? ` · P${escapeHtml(tid)}` : ""}</small></div>
            <div><span>Provider</span><strong>${escapeHtml(String(appState.settings?.provider || "-"))}</strong><small>${escapeHtml(String(appState.settings?.model || "未选择模型"))}</small></div>
        </section>
        <section class="debug-tool-card">
            <div class="debug-tool-card-head"><div><strong>当前任务</strong><span>当前标签页的任务状态</span></div><span class="debug-risk-badge state">实时状态</span></div>
            <div class="debug-task-status-list">
                ${taskRows.map(([label, status]) => `<div><span>${label}</span><b class="status-${escapeHtml(status)}">${escapeHtml(status)}</b></div>`).join("")}
            </div>
        </section>
        <section class="debug-tool-card">
            <div class="debug-tool-card-head"><div><strong>最近场景</strong><span>场景运行结果和关联 Trace</span></div></div>
            ${renderDebugScenarioResult()}
        </section>
        <section class="debug-quick-actions">
            <button type="button" class="panel-btn ghost" data-action="debug-switch-tab" data-tab="scenarios">运行场景测试</button>
            <button type="button" class="panel-btn ghost" data-action="debug-switch-tab" data-tab="logs">查看日志</button>
            <button type="button" class="panel-btn ghost" data-action="debug-switch-tab" data-tab="state">查看状态快照</button>
        </section>
    `;
}

function renderDebugScenariosPanel() {
    return `
        ${renderTaskRetryDebugPanel()}
        ${renderSummaryRetryDebugPanel()}
        ${renderErrorDemoControls()}
        ${renderSubtitleEmptyDemoControls()}
        ${renderLifecycleDemoControls()}
        ${renderDebugSettingsControls()}
    `;
}

function buildDebugStateSnapshot() {
    const bvid = normalizeBvidCase(resolveCurrentBvid() || appState.cache?.bvid || "");
    const cid = Number(resolveCid() || appState.cache?.cid || 0);
    const tid = String(getTidFromUrl(location.href) || "");
    const rawRows = Array.isArray(appState.cache?.rawSubtitle) ? appState.cache.rawSubtitle : [];
    const processedRows = Array.isArray(appState.cache?.processedSubtitle) ? appState.cache.processedSubtitle : [];
    return {
        video: {
            bvid,
            cid,
            page: tid,
            part_key: bvid && cid ? `${bvid}::${cid}` : ""
        },
        subtitle: {
            source: appState.cache?.subtitleSource || appState.cache?.source || "",
            raw_rows: rawRows.length,
            processed_rows: processedRows.length,
            active_language: appState.activeSubtitleId || ""
        },
        tasks: { ...(appState.tabState?.taskStatus || {}) },
        asr: {
            active: !!appState.asrSession?.active,
            stage: appState.asrSession?.stage || "",
            progress: Number(appState.asrSession?.progress || 0),
            provider: appState.settings?.asrProvider || "groq"
        },
        cache: {
            present: !!appState.cache,
            schema_version: Number(appState.cache?.schemaVersion || 0),
            has_summary: !!String(appState.cache?.summary || "").trim(),
            segment_count: Array.isArray(appState.cache?.segments) ? appState.cache.segments.length : 0,
            history_count: Array.isArray(appState.cache?.history) ? appState.cache.history.length : 0,
            task_sources: appState.cache?.taskSources || {}
        },
        runtime: {
            debug: isDebugLoggingEnabled(),
            tab_id: Number(appState.tabId || 0),
            provider: appState.settings?.provider || "",
            model: appState.settings?.model || ""
        }
    };
}

function renderDebugStatePanel() {
    const snapshot = buildDebugStateSnapshot();
    const rows = [
        ["BVID", snapshot.video.bvid || "-"],
        ["CID / P", `${snapshot.video.cid || "-"} / ${snapshot.video.page || "-"}`],
        ["字幕", `${snapshot.subtitle.processed_rows || snapshot.subtitle.raw_rows} 行 · ${snapshot.subtitle.source || "未知来源"}`],
        ["ASR", snapshot.asr.active ? `${snapshot.asr.stage || "运行中"} · ${snapshot.asr.progress}%` : "空闲"],
        ["缓存", snapshot.cache.present ? `命中 · ${snapshot.cache.segment_count} 个分段` : "未命中"],
        ["Provider", `${snapshot.runtime.provider || "-"} · ${snapshot.runtime.model || "-"}`]
    ];
    return `
        <section class="debug-tool-card">
            <div class="debug-tool-card-head"><div><strong>当前状态快照</strong><span>不包含字幕正文、Prompt 和密钥</span></div><span class="debug-risk-badge state">只读</span></div>
            <div class="debug-state-table">
                ${rows.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join("")}
            </div>
        </section>
        ${renderAsrChunkingStatePanel()}
        <section class="debug-tool-card">
            <details class="debug-details">
                <summary>原始状态 JSON</summary>
                <pre class="debug-state-json">${escapeHtml(JSON.stringify(snapshot, null, 2))}</pre>
            </details>
        </section>
    `;
}

function bindSegmentPromptDebugControls(panel) {
    const liveRetryTests = [
        {
            selector: '[data-action="debug-run-segments-retry-test"]',
            id: "segments_retry",
            title: "分段字段结构错误重试",
            tasks: ["segments"],
            runtimeAction: "RUN_SEGMENTS_RETRY_TEST",
            expected: "字段结构错误后采用原 Prompt 或保守 Prompt 恢复"
        },
        {
            selector: '[data-action="debug-run-segments-truncation-retry-test"]',
            id: "segments_truncation_retry",
            title: "分段截断提高上限重试",
            tasks: ["segments"],
            runtimeAction: "RUN_SEGMENTS_TRUNCATION_RETRY_TEST",
            expected: "截断后使用 8192 输出上限重试一次"
        },
        {
            selector: '[data-action="debug-run-summary-empty-retry-test"]',
            id: "summary_empty_retry",
            title: "总结空响应重试",
            tasks: ["summary"],
            runtimeAction: "RUN_SUMMARY_EMPTY_RETRY_TEST",
            expected: "首轮总结判空后自动补发一次总结请求"
        }
    ];
    liveRetryTests.forEach((test) => {
        const button = panel?.querySelector(test.selector);
        if (!button) return;
        button.addEventListener("click", async () => {
            const confirmed = window.confirm("该测试会真实调用当前 AI Provider，可能产生 API 费用。确定继续吗？");
            if (!confirmed) {
                recordDebugScenarioResult({
                    id: test.id,
                    title: test.title,
                    status: "cancelled",
                    expected: test.expected,
                    actual: "已取消，未发起请求"
                });
                renderContent();
                return;
            }
            button.disabled = true;
            const startedAt = Date.now();
            const traceId = `debug_${test.id}_${startedAt.toString(36)}`;
            recordDebugScenarioResult({
                id: test.id,
                title: test.title,
                status: "running",
                expected: test.expected,
                actual: "正在运行",
                traceId
            });
            try {
                clearPanelError("summary");
                await runTasks(test.tasks, { overrideAction: test.runtimeAction });
                await syncCacheFromBackground(resolveCurrentBvid(), {
                    force: true,
                    skipCloud: true,
                    preserveCacheOnMiss: true
                });
                const finalStatuses = test.tasks.map((task) => ({
                    task,
                    status: getCurrentVideoTaskStatus(task)
                }));
                const passed = finalStatuses.every((item) => item.status === "done");
                const failedItem = finalStatuses.find((item) => item.status !== "done");
                const errorView = failedItem ? getCurrentVideoTaskErrorView(failedItem.task) : null;
                const actual = passed
                    ? `最终任务状态：${finalStatuses.map((item) => `${item.task}=done`).join("、")}`
                    : (errorView?.message || `最终任务状态：${finalStatuses.map((item) => `${item.task}=${item.status}`).join("、")}`);
                recordDebugScenarioResult({
                    id: test.id,
                    title: test.title,
                    status: passed ? "passed" : "failed",
                    expected: test.expected,
                    actual,
                    durationMs: Date.now() - startedAt,
                    traceId
                });
                showToast(passed ? `${test.title}通过` : `${test.title}失败`);
            } catch (error) {
                recordDebugScenarioResult({
                    id: test.id,
                    title: test.title,
                    status: "failed",
                    expected: test.expected,
                    actual: error?.message || "测试失败",
                    durationMs: Date.now() - startedAt,
                    traceId
                });
                showToast(error.message || "触发测试失败");
            } finally {
                button.disabled = false;
                renderContent();
            }
        });
    });
    const debugSelect = panel?.querySelector("#debug-mode-inline");
    if (debugSelect) {
        debugSelect.addEventListener("change", async () => {
            const debugMode = String(debugSelect.value || "false") === "true";
            if (!debugMode && !window.confirm("关闭后开发者工具入口会隐藏，并返回设置页。确定关闭吗？")) {
                debugSelect.value = "true";
                return;
            }
            const nextSettings = { ...(appState.settings || {}), debugMode };
            try {
                const res = await chrome.runtime.sendMessage({ action: "SAVE_SETTINGS", settings: nextSettings });
                if (!res?.ok) throw new Error(res?.error || "保存失败");
                appState.settings = res.settings || nextSettings;
                IS_DEBUG_MODE = !!debugMode;
                globalThis.AIPluginLogger?.setDebugEnabled?.(isDebugLoggingEnabled());
                syncInjectDebugMode();
                logUI.info(debugMode ? "runtime_debug_enabled" : "runtime_debug_disabled", {
                    task: "debug",
                    detail: { source: "debug_page_inline_toggle" }
                });
                showToast(debugMode ? "已开启调试日志" : "已关闭调试日志");
                renderNav();
                renderRealtimeLogData();
            } catch (error) {
                showToast(error.message || "切换失败");
                debugSelect.value = appState.settings?.debugMode ? "true" : "false";
            }
        });
    }
}

function renderRealtimeLogPanel() {
    return `
        <section class="debug-tool-card debug-log-tool-card">
            <div class="debug-tool-card-head">
                <div><strong>统一日志</strong><span>结构化日志与 ASR UI Trace 合并展示</span></div>
                <span class="debug-risk-badge state">本地会话</span>
            </div>
            <div class="debug-log-filters">
                <select id="debug-log-level" aria-label="日志等级">
                    ${["all", "error", "warn", "info", "debug"].map((level) => `<option value="${level}" ${appState.debugLogLevel === level ? "selected" : ""}>${level === "all" ? "全部等级" : level.toUpperCase()}</option>`).join("")}
                </select>
                <select id="debug-log-module" aria-label="日志模块">
                    ${["all", "asr_ui", "asr", "download", "subtitle", "ai", "cache", "background", "content", "ui", "inject", "cloud"].map((module) => `<option value="${module}" ${appState.debugLogModule === module ? "selected" : ""}>${module === "all" ? "全部模块" : module}</option>`).join("")}
                </select>
                <input id="debug-log-query" type="search" value="${escapeHtml(appState.debugLogQuery || "")}" placeholder="搜索事件、任务、错误码">
                <label class="debug-log-failure-toggle"><input id="debug-log-only-failures" type="checkbox" ${appState.debugLogOnlyFailures ? "checked" : ""}>只看失败/兜底</label>
            </div>
            <div class="debug-log-view-switch">
                <button type="button" class="${appState.debugLogView === "timeline" ? "active" : ""}" data-action="debug-log-view" data-view="timeline">时间线</button>
                <button type="button" class="${appState.debugLogView === "raw" ? "active" : ""}" data-action="debug-log-view" data-view="raw">原始日志</button>
            </div>
            <div class="debug-log-panel">
            <div class="debug-log-toolbar">
                <span class="debug-log-status" id="debug-log-status">自动刷新中</span>
                <div class="debug-log-actions">
                    <button type="button" class="panel-btn ghost" data-action="debug-logs-refresh">刷新</button>
                    <button type="button" class="panel-btn ghost" data-action="debug-logs-copy">复制</button>
                    <button type="button" class="panel-btn ghost" data-action="debug-logs-clear">清空</button>
                </div>
            </div>
                <div class="debug-log-body" id="debug-log-body">正在读取日志...</div>
            </div>
        </section>
    `;
}

function bindRealtimeLogPanel(panel) {
    if (!panel) return;
    const refresh = () => renderRealtimeLogData();
    panel.querySelector("#debug-log-level")?.addEventListener("change", (event) => {
        appState.debugLogLevel = String(event.target?.value || "all");
        refresh();
    });
    panel.querySelector("#debug-log-module")?.addEventListener("change", (event) => {
        appState.debugLogModule = String(event.target?.value || "all");
        refresh();
    });
    panel.querySelector("#debug-log-query")?.addEventListener("input", (event) => {
        appState.debugLogQuery = String(event.target?.value || "");
        refresh();
    });
    panel.querySelector("#debug-log-only-failures")?.addEventListener("change", (event) => {
        appState.debugLogOnlyFailures = !!event.target?.checked;
        refresh();
    });
    panel.querySelector('[data-action="debug-logs-refresh"]')?.addEventListener("click", () => {
        refresh();
    });
    panel.querySelector('[data-action="debug-logs-copy"]')?.addEventListener("click", () => {
        copyRealtimeLogData();
    });
    panel.querySelector('[data-action="debug-logs-clear"]')?.addEventListener("click", () => {
        clearRealtimeLogs();
    });
}

async function runTasks(tasks, options = {}) {
    if (hasLocalPendingTasks(tasks)) return;
    setLocalPendingTasks(tasks, true);
    renderContent();
    // Check for subtitle existence before running summary or segments
    if (!canRunTasksWithCache(tasks, resolveCurrentBvid(), appState.cache)) {
        const currentBvid = resolveCurrentBvid();
        if (needsSubtitleForTasks(tasks) && currentBvid) {
            const synced = await syncCacheFromBackgroundWithRetry(currentBvid, 3, 120, { skipCloud: false });
            if (synced && canRunTasksWithCache(tasks, currentBvid, appState.cache)) {
                setLocalPendingTasks(tasks, false);
                return runTasks(tasks, options);
            }
        }
        setLocalPendingTasks(tasks, false);
        if (!currentBvid || normalizeBvidCase(appState.cache?.bvid || "") !== normalizeBvidCase(currentBvid) || !hasSubtitleInCache(appState.cache)) {
            if (currentBvid) {
                appState.cloudReadState = createCloudReadState(
                    currentBvid,
                    "failed",
                    Number(appState.cloudReadState?.requestId || 0)
                );
            }
            if (appState.activePage === "summary") renderContent();
            showToast("当前视频暂无字幕，无法生成总结");
        }
        return;
    }

    const taskId = buildTasksProgressTaskId(tasks);
    try {
        appState.visibleProgressCompletedTaskIds.delete(taskId);
        tasks.forEach((t) => appState.sessionGeneratedTasks.add(t));
        tasks.forEach((t) => {
            if (t === "summary" || t === "segments") clearPanelError("summary");
            if (t === "rumors") clearPanelError("real");
        });
        startAsymptoticPseudoProgress(taskId, 12);
        const durationMeta = resolveVideoDurationMeta();
        const taskContext = {
            ...(durationMeta ? { videoDuration: durationMeta } : {}),
            cid: resolveCid(),
            tid: getTidFromUrl(location.href),
            partCount: getCurrentRoutePartCount(),
            ...((options && typeof options === "object" && options.taskContext) ? options.taskContext : {})
        };
        const runtimeAction = String(options?.overrideAction || "RUN_TASKS");
        logPartScopeDiagnostic("task_request_identity", {
            feature: tasks.join(","),
            runtimeAction,
            requestedBvid: normalizeBvidCase(resolveCurrentBvid() || "").toLowerCase(),
            requestedCid: Number(taskContext.cid || 0),
            requestedTid: String(taskContext.tid || "")
        });
        const res = await chrome.runtime.sendMessage({
            action: runtimeAction,
            tasks,
            force: true,
            bvid: normalizeBvidCase(resolveCurrentBvid() || ""),
            taskContext
        });
        if (!res?.ok) {
            const runtimeError = new Error(res?.error || "任务失败");
            runtimeError.code = res?.code || "";
            runtimeError.status = res?.status;
            runtimeError.retryAfterSec = res?.retryAfterSec;
            throw runtimeError;
        }
        if (!appState.visibleProgressCompletedTaskIds.has(taskId)) {
            finishAsymptoticPseudoProgress(taskId, false);
        }
        if (tasks.includes("summary") && res?.taskResults?.summary === true) {
            expandPanelAfterSummaryCompletion();
        }
    } catch (error) {
        if (!appState.visibleProgressCompletedTaskIds.has(taskId)) {
            finishAsymptoticPseudoProgress(taskId, true);
        }
        logContent.error("task_abort", {
            task: "generate",
            code: error?.code || "",
            status: Number(error?.status || 0) || 0,
            detail: {
                tasks,
                error_message: error.message || "任务失败",
                stack_preview: String(error.stack || "").split("\n").slice(0, 3).join("\n")
            }
        });
        reportContentError?.(error, { task: tasks.join(","), source: "run_tasks" });
        const targetPage = tasks.includes("rumors") ? "real" : "summary";
        const view = setPanelError(targetPage, error, error.message || "任务失败");
        if (view?.presentation === "toast") showToast(view.message);
        else renderContent();
    } finally {
        setLocalPendingTasks(tasks, false);
        renderContent();
        appState.visibleProgressCompletedTaskIds.delete(taskId);
    }
}

async function handleSendChat() {
    const panel = panelShadowRoot ? panelShadowRoot.getElementById("page-chat") : null;
    const input = panel?.querySelector("#chat-input");
    const text = String(input?.value || "").trim();
    if (!text) return;
    const messageId = createChatMessageId();
    const progressTaskId = buildChatProgressTaskId(messageId);
    clearPanelError("chat");
    
    input.value = "";
    appState.chatAutoScrollPausedUntil = 0;
    appState.chatStreamingId = `a_${messageId}`;
    appState.chatActiveMessageId = messageId;
    appState.sessionGeneratedTasks.add("chat");

    const currentPending = Array.isArray(appState.chatPending) ? appState.chatPending : [];
    appState.chatPending = [...currentPending, ...createPendingChatMessages(text, messageId)];
    startAsymptoticPseudoProgress(progressTaskId, 14);
    rerenderChatKeepInputAndScroll("");
    const port = getChatStreamPort();
    logPartScopeDiagnostic("task_request_identity", {
        feature: "chat",
        messageId,
        requestedBvid: normalizeBvidCase(resolveCurrentBvid() || "").toLowerCase(),
        requestedCid: Number(resolveCid() || 0),
        requestedTid: String(getTidFromUrl(location.href) || "")
    });
    port.postMessage({
        action: "RUN_CHAT_STREAM",
        text,
        messageId,
        bvid: normalizeBvidCase(resolveCurrentBvid() || ""),
        taskContext: {
            cid: resolveCid(),
            tid: getTidFromUrl(location.href),
            partCount: getCurrentRoutePartCount()
        }
    });
}

function handleStopChat() {
    const messageId = String(appState.chatActiveMessageId || "");
    if (!messageId) return;
    const port = getChatStreamPort();
    port.postMessage({ action: "ABORT_CHAT_STREAM", messageId });
}

function renderChatHistoryItem(item) {
    return renderChatHistoryItemHtml(item, {
        hideMetrics: shouldHideRuntimeMetrics(),
        onRenderError: (error) => {
            logUI.error("rich_content_render_failed", {
                task: "chat",
                code: "RENDER_FAILED",
                detail: { error_message: error.message || "渲染失败" }
            });
        }
    });
}

function renderAssistantBubble(text, metrics) {
    return renderAssistantBubbleHtml(text, metrics, {
        hideMetrics: shouldHideRuntimeMetrics(),
        onRenderError: (error) => {
            logUI.error("rich_content_render_failed", {
                task: "chat",
                code: "RENDER_FAILED",
                detail: { error_message: error.message || "渲染失败" }
            });
        }
    });
}

function renderTopRemaining() {
    const holder = panelShadowRoot ? panelShadowRoot.getElementById("logo-remaining") : null;
    const trigger = holder?.closest?.(".logo-remaining-container") || null;
    const setMetricText = (text) => {
        if (holder) {
            holder.textContent = text;
            holder.title = text;
        }
        if (trigger) trigger.dataset.buttonTooltip = text;
    };
    if (!holder) return;
    if (shouldHideRuntimeMetrics()) {
        setMetricText("任务运行中...");
        return;
    }
    const metrics = Array.isArray(appState.cache?.metrics) ? appState.cache.metrics : [];
    const latest = metrics[metrics.length - 1];
    if (!latest) {
        setMetricText("暂无调用指标");
        return;
    }
    const total = Number(latest.tokens || 0);
    const input = Number(latest.inputTokens || 0);
    const output = Number(latest.outputTokens || 0);
    const tokenStr = input || output ? `${total} (In ${input} / Out ${output})` : `${total}`;
    const latency = Number.isFinite(Number(latest.latencyMs)) ? `${(Number(latest.latencyMs) / 1000).toFixed(3)}s` : "-";
    const parts = [`用时: ${latency}`, `Tokens: ${tokenStr}`];
    if (String(latest.provider || "").toLowerCase() === "modelscope") {
        parts.push(
            `模型剩余 ${formatMetricQuotaValue(latest.modelScopeRemaining, latest.modelScopeModelLimit)}`,
            `账号剩余 ${formatMetricQuotaValue(latest.modelScopeUserRemaining, latest.modelScopeUserLimit)}`
        );
    }
    const metricLine = parts.join(" · ");
    setMetricText(metricLine);
}

function formatMetricQuotaValue(remaining, limit) {
    const hasRemaining = remaining !== null && remaining !== undefined && remaining !== "";
    const hasLimit = limit !== null && limit !== undefined && limit !== "";
    if (!hasRemaining) return hasLimit ? `官网未返回/${limit}` : "官网未返回";
    return hasLimit ? `${remaining}/${limit}` : String(remaining);
}

function renderChatRows(history) {
    const historyList = Array.isArray(history) ? history : [];
    const pending = Array.isArray(appState.chatPending) ? appState.chatPending : [];
    const historyIds = new Set(historyList.map((item) => String(item?.id || "")));
    const merged = [
        ...historyList,
        ...pending.filter((item) => !historyIds.has(String(item?.id || "")))
    ];
    return merged.map((item) => {
        // Show skeleton if loading OR if streaming but no content yet
        if (item.role === "assistant" && (item.status === "loading" || (item.status === "streaming" && !String(item.content || "")))) {
            return `<div class="chat-loading-only">${renderSkeletonLines(4, "chat-skeleton")}</div>`;
        }
        if (item.role === "assistant" && item.status === "streaming") {
            return renderAssistantBubble(item.content || "", item.metrics || null);
        }
        return renderChatHistoryItem(item);
    }).filter((html) => !!String(html || "").trim()).join("");
}

function rerenderChatKeepInputAndScroll(value) {
    if (appState.activePage !== "chat") return;
    const panel = panelShadowRoot ? panelShadowRoot.getElementById("page-chat") : null;
    if (!panel) return;
    const prevInput = panel.querySelector("#chat-input");
    const wasFocused = !!prevInput && (panelShadowRoot.activeElement === prevInput || document.activeElement === prevInput);
    const prevSelectionStart = wasFocused ? Number(prevInput.selectionStart || 0) : 0;
    const prevSelectionEnd = wasFocused ? Number(prevInput.selectionEnd || 0) : 0;
    const keepValue = typeof value === "string" ? value : String(prevInput?.value || "");
    renderChat(panel);
    const input = panel.querySelector("#chat-input");
    if (input) {
        input.value = keepValue;
        if (wasFocused) {
            try {
                input.focus({ preventScroll: true });
            } catch (_) {
                input.focus();
            }
            const max = input.value.length;
            const start = Math.max(0, Math.min(max, prevSelectionStart));
            const end = Math.max(0, Math.min(max, prevSelectionEnd));
            input.setSelectionRange(start, end);
        }
    }
    const list = panel.querySelector("#chat-list");
    if (list) {
        bindChatListAutoScroll(list);
        if (shouldAutoScrollChat()) scrollChatToBottom(list);
    }
}

function getChatStreamPort() {
    if (appState.chatPort) return appState.chatPort;
    const port = chrome.runtime.connect({ name: "chat-stream" });
    port.onMessage.addListener(onChatStreamMessage);
    port.onDisconnect.addListener(() => {
        const activeMessageId = String(appState.chatActiveMessageId || "");
        if (activeMessageId) {
            finishAsymptoticPseudoProgress(buildChatProgressTaskId(activeMessageId), true);
        }
        appState.chatPort = null;
    });
    appState.chatPort = port;
    return port;
}

function onChatStreamMessage(message) {
    const type = String(message?.type || "");
    const messageId = String(message?.messageId || "");
    if (!messageId) return;
    const currentPartKey = `${normalizeBvidCase(resolveCurrentBvid() || "").toLowerCase()}::${Number(resolveCid() || 0)}`;
    const messagePartKey = String(message?.partKey || "");
    if (messagePartKey && messagePartKey !== currentPartKey) {
        logPartScopeDiagnostic("chat_stream_rejected", {
            feature: "chat",
            messageId,
            messagePartKey,
            currentPartKey,
            reason: "part_key_mismatch"
        });
        return;
    }
    logPartScopeDiagnostic("chat_stream_accepted", {
        feature: "chat",
        messageId,
        messagePartKey,
        currentPartKey,
        type
    }, `chat-stream:${messageId}:${type}`);
    const progressTaskId = buildChatProgressTaskId(messageId);
    const assistantId = `a_${messageId}`;
    if (type === "delta") {
        const delta = String(message?.delta || "");
        if (!delta) return;
        appState.chatPending = (appState.chatPending || []).map((item) => {
            if (item.id !== assistantId) return item;
            const nextText = `${item.content || ""}${delta}`;
            return { ...item, status: "streaming", content: nextText };
        });
        rerenderChatKeepInputAndScroll("");
        return;
    }
    if (type === "done") {
        const answer = String(message?.answer || "");
        const metrics = message?.metrics || null;
        appState.chatPending = (appState.chatPending || []).map((item) => {
            if (item.id !== assistantId) return item;
            return { ...item, status: "done", content: answer, metrics };
        });
        appState.chatStreamingId = "";
        appState.chatActiveMessageId = "";
        finishAsymptoticPseudoProgress(progressTaskId, false);
        rerenderChatKeepInputAndScroll("");
        renderTopRemaining();
        return;
    }
    if (type === "aborted") {
        appState.chatPending = (appState.chatPending || []).map((item) => {
            if (item.id !== assistantId) return item;
            const text = String(item.content || "").trim() || "已停止";
            return { ...item, status: "done", content: text, metrics: item.metrics || null };
        });
        appState.chatStreamingId = "";
        appState.chatActiveMessageId = "";
        finishAsymptoticPseudoProgress(progressTaskId, false);
        rerenderChatKeepInputAndScroll("");
        return;
    }
    if (type === "error") {
        const errorInput = toErrorInput(message, "请求失败");
        const view = mapErrorToView ? mapErrorToView(errorInput, "请求失败") : null;
        const error = view?.message || String(message?.error || message?.message || "请求失败");
        if (view?.presentation !== "toast") {
            setPanelError("chat", errorInput, "请求失败");
            appState.chatPending = (appState.chatPending || []).filter((item) => item.id !== assistantId);
            appState.chatStreamingId = "";
            appState.chatActiveMessageId = "";
            finishAsymptoticPseudoProgress(progressTaskId, true);
            renderContent();
            return;
        }
    
        appState.chatPending = (appState.chatPending || []).map((item) => {
            if (item.id !== assistantId) return item;
            return {
                ...item,
                status: "done",
                content: `请求失败：${error}`,
                metrics: null,
                failed: true
            };
        });
    
        appState.chatStreamingId = "";
        appState.chatActiveMessageId = "";
        finishAsymptoticPseudoProgress(progressTaskId, true);
        rerenderChatKeepInputAndScroll("");
    
        setTimeout(() => {
            appState.chatPending = (appState.chatPending || []).filter((item) => {
                return !(item.id === assistantId && item.failed);
            });
            rerenderChatKeepInputAndScroll("");
        }, 5000);
    
        return;
    }
}

function scrollChatToBottom(list) {
    if (!list) return;
    const jumpToBottom = () => {
        list.scrollTop = list.scrollHeight;
    };
    jumpToBottom();
    if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                jumpToBottom();
            });
        });
    }
}

function pruneChatPendingByHistory(history) {
    const list = Array.isArray(history) ? history : [];
    if (!list.length || !Array.isArray(appState.chatPending) || !appState.chatPending.length) return;
    const ids = new Set(list.map((item) => String(item?.id || "")));
    appState.chatPending = appState.chatPending.filter((item) => !ids.has(String(item?.id || "")));
}

function resetPageStateByBvidSwitch() {
    logSubtitleDiagnostic("clear_requested", { source: "resetPageStateByBvidSwitch" });
    resetPanelCollapseForCurrentPart();
    beginSubtitleUiCycle();
    appState.cache = null;
    appState.chatPending = [];
    appState.chatStreamingId = "";
    appState.chatActiveMessageId = "";
    appState.sessionGeneratedTasks = new Set();
    if (appState.chatStreamTimer) {
        clearInterval(appState.chatStreamTimer);
        appState.chatStreamTimer = null;
    }
    appState.chatGuideHidden = false;
    
    const chatPanel = panelShadowRoot ? panelShadowRoot.getElementById("page-chat") : null;
    if (chatPanel) {
    chatPanel.dataset.lastSignature = "";
    chatPanel.innerHTML = "";
    }
    
    appState.followCurrentIndex = -1;
    appState.renderedSubtitleIndex = -1;
    closeCopyMenu();
    closeSubtitleLanguageMenu();
    appState.chatAutoScrollPausedUntil = 0;
    appState.subtitleCapturedBvid = "";
    appState.subtitleOptions = [];
    appState.subtitleOptionsBvid = "";
    appState.activeSubtitleId = "";
    appState.pendingSubtitle = null;
    appState.timelineSearchTerm = "";
    if (appState.timelineSearchDebounceTimer) {
        clearTimeout(appState.timelineSearchDebounceTimer);
        appState.timelineSearchDebounceTimer = null;
    }
    appState.ccSearchTerm = "";
    if (appState.ccSearchDebounceTimer) {
        clearTimeout(appState.ccSearchDebounceTimer);
        appState.ccSearchDebounceTimer = null;
    }
    if (appState.navActionActiveTimer) {
        clearTimeout(appState.navActionActiveTimer);
        appState.navActionActiveTimer = null;
    }
    appState.navActionActive = "";
    appState.lastSubtitleForwardAt = 0;
    appState.subtitleTimeline = [];
    resetTranscriptionState();
    clearAsrSession();
    appState.transcriptionDeclinedBvid = "";
    appState.transcriptionSuppressUntil = 0;
    appState.transcriptionCapsuleVisible = false;
    appState.transcriptionCapsuleMeta = null;
    appState.asrRequestDispatched = false;
    appState.subtitleDomDetected = false;
    appState.subtitleObserveUntil = 0;
    appState.subtitleCheckTargetBvid = "";
    appState.expandedSummaryHeight = 0;
    appState.lastCacheSyncTime = 0;
    appState.lastCacheSyncBvid = "";
    appState.isStateDirty = true;
    clearStepProgressTimers();
    clearPseudoProgressTicker();
    appState.progressTaskId = "";
    appState.progressLastPercent = 0;
    appState.progressLastTick = 0;
    clearStepProgressTimers();
    clearPseudoProgressTicker();
    const currentBvid = normalizeBvidCase(resolveCurrentBvid() || getBvidFromUrl(location.href) || "");

    if (appState.tabState && typeof appState.tabState === "object") {
        appState.tabState = {
            ...appState.tabState,
            transcriptionProgress: 0
        };
    }

    appState.pseudoProgressTaskId = "";
    appState.pseudoProgressValue = 0;
    appState.pseudoProgressStartedAt = 0;
    appState.cloudReadState = { bvid: "", status: "idle", requestId: 0, startedAt: 0 };
    appState.cache = null; // Explicitly clear cache
    appState.playInfo = null; // Explicitly clear playInfo
    const bar = panelShadowRoot ? panelShadowRoot.getElementById("step-progress-bar") : null;
    if (bar) resetStepProgressBar(bar);
    appState.segmentsMarkerTickAt = 0;
    removeSegmentsFloatWindow();
    removeSegmentsProgressMarkers();
    if (appState.subtitleCheckDelayTimer) {
        clearTimeout(appState.subtitleCheckDelayTimer);
        appState.subtitleCheckDelayTimer = null;
    }
    if (appState.transcribeCountdownTimer) {
        clearInterval(appState.transcribeCountdownTimer);
        appState.transcribeCountdownTimer = null;
    }
    stopSubtitleObserver();
}

function resetAllState() {
    logSubtitleDiagnostic("clear_requested", { source: "resetAllState" });
    resetPageStateByBvidSwitch();
    clearStreamCache();
    appState.renderedSubtitleIndex = -1;
    scheduleSubtitleRender("reset_all_state");
}

function resetAppState() {
    resetPageStateByBvidSwitch();
}

async function handleSmartCopy(buttonNode) {
    if (appState.activePage === "summary") {
        await handleCopySummaryText(buttonNode);
        return;
    }
    if (appState.activePage === "CC") {
        toggleCopyMenu(buttonNode);
        return;
    }
    await handleCopyRawSubtitle(buttonNode);
}

async function handleCopySummaryText(buttonNode) {
    const text = String(appState.cache?.summary || "").trim();
    if (!text) {
        showToast("暂无总结可复制");
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        showToast("复制成功");
    } catch (_) {
        showToast("复制失败");
    }
}

function toggleCopyMenu(buttonNode) {
    const existing = document.getElementById("copy-option-menu");
    if (existing) {
        existing.remove();
        return;
    }
    const rect = buttonNode?.getBoundingClientRect?.();
    const overlay = document.createElement("div");
    overlay.id = "copy-option-menu";
    overlay.className = "copy-menu-overlay";
    overlay.dataset.theme = resolveThemeMode();
    overlay.innerHTML = `<div class="copy-option-menu"><button type="button" class="copy-option-btn" data-action="copy-with-time">复制（带时间戳）</button><button type="button" class="copy-option-btn" data-action="copy-without-time">复制（纯文本）</button></div>`;
    const menu = overlay.querySelector(".copy-option-menu");
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeCopyMenu();
    });
    overlay.querySelector('[data-action="copy-with-time"]')?.addEventListener("click", () => {
        closeCopyMenu();
        handleCopySubtitleWithTimestamp();
    });
    overlay.querySelector('[data-action="copy-without-time"]')?.addEventListener("click", () => {
        closeCopyMenu();
        handleCopyRawSubtitle();
    });
    if (rect) {
        const left = Math.max(8, rect.right + 8);
        const top = Math.max(8, rect.top);
        overlay.style.setProperty("--copy-menu-left", `${left}px`);
        overlay.style.setProperty("--copy-menu-top", `${top}px`);
        if (menu) {
            menu.style.left = "var(--copy-menu-left)";
            menu.style.top = "var(--copy-menu-top)";
        }
    }
    document.body.appendChild(overlay);
}

function closeCopyMenu() {
    const menu = document.getElementById("copy-option-menu");
    if (menu) menu.remove();
    if (appState.navActionActive === "copy") {
        setNavActionActive("");
    }
}

function toggleSubtitleLanguageMenu(buttonNode) {
    const existing = document.getElementById("subtitle-language-menu");
    if (existing) {
        existing.remove();
        return;
    }
    const rect = buttonNode?.getBoundingClientRect?.();
    if (!buttonNode?.isConnected || !rect || rect.width <= 0 || rect.height <= 0) {
        showToast("字幕语言按钮尚未就绪");
        return;
    }
    const options = getOfficialSubtitleOptionsForCurrentVideo();
    if (options.length <= 1) {
        refreshSubtitleOptionsForCurrentVideo({ force: true, allowDomOpen: true })
            .then(() => {
                renderContent();
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        const freshButton = panelShadowRoot?.querySelector('[data-action="cc-language-menu"]');
                        const freshOptions = getOfficialSubtitleOptionsForCurrentVideo();
                        if (freshOptions.length > 1 && freshButton?.isConnected) toggleSubtitleLanguageMenu(freshButton);
                        else showToast("当前视频暂无可切换字幕语种");
                    });
                });
            })
            .catch(() => showToast("读取字幕语种失败"));
        return;
    }
    const overlay = document.createElement("div");
    overlay.id = "subtitle-language-menu";
    overlay.className = "copy-menu-overlay";
    overlay.dataset.theme = resolveThemeMode();
    const activeId = String(appState.activeSubtitleId || appState.cache?.subtitleLanguage || "");
    overlay.innerHTML = `<div class="copy-option-menu subtitle-language-menu">${options.map((item) => {
        const id = getSubtitleOptionId(item);
        const active = id && id === activeId;
        return `<button type="button" class="copy-option-btn subtitle-language-option ${active ? "active" : ""}" data-action="cc-switch-language" data-language-id="${escapeHtmlAttr(id)}">${escapeHtml(item.label || id)}${active ? " · 当前" : ""}</button>`;
    }).join("")}</div>`;
    const menu = overlay.querySelector(".copy-option-menu");
    if (menu) menu.style.visibility = "hidden";
    overlay.addEventListener("click", (event) => {
        const switchButton = event.target.closest?.("[data-action='cc-switch-language']");
        if (switchButton) {
            event.preventDefault();
            event.stopPropagation();
            closeSubtitleLanguageMenu();
            switchOfficialSubtitleLanguage(switchButton.dataset.languageId).catch((error) => {
                showToast(error?.message || "切换字幕失败");
            });
            return;
        }
        if (event.target === overlay) closeSubtitleLanguageMenu();
    });
    document.body.appendChild(overlay);
    if (rect && menu) {
        requestAnimationFrame(() => {
            const padding = 8;
            const menuRect = menu.getBoundingClientRect();
            const left = Math.max(padding, Math.min(rect.right + 8, window.innerWidth - menuRect.width - padding));
            const top = Math.max(padding, Math.min(rect.top, window.innerHeight - menuRect.height - padding));
            menu.style.left = `${Math.round(left)}px`;
            menu.style.top = `${Math.round(top)}px`;
            menu.style.visibility = "visible";
        });
    }
}

function closeSubtitleLanguageMenu() {
    document.getElementById("subtitle-language-menu")?.remove();
}

async function handleCopySubtitleWithTimestamp() {
    const rows = getRawSubtitleRows();
    if (!rows.length) {
        showToast("暂无 RAW 字幕");
        return;
    }
    const text = buildTimestampedSubtitleText(appState.cache);
    try {
        await navigator.clipboard.writeText(text);
        showToast("复制成功");
    } catch (_) {
        showToast("复制失败");
    }
}

function bindChatListAutoScroll(list) {
    if (!list || list.dataset.autoBound === "1") return;
    list.dataset.autoBound = "1";
    const pause = () => {
        appState.chatAutoScrollPausedUntil = Date.now() + 3000;
    };
    list.addEventListener("wheel", pause, { passive: true });
    list.addEventListener("touchmove", pause, { passive: true });
}

function shouldAutoScrollChat() {
    const isStreaming = !!String(appState.chatStreamingId || "").trim();
    return isStreaming && Date.now() >= Number(appState.chatAutoScrollPausedUntil || 0);
}

function isCloudReadLoadingForCurrentVideo() {
    if (!isCloudReadLoadingForVideo(appState.cloudReadState, resolveCurrentBvid())) return false;
    const startedAt = Number(appState.cloudReadState?.startedAt || 0);
    if (startedAt && Date.now() - startedAt > CLOUD_READ_TIMEOUT_MS + 500) {
        appState.cloudReadState = createCloudReadState(
            appState.cloudReadState?.bvid || resolveCurrentBvid() || "",
            "failed",
            Number(appState.cloudReadState?.requestId || 0)
        );
        return false;
    }
    return true;
}

function shouldAttemptCloudReadForVideo(bvid) {
    const prefs = normalizeCloudCachePrefs(appState.cloudCachePrefs);
    if (prefs.all || prefs.current) return false;
    return shouldAttemptCloudReadForVideoState(appState.cache, appState.cloudReadState, bvid || resolveCurrentBvid());
}

function shouldAttemptCloudReadForPage(page) {
    const prefs = normalizeCloudCachePrefs(appState.cloudCachePrefs);
    if (prefs.all || prefs.current) return false;
    return shouldAttemptCloudReadForPageState(appState.cache, appState.cloudReadState, resolveCurrentBvid(), page);
}

function isAsrSubtitleSourceValue(source) {
    const value = String(source || "").toLowerCase();
    return value === "groq" || value === "whisper" || value === "siliconflow" || value === "funasr" || value === "mimo" || value === "custom_asr";
}

function applyCacheSubtitleState(cache, targetBvid = "") {
    logSubtitleDiagnostic("cache_read", {
        source: "applyCacheSubtitleState",
        bvid: String(cache?.bvid || targetBvid || ""),
        p: String(cache?.tid || ""),
        cid: Number(cache?.cid || 0),
        ...getSubtitleDiagnosticRowsMeta(cache?.rawSubtitle || cache?.processedSubtitle)
    });
    const target = normalizeBvidCase(targetBvid || cache?.bvid || resolveCurrentBvid() || "");
    if (!target || !cache || normalizeBvidCase(cache?.bvid || "") !== target) return;
    if (!isCacheForCurrentRouteVideo(cache, target)) return;
    const rowsMeta = getSubtitleDiagnosticRowsMeta(cache?.rawSubtitle || cache?.processedSubtitle);
    const applySignature = [
        target,
        String(cache?.tid || ""),
        Number(cache?.cid || 0),
        rowsMeta.rowCount,
        rowsMeta.firstThreeLines,
        String(cache?.subtitleSource || ""),
        String(cache?.subtitleLanguage || "")
    ].join("|");
    if (subtitleUiCoordinator.lastCacheApplySignature === applySignature) {
        logSubtitleDiagnostic("cache_apply_skipped", {
            source: "applyCacheSubtitleState",
            reason: "duplicate_cache_content",
            bvid: target,
            p: String(cache?.tid || ""),
            cid: Number(cache?.cid || 0)
        });
        return;
    }
    subtitleUiCoordinator.lastCacheApplySignature = applySignature;
    if (hasUsableSubtitleCache(cache, target)) {
        if (subtitleUiCoordinator.displaySource !== "inject") {
            markSubtitleUiReady("cache", target, cache?.tid || getRoutePartId());
        } else {
            logSubtitleDiagnostic("ui_phase_unchanged", {
                phase: "ready",
                source: "cache",
                reason: "inject_display_already_owned",
                routeKey: subtitleUiCoordinator.routeKey
            });
        }
        const subtitleSource = String(cache?.subtitleSource || "").toLowerCase();
        const replaceCurrentRows = isAsrSubtitleSourceValue(subtitleSource)
            || subtitleUiCoordinator.displaySource === "language_switch";
        commitSubtitleRows(getRawSubtitleRowsFromCache(cache), {
            source: replaceCurrentRows ? (subtitleUiCoordinator.displaySource === "language_switch" ? "language_switch" : "asr_cache") : "cache",
            bvid: target,
            p: cache?.tid || getRoutePartId(),
            cid: Number(cache?.cid || 0),
            replace: replaceCurrentRows
        });
    }
    const subtitleSource = String(cache?.subtitleSource || "");
    appState.tabState = {
        ...(appState.tabState || {}),
        activeBvid: target,
        activeCid: Number(cache?.cid || appState.tabState?.activeCid || 0),
        activeTid: cache?.tid || appState.tabState?.activeTid || null,
        subtitleSource: subtitleSource || appState.tabState?.subtitleSource || "",
        transcriptionProgress: isAsrSubtitleSourceValue(subtitleSource)
            ? 100
            : Number(appState.tabState?.transcriptionProgress || 0)
    };
    if (hasUsableSubtitleCache(cache, target)) {
        appState.subtitleCapturedBvid = target;
    }
}

function startCloudReadForCurrentVideo(options = {}) {
    const target = normalizeBvidCase(options?.bvid || resolveCurrentBvid() || "");
    const cid = getCurrentRouteCid();
    if (!target || !(cid > 0)) return;
    const silent = options?.silent !== false;
    const nextRequestId = Number(appState.cloudReadState?.requestId || 0) + 1;
    appState.cloudReadState = createCloudReadState(target, "loading", nextRequestId);
    if (!silent) renderContent();
    const request = chrome.runtime.sendMessage({
        action: "GET_CACHE",
        bvid: target,
        cid,
        tid: getRoutePartId(),
        partCount: getCurrentRoutePartCount()
    });
    const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("CLOUD_TIMEOUT")), CLOUD_READ_TIMEOUT_MS);
    });
    Promise.race([request, timeout])
        .then((res) => {
            if (normalizeBvidCase(appState.cloudReadState?.bvid || "") !== target) return;
            if (Number(appState.cloudReadState?.requestId || 0) !== nextRequestId) return;
            if (!res?.ok) {
                appState.cloudReadState = createCloudReadState(target, "failed", nextRequestId);
                if (!silent) renderContent();
                showToast("访问云端数据库失败");
                return;
            }
            const cache = res?.cache || null;
            const cacheUpdated = !!(cache && normalizeBvidCase(cache?.bvid || "") === target && isCacheForCurrentRouteVideo(cache, target));
            if (cache && normalizeBvidCase(cache?.bvid || "") === target && isCacheForCurrentRouteVideo(cache, target)) {
                appState.cache = cache;
                applyCacheSubtitleState(cache, target);
            }
            if (res?.tabState) appState.tabState = res.tabState;
            appState.cloudReadState = createCloudReadState(target, "success", nextRequestId);
            if (cacheUpdated || !silent || ["CC", "summary", "chat", "real"].includes(appState.activePage)) renderContent();
        })
        .catch((error) => {
            if (normalizeBvidCase(appState.cloudReadState?.bvid || "") !== target) return;
            if (Number(appState.cloudReadState?.requestId || 0) !== nextRequestId) return;
            appState.cloudReadState = createCloudReadState(target, "failed", nextRequestId);
            if (!silent || ["CC", "summary", "chat", "real"].includes(appState.activePage)) renderContent();
            if (String(error?.message || "") && String(error.message) !== "CLOUD_TIMEOUT") {
                reportContentError?.(error, { task: "cloud_read", source: "cloud_read" });
                notifyMappedError({ ...error, code: "CLOUD_FAILED" }, "访问云端数据库失败");
            }
        });
}

function ensureCloudReadForActivePage() {
    if (!shouldAttemptCloudReadForPage(appState.activePage)) return;
    startCloudReadForCurrentVideo();
}

function renderCloudLoadingState(title, detail = "读取云端数据中...") {
    return `
        <div class="page-header">
            <h3>${title}</h3>
        </div>
        <div class="page-body subtitle-empty-container">
            <div class="action-container">
                <p class="action-tip">${detail}</p>
            </div>
        </div>
    `;
}

function renderMissingSubtitleState() {
    return `
        <div class="page-body subtitle-empty-container">
            <div class="action-container">
                <p class="action-tip">暂无字幕</p>
                <div class="subtitle-empty-actions">
                    <button class="action-btn subtitle-empty-primary" data-action="goto-cc-tab">去生成字幕</button>
                    <button class="action-btn ghost subtitle-empty-secondary" data-action="summary-refresh-subtitle-cache">刷新</button>
                </div>
            </div>
        </div>
    `;
}

function dismissChatGuide() {
    appState.chatGuideHidden = true;
}

function hideChatGuideNodes(panel) {
    panel?.querySelectorAll(".chat-greeting, .chat-suggest-list").forEach((node) => {
        node.style.display = "none";
    });
}

function updateSettingsProviderHint(panel) {
    const providers = { ...(appState.providers || {}) };
    if (!providers.custom) providers.custom = { name: "自定义", baseUrl: "", regUrl: "" };
    
    // Check if we are using custom select or native select (fallback)
    let key = "";
    const customSelect = panel?.querySelector("#settings-provider-select");
    if (customSelect) {
        // Find the selected option in custom select
        const selectedOption = customSelect.querySelector(".custom-option.selected");
        key = selectedOption ? selectedOption.dataset.value : (appState.settings?.provider || "modelscope");
    } else {
        key = panel?.querySelector("#settings-provider")?.value || "";
    }

    const provider = providers[key] || {};
    const urlNode = panel?.querySelector(".settings-provider-url");
    const regBtn = panel?.querySelector('[data-action="settings-open-reg"]');
    const customWrap = panel?.querySelector(".settings-custom-only");
    const providerModelWrap = panel?.querySelector("#settings-provider-model-wrap");
    const plainModelInput = panel?.querySelector("#settings-model");
    const providerModelSelect = panel?.querySelector("#settings-provider-model");
    const providerCustomModelInput = panel?.querySelector("#settings-provider-custom-model");
    const openRouterFreeHint = panel?.querySelector("#settings-openrouter-free-hint");
    const customBase = String(panel?.querySelector("#settings-base-url")?.value || "").trim();
    const isCustom = key === "custom";
    const hasProviderModelSelect = !isCustom && getProviderModelOptions(key).length > 0;
    const currentModel = hasProviderModelSelect
        ? String(providerModelSelect?.value || "").trim()
        : String(plainModelInput?.value || "").trim();
    if (customWrap) customWrap.classList.toggle("settings-hidden", !isCustom);
    if (providerModelWrap) providerModelWrap.classList.toggle("settings-hidden", !hasProviderModelSelect);
    if (plainModelInput) plainModelInput.classList.toggle("settings-hidden", hasProviderModelSelect);
    if (providerCustomModelInput) {
        providerCustomModelInput.classList.toggle("settings-hidden", !hasProviderModelSelect || String(providerModelSelect?.value || "") !== "custom");
    }
    if (openRouterFreeHint) {
        openRouterFreeHint.classList.toggle("settings-hidden", !(key === "openrouter" && currentModel === "openrouter/free"));
    }
    if (urlNode) {
        urlNode.textContent = isCustom ? (customBase || "请填写自定义 Base URL") : (provider.baseUrl || "-");
    }
    if (regBtn) {
        regBtn.dataset.url = isCustom ? "" : (provider.regUrl || "");
        regBtn.disabled = isCustom;
    }
}

const GROQ_ASR_LIMIT_TOOLTIP = "当前常见 Groq 转录限额：RPM 20；ASH 7.2K（每小时约 2 小时音频）。具体以 Groq 控制台 Limits 页面为准。";
const MODELSCOPE_MODEL_LIMIT_TOOLTIPS = {
    "deepseek-ai/DeepSeek-V4-Flash": "ModelScope 免费额度：50次/天",
    "deepseek-ai/DeepSeek-V4-Pro": "ModelScope 当前可直接调用模型",
    "deepseek-ai/DeepSeek-V3.2": "ModelScope 免费额度：20次/天",
    "ZhipuAI/GLM-5.2": "ModelScope 免费额度：50次/天",
    "stepfun-ai/Step-3.7-Flash": "ModelScope 免费额度：50次/天"
};

function updateSettingsAsrProviderHint(panel) {
    const asrProviders = {
        groq: {
            note: "需科学上网",
            regUrl: "https://console.groq.com/keys"
        },
        siliconflow: {
            note: "无字幕时间戳",
            regUrl: "https://cloud.siliconflow.cn/account/ak"
        },
        mimo: {
            note: "无字幕时间戳",
            regUrl: "https://platform.xiaomimimo.com/"
        }
    };
    const requestedKey = String(panel?.querySelector("#settings-asr-provider")?.value || "groq").toLowerCase();
    const key = ["groq", "siliconflow", "mimo"].includes(requestedKey) ? requestedKey : "groq";
    const provider = asrProviders[key] || asrProviders.groq;
    const regBtn = panel?.querySelector('[data-register-kind="asr"]');
    const groqWrap = panel?.querySelector("#settings-asr-groq-wrap");
    const siliconFlowWrap = panel?.querySelector("#settings-asr-siliconflow-wrap");
    const mimoWrap = panel?.querySelector("#settings-asr-mimo-wrap");
    if (regBtn) {
        regBtn.dataset.url = provider.regUrl;
        regBtn.disabled = !provider.regUrl;
    }
    if (groqWrap) groqWrap.classList.toggle("settings-hidden", key !== "groq");
    if (siliconFlowWrap) siliconFlowWrap.classList.toggle("settings-hidden", key !== "siliconflow");
    if (mimoWrap) mimoWrap.classList.toggle("settings-hidden", key !== "mimo");
}

async function authorizeCustomOriginFromPanel() {
    const panel = panelShadowRoot ? panelShadowRoot.getElementById("page-settings") : null;
    if (!panel) return false;
    const statusEl = panel.querySelector("#save-status");
    const selectedOption = panel.querySelector("#settings-provider-select .custom-option.selected");
    const providerValue = selectedOption ? selectedOption.dataset.value : "modelscope";
    if (providerValue !== "custom") {
        showToast("请先切换到自定义 Provider");
        return false;
    }
    const input = panel.querySelector("#settings-base-url");
    let customUrl = "";
    try {
        customUrl = normalizeHttpsBaseUrlInput(input?.value);
    } catch (error) {
        showToast(error?.message || "Base URL 格式不正确");
        return false;
    }
    if (!customUrl) {
        showToast("请先填写 Base URL");
        return false;
    }
    if (input) input.value = customUrl;
    if (statusEl) {
        statusEl.textContent = "请在新窗口中完成授权...";
        statusEl.className = "show syncing pulse";
    }
    try {
        const openRes = await chrome.runtime.sendMessage({
            action: "OPEN_PERMISSION_REQUEST_PAGE",
            baseUrl: customUrl
        });
        if (!openRes?.ok) {
            throw new Error("打开授权窗口失败");
        }
        const startedAt = Date.now();
        let granted = false;
        while (Date.now() - startedAt < 60000) {
            const permissionRes = await chrome.runtime.sendMessage({
                action: "ENSURE_OPTIONAL_ORIGIN_PERMISSION",
                baseUrl: customUrl,
                request: false
            });
            if (permissionRes?.granted) {
                granted = true;
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!granted) {
            throw new Error("未授权访问该自定义 API 域名");
        }
        if (statusEl) {
            statusEl.textContent = "域名已授权，正在同步...";
            statusEl.className = "show syncing pulse";
        }
        await saveSettingsFromPanel(true);
        showToast("自定义 API 域名已授权");
        return true;
    } catch (error) {
        if (statusEl) {
            statusEl.textContent = "域名授权失败";
            statusEl.className = "show syncing";
        }
        reportContentError?.(error, { task: "settings_authorize", source: "settings" });
        showToast(error?.message || "授权失败");
        return false;
    }
}

async function requestCustomOriginPermissionFromSettings(customUrl, statusEl) {
    const normalizedUrl = String(customUrl || "").trim();
    if (!normalizedUrl) return false;
    if (statusEl) {
        statusEl.textContent = "请在新窗口中授权自定义 API 域名...";
        statusEl.className = "show syncing pulse";
    }
    const openRes = await chrome.runtime.sendMessage({
        action: "OPEN_PERMISSION_REQUEST_PAGE",
        baseUrl: normalizedUrl
    });
    if (!openRes?.ok) throw new Error("打开授权窗口失败");
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60000) {
        const permissionRes = await chrome.runtime.sendMessage({
            action: "ENSURE_OPTIONAL_ORIGIN_PERMISSION",
            baseUrl: normalizedUrl,
            request: false
        });
        if (permissionRes?.granted) return true;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
}

function bindSettingsCustomSelects(panel) {
    if (panel.dataset.customSelectCloseBound !== "1") {
        panel.dataset.customSelectCloseBound = "1";
        panel.addEventListener("click", () => {
            panel.querySelectorAll(".custom-select-container.open").forEach((item) => item.classList.remove("open"));
        });
    }
    panel.querySelectorAll(".settings-custom-select").forEach((selectContainer) => {
        const targetId = selectContainer.dataset.targetSelect || "";
        const nativeSelect = targetId ? panel.querySelector(`#${CSS.escape(targetId)}`) : null;
        const selectTrigger = selectContainer.querySelector(".custom-select-trigger");
        const selectOptions = selectContainer.querySelector(".custom-select-options");
        if (!nativeSelect || !selectTrigger || !selectOptions) return;

        selectTrigger.addEventListener("click", (event) => {
            event.stopPropagation();
            if (targetId === "settings-plugin-display-mode") markPluginDisplayFeatureSeen();
            const wasOpen = selectContainer.classList.contains("open");
            panel.querySelectorAll(".custom-select-container.open").forEach((item) => {
                if (item !== selectContainer) item.classList.remove("open");
            });
            selectContainer.classList.toggle("open", !wasOpen);
        });

        selectOptions.querySelectorAll(".custom-option").forEach((option) => {
            option.addEventListener("click", (event) => {
                if (event.target?.closest?.('[data-no-select="true"]')) {
                    event.stopPropagation();
                    return;
                }
                event.stopPropagation();
                const value = String(option.dataset.value || "");
                nativeSelect.value = value;
                selectContainer.querySelector(".current-value").textContent = option.dataset.label || option.textContent || "";
                selectOptions.querySelectorAll(".custom-option").forEach((item) => item.classList.remove("selected"));
                option.classList.add("selected");
                selectContainer.classList.remove("open");
                nativeSelect.dispatchEvent(new Event("change", { bubbles: true }));
            });
        });
    });
}

function getPromptSettingsDraftFromPanel(panel) {
    const fallback = normalizePromptSettingsState(appState.settingsPromptDraft || appState.settings?.promptSettings);
    const promptMode = String(panel?.querySelector("#settings-prompt-mode")?.value || fallback.mode || "guided") === "custom" ? "custom" : "guided";
    const toneVal = Number(panel?.querySelector("#settings-prompt-tone")?.value ?? (fallback.guided.tone === "casual" ? 0 : (fallback.guided.tone === "professional" ? 2 : 1)));
    const detailVal = Number(panel?.querySelector("#settings-prompt-detail")?.value ?? (fallback.guided.detail === "brief" ? 0 : (fallback.guided.detail === "detailed" ? 2 : 1)));
    const promptTone = toneVal === 0 ? "casual" : (toneVal === 2 ? "professional" : "balanced");
    const promptDetail = detailVal === 0 ? "brief" : (detailVal === 2 ? "detailed" : "normal");
    return normalizePromptSettingsState({
        mode: promptMode,
        guided: {
            tone: promptTone,
            detail: promptDetail
        },
        custom: {
            summary: String(panel?.querySelector("#settings-prompt-summary")?.value ?? fallback.custom.summary ?? ""),
            segments: String(panel?.querySelector("#settings-prompt-segments")?.value ?? fallback.custom.segments ?? ""),
            rumors: String(panel?.querySelector("#settings-prompt-rumors")?.value ?? fallback.custom.rumors ?? "")
        }
    });
}

function syncPromptSettingsDraft(panel) {
    const nextDraft = getPromptSettingsDraftFromPanel(panel);
    appState.settingsPromptDraft = nextDraft;
    if (!appState.settings) appState.settings = {};
    appState.settings.promptSettings = nextDraft;
    return nextDraft;
}

function buildSettingsUsageSnapshot(settings = {}) {
    const provider = String(settings.provider || "modelscope").trim();
    const providerModels = settings.providerModels && typeof settings.providerModels === "object" ? settings.providerModels : {};
    return {
        provider,
        model: String(providerModels[provider] || settings.model || "").trim(),
        asrProvider: String(settings.asrProvider || "groq").trim(),
        groqModel: String(settings.groqModel || "").trim(),
        siliconFlowAsrModel: String(settings.siliconFlowAsrModel || "").trim(),
        mimoAsrModel: String(settings.mimoAsrModel || DEFAULT_MIMO_ASR_MODEL).trim(),
        prefMode: String(settings.prefMode || "").trim(),
        promptMode: String(settings.promptSettings?.mode || "").trim(),
        customProtocol: String(settings.customProtocol || "").trim(),
        hasProviderApiKey: !!String(settings.apiKey || "").trim(),
        hasGroqApiKey: !!String(settings.groqApiKey || "").trim(),
        hasSiliconFlowApiKey: !!String(settings.siliconFlowApiKey || "").trim(),
        hasMimoApiKey: !!String(settings.mimoApiKey || "").trim(),
        hasCustomBaseUrl: !!String(settings.customBaseUrl || "").trim()
    };
}

function reportSettingsSavedUsageEvent(settings = {}, saveSource = "manual") {
    const snapshot = buildSettingsUsageSnapshot(settings);
    const signature = JSON.stringify(snapshot);
    if (signature === appState.lastSettingsUsageEventSignature) return;
    appState.lastSettingsUsageEventSignature = signature;
    reportUsageEvent({
        eventName: "settings_saved",
        featureName: "settings",
        status: "success",
        provider: snapshot.provider,
        model: snapshot.model,
        metadata: {
            save_source: saveSource,
            asr_provider: snapshot.asrProvider,
            groq_model: snapshot.groqModel,
            siliconflow_asr_model: snapshot.siliconFlowAsrModel,
            mimo_asr_model: snapshot.mimoAsrModel,
            pref_mode: snapshot.prefMode,
            prompt_mode: snapshot.promptMode,
            custom_protocol: snapshot.customProtocol,
            has_provider_api_key: snapshot.hasProviderApiKey,
            has_groq_api_key: snapshot.hasGroqApiKey,
            has_siliconflow_api_key: snapshot.hasSiliconFlowApiKey,
            has_mimo_api_key: snapshot.hasMimoApiKey,
            has_custom_base_url: snapshot.hasCustomBaseUrl
        }
    });
}

async function saveSettingsFromPanel(isAutoSave = false, options = {}) {
    const panel = panelShadowRoot ? panelShadowRoot.getElementById("page-settings") : null;
    if (!panel) return;
    const opts = options && typeof options === "object" ? options : {};
    
    // Validate API Keys globally before saving. Leading/trailing spaces are trimmed;
    // inner spaces still block saving because providers reject them.
    const secretInputs = Array.from(panel.querySelectorAll("[data-secret-input]"));
    for (const input of secretInputs) {
        const trimmed = String(input.value || "").trim();
        if (input.value !== trimmed) input.value = trimmed;
        const invalid = /[\s\u4e00-\u9fa5]/.test(trimmed);
        if (invalid) {
            const apiKeyError = panel.querySelector(`#${input.id}-error`);
            input.classList.add("input-error");
            if (apiKeyError) apiKeyError.classList.add("show");
            return;
        }
        input.classList.remove("input-error");
        const apiKeyError = panel.querySelector(`#${input.id}-error`);
        if (apiKeyError) apiKeyError.classList.remove("show");
    }

    const statusEl = panel.querySelector("#save-status");
    if (isAutoSave && statusEl) {
        if (appState.saveStatusTimer) {
            clearTimeout(appState.saveStatusTimer);
            appState.saveStatusTimer = null;
        }
        statusEl.textContent = "同步中...";
        statusEl.className = "show syncing pulse";
    }

    // Support custom select
    let providerValue = "modelscope";
    const customSelect = panel.querySelector("#settings-provider-select");
    if (customSelect) {
         const selectedOption = customSelect.querySelector(".custom-option.selected");
         providerValue = selectedOption ? selectedOption.dataset.value : providerValue;
    } else {
        providerValue = panel.querySelector("#settings-provider")?.value || "modelscope";
    }

    const customProtocolValue = panel.querySelector("#settings-custom-protocol")?.value || "openai";
    const defaultOpenPage = resolveDefaultOpenPage(panel.querySelector("#settings-default-open-page")?.value || appState.settings?.defaultOpenPage);
    const promptSettingsDraft = syncPromptSettingsDraft(panel);
    const providerModelValue = String(panel.querySelector("#settings-provider-model")?.value || "").trim();
    const hasProviderModelSelect = providerValue !== "custom" && getProviderModelOptions(providerValue).length > 0;
    const resolvedModelValue = hasProviderModelSelect
        ? (providerModelValue === "custom"
            ? String(panel.querySelector("#settings-provider-custom-model")?.value || "").trim()
            : providerModelValue)
        : String(panel.querySelector("#settings-model")?.value || "").trim();
    const activeApiKey = String(panel.querySelector("#settings-api-key")?.value || "").trim();
    const providerApiKeys = {
        ...(appState.settings?.providerApiKeys || {}),
        [providerValue]: activeApiKey
    };
    const providerModels = {
        ...(appState.settings?.providerModels || {}),
        [providerValue]: resolvedModelValue
    };
    const groqBaseUrlInput = panel.querySelector("#settings-groq-base-url");
    let groqBaseUrl;
    try {
        groqBaseUrl = normalizeAsrBaseUrlInput(
            groqBaseUrlInput?.readOnly === false ? appState.settings?.groqBaseUrl : groqBaseUrlInput?.value,
            DEFAULT_GROQ_ASR_BASE_URL
        );
    } catch (error) {
        showToast(error?.message || "Groq Base URL 格式不正确");
        return false;
    }
    const requestedAsrProvider = String(panel.querySelector("#settings-asr-provider")?.value || "groq").toLowerCase();
    const asrProvider = ["groq", "siliconflow", "mimo"].includes(requestedAsrProvider) ? requestedAsrProvider : "groq";
    const customBaseUrlInput = panel.querySelector("#settings-base-url");
    let customBaseUrl = ensureHttpsUrlPrefixInput(appState.settings?.customBaseUrl);
    try {
        if (providerValue === "custom") {
            customBaseUrl = normalizeHttpsBaseUrlInput(customBaseUrlInput?.value);
            if (customBaseUrlInput && customBaseUrl) customBaseUrlInput.value = customBaseUrl;
        }
    } catch (error) {
        showToast(error?.message || "自定义 Base URL 格式不正确");
        return false;
    }

    const payload = {
        provider: providerValue,
        apiKey: activeApiKey,
        providerApiKeys,
        providerModels,
        model: resolvedModelValue,
        customBaseUrl,
        customModel: providerValue === "custom"
            ? resolvedModelValue
            : String(appState.settings?.customModel || "").trim(),
        customProtocol: customProtocolValue === "claude" ? "claude" : "openai",
        asrProvider,
        groqApiKey: String(panel.querySelector("#settings-groq-api-key")?.value || "").trim(),
        groqModel: String(panel.querySelector("#settings-groq-model")?.value || "").trim(),
        groqBaseUrl,
        siliconFlowApiKey: String(panel.querySelector("#settings-siliconflow-api-key")?.value || "").trim(),
        siliconFlowAsrModel: String(panel.querySelector("#settings-siliconflow-asr-model")?.value || "").trim(),
        mimoApiKey: String(panel.querySelector("#settings-mimo-api-key")?.value || "").trim(),
        mimoAsrModel: DEFAULT_MIMO_ASR_MODEL,
        prefMode: panel.querySelector("#settings-pref-mode")?.value || "quality",
        themeMode: panel.querySelector("#settings-theme-mode")?.value || "system",
        defaultOpenPage,
        pluginDisplayMode: panel.querySelector("#settings-plugin-display-mode")?.value === "collapsed" ? "collapsed" : "expanded",
        sentryEnabled: panel.querySelector("#settings-sentry-enabled")?.value === "true",
        disableCloudCacheRead: panel.querySelector("#settings-disable-cloud-all")?.checked === true,
        sentryDsn: String(appState.settings?.sentryDsn || "").trim(),
        debugMode: panel.querySelector("#settings-debug-mode")?.value === "true",
        promptSettings: {
            mode: promptSettingsDraft.mode,
            guided: {
                tone: promptSettingsDraft.guided.tone,
                detail: promptSettingsDraft.guided.detail
            },
            custom: {
                summary: String(promptSettingsDraft.custom.summary || "").trim(),
                segments: String(promptSettingsDraft.custom.segments || "").trim(),
                rumors: String(promptSettingsDraft.custom.rumors || "").trim()
            }
        }
    };
    if (providerValue !== "custom") {
        payload.customBaseUrl = customBaseUrl;
    }
    try {
        if (providerValue === "custom") {
            const customUrl = String(payload.customBaseUrl || "").trim();
            if (!customUrl) {
                throw new Error("自定义 Provider 需要填写 Base URL");
            }
            const permissionRes = await chrome.runtime.sendMessage({
                action: "ENSURE_OPTIONAL_ORIGIN_PERMISSION",
                baseUrl: customUrl,
                request: !!opts.requestCustomPermission
            });
            if (!permissionRes?.granted) {
                const grantedAfterPrompt = await requestCustomOriginPermissionFromSettings(customUrl, statusEl);
                if (!grantedAfterPrompt) {
                    if (isAutoSave) {
                        const saveRes = await chrome.runtime.sendMessage({ action: "SAVE_SETTINGS", settings: payload });
                        if (saveRes?.settings) appState.settings = saveRes.settings;
                        reportSettingsSavedUsageEvent(appState.settings || payload, "autosave");
                        if (statusEl) {
                            statusEl.textContent = "授权后才会启用自定义 API";
                            statusEl.className = "show syncing";
                        }
                        return;
                    }
                    throw new Error("请先授权访问该自定义 API 域名");
                }
                if (statusEl) {
                    statusEl.textContent = "域名已授权，正在保存...";
                    statusEl.className = "show syncing pulse";
                }
            }
        } else {
            const providerBaseUrl = String(appState.providers?.[providerValue]?.baseUrl || "").trim();
            if (providerBaseUrl) {
                const permissionRes = await chrome.runtime.sendMessage({
                    action: "ENSURE_OPTIONAL_ORIGIN_PERMISSION",
                    baseUrl: providerBaseUrl,
                    request: !!opts.requestProviderPermission
                });
                if (!permissionRes?.granted) {
                    const grantedAfterPrompt = await requestCustomOriginPermissionFromSettings(providerBaseUrl, statusEl);
                    if (!grantedAfterPrompt) throw new Error("请先授权访问该 Provider 域名");
                }
            }
        }
        if (payload.groqBaseUrl !== DEFAULT_GROQ_ASR_BASE_URL) {
            const permissionRes = await chrome.runtime.sendMessage({
                action: "ENSURE_OPTIONAL_ORIGIN_PERMISSION",
                baseUrl: payload.groqBaseUrl,
                request: !!opts.requestGroqPermission
            });
            if (!permissionRes?.granted) {
                const grantedAfterPrompt = await requestCustomOriginPermissionFromSettings(payload.groqBaseUrl, statusEl);
                if (!grantedAfterPrompt) throw new Error("请先授权访问该 Groq Base URL 域名");
            }
        }
        const res = await chrome.runtime.sendMessage({ action: "SAVE_SETTINGS", settings: payload });
        if (!res?.ok) throw new Error(res?.error || "保存失败");
        appState.settings = res.settings || payload;
        applyThemeMode();
        appState.settingsPromptDraft = normalizePromptSettingsState(appState.settings?.promptSettings || payload.promptSettings);
        reportSettingsSavedUsageEvent(appState.settings || payload, isAutoSave ? "autosave" : "manual");
        
    if (isAutoSave) {
        const livePanel = panel;
        livePanel.dataset.lastSignature = JSON.stringify({
            settings: appState.settings,
            feedback: {
                rows: getFeedbackState().rows,
                unreadCount: getFeedbackState().unreadCount,
                loading: getFeedbackState().loading,
                submitting: getFeedbackState().submitting,
                statusText: getFeedbackState().statusText,
                errorText: getFeedbackState().errorText
            }
        });
        const liveStatusEl = livePanel.querySelector("#save-status");
        if (liveStatusEl) {
            // Cancel previous timers
            if (appState.saveShowTimer) clearTimeout(appState.saveShowTimer);
            if (appState.saveStatusTimer) clearTimeout(appState.saveStatusTimer);
            
            // Show "Saving..." immediately or if it's too fast, just proceed to "Saved"
            // Actually, for better UX, we should just show "Saved" after a tiny delay to ensure user sees it
            
            appState.saveShowTimer = setTimeout(() => {
                liveStatusEl.textContent = "已保存";
                liveStatusEl.className = "show saved";
                
                // Disappear after 2s
                appState.saveStatusTimer = setTimeout(() => {
                    const currentStatusEl = livePanel.querySelector("#save-status");
                    if (currentStatusEl) currentStatusEl.classList.remove("show");
                    appState.saveStatusTimer = null;
                }, 2000);
            }, 300);
        }
    } else {
        showToast("设置已保存");
        renderSettings(panel);
    }
    return true;
    } catch (error) {
        reportContentError?.(error, { task: "settings_save", source: "settings" });
        showToast(error.message || "保存失败");
        return false;
    }
}

function normalizeAsrBaseUrlInput(value, fallback) {
    const raw = ensureHttpsUrlPrefixInput(String(value || "").trim() || String(fallback || "").trim());
    let url;
    try {
        url = new URL(raw);
    } catch (_) {
        throw new Error("Base URL 格式不正确");
    }
    if (url.protocol !== "https:") throw new Error("Base URL 必须使用 https://");
    if (url.username || url.password || url.search || url.hash) {
        throw new Error("Base URL 不能包含账号、参数或锚点");
    }
    const pathname = url.pathname.replace(/\/+$/, "");
    if (/\/(?:models|audio\/transcriptions)$/i.test(pathname)) {
        throw new Error("Base URL 只填写基础地址，不要包含具体接口路径");
    }
    return `${url.origin}${pathname}`;
}

function ensureHttpsUrlPrefixInput(value) {
    const raw = String(value || "").trim();
    if (!raw || /^[a-z][a-z\d+.-]*:\/\//i.test(raw)) return raw;
    return `https://${raw.replace(/^\/+/, "")}`;
}

function normalizeHttpsBaseUrlInput(value) {
    const raw = ensureHttpsUrlPrefixInput(value);
    if (!raw) return "";
    let url;
    try {
        url = new URL(raw);
    } catch (_) {
        throw new Error("Base URL 格式不正确");
    }
    if (url.protocol !== "https:") throw new Error("Base URL 必须使用 https://");
    return raw;
}

function startFocusTicker() {
    if (appState.focusTickerTimer) return;
    appState.focusTickerTimer = setInterval(() => {
        if (appState.activePage === "CC") scrollToCurrentSubtitle(false);
        if (Date.now() - Number(appState.segmentsMarkerTickAt || 0) >= 1000) {
            appState.segmentsMarkerTickAt = Date.now();
            renderSegmentsProgressMarkers();
        }
    }, 200);
}

function scrollToCurrentSubtitle(force, behavior = "smooth") {
    if (!force && subtitleUiCoordinator.scrollUnlockAt > Date.now()) return false;
    if (force && subtitleUiCoordinator.scrollUnlockAt > Date.now() && behavior === "auto") return false;
    const rows = getCurrentSubtitleStateRows();
    if (!rows.length) return false;
    let canFollowScroll = appState.followEnabled;
    if (!appState.followEnabled && !force) {
        if (Date.now() - appState.followPausedAt >= FOLLOW_RESUME_MS) {
            appState.followEnabled = true;
            canFollowScroll = true;
            toggleFollowButton();
        } else {
            canFollowScroll = false;
            toggleFollowButton();
        }
    } else if (force) {
        canFollowScroll = true;
    }
    const t = getPlayerTime();
    // Allow highlighting even if time is 0 or paused, as long as it's valid
    if (!Number.isFinite(t)) return false;
    
    const index = getActiveSubtitleIndex(rows, t);
    const changed = index !== appState.followCurrentIndex;
    
    // Always highlight if forced or changed
    if (changed || force) {
        appState.followCurrentIndex = index;
        highlightSubtitleRow(index);
    }
    
    updateFollowButtonDirection();
    
    if (!changed && !canFollowScroll) return;
    
    if (index >= 0 && canFollowScroll) {
        const list = panelShadowRoot ? panelShadowRoot.getElementById("cc-list") : null;
        const target = list?.querySelector(`.cc-row[data-index="${index}"]`);
        if (list && target) {
            // Force auto behavior if requested (e.g. tab switch), overriding smooth default
            const scrollBehavior = behavior === "auto" ? "auto" : behavior;
            const top = target.offsetTop - list.clientHeight / 2 + target.clientHeight / 2;
            list.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior });
            return true;
        }
    }
    return index >= 0;
}

function highlightSubtitleRow(index) {
    if (index === appState.renderedSubtitleIndex) return;
    const list = panelShadowRoot ? panelShadowRoot.getElementById("cc-list") : null;
    if (!list) return;
    list.querySelectorAll(".cc-row.active").forEach((node) => node.classList.remove("active"));
    const active = index >= 0 ? list.querySelector(`.cc-row[data-index="${index}"]`) : null;
    if (active) active.classList.add("active");
    appState.renderedSubtitleIndex = index;
}

function pauseFollow() {
    appState.followEnabled = false;
    appState.followPausedAt = Date.now();
    toggleFollowButton();
    updateFollowButtonDirection();
}

async function onCCListClick(event) {
    const jumpBtn = event.target.closest('[data-action="cc-jump"]');
    if (jumpBtn) {
        event.preventDefault();
        event.stopPropagation();
        jumpTo(Number(jumpBtn.dataset.sec || 0));
        return;
    }
    const button = event.target.closest('[data-action="cc-copy"]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const row = button.closest(".cc-row");
    const text = String(row?.querySelector(".cc-text")?.textContent || "").trim();
    if (!text) return;
    try {
        await navigator.clipboard.writeText(text);
        const origin = button.dataset.originText || button.textContent || "复制";
        button.dataset.originText = origin;
        button.textContent = "OK";
        button.classList.add("copied");
        row?.classList.add("copied");
        showToast("已复制");
        setTimeout(() => {
            button.textContent = origin;
            button.classList.remove("copied");
            row?.classList.remove("copied");
        }, 1000);
    } catch (_) {
        showToast("复制失败");
    }
}

function toggleFollowButton() {
    const btn = panelShadowRoot ? panelShadowRoot.getElementById("btn-follow-now") : null;
    if (!btn) return;
    btn.style.display = appState.followEnabled ? "none" : "flex";
    if (!appState.followEnabled) updateFollowButtonDirection();
}

function updateFollowButtonDirection() {
    if (!panelShadowRoot) return;
    const btn = panelShadowRoot.getElementById("btn-follow-now");
    const list = panelShadowRoot.getElementById("cc-list");
    if (!btn || !list) return;
    const index = Number(appState.followCurrentIndex);
    const row = Number.isFinite(index) && index >= 0 ? list.querySelector(`.cc-row[data-index="${index}"]`) : null;
    if (!row) {
        btn.classList.remove("direction-up");
        btn.classList.add("direction-down");
        return;
    }
    const viewTop = list.scrollTop;
    const viewBottom = viewTop + list.clientHeight;
    const rowTop = row.offsetTop;
    const rowBottom = rowTop + row.offsetHeight;
    if (rowBottom > viewBottom) {
        btn.classList.remove("direction-up");
        btn.classList.add("direction-down");
        return;
    }
    if (rowTop < viewTop) {
        btn.classList.remove("direction-down");
        btn.classList.add("direction-up");
        return;
    }
    btn.classList.remove("direction-up");
    btn.classList.add("direction-down");
}

function getPlayerTime() {
    const video = document.querySelector("video");
    return video ? Number(video.currentTime) : NaN;
}

function getCurrentVideoElement() {
    const primary = document.querySelector("video");
    if (primary) return primary;
    const nested = document.querySelector(".bwp-video video");
    if (nested) return nested;
    const fallback = document.querySelector(".bwp-video");
    if (fallback && typeof fallback.duration !== "undefined") return fallback;
    return null;
}

function clearVideoSubtitleCues(forgetTrack = false) {
    const track = appState.videoSubtitleTrack;
    if (track) {
        try {
            while (track.cues?.length) track.removeCue(track.cues[0]);
            track.mode = "disabled";
        } catch (_) {}
    }
    if (forgetTrack) {
        appState.videoSubtitleTrack = null;
        appState.videoSubtitleVideo = null;
    }
    appState.videoSubtitleSignature = "";
}

function disableVideoSubtitleTrack() {
    appState.videoSubtitleEnabled = false;
    clearVideoSubtitleCues();
}

function syncVideoSubtitleTrack(cues) {
    if (!appState.videoSubtitleEnabled) {
        clearVideoSubtitleCues();
        return false;
    }
    const rows = Array.isArray(cues) ? cues : [];
    const video = getCurrentVideoElement();
    const Cue = window.VTTCue || window.TextTrackCue;
    if (!video || typeof video.addTextTrack !== "function" || typeof Cue !== "function" || !rows.length) {
        clearVideoSubtitleCues();
        return false;
    }
    const signature = rows.map((cue) => `${cue.start}:${cue.end}:${cue.text}`).join("|");
    if (appState.videoSubtitleVideo === video
        && appState.videoSubtitleTrack
        && appState.videoSubtitleSignature === signature) {
        appState.videoSubtitleTrack.mode = "showing";
        return true;
    }
    if (appState.videoSubtitleVideo && appState.videoSubtitleVideo !== video) {
        clearVideoSubtitleCues(true);
    } else {
        clearVideoSubtitleCues();
    }
    const track = appState.videoSubtitleTrack || video.addTextTrack("subtitles", "Bilitato Groq", "zh-CN");
    rows.forEach((item) => track.addCue(new Cue(item.start, item.end, item.text)));
    track.mode = "showing";
    appState.videoSubtitleTrack = track;
    appState.videoSubtitleVideo = video;
    appState.videoSubtitleSignature = signature;
    return true;
}

function toggleVideoSubtitleTrack() {
    const source = String(appState.cache?.subtitleSource || appState.tabState?.subtitleSource || "").toLowerCase();
    const rows = getCurrentSubtitleStateRows();
    const cues = (source === "groq" || source === "whisper" || source === "custom_asr") ? buildPlaybackSubtitleCues(rows) : [];
    if (!cues.length) {
        disableVideoSubtitleTrack();
        showToast("当前转录缺少可用时间戳，暂不能显示到视频中");
    } else if (!appState.videoSubtitleEnabled) {
        appState.videoSubtitleEnabled = true;
        if (!syncVideoSubtitleTrack(cues)) {
            appState.videoSubtitleEnabled = false;
            showToast("未找到可用的视频播放器");
        }
    } else {
        disableVideoSubtitleTrack();
    }
    subtitleUiCoordinator.renderedStateSignature = "";
    renderSubtitleIfNeeded(panelShadowRoot?.getElementById?.("page-CC"), "video_subtitle_toggle");
}

function resolveDurationFromSubtitles() {
    const processed = Array.isArray(appState.cache?.processedSubtitle) ? appState.cache.processedSubtitle : [];
    const raw = Array.isArray(appState.cache?.rawSubtitle) ? appState.cache.rawSubtitle : [];
    const source = processed.length ? processed : raw;
    if (!source.length) return NaN;
    let maxSec = NaN;
    source.forEach((row) => {
        const start = toNumberOrNaN(row?.start ?? row?.from);
        const end = toNumberOrNaN(row?.end ?? row?.to);
        const candidate = Number.isFinite(end) ? end : start;
        if (!Number.isFinite(candidate)) return;
        if (!Number.isFinite(maxSec) || candidate > maxSec) maxSec = candidate;
    });
    return maxSec;
}

function resolveVideoDurationMeta() {
    const video = getCurrentVideoElement();
    const durationSec = Number(video?.duration || 0);
    const fromVideo = Number.isFinite(durationSec) && durationSec > 0 ? Math.floor(durationSec) : NaN;
    const fallback = resolveDurationFromSubtitles();
    const totalSeconds = Number.isFinite(fromVideo) && fromVideo > 0
        ? fromVideo
        : (Number.isFinite(fallback) && fallback > 0 ? Math.floor(fallback) : 0);
    if (!totalSeconds) return null;
    return {
        totalSeconds,
        formattedTime: formatTime(totalSeconds)
    };
}

function jumpTo(sec) {
    const video = document.querySelector("video");
    if (!video) return;
    video.currentTime = Math.max(0, Number(sec) || 0);
    video.play().catch(() => {});
}

function getSegmentsForFloatWindow() {
    if (isNoTimestampSubtitleCache(appState.cache)) return [];
    const list = Array.isArray(appState.cache?.segments) ? appState.cache.segments : [];
    return list
        .map((item) => {
            const timelineRange = resolveSegmentTimelineRange(item, appState.cache);
            if (!timelineRange) return null;
            return {
                start: Math.max(0, Number(timelineRange.start || 0)),
                end: Math.max(0, Number(timelineRange.end || 0)),
                label: String(item?.label || "未命名章节").trim(),
                type: String(item?.type || "content")
            };
        })
        .filter((item) => item && Number.isFinite(item.start))
        .sort((a, b) => a.start - b.start);
}

function removeSegmentsFloatWindow() {
    const node = document.getElementById("segments-float-window");
    if (node) node.remove();
}

function renderSegmentsFloatWindow() {
    const segments = getSegmentsForFloatWindow();
    if (!segments.length) {
        removeSegmentsFloatWindow();
        return;
    }
    let node = document.getElementById("segments-float-window");
    if (!node) {
        node = document.createElement("section");
        node.id = "segments-float-window";
        node.className = "segments-float-window";
        node.dataset.side = "right";
        node.style.top = "180px";
        node.style.right = "0px";
        document.body.appendChild(node);
        bindSegmentsFloatWindowEvents(node);
    }
    const rowsHtml = segments.map((item) => {
        const from = formatTime(item.start);
        const to = formatTime(item.end || item.start);
        const label = escapeHtml(item.label || "未命名章节");
        const badge = item.type === "ad" ? '<span class="segments-float-badge">广告</span>' : "";
        return `<button type="button" class="segments-float-item" data-start="${item.start}"><span class="segments-float-time">${from}-${to}</span><span class="segments-float-label">${label}</span>${badge}</button>`;
    }).join("");
    node.innerHTML = `
        <button type="button" class="drag-handle" data-action="segments-toggle"><span class="drag-handle-arrow"></span></button>
        <div class="segments-float-body">
            <div class="segments-float-title">视频分段</div>
            <div class="segments-float-list">${rowsHtml}</div>
        </div>
    `;
    updateSegmentsFloatArrow(node);
}

function bindSegmentsFloatWindowEvents(node) {
    if (!node || node.dataset.bound === "1") return;
    node.dataset.bound = "1";
    node.addEventListener("click", (event) => {
        const toggleBtn = event.target.closest('[data-action="segments-toggle"]');
        if (toggleBtn) {
            node.classList.toggle("is-collapsed");
            updateSegmentsFloatArrow(node);
            return;
        }
        const jumpBtn = event.target.closest(".segments-float-item");
        if (!jumpBtn) return;
        const sec = Number(jumpBtn.dataset.start || 0);
        jumpTo(sec);
    });
    node.addEventListener("mousedown", (event) => {
        if (event.button !== 0) return;
        if (event.target.closest(".segments-float-item")) return;
        const rect = node.getBoundingClientRect();
        appState.segmentsFloatDragging = {
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top
        };
        node.classList.add("is-dragging");
        node.style.left = `${rect.left}px`;
        node.style.top = `${rect.top}px`;
        node.style.right = "auto";
        document.addEventListener("mousemove", onSegmentsFloatMouseMove);
        document.addEventListener("mouseup", onSegmentsFloatMouseUp);
    });
}

function onSegmentsFloatMouseMove(event) {
    const drag = appState.segmentsFloatDragging;
    const node = document.getElementById("segments-float-window");
    if (!drag || !node) return;
    const width = node.offsetWidth || 280;
    const height = node.offsetHeight || 360;
    const maxLeft = Math.max(0, window.innerWidth - width);
    const maxTop = Math.max(0, window.innerHeight - height);
    const left = Math.max(0, Math.min(maxLeft, event.clientX - drag.offsetX));
    const top = Math.max(0, Math.min(maxTop, event.clientY - drag.offsetY));
    node.style.left = `${left}px`;
    node.style.top = `${top}px`;
}

function onSegmentsFloatMouseUp() {
    const drag = appState.segmentsFloatDragging;
    const node = document.getElementById("segments-float-window");
    appState.segmentsFloatDragging = null;
    document.removeEventListener("mousemove", onSegmentsFloatMouseMove);
    document.removeEventListener("mouseup", onSegmentsFloatMouseUp);
    if (!drag || !node) return;
    node.classList.remove("is-dragging");
    const rect = node.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const side = centerX <= window.innerWidth / 2 ? "left" : "right";
    node.dataset.side = side;
    node.style.top = `${Math.max(0, rect.top)}px`;
    if (side === "left") {
        node.style.left = "0px";
        node.style.right = "auto";
    } else {
        node.style.right = "0px";
        node.style.left = "auto";
    }
    updateSegmentsFloatArrow(node);
}

function updateSegmentsFloatArrow(node) {
    if (!node) return;
    const arrow = node.querySelector(".drag-handle-arrow");
    if (!arrow) return;
    const side = node.dataset.side === "left" ? "left" : "right";
    const collapsed = node.classList.contains("is-collapsed");
    if (collapsed) {
        arrow.textContent = side === "right" ? "◀" : "▶";
        return;
    }
    arrow.textContent = side === "right" ? "▶" : "◀";
}

function removeSegmentsProgressMarkers() {
    document.querySelectorAll(".segment-marker-layer").forEach((node) => node.remove());
}

function renderSegmentsProgressMarkers() {
    const segments = getSegmentsForFloatWindow();
    if (!segments.length) {
        removeSegmentsProgressMarkers();
        return;
    }
    const video = document.querySelector("video");
    const duration = Number(video?.duration || 0);
    if (!video || !Number.isFinite(duration) || duration <= 0) return;
    const host = document.querySelector(".bpx-player-progress-wrap") || document.querySelector(".bpx-player-progress-schedule");
    if (!host) return;
    let layer = Array.from(host.children).find((node) => node.classList?.contains("segment-marker-layer")) || null;
    document.querySelectorAll(".segment-marker-layer").forEach((node) => {
        if (node !== layer) node.remove();
    });
    if (!layer) {
        const nextLayer = document.createElement("div");
        nextLayer.className = "segment-marker-layer";
        host.appendChild(nextLayer);
        nextLayer.addEventListener("click", (event) => {
            const marker = event.target.closest(".segment-marker");
            if (!marker) return;
            jumpTo(Number(marker.dataset.start || 0));
        });
        layer = nextLayer;
    }
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.style.overflow = "visible";
    if (!layer) return;
    const hostRect = host.getBoundingClientRect();
    const scheduleNodes = host.matches(".bpx-player-progress-schedule")
        ? [host]
        : Array.from(host.querySelectorAll(".bpx-player-progress-schedule"));
    const scheduleRects = scheduleNodes
        .map((node) => node.getBoundingClientRect())
        .filter((rect) => rect.width > 0);
    if (scheduleRects.length && hostRect.width > 0) {
        const trackLeft = Math.min(...scheduleRects.map((rect) => rect.left));
        const trackRight = Math.max(...scheduleRects.map((rect) => rect.right));
        layer.style.left = `${Math.max(0, trackLeft - hostRect.left)}px`;
        layer.style.right = "auto";
        layer.style.width = `${Math.max(0, trackRight - trackLeft)}px`;
    } else {
        layer.style.left = "0";
        layer.style.right = "0";
        layer.style.width = "auto";
    }
    layer.style.pointerEvents = "auto";
    layer.style.zIndex = "30";
    layer.style.top = "-3px";
    layer.style.bottom = "auto";
    layer.style.height = "8px";
    const markersHtml = segments.map((item) => {
        const percent = Math.max(0, Math.min(100, (item.start / duration) * 100));
        const label = escapeHtml(item.label);
        return `<span class="segment-marker" style="left:calc(${percent}% - 1.5px);" data-start="${item.start}" title="${label}"><span class="segment-marker-tooltip">${label}</span></span>`;
    }).join("");
    layer.innerHTML = markersHtml;
}

function ensureSegmentsVideoEvents() {
    const video = document.querySelector("video");
    if (!video || video.dataset.segmentsBound === "1") return;
    const refresh = () => renderSegmentsProgressMarkers();
    video.addEventListener("loadedmetadata", refresh);
    video.addEventListener("durationchange", refresh);
    video.dataset.segmentsBound = "1";
}

function shouldHideRuntimeMetrics() {
    const taskStatus = isTabStateForCurrentVideo() ? (appState.tabState?.taskStatus || {}) : {};
    const summaryRunning = taskStatus.summary === "processing";
    const segmentsRunning = taskStatus.segments === "processing";
    const rumorsRunning = taskStatus.rumors === "processing";
    const chatRunning = taskStatus.chat === "processing" || !!String(appState.chatStreamingId || "").trim();
    return summaryRunning || segmentsRunning || rumorsRunning || chatRunning;
}

function renderMetricsBox() {
    return "";
}

function getTabStateKey() {
    return appState.tabId ? `tabState_${appState.tabId}` : null;
}

function evaluateSubtitleFallback() {
    if (isTranscriptionRunning()) return; // Transcription lock guard
    const bvid = resolveCurrentBvid();
    if (!bvid) return;
    if (appState.subtitleCapturedBvid === bvid) return;
    if (hasUsableSubtitleCache(appState.cache, bvid)) {
        appState.subtitleCapturedBvid = bvid;
        return;
    }
    logPlayerApiCaptureDisabled(bvid);
    scheduleTranscriptionPrompt({
        bvid,
        cid: resolveCid(),
        tid: getTidFromUrl(location.href),
        title: cleanBilibiliTitle(document.title)
    });
}

function scheduleTranscriptionPrompt(meta) {
    if (isTranscriptionRunning()) return; // Transcription lock guard
    const bvid = normalizeBvidCase(meta?.bvid || "");
    const injectBvid = normalizeBvidCase(appState.injectBvid || "");
    const currentBvid = normalizeBvidCase(resolveCurrentBvid() || "");
    if (!bvid || !injectBvid || !currentBvid || bvid !== injectBvid || currentBvid !== injectBvid) return;
    if (appState.subtitleCheckDelayTimer) {
        clearTimeout(appState.subtitleCheckDelayTimer);
        appState.subtitleCheckDelayTimer = null;
    }
    appState.subtitleCheckTargetBvid = bvid;
    beginSubtitleObservation(bvid);
    appState.subtitleCheckDelayTimer = setTimeout(() => {
        appState.subtitleCheckDelayTimer = null;
        evaluateTranscriptionNeedAfterDelay({
            ...meta,
            bvid
        });
        renderSubtitleTimelinePanel(document.getElementById("panel-body"));
    }, SUBTITLE_CHECK_DELAY_MS);
}

function startSubtitleCheckTimer() {
    if (appState.subtitleCheckDelayTimer) {
        clearTimeout(appState.subtitleCheckDelayTimer);
        appState.subtitleCheckDelayTimer = null;
    }
    const bvid = normalizeBvidCase(getBvidFromUrl(location.href) || appState.injectBvid || "");
    const p = String(getRoutePartId() || "");
    const routeKey = `${bvid.toLowerCase()}|${p}`;
    if (subtitleUiCoordinator.phase === "idle" || subtitleUiCoordinator.routeKey !== routeKey) {
        beginSubtitleUiCycle(bvid, p);
    }
}

function evaluateTranscriptionNeedAfterDelay(meta) {
    const bvid = normalizeBvidCase(meta?.bvid || "");
    const injectBvid = normalizeBvidCase(appState.injectBvid || "");
    const currentBvid = normalizeBvidCase(resolveCurrentBvid() || "");
    if (!bvid || !injectBvid || !currentBvid || bvid !== injectBvid || currentBvid !== injectBvid) return;
    if (appState.subtitleCheckTargetBvid !== bvid) return;
    if (!appState.injectReady) return;
    if (isTranscriptionRunning()) return; // Skip warnings/updates if transcribing
    if (Date.now() < Number(appState.subtitleObserveUntil || 0)) return;
    if (appState.subtitleCapturedBvid === bvid) return;
    if (hasUsableSubtitleCache(appState.cache, bvid)) return;
    if ((Array.isArray(appState.subtitleTimeline) ? appState.subtitleTimeline : []).length > 0) return;
    if (appState.subtitleDomDetected || hasNativeCCSubtitleDom()) return;
    appState.transcriptionCapsuleMeta = {
        bvid,
        cid: Number(resolveCid() || 0),
        tid: meta?.tid || appState.tabState?.activeTid || null,
        title: String(meta?.title || "").trim()
    };
    appState.transcriptionCapsuleVisible = true;
    renderSubtitleTimelinePanel(document.getElementById("panel-body"));
}

function hasNativeCCSubtitleDom() {
    const selectors = [
        ".bpx-player-subtitle-wrap .bpx-player-subtitle-item",
        ".bpx-player-subtitle-wrap .bpx-player-subtitle-item-text",
        ".bilibili-player-video-subtitle .bilibili-player-video-subtitle-content",
        ".bilibili-player-video-subtitle-content",
        ".bpx-player-dialog-wrap .bpx-player-ctrl-subtitle-language-item-text",
        "video track[kind='subtitles']",
        "video track[kind='captions']"
    ];
    return selectors.some((selector) => {
        const node = document.querySelector(selector);
        if (!node) return false;
        const text = String(node.textContent || "").trim();
        if (selector.includes("track[")) return true;
        return text.length > 0;
    });
}

async function startTranscriptionFromCapsule() {
    const fallbackMeta = {
        bvid: normalizeBvidCase(appState.injectBvid || resolveCurrentBvid()),
        cid: Number(resolveCid() || 0),
        tid: appState.tabState?.activeTid || getTidFromUrl(location.href),
        title: cleanBilibiliTitle(document.title)
    };
    const meta = appState.transcriptionCapsuleMeta || fallbackMeta;
    const bvid = normalizeBvidCase(meta?.bvid || "");
    const progressTaskId = `transcribe:${bvid || "unknown"}`;
    const injectBvid = normalizeBvidCase(appState.injectBvid || "");
    if (!meta || !bvid || !injectBvid || bvid !== injectBvid) {
        logContent.warn("asr_start_blocked", {
            task: "asr",
            bvid,
            code: "ASR_VIDEO_STATE_CHANGED",
            detail: {
                inject_bvid: injectBvid,
                has_meta: !!meta
            }
        });
        showToast("当前视频状态已变化，请稍后重试");
        return;
    }
    if (isTranscriptionRunning()) {
        logContent.warn("asr_start_blocked", {
            task: "asr",
            bvid,
            code: "ASR_ALREADY_RUNNING"
        });
        showToast("正在转录中，请稍候...");
        return;
    }
    const confirmedCid = await waitForConfirmedRouteCid(bvid);
    if (!(confirmedCid > 0)) {
        logContent.warn("asr_start_blocked", {
            task: "asr",
            bvid,
            code: "PART_IDENTITY_PENDING"
        });
        showToast("正在确认当前分 P，请稍后再试");
        return;
    }
    const confirmedMeta = {
        ...meta,
        cid: confirmedCid,
        tid: getRoutePartId() || meta?.tid || null
    };
    acceptConfirmedRouteCid(bvid, confirmedCid, "asr_preflight");
    const finishWithExistingSubtitle = (toastText = "已读取已有字幕") => {
        if (!hasUsableSubtitleCache(appState.cache, bvid)) return false;
        appState.asrRequestDispatched = false;
        applyCacheSubtitleState(appState.cache, bvid);
        clearAsrSession();
        resetTranscriptionState({ phase: "done", progress: 100 });
        appState.transcriptionCapsuleVisible = false;
        appState.transcriptionCapsuleMeta = null;
        updateProgress(100, progressTaskId);
        renderContent();
        if (toastText) showToast(toastText);
        return true;
    };
    if (finishWithExistingSubtitle("已读取已有字幕")) return;
    clearPanelError("CC");
    const asrRunId = `asr_${bvid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    appState.progressTaskId = "";
    appState.progressLastPercent = 0;
    appState.progressLastTick = 0;
    clearStepProgressTimers();
    clearPseudoProgressTicker();

    if (appState.tabState && typeof appState.tabState === "object") {
        appState.tabState = {
            ...appState.tabState,
            activeBvid: bvid,
            transcriptionProgress: 0
        };
    }
    beginAsrSession({
        bvid,
        runId: asrRunId,
        progress: 10,
        statusText: "正在检查云端字幕...",
        stage: "cloud_check"
    });
    patchTranscriptionState({
        phase: "running",
        bvid,
        progress: 10,
        statusText: "正在检查云端字幕..."
    });
    appState.transcriptionCapsuleVisible = true;
    updateProgress(10, progressTaskId, { force: true });
    renderContent();
    renderSubtitleTimelinePanel(document.getElementById("panel-body"));

    if (!hasUsableSubtitleCache(appState.cache, bvid)) {
        appState.cloudReadState = createCloudReadState(bvid, "idle", Number(appState.cloudReadState?.requestId || 0) + 1);
        const synced = await syncCacheFromBackgroundWithRetry(bvid, 2, 150, { skipCloud: false });
        if (synced && hasUsableSubtitleCache(appState.cache, bvid)) {
            finishWithExistingSubtitle("已读取已有字幕");
            return;
        }
    }
    updateAsrSession({
        bvid,
        runId: asrRunId,
        progress: 10,
        statusText: "正在请求转录...",
        stage: "start"
    });
    patchTranscriptionState({
        phase: "running",
        bvid,
        progress: 10,
        statusText: "正在请求转录..."
    });
    const preparedAudioUrl = appState.playInfo?.audio?.[0]?.url || "";
    logContent.info("asr_start_clicked", {
        task: "asr",
        bvid,
        detail: {
            run_id: asrRunId,
            cid: confirmedCid,
            route_bvid: normalizeBvidCase(getBvidFromUrl(location.href) || ""),
            inject_bvid: injectBvid,
            playinfo_bvid: normalizeBvidCase(appState.playInfo?._bvid || ""),
            has_audio_locator: !!preparedAudioUrl,
            ...summarizeMediaLocator(preparedAudioUrl)
        }
    });

    updateProgress(10, progressTaskId, { force: true });
    renderContent();
    renderSubtitleTimelinePanel(document.getElementById("panel-body"));
    try {
        const freshPlayInfo = await ensureAsrPlayInfoForBvid(bvid, confirmedCid).catch(() => null);
        if (!hasUsablePlayInfoForBvid(freshPlayInfo, bvid)) {
            throw { code: "ASR_PLAYINFO_NOT_FRESH", message: "当前视频信息还没刷新完成，请稍等 1-2 秒后重试" };
        }
        if (finishWithExistingSubtitle("已读取已有字幕")) return;
        const lateSynced = await syncCacheFromBackground(bvid, {
            preserveCacheOnMiss: true,
            force: true,
            skipCloud: false
        });
        if (lateSynced && finishWithExistingSubtitle("已读取已有字幕")) return;
        const audioUrl = freshPlayInfo?.audio?.[0]?.url || "";
        logContent.info("asr_audio_payload_selected", {
            task: "asr",
            bvid,
            detail: {
                run_id: asrRunId,
                playinfo_bvid: normalizeBvidCase(freshPlayInfo?._bvid || appState.playInfo?._bvid || ""),
                playinfo_source: String(freshPlayInfo?._source || appState.playInfo?._source || ""),
                playinfo_age_ms: Math.max(0, Date.now() - Number(freshPlayInfo?._ts || appState.playInfo?._ts || 0)),
                has_audio_locator: !!audioUrl,
                ...summarizeMediaLocator(audioUrl)
            }
        });
        appState.asrRequestDispatched = true;
        const res = await chrome.runtime.sendMessage({
            action: "GET_AUDIO_URL",
            payload: {
                ...confirmedMeta,
                cid: confirmedCid,
                audioUrl,
                asrRunId
            }
        });
        appState.asrRequestDispatched = false;
        if (!res?.ok) throw new Error(res?.error || "Groq 转录失败");
    } catch (error) {
        appState.asrRequestDispatched = false;
        if (finishWithExistingSubtitle("已读取已有字幕")) return;
        clearAsrSession();
        logContent.error("asr_start_failed", {
            task: "asr",
            bvid,
            code: error?.code || "ASR_START_FAILED",
            status: Number(error?.status || 0) || 0,
            detail: { error_message: error.message || "Groq 转录失败" }
        });
        appState.transcriptionSuppressUntil = Date.now() + 30000;
        if (appState.tabState && typeof appState.tabState === "object") {
            appState.tabState = {
                ...appState.tabState,
                transcriptionProgress: 0
            };
        }
        resetTranscriptionState();
        updateProgress(0, progressTaskId, { force: true });
        reportContentError?.(error, { task: "asr", source: "start_transcription" });
        setPanelError("CC", error, error.message || "Groq 转录失败");
        notifyMappedError(error, error.message || "Groq 转录失败");
        renderContent();
        renderSubtitleTimelinePanel(document.getElementById("panel-body"));
    }
}

async function handleRegenerateGroqSubtitle() {
    const currentBvid = normalizeBvidCase(resolveCurrentBvid() || "");
    const injectBvid = normalizeBvidCase(appState.injectBvid || "");
    if (!currentBvid || !injectBvid || currentBvid !== injectBvid) {
        showToast("当前视频状态已变化，请稍后重试");
        return;
    }
    const subtitleSource = String(appState.tabState?.subtitleSource || "");
    if (!(subtitleSource === "groq" || subtitleSource === "whisper" || subtitleSource === "siliconflow" || subtitleSource === "funasr" || subtitleSource === "mimo" || subtitleSource === "custom_asr")) return;
    const confirmedCid = await waitForConfirmedRouteCid(injectBvid);
    if (!(confirmedCid > 0)) {
        showToast("正在确认当前分 P，请稍后再试");
        return;
    }
    appState.subtitleTimeline = [];
    appState.cache = {
        ...(appState.cache || {}),
        rawSubtitle: [],
        processedSubtitle: [],
        rawHash: "",
        processedHash: ""
    };

    appState.progressTaskId = "";
    appState.progressLastPercent = 0;
    patchTranscriptionState({
        phase: "running",
        bvid: injectBvid,
        progress: 0,
        statusText: "正在重新请求转录..."
    });
    renderContent();
    const payload = {
        bvid: injectBvid,
        cid: confirmedCid,
        tid: appState.tabState?.activeTid || getTidFromUrl(location.href),
        title: cleanBilibiliTitle(document.title)
    };
    try {
        await chrome.runtime.sendMessage({ action: "CLEAR_SUBTITLE_CACHE", bvid: injectBvid, cid: confirmedCid, tid: payload.tid });
        const freshPlayInfo = await ensureAsrPlayInfoForBvid(injectBvid, confirmedCid).catch(() => null);
        if (!hasUsablePlayInfoForBvid(freshPlayInfo, injectBvid)) {
            throw { code: "ASR_PLAYINFO_NOT_FRESH", message: "当前视频信息还没刷新完成，请稍等 1-2 秒后重试" };
        }
        const audioUrl = freshPlayInfo?.audio?.[0]?.url || "";
        const asrRunId = `asr_${injectBvid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
        logContent.info("asr_regenerate_payload_prepared", {
            task: "asr",
            bvid: injectBvid,
            detail: {
                run_id: asrRunId,
                route_bvid: normalizeBvidCase(getBvidFromUrl(location.href) || ""),
                inject_bvid: injectBvid,
                playinfo_bvid: normalizeBvidCase(freshPlayInfo?._bvid || appState.playInfo?._bvid || ""),
                playinfo_source: String(freshPlayInfo?._source || appState.playInfo?._source || ""),
                playinfo_age_ms: Math.max(0, Date.now() - Number(freshPlayInfo?._ts || appState.playInfo?._ts || 0)),
                has_audio_locator: !!audioUrl,
                ...summarizeMediaLocator(audioUrl)
            }
        });
        const res = await chrome.runtime.sendMessage({
            action: "GET_AUDIO_URL",
            payload: {
                ...payload,
                cid: confirmedCid,
                audioUrl,
                asrRunId
            }
        });
        if (!res?.ok) throw new Error(res?.error || "重新生成失败");
    } catch (error) {
        if (appState.tabState && typeof appState.tabState === "object") {
            appState.tabState = {
                ...appState.tabState,
                transcriptionProgress: 0
            };
        }
        resetTranscriptionState();
        updateProgress(0, `transcribe:${injectBvid || "unknown"}`, { force: true });
        reportContentError?.(error, { task: "asr_regenerate", source: "regenerate_transcription" });
        notifyMappedError(error, error.message || "重新生成失败");
        renderContent();
    }
}

function beginSubtitleObservation(bvid) {
    const targetBvid = normalizeBvidCase(bvid || "");
    if (!targetBvid) return;
    appState.subtitleDomDetected = hasNativeCCSubtitleDom();
    appState.subtitleObserveUntil = Date.now() + SUBTITLE_OBSERVE_GRACE_MS;
    if (appState.subtitleObserver) return;
    const root = document.querySelector(".bpx-player-container") || document.body;
    if (!root) return;
    const observer = new MutationObserver(() => {
        const currentBvid = normalizeBvidCase(resolveCurrentBvid() || "");
        const injectBvid = normalizeBvidCase(appState.injectBvid || "");
        if (!currentBvid || !injectBvid || currentBvid !== injectBvid) return;
        if (hasNativeCCSubtitleDom()) {
            appState.subtitleDomDetected = true;
            appState.transcriptionCapsuleVisible = false;
            appState.transcriptionCapsuleMeta = null;
            renderSubtitleTimelinePanel(document.getElementById("panel-body"));
        }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    appState.subtitleObserver = observer;
}

function stopSubtitleObserver() {
    if (!appState.subtitleObserver) return;
    appState.subtitleObserver.disconnect();
    appState.subtitleObserver = null;
}

function isStorageChangeStateDirty(changes, switched, routeMismatch, afterBvid) {
    return isStorageChangeStateDirtyFromPage(changes, {
        switched,
        routeMismatch,
        afterBvid,
        tabKey: getTabStateKey()
    });
}

function logPlayerApiCaptureDisabled(bvid) {
    if (!isDebugLoggingEnabled()) return;
    const routeP = String(new URL(location.href).searchParams.get("p") || "");
    const logKey = `${normalizeBvidCase(bvid || "").toLowerCase()}|${routeP}`;
    if (appState.playerApiDisabledLogKey === logKey) return;
    appState.playerApiDisabledLogKey = logKey;
    logSubtitleDiagnostic("source_disabled", {
        source: "player_api",
        reason: "disabled_for_inject_only_diagnosis",
        bvid,
        routeP
    });
}

function pickSubtitle(subtitles) {
    return pickSubtitleFromPage(subtitles);
}

function normalizeSubtitleOptions(subtitles) {
    if (typeof normalizeSubtitleOptionsFromPage === "function") {
        return normalizeSubtitleOptionsFromPage(subtitles);
    }
    const list = Array.isArray(subtitles) ? subtitles : [];
    return list.map((item, index) => {
        const rawUrl = String(item?.subtitle_url || item?.url || "").trim();
        const url = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
        const id = String(item?.lan || item?.lan_doc || `subtitle-${index + 1}`).trim();
        const label = String(item?.lan_doc || item?.lan || `字幕 ${index + 1}`).trim();
        return { id, label, url };
    }).filter((item) => item.url);
}

function getSubtitleOptionId(option) {
    return String(option?.id || option?.lan || option?.lan_doc || "").trim();
}

function normalizeSubtitleLanguageKey(option) {
    const text = [
        option?.id,
        option?.lan,
        option?.label,
        option?.lanDoc,
        option?.domLabel
    ].filter(Boolean).join(" ").toLowerCase();
    if (/中文|汉语|简体|繁體|繁体|chinese|zh-cn|zh-tw|zh-hans|zh_hans|zh-hant|zh_hant|\bzh\b|\bchi\b|\bzho\b/.test(text)) return "zh";
    if (/english|英语|英文|en-us|en-gb|\ben\b|\beng\b/.test(text)) return "en";
    if (/日本語|日本话|日语|日文|japanese|\bja\b|\bjpn\b|\bjp\b/.test(text)) return "ja";
    if (/español|espanol|西班牙语|西班牙文|spanish|\bes\b|\bspa\b/.test(text)) return "es";
    if (/العربية|عربي|阿拉伯语|阿拉伯文|arabic|\bar\b|\bara\b/.test(text)) return "ar";
    if (/português|portugues|葡萄牙语|葡萄牙文|portuguese|\bpt\b|\bpor\b/.test(text)) return "pt";
    if (/한국어|조선말|韩语|韓語|korean|\bko\b|\bkor\b/.test(text)) return "ko";
    if (/français|francais|法语|法文|french|\bfr\b|\bfre\b|\bfra\b/.test(text)) return "fr";
    if (/deutsch|德语|德文|german|\bde\b|\bger\b|\bdeu\b/.test(text)) return "de";
    if (/русский|俄语|俄文|russian|\bru\b|\brus\b/.test(text)) return "ru";
    if (/italiano|意大利语|意大利文|italian|\bit\b|\bita\b/.test(text)) return "it";
    return text.replace(/[（(].*?[）)]/g, "").replace(/\s+/g, "").trim();
}

function createSubtitleCacheKey({ bvid, cid, language = "default" } = {}) {
    return [
        String(bvid || "").trim().toLowerCase(),
        String(cid || "").trim(),
        String(language || "default").trim()
    ].join("::");
}

function mergeSubtitleOptions(...groups) {
    const output = [];
    groups.flat().forEach((item) => {
        const id = getSubtitleOptionId(item);
        const label = String(item?.label || item?.lanDoc || item?.lan || id || "").trim();
        if (!id && !label) return;
        const normalized = { ...item, id: normalizeSubtitleLanguageKey(item) || id || label, label: label || id };
        const languageKey = normalizeSubtitleLanguageKey(normalized);
        const existingIndex = output.findIndex((option) => normalizeSubtitleLanguageKey(option) === languageKey);
        if (existingIndex >= 0) {
            const existing = output[existingIndex];
            output[existingIndex] = {
                ...existing,
                ...normalized,
                id: languageKey || existing.id || normalized.id,
                label: existing.label || normalized.label,
                url: existing.url || normalized.url || "",
                domLabel: existing.domLabel || normalized.domLabel || ""
            };
            return;
        }
        output.push({ ...normalized, id: languageKey || normalized.id });
    });
    return output;
}

function collectSubtitleOptionsFromDom() {
    const roots = Array.from(document.querySelectorAll(".bpx-player-ctrl-subtitle-major-inner"));
    const scopedTextNodes = roots.flatMap((root) => Array.from(root.querySelectorAll(".bpx-player-ctrl-subtitle-language-item-text")));
    const fallbackTextNodes = Array.from(document.querySelectorAll(".bpx-player-ctrl-subtitle-language-item-text"));
    const nodes = scopedTextNodes.length ? scopedTextNodes : fallbackTextNodes;
    return nodes.map((node, index) => {
        const label = String(node?.textContent || node?.innerText || "").replace(/\s+/g, " ").trim();
        if (!label || /关闭|字幕设置|自动/i.test(label)) return null;
        const item = node?.closest?.(".bpx-player-ctrl-subtitle-language-item") || node;
        const dataset = item?.dataset || {};
        const rawUrl = String(dataset.subtitleUrl || dataset.url || dataset.href || "").trim();
        const url = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
        return {
            id: `dom:${label}`,
            label,
            domLabel: label,
            domIndex: index,
            source: "dom",
            url
        };
    }).filter(Boolean);
}

function openSubtitleLanguageDomMenu() {
    const trigger = document.querySelector(".bpx-player-ctrl-subtitle, .bilibili-player-video-btn-subtitle");
    if (!trigger) return false;
    try {
        trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true, view: window }));
    } catch (_) {}
    trigger.click?.();
    return true;
}

async function refreshSubtitleOptionsFromDom() {
    let options = collectSubtitleOptionsFromDom();
    if (options.length > 1) return options;
    openSubtitleLanguageDomMenu();
    await new Promise((resolve) => setTimeout(resolve, 160));
    options = collectSubtitleOptionsFromDom();
    return options;
}

function getOfficialSubtitleOptionsForCurrentVideo() {
    const currentBvid = normalizeBvidCase(resolveCurrentBvid() || "");
    const currentCid = resolveCid();
    const currentKey = currentBvid && currentCid ? `${currentBvid}::${currentCid}` : "";
    if (!currentKey || String(appState.subtitleOptionsKey || "") !== currentKey) return [];
    return Array.isArray(appState.subtitleOptions) ? appState.subtitleOptions : [];
}

async function refreshSubtitleOptionsForCurrentVideo({ force = false, allowDomOpen = false } = {}) {
    const bvid = normalizeBvidCase(resolveCurrentBvid() || "");
    const cid = resolveCid();
    if (!bvid || !cid) return [];
    const optionsKey = `${bvid}::${cid}`;
    if (!force && String(appState.subtitleOptionsKey || "") === optionsKey && Array.isArray(appState.subtitleOptions) && appState.subtitleOptions.length) {
        return appState.subtitleOptions;
    }
    let apiOptions = [];
    try {
        const api = `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`;
        const res = await fetch(api, { credentials: "include" });
        if (res.ok) {
            const data = await res.json();
            const subtitles = Array.isArray(data?.data?.subtitle?.subtitles) ? data.data.subtitle.subtitles : [];
            apiOptions = normalizeSubtitleOptions(subtitles);
        }
    } catch (_) {}
    let domOptions = collectSubtitleOptionsFromDom();
    if (allowDomOpen && mergeSubtitleOptions(apiOptions, domOptions).length <= 1) {
        domOptions = await refreshSubtitleOptionsFromDom().catch(() => domOptions);
    }
    appState.subtitleOptions = mergeSubtitleOptions(apiOptions, domOptions);
    appState.subtitleOptionsBvid = bvid;
    appState.subtitleOptionsKey = optionsKey;
    if (!appState.activeSubtitleId && appState.subtitleOptions.length) {
        const picked = pickSubtitle(appState.subtitleOptions);
        appState.activeSubtitleId = getSubtitleOptionId(picked);
    }
    return appState.subtitleOptions;
}

async function fetchSubtitleBody(subtitleUrl) {
    const subRes = await fetch(subtitleUrl, { credentials: "include" });
    if (!subRes.ok) return [];
    const subData = await subRes.json();
    const body = subData?.body || subData?.data?.body || subData?.result?.body || subData?.content || [];
    return Array.isArray(body) ? body : [];
}

function getCachedSubtitleRowsForLanguage(option) {
    const bvid = normalizeBvidCase(resolveCurrentBvid() || "");
    const cid = resolveCid();
    const language = normalizeSubtitleLanguageKey(option) || getSubtitleOptionId(option) || "default";
    const key = createSubtitleCacheKey({ bvid, cid, language });
    const variants = appState.cache?.subtitleVariants && typeof appState.cache.subtitleVariants === "object"
        ? appState.cache.subtitleVariants
        : {};
    const entry = variants[key];
    const rows = Array.isArray(entry?.rawSubtitle) ? entry.rawSubtitle : [];
    if (!rows.length) return null;
    return { key, rows, entry };
}

function getLocalZhSubtitleRows() {
    const bvid = normalizeBvidCase(resolveCurrentBvid() || "");
    const cid = resolveCid();
    const variants = appState.cache?.subtitleVariants && typeof appState.cache.subtitleVariants === "object"
        ? appState.cache.subtitleVariants
        : {};
    const key = createSubtitleCacheKey({ bvid, cid, language: "zh" });
    const direct = variants[key];
    if (Array.isArray(direct?.rawSubtitle) && direct.rawSubtitle.length) return { key, rows: direct.rawSubtitle, entry: direct };
    const candidate = Object.entries(variants).find(([variantKey, entry]) => (
        String(variantKey || "").startsWith(`${String(bvid || "").toLowerCase()}::${String(cid || "")}::`) &&
        normalizeSubtitleLanguageKey({
            id: entry?.language,
            label: entry?.languageLabel,
            lan: entry?.language
        }) === "zh" &&
        Array.isArray(entry?.rawSubtitle) &&
        entry.rawSubtitle.length
    ));
    if (candidate) return { key: candidate[0], rows: candidate[1].rawSubtitle, entry: candidate[1] };
    const cacheLanguage = normalizeSubtitleLanguageKey({
        id: appState.cache?.subtitleLanguage,
        label: appState.cache?.subtitleLanguageLabel
    });
    const rawRows = Array.isArray(appState.cache?.rawSubtitle) ? appState.cache.rawSubtitle : [];
    const isOfficial = String(appState.cache?.subtitleSource || "").toLowerCase() === "official";
    if (rawRows.length && isOfficial && (!cacheLanguage || cacheLanguage === "zh" || String(appState.cache?.subtitleLanguage || "") === "default")) {
        return {
            key,
            rows: rawRows,
            entry: {
                bvid,
                cid,
                language: "zh",
                languageLabel: appState.cache?.subtitleLanguageLabel || "中文",
                subtitleUrl: appState.cache?.subtitleUrl || "",
                rawSubtitle: rawRows,
                processedSubtitle: Array.isArray(appState.cache?.processedSubtitle) ? appState.cache.processedSubtitle : []
            }
        };
    }
    return null;
}

function findSubtitleOption(options, optionId) {
    const targetId = String(optionId || "").trim();
    const targetKey = normalizeSubtitleLanguageKey({ id: targetId, label: targetId, domLabel: targetId });
    const candidates = (Array.isArray(options) ? options : []).filter((item) => (
        getSubtitleOptionId(item) === targetId ||
        normalizeSubtitleLanguageKey(item) === targetId ||
        (targetKey && normalizeSubtitleLanguageKey(item) === targetKey)
    ));
    if (!candidates.length) return null;
    return candidates.find((item) => !!getCachedSubtitleRowsForLanguage(item)?.rows?.length)
        || candidates.find((item) => !!String(item?.url || "").trim())
        || candidates[0];
}

async function resolveSubtitleRowsForOption(option, { forceRefresh = false } = {}) {
    const languageKey = normalizeSubtitleLanguageKey(option) || getSubtitleOptionId(option) || "default";
    let targetOption = option;
    let cached = getCachedSubtitleRowsForLanguage(targetOption);
    if (cached?.rows?.length) {
        return { option: targetOption, rows: cached.rows, cached };
    }
    if (targetOption?.url) {
        const rows = await fetchSubtitleBody(targetOption.url);
        if (rows.length) return { option: targetOption, rows, cached: null };
    }
    if (forceRefresh) {
        const freshOptions = await refreshSubtitleOptionsForCurrentVideo({ force: true, allowDomOpen: true });
        const freshOption = findSubtitleOption(freshOptions, languageKey);
        if (freshOption) {
            targetOption = freshOption;
            cached = getCachedSubtitleRowsForLanguage(targetOption);
            if (cached?.rows?.length) {
                return { option: targetOption, rows: cached.rows, cached };
            }
            if (targetOption?.url) {
                const rows = await fetchSubtitleBody(targetOption.url);
                if (rows.length) return { option: targetOption, rows, cached: null };
            }
        }
    }
    return { option: targetOption, rows: [], cached: null };
}

function syncBiliSubtitleDomLanguage(option) {
    const label = String(option?.domLabel || option?.label || "").trim();
    if (!label) return;
    clickSubtitleLanguageDomOption(label).catch(() => {});
}

async function saveOfficialSubtitleRows(option, rows, cached = null) {
    const bvid = normalizeBvidCase(resolveCurrentBvid() || "");
    if (!bvid) throw new Error("未获取到当前视频");
    const languageKey = normalizeSubtitleLanguageKey(option) || getSubtitleOptionId(option) || "default";
    const res = await chrome.runtime.sendMessage({
        action: "SUBTITLE_CAPTURED",
        payload: {
            bvid,
            cid: resolveCid(),
            tid: getTidFromUrl(location.href),
            title: cleanBilibiliTitle(document.title),
            subtitle: rows,
            source: "official",
            subtitleLanguage: languageKey,
            subtitleLanguageLabel: option.label || getSubtitleOptionId(option),
            subtitleUrl: option.url || cached?.entry?.subtitleUrl || "",
            clearDerived: true
        }
    });
    if (!res?.ok) throw new Error(res?.error || "切换字幕失败");
    applyOfficialSubtitleVariantToLocalCache({
        bvid,
        option,
        rows,
        cached,
        languageKey
    });
    subtitleUiCoordinator.displaySource = "language_switch";
    commitSubtitleRows(rows, {
        source: "language_switch",
        bvid,
        p: getRoutePartId(),
        cid: resolveCid(),
        replace: true
    });
    syncCacheFromBackground(bvid, { preserveCacheOnMiss: true, force: true, skipCloud: true })
        .then(() => {
            if (appState.activePage === "CC") renderContent();
        })
        .catch(() => {});
}

function applyOfficialSubtitleVariantToLocalCache({ bvid, option, rows, cached = null, languageKey = "" } = {}) {
    const target = normalizeBvidCase(bvid || resolveCurrentBvid() || "");
    if (!target || !Array.isArray(rows) || !rows.length) return;
    const cid = resolveCid();
    const language = String(languageKey || normalizeSubtitleLanguageKey(option) || getSubtitleOptionId(option) || "default").trim() || "default";
    const key = createSubtitleCacheKey({ bvid: target, cid, language });
    const existingCache = appState.cache && typeof appState.cache === "object" ? appState.cache : {};
    const variants = existingCache.subtitleVariants && typeof existingCache.subtitleVariants === "object"
        ? { ...existingCache.subtitleVariants }
        : {};
    const processedSubtitle = Array.isArray(cached?.entry?.processedSubtitle) && cached.entry.processedSubtitle.length
        ? cached.entry.processedSubtitle
        : (Array.isArray(existingCache.processedSubtitle) && String(existingCache.subtitleLanguage || "") === language
            ? existingCache.processedSubtitle
            : []);
    variants[key] = {
        ...(variants[key] && typeof variants[key] === "object" ? variants[key] : {}),
        bvid: target,
        cid,
        language,
        languageLabel: String(option?.label || getSubtitleOptionId(option) || language),
        subtitleUrl: String(option?.url || cached?.entry?.subtitleUrl || ""),
        rawSubtitle: rows,
        processedSubtitle,
        updatedAt: Date.now()
    };
    appState.cache = {
        ...existingCache,
        bvid: target,
        cid,
        tid: getTidFromUrl(location.href),
        title: cleanBilibiliTitle(document.title),
        subtitleSource: "official",
        subtitleLanguage: language,
        subtitleLanguageLabel: String(option?.label || getSubtitleOptionId(option) || language),
        subtitleUrl: String(option?.url || cached?.entry?.subtitleUrl || ""),
        rawSubtitle: rows,
        processedSubtitle,
        subtitleVariants: variants,
        updatedAt: Date.now()
    };
    appState.tabState = {
        ...(appState.tabState || {}),
        activeBvid: target,
        activeCid: cid || appState.tabState?.activeCid || 0,
        activeTid: getTidFromUrl(location.href) || appState.tabState?.activeTid || null,
        subtitleSource: "official",
        subtitleLanguage: language,
        subtitleLanguageLabel: String(option?.label || getSubtitleOptionId(option) || language),
        transcriptionProgress: 0,
        updatedAt: Date.now()
    };
    appState.activeSubtitleId = language;
    appState.subtitleCapturedBvid = target;
    appState.lastSubtitleForwardAt = Date.now();
}

async function switchOfficialSubtitleLanguage(optionId) {
    const bvid = normalizeBvidCase(resolveCurrentBvid() || "");
    if (!bvid) throw new Error("未获取到当前视频");
    const targetKey = normalizeSubtitleLanguageKey({ id: optionId, label: optionId, domLabel: optionId });
    if (targetKey === "zh") {
        const zhCached = getLocalZhSubtitleRows();
        if (zhCached?.rows?.length) {
            const zhOption = {
                id: "zh",
                label: zhCached.entry?.languageLabel || "中文",
                url: zhCached.entry?.subtitleUrl || ""
            };
            applyOfficialSubtitleVariantToLocalCache({
                bvid,
                option: zhOption,
                rows: zhCached.rows,
                cached: zhCached,
                languageKey: "zh"
            });
            subtitleUiCoordinator.displaySource = "language_switch";
            subtitleUiCoordinator.lastCacheApplySignature = "";
            const ccPanel = panelShadowRoot?.getElementById?.("page-CC");
            if (ccPanel) delete ccPanel.dataset.subtitleDiagRenderSignature;
            commitSubtitleRows(zhCached.rows, {
                source: "language_switch",
                bvid,
                p: getRoutePartId(),
                cid: resolveCid(),
                replace: true
            });
            showToast("已切换为中文");
            return;
        }
    }
    const options = await refreshSubtitleOptionsForCurrentVideo({ force: !getOfficialSubtitleOptionsForCurrentVideo().length, allowDomOpen: true });
    const option = findSubtitleOption(options, optionId);
    if (!option) throw new Error("未找到该字幕语种");
    const { option: targetOption, rows, cached } = await resolveSubtitleRowsForOption(option, { forceRefresh: true });
    if (!rows.length && !targetOption?.url && (targetOption?.domLabel || targetOption?.label)) {
        await switchSubtitleLanguageByDom(targetOption);
        return;
    }
    if (!rows.length && !targetOption?.url) throw new Error("未能读取该语种字幕");
    if (!rows.length) throw new Error("该语种字幕为空");
    await saveOfficialSubtitleRows(targetOption, rows, cached);
    syncBiliSubtitleDomLanguage(targetOption);
    showToast(`已切换为${targetOption.label || targetOption.id}`);
}

async function switchSubtitleLanguageByDom(option) {
    const label = String(option?.domLabel || option?.label || "").trim();
    if (!label) throw new Error("未找到该字幕语种");
    const bvid = normalizeBvidCase(resolveCurrentBvid() || "");
    const marker = Date.now();
    appState.pendingSubtitleLanguageSwitch = {
        id: getSubtitleOptionId(option),
        label,
        bvid,
        startedAt: marker
    };
    appState.subtitleCapturedBvid = "";
    window.postMessage({ type: "BILI_ALLOW_SUBTITLE_RECAPTURE" }, "*");
    const clicked = await clickSubtitleLanguageDomOption(label);
    if (!clicked) {
        appState.pendingSubtitleLanguageSwitch = null;
        throw new Error("未找到该字幕语种");
    }
    try {
        await waitForSubtitleSwitchForward(marker);
    } catch (error) {
        const resolved = await resolveSubtitleRowsForOption(option, { forceRefresh: true });
        if (!resolved.rows.length) throw error;
        await saveOfficialSubtitleRows(resolved.option, resolved.rows, resolved.cached);
    }
    await syncCacheFromBackground(bvid, { preserveCacheOnMiss: true, force: true, skipCloud: true });
    if (appState.activePage === "CC") renderContent();
    showToast(`已切换为${label}`);
}

async function clickSubtitleLanguageDomOption(label) {
    const normalizedLabel = String(label || "").replace(/\s+/g, " ").trim();
    if (!normalizedLabel) return false;
    const requestId = `subtitle_switch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const resultPromise = new Promise((resolve) => {
        const timer = setTimeout(() => {
            window.removeEventListener("message", onMessage);
            resolve({ clicked: false, matchedText: "" });
        }, 1500);
        function onMessage(event) {
            if (event?.data?.type !== "BILI_SUBTITLE_LANGUAGE_SWITCH_RESULT") return;
            if (String(event.data?.requestId || "") !== requestId) return;
            clearTimeout(timer);
            window.removeEventListener("message", onMessage);
            resolve({
                clicked: !!event.data?.clicked,
                matchedText: String(event.data?.matchedText || "")
            });
        }
        window.addEventListener("message", onMessage);
    });
    window.postMessage({ type: "BILI_SWITCH_SUBTITLE_LANGUAGE", label: normalizedLabel, requestId }, "*");
    const result = await resultPromise;
    logContent.info("subtitle_detected", {
        source: "dom_language_click_result",
        request_id: requestId,
        label: normalizedLabel,
        clicked: !!result.clicked,
        matched_text: result.matchedText || ""
    });
    return !!result.clicked;
}

function waitForSubtitleSwitchForward(marker, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            if (Number(appState.lastSubtitleForwardAt || 0) >= marker) {
                clearInterval(timer);
                resolve();
                return;
            }
            if (Date.now() - startedAt > timeoutMs) {
                clearInterval(timer);
                appState.pendingSubtitleLanguageSwitch = null;
                reject(new Error("字幕切换超时，请重试"));
            }
        }, 120);
    });
}

function resolveCid() {
    return getCurrentRouteCid();
}

function resolveCurrentBvid() {
    return resolveCurrentBvidFromState(appState, location.href);
}

function isTabStateForCurrentVideo() {
    const currentBvid = normalizeBvidCase(resolveCurrentBvid() || "");
    const stateBvid = normalizeBvidCase(appState.tabState?.activeBvid || "");
    return !!currentBvid && !!stateBvid && currentBvid === stateBvid;
}

function getCurrentVideoTaskStatus(task) {
    if (hasLocalPendingTask(task)) return "processing";
    if (!isTabStateForCurrentVideo()) return "idle";
    return appState.tabState?.taskStatus?.[task] || "idle";
}

function getCurrentVideoTaskErrorView(task) {
    if (!isTabStateForCurrentVideo()) return null;
    const taskStatus = appState.tabState?.taskStatus?.[task] || "";
    const rawError = appState.tabState?.taskErrors?.[task]
        || ((taskStatus === "error" || taskStatus === "timeout") ? {
            message: appState.tabState?.lastError || (taskStatus === "timeout" ? "任务超时，请重试~" : "任务失败"),
            code: taskStatus === "timeout" ? "TIMEOUT" : ""
        } : null);
    if (!rawError || !mapErrorToView) return null;
    return mapErrorToView(toErrorInput(rawError, "任务失败"), "任务失败", {
        provider: appState.settings?.provider || "",
        surface: "panel"
    });
}

function reportRetryClickIfNeeded(tasks = [], action = "") {
    const taskList = Array.isArray(tasks) ? tasks : [];
    const failedTask = taskList.find((task) => {
        if (task === "transcribe") return appState.panelErrors?.CC;
        return getCurrentVideoTaskErrorView(task);
    });
    if (!failedTask) return;
    const featureName = taskList.includes("summary") && taskList.includes("segments")
        ? "summary_segments_merged"
        : failedTask;
    const errorView = failedTask === "transcribe" ? appState.panelErrors?.CC : getCurrentVideoTaskErrorView(failedTask);
    reportUsageEvent({
        eventName: "retry_clicked",
        featureName,
        status: "clicked",
        errorCode: errorView?.code || "",
        metadata: { action }
    });
}

function hasUsableSubtitleCache(cache, targetBvid = "") {
    const target = normalizeBvidCase(targetBvid || "");
    const cacheBvid = normalizeBvidCase(cache?.bvid || "");

    if (target && cacheBvid && target !== cacheBvid) return false;
    if (!isCacheForCurrentRouteVideo(cache, target)) return false;

    return (
        (Array.isArray(cache?.rawSubtitle) && cache.rawSubtitle.length > 0) ||
        (Array.isArray(cache?.processedSubtitle) && cache.processedSubtitle.length > 0)
    );
}

function getCurrentRouteVideoKey() {
    const bvid = normalizeBvidCase(getBvidFromUrl(location.href) || resolveCurrentBvid() || "");
    const tid = getRoutePartId();
    return bvid ? `${bvid}|${tid}` : "";
}

function getRoutePartId() {
    try {
        return String(new URL(location.href).searchParams.get("p") || "").trim();
    } catch (_) {
        return "";
    }
}

function getCurrentRouteCid() {
    const routeBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
    const routeTid = getRoutePartId();
    const injectBvid = normalizeBvidCase(appState.injectBvid || "");
    const tabStateBvid = normalizeBvidCase(appState.tabState?.activeBvid || "");
    const tabStateTid = String(appState.tabState?.activeTid || "").trim();
    const playInfoBvid = normalizeBvidCase(appState.playInfo?._bvid || "");
    const candidates = [];
    if (!routeBvid || !injectBvid || routeBvid === injectBvid) candidates.push(appState.injectCid);
    if ((!routeBvid || (tabStateBvid && routeBvid === tabStateBvid))
        && (routeTid ? (tabStateTid && routeTid === tabStateTid) : !tabStateTid)) {
        candidates.push(appState.tabState?.activeCid);
    }
    if ((!routeBvid || (playInfoBvid && routeBvid === playInfoBvid))) candidates.push(appState.playInfo?._cid);
    for (const value of candidates) {
        const cid = Number(value || 0);
        if (Number.isFinite(cid) && cid > 0) return cid;
    }
    return 0;
}

function getCurrentRoutePartCount() {
    const routeBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
    const injectBvid = normalizeBvidCase(appState.injectBvid || "");
    const playInfoBvid = normalizeBvidCase(appState.playInfo?._bvid || "");
    const tabStateBvid = normalizeBvidCase(appState.tabState?.activeBvid || "");
    const candidates = [];
    if (!routeBvid || !injectBvid || routeBvid === injectBvid) candidates.push(appState.injectPartCount);
    if (!routeBvid || !playInfoBvid || routeBvid === playInfoBvid) candidates.push(appState.playInfo?._partCount);
    if (!routeBvid || !tabStateBvid || routeBvid === tabStateBvid) candidates.push(appState.tabState?.activePartCount);
    for (const value of candidates) {
        const partCount = Number(value || 0);
        if (Number.isFinite(partCount) && partCount > 0) return Math.floor(partCount);
    }
    return 0;
}

function acceptConfirmedRouteCid(bvid, cid, source = "unknown") {
    const routeBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
    const confirmedBvid = normalizeBvidCase(bvid || "");
    const confirmedCid = Number(cid || 0);
    if (!routeBvid || !confirmedBvid || routeBvid !== confirmedBvid || !(confirmedCid > 0)) return false;
    const previousCid = getCurrentRouteCid();
    appState.injectBvid = routeBvid;
    appState.injectCid = confirmedCid;
    appState.tabState = {
        ...(appState.tabState || {}),
        activeBvid: routeBvid,
        activeCid: confirmedCid,
        activeTid: getRoutePartId() || null,
        activePartCount: getCurrentRoutePartCount(),
        updatedAt: Date.now()
    };
    chrome.runtime.sendMessage({
        action: "SET_ACTIVE_PART",
        bvid: routeBvid,
        cid: confirmedCid,
        tid: getRoutePartId() || null,
        partCount: getCurrentRoutePartCount()
    }).catch(() => {});
    if (previousCid !== confirmedCid) {
        logPartScopeDiagnostic("route_cid_confirmed", {
            source,
            previousCid,
            confirmedCid
        });
        appState.isStateDirty = true;
        syncCacheFromBackground(routeBvid, {
            preserveCacheOnMiss: true,
            force: true,
            skipCloud: true
        }).catch(() => {});
    }
    return true;
}

function isCacheForCurrentRouteVideo(cache, targetBvid = "") {
    if (!cache) return false;
    const target = normalizeBvidCase(targetBvid || resolveCurrentBvid() || "");
    const cacheBvid = normalizeBvidCase(cache?.bvid || "");
    if (target && cacheBvid && target !== cacheBvid) return false;

    const routeBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
    const routeTid = getRoutePartId();
    const routeCid = getCurrentRouteCid();
    const cacheCid = Number(cache?.cid || 0);
    if (routeBvid && cacheBvid && routeBvid !== cacheBvid) return false;
    if (!(cacheCid > 0)) return false;
    if (!(routeCid > 0)) {
        const isConfirmedSinglePartVideo = !routeTid && getCurrentRoutePartCount() === 1;
        return isConfirmedSinglePartVideo;
    }
    if (routeCid !== cacheCid) return false;
    if (!routeTid) return true;

    const cacheTid = String(cache?.tid || "").trim();
    if (cacheTid) return cacheTid === routeTid;
    return false;
}

function selectCacheDirectoryPart(cache, targetBvid = "", targetCid = 0) {
    if (!cache || typeof cache !== "object") return null;
    const bvid = normalizeBvidCase(cache.bvid || targetBvid || "");
    const cid = Number(targetCid || 0);
    if (!bvid) return null;
    if (!(cid > 0)) return null;
    const partKey = `${bvid.toLowerCase()}::${cid}`;
    const part = cache.parts && typeof cache.parts === "object" ? cache.parts[partKey] : null;
    if (part && typeof part === "object") {
        return { ...cache, ...part, parts: cache.parts, subtitleVariants: cache.subtitleVariants };
    }
    return null;
}

function logCacheDirectoryStructure(cache, source = "storage") {
    if (!isDebugLoggingEnabled() || !cache || typeof cache !== "object") return;
    const parts = cache.parts && typeof cache.parts === "object" ? cache.parts : {};
    const directory = Object.fromEntries(Object.entries(parts).map(([partKey, part]) => [partKey, {
        cid: Number(part?.cid || 0),
        tid: String(part?.tid || ""),
        title: String(part?.title || ""),
        subtitleRows: Array.isArray(part?.rawSubtitle) ? part.rawSubtitle.length : 0,
        subtitleVariants: part?.subtitleVariants && typeof part.subtitleVariants === "object"
            ? Object.keys(part.subtitleVariants).length
            : 0,
        hasSummary: !!String(part?.summary || "").trim(),
        segmentsCount: Array.isArray(part?.segments) ? part.segments.length : 0,
        hasRumors: !!part?.rumors,
        historyCount: Array.isArray(part?.history) ? part.history.length : 0,
        metricsCount: Array.isArray(part?.metrics) ? part.metrics.length : 0,
        updatedAt: Number(part?.updatedAt || 0)
    }]));
    const payload = {
        source,
        topLevel: {
            bvid: normalizeBvidCase(cache.bvid || "").toLowerCase(),
            schemaVersion: Number(cache.schemaVersion || 0),
            updatedAt: Number(cache.updatedAt || 0),
            keys: Object.keys(cache).sort(),
            partCount: Object.keys(parts).length
        },
        parts: directory
    };
    const signature = JSON.stringify(payload, (key, value) => key === "updatedAt" ? undefined : value);
    const dedupeKey = `cache-directory:${source}`;
    if (partScopeDiagnosticSignatures.get(dedupeKey) === signature) return;
    partScopeDiagnosticSignatures.set(dedupeKey, signature);
    console.log("[CACHE_DIRECTORY]", payload);
}

function getSubtitleCacheApplySignature(cache = {}) {
    return [
        normalizeBvidCase(cache?.bvid || "").toLowerCase(),
        Number(cache?.cid || 0),
        String(cache?.tid || ""),
        String(cache?.rawHash || ""),
        String(cache?.processedHash || ""),
        Array.isArray(cache?.rawSubtitle) ? cache.rawSubtitle.length : 0,
        Array.isArray(cache?.processedSubtitle) ? cache.processedSubtitle.length : 0,
        String(cache?.subtitleSource || ""),
        String(cache?.subtitleLanguage || "")
    ].join("|");
}

function makeShortDigest(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function summarizeMediaLocator(locator) {
    const raw = String(locator || "").trim();
    if (!raw) return { audio_host: "", audio_path_hash: "", audio_query_key_count: 0 };
    try {
        const parsed = new URL(raw);
        const queryKeys = [...parsed.searchParams.keys()].sort();
        return {
            audio_host: parsed.host || "",
            audio_path_hash: makeShortDigest(`${parsed.pathname || ""}?${parsed.search || ""}`),
            audio_query_key_count: queryKeys.length,
            audio_query_keys_hash: makeShortDigest(queryKeys.join("|"))
        };
    } catch (_) {
        return {
            audio_host: "",
            audio_path_hash: makeShortDigest(raw),
            audio_query_key_count: 0,
            audio_query_keys_hash: ""
        };
    }
}

function isolateChatInputKeyboardEvent(event) {
    const path = typeof event?.composedPath === "function" ? event.composedPath() : [];
    const target = path.find((node) => node?.id === "chat-input") || event?.target;
    if (!target || target.id !== "chat-input") return;
    if (event.isComposing || event.keyCode === 229) return;
    const key = String(event.key || "");
    if ((key === " " || key === "Spacebar") && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        event.stopImmediatePropagation?.();
        insertTextIntoControl(target, " ");
        return;
    }
    if (shouldIsolateChatInputKey?.(key)) {
        event.stopImmediatePropagation?.();
        return;
    }
    const isPlainTextKey = key.length === 1 || key === " " || key === "Spacebar";
    if (!isPlainTextKey) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.stopPropagation();
}

function insertTextIntoControl(input, text) {
    if (!input || typeof input.value !== "string") return;
    const start = Number.isFinite(input.selectionStart) ? input.selectionStart : input.value.length;
    const end = Number.isFinite(input.selectionEnd) ? input.selectionEnd : start;
    if (typeof input.setRangeText === "function") {
        input.setRangeText(text, start, end, "end");
    } else {
        input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`;
        const nextPosition = start + text.length;
        input.selectionStart = nextPosition;
        input.selectionEnd = nextPosition;
    }
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function onGlobalShortcut(event) {
    if (!event.ctrlKey || !event.shiftKey || String(event.key).toLowerCase() !== "l") return;
    event.preventDefault();
    if (logWindowVisible) {
        closeLogWindow();
        return;
    }
    openLogWindow();
}

async function openLogWindow() {
    logWindowVisible = true;
    let win = document.getElementById("plugin-log-window");
    if (!win) {
        win = document.createElement("section");
        win.id = "plugin-log-window";
        win.className = "plugin-log-window";
        win.innerHTML = `
            <div class="plugin-log-head">
                <div class="plugin-log-title">AI Plugin Logs</div>
                <div class="plugin-log-actions">
                    <button class="panel-btn ghost" data-action="logs-refresh">刷新</button>
                    <button class="panel-btn ghost" data-action="logs-copy">复制</button>
                    <button class="panel-btn ghost" data-action="logs-close">关闭</button>
                </div>
            </div>
            <pre class="plugin-log-body" id="plugin-log-body"></pre>
        `;
        document.body.appendChild(win);
        bindLogWindowEvents(win);
    }
    win.style.display = "flex";
    await renderLogWindowData();
    startLogWindowPolling();
}

function closeLogWindow() {
    logWindowVisible = false;
    const win = document.getElementById("plugin-log-window");
    if (win) win.style.display = "none";
    stopLogWindowPolling();
}

async function renderLogWindowData() {
    const box = document.getElementById("plugin-log-body");
    if (!box) return;
    try {
        const res = await chrome.runtime.sendMessage({ action: "GET_LOGS" });
        if (!res?.ok) throw new Error(res?.error || "读取日志失败");
        const logs = Array.isArray(res.logs) ? res.logs : [];
        box.textContent = logs
            .slice(-DEBUG_LOG_DISPLAY_LIMIT)
            .map((item) => `${item.time} ${item.level} ${item.module} ${item.event} ${JSON.stringify(item.detail || {})}`)
            .join("\n");
    } catch (error) {
        box.textContent = `读取日志失败：${error.message || "未知错误"}`;
        logContent.error("cache_read_failed", {
            task: "logs",
            code: "LOG_READ_FAILED",
            detail: {
                key: "global_logs",
                error_message: error.message || "读取日志失败"
            }
        });
    }
}

async function renderRealtimeLogData() {
    const box = panelShadowRoot ? panelShadowRoot.getElementById("debug-log-body") : null;
    const status = panelShadowRoot ? panelShadowRoot.getElementById("debug-log-status") : null;
    if (!box) return;
    try {
        const res = await chrome.runtime.sendMessage({ action: "GET_LOGS" });
        if (!res?.ok) throw new Error(res?.error || "读取日志失败");
        const structuredLogs = Array.isArray(res.logs) ? res.logs : [];
        const asrUiLogs = (Array.isArray(appState.asrUiTraceLogs) ? appState.asrUiTraceLogs : []).map((item) => ({
            time: item?.time || "",
            level: "debug",
            module: "asr_ui",
            event: item?.event || "asr_ui_trace",
            task: "transcribe",
            source: "content",
            detail: item?.detail || {}
        }));
        const logs = [...structuredLogs, ...asrUiLogs]
            .sort((left, right) => String(left?.time || "").localeCompare(String(right?.time || "")));
        const query = String(appState.debugLogQuery || "").trim().toLowerCase();
        const filtered = logs.filter((item) => {
            if (appState.debugLogLevel !== "all" && String(item?.level || "") !== appState.debugLogLevel) return false;
            if (appState.debugLogModule !== "all" && String(item?.module || "") !== appState.debugLogModule) return false;
            if (appState.debugLogOnlyFailures) {
                const signal = `${item?.level || ""} ${item?.event || ""} ${item?.code || ""}`.toLowerCase();
                if (!/(warn|error|fail|timeout|abort|fallback|retry|denied|invalid|blocked|mismatch)/.test(signal)) return false;
            }
            if (query) {
                const searchable = [
                    item?.event,
                    item?.task,
                    item?.task_id,
                    item?.trace_id,
                    item?.module,
                    item?.code,
                    item?.fallback,
                    item?.provider,
                    item?.model,
                    JSON.stringify(item?.detail || {})
                ].join(" ").toLowerCase();
                if (!searchable.includes(query)) return false;
            }
            return true;
        });
        const shownLogs = filtered.slice(-DEBUG_LOG_DISPLAY_LIMIT);
        if (appState.debugLogView === "raw") {
            box.classList.add("raw");
            box.textContent = shownLogs.length
                ? shownLogs.map(formatLogEntryLine).join("\n")
                : "没有符合当前筛选条件的日志。";
        } else {
            box.classList.remove("raw");
            box.innerHTML = shownLogs.length
                ? shownLogs.map(formatDebugTimelineEntry).join("")
                : `<div class="debug-log-empty">没有符合当前筛选条件的日志。</div>`;
        }
        if (status) {
            status.textContent = `${logs.length} 条 · 筛选后 ${filtered.length} 条 · 显示 ${shownLogs.length} 条`;
        }
    } catch (error) {
        box.textContent = `读取日志失败：${error.message || "未知错误"}`;
        if (status) status.textContent = "读取失败";
        logContent.error("cache_read_failed", {
            task: "logs",
            code: "LOG_READ_FAILED",
            detail: {
                key: "global_logs",
                error_message: error.message || "读取日志失败"
            }
        });
    }
}

function formatLogEntryLine(item) {
    const detail = item?.detail && typeof item.detail === "object" ? item.detail : {};
    const meta = [
        item?.task ? `task=${item.task}` : "",
        item?.task_id ? `task_id=${item.task_id}` : "",
        item?.trace_id ? `trace=${item.trace_id}` : "",
        item?.bvid ? `bvid=${item.bvid}` : "",
        item?.provider ? `provider=${item.provider}` : "",
        item?.model ? `model=${item.model}` : "",
        item?.code ? `code=${item.code}` : "",
        item?.status ? `status=${item.status}` : "",
        item?.fallback ? `fallback=${item.fallback}` : "",
        item?.duration_ms ? `duration=${item.duration_ms}ms` : ""
    ].filter(Boolean).join(" ");
    const detailText = JSON.stringify(detail || {});
    return `${item?.time || ""} ${String(item?.level || "").toUpperCase()} [${item?.module || ""}] ${item?.event || ""}${meta ? ` | ${meta}` : ""} | ${detailText}`;
}

function copyRealtimeLogData() {
    const box = panelShadowRoot ? panelShadowRoot.getElementById("debug-log-body") : null;
    const text = box?.textContent || "";
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        showToast("日志已复制");
    }).catch((error) => {
        showToast("复制失败");
        logContent.error("task_abort", {
            task: "copy_logs",
            code: "LOG_COPY_FAILED",
            detail: { error_message: error.message || "复制失败" }
        });
    });
}

async function copyDebugDiagnosticReport() {
    try {
        const response = await chrome.runtime.sendMessage({ action: "GET_LOGS" });
        const report = {
            generated_at: new Date().toISOString(),
            extension_version: globalThis.chrome?.runtime?.getManifest?.()?.version || "",
            state: buildDebugStateSnapshot(),
            last_scenario: appState.debugScenarioResult || null,
            logs: Array.isArray(response?.logs) ? response.logs.slice(-200) : [],
            asr_ui_trace: Array.isArray(appState.asrUiTraceLogs) ? appState.asrUiTraceLogs.slice(-100) : []
        };
        await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
        showToast("诊断报告已复制");
    } catch (error) {
        showToast("复制诊断报告失败");
        logContent.error("task_abort", {
            task: "copy_diagnostics",
            code: "DIAGNOSTIC_COPY_FAILED",
            detail: { error_message: error?.message || "复制失败" }
        });
    }
}

function formatDebugTimelineEntry(item) {
    const level = String(item?.level || "info").toLowerCase();
    const time = item?.time ? new Date(item.time).toLocaleTimeString() : "--:--:--";
    const detail = item?.detail && typeof item.detail === "object" ? item.detail : {};
    const meta = [
        item?.task ? `task=${item.task}` : "",
        item?.task_id ? `task_id=${item.task_id}` : "",
        item?.trace_id ? `trace=${item.trace_id}` : "",
        item?.provider ? `provider=${item.provider}` : "",
        item?.code ? `code=${item.code}` : "",
        item?.status ? `status=${item.status}` : "",
        item?.fallback ? `fallback=${item.fallback}` : "",
        item?.duration_ms ? `${item.duration_ms}ms` : "",
        Number.isFinite(Number(detail.queue_wait_ms)) ? `queue=${Number(detail.queue_wait_ms)}ms` : "",
        Number.isFinite(Number(detail.provider_request_ms)) ? `request=${Number(detail.provider_request_ms)}ms` : "",
        Number.isFinite(Number(detail.first_response_ms)) ? `first=${Number(detail.first_response_ms)}ms` : "",
        detail.timeout_phase ? `phase=${detail.timeout_phase}` : ""
    ].filter(Boolean);
    const detailText = JSON.stringify(detail);
    return `
        <article class="debug-log-entry level-${escapeHtml(level)}">
            <div class="debug-log-entry-main">
                <time>${escapeHtml(time)}</time>
                <span class="debug-level-chip">${escapeHtml(level.toUpperCase())}</span>
                <b>${escapeHtml(String(item?.module || ""))}</b>
                <strong>${escapeHtml(String(item?.event || "unknown_event"))}</strong>
            </div>
            ${meta.length ? `<div class="debug-log-entry-meta">${meta.map((value) => `<span>${escapeHtml(value)}</span>`).join("")}</div>` : ""}
            ${detailText !== "{}" ? `<details><summary>详情</summary><pre>${escapeHtml(JSON.stringify(detail, null, 2))}</pre></details>` : ""}
        </article>
    `;
}

async function clearDebugSession() {
    try {
        await chrome.runtime.sendMessage({ action: "CLEAR_LOGS" });
    } catch (_) {}
    appState.asrUiTraceLogs = [];
    appState.debugScenarioResult = null;
    appState.panelErrors = {};
    renderContent();
    showToast("本次调试会话已清空");
}

async function clearRealtimeLogs() {
    try {
        await chrome.runtime.sendMessage({ action: "CLEAR_LOGS" });
        appState.asrUiTraceLogs = [];
        await renderRealtimeLogData();
        showToast("日志已清空");
    } catch (error) {
        showToast("清空失败");
        logContent.error("task_abort", {
            task: "clear_logs",
            code: "LOG_CLEAR_FAILED",
            detail: { error_message: error.message || "清空失败" }
        });
    }
}

function copyLogWindowData() {
    const box = document.getElementById("plugin-log-body");
    const text = box?.textContent || "";
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        showToast("日志已复制");
    }).catch((error) => {
        showToast("复制失败");
        logContent.error("task_abort", {
            task: "copy_logs",
            code: "LOG_COPY_FAILED",
            detail: { error_message: error.message || "复制失败" }
        });
    });
}

function bindLogWindowEvents(win) {
    if (!win || win.dataset.bound === "1") return;
    win.dataset.bound = "1";
    const refreshBtn = win.querySelector('[data-action="logs-refresh"]');
    const copyBtn = win.querySelector('[data-action="logs-copy"]');
    const closeBtn = win.querySelector('[data-action="logs-close"]');
    refreshBtn?.addEventListener("click", () => {
        renderLogWindowData();
    });
    copyBtn?.addEventListener("click", () => {
        copyLogWindowData();
    });
    closeBtn?.addEventListener("click", () => {
        closeLogWindow();
    });
}

function startLogWindowPolling() {
    stopLogWindowPolling();
    appState.logPollTimer = setInterval(() => {
        if (!logWindowVisible) return;
        renderLogWindowData();
    }, 1000);
}

function stopLogWindowPolling() {
    if (!appState.logPollTimer) return;
    clearInterval(appState.logPollTimer);
    appState.logPollTimer = null;
}

function startRealtimeLogPolling() {
    stopRealtimeLogPolling();
    appState.debugLogPollTimer = setInterval(() => {
        if (appState.activePage !== "debug") {
            stopRealtimeLogPolling();
            return;
        }
        renderRealtimeLogData();
    }, 1000);
}

function stopRealtimeLogPolling() {
    if (!appState.debugLogPollTimer) return;
    clearInterval(appState.debugLogPollTimer);
    appState.debugLogPollTimer = null;
}

function syncPanelHeightMode() {
    const root = panelShadowRoot ? panelShadowRoot.querySelector(".ai-summary-plugin-box") : null;
    const main = root?.querySelector(".plugin-main-container");
    if (!root || !main) return;
    
    const summaryPanel = panelShadowRoot ? panelShadowRoot.getElementById("page-summary") : null;
    const isSummaryNoApiKey = appState.activePage === "summary" && summaryPanel?.classList.contains("summary-no-apikey");
    const isSummaryPage = appState.activePage === "summary" && !isSummaryNoApiKey;
    root.classList.toggle("summary-flex-mode", isSummaryPage);
    root.classList.toggle("fixed-lock-mode", !isSummaryPage);
    
    syncPluginHeight();
    if (isSummaryPage) {
        if (summaryPanel) requestAnimationFrame(() => applySummaryRatio(summaryPanel));
    }
}

function getLockedMainHeight() {
    // Deprecated by syncPluginHeight, but kept for compatibility if called elsewhere
    return 0; 
}

function getSummaryMaxHeightLimit() {
    // Deprecated
    return 0;
}

function findPlayerContainer() {
    return document.querySelector(".bpx-player-container")
        || document.querySelector("#bilibili-player")
        || document.querySelector(".video-player-container")
        || document.querySelector(".bili-video-player")
        || document.querySelector("video")?.closest("div");
}

function getRawSubtitleRows() {
    return getRawSubtitleRowsFromCache(appState.cache);
}

function getRawSubtitlePlainText() {
    return getRawSubtitlePlainTextFromCache(appState.cache);
}

async function handleCopyRawSubtitle(buttonNode) {
    const text = getRawSubtitlePlainText();
    if (!text) {
        showToast("暂无 RAW 字幕");
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        showToast("复制成功");
        if (buttonNode) {
            const origin = buttonNode.dataset.originText || buttonNode.textContent || "";
            buttonNode.dataset.originText = origin;
            buttonNode.textContent = "OK";
            setTimeout(() => {
                buttonNode.textContent = origin;
            }, 1000);
        }
    } catch (_) {
        showToast("复制失败");
    }
}

function handleExportSrt(buttonNode) {
    const rows = getRawSubtitleRows();
    if (!rows.length) {
        showToast("暂无 RAW 字幕");
        return;
    }
    const srt = buildSrtContent(appState.cache);
    const bvid = resolveCurrentBvid() || "subtitle";
    const fileName = `${bvid}.srt`;
    downloadTextFile(fileName, srt, "application/x-subrip;charset=utf-8");
    showToast("导出成功");
    if (buttonNode) {
        setNavActionActive("export", 1000);
    }
}

function scheduleInjectRetry() {
    if (appState.injectReady) return;
    if (appState.injectRetryTimer) return;
    appState.injectRetryTimer = setInterval(() => {
        if (appState.injectReady) {
            clearInterval(appState.injectRetryTimer);
            appState.injectRetryTimer = null;
            return;
        }
        injectScriptBridge();
    }, 1500);
}

function startRouteWatcher() {
    if (appState.routeWatchTimer) return;
    appState.routeWatchBvid = getBvidFromUrl(location.href);
    appState.routeWatchKey = getCurrentRouteVideoKey();
    appState.routeWatchTimer = setInterval(() => {
        const current = getBvidFromUrl(location.href);
        const currentKey = getCurrentRouteVideoKey();
        if (!current || !currentKey || currentKey === appState.routeWatchKey) return;
        const prev = appState.routeWatchBvid || "";
        const prevKey = appState.routeWatchKey || "";
        const routeP = String(getRoutePartId() || "");
        if (isDuplicateSubtitleRouteSwitch(current, routeP)) {
            appState.routeWatchBvid = current;
            appState.routeWatchKey = currentKey;
            return;
        }
        appState.routeWatchBvid = current;
        appState.routeWatchKey = currentKey;
        pushSubtitleTimeline("route_switch", { from: prev, to: current, fromKey: prevKey, toKey: currentKey });
        resetAllState();
        clearStreamCache();
        appState.pendingSubtitle = null;
        appState.activePage = resolveDefaultOpenPage(appState.settings?.defaultOpenPage);
        renderNav();
        appState.tabState = {
            ...(appState.tabState || {}),
            activeBvid: current,
            activeCid: 0,
            activeTid: routeP || null,
            activePartCount: 0,
            updatedAt: Date.now(),
            taskStatus: {
                ...(appState.tabState?.taskStatus || {}),
                summary: "idle",
                segments: "idle",
                rumors: "idle",
                chat: "idle"
            }
        };
        appState.injectBvid = current;
        appState.injectCid = 0;
        appState.injectPartCount = 0;
        appState.injectBvidChangedAt = Date.now();
        appState.isStateDirty = true;
        chrome.runtime.sendMessage({
            action: "SET_ACTIVE_PART",
            bvid: current,
            cid: 0,
            tid: routeP || null,
            partCount: 0
        }).catch(() => {});
        startSubtitleCheckTimer();
        beginSubtitleObservation(current);
        clearCCListImmediately();
        renderContent();
        syncCacheFromBackground(current);
        refreshFeedbackAfterVideoSwitch();
        scheduleTranscriptionAvailabilityCheck("route_switch");
    }, 2000);
}

function clearStreamCache() {
    appState.playInfo = null;
    appState.playInfoUpdatedAt = 0;
    appState.isPlayInfoReady = false;
    window.postMessage({ type: "REFRESH_PLAYINFO" }, "*");
}

function clearCCListImmediately() {
    logSubtitleDiagnostic("clear_requested", { source: "clearCCListImmediately" });
    const container = panelShadowRoot ? panelShadowRoot.getElementById("page-CC") : null;
    if (!container || appState.activePage !== "CC") return;
    appState.renderedSubtitleIndex = -1;
    delete container.dataset.subtitleDiagRenderSignature;
    subtitleUiCoordinator.renderedStateSignature = "";
    scheduleSubtitleRender("clear_cc_list");
}

async function requestFromInject(timeoutMs = 500) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            window.removeEventListener("message", onMessage, false);
            resolve(null);
        }, Math.max(50, Number(timeoutMs) || 500));

        const onMessage = (event) => {
            if (event.source !== window) return;
            if (String(event?.data?.type || "") !== "SEND_PLAY_INFO") return;
            clearTimeout(timer);
            window.removeEventListener("message", onMessage, false);
            resolve(event.data?.data || null);
        };

        window.addEventListener("message", onMessage, false);
        window.postMessage({ type: "GET_PLAY_INFO" }, "*");
    });
}

async function waitForConfirmedRouteCid(targetBvid, timeoutMs = 7000) {
    const expectedBvid = normalizeBvidCase(targetBvid || "");
    if (!expectedBvid) return 0;
    const deadline = Date.now() + Math.max(500, Number(timeoutMs || 0));
    while (Date.now() < deadline) {
        const routeBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
        if (routeBvid !== expectedBvid) return 0;
        const currentCid = getCurrentRouteCid();
        if (currentCid > 0) return currentCid;
        const incoming = normalizeIncomingPlayInfo(await requestFromInject(500));
        const incomingBvid = normalizeBvidCase(incoming?._bvid || "");
        const incomingCid = Number(incoming?._cid || 0);
        if (incoming && incomingBvid === expectedBvid && incomingCid > 0) {
            acceptConfirmedRouteCid(expectedBvid, incomingCid, "asr_cid_wait");
            appState.playInfo = incoming;
            appState.playInfoUpdatedAt = Date.now();
            appState.isPlayInfoReady = hasUsablePlayInfoForBvid(incoming, expectedBvid);
            return incomingCid;
        }
        await sleep(100);
    }
    return 0;
}

async function waitForAlignedPlayInfo(targetBvid, targetCid = 0) {
    const expectedBvid = normalizeBvidCase(targetBvid || "");
    const expectedCid = Number(targetCid || 0);
    if (!expectedBvid) return null;
    logContent.info("playinfo_received", { source: "route_wait_start", bvid: expectedBvid });

    const freshData = await new Promise((resolve) => {
            const waiter = {
                bvid: expectedBvid,
                cid: expectedCid,
                resolve,
                timer: null
            };
            waiter.timer = setTimeout(() => {
                playInfoWaiters.delete(waiter);
                resolve(null);
            }, 7000);
            playInfoWaiters.add(waiter);
            window.postMessage({ type: "GET_PLAY_INFO" }, "*");
        });

    if (freshData && normalizeBvidCase(getBvidFromUrl(location.href) || "") === expectedBvid) {
        appState.playInfo = freshData;
        appState.playInfoUpdatedAt = Date.now();
        appState.isPlayInfoReady = true;
        logContent.info("playinfo_received", { source: "route_wait_ready", bvid: expectedBvid });
        return appState.playInfo;
    }

    appState.isPlayInfoReady = false;
    logContent.warn("playinfo_received", { source: "route_wait_timeout", bvid: expectedBvid });
    return null;
}

function resolvePlayInfoWaiters(info) {
    const normalized = normalizeIncomingPlayInfo(info);
    for (const waiter of [...playInfoWaiters]) {
        if (!hasUsablePlayInfoForBvid(normalized, waiter.bvid)) continue;
        if (Number(waiter.cid || 0) > 0 && Number(normalized?._cid || 0) !== Number(waiter.cid)) continue;
        clearTimeout(waiter.timer);
        playInfoWaiters.delete(waiter);
        waiter.resolve(normalized);
    }
}

function isAsrPlayInfoFreshForBvid(info, targetBvid, targetCid = 0) {
    const expectedBvid = normalizeBvidCase(targetBvid || "");
    const expectedCid = Number(targetCid || 0);
    const normalized = normalizeIncomingPlayInfo(info);
    if (!hasUsablePlayInfoForBvid(normalized, expectedBvid)) return false;
    if (!(expectedCid > 0) || Number(normalized?._cid || 0) !== expectedCid) return false;
    return true;
}

async function ensureAsrPlayInfoForBvid(targetBvid, targetCid = getCurrentRouteCid()) {
    const expectedBvid = normalizeBvidCase(targetBvid || "");
    const expectedCid = Number(targetCid || 0);
    if (!expectedBvid || !(expectedCid > 0)) return null;
    if (isAsrPlayInfoFreshForBvid(appState.playInfo, expectedBvid, expectedCid)) {
        return appState.playInfo;
    }
    clearStreamCache();
    const fresh = await waitForAlignedPlayInfo(expectedBvid, expectedCid);
    if (isAsrPlayInfoFreshForBvid(fresh, expectedBvid, expectedCid)) {
        return fresh;
    }
    logContent.warn("asr_playinfo_not_fresh", {
        task: "asr",
        bvid: expectedBvid,
        code: "ASR_PLAYINFO_NOT_FRESH",
        detail: {
            playinfo_bvid: normalizeBvidCase(fresh?._bvid || appState.playInfo?._bvid || ""),
            playinfo_source: String(fresh?._source || appState.playInfo?._source || ""),
            playinfo_age_ms: Math.max(0, Date.now() - Number(fresh?._ts || appState.playInfo?._ts || 0))
        }
    });
    return null;
}

function scheduleTranscriptionAvailabilityCheck(source) {
    if (appState.subtitleFallbackTimer) {
        clearTimeout(appState.subtitleFallbackTimer);
        appState.subtitleFallbackTimer = null;
    }
    const marker = Date.now();
    appState.subtitleFallbackTimer = setTimeout(() => {
        if (appState.lastSubtitleForwardAt >= marker) return;
        logContent.warn("subtitle_detected", { source: "fallback_trigger", reason: source });
        evaluateSubtitleFallback();
    }, 2000);
}

async function forwardSubtitlePayload(payload, source) {
    const bvid = String(payload?.bvid || "").trim();
    const cid = Number(payload?.cid || 0);
    if (!bvid) return;
    logSubtitleDiagnostic("source_forwarded", {
        source: source || "forwardSubtitlePayload",
        bvid,
        p: String(payload?.p || payload?.tid || ""),
        cid,
        subtitleUrl: String(payload?.subtitleUrl || ""),
        ...getSubtitleDiagnosticRowsMeta(payload?.subtitle)
    });
    const injectBefore = normalizeBvidCase(appState.injectBvid || "");
    appState.injectBvid = bvid;
    if (normalizeBvidCase(appState.injectBvid || "") !== injectBefore) {
        appState.injectBvidChangedAt = Date.now();
        startSubtitleCheckTimer();
    }
    appState.injectCid = Number.isFinite(cid) && cid > 0 ? cid : appState.injectCid;
    try {
        const res = await chrome.runtime.sendMessage({ action: "SUBTITLE_CAPTURED", payload: { ...payload, bvid, cid: appState.injectCid || 0 } });
        if (!res?.ok) throw new Error(res?.error || "转发字幕失败");
        appState.pendingSubtitle = null;
        appState.subtitleCapturedBvid = bvid;
        appState.lastSubtitleForwardAt = Date.now();
        pushSubtitleTimeline("subtitle_forwarded", {
            source,
            bvid,
            cid: appState.injectCid || 0,
            count: Array.isArray(payload.subtitle) ? payload.subtitle.length : 0
        });
        logContent.info("subtitle_detected", { bvid, cid: appState.injectCid || 0, count: Array.isArray(payload.subtitle) ? payload.subtitle.length : 0, source });
    } catch (error) {
        pushSubtitleTimeline("subtitle_forward_error", { source, bvid, error: error.message || "转发字幕失败" });
        logContent.error("task_abort", {
            task: "subtitle_forward",
            bvid,
            code: error?.code || "SUBTITLE_FORWARD_FAILED",
            detail: {
                source,
                error_message: error.message || "转发字幕失败"
            }
        });
        reportContentError?.(error, { task: "subtitle_forward", source });
    }
}

function flushPendingSubtitleIfReady() {
    if (!appState.pendingSubtitle) return;
    const resolvedBvid = resolveCurrentBvid();
    if (!resolvedBvid) return;
    const payload = {
        ...appState.pendingSubtitle,
        bvid: String(appState.pendingSubtitle.bvid || resolvedBvid).trim() || resolvedBvid
    };
    if (!payload.bvid) return;
    pushSubtitleTimeline("pending_flush", { bvid: payload.bvid });
    forwardSubtitlePayload(payload, "pending_flush");
}

async function syncActiveCacheByBvid(expectedBvid) {
    const target = normalizeBvidCase(expectedBvid);
    if (!target) return;
    try {
        const res = await chrome.storage.local.get([`cache_${target}`]);
        if (normalizeBvidCase(appState.tabState?.activeBvid || "") !== target) return;
        const directory = res?.[`cache_${target}`] || null;
        const nextCache = selectCacheDirectoryPart(directory, target, getCurrentRouteCid());
        appState.cache = nextCache && normalizeBvidCase(nextCache?.bvid || "") === target && isCacheForCurrentRouteVideo(nextCache, target) ? nextCache : null;
        applyCacheSubtitleState(appState.cache, target);
        if (hasUsableSubtitleCache(appState.cache, target)) {
            appState.subtitleCapturedBvid = target;
            if (!isTranscriptionRunning()) {
                appState.transcriptionCapsuleVisible = false;
                appState.transcriptionCapsuleMeta = null;
            }
            const source = String(appState.cache?.subtitleSource || appState.tabState?.subtitleSource || "").toLowerCase();
            if (!["groq", "whisper", "siliconflow", "funasr", "mimo", "custom_asr"].includes(source)) {
                refreshSubtitleOptionsForCurrentVideo()
                    .then((options) => {
                        if (Array.isArray(options) && options.length > 1 && appState.activePage === "CC") renderContent();
                    })
                    .catch(() => {});
            }
        }
        appState.isStateDirty = false;
        renderContent();
    } catch (_) {}
}

function hasSubtitleCacheForBvid(targetBvid) {
    return hasUsableSubtitleCache(appState.cache, targetBvid);
}

function reconcileTranscriptionState(targetBvid) {
    const target = normalizeBvidCase(targetBvid || getStableCurrentBvid() || "");
    const hasSubtitle = hasSubtitleCacheForBvid(target);
    if (hasSubtitle) {
        if (appState.asrRequestDispatched && (isAsrSessionActiveForCurrent(target)
            || (normalizeBvidCase(getTranscriptionBvid() || "") === target && isTranscriptionRunning()))) {
            chrome.runtime.sendMessage({ action: "ABORT_TRANSCRIPTION", bvid: target }).catch(() => {});
            logContent.info("asr_existing_subtitle_abort", {
                task: "asr",
                bvid: target,
                detail: { reason: "usable_subtitle_cache_arrived" }
            });
        }
        clearAsrSession();
        resetTranscriptionState({ phase: "done", progress: 100 });
        appState.transcriptionCapsuleVisible = false;
        appState.transcriptionCapsuleMeta = null;
        return;
    }
    if (isAsrSessionActiveForCurrent(target)) {
        const session = updateAsrSession({ bvid: target });
        patchTranscriptionState({
            phase: "running",
            bvid: session.bvid || target,
            progress: Number(session.progress || 0),
            statusText: session.statusText || getTranscriptionState().statusText || "正在转录音轨..."
        });
        return;
    }
    const requestBvid = getTranscriptionBvid();
    const subtitleSource = String(appState.tabState?.subtitleSource || "");
    const localState = getTranscriptionState();
    const stateProgress = Math.max(0, Math.min(100, Number(appState.tabState?.transcriptionProgress ?? 0)));
    const localProgress = Math.max(0, Math.min(100, Number(localState.progress ?? 0)));
    const progress = localState.phase === "running" ? Math.max(stateProgress, localProgress) : Math.max(stateProgress, localProgress);
    const sameTask = !!(target && requestBvid && target === requestBvid);

    const isAsrSubtitle = subtitleSource === "groq" || subtitleSource === "whisper" || subtitleSource === "siliconflow" || subtitleSource === "funasr" || subtitleSource === "mimo" || subtitleSource === "custom_asr";
    const shouldKeepRunning = localState.phase === "running" || (sameTask && isAsrSubtitle && progress > 0 && progress < 100);
    patchTranscriptionState({
        phase: shouldKeepRunning ? "running" : localState.phase,
        bvid: shouldKeepRunning && target ? target : localState.bvid,
        progress
    });
    if (!shouldKeepRunning && localState.phase === "running") {
        resetTranscriptionState();
    }
}

async function syncCacheFromBackground(bvid, options = {}) {
    const target = normalizeBvidCase(bvid || getBvidFromUrl(location.href) || "");
    if (!target) return;
    const requestedCid = getCurrentRouteCid();
    if (!(requestedCid > 0)) {
        logPartScopeDiagnostic("cache_request_deferred", {
            requestedBvid: target.toLowerCase(),
            reason: "route_cid_pending"
        }, `cache-deferred:${target}`);
        return false;
    }
    const now = Date.now();
    if (options.force !== true && !appState.isStateDirty && appState.lastCacheSyncBvid === target && now - Number(appState.lastCacheSyncTime || 0) < CACHE_SYNC_THROTTLE_MS) {
        return;
    }
    try {
        appState.lastCacheSyncTime = now;
        appState.lastCacheSyncBvid = target;
        const res = await chrome.runtime.sendMessage({
            action: "GET_CACHE",
            bvid: target,
            cid: requestedCid,
            tid: getTidFromUrl(location.href),
            partCount: getCurrentRoutePartCount(),
            skipCloud: options.skipCloud !== false
        });
        if (!res?.ok) return;
        if (res.cloudCachePrefs) appState.cloudCachePrefs = normalizeCloudCachePrefs(res.cloudCachePrefs);
        const routeBvid = normalizeBvidCase(getBvidFromUrl(location.href));
        if (routeBvid && routeBvid !== target) return;
        const cache = res.cache || null;
        logPartScopeDiagnostic("cache_response_received", {
            requestedBvid: target.toLowerCase(),
            requestedCid,
            returnedBvid: normalizeBvidCase(cache?.bvid || "").toLowerCase(),
            returnedCid: Number(cache?.cid || 0),
            returnedTid: String(cache?.tid || ""),
            responseHasSummary: !!String(cache?.summary || "").trim(),
            responseSegmentsCount: Array.isArray(cache?.segments) ? cache.segments.length : 0,
            responseHasRumors: !!cache?.rumors,
            responseHistoryCount: Array.isArray(cache?.history) ? cache.history.length : 0
        }, `cache-response:${target}:${requestedCid}`);
        if (!cache || normalizeBvidCase(cache?.bvid || "") !== target || !isCacheForCurrentRouteVideo(cache, target)) {
            logPartScopeDiagnostic("cache_response_rejected", {
                requestedBvid: target.toLowerCase(),
                requestedCid,
                returnedBvid: normalizeBvidCase(cache?.bvid || "").toLowerCase(),
                returnedCid: Number(cache?.cid || 0),
                returnedTid: String(cache?.tid || ""),
                reason: !cache
                    ? "empty_cache"
                    : normalizeBvidCase(cache?.bvid || "") !== target
                        ? "bvid_mismatch"
                        : "route_identity_mismatch"
            });
            if (options.preserveCacheOnMiss !== true) {
                appState.cache = null;
            }
            reconcileTranscriptionState(target);
            appState.isStateDirty = false;
            renderContent();
            if (shouldAttemptCloudReadForVideo(target)) {
                startCloudReadForCurrentVideo({ bvid: target, silent: true });
            }
            return false;
        }
        appState.cache = cache;
        logPartScopeDiagnostic("cache_response_accepted", {
            requestedBvid: target.toLowerCase(),
            requestedCid,
            selectedCid: Number(cache?.cid || 0),
            selectedTid: String(cache?.tid || "")
        });
        if (res.tabState) mergeIncomingTabState(res.tabState);
        applyCacheSubtitleState(cache, target);
        appState.subtitleCapturedBvid = target;
        reconcileTranscriptionState(target);
        appState.isStateDirty = false;
        renderContent();
        if (shouldAttemptCloudReadForVideo(target)) {
            startCloudReadForCurrentVideo({ bvid: target, silent: true });
        }
        return true;
    } catch (_) {}
    return false;
}

async function syncCacheFromBackgroundWithRetry(bvid, attempts = 6, delayMs = 250, options = {}) {
    const target = normalizeBvidCase(bvid || "");
    if (!target) return false;
    for (let i = 0; i < attempts; i++) {
        const ok = await syncCacheFromBackground(target, {
            preserveCacheOnMiss: true,
            force: true,
            skipCloud: options.skipCloud !== false
        });
        if (ok && hasSubtitleCacheForBvid(target)) {
            return true;
        }
        if (i < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    reconcileTranscriptionState(target);
    renderContent();
    return false;
}

function onSidePanelMessage(message, sender, sendResponse) {
    if (String(message?.action || "") !== "SIDE_PANEL_CONTENT_ACTION") return false;
    const command = String(message?.command || "");
    Promise.resolve().then(async () => {
        if (command === "seek") {
            jumpTo(Number(message?.time || 0));
            return {};
        }
        if (command === "transcribe") {
            await startTranscriptionFromCapsule();
            return {};
        }
        if (command === "retranscribe") {
            await handleRegenerateGroqSubtitle();
            return {};
        }
        if (command === "get-subtitle-options") {
            const options = await refreshSubtitleOptionsForCurrentVideo({ allowDomOpen: true }).catch(() => getOfficialSubtitleOptionsForCurrentVideo());
            return {
                options,
                activeId: String(appState.activeSubtitleId || appState.cache?.subtitleLanguage || ""),
                source: String(appState.cache?.subtitleSource || appState.tabState?.subtitleSource || "")
            };
        }
        if (command === "switch-subtitle-language") {
            await switchOfficialSubtitleLanguage(message?.languageId);
            return {};
        }
        if (command === "download-video") {
            throw new Error("请在侧边栏选择视频清晰度");
        }
        if (command === "download-audio") {
            throw new Error("请在侧边栏选择音频流");
        }
        if (command === "get-streams") {
            const bvid = normalizeBvidCase(resolveCurrentBvid() || "");
            const info = await refreshPlayInfoNow(7000).catch(() => null);
            if (!hasUsablePlayInfoForBvid(info, bvid)) {
                throw new Error("暂未拿到可用媒体流，请稍后重试");
            }
            return {
                title: cleanBilibiliTitle(document.title),
                video: Array.isArray(info?.video) ? info.video : [],
                audio: Array.isArray(info?.audio) ? info.audio : []
            };
        }
        if (command === "prepare-download") {
            const kind = String(message?.kind || "");
            const groupIndex = Number(message?.groupIndex || 0);
            const streamIndex = Number(message?.streamIndex || 0);
            const info = await refreshPlayInfoNow(7000, { force: true }).catch(() => null);
            const stream = kind === "video"
                ? info?.video?.[groupIndex]?.streams?.[streamIndex]
                : info?.audio?.[streamIndex];
            if (!stream) throw new Error("媒体流已变化，请重新打开下载菜单");
            const url = await pickVerifiedDownloadUrl(stream);
            if (!url) throw new Error("下载链接不可用，请刷新后重试");
            const title = sanitizeDownloadFileName(cleanBilibiliTitle(document.title));
            const desc = String(kind === "video" ? info?.video?.[groupIndex]?.desc || "" : stream?.desc || "").trim();
            return {
                url,
                filename: `${title}${desc ? `_${desc}` : ""}.${kind === "video" ? "mp4" : "m4a"}`
            };
        }
        if (command === "refresh-cache") {
            await syncCacheFromBackground(resolveCurrentBvid(), {
                preserveCacheOnMiss: true,
                force: true,
                skipCloud: false
            });
            return {};
        }
        if (command === "open-setup-guide") {
            showSetupGuide();
            return {};
        }
        if (command === "switch-to-embedded") {
            setEmbeddedPanelVisible(true);
            const root = document.getElementById("__bili_ai_plugin_root__");
            root?.scrollIntoView({ behavior: "smooth", block: "start" });
            return {};
        }
        if (command === "set-embedded-visible") {
            setEmbeddedPanelVisible(message?.visible !== false);
            return {};
        }
        if (command === "get-playback-state") {
            const video = document.querySelector("video");
            return {
                currentTime: video ? Number(video.currentTime) : null,
                paused: video ? !!video.paused : true
            };
        }
        if (command === "get-settings-ui-options") {
            const providers = { ...(appState.providers || {}) };
            return {
                providerModels: Object.fromEntries(Object.keys(providers).map((key) => [key, getProviderModelOptions(key)])),
                freeQuotaProviders: ["gemini", "modelscope", "openrouter"]
            };
        }
        throw new Error("未知侧边栏操作");
    }).then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || "操作失败" }));
    return true;
}

function onBackgroundMessage(message) {
    const action = String(message?.action || "");
    if (action === "REMOTE_CONFIG_UPDATED") {
        refreshRemoteConfigView().catch(() => {});
        return false;
    }
    if (action === "SHOW_TOAST") {
        const text = String(message?.text || message?.message || "").trim();
        if (text) showToast(text);
        return false;
    }
    if (action === "TRANSCRIBE_STATUS") {
        const messageBvid = normalizeBvidCase(message?.bvid || "");
        const currentBvid = normalizeBvidCase(getStableCurrentBvid() || appState.injectBvid || "");
        logAsrUiTrace("transcribe_status_received", {
            stage: String(message?.stage || ""),
            level: String(message?.level || ""),
            bvid: messageBvid,
            current_bvid: currentBvid,
            progress: Number(message?.progress || 0),
            text: String(message?.text || ""),
            session: {
                active: !!appState.asrSession?.active,
                bvid: appState.asrSession?.bvid || "",
                stage: appState.asrSession?.stage || "",
                progress: Number(appState.asrSession?.progress || 0)
            }
        });

        if (messageBvid && currentBvid && messageBvid !== currentBvid) {
            logContent.warn("transcription_stale_message_drop", {
                task: "asr",
                bvid: messageBvid,
                detail: { current_bvid: currentBvid, stage: message?.stage || "" }
            });
            return false;
        }
        const activeTranscribeBvid = messageBvid || normalizeBvidCase(getTranscriptionBvid() || appState.injectBvid || currentBvid || "unknown");
        const progressTaskId = `transcribe:${activeTranscribeBvid}`;

        const text = String(message?.text || "").trim();
        const quotaLine = String(message?.quotaLine || "").trim();
        const isError = message?.level === "error";
        
        if (text) {
            patchTranscriptionState({ statusText: text });
        }
        if (String(message?.code || "") === "ASR_RATE_LIMIT" || /限流|rate limit/i.test(text)) {
            appState.asrRateLimitRetryAfterSec = Math.max(0, Number(message?.retryAfterSec || appState.asrRateLimitRetryAfterSec || 0));
        }
        if (isError) {
            clearAsrSession();
            if (appState.tabState && typeof appState.tabState === "object") {
                appState.tabState = {
                    ...appState.tabState,
                    transcriptionProgress: 0
                };
            }
            resetTranscriptionState();
            appState.transcriptionSuppressUntil = Date.now() + 30000;
            appState.transcriptionCapsuleVisible = true;
            updateProgress(0, progressTaskId, { force: true });
            renderContent();
            renderSubtitleTimelinePanel(document.getElementById("panel-body"));
            return false;
        }
        if (message?.stage !== "done") {
            const incomingProgress = Number.isFinite(Number(message?.progress))
                ? Math.max(0, Math.min(100, Number(message.progress)))
                : undefined;
            updateAsrSession({
                active: true,
                bvid: activeTranscribeBvid,
                stage: String(message?.stage || ""),
                statusText: text || getTranscriptionState().statusText || appState.asrSession?.statusText || "正在转录音轨...",
                progress: incomingProgress
            });
            patchTranscriptionState({
                phase: "running",
                bvid: activeTranscribeBvid,
                statusText: text || getTranscriptionState().statusText,
                ...(Number.isFinite(incomingProgress) ? { progress: Math.max(Number(getTranscriptionState().progress || 0), incomingProgress) } : {})
            });
        }

        if (Number.isFinite(Number(message?.progress))) {
            const incomingProgress = Math.max(0, Math.min(100, Number(message.progress)));
            const nextState = patchTranscriptionState({ progress: incomingProgress });
            const session = updateAsrSession({ bvid: activeTranscribeBvid, progress: incomingProgress });
            const progress = Math.max(incomingProgress, Number(nextState.progress || 0), Number(session?.progress || 0));
            updateProgress(Math.max(10, progress), progressTaskId);
        } else if (isTranscriptionRunning()) {
            updateProgress(20, progressTaskId);
        }
        const retryAfterSec = Number(message?.retryAfterSec || 0);
        if (appState.transcribeCountdownTimer && retryAfterSec <= 0) {
            clearInterval(appState.transcribeCountdownTimer);
            appState.transcribeCountdownTimer = null;
        }
        if (retryAfterSec > 0) {
            appState.asrRateLimitRetryAfterSec = retryAfterSec;
            if (appState.transcribeCountdownTimer) {
                clearInterval(appState.transcribeCountdownTimer);
                appState.transcribeCountdownTimer = null;
            }
            let remain = retryAfterSec;
            appState.transcribeCountdownTimer = setInterval(() => {
                remain -= 1;
                appState.asrRateLimitRetryAfterSec = Math.max(0, remain);
                if (appState.panelErrors?.CC?.code === "ASR_RATE_LIMIT") {
                    appState.panelErrors = {
                        ...(appState.panelErrors || {}),
                        CC: mapErrorToView ? mapErrorToView({
                            code: "ASR_RATE_LIMIT",
                            message: "Groq 转录额度或频率已超限，请等待提示时间后再试，或切换到硅基流动继续生成。",
                            retryAfterSec: Math.max(0, remain)
                        }, "请求失败", {
                            provider: appState.settings?.provider || "",
                            surface: "panel"
                        }) : appState.panelErrors?.CC
                    };
                    renderContent();
                }
                if (remain <= 0) {
                    clearInterval(appState.transcribeCountdownTimer);
                    appState.transcribeCountdownTimer = null;
                    appState.asrRateLimitRetryAfterSec = 0;
                    if (appState.panelErrors?.CC?.code === "ASR_RATE_LIMIT") {
                        appState.panelErrors = {
                            ...(appState.panelErrors || {}),
                            CC: mapErrorToView ? mapErrorToView({
                                code: "ASR_RATE_LIMIT",
                                message: "Groq 转录额度或频率已超限，请等待提示时间后再试，或切换到硅基流动继续生成。",
                                retryAfterSec: 0
                            }, "请求失败", {
                                provider: appState.settings?.provider || "",
                                surface: "panel"
                            }) : appState.panelErrors?.CC
                        };
                        renderContent();
                    }
                    showToast("可以重试转录了");
                    return;
                }
                showToast(`请等待 ${remain} 秒后重试`);
            }, 1000);
        } else if (String(message?.stage || "") === "retry_countdown") {
            appState.asrRateLimitRetryAfterSec = 0;
        }
        if (message?.stage === "done") {
            appState.asrRateLimitRetryAfterSec = 0;
            const taskBvid = normalizeBvidCase(appState.asrSession?.bvid || getTranscriptionBvid() || "");
            const currentBvid = normalizeBvidCase(appState.injectBvid || getStableCurrentBvid() || "");
            
            if (taskBvid && currentBvid && taskBvid !== currentBvid) {
                logContent.warn("transcription_stale_result_drop", {
                    task: "asr",
                    bvid: taskBvid,
                    detail: { current_bvid: currentBvid }
                });
                return false;
            }
            
            appState.isStateDirty = true;
            updateAsrSession({
                active: true,
                bvid: activeTranscribeBvid,
                stage: "done",
                progress: 100,
                statusText: "转录成功，正在加载字幕..."
            });
            patchTranscriptionState({
                phase: "running",
                bvid: activeTranscribeBvid,
                progress: 100,
                statusText: "转录成功，正在加载字幕..."
            });
            appState.transcriptionCapsuleVisible = true;
            updateProgress(95, progressTaskId);
            
            const targetBvid = normalizeBvidCase(message?.bvid || currentBvid || "");
            const finishTranscriptionDone = (ok) => {
                if (ok && hasUsableSubtitleCache(appState.cache, targetBvid)) {
                    applyCacheSubtitleState(appState.cache, targetBvid);
                    clearAsrSession();
                    resetTranscriptionState({ phase: "done", progress: 100 });
                    appState.transcriptionCapsuleVisible = false;
                    appState.transcriptionCapsuleMeta = null;
                    updateProgress(100, progressTaskId);
                } else {
                    clearAsrSession();
                    resetTranscriptionState();
                }
                renderContent();
            };
            if (hasUsableSubtitleCache(appState.cache, targetBvid)) {
                finishTranscriptionDone(true);
            } else {
                renderContent();
                syncCacheFromBackgroundWithRetry(targetBvid).then(finishTranscriptionDone);
            }
            renderSubtitleTimelinePanel(document.getElementById("panel-body"));
        }
        if (message?.stage !== "done" && message?.level !== "error") {
            const msgBvid = normalizeBvidCase(message?.bvid || "");
            const currentBvid = normalizeBvidCase(appState.injectBvid || getStableCurrentBvid() || "");
            if (!msgBvid || !currentBvid || msgBvid === currentBvid) {
                renderContent();
            }
        }
        return false;
    }
    if (action !== "SUBTITLE_READY" && action !== "UPDATE_STATE") return false;
    const payloadBvid = normalizeBvidCase(message?.bvid || "");
    const routeBvid = normalizeBvidCase(getBvidFromUrl(location.href));
    if (payloadBvid && routeBvid && payloadBvid !== routeBvid) {
        pushSubtitleTimeline("drop_mismatch_bvid_bg", { payloadBvid, currentBvid: routeBvid });
        return false;
    }
    if (message?.tabState) {
        mergeIncomingTabState(message.tabState);
        syncStepProgressByTaskState(appState.tabState);
    }
    const cache = message?.cache || null;
    if (cache && payloadBvid && normalizeBvidCase(cache?.bvid || "") !== payloadBvid) return false;
    appState.pendingSubtitle = null;
    renderNav();
    const messageCacheBvid = normalizeBvidCase(cache?.bvid || "");
    appState.cache = cache && (!routeBvid || messageCacheBvid === routeBvid) && isCacheForCurrentRouteVideo(cache, payloadBvid || routeBvid) ? cache : null;
    if (appState.cache) {
        applyCacheSubtitleState(appState.cache, payloadBvid || routeBvid);
    }
    if (cache?.rawSubtitle?.length || cache?.processedSubtitle?.length) {
        reconcileTranscriptionState(payloadBvid || routeBvid);
    }
    appState.isStateDirty = false;
    renderContent();
    return false;
}

function pushSubtitleTimeline(stage, detail) {
    const item = {
        ts: Date.now(),
        stage: String(stage || "unknown"),
        detail: detail && typeof detail === "object" ? detail : {}
    };
    appState.subtitleTimeline = [...(Array.isArray(appState.subtitleTimeline) ? appState.subtitleTimeline : []), item].slice(-40);
    renderSubtitleTimelinePanel(panelShadowRoot ? panelShadowRoot.getElementById("panel-body") : null);
}

function renderSubtitleTimelinePanel(panel) {
    if (!panel) return;
    const oldNode = panel.querySelector(".subtitle-timeline-panel");
    if (oldNode) oldNode.remove();
}

function renderTimelineRowsHtml(sourceRows, rawTerm, showCapsule) {
    const term = String(rawTerm || "").trim().toLowerCase();
    const filtered = term
        ? sourceRows.filter((item) => String(item.stage || "").toLowerCase().includes(term)
            || serializeTimelineDetail(item.detail).toLowerCase().includes(term))
        : sourceRows;
    if (!filtered.length) {
        if (term) return `<div class="subtitle-timeline-empty">未搜索到匹配字幕</div>`;
        if (showCapsule) return "";
        return `<div class="subtitle-timeline-empty">暂无字幕</div>`;
    }
    return filtered.slice(-12).reverse().map((item) => {
        const stage = highlightTimelineSearchText(String(item.stage || ""), term);
        const detail = highlightTimelineSearchText(serializeTimelineDetail(item.detail), term);
        return `<div class="subtitle-timeline-row"><span class="subtitle-timeline-time">${formatTimelineTime(item.ts)}</span><span class="subtitle-timeline-stage">${stage}</span><span class="subtitle-timeline-detail">${detail}</span></div>`;
    }).join("");
}

function highlightTimelineSearchText(text, term) {
    const safeText = escapeHtml(String(text || ""));
    if (!term) return safeText;
    return safeText.replace(new RegExp(escapeRegExp(term), "ig"), (match) => `<mark class="timeline-search-hit">${match}</mark>`);
}

function toggleExportMenu(buttonNode) {
    const existing = panelShadowRoot ? panelShadowRoot.getElementById("export-option-menu") : null;
    if (existing) {
        if (existing.dataset.streamLoading === "1") {
            return;
        }
        closeExportMenu();
        return;
    }
    
    const overlay = document.createElement("div");
    overlay.id = "export-option-menu";
    overlay.className = "copy-menu-overlay";
    overlay.dataset.theme = resolveThemeMode();
    
    const menu = document.createElement("div");
    menu.className = "copy-option-menu export-menu";
    overlay.appendChild(menu);
    
    renderExportMainMenu(menu);
    
    const rect = buttonNode?.getBoundingClientRect?.();
    const container = panelShadowRoot ? panelShadowRoot.querySelector(".ai-summary-plugin-box") : null;
    
    if (rect && container) {
        const containerRect = container.getBoundingClientRect();
        // Position relative to container
        // Place to the right of the button
        let left = rect.right - containerRect.left + 8;
        // Calculate bottom position: button top relative to container
        // We want the menu's bottom to be at the button's top
        // But since we use absolute positioning with 'bottom', we need distance from container bottom
        
        // Let's use 'bottom' style instead of 'top'
        // Distance from container bottom to button top
        let bottom = containerRect.bottom - rect.top + 5;
        
        // Boundary checks (basic)
        if (left + 200 > containerRect.width) {
            left = rect.left - containerRect.left - 200; // Flip to left if no space
        }
        
        menu.style.position = "absolute";
        menu.style.left = `${left}px`;
        menu.style.bottom = `${bottom}px`;
        menu.style.top = "auto"; // Unset top
    }
    
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeExportMenu();
    });
    
    if (container) {
        container.appendChild(overlay);
        setNavActionActive("export", 0);
    }
}

function renderExportLoadingState(menuContainer, type) {
    if (!menuContainer) return;
    const title = type === "audio" ? "正在获取音频流..." : "正在获取视频流...";
    menuContainer.dataset.streamLoading = type === "audio" ? "audio" : "video";
    menuContainer.innerHTML = `
        <div class="quality-list-header" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #eee;margin-bottom:4px;">
            <button class="back-btn" style="border:none;background:none;cursor:pointer;font-size:16px;padding:0 4px;">←</button>
            <span style="font-size:13px;font-weight:600;">${title}</span>
        </div>
        <div class="quality-list-body" style="padding:18px 16px 16px;color:#61666d;font-size:13px;line-height:1.7;">
            正在拉取当前视频的最新播放地址，请稍候...
        </div>
    `;
    menuContainer.querySelector(".back-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        menuContainer.dataset.streamLoading = "";
        renderExportMainMenu(menuContainer);
    });
}

function renderExportMainMenu(menuContainer) {
    if (!menuContainer) return;
    menuContainer.dataset.streamLoading = "";
    const pageBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
    const downloadReady = hasUsablePlayInfoForBvid(appState.playInfo, pageBvid);
    appState.isPlayInfoReady = downloadReady;
    const downloadVideoLabel = "下载视频";
    const downloadAudioLabel = "下载音频";
    menuContainer.innerHTML = `
        <button type="button" class="copy-option-btn" data-action="download-video">${downloadVideoLabel}</button>
        <button type="button" class="copy-option-btn" data-action="download-audio">${downloadAudioLabel}</button>
        <div class="menu-divider" style="height:1px;background:#eee;margin:4px 0;"></div>
        <button type="button" class="copy-option-btn" data-action="export-srt">导出字幕 (SRT)</button>
    `;
    
    menuContainer.querySelector('[data-action="export-srt"]').addEventListener("click", () => {
        closeExportMenu();
        handleExportSrt();
    });
    
    menuContainer.querySelector('[data-action="download-video"]').addEventListener("click", async (e) => {
        e.stopPropagation();
        renderVideoDownloadModeMenu(menuContainer);
    });

    menuContainer.querySelector('[data-action="download-audio"]').addEventListener("click", async (e) => {
        e.stopPropagation();
        await renderCompatQualityList(menuContainer, "audio");
    });
}

async function refreshRemoteConfigView() {
    const response = await chrome.runtime.sendMessage({ action: "GET_SETTINGS" });
    if (!response?.ok) return;
    appState.settings = response.settings || appState.settings;
    appState.providers = response.providers || appState.providers;
    renderApp();
    if (appState.activePage === "settings") showToast("远程模型与功能配置已更新");
}

function renderVideoDownloadModeMenu(menuContainer) {
    if (!menuContainer) return;
    menuContainer.dataset.streamLoading = "";
    menuContainer.innerHTML = `
        <div class="quality-list-header" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #eee;margin-bottom:4px;">
            <button class="back-btn" style="border:none;background:none;cursor:pointer;font-size:16px;padding:0 4px;">←</button>
            <span style="font-size:13px;font-weight:600;">选择下载方式</span>
        </div>
        <div class="download-mode-list">
            <button type="button" class="download-mode-option" data-download-mode="quality">
                <span class="download-mode-copy">
                    <strong>高清下载</strong>
                    <small>高清 DASH 视频，可选编码，音频需单独下载</small>
                </span>
                <span class="download-mode-arrow">›</span>
            </button>
            <button type="button" class="download-mode-option" data-download-mode="compat">
                <span class="download-mode-copy">
                    <strong>兼容下载</strong>
                    <small>单文件 MP4，兼容性更好，通常最高 720P</small>
                </span>
                <span class="download-mode-arrow">›</span>
            </button>
        </div>
    `;
    menuContainer.querySelector(".back-btn")?.addEventListener("click", (event) => {
        event.stopPropagation();
        renderExportMainMenu(menuContainer);
    });
    menuContainer.querySelector('[data-download-mode="quality"]')?.addEventListener("click", async (event) => {
        event.stopPropagation();
        renderExportLoadingState(menuContainer, "video");
        const info = await refreshPlayInfoNow(7000, { force: true }).catch(() => null);
        const pageBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
        if (!hasUsablePlayInfoForBvid(info, pageBvid)) {
            showToast("暂未拿到可用高清视频流，请稍后重试");
            renderVideoDownloadModeMenu(menuContainer);
            return;
        }
        renderQualityList(menuContainer, "video");
    });
    menuContainer.querySelector('[data-download-mode="compat"]')?.addEventListener("click", async (event) => {
        event.stopPropagation();
        await renderCompatQualityList(menuContainer, "video");
    });
}

function renderDownloadPreviousMenu(menuContainer, type) {
    if (type === "video") {
        renderVideoDownloadModeMenu(menuContainer);
        return;
    }
    renderExportMainMenu(menuContainer);
}

async function probeUrlInPage(url) {
    try {
        const res = await chrome.runtime.sendMessage({ action: "PROBE_URL", payload: { url } });
        return res?.status || "unknown";
    } catch (_) {
        return "unknown";
    }
}

async function requestStreamDownload(url, filename) {
    const response = await chrome.runtime.sendMessage({
        action: "DOWNLOAD_STREAM",
        payload: { url, filename }
    });
    if (!response?.ok) throw new Error(response?.error || "创建下载任务失败");
    return response;
}

function getStreamCandidateUrls(stream) {
    const urls = Array.isArray(stream?.urls) ? stream.urls : [];
    return [...urls, stream?.url]
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .filter((item, index, list) => list.indexOf(item) === index)
        .map((url, index) => ({ url, index, priority: getDirectDownloadHostPriority(url) }))
        .sort((left, right) => left.priority - right.priority || left.index - right.index)
        .map((item) => item.url);
}

function getDirectDownloadHostPriority(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (host.endsWith("akamaized.net") || host.includes("mirrorakam")) return 0;
        if (host.includes("mirrorcosov")) return 2;
    } catch (_) {}
    return 1;
}

async function pickVerifiedDownloadUrl(stream) {
    const candidates = getStreamCandidateUrls(stream);
    let unknownCandidate = "";
    for (const url of candidates) {
        const status = await probeUrlInPage(url);
        if (status === "ok") return url;
        if (status === "unknown" && !unknownCandidate) unknownCandidate = url;
    }
    return unknownCandidate;
}

function buildCompatIdentityPayload(type, qn) {
    return {
        type,
        qn: Number(qn || 0) || undefined,
        bvid: normalizeBvidCase(resolveCurrentBvid() || getBvidFromUrl(location.href) || ""),
        cid: Number(resolveCid() || 0),
        tid: appState.tabState?.activeTid || getTidFromUrl(location.href),
        title: cleanBilibiliTitle(document.title)
    };
}

async function fetchCompatPlayUrl(type, qn = 0) {
    const response = await chrome.runtime.sendMessage({
        action: "GET_COMPAT_PLAYURL",
        payload: buildCompatIdentityPayload(type, qn)
    });
    if (!response?.ok) throw new Error(response?.error || "获取兼容下载链接失败");
    return response;
}

async function renderCompatQualityList(menuContainer, type) {
    if (!menuContainer) return;
    if (!chrome.runtime?.id) {
        showToast("下载链接已经失效，请刷新页面后重试");
        return;
    }
    renderExportLoadingState(menuContainer, type);
    const pageBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
    let compat;
    try {
        compat = await fetchCompatPlayUrl(type);
    } catch (error) {
        logDownload.error("download_compat_playurl_failed", {
            task: "download",
            bvid: pageBvid,
            code: error?.code || "DOWNLOAD_COMPAT_PLAYURL_FAILED",
            detail: { type, reason: error?.message || "获取兼容下载链接失败" }
        });
        notifyMappedError(error, "获取兼容下载链接失败: " + (error.message || ""));
        renderDownloadPreviousMenu(menuContainer, type);
        return;
    }
    const title = type === "video" ? "选择清晰度" : "选择音频";
    const bodyHtml = type === "video"
        ? (Array.isArray(compat.qualities) ? compat.qualities : []).map((item) => `
            <div class="quality-item" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;gap:12px;border-bottom:1px solid #f1f2f3;">
                <span class="quality-desc" style="font-size:13px;">${escapeHtml(item.desc || "")}</span>
                <button class="compat-video-download-btn" data-qn="${Number(item.quality || 0)}"
                   style="font-size:12px;padding:4px 10px;border:1px solid #fb7299;color:#fff;background:#fb7299;border-radius:4px;cursor:pointer;">
                   下载
                </button>
            </div>
        `).join("")
        : (Array.isArray(compat.streams) ? compat.streams : []).map((item, index) => `
            <div class="quality-item" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;gap:12px;border-bottom:1px solid #f1f2f3;">
                <span class="quality-desc" style="font-size:13px;">${escapeHtml(item.desc || "音频")}</span>
                <button class="compat-audio-download-btn" data-index="${index}"
                   style="font-size:12px;padding:4px 10px;border:1px solid #fb7299;color:#fff;background:#fb7299;border-radius:4px;cursor:pointer;">
                   下载
                </button>
            </div>
        `).join("");

    if (!bodyHtml) {
        showToast(type === "video" ? "未找到兼容视频流" : "未找到可用音频流");
        renderDownloadPreviousMenu(menuContainer, type);
        return;
    }

    menuContainer.innerHTML = `
        <div class="quality-list-header" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #eee;margin-bottom:4px;">
            <button class="back-btn" style="border:none;background:none;cursor:pointer;font-size:16px;padding:0 4px;">←</button>
            <span style="font-size:13px;font-weight:600;">${title}</span>
            <span style="font-size:11px;color:#9499a0;">兼容模式</span>
        </div>
        <div class="quality-list-body" style="max-height:300px;overflow-y:auto;padding-top:4px;">
            ${bodyHtml}
        </div>
    `;
    menuContainer.querySelector(".back-btn")?.addEventListener("click", (e) => {
        e.stopPropagation();
        renderDownloadPreviousMenu(menuContainer, type);
    });

    menuContainer.querySelectorAll(".compat-video-download-btn").forEach((btn) => {
        btn.addEventListener("click", async (event) => {
            event.stopPropagation();
            const qn = Number(btn.dataset.qn || 0);
            const originalText = btn.textContent;
            btn.textContent = "准备中...";
            btn.disabled = true;
            try {
                const startedAt = Date.now();
                const fresh = await fetchCompatPlayUrl("video", qn);
                const stream = fresh?.stream || null;
                if (!stream?.url) throw new Error("未获取到该清晰度的 MP4 下载链接");
                const urlToDownload = await pickVerifiedDownloadUrl(stream) || stream.url;
                const safeTitle = sanitizeDownloadFileName(cleanBilibiliTitle(document.title));
                const filename = `${safeTitle}_${stream.desc || qn}_兼容.mp4`;
                logDownload.info("download_url_prepare_success", {
                    task: "download",
                    bvid: pageBvid,
                    duration_ms: Date.now() - startedAt,
                    detail: {
                        asset_type: "video",
                        download_mode: "compat_mp4",
                        quality: stream.desc || "",
                        quality_id: Number(stream.quality || qn || 0),
                        has_url: !!urlToDownload,
                        file_ext: "mp4"
                    }
                });
                await requestStreamDownload(urlToDownload, filename);
                showToast("下载已触发，请查看浏览器下载");
            } catch (error) {
                logDownload.error("download_url_prepare_failed", {
                    task: "download",
                    bvid: pageBvid,
                    code: error?.code || "DOWNLOAD_COMPAT_FAILED",
                    detail: {
                        asset_type: "video",
                        download_mode: "compat_mp4",
                        quality_id: qn,
                        reason: error.message || "下载失败"
                    }
                });
                notifyMappedError(error, "下载失败: " + (error.message || ""));
            } finally {
                btn.textContent = originalText;
                btn.disabled = false;
            }
        });
    });

    menuContainer.querySelectorAll(".compat-audio-download-btn").forEach((btn) => {
        btn.addEventListener("click", async (event) => {
            event.stopPropagation();
            const index = Number(btn.dataset.index || 0);
            const stream = Array.isArray(compat.streams) ? compat.streams[index] : null;
            if (!stream?.url) return;
            const originalText = btn.textContent;
            btn.textContent = "准备中...";
            btn.disabled = true;
            try {
                const urlToDownload = await pickVerifiedDownloadUrl(stream) || stream.url;
                const safeTitle = sanitizeDownloadFileName(cleanBilibiliTitle(document.title));
                const filename = `${safeTitle}_${stream.desc || "音频"}.m4a`;
                await requestStreamDownload(urlToDownload, filename);
                showToast("下载已触发，请查看浏览器下载");
            } catch (error) {
                notifyMappedError(error, "下载失败: " + (error.message || ""));
            } finally {
                btn.textContent = originalText;
                btn.disabled = false;
            }
        });
    });
}

function renderQualityList(menuContainer, type) {
    if (!menuContainer) return;
    menuContainer.dataset.streamLoading = "";
    if (!chrome.runtime?.id) {
        showToast("下载链接已经失效，请刷新页面后重试");
        return;
    }
    const pageBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
    if (!hasUsablePlayInfoForBvid(appState.playInfo, pageBvid)) {
        appState.isPlayInfoReady = false;
        showToast("正在获取视频流，请稍候...");
        refreshPlayInfoNow(7000)
            .then((info) => {
                if (!hasUsablePlayInfoForBvid(info, pageBvid)) {
                    showToast("暂未拿到可用视频流，请稍后重试");
                    renderDownloadPreviousMenu(menuContainer, type);
                    return;
                }
                renderQualityList(menuContainer, type);
            })
            .catch(() => {
                showToast("暂未拿到可用视频流，请稍后重试");
                renderDownloadPreviousMenu(menuContainer, type);
            });
        return;
    }
    appState.isPlayInfoReady = true;
    const streams = appState.playInfo[type] || [];
    if (!streams.length) {
        showToast(`未找到${type === "video" ? "视频" : "音频"}流`);
        return;
    }
    
    const title = type === "video" ? "选择清晰度" : "选择音频";
    const qualityTipHtml = type === "video" ? `
            <span class="download-quality-info" aria-label="下载提示" tabindex="0"
                  style="position:relative;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:1px solid #c9ccd0;border-radius:50%;color:#9499a0;font-size:12px;line-height:1;cursor:help;">
                i
                <span class="download-quality-tooltip"
                      style="display:none;position:absolute;left:50%;top:22px;transform:translateX(-50%);z-index:10000;width:220px;padding:8px 10px;border-radius:6px;background:#2f3238;color:#fff;font-size:12px;font-weight:400;line-height:1.45;box-shadow:0 6px 18px rgba(0,0,0,0.16);">
                    请检查下载文件后缀，如为.htm请尝试其他编码或清晰度！
                </span>
            </span>` : "";
    
    // For video, streams are now grouped: { quality, desc, streams: [{codecName, url...}] }
    // For audio, it's still a flat array (unless we group audio too, but inject.js didn't change audio structure much)
    
    let listHtml = "";
    
    if (type === "video") {
        listHtml = streams.map((group, gIndex) => {
            const streamList = Array.isArray(group?.streams) ? group.streams : [];
            const firstCandidateIndex = streamList.findIndex((s) => String(s?.url || "").trim());
            const initialStreamIndex = firstCandidateIndex >= 0 ? firstCandidateIndex : 0;
            // group.streams has sub-options
            const subOptions = streamList.map((s, sIndex) => `
                <button class="codec-btn" data-group="${gIndex}" data-stream="${sIndex}" 
                   title="${escapeHtml(s.codecs || s.codecName)}"
                   style="font-size:11px;padding:3px 7px;border:1px solid #e3e8ec;background:#f6f7f8;color:#61666d;border-radius:4px;cursor:pointer;">
                   ${escapeHtml(s.codecName)}
                </button>
            `).join("");
            
            return `
                <div class="quality-group" style="padding:8px 12px;border-bottom:1px solid #f1f2f3;">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                        <span class="quality-desc" style="font-size:13px;font-weight:500;color:#18191c;">${escapeHtml(group.desc)}</span>
                        <button class="download-default-btn" data-group="${gIndex}" data-stream="${initialStreamIndex}"
                           style="font-size:12px;padding:4px 10px;border:1px solid #fb7299;color:#fff;background:#fb7299;border-radius:4px;cursor:pointer;">
                           下载
                        </button>
                    </div>
                    ${streamList.length > 1 ? `
                        <details class="download-codec-options">
                            <summary>更多编码（可选）</summary>
                            <div class="codec-list">${subOptions}</div>
                        </details>
                    ` : `<div class="codec-list" hidden>${subOptions}</div>`}
                </div>
            `;
        }).join("");
    } else {
        // Audio
        listHtml = streams.map((s, index) => `
            <div class="quality-item" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;gap:12px;border-bottom:1px solid #f1f2f3;">
                <span class="quality-desc" style="font-size:13px;">${escapeHtml(s.desc)}</span>
                <button class="download-stream-btn" data-index="${index}" 
                   style="font-size:12px;padding:4px 10px;border:1px solid #fb7299;color:#fff;background:#fb7299;border-radius:4px;cursor:pointer;">
                   下载
                </button>
            </div>
        `).join("");
    }
    
    menuContainer.innerHTML = `
        <div class="quality-list-header" style="display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid #eee;margin-bottom:4px;">
            <button class="back-btn" style="border:none;background:none;cursor:pointer;font-size:16px;padding:0 4px;">←</button>
            <span style="font-size:13px;font-weight:600;">${title}</span>
            ${qualityTipHtml}
        </div>
        <div class="quality-list-body" style="max-height:300px;overflow-y:auto;padding-top:4px;">
            <div class="download-unavailable-notice" style="display:none;margin:0 10px 8px;padding:8px 10px;border:1px solid #ffd7e5;background:#fff5f8;color:#8a4158;border-radius:6px;font-size:12px;line-height:1.45;">
                <div style="font-weight:600;margin-bottom:3px;">当前下载链接暂不可用</div>
                <div style="color:#93586a;">可能是链接过期或站点拒绝，请重新获取后再试。</div>
                <button type="button" data-action="download-retry-streams" style="margin-top:7px;border:1px solid #fb7299;background:#fb7299;color:#fff;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;">重新获取</button>
            </div>
            ${listHtml}
        </div>
    `;
    
    menuContainer.querySelector(".back-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        renderDownloadPreviousMenu(menuContainer, type);
    });
    const qualityInfo = menuContainer.querySelector(".download-quality-info");
    const qualityTooltip = qualityInfo?.querySelector(".download-quality-tooltip");
    if (qualityInfo && qualityTooltip) {
        const showQualityTip = () => { qualityTooltip.style.display = "block"; };
        const hideQualityTip = () => { qualityTooltip.style.display = "none"; };
        qualityInfo.addEventListener("mouseenter", showQualityTip);
        qualityInfo.addEventListener("mouseleave", hideQualityTip);
        qualityInfo.addEventListener("focus", showQualityTip);
        qualityInfo.addEventListener("blur", hideQualityTip);
    }
    menuContainer.querySelector('[data-action="download-retry-streams"]')?.addEventListener("click", async (e) => {
        e.stopPropagation();
        menuContainer.dataset.expiredRefreshAttempted = "";
        renderExportLoadingState(menuContainer, type);
        const info = await refreshPlayInfoNow(7000, { force: true }).catch(() => null);
        const pageBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
        if (!hasUsablePlayInfoForBvid(info, pageBvid)) {
            showToast("暂未拿到可用视频流，请稍后重试");
            renderDownloadPreviousMenu(menuContainer, type);
            return;
        }
        renderQualityList(menuContainer, type);
    });

    const isProbeTargetAlive = () => !!menuContainer && (panelShadowRoot ?? document).contains(menuContainer);
    const probeSessionId = `probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    menuContainer.dataset.probeSessionId = probeSessionId;

    const setProbePending = (btn) => {
        if (!btn) return;
        if (!btn.dataset.probeOriginalText) btn.dataset.probeOriginalText = btn.textContent || "";
        if (!btn.dataset.probeOriginalOpacity) btn.dataset.probeOriginalOpacity = btn.style.opacity || "";
        if (!btn.dataset.probeOriginalCursor) btn.dataset.probeOriginalCursor = btn.style.cursor || "";
        if (!btn.dataset.probeOriginalColor) btn.dataset.probeOriginalColor = btn.style.color || "";
        if (!btn.dataset.probeOriginalBorderColor) btn.dataset.probeOriginalBorderColor = btn.style.borderColor || "";
        if (!btn.dataset.probeOriginalBackground) btn.dataset.probeOriginalBackground = btn.style.background || "";
        btn.dataset.probeStatus = "pending";
        btn.disabled = true;
        btn.textContent = "检测中…";
        btn.style.opacity = "0.6";
        btn.style.cursor = "not-allowed";
    };

    const applyProbeState = (btn, status) => {
        if (!btn || !(panelShadowRoot ?? document).contains(btn)) return;
        const originalText = btn.dataset.probeOriginalText || "下载";
        if (status === "expired") {
            btn.dataset.probeStatus = "expired";
            btn.disabled = true;
            btn.textContent = "不可用";
            btn.style.opacity = "1";
            btn.style.cursor = "not-allowed";
            btn.style.color = "#999";
            btn.style.borderColor = "#ccc";
            btn.style.background = "#f5f5f5";
            return;
        }
        if (status === "ok") {
            btn.dataset.probeStatus = "ok";
            btn.disabled = false;
            btn.textContent = originalText;
            btn.style.opacity = btn.dataset.probeOriginalOpacity || "1";
            btn.style.cursor = "pointer";
            btn.style.color = btn.dataset.probeOriginalColor || "";
            btn.style.borderColor = btn.dataset.probeOriginalBorderColor || "";
            btn.style.background = btn.dataset.probeOriginalBackground || "";
            if (btn.classList.contains("download-default-btn") || btn.classList.contains("download-stream-btn")) {
                btn.style.opacity = "1";
                btn.style.color = "#fff";
                btn.style.borderColor = "#fb7299";
                btn.style.background = "#fb7299";
            }
            return;
        }
        btn.dataset.probeStatus = "unknown";
        btn.disabled = true;
        btn.textContent = "待刷新";
        btn.style.opacity = "1";
        btn.style.cursor = "not-allowed";
        btn.style.color = "#999";
        btn.style.borderColor = "#ccc";
        btn.style.background = "#f5f5f5";
    };

    const addProbeTarget = (urlToButtons, url, btn) => {
        const key = String(url || "").trim();
        if (!key || !btn) return;
        const list = urlToButtons.get(key) || [];
        list.push(btn);
        urlToButtons.set(key, list);
    };

    const refreshMenuWhenAllExpired = async () => {
        if (menuContainer.dataset.expiredRefreshAttempted === "1") return false;
        menuContainer.dataset.expiredRefreshAttempted = "1";
        try {
            const info = await refreshPlayInfoNow(7000, { force: true }).catch(() => null);
            const pageBvid = normalizeBvidCase(getBvidFromUrl(location.href) || "");
            if (!hasUsablePlayInfoForBvid(info, pageBvid)) {
                updateUnavailableNotice();
                return false;
            }
            renderQualityList(menuContainer, type);
            return true;
        } catch (_) {
            updateUnavailableNotice();
            return false;
        }
    };

    const hasAnyUsableButton = () => {
        const actionButtons = Array.from(menuContainer.querySelectorAll(".download-default-btn, .codec-btn, .download-stream-btn"));
        return actionButtons.some((btn) => String(btn?.dataset?.probeStatus || "") === "ok");
    };

    const updateUnavailableNotice = () => {
        const notice = menuContainer.querySelector(".download-unavailable-notice");
        if (!notice) return;
        const actionButtons = Array.from(menuContainer.querySelectorAll(".download-default-btn, .codec-btn, .download-stream-btn"));
        const hasPending = actionButtons.some((btn) => String(btn?.dataset?.probeStatus || "") === "pending");
        notice.style.display = actionButtons.length > 0 && !hasPending && !hasAnyUsableButton() ? "block" : "none";
    };

    const syncDefaultButtonState = (groupIndex) => {
        if (type !== "video") return;
        const defaultBtn = menuContainer.querySelector(`.download-default-btn[data-group="${groupIndex}"]`);
        if (!defaultBtn) return;
        const group = streams[groupIndex];
        const streamList = Array.isArray(group?.streams) ? group.streams : [];
        if (!streamList.length) {
            applyProbeState(defaultBtn, "expired");
            defaultBtn.dataset.stream = "-1";
            return;
        }
        let firstOkIndex = -1;
        let firstFallbackIndex = -1;
        let hasPending = false;
        for (let i = 0; i < streamList.length; i++) {
            const codecBtn = menuContainer.querySelector(`.codec-btn[data-group="${groupIndex}"][data-stream="${i}"]`);
            const status = String(codecBtn?.dataset?.probeStatus || "pending");
            if (status === "pending") hasPending = true;
            if (status === "ok" && firstOkIndex < 0) firstOkIndex = i;
            if (status === "ok" && firstFallbackIndex < 0) firstFallbackIndex = i;
        }
        if (firstOkIndex >= 0) {
            defaultBtn.dataset.stream = String(firstOkIndex);
            applyProbeState(defaultBtn, "ok");
            return;
        }
        if (firstFallbackIndex >= 0) {
            defaultBtn.dataset.stream = String(firstFallbackIndex);
            applyProbeState(defaultBtn, "unknown");
            return;
        }
        if (hasPending) {
            setProbePending(defaultBtn);
            return;
        }
        defaultBtn.dataset.stream = "-1";
        applyProbeState(defaultBtn, "expired");
    };

    const syncAllDefaultButtons = () => {
        if (type !== "video") return;
        const groups = appState.playInfo?.video || [];
        groups.forEach((_, gIndex) => syncDefaultButtonState(gIndex));
    };

    const collectProbeTargets = () => {
        const urlToButtons = new Map();
        if (type === "video") {
            const groups = appState.playInfo?.video || [];
            groups.forEach((group, gIndex) => {
                const streamList = Array.isArray(group?.streams) ? group.streams : [];
                streamList.forEach((stream, sIndex) => {
                    const urls = getStreamCandidateUrls(stream);
                    if (!urls.length) return;
                    const codecBtn = menuContainer.querySelector(`.codec-btn[data-group="${gIndex}"][data-stream="${sIndex}"]`);
                    urls.forEach((url) => addProbeTarget(urlToButtons, url, codecBtn));
                });
            });
            return urlToButtons;
        }
        const audioStreams = appState.playInfo?.audio || [];
        audioStreams.forEach((stream, index) => {
            const urls = getStreamCandidateUrls(stream);
            if (!urls.length) return;
            const btn = menuContainer.querySelector(`.download-stream-btn[data-index="${index}"]`);
            urls.forEach((url) => addProbeTarget(urlToButtons, url, btn));
        });
        return urlToButtons;
    };

    const pendingButtons = menuContainer.querySelectorAll(".download-default-btn, .codec-btn, .download-stream-btn");
    pendingButtons.forEach(setProbePending);
    syncAllDefaultButtons();

    const startProbeForCurrentMenu = async () => {
        if (!isProbeTargetAlive() || menuContainer.dataset.probeSessionId !== probeSessionId) return;
        const urlToButtons = collectProbeTargets();
        if (!urlToButtons.size) {
            pendingButtons.forEach((btn) => applyProbeState(btn, "unknown"));
            return;
        }

        try {
            await refreshPlayInfoNow(1500).catch(() => {});
            if (!isProbeTargetAlive() || menuContainer.dataset.probeSessionId !== probeSessionId) return;
            const freshUrlToButtons = collectProbeTargets();

            const buttonStatuses = new Map();
            const rememberStatus = (btn, status) => {
                if (!btn) return;
                const list = buttonStatuses.get(btn) || [];
                list.push(status);
                buttonStatuses.set(btn, list);
            };
            await Promise.all(
                Array.from(freshUrlToButtons.entries()).map(async ([url, btnList]) => {
                    const status = await probeUrlInPage(url);
                    if (!isProbeTargetAlive() || menuContainer.dataset.probeSessionId !== probeSessionId) return;
                    btnList.forEach((btn) => rememberStatus(btn, status));
                })
            );
            const touchedGroups = new Set();
            buttonStatuses.forEach((statuses, btn) => {
                const finalStatus = statuses.includes("ok")
                    ? "ok"
                    : statuses.every((status) => status === "expired")
                        ? "expired"
                        : "unknown";
                applyProbeState(btn, finalStatus);
                const groupIndex = Number(btn?.dataset?.group);
                if (Number.isFinite(groupIndex)) touchedGroups.add(groupIndex);
            });
            touchedGroups.forEach((gIndex) => syncDefaultButtonState(gIndex));

            pendingButtons.forEach((btn) => {
                if (btn.dataset.probeStatus === "pending") applyProbeState(btn, "unknown");
            });
            syncAllDefaultButtons();
            updateUnavailableNotice();
            if (!hasAnyUsableButton()) {
                await refreshMenuWhenAllExpired();
            }
        } catch (_) {
            if (!isProbeTargetAlive() || menuContainer.dataset.probeSessionId !== probeSessionId) return;
            pendingButtons.forEach((btn) => applyProbeState(btn, "unknown"));
            syncAllDefaultButtons();
            updateUnavailableNotice();
        }
    };

    startProbeForCurrentMenu();

    // Trigger download helper
    const triggerVideoDownload = async (btn, groupIndex, streamIndex) => {
        const group = streams[groupIndex];
        const stream = group?.streams?.[streamIndex];
        if (!stream) return;
        if (String(btn?.dataset?.probeStatus || "") !== "ok") {
            showToast("下载链接未确认有效，请刷新后重试");
            refreshMenuWhenAllExpired().catch(() => {});
            return;
        }

        logDownload.info("download_option_selected", {
            task: "download",
            bvid: getBvidFromUrl(location.href) || "",
            detail: {
                asset_type: "video",
                quality: group.desc || "",
                quality_id: Number(group.quality || 0),
                codec: stream.codecName || "",
                has_video: true,
                has_audio: true
            }
        });
        const originalText = btn.textContent;
        btn.textContent = "准备中...";
        btn.disabled = true;
        btn.style.opacity = "0.7";

        try {
            const prepareStartedAt = Date.now();
            logDownload.info("download_url_prepare_start", {
                task: "download",
                bvid: getBvidFromUrl(location.href) || "",
                detail: {
                    asset_type: "video",
                    quality: group.desc || "",
                    codec: stream.codecName || ""
                }
            });
            await refreshPlayInfoNow(7000, { force: true });
            // Re-find the matching stream from fresh data
            const freshGroups = appState.playInfo?.video || [];
            // Find group by quality
            const freshGroup = freshGroups.find(g => Number(g.quality) === Number(group.quality));
            // Find stream by codecName (best effort matching)
            const freshStream = freshGroup?.streams?.find(s => s.codecName === stream.codecName) 
                || freshGroup?.streams?.[0]; // Fallback to first if codec gone

            if (!freshStream) throw new Error("无法获取最新下载地址");
            
            const urlToDownload = await pickVerifiedDownloadUrl(freshStream);
            if (!urlToDownload) throw new Error("下载链接不可用，请刷新后重试");
            // Generate safe filename
            const currentTitle = cleanBilibiliTitle(document.title);
            const safeTitle = sanitizeDownloadFileName(currentTitle);
            const filename = `${safeTitle}_${freshGroup.desc}_${freshStream.codecName}.mp4`;
            if (!chrome.runtime?.id) {
                showToast("下载链接已经失效，请刷新页面后重试");
                return;
            }
            logDownload.info("download_url_prepare_success", {
                task: "download",
                bvid: getBvidFromUrl(location.href) || "",
                duration_ms: Date.now() - prepareStartedAt,
                detail: {
                    asset_type: "video",
                    quality: freshGroup.desc || group.desc || "",
                    codec: freshStream.codecName || "",
                    has_url: !!urlToDownload,
                    url_host: (() => { try { return new URL(urlToDownload).hostname; } catch (_) { return ""; } })(),
                    file_ext: "mp4"
                }
            });
            
            await requestStreamDownload(urlToDownload, filename);
            showToast("下载已触发，请查看浏览器下载");
        } catch (err) {
            logDownload.error("download_url_prepare_failed", {
                task: "download",
                bvid: getBvidFromUrl(location.href) || "",
                code: err?.code || "DOWNLOAD_URL_PREPARE_FAILED",
                status: Number(err?.status || 0) || 0,
                detail: {
                    asset_type: "video",
                    quality: group.desc || "",
                    codec: stream.codecName || "",
                    reason: err.message || "下载失败"
                }
            });
            notifyMappedError({ ...err, code: err?.code || "DOWNLOAD_FAILED" }, "下载失败: " + (err.message || ""));
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
            btn.style.opacity = "1";
        }
    };

    if (type === "video") {
        menuContainer.querySelectorAll(".download-default-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const groupIndex = parseInt(btn.dataset.group, 10);
                const streamIndex = parseInt(btn.dataset.stream, 10);
                if (!Number.isFinite(groupIndex) || !Number.isFinite(streamIndex) || streamIndex < 0) {
                    refreshMenuWhenAllExpired().catch(() => {});
                    return;
                }
                if (String(btn.dataset.probeStatus || "") !== "ok") {
                    showToast("下载链接未确认有效，请刷新后重试");
                    refreshMenuWhenAllExpired().catch(() => {});
                    return;
                }
                triggerVideoDownload(btn, groupIndex, streamIndex);
            });
        });
        menuContainer.querySelectorAll(".codec-btn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                if (String(btn.dataset.probeStatus || "") !== "ok") {
                    showToast("下载链接未确认有效，请刷新后重试");
                    refreshMenuWhenAllExpired().catch(() => {});
                    return;
                }
                triggerVideoDownload(btn, parseInt(btn.dataset.group), parseInt(btn.dataset.stream));
            });
        });
    } else {
        // Audio handlers (legacy flat list)
        menuContainer.querySelectorAll(".download-stream-btn").forEach(btn => {
            btn.addEventListener("click", async (e) => {
                e.stopPropagation();
                if (String(btn.dataset.probeStatus || "") !== "ok") {
                    showToast("下载链接未确认有效，请刷新后重试");
                    refreshMenuWhenAllExpired().catch(() => {});
                    return;
                }
                const index = parseInt(btn.dataset.index, 10);
                const stream = streams[index];
                if (!stream) return;
                
                const originalText = btn.textContent;
                btn.textContent = "...";
                btn.disabled = true;
                
                try {
                    const prepareStartedAt = Date.now();
                    logDownload.info("download_url_prepare_start", {
                        task: "download",
                        bvid: getBvidFromUrl(location.href) || "",
                        detail: {
                            asset_type: "audio",
                            quality: stream.desc || "",
                            codec: stream.codecName || ""
                        }
                    });
                    await refreshPlayInfoNow(7000, { force: true });
                    const freshAudio = appState.playInfo?.audio || [];
                    const freshStream = freshAudio.find(a => a.id === stream.id) || freshAudio[index];
                    
                    if (!freshStream) throw new Error("无法获取最新音频地址");
                    
                    const currentTitle = cleanBilibiliTitle(document.title);
                    const safeTitle = sanitizeDownloadFileName(currentTitle);
                    const filename = `${safeTitle}_${freshStream.desc}.m4a`;
                    if (!chrome.runtime?.id) {
                        showToast("下载链接已经失效，请刷新页面后重试");
                        return;
                    }
                    logDownload.info("download_url_prepare_success", {
                        task: "download",
                        bvid: getBvidFromUrl(location.href) || "",
                        duration_ms: Date.now() - prepareStartedAt,
                        detail: {
                            asset_type: "audio",
                            quality: freshStream.desc || "",
                            codec: freshStream.codecName || "",
                            has_url: !!freshStream.url,
                            file_ext: "m4a"
                        }
                    });
                    
                    const urlToDownload = await pickVerifiedDownloadUrl(freshStream);
                    if (!urlToDownload) throw new Error("音频下载链接不可用，请刷新后重试");
                    await requestStreamDownload(urlToDownload, filename);
                    showToast("下载已触发，请查看浏览器下载");
                } catch (err) {
                    logDownload.error("download_url_prepare_failed", {
                        task: "download",
                        bvid: getBvidFromUrl(location.href) || "",
                        code: err?.code || "DOWNLOAD_URL_PREPARE_FAILED",
                        status: Number(err?.status || 0) || 0,
                        detail: {
                            asset_type: "audio",
                            reason: err.message || "下载失败"
                        }
                    });
                    notifyMappedError({ ...err, code: err?.code || "DOWNLOAD_FAILED" }, "失败: " + (err.message || ""));
                } finally {
                    btn.textContent = originalText;
                    btn.disabled = false;
                }
            });
        });
    }
}

async function refreshPlayInfoNow(timeoutMs = 7000, options = {}) {
    const waitTimeoutMs = Math.max(6000, Number(timeoutMs) || 0);
    const forceRefresh = options?.force === true;
    const pageBvid = window.location.href.match(/BV[a-zA-Z0-9]{10}/)?.[0] || "";
    const hasUsableStream =
        appState.playInfo &&
        normalizeBvidCase(appState.playInfo._bvid) === normalizeBvidCase(pageBvid) &&
        (
            (Array.isArray(appState.playInfo.audio) && appState.playInfo.audio.length > 0) ||
            (Array.isArray(appState.playInfo.video) && appState.playInfo.video.length > 0)
        );

    if (forceRefresh || !hasUsableStream) {
        appState.playInfo = null;
        appState.isPlayInfoReady = false;
        logDownload.info("download_capture_start", {
            task: "download",
            bvid: pageBvid,
            detail: {
                source_candidates: ["window_playinfo", "inject_bridge"],
                timeout_ms: waitTimeoutMs
            }
        });
        if (!forceRefresh) window.postMessage({ type: "PLAYER_WAKE_UP" }, "*");
        window.postMessage({ type: "REFRESH_PLAYINFO" }, "*");

        const startWait = Date.now();
        while (Date.now() - startWait < waitTimeoutMs) {
            const info = await requestFromInject(400);
            const isRequestedRefresh = !forceRefresh || (
                String(info?._source || "") === "fresh_playurl"
                && Number(info?._ts || 0) >= startWait
            );
            if (isRequestedRefresh && hasUsablePlayInfoForBvid(info, pageBvid)) {
                appState.playInfo = normalizeIncomingPlayInfo(info);
                appState.playInfoUpdatedAt = Date.now();
                appState.isPlayInfoReady = true;
                logDownload.info("download_playinfo_found", {
                    task: "download",
                    bvid: pageBvid,
                    duration_ms: Date.now() - startWait,
                    detail: {
                        source: "inject_bridge",
                        playinfo_source: String(appState.playInfo?._source || ""),
                        video_stream_count: Array.isArray(appState.playInfo?.video) ? appState.playInfo.video.length : 0,
                        audio_stream_count: Array.isArray(appState.playInfo?.audio) ? appState.playInfo.audio.length : 0
                    }
                });
                break;
            }
            await sleep(200);
        }
    }

    if (hasUsablePlayInfoForBvid(appState.playInfo, pageBvid)) {
        appState.isPlayInfoReady = true;
        logDownload.info("download_streams_parse_success", {
            task: "download",
            bvid: pageBvid,
            detail: {
                source: "playinfo",
                playinfo_source: String(appState.playInfo?._source || ""),
                video_group_count: Array.isArray(appState.playInfo?.video) ? appState.playInfo.video.length : 0,
                audio_stream_count: Array.isArray(appState.playInfo?.audio) ? appState.playInfo.audio.length : 0
            }
        });
        return appState.playInfo;
    }

    appState.isPlayInfoReady = false;
    logDownload.warn("download_playinfo_missing", {
        task: "download",
        bvid: pageBvid,
        code: "DOWNLOAD_PLAYINFO_MISSING",
        detail: {
            checked_sources: ["window_playinfo", "inject_bridge"]
        }
    });
    return null;
}

function closeExportMenu() {
    const menu = panelShadowRoot ? panelShadowRoot.getElementById("export-option-menu") : null;
    if (menu) menu.remove();
    if (appState.navActionActive === "export") {
        setNavActionActive("");
    }
}
