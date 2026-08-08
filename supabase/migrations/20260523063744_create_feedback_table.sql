create extension if not exists pgcrypto with schema extensions;

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  extension_version text,
  provider text,
  model text,
  bvid text,
  page text,
  type text not null default 'bug' check (type in ('bug', 'suggestion', 'question')),
  title text not null,
  content text not null,
  logs jsonb,
  metadata jsonb,
  status text not null default 'open' check (status in ('open', 'investigating', 'fixed', 'need_more_info', 'rejected')),
  reply text,
  public_message text,
  seen_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint feedback_client_id_len check (char_length(client_id) between 16 and 80),
  constraint feedback_title_len check (char_length(title) between 1 and 120),
  constraint feedback_content_len check (char_length(content) between 1 and 3000)
);

create index if not exists feedback_client_updated_idx on public.feedback (client_id, updated_at desc);
create index if not exists feedback_status_updated_idx on public.feedback (status, updated_at desc);

create or replace function public.set_feedback_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  if new.status = 'fixed' and old.status is distinct from 'fixed' and new.resolved_at is null then
    new.resolved_at = now();
  end if;
  return new;
end;
$$;

drop trigger if exists feedback_set_updated_at on public.feedback;
create trigger feedback_set_updated_at
before update on public.feedback
for each row execute function public.set_feedback_updated_at();

alter table public.feedback enable row level security;

revoke all on table public.feedback from anon, authenticated;
grant select, insert on table public.feedback to anon, authenticated;
grant update (seen_at) on table public.feedback to anon, authenticated;

drop policy if exists "feedback_insert_own_client" on public.feedback;
create policy "feedback_insert_own_client"
on public.feedback
for insert
to anon, authenticated
with check (
  client_id = coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-feedback-client-id'
  and char_length(client_id) between 16 and 80
  and char_length(title) between 1 and 120
  and char_length(content) between 1 and 3000
);

drop policy if exists "feedback_select_own_client" on public.feedback;
create policy "feedback_select_own_client"
on public.feedback
for select
to anon, authenticated
using (
  client_id = coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-feedback-client-id'
);

drop policy if exists "feedback_mark_own_seen" on public.feedback;
create policy "feedback_mark_own_seen"
on public.feedback
for update
to anon, authenticated
using (
  client_id = coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-feedback-client-id'
)
with check (
  client_id = coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-feedback-client-id'
);
;
