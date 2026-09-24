// V5 lot 4 : envoie les rappels dus (table public.reminders) aux appareils abonnés (Web Push, VAPID).
// Appelée chaque minute par pg_cron (en-tête x-cap-cron = secret du Vault). Déployée sans vérification JWT.
// Chiffrement : web-push (generateRequestDetails) ; envoi : fetch natif.
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.108.2';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});
const STALE_MS = 10 * 60 * 1000; // un rappel en retard de plus de 10 min n'est plus envoyé
const SUBJECT = 'https://cap-lac.vercel.app';

const b64u = (buf: Uint8Array) => btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));

// Paire VAPID générée ici au premier appel (WebCrypto, P-256) et rangée dans le Vault : la clé privée
// ne quitte jamais Supabase. cap_push_store_vapid n'écrit que si aucune paire n'existe encore.
async function ensureVapid() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = new Uint8Array([4, ...fromB64u(jwk.x!), ...fromB64u(jwk.y!)]);
  const { error } = await sb.rpc('cap_push_store_vapid', { pub: b64u(pub), priv: jwk.d! });
  if (error) throw error;
}

let cfg: { vapid_public: string; vapid_private: string; cron_secret: string } | null = null;
async function config() {
  if (!cfg) {
    let { data, error } = await sb.rpc('cap_push_config');
    if (error) throw error;
    if (!data.vapid_private) {
      await ensureVapid();
      ({ data, error } = await sb.rpc('cap_push_config'));
      if (error) throw error;
    }
    cfg = data;
  }
  return cfg!;
}

Deno.serve(async (req) => {
  let c;
  try { c = await config(); } catch (e) { console.error('config', e); return new Response('config', { status: 500 }); }
  if (!c.cron_secret || req.headers.get('x-cap-cron') !== c.cron_secret) return new Response('forbidden', { status: 403 });

  const now = Date.now();
  // Réclame d'un coup les rappels dus (une seule requête UPDATE → pas de double envoi)
  const { data: due, error } = await sb.from('reminders')
    .update({ sent_at: new Date(now).toISOString() })
    .is('sent_at', null).lte('due_at', new Date(now).toISOString())
    .select('user_id, key, due_at, title, body, item_id, kind');
  if (error) { console.error('claim', error); return new Response('claim', { status: 500 }); }

  // Ménage : rappels de plus de 2 jours
  await sb.from('reminders').delete().lt('due_at', new Date(now - 2 * 86400000).toISOString());

  const fresh = (due || []).filter(r => now - new Date(r.due_at).getTime() <= STALE_MS);
  const stats = { due: (due || []).length, stale: (due || []).length - fresh.length, sent: 0, gone: 0, failed: 0 };
  if (!fresh.length) return Response.json(stats);

  const users = [...new Set(fresh.map(r => r.user_id))];
  const { data: subs, error: e2 } = await sb.from('push_subscriptions').select('*').in('user_id', users);
  if (e2) { console.error('subs', e2); return new Response('subs', { status: 500 }); }

  const deadSubs = new Set<string>();
  await Promise.all(fresh.flatMap(r => (subs || []).filter(s => s.user_id === r.user_id).map(async (s) => {
    try {
      const payload = JSON.stringify({ title: r.title, body: r.body, itemId: r.item_id, kind: r.kind, tag: r.key });
      const d = webpush.generateRequestDetails(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 600, urgency: 'high', vapidDetails: { subject: SUBJECT, publicKey: c.vapid_public, privateKey: c.vapid_private } },
      );
      const res = await fetch(d.endpoint, { method: d.method, headers: d.headers, body: d.body });
      if (res.status === 404 || res.status === 410) { deadSubs.add(s.id); stats.gone++; }
      else if (res.ok) stats.sent++;
      else { stats.failed++; console.error('push', res.status, (await res.text()).slice(0, 300)); }
    } catch (e) { stats.failed++; console.error('push', e); }
  })));

  if (deadSubs.size) await sb.from('push_subscriptions').delete().in('id', [...deadSubs]);
  const okIds = (subs || []).filter(s => !deadSubs.has(s.id)).map(s => s.id);
  if (stats.sent && okIds.length) await sb.from('push_subscriptions').update({ last_used_at: new Date().toISOString() }).in('id', okIds);
  return Response.json(stats);
});
