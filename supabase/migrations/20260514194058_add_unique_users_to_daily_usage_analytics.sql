create extension if not exists pgcrypto;

alter table public.usage_stats_daily
add column if not exists unique_users bigint not null default 0;

create table if not exists public.usage_daily_unique_users (
    stat_date date not null,
    feature_name text not null,
    status text not null default 'success',
    error_code text not null default '',
    provider text not null default '',
    model text not null default '',
    extension_version text not null default '',
    user_hash text not null,
    first_seen_at timestamp with time zone not null default now(),
    primary key (stat_date, feature_name, status, error_code, provider, model, extension_version, user_hash)
);

alter table public.usage_daily_unique_users enable row level security;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename = 'usage_daily_unique_users'
          and policyname = 'usage_daily_unique_users_select_public'
    ) then
        create policy usage_daily_unique_users_select_public
        on public.usage_daily_unique_users
        for select
        using (true);
    end if;
end $$;

create index if not exists idx_usage_daily_unique_users_date
on public.usage_daily_unique_users(stat_date desc);

create index if not exists idx_usage_daily_unique_users_feature_date
on public.usage_daily_unique_users(feature_name, stat_date desc);

insert into public.usage_daily_unique_users (
    stat_date,
    feature_name,
    status,
    error_code,
    provider,
    model,
    extension_version,
    user_hash,
    first_seen_at
)
select
    created_at::date as stat_date,
    feature_name,
    'success' as status,
    '' as error_code,
    'legacy' as provider,
    '' as model,
    '' as extension_version,
    encode(digest(user_id::text, 'sha256'), 'hex') as user_hash,
    min(created_at) as first_seen_at
from public.usage_logs
where user_id is not null
  and nullif(trim(feature_name), '') is not null
group by created_at::date, feature_name, user_id
on conflict do nothing;

with old_daily as (
    select
        created_at::date as stat_date,
        feature_name,
        count(*)::bigint as usage_count,
        coalesce(sum(coalesce(token_count, 0)), 0)::bigint as total_tokens,
        count(distinct user_id)::bigint as unique_users
    from public.usage_logs
    where nullif(trim(feature_name), '') is not null
    group by created_at::date, feature_name
), existing_daily as (
    select
        stat_date,
        feature_name,
        coalesce(sum(usage_count), 0)::bigint as usage_count,
        coalesce(sum(total_tokens), 0)::bigint as total_tokens
    from public.usage_stats_daily
    where status = 'success'
      and error_code = ''
      and provider <> 'legacy'
    group by stat_date, feature_name
), backfill as (
    select
        old_daily.stat_date,
        old_daily.feature_name,
        greatest(old_daily.usage_count - coalesce(existing_daily.usage_count, 0), 0)::bigint as usage_count,
        greatest(old_daily.total_tokens - coalesce(existing_daily.total_tokens, 0), 0)::bigint as total_tokens,
        old_daily.unique_users
    from old_daily
    left join existing_daily
      on existing_daily.stat_date = old_daily.stat_date
     and existing_daily.feature_name = old_daily.feature_name
)
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
    unique_users,
    updated_at
)
select
    stat_date,
    feature_name,
    'success' as status,
    '' as error_code,
    'legacy' as provider,
    '' as model,
    '' as extension_version,
    usage_count,
    total_tokens,
    0 as total_duration_ms,
    unique_users,
    now() as updated_at
from backfill
where usage_count > 0
on conflict (stat_date, feature_name, status, error_code, provider, model, extension_version)
do update set
    usage_count = excluded.usage_count,
    total_tokens = excluded.total_tokens,
    total_duration_ms = excluded.total_duration_ms,
    unique_users = excluded.unique_users,
    updated_at = now();

update public.usage_stats_daily stats
set unique_users = users.unique_users,
    updated_at = now()
from (
    select
        stat_date,
        feature_name,
        status,
        error_code,
        provider,
        model,
        extension_version,
        count(distinct user_hash)::bigint as unique_users
    from public.usage_daily_unique_users
    group by stat_date, feature_name, status, error_code, provider, model, extension_version
) users
where stats.stat_date = users.stat_date
  and stats.feature_name = users.feature_name
  and stats.status = users.status
  and stats.error_code = users.error_code
  and stats.provider = users.provider
  and stats.model = users.model
  and stats.extension_version = users.extension_version;

create or replace function public.increment_feature_usage_daily(
    f_name text,
    f_status text default 'success',
    e_code text default '',
    p_provider text default '',
    p_model text default '',
    ext_version text default '',
    t_count bigint default 0,
    d_ms bigint default 0,
    u_id text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    normalized_user text := nullif(trim(coalesce(u_id, '')), '');
    hashed_user text;
    inserted_user boolean := false;
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
        unique_users,
        updated_at
    ) values (
        current_date,
        nullif(trim(f_name), ''),
        coalesce(nullif(trim(f_status), ''), 'success'),
        coalesce(e_code, ''),
        coalesce(p_provider, ''),
        coalesce(p_model, ''),
        coalesce(ext_version, ''),
        1,
        greatest(coalesce(t_count, 0), 0),
        greatest(coalesce(d_ms, 0), 0),
        0,
        now()
    )
    on conflict (stat_date, feature_name, status, error_code, provider, model, extension_version)
    do update set
        usage_count = public.usage_stats_daily.usage_count + 1,
        total_tokens = public.usage_stats_daily.total_tokens + greatest(coalesce(t_count, 0), 0),
        total_duration_ms = public.usage_stats_daily.total_duration_ms + greatest(coalesce(d_ms, 0), 0),
        updated_at = now();

    if normalized_user is not null then
        hashed_user := encode(digest(normalized_user, 'sha256'), 'hex');

        insert into public.usage_daily_unique_users (
            stat_date,
            feature_name,
            status,
            error_code,
            provider,
            model,
            extension_version,
            user_hash,
            first_seen_at
        ) values (
            current_date,
            nullif(trim(f_name), ''),
            coalesce(nullif(trim(f_status), ''), 'success'),
            coalesce(e_code, ''),
            coalesce(p_provider, ''),
            coalesce(p_model, ''),
            coalesce(ext_version, ''),
            hashed_user,
            now()
        )
        on conflict do nothing;

        get diagnostics inserted_user = row_count;

        if inserted_user then
            update public.usage_stats_daily
            set unique_users = unique_users + 1,
                updated_at = now()
            where stat_date = current_date
              and feature_name = nullif(trim(f_name), '')
              and status = coalesce(nullif(trim(f_status), ''), 'success')
              and error_code = coalesce(e_code, '')
              and provider = coalesce(p_provider, '')
              and model = coalesce(p_model, '')
              and extension_version = coalesce(ext_version, '');
        end if;
    end if;
end;
$$;

grant execute on function public.increment_feature_usage_daily(text, text, text, text, text, text, bigint, bigint, text) to anon, authenticated;

create or replace view public.feature_analytics as
with usage_totals as (
    select
        feature_name,
        coalesce(sum(usage_count), 0)::bigint as total_clicks,
        coalesce(sum(usage_count) filter (where status = 'success'), 0)::bigint as success_count,
        coalesce(sum(usage_count) filter (where status = 'failed'), 0)::bigint as failed_count,
        coalesce(sum(usage_count) filter (where status = 'timeout'), 0)::bigint as timeout_count,
        coalesce(sum(usage_count) filter (where status = 'cancelled'), 0)::bigint as cancelled_count,
        coalesce(sum(total_tokens), 0)::bigint as total_tokens,
        coalesce(sum(total_duration_ms), 0)::bigint as total_duration_ms,
        max(updated_at) as last_used_at
    from public.usage_stats_daily
    group by feature_name
), unique_totals as (
    select
        feature_name,
        count(distinct user_hash)::bigint as unique_users
    from public.usage_daily_unique_users
    group by feature_name
)
select
    usage_totals.feature_name,
    usage_totals.total_clicks,
    coalesce(unique_totals.unique_users, 0)::bigint as unique_users,
    usage_totals.success_count,
    usage_totals.failed_count,
    usage_totals.timeout_count,
    usage_totals.cancelled_count,
    usage_totals.total_tokens,
    case
        when usage_totals.total_clicks > 0 then round((usage_totals.total_duration_ms::numeric / usage_totals.total_clicks), 2)
        else 0
    end as avg_duration_ms,
    usage_totals.last_used_at
from usage_totals
left join unique_totals using (feature_name);
;
