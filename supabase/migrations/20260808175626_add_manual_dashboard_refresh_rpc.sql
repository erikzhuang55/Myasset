create or replace function public.refresh_usage_dashboard_v2(
  p_days integer default 30,
  p_version text default '',
  p_feature text default '',
  p_model text default ''
)
returns jsonb
language sql
volatile
security invoker
set search_path = public, private, pg_temp
as $$
  select private.refresh_usage_dashboard_cache(
    greatest(7, least(coalesce(p_days, 30), 90)),
    btrim(coalesce(p_version, '')),
    btrim(coalesce(p_feature, '')),
    btrim(coalesce(p_model, ''))
  );
$$;

revoke all on function public.refresh_usage_dashboard_v2(integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.refresh_usage_dashboard_v2(integer, text, text, text)
  to service_role;

comment on function public.refresh_usage_dashboard_v2(integer, text, text, text)
  is 'Recomputes one dashboard cache key for the private analytics site.';
