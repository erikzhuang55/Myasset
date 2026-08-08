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
set search_path = public, extensions
as $$
declare
    normalized_user text := nullif(trim(coalesce(u_id, '')), '');
    normalized_date date := (now() at time zone 'Asia/Shanghai')::date;
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
        normalized_date,
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
            normalized_date,
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
            where stat_date = normalized_date
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

notify pgrst, 'reload schema';;
