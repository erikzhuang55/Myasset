import { requestJson, requestNoContent } from "./httpClient.js";

export const DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS = 2000;

export function isSupabaseEnabled(settings) {
  return !!String(settings?.supabaseUrl || "").trim() && !!String(settings?.supabaseAnonKey || "").trim();
}

export function buildSupabaseHeaders(settings, extra = {}) {
  const apiKey = String(settings?.supabaseAnonKey || "").trim();
  return {
    apikey: apiKey,
    Authorization: `Bearer ${apiKey}`,
    ...extra
  };
}

function getSupabaseBaseUrl(settings) {
  return String(settings?.supabaseUrl || "").trim().replace(/\/+$/, "");
}

function buildRestUrl(settings, path) {
  return `${getSupabaseBaseUrl(settings)}/rest/v1/${path}`;
}

function resolveRequestTimeoutMs(options = {}) {
  const value = Number(options.timeoutMs);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS;
}

function appendSearchParams(url, params = {}) {
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    url.searchParams.set(key, String(value));
  });
  return url;
}

export async function supabaseSelect(settings, tableName, params = {}, options = {}) {
  const table = encodeURIComponent(String(tableName || "").trim());
  const url = appendSearchParams(new URL(buildRestUrl(settings, table)), params);
  const result = await requestJson(url.toString(), {
    method: "GET",
    headers: buildSupabaseHeaders(settings, { Accept: "application/json", ...(options.headers || {}) }),
    requestName: options.requestName || `supabase_select:${tableName}`,
    errorMessage: options.errorMessage,
    timeoutMs: resolveRequestTimeoutMs(options)
  });
  return Array.isArray(result.data) ? result.data : [];
}

export async function supabaseWrite(settings, tableName, body, options = {}) {
  const table = encodeURIComponent(String(tableName || "").trim());
  const url = appendSearchParams(new URL(buildRestUrl(settings, table)), options.params || {});
  await requestNoContent(url.toString(), {
    method: options.method || "POST",
    headers: buildSupabaseHeaders(settings, {
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=minimal",
      ...(options.headers || {})
    }),
    body: JSON.stringify(body || {}),
    requestName: options.requestName || `supabase_write:${tableName}`,
    errorMessage: options.errorMessage,
    timeoutMs: resolveRequestTimeoutMs(options)
  });
  return true;
}

export async function supabaseRpc(settings, rpcName, payload = {}, options = {}) {
  const rpc = encodeURIComponent(String(rpcName || "").trim());
  await requestNoContent(buildRestUrl(settings, `rpc/${rpc}`), {
    method: "POST",
    headers: buildSupabaseHeaders(settings, {
      "Content-Type": "application/json",
      Accept: "application/json"
    }),
    body: JSON.stringify(payload || {}),
    requestName: options.requestName || `supabase_rpc:${rpcName}`,
    errorMessage: options.errorMessage,
    timeoutMs: resolveRequestTimeoutMs(options)
  });
  return true;
}
