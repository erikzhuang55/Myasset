create or replace function public.get_usage_dashboard_v2(p_days integer default 30)
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
),
terminal_events as (
  select ranked.*,
    case
      when ranked.event_name = 'task_success' then 'success'
      when ranked.event_name = 'task_partial' then 'partial_success'
      when ranked.event_name = 'task_cancelled' or ranked.status = 'cancelled' then 'cancelled'
      when ranked.metadata->>'outcome_category' in (
        'plugin_logic_failed', 'provider_service_failed', 'user_config_failed', 'cancelled', 'partial_success'
      ) then ranked.metadata->>'outcome_category'
      when upper(coalesce(ranked.error_code, '')) in (
        'MISSING_API_KEY', 'CONFIG_REQUIRED', 'VALIDATION_ERROR', 'HTTP_401',
        'CUSTOM_PROVIDER_AUTH_REQUIRED', 'CUSTOM_PROVIDER_BASE_URL_REQUIRED'
      ) then 'user_config_failed'
      when upper(coalesce(ranked.error_code, '')) ~ '^(HTTP_|AI_|ASR_|PROVIDER_|NETWORK_|MODEL_|SUMMARY_EMPTY|SEGMENTS_(EMPTY|PARSE|NORMALIZE)|JSON_)'
        or upper(coalesce(ranked.error_code, '')) like '%TIMEOUT%'
        then 'provider_service_failed'
      else 'plugin_logic_failed'
    end as outcome_category
  from (
    select w.*,
      row_number() over (
        partition by coalesce(nullif(w.metadata->>'task_id', ''), w.id::text), w.feature_name
        order by w.created_at desc, w.id desc
      ) as terminal_rank
    from windowed w
    where w.event_name in ('task_success', 'task_partial', 'task_failed', 'task_cancelled')
  ) ranked
  where ranked.terminal_rank = 1
),
task_starts as (
  select feature_name,
    count(distinct coalesce(nullif(metadata->>'task_id', ''), id::text)) as started
  from windowed
  where event_name = 'task_started'
  group by feature_name
),
task_health as (
  select
    coalesce(s.feature_name, t.feature_name) as feature_name,
    coalesce(s.started, 0) as started,
    count(*) filter (where t.event_name = 'task_success') as success,
    count(*) filter (where t.outcome_category = 'partial_success') as partial_success,
    count(*) filter (where t.outcome_category = 'plugin_logic_failed') as plugin_logic_failed,
    count(*) filter (where t.outcome_category = 'provider_service_failed') as provider_service_failed,
    count(*) filter (where t.outcome_category = 'user_config_failed') as user_config_failed,
    count(*) filter (where t.outcome_category = 'cancelled') as cancelled
  from task_starts s
  full join terminal_events t on t.feature_name = s.feature_name
  group by coalesce(s.feature_name, t.feature_name), s.started
),
version_health as (
  select
    extension_version,
    count(distinct user_hash) as users,
    count(*) filter (where event_name = 'task_success') as success,
    count(*) filter (where outcome_category = 'partial_success') as partial_success,
    count(*) filter (where outcome_category = 'plugin_logic_failed') as plugin_logic_failed,
    count(*) filter (where outcome_category = 'provider_service_failed') as provider_service_failed,
    count(*) filter (where outcome_category = 'user_config_failed') as user_config_failed,
    count(*) filter (where outcome_category = 'cancelled') as cancelled
  from terminal_events
  where extension_version <> ''
  group by extension_version
),
base as (
  select public.get_usage_dashboard_v1(p_days) as payload
)
select base.payload || jsonb_build_object(
  'task_health', (select coalesce(jsonb_agg(jsonb_build_object(
    'feature', feature_name,
    'started', started,
    'success', success,
    'partial_success', partial_success,
    'plugin_logic_failed', plugin_logic_failed,
    'provider_service_failed', provider_service_failed,
    'user_config_failed', user_config_failed,
    'cancelled', cancelled,
    'task_failure_rate_percent', round(
      100.0 * (plugin_logic_failed + provider_service_failed + user_config_failed)
      / nullif(success + partial_success + plugin_logic_failed + provider_service_failed + user_config_failed + cancelled, 0),
      1
    )
  ) order by started desc), '[]'::jsonb) from task_health),
  'versions', (select coalesce(jsonb_agg(jsonb_build_object(
    'version', extension_version,
    'users', users,
    'success_rate_percent', round(
      100.0 * success
      / nullif(success + partial_success + plugin_logic_failed + provider_service_failed + user_config_failed + cancelled, 0),
      1
    ),
    'task_failure_rate_percent', round(
      100.0 * (plugin_logic_failed + provider_service_failed + user_config_failed)
      / nullif(success + partial_success + plugin_logic_failed + provider_service_failed + user_config_failed + cancelled, 0),
      1
    ),
    'plugin_logic_failed_percent', round(100.0 * plugin_logic_failed / nullif(success + partial_success + plugin_logic_failed + provider_service_failed + user_config_failed + cancelled, 0), 1),
    'provider_service_failed_percent', round(100.0 * provider_service_failed / nullif(success + partial_success + plugin_logic_failed + provider_service_failed + user_config_failed + cancelled, 0), 1),
    'user_config_failed_percent', round(100.0 * user_config_failed / nullif(success + partial_success + plugin_logic_failed + provider_service_failed + user_config_failed + cancelled, 0), 1),
    'cancelled_percent', round(100.0 * cancelled / nullif(success + partial_success + plugin_logic_failed + provider_service_failed + user_config_failed + cancelled, 0), 1),
    'partial_success_percent', round(100.0 * partial_success / nullif(success + partial_success + plugin_logic_failed + provider_service_failed + user_config_failed + cancelled, 0), 1)
  ) order by users desc), '[]'::jsonb) from version_health)
)
from base;
$$;

create or replace function public.get_usage_dashboard_filters_v2(
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
),
terminal_events as (
  select ranked.*,
    case
      when ranked.event_name = 'task_success' then 'success'
      when ranked.event_name = 'task_partial' then 'partial_success'
      when ranked.event_name = 'task_cancelled' or ranked.status = 'cancelled' then 'cancelled'
      when ranked.metadata->>'outcome_category' in (
        'plugin_logic_failed', 'provider_service_failed', 'user_config_failed', 'cancelled', 'partial_success'
      ) then ranked.metadata->>'outcome_category'
      when upper(coalesce(ranked.error_code, '')) in (
        'MISSING_API_KEY', 'CONFIG_REQUIRED', 'VALIDATION_ERROR', 'HTTP_401',
        'CUSTOM_PROVIDER_AUTH_REQUIRED', 'CUSTOM_PROVIDER_BASE_URL_REQUIRED'
      ) then 'user_config_failed'
      when upper(coalesce(ranked.error_code, '')) ~ '^(HTTP_|AI_|ASR_|PROVIDER_|NETWORK_|MODEL_|SUMMARY_EMPTY|SEGMENTS_(EMPTY|PARSE|NORMALIZE)|JSON_)'
        or upper(coalesce(ranked.error_code, '')) like '%TIMEOUT%'
        then 'provider_service_failed'
      else 'plugin_logic_failed'
    end as outcome_category
  from (
    select w.*,
      row_number() over (
        partition by coalesce(nullif(w.metadata->>'task_id', ''), w.id::text), w.feature_name
        order by w.created_at desc, w.id desc
      ) as terminal_rank
    from windowed w
    where w.event_name in ('task_success', 'task_partial', 'task_failed', 'task_cancelled')
  ) ranked
  where ranked.terminal_rank = 1
),
task_starts as (
  select feature_name,
    count(distinct coalesce(nullif(metadata->>'task_id', ''), id::text)) as started
  from windowed
  where event_name = 'task_started'
  group by feature_name
),
task_health as (
  select
    coalesce(s.feature_name, t.feature_name) as feature_name,
    coalesce(s.started, 0) as started,
    count(*) filter (where t.event_name = 'task_success') as success,
    count(*) filter (where t.outcome_category = 'partial_success') as partial_success,
    count(*) filter (where t.outcome_category = 'plugin_logic_failed') as plugin_logic_failed,
    count(*) filter (where t.outcome_category = 'provider_service_failed') as provider_service_failed,
    count(*) filter (where t.outcome_category = 'user_config_failed') as user_config_failed,
    count(*) filter (where t.outcome_category = 'cancelled') as cancelled
  from task_starts s
  full join terminal_events t on t.feature_name = s.feature_name
  group by coalesce(s.feature_name, t.feature_name), s.started
),
base as (
  select public.get_usage_dashboard_filters_v1(p_days, p_version, p_feature, p_model) as payload
)
select base.payload || jsonb_build_object(
  'task_health', (select coalesce(jsonb_agg(jsonb_build_object(
    'feature', feature_name,
    'started', started,
    'success', success,
    'partial_success', partial_success,
    'plugin_logic_failed', plugin_logic_failed,
    'provider_service_failed', provider_service_failed,
    'user_config_failed', user_config_failed,
    'cancelled', cancelled,
    'task_failure_rate_percent', round(
      100.0 * (plugin_logic_failed + provider_service_failed + user_config_failed)
      / nullif(success + partial_success + plugin_logic_failed + provider_service_failed + user_config_failed + cancelled, 0),
      1
    )
  ) order by started desc), '[]'::jsonb) from task_health)
)
from base;
$$;

revoke all on function public.get_usage_dashboard_v2(integer) from public, anon, authenticated;
revoke all on function public.get_usage_dashboard_filters_v2(integer, text, text, text) from public, anon, authenticated;
grant execute on function public.get_usage_dashboard_v2(integer) to service_role;
grant execute on function public.get_usage_dashboard_filters_v2(integer, text, text, text) to service_role;
