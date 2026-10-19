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

**État : phases 0 à 9 terminées le 19/10/2026. Commits locaux `2acdf2b` (phases 0-4), `abc2685` (5), `9b03e31` (6), `27a38a9` (7), `50a06ba` (8) ; remote `origin` = github.com/Thoxym/Tracking-Tourn-e (privé, créé et poussé jusqu'à `50a06ba` par l'utilisateur, Pages inactif) ; phase 9 et audit de sécurité pas encore commités. Prochaine étape : phase 10 (déploiement, uniquement avec accord explicite).**

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

### Phase 10 — Déploiement (uniquement avec accord explicite)
- [ ] Création du dépôt **public** (interface web GitHub ou `gh`), push de `main`.
- [ ] Pages : « Deploy from a branch », `main`, dossier `/docs`.
- [ ] Checklist iPhone (§3).

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
│   └── icons.py          # icônes PNG avec Pillow
├── docs/                 # LE SITE servi par GitHub Pages (pas de la documentation)
│   ├── .nojekyll
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── sw.js
│   ├── css/app.css
│   ├── js/               # main.js, map.js, store.js, gps.js, ui.js, wakelock.js, io.js, debug.js, pwa.js, theme-init.js
│   ├── icons/
│   └── data/             # GÉNÉRÉ, commité : plan.json, addresses.json, version.json (ne pas lire)
└── tests/                # Playwright : *.spec.js (plan, pointage, gps, wakelock, sauvegarde, debug, hors-ligne),
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
                 "labels": [ { "x": 895.4, "y": 806.1, "a": -81 } ] } ],   // a : angle en degrés, SVG
  // addresses triées par rue, numéro, rep ; "bat" vaut null si aucun bâtiment n'est associé
  "addresses": [
    { "id": "01275_xxxx_00012", "s": 2, "n": 12, "rep": "", "side": "pair",
      "x": 123.4, "y": 456.7,              // coordonnées SVG (déjà relatives au cadre)
      "ld": "Sur l'Île", "cad": "01275000AI0458", "bat": "b42", "ctx": false }
  ]
}
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
  - `events` : `{dev, seq, t, tour, ids[], st, grp, undoOf?}`, clé `[dev, seq]`, `st` ∈ `"fait" | "a_repasser" | "a_faire"` ;
  - `tours` : `{id, name, createdAt, archived}` ;
  - `meta` : `deviceId`, compteur `seq`, version des données, préférences.
- **L'état courant est dérivé du journal** : pour chaque `id`, le dernier événement de la tournée active l'emporte, ordre `(t, dev, seq)` (départage déterministe entre appareils).
- **Groupes et annulation** : chaque action utilisateur a un `grp` unique. Une action groupée dont les états précédents diffèrent (ex. « Toute la rue faite » alors que certains étaient « à repasser ») est annulée par **plusieurs événements** (un par état précédent), tous avec `undoOf: <grp annulé>`. La pile d'annulation est dérivée du journal (dernières actions de l'appareil non annulées) : elle survit à une relance. **On n'efface jamais rien du journal.**
- `navigator.storage.persist()` au premier lancement ; résultat affiché dans le debug.
- **Export** : `{app: "neyron-tournees", schema: 1, exportedAt, deviceId, tours, events}`.
- **Import** : fusion avec dédoublonnage sur `(dev, seq)`, puis recalcul de l'état. Ce format permettra de fusionner plusieurs téléphones.
- **Export** (`io.js`) : fichier `neyron-tournees-export-AAAAMMJJ-HHMM.json` (motif ignoré par git), avec en plus `dataVersion`. Construit de façon **synchrone** jusqu'à `navigator.share` (la feuille de partage exige un geste récent : pas d'`await` avant). `meta.lastExportAt` est mémorisé (pour le futur rappel de sauvegarde).
- **Import = donnée non fiable** : `parseBackup()` vérifie `app`, `schema`, puis chaque événement champ par champ (types, `st` ∈ statuts, `seq` entier ≥ 1, longueurs ≤ 64-140 caractères, ≤ 2000 ids, ≤ 200 000 événements, fichier ≤ 20 Mo) ; les entrées invalides sont ignorées et comptées, les **champs inconnus retirés** ; affichage uniquement par `textContent`. Confirmation avant fusion (nombre d'événements, date, appareil source, entrées ignorées, adresses inconnues du plan). Rien n'est jamais supprimé.
- Les événements importés d'un autre appareil ne sont pas annulables (la pile d'annulation ne contient que les actions de l'appareil). Réimporter une sauvegarde de cet appareil relève `seq` au maximum importé (jamais de clé réutilisée).
- Le sélecteur de fichiers est ouvert par un `<label for>` (le plus fiable sur iOS) ; l'`input` est masqué visuellement (`.vh`), pas en `display: none`.
- Une tournée par défaut est créée automatiquement, avec l'id fixe **`default`** (identique sur tous les appareils, pour que la fusion d'exports retombe sur la même tournée) ; « Nouvelle tournée » attend la v0.2.
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
- **Encart** (en bas à gauche, à côté des contrôles) : ligne d'état (précision / recherche du signal / position ancienne / hors du plan) puis 3 lignes « adresse · distance · Fait ». Il ignore les rues masquées et garde les « à repasser » (badge). Il est masqué pendant que le panneau d'adresse est ouvert. Sa hauteur entre dans la marge basse de la carte (centrages) et décale la barre d'échelle (`--nearby-h`).
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
- `gh` est absent : dépôt créé via l'interface web (ou après installation de `gh`), **avec accord explicite**.
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
  - Parade : une origine dédiée (organisation GitHub gratuite → `<org>.github.io`, ou domaine personnalisé). **À décider avant le premier déploiement** (changer d'origine plus tard = stockage vide).
- **Dépôt public** : les commits portent le nom complet et l'e-mail de l'utilisateur. Passer à l'e-mail `noreply` de GitHub et réécrire l'auteur des commits (dépôt encore privé, réécriture sans conséquence) avant de le rendre public.
- **Cadrage (clickjacking)** : impossible à interdire par en-tête sur Pages. Impact faible : un site tiers qui encadre l'app ne peut rien lire (origine différente), au pire provoquer des taps.
- **Chaîne d'approvisionnement** : rien de tiers à l'exécution. Playwright et les libs Python ne tournent que sur le PC. Des données sources piégées ne peuvent pas injecter de script (`textContent`, `setAttribute('d')`). L'import piégé est testé.

---

## 10. Pièges connus

- **Pointer capture** : un `setPointerCapture` dans `pointerdown` redirige le `click` vers le `<svg>` et les numéros ne réagissent plus. Capturer seulement après 4 px de mouvement.
- **`hidden` et `all: unset`** : `all: unset` sur les boutons annule `hidden`. Ajouter `[hidden]{display:none!important}`.
- **Couleurs** sur 6 chiffres (`#888` mal interprété a déjà donné du bleu marine avec reportlab).
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
- **Animations dans les tests** : mesurer un zoom après un délai fixe est instable sous WebKit chargé. Attendre la fin de l'animation (`map._anim` nul, `k` modifié).
- **Safari et pincement de page** : iOS ignore `user-scalable=no` ; les `gesturestart/change` sont bloqués au niveau du document, et sur macOS le pincement trackpad (événements `gesture*` sans pointeur actif) zoome la carte.
- **v0.2 (PDF reportlab)** : le mode de rendu du texte (`Tr`) persiste → entourer les halos de `saveState()` / `restoreState()` ; exposants et indices Unicode non rendus.

---

## 11. Tests

- **Bureau** : `python -m http.server -d docs 8000`, http://localhost:8000 (contexte sécurisé : géolocalisation et SW fonctionnent).
- **Playwright** : `npx playwright test` (ou `npm test`), ~50 s, 8 workers. Projets `webkit-iphone` (iPhone 13) et `chromium` (bureau 1280 × 800). La config lance **son propre serveur** `tests/serve.py` sur **http://127.0.0.1:8100** (boucle locale, file d'attente de 256 connexions, §10), distinct du serveur de dev (8000). Chaque test part d'un contexte neuf (IndexedDB, caches, SW vides). Rapport : `npx playwright show-report` ; trace conservée en cas d'échec.
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
- Outils communs dans `tests/helpers.js` : `openApp`, `tapAddress` (position écran calculée par la carte, §10), identifiants BAN et positions GPS de référence, `trackErrors` (toute erreur JS ou `console.error` fait échouer le test).
- Vérifié le 19/10/2026 :
  - `--repeat-each=3` : 144/144, aucun test instable ;
  - des sabotages volontaires sont détectés : encart limité à 2 adresses, module retiré du précache.
- **Pipeline** : les assertions de comptage et de résidu font office de tests.
- **iPhone** : uniquement via l'URL GitHub Pages, après un push. Debug : `?debug=1` dans Safari ; **dans l'app installée, 5 taps rapides sur la ligne de version du menu ⋮** (son stockage est séparé de Safari et elle ne reçoit pas de paramètre d'URL). Réduire le panneau pour dégager la carte avant un appui long.

---

## 12. Roadmap après la v0.1

1. **v0.2 — Confort de tournée**
   - Nouvelle tournée avec archivage.
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

  Le dépôt `github.com/Thoxym/Tracking-Tourn-e` (privé, Pages inactif) a été créé et poussé par l'utilisateur. **Décisions en attente** : origine dédiée ou `thoxym.github.io` partagé avec deux autres sites ; e-mail `noreply` et réécriture des auteurs avant passage en public.
