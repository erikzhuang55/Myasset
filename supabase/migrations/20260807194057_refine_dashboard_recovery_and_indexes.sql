create index if not exists usage_events_extension_version_created_idx
  on public.usage_events (extension_version, created_at desc)
  where nullif(extension_version, '') is not null;

create index if not exists usage_events_model_created_idx
  on public.usage_events (model, created_at desc)
  where nullif(model, '') is not null;

create index if not exists usage_events_feature_name_created_idx
  on public.usage_events (feature_name, created_at desc)
  where nullif(feature_name, '') is not null;

create or replace function private.compute_usage_dashboard_recovery_v4(
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
  select
    w.*,
    nullif(w.metadata->>'task_id', '') as task_id,
    row_number() over (
      partition by nullif(w.metadata->>'task_id', ''), w.feature_name
      order by w.created_at desc, w.id desc
    ) as terminal_rank
  from windowed w
  where w.event_name in ('task_success', 'task_partial', 'task_failed', 'task_cancelled')
    and nullif(w.metadata->>'task_id', '') is not null
),
terminal_events as materialized (
  select
    r.*,
    case
      when r.event_name = 'task_success' then 'success'
      when r.event_name = 'task_partial' then 'partial_success'
      when r.event_name = 'task_cancelled' or r.status = 'cancelled'
        or upper(coalesce(r.error_code, '')) in ('ABORTED', 'USER_CANCELLED') then 'cancelled'
      else 'failed'
    end as final_outcome
  from ranked_terminal r
  where r.terminal_rank = 1
),
final_by_task as materialized (
  select task_id, final_outcome
  from (
    select
      t.*,
      row_number() over (partition by t.task_id order by t.created_at desc, t.id desc) as task_rank
    from terminal_events t
  ) ranked
  where task_rank = 1
),
recovery_events as materialized (
  select
    w.id,
    nullif(w.metadata->>'task_id', '') as task_id,
    coalesce(nullif(w.metadata->>'strategy', ''), 'unknown') as strategy,
    w.status,
    w.created_at,
    w.duration_ms,
    w.token_count
  from windowed w
  where w.event_name = 'task_recovery_finished'
    and nullif(w.metadata->>'task_id', '') is not null
),
strategy_tasks as materialized (
  select
    strategy,
    task_id,
    bool_or(status = 'success') as direct_recovered,
    max(created_at) as last_strategy_at,
    count(*) as attempts,
    round(avg(duration_ms) filter (where duration_ms is not null)) as avg_duration_ms,
    round(percentile_cont(0.5) within group (order by duration_ms) filter (where duration_ms is not null)) as p50_duration_ms,
    round(percentile_cont(0.95) within group (order by duration_ms) filter (where duration_ms is not null)) as p95_duration_ms,
    round(avg(token_count) filter (where token_count is not null)) as avg_token_count
  from recovery_events
  group by strategy, task_id
),
strategy_task_outcomes as materialized (
  select
    st.*,
    coalesce(f.final_outcome in ('success', 'partial_success'), false) as final_completed,
    coalesce(f.final_outcome = 'success', false) as final_full_success,
    coalesce(f.final_outcome = 'partial_success', false) as final_partial_success,
    exists (
      select 1
      from recovery_events later
      where later.task_id = st.task_id
        and later.strategy <> st.strategy
        and later.created_at > st.last_strategy_at
    ) as needed_followup
  from strategy_tasks st
  left join final_by_task f on f.task_id = st.task_id
),
recovery_strategies as (
  select
    strategy,
    count(*) as tasks,
    sum(attempts) as attempts,
    count(*) filter (where direct_recovered) as direct_recovered_tasks,
    count(*) filter (where final_completed) as final_completed_tasks,
    count(*) filter (where final_full_success) as full_success_tasks,
    count(*) filter (where final_partial_success) as partial_success_tasks,
    count(*) filter (where needed_followup) as followup_required_tasks,
    round(avg(avg_duration_ms)) as avg_duration_ms,
    round(avg(p50_duration_ms)) as p50_duration_ms,
    round(avg(p95_duration_ms)) as p95_duration_ms,
    round(avg(avg_token_count)) as avg_token_count
  from strategy_task_outcomes
  group by strategy
),
terminal_errors as (
  select
    feature_name,
    coalesce(nullif(error_code, ''), 'UNKNOWN') as error_code,
    count(*) as tasks,
    count(distinct user_hash) as users
  from terminal_events
  where final_outcome = 'failed'
  group by feature_name, coalesce(nullif(error_code, ''), 'UNKNOWN')
),
raw_errors as (
  select
    feature_name,
    coalesce(nullif(error_code, ''), 'UNKNOWN') as error_code,
    count(*) as raw_events
  from windowed
  where status = 'failed' or event_name in ('task_attempt_failed', 'task_failed')
  group by feature_name, coalesce(nullif(error_code, ''), 'UNKNOWN')
)
select jsonb_build_object(
  'retry_strategies', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'strategy', strategy,
      'tasks', tasks,
      'attempts', attempts,
      'share_percent', round(100.0 * tasks / nullif((select sum(tasks) from recovery_strategies), 0), 1),
      'successes', direct_recovered_tasks,
      'recovered_tasks', direct_recovered_tasks,
      'direct_recovered_tasks', direct_recovered_tasks,
      'direct_recovery_rate_percent', round(100.0 * direct_recovered_tasks / nullif(tasks, 0), 1),
      'final_completed_tasks', final_completed_tasks,
      'final_completion_rate_percent', round(100.0 * final_completed_tasks / nullif(tasks, 0), 1),
      'followup_required_tasks', followup_required_tasks,
      'followup_required_percent', round(100.0 * followup_required_tasks / nullif(tasks, 0), 1),
      'full_success_tasks', full_success_tasks,
      'partial_success_tasks', partial_success_tasks,
      'success_rate_percent', round(100.0 * direct_recovered_tasks / nullif(tasks, 0), 1),
      'avg_duration_ms', avg_duration_ms,
      'p50_duration_ms', p50_duration_ms,
      'p95_duration_ms', p95_duration_ms,
      'avg_token_count', avg_token_count
    ) order by tasks desc), '[]'::jsonb)
    from recovery_strategies
  ),
  'errors', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'feature_name', ranked.feature_name,
      'error_code', ranked.error_code,
      'tasks', ranked.tasks,
      'raw_events', ranked.raw_events,
      'events', ranked.raw_events,
      'users', ranked.users
    ) order by ranked.tasks desc), '[]'::jsonb)
    from (
      select te.*, coalesce(re.raw_events, 0) as raw_events
      from terminal_errors te
      left join raw_errors re using (feature_name, error_code)
      order by te.tasks desc
      limit 10
    ) ranked
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
  update private.usage_dashboard_cache
  set generated_at = least(generated_at, now() - interval '25 hours')
  where cache_key = v_cache_key;

  v_payload := private.compute_usage_dashboard_v2(v_days, v_version, v_feature, v_model)
    || private.compute_usage_dashboard_task_metrics_v3(v_days, v_version, v_feature, v_model)
    || private.compute_usage_dashboard_recovery_v4(v_days, v_version, v_feature, v_model);

  insert into private.usage_dashboard_cache (cache_key, payload, generated_at)
  values (v_cache_key, v_payload, now())
  on conflict (cache_key) do update
  set payload = excluded.payload,
      generated_at = excluded.generated_at;

  return v_payload;
end;
$$;

create or replace function private.refresh_usage_dashboard_cache_all()
returns integer
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_row record;
  v_parts text[];
  v_refreshed integer := 0;
begin
  for v_row in
    with common_versions as (
      select extension_version
      from public.usage_events
      where created_at >= now() - interval '30 days'
        and nullif(extension_version, '') is not null
      group by extension_version
      order by count(*) desc
      limit 5
    ), refresh_keys as (
      select cache_key from private.usage_dashboard_cache
      union
      select '30|||'
      union
      select concat('30|', extension_version, '||') from common_versions
    )
    select cache_key from refresh_keys order by cache_key
  loop
    v_parts := string_to_array(v_row.cache_key, '|');
    perform private.refresh_usage_dashboard_cache(
      greatest(7, least(coalesce(nullif(v_parts[1], '')::integer, 30), 90)),
      coalesce(v_parts[2], ''),
      coalesce(v_parts[3], ''),
      coalesce(v_parts[4], '')
    );
    v_refreshed := v_refreshed + 1;
  end loop;
  return v_refreshed;
end;
$$;

revoke all on function private.compute_usage_dashboard_recovery_v4(integer, text, text, text)
  from public, anon, authenticated;
revoke all on function private.refresh_usage_dashboard_cache(integer, text, text, text)
  from public, anon, authenticated;
grant execute on function private.refresh_usage_dashboard_cache(integer, text, text, text)
  to service_role;
revoke all on function private.refresh_usage_dashboard_cache_all()
  from public, anon, authenticated;

delete from private.usage_dashboard_cache;
