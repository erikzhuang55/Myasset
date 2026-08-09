import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const buildScript = readFileSync(new URL("../scripts/build-release.js", import.meta.url), "utf8");
const sourceBuildScript = readFileSync(new URL("../scripts/build-firefox-source.js", import.meta.url), "utf8");
const amoBuildInstructions = readFileSync(new URL("../AMO_BUILD.md", import.meta.url), "utf8");
const background = readFileSync(new URL("../background.js", import.meta.url), "utf8");
const content = readFileSync(new URL("../content.js", import.meta.url), "utf8");
const contentCss = readFileSync(new URL("../content.css", import.meta.url), "utf8");
const releaseNotice = readFileSync(new URL("../content/contentReleaseNotice.js", import.meta.url), "utf8");
const sidepanel = readFileSync(new URL("../sidepanel.js", import.meta.url), "utf8");
const sidepanelHtml = readFileSync(new URL("../sidepanel.html", import.meta.url), "utf8");
const sidepanelCss = readFileSync(new URL("../sidepanel.css", import.meta.url), "utf8");
const offscreen = readFileSync(new URL("../offscreen.js", import.meta.url), "utf8");
const inject = readFileSync(new URL("../inject.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const videoCacheCidMigration = readFileSync(new URL("../supabase/migrations/20260710095455_add_cid_isolation_to_video_cache.sql", import.meta.url), "utf8");
const controlledVideoCacheMigration = readFileSync(new URL("../supabase/migrations/20260805185947_add_controlled_video_cache_upsert.sql", import.meta.url), "utf8");
const announcementsMigration = readFileSync(new URL("../supabase/migrations/20260807203733_add_extension_announcements.sql", import.meta.url), "utf8");

describe("native side panel", () => {
  it("declares the Chrome side panel entry and permissions", () => {
    expect(manifest.permissions).toContain("sidePanel");
    expect(manifest.permissions).toContain("webRequest");
    expect(manifest.permissions).not.toContain("tabs");
    expect(manifest.side_panel?.default_path).toBe("sidepanel.html");
    expect(manifest.host_permissions).toContain("*://*.bilibili.com/*");
    expect(manifest.host_permissions).not.toContain("https://api.bilibili.com/*");
  });

  it("includes side panel files in release packages", () => {
    expect(buildScript).toContain('"sidepanel.html"');
    expect(buildScript).toContain('"sidepanel.css"');
    expect(buildScript).toContain('"sidepanel.js"');
    expect(buildScript).toContain('"vendor"');
  });

  it("loads and caches remote model configuration without Realtime", () => {
    expect(background).toContain('SUPABASE_REMOTE_CONFIG_TABLE = "extension_remote_config"');
    expect(background).not.toContain("createRemoteConfigRealtimeSubscription");
    expect(background).toContain("segments_ai_json_repair");
    expect(background).toContain('refreshRemoteConfig(settings, "service_worker_start")');
    expect(background).toContain("isRemoteConfigCacheFresh(remoteConfigFetchedAt)");
    expect(background).toContain("fetchedVersion: remoteConfigFetchedVersion");
    expect(content).toContain('action === "REMOTE_CONFIG_UPDATED"');
    expect(content).toContain("appState?.providers?.[key]?.models");
  });

  it("connects opening, state reads, and page actions", () => {
    expect(background).toContain('msg.action === "OPEN_SIDE_PANEL"');
    expect(background).toContain('msg.action === "CLEAR_TASK_ERRORS"');
    expect(background).toContain("setPanelBehavior({ openPanelOnActionClick: true })");
    expect(content).toContain('"SIDE_PANEL_CONTENT_ACTION"');
    expect(sidepanel).toContain('action: "GET_BOOTSTRAP"');
    expect(sidepanel).toContain('action: "RUN_TASKS"');
    expect(sidepanel).toContain('action: "RUN_CHAT_STREAM"');
    expect(sidepanel).toContain('data-streaming-answer="true"');
    expect(sidepanel).toContain("list.scrollTop = list.scrollHeight");
    expect(sidepanel).toContain('action: "SAVE_SETTINGS"');
  });

  it("hides embedded UI while the native side panel is open", () => {
    expect(content).toContain('command === "set-embedded-visible"');
    expect(content).toContain("function setEmbeddedPanelVisible");
    expect(sidepanel).toContain("hideEmbeddedForActiveTab");
    expect(sidepanel).toContain("restoreHiddenEmbedded");
    expect(sidepanel).toContain("switchingToEmbedded");
    expect(sidepanel).toContain("if (!state.switchingToEmbedded)");
    expect(sidepanel).toContain('command: "set-embedded-visible"');
    expect(sidepanel).toContain('window.addEventListener("pagehide"');
  });

  it("checks database driven update availability without frequent polling", () => {
    expect(manifest.version).toBe("1.6.4");
    expect(background).toContain('msg.action === "CHECK_LATEST_VERSION"');
    expect(background).toContain('msg.action === "OPEN_EXTENSION_MANAGEMENT"');
    expect(background).toContain("VERSION_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000");
    expect(background).toContain("SUPABASE_DEFAULT_VERSION_TABLE");
    expect(background).toContain("extension_versions");
    expect(content).toContain("version-update-badge");
    expect(content).toContain('action: "CHECK_LATEST_VERSION"');
    expect(content).toContain('action: "OPEN_EXTENSION_MANAGEMENT"');
    expect(content).toContain("showDebugVersionUpdateBadge");
    expect(content).toContain('data-action="debug-show-version-update"');
    expect(content).toContain(">有可用版本更新</button>");
    expect(content).toContain('data-button-tooltip="跳转插件页后请在左上角找到“更新”按钮以更新插件"');
    expect(content).not.toContain("有可用版本更新 v${latest}");
    expect(sidepanel).toContain("version-update-badge");
    expect(sidepanel).toContain("checkLatestVersionAvailability");
    expect(sidepanel).toContain(">有可用版本更新</button>");
    expect(sidepanel).toContain('data-tooltip="跳转插件页后请在左上角找到“更新”按钮以更新插件"');
    expect(sidepanel).not.toContain("有可用版本更新 v${latest}");
  });

  it("ships the 1.6.4 release notice pages", () => {
    expect(releaseNotice).toContain('"1.6.4"');
    expect(releaseNotice).toContain("Bilitato 已更新至 v1.6.4");
    expect(releaseNotice).toContain("修复生成中切 P 出现旧错误");
    expect(releaseNotice).toContain("修复进度条完成后不消失");
    expect(releaseNotice).toContain('majorHistory.push("1.6.4", "1.6.3", "1.6.2"');
    expect(releaseNotice).toContain('"1.6.3"');
    expect(releaseNotice).toContain("Bilitato 已更新至 v1.6.3");
    expect(releaseNotice).toContain("修复分 P 字幕切换闪烁");
    expect(releaseNotice).toContain("修复其他 Provider 错用 Qwen 降级");
    expect(releaseNotice).toContain("新增公告中心");
    expect(releaseNotice).toContain('majorHistory.push("1.6.3", "1.6.2", "1.6.1"');
    expect(releaseNotice).toContain('"1.6.2"');
    expect(releaseNotice).toContain("Bilitato 已更新至 v1.6.2");
    expect(releaseNotice).toContain("兜底机制大修复");
    expect(releaseNotice).toContain("修复已有字幕却无法总结");
    expect(releaseNotice).toContain("修复分 P 路由误判");
    expect(releaseNotice).toContain('majorHistory.push("1.6.2", "1.6.1", "1.6.0"');
    expect(releaseNotice).toContain('"1.6.1"');
    expect(releaseNotice).toContain("Bilitato 已更新至 v1.6.1");
    expect(releaseNotice).toContain("远程配置更轻量");
    expect(releaseNotice).toContain("更新 ModelScope 模型列表");
    expect(releaseNotice).toContain('"1.6.0"');
    expect(releaseNotice).toContain("Bilitato 已更新至 v1.6");
    expect(releaseNotice).toContain("AI 返回异常时自动恢复");
    expect(releaseNotice).toContain("修复高清下载链接失效或变成网页");
    expect(releaseNotice).toContain("高清下载模式");
    expect(releaseNotice).toMatch(/title: "高清下载模式",[\s\S]*?highlight: true/);
    expect(releaseNotice).toMatch(/title: "新增 MiMo 语音识别",[^}]*desc:[^}]*\},/);
    expect(releaseNotice).not.toMatch(/title: "新增 MiMo 语音识别",[^}]*highlight: true/);
    expect(releaseNotice).toContain('majorHistory.push("1.6.1", "1.6.0", "1.5.x"');
    expect(releaseNotice).toContain('majorHistory.push("1.6.0", "1.5.x"');
    expect(releaseNotice).toContain('"1.5.x"');
    expect(releaseNotice).toContain("Bilitato v1.5 系列更新回顾");
    expect(releaseNotice).toContain("插件显示模式");
    expect(releaseNotice).toContain("修复分 P 视频内容串线");
    expect(releaseNotice).toContain("浏览器侧边栏模式");
    expect(releaseNotice).toContain('"1.4.x"');
    expect(releaseNotice).toContain("Bilitato v1.4 系列更新回顾");
    expect(releaseNotice).toContain('majorHistory.push("1.5.x", "1.4.x"');
  });

  it("applies theme settings to release notice and setup guide overlays", () => {
    expect(releaseNotice).toContain('overlay.dataset.theme = box.dataset.theme || "light"');
    expect(content).toContain('guideOverlay.dataset.theme = theme');
    expect(content).toContain('releaseOverlay.dataset.theme = theme');
    expect(content).toContain('overlay.dataset.theme = resolveThemeMode()');
    expect(contentCss).toContain('#setup-guide-overlay[data-theme="dark"] .guide-card');
    expect(contentCss).toContain('.release-notice-overlay[data-theme="dark"] .release-notice-card');
    expect(sidepanel).toContain('document.querySelector(".release-notice-overlay")?.setAttribute("data-theme", theme)');
  });

  it("keeps the embedded release notice above the header metrics control", () => {
    const metricsLayer = Number(contentCss.match(/\.logo-remaining-container\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1]);
    const releaseLayer = Number(contentCss.match(/\.release-notice-overlay\s*\{[\s\S]*?z-index:\s*(\d+)/)?.[1]);

    expect(releaseLayer).toBeGreaterThan(metricsLayer);
  });

  it("builds a Firefox package with sidebar and background-page compatibility", () => {
    expect(buildScript).toContain("firefox:");
    expect(buildScript).toContain('permission !== "offscreen" && permission !== "sidePanel"');
    expect(buildScript).toContain("delete targetManifest.side_panel");
    expect(buildScript).toContain("targetManifest.sidebar_action");
    expect(buildScript).toContain('scripts: ["background.js"]');
    expect(buildScript).toContain('optional: ["technicalAndInteraction"]');
    expect(background).toContain("chrome.sidebarAction.open()");
    expect(background).toContain("FIREFOX_OFFSCREEN_IFRAME_ID");
    expect(content).toContain("result.requiresToolbarAction");
  });

  it("ships a reproducible cross-platform Firefox source package", () => {
    expect(buildScript).not.toContain("powershell.exe");
    expect(buildScript).not.toContain("Compress-Archive");
    expect(buildScript).toContain("writeZipFromDirectory");
    expect(sourceBuildScript).toContain("AMO_BUILD.md");
    expect(sourceBuildScript).toContain("package-lock.json");
    expect(sourceBuildScript).not.toContain("node_modules");
    expect(amoBuildInstructions).toContain("npm ci");
    expect(amoBuildInstructions).toContain("npm run build:firefox");
  });

  it("temporarily expands a collapsed embedded panel for the release notice", () => {
    expect(content).toContain("...createEmbeddedReleaseNoticeHooks()");
    expect(content).toContain("restoreCollapsed = appState.isCollapsed");
    expect(content).toContain("if (restoreCollapsed) setPanelCollapsed(false)");
    expect(content).toContain("if (restoreCollapsed) setPanelCollapsed(true)");
    expect(releaseNotice).toContain("onOpen?.()");
    expect(releaseNotice).toContain("onClose?.()");
  });

  it("keeps the ModelScope preset list aligned with currently supported models", () => {
    const modelScopeList = content.match(/modelscope:\s*\[([\s\S]*?)\]/)?.[1] || "";
    expect(modelScopeList).not.toContain('"deepseek-ai/DeepSeek-V4-Flash"');
    expect(modelScopeList).toContain('"deepseek-ai/DeepSeek-V4-Pro"');
    expect(modelScopeList).toContain('"Qwen/Qwen3-30B-A3B-Instruct-2507"');
    expect(modelScopeList).toContain('"Qwen/Qwen3-30B-A3B"');
    expect(content).toContain("prioritizeRecommendedProviderModels(key, remoteModels)");
    expect(content.indexOf('"Qwen/Qwen3-30B-A3B-Instruct-2507"')).toBeLessThan(content.indexOf('"Qwen/Qwen3-30B-A3B"'));
    expect(modelScopeList).not.toContain('"deepseek-ai/DeepSeek-V3.2"');
    expect(modelScopeList).not.toContain('"ZhipuAI/GLM-5.2"');
    expect(modelScopeList).not.toContain('"ZhipuAI/GLM-4.7-Flash"');
    expect(modelScopeList).not.toContain('"stepfun-ai/Step-3.7-Flash"');
    expect(content).toContain("Qwen3-30B-A3B-Instruct-2507：200次/天");
    expect(content).toContain("Qwen3-235B-A22B-Instruct-2507：50次/天");
    expect(content).toContain("Qwen3-Coder-30B-A3B-Instruct：100次/天");
    expect(content).toContain("Qwen3-30B-A3B：200次/天");
    expect(content).toContain("DeepSeek-V4-Pro：20次/天");
    expect(content).toContain("DeepSeek-V4-Flash-0731：50次/天");
    expect(content).not.toContain("DeepSeek-V3.2：20次/天");
    expect(content).not.toContain("GLM-5.2：50次/天");
    expect(content).not.toContain("Step-3.7-Flash：50次/天");
    expect(content).toContain('MODELSCOPE_RECOMMENDED_MODELS.has(model) ? "推荐"');
    expect(content).toContain('option.querySelector(".model-recommended-tag")');
    expect(contentCss).toContain(".model-recommended-tag");
    expect(contentCss).toContain(".custom-option-main > span:first-child");
    expect(contentCss).toContain("text-overflow: ellipsis");
    expect(sidepanel).toContain('recommendedModelScopeModels.has(model) ? "（推荐）"');
    expect(sidepanel).toContain("recommendedModelScopeModelOrder.filter");
    expect(background).toContain('model: "Qwen/Qwen3-30B-A3B-Instruct-2507"');
    expect(background).toContain("LEGACY_MODELSCOPE_MODELS");
  });

  it("tracks ModelScope quota headers and uses compact segments first", () => {
    expect(background).toContain("modelscope-ratelimit-model-requests-limit");
    expect(background).toContain("x-modelscope-ratelimit-model-requests-limit");
    expect(background).toContain("x-ratelimit-model-requests-remaining");
    expect(background).toContain("modelscope-ratelimit-model-requests-remaining");
    expect(background).toContain("modelscope-ratelimit-requests-limit");
    expect(background).toContain("modelscope-ratelimit-requests-remaining");
    expect(background).toContain("getModelScopeDailyRequestLimit");
    expect(background).toContain('"qwen/qwen3-30b-a3b-instruct-2507": 200');
    expect(background).toContain('"deepseek-ai/deepseek-v4-flash-0731": 50');
    expect(background).toContain("onHeadersReceived");
    expect(background).toContain('provider === "modelscope"');
    expect(content).toContain("模型剩余");
    expect(sidepanel).toContain("账号剩余");
  });

  it("uses one wrapped side panel tooltip for settings info icons", () => {
    expect(sidepanelCss).toContain("max-width: min(320px, calc(100vw - 16px))");
    expect(sidepanelCss).toContain("white-space: normal");
    expect(sidepanelCss).toContain(".settings-info-icon:hover::after");
    expect(sidepanelCss).toContain("display: none !important");
  });

  it("supports official subtitle language switching", () => {
    expect(existsSync(new URL("../assets/ui/default/language.png", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../assets/ui/active/language.png", import.meta.url))).toBe(true);
    expect(content).toContain('data-action="cc-language-menu"');
    expect(content).toContain('command === "get-subtitle-options"');
    expect(content).toContain('command === "switch-subtitle-language"');
    expect(content).toContain("[data-action='cc-switch-language']");
    expect(content).toContain("clearDerived: true");
    expect(content).toContain(".bpx-player-ctrl-subtitle-major-inner");
    expect(content).toContain("switchSubtitleLanguageByDom");
    expect(content).toContain("mergeSubtitleOptions(apiOptions, domOptions)");
    expect(content).toContain("resolveSubtitleRowsForOption(option, { forceRefresh: true })");
    expect(content).toContain("saveOfficialSubtitleRows(resolved.option, resolved.rows, resolved.cached)");
    expect(content).toContain("function applyOfficialSubtitleVariantToLocalCache");
    expect(content).toContain("function syncBiliSubtitleDomLanguage");
    expect(content).toContain("syncBiliSubtitleDomLanguage(targetOption)");
    expect(content).toContain("function getLocalZhSubtitleRows");
    expect(content).toContain('if (targetKey === "zh")');
    expect(content).toContain("subtitleVariants: variants");
    expect(content).toContain("rawSubtitle: rows");
    expect(content).not.toContain("if (!rows.length && option?.domLabel)");
    expect(content).toContain("await switchSubtitleLanguageByDom(targetOption)");
    expect(content).not.toContain("该语种暂不支持直接切换");
    expect(content).toContain("BILI_SWITCH_SUBTITLE_LANGUAGE");
    expect(inject).toContain('event.data?.type === "BILI_SWITCH_SUBTITLE_LANGUAGE"');
    expect(inject).toContain("switchSubtitleLanguageByLabel");
    expect(content).toContain("BILI_ALLOW_SUBTITLE_RECAPTURE");
    expect(inject).toContain('event.data?.type === "BILI_ALLOW_SUBTITLE_RECAPTURE"');
    expect(background).toContain("subtitleLanguage");
    expect(background).toContain("function getChineseSubtitleCache");
    expect(background).toContain("const aiCache = getChineseSubtitleCache(cache)");
    expect(background).toContain("clearDerived");
    expect(sidepanel).toContain('contentAction("switch-subtitle-language"');
    expect(content).toContain("const canSwitchOfficialSubtitle = rows.length > 0 && !isAsrSubtitle && !running");
    expect(sidepanel).toContain("const languageButton = canSwitchOfficialSubtitle");
    expect(sidepanel).toContain("showSubtitleLanguageMenu");
    expect(sidepanelCss).toContain(".subtitle-language-option.active");
    expect(sidepanelCss).toContain('.ai-summary-plugin-box[data-theme="dark"] .metrics-box');
  });

  it("keeps automatic subtitle capture invisible without blocking manual controls", () => {
    expect(inject).toContain("if (!event.isTrusted) return");
    expect(inject).toContain("manualOverrideRouteKey === getRouteVideoKey()");
    expect(inject).toContain('userSubtitlePreference = { mode: "unknown", label: "" }');
    expect(inject).toContain('userSubtitlePreference = /关闭/.test(label)');
    expect(inject).toContain('userSubtitlePreference.mode === "on"');
    expect(inject).not.toContain('document.addEventListener("mouseover", (event) => {\n            release("mouseover", event);');
    expect(inject).toContain('document.addEventListener("mousedown", (event) => {\n            release("mousedown", event);');
    expect(inject).toContain("restoreSilentSessionState");
    expect(inject).toContain("finishSilentSession");
    expect(inject).toContain("const retryDelays = [0, 80, 200, 400, 800]");
    expect(inject).toContain('emitLog("subtitle_stealth_close_pending"');
    expect(inject).toContain('emitLog("subtitle_route_reset", { bvid: capturedBvid, reason });\n        performSilentAutoTrigger();\n        scheduleAutoTriggerFlow');
    expect(inject).toContain("const routeP = Math.max(1, Number(getRouteTid() || meta.p || 1))");
    expect(inject).toContain('`${meta.bvid}::p${routeP}`');
    expect(inject).not.toContain('`${meta.bvid}::${meta.cid || getRouteTid()}`');
    expect(content).toContain("allowDomOpen = false");
    expect(content).toContain("if (allowDomOpen && mergeSubtitleOptions(apiOptions, domOptions).length <= 1)");
  });

  it("defers subtitle follow scrolling until the new part player time settles", () => {
    expect(content).toContain("subtitleUiCoordinator.scrollUnlockAt = Number.POSITIVE_INFINITY");
    expect(content).toContain("armSubtitleScrollAlignment(routeKey, generation)");
    expect(content).toContain('document.addEventListener("loadedmetadata", onMediaEvent, true)');
    expect(content).toContain('document.addEventListener("durationchange", onMediaEvent, true)');
    expect(content).toContain('document.addEventListener("timeupdate", onMediaEvent, true)');
    expect(content).toContain('fallbackTimer = setTimeout(() => unlock("fallback", false), 5000)');
    expect(content).toContain("listNode.scrollTop = 0");
    expect(content).toContain("const rows = getCurrentSubtitleStateRows()");
    expect(content).not.toMatch(/scrollUnlockAt = Math\.max\([\s\S]*?subtitleUiCoordinator\.scrollUnlockAt,[\s\S]*?Date\.now\(\) \+ 300/);
  });

  it("deduplicates route, playinfo, and subtitle follow polling", () => {
    expect(inject.match(/setInterval\(\(\) =>/g)?.length || 0).toBe(1);
    expect(inject).not.toContain("new MutationObserver(() =>");
    expect(content).toContain("const playInfoWaiters = new Set()");
    expect(content).toContain("resolvePlayInfoWaiters(normalizedInfo)");
    expect(content).not.toContain("for (let i = 0; i < 30; i++)");
    expect(content).toContain("appState.focusTickerTimer = setInterval");
    expect(content).not.toContain("requestAnimationFrame(loop)");
  });

  it("keeps the CC panel loading while a subtitle request is in flight", () => {
    expect(content).toContain('event.data.event === "subtitle_request_start"');
    expect(content).toContain("extendSubtitleUiLoadingForRequest");
    expect(content).toContain('event.data.event === "subtitle_response_done"');
    expect(content).toContain("completeSubtitleUiRequest");
    expect(content).toContain("pendingRequestUrls: new Set()");
    expect(content).toContain('scheduleSubtitleUiDeadline(routeKey, generation, 10000, "timeout")');
    expect(content).toContain('scheduleSubtitleUiDeadline(subtitleUiCoordinator.routeKey, subtitleUiCoordinator.generation, SUBTITLE_CONTROL_RESULT_GRACE_MS, "unavailable")');
    expect(content).toContain('logSubtitleDiagnostic("ui_loading_extended"');
    expect(content).toContain('emptyTip.textContent = "正在读取字幕，请稍候..."');
  });

  it("keeps summary and verification locked while subtitles are still loading", () => {
    expect(content).toContain("function getCurrentSubtitleDependencyState()");
    expect(content).toContain('else if (["summary", "real"].includes(appState.activePage))');
    expect(content).toContain('if (subtitleState.status === "pending")');
    expect(content).toContain("renderSubtitlePendingState(subtitleState.detail)");
    expect(content).toContain('return "当前视频暂无字幕，无法开始验真"');
  });

  it("separates absent subtitles, capture failures, and slow subtitle responses", () => {
    expect(content).toContain('subtitleUiCoordinator.phase = "probing"');
    expect(content).toContain('source: "subtitle_control_absent"');
    expect(content).toContain('scheduleSubtitleUiDeadline(routeKey, generation, SUBTITLE_CONTROL_RESULT_GRACE_MS, "unavailable")');
    expect(content).toContain("function isUsableSubtitleControl(node)");
    expect(content).toContain("function isSubtitleControlBarReady()");
    expect(content).toContain("controlProbeObserver: null");
    expect(content).toContain('stableWindowMs: SUBTITLE_CONTROL_STABLE_MS');
    expect(content).toContain("Date.now() - startedAt >= SUBTITLE_PLAYER_READY_TIMEOUT_MS");
    expect(content).toContain('scheduleSubtitleUiDeadline(routeKey, generation, 10000, "timeout")');
    expect(content).toContain('data-action="${buttonAction}"');
    expect(content).toContain('const buttonAction = retryableSubtitleLoad ? "subtitle-load-retry" : (missingAsrApiKey ? "asr-open-settings" : "transcription-start")');
    expect(content).toContain('window.postMessage({ type: "BILI_RETRY_SUBTITLE_CAPTURE" }, "*")');
    expect(inject).toContain('event.data?.type === "BILI_RETRY_SUBTITLE_CAPTURE"');
  });

  it("detects missing subtitle controls independently from scroll alignment", () => {
    expect(content).not.toContain("if (!Number.isFinite(subtitleUiCoordinator.scrollUnlockAt))");
    expect(content).toMatch(/if \(isSubtitlePlayerReady\(\) && isSubtitleControlBarReady\(\)\)[\s\S]*?markSubtitleStateChanged\("subtitle_control_absent"\);/);
    expect(content).toMatch(/function isSubtitlePlayerReady\(\) \{[\s\S]*?return !!video && Number\(video\.readyState \|\| 0\) >= 1;/);
  });

  it("keeps subtitle fallback naming focused on transcription availability", () => {
    expect(content).toContain("function evaluateSubtitleFallback()");
    expect(content).toContain("function scheduleTranscriptionPrompt(meta)");
    expect(content).toContain("function scheduleTranscriptionAvailabilityCheck(source)");
    expect(content).toContain("function logPlayerApiCaptureDisabled(bvid)");
    expect(content).not.toContain("triggerDefaultSubtitleCapture");
    expect(content).not.toContain("scheduleSubtitleFallbackWatchdog");
    expect(content).not.toContain("fetchSubtitleByPlayerApi");
    expect(content).not.toContain("controlAvailable");
    expect(content).not.toContain("subtitleCaptureLock");
  });

  it("shows subtitle diagnostics only while debug mode is enabled", () => {
    expect(content).toMatch(/function logSubtitleDiagnostic\(event, detail = \{\}\) \{\s*if \(!isDebugLoggingEnabled\(\)\) return;/);
    expect(content).toContain('window.postMessage({ type: "BILI_SET_DEBUG_MODE", enabled: isDebugLoggingEnabled() }, "*")');
    expect(content).toContain('logSubtitleDiagnostic("source_disabled"');
    expect(content).toMatch(/function logPlayerApiCaptureDisabled\(bvid\) \{[\s\S]*?if \(appState\.playerApiDisabledLogKey === logKey\) return;[\s\S]*?appState\.playerApiDisabledLogKey = logKey;/);
    expect(inject).toContain("let subtitleDebugEnabled = false");
    expect(inject).toContain('event.data?.type === "BILI_SET_DEBUG_MODE"');
    expect(inject).toMatch(/function logSubtitleDiagnostic\(event, detail = \{\}\) \{\s*if \(!subtitleDebugEnabled\) return;/);
  });

  it("delegates full resets to the shared page reset", () => {
    expect(content).toMatch(/function resetAllState\(options = \{\}\) \{[\s\S]*?resetPageStateByBvidSwitch\(\{ preserveReadySubtitle \}\);[\s\S]*?clearStreamCache\(\);/);
  });

  it("allows the cached Chinese CC variant to replace the injected display", () => {
    expect(content).toMatch(/if \(targetKey === "zh"\)[\s\S]*?subtitleUiCoordinator\.displaySource = "language_switch"/);
    expect(content).toMatch(/if \(targetKey === "zh"\)[\s\S]*?source: "language_switch"[\s\S]*?replace: true/);
    expect(content).toMatch(/if \(targetKey === "zh"\)[\s\S]*?delete ccPanel\.dataset\.subtitleDiagRenderSignature/);
  });

  it("does not leave a ready subtitle route showing the stale loading DOM", () => {
    expect(content).toContain("doesCcDomMatchRows(panel, rows)");
    expect(content).toContain("doesCcDomMatchLoading(panel)");
    expect(content).toContain("delete panel.dataset.subtitleDiagRenderSignature");
    expect(content).toContain("delete container.dataset.subtitleDiagRenderSignature");
    expect(content).toContain("canDirectRenderCurrentRoute");
    expect(content).toContain('logSubtitleDiagnostic("direct_render_skipped"');
    expect(content).toContain('reason: payloadP && currentUrlP && payloadP !== currentUrlP ? "payload_p_mismatch" : "route_state_not_aligned"');
  });

  it("marks injected subtitles ready only after route-scoped rows are committed", () => {
    expect(content).not.toContain('markSubtitleUiReady("inject"');
    expect(content).toMatch(/subtitleUiCoordinator\.rows = list;[\s\S]*?subtitleUiCoordinator\.routeKey = routeKey;[\s\S]*?subtitleUiCoordinator\.rowsRouteKey = routeKey;[\s\S]*?subtitleUiCoordinator\.rowsCid = incomingCid \|\| currentCid \|\| 0;[\s\S]*?subtitleUiCoordinator\.phase = "ready";/);
    expect(content).toContain('reason: "rows_committed"');
    expect(content).toContain("if (unchanged && alreadyReadyForRoute) return false;");
    expect(content).toContain("readyTransition: !alreadyReadyForRoute");
  });

  it("records detailed resource timing for subtitle XHR requests", () => {
    expect(inject).toContain("logSubtitleResourceTiming(url, this, requestStartedAt, requestMeta)");
    expect(inject).toContain('logSubtitleDiagnostic("source_resource_timing"');
    expect(inject).toContain('emitLog("subtitle_resource_timing"');
    expect(inject).toContain("queueMs:");
    expect(inject).toContain("ttfbMs:");
    expect(inject).toContain("downloadMs:");
    expect(inject).toContain("nextHopProtocol");
  });

  it("stores ASR subtitles with the current part cid resolved from playurl", () => {
    expect(background).toContain("const effectiveCid = Number(media?.cid || media?.pageCid || cid || 0)");
    expect(background).toContain("cid: Number.isFinite(effectiveCid) ? effectiveCid : 0");
    expect(background).toContain("cid: Number(result?.identity?.cid || payload?.cid || 0)");
    expect(background).toContain("Number(params.get(\"p\") || state.p || fallbackData.page || 1)");
    expect(inject).toContain('_cid: Number.isFinite(currentCid) && currentCid > 0 ? currentCid : 0');
    expect(inject).toContain('emitLog("playinfo_stale_skip"');
    expect(inject).toContain("const stateMatchesRoute =");
    expect(content).toContain("const confirmedCid = await waitForConfirmedRouteCid(bvid)");
    expect(content).toContain("cid: confirmedCid");
  });

  it("restores existing ASR subtitles before starting another transcription", () => {
    expect(content).toContain("function getCurrentRouteCid()");
    expect(content).toContain("routeBvid === tabStateBvid");
    expect(content).toContain("function waitForConfirmedRouteCid(");
    expect(content).toContain('code: "PART_IDENTITY_PENDING"');
    expect(content).toContain('reason: "route_cid_pending"');
    expect(content).toContain('action: "SET_ACTIVE_PART"');
    expect(content).toContain("finishWithExistingSubtitle");
    expect(content).toContain("asrRequestDispatched: false");
    expect(content).toContain('action: "ABORT_TRANSCRIPTION"');
    expect(content).toContain('reason: "usable_subtitle_cache_arrived"');
    expect(background).toContain('const hasExplicitCid = Object.prototype.hasOwnProperty.call(msg || {}, "cid")');
    expect(background).toContain("cid: Number(hasExplicitCid ? msg.cid : (tabState?.activeCid || 0))");
    expect(background).toContain("Number(context?.partCount || 0) !== 1");
    expect(background).toContain("allowPendingSinglePartCid");
  });

  it("adds confirmed local cache cleanup actions in settings", () => {
    expect(background).toContain('msg.action === "DELETE_VIDEO_CACHE"');
    expect(background).toContain('msg.action === "DELETE_ALL_VIDEO_CACHE"');
    expect(background).toContain("buildDerivedCacheClearPatch");
    expect(background).not.toContain("cacheMemory.clear()");
    expect(content).toContain('data-action="settings-delete-current-cache"');
    expect(content).toContain('data-action="settings-delete-all-cache"');
    expect(content).toContain("本地字幕缓存会保留");
    expect(content).toContain('updateCloudCacheReadPref("current", true');
    expect(content).toContain('updateCloudCacheReadPref("all", true');
    expect(sidepanel).toContain('data-action="delete-current-cache"');
    expect(sidepanel).toContain('data-action="delete-all-cache"');
    expect(sidepanel).toContain("本地字幕缓存会保留");
    expect(sidepanel).toContain('updateCloudCacheReadPref("current", true');
    expect(sidepanel).toContain('updateCloudCacheReadPref("all", true');
  });

  it("adds cloud cache read controls in cache management", () => {
    expect(background).toContain("CLOUD_READ_DISABLED_BVIDS_KEY");
    expect(background).toContain('msg.action === "SET_CLOUD_CACHE_READ_PREF"');
    expect(background).toContain("shouldSkipCloudCacheRead");
    expect(content).toContain("缓存管理");
    expect(content).toContain("settings-disable-cloud-current");
    expect(content).toContain("settings-disable-cloud-all");
    expect(content).toContain("本视频不拉取云端缓存");
    expect(content).toContain("已由所有视频设置覆盖");
    expect(content).toContain("currentCloudDisabledAttr = currentBvid && !allCloudDisabledOn");
    expect(content).toContain("所有视频不拉取云端缓存");
    expect(sidepanel).toContain("setting-disable-cloud-current");
    expect(sidepanel).toContain("setting-disable-cloud-all");
    expect(sidepanel).toContain("currentCloudDisabledAttr = getBvid() && !allCloudDisabledOn");
  });

  it("does not show the empty summary call-to-action under task errors", () => {
    expect(sidepanel).toContain("const errorHtml = taskErrorHtml");
    expect(sidepanel).toContain('errorHtml ? ""');
  });

  it("reuses the embedded subtitle and summary presentation", () => {
    expect(sidepanelHtml).toContain('<script src="markdownRenderer.js"></script>');
    expect(sidepanel).toContain('class="cc-row"');
    expect(sidepanel).toContain("MarkdownRenderer?.render(summary)");
    expect(sidepanel).toContain('class="result-text summary-result-text"');
    expect(sidepanel).toContain('class="chat-display-area"');
    expect(sidepanel).toContain("Hello, Ask me anything!");
    expect(sidepanel).toContain('action === "chat-suggest"');
    expect(sidepanel).toContain('class="real-notice"');
    expect(sidepanel).toContain('class="settings-scroll-body"');
    expect(sidepanel).toContain('data-action="open-setup-guide"');
    expect(sidepanel).toContain('data-action="open-register"');
    expect(sidepanel).toContain('class="feedback-card"');
    expect(sidepanel).toContain('data-action="switch-to-embedded"');
    expect(sidepanel).toContain("state.settingsScrollTop");
    expect(sidepanel).toContain("state.chatDraft");
    expect(sidepanel).toContain("官方AI字幕");
    expect(sidepanel).toContain("生成 AI 总结");
    expect(sidepanel).toContain("enhanceSettingsSelects()");
    expect(sidepanel).toContain("showActionMenu(nav.dataset.nav, nav)");
    expect(sidepanel).toContain("个性化");
    expect(sidepanel).toContain("settings-action-row");
    expect(content).toContain("settings-theme-mode");
    expect(sidepanel).toContain("setting-theme-mode");
    expect(content).toContain("dataset.theme");
    expect(sidepanel).toContain("data-theme");
    expect(background).toContain('themeMode: "system"');
    expect(sidepanel).toContain("syncSubtitlePlayback");
    expect(sidepanel).toContain('data-action="follow-now"');
    expect(content).toContain('command === "get-playback-state"');
    expect(sidepanelCss).toContain(".custom-select-trigger");
    expect(sidepanelCss).toContain(".copy-option-menu");
    expect(sidepanel).toContain("hasTaskContent");
    expect(sidepanel).toContain("chatWasAtBottom");
    expect(sidepanel).toContain('taskStatus("segments") === "processing"');
    expect(sidepanel).toContain('data-tooltip="切换回内嵌插件"');
    expect(sidepanel).toContain("showUiTooltip");
    expect(sidepanelCss).toContain(".side-ui-tooltip::before");
    expect(sidepanel).toContain('class="ad-tag"');
    expect(sidepanelCss).toContain(".segment-card.ad");
    expect(sidepanel).toContain("is-success");
    expect(sidepanel).toContain("showCopyFeedback");
    expect(sidepanel).toContain("summaryWasAtBottom");
    expect(sidepanel).toContain("state.chatGuideHidden = false");
    expect(sidepanel).toContain("state.activePartKey !== nextPartKey");
    expect(sidepanel).toContain('if (kind === "copy") showCopyFeedback(anchor, "复制")');
    expect(sidepanel).toContain('showToast("反馈提交成功")');
    expect(sidepanelCss).toContain("z-index: 2147483647");
    expect(sidepanelCss).toContain(".panel-icon-btn.is-loading");
    expect(sidepanelCss).toContain(".settings-reset-btn");
    expect(sidepanelCss).toContain("word-break: keep-all");
    expect(content).toContain('command === "open-setup-guide"');
    expect(content).toContain('command === "switch-to-embedded"');
    expect(sidepanel).toContain('action: "RUN_CHAT_STREAM"');
    expect(sidepanel).toContain("scheduleSettingsSave()");
    expect(sidepanel).toContain('contentAction("prepare-download"');
    expect(content).toContain("function renderVideoDownloadModeMenu");
    expect(content).toContain('data-download-mode="quality"');
    expect(content).toContain('data-download-mode="compat"');
    expect(content).toContain("高清下载");
    expect(content).toContain("兼容下载");
    expect(content).toContain('class="download-codec-options"');
    expect(contentCss).toContain(".download-mode-option");
    expect(contentCss).toContain(".download-codec-options");
    expect(sidepanelHtml).toContain('content/contentErrorMessages.js');
    expect(sidepanelHtml).toContain('content/contentReleaseNotice.js');
    expect(background).toContain("msg?.tabId || port?.sender?.tab?.id");
    expect(background).toContain("fetchBiliPlayUrlForTab");
    expect(background).toContain("probeUrlStatusForTab");
    expect(background).toContain("? await probeUrlStatusForTab(tabId, url)");
    expect(background).toContain(": await probeUrlStatus(url)");
    expect(background).toContain('world: "MAIN"');
    expect(sidepanelCss).toContain(".cc-row:hover");
    expect(sidepanelCss).toContain(".chat-footer");
    expect(sidepanelCss).toContain(".claim-card.fake");
    expect(sidepanelCss).not.toContain("border-bottom: 1px solid #f1f2f3");
  });

  it("blocks transcription before task creation when the selected ASR key is missing", () => {
    expect(content).toContain("function getAsrApiKeyRequirement");
    expect(content).toContain('`请先填写${escapeHtml(asrKeyRequirement.providerName)}的API Key，再开始转录`');
    expect(content).toContain('missingAsrApiKey ? "去设置" : "开始在线转录"');
    expect(content).toContain('if (action === "asr-open-settings")');
    expect(sidepanel).toContain('asrKeyRequirement.missing ? `请先填写${escapeHtml(asrKeyRequirement.providerName)}的API Key，再开始转录`');
    expect(sidepanel).toContain('data-action="${asrKeyRequirement.missing && !running ? "go-asr-settings" : "transcribe"}"');
    expect(background.indexOf('if (!asrApiKey) {')).toBeLessThan(background.indexOf('const taskId = createUsageTaskId("transcribe")'));
    expect(background).toContain('eventName: "transcribe_preflight_blocked"');
  });

  it("caches feedback for six hours but refreshes once when the plugin opens", () => {
    expect(background).toContain("const FEEDBACK_CACHE_TTL_MS = 6 * 60 * 60 * 1000");
    expect(background).toContain("async function readCachedFeedbackState");
    expect(background).toContain("if (!force && !markSeen && cacheFresh) return cached");
    expect(content).toContain('refreshFeedback: true');
    expect(sidepanel).toContain('refreshState({ hydrate: true, refreshFeedback: true })');
  });

  it("migrates the bundled Sentry DSN without overwriting custom DSNs", () => {
    expect(background).toContain('const DEFAULT_SENTRY_DSN = "https://440bce86f646672341586eb09c859631@o4511769099501568.ingest.de.sentry.io/4511769123029072"');
    expect(background).toContain("const LEGACY_SENTRY_DSNS = new Set([");
    expect(background).toContain("LEGACY_SENTRY_DSNS.has(storedSentryDsn)");
    expect(background).toContain(": storedSentryDsn;");
  });

  it("positions generated segment markers across the full native chapter track", () => {
    expect(content).toContain('document.querySelector(".bpx-player-progress-wrap") || document.querySelector(".bpx-player-progress-schedule")');
    expect(content).toContain('host.querySelectorAll(".bpx-player-progress-schedule")');
    expect(content).toContain("const trackLeft = Math.min(...scheduleRects.map((rect) => rect.left))");
    expect(content).toContain("const trackRight = Math.max(...scheduleRects.map((rect) => rect.right))");
  });

  it("rejects empty or placeholder-only feedback before submission", () => {
    expect(background).toContain("function isMeaningfulFeedbackText(value)");
    expect(background).toContain("标题不能为空哦");
    expect(background).toContain("内容不能为空哦");
    expect(content).toContain("function isMeaningfulFeedbackText(value)");
    expect(content).toContain("if (!isMeaningfulFeedbackText(title))");
    expect(content).toContain("if (!isMeaningfulFeedbackText(content))");
    expect(sidepanel).toContain("function isMeaningfulFeedbackText(value)");
    expect(sidepanel).toContain("if (!isMeaningfulFeedbackText(title))");
    expect(sidepanel).toContain("if (!isMeaningfulFeedbackText(content))");
  });

  it("keeps transcription and AI generation mutually exclusive", () => {
    expect(content).toContain('code: "ASR_IN_PROGRESS"');
    expect(content).toContain('showToast("字幕转录中，请等待完成后再生成总结")');
    expect(content).toContain('code: "AI_TASK_IN_PROGRESS"');
    expect(content).toContain('showToast("总结生成中，请完成后再转录字幕")');
  });

  it("submits deduplicated feedback diagnostics with route and cache context", () => {
    expect(content).toContain("function buildFeedbackDiagnosticContext()");
    expect(content).toContain("diagnosticContext: buildFeedbackDiagnosticContext()");
    expect(background).toContain("function dedupeFeedbackLogs(");
    expect(background).toContain("route_context: msg?.diagnosticContext");
    expect(background).toContain("background_context:");
  });

  it("supports a default-collapsed embedded panel that expands after summary success", () => {
    expect(background).toContain('pluginDisplayMode: "collapsed"');
    expect(background).toContain("pluginDisplayFeatureSeen: true");
    expect(background).toContain('Object.prototype.hasOwnProperty.call(base, "pluginDisplayFeatureSeen")');
    expect(background).toContain('Object.keys(base).length > 0 ? "expanded"');
    expect(content).toContain('renderCustomSelect("settings-plugin-display-mode"');
    expect(sidepanel).toContain('id="setting-plugin-display-mode"');
    expect(content).toContain('class="settings-feature-label">插件显示');
    expect(sidepanel).toContain('class="settings-feature-label">插件显示');
    expect(content).not.toContain("插件显示区域");
    expect(sidepanel).not.toContain("插件显示区域");
    expect(content.indexOf('class="settings-feature-label">插件显示')).toBeLessThan(content.indexOf("<label>深/浅模式</label>"));
    expect(sidepanel.indexOf('class="settings-feature-label">插件显示')).toBeLessThan(sidepanel.indexOf("<label>深/浅模式</label>"));
    expect(content).toContain('class="collapsed-summary-btn"');
    expect(content).not.toContain('data-action="collapsed-open-settings"');
    expect(content).toContain("function resetPanelCollapseForCurrentPart()");
    expect(content).toContain('res?.taskResults?.summary === true');
    expect(content).toContain("beforeCid > 0 && activeCid > 0 && beforeCid !== activeCid");
    expect(content).toContain("_guideRestoreCollapsed = _guideSimulatesFirstInstall || appState.isCollapsed");
    expect(content).toContain("shouldRestoreCollapsed");
    expect(content).toContain("appState.activePage = previousPage");
    expect(content).toContain('data-action="debug-simulate-first-install"');
    expect(content).toContain("showSetupGuide({ simulateFirstInstall: true })");
    expect(content).toContain('_guideSimulatesFirstInstall ? "collapsed"');
    expect(content).toContain("Tips：你可以自定义插件显示效果");
    expect(content).toContain("点击 Bilitato 的标题栏来展开/收起");
    expect(content).toContain("const totalSteps = 4");
    expect(content).toContain('assets/ui/plugin-display-collapsed.png');
    expect(contentCss).toContain(".guide-display-tip-image");
    expect(content).toContain('setPanelCollapsed(shouldCollapse, { showHint: shouldCollapse })');
    expect(content).toContain('setPanelCollapsed(true, { showHint: true })');
    expect(content).toContain("已收起，点击标题栏展开");
    expect(contentCss).toContain("@keyframes collapse-header-landed");
    expect(contentCss).toContain("prefers-reduced-motion: reduce");
    expect(contentCss).toContain("margin-bottom: 10px !important");
    expect(content).toContain("summaryRatio: 0.7");
    expect(content).toContain("const expandedSummaryRatio = 0.6");
    expect(content).toContain("Math.min(Math.ceil(neededBoxHeight), Math.ceil(panelHeightLimit))");
    expect(content).toContain("summaryRatioManuallyAdjusted");
    expect(content).toContain("naturalSegmentsHeight");
    expect(content).toContain('summaryButton.dataset.action = hasSummary && !running ? "view-summary" : "run-summary"');
    expect(content).toContain('? "查看总结"');
    expect(content).toContain('? "重试总结"');
    expect(content).toContain('if (action === "view-summary")');
    expect(contentCss).toContain(".ai-summary-plugin-box.is-collapsed .collapsed-summary-btn");
    expect(contentCss).toContain(".ai-summary-plugin-box.is-collapsed .native-side-panel-btn");
    expect(content).toContain("shouldShowPluginDisplayFeatureDot()");
    expect(content).toContain("markPluginDisplayFeatureSeen()");
    expect(content).toContain('class="settings-feature-dot plugin-display-feature-dot"');
    expect(sidepanel).toContain("state.settings?.pluginDisplayFeatureSeen === false");
    expect(sidepanel).toContain('select.id === "setting-plugin-display-mode"');
    expect(sidepanel).toContain("function markPluginDisplayFeatureSeen()");
    expect(sidepanelCss).toContain(".settings-feature-dot");
  });

  it("supports remote announcement history with a dismissible title banner", () => {
    expect(content).toContain('id="plugin-top-announcement-slot"');
    expect(content).toContain('data-action="open-top-announcement"');
    expect(content).toContain('data-action="dismiss-top-announcement"');
    expect(content).toContain('data-action="close-top-announcement"');
    expect(content).toContain('data-action="announcement-page"');
    expect(content).toContain('const pageSize = 3');
    expect(content).toContain('selectedAnnouncement\n        ? [selectedAnnouncement]');
    expect(content).toContain('await markAnnouncementsRead([selectedKey])');
    expect(content).toContain('有最新公告，请及时查看');
    expect(content).toContain('announcement-unread-dot');
    expect(content).toContain('hasFeedbackUnread() || shouldShowPluginDisplayFeatureDot() || hasUnreadAnnouncements()');
    expect(content).toContain('topAnnouncementDismissed:${String(key || "").trim().toLowerCase()}');
    expect(content).toContain('action: "GET_ANNOUNCEMENTS"');
    expect(content).toContain('data-action="settings-open-announcements"');
    expect(sidepanel).toContain('data-action="open-announcements"');
    expect(sidepanel).toContain('announcementsUnread: false');
    expect(sidepanel).toContain('refreshAnnouncementUnreadState');
    expect(sidepanel).toContain('|| state.announcementsUnread');
    expect(background).toContain('SUPABASE_ANNOUNCEMENTS_TABLE = "extension_announcements"');
    expect(background).toContain('ANNOUNCEMENT_CACHE_TTL_MS = 6 * 60 * 60 * 1000');
    expect(background).toContain('msg.action === "GET_ANNOUNCEMENTS"');
    expect(content).toContain('https://modelscope.cn/my/overview');
    expect(content).toContain('每日登录赠送200魔粒');
    expect(contentCss).toContain('.ai-summary-plugin-box.is-collapsed .plugin-top-announcement-slot');
    expect(contentCss).toContain('.plugin-announcement-overlay[data-theme="dark"] .plugin-announcement-item');
    expect(announcementsMigration).toContain('create table if not exists public.extension_announcements');
    expect(announcementsMigration).toContain('alter table public.extension_announcements enable row level security');
    expect(announcementsMigration).toContain('to anon, authenticated');
    expect(announcementsMigration).toContain('using (is_published = true)');
    expect(announcementsMigration).toContain("'test_release_notice_2026_08'");
    expect(announcementsMigration).toContain("'test_service_notice_2026_08'");
  });

  it("supports a configurable Groq Base URL for regular and chunked transcription", () => {
    expect(background).toContain("groqBaseUrl: DEFAULT_GROQ_BASE_URL");
    expect(background).toContain('buildAsrEndpoint(baseUrl, "models", DEFAULT_GROQ_BASE_URL)');
    expect(background).toContain('buildAsrEndpoint(baseUrl, "audio/transcriptions", DEFAULT_GROQ_BASE_URL)');
    expect(background).toContain("baseUrl: String(options.baseUrl || DEFAULT_GROQ_BASE_URL)");
    expect(offscreen).toContain('buildAsrEndpoint(baseUrl, "audio/transcriptions", DEFAULT_GROQ_BASE_URL)');
    expect(content).toContain('data-action="settings-edit-groq-base-url"');
    expect(content).toContain('data-action="settings-reset-groq-base-url"');
    expect(sidepanel).toContain('data-action="edit-groq-base-url"');
    expect(sidepanel).toContain('data-action="reset-groq-base-url"');
    expect(content).toContain('DEFAULT_SILICONFLOW_ASR_BASE_URL = "https://api.siliconflow.cn/v1"');
    expect(sidepanel).toContain('DEFAULT_SILICONFLOW_ASR_BASE_URL = "https://api.siliconflow.cn/v1"');
  });

  it("supports Xiaomi MiMo transcription and removes the generic custom ASR provider", () => {
    expect(background).toContain('mimoApiKey: ""');
    expect(background).toContain("mimoAsrModel: MIMO_ASR_MODEL");
    expect(background).toContain('["groq", "siliconflow", "mimo"].includes(requestedAsrProvider)');
    expect(background).toContain("subtitleSource = asrProvider");
    expect(background).toContain('provider: asrProvider');
    expect(background).toContain('asrProvider === "mimo" || audioBlob.size >= asrMaxAudioBytes');
    expect(background).toContain('provider: String(payload?.provider || "groq")');
    expect(content).toContain('renderSecretInput("settings-mimo-api-key"');
    expect(content).toContain('id="settings-mimo-asr-model"');
    expect(sidepanel).toContain('secretField("setting-mimo-key"');
    expect(sidepanel).toContain('id="setting-mimo-model"');
    expect(offscreen).toContain('["groq", "siliconflow", "mimo"].includes(requestedProvider)');
    expect(offscreen).toContain('mimeType: isMimo ? "audio/mpeg" : "audio/mp4"');
    expect(offscreen).toContain('"libmp3lame"');
    expect(offscreen).toContain('provider === "mimo" ? MIMO_ASR_CHUNK_SECONDS : DEFAULT_ASR_CHUNK_SECONDS');
    expect(offscreen).toContain("ASR_CHUNK_TRANSCRIBE_EMPTY");
    expect(content).not.toContain('settings-authorize-custom-asr-origin');
    expect(sidepanel).not.toContain('authorize-custom-asr-origin');
    expect(content).not.toContain('id="settings-custom-asr-base-url"');
    expect(sidepanel).not.toContain('id="setting-custom-asr-base-url"');
    expect(manifest.host_permissions).toContain("https://api.xiaomimimo.com/*");
  });

  it("isolates AI results and chat streams by video part", () => {
    expect(background).toContain("function createVideoCachePartKey(bvid, cid)");
    expect(background).toContain("function getPartCacheForContext");
    expect(background).toContain("taskStateByPart");
    expect(background).toContain('msg.action === "SET_ACTIVE_PART"');
    expect(background).toContain('cid: identity.cid > 0 ? `eq.${identity.cid}` : "is.null"');
    expect(background).toContain("buildSupabaseVideoPatch(bvid, settings, patch, partContext = {})");
    expect(background).toContain('supabaseRpc(settings, "upsert_video_cache_controlled"');
    expect(controlledVideoCacheMigration).toContain("security definer");
    expect(controlledVideoCacheMigration).toContain("set search_path = ''");
    expect(controlledVideoCacheMigration).toContain("grant execute on function public.upsert_video_cache_controlled(jsonb) to anon");
    expect(videoCacheCidMigration).toContain("video_cache_bvid_cid_unique");
    expect(videoCacheCidMigration).toContain("where cid is not null");
    expect(background).toContain('safePortPost(port, { type: "done", messageId, partKey: identity.partKey');
    expect(content).toContain("messagePartKey !== currentPartKey");
    expect(content).toContain('action: "SET_ACTIVE_PART"');
    expect(sidepanel).toContain("messagePartKey !== currentPartKey");
  });

  it("falls back to legacy cloud rows only for confirmed single-part videos", () => {
    expect(inject).toContain("partCount: stateMatchesRoute ? pages.length : 0");
    expect(inject).toContain("_partCount: Number(currentMeta.partCount || 0)");
    expect(content).toContain("function getCurrentRoutePartCount()");
    expect(content).toContain("partCount: getCurrentRoutePartCount()");
    expect(background).toContain("identity.partCount === 1");
    expect(background).toContain('source = "legacy_bvid"');
    expect(background).toContain('requestName: "cloud_video_cache_legacy_fetch"');
    expect(background).toContain('cid: "is.null"');
  });

  it("logs part-scoped AI cache decisions only in debug mode", () => {
    expect(background).toContain('console.log("[PART_SCOPE_DIAG]"');
    expect(background).toContain("if (!currentDebugMode) return");
    expect(background).toContain('"cloud_read_query"');
    expect(background).toContain('"cache_write_target"');
    expect(content).toContain('console.log("[PART_SCOPE_DIAG]"');
    expect(content).toContain("if (!isDebugLoggingEnabled()) return");
    expect(content).toContain('"storage_cache_candidate"');
    expect(content).toContain('"ui_render_read"');
    expect(sidepanel).toContain("if (!state.settings?.debugMode) return");
    expect(sidepanel).toContain('"bootstrap_response_received"');
  });

  it("finishes visible task progress before background post-processing returns", () => {
    expect(content).toContain("visibleProgressCompletedTaskIds: new Set()");
    expect(content).toContain("syncStepProgressByTaskState(appState.tabState)");
    expect(content).toContain("startAsymptoticPseudoProgress(activeTaskId, 18)");
    expect(content).toContain("if (!appState.visibleProgressCompletedTaskIds.has(taskId))");
  });

  it("renders subtitles from one route-scoped state without empty-cache replacement", () => {
    expect(content).toContain("function commitSubtitleRows(rows, options = {})");
    expect(content).toContain("function renderSubtitleIfNeeded(container, reason = \"state_change\")");
    expect(content).toContain("function scheduleSubtitleRender(reason = \"state_change\")");
    expect(content).toContain('reason: "current_rows_already_authoritative"');
    expect(content).toContain("const rows = getCurrentSubtitleStateRows()");
    expect(content.match(/renderCC\(/g)?.length || 0).toBe(2);
  });

  it("declares the content action listener at top level", () => {
    const sidePanelHandlerIndex = content.indexOf("function onSidePanelMessage");
    const backgroundHandlerIndex = content.indexOf("function onBackgroundMessage");

    expect(sidePanelHandlerIndex).toBeGreaterThan(0);
    expect(backgroundHandlerIndex).toBeGreaterThan(sidePanelHandlerIndex);
  });

  it("opens the side panel before any awaited setup can consume the click gesture", () => {
    const branchStart = background.indexOf('if (msg.action === "OPEN_SIDE_PANEL")');
    const branchEnd = background.indexOf('if (msg.action === "REPORT_ERROR")', branchStart);
    const openBranch = background.slice(branchStart, branchEnd);

    expect(openBranch).toContain("chrome.sidePanel.open({ tabId })");
    expect(openBranch).not.toContain("await chrome.sidePanel");
    expect(openBranch).not.toContain("setOptions");
    expect(openBranch).toContain("requiresToolbarAction: true");
  });
});
