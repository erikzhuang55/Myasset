import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/httpClient.js", () => ({
    requestNoContent: vi.fn(async () => undefined),
    requestJson: vi.fn()
}));

import { requestNoContent } from "../utils/httpClient.js";
import { normalizeUsageEventPayload, reportUsageEvent } from "../utils/usageEvents.js";

describe("usageEvents", () => {
    it("normalizes payload for Supabase insert", () => {
        const row = normalizeUsageEventPayload({
            userHash: " user_123 ",
            sessionId: " session_123 ",
            extensionVersion: "1.4.0",
            eventName: "Task Started!",
            featureName: "summary",
            status: "success",
            durationMs: "123.4",
            tokenCount: 88,
            metadata: {
                source: "panel",
                nested: { a: 1 }
            }
        });

        expect(row).toMatchObject({
            user_hash: "user_123",
            session_id: "session_123",
            extension_version: "1.4.0",
            event_name: "task_started",
            feature_name: "summary",
            status: "success",
            duration_ms: 123,
            token_count: 88,
            metadata: {
                source: "panel",
                nested: "{\"a\":1}"
            }
        });
    });

    it("rejects payloads without required identifiers", () => {
        expect(normalizeUsageEventPayload({ sessionId: "s", eventName: "started" })).toBeNull();
        expect(normalizeUsageEventPayload({ userHash: "u", eventName: "started" })).toBeNull();
        expect(normalizeUsageEventPayload({ userHash: "u", sessionId: "s" })).toBeNull();
    });

    it("writes to usage_events by default", async () => {
        await reportUsageEvent({
            supabaseUrl: "https://example.supabase.co",
            supabaseAnonKey: "anon"
        }, {
            userHash: "u",
            sessionId: "s",
            eventName: "task_success",
            featureName: "chat"
        });

        expect(requestNoContent).toHaveBeenCalledWith(
            "https://example.supabase.co/rest/v1/usage_events",
            expect.objectContaining({
                method: "POST",
                requestName: "usage_event_report",
                timeoutMs: 2000
            })
        );
    });
});
