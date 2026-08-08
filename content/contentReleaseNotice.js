// content/contentReleaseNotice.js

(function () {
  const STORAGE_KEY = "bilitato_last_seen_version";

  const RELEASE_NOTES = {
    "1.6.3": {
      title: "Bilitato 已更新至 v1.6.3",
      displayVersion: "v1.6.3",
      subtitle: "本次重点优化分 P 字幕切换、ModelScope 自动降级和服务通知体验。",
      groups: [
        {
          tag: "新增",
          items: [
            {
              title: "新增公告中心",
              desc: "插件标题栏会提示重要服务变更，也可以在设置中查看历史公告；已读公告可关闭，不会反复打扰。",
              highlight: true,
            },
          ],
        },
        {
          tag: "优化",
          items: [
            {
              title: "ModelScope 降级更及时",
              desc: "模型当日额度耗尽或暂时不可用时，会自动切换到其他可用模型，并提示当前处理状态。",
              highlight: true,
            },
            {
              title: "Gemini 限流提示更清楚",
              desc: "服务返回明确等待时间时，插件会显示倒计时提示，并在等待结束后自动重试一次。",
            },
            {
              title: "转录配置提醒更直接",
              desc: "开始转录前会检查当前语音识别服务的 API Key；未填写时可直接前往设置。",
            },
          ],
        },
        {
          tag: "修复",
          items: [
            {
              title: "修复分 P 字幕切换闪烁",
              desc: "已确认属于当前分 P 的字幕，不再被迟到的重复路由通知清空，同时继续严格校验 BVID、P 和 CID。",
              highlight: true,
            },
            {
              title: "修复分 P 缓存身份波动",
              desc: "统一首页分 P 标识的空值与 P1 表示，减少字幕先出现、短暂丢失后又恢复的问题。",
            },
            {
              title: "修复其他 Provider 错用 Qwen 降级",
              desc: "自动切换备用模型严格限制在 ModelScope，Gemini、自定义 Provider 等继续使用各自原有请求与重试方式。",
            },
            {
              title: "修复空总结直接失败",
              desc: "ModelScope 返回结束但没有总结正文时，会优先尝试可用备用模型，提高任务最终完成率。",
            },
          ],
        },
      ],
      privacy: "Bilitato 不会上传您的 API Key、Prompt 或与 AI 的聊天内容。公告仅同步公开服务通知，自动降级不会修改您保存的默认模型。",
    },
    "1.6.2": {
      title: "Bilitato 已更新至 v1.6.2",
      displayVersion: "v1.6.2",
      subtitle: "兜底机制大修复：集中提升字幕读取、AI 总结和模型调用的稳定性。",
      groups: [
        {
          tag: "优化",
          items: [
            {
              title: "AI 重试更有针对性",
              desc: "根据输出截断、内容为空和格式异常采用不同的恢复方式，大多数临时异常会在后台自动处理。",
              highlight: true,
            },
            {
              title: "ModelScope 调用更稳定",
              desc: "模型限流或暂时不可用时自动尝试其他可用模型，并避开当天已经确认额度不足的模型。",
            },
            {
              title: "优化 DeepSeek V4 重试",
              desc: "思考内容占满输出空间时，第二次重试会优先保证总结正文完整返回。",
            },
            {
              title: "字幕读取状态更清楚",
              desc: "字幕读取期间，总结与事实核查会同步等待，不再提前显示“暂无字幕”。",
            },
            {
              title: "错误提示与统计更准确",
              desc: "用户配置、主动取消等情况不再作为插件故障处理，减少无效错误提示。",
            },
          ],
        },
        {
          tag: "修复",
          items: [
            {
              title: "修复已有字幕却无法总结",
              desc: "修复字幕已经显示，但总结页仍提示“暂无字幕”的问题。",
              highlight: true,
            },
            {
              title: "修复字幕缓存被错误清空",
              desc: "CID 暂时未获取到时，不再清空同一视频已有的有效字幕缓存。",
            },
            {
              title: "修复分 P 路由误判",
              desc: "播放器加载时的 CID 波动不再被误认为切换分 P，同时继续严格隔离不同分 P 的字幕与总结。",
            },
            {
              title: "修复快速切换分 P 串线",
              desc: "快速切换选集时，字幕、总结和视频分段会继续对应当前分 P。",
            },
            {
              title: "修复异常输出直接失败",
              desc: "总结为空、输出被截断、JSON 格式或字段结构异常时，会自动修复或重试。",
            },
            {
              title: "修复失败状态重复统计",
              desc: "同一次任务只按最终结果记录，避免中间重试被重复计为任务失败。",
            },
          ],
        },
      ],
      privacy: "Bilitato 不会上传您的 API Key、Prompt 或与 AI 的聊天内容。自动重试仅使用当前任务所需的字幕和用户已有配置。",
    },
    "1.6.1": {
      title: "Bilitato 已更新至 v1.6.1",
      displayVersion: "v1.6.1",
      subtitle: "本次重点降低远程配置带来的服务压力，并同步更新 ModelScope 当前可用模型。",
      groups: [
        {
          tag: "优化",
          items: [
            {
              title: "远程配置更轻量",
              desc: "不再保持远程配置长连接，改为优先读取本地缓存并每日更新一次，减少后台连接和请求对正常使用的影响。",
              highlight: true,
            },
            {
              title: "服务异常时继续使用缓存",
              desc: "远程配置暂时不可用时会继续使用本地配置，不影响字幕、总结、分段和聊天等主要功能。",
            },
          ],
        },
        {
          tag: "更新",
          items: [
            {
              title: "更新 ModelScope 模型列表",
              desc: "新增并整理 Qwen3 与 DeepSeek V4 当前可用模型，旧版 DeepSeek-V4-Flash 会自动切换到推荐模型。",
              highlight: true,
            },
            {
              title: "推荐模型更容易选择",
              desc: "默认使用 Qwen3-30B-A3B-Instruct-2507，并保留 Qwen3、DeepSeek V4 Pro 和 DeepSeek V4 Flash 0731 等可用选项。",
            },
          ],
        },
      ],
      privacy: "Bilitato 不会上传您的 API Key、Prompt 或与 AI 的聊天内容。远程配置仅同步公开的可用模型和功能开关。",
    },
    "1.6.0": {
      title: "Bilitato 已更新至 v1.6",
      displayVersion: "v1.6",
      subtitle: "从 v1.5.1 以来，我们补齐了高清下载、MiMo 字幕、AI 自动恢复和远程模型配置，并集中修复字幕缓存与 Provider 错误处理。",
      groups: [
        {
          tag: "新增",
          items: [
            {
              title: "高清下载模式",
              desc: "新增按清晰度下载视频，可选择 AVC、HEVC、AV1 等可用编码；同时保留兼容下载，方便在不同视频和网络环境下切换。",
              highlight: true,
            },
            {
              title: "新增 MiMo 语音识别",
              desc: "没有站内字幕时，可以选择小米 MiMo 生成字幕，为总结、分段和聊天补充文本来源。",
            },
            {
              title: "模型与功能配置可动态更新",
              desc: "Provider、模型列表和部分恢复策略可以在线同步，后续兼容新模型时不必每次等待插件发版。",
            },
          ],
        },
        {
          tag: "修复",
          items: [
            {
              title: "AI 返回异常时自动恢复",
              desc: "遇到输出被截断、总结为空、JSON 格式错误或字段结构异常时，会自动提高输出上限、重试或修复，减少生成到一半直接失败。",
              highlight: true,
            },
            {
              title: "修复高清下载链接失效或变成网页",
              desc: "每次下载都会刷新视频流签名、校验响应类型并优先选择可直连的备用 CDN，减少保存为 .htm、找不到视频流或无法提取文件的问题。",
            },
            {
              title: "修复已有字幕却提示暂无字幕",
              desc: "优化单集视频和路由切换期间的字幕缓存读取；总结重试会沿用原来的请求方式、字幕和当前视频上下文。",
            },
            {
              title: "修复字幕控制状态不同步",
              desc: "改善播放器字幕入口、字幕列表和缓存状态之间的同步，减少已有字幕却反复检测、切换后状态不更新等问题。",
            },
            {
              title: "修复自定义 Provider 错误提示不准确",
              desc: "当接口返回登录页、代理错误页、模型不存在或鉴权失败时，会展示更贴近真实原因的提示。",
            },
            {
              title: "修复分段指令冲突",
              desc: "移除互相矛盾的分段要求，统一字幕输入上限，减少模型返回空内容、非 JSON 或不符合字段结构的情况。",
            },
          ],
        },
        {
          tag: "优化",
          items: [
            {
              title: "重试过程保持无感",
              desc: "可恢复的问题会在后台自动处理，最终成功时不会打断使用；只有确实无法恢复时才展示错误。",
            },
            {
              title: "JSON 与字段结构分级修复",
              desc: "优先在本地修复 JSON 和字段别名，仍无法处理时再按远程开关调用专用修复请求，尽量减少额外等待和消耗。",
            },
            {
              title: "错误提示与诊断更清楚",
              desc: "补充分次 AI 响应、结束原因和下载阶段信息，同时减少用户取消、缺少配置、无字幕等非程序故障造成的错误噪声。",
            },
            {
              title: "补充重试测试工具",
              desc: "测试面板可以模拟输出截断、总结为空和修复重试，方便确认各类异常在前端的最终展示。",
            },
          ],
        },
      ],
      privacy: "Bilitato 不会上传您的 API Key、Prompt 或与 AI 的聊天内容。远程配置仅用于同步可用模型与功能开关，不会下发或读取您的私密配置。",
    },
    "1.5.x": {
      title: "Bilitato v1.5 系列更新回顾",
      displayVersion: "v1.5",
      subtitle: "v1.5 与 v1.5.1 合并展示：新增侧边栏、主题、插件显示和缓存管理，并重点修复分 P 视频内容串线。",
      groups: [
        {
          tag: "新增",
          items: [
            {
              title: "插件显示模式",
              desc: "可在设置中选择默认缩起或默认展开；缩起后仅保留标题栏和总结按钮，也可以点击标题栏随时展开。",
              highlight: true,
            },
            {
              title: "浏览器侧边栏模式",
              desc: "可以把 Bilitato 打开到浏览器侧边栏，使用更宽的空间查看字幕、总结、聊天、验真和设置。",
            },
            {
              title: "深色 / 浅色模式与缓存管理",
              desc: "新增跟随系统、浅色和深色主题；可以删除当前视频或全部 AI 缓存，并按需关闭云端缓存拉取。",
            },
            {
              title: "Groq 自定义 Base URL",
              desc: "Groq 支持使用 Cloudflare 等兼容中转地址，连接检测和转录请求都会使用修改后的地址。",
            },
            {
              title: "可用版本更新提醒",
              desc: "检测到新版本时会在标题旁显示提示，点击即可前往浏览器扩展管理页更新。",
            },
          ],
        },
        {
          tag: "修复",
          items: [
            {
              title: "修复分 P 视频内容串线",
              desc: "字幕、总结、分段、聊天和任务进度按当前分 P 的真实 CID 隔离，切换选集后不会再显示上一集内容。",
              highlight: true,
            },
            {
              title: "修复字幕切换与加载异常",
              desc: "优化视频、分 P 和字幕语言切换时的状态同步，减少字幕一直加载、显示旧字幕、语言回切失败或菜单错位。",
            },
            {
              title: "修复单 P 视频无法读取云端缓存",
              desc: "普通单集视频可以正常读取旧版云端缓存，不会因为缺少分 P 信息而跳过。",
            },
            {
              title: "修复原生章节视频的分段标记错位",
              desc: "视频自带 B 站章节时，Bilitato 生成的分段标记会正确分布在整条进度条上。",
            },
          ],
        },
        {
          tag: "优化",
          items: [
            {
              title: "优化缩起与总结阅读体验",
              desc: "总结完成后自动展开，再次缩起时显示“查看总结”；同时增加总结区域，避免视频分段占用过多空间。",
            },
            {
              title: "优化新功能引导与反馈提示",
              desc: "设置入口新增功能红点；反馈标题或内容为空时会分别给出明确提示。",
            },
            {
              title: "优化主题、指标和总结显示",
              desc: "改善深色模式可读性、调用指标浮层和模型思考内容清理，让面板信息更清楚。",
            },
          ],
        },
      ],
      privacy: "本插件不会上传任何 API Key、Prompt 或您和 AI 的聊天内容。字幕与总结缓存仍保存在浏览器本地。",
    },
    "1.4.x": {
      title: "Bilitato v1.4 系列更新回顾",
      displayVersion: "v1.4",
      subtitle: "v1.4 系列主要打磨侧边栏、缓存、模型选项、更新提醒和错误恢复体验。新增能力已统一归入 v1.5，这里保留各版本的优化与修复重点。",
      groups: [
        {
          tag: "v1.4.3",
          sections: [
            {
              tag: "修复",
              items: [
                {
                  title: "修复侧边栏切回内嵌偶发无效",
                  desc: "修复点击切回内嵌面板后，侧边栏关闭了但页面仍保持侧边栏状态的问题。",
                  highlight: true,
                },
                {
                  title: "修复更新导览显示细节",
                  desc: "更新导览弹层不再被页面右上角按钮干扰，阅读更新内容更干净。",
                },
              ],
            },
            {
              tag: "优化",
              items: [
                {
                  title: "优化缓存管理区域",
                  desc: "缓存删除和云端缓存拉取开关的排版更舒展，宽侧边栏里不再显得拥挤。",
                },
                {
                  title: "补充测试入口",
                  desc: "测试页新增可用版本更新入口，方便确认更新提示和跳转是否正常。",
                },
              ],
            },
          ],
        },
        {
          tag: "v1.4.2",
          sections: [
            {
              tag: "修复",
              items: [
                {
                  title: "修复侧边栏体验不一致",
                  desc: "侧边栏的字幕、总结、聊天、验真和设置样式进一步对齐内嵌面板，复制、下载、提示气泡和滚动表现更一致。",
                  highlight: true,
                },
                {
                  title: "修复聊天和总结滚动异常",
                  desc: "修复流式输出时页面跳到顶部、切换新视频后聊天引导缺失、复制后无反馈等问题。",
                },
                {
                  title: "修复下载兼容问题",
                  desc: "针对部分浏览器直接下载 B 站音视频时的跨域失败，改为更兼容的下载链路。",
                },
              ],
            },
            {
              tag: "优化",
              items: [
                {
                  title: "更新 ModelScope 模型选项",
                  desc: "根据 ModelScope 当前可直接调用的模型范围更新默认选项，并补充更清晰的额度提示。",
                },
                {
                  title: "优化侧边栏与内嵌面板切换",
                  desc: "打开侧边栏后自动隐藏内嵌面板，切回内嵌时再恢复，页面不再同时出现两套入口。",
                },
              ],
            },
          ],
        },
        {
          tag: "v1.4.1 / v1.4.0",
          sections: [
            {
              tag: "修复",
              items: [
                {
                  title: "修复 B 站原生字幕默认露出和黑框残留",
                  desc: "针对 B 站字幕懒加载，改为自动触发后只做无感隐藏，并在用户手动碰字幕按钮时立刻恢复。",
                  highlight: true,
                },
                {
                  title: "优化错误面板恢复路径",
                  desc: "限额、限流和请求失败时提供更明确的重试、返回或设置入口，减少卡在错误状态的情况。",
                },
              ],
            },
            {
              tag: "优化",
              items: [
                {
                  title: "优化反馈中心与使用数据",
                  desc: "反馈入口降级更稳，调用耗时、Token 和额度提示也更清楚。",
                },
                {
                  title: "优化原生字幕接管",
                  desc: "字幕抓取、隐藏和恢复逻辑更稳定，减少默认开字幕时的闪动和误触。",
                },
              ],
            },
          ],
        },
      ],
      privacy: "本插件不会上传任何 API Key、Prompt 或您和 AI 的聊天内容。缓存管理只影响浏览器本机保存的数据，不会删除您的 B 站数据。",
    },
    "1.4.3": {
      title: "Bilitato 已更新至 v1.4.3",
      displayVersion: "v1.4.3",
      subtitle: "这版继续打磨侧边栏和更新体验：切回内嵌面板更稳定，缓存管理更清楚，也能在有新版可用时更早提醒你。",
      groups: [
        {
          tag: "新增",
          items: [
            {
              title: "新增可用版本更新提醒",
              desc: "当插件检测到有新版本可用时，会在标题旁显示小提示，点击即可打开浏览器扩展管理页进行更新。",
              highlight: true,
            },
          ],
        },
        {
          tag: "修复",
          items: [
            {
              title: "修复侧边栏切回内嵌偶发无效",
              desc: "修复点击切回内嵌面板后，侧边栏关闭了但页面仍保持侧边栏状态的问题。",
              highlight: true,
            },
            {
              title: "修复更新导览显示细节",
              desc: "更新导览弹层现在不会再被页面右上角按钮干扰，阅读更新内容更干净。",
            },
          ],
        },
        {
          tag: "优化",
          items: [
            {
              title: "优化缓存管理区域",
              desc: "缓存删除和云端缓存拉取开关的排版更舒展，宽侧边栏里不再显得拥挤。",
            },
            {
              title: "补充测试入口",
              desc: "测试页新增可用版本更新入口，方便确认更新提示和跳转是否正常。",
            },
          ],
        },
      ],
      privacy: "本插件不会上传任何 API Key、Prompt 或您和 AI 的聊天内容。版本检查只读取插件最新版本号，不包含视频内容、字幕、聊天或个人配置。",
    },
    "1.4.2": {
      title: "Bilitato 已更新至 v1.4.2",
      displayVersion: "v1.4.2",
      subtitle: "这版重点补上浏览器侧边栏、缓存管理和一批细节体验修复，让看视频时的操作更稳定、更顺手。",
      groups: [
        {
          tag: "新增",
          items: [
            {
              title: "新增浏览器侧边栏模式",
              desc: "可以把 Bilitato 打开到浏览器侧边栏里使用，字幕、总结、聊天、验真和设置都能在更宽的空间里操作。",
              highlight: true,
            },
            {
              title: "新增本地缓存清理",
              desc: "设置页现在可以删除当前视频缓存，也可以一键清空所有视频缓存，误点前会先二次确认。",
            },
          ],
        },
        {
          tag: "修复",
          items: [
            {
              title: "修复侧边栏体验不一致",
              desc: "侧边栏的字幕、总结、聊天、验真和设置样式进一步对齐内嵌面板，复制、下载、提示气泡和滚动表现更一致。",
              highlight: true,
            },
            {
              title: "修复聊天和总结滚动异常",
              desc: "修复流式输出时页面跳到顶部、切换新视频后聊天引导缺失、复制后无反馈等问题。",
            },
            {
              title: "修复下载兼容问题",
              desc: "针对部分浏览器直接下载 B 站音视频时的跨域失败，改为更兼容的下载链路。",
            },
          ],
        },
        {
          tag: "优化",
          items: [
            {
              title: "更新 ModelScope 模型选项",
              desc: "根据 ModelScope 当前可直接调用的模型范围更新默认选项，并补充更清晰的额度提示。",
            },
            {
              title: "优化侧边栏与内嵌面板切换",
              desc: "打开侧边栏后自动隐藏内嵌面板，切回内嵌时再恢复，页面不再同时出现两套入口。",
            },
          ],
        },
      ],
      privacy: "本插件不会上传任何 API Key、Prompt 或您和 AI 的聊天内容。本地缓存清理只会删除浏览器本机保存的视频缓存，不会删除您的 B 站数据。",
    },
    "1.4.1": {
      title: "Bilitato 已更新至 v1.4.1",
      displayVersion: "v1.4.1",
      subtitle: "本次重点升级原生字幕接管、错误面板、反馈中心与使用数据打点，集中优化默认开字幕暴露、限流提示过轻、反馈服务误伤主流程和模型选择范围不够的问题。",
      groups: [
        {
          tag: "新增",
          items: [
            {
              title: "新增小米 MiMo Provider",
              desc: "设置页现在支持直接选择小米 MiMo，并内置常用模型候选项，扩充了可用模型池。",
              highlight: true,
            },
          ],
        },
        {
          tag: "修复",
          items: [
            {
              title: "修复 B 站原生字幕默认露出和黑框残留",
              desc: "针对 B 站字幕懒加载，改为自动触发后只做无感隐藏，并在用户手动碰字幕按钮时立刻恢复，避免按钮卡死、黑框残留和字幕露出。",
              highlight: true,
            },
            {
              title: "修复合集/分 P 切换时字幕串线",
              desc: "字幕抓取改为按 `bvid + p` 路由识别，切换合集或分 P 时会更准确地重置状态，减少把上一个视频字幕带到当前视频的问题。",
            },
            {
              title: "修复反馈服务异常误导感",
              desc: "反馈中心不可用时继续按非阻塞方式降级，只影响反馈入口，不再给人主功能也会受影响的感觉。",
            },
          ],
        },
        {
          tag: "优化",
          items: [
            {
              title: "429 / 5XX 改为面板提示",
              desc: "高频限流和服务异常不再只弹 Toast，而是进入面板卡片，并统一补上重试按钮。",
            },
            {
              title: "细化 402 / 429 错误文案",
              desc: "现在会区分余额不足、模型不可用、配额耗尽、频率限制和队列拥堵，用户更容易知道该换模型、等一会儿还是去设置。",
            },
          ],
        },
      ],
      privacy: "本插件不会上传任何 API Key、Prompt 或您和 AI 的聊天内容。新增的使用行为上报仅记录任务状态、Provider、模型、耗时等统计字段，不包含聊天正文、Prompt 或字幕原文。",
    },
    "1.4.0": {
      title: "Bilitato 已更新至 v1.4.0",
      displayVersion: "v1.4.0",
      subtitle: "本次重点升级长音频转录、分段容错和转录稳定性，集中优化超大音轨转录、视频切换串线、按钮状态异常和错误提示不清的问题。",
      groups: [
        {
          tag: "新增",
          items: [
            {
              title: "长音频自动切片转录",
              desc: "超出服务限制的音轨现在会先自动切片，再分段转录，减少“音频过大无法转录”的情况。",
              highlight: true,
            },
            {
              title: "额度说明更清晰",
              desc: "Groq 和 ModelScope 常用模型的额度说明现在可以直接在设置页查看。",
            },
          ],
        },
        {
          tag: "修复",
          items: [
            {
              title: "修复字幕串到上一个视频",
              desc: "修复切换视频后偶发沿用旧音轨，导致字幕串线的问题。",
              highlight: true,
            },
            {
              title: "修复转录按钮和进度异常",
              desc: "修复按钮短暂释放、进度条中断后又恢复等问题，转录过程更稳定。",
            },
            {
              title: "修复分段生成易失败",
              desc: "修复分段 JSON、字段缺失、占位值等问题导致整体失败的情况。",
            },
          ],
        },
        {
          tag: "优化",
          items: [
            {
              title: "优化长音频转录体验",
              desc: "Groq 与硅基流动都补强了超限场景下的自动切片处理能力。",
            },
            {
              title: "优化错误提示",
              desc: "现在能更明确区分限流、切片失败、自动切片仍超限、时长识别失败等不同原因。",
            },
            {
              title: "优化设置页交互",
              desc: "下拉项说明提示的位置和展示方式更自然，不再容易被遮挡或裁切。",
            },
          ],
        },
      ],
      privacy: "本插件不会上传任何 API Key、Prompt 或您和 AI 的聊天内容。长音频切片与合并在本地完成，仅在实际调用您选择的转录服务时上传必要音频内容。",
    },
    "1.3.x": {
      title: "Bilitato v1.3 系列更新回顾",
      displayVersion: "v1.3.1 - v1.3.0",
      subtitle: "v1.3 系列的更新总结。",
      groups: [
        {
          tag: "v1.3.1",
          sections: [
            {
              tag: "新增",
              items: [
                {
                  title: "错误提示更具体",
                  desc: "细分了超时、Provider 网络失败、模型无权限、阿里云未实名、模型 ID 无效等前端错误提示，并统一补上刷新或重试入口。",
                },
              ],
            },
            {
              tag: "修复",
              items: [
                {
                  title: "修复总结与分段状态不同步",
                  desc: "修复总结已完成但分段偶发被旧缓存覆盖成空数组，导致页面误显示尚未生成分段的问题。",
                  highlight: true,
                },
                {
                  title: "修复提示词被切换重置",
                  desc: "修复切换 Groq、硅基流动或主 Provider 时，个性化里的自定义提示词被回填成默认值的问题。",
                },
                {
                  title: "修复本地缓存与配额问题",
                  desc: "增加 unlimitedStorage 和本地缓存兜底，避免字幕缓存过大时反复触发 QUOTA_BYTES 上报。",
                },
              ],
            },
            {
              tag: "优化",
              items: [
                {
                  title: "Provider 网络失败无感重试",
                  desc: "普通模型请求遇到短暂网络波动时会自动短退避重试；流式请求仅在首包前失败时补重试一次，减少偶发生成失败。",
                },
                {
                  title: "分段空返回自动补救",
                  desc: "分段为空或格式跑偏时，会保留更完整诊断信息，并在合适场景自动尝试更紧凑的补救请求。",
                },
              ],
            },
          ],
        },
        {
          tag: "v1.3.0",
          sections: [
            {
              tag: "新增",
              items: [
                {
                  title: "反馈中心",
                  desc: "现在可以在插件内提交问题与建议，并查看处理状态和回复提醒。",
                },
                {
                  title: "更多 Provider 支持",
                  desc: "新增 OpenRouter 和 Claude 支持，完善 Gemini、OpenAI、DeepSeek、Kimi、智谱等模型候选项。",
                  highlight: true,
                },
              ],
            },
            {
              tag: "优化",
              items: [
                {
                  title: "模型设置更好用",
                  desc: "不同 Provider 会分别记忆 API Key 和模型选择，自定义 Provider 支持自动授权域名。",
                },
                {
                  title: "免费额度提示",
                  desc: "ModelScope、Gemini、OpenRouter 增加免费额度标记，悬停即可查看 RPM、RPD 等限额信息。",
                },
                {
                  title: "多模型兼容更稳定",
                  desc: "优化 OpenRouter、Gemini、Claude、自定义 API 等流式返回解析，减少总结为空和生成失败。",
                  highlight: true,
                },
              ],
            },
            {
              tag: "修复",
              items: [
                {
                  title: "修复字幕缓存读取",
                  desc: "修复本地/云端字幕已存在时，聊天、总结、验真偶发提示暂无字幕的问题。",
                },
                {
                  title: "修复转录状态异常",
                  desc: "修复在线转录按钮闪烁、进度回退、下载后短暂误显示无字幕等问题。",
                },
                {
                  title: "修复聊天体验问题",
                  desc: "修复聊天报错后页面置底、无字幕状态误上报异常、输入空格和输入法异常等问题。",
                },
              ],
            },
          ],
        },
      ],
      privacy: "本插件不会上传任何 API Key、Prompt 或您和 AI 的聊天内容。反馈中心仅在您主动提交时上传问题内容和必要异常日志。",
    },
    "1.2.x": {
      title: "Bilitato v1.2 系列更新回顾",
      displayVersion: "v1.2.3 - v1.2.0",
      subtitle: "v1.2 系列的更新总结。",
      groups: [
        {
          tag: "v1.2.3",
          sections: [
            {
              tag: "优化",
              items: [
                {
                  title: "字幕缓存更稳定",
                  desc: "CC、总结、聊天、验真都会主动读取云端字幕；云端已有字幕时会直接加载，减少重复转录。",
                },
                {
                  title: "分段和广告识别更准确",
                  desc: "优化分段边界和广告识别逻辑，减少错分、漏分和时间点偏移，长视频结构更清晰。",
                },
              ],
            },
            {
              tag: "修复",
              items: [
                {
                  title: "修复字幕状态不同步",
                  desc: "修复转录完成后总结仍显示暂无字幕、刷新无反应，以及页面未及时刷新字幕的问题。",
                },
                {
                  title: "修复总结与验真异常",
                  desc: "修复无 API Key 时总结页空白、验真读取转录字幕报错、已有字幕却提示无字幕等问题。",
                },
              ],
            },
          ],
        },
        {
          tag: "v1.2.2",
          sections: [
            {
              tag: "新增",
              items: [
                {
                  title: "新手引导预览",
                  desc: "新增第三步预览效果，无需先配置 API Key，也能查看已有云端缓存的视频总结。",
                },
              ],
            },
            {
              tag: "优化",
              items: [
                {
                  title: "高速/省流模式",
                  desc: "默认使用高速模式，总结支持流式展示；省流模式保留 1 次调用生成总结和分段。",
                },
                {
                  title: "设置与缓存提示",
                  desc: "设置页改为自动保存提示，API Key 可显示明文并自动清理首尾空格，云端缓存会提示不消耗调用次数。",
                },
              ],
            },
          ],
        },
        {
          tag: "v1.2.1",
          sections: [
            {
              tag: "优化",
              items: [
                {
                  title: "转录与按钮反馈",
                  desc: "点击转录后会立即进入检查/转录状态，按钮同步禁用，减少卡顿感和重复点击。",
                },
              ],
            },
            {
              tag: "修复",
              items: [
                {
                  title: "修复聊天输入问题",
                  desc: "修复聊天框无法输入空格、中文输入法可能被打断，以及报错后页面强制滚到底部的问题。",
                },
                {
                  title: "修复转录状态异常",
                  desc: "修复在线转录按钮闪烁、进度回退、下载后短暂误显示无字幕等问题。",
                },
              ],
            },
          ],
        },
        {
          tag: "v1.2.0",
          sections: [
            {
              tag: "新增",
              items: [
                {
                  title: "SiliconFlow 转录支持",
                  desc: "支持无需翻墙的 FunAudioLLM/SenseVoiceSmall 大模型（无法生成时间戳，但不影响总结）。",
                },
              ],
            },
            {
              tag: "优化",
              items: [
                {
                  title: "视频/音频下载更稳定",
                  desc: "重做下载方式，减少 403、下载失败、下载成网页文件等问题。",
                },
              ],
            },
            {
              tag: "修复",
              items: [
                {
                  title: "音频转录修复",
                  desc: "修复无字幕视频音频转录可能会出现字幕串线的问题。",
                },
              ],
            },
          ],
        },
      ],
      privacy: "本插件不会上传任何 API Key、Prompt 或您和 AI 的聊天内容。",
    },
    "1.2.3": {
      title: "Bilitato 已更新至 v1.2.3",
      displayVersion: "v1.2.1 - v1.2.3",
      subtitle: "本次合并了近期多版更新，重点优化新手引导、转录、字幕缓存、总结、分段、聊天和验真体验。",
      groups: [
        {
          tag: "新增",
          items: [
            {
              title: "新手引导预览",
              desc: "新增第三步预览效果，无需先配置 API Key，也能查看已有云端缓存的视频总结。",
            },
          ],
        },
        {
          tag: "优化",
          items: [
            {
              title: "高速/省流模式",
              desc: "默认使用高速模式，总结支持流式展示；省流模式保留 1 次调用生成总结和分段。",
            },
            {
              title: "设置与缓存提示",
              desc: "设置页改为自动保存提示，API Key 可显示明文并自动清理首尾空格，云端缓存会提示不消耗调用次数。",
            },
            {
              title: "云端字幕缓存更稳定",
              desc: "CC、总结、聊天、验真都会主动读取云端字幕；云端已有字幕时会直接加载，减少重复转录。",
            },
            {
              title: "在线转录反馈更及时",
              desc: "点击转录后会立即进入检查/转录状态，按钮同步禁用，避免卡顿感和重复点击。",
            },
            {
              title: "分段和广告识别更准确",
              desc: "优化分段边界和广告识别逻辑，减少错分、漏分和时间点偏移，长视频结构更清晰。",
            },
          ],
        },
        {
          tag: "修复",
          items: [
            {
              title: "修复字幕状态不同步",
              desc: "修复转录完成后总结仍显示暂无字幕、刷新无反应，以及页面未及时刷新字幕的问题。",
            },
            {
              title: "修复聊天输入问题",
              desc: "修复聊天框无法输入空格、中文输入法可能被打断，以及报错后页面强制滚到底部的问题。",
            },
            {
              title: "修复总结与验真异常",
              desc: "修复无 API Key 时总结页空白、验真读取转录字幕报错、已有字幕却提示无字幕等问题。",
            },
          ],
        },
      ],
      privacy: "本插件不会上传任何 API Key、Prompt 或您和 AI 的聊天内容。",
    },
    "1.2.0": {
      title: "Bilitato 已更新至 v1.2.0",
      displayVersion: "v1.2.0",
      subtitle: "本次重点优化转录、下载与稳定性。",
      groups: [
        {
          tag: "新增",
          items: [
            {
              title: "SiliconFlow 转录支持",
              desc: "支持无需翻墙的 FunAudioLLM/SenseVoiceSmall 大模型（无法生成时间戳，但不影响总结）。",
            },
          ],
        },
        {
          tag: "优化",
          items: [
            {
              title: "视频/音频下载更稳定",
              desc: "重做下载方式，减少 403、下载失败、下载成网页文件等问题。",
            },
          ],
        },
        {
          tag: "修复",
          items: [
            {
              title: "音频转录修复",
              desc: "修复无字幕视频音频转录可能会出现字幕串线的问题。",
            },
          ],
        },
      ],
      privacy: "本插件不会上传任何 API Key、Prompt 或您和 AI 的聊天内容。",
    },
  };

  function getCurrentVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return "";
    }
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (result) => {
        resolve(result?.[key]);
      });
    });
  }

  function storageSet(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set(data, resolve);
    });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  async function shouldShowReleaseNotice(version = getCurrentVersion()) {
    if (!version || !RELEASE_NOTES[version]) return false;

    const lastSeenVersion = await storageGet(STORAGE_KEY);
    return lastSeenVersion !== version;
  }

  async function markReleaseNoticeSeen(version = getCurrentVersion()) {
    if (!version) return;

    await storageSet({
      [STORAGE_KEY]: version,
    });
  }

  function renderReleaseNotice({ root, version = getCurrentVersion(), onOpen, onClose }) {
    if (!root) return false;

    const note = RELEASE_NOTES[version];
    if (!note) return false;
    const pageVersions = buildReleasePageVersions(version);

    const box = root.querySelector(".ai-summary-plugin-box");
    if (!box) return false;

    if (box.querySelector(".release-notice-overlay")) return true;

    onOpen?.();

    const overlay = document.createElement("div");
    overlay.className = "release-notice-overlay";
    overlay.dataset.theme = box.dataset.theme || "light";

    overlay.innerHTML = `
      <div class="release-notice-card" role="dialog" aria-modal="true">
        <button class="release-notice-close" type="button" title="关闭">×</button>
        <div class="release-notice-content"></div>
        <div class="release-notice-pager"></div>
        <div class="release-notice-actions">
          <button class="release-notice-secondary" type="button">
            稍后再看
          </button>
          <button class="release-notice-primary" type="button">
            我知道了
          </button>
        </div>
      </div>
    `;

    let pageIndex = 0;
    const normalizeGroups = (pageNote) => {
      if (Array.isArray(pageNote?.groups)) return pageNote.groups;
      const buckets = [];
      (Array.isArray(pageNote?.highlights) ? pageNote.highlights : []).forEach((item) => {
        const tag = String(item?.tag || "优化");
        let group = buckets.find((entry) => entry.tag === tag);
        if (!group) {
          group = { tag, items: [] };
          buckets.push(group);
        }
        group.items.push({ title: item.title, desc: item.desc });
      });
      return buckets;
    };

    const renderPage = () => {
      const pageVersion = pageVersions[pageIndex] || version;
      const pageNote = RELEASE_NOTES[pageVersion] || note;
      const displayVersion = pageNote.displayVersion || `v${pageVersion}`;
      const groups = normalizeGroups(pageNote);
      const content = overlay.querySelector(".release-notice-content");
      const pager = overlay.querySelector(".release-notice-pager");
      if (content) {
        content.innerHTML = `
          <div class="release-notice-fixed-head">
            <div class="release-notice-top">
              <span class="release-notice-badge">更新说明</span>
              <span class="release-notice-version">${escapeHtml(displayVersion)}</span>
            </div>

            <div class="release-notice-title">${escapeHtml(pageNote.title)}</div>
            <div class="release-notice-subtitle">${escapeHtml(pageNote.subtitle)}</div>
          </div>

          <div class="release-notice-scroll-body">
            <div class="release-notice-group-list">
              ${groups
              .map(
                (group) => `
                  <section class="release-notice-group">
                    <div class="release-notice-group-tag">${escapeHtml(group.tag)}</div>
                    ${Array.isArray(group.sections) ? `
                      <div class="release-notice-section-list">
                        ${group.sections
                          .map(
                            (section) => `
                              <div class="release-notice-section">
                                <div class="release-notice-section-tag">${escapeHtml(section.tag)}</div>
                                <div class="release-notice-group-items">
                                  ${(Array.isArray(section.items) ? section.items : [])
                                    .map(
                                      (item) => `
                                        <div class="release-notice-item${item.highlight ? " release-notice-item-highlight" : ""}">
                                          <div class="release-notice-item-title">${escapeHtml(item.title)}</div>
                                          <div class="release-notice-item-desc">${escapeHtml(item.desc)}</div>
                                        </div>
                                      `
                                    )
                                    .join("")}
                                </div>
                              </div>
                            `
                          )
                          .join("")}
                      </div>
                    ` : `
                      <div class="release-notice-group-items">
                        ${(Array.isArray(group.items) ? group.items : [])
                        .map(
                          (item) => `
                            <div class="release-notice-item${item.highlight ? " release-notice-item-highlight" : ""}">
                              <div class="release-notice-item-title">${escapeHtml(item.title)}</div>
                              <div class="release-notice-item-desc">${escapeHtml(item.desc)}</div>
                            </div>
                          `
                        )
                        .join("")}
                      </div>
                    `}
                  </section>
                `
              )
              .join("")}
            </div>

            <div class="release-notice-privacy">
              ${escapeHtml(pageNote.privacy)}
            </div>
          </div>
        `;
      }
      if (pager) {
        pager.innerHTML = pageVersions.length > 1 ? `
          <button class="release-notice-page-btn" type="button" data-release-page="prev" ${pageIndex === 0 ? "disabled" : ""}>上一页</button>
          <span class="release-notice-page-count">${pageIndex + 1} / ${pageVersions.length}</span>
          <button class="release-notice-page-btn" type="button" data-release-page="next" ${pageIndex >= pageVersions.length - 1 ? "disabled" : ""}>下一页</button>
        ` : "";
      }
    };
    renderPage();

    let closed = false;
    const closeOverlay = () => {
      if (closed) return;
      closed = true;
      overlay.remove();
      onClose?.();
    };

    const closeAndMarkSeen = async () => {
      await markReleaseNoticeSeen(version);
      closeOverlay();
    };

    const closeOnly = () => {
      closeOverlay();
    };

    overlay
      .querySelector(".release-notice-close")
      ?.addEventListener("click", closeAndMarkSeen);

    overlay
      .querySelector(".release-notice-primary")
      ?.addEventListener("click", closeAndMarkSeen);

    overlay
      .querySelector(".release-notice-secondary")
      ?.addEventListener("click", closeOnly);

    overlay.addEventListener("click", (event) => {
      const pageButton = event.target.closest?.("[data-release-page]");
      if (!pageButton) return;
      const direction = pageButton.dataset.releasePage;
      if (direction === "prev") pageIndex = Math.max(0, pageIndex - 1);
      if (direction === "next") pageIndex = Math.min(pageVersions.length - 1, pageIndex + 1);
      renderPage();
    });

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeOnly();
    });

    box.appendChild(overlay);
    return true;
  }

  function buildReleasePageVersions(version) {
    const majorHistory = [];
    if (version === "1.6.3") {
      majorHistory.push("1.6.3", "1.6.2", "1.6.1", "1.6.0", "1.5.x", "1.4.x", "1.3.x", "1.2.x");
    } else if (version === "1.6.2") {
      majorHistory.push("1.6.2", "1.6.1", "1.6.0", "1.5.x", "1.4.x", "1.3.x", "1.2.x");
    } else if (version === "1.6.1") {
      majorHistory.push("1.6.1", "1.6.0", "1.5.x", "1.4.x", "1.3.x", "1.2.x");
    } else if (version === "1.6.0") {
      majorHistory.push("1.6.0", "1.5.x", "1.4.x", "1.3.x", "1.2.x");
    } else if (version === "1.5.1" || version === "1.5.0" || version === "1.5.x") {
      majorHistory.push("1.5.x", "1.4.x", "1.3.x", "1.2.x");
    } else if (version === "1.4.3") {
      majorHistory.push("1.4.x", "1.3.x", "1.2.x");
    } else if (version === "1.4.2") {
      majorHistory.push("1.4.x", "1.3.x", "1.2.x");
    } else if (version === "1.4.1") {
      majorHistory.push("1.4.x", "1.3.x", "1.2.x");
    } else if (version === "1.4.0") {
      majorHistory.push("1.4.x", "1.3.x", "1.2.x");
    } else if (version === "1.3.1" || version === "1.3.0" || version === "1.3.x") {
      majorHistory.push("1.3.x", "1.2.x");
    } else {
      majorHistory.push(version, "1.2.x");
    }
    return majorHistory.filter((item, index, arr) => item && RELEASE_NOTES[item] && arr.indexOf(item) === index);
  }

  async function maybeShowReleaseNotice({ root, version = getCurrentVersion(), onOpen, onClose }) {
    const shouldShow = await shouldShowReleaseNotice(version);
    if (!shouldShow) return false;

    return renderReleaseNotice({ root, version, onOpen, onClose });
  }

  globalThis.BilitatoReleaseNotice = {
    RELEASE_NOTES,
    shouldShowReleaseNotice,
    markReleaseNoticeSeen,
    renderReleaseNotice,
    maybeShowReleaseNotice,
  };
})();
