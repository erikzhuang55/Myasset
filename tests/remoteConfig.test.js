import { describe, expect, it } from "vitest";
import {
  buildEffectiveProviderCatalog,
  isRemoteFeatureEnabled,
  normalizeRemoteConfigRow,
} from "../utils/remoteConfig.js";

describe("remote configuration", () => {
  it("normalizes public feature and model configuration", () => {
    const config = normalizeRemoteConfigRow({
      config_key: "production",
      revision: 7,
      updated_at: "2026-08-02T00:00:00Z",
      payload: {
        feature_flags: { summary_empty_retry: false },
        providers: {
          openai: {
            base_url: "https://proxy.example.com/v1/",
            default_model: "gpt-test",
            models: ["gpt-test", "gpt-test", "gpt-small"],
          },
          unsafe: { base_url: "http://example.com/v1", models: ["bad"] },
        },
      },
    });

    expect(config.revision).toBe(7);
    expect(config.featureFlags.summary_empty_retry).toBe(false);
    expect(config.featureFlags.segments_compact_retry).toBe(true);
    expect(config.featureFlags.segments_ai_json_repair).toBe(true);
    expect(config.providers.openai).toMatchObject({
      baseUrl: "https://proxy.example.com/v1",
      model: "gpt-test",
      models: ["gpt-test", "gpt-small"],
    });
    expect(config.providers.unsafe.baseUrl).toBe("");
  });

  it("updates the catalog without discarding an existing disabled selection", () => {
    const staticProviders = {
      openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1/", model: "old" },
      deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com/", model: "old" },
      custom: { name: "自定义", baseUrl: "" },
    };
    const remoteConfig = normalizeRemoteConfigRow({
      revision: 2,
      payload: {
        providers: {
          openai: { enabled: false, models: ["new"] },
          deepseek: { enabled: true, default_model: "new", models: ["new"] },
        },
      },
    });

    expect(buildEffectiveProviderCatalog(staticProviders, remoteConfig)).not.toHaveProperty("openai");
    expect(buildEffectiveProviderCatalog(staticProviders, remoteConfig, "openai").openai.disabled).toBe(true);
    expect(buildEffectiveProviderCatalog(staticProviders, remoteConfig).deepseek.models).toEqual(["new"]);
  });

  it("falls back safely when a feature flag is absent", () => {
    expect(isRemoteFeatureEnabled({}, "unknown", false)).toBe(false);
    expect(isRemoteFeatureEnabled({ featureFlags: { enabled: true } }, "enabled", false)).toBe(true);
  });
});
