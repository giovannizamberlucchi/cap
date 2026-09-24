import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import AuthGate from './App.jsx';

// V5 lot 4 : service worker (hors ligne + notifications push). Une nouvelle version n'est jamais
// appliquée d'office : l'app affiche « Recharger » (événement cap:need-refresh).
window.__capUpdateSW = registerSW({
  onNeedRefresh() {
    window.__capNeedRefresh = true;
    window.dispatchEvent(new Event('cap:need-refresh'));
  },
});

createRoot(document.getElementById('root')).render(<AuthGate />);
