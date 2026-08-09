const UI_BASE = "assets/ui";
const DEFAULT_GROQ_ASR_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_SILICONFLOW_ASR_BASE_URL = "https://api.siliconflow.cn/v1";
const DEFAULT_MIMO_ASR_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_MIMO_ASR_MODEL = "mimo-v2.5-asr";
const SUMMARY_DRAFT_TTL_MS = 10 * 60 * 1000;
const SUMMARY_DRAFT_STORAGE_PREFIX = "summaryDraft_";
const state = {
    tabId: 0,
    activePage: "CC",
    tabState: null,
    cache: null,
    settings: null,
    providers: {},
    settingsUiOptions: { providerModels: {}, freeQuotaProviders: [] },
    subtitleOptions: [],
    activeSubtitleId: "",
    feedback: null,
    streams: null,
    busy: "",
    error: "",
    search: "",
    chatDraft: "",
    settingsScrollTop: 0,
    renderSignature: "",
    hiddenEmbeddedTabId: 0,
    actionMenu: "",
    followEnabled: true,
    followPausedAt: 0,
    followCurrentIndex: -1,
    chatStreaming: null,
    chatPort: null,
    chatGuideHidden: false,
    settingsSaveTimer: null,
    feedbackDraft: { type: "bug", title: "", content: "", includeLogs: true },
    cloudCachePrefs: { all: false, current: false },
    releaseChecked: false,
    versionState: null,
    versionCheckInFlight: false,
    versionCheckedAt: 0,
    summaryRatio: 0.6,
    segmentsExpanded: false,
    initialized: false,
    activeBvid: "",
    activePartKey: "",
    switchingToEmbedded: false,
    summaryStreamDraft: null,
    summaryDraftExpiryTimer: null,
    summaryDraftExpiryAt: 0,
    announcementsUnread: false
};

const app = document.getElementById("app");

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function formatTime(value) {
    const total = Math.max(0, Math.floor(Number(value || 0)));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getRows() {
    const raw = Array.isArray(state.cache?.rawSubtitle) ? state.cache.rawSubtitle : [];
    return raw.length ? raw : (Array.isArray(state.cache?.processedSubtitle) ? state.cache.processedSubtitle : []);
}

function getBvid() {
    return String(state.tabState?.activeBvid || state.cache?.bvid || "").trim();
}

function getActiveCid() {
    if (state.tabState && Object.prototype.hasOwnProperty.call(state.tabState, "activeCid")) {
        return Number(state.tabState.activeCid || 0);
    }
    return Number(state.cache?.cid || 0);
}

function getActivePartKey() {
    const bvid = getBvid().toLowerCase();
    const cid = getActiveCid();
    return bvid && cid > 0 ? `${bvid}::${cid}` : "";
}

const partScopeDiagnosticSignatures = new Map();

function logPartScopeDiagnostic(event, detail = {}, dedupeKey = "") {
    if (!state.settings?.debugMode) return;
    const cache = state.cache || {};
    const payload = {
        event,
        ts: Date.now(),
        layer: "sidepanel",
        activeBvid: getBvid().toLowerCase(),
        activeCid: getActiveCid(),
        activeTid: String(state.tabState?.activeTid || ""),
        cacheBvid: String(cache?.bvid || "").toLowerCase(),
        cacheCid: Number(cache?.cid || 0),
        cacheTid: String(cache?.tid || ""),
        hasSummary: !!String(cache?.summary || "").trim(),
        segmentsCount: Array.isArray(cache?.segments) ? cache.segments.length : 0,
        hasRumors: !!cache?.rumors,
        historyCount: Array.isArray(cache?.history) ? cache.history.length : 0,
        availablePartKeys: cache?.parts && typeof cache.parts === "object" ? Object.keys(cache.parts).slice(0, 50) : [],
        ...detail
    };
    if (dedupeKey) {
        const signature = JSON.stringify(payload, (key, value) => key === "ts" ? undefined : value);
        if (partScopeDiagnosticSignatures.get(dedupeKey) === signature) return;
        partScopeDiagnosticSignatures.set(dedupeKey, signature);
    }
    console.log("[PART_SCOPE_DIAG]", payload);
}

function isCacheForActiveVideo(cache, tabState) {
    if (!cache) return false;
    const activeBvid = String(tabState?.activeBvid || "").trim().toLowerCase();
    const cacheBvid = String(cache?.bvid || "").trim().toLowerCase();
    if (activeBvid && cacheBvid && activeBvid !== cacheBvid) return false;
    const activeCid = Number(tabState?.activeCid || 0);
    const cacheCid = Number(cache?.cid || 0);
    if (activeCid > 0 && cacheCid > 0 && activeCid !== cacheCid) return false;
    const activeTid = String(tabState?.activeTid || "").trim();
    const cacheTid = String(cache?.tid || "").trim();
    if (activeTid && cacheTid && activeTid !== cacheTid) return false;
    return true;
}

function getLatestMetricText() {
    const metrics = Array.isArray(state.cache?.metrics) ? state.cache.metrics : [];
    const latest = metrics[metrics.length - 1];
    if (!latest) return "暂无调用指标";
    const latency = Number.isFinite(Number(latest.latencyMs)) ? `${(Number(latest.latencyMs) / 1000).toFixed(2)}s` : "-";
    const tokens = Number(latest.tokens || 0);
    const parts = [`用时 ${latency}`, `Tokens ${tokens}`];
    if (String(latest.provider || "").toLowerCase() === "modelscope") {
        parts.push(
            `模型剩余 ${formatMetricQuotaValue(latest.modelScopeRemaining, latest.modelScopeModelLimit)}`,
            `账号剩余 ${formatMetricQuotaValue(latest.modelScopeUserRemaining, latest.modelScopeUserLimit)}`
        );
    }
    return parts.join(" · ");
}

function formatMetricQuotaValue(remaining, limit) {
    const hasRemaining = remaining !== null && remaining !== undefined && remaining !== "";
    const hasLimit = limit !== null && limit !== undefined && limit !== "";
    if (!hasRemaining) return hasLimit ? `官网未返回/${limit}` : "官网未返回";
    return hasLimit ? `${remaining}/${limit}` : String(remaining);
}

function normalizeCloudCachePrefs(value = {}) {
    return {
        all: !!value?.all,
        current: !!value?.current
    };
}

function getAsrApiKeyRequirement(settings = {}) {
    const requested = String(settings.asrProvider || "groq").toLowerCase();
    const provider = ["groq", "siliconflow", "mimo"].includes(requested) ? requested : "groq";
    const providerName = provider === "siliconflow" ? "硅基流动" : (provider === "mimo" ? "Mimo" : "Groq");
    const apiKey = provider === "siliconflow"
        ? settings.siliconFlowApiKey
        : (provider === "mimo" ? settings.mimoApiKey : settings.groqApiKey);
    return { provider, providerName, missing: !String(apiKey || "").trim() };
}

function renderVersionUpdateBadge() {
    if (!state.versionState?.hasUpdate) return "";
    return `<button type="button" class="version-update-badge" data-action="open-extension-management" data-tooltip="跳转插件页后请在左上角找到“更新”按钮以更新插件" data-tooltip-placement="bottom">有可用版本更新</button>`;
}

function getAnnouncementDismissedStorageKey(key) {
    return `topAnnouncementDismissed:${String(key || "").trim().toLowerCase()}`;
}

function renderAnnouncementUnreadDot() {
    return state.announcementsUnread ? '<span class="settings-feature-dot announcement-unread-dot" aria-label="有新公告"></span>' : "";
}

async function refreshAnnouncementUnreadState({ force = false } = {}) {
    try {
        const response = await chrome.runtime.sendMessage({ action: "GET_ANNOUNCEMENTS", force });
        const rows = Array.isArray(response?.announcements?.rows) ? response.announcements.rows : [];
        const keys = [...new Set(rows.map((item) => String(item?.announcement_key || item?.key || "").trim().toLowerCase()).filter(Boolean))];
        const storageKeys = keys.map(getAnnouncementDismissedStorageKey);
        const stored = storageKeys.length ? await chrome.storage.local.get(storageKeys) : {};
        const unread = keys.some((key) => stored?.[getAnnouncementDismissedStorageKey(key)] !== true);
        if (unread !== state.announcementsUnread) {
            state.announcementsUnread = unread;
            render();
        }
    } catch (_) {}
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

async function checkLatestVersionAvailability({ force = false } = {}) {
    if (state.versionCheckInFlight) return;
    const stale = Date.now() - Number(state.versionCheckedAt || 0) > 60 * 60 * 1000;
    if (!force && state.versionCheckedAt && !stale) return;
    state.versionCheckInFlight = true;
    try {
        const result = await chrome.runtime.sendMessage({ action: "CHECK_LATEST_VERSION", force });
        if (result?.ok) {
            state.versionState = result.versionState || null;
            state.versionCheckedAt = Date.now();
            render();
        }
    } catch (_) {
        state.versionCheckedAt = Date.now();
    } finally {
        state.versionCheckInFlight = false;
    }
}

function isBiliTab(tab) {
    return /^https:\/\/www\.bilibili\.com\/(video|list)\//i.test(String(tab?.url || ""));
}

async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs.find(isBiliTab) || null;
}

async function refreshState({ quiet = false, hydrate = false, refreshFeedback = false } = {}) {
    try {
        const tab = await getActiveTab();
        if (!tab?.id) {
            await restoreHiddenEmbedded();
            state.tabId = 0;
            state.tabState = null;
            state.cache = null;
            state.error = "请先打开一个 B 站视频页面";
            render();
            return;
        }
        state.tabId = tab.id;
        if (!state.switchingToEmbedded) {
            await hideEmbeddedForActiveTab(tab.id);
        }
        const result = await chrome.runtime.sendMessage({
            action: "GET_BOOTSTRAP",
            tabId: tab.id,
            skipCloud: !hydrate,
            refreshFeedback
        });
        if (!result?.ok) throw new Error(result?.error || "读取视频状态失败");
        const nextBvid = String(result.tabState?.activeBvid || result.cache?.bvid || result.bvid || "");
        const nextCid = result.tabState && Object.prototype.hasOwnProperty.call(result.tabState, "activeCid")
            ? Number(result.tabState.activeCid || 0)
            : Number(result.cache?.cid || 0);
        const nextTid = String(result.tabState?.activeTid || result.cache?.tid || "").trim();
        const nextPartKey = nextBvid && nextCid > 0
            ? `${nextBvid.toLowerCase()}::${nextCid}`
            : nextBvid && nextTid
                ? `${nextBvid.toLowerCase()}::p:${nextTid}`
                : "";
        if (result.settings?.debugMode) {
            const responseCache = result.cache || {};
            const diagnostic = {
                event: "bootstrap_response_received",
                layer: "sidepanel",
                nextBvid: nextBvid.toLowerCase(),
                nextCid,
                nextTid,
                nextPartKey,
                returnedBvid: String(responseCache?.bvid || "").toLowerCase(),
                returnedCid: Number(responseCache?.cid || 0),
                returnedTid: String(responseCache?.tid || ""),
                accepted: !!result.cache && isCacheForActiveVideo(responseCache, result.tabState),
                hasSummary: !!String(responseCache?.summary || "").trim(),
                segmentsCount: Array.isArray(responseCache?.segments) ? responseCache.segments.length : 0,
                hasRumors: !!responseCache?.rumors,
                historyCount: Array.isArray(responseCache?.history) ? responseCache.history.length : 0
            };
            const signature = JSON.stringify(diagnostic);
            if (partScopeDiagnosticSignatures.get("bootstrap-response") !== signature) {
                partScopeDiagnosticSignatures.set("bootstrap-response", signature);
                console.log("[PART_SCOPE_DIAG]", { ...diagnostic, ts: Date.now() });
            }
        }
        if (state.activePartKey && nextPartKey && state.activePartKey !== nextPartKey) {
            if (state.chatStreaming && state.chatPort) {
                state.chatPort.postMessage({
                    action: "ABORT_CHAT_STREAM",
                    tabId: state.tabId,
                    messageId: state.chatStreaming.messageId
                });
                state.chatPort.disconnect();
            }
            state.chatStreaming = null;
            state.chatPort = null;
            state.chatDraft = "";
            state.chatGuideHidden = false;
            state.subtitleOptions = [];
            state.activeSubtitleId = "";
            state.summaryStreamDraft = null;
        }
        state.activeBvid = nextBvid;
        state.activePartKey = nextPartKey;
        state.tabState = result.tabState || null;
        state.cache = isCacheForActiveVideo(result.cache, state.tabState) ? result.cache : null;
        state.settings = result.settings || {};
        logPartScopeDiagnostic("bootstrap_cache_applied", {
            selected: !!state.cache,
            selectedPartKey: getActivePartKey()
        }, "bootstrap-cache-applied");
        state.cloudCachePrefs = normalizeCloudCachePrefs(result.cloudCachePrefs);
        if (!state.initialized) {
            const preferred = String(state.settings.defaultOpenPage || "CC");
            state.activePage = ["CC", "summary", "chat", "real"].includes(preferred) ? preferred : "CC";
            state.initialized = true;
        }
        state.providers = result.providers || {};
        state.settingsUiOptions = await contentAction("get-settings-ui-options").catch(() => state.settingsUiOptions);
        const subtitleOptionState = await contentAction("get-subtitle-options").catch(() => null);
        state.subtitleOptions = Array.isArray(subtitleOptionState?.options) ? subtitleOptionState.options : [];
        state.activeSubtitleId = String(subtitleOptionState?.activeId || state.cache?.subtitleLanguage || "");
        state.feedback = result.feedback || null;
        state.error = "";
        const nextSignature = JSON.stringify({
            tabId: state.tabId,
            tabState: state.tabState,
            cache: state.cache,
            settings: state.settings,
            cloudCachePrefs: state.cloudCachePrefs,
            settingsUiOptions: state.settingsUiOptions,
            subtitleOptions: state.subtitleOptions,
            activeSubtitleId: state.activeSubtitleId,
            feedback: state.feedback,
            error: state.error
        });
        if (nextSignature !== state.renderSignature) {
            state.renderSignature = nextSignature;
            render();
        }
        checkLatestVersionAvailability().catch(() => {});
        if (hydrate) refreshAnnouncementUnreadState().catch(() => {});
    } catch (error) {
        if (!quiet) state.error = error?.message || "读取失败";
        render();
    }
}

async function runtimeMessage(payload) {
    const result = await chrome.runtime.sendMessage({ ...payload, tabId: state.tabId });
    if (!result?.ok) throw new Error(result?.error || "操作失败");
    return result;
}

async function contentAction(command, extra = {}) {
    if (!state.tabId) throw new Error("未找到当前视频标签页");
    const result = await chrome.tabs.sendMessage(state.tabId, {
        action: "SIDE_PANEL_CONTENT_ACTION",
        command,
        ...extra
    });
    if (!result?.ok) throw new Error(result?.error || "网页操作失败");
    return result;
}

async function setEmbeddedVisibleForTab(tabId, visible) {
    const id = Number(tabId || 0);
    if (!id) return;
    await chrome.tabs.sendMessage(id, {
        action: "SIDE_PANEL_CONTENT_ACTION",
        command: "set-embedded-visible",
        visible: visible !== false
    }).catch(() => {});
}

async function hideEmbeddedForActiveTab(tabId) {
    if (state.switchingToEmbedded) return;
    const id = Number(tabId || 0);
    if (!id) return;
    if (state.hiddenEmbeddedTabId && state.hiddenEmbeddedTabId !== id) {
        await setEmbeddedVisibleForTab(state.hiddenEmbeddedTabId, true);
    }
    await setEmbeddedVisibleForTab(id, false);
    state.hiddenEmbeddedTabId = id;
}

async function restoreHiddenEmbedded() {
    const id = Number(state.hiddenEmbeddedTabId || 0);
    state.hiddenEmbeddedTabId = 0;
    if (id) await setEmbeddedVisibleForTab(id, true);
}

function showToast(text) {
    document.querySelector(".toast")?.remove();
    const node = document.createElement("div");
    node.className = "toast";
    node.textContent = text;
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 1800);
}

function navButton(id, file, label) {
    const active = state.activePage === id;
    const src = `${UI_BASE}/${active ? "active" : "default"}/${file}`;
    const showSettingsDot = Number(state.feedback?.unreadCount || 0) > 0
        || state.settings?.pluginDisplayFeatureSeen === false
        || state.announcementsUnread;
    const dot = id === "settings" && showSettingsDot ? `<span class="nav-red-dot"></span>` : "";
    return `<button class="side-nav-item ${active ? "active" : ""}" data-nav="${id}" data-id="${id}" data-tooltip="${escapeHtml(label)}" data-tooltip-placement="right" aria-label="${escapeHtml(label)}"><img class="loaded" src="${src}" alt="">${dot}</button>`;
}

function hideUiTooltip() {
    document.getElementById("side-ui-tooltip")?.remove();
}

function showUiTooltip(target) {
    const text = String(target?.dataset?.tooltip || "").trim();
    if (!text) return;
    hideUiTooltip();
    const rect = target.getBoundingClientRect();
    const placement = target.dataset.tooltipPlacement || "bottom";
    const tooltip = document.createElement("div");
    tooltip.id = "side-ui-tooltip";
    tooltip.className = `side-ui-tooltip placement-${placement}`;
    tooltip.textContent = text;
    document.body.appendChild(tooltip);
    const tipRect = tooltip.getBoundingClientRect();
    const padding = 8;
    let left;
    let top;
    if (placement === "right") {
        left = rect.right + 8;
        top = rect.top + (rect.height - tipRect.height) / 2;
        if (left + tipRect.width > window.innerWidth - padding) {
            left = Math.max(padding, rect.left - tipRect.width - 8);
            tooltip.className = "side-ui-tooltip placement-left";
        }
    } else {
        left = rect.left + (rect.width - tipRect.width) / 2;
        top = rect.bottom + 8;
    }
    left = Math.max(padding, Math.min(left, window.innerWidth - tipRect.width - padding));
    top = Math.max(padding, Math.min(top, window.innerHeight - tipRect.height - padding));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
    tooltip.style.setProperty("--arrow-left", `${Math.max(8, Math.min(tipRect.width - 8, rect.left + rect.width / 2 - left))}px`);
}

function settingOptionNote(selectId, value) {
    if (selectId === "setting-provider") {
        if (state.settingsUiOptions.freeQuotaProviders?.includes(value)) return "免费额度";
        return String(state.providers?.[value]?.note || "");
    }
    if (selectId === "setting-asr-provider") return value === "siliconflow" || value === "mimo" ? "无字幕时间戳" : "需科学上网";
    if (selectId === "setting-pref-mode") return value === "quality" ? "速度更快 · 2次调用" : "更省次数 · 1次调用";
    return "";
}

function resolveProviderModelValue(providerKey, model) {
    const value = String(model || "").trim();
    if (String(providerKey || "").toLowerCase() !== "modelscope") return value;
    const legacyModels = new Set([
        "moonshotai/Kimi-K2.5",
        "moonshotai/Kimi-K2.6",
        "MiniMax/MiniMax-M2.5",
        "ZhipuAI/GLM-5.1",
        "Qwen/Qwen3.5-27B",
        "Qwen/Qwen2.5-72B-Instruct"
    ]);
    const fallback = state.settingsUiOptions.providerModels?.modelscope?.[0] || value;
    return legacyModels.has(value) ? fallback : value;
}

function enhanceSettingsSelects() {
    document.querySelectorAll(".settings-page-shell select").forEach((select) => {
        if (!select.id || select.nextElementSibling?.classList.contains("custom-select-container")) return;
        select.classList.add("settings-native-select-hidden");
        const container = document.createElement("div");
        container.className = "custom-select-container settings-custom-select";
        container.dataset.targetSelect = select.id;
        const renderSelect = () => {
            const selected = select.options[select.selectedIndex];
            const options = Array.from(select.options).map((option) => {
                const note = settingOptionNote(select.id, option.value);
                return `<button type="button" class="custom-option ${option.selected ? "selected" : ""}" data-value="${escapeHtml(option.value)}"><span>${escapeHtml(option.textContent)}</span>${note ? `<span class="custom-option-note">${escapeHtml(note)}</span>` : ""}</button>`;
            }).join("");
            container.innerHTML = `<button type="button" class="custom-select-trigger"><span class="current-value">${escapeHtml(selected?.textContent || "")}</span><span class="custom-select-arrow">⌄</span></button><div class="custom-select-options">${options}</div>`;
        };
        renderSelect();
        container.addEventListener("click", (event) => {
            const option = event.target.closest(".custom-option");
            if (option) {
                select.value = option.dataset.value;
                select.dispatchEvent(new Event("change", { bubbles: true }));
                renderSelect();
                container.classList.remove("open");
                return;
            }
            if (event.target.closest(".custom-select-trigger")) {
                if (select.id === "setting-plugin-display-mode") markPluginDisplayFeatureSeen();
                document.querySelectorAll(".custom-select-container.open").forEach((node) => {
                    if (node !== container) node.classList.remove("open");
                });
                container.classList.toggle("open");
            }
        });
        select.after(container);
    });
}

function markPluginDisplayFeatureSeen() {
    if (state.settings?.pluginDisplayFeatureSeen !== false) return;
    state.settings = { ...state.settings, pluginDisplayFeatureSeen: true };
    document.querySelector(".plugin-display-feature-dot")?.remove();
    if (Number(state.feedback?.unreadCount || 0) <= 0 && !state.announcementsUnread) {
        document.querySelector('.side-nav-item[data-id="settings"] .nav-red-dot')?.remove();
    }
    scheduleSettingsSave();
}

function closeActionMenu() {
    document.getElementById("side-action-menu")?.remove();
    state.actionMenu = "";
}

function showSubtitleLanguageMenu(anchor) {
    closeActionMenu();
    const options = Array.isArray(state.subtitleOptions) ? state.subtitleOptions : [];
    if (options.length <= 1) {
        contentAction("get-subtitle-options")
            .then((result) => {
                state.subtitleOptions = Array.isArray(result?.options) ? result.options : [];
                state.activeSubtitleId = String(result?.activeId || state.activeSubtitleId || "");
                if (state.subtitleOptions.length > 1) showSubtitleLanguageMenu(anchor);
                else showToast("当前视频暂无可切换字幕语种");
            })
            .catch((error) => showToast(error?.message || "读取字幕语种失败"));
        return;
    }
    const rect = anchor.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.id = "side-action-menu";
    overlay.className = "copy-menu-overlay";
    overlay.dataset.theme = resolveThemeMode();
    const menu = document.createElement("div");
    menu.className = "copy-option-menu subtitle-language-menu";
    menu.style.left = `${Math.max(52, rect.right + 8)}px`;
    menu.style.top = `${Math.max(8, rect.top)}px`;
    menu.innerHTML = options.map((item) => {
        const id = String(item?.id || item?.lan || item?.label || "").trim();
        const label = String(item?.label || item?.lanDoc || item?.lan || id || "字幕").trim();
        const active = id && id === String(state.activeSubtitleId || "");
        return `<button class="copy-option-btn subtitle-language-option ${active ? "active" : ""}" data-action="switch-subtitle-language" data-language-id="${escapeHtml(id)}">${escapeHtml(label)}${active ? " · 当前" : ""}</button>`;
    }).join("");
    overlay.appendChild(menu);
    document.body.appendChild(overlay);
    const menuRect = menu.getBoundingClientRect();
    const viewportPadding = 8;
    if (menuRect.bottom > window.innerHeight - viewportPadding) {
        menu.style.top = "auto";
        menu.style.bottom = `${Math.max(viewportPadding, window.innerHeight - rect.top + 5)}px`;
    }
    if (menuRect.right > window.innerWidth - viewportPadding) {
        menu.style.left = `${Math.max(52, window.innerWidth - menuRect.width - viewportPadding)}px`;
    }
    overlay.addEventListener("click", async (event) => {
        if (event.target === overlay) return closeActionMenu();
        const action = event.target.closest("[data-action='switch-subtitle-language']");
        if (!action) return;
        closeActionMenu();
        state.busy = "切换字幕";
        render();
        try {
            await contentAction("switch-subtitle-language", { languageId: action.dataset.languageId });
            await refreshState({ hydrate: true });
            showToast("已切换字幕语言");
        } catch (error) {
            showToast(error?.message || "切换字幕失败");
        } finally {
            state.busy = "";
            render();
        }
    });
    state.actionMenu = "subtitle-language";
}

function showActionMenu(kind, anchor) {
    closeActionMenu();
    const rect = anchor.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.id = "side-action-menu";
    overlay.className = "copy-menu-overlay";
    overlay.dataset.theme = resolveThemeMode();
    const menu = document.createElement("div");
    menu.className = "copy-option-menu";
    menu.style.left = `${Math.max(52, rect.right + 8)}px`;
    menu.style.top = `${Math.max(8, rect.top)}px`;
    menu.innerHTML = kind === "copy"
        ? `<button class="copy-option-btn" data-action="copy-timestamped">复制（带时间戳）</button><button class="copy-option-btn" data-action="copy-plain">复制（纯文本）</button>`
        : `<button class="copy-option-btn" data-action="export-srt">导出字幕 SRT</button><button class="copy-option-btn" data-menu-download="video">下载视频</button><button class="copy-option-btn" data-menu-download="audio">下载音频</button>`;
    overlay.appendChild(menu);
    document.body.appendChild(overlay);
    const menuRect = menu.getBoundingClientRect();
    const viewportPadding = 8;
    if (menuRect.bottom > window.innerHeight - viewportPadding) {
        menu.style.top = "auto";
        menu.style.bottom = `${Math.max(viewportPadding, window.innerHeight - rect.top + 5)}px`;
    }
    if (menuRect.right > window.innerWidth - viewportPadding) {
        menu.style.left = `${Math.max(52, window.innerWidth - menuRect.width - viewportPadding)}px`;
    }
    overlay.addEventListener("click", async (event) => {
        if (event.target === overlay) return closeActionMenu();
        const action = event.target.closest("[data-action]");
        if (action) {
            closeActionMenu();
            try {
                await handleAction(action);
                if (kind === "copy") showCopyFeedback(anchor, "复制");
            } catch (error) {
                showToast(error?.message || "操作失败");
            }
            return;
        }
        const download = event.target.closest("[data-menu-download]");
        if (!download) return;
        menu.innerHTML = `<div class="menu-loading">正在获取媒体流...</div>`;
        try {
            state.streams = await contentAction("get-streams");
            const kindValue = download.dataset.menuDownload;
            const items = kindValue === "video"
                ? (state.streams?.video || []).flatMap((group, groupIndex) => (group.streams || []).map((stream, streamIndex) => ({ label: `${group.desc || "视频"} ${stream.codecName || ""}`, kind: "video", groupIndex, streamIndex })))
                : (state.streams?.audio || []).map((stream, streamIndex) => ({ label: stream.desc || `音频 ${streamIndex + 1}`, kind: "audio", groupIndex: 0, streamIndex }));
            menu.innerHTML = items.length
                ? items.map((item) => `<button class="copy-option-btn" data-action="download-stream" data-kind="${item.kind}" data-group="${item.groupIndex}" data-stream="${item.streamIndex}">${escapeHtml(item.label)}</button>`).join("")
                : `<div class="menu-loading">暂无可用媒体流</div>`;
        } catch (error) {
            menu.innerHTML = `<div class="menu-loading">${escapeHtml(error?.message || "读取失败")}</div>`;
        }
    });
    state.actionMenu = kind;
}

function renderShell(content) {
    const theme = resolveThemeMode();
    app.innerHTML = `
        <section class="ai-summary-plugin-box" data-theme="${escapeHtml(theme)}">
            <header class="plugin-top-logo">
                <div class="plugin-brand">
                    <img src="assets/icons/icon38.png" alt="">
                    <span class="logo-title">Bilitato B站视频小助手</span>
                    ${renderVersionUpdateBadge()}
                </div>
                <div class="plugin-top-actions">
                    <div class="metric-trigger">
                        <button class="header-icon-btn" data-tooltip="${escapeHtml(getLatestMetricText())}" data-tooltip-placement="bottom" aria-label="调用指标">
                            <img src="assets/ui/default/usage.png" alt="">
                        </button>
                    </div>
                    <button class="header-icon-btn side-mode-btn" data-action="switch-to-embedded" data-tooltip="切换回内嵌插件" data-tooltip-placement="bottom" aria-label="切换回内嵌插件">
                        <img src="assets/ui/active/sidebar.png" alt="">
                    </button>
                </div>
            </header>
            <div class="plugin-main-container">
                <nav class="plugin-side-nav">
                    <div class="nav-group">
                        ${navButton("CC", "CC.png", "字幕")}
                        ${navButton("summary", "summary.png", "总结")}
                        ${navButton("chat", "chat.png", "聊天")}
                        ${navButton("real", "real.png", "验真")}
                    </div>
                    <div class="nav-group">
                        ${navButton("copy", "copy.png", "复制")}
                        ${navButton("export", "download.png", "导出")}
                        ${navButton("settings", "settings.png", "设置")}
                    </div>
                </nav>
                <main class="plugin-content-panel">${content}</main>
            </div>
        </section>
    `;
}

function resolveThemeMode(settings = state.settings || {}) {
    const mode = String(settings.themeMode || "system").toLowerCase();
    if (mode === "dark" || mode === "light") return mode;
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

function applyThemeMode() {
    const box = document.querySelector(".ai-summary-plugin-box");
    const theme = resolveThemeMode();
    if (box) box.dataset.theme = theme;
    document.querySelector(".release-notice-overlay")?.setAttribute("data-theme", theme);
}

window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
    if (String(state.settings?.themeMode || "system") === "system") applyThemeMode();
});

function statusHtml() {
    if (state.error) return `<div class="status error">${escapeHtml(state.error)}</div>`;
    return "";
}

function taskStatus(task) {
    return String(state.tabState?.taskStatus?.[task] || "idle");
}

function taskErrorHtml(task, retryAction) {
    const status = taskStatus(task);
    if (status !== "error" && status !== "timeout") return "";
    const error = state.tabState?.taskErrors?.[task] || {};
    const message = error.message || state.tabState?.lastError || "任务失败，请重试";
    const mapper = globalThis.BilitatoContentErrorMessages;
    if (mapper?.mapErrorToView && mapper?.renderErrorPanel) {
        const view = mapper.mapErrorToView({ ...error, message });
        if (view && view.presentation !== "toast") return mapper.renderErrorPanel(view, retryAction);
    }
    return `<div class="task-error-card"><strong>${status === "timeout" ? "处理超时" : "处理失败"}</strong><span>${escapeHtml(message)}</span><div class="task-error-actions"><button class="btn secondary" data-action="${retryAction}">重试</button><button class="btn secondary" data-nav="settings">去设置</button></div></div>`;
}

function cacheTagHtml(tasks) {
    const hasTaskContent = tasks.some((task) => {
        if (task === "summary") return !!String(state.cache?.summary || "").trim();
        if (task === "segments") return Array.isArray(state.cache?.segments) && state.cache.segments.length > 0;
        if (task === "rumors") {
            const rumors = state.cache?.rumors;
            return !!String(rumors?.overview || "").trim() || (Array.isArray(rumors?.claims) && rumors.claims.length > 0);
        }
        return state.cache?.[task] != null;
    });
    const stillProcessing = tasks.some((task) => taskStatus(task) === "processing");
    const hasFailure = tasks.some((task) => ["error", "timeout"].includes(taskStatus(task)));
    if (!hasTaskContent || stillProcessing || hasFailure) return "";
    const sources = tasks.map((task) => String(state.cache?.[`${task}CacheSource`] || "")).filter(Boolean);
    if (sources.includes("cloud")) return `<span class="cache-tag">云端缓存</span>`;
    return `<span class="cache-tag local">本地缓存</span>`;
}

function skeletonHtml(lines = 4) {
    return `<div class="skeleton-list">${Array.from({ length: lines }, (_, index) => `<div class="skeleton-line" style="width:${Math.max(48, 96 - index * 11)}%"></div>`).join("")}</div>`;
}

function metricsHtml() {
    const text = getLatestMetricText();
    return text === "暂无调用指标" ? "" : `<div class="metrics-box">${escapeHtml(text)}</div>`;
}

function noApiKeyHtml() {
    return `<div class="no-apikey-notice"><div class="no-apikey-icon">🔑</div><div class="no-apikey-text">暂未配置 API Key<br>请去设置里填写哦~</div><button class="no-apikey-btn" data-nav="settings">点此配置 →</button></div>`;
}

function renderCC() {
    const rows = getRows();
    const term = state.search.trim().toLowerCase();
    const filtered = rows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => !term || String(row?.text || row?.content || "").toLowerCase().includes(term));
    const source = String(state.cache?.subtitleSource || state.tabState?.subtitleSource || "");
    const subtitleCacheSource = String(state.cache?.subtitleCacheSource || "").toLowerCase();
    const isAsrSubtitle = ["groq", "whisper", "siliconflow", "funasr", "mimo", "custom_asr"].includes(source.toLowerCase());
    const sourceText = subtitleCacheSource === "cloud" ? "云端缓存" : (isAsrSubtitle ? "ASR转录生成" : "官方AI字幕");
    const running = Number(state.tabState?.transcriptionProgress || 0) > 0;
    const asrKeyRequirement = getAsrApiKeyRequirement(state.settings || {});
    const canSwitchOfficialSubtitle = rows.length > 0 && !isAsrSubtitle && !running;
    const languageButton = canSwitchOfficialSubtitle
        ? `<button class="panel-icon-btn cc-language-btn" data-action="subtitle-language-menu" data-tooltip="切换字幕语言" data-tooltip-placement="bottom" aria-label="切换字幕语言"><img class="icon-default" src="assets/ui/default/language.png" alt=""><img class="icon-active" src="assets/ui/active/language.png" alt=""></button>`
        : "";
    const list = filtered.map(({ row, index }) => {
        const start = Number(row?.start ?? row?.from ?? 0);
        const end = Number(row?.end ?? row?.to ?? rows[index + 1]?.start ?? start + 6);
        const text = String(row?.text ?? row?.content ?? "");
        return `<div class="cc-row" data-index="${index}" data-start="${start}" data-end="${end}">
            <button class="cc-time cc-time-btn" data-action="seek" data-time="${start}">${formatTime(start)}</button>
            <span class="cc-text">${escapeHtml(text)}</span>
            <button class="cc-copy-btn" data-action="copy-row">复制</button>
        </div>`;
    }).join("");
    return `<section class="page cc-page">
        ${statusHtml()}
        <section class="cc-panel">
            <div class="transcription-control-center">
                <div class="cc-transcribe-head">
                    <div class="cc-search-container">
                        <input type="text" id="subtitle-search" class="cc-search-input" value="${escapeHtml(state.search)}" placeholder="搜索字幕...">
                        ${state.search ? `<button type="button" class="cc-search-clear visible" data-action="clear-search" aria-label="清空搜索">×</button>` : ""}
                    </div>
                    <div class="cc-header-right">
                        <div class="cc-transcribe-status">${escapeHtml(sourceText)}</div>
                        <div class="cc-transcribe-actions">${languageButton}</div>
                    </div>
                </div>
            </div>
            ${rows.length
                ? `<div class="cc-viewport"><div class="cc-list">${list || `<div class="empty">没有匹配结果</div>`}</div><button class="follow-fab direction-down" data-action="follow-now" aria-label="回到当前" style="display:none;"><img class="follow-fab-icon" src="assets/ui/default/up.png" alt=""></button></div>`
                : `<div class="subtitle-empty-container"><div class="action-container"><p class="action-tip">${running ? "正在转录音轨..." : (asrKeyRequirement.missing ? `请先填写${escapeHtml(asrKeyRequirement.providerName)}的API Key，再开始转录` : "未检测到字幕，可开启在线转录")}</p><button class="action-btn" data-action="${asrKeyRequirement.missing && !running ? "go-asr-settings" : "transcribe"}" ${running ? "disabled" : ""}>${running ? `转录中 ${Number(state.tabState?.transcriptionProgress || 0)}%` : (asrKeyRequirement.missing ? "去设置" : "开始在线转录")}</button></div></div>`}
        </section>
    </section>`;
}

function renderSummary() {
    const streamDraft = state.summaryStreamDraft;
    const streamDraftIsFresh = taskStatus("summary") === "processing"
        && streamDraft && typeof streamDraft === "object"
        && String(streamDraft.text || "").trim()
        && Date.now() - Number(streamDraft.updatedAt || 0) < SUMMARY_DRAFT_TTL_MS;
    const summaryDraft = streamDraftIsFresh ? streamDraft : state.cache?.summaryDraft;
    const freshDraft = taskStatus("summary") === "processing"
        && summaryDraft && typeof summaryDraft === "object"
        && String(summaryDraft.text || "").trim()
        && Date.now() - Number(summaryDraft.updatedAt || 0) < SUMMARY_DRAFT_TTL_MS;
    const draftExpiryAt = freshDraft ? Number(summaryDraft.updatedAt || 0) + SUMMARY_DRAFT_TTL_MS : 0;
    if (draftExpiryAt !== state.summaryDraftExpiryAt) {
        if (state.summaryDraftExpiryTimer) clearTimeout(state.summaryDraftExpiryTimer);
        state.summaryDraftExpiryAt = draftExpiryAt;
        state.summaryDraftExpiryTimer = draftExpiryAt ? setTimeout(() => {
            state.summaryDraftExpiryTimer = null;
            state.summaryDraftExpiryAt = 0;
            refreshState({ quiet: true, hydrate: false }).catch(() => {});
        }, Math.max(0, draftExpiryAt - Date.now()) + 20) : null;
    }
    const summary = String(freshDraft ? summaryDraft.text : (state.cache?.summary || "")).trim();
    const segments = Array.isArray(state.cache?.segments) ? state.cache.segments : [];
    logPartScopeDiagnostic("ui_render_read", {
        feature: "summary_segments",
        summaryStatus: taskStatus("summary"),
        segmentsStatus: taskStatus("segments"),
        accepted: isCacheForActiveVideo(state.cache, state.tabState)
    }, "render:summary_segments");
    const segmentHtml = segments.map((item) => {
        const start = Number(item?.start ?? item?.start_sec ?? 0);
        const end = Number(item?.end ?? item?.end_sec ?? start);
        const title = item?.label || item?.title || item?.topic || "视频片段";
        const isAd = String(item?.type || "").toLowerCase() === "ad";
        const noTimestamp = !!(item?.no_timestamp || ["siliconflow", "funasr", "mimo"].includes(String(state.cache?.subtitleSource || "").toLowerCase()));
        return `<button class="segment-card ${isAd ? "ad" : ""} ${noTimestamp ? "no-timestamp" : ""}" ${noTimestamp ? "disabled" : `data-action="seek" data-time="${start}"`}>
            <span class="seg-time">${noTimestamp ? "无时间轴" : `${formatTime(start)}-${formatTime(end)}`}</span>
            <span class="seg-label">${escapeHtml(title)}</span>
            ${isAd ? `<span class="ad-tag">广告片段</span>` : ""}
        </button>`;
    }).join("");
    const summaryHtml = globalThis.MarkdownRenderer?.render(summary) || escapeHtml(summary);
    const loading = taskStatus("summary") === "processing" || taskStatus("segments") === "processing";
    const hasContent = !!summary || segments.length > 0;
    const errorHtml = taskErrorHtml("summary", "run-summary") || taskErrorHtml("segments", "run-summary");
    const modeNotice = !state.settings?.summaryModeNoticeSeen ? `<div class="summary-mode-notice"><div class="summary-mode-notice-text"><strong>当前为「${state.settings?.prefMode === "efficiency" ? "省流模式" : "高速模式"}」</strong><span>${state.settings?.prefMode === "efficiency" ? "本次会消耗 1 次模型调用，同时生成总结和分段。" : "会同时生成总结和分段，速度更快，但每次会消耗 2 次模型调用次数。"}</span></div><button class="summary-mode-notice-btn" data-action="dismiss-summary-mode">知道了</button></div>` : "";
    if (!String(state.settings?.apiKey || "").trim() && !summary && !segments.length) {
        return `<section class="page summary-page">${noApiKeyHtml()}</section>`;
    }
    return `<section class="page summary-page ${state.segmentsExpanded ? "segments-expanded" : ""}">
        <div class="page-header">
            <h2>总结 ${cacheTagHtml(["summary", "segments"])}</h2>
            <div class="summary-header-actions">
                ${summary ? `<button class="panel-icon-btn" data-action="copy-summary" data-tooltip="复制" data-tooltip-placement="bottom" aria-label="复制"><img src="assets/ui/default/copy2.png" alt=""></button>` : ""}
                ${hasContent ? `<button class="panel-icon-btn ${loading ? "is-loading" : ""}" data-action="run-summary" data-tooltip="${loading ? "正在生成" : "重新生成"}" data-tooltip-placement="bottom" aria-label="重新生成" ${loading || state.busy ? "disabled" : ""}><img src="assets/ui/default/refresh.png" alt=""></button>` : ""}
            </div>
        </div>
        ${modeNotice}
        ${statusHtml()}
        ${errorHtml}
        ${loading && !summary && !segments.length ? `<div class="page-body">${skeletonHtml(5)}${skeletonHtml(4)}</div>` : summary || segments.length ? `
            <div class="page-body">
                <div class="summary-card-fixed">
                    <div class="result-text summary-result-text">${summaryHtml || `<div class="empty-text">尚未生成总结</div>`}</div>
                </div>
                <div class="summary-resize-divider"></div>
                <div class="summary-card-segments">
                    <div class="segments-section-header"><span class="segments-section-title">视频分段</span>${segments.length ? `<button class="segments-toggle-btn ${state.segmentsExpanded ? "is-expanded" : ""}" data-action="toggle-segments">${state.segmentsExpanded ? "收起" : "展开"}⌄</button>` : ""}</div>
                    <div class="segments-body"><div class="segment-list">${segmentHtml || (taskStatus("segments") === "processing" ? skeletonHtml(5) : `<div class="empty-text">尚未生成分段</div>`)}</div></div>
                </div>
            </div>
        ` : (errorHtml ? "" : `<div class="page-body subtitle-empty-container"><div class="action-container"><p class="action-tip">去除噪音，抓住重点。</p><button class="action-btn" data-action="run-summary">生成 AI 总结</button></div></div>`)}
        ${metricsHtml()}
    </section>`;
}

function renderChat() {
    if (!String(state.settings?.apiKey || "").trim()) {
        return `<section class="page chat-page-shell">${noApiKeyHtml()}</section>`;
    }
    const history = Array.isArray(state.cache?.history) ? state.cache.history : [];
    logPartScopeDiagnostic("ui_render_read", {
        feature: "chat",
        accepted: isCacheForActiveVideo(state.cache, state.tabState),
        streamingPartKey: state.chatStreaming?.partKey || ""
    }, "render:chat");
    const displayHistory = state.chatStreaming
        ? [...history, { role: "user", content: state.chatStreaming.question }, { role: "assistant", content: state.chatStreaming.answer, streaming: true }]
        : history;
    const rows = displayHistory.map((item) => {
        const role = item?.role === "user" ? "user" : "assistant";
        const content = String(item?.content || item?.text || "");
        const html = role === "assistant"
            ? (globalThis.MarkdownRenderer?.render(content) || escapeHtml(content))
            : escapeHtml(content);
        const meta = item?.metrics ? `<div class="chat-item-meta">${escapeHtml(`${Number(item.metrics.latencyMs || 0) ? `${(Number(item.metrics.latencyMs) / 1000).toFixed(2)}s` : ""}${Number(item.metrics.tokens || 0) ? ` · ${item.metrics.tokens} Tokens` : ""}`)}</div>` : "";
        return `<div class="chat-message-wrap ${role}" ${item?.streaming ? 'data-streaming-answer="true"' : ""}><div class="chat-item ${role}">${html}</div>${role === "assistant" && content && !item?.streaming ? `<button class="chat-copy-mini-btn" data-action="copy-chat">复制</button>${meta}` : ""}</div>`;
    }).join("");
    const guide = displayHistory.length || state.chatGuideHidden ? "" : `
        <div class="chat-greeting">Hello, Ask me anything!</div>
        <div class="chat-suggest-list">
            <button type="button" class="chat-suggest-link" data-action="chat-suggest" data-text="帮我生成视频大纲">帮我生成视频大纲</button>
            <button type="button" class="chat-suggest-link" data-action="chat-suggest" data-text="作者讲了哪些主要观点">作者讲了哪些主要观点</button>
            <button type="button" class="chat-suggest-link" data-action="chat-suggest" data-text="帮我翻译成英文稿">帮我翻译成英文稿</button>
            <button type="button" class="chat-suggest-link" data-action="chat-suggest" data-text="这个视频片段出自哪里？">这个视频片段出自哪里？</button>
        </div>`;
    return `<section class="page chat-page-shell">
        <div class="page-header"><h2>聊天</h2></div>
        ${statusHtml()}
        <section class="chat-page">
            ${guide}
            <div class="chat-display-area">${rows}</div>
            <div class="chat-footer">
                <div class="chat-input-wrap">
                    <textarea id="chat-input" placeholder="有咩想问的？">${escapeHtml(state.chatDraft)}</textarea>
                    <button class="chat-send-btn ${state.chatStreaming ? "stopping" : ""}" data-action="${state.chatStreaming ? "stop-chat" : "send-chat"}" aria-label="${state.chatStreaming ? "停止" : "发送"}">${state.chatStreaming ? "■" : "↑"}</button>
                </div>
            </div>
        </section>
        ${taskErrorHtml("chat", "send-chat")}
    </section>`;
}

function verdictMeta(value) {
    const text = String(value || "").toLowerCase();
    if (/false|fake|不实|谣言|不可信/.test(text)) return ["不可信", "fake"];
    if (/doubt|suspicious|存疑|核实/.test(text)) return ["存疑", "doubt"];
    if (/basic|partial|基本/.test(text)) return ["基本可信", "basic"];
    if (/true|real|可信|真实/.test(text)) return ["可信", "real"];
    return ["未知", ""];
}

function feedbackTypeLabel(value) {
    return { bug: "问题", suggestion: "建议", question: "咨询" }[String(value || "")] || "问题";
}

function feedbackStatusLabel(value) {
    return { pending: "处理中", processing: "处理中", resolved: "已处理", closed: "已关闭" }[String(value || "").toLowerCase()] || "处理中";
}

function isMeaningfulFeedbackText(value) {
    const normalized = String(value || "").trim().replace(/[。.!！?？]+$/g, "").trim();
    return !!normalized && !/^(无|暂无|没有|无内容|没内容|不知道|不清楚)$/i.test(normalized);
}

function renderReal() {
    const claims = Array.isArray(state.cache?.rumors?.claims)
        ? state.cache.rumors.claims
        : (Array.isArray(state.cache?.rumors) ? state.cache.rumors : []);
    const overview = String(state.cache?.rumors?.overview || "").trim();
    logPartScopeDiagnostic("ui_render_read", {
        feature: "rumors",
        rumorsStatus: taskStatus("rumors"),
        claimsCount: claims.length,
        accepted: isCacheForActiveVideo(state.cache, state.tabState)
    }, "render:rumors");
    const loading = taskStatus("rumors") === "processing";
    if (!String(state.settings?.apiKey || "").trim() && !claims.length) {
        return `<section class="page real-page-shell">${noApiKeyHtml()}</section>`;
    }
    const list = claims.map((item) => {
        const [label, cls] = verdictMeta(item?.verdict || item?.status);
        const time = Number(item?.timestamp_sec ?? item?.start ?? 0);
        const noTimestamp = !!(item?.no_timestamp || ["siliconflow", "funasr", "mimo"].includes(String(state.cache?.subtitleSource || "").toLowerCase()));
        const tooltip = {
            fake: "信息与事实严重不符，或属于明显的误导或谣言。",
            doubt: "证据不足或存在逻辑矛盾，需要用户进一步甄别。",
            basic: "核心观点正确，但细节可能存在偏差。",
            real: "信息有明确出处或符合客观事实。"
        }[cls] || "AI 暂时无法获取外部资料进行验证，或内容属于主观观点。";
        return `<div class="claim-card ${cls || "unknown"}">
            <div class="claim-header">
                ${noTimestamp ? `<span class="claim-time-btn claim-time-static">无时间轴</span>` : `<button class="claim-time-btn" data-action="seek" data-time="${time}">${formatTime(time)}</button>`}
                <span class="claim-status-tag ${cls || "unknown"}" data-tooltip="${escapeHtml(tooltip)}">${label}</span>
            </div>
            <div class="claim-content">${escapeHtml(item?.claim || item?.title || "待验真内容")}</div>
            <div class="claim-analysis">${escapeHtml(item?.analysis || item?.reason || "")}</div>
        </div>`;
    }).join("");
    return `<section class="page real-page-shell">
        <div class="page-header">
            <h2>验真助手 <span class="beta-tag">Beta</span>${cacheTagHtml(["rumors"])}</h2>
            ${claims.length ? `<button class="panel-icon-btn" data-action="run-rumors" title="重新验真" aria-label="重新验真" ${state.busy ? "disabled" : ""}><img src="assets/ui/default/refresh.png" alt=""></button>` : ""}
        </div>
        ${statusHtml()}
        <div class="real-notice">提示：当前内置大模型暂无联网能力，无法对时事新闻作出实时评判；验真结果仅基于历史事实、科学常识、通用知识和视频上下文，仅供参考。</div>
        ${taskErrorHtml("rumors", "run-rumors")}
        ${loading && !claims.length ? `<div class="real-page-section">${skeletonHtml(6)}</div>` : claims.length
            ? `<div class="real-page-section">${overview ? `<div class="rumor-overview">${globalThis.MarkdownRenderer?.render(overview) || escapeHtml(overview)}</div>` : ""}<div class="claim-list">${list}</div></div>`
            : `<div class="page-body subtitle-empty-container"><div class="action-container"><p class="action-tip">先问是不是，再问为什么。</p><button class="action-btn" data-action="run-rumors" ${state.busy ? "disabled" : ""}>开始验真</button></div></div>`}
        ${metricsHtml()}
    </section>`;
}

function renderSettings() {
    const settings = state.settings || {};
    const promptSettings = settings.promptSettings || {};
    const customPrompts = promptSettings.custom || {};
    const providerOptions = Object.entries(state.providers || {}).map(([key, item]) =>
        `<option value="${escapeHtml(key)}" ${settings.provider === key ? "selected" : ""}>${escapeHtml(item?.name || key)}</option>`
    ).join("");
    const feedbackRows = Array.isArray(state.feedback?.rows) ? state.feedback.rows : [];
    const feedbackDraft = state.feedbackDraft;
    const feedbackHtml = feedbackRows.slice(0, 5).map((row) => `
        <div class="feedback-item">
            <div class="feedback-item-head">
                <strong>${escapeHtml(row?.title || "未命名反馈")}</strong>
                <span class="feedback-status">${feedbackStatusLabel(row?.status)}</span>
            </div>
            <div class="feedback-item-meta">${feedbackTypeLabel(row?.type)}</div>
            <div class="feedback-item-content">${escapeHtml(row?.content || "")}</div>
            ${row?.reply ? `<div class="feedback-reply">${escapeHtml(row.reply)}</div>` : ""}
        </div>`).join("");
    const provider = state.providers?.[settings.provider] || {};
    const rawProviderModels = state.settingsUiOptions.providerModels?.[settings.provider] || [];
    const recommendedModelScopeModelOrder = [
        "Qwen/Qwen3-30B-A3B-Instruct-2507",
        "Qwen/Qwen3-30B-A3B"
    ];
    const recommendedModelScopeModels = new Set(recommendedModelScopeModelOrder);
    const providerModels = settings.provider === "modelscope"
        ? [
            ...recommendedModelScopeModelOrder.filter((model) => rawProviderModels.includes(model)),
            ...rawProviderModels.filter((model) => !recommendedModelScopeModels.has(model))
        ]
        : rawProviderModels;
    const currentModel = resolveProviderModelValue(settings.provider, settings.providerModels?.[settings.provider] || settings.model || provider.model || "");
    const modelIsPreset = providerModels.includes(currentModel);
    const modelOptions = providerModels.map((model) => {
        const recommended = settings.provider === "modelscope" && recommendedModelScopeModels.has(model) ? "（推荐）" : "";
        return `<option value="${escapeHtml(model)}" ${model === currentModel ? "selected" : ""}>${escapeHtml(model)}${recommended}</option>`;
    }).join("");
    const modelScopeModelInfo = "ModelScope 免费额度：Qwen3-30B-A3B-Instruct-2507 200次/天；Qwen3-235B-A22B-Instruct-2507 50次/天；Qwen3-Coder-30B-A3B-Instruct 100次/天；Qwen3-30B-A3B 200次/天；DeepSeek-V4-Pro 20次/天；DeepSeek-V4-Flash-0731 50次/天。";
    const modelLabelInfo = settings.provider === "modelscope"
        ? `<span id="setting-model-info" class="settings-info-icon" data-tooltip="${escapeHtml(modelScopeModelInfo)}">i</span>`
        : `<span id="setting-model-info" class="settings-info-icon settings-hidden" data-tooltip="${escapeHtml(modelScopeModelInfo)}">i</span>`;
    const providerNote = String(provider?.note || "").trim();
    const customProviderVisible = settings.provider === "custom" ? "" : "settings-hidden";
    const requestedAsrProvider = String(settings.asrProvider || "groq").toLowerCase();
    const asrProvider = ["groq", "siliconflow", "mimo"].includes(requestedAsrProvider) ? requestedAsrProvider : "groq";
    const guidedVisible = promptSettings.mode === "custom" ? "settings-hidden" : "";
    const customPromptVisible = promptSettings.mode === "custom" ? "" : "settings-hidden";
    const cloudCachePrefs = normalizeCloudCachePrefs(state.cloudCachePrefs);
    const allCloudDisabledOn = !!(cloudCachePrefs.all || settings.disableCloudCacheRead);
    const currentCloudDisabled = (allCloudDisabledOn || cloudCachePrefs.current) ? "checked" : "";
    const allCloudDisabled = allCloudDisabledOn ? "checked" : "";
    const currentCloudDisabledAttr = getBvid() && !allCloudDisabledOn ? "" : "disabled";
    const currentCloudLabel = allCloudDisabledOn ? "本视频不拉取云端缓存（已由所有视频设置覆盖）" : "本视频不拉取云端缓存";
    const secretField = (id, value, placeholder = "") => `<div class="settings-secret-field"><input id="${id}" type="password" value="${escapeHtml(value || "")}" placeholder="${escapeHtml(placeholder)}" autocomplete="off"><button type="button" class="settings-secret-toggle" data-action="toggle-secret" data-target="${id}">显示</button></div><div class="field-error" id="${id}-error"></div>`;
    const asrRegisterUrl = asrProvider === "siliconflow"
        ? "https://cloud.siliconflow.cn/account/ak"
        : (asrProvider === "mimo" ? "https://platform.xiaomimimo.com/" : "https://console.groq.com/keys");
    return `<section class="page settings-page-shell">
        <div class="page-header"><h2>设置（自动保存）</h2><span id="settings-save-status" class="settings-save-status"></span></div>
        ${statusHtml()}
        <div class="settings-scroll-body"><div class="settings-grid">
            <div class="settings-group">
                <div class="settings-group-title-row"><div class="settings-group-title">主模型配置</div><div class="settings-title-actions"><button type="button" class="panel-btn ghost settings-guide-btn" data-action="open-setup-guide">查看引导</button><button type="button" class="panel-btn ghost settings-guide-btn${state.announcementsUnread ? " has-unread-announcement" : ""}" data-action="open-announcements">查看公告${renderAnnouncementUnreadDot()}</button></div></div>
                <div class="field"><label>Provider ${providerNote ? `<span id="setting-provider-tag" class="provider-tag">${escapeHtml(providerNote)}</span>` : `<span id="setting-provider-tag" class="provider-tag settings-hidden"></span>`}</label><div class="settings-provider-row"><select id="setting-provider">${providerOptions}</select><button id="setting-provider-register" type="button" class="panel-btn ghost" data-action="open-register" data-url="${escapeHtml(provider?.regUrl || "")}" ${provider?.regUrl ? "" : "disabled"}>注册</button></div></div>
                <div class="field"><label>API Key</label>${secretField("setting-api-key", settings.apiKey, "示例：sk-xxxxx")}</div>
                <div class="field"><label class="settings-label-with-info">Model${modelLabelInfo}</label>${providerModels.length ? `<select id="setting-model-select">${modelOptions}<option value="custom" ${modelIsPreset ? "" : "selected"}>自定义</option></select>` : ""}<input id="setting-model" class="${providerModels.length && modelIsPreset ? "settings-hidden" : ""}" value="${escapeHtml(currentModel)}" placeholder="请输入模型名"></div>
                <div id="setting-custom-provider-fields" class="${customProviderVisible}">
                    <div class="field"><label>自定义地址协议</label><select id="setting-custom-protocol"><option value="openai" ${settings.customProtocol !== "claude" ? "selected" : ""}>OpenAI 协议</option><option value="claude" ${settings.customProtocol === "claude" ? "selected" : ""}>Claude 协议</option></select></div>
                    <div class="field"><label>Base URL</label><input id="setting-base-url" value="${escapeHtml(settings.customBaseUrl || "")}" placeholder="示例：https://api.example.com/v1"></div>
                    <button type="button" class="panel-btn ghost" data-action="authorize-custom-origin">授权当前域名</button>
                </div>
            </div>
            <div class="settings-group">
                <div class="settings-group-title" id="setting-asr-section">ASR 音频识别</div>
                <div class="field"><label>Provider</label><div class="settings-provider-row"><select id="setting-asr-provider"><option value="groq" ${asrProvider === "groq" ? "selected" : ""}>Groq</option><option value="siliconflow" ${asrProvider === "siliconflow" ? "selected" : ""}>硅基流动</option><option value="mimo" ${asrProvider === "mimo" ? "selected" : ""}>小米 MiMo</option></select><button id="setting-asr-register" type="button" class="panel-btn ghost" data-action="open-register" data-url="${asrRegisterUrl}" ${asrRegisterUrl ? "" : "disabled"}>注册</button></div></div>
                <div id="setting-asr-groq-fields" class="${asrProvider === "groq" ? "" : "settings-hidden"}">
                    <div class="field"><label>Base URL</label><div class="settings-asr-base-url-row"><input id="setting-groq-base-url" data-manual-save="true" value="${escapeHtml(settings.groqBaseUrl || DEFAULT_GROQ_ASR_BASE_URL)}" readonly><button type="button" class="panel-btn ghost" data-action="edit-groq-base-url">修改</button><button type="button" class="panel-btn ghost" data-action="reset-groq-base-url">重置</button></div></div>
                    <div class="field"><label>Groq API Key</label>${secretField("setting-groq-key", settings.groqApiKey, "示例：gsk_xxxxx")}</div>
                    <div class="field"><label>Groq 模型</label><input id="setting-groq-model" value="${escapeHtml(settings.groqModel || "whisper-large-v3-turbo")}"></div>
                </div>
                <div id="setting-asr-siliconflow-fields" class="${asrProvider === "siliconflow" ? "" : "settings-hidden"}">
                    <div class="settings-provider-url">${DEFAULT_SILICONFLOW_ASR_BASE_URL}</div>
                    <div class="field"><label>硅基流动 API Key</label>${secretField("setting-siliconflow-key", settings.siliconFlowApiKey, "示例：sk-xxxxx")}</div>
                    <div class="field"><label>硅基流动模型</label><input id="setting-siliconflow-model" value="${escapeHtml(settings.siliconFlowAsrModel || "FunAudioLLM/SenseVoiceSmall")}"></div>
                </div>
                <div id="setting-asr-mimo-fields" class="${asrProvider === "mimo" ? "" : "settings-hidden"}">
                    <div class="settings-provider-url">${DEFAULT_MIMO_ASR_BASE_URL}</div>
                    <div class="field"><label>小米 MiMo API Key</label>${secretField("setting-mimo-key", settings.mimoApiKey, "示例：sk-xxxxx")}</div>
                    <div class="field"><label>小米 MiMo 模型</label><input id="setting-mimo-model" value="${DEFAULT_MIMO_ASR_MODEL}" readonly></div>
                </div>
            </div>
            <div class="settings-group">
                <div class="settings-group-title">调用与显示</div>
                <div class="field"><label class="settings-feature-label">插件显示${settings.pluginDisplayFeatureSeen === false ? '<span class="settings-feature-dot plugin-display-feature-dot" aria-label="新增功能"></span>' : ""}</label><select id="setting-plugin-display-mode"><option value="expanded" ${settings.pluginDisplayMode !== "collapsed" ? "selected" : ""}>默认展开</option><option value="collapsed" ${settings.pluginDisplayMode === "collapsed" ? "selected" : ""}>默认缩起</option></select></div>
                <div class="field"><label>深/浅模式</label><select id="setting-theme-mode"><option value="system" ${settings.themeMode !== "light" && settings.themeMode !== "dark" ? "selected" : ""}>跟随系统</option><option value="light" ${settings.themeMode === "light" ? "selected" : ""}>浅色模式</option><option value="dark" ${settings.themeMode === "dark" ? "selected" : ""}>深色模式</option></select></div>
                <div class="field"><label>默认页面</label><select id="setting-default-page">${["CC", "summary", "chat", "real"].map((key) => `<option value="${key}" ${settings.defaultOpenPage === key ? "selected" : ""}>${{CC:"字幕",summary:"总结",chat:"聊天",real:"验真"}[key]}</option>`).join("")}</select></div>
                <div class="field"><label>调用模式</label><select id="setting-pref-mode"><option value="quality" ${settings.prefMode !== "efficiency" ? "selected" : ""}>高速模式</option><option value="efficiency" ${settings.prefMode === "efficiency" ? "selected" : ""}>省流模式</option></select></div>
                <div class="field"><label>异常上报</label><select id="setting-sentry"><option value="true" ${settings.sentryEnabled ? "selected" : ""}>开启</option><option value="false" ${!settings.sentryEnabled ? "selected" : ""}>关闭</option></select></div>
                <div class="settings-group-title">缓存管理</div>
                <div class="settings-action-row"><button class="btn secondary" data-action="delete-current-cache">删除当前视频 AI 结果缓存</button><button class="btn secondary" data-action="delete-all-cache">删除所有视频 AI 结果缓存</button></div>
                <div class="settings-check-grid">
                    <label class="settings-check-row"><input id="setting-disable-cloud-current" type="checkbox" ${currentCloudDisabled} ${currentCloudDisabledAttr}><span>${escapeHtml(currentCloudLabel)}</span></label>
                    <label class="settings-check-row"><input id="setting-disable-cloud-all" type="checkbox" ${allCloudDisabled}><span>所有视频不拉取云端缓存</span></label>
                </div>
            </div>
            <div class="settings-group">
                <div class="settings-group-title">个性化</div>
                <div class="field"><label>模式</label><select id="setting-prompt-mode"><option value="guided" ${promptSettings.mode !== "custom" ? "selected" : ""}>简单模式</option><option value="custom" ${promptSettings.mode === "custom" ? "selected" : ""}>专业模式</option></select></div>
                <div id="setting-prompt-guided-fields" class="${guidedVisible}">
                    <div class="field slider-group"><label>语言风格</label><div class="slider-labels"><span>轻松</span><span>平衡</span><span>专业</span></div><input id="setting-prompt-tone" type="range" min="0" max="2" step="1" value="${promptSettings.guided?.tone === "casual" ? 0 : promptSettings.guided?.tone === "professional" ? 2 : 1}"></div>
                    <div class="field slider-group"><label>详略程度</label><div class="slider-labels"><span>简略</span><span>标准</span><span>详实</span></div><input id="setting-prompt-detail" type="range" min="0" max="2" step="1" value="${promptSettings.guided?.detail === "brief" ? 0 : promptSettings.guided?.detail === "detailed" ? 2 : 1}"></div>
                </div>
                <div id="setting-prompt-custom-fields" class="${customPromptVisible}">
                    <div class="field"><label>总结 Prompt</label><textarea id="setting-prompt-summary" maxlength="1000">${escapeHtml(customPrompts.summary || "")}</textarea><div class="prompt-char-count">${String(customPrompts.summary || "").length}/1000</div></div>
                    <div class="field"><label>分段 Prompt</label><textarea id="setting-prompt-segments" maxlength="1000">${escapeHtml(customPrompts.segments || "")}</textarea><div class="prompt-char-count">${String(customPrompts.segments || "").length}/1000</div></div>
                    <div class="field"><label>验真 Prompt</label><textarea id="setting-prompt-rumors" maxlength="1000">${escapeHtml(customPrompts.rumors || "")}</textarea><div class="prompt-char-count">${String(customPrompts.rumors || "").length}/1000</div></div>
                </div>
                <button type="button" class="panel-btn ghost settings-reset-btn" data-action="reset-prompts">恢复默认</button>
            </div>
            <div class="settings-group">
                <div class="settings-group-title">帮助与反馈</div>
                <div class="settings-action-row"><button class="btn secondary" data-action="open-help">帮助文档</button><button class="btn secondary" data-action="open-review">去好评</button></div>
                <div class="feedback-card">
                    <div class="feedback-title">反馈中心</div>
                    <div class="feedback-subtitle">我非常重视你和你的意见。</div>
                    <select id="feedback-type">
                        <option value="bug" ${feedbackDraft.type === "bug" ? "selected" : ""}>问题反馈</option>
                        <option value="suggestion" ${feedbackDraft.type === "suggestion" ? "selected" : ""}>功能建议</option>
                        <option value="question" ${feedbackDraft.type === "question" ? "selected" : ""}>使用咨询</option>
                    </select>
                    <input id="feedback-title" type="text" maxlength="120" value="${escapeHtml(feedbackDraft.title)}" placeholder="一句话说说遇到了什么问题～">
                    <textarea id="feedback-content" maxlength="3000" placeholder="告诉我你具体遇到了什么问题">${escapeHtml(feedbackDraft.content)}</textarea>
                    <label class="feedback-check"><input id="feedback-include-logs" type="checkbox" ${feedbackDraft.includeLogs ? "checked" : ""}><span>默认附带异常日志，便于定位问题</span></label>
                    <button class="feedback-submit-btn" data-action="submit-feedback">提交反馈</button>
                    <div class="feedback-list">${feedbackHtml || `<div class="feedback-empty">暂无反馈记录。</div>`}</div>
                </div>
            </div>
        </div></div>
    </section>`;
}

function renderCopy() {
    return `<section class="page">
        <div class="page-header"><h2>复制</h2></div>
        <div class="empty">
            <button class="btn" data-action="copy-timestamped">复制带时间戳字幕</button>
            <button class="btn secondary" data-action="copy-plain">复制纯文本字幕</button>
            <button class="btn secondary" data-action="copy-summary">复制总结</button>
        </div>
    </section>`;
}

function renderExport() {
    const video = Array.isArray(state.streams?.video) ? state.streams.video : [];
    const audio = Array.isArray(state.streams?.audio) ? state.streams.audio : [];
    const videoOptions = video.map((group, groupIndex) => {
        const streams = Array.isArray(group?.streams) ? group.streams : [];
        return streams.map((stream, streamIndex) => `
            <div class="segment">
                <div class="segment-head">
                    <div>
                        <div class="segment-title">${escapeHtml(group?.desc || `清晰度 ${groupIndex + 1}`)}</div>
                        <div class="segment-desc">${escapeHtml(stream?.codecName || stream?.codecs || "")}</div>
                    </div>
                    <button class="btn" data-action="download-stream" data-kind="video" data-group="${groupIndex}" data-stream="${streamIndex}">下载</button>
                </div>
            </div>`).join("");
    }).join("");
    const audioOptions = audio.map((stream, index) => `
        <div class="segment">
            <div class="segment-head">
                <div class="segment-title">${escapeHtml(stream?.desc || `音频 ${index + 1}`)}</div>
                <button class="btn" data-action="download-stream" data-kind="audio" data-stream="${index}">下载</button>
            </div>
        </div>`).join("");
    return `<section class="page">
        <div class="page-header"><h2>导出</h2><button class="btn secondary" data-action="load-streams">刷新媒体流</button></div>
        ${statusHtml()}
        <div class="section"><button class="btn" data-action="export-srt">导出字幕 SRT</button></div>
        ${state.streams ? `
            <div class="section"><div class="section-title">视频</div><div class="segment-list">${videoOptions || "暂无视频流"}</div></div>
            <div class="section"><div class="section-title">音频</div><div class="segment-list">${audioOptions || "暂无音频流"}</div></div>
        ` : `<div class="empty"><div>读取当前视频可下载的清晰度和音频流</div><button class="btn secondary" data-action="load-streams">读取媒体流</button></div>`}
    </section>`;
}

function render() {
    const settingsScrollTop = document.querySelector(".settings-scroll-body")?.scrollTop ?? state.settingsScrollTop;
    const chatListBefore = document.querySelector(".chat-display-area");
    const chatScrollTop = chatListBefore?.scrollTop || 0;
    const chatWasAtBottom = !!chatListBefore && chatListBefore.scrollHeight - chatListBefore.scrollTop <= chatListBefore.clientHeight + 40;
    const summaryBefore = document.querySelector(".summary-result-text");
    const summaryScrollTop = summaryBefore?.scrollTop || 0;
    const summaryWasAtBottom = !!summaryBefore && summaryBefore.scrollHeight - summaryBefore.scrollTop <= summaryBefore.clientHeight + 40;
    const segmentsBefore = document.querySelector(".segments-body");
    const segmentsScrollTop = segmentsBefore?.scrollTop || 0;
    const focusedId = document.activeElement?.id || "";
    const selectionStart = document.activeElement?.selectionStart;
    const selectionEnd = document.activeElement?.selectionEnd;
    let content;
    if (!state.tabId) {
        content = `<section class="page"><div class="empty">${escapeHtml(state.error || "请打开 B 站视频")}</div></section>`;
    } else if (state.activePage === "summary") content = renderSummary();
    else if (state.activePage === "chat") content = renderChat();
    else if (state.activePage === "real") content = renderReal();
    else if (state.activePage === "settings") content = renderSettings();
    else if (state.activePage === "copy") content = renderCopy();
    else if (state.activePage === "export") content = renderExport();
    else content = renderCC();
    renderShell(content);
    requestAnimationFrame(() => {
        enhanceSettingsSelects();
        bindSubtitleFollow();
        bindSummaryResize();
        const scrollBody = document.querySelector(".settings-scroll-body");
        if (scrollBody) scrollBody.scrollTop = settingsScrollTop;
        const chatList = document.querySelector(".chat-display-area");
        if (chatList) chatList.scrollTop = chatWasAtBottom ? chatList.scrollHeight : chatScrollTop;
        const summaryResult = document.querySelector(".summary-result-text");
        if (summaryResult) summaryResult.scrollTop = summaryWasAtBottom ? summaryResult.scrollHeight : summaryScrollTop;
        const segmentsBody = document.querySelector(".segments-body");
        if (segmentsBody) segmentsBody.scrollTop = segmentsScrollTop;
        if (!focusedId) return;
        const focused = document.getElementById(focusedId);
        focused?.focus();
        if (typeof focused?.setSelectionRange === "function" && Number.isInteger(selectionStart)) {
            focused.setSelectionRange(selectionStart, selectionEnd);
        }
        if (!state.releaseChecked) {
            state.releaseChecked = true;
            globalThis.BilitatoReleaseNotice?.maybeShowReleaseNotice({ root: document });
        }
    });
}

function bindSummaryResize() {
    const divider = document.querySelector(".summary-resize-divider");
    const body = document.querySelector(".summary-page .page-body");
    const summary = document.querySelector(".summary-card-fixed");
    if (!divider || !body || !summary) return;
    summary.style.height = state.segmentsExpanded ? "auto" : `${Math.round(state.summaryRatio * 100)}%`;
    if (state.segmentsExpanded) return;
    divider.onmousedown = (event) => {
        event.preventDefault();
        const rect = body.getBoundingClientRect();
        const move = (moveEvent) => {
            state.summaryRatio = Math.max(0.15, Math.min(0.85, (moveEvent.clientY - rect.top) / rect.height));
            summary.style.height = `${Math.round(state.summaryRatio * 100)}%`;
        };
        const up = () => {
            document.removeEventListener("mousemove", move);
            document.removeEventListener("mouseup", up);
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
    };
}

function bindSubtitleFollow() {
    const list = document.querySelector(".cc-list");
    if (!list || list.dataset.followBound === "1") return;
    list.dataset.followBound = "1";
    const pause = () => {
        state.followEnabled = false;
        state.followPausedAt = Date.now();
        updateFollowButton();
    };
    list.addEventListener("wheel", pause, { passive: true });
    list.addEventListener("touchmove", pause, { passive: true });
}

function updateFollowButton() {
    const button = document.querySelector(".follow-fab");
    const list = document.querySelector(".cc-list");
    if (!button || !list) return;
    button.style.display = state.followEnabled ? "none" : "flex";
    const row = list.querySelector(`.cc-row[data-index="${state.followCurrentIndex}"]`);
    button.classList.toggle("direction-up", !!row && row.offsetTop < list.scrollTop);
    button.classList.toggle("direction-down", !row || row.offsetTop >= list.scrollTop);
}

function syncSubtitlePlayback(currentTime, force = false) {
    if (state.activePage !== "CC" || !Number.isFinite(currentTime)) return;
    if (!state.followEnabled && Date.now() - state.followPausedAt >= 5000) {
        state.followEnabled = true;
    }
    const list = document.querySelector(".cc-list");
    if (!list) return;
    const rows = Array.from(list.querySelectorAll(".cc-row"));
    const active = rows.find((row) => {
        const start = Number(row.dataset.start);
        const end = Number(row.dataset.end);
        return start <= currentTime && currentTime < end;
    });
    const index = active ? Number(active.dataset.index) : -1;
    if (index !== state.followCurrentIndex || force) {
        list.querySelectorAll(".cc-row.active").forEach((row) => row.classList.remove("active"));
        active?.classList.add("active");
        state.followCurrentIndex = index;
    }
    updateFollowButton();
    if (active && (state.followEnabled || force)) {
        const top = active.offsetTop - list.clientHeight / 2 + active.clientHeight / 2;
        list.scrollTo({ top: Math.max(0, top), behavior: force ? "auto" : "smooth" });
    }
}

function subtitlePlainText(timestamped = false) {
    return getRows().map((row) => {
        const text = String(row?.text ?? row?.content ?? "").trim();
        if (!timestamped) return text;
        return `[${formatTime(row?.start ?? row?.from ?? 0)}] ${text}`;
    }).filter(Boolean).join("\n");
}

function buildSrt() {
    const time = (seconds) => {
        const ms = Math.max(0, Math.round(Number(seconds || 0) * 1000));
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        const s = Math.floor((ms % 60000) / 1000);
        const milli = ms % 1000;
        return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(milli).padStart(3, "0")}`;
    };
    return getRows().map((row, index) => {
        const start = Number(row?.start ?? row?.from ?? 0);
        const end = Number(row?.end ?? row?.to ?? start + 3);
        return `${index + 1}\n${time(start)} --> ${time(end)}\n${String(row?.text ?? row?.content ?? "")}\n`;
    }).join("\n");
}

async function copyText(text, emptyMessage) {
    if (!String(text || "").trim()) throw new Error(emptyMessage);
    await navigator.clipboard.writeText(text);
    showToast("复制成功");
}

function showCopyFeedback(actionNode, defaultText = "") {
    if (!actionNode) return;
    const originalText = actionNode.dataset.originText || actionNode.textContent || defaultText;
    actionNode.dataset.originText = originalText;
    actionNode.classList.add("is-success");
    if (!actionNode.querySelector("img")) actionNode.textContent = "OK";
    const originalTooltip = actionNode.dataset.tooltip || defaultText || "复制";
    actionNode.dataset.tooltip = "已复制";
    showUiTooltip(actionNode);
    setTimeout(() => {
        actionNode.classList.remove("is-success");
        if (!actionNode.querySelector("img")) actionNode.textContent = originalText;
        actionNode.dataset.tooltip = originalTooltip;
        hideUiTooltip();
    }, 1000);
}

async function runTask(tasks, label) {
    state.busy = label;
    state.error = "";
    render();
    try {
        logPartScopeDiagnostic("task_request_identity", {
            feature: tasks.join(","),
            requestedBvid: getBvid().toLowerCase(),
            requestedCid: getActiveCid(),
            requestedTid: String(state.tabState?.activeTid || state.cache?.tid || "")
        });
        await runtimeMessage({
            action: "RUN_TASKS",
            tasks,
            force: true,
            bvid: getBvid(),
            taskContext: {
                cid: getActiveCid(),
                tid: String(state.tabState?.activeTid || state.cache?.tid || ""),
                partCount: Number(state.tabState?.activePartCount || 0)
            }
        });
        await refreshState({ quiet: true });
    } finally {
        state.busy = "";
        render();
    }
}

function startChatStream(text) {
    const messageId = `side_${Date.now().toString(36)}`;
    const requestPartKey = getActivePartKey();
    state.chatDraft = "";
    state.chatStreaming = { messageId, question: text, answer: "", partKey: requestPartKey };
    state.error = "";
    render();
    const port = chrome.runtime.connect({ name: "chat-stream" });
    state.chatPort = port;
    logPartScopeDiagnostic("task_request_identity", {
        feature: "chat",
        messageId,
        requestPartKey,
        requestedBvid: getBvid().toLowerCase(),
        requestedCid: getActiveCid(),
        requestedTid: String(state.tabState?.activeTid || state.cache?.tid || "")
    });
    port.onMessage.addListener((message) => {
        if (String(message?.messageId || "") !== messageId) return;
        const messagePartKey = String(message?.partKey || "");
        const currentPartKey = getActivePartKey();
        if (messagePartKey && messagePartKey !== currentPartKey) {
            logPartScopeDiagnostic("chat_stream_rejected", {
                feature: "chat",
                messageId,
                requestPartKey,
                messagePartKey,
                currentPartKey,
                reason: "part_key_mismatch"
            });
            return;
        }
        logPartScopeDiagnostic("chat_stream_accepted", {
            feature: "chat",
            messageId,
            requestPartKey,
            messagePartKey,
            currentPartKey,
            type: String(message?.type || "")
        }, `chat-stream:${messageId}:${message?.type || ""}`);
        if (message.type === "delta") {
            state.chatStreaming.answer += String(message.delta || "");
            const answerNode = document.querySelector('[data-streaming-answer="true"] .chat-item');
            if (answerNode) {
                answerNode.innerHTML = globalThis.MarkdownRenderer?.render(state.chatStreaming.answer)
                    || escapeHtml(state.chatStreaming.answer);
            }
            const list = document.querySelector(".chat-display-area");
            if (list) list.scrollTop = list.scrollHeight;
            return;
        }
        if (message.type === "done" || message.type === "aborted") {
            const completed = state.chatStreaming;
            if (message.type === "done" && completed) {
                state.cache = {
                    ...(state.cache || {}),
                    history: [
                        ...(Array.isArray(state.cache?.history) ? state.cache.history : []),
                        { role: "user", content: completed.question },
                        { role: "assistant", content: message.answer || completed.answer, metrics: message.metrics || null }
                    ]
                };
            }
            state.chatStreaming = null;
            state.chatPort = null;
            port.disconnect();
            render();
            requestAnimationFrame(() => {
                const list = document.querySelector(".chat-display-area");
                if (list) list.scrollTop = list.scrollHeight;
            });
            setTimeout(() => refreshState({ quiet: true }), 300);
            return;
        }
        if (message.type === "error") {
            state.error = message.error || "聊天失败";
            state.chatStreaming = null;
            state.chatPort = null;
            port.disconnect();
            refreshState({ quiet: true });
        }
    });
    port.onDisconnect.addListener(() => {
        if (state.chatPort === port) state.chatPort = null;
    });
    port.postMessage({
        action: "RUN_CHAT_STREAM",
        tabId: state.tabId,
        text,
        messageId,
        bvid: getBvid(),
        taskContext: {
            cid: getActiveCid(),
            tid: String(state.tabState?.activeTid || state.cache?.tid || ""),
            partCount: Number(state.tabState?.activePartCount || 0)
        }
    });
}

async function saveSettings({ silent = false, requestGroqPermission = false } = {}) {
    const current = state.settings || {};
    const provider = document.getElementById("setting-provider")?.value || current.provider || "modelscope";
    const apiKey = document.getElementById("setting-api-key")?.value.trim() || "";
    const modelSelectValue = document.getElementById("setting-model-select")?.value || "";
    const model = modelSelectValue && modelSelectValue !== "custom"
        ? modelSelectValue
        : document.getElementById("setting-model")?.value.trim() || "";
    const invalidKey = [apiKey, document.getElementById("setting-groq-key")?.value || "", document.getElementById("setting-siliconflow-key")?.value || "", document.getElementById("setting-mimo-key")?.value || ""]
        .find((value) => /[\u3400-\u9fff]|\s/.test(String(value || "").trim()));
    if (invalidKey) throw new Error("API Key 不能包含中文或空格");
    const toneValue = Number(document.getElementById("setting-prompt-tone")?.value ?? 1);
    const detailValue = Number(document.getElementById("setting-prompt-detail")?.value ?? 1);
    const groqBaseUrlInput = document.getElementById("setting-groq-base-url");
    const groqBaseUrl = normalizeAsrBaseUrlInput(
        groqBaseUrlInput?.readOnly === false ? current.groqBaseUrl : groqBaseUrlInput?.value,
        DEFAULT_GROQ_ASR_BASE_URL
    );
    const customBaseUrlInput = document.getElementById("setting-base-url");
    const customBaseUrl = provider === "custom"
        ? normalizeHttpsBaseUrlInput(customBaseUrlInput?.value)
        : ensureHttpsUrlPrefixInput(current.customBaseUrl);
    if (provider === "custom" && customBaseUrlInput && customBaseUrl) customBaseUrlInput.value = customBaseUrl;
    const requestedAsrProvider = String(document.getElementById("setting-asr-provider")?.value || "groq").toLowerCase();
    const asrProvider = ["groq", "siliconflow", "mimo"].includes(requestedAsrProvider) ? requestedAsrProvider : "groq";
    const payload = {
        ...current,
        provider,
        apiKey,
        model,
        providerApiKeys: { ...(current.providerApiKeys || {}), [provider]: apiKey },
        providerModels: { ...(current.providerModels || {}), [provider]: model },
        customBaseUrl,
        customProtocol: document.getElementById("setting-custom-protocol")?.value || "openai",
        asrProvider,
        groqApiKey: document.getElementById("setting-groq-key")?.value.trim() || "",
        groqModel: document.getElementById("setting-groq-model")?.value.trim() || "whisper-large-v3-turbo",
        groqBaseUrl,
        siliconFlowApiKey: document.getElementById("setting-siliconflow-key")?.value.trim() || "",
        siliconFlowAsrModel: document.getElementById("setting-siliconflow-model")?.value.trim() || "FunAudioLLM/SenseVoiceSmall",
        mimoApiKey: document.getElementById("setting-mimo-key")?.value.trim() || "",
        mimoAsrModel: DEFAULT_MIMO_ASR_MODEL,
        themeMode: document.getElementById("setting-theme-mode")?.value || "system",
        prefMode: document.getElementById("setting-pref-mode")?.value || "quality",
        defaultOpenPage: document.getElementById("setting-default-page")?.value || "CC",
        pluginDisplayMode: document.getElementById("setting-plugin-display-mode")?.value === "collapsed" ? "collapsed" : "expanded",
        sentryEnabled: document.getElementById("setting-sentry")?.value === "true",
        disableCloudCacheRead: document.getElementById("setting-disable-cloud-all")?.checked === true,
        promptSettings: {
            ...(current.promptSettings || {}),
            mode: document.getElementById("setting-prompt-mode")?.value || "guided",
            guided: {
                ...((current.promptSettings || {}).guided || {}),
                tone: ["casual", "balanced", "professional"][toneValue] || "balanced",
                detail: ["brief", "normal", "detailed"][detailValue] || "normal"
            },
            custom: {
                ...((current.promptSettings || {}).custom || {}),
                summary: document.getElementById("setting-prompt-summary")?.value.trim() || "",
                segments: document.getElementById("setting-prompt-segments")?.value.trim() || "",
                rumors: document.getElementById("setting-prompt-rumors")?.value.trim() || ""
            }
        }
    };
    if (groqBaseUrl !== DEFAULT_GROQ_ASR_BASE_URL) {
        const permission = await runtimeMessage({
            action: "ENSURE_OPTIONAL_ORIGIN_PERMISSION",
            baseUrl: groqBaseUrl,
            request: requestGroqPermission
        });
        if (!permission?.granted) throw new Error("请点击 Base URL 旁的保存按钮并授权域名");
    }
    const result = await runtimeMessage({ action: "SAVE_SETTINGS", settings: payload });
    state.settings = result.settings || payload;
    state.renderSignature = "";
    applyThemeMode();
    const status = document.getElementById("settings-save-status");
    if (status) {
        status.textContent = "已保存";
        status.classList.add("show");
        setTimeout(() => status.classList.remove("show"), 1200);
    }
    if (!silent) showToast("设置已保存");
}

function scheduleSettingsSave() {
    clearTimeout(state.settingsSaveTimer);
    state.settingsSaveTimer = setTimeout(() => {
        saveSettings({ silent: true }).catch((error) => showToast(error?.message || "保存失败"));
    }, 500);
}

async function handleAction(actionNode) {
    const action = actionNode.dataset.action;
    if (action === "refresh") return refreshState({ hydrate: true });
    if (action === "switch-to-embedded") {
        state.switchingToEmbedded = true;
        const targetTabId = state.tabId || state.hiddenEmbeddedTabId;
        try {
            if (targetTabId) await setEmbeddedVisibleForTab(targetTabId, true);
            if (state.tabId) await contentAction("switch-to-embedded");
            state.hiddenEmbeddedTabId = 0;
            setTimeout(() => window.close(), 80);
        } catch (error) {
            state.switchingToEmbedded = false;
            throw error;
        }
        return;
    }
    if (action === "seek") return contentAction("seek", { time: Number(actionNode.dataset.time || 0) });
    if (action === "follow-now") {
        state.followEnabled = true;
        const playback = await contentAction("get-playback-state");
        if (playback.currentTime != null) syncSubtitlePlayback(Number(playback.currentTime), true);
        return;
    }
    if (action === "toggle-segments") {
        state.segmentsExpanded = !state.segmentsExpanded;
        render();
        return;
    }
    if (action === "dismiss-summary-mode") {
        state.settings = { ...(state.settings || {}), summaryModeNoticeSeen: true };
        await runtimeMessage({ action: "SAVE_SETTINGS", settings: state.settings });
        render();
        return;
    }
    if (action === "copy-row") {
        await copyText(actionNode.closest(".cc-row")?.querySelector(".cc-text")?.textContent, "暂无字幕");
        showCopyFeedback(actionNode, "复制");
        return;
    }
    if (action === "copy-chat") {
        await copyText(actionNode.closest(".chat-message-wrap")?.querySelector(".chat-item")?.textContent, "暂无回答");
        showCopyFeedback(actionNode, "复制");
        return;
    }
    if (action === "clear-search") {
        state.search = "";
        render();
        return;
    }
    if (action === "chat-suggest") {
        const input = document.getElementById("chat-input");
        if (input) {
            state.chatDraft = String(actionNode.dataset.text || "");
            state.chatGuideHidden = true;
            input.value = state.chatDraft;
            input.focus();
        }
        return;
    }
    if (action === "transcribe") return contentAction("transcribe");
    if (action === "go-asr-settings") {
        state.activePage = "settings";
        render();
        requestAnimationFrame(() => {
            document.getElementById("setting-asr-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        return;
    }
    if (action === "retranscribe") return contentAction("retranscribe");
    if (action === "subtitle-language-menu") return showSubtitleLanguageMenu(actionNode);
    if (action === "run-summary") return runTask(["summary", "segments"], "生成总结");
    if (action === "go-summary") {
        state.activePage = "summary";
        runtimeMessage({ action: "CLEAR_TASK_ERRORS", tasks: ["summary", "segments"] }).catch(() => {});
        if (state.tabState?.taskErrors) {
            state.tabState = {
                ...state.tabState,
                taskStatus: {
                    ...(state.tabState.taskStatus || {}),
                    summary: "idle",
                    segments: "idle"
                },
                taskErrors: {
                    ...(state.tabState.taskErrors || {}),
                    summary: null,
                    segments: null
                }
            };
        }
        render();
        return;
    }
    if (action === "run-rumors") return runTask(["rumors"], "验真");
    if (action === "copy-summary") {
        await copyText(state.cache?.summary, "暂无总结");
        showCopyFeedback(actionNode, "复制");
        return;
    }
    if (action === "copy-plain") return copyText(subtitlePlainText(false), "暂无字幕");
    if (action === "copy-timestamped") return copyText(subtitlePlainText(true), "暂无字幕");
    if (action === "export-srt") {
        const content = buildSrt();
        if (!content) throw new Error("暂无字幕");
        const url = URL.createObjectURL(new Blob([content], { type: "application/x-subrip;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = `${getBvid() || "subtitle"}.srt`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
    }
    if (action === "load-streams") {
        state.busy = "读取媒体流";
        render();
        try {
            state.streams = await contentAction("get-streams");
        } finally {
            state.busy = "";
            render();
        }
        return;
    }
    if (action === "download-stream") {
        const kind = actionNode.dataset.kind;
        const groupIndex = Number(actionNode.dataset.group || 0);
        const streamIndex = Number(actionNode.dataset.stream || 0);
        const prepared = await contentAction("prepare-download", { kind, groupIndex, streamIndex });
        await runtimeMessage({
            action: "DOWNLOAD_STREAM",
            payload: { url: prepared.url, filename: prepared.filename }
        });
        showToast("已开始下载");
        return;
    }
    if (action === "send-chat") {
        const input = document.getElementById("chat-input");
        const text = String(input?.value || "").trim();
        if (!text) return;
        startChatStream(text);
        return;
    }
    if (action === "stop-chat") {
        const streaming = state.chatStreaming;
        if (streaming && state.chatPort) {
            state.chatPort.postMessage({ action: "ABORT_CHAT_STREAM", tabId: state.tabId, messageId: streaming.messageId });
        }
        return;
    }
    if (action === "save-settings") return saveSettings();
    if (action === "toggle-secret") {
        const input = document.getElementById(actionNode.dataset.target);
        if (!input) return;
        input.type = input.type === "password" ? "text" : "password";
        actionNode.textContent = input.type === "password" ? "显示" : "隐藏";
        return;
    }
    if (action === "reset-prompts") {
        const defaults = globalThis.BilitatoContentSettings?.TASK_PROMPTS_DEFAULT || {};
        ["summary", "segments", "rumors"].forEach((key) => {
            const input = document.getElementById(`setting-prompt-${key}`);
            if (input) input.value = defaults[key] || "";
        });
        scheduleSettingsSave();
        return;
    }
    if (action === "delete-current-cache") {
        await deleteCurrentVideoCache();
        return;
    }
    if (action === "delete-all-cache") {
        await deleteAllVideoCache();
        return;
    }
    if (action === "open-setup-guide") {
        await contentAction("open-setup-guide");
        window.close();
        return;
    }
    if (action === "open-announcements") {
        await contentAction("open-announcements");
        state.announcementsUnread = false;
        window.close();
        return;
    }
    if (action === "goto-setup-guide") {
        state.activePage = "settings";
        render();
        return;
    }
    if (action === "open-external-url") {
        const url = String(actionNode.dataset.url || "").trim();
        if (url) return chrome.tabs.create({ url });
        return;
    }
    if (action === "open-extension-management") {
        await runtimeMessage({ action: "OPEN_EXTENSION_MANAGEMENT" });
        return;
    }
    if (action === "refresh-page") {
        await chrome.tabs.reload(state.tabId);
        return;
    }
    if (action === "open-register") {
        const url = String(actionNode.dataset.url || "").trim();
        if (!url) throw new Error("当前服务商没有注册链接");
        return chrome.tabs.create({ url });
    }
    if (action === "authorize-custom-origin") {
        const input = document.getElementById("setting-base-url");
        const baseUrl = normalizeHttpsBaseUrlInput(input?.value);
        if (!baseUrl) throw new Error("请先填写 Base URL");
        if (input) input.value = baseUrl;
        const permission = await runtimeMessage({
            action: "ENSURE_OPTIONAL_ORIGIN_PERMISSION",
            baseUrl,
            request: true
        });
        if (!permission?.granted) throw new Error("本次未完成授权，可以重新点击“授权当前域名”");
        showToast("域名授权成功");
        return;
    }
    if (action === "edit-groq-base-url") {
        const input = document.getElementById("setting-groq-base-url");
        if (!input) return;
        if (input.readOnly) {
            input.readOnly = false;
            actionNode.textContent = "保存";
            input.focus();
            input.select();
            return;
        }
        input.value = normalizeAsrBaseUrlInput(input.value, DEFAULT_GROQ_ASR_BASE_URL);
        input.readOnly = true;
        actionNode.textContent = "修改";
        try {
            await saveSettings({ requestGroqPermission: true });
        } catch (error) {
            input.readOnly = false;
            actionNode.textContent = "保存";
            throw error;
        }
        return;
    }
    if (action === "reset-groq-base-url") {
        const input = document.getElementById("setting-groq-base-url");
        if (!input) return;
        input.value = DEFAULT_GROQ_ASR_BASE_URL;
        input.readOnly = true;
        document.querySelector('[data-action="edit-groq-base-url"]')?.replaceChildren("修改");
        await saveSettings({ silent: true });
        showToast("已恢复 Groq 官方地址");
        return;
    }
    if (action === "open-help") return chrome.tabs.create({ url: "https://github.com/erikzhuang55/Bilitato" });
    if (action === "open-review") {
        const url = globalThis.BILITATO_STORE_CONFIG?.reviewUrl || "https://chromewebstore.google.com/";
        return chrome.tabs.create({ url });
    }
    if (action === "submit-feedback") {
        const title = document.getElementById("feedback-title")?.value.trim() || "";
        const content = document.getElementById("feedback-content")?.value.trim() || "";
        const type = document.getElementById("feedback-type")?.value || "bug";
        const includeLogs = document.getElementById("feedback-include-logs")?.checked !== false;
        if (!isMeaningfulFeedbackText(title)) throw new Error("标题不能为空哦");
        if (!isMeaningfulFeedbackText(content)) throw new Error("内容不能为空哦");
        const logs = includeLogs ? (await runtimeMessage({ action: "GET_LOGS" })).logs || [] : [];
        const result = await runtimeMessage({
            action: "SUBMIT_FEEDBACK",
            type,
            title,
            content,
            bvid: getBvid(),
            includeLogs,
            logs
        });
        state.feedback = result.feedback || state.feedback;
        state.feedbackDraft = { type: "bug", title: "", content: "", includeLogs: true };
        render();
        showToast("反馈提交成功");
    }
}

async function deleteCurrentVideoCache() {
    const bvid = getBvid();
    if (!bvid) throw new Error("未获取到当前视频");
    if (!window.confirm("确定删除当前视频的 AI 结果缓存吗？会清除总结、分段、聊天记录和验真结果，本地字幕缓存会保留。")) return;
    const result = await runtimeMessage({ action: "DELETE_VIDEO_CACHE", bvid });
    state.cache = null;
    await updateCloudCacheReadPref("current", true, { silent: true, render: false });
    const currentCheckbox = document.getElementById("setting-disable-cloud-current");
    if (currentCheckbox) currentCheckbox.checked = true;
    await refreshState({ quiet: true, skipCloud: true });
    showToast("已删除当前视频 AI 结果缓存，并已关闭本视频云端缓存拉取");
    return result;
}

async function deleteAllVideoCache() {
    if (!window.confirm("确定删除所有视频的 AI 结果缓存吗？会清除总结、分段、聊天记录和验真结果，本地字幕缓存会保留。")) return;
    const result = await runtimeMessage({ action: "DELETE_ALL_VIDEO_CACHE" });
    state.cache = null;
    await updateCloudCacheReadPref("all", true, { silent: true, render: false });
    const allCheckbox = document.getElementById("setting-disable-cloud-all");
    if (allCheckbox) allCheckbox.checked = true;
    await refreshState({ quiet: true, skipCloud: true });
    showToast(`已删除 ${Number(result?.deleted || 0)} 条 AI 结果缓存，并已关闭所有视频云端缓存拉取`);
    return result;
}

async function updateCloudCacheReadPref(scope, disabled, options = {}) {
    const result = await runtimeMessage({
        action: "SET_CLOUD_CACHE_READ_PREF",
        scope,
        disabled,
        bvid: getBvid()
    });
    if (result.settings) state.settings = result.settings;
    state.cloudCachePrefs = normalizeCloudCachePrefs(result.cloudCachePrefs);
    if (options.render !== false) render();
    if (!options.silent) showToast("缓存设置已保存");
}

app.addEventListener("click", (event) => {
    hideUiTooltip();
    const nav = event.target.closest("[data-nav]");
    if (nav) {
        if (nav.dataset.nav === "copy" || nav.dataset.nav === "export") {
            showActionMenu(nav.dataset.nav, nav);
            return;
        }
        state.activePage = nav.dataset.nav;
        if (state.activePage === "settings" && Number(state.feedback?.unreadCount || 0) > 0) {
            runtimeMessage({ action: "MARK_FEEDBACK_SEEN" }).then((result) => {
                state.feedback = result.feedback || state.feedback;
            }).catch(() => {});
        }
        render();
        return;
    }
    const actionNode = event.target.closest("[data-action]");
    if (!actionNode) return;
    handleAction(actionNode).catch((error) => {
        state.error = error?.message || "操作失败";
        render();
    });
});

app.addEventListener("mouseover", (event) => {
    const target = event.target.closest("[data-tooltip]");
    if (target && !target.contains(event.relatedTarget)) showUiTooltip(target);
});

app.addEventListener("mouseout", (event) => {
    const target = event.target.closest("[data-tooltip]");
    if (target && !target.contains(event.relatedTarget)) hideUiTooltip();
});

app.addEventListener("focusin", (event) => {
    const target = event.target.closest("[data-tooltip]");
    if (target) showUiTooltip(target);
});

app.addEventListener("focusout", hideUiTooltip);
app.addEventListener("focusout", (event) => {
    if (event.target.id !== "setting-base-url") return;
    const prefixed = ensureHttpsUrlPrefixInput(event.target.value);
    if (prefixed) event.target.value = prefixed;
});

app.addEventListener("input", (event) => {
    if (event.target.id === "chat-input") {
        state.chatDraft = event.target.value;
        if (state.chatDraft.trim()) {
            state.chatGuideHidden = true;
            document.querySelector(".chat-greeting")?.remove();
            document.querySelector(".chat-suggest-list")?.remove();
        }
        return;
    }
    if (event.target.id === "subtitle-search") {
        state.search = event.target.value;
        render();
        const input = document.getElementById("subtitle-search");
        input?.focus();
        input?.setSelectionRange(state.search.length, state.search.length);
        return;
    }
    if (event.target.id?.startsWith("setting-") && event.target.dataset.manualSave !== "true") {
        if (event.target.tagName === "TEXTAREA") {
            const count = event.target.parentElement?.querySelector(".prompt-char-count");
            if (count) count.textContent = `${event.target.value.length}/1000`;
        }
        scheduleSettingsSave();
        return;
    }
    if (event.target.id === "feedback-title" || event.target.id === "feedback-content") {
        state.feedbackDraft[event.target.id === "feedback-title" ? "title" : "content"] = event.target.value;
    }
});

app.addEventListener("change", (event) => {
    if (event.target.id === "setting-provider") {
        const button = document.getElementById("setting-provider-register");
        const selectedProvider = state.providers?.[event.target.value] || {};
        const url = String(selectedProvider.regUrl || "");
        if (button) {
            button.dataset.url = url;
            button.disabled = !url;
        }
        const tag = document.getElementById("setting-provider-tag");
        if (tag) {
            tag.textContent = String(selectedProvider.note || "");
            tag.classList.toggle("settings-hidden", !tag.textContent);
        }
        document.getElementById("setting-model-info")
            ?.classList.toggle("settings-hidden", event.target.value !== "modelscope");
        document.getElementById("setting-custom-provider-fields")
            ?.classList.toggle("settings-hidden", event.target.value !== "custom");
        const modelSelect = document.getElementById("setting-model-select");
        const modelInput = document.getElementById("setting-model");
        const apiInput = document.getElementById("setting-api-key");
        const models = state.settingsUiOptions.providerModels?.[event.target.value] || [];
        const savedModel = resolveProviderModelValue(event.target.value, state.settings?.providerModels?.[event.target.value] || models[0] || "");
        if (apiInput) apiInput.value = state.settings?.providerApiKeys?.[event.target.value] || "";
        if (modelSelect) {
            modelSelect.nextElementSibling?.classList.contains("custom-select-container") && modelSelect.nextElementSibling.remove();
            modelSelect.innerHTML = `${models.map((model) => `<option value="${escapeHtml(model)}" ${model === savedModel ? "selected" : ""}>${escapeHtml(model)}</option>`).join("")}<option value="custom" ${models.includes(savedModel) ? "" : "selected"}>自定义</option>`;
            enhanceSettingsSelects();
        }
        if (modelInput) {
            modelInput.value = savedModel;
            modelInput.classList.toggle("settings-hidden", models.includes(savedModel));
        }
    }
    if (event.target.id === "setting-asr-provider") {
        const button = document.getElementById("setting-asr-register");
        if (button) {
            button.dataset.url = event.target.value === "siliconflow"
                ? "https://cloud.siliconflow.cn/account/ak"
                : (event.target.value === "mimo" ? "https://platform.xiaomimimo.com/" : "https://console.groq.com/keys");
            button.disabled = !button.dataset.url;
        }
        document.getElementById("setting-asr-groq-fields")?.classList.toggle("settings-hidden", event.target.value !== "groq");
        document.getElementById("setting-asr-siliconflow-fields")?.classList.toggle("settings-hidden", event.target.value !== "siliconflow");
        document.getElementById("setting-asr-mimo-fields")?.classList.toggle("settings-hidden", event.target.value !== "mimo");
    }
    if (event.target.id === "setting-prompt-mode") {
        document.getElementById("setting-prompt-guided-fields")?.classList.toggle("settings-hidden", event.target.value === "custom");
        document.getElementById("setting-prompt-custom-fields")?.classList.toggle("settings-hidden", event.target.value !== "custom");
    }
    if (event.target.id === "setting-model-select") {
        const input = document.getElementById("setting-model");
        if (input) input.classList.toggle("settings-hidden", event.target.value !== "custom");
    }
    if (event.target.id === "setting-disable-cloud-current") {
        updateCloudCacheReadPref("current", !!event.target.checked).catch((error) => {
            event.target.checked = !event.target.checked;
            showToast(error?.message || "保存失败");
        });
        return;
    }
    if (event.target.id === "setting-disable-cloud-all") {
        updateCloudCacheReadPref("all", !!event.target.checked).catch((error) => {
            event.target.checked = !event.target.checked;
            showToast(error?.message || "保存失败");
        });
        return;
    }
    if (event.target.id === "setting-plugin-display-mode") markPluginDisplayFeatureSeen();
    if (event.target.id?.startsWith("setting-") && event.target.dataset.manualSave !== "true") scheduleSettingsSave();
    if (event.target.id === "feedback-type") state.feedbackDraft.type = event.target.value;
    if (event.target.id === "feedback-include-logs") state.feedbackDraft.includeLogs = event.target.checked;
});

app.addEventListener("scroll", (event) => {
    if (event.target.classList?.contains("settings-scroll-body")) {
        state.settingsScrollTop = event.target.scrollTop;
    }
}, true);

app.addEventListener("keydown", (event) => {
    if (event.target.id !== "chat-input" || event.key !== "Enter" || event.isComposing || event.ctrlKey) return;
    event.preventDefault();
    const text = String(event.target.value || "").trim();
    if (text && !state.chatStreaming) startChatStream(text);
});

chrome.storage.onChanged.addListener((changes) => {
    const summaryDraftKeys = Object.keys(changes || {}).filter((key) => key.startsWith(SUMMARY_DRAFT_STORAGE_PREFIX));
    summaryDraftKeys.forEach((key) => {
        const draft = changes[key]?.newValue;
        const draftBvid = String(draft?.bvid || key.slice(SUMMARY_DRAFT_STORAGE_PREFIX.length)).trim().toLowerCase();
        if (draft && draftBvid && draftBvid === String(state.activeBvid || "").trim().toLowerCase()) {
            state.summaryStreamDraft = draft;
        } else if (!draft && (!state.summaryStreamDraft?.bvid || draftBvid === String(state.summaryStreamDraft.bvid).toLowerCase())) {
            state.summaryStreamDraft = null;
        }
    });
    if (summaryDraftKeys.length) render();
    if (Object.keys(changes || {}).some((key) => key.startsWith("topAnnouncementDismissed:"))) {
        refreshAnnouncementUnreadState().catch(() => {});
    }
    if (Object.keys(changes || {}).some((key) => key === "settings" || key === "cloudReadDisabledBvids" || key.startsWith("cache_") || key.startsWith("tabState_"))) {
        refreshState({ quiet: true });
    }
});

chrome.runtime.onMessage.addListener((message) => {
    const action = String(message?.action || "");
    const messageBvid = String(message?.bvid || message?.draft?.bvid || "").trim().toLowerCase();
    const currentBvid = String(state.activeBvid || "").trim().toLowerCase();
    if (!messageBvid || !currentBvid || messageBvid !== currentBvid) return false;
    if (action === "SUMMARY_STREAM_UPDATE" && message?.draft) {
        if (Number(message.draft.updatedAt || 0) >= Number(state.summaryStreamDraft?.updatedAt || 0)) {
            state.summaryStreamDraft = message.draft;
            render();
        }
    } else if (action === "SUMMARY_STREAM_CLEAR") {
        state.summaryStreamDraft = null;
        render();
    }
    return false;
});

chrome.tabs.onActivated.addListener(() => refreshState({ quiet: true }));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === state.tabId && (changeInfo.url || changeInfo.status === "complete")) {
        refreshState({ quiet: true });
    }
});

window.addEventListener("pagehide", () => {
    restoreHiddenEmbedded();
});
window.addEventListener("beforeunload", () => {
    restoreHiddenEmbedded();
});

refreshState({ hydrate: true, refreshFeedback: true });
setInterval(() => refreshState({ quiet: true }), 1500);
setInterval(async () => {
    if (state.activePage !== "CC" || !state.tabId || document.hidden) return;
    try {
        const playback = await contentAction("get-playback-state");
        if (playback.currentTime != null) syncSubtitlePlayback(Number(playback.currentTime));
    } catch (_) {}
}, 500);
