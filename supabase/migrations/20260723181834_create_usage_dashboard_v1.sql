create or replace function public.get_usage_dashboard_v1(p_days integer default 30)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
with
params as (
  select greatest(7, least(coalesce(p_days, 30), 90)) as days,
    coalesce(max((created_at at time zone 'Asia/Shanghai')::date), (now() at time zone 'Asia/Shanghai')::date) as anchor_date
  from public.usage_events
),
events as (
  select e.*, (e.created_at at time zone 'Asia/Shanghai')::date as local_date
  from public.usage_events e
),
windowed as (
  select e.* from events e cross join params p
  where e.local_date between p.anchor_date - (p.days - 1) and p.anchor_date
),
kpis as (
  select p.anchor_date, p.days,
    count(distinct e.user_hash) filter (where e.local_date = p.anchor_date) as dau,
    count(distinct e.user_hash) filter (where e.local_date between p.anchor_date - 6 and p.anchor_date) as wau,
    count(distinct e.user_hash) filter (where e.local_date between p.anchor_date - 29 and p.anchor_date) as mau,
    (select count(distinct user_hash) from events) as observable_users
  from params p left join events e on e.local_date between p.anchor_date - 29 and p.anchor_date
  group by p.anchor_date, p.days
),
feature_catalog(feature_key, label, sort_order) as (
  values ('summary', 'Summary', 1), ('cc', 'CC', 2), ('chat', 'Chat', 3), ('real', 'Real-time', 4), ('settings', 'Settings', 5)
),
adoption as (
  select f.feature_key, f.label, f.sort_order, count(w.id) as uses, count(distinct w.user_hash) as users
  from feature_catalog f
  left join windowed w on w.event_name = 'panel_opened' and lower(w.feature_name) = f.feature_key
  group by f.feature_key, f.label, f.sort_order
),
funnel_extension as (
  select user_hash, min(created_at) as occurred_at from windowed where event_name = 'extension_started' group by user_hash
),
funnel_panel as (
  select s.user_hash, min(e.created_at) as occurred_at
  from funnel_extension s join windowed e on e.user_hash = s.user_hash and e.event_name = 'panel_opened'
    and lower(e.feature_name) = 'summary' and e.created_at >= s.occurred_at
  group by s.user_hash
),
funnel_started as (
  select s.user_hash, min(e.created_at) as occurred_at
  from funnel_panel s join windowed e on e.user_hash = s.user_hash and e.event_name = 'task_started'
    and e.feature_name = 'summary_segments_merged' and e.created_at >= s.occurred_at
  group by s.user_hash
),
funnel_success as (
  select s.user_hash, min(e.created_at) as occurred_at
  from funnel_started s join windowed e on e.user_hash = s.user_hash and e.event_name = 'task_success'
    and e.feature_name = 'summary_segments_merged' and e.created_at >= s.occurred_at
  group by s.user_hash
),
funnel_counts as (
  select 1 as sort_order, 'extension_started' as step, 'Extension started' as label, (select count(*) from funnel_extension) as users
  union all select 2, 'panel_opened_summary', 'Summary opened', (select count(*) from funnel_panel)
  union all select 3, 'task_started_summary', 'Summary task started', (select count(*) from funnel_started)
  union all select 4, 'task_success_summary', 'Summary task succeeded', (select count(*) from funnel_success)
),
funnel as (
  select sort_order, step, label, users, lag(users) over (order by sort_order) as previous_users from funnel_counts
),
task_health as (
  select feature_name,
    count(*) filter (where event_name = 'task_started') as started,
    count(*) filter (where event_name = 'task_success') as success,
    count(*) filter (where event_name = 'task_partial') as partial,
    count(*) filter (where event_name = 'task_failed' and status not in ('timeout', 'cancelled')) as failed,
    count(*) filter (where event_name = 'task_failed' and status = 'timeout') as timeout,
    count(*) filter (where event_name = 'task_cancelled' or (event_name = 'task_failed' and status = 'cancelled')) as cancelled
  from windowed where event_name like 'task_%' group by feature_name
),
error_distribution as (
  select feature_name, coalesce(nullif(error_code, ''), 'UNKNOWN') as error_code,
    count(*) as events, count(distinct user_hash) as users
  from windowed where event_name = 'task_failed'
  group by feature_name, coalesce(nullif(error_code, ''), 'UNKNOWN') order by events desc limit 10
),
version_health as (
  select extension_version, count(distinct user_hash) as users,
    count(*) filter (where event_name = 'task_success') as success,
    count(*) filter (where event_name = 'task_failed' and status not in ('timeout', 'cancelled')) as failed,
    count(*) filter (where event_name = 'task_failed' and status = 'timeout') as timeout,
    count(*) filter (where event_name = 'task_cancelled' or (event_name = 'task_failed' and status = 'cancelled')) as cancelled
  from windowed where extension_version <> '' group by extension_version
),
calendar as (
  select generate_series((select anchor_date - (days - 1) from params), (select anchor_date from params), interval '1 day')::date as stat_date
),
daily as (
  select c.stat_date, count(distinct w.user_hash) as dau,
    count(*) filter (where w.event_name = 'task_started') as task_volume,
    count(*) filter (where w.event_name = 'task_success') as task_success,
    count(*) filter (where w.event_name in ('task_success', 'task_partial', 'task_failed', 'task_cancelled')) as task_terminal
  from calendar c left join windowed w on w.local_date = c.stat_date group by c.stat_date
)
select jsonb_build_object(
  'generated_at', now(), 'timezone', 'Asia/Shanghai',
  'window', (select jsonb_build_object('days', days, 'start_date', anchor_date - (days - 1), 'end_date', anchor_date) from params),
  'overview', (select jsonb_build_object('dau', dau, 'wau', wau, 'mau', mau,
    'wau_mau_percent', round(100.0 * wau / nullif(mau, 0), 1), 'observable_users', observable_users) from kpis),
  'adoption', (select coalesce(jsonb_agg(jsonb_build_object('feature', label, 'feature_key', feature_key,
    'users', users, 'uses', uses, 'mau_share_percent', round(100.0 * users / nullif((select mau from kpis), 0), 1)) order by sort_order), '[]'::jsonb) from adoption),
  'funnel', (select coalesce(jsonb_agg(jsonb_build_object('step', step, 'label', label, 'users', users,
    'conversion_percent', case when previous_users is null then 100 else round(100.0 * users / nullif(previous_users, 0), 1) end,
    'dropoff', case when previous_users is null then 0 else greatest(previous_users - users, 0) end) order by sort_order), '[]'::jsonb) from funnel),
  'task_health', (select coalesce(jsonb_agg(jsonb_build_object('feature', feature_name, 'started', started,
    'success', success, 'partial', partial, 'failed', failed, 'timeout', timeout, 'cancelled', cancelled,
    'success_rate_percent', round(100.0 * success / nullif(success + partial + failed + timeout + cancelled, 0), 1)) order by started desc), '[]'::jsonb) from task_health),
  'errors', (select coalesce(jsonb_agg(to_jsonb(error_distribution)), '[]'::jsonb) from error_distribution),
  'versions', (select coalesce(jsonb_agg(jsonb_build_object('version', extension_version, 'users', users,
    'success_rate_percent', round(100.0 * success / nullif(success + failed + timeout + cancelled, 0), 1),
    'error_rate_percent', round(100.0 * (failed + timeout) / nullif(success + failed + timeout + cancelled, 0), 1),
    'timeout', timeout) order by users desc), '[]'::jsonb) from version_health),
  'trend', (select coalesce(jsonb_agg(jsonb_build_object('date', stat_date, 'dau', dau, 'task_volume', task_volume,
    'task_success_rate_percent', round(100.0 * task_success / nullif(task_terminal, 0), 1)) order by stat_date), '[]'::jsonb) from daily)
);
$$;
revoke all on function public.get_usage_dashboard_v1(integer) from public;
revoke all on function public.get_usage_dashboard_v1(integer) from anon;
revoke all on function public.get_usage_dashboard_v1(integer) from authenticated;
grant execute on function public.get_usage_dashboard_v1(integer) to service_role;;
