-- V5 lot 4 : appel de la fonction send-reminders chaque minute (pg_cron + pg_net).
-- Le secret partagé est lu dans le Vault au moment de l'appel.
select cron.schedule(
  'cap-send-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://hrsdzqwgpklzqvhltowz.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cap-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'cap_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);
