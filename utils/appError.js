export function normalizeHttpErrorCode(status) {
  const value = Number(status || 0);
  if (value >= 500) return "HTTP_5XX";
  if ([400, 401, 403, 404, 408, 429].includes(value)) return `HTTP_${value}`;
  if (value > 0) return `HTTP_${value}`;
  return "UNKNOWN";
}

export function createAppError(code, message, extra = {}) {
  const error = new Error(message || code || "UNKNOWN");
  error.code = String(code || "UNKNOWN");
  Object.assign(error, extra || {});
  return error;
}

export function createHttpError(status, message, extra = {}) {
  const code = normalizeHttpErrorCode(status);
  return createAppError(code, message || `HTTP ${status}`, {
    status: Number(status || 0),
    ...extra
  });
}

export function serializeAppError(error) {
  return {
    name: String(error?.name || "Error"),
    message: String(error?.message || "未知错误"),
    code: String(error?.code || inferErrorCode(error) || ""),
    status: Number(error?.status || 0) || undefined,
    retryAfterSec: Number(error?.retryAfterSec || 0) || undefined,
    stack: String(error?.stack || "")
  };
}

export function inferErrorCode(error) {
  const code = String(error?.code || "").trim();
  const message = String(error?.message || error || "");
  const genericCodes = new Set([
    "HTTP_400",
    "HTTP_401",
    "HTTP_403",
    "HTTP_402",
    "HTTP_429",
    "HTTP_5XX",
    "TIMEOUT",
    "NETWORK_ERROR",
    "JSON_PARSE_ERROR",
    "UNKNOWN"
  ]);
  if (code && !genericCodes.has(code)) return code;
  if (/(?:invalid|incorrect|wrong|bad|expired|missing)\s+(?:api\s*)?key|api\s*key\s+(?:is\s+)?(?:invalid|incorrect|wrong|expired|missing)|invalid_api_key|unauthorized api key|authentication.*(?:failed|invalid)|鉴权失败|认证失败|密钥.*(?:无效|错误|过期)|API\s*Key.*(?:无效|错误|过期|不正确)|令牌.*(?:无效|错误|过期)/i.test(message)) return "HTTP_401";
  if (/User location is not supported for the API use|location is not supported|unsupported.*location|地区.*不支持|所在地.*不支持/i.test(message)) return "API_LOCATION_UNSUPPORTED";
  if (/real-name verified|实名认证|实名.*验证|Please make sure your associated Aliyun account is real-name verified/i.test(message)) return "ALIYUN_REALNAME_REQUIRED";
  if (/Invalid model id|模型 ID.*(?:无效|不存在|不支持)|模型名称.*(?:无效|不存在|不支持)/i.test(message)) return "INVALID_MODEL_ID";
  if (/Model is private|private model|没有权限使用这个模型|无权访问该模型|model.*forbidden|model.*denied/i.test(message)) return "MODEL_ACCESS_DENIED";
  if (/Groq.*(?:Forbidden|拒绝了当前网络请求)|ASR_GROQ_ACCESS_BLOCKED/i.test(message)) return "ASR_GROQ_ACCESS_BLOCKED";
  if (/(?:Groq|硅基流动|transcription|转录).*(?:403|forbidden|Illegal operation)|(?:403|forbidden|Illegal operation).*(?:Groq|硅基流动|transcription|转录)/i.test(message)) return "ASR_FORBIDDEN";
  if (/Insufficient Balance|余额不足|额度不足|balance.*insufficient/i.test(message)) return "HTTP_402_INSUFFICIENT_BALANCE";
  if (/402/i.test(message) && /free route|免费路由|route unavailable|模型配置不可用|当前模型配置不可用|provider.*unavailable/i.test(message)) return "HTTP_402_MODEL_UNAVAILABLE";
  if (/insufficient_quota|request_quota_exceeded|额度已用尽|配额已用尽|quota exceeded/i.test(message)) return "HTTP_429_INSUFFICIENT_QUOTA";
  if (/queue_exceeded|队列已满|队列拥堵|service unavailable due to queue/i.test(message)) return "HTTP_429_QUEUE_EXCEEDED";
  if (/Too many requests|rate limit|请求太频繁|限流|too many tokens/i.test(message) && !/groq|转录/i.test(message)) return "HTTP_429_RATE_LIMIT";
  const httpMatch = message.match(/\bHTTP\s+([0-9]{3})\b|API Error\s+([0-9]{3})/i);
  if (httpMatch) return normalizeHttpErrorCode(Number(httpMatch[1] || httpMatch[2]));
  if (/模型长时间没有开始返回内容|stream timeout|first token timeout/i.test(message)) return "AI_STREAM_TIMEOUT";
  if (/模型请求超时|ai request timeout|provider timeout/i.test(message)) return "AI_RESPONSE_TIMEOUT";
  if (/转录请求超时|asr timeout|transcription timeout/i.test(message)) return "ASR_REQUEST_TIMEOUT";
  if (/无法连接\s*Groq\s*服务器|Groq.*(?:unreachable|connectivity)|ASR_GROQ_UNREACHABLE/i.test(message)) return "ASR_GROQ_UNREACHABLE";
  if (/网络请求超时|request timeout/i.test(message)) return "NETWORK_REQUEST_TIMEOUT";
  if (/timeout|超时/i.test(message)) return "TIMEOUT";
  if (/feedback.*(?:failed to fetch|network|timeout|unavailable)|反馈服务暂时不可用|feedback_(?:select|mark_seen)_unavailable/i.test(message)) return "FEEDBACK_SERVICE_UNAVAILABLE";
  if (/模型服务连接失败|provider network error/i.test(message)) return "PROVIDER_NETWORK_ERROR";
  if (/PROVIDER_INVALID_RESPONSE|模型服务返回了网页内容|内容不是有效 JSON|Provider 地址返回的不是 API 数据/i.test(message)) return "PROVIDER_INVALID_RESPONSE";
  if (/(?:provider|模型服务|上游|inference|chat_stream|summary|segments).*(?:failed to fetch|network error|网络请求失败)|(?:failed to fetch|network error).*(?:provider|模型服务|上游|inference|chat_stream|summary|segments)/i.test(message)) return "PROVIDER_NETWORK_ERROR";
  if (/network|failed to fetch|网络/i.test(message)) return "NETWORK_ERROR";
  if (/模型没有返回总结内容|总结生成为空|summary_empty|SUMMARY_EMPTY/i.test(message)) return "SUMMARY_EMPTY_RESPONSE";
  if (/字幕内容过长|context length|maximum context|max context|too many tokens|prompt too long|input too long|context_length_exceeded/i.test(message)) return "SEGMENTS_CONTEXT_TOO_LONG";
  if (/模型没有返回分段内容|返回为空|response_chars.?0|has_text.?false/i.test(message)) return "SEGMENTS_EMPTY_RESPONSE";
  if (/分段输出被截断|输出被截断|truncated|max_tokens|finish_reason.?length/i.test(message)) return "SEGMENTS_OUTPUT_TRUNCATED";
  if (/模型漏掉了分段部分|分段输出缺失|分段.*缺失|missing.*segments/i.test(message)) return "SEGMENTS_MISSING_PROTOCOL";
  if (/分段字段不完整|invalid schema|schema/i.test(message)) return "SEGMENTS_INVALID_SCHEMA";
  if (/模型没有生成有效分段|空分段|empty list/i.test(message)) return "SEGMENTS_EMPTY_LIST";
  if (/分段.*(?:格式|JSON|解析)|segments.*(?:json|parse)|模型返回分段格式/i.test(message)) return "SEGMENTS_JSON_PARSE_FAILED";
  if (/验真 JSON 解析失败|rumors.*(?:json|parse)|验真.*(?:格式|JSON|解析)/i.test(message)) return "RUMORS_JSON_PARSE_FAILED";
  if (/JSON\s*解析失败|json_parse|JSON Parse/i.test(message)) return "JSON_PARSE_ERROR";
  if (/文件大小超出限制|音频过大|too large/i.test(message)) return "ASR_FILE_TOO_LARGE";
  return code || "";
}
