# Soumission au store officiel Umbrel — `bolt12-server`

Ce dossier contient l'app prête à être **copiée dans un fork de
[`getumbrel/umbrel-apps`](https://github.com/getumbrel/umbrel-apps)**.

```
bolt12-server/
├── umbrel-app.yml      # manifeste (conventions officielles, id sans préfixe)
├── docker-compose.yml  # images épinglées par digest multi-arch
└── icon.svg            # (pratique ; l'icône va aussi dans le repo gallery)
```

> ⚠️ **Avant d'investir dans le PR**, lis la section « Risque » en bas : l'étape
> manuelle de flags LND peut être refusée par la review officielle. Ouvre d'abord
> une *issue* chez `getumbrel/umbrel-apps` pour valider la faisabilité.

## Étapes

1. **Fork** `getumbrel/umbrel-apps`, crée une branche `add-bolt12-server`.
2. Copie le dossier `bolt12-server/` (umbrel-app.yml + docker-compose.yml) à la
   racine du fork. **Ne mets PAS** `umbrel-app-store.yml` (réservé aux stores
   communautaires) ni le dossier `silex-bolt12-server/`.
3. **Teste sur umbrelOS** (obligatoire avant le PR) :
   - Env de dev : `git clone getumbrel/umbrel`, `npm run dev`, copie l'app,
     installe-la, vérifie la persistance (redémarre l'app, l'état doit tenir).
   - + sur une machine réelle (RPi 5, x86, ou VM) via `rsync`.
4. **Icône & galerie** (fournies dans le PR, ajoutées par les mainteneurs au repo
   `getumbrel/umbrel-apps-gallery`) :
   - Icône : `icon.svg` **256×256, sans coins arrondis** (déjà ici).
   - Galerie : **3 à 5 PNG 1440×900**. Tes captures actuelles sont en SVG
     (`silex-bolt12-server/screenshots/*.svg`) → **à convertir/recréer en PNG**.
   - `gallery: []` reste vide dans le manifeste pour une 1re soumission.
5. **Ouvre le PR** sur `getumbrel/umbrel-apps` avec : nom de l'app, l'icône SVG,
   les 3-5 PNG, et la checklist de tests cochée (RPi / Umbrel Home / VM Linux).
6. Une fois le PR ouvert, renseigne `submission:` dans `umbrel-app.yml` avec
   l'URL du PR.

## Images (déjà épinglées par digest)

| Service | Image |
|---|---|
| web  | `ghcr.io/silexperience210/bolt12-server@sha256:4569c33791c39238e90e96585cdc1a9b3d5fee3e7c49fdd6065fee628dabfaae` (= v2.2.4) |
| lndk | `ghcr.io/silexperience210/lndk@sha256:efb58493b9fbf406c0f1fd683e17ec45078986c8e839a79341084a3367bc2004` (= v0.3.0) |

**À chaque nouvelle release**, mets à jour le digest `web`. Pour récupérer le
digest multi-arch d'un tag :
```bash
docker buildx imagetools inspect ghcr.io/silexperience210/bolt12-server:<tag> --format '{{.Manifest.Digest}}'
# ou via le log du workflow docker.yml : la ligne "pushing manifest for ...:<tag>@sha256:..."
```

## Différences vs ton store communautaire (`silex-bolt12-server/`)

| | Communautaire (actuel) | Officiel (ce dossier) |
|---|---|---|
| `id` | `silex-bolt12-server` | `bolt12-server` |
| `umbrel-app-store.yml` | requis | **interdit** |
| Image | tag `:2.2.4` | **digest** `@sha256:…` |
| `icon`/`gallery` dans le yml | URLs | pas d'`icon:` ; `gallery: []` |
| `releaseNotes` | rempli | vide (1re soumission) |
| Review | aucune | PR + mainteneurs Umbrel |

## ⚠️ Risque d'acceptation

BOLT12 exige des flags protocole (`protocol.custom-message=513`, etc.) que le
Lightning d'Umbrel ne pose pas par défaut → l'app nécessite une reconfiguration
**manuelle (SSH)** d'une autre app, hors sandbox. Les apps officielles
dépendant de `lightning` utilisent LND tel quel. La review officielle peut
**refuser ou demander une refonte**. La voie sûre reste ton **store
communautaire** (déjà fonctionnel : `https://github.com/Silexperience210/bolt12-server`).
