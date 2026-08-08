create table if not exists public.extension_announcements (
  announcement_key text primary key,
  title text not null check (char_length(title) between 1 and 120),
  summary text not null default '' check (char_length(summary) <= 240),
  content text not null check (char_length(content) between 1 and 5000),
  link_url text not null default '' check (link_url = '' or link_url ~ '^https://'),
  link_label text not null default '' check (char_length(link_label) <= 60),
  show_banner boolean not null default true,
  is_published boolean not null default false,
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint extension_announcements_key_format
    check (announcement_key ~ '^[a-z0-9][a-z0-9_-]{0,79}$')
);

alter table public.extension_announcements enable row level security;

revoke all on table public.extension_announcements from public;
revoke all on table public.extension_announcements from anon;
revoke all on table public.extension_announcements from authenticated;
grant select on table public.extension_announcements to anon, authenticated;
grant select, insert, update, delete on table public.extension_announcements to service_role;

drop policy if exists extension_announcements_public_read on public.extension_announcements;
create policy extension_announcements_public_read
  on public.extension_announcements
  for select
  to anon, authenticated
  using (is_published = true);

create or replace function public.touch_extension_announcement_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.touch_extension_announcement_updated_at() from public;
revoke all on function public.touch_extension_announcement_updated_at() from anon;
revoke all on function public.touch_extension_announcement_updated_at() from authenticated;

drop trigger if exists extension_announcements_touch_updated_at on public.extension_announcements;
create trigger extension_announcements_touch_updated_at
before update on public.extension_announcements
for each row execute function public.touch_extension_announcement_updated_at();

create index if not exists extension_announcements_published_at_idx
  on public.extension_announcements (published_at desc)
  where is_published = true;

insert into public.extension_announcements (
  announcement_key,
  title,
  summary,
  content,
  link_url,
  link_label,
  show_banner,
  is_published,
  published_at
)
values (
  'modelscope_magicube_2026_08',
  'ModelScope 免费额度机制更新',
  'ModelScope 免费额度机制更新，点击查看',
  'modelscope目前更新了调用机制，取消了每天自动刷新的调用额度，而是改为魔粒兑换免费额度，每日登录赠送200魔粒（约等于200次调用），如您频繁出现额度不足的提示，请登录 ModelScope 个人中心即可刷新每日免费调用额度，祝调用愉快！',
  'https://modelscope.cn/my/overview',
  '前往 ModelScope',
  true,
  true,
  '2026-08-08 00:00:00+08'
)
on conflict (announcement_key) do nothing;

insert into public.extension_announcements (
  announcement_key,
  title,
  summary,
  content,
  link_url,
  link_label,
  show_banner,
  is_published,
  published_at
)
values
  (
    'test_release_notice_2026_08',
    '测试公告：版本功能预告',
    '用于检查公告中心的短内容与链接样式',
    '这是一条测试公告，用来确认公告标题、发布日期、正文和外部链接可以正常显示。',
    'https://github.com/erikzhuang55/Bilitato',
    '查看项目主页',
    false,
    true,
    '2026-08-07 18:00:00+08'
  ),
  (
    'test_service_notice_2026_08',
    '测试公告：服务状态说明',
    '用于检查较长文本在公告中心内的换行效果',
    '这是一条不带跳转链接的测试公告。公告中心会保留已经发布的历史通知，即使该公告不再显示在插件标题栏下方，用户仍然可以从设置页的“查看公告”入口找到它。',
    '',
    '',
    false,
    true,
    '2026-08-06 12:00:00+08'
  )
on conflict (announcement_key) do nothing;
