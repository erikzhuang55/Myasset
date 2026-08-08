do $migration$
declare
  v_definition text;
  v_original text;
begin
  select pg_get_functiondef(
    'private.compute_usage_dashboard_task_metrics_v3(integer,text,text,text)'::regprocedure
  ) into v_definition;
  v_original := v_definition;

  v_definition := replace(
    v_definition,
    'coalesce(nullif(w.metadata->>''task_id'', ''''), w.id::text) as task_key',
    'nullif(w.metadata->>''task_id'', '''') as task_key'
  );
  v_definition := replace(
    v_definition,
    'partition by coalesce(nullif(w.metadata->>''task_id'', ''''), w.id::text), w.feature_name',
    'partition by nullif(w.metadata->>''task_id'', ''''), w.feature_name'
  );
  v_definition := replace(
    v_definition,
    E'  where w.event_name in (''task_success'', ''task_partial'', ''task_failed'', ''task_cancelled'')\n),\nterminal_events',
    E'  where w.event_name in (''task_success'', ''task_partial'', ''task_failed'', ''task_cancelled'')\n    and nullif(w.metadata->>''task_id'', '''') is not null\n),\nterminal_events'
  );

  if v_definition = v_original
    or position('coalesce(nullif(w.metadata->>''task_id'', ''''), w.id::text) as task_key' in v_definition) > 0
    or position(E'and nullif(w.metadata->>''task_id'', '''') is not null\n),\nterminal_events' in v_definition) = 0
  then
    raise exception 'Expected task metric function markers were not found';
  end if;

  execute v_definition;
end;
$migration$;
delete from private.usage_dashboard_cache;
