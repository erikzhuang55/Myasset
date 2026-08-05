begin;

drop policy if exists "Allow public update video_cache" on public.video_cache;
drop policy if exists "Allow update only after 24 hours" on public.video_cache;
drop policy if exists video_cache_update_simple on public.video_cache;

commit;
