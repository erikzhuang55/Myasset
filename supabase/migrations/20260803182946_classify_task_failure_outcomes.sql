create schema if not exists private;

create table if not exists private.usage_dashboard_cache (
  cache_key text primary key,
  payload jsonb not null,
  generated_at timestamptz not null default now()
);

create index if not exists usage_dashboard_cache_generated_at_idx
  on private.usage_dashboard_cache (generated_at);

drop function if exists public.get_usage_dashboard_v2(integer);
drop function if exists public.get_usage_dashboard_filters_v2(integer, text, text, text);

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
  v_base_payload jsonb;
  v_filtered_payload jsonb;
  v_outcome_payload jsonb;
  v_payload jsonb;
begin
  v_cache_key := concat_ws('|',
    v_days::text,
    coalesce(v_version, ''),
    coalesce(v_feature, ''),
    coalesce(v_model, '')
  );

  select c.payload, c.generated_at
  into v_cached_payload, v_cached_at
  from private.usage_dashboard_cache c
  where c.cache_key = v_cache_key
    and c.generated_at >= now() - interval '24 hours';

  if v_cached_payload is not null then
    return v_cached_payload || jsonb_build_object(
      'cache_info', jsonb_build_object(
        'hit', true,
        'generated_at', v_cached_at,
        'ttl_hours', 24
      )
    );
  end if;

  v_base_payload := public.get_usage_dashboard_v1(v_days);
  v_filtered_payload := public.get_usage_dashboard_filters_v1(
    v_days,
    coalesce(v_version, ''),
    coalesce(v_feature, ''),
    coalesce(v_model, '')
  );

  with
  params as (
    select coalesce(
      ((select max(created_at) from public.usage_events) at time zone 'Asia/Shanghai')::date,
      (now() at time zone 'Asia/Shanghai')::date
    ) as anchor_date
  ),
  windowed as materialized (
    select e.*
    from public.usage_events e
    cross join params p
    where e.created_at >= ((p.anchor_date - (v_days - 1))::timestamp at time zone 'Asia/Shanghai')
      and e.created_at < ((p.anchor_date + 1)::timestamp at time zone 'Asia/Shanghai')
  ),
  terminal_events as materialized (
    select ranked.*,
      case
        when ranked.event_name = 'task_success' then 'success'
        when ranked.event_name = 'task_partial' then 'partial_success'
        when ranked.event_name = 'task_cancelled' or ranked.status = 'cancelled' then 'cancelled'
        when ranked.metadata->>'outcome_category' in (
          'plugin_logic_failed', 'provider_service_failed', 'user_config_failed',
          'cancelled', 'partial_success'
        ) then ranked.metadata->>'outcome_category'
        when upper(coalesce(ranked.error_code, '')) in (
          'MISSING_API_KEY', 'CONFIG_REQUIRED', 'VALIDATION_ERROR', 'HTTP_401',
          'CUSTOM_PROVIDER_AUTH_REQUIRED', 'CUSTOM_PROVIDER_BASE_URL_REQUIRED'
        ) then 'user_config_failed'
        when upper(coalesce(ranked.error_code, '')) ~
          '^(HTTP_|AI_|ASR_|PROVIDER_|NETWORK_|MODEL_|SUMMARY_EMPTY|SEGMENTS_(EMPTY|PARSE|NORMALIZE)|JSON_)'
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
  filtered_terminal_events as materialized (
    select t.*
    from terminal_events t
    where (v_version is null or t.extension_version = v_version)
      and (v_feature is null or t.feature_name = v_feature)
      and (v_model is null or t.model = v_model)
  ),
  task_starts as (
    select w.feature_name,
      count(distinct coalesce(nullif(w.metadata->>'task_id', ''), w.id::text)) as started
    from windowed w
    where w.event_name = 'task_started'
      and (v_version is null or w.extension_version = v_version)
      and (v_feature is null or w.feature_name = v_feature)
      and (v_model is null or w.model = v_model)
    group by w.feature_name
  ),
  task_health as (
    select
      coalesce(s.feature_name, t.feature_name) as feature_name,
      coalesce(s.started, 0) as started,
      count(*) filter (where t.outcome_category = 'success') as success,
      count(*) filter (where t.outcome_category = 'partial_success') as partial_success,
      count(*) filter (where t.outcome_category = 'plugin_logic_failed') as plugin_logic_failed,
      count(*) filter (where t.outcome_category = 'provider_service_failed') as provider_service_failed,
      count(*) filter (where t.outcome_category = 'user_config_failed') as user_config_failed,
      count(*) filter (where t.outcome_category = 'cancelled') as cancelled
    from task_starts s
    full join filtered_terminal_events t on t.feature_name = s.feature_name
    group by coalesce(s.feature_name, t.feature_name), s.started
  ),
  version_health as (
    select
      t.extension_version,
      count(distinct t.user_hash) as users,
      count(*) filter (where t.outcome_category = 'success') as success,
      count(*) filter (where t.outcome_category = 'partial_success') as partial_success,
      count(*) filter (where t.outcome_category = 'plugin_logic_failed') as plugin_logic_failed,
      count(*) filter (where t.outcome_category = 'provider_service_failed') as provider_service_failed,
      count(*) filter (where t.outcome_category = 'user_config_failed') as user_config_failed,
      count(*) filter (where t.outcome_category = 'cancelled') as cancelled
    from terminal_events t
    where coalesce(t.extension_version, '') <> ''
    group by t.extension_version
  )
  select jsonb_build_object(
    'task_health', (
      select coalesce(jsonb_agg(jsonb_build_object(
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
      ) order by started desc), '[]'::jsonb)
      from task_health
    ),
    'versions', (
      select coalesce(jsonb_agg(jsonb_build_object(
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
      ) order by users desc), '[]'::jsonb)
      from version_health
    )
  )
  into v_outcome_payload;

  v_payload := v_base_payload
    || v_filtered_payload
    || v_outcome_payload;

  insert into private.usage_dashboard_cache (cache_key, payload, generated_at)
  values (v_cache_key, v_payload, now())
  on conflict (cache_key) do update
  set payload = excluded.payload,
      generated_at = excluded.generated_at;

  delete from private.usage_dashboard_cache
  where generated_at < now() - interval '7 days';

  return v_payload || jsonb_build_object(
    'cache_info', jsonb_build_object(
      'hit', false,
      'generated_at', now(),
      'ttl_hours', 24
    )
  );
end;
$$;

revoke all on schema private from public;
revoke all on table private.usage_dashboard_cache from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete on table private.usage_dashboard_cache to service_role;

revoke all on function public.get_usage_dashboard_v2(integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.get_usage_dashboard_v2(integer, text, text, text)
  to service_role;
