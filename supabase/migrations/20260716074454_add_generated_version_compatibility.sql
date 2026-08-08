alter table public.extension_versions
add column if not exists version text
generated always as (latest_version) stored;

insert into public.extension_versions (id, latest_version, enabled, updated_at)
values ('bilitato', '1.5.0', true, now())
on conflict (id) do update
set latest_version = excluded.latest_version,
    updated_at = now();;
