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

do $$
declare
  v_job_id bigint;
begin
  for v_job_id in
    select jobid from cron.job where jobname = 'bilitato-dashboard-cache-refresh'
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'bilitato-dashboard-cache-refresh',
    '0 4 * * *',
    $schedule$select private.refresh_usage_dashboard_cache_all();$schedule$
  );
end;
$$;

;
