create index if not exists usage_events_task_id_created_idx
  on public.usage_events ((metadata->>'task_id'), created_at)
  where metadata ? 'task_id';

create index if not exists usage_events_recovery_created_idx
  on public.usage_events (created_at, event_name)
  where event_name in ('task_attempt_failed', 'task_recovery_finished');

do $migration$
declare
  function_definition text;
begin
  select pg_get_functiondef(
    'public.get_usage_dashboard_v1(integer)'::regprocedure
  ) into function_definition;

  if position('e.extension_version,' in function_definition) = 0 then
    raise exception 'Expected usage dashboard recent-event projection was not found';
  end if;

  function_definition := replace(
    function_definition,
    E'    e.extension_version,\n    e.created_at,',
    E'    e.extension_version,\n    e.provider,\n    e.model,\n    e.duration_ms,\n    e.token_count,\n    e.metadata,\n    e.created_at,'
  );

  if position(E')\nselect jsonb_build_object(' in function_definition) = 0 then
    raise exception 'Expected usage dashboard final select marker was not found';
  end if;

  function_definition := replace(
    function_definition,
    E')\nselect jsonb_build_object(',
    E'),\n'
    || E'task_attempt_failures as (\n'
    || E'  select\n'
    || E'    nullif(metadata->>''task_id'', '''') as task_id,\n'
    || E'    min(created_at) as initial_failed_at\n'
    || E'  from windowed\n'
    || E'  where event_name = ''task_attempt_failed''\n'
    || E'    and nullif(metadata->>''task_id'', '''') is not null\n'
    || E'  group by nullif(metadata->>''task_id'', '''')\n'
    || E'),\n'
    || E'recovery_events as (\n'
    || E'  select\n'
    || E'    nullif(metadata->>''task_id'', '''') as task_id,\n'
    || E'    feature_name,\n'
    || E'    provider,\n'
    || E'    model,\n'
    || E'    status,\n'
    || E'    coalesce(nullif(metadata->>''strategy'', ''''), ''unknown'') as strategy,\n'
    || E'    duration_ms,\n'
    || E'    token_count\n'
    || E'  from windowed\n'
    || E'  where event_name = ''task_recovery_finished''\n'
    || E'    and nullif(metadata->>''task_id'', '''') is not null\n'
    || E'),\n'
    || E'recovered_tasks as (\n'
    || E'  select distinct task_id\n'
    || E'  from recovery_events\n'
    || E'  where status = ''success''\n'
    || E'),\n'
    || E'retry_overview as (\n'
    || E'  select\n'
    || E'    (select count(*) from task_attempt_failures) as initial_failed_tasks,\n'
    || E'    (select count(*) from recovery_events) as recovery_attempts,\n'
    || E'    (select count(*) from recovery_events where status = ''success'') as recovery_successes,\n'
    || E'    (select count(*) from recovered_tasks) as recovered_tasks\n'
    || E'),\n'
    || E'recovery_strategies as (\n'
    || E'  select\n'
    || E'    strategy,\n'
    || E'    count(*) as attempts,\n'
    || E'    count(*) filter (where status = ''success'') as successes,\n'
    || E'    round(avg(duration_ms) filter (where duration_ms is not null)) as avg_duration_ms,\n'
    || E'    round(percentile_cont(0.5) within group (order by duration_ms) filter (where duration_ms is not null)) as p50_duration_ms,\n'
    || E'    round(percentile_cont(0.95) within group (order by duration_ms) filter (where duration_ms is not null)) as p95_duration_ms,\n'
    || E'    round(avg(token_count) filter (where token_count is not null)) as avg_token_count\n'
    || E'  from recovery_events\n'
    || E'  group by strategy\n'
    || E'),\n'
    || E'model_performance as (\n'
    || E'  select\n'
    || E'    feature_name,\n'
    || E'    provider,\n'
    || E'    model,\n'
    || E'    count(*) as terminal_tasks,\n'
    || E'    count(*) filter (where event_name = ''task_success'') as successful_tasks,\n'
    || E'    count(*) filter (where event_name in (''task_failed'', ''task_cancelled'')) as failed_tasks,\n'
    || E'    round(avg(duration_ms) filter (where event_name = ''task_success'' and duration_ms is not null)) as avg_duration_ms,\n'
    || E'    round(percentile_cont(0.5) within group (order by duration_ms) filter (where event_name = ''task_success'' and duration_ms is not null)) as p50_duration_ms,\n'
    || E'    round(percentile_cont(0.95) within group (order by duration_ms) filter (where event_name = ''task_success'' and duration_ms is not null)) as p95_duration_ms,\n'
    || E'    round(avg(token_count) filter (where event_name = ''task_success'' and token_count is not null)) as avg_token_count\n'
    || E'  from windowed\n'
    || E'  where event_name in (''task_success'', ''task_partial'', ''task_failed'', ''task_cancelled'')\n'
    || E'    and nullif(provider, '''') is not null\n'
    || E'    and nullif(model, '''') is not null\n'
    || E'  group by feature_name, provider, model\n'
    || E')\n'
    || E'select jsonb_build_object('
  );

  if position(E'  ''trend'', (select' in function_definition) = 0 then
    raise exception 'Expected usage dashboard trend output marker was not found';
  end if;

  function_definition := replace(
    function_definition,
    E'  ''trend'', (select',
    E'  ''retry_overview'', (select jsonb_build_object(\n'
    || E'    ''initial_failed_tasks'', initial_failed_tasks,\n'
    || E'    ''recovery_attempts'', recovery_attempts,\n'
    || E'    ''recovery_successes'', recovery_successes,\n'
    || E'    ''recovered_tasks'', recovered_tasks,\n'
    || E'    ''unrecovered_tasks'', greatest(initial_failed_tasks - recovered_tasks, 0),\n'
    || E'    ''recovery_rate_percent'', round(100.0 * recovered_tasks / nullif(initial_failed_tasks, 0), 1)\n'
    || E'  ) from retry_overview),\n'
    || E'  ''retry_strategies'', (select coalesce(jsonb_agg(jsonb_build_object(\n'
    || E'    ''strategy'', strategy,\n'
    || E'    ''attempts'', attempts,\n'
    || E'    ''share_percent'', round(100.0 * attempts / nullif((select sum(attempts) from recovery_strategies), 0), 1),\n'
    || E'    ''successes'', successes,\n'
    || E'    ''success_rate_percent'', round(100.0 * successes / nullif(attempts, 0), 1),\n'
    || E'    ''avg_duration_ms'', avg_duration_ms,\n'
    || E'    ''p50_duration_ms'', p50_duration_ms,\n'
    || E'    ''p95_duration_ms'', p95_duration_ms,\n'
    || E'    ''avg_token_count'', avg_token_count\n'
    || E'  ) order by attempts desc), ''[]''::jsonb) from recovery_strategies),\n'
    || E'  ''model_performance'', (select coalesce(jsonb_agg(jsonb_build_object(\n'
    || E'    ''feature_name'', feature_name,\n'
    || E'    ''provider'', provider,\n'
    || E'    ''model'', model,\n'
    || E'    ''terminal_tasks'', terminal_tasks,\n'
    || E'    ''successful_tasks'', successful_tasks,\n'
    || E'    ''failed_tasks'', failed_tasks,\n'
    || E'    ''success_rate_percent'', round(100.0 * successful_tasks / nullif(terminal_tasks, 0), 1),\n'
    || E'    ''avg_duration_ms'', avg_duration_ms,\n'
    || E'    ''p50_duration_ms'', p50_duration_ms,\n'
    || E'    ''p95_duration_ms'', p95_duration_ms,\n'
    || E'    ''avg_token_count'', avg_token_count\n'
    || E'  ) order by terminal_tasks desc), ''[]''::jsonb) from (\n'
    || E'    select * from model_performance order by terminal_tasks desc limit 50\n'
    || E'  ) ranked_models),\n'
    || E'  ''trend'', (select'
  );

  execute function_definition;
end;
$migration$;

revoke all on function public.get_usage_dashboard_v1(integer) from public;
revoke all on function public.get_usage_dashboard_v1(integer) from anon;
revoke all on function public.get_usage_dashboard_v1(integer) from authenticated;
grant execute on function public.get_usage_dashboard_v1(integer) to service_role;
