do $migration$
declare
  function_definition text;
  old_recovered_tasks text := E'recovered_tasks as (\n  select distinct f.task_id\n  from task_attempt_failures f\n  join windowed terminal\n    on nullif(terminal.metadata->>''task_id'', '''') = f.task_id\n   and terminal.created_at >= f.initial_failed_at\n   and terminal.event_name in (''task_success'', ''task_partial'')\n),';
  new_recovered_tasks text := E'recovered_tasks as (\n  select distinct task_id\n  from recovery_events\n  where status = ''success''\n),';
begin
  select pg_get_functiondef(
    'public.get_usage_dashboard_v1(integer)'::regprocedure
  ) into function_definition;

  if position(old_recovered_tasks in function_definition) = 0 then
    raise exception 'Expected recovered_tasks dashboard CTE was not found';
  end if;

  execute replace(function_definition, old_recovered_tasks, new_recovered_tasks);
end;
$migration$;

revoke all on function public.get_usage_dashboard_v1(integer) from public;
revoke all on function public.get_usage_dashboard_v1(integer) from anon;
revoke all on function public.get_usage_dashboard_v1(integer) from authenticated;
grant execute on function public.get_usage_dashboard_v1(integer) to service_role;

;
