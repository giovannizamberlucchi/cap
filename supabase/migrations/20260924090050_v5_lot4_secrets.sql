-- V5 lot 4 : secrets générés DANS Supabase (ils ne transitent jamais ailleurs).
-- - cap_cron_secret : aléatoire, créé ici.
-- - cap_vapid_public / cap_vapid_private : paire P-256 générée par la fonction send-reminders au
--   premier appel (WebCrypto), rangée via cap_push_store_vapid (une seule fois, jamais écrasée).
-- L'app lit la clé PUBLIQUE via cap_vapid_public_key() pour abonner l'appareil.

select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cap_cron_secret')
where not exists (select 1 from vault.secrets where name = 'cap_cron_secret');

create or replace function public.cap_push_store_vapid(pub text, priv text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from vault.secrets where name = 'cap_vapid_private') then
    perform vault.create_secret(pub, 'cap_vapid_public');
    perform vault.create_secret(priv, 'cap_vapid_private');
  end if;
end;
$$;
revoke all on function public.cap_push_store_vapid(text, text) from public, anon, authenticated;
grant execute on function public.cap_push_store_vapid(text, text) to service_role;

create or replace function public.cap_vapid_public_key()
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'cap_vapid_public';
$$;
revoke all on function public.cap_vapid_public_key() from public, anon;
grant execute on function public.cap_vapid_public_key() to authenticated;
