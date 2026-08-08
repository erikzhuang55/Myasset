create index if not exists usage_events_funnel_user_created_idx
  on public.usage_events (user_hash, event_name, feature_name, created_at)
  include (extension_version)
  where event_name in ('panel_opened', 'task_started', 'task_success');

do $migration$
declare
  function_definition text;
  old_funnel text := $old$funnel_panel as (
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
),$old$;
  new_funnel text := $new$funnel_panel as (
  select s.user_hash, e.occurred_at
  from funnel_extension s
  cross join params p
  cross join lateral (
    select u.created_at as occurred_at
    from public.usage_events u
    where u.user_hash = s.user_hash
      and u.event_name = 'panel_opened'
      and lower(u.feature_name) = 'summary'
      and u.created_at >= s.occurred_at
      and u.created_at < ((p.anchor_date + 1)::timestamp at time zone 'Asia/Shanghai')
      and (p.version_filter is null or u.extension_version = p.version_filter)
    order by u.created_at
    limit 1
  ) e
),
funnel_started as (
  select s.user_hash, e.occurred_at
  from funnel_panel s
  cross join params p
  cross join lateral (
    select u.created_at as occurred_at
    from public.usage_events u
    where u.user_hash = s.user_hash
      and u.event_name = 'task_started'
      and u.feature_name = 'summary_segments_merged'
      and u.created_at >= s.occurred_at
      and u.created_at < ((p.anchor_date + 1)::timestamp at time zone 'Asia/Shanghai')
      and (p.version_filter is null or u.extension_version = p.version_filter)
    order by u.created_at
    limit 1
  ) e
),
funnel_success as (
  select s.user_hash, e.occurred_at
  from funnel_started s
  cross join params p
  cross join lateral (
    select u.created_at as occurred_at
    from public.usage_events u
    where u.user_hash = s.user_hash
      and u.event_name = 'task_success'
      and u.feature_name = 'summary_segments_merged'
      and u.created_at >= s.occurred_at
      and u.created_at < ((p.anchor_date + 1)::timestamp at time zone 'Asia/Shanghai')
      and (p.version_filter is null or u.extension_version = p.version_filter)
    order by u.created_at
    limit 1
  ) e
),$new$;
begin
  select pg_get_functiondef(
    'public.get_usage_dashboard_filters_v1(integer,text,text,text)'::regprocedure
  ) into function_definition;

  if position(old_funnel in function_definition) = 0 then
    raise exception 'Expected dashboard funnel block was not found';
  end if;

  execute replace(function_definition, old_funnel, new_funnel);
end;
$migration$;

revoke all on function public.get_usage_dashboard_filters_v1(integer, text, text, text) from public;
revoke all on function public.get_usage_dashboard_filters_v1(integer, text, text, text) from anon;
revoke all on function public.get_usage_dashboard_filters_v1(integer, text, text, text) from authenticated;
grant execute on function public.get_usage_dashboard_filters_v1(integer, text, text, text) to service_role;

;
