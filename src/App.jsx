import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';

// V4 4a.1 : contexte léger pour exposer l'arbre des caps aux cartes de tâche (chip lignée)
// value = { caps, onOpenCap }
const CapsContext = React.createContext({ caps: [], onOpenCap: null });

// V4 4a.1+ : contexte fournissant à la Boussole les handlers de TaskCard (réordo/imbrication/etc.)
// pour que les tâches liées se comportent exactement comme dans la vue Priorités.
const BoussoleTaskCtx = React.createContext(null);
// V4 4a.2 : opérations de confrontation (pace, question d'échéance, bas régime) pour CapNode récursif
const BoussoleCapCtx = React.createContext({ lowMode: false });

// ============ SUPABASE CONFIG ============
const SUPABASE_URL = 'https://hrsdzqwgpklzqvhltowz.supabase.co';
const SUPABASE_KEY = 'sb_publishable_PaES5uiS-4ShcbGipvMb6g_KkJ_nT5a';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// V5 lot 4 : ce que CET appareil sait faire en matière de notifications push
function isIOSDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandaloneApp() {
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
}
function pushSupportStatus() {
  const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!ok) return isIOSDevice() && !isStandaloneApp() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'off';
}
function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

// V5 lot 4 : réécrit côté Supabase les rappels à venir (table `reminders`), lus chaque minute par la
// fonction `send-reminders`. Upsert par clé stable (jamais de doublon, un rappel déjà envoyé le reste)
// + suppression des rappels futurs qui n'existent plus. Les rappels de test ne sont jamais supprimés ici.
async function syncRemindersToCloud(userId, list) {
  const { data: existing, error } = await sb.from('reminders').select('key')
    .eq('user_id', userId).is('sent_at', null).gt('due_at', new Date().toISOString());
  if (error) { console.error('reminders select', error); return false; }
  const want = new Set(list.map(r => r.key));
  const toDelete = (existing || []).map(e => e.key).filter(k => !want.has(k) && !k.startsWith('test:'));
  if (list.length) {
    const rows = list.map(r => ({ user_id: userId, key: r.key, due_at: new Date(r.dueAt).toISOString(), title: r.title, body: r.body, item_id: r.itemId || null, kind: r.kind }));
    const { error: e2 } = await sb.from('reminders').upsert(rows, { onConflict: 'user_id,key' });
    if (e2) { console.error('reminders upsert', e2); return false; }
  }
  if (toDelete.length) {
    const { error: e3 } = await sb.from('reminders').delete().eq('user_id', userId).is('sent_at', null).in('key', toDelete);
    if (e3) { console.error('reminders delete', e3); return false; }
  }
  return true;
}

// ============ CLOUD SYNC HELPERS ============
async function cloudLoad(userId) {
  try {
    const { data, error } = await sb
      .from('cap_data')
      .select('data, rev, updated_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) { console.error('Cloud load error:', error); return null; } // null = erreur réseau/serveur
    if (!data) return { data: null, rev: 0, updatedAt: null, exists: false };
    return { data: data.data || null, rev: (data.rev || 0), updatedAt: data.updated_at || null, exists: true };
  } catch (e) { console.error(e); return null; }
}

// FIX SYNC : sauvegarde en compare-and-swap sur la révision.
// N'écrit QUE si la révision cloud vaut encore baseRev → aucun appareil ne peut
// écraser aveuglément une version plus récente (c'était la cause de la perte de données).
// Retourne { ok, newRev } si succès, { conflict:true, current } si le cloud a avancé ailleurs.
async function cloudSaveCAS(userId, payload, baseRev) {
  const stamp = new Date().toISOString();
  const newRev = (baseRev || 0) + 1;
  try {
    // 1) Update gardé par la révision de base
    const { data: upd, error } = await sb
      .from('cap_data')
      .update({ data: payload, rev: newRev, updated_at: stamp })
      .eq('user_id', userId)
      .eq('rev', baseRev)
      .select('rev');
    if (error) { console.error('Cloud save error:', error); return { ok: false, error }; }
    if (upd && upd.length) return { ok: true, newRev };
    // 2) 0 ligne modifiée : soit pas encore de ligne, soit conflit (rev a avancé ailleurs)
    const { data: cur, error: e2 } = await sb
      .from('cap_data')
      .select('data, rev, updated_at')
      .eq('user_id', userId)
      .maybeSingle();
    if (e2) { console.error(e2); return { ok: false, error: e2 }; }
    if (!cur) {
      // Aucune ligne encore : on insère la base à rev 1
      const { error: e3 } = await sb
        .from('cap_data')
        .insert({ user_id: userId, data: payload, rev: 1, updated_at: stamp });
      if (e3) { console.error(e3); return { ok: false, conflict: true }; } // course d'insert → recharger
      return { ok: true, newRev: 1 };
    }
    // Conflit réel : un autre appareil détient une révision plus récente
    return { ok: false, conflict: true, current: { data: cur.data, rev: (cur.rev || 0), updatedAt: cur.updated_at } };
  } catch (e) { console.error(e); return { ok: false, error: e }; }
}

// ============ ICONS ============
const Icon = ({ d, size = 16, strokeWidth = 2, fill = 'none' }) => (
  <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">{d}</svg>
);
const IconPlus = (p) => <Icon {...p} d={<><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>} />;
const IconPin = ({ size = 16, strokeWidth = 2, filled = false }) => (
  <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="17" x2="12" y2="22"/><path d="M5 17h14l-1.5-4V5a2 2 0 0 0-2-2H8.5a2 2 0 0 0-2 2v8z"/></svg>
);
const IconCopy = (p) => <Icon {...p} d={<><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>} />;
const IconPlay = (p) => <Icon {...p} d={<polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/>} />;
const IconPause = (p) => <Icon {...p} d={<><rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none"/><rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none"/></>} />;
const IconStop = (p) => <Icon {...p} d={<rect x="5" y="5" width="14" height="14" fill="currentColor" stroke="none"/>} />;
const IconRotate = (p) => <Icon {...p} d={<><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></>} />;
const IconCheck = (p) => <Icon {...p} d={<polyline points="20 6 9 17 4 12"/>} />;
const IconTrash = (p) => <Icon {...p} d={<><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></>} />;
const IconClock = (p) => <Icon {...p} d={<><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>} />;
const IconZap = (p) => <Icon {...p} d={<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>} />;
// V3 S4 : Batterie avec niveau (0=vide, 1=low, 2=medium, 3=high)
const IconBattery = ({ level = 2, size = 14 }) => {
  // Body 14x8, bornes (1, 2) à (13, 6) intérieures, terminal à droite
  const cellW = 3.2;
  const padX = 1.6;
  return (
    <svg width={size + 4} height={size - 2} viewBox="0 0 18 9" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ display: 'inline-block', verticalAlign: 'middle' }}>
      <rect x="0.5" y="0.5" width="14" height="8" rx="1" stroke="currentColor" strokeWidth="1" fill="none"/>
      <rect x="15" y="2.5" width="2" height="4" rx="0.5" fill="currentColor"/>
      {level >= 1 && <rect x={padX} y={2} width={cellW} height={5} fill="currentColor"/>}
      {level >= 2 && <rect x={padX + cellW + 0.4} y={2} width={cellW} height={5} fill="currentColor"/>}
      {level >= 3 && <rect x={padX + 2 * (cellW + 0.4)} y={2} width={cellW} height={5} fill="currentColor"/>}
    </svg>
  );
};
const IconFlame = (p) => <Icon {...p} d={<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>} />;
const IconInbox = (p) => <Icon {...p} d={<><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></>} />;
const IconSparkles = (p) => <Icon {...p} d={<path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>} />;
const IconX = (p) => <Icon {...p} d={<><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>} />;
const IconMaximize = (p) => <Icon {...p} d={<><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></>} />;
const IconMinimize = (p) => <Icon {...p} d={<><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></>} />;
const IconChevronDown = (p) => <Icon {...p} d={<polyline points="6 9 12 15 18 9"/>} />;
const IconChevronRight = (p) => <Icon {...p} d={<polyline points="9 18 15 12 9 6"/>} />;
const IconChevronLeft = (p) => <Icon {...p} d={<polyline points="15 18 9 12 15 6"/>} />;
const IconCalendar = (p) => <Icon {...p} d={<><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></>} />;
const IconTag = (p) => <Icon {...p} d={<><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></>} />;
const IconTimer = (p) => <Icon {...p} d={<><line x1="10" y1="2" x2="14" y2="2"/><line x1="12" y1="14" x2="15" y2="11"/><circle cx="12" cy="14" r="8"/></>} />;
const IconTarget = (p) => <Icon {...p} d={<><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2" fill="currentColor"/></>} />;
const IconDownload = (p) => <Icon {...p} d={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></>} />;
const IconUpload = (p) => <Icon {...p} d={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></>} />;
const IconSettings = (p) => <Icon {...p} d={<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></>} />;
const IconSun = (p) => <Icon {...p} d={<><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></>} />;
const IconMoon = (p) => <Icon {...p} d={<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>} />;
const IconScales = (p) => <Icon {...p} d={<><line x1="12" y1="3" x2="12" y2="21"/><line x1="5" y1="7" x2="19" y2="7"/><path d="M5 7l-3 7a3 3 0 0 0 6 0z"/><path d="M19 7l-3 7a3 3 0 0 0 6 0z"/><line x1="8" y1="21" x2="16" y2="21"/></>} />;
const IconCompass = (p) => <Icon {...p} d={<><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></>} />;

// ============ LOGO ============
// Piste 2A « barre à roue, franche » du design component « Cap - Exploration logo » :
// jante ouverte en C, 6 rayons-poignées + 1 rayon d'accent au nord, moyeu plein.
// Monochrome (currentColor) → suit le thème ; l'accent suit --ocean, qui s'éclaircit en sombre.
const CAP_SPOKES = [45, 135, 180, 225, 270, 315];
const CapMark = ({ size = 32, accent = 'var(--ocean)', style }) => (
  <svg viewBox="0 0 100 100" aria-hidden="true" style={{ width: size, height: size, display: 'block', flexShrink: 0, ...style }}>
    <path d="M76,40 A28,28 0 1 0 76,60" fill="none" stroke="currentColor" strokeWidth="6" />
    <g stroke="currentColor" strokeWidth="4.5" strokeLinecap="round">
      {CAP_SPOKES.map(a => <line key={a} x1="50" y1="44" x2="50" y2="7" transform={`rotate(${a} 50 50)`} />)}
    </g>
    <line x1="50" y1="44" x2="50" y2="7" stroke={accent} strokeWidth="4.5" strokeLinecap="round" />
    <circle cx="50" cy="50" r="5.5" fill="currentColor" />
  </svg>
);

// Écran de chargement animé — port du design component « Cap - Loader ».
// Les rayons s'allument en séquence sur 2 tours, dans le sens horaire ; l'est est sauté
// (c'est là que la jante s'ouvre). La roue se fige au nord — on retrouve exactement le logo
// statique — l'étoile polaire apparaît, puis ça reboucle.
const CAP_LOOP_ANGLES = [0, 45, 135, 180, 225, 270, 315];
const CAP_STEP_MS = 220;

function CapLoader({ size = 178, caption = 'Ne perdez pas le nord.' }) {
  const [active, setActive] = useState(0);
  const [trail, setTrail] = useState(-1);
  const [starOn, setStarOn] = useState(false);
  const [textIn, setTextIn] = useState(false);

  useEffect(() => {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      // Pas de balayage : on montre directement l'état d'arrivée.
      setTextIn(true); setStarOn(true);
      return;
    }
    const timers = new Set();
    const after = (ms, fn) => {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.add(id);
    };
    const N = CAP_LOOP_ANGLES.length;
    const TOTAL = N * 2 + 1; // 2 tours, et on termine sur le nord
    after(320, () => setTextIn(true));
    const runLoop = () => {
      setStarOn(false);
      let s = 0;
      const doStep = () => {
        const a = s % N;
        setActive(a);
        setTrail(s === 0 ? -1 : (a - 1 + N) % N);
        s++;
        if (s < TOTAL) { after(CAP_STEP_MS, doStep); return; }
        setActive(0); setTrail(-1);
        after(CAP_STEP_MS * 1.4, () => {
          setStarOn(true);
          after(1700, () => after(520, runLoop));
        });
      };
      doStep();
    };
    runLoop();
    return () => { timers.forEach(clearTimeout); timers.clear(); };
  }, []);

  const star = Math.round(size * 0.18);

  return (
    <div className="paper-texture" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2.6rem', minHeight: '100vh', padding: '3rem 1rem', color: 'var(--ink)' }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg viewBox="0 0 100 100" aria-hidden="true" style={{ display: 'block', width: '100%', height: '100%' }}>
          <path d="M76,40 A28,28 0 1 0 76,60" fill="none" stroke="currentColor" strokeWidth="6" />
          <g stroke="currentColor" strokeWidth="4.5" strokeLinecap="round">
            {CAP_LOOP_ANGLES.map(a => <line key={a} x1="50" y1="44" x2="50" y2="7" transform={`rotate(${a} 50 50)`} />)}
          </g>
          <g stroke="var(--ocean)" strokeWidth="5" strokeLinecap="round">
            {CAP_LOOP_ANGLES.map((a, i) => (
              <line key={a} x1="50" y1="44" x2="50" y2="7" transform={`rotate(${a} 50 50)`}
                style={{ opacity: i === active ? 1 : (i === trail ? 0.32 : 0), transition: 'opacity 0.15s linear' }} />
            ))}
          </g>
          <circle cx="50" cy="50" r="5.5" fill="currentColor" />
        </svg>
        <div style={{ position: 'absolute', top: '-4%', left: '93%', width: star, height: star, opacity: starOn ? 1 : 0, transform: `translate(-50%,-50%) scale(${starOn ? 1 : 0.4})`, transition: 'opacity 0.75s ease, transform 0.75s cubic-bezier(.2,1.5,.4,1)', pointerEvents: 'none' }}>
          <div className="cap-star-glow" />
          <svg viewBox="0 0 100 100" aria-hidden="true" style={{ display: 'block', position: 'relative', width: '100%', height: '100%' }}>
            <path d="M50,6 L57,43 L82,50 L57,57 L50,94 L43,57 L18,50 L43,43 Z" fill="var(--ocean)" />
          </svg>
        </div>
      </div>
      <div className="display" role="status" style={{ fontStyle: 'italic', fontWeight: 500, fontSize: '1.55rem', lineHeight: 1.2, textAlign: 'center', opacity: textIn ? 1 : 0, transform: textIn ? 'translateY(0)' : 'translateY(10px)', transition: 'opacity 0.9s ease, transform 0.9s ease' }}>
        {caption}
      </div>
    </div>
  );
}

// ============ STORAGE ============
const STORAGE_KEY = 'cap-app-v2';
const loadState = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
};
const saveState = (state) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { console.error(e); }
};

// ============ UTILS ============
const generateId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const todayISO = () => {
  const d = new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const tomorrowISO = () => {
  const d = new Date(Date.now() + 86400000);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

function energyLabel(e) { return e === 'low' ? 'faible' : e === 'high' ? 'haute' : 'moyen'; }

function formatDate(d) {
  if (!d) return '';
  const today = todayISO(), tomorrow = tomorrowISO();
  if (d === today) return "Aujourd'hui";
  if (d === tomorrow) return "Demain";
  return new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

// Convertit un objet duration {weeks, days, hours, minutes} en minutes totales
function durationToMinutes(d) {
  if (!d) return 0;
  return (d.weeks || 0) * 7 * 24 * 60 + (d.days || 0) * 24 * 60 + (d.hours || 0) * 60 + (d.minutes || 0);
}

// Formatte un objet duration en string compacte "1s 4j 5h 32min"
function formatDuration(d) {
  if (!d) return '';
  const parts = [];
  if (d.weeks) parts.push(`${d.weeks}s`);
  if (d.days) parts.push(`${d.days}j`);
  if (d.hours) parts.push(`${d.hours}h`);
  if (d.minutes) parts.push(`${d.minutes}min`);
  return parts.join(' ') || '';
}

// ============ DEADLINE HELPERS ============
// Calcule le nombre de jours entre aujourd'hui et la deadline (négatif si en retard)
function daysUntilDeadline(deadlineISO) {
  if (!deadlineISO) return null;
  const today = new Date(todayISO() + 'T00:00:00').getTime();
  const dl = new Date(deadlineISO + 'T00:00:00').getTime();
  return Math.round((dl - today) / 86400000);
}

// Retourne {label, color, urgent} pour l'affichage du chip deadline
function deadlineStatus(deadlineISO) {
  const d = daysUntilDeadline(deadlineISO);
  if (d === null) return null;
  if (d < 0) return { label: `En retard de ${Math.abs(d)}j`, color: 'rust', intense: true, urgent: true };
  if (d === 0) return { label: "Aujourd'hui", color: 'rust', urgent: true };
  if (d === 1) return { label: 'Demain', color: 'rust', urgent: true };
  if (d <= 3) return { label: `Dans ${d}j`, color: 'orange', urgent: true };
  if (d <= 7) return { label: `Dans ${d}j`, color: 'ochre', urgent: false };
  return { label: `Échéance ${formatDate(deadlineISO)}`, color: 'neutral', urgent: false };
}

// ============ RECURRENCE ENGINE ============
// 0=dim, 1=lun, 2=mar, 3=mer, 4=jeu, 5=ven, 6=sam (alignement Date.getDay())
function isoToDate(iso) { return new Date(iso + 'T00:00:00'); }
function dateToISO(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(iso, n) { const d = isoToDate(iso); d.setDate(d.getDate() + n); return dateToISO(d); }

// Renvoie true si la date `iso` est une occurrence brute (avant exceptions) de cet item récurrent
function isOccurrenceDate(item, iso) {
  if (!item.recurrence) return false;
  const r = item.recurrence;
  const d = isoToDate(iso);
  // Référence : createdAt ramené à la date locale, ou date du premier item
  const refMs = item.createdAt || Date.now();
  const refDate = new Date(refMs);
  const refIso = dateToISO(refDate);
  // Pas d'occurrence avant la création
  if (iso < refIso) return false;
  // Fin de récurrence par date
  if (r.endDate && iso > r.endDate) return false;

  const interval = r.interval || 1;
  if (r.rule === 'daily' || r.rule === 'interval') {
    const diffDays = Math.round((isoToDate(iso) - isoToDate(refIso)) / 86400000);
    if (diffDays < 0) return false;
    return diffDays % interval === 0;
  }
  if (r.rule === 'weekly') {
    const dow = d.getDay();
    if (!r.weekdays || !r.weekdays.includes(dow)) return false;
    // toutes les N semaines depuis la semaine de référence
    const refWeekStart = (() => { const x = new Date(refDate); x.setDate(refDate.getDate() - ((refDate.getDay() + 6) % 7)); return x; })();
    const targetWeekStart = (() => { const x = new Date(d); x.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return x; })();
    const diffWeeks = Math.round((targetWeekStart - refWeekStart) / (7 * 86400000));
    if (diffWeeks < 0) return false;
    return diffWeeks % interval === 0;
  }
  if (r.rule === 'monthly') {
    // V3 S5.5+ : fallback "fin de mois intelligent"
    // Si monthDay > nb jours du mois courant (ex : 31 demandé en février),
    // l'occurrence tombe le dernier jour disponible (28/29 fév, 30 avr/juin/sep/nov).
    const lastDayOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const targetDay = Math.min(r.monthDay, lastDayOfMonth);
    if (targetDay !== d.getDate()) return false;
    const monthDiff = (d.getFullYear() - refDate.getFullYear()) * 12 + (d.getMonth() - refDate.getMonth());
    if (monthDiff < 0) return false;
    return monthDiff % interval === 0;
  }
  // V3 S5.5 : annuel — même mois et même jour, tous les N ans depuis la création
  if (r.rule === 'yearly') {
    const targetMonth = (typeof r.month === 'number') ? r.month : refDate.getMonth(); // 0-11
    const targetDay = r.monthDay || refDate.getDate();
    if (d.getMonth() !== targetMonth) return false;
    if (d.getDate() !== targetDay) return false;
    const yearDiff = d.getFullYear() - refDate.getFullYear();
    if (yearDiff < 0) return false;
    return yearDiff % interval === 0;
  }
  return false;
}

// Calcule les occurrences (après exceptions) d'un item récurrent dans [fromISO, toISO]
// Renvoie un array de { date, time, status } où status = 'normal'|'completed'|'skipped' (jamais 'deleted' qui est filtré)
// Inclut aussi les occurrences déplacées (exceptions {date, time}) qui tombent dans la fenêtre
function getOccurrencesInRange(item, fromISO, toISO) {
  if (!item.recurrence) return [];
  const result = [];
  const exceptions = item.exceptions || {};

  // 1. Compter occurrences brutes pour respecter endAfter
  let brutCount = 0;
  const endAfter = item.recurrence.endAfter;
  // On itère sur la fenêtre [createdAt, toISO] pour pouvoir compter les occurrences avant fromISO
  const startScan = (() => {
    const refMs = item.createdAt || Date.now();
    return dateToISO(new Date(refMs));
  })();
  const scanFrom = startScan < fromISO ? startScan : fromISO;
  let cursor = scanFrom;

  while (cursor <= toISO) {
    if (isOccurrenceDate(item, cursor)) {
      brutCount++;
      if (endAfter && brutCount > endAfter) break;
      const exc = exceptions[cursor];
      if (exc && typeof exc === 'object' && exc.date) {
        // Déplacement — sera ajouté plus bas si la cible tombe dans la fenêtre
      } else if (exc === 'deleted' || exc === 'skipped') {
        // Skip
      } else if (cursor >= fromISO) {
        result.push({ date: cursor, time: item.time || '', status: exc === 'completed' ? 'completed' : 'normal' });
      }
    }
    cursor = addDays(cursor, 1);
  }

  // 2. Ajouter les exceptions de type déplacement qui tombent dans [fromISO, toISO]
  for (const [origDate, exc] of Object.entries(exceptions)) {
    if (exc && typeof exc === 'object' && exc.date) {
      if (exc.date >= fromISO && exc.date <= toISO) {
        result.push({ date: exc.date, time: exc.time || item.time || '', status: 'normal', movedFrom: origDate });
      }
    }
  }

  // 3. Trier par date
  result.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  return result;
}

// Vrai si l'item a une occurrence (récurrente ou one-shot) ce jour-là
function hasOccurrenceOnDate(item, iso) {
  if (item.recurrence) {
    return getOccurrencesInRange(item, iso, iso).length > 0;
  }
  return item.date === iso;
}

// Détection de collision : retourne l'occurrence qui bloque, ou null
// excludeKey = `${itemId}|${origDate}` à exclure du check (cas drag d'une occurrence sur elle-même)
// ============ TIME UTILS (minutes-based) ============
// Plancher visuel d'un bloc : durée minimum réelle d'une tâche dans l'agenda.
// Pas de plancher artificiel — le bloc fait sa vraie durée. Sol absolu = 5 min (1 tranche).
const MIN_VISUAL_MIN = 5;
// Pas de la grille agenda
const SLOT_MIN = 5;
// Pixels par tranche de 5 min (120px/h / 12 tranches = 10px). Augmenter pour densifier.
const PX_PER_SLOT = 10;
const PX_PER_HOUR = 120;

// Convertit "HH:MM" en minutes depuis minuit (0..1439). null si vide/invalide.
function timeToMin(t) {
  if (!t || typeof t !== 'string') return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10);
  if (isNaN(h) || isNaN(mn)) return null;
  return h * 60 + mn;
}
// Convertit minutes (0..1439) en "HH:MM"
function minToTime(min) {
  const m = Math.max(0, Math.min(1439, min | 0));
  const h = Math.floor(m / 60);
  const mn = m % 60;
  return `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
}
// Snap au pas de 5 min
function snap5(min) { return Math.round(min / 5) * 5; }

// V3 S4.5 : zone "couronne" (prep + trajet aller, et trajet retour si activé) autour d'un RDV
// Ne s'active que si l'item est isImportant ET a une heure (sans heure → rien à entourer).
// Renvoie { prepStart, travelStart, time, end, returnEnd, hasPrep, hasTravel, hasReturn } en minutes
// ou null si l'item n'a pas de couronne (pas important ou pas d'heure).
// `time` ici = minutes de l'heure de RDV (= début effectif de la tâche).
function getRdvHalo(item, occStartMin, occDurationMin) {
  if (!item || !item.isImportant) return null;
  if (occStartMin == null) return null;
  const prep = (typeof item.prepDuration === 'number' && item.prepDuration > 0) ? item.prepDuration : 0;
  const trav = (typeof item.travelDuration === 'number' && item.travelDuration > 0) ? item.travelDuration : 0;
  // V5 : retour éventuellement différent de l'aller (travelReturnDuration), sinon = aller
  const retDur = item.travelReturn
    ? ((typeof item.travelReturnDuration === 'number' && item.travelReturnDuration > 0) ? item.travelReturnDuration : trav)
    : 0;
  const ret = retDur > 0;
  if (!prep && !trav && !ret) return null;
  const dur = Math.max(occDurationMin || 0, MIN_VISUAL_MIN);
  return {
    prepStart: occStartMin - trav - prep,
    travelStart: occStartMin - trav,
    time: occStartMin,
    end: occStartMin + dur,
    returnEnd: occStartMin + dur + retDur,
    hasPrep: prep > 0,
    hasTravel: trav > 0,
    hasReturn: ret,
  };
}

// V3 S4.5 : bornes étendues pour la détection de chevauchement
// Inclut prep + trajet aller + (optionnel) trajet retour. Si pas de couronne → bornes nues.
function getEffectiveBounds(item, startMin, durationMin) {
  if (startMin == null) return null;
  const dur = Math.max(durationMin || 0, MIN_VISUAL_MIN);
  const halo = getRdvHalo(item, startMin, durationMin);
  if (!halo) return { start: startMin, end: startMin + dur };
  return { start: halo.prepStart, end: halo.returnEnd };
}

// V3 S4.5 : message de toast uniforme pour un conflit. Précise si la zone touchée
// chez l'autre est sa préparation, son trajet ou son retour.
function formatConflictToast(overlap) {
  const oStart = timeToMin(overlap.time);
  const oCoreDur = Math.max(overlap.durationMin || 0, MIN_VISUAL_MIN);
  const halo = getRdvHalo(overlap.item, oStart, overlap.durationMin || 0);
  const effStart = halo ? halo.prepStart : oStart;
  const effEnd = halo ? halo.returnEnd : (oStart + oCoreDur);
  // Clamp pour l'affichage si zone négative ou > 24h
  const showStart = Math.max(0, effStart);
  const showEnd = Math.min(24 * 60, effEnd);
  const zoneStr = (() => {
    switch (overlap.conflictKind) {
      case 'prep': return ' (prep)';
      case 'travel': return ' (trajet)';
      case 'return': return ' (trajet retour)';
      default: return halo ? ' (prep+trajet inclus)' : '';
    }
  })();
  return `⚠ Chevauche « ${overlap.item.title} » ${minToTime(showStart)}–${minToTime(showEnd)}${zoneStr}`;
}

// Détection de chevauchement : compare des plages [start, end[ pour deux occurrences ce jour
// items: arbre, date: ISO, startMin/endMin: bornes du créneau testé, excludeKey: occ qu'on déplace (à exclure)
// V3 S4.5 : si l'occurrence à tester a un halo prep/trajet, son [start, end] doit être passé déjà étendu
// par l'appelant (via getEffectiveBounds). Côté items existants : on étend leurs bornes ici.
// Retourne la première occurrence qui chevauche, ou null. L'occurrence retournée porte un champ
// extra `conflictKind` : 'core' | 'prep' | 'travel' | 'return' selon la zone touchée chez l'autre.
function findOverlapAt(items, date, startMin, endMin, excludeKey = null) {
  if (startMin == null || endMin == null || endMin <= startMin) return null;
  const occs = expandItemsForRange(items, date, date);
  for (const o of occs) {
    if (o.date !== date) continue;
    if (!o.time) continue; // sans heure → pas dans la grille
    if (o.status === 'completed' || o.status === 'skipped') continue;
    const oStart = timeToMin(o.time);
    if (oStart == null) continue;
    const oCoreDur = Math.max(o.durationMin || 0, MIN_VISUAL_MIN); // bloc visuel min
    const oCoreEnd = oStart + oCoreDur;
    const key = `${o.item.id}|${o.movedFrom || o.date}`;
    if (excludeKey && key === excludeKey) continue;
    // V3 S4.5 : zone effective de o (prep + trajet ± retour) si halo
    const halo = getRdvHalo(o.item, oStart, oCoreDur);
    const effStart = halo ? halo.prepStart : oStart;
    const effEnd = halo ? halo.returnEnd : oCoreEnd;
    // chevauchement : startA < endB && startB < endA
    if (startMin < effEnd && effStart < endMin) {
      // Identifier quelle zone de o est touchée
      let conflictKind = 'core';
      if (halo) {
        if (startMin < halo.travelStart && halo.prepStart < endMin) conflictKind = 'prep';
        else if (startMin < halo.time && halo.travelStart < endMin) conflictKind = 'travel';
        else if (halo.hasReturn && startMin < halo.returnEnd && halo.end < endMin) conflictKind = 'return';
        // Si on touche aussi le bloc principal, on garde 'core' qui prime
        if (startMin < oCoreEnd && oStart < endMin) conflictKind = 'core';
      }
      return { ...o, conflictKind };
    }
  }
  return null;
}

// V3 S(C1) : assignation de "lanes" (colonnes) pour les blocs qui se chevauchent dans la vue jour.
// Entrée : [{ key, startMin, endMin }]. Sortie : { [key]: { lane, lanes } }.
// Algo standard d'agenda : on forme des grappes de blocs qui se chevauchent transitivement,
// puis on répartit chaque grappe en colonnes (1re colonne libre, sinon nouvelle).
function computeDayLanes(blocks) {
  const sorted = [...blocks].sort((a, b) => (a.startMin - b.startMin) || (a.endMin - b.endMin));
  const result = {};
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const laneEnds = []; // fin du dernier bloc placé dans chaque colonne
    for (const b of cluster) {
      let placed = false;
      for (let i = 0; i < laneEnds.length; i++) {
        if (b.startMin >= laneEnds[i]) { b._lane = i; laneEnds[i] = b.endMin; placed = true; break; }
      }
      if (!placed) { b._lane = laneEnds.length; laneEnds.push(b.endMin); }
    }
    const lanes = laneEnds.length;
    for (const b of cluster) result[b.key] = { lane: b._lane, lanes };
    cluster = [];
    clusterEnd = -1;
  };
  for (const b of sorted) {
    if (cluster.length && b.startMin >= clusterEnd) flush();
    cluster.push(b);
    clusterEnd = Math.max(clusterEnd, b.endMin);
  }
  flush();
  return result;
}

// Aplatit un arbre d'items (parents + sous-tâches récursifs) en une liste plate
function flattenItems(items) {
  const result = [];
  for (const i of items) {
    result.push(i);
    if (i.subtasks?.length) result.push(...flattenItems(i.subtasks));
  }
  return result;
}

// ============ EXPAND ITEMS FOR RANGE ============
// Transforme une liste d'items (récursive) en liste plate d'occurrences dans la fenêtre [fromISO, toISO].
// Chaque occurrence porte une référence stable { item, date, time, status, isOccurrence }.
// - item one-shot dans la plage → 1 occurrence (date = item.date, isOccurrence = false)
// - item récurrent → toutes ses occurrences dans la plage (isOccurrence = true)
// - habitudes : idem, isOccurrence = true
// Sous-tâches : on descend récursivement. Une sous-tâche apparaît dans l'agenda si elle a sa propre
// date/récurrence qui diffère du parent (sinon doublon visuel sans intérêt).
// ============ EXPAND ITEMS FOR RANGE ============
// Transforme une liste d'items (récursive) en liste plate d'occurrences dans la fenêtre [fromISO, toISO].
// Chaque occurrence porte une référence stable { item, date, time, status, isOccurrence, durationMin }.
// - item one-shot dans la plage → 1 occurrence (date = item.date, isOccurrence = false)
// - item récurrent → toutes ses occurrences dans la plage (isOccurrence = true)
// - habitudes : idem, isOccurrence = true
// Sous-tâches : on descend récursivement.
// V3 S3 : un item AVEC sous-tâches n'est PAS affiché dans l'agenda (seules les sous-tâches le sont).
// V3 S3 : durationMin par occurrence, avec override possible via exception { duration }.
function expandItemsForRange(items, fromISO, toISO) {
  const today = todayISO();
  const result = [];
  const walk = (list, parent = null) => {
    for (const it of list) {
      const hasSubs = !!(it.subtasks && it.subtasks.length > 0);
      // Si l'item a des sous-tâches, il n'apparaît PAS dans l'agenda (seules les sous-tâches y figurent)
      const showThis = !hasSubs;

      if (showThis) {
        if (it.completed && !it.recurrence) {
          // V3 S4 : tâche one-shot complétée → visible UNIQUEMENT si date == aujourd'hui (grisée)
          // sinon archivée → invisible dans l'agenda
          if (it.date && it.date === today && today >= fromISO && today <= toISO) {
            const durationMin = effectiveDurationMinutes(it) || 0;
            result.push({ item: it, date: it.date, time: it.time || '', status: 'completed', isOccurrence: false, durationMin });
          }
        } else if (it.recurrence) {
          const occs = getOccurrencesInRange(it, fromISO, toISO);
          const baseDur = effectiveDurationMinutes(it) || 0;
          // V3 S(D) : routine multi-créneaux (≥2 heures/jour) → une occurrence par créneau, statut via slotHistory
          const multiTimes = (it.streak && Array.isArray(it.times) && it.times.length >= 2) ? it.times : null;
          for (const o of occs) {
            const status = o.status;
            if (status === 'skipped') continue;
            if (multiTimes) {
              const doneSlots = (it.slotHistory || {})[o.date] || [];
              for (const t of multiTimes) {
                const slotDone = doneSlots.includes(t);
                // créneau fait → grisé le jour J, invisible les autres jours
                if (slotDone && o.date !== today) continue;
                result.push({ item: it, date: o.date, time: t, status: slotDone ? 'completed' : 'normal', isOccurrence: true, movedFrom: o.movedFrom, durationMin: baseDur, slotTime: t });
              }
              continue;
            }
            // V3 S4 : occurrence récurrente cochée → grisée le jour J, invisible les autres jours
            if (status === 'completed' && o.date !== today) continue;
            // V3 S5 : pour une tâche avec streak, le statut "completed" se lit dans history
            // (pas dans exceptions). On ré-évalue le status à partir de history.
            const finalStatus = (it.streak && (it.history || []).includes(o.date)) ? 'completed' : status;
            if (finalStatus === 'completed' && o.date !== today) continue;
            const excKey = o.movedFrom || o.date;
            const exc = it.exceptions?.[excKey];
            const overrideDur = (exc && typeof exc === 'object' && typeof exc.duration === 'number') ? exc.duration : null;
            const durationMin = overrideDur != null ? overrideDur : baseDur;
            result.push({ item: it, date: o.date, time: o.time || it.time || '', status: finalStatus, isOccurrence: true, movedFrom: o.movedFrom, durationMin });
          }
        } else {
          if (it.date && it.date >= fromISO && it.date <= toISO) {
            const durationMin = effectiveDurationMinutes(it) || 0;
            result.push({ item: it, date: it.date, time: it.time || '', status: 'normal', isOccurrence: false, durationMin });
          }
        }
      }

      // Descendre dans les sous-tâches
      if (it.subtasks?.length) walk(it.subtasks, it);
    }
  };
  walk(items);
  result.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  return result;
}

// Pour les tâches avec streak (V3 S5), le statut "completed aujourd'hui" est porté
// par lastCompletedDate/history, pas par exceptions.
// Cette fonction unifie l'accès au statut pour une occurrence donnée.
function isOccurrenceCompleted(item, iso) {
  if (item.streak) {
    return (item.history || []).includes(iso);
  }
  if (item.recurrence) {
    return item.exceptions?.[iso] === 'completed';
  }
  return !!item.completed;
}

// ============ V5 LOT 4 : RAPPELS — calcul unique (minuteurs locaux + notifications push) ============
const REMINDER_WINDOW_DAYS = 14;

function reminderLabel(min) {
  return min === 0 ? 'maintenant' :
    min === 1440 ? 'demain' :
    min >= 60 ? `dans ${Math.round(min / 60)}h` :
    `dans ${min} min`;
}

// Rappels à venir sur [now, now + 14 j] : tâches datées avec heure + rappel, et (V5 lot 4) occurrences
// des tâches récurrentes / routines — un rappel par créneau pour les routines multi-créneaux.
// RDV avec trajet aller : le rappel se cale sur l'heure de départ (V3 S4.5).
// Retourne [{ key, itemId, dueAt (ms), title, body, kind }] trié ; key stable = tâche + heure prévue + délai.
function computeReminders(items, now = Date.now(), days = REMINDER_WINDOW_DAYS) {
  const out = [];
  const horizon = now + days * 86400000;
  const fromISO = dateToISO(new Date(now));
  const toISO = addDays(fromISO, days + 1);
  const add = (it, dateISO, time) => {
    const reminderMin = parseInt(it.reminder, 10);
    if (isNaN(reminderMin)) return;
    const at = new Date(`${dateISO}T${time}:00`).getTime();
    if (isNaN(at)) return;
    const travelMin = (it.isImportant && typeof it.travelDuration === 'number' && it.travelDuration > 0) ? it.travelDuration : 0;
    const dueAt = at - travelMin * 60000 - reminderMin * 60000;
    if (dueAt <= now || dueAt > horizon) return;
    out.push({
      key: `r:${it.id}:${dateISO}T${time}:${reminderMin}`,
      itemId: it.id,
      dueAt,
      title: travelMin > 0 ? '🧭 Cap — Départ' : '🧭 Cap — Rappel',
      body: travelMin > 0 ? `🚗 Heure de partir pour « ${it.title} » (RDV à ${time})` : `« ${it.title} » ${reminderLabel(reminderMin)}`,
      kind: travelMin > 0 ? 'travel' : 'task',
    });
  };
  for (const it of flattenItems(items)) {
    if (!it.reminder) continue;
    if (!it.recurrence) {
      if (!it.completed && it.date && it.time) add(it, it.date, it.time);
      continue;
    }
    const multi = (it.streak && Array.isArray(it.times) && it.times.length >= 2) ? it.times : null;
    for (const o of getOccurrencesInRange(it, fromISO, toISO)) {
      if (o.status === 'completed' || o.status === 'skipped') continue;
      if (multi) {
        const done = (it.slotHistory || {})[o.date] || [];
        multi.forEach(t => { if (t && !done.includes(t)) add(it, o.date, t); });
        continue;
      }
      if (isOccurrenceCompleted(it, o.date)) continue;
      const t = o.time || it.time;
      if (t) add(it, o.date, t);
    }
  }
  return out.sort((a, b) => a.dueAt - b.dueAt);
}

// ============ V3 S5 : RÉCURRENCE FLOTTANTE ============
// "N fois par semaine sans jour fixe" / "N fois par mois sans jour fixe"
// Le streak compte les périodes (semaines / mois) où l'objectif est atteint.

// Identifiant de période ISO :
// - floatingWeekly : "YYYY-Www" (semaine ISO, lundi → dimanche)
// - floatingMonthly : "YYYY-MM"
function isoWeekId(date) {
  // Date → "YYYY-Www" basé sur la semaine ISO 8601 (lundi = jour 1)
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function isoMonthId(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function periodIdForRecurrence(rec, dateObj) {
  if (!rec) return null;
  if (rec.rule === 'floatingWeekly') return isoWeekId(dateObj);
  if (rec.rule === 'floatingMonthly') return isoMonthId(dateObj);
  return null;
}

// Bornes lundi/dimanche d'une semaine ISO contenant `dateObj`
function weekRange(dateObj) {
  const d = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  const dow = d.getDay() || 7; // lundi=1 ... dimanche=7
  const monday = new Date(d); monday.setDate(d.getDate() - (dow - 1));
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  return { start: dateToISO(monday), end: dateToISO(sunday) };
}

function monthRange(dateObj) {
  const start = new Date(dateObj.getFullYear(), dateObj.getMonth(), 1);
  const end = new Date(dateObj.getFullYear(), dateObj.getMonth() + 1, 0);
  return { start: dateToISO(start), end: dateToISO(end) };
}

// Compte les complétions (history) d'un item sur la période contenant `today`.
function floatingCompletionsInPeriod(item, todayObj) {
  if (!item.recurrence) return 0;
  let range = null;
  if (item.recurrence.rule === 'floatingWeekly') range = weekRange(todayObj);
  else if (item.recurrence.rule === 'floatingMonthly') range = monthRange(todayObj);
  else return 0;
  return (item.history || []).filter(d => d >= range.start && d <= range.end).length;
}

// Quota atteint pour la période courante ?
function isFloatingQuotaMet(item, todayObj) {
  const r = item.recurrence;
  if (!r || (r.rule !== 'floatingWeekly' && r.rule !== 'floatingMonthly')) return false;
  const target = r.count || 1;
  return floatingCompletionsInPeriod(item, todayObj) >= target;
}

function isFloatingRecurrence(rec) {
  return rec && (rec.rule === 'floatingWeekly' || rec.rule === 'floatingMonthly');
}

// V3 S5.5 : Niveau d'alerte pour récurrence flottante quand le quota est tendu
// Renvoie 'safe' (vert/normal), 'warning' (orange : jours restants = manquants),
// 'critical' (rouge : jours restants < manquants — impossible)
function getFloatingAlertLevel(item, todayObj) {
  const r = item.recurrence;
  if (!r || !isFloatingRecurrence(r)) return 'safe';
  const target = r.count || 1;
  const done = floatingCompletionsInPeriod(item, todayObj);
  if (done >= target) return 'safe';
  const missing = target - done;
  // Jours restants dans la période courante (incluant aujourd'hui)
  let endIso, todayIso = dateToISO(todayObj);
  if (r.rule === 'floatingWeekly') endIso = weekRange(todayObj).end;
  else if (r.rule === 'floatingMonthly') endIso = monthRange(todayObj).end;
  else return 'safe';
  const todayD = isoToDate(todayIso);
  const endD = isoToDate(endIso);
  const remaining = Math.max(0, Math.round((endD - todayD) / 86400000) + 1);
  if (remaining < missing) return 'critical';
  if (remaining === missing) return 'warning';
  return 'safe';
}

// V3 S5.5++ : Calcul lazy du streak — périodes consécutives réussies remontant depuis aujourd'hui.
// Une période est définie par le type de récurrence. On s'arrête à la première période ratée.
// Renvoie { count, periodLabel } où periodLabel est utilisé pour le suffixe ("jours" | "semaines" | "mois" | "années" | "périodes").
function computeStreak(item, todayObj) {
  const r = item.recurrence;
  const history = item.history || [];
  const histSet = new Set(history);
  const todayIso = dateToISO(todayObj);

  // Pas de récurrence : on compte les complétions (cas exotique, ne devrait pas se présenter)
  if (!r) {
    return { count: history.length, periodLabel: 'fois' };
  }

  // Helpers
  const isoOf = (d) => dateToISO(d);
  const dayBack = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - n); return x; };
  const monthBack = (d, n) => new Date(d.getFullYear(), d.getMonth() - n, 1);
  const yearBack = (d, n) => new Date(d.getFullYear() - n, 0, 1);
  const weekRangeOf = (d) => weekRange(d);
  const monthRangeOf = (d) => monthRange(d);

  // QUOTIDIEN : chaque jour est une période. On remonte tant que history contient le jour.
  // Tolérance : si aujourd'hui pas encore coché, on commence à hier (sinon on perdrait le streak en début de journée).
  if (r.rule === 'daily' && (r.interval || 1) === 1) {
    let count = 0;
    let cursor = new Date(todayObj.getFullYear(), todayObj.getMonth(), todayObj.getDate());
    const todayDone = histSet.has(todayIso);
    if (!todayDone) cursor = dayBack(cursor, 1); // on regarde à partir d'hier
    while (histSet.has(isoOf(cursor))) {
      count++;
      cursor = dayBack(cursor, 1);
    }
    return { count, periodLabel: 'jours' };
  }

  // LUN-VEN : période = semaine. Réussite = les 5 jours ouvrés cochés.
  // Tolérance : si on est en cours de semaine et que les jours déjà passés sont cochés, on compte la semaine en cours uniquement si tous les jours déjà passés sont OK.
  // Mais simpliste : on regarde les semaines précédentes complètes uniquement, plus la semaine courante si elle est complète.
  const isWeekdaysPattern = r.rule === 'weekly' && (r.interval || 1) === 1 && r.weekdays?.length === 5 && r.weekdays.every(x => x >= 1 && x <= 5);
  if (isWeekdaysPattern) {
    let count = 0;
    let cursorEnd = todayObj;
    while (true) {
      const range = weekRangeOf(cursorEnd);
      // Lundi à vendredi de cette semaine
      const monday = isoToDate(range.start);
      let allDone = true;
      for (let i = 0; i < 5; i++) {
        const d = new Date(monday); d.setDate(monday.getDate() + i);
        const iso = isoOf(d);
        // Si le jour est dans le futur par rapport à aujourd'hui, on ne le compte pas comme raté
        if (iso > todayIso) {
          // Semaine en cours non encore terminée : on ne compte que si on a au moins un jour passé et tous les passés faits
          continue;
        }
        if (!histSet.has(iso)) { allDone = false; break; }
      }
      if (!allDone) break;
      count++;
      cursorEnd = dayBack(cursorEnd, 7);
      // Stop si on dépasse createdAt
      const created = item.createdAt ? new Date(item.createdAt) : null;
      if (created && cursorEnd < created) break;
    }
    return { count, periodLabel: 'semaines' };
  }

  // HEBDO multi-jours (1+ jours sélectionnés, intervalle 1) : période = semaine. Réussite = tous les jours d'occurrence de la semaine sont cochés.
  if (r.rule === 'weekly' && (r.interval || 1) === 1) {
    const wd = r.weekdays || [];
    if (wd.length === 0) return { count: 0, periodLabel: 'semaines' };
    let count = 0;
    let cursorEnd = todayObj;
    while (true) {
      const range = weekRangeOf(cursorEnd);
      const monday = isoToDate(range.start);
      let allDone = true;
      for (let i = 0; i < 7; i++) {
        const d = new Date(monday); d.setDate(monday.getDate() + i);
        const dow = d.getDay();
        if (!wd.includes(dow)) continue;
        const iso = isoOf(d);
        if (iso > todayIso) continue;
        if (!histSet.has(iso)) { allDone = false; break; }
      }
      if (!allDone) break;
      count++;
      cursorEnd = dayBack(cursorEnd, 7);
      const created = item.createdAt ? new Date(item.createdAt) : null;
      if (created && cursorEnd < created) break;
    }
    return { count, periodLabel: 'semaines' };
  }

  // MENSUEL : période = mois. Réussite = au moins une complétion ce mois-ci sur le bon jour (ou fallback fin de mois).
  if (r.rule === 'monthly' && (r.interval || 1) === 1) {
    let count = 0;
    let cursorMonth = new Date(todayObj.getFullYear(), todayObj.getMonth(), 1);
    while (true) {
      const lastDay = new Date(cursorMonth.getFullYear(), cursorMonth.getMonth() + 1, 0).getDate();
      const targetDay = Math.min(r.monthDay || 1, lastDay);
      const occDate = new Date(cursorMonth.getFullYear(), cursorMonth.getMonth(), targetDay);
      const occIso = isoOf(occDate);
      // Si l'occurrence du mois est dans le futur, on ne compte pas le mois comme raté (mois en cours)
      if (occIso > todayIso) {
        cursorMonth = monthBack(cursorMonth, 1);
        continue;
      }
      if (!histSet.has(occIso)) break;
      count++;
      cursorMonth = monthBack(cursorMonth, 1);
      const created = item.createdAt ? new Date(item.createdAt) : null;
      if (created && cursorMonth < new Date(created.getFullYear(), created.getMonth(), 1)) break;
    }
    return { count, periodLabel: 'mois' };
  }

  // ANNUEL : période = année. Réussite = occurrence de l'année cochée.
  if (r.rule === 'yearly' && (r.interval || 1) === 1) {
    let count = 0;
    let cursorYear = todayObj.getFullYear();
    const targetMonth = (typeof r.month === 'number') ? r.month : 0;
    const targetDayBase = r.monthDay || 1;
    while (true) {
      // Gestion 29 février années non bissextiles
      const lastDay = new Date(cursorYear, targetMonth + 1, 0).getDate();
      const targetDay = Math.min(targetDayBase, lastDay);
      const occDate = new Date(cursorYear, targetMonth, targetDay);
      const occIso = isoOf(occDate);
      if (occIso > todayIso) {
        cursorYear--;
        continue;
      }
      // Cas 29 février non-bissextile : pas d'occurrence cette année, on saute sans casser le streak
      if (targetDayBase === 29 && targetMonth === 1 && targetDay !== 29) {
        cursorYear--;
        continue;
      }
      if (!histSet.has(occIso)) break;
      count++;
      cursorYear--;
      const created = item.createdAt ? new Date(item.createdAt) : null;
      if (created && cursorYear < created.getFullYear()) break;
    }
    return { count, periodLabel: 'années' };
  }

  // FLOTTANTE HEBDO : période = semaine. Réussite = quota N atteint.
  if (r.rule === 'floatingWeekly') {
    const target = r.count || 1;
    let count = 0;
    let cursorEnd = todayObj;
    while (true) {
      const range = weekRangeOf(cursorEnd);
      const inWeek = history.filter(d => d >= range.start && d <= range.end).length;
      // Semaine en cours : on ne casse pas le streak, on s'arrête juste sans la compter (si pas atteinte)
      const isCurrent = (range.start <= todayIso && todayIso <= range.end);
      if (isCurrent) {
        if (inWeek >= target) count++;
        // Pas de break : on remonte
      } else {
        if (inWeek < target) break;
        count++;
      }
      cursorEnd = dayBack(cursorEnd, 7);
      const created = item.createdAt ? new Date(item.createdAt) : null;
      if (created && cursorEnd < created) break;
    }
    return { count, periodLabel: 'semaines' };
  }

  // FLOTTANTE MENSUELLE : période = mois.
  if (r.rule === 'floatingMonthly') {
    const target = r.count || 1;
    let count = 0;
    let cursorMonth = new Date(todayObj.getFullYear(), todayObj.getMonth(), 1);
    while (true) {
      const range = monthRangeOf(cursorMonth);
      const inMonth = history.filter(d => d >= range.start && d <= range.end).length;
      const isCurrent = cursorMonth.getFullYear() === todayObj.getFullYear() && cursorMonth.getMonth() === todayObj.getMonth();
      if (isCurrent) {
        if (inMonth >= target) count++;
      } else {
        if (inMonth < target) break;
        count++;
      }
      cursorMonth = monthBack(cursorMonth, 1);
      const created = item.createdAt ? new Date(item.createdAt) : null;
      if (created && cursorMonth < new Date(created.getFullYear(), created.getMonth(), 1)) break;
    }
    return { count, periodLabel: 'mois' };
  }

  // Fallback (custom, intervalles > 1) : compte les complétions
  return { count: history.length, periodLabel: 'fois' };
}

// V3 S5.5 : Génère les "barres" d'historique adaptées au type de récurrence
// Renvoie { mode, bars: [{ key, label, dayLetter?, fill (0..1), status, isOccurrenceDay? }], header? }
// mode : 'daily7' | 'weekdays5' | 'weeklyFix7' | 'monthly6m' | 'yearly12m' | 'floatingWeek7' | 'floatingMonth' | 'fallback14d'
function getStreakBars(item, todayObj) {
  const r = item.recurrence;
  const todayIso = dateToISO(todayObj);
  const history = item.history || [];
  // Lundi de la semaine ISO (1) → dimanche (7), labels jour LMMJVSD
  const dayLetters = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

  // Helper : génère 7 jours lun→dim contenant todayObj
  const last7DaysMonSun = () => {
    const out = [];
    const d = new Date(todayObj.getFullYear(), todayObj.getMonth(), todayObj.getDate());
    const dow = d.getDay() || 7; // L=1 .. D=7
    const monday = new Date(d); monday.setDate(d.getDate() - (dow - 1));
    for (let i = 0; i < 7; i++) {
      const x = new Date(monday); x.setDate(monday.getDate() + i);
      out.push({ date: dateToISO(x), dateObj: x, dayLetter: dayLetters[i] });
    }
    return out;
  };

  if (!r) {
    // Tâche non récurrente avec streak (cas exotique) : fallback 14j
    const out = [];
    for (let i = 13; i >= 0; i--) {
      const d = dateToISO(new Date(Date.now() - i * 86400000));
      out.push({ key: d, label: d, fill: history.includes(d) ? 1 : 0, status: history.includes(d) ? 'done' : 'empty' });
    }
    return { mode: 'fallback14d', bars: out };
  }

  // QUOTIDIEN : 7 derniers jours, lun→dim, lettres
  if (r.rule === 'daily' && (r.interval || 1) === 1) {
    const days = last7DaysMonSun();
    return {
      mode: 'daily7',
      bars: days.map(d => ({
        key: d.date,
        label: d.date,
        dayLetter: d.dayLetter,
        fill: history.includes(d.date) ? 1 : 0,
        status: history.includes(d.date) ? 'done' : (d.date <= todayIso ? 'missed' : 'future'),
      })),
    };
  }

  // LUN-VEN : 5 jours lun→ven
  const isWeekdaysPattern = r.rule === 'weekly' && (r.interval || 1) === 1 && r.weekdays?.length === 5 && r.weekdays.every(x => x >= 1 && x <= 5);
  if (isWeekdaysPattern) {
    const days = last7DaysMonSun().slice(0, 5); // L M M J V
    return {
      mode: 'weekdays5',
      bars: days.map(d => ({
        key: d.date,
        label: d.date,
        dayLetter: d.dayLetter,
        fill: history.includes(d.date) ? 1 : 0,
        status: history.includes(d.date) ? 'done' : (d.date <= todayIso ? 'missed' : 'future'),
      })),
    };
  }

  // HEBDO DATE FIXE (weekly à jours précis) : 7 jours, distinguer jours d'occurrence vs hors-occurrence
  if (r.rule === 'weekly' && (r.interval || 1) === 1) {
    const days = last7DaysMonSun();
    const wd = r.weekdays || [];
    return {
      mode: 'weeklyFix7',
      bars: days.map(d => {
        const dow = d.dateObj.getDay();
        const isOcc = wd.includes(dow);
        const done = history.includes(d.date);
        let status;
        if (!isOcc) status = 'noOccurrence';
        else if (done) status = 'done';
        else if (d.date <= todayIso) status = 'missed';
        else status = 'future';
        return {
          key: d.date,
          label: d.date,
          dayLetter: d.dayLetter,
          fill: done ? 1 : 0,
          status,
          isOccurrenceDay: isOcc,
        };
      }),
    };
  }

  // MENSUEL : 6 derniers mois, 1 case par mois
  if (r.rule === 'monthly' && (r.interval || 1) === 1) {
    const monthShort = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];
    const out = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(todayObj.getFullYear(), todayObj.getMonth() - i, 1);
      const monthIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      // Une occurrence du mois faite si une entrée history du mois existe
      const monthDone = history.some(h => h.startsWith(monthIso));
      const isCurrent = (i === 0);
      let status;
      if (monthDone) status = 'done';
      else if (isCurrent) status = 'pending';
      else status = 'missed';
      out.push({
        key: monthIso,
        label: `${monthShort[d.getMonth()]} ${d.getFullYear()}`,
        fill: monthDone ? 1 : 0,
        status,
      });
    }
    return { mode: 'monthly6m', bars: out };
  }

  // ANNUEL : 12 mois de l'année courante, 1 case par mois (case "active" sur le mois ciblé)
  if (r.rule === 'yearly' && (r.interval || 1) === 1) {
    const monthShort = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    const targetMonth = (typeof r.month === 'number') ? r.month : null;
    const year = todayObj.getFullYear();
    const out = [];
    for (let m = 0; m < 12; m++) {
      const monthIso = `${year}-${String(m + 1).padStart(2, '0')}`;
      const monthDone = history.some(h => h.startsWith(monthIso));
      const isOcc = (targetMonth === null) || (m === targetMonth);
      const isCurrent = (m === todayObj.getMonth());
      let status;
      if (!isOcc) status = 'noOccurrence';
      else if (monthDone) status = 'done';
      else if (m < todayObj.getMonth() || (m === todayObj.getMonth() && false)) status = 'missed';
      else status = isCurrent ? 'pending' : 'future';
      out.push({
        key: monthIso,
        label: `${monthShort[m]} ${year}`,
        dayLetter: monthShort[m],
        fill: monthDone ? 1 : 0,
        status,
        isOccurrenceDay: isOcc,
      });
    }
    return { mode: 'yearly12m', bars: out };
  }

  // FLOTTANTE HEBDO : 7 jours lun→dim, fill = 1 si une complétion ce jour-là
  if (r.rule === 'floatingWeekly') {
    const days = last7DaysMonSun();
    return {
      mode: 'floatingWeek7',
      bars: days.map(d => ({
        key: d.date,
        label: d.date,
        dayLetter: d.dayLetter,
        fill: history.includes(d.date) ? 1 : 0,
        status: history.includes(d.date) ? 'done' : 'empty',
      })),
    };
  }

  // FLOTTANTE MENSUELLE : tous les jours du mois courant (28-31 cases)
  if (r.rule === 'floatingMonthly') {
    const year = todayObj.getFullYear();
    const month = todayObj.getMonth();
    const lastDay = new Date(year, month + 1, 0).getDate();
    const out = [];
    for (let day = 1; day <= lastDay; day++) {
      const d = new Date(year, month, day);
      const iso = dateToISO(d);
      out.push({
        key: iso,
        label: iso,
        fill: history.includes(iso) ? 1 : 0,
        status: history.includes(iso) ? 'done' : (iso <= todayIso ? 'missed' : 'future'),
      });
    }
    return { mode: 'floatingMonth', bars: out };
  }

  // Fallback (custom ou intervalle > 1) : 14 derniers jours
  const out = [];
  for (let i = 13; i >= 0; i--) {
    const d = dateToISO(new Date(Date.now() - i * 86400000));
    out.push({ key: d, label: d, fill: history.includes(d) ? 1 : 0, status: history.includes(d) ? 'done' : 'empty' });
  }
  return { mode: 'fallback14d', bars: out };
}

// Label compact pour le chip récurrence
function recurrenceShortLabel(r) {
  if (!r) return '';
  const i = r.interval || 1;
  if (r.rule === 'daily' || r.rule === 'interval') {
    return i === 1 ? 'tous les jours' : `tous les ${i}j`;
  }
  if (r.rule === 'weekly') {
    const dows = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
    if (!r.weekdays || r.weekdays.length === 0) return 'hebdo';
    if (r.weekdays.length === 7) return 'tous les jours';
    if (r.weekdays.length === 5 && r.weekdays.every(d => d >= 1 && d <= 5)) return 'lun-ven';
    if (r.weekdays.length === 2 && r.weekdays.includes(0) && r.weekdays.includes(6)) return 'week-end';
    const sorted = [...r.weekdays].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    return sorted.map(d => dows[d]).join(' ');
  }
  if (r.rule === 'monthly') {
    return i === 1 ? `le ${r.monthDay} du mois` : `le ${r.monthDay}, ts les ${i}m`;
  }
  if (r.rule === 'floatingWeekly') {
    return `${r.count || 1}×/semaine`;
  }
  if (r.rule === 'floatingMonthly') {
    return `${r.count || 1}×/mois`;
  }
  if (r.rule === 'yearly') {
    const monthNames = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'aoû', 'sep', 'oct', 'nov', 'déc'];
    const m = (typeof r.month === 'number') ? monthNames[r.month] : '';
    if (!m) return i === 1 ? 'chaque année' : `tous les ${i} ans`;
    return i === 1 ? `le ${r.monthDay} ${m}` : `le ${r.monthDay} ${m}, ts les ${i} ans`;
  }
  return '';
}

// ============ DURATION : SOMME DES SOUS-TÂCHES ============
// Renvoie la durée effective d'un item :
// - Si durationManualOverride === true OU pas de sous-tâches : item.duration tel quel
// - Sinon : somme récursive des durées des sous-tâches
function effectiveDurationMinutes(item) {
  if (item.durationManualOverride) return durationToMinutes(item.duration);
  if (!item.subtasks || item.subtasks.length === 0) return durationToMinutes(item.duration);
  return item.subtasks.reduce((sum, s) => sum + effectiveDurationMinutes(s), 0);
}

// Renvoie l'objet duration auto (recomposé en h/min) à partir d'un total minutes
function minutesToDuration(min) {
  if (!min) return null;
  const weeks = Math.floor(min / (7 * 24 * 60)); min -= weeks * 7 * 24 * 60;
  const days = Math.floor(min / (24 * 60)); min -= days * 24 * 60;
  const hours = Math.floor(min / 60); min -= hours * 60;
  return { weeks: weeks || 0, days: days || 0, hours: hours || 0, minutes: min || 0 };
}

// Somme directe des durées effectives des sous-tâches d'un item
function effectiveSubtaskSum(item) {
  if (!item.subtasks || item.subtasks.length === 0) return 0;
  return item.subtasks.reduce((sum, s) => sum + effectiveDurationMinutes(s), 0);
}

// V3 S4 : Tri auto par défaut
// Hiérarchie : Important → Deadline → Date prévue → Durée courte → Énergie faible → CreatedAt
// Logique TDAH : enchainer les petits trucs amorce le momentum.
const ENERGY_ORDER = { low: 0, medium: 1, high: 2 };
function sortItemsAuto(items) {
  const arr = [...items];
  arr.sort((a, b) => {
    // Important d'abord
    const aImp = a.isImportant ? 1 : 0;
    const bImp = b.isImportant ? 1 : 0;
    if (aImp !== bImp) return bImp - aImp;
    // Deadline
    const aDl = a.deadline || null;
    const bDl = b.deadline || null;
    if (aDl && !bDl) return -1;
    if (!aDl && bDl) return 1;
    if (aDl && bDl && aDl !== bDl) return aDl < bDl ? -1 : 1;
    // Date prévue
    const aDate = a.date || null;
    const bDate = b.date || null;
    if (aDate && !bDate) return -1;
    if (!aDate && bDate) return 1;
    if (aDate && bDate && aDate !== bDate) return aDate < bDate ? -1 : 1;
    // Durée courte d'abord (amorce momentum). 0 = sans durée → traité comme moyen-long (en bas).
    const aDur = effectiveDurationMinutes(a) || 9999;
    const bDur = effectiveDurationMinutes(b) || 9999;
    if (aDur !== bDur) return aDur - bDur;
    // Énergie faible d'abord
    const aE = ENERGY_ORDER[a.energy] !== undefined ? ENERGY_ORDER[a.energy] : 1;
    const bE = ENERGY_ORDER[b.energy] !== undefined ? ENERGY_ORDER[b.energy] : 1;
    if (aE !== bE) return aE - bE;
    // CreatedAt asc
    return (a.createdAt || 0) - (b.createdAt || 0);
  });
  return arr;
}

// V3 S4 : archive immédiate (plus de seuil 7j)
// Filets de sécurité : toast undo 5s, Cmd+Z, restauration depuis vue Archive
function isArchived(item) {
  if (!item.completed) return false;
  if (!item.completedAt) return false;
  return true;
}

// V3 S4 : recherche full-text (insensible casse/accents)
function normalize(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function itemMatchesSearch(item, query, scopes) {
  if (!query) return true;
  const q = normalize(query);
  if (scopes.titles && normalize(item.title).includes(q)) return true;
  if (scopes.notes && normalize(item.notes).includes(q)) return true;
  if (scopes.subtasks && item.subtasks) {
    for (const sub of item.subtasks) {
      if (itemMatchesSearch(sub, query, scopes)) return true;
    }
  }
  return false;
}

// V3 S4 : filtres avancés
function itemMatchesFilters(item, filters) {
  // Énergie
  if (filters.energy && filters.energy.length > 0) {
    if (!filters.energy.includes(item.energy)) return false;
  }
  // Durée (en minutes effective)
  if (filters.duration && filters.duration.length > 0) {
    const min = effectiveDurationMinutes(item);
    const matchAny = filters.duration.some(bucket => {
      if (bucket === 'short') return min > 0 && min < 15;
      if (bucket === 'mid') return min >= 15 && min <= 30;
      if (bucket === 'long') return min > 30 && min <= 60;
      if (bucket === 'xlong') return min > 60;
      if (bucket === 'none') return min === 0;
      return false;
    });
    if (!matchAny) return false;
  }
  // Deadline
  if (filters.deadline && filters.deadline.length > 0) {
    const today = todayISO();
    const todayD = new Date(today + 'T00:00:00');
    const matchAny = filters.deadline.some(bucket => {
      if (bucket === 'overdue') {
        if (!item.deadline) return false;
        return item.deadline < today;
      }
      if (bucket === 'today') return item.deadline === today;
      if (bucket === 'week') {
        if (!item.deadline) return false;
        const dl = new Date(item.deadline + 'T00:00:00');
        const diff = (dl - todayD) / 86400000;
        return diff >= 0 && diff <= 7;
      }
      if (bucket === 'month') {
        if (!item.deadline) return false;
        const dl = new Date(item.deadline + 'T00:00:00');
        const diff = (dl - todayD) / 86400000;
        return diff >= 0 && diff <= 31;
      }
      if (bucket === 'quarter') {
        if (!item.deadline) return false;
        const dl = new Date(item.deadline + 'T00:00:00');
        const diff = (dl - todayD) / 86400000;
        return diff >= 0 && diff <= 92;
      }
      if (bucket === 'none') return !item.deadline;
      return false;
    });
    if (!matchAny) return false;
  }
  // Catégorie
  if (filters.category && filters.category.length > 0) {
    if (!filters.category.includes(item.categoryId || '__none__')) {
      // si pas de catégorie, on autorise __none__
      if (item.categoryId || !filters.category.includes('__none__')) return false;
    }
  }
  return true;
}
function hasActiveFilters(filters) {
  return (filters.energy?.length || 0) + (filters.duration?.length || 0) + (filters.deadline?.length || 0) + (filters.category?.length || 0) > 0;
}

// V3 S4 : items "en retard" (date passée OU occurrence récurrente passée non cochée OU sous-tâche en retard)
function findOverdueRoots(items, todayIso) {
  // Renvoie une liste plate { item, type, sourceDate } d'items dont la date prévue est passée et non complétés
  // Inclut sous-tâches en retard (héritées si parent date < today)
  const result = [];
  function walk(list, parent = null) {
    for (const it of list) {
      // V3 S5 : les tâches "routine" (streak) et les récurrences flottantes ne génèrent pas d'overdue
      if (it.streak) continue;
      if (isFloatingRecurrence(it.recurrence)) continue;
      if (it.completed) continue;
      // One-shot avec date passée
      if (it.date && it.date < todayIso && !it.recurrence) {
        result.push({ item: it, parent, sourceDate: it.date });
      }
      // Récurrent : occurrences manquées des 14 derniers jours
      // (limite à 14j pour éviter l'explosion)
      if (it.recurrence) {
        const fromIso = (() => {
          const d = new Date(todayIso + 'T00:00:00');
          d.setDate(d.getDate() - 14);
          return dateToISO(d);
        })();
        const toIso = (() => {
          const d = new Date(todayIso + 'T00:00:00');
          d.setDate(d.getDate() - 1);
          return dateToISO(d);
        })();
        const occs = getOccurrencesInRange(it, fromIso, toIso);
        for (const o of occs) {
          const ex = (it.exceptions || {})[o.date];
          if (ex === 'completed' || ex === 'deleted' || ex === 'skipped') continue;
          result.push({ item: it, parent, sourceDate: o.date });
        }
      }
      if (it.subtasks?.length) walk(it.subtasks, it);
    }
  }
  walk(items);
  // Tri : plus ancien d'abord
  result.sort((a, b) => (a.sourceDate < b.sourceDate ? -1 : 1));
  return result;
}

// ============ MIGRATION SCHEMA V3 ============
const SCHEMA_VERSION = 14;

function migrateItem(item) {
  // Type recurring → task avec recurrence quotidienne par défaut
  let type = item.type || 'task';
  let recurrence = item.recurrence !== undefined ? item.recurrence : null;
  if (type === 'recurring') {
    type = 'task';
    if (recurrence === null) recurrence = { rule: 'daily', interval: 1, weekdays: [], monthDay: null, endDate: null, endAfter: null };
  }
  // Habitudes : convertir frequency → recurrence
  let wasHabit = (type === 'habit');
  if (type === 'habit' && (recurrence === null || recurrence === undefined)) {
    const freq = item.frequency;
    if (freq === 'weekdays') {
      recurrence = { rule: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5], monthDay: null, endDate: null, endAfter: null };
    } else if (freq === 'weekly') {
      // Option 2 : lundi par défaut
      recurrence = { rule: 'weekly', interval: 1, weekdays: [1], monthDay: null, endDate: null, endAfter: null };
    } else {
      // 'daily' ou rien
      recurrence = { rule: 'daily', interval: 1, weekdays: [], monthDay: null, endDate: null, endAfter: null };
    }
  }
  // V3 S5 : fusion habit → task + streak: true
  // Si l'habitude n'avait pas de récurrence post-migration (cas tordu), on force daily
  if (wasHabit && !recurrence) {
    recurrence = { rule: 'daily', interval: 1, weekdays: [], monthDay: null, endDate: null, endAfter: null };
  }
  const streak = wasHabit ? true : (item.streak === true);
  const finalType = (type === 'habit') ? 'task' : type;
  // Nettoyer les champs obsolètes : frequency (S5) + champs morts du streak retirés en V5 (schema v14)
  const { frequency, streakCount: _deadStreakCount, graceDays: _deadGraceDays, lastEvaluatedPeriod: _deadLastEval, ...rest } = item;
  return {
    ...rest,
    type: finalType,
    recurrence,
    streak,
    lastCompletedDate: item.lastCompletedDate !== undefined ? item.lastCompletedDate : null,
    history: item.history || [],
    deadline: item.deadline !== undefined ? item.deadline : null,
    exceptions: item.exceptions || {},
    durationManualOverride: item.durationManualOverride || false,
    // V3 S4 (schema v5)
    completedAt: item.completedAt !== undefined ? item.completedAt : (item.completed ? null : null),
    isImportant: item.isImportant || false,
    // V3 S4.5 (schema v6) : préparation + trajet sur les RDV importants
    prepDuration: item.prepDuration !== undefined ? item.prepDuration : null,
    travelDuration: item.travelDuration !== undefined ? item.travelDuration : null,
    travelReturn: item.travelReturn !== undefined ? item.travelReturn : false,
    // V5 (schema v14) : durée du trajet retour si différente de l'aller (null = identique à l'aller)
    travelReturnDuration: item.travelReturnDuration !== undefined ? item.travelReturnDuration : null,
    // V3 S(A+B) schema v8 : épinglage en haut de colonne
    pinned: item.pinned || false,
    // V3 S(D) schema v9 : routines multi-créneaux par jour
    times: Array.isArray(item.times) ? item.times : [],
    slotHistory: (item.slotHistory && typeof item.slotHistory === 'object') ? item.slotHistory : {},
    // V4 4a.1 (schema v10) : filiation optionnelle tâche → cap (objectif ou nœud projet/jalon)
    capId: item.capId !== undefined ? item.capId : null,
    // V4 4b (schema v12) : piliers servis (facultatif) + ressenti a posteriori (☀️ up / 😴 down)
    pillars: Array.isArray(item.pillars) ? item.pillars : [],
    feel: item.feel !== undefined ? item.feel : null,
    subtasks: (item.subtasks || []).map(migrateItem),
  };
}

// V4 4a.2 (schema v11) : horodatages de statut + journal des décisions sur chaque cap
function migrateCap(node) {
  return {
    ...node,
    reachedAt: node.reachedAt !== undefined ? node.reachedAt : null,
    statusChangedAt: node.statusChangedAt !== undefined ? node.statusChangedAt : null,
    decisions: Array.isArray(node.decisions) ? node.decisions : [],
    pillars: Array.isArray(node.pillars) ? node.pillars : [], // V4 4b
    children: (node.children || []).map(migrateCap),
  };
}

function migrateState(state) {
  if (state.schemaVersion >= SCHEMA_VERSION) return state;
  return {
    ...state,
    items: (state.items || []).map(migrateItem),
    dailyIntentions: state.dailyIntentions || {},
    // V4 4a.1 : arbre des caps + visions (texte libre lié)
    caps: (state.caps || []).map(migrateCap),
    visions: state.visions || [],
    // V4 4a.2 : mode bas régime (kill-switch de toute confrontation)
    lowMode: state.lowMode || { on: false, since: null },
    // V4 4a.3 : rituels (hebdo + focale mensuelle) et focus de la semaine
    reviews: state.reviews || { weekly: {}, monthly: {} },
    weeklyFocus: state.weeklyFocus || {},
    // V4 4b : ce que j'arrête (streak inversé : réussir = ne pas craquer)
    quits: state.quits || [],
    // V4 4c : argent (opérations ponctuelles + flux récurrents)
    money: state.money || { entries: [], flows: [] },
    // V4 4f (schema v13) : journal des pomodoros terminés (prime time observé passivement)
    focusLog: state.focusLog || [],
    schemaVersion: SCHEMA_VERSION,
  };
}

// Normalise un état chargé (local, cloud ou import). Les clés inconnues sont CONSERVÉES
// (compatibilité ascendante : une version plus ancienne ne doit jamais effacer des données
// qu'elle ne connaît pas encore).
function normalizeLoadedState(raw) {
  const r = raw || {};
  return migrateState({
    ...r,
    items: r.items || [],
    categories: r.categories || DEFAULT_CATEGORIES,
    settings: { ...DEFAULT_SETTINGS, ...(r.settings || {}) },
    capacity: r.capacity || {},
    dailyIntentions: r.dailyIntentions || {},
    caps: r.caps || [],
    visions: r.visions || [],
    lowMode: r.lowMode || { on: false, since: null },
    reviews: { weekly: {}, monthly: {}, ...(r.reviews || {}) },
    weeklyFocus: r.weeklyFocus || {},
    quits: r.quits || [],
    money: { entries: [], flows: [], ...(r.money || {}) },
    focusLog: r.focusLog || [],
    schemaVersion: r.schemaVersion || 0,
  });
}

// ============ DEFAULT STATE ============
const DEFAULT_CATEGORIES = [
  { id: 'cat-work', name: 'Travail', color: '#2C5F7C' },
  { id: 'cat-perso', name: 'Perso', color: '#5C7A3E' },
  { id: 'cat-sante', name: 'Santé', color: '#B8482E' },
  { id: 'cat-admin', name: 'Admin', color: '#C68729' },
];

const ENERGY_PRESETS = [
  { id: 'rocket', emoji: '🚀', label: 'Fusée', hours: 8, desc: 'Mode pleine forme' },
  { id: 'normal', emoji: '☀️', label: 'Normale', hours: 6, desc: 'Journée standard' },
  { id: 'calm', emoji: '🌿', label: 'Tranquille', hours: 4, desc: 'À mon rythme' },
  { id: 'survival', emoji: '🌧️', label: 'Survie', hours: 2, desc: 'On fait au mieux' },
];

const DEFAULT_SETTINGS = {
  pomoFocus: 25,
  pomoBreak: 5,
  pomoLongBreak: 15,
  pomoCyclesBeforeLongBreak: 4,
  theme: 'light',
  // V3 S5 : afficher les tâches récurrentes en vue Priorités (Inbox + Must/Should/Want)
  // Off par défaut : les récurrentes vivent en agenda Jour + onglet Routines
  showRecurringInPriorities: false,
};

// ============ CAPS — modèle V4 4a.1 (helpers purs) ============
// Arbre des caps : objectifs à la racine (state.caps), chaque nœud porte children[].
// Objectif (kind:'objective') et Projet/Jalon (kind:'node') partagent la même récursivité.
// Le rendu Projet vs Jalon dépend de la profondeur, pas du type (voir BoussoleView).
const CAP_STATUSES = ['active', 'reached', 'paused', 'abandoned'];

function makeVision(data) {
  return { id: generateId(), text: (data && data.text) || '', createdAt: Date.now() };
}
function makeObjective(data = {}) {
  return {
    id: generateId(), kind: 'objective',
    title: data.title || 'Sans titre',
    why: data.why || '',
    visionLink: data.visionLink || null,
    deadline: data.deadline || null,
    measure: data.measure || null, // { mode:'none'|'binary'|'numeric', target, unit, current }
    status: 'active',
    children: [],
    createdAt: Date.now(),
    reachedAt: null, statusChangedAt: null, decisions: [], pillars: data.pillars || [],
  };
}
function makeCapNode(data = {}) {
  return {
    id: generateId(), kind: 'node',
    title: data.title || 'Sans titre',
    why: data.why || '',
    deliverable: data.deliverable || '',
    deadline: data.deadline || null,
    measure: data.measure || null, // V4 4a.1+ : mesure optionnelle aussi sur projet/jalon
    status: 'active',
    children: [],
    createdAt: Date.now(),
    reachedAt: null, statusChangedAt: null, decisions: [], pillars: data.pillars || [],
  };
}

// Recherche d'un nœud (objectif ou node) n'importe où dans la forêt
function findCapNode(list, id) {
  for (const n of list) {
    if (n.id === id) return n;
    if (n.children?.length) {
      const f = findCapNode(n.children, id);
      if (f) return f;
    }
  }
  return null;
}
// Update immuable d'un nœud par id (patch objet ou fonction)
function updateCapTree(list, id, patch) {
  return list.map(n => {
    if (n.id === id) return { ...n, ...(typeof patch === 'function' ? patch(n) : patch) };
    return n.children?.length ? { ...n, children: updateCapTree(n.children, id, patch) } : n;
  });
}
// Insertion d'un enfant sous parentId (parent = objectif ou node)
function insertCapChild(list, parentId, child) {
  return list.map(n => {
    if (n.id === parentId) return { ...n, children: [...(n.children || []), child] };
    return n.children?.length ? { ...n, children: insertCapChild(n.children, parentId, child) } : n;
  });
}
// Suppression d'un nœud et de tout son sous-arbre
function deleteCapTree(list, id) {
  return list.filter(n => n.id !== id).map(n => n.children?.length ? { ...n, children: deleteCapTree(n.children, id) } : n);
}
// Tous les ids d'un sous-arbre (pour nettoyer les capId orphelins à la suppression)
function collectCapIds(node) {
  return [node.id, ...((node.children || []).flatMap(collectCapIds))];
}
// Déplacement haut/bas d'un nœud parmi ses frères (dir = -1 monter, +1 descendre)
function moveCapSibling(list, id, dir) {
  const idx = list.findIndex(n => n.id === id);
  if (idx !== -1) {
    const ni = idx + dir;
    if (ni < 0 || ni >= list.length) return list;
    const copy = [...list];
    [copy[idx], copy[ni]] = [copy[ni], copy[idx]];
    return copy;
  }
  return list.map(n => n.children?.length ? { ...n, children: moveCapSibling(n.children, id, dir) } : n);
}
// Chemin objectif→…→nœud (array de nœuds). null si introuvable.
function capPathById(caps, id) {
  function dig(node, acc) {
    if (node.id === id) return acc;
    for (const c of (node.children || [])) {
      const r = dig(c, [...acc, c]);
      if (r) return r;
    }
    return null;
  }
  for (const o of caps) {
    const r = dig(o, [o]);
    if (r) return r;
  }
  return null;
}
// Libellé court du nœud direct lié (pour le chip de carte)
function capDirectLabel(caps, id) {
  const node = findCapNode(caps, id);
  return node ? node.title : null;
}
// Lignée lisible ["Vision","Objectif","Projet","Jalon"]. visions optionnel.
function capLineageLabel(caps, visions, id) {
  const path = capPathById(caps, id);
  if (!path) return null;
  const parts = path.map(n => n.title || '—');
  const obj = path[0];
  if (obj && obj.visionLink && Array.isArray(visions)) {
    const v = visions.find(x => x.id === obj.visionLink);
    if (v && v.text) parts.unshift(v.text.split('\n')[0].slice(0, 40));
  }
  return parts;
}
// Type d'affichage d'un nœud selon sa profondeur sous l'objectif :
// depth 0 = objectif, depth 1 = projet, depth ≥2 = jalon
function capDisplayKind(depth) {
  if (depth === 0) return 'objective';
  if (depth === 1) return 'project';
  return 'milestone';
}
// Avancement = enfants directs franchis / total (jamais récursif profond)
function capProgress(node) {
  const kids = node.children || [];
  if (!kids.length) return null;
  const done = kids.filter(c => c.status === 'reached').length;
  return { done, total: kids.length };
}

// ============ CAPS — V4 4a.2 : pace + confrontation ============
// Signal de pace, porté par les jalons DATÉS (enfants directs), jamais de tracking d'heures.
// Ne s'applique qu'aux projets/jalons (depth ≥ 1) — jamais aux objectifs ni à la vision.
// Retourne null si aucun jalon daté (pas de fausse précision), sinon :
//   'still'  : rien n'a bougé alors qu'une échéance est passée
//   'behind' : un jalon échu attend encore
//   'ahead'  : au moins un jalon franchi avant sa date, rien d'échu en attente
//   'ok'     : ça colle au calendrier
function capPace(node, today = todayISO()) {
  const dated = (node.children || []).filter(c => c.deadline && c.status !== 'abandoned');
  if (!dated.length) return null;
  const overdueOpen = dated.filter(c => c.status === 'active' && c.deadline < today);
  const reached = (node.children || []).filter(c => c.status === 'reached');
  if (overdueOpen.length && !reached.length) return 'still';
  if (overdueOpen.length) return 'behind';
  const early = dated.filter(c => c.status === 'reached' && c.reachedAt && dateToISO(new Date(c.reachedAt)) < c.deadline);
  if (early.length) return 'ahead';
  return 'ok';
}
const PACE_LABELS = { still: 'rien n\'a bougé', behind: 'un jalon attend', ok: 'ça colle', ahead: 'en avance' };

// La question « échéance passée » est-elle due sur ce nœud ? (projet/jalon actif, deadline dépassée,
// pas encore de réponse pour CETTE échéance ; « plus tard » la fait taire 7 jours)
const CAP_LATER_MS = 7 * 24 * 3600 * 1000;
function capDeadlineQuestionDue(node, depth, today = todayISO(), now = Date.now()) {
  if (depth < 1 || node.status !== 'active' || !node.deadline || node.deadline >= today) return false;
  return !(node.decisions || []).some(d => d.trigger === 'deadline' && d.forDeadline === node.deadline
    && (d.answer !== 'later' || now - d.at < CAP_LATER_MS));
}

// ============ V4 4b : PILIERS ============
// Temps = carburant méta (mesuré, pas tagué). Les 3 piliers vitaux, Sens scindé en Lien + Alignement.
const PILLARS = [
  { id: 'energy', label: 'Énergie', color: '#C68729' },
  { id: 'money', label: 'Argent', color: '#5C7A3E' },
  { id: 'link', label: 'Lien', color: '#B8482E' },
  { id: 'alignment', label: 'Alignement', color: '#6B4E8A' },
];
// Piliers effectifs d'une tâche : les siens, sinon ceux hérités de sa lignée de caps (sans rien stocker)
function capLineagePillars(caps, capId) {
  const path = capId ? capPathById(caps, capId) : null;
  if (!path) return [];
  return [...new Set(path.flatMap(n => n.pillars || []))];
}
function itemPillars(item, caps) {
  return (item.pillars && item.pillars.length) ? item.pillars : capLineagePillars(caps, item.capId);
}
// Ce que j'arrête : jours consécutifs sans craquer (depuis le dernier écart ou le début)
function quitStreak(q, today = todayISO()) {
  const slips = [...(q.slips || [])].filter(d => d <= today).sort();
  const start = slips.length ? addDays(slips[slips.length - 1], 1) : dateToISO(new Date(q.createdAt || Date.now()));
  if (start > today) return 0;
  return Math.round((isoToDate(today) - isoToDate(start)) / 86400000) + 1;
}

// ============ V4 4a.3 : RITUEL HEBDO ============
// Semaine regardée par le rituel : du vendredi au dimanche = la semaine en cours ;
// le lundi = la semaine qui vient de finir (on rattrape le point du week-end).
function reviewWeekFor(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (d.getDay() === 1) d.setDate(d.getDate() - 1);
  const range = weekRange(d);
  const nextMonday = addDays(range.end, 1);
  return { weekId: isoWeekId(d), range, nextMonday, nextWeekId: isoWeekId(isoToDate(nextMonday)) };
}
// Fenêtre d'invitation : vendredi 17h → lundi soir
function isReviewWindow(now = new Date()) {
  const dow = now.getDay();
  return dow === 6 || dow === 0 || dow === 1 || (dow === 5 && now.getHours() >= 17);
}
// Semaine du focus « en cours » : le focus posé au rituel vaut pour la semaine qui suit
function currentFocusWeekId(now = new Date()) { return isoWeekId(now); }

// Dernière activité d'un cap : création/changement de statut/décision du cap et de ses
// descendants + création/complétion des tâches liées au sous-arbre. Aucun stockage.
function capLastActivity(node, allItems) {
  const ids = new Set(collectCapIds(node));
  let last = 0;
  const walk = (n) => {
    last = Math.max(last, n.createdAt || 0, n.statusChangedAt || 0, n.reachedAt || 0,
      ...((n.decisions || []).map(d => d.at || 0)));
    (n.children || []).forEach(walk);
  };
  walk(node);
  allItems.forEach(it => {
    if (it.capId && ids.has(it.capId)) last = Math.max(last, it.createdAt || 0, it.completedAt || 0);
  });
  return last;
}
const CAP_ZOMBIE_MS = 21 * 24 * 3600 * 1000;
// Caps « zombies » : objectifs et projets actifs sans aucune activité depuis ~3 semaines.
// Un projet n'est pas signalé si son objectif l'est déjà (une seule question suffit).
function findZombieCaps(caps, items, now = Date.now()) {
  const all = flattenItems(items);
  const out = [];
  caps.filter(o => o.status === 'active').forEach(o => {
    if (now - capLastActivity(o, all) > CAP_ZOMBIE_MS) { out.push({ node: o, depth: 0 }); return; }
    (o.children || []).filter(p => p.status === 'active').forEach(p => {
      if (now - capLastActivity(p, all) > CAP_ZOMBIE_MS) out.push({ node: p, depth: 1, parent: o });
    });
  });
  return out;
}
// Projets (depth 1) actifs dont le rythme demande un regard (rien n'a bougé / un jalon attend)
function findPaceConcerns(caps, today = todayISO()) {
  const out = [];
  caps.filter(o => o.status === 'active').forEach(o => (o.children || []).filter(p => p.status === 'active').forEach(p => {
    const pace = capPace(p, today);
    if (pace === 'still' || pace === 'behind') {
      out.push({ node: p, parent: o, pace, overdue: (p.children || []).filter(c => c.status === 'active' && c.deadline && c.deadline < today) });
    }
  }));
  return out;
}
// Liste plate des caps actifs (pour choisir le focus) : [{ id, label, depth }]
function activeCapOptions(caps) {
  const out = [];
  const walk = (n, depth, prefix) => {
    if (n.status !== 'active') return;
    const label = prefix ? `${prefix} › ${n.title}` : n.title;
    out.push({ id: n.id, label, depth });
    (n.children || []).forEach(c => walk(c, depth + 1, label));
  };
  caps.forEach(o => walk(o, 0, ''));
  return out;
}

// ============ MAIN APP ============
function CapApp({ session }) {
  const userId = session.user.id;
  const userEmail = session.user.email;
  const STORAGE_KEY_USER = `cap-app-v2-${userId}`;

  // État initial : on commence avec localStorage local (pour responsivité), puis on sync cloud
  const [state, setState] = useState(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_USER);
      if (raw) {
        return normalizeLoadedState(JSON.parse(raw));
      }
    } catch {}
    return normalizeLoadedState({ schemaVersion: SCHEMA_VERSION });
  });

  const [cloudStatus, setCloudStatus] = useState('idle'); // idle | loading | syncing | synced | error
  const [hasLoadedCloud, setHasLoadedCloud] = useState(false);
  const saveTimerRef = useRef(null);
  // V4 4a.1 fix sync : refs pour lire l'état courant dans les handlers de fermeture (closure fraîche)
  const stateRef = useRef(state);
  const hasLoadedCloudRef = useRef(false);
  // FIX SYNC (révisions) : base = n° de révision cloud connu par CE device.
  // Entier monotone → insensible au décalage d'horloge entre appareils.
  const CLOUD_REV_KEY = `${STORAGE_KEY_USER}-cloudrev`;
  const baseRevRef = useRef(null);
  if (baseRevRef.current === null) {
    try { baseRevRef.current = parseInt(localStorage.getItem(CLOUD_REV_KEY) || '0', 10) || 0; } catch { baseRevRef.current = 0; }
  }
  const setBaseRev = (r) => { baseRevRef.current = r; try { localStorage.setItem(CLOUD_REV_KEY, String(r)); } catch {} };
  const skipCloudSaveRef = useRef(false);     // sauter la sauvegarde juste après une adoption cloud
  const cloudSaveInFlightRef = useRef(false); // évite deux écritures cloud concurrentes du même device
  // Refs tenues à jour à chaque rendu (lues par les handlers pagehide/visibilitychange)
  stateRef.current = state;
  hasLoadedCloudRef.current = hasLoadedCloud;
  const [lastSyncedAt, setLastSyncedAt] = useState(null);
  const [syncTick, setSyncTick] = useState(0); // pour forcer rerender de l'indicateur

  const [view, setView] = useState('priorities');
  // V4 4a.1 : éditeur de cap. null = fermé. { mode:'objective'|'node', node?, parentId? }
  const [capEditor, setCapEditor] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAddPrefill, setQuickAddPrefill] = useState(null); // { date, time, priority? }
  const [editingItem, setEditingItem] = useState(null);
  const [editingOccurrenceDate, setEditingOccurrenceDate] = useState(null); // si on édite UNE occurrence d'un item récurrent
  const [pendingScope, setPendingScope] = useState(null); // { kind: 'edit'|'delete', itemId, occDate, patch? }
  const [editingParentId, setEditingParentId] = useState(null);
  const [quickCapture, setQuickCapture] = useState('');
  const quickCaptureRef = useRef(null);
  const [suggestedTask, setSuggestedTask] = useState(null);
  const [showSuggestion, setShowSuggestion] = useState(false);
  const [showCheckin, setShowCheckin] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showReview, setShowReview] = useState(false); // V4 4a.3 : rituel hebdo
  const [focusMode, setFocusMode] = useState(null);
  const [calView, setCalView] = useState('day');
  const [calDate, setCalDate] = useState(todayISO());
  const [confettis, setConfettis] = useState([]);
  const [toast, setToast] = useState(null); // { id, message, action?: { label, onClick } }
  const undoStackRef = useRef([]); // stack profondeur 5

  // V3 S4 : tâche sélectionnée (pour raccourcis 1/2/3 et actions ciblées)
  const [selectedItemId, setSelectedItemId] = useState(null);
  // V3 S4 : ordre manuel par colonne — { must: bool, should: bool, want: bool }
  const [manualOrder, setManualOrder] = useState({ must: false, should: false, want: false });
  // V3 S4 : recherche & filtres
  const [searchQuery, setSearchQuery] = useState('');
  const [searchScopes, setSearchScopes] = useState({ titles: true, notes: true, subtasks: true });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filters, setFilters] = useState({ energy: [], duration: [], deadline: [], category: [] });
  // V3 S4 : view archive
  const [showHeaderBadge, setShowHeaderBadge] = useState(true);

  // Rappels schedulés
  const reminderTimersRef = useRef(new Map()); // itemId -> timeoutId

  // V5 lot 2 : session « Démarrer » — reliée à une tâche, gardée en local sur CET appareil (survit au rechargement).
  // running = { itemId, plan: [min de chaque tranche] | null (pomodoro classique), slice, mode: 'focus'|'break'|'longBreak'|'done',
  //             totalSeconds, endsAt (ms, hors pause), pausedLeft (s, en pause), paused, cycles, startedAt, workedMin }
  // Le temps restant se calcule depuis endsAt (runningLeft) : pas de dérive en arrière-plan ni après une veille.
  const RUNNING_KEY = `${STORAGE_KEY_USER}-running`;
  const [running, setRunning] = useState(() => {
    try {
      const r = JSON.parse(localStorage.getItem(RUNNING_KEY) || 'null');
      return r && r.itemId && r.mode ? r : null;
    } catch { return null; }
  });
  const runningRef = useRef(running);
  runningRef.current = running;
  const commitRunning = (r) => { runningRef.current = r; setRunning(r); };
  const [runTick, setRunTick] = useState(0); // force le rendu du chrono chaque seconde
  const [sessionSummary, setSessionSummary] = useState(null); // V5 lot 2 : bilan après « Fini »

  // V5 lot 4 : notifications push sur CET appareil. status : on | off | denied | unsupported | ios-install | busy
  const PUSH_KEY = `${STORAGE_KEY_USER}-push`;
  const [pushInfo, setPushInfo] = useState(() => {
    let endpoint = null;
    try { endpoint = localStorage.getItem(PUSH_KEY); } catch {}
    const st = pushSupportStatus();
    return { status: endpoint && st === 'off' && Notification.permission === 'granted' ? 'on' : st, endpoint };
  });
  const pushActiveRef = useRef(false);
  pushActiveRef.current = pushInfo.status === 'on';

  // Apply theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', state.settings.theme);
  }, [state.settings.theme]);

  // Adoption d'un état cloud → état local (helper commun load + résolution de conflit)
  const adoptCloud = (cloudData) => normalizeLoadedState(cloudData);

  // Sauvegarde cloud robuste (CAS), partagée par le debounce et le flush.
  const doCloudSave = async () => {
    if (!hasLoadedCloudRef.current) return;
    if (cloudSaveInFlightRef.current) return;
    cloudSaveInFlightRef.current = true;
    try {
      const snapshot = stateRef.current;
      const res = await cloudSaveCAS(userId, snapshot, baseRevRef.current);
      if (res.ok) {
        setBaseRev(res.newRev);
        setLastSyncedAt(Date.now());
        setCloudStatus('synced');
      } else if (res.conflict && res.current && res.current.data && res.current.data.items !== undefined && (res.current.rev || 0) > baseRevRef.current) {
        // Un autre appareil détient une révision plus récente : on NE l'écrase PAS.
        // On stashe d'abord le local non synchronisé (jamais de perte silencieuse), puis on adopte le cloud.
        try { localStorage.setItem(`${STORAGE_KEY_USER}-conflict`, JSON.stringify(snapshot)); } catch {}
        skipCloudSaveRef.current = true;
        setBaseRev(res.current.rev || 0);
        setState(adoptCloud(res.current.data));
        setCloudStatus('synced');
      } else {
        setCloudStatus('error');
      }
    } finally {
      cloudSaveInFlightRef.current = false;
    }
  };

  // ============ CLOUD LOAD au démarrage ============
  // FIX SYNC : décision fondée sur la RÉVISION (monotone), pas sur l'horloge.
  // On n'adopte le cloud que s'il est STRICTEMENT en avance sur la révision connue de ce device.
  useEffect(() => {
    let cancelled = false;
    setCloudStatus('loading');
    cloudLoad(userId).then(res => {
      if (cancelled) return;
      if (res === null) { setHasLoadedCloud(true); setCloudStatus('error'); return; } // erreur réseau → on garde le local
      const cloudData = res.data;
      const cloudRev = res.rev || 0;
      const cloudHasData = cloudData && cloudData.items !== undefined;
      if (cloudHasData && cloudRev > baseRevRef.current) {
        // Le cloud est plus avancé (un autre appareil a écrit après notre dernière sync) → on adopte.
        skipCloudSaveRef.current = true; // pas de réécriture inutile juste après l'adoption
        setState(adoptCloud(cloudData));
        setBaseRev(cloudRev);
      }
      // Sinon local >= cloud → on garde le local ; le persist le repoussera via CAS (fait avancer la révision).
      setHasLoadedCloud(true);
      setCloudStatus('synced');
      setLastSyncedAt(Date.now());
    }).catch(() => {
      if (!cancelled) { setHasLoadedCloud(true); setCloudStatus('error'); }
    });
    return () => { cancelled = true; };
  }, [userId]);

  // ============ FLUSH À LA FERMETURE / NAVIGATION ============
  // Écrit en local (synchrone, sûr) et tente une sauvegarde cloud CAS best-effort avant le gel de la page.
  useEffect(() => {
    const flush = () => {
      try { localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(stateRef.current)); } catch {}
      if (!hasLoadedCloudRef.current) return;
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      try { doCloudSave(); } catch {}
    };
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [userId]);

  // ============ PERSIST LOCAL + CLOUD (avec debounce) ============
  useEffect(() => {
    // Toujours sauvegarder en local immédiatement (responsif, fallback hors-ligne)
    try { localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(state)); } catch {}

    if (!hasLoadedCloud) return; // Pas de save cloud avant le 1er load
    // Ne pas réécrire au cloud juste après une adoption (load ou résolution de conflit)
    if (skipCloudSaveRef.current) { skipCloudSaveRef.current = false; setCloudStatus('synced'); return; }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setCloudStatus('syncing');
    saveTimerRef.current = setTimeout(() => { doCloudSave(); }, 1500);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [state, userId, hasLoadedCloud]);

  // Tick pour rafraîchir le label "il y a Xmin" toutes les 30s
  useEffect(() => {
    const id = setInterval(() => setSyncTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  // ============ LOGOUT ============
  async function handleLogout() {
    if (cloudStatus === 'syncing') {
      if (!confirm('Sync en cours. Te déconnecter quand même ?')) return;
    }
    await removePushSubscription(); // V5 lot 4 : cet appareil ne reçoit plus les notifications de ce compte
    await sb.auth.signOut();
  }

  // ============ DELETE ACCOUNT ============
  async function handleDeleteAccount() {
    try {
      // 1. Delete cloud data
      const { error } = await sb.from('cap_data').delete().eq('user_id', userId);
      if (error) {
        alert('Erreur lors de la suppression : ' + error.message);
        return;
      }
      // V5 lot 4 : abonnements push et rappels
      await removePushSubscription();
      await sb.from('reminders').delete().eq('user_id', userId);
      await sb.from('push_subscriptions').delete().eq('user_id', userId);
      // 2. Clear local cache
      try {
        localStorage.removeItem(STORAGE_KEY_USER);
        localStorage.removeItem(CLOUD_REV_KEY);
        localStorage.removeItem(`${STORAGE_KEY_USER}-conflict`);
        localStorage.removeItem(RUNNING_KEY);
        localStorage.removeItem(PUSH_KEY);
      } catch {}
      // 3. Sign out (le compte auth Supabase reste — à nettoyer via Edge Function plus tard)
      await sb.auth.signOut();
    } catch (e) {
      alert('Erreur : ' + (e.message || 'inconnue'));
    }
  }

  // Check-in matinal
  useEffect(() => {
    const today = todayISO();
    if (!state.capacity[today]) {
      setTimeout(() => setShowCheckin(true), 600);
    }
  }, []);

  // V5 lot 2 : session en cours persistée localement
  useEffect(() => {
    try {
      if (running) localStorage.setItem(RUNNING_KEY, JSON.stringify(running));
      else localStorage.removeItem(RUNNING_KEY);
    } catch {}
  }, [running]);

  // V5 lot 2 : tick de la session — avance les phases échues (plusieurs d'un coup après une veille)
  const settingsRef = useRef(state.settings);
  settingsRef.current = state.settings;
  useEffect(() => {
    if (!running) return;
    const tick = () => {
      setRunTick(t => t + 1);
      const r = runningRef.current;
      if (!r) return;
      if (hasLoadedCloudRef.current && !findItem(stateRef.current.items, r.itemId)) { commitRunning(null); return; }
      const { next, credits, events } = stepRunning(r, Date.now(), settingsRef.current);
      if (next === r) return;
      credits.forEach(c => creditWork(r.itemId, c.min, c.full, c.at, true));
      commitRunning(next);
      const title = findItem(stateRef.current.items, r.itemId)?.title || '';
      const last = events[events.length - 1];
      if (last === 'planDone') { playBell(880); notify('Temps prévu écoulé', `« ${title} » — c'est fini ?`); }
      else if (last === 'workEnd') { playBell(880); notify('Tranche terminée', 'Petite pause, tu l\'as méritée 🌿'); }
      else if (last === 'breakEnd') { playBell(660); notify('Pause terminée', 'On repart 💪'); }
      else if (last === 'waitResume') { showToast('Pause terminée pendant ton absence — la tranche suivante attend ▶'); }
    };
    tick();
    const interval = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', tick); };
  }, [!!running]);

  // V5 lot 4 : plus de demande d'autorisation au premier clic — l'activation se fait dans Réglages › Notifications.

  // ============ RAPPELS LOCAUX (minuteurs — onglet ouvert) ============
  // V5 lot 4 : même calcul que le push (computeReminders). Sur un appareil abonné au push, c'est le push
  // qui notifie (même Cap fermé) → pas de minuteur local, pour éviter les doublons.
  const [reminderTick, setReminderTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setReminderTick(t => t + 1), 3600000); // l'horizon de 14 jours glisse
    const onVis = () => { if (document.visibilityState === 'visible') setReminderTick(t => t + 1); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, []);
  useEffect(() => {
    reminderTimersRef.current.forEach(id => clearTimeout(id));
    reminderTimersRef.current.clear();
    if (pushInfo.status === 'on') return;
    const now = Date.now();
    for (const r of computeReminders(state.items, now)) {
      const delay = r.dueAt - now;
      if (delay > 2147483647) continue; // limite setTimeout (~24,8 j)
      const tid = setTimeout(() => {
        notify(r.title, r.body);
        // Fallback toast si notif refusée
        if (!('Notification' in window) || Notification.permission !== 'granted') {
          showToast(`${r.kind === 'travel' ? '' : '🧭 '}${r.body}`, null, 6000);
        }
        playBell(660);
      }, delay);
      reminderTimersRef.current.set(r.key, tid);
    }
    return () => {
      reminderTimersRef.current.forEach(id => clearTimeout(id));
      reminderTimersRef.current.clear();
    };
  }, [state.items, pushInfo.status, reminderTick]);

  // ============ V5 LOT 4 : RAPPELS PUSH (Supabase) ============
  // Chaque appareil connecté réécrit les rappels des 14 prochains jours (+ fins de phase de la session
  // en cours) ; la fonction serveur les envoie aux appareils abonnés, même Cap fermé.
  const lastReminderSyncRef = useRef('');
  useEffect(() => {
    if (!hasLoadedCloud) return;
    const t = setTimeout(async () => {
      const r = runningRef.current;
      const runTitle = r ? (findItem(stateRef.current.items, r.itemId)?.title || '') : '';
      const list = [...computeReminders(stateRef.current.items), ...sessionReminders(r, runTitle, settingsRef.current)];
      const sig = JSON.stringify(list.map(x => [x.key, x.title, x.body]));
      if (sig === lastReminderSyncRef.current) return;
      if (await syncRemindersToCloud(userId, list)) lastReminderSyncRef.current = sig;
    }, 2000);
    return () => clearTimeout(t);
  }, [state.items, running, hasLoadedCloud, reminderTick]);

  // Vérifie l'abonnement réel de l'appareil au démarrage (autorisation retirée, abonnement expiré…)
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    let cancelled = false;
    navigator.serviceWorker.getRegistration().then(reg => reg ? reg.pushManager.getSubscription() : null).then(sub => {
      if (cancelled) return;
      if (sub && Notification.permission === 'granted') {
        savePushSubscription(sub).catch(() => {});
      } else if (pushInfo.endpoint) {
        try { localStorage.removeItem(PUSH_KEY); } catch {}
        setPushInfo({ status: pushSupportStatus(), endpoint: null });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function savePushSubscription(sub) {
    const j = sub.toJSON();
    const { error } = await sb.from('push_subscriptions').upsert({
      user_id: userId, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
      user_agent: navigator.userAgent.slice(0, 200),
    }, { onConflict: 'user_id,endpoint' });
    if (error) throw error;
    try { localStorage.setItem(PUSH_KEY, j.endpoint); } catch {}
    setPushInfo({ status: 'on', endpoint: j.endpoint });
  }

  async function enablePush() {
    const st = pushSupportStatus();
    if (st === 'unsupported' || st === 'ios-install') { setPushInfo(p => ({ ...p, status: st })); return; }
    setPushInfo(p => ({ ...p, status: 'busy' }));
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setPushInfo({ status: perm === 'denied' ? 'denied' : 'off', endpoint: null }); return; }
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) throw new Error('service worker absent');
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        // Clé publique VAPID lue dans Supabase (la paire y est générée ; la clé privée n'en sort jamais)
        const { data: vapidPublic, error: ev } = await sb.rpc('cap_vapid_public_key');
        if (ev || !vapidPublic) throw ev || new Error('clé VAPID pas encore disponible');
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(vapidPublic) });
      }
      await savePushSubscription(sub);
      lastReminderSyncRef.current = ''; // force une réécriture des rappels
      setReminderTick(t => t + 1);
      showToast('🔔 Notifications activées sur cet appareil');
    } catch (e) {
      console.error(e);
      setPushInfo({ status: pushSupportStatus(), endpoint: null });
      showToast('⚠ Impossible d\'activer les notifications sur cet appareil', null, 5000);
    }
  }

  async function removePushSubscription() {
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      const endpoint = (sub && sub.endpoint) || pushInfo.endpoint;
      if (endpoint) await sb.from('push_subscriptions').delete().eq('user_id', userId).eq('endpoint', endpoint);
      if (sub) await sub.unsubscribe();
    } catch (e) { console.error(e); }
    try { localStorage.removeItem(PUSH_KEY); } catch {}
  }

  async function disablePush() {
    setPushInfo(p => ({ ...p, status: 'busy' }));
    await removePushSubscription();
    setPushInfo({ status: pushSupportStatus(), endpoint: null });
    showToast('Notifications désactivées sur cet appareil');
  }

  async function testPush() {
    const { error } = await sb.from('reminders').insert({
      user_id: userId, key: `test:${Date.now()}`, due_at: new Date().toISOString(),
      title: '🧭 Cap — Test', body: 'Les notifications marchent sur cet appareil.', item_id: null, kind: 'test',
    });
    showToast(error ? '⚠ Test impossible (réseau ?)' : '🔔 Test envoyé — la notification arrive dans la minute', null, 5000);
  }

  // Clic sur une notification (service worker) ou lien ?item=… → ouvre la tâche (ou sa session en cours)
  function openItemFromNotification(itemId) {
    if (!itemId) return;
    const it = findItem(stateRef.current.items, itemId);
    if (!it) return;
    if (runningRef.current && runningRef.current.itemId === itemId) { setFocusMode(itemId); return; }
    setEditingItem(it);
  }
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const id = params.get('item');
      if (id) {
        openItemFromNotification(id);
        params.delete('item');
        const q = params.toString();
        window.history.replaceState(null, '', window.location.pathname + (q ? `?${q}` : '') + window.location.hash);
      }
    } catch {}
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e) => { if (e.data && e.data.type === 'cap:open-item') openItemFromNotification(e.data.itemId); };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, []);

  // V5 lot 4 : nouvelle version de Cap disponible (service worker) → proposer, jamais forcer
  useEffect(() => {
    const onNeed = () => showToast('✨ Nouvelle version de Cap', { label: 'Recharger', onClick: () => window.__capUpdateSW && window.__capUpdateSW(true) }, 3600000);
    window.addEventListener('cap:need-refresh', onNeed);
    if (window.__capNeedRefresh) onNeed();
    return () => window.removeEventListener('cap:need-refresh', onNeed);
  }, []);

  // ============ RACCOURCIS CLAVIER ============
  useEffect(() => {
    function isInInput(target) {
      if (!target) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    }
    function anyModalOpen() {
      return showAddModal || showQuickAdd || editingItem || showSuggestion || showCheckin || showSettings || showReview || sessionSummary;
    }
    function handleKey(e) {
      // Échap : ferme modals (priorité du plus récent au plus ancien d'apparition logique)
      if (e.key === 'Escape' && !e.isComposing) {
        if (sessionSummary) { setSessionSummary(null); e.preventDefault(); return; }
        if (showSettings) { setShowSettings(false); e.preventDefault(); return; }
        if (showReview) { setShowReview(false); e.preventDefault(); return; }
        if (showCheckin) { setShowCheckin(false); e.preventDefault(); return; }
        if (showSuggestion) { setShowSuggestion(false); e.preventDefault(); return; }
        if (editingItem) { setEditingItem(null); e.preventDefault(); return; }
        if (showAddModal) { setShowAddModal(false); setEditingParentId(null); e.preventDefault(); return; }
        if (showQuickAdd) { setShowQuickAdd(false); setQuickAddPrefill(null); e.preventDefault(); return; }
        if (focusMode) { setFocusMode(null); e.preventDefault(); return; } // = Réduire : la session continue dans le bandeau
        // V3 S4 : Échap déselectionne tâche en dernier recours
        if (selectedItemId) { setSelectedItemId(null); e.preventDefault(); return; }
      }

      // Cmd/Ctrl+Z : undo dernière suppression
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        if (isInInput(e.target)) return; // laisse le navigateur gérer l'undo dans les champs
        e.preventDefault();
        undoLastDelete();
        return;
      }

      // Raccourcis désactivés si dans un input ou modal ouvert
      if (isInInput(e.target) || anyModalOpen()) return;

      // N : ajout rapide / Shift+N : modale complète
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        if (e.shiftKey) {
          setEditingParentId(null);
          setShowAddModal(true);
        } else {
          setQuickAddPrefill(null);
          setShowQuickAdd(true);
        }
        return;
      }
      // / : focus capture rapide
      if (e.key === '/') {
        e.preventDefault();
        if (quickCaptureRef.current) {
          setView('priorities'); // au cas où on est ailleurs, la barre est en haut
          quickCaptureRef.current.focus();
        }
        return;
      }
      // F : plein écran de la tâche en cours
      if ((e.key === 'f' || e.key === 'F') && running) {
        e.preventDefault();
        setFocusMode(running.itemId);
        return;
      }
      // Espace : pause/reprise de la session (uniquement si une tâche tourne déjà)
      if (e.key === ' ' && running) {
        e.preventDefault();
        pauseResume();
        return;
      }
      // V3 S4 : 1/2/3 → déplace tâche sélectionnée vers Must/Should/Want
      if (e.key === '1' || e.key === '2' || e.key === '3') {
        if (!selectedItemId) {
          // Pas de tâche sélectionnée → indication discrète
          return;
        }
        e.preventDefault();
        const targetPriority = e.key === '1' ? 'must' : e.key === '2' ? 'should' : 'want';
        const sel = findItem(state.items, selectedItemId);
        if (sel) {
          const isRoot = state.items.some(it => it.id === selectedItemId);
          if (isRoot) {
            pushUndoSnapshot('priority', 'changement priorité (raccourci)');
            updateItem(selectedItemId, { priority: targetPriority });
            showToast(`Déplacé vers ${targetPriority === 'must' ? 'Must' : targetPriority === 'should' ? 'Should' : 'Want'}`);
          } else {
            showToast('Sélection : sous-tâche — drag pour la promouvoir en racine.');
          }
        }
        return;
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [showAddModal, showQuickAdd, editingItem, showSuggestion, showCheckin, showSettings, showReview, focusMode, running, selectedItemId, state.items, sessionSummary]);

  // ============ V3 S4 : AUTO-SCROLL PENDANT DRAG ============
  // Quand le curseur approche du bord haut/bas pendant un drag, scroll auto.
  // Implémentation simple : scrollBy direct à chaque dragover, pas de setInterval (saccadé mais robuste).
  useEffect(() => {
    const EDGE = 100; // zone d'activation en px
    const MAX_SPEED = 24; // px par event

    function onDragOver(e) {
      const y = e.clientY;
      const h = window.innerHeight;
      let speed = 0;
      if (y < EDGE) {
        const ratio = Math.max(0, (EDGE - y) / EDGE);
        speed = -Math.ceil(ratio * MAX_SPEED);
      } else if (y > h - EDGE) {
        const ratio = Math.max(0, (y - (h - EDGE)) / EDGE);
        speed = Math.ceil(ratio * MAX_SPEED);
      }
      if (speed !== 0) {
        window.scrollBy(0, speed);
      }
    }

    document.addEventListener('dragover', onDragOver);
    return () => {
      document.removeEventListener('dragover', onDragOver);
    };
  }, []);

  // ============ HELPERS ============
  function playBell(freq = 880) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 1);
      osc.start(); osc.stop(ctx.currentTime + 1);
    } catch {}
  }

  function notify(title, body) {
    if (pushActiveRef.current) return; // V5 lot 4 : appareil abonné → c'est le push qui notifie
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification(title, { body }); } catch {}
    }
  }

  // Trouve un item récursivement (parmi tous les items + sous-tâches)
  function findItem(items, id) {
    for (const i of items) {
      if (i.id === id) return i;
      if (i.subtasks?.length) {
        const found = findItem(i.subtasks, id);
        if (found) return found;
      }
    }
    return null;
  }

  // Trouve le parent d'un item (null si racine)
  function findParent(items, childId, parent = null) {
    for (const i of items) {
      if (i.id === childId) return parent;
      if (i.subtasks?.length) {
        const found = findParent(i.subtasks, childId, i);
        if (found !== undefined && found !== null) return found;
        if (i.subtasks.some(s => s.id === childId)) return i;
      }
    }
    return null;
  }

  // Update récursivement
  function updateInTree(items, id, patch) {
    return items.map(i => {
      if (i.id === id) return { ...i, ...(typeof patch === 'function' ? patch(i) : patch) };
      if (i.subtasks?.length) return { ...i, subtasks: updateInTree(i.subtasks, id, patch) };
      return i;
    });
  }

  function deleteInTree(items, id) {
    return items.filter(i => i.id !== id).map(i => ({
      ...i,
      subtasks: i.subtasks ? deleteInTree(i.subtasks, id) : []
    }));
  }

  function addSubtaskToTree(items, parentId, newItem) {
    return items.map(i => {
      if (i.id === parentId) return { ...i, subtasks: [...(i.subtasks || []), newItem] };
      if (i.subtasks?.length) return { ...i, subtasks: addSubtaskToTree(i.subtasks, parentId, newItem) };
      return i;
    });
  }

  // Réordonne un item (racine ou sous-tâche) : on retire l'item, on l'insère avant ou après la cible
  // - Racine + Racine = réordo dans la liste racine
  // - Sous-tâche + Sous-tâche du même parent = réordo dans subtasks
  // - Sous-tâche + Sous-tâche d'un autre parent = rerooting (devient sous-tâche du parent du target)
  // - Cas mixtes (racine vs sous-tâche) = on délègue à reparentSubtask via 'center' drop
  function reorderItems(draggedId, targetId, position) {
    pushUndoSnapshot('reorder', 'réordonnancement');
    setState(s => {
      // Trouver dragged et target avec leurs parents
      function findWithParent(items, id, parent = null) {
        for (const i of items) {
          if (i.id === id) return { item: i, parent };
          if (i.subtasks?.length) {
            const f = findWithParent(i.subtasks, id, i);
            if (f) return f;
          }
        }
        return null;
      }
      const dragInfo = findWithParent(s.items, draggedId);
      const targetInfo = findWithParent(s.items, targetId);
      if (!dragInfo || !targetInfo) return s;

      // Cas 1 : les deux sont racines → réordo dans s.items
      if (!dragInfo.parent && !targetInfo.parent) {
        const filtered = s.items.filter(i => i.id !== draggedId);
        const targetIndex = filtered.findIndex(i => i.id === targetId);
        if (targetIndex === -1) return s;
        const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
        const newItems = [...filtered.slice(0, insertAt), dragInfo.item, ...filtered.slice(insertAt)];
        return { ...s, items: newItems };
      }
      // Cas 2 : les deux dans la même branche (même parent)
      if (dragInfo.parent && targetInfo.parent && dragInfo.parent.id === targetInfo.parent.id) {
        const parentId = dragInfo.parent.id;
        function reorderInParent(items) {
          return items.map(i => {
            if (i.id === parentId) {
              const subs = i.subtasks || [];
              const filtered = subs.filter(x => x.id !== draggedId);
              const targetIndex = filtered.findIndex(x => x.id === targetId);
              if (targetIndex === -1) return i;
              const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
              const newSubs = [...filtered.slice(0, insertAt), dragInfo.item, ...filtered.slice(insertAt)];
              return { ...i, subtasks: newSubs };
            }
            return i.subtasks?.length ? { ...i, subtasks: reorderInParent(i.subtasks) } : i;
          });
        }
        return { ...s, items: reorderInParent(s.items) };
      }
      // Cas 3 : dragged sous-tâche, target racine → on rerooting via drop center seulement.
      // Si position 'before'/'after' avec cible racine et dragged sous-tâche : on traite comme rerooting de la sous-tâche en racine
      // (promotion à racine). Pour rester simple → on ne fait rien dans ce cas (le drop center gère le rerooting).
      // On peut aussi dire : on retire dragged et on l'insère before/after target en racine.
      if (dragInfo.parent && !targetInfo.parent) {
        // Promotion en racine + insertion à position
        function removeFromTree(items, id) {
          return items.filter(i => i.id !== id).map(i => ({
            ...i, subtasks: i.subtasks ? removeFromTree(i.subtasks, id) : []
          }));
        }
        let newItems = removeFromTree(s.items, draggedId);
        const promoted = { ...dragInfo.item, priority: targetInfo.item.priority };
        const targetIndex = newItems.findIndex(i => i.id === targetId);
        const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
        newItems = [...newItems.slice(0, insertAt), promoted, ...newItems.slice(insertAt)];
        return { ...s, items: newItems };
      }
      // Cas 4 : dragged racine, target sous-tâche → on insère dragged dans la branche du parent du target
      if (!dragInfo.parent && targetInfo.parent) {
        const newParentId = targetInfo.parent.id;
        function removeFromTree(items, id) {
          return items.filter(i => i.id !== id).map(i => ({
            ...i, subtasks: i.subtasks ? removeFromTree(i.subtasks, id) : []
          }));
        }
        let newItems = removeFromTree(s.items, draggedId);
        const draggedAsSub = { ...dragInfo.item, priority: null };
        function insertInParent(items) {
          return items.map(i => {
            if (i.id === newParentId) {
              const subs = i.subtasks || [];
              const targetIndex = subs.findIndex(x => x.id === targetId);
              if (targetIndex === -1) return { ...i, subtasks: [...subs, draggedAsSub] };
              const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
              return { ...i, subtasks: [...subs.slice(0, insertAt), draggedAsSub, ...subs.slice(insertAt)] };
            }
            return i.subtasks?.length ? { ...i, subtasks: insertInParent(i.subtasks) } : i;
          });
        }
        return { ...s, items: insertInParent(newItems) };
      }
      // Cas 5 : les deux sous-tâches mais parents différents → on déplace dragged dans la branche du target
      if (dragInfo.parent && targetInfo.parent && dragInfo.parent.id !== targetInfo.parent.id) {
        const newParentId = targetInfo.parent.id;
        function removeFromTree(items, id) {
          return items.filter(i => i.id !== id).map(i => ({
            ...i, subtasks: i.subtasks ? removeFromTree(i.subtasks, id) : []
          }));
        }
        let newItems = removeFromTree(s.items, draggedId);
        const draggedAsSub = { ...dragInfo.item, priority: null };
        function insertInParent(items) {
          return items.map(i => {
            if (i.id === newParentId) {
              const subs = i.subtasks || [];
              const targetIndex = subs.findIndex(x => x.id === targetId);
              if (targetIndex === -1) return { ...i, subtasks: [...subs, draggedAsSub] };
              const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
              return { ...i, subtasks: [...subs.slice(0, insertAt), draggedAsSub, ...subs.slice(insertAt)] };
            }
            return i.subtasks?.length ? { ...i, subtasks: insertInParent(i.subtasks) } : i;
          });
        }
        return { ...s, items: insertInParent(newItems) };
      }
      return s;
    });
    const target = state.items.find(i => i.id === targetId);
    if (target && (target.priority === 'must' || target.priority === 'should' || target.priority === 'want')) {
      setManualOrder(m => ({ ...m, [target.priority]: true }));
    }
  }

  // ============ CRUD ============
  function makeItem(data, isSubtask = false) {
    // V3 S5 : plus de type 'habit' — toujours 'task'. Fallback défensif.
    const safeType = (data.type === 'habit') ? 'task' : (data.type || 'task');
    return {
      id: generateId(),
      title: data.title || 'Sans titre',
      type: safeType,
      categoryId: data.categoryId || '',
      icon: data.icon || '',
      date: data.date || '',
      time: data.time || '',
      reminder: data.reminder || '',
      priority: data.priority !== undefined ? data.priority : (isSubtask ? null : 'inbox'),
      subtasks: data.subtasks || [],
      notes: data.notes || '',
      energy: data.energy || 'medium',
      duration: data.duration || null, // {weeks, days, hours, minutes}
      durationManualOverride: data.durationManualOverride || false,
      deadline: data.deadline || null,
      recurrence: data.recurrence || null,
      exceptions: data.exceptions || {},
      actualMinutes: 0,
      pomosDone: 0,
      completed: false,
      completedAt: null, // V3 S4 : timestamp de complétion (pour archive 7j)
      isImportant: data.isImportant || false, // V3 S4 : flag visibilité (RDV, etc.)
      prepDuration: data.prepDuration ?? null, // V3 S4.5 : minutes de préparation avant time
      travelDuration: data.travelDuration ?? null, // V3 S4.5 : minutes de trajet aller
      travelReturn: data.travelReturn ?? false, // V3 S4.5 : trajet retour
      travelReturnDuration: data.travelReturnDuration ?? null, // V5 : null = identique à l'aller
      pinned: data.pinned || false, // V3 S(A+B) : épinglé en haut de colonne
      times: Array.isArray(data.times) ? data.times : [], // V3 S(D) : créneaux multiples/jour (routines)
      slotHistory: (data.slotHistory && typeof data.slotHistory === 'object') ? data.slotHistory : {}, // V3 S(D) : créneaux faits par date
      capId: data.capId !== undefined ? data.capId : null, // V4 4a.1 : filiation optionnelle vers un cap
      pillars: data.pillars || [], // V4 4b
      feel: null,
      createdAt: Date.now(),
      // V3 S5 : streak devient un booléen (suivre la régularité oui/non)
      streak: data.streak === true,
      lastCompletedDate: data.lastCompletedDate || null,
      history: data.history || [],
    };
  }

  function addItem(data, parentId = null) {
    const newItem = makeItem(data, !!parentId);
    if (parentId) {
      setState(s => ({ ...s, items: addSubtaskToTree(s.items, parentId, newItem) }));
    } else {
      setState(s => ({ ...s, items: [newItem, ...s.items] }));
    }
    return newItem;
  }

  function updateItem(id, patch) {
    setState(s => ({ ...s, items: updateInTree(s.items, id, patch) }));
  }

  // V3 S(A+B) : épingler / désépingler une tâche (remontée en tête de colonne)
  function togglePin(id) {
    const it = findItem(state.items, id);
    if (!it) return;
    updateItem(id, { pinned: !it.pinned });
    showToast(it.pinned ? 'Désépinglée' : '📌 Épinglée en haut');
  }

  // V3 S(A+B) : dupliquer une tâche / sous-tâche (arbre entier, sans date/heure)
  function cloneItemTree(src, isRoot) {
    return {
      ...src,
      id: generateId(),
      title: isRoot ? (src.title + ' (copie)') : src.title,
      date: '',
      time: '',
      completed: false,
      completedAt: null,
      actualMinutes: 0,
      pomosDone: 0,
      pinned: false,
      history: [],
      exceptions: {},
      lastCompletedDate: null,
      // isImportant nécessite date+heure ou échéance : on ne le garde que si une échéance subsiste
      isImportant: !!(src.isImportant && src.deadline),
      createdAt: Date.now(),
      subtasks: (src.subtasks || []).map(s => cloneItemTree(s, false)),
    };
  }

  function duplicateItem(id) {
    const src = findItem(state.items, id);
    if (!src) return;
    pushUndoSnapshot('duplicate', `duplication « ${src.title} »`);
    const clone = cloneItemTree(src, true);
    setState(s => {
      const pos = findItemPosition(s.items, id);
      if (!pos) return { ...s, items: [clone, ...s.items] };
      return { ...s, items: insertAtPosition(s.items, pos.parentId, pos.index + 1, clone) };
    });
    showToast('Dupliquée');
  }

  // ============ CAPS — CRUD V4 4a.1 ============
  function addVision(text = '') {
    const v = makeVision({ text });
    setState(s => ({ ...s, visions: [...(s.visions || []), v] }));
    return v;
  }
  function updateVision(id, patch) {
    setState(s => ({ ...s, visions: (s.visions || []).map(v => v.id === id ? { ...v, ...patch } : v) }));
  }
  function deleteVision(id) {
    setState(s => ({
      ...s,
      visions: (s.visions || []).filter(v => v.id !== id),
      // les objectifs qui pointaient vers cette vision repassent en non-lié
      caps: (s.caps || []).map(o => o.visionLink === id ? { ...o, visionLink: null } : o),
    }));
  }

  function addObjective(data) {
    const o = makeObjective(data);
    setState(s => ({ ...s, caps: [o, ...(s.caps || [])] }));
    return o;
  }
  // parentId = objectif OU node parent. Insère un nœud projet/jalon.
  function addCapNode(parentId, data) {
    const node = makeCapNode(data);
    setState(s => ({ ...s, caps: insertCapChild(s.caps || [], parentId, node) }));
    return node;
  }
  function updateCap(id, patch) {
    setState(s => ({ ...s, caps: updateCapTree(s.caps || [], id, patch) }));
  }
  function moveCap(id, dir) {
    setState(s => ({ ...s, caps: moveCapSibling(s.caps || [], id, dir) }));
  }
  function deleteCap(id) {
    const node = findCapNode(state.caps || [], id);
    if (!node) return;
    const orphanIds = new Set(collectCapIds(node));
    pushUndoSnapshot('cap-delete', `« ${node.title} » retiré`);
    setState(s => ({
      ...s,
      caps: deleteCapTree(s.caps || [], id),
      // nettoyage des capId pointant vers le sous-arbre supprimé (plus de liens fantômes)
      items: stripCapIds(s.items, orphanIds),
    }));
  }
  // Nettoie récursivement les capId orphelins dans l'arbre des tâches
  function stripCapIds(items, orphanIds) {
    return items.map(it => {
      const next = (it.capId && orphanIds.has(it.capId)) ? { ...it, capId: null } : it;
      return next.subtasks?.length ? { ...next, subtasks: stripCapIds(next.subtasks, orphanIds) } : next;
    });
  }
  // Changement de statut + retours doux (garde-fous : abandon célébré, jamais puni)
  function setCapStatus(id, status) {
    const node = findCapNode(state.caps || [], id);
    if (!node) return;
    const now = Date.now();
    updateCap(id, { status, statusChangedAt: now, reachedAt: status === 'reached' ? now : null });
    if (status === 'reached') {
      const path = capPathById(state.caps || [], id);
      const depth = path ? path.length - 1 : 0;
      const kind = capDisplayKind(depth);
      showToast(kind === 'objective' ? '🎯 Objectif atteint' : kind === 'milestone' ? '⚑ Jalon franchi' : '✓ Projet terminé');
      triggerConfetti();
    } else if (status === 'abandoned') {
      showToast('Cap lâché — c\'est une décision, pas un échec.');
    } else if (status === 'paused') {
      showToast('Cap mis en pause. Il dort, sans culpabilité.');
    }
  }
  // V4 4a.2 : consigne une réponse à une question de confrontation (+ patch éventuel du cap)
  function recordCapDecision(id, decision, patch = {}) {
    const node = findCapNode(state.caps || [], id);
    if (!node) return;
    updateCap(id, { ...patch, decisions: [...(node.decisions || []), { at: Date.now(), ...decision }] });
  }
  // V4 4a.2 : mode bas régime — coupe toute confrontation, pace et nudge
  function setLowMode(on) {
    setState(s => ({ ...s, lowMode: { on, since: on ? todayISO() : null } }));
    showToast(on ? 'Période de pause. Les caps dorment en silence — aucune question tant que tu ne reprends pas.' : 'Reprise. La Boussole reparle, doucement.');
  }
  const lowModeOn = !!(state.lowMode && state.lowMode.on);

  // Création : avertissements non bloquants (chevauchement V3 C1 + date/heure déjà passée V5).
  // La date passée n'est jamais signalée pour les routines ni les récurrentes (rattrapage légitime).
  function warnOnCreate(data) {
    const msgs = [];
    if (data.date && data.time) {
      const start = timeToMin(data.time);
      if (start != null) {
        const dur = durationToMinutes(data.duration || {}) || 0;
        const eff = getEffectiveBounds(data, start, dur);
        const overlap = findOverlapAt(state.items, data.date, eff.start, eff.end, null);
        if (overlap) msgs.push(formatConflictToast(overlap));
      }
    }
    if (data.date && !data.recurrence && !data.streak) {
      const now = new Date();
      const today = todayISO();
      if (data.date < today) msgs.push(`⏳ Le ${formatDate(data.date)} est déjà passé — tâche créée quand même.`);
      else if (data.date === today && data.time && timeToMin(data.time) < now.getHours() * 60 + now.getMinutes()) msgs.push(`⏳ ${data.time} est déjà passé aujourd'hui — tâche créée quand même.`);
    }
    if (msgs.length) showToast(msgs.join(' · '), null, 5000);
  }

  // V4 4c : argent
  function setMoney(fn) { setState(s => ({ ...s, money: fn({ entries: [], flows: [], ...(s.money || {}) }) })); }
  const moneyProps = {
    money: state.money,
    onAddEntry: (e) => setMoney(m => ({ ...m, entries: [...m.entries, { id: generateId(), createdAt: Date.now(), ...e }] })),
    onDeleteEntry: (id) => setMoney(m => ({ ...m, entries: m.entries.filter(e => e.id !== id) })),
    onAddFlow: (f) => setMoney(m => ({ ...m, flows: [...m.flows, { id: generateId(), since: todayISO(), until: null, createdAt: Date.now(), ...f }] })),
    onStopFlow: (id) => setMoney(m => ({ ...m, flows: m.flows.map(f => f.id === id ? { ...f, until: todayISO() } : f) })),
    onDeleteFlow: (id) => { if (window.confirm('Supprimer ce flux et tout son historique ? (« arrêter » garde l\'historique)')) setMoney(m => ({ ...m, flows: m.flows.filter(f => f.id !== id) })); },
  };

  const fluxProps = { state };

  // V4 4b : ce que j'arrête
  function addQuit({ title, pillars }) {
    setState(s => ({ ...s, quits: [...(s.quits || []), { id: generateId(), title, pillars: pillars || [], slips: [], createdAt: Date.now() }] }));
  }
  function toggleQuitSlip(id, date) {
    let slipped = false;
    setState(s => ({ ...s, quits: (s.quits || []).map(q => {
      if (q.id !== id) return q;
      const has = (q.slips || []).includes(date);
      slipped = !has;
      return { ...q, slips: has ? q.slips.filter(d => d !== date) : [...(q.slips || []), date] };
    }) }));
    const q = (state.quits || []).find(x => x.id === id);
    if (q && !(q.slips || []).includes(date)) showToast('Noté. Le compteur repart — sans jugement.');
  }
  function deleteQuit(id) {
    const q = (state.quits || []).find(x => x.id === id);
    if (!q || !window.confirm(`Retirer « ${q.title} » ?`)) return;
    setState(s => ({ ...s, quits: (s.quits || []).filter(x => x.id !== id) }));
  }

  // V4 4a.3 : rituel hebdo
  const reviewWeek = reviewWeekFor(new Date());
  const reviewEntry = (state.reviews?.weekly || {})[reviewWeek.weekId];
  const showReviewInvite = !lowModeOn && isReviewWindow(new Date()) && !(reviewEntry && (reviewEntry.doneAt || reviewEntry.skippedAt));
  function skipReview() {
    setState(s => ({ ...s, reviews: { ...s.reviews, weekly: { ...(s.reviews?.weekly || {}), [reviewWeek.weekId]: { skippedAt: Date.now() } } } }));
    showToast('Pas cette semaine. Aucun souci.');
  }
  function finishReview({ mattered, focus, extra }) {
    setState(s => {
      const next = {
        ...s,
        reviews: { ...s.reviews, weekly: { ...(s.reviews?.weekly || {}), [reviewWeek.weekId]: { mattered, doneAt: Date.now() } } },
        weeklyFocus: { ...(s.weeklyFocus || {}) },
      };
      if (focus) next.weeklyFocus[reviewWeek.nextWeekId] = focus; else delete next.weeklyFocus[reviewWeek.nextWeekId];
      return applyReviewExtras(next, extra || {});
    });
    setShowReview(false);
    showToast('Point fait. Bonne semaine.');
  }
  // Focale mensuelle : 4e écran du 1er rituel du mois (jusqu'au 10), sauf en période de pause
  const monthId = isoMonthId(new Date());
  const monthlyDue = !lowModeOn && new Date().getDate() <= 10 && !((state.reviews?.monthly || {})[monthId]?.doneAt);
  const reviewExtraSteps = monthlyDue ? [{
    key: 'month', title: 'Et ce mois-ci, la direction ?',
    render: (data, set) => <MonthlyFocusStep caps={state.caps || []} visions={state.visions || []} data={data} set={set} onCapDecision={recordCapDecision} onSetCapStatus={setCapStatus} />,
  }] : [];
  function applyReviewExtras(s, extra) {
    if (!extra.month) return s;
    return { ...s, reviews: { ...s.reviews, monthly: { ...(s.reviews?.monthly || {}), [monthId]: { doneAt: Date.now(), monthCapId: extra.month.monthCapId || null } } } };
  }
  const monthCapId = (state.reviews?.monthly || {})[monthId]?.monthCapId || null;
  const monthCapLabel = monthCapId ? capDirectLabel(state.caps || [], monthCapId) : null;
  // « Ça m'a échappé » → une petite tâche liée au cap, casée au début de la semaine qui vient
  function addNudgeTask(capId, title) {
    const date = todayISO() < reviewWeek.nextMonday ? reviewWeek.nextMonday : todayISO();
    addItem({ title, capId, priority: 'must', date, duration: { weeks: 0, days: 0, hours: 0, minutes: 15 } });
    showToast(`« ${title} » casée le ${formatDate(date)}.`);
  }
  // Focus de la semaine en cours (posé au rituel précédent)
  const currentFocus = (state.weeklyFocus || {})[currentFocusWeekId(new Date())] || null;
  const currentFocusLabel = currentFocus ? ((currentFocus.capId && capDirectLabel(state.caps || [], currentFocus.capId)) || currentFocus.text || null) : null;

  // Compte les caps "actifs" pour le warning soft de surinvestissement (objectifs racine)
  const activeObjectiveCount = (state.caps || []).filter(o => o.status === 'active').length;

  // V4 4a.1+ : (re)lier ou délier une tâche à un cap (drag-drop dans la Boussole)
  function linkTaskToCap(taskId, capId) {
    const next = capId || null;
    const cur = findItem(state.items, taskId);
    if (cur && (cur.capId || null) === next) return; // déjà lié à ce cap → rien à faire
    updateItem(taskId, { capId: next });
    showToast(next ? '🧭 Tâche rattachée' : 'Tâche déliée');
  }

  // ============ TOAST ============
  function showToast(message, action = null, duration = 3500, extraActions = null) {
    const id = generateId();
    setToast({ id, message, action, extraActions });
    setTimeout(() => {
      setToast(t => (t && t.id === id ? { ...t, leaving: true } : t));
      setTimeout(() => setToast(t => (t && t.id === id ? null : t)), 200);
    }, duration);
  }

  // ============ UNDO STACK (suppressions) ============
  // Trouve la position d'un item : { parentId|null, index }
  function findItemPosition(items, id, parentId = null) {
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === id) return { parentId, index: i };
      if (items[i].subtasks?.length) {
        const found = findItemPosition(items[i].subtasks, id, items[i].id);
        if (found) return found;
      }
    }
    return null;
  }

  function insertAtPosition(items, parentId, index, item) {
    if (parentId === null) {
      const safeIndex = Math.min(Math.max(index, 0), items.length);
      return [...items.slice(0, safeIndex), item, ...items.slice(safeIndex)];
    }
    return items.map(i => {
      if (i.id === parentId) {
        const subs = i.subtasks || [];
        const safeIndex = Math.min(Math.max(index, 0), subs.length);
        return { ...i, subtasks: [...subs.slice(0, safeIndex), item, ...subs.slice(safeIndex)] };
      }
      if (i.subtasks?.length) return { ...i, subtasks: insertAtPosition(i.subtasks, parentId, index, item) };
      return i;
    });
  }

  // V3 S4 : Stack undo unifiée (delete + complete + D&D divers), profondeur 10
  // Chaque entrée : { type, label, snapshot: items array deep-cloned, timestamp }
  function pushUndoSnapshot(type, label) {
    const stack = undoStackRef.current;
    // Deep clone pour figer le snapshot (JSON simple suffit, items sont du JSON-safe)
    let snapshot;
    try {
      snapshot = JSON.parse(JSON.stringify(state.items));
    } catch {
      return;
    }
    stack.push({ type, label, snapshot, timestamp: Date.now() });
    if (stack.length > 10) stack.shift();
  }

  function undoLastDelete() {
    const stack = undoStackRef.current;
    if (stack.length === 0) {
      showToast('Rien à annuler');
      return;
    }
    const last = stack.pop();
    if (last.snapshot) {
      // Snapshot unifié → restaure tout l'arbre items
      setState(s => ({ ...s, items: last.snapshot }));
      showToast(`Annulé : ${last.label || last.type}`);
    } else if (last.item && last.parentId !== undefined) {
      // Ancien format (legacy delete) → restaure à la position
      setState(s => ({ ...s, items: insertAtPosition(s.items, last.parentId, last.index, last.item) }));
      showToast(`« ${last.item.title} » restaurée`);
    }
  }

  function deleteItem(id) {
    setState(s => {
      const pos = findItemPosition(s.items, id);
      const item = findItem(s.items, id);
      if (item && pos) {
        // Snapshot complet (cohérent avec la nouvelle stack)
        try {
          const snapshot = JSON.parse(JSON.stringify(s.items));
          undoStackRef.current.push({ type: 'delete', label: `« ${item.title} » supprimée`, snapshot, timestamp: Date.now() });
          if (undoStackRef.current.length > 10) undoStackRef.current.shift();
        } catch {}
      }
      return { ...s, items: deleteInTree(s.items, id) };
    });
    showToast('Tâche supprimée', { label: 'Annuler', onClick: undoLastDelete });
  }

  // V5 : vider l'archive (tâches racines archivées + leur arbre), annulable via la pile d'undo
  function emptyArchive() {
    const ids = new Set(state.items.filter(i => isArchived(i)).map(i => i.id));
    if (!ids.size) return;
    pushUndoSnapshot('delete', `${ids.size} tâches archivées supprimées`);
    setState(s => ({ ...s, items: s.items.filter(i => !ids.has(i.id)) }));
    showToast(`${ids.size} tâche${ids.size > 1 ? 's' : ''} supprimée${ids.size > 1 ? 's' : ''} définitivement`, { label: 'Annuler', onClick: undoLastDelete });
  }

  // opts.silent (V5 lot 2) : pas de toast — le bilan de session prend le relais (ressenti compris)
  function toggleComplete(item, opts = {}) {
    const today = todayISO();
    // V3 S5 : si streak (ex-habitude) ou récurrence, on coche l'occurrence d'aujourd'hui
    // via le système history/exceptions, pas via item.completed.
    if (item.streak || item.recurrence) {
      toggleOccurrenceComplete(item.id, today);
      return;
    }
    const willComplete = !item.completed;
    // V3 S4 : push undo stack avant complétion (pour Cmd+Z)
    if (willComplete) {
      pushUndoSnapshot('complete', `« ${item.title} »`);
    }
    updateItem(item.id, { completed: willComplete, completedAt: willComplete ? Date.now() : null });
    if (willComplete) {
      triggerConfetti();
      if (opts.silent) return;
      // Toast avec bouton Annuler 5s
      // V4 4b : ressenti a posteriori, facultatif (☀️ ça m'a donné de l'énergie / 😴 ça m'a vidé)
      showToast(`✓ « ${item.title.length > 30 ? item.title.slice(0, 30) + '…' : item.title} » archivée`, {
        label: 'Annuler',
        onClick: () => updateItem(item.id, { completed: false, completedAt: null }),
      }, 6000, [
        { label: '☀️', title: 'Ça m\'a donné de l\'énergie', onClick: () => updateItem(item.id, { feel: 'up' }) },
        { label: '😴', title: 'Ça m\'a vidé', onClick: () => updateItem(item.id, { feel: 'down' }) },
      ]);
    }
  }

  // ============ OCCURRENCES (V3 S2B) ============
  // Marquer une occurrence comme complétée / décomplétée
  function toggleOccurrenceComplete(itemId, occDate, occTime) {
    const item = findItem(state.items, itemId);
    if (!item) return;
    // V3 S(D) : routine multi-créneaux (≥2 heures/jour). history (moteur du streak) reste dérivé :
    // la date y figure ssi TOUS les créneaux du jour sont faits.
    // - avec occTime → bascule ce créneau
    // - sans occTime → bascule le jour entier (tous les créneaux) ; appelé par les listes date-only
    if (item.streak && Array.isArray(item.times) && item.times.length >= 2) {
      const slotHistory = { ...(item.slotHistory || {}) };
      const daySet = new Set(slotHistory[occDate] || []);
      const isToday = occDate === todayISO();
      let becameAllDone = false;
      if (occTime) {
        const wasDone = daySet.has(occTime);
        if (wasDone) daySet.delete(occTime); else daySet.add(occTime);
      } else {
        const allDone = item.times.every(t => daySet.has(t));
        daySet.clear();
        if (!allDone) item.times.forEach(t => daySet.add(t)); // tout cocher si pas déjà complet
      }
      const arr = [...daySet].sort();
      if (arr.length) slotHistory[occDate] = arr; else delete slotHistory[occDate];
      const allDoneNow = item.times.every(t => daySet.has(t));
      const wasAllDoneBefore = (item.history || []).includes(occDate);
      becameAllDone = allDoneNow && !wasAllDoneBefore;
      let history = (item.history || []).filter(d => d !== occDate);
      if (allDoneNow) history = [...history, occDate];
      updateItem(itemId, {
        slotHistory,
        history,
        lastCompletedDate: isToday ? (allDoneNow ? occDate : null) : item.lastCompletedDate,
      });
      if (becameAllDone) triggerConfetti(); // jour entièrement bouclé
      return;
    }
    // V3 S5.5++ : si streak activé, on track via history + lastCompletedDate uniquement.
    // Le streak est calculé lazy à l'affichage (computeStreak), rien à incrémenter ici.
    // Le champ reste en data pour rétrocompat mais devient mort.
    if (item.streak) {
      const isToday = occDate === todayISO();
      const inHistory = (item.history || []).includes(occDate);
      if (inHistory) {
        const newHistory = item.history.filter(d => d !== occDate);
        updateItem(itemId, {
          history: newHistory,
          lastCompletedDate: isToday ? null : item.lastCompletedDate,
        });
      } else {
        updateItem(itemId, {
          history: [...(item.history || []), occDate],
          lastCompletedDate: isToday ? occDate : item.lastCompletedDate,
        });
        triggerConfetti();
      }
      return;
    }
    // Tâche récurrente sans streak : on stocke dans exceptions
    const exceptions = { ...(item.exceptions || {}) };
    const current = exceptions[occDate];
    if (current === 'completed') {
      delete exceptions[occDate];
    } else {
      exceptions[occDate] = 'completed';
      triggerConfetti();
    }
    updateItem(itemId, { exceptions });
  }

  // Déplacer une occurrence : crée une exception avec nouvelle date/time
  function moveOccurrence(itemId, origDate, newDate, newTime) {
    const item = findItem(state.items, itemId);
    if (!item) return;
    const exceptions = { ...(item.exceptions || {}) };
    // Préserver une éventuelle override duration sur cette occurrence
    const prev = exceptions[origDate];
    const prevDuration = (prev && typeof prev === 'object' && typeof prev.duration === 'number') ? prev.duration : null;
    const newExc = { date: newDate, time: newTime || '' };
    if (prevDuration != null) newExc.duration = prevDuration;
    exceptions[origDate] = newExc;
    updateItem(itemId, { exceptions });
  }

  // Suppression d'une occurrence avec scope
  function deleteOccurrenceWithScope(itemId, occDate, scope) {
    const item = findItem(state.items, itemId);
    if (!item) return;
    if (scope === 'all') {
      // Supprime toute la série (= deleteItem normal, avec undo)
      deleteItem(itemId);
      return;
    }
    if (scope === 'this-and-future') {
      // Termine la série la veille
      const dayBefore = new Date(occDate + 'T00:00:00');
      dayBefore.setDate(dayBefore.getDate() - 1);
      const newEndDate = dateToISO(dayBefore);
      const newRecurrence = { ...item.recurrence, endDate: newEndDate, endAfter: null };
      updateItem(itemId, { recurrence: newRecurrence });
      showToast('Récurrence terminée');
      return;
    }
    // 'this' = juste cette occurrence
    const exceptions = { ...(item.exceptions || {}) };
    exceptions[occDate] = 'deleted';
    updateItem(itemId, { exceptions });
    showToast('Occurrence supprimée');
  }

  // Modification d'une occurrence avec scope
  // patch = données du form (telles que onSave les fournit)
  function updateOccurrenceWithScope(itemId, occDate, patch, scope) {
    const item = findItem(state.items, itemId);
    if (!item) return;
    if (scope === 'all') {
      // Modification de la série complète
      updateItem(itemId, patch);
      return;
    }
    if (scope === 'this-and-future') {
      // Split : la série originale termine la veille, on crée une nouvelle série démarrant à occDate
      const dayBefore = new Date(occDate + 'T00:00:00');
      dayBefore.setDate(dayBefore.getDate() - 1);
      const newEndDate = dateToISO(dayBefore);
      const oldRecurrence = { ...item.recurrence, endDate: newEndDate, endAfter: null };
      updateItem(itemId, { recurrence: oldRecurrence });
      // Nouvelle série basée sur l'ancien + patch, créée comme item indépendant
      const newSeriesData = {
        ...item,
        ...patch,
        // Nettoie identité et flags spécifiques à l'instance
        id: undefined,
        completed: false,
        completedAt: null,
        actualMinutes: 0,
        pomosDone: 0,
        history: [],
        streak: item.streak === true,
        lastCompletedDate: null,
        exceptions: {},
        // La récurrence vient soit du patch, soit héritée mais on la conserve sans endDate du parent
        recurrence: patch.recurrence !== undefined ? patch.recurrence : { ...item.recurrence, endDate: null },
        // Ajustement createdAt pour que la nouvelle série démarre bien à occDate
        createdAt: new Date(occDate + 'T00:00:00').getTime(),
      };
      addItem(newSeriesData);
      return;
    }
    // 'this' = approche pragmatique : tâche dérivée one-shot + exception 'deleted' sur l'origine
    const exceptions = { ...(item.exceptions || {}) };
    exceptions[occDate] = 'deleted';
    updateItem(itemId, { exceptions });
    // Crée une tâche one-shot pour cette occurrence avec les modifs
    const derivedData = {
      ...item,
      ...patch,
      id: undefined,
      recurrence: null,
      exceptions: {},
      date: occDate,
      time: patch.time !== undefined ? patch.time : (item.time || ''),
      completed: false,
      completedAt: null,
      actualMinutes: 0,
      pomosDone: 0,
      history: [],
      // V3 S5 : occurrence détachée = tâche one-shot, pas de streak
      streak: false,
      lastCompletedDate: null,
      createdAt: Date.now(),
    };
    addItem(derivedData);
  }

  // Drop d'une tâche/occurrence sur un créneau de l'agenda
  // startMin: minute du jour (0..1435), au pas de 5 min (snap appliqué amont)
  function handleCalendarDrop(payload, date, startMin) {
    // payload peut être : "id" simple (legacy = tâche depuis listes), ou JSON {id, occDate, fromUnscheduled}
    let id = payload;
    let occDate = null;
    let fromUnscheduled = false;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object' && parsed.id) {
        id = parsed.id;
        occDate = parsed.occDate || null;
        fromUnscheduled = !!parsed.fromUnscheduled;
      }
    } catch {}

    const item = findItem(state.items, id);
    if (!item) return;

    // Refus : item avec sous-tâches → on demande de placer les sous-tâches individuellement
    if (item.subtasks && item.subtasks.length > 0) {
      showToast('Cette tâche a des sous-tâches — place-les individuellement.');
      return;
    }

    // Calcul durée de l'item au moment du drop (pour la collision)
    let durMin = effectiveDurationMinutes(item) || 0;
    // Override exception duration si occurrence récurrente
    if (occDate && item.recurrence) {
      const exc = item.exceptions?.[occDate];
      if (exc && typeof exc === 'object' && typeof exc.duration === 'number') {
        durMin = exc.duration;
      }
    }
    const blockMin = Math.max(durMin, MIN_VISUAL_MIN);
    const endMin = startMin + blockMin;
    if (endMin > 24 * 60) {
      showToast('La tâche dépasse minuit — choisis un créneau plus tôt.');
      return;
    }

    // V3 S(C1) : le chevauchement est désormais autorisé. On informe sans bloquer.
    const excludeKey = occDate ? `${id}|${occDate}` : `${id}|${item.date}`;
    const eff = getEffectiveBounds(item, startMin, durMin);
    const overlap = findOverlapAt(state.items, date, eff.start, eff.end, excludeKey);
    if (overlap) {
      showToast(formatConflictToast(overlap));
    }

    const newTime = minToTime(snap5(startMin));

    if (occDate && item.recurrence) {
      moveOccurrence(id, occDate, date, newTime);
      return;
    }
    if (fromUnscheduled && item.recurrence) {
      moveOccurrence(id, occDate, date, newTime);
      return;
    }

    // Tâche one-shot : modifie date/time directement
    updateItem(id, { date, time: newTime });
  }

  // Resize d'une occurrence : changer sa durée (one-shot ou exception sur récurrence)
  // newDurationMin doit être au pas de 5 min, >=5, <=480
  function resizeOccurrence(itemId, occDate, newDurationMin) {
    const item = findItem(state.items, itemId);
    if (!item) return;
    const dur = Math.max(5, Math.min(480, snap5(newDurationMin)));
    if (item.recurrence && occDate) {
      // Exception sur cette occurrence : on conserve date/time existants ou on initialise
      const exceptions = { ...(item.exceptions || {}) };
      const existing = exceptions[occDate];
      let newExc;
      if (existing && typeof existing === 'object' && existing.date) {
        newExc = { ...existing, duration: dur };
      } else {
        // Créer une exception "déplacement" qui ne change ni date ni time, mais ajoute duration
        newExc = { date: occDate, time: item.time || '', duration: dur };
      }
      exceptions[occDate] = newExc;
      updateItem(itemId, { exceptions });
    } else {
      // One-shot : maj duration directe (override manuel si subtasks, mais subtasks → pas affiché donc cas n'arrive pas)
      updateItem(itemId, { duration: minutesToDuration(dur), durationManualOverride: !!(item.subtasks && item.subtasks.length) });
    }
  }

  function triggerConfetti() {
    const colors = ['#B8482E', '#2C5F7C', '#C68729', '#5C7A3E'];
    const pieces = Array.from({ length: 12 }).map((_, i) => ({
      id: generateId() + i,
      color: colors[i % colors.length],
      left: 40 + Math.random() * 20,
      delay: Math.random() * 0.2,
    }));
    setConfettis(pieces);
    setTimeout(() => setConfettis([]), 1100);
  }

  function handleQuickCapture() {
    if (!quickCapture.trim()) return;
    addItem({ title: quickCapture.trim(), priority: 'inbox' });
    setQuickCapture('');
  }

  // ============ DÉMARRER (V5 lot 2) ============
  // Temps de travail enregistré sur la tâche. Tranche terminée → aussi dans focusLog (prime time) ;
  // 🍅 seulement pour une tranche complète (≥ durée focus).
  function creditWork(itemId, min, full, at, log) {
    if (!min || min <= 0) return;
    setState(s => {
      if (!findItem(s.items, itemId)) return s;
      const items = updateInTree(s.items, itemId, it => ({
        actualMinutes: (it.actualMinutes || 0) + min,
        pomosDone: (it.pomosDone || 0) + (full ? 1 : 0),
      }));
      const focusLog = log ? [...(s.focusLog || []), { at, min, itemId }].slice(-1000) : s.focusLog;
      return { ...s, items, focusLog };
    });
  }

  // Tranche de travail interrompue (Fini, Arrêter, autre tâche) : on enregistre le temps déjà passé.
  function flushRunning(r) {
    if (!r || r.mode !== 'focus') return 0;
    const min = Math.round((r.totalSeconds - runningLeft(r, Date.now())) / 60);
    creditWork(r.itemId, min, false, Date.now(), false);
    return Math.max(0, min);
  }

  function startTask(itemId) {
    const prev = runningRef.current;
    if (prev && prev.itemId === itemId) { setFocusMode(itemId); return; }
    const item = findItem(state.items, itemId);
    if (!item) return;
    if (prev) {
      flushRunning(prev);
      const prevItem = findItem(state.items, prev.itemId);
      if (prevItem) showToast(`⏱ Temps enregistré sur « ${prevItem.title.length > 30 ? prevItem.title.slice(0, 30) + '…' : prevItem.title} »`);
    }
    const plan = buildSessionPlan(sessionPlanMinutes(item, state.settings), state.settings.pomoFocus);
    const first = plan ? plan[0] : state.settings.pomoFocus;
    const now = Date.now();
    commitRunning({
      itemId, plan, slice: 0, mode: 'focus',
      totalSeconds: first * 60, endsAt: now + first * 60000, pausedLeft: null, paused: false,
      cycles: 0, startedAt: now, workedMin: 0,
    });
    setFocusMode(itemId);
  }

  function pauseResume() {
    const r = runningRef.current;
    if (!r || r.mode === 'done') return;
    const now = Date.now();
    if (r.paused) commitRunning({ ...r, paused: false, endsAt: now + (r.pausedLeft || 0) * 1000, pausedLeft: null });
    else commitRunning({ ...r, paused: true, pausedLeft: runningLeft(r, now), endsAt: null });
  }

  function stopTask() {
    flushRunning(runningRef.current);
    commitRunning(null);
    setFocusMode(null);
  }

  // Passe à la phase suivante maintenant (la tranche en cours compte pour le temps déjà passé)
  function skipPhase() {
    const r = runningRef.current;
    if (!r || r.mode === 'done') return;
    const now = Date.now();
    const elapsed = r.mode === 'focus' ? r.totalSeconds - runningLeft(r, now) : r.totalSeconds;
    const cut = { ...r, totalSeconds: elapsed, endsAt: now, paused: false, pausedLeft: null };
    const { next, credits } = stepRunning(cut, now, state.settings);
    credits.forEach(c => creditWork(r.itemId, c.min, c.full, c.at, true));
    commitRunning(next);
  }

  // « +5 min » quand le temps prévu est écoulé
  function extendSession(min = 5) {
    const r = runningRef.current;
    if (!r) return;
    const plan = r.plan ? [...r.plan, min] : null;
    commitRunning({
      ...r, plan, slice: plan ? plan.length - 1 : r.slice + 1, mode: 'focus',
      totalSeconds: min * 60, endsAt: Date.now() + min * 60000, pausedLeft: null, paused: false,
    });
  }

  // « Fini » à tout moment : enregistre, arrête, coche, puis bilan neutre estimé / réel
  function finishSession() {
    const r = runningRef.current;
    if (!r) return;
    const item = findItem(state.items, r.itemId);
    const partial = flushRunning(r);
    commitRunning(null);
    setFocusMode(null);
    if (!item) return;
    const recurring = !!(item.recurrence || item.streak);
    const realMin = recurring ? (r.workedMin || 0) + partial : (item.actualMinutes || 0) + partial;
    const alreadyDone = recurring ? isOccurrenceCompleted(item, todayISO()) : item.completed;
    if (!alreadyDone) toggleComplete(item, { silent: true });
    setSessionSummary({ itemId: item.id, title: item.title, icon: item.icon, estMin: effectiveDurationMinutes(item), realMin, recurring, feel: null });
  }

  // ============ SUGGESTION ============
  function suggestNext() {
    // V3 S5 : on inclut les tâches récurrentes (ex-habitudes comprises) si elles ont une priorité.
    // Mais on exclut celles sans priorité (sous-tâches) et les complétées (one-shot).
    const allTasks = flattenItems(state.items).filter(i => {
      if (i.priority === null) return false;
      // One-shot complétée : exclue
      if (!i.recurrence && i.completed) return false;
      return true;
    });
    if (allTasks.length === 0) {
      setSuggestedTask(null); setShowSuggestion(true); return;
    }
    const today = todayISO();
    const tomorrow = tomorrowISO();
    const todayObj = new Date();
    // V3 S5 : skip récurrences déjà cochées aujourd'hui ou quota flottant atteint
    const eligible = allTasks.filter(i => {
      if (!i.recurrence) return true;
      if (isFloatingRecurrence(i.recurrence)) {
        return !isFloatingQuotaMet(i, todayObj);
      }
      // Récurrence à date fixe : déjà cochée aujourd'hui ?
      if (isOccurrenceCompleted(i, today)) return false;
      // Doit avoir une occurrence aujourd'hui pour être suggérée comme "à faire maintenant"
      return hasOccurrenceOnDate(i, today);
    });
    if (eligible.length === 0) {
      setSuggestedTask(null); setShowSuggestion(true); return;
    }
    const scored = eligible.map(i => {
      let score = 0;
      if (i.priority === 'must') score += 100;
      if (i.priority === 'should') score += 50;
      if (i.priority === 'want') score += 20;
      if (i.date) {
        if (i.date <= today) score += 80;
        else if (i.date <= tomorrow) score += 40;
      } else if (i.recurrence && hasOccurrenceOnDate(i, today)) {
        // V3 S5 : récurrence non flottante avec occurrence aujourd'hui = équivalent date du jour
        score += 80;
      } else if (isFloatingRecurrence(i.recurrence) && !isFloatingQuotaMet(i, todayObj)) {
        // V3 S5 : récurrence flottante quota non atteint = priorité jour
        score += 60;
      }
      // Deadline scoring : urgence forte sur les échéances proches
      if (i.deadline) {
        const d = daysUntilDeadline(i.deadline);
        if (d !== null) {
          if (d < 0) score += 200;        // en retard
          else if (d <= 1) score += 120;
          else if (d <= 3) score += 60;
          else if (d <= 7) score += 30;
        }
      }
      const minutes = effectiveDurationMinutes(i);
      if (minutes && minutes <= 15) score += 15;
      // V4 4a.3 : léger coup de pouce aux tâches rattachées au focus de la semaine (lignée comprise)
      if (currentFocus?.capId && i.capId) {
        const path = capPathById(state.caps || [], i.capId);
        if (path && path.some(n => n.id === currentFocus.capId)) score += 40;
      }
      return { item: i, score };
    });
    scored.sort((a, b) => b.score - a.score);
    setSuggestedTask(scored[0].item);
    setShowSuggestion(true);
  }

  // ============ CAPACITY / GAUGE ============
  const today = todayISO();
  const todayCapacity = state.capacity[today];

  // Estimé : on parcourt l'arbre, et pour chaque item planifié aujourd'hui (date ou occurrence récurrente)
  // on regarde s'il a des sous-tâches planifiées aujourd'hui :
  // - oui → on compte récursivement les sous-tâches (pas l'item lui-même)
  // - non → on compte cet item avec sa durée effective
  // Évite le double comptage parent + sous-tâches.
  const todayEstimatedMinutes = useMemo(() => {
    function isPlannedToday(item) {
      if (item.completed) return false;
      if (item.recurrence) {
        // V3 S5 : récurrence flottante avec quota non atteint = comptée comme planifiée du jour
        if (isFloatingRecurrence(item.recurrence)) {
          return !isFloatingQuotaMet(item, new Date());
        }
        return hasOccurrenceOnDate(item, today);
      }
      return item.date === today;
    }
    function hasPlannedDescendant(item) {
      for (const s of (item.subtasks || [])) {
        if (isPlannedToday(s) || hasPlannedDescendant(s)) return true;
      }
      return false;
    }
    function sumLeaves(item) {
      const planned = isPlannedToday(item);
      const subsPlanned = hasPlannedDescendant(item);
      if (subsPlanned) {
        // On descend dans les sous-tâches uniquement
        return (item.subtasks || []).reduce((sum, s) => sum + sumLeaves(s), 0);
      }
      if (planned) {
        // Feuille planifiée, on compte sa durée effective directe (pas récursive ici puisqu'aucune sub planifiée)
        return durationToMinutes(item.duration);
      }
      return 0;
    }
    return state.items.reduce((sum, i) => sum + sumLeaves(i), 0);
  }, [state.items, today]);

  const todayActualMinutes = useMemo(() => {
    const startOfDay = new Date(today + 'T00:00:00').getTime();
    return flattenItems(state.items).reduce((sum, i) => {
      if (i.completedAt && i.completedAt >= startOfDay) return sum + (i.actualMinutes || 0);
      if (i.id === running?.itemId) return sum + (i.actualMinutes || 0);
      return sum;
    }, 0);
  }, [state.items, today, running]);

  // ============ EXPORT/IMPORT ============
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `cap-backup-${todayISO()}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  function importData(e) {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.items && Array.isArray(data.items)) {
          if (confirm(`Importer ${data.items.length} items ? Tes données actuelles seront remplacées.`)) {
            setState(prev => normalizeLoadedState({ ...prev, ...data, schemaVersion: data.schemaVersion || 0 }));
          }
        }
      } catch { alert('Fichier invalide.'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  // Intention du jour : éditer + lire
  function setDailyIntention(date, text) {
    setState(s => {
      const nextIntents = { ...(s.dailyIntentions || {}) };
      const trimmed = (text || '').trim();
      if (trimmed) {
        nextIntents[date] = trimmed;
      } else {
        delete nextIntents[date];
      }
      return { ...s, dailyIntentions: nextIntents };
    });
  }

  // ============ COLUMNS (V3 S4 : tri auto, recherche, filtres, archive) ============
  // V3 S5 : plus de séparation tâche/habitude — tout est tâche. rootItems = items racine.
  const rootItems = state.items;

  // Filtrer items archivés (completés depuis > 7j)
  const visibleRoots = rootItems.filter(i => !isArchived(i));

  // Pipeline : recherche → filtres → tri par colonne
  function passesSearchAndFilters(it) {
    if (searchQuery && !itemMatchesSearch(it, searchQuery, searchScopes)) return false;
    if (hasActiveFilters(filters) && !itemMatchesFilters(it, filters)) return false;
    return true;
  }

  // V3 S5 : par défaut on masque les tâches récurrentes des colonnes Priorités (Inbox + Must/Should/Want).
  // Toggle dans les settings pour les afficher.
  const showRecurringInPriorities = !!state.settings.showRecurringInPriorities;
  function passesRecurringFilter(it) {
    if (showRecurringInPriorities) return true;
    return !it.recurrence;
  }

  function buildColumn(priorityKey) {
    // V3 S(A+B) : les RDV importants sortent des colonnes (vivent dans le bandeau RDV en tête).
    const filtered = visibleRoots.filter(i => i.priority === priorityKey && !i.completed && !i.isImportant && passesRecurringFilter(i) && passesSearchAndFilters(i));
    const ordered = manualOrder[priorityKey] ? filtered : sortItemsAuto(filtered);
    // V3 S(A+B) : les tâches épinglées remontent toujours en tête (au-dessus du tri auto ET du manuel),
    // en conservant leur ordre relatif.
    const pinned = ordered.filter(i => i.pinned);
    const rest = ordered.filter(i => !i.pinned);
    return [...pinned, ...rest];
  }

  const columns = {
    must: { title: 'Must', subtitle: 'À faire — non négociable', accent: 'rust', items: buildColumn('must') },
    should: { title: 'Should', subtitle: 'À planifier — important', accent: 'ocean', items: buildColumn('should') },
    want: { title: 'Want', subtitle: 'Envies — quand c\'est le moment', accent: 'moss', items: buildColumn('want') },
  };

  // V5 : vue « Trier par échéance » — une seule liste, groupée par proximité de l'échéance.
  // Échéance effective d'une tâche = la plus proche entre la sienne et celles de ses sous-tâches ouvertes.
  const sortByDeadline = !!state.settings.sortByDeadline;
  const deadlineGroups = useMemo(() => {
    if (!sortByDeadline) return [];
    const effDl = (it) => {
      const own = !it.completed && it.deadline ? [it.deadline] : [];
      return [...own, ...(it.subtasks || []).map(effDl).filter(Boolean)].sort()[0] || null;
    };
    const pool = visibleRoots.filter(i => ['must', 'should', 'want', 'inbox'].includes(i.priority) && !i.completed && passesRecurringFilter(i) && passesSearchAndFilters(i))
      .map(i => ({ item: i, dl: effDl(i) }))
      .sort((a, b) => (a.dl || '9999-12-31').localeCompare(b.dl || '9999-12-31'));
    const today = todayISO(), weekEnd = weekRange(new Date()).end, monthEnd = monthRange(new Date()).end;
    const buckets = [
      { key: 'late', label: 'En retard', test: d => d && d < today },
      { key: 'today', label: "Aujourd'hui", test: d => d === today },
      { key: 'week', label: 'Cette semaine', test: d => d && d > today && d <= weekEnd },
      { key: 'month', label: 'Ce mois-ci', test: d => d && d > weekEnd && d <= monthEnd },
      { key: 'later', label: 'Plus tard', test: d => d && d > monthEnd },
      { key: 'none', label: 'Sans échéance', test: d => !d },
    ];
    return buckets.map(b => ({ ...b, rows: pool.filter(r => b.test(r.dl)) })).filter(b => b.rows.length);
  }, [sortByDeadline, state.items, state.settings.showRecurringInPriorities, searchQuery, searchScopes, filters]);

  const inboxItems = visibleRoots.filter(i => i.priority === 'inbox' && !i.completed && passesRecurringFilter(i));
  // V3 S5 : "habits" = tâches avec streak (l'onglet Routines filtre dessus)
  const routines = state.items.filter(i => i.streak === true);
  const inboxCount = inboxItems.length;

  // V3 S4 : items archivés (pour vue Archive)
  const archivedItems = rootItems.filter(i => isArchived(i));

  // V3 S4 : items en retard
  const todayIso = todayISO();
  const overdueList = useMemo(() => findOverdueRoots(state.items, todayIso), [state.items, todayIso]);

  // V3 S4 : prochains RDV importants ou tâches importantes du jour (pour bandeau "Aujourd'hui")
  const todayImportant = useMemo(() => {
    const out = [];
    for (const it of flattenItems(state.items)) {
      if (it.completed) continue;
      if (!it.isImportant) continue; // V3 S4 : strict isImportant
      const isToday = it.date === todayIso;
      const recurToday = it.recurrence && hasOccurrenceOnDate(it, todayIso);
      const matchesToday = isToday || recurToday;
      if (!matchesToday) continue;
      // V3 S5 : si streak, statut completed se lit dans history
      if (recurToday && it.streak && (it.history || []).includes(todayIso)) continue;
      if (recurToday && (it.exceptions || {})[todayIso] === 'completed') continue;
      out.push(it);
    }
    out.sort((a, b) => {
      const aT = a.time ? timeToMin(a.time) : 99999;
      const bT = b.time ? timeToMin(b.time) : 99999;
      return aT - bT;
    });
    return out;
  }, [state.items, todayIso]);

  // V3 S(A+B) : RDV importants à venir (aujourd'hui + futur) pour le bandeau d'accueil.
  // Les RDV en retard restent gérés par OverdueBanner. Les RDV sortent des colonnes Must/Should/Want.
  const upcomingImportant = useMemo(() => {
    const out = [];
    for (const it of flattenItems(state.items)) {
      if (it.completed) continue;
      if (!it.isImportant) continue;
      let sortKey = null;
      let occDate = null;
      if (it.recurrence) {
        // Occurrence du jour uniquement (cas RDV récurrent), si pas déjà cochée
        if (!hasOccurrenceOnDate(it, todayIso)) continue;
        if (it.streak && (it.history || []).includes(todayIso)) continue;
        if ((it.exceptions || {})[todayIso] === 'completed') continue;
        occDate = todayIso;
        sortKey = todayIso + 'T' + (it.time || '99:99');
      } else if (it.date) {
        if (it.date < todayIso) continue; // passé → géré par En retard
        sortKey = it.date + 'T' + (it.time || '99:99');
      } else if (it.deadline) {
        if (it.deadline < todayIso) continue; // échéance dépassée → En retard
        sortKey = it.deadline + 'T99:98'; // après les items horodatés du même jour
      } else {
        continue;
      }
      out.push({ item: it, sortKey, occDate });
    }
    out.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    return out;
  }, [state.items, todayIso]);

  // V3 S4 : prochaine échéance pour header badge (RDV/important à venir aujourd'hui)
  // V3 S4.5 : si prep ou trajet renseignés, le countdown vise le début de prep (= heure où il faut s'y mettre)
  const nextUpcoming = useMemo(() => {
    if (!showHeaderBadge) return null;
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    for (const it of todayImportant) {
      if (!it.time) continue;
      const t = timeToMin(it.time);
      if (t == null) continue;
      const prep = (typeof it.prepDuration === 'number' && it.prepDuration > 0) ? it.prepDuration : 0;
      const trav = (typeof it.travelDuration === 'number' && it.travelDuration > 0) ? it.travelDuration : 0;
      // Cible du countdown = début de prep (option prudente, validée)
      const targetMin = t - trav - prep;
      if (targetMin >= nowMin) {
        return {
          item: it,
          minutesUntil: targetMin - nowMin,
          targetMin,
          hasHalo: prep > 0 || trav > 0,
          prep, trav,
        };
      }
      // V5 : heure de prep/départ dépassée mais RDV pas encore commencé → le badge reste, en ocre
      if ((prep > 0 || trav > 0) && t > nowMin) {
        return { item: it, late: true, lateBy: nowMin - targetMin, minutesUntil: t - nowMin, targetMin, hasHalo: true, prep, trav };
      }
    }
    return null;
  }, [todayImportant, syncTick, showHeaderBadge]);

  // Toggle theme
  function toggleTheme() {
    setState(s => ({ ...s, settings: { ...s.settings, theme: s.settings.theme === 'light' ? 'dark' : 'light' } }));
  }

  // V3 S4 : reporter un item ou une occurrence en retard
  function postponeItem(itemId, sourceDate, newDate) {
    const it = findItem(state.items, itemId);
    if (!it) return;
    pushUndoSnapshot('postpone', 'report');
    if (it.recurrence) {
      moveOccurrence(itemId, sourceDate, newDate, it.time);
      showToast('Reporté');
    } else {
      updateItem(itemId, { date: newDate });
      showToast('Reporté');
    }
  }

  // V3 S4 : déplacer une sous-tâche vers un nouveau parent
  // Si dragged est racine ET target est racine → fait un rerooting (devient sous-tâche du target)
  // Si dragged est sous-tâche → change de parent
  function reparentSubtask(draggedId, newParentId) {
    if (draggedId === newParentId) return;
    pushUndoSnapshot('reparent', 'rattachement sous-tâche');
    setState(s => {
      const dragged = findItem(s.items, draggedId);
      if (!dragged) return s;
      // Test boucle : newParentId est-il dans les descendants de dragged ?
      function isDescendant(node, targetId) {
        if (!node.subtasks) return false;
        for (const sub of node.subtasks) {
          if (sub.id === targetId) return true;
          if (isDescendant(sub, targetId)) return true;
        }
        return false;
      }
      if (isDescendant(dragged, newParentId)) {
        return s;
      }
      function removeFromTree(items, id) {
        return items.filter(i => i.id !== id).map(i => ({
          ...i,
          subtasks: i.subtasks ? removeFromTree(i.subtasks, id) : []
        }));
      }
      let newItems = removeFromTree(s.items, draggedId);
      const draggedAsSub = { ...dragged, priority: null };
      newItems = addSubtaskToTree(newItems, newParentId, draggedAsSub);
      return { ...s, items: newItems };
    });
    showToast('Déplacé en sous-tâche');
  }

  // V3 S4 : restaurer un item archivé (le décocher → repart en cours)
  function restoreItem(id) {
    updateItem(id, { completed: false, completedAt: null });
    showToast('Tâche restaurée');
  }

  // V5 lot 2 : vue de la session avec le temps restant calculé à l'instant (runTick force le rendu chaque seconde)
  const runningView = running ? { ...running, secondsLeft: runningLeft(running, Date.now()), tick: runTick } : null;

  if (focusMode) {
    const item = findItem(state.items, focusMode);
    if (!item) { setFocusMode(null); return null; }
    const isThis = running && running.itemId === item.id;
    return <FocusScreen
      item={item}
      onReduce={() => setFocusMode(null)}
      running={runningView}
      onStart={() => startTask(item.id)}
      onPauseResume={pauseResume}
      onStop={stopTask}
      onSkip={skipPhase}
      onExtend={() => extendSession(5)}
      onComplete={() => { if (isThis) finishSession(); else { toggleComplete(item); setFocusMode(null); } }}
      categories={state.categories}
    />;
  }

  return (
    <div>
      {/* Running banner */}
      {runningView && <RunningBanner running={runningView} item={findItem(state.items, running.itemId)} onPauseResume={pauseResume} onStop={stopTask} onOpen={() => setFocusMode(running.itemId)} onSkip={skipPhase} onFinish={finishSession} onExtend={() => extendSession(5)} />}

      {/* Confettis */}
      {confettis.length > 0 && (
        <div style={{ position: 'fixed', top: '50%', left: 0, right: 0, pointerEvents: 'none', zIndex: 200 }}>
          {confettis.map(p => (
            <div key={p.id} className="confetti-particle" style={{ left: `${p.left}%`, background: p.color, animationDelay: `${p.delay}s` }} />
          ))}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`toast ${toast.leaving ? 'leaving' : ''}`}>
          <span>{toast.message}</span>
          {toast.action && (
            <button onClick={() => { toast.action.onClick(); setToast(null); }}>{toast.action.label}</button>
          )}
          {(toast.extraActions || []).map(a => (
            <button key={a.label} title={a.title} className="toast-feel" onClick={() => { a.onClick(); setToast(null); }}>{a.label}</button>
          ))}
        </div>
      )}

      <div className="paper-texture" style={{ maxWidth: '1280px', margin: '0 auto', padding: '2rem 1.25rem' }}>
        <header style={{ marginBottom: '2rem' }}>
          <div className="header-grid" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1.5rem', borderBottom: '1px solid var(--ink)', paddingBottom: '1rem', gap: '0.75rem' }}>
            <div style={{ flexShrink: 0 }}>
              <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', whiteSpace: 'nowrap', flexWrap: 'wrap' }}>
                {new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}
                {todayCapacity && <span> · {ENERGY_PRESETS.find(p => p.id === todayCapacity.mode)?.emoji || '⚓'} {todayCapacity.hours}h</span>}
                {currentFocusLabel && <span className="focus-chip" title="Le focus que tu as posé pour cette semaine" onClick={() => setView('caps')}>✦ Cette semaine : {currentFocusLabel.length > 32 ? currentFocusLabel.slice(0, 32) + '…' : currentFocusLabel}</span>}
              </div>
              {/* Le logo 2A tient lieu de titre — le mot « Cap » reste pour les lecteurs d'écran. */}
              <h1 style={{ display: 'flex', alignItems: 'center', margin: 0, lineHeight: 1 }}>
                <CapMark size="clamp(2.8rem, 7vw, 4rem)" />
                <span style={{ position: 'absolute', width: '1px', height: '1px', padding: 0, margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 }}>Cap</span>
              </h1>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              {nextUpcoming && (() => {
                // V3 S4.5 : si halo (prep ou trajet), on affiche l'heure cible (= début prep) + un picto + tooltip détaillé
                const item = nextUpcoming.item;
                const tgt = nextUpcoming.targetMin;
                const targetLabel = minToTime(Math.max(0, tgt));
                const titleTrunc = item.title.length > 22 ? item.title.slice(0, 22) + '…' : item.title;
                const m = nextUpcoming.minutesUntil;
                const countdown = m < 60 ? `${m}min` : `${Math.floor(m / 60)}h${m % 60 ? (m % 60) : ''}`;
                const tooltip = nextUpcoming.hasHalo
                  ? `${item.title}\nRDV à ${item.time}${nextUpcoming.prep > 0 ? ` · prep ${nextUpcoming.prep}min` : ''}${nextUpcoming.trav > 0 ? ` · trajet ${nextUpcoming.trav}min` : ''}\nÀ commencer à ${targetLabel}`
                  : `${item.title} à ${item.time}`;
                const icon = nextUpcoming.prep > 0 ? '🎒' : (nextUpcoming.trav > 0 ? '🚗' : null);
                const late = !!nextUpcoming.late;
                const bc = late ? 'var(--ochre)' : 'var(--rust)';
                return (
                  <div title={tooltip} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.3rem 0.6rem', border: `1px solid ${bc}`, background: late ? 'rgba(196,135,41,0.12)' : 'rgba(184,72,46,0.08)', color: bc, borderRadius: '999px', fontSize: '0.72rem', fontWeight: 600 }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: bc }} />
                    {icon && <span style={{ fontSize: '0.75rem' }}>{icon}</span>}
                    {late ? <>RDV {item.time} · {titleTrunc}</> : <>{targetLabel} · {titleTrunc}</>}
                    <span style={{ fontWeight: 400, opacity: 0.85 }}>{late ? `· ${nextUpcoming.prep > 0 ? 'préparation prévue' : 'départ prévu'} à ${targetLabel}, RDV dans ${countdown}` : `· dans ${countdown}`}</span>
                    <button onClick={() => setShowHeaderBadge(false)} title="Masquer ce badge (réactivable dans Réglages)" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: bc, padding: 0, marginLeft: '0.2rem', display: 'inline-flex', alignItems: 'center' }}>
                      <IconX size={11} />
                    </button>
                  </div>
                );
              })()}
              <SyncIndicator status={cloudStatus} lastSyncedAt={lastSyncedAt} tick={syncTick} />
              <button className="theme-toggle" onClick={toggleTheme} title="Basculer thème">
                {state.settings.theme === 'light' ? <IconMoon size={14} /> : <IconSun size={14} />}
              </button>
              <button className="btn" onClick={() => setShowCheckin(true)} title="Check-in du jour">
                {todayCapacity ? `${ENERGY_PRESETS.find(p => p.id === todayCapacity.mode)?.emoji || '⚓'} ${todayCapacity.hours}h` : 'Check-in'}
              </button>
              <button className="btn" onClick={suggestNext}><IconSparkles size={14} /> Je commence par quoi ?</button>
              <button className="btn btn-rust" onClick={() => { setQuickAddPrefill(null); setShowQuickAdd(true); }}><IconPlus size={14} /> Nouveau</button>
              <button className="btn-ghost" onClick={handleLogout} title={`Connecté en tant que ${userEmail}`} style={{ border: '1px solid var(--line)', padding: '0.3rem 0.5rem', fontSize: '0.7rem', color: 'var(--ink-muted)', background: 'transparent', cursor: 'pointer', borderRadius: '3px' }}>
                Déconnexion
              </button>
            </div>
          </div>

          {/* Capacity gauge */}
          {todayCapacity && <CapacityGauge capacity={todayCapacity} estimatedMin={todayEstimatedMinutes} actualMin={todayActualMinutes} />}

          {/* Quick capture */}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1.5rem', marginTop: '1.5rem' }}>
            <IconInbox size={16} />
            <input ref={quickCaptureRef} className="input" placeholder="Capture rapide — tape ici, trie plus tard…  (raccourci : / )" value={quickCapture} onChange={e => setQuickCapture(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleQuickCapture()} style={{ flex: 1 }} />
            <button className="btn" onClick={handleQuickCapture} disabled={!quickCapture.trim()}>Ajouter</button>
          </div>

          {/* Nav */}
          <nav style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', borderBottom: '1px solid var(--line)', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: '0.2rem', flexWrap: 'wrap' }}>
              <div className={`nav-tab ${view === 'priorities' ? 'active' : ''}`} onClick={() => setView('priorities')}><IconTarget size={14} /> Priorités</div>
              <div className={`nav-tab ${view === 'inbox' ? 'active' : ''}`} onClick={() => setView('inbox')}><IconInbox size={14} /> Boîte · {inboxCount}</div>
              <div className={`nav-tab ${view === 'calendar' ? 'active' : ''}`} onClick={() => setView('calendar')}><IconCalendar size={14} /> Agenda</div>
              <div className={`nav-tab ${view === 'caps' ? 'active' : ''}`} onClick={() => setView('caps')}><IconCompass size={14} /> Boussole</div>
              <div className={`nav-tab ${view === 'routines' ? 'active' : ''}`} onClick={() => setView('routines')}><IconFlame size={14} /> Routines · {routines.length}</div>
              <div className={`nav-tab ${view === 'pillars' ? 'active' : ''}`} onClick={() => setView('pillars')}><IconScales size={14} /> Piliers</div>
              <div className={`nav-tab ${view === 'archive' ? 'active' : ''}`} onClick={() => setView('archive')}>📦 Archive · {archivedItems.length}</div>
            </div>
            <div style={{ display: 'flex', gap: '0.2rem', paddingBottom: '0.3rem' }}>
              <button className="btn-ghost" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-muted)', padding: '0.3rem 0.5rem', fontSize: '0.75rem', display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }} onClick={() => setShowSettings(true)}>
                <IconSettings size={14} /> Réglages
              </button>
              <button className="btn-ghost" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-muted)', padding: '0.3rem 0.5rem', fontSize: '0.75rem', display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }} onClick={exportData}>
                <IconDownload size={14} /> Export
              </button>
              <label className="btn-ghost" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-muted)', padding: '0.3rem 0.5rem', fontSize: '0.75rem', display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }}>
                <IconUpload size={14} /> Import
                <input type="file" accept=".json" onChange={importData} style={{ display: 'none' }} />
              </label>
            </div>
          </nav>
        </header>

        {/* VIEWS */}
        {view === 'priorities' && (
          <>
            <SearchAndFilters
              searchQuery={searchQuery} setSearchQuery={setSearchQuery}
              searchScopes={searchScopes} setSearchScopes={setSearchScopes}
              filtersOpen={filtersOpen} setFiltersOpen={setFiltersOpen}
              filters={filters} setFilters={setFilters}
              categories={state.categories}
            />
            {showReviewInvite && <WeeklyReviewInvite onOpen={() => setShowReview(true)} onSkip={skipReview} />}
            {upcomingImportant.length > 0 && (
              <RdvBanner rdvs={upcomingImportant} categories={state.categories} todayIso={todayIso} onEdit={(it, occDate) => { setEditingOccurrenceDate(occDate || null); setEditingItem(it); }} />
            )}
            {overdueList.length > 0 && (
              <OverdueBanner overdues={overdueList} categories={state.categories} onEdit={(it, occDate) => { setEditingOccurrenceDate(occDate || null); setEditingItem(it); }} onPostpone={postponeItem} onMarkDone={(it, occDate) => { if (it.recurrence || it.streak) { toggleOccurrenceComplete(it.id, occDate || todayISO()); } else { toggleComplete(it); } }} />
            )}
            {/* V3 S5 : toggle pour afficher/masquer les tâches récurrentes dans Priorités */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem', fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!state.settings.showRecurringInPriorities}
                  onChange={(e) => setState(s => ({ ...s, settings: { ...s.settings, showRecurringInPriorities: e.target.checked } }))}
                  style={{ cursor: 'pointer' }}
                />
                <span>Afficher les récurrentes</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer', marginLeft: '0.8rem' }}>
                <input
                  type="checkbox"
                  checked={sortByDeadline}
                  onChange={(e) => setState(s => ({ ...s, settings: { ...s.settings, sortByDeadline: e.target.checked } }))}
                  style={{ cursor: 'pointer' }}
                />
                <span>Trier par échéance</span>
              </label>
            </div>
            <CapsContext.Provider value={{ caps: state.caps || [], onOpenCap: () => setView('caps') }}>
            {sortByDeadline && (
              <div className="deadline-list">
                {deadlineGroups.length === 0 && <div style={{ fontSize: '0.85rem', color: 'var(--ink-fog)', fontStyle: 'italic', padding: '1rem 0' }}>Rien à afficher.</div>}
                {deadlineGroups.map(g => (
                  <div key={g.key} style={{ marginBottom: '1.2rem' }}>
                    <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: g.key === 'late' ? 'var(--rust)' : 'var(--ink-muted)', borderBottom: '1px solid var(--line)', paddingBottom: '0.3rem', marginBottom: '0.5rem' }}>
                      {g.label} · {g.rows.length}
                    </div>
                    {g.rows.map(({ item }) => (
                      <div key={item.id} className="deadline-row">
                        <span className={`prio-tag prio-${item.priority}`}>{item.priority === 'inbox' ? 'Boîte' : item.priority.charAt(0).toUpperCase() + item.priority.slice(1)}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <TaskCard item={item} categories={state.categories} runningId={running?.itemId}
                            onToggle={toggleComplete} onEdit={setEditingItem}
                            onStart={startTask}
                            onAddSub={(parentId) => { setEditingParentId(parentId); setShowAddModal(true); }}
                            onReorder={reorderItems} onSubtaskDrop={reparentSubtask} depth={0}
                            selectedId={selectedItemId} onSelect={setSelectedItemId}
                            searchHighlight={searchQuery} onTogglePin={togglePin} />
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {!sortByDeadline && <div className="columns-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem' }}>
              {Object.entries(columns).map(([key, c]) => (
                <Column key={key} colKey={key} column={c} categories={state.categories} runningId={running?.itemId}
                  onDrop={(itemId) => {
                    pushUndoSnapshot('priority', 'changement priorité');
                    const isRoot = state.items.some(it => it.id === itemId);
                    if (isRoot) {
                      updateItem(itemId, { priority: key });
                    } else {
                      // Promotion sous-tâche → racine
                      setState(s => {
                        const sub = findItem(s.items, itemId);
                        if (!sub) return s;
                        function removeFromTree(items, id) {
                          return items.filter(i => i.id !== id).map(i => ({
                            ...i, subtasks: i.subtasks ? removeFromTree(i.subtasks, id) : []
                          }));
                        }
                        const newItems = removeFromTree(s.items, itemId);
                        const promoted = { ...sub, priority: key };
                        return { ...s, items: [promoted, ...newItems] };
                      });
                      showToast('Sous-tâche promue en tâche');
                    }
                  }}
                  onReorder={reorderItems}
                  onSubtaskDrop={reparentSubtask}
                  onToggle={toggleComplete} onEdit={setEditingItem}
                  onStart={startTask}
                  onAddSub={(parentId) => { setEditingParentId(parentId); setShowAddModal(true); }}
                  onTogglePin={togglePin}
                  selectedId={selectedItemId} onSelect={setSelectedItemId}
                  manualOrder={manualOrder[key]}
                  onResetManual={() => setManualOrder(m => ({ ...m, [key]: false }))}
                  searchHighlight={searchQuery}
                />
              ))}
            </div>}
            </CapsContext.Provider>
          </>
        )}

        {view === 'inbox' && <InboxView items={inboxItems} categories={state.categories} onToggle={toggleComplete} onEdit={setEditingItem} onUpdatePriority={(id, p) => updateItem(id, { priority: p })} onDelete={deleteItem} />}

        {view === 'calendar' && <CalCapsCtx.Provider value={{ marks: lowModeOn ? {} : capDeadlineMarks(state.caps || []), onOpenCap: () => setView('caps') }}><CalendarView
          items={state.items} categories={state.categories}
          calView={calView} setCalView={setCalView}
          calDate={calDate} setCalDate={setCalDate}
          onUpdate={updateItem}
          onEdit={(it, occDate) => { setEditingOccurrenceDate(occDate || null); setEditingItem(it); }}
          onDropTask={(payload, date, startMin) => handleCalendarDrop(payload, date, startMin)}
          onResize={(itemId, occDate, newDur) => resizeOccurrence(itemId, occDate, newDur)}
          onAddAtSlot={(date, startMin) => {
            setQuickAddPrefill({ date, time: minToTime(snap5(startMin)) });
            setShowQuickAdd(true);
          }}
          onToggleOccurrence={(itemId, occDate, occTime) => {
            if (!occDate) {
              const it = findItem(state.items, itemId);
              if (it) toggleComplete(it);
            } else {
              toggleOccurrenceComplete(itemId, occDate, occTime);
            }
          }}
          onToggleComplete={toggleComplete}
          dailyIntention={state.dailyIntentions?.[calDate] || ''}
          onSetDailyIntention={setDailyIntention}
          todayCapacity={todayCapacity}
          todayEstimatedMinutes={todayEstimatedMinutes}
          todayActualMinutes={todayActualMinutes}
        /></CalCapsCtx.Provider>}

        {view === 'routines' && <RoutinesView items={routines} categories={state.categories} onToggle={toggleComplete} onEdit={setEditingItem} onDelete={deleteItem} onAdd={() => { setEditingParentId(null); setShowAddModal(true); }} />}
        {view === 'pillars' && <PiliersView moneyProps={moneyProps} fluxProps={fluxProps} />}
        {view === 'routines' && <QuitsSection quits={state.quits || []} onAdd={addQuit} onToggleSlip={toggleQuitSlip} onDelete={deleteQuit} />}

        {view === 'caps' && <BoussoleTaskCtx.Provider value={{
          categories: state.categories,
          onToggle: toggleComplete,
          onEdit: (it) => setEditingItem(it),
          onAddSub: (parentId) => { setEditingParentId(parentId); setShowAddModal(true); },
          onStart: startTask,
          onReorder: reorderItems,
          onSubtaskDrop: reparentSubtask,
          onTogglePin: togglePin,
          runningId: running?.itemId,
          selectedId: selectedItemId,
          onSelect: setSelectedItemId,
        }}><BoussoleCapCtx.Provider value={{ lowMode: lowModeOn, onDecision: recordCapDecision }}><BoussoleView
          lowMode={state.lowMode}
          onSetLowMode={setLowMode}
          onOpenReview={() => setShowReview(true)}
          weekFocusLabel={currentFocusLabel}
          monthCapLabel={monthCapLabel}
          caps={state.caps || []}
          visions={state.visions || []}
          items={state.items}
          categories={state.categories}
          activeObjectiveCount={activeObjectiveCount}
          onAddObjective={() => setCapEditor({ mode: 'objective', node: null, parentId: null })}
          onEditCap={(node, depth) => setCapEditor({ mode: depth === 0 ? 'objective' : 'node', node, parentId: null })}
          onAddNode={(parentId) => setCapEditor({ mode: 'node', node: null, parentId })}
          onSetStatus={setCapStatus}
          onMoveCap={moveCap}
          onDeleteCap={deleteCap}
          onAddVision={addVision}
          onUpdateVision={updateVision}
          onDeleteVision={deleteVision}
          onAddTaskToCap={(capId) => { setQuickAddPrefill({ capId }); setEditingParentId(null); setShowAddModal(true); }}
          onLinkTaskToCap={linkTaskToCap}
          onEditTask={(it) => setEditingItem(it)}
          onToggleTask={toggleComplete}
        /></BoussoleCapCtx.Provider></BoussoleTaskCtx.Provider>}

        {view === 'archive' && (
          <ArchiveView
            archivedItems={archivedItems}
            categories={state.categories}
            searchQuery={searchQuery}
            searchScopes={searchScopes}
            setSearchQuery={setSearchQuery}
            setSearchScopes={setSearchScopes}
            onRestore={restoreItem}
            onEdit={setEditingItem}
            onDelete={deleteItem}
            onEmpty={emptyArchive}
          />
        )}

        <footer style={{ marginTop: '3rem', paddingTop: '1rem', borderTop: '1px solid var(--line)', fontSize: '0.75rem', color: 'var(--ink-muted)', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
          <span className="mono">{flattenItems(state.items).filter(i => !i.completed && !i.streak).length} ouvertes · {flattenItems(state.items).filter(i => i.completed).length} terminées</span>
          <span className="display" style={{ fontStyle: 'italic' }}>Garde le cap.</span>
        </footer>
      </div>

      {/* MODALS */}
      {showQuickAdd && <QuickAddModal
        categories={state.categories}
        prefill={quickAddPrefill}
        onClose={() => { setShowQuickAdd(false); setQuickAddPrefill(null); }}
        onSave={(data) => {
          // V3 S(C1) : chevauchement autorisé — on informe sans bloquer.
          warnOnCreate(data);
          addItem(data, null);
          setShowQuickAdd(false);
          setQuickAddPrefill(null);
        }}
        onMore={(data) => {
          // Bascule vers modale complète : on ferme quick et on ouvre full avec prefill
          setShowQuickAdd(false);
          setQuickAddPrefill(data); // réutilise pour la modale complète
          setEditingParentId(null);
          setShowAddModal(true);
        }}
      />}
      {showAddModal && <ItemModal categories={state.categories} caps={state.caps || []} visions={state.visions || []} parentId={editingParentId} parentItem={editingParentId ? findItem(state.items, editingParentId) : null} initialData={quickAddPrefill} onClose={() => { setShowAddModal(false); setEditingParentId(null); setQuickAddPrefill(null); }} onSave={(data) => {
        // V3 S(C1) : chevauchement autorisé — on informe sans bloquer.
        warnOnCreate(data);
        addItem(data, editingParentId);
        setShowAddModal(false); setEditingParentId(null); setQuickAddPrefill(null);
      }} onAddCategory={(cat) => setState(s => ({ ...s, categories: [...s.categories, cat] }))} />}
      {editingItem && (() => {
        const isOccurrence = !!editingOccurrenceDate;
        const isRecurring = !!editingItem.recurrence;
        const closeAll = () => { setEditingItem(null); setEditingOccurrenceDate(null); };

        // V3 S4 : test chevauchement si data a date+heure+durée et que la cible bouge
        // V3 S4.5 : étendu au halo prep/trajet (data porte les nouveaux champs)
        const checkOverlap = (data) => {
          if (!data.date || !data.time) return null;
          const start = timeToMin(data.time);
          if (start == null) return null;
          const dur = durationToMinutes(data.duration || {}) || 0;
          const eff = getEffectiveBounds(data, start, dur);
          const excludeKey = isOccurrence ? `${editingItem.id}|${editingOccurrenceDate}` : `${editingItem.id}|${editingItem.date}`;
          return findOverlapAt(state.items, data.date, eff.start, eff.end, excludeKey);
        };

        const handleSave = (data) => {
          // V3 S(C1) : chevauchement autorisé — on informe sans bloquer.
          const overlap = checkOverlap(data);
          if (overlap) showToast(formatConflictToast(overlap));
          if (isOccurrence && isRecurring) {
            const changed = Object.keys(data).some(k => JSON.stringify(data[k]) !== JSON.stringify(editingItem[k]));
            if (!changed) { closeAll(); return; }
            setPendingScope({ kind: 'edit', itemId: editingItem.id, occDate: editingOccurrenceDate, patch: data });
            return;
          }
          updateItem(editingItem.id, data);
          closeAll();
        };

        const handleDelete = () => {
          if (isOccurrence && isRecurring) {
            setPendingScope({ kind: 'delete', itemId: editingItem.id, occDate: editingOccurrenceDate });
            return;
          }
          deleteItem(editingItem.id);
          closeAll();
        };

        // V3 S(A+B) : état "fait" lisible dans la modale (case Terminé)
        const occForDone = editingOccurrenceDate || todayISO();
        let isDone;
        if (editingItem.streak) {
          isDone = (editingItem.history || []).includes(occForDone);
        } else if (isRecurring) {
          isDone = (editingItem.exceptions || {})[occForDone] === 'completed';
        } else {
          isDone = !!editingItem.completed;
        }
        const handleMarkDone = () => {
          if (editingItem.recurrence || editingItem.streak) {
            toggleOccurrenceComplete(editingItem.id, occForDone);
          } else {
            toggleComplete(editingItem);
          }
          closeAll();
        };

        return <ItemModal
          item={editingItem}
          occurrenceDate={editingOccurrenceDate}
          categories={state.categories}
          caps={state.caps || []}
          visions={state.visions || []}
          onClose={closeAll}
          onSave={handleSave}
          onDelete={handleDelete}
          isDone={isDone}
          onMarkDone={handleMarkDone}
          onDuplicate={() => { duplicateItem(editingItem.id); closeAll(); }}
          onAddCategory={(cat) => setState(s => ({ ...s, categories: [...s.categories, cat] }))}
        />;
      })()}
      {capEditor && <CapModal
        mode={capEditor.mode}
        node={capEditor.node}
        visions={state.visions || []}
        activeObjectiveCount={activeObjectiveCount}
        onClose={() => setCapEditor(null)}
        onSave={(data) => {
          if (capEditor.node) {
            updateCap(capEditor.node.id, data);
          } else if (capEditor.mode === 'objective') {
            addObjective(data);
          } else {
            addCapNode(capEditor.parentId, data);
          }
          setCapEditor(null);
        }}
      />}
      {pendingScope && (
        <ScopeModal
          kind={pendingScope.kind}
          onClose={() => setPendingScope(null)}
          onConfirm={(scope) => {
            const { kind, itemId, occDate, patch } = pendingScope;
            if (kind === 'edit') updateOccurrenceWithScope(itemId, occDate, patch, scope);
            if (kind === 'delete') deleteOccurrenceWithScope(itemId, occDate, scope);
            setPendingScope(null);
            setEditingItem(null);
            setEditingOccurrenceDate(null);
          }}
        />
      )}
      {sessionSummary && <SessionSummaryModal summary={sessionSummary}
        onFeel={(f) => { const nf = sessionSummary.feel === f ? null : f; updateItem(sessionSummary.itemId, { feel: nf }); setSessionSummary(ss => ss && { ...ss, feel: nf }); }}
        onClose={() => setSessionSummary(null)} />}
      {showSuggestion && <SuggestionModal task={suggestedTask} categories={state.categories} onClose={() => setShowSuggestion(false)} onStart={(id) => { setShowSuggestion(false); startTask(id); }} />}
      {showCheckin && <CheckinModal currentMode={todayCapacity?.mode} onClose={() => setShowCheckin(false)} onSelect={(preset, hours) => { setState(s => ({ ...s, capacity: { ...s.capacity, [today]: { mode: preset, hours } } })); setShowCheckin(false); }} />}
      {showReview && <WeeklyReviewModal state={state} lowMode={lowModeOn} week={reviewWeek} extraSteps={reviewExtraSteps}
        onClose={() => setShowReview(false)} onFinish={finishReview}
        onCapDecision={recordCapDecision} onSetCapStatus={setCapStatus} onUpdateCap={updateCap} onAddNudgeTask={addNudgeTask} />}
      {showSettings && <SettingsModal settings={state.settings} categories={state.categories} userEmail={userEmail} onClose={() => setShowSettings(false)} onSave={(newSettings) => setState(s => ({ ...s, settings: newSettings }))} onUpdateCategories={(cats) => setState(s => ({ ...s, categories: cats }))} onDeleteAccount={handleDeleteAccount}
        push={{ status: pushInfo.status, onEnable: enablePush, onDisable: disablePush, onTest: testPush }} />}
    </div>
  );
}

// ============ RUNNING BANNER ============
// ============ V5 LOT 2 : SESSION « DÉMARRER » ============
// Plan de la session (minutes de chaque tranche de travail) à partir de la durée prévue :
//  ≤ D → une tranche ; > D → D, D, …, reste (un reste < 5 min s'ajoute à la dernière tranche) ;
//  pas de durée → null = pomodoro classique en boucle.
function buildSessionPlan(planMin, D) {
  if (!planMin || planMin <= 0) return null;
  if (planMin <= D) return [planMin];
  const slices = [];
  let rest = planMin;
  while (rest > D) { slices.push(D); rest -= D; }
  if (rest < 5) slices[slices.length - 1] += rest;
  else slices.push(rest);
  return slices;
}

// Durée à planifier : estimé − temps déjà passé (min 5) ; estimation dépassée → une tranche D.
// Récurrentes : toujours la durée complète (leur temps cumulé couvre toutes les occurrences).
function sessionPlanMinutes(item, settings) {
  const est = effectiveDurationMinutes(item);
  if (!est) return 0;
  if (item.recurrence || item.streak) return est;
  const done = item.actualMinutes || 0;
  if (done <= 0) return est;
  if (done < est) return Math.max(5, est - done);
  return settings.pomoFocus;
}

// Secondes restantes de la phase en cours (calculées depuis l'heure de fin : pas de dérive).
function runningLeft(r, now) {
  if (!r || r.mode === 'done') return 0;
  if (r.paused) return r.pausedLeft || 0;
  return Math.max(0, Math.ceil((r.endsAt - now) / 1000));
}

// Avance la session jusqu'à `now`. Les phases s'enchaînent sur l'horaire prévu (pas sur l'heure du tick).
// Une pause finie depuis plus d'une minute (Cap endormi / fermé) ne relance pas seule la tranche suivante :
// elle attend en pause → au plus une tranche comptée pendant une absence.
// Retourne { next, credits: [{ min, full, at }], events }.
function stepRunning(r, now, settings) {
  const credits = [], events = [];
  let cur = r;
  let guard = 0;
  while (cur && !cur.paused && cur.mode !== 'done' && cur.endsAt <= now && guard++ < 50) {
    const late = now - cur.endsAt > 60000;
    if (cur.mode === 'focus') {
      const min = Math.round(cur.totalSeconds / 60);
      credits.push({ min, full: cur.totalSeconds >= settings.pomoFocus * 60, at: cur.endsAt });
      const cycles = cur.cycles + 1;
      const workedMin = (cur.workedMin || 0) + min;
      if (cur.plan && cur.slice >= cur.plan.length - 1) {
        cur = { ...cur, mode: 'done', cycles, workedMin, endsAt: null, pausedLeft: null, totalSeconds: 0 };
        events.push('planDone');
        break;
      }
      const isLong = cycles % (settings.pomoCyclesBeforeLongBreak || 4) === 0;
      const breakMin = isLong ? settings.pomoLongBreak : settings.pomoBreak;
      cur = { ...cur, mode: isLong ? 'longBreak' : 'break', cycles, workedMin, totalSeconds: breakMin * 60, endsAt: cur.endsAt + breakMin * 60000 };
      events.push('workEnd');
    } else {
      const slice = cur.slice + 1;
      const dur = cur.plan ? cur.plan[slice] : settings.pomoFocus;
      if (late) {
        cur = { ...cur, mode: 'focus', slice, totalSeconds: dur * 60, paused: true, pausedLeft: dur * 60, endsAt: null };
        events.push('waitResume');
        break;
      }
      cur = { ...cur, mode: 'focus', slice, totalSeconds: dur * 60, endsAt: cur.endsAt + dur * 60000 };
      events.push('breakEnd');
    }
  }
  return { next: cur, credits, events };
}

// V5 lot 4 : fins de phase à venir d'une session en cours (pour les notifications push, Cap fermé).
// On simule l'enchaînement prévu (sans pause) : tranche → pause → … → temps prévu écoulé. 12 phases max.
function sessionReminders(r, title, settings) {
  if (!r || r.paused || r.mode === 'done' || !r.endsAt) return [];
  const out = [];
  let cur = r;
  for (let i = 0; i < 12 && cur && !cur.paused && cur.mode !== 'done' && cur.endsAt; i++) {
    const at = cur.endsAt;
    const { next, events } = stepRunning(cur, at, settings);
    const ev = events[events.length - 1];
    const [t, b] = ev === 'planDone' ? ['Temps prévu écoulé', `« ${title} » — c'est fini ?`]
      : ev === 'workEnd' ? ['Tranche terminée', 'Petite pause, tu l\'as méritée 🌿']
      : ['Pause terminée', 'On repart 💪'];
    out.push({ key: `s:${r.itemId}:${r.startedAt}:${at}`, itemId: r.itemId, dueAt: at, title: `⏱ ${t}`, body: b, kind: 'session' });
    if (!ev || next === cur) break;
    cur = next;
  }
  return out;
}

function sessionModeLabel(r) {
  if (!r) return '';
  if (r.mode === 'done') return 'Temps prévu écoulé';
  if (r.mode === 'longBreak') return 'Longue pause';
  if (r.mode === 'break') return 'Pause';
  if (r.plan && r.plan.length > 1) return `Tranche ${Math.min(r.slice + 1, r.plan.length)}/${r.plan.length}`;
  if (!r.plan) return `Pomodoro ${r.slice + 1}`;
  return 'Focus';
}

function RunningBanner({ running, item, onPauseResume, onStop, onOpen, onSkip, onFinish, onExtend }) {
  const min = Math.floor(running.secondsLeft / 60);
  const sec = running.secondsLeft % 60;
  const done = running.mode === 'done';
  const modeLabel = sessionModeLabel(running) + (running.paused ? ' · en pause' : '');
  const modeColor = running.mode === 'focus' ? 'var(--rust)' : done ? 'var(--ochre)' : 'var(--moss)';
  const btn = { background: 'transparent', color: 'var(--paper)', border: '1px solid var(--paper)', padding: '0.2rem 0.5rem', borderRadius: '3px', cursor: 'pointer', fontSize: '0.75rem' };
  return (
    <div className="running-banner">
      <div className="running-pulse" style={{ background: modeColor }} />
      <span style={{ fontWeight: 600 }}>{modeLabel}</span>
      {!done && <span className="mono">{String(min).padStart(2, '0')}:{String(sec).padStart(2, '0')}</span>}
      <span style={{ flex: 1, opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }} onClick={onOpen}>{item ? `· ${item.title}` : ''}</span>
      {done ? (
        <button onClick={onExtend} style={btn} title="Encore 5 minutes">+5 min</button>
      ) : (
        <>
          <button onClick={onPauseResume} style={btn} title={running.paused ? 'Reprendre' : 'Pause'}>
            {running.paused ? <IconPlay size={12} /> : <IconPause size={12} />}
          </button>
          <button onClick={onSkip} style={btn} title="Passer à la phase suivante">⏭</button>
        </>
      )}
      <button onClick={onFinish} style={btn} title="Fini"><IconCheck size={12} /></button>
      <button onClick={onStop} style={btn} title="Arrêter (le temps passé est gardé)"><IconStop size={12} /></button>
      <button onClick={onOpen} style={btn} title="Plein écran (F)"><IconMaximize size={12} /></button>
    </div>
  );
}

// V5 lot 2 : bilan neutre après « Fini » — estimé / réel, ressenti facultatif. Pas de verdict.
function SessionSummaryModal({ summary, onFeel, onClose }) {
  const { title, icon, estMin, realMin, recurring, feel } = summary;
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); onClose(); } }} tabIndex={-1} ref={el => el && el.focus()} style={{ maxWidth: '440px', textAlign: 'center', outline: 'none' }}>
        <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: '0.75rem' }}>Fini</div>
        <h2 className="display" style={{ fontSize: '1.6rem', fontWeight: 500, fontStyle: 'italic', margin: '0 0 1rem 0' }}>
          ✓ {icon && <span style={{ marginRight: '0.3rem' }}>{icon}</span>}« {title} »
        </h2>
        <div className="mono session-summary-times" style={{ display: 'flex', justifyContent: 'center', gap: '1.5rem', fontSize: '0.85rem', marginBottom: '1.2rem' }}>
          <div><div style={{ fontSize: '0.65rem', color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Estimé</div>{estMin > 0 ? fmtMin(estMin) : '—'}</div>
          <div><div style={{ fontSize: '0.65rem', color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{recurring ? 'Réel (cette fois)' : 'Réel'}</div>{realMin > 0 ? fmtMin(realMin) : '< 1 min'}</div>
        </div>
        {!recurring && (
          <div style={{ marginBottom: '1.2rem' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--ink-muted)', marginBottom: '0.4rem' }}>Et toi, ça t'a fait quoi ? <span style={{ color: 'var(--ink-fog)' }}>(facultatif)</span></div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
              <button className="btn" style={{ borderColor: feel === 'up' ? 'var(--ochre)' : undefined }} onClick={() => onFeel('up')}>☀️ Énergie</button>
              <button className="btn" style={{ borderColor: feel === 'down' ? 'var(--ochre)' : undefined }} onClick={() => onFeel('down')}>😴 Vidé</button>
            </div>
          </div>
        )}
        <button className="btn btn-rust" onClick={onClose}>Fermer</button>
      </div>
    </div>
  );
}

// ============ SYNC INDICATOR ============
function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return 'à l\'instant';
  const min = Math.floor(sec / 60);
  if (min < 1) return 'à l\'instant';
  if (min < 60) return `il y a ${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h}h`;
  const d = Math.floor(h / 24);
  return `il y a ${d}j`;
}

function SyncIndicator({ status, lastSyncedAt, tick }) {
  // tick = utilisé uniquement pour forcer le rerender périodique
  const config = (() => {
    if (status === 'loading') return { label: 'Chargement…', color: 'var(--ocean)', pulse: true };
    if (status === 'syncing') return { label: 'Sync…', color: 'var(--ochre)', pulse: true };
    if (status === 'error') {
      const rel = lastSyncedAt ? relativeTime(lastSyncedAt) : '';
      return { label: rel ? `⚠ Pas synchro depuis ${rel}` : '⚠ Sync erreur', color: 'var(--rust)', pulse: false };
    }
    if (status === 'synced') {
      const rel = lastSyncedAt ? relativeTime(lastSyncedAt) : 'à l\'instant';
      return { label: `Synchro · ${rel}`, color: 'var(--moss)', pulse: false };
    }
    return null;
  })();
  if (!config) return null;
  return (
    <span className="mono" style={{ fontSize: '0.65rem', color: config.color, padding: '0.2rem 0.5rem', border: `1px solid ${config.color}`, borderRadius: '999px', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', opacity: config.pulse ? 0.7 : 1, animation: config.pulse ? 'pulse 1.5s ease-in-out infinite' : 'none' }}>
      {config.label}
    </span>
  );
}

// ============ CAPACITY GAUGE ============
function CapacityGauge({ capacity, estimatedMin, actualMin }) {
  const totalMin = capacity.hours * 60;
  const estPct = Math.min(100, (estimatedMin / totalMin) * 100);
  const realPct = Math.min(100, (actualMin / totalMin) * 100);
  const overflow = estimatedMin > totalMin || actualMin > totalMin;

  return (
    <div style={{ marginTop: '1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
        <span className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>
          Capacité du jour · {capacity.hours}h
        </span>
        <span className="mono" style={{ fontSize: '0.75rem', color: overflow ? 'var(--rust)' : 'var(--ink-muted)' }}>
          Estimé {fmtMin(estimatedMin)} · Réel {fmtMin(actualMin)}
          {overflow && ' · ⚠️ Au-dessus de ta capacité'}
        </span>
      </div>
      <div className="gauge-bar">
        <div className={`gauge-fill-est ${overflow && estimatedMin > totalMin ? 'gauge-overflow' : ''}`} style={{ width: `${estPct}%` }} />
        <div className="gauge-fill-real" style={{ width: `${realPct}%` }} />
      </div>
    </div>
  );
}

function fmtMin(min) {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

// ============ INTENTION DU JOUR (V3 S3) ============
function IntentionEditor({ date, value, onChange }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const inputRef = useRef(null);

  useEffect(() => {
    setDraft(value || '');
    setEditing(false);
  }, [date, value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      // Place le curseur à la fin
      inputRef.current.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length);
    }
  }, [editing]);

  const commit = () => {
    onChange(draft);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(value || '');
    setEditing(false);
  };
  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  return (
    <div className="day-side-block">
      <div className="label-side">Intention du jour</div>
      {editing ? (
        <textarea
          ref={inputRef}
          className="intention-input"
          rows={2}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKey}
          placeholder="Une intention pour aujourd'hui ?"
        />
      ) : (
        <div
          className={`intention-display ${value ? '' : 'empty'}`}
          onClick={() => setEditing(true)}
        >
          {value || 'Une intention pour aujourd\'hui ?'}
        </div>
      )}
    </div>
  );
}

// ============ JAUGE CAPACITÉ COMPACTE (V3 S3, vue jour colonne droite) ============
function CapacityGaugeCompact({ capacity, estimatedMin, actualMin }) {
  if (!capacity) return null;
  const totalMin = capacity.hours * 60;
  const estPct = Math.min(100, (estimatedMin / totalMin) * 100);
  const realPct = Math.min(100, (actualMin / totalMin) * 100);
  const overflow = estimatedMin > totalMin || actualMin > totalMin;
  return (
    <div className="day-side-block">
      <div className="label-side">Capacité · {capacity.hours}h</div>
      <div className="gauge-bar" style={{ marginTop: '0.2rem' }}>
        <div className={`gauge-fill-est ${overflow && estimatedMin > totalMin ? 'gauge-overflow' : ''}`} style={{ width: `${estPct}%` }} />
        <div className="gauge-fill-real" style={{ width: `${realPct}%` }} />
      </div>
      <div className="mono" style={{ fontSize: '0.65rem', color: overflow ? 'var(--rust)' : 'var(--ink-muted)', marginTop: '0.4rem' }}>
        Estimé {fmtMin(estimatedMin)} · Réel {fmtMin(actualMin)}
        {overflow && ' ⚠️'}
      </div>
    </div>
  );
}

// ============ HABITUDES DU JOUR (V3 S3) ============
// Affiche les habitudes dont une occurrence tombe ce jour-là, cochables
// V3 S4 : Bloc Important / RDV du jour dans colonne droite vue Jour
function ImportantTodayBlock({ items, categories, onEdit, onToggleOccurrence, onToggle, date }) {
  if (!items || items.length === 0) return null;
  const refDate = date || todayISO();
  return (
    <div className="day-side-block" style={{ borderColor: 'var(--ochre)', background: 'rgba(196,135,41,0.06)' }}>
      <div className="label-side" style={{ color: 'var(--ochre)' }}>★ Important / RDV · {items.length}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {items.map(it => {
          const cat = categories.find(c => c.id === it.categoryId);
          const isRecurOnDate = it.recurrence && hasOccurrenceOnDate(it, refDate);
          const occDate = isRecurOnDate ? refDate : null;
          return (
            <div key={it.id}
              onClick={() => onEdit(it, occDate)}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                padding: '0.35rem 0.5rem',
                background: 'var(--paper)',
                border: '1px solid var(--line)',
                borderLeft: '3px solid ' + (cat?.color || 'var(--ochre)'),
                borderRadius: '3px',
                fontSize: '0.8rem',
                cursor: 'pointer',
              }}>
              <div className="checkbox" onClick={(e) => { e.stopPropagation(); if (isRecurOnDate) onToggleOccurrence(it.id, refDate); else onToggle(it); }} />
              {it.isImportant && <span style={{ color: 'var(--ochre)', fontSize: '0.85rem' }}>★</span>}
              {it.time && <span style={{ fontWeight: 600, color: 'var(--ink)', fontSize: '0.75rem' }}>{it.time}</span>}
              <span style={{ flex: 1, color: 'var(--ink)' }}>{it.icon && <span>{it.icon} </span>}{it.title}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DailyRoutinesList({ items, date, onToggleOccurrence, onEdit }) {
  // V3 S5 : filtre sur streak === true (ex-habitudes), avec floating géré
  const todays = [];
  const dateObj = isoToDate(date);
  const walk = (list) => {
    for (const it of list) {
      if (it.streak) {
        if (isFloatingRecurrence(it.recurrence)) {
          // Récurrence flottante : on l'affiche tant que le quota de la période n'est pas atteint
          // (ou si elle a déjà été cochée ce jour précis)
          const target = it.recurrence.count || 1;
          const done = floatingCompletionsInPeriod(it, dateObj);
          const checkedToday = (it.history || []).includes(date);
          if (done < target || checkedToday) {
            todays.push({
              item: it,
              date,
              status: checkedToday ? 'completed' : 'normal',
              floating: true,
              floatingDone: done,
              floatingTarget: target,
            });
          }
        } else {
          const occs = expandItemsForRange([it], date, date);
          for (const o of occs) todays.push(o);
        }
      }
      if (it.subtasks?.length) walk(it.subtasks);
    }
  };
  walk(items);
  // V3 S(D) #12 : routines du jour classées par heure (sans-heure en fin)
  todays.sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));

  if (todays.length === 0) {
    return (
      <div className="day-side-block">
        <div className="label-side">Routines du jour</div>
        <div style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', fontStyle: 'italic' }}>
          Aucune routine prévue.
        </div>
      </div>
    );
  }

  return (
    <div className="day-side-block">
      <div className="label-side">Routines du jour · {todays.length}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {todays.map(o => {
          const completed = o.status === 'completed';
          return (
            <div
              key={`rou-${o.item.id}-${o.date}-${o.time || ''}`}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.4rem',
                padding: '0.3rem 0.4rem',
                background: 'var(--paper)',
                border: '1px solid var(--line)',
                borderRadius: '3px',
                fontSize: '0.8rem',
                cursor: 'pointer',
                opacity: completed ? 0.55 : 1,
              }}
              onClick={() => onEdit(o.item, o.date)}
            >
              <div
                className={`checkbox ${completed ? 'checked' : ''}`}
                onClick={(e) => { e.stopPropagation(); onToggleOccurrence(o.item.id, o.date, o.time); }}
                style={{ width: '14px', height: '14px', flexShrink: 0 }}
              >
                {completed && <IconCheck size={9} strokeWidth={3} />}
              </div>
              {o.item.icon && <span style={{ fontSize: '0.85rem' }}>{o.item.icon}</span>}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textDecoration: completed ? 'line-through' : 'none' }}>
                {o.item.title}
              </span>
              {o.floating && (
                <span className="mono" style={{ fontSize: '0.65rem', color: 'var(--ink-muted)' }}>{o.floatingDone}/{o.floatingTarget}</span>
              )}
              {o.time && !o.floating && <span className="mono" style={{ fontSize: '0.65rem', color: 'var(--ink-muted)' }}>{o.time}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ MARQUEUR DE DENSITÉ JOUR (vue semaine) ============
// Affiche une barre horizontale composée de segments colorés par priorité
// proportionnels aux minutes occupées dans la journée
function DayDensityBar({ occurrences, date }) {
  const dayOccs = occurrences.filter(o => o.date === date && o.time && o.status !== 'completed');
  if (dayOccs.length === 0) return null;
  // Compter les minutes par classe (must/should/want/habit)
  const counts = { must: 0, should: 0, want: 0, habit: 0 };
  for (const o of dayOccs) {
    const cls = o.item.streak ? 'habit' : (o.item.priority || 'should');
    const dur = Math.max(o.durationMin || 0, SLOT_MIN);
    if (counts[cls] !== undefined) counts[cls] += dur;
  }
  // 100% = 8h (480min). Au-delà, on cap à 100%.
  const FULL = 480;
  const total = counts.must + counts.should + counts.want + counts.habit;
  if (total === 0) return null;
  const scale = (m) => `${Math.min(100, (m / FULL) * 100)}%`;
  return (
    <div className="day-density-bar" title={`${fmtMin(total)} planifié${total > 1 ? 's' : ''}`}>
      {counts.must > 0 && <span className="must" style={{ width: scale(counts.must) }} />}
      {counts.should > 0 && <span className="should" style={{ width: scale(counts.should) }} />}
      {counts.want > 0 && <span className="want" style={{ width: scale(counts.want) }} />}
      {counts.habit > 0 && <span className="habit" style={{ width: scale(counts.habit) }} />}
    </div>
  );
}

// ============ V3 S4 : SEARCH & FILTERS BAR ============
function SearchAndFilters({ searchQuery, setSearchQuery, searchScopes, setSearchScopes, filtersOpen, setFiltersOpen, filters, setFilters, categories }) {
  const toggleScope = (k) => setSearchScopes(s => ({ ...s, [k]: !s[k] }));
  const toggleFilter = (family, value) => {
    setFilters(f => {
      const cur = f[family] || [];
      const next = cur.includes(value) ? cur.filter(v => v !== value) : [...cur, value];
      return { ...f, [family]: next };
    });
  };
  const clearAllFilters = () => setFilters({ energy: [], duration: [], deadline: [], category: [] });
  const activeCount = (filters.energy?.length || 0) + (filters.duration?.length || 0) + (filters.deadline?.length || 0) + (filters.category?.length || 0);

  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="input"
          placeholder="Rechercher dans tâches, notes, sous-tâches…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          style={{ flex: 1, minWidth: '200px' }}
        />
        {searchQuery && (
          <button className="btn-ghost" onClick={() => setSearchQuery('')} style={{ border: '1px solid var(--line)', background: 'transparent', cursor: 'pointer', padding: '0.4rem 0.6rem', fontSize: '0.75rem', borderRadius: '3px', color: 'var(--ink-muted)' }}>
            <IconX size={12} />
          </button>
        )}
        <button
          className="btn-ghost"
          onClick={() => setFiltersOpen(o => !o)}
          style={{ border: '1px solid var(--line)', background: filtersOpen || activeCount > 0 ? 'var(--paper-2)' : 'transparent', cursor: 'pointer', padding: '0.4rem 0.7rem', fontSize: '0.78rem', borderRadius: '3px', color: 'var(--ink)', display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }}
        >
          ⚲ Filtres{activeCount > 0 && <span className="mono" style={{ background: 'var(--rust)', color: 'var(--paper)', padding: '0 0.4rem', borderRadius: '999px', fontSize: '0.65rem' }}>{activeCount}</span>}
          {filtersOpen ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
        </button>
      </div>
      {/* Scopes */}
      {searchQuery && (
        <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginRight: '0.2rem' }}>Chercher dans :</span>
          {[
            { k: 'titles', l: 'Titres' },
            { k: 'notes', l: 'Notes' },
            { k: 'subtasks', l: 'Sous-tâches' },
          ].map(s => (
            <button key={s.k} onClick={() => toggleScope(s.k)} style={{
              border: '1px solid var(--line)', background: searchScopes[s.k] ? 'var(--ink)' : 'transparent',
              color: searchScopes[s.k] ? 'var(--paper)' : 'var(--ink-muted)',
              cursor: 'pointer', padding: '0.15rem 0.55rem', fontSize: '0.7rem', borderRadius: '999px'
            }}>
              {s.l}
            </button>
          ))}
        </div>
      )}
      {/* Filtres avancés */}
      {filtersOpen && (
        <div style={{ marginTop: '0.6rem', padding: '0.75rem', background: 'var(--paper-2)', borderRadius: '4px', border: '1px solid var(--line)' }}>
          <FilterFamily title="Énergie" items={[
            { v: 'low', l: 'Faible' }, { v: 'medium', l: 'Moyenne' }, { v: 'high', l: 'Haute' }
          ]} active={filters.energy} onToggle={(v) => toggleFilter('energy', v)} />
          <FilterFamily title="Durée" items={[
            { v: 'short', l: '< 15min' }, { v: 'mid', l: '15–30min' }, { v: 'long', l: '30–60min' }, { v: 'xlong', l: '> 1h' }, { v: 'none', l: 'Sans durée' }
          ]} active={filters.duration} onToggle={(v) => toggleFilter('duration', v)} />
          <FilterFamily title="Échéance" items={[
            { v: 'overdue', l: 'En retard' },
            { v: 'today', l: "Aujourd'hui" },
            { v: 'week', l: 'Cette semaine' },
            { v: 'month', l: 'Ce mois' },
            { v: 'quarter', l: 'Ce trimestre' },
            { v: 'none', l: 'Sans échéance' }
          ]} active={filters.deadline} onToggle={(v) => toggleFilter('deadline', v)} />
          <FilterFamily title="Catégorie" items={[
            ...categories.map(c => ({ v: c.id, l: c.name, color: c.color })),
            { v: '__none__', l: 'Sans catégorie' }
          ]} active={filters.category} onToggle={(v) => toggleFilter('category', v)} />
          {activeCount > 0 && (
            <button onClick={clearAllFilters} style={{ marginTop: '0.4rem', border: '1px solid var(--line)', background: 'transparent', cursor: 'pointer', padding: '0.3rem 0.7rem', fontSize: '0.72rem', borderRadius: '3px', color: 'var(--ink-muted)' }}>
              Effacer les filtres
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FilterFamily({ title, items, active, onToggle }) {
  return (
    <div style={{ marginBottom: '0.6rem' }}>
      <div className="mono" style={{ fontSize: '0.65rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: '0.3rem' }}>{title}</div>
      <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
        {items.map(it => {
          const isOn = active?.includes(it.v);
          return (
            <button key={it.v} onClick={() => onToggle(it.v)} style={{
              border: '1px solid ' + (it.color || 'var(--line)'),
              background: isOn ? (it.color || 'var(--ink)') : 'transparent',
              color: isOn ? 'var(--paper)' : 'var(--ink)',
              cursor: 'pointer', padding: '0.2rem 0.55rem', fontSize: '0.7rem', borderRadius: '999px',
              display: 'inline-flex', alignItems: 'center', gap: '0.3rem'
            }}>
              {it.color && <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: it.color, border: '1px solid var(--paper)' }} />}
              {it.l}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============ V3 S4 : BANDEAU "AUJOURD'HUI" (RDV / important) ============
function TodayBanner({ items, categories, onEdit, onToggleOccurrence, onToggle }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, 5);
  return (
    <div style={{ marginBottom: '1rem', padding: '0.75rem 0.9rem', background: 'rgba(196,135,41,0.08)', border: '1px solid var(--ochre)', borderRadius: '4px' }}>
      <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ochre)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
        🗓️ Aujourd'hui · {items.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        {visible.map(it => {
          const cat = categories.find(c => c.id === it.categoryId);
          const isToday = it.date === todayISO();
          const isRecurToday = it.recurrence && hasOccurrenceOnDate(it, todayISO());
          const occDate = isRecurToday ? todayISO() : null;
          return (
            <div key={it.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.35rem 0.5rem', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: '3px', borderLeft: '3px solid ' + (cat?.color || 'var(--ochre)'), cursor: 'pointer' }}
              onClick={() => onEdit(it, occDate)}>
              <div className="checkbox" onClick={(e) => { e.stopPropagation(); if (isRecurToday) onToggleOccurrence(it.id, todayISO()); else onToggle(it); }} />
              {it.isImportant && <span style={{ color: 'var(--ochre)' }}>★</span>}
              <span style={{ fontWeight: 600, fontSize: '0.78rem', color: 'var(--ink)', minWidth: '45px' }}>{it.time || '—'}</span>
              <span style={{ flex: 1, fontSize: '0.85rem', color: 'var(--ink)' }}>{it.icon && <span>{it.icon} </span>}{it.title}</span>
              {cat && <span className="chip" style={{ fontSize: '0.65rem' }}><span className="cat-dot" style={{ background: cat.color }} />{cat.name}</span>}
            </div>
          );
        })}
      </div>
      {items.length > 5 && (
        <button onClick={() => setExpanded(e => !e)} style={{ marginTop: '0.5rem', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ochre)', fontSize: '0.75rem', textDecoration: 'underline', padding: 0 }}>
          {expanded ? 'Voir moins' : `Voir tout (${items.length})`}
        </button>
      )}
    </div>
  );
}

// ============ V3 S4 : BANDEAU "EN RETARD" ============
// ============ V3 S(A+B) : BANDEAU RDV IMPORTANTS À VENIR ============
function RdvBanner({ rdvs, categories, todayIso, onEdit }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? rdvs : rdvs.slice(0, 5);
  const dayLabel = (iso) => {
    if (iso === todayIso) return "Aujourd'hui";
    return formatDate(iso);
  };
  return (
    <div style={{ marginBottom: '1rem', padding: '0.75rem 0.9rem', background: 'rgba(196,135,41,0.08)', border: '1px solid var(--ochre)', borderRadius: '4px' }}>
      <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ochre)', marginBottom: '0.5rem' }}>
        ★ RDV &amp; échéances · {rdvs.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        {visible.map((r, idx) => {
          const it = r.item;
          const cat = categories.find(c => c.id === it.categoryId);
          // Étiquette temporelle : date+heure si dispo, sinon échéance
          let when;
          if (it.recurrence) {
            when = `${dayLabel(todayIso)}${it.time ? ' · ' + it.time : ''}`;
          } else if (it.date) {
            when = `${dayLabel(it.date)}${it.time ? ' · ' + it.time : ''}`;
          } else if (it.deadline) {
            when = `échéance ${dayLabel(it.deadline)}`;
          } else {
            when = '';
          }
          return (
            <div key={it.id + '-' + idx} style={{ padding: '0.4rem 0.5rem', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: '3px', borderLeft: '3px solid ' + (cat?.color || 'var(--ochre)') }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span style={{ color: 'var(--ochre)', fontSize: '0.85rem', flexShrink: 0 }}>★</span>
                <span style={{ flex: 1, fontSize: '0.85rem', color: 'var(--ink)', cursor: 'pointer', minWidth: 0 }} onClick={() => onEdit(it, r.occDate)}>
                  {it.icon && <span>{it.icon} </span>}{it.title}
                </span>
                {when && <span style={{ fontSize: '0.72rem', color: 'var(--ink-muted)', whiteSpace: 'nowrap' }}>{when}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {rdvs.length > 5 && (
        <button onClick={() => setExpanded(e => !e)} style={{ marginTop: '0.5rem', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ochre)', fontSize: '0.75rem', textDecoration: 'underline', padding: 0 }}>
          {expanded ? 'Voir moins' : `Voir tout (${rdvs.length})`}
        </button>
      )}
    </div>
  );
}

function OverdueBanner({ overdues, categories, onEdit, onPostpone, onMarkDone }) {
  const [expanded, setExpanded] = useState(false);
  const [showDateInput, setShowDateInput] = useState(null); // sourceDate-itemId clé
  const [customDate, setCustomDate] = useState('');
  const visible = expanded ? overdues : overdues.slice(0, 5);
  return (
    <div style={{ marginBottom: '1rem', padding: '0.75rem 0.9rem', background: 'rgba(184,72,46,0.06)', border: '1px solid var(--rust)', borderRadius: '4px' }}>
      <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--rust)', marginBottom: '0.5rem' }}>
        ⚠ En retard · {overdues.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        {visible.map((o, idx) => {
          const cat = categories.find(c => c.id === o.item.categoryId);
          const key = `${o.item.id}-${o.sourceDate}`;
          const showInput = showDateInput === key;
          return (
            <div key={key + '-' + idx} style={{ padding: '0.4rem 0.5rem', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: '3px', borderLeft: '3px solid ' + (cat?.color || 'var(--rust)') }}>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <span style={{ flex: 1, fontSize: '0.85rem', color: 'var(--ink)', cursor: 'pointer' }} onClick={() => onEdit(o.item, o.item.recurrence ? o.sourceDate : null)}>
                  {o.item.icon && <span>{o.item.icon} </span>}{o.item.title}
                  <span style={{ marginLeft: '0.4rem', fontSize: '0.7rem', color: 'var(--ink-muted)' }}>{formatDate(o.sourceDate)}</span>
                </span>
                {!showInput ? (
                  <>
                    <button onClick={() => onMarkDone && onMarkDone(o.item, o.item.recurrence ? o.sourceDate : null)} title="Marquer comme fait" style={{ border: '1px solid var(--moss)', background: 'transparent', cursor: 'pointer', padding: '0.15rem 0.5rem', fontSize: '0.7rem', borderRadius: '3px', color: 'var(--moss)' }}>✓ Fait</button>
                    <button onClick={() => onPostpone(o.item.id, o.sourceDate, todayISO())} title="Remettre à aujourd'hui" style={{ border: '1px solid var(--line)', background: 'transparent', cursor: 'pointer', padding: '0.15rem 0.5rem', fontSize: '0.7rem', borderRadius: '3px', color: 'var(--ink)' }}>↳ Aujourd'hui</button>
                    <button onClick={() => onPostpone(o.item.id, o.sourceDate, tomorrowISO())} title="Reporter à demain" style={{ border: '1px solid var(--line)', background: 'transparent', cursor: 'pointer', padding: '0.15rem 0.5rem', fontSize: '0.7rem', borderRadius: '3px', color: 'var(--ink)' }}>📅 Demain</button>
                    <button onClick={() => { setShowDateInput(key); setCustomDate(todayISO()); }} title="Reporter à autre date" style={{ border: '1px solid var(--line)', background: 'transparent', cursor: 'pointer', padding: '0.15rem 0.5rem', fontSize: '0.7rem', borderRadius: '3px', color: 'var(--ink)' }}>📆 Autre</button>
                  </>
                ) : (
                  <>
                    <input type="date" value={customDate} onChange={e => setCustomDate(e.target.value)} style={{ padding: '0.15rem 0.3rem', fontSize: '0.7rem', border: '1px solid var(--line)', borderRadius: '3px' }} />
                    <button onClick={() => { if (customDate) { onPostpone(o.item.id, o.sourceDate, customDate); setShowDateInput(null); } }} style={{ border: '1px solid var(--rust)', background: 'var(--rust)', color: 'var(--paper)', cursor: 'pointer', padding: '0.15rem 0.5rem', fontSize: '0.7rem', borderRadius: '3px' }}>OK</button>
                    <button onClick={() => setShowDateInput(null)} style={{ border: '1px solid var(--line)', background: 'transparent', cursor: 'pointer', padding: '0.15rem 0.5rem', fontSize: '0.7rem', borderRadius: '3px', color: 'var(--ink-muted)' }}>×</button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {overdues.length > 5 && (
        <button onClick={() => setExpanded(e => !e)} style={{ marginTop: '0.5rem', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--rust)', fontSize: '0.75rem', textDecoration: 'underline', padding: 0 }}>
          {expanded ? 'Voir moins' : `Voir tout (${overdues.length})`}
        </button>
      )}
    </div>
  );
}

// ============ V3 S4 : VUE ARCHIVE ============
function ArchiveView({ archivedItems, categories, searchQuery, searchScopes, setSearchQuery, setSearchScopes, onRestore, onEdit, onDelete, onEmpty }) {
  const filtered = searchQuery ? archivedItems.filter(it => itemMatchesSearch(it, searchQuery, searchScopes)) : archivedItems;
  // Grouper par semaine ISO (lundi → dimanche)
  const groups = {};
  for (const it of filtered) {
    if (!it.completedAt) continue;
    const d = new Date(it.completedAt);
    // Lundi de la semaine
    const dow = (d.getDay() + 6) % 7; // 0=lundi
    const monday = new Date(d);
    monday.setDate(d.getDate() - dow);
    monday.setHours(0, 0, 0, 0);
    const key = dateToISO(monday);
    if (!groups[key]) groups[key] = [];
    groups[key].push(it);
  }
  const sortedKeys = Object.keys(groups).sort().reverse();

  if (archivedItems.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem 1rem', color: 'var(--ink-muted)' }}>
        <div style={{ fontSize: '3rem', opacity: 0.3, marginBottom: '1rem' }}>📦</div>
        <div className="display" style={{ fontSize: '1.4rem', fontStyle: 'italic' }}>Archive vide.</div>
        <div style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>Les tâches cochées atterrissent ici.</div>
      </div>
    );
  }

  return (
    <div>
      {/* V5 : suppression définitive (à l'unité ou tout) — Ctrl+Z / « Annuler » restent possibles */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.6rem' }}>
        <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-fog)' }}
          onClick={() => { if (window.confirm(`Supprimer définitivement les ${archivedItems.length} tâches archivées ? (Ctrl+Z pour annuler juste après)`)) onEmpty(); }}>
          <IconTrash size={12} /> Vider l'archive
        </button>
      </div>
      <div style={{ marginBottom: '1.25rem' }}>
        <input
          className="input"
          placeholder="Rechercher dans l'archive…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
        {searchQuery && (
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginRight: '0.2rem' }}>Chercher dans :</span>
            {[{ k: 'titles', l: 'Titres' }, { k: 'notes', l: 'Notes' }, { k: 'subtasks', l: 'Sous-tâches' }].map(s => (
              <button key={s.k} onClick={() => setSearchScopes(sc => ({ ...sc, [s.k]: !sc[s.k] }))} style={{
                border: '1px solid var(--line)', background: searchScopes[s.k] ? 'var(--ink)' : 'transparent',
                color: searchScopes[s.k] ? 'var(--paper)' : 'var(--ink-muted)',
                cursor: 'pointer', padding: '0.15rem 0.55rem', fontSize: '0.7rem', borderRadius: '999px'
              }}>
                {s.l}
              </button>
            ))}
          </div>
        )}
      </div>
      {sortedKeys.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--ink-muted)', fontSize: '0.85rem' }}>Aucune correspondance.</div>
      ) : sortedKeys.map(weekKey => {
        const weekDate = new Date(weekKey + 'T00:00:00');
        const weekEnd = new Date(weekDate);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const label = `Semaine du ${weekDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} – ${weekEnd.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}`;
        return (
          <div key={weekKey} style={{ marginBottom: '1.5rem' }}>
            <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: '0.5rem', borderBottom: '1px solid var(--line)', paddingBottom: '0.3rem' }}>
              {label} · {groups[weekKey].length}
            </div>
            {groups[weekKey].map(it => {
              const cat = categories.find(c => c.id === it.categoryId);
              return (
                <div key={it.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', padding: '0.5rem 0.6rem', background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: '3px', borderLeft: '3px solid ' + (cat?.color || 'var(--line)'), marginBottom: '0.3rem', opacity: 0.85 }}>
                  <span style={{ flex: 1, fontSize: '0.85rem', textDecoration: 'line-through', cursor: 'pointer' }} onClick={() => onEdit(it)}>
                    {it.icon && <span>{it.icon} </span>}{it.title}
                  </span>
                  {cat && <span className="chip" style={{ fontSize: '0.65rem' }}><span className="cat-dot" style={{ background: cat.color }} />{cat.name}</span>}
                  <span style={{ fontSize: '0.7rem', color: 'var(--ink-muted)' }}>{new Date(it.completedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</span>
                  <button onClick={() => onRestore(it.id)} title="Restaurer" style={{ border: '1px solid var(--line)', background: 'transparent', cursor: 'pointer', padding: '0.15rem 0.5rem', fontSize: '0.7rem', borderRadius: '3px', color: 'var(--ink)' }}>↺ Restaurer</button>
                  <button onClick={() => onDelete(it.id)} title="Supprimer définitivement" style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '0.15rem', color: 'var(--ink-fog)', display: 'inline-flex' }}><IconTrash size={13} /></button>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ============ COLUMN ============
function Column({ colKey, column, categories, onDrop, onReorder, onToggle, onEdit, onStart, onAddSub, onSubtaskDrop, runningId, selectedId, onSelect, manualOrder, onResetManual, searchHighlight, onTogglePin }) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <div className={`column column-${colKey} ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); const id = e.dataTransfer.getData('text/plain'); if (id) onDrop(id); }}
    >
      <div style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
          <div>
            <h2 className="display" style={{ fontSize: '1.6rem', fontWeight: 500, margin: 0, letterSpacing: '-0.01em', fontStyle: 'italic' }}>{column.title}</h2>
            <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--ink-muted)', marginTop: '0.15rem' }}>
              {column.subtitle} · {column.items.length}
            </div>
          </div>
          {manualOrder && (
            <button className="btn-ghost" onClick={onResetManual} title="Re-trier auto (deadline → date → énergie)" style={{ border: '1px solid var(--line)', background: 'transparent', cursor: 'pointer', color: 'var(--ink-muted)', padding: '0.2rem 0.5rem', fontSize: '0.7rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem', borderRadius: '3px', whiteSpace: 'nowrap' }}>
              ↻ Tri auto
            </button>
          )}
        </div>
      </div>
      <div style={{ flex: 1 }}>
        {column.items.length === 0 ? (
          <div style={{ fontSize: '0.8rem', color: 'var(--ink-fog)', fontStyle: 'italic', padding: '1rem 0' }}>Glisse une tâche ici</div>
        ) : (
          column.items.map(item => <TaskCard key={item.id} item={item} categories={categories} runningId={runningId} onToggle={onToggle} onEdit={onEdit} onStart={onStart} onAddSub={onAddSub} onReorder={onReorder} onSubtaskDrop={onSubtaskDrop} depth={0} selectedId={selectedId} onSelect={onSelect} searchHighlight={searchHighlight} onTogglePin={onTogglePin} />)
        )}
      </div>
    </div>
  );
}

// ============ TASK CARD (récursive avec sous-tâches) ============
function TaskCard({ item, categories, onToggle, onEdit, onStart, onAddSub, onReorder, onSubtaskDrop, depth = 0, runningId, parentItem = null, selectedId, onSelect, defaultExpanded = false, searchHighlight = '', onTogglePin }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [dropPosition, setDropPosition] = useState(null); // 'before' | 'after' | 'center' | null
  const [subtaskDragOver, setSubtaskDragOver] = useState(false);
  const cardJustDragged = useRef(false);
  const cat = categories.find(c => c.id === item.categoryId);
  const { caps: ctxCaps, onOpenCap } = React.useContext(CapsContext);
  const capLabel = item.capId ? capDirectLabel(ctxCaps, item.capId) : null;
  const hasSubtasks = item.subtasks && item.subtasks.length > 0;
  const doneSubs = (item.subtasks || []).filter(s => s.completed).length;
  const isRunning = runningId === item.id;
  const isSelected = selectedId === item.id;

  // Deadline status
  const dlStatus = deadlineStatus(item.deadline);

  // Avertissement sous-tâche : deadline > parent.deadline ou parent.date
  const subtaskDeadlineWarn = (() => {
    if (!parentItem || !item.deadline) return false;
    const parentLimit = parentItem.deadline || parentItem.date || null;
    if (!parentLimit) return false;
    return item.deadline > parentLimit;
  })();

  // Durée affichée : effective (auto si sous-tâches sans override)
  const showDurationAuto = hasSubtasks && !item.durationManualOverride;
  const effectiveMin = effectiveDurationMinutes(item);
  const directMin = durationToMinutes(item.duration);

  const handleToggle = (e) => { e.stopPropagation(); onToggle(item); };
  const handleDragStart = (e) => {
    e.stopPropagation();
    e.dataTransfer.setData('text/plain', item.id);
    e.dataTransfer.effectAllowed = 'move';
    cardJustDragged.current = true;
  };

  // V3 S4 : Drag sur cette carte → 3 zones :
  //  - tiers haut → 'before' (réordo avant)
  //  - tiers central → 'center' (rerooting : devient sous-tâche de cet item)
  //  - tiers bas → 'after' (réordo après)
  // canReorder est maintenant true à toute profondeur (réordo intra-branche pour sous-tâches)
  const canReorder = !!onReorder;
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const h = rect.height;
    const tHigh = h * 0.33;
    const tLow = h * 0.66;
    let pos;
    if (y < tHigh) pos = 'before';
    else if (y > tLow) pos = 'after';
    else pos = 'center';
    setDropPosition(pos);
    setSubtaskDragOver(pos === 'center');
  };
  const handleDragLeave = (e) => {
    // Reset uniquement si on quitte la carte (pas un enfant)
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDropPosition(null);
    setSubtaskDragOver(false);
  };
  const handleDragEnd = () => {
    // Reset au cas où dragend arrive sans drop (drag annulé)
    setDropPosition(null);
    setSubtaskDragOver(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const draggedId = e.dataTransfer.getData('text/plain');
    const pos = dropPosition;
    setDropPosition(null);
    setSubtaskDragOver(false);
    if (!draggedId || draggedId === item.id) return;
    if (pos === 'center') {
      // Rerooting : devient sous-tâche de this
      if (onSubtaskDrop) onSubtaskDrop(draggedId, item.id);
    } else if (pos === 'before' || pos === 'after') {
      // Réordo before/after this
      if (onReorder) onReorder(draggedId, item.id, pos);
    }
  };

  const cardClass = depth === 0 ? 'task-card' : 'subtask-card';
  const urgencyClass = dlStatus?.urgent ? (daysUntilDeadline(item.deadline) < 0 ? 'overdue' : 'urgent') : '';
  const importantClass = item.isImportant ? 'important' : '';
  const selectedClass = isSelected ? 'selected' : '';
  const cardStyle = {
    borderLeftColor: cat?.color || 'var(--line)',
  };
  if (item.completed) cardStyle.opacity = 0.5;
  if (isRunning) {
    cardStyle.borderLeftColor = 'var(--rust)';
    cardStyle.boxShadow = '0 0 0 2px var(--rust-soft)';
  }
  // Indicateur visuel de drop : barre au-dessus ou en dessous
  if (dropPosition === 'before') {
    cardStyle.boxShadow = (cardStyle.boxShadow ? cardStyle.boxShadow + ', ' : '') + 'inset 0 3px 0 0 var(--rust)';
  } else if (dropPosition === 'after') {
    cardStyle.boxShadow = (cardStyle.boxShadow ? cardStyle.boxShadow + ', ' : '') + 'inset 0 -3px 0 0 var(--rust)';
  }
  // V3 S4 : drop sous-tâche = surbrillance de la carte cible
  if (subtaskDragOver) {
    cardStyle.background = 'var(--paper-2)';
    cardStyle.boxShadow = '0 0 0 2px var(--ocean)';
  }

  // V3 S4 : highlight de recherche dans le titre
  const renderTitle = () => {
    if (!searchHighlight) return <span>{item.title}</span>;
    try {
      const safe = searchHighlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`(${safe})`, 'gi');
      const parts = item.title.split(re);
      return <span>{parts.map((p, i) => re.test(p) ? <mark key={i} style={{ background: 'rgba(196,135,41,0.3)', padding: '0 2px' }}>{p}</mark> : <span key={i}>{p}</span>)}</span>;
    } catch { return <span>{item.title}</span>; }
  };

  const handleCardClick = (e) => {
    // V3 S4 : Évite que le click déclenché en fin de drag re-sélectionne ou perturbe
    // (la plupart des navigateurs n'envoient pas de click après un drag,
    // mais on garde un guard explicite via une flag local)
    if (cardJustDragged.current) {
      cardJustDragged.current = false;
      return;
    }
    if (onSelect) onSelect(item.id);
  };

  return (
    <div>
      <div className={`${cardClass} ${item.completed ? 'completed' : ''} ${isRunning ? 'running' : ''} ${urgencyClass} ${importantClass} ${selectedClass} ${dropPosition === 'center' ? 'drop-rerooting' : ''}`}
           draggable={true}
           onDragStart={handleDragStart}
           onDragOver={handleDragOver}
           onDragLeave={handleDragLeave}
           onDragEnd={handleDragEnd}
           onDrop={handleDrop}
           onClick={handleCardClick}
           style={cardStyle}>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
          <div className={`checkbox ${item.completed ? 'checked' : ''}`} onClick={handleToggle}>
            {item.completed && <IconCheck size={11} strokeWidth={3} />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }} onClick={(e) => { onEdit(item); }}>
            <div style={{ fontSize: depth === 0 ? '0.9rem' : '0.82rem', fontWeight: 500, lineHeight: 1.3, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              {item.isImportant && <span className="star-pin" title="Important">★</span>}
              {item.pinned && depth === 0 && <span title="Épinglée" style={{ fontSize: '0.8rem' }}>📌</span>}
              {item.icon && <span>{item.icon}</span>}
              {renderTitle()}
            </div>
            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
              {cat && <span className="chip"><span className="cat-dot" style={{ background: cat.color }} />{cat.name}</span>}
              {capLabel && <span className="chip chip-cap" title={`Cap : ${capLabel}`} onClick={(e) => { e.stopPropagation(); onOpenCap && onOpenCap(item.capId); }} style={{ cursor: onOpenCap ? 'pointer' : 'default' }}><IconCompass size={10} />{capLabel.length > 18 ? capLabel.slice(0, 18) + '…' : capLabel}</span>}
              {item.date && <span className="chip"><IconCalendar size={10} />{formatDate(item.date)}{item.time && ` ${item.time}`}</span>}
              {dlStatus && <span className={`chip chip-deadline-${dlStatus.color} ${dlStatus.intense ? 'intense' : ''}`} title={`Échéance ${item.deadline}`}>⚠ {dlStatus.label}</span>}
              {item.recurrence && <span className="chip chip-recurrence" title="Tâche récurrente">🔁 {recurrenceShortLabel(item.recurrence)}</span>}
              {effectiveMin > 0 && (
                <span className="chip" title={showDurationAuto ? 'Durée auto = somme des sous-tâches' : ''}>
                  <IconClock size={10} />{showDurationAuto ? '∑ ' : ''}{formatDuration(minutesToDuration(effectiveMin))}
                </span>
              )}
              {item.durationManualOverride && hasSubtasks && directMin !== effectiveSubtaskSum(item) && (
                <span className="chip chip-warning" title={`Manuel : ${fmtMin(directMin)} · somme des sous-tâches : ${fmtMin(effectiveSubtaskSum(item))}`}>ⓘ manuel</span>
              )}
              {item.energy && (() => {
                const lvl = item.energy === 'low' ? 1 : item.energy === 'high' ? 3 : 2;
                return <span className={`chip chip-energy-${item.energy}`} title={`Énergie ${energyLabel(item.energy)}`} style={{ padding: '0.1rem 0.4rem' }}><IconBattery level={lvl} /></span>;
              })()}
              {hasSubtasks && (
                <span className="chip" onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }} style={{ cursor: 'pointer' }}>
                  {expanded ? <IconChevronDown size={10} /> : <IconChevronRight size={10} />} {doneSubs}/{item.subtasks.length}
                </span>
              )}
              {subtaskDeadlineWarn && <span className="chip chip-warning" title="Échéance plus tardive que le parent">⚠ après parent</span>}
              {item.pomosDone > 0 && <span className="chip"><IconTimer size={10} />{item.pomosDone} 🍅</span>}
              {item.actualMinutes > 0 && effectiveMin > 0 && (() => {
                const ratio = item.actualMinutes / effectiveMin;
                return <span className="chip" style={{ borderColor: ratio > 1.2 ? 'var(--rust)' : 'var(--line)' }}>⏱ {fmtMin(item.actualMinutes)}/{fmtMin(effectiveMin)}</span>;
              })()}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }}>
            {depth === 0 && onTogglePin && (
              <button className="btn-ghost" style={{ padding: '0.2rem', border: 'none', background: 'transparent', cursor: 'pointer', color: item.pinned ? 'var(--ochre)' : 'var(--ink-muted)' }} onClick={(e) => { e.stopPropagation(); onTogglePin(item.id); }} title={item.pinned ? 'Désépingler' : 'Épingler en haut'}>
                <IconPin size={12} filled={item.pinned} />
              </button>
            )}
            <button className="btn-ghost" style={{ padding: '0.2rem', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-muted)' }} onClick={(e) => { e.stopPropagation(); onAddSub(item.id); }} title="Ajouter sous-tâche">
              <IconPlus size={12} />
            </button>
            <button className="btn-ghost" style={{ padding: '0.2rem', border: 'none', background: 'transparent', cursor: 'pointer', color: isRunning ? 'var(--rust)' : 'var(--ink-muted)' }} onClick={(e) => { e.stopPropagation(); onStart(item.id); }} title={isRunning ? 'En cours — ouvrir' : 'Démarrer'}>
              <IconPlay size={12} />
            </button>
          </div>
        </div>
      </div>

      {hasSubtasks && expanded && (
        <div className="subtask">
          {item.subtasks.map(sub => (
            <TaskCard key={sub.id} item={sub} categories={categories} runningId={runningId} onToggle={onToggle} onEdit={onEdit} onStart={onStart} onAddSub={onAddSub} onReorder={onReorder} onSubtaskDrop={onSubtaskDrop} depth={depth + 1} parentItem={item} selectedId={selectedId} onSelect={onSelect} defaultExpanded={defaultExpanded} searchHighlight={searchHighlight} onTogglePin={onTogglePin} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============ INBOX VIEW ============
function InboxView({ items, categories, onToggle, onEdit, onUpdatePriority, onDelete }) {
  if (items.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem 1rem', color: 'var(--ink-muted)' }}>
        <div style={{ opacity: 0.3, marginBottom: '1rem' }}><IconInbox size={48} /></div>
        <div className="display" style={{ fontSize: '1.4rem', fontStyle: 'italic' }}>Boîte vide.</div>
        <div style={{ fontSize: '0.85rem', marginTop: '0.5rem' }}>Capture rapide en haut pour balancer des idées.</div>
      </div>
    );
  }
  return (
    <div>
      <p style={{ color: 'var(--ink-muted)', fontSize: '0.85rem', marginBottom: '1rem' }}>Tâches à trier — assigne-les à Must, Should ou Want.</p>
      {items.map(item => {
        const cat = categories.find(c => c.id === item.categoryId);
        return (
          <div key={item.id} className="task-card" style={{ marginBottom: '0.75rem', borderLeftColor: cat?.color || 'var(--line)' }}>
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="checkbox" onClick={() => onToggle(item)}>{item.completed && <IconCheck size={11} strokeWidth={3} />}</div>
              <span style={{ flex: 1, minWidth: '150px', fontSize: '0.9rem', cursor: 'pointer', fontWeight: 500 }} onClick={() => onEdit(item)}>
                {item.icon && <span style={{ marginRight: '0.3rem' }}>{item.icon}</span>}
                {item.title}
              </span>
              <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                <button className="btn" style={{ fontSize: '0.7rem', padding: '0.3rem 0.5rem', borderColor: 'var(--rust)', color: 'var(--rust)' }} onClick={() => onUpdatePriority(item.id, 'must')}>Must</button>
                <button className="btn" style={{ fontSize: '0.7rem', padding: '0.3rem 0.5rem', borderColor: 'var(--ocean)', color: 'var(--ocean)' }} onClick={() => onUpdatePriority(item.id, 'should')}>Should</button>
                <button className="btn" style={{ fontSize: '0.7rem', padding: '0.3rem 0.5rem', borderColor: 'var(--moss)', color: 'var(--moss)' }} onClick={() => onUpdatePriority(item.id, 'want')}>Want</button>
                <button className="btn-ghost" style={{ padding: '0.3rem', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-muted)' }} onClick={() => onDelete(item.id)}><IconTrash size={14} /></button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ============ ROUTINES VIEW (V3 S5) ============
function RoutinesView({ items, categories, onToggle, onEdit, onDelete, onAdd }) {
  const today = todayISO();
  const todayObj = new Date();
  if (items.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: '4rem 1rem', color: 'var(--ink-muted)' }}>
        <div style={{ opacity: 0.3, marginBottom: '1rem' }}><IconFlame size={48} /></div>
        <div className="display" style={{ fontSize: '1.4rem', fontStyle: 'italic' }}>Aucune routine.</div>
        <div style={{ fontSize: '0.85rem', marginTop: '0.5rem', marginBottom: '1rem' }}>Active « Suivre la régularité » sur une tâche récurrente pour démarrer une routine.</div>
        <button className="btn btn-rust" onClick={onAdd}><IconPlus size={14} /> Nouvelle routine</button>
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
      {items.map(item => {
        const cat = categories.find(c => c.id === item.categoryId);
        const doneToday = (item.history || []).includes(today);
        const floating = isFloatingRecurrence(item.recurrence);
        // V3 S5.5++ : streak calculé lazy depuis history (le vrai compte de périodes consécutives réussies)
        const streakInfo = computeStreak(item, todayObj);
        const sc = streakInfo.count;
        const periodLabel = streakInfo.periodLabel;
        const r = item.recurrence;
        // V3 S5.5 : barre adaptative au type de récurrence
        const streakData = getStreakBars(item, todayObj);
        const showLetters = ['daily7', 'weekdays5', 'weeklyFix7', 'floatingWeek7', 'yearly12m'].includes(streakData.mode);
        // Alerte flottante
        const alertLevel = floating ? getFloatingAlertLevel(item, todayObj) : 'safe';
        // Compteur flottant
        let floatingProgress = null;
        if (floating) {
          const target = r.count || 1;
          const done = floatingCompletionsInPeriod(item, todayObj);
          floatingProgress = { done, target, periodLabel: r.rule === 'floatingWeekly' ? 'cette semaine' : 'ce mois' };
        }
        // Mensuel : prochaine échéance
        let nextDue = null;
        if (r && r.rule === 'monthly' && (r.interval || 1) === 1) {
          const day = r.monthDay || 1;
          const tD = new Date(todayObj.getFullYear(), todayObj.getMonth(), day);
          if (tD < new Date(todayObj.getFullYear(), todayObj.getMonth(), todayObj.getDate())) {
            tD.setMonth(tD.getMonth() + 1);
          }
          nextDue = tD;
        }
        // Couleur de la cellule selon status (CSS-vars)
        const cellStyle = (b) => {
          const baseH = streakData.mode === 'floatingMonth' ? 14 : 20;
          const common = { flex: 1, height: `${baseH}px`, border: '1px solid var(--line)', borderRadius: '2px', position: 'relative' };
          if (b.status === 'done') return { ...common, background: 'var(--rust)' };
          if (b.status === 'noOccurrence') return { ...common, background: 'transparent', border: '1px dashed var(--ink-fog)', opacity: 0.4 };
          if (b.status === 'missed') return { ...common, background: 'var(--paper-2)', borderColor: 'var(--rust)', borderStyle: 'dashed' };
          if (b.status === 'pending') return { ...common, background: 'var(--paper-2)', borderColor: 'var(--ochre)' };
          if (b.status === 'future') return { ...common, background: 'var(--paper-2)' };
          return { ...common, background: 'var(--paper-2)' };
        };
        return (
          <div key={item.id} style={{ border: '1px solid var(--ink)', padding: '1rem', background: 'var(--paper)', borderRadius: '3px', borderLeft: `4px solid ${cat?.color || 'var(--ochre)'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem' }} onClick={() => onEdit(item)}>
                  {item.icon && <span>{item.icon}</span>}{item.title}
                </div>
                {cat && <span className="chip" style={{ marginTop: '0.3rem' }}><span className="cat-dot" style={{ background: cat.color }} />{cat.name}</span>}
                {item.recurrence && <span className="chip chip-recurrence" style={{ marginTop: '0.3rem', marginLeft: '0.3rem' }}>🔁 {recurrenceShortLabel(item.recurrence)}</span>}
                {item.time && !floating && <span className="chip" style={{ marginTop: '0.3rem', marginLeft: '0.3rem' }}><IconClock size={10} />{item.time}</span>}
              </div>
              <button className="btn-ghost" style={{ padding: '0.25rem', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-muted)' }} onClick={() => onDelete(item.id)}><IconTrash size={14} /></button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
              <div style={{ color: sc > 0 ? 'var(--rust)' : 'var(--ink-fog)', animation: sc > 0 && doneToday ? 'flameGlow 2s infinite' : 'none' }}><IconFlame size={sc > 5 ? 22 : sc > 2 ? 20 : 18} /></div>
              <span className="display" style={{ fontSize: '1.5rem', fontWeight: 600 }}>{sc}</span>
              <span style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>{sc <= 1 ? ({ jours: 'jour', semaines: 'semaine', années: 'année' }[periodLabel] || periodLabel) : periodLabel} de suite</span>
            </div>
            {floatingProgress && (
              <div style={{ marginBottom: '0.5rem', fontSize: '0.85rem', color: 'var(--ink)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span><strong>{floatingProgress.done}/{floatingProgress.target}</strong> <span style={{ color: 'var(--ink-muted)' }}>{floatingProgress.periodLabel}</span></span>
                {alertLevel === 'warning' && (
                  <span style={{ fontSize: '0.7rem', color: 'var(--ochre)', fontWeight: 600 }}>⚠ ça se joue maintenant</span>
                )}
                {alertLevel === 'critical' && (
                  <span style={{ fontSize: '0.7rem', color: 'var(--rust)', fontWeight: 600 }}>🔥 objectif menacé</span>
                )}
              </div>
            )}
            {nextDue && (
              <div style={{ marginBottom: '0.5rem', fontSize: '0.78rem', color: 'var(--ink-muted)' }}>
                Prochaine échéance : <strong style={{ color: 'var(--ink)' }}>{formatDate(dateToISO(nextDue))}</strong>
              </div>
            )}
            {/* Lettres jour au-dessus des cases pour les modes pertinents */}
            {showLetters && (
              <div style={{ display: 'flex', gap: '3px', marginBottom: '2px' }}>
                {streakData.bars.map((b, i) => (
                  <div key={`L-${i}`} style={{ flex: 1, fontSize: '0.6rem', textAlign: 'center', color: 'var(--ink-muted)', fontFamily: 'JetBrains Mono, monospace' }}>{b.dayLetter || ''}</div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: streakData.mode === 'floatingMonth' ? '1px' : '3px', marginBottom: '0.75rem' }}>
              {streakData.bars.map((b, i) => (
                <div key={b.key} title={b.label} style={cellStyle(b)} />
              ))}
            </div>
            <button className={doneToday ? 'btn btn-rust' : 'btn'} style={{ width: '100%', justifyContent: 'center' }} onClick={() => onToggle(item)}>
              {doneToday ? <><IconCheck size={14} /> Fait aujourd'hui</> : <>Marquer fait</>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ============ CALENDAR VIEW ============
function CalendarView({ items, categories, calView, setCalView, calDate, setCalDate, onUpdate, onEdit, onDropTask, onResize, onAddAtSlot, onToggleOccurrence, onToggleComplete, dailyIntention, onSetDailyIntention, todayCapacity, todayEstimatedMinutes, todayActualMinutes }) {
  // V3 S4 : Important / RDV pour la date affichée (strictement isImportant=true)
  const importantForCurrentDay = useMemo(() => {
    const out = [];
    for (const it of flattenItems(items)) {
      if (it.completed) continue;
      if (!it.isImportant) continue; // strict : seulement les important
      const isOnDate = it.date === calDate;
      const recurOnDate = it.recurrence && hasOccurrenceOnDate(it, calDate);
      const matchesDay = isOnDate || recurOnDate;
      if (!matchesDay) continue;
      // V3 S5 : si streak, completed lu dans history
      if (recurOnDate && it.streak && (it.history || []).includes(calDate)) continue;
      // Skip occurrence cochée
      if (recurOnDate && (it.exceptions || {})[calDate] === 'completed') continue;
      out.push(it);
    }
    out.sort((a, b) => {
      const aT = a.time ? timeToMin(a.time) : 99999;
      const bT = b.time ? timeToMin(b.time) : 99999;
      return aT - bT;
    });
    return out;
  }, [items, calDate]);

  // Calcul de la fenêtre visible selon la vue
  const visibleRange = (() => {
    const d = new Date(calDate + 'T12:00:00');
    if (calView === 'day') return { from: calDate, to: calDate };
    if (calView === 'week') {
      const start = new Date(d); start.setDate(d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1));
      const end = new Date(start); end.setDate(start.getDate() + 6);
      return { from: dateToISO(start), to: dateToISO(end) };
    }
    // month : on couvre la grille de 6 semaines
    const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
    const startDow = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1;
    const start = new Date(firstDay); start.setDate(1 - startDow);
    const end = new Date(start); end.setDate(start.getDate() + 41);
    return { from: dateToISO(start), to: dateToISO(end) };
  })();

  // Toutes les occurrences (one-shot + récurrentes) dans la fenêtre
  const occurrencesAll = expandItemsForRange(items, visibleRange.from, visibleRange.to);
  // V3 S4 : en vue semaine et mois, on n'affiche QUE les tâches one-shot
  // V3 S5 : récurrentes (incluant ex-habitudes via streak) déjà filtrées par !o.isOccurrence
  const occurrences = (calView === 'week' || calView === 'month')
    ? occurrencesAll.filter(o => !o.isOccurrence)
    : occurrencesAll;

  // Items sans heure → zone "À planifier"
  const unscheduledOccurrences = occurrences.filter(o => !o.time && o.status !== 'completed');
  // Pour la vue jour : seulement les unscheduled du jour
  const unscheduledDay = unscheduledOccurrences.filter(o => o.date === calDate);
  const scheduledOccurrences = occurrences.filter(o => !!o.time);

  // Liste "À caser" pour la vue jour : Must sans date du tout, triés (deadline asc → énergie asc → createdAt asc)
  // Exclut : items avec sous-tâches (parents non plaçables), items completed, items récurrents (ils ont déjà des occurrences)
  const toScheduleMust = (() => {
    if (calView !== 'day') return [];
    const ENERGY_RANK = { low: 0, medium: 1, high: 2 };
    const flat = flattenItems(items);
    const candidates = flat.filter(it =>
      it.priority === 'must' &&
      !it.completed &&
      !it.date &&
      !it.recurrence &&
      !(it.subtasks && it.subtasks.length > 0)
    );
    candidates.sort((a, b) => {
      // 1. Deadline asc (sans deadline = +∞)
      const aDl = a.deadline || '9999-12-31';
      const bDl = b.deadline || '9999-12-31';
      if (aDl !== bDl) return aDl.localeCompare(bDl);
      // 2. Énergie asc (low first, non classé last)
      const aE = ENERGY_RANK[a.energy] ?? 3;
      const bE = ENERGY_RANK[b.energy] ?? 3;
      if (aE !== bE) return aE - bE;
      // 3. createdAt asc
      return (a.createdAt || 0) - (b.createdAt || 0);
    });
    return candidates;
  })();

  const navigate = (delta) => {
    const d = new Date(calDate + 'T12:00:00');
    if (calView === 'day') d.setDate(d.getDate() + delta);
    else if (calView === 'week') d.setDate(d.getDate() + delta * 7);
    else if (calView === 'year') d.setFullYear(d.getFullYear() + delta);
    else d.setMonth(d.getMonth() + delta);
    setCalDate(dateToISO(d));
  };

  const headerLabel = (() => {
    const d = new Date(calDate + 'T12:00:00');
    if (calView === 'day') {
      // V3 S4 : label dynamique Aujourd'hui / Demain / Après-demain / date
      const today = todayISO();
      const tomorrow = (() => { const x = new Date(); x.setDate(x.getDate() + 1); return dateToISO(x); })();
      const dayAfter = (() => { const x = new Date(); x.setDate(x.getDate() + 2); return dateToISO(x); })();
      if (calDate === today) return "Aujourd'hui";
      if (calDate === tomorrow) return "Demain";
      if (calDate === dayAfter) return "Après-demain";
      return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    }
    if (calView === 'week') {
      const start = new Date(d); start.setDate(d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1));
      const end = new Date(start); end.setDate(start.getDate() + 6);
      return `${start.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    if (calView === 'year') return String(d.getFullYear());
    return d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  })();

  // === Side panel pour la vue Jour ===
  // Affiche capacité du jour courant uniquement si calDate === today (sinon inutile)
  const isToday = calDate === todayISO();

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
          <button className="btn" onClick={() => navigate(-1)}><IconChevronLeft size={14} /></button>
          <button className="btn" onClick={() => setCalDate(todayISO())} title="Revenir à aujourd'hui"><IconTarget size={14} /></button>
          <button className="btn" onClick={() => navigate(1)}><IconChevronRight size={14} /></button>
          <span className="display" style={{ marginLeft: '0.75rem', fontSize: '1.1rem', fontStyle: 'italic' }}>{headerLabel}</span>
        </div>
        <div style={{ display: 'flex', gap: '0.3rem' }}>
          {['day', 'week', 'month', 'year'].map(v => (
            <button key={v} className={calView === v ? 'btn btn-primary' : 'btn'} onClick={() => setCalView(v)} style={{ fontSize: '0.8rem' }}>
              {v === 'day' ? 'Jour' : v === 'week' ? 'Semaine' : v === 'month' ? 'Mois' : 'Année'}
            </button>
          ))}
        </div>
      </div>

      {calView === 'day' && (
        <div className="day-layout">
          <DayView
            date={calDate}
            occurrences={scheduledOccurrences}
            categories={categories}
            onEdit={onEdit}
            onDropTask={onDropTask}
            onResize={onResize}
            onAddAtSlot={onAddAtSlot}
            onToggleOccurrence={onToggleOccurrence}
          />
          <div className="day-side">
            {importantForCurrentDay && importantForCurrentDay.length > 0 && (
              <ImportantTodayBlock
                items={importantForCurrentDay}
                categories={categories}
                onEdit={onEdit}
                onToggleOccurrence={onToggleOccurrence}
                onToggle={onToggleComplete}
                date={calDate}
              />
            )}
            <IntentionEditor
              date={calDate}
              value={dailyIntention}
              onChange={(text) => onSetDailyIntention(calDate, text)}
            />
            <UnscheduledZone
              occurrences={unscheduledDay}
              toSchedule={toScheduleMust}
              categories={categories}
              onEdit={onEdit}
              onToggleOccurrence={onToggleOccurrence}
              compact
              emptyHint="Tout est calé."
            />
            {isToday && todayCapacity && (
              <CapacityGaugeCompact
                capacity={todayCapacity}
                estimatedMin={todayEstimatedMinutes}
                actualMin={todayActualMinutes}
              />
            )}
            <DailyRoutinesList
              items={items}
              date={calDate}
              onToggleOccurrence={onToggleOccurrence}
              onEdit={onEdit}
            />
          </div>
        </div>
      )}

      {calView === 'year' && <YearView date={calDate} items={items} setCalDate={setCalDate} setCalView={setCalView} />}

      {calView === 'week' && (
        <WeekView
          date={calDate}
          occurrences={occurrences}
          unscheduled={unscheduledOccurrences}
          categories={categories}
          onEdit={onEdit}
          onDropTask={onDropTask}
          onResize={onResize}
          onAddAtSlot={onAddAtSlot}
          onToggleOccurrence={onToggleOccurrence}
          setCalDate={setCalDate}
          setCalView={setCalView}
        />
      )}

      {calView === 'month' && (
        <MonthView
          date={calDate}
          occurrences={occurrences}
          categories={categories}
          onEdit={onEdit}
          onDropTask={onDropTask}
          onToggleOccurrence={onToggleOccurrence}
          setCalDate={setCalDate}
          setCalView={setCalView}
        />
      )}

      <div style={{ marginTop: '1rem', fontSize: '0.75rem', color: 'var(--ink-muted)', fontStyle: 'italic' }}>
        Astuce : clique sur un créneau vide pour ajouter — glisse une tâche depuis Priorités ou Inbox pour la planifier — tire le bord bas d'un bloc pour redimensionner.
      </div>
    </div>
  );
}

// Zone "À planifier" : items récurrents sans heure
// Zone "À planifier" : items sans heure (récurrentes et one-shot)
// compact: true pour version colonne (vue jour) ou bandeau (vue semaine)
// toSchedule: liste optionnelle d'items Must sans date à caser dans la journée
function UnscheduledZone({ occurrences, toSchedule, categories, onEdit, onToggleOccurrence, compact, emptyHint }) {
  const [showAllToSchedule, setShowAllToSchedule] = useState(false);
  const TO_SCHEDULE_LIMIT = 5;
  const hasUnscheduled = occurrences.length > 0;
  const hasToSchedule = toSchedule && toSchedule.length > 0;

  if (compact) {
    return (
      <div className="day-side-block">
        {/* Section 1 : Aujourd'hui sans heure */}
        <div className="label-side">
          Aujourd'hui sans heure {hasUnscheduled && <span style={{ opacity: 0.6 }}>· {occurrences.length}</span>}
        </div>
        {!hasUnscheduled ? (
          <div style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', fontStyle: 'italic', marginBottom: hasToSchedule ? '0.75rem' : 0 }}>
            {emptyHint || 'Tout est calé.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginBottom: hasToSchedule ? '0.75rem' : 0 }}>
            {occurrences.map(o => (
              <UnscheduledChip key={`${o.item.id}|${o.date}`} occurrence={o} categories={categories} onEdit={onEdit} onToggleOccurrence={onToggleOccurrence} block />
            ))}
          </div>
        )}

        {/* Section 2 : À caser (Must sans date) */}
        {hasToSchedule && (
          <>
            <div style={{ borderTop: '1px dashed var(--line)', margin: '0.5rem 0 0.5rem', opacity: hasUnscheduled ? 1 : 0 }} />
            <div className="label-side">
              À caser <span style={{ opacity: 0.6 }}>· {toSchedule.length} Must sans date</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {(showAllToSchedule ? toSchedule : toSchedule.slice(0, TO_SCHEDULE_LIMIT)).map(item => (
                <ToScheduleChip key={item.id} item={item} categories={categories} onEdit={onEdit} block />
              ))}
            </div>
            {toSchedule.length > TO_SCHEDULE_LIMIT && (
              <button
                className="btn-ghost"
                style={{ marginTop: '0.4rem', fontSize: '0.7rem', color: 'var(--ink-muted)', cursor: 'pointer', border: 'none', background: 'transparent', textDecoration: 'underline', padding: 0 }}
                onClick={() => setShowAllToSchedule(s => !s)}
              >
                {showAllToSchedule ? `Voir 5 premiers` : `Voir tout (${toSchedule.length})`}
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  // Mode original : bandeau horizontal (sans toSchedule)
  return (
    <div style={{ background: 'var(--paper-2)', border: '1px dashed var(--line)', borderRadius: '4px', padding: '0.6rem 0.75rem', marginBottom: '1rem' }}>
      <div style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.4rem', fontWeight: 600 }}>
        À planifier <span style={{ fontWeight: 400, fontStyle: 'italic', textTransform: 'none', letterSpacing: 0, marginLeft: '0.4rem' }}>· glisse-les dans la grille pour leur donner un créneau</span>
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {occurrences.map(o => (
          <UnscheduledChip key={`${o.item.id}|${o.date}`} occurrence={o} categories={categories} onEdit={onEdit} onToggleOccurrence={onToggleOccurrence} />
        ))}
      </div>
    </div>
  );
}

// Chip pour items de la section "À caser" : drag = id simple, pas de date d'occurrence
function ToScheduleChip({ item, categories, onEdit, block }) {
  const cat = categories.find(c => c.id === item.categoryId);
  const handleDragStart = (e) => {
    e.dataTransfer.setData('text/plain', item.id);
    e.dataTransfer.effectAllowed = 'move';
  };
  // Petit indicateur deadline si item.deadline défini
  const today = todayISO();
  let deadlineLabel = null;
  if (item.deadline) {
    if (item.deadline < today) deadlineLabel = '⚠ en retard';
    else if (item.deadline === today) deadlineLabel = '⚠ aujourd\'hui';
    else {
      const dl = new Date(item.deadline + 'T00:00:00');
      const tdy = new Date(today + 'T00:00:00');
      const days = Math.round((dl - tdy) / 86400000);
      if (days <= 7) deadlineLabel = `dans ${days}j`;
    }
  }
  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={() => onEdit(item, null)}
      style={{
        display: block ? 'flex' : 'inline-flex', alignItems: 'center', gap: '0.4rem',
        padding: '0.35rem 0.5rem', background: 'var(--paper)', border: `1px solid ${cat?.color || 'var(--line)'}`,
        borderLeft: `3px solid var(--rust)`, borderRadius: '3px',
        fontSize: '0.78rem', cursor: 'grab',
        width: block ? '100%' : 'auto', boxSizing: 'border-box',
      }}
      title={item.notes || item.title}
    >
      {item.icon && <span style={{ flexShrink: 0 }}>{item.icon}</span>}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: block ? 1 : 'initial' }}>{item.title}</span>
      {deadlineLabel && (
        <span style={{ fontSize: '0.6rem', color: 'var(--rust)', flexShrink: 0, fontWeight: 500 }}>{deadlineLabel}</span>
      )}
    </div>
  );
}

function UnscheduledChip({ occurrence, categories, onEdit, onToggleOccurrence, block }) {
  const { item, date, status, isOccurrence } = occurrence;
  const cat = categories.find(c => c.id === item.categoryId);
  const handleDragStart = (e) => {
    if (isOccurrence) {
      e.dataTransfer.setData('text/plain', JSON.stringify({ id: item.id, occDate: date, fromUnscheduled: true }));
    } else {
      e.dataTransfer.setData('text/plain', item.id);
    }
    e.dataTransfer.effectAllowed = 'move';
  };
  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onClick={() => onEdit(item, isOccurrence ? date : null)}
      style={{
        display: block ? 'flex' : 'inline-flex', alignItems: 'center', gap: '0.4rem',
        padding: '0.35rem 0.5rem', background: 'var(--paper)', border: `1px solid ${cat?.color || 'var(--line)'}`,
        borderLeft: `3px solid ${cat?.color || 'var(--line)'}`, borderRadius: '3px',
        fontSize: '0.78rem', cursor: 'grab', opacity: status === 'completed' ? 0.5 : 1,
        width: block ? '100%' : 'auto', boxSizing: 'border-box',
      }}
    >
      <div className={`checkbox ${status === 'completed' ? 'checked' : ''}`} onClick={(e) => { e.stopPropagation(); onToggleOccurrence(item.id, isOccurrence ? date : null); }} style={{ width: '14px', height: '14px', flexShrink: 0 }}>
        {status === 'completed' && <IconCheck size={9} strokeWidth={3} />}
      </div>
      {item.icon && <span>{item.icon}</span>}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: block ? 1 : 'initial' }}>{item.title}</span>
      <span style={{ fontSize: '0.65rem', color: 'var(--ink-muted)', flexShrink: 0 }}>· {formatDate(date)}</span>
    </div>
  );
}

function getItemColor(item, categories) {
  if (item.streak) return 'must';
  return item.priority || 'should';
}

function CalOccurrence({ occurrence, categories, onEdit, onToggleOccurrence }) {
  // Conservé pour compatibilité Mois (rendu compact dans MonthCell)
  const { item, date, time, status, isOccurrence, movedFrom } = occurrence;
  const cat = categories.find(c => c.id === item.categoryId);
  const cls = item.streak ? 'habit' : item.priority || 'should';
  const completed = status === 'completed';
  const handleDragStart = (e) => {
    e.stopPropagation();
    const origDate = movedFrom || date;
    if (isOccurrence) {
      e.dataTransfer.setData('text/plain', JSON.stringify({ id: item.id, occDate: origDate }));
    } else {
      e.dataTransfer.setData('text/plain', item.id);
    }
  };
  return (
    <div className={`cal-task ${cls} ${completed ? 'completed' : ''}`} draggable onDragStart={handleDragStart} onClick={() => onEdit(item, isOccurrence ? date : null)} style={{ opacity: completed ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
      <div className={`checkbox ${completed ? 'checked' : ''}`} onClick={(e) => { e.stopPropagation(); onToggleOccurrence(item.id, isOccurrence ? date : null); }} style={{ width: '12px', height: '12px', flexShrink: 0 }}>
        {completed && <IconCheck size={8} strokeWidth={3} />}
      </div>
      {item.icon && <span style={{ fontSize: '0.75rem' }}>{item.icon}</span>}
      {cat && <span className="cat-dot" style={{ background: cat.color, opacity: 0.9 }} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
      {isOccurrence && <span style={{ fontSize: '0.55rem', color: 'var(--ink-muted)', flexShrink: 0 }}>🔁</span>}
    </div>
  );
}

// Bloc tâche en positionnement absolu dans la colonne agenda
// Props :
// - occurrence : { item, date, time, status, isOccurrence, movedFrom, durationMin }
// - selected : true si l'overlay doit être affiché pour ce bloc
// - onSelect(key) : ouvre l'overlay sur ce bloc
// - onOpenEdit(item, occDate) : ouvre la modale d'édition (utilisé par l'overlay et par le 2e tap)
// - onResize(itemId, occDate, newDur)
// - colItems : occurrences de la colonne (pour buttoir resize)
function CalBlock({ occurrence, categories, onOpenEdit, onToggleOccurrence, onResize, colItems, selected, onSelect, blockKey, layout }) {
  const { item, date, time, status, isOccurrence, movedFrom, durationMin } = occurrence;
  const cat = categories.find(c => c.id === item.categoryId);
  const cls = item.streak ? 'habit' : item.priority || 'should';
  const completed = status === 'completed';

  const startMin = timeToMin(time) ?? 9 * 60;
  // Sol = SLOT_MIN (5 min). Pas de plancher artificiel.
  const dur = Math.max(durationMin || 0, SLOT_MIN);
  const endMin = Math.min(24 * 60, startMin + dur);
  const top = (startMin / SLOT_MIN) * PX_PER_SLOT;
  const height = ((endMin - startMin) / SLOT_MIN) * PX_PER_SLOT;

  const [resizing, setResizing] = useState(false);
  const [resizeDur, setResizeDur] = useState(null);
  const blockRef = useRef(null);

  const handleDragStart = (e) => {
    e.stopPropagation();
    const origDate = movedFrom || date;
    if (isOccurrence) {
      e.dataTransfer.setData('text/plain', JSON.stringify({ id: item.id, occDate: origDate }));
    } else {
      e.dataTransfer.setData('text/plain', item.id);
    }
    e.dataTransfer.effectAllowed = 'move';
  };

  const computeMaxDur = () => {
    // V3 S(C1) : le chevauchement étant autorisé, le resize n'est plus borné par les blocs voisins.
    // On garde un plafond de sécurité (8h) et la fin de journée, en réservant la place du trajet retour éventuel.
    const myHalo = getRdvHalo(item, startMin, dur);
    const myReturnPad = (myHalo && myHalo.hasReturn) ? (myHalo.returnEnd - myHalo.end) : 0;
    return Math.max(5, Math.min(480, 24 * 60 - startMin - myReturnPad));
  };

  const onResizeStart = (e) => {
    e.stopPropagation();
    e.preventDefault();
    setResizing(true);
    setResizeDur(dur);
    const startY = e.clientY;
    const initialDur = dur;
    const maxDur = computeMaxDur();

    const onMove = (mv) => {
      const dy = mv.clientY - startY;
      const deltaMin = (dy / PX_PER_SLOT) * SLOT_MIN;
      let newDur = snap5(initialDur + deltaMin);
      if (newDur < 5) newDur = 5;
      if (newDur > maxDur) newDur = Math.max(5, maxDur);
      setResizeDur(newDur);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setResizing(false);
      const finalDur = snap5(Math.max(5, Math.min(computeMaxDur(), resizeDurRef.current)));
      if (finalDur !== durationMin) {
        const occDate = isOccurrence ? (movedFrom || date) : null;
        onResize(item.id, occDate, finalDur);
      }
      setResizeDur(null);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const resizeDurRef = useRef(dur);
  resizeDurRef.current = resizeDur != null ? resizeDur : dur;

  const displayDur = resizeDur != null ? resizeDur : dur;
  // V3 S4 : hauteur minimale 20 px pour pouvoir cocher (checkbox visible)
  const rawHeight = (displayDur / SLOT_MIN) * PX_PER_SLOT;
  const displayHeight = Math.max(rawHeight, 20);
  const tiny = false; // déprécié : on ne tronque plus en dessous de 20px
  const compact = displayHeight < 50;
  const displayEndMin = startMin + displayDur;

  const handleBlockClick = (e) => {
    if (resizing) return;
    e.stopPropagation();
    if (selected) {
      // 2e tap → ouvre l'édition
      onOpenEdit(item, isOccurrence ? date : null);
    } else {
      onSelect(blockKey);
    }
  };

  return (
    <div
      ref={blockRef}
      className={`cal-block ${cls} ${completed ? 'completed' : ''} ${resizing ? 'dragging' : ''} ${selected ? 'selected' : ''} ${tiny ? 'tiny' : ''} ${item.isImportant ? 'cal-block-important' : ''}`}
      draggable={!resizing}
      onDragStart={handleDragStart}
      onClick={handleBlockClick}
      style={{
        top: `${top}px`,
        height: `${displayHeight}px`,
        left: `calc(${(layout && layout.lanes > 1) ? ((layout.lane * 100) / layout.lanes) : 0}% + 3px)`,
        width: `calc(${(layout && layout.lanes > 1) ? (100 / layout.lanes) : 100}% - 6px)`,
        right: 'auto',
        borderLeft: cat ? `${item.isImportant ? 5 : 3}px solid ${item.isImportant ? 'var(--ochre)' : cat.color}` : 'none',
        paddingLeft: cat ? '0.3rem' : (tiny ? '0.3rem' : '0.4rem'),
        background: item.isImportant ? 'rgba(196,135,41,0.18)' : undefined,
        boxShadow: item.isImportant ? '0 0 0 1px var(--ochre)' : undefined,
      }}
    >
      <div className="cal-block-title">
        {!tiny && (
          <div
            className={`checkbox ${completed ? 'checked' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleOccurrence(item.id, isOccurrence ? date : null, time); }}
            style={{ width: '11px', height: '11px', flexShrink: 0 }}
          >
            {completed && <IconCheck size={7} strokeWidth={3} />}
          </div>
        )}
        {item.isImportant && <span style={{ color: 'var(--ochre)', fontSize: '0.85rem', flexShrink: 0, fontWeight: 700 }}>★</span>}
        {item.icon && !compact && <span style={{ fontSize: '0.7rem', flexShrink: 0 }}>{item.icon}</span>}
        <span className="cal-block-title-text" style={{ fontWeight: item.isImportant ? 600 : undefined }}>{item.title}</span>
        {isOccurrence && !compact && <span style={{ fontSize: '0.55rem', opacity: 0.7, flexShrink: 0 }}>🔁</span>}
      </div>
      {!compact && (
        <div className="cal-block-time">
          {minToTime(startMin)}–{minToTime(displayEndMin)}{resizing ? ` · ${formatDurMin(displayDur)}` : ''}
        </div>
      )}
      {/* Poignée resize : pas affichée sur tiny (bloc trop petit, écraserait le clic) */}
      {!tiny && (
        <div
          className={`cal-block-resize ${resizing ? 'resizing' : ''}`}
          onMouseDown={onResizeStart}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}

// Overlay d'info qui apparaît quand un bloc est sélectionné
// Affiche checkbox + titre + plage + durée + catégorie + actions (modifier / démarrer)
function CalBlockOverlay({ occurrence, categories, onOpenEdit, onToggleOccurrence, onClose }) {
  const { item, date, time, status, isOccurrence, movedFrom, durationMin } = occurrence;
  const cat = categories.find(c => c.id === item.categoryId);
  const cls = item.streak ? 'habit' : item.priority || 'should';
  const completed = status === 'completed';

  const startMin = timeToMin(time) ?? 9 * 60;
  const dur = Math.max(durationMin || 0, SLOT_MIN);
  const endMin = Math.min(24 * 60, startMin + dur);
  const top = (startMin / SLOT_MIN) * PX_PER_SLOT;

  // Position : juste à côté du bloc, à droite si possible, sinon à gauche
  // Le top est aligné sur le bloc, mais on ajuste si dépasse en bas
  return (
    <div
      className={`cal-block-overlay ${cls}`}
      onClick={(e) => e.stopPropagation()}
      style={{
        top: `${top}px`,
        left: 'calc(100% - 4px)',
        marginLeft: '4px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem' }}>
        <div
          className={`checkbox ${completed ? 'checked' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleOccurrence(item.id, isOccurrence ? date : null, time); }}
          style={{ width: '14px', height: '14px', flexShrink: 0, marginTop: '2px' }}
        >
          {completed && <IconCheck size={9} strokeWidth={3} />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="cal-block-overlay-title">
            {item.icon && <span style={{ marginRight: '0.3rem' }}>{item.icon}</span>}
            {item.title}
            {isOccurrence && <span style={{ fontSize: '0.65rem', opacity: 0.6, marginLeft: '0.3rem' }}>🔁</span>}
          </div>
          <div className="cal-block-overlay-meta">
            <span>{minToTime(startMin)}–{minToTime(endMin)}</span>
            <span>·</span>
            <span>{formatDurMin(dur)}</span>
            {cat && (
              <>
                <span>·</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: cat.color, display: 'inline-block' }} />
                  {cat.name}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="cal-block-overlay-actions">
        <button className="btn btn-rust" onClick={() => { onOpenEdit(item, isOccurrence ? date : null); onClose(); }}>
          Modifier
        </button>
        <button className="btn" onClick={onClose} style={{ marginLeft: 'auto' }}>Fermer</button>
      </div>
    </div>
  );
}

// Format compact "1h05" / "45min"
function formatDurMin(min) {
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}`;
}

// Colonne de jour : 24h en absolu, blocs positionnés, drop minute-précis, clic vide → ajout
// V3 S4.5 : zones hachurées pour préparation et trajet d'un RDV important.
// Non-interactives (pointerEvents none), dessinées en-dessous des blocs principaux (z-index 1).
// Clamp aux bornes 0–24h pour gérer les débordements minuit.
function RdvHaloBlocks({ halo }) {
  const DAY_END = 24 * 60;
  const Block = ({ start, end, opacity, label, key }) => {
    const cs = Math.max(0, start);
    const ce = Math.min(DAY_END, end);
    if (ce <= cs) return null;
    const top = (cs / SLOT_MIN) * PX_PER_SLOT;
    const height = ((ce - cs) / SLOT_MIN) * PX_PER_SLOT;
    // Hachures via background-image, motif ochre
    return (
      <div
        key={key}
        style={{
          position: 'absolute', left: 0, right: 0,
          top: `${top}px`, height: `${height}px`,
          backgroundImage: `repeating-linear-gradient(135deg, rgba(196,135,41,${opacity}) 0px, rgba(196,135,41,${opacity}) 6px, transparent 6px, transparent 12px)`,
          borderLeft: `2px dashed rgba(196,135,41,${Math.min(0.8, opacity + 0.3)})`,
          pointerEvents: 'none',
          zIndex: 1,
          fontSize: '0.65rem',
          color: 'rgba(196,135,41,0.95)',
          fontWeight: 600,
          paddingLeft: '0.4rem',
          paddingTop: height >= 20 ? '0.15rem' : 0,
          overflow: 'hidden',
          fontStyle: 'italic',
        }}
      >
        {height >= 20 && <span>{label}</span>}
      </div>
    );
  };
  return (
    <>
      {halo.hasPrep && (
        <Block
          key="prep"
          start={halo.prepStart}
          end={halo.travelStart}
          opacity={0.18}
          label="🎒 Prep"
        />
      )}
      {halo.hasTravel && (
        <Block
          key="travel"
          start={halo.travelStart}
          end={halo.time}
          opacity={0.25}
          label="🚗 Trajet"
        />
      )}
      {halo.hasReturn && (
        <Block
          key="return"
          start={halo.end}
          end={halo.returnEnd}
          opacity={0.25}
          label="🚗 Retour"
        />
      )}
    </>
  );
}

function AgendaDayColumn({ date, occurrences, categories, onOpenEdit, onDropTask, onResize, onToggleOccurrence, onAddAtSlot, isToday, selectedKey, onSelect }) {
  const colRef = useRef(null);
  const [dragHover, setDragHover] = useState(null); // { startMin } pendant drag-over
  const totalHeight = 24 * PX_PER_HOUR;

  // Filtrer occurrences de cette colonne avec time
  const colOccs = occurrences.filter(o => o.date === date && o.time);

  // V3 S(C1) : layout côte à côte des blocs qui se chevauchent (chevauchement désormais autorisé)
  const dayLanes = useMemo(() => {
    const blocks = colOccs.map(o => {
      const s = timeToMin(o.time) ?? 9 * 60;
      const d = Math.max(o.durationMin || 0, SLOT_MIN);
      return { key: `${o.item.id}|${o.date}|${o.movedFrom || ''}|${o.time || ''}`, startMin: s, endMin: Math.min(24 * 60, s + d) };
    });
    return computeDayLanes(blocks);
  }, [colOccs]);

  // Position du Y dans la colonne → minute snappée
  const yToMin = (clientY) => {
    if (!colRef.current) return null;
    const rect = colRef.current.getBoundingClientRect();
    const y = clientY - rect.top;
    const min = Math.max(0, Math.min(24 * 60 - SLOT_MIN, (y / PX_PER_SLOT) * SLOT_MIN));
    return snap5(min);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    const m = yToMin(e.clientY);
    if (m != null) setDragHover({ startMin: m });
  };
  const handleDragLeave = () => setDragHover(null);
  const handleDrop = (e) => {
    e.preventDefault();
    const payload = e.dataTransfer.getData('text/plain');
    const m = yToMin(e.clientY);
    setDragHover(null);
    if (payload && m != null) onDropTask(payload, date, m);
  };

  // Clic dans le vide :
  // - si un bloc est sélectionné → on le désélectionne
  // - sinon → ouvre l'ajout rapide pré-rempli
  const handleColumnClick = (e) => {
    if (e.target !== e.currentTarget) return;
    if (selectedKey) {
      onSelect(null);
      return;
    }
    const m = yToMin(e.clientY);
    if (m != null) onAddAtSlot(date, m);
  };

  // Ligne "maintenant" si aujourd'hui
  const now = new Date();
  const nowMin = isToday ? (now.getHours() * 60 + now.getMinutes()) : null;

  // Trouver l'occurrence sélectionnée pour afficher l'overlay
  const selectedOcc = colOccs.find(o => `${o.item.id}|${o.date}|${o.movedFrom || ''}|${o.time || ''}` === selectedKey);

  return (
    <div
      ref={colRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleColumnClick}
      style={{
        position: 'relative',
        height: `${totalHeight}px`,
        background: isToday ? 'var(--paper-2)' : 'var(--paper)',
        borderRight: '1px solid var(--line)',
        cursor: 'pointer',
      }}
    >
      {/* Lignes d'heure (purement visuelles) */}
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={h}
          style={{
            position: 'absolute', left: 0, right: 0,
            top: `${h * PX_PER_HOUR}px`, height: `${PX_PER_HOUR}px`,
            borderTop: h === 0 ? 'none' : '1px solid var(--line)',
            pointerEvents: 'none',
          }}
        >
          <div style={{
            position: 'absolute', left: 0, right: 0, top: '50%',
            borderTop: '1px dashed var(--line)', opacity: 0.35,
          }} />
        </div>
      ))}

      {/* Ligne maintenant */}
      {nowMin != null && (
        <div style={{
          position: 'absolute', left: 0, right: 0,
          top: `${(nowMin / SLOT_MIN) * PX_PER_SLOT}px`,
          borderTop: '1.5px solid var(--rust)', zIndex: 5, pointerEvents: 'none',
        }}>
          <div style={{ position: 'absolute', left: -4, top: -4, width: 8, height: 8, background: 'var(--rust)', borderRadius: '50%' }} />
        </div>
      )}

      {/* V3 S4.5 : Halos prep/trajet pour les RDV importants — rendus AVANT les blocs (z-index inférieur) */}
      {colOccs.map(o => {
        if (o.status === 'completed' || o.status === 'skipped') return null;
        const startMin = timeToMin(o.time);
        if (startMin == null) return null;
        const halo = getRdvHalo(o.item, startMin, o.durationMin || 0);
        if (!halo) return null;
        const k = `${o.item.id}|${o.date}|${o.movedFrom || ''}|${o.time || ''}`;
        return <RdvHaloBlocks key={`halo-${k}`} halo={halo} />;
      })}

      {/* Blocs */}
      {colOccs.map(o => {
        const k = `${o.item.id}|${o.date}|${o.movedFrom || ''}|${o.time || ''}`;
        return (
          <CalBlock
            key={k}
            blockKey={k}
            occurrence={o}
            categories={categories}
            onOpenEdit={onOpenEdit}
            onToggleOccurrence={onToggleOccurrence}
            onResize={onResize}
            colItems={colOccs}
            selected={selectedKey === k}
            onSelect={onSelect}
            layout={dayLanes[k]}
          />
        );
      })}

      {/* Overlay du bloc sélectionné */}
      {selectedOcc && (
        <CalBlockOverlay
          occurrence={selectedOcc}
          categories={categories}
          onOpenEdit={onOpenEdit}
          onToggleOccurrence={onToggleOccurrence}
          onClose={() => onSelect(null)}
        />
      )}

      {/* Indicateur de drop */}
      {dragHover && (
        <div className="agenda-drop-indicator" style={{
          left: 0, right: 0,
          top: `${(dragHover.startMin / SLOT_MIN) * PX_PER_SLOT}px`,
        }} />
      )}
    </div>
  );
}

// Colonne d'heures (gauche) : labels 0..23
function AgendaHoursColumn() {
  return (
    <div style={{ position: 'relative', height: `${24 * PX_PER_HOUR}px`, background: 'var(--paper-2)', borderRight: '1px solid var(--line)' }}>
      {Array.from({ length: 24 }, (_, h) => (
        <div
          key={h}
          style={{
            position: 'absolute', right: 0, left: 0,
            top: `${h * PX_PER_HOUR}px`, height: `${PX_PER_HOUR}px`,
            padding: '2px 6px 0 0',
            fontSize: '0.7rem', color: 'var(--ink-muted)',
            textAlign: 'right',
            borderTop: h === 0 ? 'none' : '1px solid var(--line)',
            pointerEvents: 'none',
          }}
        >
          {String(h).padStart(2, '0')}h
        </div>
      ))}
    </div>
  );
}

// Wrapper qui scroll auto vers l'heure courante à l'ouverture
function AgendaScrollWrapper({ children, scrollKey }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const now = new Date();
    const min = now.getHours() * 60 + now.getMinutes();
    // Cible : 1h avant l'heure actuelle (pour avoir un peu de contexte au-dessus)
    const target = Math.max(0, ((min - 60) / SLOT_MIN) * PX_PER_SLOT);
    ref.current.scrollTop = target;
  }, [scrollKey]);
  return (
    <div ref={ref} style={{ maxHeight: '70vh', overflowY: 'auto', border: '1px solid var(--line)', borderRadius: '3px' }}>
      {children}
    </div>
  );
}

function DayView({ date, occurrences, categories, onEdit, onDropTask, onResize, onToggleOccurrence, onAddAtSlot }) {
  const isToday = date === todayISO();
  const [selectedKey, setSelectedKey] = useState(null);
  // Désélectionner quand on change de jour
  useEffect(() => { setSelectedKey(null); }, [date]);
  return (
    <AgendaScrollWrapper scrollKey={date}>
      <div style={{ display: 'grid', gridTemplateColumns: '60px 1fr' }}>
        <AgendaHoursColumn />
        <AgendaDayColumn
          date={date}
          occurrences={occurrences}
          categories={categories}
          onOpenEdit={onEdit}
          onDropTask={onDropTask}
          onResize={onResize}
          onToggleOccurrence={onToggleOccurrence}
          onAddAtSlot={onAddAtSlot}
          isToday={isToday}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
        />
      </div>
    </AgendaScrollWrapper>
  );
}

// ============ WEEK VIEW (V3 S3) ============
// Échelle 48px/h, snap drop 15 min, tâches < 15 min cachées (pastille), bandeau À planifier à gauche
const WEEK_PX_PER_HOUR = 48;
const WEEK_SNAP_MIN = 15;
const WEEK_HIDE_THRESHOLD_MIN = 15; // tâches < ce seuil → pastille
const WEEK_PX_PER_MIN = WEEK_PX_PER_HOUR / 60;

// Bloc tâche dans la vue semaine (compact, pas de resize, juste click=ouvrir)
function WeekBlock({ occurrence, categories, onClick }) {
  const { item, time, status, durationMin } = occurrence;
  const cat = categories.find(c => c.id === item.categoryId);
  const cls = item.streak ? 'habit' : item.priority || 'should';
  const completed = status === 'completed';
  const startMin = timeToMin(time) ?? 9 * 60;
  const dur = Math.max(durationMin || 0, WEEK_HIDE_THRESHOLD_MIN);
  const endMin = Math.min(24 * 60, startMin + dur);
  const top = startMin * WEEK_PX_PER_MIN;
  const rawHeight = (endMin - startMin) * WEEK_PX_PER_MIN;
  // V3 S4 : hauteur minimale 18px pour lisibilité (tâches courtes)
  const height = Math.max(rawHeight, 18);

  const handleDragStart = (e) => {
    e.stopPropagation();
    if (occurrence.isOccurrence) {
      e.dataTransfer.setData('text/plain', JSON.stringify({ id: item.id, occDate: occurrence.movedFrom || occurrence.date }));
    } else {
      e.dataTransfer.setData('text/plain', item.id);
    }
    e.dataTransfer.effectAllowed = 'move';
  };

  // V3 S4.5 : pictos prep/trajet (uniquement si Important + heure → halo possible)
  const halo = getRdvHalo(item, startMin, durationMin || 0);
  const hasPrep = !!(halo && halo.hasPrep);
  const hasTravel = !!(halo && halo.hasTravel);
  // Tooltip enrichi avec bornes effectives si halo
  const titleText = (() => {
    const baseRange = `${minToTime(startMin)}–${minToTime(startMin + dur)}`;
    if (halo) {
      const fullRange = `${minToTime(Math.max(0, halo.prepStart))}–${minToTime(Math.min(24*60, halo.returnEnd))}`;
      const parts = [];
      if (hasPrep) parts.push(`prep ${item.prepDuration}min`);
      if (hasTravel) parts.push(`trajet ${item.travelDuration}min${halo.hasReturn ? ' (aller-retour)' : ''}`);
      return `${item.isImportant ? '★ Important · ' : ''}${item.title} · ${baseRange} · zone ${fullRange} · ${parts.join(' + ')}`;
    }
    return `${item.isImportant ? '★ Important · ' : ''}${item.title} · ${baseRange}`;
  })();

  return (
    <div
      className={`cal-block ${cls} ${completed ? 'completed' : ''} ${item.isImportant ? 'cal-block-important' : ''}`}
      draggable
      onDragStart={handleDragStart}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      style={{
        top: `${top}px`, height: `${height}px`,
        borderLeft: cat ? `${item.isImportant ? 5 : 3}px solid ${item.isImportant ? 'var(--ochre)' : cat.color}` : 'none',
        paddingLeft: cat ? '0.3rem' : '0.3rem',
        fontSize: '0.65rem',
        gap: 0,
        background: item.isImportant ? 'rgba(196,135,41,0.18)' : undefined,
        boxShadow: item.isImportant ? '0 0 0 1px var(--ochre)' : undefined,
      }}
      title={titleText}
    >
      <div className="cal-block-title" style={{ lineHeight: 1.1 }}>
        {item.isImportant && <span style={{ color: 'var(--ochre)', fontSize: '0.75rem', flexShrink: 0, fontWeight: 700 }}>★</span>}
        {hasPrep && <span style={{ color: 'var(--ochre)', fontSize: '0.65rem', flexShrink: 0 }} title="Préparation">🎒</span>}
        {hasTravel && <span style={{ color: 'var(--ochre)', fontSize: '0.65rem', flexShrink: 0 }} title="Trajet">🚗</span>}
        {item.icon && <span style={{ fontSize: '0.65rem', flexShrink: 0 }}>{item.icon}</span>}
        <span className="cal-block-title-text" style={{ fontWeight: item.isImportant ? 600 : undefined }}>{item.title}</span>
      </div>
    </div>
  );
}

// Colonne d'un jour en vue semaine
function WeekDayColumn({ date, occurrences, categories, onDropTask, onAddAtSlot, isToday, isPast, onEdit, onJumpToDay }) {
  const colRef = useRef(null);
  const [dragHover, setDragHover] = useState(null);
  const totalHeight = 24 * WEEK_PX_PER_HOUR;

  const dayOccs = occurrences.filter(o => o.date === date && o.time);
  // V3 S4 : tri par hiérarchie complète (Important → deadline → date → durée → énergie)
  // Pour les vues calendrier, on étend sortItemsAuto sur les .item
  const sortedDayOccs = [...dayOccs].sort((a, b) => {
    const aImp = a.item.isImportant ? 1 : 0;
    const bImp = b.item.isImportant ? 1 : 0;
    if (aImp !== bImp) return bImp - aImp;
    const aDl = a.item.deadline || null;
    const bDl = b.item.deadline || null;
    if (aDl && !bDl) return -1;
    if (!aDl && bDl) return 1;
    if (aDl && bDl && aDl !== bDl) return aDl < bDl ? -1 : 1;
    // Durée courte d'abord pour départager
    const aDur = a.durationMin || 9999;
    const bDur = b.durationMin || 9999;
    if (aDur !== bDur) return aDur - bDur;
    return (a.time || 'zz').localeCompare(b.time || 'zz');
  });

  // V3 S4 : détection chevauchement visuel
  // Pour chaque occurrence, vérifier si elle chevauche une autre déjà placée
  // Si oui et que la cellule manque de place, masquer (hidden) et compter dans overflow
  // Stratégie simple : on garde les blocs prioritaires, on cache ceux qui se chevauchent
  // (mais on les compte) — l'utilisateur clique sur +N pour aller à la vue jour
  const placedRanges = []; // [{startMin, endMin}]
  const visibleOccs = [];
  const hiddenOccs = [];
  for (const o of sortedDayOccs) {
    const startMin = timeToMin(o.time) ?? 9 * 60;
    const dur = Math.max(o.durationMin || 0, WEEK_HIDE_THRESHOLD_MIN);
    const endMin = Math.min(24 * 60, startMin + dur);
    // Détecte chevauchement avec un bloc déjà placé
    const overlaps = placedRanges.some(r => startMin < r.endMin && r.startMin < endMin);
    if (overlaps) {
      hiddenOccs.push(o);
    } else {
      visibleOccs.push(o);
      placedRanges.push({ startMin, endMin });
    }
  }
  // microOccs déprécié (S4) : on n'isole plus par durée. Tout est dans visible/hidden selon chevauchement.
  const microOccs = []; // garde le nom pour compat code aval mais vide

  const yToMin = (clientY) => {
    if (!colRef.current) return null;
    const rect = colRef.current.getBoundingClientRect();
    const y = clientY - rect.top;
    const min = Math.max(0, Math.min(24 * 60 - WEEK_SNAP_MIN, y / WEEK_PX_PER_MIN));
    return Math.round(min / WEEK_SNAP_MIN) * WEEK_SNAP_MIN;
  };

  const handleDragOver = (e) => { e.preventDefault(); const m = yToMin(e.clientY); if (m != null) setDragHover({ startMin: m }); };
  const handleDragLeave = () => setDragHover(null);
  const handleDrop = (e) => {
    e.preventDefault();
    const payload = e.dataTransfer.getData('text/plain');
    const m = yToMin(e.clientY);
    setDragHover(null);
    if (payload && m != null) onDropTask(payload, date, m);
  };

  const handleColClick = (e) => {
    if (e.target !== e.currentTarget) return;
    const m = yToMin(e.clientY);
    if (m != null) onAddAtSlot(date, m);
  };

  const now = new Date();
  const nowMin = isToday ? (now.getHours() * 60 + now.getMinutes()) : null;

  return (
    <div
      ref={colRef}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleColClick}
      style={{
        position: 'relative',
        height: `${totalHeight}px`,
        background: isToday ? 'var(--paper-2)' : 'var(--paper)',
        opacity: isPast ? 0.55 : 1,
        borderRight: '1px solid var(--line)',
        cursor: 'pointer',
      }}
    >
      {/* Lignes d'heure */}
      {Array.from({ length: 24 }, (_, h) => (
        <div key={h} style={{
          position: 'absolute', left: 0, right: 0,
          top: `${h * WEEK_PX_PER_HOUR}px`, height: `${WEEK_PX_PER_HOUR}px`,
          borderTop: h === 0 ? 'none' : '1px solid var(--line)',
          pointerEvents: 'none',
        }} />
      ))}

      {/* Ligne maintenant */}
      {nowMin != null && (
        <div style={{
          position: 'absolute', left: 0, right: 0,
          top: `${nowMin * WEEK_PX_PER_MIN}px`,
          borderTop: '1.5px solid var(--rust)', zIndex: 5, pointerEvents: 'none',
        }}>
          <div style={{ position: 'absolute', left: -4, top: -4, width: 8, height: 8, background: 'var(--rust)', borderRadius: '50%' }} />
        </div>
      )}

      {/* Blocs visibles (≥ 15 min) */}
      {visibleOccs.map(o => (
        <WeekBlock
          key={`${o.item.id}|${o.date}|${o.movedFrom || ''}|${o.time || ''}`}
          occurrence={o}
          categories={categories}
          onClick={() => onEdit(o.item, o.isOccurrence ? o.date : null)}
        />
      ))}

      {/* V3 S4 : Pastille overflow "+N" en haut de la colonne si chevauchements masqués */}
      {hiddenOccs.length > 0 && (
        <div
          className="week-micro-pill"
          onClick={(e) => { e.stopPropagation(); onJumpToDay(date); }}
          title={`${hiddenOccs.length} tâche${hiddenOccs.length > 1 ? 's' : ''} masquée${hiddenOccs.length > 1 ? 's' : ''} (chevauchement) — cliquez pour la vue jour`}
          style={{ top: '4px' }}
        >
          +{hiddenOccs.length}
        </div>
      )}

      {/* Indicateur drop */}
      {dragHover && (
        <div className="agenda-drop-indicator" style={{
          left: 0, right: 0,
          top: `${dragHover.startMin * WEEK_PX_PER_MIN}px`,
        }} />
      )}
    </div>
  );
}

// Colonne d'heures pour la vue semaine (échelle WEEK_PX_PER_HOUR)
function WeekHoursColumn() {
  return (
    <div style={{ position: 'relative', height: `${24 * WEEK_PX_PER_HOUR}px`, background: 'var(--paper-2)', borderRight: '1px solid var(--line)' }}>
      {Array.from({ length: 24 }, (_, h) => (
        <div key={h} style={{
          position: 'absolute', right: 0, left: 0,
          top: `${h * WEEK_PX_PER_HOUR}px`, height: `${WEEK_PX_PER_HOUR}px`,
          padding: '2px 4px 0 0',
          fontSize: '0.65rem', color: 'var(--ink-muted)',
          textAlign: 'right',
          borderTop: h === 0 ? 'none' : '1px solid var(--line)',
          pointerEvents: 'none',
        }}>
          {String(h).padStart(2, '0')}h
        </div>
      ))}
    </div>
  );
}

// Wrapper scroll spécifique semaine (auto-scroll vers heure courante)
function WeekScrollWrapper({ children, scrollKey }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const now = new Date();
    const min = now.getHours() * 60 + now.getMinutes();
    const target = Math.max(0, (min - 60) * WEEK_PX_PER_MIN);
    ref.current.scrollTop = target;
  }, [scrollKey]);
  return (
    <div ref={ref} style={{ maxHeight: '78vh', overflow: 'auto', border: '1px solid var(--line)', borderRadius: '3px' }}>
      {children}
    </div>
  );
}

function WeekView({ date, occurrences, unscheduled, categories, onEdit, onDropTask, onResize, onToggleOccurrence, onAddAtSlot, setCalDate, setCalView }) {
  const d = new Date(date + 'T12:00:00');
  const start = new Date(d); start.setDate(d.getDate() - d.getDay() + (d.getDay() === 0 ? -6 : 1));
  const days = Array.from({ length: 7 }, (_, i) => {
    const dd = new Date(start); dd.setDate(start.getDate() + i);
    return dateToISO(dd);
  });
  const today = todayISO();

  const onJumpToDay = (dd) => { setCalDate(dd); setCalView('day'); };

  return (
    <div className="week-layout">
      {/* Bandeau gauche : À planifier */}
      <div className="week-unscheduled">
        <div className="label-side">À planifier · {unscheduled?.length || 0}</div>
        {!unscheduled || unscheduled.length === 0 ? (
          <div style={{ fontSize: '0.72rem', color: 'var(--ink-muted)', fontStyle: 'italic' }}>
            Tout est calé pour cette semaine.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            {unscheduled.map(o => (
              <UnscheduledChip key={`${o.item.id}|${o.date}`} occurrence={o} categories={categories} onEdit={onEdit} onToggleOccurrence={onToggleOccurrence} block />
            ))}
          </div>
        )}
      </div>

      {/* Grille 7 jours */}
      <WeekScrollWrapper scrollKey={`week-${days[0]}`}>
        <div style={{ display: 'grid', gridTemplateColumns: '50px repeat(7, 1fr)' }}>
          {/* Coin vide en haut à gauche */}
          <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--paper-2)', borderBottom: '1px solid var(--line)', borderRight: '1px solid var(--line)', height: '52px' }}></div>
          {/* Header de chaque jour : nom + numéro + densité */}
          {days.map(dd => {
            const dayDate = new Date(dd + 'T12:00:00');
            const isToday = dd === today;
            const isPast = dd < today;
            return (
              <div
                key={`hdr-${dd}`}
                onClick={() => onJumpToDay(dd)}
                style={{
                  position: 'sticky', top: 0, zIndex: 10,
                  background: 'var(--paper-2)',
                  padding: '0.3rem 0.3rem 0.4rem',
                  textAlign: 'center',
                  borderBottom: '1px solid var(--line)', borderRight: '1px solid var(--line)',
                  fontSize: '0.7rem',
                  height: '52px', boxSizing: 'border-box',
                  opacity: isPast ? 0.6 : 1,
                  cursor: 'pointer',
                }}
                title={`Voir le jour ${dayDate.toLocaleDateString('fr-FR')}`}
              >
                <div className="mono" style={{ color: 'var(--ink-muted)', fontSize: '0.6rem' }}>{dayDate.toLocaleDateString('fr-FR', { weekday: 'short' })}</div>
                <div className="display" style={{ fontSize: '1rem', fontWeight: isToday ? 600 : 400 }}>{dayDate.getDate()}</div>
                <DayDensityBar occurrences={occurrences} date={dd} />
              </div>
            );
          })}

          {/* Body : 1 colonne d'heures + 7 colonnes jours */}
          <WeekHoursColumn />
          {days.map(dd => (
            <WeekDayColumn
              key={dd}
              date={dd}
              occurrences={occurrences}
              categories={categories}
              onDropTask={onDropTask}
              onAddAtSlot={onAddAtSlot}
              onEdit={onEdit}
              onJumpToDay={onJumpToDay}
              isToday={dd === today}
              isPast={dd < today}
            />
          ))}
        </div>
      </WeekScrollWrapper>
    </div>
  );
}

function MonthView({ date, occurrences, categories, onEdit, onDropTask, onToggleOccurrence, setCalDate, setCalView }) {
  const d = new Date(date + 'T12:00:00');
  const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
  const startDow = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1; // monday-first
  const start = new Date(firstDay); start.setDate(1 - startDow);
  const cells = Array.from({ length: 42 }, (_, i) => {
    const dd = new Date(start); dd.setDate(start.getDate() + i);
    return dd;
  });
  const today = todayISO();
  const dowLabels = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

  return (
    <div className="cal-grid" style={{ gridTemplateColumns: 'repeat(7, 1fr)', gridTemplateRows: 'auto repeat(6, minmax(110px, 1fr))' }}>
      {dowLabels.map(l => (
        <div key={l} style={{ background: 'var(--paper-2)', padding: '0.4rem', textAlign: 'center', fontSize: '0.7rem', color: 'var(--ink-muted)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>{l}</div>
      ))}
      {cells.map((dd, i) => {
        const ddIso = dateToISO(dd);
        const cellOccs = occurrences.filter(o => o.date === ddIso);
        const otherMonth = dd.getMonth() !== d.getMonth();
        return <MonthCell key={i} dd={dd} ddIso={ddIso} occurrences={cellOccs} categories={categories} otherMonth={otherMonth} isToday={ddIso === today} onEdit={onEdit} onDropTask={onDropTask} onToggleOccurrence={onToggleOccurrence} setCalDate={setCalDate} setCalView={setCalView} />;
      })}
    </div>
  );
}

// V4 4g : échéances des caps (objectifs, projets, jalons actifs) par date, pour l'agenda
function capDeadlineMarks(caps) {
  const byDate = {};
  const walk = (n, depth, objTitle) => {
    if (n.status === 'active' && n.deadline) (byDate[n.deadline] = byDate[n.deadline] || []).push({ id: n.id, title: n.title, kind: capDisplayKind(depth), objTitle });
    (n.children || []).forEach(c => walk(c, depth + 1, objTitle || n.title));
  };
  caps.forEach(o => walk(o, 0, null));
  return byDate;
}
const CAP_KIND_SIGN = { objective: '◆', project: '▸', milestone: '⚑' };
const CalCapsCtx = React.createContext({ marks: {}, onOpenCap: null });

// V4 4g : vue Année — 12 mini-mois, jours chargés en densité, échéances des caps en repères.
// Clic sur un mois → vue Mois ; sur un jour → vue Jour.
function YearView({ date, items, setCalDate, setCalView }) {
  const { marks, onOpenCap } = React.useContext(CalCapsCtx);
  const year = isoToDate(date).getFullYear();
  const occ = useMemo(() => expandItemsForRange(items, `${year}-01-01`, `${year}-12-31`).filter(o => !o.isOccurrence), [items, year]);
  const countByDay = {};
  occ.forEach(o => { countByDay[o.date] = (countByDay[o.date] || 0) + 1; });
  const today = todayISO();
  const yearMarks = Object.entries(marks).filter(([d]) => d.startsWith(String(year))).sort();
  return (
    <div>
      <div className="year-grid">
        {Array.from({ length: 12 }, (_, m) => {
          const first = new Date(year, m, 1);
          const lead = (first.getDay() || 7) - 1;
          const days = new Date(year, m + 1, 0).getDate();
          const monthIso = dateToISO(first);
          return (
            <div key={m} className="year-month">
              <div className="year-month-title" onClick={() => { setCalDate(monthIso); setCalView('month'); }}>
                {first.toLocaleDateString('fr-FR', { month: 'long' })}
              </div>
              <div className="year-days">
                {['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((l, i) => <span key={'h' + i} className="year-dow">{l}</span>)}
                {Array.from({ length: lead }, (_, i) => <span key={'e' + i} />)}
                {Array.from({ length: days }, (_, i) => {
                  const iso = dateToISO(new Date(year, m, i + 1));
                  const n = countByDay[iso] || 0;
                  const mk = marks[iso];
                  const lvl = n >= 5 ? 3 : n >= 3 ? 2 : n >= 1 ? 1 : 0;
                  return (
                    <span key={iso} className={`year-day lvl-${lvl} ${iso === today ? 'today' : ''} ${mk ? 'has-mark' : ''}`}
                      title={`${formatDate(iso)}${n ? ` · ${n} tâche${n > 1 ? 's' : ''}` : ''}${mk ? '\n' + mk.map(x => `${CAP_KIND_SIGN[x.kind]} ${x.title}`).join('\n') : ''}`}
                      onClick={() => { setCalDate(iso); setCalView('day'); }}>{i + 1}</span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flux-card" style={{ marginTop: '1rem' }}>
        <div className="flux-title">Échéances de tes caps en {year}</div>
        {yearMarks.length === 0
          ? <div className="flux-hint">Aucune échéance de cap posée sur l'année.</div>
          : yearMarks.map(([d, list]) => list.map(x => (
              <div key={x.id} className="money-line" style={{ cursor: onOpenCap ? 'pointer' : 'default' }} onClick={() => onOpenCap && onOpenCap()}>
                <span className="mono" style={{ fontSize: '0.72rem', color: 'var(--ink-muted)', width: '4.5rem' }}>{formatDate(d)}</span>
                <span style={{ color: 'var(--violet)', width: '1rem' }}>{CAP_KIND_SIGN[x.kind]}</span>
                <span style={{ flex: 1 }}>{x.title}{x.objTitle && <span style={{ color: 'var(--ink-muted)', fontSize: '0.75rem' }}> · {x.objTitle}</span>}</span>
              </div>
            )))}
        <div className="flux-hint" style={{ marginTop: '0.5rem' }}>◆ objectif · ▸ projet · ⚑ jalon. Densité des jours : tâches ponctuelles datées.</div>
      </div>
    </div>
  );
}

function MonthCell({ dd, ddIso, occurrences, categories, otherMonth, isToday, onEdit, onDropTask, onToggleOccurrence, setCalDate, setCalView }) {
  const [over, setOver] = useState(false);
  const [popover, setPopover] = useState(null); // {x, y} | null
  const { marks: capMarksAll, onOpenCap } = React.useContext(CalCapsCtx); // V4 4g
  const capMarks = capMarksAll[ddIso] || null;

  // V3 S(C2) : tri façon agenda — Important ★ d'abord, puis horodatés par heure, puis le reste
  const priRank = { must: 0, should: 1, want: 2 };
  const sorted = [...occurrences].sort((a, b) => {
    const aImp = a.item.isImportant ? 1 : 0;
    const bImp = b.item.isImportant ? 1 : 0;
    if (aImp !== bImp) return bImp - aImp;
    const aHasT = a.time ? 1 : 0;
    const bHasT = b.time ? 1 : 0;
    if (aHasT !== bHasT) return bHasT - aHasT; // horodatés avant les sans-heure
    if (a.time && b.time && a.time !== b.time) return a.time < b.time ? -1 : 1;
    const aDl = a.item.deadline || null;
    const bDl = b.item.deadline || null;
    if (aDl && !bDl) return -1;
    if (!aDl && bDl) return 1;
    if (aDl && bDl && aDl !== bDl) return aDl < bDl ? -1 : 1;
    const aP = priRank[a.item.priority] ?? 3;
    const bP = priRank[b.item.priority] ?? 3;
    return aP - bP;
  });

  // Densité visuelle : 1=1-2 items, 2=3-4, 3=5-6, 4=7+
  let densityClass = '';
  const n = occurrences.length;
  if (n >= 7) densityClass = 'density-4';
  else if (n >= 5) densityClass = 'density-3';
  else if (n >= 3) densityClass = 'density-2';
  else if (n >= 1) densityClass = 'density-1';

  // Surbrillance deadline pour items dont la deadline tombe ce jour
  const deadlineState = (item) => {
    if (!item.deadline) return null;
    if (item.deadline < ddIso) return 'overdue';
    // Pas de soft state ici, déjà 'soon' = sur la date elle-même
    if (item.deadline === ddIso) return 'soon';
    return null;
  };

  const goDay = () => { setCalDate(ddIso); setCalView('day'); };

  // V3 S(C2) : pastille façon agenda — dot catégorie (ou ★) + heure + titre
  const renderChip = (o, keyPrefix = '') => {
    const cat = categories.find(c => c.id === o.item.categoryId);
    const dl = deadlineState(o.item);
    const completed = o.status === 'completed';
    const imp = o.item.isImportant;
    return (
      <div
        key={`${keyPrefix}${o.item.id}|${o.date}|${o.movedFrom || ''}|${o.time || ''}`}
        onClick={(e) => { e.stopPropagation(); setPopover(null); onEdit(o.item, o.isOccurrence ? o.date : null); }}
        title={`${o.time ? o.time + ' · ' : ''}${o.item.title}`}
        style={{
          display: 'flex', alignItems: 'center', gap: '0.25rem',
          fontSize: '0.68rem', lineHeight: 1.25, padding: '0.06rem 0.2rem',
          borderRadius: '2px', cursor: 'pointer',
          background: imp ? 'rgba(196,135,41,0.18)' : undefined,
          borderLeft: imp ? '2px solid var(--ochre)' : undefined,
          opacity: completed ? 0.5 : 1,
          textDecoration: completed ? 'line-through' : undefined,
          boxShadow: (dl === 'soon' || dl === 'overdue') ? '0 0 0 1px var(--rust) inset' : undefined,
        }}
      >
        {imp
          ? <span style={{ color: 'var(--ochre)', fontSize: '0.7rem', flexShrink: 0 }}>★</span>
          : <span style={{ width: 6, height: 6, borderRadius: '50%', flexShrink: 0, background: cat?.color || 'var(--ink-fog)' }} />}
        {o.time && <span style={{ color: 'var(--ink-muted)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{o.time}</span>}
        {o.item.icon && <span style={{ flexShrink: 0 }}>{o.item.icon}</span>}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--ink)' }}>{o.item.title}</span>
        {o.isOccurrence && <span style={{ fontSize: '0.5rem', color: 'var(--ink-muted)', flexShrink: 0 }}>🔁</span>}
      </div>
    );
  };

  const handleCellClick = (e) => {
    if (e.target !== e.currentTarget) return;
    setCalDate(ddIso); setCalView('day');
  };

  return (
    <div
      className={`cal-cell ${otherMonth ? 'other-month' : ''} ${isToday ? 'today' : ''} ${over ? 'drag-over' : ''} ${densityClass}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); const payload = e.dataTransfer.getData('text/plain'); if (payload) onDropTask(payload, ddIso, 9 * 60); }}
      onClick={handleCellClick}
      style={{ cursor: 'pointer' }}
    >
      <div
        style={{ fontSize: '0.75rem', color: isToday ? 'var(--rust)' : 'var(--ink)', fontWeight: isToday ? 600 : 400, marginBottom: '0.2rem' }}
        onClick={(e) => { e.stopPropagation(); setCalDate(ddIso); setCalView('day'); }}
      >
        {dd.getDate()}
      </div>
      {capMarks && capMarks.map(x => (
        <div key={x.id} className="cal-cap-mark" title={`${x.kind === 'objective' ? 'Objectif' : x.kind === 'project' ? 'Projet' : 'Jalon'} · échéance${x.objTitle ? ' · ' + x.objTitle : ''}`}
          onClick={(e) => { e.stopPropagation(); onOpenCap && onOpenCap(); }}>
          {CAP_KIND_SIGN[x.kind]} {x.title}
        </div>
      ))}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
        {sorted.slice(0, 3).map(o => renderChip(o))}
      </div>
      {sorted.length > 3 && (
        <div
          style={{ fontSize: '0.62rem', color: 'var(--ink-muted)', cursor: 'pointer', marginTop: '1px', fontWeight: 500, paddingLeft: '0.2rem' }}
          onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); setPopover({ x: r.left, y: r.bottom }); }}
        >
          +{sorted.length - 3} autres
        </div>
      )}
      {popover && (
        <>
          <div onClick={(e) => { e.stopPropagation(); setPopover(null); }} style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.max(8, Math.min(popover.x, (typeof window !== 'undefined' ? window.innerWidth : 1000) - 256)),
              top: Math.min(popover.y + 4, (typeof window !== 'undefined' ? window.innerHeight : 800) - 340),
              width: 240, maxHeight: 320, overflowY: 'auto',
              background: 'var(--paper)', border: '1px solid var(--ink)', borderRadius: '4px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.2)', zIndex: 61, padding: '0.5rem',
            }}
          >
            <div
              onClick={() => { setPopover(null); goDay(); }}
              style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--ink)', cursor: 'pointer', marginBottom: '0.4rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--line)', paddingBottom: '0.3rem', gap: '0.5rem' }}
            >
              <span style={{ textTransform: 'capitalize' }}>{dd.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</span>
              <span style={{ color: 'var(--ink-muted)', fontSize: '0.62rem', whiteSpace: 'nowrap' }}>vue jour →</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {sorted.map(o => renderChip(o, 'pop-'))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ============ QUICK ADD MODAL (V3 S3) ============
// Modale rapide d'ajout : titre, priorité, date+heure, durée préset, catégorie.
// Entrée = enregistre. Bouton "+ détails" = bascule vers modale complète (avec prefill).
function QuickAddModal({ categories, prefill, onClose, onSave, onMore }) {
  const pre = prefill || {};
  const [title, setTitle] = useState(pre.title || '');
  const [priority, setPriority] = useState(pre.priority || 'inbox');
  const [date, setDate] = useState(pre.date || '');
  const [time, setTime] = useState(pre.time || '');
  const [durationMin, setDurationMin] = useState(durationToMinutes(pre.duration || {}) || 5);
  const [customDur, setCustomDur] = useState(false);
  const [categoryId, setCategoryId] = useState(pre.categoryId !== undefined ? pre.categoryId : '');
  const titleRef = useRef(null);

  useEffect(() => {
    // focus auto sur le titre à l'ouverture
    if (titleRef.current) titleRef.current.focus();
  }, []);

  const presetDurs = [5, 15, 30, 60, 120];

  // Construit la data conforme à addItem (mêmes champs que ItemModal handleSave)
  const buildData = () => {
    const safeDur = durationMin > 0 ? Math.max(5, snap5(durationMin)) : 0;
    return {
      title: title.trim(),
      type: 'task',
      categoryId: categoryId || '',
      icon: '',
      date: date || '',
      time: time || '',
      reminder: '',
      priority: priority,
      notes: '',
      energy: 'medium',
      duration: safeDur > 0 ? minutesToDuration(safeDur) : null,
      durationManualOverride: false,
      deadline: null,
      recurrence: null,
    };
  };

  const handleSave = () => {
    if (!title.trim()) return;
    onSave(buildData());
  };

  const handleMore = () => {
    // On passe la donnée même si titre vide, pour que la modale complète prenne le relais
    onMore(buildData());
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }} onKeyDown={handleKeyDown}>
        <h2 className="display" style={{ margin: 0, marginBottom: '0.75rem', fontSize: '1.3rem', fontWeight: 500, fontStyle: 'italic' }}>
          Ajout rapide
        </h2>

        {/* Titre */}
        <input
          ref={titleRef}
          className="input"
          placeholder="Titre de la tâche…"
          value={title}
          onChange={e => setTitle(e.target.value)}
          style={{ width: '100%', padding: '0.5rem 0.6rem', fontSize: '0.95rem', marginBottom: '0.75rem', boxSizing: 'border-box' }}
        />

        {/* Priorité */}
        <Label>Priorité</Label>
        <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          {[
            { id: 'must', label: 'Must' },
            { id: 'should', label: 'Should' },
            { id: 'want', label: 'Want' },
            { id: 'inbox', label: 'Inbox' },
          ].map(p => (
            <button
              key={p.id}
              className={priority === p.id ? 'btn btn-primary' : 'btn'}
              onClick={() => setPriority(p.id)}
              style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Date + heure */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <div>
            <Label>Date</Label>
            <input type="date" className="input" style={{ width: '100%', padding: '0.4rem', boxSizing: 'border-box' }} value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <Label>Heure</Label>
            <TimeInput value={time} onChange={setTime} style={{ width: '100%' }} />
          </div>
        </div>
        {(date || time) && (
          <div style={{ marginBottom: '0.75rem' }}>
            <button className="btn-ghost" style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', cursor: 'pointer', border: 'none', background: 'transparent', textDecoration: 'underline' }} onClick={() => { setDate(''); setTime(''); }}>retirer date et heure</button>
          </div>
        )}

        {/* Durée */}
        <Label>Durée</Label>
        <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
          {presetDurs.map(m => (
            <button
              key={m}
              className={(!customDur && durationMin === m) ? 'btn btn-primary' : 'btn'}
              onClick={() => { setDurationMin(m); setCustomDur(false); }}
              style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}
            >
              {formatDurMin(m)}
            </button>
          ))}
          <button
            className={customDur ? 'btn btn-primary' : 'btn'}
            onClick={() => setCustomDur(true)}
            style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}
          >
            Autre
          </button>
          <button
            className={(!customDur && durationMin === 0) ? 'btn btn-primary' : 'btn'}
            onClick={() => { setDurationMin(0); setCustomDur(false); }}
            style={{ fontSize: '0.78rem', padding: '0.3rem 0.6rem' }}
          >
            —
          </button>
        </div>
        {customDur && (
          <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', marginBottom: '0.5rem' }}>
            <input
              type="number"
              min="5"
              step="5"
              className="input"
              style={{ width: '90px', padding: '0.3rem' }}
              value={durationMin || ''}
              onChange={e => setDurationMin(parseInt(e.target.value) || 0)}
              onBlur={e => setDurationMin(snap5(Math.max(5, parseInt(e.target.value) || 5)))}
              placeholder="min"
            />
            <span style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>min · pas de 5</span>
          </div>
        )}

        {/* Catégorie */}
        {categories && categories.length > 0 && (
          <>
            <Label>Catégorie</Label>
            <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <button
                className={!categoryId ? 'btn btn-primary' : 'btn'}
                onClick={() => setCategoryId('')}
                style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem' }}
              >
                Aucune
              </button>
              {categories.map(c => (
                <button
                  key={c.id}
                  className={categoryId === c.id ? 'btn btn-primary' : 'btn'}
                  onClick={() => setCategoryId(c.id)}
                  style={{ fontSize: '0.75rem', padding: '0.3rem 0.5rem', display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}
                >
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: c.color, display: 'inline-block' }}></span>
                  {c.name}
                </button>
              ))}
            </div>
          </>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.5rem' }}>
          <button
            className="btn-ghost"
            style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', cursor: 'pointer', border: 'none', background: 'transparent', textDecoration: 'underline' }}
            onClick={handleMore}
          >
            + détails
          </button>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button className="btn" onClick={onClose}>Annuler</button>
            <button className="btn btn-rust" onClick={handleSave} disabled={!title.trim()}>
              <IconCheck size={14} /> Enregistrer
            </button>
          </div>
        </div>

        <div style={{ marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--ink-muted)', fontStyle: 'italic' }}>
          Entrée pour valider · Échap pour fermer
        </div>
      </div>
    </div>
  );
}

// ============ ITEM MODAL ============
// ============ SCOPE MODAL (V3 S2B) ============
// Demande à l'utilisateur le scope d'une modification ou suppression sur une tâche récurrente
function ScopeModal({ kind, onClose, onConfirm }) {
  const [scope, setScope] = useState('this');
  const verb = kind === 'delete' ? 'Supprimer' : 'Appliquer';
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '440px' }}>
        <h2 className="display" style={{ margin: 0, marginBottom: '0.5rem', fontSize: '1.3rem', fontWeight: 500, fontStyle: 'italic' }}>
          {kind === 'delete' ? 'Supprimer cette occurrence ?' : 'À quoi appliquer le changement ?'}
        </h2>
        <div style={{ fontSize: '0.8rem', color: 'var(--ink-muted)', marginBottom: '1rem' }}>
          Cet item est récurrent. Choisis le périmètre :
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '1.5rem' }}>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', cursor: 'pointer', padding: '0.6rem', background: scope === 'this' ? 'var(--paper-2)' : 'transparent', border: `1px solid ${scope === 'this' ? 'var(--rust)' : 'var(--line)'}`, borderRadius: '3px' }}>
            <input type="radio" checked={scope === 'this'} onChange={() => setScope('this')} style={{ marginTop: '0.15rem' }} />
            <div>
              <div style={{ fontWeight: 500, fontSize: '0.88rem' }}>Cette occurrence seulement</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>Ne touche que cette date. Les autres restent inchangées.</div>
            </div>
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', cursor: 'pointer', padding: '0.6rem', background: scope === 'this-and-future' ? 'var(--paper-2)' : 'transparent', border: `1px solid ${scope === 'this-and-future' ? 'var(--rust)' : 'var(--line)'}`, borderRadius: '3px' }}>
            <input type="radio" checked={scope === 'this-and-future'} onChange={() => setScope('this-and-future')} style={{ marginTop: '0.15rem' }} />
            <div>
              <div style={{ fontWeight: 500, fontSize: '0.88rem' }}>Cette occurrence et toutes les futures</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>{kind === 'delete' ? 'Termine la série à partir de cette date.' : 'Modifie à partir de cette date. Les passées restent inchangées.'}</div>
            </div>
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', cursor: 'pointer', padding: '0.6rem', background: scope === 'all' ? 'var(--paper-2)' : 'transparent', border: `1px solid ${scope === 'all' ? 'var(--rust)' : 'var(--line)'}`, borderRadius: '3px' }}>
            <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} style={{ marginTop: '0.15rem' }} />
            <div>
              <div style={{ fontWeight: 500, fontSize: '0.88rem' }}>Toute la série</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>{kind === 'delete' ? 'Supprime toutes les occurrences (passées et futures).' : 'Modifie toutes les occurrences.'}</div>
            </div>
          </label>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Annuler</button>
          <button className="btn btn-rust" onClick={() => onConfirm(scope)}><IconCheck size={14} /> {verb}</button>
        </div>
      </div>
    </div>
  );
}

// ============ PREP / TRAVEL SECTION (V3 S4.5) ============
// Apparaît dans ItemModal uniquement si Important + heure renseignée.
// Champs optionnels et indépendants : préparation (avant le trajet), trajet aller (toujours juste avant l'heure de RDV),
// trajet retour symétrique cochable. Saisie en minutes via boutons rapides + input "autre".
function PrepTravelSection({ prepDuration, travelDuration, travelReturn, travelReturnDuration, onChangePrep, onChangeTravel, onToggleReturn, onChangeReturnDuration, time }) {
  const PREP_PRESETS = [5, 10, 15, 30];
  const TRAVEL_PRESETS = [5, 10, 15, 30, 45];

  // Calcule l'heure de "départ" (= time - travel - prep) pour aperçu textuel
  const startMin = timeToMin(time);
  const prep = (typeof prepDuration === 'number' && prepDuration > 0) ? prepDuration : 0;
  const trav = (typeof travelDuration === 'number' && travelDuration > 0) ? travelDuration : 0;
  const showHint = (prep > 0 || trav > 0) && startMin != null;
  const departMin = startMin != null ? Math.max(0, startMin - trav) : null;
  const prepStartMin = startMin != null ? Math.max(0, startMin - trav - prep) : null;

  const Picker = ({ label, value, presets, onChange, emoji }) => {
    const val = (typeof value === 'number' && value > 0) ? value : null;
    return (
      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.78rem', color: 'var(--ink-muted)', marginBottom: '0.35rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          <span>{emoji}</span><span>{label}</span>
          {val != null && <span style={{ color: 'var(--ochre)', fontWeight: 600 }}>· {val} min</span>}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', alignItems: 'center' }}>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="btn"
            style={{
              padding: '0.25rem 0.55rem', fontSize: '0.72rem',
              borderColor: val == null ? 'var(--ochre)' : 'var(--line)',
              background: val == null ? 'rgba(196,135,41,0.12)' : 'transparent',
              color: val == null ? 'var(--ochre)' : 'var(--ink-muted)',
              fontWeight: val == null ? 600 : 400,
            }}
          >
            Aucun
          </button>
          {presets.map(n => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(n)}
              className="btn"
              style={{
                padding: '0.25rem 0.55rem', fontSize: '0.72rem',
                borderColor: val === n ? 'var(--ochre)' : 'var(--line)',
                background: val === n ? 'rgba(196,135,41,0.12)' : 'transparent',
                color: val === n ? 'var(--ochre)' : 'var(--ink-muted)',
                fontWeight: val === n ? 600 : 400,
              }}
            >
              {n} min
            </button>
          ))}
          <input
            type="number"
            min="1"
            max="240"
            step="5"
            placeholder="autre"
            value={val != null && !presets.includes(val) ? val : ''}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') { onChange(null); return; }
              const n = parseInt(raw, 10);
              if (isNaN(n) || n < 1) { onChange(null); return; }
              onChange(Math.min(240, n));
            }}
            onBlur={(e) => {
              // V3 S4.5 fix : snap au pas de 5 min au blur (HTML5 step n'est qu'indicatif)
              const raw = e.target.value;
              if (raw === '') return;
              const n = parseInt(raw, 10);
              if (isNaN(n) || n < 1) return;
              const snapped = Math.max(5, Math.min(240, Math.round(n / 5) * 5));
              if (snapped !== n) onChange(snapped);
            }}
            style={{
              width: '70px', padding: '0.25rem 0.4rem', fontSize: '0.72rem',
              border: '1px solid var(--line)', borderRadius: '3px',
              background: 'var(--paper)', color: 'var(--ink)',
              fontFamily: 'var(--font-body)',
            }}
          />
        </div>
      </div>
    );
  };

  return (
    <div style={{
      marginBottom: '1.25rem',
      padding: '0.75rem 0.85rem',
      borderLeft: '3px solid var(--ochre)',
      background: 'rgba(196,135,41,0.05)',
      borderRadius: '3px',
    }}>
      <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--ochre)', marginBottom: '0.55rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Avant le RDV
      </div>
      <Picker label="Préparation" value={prepDuration} presets={PREP_PRESETS} onChange={onChangePrep} emoji="🎒" />
      <Picker label="Trajet aller" value={travelDuration} presets={TRAVEL_PRESETS} onChange={onChangeTravel} emoji="🚗" />
      {/* V5 : trajet retour, prérempli avec l'aller, modifiable (ex. retour à pied) */}
      <label style={{
        display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem',
        color: 'var(--ink)', cursor: 'pointer', marginTop: '0.2rem', marginBottom: travelReturn ? '0.5rem' : 0,
      }}>
        <input type="checkbox" checked={!!travelReturn} onChange={onToggleReturn} />
        <span>🔄 Trajet retour</span>
      </label>
      {travelReturn && (
        <Picker label={`Trajet retour${travelReturnDuration == null && trav > 0 ? ' (= aller)' : ''}`}
          value={travelReturnDuration != null ? travelReturnDuration : (trav > 0 ? trav : null)}
          presets={TRAVEL_PRESETS}
          onChange={onChangeReturnDuration}
          emoji="🏠" />
      )}
      {showHint && (
        <div style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginTop: '0.55rem', fontStyle: 'italic', lineHeight: 1.4 }}>
          {prep > 0 && trav > 0 && `🎒 Prep à ${minToTime(prepStartMin)} → 🚗 départ à ${minToTime(departMin)} → RDV à ${time}`}
          {prep > 0 && trav === 0 && `🎒 Prep à ${minToTime(prepStartMin)} → RDV à ${time}`}
          {prep === 0 && trav > 0 && `🚗 Départ à ${minToTime(departMin)} → RDV à ${time}`}
        </div>
      )}
    </div>
  );
}

// ============ V4 4a.1 — BOUSSOLE ============
function VisionEditor({ vision, onUpdate, onDelete }) {
  const [text, setText] = useState(vision.text || '');
  useEffect(() => { setText(vision.text || ''); }, [vision.id]);
  return (
    <div className="cap-vision">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
        <Label>Vision</Label>
        <button className="btn-ghost" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-fog)', padding: '0.1rem' }} title="Supprimer cette vision" onClick={() => { if (window.confirm('Supprimer cette vision ? Les objectifs liés repasseront en non-rattachés.')) onDelete(); }}>
          <IconTrash size={13} />
        </button>
      </div>
      <textarea
        className="input"
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={() => { if (text !== vision.text) onUpdate({ text }); }}
        placeholder="La direction, le rêve, le pourquoi… (1 an et +). Texte libre."
        rows={3}
        style={{ resize: 'vertical', fontFamily: 'var(--font-display)', fontStyle: 'italic', fontSize: '0.95rem' }}
      />
    </div>
  );
}

// V4 4a.2 : échéance d'un projet/jalon passée → l'app DEMANDE (jamais de « retard » sur un cap).
// Question + options + souveraineté. Chaque réponse est consignée dans node.decisions.
function CapDeadlineQuestion({ node, kind, onEditCap, onSetStatus }) {
  const capOps = React.useContext(BoussoleCapCtx);
  const [mode, setMode] = useState(null); // null | 'postpone' | 'file'
  const [newDate, setNewDate] = useState(addDays(todayISO(), 14));
  const decide = (answer, patch) => capOps.onDecision(node.id, { trigger: 'deadline', forDeadline: node.deadline, answer }, patch);
  const noun = kind === 'milestone' ? 'ce jalon' : 'ce projet';
  const doneLabel = kind === 'milestone' ? 'Franchi, en fait' : 'Terminé, en fait';
  return (
    <div className="cap-question">
      <div style={{ fontSize: '0.82rem', marginBottom: '0.45rem' }}>
        L'échéance du {formatDate(node.deadline)} est passée. Tu en fais quoi, de {noun} ?
      </div>
      {mode === null && (
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
          <button className="cap-btn-mini" onClick={() => setMode('postpone')}>Repousser</button>
          <button className="cap-btn-mini" onClick={() => { decide('reduce'); onEditCap(); }}>Réduire le livrable</button>
          <button className="cap-btn-mini" onClick={() => setMode('file')}>Classer</button>
          <span style={{ flex: 1 }} />
          <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-fog)' }} onClick={() => decide('later')}>plus tard</button>
        </div>
      )}
      {mode === 'postpone' && (
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <input type="date" className="input" style={{ width: 'auto', padding: '0.25rem 0.4rem', fontSize: '0.8rem' }} value={newDate} min={todayISO()} onChange={e => setNewDate(e.target.value)} />
          <button className="cap-btn-mini" disabled={!newDate} onClick={() => decide('postpone', { deadline: newDate })}>OK</button>
          <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-fog)' }} onClick={() => setMode(null)}>annuler</button>
        </div>
      )}
      {mode === 'file' && (
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="cap-btn-mini" style={{ borderColor: 'var(--moss)', color: 'var(--moss)' }} onClick={() => { decide('file-reached'); onSetStatus(node.id, 'reached'); }}>{doneLabel}</button>
          <button className="cap-btn-mini" onClick={() => { decide('file-paused'); onSetStatus(node.id, 'paused'); }}>En pause</button>
          <button className="cap-btn-mini" onClick={() => { decide('file-abandoned'); onSetStatus(node.id, 'abandoned'); }}>Ça ne compte plus</button>
          <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-fog)' }} onClick={() => setMode(null)}>annuler</button>
        </div>
      )}
    </div>
  );
}

function CapNode({ node, depth, visions, tasksByCap, parentMap, isFirst, isLast, onEditCap, onAddNode, onSetStatus, onMoveCap, onDeleteCap, onAddTaskToCap, onEditTask, onToggleTask }) {
  const kind = capDisplayKind(depth); // objective | project | milestone
  const taskOps = React.useContext(BoussoleTaskCtx); // handlers TaskCard (réordo/imbrication identiques à Priorités)
  const capOps = React.useContext(BoussoleCapCtx); // V4 4a.2
  const pace = (depth >= 1 && !capOps.lowMode && node.status === 'active') ? capPace(node) : null;
  const askDeadline = !capOps.lowMode && capDeadlineQuestionDue(node, depth);
  const [collapsed, setCollapsed] = useState(false);
  const [showTasks, setShowTasks] = useState(true);
  const prog = capProgress(node);
  const dormant = node.status !== 'active';
  const reached = node.status === 'reached';
  const linked = tasksByCap[node.id] || [];
  // Tâches liées de plus haut niveau : leur parent n'est pas lui-même lié à ce cap.
  // (leurs sous-tâches sont rendues par TaskCard, donc pas besoin de les lister à part)
  const linkedSet = new Set(linked.map(t => t.id));
  const topLinked = linked.filter(t => { const p = parentMap ? parentMap[t.id] : null; return !p || !linkedSet.has(p); });
  const children = node.children || [];

  const cls = kind === 'objective' ? 'cap-objective' : kind === 'project' ? 'cap-project' : 'cap-milestone';
  const advanceVerb = kind === 'objective' ? 'Marquer atteint' : kind === 'project' ? 'Terminer' : 'Franchir ✓';
  const addLabel = depth === 0 ? '+ projet' : '+ jalon';
  const kindLabel = kind === 'objective' ? 'Objectif' : kind === 'project' ? 'Projet' : 'Jalon';

  const vision = (kind === 'objective' && node.visionLink) ? visions.find(v => v.id === node.visionLink) : null;
  const deadlinePast = node.deadline && node.deadline < todayISO();

  return (
    <div className={`${cls} ${dormant ? 'dormant' : ''} ${reached ? 'reached' : ''}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mono" style={{ fontSize: '0.6rem', letterSpacing: '0.1em', textTransform: 'uppercase', color: kind === 'objective' ? '#6B4E8A' : kind === 'project' ? 'var(--ocean)' : 'var(--moss)', marginBottom: '0.15rem', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            {kind === 'milestone' && <span>⚑</span>}{kindLabel}
            {dormant && <span className={`cap-status-pill ${node.status}`}>{node.status === 'reached' ? (kind === 'milestone' ? 'franchi' : kind === 'objective' ? 'atteint' : 'terminé') : node.status === 'paused' ? 'en pause' : 'abandonné'}</span>}
          </div>
          <div className={kind === 'objective' ? 'display' : ''} style={{ fontWeight: kind === 'objective' ? 600 : 500, fontSize: kind === 'objective' ? '1.15rem' : kind === 'project' ? '0.95rem' : '0.88rem', fontStyle: kind === 'objective' ? 'italic' : 'normal', lineHeight: 1.25, textDecoration: reached ? 'line-through' : 'none' }}>
            {node.title}
          </div>
          {node.why && <div className="cap-why">{node.why}</div>}
          {(kind === 'node' || kind === 'project' || kind === 'milestone') && node.deliverable && (
            <div style={{ fontSize: '0.78rem', color: 'var(--ink-soft)', marginTop: '0.2rem' }}>Livrable : {node.deliverable}</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', flexShrink: 0 }}>
          <button className="cap-btn-mini" disabled={isFirst} title="Monter" onClick={() => onMoveCap(node.id, -1)} style={{ padding: '0.2rem 0.35rem' }}>↑</button>
          <button className="cap-btn-mini" disabled={isLast} title="Descendre" onClick={() => onMoveCap(node.id, 1)} style={{ padding: '0.2rem 0.35rem' }}>↓</button>
          <button className="cap-btn-mini" title="Éditer" onClick={() => onEditCap(node, depth)} style={{ padding: '0.2rem 0.35rem' }}>éditer</button>
          <button className="cap-btn-mini" title="Retirer ce cap" onClick={() => { if (window.confirm(`Retirer « ${node.title} » et tout ce qu'il contient ? Les tâches liées seront déliées (pas supprimées).`)) onDeleteCap(node.id); }} style={{ padding: '0.2rem 0.35rem', borderColor: 'transparent', color: 'var(--ink-fog)' }}><IconTrash size={12} /></button>
        </div>
      </div>

      {/* meta chips */}
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.5rem', alignItems: 'center' }}>
        {prog && <span className="cap-progress" title="Enfants franchis / total">{prog.done}/{prog.total} {depth === 0 ? 'projets' : 'jalons'}</span>}
        {node.deadline && <span className="chip" title={deadlinePast ? 'Échéance dépassée — un cap n\'est jamais « en retard » ; à revoir au bilan' : 'Échéance indicative'} style={{ color: 'var(--ink-muted)' }}><IconCalendar size={10} />{formatDate(node.deadline)}{deadlinePast ? ' · échue' : ''}</span>}
        {node.measure && node.measure.mode === 'numeric' && (
          <span className="chip" style={{ color: 'var(--ink-soft)' }}>📊 {node.measure.current ?? 0}/{node.measure.target ?? '?'}{node.measure.unit ? ' ' + node.measure.unit : ''}</span>
        )}
        {node.measure && node.measure.mode === 'binary' && (
          <span className="chip" style={{ color: 'var(--ink-soft)' }}>{reached ? '✓ atteint' : '○ pas encore'}</span>
        )}
        {vision && <span className="chip chip-cap" title="Vision rattachée"><IconCompass size={10} />{(vision.text.split('\n')[0] || 'Vision').slice(0, 24)}</span>}
        {node.pillars?.length > 0 && <PillarDots pillars={node.pillars} />}
        {pace && <span className="chip cap-pace" title="Rythme : l'état des jalons comparé à leurs dates. Une indication, pas un verdict.">Rythme · {PACE_LABELS[pace]}</span>}
      </div>

      {askDeadline && <CapDeadlineQuestion node={node} kind={kind} onEditCap={() => onEditCap(node, depth)} onSetStatus={onSetStatus} />}

      {/* action row */}
      {!dormant && (
        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.6rem', alignItems: 'center' }}>
          <button className="cap-btn-mini" style={{ borderColor: 'var(--moss)', color: 'var(--moss)' }} onClick={() => onSetStatus(node.id, 'reached')}>{advanceVerb}</button>
          <button className="cap-btn-mini" onClick={() => onAddNode(node.id)}>{addLabel}</button>
          <button className="cap-btn-mini" onClick={() => onAddTaskToCap(node.id)}>+ tâche</button>
          <span style={{ flex: 1 }} />
          <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-fog)' }} onClick={() => onSetStatus(node.id, 'paused')}>pause</button>
          <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-fog)' }} onClick={() => { if (window.confirm(`Lâcher « ${node.title} » ? C'est une décision assumée, pas un échec.`)) onSetStatus(node.id, 'abandoned'); }}>abandonner</button>
        </div>
      )}
      {dormant && (
        <div style={{ marginTop: '0.6rem' }}>
          <button className="cap-btn-mini" onClick={() => onSetStatus(node.id, 'active')}>réactiver</button>
        </div>
      )}

      {/* tâches liées — rendues comme en Priorités (réordo + imbrication en D&D) */}
      {topLinked.length > 0 && (
        <div style={{ marginTop: '0.5rem' }}>
          <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-muted)', padding: '0.15rem 0' }} onClick={() => setShowTasks(t => !t)}>
            {showTasks ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />} Tâches liées · {linked.length}
          </button>
          {showTasks && taskOps && (
            <div style={{ marginTop: '0.4rem' }}>
              {topLinked.map(t => (
                <TaskCard key={t.id} item={t} depth={0}
                  categories={taskOps.categories}
                  onToggle={taskOps.onToggle} onEdit={taskOps.onEdit}
                  onStart={taskOps.onStart} onAddSub={taskOps.onAddSub}
                  onReorder={taskOps.onReorder} onSubtaskDrop={taskOps.onSubtaskDrop}
                  onTogglePin={taskOps.onTogglePin} runningId={taskOps.runningId}
                  selectedId={taskOps.selectedId} onSelect={taskOps.onSelect} />
              ))}
              <div style={{ fontSize: '0.68rem', color: 'var(--ink-fog)', marginTop: '0.2rem', fontStyle: 'italic' }}>
                Glisse une tâche sur une autre : haut/bas pour l'ordre, centre pour l'imbriquer en sous-tâche.
              </div>
            </div>
          )}
        </div>
      )}

      {/* enfants récursifs */}
      {children.length > 0 && (
        <div style={{ marginTop: '0.4rem' }}>
          <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-muted)', padding: '0.15rem 0' }} onClick={() => setCollapsed(c => !c)}>
            {collapsed ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />} {collapsed ? 'déplier' : 'replier'}
          </button>
          {!collapsed && (
            <div className="cap-node-children">
              {children.map((c, i) => (
                <CapNode key={c.id} node={c} depth={depth + 1} visions={visions} tasksByCap={tasksByCap} parentMap={parentMap}
                  isFirst={i === 0} isLast={i === children.length - 1}
                  onEditCap={onEditCap} onAddNode={onAddNode} onSetStatus={onSetStatus} onMoveCap={onMoveCap}
                  onDeleteCap={onDeleteCap} onAddTaskToCap={onAddTaskToCap} onEditTask={onEditTask} onToggleTask={onToggleTask} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BoussoleView({ lowMode, onSetLowMode, onOpenReview, weekFocusLabel, monthCapLabel, caps, visions, items, categories, activeObjectiveCount, onAddObjective, onEditCap, onAddNode, onSetStatus, onMoveCap, onDeleteCap, onAddVision, onUpdateVision, onDeleteVision, onAddTaskToCap, onLinkTaskToCap, onEditTask, onToggleTask }) {
  const tasksByCap = useMemo(() => {
    const m = {};
    flattenItems(items).forEach(it => { if (it.capId) { (m[it.capId] = m[it.capId] || []).push(it); } });
    return m;
  }, [items]);

  // Carte enfant→parent (pour ne montrer que les tâches liées de plus haut niveau ; leurs sous-tâches viennent avec)
  const parentMap = useMemo(() => {
    const m = {};
    const walk = (list, parentId) => list.forEach(it => { m[it.id] = parentId; if (it.subtasks?.length) walk(it.subtasks, it.id); });
    walk(items, null);
    return m;
  }, [items]);

  const active = caps.filter(o => o.status === 'active');
  const dormant = caps.filter(o => o.status !== 'active');
  const [showDormant, setShowDormant] = useState(false);
  const [showVision, setShowVision] = useState(true);

  return (
    <div style={{ maxWidth: '760px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '0.5rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <h2 className="display" style={{ margin: 0, fontSize: '1.6rem', fontWeight: 500, fontStyle: 'italic' }}>Boussole</h2>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.82rem', color: 'var(--ink-muted)' }}>Est-ce que ce que je fais m'amène où je veux ?</p>
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
          <button className="cap-btn-mini" title="Le rituel hebdo : ce qui a compté, où en sont tes projets, ce qui compte ensuite" onClick={onOpenReview}>Point de la semaine</button>
          {!lowMode?.on && <button className="cap-btn-mini" title="Coupe toute question, rythme et relance. Les caps dorment en silence." onClick={() => onSetLowMode(true)}>Période de pause</button>}
          <button className="btn btn-rust" onClick={onAddObjective}><IconPlus size={14} /> Objectif</button>
        </div>
      </div>

      {(weekFocusLabel || monthCapLabel) && !lowMode?.on && (
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
          {monthCapLabel && <span className="focus-chip" style={{ cursor: 'default' }}>◆ Ce mois-ci : {monthCapLabel}</span>}
          {weekFocusLabel && <span className="focus-chip" style={{ cursor: 'default' }}>✦ Cette semaine : {weekFocusLabel}</span>}
        </div>
      )}

      {lowMode?.on && (
        <div className="cap-lowmode">
          <span>🌙 Période de pause{lowMode.since ? ` depuis le ${formatDate(lowMode.since)}` : ''}. Pas de questions, pas de rythme affiché : les caps dorment en silence.</span>
          <button className="cap-btn-mini" onClick={() => onSetLowMode(false)}>Reprendre</button>
        </div>
      )}

      {activeObjectiveCount >= 3 && (
        <div style={{ fontSize: '0.78rem', color: 'var(--ochre)', background: 'rgba(196,135,41,0.1)', border: '1px solid var(--ochre)', borderRadius: '3px', padding: '0.5rem 0.7rem', marginBottom: '0.75rem' }}>
          {activeObjectiveCount} objectifs actifs en parallèle. Tu surinvestis peut-être ? (Juste une remarque — rien n'est bloqué.)
        </div>
      )}

      {/* Vision */}
      <div style={{ marginBottom: '1.25rem' }}>
        <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-muted)', padding: '0.15rem 0', marginBottom: '0.4rem' }} onClick={() => setShowVision(v => !v)}>
          {showVision ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />} Vision · {visions.length}
        </button>
        {showVision && (
          <>
            {visions.map(v => <VisionEditor key={v.id} vision={v} onUpdate={(p) => onUpdateVision(v.id, p)} onDelete={() => onDeleteVision(v.id)} />)}
            <button className="cap-btn-mini" onClick={() => onAddVision('')}><IconPlus size={12} /> Vision</button>
          </>
        )}
      </div>

      {/* Objectifs actifs */}
      {active.length === 0 && dormant.length === 0 && (
        <div style={{ textAlign: 'center', color: 'var(--ink-fog)', fontStyle: 'italic', padding: '2.5rem 1rem', border: '1px dashed var(--line)', borderRadius: '4px' }}>
          Aucun cap encore. Pose un objectif (≈3 mois) pour commencer à relier ton quotidien à une direction.
        </div>
      )}
      {active.map((o, i) => (
        <CapNode key={o.id} node={o} depth={0} visions={visions} tasksByCap={tasksByCap} parentMap={parentMap}
          isFirst={i === 0} isLast={i === active.length - 1}
          onEditCap={onEditCap} onAddNode={onAddNode} onSetStatus={onSetStatus} onMoveCap={onMoveCap}
          onDeleteCap={onDeleteCap} onAddTaskToCap={onAddTaskToCap} onEditTask={onEditTask} onToggleTask={onToggleTask} />
      ))}

      {/* Dormants (pause / atteints / abandonnés) */}
      {dormant.length > 0 && (
        <div style={{ marginTop: '1.5rem' }}>
          <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-muted)' }} onClick={() => setShowDormant(d => !d)}>
            {showDormant ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />} En pause · atteints · lâchés ({dormant.length})
          </button>
          {showDormant && (
            <div style={{ marginTop: '0.6rem' }}>
              {dormant.map((o, i) => (
                <CapNode key={o.id} node={o} depth={0} visions={visions} tasksByCap={tasksByCap} parentMap={parentMap}
                  isFirst={true} isLast={true}
                  onEditCap={onEditCap} onAddNode={onAddNode} onSetStatus={onSetStatus} onMoveCap={onMoveCap}
                  onDeleteCap={onDeleteCap} onAddTaskToCap={onAddTaskToCap} onEditTask={onEditTask} onToggleTask={onToggleTask} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Marque un écran additionnel du rituel comme « vu » (la focale mensuelle compte comme faite dès qu'elle a été regardée)
function ExtraStepVisit({ onVisit, children }) {
  useEffect(() => { onVisit(); }, []);
  return <div>{children}</div>;
}

// V4 4a.3 : invitation discrète au rituel (jamais de popup). Sautable, pas de streak.
function WeeklyReviewInvite({ onOpen, onSkip }) {
  return (
    <div className="review-invite">
      <div>
        <div className="display" style={{ fontSize: '1.05rem', fontStyle: 'italic', fontWeight: 500 }}>Ton point de la semaine</div>
        <div style={{ fontSize: '0.78rem', color: 'var(--ink-muted)' }}>Trois questions, trois minutes. Ce qui a compté, où en sont tes projets, ce qui compte ensuite.</div>
      </div>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
        <button className="btn btn-rust" onClick={onOpen}>Ouvrir</button>
        <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-fog)' }} onClick={onSkip}>pas cette semaine</button>
      </div>
    </div>
  );
}

// V4 4a.3 : le rituel hebdo unique. Ordre non négociable : doux → qui-pique → souveraineté.
// Chaque écran est sautable ; rien n'est obligatoire. Le mode bas régime retire l'écran 2.
function WeeklyReviewModal({ state, lowMode, week, extraSteps = [], onClose, onFinish, onCapDecision, onSetCapStatus, onUpdateCap, onAddNudgeTask }) {
  const existing = (state.reviews?.weekly || {})[week.weekId] || {};
  const [step, setStep] = useState(0);
  const [mattered, setMattered] = useState(existing.mattered || '');
  const prevFocus = (state.weeklyFocus || {})[week.nextWeekId] || {};
  const [focusCapId, setFocusCapId] = useState(prevFocus.capId || '');
  const [focusText, setFocusText] = useState(prevFocus.text || '');
  const [answered, setAnswered] = useState({}); // capId → libellé de la réponse donnée pendant ce rituel
  const [nudgeFor, setNudgeFor] = useState(null);
  const [nudgeTitle, setNudgeTitle] = useState('');
  const [extraData, setExtraData] = useState({});

  const caps = state.caps || [];
  const items = state.items || [];
  const all = useMemo(() => flattenItems(items), [items]);
  const startTs = isoToDate(week.range.start).getTime();
  const endTs = isoToDate(addDays(week.range.end, 1)).getTime();
  const doneTasks = all.filter(i => i.completedAt && i.completedAt >= startTs && i.completedAt < endTs);
  let routineChecks = 0;
  all.forEach(i => {
    if (!(i.recurrence || i.streak)) return;
    for (let d = week.range.start; d <= week.range.end; d = addDays(d, 1)) if (isOccurrenceCompleted(i, d)) routineChecks++;
  });
  const intentions = Object.entries(state.dailyIntentions || {}).filter(([d, t]) => d >= week.range.start && d <= week.range.end && t).sort();
  // Figés à l'ouverture : les réponses ne font pas « sauter » la liste. Un projet déjà
  // interrogé sur son rythme n'est pas re-questionné comme zombie (une question suffit).
  const concerns = useMemo(() => findPaceConcerns(caps), []);
  const zombies = useMemo(() => { const seen = new Set(concerns.map(c => c.node.id)); return findZombieCaps(caps, items).filter(z => !seen.has(z.node.id)); }, []);
  const objectivesWithWhy = caps.filter(o => o.status === 'active' && o.why);
  const capOptions = activeCapOptions(caps);

  const steps = ['mattered', ...(lowMode ? [] : ['projects']), 'next', ...extraSteps.map(e => e.key)];
  const cur = steps[step];
  const isLast = step === steps.length - 1;
  const mark = (id, label) => setAnswered(a => ({ ...a, [id]: label }));
  const finish = () => onFinish({ mattered: mattered.trim(), focus: (focusCapId || focusText.trim()) ? { capId: focusCapId || null, text: focusText.trim() } : null, extra: extraData });

  const titles = { mattered: "Qu'est-ce qui a compté cette semaine ?", projects: 'Où en sont tes projets ?', next: 'La semaine qui vient, qu\'est-ce qui compte ?' };
  extraSteps.forEach(e => { titles[e.key] = e.title; });

  const answerRow = (id, buttons) => answered[id]
    ? <div style={{ fontSize: '0.78rem', color: 'var(--moss)', marginTop: '0.35rem' }}>✓ {answered[id]}</div>
    : <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>{buttons}</div>;

  return (
    <div className="modal-bg">{/* pas de fermeture au clic sur le fond : on ne perd pas ce qui a été écrit */}
      <div className="modal review-modal" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
          <div className="mono" style={{ fontSize: '0.65rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)' }}>
            Point de la semaine · {step + 1}/{steps.length}
          </div>
          <button className="btn-ghost" style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '0.3rem' }} onClick={onClose}><IconX size={18} /></button>
        </div>
        <h2 className="display" style={{ margin: '0 0 1rem', fontSize: '1.4rem', fontWeight: 500, fontStyle: 'italic' }}>{titles[cur]}</h2>

        {cur === 'mattered' && (
          <div>
            <div className="review-facts">
              <span>{doneTasks.length} tâche{doneTasks.length > 1 ? 's' : ''} bouclée{doneTasks.length > 1 ? 's' : ''}</span>
              <span>{routineChecks} routine{routineChecks > 1 ? 's' : ''} cochée{routineChecks > 1 ? 's' : ''}</span>
            </div>
            {doneTasks.length > 0 && (
              <ul className="review-list">
                {doneTasks.slice(0, 8).map(t => {
                  const lab = t.capId ? capDirectLabel(caps, t.capId) : null;
                  return <li key={t.id}>{t.title}{lab && <span className="chip chip-cap" style={{ marginLeft: '0.4rem' }}><IconCompass size={9} />{lab}</span>}</li>;
                })}
                {doneTasks.length > 8 && <li style={{ color: 'var(--ink-fog)' }}>… et {doneTasks.length - 8} autres</li>}
              </ul>
            )}
            {intentions.length > 0 && (
              <div style={{ margin: '0.6rem 0' }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--ink-muted)', marginBottom: '0.2rem' }}>Tes intentions du jour :</div>
                {intentions.map(([d, t]) => <div key={d} style={{ fontSize: '0.8rem', color: 'var(--ink-soft)', fontStyle: 'italic' }}>{formatDate(d)} — {t}</div>)}
              </div>
            )}
            <textarea className="input" rows={3} placeholder="En quelques mots, si tu veux. Rien n'est obligatoire." value={mattered} onChange={e => setMattered(e.target.value)} style={{ marginTop: '0.5rem', resize: 'vertical' }} />
          </div>
        )}

        {cur === 'projects' && (
          <div>
            {objectivesWithWhy.length > 0 && (
              <div style={{ marginBottom: '0.9rem' }}>
                <div style={{ fontSize: '0.72rem', color: 'var(--ink-muted)', marginBottom: '0.25rem' }}>Pour rappel, pourquoi tu fais tout ça :</div>
                {objectivesWithWhy.map(o => <div key={o.id} style={{ fontSize: '0.82rem', marginBottom: '0.15rem' }}><strong>{o.title}</strong> — <span className="cap-why" style={{ display: 'inline' }}>{o.why}</span></div>)}
              </div>
            )}
            {concerns.length === 0 && zombies.length === 0 && (
              <div style={{ fontSize: '0.85rem', color: 'var(--ink-soft)', padding: '0.5rem 0' }}>Rien ne réclame ton attention côté projets. Ça roule.</div>
            )}
            {concerns.map(c => (
              <div key={c.node.id} className="cap-question" style={{ marginTop: '0.5rem' }}>
                <div style={{ fontSize: '0.82rem' }}><strong>{c.node.title}</strong> <span style={{ color: 'var(--ink-muted)' }}>({c.parent.title})</span> — {c.pace === 'still' ? "rien n'a bougé alors qu'un jalon est passé." : 'un jalon attend.'}</div>
                {c.overdue.map(m => (
                  <div key={m.id} style={{ marginTop: '0.4rem', paddingLeft: '0.6rem', borderLeft: '2px dotted var(--line)' }}>
                    <div style={{ fontSize: '0.8rem' }}>⚑ {m.title} <span style={{ color: 'var(--ink-muted)' }}>· prévu le {formatDate(m.deadline)}</span> — il en est où ?</div>
                    {answerRow(m.id, <>
                      <button className="cap-btn-mini" style={{ borderColor: 'var(--moss)', color: 'var(--moss)' }} onClick={() => { onSetCapStatus(m.id, 'reached'); mark(m.id, 'franchi'); }}>Franchi</button>
                      <button className="cap-btn-mini" onClick={() => { const nd = addDays(todayISO(), 14); onCapDecision(m.id, { trigger: 'pace', answer: 'postpone', forDeadline: m.deadline }, { deadline: nd }); mark(m.id, `repoussé au ${formatDate(nd)}`); }}>Repousser de 2 semaines</button>
                      <button className="cap-btn-mini" onClick={() => { onCapDecision(m.id, { trigger: 'pace', answer: 'escaped', forDeadline: m.deadline }); setNudgeFor(c.node); setNudgeTitle(''); mark(m.id, "ça t'a échappé — rien de grave"); }}>Ça m'a échappé</button>
                      <button className="cap-btn-mini" onClick={() => { onCapDecision(m.id, { trigger: 'pace', answer: 'drop', forDeadline: m.deadline }); onSetCapStatus(m.id, 'abandoned'); mark(m.id, 'lâché — une décision, pas un échec'); }}>Ça ne compte plus</button>
                    </>)}
                  </div>
                ))}
              </div>
            ))}
            {zombies.map(z => (
              <div key={z.node.id} className="cap-question" style={{ marginTop: '0.5rem' }}>
                <div style={{ fontSize: '0.82rem' }}><strong>{z.node.title}</strong>{z.parent && <span style={{ color: 'var(--ink-muted)' }}> ({z.parent.title})</span>} — rien n'a bougé depuis trois semaines. Pause assumée, ou perte de sens ?</div>
                {answerRow(z.node.id, <>
                  <button className="cap-btn-mini" onClick={() => { onCapDecision(z.node.id, { trigger: 'zombie', answer: 'pause' }); onSetCapStatus(z.node.id, 'paused'); mark(z.node.id, 'en pause, assumée'); }}>Pause assumée</button>
                  <button className="cap-btn-mini" onClick={() => { onCapDecision(z.node.id, { trigger: 'zombie', answer: 'escaped' }); setNudgeFor(z.node); setNudgeTitle(''); mark(z.node.id, "ça t'a échappé — on s'y remet doucement"); }}>Ça m'a échappé</button>
                  <button className="cap-btn-mini" onClick={() => { onCapDecision(z.node.id, { trigger: 'zombie', answer: 'drop' }); onSetCapStatus(z.node.id, 'abandoned'); mark(z.node.id, 'lâché — une décision, pas un échec'); }}>Ça ne compte plus</button>
                </>)}
              </div>
            ))}
            {nudgeFor && (
              <div className="review-nudge">
                <div style={{ fontSize: '0.8rem', marginBottom: '0.35rem' }}>Une petite chose pour te remettre sur « {nudgeFor.title} » la semaine prochaine ?</div>
                <div style={{ display: 'flex', gap: '0.35rem' }}>
                  <input className="input" autoFocus placeholder="Ex. : relire mes notes 15 min" value={nudgeTitle} onChange={e => setNudgeTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && nudgeTitle.trim()) { onAddNudgeTask(nudgeFor.id, nudgeTitle.trim()); setNudgeFor(null); } }} />
                  <button className="cap-btn-mini" disabled={!nudgeTitle.trim()} onClick={() => { onAddNudgeTask(nudgeFor.id, nudgeTitle.trim()); setNudgeFor(null); }}>Caser</button>
                  <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-fog)' }} onClick={() => setNudgeFor(null)}>non merci</button>
                </div>
              </div>
            )}
          </div>
        )}

        {cur === 'next' && (
          <div>
            <div style={{ fontSize: '0.8rem', color: 'var(--ink-muted)', marginBottom: '0.6rem' }}>Une seule chose. Celle qui, si elle avance, rend la semaine réussie.</div>
            {capOptions.length > 0 && (
              <select className="input" value={focusCapId} onChange={e => setFocusCapId(e.target.value)} style={{ marginBottom: '0.5rem' }}>
                <option value="">— pas un cap en particulier —</option>
                {capOptions.map(o => <option key={o.id} value={o.id}>{'  '.repeat(o.depth)}{o.label}</option>)}
              </select>
            )}
            <input className="input" placeholder={focusCapId ? 'Précision (facultatif)' : 'En quelques mots (facultatif)'} value={focusText} onChange={e => setFocusText(e.target.value)} />
          </div>
        )}

        {extraSteps.map(e => cur === e.key && <ExtraStepVisit key={e.key} onVisit={() => setExtraData(d => d[e.key] ? d : ({ ...d, [e.key]: {} }))}>{e.render(extraData[e.key] || {}, v => setExtraData(d => ({ ...d, [e.key]: { ...(d[e.key] || {}), ...v } })))}</ExtraStepVisit>)}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1.4rem', gap: '0.5rem' }}>
          <button className="cap-btn-mini" disabled={step === 0} onClick={() => setStep(s => s - 1)}>← retour</button>
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {!isLast && <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-fog)' }} onClick={() => setStep(s => s + 1)}>passer</button>}
            {!isLast && <button className="btn btn-rust" onClick={() => setStep(s => s + 1)}>Suivant</button>}
            {isLast && <button className="btn btn-rust" onClick={finish}>Terminer</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

// V4 4a.3 : focale mensuelle = 4e écran du rituel la 1re fois du mois (pas un second rituel).
// Elle regarde la direction : vision, objectifs, alignement — plus rare, contemplatif.
function MonthlyFocusStep({ caps, visions, data, set, onCapDecision, onSetCapStatus }) {
  const objectives = caps.filter(o => o.status === 'active');
  const answers = data.alignment || {};
  const answer = (o, a, label) => {
    onCapDecision(o.id, { trigger: 'alignment', answer: a });
    set({ alignment: { ...answers, [o.id]: label } });
  };
  const options = activeCapOptions(caps).filter(o => o.depth <= 1);
  return (
    <div>
      {visions.filter(v => v.text).length > 0 && (
        <div className="cap-vision" style={{ padding: '0.7rem 0.9rem' }}>
          {visions.filter(v => v.text).map(v => <div key={v.id} style={{ fontSize: '0.85rem', fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>{v.text}</div>)}
        </div>
      )}
      {objectives.length === 0 && <div style={{ fontSize: '0.85rem', color: 'var(--ink-soft)' }}>Aucun objectif actif. C'est peut-être le moment d'en poser un — ou pas.</div>}
      {objectives.map(o => (
        <div key={o.id} className="cap-question" style={{ marginTop: '0.5rem' }}>
          <div style={{ fontSize: '0.85rem' }}><strong>{o.title}</strong></div>
          {o.why && <div className="cap-why">{o.why}</div>}
          <div style={{ fontSize: '0.8rem', marginTop: '0.35rem' }}>Toujours aligné avec ce qui compte pour toi ?</div>
          {answers[o.id]
            ? <div style={{ fontSize: '0.78rem', color: 'var(--moss)', marginTop: '0.35rem' }}>✓ {answers[o.id]}</div>
            : <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
                <button className="cap-btn-mini" onClick={() => answer(o, 'yes', 'toujours aligné')}>Oui</button>
                <button className="cap-btn-mini" onClick={() => answer(o, 'adjust', 'à ajuster — tu pourras le retoucher dans la Boussole')}>À ajuster</button>
                <button className="cap-btn-mini" onClick={() => { answer(o, 'pause', 'mis en pause'); onSetCapStatus(o.id, 'paused'); }}>Plus vraiment : pause</button>
                <button className="cap-btn-mini" onClick={() => { answer(o, 'drop', 'lâché — une décision, pas un échec'); onSetCapStatus(o.id, 'abandoned'); }}>Plus vraiment : lâcher</button>
              </div>}
        </div>
      ))}
      {options.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--ink-muted)', marginBottom: '0.35rem' }}>Le cap du mois — celui qui compte le plus ce mois-ci (facultatif) :</div>
          <select className="input" value={data.monthCapId || ''} onChange={e => set({ monthCapId: e.target.value })}>
            <option value="">— aucun en particulier —</option>
            {options.map(o => <option key={o.id} value={o.id}>{'  '.repeat(o.depth)}{o.label}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}

// V4 4b : sélection des piliers (facultatif). `inherited` = piliers hérités du cap, affichés en indice.
function PillarPicker({ value = [], onChange, inherited = [] }) {
  const toggle = (id) => onChange(value.includes(id) ? value.filter(x => x !== id) : [...value, id]);
  return (
    <div>
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
        {PILLARS.map(p => {
          const on = value.includes(p.id);
          return (
            <button key={p.id} type="button" className="pillar-chip" onClick={() => toggle(p.id)}
              style={on ? { background: p.color, borderColor: p.color, color: '#fff' } : { borderColor: p.color, color: p.color }}>{p.label}</button>
          );
        })}
      </div>
      {!value.length && inherited.length > 0 && (
        <div style={{ fontSize: '0.72rem', color: 'var(--ink-muted)', marginTop: '0.3rem' }}>
          Hérité du cap : {inherited.map(id => PILLARS.find(p => p.id === id)?.label).filter(Boolean).join(', ')}
        </div>
      )}
    </div>
  );
}
function PillarDots({ pillars }) {
  if (!pillars || !pillars.length) return null;
  return (
    <span style={{ display: 'inline-flex', gap: '0.25rem', alignItems: 'center' }}>
      {pillars.map(id => { const p = PILLARS.find(x => x.id === id); return p ? <span key={id} className="chip" style={{ color: p.color, borderColor: p.color }}>{p.label}</span> : null; })}
    </span>
  );
}

// V4 4b : « Ce que j'arrête » — streak inversé. Réussir = ne pas craquer ; craquer se dit, sans jugement.
function QuitsSection({ quits, onAdd, onToggleSlip, onDelete }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [pillars, setPillars] = useState([]);
  const today = todayISO();
  const submit = () => { if (!title.trim()) return; onAdd({ title: title.trim(), pillars }); setTitle(''); setPillars([]); setAdding(false); };
  return (
    <div style={{ marginTop: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <h3 className="display" style={{ margin: 0, fontSize: '1.25rem', fontStyle: 'italic', fontWeight: 500 }}>Ce que j'arrête</h3>
          <div style={{ fontSize: '0.78rem', color: 'var(--ink-muted)' }}>Réussir, ici, c'est ne rien faire. Un écart se note, le compteur repart — sans jugement.</div>
        </div>
        {!adding && <button className="cap-btn-mini" onClick={() => setAdding(true)}><IconPlus size={12} /> Arrêter quelque chose</button>}
      </div>
      {adding && (
        <div className="cap-question" style={{ marginBottom: '0.9rem' }}>
          <input className="input" autoFocus placeholder="Ex. : scroller au lit, fumer, commander à manger" value={title} onChange={e => setTitle(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
          <div style={{ margin: '0.5rem 0 0.2rem', fontSize: '0.72rem', color: 'var(--ink-muted)' }}>Ce que ça libère (facultatif) :</div>
          <PillarPicker value={pillars} onChange={setPillars} />
          <div style={{ display: 'flex', gap: '0.35rem', marginTop: '0.6rem' }}>
            <button className="cap-btn-mini" disabled={!title.trim()} onClick={submit}>Ajouter</button>
            <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-fog)' }} onClick={() => setAdding(false)}>annuler</button>
          </div>
        </div>
      )}
      {quits.length === 0 && !adding && <div style={{ fontSize: '0.82rem', color: 'var(--ink-fog)', fontStyle: 'italic' }}>Rien pour l'instant.</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem' }}>
        {quits.map(q => {
          const n = quitStreak(q, today);
          const slippedToday = (q.slips || []).includes(today);
          const days = Array.from({ length: 14 }, (_, i) => addDays(today, i - 13));
          const startIso = dateToISO(new Date(q.createdAt || Date.now()));
          return (
            <div key={q.id} className="quit-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{q.title}</div>
                  <div style={{ marginTop: '0.25rem' }}><PillarDots pillars={q.pillars} /></div>
                </div>
                <button className="btn-ghost" style={{ padding: '0.25rem', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-muted)' }} title="Retirer" onClick={() => onDelete(q.id)}><IconTrash size={14} /></button>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem', margin: '0.6rem 0' }}>
                <span className="display" style={{ fontSize: '1.5rem', fontWeight: 600 }}>{n}</span>
                <span style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>jour{n > 1 ? 's' : ''} sans</span>
              </div>
              <div style={{ display: 'flex', gap: '3px', marginBottom: '0.75rem' }}>
                {days.map(d => {
                  const slip = (q.slips || []).includes(d);
                  const before = d < startIso;
                  return <div key={d} title={formatDate(d) + (slip ? ' · écart' : '')} style={{ flex: 1, height: '14px', borderRadius: '2px', border: '1px solid var(--line)', background: before ? 'transparent' : slip ? 'var(--ink-fog)' : 'var(--moss)', opacity: before ? 0.3 : 1 }} />;
                })}
              </div>
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => onToggleSlip(q.id, today)}>
                {slippedToday ? 'Annuler l\'écart d\'aujourd\'hui' : 'J\'ai craqué aujourd\'hui'}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ V4 4c : PILIER ARGENT ============
// Pas un outil bancaire : juste les flux. Montants stockés en centimes (entiers), en euros.
const EUR = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const fmtEur = (cents) => EUR.format((cents || 0) / 100);
function parseAmountToCents(str) {
  const n = parseFloat(String(str || '').replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}
// Périodes : { kind: 'day'|'week'|'month', anchor: iso } → { start, end, label }
function periodRange(kind, anchor) {
  const d = isoToDate(anchor);
  if (kind === 'day') return { start: anchor, end: anchor, label: formatDate(anchor) };
  if (kind === 'week') { const r = weekRange(d); return { ...r, label: `Semaine du ${formatDate(r.start)}` }; }
  const r = monthRange(d);
  const ml = d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  return { ...r, label: ml.charAt(0).toUpperCase() + ml.slice(1) };
}
function shiftPeriod(kind, anchor, dir) {
  if (kind === 'day') return addDays(anchor, dir);
  if (kind === 'week') return addDays(anchor, 7 * dir);
  const d = isoToDate(anchor); d.setDate(1); d.setMonth(d.getMonth() + dir); return dateToISO(d);
}
// Occurrences d'un flux récurrent (mensuel jour N, hebdo jour J) dans [start, end]
function flowOccurrences(flow, start, end) {
  const out = [];
  const from = flow.since && flow.since > start ? flow.since : start;
  const to = flow.until && flow.until < end ? flow.until : end;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dt = isoToDate(d);
    if (flow.rule === 'weekly' && (dt.getDay() || 7) === flow.day) out.push(d);
    if (flow.rule === 'monthly') {
      const last = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
      if (dt.getDate() === Math.min(flow.day, last)) out.push(d);
    }
  }
  return out;
}
// Toutes les lignes d'argent (ponctuelles + occurrences de flux) sur une période
function moneyLines(money, start, end) {
  const m = money || {};
  const lines = (m.entries || []).filter(e => e.date >= start && e.date <= end).map(e => ({ ...e, key: e.id }));
  (m.flows || []).forEach(f => flowOccurrences(f, start, end).forEach(d => lines.push({ key: f.id + d, flowId: f.id, date: d, amount: f.amount, dir: f.dir, label: f.label, recurring: true })));
  return lines.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}
function moneyTotals(lines) {
  const inc = lines.filter(l => l.dir === 'in').reduce((s, l) => s + l.amount, 0);
  const out = lines.filter(l => l.dir === 'out').reduce((s, l) => s + l.amount, 0);
  return { inc, out, net: inc - out };
}
const WEEKDAY_LABELS = ['', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

function PeriodNav({ kind, setKind, anchor, setAnchor, kinds = ['day', 'week', 'month'] }) {
  const labels = { day: 'Jour', week: 'Semaine', month: 'Mois' };
  const r = periodRange(kind, anchor);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.9rem' }}>
      <div style={{ display: 'flex', gap: '0.25rem' }}>
        {kinds.map(k => <button key={k} className={`cap-btn-mini ${kind === k ? 'active-mini' : ''}`} onClick={() => setKind(k)}>{labels[k]}</button>)}
      </div>
      <button className="cap-btn-mini" title="Précédent" onClick={() => setAnchor(shiftPeriod(kind, anchor, -1))}><IconChevronLeft size={12} /></button>
      <span style={{ fontSize: '0.85rem', minWidth: '9rem', textAlign: 'center' }}>{r.label}</span>
      <button className="cap-btn-mini" title="Suivant" onClick={() => setAnchor(shiftPeriod(kind, anchor, 1))}><IconChevronRight size={12} /></button>
      <button className="cap-btn-mini" style={{ borderColor: 'transparent' }} onClick={() => setAnchor(todayISO())}>aujourd'hui</button>
    </div>
  );
}

function MoneyPanel({ money, onAddEntry, onDeleteEntry, onAddFlow, onStopFlow, onDeleteFlow }) {
  const [kind, setKind] = useState('month');
  const [anchor, setAnchor] = useState(todayISO());
  const [dir, setDir] = useState('out');
  const [amount, setAmount] = useState('');
  const [label, setLabel] = useState('');
  const [date, setDate] = useState(todayISO());
  const [amountErr, setAmountErr] = useState(false);
  const [showFlowForm, setShowFlowForm] = useState(false);
  const [flow, setFlow] = useState({ dir: 'out', amount: '', label: '', rule: 'monthly', day: 1 });
  const r = periodRange(kind, anchor);
  const lines = moneyLines(money, r.start, r.end);
  const t = moneyTotals(lines);
  const submit = () => {
    const cents = parseAmountToCents(amount);
    if (!cents) { setAmountErr(true); return; }
    onAddEntry({ dir, amount: cents, label: label.trim() || (dir === 'in' ? 'Entrée' : 'Sortie'), date: date || todayISO() });
    setAmount(''); setLabel(''); setAmountErr(false);
  };
  const submitFlow = () => {
    const cents = parseAmountToCents(flow.amount);
    if (!cents || !flow.label.trim()) return;
    onAddFlow({ ...flow, amount: cents, label: flow.label.trim(), day: Number(flow.day) });
    setFlow({ dir: 'out', amount: '', label: '', rule: 'monthly', day: 1 }); setShowFlowForm(false);
  };
  const flows = (money?.flows || []);
  return (
    <div>
      <PeriodNav kind={kind} setKind={setKind} anchor={anchor} setAnchor={setAnchor} />
      <div className="stat-row">
        <div className="stat-tile"><div className="stat-label">Entrées</div><div className="stat-value">{fmtEur(t.inc)}</div></div>
        <div className="stat-tile"><div className="stat-label">Sorties</div><div className="stat-value">{fmtEur(t.out)}</div></div>
        <div className="stat-tile"><div className="stat-label">Solde net</div><div className="stat-value">{t.net > 0 ? '+' : ''}{fmtEur(t.net)}</div></div>
      </div>

      <div className="money-form">
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          <button className={`cap-btn-mini ${dir === 'out' ? 'active-mini' : ''}`} onClick={() => setDir('out')}>− Sortie</button>
          <button className={`cap-btn-mini ${dir === 'in' ? 'active-mini' : ''}`} onClick={() => setDir('in')}>+ Entrée</button>
        </div>
        <input className={`input ${amountErr ? 'input-error' : ''}`} inputMode="decimal" placeholder="Montant €" value={amount} onChange={e => { setAmount(e.target.value); setAmountErr(false); }} onKeyDown={e => { if (e.key === 'Enter') submit(); }} style={{ width: '7.5rem' }} />
        <input className="input" placeholder="Libellé (facultatif)" value={label} onChange={e => setLabel(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') submit(); }} style={{ flex: 1, minWidth: '8rem' }} />
        <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} style={{ width: 'auto' }} />
        <button className="btn btn-rust" onClick={submit}><IconPlus size={14} /> Ajouter</button>
      </div>

      {lines.length === 0
        ? <div style={{ fontSize: '0.82rem', color: 'var(--ink-fog)', fontStyle: 'italic', margin: '0.8rem 0' }}>Aucun mouvement sur cette période.</div>
        : <div className="money-list">
            {lines.map(l => (
              <div key={l.key} className="money-line" style={{ opacity: l.date > todayISO() ? 0.55 : 1 }} title={l.date > todayISO() ? 'À venir' : undefined}>
                <span className="mono" style={{ fontSize: '0.72rem', color: 'var(--ink-muted)', width: '4.5rem' }}>{formatDate(l.date)}{l.date > todayISO() ? ' ·' : ''}</span>
                <span style={{ flex: 1 }}>{l.recurring && <span title="Flux récurrent" style={{ marginRight: '0.3rem' }}>🔁</span>}{l.label}</span>
                <span className="mono" style={{ fontSize: '0.82rem' }}>{l.dir === 'in' ? '+' : '−'}{fmtEur(l.amount)}</span>
                {!l.recurring
                  ? <button className="btn-ghost" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-fog)', padding: '0.2rem' }} title="Supprimer" onClick={() => onDeleteEntry(l.id)}><IconTrash size={12} /></button>
                  : <span style={{ width: '1.2rem' }} />}
              </div>
            ))}
          </div>}

      <div style={{ marginTop: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <Label>Flux récurrents</Label>
          {!showFlowForm && <button className="cap-btn-mini" onClick={() => setShowFlowForm(true)}><IconPlus size={12} /> Flux</button>}
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--ink-fog)', marginBottom: '0.5rem' }}>Loyer, salaire, abonnements : comptés automatiquement dans les totaux, sans ressaisie.</div>
        {showFlowForm && (
          <div className="money-form" style={{ marginBottom: '0.6rem' }}>
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              <button className={`cap-btn-mini ${flow.dir === 'out' ? 'active-mini' : ''}`} onClick={() => setFlow(f => ({ ...f, dir: 'out' }))}>− Sortie</button>
              <button className={`cap-btn-mini ${flow.dir === 'in' ? 'active-mini' : ''}`} onClick={() => setFlow(f => ({ ...f, dir: 'in' }))}>+ Entrée</button>
            </div>
            <input className="input" placeholder="Libellé" value={flow.label} onChange={e => setFlow(f => ({ ...f, label: e.target.value }))} style={{ flex: 1, minWidth: '8rem' }} />
            <input className="input" inputMode="decimal" placeholder="Montant €" value={flow.amount} onChange={e => setFlow(f => ({ ...f, amount: e.target.value }))} style={{ width: '7.5rem' }} />
            <select className="input" value={flow.rule} onChange={e => setFlow(f => ({ ...f, rule: e.target.value, day: 1 }))} style={{ width: 'auto' }}>
              <option value="monthly">chaque mois, le</option>
              <option value="weekly">chaque semaine, le</option>
            </select>
            {flow.rule === 'monthly'
              ? <input className="input" type="number" min="1" max="31" value={flow.day} onChange={e => setFlow(f => ({ ...f, day: Math.max(1, Math.min(31, parseInt(e.target.value) || 1)) }))} style={{ width: '4.2rem' }} />
              : <select className="input" value={flow.day} onChange={e => setFlow(f => ({ ...f, day: Number(e.target.value) }))} style={{ width: 'auto' }}>
                  {[1, 2, 3, 4, 5, 6, 7].map(d => <option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>)}
                </select>}
            <button className="cap-btn-mini" disabled={!parseAmountToCents(flow.amount) || !flow.label.trim()} onClick={submitFlow}>Ajouter</button>
            <button className="cap-btn-mini" style={{ borderColor: 'transparent', color: 'var(--ink-fog)' }} onClick={() => setShowFlowForm(false)}>annuler</button>
          </div>
        )}
        {flows.length === 0 && !showFlowForm && <div style={{ fontSize: '0.82rem', color: 'var(--ink-fog)', fontStyle: 'italic' }}>Aucun flux récurrent.</div>}
        {flows.map(f => (
          <div key={f.id} className="money-line" style={{ opacity: f.until && f.until < todayISO() ? 0.5 : 1 }}>
            <span style={{ flex: 1 }}>🔁 {f.label} <span style={{ color: 'var(--ink-muted)', fontSize: '0.75rem' }}>· {f.rule === 'monthly' ? `le ${f.day} du mois` : `chaque ${WEEKDAY_LABELS[f.day]}`}{f.until ? ` · arrêté le ${formatDate(f.until)}` : ''}</span></span>
            <span className="mono" style={{ fontSize: '0.82rem' }}>{f.dir === 'in' ? '+' : '−'}{fmtEur(f.amount)}</span>
            {!f.until && <button className="cap-btn-mini" style={{ borderColor: 'transparent' }} title="Le flux s'arrête aujourd'hui ; l'historique reste compté" onClick={() => onStopFlow(f.id)}>arrêter</button>}
            <button className="btn-ghost" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-fog)', padding: '0.2rem' }} title="Supprimer (retire aussi l'historique)" onClick={() => onDeleteFlow(f.id)}><IconTrash size={12} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============ V4 4d : VASES COMMUNICANTS ============
// Temps réalisé sur [start, end] : réel pomodoro si mesuré, sinon durée estimée.
// Feuilles seulement (un parent à sous-tâches n'est pas compté en plus de ses sous-tâches).
function computeTimeSpent(items, caps, start, end) {
  const startTs = isoToDate(start).getTime(), endTs = isoToDate(addDays(end, 1)).getTime();
  const res = { total: 0, onCaps: 0, daily: 0, pillars: { energy: 0, money: 0, link: 0, alignment: 0, none: 0 }, up: 0, down: 0 };
  const add = (it, min) => {
    if (!min) return;
    res.total += min;
    const onCap = !!(it.capId && capPathById(caps, it.capId));
    if (onCap) res.onCaps += min; else res.daily += min;
    const ps = itemPillars(it, caps);
    if (!ps.length) res.pillars.none += min;
    ps.forEach(p => { if (res.pillars[p] !== undefined) res.pillars[p] += min; });
  };
  flattenItems(items).forEach(it => {
    if (it.subtasks && it.subtasks.length) return;
    if (it.recurrence || it.streak) {
      const per = durationToMinutes(it.duration);
      for (let d = start; d <= end; d = addDays(d, 1)) if (isOccurrenceCompleted(it, d)) add(it, per);
      return;
    }
    if (it.completed && it.completedAt >= startTs && it.completedAt < endTs) {
      add(it, it.actualMinutes || effectiveDurationMinutes(it));
      if (it.feel === 'up') res.up++;
      if (it.feel === 'down') res.down++;
    }
  });
  return res;
}
// V4 4f : prime time observé passivement. Fenêtre de 2 h où tu termines le plus de pomodoros,
// sur les 60 derniers jours. Rien avant ~10 sessions étalées sur au moins 2 semaines.
function computePrimeTime(focusLog, now = Date.now()) {
  const recent = (focusLog || []).filter(e => now - e.at < 60 * 86400000);
  if (recent.length < 10) return { ready: false, count: recent.length };
  const span = Math.max(...recent.map(e => e.at)) - Math.min(...recent.map(e => e.at));
  if (span < 14 * 86400000) return { ready: false, count: recent.length };
  const byHour = Array(24).fill(0);
  recent.forEach(e => { byHour[new Date(e.at - (e.min || 0) * 60000).getHours()]++; });
  // Heure de pointe, élargie à 2 h du côté du voisin le plus fourni
  const peak = byHour.indexOf(Math.max(...byHour));
  const from = (peak === 23 || (peak > 0 && byHour[peak - 1] > byHour[peak + 1])) ? peak - 1 : peak;
  return { ready: true, from, to: from + 2, hits: byHour[from] + byHour[from + 1], count: recent.length };
}
const fmtHours = (min) => { const m = Math.round(min || 0); if (m < 60) return `${m} min`; const h = Math.floor(m / 60), r = m % 60; return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`; };

function HBar({ label, value, max, color, hint }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div className="hbar-row" title={`${label} : ${fmtHours(value)}${hint ? ' — ' + hint : ''}`}>
      <span className="hbar-label">{label}</span>
      <span className="hbar-track"><span className="hbar-fill" style={{ width: `${pct}%`, background: color }} /></span>
      <span className="hbar-value">{fmtHours(value)}</span>
    </div>
  );
}

function FluxPanel({ state }) {
  const [kind, setKind] = useState('week');
  const [anchor, setAnchor] = useState(todayISO());
  const caps = state.caps || [];
  const r = periodRange(kind, anchor);
  const t = computeTimeSpent(state.items || [], caps, r.start, r.end);
  const money = moneyTotals(moneyLines(state.money, r.start, r.end));
  const checkins = {};
  for (let d = r.start; d <= r.end; d = addDays(d, 1)) { const c = (state.capacity || {})[d]; if (c && c.mode) checkins[c.mode] = (checkins[c.mode] || 0) + 1; }
  const quits = (state.quits || []);
  // Tendance : 8 semaines finissant sur la semaine de la période
  const lastWeekStart = weekRange(isoToDate(r.end)).start;
  const trend = Array.from({ length: 8 }, (_, i) => {
    const ws = addDays(lastWeekStart, -7 * (7 - i)), we = addDays(ws, 6);
    const w = computeTimeSpent(state.items || [], caps, ws, we);
    return { ws, onCaps: w.onCaps, daily: w.daily };
  });
  const trendMax = Math.max(1, ...trend.map(w => w.onCaps + w.daily));
  const pillarMax = Math.max(1, ...Object.values(t.pillars));
  const CAP_COLOR = 'var(--violet)', DAILY_COLOR = 'var(--ink-fog)';
  return (
    <div>
      <PeriodNav kind={kind} setKind={setKind} anchor={anchor} setAnchor={setAnchor} kinds={['week', 'month']} />

      <div className="stat-row">
        <div className="stat-tile"><div className="stat-label">Temps réalisé</div><div className="stat-value">{fmtHours(t.total)}</div><div className="stat-sub">réel mesuré, sinon estimé</div></div>
        <div className="stat-tile"><div className="stat-label">Sur tes caps</div><div className="stat-value">{fmtHours(t.onCaps)}</div><div className="stat-sub">le reste : {fmtHours(t.daily)} de quotidien</div></div>
        <div className="stat-tile"><div className="stat-label">Ressenti</div><div className="stat-value">☀️ {t.up} · 😴 {t.down}</div><div className="stat-sub">tâches notées à la complétion</div></div>
        <div className="stat-tile"><div className="stat-label">Argent · net</div><div className="stat-value">{money.net > 0 ? '+' : ''}{fmtEur(money.net)}</div><div className="stat-sub">{fmtEur(money.inc)} entrés · {fmtEur(money.out)} sortis</div></div>
      </div>

      <div className="flux-card">
        <div className="flux-title">Le quotidien et le long terme</div>
        <div className="flux-hint">Le quotidien crie, le rêve attend. Ici, juste ce qui s'est passé.</div>
        <HBar label="Sur tes caps" value={t.onCaps} max={Math.max(1, t.onCaps, t.daily)} color={CAP_COLOR} />
        <HBar label="Quotidien" value={t.daily} max={Math.max(1, t.onCaps, t.daily)} color={DAILY_COLOR} />
      </div>

      <div className="flux-card">
        <div className="flux-title">Temps par pilier</div>
        <div className="flux-hint">Une tâche qui sert deux piliers compte dans les deux. Piliers hérités du cap si la tâche n'en a pas.</div>
        {PILLARS.map(p => <HBar key={p.id} label={p.label} value={t.pillars[p.id]} max={pillarMax} color={p.color} />)}
        <HBar label="Sans pilier" value={t.pillars.none} max={pillarMax} color="var(--line)" />
        <div className="flux-hint" style={{ marginTop: '0.5rem' }}>Sens (Lien + Alignement) : {fmtHours(t.pillars.link + t.pillars.alignment)}</div>
      </div>

      <div className="flux-card">
        <div className="flux-title">Énergie</div>
        {Object.keys(checkins).length === 0
          ? <div className="flux-hint">Pas de check-in sur la période.</div>
          : <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
              {ENERGY_PRESETS.filter(p => checkins[p.id]).map(p => <span key={p.id} className="chip">{p.emoji} {p.label} · {checkins[p.id]} j</span>)}
              {checkins.custom && <span className="chip">⚓ Au feeling · {checkins.custom} j</span>}
            </div>}
        {(() => {
          const pt = computePrimeTime(state.focusLog);
          return (
            <div style={{ marginTop: '0.6rem', fontSize: '0.8rem', color: pt.ready ? 'var(--ink-soft)' : 'var(--ink-fog)' }}>
              {pt.ready
                ? <>🕘 Tu démarres le plus souvent tes pomodoros entre <strong>{pt.from} h et {pt.to} h</strong> ({pt.hits} sur {pt.count}, 60 derniers jours). Une observation, pas une consigne.</>
                : <>🕘 Ton « prime time » apparaîtra ici après une dizaine de pomodoros sur deux semaines ({pt.count} pour l'instant).</>}
            </div>
          );
        })()}
        {quits.length > 0 && (
          <div style={{ marginTop: '0.6rem', fontSize: '0.8rem', color: 'var(--ink-soft)' }}>
            Ce que tu arrêtes : {quits.map(q => `${q.title} (${quitStreak(q)} j sans)`).join(' · ')}
          </div>
        )}
      </div>

      <div className="flux-card">
        <div className="flux-title">Tendance · 8 semaines</div>
        <div className="flux-legend">
          <span><span className="legend-swatch" style={{ background: CAP_COLOR }} /> Sur tes caps</span>
          <span><span className="legend-swatch" style={{ background: DAILY_COLOR }} /> Quotidien</span>
        </div>
        <div className="trend">
          {trend.map(w => {
            const hCap = (w.onCaps / trendMax) * 100, hDaily = (w.daily / trendMax) * 100;
            return (
              <div key={w.ws} className="trend-col" title={`Semaine du ${formatDate(w.ws)}\nSur tes caps : ${fmtHours(w.onCaps)}\nQuotidien : ${fmtHours(w.daily)}`}>
                <div className="trend-stack">
                  {w.daily > 0 && <span style={{ height: `${hDaily}%`, background: DAILY_COLOR }} />}
                  {w.onCaps > 0 && <span style={{ height: `${hCap}%`, background: CAP_COLOR }} />}
                </div>
                <div className="trend-label">{isoToDate(w.ws).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</div>
              </div>
            );
          })}
        </div>
        <details style={{ marginTop: '0.6rem' }}>
          <summary style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', cursor: 'pointer' }}>Voir en tableau</summary>
          <table className="flux-table">
            <thead><tr><th>Semaine du</th><th>Sur tes caps</th><th>Quotidien</th></tr></thead>
            <tbody>{trend.map(w => <tr key={w.ws}><td>{formatDate(w.ws)}</td><td>{fmtHours(w.onCaps)}</td><td>{fmtHours(w.daily)}</td></tr>)}</tbody>
          </table>
        </details>
      </div>
    </div>
  );
}

// V4 4c/4d : onglet Piliers — vases communicants (4d) + argent (4c)
function PiliersView(props) {
  const [tab, setTab] = useState(props.initialTab || 'flux');
  return (
    <div style={{ maxWidth: '860px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <div>
          <h2 className="display" style={{ margin: 0, fontSize: '1.6rem', fontWeight: 500, fontStyle: 'italic' }}>Piliers</h2>
          <p style={{ margin: '0.2rem 0 0', fontSize: '0.82rem', color: 'var(--ink-muted)' }}>Temps, énergie, argent, sens : voir les vases communicants. Des faits, pas un score.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.25rem' }}>
          <button className={`cap-btn-mini ${tab === 'flux' ? 'active-mini' : ''}`} onClick={() => setTab('flux')}>Vases communicants</button>
          <button className={`cap-btn-mini ${tab === 'money' ? 'active-mini' : ''}`} onClick={() => setTab('money')}>Argent</button>
        </div>
      </div>
      {tab === 'money' && <MoneyPanel {...props.moneyProps} />}
      {tab === 'flux' && <FluxPanel {...props.fluxProps} />}
    </div>
  );
}

function CapModal({ mode, node, visions, activeObjectiveCount, onClose, onSave }) {
  const isObjective = mode === 'objective';
  const isEdit = !!node;
  const [form, setForm] = useState({
    title: node?.title || '',
    why: node?.why || '',
    deliverable: node?.deliverable || '',
    deadline: node?.deadline || '',
    visionLink: node?.visionLink || '',
    measureMode: node?.measure?.mode || 'none',
    measureTarget: node?.measure?.target ?? '',
    measureUnit: node?.measure?.unit || '',
    measureCurrent: node?.measure?.current ?? '',
    status: node?.status || 'active',
    pillars: node?.pillars || [],
  });
  const [titleError, setTitleError] = useState(false);
  const [whyError, setWhyError] = useState(false);
  const [shake, setShake] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = () => {
    if (!form.title.trim()) { setTitleError(true); setShake(true); setTimeout(() => setShake(false), 400); return; }
    // why obligatoire uniquement sur l'objectif (racine de la confrontation) ; optionnel sur projet/jalon
    if (isObjective && !form.why.trim()) { setWhyError(true); setShake(true); setTimeout(() => setShake(false), 400); return; }
    setTitleError(false); setWhyError(false);
    let measure = null;
    if (form.measureMode === 'binary') measure = { mode: 'binary' };
    else if (form.measureMode === 'numeric') measure = { mode: 'numeric', target: form.measureTarget === '' ? null : Number(form.measureTarget), unit: form.measureUnit || '', current: form.measureCurrent === '' ? 0 : Number(form.measureCurrent) };
    const base = {
      title: form.title.trim(),
      why: form.why.trim(),
      deadline: form.deadline || null,
      status: form.status,
      measure,
      pillars: form.pillars,
    };
    if (isObjective) {
      onSave({ ...base, visionLink: form.visionLink || null });
    } else {
      onSave({ ...base, deliverable: form.deliverable.trim() });
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); handleSave(); }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className={`modal ${shake ? 'modal-shake' : ''}`} onClick={e => e.stopPropagation()} onKeyDown={handleKey} style={{ maxWidth: '520px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <h2 className="display" style={{ margin: 0, fontSize: '1.4rem', fontWeight: 500, fontStyle: 'italic' }}>
            {isEdit ? 'Modifier' : isObjective ? 'Nouvel objectif' : 'Nouveau projet / jalon'}
          </h2>
          <button className="btn-ghost" style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '0.3rem' }} onClick={onClose}><IconX size={18} /></button>
        </div>

        {!isEdit && isObjective && activeObjectiveCount >= 3 && (
          <div style={{ fontSize: '0.78rem', color: 'var(--ochre)', background: 'rgba(196,135,41,0.1)', border: '1px solid var(--ochre)', borderRadius: '3px', padding: '0.5rem 0.7rem', marginBottom: '1rem' }}>
            Déjà {activeObjectiveCount} objectifs actifs. Rien n'est bloqué, mais un cerveau qui vise partout n'avance nulle part.
          </div>
        )}

        <div style={{ marginBottom: '1rem' }}>
          <Label>Titre</Label>
          <input className={`input ${titleError ? 'input-error' : ''}`} value={form.title} onChange={e => { set('title', e.target.value); setTitleError(false); }} placeholder={isObjective ? 'Le résultat visé (~3 mois)' : 'Le levier'} autoFocus />
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <Label>{isObjective ? 'Pourquoi (court, obligatoire)' : 'Pourquoi (optionnel)'}</Label>
          <input className={`input ${whyError ? 'input-error' : ''}`} value={form.why} onChange={e => { set('why', e.target.value); setWhyError(false); }} placeholder={isObjective ? 'Ce qui donne du sens à ce cap' : 'Le pourquoi de ce levier, si pas évident'} />
          {whyError && <div style={{ fontSize: '0.72rem', color: 'var(--rust)', marginTop: '0.25rem' }}>Le « pourquoi » est la racine de la confrontation — sur l'objectif, même court, il est requis.</div>}
        </div>

        {!isObjective && (
          <div style={{ marginBottom: '1rem' }}>
            <Label>Livrable</Label>
            <input className="input" value={form.deliverable} onChange={e => set('deliverable', e.target.value)} placeholder="Le livrable concret (ce qui prouve que c'est fait)" />
          </div>
        )}

        <div style={{ marginBottom: '1rem' }}>
          <Label>Échéance {isObjective ? '(~90j, indicative)' : ''}</Label>
          <input type="date" className="input" value={form.deadline || ''} onChange={e => set('deadline', e.target.value)} />
          <div style={{ fontSize: '0.72rem', color: 'var(--ink-fog)', marginTop: '0.25rem' }}>Un cap n'est jamais « en retard ». L'échéance sert au tempo, pas à la culpabilité.</div>
        </div>

        {isObjective && (
          <div style={{ marginBottom: '1rem' }}>
            <Label>Rattacher à une vision</Label>
            <select className="input" value={form.visionLink} onChange={e => set('visionLink', e.target.value)}>
              <option value="">— Aucune —</option>
              {visions.map(v => <option key={v.id} value={v.id}>{(v.text.split('\n')[0] || 'Vision sans titre').slice(0, 50)}</option>)}
            </select>
          </div>
        )}

        <div style={{ marginBottom: '1rem' }}>
          <Label>Piliers servis (facultatif)</Label>
          <PillarPicker value={form.pillars} onChange={v => set('pillars', v)} />
          <div style={{ fontSize: '0.72rem', color: 'var(--ink-fog)', marginTop: '0.25rem' }}>Les tâches rattachées en héritent, sans rien taguer de plus.</div>
        </div>

        <div style={{ marginBottom: '1rem' }}>
          <Label>Mesure (optionnelle)</Label>
          <select className="input" value={form.measureMode} onChange={e => set('measureMode', e.target.value)}>
            <option value="none">Aucune</option>
            <option value="binary">Atteint / pas atteint</option>
            <option value="numeric">Cible chiffrée</option>
          </select>
          {form.measureMode === 'numeric' && (
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <input className="input" type="number" value={form.measureCurrent} onChange={e => set('measureCurrent', e.target.value)} placeholder="actuel" style={{ flex: 1 }} />
              <span style={{ alignSelf: 'center', color: 'var(--ink-muted)' }}>/</span>
              <input className="input" type="number" value={form.measureTarget} onChange={e => set('measureTarget', e.target.value)} placeholder="cible" style={{ flex: 1 }} />
              <input className="input" value={form.measureUnit} onChange={e => set('measureUnit', e.target.value)} placeholder="unité" style={{ flex: 1 }} />
            </div>
          )}
          <div style={{ fontSize: '0.72rem', color: 'var(--ink-fog)', marginTop: '0.25rem' }}>Indicatif seulement — jamais de barre auto ni de franchissement automatique. Franchir reste un acte manuel.</div>
        </div>

        {isEdit && (
          <div style={{ marginBottom: '1rem' }}>
            <Label>Statut</Label>
            <select className="input" value={form.status} onChange={e => set('status', e.target.value)}>
              <option value="active">Actif</option>
              <option value="reached">{isObjective ? 'Atteint' : 'Franchi / terminé'}</option>
              <option value="paused">En pause</option>
              <option value="abandoned">Abandonné</option>
            </select>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1.5rem' }}>
          <button className="btn" onClick={onClose}>Annuler</button>
          <button className="btn btn-rust" onClick={handleSave}><IconCheck size={14} /> Enregistrer</button>
        </div>
      </div>
    </div>
  );
}

function ItemModal({ item, parentId, parentItem, categories, caps = [], visions = [], onClose, onSave, onDelete, onAddCategory, occurrenceDate, initialData, isDone, onMarkDone, onDuplicate }) {
  // Pour une nouvelle sous-tâche, hériter de la config du parent (sauf titre/dates/durée)
  const inheritFromParent = parentItem && !item;
  // initialData : prefill venant de QuickAddModal (champs déjà saisis), prioritaire sur l'héritage parent et sur les défauts
  const pre = initialData || {};

  // V3 S5 : plus de type 'habit' — toujours 'task'. On garde le champ pour rétrocompatibilité.
  const initialType = 'task';

  // V3 S5 : récurrence existante préservée. Plus d'auto-init pour habitude.
  const initialRecurrence = (item?.recurrence !== undefined && item?.recurrence !== null) ? item.recurrence : null;

  const [form, setForm] = useState({
    title: item?.title || pre.title || '',
    type: initialType,
    categoryId: item?.categoryId !== undefined ? item.categoryId : (pre.categoryId !== undefined ? pre.categoryId : (inheritFromParent ? parentItem.categoryId : '')),
    icon: item?.icon || pre.icon || '',
    date: item?.date !== undefined && item?.date !== '' ? item.date : (pre.date || (inheritFromParent ? (parentItem.date || '') : '')),
    time: item?.time !== undefined && item?.time !== '' ? item.time : (pre.time || (inheritFromParent ? (parentItem.time || '') : '')),
    reminder: item?.reminder || pre.reminder || '',
    priority: item?.priority !== undefined ? item.priority : (pre.priority !== undefined ? pre.priority : (inheritFromParent ? parentItem.priority : (parentId ? null : 'inbox'))),
    notes: item?.notes || pre.notes || '',
    energy: item?.energy || pre.energy || (inheritFromParent ? parentItem.energy : 'medium'),
    duration: item?.duration || pre.duration || (item ? { minutes: 0 } : { minutes: 5 }),
    durationManualOverride: item?.durationManualOverride || false,
    deadline: item?.deadline !== undefined && item?.deadline !== null ? item.deadline : (pre.deadline !== undefined ? pre.deadline : (inheritFromParent ? (parentItem.deadline || null) : null)),
    recurrence: initialRecurrence,
    isImportant: item?.isImportant !== undefined ? item.isImportant : (pre.isImportant || false), // V3 S4 : flag visibilité
    // V3 S4.5 : préparation + trajet (n'ont d'effet que si isImportant + time)
    prepDuration: item?.prepDuration ?? pre.prepDuration ?? null,
    travelDuration: item?.travelDuration ?? pre.travelDuration ?? null,
    travelReturn: item?.travelReturn ?? pre.travelReturn ?? false,
    travelReturnDuration: item?.travelReturnDuration ?? pre.travelReturnDuration ?? null, // V5
    // V3 S5 : streak (suivre la régularité)
    streak: item?.streak === true,
    // V3 S(D) : créneaux multiples par jour pour routines. Pré-rempli depuis times, sinon depuis l'heure unique.
    times: (item?.times && item.times.length) ? [...item.times] : ((item?.streak && item?.time) ? [item.time] : []),
    // V4 4a.1 : filiation cap. Sous-tâche hérite du capId du parent ; sinon prefill ou existant.
    capId: item?.capId !== undefined ? item.capId : (pre.capId !== undefined ? pre.capId : (inheritFromParent ? (parentItem.capId || null) : null)),
    pillars: item?.pillars || pre.pillars || [], // V4 4b
    // history conservé tel quel via le passthrough handleSave
  });
  const [showAddCat, setShowAddCat] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatColor, setNewCatColor] = useState('#B8482E');

  const COLOR_OPTIONS = ['#B8482E', '#2C5F7C', '#C68729', '#5C7A3E', '#6B4E8A', '#D97A5E', '#3D8B7A', '#A8456B'];
  const ICON_OPTIONS = ['', '📚', '💼', '🏃', '🍳', '🎨', '🎵', '💻', '☕', '🌿', '🧘', '📞', '🛒', '📝', '🚿', '💊'];

  const hasSubtasks = item?.subtasks && item.subtasks.length > 0;
  const subtaskSum = hasSubtasks ? item.subtasks.reduce((s, st) => s + effectiveDurationMinutes(st), 0) : 0;
  // Si l'item a des sous-tâches et pas d'override, on désactive l'édition durée et on affiche la somme
  const durationLocked = hasSubtasks && !form.durationManualOverride;

  // V3 S4 : flags d'erreur pour highlight visuel
  const [titleError, setTitleError] = useState(false);
  const [importantError, setImportantError] = useState(false);
  const [shake, setShake] = useState(false);

  const triggerShake = () => {
    setShake(true);
    setTimeout(() => setShake(false), 400);
  };

  const handleSave = () => {
    // Validation titre
    if (!form.title.trim()) {
      setTitleError(true);
      triggerShake();
      return;
    }
    // V3 S4 : Important nécessite date+heure OU deadline (ou récurrence avec heure)
    if (form.isImportant) {
      const hasDateTime = (form.date && form.time) || (form.recurrence && form.time);
      const hasDeadline = !!form.deadline;
      if (!hasDateTime && !hasDeadline) {
        setImportantError(true);
        triggerShake();
        return;
      }
    }
    setTitleError(false);
    setImportantError(false);
    let finalDuration = (form.duration?.weeks || form.duration?.days || form.duration?.hours || form.duration?.minutes) ? form.duration : null;
    if (durationLocked) finalDuration = null;
    // V3 S(D) : normaliser les créneaux d'une routine. ≥2 → multi-créneaux ; sinon heure unique classique.
    let outTimes = [];
    let outTime = form.time;
    if (form.streak && form.recurrence && !isFloatingRecurrence(form.recurrence)) {
      const cleaned = [...new Set((form.times || []).filter(Boolean))].sort();
      if (cleaned.length >= 2) { outTimes = cleaned; outTime = cleaned[0]; }
      else { outTimes = []; outTime = cleaned[0] || ''; }
    }
    onSave({
      ...form,
      time: outTime,
      times: outTimes,
      duration: finalDuration,
      deadline: form.deadline || null,
    });
  };

  const totalMin = durationToMinutes(form.duration);
  const shouldSuggestBreakdown = !durationLocked && totalMin > 25 && !hasSubtasks;

  // Détermine quelle "preset" de récurrence est sélectionnée pour le select
  const recurrencePreset = (() => {
    const r = form.recurrence;
    if (!r) return 'none';
    if (r.rule === 'daily' && r.interval === 1) return 'daily';
    if (r.rule === 'weekly' && r.interval === 1 && r.weekdays?.length === 5 && r.weekdays.every(d => d >= 1 && d <= 5)) return 'weekdays';
    if (r.rule === 'weekly' && r.interval === 1 && r.weekdays?.length === 1) return 'weekly';
    if (r.rule === 'monthly' && r.interval === 1) return 'monthly';
    if (r.rule === 'yearly' && r.interval === 1) return 'yearly';
    if (r.rule === 'floatingWeekly') return 'floatingWeekly';
    if (r.rule === 'floatingMonthly') return 'floatingMonthly';
    return 'custom';
  })();

  const setRecurrencePreset = (preset) => {
    if (preset === 'none') return setForm(f => ({ ...f, recurrence: null }));
    // Activer une récurrence vide la date d'exécution (incohérent d'avoir les deux).
    // L'heure est conservée (cohérent : même heure pour toutes les occurrences).
    const clearDate = (f) => ({ ...f, date: '' });
    if (preset === 'daily') return setForm(f => ({ ...clearDate(f), recurrence: { rule: 'daily', interval: 1, weekdays: [], monthDay: null, endDate: null, endAfter: null } }));
    if (preset === 'weekdays') return setForm(f => ({ ...clearDate(f), recurrence: { rule: 'weekly', interval: 1, weekdays: [1,2,3,4,5], monthDay: null, endDate: null, endAfter: null } }));
    if (preset === 'weekly') {
      const today = new Date(); const dow = today.getDay();
      return setForm(f => ({ ...clearDate(f), recurrence: { rule: 'weekly', interval: 1, weekdays: [dow], monthDay: null, endDate: null, endAfter: null } }));
    }
    if (preset === 'monthly') {
      const today = new Date();
      return setForm(f => ({ ...clearDate(f), recurrence: { rule: 'monthly', interval: 1, weekdays: [], monthDay: today.getDate(), endDate: null, endAfter: null } }));
    }
    // V3 S5.5 : récurrence annuelle (mêmes jour+mois chaque année)
    if (preset === 'yearly') {
      const today = new Date();
      return setForm(f => ({ ...clearDate(f), recurrence: { rule: 'yearly', interval: 1, weekdays: [], monthDay: today.getDate(), month: today.getMonth(), endDate: null, endAfter: null } }));
    }
    // V3 S5 : récurrences flottantes (jours libres)
    if (preset === 'floatingWeekly') {
      // Les flottantes vident aussi l'heure (pas de créneau fixe)
      return setForm(f => ({ ...clearDate(f), time: '', recurrence: { rule: 'floatingWeekly', count: 3, interval: 1, weekdays: [], monthDay: null, endDate: null, endAfter: null } }));
    }
    if (preset === 'floatingMonthly') {
      return setForm(f => ({ ...clearDate(f), time: '', recurrence: { rule: 'floatingMonthly', count: 4, interval: 1, weekdays: [], monthDay: null, endDate: null, endAfter: null } }));
    }
    if (preset === 'custom') {
      return setForm(f => ({ ...clearDate(f), recurrence: f.recurrence ? { ...f.recurrence } : { rule: 'weekly', interval: 1, weekdays: [1], monthDay: null, endDate: null, endAfter: null } }));
    }
  };

  // V3 S4 : Entrée appelle handleSave qui gère validation + shake
  const handleModalKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      const tag = e.target.tagName;
      if (tag === 'TEXTAREA') return; // textarea = retour ligne
      if (e.target.isContentEditable) return;
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className={`modal ${shake ? 'modal-shake' : ''}`} onClick={e => e.stopPropagation()} onKeyDown={handleModalKeyDown}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <h2 className="display" style={{ margin: 0, fontSize: '1.5rem', fontWeight: 500, fontStyle: 'italic' }}>
            {item ? 'Modifier' : parentId ? 'Nouvelle sous-tâche' : 'Nouvel item'}
          </h2>
          <button className="btn-ghost" style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '0.3rem' }} onClick={onClose}><IconX size={18} /></button>
        </div>
        {occurrenceDate && (
          <div style={{ background: 'rgba(44,95,124,0.08)', border: '1px solid var(--ocean)', color: 'var(--ocean)', padding: '0.5rem 0.75rem', borderRadius: '3px', fontSize: '0.78rem', marginBottom: '1rem' }}>
            🔁 Tu édites une occurrence du {formatDate(occurrenceDate)} d'un item récurrent. Au moment d'enregistrer, tu pourras choisir si la modif touche cette occurrence, les futures, ou toute la série.
          </div>
        )}

        {/* V3 S5 : suppression du sélecteur Type — fusion habitude / tâche récurrente.
            Pour suivre la régularité (streak), voir le toggle dans la section Récurrence. */}

        {/* V3 S(A+B) : case Terminé — valide/archive sans repasser par la liste (édition uniquement) */}
        {item && onMarkDone && (
          <div
            onClick={onMarkDone}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '1rem', padding: '0.5rem 0.6rem', border: '1px solid ' + (isDone ? 'var(--moss)' : 'var(--line)'), borderRadius: '3px', background: isDone ? 'rgba(92,122,62,0.1)' : 'transparent' }}
          >
            <div className={`checkbox ${isDone ? 'checked' : ''}`}>{isDone && <IconCheck size={11} strokeWidth={3} />}</div>
            <span style={{ fontSize: '0.85rem', color: isDone ? 'var(--moss)' : 'var(--ink)', fontWeight: 500 }}>
              {isDone ? 'Terminé' : 'Marquer comme terminé'}
            </span>
          </div>
        )}

        <Label>Titre</Label>
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
          <select className="input" style={{ width: '60px', textAlign: 'center', padding: '0.4rem' }} value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))}>
            {ICON_OPTIONS.map(i => <option key={i} value={i}>{i || '—'}</option>)}
          </select>
          <input className={`input ${titleError ? 'input-error' : ''}`} value={form.title} onChange={e => { setForm(f => ({ ...f, title: e.target.value })); if (titleError) setTitleError(false); }} placeholder="Que veux-tu faire ?" autoFocus />
        </div>

        {!parentId && (
          <>
            <Label>Priorité</Label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '0.4rem', marginBottom: '1rem' }}>
              <button className={form.priority === 'must' ? 'btn btn-primary' : 'btn'} onClick={() => setForm(f => ({ ...f, priority: 'must' }))} style={{ fontSize: '0.8rem', justifyContent: 'center' }}>Must</button>
              <button className={form.priority === 'should' ? 'btn btn-primary' : 'btn'} onClick={() => setForm(f => ({ ...f, priority: 'should' }))} style={{ fontSize: '0.8rem', justifyContent: 'center' }}>Should</button>
              <button className={form.priority === 'want' ? 'btn btn-primary' : 'btn'} onClick={() => setForm(f => ({ ...f, priority: 'want' }))} style={{ fontSize: '0.8rem', justifyContent: 'center' }}>Want</button>
              <button className={form.priority === 'inbox' ? 'btn btn-primary' : 'btn'} onClick={() => setForm(f => ({ ...f, priority: 'inbox' }))} style={{ fontSize: '0.8rem', justifyContent: 'center' }}>Boîte</button>
            </div>
          </>
        )}

        <Label>Catégorie</Label>
        <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <button className={form.categoryId === '' ? 'btn btn-primary' : 'btn'} onClick={() => setForm(f => ({ ...f, categoryId: '' }))} style={{ fontSize: '0.75rem' }}>Aucune</button>
          {categories.map(c => (
            <button key={c.id} className={form.categoryId === c.id ? 'btn btn-primary' : 'btn'} onClick={() => setForm(f => ({ ...f, categoryId: c.id }))} style={{ fontSize: '0.75rem', borderColor: c.color }}>
              <span className="cat-dot" style={{ background: c.color }} /> {c.name}
            </button>
          ))}
          <button className="btn btn-ghost" onClick={() => setShowAddCat(!showAddCat)} style={{ fontSize: '0.75rem', background: 'transparent' }}><IconPlus size={12} /> Nouvelle</button>
        </div>
        {showAddCat && (
          <div style={{ marginBottom: '1rem', padding: '0.75rem', background: 'var(--paper-2)', borderRadius: '3px' }}>
            <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.5rem' }}>
              <input className="input" placeholder="Nom de catégorie" value={newCatName} onChange={e => setNewCatName(e.target.value)} />
            </div>
            <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
              {COLOR_OPTIONS.map(c => (
                <div key={c} className={`color-swatch ${newCatColor === c ? 'selected' : ''}`} style={{ background: c }} onClick={() => setNewCatColor(c)} />
              ))}
            </div>
            <button className="btn btn-rust" style={{ fontSize: '0.8rem' }} onClick={() => {
              if (!newCatName.trim()) return;
              const cat = { id: 'cat-' + generateId(), name: newCatName.trim(), color: newCatColor };
              onAddCategory(cat);
              setForm(f => ({ ...f, categoryId: cat.id }));
              setNewCatName(''); setShowAddCat(false);
            }}>Créer</button>
          </div>
        )}

        <Label>Énergie requise</Label>
        <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '1rem' }}>
          {['low', 'medium', 'high'].map(e => (
            <button key={e} className={form.energy === e ? 'btn btn-primary' : 'btn'} onClick={() => setForm(f => ({ ...f, energy: e }))} style={{ flex: 1, justifyContent: 'center', fontSize: '0.8rem' }}>{energyLabel(e)}</button>
          ))}
        </div>

        {/* DATE & HEURE — V3 S5 : si pas de récurrence : date+heure ; si récurrence : juste heure */}
        {!form.recurrence && (
          <>
            <Label>Date & heure d'exécution</Label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.4rem' }}>
              <input type="date" className="input" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
              <TimeInput value={form.time} onChange={(t) => setForm(f => ({ ...f, time: t }))} style={{ width: '100%' }} />
            </div>
            {(form.date || form.time) && (
              <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '1rem', justifyContent: 'flex-end' }}>
                {form.date && <button className="btn-ghost" style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, textDecoration: 'underline' }} onClick={() => setForm(f => ({ ...f, date: '' }))}>retirer date</button>}
                {form.time && <button className="btn-ghost" style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, textDecoration: 'underline' }} onClick={() => setForm(f => ({ ...f, time: '' }))}>retirer heure</button>}
                {form.date && form.time && <button className="btn-ghost" style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, textDecoration: 'underline' }} onClick={() => setForm(f => ({ ...f, date: '', time: '' }))}>retirer les deux</button>}
              </div>
            )}
            {!form.date && !form.time && <div style={{ marginBottom: '1rem' }} />}
          </>
        )}
        {form.recurrence && !isFloatingRecurrence(form.recurrence) && !form.streak && (
          <>
            <Label>Heure (optionnelle)</Label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.4rem' }}>
              <TimeInput value={form.time} onChange={(t) => setForm(f => ({ ...f, time: t }))} />
              {form.time && <button className="btn-ghost" style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', border: 'none', background: 'transparent', cursor: 'pointer' }} onClick={() => setForm(f => ({ ...f, time: '' }))}>retirer</button>}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginBottom: '0.5rem', fontStyle: 'italic' }}>
              {form.time ? `Chaque occurrence sera planifiée à ${form.time}.` : `Sans heure, les occurrences apparaîtront dans la zone "À planifier" de l'agenda.`}
            </div>
            <button
              className="btn-ghost"
              style={{ fontSize: '0.78rem', color: 'var(--ochre)', border: '1px dashed var(--ochre)', background: 'transparent', cursor: 'pointer', borderRadius: '3px', padding: '0.25rem 0.5rem', marginBottom: '1rem' }}
              onClick={() => setForm(f => ({ ...f, streak: true, times: [f.time || '', ''] }))}
              title="Ex. médoc 8h / 14h / 20h — chaque prise cochable séparément"
            >+ Plusieurs fois par jour (routine)</button>
          </>
        )}
        {form.recurrence && !isFloatingRecurrence(form.recurrence) && form.streak && (
          <>
            <Label>Créneaux du jour</Label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '0.5rem' }}>
              {(form.times.length ? form.times : ['']).map((t, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <TimeInput
                    value={t}
                    onChange={(nv) => setForm(f => {
                      const base = f.times.length ? [...f.times] : [''];
                      base[idx] = nv;
                      return { ...f, times: base };
                    })}
                  />
                  {(form.times.length > 1) && (
                    <button className="btn-ghost" style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', border: 'none', background: 'transparent', cursor: 'pointer' }} onClick={() => setForm(f => ({ ...f, times: f.times.filter((_, i) => i !== idx) }))}>retirer</button>
                  )}
                </div>
              ))}
            </div>
            <button
              className="btn-ghost"
              style={{ fontSize: '0.78rem', color: 'var(--ochre)', border: '1px dashed var(--ochre)', background: 'transparent', cursor: 'pointer', borderRadius: '3px', padding: '0.25rem 0.5rem', marginBottom: '0.4rem' }}
              onClick={() => setForm(f => {
                const base = f.times.length ? [...f.times] : (f.time ? [f.time] : []);
                base.push('');
                return { ...f, times: base };
              })}
            >+ Ajouter un créneau</button>
            <div style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginBottom: '1rem', fontStyle: 'italic', lineHeight: 1.4 }}>
              {form.times.filter(Boolean).length >= 2
                ? `${form.times.filter(Boolean).length} prises/jour — chacune cochable séparément. Le jour ne compte pour le streak que si toutes sont faites.`
                : `Une seule heure = routine classique. Ajoute un 2ᵉ créneau pour répéter plusieurs fois par jour (ex. médoc 8h / 14h / 20h).`}
            </div>
          </>
        )}
        {form.recurrence && isFloatingRecurrence(form.recurrence) && (
          <div style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginBottom: '1rem', fontStyle: 'italic' }}>
            Récurrence flottante : pas de jour ni d'heure fixe. À caser librement dans la période.
          </div>
        )}

        {/* DEADLINE — V3 S5 : pas pour les routines (streak) */}
        {!form.streak && (
          <>
            <Label>Échéance</Label>
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.4rem' }}>
              <input type="date" className="input" value={form.deadline || ''} onChange={e => setForm(f => ({ ...f, deadline: e.target.value || null }))} style={{ flex: 1 }} />
              {form.deadline && <button className="btn-ghost" style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', border: 'none', background: 'transparent', cursor: 'pointer' }} onClick={() => setForm(f => ({ ...f, deadline: null }))}>retirer</button>}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginBottom: '1rem', fontStyle: 'italic' }}>
              Date limite à respecter (≠ date d'exécution).
            </div>
          </>
        )}

        {/* RÉCURRENCE — V3 S5 : sélecteur unique avec floating */}
        <Label>Récurrence</Label>
        <div style={{ marginBottom: '1rem' }}>
          <select className="input" value={recurrencePreset} onChange={e => setRecurrencePreset(e.target.value)} style={{ marginBottom: '0.5rem' }}>
            <option value="none">Aucune (tâche unique)</option>
            <option value="daily">Quotidien</option>
            <option value="weekdays">Lun-Ven</option>
            <option value="weekly">Hebdomadaire</option>
            <option value="monthly">Mensuel</option>
            <option value="yearly">Annuel</option>
            <option value="floatingWeekly">N fois par semaine (jours libres)</option>
            <option value="floatingMonthly">N fois par mois (jours libres)</option>
            <option value="custom">Personnalisé</option>
          </select>

          {form.recurrence && !isFloatingRecurrence(form.recurrence) && (
            <RecurrenceOptions value={form.recurrence} preset={recurrencePreset} onChange={(r) => setForm(f => ({ ...f, recurrence: r }))} />
          )}
          {form.recurrence && isFloatingRecurrence(form.recurrence) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem', background: 'var(--paper-2)', borderRadius: '3px' }}>
              <span style={{ fontSize: '0.8rem' }}>Objectif :</span>
              <input
                type="number" min="1" max="30" step="1"
                value={form.recurrence.count || 1}
                onChange={e => {
                  const n = Math.max(1, Math.min(30, parseInt(e.target.value, 10) || 1));
                  setForm(f => ({ ...f, recurrence: { ...f.recurrence, count: n } }));
                }}
                style={{ width: '60px', padding: '0.3rem', fontSize: '0.85rem', border: '1px solid var(--line)', borderRadius: '3px', background: 'var(--paper)', color: 'var(--ink)' }}
              />
              <span style={{ fontSize: '0.8rem', color: 'var(--ink-muted)' }}>fois par {form.recurrence.rule === 'floatingWeekly' ? 'semaine' : 'mois'}</span>
            </div>
          )}

          {/* V3 S5 : toggle "Suivre la régularité" — visible uniquement si récurrence active */}
          {form.recurrence && (
            <div style={{ marginTop: '0.75rem', padding: '0.6rem 0.75rem', background: form.streak ? 'rgba(196,135,41,0.08)' : 'transparent', border: '1px solid ' + (form.streak ? 'var(--ochre)' : 'var(--line)'), borderRadius: '3px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', fontSize: '0.85rem' }}>
                <input
                  type="checkbox"
                  checked={form.streak}
                  onChange={(e) => setForm(f => ({ ...f, streak: e.target.checked }))}
                  style={{ cursor: 'pointer' }}
                />
                <span style={{ fontWeight: form.streak ? 600 : 400 }}>Suivre la régularité (routine)</span>
              </label>
              {!form.streak && (
                <div style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginTop: '0.3rem', fontStyle: 'italic', paddingLeft: '1.5rem' }}>
                  Active pour suivre ta régularité (compteur, flamme).
                </div>
              )}
              {form.streak && (
                <div style={{ fontSize: '0.7rem', color: 'var(--ochre)', marginTop: '0.3rem', paddingLeft: '1.5rem' }}>
                  🔥 Routine — apparaîtra dans l'onglet Routines avec compteur et flamme.
                </div>
              )}
            </div>
          )}
        </div>

        {/* DURÉE */}
        <Label>Durée estimée {durationLocked && <span style={{ textTransform: 'none', letterSpacing: 0, fontStyle: 'italic', color: 'var(--ink-muted)' }}>· auto = somme des sous-tâches</span>}</Label>
        {durationLocked ? (
          <div style={{ marginBottom: '1rem' }}>
            <div style={{ padding: '0.6rem 0.75rem', background: 'var(--paper-2)', border: '1px dashed var(--line)', borderRadius: '3px', fontSize: '0.85rem', color: 'var(--ink-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>∑ {fmtMin(subtaskSum) || '—'}</span>
              <button className="btn-ghost" style={{ fontSize: '0.7rem', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-muted)', textDecoration: 'underline' }} onClick={() => setForm(f => ({ ...f, durationManualOverride: true, duration: minutesToDuration(subtaskSum) || { minutes: 0 } }))}>
                Forcer manuellement
              </button>
            </div>
          </div>
        ) : (
          <>
            <DurationInput value={form.duration} onChange={(d) => setForm(f => ({ ...f, duration: d }))} />
            {hasSubtasks && form.durationManualOverride && (
              <div style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginBottom: '0.75rem', fontStyle: 'italic' }}>
                ⓘ Manuel · somme des sous-tâches : {fmtMin(subtaskSum) || '—'}
                <button className="btn-ghost" style={{ marginLeft: '0.4rem', fontSize: '0.7rem', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ocean)', textDecoration: 'underline' }} onClick={() => setForm(f => ({ ...f, durationManualOverride: false }))}>
                  Revenir à l'auto
                </button>
              </div>
            )}
            {shouldSuggestBreakdown && (
              <div style={{ background: 'var(--paper-2)', padding: '0.75rem', marginBottom: '1rem', fontSize: '0.8rem', borderLeft: '3px solid var(--ochre)', borderRadius: '3px' }}>
                💡 <strong>Suggestion</strong> — cette tâche dépasse 25 min. Tu pourrais la découper en sous-tâches après l'avoir créée.
              </div>
            )}
          </>
        )}

        {/* RAPPEL — one-shot ; V5 lot 4 : aussi récurrentes / routines à heure fixe (chaque occurrence, chaque créneau) */}
        {(!form.recurrence || (!isFloatingRecurrence(form.recurrence) && (form.time || (form.times || []).some(Boolean)))) && (
          <>
            <Label>Rappel{form.recurrence ? ' · à chaque occurrence' : ''}</Label>
            <select className="input" style={{ marginBottom: '0.3rem' }} value={form.reminder} onChange={e => setForm(f => ({ ...f, reminder: e.target.value }))}>
              <option value="">Aucun</option>
              <option value="0">À l'heure prévue</option>
              <option value="5">5 min avant</option>
              <option value="15">15 min avant</option>
              <option value="30">30 min avant</option>
              <option value="60">1 h avant</option>
              <option value="1440">La veille</option>
            </select>
            {form.reminder && (
              <div style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginBottom: '1rem', fontStyle: 'italic' }}>
                ⓘ Cap fermé : seulement sur les appareils où les notifications sont activées (Réglages › Notifications){form.recurrence && form.streak && (form.times || []).filter(Boolean).length >= 2 ? ' · un rappel par créneau' : ''}
              </div>
            )}
            {!form.reminder && <div style={{ marginBottom: '1rem' }} />}
          </>
        )}

        <Label>Important / RDV</Label>
        <div style={{ marginBottom: importantError ? '0.4rem' : '1.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => { setForm(f => ({ ...f, isImportant: !f.isImportant })); if (importantError) setImportantError(false); }}
            style={{
              border: '1px solid ' + (importantError ? 'var(--rust)' : (form.isImportant ? 'var(--ochre)' : 'var(--line)')),
              background: importantError ? 'rgba(184,72,46,0.06)' : (form.isImportant ? 'rgba(196,135,41,0.15)' : 'transparent'),
              color: form.isImportant ? 'var(--ochre)' : 'var(--ink-muted)',
              cursor: 'pointer', padding: '0.4rem 0.75rem', fontSize: '0.8rem',
              borderRadius: '3px', display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
              fontWeight: form.isImportant ? 600 : 400
            }}
          >
            {form.isImportant ? '★' : '☆'} {form.isImportant ? 'Important' : 'Marquer important'}
          </button>
          <span style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', fontStyle: 'italic' }}>
            RDV, échéance critique — toujours visible en haut
          </span>
        </div>
        {importantError && (
          <div style={{ fontSize: '0.75rem', color: 'var(--rust)', marginBottom: '1.25rem', fontWeight: 500 }}>
            ⚠ Important nécessite date+heure ou échéance. Renseigne au moins l'un des deux.
          </div>
        )}

        {/* V3 S4.5 : Préparation + trajet — visible uniquement si Important + heure renseignée */}
        {form.isImportant && form.time && (
          <PrepTravelSection
            prepDuration={form.prepDuration}
            travelDuration={form.travelDuration}
            travelReturn={form.travelReturn}
            travelReturnDuration={form.travelReturnDuration ?? null}
            onChangeReturnDuration={(v) => setForm(f => v === null
              ? { ...f, travelReturn: false, travelReturnDuration: null } // « Aucun » = pas de retour
              : { ...f, travelReturnDuration: v === f.travelDuration ? null : v })} // = aller → on garde le lien
            onChangePrep={(v) => setForm(f => ({ ...f, prepDuration: v }))}
            onChangeTravel={(v) => setForm(f => ({ ...f, travelDuration: v }))}
            onToggleReturn={() => setForm(f => ({ ...f, travelReturn: !f.travelReturn }))}
            time={form.time}
          />
        )}

        {/* V4 4a.1 : rattachement à un cap (filiation optionnelle) */}
        {caps && caps.length > 0 && (() => {
          // Options à plat avec indentation selon la profondeur
          const opts = [];
          const walk = (list, depth) => {
            list.forEach(n => {
              const k = capDisplayKind(depth);
              const prefix = '\u00A0\u00A0'.repeat(depth) + (k === 'objective' ? '◷ ' : k === 'project' ? '▸ ' : '⚑ ');
              opts.push({ id: n.id, label: prefix + n.title });
              if (n.children?.length) walk(n.children, depth + 1);
            });
          };
          walk(caps, 0);
          const lineage = form.capId ? capLineageLabel(caps, visions, form.capId) : null;
          return (
            <div style={{ marginBottom: '1.5rem' }}>
              <Label>Cap rattaché</Label>
              <select className="input" value={form.capId || ''} onChange={e => setForm(f => ({ ...f, capId: e.target.value || null }))}>
                <option value="">— Aucun (tâche libre) —</option>
                {opts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
              {lineage && (
                <div style={{ fontSize: '0.72rem', color: 'var(--ink-muted)', marginTop: '0.3rem', display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
                  <IconCompass size={11} /> {lineage.join(' › ')}
                </div>
              )}
            </div>
          );
        })()}

        <div style={{ marginBottom: '1.5rem' }}>
          <Label>Piliers (facultatif)</Label>
          <PillarPicker value={form.pillars || []} onChange={v => setForm(f => ({ ...f, pillars: v }))} inherited={capLineagePillars(caps, form.capId)} />
        </div>

        <Label>Notes</Label>
        <textarea className="input" rows="3" style={{ marginBottom: '1.5rem', resize: 'vertical', fontFamily: 'var(--font-body)' }} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Contexte, détails…" />

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          {onDelete && (
            <button className="btn" style={{ borderColor: 'var(--rust)', color: 'var(--rust)', marginRight: 'auto' }} onClick={onDelete}><IconTrash size={14} /> Supprimer</button>
          )}
          {item && onDuplicate && (
            <button className="btn" onClick={onDuplicate} title="Dupliquer (sans date/heure)"><IconCopy size={14} /> Dupliquer</button>
          )}
          <button className="btn" onClick={onClose}>Annuler</button>
          <button className="btn btn-rust" onClick={handleSave}><IconCheck size={14} /> Enregistrer</button>
        </div>
      </div>
    </div>
  );
}

// ============ RECURRENCE OPTIONS (sous-bloc du modal) ============
function RecurrenceOptions({ value, preset, onChange }) {
  const r = value;
  const dowLabels = ['L', 'M', 'M', 'J', 'V', 'S', 'D']; // affichage L-D (lundi premier)
  const dowOrder = [1, 2, 3, 4, 5, 6, 0]; // mapping aux valeurs réelles
  const toggleDay = (dow) => {
    const wd = r.weekdays || [];
    const next = wd.includes(dow) ? wd.filter(d => d !== dow) : [...wd, dow];
    onChange({ ...r, weekdays: next });
  };
  const showWeekdaysPicker = preset === 'weekly' || (preset === 'custom' && r.rule === 'weekly');
  const showMonthDay = preset === 'monthly' || (preset === 'custom' && r.rule === 'monthly');
  const showYearly = preset === 'yearly';
  const showInterval = preset === 'custom';
  const showRuleSelect = preset === 'custom';

  const monthNamesFull = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

  return (
    <div style={{ background: 'var(--paper-2)', padding: '0.6rem 0.75rem', borderRadius: '3px', marginBottom: '0.5rem', fontSize: '0.85rem' }}>
      {showRuleSelect && (
        <div style={{ marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', marginRight: '0.4rem' }}>Type :</span>
          <select className="input" style={{ width: 'auto', display: 'inline-block', padding: '0.3rem 0.5rem', fontSize: '0.8rem' }} value={r.rule} onChange={e => onChange({ ...r, rule: e.target.value })}>
            <option value="daily">Tous les X jours</option>
            <option value="weekly">Hebdomadaire</option>
            <option value="monthly">Mensuel</option>
          </select>
        </div>
      )}
      {showInterval && (
        <div style={{ marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>Tous les</span>
          <input type="number" min="1" className="input" style={{ width: '60px', padding: '0.3rem' }} value={r.interval || 1} onChange={e => onChange({ ...r, interval: Math.max(1, parseInt(e.target.value) || 1) })} />
          <span style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>{r.rule === 'daily' ? 'jour(s)' : r.rule === 'weekly' ? 'semaine(s)' : 'mois'}</span>
        </div>
      )}
      {showWeekdaysPicker && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginBottom: '0.3rem' }}>Jours</div>
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
            {dowOrder.map((dow, i) => {
              const active = (r.weekdays || []).includes(dow);
              return (
                <button key={dow} className={active ? 'btn btn-primary' : 'btn'} onClick={() => toggleDay(dow)} style={{ width: '32px', height: '32px', padding: 0, justifyContent: 'center', fontSize: '0.75rem', fontWeight: active ? 600 : 400 }}>
                  {dowLabels[i]}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {showMonthDay && (
        <>
          <div style={{ marginBottom: '0.3rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>Le</span>
            <input type="number" min="1" max="31" className="input" style={{ width: '60px', padding: '0.3rem' }} value={r.monthDay || 1} onChange={e => onChange({ ...r, monthDay: Math.min(31, Math.max(1, parseInt(e.target.value) || 1)) })} />
            <span style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>du mois</span>
          </div>
          {/* V3 S5.5+ : warning si jour > 28, on tombera sur dernier jour pour mois courts */}
          {(r.monthDay || 0) > 28 && (
            <div style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginBottom: '0.5rem', fontStyle: 'italic' }}>
              ⓘ Pour les mois plus courts, l'occurrence tombera le dernier jour disponible (ex : 28 février).
            </div>
          )}
        </>
      )}
      {showYearly && (() => {
        // V3 S5.5+ : cap dynamique du jour selon le mois sélectionné
        // 29 max pour février (autorise les 29 fév sciemment, années bissextiles uniquement)
        const month = typeof r.month === 'number' ? r.month : 0;
        const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month];
        const currentDay = r.monthDay || 1;
        // Si on change vers un mois plus court, clip le jour
        const handleMonthChange = (newMonth) => {
          const newMax = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][newMonth];
          const newDay = currentDay > newMax ? newMax : currentDay;
          onChange({ ...r, month: newMonth, monthDay: newDay });
        };
        const isLeapDay = (month === 1 && currentDay === 29);
        return (
          <>
            <div style={{ marginBottom: '0.3rem', display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>Le</span>
              <input
                type="number" min="1" max={daysInMonth} className="input"
                style={{ width: '60px', padding: '0.3rem' }}
                value={currentDay}
                onChange={e => onChange({ ...r, monthDay: Math.min(daysInMonth, Math.max(1, parseInt(e.target.value) || 1)) })}
              />
              <select
                className="input"
                style={{ width: 'auto', padding: '0.3rem 0.5rem', fontSize: '0.8rem' }}
                value={month}
                onChange={e => handleMonthChange(parseInt(e.target.value, 10))}
              >
                {monthNamesFull.map((m, i) => <option key={i} value={i}>{m}</option>)}
              </select>
            </div>
            {isLeapDay && (
              <div style={{ fontSize: '0.7rem', color: 'var(--ochre)', marginBottom: '0.5rem', fontStyle: 'italic' }}>
                ⓘ 29 février : ne se déclenche que les années bissextiles (tous les 4 ans).
              </div>
            )}
          </>
        );
      })()}

      {/* Fin de récurrence */}
      <div style={{ marginTop: '0.6rem', paddingTop: '0.5rem', borderTop: '1px dashed var(--line)' }}>
        <div style={{ fontSize: '0.7rem', color: 'var(--ink-muted)', marginBottom: '0.3rem' }}>Fin</div>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center', fontSize: '0.78rem' }}>
          <label style={{ display: 'inline-flex', gap: '0.2rem', alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" checked={!r.endDate && !r.endAfter} onChange={() => onChange({ ...r, endDate: null, endAfter: null })} />
            Pas de fin
          </label>
          <label style={{ display: 'inline-flex', gap: '0.2rem', alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" checked={!!r.endDate} onChange={() => onChange({ ...r, endDate: r.endDate || todayISO(), endAfter: null })} />
            Jusqu'au
          </label>
          {r.endDate && (
            <input type="date" className="input" value={r.endDate} onChange={e => onChange({ ...r, endDate: e.target.value, endAfter: null })} style={{ width: 'auto', padding: '0.2rem 0.4rem', fontSize: '0.78rem' }} />
          )}
          <label style={{ display: 'inline-flex', gap: '0.2rem', alignItems: 'center', cursor: 'pointer' }}>
            <input type="radio" checked={!!r.endAfter} onChange={() => onChange({ ...r, endAfter: r.endAfter || 10, endDate: null })} />
            Après
          </label>
          {r.endAfter && (
            <>
              <input type="number" min="1" className="input" value={r.endAfter} onChange={e => onChange({ ...r, endAfter: Math.max(1, parseInt(e.target.value) || 1), endDate: null })} style={{ width: '55px', padding: '0.2rem 0.4rem', fontSize: '0.78rem' }} />
              <span>occurrences</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DurationInput({ value, onChange }) {
  const [showAll, setShowAll] = useState(!!(value.weeks || value.days || value.hours));
  const update = (field, v) => onChange({ ...value, [field]: parseInt(v) || 0 });
  // Snap au pas de 5 min uniquement à la sortie de champ (pour ne pas bloquer la saisie en cours)
  const snapMinOnBlur = (e) => {
    const raw = parseInt(e.target.value) || 0;
    const snapped = snap5(raw);
    if (snapped !== raw) onChange({ ...value, minutes: snapped });
  };

  return (
    <div style={{ marginBottom: '1rem' }}>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
        {showAll && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
              <input type="number" min="0" className="input" style={{ width: '60px', padding: '0.4rem' }} value={value.weeks || ''} onChange={e => update('weeks', e.target.value)} placeholder="0" />
              <span style={{ fontSize: '0.8rem', color: 'var(--ink-muted)' }}>sem.</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
              <input type="number" min="0" className="input" style={{ width: '60px', padding: '0.4rem' }} value={value.days || ''} onChange={e => update('days', e.target.value)} placeholder="0" />
              <span style={{ fontSize: '0.8rem', color: 'var(--ink-muted)' }}>j</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
              <input type="number" min="0" className="input" style={{ width: '60px', padding: '0.4rem' }} value={value.hours || ''} onChange={e => update('hours', e.target.value)} placeholder="0" />
              <span style={{ fontSize: '0.8rem', color: 'var(--ink-muted)' }}>h</span>
            </div>
          </>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
          <input type="number" min="0" step="5" className="input" style={{ width: '70px', padding: '0.4rem' }} value={value.minutes || ''} onChange={e => update('minutes', e.target.value)} onBlur={snapMinOnBlur} placeholder="0" />
          <span style={{ fontSize: '0.8rem', color: 'var(--ink-muted)' }}>min</span>
        </div>
        {!showAll && <button className="btn-ghost" style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', cursor: 'pointer', border: 'none', background: 'transparent' }} onClick={() => setShowAll(true)}><IconPlus size={12} /> heures, jours, semaines</button>}
        {showAll && <button className="btn-ghost" style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', cursor: 'pointer', border: 'none', background: 'transparent' }} onClick={() => { setShowAll(false); onChange({ minutes: value.minutes || 0 }); }}>seulement min</button>}
      </div>
      {durationToMinutes(value) > 0 && (
        <div style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', marginTop: '0.4rem' }}>
          Total : <span className="mono">{formatDuration(value)}</span> <span style={{ fontStyle: 'italic' }}>· pas de 5 min</span>
        </div>
      )}
    </div>
  );
}

// V5 lot 4 : Réglages › Notifications (par appareil)
function NotificationsSettings({ push }) {
  const { status, onEnable, onDisable, onTest } = push;
  const note = { fontSize: '0.75rem', color: 'var(--ink-muted)', lineHeight: 1.45 };
  return (
    <>
      <Label>Notifications</Label>
      <div style={{ marginBottom: '1rem' }}>
        {status === 'on' && (
          <>
            <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>🔔 Activées sur cet appareil — rappels et fins de tranche arrivent même Cap fermé.</div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button className="btn" onClick={onTest}>Envoyer une notification de test</button>
              <button className="btn" onClick={onDisable}>Désactiver sur cet appareil</button>
            </div>
          </>
        )}
        {(status === 'off' || status === 'busy') && (
          <>
            <div style={{ ...note, marginBottom: '0.5rem' }}>Reçois tes rappels, l'heure de partir et les fins de tranche même quand Cap est fermé. À activer sur chaque appareil.</div>
            <button className="btn btn-rust" onClick={onEnable} disabled={status === 'busy'}>{status === 'busy' ? '…' : '🔔 Activer sur cet appareil'}</button>
          </>
        )}
        {status === 'denied' && <div style={note}>Les notifications sont bloquées pour Cap dans ce navigateur. Autorise-les dans les réglages du site (icône à gauche de l'adresse), puis reviens ici.</div>}
        {status === 'ios-install' && <div style={note}>Sur iPhone, les notifications ne marchent que si Cap est installé : bouton Partager › « Sur l'écran d'accueil », puis ouvre Cap depuis l'icône et reviens ici.</div>}
        {status === 'unsupported' && <div style={note}>Ce navigateur ne gère pas les notifications push. Les rappels restent affichés quand Cap est ouvert.</div>}
      </div>
    </>
  );
}

function Label({ children }) {
  return <label className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)', display: 'block', marginBottom: '0.3rem' }}>{children}</label>;
}

// V3 S4 : Input time avec snap 5min + 4 boutons : heures ±1 / minutes ±5
function TimeInput({ value, onChange, style, className }) {
  const handleChange = (e) => {
    onChange(e.target.value);
  };
  const handleBlur = (e) => {
    // Snap 5 min au blur (au cas où l'utilisateur a tapé 11:31 manuellement)
    const v = e.target.value;
    if (!v) return;
    const mins = timeToMin(v);
    if (mins == null) return;
    const snapped = snap5(mins);
    const newVal = minToTime(snapped);
    if (newVal !== v) onChange(newVal);
  };
  const adjustHour = (delta) => {
    const cur = value ? timeToMin(value) : null;
    const base = cur != null ? cur : 9 * 60;
    let next = snap5(base) + delta * 60;
    if (next < 0) next = 0;
    if (next > 23 * 60 + 55) next = 23 * 60 + 55;
    onChange(minToTime(next));
  };
  const adjustMinute = (delta) => {
    const cur = value ? timeToMin(value) : null;
    const base = cur != null ? cur : 9 * 60;
    let next = snap5(base) + delta;
    if (next < 0) next = 0;
    if (next > 23 * 60 + 55) next = 23 * 60 + 55;
    onChange(minToTime(next));
  };
  const btnStyle = { border: '1px solid var(--line)', background: 'var(--paper)', cursor: 'pointer', padding: '0.25rem 0.35rem', fontSize: '0.65rem', borderRadius: '3px', color: 'var(--ink)', flexShrink: 0, lineHeight: 1, fontWeight: 600 };
  return (
    <div style={{ display: 'inline-flex', gap: '0.15rem', alignItems: 'center', ...(style || {}) }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
        <button type="button" onClick={() => adjustHour(1)} title="+1 h" style={btnStyle}>▲h</button>
        <button type="button" onClick={() => adjustHour(-1)} title="-1 h" style={btnStyle}>▼h</button>
      </div>
      <input
        type="time"
        step="300"
        className={className || 'input'}
        value={value || ''}
        onChange={handleChange}
        onBlur={handleBlur}
        style={{ flex: 1, minWidth: '90px', padding: '0.4rem' }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1px' }}>
        <button type="button" onClick={() => adjustMinute(5)} title="+5 min" style={btnStyle}>▲5</button>
        <button type="button" onClick={() => adjustMinute(-5)} title="-5 min" style={btnStyle}>▼5</button>
      </div>
    </div>
  );
}

// ============ SUGGESTION MODAL ============
function SuggestionModal({ task, categories, onClose, onStart }) {
  // V3 S4 : Entrée valide → Démarrer (si task) ou ferme (si pas de task)
  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (task) onStart(task.id);
      else onClose();
    }
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} onKeyDown={handleKey} tabIndex={-1} ref={el => el && el.focus()} style={{ maxWidth: '480px', textAlign: 'center', outline: 'none' }}>
        <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: '0.75rem' }}>Suggestion</div>
        {task ? (
          <>
            <div className="display" style={{ fontSize: '1rem', color: 'var(--ink-muted)', marginBottom: '0.5rem', fontStyle: 'italic' }}>Commence par ça —</div>
            <h2 className="display" style={{ fontSize: '1.8rem', fontWeight: 500, margin: '0 0 1rem 0', letterSpacing: '-0.01em' }}>
              {task.icon && <span style={{ marginRight: '0.4rem' }}>{task.icon}</span>}« {task.title} »
            </h2>
            <div style={{ display: 'flex', gap: '0.3rem', justifyContent: 'center', flexWrap: 'wrap', marginBottom: '1.5rem' }}>
              {(() => { const c = categories.find(x => x.id === task.categoryId); return c ? <span className="chip"><span className="cat-dot" style={{ background: c.color }} />{c.name}</span> : null; })()}
              {(() => { const m = effectiveDurationMinutes(task); return m > 0 ? <span className="chip"><IconClock size={10} />{formatDuration(minutesToDuration(m))}</span> : null; })()}
              {(() => { const dl = deadlineStatus(task.deadline); return dl ? <span className={`chip chip-deadline-${dl.color} ${dl.intense ? 'intense' : ''}`}>⚠ {dl.label}</span> : null; })()}
              {task.energy && (() => {
                const lvl = task.energy === 'low' ? 1 : task.energy === 'high' ? 3 : 2;
                return <span className={`chip chip-energy-${task.energy}`} title={`Énergie ${energyLabel(task.energy)}`} style={{ padding: '0.1rem 0.4rem' }}><IconBattery level={lvl} /></span>;
              })()}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button className="btn" onClick={onClose}>Plus tard</button>
              <button className="btn btn-rust" onClick={() => onStart(task.id)}><IconPlay size={14} /> Démarrer</button>
            </div>
          </>
        ) : (
          <>
            <div className="display" style={{ fontSize: '1.8rem', fontStyle: 'italic', margin: '1rem 0' }}>Rien à faire.</div>
            <p style={{ color: 'var(--ink-muted)', fontSize: '0.9rem' }}>Tout est rangé, ou rien n'est encore planifié. Profites-en 🌿</p>
            <button className="btn btn-rust" onClick={onClose} style={{ marginTop: '1rem' }}>Fermer</button>
          </>
        )}
      </div>
    </div>
  );
}

// ============ CHECK-IN MODAL ============
function CheckinModal({ currentMode, onClose, onSelect }) {
  const [customHours, setCustomHours] = useState(6);
  const [showCustom, setShowCustom] = useState(false);

  // V3 S4 : Entrée valide check-in si custom + valeur numérique, sinon ne fait rien
  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      const tag = e.target.tagName;
      if (tag === 'TEXTAREA') return;
      if (showCustom && customHours > 0) {
        e.preventDefault();
        onSelect('custom', customHours);
      }
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} onKeyDown={handleKey} style={{ maxWidth: '560px' }}>
        <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: '0.5rem' }}>Check-in du jour</div>
        <h2 className="display" style={{ margin: '0 0 0.5rem 0', fontSize: '1.6rem', fontStyle: 'italic' }}>Comment tu te sens aujourd'hui ?</h2>
        <p style={{ color: 'var(--ink-muted)', fontSize: '0.85rem', marginBottom: '1.25rem' }}>Pas de jugement. C'est juste pour caler ta capacité du jour.</p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', marginBottom: '0.75rem' }}>
          {ENERGY_PRESETS.map(p => (
            <div key={p.id} className={`energy-card ${currentMode === p.id ? 'selected' : ''}`} onClick={() => onSelect(p.id, p.hours)}>
              <div style={{ fontSize: '2rem', marginBottom: '0.3rem' }}>{p.emoji}</div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>{p.label}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--ink-muted)' }}>{p.desc}</div>
              <div className="mono" style={{ fontSize: '0.75rem', marginTop: '0.3rem' }}>{p.hours}h de capacité</div>
            </div>
          ))}
        </div>

        <div className={`energy-card ${currentMode === 'custom' ? 'selected' : ''}`} onClick={() => setShowCustom(true)} style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: '1.3rem', marginBottom: '0.2rem' }}>🎚️</div>
          <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>Autre — au feeling</div>
          {showCustom ? (
            <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.4rem', justifyContent: 'center', alignItems: 'center' }} onClick={e => e.stopPropagation()}>
              <input type="number" min="0.5" max="16" step="0.5" className="input" style={{ width: '80px', textAlign: 'center' }} value={customHours} onChange={e => setCustomHours(parseFloat(e.target.value))} />
              <span style={{ fontSize: '0.85rem' }}>heures</span>
              <button className="btn btn-rust" style={{ fontSize: '0.8rem' }} onClick={() => onSelect('custom', customHours)}>Valider</button>
            </div>
          ) : (
            <div style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', marginTop: '0.2rem' }}>Définis le nombre d'heures précis</div>
          )}
        </div>

        <button className="btn-ghost" onClick={onClose} style={{ display: 'block', margin: '0 auto', fontSize: '0.8rem', color: 'var(--ink-muted)', border: 'none', background: 'transparent', cursor: 'pointer' }}>Plus tard</button>
      </div>
    </div>
  );
}

// ============ SETTINGS MODAL ============
function SettingsModal({ settings, categories, userEmail, onClose, onSave, onUpdateCategories, onDeleteAccount, push }) {
  const [form, setForm] = useState({ ...settings });
  const [editingCats, setEditingCats] = useState(categories);
  const [newCatName, setNewCatName] = useState('');
  const [newCatColor, setNewCatColor] = useState('#B8482E');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteEmailInput, setDeleteEmailInput] = useState('');
  const [deleting, setDeleting] = useState(false);
  const COLOR_OPTIONS = ['#B8482E', '#2C5F7C', '#C68729', '#5C7A3E', '#6B4E8A', '#D97A5E', '#3D8B7A', '#A8456B'];

  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
  const cmdKey = isMac ? '⌘' : 'Ctrl';

  // V3 S4 : Entrée valide settings (sauf focus textarea/input zone dangereuse de delete)
  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      const tag = e.target.tagName;
      if (tag === 'TEXTAREA') return;
      // Si on est dans le champ "delete email confirm" : ne pas valider settings
      if (showDeleteConfirm) return;
      // Si on est dans le champ "nouvelle catégorie" : ajouter la catégorie au lieu de fermer
      if (e.target.placeholder === 'Nouvelle catégorie…' && newCatName.trim()) {
        e.preventDefault();
        setEditingCats([...editingCats, { id: 'cat-' + generateId(), name: newCatName.trim(), color: newCatColor }]);
        setNewCatName('');
        return;
      }
      e.preventDefault();
      onSave(form);
      onUpdateCategories(editingCats);
      onClose();
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} onKeyDown={handleKey} style={{ maxWidth: '540px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
          <h2 className="display" style={{ margin: 0, fontSize: '1.5rem', fontWeight: 500, fontStyle: 'italic' }}>Réglages</h2>
          <button className="btn-ghost" style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '0.3rem' }} onClick={onClose}><IconX size={18} /></button>
        </div>

        <Label>Pomodoro</Label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '1rem' }}>
          <div>
            <div style={{ fontSize: '0.75rem', marginBottom: '0.3rem', color: 'var(--ink-muted)' }}>Focus (min)</div>
            <input type="number" min="5" max="120" className="input" value={form.pomoFocus} onChange={e => setForm(f => ({ ...f, pomoFocus: parseInt(e.target.value) || 25 }))} />
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', marginBottom: '0.3rem', color: 'var(--ink-muted)' }}>Pause (min)</div>
            <input type="number" min="1" max="60" className="input" value={form.pomoBreak} onChange={e => setForm(f => ({ ...f, pomoBreak: parseInt(e.target.value) || 5 }))} />
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', marginBottom: '0.3rem', color: 'var(--ink-muted)' }}>Longue pause (min)</div>
            <input type="number" min="5" max="60" className="input" value={form.pomoLongBreak} onChange={e => setForm(f => ({ ...f, pomoLongBreak: parseInt(e.target.value) || 15 }))} />
          </div>
          <div>
            <div style={{ fontSize: '0.75rem', marginBottom: '0.3rem', color: 'var(--ink-muted)' }}>Cycles avant longue pause</div>
            <input type="number" min="2" max="10" className="input" value={form.pomoCyclesBeforeLongBreak} onChange={e => setForm(f => ({ ...f, pomoCyclesBeforeLongBreak: parseInt(e.target.value) || 4 }))} />
          </div>
        </div>

        <Label>Catégories</Label>
        <div style={{ marginBottom: '1rem' }}>
          {editingCats.map((c, i) => (
            <div key={c.id} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', padding: '0.3rem 0', borderBottom: '1px dashed var(--line)' }}>
              <span className="cat-dot" style={{ background: c.color, width: '14px', height: '14px' }} />
              <input className="input" value={c.name} onChange={e => {
                const newCats = [...editingCats]; newCats[i] = { ...c, name: e.target.value }; setEditingCats(newCats);
              }} style={{ flex: 1 }} />
              <input type="color" value={c.color} onChange={e => {
                const newCats = [...editingCats]; newCats[i] = { ...c, color: e.target.value }; setEditingCats(newCats);
              }} style={{ width: '32px', height: '32px', border: 'none', cursor: 'pointer', padding: 0, background: 'transparent' }} />
              <button className="btn-ghost" onClick={() => {
                if (confirm(`Supprimer la catégorie "${c.name}" ?`)) {
                  setEditingCats(editingCats.filter(x => x.id !== c.id));
                }
              }} style={{ padding: '0.3rem', border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-muted)' }}><IconTrash size={14} /></button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.5rem', alignItems: 'center' }}>
            <input className="input" placeholder="Nouvelle catégorie…" value={newCatName} onChange={e => setNewCatName(e.target.value)} style={{ flex: 1 }} />
            <input type="color" value={newCatColor} onChange={e => setNewCatColor(e.target.value)} style={{ width: '32px', height: '32px', border: 'none', cursor: 'pointer', padding: 0, background: 'transparent' }} />
            <button className="btn" onClick={() => {
              if (!newCatName.trim()) return;
              setEditingCats([...editingCats, { id: 'cat-' + generateId(), name: newCatName.trim(), color: newCatColor }]);
              setNewCatName('');
            }}><IconPlus size={14} /></button>
          </div>
        </div>

        {push && <NotificationsSettings push={push} />}

        <Label>Raccourcis clavier</Label>
        <div style={{ fontSize: '0.8rem', marginBottom: '1rem', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.4rem 0.75rem', alignItems: 'center' }}>
          <kbd>Échap</kbd><span>Fermer fenêtre / désélectionner</span>
          <kbd>{cmdKey}+Z</kbd><span>Annuler la dernière suppression</span>
          <kbd>N</kbd><span>Capture rapide</span>
          <kbd>Shift+N</kbd><span>Nouvel item complet</span>
          <kbd>/</kbd><span>Focus capture rapide</span>
          <kbd>F</kbd><span>Plein écran de la tâche en cours</span>
          <kbd>Espace</kbd><span>Pause / reprise de la tâche en cours</span>
          <span style={{ whiteSpace: 'nowrap' }}><kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd></span><span>Déplacer la tâche sélectionnée vers Must / Should / Want</span>
          <kbd>Entrée</kbd><span>Valider la fenêtre ouverte</span>
        </div>

        <Label>Compte</Label>
        <div style={{ fontSize: '0.85rem', color: 'var(--ink-muted)', marginBottom: '0.5rem' }}>
          Connecté en tant que <span className="mono">{userEmail || '—'}</span>
        </div>

        <div className="danger-zone">
          <div style={{ fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.4rem', color: 'var(--rust)' }}>Zone dangereuse</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--ink-muted)', marginBottom: '0.75rem' }}>
            La suppression efface toutes tes données Cap (tâches, habitudes, catégories, capacités). Action irréversible.
          </div>
          {!showDeleteConfirm ? (
            <button className="btn" style={{ borderColor: 'var(--rust)', color: 'var(--rust)' }} onClick={() => setShowDeleteConfirm(true)}>
              <IconTrash size={14} /> Supprimer mon compte
            </button>
          ) : (
            <div>
              <div style={{ fontSize: '0.8rem', marginBottom: '0.4rem' }}>
                Pour confirmer, tape ton email : <span className="mono" style={{ color: 'var(--ink)' }}>{userEmail}</span>
              </div>
              <input className="input" placeholder="ton@email.com" value={deleteEmailInput} onChange={e => setDeleteEmailInput(e.target.value)} style={{ marginBottom: '0.5rem' }} />
              <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => { setShowDeleteConfirm(false); setDeleteEmailInput(''); }} disabled={deleting}>Annuler</button>
                <button
                  className="btn"
                  style={{ background: 'var(--rust)', color: 'var(--paper)', borderColor: 'var(--rust)' }}
                  disabled={deleting || deleteEmailInput.trim().toLowerCase() !== (userEmail || '').toLowerCase()}
                  onClick={async () => {
                    setDeleting(true);
                    try {
                      await onDeleteAccount();
                    } finally {
                      setDeleting(false);
                    }
                  }}
                >
                  {deleting ? 'Suppression…' : 'Confirmer la suppression'}
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: '1.5rem' }}>
          <button className="btn" onClick={onClose}>Annuler</button>
          <button className="btn btn-rust" onClick={() => { onSave(form); onUpdateCategories(editingCats); onClose(); }}><IconCheck size={14} /> Enregistrer</button>
        </div>
      </div>
    </div>
  );
}

// ============ FOCUS SCREEN ============
function FocusScreen({ item, onReduce, running, onStart, onPauseResume, onStop, onSkip, onExtend, onComplete, categories }) {
  const cat = categories.find(c => c.id === item.categoryId);
  const isRunningThis = running && running.itemId === item.id;
  const done = isRunningThis && running.mode === 'done';
  const seconds = isRunningThis ? running.secondsLeft : 0;
  const total = isRunningThis && running.totalSeconds ? running.totalSeconds : 1;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  const pct = done ? 1 : isRunningThis ? seconds / total : 0;
  const modeLabel = isRunningThis ? sessionModeLabel(running) + (running.paused ? ' · en pause' : '') : '';
  // Plan en petites barres (tranche faite / en cours / à venir), seulement s'il y a plusieurs tranches
  const plan = isRunningThis && running.plan && running.plan.length > 1 ? running.plan : null;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--paper)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', zIndex: 50, overflow: 'auto' }}>
      <button className="btn" onClick={onReduce} style={{ position: 'absolute', top: '1.5rem', right: '1.5rem' }} title={isRunningThis ? 'La session continue dans le bandeau (Échap)' : 'Fermer (Échap)'}>
        {isRunningThis ? <><IconMinimize size={14} /> Réduire</> : <><IconX size={14} /> Fermer</>}
      </button>

      <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: '1rem' }}>Une seule chose · Rien d'autre</div>

      {cat && <div style={{ marginBottom: '0.5rem' }}><span className="chip"><span className="cat-dot" style={{ background: cat.color }} />{cat.name}</span></div>}

      <h1 className="display" style={{ fontSize: 'clamp(1.8rem, 5vw, 3rem)', fontWeight: 500, textAlign: 'center', maxWidth: '700px', margin: '0 0 1.5rem 0', fontStyle: 'italic', letterSpacing: '-0.02em' }}>
        {item.icon && <span style={{ marginRight: '0.5rem' }}>{item.icon}</span>}« {item.title} »
      </h1>

      {item.subtasks && item.subtasks.length > 0 && (
        <div style={{ marginBottom: '2rem', textAlign: 'left', maxWidth: '420px', width: '100%' }}>
          {item.subtasks.map(s => (
            <div key={s.id} style={{ padding: '0.4rem 0', borderBottom: '1px dashed var(--line)', fontSize: '0.95rem', color: 'var(--ink-soft)', textDecoration: s.completed ? 'line-through' : 'none', opacity: s.completed ? 0.5 : 1 }}>
              · {s.icon && <span>{s.icon} </span>}{s.title}
            </div>
          ))}
        </div>
      )}

      <div style={{ width: '260px', maxWidth: '70vw', aspectRatio: 1, marginBottom: plan ? '0.75rem' : '1.5rem' }}>
        <svg viewBox="0 0 200 200" style={{ width: '100%', height: '100%' }}>
          <circle cx="100" cy="100" r="92" fill="var(--paper-2)" stroke="var(--ink)" strokeWidth="1.5" />
          {Array.from({ length: 60 }).map((_, i) => {
            const angle = (i * 6 - 90) * Math.PI / 180;
            const isHour = i % 5 === 0;
            const r1 = isHour ? 84 : 88, r2 = 91;
            return <line key={i} x1={100 + r1 * Math.cos(angle)} y1={100 + r1 * Math.sin(angle)} x2={100 + r2 * Math.cos(angle)} y2={100 + r2 * Math.sin(angle)} stroke="var(--ink-muted)" strokeWidth={isHour ? 1.2 : 0.5} />;
          })}
          <PomoSector pct={pct} mode={isRunningThis ? running.mode : 'focus'} />
          <circle cx="100" cy="100" r="4" fill="var(--ink)" />
          <text x="100" y="108" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="22" fill="var(--ink)" fontWeight="500">
            {done ? '⏰' : isRunningThis ? `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : '—'}
          </text>
          {isRunningThis && (
            <text x="100" y="135" textAnchor="middle" fontFamily="DM Sans, sans-serif" fontSize="10" fill="var(--ink-muted)">{modeLabel}</text>
          )}
        </svg>
      </div>

      {plan && (
        <div className="session-plan" title="Plan de la session" style={{ display: 'flex', gap: '4px', alignItems: 'center', marginBottom: '1.5rem', width: '260px', maxWidth: '70vw' }}>
          {plan.map((m, i) => {
            const past = i < running.slice || (i === running.slice && running.mode !== 'focus');
            const current = i === running.slice && running.mode === 'focus';
            return (
              <div key={i} style={{ flex: m, height: '6px', borderRadius: '3px', background: past ? 'var(--rust)' : current ? 'color-mix(in srgb, var(--rust) 45%, transparent)' : 'var(--line)', outline: current ? '1px solid var(--rust)' : 'none' }} title={`${m} min`} />
            );
          })}
        </div>
      )}

      {done && (
        <div className="display" style={{ fontSize: '1.1rem', fontStyle: 'italic', color: 'var(--ink-soft)', marginBottom: '1rem', textAlign: 'center' }}>Temps prévu écoulé. C'est fini ?</div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        {!isRunningThis ? (
          <button className="btn btn-rust" onClick={onStart}><IconPlay size={14} /> Démarrer</button>
        ) : done ? (
          <>
            <button className="btn btn-rust" onClick={onComplete}><IconCheck size={14} /> Fini</button>
            <button className="btn" onClick={onExtend}>+5 min</button>
            <button className="btn" onClick={onStop}>Je m'arrête là</button>
          </>
        ) : (
          <>
            <button className="btn btn-primary" onClick={onPauseResume}>
              {running.paused ? <><IconPlay size={14} /> Reprendre</> : <><IconPause size={14} /> Pause</>}
            </button>
            <button className="btn" onClick={onSkip} title="Passer à la phase suivante (le temps déjà passé est gardé)">⏭ {running.mode !== 'focus' ? 'Reprendre le travail' : running.plan && running.slice >= running.plan.length - 1 ? 'Terminer la tranche' : 'Aller à la pause'}</button>
            <button className="btn" onClick={onStop} title="Le temps passé est gardé"><IconStop size={14} /> Arrêter</button>
          </>
        )}
        {!done && <button className="btn" onClick={onComplete}><IconCheck size={14} /> Fini</button>}
      </div>

      {item.actualMinutes > 0 && effectiveDurationMinutes(item) > 0 && (
        <div className="mono" style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', marginTop: '0.5rem' }}>
          ⏱ {fmtMin(item.actualMinutes)} passées · estimé {formatDuration(minutesToDuration(effectiveDurationMinutes(item)))}
        </div>
      )}
    </div>
  );
}

function PomoSector({ pct, mode }) {
  const color = mode === 'focus' ? 'var(--rust)' : 'var(--moss)';
  if (pct >= 1) return <circle cx="100" cy="100" r="80" fill={color} opacity="0.7" />;
  if (pct <= 0) return null;
  const angle = pct * 360;
  const largeArc = angle > 180 ? 1 : 0;
  const rad = (angle - 90) * Math.PI / 180;
  const x = 100 + 80 * Math.cos(rad);
  const y = 100 + 80 * Math.sin(rad);
  const d = `M 100 100 L 100 20 A 80 80 0 ${largeArc} 1 ${x} ${y} Z`;
  return <path d={d} fill={color} opacity="0.7" />;
}

// ============ AUTH GATE ============
function AuthGate() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recoveryMode, setRecoveryMode] = useState(false);

  useEffect(() => {
    // Récupère la session existante
    sb.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });
    // Écoute les changements (login, logout, refresh token, recovery)
    const { data: { subscription } } = sb.auth.onAuthStateChange((event, session) => {
      setSession(session);
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryMode(true);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  if (loading) {
    return (
      <CapLoader />
    );
  }

  // Si on est en mode recovery, on affiche l'écran "nouveau mot de passe"
  // même si une session existe (Supabase a créé une session temporaire pour l'occasion)
  if (recoveryMode) {
    return <PasswordRecoveryScreen onDone={() => { setRecoveryMode(false); }} />;
  }

  if (!session) {
    return <LoginScreen />;
  }

  return <CapApp session={session} />;
}

// ============ PASSWORD RECOVERY SCREEN ============
function PasswordRecoveryScreen({ onDone }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (password.length < 6) { setMessage({ type: 'error', text: 'Au moins 6 caractères.' }); return; }
    if (password !== confirm) { setMessage({ type: 'error', text: 'Les deux mots de passe ne correspondent pas.' }); return; }
    setLoading(true); setMessage(null);
    try {
      const { error } = await sb.auth.updateUser({ password });
      if (error) {
        setMessage({ type: 'error', text: error.message });
      } else {
        setMessage({ type: 'success', text: 'Mot de passe mis à jour. Tu es connecté.' });
        // Nettoyage du hash dans l'URL pour éviter de rejouer l'event au refresh
        try { history.replaceState(null, '', window.location.pathname); } catch {}
        // Petit délai pour laisser voir le message, puis on quitte le mode recovery → AuthGate basculera sur CapApp
        setTimeout(() => onDone(), 1200);
      }
    } finally { setLoading(false); }
  }

  return (
    <div className="paper-texture" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
      <div style={{ maxWidth: '420px', width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.1rem', color: 'var(--ink)' }}><CapMark size={52} /></div>
          <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: '0.5rem' }}>Récupération</div>
          <h1 className="display" style={{ fontSize: '2.5rem', fontWeight: 600, fontStyle: 'italic', margin: 0, letterSpacing: '-0.03em' }}>Nouveau mot de passe</h1>
        </div>
        <form onSubmit={handleSubmit} style={{ border: '1px solid var(--ink)', padding: '1.5rem', background: 'var(--paper)', borderRadius: '4px', boxShadow: '4px 4px 0 var(--shadow)' }}>
          <label className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)', display: 'block', marginBottom: '0.3rem' }}>Mot de passe</label>
          <input type="password" className="input" value={password} onChange={e => setPassword(e.target.value)} placeholder="Au moins 6 caractères" autoComplete="new-password" minLength={6} required style={{ marginBottom: '0.75rem' }} />
          <label className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)', display: 'block', marginBottom: '0.3rem' }}>Confirmation</label>
          <input type="password" className="input" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Retape le même" autoComplete="new-password" minLength={6} required style={{ marginBottom: '1rem' }} />
          {message && (
            <div style={{ padding: '0.6rem 0.75rem', marginBottom: '1rem', fontSize: '0.85rem', borderRadius: '3px', borderLeft: `3px solid ${message.type === 'error' ? 'var(--rust)' : 'var(--moss)'}`, background: 'var(--paper-2)' }}>
              {message.text}
            </div>
          )}
          <button type="submit" className="btn btn-rust" disabled={loading} style={{ width: '100%', justifyContent: 'center', padding: '0.7rem' }}>
            {loading ? 'Un instant…' : 'Mettre à jour mon mot de passe'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ============ LOGIN SCREEN ============
function LoginScreen() {
  const [mode, setMode] = useState('signin'); // signin | signup | forgot
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null); // { type: 'error'|'info'|'success', text: '...' }

  async function handleSubmit(e) {
    e.preventDefault();
    if (mode === 'forgot') {
      if (!email.trim()) return;
      setLoading(true); setMessage(null);
      try {
        const { error } = await sb.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: window.location.origin + window.location.pathname,
        });
        if (error) {
          setMessage({ type: 'error', text: error.message });
        } else {
          setMessage({ type: 'success', text: 'Si ce compte existe, un email a été envoyé. Vérifie ta boîte (et les spams).' });
        }
      } finally { setLoading(false); }
      return;
    }

    if (!email.trim() || !password.trim()) return;
    setLoading(true); setMessage(null);
    try {
      if (mode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email: email.trim(), password });
        if (error) {
          setMessage({ type: 'error', text: error.message });
        } else if (data.user && !data.session) {
          // Email de confirmation envoyé
          setMessage({ type: 'success', text: 'Compte créé. Vérifie ta boîte mail pour confirmer ton adresse, puis connecte-toi.' });
          setMode('signin');
        } else if (data.session) {
          // Auto-connecté (si confirm email désactivé)
          setMessage({ type: 'success', text: 'Compte créé et connecté !' });
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
        if (error) {
          if (error.message.toLowerCase().includes('email not confirmed')) {
            setMessage({ type: 'error', text: 'Email pas encore confirmé. Vérifie ta boîte mail (et les spams).' });
          } else if (error.message.toLowerCase().includes('invalid login')) {
            setMessage({ type: 'error', text: 'Email ou mot de passe incorrect.' });
          } else {
            setMessage({ type: 'error', text: error.message });
          }
        }
      }
    } finally { setLoading(false); }
  }

  async function handleResendConfirm() {
    if (!email.trim()) { setMessage({ type: 'error', text: 'Entre ton email d\'abord.' }); return; }
    setLoading(true); setMessage(null);
    try {
      const { error } = await sb.auth.resend({ type: 'signup', email: email.trim() });
      if (error) setMessage({ type: 'error', text: error.message });
      else setMessage({ type: 'success', text: 'Email de confirmation renvoyé. Vérifie ta boîte (et les spams).' });
    } finally { setLoading(false); }
  }

  return (
    <div className="paper-texture" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem' }}>
      <div style={{ maxWidth: '420px', width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.1rem', color: 'var(--ink)' }}><CapMark size={68} /></div>
          <div className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--ink-muted)', marginBottom: '0.5rem' }}>Productivité</div>
          <h1 className="display" style={{ fontSize: '3.5rem', fontWeight: 600, fontStyle: 'italic', margin: 0, letterSpacing: '-0.03em' }}>Cap</h1>
          <div style={{ fontSize: '0.9rem', color: 'var(--ink-muted)', marginTop: '0.5rem', fontStyle: 'italic' }}>Garde le cap. Ton rythme, ton énergie.</div>
        </div>

        <form onSubmit={handleSubmit} style={{ border: '1px solid var(--ink)', padding: '1.5rem', background: 'var(--paper)', borderRadius: '4px', boxShadow: '4px 4px 0 var(--shadow)' }}>
          {mode !== 'forgot' && (
            <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '1.25rem' }}>
              <button type="button" className={mode === 'signin' ? 'btn btn-primary' : 'btn'} onClick={() => { setMode('signin'); setMessage(null); }} style={{ flex: 1, justifyContent: 'center' }}>Connexion</button>
              <button type="button" className={mode === 'signup' ? 'btn btn-primary' : 'btn'} onClick={() => { setMode('signup'); setMessage(null); }} style={{ flex: 1, justifyContent: 'center' }}>Créer un compte</button>
            </div>
          )}

          {mode === 'forgot' && (
            <div style={{ marginBottom: '1rem', fontSize: '0.85rem', color: 'var(--ink-muted)' }}>
              Tape ton email, on t'envoie un lien pour redéfinir ton mot de passe.
            </div>
          )}

          <label className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)', display: 'block', marginBottom: '0.3rem' }}>Email</label>
          <input type="email" className="input" value={email} onChange={e => setEmail(e.target.value)} placeholder="toi@exemple.com" autoComplete="email" required style={{ marginBottom: '0.75rem' }} />

          {mode !== 'forgot' && (
            <>
              <label className="mono" style={{ fontSize: '0.7rem', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--ink-muted)', display: 'block', marginBottom: '0.3rem' }}>Mot de passe</label>
              <input type="password" className="input" value={password} onChange={e => setPassword(e.target.value)} placeholder={mode === 'signup' ? 'Au moins 6 caractères' : '••••••••'} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={6} required style={{ marginBottom: '1rem' }} />
            </>
          )}

          {message && (
            <div style={{ padding: '0.6rem 0.75rem', marginBottom: '1rem', fontSize: '0.85rem', borderRadius: '3px', borderLeft: `3px solid ${message.type === 'error' ? 'var(--rust)' : 'var(--moss)'}`, background: 'var(--paper-2)' }}>
              {message.text}
            </div>
          )}

          <button type="submit" className="btn btn-rust" disabled={loading} style={{ width: '100%', justifyContent: 'center', padding: '0.7rem' }}>
            {loading ? 'Un instant…' :
              mode === 'signup' ? 'Créer mon compte' :
              mode === 'forgot' ? 'Envoyer le lien' :
              'Me connecter'}
          </button>

          {mode === 'signin' && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.75rem', flexWrap: 'wrap', gap: '0.4rem' }}>
              <button type="button" onClick={() => { setMode('forgot'); setMessage(null); }} disabled={loading} style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', border: 'none', background: 'transparent', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                Mot de passe oublié ?
              </button>
              <button type="button" onClick={handleResendConfirm} disabled={loading} style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', border: 'none', background: 'transparent', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                Renvoyer la confirmation
              </button>
            </div>
          )}

          {mode === 'forgot' && (
            <button type="button" onClick={() => { setMode('signin'); setMessage(null); }} disabled={loading} style={{ display: 'block', margin: '0.75rem auto 0', fontSize: '0.75rem', color: 'var(--ink-muted)', border: 'none', background: 'transparent', cursor: 'pointer', textDecoration: 'underline' }}>
              ← Retour à la connexion
            </button>
          )}
        </form>

        <div style={{ textAlign: 'center', marginTop: '1.5rem', fontSize: '0.75rem', color: 'var(--ink-muted)' }}>
          Tes données sont synchronisées entre tous tes appareils.
        </div>
      </div>
    </div>
  );
}

export default AuthGate;
