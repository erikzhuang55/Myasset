import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS,
  buildSupabaseHeaders,
  isSupabaseEnabled,
  supabaseRpc,
  supabaseSelect,
  supabaseWrite
} from "../utils/supabaseClient.js";

const originalFetch = globalThis.fetch;

const settings = {
  supabaseUrl: "https://project.supabase.co/",
  supabaseAnonKey: "anon-key"
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("supabaseClient", () => {
  it("uses a five second default request timeout", () => {
    expect(DEFAULT_SUPABASE_REQUEST_TIMEOUT_MS).toBe(5000);
  });

  it("detects whether supabase is configured", () => {
    expect(isSupabaseEnabled(settings)).toBe(true);
    expect(isSupabaseEnabled({ supabaseUrl: "", supabaseAnonKey: "anon-key" })).toBe(false);
  });

  it("builds auth headers", () => {
    expect(buildSupabaseHeaders(settings, { Accept: "application/json" })).toEqual({
      apikey: "anon-key",
      Authorization: "Bearer anon-key",
      Accept: "application/json"
    });
  });

  it("selects rows with query params", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([{ bvid: "BV1" }]), { status: 200 }));

    const rows = await supabaseSelect(settings, "video_cache", {
      select: "bvid,updated_at",
      bvid: "eq.BV1",
      limit: 1
    });

    expect(rows).toEqual([{ bvid: "BV1" }]);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toContain("https://project.supabase.co/rest/v1/video_cache?");
    expect(url).toContain("select=bvid%2Cupdated_at");
    expect(init.headers.Authorization).toBe("Bearer anon-key");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("writes rows with return=minimal", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 }));

    await supabaseWrite(settings, "video_cache", { bvid: "BV1" }, {
      method: "PATCH",
      params: { bvid: "eq.BV1" }
    });

    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toContain("bvid=eq.BV1");
    expect(init.method).toBe("PATCH");
    expect(init.headers.Prefer).toBe("return=minimal");
    expect(JSON.parse(init.body)).toEqual({ bvid: "BV1" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes request scoped headers", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));

    await supabaseSelect(settings, "feedback", { select: "id" }, {
      headers: { "x-feedback-client-id": "client-1234567890" }
    });

    const [, init] = globalThis.fetch.mock.calls[0];
    expect(init.headers["x-feedback-client-id"]).toBe("client-1234567890");
  });

  it("calls rpc endpoints", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 204 }));

    await supabaseRpc(settings, "increment_feature_usage_daily", { f_name: "summary" });

    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toBe("https://project.supabase.co/rest/v1/rpc/increment_feature_usage_daily");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ f_name: "summary" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
