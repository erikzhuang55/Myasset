import { RealtimeClient } from "@supabase/realtime-js";

export function createRemoteConfigRealtimeSubscription({
  supabaseUrl,
  anonKey,
  table = "extension_remote_config",
  configKey = "production",
  onChange,
  onStatus,
} = {}) {
  const baseUrl = String(supabaseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(anonKey || "").trim();
  if (!baseUrl || !apiKey) return null;

  const client = new RealtimeClient(`${baseUrl}/realtime/v1`, {
    params: { apikey: apiKey },
    heartbeatIntervalMs: 25_000,
  });
  const channel = client
    .channel(`remote-config:${configKey}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table,
      filter: `config_key=eq.${configKey}`,
    }, (payload) => {
      if (payload?.new && typeof onChange === "function") onChange(payload.new);
    });

  channel.subscribe((status, error) => {
    if (typeof onStatus === "function") onStatus(status, error || null);
  });

  return {
    stop: async () => {
      await client.removeChannel(channel).catch(() => {});
      await client.disconnect().catch(() => {});
    },
  };
}
