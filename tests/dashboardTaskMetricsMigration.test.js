import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../supabase/migrations/20260807180503_dedupe_dashboard_task_outcomes.sql", import.meta.url),
  "utf8",
);
const trackedTaskMigration = readFileSync(
  new URL("../supabase/migrations/20260807182022_scope_dashboard_metrics_to_tracked_tasks.sql", import.meta.url),
  "utf8",
);
const recoveryMigration = readFileSync(
  new URL("../supabase/migrations/20260807194057_refine_dashboard_recovery_and_indexes.sql", import.meta.url),
  "utf8",
);
const lifecycleMigration = readFileSync(
  new URL("../supabase/migrations/20260808064143_fix_dashboard_task_lifecycle_metrics.sql", import.meta.url),
  "utf8",
);

describe("dashboard task metrics migration", () => {
  it("deduplicates terminal events before task and model metrics", () => {
    expect(migration).toContain("partition by coalesce(nullif(w.metadata->>'task_id', ''), w.id::text), w.feature_name");
    expect(migration).toContain("where r.terminal_rank = 1");
    expect(migration).toContain("from terminal_events");
  });

  it("uses final task outcomes for recovery and exposes no-terminal tasks", () => {
    expect(migration).toContain("final_by_task as materialized");
    expect(migration).toContain("'full_recovered_tasks'");
    expect(migration).toContain("'partial_recovered_tasks'");
    expect(migration).toContain("'no_terminal_tasks'");
  });

  it("publishes the requested KPI and 429 breakdown fields", () => {
    expect(migration).toContain("'full_success_rate_percent'");
    expect(migration).toContain("'completion_rate_percent'");
    expect(migration).toContain("'plugin_logic_failure_rate_percent'");
    expect(migration).toContain("'provider_service_failure_rate_percent'");
    expect(migration).toContain("'user_config_block_rate_percent'");
    expect(migration).toContain("'rate_limits'");
  });

  it("excludes legacy terminal events that cannot be reliably deduplicated", () => {
    expect(trackedTaskMigration).toContain("and nullif(w.metadata->>''task_id'', '''') is not null");
    expect(trackedTaskMigration).toContain("delete from private.usage_dashboard_cache");
  });

  it("separates direct recovery, final completion, and follow-up fallback rates", () => {
    expect(recoveryMigration).toContain("'direct_recovery_rate_percent'");
    expect(recoveryMigration).toContain("'final_completion_rate_percent'");
    expect(recoveryMigration).toContain("'followup_required_percent'");
    expect(recoveryMigration).toContain("'raw_events'");
    expect(recoveryMigration).toContain("'tasks', ranked.tasks");
  });

  it("indexes dashboard filters and prewarms common version caches", () => {
    expect(recoveryMigration).toContain("usage_events_extension_version_created_idx");
    expect(recoveryMigration).toContain("usage_events_model_created_idx");
    expect(recoveryMigration).toContain("usage_events_feature_name_created_idx");
    expect(recoveryMigration).toContain("common_versions as");
    expect(recoveryMigration).toContain("limit 5");
  });

  it("treats blocked tasks as terminal and divides completion by tracked starts", () => {
    expect(lifecycleMigration).toContain("'task_cancelled', 'task_blocked'");
    expect(lifecycleMigration).toContain("nullif(s.started_tasks, 0)");
    expect(lifecycleMigration).toContain("when r.event_name = 'task_blocked' then 'blocked'");
  });

  it("filters by matching task ids before reading full lifecycles", () => {
    expect(lifecycleMigration).toContain("model_matched_tasks as materialized");
    expect(lifecycleMigration).toContain("from model_matched_tasks matched");
    expect(lifecycleMigration).toContain("usage_events_task_id_created_idx");
  });

  it("attributes model latency to actual request events", () => {
    expect(lifecycleMigration).toContain("model_request_events as materialized");
    expect(lifecycleMigration).toContain("w.event_name in ('task_attempt_failed', 'task_recovery_finished')");
    expect(lifecycleMigration).toContain("'request_count', request_count");
    expect(lifecycleMigration).toContain("'successful_requests', successful_requests");
  });

  it("updates the remote ModelScope default model", () => {
    expect(lifecycleMigration).toContain("'{providers,modelscope,default_model}'");
    expect(lifecycleMigration).toContain("Qwen/Qwen3-30B-A3B-Instruct-2507");
  });
});
