# photo-picker-poc

Outil isolé : extraction des photos Google Maps pour les salons coiffeurs, UI de
tri (grille + crop 1920×1080), et push automatique du hero choisi vers la BDD
d'outil-coiffure + recapture du screenshot landing.

## Isolation

- Tout le code de cet outil vit dans `photo-picker-poc/`.
- Sa propre BDD : `data/photo-picker.db` (séparée de `outil-coiffure/data/salons.db`).
- Le **seul** point de contact avec outil-coiffure côté code est **1 ligne ajoutée**
  dans `outil-coiffure/server.js` : `app.use('/hero-images', express.static(HERO_IMAGES_DIR, ...))`
- Pour rollback complet : `rm -rf photo-picker-poc/` + retirer cette ligne (le reste
  de outil-coiffure n'a rien à désinstaller).

## Stack

- Puppeteer-extra + stealth (scrape Google Maps + recapture screenshot)
- better-sqlite3 (DB locale + écriture overrides_json dans salons.db au sync)
- Sharp (crop + resize JPEG)
- Express + express-session + Cropper.js (UI)

## Workflow utilisateur

1. **Import CSV** : `node scripts/import-csv.mjs <fichier.csv>` → remplit la
   DB locale avec nom/ville/google_id/lien Maps.
2. **Scrape batch** : `node scripts/run-batch.mjs --source ain --concurrency 4`
   → visite chaque salon sur Google Maps, extrait jusqu'à ~10 photos.
3. **UI de tri** : `node --env-file=.env server.js`, login sur `http://localhost:4000`,
   pour chaque salon afficher la grille de photos, cliquer une photo → modale crop
   en ratio 16:9 (centré par défaut, ajustable manuellement) → confirmation.
4. **Sync auto** au moment du clic "Valider" :
   - Téléchargement de l'image source en résolution maximale
   - Crop selon le rectangle choisi → 1920×1080 JPEG q85
   - Écriture sur `HERO_IMAGES_DIR/{slug}.jpg`
   - UPDATE `salons.overrides_json.hero.backgroundImage = "/hero-images/{slug}.jpg"`
   - Recapture du screenshot landing en visitant `SITE_PUBLIC_URL/preview/{slug}`
     puis écrasement de `SCREENSHOTS_DIR/{slug}.jpg`
5. **Skip** : si aucune photo ne convient → `status='skipped'` (passe au suivant).

## Mise en route (local)

```bash
cd photo-picker-poc
npm install
cp .env.example .env
# Édite .env : PICKER_PASSWORD, SESSION_SECRET, chemins outil-coiffure

# Import d'un département test
node scripts/import-csv.mjs ../exports-scrap.io/coiffeur-france-auvergne-rhone-alpes-ain.csv

# Scrape (~15 min sur 100 salons avec 4 threads)
node scripts/run-batch.mjs --source ain --concurrency 4 --delay 1500

# UI
node --env-file=.env server.js
# → http://localhost:4000
```

## Déploiement Coolify (prod)

L'app doit être déployée **en plus** de outil-coiffure, dans le même projet
Coolify, avec le **même volume persistant** monté à `/data` pour partager
`salons.db`, `screenshots/`, `hero-images/`.

1. Dans Coolify, ajoute un nouveau service "Dockerfile" pointant sur ce dossier
2. Variables d'environnement à set :
   - `PICKER_PASSWORD=...` (mot de passe partagé pour toi + tes amis)
   - `SESSION_SECRET=...` (`openssl rand -hex 32`)
   - `SITE_PUBLIC_URL=https://monsitehq.com`
   - `NODE_ENV=production`
3. Volume mount : volume partagé avec outil-coiffure, mount path `/data`
4. Sous-domaine : ex. `picker.monsitehq.com` (auto-SSL Coolify)
5. Outil-coiffure doit avoir `HERO_IMAGES_DIR=/data/hero-images` dans ses env
   (sinon il fallbacke à `./data/hero-images` ce qui marche en local aussi)

## Critères de succès du POC

- ✅ 5/5 salons sans erreur en POC initial (cf. `data/poc-results.json`)
- ✅ Médiane 7 photos/salon (max 10)
- ✅ URLs hero `w1280-h800` servies par Google CDN (200 image/jpeg validés)
- ✅ Format URL stable même si Google change le DOM (regex robuste sur 3 namespaces)
- ⏳ Validation 100 % d'un département (Ain, 105 salons) — en cours

## Rollback

```bash
# Si l'outil ne convient pas :
rm -rf photo-picker-poc/

# Et dans outil-coiffure/server.js, retirer :
#   const HERO_IMAGES_DIR = ...
#   app.use('/hero-images', express.static(HERO_IMAGES_DIR, ...));

# Les overrides_json déjà écrits dans salons.db peuvent être nettoyés ainsi :
sqlite3 outil-coiffure/data/salons.db \
  "UPDATE salons SET overrides_json = json_remove(overrides_json, '$.hero.backgroundImage', '$.hero.backgroundImageSource', '$.hero.backgroundImageUpdatedAt') WHERE json_extract(overrides_json, '$.hero.backgroundImageSource') = 'photo-picker';"
```
