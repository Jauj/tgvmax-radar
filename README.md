# 🚄 TGVmax Radar

Outil local & gratuit pour trouver les places **TGVmax** ouvertes à la réservation. Inspiré du principe de Trainquille, mais **sans compte, sans quota, sans pub et sans tracker** — et tout le code tourne dans ton navigateur.

## Fonctionnalités

- 🎯 **Depuis une gare** : toutes les destinations atteignables avec TGVmax à une date donnée.
- 🔄 **Vers une destination** : toutes les origines d'où on peut arriver.
- ✂️ **Itinéraires à correspondances** : si aucun direct n'est dispo, cherche automatiquement des chaînes de places TGVmax — **1 à 4 correspondances**, attente réglable par étape (5 min → 8 h), même journée, sans repasser deux fois par la même gare. Les meilleurs itinéraires sont listés par nombre de correspondances.
- 🗺️ Carte interactive (Leaflet + OpenStreetMap/CARTO).
- ⇄ **Échange départ / arrivée** : inverse le sens du trajet en un clic, dans tous les modes de recherche.
- 🌙 **Mode sombre** : bouton de bascule clair/sombre en haut à droite — préférence mémorisée, sinon suit le réglage du système (sans flash au chargement).
- 📈 **Suivi & historique des disponibilités** : chaque relevé mémorise le nombre de trains directs d'un tronçon pour **toutes les dates de voyage** de la fenêtre de réservation, et les vues retracent l'évolution jour après jour :
  - **📈 Courbes** — une courbe par date de voyage (repérer les places qui remontent) ou comparaison de plusieurs tronçons sur un même graphique ;
  - **🗓 Calendrier** — heatmap « relevés × dates de voyage » : on voit d'un coup d'œil les ouvertures (vert) et les épuisements (rouge) ;
  - **📋 Données** — tableau croisé, export CSV-ready (JSON), import, purge.
  - Fonctionne **sans aucun compte** : historique local (localStorage) + fusion automatique des relevés du dépôt. La sauvegarde Supabase reste optionnelle.
- 🤖 **Snapshot quotidien automatique** : une GitHub Action ([`.github/workflows/daily-snapshot.yml`](.github/workflows/daily-snapshot.yml)) relève chaque nuit à 6 h 45 la fenêtre complète pour chaque tronçon de [`data/watched.json`](data/watched.json), et versionne le résultat dans `data/history/` — consultable par tous, même sans visiter le site.
- ⚡ Une seule requête réseau par date (filtre `od_happy_card=OUI` fait côté API — plus léger que le site original).

## Source de données

[Dataset open data « tgvmax » de la SNCF](https://data.sncf.com) (licence ODbL), mis à jour chaque nuit. Fenêtre de réservation : ~31 jours. Les disponibilités sont **indicatives** et évoluent en temps réel — toujours vérifier sur [SNCF Connect](https://www.sncf-connect.com) avant de réserver.

Outil indépendant, **non affilié à la SNCF**. Ne vend aucun billet.

## Utiliser en local

Aucun build, aucun serveur requis (l'API SNCF autorise le CORS universel) :

- **Simple** : double-clique sur `index.html` → s'ouvre dans ton navigateur.
- **Recommandé (petit serveur local)** :
  ```bash
  cd tgvmax-app
  python -m http.server 8080
  # ou : npx serve .
  ```
  puis ouvre http://localhost:8080

## Déployer gratuitement sur GitHub Pages

### Méthode web (5 minutes)

1. Crée un compte [GitHub](https://github.com) si besoin.
2. Clique sur **+** (en haut à droite) → **New repository** → nom : `tgvmax-radar` → **Public** → Create.
3. Sur la page du repo : **Add file → Upload files** → glisse `index.html`, `style.css`, `app.js` (et ce README) → **Commit changes**.
4. Onglet **Settings → Pages** (menu de gauche) → « Build and deployment » → Source : **Deploy from a branch** → Branch : `main` / `(root)` → **Save**.
5. Attends ~1 minute → ton site est en ligne sur `https://<ton-pseudo>.github.io/tgvmax-radar/`

### Méthode ligne de commande (si `gh` CLI installé)

```bash
cd tgvmax-app
git init && git add . && git commit -m "TGVmax Radar"
gh repo create tgvmax-radar --public --source=. --push
gh api repos/{owner}/{repo}/pages -X POST -f "source[branch]=main" -f "source[path]=/"
```

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Page unique : 3 onglets de recherche + suivi + carte |
| `app.js` | Logique : API SNCF, recherches, carte, historique des disponibilités |
| `style.css` | Habillage (thème clair/sombre, heatmap, graphiques) |
| `data/watched.json` | Tronçons relevés automatiquement chaque nuit |
| `data/history/*.json` | Historique des relevés (un fichier par tronçon) |
| `scripts/daily-snapshot.mjs` | Robot du snapshot quotidien (GitHub Actions) |
| `.github/workflows/daily-snapshot.yml` | Planification du relevé nocturne |
| `supabase-config.js` / `supabase-setup.sql` | Sauvegarde en ligne **optionnelle** des instantanés |

## Ajouter un tronçon au snapshot automatique

1. Sur le site : onglet **📈 Suivi** → fais tes recherches/instantanés habituels.
2. Ouvre **⚙️ Snapshot quotidien automatique** → **📋 Préparer watched.json** : le fichier à jour est copié et GitHub s'ouvre sur la page d'ajout de fichier.
3. Colle, Commit — la nuit suivante, le relevé est pris en compte automatiquement.

## Crédits

- Données : [SNCF Open Data](https://data.sncf.com) — dataset `tgvmax`, licence [ODbL](https://opendatacommons.org/licenses/odbl/).
- Carte : [OpenStreetMap](https://www.openstreetmap.org) / CARTO, librairie [Leaflet](https://leafletjs.com).
- Géocodage de secours : [Nominatim](https://nominatim.openstreetmap.org).
