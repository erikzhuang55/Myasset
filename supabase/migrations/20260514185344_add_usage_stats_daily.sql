create table if not exists public.usage_stats_daily (
  stat_date date not null,
  feature_name text not null,
  status text not null default 'success',
  error_code text not null default '',
  provider text not null default '',
  model text not null default '',
  extension_version text not null default '',
  usage_count bigint not null default 0,
  total_tokens bigint not null default 0,
  total_duration_ms bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (stat_date, feature_name, status, error_code, provider, model, extension_version)
);

alter table public.usage_stats_daily enable row level security;

drop policy if exists "Allow public read usage_stats_daily" on public.usage_stats_daily;
create policy "Allow public read usage_stats_daily"
  on public.usage_stats_daily
  for select
  using (true);

create index if not exists idx_usage_stats_daily_date
  on public.usage_stats_daily (stat_date desc);

create index if not exists idx_usage_stats_daily_feature_date
  on public.usage_stats_daily (feature_name, stat_date desc);

create or replace function public.increment_feature_usage_daily(
  f_name text,
  f_status text default 'success',
  e_code text default '',
  p_provider text default '',
  p_model text default '',
  ext_version text default '',
  t_count integer default 0,
  d_ms integer default 0
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.usage_stats_daily (
    stat_date,
    feature_name,
    status,
    error_code,
    provider,
    model,
    extension_version,
    usage_count,
    total_tokens,
    total_duration_ms,
    updated_at
  ) values (
    current_date,
    nullif(trim(f_name), ''),
    coalesce(nullif(trim(f_status), ''), 'success'),
    coalesce(nullif(trim(e_code), ''), ''),
    coalesce(nullif(trim(p_provider), ''), ''),
    coalesce(nullif(trim(p_model), ''), ''),
    coalesce(nullif(trim(ext_version), ''), ''),
    1,
    greatest(coalesce(t_count, 0), 0),
    greatest(coalesce(d_ms, 0), 0),
    now()
  )
  on conflict (stat_date, feature_name, status, error_code, provider, model, extension_version)
  do update set
    usage_count = public.usage_stats_daily.usage_count + 1,
    total_tokens = public.usage_stats_daily.total_tokens + greatest(coalesce(excluded.total_tokens, 0), 0),
    total_duration_ms = public.usage_stats_daily.total_duration_ms + greatest(coalesce(excluded.total_duration_ms, 0), 0),
    updated_at = now();
end;
$$;

grant execute on function public.increment_feature_usage_daily(text, text, text, text, text, text, integer, integer) to anon, authenticated;;
