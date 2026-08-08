create or replace function public.get_usage_dashboard_filters_v1(
  p_days integer default 30,
  p_version text default '',
  p_feature text default '',
  p_model text default ''
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
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
recent as materialized (
  select
    e.id,
    e.user_hash,
    e.event_name,
    e.feature_name,
    e.status,
    e.error_code,
    e.extension_version,
    e.provider,
    e.model,
    e.duration_ms,
    e.created_at,
    (e.created_at at time zone 'Asia/Shanghai')::date as local_date
  from public.usage_events e
  cross join params p
  where e.created_at >= (
      (p.anchor_date - (p.days - 1))::timestamp at time zone 'Asia/Shanghai'
    )
    and e.created_at < (
      (p.anchor_date + 1)::timestamp at time zone 'Asia/Shanghai'
    )
),
windowed as materialized (
  select r.*
  from recent r
  cross join params p
  where r.local_date between p.anchor_date - (p.days - 1) and p.anchor_date
    and (p.version_filter is null or r.extension_version = p.version_filter)
),
version_options as (
  select extension_version
  from recent
  where extension_version <> ''
  group by extension_version
),
task_options as (
  select feature_name
  from windowed
  where event_name in ('task_success', 'task_partial', 'task_failed', 'task_cancelled')
    and feature_name <> ''
    and provider <> ''
    and model <> ''
  group by feature_name
),
model_options as (
  select provider, model
  from windowed
  where event_name in ('task_success', 'task_partial', 'task_failed', 'task_cancelled')
    and provider <> ''
    and model <> ''
  group by provider, model
),
funnel_extension as (
  select user_hash, min(created_at) as occurred_at
  from windowed
  where event_name = 'extension_started'
  group by user_hash
),
funnel_panel as (
  select s.user_hash, min(e.created_at) as occurred_at
  from funnel_extension s
  join windowed e
    on e.user_hash = s.user_hash
   and e.event_name = 'panel_opened'
   and lower(e.feature_name) = 'summary'
   and e.created_at >= s.occurred_at
  group by s.user_hash
),
funnel_started as (
  select s.user_hash, min(e.created_at) as occurred_at
  from funnel_panel s
  join windowed e
    on e.user_hash = s.user_hash
   and e.event_name = 'task_started'
   and e.feature_name = 'summary_segments_merged'
   and e.created_at >= s.occurred_at
  group by s.user_hash
),
funnel_success as (
  select s.user_hash, min(e.created_at) as occurred_at
  from funnel_started s
  join windowed e
    on e.user_hash = s.user_hash
   and e.event_name = 'task_success'
   and e.feature_name = 'summary_segments_merged'
   and e.created_at >= s.occurred_at
  group by s.user_hash
),
funnel_counts as (
  select 1 as sort_order, 'extension_started' as step, 'Extension started' as label,
    (select count(*) from funnel_extension) as users
  union all
  select 2, 'panel_opened_summary', 'Summary opened', (select count(*) from funnel_panel)
  union all
  select 3, 'task_started_summary', 'Summary task started', (select count(*) from funnel_started)
  union all
  select 4, 'task_success_summary', 'Summary task succeeded', (select count(*) from funnel_success)
),
funnel as (
  select
    sort_order,
    step,
    label,
    users,
    lag(users) over (order by sort_order) as previous_users
  from funnel_counts
),
task_health as (
  select
    feature_name,
    count(*) filter (where event_name = 'task_started') as started,
    count(*) filter (where event_name = 'task_success') as success,
    count(*) filter (where event_name = 'task_partial') as partial,
    count(*) filter (
      where event_name = 'task_failed' and status not in ('timeout', 'cancelled')
    ) as failed,
    count(*) filter (where event_name = 'task_failed' and status = 'timeout') as timeout,
    count(*) filter (
      where event_name = 'task_cancelled'
         or (event_name = 'task_failed' and status = 'cancelled')
    ) as cancelled
  from windowed
  where event_name like 'task_%'
  group by feature_name
),
error_distribution as (
  select
    feature_name,
    coalesce(nullif(error_code, ''), 'UNKNOWN') as error_code,
    count(*) as events,
    count(distinct user_hash) as users
  from windowed
  where event_name = 'task_failed'
  group by feature_name, coalesce(nullif(error_code, ''), 'UNKNOWN')
  order by events desc
  limit 10
),
model_performance as (
  select
    w.feature_name,
    w.provider,
    w.model,
    count(*) as terminal_tasks,
    count(*) filter (where w.event_name = 'task_success') as successful_tasks,
    count(*) filter (where w.event_name in ('task_failed', 'task_cancelled')) as failed_tasks,
    round(avg(w.duration_ms) filter (
      where w.event_name = 'task_success' and w.duration_ms is not null
    )) as avg_duration_ms,
    round(percentile_cont(0.5) within group (order by w.duration_ms) filter (
      where w.event_name = 'task_success' and w.duration_ms is not null
    )) as p50_duration_ms,
    round(percentile_cont(0.95) within group (order by w.duration_ms) filter (
      where w.event_name = 'task_success' and w.duration_ms is not null
    )) as p95_duration_ms
  from windowed w
  cross join params p
  where w.event_name in ('task_success', 'task_partial', 'task_failed', 'task_cancelled')
    and w.provider <> ''
    and w.model <> ''
    and (p.feature_filter is null or w.feature_name = p.feature_filter)
    and (p.model_filter is null or w.model = p.model_filter)
  group by w.feature_name, w.provider, w.model
)
select jsonb_build_object(
  'active_filters', (select jsonb_build_object(
    'version', coalesce(version_filter, ''),
    'feature', coalesce(feature_filter, ''),
    'model', coalesce(model_filter, '')
  ) from params),
  'filter_options', jsonb_build_object(
    'versions', (select coalesce(jsonb_agg(extension_version order by extension_version desc), '[]'::jsonb) from version_options),
    'tasks', (select coalesce(jsonb_agg(feature_name order by feature_name), '[]'::jsonb) from task_options),
    'models', (select coalesce(jsonb_agg(jsonb_build_object(
      'provider', provider,
      'model', model
    ) order by provider, model), '[]'::jsonb) from model_options)
  ),
  'funnel', (select coalesce(jsonb_agg(jsonb_build_object(
    'step', step,
    'label', label,
    'users', users,
    'conversion_percent', case
      when previous_users is null then 100
      else round(100.0 * users / nullif(previous_users, 0), 1)
    end,
    'dropoff', case
      when previous_users is null then 0
      else greatest(previous_users - users, 0)
    end
  ) order by sort_order), '[]'::jsonb) from funnel),
  'task_health', (select coalesce(jsonb_agg(jsonb_build_object(
    'feature', feature_name,
    'started', started,
    'success', success,
    'partial', partial,
    'failed', failed,
    'timeout', timeout,
    'cancelled', cancelled,
    'success_rate_percent', round(
      100.0 * success / nullif(success + partial + failed + timeout + cancelled, 0), 1
    )
  ) order by started desc), '[]'::jsonb) from task_health),
  'errors', (select coalesce(jsonb_agg(to_jsonb(error_distribution)), '[]'::jsonb) from error_distribution),
  'model_performance', (select coalesce(jsonb_agg(jsonb_build_object(
    'feature_name', feature_name,
    'provider', provider,
    'model', model,
    'terminal_tasks', terminal_tasks,
    'successful_tasks', successful_tasks,
    'failed_tasks', failed_tasks,
    'success_rate_percent', round(100.0 * successful_tasks / nullif(terminal_tasks, 0), 1),
    'avg_duration_ms', avg_duration_ms,
    'p50_duration_ms', p50_duration_ms,
    'p95_duration_ms', p95_duration_ms,
    'avg_token_count', null
  ) order by terminal_tasks desc), '[]'::jsonb) from (
    select * from model_performance order by terminal_tasks desc limit 50
  ) ranked_models)
);
$$;

revoke all on function public.get_usage_dashboard_filters_v1(integer, text, text, text) from public;
revoke all on function public.get_usage_dashboard_filters_v1(integer, text, text, text) from anon;
revoke all on function public.get_usage_dashboard_filters_v1(integer, text, text, text) from authenticated;
grant execute on function public.get_usage_dashboard_filters_v1(integer, text, text, text) to service_role;

;
