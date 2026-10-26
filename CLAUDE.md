# CLAUDE.md — Tournées de Neyron (PWA iPhone, GitHub Pages)

> Référence chargée à chaque session. La spécification d'origine est dans `CLAUDE_base.md` (archive, non chargée automatiquement) ; **ce fichier la remplace** et intègre le plan d'action, les constats sur les données réelles, les améliorations et la roadmap.

---

## 0. En bref et règles d'or

Projet : une web app installable sur iPhone pour faire des **tournées de tous les numéros de certaines rues** de Neyron (Ain, 01700, code INSEE **01275**). Elle affiche un plan cadastral avec le numéro de chaque maison, permet de **pointer les numéros faits** (un par un ou une rue entière) et montre **la position GPS**.

Un premier projet (plan interactif en artifact claude.ai + PDF A4 par rue) a fixé les données, traitements et pièges décrits ici. On repart sur une **PWA hors ligne hébergée en statique sur GitHub Pages**.

L'utilisateur est ingénieur réseau et sécurité, à l'aise techniquement. Interface et échanges en **français** ; identifiants de code en anglais.

**Règles d'or**
1. **Ne jamais lire `sources/`, `work/` ni `docs/data/`** (volumineux ou générés). Pour un format : le schéma §7.6 ou un extrait (`head -c 2000`).
2. **Aucun chemin absolu** dans le site (`/js/…` casse sous `/<repo>/`). Tout est relatif.
3. **Ne pas créer le dépôt GitHub ni pousser** sans accord explicite de l'utilisateur.
4. **Ne jamais committer** de progression, d'export JSON, de trace GPS ni de note sur les habitants.
5. Pas de framework, pas de bundler, **aucune dépendance JS à l'exécution**, aucun script tiers ni inline.
6. Après toute modification de JS/CSS/HTML : `python pipeline/build.py --stamp` (sinon l'iPhone garde l'ancienne version, §7.5). Les tests le vérifient (`build.py --check`).
7. **Tenir à jour les cases du plan (§2)** au fil du travail, et le journal des décisions (§14).

---

## 1. Environnement de développement (Windows 11)

| Outil | État au 19/10/2026 |
|---|---|
| Python 3.12 (`python` ou `python3`) | shapely 2.2, pyproj 3.8, scipy 1.18, numpy, pandas, Pillow installés (`--user`) |
| Node 22 / npm 11 | `@playwright/test` 1.64 (devDependency) ; navigateurs WebKit et Chromium installés |
| git 2.46 | branche `main`, remote `origin` (GitHub, privé) ; `core.autocrlf=true` sur ce poste, neutralisé par `.gitattributes` (`eol=lf`) |
| `gh` (GitHub CLI) | **absent** : créer le dépôt via l'interface web, ou installer `gh` (avec accord) |
| zcat / awk / grep | uniquement dans Git Bash → le pipeline n'en dépend pas (lecture gzip en Python) |

Commandes (PowerShell ou Git Bash, depuis la racine) :
```bash
pip install --user -r pipeline/requirements.txt     # shapely pyproj scipy numpy pandas pillow
npm install                                         # devDependencies : @playwright/test
npx playwright install webkit chromium
python pipeline/fetch_roads.py                      # télécharge le réseau routier (BD TOPO + OSM) dans sources/
python pipeline/build.py                            # régénère docs/data/ + stamp
python pipeline/build.py --stamp                    # recalcule seulement VERSION/PRECACHE de sw.js
python pipeline/build.py --check                    # vérifie que le stamp est à jour, sans rien écrire
python pipeline/build.py --preview                  # + work/preview.png pour contrôle visuel
python pipeline/build.py --force-extract            # relit les sources malgré le cache de work/
python pipeline/icons.py                            # regénère les icônes (build ne crée que les manquantes)
python -m http.server -d docs 8000                  # puis http://localhost:8000
npx playwright test                                 # tests (serveur lancé par la config sur le port 8100, §11)
```

---

## 2. Plan d'action v0.1 (à cocher au fil de l'eau)

**État : phases 0 à 9 terminées, phase 10 déployée le 19/10/2026 : app en ligne sur https://thoxym.github.io/Tracking-Tourn-e/ (dépôt public github.com/Thoxym/Tracking-Tourn-e, `main`, Pages sur `/docs`). Historique réécrit en e-mail `noreply` (identifiants des commits changés : `2ccfec2` phases 0-4 … `6fd0887` phase 9, `9f7d545` BASE_URL). Reste : checklist iPhone (§3) par l'utilisateur. Depuis le 20/10/2026, le travail se fait sur la branche **`dev_tracking_tournee_laposte`** (produit facteur, plan en §2 bis ; itinéraire reporté). Tout nouveau push reste soumis à l'accord de l'utilisateur (règle 3).**

### Phase 0 — Initialisation ✅
- [x] `git init` (local uniquement, branche `main`).
- [x] `.gitignore` : `sources/`, `work/`, `exports/`, `*.gpx`, `progress*.json`, `node_modules/`, `test-results/`, `playwright-report/`, et à la racine `/*.csv`, `/*.csv.gz`, `/*.json.gz`, `/*.json` (sauf `package*.json`). Plus `.gitattributes` (LF partout).
- [x] Déplacer `adresses-01.csv.gz`, `cadastre-01-batiments.json.gz`, `cadastre-01-parcelles.json.gz` dans `sources/`.
- [x] Créer l'arborescence §6, `docs/.nojekyll` (vide), `pipeline/requirements.txt`, `package.json`.
- [x] Installer les dépendances (§1).
- **Fin de phase** : `git status` ne montre aucun fichier source ; `python -c "import shapely, pyproj, scipy"` passe. ✔

### Phase 1 — Pipeline (`pipeline/config.py`, `geo.py`, `build.py`, `icons.py`) ✅
- [x] `config.py` : `STREETS` (nom BAN exact + filtre de numéros), `COLORS`, marges (110 m, 150 m), seuils d'association (40 %, 6 m, 25 m), `EXPECTED_COUNTS`.
- [x] Extraction : détection des sources par motif (département ou commune, `.csv`/`.csv.gz`/`_csv.gz`, `.json.gz`/`_json.gz`), lecture **gzip en streaming Python**, filtre 01275, cache dans `work/` (`extract-meta.json` : invalidé si nom, taille ou date de la source changent).
- [x] Ajustement affine GPS → Lambert-93 sur les 959 adresses ; **échec du build si résidu max > 0,5 m**.
- [x] Projection Lambert-93, emprise (bbox tournée + 110 m), filtrage parcelles/bâtiments (emprise + 150 m).
- [x] Association adresse ↔ bâtiment (STRtree) avec repli quand `cad_parcelles` est vide ; bâti dur préféré.
- [x] Tracés des rues « domaine non cadastré » (§7.4) ; aucune rue en repli MST.
- [x] Export `addresses.json`, `plan.json`, `version.json` (schéma §7.6) : tri naturel, `side`, `ctx`, paths SVG au décimètre, étiquettes de rues.
- [x] **Assertions** : comptes par rue, résidu affine, voies absentes de la BAN, ids en double → échec, sans toucher à `docs/data/`.
- [x] `--stamp` : hash du code + données → `version.json` et bloc `VERSION`/`PRECACHE` de `docs/sw.js` (§7.5). Testé : idempotent, insensible au CRLF, change si un JS change. Le bloc sera réellement écrit quand `sw.js` existera (phase 8).
- [x] `icons.py` : PNG 180, 192, 512 et maskable 512 (repère blanc coché sur fond bleu).
- [x] `--preview` : `work/preview.png` (parcelles, bâtiments liés, tracés, numéros, étiquettes) pour contrôle visuel.
- **Fin de phase** : ✔ build en ~20 s (9 s avec le cache), reproductible à l'octet près ; chiffres réels en §7.7.

### Phase 2 — Rendu du plan (`index.html`, `css/app.css`, `js/main.js`, `js/map.js`, `js/ui.js`, `js/theme-init.js`) ✅
- [x] `index.html` : CSP en meta, viewport iOS, `apple-touch-icon`, `theme-color` clair/sombre, modules ES. (Lien vers le manifest à ajouter en phase 8.)
- [x] `app.css` : tokens clair/sombre, `100dvh`, safe-area, `[hidden]{display:none!important}`.
- [x] Couches SVG (§8.1), zoom/déplacement par `viewBox` : pincement, glisser, molette, clavier, boutons +/−/tout voir ; cadrages animés.
- [x] Pointer capture seulement après 4 px de mouvement (§10) ; taps résolus en JS (`pointer-events: none` sur le contenu SVG).
- [x] Tailles constantes à l'écran (texte, halos) + `vector-effect: non-scaling-stroke` pour les traits ; barre d'échelle.
- [x] Tap → numéro pointable le plus proche à 22 px max ; panneau d'adresse (titre, lieu-dit, côté), la carte se décale si le panneau couvre l'adresse.
- [x] Légende repliable (repliée sur mobile, ancrée à gauche dès 900 px) : case = afficher/masquer, nom = sélection + zoom (cadre ≥ 220 m, hors légende).
- [x] Thème auto / clair / sombre (bouton), couleurs de rues relues depuis les données.
- **Fin de phase** : ✔ captures Chromium bureau + WebKit iPhone 13 sans erreur console ; gestes vérifiés par événements synthétiques (glisser, seuil 4 px, pincement ×2 sans dérive du point d'ancrage, double tap, appui long).

### Phase 3 — Pointage et stockage (`js/store.js`, `js/ui.js`) ✅
- [x] IndexedDB `neyron-tournees` : stores `events`, `tours`, `meta` ; tournée par défaut (id fixe `default`) ; `deviceId` et compteur `seq`. Mode dégradé en mémoire si IndexedDB est indisponible (avertissement).
- [x] État dérivé du journal (dernier événement par `(t, dev, seq)`).
- [x] Panneau bas : **Fait / À repasser / Remettre à faire** (seules les actions qui changent le statut sont proposées ; badge du statut actuel ; le panneau se ferme après l'action).
- [x] Statuts sur numéros, points et bâtiments, distincts par la forme (§8.1).
- [x] Progression par rue (« 12/18 », « 2 ↻ » à repasser, barre) et totale + « **Toute la rue faite** » (bouton ✓✓) avec confirmation `<dialog>`.
- [x] **Annuler** (groupes `grp`, §8.2) : bouton dans la barre du haut, lien dans le toast, Ctrl+Z ; plusieurs fois de suite et après relance.
- [x] `navigator.storage.persist()` au premier lancement, `persisted()` ensuite.
- **Fin de phase** : ✔ parcours complet vérifié en WebKit iPhone et Chromium (25 contrôles chacun) : Fait, À repasser, rechargement, refus puis acceptation de « Toute la rue faite », 3 annulations (états précédents restaurés, y compris « à repasser »), journal de 7 événements dont 4 d'annulation.

### Phase 4 — GPS (`js/gps.js`) ✅
- [x] `watchPosition`, conversion affine, point + cercle de précision, couleur selon précision, point grisé si position > 10 s.
- [x] Bouton unique localiser → suivre → arrêt ; suivre se coupe au glisser manuel (pas au pincement).
- [x] « Hors du plan (x km) » (sans liste).
- [x] Encart des **3 adresses non faites les plus proches**, distance + bouton « Fait » ; nom = ouvre le panneau d'adresse.
- [x] Relance sur `visibilitychange` ; rappel « pas de GPS écran verrouillé, gardez l'écran allumé » au démarrage et à chaque relance.
- **Fin de phase** : ✔ 21 contrôles en WebKit iPhone et Chromium avec géolocalisation simulée (28 Rue de la Gare à 0 m, suivre jusqu'au 9, glisser = fin du suivi, Fait depuis l'encart, précision 45 m = rouge, Lyon = « Hors du plan (7,9 km) », position ancienne, relance, panneau/encart, arrêt, autorisation refusée).

### Phase 5 — Wake Lock (`js/wakelock.js`) ✅
- [x] Bouton (soleil, barre du haut), réacquisition au retour au premier plan, message de repli « Réglez Verrouillage auto sur Jamais pendant la tournée ».
- [x] Reprise refusée hors geste : bouton « en attente » (orange) et nouvel essai au prochain toucher de l'écran.
- [x] Au démarrage du GPS, le toast propose « Garder l'écran allumé » (action du toast généralisée : `toast(msg, {action: {label, run}})`).
- **Fin de phase** : ✔ 13 contrôles en WebKit iPhone et Chromium avec une API Wake Lock simulée (tap, page masquée puis visible, reprise refusée puis toucher, arrêt, action du toast GPS, refus, API absente).

### Phase 6 — Export / import (`js/io.js`) ✅
- [x] Export JSON via `navigator.share({files})` si `canShare`, sinon lien `download` sur blob ; partage annulé signalé (pas de repli).
- [x] Import `<input type="file" accept=".json,application/json">`, fusion dédoublonnée sur `(dev, seq)`, recalcul de l'état, confirmation préalable, résumé (« 42 événements ajoutés »).
- [x] Menu « ⋮ » (barre du haut) : Exporter, Importer, Thème (déplacé depuis la barre), versions app / données en pied.
- **Fin de phase** : ✔ 23 contrôles en WebKit iPhone et Chromium : export (téléchargement, partage simulé, partage annulé), **export puis import sur un autre appareil : état identique**, conservé après rechargement, réimport sans doublon, réimport sur l'appareil d'origine, JSON invalide, fichier étranger, fichier piégé (5 entrées invalides ignorées, champ inconnu retiré, adresse inconnue signalée), refus de la confirmation.

### Phase 7 — Panneau debug (`js/debug.js`, `?debug=1`) ✅
- [x] Précision GPS, âge de la dernière position, état Wake Lock, résultat `storage.persist()`, `storage.estimate()`, mode standalone ou non, état du service worker, version app et données (+ build, écran, réseau, journal, appareil, dernier export, zoom, dernière erreur GPS).
- [x] Appui long (≥ 600 ms sans bouger) sur la carte = position simulée (coupe le vrai GPS ; ne vieillit pas).
- [x] Bouton « Copier le diagnostic » (presse-papiers, repli `execCommand`, texte sélectionnable).
- [x] Activation sans paramètre d'URL : **5 taps sur la ligne de version du menu** (l'app installée s'ouvre toujours sur `./`) ; choix mémorisé ; `?debug=0` désactive.
- [x] Journal des 15 dernières erreurs JS et promesses rejetées, toujours collecté.
- **Fin de phase** : ✔ 20 contrôles en WebKit iPhone et Chromium (sans debug : rien ; `?debug=1` ; mémorisation ; appui long sur le 28 = « 28 Rue de la Gare · 0 m » ; erreurs reprises ; copie ; réduire ; `?debug=0` ; 5 taps aller-retour).

### Phase 8 — Service worker et manifest (`docs/sw.js`, `docs/manifest.webmanifest`, `docs/js/pwa.js`) ✅
- [x] Manifest : `id`/`start_url`/`scope` `"./"`, `display: "standalone"`, icônes 192/512 + maskable, `lang: "fr"` ; lié dans `index.html`.
- [x] Précache complet (21 fichiers) avec `{cache: 'reload'}`, cache `neyron-tournees-<VERSION>`, cache d'abord, purge des anciens caches `neyron-tournees-*` uniquement, `clients.claim()`.
- [x] Bandeau « Nouvelle version disponible — Recharger » → `SKIP_WAITING` → rechargement sur `controllerchange` (seulement si l'utilisateur l'a demandé) ; `reg.update()` au retour au premier plan (≥ 30 min d'écart).
- **Fin de phase** : ✔ 14 contrôles en Chromium et WebKit (profil iPhone) : précache complet, page contrôlée dès la première visite sans rechargement ni bandeau, **rechargement hors ligne OK** (avec `?debug=1` aussi), pointage hors ligne conservé, mise à jour simulée sur un second serveur (bandeau, pas de rechargement imposé, « Recharger », nouveau cache, ancien supprimé, cache d'un autre site conservé). Chromium : aucune erreur d'installabilité ni de manifest.

### Phase 9 — Tests Playwright (`tests/`, `playwright.config.js`) ✅
- [x] Projets WebKit (profil iPhone) et Chromium. `webServer` = `tests/serve.py` sur 127.0.0.1:8100 plutôt que `http.server` : sa file d'attente de 5 connexions déborde en parallèle (§10).
- [x] Les 6 cas de §11, plus les vérifications des phases 2 à 8 (gestes, GPS, Wake Lock, import piégé, debug, mise à jour du SW).
- [x] `build.py --check` : échoue si `docs/` a changé sans stamp ; appelé par les tests.
- **Fin de phase** : ✔ `npx playwright test` vert. 25 tests × 2 navigateurs (un seul passage pour le stamp) : 49 réussis, 1 ignoré, 48 s. Stable sur 3 répétitions ; sabotages volontaires détectés.

### Phase 10 — Déploiement (uniquement avec accord explicite) — en ligne
- [x] Dépôt **public** `Thoxym/Tracking-Tourn-e`, recréé vide par l'utilisateur (l'ancien dépôt privé portait l'e-mail personnel dans des commits accessibles par identifiant) ; push de `main` (`9f7d545`).
- [x] Pages : « Deploy from a branch », `main`, dossier `/docs` ; HTTPS imposé. Premier déploiement en erreur 502 côté GitHub (« Creating Pages deployment failed ») : une simple relance du job a suffi.
- [x] Ruleset `protect-main` (branche par défaut, aucune exception) : suppression et force-push interdits.
- [x] Site vérifié : types MIME corrects, HSTS 1 an, `http://` → 301, **51 tests réussis contre le site en ligne** (`BASE_URL=… npx playwright test`).
- [ ] Checklist iPhone (§3), par l'utilisateur.

---

## 2 bis. Branche `dev_tracking_tournee_laposte` : produit « facteur » (créée le 20/10/2026)

`main` garde la v0.1 en ligne. Cette branche fait évoluer l'app vers la **distribution du courrier** : savoir ce qui a été distribué, ce qui reste à traiter, si une rue est entièrement couverte, pourquoi une adresse n'a pas pu être desservie, et reprendre une tournée interrompue sans oublier de boîte. Utilisable **d'une seule main**, sans menus imbriqués. **Pas de calcul d'itinéraire** : la personne compose sa tournée elle-même. Une proposition d'optimisation viendra plus tard (§12 A).

**Interface** : une barre d'onglets en bas, sobre, avec trois onglets :
- **Préparer** : rues, secteur, numéros, charge de travail, adresses manquantes ;
- **Distribuer** : position, adresses à traiter, pointage d'un numéro ou d'une rue, anomalies sans interrompre la tournée ;
- **Contrôler** : distribuées, non traitées, motifs, rapport exportable.

### Architecture : ce qui tient, ce qui doit évoluer
| Besoin | Aujourd'hui | Évolution | Quand |
|---|---|---|---|
| Pointage hors ligne, rue entière, annulation, reprise après relance | journal d'événements IndexedDB, état dérivé, pile d'annulation persistante | aucune (socle réutilisé) | — |
| Plusieurs tournées | store `tours` et champ `tour` dans chaque événement, mais l'interface ne connaît que `default` | tournée = nom + sélection ordonnée d'adresses ; IndexedDB v2 avec migration de `default` | branche |
| Sélectionner librement des rues | 10 rues figées dans `config.py`, 229 adresses | pipeline en mode **commune entière** (942 adresses, 90 voies), sélection dans l'app | branche |
| Couleurs | une couleur par rue | impossible avec 90 voies : couleurs par **statut et sélection**, liste de rues avec recherche à la place de la légende | branche |
| Anomalies | statuts fait / à repasser / à faire | statut `anomalie` + **motif codé** (liste fermée) ; export en `schema: 2`, `schema: 1` toujours importable | branche |
| Charge de travail, adresses manquantes | rien | pipeline : longueur de chaque voie, bâtiments sans adresse, adresses sans bâtiment ; app : durée estimée paramétrable | branche |
| Rapport | export JSON brut | synthèse à l'écran, rapport CSV et JSON par la feuille de partage | branche |
| Navigation | une seule vue carte | barre d'onglets, 3 vues ; la carte est partagée entre Préparer et Distribuer (même `MapView`) ; `ui.js` découpé en `views/*.js` | branche |
| Autres communes ou secteurs (Lyon 3e) | un seul jeu de données précaché | paquets de données par secteur, téléchargés et mis en cache à la demande ; au-delà de quelques milliers de numéros, le SVG devient lourd (masquage hors écran ou canvas) | plus tard |
| Remplaçant, plusieurs téléphones, encadrement | export/import manuel | synchro = **backend** (authentification, chiffrement, hébergement UE) ; GitHub Pages ne suffit plus. Le journal en ajout seul, à clés `(dev, seq)`, est déjà prêt pour une fusion | plus tard |
| Boîtes aux lettres | la BAN donne des **numéros**, pas des boîtes | nombre de boîtes par adresse saisi localement (immeubles) | plus tard |
| Itinéraire optimisé | — | graphe piéton + voyageur de commerce (§12 A) | plus tard |
| Usage professionnel réel | app perso, dépôt public, origine partagée | cadre RGPD salarié (CNIL), DPO, MDM, origine dédiée, déploiement non public ; **ni nom ni logo La Poste** sur un site public sans autorisation | à valider avant tout usage réel |

- **Code** : vanilla sans framework, ça tient pour 3 vues. Si les formulaires se multiplient, une petite bibliothèque intégrée au dépôt (Preact ou Lit, sans bundler) est envisageable, mais pas maintenant.
- **RGPD (renforcé)** :
  - Certains motifs concernent les occupants (« destinataire inconnu ») : ce sont des données personnelles. Donc codes seulement, pas de note libre par défaut, tout reste sur l'appareil.
  - Un rapport horodaté, c'est le suivi de l'activité d'un salarié : rapport **agrégé par défaut**, heures en option.
  - La trace GPS n'est jamais enregistrée.
- **Déploiement de la branche** : Pages sert `main`. Pour tester sur l'iPhone, deux options :
  - publier temporairement la branche sur Pages, ce qui remplace la v0.1 ;
  - utiliser un second dépôt.

  Dans les deux cas, l'origine est la même (`thoxym.github.io`). Préfixes IndexedDB, caches et `localStorage` **distincts de `neyron-tournees`** si les deux apps coexistent. À décider en L8.

### Plan de la branche (à cocher)
- [x] **L1 — Navigation** ✅ (20/10/2026).
  - `js/tabs.js` (`TabBar`) : barre en bas, 56 px + safe-area, `aria-current="page"`, onglet mémorisé dans `localStorage['neyron-tournees.tab']`, Distribuer par défaut.
  - **La carte reste en place sous les vues** : Préparer et Contrôler sont des panneaux opaques par-dessus, sans redimensionnement, et le GPS ou le suivi continuent. Hors Distribuer, légende, panneau, encart, échelle et contrôles sont en `visibility: hidden`, ce qui garde des tailles valables pour `updatePadding`.
  - `--bottom-ui` (barre + safe-area) remplace `--safe-b` pour tout ce qui est ancré en bas ; `#map` s'arrête au-dessus de la barre.
  - Quitter Distribuer ferme le panneau d'adresse et le menu.
  - « Rues » depuis un autre onglet ramène à la carte, légende ouverte (écouteur en capture sur `document`).
  - Grand écran : encart GPS et échelle à droite de la légende ouverte (`:has`).
  - `js/views/prepare.js` (squelette) : tournée en cours (nom, rues, adresses), liste des rues (pairs / impairs, nombre de numéros). Une rue ouvre la carte, rue sélectionnée et cadrée.
  - `js/views/control.js` (squelette) : faites / restantes / à repasser, barre de progression, détail par rue mis à jour en direct (`store.onChange`), export.
  - Rendu des lignes partagé dans `js/views/common.js`.
  - Tests : `tests/navigation.spec.js` (7 tests × 2 moteurs). Suite complète : 65 réussis, 1 ignoré ; navigation et GPS stables sur 3 répétitions.
- [x] **L2 — Commune entière** ✅ (20/10/2026).
  - Pipeline : toutes les voies ayant une adresse `entrée` → **941 adresses sur 90 voies**. Le 942e est un doublon BAN (« 2 Impasse Privée des Capucins », même id, à 25 m) : on garde la première occurrence, et le build le signale.
  - Rue `s` = rang alphabétique sans accents (`street_sort_key`). Contrôle des totaux (`EXPECTED_ADDRESSES`, `EXPECTED_STREETS`). Plus de numéros de contexte (`ctx` toujours `false`, champ gardé pour compatibilité).
  - **Tournées prédéfinies** : `config.PRESETS` → `addresses.json` `presets: [{id, name, ids}]`. Les 10 rues de la v0.1 = preset `default` (229 ids, comptes par rue vérifiés comme avant). C'est l'id de la tournée par défaut de l'app : la progression déjà saisie s'y rattachera en L3.
  - **Couleurs** : `PALETTE` de 8 teintes sans vert ni orange (réservés aux statuts). Coloration gloutonne des rues voisines (tracés à moins de 30 m, `geo.neighbor_colors`) : 0 paire de voisines de même couleur, jusqu'à 25 voisines par rue.
  - `streets[].len` : longueur de l'arbre couvrant des adresses (m), pour la charge en L4. 20,8 km au total.
  - Cadre 2060 × 3200 m. 2773 parcelles, 2151 bâtiments. 874 adresses liées à un bâtiment, 67 sans (base du contrôle « adresses manquantes » en L4). `addresses.json` 161 Ko, `plan.json` 670 Ko. Build en 7 s avec le cache.
  - App : légende devenue liste des rues **avec recherche** (sans accents ni casse ; Ctrl+Z dans le champ n'annule pas la progression), recherche aussi dans Préparer. Champs à 16 px (sinon iOS zoome) et sélectionnables malgré `user-select: none`.
  - Tests pilotés par les données (`total()`, `STREET` recherché par nom). 69 réussis, 1 ignoré.
  - **Perf** (WebKit Windows, rendu logiciel) : environ 220 ms par image de zoom contre 170 ms pour `main` (229 adresses), soit +30 à 50 %. Acceptable à Neyron. Pour Lyon 3e (milliers de numéros), il faudra ne dessiner que ce qui est à l'écran ou passer au canvas.
- [x] **L3 — Tournées** ✅ (20/10/2026).
  - **Modèle** : tournée `{id, name, createdAt, updatedAt, archived, ids[]}`, où `ids` est la composition, rangée dans l'ordre des données.
    - Pas de changement de version IndexedDB : les fiches de `tours` sont seulement enrichies.
    - **Migration** au démarrage (`Store.open(dataVersion, presets)`) : une tournée sans `ids` reçoit ceux du preset de même id. La tournée `default` de la v0.1 devient « Neyron — 10 rues », progression et pile d'annulation conservées. Un premier lancement crée les presets.
  - **Store** :
    - `activeTour`, `liveTours()`, `archivedTours()` ;
    - `stateOf(tourId)` : statuts d'une tournée non active ;
    - `createTour`, `updateTour`, `setActiveTour` (émettent `{type: 'tour'}`) ;
    - `archiveTour`, qui bascule sur la plus récente des autres et refuse d'archiver la dernière tournée en cours. Rien n'est supprimé.
  - **Import** : `validTour` accepte `ids` (20 000 au plus) et `updatedAt`. Une tournée connue est remplacée si la version importée est plus récente (dernière écriture gagnante) ; une ancienne sauvegarde sans `updatedAt` ne remplace jamais rien. La confirmation nomme les tournées nouvelles ou mises à jour.
  - **Carte** :
    - `map.setScope(ids)` : hors tournée, numéros, points et bâtiments en gris (`.out`), rues sans adresse de la tournée atténuées (`.dim`) ;
    - hors tournée, pas de tap (`hitTest`), pas de statut affiché, absent de l'encart GPS ;
    - « voir tout » cadre la tournée ; changer de tournée recadre ;
    - `map.selecting` rend tout pointable pendant la composition.
  - **Interface** : `ui._applyTour()` recalcule `byStreet` (adresses de la tournée par rue), donc légende (« Rues de la tournée », message si vide), progression, « Toute la rue faite » et Contrôler. `ui.prompt()` sert à la saisie d'un nom, `ui.tapOverride` à la composition.
  - **Préparer** :
    - liste des tournées (active cochée, « n adresses · k faites »), Nouvelle tournée (nom par défaut « Tournée du jj/mm »), Renommer, Archiver, section repliable « Tournées archivées » (un toucher restaure) ;
    - rues de la commune avec recherche (« k/n dans la tournée ») ; une rue ouvre l'**éditeur** : Tous / Pairs / Impairs, plage du n° au n°, aperçu « x numéros concernés · y déjà dans la tournée », Ajouter, Retirer, Voir sur la carte ;
    - **Choisir sur la carte** : la carte s'affiche avec ses contrôles et une barre « Tournée : n adresses — Terminer ». Un tap ajoute ou retire. Changer d'onglet termine la composition.
  - Tests : `tests/tournees.spec.js` (7 × 2 : migration d'une base v0.1 réelle, hors tournée non pointable, composition par rue, progression par tournée, renommer / archiver / restaurer, composition sur la carte, export / import des tournées). Les anciens tests sont adaptés (tournée par défaut de 229 adresses). Suite : 83 réussis, 1 ignoré ; tournées et navigation stables sur 3 répétitions.
  - Limite assumée : les changements de composition ne s'annulent pas (Annuler ne concerne que les statuts).
- [x] **L4 — Préparer** ✅ (20/10/2026).
  - **Calculs sans DOM** dans `js/tourplan.js` :
    - `streetOrder`, `sequence` (adresses dans l'ordre de passage) ;
    - `mstLength` (Prim), `workload`, `findGaps`, `nearUnaddressed`, `parseSector` ;
    - réglages de l'estimation (`localStorage['neyron-tournees.workload']`).
  - **Ordre de passage** : champs `order` et `reverse` de la tournée.
    - Ils sont enregistrés par **clé de voie BAN** (`01275_0420`, début de l'id des adresses ; une clé par rue, vérifié), pas par rang `s`, qui se décalerait si une voie apparaissait.
    - Sans ordre choisi : ordre alphabétique. Une rue ajoutée ensuite arrive en fin d'ordre.
    - Préparer, section repliable « Ordre de passage » : Monter, Descendre, Inverser le sens (numéros décroissants), « Ordre alphabétique » (avec confirmation). Le focus reste sur le bouton utilisé.
    - La légende de Distribuer et Contrôler suivent cet ordre (`ui.order`, `ui.sequence()`).
  - **Charge estimée** :
    - nombre d'adresses ;
    - distance = arbre couvrant des adresses de chaque rue + liaisons à vol d'oiseau entre la fin d'une rue et le début de la suivante ;
    - durée = adresses × temps par adresse (20 s par défaut) + distance ÷ vitesse (4 km/h).
    - Réglages propres à l'appareil (virgule acceptée, valeur invalide signalée puis abandonnée). Tournée par défaut : ≈ 10,6 km, ≈ 3 h 55 en ordre alphabétique.
    - Contrôler affiche le **reste estimé** sur les adresses non faites.
    - Le Prim de l'app retrouve à 1 m près `streets[].len` du pipeline (scipy).
  - **Vérifications** (section repliable, nombre de points en titre) :
    - **numéros oubliés** : hors tournée mais entre deux numéros de la tournée du même côté ; « Ajouter » en un geste ;
    - **numéros sans bâtiment** (`bat: null`) : ouvre le panneau d'adresse sur la carte ;
    - **bâtiments sans adresse** à moins de 60 m de la tournée : carte centrée, repère rouge (`map.mark`).
    - Pipeline : `addresses.json` → `unaddressed: [{x, y, a}]`, soit le bâti dur ≥ 50 m², lié à aucune adresse, sur une parcelle qu'aucune adresse de la commune ne cite, à plus de 20 m de tout point d'adresse (`geo.unaddressed_buildings`, `config.UNADDRESSED_*`). 29 dans la commune, 2 près de la tournée par défaut. Tournée par défaut : 0 oublié, 8 sans bâtiment.
  - **Import d'un secteur** (CSV) :
    - format `voie;début;fin;côté`, séparateur `;`, tabulation ou `,` (détecté), guillemets, en-tête et lignes `#` ignorés ;
    - UTF-8 (BOM accepté), sinon **Windows-1252** (Excel en français) ;
    - voie comparée sans accents, casse, apostrophes ni tirets, avec une suggestion si le nom est proche (« Rue de la Garre » → « Rue de la Gare » ?) ;
    - côté : tous, pairs, impairs ; début > fin = sens inversé ; l'ordre des lignes donne l'ordre de passage.
    - Crée une nouvelle tournée (nom = nom du fichier, modifiable). Le dialogue résume le secteur et les 3 premières lignes ignorées.
    - Donnée non fiable : 512 Ko et 5000 lignes au plus, `textContent` seulement.
  - Export / import : `validTour` garde `order` et `reverse` (clés ≤ 64 caractères, 2000 au plus).
  - Tests : `tests/preparer.spec.js` (4 × 2 : charge et réglages, ordre de passage, vérifications, import CSV), et l'export des tournées vérifie l'ordre et le sens. Sabotages détectés (liaisons entre rues supprimées, sens ignoré). Suite : 91 réussis, 1 ignoré ; préparer, tournées et navigation : 108/108 sur 3 répétitions, avec un délai WebKit porté à 75 s (§10).
- [x] **L5 — Distribuer** ✅ (20/10/2026).
  - **Statut `anomalie` avec motif codé** (`why`), liste fermée validée par l'utilisateur (`store.REASONS`) :
    - `absente` : boîte absente ;
    - `inaccessible` : boîte inaccessible ;
    - `pleine` : boîte pleine ou abîmée ;
    - `introuvable` : numéro introuvable ;
    - `inconnu` : destinataire inconnu ;
    - `autre`.

    Aucune note libre (RGPD). Une anomalie est une adresse **traitée** (`isTreated` : distribuée ou anomalie).
  - **Store** : `setStatus(ids, st, why)` (changer de motif est une action) ; `reason(id)` ; Annuler rétablit statut **et** motif précédents ; l'événement ne porte `why` que pour une anomalie.
  - **Import** : `validEvent` exige un motif de la liste pour une anomalie (sinon entrée ignorée) et retire `why` des autres statuts. Toujours `schema: 1` : une v0.1 ignorerait seulement ces événements (export v2 en L7).
  - **Libellés** : « Fait » devient **« Distribué »** partout (le statut interne reste `fait`). « Toute la rue distribuée » marque les restantes (à faire, à repasser) et **conserve les anomalies**. La pastille du haut compte les adresses traitées.
  - **Panneau d'adresse** : Distribué / Anomalie / À repasser / Remettre à faire, en grille, boutons de 52 px. « Anomalie » reste proposée sur une anomalie (changer de motif). Badge « anomalie : boîte absente ».
  - **Choix du motif** : `ui.pickReason()`, un `<dialog>` en bas d'écran avec 6 gros boutons (2 colonnes) ; le motif actuel est mis en avant. Le focus initial est sur Annuler (`autofocus`), si bien qu'un Entrée par erreur ne choisit rien. Échap annule sans fermer le panneau.
  - **Reprendre** (`js/views/distribute.js`, `DistributeView`) :
    - prochaine adresse = première « à faire » dans l'ordre de passage (`ui.sequence()`), puis les « à repasser » ;
    - bouton « Reprendre · adresse » en bas à gauche, puis carte « prochaine adresse » : position (« Rue 3/10 · 4 numéros restants »), adresse, côté, lieu-dit ;
    - boutons de 60 px **Anomalie** et **Distribué** (à droite, sous le pouce), puis À repasser et « Toute la rue (n) » ;
    - la carte avance seule après chaque action ; la carte du plan garde l'adresse visible (`ensureVisible`, ou recentrage si le zoom est trop faible), sauf en mode suivi GPS ;
    - un **second toucher dans les 500 ms est ignoré**, pour ne pas distribuer l'adresse suivante par erreur ;
    - Annuler (toast ou barre du haut) ramène l'adresse précédente ;
    - fin de tournée : « Tournée terminée · n distribuées, k anomalies » et « Voir le bilan » ;
    - reprise mémorisée (`localStorage['neyron-tournees.guided']`) : retrouvée après une relance ;
    - pendant la reprise, l'encart GPS s'efface (`ui.guided`) ; un toucher sur le plan ouvre le panneau d'adresse, et la carte « prochaine » réapparaît ensuite.
  - **Dock** en bas à gauche (`#dock`) : empile « Reprendre », l'encart GPS et la carte « prochaine adresse ». Sa hauteur entre dans la marge basse de la carte et décale l'échelle (`--dock-h`, ex-`--nearby-h`).
  - **Rendu** : anomalie = pastille **rouge** (`--anomalie`) à chiffres penchés, point **carré** en vue d'ensemble, bâtiment rouge. Compteurs d'anomalies avec une icône SVG, et non le caractère ⚠ (emoji jaune sous Windows, §10).
  - **Contrôler** : 4 cases (distribuées, restantes, à repasser, anomalies), « n / N adresses traitées », rue « entière traitée », anomalies par rue. L'encart GPS ignore les adresses traitées.
  - Tests : `tests/distribuer.spec.js` (4 × 2 : anomalie et motifs depuis le panneau ; reprise complète d'une tournée de deux rues avec double toucher, Annuler, à repasser, anomalie, toute la rue, fin et relance ; panneau pendant la reprise ; comptes, encart GPS, toute la rue et import des motifs). Anciens tests adaptés aux nouveaux libellés. Sabotages détectés (protection du double toucher, motif non rétabli par Annuler). Suite : 99 réussis, 1 ignoré. Distribuer, pointage, GPS et navigation × 3 : 114/114, dont 1 réussi au second essai (blocage WebKit, §10).
- [x] **L6 — Contrôler** ✅ (20/10/2026).
  - **Synthèse** :
    - 4 cases et la progression (déjà en L5) ; par rue, dans l'ordre de passage, avec les anomalies ;
    - section repliable **Anomalies** : barres par motif (motifs présents, du plus fréquent au moins fréquent), puis la liste des adresses et leur motif ;
    - section repliable **Non traitées** : à faire et à repasser, dans l'ordre de passage ;
    - un toucher sur une ligne ouvre l'adresse sur la carte (panneau).
  - **Rapport** (`js/report.js`, sans DOM) :
    - une ligne par adresse de la tournée, dans l'ordre de passage : `rue;numero;complement;cote;statut;motif`, avec les statuts distribuée / anomalie / à repasser / non traitée ;
    - **CSV** pour Excel en français : `;`, BOM UTF-8, CRLF. Les cellules sont protégées contre l'injection de formule (`'` devant = + - @) et les guillemets ;
    - **JSON** : `{kind: 'rapport', tournee, date, totaux, anomalies_par_motif, rues[], adresses[]}` ;
    - **sans heure par défaut** (RGPD : les heures retracent l'activité de la personne). Une case « Inclure les heures de pointage » (préférence d'appareil, `neyron-tournees.report-hours`) ajoute la colonne `heure` (dernier changement) et `passage.debut/fin` ;
    - nom du fichier : `rapport-<tournée>-AAAAMMJJ.csv|json` ;
    - envoi par la feuille de partage, sinon téléchargement (`io.shareFile`, commun avec la sauvegarde) ;
    - un rapport importé comme sauvegarde est refusé avec un message clair.
  - **Clôture du passage** :
    - une tournée se refait chaque jour : clôturer pose une **borne** dans le journal (`tour.closures[].at`) et la tournée repart à zéro. Rien n'est effacé ; seuls les événements postérieurs comptent (`store.passageStart`, `derive(tourId, from, to)`) ;
    - l'historique garde un **bilan agrégé** par passage (`{at, start, n, done, again, todo, anomalies: {motif: n}}`), sans détail par adresse ;
    - la confirmation rappelle le nombre de non traitées et invite à exporter le rapport avant. Juste après, le toast propose « Rapport CSV » du passage clôturé ;
    - le dernier passage peut être **rouvert** tant que rien n'a été pointé depuis ;
    - les actions du passage clos ne s'annulent plus ; la reprise guidée s'arrête ;
    - si l'horloge du téléphone recule, un nouvel événement est daté juste après la borne (sinon il serait invisible) ;
    - import : `validTour` valide les passages (comptes ≥ 0, début < fin, motifs de la liste) et les trie.
  - Tests : `tests/controler.spec.js` (4 × 2 : synthèse et listes ; rapports CSV / JSON, heures, partage, injection, refus à l'import ; clôture, historique, rapport du passage clos, réouverture, relance ; horloge qui recule et passages importés). Sabotages détectés (borne ignorée, garde anti-formule retirée). Suite : 106 réussis, 1 ignoré, 1 réussi au second essai (le test cliquait le toast après ses 8 s : corrigé) ; contrôler × 5 : 40/40 ; contrôler, sauvegarde, distribuer et navigation × 3 : 108/108.
- [x] **L7 — Robustesse** ✅ (20/10/2026).
  - **Sauvegarde au format 2** (`store.BACKUP_SCHEMA`) :
    - contenu : composition, ordre, sens, passages clôturés, anomalies et motifs ;
    - import des formats 1 (v0.1) et 2. Une tournée v0.1 sans composition (`legacy`) reçoit le preset de même id, comme la migration au démarrage, et ne remplace jamais une tournée connue ;
    - format plus récent : refusé avec la consigne « mettez l'app à jour » ;
    - une v0.1 refuse en bloc un fichier v2, plutôt que d'en recalculer un état faux sans les bornes de passage.
  - **Écritures** :
    - le store écrit **avant** de modifier la mémoire (`createTour`, `updateTour`, clôture, réouverture) : si l'écriture échoue, l'écran ne montre pas un changement perdu à la relance ;
    - les actions de Préparer et Contrôler passent par `common.guard` : toast « Enregistrement impossible : … » au lieu d'une promesse rejetée silencieuse (le pointage l'avait déjà).
  - **Journal d'un an** (mesuré : 300 passages de 229 adresses, 68 700 événements, Chromium) :
    - état recalculé en 3 ms, rendus de Préparer et Contrôler en 7 et 20 ms, relance en 0,5 s : pas d'optimisation nécessaire ;
    - les `Math.max(...)` et `push(...)` sur tout le journal sont remplacés par des boucles (limite d'arguments d'un appel, qui dépend de la pile du moteur) ;
    - WebKit sous Windows écrit 15 ms par événement dans IndexedDB : importer une grosse sauvegarde y est lent (moteur de test, pas l'app).
  - **Ergonomie à une main** (audit, puis test) :
    - toutes les cibles font au moins 44 px : noms de rues de la légende (34), « Distribué » de l'encart GPS (36), action du toast (36), champs de recherche et de réglage (40), en-têtes repliables (32), Tous / Pairs / Impairs (40), « Rouvrir » (40) ;
    - **bug corrigé** : dans une vue qui défile, les boutons s'écrasaient sous leur hauteur (« Sauvegarder la progression » à 24 px). Correctif : `.view-body > * { flex-shrink: 0 }`.
  - **RGPD** : revue en §13 ; mention sous « Sauvegarder la progression » (historique horodaté : à garder pour soi, ce n'est pas un rapport).
  - Tests : `tests/robustesse.spec.js` (5 × 2) :
    - parcours complet **hors ligne** : secteur importé, ordre, reprise avec anomalie et toute la rue, rapport, clôture, relance ;
    - format 2 d'un appareil à l'autre, état identique ;
    - fichiers v0.1 (annulation rejouée, preset) et format futur ;
    - stockage plein ;
    - cibles ≥ 44 px et boutons nommés dans les 3 vues, le panneau, le choix du motif, la reprise, le menu et l'éditeur de rue.

    Sabotages détectés (migration v0.1 retirée, écrasement des boutons remis). Suite : 117 réussis, 1 ignoré. Robustesse, sauvegarde, tournées et contrôler × 3 : 114/114.
- [ ] **L8 — Déploiement de la branche** (canal à décider, accord explicite).

**À valider par l'utilisateur** :
- ~~statuts et liste des motifs~~ : validés le 20/10/2026 (L5) ;
- nom de l'app (sans marque La Poste) ;
- canal de déploiement de la branche.

### 2 ter. Refonte de l'interface (décidée le 25/10/2026, avant toute publication)
Style **Liquid Glass** (iOS 26) : matériaux translucides flous (`backdrop-filter`), coins très arrondis, composants iOS (listes groupées, interrupteurs, contrôle segmenté, alertes, feuille d'actions, menu déroulant). **Au plus simple, sans perdre de fonction.**
- **Carte plein écran**, toujours visible. Boutons en verre posés dessus : Annuler en haut à gauche ; colonne en haut à droite avec menu ⋯, localiser et écran allumé ; « voir tout » dessous ; zoom +/− seulement à la souris.
- **Feuille à crans** (petit / moyen / grand) par-dessus la carte, comme Localiser ou Plans. Les 3 onglets (**capsule flottante** en bas) changent son contenu, et chaque onglet garde son cran. Navigation par pages dans la feuille (retour « ‹ »), au lieu des sections repliables. Sur grand écran : panneau latéral fixe.
- **Distribuer** : la **prochaine adresse** est toujours proposée en haut de la feuille, sans mode « Reprendre » à activer : Distribué, Anomalie, À repasser, Toute la rue. Puis les adresses à proximité (GPS) et les rues de la tournée (l'ancienne légende).
- **Fiche d'adresse** (toucher sur la carte, ou une ligne d'une liste) : page de la feuille, dans n'importe quel onglet.
- **Préparer** : la tournée active (charge estimée), puis des lignes qui ouvrent des pages : Tournées, Ordre de passage, Vérifications, Rues de la commune (éditeur de rue), Réglages de l'estimation. « Choisir sur la carte » réduit la feuille à une barre.
- **Contrôler** : anneau de progression et 4 cases, puis Par rue, Anomalies, Non traitées, Passages clôturés ; rapport (interrupteur « heures ») ; clôture. La sauvegarde n'est plus que dans le menu ⋯.
- Couleurs système d'Apple (bleu, vert, orange, rouge, assombris pour garder un contraste lisible sous un texte blanc). Police système (SF sur iPhone). Respect de « Réduire la transparence » et « Réduire les animations ».

Étapes :
- [x] **R1 — Coquille** ✅ (25/10/2026).
  - `#map` plein écran ; boutons ronds en verre : Annuler (haut gauche), capsule ⋯ / localiser / écran allumé (haut droite), « voir toute la tournée », zoom +/− seulement avec une souris (`hover: hover`). Échelle affichée pendant et juste après un changement de vue.
  - `js/sheet.js` (`Panel`) : feuille à 3 crans (`peek` = jusqu'à l'élément `[data-peek]` de la page, `medium` = 52 % de l'écran, `large` = sous la barre d'état).
    - La **hauteur** suit le doigt, pas une translation : le contenu qui défile a toujours la taille de la partie visible. Un élément focalisé ou ciblé se montre donc en faisant défiler la page, sans cran caché.
    - On tire par la poignée, l'en-tête, ou le contenu hors grand cran (`touch-action: none`). Au grand cran, le contenu défile ; tiré vers le bas tout en haut, il réduit la feuille (événements tactiles). Un geste vif passe au cran suivant ; le toucher qui suit un glisser est ignoré. La poignée fait aussi passer au cran suivant au clic.
    - Pile de pages par vue : `[data-push]` / `[data-back]` ; toucher l'onglet courant ramène à la page principale (et ferme la fiche d'adresse).
    - Chaque vue garde son cran (Distribuer : petit ; Préparer et Contrôler : moyen au premier affichage). Au grand cran, les boutons de la carte s'effacent (`visibility`).
    - Marges de la carte : `ui.updatePadding()` d'après `panel.covered()` (hauteur visée, plafonnée au cran moyen) ou `coveredLeft()` (grand écran).
  - `tabs.js` : capsule flottante, la vue de l'onglet s'affiche dans la feuille. Grand écran (≥ 900 px) : panneau latéral fixe de 400 px, capsule en bas du panneau.
- [x] **R2 — Contenus** ✅ (25/10/2026).
  - **Distribuer** : en-tête (nom de la tournée, « n/N adresses traitées »), prochaine adresse **toujours** proposée (plus de mode « Reprendre » ni de clé `guided`), puis « À proximité » (GPS) et « Rues de la tournée » (ancienne légende, avec recherche). Une action faite depuis la carte « prochaine » montre l'adresse suivante sur le plan ; au lancement d'une tournée commencée, le plan s'ouvre sur elle.
  - **Fiche d'adresse** (`#sheet`) : vue de la feuille au petit cran, par-dessus l'onglet courant, retrouvé à la fermeture. Les listes de Préparer et Contrôler l'ouvrent sans changer d'onglet (`common.showAddress`) ; « voir la rue » et les points à vérifier réduisent la feuille et restent dans l'onglet.
  - **Préparer** : tournée active (ligne « Changer » vers la page Tournées) et charge en deux tuiles, puis lignes à icône vers les pages Rues de la commune (→ éditeur de rue, une page), Ordre de passage, Vérifications, Réglages de l'estimation ; Renommer, Archiver. « Choisir sur la carte » ouvre la page `select` au petit cran.
  - **Contrôler** : anneau de progression (pourcentage au centre), « n / N adresses traitées », reste estimé, 4 tuiles (ouvrent Par rue, Non traitées, Anomalies), lignes vers Par rue, Anomalies, Non traitées, Passages clôturés ; Rapport (interrupteur « Inclure les heures », partager CSV / JSON) ; Clôturer en rouge. « Sauvegarder la progression » n'est plus que dans le menu ⋯, avec la mention RGPD.
- [x] **R3 — Dialogues** ✅ (25/10/2026). Alerte iOS 26 (boutons en capsule côte à côte ; action irréversible en rouge : `ui.confirm(msg, label, {destructive})`), feuille d'actions pour le motif (6 lignes, Annuler à part, focus initial sur Annuler), alerte avec champ pour les noms, menu déroulant ⋯, toasts et bandeau de mise à jour en capsule de verre en haut. Matériau plus opaque (`--glass-strong`) pour ce qui porte du texte sur la carte.
- [x] **R4 — Vérification** ✅ (25/10/2026).
  - Tests adaptés (outils `openPage`, `openLegend`, `setDetent`, tap centré dans la partie visible du plan) ; nouveaux : crans et pages, glisser au doigt, fiche par-dessus l'onglet, plan ouvert sur la prochaine adresse. Animations CSS coupées dans les tests (`reducedMotion: 'reduce'`).
  - Audit des cibles de 44 px et des boutons nommés dans toutes les pages de la feuille.
  - Captures iPhone 13 (WebKit) clair et sombre, et grand écran (Chromium).
  - Suite : 121 réussis, 3 ignorés (dont les deux tests de crans, sans objet sur grand écran), avec 5 workers. Avec 8 workers et la machine chargée, quelques démarrages WebKit dépassent le délai (§10).

### 2 quater. Itinéraire, guidage et repères (décidé le 25/10/2026)
Plan validé par l'utilisateur ; le détail est dans `~/.claude/plans/j-ai-besoin-de-toi-replicated-garden.md`.

Fonctions décidées :
- **itinéraire optimisé**, calculé sur l'appareil :
  - tissage (les deux côtés de la rue à la fois) ;
  - arrêts du véhicule (marche autour de l'arrêt) ;
  - véhicule voiture, vélo ou à pied ;
  - réglages par tournée ;
  - itinéraire entièrement personnalisable (retouches, liste d'arrêts à réordonner) ;
- **repères d'adresses** (liste fermée + note ≤ 60 caractères), avec une alerte pendant la tournée ;
- **Distribuer** : choix de la tournée et « Démarrer la tournée », guidage « comme Waze » (voix, carte orientée), simulation (pause, ×2, ×4, ×8).

Chaque écran s'intègre au style Liquid Glass actuel (§2 ter), avec les composants existants.

Choix de l'utilisateur :
- **réseau** : BD TOPO pour les routes, OSM pour les cheminements, téléchargés par le pipeline ;
- **départ et arrivée** : choisis sur le plan, approche par Plans ou Waze ;
- **tissage** : automatique selon la route, puis forcé rue par rue.

Pourquoi pas Dijkstra seul : il donne le plus court chemin entre deux points. L'ordre de visite des arrêts est un problème de voyageur de commerce asymétrique (sens uniques, côté de la route). Dijkstra calcule les temps entre arrêts, puis une heuristique choisit l'ordre (plus proche voisin, Or-opt, 2-opt, orientation des arrêts).

- [x] **I1 — Réseau routier** ✅ (25/10/2026).
  - **Téléchargement** : `pipeline/fetch_roads.py` (urllib) écrit dans `sources/` (jamais commité). Seule l'emprise est envoyée.
    - BD TOPO `troncon_de_route` : WFS de la Géoplateforme, par pages, en Lambert-93, cadre + 1,5 km.
    - OSM `way[highway]` : Overpass, cadre + 300 m.
  - **`pipeline/roads.py`**, appelé par `build.py` si les deux sources sont là (sinon le `roads.json` existant est conservé).
    - **Graphe** : extrémités fusionnées à 20 cm près.
      - Toute la BD TOPO jusqu'à 300 m du cadre, puis seulement les routes carrossables d'importance ≤ 4 jusqu'à 1,5 km.
      - Sans cette couronne, des sens uniques coupés par l'emprise isolaient le bord du Rhône.
    - **Attributs d'un tronçon** :
      - accès par mode : voiture 1, vélo 2, pied 4, voie privée 8. Les voies « restreintes aux ayants droit » restent carrossables, avec une pénalité dans l'app ;
      - sens (`sens_de_circulation`) ;
      - vitesse (`vitesse_moyenne_vl`, plafonnée à 70 km/h) ;
      - rue de la commune, par l'identifiant BAN de voie gauche/droite, qui est la clé `01275_0660` des ids d'adresse ;
      - nom pour les consignes ;
      - « pas de tissage d'office » : 2 chaussées, rond-point, bretelle, importance ≤ 2, chaussée ≥ 9 m, ou ≥ 3 voies ;
      - classe.
    - **OSM** ajoute seulement :
      - les cheminements à plus de 6 m de tout tronçon BD TOPO (sentiers, escaliers, passages), raccordés au tronçon le plus proche à moins de 8 m ;
      - les dessertes (`service`), souvent des impasses privées absentes de la BD TOPO, carrossables comme voies privées.
    - **Rattachement de chaque adresse** au tronçon de sa voie, à moins de 120 m. Le tronçon est cherché dans cet ordre :
      1. par l'identifiant BAN ;
      2. par le nom (abréviations BD TOPO « CHE », « IMP » développées, articles et « privée » ignorés) ;
      3. par un tronçon carrossable sans nom à moins de 40 m (impasse privée : il prend l'identifiant de la voie) ;
      4. sinon, par le tronçon carrossable le plus proche.
    - **Point de remise** : point de la limite de parcelle le plus proche de la projection de l'adresse sur la voie (la façade, pas le fond de la parcelle).
    - **Côté** : droite ou gauche dans le sens de saisie du tronçon. Sur une voie bordée par deux rues, le côté de la bonne rue l'emporte.
    - **Accès voiture** : une adresse sur un chemin non carrossable, ou hors de la composante principale en voiture, reçoit l'accès voiture le plus proche (≤ 400 m).
  - **Assertions** :
    - 941 adresses rattachées ;
    - au moins 88 % sur un tronçon de leur voie (le reste : impasses privées absentes des deux sources, desservies depuis la route d'accès) ;
    - `roads.json` ≤ 1,5 Mo.
  - **Chiffres réels** :

    | Mesure | Valeur |
    |---|---|
    | réseau | 2058 nœuds, 2400 tronçons, 184 km |
    | carrossables dans la composante principale | 1539 / 1687 |
    | rattachement | 723 par l'identifiant, 40 par le nom, 79 à une voie sans nom, 99 à une autre voie |
    | distance route - point de remise | médiane 4,3 m, max 94 m |
    | `roads.json` | 230 Ko |
  - `--preview` écrit aussi `work/roads-preview.png`.
  - **Mentions dans le menu ⋯** : BAN et cadastre (Etalab), IGN BD TOPO, © contributeurs OpenStreetMap (ODbL). `roads.json`, base dérivée d'OSM, est sous ODbL (dépôt public : conforme).
  - **Tests** : `tests/itineraire.spec.js` : cohérence du graphe, chaque adresse rattachée, accès voiture, pairs et impairs de part et d'autre de la Rue de la Gare, mentions du menu.
  - **Constat pour I2** : une partie de la Route de Genève est en **2 chaussées à sens unique**, et chaque côté se rattache à sa chaussée. Un arrêt tissé doit donc regrouper les points de remise par **distance de marche autour de l'arrêt**, pas par tronçon.
- [x] **I2 — Moteur** ✅ (25/10/2026). Sans DOM, exécuté dans un worker.
  - **`js/routing.js` (`RoadGraph`)** :
    - **Dijkstra sur les arcs orientés** : arc 2e de a vers b, 2e+1 de b vers a, tas binaire, coûts en secondes par mode ;
    - **voiture** : vitesse du tronçon, voies privées ×1,5, demi-tour 60 s (20 s en impasse), virage serré 6 s, interdit sur place ;
    - **vélo** : 15 km/h (×0,66 sur chemin, sentier ou desserte), demi-tour 8 s, demi-tour sur place 5 s ;
    - **pied** : 4,5 km/h (escalier ×0,5), sens uniques ignorés, demi-tour gratuit ;
    - `search` part d'une position {arc, s} et renvoie le coût d'entrée dans chaque arc ; `costTo` et `pathTo` donnent le coût et le chemin jusqu'à une position (à pied ou à vélo, une position est aussi atteignable dans l'autre sens) ;
    - `main(mode)` : composante connexe principale du mode ; une adresse rattachée à un îlot (parking, sentier isolé) prend le tronçon le plus proche de cette composante ;
    - géométrie : `pointAt`, `bearingAt`, `project` (côté +1 à droite, repère SVG), `nearest`, `arcPolyline`.
  - **`js/itinerary.js` (`computeRoute`)**.
    - **Réglages** : `settingsFor` complète les réglages enregistrés avec les valeurs par défaut du mode.

      | Mode | Marche max | Arrêt | Boîte | Traversée | Vitesse |
      |---|---|---|---|---|---|
      | voiture | 40 m | 20 s | 15 s | 10 s | marche 4,5 km/h |
      | vélo | 25 m | 8 s | 15 s | 10 s | 15 km/h |
      | à pied | — | — | 15 s | 10 s | 4,5 km/h |

      Les bornes sont dans `LIMITS`. Tissage `auto` / `always` / `never`, `weaveBy` {clé de voie : `weave` | `sides`}. Départ et arrivée : un point, ou `end: 'start'`. `seed` fixe le tirage aléatoire.
    - **Arrêts (voiture, vélo)** : glouton le long de chaque tronçon. L'arrêt se place 0,8 × marche max en avant de la première adresse libre. Il prend les points de remise à moins de la marche max (distance à vol d'oiseau), sur le même tronçon ou la même rue, ce qui couvre les 2 chaussées de la Route de Genève.
      - Si le tissage est refusé, l'arrêt ne sert que le côté de la première adresse, et il est recentré sur l'étendue de ses adresses.
      - Une adresse à long accès forme un arrêt à elle seule.
      - **Orientation** : sens permis par les sens uniques. Un arrêt d'un seul côté est parcouru avec ce côté à droite, si ce sens est permis.
      - **Service** : arrêt + boîtes + marche (2 × étendue + 2 × distance route-boîte) + traversées (changements de côté depuis le véhicule garé à droite, et le retour).
    - **Dépôt depuis le véhicule** (voiture, `fromVehicle`) : boîtes à 3 m de la route au plus, servies en roulant, par tronçon et par côté.
    - **À pied** : portions de rue. Les tronçons d'une même rue sont mis bout à bout (`streetChains`, coupés où la rue se ramifie, et au-delà de 200 m sans adresse). Une portion couvre les deux côtés si la rue est tissée, sinon un côté : on fait un côté de bout en bout, puis l'autre au retour.
    - **Ordre de visite** :
      - matrice des temps entre orientations (une recherche de Dijkstra par orientation) ;
      - unités injoignables écartées et signalées (`unreachable`) ;
      - départ : plus proche voisin, et ordre par rues (meilleure orientation par programmation dynamique) ;
      - recherche locale : orientation, 2-opt asymétrique (chaque unité inversée prend son orientation inverse), déplacement de 1 à 3 unités, à l'endroit ou inversées ;
      - perturbation « double pont » jusqu'au budget de temps (2 s par défaut), générateur mulberry32 à graine.
    - **Dans une unité** : ordre le long du sens de parcours. Tissée, les deux côtés alternent selon la position : Route de Genève, `60D 58D 59G 62D 59bisG 64D…`
    - **Sortie** :
      - arrêts : ids dans l'ordre, côtés, arcs et abscisses d'entrée et de sortie, chemin d'une portion, point, marche, service ;
      - trajets (arcs, s, m) ;
      - totaux : durée, trajets, service, km roulés, km marchés ;
      - `baseline` : même calcul dans l'ordre par rues ;
      - `missing`, `unreachable`.
  - **`js/route-worker.js`** (worker module) : charge `roads.json` et `addresses.json` une fois. **`js/route-client.js`** (`RouteClient`) : une demande à la fois, une nouvelle demande annule la précédente (worker relancé), avec la progression (`arrets`, `matrice`, `optimisation`).
  - **Mesures**, Node, budget de 2 s :

    | Mode | Tournée par défaut | Ordre par rues | Commune entière (budget 3 s) |
    |---|---|---|---|
    | voiture | 60 arrêts, ≈ 3 h 46 | 4 h 24 | 297 arrêts |
    | vélo | 81 arrêts, ≈ 3 h 18 | 4 h 26 | 401 arrêts |
    | à pied | 22 portions, ≈ 3 h 26 | 4 h 38 | 246 portions |
  - **À calibrer sur le terrain** : en voiture, la marche autour de chaque arrêt (aller-retour au véhicule) pèse lourd ; les réglages par défaut seront à ajuster avec l'utilisateur.
  - **Tests** (`tests/itineraire.spec.js`, WebKit et Chromium) :
    - sens unique : la voiture fait le tour, le piéton revient sur ses pas ;
    - tournée par défaut : chaque adresse une fois, marche max respectée, mieux que l'ordre par rues, trajets complets, même graine même résultat ;
    - Route de Genève : tissée, arrêts mêlant pairs et impairs ; non tissée, un seul côté, toujours à droite ; à pied, longues portions d'un seul côté ;
    - worker : annulation, progression, résultat.
- [x] **I3 — Préparer, page Itinéraire** ✅ (25/10/2026).
  - **Racine de Préparer** : la ligne « Ordre de passage » devient « Itinéraire » (valeur : durée, ou « à calculer »). L'ordre des rues devient une ligne de la page Itinéraire (`tests/helpers.js` : `openPage` passe par `#prep-route-row` pour `#prep-order-row`). Avec un itinéraire, les tuiles Distance et Durée en reprennent les totaux.
  - **Page Itinéraire** (`js/views/route.js`, `RouteView`), dans l'ordre :
    - avis « Itinéraire à revoir : n adresses ajoutées / retirées, réglages modifiés, réseau routier mis à jour » avec « Mettre à jour » ;
    - **résultat** : durée, distance roulée (à pied : distance), arrêts ou portions. Au petit cran, c'est l'élément `[data-peek]`, que `render` déplace ;
    - gain sur l'ordre des rues, marche autour des arrêts ;
    - lignes : Arrêts dans l'ordre, Voir sur le plan (petit cran, plan cadré), Optimiser davantage (10 s), Supprimer l'itinéraire ;
    - **réglages** : véhicule (contrôle segmenté), tissage (Auto / Toujours / Jamais), départ et arrivée (feuille d'actions : meilleur premier arrêt, ou au dernier arrêt, retour au départ, choisir sur le plan), réglages avancés ;
    - « Calculer / Recalculer l'itinéraire » (progression dans le worker), puis la ligne « Ordre des rues ».
  - **Choisir un point** : page `route-pick` au petit cran ; un toucher sur le plan (à tout zoom : `map.picking`, `ui.pointOverride`) place le départ ou l'arrivée. Le libellé est l'adresse la plus proche (« Près du 28 Rue de la Gare »).
  - **Réglages avancés** :
    - champs selon le mode (`data-modes`) : marche autour d'un arrêt, temps d'arrêt, temps par boîte, traverser la rue, vitesse de marche, vitesse à vélo ;
    - interrupteur « Dépôt depuis le véhicule » (voiture) ;
    - les valeurs sont propres à chaque mode (`settings.custom.car|bike|foot`) ; valeur hors bornes signalée puis abandonnée ; « Valeurs par défaut ».
  - **Tissage par rue** : éditeur de rue (Par défaut / Tissée / Côté par côté) et menu ⋯ d'un arrêt. Enregistré par clé de voie (`settings.weaveBy`).
  - **Liste des arrêts** (page `route-stops`) :
    - pastille numérotée, rue, résumé (« 125, 127, 129 à droite · 144 bis, 144 à gauche » ; portion : « côté droit : 58 → 90 (17) ») ;
    - Monter / Descendre (le focus reste sur le bouton) ;
    - ⋯ : feuille d'actions avec Voir sur le plan, Fusionner avec l'arrêt suivant (le véhicule reste au premier), Séparer en deux (la seconde moitié au droit de sa première adresse), tissage de la rue.
    - Une retouche réévalue trajets et totaux sur le fil principal (`evaluateStops`) et marque l'itinéraire « retouché » (`manual`).
  - **Composition modifiée** : itinéraire retouché, « Mettre à jour » range les adresses ajoutées dans l'arrêt le plus proche (à moins de la marche max), sinon dans un nouvel arrêt après lui, et retire les adresses enlevées (`updateComposition`), sans toucher aux retouches. Sinon, nouveau calcul. Recalculer un itinéraire retouché demande confirmation.
  - **Plan** : calques `l-route` (tracé bleu sur liseré, sous les étiquettes) et `l-route-stops` (pastilles numérotées de taille constante, départ « D » vert, arrivée « A »), affichés tant qu'une page de l'itinéraire est ouverte (`map.setRoute`).
  - **Modèle** : `tour.route = {settings, stops?, totals?, baseline?, roadsVersion?, computedAt?, manual?, settingsKey?}`.
    - Un arrêt garde ids, côtés, arcs et abscisses d'entrée et de sortie, chemin d'une portion, point, marche, service, et le temps et la distance du trajet qui y mène (`legSec`, `legM`).
    - Les trajets se recalculent à l'affichage : `js/roads.js` charge le réseau sur le fil principal à la demande.
    - Import : `io.validRoute`, champs connus seulement, tailles bornées ; un arrêt invalide fait ignorer l'itinéraire, mais les réglages sont gardés. Ce sont des champs facultatifs du format 2.
  - **Ordre de visite** : `ui.visitOrder()` (itinéraire, puis les adresses ajoutées depuis, dans l'ordre des rues) et `ui.visitGroups()`.
    - Distribuer : prochaine adresse, « Arrêt k/N ».
    - Contrôler : non traitées, anomalies ; « Reste ≈ » = arrêts encore à servir, trajet + part du service.
    - Rapport : ordre de visite.
  - **Feuille d'actions générique** `ui.actionSheet(titre, [{label, value, checked?, destructive?}], {message})` (dialogue `#action-sheet`), réutilisable pour les repères et le choix de tournée.
  - **Tests** (`tests/itineraire.spec.js`, WebKit et Chromium) :
    - calcul, tracé, retouches (descendre, fusionner, séparer), Distribuer suit l'itinéraire, composition modifiée puis mise à jour qui garde les retouches, relance ;
    - à pied, tissage « jamais », réglages avancés (mode, valeur refusée), départ touché sur le plan, retour au départ, Rue de la Gare tissée depuis l'éditeur ;
    - itinéraire importé validé champ par champ.

    Audit des cibles de 44 px étendu aux pages Itinéraire, Réglages, Arrêts et à la feuille d'actions.
- [x] **I4 — Repères** ✅ (25/10/2026).
  - **Liste fermée** `store.TAGS` : chien, boîte déplacée ou cachée, portail ou sonnette, accès difficile, remise en main propre fréquente, stationnement difficile, danger, autre.
  - **Note facultative** : 60 caractères au plus, nettoyée par `cleanNote` (une ligne, sans caractères de contrôle). Avertissement sous le champ : « Rien sur les personnes, aucun code d'accès. »
  - **Stockage par adresse**, pas par tournée : `meta.tags = {id: {c, note?, at}}`. `store.setTags` écrit d'abord ; rien de coché ni de noté supprime le repère ; `clearTags`.
  - **Sauvegarde** : `tags` dans l'export. À l'import, `io.validTags` garde seulement les codes de la liste, nettoie et borne la note ; une entrée vide est écartée. À la fusion, le repère le plus récent l'emporte, adresse par adresse. La confirmation compte les repères.
  - **Jamais dans le rapport.**
  - **Interface** :
    - **fiche d'adresse** : bouton étiquette en haut (rond, à côté de Fermer), ligne orange « Chien · Portail ou sonnette — boîte derrière le garage » ;
    - **saisie** : feuille `#tag-dialog`, avec les 8 repères en pastilles à cocher sur deux colonnes, le champ de note, Enregistrer et Supprimer. Entrée dans la note enregistre, et ne déclenche pas « Supprimer », premier bouton du formulaire (§10) ;
    - **plan** : pastille orange à côté du numéro (calque `l-tags`, un seul chemin, décalage constant à l'écran recalculé au zoom) ;
    - **Distribuer** : ligne orange sur la carte « prochaine adresse » ;
    - **Préparer › Repères** (`js/views/tags.js`) : toutes les adresses repérées avec leur date, un toucher modifie, mention RGPD, « Supprimer tous les repères ».
  - **Alerte** (`js/tag-alerts.js`, `TagAlerts`) : bandeau orange en verre en haut de l'écran, 8 s, avec Fermer.
    - Déclenchement : la prochaine adresse (ou l'arrêt courant, I5) devient une adresse repérée, mais pas au lancement de l'app ; ou la position GPS passe à moins de 50 m d'une adresse repérée de la tournée non traitée (précision ≤ 30 m).
    - Une même adresse n'est pas réannoncée avant 15 min.
    - `onAlert(fn)` : la voix s'y abonnera (I6).
  - **Tests** (`tests/reperes.spec.js`) :
    - saisie depuis la fiche, affichage (fiche, plan, page), modification depuis la liste, note bornée, Entrée, relance, suppression ;
    - alerte sur la prochaine adresse, « Tout supprimer » ;
    - alerte de proximité GPS, une seule fois ;
    - export avec les repères, rapport CSV sans repère, import sur un autre appareil avec repères piégés nettoyés.

    Audit des cibles de 44 px étendu à la fenêtre de saisie et à la page Repères.
- [x] **I5 — Navigation** ✅ (25/10/2026). Nord en haut ; la voix et la carte orientée viendront en I6.
  - **En-tête de Distribuer** :
    - le nom de la tournée est un bouton (chevron) qui ouvre la feuille d'actions des tournées en cours ;
    - **« Démarrer »** (capsule bleue) à droite.
    - Sans itinéraire, une feuille d'actions propose « Calculer l'itinéraire » (Préparer › Itinéraire, calcul lancé) ou « Démarrer sans itinéraire » (écran allumé, suivi GPS, prochaine adresse comme avant).
  - **Mode navigation** (`js/views/navigate.js`, `NavigateView`, `#app[data-mode="nav"]`) :
    - **sans capsule d'onglets** ;
    - **bandeau de consigne** `#nav-banner` en verre en haut, entre Annuler et les boutons de droite : flèche, distance, consigne ;
    - **feuille de l'arrêt en cours** (`#view-navigate`) : « Arrêt k/N », rue, distance, durée restante ; numéros avec leur côté, repère, statut ; Distribué (rond vert) et ⋯ par adresse (Anomalie, À repasser, Remettre à faire, fiche) ; « Arrêt suivant » et « Tout l'arrêt distribué » ; les 3 arrêts suivants ; Terminer, confirmé s'il reste des adresses.
    - **Arrêt suivant automatique** quand tout l'arrêt est traité (après 400 ms) ; les arrêts sautés reviennent à la fin ; fin de tournée annoncée.
    - Protection de 500 ms contre le double toucher ; Annuler reste disponible ; les adresses retirées depuis le calcul sont ignorées.
  - **Guidage** (`js/guidance.js`, sans DOM) :
    - `buildLeg` : polyligne d'un trajet et consignes aux nœuds selon l'angle entre caps : tout droit si la rue change, légèrement / à droite / à gauche, franchement, demi-tour ;
    - **ronds-points** en une seule consigne avec le numéro de sortie (sorties = nœuds intérieurs ayant une autre route praticable) ;
    - `locate` : abscisse et écart, cherchés près de l'abscisse précédente ; `nextManeuver` ; `instruction` (français) ; `formatDist` ;
    - `reroute` : depuis la position, sens de départ choisi d'après le cap de marche.
  - **Position** : GPS, ou position simulée (`gps.simulate`).
    - Le plan suit la position, même si le GPS a coupé son propre suivi ; un glisser à la main le suspend, et « Localiser » le reprend.
    - Le trajet jusqu'à l'arrêt est calculé depuis la position s'il n'y en a pas (premier arrêt sans point de départ, arrêt sauté).
    - **Arrivée** à moins de 30 m (vélo 25 m, à pied 20 m) : le bandeau affiche « Arrêt k » et les numéros à droite / à gauche.
    - **Hors itinéraire** : écart de plus de 30 m (vélo 25 m, à pied 20 m), précision ≤ 25 m, pendant 5 s (`nav.offRouteMs`). Nouveau trajet, toast « Itinéraire recalculé ».
  - **Plan** : trajet jusqu'à l'arrêt en gras (`setRoute({ahead})`), suite de l'itinéraire, arrêts restants numérotés, arrêt en cours en orange. L'aperçu de Préparer s'efface pendant la navigation.
  - **Repères** : annoncés quand leur arrêt devient l'arrêt en cours (`TagAlerts`).
  - **Rejoindre le premier arrêt** : si la position est inconnue ou à plus de 300 m, liens Plans (`maps.apple.com/?daddr=…`) et Waze (`waze.com/ul?ll=…&navigate=yes`). Seules les coordonnées de l'arrêt partent, et seulement sur toucher (plan → GPS par inversion de l'affine).
  - **Grand écran** : bandeau à droite du panneau latéral.
  - **Tests** (`tests/guidage.spec.js`, WebKit et Chromium) :
    - démarrage, liens Plans / Waze, consigne avec distance, arrivée, distribution de l'arrêt puis arrêt suivant, Annuler, Arrêt suivant, Terminer ;
    - hors itinéraire ;
    - choix de la tournée et démarrage sans itinéraire (calcul proposé, puis navigation) ;
    - repère annoncé à l'arrêt.

    Audit des cibles de 44 px étendu à la vue de navigation.
- [x] **I5 bis — Simulation, quitter et reprendre** ✅ (25/10/2026).
  - **Distribuer** : une ligne de boutons sous le titre, « Démarrer » (ou « Reprendre · arrêt k ») et « Simuler » (visible si un itinéraire est calculé). Le titre de la tournée n'est plus tronqué. « Simuler la tournée » aussi dans Préparer › Itinéraire.
  - **Quitter** (bouton de la feuille de navigation, feuille d'actions) :
    - **Mettre en pause** : l'arrêt en cours est mémorisé (`localStorage['neyron-tournees.nav'] = {tour, k, at}`, écrit à chaque arrêt). « Reprendre · arrêt k » ramène à cet arrêt, même après une relance ou une fermeture de l'app ; si l'arrêt est fini, on passe au suivant ouvert.
    - **Terminer la tournée** : la reprise est effacée (c'est aussi le cas quand tout est traité).
    - La progression est conservée dans les deux cas. Une app fermée en pleine navigation propose aussi « Reprendre ».
  - **Simulation** (`js/simulator.js`, `Simulator`) : même vue que la navigation (bandeau, arrêt, tracé, alertes des repères).
    - La position avance seule le long du trajet (`gps.simulate`) : voiture 30 km/h, vélo à la vitesse des réglages, à pied à la vitesse de marche.
    - À chaque arrêt, elle reste le temps de service prévu, puis sert l'arrêt.
    - **Capsule de commandes** en verre sous le bandeau : arrêt précédent, lecture / pause, arrêt suivant, vitesse ×1 / ×2 / ×4 / ×8, quitter. Le titre de la feuille indique « Simulation · Arrêt k/N ».
    - **Rien n'est enregistré** : statuts simulés en mémoire (`nav.status`, `nav.simState`) et montrés sur le plan (`map.applyStatuses`). Le plan revient aux statuts réels en quittant. Pas d'Annuler, pas de reprise mémorisée, GPS remis comme avant.
  - Petit cran plafonné à 68 % de l'écran (au lieu de 62 %), pour la ligne de boutons de Distribuer sur les petits écrans.
  - **Tests** (`tests/guidage.spec.js`) :
    - pause, relance de l'app, reprise à l'arrêt mémorisé, Terminer qui efface la reprise ;
    - simulation : vitesses, défilement seul, pause (position figée), arrêts suivant et précédent, journal vide, plan rendu aux statuts réels.

    Audit des cibles étendu à « Quitter la tournée » et à la capsule de simulation.
- [x] **I6 — Voix et carte orientée** ✅ (25/10/2026).
  - **Voix** (`js/voice.js`, `Voice`) :
    - `speechSynthesis` en `fr-FR` (voix locale de préférence, sans réseau) ;
    - débloquée par le toucher sur Démarrer ou Simuler : première annonce « Tournée démarrée. Arrêt 1, rue » ;
    - **virages** annoncés à l'approche, une seule fois par seuil : voiture 300, 100 et 25 m ; vélo 150, 40 et 15 m ; à pied 40 et 10 m. « Dans 100 m, tournez à droite sur … » ; au dernier seuil, la consigne seule. Une annonce remplace la précédente (`interrupt`) ; les seuils déjà dépassés ne sont pas annoncés en retard ;
    - **arrivée** : « Arrêt 3. 125, 127, 129 à droite, puis 144 bis, 144 à gauche. » ;
    - **repères** pendant la navigation : « Attention, 12 Rue de la Gare : Chien » (`TagAlerts.onAlert`) ;
    - bouton haut-parleur dans la feuille de navigation (sourdine), préférence d'appareil `neyron-tournees.voice` ; journal des 50 dernières annonces (`voice.spoken`, tests).
  - **Carte orientée** (`map.setRotation`) : un groupe racine `g.root` tourne autour du centre de la vue (`rotate(θ cx cy)`).
    - Conversions écran <-> plan (`_s2w`, `_w2s`) utilisées par `toWorld`, `toScreen`, le glisser, le pincement, la molette, `zoomAt`, `fitBounds`, `centerOn` et `ensureVisible` ; un toucher sur un numéro reste juste.
    - Numéros, pastilles d'arrêt et noms de rues redressés, ces derniers toujours lisibles de gauche à droite (`_uprightTexts`, au-delà de 3° d'écart, 1,7 ms) ; pastilles de repère décalées à l'écran.
    - En navigation, le trajet à venir (20 m devant la position sur le trajet, sinon le cap de marche) pointe vers le haut, mis à jour au-delà de 8° d'écart.
    - **Boussole** (bouton rond sous la colonne de droite, aiguille rouge qui tourne avec le plan) : nord en haut ou carte orientée, préférence `neyron-tournees.headup`. Nord en haut et boussole masquée à la fin de la navigation.
    - **Coût** : sous WebKit Windows (rendu logiciel), une image avec le plan tourné coûte autant qu'une image nord en haut. À confirmer sur l'iPhone.
  - En navigation, la marge haute de la carte passe sous le bandeau de consigne (et la capsule de simulation) : la position reste visible (`ui.updatePadding`).
  - **Tests** (`tests/guidage.spec.js`) :
    - voix : démarrage, virage annoncé une fois à l'approche, arrivée, repère, sourdine ;
    - carte orientée : trajet vers le haut, numéros redressés, toucher juste avec le plan tourné, boussole, nord à la fin.
- [ ] **I7 — Robustesse** : tests de guidage et de repères, performance sur la commune entière, hors ligne, RGPD (§13), documentation.

---

## 3. Définition de « terminé » pour la v0.1
- `python pipeline/build.py` régénère `docs/data/` sans erreur.
- `python -m http.server -d docs 8000`, puis http://localhost:8000 : tout fonctionne dans un navigateur de bureau.
- Les tests Playwright WebKit (profil iPhone) passent.
- Sur iPhone, depuis l'URL GitHub Pages :
  - installation sur l'écran d'accueil ;
  - relance en mode avion ;
  - pointage d'un numéro et de toute une rue ;
  - fermeture puis relance de l'app : la progression est toujours là ;
  - position GPS visible avec sa précision.

---

## 4. Données sources

Sous Licence Ouverte Etalab 2.0. Le pipeline accepte la version département **ou** commune. Fournies le 19/10/2026 (version département) :

| Contenu | Nom département (fourni) | Nom commune (accepté) |
|---|---|---|
| Adresses BAN, CSV `;` | `adresses-01.csv.gz` (9 Mo) | `adresses-01275.csv(.gz)` ou CSV déjà filtré |
| Bâtiments, GeoJSON | `cadastre-01-batiments.json.gz` (34 Mo) | `cadastre-01275-batiments.json.gz` |
| Parcelles, GeoJSON | `cadastre-01-parcelles.json.gz` (181 Mo, 815 Mo décompressé) | `cadastre-01275-parcelles.json.gz` |

Réseau routier (branche facteur, itinéraire), téléchargé par `pipeline/fetch_roads.py` dans `sources/` :
- `roads-bdtopo-01275.geojson` : BD TOPO `troncon_de_route`, IGN, Licence Ouverte ; environ 11 Mo, 3650 tronçons ;
- `roads-osm-01275.json` : OSM `way[highway]`, ODbL ; environ 0,7 Mo.

Les noms peuvent varier (`_csv.gz`, `_json.gz`) : détecter par motif. **Ne jamais lire ces fichiers en entier.** Si un fichier d'un autre type est fourni (PDF, shapefile…), demander à l'utilisateur quoi en faire.

### Format et filtrage
- Cadastre : **une feature par ligne** ; la ligne 1 est l'en-tête `{"type":"FeatureCollection","features":[`. Lire une ligne : `json.loads(line.strip().rstrip(','))`, après un test de sous-chaîne `'"commune":"01275"'`. Géométries en WGS84.
- Contrôle rapide en Git Bash (référence) :
  ```bash
  zcat sources/adresses-01*.gz | awk -F';' '$7=="01275"' | wc -l                  # 959
  zcat sources/cadastre-01*-batiments*.gz | grep -c '"commune":"01275"'           # 2151
  zcat sources/cadastre-01*-parcelles*.gz | grep -c '"commune":"01275"'           # 2786
  ```

### Colonnes BAN
`id;id_fantoir;numero;rep;nom_voie;code_postal;code_insee;nom_commune;code_insee_ancienne_commune;nom_ancienne_commune;x;y;lon;lat;type_position;alias;nom_ld;libelle_acheminement;nom_afnor;source_position;source_nom_voie;certification_commune;cad_parcelles`
- **`id`** = clé d'interopérabilité et **identifiant stable de l'adresse dans toute l'app** (clé de progression). Le suffixe `rep` en fait partie : `01275_0420_00028`, `01275_0620_00006_b`, `01275_0420_00022_bis`.
- `x`, `y` en Lambert-93 (EPSG:2154, mètres) ; `lon`, `lat` en WGS84.
- `nom_ld` = lieu-dit ; `cad_parcelles` = parcelle(s) séparées par `|` (ex. `01275000AI0458`).

### Constats vérifiés (19/10/2026)
- 959 adresses à Neyron ; 2151 bâtiments ; 2786 parcelles.
- `rep` dans la commune : `bis` (88), `ter` (22), lettres **`a` à `n`** (logements de l'Impasse Privée des Capucins). Dans la tournée : `""`, `a`, `b`, `c`, `d`, `bis`, `ter`.
- `type_position` : 942 `entrée`, le reste (`logement`, `cage d'escalier`, `bâtiment`) est **hors tournée**.
- **Une adresse de la tournée (un `bis`) a un `cad_parcelles` vide** → repli obligatoire (§7.2, étape 4).
- Les parcelles ont un `id` (`010020000A0225`) ; **les bâtiments n'en ont pas** → générer `b0…bN` (ids non stables d'un millésime à l'autre, sans importance : seule la progression doit être stable et elle repose sur l'`id` d'adresse).

---

## 5. Voies retenues

L'index sert d'identifiant de rue et de couleur (clair / sombre).

| Index | Nom officiel BAN | Numéros | Couleurs |
|---|---|---|---|
| 0 | Montée Neuve | 58 | #1d5fd1 / #6ea2ff |
| 1 | Chemin sous les Saules | 18 | #1f8a4c / #5fcf8c |
| 2 | Rue de la Gare | 15 | #c22f25 / #ff7a6e |
| 3 | Avenue des Trois Glorieuses | 5 | #d0560a / #ff9d55 |
| 4 | Impasse des Pêcheurs | 5 | #0b8796 / #4fd3e0 |
| 5 | Chemin du Molliet | 4 | #9a6f00 / #e2b84a |
| 6 | Impasse Privée B | 7 | #c2287c / #ff79bf |
| 7 | Chemin du Barry | 3 | #7a3fb0 / #bf8cf0 |
| 8 | Route de Genève, **n° 58 à 193, pairs et impairs** | 105 | #283a52 / #c9d6e8 |
| 9 | Montée des Écoles | 9 | #5f7d0e / #a9cc4a |

**229 numéros à pointer** (comptes vérifiés dans la BAN le 19/10/2026).

> **Branche facteur (L2)** : l'app couvre **toute la commune** (941 adresses, 90 voies, ordre alphabétique, couleurs par voisinage). Ces 10 voies forment la tournée prédéfinie `default` (`config.PRESETS`, mêmes comptes vérifiés). Le tableau ci-dessus décrit la v0.1 (`main`).

- « Impasse de la Gare » n'existe pas dans la BAN ; ses maisons sont probablement numérotées sur la Rue de la Gare.
- **Route de Genève** : 138 numéros dans la BAN, numérotation croissante d'est en ouest (n° 3 → 193). Seul le tronçon **58 → 193, côtés pair et impair**, est dans la tournée (confirmé, §14). Les n° < 58 qui tombent dans le cadre sont affichés **en gris**, comme repères, **non pointables** (`ctx: true`).
- Le n° 73 bis de la Route de Genève est à ~250 m au nord de la route, au bout d'un accès privé : normal.
- Ajouter une rue : `pipeline/config.py` (`STREETS`, `COLORS`, `EXPECTED_COUNTS`), relancer le pipeline. Les couleurs sont lues depuis les données : **ne pas les dupliquer dans le CSS**. Toujours sur 6 chiffres.

---

## 6. Structure du dépôt

```
neyron-tournees/
├── CLAUDE.md
├── CLAUDE_base.md        # spec d'origine (archive)
├── .gitignore
├── .gitattributes        # eol=lf (hash de version stable sous Windows)
├── package.json          # devDependencies : @playwright/test (rien à l'exécution)
├── playwright.config.js
├── sources/              # BAN + cadastre (jamais commités, jamais lus en entier)
├── work/                 # intermédiaires du pipeline (ignoré)
├── pipeline/
│   ├── requirements.txt
│   ├── config.py         # STREETS, COLORS, EXPECTED_COUNTS, filtres, marges, seuils
│   ├── geo.py            # extraction, projection, emprise, association, tracés
│   ├── build.py          # point d'entrée : docs/data/*, version, stamp de sw.js (--stamp)
│   ├── fetch_roads.py    # branche facteur : télécharge le réseau routier (BD TOPO, OSM) dans sources/
│   ├── roads.py          # branche facteur : graphe routier et rattachement des adresses -> data/roads.json
│   └── icons.py          # icônes PNG avec Pillow
├── docs/                 # LE SITE servi par GitHub Pages (pas de la documentation)
│   ├── .nojekyll
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── sw.js
│   ├── css/app.css
│   ├── js/               # main.js, map.js, store.js, gps.js, ui.js, wakelock.js, io.js, debug.js, pwa.js, theme-init.js,
│   │                     #   tabs.js, sheet.js, tourplan.js, report.js, views/ (prepare.js, distribute.js, control.js, common.js) — branche facteur
│   │                     #   routing.js, itinerary.js, route-worker.js, route-client.js, roads.js, views/route.js — itinéraire (§2 quater)
│   │                     #   tag-alerts.js, views/tags.js — repères d'adresse ; guidance.js, views/navigate.js, simulator.js, voice.js — navigation
│   ├── icons/
│   └── data/             # GÉNÉRÉ, commité : plan.json, addresses.json, roads.json, version.json (ne pas lire)
└── tests/                # Playwright : *.spec.js (plan, pointage, gps, wakelock, sauvegarde, debug, hors-ligne ;
                          #   branche facteur : navigation, tournees, preparer, distribuer, controler, robustesse),
                          #   helpers.js (outils communs), serve.py (serveur statique des tests)
```

---

## 7. Pipeline Python

### 7.1 Extraction, projection et emprise
- Lecture des `.gz` avec `gzip.open(…, 'rt', encoding='utf-8')` ligne par ligne ; filtre 01275 ; résultat mis en cache dans `work/neyron.csv`, `work/bat.jsonl`, `work/par.jsonl`.
- Projection Lambert-93 :
  ```python
  T = Transformer.from_crs(4326, 2154, always_xy=True)
  shapely.transform(g, lambda c: np.column_stack(T.transform(c[:,0], c[:,1])))
  ```
- Emprise : bbox des adresses de la tournée (sans la Route de Genève < 58) + marge 110 m, soit ~1570 × 1678 m.
- On garde parcelles et bâtiments intersectant l'emprise élargie de 150 m (~1870 parcelles, ~1500 bâtiments).

### 7.2 Associer une adresse à un bâtiment
1. Prendre la ou les parcelles de l'adresse (`cad_parcelles`).
2. Garder les bâtiments dont > 40 % de la surface est dans ces parcelles (STRtree).
3. Retenir le plus proche du point d'adresse.
4. À défaut (y compris `cad_parcelles` vide) : le bâtiment le plus proche à moins de 6 m, cherché dans un rayon de 25 m.

À distance comparable, le **bâti dur** (`type: "01"`) l'emporte sur le bâti léger (`"02"` : abris, garages) : un bâti dur jusqu'à 3 m plus loin reste préféré. Le numéro est affiché **au point BAN**, pas au centroïde du bâtiment. Résultats réels en §7.7.

### 7.3 Données pour la PWA
- **Identifiant** : l'`id` BAN.
- **Tri naturel** : numéro, puis `rep` : `""` < `bis` < `ter` < `quater` < lettres `a`…`z` (ordre alphabétique).
- **Côté** : `side` = `"pair"` ou `"impair"` selon la parité du numéro.
- **Transformation GPS → Lambert-93** : moindres carrés sur les **959 adresses** (`x = a·lon + b·lat + c`, `y = d·lon + e·lat + f`). 6 coefficients + résidu max dans `addresses.json`. Résidu attendu ~ décimètre ; **échec du build au-delà de 0,5 m**. Évite d'embarquer proj4js.
- **Coordonnées SVG** : `sx = x - x0`, `sy = y1 - y` (1 unité = 1 m, nord en haut).
- **Contrôles** : comptes par rue = `EXPECTED_COUNTS` (58, 18, 15, 5, 5, 4, 7, 3, 105, 9), sinon échec avec le détail de l'écart.

### 7.4 Tracés des rues
Pas de filaire de voirie : tracé approché par le domaine non cadastré. Les parcelles des communes voisines ne sont pas chargées : le domaine est limité à la commune par une **fermeture morphologique** (union des parcelles `buffer(15).buffer(-15)`), sinon l'extérieur de la commune passerait pour de la voirie.
```python
gaps = (fermeture(parcelles) & emprise).difference(unary_union([p.buffer(0.3) for p in parcelles]))
# pour chaque rue :
mst  = minimum_spanning_tree(cdist(pts, pts))                 # arbre couvrant des points d'adresse
corr = MultiLineString(aretes_mst).buffer(28) | unary_union([Point(p).buffer(30) for p in pts])
trace = gaps & corr   # garder les morceaux > 40 m² à moins de 22 m d'une adresse
if trace.area < 150: trace = trace | MultiLineString(aretes_mst).buffer(3)   # voies privées cadastrées
trace = trace.simplify(0.5)
```
Repli si une rue pose problème : mettre son index dans `TRACE_FALLBACK_STREETS` → `MultiLineString(aretes_mst).buffer(4)`. Limites connues : aux carrefours, le tracé peut déborder de quelques mètres sur la rue voisine ; sur la Route de Genève entre le 176 et le 190, où le non-cadastré est large, le tracé s'évase (largeur du couloir, 56 m).

**Étiquettes** : le plus long chemin de l'arbre couvrant sert d'axe ; une étiquette tous les ~450 m, sauf sur les 12 % extrêmes des rues longues (accès privés) ; orientation locale sur ±40 m, ramenée dans (-90°, 90°] ; point recalé sur le tracé s'il en est à moins de 40 m.

### 7.5 Sorties, version et stamp
- Géométries en paths SVG (`M x yL x y x y…Z`), coordonnées arrondies au décimètre, **négatives possibles** (géométries jusqu'à 150 m hors du cadre). Bâtiments **sans** adresse de la tournée fusionnés en un seul path. Les remplir avec `fill-rule="evenodd"` (cours intérieures).
- Identifiants de bâtiment `b<index>` : stables d'un build à l'autre tant que les sources ne changent pas.
- **Version des données** : hash court du contenu (calculé avant d'y insérer le champ `version`), écrit dans `addresses.json` et `version.json`.
- **Version de l'app** (`--stamp`, aussi exécuté en fin de build complet) : hash court (8 caractères) de tous les fichiers de `docs/`, CRLF normalisés en LF, `sw.js` compris **hors bloc généré**, sauf `version.json` et `.nojekyll`. Le précache liste `./` puis tous les fichiers de `docs/` sauf `sw.js` et `.nojekyll`. Réécrit dans `docs/sw.js`, entre marqueurs, de façon idempotente (le bloc doit exister dans `sw.js`, sinon le stamp le signale et ne l'écrit pas) :
  ```js
  // @build:start
  const VERSION = 'a1b2c3d';
  const PRECACHE = ['./', './index.html', './css/app.css', './js/main.js', …, './data/plan.json'];
  // @build:end
  ```
  Sans ce stamp, un changement de code ne modifie pas `sw.js` : le navigateur ne voit pas de mise à jour et l'iPhone garde l'ancienne app. `--check` refait le calcul sans rien écrire et échoue si `sw.js` ou `version.json` est périmé (appelé par les tests Playwright).
- `version.json` : `{ "app": "…", "data": "…", "builtAt": "…" }` ; `builtAt` n'est mis à jour que si une version change (pas de diff git inutile).

### 7.6 Schéma des données (`docs/data/`)
```jsonc
// addresses.json
{
  "version": "a1b2c3d",
  "frame": { "x0": 0, "y1": 0, "W": 1570, "H": 1678 },     // Lambert-93, mètres
  "affine": { "x": [a, b, c], "y": [d, e, f], "maxResidual_m": 0.08 },
  "streets": [ { "i": 0, "name": "Montée Neuve", "colors": ["#1d5fd1", "#6ea2ff"], "count": 58,
                 "len": 812,                                                // branche facteur : longueur (m)
                 "labels": [ { "x": 895.4, "y": 806.1, "a": -81 } ] } ],   // a : angle en degrés, SVG
  "presets": [ { "id": "default", "name": "Neyron — 10 rues", "ids": ["01275_…", …] } ],  // branche facteur
  "unaddressed": [ { "x": 812.4, "y": 1530.2, "a": 148 } ],  // branche facteur : bâtiments sans adresse (a : m²)
  // addresses triées par rue, numéro, rep ; "bat" vaut null si aucun bâtiment n'est associé
  "addresses": [
    { "id": "01275_xxxx_00012", "s": 2, "n": 12, "rep": "", "side": "pair",
      "x": 123.4, "y": 456.7,              // coordonnées SVG (déjà relatives au cadre)
      "ld": "Sur l'Île", "cad": "01275000AI0458", "bat": "b42", "ctx": false }
  ]
}
// roads.json (branche facteur) : coordonnées SVG du cadre, comme addresses.json
{ "version": "…", "attribution": "…", "fetched": {"bdtopo": "…", "osm": "…"},
  "classes": ["route", "rond-point", …], "names": ["Route de Genève", …],
  "nodes": [x0, y0, x1, y1, …],
  // tronçon : nœuds a et b ; longueur (m) ; accès (1 voiture, 2 vélo, 4 pied, 8 voie privée) ;
  // sens (1 : a -> b, -1 : b -> a, 0 : double) ; km/h voiture ; rue de la commune (-1 sinon) ; nom (-1 sinon) ;
  // pas de tissage d'office ; classe ; points intermédiaires
  "edges": [[a, b, len, m, ow, v, s, name, nw, cls, [x, y, …]], …],
  // adresse : tronçon ; abscisse depuis a (m) ; côté (+1 droite, -1 gauche dans le sens a -> b) ;
  // distance route - point de remise (m) ; point de remise ; puis, si le tronçon n'est pas carrossable :
  // tronçon, abscisse et distance de l'accès voiture
  "snap": { "01275_0420_00028": [ei, t, sd, off, px, py], … } }
// plan.json
{ "parcels": "M…", "buildingsOther": "M…",
  "buildings": { "b42": "M…" },          // bâtiments liés à une adresse
  "traces": { "0": "M…", "1": "M…" } }   // par index de rue
```

### 7.7 Chiffres réels du build (19/10/2026, version des données `442a0fd1`)
- Résidu affine max **0,146 m** (moyen 0,025 m) ; écart BAN x/y vs pyproj 0,007 m.
- Cadre **1570 × 1679 m** (x0 = 848841, y1 = 6526485).
- **240 adresses** : 229 pointables + **11 de contexte** (Route de Genève < 58 dans le cadre). L'ancien projet annonçait ~262 : il comptait sans doute les 33 numéros < 58, même hors du cadre ; on garde la règle « dans le cadre ».
- Géométries gardées : 2210 parcelles, 1844 bâtiments (l'ancien projet annonçait ~1870 / ~1500, cadre probablement différent). Les parcelles de Neyron couvrent 72 % du cadre ; le reste est hors commune (vide sur le plan).
- **232 adresses liées à un bâtiment** (226 par la parcelle, 6 par proximité). 8 pointables sans bâtiment : 7 et 114 Montée Neuve, 59 bis, 61 et 152 Route de Genève, 6 b Chemin du Molliet, 2 Chemin sous les Saules, 13 Chemin du Barry (le numéro reste affiché et pointable).
- Domaine non cadastré : 13,4 ha ; toutes les rues en mode « domaine ».
- Sorties : `addresses.json` 38 Ko, `plan.json` 495 Ko (servis compressés par Pages).

---

## 8. Application (PWA)

> **Branche facteur** : l'interface autour du plan (feuille à crans, onglets, boutons en verre, fiche d'adresse, dialogues) est décrite en §2 ter ; ce qui suit vaut pour le plan lui-même. La légende y est devenue la section « Rues de la tournée » de Distribuer, l'encart GPS la section « À proximité ».

### 8.1 Rendu du plan (`map.js`, `ui.js`)
- SVG inline en mètres ; zoom et déplacement via le `viewBox`.
- Couches, de bas en haut :
  1. parcelles (trait fin gris) ;
  2. tracés de rues (couleur de la rue à 28 %) ;
  3. bâtiments (gris clair ; ceux d'une adresse de la tournée : couleur de la rue à 35 %, ou couleur du statut) ;
  4. noms de rues ;
  5. numéros (contexte `ctx` en gris, non cliquables) ;
  6. calque GPS (cercle de précision, point).
- À chaque changement de zoom : `fontSize = clamp(13/k, 2.2, 14)` (`k` = pixels par mètre), idem pour les halos (`paint-order: stroke`). Les traits utilisent `vector-effect: non-scaling-stroke`.
- Barre d'échelle dynamique.
- **Tap** : numéro pointable le plus proche à 22 px max (calcul en coordonnées écran, pas de cible par élément).
- **Légende** : case de couleur = afficher/masquer la rue ; nom = sélectionner (surbrillance, reste atténué, zoom avec un cadre ≥ 220 m qui ne passe pas sous la légende) ; progression + « Toute la rue faite ». Repliable, repliée par défaut sur mobile.
- Cibles tactiles ≥ 44 px pour tous les boutons.
- **Niveaux de zoom** (`k` en px/m, constantes en tête de `map.js`) : sous `K_NUMBERS = 0.9`, des points de taille constante remplacent les numéros (vue d'avancement) et un tap rapproche (×2,5) au lieu de pointer ; sous `K_LABELS = 0.4`, pas d'étiquettes ; `K_MAX = 40`. Double tap sur une zone vide : zoom ×2. Appui long (600 ms) : événement `longpress` (position simulée du debug, phase 7).
- Points de taille constante : trait de longueur nulle (`M x yh0.01`) à bout rond en `non-scaling-stroke`, sans recalcul au zoom.
- **API de `MapView`** pour les phases suivantes : événements `tap` ({address|null, world}), `longpress`, `userpan` (coupe le mode suivre), `view`, `ready` ; `selectAddress(id)`, `selectStreet(i)`, `setStreetVisible(i, bool)`, `fitBounds()`, `ensureVisible()`, `setPadding()`, `toScreen()` / `toWorld()`, calque `lGps`, `addrEls` / `buildingEls` (classes de statut `st-fait`, `st-a_repasser` déjà stylées). `window.neyronApp = {map, ui, data}` pour le debug et les tests.
- Thème : préférence par appareil dans `localStorage['neyron-tournees.theme']` (clé préfixée), appliquée avant affichage par `theme-init.js` (script classique externe : CSP sans inline).
- **Rendu des statuts — distinct par la forme**, car le vert « fait » est proche de la couleur du Chemin sous les Saules et l'orange « à repasser » de celle de l'Avenue des Trois Glorieuses :
  - à faire : numéro gras couleur de la rue, halo fond de carte ;
  - fait : numéro vert **estompé** (opacité 0,45), bâtiment revenu au gris avec liseré vert, point petit et pâle ;
  - à repasser : numéro en **pastille** (texte clair sur halo orange épais), bâtiment orange, gros point orange.
  Les halos sont en `em` dans le CSS (suivent la taille de police posée par JS) ; vérifié sous WebKit.

### 8.2 Stockage (`store.js`)
- IndexedDB, base **`neyron-tournees`**, trois stores :
  - `events` : `{dev, seq, t, tour, ids[], st, grp, undoOf?}`, clé `[dev, seq]`, `st` ∈ `"fait" | "a_repasser" | "a_faire"` (branche facteur : plus `"anomalie"` avec `why`, motif codé, §2 bis L5) ;
  - `tours` : `{id, name, createdAt, archived}` (branche facteur : plus `updatedAt`, `ids[]`, `order[]`, `reverse[]`, `closures[]`, §2 bis) ;
  - `meta` : `deviceId`, compteur `seq`, version des données, préférences.
- **L'état courant est dérivé du journal** : pour chaque `id`, le dernier événement de la tournée active l'emporte, ordre `(t, dev, seq)` (départage déterministe entre appareils).
- **Groupes et annulation** : chaque action utilisateur a un `grp` unique. Une action groupée dont les états précédents diffèrent (ex. « Toute la rue faite » alors que certains étaient « à repasser ») est annulée par **plusieurs événements** (un par état précédent), tous avec `undoOf: <grp annulé>`. La pile d'annulation est dérivée du journal (dernières actions de l'appareil non annulées) : elle survit à une relance. **On n'efface rien du journal**, sauf le détail des passages clôturés depuis plus de 2 mois (branche facteur, `store.purge`, §13).
- `navigator.storage.persist()` au premier lancement ; résultat affiché dans le debug.
- **Export** : `{app: "neyron-tournees", schema: 1, exportedAt, deviceId, tours, events}` (branche facteur : `schema: 2`, formats 1 et 2 importés, §2 bis L7).
- **Import** : fusion avec dédoublonnage sur `(dev, seq)`, puis recalcul de l'état. Ce format permettra de fusionner plusieurs téléphones.
- **Export** (`io.js`) : fichier `neyron-tournees-export-AAAAMMJJ-HHMM.json` (motif ignoré par git), avec en plus `dataVersion`. Construit de façon **synchrone** jusqu'à `navigator.share` (la feuille de partage exige un geste récent : pas d'`await` avant). `meta.lastExportAt` est mémorisé (pour le futur rappel de sauvegarde).
- **Import = donnée non fiable** : `parseBackup()` vérifie `app`, `schema`, puis chaque événement champ par champ (types, `st` ∈ statuts, `seq` entier ≥ 1, longueurs ≤ 64-140 caractères, ≤ 2000 ids, ≤ 200 000 événements, fichier ≤ 20 Mo) ; les entrées invalides sont ignorées et comptées, les **champs inconnus retirés** ; affichage uniquement par `textContent`. Confirmation avant fusion (nombre d'événements, date, appareil source, entrées ignorées, adresses inconnues du plan). Rien n'est jamais supprimé.
- Les événements importés d'un autre appareil ne sont pas annulables (la pile d'annulation ne contient que les actions de l'appareil). Réimporter une sauvegarde de cet appareil relève `seq` au maximum importé (jamais de clé réutilisée).
- Le sélecteur de fichiers est ouvert par un `<label for>` (le plus fiable sur iOS) ; l'`input` est masqué visuellement (`.vh`), pas en `display: none`.
- Une tournée par défaut est créée automatiquement, avec l'id fixe **`default`** (identique sur tous les appareils, pour que la fusion d'exports retombe sur la même tournée) ; « Nouvelle tournée » attend la v0.2. *Branche facteur : tournées multiples et composition en L3 (§2 bis).*
- Écritures : une transaction par action (événements + `seq`), requêtes émises sans `await` intermédiaire (certains Safari valident la transaction dès qu'on rend la main) ; `add` et jamais `put` pour les événements. Une action dont rien ne change (déjà dans ce statut) n'écrit rien.
- API de `Store` : `open(dataVersion)`, `status(id)`, `setStatus(ids, st)`, `undo()`, `canUndo()`, `onChange(fn)`, `requestPersist()`, `allEvents`, `deviceId`, `persistent`, `error`.

### 8.3 GPS (`gps.js`)
- `watchPosition` avec `{enableHighAccuracy: true, maximumAge: 0, timeout: 15000}` ; conversion affine puis soustraction de `x0` / `y1`.
- Rayon du cercle = `coords.accuracy` (mètres). Couleur du point : vert ≤ 10 m, orange ≤ 30 m, rouge au-delà ; **gris si la dernière position a plus de 10 s**.
- Hors du cadre : « Hors du plan (x km) ».
- Mode **suivre** : recentrer à chaque position ; désactivé dès que l'utilisateur déplace la carte à la main.
- **Encart des plus proches** : 3 adresses non faites les plus proches (force brute, 229 points), distance + bouton « Fait ».
- `visibilitychange` (retour au premier plan) : relancer `watchPosition` si aucune position depuis plus de 10 s.
- Hors contexte sécurisé (HTTP), le GPS n'est pas lancé et un toast l'explique ; un refus (code 1) donne le chemin des réglages iOS (« Sites web Safari »).
- Le GPS ne marche **pas** en arrière-plan sur iOS : l'interface le rappelle, avec le conseil de garder l'écran allumé.
- **Bouton localiser** (en haut de la colonne de droite), trois états : `off` → tap → `on` (GPS lancé, centrage sur le premier point, zoom porté à 2,2 px/m au moins) → tap → `follow` (recentrage à chaque position, bouton enfoncé) → tap → `off` (GPS arrêté, point et encart masqués). Un glisser de la carte (`userpan`) repasse de `follow` à `on` ; un pincement (`userzoom`) ne coupe pas le suivi. Pas de recentrage pendant un geste.
- **Encart** (branche facteur : section « À proximité » de Distribuer, §2 ter) : ligne d'état (précision / recherche du signal / position ancienne / hors du plan) puis 3 lignes « adresse · distance · Fait ». Il ignore les rues masquées et garde les « à repasser » (badge). Il est masqué pendant que le panneau d'adresse est ouvert. Sa hauteur entre dans la marge basse de la carte (centrages) et décale la barre d'échelle (`--nearby-h`).
- **Sécurité du geste** : la liste est figée pendant un appui sur l'encart (+ 400 ms), pour qu'une nouvelle position ne réordonne pas les lignes entre l'appui et le relâcher (sinon « Fait » partirait sur une autre adresse). Le rafraîchissement qui suit une action est, lui, immédiat.
- `GpsTracker.inject(x, y, acc)` injecte une position simulée (panneau debug, phase 7). `window.neyronApp.gps` expose le contrôleur.
- Les toasts s'affichent **en haut**, sous la barre, pour ne pas chevaucher l'encart ni le panneau.

### 8.4 Wake Lock (`wakelock.js`)
- `navigator.wakeLock.request('screen')` sur action utilisateur (bouton).
- Relâché automatiquement quand la page est masquée : le redemander sur `visibilitychange` si le bouton est actif.
- API absente ou refusée : « Réglez Verrouillage auto sur Jamais pendant la tournée ».
- `wanted` (choix de l'utilisateur) et `sentinel` (verrou tenu) sont distincts : page masquée → verrou relâché par le système, bouton « en attente » ; retour au premier plan → nouvelle demande ; si elle est refusée (hors geste, fréquent sur iOS), nouvel essai au prochain `pointerdown` du document.
- Au premier succès de la session, le toast rappelle le réglage « Verrouillage auto » : en app installée sur iOS < 18.4, la demande peut réussir sans effet.
- `wake.state` donne un état lisible pour le panneau debug (actif / demandé, non tenu (erreur) / inactif / non supporté).

### 8.5 Service worker (`sw.js`)
- Précache de toute l'app et des données à l'installation, avec `{cache: 'reload'}` (Pages renvoie `max-age=600`). Cache `neyron-tournees-<VERSION>`.
- **Cache d'abord**, sans aucun appel réseau bloquant. Navigation → `./index.html` en cache.
- Suppression des anciens caches `neyron-tournees-*` à l'activation (ne pas toucher aux caches d'autres sites de l'origine).
- Mise à jour : nouvelle version détectée → bandeau « Nouvelle version disponible — Recharger » → `postMessage({type: 'SKIP_WAITING'})` → rechargement sur `controllerchange`.
- Enregistrement : `navigator.serviceWorker.register('./sw.js', {scope: './'})`, dans `pwa.js`, appelé au chargement du module principal (avant le plan).
- Sans « Recharger », le worker en attente s'active de lui-même au prochain lancement à froid (toutes les fenêtres de l'app fermées) : le bandeau est un confort, pas un contrôle de sécurité (§9).
- `clients.claim()` à l'activation : dès la première visite, la page est contrôlée et l'app fonctionne hors ligne sans rechargement. La prise de contrôle de la première installation ne recharge pas la page (rechargement seulement après « Recharger »).
- **Détection d'une mise à jour** : un worker en attente (`reg.waiting`) alors que la page était **déjà contrôlée par une version précédente** (au chargement, ou depuis la fin de la première installation). Ne pas se fier à `navigator.serviceWorker.controller` seul (piège WebKit, §10).
- Navigations (dont `?debug=1`) → `./index.html` du cache ; autres requêtes → cache avec `ignoreSearch`, réseau seulement hors précache. Requêtes d'une autre origine ou hors du scope : non interceptées.
- **Développement local** : avec le cache d'abord, une modification de JS/CSS n'apparaît qu'après `python pipeline/build.py --stamp` puis rechargement (bandeau « Recharger »). Les tests Playwright partent d'un contexte neuf et ne sont pas concernés.

### 8.6 Spécificités iOS
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">` ; `env(safe-area-inset-*)` et `100dvh`.
- `apple-touch-icon` (180 px), `apple-mobile-web-app-status-bar-style`, `theme-color` (clair et sombre). Manifest `display: "standalone"`.
- `touch-action: none` sur la carte ; empêcher le zoom par double tap et le rebond (`overscroll-behavior: none`).
- Export : `navigator.share({files: [...]})` si `navigator.canShare` l'accepte (geste utilisateur requis), sinon lien `download` sur un blob. Import : `<input type="file" accept=".json,application/json">` (iOS grise parfois les `.json` sans l'extension explicite).
- La web app installée a un stockage **séparé de Safari** : la progression saisie dans Safari n'apparaît pas dans l'app installée.
- Thème clair/sombre via tokens CSS sur `:root`, `prefers-color-scheme` et `data-theme`.
- Police : pile système (`-apple-system, system-ui, …`) en v0.1.

---

## 9. Déploiement : GitHub Pages et sécurité

### Mise en place
- Pages en « Deploy from a branch », branche `main`, dossier **`/docs`** ; `docs/.nojekyll` vide ; aucun workflow Actions nécessaire.
- Le pipeline tourne **en local** ; les sources ne sont pas dans le dépôt. `docs/data/` (quelques Mo) **est commité**.
- `gh` est absent : réglages GitHub faits par l'utilisateur dans l'interface web. URL : **https://thoxym.github.io/Tracking-Tourn-e/**. Le warning « Node.js 20 is deprecated » du workflow interne « pages build and deployment » est sans conséquence (workflow géré par GitHub).
- Un push sur `main` est en ligne en 1 à 2 min ; c'est le moyen de tester sur l'iPhone (HTTPS exigé, pas de certificat local).

### Conséquences de l'hébergement
- **Dépôt public** (Pages gratuit) : acceptable, données ouvertes (BAN, cadastre Etalab). Ne jamais committer progression, export, trace GPS, notes.
- **Sous-chemin** `https://<user>.github.io/<repo>/` : URL relatives partout ; manifest `start_url: "./"`, `scope: "./"` ; aucun chemin commençant par `/`.
- **Origine partagée** `<user>.github.io` : préfixer IndexedDB (`neyron-tournees`) et caches (`neyron-tournees-<version>`) ; pas de clés `localStorage` génériques. Changer d'origine = stockage vide, d'où l'export/import.
- **Sécurité** : le SW se met à jour dès que le téléphone joint le site ; l'intégrité repose sur le compte GitHub (MFA + clé matérielle : affaire de l'utilisateur). Côté code :
  - aucun script tiers à l'exécution, tout est servi depuis le dépôt ;
  - CSP en meta (Pages ne permet pas d'en-têtes ; ni `frame-ancestors` ni `Permissions-Policy` possibles), **sans `'unsafe-inline'`** (styles posés uniquement par le CSSOM, autorisé) :
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'` ;
  - aucun script inline, aucun `innerHTML` (tout affichage par `textContent`) ; `<meta name="referrer" content="no-referrer">`.

### Audit de sécurité (19/10/2026)
- **Aucune donnée GPS ne quitte l'appareil.**
  - La position est calculée par l'iPhone, convertie et affichée localement.
  - Seuls trois flux sortent : le chargement des fichiers statiques (identiques pour tous), la vérification de mise à jour de `sw.js`, et l'export, partagé à la main par la feuille de partage.
  - Les positions ne sont jamais stockées : mémoire seule, effacées à l'arrêt du GPS.
  - Le diagnostic copié du panneau debug **masque** lat/lon, x/y et le centre de la carte (le panneau, lui, les affiche sur l'appareil).
- **Donnée indirecte** : le journal (IndexedDB, exports) horodate chaque adresse pointée. C'est un historique partiel des déplacements : traiter les exports comme sensibles.
- **MITM** : rien à intercepter, puisqu'aucune position ne transite.
  - Pour injecter du code, il faudrait casser TLS : HTTPS imposé sur github.io (http → 301), HSTS 1 an (`max-age=31556952`), mais **github.io n'est pas préchargé HSTS** (vérifié sur hstspreload.org).
  - Risque résiduel : première visite en `http://` sur un réseau hostile. Toujours ouvrir l'URL `https://` ; une fois l'app installée, son code est servi par le SW.
  - Un iPhone avec un certificat racine ajouté (profil MDM, proxy d'entreprise) permettrait l'interception.
- **Compromission du compte ou du dépôt GitHub** : c'est le vrai point d'entrée.
  - Un push malveillant atteint le téléphone : le bandeau « Recharger » n'est **pas** une barrière, car le worker en attente s'active seul au prochain lancement à froid.
  - Du code malveillant pourrait alors lire le GPS en direct et l'exfiltrer (il réécrirait la CSP). Aucune parade côté app (limite des web apps).
  - Parades côté compte : clé de sécurité ou passkey, pas de SMS, jetons à durée limitée, ruleset sur `main` (pas de force-push), aucun workflow tiers.
- **Co-hébergement sur `thoxym.github.io`** : le compte a déjà deux sites Pages (`programme-3ans`, `programme2026-st-leger`) sur **la même origine**.
  - Une faille ou un script tiers ajouté à l'un d'eux (aujourd'hui : polices Google en CSS et images externes, pas de script tiers ni de construction risquée) aurait accès à l'IndexedDB et aux caches de l'app.
  - Il pourrait **empoisonner le cache** du SW : injection persistante, donc exfiltration GPS.
  - Il hériterait aussi de l'**autorisation de localisation** accordée à l'origine.
  - Parade possible : une origine dédiée (organisation GitHub gratuite → `<org>.github.io`, ou domaine personnalisé). **Décision de l'utilisateur : rester sur `thoxym.github.io`**, risque accepté, à condition de **ne jamais ajouter de script tiers** (analytics, widgets, CDN) aux autres sites du compte. Migrer plus tard = stockage vide (export/import).
- **Dépôt public** : commits en `182675505+Thoxym@users.noreply.github.com` (réglé dans la config **locale** du dépôt ; historique réécrit, dépôt recréé pour ne laisser aucun ancien commit accessible). Le nom complet reste affiché (choix de l'utilisateur).
- **Cadrage (clickjacking)** : impossible à interdire par en-tête sur Pages. Impact faible : un site tiers qui encadre l'app ne peut rien lire (origine différente), au pire provoquer des taps.
- **Chaîne d'approvisionnement** : rien de tiers à l'exécution. Playwright et les libs Python ne tournent que sur le PC. Des données sources piégées ne peuvent pas injecter de script (`textContent`, `setAttribute('d')`). L'import piégé est testé.

---

## 10. Pièges connus

- **Pointer capture** : un `setPointerCapture` dans `pointerdown` redirige le `click` vers le `<svg>` et les numéros ne réagissent plus. Capturer seulement après 4 px de mouvement.
- **`hidden` et `all: unset`** : `all: unset` sur les boutons annule `hidden`. Ajouter `[hidden]{display:none!important}`.
- **Couleurs** sur 6 chiffres (`#888` mal interprété a déjà donné du bleu marine avec reportlab).
- **Doublons BAN** : une adresse peut figurer deux fois avec le même `id` (deux entrées, ex. 2 Impasse Privée des Capucins). L'id étant la clé de progression, le pipeline garde la première occurrence et le signale.
- **Rang `s` des rues** : c'est le rang alphabétique dans les données, qui se décale si une voie apparaît dans un nouveau millésime BAN. Pour enregistrer quelque chose par rue (ordre, sens), utiliser la **clé de voie** (`01275_0420`, début de l'id des adresses, `tourplan.streetKeys`).
- **Caractère ⚠ (U+26A0)** : même suivi du sélecteur de texte U+FE0E, WebKit sous Windows l'affiche en emoji jaune. Utiliser une icône SVG (`common.anomalyCount`).
- **CSV venant d'Excel en français** : souvent en Windows-1252, avec `;`. Décoder en UTF-8 strict (`TextDecoder('utf-8', {fatal: true})`), puis Windows-1252 en cas d'échec.
- **Entrée dans un `<dialog>` à formulaire** : elle déclenche le premier bouton `submit` du formulaire (ici « Annuler »). `ui.prompt` intercepte Entrée pour valider.
- **Champs de saisie sur iOS** : police d'au moins 16 px, sinon Safari zoome la page au focus. Et `user-select: text` sur le champ, puisque le `body` est en `user-select: none`.
- **Pas de serveur LAN** : le SW ne doit jamais attendre le réseau pour servir l'app.
- **iPhone sur `http://<IP du PC>:8000`** : ce n'est pas un contexte sécurisé. Safari y **refuse la localisation sans rien demander** (erreur « refusée », quels que soient les réglages), et il n'y a ni service worker ni Wake Lock. Seule l'interface se teste ainsi ; le GPS exige HTTPS (GitHub Pages). L'app l'annonce désormais (`isSecureContext`) et le panneau debug affiche « contexte sécurisé ».
- **Chemins** absolus (`/js/…`) cassés sous `/<repo>/`.
- **Oubli du stamp** : modifier du JS/CSS sans `build.py --stamp` → pas de mise à jour du SW sur l'iPhone.
- **Windows** : pas de `zcat` hors Git Bash (le pipeline lit le gzip en Python) ; toujours ouvrir les fichiers en `encoding='utf-8'` (noms de voies accentués, apostrophe typographique dans `cage d’escalier`) ; écrire les JSON avec `ensure_ascii=False` et des fins de ligne `\n`.
- **iOS** :
  - Wake Lock en mode standalone fiable seulement sur iOS récent (≈ 18.4+) : vérifier sur l'appareil, garder le message de repli ;
  - la permission de géolocalisation peut être redemandée à chaque lancement de l'app installée ;
  - stockage de l'app installée séparé de Safari : ne pas pointer dans Safari ;
  - WebKit de Playwright sous Windows ≠ Safari iOS : les tests ne remplacent pas l'essai sur l'iPhone.
- **Playwright + WebKit : `boundingBox()` des `<text>` SVG est faux** (coordonnées aberrantes, ex. x = −1345). Pour taper un numéro dans un test, calculer la position avec `neyronApp.map.toScreen(a.x, a.y)` et taper `#map` à cette position. Sous le zoom `K_NUMBERS`, les numéros sont masqués : zoomer d'abord.
- **WebKit et première installation du service worker** : la page est rattachée au nouveau worker (`clients.claim`) **avant** que celui-ci signale `installed`, alors qu'il est encore `waiting`. Un test « `reg.waiting && controller` » affiche donc un faux bandeau « Nouvelle version » à la première visite. Critère retenu : page déjà contrôlée par une version précédente (§8.5).
- **Playwright + Chromium, géolocalisation simulée** : `setGeolocation` avec les mêmes coordonnées et une autre précision ne déclenche pas de nouvelle position ; décaler légèrement la position dans les tests.
- **`python -m http.server` et tests en parallèle** : sa file d'attente de 5 connexions déborde quand plusieurs navigateurs précachent l'app en même temps. Sous Windows, cela donne des connexions refusées et une app qui ne démarre pas (timeouts aléatoires). Les tests utilisent donc `tests/serve.py` (file de 256).
- **Chromium hors ligne et cache HTTP** : avec `setOffline(true)`, Chromium peut encore servir un fichier depuis son cache HTTP. Un fichier absent du précache passe alors inaperçu (l'iPhone, lui, ne garantit pas ce cache). Le test hors ligne vérifie donc que chaque ressource chargée est dans le cache du SW.
- **WebKit sous Windows, tests en parallèle** :
  - Le rendu est logiciel. Avec 8 workers et `--repeat-each=3`, les tests de tournées les plus longs atteignent ~50 s : le projet `webkit-iphone` a donc un délai de 75 s (Chromium : 45 s).
  - Une fois, un worker est resté bloqué après la fin des tests, avec un `WebKitNetworkProcess` orphelin. Arrêter alors les processus `node` de Playwright et `tests/serve.py`, puis relancer avec `--reporter=list > fichier` pour voir où ça bloque.
  - Rarement (environ 1 exécution WebKit sur 50 dans les tests longs, sous charge), un clic attend « visible, enabled and stable » jusqu'au délai, sans aucune nouvelle tentative dans le journal. La page, elle, répond : capture et instantané d'accessibilité fonctionnent. C'est le `requestAnimationFrame` du script injecté par Playwright qui ne vient plus.
  - Côté app, au repos : 0 mutation du DOM, 0 rendu de carte, ~50 images/s. Test A/B L4 / L5 (navigation et Préparer, × 10) : 0 blocage des deux côtés.
  - D'où un second essai pour WebKit seulement (`retries: 1`), signalé « flaky » dans le rapport.
- **Taper un numéro pendant une animation de la carte** (recentrage vers la prochaine adresse, cadrage) : l'animation continue et déplace le plan sous le doigt. Les outils de test appellent `map._stopAnim()` avant de calculer la position.
- **Feuille et tests** (refonte) :
  - Le centre de l'écran peut être sous la feuille : les outils de test centrent l'adresse dans la partie visible (`map.centerOn`, qui tient compte des marges) avant de taper.
  - Au grand cran, les boutons de la carte sont masqués : passer au cran moyen avant de toucher le menu ⋯ ou Annuler.
  - Un onglet retrouve la page où on l'avait laissé : `openPage` retouche l'onglet pour revenir à la page principale.
- **Captures sous WebKit (Windows)** : les animations CSS y sont lentes, une capture peut tomber en pleine entrée de page ou de dialogue (page blanche, dialogue à moitié transparent). Capturer avec `reducedMotion: 'reduce'`, comme les tests. Ce WebKit **ne dessine pas** `backdrop-filter` (le plan reste net sous le verre) : le flou ne se juge que sur l'iPhone, d'où des matériaux assez opaques pour rester lisibles sans flou.
- **Machine chargée** (navigateur de l'utilisateur ouvert, `com.docker.llama-server` actif) : des démarrages de l'app sous WebKit dépassent 15 s, sans rapport avec le code (un essai sans flou a donné plus d'échecs ; les tests relancés seuls passent). `waitReady` attend donc 30 s. Lancer avec `--workers=3` à `5` pour distinguer les vrais échecs (25/10/2026, après I2 : 5 workers → quelques tests WebKit réussis au second essai ; WebKit seul avec 3 workers → 66/66).
- **Port 8100 = serveur des tests** : Playwright le démarre et l'arrête. Pour voir l'app en local, servir `docs/` sur le port 8000 (`python -m http.server -d docs 8000 --bind 127.0.0.1`), puis « Recharger » sur le bandeau (le service worker sert d'abord la version en cache).
- **Séparateurs des listes groupées** : `.group > * + *::before` dessine le trait fin ; un enfant direct ne peut donc pas utiliser son propre `::before` (pastille de couleur de l'ordre de passage : élément `.order-dot`).
- **`<dialog>` en bas d'écran** : les styles du navigateur centrent un dialogue modal et bornent sa hauteur ; la feuille d'actions se place en `position: fixed; inset: auto 0 0 0`, sans `max-height`.
- **Animations dans les tests** : mesurer un zoom après un délai fixe est instable sous WebKit chargé. Attendre la fin de l'animation (`map._anim` nul, `k` modifié).
- **Safari et pincement de page** : iOS ignore `user-scalable=no` ; les `gesturestart/change` sont bloqués au niveau du document, et sur macOS le pincement trackpad (événements `gesture*` sans pointeur actif) zoome la carte.
- **v0.2 (PDF reportlab)** : le mode de rendu du texte (`Tr`) persiste → entourer les halos de `saveState()` / `restoreState()` ; exposants et indices Unicode non rendus.

---

## 11. Tests

- **Bureau** : `python -m http.server -d docs 8000`, http://localhost:8000 (contexte sécurisé : géolocalisation et SW fonctionnent).
- **Playwright** : `npx playwright test` (ou `npm test`), ~50 s, 8 workers. Projets `webkit-iphone` (iPhone 13, délai de 75 s par test, un second essai, §10) et `chromium` (bureau 1280 × 800, 45 s). La config lance **son propre serveur** `tests/serve.py` sur **http://127.0.0.1:8100** (boucle locale, file d'attente de 256 connexions, §10), distinct du serveur de dev (8000). Chaque test part d'un contexte neuf (IndexedDB, caches, SW vides). Rapport : `npx playwright show-report` ; trace conservée en cas d'échec.
- **Contre le site en ligne**, après un push : `BASE_URL=https://thoxym.github.io/Tracking-Tourn-e/ npx playwright test` (PowerShell : `$env:BASE_URL='…'; npx playwright test`). Pas de serveur local. Le site doit servir le commit courant : les tests comparent la version avec celle de `docs/sw.js`. Compter 1 à 3 min de publication après le push.
- Les 6 cas de référence, et les fichiers qui les couvrent :
  1. chargement du plan (229 numéros pointables, contexte en gris) → `plan.spec.js` ;
  2. tap sur un numéro, Fait : l'état persiste après rechargement → `pointage.spec.js` ;
  3. « Toute la rue faite », puis Annuler : états précédents restaurés (y compris « à repasser ») → `pointage.spec.js` ;
  4. position simulée sur la Rue de la Gare : l'encart propose les bons numéros → `gps.spec.js` (attendus recalculés depuis `addresses.json`, indépendamment de l'app) ;
  5. export puis import : état identique → `sauvegarde.spec.js` (deux contextes = deux appareils) ;
  6. hors ligne (`context.setOffline(true)`) après une première visite : l'app se charge → `hors-ligne.spec.js`.
- Couvert en plus (repris des vérifications des phases 2 à 8) :
  - gestes ;
  - numéro de contexte non pointable ;
  - Ctrl+Z ;
  - suivi GPS, précision, hors du plan, position ancienne, relance, refus ;
  - Wake Lock simulé (`wakelock.spec.js`) ;
  - feuille de partage ;
  - **import piégé** ;
  - panneau debug (`debug.spec.js`) ;
  - **tout fichier chargé hors ligne est dans le précache** ;
  - mise à jour par le bandeau, sur une copie du site servie sur un port libre ;
  - **stamp à jour** (`build.py --check`, Chromium seulement).
- Outils communs dans `tests/helpers.js` : `openApp`, `tapAddress` (position écran calculée par la carte, adresse centrée hors de la feuille, §10), `setDetent`, `openPage(page, onglet, ligne)` (page principale de l'onglet, grand cran, puis la ligne), `openLegend` (rues de la tournée), identifiants BAN et positions GPS de référence, `trackErrors` (toute erreur JS ou `console.error` fait échouer le test).
- Les tests tournent avec `reducedMotion: 'reduce'` : transitions et animations CSS coupées, une cible n'est jamais touchée en mouvement.
- Vérifié le 19/10/2026 :
  - `--repeat-each=3` : 144/144, aucun test instable ;
  - des sabotages volontaires sont détectés : encart limité à 2 adresses, module retiré du précache.
- **Pipeline** : les assertions de comptage et de résidu font office de tests.
- **iPhone** : uniquement via l'URL GitHub Pages, après un push. Debug : `?debug=1` dans Safari ; **dans l'app installée, 5 taps rapides sur la ligne de version du menu ⋮** (son stockage est séparé de Safari et elle ne reçoit pas de paramètre d'URL). Réduire le panneau pour dégager la carte avant un appui long.

---

## 12. Roadmap après la v0.1

**Décidé le 19/10/2026 (priorité sur la liste numérotée ci-dessous)** :

A. **Mode préparation de tournée** (repris et précisé par le plan de branche §2 bis, le 20/10/2026 : tournées composées à la main d'abord, **itinéraire calculé reporté**, proposé ensuite comme optimisation). L'utilisateur crée lui-même ses tournées dans l'app, sur **toute la commune** de Neyron.
   - **Toute la commune** :
     - le pipeline traite toutes les voies et toutes les adresses `entrée` (~940), avec un cadre sur la commune entière ;
     - les 10 rues actuelles deviennent une tournée parmi d'autres (à recréer ou importer) ;
     - conséquences : plus de couleur par rue (trop de voies), couleurs par sélection et statut ; recherche d'adresse ou de rue à la place de la longue légende ; tests à adapter (229 codé en dur, `EXPECTED_COUNTS`).
   - **Créer une tournée** : nom, sélection des numéros (tap, rue entière, côté pair / impair, éventuellement lasso), archivage. Ça s'appuie sur le store `tours` et le champ `tour` des événements, prévus dès la v0.1. La progression est suivie par tournée.
   - **Itinéraire le plus court**. Dijkstra seul ne suffit pas : visiter N adresses choisies dans le meilleur ordre est un **problème du voyageur de commerce**.
     - Distances réelles à pied : Dijkstra ou A* sur un **graphe piéton**, depuis chaque adresse sélectionnée (matrice N × N).
     - Ordre de visite : exact (Held-Karp) jusqu'à ~12 points, sinon plus proche voisin puis 2-opt / Or-opt (quelques ms en JS pour 200 points).
     - Options : départ = position GPS ou adresse choisie ; boucle ou chemin ouvert.
     - Porte-à-porte : pénalité de traversée (un côté puis l'autre sur la Route de Genève, zigzag dans les petites rues).
     - Affichage : tracé, numéro d'ordre sur chaque adresse, distance et durée estimées, « prochaine adresse ».
   - **Graphe piéton** à construire par le pipeline : aujourd'hui on n'a que des tracés approchés, pas de réseau. Deux sources possibles :
     - **OSM** : sentiers, escaliers, passages, utiles pour les « montées » ; licence ODbL, avec la mention « © les contributeurs OpenStreetMap » obligatoire dans l'app ;
     - **BD TOPO IGN** : Licence Ouverte, tronçons de voirie.
     - **À décider en début de session.**
   - Tout le calcul se fait **sur l'appareil** (graphe embarqué, aucun service de routage externe) : cohérent avec §9, aucune position n'est envoyée.
B. **Plus tard — deuxième carte : Lyon 3e autour de la gare Part-Dieu.**
   - Multi-cartes : données par carte (`docs/data/<carte>/`), sélecteur de carte, ajustement affine propre à chaque carte.
   - Les identifiants BAN commencent par le code INSEE : pas de collision dans le journal.
   - Lyon est publié **par arrondissement** : 3e = INSEE **69383**, BAN du département 69, cadastre de la commune 69383 (à vérifier au téléchargement).
   - Milieu dense : immeubles, plusieurs adresses par bâtiment, `type_position` variés. Emprise limitée autour de la gare. Précache plus lourd.

1. **v0.2 — Confort de tournée**
   - Nouvelle tournée avec archivage (→ intégré au point A).
   - Actions groupées par côté (pairs / impairs) et par tronçon (Route de Genève : 105 numéros).
   - Filtre « reste à faire ».
   - **Recherche d'une adresse** (« 12 Rue de la Gare ») avec zoom dessus.
   - **Rappel de sauvegarde** : bandeau si aucun export depuis N pointages ou N jours.
   - Mode « gros boutons » (usage avec gants, en marchant).
   - Export PDF A4 par rue, logique reportlab de l'ancien projet (échelle 1:2000 à 1:2500, découpage selon l'axe principal, vue d'ensemble), servis comme fichiers via la feuille de partage.
   - Police Barlow Semi Condensed hébergée dans l'app.
2. **v0.3 — Guidage**
   - Ordre de passage par rue : pairs puis impairs, ou zigzag dans les petites rues ; un côté puis l'autre sur la Route de Genève.
   - Ordre des rues choisi à la main.
   - Flèche et distance vers la prochaine adresse ; **boussole** via `DeviceOrientationEvent` (permission iOS sur geste).
   - Suggestion automatique optionnelle, désactivée par défaut, seuils à calibrer sur le terrain (ex. précision ≤ 10 m, distance ≤ 6 m, 8 s sur place), dans un message annulable plutôt qu'un pointage silencieux.
   - Mode simulation `?sim=trace.gpx`.
3. **v0.4 — Trace et bilan**
   - Enregistrement filtré de la trace (précision, distance minimale), affichage, export GPX.
   - Statistiques : temps, distance, avancement par rue.
   - Liste imprimable des adresses « à repasser ».
4. **Plus tard, si besoin**
   - Synchro à plusieurs : d'abord par fusion d'exports JSON (déjà permise), puis éventuellement en temps réel (backend type Cloudflare Workers + D1 derrière Access, à valider avec l'utilisateur).
   - Vrais axes de voies (OSM ou BD TOPO) à la place des tracés approchés.
   - Domaine personnalisé pour isoler l'origine (migration via export/import).
   - CI GitHub Actions lançant Playwright au push (optionnelle).

---

## 13. Garde-fous RGPD
- Stocker plus que fait / pas fait (absent, refus, notes) = données sur des foyers identifiables, soumises au RGPD.
- Une liste d'« absents » horodatés équivaut à une liste de maisons vides. Ces données restent **sur l'appareil**, ne sont jamais commitées et ne partent jamais vers un serveur sans décision explicite de l'utilisateur.

### Revue de la branche facteur (L7, 20/10/2026)
| Donnée | Où | Contenu | Mesure |
|---|---|---|---|
| Journal (`events`) | IndexedDB, sur l'appareil | chaque pointage horodaté, motif d'anomalie codé | jamais envoyé ; détail d'un passage clôturé **effacé après 2 mois** (voir ci-dessous) |
| Motifs d'anomalie | journal, rapport | 6 codes fermés ; « destinataire inconnu » concerne les occupants | aucune note libre ; motifs validés par l'utilisateur |
| Rapport CSV / JSON | partagé à la main | une ligne par adresse : statut, motif | **sans heure par défaut** ; heures sur demande explicite (case) |
| Historique des passages | fiche de tournée | comptes par passage, anomalies par motif | **agrégé**, sans détail par adresse ni heure |
| Sauvegarde JSON | partagée à la main | tout le journal horodaté, identifiant d'appareil aléatoire | mention « à garder pour vous, ce n'est pas un rapport » |
| Position GPS | mémoire seulement | — | jamais stockée ni exportée ; masquée dans le diagnostic copié |
| Repères d'adresse (I4) | `meta.tags`, sur l'appareil ; sauvegarde | 8 codes fermés (« chien »…) et une note de 60 caractères au plus, par adresse | foyer identifiable : avertissement sous la note (rien sur les personnes, aucun code d'accès) ; **jamais dans le rapport** ; liste à revoir et « Tout supprimer » dans Préparer › Repères |
| Préférences (`localStorage`) | appareil | thème, onglet, réglages de charge, heures du rapport, tournée en pause (id de tournée et numéro d'arrêt, I5 bis), voix et carte orientée (I6) | aucune donnée personnelle |

- Aucun flux réseau nouveau : CSP inchangée, aucun service tiers, tout reste sur l'appareil.
- **Conservation limitée** (validée le 25/10/2026) : `store.purge()` efface, à chaque lancement et après chaque import, les événements antérieurs à la dernière clôture de plus de **60 jours** de chaque tournée (`RETENTION_DAYS`, durée recommandée par la CNIL pour le suivi d'activité d'un salarié).
  - Le bilan agrégé des passages est gardé ; le passage en cours et l'annulation (passage en cours seulement) n'en dépendent pas ; `seq` ne redescend jamais (`meta.seq`).
  - Une sauvegarde qui rapporte le détail d'un passage déjà effacé le voit effacé à nouveau à l'import (le résumé ne le compte pas).
  - Une tournée jamais clôturée garde tout son journal (c'est son passage en cours).
  - Le panneau debug affiche le nombre d'événements effacés depuis le lancement.

---

## 14. Journal des décisions
- **19/10/2026** — Route de Genève : tournée sur les n° **58 à 193, côtés pair et impair** (105 numéros) ; n° < 58 du cadre en gris, non pointables (`ctx: true`). *Confirmé par l'utilisateur.*
- **19/10/2026** — Premier test terrain visé dans **quelques jours** : v0.1 complète, tracés « domaine non cadastré » (repli MST seulement en secours) et améliorations intégrées (stamp, assertions, annulation groupée, debug enrichi).
- **19/10/2026** — Données sources fournies en version département ; comptes vérifiés (§4). `CLAUDE_base.md` conservé comme archive.
- **19/10/2026** — Phase 0 : sources déplacées dans `sources/`, dépôt git local sans remote. Ajout de `.gitattributes` (`eol=lf`) car `core.autocrlf=true` sur le poste fausserait le hash de version.
- **19/10/2026** — Phase 1 : contexte = numéros hors tronçon **dans le cadre** (11, et non 33) ; bâti dur préféré pour l'association ; domaine non cadastré limité à la commune par fermeture morphologique ; étiquettes de rues calculées par le pipeline (`streets[].labels`, ajout au schéma).
- **19/10/2026** — Phase 2 : en vue d'ensemble, points à la place des numéros et tap = zoom (évite les pointages au hasard) ; thème stocké en `localStorage` préfixé (préférence d'appareil, lue avant affichage) plutôt qu'en IndexedDB ; panneau d'adresse en bas, avec décalage automatique de la carte.
- **19/10/2026** — Phase 3 : statuts distincts par la forme (estompé / pastille) et pas seulement par la couleur, à cause des collisions avec les couleurs de rues ; tournée par défaut à id fixe `default` ; panneau d'adresse limité aux actions qui changent le statut, fermé après l'action, toast avec « Annuler ».
- **19/10/2026** — Phase 4 : bouton GPS unique à trois états (localiser / suivre / arrêter) ; le pincement ne coupe pas le suivi ; encart figé pendant un appui (protection contre un « Fait » sur la mauvaise ligne) ; toasts déplacés en haut.
- **19/10/2026** — Premier commit `2acdf2b` (phases 0 à 4), à la demande de l'utilisateur ; pas de remote.
- **19/10/2026** — Phase 5 : écran allumé proposé directement depuis le toast de démarrage du GPS ; reprise du verrou au prochain toucher si iOS la refuse au retour au premier plan.
- **19/10/2026** — Commit `abc2685` (phase 5). Phase 6 : menu « ⋮ » qui regroupe Exporter / Importer / Thème (le bouton thème quitte la barre pour libérer de la place sur iPhone) ; import validé strictement et confirmé avant fusion.
- **19/10/2026** — Commit `9b03e31` (phase 6). Phase 7 : debug activable dans l'app installée par 5 taps sur la version (pas de paramètre d'URL possible) ; journal d'erreurs JS toujours collecté ; position simulée qui coupe le vrai GPS ; panneau limité à 38 % de la hauteur sur téléphone.
- **19/10/2026** — Commit `27a38a9` (phase 7). Phase 8 : `clients.claim()` pour être hors ligne dès la première visite ; mise à jour jamais imposée (bandeau) ; vérification de mise à jour au retour au premier plan (app installée rarement rechargée) ; critère de mise à jour robuste au comportement de WebKit.
- **19/10/2026** — Commit `50a06ba` (phase 8). Phase 9 :
  - serveur de test dédié (`tests/serve.py`, 127.0.0.1:8100, file d'attente longue) au lieu de `http.server`, qui refusait des connexions en parallèle ;
  - tests de toutes les phases, et pas seulement des 6 cas ;
  - attendus GPS recalculés depuis les données ;
  - précache vérifié ressource par ressource ;
  - `build.py --check` dans les tests contre l'oubli du stamp.
- **19/10/2026** — Audit de sécurité (§9) :
  - CSP durcie (sans `'unsafe-inline'`, plus `object-src`, `base-uri` et `form-action` à `'none'`) ;
  - position masquée dans le diagnostic copié ;
  - message explicite en HTTP (`isSecureContext`) : l'iPhone testait sur `http://192.168.1.x:8000`, d'où « localisation refusée » ;
  - message de refus GPS avec le chemin iOS.

  Le dépôt `github.com/Thoxym/Tracking-Tourn-e` (privé, Pages inactif) avait été créé et poussé par l'utilisateur.
- **19/10/2026** — Phase 10, décisions de l'utilisateur :
  - origine `thoxym.github.io` conservée (partagée avec `programme-3ans` et `programme2026-st-leger`, risque accepté) ;
  - e-mail `noreply` et réécriture de l'historique ; plutôt qu'un force-push, qui laisserait les anciens commits visibles via l'onglet Activity, le dépôt a été supprimé puis recréé public et vide ;
  - nom de dépôt `Tracking-Tourn-e` conservé ;
  - ruleset sur `main`.

  Le serveur de dev (`http.server` sur toutes les interfaces, journal des requêtes en local) a été arrêté. Tests rendus lançables contre le site en ligne (`BASE_URL`).
- **19/10/2026** — Carte de Cottance abandonnée : pas nécessaire pour valider le GPS. Prochaine session : mode préparation de tournée sur toute la commune, avec itinéraire le plus court (§12 A). Plus tard : carte de Lyon 3e autour de la gare Part-Dieu (§12 B).
- **20/10/2026** — Branche `dev_tracking_tournee_laposte` : l'app évolue vers la distribution du courrier (préparer / distribuer / contrôler), avec une barre d'onglets en bas, sobre. Pas d'itinéraire calculé pour l'instant. Plan et limites d'architecture en §2 bis. Plan validé par l'utilisateur.
- **20/10/2026** — L1 : vues Préparer et Contrôler posées par-dessus la carte plutôt que de la masquer. Avec `display: none`, la carte aurait une taille nulle (cadrages faux, suivi GPS cassé), et Préparer réutilisera la carte pour la sélection (L3). Distribuer est l'onglet par défaut.
- **20/10/2026** — L2 : toute la commune (941 adresses, 90 voies).
  - Les 10 rues deviennent la tournée prédéfinie `default`.
  - Couleurs : plutôt qu'une couleur unique, une palette de 8 teintes attribuée par voisinage, pour savoir à quelle rue appartient un numéro près d'un carrefour. Le vert et l'orange restent réservés aux statuts.
  - Rues triées par ordre alphabétique et cherchables.
  - Doublon BAN : on garde la première occurrence.
- **20/10/2026** — L3 : tournées.
  - La composition est une liste d'ids dans la fiche de tournée, sans nouvelle version IndexedDB.
  - La tournée `default` de la v0.1 est migrée vers le preset « 10 rues » avec sa progression.
  - La progression reste propre à chaque tournée.
  - Hors tournée : gris et non pointable.
  - Composition par rue (côté, plage) ou sur la carte.
  - Archivage plutôt que suppression.
  - Fusion des tournées importées : dernière écriture gagnante (`updatedAt`).
- **20/10/2026** — Commit `d77f7d8` (L3). L4 : préparer.
  - Ordre de passage et sens enregistrés par clé de voie BAN plutôt que par rang alphabétique (stable d'un millésime à l'autre).
  - Charge = arbre couvrant par rue + liaisons à vol d'oiseau. C'est une estimation affichée comme telle (« ≈ ») ; le vrai chemin attendra le graphe piéton (§12 A). Réglages par appareil, comme le thème.
  - Vérifications informatives, sans « marquer comme vu » pour l'instant : numéros oubliés (même côté, entre deux numéros de la tournée), numéros sans bâtiment, bâtiments sans adresse repérés par le pipeline.
  - Le secteur CSV crée toujours une **nouvelle** tournée, dont l'ordre des lignes donne l'ordre de passage ; pas d'export CSV de secteur (la sauvegarde JSON transporte déjà les tournées).
- **20/10/2026** — Commit `b51103a` (L4). L5 : distribuer.
  - Motifs d'anomalie **validés par l'utilisateur** (liste de 6, codes stables, sans note libre).
  - Anomalie = statut à part entière, avec son motif, et adresse traitée. « À repasser » est gardé pour reporter une adresse dans la tournée.
  - « Fait » devient « Distribué » dans l'interface. Le statut interne reste `fait`, ce qui garde les données et exports compatibles.
  - Reprise guidée : carte « prochaine adresse » dans un dock en bas d'écran (zone du pouce), qui avance seule. Protection de 500 ms contre le double toucher, comme l'encart GPS, figé pendant l'appui. Reprise mémorisée d'une relance à l'autre.
  - Choix du motif dans un `<dialog>` en bas d'écran (focus sur Annuler), partagé par le panneau d'adresse et la reprise.
- **20/10/2026** — Commit `d7eeb24` (L5). L6 : contrôler.
  - Clôturer = fin du **passage**, pas de la tournée : un facteur refait la même tournée chaque jour. Borne dans le journal plutôt qu'effacement ou duplication de tournée ; dernier passage réouvrable.
  - Historique **agrégé** seulement. Le détail par adresse sort par le rapport, à exporter avant ou juste après la clôture (toast).
  - Rapport sans heures par défaut (RGPD), heures en option. CSV protégé contre l'injection de formule.
- **20/10/2026** — Commit `5ffa2f6` (L6). L7 : robustesse.
  - Sauvegarde au format 2. La v0.1 la refuse en bloc, et c'est voulu : sans les bornes de passage, elle calculerait un état faux.
  - Store : écrire d'abord, modifier la mémoire ensuite.
  - Cibles tactiles portées à 44 px partout, et correction de l'écrasement des boutons dans les vues qui défilent.
  - Revue RGPD consignée en §13. La purge du journal est proposée à l'utilisateur, pas faite, car elle touche la règle « on n'efface jamais rien ».
- **25/10/2026** — Commit `f779a86` (L7). Décisions de l'utilisateur :
  - effacement du détail des passages clôturés depuis plus de **2 mois** (bilans gardés, §13) ;
  - **pas de publication pour l'instant** : refonte complète de l'interface d'abord (§2 ter), style Apple **Liquid Glass** (iOS 26), carte plein écran sous une **feuille à crans** dont les 3 onglets changent le contenu (comme Localiser ou Plans), au plus simple sans perdre de fonction.
- **25/10/2026** — Refonte (R1 à R4), choix de mise en œuvre :
  - plus de mode « Reprendre » : la prochaine adresse est toujours en haut de Distribuer, ce qui supprime un geste et un état mémorisé ;
  - la fiche d'adresse et « voir sur le plan » restent dans l'onglet courant, puisque la carte est visible partout ; on revient à la liste en fermant la fiche ;
  - les sections repliables deviennent des pages de la feuille (navigation iOS), l'éditeur de rue une page plutôt qu'un dialogue ;
  - la sauvegarde ne reste que dans le menu ⋯ (elle doublait la ligne de Contrôler) ;
  - grand cran : les boutons de la carte s'effacent, comme dans Plans ;
  - pas de SF Symbols (licence réservée aux plateformes Apple) : icônes SVG dessinées dans le même esprit ;
  - couleurs système d'Apple assombries pour les statuts sur fond plein (vert `#248a3d`, rouge `#d70015`), « À repasser » et « Remettre à faire » en boutons teintés.
- **25/10/2026** — Refonte commitée par l'utilisateur (`396c244`). Nouvelles fonctions décidées (§2 quater) :
  - itinéraire optimisé calculé sur l'appareil, avec tissage et arrêts du véhicule ;
  - modes voiture, vélo et à pied ;
  - itinéraire personnalisable ;
  - repères d'adresses avec alerte ;
  - guidage « comme Waze » (voix, carte orientée) ;
  - simulation.

  Choix de l'utilisateur :
  - réseau BD TOPO et OSM, téléchargés par le pipeline ;
  - repères en liste fermée avec une note courte (avertissement RGPD) ;
  - départ et arrivée choisis sur le plan, approche par Plans ou Waze ;
  - retouches du calcul et liste d'arrêts à réordonner ;
  - tissage automatique selon la route.
- **25/10/2026** — I1 :
  - tronçons rattachés aux voies par l'identifiant BAN de la BD TOPO (même clé que les adresses) plutôt que par le nom ;
  - point de remise estimé sur la limite de parcelle au droit de l'adresse, car la BAN place souvent le point sur la maison ;
  - emprise élargie à 1,5 km pour les routes principales, car des sens uniques coupés isolaient le bord du Rhône ;
  - dessertes OSM carrossables comme voies privées.
- **25/10/2026** — Commit `5a92a06` (I1). I2 :
  - Dijkstra sur les arcs orientés plutôt que sur les nœuds : demi-tours, sens uniques et côté de la route exacts ;
  - arrêts regroupés par distance de marche autour de l'arrêt (et non par tronçon), pour tisser par-dessus les 2 chaussées ;
  - à pied, portions de rue mises bout à bout, pour que « non tissé » donne un côté puis l'autre et pas un zigzag tronçon par tronçon ;
  - heuristique reproductible (graine) et bornée en temps, dans un worker.
- **25/10/2026** — Commit `d2177ba` (I2). I3 :
  - « Recalculer » repart de zéro, avec confirmation si l'itinéraire est retouché, au lieu de réoptimiser autour de retouches verrouillées : plus simple à comprendre, et une composition modifiée garde les retouches (« Mettre à jour »).
  - Réglages chiffrés propres à chaque mode (passer de la voiture au vélo ne mélange pas les valeurs).
  - Une fois calculé, le résultat passe en tête de la page Itinéraire et sert de petit cran.
  - Le tracé n'est montré que dans les pages de l'itinéraire, pour ne pas charger Distribuer avant la navigation (I5).
- **25/10/2026** — Commit `9c7eeb3` (I3). I4 :
  - repères par adresse plutôt que par tournée (le chien est le même quelle que soit la tournée) ;
  - à la fusion, le plus récent l'emporte ; une suppression ne se propage pas d'un appareil à l'autre ;
  - alerte sur la prochaine adresse et à moins de 50 m au GPS, pas plus d'une fois par quart d'heure pour une même adresse ;
  - saisie en pastilles sur deux colonnes, pour tenir à l'écran avec la note.
- **25/10/2026** — Commit `958493e` (I4). I5 :
  - pendant la navigation, la capsule d'onglets disparaît et la feuille montre l'arrêt en cours (comme Plans en guidage) ; Terminer ramène à Distribuer ;
  - « Démarrer » dans l'en-tête de Distribuer, pour ne pas allonger le petit cran ;
  - le plan suit la position lui-même, car un refus ou une coupure du GPS ne doit pas figer la carte ;
  - l'approche du premier arrêt peut passer par Plans ou Waze (liens, sans aucun appel réseau de l'app).
- **25/10/2026** — Commit `100dcc4` (I5). I5 bis, avec la demande de l'utilisateur de pouvoir quitter puis reprendre une tournée :
  - « Quitter » propose la pause (reprise à l'arrêt mémorisé, même après une relance) ou la fin ;
  - la reprise est une préférence d'appareil (`localStorage`), comme l'onglet : elle ne voyage pas avec la sauvegarde ;
  - la simulation passe par la même vue et la même source de position que le GPS, sans rien écrire dans le journal.
- **25/10/2026** — Commit `2f36d55` (I5 bis). I6 :
  - rotation par un groupe SVG racine plutôt qu'une rotation CSS du conteneur : les gestes, le toucher et les cadrages restent exacts, et les textes se redressent un à un ;
  - cap tiré du trajet à venir plutôt que de la boussole de l'iPhone (pas de permission à demander, pas d'affolement à l'arrêt) ;
  - voix du système, hors ligne, avec une annonce par seuil ; repères annoncés seulement pendant la navigation.