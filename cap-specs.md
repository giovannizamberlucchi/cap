# Cap — Specs (V4 en cours) + Roadmap

> **État** (au 2026-09-23) : V3 livrée intégralement · V4 4a.1 (Boussole) + correctifs sync #1/#2 + logo/loader en prod · **Phase 4 (4a.2 → 4g) livrée en 8 lots, en prod depuis le 2026-09-23 (commit `24d726a`)** · **V5 cadrée (9 lots) — lots 1 et 2 en prod le 2026-09-23 · lot 3 (migration React + Vite) en prod le 2026-09-24 · lot 4 (PWA + push) en prod le 2026-09-24 · lot 5 (synchro par fusion) codé, en preview**. Schema version **14**.
> Specs maître unique, **versionnées dans le repo** (`cap-specs.md`, depuis le 2026-09-23) — la version vit dans le contenu (sections, statuts livré/à coder), pas dans le nom de fichier. Le repo est la source de vérité ; le projet Claude.ai n'en est plus qu'un reflet éventuel. Les règles de travail avec Claude sont dans `CLAUDE.md`.

App de productivité TDAH. Web déployée → futur mobile natif éventuel.

---

## Stack technique actuelle

**Frontend**
- React 18 + **Vite** (depuis V5 lot 3) : `src/App.jsx` (toute l'app, un seul module), `src/styles.css`, `src/main.jsx`, `index.html` réduit au `<head>` ; `npm run dev` / `npm run build` → `dist/`
- *Avant V5 lot 3 : un seul `index.html`, React + Babel standalone via CDN, sans build*
- Style : papier crème + accents chauds, mode sombre dispo
- Typo : Fraunces (titres) + DM Sans (corps) + JetBrains Mono (mono)

**Backend**
- Supabase (auth + base de données PostgreSQL)
- Table `cap_data` : stockage JSON par utilisateur (colonnes `user_id`, `data`, `rev`, `updated_at`)
- Row Level Security activé : chaque user voit uniquement ses données
- Auth email/password avec confirmation email activée

**Hébergement**
- Frontend sur **Vercel** : `https://cap-lac.vercel.app`
- Projet Vercel `cap` relié au repo GitHub : **chaque push sur `main` déploie en production** ; chaque push sur une autre branche crée une **preview** (protégée par la connexion Vercel).
- Process : les lots sont poussés sur une branche de travail → test sur la preview → fusion dans `main` sur validation = mise en prod.
- Repo GitHub (`giovannizamberlucchi/cap`) : code + specs (`cap-specs.md`) + règles de travail (`CLAUDE.md`)
- Supabase Auth : Site URL + Redirect URLs à pointer sur le domaine Vercel (le reset mot de passe redirige vers `window.location.origin`)
- *Ancien hébergement : Netlify `https://cap-adhd-prod-app.netlify.app` (drag & drop manuel) — remplacé par Vercel*

**Sync**
- localStorage en cache local (responsivité immédiate, fallback hors-ligne)
- Sauvegarde cloud avec debounce 1.5s après chaque modif
- Indicateur visuel : `Sync…` / `Synchro · il y a Xmin` / `⚠ Pas synchro depuis Xmin` (couleurs vert/orange/rouge)
- Stratégie : **versionning par révision (`rev`) + compare-and-swap** (cf. « Correctif sync #2 » plus bas). Un appareil ne peut plus écraser une version cloud plus récente. *(remplace le last-write-wins par timestamp)*
- **V5 lot 5** : en cas de version cloud plus récente, **fusion à 3 voies** (base commune gardée en local, `src/sync-merge.js`) au lieu de l'adoption en bloc ; vérification au retour sur l'app.

---

## V3 livrée — état actuel (S1 + S2A + S2B + S3 + S4 + S4.5 + S5 + S5.5 + Lot A→D + correctifs)

### Système de priorités
- 3 colonnes **Must / Should / Want** (matrice Eisenhower abandonnée)
- Inbox séparée pour le tri à froid
- Drag and drop entre colonnes
- Drag and drop pour réordonner dans une même colonne
- **Tri auto par défaut (V3 S4)** : Important ★ → Deadline asc → Date prévue asc → Durée courte → Énergie faible → CreatedAt asc
- **Réordo manuel** prime sur tri auto par colonne (`manualOrder`). Bouton "↻ Tri auto" apparaît en haut de colonne uniquement si l'ordre manuel est actif.
- **Sélection de tâche** (V3 S4) : clic sur carte = bordure rouge visible. Échap déselectionne. Sert au raccourci 1/2/3.
- **D&D 3 zones** (V3 S4) : tiers haut = insère before, tiers central = devient sous-tâche (rerooting), tiers bas = insère after. Réordo également dispo sur les sous-tâches dans une même branche.
- **Auto-scroll pendant drag** (V3 S4) : scroll auto près des bords haut/bas (zone 100px, vitesse proportionnelle).
- **Toggle "Afficher les récurrentes"** (V3 S5) : off par défaut, masque toutes les tâches récurrentes (incluant routines) des 4 colonnes Inbox + Must/Should/Want. Persisté dans `state.settings.showRecurringInPriorities`.

### Items
- **Type unique `task`** (V3 S5 : suppression du type `habit`). La distinction routine/récurrente passe par le booléen `streak`.
- Sous-tâches **profondeur infinie**
- Sous-tâches qui héritent de la config du parent à la création (catégorie, priorité, énergie, **date/heure/deadline**) — modifiables avant sauvegarde, le parent ne propage pas après création. Pas d'héritage de `recurrence` ni `streak`.
- Activation d'une récurrence sur un item vide automatiquement la `date` (cohérence : date d'exécution incompatible avec récurrence)
- Propriétés par item :
  - Titre + icône/emoji optionnel
  - Catégorie (avec couleur)
  - Date + heure d'exécution (one-shot) **ou** récurrence
  - **Échéance (deadline)** indépendante de la date d'exécution, sur tâche ET sous-tâche
  - Rappel local (5min, 15min, 30min, 1h, la veille) avec setTimeout — ⓘ nécessite Cap ouvert
  - Priorité (Must/Should/Want/Inbox)
  - Énergie requise (faible/moyen/haute) — **rendue via icône batterie 3 niveaux** depuis V3 S4
  - Durée estimée composée (semaines, jours, heures, minutes) — **saisie au pas de 5 min** (V3 S3). **Défaut 5 min à la création** (tâche et sous-tâche) depuis Lot A.
  - **Durée auto** = somme des sous-tâches si présentes, override manuel possible avec retour à l'auto
  - **Flag `isImportant`** (V3 S4) : RDV, échéance critique. Étoile ★ ochre + bordure 5px. Validation : nécessite date+heure OU deadline pour activer. **Lot B : les items `isImportant` sortent des colonnes Must/Should/Want** (ils vivent dans le bandeau RDV de l'accueil) — ils restent toutefois comptés dans la jauge capacité s'ils sont datés aujourd'hui.
  - **`completedAt`** (V3 S4) : timestamp de complétion, sert à l'archive.
  - **`prepDuration`, `travelDuration`, `travelReturn`** (V3 S4.5) : couronne autour d'un RDV important. N'ont d'effet que si `isImportant + time`. Valeurs préservées en interne sinon.
  - **`streak: bool`** (V3 S5) : suivre la régularité (routine). Visible uniquement si récurrence active. Désactivation conserve `history` en interne.
  - **`pinned: bool`** (Lot B) : épingle la tâche en tête de sa colonne (au-dessus du tri auto ET du tri manuel). Tâches de 1er niveau uniquement (pas les sous-tâches). Icône épingle sur la carte + indicateur 📌.
  - **`times: [iso]`** (Lot D) : créneaux multiples par jour pour une routine (ex. médoc 8h/14h/20h). Vide ou 1 entrée = comportement classique. ≥2 = la routine génère une occurrence par créneau, chacune cochable séparément. N'a d'effet que si `streak`.
  - **`slotHistory: { iso: [heures] }`** (Lot D) : créneaux faits par jour (source de vérité du cochage multi-créneaux). `history` (dates) en reste dérivé : une date n'y entre que si TOUS les créneaux du jour sont faits.
  - **`history: [iso]`** : dates de complétion. Utilisé par `computeStreak` (lazy) et la barre adaptative.
  - **`streakCount`, `graceDays`, `lastEvaluatedPeriod`** : champs morts depuis S5.5++ (rétrocompat). Suppression prévue S7.
  - Notes
  - Sous-tâches

### Récurrence (V3 S2A + S5 + S5.5)
- Règles supportées : `daily`, `weekly` (multi-jours), `monthly`, `yearly` (S5.5), `floatingWeekly` (S5), `floatingMonthly` (S5), `interval` (legacy)
- Granularité UI : **Aucune / Quotidien / Lun-Ven / Hebdo / Mensuel / Annuel / N×/semaine (jours libres) / N×/mois (jours libres) / Personnalisé**
- Personnalisé : tous les N jours/semaines/mois, multi-jours par semaine (lun+mer+ven possible)
- Fin de récurrence : pas de fin / jusqu'au [date] / après [N] occurrences
- Une seule heure pour toute la série (sauf flottantes : pas d'heure ; sauf routines multi-créneaux Lot D : plusieurs heures/jour)
- **Mensuel "fin de mois intelligent"** (S5.5) : si `monthDay > nb jours du mois courant`, occurrence tombe le dernier jour disponible. Warning UI dès jour ≥ 29.
- **Annuel** (S5.5) : `{ rule: 'yearly', monthDay, month, interval }`. Cap dynamique sur l'input jour selon le mois (29 max fév). Warning si 29 fév : ne se déclenche que les bissextiles.
- **Récurrences flottantes** (S5) : `floatingWeekly { count: N }` et `floatingMonthly { count: N }`. N complétions par période ISO. Quota atteint = item disparaît de "Routines du jour" mais reste cochable individuellement. Compteur "X/N cette semaine/ce mois" affiché.

### Routines (V3 S5 + S5.5)
- Onglet "Routines" (ex-Habitudes) : filtre `streak === true`
- Card affichant : flamme + compteur lazy (`computeStreak`) + label dynamique ("X jours/semaines/mois/années/fois de suite") + barre adaptative (`getStreakBars`) + alerte flottante si pertinent (`getFloatingAlertLevel`)
- Streak strict période à période : 1 période ratée = reset à 0 (pas de tolérance graceDays — concept retiré S5.5++)
- Tolérance période en cours : si pas encore atteinte, on ne casse pas le streak
- Cocher / décocher route via `toggleOccurrenceComplete(item.id, date, time?)` (auto-routing si `streak` ou `recurrence`)
- **Routines multi-créneaux** (Lot D) : une routine peut avoir plusieurs heures/jour (champ `times`, ≥2 créneaux). Chaque créneau devient une occurrence distincte dans l'agenda (jour/semaine/mois) et dans "Routines du jour", cochable séparément. **Streak tout-ou-rien** : le jour ne compte pour le streak que si TOUS les créneaux sont faits (confetti au dernier). Édition : section "Créneaux du jour" dans la modale (bouton "+ Plusieurs fois par jour" dans la section Heure, ou via le toggle "Suivre la régularité"). Cochage par créneau via l'agenda / la liste ; cochage sans heure (listes date-only) = bascule le jour entier.
- **Routines du jour triées par heure** (Lot D #12)

### Deadlines (V3 S2A)
- Champ `deadline` séparé de la date d'exécution
- Chip 5 niveaux selon proximité : neutre (>7j) / jaune (4-7j) / orange (2-3j) / rouge (≤1j) / rouge intense pulsant (en retard)
- Bordure de carte rougit dans les 24h, pulse en retard
- Warning visuel "⚠ après parent" si deadline sous-tâche > deadline parent

### Suggestion "Je commence par quoi ?"
- Scoring : priorité (Must +100, Should +50, Want +20) + date (aujourd'hui +80, demain +40) + **deadline (en retard +200, ≤1j +120, ≤3j +60, ≤7j +30)** + quick win (≤15min +15)
- Modal avec actions : plus tard / ▶ Démarrer (V5 lot 2 ; Entrée = Démarrer)

### Calendrier (V3 S2B + S3)
- 3 vues : **jour / semaine / mois**

#### Vue Jour (V3 S3 + S4)
- **Vue par défaut de l'agenda** depuis V3 S4 (avant : Semaine)
- **Label dynamique** : "Aujourd'hui" / "Demain" / "Après-demain" / date formatée selon la date affichée
- **Bouton retour aujourd'hui** : icône cible (au lieu du texte "Aujourd'hui" qui doublonnait avec le label)
- **Layout 2 colonnes** sur desktop (≥1100px) : agenda à gauche (max 560px) + colonne droite 320px ; stack vertical sur mobile.
- **Échelle 120px/h** (10px par tranche de 5 min) — précision 5 min sur tout (drop, resize, saisie durée).
- **Plage 24h** affichée d'un coup, scroll vertical, **auto-scroll vers 1h avant l'heure courante** au mount.
- **Tâches en blocs absolus** dimensionnés par leur durée. **Hauteur minimale 20 px** (V3 S4) pour assurer la visibilité de la checkbox même sur tâches très courtes.
- **Mode "tiny" déprécié** (V3 S4) : avec hauteur min 20 px, on n'entre plus dans ce mode. Restent compact (< 50px) et normal (≥ 50px).
- **Pas de hover/overlay au survol.** Tap (= click) sur un bloc :
  - 1er tap → overlay flottant à droite (titre, plage, durée, catégorie, bouton Modifier, bouton Fermer)
  - 2e tap sur le même bloc → ouvre la modale d'édition
  - Tap sur le fond → referme l'overlay
- **Resize** par poignée bord bas (drag vertical, snap 5 min, min 5 / max 8h). **Lot C1 : plus borné par la tâche suivante** (le chevauchement est désormais autorisé) — plafond fin de journée + 8h, réserve la place du trajet retour éventuel. Tooltip durée pendant le drag.
- **Chevauchement autorisé** (Lot C1) : drop, resize, modales et QuickAdd ne bloquent plus. Un toast informatif non bloquant signale le conflit (« ⚠ Chevauche X HH:MM–HH:MM ») mais l'action passe. **Rendu côte à côte** : les blocs qui se chevauchent se partagent la largeur en colonnes (algo de grappes `computeDayLanes`, façon Google Agenda). Vue jour uniquement.
- **Tâche avec sous-tâches** : parent invisible dans l'agenda. Drag du parent depuis les listes refusé avec toast.
- **Resize sur occurrence récurrente** : crée une exception `duration` qui ne touche pas la série.
- **Clic sur créneau vide** → ouvre la modale rapide pré-remplie date+heure du clic.
- **Ligne "maintenant"** affichée le jour courant.

##### Colonne droite (V3 S3 + S4)
1. **Bloc "★ Important / RDV"** (V3 S4) : tâches `isImportant=true` pour la date affichée, triées par heure. En tête de colonne, fond ochre clair.
2. **Intention du jour** (édition inline : clic sur le texte → textarea, Entrée valide, Échap annule). Persistée par jour dans `state.dailyIntentions`.
3. **Aujourd'hui sans heure** : items du jour courant sans heure (récurrents + one-shot).
4. **À caser** : Must sans date du tout, triés deadline asc → énergie asc → createdAt asc. Limite 5 affichés + bouton "Voir tout (N)" / "Voir 5 premiers". Drag vers la grille = ajoute date du jour + heure du drop.
5. **Jauge capacité compacte** (uniquement si `calDate === aujourd'hui`).
6. **Routines du jour** : liste cochables, **triées par heure** (Lot D), une ligne par créneau pour les routines multi-créneaux, clic ouvre la modale d'édition.

#### Vue Semaine (V3 S3 + S4)
- **Échelle 48px/h**, snap drop **15 min**.
- **Uniquement les tâches one-shot** (V3 S4) : récurrents et habitudes exclus, vivent en vue Jour + onglets dédiés. La vue semaine sert à voir le contexte des engagements ponctuels.
- **Bandeau gauche permanent "À planifier"** (~140px) sur desktop : one-shot sans heure de la semaine. Drag horizontal vers les colonnes jour. Stack en haut sur mobile.
- **Marqueur de densité** sous chaque en-tête de jour : segments colorés par priorité (rust=Must, ocean=Should, moss=Want, ochre=habit), 100% = 8h cumulées. Factuel, pas prédictif.
- **Hauteur min 18 px par bloc** (V3 S4) pour assurer la lisibilité des tâches courtes.
- **Tri hiérarchie complète** (V3 S4) : Important → Deadline → Date → Durée courte → Heure asc.
- **Détection chevauchement** (V3 S4) : si 2 tâches se superposent visuellement, la plus prioritaire est rendue, l'autre comptée dans une **pastille "+N" en haut de la colonne du jour**, clic = bascule vue Jour.
- **Étoile ★ ochre + fond ochre clair + bordure 5px** (V3 S4) sur blocs `isImportant`.
- **Jours passés** à 55% d'opacité (et leur en-tête à 60%).
- **Clic sur en-tête de jour** → bascule vue jour de ce jour.
- Auto-scroll vers heure courante au mount.
- Pas de resize ni overlay sur les blocs (cliquer = ouvrir l'édition directement).

#### Vue Mois (V3 S3 + S4)
- Grille 7×6 conservée, alignement lundi → dimanche.
- **Lignes égales** (V3 S4) : `grid-template-rows: auto repeat(6, minmax(110px, 1fr))`, overflow caché par cellule.
- **Alignement jours corrigé** (V3 S4) : `dateToISO()` en local au lieu de `toISOString()` UTC qui décalait selon fuseau horaire.
- **Uniquement les tâches one-shot** (V3 S4) : récurrents et habitudes exclus.
- **Tri hiérarchie complète** (V3 S4) : Important → Deadline → Date → Priorité (Must/Should/Want) → Durée courte → Énergie low → Heure asc.
- **Étoile ★ ochre + fond ochre clair + bordure gauche** (V3 S4) sur items `isImportant`.
- **Deadlines surbrillance** sur les items dont la deadline tombe ce jour : bordure rust si deadline = jour, pulsation si en retard.
- **Fond saturé selon densité** : 1-2 items = neutre, 3-4 = légèrement assombri, 5-6 = plus, 7+ = marqué.
- **Simple-clic sur case (fond)** → bascule vue jour.
- **Style type Google Agenda** (Lot C2) :
  - Pastilles fines : **dot de couleur catégorie** (ou ★ ochre si RDV important) + **heure** + titre.
  - Tri agenda : important ★ d'abord, puis horodatés **par heure croissante**, puis sans-heure.
  - 3 pastilles max par cellule, puis **"+N autres" → popover** (panneau flottant `position:fixed` qui déplie toute la journée sur place ; clic event = édition, clic en-tête = vue jour, clic ailleurs = ferme). Remplace l'ancien "+N" qui basculait en vue jour.
  - Pas d'events multi-jours en barres (le modèle Cap n'a pas de tâches multi-jours).

#### Comportements transverses calendrier
- **Tâches récurrentes affichées sur toutes leurs occurrences** via moteur `expandItemsForRange`.
- **Cocher une occurrence** = exception `'completed'` pour cette date seule, les autres restent intactes.
- **Drag d'occurrence** vers autre créneau = exception silencieuse `{ date, time, duration? }` (template intact). L'override duration éventuelle est conservée si on déplace.
- **Détection chevauchement** sur plages `[start, end[`, pas seulement même heure de début.
- **Modal scope "Cette occurrence / Futures / Série"** à la modif et à la suppression d'une occurrence récurrente.
- Modif "Cette occurrence" : approche pragmatique → tâche dérivée one-shot + exception `'deleted'` sur l'origine.
- Modif "Futures" : split la série (ancienne `endDate = veille`, nouvelle créée à partir de l'occurrence).
- Modif/suppression "Série" : touche le template directement (avec undo via Ctrl+Z).
- Sous-tâches avec date/récurrence ≠ parent : visibles dans l'agenda. Sous-tâche avec date identique au parent : ignorée pour éviter doublon.
- Navigation prev/next/aujourd'hui.

### Modale rapide d'ajout (V3 S3)
- Champs : titre (focus auto), priorité (Must/Should/Want/Inbox boutons radio), date + heure (step 5 min), durée par boutons rapides (5/15/30/1h/2h/autre), catégorie.
- **Entrée** = enregistre.
- **+ détails** → bascule vers modale complète avec champs pré-remplis.
- **Triggers** : bouton "Nouveau" du header, raccourci `N`, clic sur créneau vide de l'agenda.
- Signale le chevauchement à la sauvegarde (toast info non bloquant, Lot C1) si date+heure renseignés.

### Saisie d'heure (TimeInput, V3 S4)
- Composant unifié pour tous les inputs heure (ItemModal, QuickAdd, récurrence, habitude)
- `<input type="time" step="300">` (flèches navigateur incrémentent par 5 min)
- **Snap 5 min au blur** : si saisie clavier 11:31, snap auto à 11:30
- **4 boutons custom** entourant l'input :
  - À gauche : `▲h` (+1 heure) / `▼h` (-1 heure)
  - À droite : `▲5` (+5 min) / `▼5` (-5 min)
- Bornes 00:00 → 23:55

### Chevauchement autorisé (V3 S4 → Lot C1)
**Historique** : bloqué partout en S4 (refus dur). **Lot C1 : le chevauchement est désormais autorisé** (cas d'usage : prise de médoc 11h pendant un RDV 10h–12h).
- Drop agenda, resize, ItemModal (création + édition), QuickAdd : **ne bloquent plus**.
- Un **toast informatif non bloquant** signale le conflit (« ⚠ Chevauche X HH:MM–HH:MM », `formatConflictToast`) — l'action passe quand même.
- Vue jour : rendu **côte à côte** en colonnes (`computeDayLanes`). Vue semaine : conserve le système "+N" (colonnes trop étroites pour le côte-à-côte).

### Filtre récurrents/habitudes en agenda (V3 S4)
- Vue Semaine et Vue Mois : seules les tâches one-shot apparaissent (récurrents et habitudes masqués pour ne pas saturer)
- Vue Jour : tout reste affiché (one-shot + récurrents + habitudes du jour)

### Recherche & filtres (V3 S4)
- **Barre de recherche** unifiée Priorités + Archive
- **Toggles scope** : Titres / Notes / Sous-tâches (tous actifs par défaut, désactivables individuellement)
- **Recherche insensible casse + accents** (NFD normalize), highlight jaune sur le titre matché
- **Panneau filtres avancés** repliable à côté de la barre, avec compteur chip rouge si filtres actifs
- **Familles de filtres** :
  - Énergie (low / medium / high)
  - Durée (<15min / 15–30 / 30–60 / >1h / sans durée)
  - Échéance (En retard / Aujourd'hui / Cette semaine / **Ce mois / Ce trimestre** / Sans échéance)
  - Catégorie (toutes les catégories existantes + sans catégorie)
- **Logique** : AND entre familles, OR à l'intérieur (énergie low + medium = soit l'un soit l'autre, mais doit aussi matcher la catégorie sélectionnée)
- **Bouton "Effacer les filtres"** actif si ≥ 1 filtre

### Archive (V3 S4)
- **Archive immédiate au check** : tâche cochée → disparaît des listes Priorités, Boîte, Habitudes (sauf le jour J en agenda où elle reste grisée)
- **Triple filet de sécurité** :
  1. Toast undo 5s avec bouton "Annuler" qui décoche
  2. Cmd/Ctrl+Z dans la stack undo unifiée prof 10
  3. Restauration manuelle depuis vue Archive (bouton "↺ Restaurer")
- **Vue Archive dédiée** dans la nav, compteur sur l'onglet
- **Groupement par semaine** (lundi → dimanche), plus récente en haut
- **Recherche dans archive** avec mêmes toggles que la recherche principale
- **Sous-tâches archivées uniquement avec le parent** (cohérence arbre)

### Bandeau "En retard" (V3 S4)
- Affiché en haut de Priorités si au moins une tâche en retard
- 5 max visibles + bouton "Voir tout (N)"
- Inclut occurrences récurrentes manquées des 14 derniers jours (limite anti-explosion)
- Boutons par tâche :
  - **✓ Fait** (Lot A) : coche/archive (occurrence pour une récurrente, archive pour one-shot)
  - **↳ Aujourd'hui** (Lot A) : report au jour même
  - **📅 Demain** : un clic, reporte au lendemain
  - **📆 Autre** : input date inline + OK
- Pour les récurrentes : crée une exception `move` sans toucher la série

### Visibilité importante / RDV (V3 S4 + Lot B)
- **Flag `isImportant`** sur tâches : étoile ★ ochre + bordure marquée 5px
- **Validation à l'activation** : nécessite date+heure OU deadline (souplesse pour "passeport avant l'été" sans heure précise). Si invalide à la save : shake + bordure rouge + message d'erreur
- **Lot B — Bandeau "★ RDV & échéances"** en tête de l'accueil (Priorités) : liste les RDV importants d'aujourd'hui + à venir, triés par date/heure, 5 max + "voir tout". Les RDV importants **sortent des colonnes Must/Should/Want** (fini la pollution). Les RDV en retard restent dans le bandeau "En retard". Un RDV daté aujourd'hui reste compté dans la jauge capacité.
- **Rendu visuel renforcé** dans toutes les vues calendrier :
  - Vue Jour : fond ochre clair + étoile en gras + bordure 5px ochre + box-shadow
  - Vue Semaine : pareil + box-shadow ochre
  - Vue Mois : ★ ochre + fond ochre clair sur la pastille
- **Bloc "★ Important / RDV"** dans agenda Jour colonne droite, calé sur **la date affichée** (pas seulement aujourd'hui).
- Bandeau "Aujourd'hui" sur Priorités supprimé (V3 S4) au profit du bloc agenda + header badge + bandeau RDV (Lot B).
- **Case "Terminé"** (Lot B) : en tête de la modale d'édition, valide/archive sans repasser par la liste (one-shot → archive ; occurrence récurrente → coche l'occurrence du jour).
- **Dupliquer** (Lot A) : bouton dans la modale d'édition (tâche et sous-tâche) → clone l'arbre entier, suffixe `(copie)`, sans date/heure, reste hérité.

### Header badge "Prochaine échéance" (V3 S4)
- Affiché en haut du header (à côté de l'indicateur sync) si au moins une tâche `isImportant` avec heure à venir aujourd'hui
- Format : pastille ronde rouge + heure + titre tronqué + countdown ("dans 2h15")
- Bouton X pour le masquer pour la session (revient au reload)
- Filtre strict isImportant (les tâches avec heure non-important ne déclenchent pas)

### Stack undo unifiée (V3 S4)
- Cmd/Ctrl+Z annule la dernière action quelle qu'elle soit : delete, complete, reorder, reparent, postpone, changement priorité (raccourci ou D&D)
- **Profondeur 10** (avant : 5)
- Implémentation : snapshot complet de `state.items` deep-cloné JSON, restauré au pop

### Check-in matinal
- Popup à la première ouverture du jour
- 4 modes prédéfinis : Fusée 🚀 (8h), Normale ☀️ (6h), Tranquille 🌿 (4h), Survie 🌧️ (2h)
- Option "Autre — au feeling" : saisie libre du nombre d'heures
- Modifiable à tout moment via bouton dans le header

### Jauge de capacité quotidienne
- **Logique "feuilles planifiées"** (V3 S2A) : pas de double comptage parent/sous-tâches
  - Parcourt l'arbre, pour chaque item planifié aujourd'hui : si descendant planifié → on compte les feuilles, sinon on compte l'item
- Affiche **estimé** (océan en plein) + **réel** (rouille hachurée superposée)
- Avertit quand dépassement (passe en rouge)
- Ne bloque pas l'ajout de tâches
- Présente dans le header global et dans la colonne droite vue jour (version compacte)

### Session « Démarrer » (V5 lot 2 — remplace « Pomodoro avec cycles » + « Mode focus »)
- **Une seule action ▶ Démarrer** (carte de tâche, suggestion) : lance le chrono ET ouvre le plein écran. ▶ sur la tâche déjà en cours = rouvre le plein écran.
- **Plein écran** (disque géant, sous-tâches, plan en barres) ⇄ **bandeau** (Réduire / Échap ; ⤢ ou F pour revenir). La session continue dans les deux.
- **Plan** (D = durée focus des réglages) : tâche ≤ D → une tranche = sa durée ; > D → D, pause, D, …, reste (reste < 5 min ajouté à la dernière tranche) ; sans durée → pomodoro classique en boucle. Pauses / longue pause selon réglages. Tâche entamée → plan sur estimé − déjà passé (min 5 ; estimation dépassée → une tranche D) ; récurrentes → toujours la durée complète.
- **Fin du plan** : cloche + « Temps prévu écoulé. C'est fini ? » → ✓ Fini / +5 min / Je m'arrête là.
- **Fini** (à tout moment, plein écran ou bandeau) : temps enregistré, chrono arrêté, tâche cochée (occurrence du jour pour une récurrente), puis **bilan neutre** « Estimé X · Réel Y » (réel = cumul de la tâche ; « cette fois » pour une récurrente) + ressenti ☀️/😴 facultatif (tâches non récurrentes). Pas de toast dans ce cas.
- **Arrêter / Je m'arrête là** : temps enregistré, pas de bilan. **⏭** : passe à la phase suivante, le temps déjà passé est gardé.
- **Démarrer une autre tâche** pendant une session : le temps de la première est enregistré (toast).
- **Chrono fiable** : temps restant calculé depuis l'heure de fin (`endsAt`), pas de dérive en arrière-plan / veille. Session gardée en localStorage (`cap-app-v2-<user>-running`, cet appareil seulement) → survit au rechargement. Les phases s'enchaînent sur l'horaire prévu ; une pause terminée depuis > 1 min (Cap endormi/fermé) ne relance pas seule la tranche suivante : elle attend en pause (au plus une tranche comptée pendant une absence).
- **Comptage** : chaque tranche terminée → `actualMinutes` + entrée `focusLog` (prime time) ; 🍅 (`pomosDone`) seulement pour une tranche complète (≥ D). Tranche interrompue → `actualMinutes` seulement.
- Raccourcis : F = plein écran de la session, Espace = pause/reprise.

### Catégories
- 4 par défaut : Travail / Perso / Santé / Admin
- Personnalisables (nom + couleur) dans Réglages
- Création à la volée depuis le formulaire d'item

### Authentification (V3 S1)
- Login/signup email + mot de passe
- Confirmation email obligatoire
- Session persistante entre rechargements
- **Récupération mot de passe** : reset email Supabase + écran nouveau mdp + auto-connexion après update
- **Suppression de compte** : delete cap_data + clear localStorage + signOut, confirmation par saisie email exact (note : compte auth Supabase reste, à clean Phase 3)
- Bouton déconnexion dans le header
- Données isolées par utilisateur (RLS Supabase)

### Multi-device
- Accès depuis n'importe quel navigateur via l'URL Vercel (`cap-lac.vercel.app`)
- Installable comme PWA basique sur tel et ordi (pas de manifest ; favicon = logo Cap depuis le 2026-09-20)
- Mêmes données partout grâce à la sync cloud

### Sync (V3 S1)
- localStorage en cache local (responsivité immédiate, fallback hors-ligne)
- Sauvegarde cloud avec debounce 1.5s après chaque modif
- **Indicateur "Synchro · il y a Xmin"** : couleurs vert/orange/rouge, tick toutes les 30s
- Stratégie : **versionning par révision (`rev`) + compare-and-swap** depuis le correctif du 2026-07-13 (cf. « Correctif sync #2 »). *(avant : last-write-wins par timestamp)*

### Raccourcis clavier (V3 S1 + S3 + S4)
- `N` → ajout rapide (V3 S3, avant : modale complète)
- `Shift+N` → modale complète (V3 S3)
- `/` → focus capture rapide
- `F` → plein écran de la session en cours
- `Espace` → pause/reprise de la session
- `Échap` → ferme modal (hiérarchie : bilan de session > settings > checkin > suggestion > editingItem > showAddModal > showQuickAdd > plein écran de session (= Réduire) > **désélection tâche**)
- `Cmd/Ctrl+Z` → undo dernière opération (V3 S4 : stack unifiée prof 10 incluant delete, complete, reorder, reparent, postpone, priority)
- `Entrée` → valide la modale ouverte avec validation contextuelle (titre rempli, important = date+heure ou deadline). Sinon shake + bordure rouge + toast.
- **`1` / `2` / `3`** → déplace la tâche sélectionnée vers Must / Should / Want (V3 S4, nécessite avoir cliqué sur une tâche pour la sélectionner)
- Liste affichée dans Réglages (détection ⌘ Mac vs Ctrl)

### Animations satisfaisantes
- Pop sur checkbox cochée
- Confettis à la complétion
- Flamme qui grandit avec le streak des habitudes
- Modal qui zoom in
- Cartes qui glissent au survol

### Mode sombre
- Bascule en haut (icône lune/soleil)
- Préférence sauvegardée
- Lignes de grille agenda visibles, texte cal-task et cal-block adaptés, checkboxes cal-task adaptées, boutons ghost (X, +, target, play) suivent `--ink`, inputs date/time avec `color-scheme: dark`

### Habitudes → Routines (depuis V3 S5)
- Onglet dédié « Routines » (ex-Habitudes) — détail dans la section Routines plus haut
- Streak strict période à période (jours de grâce retirés en S5.5++)
- Barres adaptatives selon le type de récurrence (S5.5) ; 14 derniers jours = fallback custom
- Récurrence avancée disponible (cf. section Récurrence)
- Heure optionnelle pour caler dans l'agenda
- Cochables aussi depuis la colonne droite vue jour (V3 S3)

### Export / Import
- Export JSON de toutes les données (inclut `dailyIntentions` depuis V3 S3)
- Import JSON avec confirmation

### Schema migrations
- Migration auto via `migrateState` au load (local + cloud)
- v3 → v4 : ajout du champ `dailyIntentions` (par défaut `{}`)
- v4 → v5 (V3 S4) : ajout des champs `isImportant: false` et `completedAt: null` sur tous les items + sous-tâches
- v5 → v6 (V3 S4.5) : ajout des champs `prepDuration: null`, `travelDuration: null`, `travelReturn: false` sur tous les items + sous-tâches
- v6 → v7 (V3 S5) : `type === 'habit'` → `type: 'task'` + `streak: true` ; ex-tâches récurrentes `streak: false` ; `frequency` obsolète nettoyée
- v7 → v8 (Lot B) : ajout `pinned: false`
- v8 → v9 (Lot D) : ajout `times: []` et `slotHistory: {}` (par défaut vides → aucune routine existante affectée)
- v9 → v10 (V4 4a.1) : ajout `capId: null` sur tous les items + sous-tâches (filiation tâche → cap). Au niveau `state` : ajout `caps: []` et `visions: []`. Aucune donnée V3 affectée.
- v10 → v11 (V4 4a.2/4a.3) : sur chaque cap `reachedAt`, `statusChangedAt`, `decisions: []` ; au niveau `state` : `lowMode`, `reviews { weekly, monthly }`, `weeklyFocus`.
- v11 → v12 (V4 4b/4c) : `pillars: []` + `feel: null` sur les items, `pillars: []` sur les caps ; `state.quits: []`, `state.money { entries, flows }`.
- v12 → v13 (V4 4f) : `state.focusLog: []`.
- **Version courante : 13**
- **Chargement unifié** (V4 lot 1) : `normalizeLoadedState` remplace les trois listes blanches (local, cloud, import) et **conserve les clés inconnues** → une version plus ancienne ne peut plus effacer des données plus récentes. ⚠️ Au moment de la mise en prod, recharger tous les onglets ouverts (un onglet resté sur l'ancienne version, lui, efface encore les clés qu'il ne connaît pas).
- ⚠️ Note : la colonne DB `rev` (correctif sync #2) est **hors** `migrateState` — c'est une colonne Postgres, pas un champ du blob JSON.

---

## V4 4a.1 livrée — Boussole (architecture temporelle, socle)

Première brique de V4. Fait passer Cap du *to-do* à la *boussole* : relier le quotidien (tâches) à une direction (vision/objectifs). Conception validée dans `cap-4a-architecture-temporelle.md`.

### Modèle de données (schema v10)
- **`state.visions: [{ id, text, createdAt }]`** — texte libre (sommet narratif, 1 an et +). Multi-visions possible. `id` sert de cible à `visionLink`.
- **`state.caps: [Objectif]`** — arbre séparé de `state.items` (jamais fondu dedans, pour ne pas polluer colonnes/agenda/tri).
  - **Objectif** `{ id, kind:'objective', title, why, visionLink, deadline, measure, status, children, createdAt }` — résultat visé (~3 mois).
  - **Projet/Jalon** = même objet récursif `{ id, kind:'node', title, why, deliverable, deadline, measure, status, children, createdAt }`. Le rendu **Projet vs Jalon dépend de la profondeur, pas du type** (`capDisplayKind(depth)` : 0 = objectif, 1 = projet, ≥2 = jalon).
  - `status` : `active / reached / paused / abandoned`.
  - **Avancement** = enfants directs franchis / total (jamais récursif profond) — « 2/4 jalons ».
- **`item.capId: null`** sur la tâche — filiation optionnelle vers n'importe quel nœud (objectif OU projet/jalon). La lignée complète (Vision › Objectif › Projet › Jalon) se déduit en remontant les liens — zéro re-tagging.

### Garde-fous appliqués (du doc 4a)
- **`why` obligatoire sur l'objectif** (racine de la confrontation), **optionnel sur projet/jalon**.
- **Mesure optionnelle** (3 modes : aucune / atteint-pas atteint / chiffré cible+unité+courant) sur objectif **et** nœud. **Purement informationnelle** : jamais de barre auto ni de franchissement automatique.
- **Franchir = manuel** (bouton). Un objectif s'« atteint », un projet se « termine », un jalon se « franchit ».
- **Un cap n'est jamais « en retard »** : deadline indicative, jamais de rouge pulsant. Échéance passée → affichée « · échue » en neutre (la confrontation viendra en 4a.2).
- **Abandon célébré** (toast « c'est une décision, pas un échec »), pause assumée.
- **Plafond soft** : warning non bloquant à ≥3 objectifs actifs.

### Vue Boussole (onglet 🧭, à côté de Priorités/Agenda/Routines)
- Vision(s) repliable(s) en tête (édition au blur), objectifs en cartes, projets/jalons imbriqués au rendu différencié (carte projet / ⚑ jalon pointillé).
- **Réordonnancement des nœuds par flèches ↑↓** (drag-drop des nœuds volontairement reporté). Statut, éditer, supprimer (avec délien des tâches, pas suppression). « + projet/jalon », « + tâche » (préremplit `capId`).
- **Tâches liées rendues avec le composant `TaskCard` lui-même** (via `BoussoleTaskCtx`) → comportement **identique à la vue Priorités** : D&D 3-zones (haut/bas = ordre, centre = imbrication en sous-tâche), cases, édition, sous-tâches, durées. Seules les tâches « de tête » sont listées (parent non lié au même cap) ; leurs sous-tâches viennent avec via le rendu arborescent. Une tâche reste une seule entité dans toute l'app — pas de double arbre.
- Sur la carte tâche en Priorités : **chip 🧭** cliquable (cap direct) ; lignée complète dans la modale via le select « Cap rattaché ».

### Hors périmètre 4a.1 (→ 4a.2 / 4a.3)
- Couche **confrontation** + signal de **pace** (porté par les jalons), détection **cap zombie**, **mode bas régime** (kill-switch). → 4a.2
- **Rituel hebdo** unique (doux → qui-pique → souveraineté) + focale mensuelle direction. → 4a.3
- Tagging par pilier, pilier argent, dashboard flux → 4b et suite (un cap n'a pas besoin de son pilier pour exister, `why` porte le sens en attendant).
- **Drag-drop des nœuds** (reporté), **re-rattachement d'une tâche à un autre cap par drag** (retiré — passe par le select de la modale ; entrait en conflit avec le D&D de réordo).

### Décisions actées en 4a.1
- `caps`/`visions` = arbres séparés de `items` (architecture).
- Filiation = un seul `capId` posé une fois, lignée déduite (pas de re-tagging).
- Plafonds soft partout (pas de verrou dur).
- Onglet nommé **« Boussole »** (évite la collision avec le nom de l'app).
- Réordo nœuds = flèches ; réordo/imbrication tâches = D&D via `TaskCard`.

## Correctif sync critique (perte de données au back/forward) — livré

**Symptôme** : indicateur « synchro » au vert mais perte de tout en utilisant les flèches précédent/suivant du navigateur.

**Cause** : (1) la sauvegarde cloud *debouncée* (1,5 s) était annulée à la navigation, donc le cloud restait périmé ; (2) au rechargement, le chargement cloud **écrasait systématiquement le local** (priorité cloud), même quand le local était plus récent — puis réécrivait cet état amputé partout.

**Fix** :
- **Last-write-wins par timestamp** : `cloudLoad` renvoie `updated_at` ; chaque sauvegarde confirmée stocke ce timestamp en local (`${STORAGE_KEY_USER}-cloudts`). Au chargement, on n'adopte le cloud que s'il est **strictement plus récent** que la base locale connue. Sinon on garde le local (qui sera repoussé au cloud). Garde de transition : si pas de base locale connue mais local non vide → on garde le local (jamais d'écrasement aveugle).
- **Flush à la fermeture** : sur `pagehide` + `visibilitychange:hidden`, écriture localStorage synchrone + tentative de sauvegarde cloud immédiate (le debounce ne peut plus être avalé par la navigation).
- Limite connue : last-write-wins reste par timestamp (multi-appareils : la session la plus récente gagne ; auto-corrigé dès la 1re sauvegarde sur chaque appareil).

> ⚠️ **Superséde par le Correctif sync #2 (2026-07-13)** : le mécanisme de décision par **timestamp** (`-cloudts`) a été remplacé par un **numéro de révision + compare-and-swap** (voir ci-dessous), car il causait une perte de données au changement d'appareil. Le flush `pagehide`/`visibilitychange` de ce correctif est conservé.

## Correctif sync #2 — perte de données au changement d'appareil (révision + CAS) — livré 2026-07-13

**Symptôme** : ouverture sur un 2e appareil (téléphone) rarement utilisé → affiche de vieilles données ; retour sur l'appareil principal (PC) → tâches récentes effacées, « rétrogradées » à la version du téléphone.

**Cause** : le last-write-wins par **timestamp stocké par appareil** (`-cloudts`) était fragile. Sur un appareil sans base timestamp connue (1re exécution de cette version, ou appareil peu utilisé), la garde « ne pas écraser un local non-vide d'âge inconnu » **conservait le local périmé puis le repoussait au cloud** avec un timestamp neuf → écrasait la version récente du PC. De plus, `cloudSave` faisait un **upsert inconditionnel** (aucun contrôle de ce qu'il écrasait). Au retour sur PC, celui-ci voyait le cloud « plus récent » et adoptait la version périmée.

**Fix (remplace la décision par timestamp)** :
- **Colonne `rev` (bigint, défaut 0)** ajoutée à `cap_data` : compteur de révision **monotone**, insensible au décalage d'horloge entre appareils.
  - Migration DB manuelle (hors `migrateState`) : `alter table public.cap_data add column if not exists rev bigint not null default 0;`
- **Décision de chargement par révision** (`cloudLoad` renvoie aussi `rev`) : on n'adopte le cloud que si sa `rev` est **strictement supérieure** à la `rev` connue de l'appareil (`${STORAGE_KEY_USER}-cloudrev`). Suppression de la garde « local non-vide d'âge inconnu » qui causait le bug.
- **Sauvegarde en compare-and-swap** (`cloudSaveCAS`) : `UPDATE … WHERE rev = base`. 0 ligne touchée = un autre appareil a écrit entre-temps → **on n'écrase pas**, on recharge. Insert à `rev = 1` si aucune ligne n'existe.
- **Résolution de conflit** : avant d'adopter une version cloud plus récente, le local non synchronisé est **stashé** (`${STORAGE_KEY_USER}-conflict`) — jamais de perte silencieuse.
- Le flush `pagehide` / `visibilitychange` (correctif #1) est conservé, désormais via le CAS.

**Limites connues** :
- Transition à la 1re ouverture post-fix : toutes les lignes démarrent à `rev = 0` ; le 1er appareil qui sauvegarde pose `rev = 1` et fait référence, les autres l'adoptent.
- Édition **strictement simultanée** sur 2 appareils (même fenêtre de quelques secondes) : le perdant du CAS adopte la version du gagnant (son état est stashé, pas perdu). Un vrai *merge par tâche* serait la V2 (usage multi-appareils actif).
- **Déploiement** : à l'époque du fix, Netlify en drag & drop manuel (un `git push` ne déployait pas). Hébergement désormais sur Vercel (`cap-lac.vercel.app`).

## V4 Phase 4 livrée — lots 1 à 8 (en prod depuis le 2026-09-23)

Cadrage validé le 2026-09-23 (recos : pas de jauge sans jalon daté, focus hebdo unique, mensuel = 4e écran du rituel, onglet unique « Piliers », heatmap horaire abandonnée). Un commit par lot.

### Lot 1 — 4a.2 : rythme, question d'échéance, période de pause (schema v11)
- **Rythme** (`capPace`) sur projet/jalon uniquement, depuis les jalons **datés** (enfants directs, abandonnés exclus) : `still` rien n'a bougé (jalon échu, aucun franchi) · `behind` un jalon attend · `ahead` en avance (franchi avant sa date, rien d'échu en attente) · `ok` ça colle. **Sans jalon daté : rien d'affiché** (la « jauge grossière » de la spec est abandonnée — fausse précision). Rendu : mention neutre « Rythme · … », jamais de couleur d'alerte.
- **Question d'échéance** (`CapDeadlineQuestion`) : projet/jalon actif dont la deadline est passée → « L'échéance du X est passée. Tu en fais quoi ? » Repousser (date, défaut +14 j) / Réduire le livrable (ouvre l'édition) / Classer (terminé-franchi · en pause · ça ne compte plus) / plus tard. Réponse consignée dans `decisions` avec `forDeadline` : la question ne revient qu'à la prochaine échéance ; « plus tard » = 7 jours de silence. Objectifs : toujours « · échue » neutre, pas de question (confrontation douce au mensuel).
- **Période de pause** (`state.lowMode { on, since }`) : bouton dans l'en-tête Boussole, bandeau « 🌙 Période de pause depuis le X » + Reprendre. Coupe rythme, questions, invitation au rituel, écran 2 du rituel, focale mensuelle, repères de caps dans l'agenda.
- `setCapStatus` pose `statusChangedAt` et `reachedAt` (null si réactivé).

### Lot 2 — 4a.3 : rituel hebdo
- **Invitation** (`WeeklyReviewInvite`) en haut de Priorités du **vendredi 17h au lundi soir**, jamais de popup ; « pas cette semaine » la saute. Accès manuel : bouton « Point de la semaine » dans la Boussole. Semaine regardée : ven→dim = semaine en cours ; lundi = semaine écoulée.
- **Modale en 3 écrans**, chaque écran « passer », pas de fermeture au clic sur le fond (on ne perd pas ce qui est écrit) :
  1. *Qu'est-ce qui a compté ?* — tâches bouclées (avec leur cap), routines cochées, intentions du jour de la semaine, champ libre facultatif.
  2. *Où en sont tes projets ?* — rappel des `why` des objectifs ; projets `still`/`behind` : chaque jalon échu en question (Franchi / Repousser de 2 semaines / Ça m'a échappé / Ça ne compte plus) ; **caps zombies** (objectifs et projets actifs sans activité depuis 21 j ; un projet déjà questionné sur son rythme ou dont l'objectif est zombie n'est pas re-questionné) : Pause assumée / Ça m'a échappé / Ça ne compte plus. « Ça m'a échappé » propose de **caser une petite tâche** liée au cap (Must, 15 min, datée du lundi suivant).
  3. *La semaine qui vient, qu'est-ce qui compte ?* — **un seul focus** : un cap actif et/ou quelques mots.
- **Focus** : `weeklyFocus[semaine suivante]`, pastille « ✦ Cette semaine : X » dans l'en-tête (clic → Boussole) et en tête de Boussole ; **+40** dans « Je commence par quoi ? » pour les tâches dont la lignée contient le cap focus.
- **Dernière activité d'un cap** calculée (`capLastActivity`) : création/statut/décisions du sous-arbre + création/complétion des tâches liées. Répondre à une question compte comme activité → silence naturel de 3 semaines.
- Données : `reviews.weekly[YYYY-Www] = { mattered, doneAt } | { skippedAt }`.

### Lot 3 — focale mensuelle
- Pas de second rituel : **1er rituel du mois (jusqu'au 10)** → 4e écran facultatif « Et ce mois-ci, la direction ? » : vision(s) relue(s), chaque objectif actif avec son `why` + « Toujours aligné ? » (Oui / À ajuster / Plus vraiment : pause / Plus vraiment : lâcher), puis **cap du mois** (objectif ou projet).
- Réponses dans `decisions` (trigger `alignment`) ; `reviews.monthly[YYYY-MM] = { doneAt, monthCapId }` ; pastille « ◆ Ce mois-ci : X » en tête de Boussole. L'écran compte comme fait dès qu'il a été vu.

### Lot 4 — 4b : piliers, ressenti, ce que j'arrête (schema v12)
- `PILLARS` = Énergie / Argent / Lien / Alignement (le Temps est mesuré, pas tagué). Sélecteur facultatif dans la modale tâche et la modale cap ; chips sur les cartes cap.
- **Héritage calculé** (`itemPillars`) : une tâche sans pilier propre prend ceux de sa lignée de caps (union), rappelé dans la modale (« Hérité du cap : … »).
- **Ressenti a posteriori** : le toast de complétion d'une tâche ponctuelle propose ☀️ / 😴 (`item.feel` = `up` / `down`), non bloquant.
- **Ce que j'arrête** (`state.quits`, onglet Routines) : streak inversé « X jours sans » (`quitStreak` = depuis le dernier écart ou la création), 14 derniers jours, bouton « J'ai craqué aujourd'hui » réversible, copie sans jugement. **Hors moteur de récurrence** : jamais dans l'agenda, le retard, la capacité ni la suggestion.

### Lot 5 — 4c : argent (onglet « Piliers » › Argent)
- Nouvel onglet **Piliers** (icône balance) avec deux sous-onglets : Vases communicants (défaut) / Argent.
- Entrées / Sorties / Solde net par **jour / semaine / mois** avec navigation ; saisie rapide (± , montant « 12,50 » accepté, libellé facultatif, date) ; liste des mouvements, lignes à venir estompées.
- **Flux récurrents** mensuels (jour N, fin de mois intelligente) ou hebdo (jour de semaine), comptés automatiquement sans générer d'opérations ; « arrêter » = `until` aujourd'hui (historique gardé), supprimer = retire tout.
- `state.money = { entries: [{ id, date, amount (centimes), dir: 'in'|'out', label }], flows: [{ id, label, amount, dir, rule: 'monthly'|'weekly', day, since, until }] }`. Euros uniquement. Pas un outil bancaire.

### Lot 6 — 4d : vases communicants (+ vue semaine « usage C » de 4g)
- Période semaine / mois. Tuiles : temps réalisé (réel pomodoro si mesuré, sinon estimé), **sur tes caps vs quotidien**, ressenti ☀️/😴, solde net.
- Barres : « Le quotidien et le long terme » (caps vs quotidien) ; temps par pilier (+ « Sans pilier ») et Sens = Lien + Alignement ; énergie (modes du check-in, ce que tu arrêtes) ; **tendance 8 semaines** caps/quotidien avec légende, info-bulles et « Voir en tableau ».
- Calcul (`computeTimeSpent`) : feuilles seulement (pas de double compte parent/sous-tâches) ; routines = durée × occurrences cochées ; une tâche à deux piliers compte dans les deux. Aucun score, aucun pourcentage.
- Couleurs : `--violet` (caps, plus clair en sombre) et gris encre (quotidien) ; l'identité passe toujours par le libellé de ligne ou la légende.

### Lot 7 — 4f : prime time (schema v13)
- `state.focusLog` : `{ at, min, itemId }` à chaque pomodoro de focus terminé (1000 dernières entrées).
- `computePrimeTime` : ≥ 10 sessions sur 60 j étalées sur ≥ 14 j → heure de pointe de démarrage élargie à 2 h vers le voisin le plus fourni. Affiché dans Piliers › Énergie comme observation (« Une observation, pas une consigne »). Aucune notification.

### Lot 8 — 4g : les caps dans l'agenda, vue Année
- **Vue Mois** : repères violets sous le numéro du jour pour les échéances des caps actifs (◆ objectif · ▸ projet · ⚑ jalon), clic → Boussole. Masqués en période de pause.
- **Vue Année** (bouton « Année ») : 12 mini-mois, densité des tâches ponctuelles datées, jours d'échéance de cap soulignés, aujourd'hui cerclé ; clic mois → vue Mois, clic jour → vue Jour ; liste « Échéances de tes caps en AAAA ».
- Heatmap horaire vue Mois : **abandonnée** (doublon avec le lot C2). Pastilles catégories : déjà là (C2).

### Limites connues / reporté
- Pace sans `reachedAt` pour les jalons franchis avant v11 → jamais « en avance » sur ces anciens jalons.
- « Réduire le livrable » consigne la réponse avant l'édition : annuler l'édition ne ramène pas la question.
- Ressenti ☀️/😴 uniquement sur les tâches ponctuelles (pas sur les occurrences de routine).
- Période de pause : réglage dans la Boussole uniquement (pas dans Réglages).
- Focus hebdo et cap du mois : pas de mise en avant dans les colonnes Priorités (seulement en-tête, Boussole, suggestion).

## Identité visuelle — logo + écran de chargement — livré 2026-09-20

- **`<CapMark />`** : mark « barre à roue » (piste 2A) en SVG inline, monochrome (`currentColor`) + un rayon d'accent sur `--ocean` → suit le thème. Utilisé en en-tête (remplace le titre « Cap », mot conservé en texte masqué dans le `<h1>` pour les lecteurs d'écran), écran de connexion et récupération de mot de passe.
- **Favicon** : même mark sur tuile papier, traits épaissis (lisible 16→64px, onglet clair et sombre). Remplace l'emoji boussole.
- **`<CapLoader />`** : écran de chargement animé — rayons allumés en séquence sur deux tours, roue figée au nord, étoile polaire, boucle. Halo sur `--ocean`. `prefers-reduced-motion` → état d'arrivée direct.
- Retrait des emojis boussole redondants dans les intitulés + icône compas de la ligne de date.
- **Mentions TDAH retirées de l'interface** : `<title>` = « Cap — ton rythme, ton énergie » ; écran de connexion « Productivité » (au lieu de « Productivité TDAH »). Le positionnement TDAH reste dans les specs et les commentaires de code, pas dans l'UI.

---

## V4 4a.2 / 4a.3 — design (principes) — ✅ codé, voir « V4 Phase 4 codée » plus haut

*(Conception validée, issue de `cap-4a-architecture-temporelle.md`, désormais intégrée ici. S'appuie sur le socle 4a.1.)*

### 4a.2 — Couche confrontation + signal de pace

**Principe** : la confrontation **ne combat pas l'inaction, mais la dérive inconsciente**. Ne rien faire sur un projet peut être le bon choix ; le problème c'est de dériver *sans le voir*. Le rêve ne crie jamais — l'app donne une voix au silencieux pour que l'inaction redevienne un *choix*, pas un oubli. L'ennemi : « le silence passe inaperçu », pas « tu n'en fais pas assez ».

**La voix = une question, jamais un verdict.** Constat brut + souveraineté immédiate (« … tu valides ? »). Trois réponses **toutes légitimes** :
1. **Pause assumée** → le cap s'endort, zéro culpabilité, enregistré comme conscient.
2. **Ça m'a échappé** → là seulement, l'app propose un coup de pouce (caser une petite tâche la semaine suivante). Aide à se rebrancher, ne sermonne pas.
3. **Ça ne compte plus** → cap retiré, et **célébré** (lâcher un objectif mort = victoire). (Déjà implémenté en 4a.1 sur l'abandon.)

**Signal de pace — porté par les jalons, zéro tracking d'heures.** Les jalons ont deadline + état franchi → ils sont le métronome. Le calendrier dit où tu *devrais* être, l'état des jalons où tu *es*, l'écart donne 4 niveaux :

| Niveau | Condition |
|---|---|
| **rien** | aucun jalon bougé, une échéance déjà passée |
| **un peu en retard** | un jalon échu pas encore franchi |
| **ok** | jalons franchis collent au calendrier |
| **en avance** | jalons franchis avant les dates |

- Le tranchant vient du **contraste déclaration/réalité**, pas de la précision horaire (mesurer les heures = surveillance + exclusion de l'immesurable → écarté).
- Sans jalon daté : jauge grossière sur la deadline finale du projet. Raison de plus de poser des jalons.
- **S'applique à projet/jalon uniquement** (date + livrable concret). **Objectif/Vision : jamais de chrono**, confrontation douce (alignement/sens) seulement.

**« Retard » sur un cap : jamais.** Une tâche peut être en retard (chip rouge V3 légitime). Un cap non : deadline de projet passée → l'app **demande** (« repousser / réduire le livrable / classer ? »). Question + options + souveraineté, jamais de rouge pulsant ambiant. *(4a.1 affiche déjà « · échue » en neutre ; la question interactive est à coder ici.)*

**Cap zombie** (seule exception où l'app parle d'elle-même) : rien depuis ~3 semaines → l'app rompt le silence **une fois, doucement, au bilan** (« pause assumée ou perte de sens ? »). Jamais en alarme quotidienne.

**Kill-switch — mode bas régime** : « période de pause » coupe **toute** confrontation, détection zombie et nudge ; caps en sommeil silencieux. La confrontation s'*invite*, ne *poursuit* jamais.

### 4a.3 — Rituel hebdo unique + focale mensuelle

**Un seul rituel hebdo** (fusion mini-bilan + confrontation — deux rituels, un cerveau TDAH en lâche un, et ce serait le qui-pique).

**Ordre non négociable : doux → qui-pique → souveraineté.**
1. **« Qu'est-ce qui a compté cette semaine ? »** — rétrospectif, ouvert, sans jugement. Ancrage sur le réel/le positif.
2. **« Où en sont tes projets ? »** — la jauge de pace remonte ici, en questions, sur terrain déjà apaisé.
3. **« La semaine qui vient, qu'est-ce qui compte ? »** — clôture = rendre la main. Le « one thing » se pose comme conséquence du regard porté, pas comme case à remplir.

> Inverser (pace en premier) ouvrirait sur « voilà ce que tu n'as pas fait » → onglet claqué. L'ordre, c'est ce qui fait qu'on revient.

**Forme** : intégralement **sautable**, **pas de streak**, **court** (trois respirations). Coupé par le mode bas régime.

**Mensuel** = autre focale : la **direction** (objectifs + alignement vision). Plus rare, contemplatif. L'hebdo regarde l'exécution, le mensuel regarde le cap.

### Garde-fous 4a (verrouillés, valent pour tout V4 4a)
- Aucun **streak / % / score** sur les caps. Aucune notion de **« retard »** sur un cap.
- `why` court (obligatoire objectif, optionnel nœud — acté 4a.1). Rattachement toujours optionnel.
- **Plafonds en soft** (warning, pas verrou). Bilans jamais obligatoires, sautables, sans streak. Mode bas régime coupe tout.
- Différence Cap-libérateur vs Cap-prison : ce que l'app dit quand on n'a rien fait (question, pas jugement), friction d'entrée faible, pas de « retard » sur les caps, célébration (pas punition) quand on lâche un cap.

### Décisions (tranchées au cadrage du 2026-09-23)
- **Filiation tâche → cap** : ✅ tranchée et codée en 4a.1 (`capId` unique, lignée déduite).
- **Plafonds** : soft ; **focus hebdo principal unique** (focus désigné, pas de compteur, pas de secondaires).
- **Écrans** du rituel, mensuel (4e écran du 1er rituel du mois) et rendu du pace (mention neutre, rien sans jalon daté) : ✅ codés.
- **Mesure d'objectif** : optionnel acté et codé (4a.1).

---

## V5 — cadrage validé le 2026-09-23 (lots 1-4 en prod, lot 5 en preview, lots 6-9 à coder)

**Thème : fiabilité du quotidien + planification par semaine.** Ouverture (partage, testeurs, Android natif, domaine) → plus tard. Ajustements fins : à l'usage.

### Lots (ordre)
| Lot | Contenu |
|---|---|
| 1 | S7 irritants (dette V3) + tri par échéance |
| 2 | S6 « Démarrer » |
| 3 | Migration vers React + Vite (build) — ajouté le 2026-09-24 |
| 4 | PWA + notifications push |
| 5 | Synchro : fusion par tâche en cas de conflit |
| 6 | Sentry + suppression complète du compte Supabase |
| 7 | Heures libres (semaine d'abord) + alerte de surcharge |
| 8 | Remplissage auto de la journée |
| 9 | Import calendrier externe (Google) |

### Lot 1 — S7 irritants ✅ en prod (2026-09-23)
- **Date/heure passée à la création** : avertissement non bloquant ; jamais sur les routines (rattrapage).
- **Trajet retour asymétrique** : champ retour séparé, prérempli avec l'aller.
- **Badge « en retard de prep »** : reste visible en ocre jusqu'à l'heure du RDV.
- **Archive** : suppression définitive à l'unité + « Vider l'archive » avec confirmation.
- **Pluriels** des labels streak ; **suppression des champs morts** `streakCount`, `graceDays`, `lastEvaluatedPeriod` (schema v14) ; **revue complète du mode sombre**.
- **Tri par échéance** dans Priorités : bouton qui bascule sur une liste unique triée par deadline (les filtres Échéance ne font que filtrer les colonnes).
- Onglet « Deadlines » : abandonné. Prep/trajet modifiés sur une occurrence qui touchent le template : laissé tel quel (rien remonté à l'usage).
- **Implémentation** :
  - Avertissement à la création (`warnOnCreate`, QuickAdd + modale complète) : fusionne l'info chevauchement et « ⏳ … est déjà passé — tâche créée quand même ». Jamais sur une tâche récurrente ni une routine. Pas à l'édition.
  - Trajet retour : `travelReturnDuration` (null = identique à l'aller) ; case « 🔄 Trajet retour » toujours disponible, sélecteur prérempli avec l'aller, « Aucun » décoche. La couronne du RDV (agenda, chevauchements) utilise la durée retour.
  - Badge en-tête : prep/départ dépassé mais RDV pas commencé → badge ocre « RDV HH:MM · … · préparation prévue à HH:MM, RDV dans X ».
  - Archive : poubelle par tâche (annulable) + « Vider l'archive » (confirmation, annulable par Ctrl+Z / Annuler).
  - Pluriels : « 1 jour / semaine / année de suite ».
  - Schema **v14** : `streakCount`, `graceDays`, `lastEvaluatedPeriod` retirés à la migration et plus jamais écrits.
  - Tri par échéance : case « Trier par échéance » (persistée `settings.sortByDeadline`) à côté de « Afficher les récurrentes » ; liste unique groupée En retard / Aujourd'hui / Cette semaine / Ce mois-ci / Plus tard / Sans échéance, étiquette de priorité par ligne. Échéance effective = la plus proche entre la tâche et ses sous-tâches ouvertes. Recherche et filtres s'appliquent. RDV importants exclus (ils vivent dans le bandeau).
  - Mode sombre : bouton « + Nouvelle » catégorie (fond blanc) corrigé, `.btn-ghost` transparent par défaut ; raccourcis 1/2/3 sur une ligne dans Réglages ; en-tête qui ne se tasse plus quand le badge RDV est long.

### Lot 2 — S6 « Démarrer » ✅ en prod (2026-09-23)
Spec d'origine : une seule action « Démarrer » ; plein écran par défaut, bascule mini-fenêtre ; tâche ≤ D (focus pomodoro) → démarre sur sa durée estimée, bilan estimé/réel ; tâche > D → tranches D → pause → … → reste.
- **Cadrage validé** : bouton 🎯 « Mode focus » retiré (cartes + suggestion) ; « Quitter » remplacé par Réduire / Arrêter / Fini ; relance d'une tâche entamée sur le reste ; reste < 5 min fusionné ; bilan neutre + ressenti ; **ajout hors spec d'origine** : chrono sur heure de fin + session persistée localement.
- **Bugs corrigés** : « Fini » en plein écran laissait tourner le chrono sans enregistrer le temps ; démarrer une autre tâche écrasait le chrono sans enregistrer son temps.
- Détail : voir « Session « Démarrer » » dans la partie V3 (fonctionnel). Code : `buildSessionPlan`, `sessionPlanMinutes`, `runningLeft`, `stepRunning` (pur), `startTask` / `finishSession` / `extendSession` / `skipPhase` / `stopTask` dans l'app, `SessionSummaryModal`. `toggleComplete(item, { silent })`.
- Pas de changement de schéma (session locale, hors `state`). Pas de push (lot 4) : cloche + notification locale si Cap ouvert.
- **Reporté** : Démarrer depuis l'agenda (overlay vue Jour).

### Lot 3 — Migration vers React + Vite ✅ en prod (2026-09-24)
Ajouté au cadrage le 2026-09-24 : passer au build **avant** la PWA (qui en dépend : `vite-plugin-pwa`) et supprimer la compilation Babel dans le navigateur (~1-2 s à chaque ouverture sur téléphone, fichier au-delà de la limite de 500 Ko de Babel). SvelteKit écarté (réécriture complète de ~10 000 lignes, rendu serveur inutile pour une app privée derrière un login).
- **Migration mécanique** : le script Babel devient `src/App.jsx` **tel quel** (imports React / supabase-js en tête, `export default AuthGate`), le CSS devient `src/styles.css` tel quel, `src/main.jsx` fait le rendu, `index.html` ne garde que le `<head>` (titre, favicon, Google Fonts) et `<div id="root">`. Seule ligne de code changée : `window.supabase.createClient` → `createClient` importé.
- **Dépendances npm figées** (`package-lock.json`) : react / react-dom 18.3.1, @supabase/supabase-js 2.108.2 (mêmes versions que les CDN) ; dev : vite 8, @vitejs/plugin-react 6. Node 22.
- **Vercel** : `vercel.json` (framework vite, `npm ci`, `npm run build`, sortie `dist/`). Build en échec = la prod précédente reste en ligne.
- Rien d'autre : pas de découpage en modules, pas de TypeScript, pas de lint (plus tard, progressivement). Données, clés localStorage, Supabase, schéma v14 : inchangés.
- **Vérifié** : mêmes parcours et mêmes données sur l'ancienne et la nouvelle version, 25 captures comparées au pixel (tous les onglets, agenda jour/semaine/mois/année, modales, sombre, mobile, Démarrer) → identiques, hors animations en cours ; même état final des données ; aucune erreur JS. Bundle : 170 Ko gzip (+ 6 Ko CSS) au lieu de React + Babel standalone + source JSX.

### Lot 4 — PWA + push ✅ en prod (2026-09-24)
**Cadrage validé** (2026-09-24) : PWA installable et hors ligne, push via Supabase, **+ rappels sur les récurrentes / routines** (manque constaté : le rappel était masqué dès qu'il y avait une récurrence) **+ push des fins de phase « Démarrer »**. Plus de demande d'autorisation au premier clic.

**PWA**
- `vite-plugin-pwa` en `injectManifest` : service worker maison `src/sw.js` (Workbox) — précache du build, navigation → `index.html` précaché, Google Fonts en cache (CSS revalidée, polices 1 an), réception du push, clic sur la notification.
- Manifest généré (Cap, papier `#F4EFE6`, standalone, fr) ; icônes `public/icons/` (192, 512, maskable 512, apple-touch 180, badge 96 monochrome) générées depuis le mark du favicon ; balises iOS dans `index.html`.
- **Mise à jour** : `registerType: 'prompt'` → `main.jsx` enregistre le SW (`registerSW`) et émet `cap:need-refresh` → toast « ✨ Nouvelle version de Cap · Recharger » (jamais de rechargement forcé). Remplace le « recharge tous tes onglets » après une mise en prod (à partir de la version suivante).

**Rappels (calcul unique)**
- `computeReminders(items, now, 14)` : tâches datées avec heure + rappel (heure de partir si RDV avec trajet), **et occurrences des récurrentes / routines** (un rappel par créneau pour les routines multi-créneaux ; occurrences cochées, sautées, créneaux faits exclus ; récurrences flottantes exclues faute d'heure). Clé stable `r:<item>:<date>T<heure>:<délai>`.
- `sessionReminders(running, titre, réglages)` : simule l'enchaînement prévu d'une session (sans pause, 12 phases max) → fins de tranche / de pause / temps prévu écoulé. Effacés à la pause, à l'arrêt, sur Fini ; recréés à la reprise.
- Modale : « Rappel · à chaque occurrence » proposé aussi pour une récurrente / routine à heure fixe.
- **Minuteurs locaux** (Cap ouvert) : même calcul ; **désactivés sur un appareil abonné au push** (et `notify()` muet) → pas de doublon ; la cloche et les toasts de session restent.

**Push (Supabase, première brique serveur)**
- Tables `push_subscriptions` (un abonnement par appareil et par compte, `unique(user_id, endpoint)`) et `reminders` (`primary key (user_id, key)`, `sent_at`), RLS « les siens ».
- L'app réécrit les rappels à venir (2 s après un changement de tâches ou de session, + toutes les heures / au retour sur l'onglet) : upsert par clé + suppression des rappels futurs disparus ; un rappel déjà envoyé n'est jamais renvoyé ; `test:*` jamais supprimés par l'app.
- Edge Function **`send-reminders`** (Deno, `verify_jwt` off, protégée par l'en-tête `x-cap-cron`) appelée **chaque minute par pg_cron** (`cap-send-reminders`, pg_net) : réclame les rappels dus en une requête UPDATE (pas de double envoi), abandonne ceux en retard de plus de 10 min, chiffre avec `web-push` (`generateRequestDetails`) et envoie en `fetch` natif (TTL 10 min, urgence haute), supprime les abonnements morts (404/410), purge les rappels de plus de 2 jours.
- **Secrets générés dans Supabase, jamais ailleurs** : `cap_cron_secret` (aléatoire, en base), paire VAPID P-256 générée par la fonction au premier appel (WebCrypto) et rangée dans le Vault (`cap_push_store_vapid`, une seule fois). L'app lit la clé **publique** via `cap_vapid_public_key()` (autorisé aux connectés, voulu). Config lue par `cap_push_config()` (clé de service uniquement).
- SQL versionné dans `supabase/migrations/`, fonction dans `supabase/functions/send-reminders/`. `pg_net` dans le schéma `extensions`.
- **Clic sur une notification** : ramène Cap au premier plan (message `cap:open-item`) ou l'ouvre sur `/?item=<id>` → modale de la tâche (ou plein écran si c'est la session en cours).
- **Réglages › Notifications** (par appareil) : Activer / Désactiver / « Envoyer une notification de test » (arrive dans la minute) ; états refusé / non géré / « sur iPhone, installe d'abord Cap ». Déconnexion = l'appareil ne reçoit plus les notifications du compte ; suppression du compte = abonnements et rappels effacés.
- **Vérifié** : chiffrement Web Push sous Deno (déchiffrement contrôlé), chaîne serveur de bout en bout (rappel dû → envoi → abonnement mort supprimé), calcul des rappels (routine 2 créneaux, heure de partir, hebdo, flottante exclue, coche → retiré), rappels de session (5 phases, pause / reprise / arrêt), SW actif, hors ligne, lien `?item=`, toast de mise à jour ; non-régression visuelle (seuls les Réglages changent). **La réception réelle d'une notification ne se teste que sur un vrai appareil.**
- **Limites** : iPhone → Cap installé sur l'écran d'accueil (iOS 16.4+) ; précision ~1 min (pg_cron) ; les fins de phase d'une session sont envoyées à **tous** les appareils abonnés du compte.

### Lot 5 — Synchro ✅ codé (2026-09-24, en preview)
Spec d'origine : en cas de conflit, fusion à 3 voies par tâche au lieu d'adopter tout le cloud ; même tâche modifiée des deux côtés → la plus récente gagne, l'autre en stash.
- **Constat au cadrage** : 2 chemins de perte — (1) sauvegarde refusée (CAS) → local mis de côté en bloc (`-conflict`, invisible) et cloud adopté ; (2) au démarrage, cloud plus récent adopté **même si l'appareil avait des modifications non envoyées** (perdues sans stash). Angle mort : un onglet ouvert ne voyait jamais les changements faits ailleurs.
- **Module `src/sync-merge.js`** (pur, premier module sorti de `App.jsx`, validé) : `mergeStates(base, local, cloud, { localNewer })` → `{ merged, conflicts }`.
  - Champ par champ : le côté qui a changé par rapport à la base gagne ; les deux → **vrai conflit** : la plus récente gagne (`localNewer` = dernière modif locale vs `updated_at` du cloud), l'autre valeur est renvoyée dans `conflicts`.
  - **Arbres** (`items`/`subtasks`, `caps`/`children`) : aplatis par id (champs + parent + position) → pas de doublon en cas de déplacement ; parent supprimé mais enfant gardé → parent ressuscité.
  - Listes d'objets à id (visions, argent, arrêts, catégories…) : élément par élément. Listes de valeurs / objets sans id (`history`, créneaux, `focusLog`…) : ensembles, ajouts et retraits combinés. Objets (réglages, rituels, `exceptions`, `slotHistory`…) : clé par clé. Clés inconnues : fusionnées pareil.
  - **Supprimé d'un côté, modifié (contenu ou position) de l'autre → gardé**, version modifiée entière.
  - Compteurs `actualMinutes` / `pomosDone` : incréments additionnés. Horodatages techniques (`completedAt`, `statusChangedAt`, `reachedAt`…) : tranchés sans être signalés.
  - Ordre : ordre local, les nouveautés du cloud insérées avant leur successeur (sinon à la fin).
- **Tests** : `npm test` (`node --test`, aucune dépendance) — 22 tests dont 3000 fusions aléatoires (pas de doublon, aucun ajout perdu, rien d'intact supprimé, aucune modification perdue même si l'autre côté a supprimé).
- **Intégration (`App.jsx`)** : `integrateRemote(remote)` —
  - version commune (`-base` en localStorage, = dernier état écrit ou adopté) ; heure de dernière modif locale (`-lastedit`) ;
  - rien changé localement depuis la base → adoption ; sinon fusion → si la fusion diffère du cloud, elle repart en CAS sur la nouvelle révision ;
  - pas encore de base (1re synchro après la mise à jour, cloud en avance) → ancien comportement (local mis de côté dans `-conflict`, sauf appareil neuf jamais modifié) ; base créée dès que l'appareil est à jour ;
  - appelée : CAS refusé, démarrage (cloud en avance), **retour sur l'app** (`visibilitychange`, 15 s mini entre deux vérifications, jamais pendant une sauvegarde).
  - Saisie pendant la fusion : refusionnée par-dessus (rien d'écrasé).
- **Conflits** : toast « Synchro : N conflit(s) — version la plus récente gardée · Voir » ; **Réglages › Synchro** (visible seulement s'il y a des conflits) : tâche, champ, gardé / mis de côté, « Reprendre l'autre version » (tâches), OK, Tout effacer. 50 derniers, en localStorage.
- **Vérifié** (2 appareils simulés sur une base partagée) : onglet pas à jour → coche + renommage conservés ; retour sur l'app → changements récupérés ; vrai conflit → plus récente gagne + liste + reprise ; modifs hors ligne + rechargement → fusionnées, rien de perdu. Non-régression visuelle OK.
- Pas de changement de schéma ni de serveur. **Limite** : départage des vrais conflits à l'horloge des appareils (décalage possible ; l'autre valeur reste récupérable). Pas de temps réel (Supabase Realtime) : vérification au retour sur l'app.

### Lot 6 — 4d : vases communicants (+ vue semaine « usage C » de 4g)
- Période semaine / mois. Tuiles : temps réalisé (réel pomodoro si mesuré, sinon estimé), **sur tes caps vs quotidien**, ressenti ☀️/😴, solde net.
- Barres : « Le quotidien et le long terme » (caps vs quotidien) ; temps par pilier (+ « Sans pilier ») et Sens = Lien + Alignement ; énergie (modes du check-in, ce que tu arrêtes) ; **tendance 8 semaines** caps/quotidien avec légende, info-bulles et « Voir en tableau ».
- Calcul (`computeTimeSpent`) : feuilles seulement (pas de double compte parent/sous-tâches) ; routines = durée × occurrences cochées ; une tâche à deux piliers compte dans les deux. Aucun score, aucun pourcentage.
- Couleurs : `--violet` (caps, plus clair en sombre) et gris encre (quotidien) ; l'identité passe toujours par le libellé de ligne ou la légende.

### Lot 7 — 4f : prime time (schema v13)
- `state.focusLog` : `{ at, min, itemId }` à chaque pomodoro de focus terminé (1000 dernières entrées).
- `computePrimeTime` : ≥ 10 sessions sur 60 j étalées sur ≥ 14 j → heure de pointe de démarrage élargie à 2 h vers le voisin le plus fourni. Affiché dans Piliers › Énergie comme observation (« Une observation, pas une consigne »). Aucune notification.

### Lot 8 — 4g : les caps dans l'agenda, vue Année
- **Vue Mois** : repères violets sous le numéro du jour pour les échéances des caps actifs (◆ objectif · ▸ projet · ⚑ jalon), clic → Boussole. Masqués en période de pause.
- **Vue Année** (bouton « Année ») : 12 mini-mois, densité des tâches ponctuelles datées, jours d'échéance de cap soulignés, aujourd'hui cerclé ; clic mois → vue Mois, clic jour → vue Jour ; liste « Échéances de tes caps en AAAA ».
- Heatmap horaire vue Mois : **abandonnée** (doublon avec le lot C2). Pastilles catégories : déjà là (C2).

### Limites connues / reporté
- Pace sans `reachedAt` pour les jalons franchis avant v11 → jamais « en avance » sur ces anciens jalons.
- « Réduire le livrable » consigne la réponse avant l'édition : annuler l'édition ne ramène pas la question.
- Ressenti ☀️/😴 uniquement sur les tâches ponctuelles (pas sur les occurrences de routine).
- Période de pause : réglage dans la Boussole uniquement (pas dans Réglages).
- Focus hebdo et cap du mois : pas de mise en avant dans les colonnes Priorités (seulement en-tête, Boussole, suggestion).

## Identité visuelle — logo + écran de chargement — livré 2026-09-20

- **`<CapMark />`** : mark « barre à roue » (piste 2A) en SVG inline, monochrome (`currentColor`) + un rayon d'accent sur `--ocean` → suit le thème. Utilisé en en-tête (remplace le titre « Cap », mot conservé en texte masqué dans le `<h1>` pour les lecteurs d'écran), écran de connexion et récupération de mot de passe.
- **Favicon** : même mark sur tuile papier, traits épaissis (lisible 16→64px, onglet clair et sombre). Remplace l'emoji boussole.
- **`<CapLoader />`** : écran de chargement animé — rayons allumés en séquence sur deux tours, roue figée au nord, étoile polaire, boucle. Halo sur `--ocean`. `prefers-reduced-motion` → état d'arrivée direct.
- Retrait des emojis boussole redondants dans les intitulés + icône compas de la ligne de date.
- **Mentions TDAH retirées de l'interface** : `<title>` = « Cap — ton rythme, ton énergie » ; écran de connexion « Productivité » (au lieu de « Productivité TDAH »). Le positionnement TDAH reste dans les specs et les commentaires de code, pas dans l'UI.

---

## V4 4a.2 / 4a.3 — design (principes) — ✅ codé, voir « V4 Phase 4 codée » plus haut

*(Conception validée, issue de `cap-4a-architecture-temporelle.md`, désormais intégrée ici. S'appuie sur le socle 4a.1.)*

### 4a.2 — Couche confrontation + signal de pace

**Principe** : la confrontation **ne combat pas l'inaction, mais la dérive inconsciente**. Ne rien faire sur un projet peut être le bon choix ; le problème c'est de dériver *sans le voir*. Le rêve ne crie jamais — l'app donne une voix au silencieux pour que l'inaction redevienne un *choix*, pas un oubli. L'ennemi : « le silence passe inaperçu », pas « tu n'en fais pas assez ».

**La voix = une question, jamais un verdict.** Constat brut + souveraineté immédiate (« … tu valides ? »). Trois réponses **toutes légitimes** :
1. **Pause assumée** → le cap s'endort, zéro culpabilité, enregistré comme conscient.
2. **Ça m'a échappé** → là seulement, l'app propose un coup de pouce (caser une petite tâche la semaine suivante). Aide à se rebrancher, ne sermonne pas.
3. **Ça ne compte plus** → cap retiré, et **célébré** (lâcher un objectif mort = victoire). (Déjà implémenté en 4a.1 sur l'abandon.)

**Signal de pace — porté par les jalons, zéro tracking d'heures.** Les jalons ont deadline + état franchi → ils sont le métronome. Le calendrier dit où tu *devrais* être, l'état des jalons où tu *es*, l'écart donne 4 niveaux :

| Niveau | Condition |
|---|---|
| **rien** | aucun jalon bougé, une échéance déjà passée |
| **un peu en retard** | un jalon échu pas encore franchi |
| **ok** | jalons franchis collent au calendrier |
| **en avance** | jalons franchis avant les dates |

- Le tranchant vient du **contraste déclaration/réalité**, pas de la précision horaire (mesurer les heures = surveillance + exclusion de l'immesurable → écarté).
- Sans jalon daté : jauge grossière sur la deadline finale du projet. Raison de plus de poser des jalons.
- **S'applique à projet/jalon uniquement** (date + livrable concret). **Objectif/Vision : jamais de chrono**, confrontation douce (alignement/sens) seulement.

**« Retard » sur un cap : jamais.** Une tâche peut être en retard (chip rouge V3 légitime). Un cap non : deadline de projet passée → l'app **demande** (« repousser / réduire le livrable / classer ? »). Question + options + souveraineté, jamais de rouge pulsant ambiant. *(4a.1 affiche déjà « · échue » en neutre ; la question interactive est à coder ici.)*

**Cap zombie** (seule exception où l'app parle d'elle-même) : rien depuis ~3 semaines → l'app rompt le silence **une fois, doucement, au bilan** (« pause assumée ou perte de sens ? »). Jamais en alarme quotidienne.

**Kill-switch — mode bas régime** : « période de pause » coupe **toute** confrontation, détection zombie et nudge ; caps en sommeil silencieux. La confrontation s'*invite*, ne *poursuit* jamais.

### 4a.3 — Rituel hebdo unique + focale mensuelle

**Un seul rituel hebdo** (fusion mini-bilan + confrontation — deux rituels, un cerveau TDAH en lâche un, et ce serait le qui-pique).

**Ordre non négociable : doux → qui-pique → souveraineté.**
1. **« Qu'est-ce qui a compté cette semaine ? »** — rétrospectif, ouvert, sans jugement. Ancrage sur le réel/le positif.
2. **« Où en sont tes projets ? »** — la jauge de pace remonte ici, en questions, sur terrain déjà apaisé.
3. **« La semaine qui vient, qu'est-ce qui compte ? »** — clôture = rendre la main. Le « one thing » se pose comme conséquence du regard porté, pas comme case à remplir.

> Inverser (pace en premier) ouvrirait sur « voilà ce que tu n'as pas fait » → onglet claqué. L'ordre, c'est ce qui fait qu'on revient.

**Forme** : intégralement **sautable**, **pas de streak**, **court** (trois respirations). Coupé par le mode bas régime.

**Mensuel** = autre focale : la **direction** (objectifs + alignement vision). Plus rare, contemplatif. L'hebdo regarde l'exécution, le mensuel regarde le cap.

### Garde-fous 4a (verrouillés, valent pour tout V4 4a)
- Aucun **streak / % / score** sur les caps. Aucune notion de **« retard »** sur un cap.
- `why` court (obligatoire objectif, optionnel nœud — acté 4a.1). Rattachement toujours optionnel.
- **Plafonds en soft** (warning, pas verrou). Bilans jamais obligatoires, sautables, sans streak. Mode bas régime coupe tout.
- Différence Cap-libérateur vs Cap-prison : ce que l'app dit quand on n'a rien fait (question, pas jugement), friction d'entrée faible, pas de « retard » sur les caps, célébration (pas punition) quand on lâche un cap.

### Décisions (tranchées au cadrage du 2026-09-23)
- **Filiation tâche → cap** : ✅ tranchée et codée en 4a.1 (`capId` unique, lignée déduite).
- **Plafonds** : soft ; **focus hebdo principal unique** (focus désigné, pas de compteur, pas de secondaires).
- **Écrans** du rituel, mensuel (4e écran du 1er rituel du mois) et rendu du pace (mention neutre, rien sans jalon daté) : ✅ codés.
- **Mesure d'objectif** : optionnel acté et codé (4a.1).

---

## V5 — cadrage validé le 2026-09-23 (lots 1-4 en prod, lot 5 en preview, lots 6-9 à coder)

**Thème : fiabilité du quotidien + planification par semaine.** Ouverture (partage, testeurs, Android natif, domaine) → plus tard. Ajustements fins : à l'usage.

### Lots (ordre)
| Lot | Contenu |
|---|---|
| 1 | S7 irritants (dette V3) + tri par échéance |
| 2 | S6 « Démarrer » |
| 3 | Migration vers React + Vite (build) — ajouté le 2026-09-24 |
| 4 | PWA + notifications push |
| 5 | Synchro : fusion par tâche en cas de conflit |
| 6 | Sentry + suppression complète du compte Supabase |
| 7 | Heures libres (semaine d'abord) + alerte de surcharge |
| 8 | Remplissage auto de la journée |
| 9 | Import calendrier externe (Google) |

### Lot 1 — S7 irritants ✅ en prod (2026-09-23)
- **Date/heure passée à la création** : avertissement non bloquant ; jamais sur les routines (rattrapage).
- **Trajet retour asymétrique** : champ retour séparé, prérempli avec l'aller.
- **Badge « en retard de prep »** : reste visible en ocre jusqu'à l'heure du RDV.
- **Archive** : suppression définitive à l'unité + « Vider l'archive » avec confirmation.
- **Pluriels** des labels streak ; **suppression des champs morts** `streakCount`, `graceDays`, `lastEvaluatedPeriod` (schema v14) ; **revue complète du mode sombre**.
- **Tri par échéance** dans Priorités : bouton qui bascule sur une liste unique triée par deadline (les filtres Échéance ne font que filtrer les colonnes).
- Onglet « Deadlines » : abandonné. Prep/trajet modifiés sur une occurrence qui touchent le template : laissé tel quel (rien remonté à l'usage).
- **Implémentation** :
  - Avertissement à la création (`warnOnCreate`, QuickAdd + modale complète) : fusionne l'info chevauchement et « ⏳ … est déjà passé — tâche créée quand même ». Jamais sur une tâche récurrente ni une routine. Pas à l'édition.
  - Trajet retour : `travelReturnDuration` (null = identique à l'aller) ; case « 🔄 Trajet retour » toujours disponible, sélecteur prérempli avec l'aller, « Aucun » décoche. La couronne du RDV (agenda, chevauchements) utilise la durée retour.
  - Badge en-tête : prep/départ dépassé mais RDV pas commencé → badge ocre « RDV HH:MM · … · préparation prévue à HH:MM, RDV dans X ».
  - Archive : poubelle par tâche (annulable) + « Vider l'archive » (confirmation, annulable par Ctrl+Z / Annuler).
  - Pluriels : « 1 jour / semaine / année de suite ».
  - Schema **v14** : `streakCount`, `graceDays`, `lastEvaluatedPeriod` retirés à la migration et plus jamais écrits.
  - Tri par échéance : case « Trier par échéance » (persistée `settings.sortByDeadline`) à côté de « Afficher les récurrentes » ; liste unique groupée En retard / Aujourd'hui / Cette semaine / Ce mois-ci / Plus tard / Sans échéance, étiquette de priorité par ligne. Échéance effective = la plus proche entre la tâche et ses sous-tâches ouvertes. Recherche et filtres s'appliquent. RDV importants exclus (ils vivent dans le bandeau).
  - Mode sombre : bouton « + Nouvelle » catégorie (fond blanc) corrigé, `.btn-ghost` transparent par défaut ; raccourcis 1/2/3 sur une ligne dans Réglages ; en-tête qui ne se tasse plus quand le badge RDV est long.

### Lot 2 — S6 « Démarrer » ✅ en prod (2026-09-23)
Spec d'origine : une seule action « Démarrer » ; plein écran par défaut, bascule mini-fenêtre ; tâche ≤ D (focus pomodoro) → démarre sur sa durée estimée, bilan estimé/réel ; tâche > D → tranches D → pause → … → reste.
- **Cadrage validé** : bouton 🎯 « Mode focus » retiré (cartes + suggestion) ; « Quitter » remplacé par Réduire / Arrêter / Fini ; relance d'une tâche entamée sur le reste ; reste < 5 min fusionné ; bilan neutre + ressenti ; **ajout hors spec d'origine** : chrono sur heure de fin + session persistée localement.
- **Bugs corrigés** : « Fini » en plein écran laissait tourner le chrono sans enregistrer le temps ; démarrer une autre tâche écrasait le chrono sans enregistrer son temps.
- Détail : voir « Session « Démarrer » » dans la partie V3 (fonctionnel). Code : `buildSessionPlan`, `sessionPlanMinutes`, `runningLeft`, `stepRunning` (pur), `startTask` / `finishSession` / `extendSession` / `skipPhase` / `stopTask` dans l'app, `SessionSummaryModal`. `toggleComplete(item, { silent })`.
- Pas de changement de schéma (session locale, hors `state`). Pas de push (lot 4) : cloche + notification locale si Cap ouvert.
- **Reporté** : Démarrer depuis l'agenda (overlay vue Jour).

### Lot 3 — Migration vers React + Vite ✅ en prod (2026-09-24)
Ajouté au cadrage le 2026-09-24 : passer au build **avant** la PWA (qui en dépend : `vite-plugin-pwa`) et supprimer la compilation Babel dans le navigateur (~1-2 s à chaque ouverture sur téléphone, fichier au-delà de la limite de 500 Ko de Babel). SvelteKit écarté (réécriture complète de ~10 000 lignes, rendu serveur inutile pour une app privée derrière un login).
- **Migration mécanique** : le script Babel devient `src/App.jsx` **tel quel** (imports React / supabase-js en tête, `export default AuthGate`), le CSS devient `src/styles.css` tel quel, `src/main.jsx` fait le rendu, `index.html` ne garde que le `<head>` (titre, favicon, Google Fonts) et `<div id="root">`. Seule ligne de code changée : `window.supabase.createClient` → `createClient` importé.
- **Dépendances npm figées** (`package-lock.json`) : react / react-dom 18.3.1, @supabase/supabase-js 2.108.2 (mêmes versions que les CDN) ; dev : vite 8, @vitejs/plugin-react 6. Node 22.
- **Vercel** : `vercel.json` (framework vite, `npm ci`, `npm run build`, sortie `dist/`). Build en échec = la prod précédente reste en ligne.
- Rien d'autre : pas de découpage en modules, pas de TypeScript, pas de lint (plus tard, progressivement). Données, clés localStorage, Supabase, schéma v14 : inchangés.
- **Vérifié** : mêmes parcours et mêmes données sur l'ancienne et la nouvelle version, 25 captures comparées au pixel (tous les onglets, agenda jour/semaine/mois/année, modales, sombre, mobile, Démarrer) → identiques, hors animations en cours ; même état final des données ; aucune erreur JS. Bundle : 170 Ko gzip (+ 6 Ko CSS) au lieu de React + Babel standalone + source JSX.

### Lot 4 — PWA + push ✅ en prod (2026-09-24)
**Cadrage validé** (2026-09-24) : PWA installable et hors ligne, push via Supabase, **+ rappels sur les récurrentes / routines** (manque constaté : le rappel était masqué dès qu'il y avait une récurrence) **+ push des fins de phase « Démarrer »**. Plus de demande d'autorisation au premier clic.

**PWA**
- `vite-plugin-pwa` en `injectManifest` : service worker maison `src/sw.js` (Workbox) — précache du build, navigation → `index.html` précaché, Google Fonts en cache (CSS revalidée, polices 1 an), réception du push, clic sur la notification.
- Manifest généré (Cap, papier `#F4EFE6`, standalone, fr) ; icônes `public/icons/` (192, 512, maskable 512, apple-touch 180, badge 96 monochrome) générées depuis le mark du favicon ; balises iOS dans `index.html`.
- **Mise à jour** : `registerType: 'prompt'` → `main.jsx` enregistre le SW (`registerSW`) et émet `cap:need-refresh` → toast « ✨ Nouvelle version de Cap · Recharger » (jamais de rechargement forcé). Remplace le « recharge tous tes onglets » après une mise en prod (à partir de la version suivante).

**Rappels (calcul unique)**
- `computeReminders(items, now, 14)` : tâches datées avec heure + rappel (heure de partir si RDV avec trajet), **et occurrences des récurrentes / routines** (un rappel par créneau pour les routines multi-créneaux ; occurrences cochées, sautées, créneaux faits exclus ; récurrences flottantes exclues faute d'heure). Clé stable `r:<item>:<date>T<heure>:<délai>`.
- `sessionReminders(running, titre, réglages)` : simule l'enchaînement prévu d'une session (sans pause, 12 phases max) → fins de tranche / de pause / temps prévu écoulé. Effacés à la pause, à l'arrêt, sur Fini ; recréés à la reprise.
- Modale : « Rappel · à chaque occurrence » proposé aussi pour une récurrente / routine à heure fixe.
- **Minuteurs locaux** (Cap ouvert) : même calcul ; **désactivés sur un appareil abonné au push** (et `notify()` muet) → pas de doublon ; la cloche et les toasts de session restent.

**Push (Supabase, première brique serveur)**
- Tables `push_subscriptions` (un abonnement par appareil et par compte, `unique(user_id, endpoint)`) et `reminders` (`primary key (user_id, key)`, `sent_at`), RLS « les siens ».
- L'app réécrit les rappels à venir (2 s après un changement de tâches ou de session, + toutes les heures / au retour sur l'onglet) : upsert par clé + suppression des rappels futurs disparus ; un rappel déjà envoyé n'est jamais renvoyé ; `test:*` jamais supprimés par l'app.
- Edge Function **`send-reminders`** (Deno, `verify_jwt` off, protégée par l'en-tête `x-cap-cron`) appelée **chaque minute par pg_cron** (`cap-send-reminders`, pg_net) : réclame les rappels dus en une requête UPDATE (pas de double envoi), abandonne ceux en retard de plus de 10 min, chiffre avec `web-push` (`generateRequestDetails`) et envoie en `fetch` natif (TTL 10 min, urgence haute), supprime les abonnements morts (404/410), purge les rappels de plus de 2 jours.
- **Secrets générés dans Supabase, jamais ailleurs** : `cap_cron_secret` (aléatoire, en base), paire VAPID P-256 générée par la fonction au premier appel (WebCrypto) et rangée dans le Vault (`cap_push_store_vapid`, une seule fois). L'app lit la clé **publique** via `cap_vapid_public_key()` (autorisé aux connectés, voulu). Config lue par `cap_push_config()` (clé de service uniquement).
- SQL versionné dans `supabase/migrations/`, fonction dans `supabase/functions/send-reminders/`. `pg_net` dans le schéma `extensions`.
- **Clic sur une notification** : ramène Cap au premier plan (message `cap:open-item`) ou l'ouvre sur `/?item=<id>` → modale de la tâche (ou plein écran si c'est la session en cours).
- **Réglages › Notifications** (par appareil) : Activer / Désactiver / « Envoyer une notification de test » (arrive dans la minute) ; états refusé / non géré / « sur iPhone, installe d'abord Cap ». Déconnexion = l'appareil ne reçoit plus les notifications du compte ; suppression du compte = abonnements et rappels effacés.
- **Vérifié** : chiffrement Web Push sous Deno (déchiffrement contrôlé), chaîne serveur de bout en bout (rappel dû → envoi → abonnement mort supprimé), calcul des rappels (routine 2 créneaux, heure de partir, hebdo, flottante exclue, coche → retiré), rappels de session (5 phases, pause / reprise / arrêt), SW actif, hors ligne, lien `?item=`, toast de mise à jour ; non-régression visuelle (seuls les Réglages changent). **La réception réelle d'une notification ne se teste que sur un vrai appareil.**
- **Limites** : iPhone → Cap installé sur l'écran d'accueil (iOS 16.4+) ; précision ~1 min (pg_cron) ; les fins de phase d'une session sont envoyées à **tous** les appareils abonnés du compte.

### Lot 5 — Synchro
En cas de conflit (compare-and-swap refusé) : **fusion à 3 voies par tâche** (dernière version commune gardée en local, version locale, version cloud) au lieu d'adopter tout le cloud et de mettre le local de côté. Conflit sur une même tâche : la modification la plus récente gagne, l'autre reste en stash.

### Lot 6 — Sentry + suppression du compte
- Sentry : capture des erreurs JS (DSN à fournir par l'utilisateur au moment du lot).
- Suppression complète : Edge Function admin qui supprime le compte auth Supabase en plus des données (RGPD).

### Lot 7 — Heures libres + alerte de surcharge
- **Heures libres = heures éveillées − survie − déjà engagé**, sur les jours restants de la période. **Semaine d'abord**, mois en second.
  - Heures éveillées : réglage, 16 h/j par défaut. Survie : réglage, 3 h/j par défaut (repas, hygiène, ménage).
  - Déjà engagé : RDV (+ prep/trajets), tâches datées (durée estimée), routines horodatées, réglage facultatif « travail » (ex. 7 h × jours ouvrés).
  - Non compté : tâches non datées (c'est là qu'elles peuvent aller).
  - Affichage : tuile Piliers (suit semaine/mois) ; **rituel hebdo écran 3** (« La semaine qui vient : X h libres ») ; en-tête de la vue Semaine de l'agenda. Pas dans l'en-tête global.
- **Alerte de surcharge** (nombre, en complément de la jauge qui mesure le temps) :
  - Compte : tâches prévues aujourd'hui (datées + occurrences du jour des récurrentes), par sous-tâches si elles sont datées du jour, RDV importants inclus.
  - Ne compte pas : routines, non datées, déjà cochées.
  - Seuil 15 par défaut, réglable. Toast non bloquant au moment où on le dépasse, une fois par jour : « 16 choses aujourd'hui. Tu surinvestis le quotidien ? » + « Voir ma journée ».

### Lot 8 — Remplissage auto de la journée
- Bouton « Remplir ma journée » (vue Jour) → **aperçu en pointillés** : tout valider / retirer / annuler. Rien n'est placé sans accord.
- Candidates, dans l'ordre : datées aujourd'hui sans heure → Must non datées → Should → Want. Routines horodatées et RDV : fixes.
- Créneaux : trous libres, jamais avant maintenant, dans une plage réglable (défaut 9h–19h), marge 5 min, prep/trajets des RDV respectés.
- Budget : s'arrête à la capacité du check-in (déjà planifié compris).
- Ordre : énergie haute sur le prime time (sinon le matin), énergie faible en fin de journée, tâches courtes pour boucher les petits trous. *(Écart assumé avec « énergie croissante » de la spec d'origine.)*
- Tâche > 30 min sans sous-tâches : placée quand même + suggestion « découpe-la ? » (jamais de découpage automatique). Sous-tâches d'un même parent : groupées, les plus courtes d'abord.

### Lot 9 — Import calendrier externe
- Phase 1 : **lecture seule**, événements en grisé dans l'agenda, sans interaction avec le chevauchement de Cap (spec d'origine). Sync bidirectionnelle : plus tard.
- **Technique à trancher au début du lot** — reco : **URL iCal secrète** (Google, Outlook et Apple en fournissent une) lue par une Edge Function (contourne le CORS), au lieu de l'OAuth Google (projet Google Cloud, écran de consentement, jetons à renouveler). Plus simple, universel, suffisant en lecture seule.

### Plus tard (D)
Partage entre utilisateurs, testeurs extérieurs, page d'accueil, domaine perso, Android natif (Capacitor, seulement si la PWA déçoit sur les notifications).

---

## Roadmap

### Phase 1 — Validation usage (terminée)
**Objectif** : utiliser Cap dans la durée pour identifier les vraies frictions.
- Test quotidien sur ordi + tel ✓
- Notes accumulées dans le projet Cap ✓
- Feedback consolidé en plan V3 ci-dessous ✓

### Phase 2 — V3 (livrée — S6 et S7 reportées)
**Objectif** : fusionner les corrections V2.3 et les features V3 en un seul gros bloc, livré par sessions.

**Découpage en 5 sessions de code, chaque session = livraison possible.**

#### Session 1 — Sécurité & fondations ✅ LIVRÉE
- ✅ Récupération mot de passe (Supabase reset email + écran nouveau mdp, auto-connexion après update)
- ✅ Suppression de compte (delete cap_data + clear localStorage + signOut, confirmation par saisie email exact)
- ✅ Déclenchement réel des rappels (setTimeout côté client, notif système ou fallback toast, mention "ⓘ Rappel local — nécessite Cap ouvert")
- ✅ Échap ferme les modals (hiérarchie : settings > checkin > suggestion > editingItem > showAddModal > focusMode)
- ✅ Cmd/Ctrl+Z = undo dernière suppression (stack profondeur 5, items + sous-tâches, toast "Annuler", confirm() retiré du modal édition)
- ✅ Indicateur "Synchro · il y a Xmin" (couleurs vert/orange/rouge, tick toutes les 30s)
- ✅ Raccourcis bonus : N (nouveau), / (capture rapide), F (focus tâche en cours), Espace (pause/reprise pomodoro)
- ✅ Liste des raccourcis affichée dans Réglages (détection ⌘ Mac vs Ctrl)

#### Session 2 — Refonte modèle Task/Habit + Calendrier complet ✅ LIVRÉE
**Livrée en 2 sous-sessions (S2A modèle, S2B calendrier) + correctifs en cours d'usage.**

**S2A — Refonte modèle**
- ✅ Fusion `task` + `recurring` → un seul type `task` avec champ `recurrence` optionnel
- ✅ Habitudes restent à part (`habit`), utilisent le même système de récurrence
- ✅ Récurrence avancée : daily / weekdays / weekly multi-jours / monthly / personnalisé tous les N
- ✅ Fin de récurrence : pas de fin / jusqu'au [date] / après [N] occurrences
- ✅ Heure optionnelle sur habitudes (zone "À planifier" si vide)
- ✅ Deadlines sur tâches ET sous-tâches (≠ date d'exécution), 5 niveaux de chip + bordure pulsante en retard
- ✅ Calcul auto durée parent = somme des sous-tâches, override manuel possible
- ✅ Migration auto schema v3 (anciennes données préservées)
- ✅ Scoring deadline dans suggestion (en retard +200, ≤1j +120, ≤3j +60, ≤7j +30)
- ✅ Jauge "feuilles planifiées" (pas de double comptage parent/sous-tâches)
- ✅ Warning visuel sous-tâche avec deadline > parent
- ✅ Micro-copy clarification habitude vs tâche récurrente

**S2B — Calendrier**
- ✅ Tâches récurrentes affichées sur toutes leurs occurrences (moteur `expandItemsForRange`)
- ✅ Cocher une occurrence = exception `'completed'` pour cette date seule
- ✅ Zone "À planifier" en haut Day/Week pour items récurrents sans heure
- ✅ Drag depuis "À planifier" vers créneau = définit l'heure pour cette occurrence
- ✅ Drag d'occurrence = exception silencieuse, template intact
- ✅ Détection collision : drop refusé avec toast
- ✅ ScopeModal "Cette occurrence / Futures / Série" à la modif et suppression
- ✅ Approche pragmatique pour modif "Cette occurrence" : tâche dérivée + exception `'deleted'`
- ✅ Sous-tâches descendues dans expansion (visibles si date/récurrence ≠ parent)

**Correctifs au fil de l'usage**
- ✅ Heure conservée sur tâche récurrente (pas que la date)
- ✅ Sous-tâche hérite de date/time/deadline du parent à la création
- ✅ Boutons "retirer date/heure/les deux" sur tâches one-shot
- ✅ Activation d'une récurrence vide automatiquement la date
- ✅ Mode nuit : `--line` éclairci, texte cal-task forcé sombre, checkbox cal-task adaptée, boutons ghost suivent `--ink`, inputs date/time avec `color-scheme: dark`

#### Session 3 — UX Agenda complet ✅ LIVRÉE

**Refonte vue Jour**
- ✅ Échelle 120px/h (10px / 5 min), plage 24h, auto-scroll 1h avant maintenant
- ✅ Blocs absolus dimensionnés par durée réelle (pas de plancher visuel)
- ✅ Trois niveaux d'affichage : tiny (< 20px), compact (< 50px), normal (≥ 50px)
- ✅ Tap = sélection avec overlay flottant ; 2e tap = édition ; tap fond = referme
- ✅ Resize par poignée bord bas (snap 5 min, buttoir tâche suivante, max 8h)
- ✅ Pas de chevauchement (collision sur plages, pas seulement même heure)
- ✅ Tâche avec sous-tâches → parent invisible dans agenda, drag refusé
- ✅ Resize d'occurrence récurrente = exception duration (n'affecte pas la série)
- ✅ Clic créneau vide → modale rapide pré-remplie
- ✅ Layout 2 colonnes (agenda max 560px + colonne droite 320px), responsive < 1100px

**Colonne droite vue Jour**
- ✅ Intention du jour (édition inline, persistée dans `state.dailyIntentions`)
- ✅ Section "Aujourd'hui sans heure" : items datés aujourd'hui sans heure
- ✅ Section "À caser" : Must sans date du tout, tri deadline → énergie → createdAt, limite 5 + bouton "Voir tout"
- ✅ Drag depuis "À caser" vers grille = ajoute date+heure
- ✅ Jauge capacité compacte (si jour courant)
- ✅ Habitudes du jour cochables

**Refonte vue Semaine**
- ✅ Échelle 48px/h, snap drop 15 min
- ✅ Bandeau gauche permanent "À planifier" (récurrentes + one-shot sans heure)
- ✅ Marqueur de densité par jour (segments colorés par priorité)
- ✅ Tâches < 15 min cachées → pastille "+N", clic = bascule vue jour
- ✅ Jours passés à 55% d'opacité
- ✅ Clic en-tête jour = bascule vue jour
- ✅ Auto-scroll heure courante

**Refonte vue Mois**
- ✅ Tri par priorité dans chaque case (Must > Should > Want > autres)
- ✅ Deadlines surbrillance (bordure rust si jour, pulsation si en retard)
- ✅ Fond saturé selon densité (1-2 / 3-4 / 5-6 / 7+)
- ✅ Simple-clic = bascule vue jour

**Modale rapide d'ajout**
- ✅ Composant `QuickAddModal` (titre, priorité, date+heure, durée par boutons, catégorie)
- ✅ Bouton "Nouveau" du header → quick add
- ✅ `N` = quick / `Shift+N` = complet
- ✅ Clic créneau vide agenda → quick add prérempli
- ✅ "+ détails" bascule vers modale complète avec prefill
- ✅ Entrée valide, vérifie chevauchement avant save

**Saisie durée**
- ✅ DurationInput au pas de 5 min (step="5", snap onBlur)

**Schema**
- ✅ Migration v3 → v4 (ajout `dailyIntentions: {}`)

**Refactor au passage**
- ✅ `flattenItems` hissée au scope global (était dans App, utilisée dans CalendarView)

#### Session 4 — UX Listes & Power user + Visibilité importante ✅ LIVRÉE

**Tri & sélection**
- ✅ Notion de "tâche sélectionnée" (clic = bordure rouge, Échap déselectionne)
- ✅ Tri auto par défaut hiérarchie complète : Important → Deadline → Date prévue → Durée courte → Énergie faible → CreatedAt
- ✅ Bouton "↻ Tri auto" qui apparaît uniquement si l'utilisateur a réordonné manuellement (flag `manualOrder` par colonne, l'ordre manuel persiste jusqu'au reset)
- ✅ Sous-tâches repliées par défaut, reset au reload (state local non persisté)

**Power user**
- ✅ Raccourcis 1 / 2 / 3 → déplace la tâche sélectionnée vers Must / Should / Want
- ✅ Entrée valide les modals avec gestion focus textarea (ItemModal, QuickAdd, Settings, Checkin, Suggestion)
- ✅ Validation visuelle : shake + bordure rouge + toast si Entrée invalide (titre vide, Important sans date+heure ni deadline)
- ✅ D&D sous-tâches entre branches + réordo dans même branche
- ✅ Système 3 zones de drop sur une carte : tiers haut (before) / tiers central (rerooting = devient sous-tâche) / tiers bas (after)
- ✅ Drop sur colonne Must/Should/Want = changement priorité, sous-tâche promue en racine
- ✅ Boucle interdite (drag parent dans descendant) = refus silencieux
- ✅ Auto-scroll pendant drag (zone bord 100px, vitesse proportionnelle)
- ✅ Cmd/Ctrl+Z étendu à toutes les opérations D&D (delete, complete, reorder, reparent, postpone, priority) — stack unifiée profondeur 10, snapshot complet de l'arbre

**Recherche & filtres**
- ✅ Barre de recherche unifiée Priorités + Archive
- ✅ Toggles scope : Titres / Notes / Sous-tâches (tous actifs par défaut)
- ✅ Recherche insensible casse/accents avec highlight jaune sur le titre matché
- ✅ Filtres avancés combinables (panneau repliable) : Énergie / Durée / Échéance / Catégorie
- ✅ Logique AND entre familles, OR à l'intérieur
- ✅ Buckets échéance : En retard / Aujourd'hui / Cette semaine / Ce mois / Ce trimestre / Sans échéance
- ✅ Compteur filtres actifs (chip rouge), bouton "Effacer les filtres"

**Retard**
- ✅ Bandeau "En retard" en haut de Priorités, 5 max + "Voir tout (N)"
- ✅ Boutons "📅 Demain" (un clic) et "📆 Autre" (input date inline)
- ✅ Occurrences récurrentes manquées des 14 derniers jours incluses
- ✅ Postponer crée une exception `move` sans toucher la série pour les récurrentes

**Archive**
- ✅ Archive immédiate au check (plus de seuil 7j)
- ✅ Triple filet de sécurité : toast undo 5s + Cmd/Ctrl+Z + restauration depuis vue Archive
- ✅ Vue Archive groupée par semaine (lundi → dimanche)
- ✅ Recherche dans archive avec toggles dédiés
- ✅ Bouton "↺ Restaurer", compteur sur l'onglet
- ✅ Tâche cochée disparaît de l'agenda **sauf le jour J** où elle reste grisée
- ✅ Occurrence récurrente cochée grisée le jour J, invisible les autres jours

**Visibilité importante (RDV)**
- ✅ Toggle ★ "Important" dans ItemModal
- ✅ Validation : Important nécessite date+heure OU deadline (flexible)
- ✅ Étoile ochre + bordure 5px + fond ochre clair sur cartes Priorités, blocs vue Jour, blocs vue Semaine, items vue Mois
- ✅ Bloc dédié "★ Important / RDV" dans colonne droite vue Jour, contextualisé sur la date affichée (`importantForCurrentDay`)
- ✅ Strict isImportant : seules les tâches marquées y apparaissent
- ✅ Header badge persistant avec countdown, désactivable par X pour la session

**Vues calendrier — corrections & polish**
- ✅ Vue agenda par défaut = Jour
- ✅ Label dynamique vue Jour : "Aujourd'hui" / "Demain" / "Après-demain" / date
- ✅ Bouton retour à aujourd'hui = icône cible
- ✅ Vue Semaine et Mois : uniquement les tâches one-shot
- ✅ Vue Semaine : hauteur min 18 px par bloc + tri hiérarchie complète + détection chevauchement → pastille "+N" en haut de colonne
- ✅ Vue Mois : tri hiérarchie complète, lignes égales, alignement jours corrigé via `dateToISO()` (timezone fix)

**Composants & helpers**
- ✅ Icône batterie 3 niveaux remplace la chip texte d'énergie
- ✅ TimeInput composant réutilisable : `step="300"` + snap 5 min au blur + 4 boutons custom (heures ±1, minutes ±5)
- ✅ Détection chevauchement étendue à ItemModal + QuickAdd : refus dur avec toast nommant la tâche en conflit
- ✅ Helpers ajoutés : `sortItemsAuto`, `isArchived`, `itemMatchesSearch`, `itemMatchesFilters`, `findOverdueRoots`, `pushUndoSnapshot`
- ✅ Migration schema v4 → v5 : ajout `isImportant: false` et `completedAt: null`

**Bug timezone (correctif S4)**
- ✅ Tous les `toISOString().slice(0, 10)` remplacés par `dateToISO()` (formate en local, pas UTC) — corrige le décalage de 1 jour selon fuseau horaire

#### Session 4.5 — Préparation & trajet RDV ✅ LIVRÉE

**Modèle**
- ✅ Champs `prepDuration`, `travelDuration` (minutes, optionnels), `travelReturn` (boolean) sur tous les items et sous-tâches
- ✅ Migration schema v5 → v6 silencieuse
- ✅ Champs n'ont d'effet que si `isImportant === true ET time` renseignée (valeurs préservées en interne sinon)
- ✅ Pas d'héritage parent → sous-tâche sur ces 3 champs (volontaire, contrairement à date/heure/deadline)

**ItemModal — section "Avant le RDV"**
- ✅ Visible uniquement si Important + heure
- ✅ Boutons rapides Préparation (5/10/15/30) et Trajet aller (5/10/15/30/45)
- ✅ Champ "autre" libre, snap au pas de 5 min au blur
- ✅ Trajet retour : checkbox conditionnée à un trajet aller > 0, valeur symétrique (= même que l'aller)
- ✅ Hint textuel sous les pickers : "🎒 Prep à hh:mm → 🚗 départ à hh:mm → RDV à hh:mm"

**Helpers globaux**
- ✅ `getRdvHalo(item, startMin, durationMin)` : renvoie les bornes prep/travel/end/returnEnd ou null si pas de couronne
- ✅ `getEffectiveBounds(item, startMin, durationMin)` : bornes étendues incluant le halo (pour collision)
- ✅ `formatConflictToast(overlap)` : message uniforme avec suffixe `(prep)` / `(trajet)` / `(trajet retour)` / `(prep+trajet inclus)`

**Détection chevauchement étendue**
- ✅ `findOverlapAt` étend les bornes des items existants à leur halo et identifie la zone touchée (`conflictKind`)
- ✅ Tous les call sites migrés : drop direct, resize buttoir, ItemModal create/edit, QuickAdd
- ✅ Resize : la poignée s'arrête au début de la prep de la tâche suivante (pas à son heure de RDV)
- ✅ excludeKey conservé pour ne pas chevaucher soi-même

**Vue Jour — zones fantômes**
- ✅ Composant `RdvHaloBlocks` rend 3 blocs hachurés (prep / trajet aller / trajet retour) en couleur ochre
- ✅ Hachures à opacités distinctes : prep 0.18, trajet 0.25
- ✅ Labels "🎒 Prep" / "🚗 Trajet" / "🚗 Retour" si bloc ≥ 20px de haut
- ✅ Non-interactives (pointerEvents: none, z-index 1)
- ✅ Clamp aux bornes 0–24h pour gérer les débordements minuit

**Vue Semaine — pictos**
- ✅ Pictos 🎒 (prep) et 🚗 (travel) dans le bloc important quand renseignés, à côté du ★
- ✅ Tooltip enrichi avec heure RDV + zone effective + détail prep/trajet
- ✅ Pas de zones hachurées en vue Semaine (densité trop tassée à 48px/h)

**Vue Mois**
- Aucun changement (déjà tassée)

**Rappel décalé "heure de départ"**
- ✅ Si `travelDuration > 0`, le rappel se déclenche à `time - travelDuration - reminderMin` (au lieu de `time - reminderMin`)
- ✅ Label spécifique : "🚗 Heure de partir pour « X » (RDV à hh:mm)" + titre notif "🧭 Cap — Départ"
- ✅ Sans trajet : comportement inchangé

**Header badge — countdown vers début de prep**
- ✅ `nextUpcoming` cible `time - travel - prep` (= heure où il faut s'y mettre)
- ✅ Picto 🎒 si prep > 0, sinon 🚗 si trajet > 0, sinon pas de picto
- ✅ Tooltip détaillé : "RDV à hh:mm · prep Xmin · trajet Xmin · À commencer à hh:mm"
- ✅ Quand cible passée mais pas encore l'heure RDV : badge disparaît (comportement standard, à débattre si frustrant à l'usage)

**Mode sombre**
- ✅ Section "Avant le RDV" lisible (fond ochre transparent passe sur paper sombre)
- ✅ Hachures fantômes lisibles
- ✅ **Correctif post-livraison** : règle CSS dédiée `[data-theme="dark"] .cal-block.cal-block-important` force fond ochre saturé + texte sombre, sinon le fond ochre transparent inline laissait passer le paper sombre et rendait le texte illisible
- ✅ **Correctif post-livraison** : snap 5 min au blur sur l'input "autre" (HTML5 step n'est qu'indicatif)

**Hors scope S4.5 (reportés)**
- Bloc prep/trajet asymétrique (= valeurs différentes aller/retour)
- Zones fantômes en vue Semaine
- Rappel séparé pour la prep
- Recalcul auto durée parent intégrant prep/trajet (volontairement pas implémenté : la durée est l'effort de la tâche, pas son enrobage)
- Modification prep/travel sur **une occurrence** récurrente touche le template (acceptable pour MVP, à voir à l'usage)

#### Session 5 — Fusion habitude / tâche récurrente ✅ livrée

**Décision tranchée en fin de S4** : la distinction habitude / tâche récurrente n'était pas robuste (cas-limite "appeler ma mère le dimanche"). Fusion en un seul concept "tâche récurrente" avec streak optionnel.

**Refactor structurel livré**
- Type `habit` supprimé. Tout est `type: 'task'`.
- Champ booléen `streak` (suivre la régularité oui/non), `history`, `lastCompletedDate`, `lastEvaluatedPeriod` (préparé, non utilisé), `streakCount` (legacy, ignoré depuis S5.5++)
- Migration schema v6 → v7 : `type === 'habit'` → `type: 'task'` + `streak: true` ; ex-tâches récurrentes restent `streak: false` ; `frequency` obsolète nettoyée
- Onglet "Habitudes" → **"Routines"** (composants `RoutinesView`, `DailyRoutinesList`). Position nav inchangée.

**ItemModal**
- Plus de toggle Tâche/Habitude
- Toggle "Suivre la régularité" visible uniquement si récurrence active. Désactivation conserve `history`/`lastCompletedDate` en interne (re-cocher retrouve les compteurs).
- Sélecteur récurrence enrichi : Aucune / Quotidien / Lun-Ven / Hebdo / Mensuel / **Annuel** / **N fois par semaine (jours libres)** / **N fois par mois (jours libres)** / Personnalisé
- Récurrence flottante (`floatingWeekly`, `floatingMonthly`) : input numérique pour N (1-30). Vide aussi `time` à l'activation (pas de créneau fixe).

**Saturation Must/Should/Want**
- Toggle `state.settings.showRecurringInPriorities` (off par défaut). Visible en haut à droite vue Priorités.
- Off : aucune tâche récurrente dans Inbox + Must + Should + Want
- On : récurrentes (et routines) avec une priorité apparaissent dans la colonne correspondante
- Routines vivent en agenda Jour + onglet Routines, peu importe ce toggle

**Récurrence flexible TDAH-friendly**
- `floatingWeekly { count: N }` : N complétions par semaine ISO (lundi → dimanche). Apparaît dans "Routines du jour" tant que quota non atteint.
- `floatingMonthly { count: N }` : idem mois calendaire.
- Compteur "X/N cette semaine" / "X/N ce mois" affiché en card Routines et zone "Routines du jour".
- Helpers : `isFloatingRecurrence`, `floatingCompletionsInPeriod`, `isFloatingQuotaMet`, `getFloatingAlertLevel`, `isoWeekId`, `isoMonthId`, `weekRange`, `monthRange`.
- Vue Semaine et Mois agenda excluent les récurrents (`!o.isOccurrence`) — comportement préservé S4.

**Suggestion "Je commence par quoi"**
- Récurrentes éligibles au scoring (avant : exclues car habitudes)
- Skip si déjà cochée aujourd'hui (récurrence à date fixe) ou quota atteint (flottante)
- Scoring : occurrence du jour = +80 pour récurrence à date fixe, +60 pour flottante non atteinte

**Cocher / décocher**
- `toggleComplete` route automatiquement vers `toggleOccurrenceComplete(item.id, today)` si `streak` ou `recurrence`
- Si `streak` : history + lastCompletedDate (depuis S5.5++ : plus de mutation streakCount)
- Sinon récurrence : exceptions[date] = 'completed'

#### Session 5.5 — Barres adaptatives + annuel + alertes + streak lazy ✅ livrée

**Récurrence annuelle**
- Nouveau type `recurrence: { rule: 'yearly', monthDay, month, interval }`
- Sélecteur ItemModal "Annuel" : input jour (1-31) + select mois
- Cap dynamique sur l'input jour : max = nb jours du mois sélectionné (29 max pour février)
- Au changement de mois, clip vers le bas si jour > max du nouveau mois (31 → 29 si fév). Pas de clip vers le haut.
- Warning ochre si jour=29 + mois=fév : "Ne se déclenche que les années bissextiles (tous les 4 ans)."
- 29 février non bissextile : pas d'occurrence cette année (`if (targetDay !== d.getDate()) return false`), mais le streak ne casse pas (skip silencieux dans `computeStreak`)

**Mensuel — fin de mois intelligent**
- Si `monthDay > nb jours du mois courant` : occurrence tombe le **dernier jour disponible** (28/29 fév, 30 avr/juin/sep/nov)
- Implémenté dans `isOccurrenceDate` via `Math.min(r.monthDay, lastDayOfMonth)`
- Warning UI dès `monthDay >= 29` : "Pour les mois plus courts, l'occurrence tombera le dernier jour disponible (ex : 28 février)"
- Cas typique débloqué : "loyer le 30" se déclenche aussi en février

**Barres d'historique adaptatives — `getStreakBars(item, todayObj)`**
- Quotidien : 7 cases lun→dim avec lettres L M M J V S D
- Lun-Ven : 5 cases L M M J V
- Hebdo date fixe : 7 cases avec lettres ; jours sans occurrence en bordure pointillée + opacité 0.4 (status `noOccurrence`)
- Mensuel : 6 derniers mois ; mois en cours = bordure ochre (pending) ; affichage "Prochaine échéance : X" sous les compteurs
- Annuel : 12 mois année courante, lettres J F M A M J J A S O N D, mois cible = case active
- Flottante hebdo : 7 cases lun→dim
- Flottante mensuelle : 28-31 cases (jours du mois courant), gap 1px, height 14px
- Custom / fallback : 14 jours classiques

**Alertes flottantes — `getFloatingAlertLevel`**
- 3 niveaux selon `jours_restants` vs `manquants` (target − done) :
  - `safe` : restants > manquants ou quota atteint
  - `warning` (ochre, "⚠ ça se joue maintenant") : restants = manquants exactement
  - `critical` (rust, "🔥 objectif menacé") : restants < manquants (mathématiquement impossible)
- Affichage dans la card Routines, à droite du compteur

**Status case par état**
- `done` : pleine rust
- `missed` : bordure rouge dashed (jour passé non fait sur occurrence attendue)
- `pending` : bordure ochre (mois/jour en cours)
- `future` : grise (paper-2)
- `noOccurrence` : bordure dashed ink-fog + opacité 0.4

**Streak lazy — `computeStreak(item, todayObj)` (S5.5++)**

Fix : avant S5.5++, `streakCount` était un compteur cumulatif déguisé. Désormais le streak est calculé à la volée à l'affichage = nombre de **périodes consécutives réussies** remontant depuis aujourd'hui :

| Type | Période | Réussite |
|---|---|---|
| Quotidien | jour | jour coché |
| Lun-Ven | semaine | 5 jours ouvrés cochés |
| Hebdo (multi-jours) | semaine | tous les jours d'occurrence cochés |
| Mensuel | mois | occurrence du mois cochée (fin de mois inclus) |
| Annuel | année | occurrence de l'année cochée (skip 29 fév non bissextile) |
| Flottante hebdo | semaine | quota N atteint |
| Flottante mensuelle | mois | quota N atteint |
| Custom | — | nb total de complétions |

- Tolérance jour/semaine/mois en cours : si pas encore atteint, on ne casse pas le streak (on ne le compte juste pas)
- Stop quand on remonte avant `createdAt`
- Champ `streakCount` en data devient mort (rétrocompat). Plus mis à jour. Suppression prévue S7.
- `toggleOccurrenceComplete` ne touche plus `streakCount` (bug de double mutation supprimé)

**Label dynamique** : "X jours / semaines / mois / années / fois de suite" selon `periodLabel` retourné par `computeStreak`. Pluriel non géré (esthétique S7).

**Suppression affichage `graceDays`** (S5.5++)
- L'affichage "X jours de grâce autorisés" en card Routines retiré : sémantique cassée (ex : 2 jours de grâce sur une routine hebdo = inutile, 7 jours d'écart entre occurrences).
- Champ `graceDays` reste en data (rétrocompat), mais plus exposé ni utilisé.
- Pas de notion de cassure de streak avec tolérance — c'est toujours strict période à période.

#### Session Lot A→D — Polish features (épingles, RDV, chevauchement, vue mois agenda, routines multi-créneaux) ✅ LIVRÉE
Session découpée en 4 lots, validés et codés successivement (schema 7 → 9).

**Lot A — quick wins**
- Durée **5 min par défaut** à la création (tâche + sous-tâche).
- **Dupliquer** (modale d'édition) : clone l'arbre entier, `(copie)`, sans date/heure, reste hérité ; `isImportant` conservé seulement si une échéance subsiste.
- Bandeau "En retard" : ajout **✓ Fait** et **↳ Aujourd'hui**.

**Lot B — structure des colonnes**
- `isImportant` ne sert plus à trier dans les colonnes : les RDV **sortent des colonnes** vers un **bandeau "★ RDV & échéances"** en tête de l'accueil (aujourd'hui + à venir, 5 max + voir tout). Toujours comptés dans la capacité si datés aujourd'hui.
- **Épinglage** (`pinned`) : remonte une tâche en tête de colonne (au-dessus tri auto ET manuel), 1er niveau seulement, icône épingle + 📌.
- **Case "Terminé"** dans la modale d'édition (archive sans repasser par la liste ; occurrence du jour pour une récurrente).

**Lot C — agenda**
- **C1 — Chevauchement autorisé** : refus dur → toast info non bloquant ; resize libéré du buttoir ; **rendu côte à côte** en vue jour (`computeDayLanes`). Vue semaine inchangée (système "+N").
- **C2 — Vue mois type Google Agenda** : pastilles dot+heure+titre, tri horodaté par heure, "+N autres" → popover dépliant la journée sur place.
- **C3 — abandonné/reporté** : rappels RDV (déjà assez visibles) abandonnés ; **vue année reportée** à l'architecture temporelle V4 (n'a de valeur qu'avec les caps long-terme, inexistants dans le modèle actuel).

**Lot D — routines multi-créneaux**
- Champ `times` (≥2 créneaux/jour) + `slotHistory`. Une occurrence par créneau dans agenda + "Routines du jour" (triées par heure, #12), cochable séparément.
- **Streak tout-ou-rien** : `history` (dates) dérivé = jour compté ssi tous les créneaux faits ; confetti au dernier.
- Découvrabilité : bouton "+ Plusieurs fois par jour (routine)" dans la section Heure (active streak + ouvre l'éditeur de créneaux).
- Correctif clé : le wrapper `onToggleOccurrence` de la vue calendrier passe désormais le 3ᵉ argument `occTime` (sinon tout cochage basculait le jour entier).

**En réserve (issu de cette session, non fait)** : lanes en vue semaine, halos prep/trajet alignés sur les lanes, reflow live des voisins pendant un resize.

#### Session 6 — Refonte action Démarrer (→ V5 lot 2, en prod)
- **Fusion Mode focus + Démarrer tâche → 1 seule action "Démarrer"**
- **UX par défaut** : plein écran (mode focus actuel)
- **Bascule** : bouton pour passer en mini-modale (mode actuel "tâche en cours" / bandeau)
  → l'utilisateur peut toggle entre les 2 vues pendant la session
- **Logique temps** (D = durée focus pomodoro, par défaut 25 min, configurable) :
  - **Tâche ≤ D** (ex : 5, 10, 20 min) : démarre direct sur la durée estimée de la tâche, pas de pomodoro forcé, bilan estimé vs réel en fin
  - **Tâche > D** : découpe auto en tranches `D travail → pause → D travail → pause → reste`. Cycles imposés selon réglage pomodoro.

**Note ordre** : S6 (Démarrer) à remonter si la friction sur le pomodoro/focus devient prioritaire à l'usage.

#### Session 7 — Polish & irritants en vrac

**Bac à sable** des irritants accumulés à l'usage, issus de toutes les conversations précédentes. Ne pas attendre d'avoir une cohérence thématique : la session sert justement à liquider les petites frictions transverses qui ne rentrent dans aucune autre session.

**À traiter (cadrage à faire en début de session, certains points peuvent migrer ailleurs ou tomber)** :

**Verrou date passée à la création**
- Aujourd'hui rien n'empêche de créer une tâche/sous-tâche/habitude sur date+heure déjà passées dans la journée courante, ce qui fausse l'agenda du jour
- À trancher : refus dur ? warning soft ? exception pour habitudes (cas rattrapage) ?

**S4.5 — restes**
- Trajet retour asymétrique (valeur différente aller/retour, cas typique : retour à pied)
- Header badge "en retard de prep" : aujourd'hui le badge disparaît dès que l'heure de prep est dépassée. Option à creuser : laisser le badge avec couleur d'alerte tant que l'heure RDV n'est pas atteinte
- Modification prep/travel sur une occurrence récurrente touche le template (à vérifier si frustrant à l'usage)

**Mode sombre — vérifications transverses**
- Croix X de fermeture sur cartes/modals : lisible partout en mode sombre ?
- Checkboxes : visibilité sur tous les fonds (vu cas `cal-task` et `cal-block-important` corrigés, à vérifier sur tous les autres composants)
- Boutons ghost et icônes secondaires en cohérence avec `--ink`

**Filtres / vues**
- Vue ou onglet dédié "Deadlines" (potentiellement déjà couvert par les filtres avancés "Cette semaine / Ce mois / Ce trimestre" — à challenger à l'usage)

**Format de communication avec Claude**
- Préférer markdown pour les fichiers partagés (checklists, retours d'usage), pas docx — règle ajoutée dans les règles de fonctionnement

**Process** :
- Cadrer en début de session : revoir cette liste, supprimer ce qui n'est plus pertinent, prioriser
- Ajouter au fil de la session 5 et 6 ce qui ressort à l'usage avant le code de S7

### Phase 3 — Plus tard (notes consolidées)

**Stats & bilans**
- "J'ai fait quoi cette semaine"
- Compteur pomodoros, tendances habitudes
- Utile pour la philosophie "voir les vases communicants"

**Polish déploiement**
- Manifest PWA propre + icône Cap *(logo « barre à roue » livré le 2026-09-20 — en-tête, favicon, loader ; reste le manifest + icônes d'installation)*
- Monitoring d'erreurs (Sentry ou équivalent) — utile dès qu'il y a d'autres testeurs
- Amélioration sync : *(détection de conflit ✅ livrée — révision + CAS, correctif sync #2)* ; reste le **merge par tâche** (édition simultanée multi-appareils)

**Notifs / rappels avancés**
- **Vrai push notif** (Service Worker + Push API + cron côté serveur Supabase) — lié à la PWA propre, marche app fermée
- **Notification click → ramène sur la tâche concernée** dans l'app
- **Suppression compte auth Supabase complète** (delete user via Edge Function admin SECURITY DEFINER) — pour clean RGPD complet, aujourd'hui seules les données sont effacées, le compte auth reste

**Optim mobile / Android**
- Colonne droite vue Jour empilée sous l'agenda (déjà en CSS responsive < 1100px) — à valider à l'usage
- Bandeau "À planifier" vue Semaine en haut sur mobile (déjà en CSS) — idem
- Overlay du tap mieux positionné sur écrans étroits (déborde à droite à 320px → afficher à gauche si pas de place)
- Tap targets agrandies pour le tactile (poignée resize, checkboxes, pastille +N)

### Phase 4 — V4 vision : framework piliers
**Objectif** : faire de Cap un outil de boussole, pas juste un to-do.

**Conception d'abord, code après.**

**4a — Architecture temporelle** *(4a.1 ✅ en prod ; 4a.2 + 4a.3 ✅ codés — lots 1 à 3, voir « V4 Phase 4 codée »)*
- Caps annuels / 90 jours / mensuels / hebdo
- "1 chose principale" par échelle (one thing adapté TDAH)
- Bilans périodiques légers
- Inspiration méthode 90 jours de Stan Leloup
- **Mécanisme de confrontation hebdo/long-terme** : "tu as déclaré vouloir X cette année, cette semaine 0h dessus, tu valides ?". Cœur philosophique de Cap. Pas un dashboard joli — un moment de réalité. *(→ 4a.2)*

**4b — Tagging des piliers** *(✅ codé — lot 4)*
- Tagger tâches/habitudes/caps avec impact sur piliers (énergie / temps / argent / sens)
- Optionnel par défaut, ne pas alourdir l'usage de base
- **Tâches énergisantes vs épuisantes** : tagging à enrichir (au-delà du seul coût énergétique low/medium/high)

**4c — Pilier argent** *(✅ codé — lot 5)*
- Suivi entrées/sorties à 3 niveaux : quotidien / hebdo / mensuel
- Pas un outil bancaire, juste les flux

**4d — Visualisation vases communicants** *(✅ codé — lot 6)*
- Dashboard flux nets sur les piliers
- Patterns dans le temps
- Cœur conceptuel de Cap

**4e — Lignée des tâches** *(✅ socle 4a.1 + relecture des `why` au rituel hebdo et mensuel — lots 2-3)*
- Chaque tâche/habitude affiche sa filiation : cap hebdo → cap 90j → cap annuel → vision
- Remettre du sens dans le quotidien sans tagger en plus
- Un champ "pourquoi" obligatoire sur chaque cap, relu au bilan *(why obligatoire sur l'objectif, optionnel sur projet/jalon — acté en 4a.1)*

**4f — Prime time observé passivement** *(✅ codé — lot 7)*
- Cap détecte les heures où l'utilisateur finit ses pomodoros et suggère doucement
- Pas de tagging actif, juste de l'observation

**4g — Reprise/évolution des vues hebdo et mensuelle dans la perspective piliers** *(✅ lot 6 pour l'usage C, lot 8 pour M2 + vue Année ; heatmap horaire abandonnée)*
*Décisions reportées de S3 à V4 :*
- **Vue Semaine usage C (arbitrage piliers)** : agrégation des heures par pilier/catégorie sur la semaine, vue "où est passé mon temps". Cœur du framework piliers.
- **Vue Mois pistes 5 et 6 reportées** :
  - Heatmap horaire compacte par case (24 micro-pixels horizontaux indiquant les créneaux occupés du jour)
  - Pastilles catégories par case (un point par catégorie présente, plus aéré)
- **Vue Mois usage M2** : pilotage long-terme — caps mensuels visibles, streaks visuels par jour pour les habitudes (style heatmap GitHub).

**Garde-fous Phase 4** :
- Pas une usine à gaz
- Pas une prison productiviste
- Toute feature optionnelle ou invisible par défaut
- L'app sert la liberté, pas la mesure
- **Différence Cap-libérateur vs Cap-prison** se joue dans :
  - Ce que l'app dit quand on n'a rien fait (rien ? juge ? console ?)
  - La friction d'entrée des features piliers (combien de clics ?)
  - Présence ou absence de notion de "retard"
  - Ce qui se passe quand on casse un streak (l'app se réjouit-elle de pouvoir punir ?)

### Phase 5 — Polish final & partage (option)
Activée seulement si Cap convainc à l'usage et que le partage devient un objectif :
- PWA complète (service worker, hors-ligne, manifest soigné)
- Nom de domaine perso
- Page d'accueil
- Mécanique d'invitation testeurs

---

## Vision de fond

**Cap = instrument pour ne pas mourir avec ses rêves dans la tête.**

99% des gens sont emprisonnés par le quotidien et ne réalisent pas leur rêve faute de pouvoir y consacrer assez de temps, argent, énergie et sens. La fonctionnalité centrale de Cap, celle qui n'existe nulle part ailleurs : **rendre visible l'arbitrage entre quotidien et long terme, en temps réel.**

Le quotidien, par défaut, mange tout. Il est urgent, il crie, il a des deadlines. Le rêve, lui, ne crie jamais. Il attend.

**Distinction qui compte** :
- **To-do** = répond à "qu'est-ce que je dois faire maintenant ?"
- **Boussole** = répond à "est-ce que ce que je fais m'amène où je veux ?"
- V2 fait bien le premier. V4 vise le second. V3 est le pont (gestion fluide du quotidien + germes du long terme avec l'intention du jour).

**Framework piliers** :
- **Temps** : carburant méta (irrigue tout)
- **3 piliers vitaux** : Énergie, Argent, Sens
- **Sens** se subdivise en : Lien (relations) + Alignement (valeurs profondes)

**Liberté** = flux net positif sur les 3 piliers, avec un budget temps maîtrisé.

**Objectif Cap** : voir les vases communicants entre piliers, arbitrer consciemment, sortir du mode "course du hamster". Chaque action transfère entre piliers (coût/gain). Investir 5h cette semaine pour automatiser un truc = dépenser du temps maintenant pour en gagner plus tard.

**Inspiration** : méthode 90 jours de Stan Leloup adaptée TDAH ("1 chose par échelle de temps") + 4 axes de vie de Stan (business, famille, spirituel, santé) qui résonnent avec le framework piliers.

**Garde-fous** :
- Pas une usine à gaz
- Pas une prison productiviste
- L'app sert la liberté, pas la mesure
- Garder le cap et le bon tempo

---

## Règles de fonctionnement avec Claude

- Ne génère JAMAIS de fichier sans demander d'abord
- Mode carnet : quand des notes/idées arrivent, noter sans élaborer sauf si demandé
- Cadrer toujours avant de coder : specs → validation → code
- Pour les changements de design ou de structure, proposer d'abord
- Vérifier que le code compile avant de livrer un fichier
- **Les specs ne sont mises à jour qu'à la fin de la session** (ou à la fin d'un lot), après le code livré — pas en amont, ça bouge trop pendant l'implémentation. Elles sont commitées avec le code.
- **À chaque livraison, Claude produit une checklist live exhaustive** des points à vérifier en usage réel
- **Format des fichiers échangés** : markdown par défaut pour notes, retours d'usage et checklists. Pas de docx (ouverture lente, conversion à chaque lecture).

**1 conversation = 1 mission claire.** Pas de convo géante. Cadrage + code + corrections + finalisation specs dans la même session. Exemples :
- `Cap V3 - Session 1 sécurité & fondations` ✅ terminée
- `Cap V3 - Session 2 refonte Task/Habit + agenda` ✅ terminée
- `Cap V3 - Session 3 UX agenda` ✅ terminée
- `Cap V3 - Session 4 UX listes & power user` ✅ terminée
- `Cap V3 - Session 4.5 prep & trajet RDV` ✅ terminée
- `Cap V3 - Session 5 fusion habitude/récurrent` ✅ terminée
- `Cap V3 - Session 5.5 barres adaptatives + annuel + alertes + streak lazy` ✅ terminée
- `Cap V3 - Session 6 refonte Démarrer` (peut être remontée si friction pomodoro)
- `Cap V3 - Session 7 polish & irritants` (bac à sable des frictions accumulées)
- `Cap V3 - Lots A→D polish features` ✅ terminée
- `Cap V4 - design architecture temporelle` ✅ terminée (4a.1 codée)
- `Correctif sync #2 (révision + CAS)` ✅ terminée
- `Logo Cap + écran de chargement` ✅ terminée
- `Cap V4 - Phase 4 (4a.2 → 4g) en 8 lots` ✅ en prod

**Avant chaque session de code** : cadrage specs détaillées, validation, code.
**À la fin de chaque session** : mise à jour de ce specs pour refléter l'état réel + ajout des décisions reportées.

---

## Infos techniques persistantes

**URL prod (Vercel)** : `https://cap-lac.vercel.app`
**Ancienne URL (Netlify, remplacée)** : `https://cap-adhd-prod-app.netlify.app`
**Supabase URL** : `https://hrsdzqwgpklzqvhltowz.supabase.co`
**Supabase clé publique (publishable)** : `sb_publishable_PaES5uiS-4ShcbGipvMb6g_KkJ_nT5a`
**Variable Supabase dans le code** : `sb` (pas `supabase`, conflit avec `window.supabase`)
**Table de données** : `cap_data` (colonnes `user_id`, `data` JSONB, `rev` bigint, `updated_at`)
**Storage local key** : `cap-app-v2-{userId}`
**Storage clé révision sync** : `cap-app-v2-{userId}-cloudrev` (dernière `rev` cloud connue de ce device — base du compare-and-swap, voir correctif sync #2). *(Remplace `-cloudts`, plus utilisée dans le code.)*
**Storage clé conflit** : `cap-app-v2-{userId}-conflict` (stash du local non synchronisé avant adoption d'une version cloud plus récente)
**Supabase Auth — Site URL** : `https://cap-lac.vercel.app`
**Supabase Auth — Redirect URLs** : `https://cap-lac.vercel.app/**` (nécessaire pour reset password et confirmation email)
**Schema version** : **13** — 11 = horodatages/décisions caps + lowMode/reviews/weeklyFocus ; 12 = pillars/feel/quits/money ; 13 = focusLog. 10 = V4 4a.1 : ajout `capId` sur items + `caps`/`visions` au niveau state. Historique : 7 = fusion habitude/récurrent (`streak: bool`, règles `floatingWeekly`/`floatingMonthly`/`yearly`) ; 8 = `pinned` ; 9 = `times`/`slotHistory`. Champs morts conservés en rétrocompat : `streakCount`, `graceDays`, `lastEvaluatedPeriod`.

**Note timezone** : utiliser `dateToISO()` (formatage local) et non `toISOString().slice(0, 10)` (UTC) pour formater les dates. Sinon décalage de 1 jour selon fuseau horaire.

---

## Décisions reportées

**S5/S5.5 livrés** — voir détail dans la roadmap.

**S7 polish & irritants** (voir roadmap, à faire après S6) — bac à sable des irritants accumulés à l'usage. À traiter en S7 :
- Pluriel propre dans les labels streak ("1 jour" / "2 jours", "1 semaine" / "2 semaines", etc.) — esthétique
- **Suppression définitive des champs morts** : `streakCount`, `graceDays`, `lastEvaluatedPeriod` (rétrocompat depuis S5.5++, plus utilisés)
- Verrou date passée à la création (warning soft ou refus dur)
- Trajet retour asymétrique (S4.5 reste)
- Header badge "en retard de prep" : prolonger jusqu'à l'heure RDV même si prep dépassée
- Modification prep/travel sur occurrence récurrente touche le template (à vérifier à l'usage)
- Mode sombre — vérifications transverses (croix X, checkboxes, boutons ghost)
- **Suppression d'archives via bouton** : pouvoir supprimer définitivement une tâche archivée depuis la vue Archive (bouton dédié), pas seulement la restaurer. (demande usage — à confirmer : suppression à l'unité + éventuel « vider les archives » avec confirmation.)

**V4** (architecture temporelle + framework piliers) :
- ✅ *(lot 8)* **Vue année** (issue du Lot C3, reportée ici) : 12 mini-mois cliquables. N'a de vraie valeur qu'avec les **caps long-terme / 90j** (inexistants dans le modèle actuel) — à construire avec l'architecture temporelle, pas avant (sinon coquille de navigation faisant doublon avec la vue mois).
- ✅ *(lot 5)* **Pilier Argent** (carnet V3) : entrées/sorties quotidien/hebdo/mensuel, à intégrer au framework piliers.
- ✅ *(lot 4)* **Tagging des tâches par impact pilier** (carnet V3) : Énergie / Argent / Sens (Lien + Alignement).
- ✅ *(lot 6, dans Piliers)* Vue Semaine agrégation par pilier (usage C arbitrage piliers)
- *(lot 8 : heatmap abandonnée ; pastilles catégories déjà en C2 ; échéances des caps ajoutées)* Vue Mois heatmap horaire / pastilles catégories (usage M2 pilotage long-terme)
- **Vues bilan archive** : par mois / trimestre / année (au-delà de la semaine actuelle)
- **Vue/carte dédiée planification du jour d'après** (préparer la veille au soir, classique TDAH)
- **Auto-fill agenda** du jour : bouton qui case les Must (puis Should, puis Want) sans heure dans les créneaux libres, ordre énergie croissante (faible en haut). Découpage max en sous-tâches < 25-30 min comme principe. Sous-tâches en priorité dans le placement, tâches courtes intégrables. Enchaîner sous-tâches liées en commençant par les plus courtes. Système optionnel "dépend de la tâche X" si pas trop lourd.
- **Partage de tâches entre utilisateurs** (collaboration multi-comptes) — y compris le partage de RDV / proposer des tâches à d'autres (germe carnet 4a)
- ✅ *(lot 4 : « Ce que j'arrête »)* **Habitude négative / soustraction** (germe carnet 4a) → relève de **4b (piliers)**, pas de 4a. À traiter comme un *type d'impact pilier* : arrêter X = flux net positif (énergie/argent/sens). Possiblement un type de cap « arrêter X d'ici 90j ». Mécanisme (streak inversé : succès = abstinence, état « j'ai craqué » explicite) trivial une fois la couche piliers posée — ne pas construire isolément avant.
- **Pièces jointes sur une tâche** (germe carnet 4a) : PDF / JPEG, ex. compte-rendu ou ordonnance sur un RDV médical.
- **Champ "pourquoi" sur les caps** (annuel/90j/hebdo) relu au bilan — racine du mécanisme de confrontation *(✅ `why` livré en 4a.1 ; relecture au rituel — lots 2-3)*
- ✅ *(lot 4)* **Tag énergisant/épuisant a posteriori** : 😴/☀️/rien optionnel à la complétion d'une tâche, pour patterns au bilan
- **Lignée des tâches affichée** (cap hebdo → 90j → annuel → vision) sans tag manuel *(✅ livrée en 4a.1)*
- **Mini bilan dominical** : 30s, "qu'est-ce qui a compté cette semaine ?" — germe du bilan V4 sans la pyramide complète *(→ fusionné dans le rituel hebdo unique — ✅ lot 2)*
- **Mécanisme de confrontation hebdo/long-terme** : "tu as déclaré X cette année, cette semaine 0h, tu valides ?" — cœur philosophique de Cap *(→ ✅ lots 1-2)*
- **Concept "richesse en temps libre"** : indicateur permanent "Heures libres ce mois : X" = temps disponible après survie estimée
- **Plafonds durs TDAH-friendly** : max 1 cap hebdo principal + 2 secondaires, max 3 caps 90j actifs, max 1 domaine actif intensément *(→ tranché en 4a.1 : plafonds **soft** ; seule exception encore ouverte = hebdo principal unique, cf. décisions ouvertes 4a)*
- **Mode bas régime** / "période de pause" : tous les bilans sautés, caps en pause, pas de notif *(→ ✅ lot 1)*
- **Détection caps zombies** : si un cap 90j n'a aucune tâche depuis 3 semaines, demander au bilan hebdo "pause assumée ou perte de sens ?" *(→ ✅ lot 2)*
- **Anti-perfectionnisme** : aucun bilan obligatoire, pas de streak sur les bilans *(→ acté dans les garde-fous 4a)*
- **Limite saisie quotidienne** : si > 15 tâches dans une journée, "tu surinvestis le quotidien aujourd'hui. Pause ?"
- ✅ *(lot 7)* **Prime time observé passivement** : Cap détecte les heures où l'utilisateur finit ses pomodoros et suggère doucement
- **Import calendrier externe** (V4 ou plus tard) :
  - Phase 1 : import lecture seule depuis Google Calendar (OAuth Google via Supabase Auth probablement). Events affichés en grisé sur l'agenda Cap, sans interaction avec le moteur de chevauchement Cap. Permet de voir le contexte sans dupliquer la saisie.
  - Phase 2 : sync bidirectionnel (push tâches Cap avec date+heure vers Google). Difficile (conflits, doublons, ID mapping). À ne traiter qu'après usage stabilisé phase 1.
  - Phase 3 (hypothétique) : Cap remplace le calendrier (RSVP, invitations). Hors scope V4, peut-être jamais.
  - Outlook / iCal : via parsing iCal universel, après Google.
- **Liste de fêtes / anniversaires importées** (V4 ou plus tard) :
  - Anniversaires (mécanique de récurrence annuelle déjà dispo S5.5, manque l'import depuis carnet d'adresses ou Google Contacts)
  - Jours fériés français pré-chargés (calendrier officiel, configurable selon la région)
  - Fêtes culturelles configurables (saint du jour, fêtes religieuses, etc.) — opt-in
  - Affichage en agenda comme événements informatifs (style import calendrier ci-dessus)

**Phase 3 — plus tard** :
- Conversion Android via Capacitor (après V4 si pertinent)
- App PC native via Electron/Tauri (option future, faible priorité)
- Service worker / hors-ligne complet (Phase 5)
- Nom de domaine perso (Phase 5)
- Stats & bilans (Phase 3 plus tard)
- Manifest PWA propre + icône Cap (Phase 3 plus tard)
- Monitoring d'erreurs Sentry (Phase 3 plus tard, si testeurs externes)
- Amélioration sync : merge par tâche (Phase 3 plus tard — détection de conflit déjà livrée, correctif sync #2)
- Vrai push notif Service Worker + Push API (Phase 3 plus tard, lié à PWA propre)
- Notification click → ramener sur la tâche (Phase 3 plus tard)
- Suppression compte auth Supabase complète via Edge Function admin (Phase 3 plus tard)
- Optim mobile / Android (Phase 3 plus tard, à valider à l'usage)
