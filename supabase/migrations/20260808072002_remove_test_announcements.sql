delete from public.extension_announcements
where announcement_key in (
  'test_release_notice_2026_08',
  'test_service_notice_2026_08'
);
