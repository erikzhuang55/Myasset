create or replace function public.set_feedback_updated_at()
returns trigger
language plpgsql
as $$
begin
  if row(old.id, old.client_id, old.extension_version, old.provider, old.model, old.bvid, old.page, old.type, old.title, old.content, old.logs, old.metadata, old.status, old.reply, old.public_message, old.resolved_at)
     is distinct from
     row(new.id, new.client_id, new.extension_version, new.provider, new.model, new.bvid, new.page, new.type, new.title, new.content, new.logs, new.metadata, new.status, new.reply, new.public_message, new.resolved_at) then
    new.updated_at = now();
  end if;

  if new.status = 'fixed' and old.status is distinct from 'fixed' and new.resolved_at is null then
    new.resolved_at = now();
  end if;
  return new;
end;
$$;;
