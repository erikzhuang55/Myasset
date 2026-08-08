create extension if not exists pg_net;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.notify_feedback_wechat()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform net.http_post(
    url := 'https://qdksdauixnbgrgkilgac.supabase.co/functions/v1/notify-feedback-wechat',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFka3NkYXVpeG5iZ3Jna2lsZ2FjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxODkzNjgsImV4cCI6MjA4Nzc2NTM2OH0.njxkv4e0Sjs8MS1jXs8_pE1182dQXOw4qOyHSwygt3M'
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'feedback',
      'schema', 'public',
      'record', to_jsonb(new),
      'old_record', null
    ),
    timeout_milliseconds := 5000
  );

  return new;
end;
$$;

revoke all on function private.notify_feedback_wechat() from public, anon, authenticated;

drop trigger if exists feedback_notify_wechat_on_insert on public.feedback;
create trigger feedback_notify_wechat_on_insert
after insert on public.feedback
for each row
execute function private.notify_feedback_wechat();;
