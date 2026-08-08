do $migration$
declare
  function_definition text;
  previous_funnel text := $previous$
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
$previous$;
  optimized_funnel text := $optimized$
funnel_extension as materialized (
  select e.user_hash, min(e.created_at) as occurred_at
  from public.usage_events e
  cross join params p
  where e.created_at >= (
      (p.anchor_date - (p.days - 1))::timestamp
      at time zone 'Asia/Shanghai'
    )
    and e.created_at < (
      (p.anchor_date + 1)::timestamp
      at time zone 'Asia/Shanghai'
    )
    and e.event_name = 'extension_started'
  group by e.user_hash
),
funnel_panel as materialized (
  select s.user_hash, next_event.occurred_at
  from funnel_extension s
  cross join params p
  cross join lateral (
    select min(e.created_at) as occurred_at
    from public.usage_events e
    where e.user_hash = s.user_hash
      and e.created_at >= s.occurred_at
      and e.created_at < (
        (p.anchor_date + 1)::timestamp
        at time zone 'Asia/Shanghai'
      )
      and e.event_name = 'panel_opened'
      and lower(e.feature_name) = 'summary'
  ) next_event
  where next_event.occurred_at is not null
),
funnel_started as materialized (
  select s.user_hash, next_event.occurred_at
  from funnel_panel s
  cross join params p
  cross join lateral (
    select min(e.created_at) as occurred_at
    from public.usage_events e
    where e.user_hash = s.user_hash
      and e.created_at >= s.occurred_at
      and e.created_at < (
        (p.anchor_date + 1)::timestamp
        at time zone 'Asia/Shanghai'
      )
      and e.event_name = 'task_started'
      and e.feature_name = 'summary_segments_merged'
  ) next_event
  where next_event.occurred_at is not null
),
funnel_success as materialized (
  select s.user_hash, next_event.occurred_at
  from funnel_started s
  cross join params p
  cross join lateral (
    select min(e.created_at) as occurred_at
    from public.usage_events e
    where e.user_hash = s.user_hash
      and e.created_at >= s.occurred_at
      and e.created_at < (
        (p.anchor_date + 1)::timestamp
        at time zone 'Asia/Shanghai'
      )
      and e.event_name = 'task_success'
      and e.feature_name = 'summary_segments_merged'
  ) next_event
  where next_event.occurred_at is not null
),
$optimized$;
begin
  select pg_get_functiondef(
    'public.get_usage_dashboard_v1(integer)'::regprocedure
  )
  into function_definition;

  if position(previous_funnel in function_definition) = 0 then
    raise exception 'Expected usage dashboard funnel definition was not found';
  end if;

  execute replace(function_definition, previous_funnel, optimized_funnel);
end;
$migration$;


;
