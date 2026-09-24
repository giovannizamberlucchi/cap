# Cap — instructions pour Claude

Cap est une app de productivité pensée pour un cerveau TDAH (le mot n'apparaît pas dans l'interface). Philosophie : une boussole, pas une prison productiviste. Specs complètes, roadmap et décisions : **`cap-specs.md`** (source de vérité, versionnée ici). Lis-le avant tout cadrage ou tout code.

## Règles de fonctionnement
- **Cadrer avant de coder** : lister les specs, faire valider, puis coder. Pour tout changement de design ou de structure : proposer d'abord, coder après validation.
- **Mode carnet** : quand l'utilisateur envoie des notes ou des idées en vrac, noter sans élaborer, sauf demande explicite.
- **Ne jamais générer de fichier sans demander d'abord** (hors code et specs d'un lot validé).
- **Une question à la fois**, avec ta recommandation argumentée ; pas de menu d'options sans avis.
- **Vérifier que le code se charge et tourne** avant de livrer (test headless, voir plus bas).
- **À chaque livraison : une checklist exhaustive** de ce qu'il faut tester en usage réel (markdown, fichier `cap-<version>-checklist.md`, ignoré par git).
- **Mettre à jour `cap-specs.md`** à la fin de chaque lot ou session pour refléter l'état réel + les décisions reportées. Le commiter avec le code.
- Fichiers échangés : markdown, jamais de docx.
- 1 conversation = 1 mission claire.

## Stack
- **React 18 + Vite** (depuis V5 lot 3). Toute l'app est dans **`src/App.jsx`** (un seul module, migré tel quel depuis l'ancien `index.html`), le CSS dans **`src/styles.css`**, le rendu dans `src/main.jsx` ; `index.html` ne garde que le `<head>` (titre, favicon, Google Fonts). Dépendances npm figées par `package-lock.json` (react 18.3.1, @supabase/supabase-js 2.108.2). `npm run dev` pour le local, `npm run build` → `dist/`. Pas de TypeScript, pas de lint ; découpage en modules seulement s'il est validé.
- Typo Fraunces / DM Sans / JetBrains Mono ; thème papier crème, mode sombre via `[data-theme="dark"]` et variables CSS (`--ink`, `--paper`, `--rust`, `--ocean`, `--ochre`, `--moss`, `--violet`…).
- **Supabase** : auth email/mot de passe + table `cap_data` (`user_id`, `data` JSONB, `rev`, `updated_at`), RLS. Client nommé `sb` (pas `supabase`), créé en tête de `src/App.jsx` avec `createClient` importé.
- **Sync** : localStorage + sauvegarde cloud debouncée 1,5 s en compare-and-swap sur `rev` (`cloudSaveCAS`). Ne jamais réintroduire d'upsert inconditionnel. Version cloud plus récente → **fusion à 3 voies** (`integrateRemote` → `mergeStates` de **`src/sync-merge.js`**, module pur ; base commune en localStorage `-base`). Toute modification de `sync-merge.js` : `npm test` doit passer (et ajouter un test pour le nouveau cas).
- **PWA** (V5 lot 4) : `vite-plugin-pwa` en `injectManifest`, service worker `src/sw.js` (précache, push, clic notification), icônes dans `public/icons/`. Mise à jour proposée par un toast, jamais forcée.
- **Push** (V5 lot 4) : tables `push_subscriptions` et `reminders` (RLS), Edge Function `send-reminders` appelée chaque minute par pg_cron. Code serveur versionné dans `supabase/` (migrations + fonction) ; tout changement serveur passe par une migration commitée. **Aucun secret dans le repo ni dans la conversation** : ils sont générés et gardés dans le Vault Supabase. Les rappels sont calculés côté app par `computeReminders` / `sessionReminders` (source unique pour les minuteurs locaux et le push).

## Conventions de code
- **Schéma** : `SCHEMA_VERSION` + `migrateItem` / `migrateCap` / `migrateState`. Tout nouveau champ : défaut dans la migration ET dans `normalizeLoadedState` (qui conserve les clés inconnues — ne jamais revenir à une liste blanche).
- **Dates** : `dateToISO()` / `todayISO()` (heure locale), jamais `toISOString().slice(0, 10)`.
- Garde-fous produit (V4) : aucun score, pourcentage ou « retard » sur les caps ; questions plutôt que verdicts ; tout est sautable ; la période de pause coupe toute confrontation.
- Commentaires et textes d'interface en français.

## Déploiement
- Vercel (projet `cap`), prod : `https://cap-lac.vercel.app`. **Un push sur `main` = mise en production.** Tout push sur une autre branche = preview. Vercel build avec Vite (`vercel.json` : `npm ci`, `npm run build`, sortie `dist/`) ; un build en échec laisse la prod précédente en ligne → toujours vérifier `npm run build` avant de pousser.
- Process : travailler sur une branche, un commit par lot, pousser → l'utilisateur teste la preview → **fusion dans `main` uniquement sur son « go »**.
- La preview partage la base Supabase de la prod : le signaler, recommander un compte de test.

## Test headless
`npm ci` puis une **build de test** avec un faux Supabase : config temporaire à la racine du repo (supprimée après) qui fait `mergeConfig` de `vite.config.js` avec un alias `@supabase/supabase-js` → faux module (`createClient` renvoyant une session factice, des tables en mémoire `cap_data` / `reminders` / `push_subscriptions` avec les filtres utilisés, et `rpc`), sortie dans le dossier de travail. Pour le service worker (hors ligne, mise à jour) : servir la sortie sur `http://localhost` (contexte sécurisé), pas via l'interception de requêtes. La réception réelle d'une notification push ne se teste que sur un vrai appareil. Tests unitaires : `npm test` (`node --test`, `tests/*.test.js`). Synchro entre appareils : deux contextes Playwright isolés dont le faux Supabase passe par une base partagée côté Node (`exposeFunction`). Servir cette sortie via l'interception de requêtes Playwright (`playwright-core` installé dans le dossier de travail ; Google Fonts peut être renvoyé vide). Chromium : `/opt/pw-browsers`. Pour un changement censé ne rien modifier à l'écran : comparer les captures avant/après (pixelmatch).
