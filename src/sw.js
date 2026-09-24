// V5 lot 4 : service worker de Cap (vite-plugin-pwa, stratégie injectManifest).
// - Précache du build (ouverture hors ligne) + polices Google en cache.
// - Réception des notifications push (rappels, heure de partir, fins de tranche) et clic → ouvre la tâche.
// - Mise à jour : l'app propose « Recharger » (message SKIP_WAITING), jamais de rechargement forcé.
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// Navigation (application à page unique) : toujours l'index précaché
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

// Polices Google : feuille de style revalidée en arrière-plan, fichiers de police gardés un an
registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com',
  new StaleWhileRevalidate({ cacheName: 'cap-google-fonts-css' })
);
registerRoute(
  ({ url }) => url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'cap-google-fonts',
    plugins: [
      new CacheableResponsePlugin({ statuses: [0, 200] }),
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 365 * 24 * 3600 }),
    ],
  })
);

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Notification push : toujours affichée (iOS retire l'autorisation aux push « silencieux »).
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Cap';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    lang: 'fr',
    data: { itemId: data.itemId || null },
  }));
});

// Clic : ramène une fenêtre Cap existante au premier plan sur la tâche, sinon en ouvre une.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const itemId = event.notification.data && event.notification.data.itemId;
  const url = itemId ? `/?item=${encodeURIComponent(itemId)}` : '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      if (itemId) win.postMessage({ type: 'cap:open-item', itemId });
      return;
    }
    await self.clients.openWindow(url);
  })());
});
