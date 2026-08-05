(function () {
    function buildTasksProgressTaskId(tasks) {
        const list = Array.isArray(tasks) ? tasks.map((item) => String(item || "").trim()).filter(Boolean) : [];
        return `tasks:${list.sort().join(",") || "unknown"}`;
    }

    function buildChatProgressTaskId(messageId) {
        return `chat:${String(messageId || "unknown")}`;
    }

    function needsSubtitleForTasks(tasks) {
        const list = Array.isArray(tasks) ? tasks : [];
        return list.includes("summary") || list.includes("segments") || list.includes("rumors");
    }

    function canRunTasksWithCache(tasks, currentBvid, cache) {
        if (!needsSubtitleForTasks(tasks)) return true;
    
        const current = String(currentBvid || "").toLowerCase();
        const cacheBvid = String(cache?.bvid || "").toLowerCase();
    
        const hasSubtitle =
            (Array.isArray(cache?.rawSubtitle) && cache.rawSubtitle.length > 0) ||
            (Array.isArray(cache?.processedSubtitle) && cache.processedSubtitle.length > 0);
    
        return !!current && cacheBvid === current && hasSubtitle;
    }

    function getSubtitleDependencyState({
        hasSubtitle = false,
        playerLoading = false,
        cloudLoading = false,
        transcribing = false
    } = {}) {
        if (hasSubtitle) return { status: "ready", detail: "" };
        if (transcribing) return { status: "pending", detail: "正在生成字幕，请稍候..." };
        if (playerLoading) return { status: "pending", detail: "正在读取字幕，请稍候..." };
        if (cloudLoading) return { status: "pending", detail: "正在读取字幕缓存，请稍候..." };
        return { status: "missing", detail: "暂无字幕" };
    }

    function createChatMessageId(now = Date.now(), randomText = Math.random().toString(36)) {
        return `${now}_${String(randomText || "").slice(2, 8)}`;
    }

    function createPendingChatMessages(text, messageId, createdAt = Date.now()) {
        return [
            { id: `u_${messageId}`, role: "user", content: text, status: "done", createdAt },
            { id: `a_${messageId}`, role: "assistant", content: "", metrics: null, status: "loading", messageId, createdAt }
        ];
    }

    globalThis.BilitatoContentAi = {
        buildChatProgressTaskId,
        buildTasksProgressTaskId,
        canRunTasksWithCache,
        createChatMessageId,
        createPendingChatMessages,
        getSubtitleDependencyState,
        needsSubtitleForTasks
    };
})();
