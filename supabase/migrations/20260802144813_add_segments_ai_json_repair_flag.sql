update public.extension_remote_config
set payload = jsonb_set(
  payload,
  '{feature_flags,segments_ai_json_repair}',
  'true'::jsonb,
  true
)
where config_key = 'production';
