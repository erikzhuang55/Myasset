drop index if exists public.usage_events_extension_version_created_idx;

create index usage_events_version_activity_idx
  on public.usage_events (extension_version, created_at desc)
  include (user_hash, event_name, status)
  where extension_version <> '';

create or replace function private.compute_usage_dashboard_activity_v1(
  p_days integer default 30,
  p_version text default ''
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_days integer := greatest(7, least(coalesce(p_days, 30), 90));
  v_version text := nullif(btrim(coalesce(p_version, '')), '');
  v_payload jsonb;
begin
  if v_version is null then
    return '{}'::jsonb;
  end if;

  with
  params as (
    select coalesce(
      ((select max(created_at) from public.usage_events) at time zone 'Asia/Shanghai')::date,
      (now() at time zone 'Asia/Shanghai')::date
    ) as anchor_date
  ),
  recent as materialized (
    select
      e.user_hash,
      e.event_name,
      e.status,
      e.created_at,
      (e.created_at at time zone 'Asia/Shanghai')::date as local_date
    from public.usage_events e
    cross join params p
    where e.extension_version = v_version
      and e.created_at >= (
        (p.anchor_date - (greatest(v_days, 30) - 1))::timestamp
        at time zone 'Asia/Shanghai'
      )
      and e.created_at < (
        (p.anchor_date + 1)::timestamp at time zone 'Asia/Shanghai'
      )
  ),
  windowed as materialized (
    select r.*
    from recent r
    cross join params p
    where r.local_date between p.anchor_date - (v_days - 1) and p.anchor_date
  ),
  kpis as (
    select
      count(distinct r.user_hash) filter (
        where r.local_date = p.anchor_date
      ) as dau,
      count(distinct r.user_hash) filter (
        where r.local_date between p.anchor_date - 6 and p.anchor_date
      ) as wau,
      count(distinct r.user_hash) filter (
        where r.local_date between p.anchor_date - 29 and p.anchor_date
      ) as mau
    from params p
    left join recent r
      on r.local_date between p.anchor_date - 29 and p.anchor_date
  ),
  calendar as (
    select generate_series(
      (select anchor_date - (v_days - 1) from params),
      (select anchor_date from params),
      interval '1 day'
    )::date as stat_date
  ),
  daily as (
    select
      c.stat_date,
      count(distinct w.user_hash) as dau,
      count(*) filter (where w.event_name = 'task_started') as task_volume,
      count(*) filter (where w.event_name = 'task_success') as task_success,
      count(*) filter (
        where w.event_name in (
          'task_success', 'task_partial', 'task_failed', 'task_cancelled', 'task_blocked'
        )
      ) as task_terminal
    from calendar c
    left join windowed w on w.local_date = c.stat_date
    group by c.stat_date
  )
  select jsonb_build_object(
    'overview', (
      select jsonb_build_object(
        'dau', k.dau,
        'wau', k.wau,
        'mau', k.mau,
        'wau_mau_percent', round(100.0 * k.wau / nullif(k.mau, 0), 1)
      )
      from kpis k
    ),
    'trend', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'date', stat_date,
        'dau', dau,
        'task_volume', task_volume,
        'task_success_rate_percent', round(
          100.0 * task_success / nullif(task_terminal, 0),
          1
        )
      ) order by stat_date), '[]'::jsonb)
      from daily
    )
  )
  into v_payload;

  return v_payload;
end;
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
  v_base_payload jsonb;
  v_activity_payload jsonb;
  v_payload jsonb;
begin
  update private.usage_dashboard_cache
  set generated_at = least(generated_at, now() - interval '25 hours')
  where cache_key = v_cache_key;

  v_base_payload := private.compute_usage_dashboard_v2(v_days, v_version, v_feature, v_model);
  v_activity_payload := private.compute_usage_dashboard_activity_v1(v_days, v_version);

  if v_activity_payload <> '{}'::jsonb then
    v_base_payload := jsonb_set(
      v_base_payload,
      '{overview}',
      coalesce(v_base_payload->'overview', '{}'::jsonb)
        || coalesce(v_activity_payload->'overview', '{}'::jsonb),
      true
    ) || (v_activity_payload - 'overview');
  end if;

  v_payload := v_base_payload
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

revoke all on function private.compute_usage_dashboard_activity_v1(integer, text)
  from public, anon, authenticated;
grant execute on function private.compute_usage_dashboard_activity_v1(integer, text)
  to service_role;

revoke all on function private.refresh_usage_dashboard_cache(integer, text, text, text)
  from public, anon, authenticated;
grant execute on function private.refresh_usage_dashboard_cache(integer, text, text, text)
  to service_role;

delete from private.usage_dashboard_cache
where split_part(cache_key, '|', 2) <> '';
