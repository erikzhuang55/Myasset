create or replace function private.compute_usage_dashboard_task_metrics_v3(
  p_days integer default 30,
  p_version text default '',
  p_feature text default '',
  p_model text default ''
)
returns jsonb
language sql
stable
security definer
set search_path = public, private, pg_temp
as $$
with
params as (
  select
    greatest(7, least(coalesce(p_days, 30), 90)) as days,
    nullif(btrim(coalesce(p_version, '')), '') as version_filter,
    nullif(btrim(coalesce(p_feature, '')), '') as feature_filter,
    nullif(btrim(coalesce(p_model, '')), '') as model_filter,
    coalesce(
      ((select max(created_at) from public.usage_events) at time zone 'Asia/Shanghai')::date,
      (now() at time zone 'Asia/Shanghai')::date
    ) as anchor_date
),
windowed as materialized (
  select e.*
  from public.usage_events e
  cross join params p
  where e.created_at >= ((p.anchor_date - (p.days - 1))::timestamp at time zone 'Asia/Shanghai')
    and e.created_at < ((p.anchor_date + 1)::timestamp at time zone 'Asia/Shanghai')
    and (p.version_filter is null or e.extension_version = p.version_filter)
    and (p.feature_filter is null or e.feature_name = p.feature_filter)
    and (p.model_filter is null or e.model = p.model_filter)
),
ranked_terminal as materialized (
  select w.*,
    coalesce(nullif(w.metadata->>'task_id', ''), w.id::text) as task_key,
    row_number() over (
      partition by coalesce(nullif(w.metadata->>'task_id', ''), w.id::text), w.feature_name
      order by w.created_at desc, w.id desc
    ) as terminal_rank
  from windowed w
  where w.event_name in ('task_success', 'task_partial', 'task_failed', 'task_cancelled')
),
terminal_events as materialized (
  select r.*,
    case
      when r.event_name = 'task_success' then 'success'
      when r.event_name = 'task_partial' then 'partial_success'
      when r.event_name = 'task_cancelled' or r.status = 'cancelled'
        or upper(coalesce(r.error_code, '')) in ('ABORTED', 'USER_CANCELLED') then 'cancelled'
      when upper(coalesce(r.error_code, '')) in (
        'MISSING_API_KEY', 'CONFIG_REQUIRED', 'VALIDATION_ERROR', 'HTTP_401',
        'CUSTOM_PROVIDER_AUTH_REQUIRED', 'CUSTOM_PROVIDER_BASE_URL_REQUIRED'
      ) then 'user_config_failed'
      when upper(coalesce(r.error_code, '')) like 'HTTP_429%'
        or upper(coalesce(r.error_code, '')) ~
          '^(HTTP_|AI_|ASR_|PROVIDER_|NETWORK_|MODEL_|SUMMARY_EMPTY|SEGMENTS_(EMPTY|PARSE|NORMALIZE)|JSON_)'
        or upper(coalesce(r.error_code, '')) like '%TIMEOUT%'
      then 'provider_service_failed'
      when r.metadata->>'outcome_category' in (
        'plugin_logic_failed', 'provider_service_failed', 'user_config_failed',
        'cancelled', 'partial_success'
      ) then r.metadata->>'outcome_category'
      else 'plugin_logic_failed'
    end as outcome_category
  from ranked_terminal r
  where r.terminal_rank = 1
),
tracked_starts as materialized (
  select distinct on (nullif(w.metadata->>'task_id', ''), w.feature_name)
    nullif(w.metadata->>'task_id', '') as task_id,
    w.feature_name,
    w.created_at
  from windowed w
  where w.event_name = 'task_started'
    and nullif(w.metadata->>'task_id', '') is not null
  order by nullif(w.metadata->>'task_id', ''), w.feature_name, w.created_at
),
task_health as (
  select
    feature_name,
    count(*) as terminal_tasks,
    count(*) filter (where outcome_category = 'success') as success,
    count(*) filter (where outcome_category = 'partial_success') as partial_success,
    count(*) filter (where outcome_category = 'plugin_logic_failed') as plugin_logic_failed,
    count(*) filter (where outcome_category = 'provider_service_failed') as provider_service_failed,
    count(*) filter (where outcome_category = 'user_config_failed') as user_config_failed,
    count(*) filter (where outcome_category = 'cancelled') as cancelled
  from terminal_events
  group by feature_name
),
start_health as (
  select s.feature_name,
    count(*) as started,
    count(*) filter (where t.task_key is null) as no_terminal_tasks
  from tracked_starts s
  left join terminal_events t
    on t.task_key = s.task_id and t.feature_name = s.feature_name
  group by s.feature_name
),
health_rows as (
  select
    coalesce(s.feature_name, h.feature_name) as feature_name,
    coalesce(s.started, h.terminal_tasks, 0) as started,
    coalesce(s.no_terminal_tasks, 0) as no_terminal_tasks,
    coalesce(h.terminal_tasks, 0) as terminal_tasks,
    coalesce(h.success, 0) as success,
    coalesce(h.partial_success, 0) as partial_success,
    coalesce(h.plugin_logic_failed, 0) as plugin_logic_failed,
    coalesce(h.provider_service_failed, 0) as provider_service_failed,
    coalesce(h.user_config_failed, 0) as user_config_failed,
    coalesce(h.cancelled, 0) as cancelled
  from start_health s
  full join task_health h on h.feature_name = s.feature_name
),
all_kpis as (
  select
    count(*) as terminal_tasks,
    count(*) filter (where outcome_category = 'success') as success,
    count(*) filter (where outcome_category = 'partial_success') as partial_success,
    count(*) filter (where outcome_category = 'plugin_logic_failed') as plugin_logic_failed,
    count(*) filter (where outcome_category = 'provider_service_failed') as provider_service_failed,
    count(*) filter (where outcome_category = 'user_config_failed') as user_config_failed,
    count(*) filter (where outcome_category = 'cancelled') as cancelled
  from terminal_events
),
start_kpis as (
  select count(*) as started_tasks,
    count(*) filter (where t.task_key is null) as no_terminal_tasks
  from tracked_starts s
  left join terminal_events t
    on t.task_key = s.task_id and t.feature_name = s.feature_name
),
attempted_tasks as materialized (
  select distinct nullif(w.metadata->>'task_id', '') as task_id
  from windowed w
  where w.event_name in ('task_attempt_failed', 'task_recovery_started', 'task_recovery_finished')
    and nullif(w.metadata->>'task_id', '') is not null
),
final_by_task as materialized (
  select ranked.task_key as task_id, ranked.outcome_category
  from (
    select t.*,
      row_number() over (partition by t.task_key order by t.created_at desc, t.id desc) as task_rank
    from terminal_events t
    join attempted_tasks a on a.task_id = t.task_key
  ) ranked
  where ranked.task_rank = 1
),
recovery_events as materialized (
  select
    nullif(w.metadata->>'task_id', '') as task_id,
    coalesce(nullif(w.metadata->>'strategy', ''), 'unknown') as strategy,
    w.duration_ms,
    w.token_count
  from windowed w
  where w.event_name = 'task_recovery_finished'
    and nullif(w.metadata->>'task_id', '') is not null
),
strategy_tasks as (
  select distinct strategy, task_id
  from recovery_events
),
recovery_strategies as (
  select
    st.strategy,
    count(distinct st.task_id) as tasks,
    count(distinct st.task_id) filter (where f.outcome_category in ('success', 'partial_success')) as recovered_tasks,
    count(distinct st.task_id) filter (where f.outcome_category = 'success') as full_success_tasks,
    count(distinct st.task_id) filter (where f.outcome_category = 'partial_success') as partial_success_tasks,
    count(r.task_id) as attempts,
    round(avg(r.duration_ms) filter (where r.duration_ms is not null)) as avg_duration_ms,
    round(percentile_cont(0.5) within group (order by r.duration_ms) filter (where r.duration_ms is not null)) as p50_duration_ms,
    round(percentile_cont(0.95) within group (order by r.duration_ms) filter (where r.duration_ms is not null)) as p95_duration_ms,
    round(avg(r.token_count) filter (where r.token_count is not null)) as avg_token_count
  from strategy_tasks st
  left join final_by_task f on f.task_id = st.task_id
  left join recovery_events r on r.strategy = st.strategy and r.task_id = st.task_id
  group by st.strategy
),
model_performance as (
  select
    feature_name,
    provider,
    model,
    count(*) as terminal_tasks,
    count(*) filter (where outcome_category = 'success') as successful_tasks,
    count(*) filter (where outcome_category = 'partial_success') as partial_successful_tasks,
    count(*) filter (where outcome_category not in ('success', 'partial_success')) as failed_tasks,
    round(avg(duration_ms) filter (where outcome_category = 'success' and duration_ms is not null)) as avg_duration_ms,
    round(percentile_cont(0.5) within group (order by duration_ms) filter (where outcome_category = 'success' and duration_ms is not null)) as p50_duration_ms,
    round(percentile_cont(0.95) within group (order by duration_ms) filter (where outcome_category = 'success' and duration_ms is not null)) as p95_duration_ms,
    round(avg(token_count) filter (where outcome_category = 'success' and token_count is not null)) as avg_token_count
  from terminal_events
  where nullif(provider, '') is not null and nullif(model, '') is not null
  group by feature_name, provider, model
),
rate_limits as (
  select
    provider,
    model,
    case upper(coalesce(error_code, ''))
      when 'HTTP_429_CREDIT_EXHAUSTED' then 'credit_balance_exhausted'
      when 'HTTP_429_MODEL_QUOTA_EXHAUSTED' then 'model_quota_exhausted'
      when 'HTTP_429_INSUFFICIENT_QUOTA' then 'quota_exhausted'
      when 'HTTP_429_QUEUE_EXCEEDED' then 'queue_overloaded'
      when 'HTTP_429_RATE_LIMIT' then 'rate_limited'
      else 'unknown_429'
    end as reason,
    count(*) as tasks,
    count(distinct user_hash) as users
  from terminal_events
  where upper(coalesce(error_code, '')) like 'HTTP_429%'
  group by provider, model, 3
)
select jsonb_build_object(
  'task_kpis', (
    select jsonb_build_object(
      'started_tasks', s.started_tasks,
      'terminal_tasks', k.terminal_tasks,
      'full_success_tasks', k.success,
      'completed_tasks', k.success + k.partial_success,
      'full_success_rate_percent', round(100.0 * k.success / nullif(k.terminal_tasks, 0), 1),
      'completion_rate_percent', round(100.0 * (k.success + k.partial_success) / nullif(k.terminal_tasks, 0), 1),
      'plugin_logic_failure_rate_percent', round(100.0 * k.plugin_logic_failed / nullif(k.terminal_tasks, 0), 1),
      'provider_service_failure_rate_percent', round(100.0 * k.provider_service_failed / nullif(k.terminal_tasks, 0), 1),
      'user_config_block_rate_percent', round(100.0 * k.user_config_failed / nullif(k.terminal_tasks, 0), 1),
      'no_terminal_tasks', s.no_terminal_tasks
    ) from all_kpis k cross join start_kpis s
  ),
  'task_health', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'feature', feature_name,
      'started', started,
      'terminal_tasks', terminal_tasks,
      'no_terminal_tasks', no_terminal_tasks,
      'success', success,
      'partial_success', partial_success,
      'plugin_logic_failed', plugin_logic_failed,
      'provider_service_failed', provider_service_failed,
      'user_config_failed', user_config_failed,
      'cancelled', cancelled,
      'task_failure_rate_percent', round(100.0 * (plugin_logic_failed + provider_service_failed + user_config_failed) / nullif(terminal_tasks, 0), 1)
    ) order by started desc), '[]'::jsonb) from health_rows
  ),
  'retry_overview', (
    select jsonb_build_object(
      'initial_failed_tasks', count(*),
      'recovery_attempts', (select count(*) from recovery_events),
      'recovery_successes', count(*) filter (where f.outcome_category in ('success', 'partial_success')),
      'recovered_tasks', count(*) filter (where f.outcome_category in ('success', 'partial_success')),
      'full_recovered_tasks', count(*) filter (where f.outcome_category = 'success'),
      'partial_recovered_tasks', count(*) filter (where f.outcome_category = 'partial_success'),
      'unrecovered_tasks', count(*) filter (where f.outcome_category in ('plugin_logic_failed', 'provider_service_failed', 'user_config_failed')),
      'cancelled_tasks', count(*) filter (where f.outcome_category = 'cancelled'),
      'no_terminal_tasks', count(*) filter (where f.task_id is null),
      'recovery_rate_percent', round(100.0 * count(*) filter (where f.outcome_category in ('success', 'partial_success')) / nullif(count(*) filter (where f.task_id is not null), 0), 1)
    )
    from attempted_tasks a
    left join final_by_task f on f.task_id = a.task_id
  ),
  'retry_strategies', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'strategy', strategy,
      'tasks', tasks,
      'attempts', attempts,
      'share_percent', round(100.0 * tasks / nullif((select sum(tasks) from recovery_strategies), 0), 1),
      'successes', recovered_tasks,
      'recovered_tasks', recovered_tasks,
      'full_success_tasks', full_success_tasks,
      'partial_success_tasks', partial_success_tasks,
      'success_rate_percent', round(100.0 * recovered_tasks / nullif(tasks, 0), 1),
      'avg_duration_ms', avg_duration_ms,
      'p50_duration_ms', p50_duration_ms,
      'p95_duration_ms', p95_duration_ms,
      'avg_token_count', avg_token_count
    ) order by tasks desc), '[]'::jsonb) from recovery_strategies
  ),
  'model_performance', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'feature_name', feature_name,
      'provider', provider,
      'model', model,
      'terminal_tasks', terminal_tasks,
      'successful_tasks', successful_tasks,
      'partial_successful_tasks', partial_successful_tasks,
      'failed_tasks', failed_tasks,
      'success_rate_percent', round(100.0 * successful_tasks / nullif(terminal_tasks, 0), 1),
      'avg_duration_ms', avg_duration_ms,
      'p50_duration_ms', p50_duration_ms,
      'p95_duration_ms', p95_duration_ms,
      'avg_token_count', avg_token_count
    ) order by terminal_tasks desc), '[]'::jsonb)
    from (select * from model_performance order by terminal_tasks desc limit 50) ranked
  ),
  'rate_limits', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'provider', provider,
      'model', model,
      'reason', reason,
      'tasks', tasks,
      'users', users
    ) order by tasks desc), '[]'::jsonb) from rate_limits
  )
);
$$;
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
  -- Force the legacy compute function past its own 24-hour cache guard.
  update private.usage_dashboard_cache
  set generated_at = least(generated_at, now() - interval '25 hours')
  where cache_key = v_cache_key;

  v_payload := private.compute_usage_dashboard_v2(v_days, v_version, v_feature, v_model)
    || private.compute_usage_dashboard_task_metrics_v3(v_days, v_version, v_feature, v_model);

  insert into private.usage_dashboard_cache (cache_key, payload, generated_at)
  values (v_cache_key, v_payload, now())
  on conflict (cache_key) do update
  set payload = excluded.payload,
      generated_at = excluded.generated_at;

  return v_payload;
end;
$$;
create or replace function public.get_usage_dashboard_v2(
  p_days integer default 30,
  p_version text default '',
  p_feature text default '',
  p_model text default ''
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $$
declare
  v_days integer := greatest(7, least(coalesce(p_days, 30), 90));
  v_version text := nullif(btrim(coalesce(p_version, '')), '');
  v_feature text := nullif(btrim(coalesce(p_feature, '')), '');
  v_model text := nullif(btrim(coalesce(p_model, '')), '');
  v_cache_key text;
  v_cached_payload jsonb;
  v_cached_at timestamptz;
begin
  v_cache_key := concat_ws('|', v_days::text, coalesce(v_version, ''), coalesce(v_feature, ''), coalesce(v_model, ''));
  select c.payload, c.generated_at into v_cached_payload, v_cached_at
  from private.usage_dashboard_cache c where c.cache_key = v_cache_key;

  if v_cached_payload is not null then
    return v_cached_payload || jsonb_build_object('cache_info', jsonb_build_object(
      'hit', true,
      'stale', v_cached_at < now() - interval '24 hours',
      'generated_at', v_cached_at,
      'ttl_hours', 24
    ));
  end if;

  return private.refresh_usage_dashboard_cache(v_days, coalesce(v_version, ''), coalesce(v_feature, ''), coalesce(v_model, ''))
    || jsonb_build_object('cache_info', jsonb_build_object('hit', false, 'generated_at', now(), 'ttl_hours', 24));
end;
$$;
revoke all on function private.compute_usage_dashboard_task_metrics_v3(integer, text, text, text)
  from public, anon, authenticated;
revoke all on function private.refresh_usage_dashboard_cache(integer, text, text, text)
  from public, anon, authenticated;
grant execute on function private.refresh_usage_dashboard_cache(integer, text, text, text)
  to service_role;
revoke all on function public.get_usage_dashboard_v2(integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.get_usage_dashboard_v2(integer, text, text, text)
  to service_role;
delete from private.usage_dashboard_cache;
