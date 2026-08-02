export const TASK_PROMPT_FORMAT_RULES = {
    segments: "【技术规范】只输出 JSON 数组，严禁包含任何 Markdown 代码块或解释性文字。格式严格遵守：普通章节为 {\"start\":数字,\"end\":数字,\"start_line\":数字,\"end_line\":数字,\"label\":\"字符串\",\"type\":\"content\"}；广告章节为 {\"start\":数字,\"end\":数字,\"start_line\":数字,\"end_line\":数字,\"label\":\"字符串\",\"type\":\"ad\",\"ad_start_line\":数字,\"ad_end_line\":数字}。所有 line 值必须来自逐句字幕前的 #编号，系统会优先用 line_id 映射最终时间。start/end/start_line/end_line/ad_start_line/ad_end_line 必须是合法 JSON 数字，禁止输出 III、NaN、Infinity、中文数字或其他未加引号的非数字 token。",
    rumors: "【技术规范】只输出 JSON 对象，严禁 Markdown。结构必须包含：{ \"overall_score\": 数字, \"overview\": \"字符串\", \"claims\": [{\"text\":\"内容\",\"timestamp_sec\":秒数整数,\"verdict\":布尔值,\"analysis\":\"原因\"}] }。timestamp_sec 必须是秒数整数，例如 15:27 输出 927；禁止输出 15:27、\"15:27\" 或 \"15分27秒\"。",
    summary:  "【技术规范】输出 Markdown 正文，严禁输出 JSON。必须使用 3-5 个加粗小标题（格式：**小标题**）；禁止使用一级标题；禁止整段纯文本输出。只输出最终总结，禁止输出思考过程、任务复述、写作计划、草稿说明或“让我分析/我将/需要输出”等前置文字。"
};

export const MERGED_SEGMENTS_FORMAT_RULE = `
【分段输出字段规范（必须匹配系统标准）】
SEGMENTS 部分必须输出 JSON 数组，每个对象必须包含以下字段：
- start: 数字（秒）
- end: 数字（秒，且必须大于 start）
- start_line: 数字（章节开始对应的逐句字幕 #编号）
- end_line: 数字（章节结束对应的逐句字幕 #编号）
- label: 字符串（章节标题）
- type: "content" 或 "ad"

广告段额外必须包含：
- ad_start_line: 数字（广告开始对应的逐句字幕 #编号）
- ad_end_line: 数字（广告结束对应的逐句字幕 #编号）

禁止输出字段：time_start、time_end、start_time、end_time、title、name、summary、content 等。
示例：
[{"start":0,"end":105,"start_line":0,"end_line":40,"label":"案件引入与背景介绍","type":"content"},{"start":407,"end":520,"start_line":120,"end_line":145,"label":"品牌推广","type":"ad","ad_start_line":120,"ad_end_line":145}]
`.trim();

export const SEGMENTS_AD_TEST_PROMPT = `
你是一个 B 站视频分段助手。请基于字幕，把视频划分为适合进度条展示的章节，并识别广告片段。

【输入说明】
字幕每行格式如下：
#行号 [开始时间-结束时间] 字幕内容

【任务】
1. 按视频内容变化划分章节。
2. 识别广告片段。
3. 必须覆盖整个视频，从第一行字幕到最后一行字幕。
4. 不要只分析前半段，最后一个章节必须覆盖到字幕最后一行附近。

【分段要求】
- 10 分钟以内：4-7 段。
- 10-25 分钟：6-10 段。
- 25-45 分钟：8-12 段。
- 45 分钟以上：10-16 段。
- 遇到新案件、新人物、新阶段、新证据、新观点、结论变化时，应拆成新段。
- 普通正文段 type 为 "content"。
- 广告段 type 为 "ad"。

【广告判断】
广告是指视频主线暂停，开始推广产品、服务、课程、APP、活动、优惠、购买/下载/注册链接等内容。

广告段必须返回：
- ad_start_line：广告开始的字幕行号。
- ad_end_line：广告结束的字幕行号。

广告开始行：
第一句明确进入推广内容的字幕。

广告结束行：
最后一句仍属于推广内容的字幕。

广告结束规则补充：
- 广告段中的情绪铺垫、送礼场景、亲情表达、用户痛点共鸣、使用体验延伸，仍属于广告的一部分。
- 不要因为某几句没有出现品牌名、产品名或购买词，就判定广告结束。
- 只有当字幕明确回到视频原本主题、案件、故事、教程或正文主线时，才算广告结束。
- 如果广告后出现“回到正题 / 说回案件 / 继续刚才的话题 / 接着讲故事 / 话说回来”等明显回归主线表达，应把这些句子作为正文，不算广告。

【输出格式】
只输出 JSON 数组，不要 Markdown，不要解释。

普通段格式：
{
  "start": 秒数,
  "end": 秒数,
  "start_line": 行号,
  "end_line": 行号,
  "label": "简短章节标题",
  "type": "content"
}

广告段格式：
{
  "start": 秒数,
  "end": 秒数,
  "start_line": 行号,
  "end_line": 行号,
  "label": "广告：产品或服务名称",
  "type": "ad",
  "ad_start_line": 行号,
  "ad_end_line": 行号
}

【重要约束】
- start/end 必须来自字幕时间，不要凭空估算。
- start/end/start_line/end_line/ad_start_line/ad_end_line 必须是合法 JSON 数字；禁止输出 III、NaN、Infinity、中文数字或其他未加引号的非数字 token。
- start_line/end_line 必须来自字幕开头的 #行号；普通正文和广告都必须填写。
- 系统会优先使用 start_line/end_line 映射最终 start/end，start/end 只作为兼容字段。
- 所有分段按时间升序排列。
- 不要重叠。
- 不要漏掉视频后半段。
- 最后一段 end 必须接近最后一行字幕的结束时间。
`.trim();

export const OUTPUT_PROTOCOL = `
【输出协议 - 严格执行】
你必须严格按照以下格式输出，任何偏离都会导致解析失败：

<<<SUMMARY_START>>>
 (总结正文，使用 Markdown：加粗小标题；不要 JSON)
<<<SUMMARY_END>>>

<<<SEGMENTS_START>>>
（分段 JSON 数组，不要任何其他文字）
<<<SEGMENTS_END>>>

禁止：
- 禁止在标签外输出任何解释文字
- 禁止修改标签格式（<<<和>>>必须保留）
- 禁止在 SEGMENTS 部分输出非 JSON 内容
- 禁止省略任何一个标签
`.trim();

export const BASE_PROMPT = `
你是一个中文视频内容分析助手。请基于字幕内容完成分析。
如果字幕中存在明显识别错误，可根据上下文进行合理修正。
忽略无意义重复、口误和噪声内容。
`;

export const TASK_PROMPTS = {
    summary: `
任务：生成一份结构化的视频分析总结。

要求：
1. 先用 2-4 句话概括视频主题、核心观点和整体结论，
让用户快速知道“这个视频主要讲了什么”。

2. 然后提炼视频中的核心内容，
包括：
- 主要观点
- 关键论据
- 重要细节
- 典型案例
- 数据或结论
- 作者态度与倾向（如果明显）

3. 不要逐句复述字幕，
而是重新组织内容，
形成更易阅读的总结。

4. 对长视频：
必须覆盖视频前、中、后期的重要内容，
不要只总结前半部分。

5. 如果视频存在多个主题或章节，
请分点整理。

6. 忽略：
- 广告
- 套话
- 无意义闲聊
- 重复内容
- 点赞关注引导

7. 如果字幕存在明显 ASR 错误，
可根据上下文合理修正。

8. 输出必须具有“信息密度”，
避免空泛总结。

9. 如果 detail 为 detailed：
需要进一步展开：
- 背景逻辑
- 原因分析
- 观点之间的关系
- 可能影响
- 视频隐含结论

10. 输出格式必须稳定，但小标题要根据视频内容动态生成：

- 只输出最终总结正文，不要输出思考过程、分析计划、任务复述、草稿说明。
- 禁止出现“让我分析”“我将梳理”“需要输出”“让我组织内容”“视频的核心观点是”等自我说明式前置文字。
- 使用 3-5 个加粗小标题，例如：**实验背景**、**核心争议**、**事件经过**、**主要观点**、**关键结论**。
- 加粗小标题数量和每节要点数量必须服从“详略程度”要求。
- 小标题必须根据视频实际内容命名，不要机械使用固定模板。
- 每个小标题下用 2-4 个要点展开。
- 第一个小标题必须承担“视频概述”功能，但标题可以根据内容改写，例如：
  - 科普/历史类：**背景与主题**
  - 案件/事件类：**事件概况**
  - 产品/测评类：**核心结论**
  - 观点评论类：**主要论点**
- 如果视频有明显争议，应包含一个与争议相关的小标题，例如 **核心争议**、**争议焦点** 或 **不同观点**。
- 如果视频主要是教程，应包含步骤、方法或操作要点。
- 如果视频主要是故事，应按情节发展或关键转折组织。
- 如果视频主要是新闻/社会事件，应按背景、经过、影响、争议组织。
`,

    segments: `
任务：根据字幕内容划分视频章节，并识别广告段落。

要求：
1. 按内容逻辑划分章节，粒度要适合进度条导航，不要只按“大事件”粗分。
   - 10 分钟以内：通常 4–7 个章节。
   - 10–25 分钟：通常 6–10 个章节。
   - 25–45 分钟：通常 8–12 个章节。
   - 45 分钟以上：通常 10–16 个章节。
   - 除非视频本身确实长期只讲同一件事，否则普通 content 章节尽量不要超过 5–7 分钟。
2. 每个章节需要有：
   - 一个简短清晰的小标题，像视频进度条章节标题
   - start_line 和 end_line，必须直接来自逐句字幕前的 #编号
3. 章节必须按时间顺序排列，并尽量连续覆盖视频内容，不要出现明显重叠或错序。
   - 但广告段例外：广告的 start 和 end 必须精确对应字幕中推广内容的实际边界，
   - 允许广告段与相邻 content 段之间存在小段空隙，不强求无缝衔接。
4. 必须覆盖视频全程，不要在视频中途停止分段，字幕中最后出现的内容必须被包含在某个章节内。
   - 遇到案件、人物、地点、观点、时间线、证据、争议点、结论明显切换时，应拆成新章节。
   - 广告前后的正文内容应拆成不同 content 章节，不要用一个超长 content 章节跨过广告。

广告识别规则：
5. 广告通常具有以下特征：
   - 博主从讲述视频内容转为推荐产品或服务
   - 出现品牌介绍、购买、下载、注册链接、优惠等内容
   - 出现"感谢赞助 / 本期视频由…支持 / 推荐大家试试"
   - 视频主线突然中断，插入与主题无关的推广

6. 广告边界定义：
   - 广告开始：字幕中第一条出现明确产品名、品牌名或购买引导的那一句，以该句时间戳为准。过渡语（如"咱们先缓缓""起来活动活动"）不算广告开始。
   - 广告结束：字幕中第一条重新出现"当事人说""话说回来""好了说回正题"或明确回归故事叙述的那一句，以该句时间戳为准。
   - 广告段内出现的"用户好评""家人推荐""朋友使用体验"等内容，仍属于广告段的一部分，不视为回归主线。

7. 时间戳规则（严格执行）：
   - 对所有段落，必须输出 start_line 和 end_line，line 值必须直接来自【分段与广告逐句字幕】中的 #编号。
   - 对广告段，还必须额外输出 ad_start_line 和 ad_end_line；通常它们应与 start_line/end_line 相同。
   - 所有段落的 start/end 可以先按对应行的时间填写，但最终系统会以 start_line/end_line 映射到原始字幕时间为准。
   - 转换方法：[m:ss] 转秒数 = m×60+ss，例如 [6:47] = 6×60+47 = 407。
   - 如果找不到对应的 #编号，宁可缩小到确定的字幕行，不要估算区间。

8. 其他规则：
   - 广告段标记为 ad，正常内容标记为 content。
   - 频道介绍、开场白、结尾感谢语不算广告。
   - 如果边界不确定，缩小广告区间，不要过度标记。
`,
    rumors: `
任务：识别视频中值得核查的重要声明，并评估其可信度。

筛选要求：
1. 只选择对视频核心结论、主要观点或关键判断有明显影响的声明。
2. 优先选择反直觉、争议性强、涉及事实判断，或需要验证的重要说法。
3. 忽略广告、情绪表达、主观感受、闲聊和无关描述。

分析要求：
4. 对每个声明进行简要分析，并判断其可信度。
5. 如果内容依赖实时信息、外部事实或当前无法确认的信息，可标记为 unknown。
6. 分析应尽量客观、简洁，不要展开过长论述。
7. 如果字幕存在明显识别错误，可结合上下文做合理理解，但不要凭空补充事实。
`
};

export const TONE_PROMPTS = {
    casual: `
表达风格（强制）：
- 更像在向朋友解释这个视频
- 优先回答：
    - 这个视频到底在讲什么
    - 为什么值得看
    - 哪些地方最有意思
- 可以适当加入“其实”“本质上”“相当于”等解释型表达
- 不要堆砌术语
- 更强调“让人容易理解”
`,

    balanced: `
输出风格清晰自然，
兼顾可读性与信息密度。
    
要求：
- 不要过度简写
- 不要只给结论
- 需要保留主要观点和关键细节
- 用自然易读的方式组织内容
- 避免过于学术化
- 避免过于口语化
- 更像高质量内容平台的编辑总结
`,

    professional: `
表达风格（强制）：
- 使用分析报告/研究摘要风格
- 不要只复述视频内容
- 优先提炼：
  - 视频真正想表达什么
  - 论点之间的逻辑关系
  - 作者隐含的判断与立场
  - 内容可能带来的影响
- 如果视频存在争议：
  - 要指出争议焦点
  - 分析不同观点背后的逻辑
- 更关注“为什么”与“意味着什么”
- 避免聊天感和情绪化表达
`
};

export const DETAIL_PROMPTS = {
    brief: `
输出长度控制（强制）：
- 只输出 2-3 个加粗小标题
- 每个小标题下最多 2 条项目符号
- 每条不超过 35 字
- 只保留核心结论和最关键事实
- 不展开背景、细节案例和影响分析
`,
    normal: `
输出长度控制（强制）：
- 输出 3-4 个加粗小标题
- 每个小标题下 2-3 条项目符号
- 每条控制在 35-60 字
- 覆盖主要观点、关键细节和必要背景
- 不需要展开所有例子
`,
    detailed: `
输出长度控制（强制）：
- 输出 4-6 个加粗小标题
- 每个小标题下 3-5 条项目符号
- 每条可写 50-90 字
- 充分展开背景、原因、过程、影响、争议和隐含结论
- 尽量保留关键案例、细节与逻辑链
`
};
export const DEFAULT_PROMPT_SETTINGS = {
    mode: "guided",
    guided: {
        tone: "balanced",
        detail: "normal"
    },
    custom: {
        summary: TASK_PROMPTS.summary,
        segments: TASK_PROMPTS.segments,
        rumors: TASK_PROMPTS.rumors
    }
};

export function normalizePromptSettings(raw) {
    const base = raw && typeof raw === "object" ? raw : {};
    const mode = base.mode === "custom" ? "custom" : "guided";
    const guidedRaw = base.guided && typeof base.guided === "object" ? base.guided : {};
    const customRaw = base.custom && typeof base.custom === "object" ? base.custom : {};
    const tone = Object.prototype.hasOwnProperty.call(TONE_PROMPTS, guidedRaw.tone) ? guidedRaw.tone : "balanced";
    const detail = Object.prototype.hasOwnProperty.call(DETAIL_PROMPTS, guidedRaw.detail) ? guidedRaw.detail : "normal";
    return {
        mode,
        guided: { tone, detail },
        custom: {
            summary: String(customRaw.summary || TASK_PROMPTS.summary),
            segments: String(customRaw.segments || TASK_PROMPTS.segments),
            rumors: String(customRaw.rumors || TASK_PROMPTS.rumors)
        }
    };
}

export function formatDurationAsClock(totalSeconds) {
    const total = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function resolveDurationPromptContext(taskContext) {
    const totalSeconds = Number(taskContext?.videoDuration?.totalSeconds || 0);
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
    const normalizedSec = Math.floor(totalSeconds);
    const formattedTime = String(taskContext?.videoDuration?.formattedTime || "").trim() || formatDurationAsClock(normalizedSec);
    return { totalSeconds: normalizedSec, formattedTime };
}

export function buildVideoMetaBlock(taskContext) {
    const info = resolveDurationPromptContext(taskContext);
    if (!info) return "";
    return `【视频元数据】\n视频总时长为 ${info.totalSeconds} 秒 (${info.formattedTime})。`;
}

export function buildDurationHardRule(taskContext) {
    if (taskContext?.noSubtitleTimestamps) {
        return "核心强制：当前字幕没有真实时间轴。请按字幕 line_id 完整覆盖视频内容，start_line/end_line/ad_start_line/ad_end_line 必须来自 #编号；start/end 仅作为兼容字段，可填写对应行号，不要编造秒级时间。";
    }
    const info = resolveDurationPromptContext(taskContext);
    if (!info) return "";
    const lastSegmentStart = Math.floor(info.totalSeconds * 0.75);
    const minutes = info.totalSeconds / 60;
    let target = "6-8";
    let maxContentMinutes = 5;
    if (minutes <= 10) {
        target = "4-7";
        maxContentMinutes = 4;
    } else if (minutes <= 25) {
        target = "6-10";
        maxContentMinutes = 5;
    } else if (minutes <= 45) {
        target = "8-12";
        maxContentMinutes = 6;
    } else {
        target = "10-16";
        maxContentMinutes = 7;
    }
    return `核心强制：视频总时长 ${info.totalSeconds} 秒（${info.formattedTime}），最后一个章节的 start 必须大于 ${lastSegmentStart} 秒，确保视频后半段内容（包括结局）不被遗漏。章节时间戳必须直接来自字幕，禁止估算。请根据总时长将章节控制为 ${target} 个，普通 content 章节尽量不要超过 ${maxContentMinutes} 分钟；如果出现案件阶段、人物视角、证据、观点或结论切换，必须拆成新章节，不要为了少分段把多个主题合并。`;
}

export function buildNoTimestampTaskRule(type, taskContext) {
    if (!taskContext?.noSubtitleTimestamps) return "";
    if (type === "segments") {
        return "【无时间轴处理规则】本次字幕没有真实开始/结束秒数。分段和广告识别以 line_id 为准，必须输出 start_line/end_line；广告还必须输出 ad_start_line/ad_end_line。start/end 可填写对应行号作为兼容字段，系统会按 line_id 生成无时间轴分段。";
    }
    if (type === "rumors") {
        return "【无时间轴处理规则】本次字幕没有真实时间轴。验真仍需正常输出 claims；每条 claim 的 timestamp_sec 填 0，系统会隐藏跳转时间。不要因为没有时间戳拒绝验真。";
    }
    return "";
}

export function buildPrompt({
    type,
    subtitle,
    mode = "guided",
    guided = {},
    customPrompts = {},
    taskContext = {}
}) {
    const noTimestampRule = buildNoTimestampTaskRule(type, taskContext);
    const formatRule = [
        TASK_PROMPT_FORMAT_RULES[type] || "",
        type === "segments" && taskContext?.noSubtitleTimestamps
            ? "补充：无时间轴字幕中 start/end 可使用 line_id 兼容值；start_line/end_line 才是最终依据。"
            : ""
    ].filter(Boolean).join("\n");
    const videoMetaBlock = buildVideoMetaBlock(taskContext);
    const durationHardRule = type === "segments" ? buildDurationHardRule(taskContext) : "";
    const subtitleBlock = `【字幕内容】\n${subtitle}`.trim();
    if (mode === "custom") {
        const userPrompt = customPrompts[type] || TASK_PROMPTS[type] || "";
        return [
            BASE_PROMPT,
            userPrompt,
            noTimestampRule,
            durationHardRule,
            videoMetaBlock,
            subtitleBlock,
            formatRule
        ].filter(Boolean).join("\n\n");
    }
    const isSummaryTask = type === "summary";
    const toneRule = isSummaryTask ? (TONE_PROMPTS[guided.tone || "balanced"] || "") : "";
    const detailRule = isSummaryTask ? (DETAIL_PROMPTS[guided.detail || "normal"] || "") : "";
    return [
        BASE_PROMPT,
        TASK_PROMPTS[type],
        isSummaryTask ? "【输出风格要求】" : "",
        toneRule,
        detailRule,
        noTimestampRule,
        durationHardRule,
        videoMetaBlock,
        subtitleBlock,
        formatRule
    ].filter(Boolean).join("\n\n");
}

export function buildSegmentsAdTestPrompt({
    subtitle,
    taskContext = {}
}) {
    const videoMetaBlock = buildVideoMetaBlock(taskContext);
    const durationHardRule = buildDurationHardRule(taskContext);
    const noTimestampRule = buildNoTimestampTaskRule("segments", taskContext);
    const subtitleBlock = `【字幕内容】\n${subtitle}`.trim();
    return [
        SEGMENTS_AD_TEST_PROMPT,
        noTimestampRule,
        durationHardRule,
        videoMetaBlock,
        subtitleBlock
    ].filter(Boolean).join("\n\n");
}

export function buildCompactSegmentsPrompt({
    subtitle,
    taskContext = {}
}) {
    const videoMetaBlock = buildVideoMetaBlock(taskContext);
    const noTimestampRule = buildNoTimestampTaskRule("segments", taskContext);
    const subtitleBlock = `【字幕内容】\n${subtitle}`.trim();
    return [
        "你是一个 B 站视频章节分段助手，同时你需要识别广告。现在必须使用极简格式重新生成。",
        "【核心要求】",
        "- 严禁逐句分段，必须按章节级内容分段。",
        "- 10 分钟以内输出 4-7 段；10-25 分钟输出 6-10 段；25-45 分钟输出 8-12 段；45 分钟以上输出 10-16 段。",
        "- 每个 label 控制在 8-16 个中文字，必须概括本段核心事件或观点，不要只写泛化词。",
        "- 必须覆盖从第一行到最后一行字幕，最后一段 end_line 必须接近最后一个 #编号。",
        "- 如果有广告，type 写 \"ad\"；普通内容 type 写 \"content\"。",
        "【广告要求】",
        "- 广告通常具有以下特征：",
        "- 博主从讲述视频内容转为推荐产品或服务",
        "- 出现品牌介绍、购买、下载、注册链接、优惠等内容",
        "- 出现感谢赞助 / 本期视频由…支持 / 推荐大家试试",
        "- 视频主线突然中断，插入与主题无关的推广",
        "- 广告段必须输出 ad_start_line 和 ad_end_line，通常它们应与 start_line/end_line 相同。",
        "【极简输出格式】",
        "只输出 JSON 数组，不要 Markdown，不要解释，不要代码块。",
        "普通段只允许字段：{\"start_line\":0,\"end_line\":50,\"label\":\"背景铺垫\",\"type\":\"content\"}",
        "广告段只允许字段：{\"start_line\":120,\"end_line\":145,\"label\":\"广告推广\",\"type\":\"ad\",\"ad_start_line\":120,\"ad_end_line\":145}",
        "禁止输出 start/end 秒数，系统会用 line_id 自动映射时间。",
        noTimestampRule,
        videoMetaBlock,
        subtitleBlock
    ].filter(Boolean).join("\n\n");
}

export function buildMergedSummarySegmentsPrompt({
    subtitle,
    mode = "guided",
    guided = {},
    customPrompts = {},
    taskContext = {},
    segmentsPromptOverride = ""
}) {
    const videoMetaBlock = buildVideoMetaBlock(taskContext);
    const durationHardRule = buildDurationHardRule(taskContext);
    const noTimestampRule = buildNoTimestampTaskRule("segments", taskContext);
    const subtitleBlock = `【字幕内容】\n${subtitle}`.trim();
    const summaryPrompt = mode === "custom"
        ? (customPrompts.summary || TASK_PROMPTS.summary || "")
        : (TASK_PROMPTS.summary || "");
    const segmentsPrompt = mode === "custom"
        ? (customPrompts.segments || TASK_PROMPTS.segments || "")
        : (TASK_PROMPTS.segments || "");
    const parts = [BASE_PROMPT, "【任务1：视频总结】", summaryPrompt];
    if (mode !== "custom") {
        const toneRule = TONE_PROMPTS[guided.tone || "balanced"] || "";
        const detailRule = DETAIL_PROMPTS[guided.detail || "normal"] || "";
        parts.push("【任务1输出风格要求】", toneRule, detailRule);
    }
    parts.push("【任务2：视频分段】", segmentsPromptOverride || segmentsPrompt, noTimestampRule, durationHardRule);
    parts.push(MERGED_SEGMENTS_FORMAT_RULE);
    parts.push(videoMetaBlock);
    parts.push(subtitleBlock);
    parts.push(OUTPUT_PROTOCOL);
    return parts.filter(Boolean).join("\n\n");
}

export function extractProtocolSection(text, startTag, endTag) {
    const source = String(text || "");
    const startIndex = source.indexOf(startTag);
    if (startIndex < 0) {
        return { found: false, content: "" };
    }
    const contentStart = startIndex + startTag.length;
    const endIndex = source.indexOf(endTag, contentStart);
    if (endIndex < 0) {
        return { found: false, content: "" };
    }
    return {
        found: true,
        content: source.slice(contentStart, endIndex).trim()
    };
}

export function extractFirstProtocolSection(text, tags) {
    const list = Array.isArray(tags) ? tags : [];
    for (const pair of list) {
        const startTag = pair?.[0];
        const endTag = pair?.[1];
        if (!startTag || !endTag) continue;
        const section = extractProtocolSection(text, startTag, endTag);
        if (section.found) return section;
    }
    return null;
}
