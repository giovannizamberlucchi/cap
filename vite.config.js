import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // App volontairement en un seul gros module (migration mécanique V5 lot 3) : pas d'avertissement de taille.
  build: { chunkSizeWarningLimit: 1000 },
});
