create table if not exists public.extension_remote_config (
  config_key text primary key,
  revision bigint not null default 1 check (revision > 0),
  enabled boolean not null default true,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  updated_at timestamptz not null default now(),
  constraint extension_remote_config_key_format
    check (config_key ~ '^[a-z0-9][a-z0-9_-]{0,79}$')
);

alter table public.extension_remote_config enable row level security;

revoke all on table public.extension_remote_config from public;
revoke all on table public.extension_remote_config from anon;
revoke all on table public.extension_remote_config from authenticated;
grant select on table public.extension_remote_config to anon, authenticated;
grant select, insert, update, delete on table public.extension_remote_config to service_role;

drop policy if exists extension_remote_config_public_read on public.extension_remote_config;
create policy extension_remote_config_public_read
  on public.extension_remote_config
  for select
  to anon, authenticated
  using (enabled = true);

create or replace function public.bump_extension_remote_config_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.revision := old.revision + 1;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.bump_extension_remote_config_revision() from public;
revoke all on function public.bump_extension_remote_config_revision() from anon;
revoke all on function public.bump_extension_remote_config_revision() from authenticated;

drop trigger if exists extension_remote_config_bump_revision on public.extension_remote_config;
create trigger extension_remote_config_bump_revision
before update on public.extension_remote_config
for each row execute function public.bump_extension_remote_config_revision();

insert into public.extension_remote_config (config_key, payload)
values (
  'production',
  $config$
  {
    "feature_flags": {
      "summary_empty_retry": true,
      "segments_local_json_repair": true,
      "segments_ai_json_repair": true,
      "segments_primary_retry": true,
      "segments_compact_retry": true,
      "segments_expanded_tokens_retry": true
    },
    "providers": {
      "modelscope": {
        "enabled": true,
        "name": "ModelScope (魔搭)",
        "base_url": "https://api-inference.modelscope.cn/v1/",
        "default_model": "deepseek-ai/DeepSeek-V4-Flash",
        "models": ["deepseek-ai/DeepSeek-V4-Flash", "deepseek-ai/DeepSeek-V4-Pro", "deepseek-ai/DeepSeek-V3.2", "ZhipuAI/GLM-5.2", "stepfun-ai/Step-3.7-Flash"]
      },
      "zhipu": {
        "enabled": true,
        "name": "智谱 AI",
        "base_url": "https://open.bigmodel.cn/api/paas/v4/",
        "default_model": "glm-5.1",
        "models": ["glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.6", "glm-4.5"]
      },
      "gemini": {
        "enabled": true,
        "name": "Google Gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/",
        "default_model": "gemini-3.5-flash",
        "protocol": "google",
        "models": ["gemini-3.5-flash", "gemini-3.1-pro-preview", "gemini-3-flash-preview", "gemini-3.1-flash-lite", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"]
      },
      "openai": {
        "enabled": true,
        "name": "OpenAI / 兼容",
        "base_url": "https://api.openai.com/v1/",
        "default_model": "gpt-5.5",
        "models": ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.2", "gpt-5.2-pro", "gpt-5.1", "gpt-5", "gpt-5-pro", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"]
      },
      "openrouter": {
        "enabled": true,
        "name": "OpenRouter",
        "base_url": "https://openrouter.ai/api/v1/",
        "default_model": "openrouter/free",
        "models": ["openrouter/free", "openrouter/auto", "~openai/gpt-latest", "~openai/gpt-mini-latest", "openai/gpt-5.5", "openai/gpt-chat-latest", "~anthropic/claude-sonnet-latest", "anthropic/claude-opus-4.7", "anthropic/claude-opus-4.7-fast", "~google/gemini-pro-latest", "~google/gemini-flash-latest", "google/gemini-3.5-flash", "qwen/qwen3.7-max", "x-ai/grok-4.3", "x-ai/grok-build-0.1", "moonshotai/kimi-k2.6", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v3.2", "z-ai/glm-5.1", "openrouter/owl-alpha"]
      },
      "deepseek": {
        "enabled": true,
        "name": "DeepSeek",
        "base_url": "https://api.deepseek.com/",
        "default_model": "deepseek-v4-flash",
        "models": ["deepseek-v4-flash", "deepseek-v4-pro"]
      },
      "kimi": {
        "enabled": true,
        "name": "Moonshot (Kimi)",
        "base_url": "https://api.moonshot.cn/v1/",
        "default_model": "kimi-k2.6",
        "models": ["kimi-k2.6", "kimi-k2.5", "kimi-k2-turbo-preview", "kimi-k2-thinking", "kimi-k2-thinking-turbo", "moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"]
      },
      "mimo": {
        "enabled": true,
        "name": "小米 MiMo",
        "base_url": "https://api.xiaomimimo.com/v1/",
        "default_model": "mimo-v2.5-pro",
        "header_key": "api-key",
        "models": ["mimo-v2.5-pro", "mimo-v2.5", "mimo-v2-pro", "mimo-v2-omni", "mimo-v2-flash"]
      },
      "claude": {
        "enabled": true,
        "name": "Claude",
        "base_url": "https://api.anthropic.com",
        "default_model": "claude-sonnet-4-6",
        "protocol": "claude",
        "models": ["claude-opus-4-5", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5"]
      }
    },
    "asr": {
      "groq": {
        "enabled": true,
        "name": "Groq",
        "base_url": "https://api.groq.com/openai/v1",
        "default_model": "whisper-large-v3-turbo",
        "models": ["whisper-large-v3-turbo", "whisper-large-v3"]
      },
      "siliconflow": {
        "enabled": true,
        "name": "硅基流动",
        "base_url": "https://api.siliconflow.cn/v1",
        "default_model": "FunAudioLLM/SenseVoiceSmall",
        "models": ["FunAudioLLM/SenseVoiceSmall"]
      },
      "mimo": {
        "enabled": true,
        "name": "小米 MiMo",
        "base_url": "https://api.xiaomimimo.com/v1",
        "default_model": "mimo-v2.5-asr",
        "models": ["mimo-v2.5-asr"]
      }
    }
  }
  $config$::jsonb
)
on conflict (config_key) do nothing;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'extension_remote_config'
  ) then
    alter publication supabase_realtime add table public.extension_remote_config;
  end if;
end;
$$;
