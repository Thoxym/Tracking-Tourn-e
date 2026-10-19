# CLAUDE.md — Tournées de Neyron (PWA iPhone, GitHub Pages)

Projet : une web app installable sur iPhone pour faire des **tournées de tous les numéros de certaines rues** de Neyron (Ain, 01700, code INSEE **01275**). Elle affiche un plan cadastral avec le numéro de chaque maison. Elle permet de **pointer les numéros faits**, un par un ou une rue entière d'un coup, et elle montre **la position GPS** pour savoir où on en est.

Un premier projet existe déjà : un plan interactif publié en artifact claude.ai, plus des PDF A4 par rue. Il a fixé les données, les traitements et les pièges décrits ici. On repart sur une **PWA hors ligne hébergée en statique sur GitHub Pages**.

L'utilisateur est ingénieur réseau et sécurité, à l'aise techniquement. Interface et échanges en **français** ; identifiants de code en anglais.

---

## 1. Priorité immédiate : prototype v0.1 testable sur iPhone demain

Il faut un prototype qui marche sur le terrain, pas une version complète. Tout ce qui n'est pas listé ci-dessous attend la v0.2.

### Dans le périmètre v0.1
1. **Pipeline Python.** À partir des fichiers sources, il génère les données de l'app (`docs/data/`) : plan, adresses avec identifiant stable, coefficients GPS → Lambert-93.
2. **PWA installable.** Manifest, icônes et service worker. Elle s'ouvre **en mode avion** une fois installée sur l'écran d'accueil.
3. **Plan.**
   - Parcelles, bâtiments et numéros en SVG métrique.
   - Zoom et déplacement (pincement, glisser, molette, boutons).
   - Légende par rue, avec sélection et zoom sur la rue.
   - Thèmes clair et sombre.
4. **Pointage.**
   - Un tap sur un numéro ouvre un panneau en bas : **Fait / À repasser / Remettre à faire**.
   - Dans la légende, une barre de progression par rue (« 12/18 ») et une action « **Toute la rue faite** », avec confirmation.
   - Un bouton **Annuler** pour la dernière action.
   - Les numéros faits passent en vert ou s'estompent, ceux à repasser passent en orange.
   - La progression persiste après fermeture et relance.
5. **GPS.**
   - Point de position et cercle de précision.
   - Bouton « localiser » puis « suivre ».
   - Un encart avec les **3 adresses non faites les plus proches**, chacune avec un bouton « Fait ».
6. **Écran allumé.** Bouton Wake Lock, réacquis au retour au premier plan.
7. **Sauvegarde.** Export et import JSON de la progression, via la feuille de partage iOS, avec un téléchargement en repli.
8. **Panneau debug** (`?debug=1`).
   - Il affiche la précision GPS, l'état du Wake Lock, le résultat de `navigator.storage.persist()`, la version de l'app et celle des données.
   - Un appui long sur la carte simule une position, pour tester sans sortir.

### Hors périmètre v0.1 (voir roadmap)
- Export PDF.
- Ordre de tournée et guidage.
- Enregistrement de trace et export GPX.
- Validation automatique par GPS.
- Statistiques.
- Synchro à plusieurs.
- Police Barlow : utiliser la pile système (`-apple-system, system-ui, …`) en v0.1.

### Ordre de travail recommandé
1. Vérifier les fichiers sources fournis (§3), les déplacer dans `sources/` et compléter `.gitignore`.
2. Pipeline : filtrage commune → géométries → association adresse-bâtiment → tracés des rues → export JSON.
   - Les tracés de rues peuvent être simplifiés si le temps manque (§6.4).
3. App : rendu du plan, puis pointage et stockage, puis GPS, puis Wake Lock, puis export/import, puis panneau debug.
4. Service worker et manifest, puis test hors ligne.
5. Tests Playwright (§9), puis préparation du déploiement.
   - Ne **pas** créer le dépôt GitHub ni pousser sans accord explicite de l'utilisateur.

### Définition de « terminé » pour la v0.1
- `python3 pipeline/build.py` regénère `docs/data/` sans erreur.
- `python3 -m http.server -d docs 8000`, puis http://localhost:8000 : tout fonctionne dans un navigateur de bureau.
- Les tests Playwright WebKit (profil iPhone) passent.
- Sur iPhone, depuis l'URL GitHub Pages :
  - installation sur l'écran d'accueil ;
  - relance en mode avion ;
  - pointage d'un numéro et de toute une rue ;
  - fermeture puis relance de l'app : la progression est toujours là ;
  - position GPS visible avec sa précision.

---

## 2. Déploiement : GitHub Pages (option retenue)

### Mise en place
- **Méthode la plus simple :** Pages en mode « Deploy from a branch », branche `main`, dossier **`/docs`**.
  - `docs/` contient donc le **site** et non de la documentation.
  - Ajouter un fichier vide `docs/.nojekyll` pour désactiver Jekyll.
  - Aucun workflow GitHub Actions n'est nécessaire.
- Le pipeline tourne **en local** : les sources ne sont pas dans le dépôt. Les données générées dans `docs/data/` (quelques Mo) **sont commitées**, car Pages doit les servir.

### Conséquences de l'hébergement
- **Dépôt public.** Pages est gratuit seulement avec un dépôt public. Le code et le plan sont donc publics, ce qui est acceptable : ce sont des données ouvertes (BAN, cadastre Etalab).
  - Ne jamais committer de progression, d'export JSON, de trace GPS ni de note sur les habitants.
  - Le `.gitignore` doit couvrir `exports/`, `*.gpx`, `progress*.json` et `sources/`.
- **Sous-chemin.** Le site est servi sous `https://<user>.github.io/<repo>/`.
  - Toutes les URL doivent être **relatives**.
  - Dans le manifest : `start_url: "./"` et `scope: "./"`.
  - Le service worker est enregistré avec `register('./sw.js', {scope: './'})`.
  - Aucun chemin ne commence par `/`.
- **Origine partagée.** `<user>.github.io` est commune à tous les sites Pages de l'utilisateur.
  - Préfixer le nom IndexedDB (`neyron-tournees`) et les noms de cache (`neyron-tournees-<version>`).
  - Pas de clés `localStorage` génériques.
  - Un domaine personnalisé isolerait l'origine ; c'est possible plus tard. Attention : changer d'origine = stockage vide, d'où l'export/import JSON.
- **Sécurité.** Le service worker se met à jour automatiquement dès que le téléphone joint le site. L'intégrité de l'app repose donc sur le compte GitHub de l'utilisateur.
  - Côté utilisateur : MFA et clé matérielle sur le compte (c'est son affaire).
  - Côté code :
    - aucun script tiers chargé à l'exécution : tout est servi depuis le dépôt ;
    - CSP en balise meta (Pages ne permet pas d'en-têtes) :
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self'; connect-src 'self'` ;
    - aucun script inline.
- **Cache HTTP.** Pages renvoie `Cache-Control: max-age=600`.
  - Pour le précache du service worker, faire les requêtes avec `{cache: 'reload'}`.
  - Versionner le cache avec le hash des données et du code.
- **Délai.** Un push sur `main` est en ligne en 1 à 2 minutes environ. C'est le moyen de tester sur l'iPhone, qui exige du HTTPS : pas besoin de certificat local.

---

## 3. Données sources

L'utilisateur va **déposer à la racine du projet les fichiers complets (adresses et cadastre) de Neyron**. Au premier lancement, il faut :
1. lister ce qui a été fourni ;
2. le déplacer dans `sources/` ;
3. vérifier que `sources/` et les motifs `*.csv.gz`, `*.json.gz`, `*.csv`, `*.json` à la racine sont dans `.gitignore`.

**Ne jamais lire ces fichiers en entier** (le fichier des parcelles du département fait 815 Mo décompressé) : filtrer avec `zcat | awk/grep`. Si un fichier d'un autre type est fourni (plan PDF, shapefile, etc.), demander à l'utilisateur ce qu'il faut en faire avant de l'intégrer.

### Fichiers attendus
Les sources sont sous Licence Ouverte Etalab 2.0. Le pipeline doit accepter la version département **ou** commune.

| Contenu | Nom département | Nom commune |
|---|---|---|
| Adresses BAN, CSV `;` | `adresses-01.csv.gz` | `adresses-01275.csv(.gz)` ou CSV déjà filtré |
| Bâtiments, GeoJSON | `cadastre-01-batiments.json.gz` | `cadastre-01275-batiments.json.gz` |
| Parcelles, GeoJSON | `cadastre-01-parcelles.json.gz` | `cadastre-01275-parcelles.json.gz` |

Les noms peuvent varier légèrement (`_csv.gz`, `_json.gz`) : détecter par motif.

### Filtrage sur la commune
Les GeoJSON du cadastre contiennent **une feature par ligne**.
```bash
zcat sources/adresses-01*.gz | awk -F';' 'NR==1||$7=="01275"' > work/neyron.csv            # 959 adresses
zcat sources/cadastre-01*-batiments*.gz | grep '"commune":"01275"' > work/bat.jsonl      # ~2151
zcat sources/cadastre-01*-parcelles*.gz | grep '"commune":"01275"' > work/par.jsonl     # ~2786
```
Pour lire une ligne : `json.loads(line.strip().rstrip(','))`. Les géométries du cadastre sont en WGS84.

### Colonnes BAN utiles
`id;id_fantoir;numero;rep;nom_voie;code_postal;code_insee;nom_commune;…;x;y;lon;lat;type_position;alias;nom_ld;libelle_acheminement;nom_afnor;source_position;source_nom_voie;certification_commune;cad_parcelles`
- **`id`** est la clé d'interopérabilité, par exemple `01275_xxxx_00012`. C'est **l'identifiant stable de l'adresse dans toute l'app** : il sert de clé pour la progression.
- `x` et `y` sont en Lambert-93 (EPSG:2154), en mètres ; `lon` et `lat` sont en WGS84.
- `rep` vaut par exemple `bis`, `ter`, `a`, `b` ou `c`.
- `type_position` vaut `entrée` : le point est à l'entrée.
- `nom_ld` est le lieu-dit.
- `cad_parcelles` donne la ou les parcelles, séparées par `|`, par exemple `01275000AI0458`.

---

## 4. Voies retenues

L'index sert d'identifiant de rue et de couleur. Les couleurs sont données en clair / sombre.

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
| 8 | Route de Genève, **n° 58 à 193 seulement** | 105 | #283a52 / #c9d6e8 |
| 9 | Montée des Écoles | 9 | #5f7d0e / #a9cc4a |

Il y a **229 numéros à pointer** au total.

Notes sur ces voies :
- « Impasse de la Gare » n'existe pas dans la BAN. Ses maisons sont probablement numérotées sur la Rue de la Gare.
- **Route de Genève.** La numérotation monte d'est en ouest, du n° 3 au n° 193. Seul le tronçon 58 → 193 fait partie de la tournée.
  - Les numéros inférieurs à 58 qui tombent dans le cadre sont affichés **en gris**, comme repères, et ne sont **pas pointables**. Dans les données, ils ont `ctx: true`.
  - Cette interprétation reste à confirmer par l'utilisateur.
- Le n° 73 bis de la Route de Genève est environ 250 m au nord de la route, au bout d'un accès privé. C'est normal.
- Pour ajouter une rue : la mettre dans `pipeline/config.py` (`STREETS` et `COLORS`), relancer le pipeline. Les couleurs des rues sont lues depuis les données : ne pas les dupliquer dans le CSS.

---

## 5. Structure du dépôt

```
neyron-tournees/
├── CLAUDE.md
├── .gitignore            # sources/, work/, exports/, *.gpx, progress*.json, gros fichiers à la racine
├── sources/              # fichiers BAN + cadastre (jamais commités, jamais lus en entier)
├── work/                 # intermédiaires du pipeline (ignoré)
├── pipeline/
│   ├── config.py         # STREETS, COLORS, filtres (Route de Genève ≥ 58), marges
│   ├── geo.py            # filtrage, projection, emprise, association adresse-bâtiment, tracés
│   ├── build.py          # point d'entrée : génère docs/data/*, la version et la liste de précache
│   └── icons.py          # icônes PNG (180, 192, 512) générées avec Pillow
├── docs/                 # LE SITE servi par GitHub Pages
│   ├── .nojekyll
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── sw.js
│   ├── css/app.css
│   ├── js/               # modules ES : main.js, map.js, store.js, gps.js, ui.js, wakelock.js, io.js, debug.js
│   ├── icons/
│   └── data/             # GÉNÉRÉ : plan.json, addresses.json, version.json (à ne pas lire)
└── tests/                # Playwright
```

Règle pour Claude Code : **ne jamais lire `sources/`, `work/` ni `docs/data/`**, ce sont des fichiers générés ou volumineux. Pour comprendre le format des données, lire le schéma (§6.6) ou un extrait (`head -c 2000`).

Pas de framework, pas de bundler, pas de dépendance JS à l'exécution. Dépendances Python : `pip install shapely pyproj scipy numpy pandas pillow` (ajouter `--break-system-packages` si nécessaire).

---

## 6. Pipeline Python

### 6.1 Projection et emprise
- Toutes les géométries sont projetées en Lambert-93 :
  ```python
  T = Transformer.from_crs(4326, 2154, always_xy=True)
  shapely.transform(g, lambda c: np.column_stack(T.transform(c[:,0], c[:,1])))
  ```
- Emprise : la boîte englobante des adresses de la tournée, sans la Route de Genève avant le 58, plus une marge de 110 m. Elle fait environ 1570 × 1678 m.
- On garde les parcelles et les bâtiments qui intersectent l'emprise élargie de 150 m, soit environ 1870 parcelles et 1500 bâtiments.

### 6.2 Associer une adresse à un bâtiment
1. Prendre la ou les parcelles de l'adresse (`cad_parcelles`).
2. Garder les bâtiments dont plus de 40 % de la surface est dans ces parcelles, avec un STRtree.
3. Retenir le bâtiment le plus proche du point d'adresse.
4. À défaut, prendre le bâtiment le plus proche à moins de 6 m, dans un rayon de 25 m.

Résultat attendu : environ 262 adresses (avec celles de contexte), dont environ 208 associées à un bâtiment. Le numéro est affiché **au point BAN**, pas au centroïde du bâtiment.

### 6.3 Nouveautés pour la PWA
- **Identifiant** : l'`id` BAN de chaque adresse.
- **Tri naturel** : par numéro, puis par `rep` (`""` < `bis` < `ter` < `quater` < `a` < `b` < `c`).
- **Côté** : `side` vaut `"pair"` ou `"impair"` selon la parité du numéro.
- **Transformation GPS → Lambert-93.**
  - Ajuster par moindres carrés une **transformation affine** sur les **959 adresses de Neyron**, qui ont à la fois `lon/lat` et `x/y` : `x = a·lon + b·lat + c`, `y = d·lon + e·lat + f`.
  - Écrire les 6 coefficients et le résidu maximal dans `addresses.json`.
  - Le résidu attendu est de l'ordre du décimètre. **Si le résidu maximal dépasse 0,5 m, faire échouer le build.**
  - Cela évite d'embarquer proj4js.
- **Coordonnées SVG** : `sx = x - x0` et `sy = y1 - y`, soit 1 unité = 1 mètre, avec le nord en haut.
- **Version** : le hash court du contenu des données, écrit dans `version.json` et injecté dans `sw.js` (constante `VERSION` remplacée au build) avec la liste des fichiers à précacher.

### 6.4 Tracés des rues
On n'a pas de filaire de voirie ; le tracé est approché par le domaine non cadastré.
```python
gaps = emprise.difference(unary_union([p.buffer(0.3) for p in parcelles]))
# pour chaque rue :
mst  = minimum_spanning_tree(cdist(pts, pts))                 # arbre couvrant des points d'adresse
corr = MultiLineString(aretes_mst).buffer(28) | unary_union([Point(p).buffer(30) for p in pts])
trace = gaps & corr   # garder les morceaux > 40 m² à moins de 22 m d'une adresse
if trace.area < 150: trace = trace | MultiLineString(aretes_mst).buffer(3)   # voies privées cadastrées
trace = trace.simplify(0.5)
```
Si le temps manque pour la v0.1, se contenter de `MultiLineString(aretes_mst).buffer(4)`. Limite connue : aux carrefours, le tracé peut déborder de quelques mètres sur la rue voisine.

### 6.5 Sorties
- Les géométries sont écrites en paths SVG, avec des coordonnées arrondies au décimètre.
- Les bâtiments **sans** adresse de la tournée sont fusionnés en un seul path.

### 6.6 Schéma des données (`docs/data/`)
```jsonc
// addresses.json
{
  "version": "a1b2c3d",
  "frame": { "x0": 0, "y1": 0, "W": 1570, "H": 1678 },     // Lambert-93, mètres
  "affine": { "x": [a, b, c], "y": [d, e, f], "maxResidual_m": 0.08 },
  "streets": [ { "i": 0, "name": "Montée Neuve", "colors": ["#1d5fd1", "#6ea2ff"], "count": 58 } ],
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

---

## 7. Application (PWA)

### 7.1 Rendu du plan
- SVG inline avec des coordonnées en mètres. Le zoom et le déplacement passent par le `viewBox`.
- Couches, de bas en haut :
  1. parcelles (trait fin gris) ;
  2. tracés de rues (couleur de la rue à 28 %) ;
  3. bâtiments (gris clair ; ceux d'une adresse de la tournée prennent la couleur de la rue à 35 %, ou la couleur de leur statut) ;
  4. noms de rues ;
  5. numéros ;
  6. calque GPS (cercle de précision, point).
- À chaque rendu, recalculer les tailles pour qu'elles restent constantes à l'écran : `fontSize = clamp(13/k, 2.2, 14)`, où `k` est le nombre de pixels par mètre. Faire de même pour les halos et les traits.
- Barre d'échelle dynamique.
- **Tap sur la carte** : chercher le numéro pointable le plus proche, à 22 px maximum.
- **Légende** :
  - case de couleur : afficher ou masquer la rue ;
  - nom : sélectionner la rue (surbrillance, reste atténué, zoom avec un cadre d'au moins 220 m qui ne passe pas sous la légende) ;
  - progression de la rue et bouton « Toute la rue faite ».
- La légende est repliable, et repliée par défaut sur mobile.

### 7.2 Stockage (`store.js`)
- IndexedDB, base **`neyron-tournees`**, avec trois stores :
  - `events` : `{seq, t, tour, ids[], st, dev}`, avec `st` ∈ `"fait" | "a_repasser" | "a_faire"` ;
  - `tours` : `{id, name, createdAt, archived}` ;
  - `meta` : `deviceId`, version des données, préférences.
- **L'état courant est dérivé du journal.** Pour chaque `id`, le dernier événement de la tournée active (par `t`) l'emporte.
- « Annuler » ajoute un événement qui rétablit l'état précédent des `ids` concernés. On n'efface jamais rien du journal.
- Au premier lancement, appeler `navigator.storage.persist()` et afficher le résultat dans le panneau debug.
- **Export** : `{app: "neyron-tournees", schema: 1, exportedAt, deviceId, tours, events}`.
- **Import** : fusion avec dédoublonnage sur `(dev, seq)`, puis recalcul de l'état. Ce format permettra plus tard de fusionner les données de plusieurs téléphones.
- Une tournée par défaut est créée automatiquement. « Nouvelle tournée » (archivage de la précédente) peut attendre la v0.2.

### 7.3 GPS (`gps.js`)
- `watchPosition` avec `{enableHighAccuracy: true, maximumAge: 0, timeout: 15000}`. Conversion en coordonnées SVG avec les coefficients affines, puis soustraction de `x0` et `y1`.
- Le rayon du cercle de précision vaut `coords.accuracy`, directement en mètres.
- Couleur du point selon la précision : vert ≤ 10 m, orange ≤ 30 m, rouge au-delà.
- Si la position est hors du cadre, afficher « Hors du plan (x km) ».
- Mode **suivre** : recentrer à chaque position. Il se désactive dès que l'utilisateur déplace la carte à la main.
- **Encart des plus proches** : les 3 adresses non faites les plus proches. Le calcul se fait en force brute, ce qui suffit pour 229 points. Chaque adresse affiche sa distance et un bouton « Fait ».
- Sur `visibilitychange` (retour au premier plan) : relancer `watchPosition` si aucune position n'est arrivée depuis plus de 10 s.
- Le GPS ne marche **pas** en arrière-plan sur iOS : l'interface doit le rappeler, avec un conseil sur l'écran allumé.

### 7.4 Wake Lock (`wakelock.js`)
- `navigator.wakeLock.request('screen')` sur action de l'utilisateur (bouton).
- Le verrou est relâché automatiquement quand la page est masquée : le redemander sur `visibilitychange` si le bouton est actif.
- Si l'API est absente ou refusée, afficher : « Réglez Verrouillage auto sur Jamais pendant la tournée ».

### 7.5 Service worker (`sw.js`)
- Précache de toute l'app et des données à l'installation, avec `{cache: 'reload'}`. Cache nommé `neyron-tournees-<VERSION>`.
- Stratégie **cache d'abord**, sans aucun appel réseau bloquant.
- Supprimer les anciens caches à l'activation.
- Mise à jour :
  - une nouvelle version détectée affiche le bandeau « Nouvelle version disponible — Recharger » ;
  - un clic envoie `postMessage({type: 'SKIP_WAITING'})`, puis la page se recharge sur `controllerchange`.

### 7.6 Spécificités iOS
- `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`.
- Utiliser `env(safe-area-inset-*)` et `100dvh`.
- Balises `apple-touch-icon` (180 px), `apple-mobile-web-app-status-bar-style` et `theme-color` (clair et sombre).
- Manifest avec `display: "standalone"`.
- `touch-action: none` sur la carte. Empêcher le zoom par double tap et le rebond (`overscroll-behavior: none`).
- Pour l'export, utiliser `navigator.share({files: [...]})` si `navigator.canShare` l'accepte, avec en repli un lien `download` sur un blob. Pour l'import : `<input type="file" accept="application/json">`.
- La web app installée a un stockage **séparé de Safari**. La progression saisie dans Safari n'apparaît pas dans l'app installée.
- Thème clair et sombre via des tokens CSS sur `:root`, avec `prefers-color-scheme` et `data-theme`.

---

## 8. Pièges connus (déjà rencontrés)

- **Pointer capture.** Un `setPointerCapture` dans `pointerdown` redirige le `click` vers le `<svg>`, et les numéros ne réagissent plus. Ne capturer qu'une fois que le pointeur a bougé de plus de 4 px.
- **`hidden` et `all: unset`.** `all: unset` sur les boutons annule l'attribut `hidden`. Ajouter `[hidden]{display:none!important}`.
- **Couleurs.** Toujours écrire les couleurs sur 6 chiffres : `#888` mal interprété a déjà produit du bleu marine avec reportlab.
- **Pas de serveur LAN.** Le service worker ne doit jamais attendre le réseau pour servir l'app.
- **Chemins.** Tout chemin absolu (`/js/…`) casse sur GitHub Pages à cause du sous-chemin `/<repo>/`.
- **Pour la v0.2 (PDF avec reportlab) :**
  - le mode de rendu du texte (`Tr`) persiste : entourer les halos de `saveState()` / `restoreState()` ;
  - les exposants et indices Unicode ne sont pas rendus.

---

## 9. Tests

- **En local sur le bureau** : `python3 -m http.server -d docs 8000`, puis http://localhost:8000. `localhost` est un contexte sécurisé, donc la géolocalisation et le service worker fonctionnent.
- **Playwright** avec le moteur WebKit et un profil iPhone, géolocalisation simulée (`context.setGeolocation`, `permissions: ['geolocation']`). Cas à couvrir :
  - chargement du plan ;
  - tap sur un numéro, puis Fait : l'état persiste après rechargement ;
  - « Toute la rue faite », puis Annuler ;
  - position simulée sur la Rue de la Gare : l'encart propose les bons numéros ;
  - export puis import : état identique ;
  - hors ligne (`context.setOffline(true)`) après une première visite : l'app se charge.
- **Sur iPhone** : uniquement via l'URL GitHub Pages, après un push. Se servir du panneau `?debug=1`.

---

## 10. Roadmap après la v0.1

1. **v0.2 — Confort de tournée.**
   - Nouvelle tournée avec archivage.
   - Actions groupées par côté (pairs ou impairs) et par tronçon (Route de Genève : 105 numéros).
   - Filtre « reste à faire ».
   - Export PDF A4 par rue, en reprenant la logique reportlab de l'ancien projet (échelle entre 1:2000 et 1:2500, découpage selon l'axe principal, vue d'ensemble). Les PDF sont servis comme fichiers et passent par la feuille de partage.
   - Police Barlow Semi Condensed hébergée dans l'app.
2. **v0.3 — Guidage.**
   - Ordre de passage dans chaque rue : pairs puis impairs, ou zigzag dans les petites rues ; un côté puis l'autre sur la Route de Genève.
   - Ordre des rues choisi à la main.
   - Flèche et distance vers la prochaine adresse.
   - Suggestion automatique en option, désactivée par défaut, avec des seuils à calibrer sur le terrain (par exemple précision ≤ 10 m, distance ≤ 6 m, 8 s sur place). Elle s'affiche dans un message qu'on peut annuler, au lieu de pointer sans prévenir.
   - Mode simulation `?sim=trace.gpx`.
3. **v0.4 — Trace et bilan.**
   - Enregistrement filtré de la trace (précision, distance minimale), affichage et export GPX.
   - Statistiques : temps, distance, avancement par rue.
   - Liste imprimable des adresses « à repasser ».
4. **Plus tard, si besoin.**
   - Synchro à plusieurs : d'abord par fusion d'exports JSON (déjà permise par le format), puis éventuellement en temps réel. Cela demanderait un backend, par exemple Cloudflare Workers + D1 derrière Access, à valider avec l'utilisateur.
   - Vrais axes de voies (OSM ou BD TOPO) à la place des tracés approchés.

### Garde-fous
- Si on stocke plus que fait / pas fait (absent, refus, notes), ce sont des données sur des foyers identifiables, soumises au RGPD.
- Une liste d'« absents » horodatés équivaut à une liste de maisons vides. Ces données restent **sur l'appareil**, ne sont jamais commitées, et ne partent jamais vers un serveur sans décision explicite de l'utilisateur.
