create index if not exists usage_events_task_id_created_idx
  on public.usage_events ((metadata->>'task_id'), created_at desc)
  where nullif(metadata->>'task_id', '') is not null;

do $migration$
declare
  v_definition text;
  v_original text;
  v_start integer;
  v_end integer;
  v_model_block text := $block$model_request_events as materialized (
  select
    nullif(w.metadata->>'task_id', '') as task_id,
    w.feature_name,
    w.provider,
    w.model,
    case
      when w.event_name = 'task_recovery_finished' and w.status = 'success' then 'success'
      else 'failed'
    end as request_outcome,
    w.duration_ms,
    w.token_count
  from windowed w
  where w.event_name in ('task_attempt_failed', 'task_recovery_finished')
    and nullif(w.metadata->>'task_id', '') is not null
    and nullif(w.provider, '') is not null
    and nullif(w.model, '') is not null
),
model_request_tasks as materialized (
  select distinct task_id, feature_name
  from model_request_events
),
legacy_model_requests as materialized (
  select
    t.task_key as task_id,
    t.feature_name,
    t.provider,
    t.model,
    case
      when t.outcome_category = 'success' then 'success'
      when t.outcome_category = 'partial_success' then 'partial_success'
      else 'failed'
    end as request_outcome,
    t.duration_ms,
    t.token_count
  from terminal_events t
  where nullif(t.provider, '') is not null
    and nullif(t.model, '') is not null
    and not exists (
      select 1
      from model_request_tasks mrt
      where mrt.task_id = t.task_key
        and mrt.feature_name = t.feature_name
    )
),
actual_model_requests as materialized (
  select * from model_request_events
  union all
  select * from legacy_model_requests
),
model_performance as (
  select
    feature_name,
    provider,
    model,
    count(*) as request_count,
    count(*) filter (where request_outcome = 'success') as successful_requests,
    count(*) filter (where request_outcome = 'partial_success') as partial_successful_requests,
    count(*) filter (where request_outcome = 'failed') as failed_requests,
    round(avg(duration_ms) filter (where request_outcome = 'success' and duration_ms is not null)) as avg_duration_ms,
    round(percentile_cont(0.5) within group (order by duration_ms) filter (where request_outcome = 'success' and duration_ms is not null)) as p50_duration_ms,
    round(percentile_cont(0.95) within group (order by duration_ms) filter (where request_outcome = 'success' and duration_ms is not null)) as p95_duration_ms,
    round(avg(token_count) filter (where request_outcome = 'success' and token_count is not null)) as avg_token_count
  from actual_model_requests
  group by feature_name, provider, model
)$block$;
begin
  select pg_get_functiondef(
    'private.compute_usage_dashboard_task_metrics_v3(integer,text,text,text)'::regprocedure
  ) into v_definition;
  v_original := v_definition;

  v_definition := replace(
    v_definition,
    'compute_usage_dashboard_task_metrics_v3',
    'compute_usage_dashboard_task_metrics_v4'
  );

  v_definition := replace(
    v_definition,
    E'windowed as materialized (\n  select e.*\n  from public.usage_events e\n  cross join params p\n  where e.created_at >= ((p.anchor_date - (p.days - 1))::timestamp at time zone ''Asia/Shanghai'')\n    and e.created_at < ((p.anchor_date + 1)::timestamp at time zone ''Asia/Shanghai'')\n    and (p.version_filter is null or e.extension_version = p.version_filter)\n    and (p.feature_filter is null or e.feature_name = p.feature_filter)\n    and (p.model_filter is null or e.model = p.model_filter)\n),',
    E'model_matched_tasks as materialized (\n  select distinct nullif(e.metadata->>''task_id'', '''') as task_id\n  from public.usage_events e\n  cross join params p\n  where p.model_filter is not null\n    and e.created_at >= ((p.anchor_date - (p.days - 1))::timestamp at time zone ''Asia/Shanghai'')\n    and e.created_at < ((p.anchor_date + 1)::timestamp at time zone ''Asia/Shanghai'')\n    and (p.version_filter is null or e.extension_version = p.version_filter)\n    and (p.feature_filter is null or e.feature_name = p.feature_filter)\n    and e.model = p.model_filter\n    and nullif(e.metadata->>''task_id'', '''') is not null\n),\nwindowed as materialized (\n  select e.*\n  from public.usage_events e\n  cross join params p\n  where e.created_at >= ((p.anchor_date - (p.days - 1))::timestamp at time zone ''Asia/Shanghai'')\n    and e.created_at < ((p.anchor_date + 1)::timestamp at time zone ''Asia/Shanghai'')\n    and (p.version_filter is null or e.extension_version = p.version_filter)\n    and (p.feature_filter is null or e.feature_name = p.feature_filter)\n    and (p.model_filter is null or exists (\n      select 1\n      from model_matched_tasks matched\n      where matched.task_id = nullif(e.metadata->>''task_id'', '''')\n    ))\n),'
  );

  v_definition := replace(
    v_definition,
    $old$('task_success', 'task_partial', 'task_failed', 'task_cancelled')$old$,
    $new$('task_success', 'task_partial', 'task_failed', 'task_cancelled', 'task_blocked')$new$
  );
  v_definition := replace(
    v_definition,
    'round(100.0 * (k.success + k.partial_success) / nullif(k.terminal_tasks, 0), 1)',
    'round(100.0 * (k.success + k.partial_success) / nullif(s.started_tasks, 0), 1)'
  );

  v_start := position(E'model_performance as (\n' in v_definition);
  v_end := position(E'),\nrate_limits as (' in v_definition);
  if v_start = 0 or v_end = 0 or v_end <= v_start then
    raise exception 'Expected model performance block was not found';
  end if;
  v_definition := left(v_definition, v_start - 1)
    || v_model_block
    || substring(v_definition from v_end + 1);

  v_start := position($find$'model_performance', ($find$ in v_definition);
  if v_start = 0 then
    raise exception 'Expected model performance JSON block was not found';
  end if;
  v_model_block := substring(v_definition from v_start);
  v_model_block := replace(
    v_model_block,
    $old$'terminal_tasks', terminal_tasks$old$,
    $new$'terminal_tasks', request_count,
      'request_count', request_count$new$
  );
  v_model_block := replace(
    v_model_block,
    $old$'successful_tasks', successful_tasks$old$,
    $new$'successful_tasks', successful_requests,
      'successful_requests', successful_requests$new$
  );
  v_model_block := replace(
    v_model_block,
    $old$'partial_successful_tasks', partial_successful_tasks$old$,
    $new$'partial_successful_tasks', partial_successful_requests,
      'partial_successful_requests', partial_successful_requests$new$
  );
  v_model_block := replace(
    v_model_block,
    $old$'failed_tasks', failed_tasks$old$,
    $new$'failed_tasks', failed_requests,
      'failed_requests', failed_requests$new$
  );
  v_model_block := replace(v_model_block, 'round(100.0 * successful_tasks / nullif(terminal_tasks, 0), 1)', 'round(100.0 * successful_requests / nullif(request_count, 0), 1)');
  v_model_block := replace(v_model_block, 'order by terminal_tasks desc', 'order by request_count desc');
  v_definition := left(v_definition, v_start - 1) || v_model_block;

  if v_definition = v_original
    or position('compute_usage_dashboard_task_metrics_v4' in v_definition) = 0
    or position($find$'task_blocked'$find$ in v_definition) = 0
    or position('model_matched_tasks as materialized' in v_definition) = 0
    or position($find$'request_count', request_count$find$ in v_definition) = 0
    or position('nullif(s.started_tasks, 0)' in v_definition) = 0
  then
    raise exception 'Task metric lifecycle rewrite did not apply completely';
  end if;

  execute v_definition;
end;
$migration$;

do $migration$
declare
  v_definition text;
  v_original text;
begin
  select pg_get_functiondef(
    'private.compute_usage_dashboard_recovery_v4(integer,text,text,text)'::regprocedure
  ) into v_definition;
  v_original := v_definition;

  v_definition := replace(
    v_definition,
    'compute_usage_dashboard_recovery_v4',
    'compute_usage_dashboard_recovery_v5'
  );
  v_definition := replace(
    v_definition,
    E'windowed as materialized (\n  select e.*\n  from public.usage_events e\n  cross join params p\n  where e.created_at >= ((p.anchor_date - (p.days - 1))::timestamp at time zone ''Asia/Shanghai'')\n    and e.created_at < ((p.anchor_date + 1)::timestamp at time zone ''Asia/Shanghai'')\n    and (p.version_filter is null or e.extension_version = p.version_filter)\n    and (p.feature_filter is null or e.feature_name = p.feature_filter)\n    and (p.model_filter is null or e.model = p.model_filter)\n),',
    E'model_matched_tasks as materialized (\n  select distinct nullif(e.metadata->>''task_id'', '''') as task_id\n  from public.usage_events e\n  cross join params p\n  where p.model_filter is not null\n    and e.created_at >= ((p.anchor_date - (p.days - 1))::timestamp at time zone ''Asia/Shanghai'')\n    and e.created_at < ((p.anchor_date + 1)::timestamp at time zone ''Asia/Shanghai'')\n    and (p.version_filter is null or e.extension_version = p.version_filter)\n    and (p.feature_filter is null or e.feature_name = p.feature_filter)\n    and e.model = p.model_filter\n    and nullif(e.metadata->>''task_id'', '''') is not null\n),\nwindowed as materialized (\n  select e.*\n  from public.usage_events e\n  cross join params p\n  where e.created_at >= ((p.anchor_date - (p.days - 1))::timestamp at time zone ''Asia/Shanghai'')\n    and e.created_at < ((p.anchor_date + 1)::timestamp at time zone ''Asia/Shanghai'')\n    and (p.version_filter is null or e.extension_version = p.version_filter)\n    and (p.feature_filter is null or e.feature_name = p.feature_filter)\n    and (p.model_filter is null or exists (\n      select 1\n      from model_matched_tasks matched\n      where matched.task_id = nullif(e.metadata->>''task_id'', '''')\n    ))\n),'
  );
  v_definition := replace(
    v_definition,
    $old$('task_success', 'task_partial', 'task_failed', 'task_cancelled')$old$,
    $new$('task_success', 'task_partial', 'task_failed', 'task_cancelled', 'task_blocked')$new$
  );
  v_definition := replace(
    v_definition,
    $old$when r.event_name = 'task_cancelled' or r.status = 'cancelled'$old$,
    $new$when r.event_name = 'task_blocked' then 'blocked'
      when r.event_name = 'task_cancelled' or r.status = 'cancelled'$new$
  );

  if v_definition = v_original
    or position('compute_usage_dashboard_recovery_v5' in v_definition) = 0
    or position($find$when r.event_name = 'task_blocked' then 'blocked'$find$ in v_definition) = 0
    or position('model_matched_tasks as materialized' in v_definition) = 0
  then
    raise exception 'Recovery lifecycle rewrite did not apply completely';
  end if;

  execute v_definition;
end;
$migration$;

create or replace function private.refresh_usage_dashboard_cache(
  p_days integer default 30,
  p_version text default '',
  p_feature text default '',
  p_model text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_days integer := greatest(7, least(coalesce(p_days, 30), 90));
  v_version text := btrim(coalesce(p_version, ''));
  v_feature text := btrim(coalesce(p_feature, ''));
  v_model text := btrim(coalesce(p_model, ''));
  v_cache_key text := concat_ws('|', v_days::text, v_version, v_feature, v_model);
  v_payload jsonb;
begin
  update private.usage_dashboard_cache
  set generated_at = least(generated_at, now() - interval '25 hours')
  where cache_key = v_cache_key;

  v_payload := private.compute_usage_dashboard_v2(v_days, v_version, v_feature, v_model)
    || private.compute_usage_dashboard_task_metrics_v4(v_days, v_version, v_feature, v_model)
    || private.compute_usage_dashboard_recovery_v5(v_days, v_version, v_feature, v_model);

  insert into private.usage_dashboard_cache (cache_key, payload, generated_at)
  values (v_cache_key, v_payload, now())
  on conflict (cache_key) do update
  set payload = excluded.payload,
      generated_at = excluded.generated_at;

  return v_payload;
end;
$$;

update public.extension_remote_config
set payload = jsonb_set(
      payload,
      '{providers,modelscope,default_model}',
      to_jsonb('Qwen/Qwen3-30B-A3B-Instruct-2507'::text),
      true
    ),
    revision = revision + 1,
    updated_at = now()
where config_key = 'production'
  and payload #>> '{providers,modelscope,default_model}'
    is distinct from 'Qwen/Qwen3-30B-A3B-Instruct-2507';

revoke all on function private.compute_usage_dashboard_task_metrics_v4(integer, text, text, text)
  from public, anon, authenticated;
revoke all on function private.compute_usage_dashboard_recovery_v5(integer, text, text, text)
  from public, anon, authenticated;
revoke all on function private.refresh_usage_dashboard_cache(integer, text, text, text)
  from public, anon, authenticated;
grant execute on function private.refresh_usage_dashboard_cache(integer, text, text, text)
  to service_role;

delete from private.usage_dashboard_cache;
