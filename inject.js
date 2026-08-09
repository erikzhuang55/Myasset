(function () {
    if (window.__BILI_AI_INJECT_READY__) {
        window.postMessage({ type: "BILI_INJECT_READY" }, "*");
        return;
    }
    window.__BILI_AI_INJECT_READY__ = true;
    let isSubtitleCaptured = false;
    let autoTriggerTimer = null;
    let autoTriggerStarted = false;
    let maskNode = null;
    let capturedBvid = "";
    let capturedRouteKey = "";
    let latestPlayinfo = null; // 存储 XHR 拦截到的最新 dash 数据
    let latestSubtitleIdentity = null;
    let playinfoRefreshActive = false;
    let latestAudioProbe = null;
    let routeMonitorTimer = null;
    let silentDeadlineTs = Date.now() + 2000;
    let subtitleStringCache = [];
    let routeMetaReadyAt = 0;
    let autoTriggerAttempts = 0;
    let silentSession = null;
    let silentSessionSeq = 0;
    let manualOverrideRouteKey = "";
    let subtitleDebugEnabled = false;
    let userSubtitlePreference = { mode: "unknown", label: "" };
    const stealthStyleId = "bili-stealth-css";
    const originalFetch = window.fetch;
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    window.postMessage({ type: "BILI_INJECT_READY" }, "*");
    bindManualCCIntervention();
    startRouteMonitor();
    scheduleAutoTriggerFlow("inject_bootstrap");
    emitPlayInfo(); // Initial emission

    window.addEventListener("message", (event) => {
        if (event.data?.type === "BILI_SET_DEBUG_MODE") {
            subtitleDebugEnabled = event.data.enabled === true;
            return;
        }
        if (event.data?.type === "GET_PLAY_INFO") {
            window.postMessage({
                type: "SEND_PLAY_INFO",
                data: playinfoRefreshActive ? null : resolvePlayInfo()
            }, "*");
            return;
        }
        if (event.data?.type === "BILI_ALLOW_SUBTITLE_RECAPTURE") {
            isSubtitleCaptured = false;
            subtitleStringCache = [];
            removeStealthMask();
            emitLog("subtitle_recapture_enabled", { source: "content" });
            return;
        }
        if (event.data?.type === "BILI_RETRY_SUBTITLE_CAPTURE") {
            isSubtitleCaptured = false;
            autoTriggerStarted = false;
            subtitleStringCache = [];
            manualOverrideRouteKey = "";
            silentDeadlineTs = Date.now() + 2000;
            cancelSilentSession({ releaseMask: true });
            performSilentAutoTrigger();
            scheduleAutoTriggerFlow("manual_retry");
            emitLog("subtitle_retry_started", { routeKey: getRouteVideoKey() });
            return;
        }
        if (event.data?.type === "BILI_SWITCH_SUBTITLE_LANGUAGE") {
            const label = String(event.data?.label || "").trim();
            const requestId = String(event.data?.requestId || "");
            isSubtitleCaptured = false;
            subtitleStringCache = [];
            removeStealthMask();
            switchSubtitleLanguageByLabel(label, requestId);
            return;
        }
        if (event.data?.type === "REFRESH_PLAYINFO") {
            refreshDashPlayInfo();
            return;
        }
        if (event.data && (event.data.type === "RE_EMIT_PLAYINFO" || event.data.type === "PLAYER_WAKE_UP")) {
            emitPlayInfo();
        }
    });

    window.fetch = async function (...args) {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        const requestMeta = resolveCurrentVideoMeta();
        rememberSubtitleMetadataIdentity(url, requestMeta);
        const response = await originalFetch.apply(this, args);
        if (isSubtitleRequest(url)) {
            logSubtitleDiagnostic("source_request", { source: "inject.fetch", subtitleUrl: url, requestMeta });
            emitLog("subtitle_request_start", { source: "fetch", url, requestMeta });
            scheduleAutoTriggerFlow("fetch_detected");
            response.clone().text().then((text) => {
                logSubtitleDiagnostic("source_response", { source: "inject.fetch", subtitleUrl: url, requestMeta, currentMeta: resolveCurrentVideoMeta() });
                emitLog("subtitle_response_done", { source: "fetch", url, requestMeta, currentMeta: resolveCurrentVideoMeta() });
                emitSubtitlePayload(text, url, requestMeta);
            }).catch(() => {});
        }
        return response;
    };

    XMLHttpRequest.prototype.open = function (method, url) {
        const rawUrl = String(url || "");
        if (rawUrl.includes(".m4s") || rawUrl.includes("upos")) {
            latestAudioProbe = rawUrl;
        }
        this.__biliUrl = url;
        this.__biliRequestMeta = resolveCurrentVideoMeta();
        rememberSubtitleMetadataIdentity(rawUrl, this.__biliRequestMeta);
        return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
        const url = this.__biliUrl || "";

        if (isSubtitleRequest(url)) {
            const requestMeta = this.__biliRequestMeta || resolveCurrentVideoMeta();
            const requestStartedAt = performance.now();
            logSubtitleDiagnostic("source_request", { source: "inject.xhr", subtitleUrl: url, requestMeta });
            emitLog("subtitle_request_start", { source: "xhr", url, requestMeta });
            scheduleAutoTriggerFlow("xhr_detected");
            this.addEventListener("load", () => {
                logSubtitleResourceTiming(url, this, requestStartedAt, requestMeta);
                logSubtitleDiagnostic("source_response", { source: "inject.xhr", subtitleUrl: url, requestMeta, currentMeta: resolveCurrentVideoMeta() });
                emitLog("subtitle_response_done", { source: "xhr", url, requestMeta, currentMeta: resolveCurrentVideoMeta() });
                emitSubtitlePayload(this.responseText, url, requestMeta);
            });
        }

        if (isPlayurlRequest(url)) {
            this.addEventListener("load", () => {
                try {
                    const dashData = JSON.parse(this.responseText);
                    const playData = dashData?.data || dashData?.result || dashData;
                    const dash = playData?.dash;
                    if (dash) {
                        const requestBvid = String(this.__biliRequestMeta?.bvid || "").trim();
                        const routeBvid = window.location.href.match(/BV[a-zA-Z0-9]{10}/)?.[0] || "";
                        if (requestBvid && routeBvid && requestBvid.toLowerCase() !== routeBvid.toLowerCase()) {
                            emitLog("playinfo_stale_skip", { request_bvid: requestBvid, route_bvid: routeBvid });
                            return;
                        }
                        const currentBvid = requestBvid || routeBvid;
                        let currentCid = 0;
                        try {
                            currentCid = Number(new URL(url, location.href).searchParams.get("cid") || 0);
                        } catch (_) {}
                        latestPlayinfo = {
                            ...playData,
                            _bvid: currentBvid,
                            _cid: Number.isFinite(currentCid) && currentCid > 0 ? currentCid : 0,
                            _ts: Date.now()
                        };
                        emitLog("playinfo_updated", { source: "xhr_playurl", url_host: getUrlHost(url), bvid: currentBvid });
                        emitPlayInfo();
                    }
                } catch (_) {}
            });
        }
        return originalSend.apply(this, arguments);
    };

    function emitSubtitlePayload(rawText, url, requestMeta = null) {
        syncCaptureStateWithRoute();
        if (isSubtitleCaptured) {
            logSubtitleDiagnostic("source_ignored", { source: "inject", reason: "already_captured", subtitleUrl: url, requestMeta });
            return;
        }
        const currentMeta = resolveCurrentVideoMeta();
        const requestedBvid = String(requestMeta?.bvid || "").toLowerCase();
        const currentBvid = String(currentMeta?.bvid || "").toLowerCase();
        const requestedP = Number(requestMeta?.p || 0);
        const currentP = Number(currentMeta?.p || 0);
        if ((requestedBvid && currentBvid && requestedBvid !== currentBvid)
            || (requestedP > 0 && currentP > 0 && requestedP !== currentP)) {
            logSubtitleDiagnostic("source_ignored", {
                source: "inject",
                reason: "request_route_mismatch",
                subtitleUrl: url,
                requestMeta,
                currentMeta
            });
            emitLog("subtitle_stale_ui_skip", { requestedMeta: requestMeta, currentMeta, reason: "request_route_mismatch" });
            return;
        }
        subtitleStringCache.push(String(rawText || ""));
        if (subtitleStringCache.length > 6) subtitleStringCache = subtitleStringCache.slice(-6);
        let data;
        try {
            data = JSON.parse(rawText);
        } catch (_) {
            emitLog("json_parse_error", { source: "inject_subtitle", url_host: getUrlHost(url) });
            return;
        }
        const body = data?.body || data?.data?.body || data?.content || data?.result?.body || (Array.isArray(data) ? data : null);
        if (!Array.isArray(body) || !body.length) return;
        logSubtitleDiagnostic("source_received", {
            source: "inject",
            subtitleUrl: url,
            requestMeta,
            ...getSubtitleDiagnosticRowsMeta(body)
        });
        const routeBvid = String(requestMeta?.bvid || getBvidFromUrl(location.href) || "").trim();
        isSubtitleCaptured = true;
        capturedBvid = routeBvid || capturedBvid;
        stopAutoTriggerFlow({ preserveMask: true });
        finishSilentSession();
        const delay = Math.max(0, Number(routeMetaReadyAt || 0) - Date.now());
        setTimeout(() => {
            postSubtitleData(body, url, requestMeta);
        }, delay);
    }

    function isSubtitleRequest(rawUrl) {
        if (!rawUrl) return false;
        let parsed;
        try {
            parsed = new URL(rawUrl, location.href);
        } catch (_) {
            return false;
        }
        const host = parsed.hostname.toLowerCase();
        const path = parsed.pathname.toLowerCase();
        if (host === "data.bilibili.com") return false;
        if (path.includes("/log/web")) return false;
        if (/\/bfs\/(ai_)?subtitle\//i.test(path)) return true;
        if (/\/aisubtitle\//i.test(path)) return true;
        if (path.endsWith(".json") && path.includes("subtitle")) return true;
        return false;
    }

    function isPlayurlRequest(url) {
        if (!url) return false;
        return /\/x\/player\/(wbi\/)?playurl|\/pgc\/player\/web\/playurl/.test(url);
    }

    function emitLog(event, detail) {
        window.postMessage({ type: "BILI_INJECT_LOG", event, detail }, "*");
    }

    function getSubtitleDiagnosticRowsMeta(rows) {
        const list = Array.isArray(rows) ? rows : [];
        const preview = (row) => String(row?.text || row?.content || "").replace(/\s+/g, " ").trim().slice(0, 120);
        return {
            rowCount: list.length,
            firstThreeLines: list.slice(0, 3).map(preview).join("\\n"),
            firstLine: preview(list[0]),
            secondLine: preview(list[1]),
            thirdLine: preview(list[2])
        };
    }

    function logSubtitleDiagnostic(event, detail = {}) {
        if (!subtitleDebugEnabled) return;
        try {
            console.log("[SUBTITLE_DIAG]", {
                event,
                ts: Date.now(),
                routeUrl: location.href,
                ...detail
            });
        } catch (_) {}
    }

    function getUrlHost(url) {
        try {
            return new URL(String(url || "")).host;
        } catch (_) {
            return "";
        }
    }

    function logSubtitleResourceTiming(rawUrl, xhr, requestStartedAt, requestMeta) {
        setTimeout(() => {
            let absoluteUrl = "";
            try {
                absoluteUrl = new URL(String(rawUrl || ""), location.href).href;
            } catch (_) {}
            const entries = absoluteUrl ? performance.getEntriesByName(absoluteUrl, "resource") : [];
            const entry = entries[entries.length - 1] || null;
            const value = (number) => Number.isFinite(Number(number)) ? Math.round(Number(number) * 10) / 10 : null;
            const elapsedMs = value(performance.now() - Number(requestStartedAt || performance.now()));
            const timing = {
                source: "inject.xhr",
                urlHost: getUrlHost(absoluteUrl || rawUrl),
                status: Number(xhr?.status || 0),
                elapsedMs,
                queueMs: entry ? value(entry.fetchStart - entry.startTime) : null,
                dnsMs: entry ? value(entry.domainLookupEnd - entry.domainLookupStart) : null,
                connectMs: entry ? value(entry.connectEnd - entry.connectStart) : null,
                tlsMs: entry && entry.secureConnectionStart > 0 ? value(entry.connectEnd - entry.secureConnectionStart) : null,
                ttfbMs: entry ? value(entry.responseStart - entry.requestStart) : null,
                downloadMs: entry ? value(entry.responseEnd - entry.responseStart) : null,
                resourceTotalMs: entry ? value(entry.duration) : null,
                protocol: String(entry?.nextHopProtocol || ""),
                transferSize: Number(entry?.transferSize || 0),
                encodedBodySize: Number(entry?.encodedBodySize || 0),
                decodedBodySize: Number(entry?.decodedBodySize || 0),
                timingAvailable: !!entry,
                requestMeta
            };
            logSubtitleDiagnostic("source_resource_timing", timing);
            emitLog("subtitle_resource_timing", timing);
        }, 0);
    }

    function scheduleAutoTriggerFlow(reason) {
        syncCaptureStateWithRoute();
        if (isSubtitleCaptured || autoTriggerStarted || manualOverrideRouteKey === getRouteVideoKey()) return;
        if (autoTriggerTimer) clearTimeout(autoTriggerTimer);
        const waitMs = Math.max(0, Number(silentDeadlineTs || 0) - Date.now());
        autoTriggerAttempts = 0;
        autoTriggerTimer = setTimeout(() => autoTriggerLoop(reason), waitMs);
    }

    function autoTriggerLoop(reason) {
        if (isSubtitleCaptured) return;
        const toggle = document.querySelector(".bpx-player-ctrl-subtitle, .bilibili-player-video-btn-subtitle");
        if (!toggle) {
            autoTriggerAttempts += 1;
            if (autoTriggerAttempts >= 10) return;
            autoTriggerTimer = setTimeout(() => autoTriggerLoop(reason), 1000);
            return;
        }
        autoTriggerStarted = true;
        performSilentAutoTrigger();
        emitLog("subtitle_autotrigger", { reason, attempts: autoTriggerAttempts });
    }

    function stopAutoTriggerFlow({ preserveMask = false } = {}) {
        if (autoTriggerTimer) {
            clearTimeout(autoTriggerTimer);
            autoTriggerTimer = null;
        }
        if (!preserveMask) removeStealthMask();
    }

    function applyStealthMask() {
        if (document.getElementById(stealthStyleId)) return;
        maskNode = document.createElement("style");
        maskNode.id = stealthStyleId;
        maskNode.innerHTML = [
            ".bpx-player-video-subtitle { visibility: hidden !important; }",
            ".bili-subtitle-x-subtitle-panel-position { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }",
            ".bpx-player-ctrl-subtitle-menu, .bpx-player-ctrl-subtitle-panel, .bpx-player-dialog-wrap:has(.bpx-player-ctrl-subtitle-language-item-text) { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }",
            ".bpx-common-toast, .bpx-player-toast-wrap, .bpx-player-toast-row, .bpx-player-toast-auto { display: none !important; opacity: 0 !important; visibility: hidden !important; }"
        ].join(" ");
        document.head.appendChild(maskNode);
        emitLog("subtitle_stealth_applied", { source: "inject" });
    }

    function removeStealthMask() {
        const hadMask = !!document.getElementById(stealthStyleId) || !!maskNode?.isConnected;
        const style = document.getElementById(stealthStyleId);
        if (style) style.remove();
        if (maskNode?.isConnected) maskNode.remove();
        maskNode = null;
        const containers = document.querySelectorAll(".bpx-player-video-subtitle");
        containers.forEach((container) => {
            container.style.removeProperty("display");
            container.style.removeProperty("opacity");
            container.style.removeProperty("visibility");
            container.style.removeProperty("height");
            container.style.removeProperty("pointer-events");
            container.style.pointerEvents = "auto";
        });
        if (hadMask) emitLog("subtitle_stealth_released", { source: "manual_interaction" });
    }

    function getSubtitleLanguageEntries() {
        return Array.from(document.querySelectorAll(".bpx-player-ctrl-subtitle-language-item-text")).map((labelNode) => ({
            labelNode,
            item: labelNode.closest?.(".bpx-player-ctrl-subtitle-language-item") || labelNode,
            label: normalizeSubtitleLabel(labelNode.textContent || labelNode.innerText)
        }));
    }

    function restoreSilentSessionState(session = silentSession) {
        if (!session) return false;
        const restoreLabel = userSubtitlePreference.mode === "on" && userSubtitlePreference.label
            ? userSubtitlePreference.label
            : "关闭";
        const result = clickSubtitleLanguageLabel(restoreLabel);
        if (result.clicked) {
            session.restoreClicked = true;
            emitLog("subtitle_stealth_restore_clicked", {
                routeKey: session.routeKey,
                preferenceMode: userSubtitlePreference.mode,
                requestedLabel: restoreLabel,
                matchedText: result.matchedText
            });
        }
        return result.clicked;
    }

    function closeSubtitleMenuSilently() {
        const nodes = document.querySelectorAll(".bpx-player-ctrl-subtitle, .bilibili-player-video-btn-subtitle, .bpx-player-ctrl-subtitle-menu, .bpx-player-ctrl-subtitle-panel");
        nodes.forEach((node) => {
            ["mouseleave", "mouseout"].forEach((type) => {
                try {
                    node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
                } catch (_) {}
            });
        });
        try {
            document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
        } catch (_) {}
    }

    function cancelSilentSession({ restore = false, releaseMask = true } = {}) {
        const session = silentSession;
        if (session?.finishTimer) clearTimeout(session.finishTimer);
        if (restore) restoreSilentSessionState(session);
        silentSession = null;
        if (releaseMask) removeStealthMask();
    }

    function finishSilentSession() {
        const session = silentSession;
        if (!session || session.finishing) return;
        session.finishing = true;
        const retryDelays = [0, 80, 200, 400, 800];
        const tryClose = (attempt) => {
            if (silentSession?.id !== session.id) return;
            if (restoreSilentSessionState(session)) {
                closeSubtitleMenuSilently();
                session.finishTimer = setTimeout(() => {
                    if (silentSession?.id !== session.id) return;
                    silentSession = null;
                    removeStealthMask();
                    emitLog("subtitle_stealth_completed", { routeKey: session.routeKey, attempts: attempt + 1 });
                }, 160);
                return;
            }
            if (attempt + 1 < retryDelays.length) {
                session.finishTimer = setTimeout(() => tryClose(attempt + 1), retryDelays[attempt + 1]);
                return;
            }
            closeSubtitleMenuSilently();
            emitLog("subtitle_stealth_close_pending", { routeKey: session.routeKey, attempts: retryDelays.length });
        };
        tryClose(0);
    }

    function performSilentAutoTrigger() {
        return blindSilentOpen();
    }

    function blindSilentOpen() {
        if (isSubtitleCaptured) return;
        const routeKey = getRouteVideoKey();
        if (manualOverrideRouteKey === routeKey) return false;
        cancelSilentSession({ releaseMask: false });
        silentSession = {
            id: ++silentSessionSeq,
            routeKey,
            finishTimer: null,
            finishing: false,
            restoreClicked: false
        };
        applyStealthMask();
        const allTextDivs = Array.from(document.querySelectorAll(".bpx-player-ctrl-subtitle-language-item-text"));
        const chineseTrack = allTextDivs.find((el) => String(el?.innerText || "").trim().includes("中文"));
        if (chineseTrack) {
            chineseTrack.click();
            return true;
        }
        const ccBtn = document.querySelector(".bpx-player-ctrl-subtitle");
        let clicked = false;
        if (ccBtn) {
            try {
                const evt = new MouseEvent("mouseenter", { bubbles: true, cancelable: true, view: window });
                ccBtn.dispatchEvent(evt);
            } catch (_) {}
            ccBtn.click();
            clicked = true;
        }
        setTimeout(() => {
            if (isSubtitleCaptured) return;
            const retryTrack = Array.from(document.querySelectorAll(".bpx-player-ctrl-subtitle-language-item-text"))
                .find((el) => String(el?.innerText || "").trim().includes("中文"));
            if (retryTrack) retryTrack.click();
        }, 100);
        return clicked;
    }

    function normalizeSubtitleLabel(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
    }

    function dispatchSubtitleClick(target) {
        if (!target) return false;
        ["pointerdown", "mousedown", "pointerup", "mouseup"].forEach((type) => {
            try {
                target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            } catch (_) {}
        });
        try {
            target.click?.();
        } catch (_) {}
        return true;
    }

    function openSubtitleMenuForSwitch() {
        const trigger = document.querySelector(".bpx-player-ctrl-subtitle, .bilibili-player-video-btn-subtitle");
        if (!trigger) return false;
        ["mouseenter", "mouseover", "mousemove"].forEach((type) => {
            try {
                trigger.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
            } catch (_) {}
        });
        return true;
    }

    function clickSubtitleLanguageLabel(label) {
        const targetLabel = normalizeSubtitleLabel(label);
        if (!targetLabel) return { clicked: false, matchedText: "" };
        const nodes = Array.from(document.querySelectorAll(".bpx-player-ctrl-subtitle-language-item-text"));
        const node = nodes.find((item) => normalizeSubtitleLabel(item?.textContent || item?.innerText) === targetLabel)
            || nodes.find((item) => normalizeSubtitleLabel(item?.textContent || item?.innerText).includes(targetLabel));
        const target = node?.closest?.(".bpx-player-ctrl-subtitle-language-item") || node;
        const clicked = dispatchSubtitleClick(target);
        return { clicked, matchedText: normalizeSubtitleLabel(node?.textContent || node?.innerText || "") };
    }

    function emitSubtitleLanguageSwitchResult(requestId, label, result) {
        const payload = {
            type: "BILI_SUBTITLE_LANGUAGE_SWITCH_RESULT",
            requestId,
            label,
            clicked: !!result?.clicked,
            matchedText: String(result?.matchedText || "")
        };
        window.postMessage(payload, "*");
        emitLog("subtitle_language_switch", payload);
    }

    function switchSubtitleLanguageByLabel(label, requestId) {
        const first = clickSubtitleLanguageLabel(label);
        if (first.clicked) {
            emitSubtitleLanguageSwitchResult(requestId, label, first);
            return;
        }
        openSubtitleMenuForSwitch();
        let done = false;
        [160, 360, 700].forEach((delay) => {
            setTimeout(() => {
                if (done) return;
                const result = clickSubtitleLanguageLabel(label);
                emitLog("subtitle_language_switch_retry", { label, clicked: result.clicked, matchedText: result.matchedText, delay });
                if (result.clicked) {
                    done = true;
                    emitSubtitleLanguageSwitchResult(requestId, label, result);
                } else if (delay === 700) {
                    emitSubtitleLanguageSwitchResult(requestId, label, result);
                }
            }, delay);
        });
    }

    function syncCaptureStateWithRoute() {
        const current = String(getBvidFromUrl(location.href) || "").trim();
        const currentKey = getRouteVideoKey();
        if (!capturedBvid) {
            if (current) capturedBvid = current;
            if (currentKey) capturedRouteKey = currentKey;
            return;
        }
        if (current && currentKey && currentKey !== capturedRouteKey) {
            hardResetForRoute(current, "route_switch_reset");
        }
    }

    function hardResetForRoute(nextBvid, reason) {
        cancelSilentSession({ releaseMask: true });
        isSubtitleCaptured = false;
        autoTriggerStarted = false;
        capturedBvid = String(nextBvid || "").trim();
        capturedRouteKey = getRouteVideoKey();
        subtitleStringCache = [];
        latestPlayinfo = null; // 切换视频时清空，防止旧视频数据残留
        const nextP = Math.max(1, Number(getRouteTid() || 1));
        const keepCurrentSubtitleIdentity = String(latestSubtitleIdentity?.bvid || "").toLowerCase() === String(nextBvid || "").toLowerCase()
            && Number(latestSubtitleIdentity?.p || 1) === nextP;
        if (!keepCurrentSubtitleIdentity) latestSubtitleIdentity = null;
        latestAudioProbe = null;
        silentDeadlineTs = Date.now() + 2000;
        manualOverrideRouteKey = "";
        stopAutoTriggerFlow();
        emitLog("subtitle_route_reset", { bvid: capturedBvid, reason });
        performSilentAutoTrigger();
        scheduleAutoTriggerFlow(reason || "route_switch_reset");
    }

    function startRouteMonitor() {
        if (routeMonitorTimer) return;
        routeMonitorTimer = setInterval(() => {
            const current = String(getBvidFromUrl(location.href) || "").trim();
            const currentKey = getRouteVideoKey();
            if (!current) return;
            if (!capturedBvid) {
                capturedBvid = current;
                capturedRouteKey = currentKey;
                emitPlayInfo(); // Emit when first BVID captured
                return;
            }
            if (currentKey && currentKey === capturedRouteKey) return;
            
            // Immediately dispatch postMessage on detection without delay
            const meta = resolveCurrentVideoMeta();
            window.postMessage({ type: "BILI_ROUTE_SWITCH", bvid: current, cid: meta.cid || 0, tid: getRouteTid(), partCount: meta.partCount || 0 }, "*");
            
            routeMetaReadyAt = Date.now() + 800;
            hardResetForRoute(current, "route_monitor");
            setTimeout(emitPlayInfo, 1000); // Emit after route change with a delay to ensure __playinfo__ might be updated or we might need to re-read
        }, 300);
    }

    function postSubtitleData(body, subtitleUrl = "", requestMeta = null) {
        const meta = requestMeta || resolveCurrentVideoMeta();
        const currentMeta = resolveCurrentVideoMeta();
        if ((meta?.bvid && currentMeta?.bvid && String(meta.bvid).toLowerCase() !== String(currentMeta.bvid).toLowerCase())
            || (Number(meta?.p || 0) > 0 && Number(currentMeta?.p || 0) > 0 && Number(meta.p) !== Number(currentMeta.p))) {
            emitLog("subtitle_stale_ui_skip", { requestedMeta: meta, currentMeta, reason: "post_route_mismatch" });
            return;
        }
        const routeBvid = String(getBvidFromUrl(location.href) || "").trim();
        const bvid = String(meta.bvid || routeBvid || "").trim();
        if (!bvid) {
            emitLog("subtitle_detected", { source: "inject_drop_missing_bvid" });
            return;
        }
        const cid = meta.cid || 0;
        logSubtitleDiagnostic("source_forwarded", {
            source: "inject",
            bvid,
            cid,
            subtitleUrl,
            requestMeta,
            ...getSubtitleDiagnosticRowsMeta(body)
        });
        emitLog("subtitle_parsed", { count: body.length, bvid, cid });
        window.postMessage({ type: "BILI_SUBTITLE_HANDSHAKE", bvid, cid, partCount: meta.partCount || 0 }, "*");
        setTimeout(() => {
            window.postMessage({
                type: "BILI_SUBTITLE_DATA",
                data: body,
                bvid,
                cid,
                p: meta.p || 1,
                part: meta.part || "",
                duration: meta.duration || 0,
                partCount: meta.partCount || 0,
                language: meta.language || "",
                languageLabel: meta.languageLabel || "",
                subtitleUrl: String(subtitleUrl || "")
            }, "*");
        }, 0);
    }

    function bindManualCCIntervention() {
        const release = (eventName, event) => {
            if (!event.isTrusted) return;
            const languageItem = event.target?.closest?.(".bpx-player-ctrl-subtitle-language-item");
            const target = event.target?.closest?.(".bpx-player-ctrl-subtitle, .bilibili-player-video-btn-subtitle");
            if (!target && !languageItem) return;
            if (eventName === "click" && languageItem) {
                const labelNode = languageItem.querySelector?.(".bpx-player-ctrl-subtitle-language-item-text");
                const label = normalizeSubtitleLabel(labelNode?.textContent || languageItem.textContent || "");
                if (label) {
                    userSubtitlePreference = /关闭/.test(label)
                        ? { mode: "off", label: "关闭" }
                        : { mode: "on", label };
                    emitLog("subtitle_user_preference_changed", userSubtitlePreference);
                }
            }
            emitLog("subtitle_manual_intervention", { event: eventName });
            manualOverrideRouteKey = getRouteVideoKey();
            autoTriggerStarted = true;
            if (autoTriggerTimer) {
                clearTimeout(autoTriggerTimer);
                autoTriggerTimer = null;
            }
            cancelSilentSession({ restore: !languageItem, releaseMask: true });
        };
        document.addEventListener("mousedown", (event) => {
            release("mousedown", event);
        }, true);
        document.addEventListener("click", (event) => {
            release("click", event);
        }, true);
    }

    function resolveCurrentVideoMeta() {
        const state = window.__INITIAL_STATE__ || {};
        const videoData = state.videoData || {};
        const pages = Array.isArray(videoData.pages) ? videoData.pages : [];
        const url = new URL(location.href);
        const routeBvid = location.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/)?.[1] || "";
        const stateBvid = String(videoData.bvid || state.bvid || "").trim();
        const stateMatchesRoute = !routeBvid || !stateBvid || routeBvid.toLowerCase() === stateBvid.toLowerCase();
        const bvid = routeBvid || stateBvid;
        const p = Math.max(1, Number(url.searchParams.get("p") || state.p || 1));
        const currentPage = stateMatchesRoute
            ? (pages.find((item) => Number(item?.page) === p) || pages[p - 1] || null)
            : null;
        const video = document.querySelector("video");
        const duration = Number(currentPage?.duration) || Number(video?.duration) || 0;
        const playInfoMatchesRoute = String(latestPlayinfo?._bvid || "").toLowerCase() === String(bvid || "").toLowerCase();
        const currentAid = stateMatchesRoute
            ? Number(videoData?.aid || state?.aid || 0)
            : 0;
        const referenceCid = Number(currentPage?.cid)
            || (playInfoMatchesRoute ? Number(latestPlayinfo?._cid) : 0)
            || (stateMatchesRoute ? Number(state.cid) : 0)
            || 0;
        const subtitleIdentityMatchesRoute = String(latestSubtitleIdentity?.bvid || "").toLowerCase() === String(bvid || "").toLowerCase()
            && Number(latestSubtitleIdentity?.p || 1) === p
            && Number(latestSubtitleIdentity?.aid || 0) > 0
            && (currentAid > 0
                ? Number(latestSubtitleIdentity.aid) === currentAid
                : latestSubtitleIdentity?.verified === true)
            && (!(referenceCid > 0) || Number(latestSubtitleIdentity.cid) === referenceCid);
        const cid = (subtitleIdentityMatchesRoute ? Number(latestSubtitleIdentity?.cid) : 0)
            || referenceCid;
        return {
            bvid: String(bvid || "").trim(),
            p,
            cid: Number.isFinite(cid) ? cid : 0,
            aid: Number.isFinite(currentAid) ? currentAid : 0,
            referenceCid: Number.isFinite(referenceCid) ? referenceCid : 0,
            part: String(currentPage?.part || ""),
            duration: Number.isFinite(duration) ? duration : 0,
            partCount: stateMatchesRoute ? pages.length : 0
        };
    }

    function getBvidFromUrl(url) {
        const match = String(url || "").match(/\/video\/(BV[0-9A-Za-z]+)/i);
        return match ? match[1] : "";
    }

    function getRouteTid() {
        const parsed = new URL(location.href);
        return parsed.searchParams.get("p") || "";
    }

    function getRouteVideoKey() {
        const meta = resolveCurrentVideoMeta();
        const routeP = Math.max(1, Number(getRouteTid() || meta.p || 1));
        return meta.bvid ? `${meta.bvid}::p${routeP}` : "";
    }

    function getSubtitleMetadataIdentity(rawUrl) {
        if (!rawUrl) return null;
        try {
            const parsed = new URL(rawUrl, location.href);
            if (!/\/x\/v2\/subtitle\/web\/view$/i.test(parsed.pathname)) return null;
            const cid = Number(parsed.searchParams.get("oid") || 0);
            const aid = Number(parsed.searchParams.get("pid") || 0);
            if (!Number.isFinite(cid) || !(cid > 0)) return null;
            return {
                cid,
                aid: Number.isFinite(aid) && aid > 0 ? aid : 0
            };
        } catch (_) {
            return null;
        }
    }

    function rememberSubtitleMetadataIdentity(rawUrl, requestMeta = null) {
        const identity = getSubtitleMetadataIdentity(rawUrl);
        if (!identity) return;
        const routeBvid = String(requestMeta?.bvid || getBvidFromUrl(location.href) || "").trim();
        if (!routeBvid) return;
        const p = Math.max(1, Number(requestMeta?.p || getRouteTid() || 1));
        const currentAid = Number(requestMeta?.aid || 0);
        const referenceCid = Number(requestMeta?.referenceCid || 0);
        const aidMatches = identity.aid > 0 && currentAid > 0 && identity.aid === currentAid;
        const cidMatches = !(referenceCid > 0) || identity.cid === referenceCid;
        const verified = aidMatches && cidMatches;
        latestSubtitleIdentity = {
            bvid: routeBvid,
            p,
            cid: identity.cid,
            aid: identity.aid,
            verified
        };
        emitLog("subtitle_identity_observed", {
            bvid: routeBvid,
            p,
            cid: identity.cid,
            aid: identity.aid,
            verified,
            reference_cid: referenceCid,
            source: "subtitle_metadata"
        });
    }

    function emitPlayInfo() {
        const info = resolvePlayInfo();
        if (info) {
            window.postMessage({ type: "BILI_PLAYINFO_DATA", info }, "*");
        } else {
            emitLog("playinfo_missing", { source: "resolve_playinfo" });
        }
    }

    async function refreshDashPlayInfo() {
        if (playinfoRefreshActive) return;
        playinfoRefreshActive = true;
        latestPlayinfo = null;
        const meta = resolveCurrentVideoMeta();
        if (!meta.bvid || !(meta.cid > 0)) {
            emitLog("playinfo_refresh_failed", { reason: "missing_bvid_or_cid", bvid: meta.bvid, cid: meta.cid });
            playinfoRefreshActive = false;
            return;
        }
        try {
            const callbackName = `__bilitatoDashPlayurl_${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const params = new URLSearchParams({
                bvid: meta.bvid,
                cid: String(meta.cid),
                qn: "127",
                fnver: "0",
                fnval: "4048",
                fourk: "1",
                otype: "json",
                callback: callbackName,
                jsonp: "jsonp"
            });
            const json = await new Promise((resolve, reject) => {
                const script = document.createElement("script");
                const timeoutId = setTimeout(() => finish(new Error("playurl timeout")), 8000);
                const finish = (error, value) => {
                    clearTimeout(timeoutId);
                    script.remove();
                    try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
                    if (error) reject(error);
                    else resolve(value);
                };
                window[callbackName] = (value) => finish(null, value);
                script.onerror = () => finish(new Error("playurl script failed"));
                script.src = `https://api.bilibili.com/x/player/playurl?${params.toString()}`;
                (document.head || document.documentElement).appendChild(script);
            });
            if (Number(json?.code || 0) !== 0) throw new Error(String(json?.message || "playurl failed"));
            const playData = json?.data || json?.result || null;
            if (!playData?.dash) throw new Error("dash missing");
            latestPlayinfo = {
                ...playData,
                _bvid: meta.bvid,
                _cid: meta.cid,
                _ts: Date.now(),
                _source: "fresh_playurl"
            };
            emitLog("playinfo_updated", { source: "fresh_playurl", bvid: meta.bvid, cid: meta.cid });
            playinfoRefreshActive = false;
            emitPlayInfo();
        } catch (error) {
            emitLog("playinfo_refresh_failed", {
                reason: error?.message || "playurl request failed",
                bvid: meta.bvid,
                cid: meta.cid
            });
            playinfoRefreshActive = false;
            window.postMessage({ type: "BILI_PLAYINFO_REFRESH_FAILED" }, "*");
        }
    }

    function resolvePlayInfo() {
        try {
            const data = latestPlayinfo || window.__playinfo__?.data || null;
            if (!data) return null;
            
            // Collect all candidates
            let candidates = [];

            // 1. DASH
            if (data.dash && data.dash.video) {
                data.dash.video.forEach(v => {
                    const primaryUrl = v.baseUrl || v.base_url || "";
                    const backupUrls = Array.isArray(v.backupUrl) ? v.backupUrl : (Array.isArray(v.backup_url) ? v.backup_url : []);
                    candidates.push({
                        quality: v.id,
                        codecid: v.codecid,
                        desc: getQualityDesc(v.id, data.accept_quality, data.accept_description),
                        url: primaryUrl,
                        urls: [primaryUrl, ...backupUrls].filter(Boolean),
                        codecs: v.codecs,
                        type: 'DASH'
                    });
                });
            }
            
            // 2. DURL (Legacy/MP4)
            if (data.durl) {
                 data.durl.forEach(v => {
                    const primaryUrl = v.url || "";
                    const backupUrls = Array.isArray(v.backupUrl) ? v.backupUrl : (Array.isArray(v.backup_url) ? v.backup_url : []);
                    candidates.push({
                        quality: data.quality || 0, // durl usually has top-level quality
                        codecid: 0, // unknown
                        desc: getQualityDesc(data.quality, data.accept_quality, data.accept_description),
                        url: primaryUrl,
                        urls: [primaryUrl, ...backupUrls].filter(Boolean),
                        type: 'MP4'
                    });
                });
            }

            // Deduplication and Grouping
            const uniqueMap = new Map();
            const groupedMap = new Map();
            
            candidates.forEach(item => {
                const key = `${item.quality}_${item.codecid}`;
                
                // De-duplication: skip if exact quality+codecid exists
                if (uniqueMap.has(key)) return;
                uniqueMap.set(key, true);

                // Group by quality
                if (!groupedMap.has(item.quality)) {
                    groupedMap.set(item.quality, {
                        desc: item.desc,
                        streams: []
                    });
                }
                
                // Map friendly codec name
                item.codecName = mapCodecName(item.codecs, item.codecid);
                groupedMap.get(item.quality).streams.push(item);
            });

            // Convert map to array and sort by quality desc
            const resultVideo = Array.from(groupedMap.entries())
                .sort((a, b) => b[0] - a[0])
                .map(([q, val]) => ({
                    quality: q,
                    desc: val.desc,
                    streams: val.streams.sort((a, b) => {
                        // Sort streams within quality: AVC first (compatibility), then HEVC, then AV1
                        const score = (c) => {
                            if (c === "AVC") return 3;
                            if (c === "HEVC") return 2;
                            if (c === "AV1") return 1;
                            return 0;
                        };
                        return score(b.codecName) - score(a.codecName);
                    })
                }));
            
            if (candidates.length > resultVideo.length) {
            }
            
            // Audio streams
            const audio = [];
            if (data.dash && data.dash.audio) {
                data.dash.audio.forEach(a => {
                    const bandwidthNum = a.bandwidth || 0;
                    const bandwidthStr = bandwidthNum ? `${Math.round(bandwidthNum / 1000)}kbps` : "";
                    const idDesc = a.id === 30280 ? "高品质" : a.id === 30232 ? "中品质" : a.id === 30216 ? "低品质" : "";
                    
                    let finalDesc = "";
                    if (idDesc && bandwidthStr) {
                        finalDesc = `${idDesc} · ${bandwidthStr}`;
                    } else if (idDesc) {
                        finalDesc = idDesc;
                    } else if (bandwidthStr) {
                        finalDesc = bandwidthStr;
                    } else {
                        finalDesc = `Audio ${a.id}`;
                    }
                    
                    const primaryUrl = a.baseUrl || a.base_url || "";
                    const backupUrls = Array.isArray(a.backupUrl) ? a.backupUrl : (Array.isArray(a.backup_url) ? a.backup_url : []);
                    audio.push({
                        id: a.id,
                        desc: finalDesc, 
                        url: primaryUrl,
                        urls: [primaryUrl, ...backupUrls].filter(Boolean),
                        bandwidth: bandwidthNum
                    });
                });
                
                // Sort audio by bandwidth descending
                audio.sort((a, b) => b.bandwidth - a.bandwidth);
            }
            
            const currentMeta = resolveCurrentVideoMeta();
            return {
                video: resultVideo,
                audio,
                _bvid: String(data._bvid || getBvidFromUrl(location.href) || "").trim(),
                _cid: Number(data._cid || currentMeta.cid || 0),
                _partCount: Number(currentMeta.partCount || 0),
                _ts: Number(data._ts || 0),
                _source: String(data._source || "")
            };
        } catch (e) {
            emitLog("playinfo_error", {
                code: "PLAYINFO_PARSE_FAILED",
                error_message: e.message || "playinfo parse failed",
                stack_preview: String(e.stack || "").split("\n").slice(0, 3).join("\n")
            });
            return null;
        }
    }

    function mapCodecName(codecs, codecid) {
        const c = String(codecs || "").toLowerCase();
        // 7 = AVC, 12 = HEVC, 13 = AV1 (approximate bilibili mapping)
        if (c.includes("avc") || codecid === 7) return "AVC";
        if (c.includes("hev") || c.includes("hvc") || codecid === 12) return "HEVC";
        if (c.includes("av01") || codecid === 13) return "AV1";
        return "MP4"; // Fallback
    }

    function getQualityDesc(quality, accept_quality, accept_description) {
        if (!Array.isArray(accept_quality) || !Array.isArray(accept_description)) return String(quality);
        const index = accept_quality.indexOf(quality);
        if (index > -1 && accept_description[index]) {
            return accept_description[index];
        }
        return String(quality);
    }
})();
