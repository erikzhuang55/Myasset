import { RealtimeClient } from "@supabase/realtime-js";

const supabaseUrl = process.env.BILITATO_SUPABASE_URL || "https://qdksdauixnbgrgkilgac.supabase.co";
const anonKey = process.env.BILITATO_SUPABASE_ANON_KEY || "sb_publishable_55zwbZc_sQ0k4EDJBgpxsQ_1F86l1vT";
const timeoutMs = Math.max(1000, Number(process.env.BILITATO_REALTIME_TEST_TIMEOUT_MS || 20000));
const client = new RealtimeClient(`${supabaseUrl.replace(/\/+$/, "")}/realtime/v1`, {
  params: { apikey: anonKey },
  heartbeatIntervalMs: 25_000,
});
const channel = client.channel("remote-config-verification")
  .on("postgres_changes", {
    event: "UPDATE",
    schema: "public",
    table: "extension_remote_config",
    filter: "config_key=eq.production",
  }, async (payload) => {
    console.log(JSON.stringify({
      received: true,
      revision: payload.new?.revision,
      config_key: payload.new?.config_key,
    }));
    await client.removeChannel(channel).catch(() => {});
    await client.disconnect().catch(() => {});
    process.exit(0);
  });

channel.subscribe((status, error) => {
  console.error(`STATUS:${status}${error ? `:${error.message}` : ""}`);
});

setTimeout(async () => {
  console.log(JSON.stringify({ received: false, reason: "timeout" }));
  await client.disconnect().catch(() => {});
  process.exit(2);
}, timeoutMs);
