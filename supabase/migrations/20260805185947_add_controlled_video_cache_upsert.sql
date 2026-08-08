create or replace function public.upsert_video_cache_controlled(p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bvid text := lower(trim(coalesce(p_payload ->> 'bvid', '')));
  v_cid bigint := nullif(p_payload ->> 'cid', '')::bigint;
  v_allowed_keys text[] := array[
    'bvid', 'cid', 'title', 'subtitle_source', 'raw_subtitle', 'processed_subtitle',
    'subtitle_uploaded_at', 'summary', 'summary_model', 'segments', 'segments_model',
    'rumors', 'rumors_model', 'increment_subtitle_upload_count',
    'increment_summary_call_count', 'increment_segments_call_count',
    'increment_rumors_call_count'
  ];
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'INVALID_VIDEO_CACHE_PAYLOAD';
  end if;
  if v_bvid !~ '^bv[a-z0-9]{10}$' or v_cid is null or v_cid <= 0 then
    raise exception 'INVALID_VIDEO_IDENTITY';
  end if;
  if (p_payload - v_allowed_keys) <> '{}'::jsonb then
    raise exception 'UNSUPPORTED_VIDEO_CACHE_FIELDS';
  end if;
  if pg_column_size(p_payload) > 6291456 then raise exception 'VIDEO_CACHE_PAYLOAD_TOO_LARGE'; end if;
  if p_payload ? 'title' and length(coalesce(p_payload ->> 'title', '')) > 500 then raise exception 'VIDEO_CACHE_TITLE_TOO_LONG'; end if;
  if p_payload ? 'summary' and length(coalesce(p_payload ->> 'summary', '')) < 100 then raise exception 'VIDEO_CACHE_SUMMARY_TOO_SHORT'; end if;
  if p_payload ? 'summary' and length(coalesce(p_payload ->> 'summary', '')) > 200000 then raise exception 'VIDEO_CACHE_SUMMARY_TOO_LONG'; end if;
  if p_payload ? 'raw_subtitle' and jsonb_typeof(p_payload -> 'raw_subtitle') <> 'array' then raise exception 'INVALID_RAW_SUBTITLE'; end if;
  if p_payload ? 'processed_subtitle' and jsonb_typeof(p_payload -> 'processed_subtitle') <> 'array' then raise exception 'INVALID_PROCESSED_SUBTITLE'; end if;
  if p_payload ? 'segments' and jsonb_typeof(p_payload -> 'segments') <> 'array' then raise exception 'INVALID_SEGMENTS'; end if;
  if p_payload ? 'raw_subtitle' and jsonb_array_length(p_payload -> 'raw_subtitle') > 20000 then raise exception 'RAW_SUBTITLE_TOO_LARGE'; end if;
  if p_payload ? 'processed_subtitle' and jsonb_array_length(p_payload -> 'processed_subtitle') > 20000 then raise exception 'PROCESSED_SUBTITLE_TOO_LARGE'; end if;
  if p_payload ? 'segments' and jsonb_array_length(p_payload -> 'segments') > 1000 then raise exception 'SEGMENTS_TOO_LARGE'; end if;

  insert into public.video_cache as target (
    bvid, cid, title, subtitle_source, raw_subtitle, processed_subtitle,
    subtitle_upload_count, subtitle_uploaded_at,
    summary, summary_model, summary_call_count,
    segments, segments_model, segments_call_count,
    rumors, rumors_model, rumors_call_count,
    created_at, updated_at
  ) values (
    v_bvid, v_cid,
    case when p_payload ? 'title' then nullif(p_payload ->> 'title', '') else null end,
    case when p_payload ? 'subtitle_source' then p_payload ->> 'subtitle_source' else null end,
    case when p_payload ? 'raw_subtitle' then p_payload -> 'raw_subtitle' else null end,
    case when p_payload ? 'processed_subtitle' then p_payload -> 'processed_subtitle' else null end,
    case when coalesce((p_payload ->> 'increment_subtitle_upload_count')::boolean, false) then 1 else 0 end,
    case when p_payload ? 'subtitle_uploaded_at' then (p_payload ->> 'subtitle_uploaded_at')::timestamptz else null end,
    case when p_payload ? 'summary' then p_payload ->> 'summary' else null end,
    case when p_payload ? 'summary_model' then p_payload ->> 'summary_model' else null end,
    case when coalesce((p_payload ->> 'increment_summary_call_count')::boolean, false) then 1 else 0 end,
    case when p_payload ? 'segments' then p_payload -> 'segments' else null end,
    case when p_payload ? 'segments_model' then p_payload ->> 'segments_model' else null end,
    case when coalesce((p_payload ->> 'increment_segments_call_count')::boolean, false) then 1 else 0 end,
    case when p_payload ? 'rumors' then p_payload ->> 'rumors' else null end,
    case when p_payload ? 'rumors_model' then p_payload ->> 'rumors_model' else null end,
    case when coalesce((p_payload ->> 'increment_rumors_call_count')::boolean, false) then 1 else 0 end,
    now(), now()
  )
  on conflict (bvid, cid) where cid is not null
  do update set
    title = case when p_payload ? 'title' then excluded.title else target.title end,
    subtitle_source = case when p_payload ? 'subtitle_source' then excluded.subtitle_source else target.subtitle_source end,
    raw_subtitle = case when p_payload ? 'raw_subtitle' then excluded.raw_subtitle else target.raw_subtitle end,
    processed_subtitle = case when p_payload ? 'processed_subtitle' then excluded.processed_subtitle else target.processed_subtitle end,
    subtitle_upload_count = coalesce(target.subtitle_upload_count, 0) + case when coalesce((p_payload ->> 'increment_subtitle_upload_count')::boolean, false) then 1 else 0 end,
    subtitle_uploaded_at = case when p_payload ? 'subtitle_uploaded_at' then excluded.subtitle_uploaded_at else target.subtitle_uploaded_at end,
    summary = case when p_payload ? 'summary' then excluded.summary else target.summary end,
    summary_model = case when p_payload ? 'summary_model' then excluded.summary_model else target.summary_model end,
    summary_call_count = coalesce(target.summary_call_count, 0) + case when coalesce((p_payload ->> 'increment_summary_call_count')::boolean, false) then 1 else 0 end,
    segments = case when p_payload ? 'segments' then excluded.segments else target.segments end,
    segments_model = case when p_payload ? 'segments_model' then excluded.segments_model else target.segments_model end,
    segments_call_count = coalesce(target.segments_call_count, 0) + case when coalesce((p_payload ->> 'increment_segments_call_count')::boolean, false) then 1 else 0 end,
    rumors = case when p_payload ? 'rumors' then excluded.rumors else target.rumors end,
    rumors_model = case when p_payload ? 'rumors_model' then excluded.rumors_model else target.rumors_model end,
    rumors_call_count = coalesce(target.rumors_call_count, 0) + case when coalesce((p_payload ->> 'increment_rumors_call_count')::boolean, false) then 1 else 0 end,
    updated_at = now();
end;
$$;

revoke all on function public.upsert_video_cache_controlled(jsonb) from public;
revoke all on function public.upsert_video_cache_controlled(jsonb) from anon;
revoke all on function public.upsert_video_cache_controlled(jsonb) from authenticated;
grant execute on function public.upsert_video_cache_controlled(jsonb) to anon;;
