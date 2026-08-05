const DEFAULT_FEATURE_FLAGS = Object.freeze({
  summary_empty_retry: true,
  segments_local_json_repair: true,
  segments_ai_json_repair: true,
  segments_primary_retry: true,
  segments_compact_retry: true,
  segments_expanded_tokens_retry: true,
  modelscope_model_fallback: true,
});

const DEFAULT_MODELSCOPE_FALLBACK = Object.freeze({
  enabled: true,
  maxAttempts: 1,
  tasks: Object.freeze({
    default: Object.freeze(["Qwen/Qwen3-30B-A3B-Instruct-2507", "Qwen/Qwen3-30B-A3B"]),
    summary: Object.freeze(["Qwen/Qwen3-30B-A3B-Instruct-2507", "Qwen/Qwen3-30B-A3B"]),
    segments: Object.freeze(["Qwen/Qwen3-Coder-30B-A3B-Instruct", "Qwen/Qwen3-30B-A3B-Instruct-2507", "Qwen/Qwen3-30B-A3B"]),
    rumors: Object.freeze(["Qwen/Qwen3-30B-A3B-Instruct-2507", "Qwen/Qwen3-30B-A3B"]),
    chat: Object.freeze(["Qwen/Qwen3-30B-A3B-Instruct-2507", "Qwen/Qwen3-30B-A3B"]),
  }),
});

export const DEFAULT_REMOTE_CONFIG = Object.freeze({
  configKey: "production",
  revision: 0,
  updatedAt: "",
  featureFlags: DEFAULT_FEATURE_FLAGS,
  providers: {},
  asr: {},
  modelFallback: DEFAULT_MODELSCOPE_FALLBACK,
});

export const REMOTE_CONFIG_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function isRemoteConfigCacheFresh(
  fetchedAt,
  now = Date.now(),
  maxAgeMs = REMOTE_CONFIG_CACHE_MAX_AGE_MS,
) {
  const fetched = Number(fetchedAt || 0);
  const current = Number(now || 0);
  const maxAge = Number(maxAgeMs || 0);
  return fetched > 0
    && current >= fetched
    && maxAge > 0
    && current - fetched < maxAge;
}

function cleanText(value, maxLength = 160) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanHttpsUrl(value) {
  const input = cleanText(value, 500);
  if (!input) return "";
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || url.username || url.password) return "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function cleanModels(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, 200)).filter(Boolean))].slice(0, 120);
}

function normalizeProvider(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const protocol = cleanText(value.protocol || value.type, 20).toLowerCase();
  const headerKey = cleanText(value.header_key || value.headerKey, 40);
  return {
    enabled: value.enabled !== false,
    name: cleanText(value.name, 80),
    baseUrl: cleanHttpsUrl(value.base_url || value.baseUrl),
    model: cleanText(value.default_model || value.model, 200),
    models: cleanModels(value.models),
    regUrl: cleanHttpsUrl(value.reg_url || value.regUrl),
    type: ["openai", "claude", "google"].includes(protocol) ? protocol : "",
    headerKey: ["Authorization", "api-key"].includes(headerKey) ? headerKey : "",
    tokenPrefix: cleanText(value.token_prefix || value.tokenPrefix, 20),
  };
}

function normalizeProviderMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, provider]) => {
    const normalizedKey = cleanText(key, 50).toLowerCase().replace(/[^a-z0-9_-]/g, "");
    return [normalizedKey, normalizeProvider(provider)];
  }).filter(([key, provider]) => key && provider));
}

function normalizeFeatureFlags(value) {
  const incoming = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.entries(DEFAULT_FEATURE_FLAGS).map(([key, fallback]) => [
    key,
    Object.prototype.hasOwnProperty.call(incoming, key) ? incoming[key] !== false : fallback,
  ]));
}

function normalizeModelFallback(value = {}) {
  const incoming = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const incomingTasks = incoming.tasks && typeof incoming.tasks === "object" && !Array.isArray(incoming.tasks)
    ? incoming.tasks
    : {};
  const tasks = Object.fromEntries(Object.entries(DEFAULT_MODELSCOPE_FALLBACK.tasks).map(([task, fallback]) => {
    const models = cleanModels(incomingTasks[task]);
    return [task, models.length ? models : [...fallback]];
  }));
  return {
    enabled: incoming.enabled !== false,
    maxAttempts: 1,
    tasks,
  };
}

export function normalizeRemoteConfigRow(row = {}) {
  const payload = row?.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload
    : {};
  return {
    configKey: cleanText(row.config_key || row.configKey || "production", 80) || "production",
    revision: Math.max(0, Math.floor(Number(row.revision || 0)) || 0),
    updatedAt: cleanText(row.updated_at || row.updatedAt, 80),
    featureFlags: normalizeFeatureFlags(payload.feature_flags || payload.featureFlags),
    providers: normalizeProviderMap(payload.providers),
    asr: normalizeProviderMap(payload.asr),
    modelFallback: normalizeModelFallback(payload.model_fallback || payload.modelFallback),
  };
}

export function buildEffectiveProviderCatalog(staticProviders = {}, remoteConfig = {}, currentProvider = "") {
  const remoteProviders = remoteConfig?.providers && typeof remoteConfig.providers === "object"
    ? remoteConfig.providers
    : {};
  const keys = new Set([...Object.keys(staticProviders || {}), ...Object.keys(remoteProviders)]);
  const currentKey = cleanText(currentProvider, 50).toLowerCase();
  const result = {};
  keys.forEach((key) => {
    const baked = staticProviders?.[key] && typeof staticProviders[key] === "object" ? staticProviders[key] : {};
    const remote = remoteProviders?.[key] && typeof remoteProviders[key] === "object" ? remoteProviders[key] : null;
    if (remote?.enabled === false && key !== currentKey) return;
    const merged = {
      ...baked,
      ...(remote?.name ? { name: remote.name } : {}),
      ...(remote?.baseUrl ? { baseUrl: remote.baseUrl } : {}),
      ...(remote?.model ? { model: remote.model } : {}),
      ...(remote?.models?.length ? { models: [...remote.models] } : {}),
      ...(remote?.regUrl ? { regUrl: remote.regUrl } : {}),
      ...(remote?.type ? { type: remote.type === "openai" ? undefined : remote.type } : {}),
      ...(remote?.headerKey ? { headerKey: remote.headerKey } : {}),
      ...(remote?.tokenPrefix ? { tokenPrefix: remote.tokenPrefix } : {}),
      ...(remote?.enabled === false ? { disabled: true } : {}),
    };
    if (!merged.name) merged.name = key;
    if (merged.baseUrl || key === "custom" || baked.baseUrl !== undefined) result[key] = merged;
  });
  if (!result.custom && staticProviders?.custom) result.custom = { ...staticProviders.custom };
  return result;
}

export function isRemoteFeatureEnabled(remoteConfig, key, fallback = true) {
  const flags = remoteConfig?.featureFlags;
  if (!flags || !Object.prototype.hasOwnProperty.call(flags, key)) return fallback;
  return flags[key] !== false;
}
