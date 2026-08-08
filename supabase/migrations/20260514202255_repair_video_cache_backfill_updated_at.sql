alter table public.video_cache disable trigger trg_video_cache_set_updated_at;

update public.video_cache
set updated_at = created_at
where updated_at >= timestamp with time zone '2026-05-14 20:22:00+00'
  and created_at < timestamp with time zone '2026-05-14 20:00:00+00';

alter table public.video_cache enable trigger trg_video_cache_set_updated_at;

notify pgrst, 'reload schema';;
