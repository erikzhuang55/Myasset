create schema if not exists private;
create extension if not exists pg_cron;

alter function public.get_usage_dashboard_v2(integer, text, text, text)
  set schema private;

alter function private.get_usage_dashboard_v2(integer, text, text, text)
  rename to compute_usage_dashboard_v2;

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
  v_cache_key text;
begin
  v_cache_key := concat_ws('|', v_days::text, v_version, v_feature, v_model);

  -- Keep the previous payload readable while the expensive query recomputes.
  update private.usage_dashboard_cache
  set generated_at = least(generated_at, now() - interval '25 hours')
  where cache_key = v_cache_key;

  return private.compute_usage_dashboard_v2(v_days, v_version, v_feature, v_model);
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
  v_is_stale boolean;
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
  where c.cache_key = v_cache_key;

  if v_cached_payload is not null then
    v_is_stale := v_cached_at < now() - interval '24 hours';
    return v_cached_payload || jsonb_build_object(
      'cache_info', jsonb_build_object(
        'hit', true,
        'stale', v_is_stale,
        'generated_at', v_cached_at,
        'ttl_hours', 24
      )
    );
  end if;

  return private.compute_usage_dashboard_v2(
    v_days,
    coalesce(v_version, ''),
    coalesce(v_feature, ''),
    coalesce(v_model, '')
  );
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
    select cache_key
    from private.usage_dashboard_cache
    where generated_at < now() - interval '23 hours'
    order by generated_at
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

  if not exists (select 1 from private.usage_dashboard_cache where cache_key = '30|||') then
    perform private.refresh_usage_dashboard_cache(30, '', '', '');
    v_refreshed := v_refreshed + 1;
  end if;

  return v_refreshed;
end;
$$;

revoke all on function private.compute_usage_dashboard_v2(integer, text, text, text)
  from public, anon, authenticated;
revoke all on function private.refresh_usage_dashboard_cache(integer, text, text, text)
  from public, anon, authenticated;
revoke all on function private.refresh_usage_dashboard_cache_all()
  from public, anon, authenticated;

revoke all on function public.get_usage_dashboard_v2(integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.get_usage_dashboard_v2(integer, text, text, text)
  to service_role;

do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'extension_remote_config'
  ) then
    alter publication supabase_realtime drop table public.extension_remote_config;
  end if;
end;
$$;

do $$
declare
  v_job_id bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    for v_job_id in
      select jobid from cron.job where jobname = 'bilitato-dashboard-cache-refresh'
    loop
      perform cron.unschedule(v_job_id);
    end loop;

    perform cron.schedule(
      'bilitato-dashboard-cache-refresh',
      '17 * * * *',
      $schedule$select private.refresh_usage_dashboard_cache_all();$schedule$
    );
  end if;
end;
$$;
