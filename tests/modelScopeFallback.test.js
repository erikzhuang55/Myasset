import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  classifyModelScopeFallbackError,
  getShanghaiDateKey,
  markModelScopeModelUnavailable,
  normalizeModelScopeQuotaLedger,
  selectModelScopeFallbackModel,
  updateModelScopeQuotaLedger,
  shouldUseImmediateModelScopeFallback,
  isStrictModelScopeProvider,
} from "../utils/modelScopeFallback.js";

const backgroundSource = readFileSync(new URL("../background.js", import.meta.url), "utf8");

const NOW = Date.UTC(2026, 7, 6, 8, 0, 0);
const MODELS = ["model-a", "model-b", "model-c"];
const CONFIG = {
  tasks: {
    summary: ["model-a", "model-b", "model-c"],
    default: ["model-a", "model-b", "model-c"],
  },
};

describe("ModelScope model fallback", () => {
  it("continues through deterministic quota failures without retrying an attempted model", () => {
    expect(backgroundSource).toContain("while (fallbackModelsTried.length < maxAttempts)");
    expect(backgroundSource).toContain("excludedModels: [...attemptedModels]");
    expect(backgroundSource).toContain('["quota_exhausted", "model_quota_exhausted", "model_unavailable"]');
    expect(backgroundSource).toContain("if (canTryNextModel && attempt < maxAttempts) continue");
  });

  it("only enables model switching for the explicit ModelScope provider", () => {
    expect(isStrictModelScopeProvider({ provider: "modelscope" })).toBe(true);
    expect(isStrictModelScopeProvider({ provider: " ModelScope " })).toBe(true);
    expect(isStrictModelScopeProvider({ provider: "gemini", model: "Qwen/Qwen3-30B-A3B" })).toBe(false);
    expect(isStrictModelScopeProvider({ providerModels: { modelscope: "Qwen/Qwen3-30B-A3B" } })).toBe(false);
  });

  it("resets the quota ledger on the next Shanghai calendar day", () => {
    const previous = {
      date: "2026-08-05",
      models: { "model-b": { remaining: 0 } },
      user: { remaining: 0 },
    };
    expect(getShanghaiDateKey(NOW)).toBe("2026-08-06");
    expect(normalizeModelScopeQuotaLedger(previous, NOW)).toEqual({
      date: "2026-08-06",
      models: {},
      user: { limit: null, remaining: null, updatedAt: 0 },
    });
  });

  it("records model and user remaining quota from response headers", () => {
    const ledger = updateModelScopeQuotaLedger({}, "model-a", {
      modelLimit: 200,
      modelRemaining: 17,
      userLimit: 2000,
      userRemaining: 109,
    }, NOW);
    expect(ledger.models["model-a"]).toMatchObject({
      limit: 200,
      remaining: 17,
      source: "response_header",
    });
    expect(ledger.user).toMatchObject({ limit: 2000, remaining: 109 });
  });

  it("skips a model already exhausted today", () => {
    let ledger = normalizeModelScopeQuotaLedger({}, NOW);
    ledger = markModelScopeModelUnavailable(ledger, "model-b", "quota_exhausted", NOW);
    expect(selectModelScopeFallbackModel({
      currentModel: "model-a",
      task: "summary",
      availableModels: MODELS,
      fallbackConfig: CONFIG,
      ledger,
      now: NOW,
    })).toBe("model-c");
  });

  it("skips models already attempted in the current fallback chain", () => {
    expect(selectModelScopeFallbackModel({
      currentModel: "model-a",
      task: "summary",
      availableModels: MODELS,
      fallbackConfig: CONFIG,
      ledger: normalizeModelScopeQuotaLedger({}, NOW),
      excludedModels: ["model-b"],
      now: NOW,
    })).toBe("model-c");
  });

  it("allows one attempt for a model whose remaining quota is unknown", () => {
    expect(selectModelScopeFallbackModel({
      currentModel: "model-a",
      task: "summary",
      availableModels: MODELS,
      fallbackConfig: CONFIG,
      ledger: normalizeModelScopeQuotaLedger({}, NOW),
      now: NOW,
    })).toBe("model-b");
  });

  it("still probes another model when aggregate quota information is not actionable", () => {
    const ledger = normalizeModelScopeQuotaLedger({
      date: "2026-08-06",
      models: {},
      user: { limit: 2000, remaining: 0, updatedAt: NOW },
    }, NOW);
    expect(selectModelScopeFallbackModel({
      currentModel: "model-a",
      task: "summary",
      availableModels: MODELS,
      fallbackConfig: CONFIG,
      ledger,
      now: NOW,
    })).toBe("model-b");
  });

  it("only retries failures that a different model can plausibly recover", () => {
    let ledger = normalizeModelScopeQuotaLedger({}, Date.now());
    expect(classifyModelScopeFallbackError({ code: "HTTP_5XX", status: 503 }, ledger)).toMatchObject({ reason: "provider_5xx" });
    expect(classifyModelScopeFallbackError({ code: "HTTP_503" }, ledger)).toMatchObject({ reason: "provider_5xx" });
    expect(classifyModelScopeFallbackError({ code: "AI_STREAM_TIMEOUT" }, ledger)).toMatchObject({ reason: "timeout" });
    expect(classifyModelScopeFallbackError({ code: "HTTP_400", status: 400, message: "model is not available" }, ledger)).toMatchObject({ reason: "model_unavailable" });
    expect(classifyModelScopeFallbackError({ code: "HTTP_401", status: 401 }, ledger)).toBeNull();
    expect(classifyModelScopeFallbackError({ code: "PROVIDER_NETWORK_ERROR" }, ledger)).toBeNull();
    expect(classifyModelScopeFallbackError({ code: "SUMMARY_EMPTY_RESPONSE" }, ledger)).toMatchObject({ reason: "summary_empty" });
    expect(classifyModelScopeFallbackError({ code: "SEGMENTS_JSON_PARSE_FAILED" }, ledger)).toMatchObject({ reason: "structured_output_invalid" });
    expect(classifyModelScopeFallbackError({ code: "SEGMENTS_INVALID_SCHEMA" }, ledger)).toMatchObject({ reason: "structured_output_invalid" });
    ledger = updateModelScopeQuotaLedger(ledger, "model-a", {
      modelRemaining: 0,
      userRemaining: 50,
    });
    expect(classifyModelScopeFallbackError(
      { code: "HTTP_429", status: 429 },
      ledger,
      { currentModel: "model-a" },
    )).toMatchObject({ reason: "model_quota_exhausted" });
    ledger = updateModelScopeQuotaLedger(ledger, "model-a", { userRemaining: 0 });
    expect(classifyModelScopeFallbackError(
      { code: "HTTP_429", status: 429 },
      ledger,
      { currentModel: "model-a" },
    )).toMatchObject({ reason: "model_quota_exhausted" });
  });

  it("switches after one short wait for queue, rate-limit, and unknown 429 failures", () => {
    expect(classifyModelScopeFallbackError({ code: "HTTP_429_QUEUE_EXCEEDED", status: 429 })).toMatchObject({ reason: "queue_overloaded" });
    expect(classifyModelScopeFallbackError({ code: "HTTP_429_RATE_LIMIT", status: 429 })).toMatchObject({ reason: "rate_limited" });
    expect(classifyModelScopeFallbackError({ code: "HTTP_429", status: 429 })).toMatchObject({ reason: "unknown_429" });
    expect(shouldUseImmediateModelScopeFallback({ code: "HTTP_429", status: 429 })).toBe(false);
  });

  it("immediately falls back for quota exhaustion and unavailable models", () => {
    const quotaError = {
      code: "HTTP_429",
      status: 429,
      message: 'API Error 429: {"error":{"code":"insufficient_quota","message":"check billing details"}}',
    };
    const unavailableError = {
      code: "HTTP_400",
      status: 400,
      message: "Model id: deepseek-ai/DeepSeek-V3.2 has no provider supported",
    };
    const balanceError = {
      code: "HTTP_429",
      status: 429,
      message: 'API Error 429: {"error":{"message":"insufficient balance"}}',
    };
    const modelQuotaError = {
      code: "HTTP_429",
      status: 429,
      message: "We have to rate limit you for model deepseek-ai/DeepSeek-V4-Pro",
    };

    expect(classifyModelScopeFallbackError(quotaError)).toMatchObject({
      reason: "quota_exhausted",
      immediate: true,
    });
    expect(classifyModelScopeFallbackError(unavailableError)).toMatchObject({
      reason: "model_unavailable",
    });
    expect(shouldUseImmediateModelScopeFallback(quotaError)).toBe(true);
    expect(shouldUseImmediateModelScopeFallback(balanceError)).toBe(true);
    expect(classifyModelScopeFallbackError(modelQuotaError)).toMatchObject({
      reason: "model_quota_exhausted",
      immediate: true,
    });
    expect(shouldUseImmediateModelScopeFallback(modelQuotaError)).toBe(true);
    expect(shouldUseImmediateModelScopeFallback(unavailableError)).toBe(true);
  });
});
