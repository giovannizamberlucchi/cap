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
- Un seul fichier **`index.html`** : React 18 + Babel standalone via CDN (unpkg), **pas de build**. Typo Fraunces / DM Sans / JetBrains Mono ; thème papier crème, mode sombre via `[data-theme="dark"]` et variables CSS (`--ink`, `--paper`, `--rust`, `--ocean`, `--ochre`, `--moss`, `--violet`…).
- **Supabase** : auth email/mot de passe + table `cap_data` (`user_id`, `data` JSONB, `rev`, `updated_at`), RLS. Client nommé `sb` (pas `supabase`).
- **Sync** : localStorage + sauvegarde cloud debouncée 1,5 s en compare-and-swap sur `rev` (`cloudSaveCAS`). Ne jamais réintroduire d'upsert inconditionnel.

## Conventions de code
- **Schéma** : `SCHEMA_VERSION` + `migrateItem` / `migrateCap` / `migrateState`. Tout nouveau champ : défaut dans la migration ET dans `normalizeLoadedState` (qui conserve les clés inconnues — ne jamais revenir à une liste blanche).
- **Dates** : `dateToISO()` / `todayISO()` (heure locale), jamais `toISOString().slice(0, 10)`.
- Garde-fous produit (V4) : aucun score, pourcentage ou « retard » sur les caps ; questions plutôt que verdicts ; tout est sautable ; la période de pause coupe toute confrontation.
- Commentaires et textes d'interface en français.

## Déploiement
- Vercel (projet `cap`), prod : `https://cap-lac.vercel.app`. **Un push sur `main` = mise en production.** Tout push sur une autre branche = preview.
- Process : travailler sur une branche, un commit par lot, pousser → l'utilisateur teste la preview → **fusion dans `main` uniquement sur son « go »**.
- La preview partage la base Supabase de la prod : le signaler, recommander un compte de test.

## Test headless
Les CDN peuvent être bloqués dans l'environnement cloud, mais npm fonctionne : installer `react@18.3.1`, `react-dom@18.3.1`, `@babel/standalone@7.26.4`, `playwright-core` dans un dossier de travail, servir ces fichiers via l'interception de requêtes Playwright, et remplacer `supabase-js` par un faux client (session factice + table `cap_data` en mémoire). Chromium : `/opt/pw-browsers`.
