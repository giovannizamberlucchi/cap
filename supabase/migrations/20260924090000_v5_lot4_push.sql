-- V5 lot 4 : notifications push (abonnements par appareil + rappels à envoyer)
-- Appliquée sur le projet Supabase de Cap via l'outil de migration. Les secrets (clés VAPID, secret
-- de l'appel planifié) sont créés à part dans le Vault, jamais dans ce fichier.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- Un abonnement push par appareil et par compte
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (user_id, endpoint)
);
alter table public.push_subscriptions enable row level security;
create policy "push_subscriptions : les siens" on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Rappels à envoyer (réécrits par l'app : 14 prochains jours + fins de phase de la session en cours)
create table if not exists public.reminders (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  key text not null,
  due_at timestamptz not null,
  title text not null,
  body text not null,
  item_id text,
  kind text not null default 'task',
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index if not exists reminders_due_idx on public.reminders (due_at) where sent_at is null;
alter table public.reminders enable row level security;
create policy "reminders : les siens" on public.reminders
  for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Configuration lue par la fonction send-reminders (clé de service uniquement)
create or replace function public.cap_push_config()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'vapid_public',  (select decrypted_secret from vault.decrypted_secrets where name = 'cap_vapid_public'),
    'vapid_private', (select decrypted_secret from vault.decrypted_secrets where name = 'cap_vapid_private'),
    'cron_secret',   (select decrypted_secret from vault.decrypted_secrets where name = 'cap_cron_secret')
  );
$$;
revoke all on function public.cap_push_config() from public, anon, authenticated;
grant execute on function public.cap_push_config() to service_role;

-- (appliqué ensuite) pg_net hors du schéma public, recommandation du linter Supabase :
-- drop extension if exists pg_net; create extension pg_net with schema extensions;
