alter function public.refresh_usage_dashboard_v2(integer, text, text, text)
  set statement_timeout = '60s';

comment on function public.refresh_usage_dashboard_v2(integer, text, text, text)
  is 'Recomputes one dashboard cache key with a longer timeout for manual refreshes.';
