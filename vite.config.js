import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    // V5 lot 4 : PWA — manifest + service worker maison (src/sw.js) pour les notifications push
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'prompt',
      includeManifestIcons: false, // déjà couvertes par globPatterns
      injectRegister: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      manifest: {
        name: 'Cap',
        short_name: 'Cap',
        description: 'Ton rythme, ton énergie.',
        lang: 'fr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#F4EFE6',
        theme_color: '#F4EFE6',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  // App volontairement en un seul gros module (migration mécanique V5 lot 3) : pas d'avertissement de taille.
  build: { chunkSizeWarningLimit: 1000 },
});
