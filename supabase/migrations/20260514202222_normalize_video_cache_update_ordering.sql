create or replace function public.set_video_cache_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_video_cache_set_updated_at on public.video_cache;

create trigger trg_video_cache_set_updated_at
before insert or update on public.video_cache
for each row
execute function public.set_video_cache_updated_at();

update public.video_cache
set updated_at = created_at
where updated_at < created_at;

create index if not exists idx_video_cache_updated_at_desc
on public.video_cache(updated_at desc);

create index if not exists idx_video_cache_created_at_desc
on public.video_cache(created_at desc);

create or replace view public.video_cache_recent as
select
    bvid,
    title,
    created_at,
    updated_at,
    subtitle_uploaded_at,
    subtitle_source,
    summary_model,
    segments_model,
    rumors_model,
    summary_call_count,
    segments_call_count,
    rumors_call_count,
    subtitle_upload_count,
    (summary is not null) as has_summary,
    (segments is not null) as has_segments,
    (rumors is not null) as has_rumors,
    (raw_subtitle is not null or processed_subtitle is not null) as has_subtitle
from public.video_cache
order by updated_at desc nulls last, created_at desc nulls last;

grant select on public.video_cache_recent to anon, authenticated;

notify pgrst, 'reload schema';;
