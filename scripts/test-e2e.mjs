// Test end-to-end LOCAL du pipeline complet :
// 1. Crée une fausse outil-coiffure salons.db (data/test-outil-coiffure.db) avec
//    le schéma minimum + insère 5 salons venant de photo-picker.db (matching par google_id).
// 2. Setup les dossiers test-hero-images/ et test-screenshots/.
// 3. Lance un appel direct à syncSalon() depuis le code (pas via HTTP) pour le 1er salon
//    avec un crop par défaut (centré).
// 4. Vérifie :
//    - Fichier hero-images/{slug}.jpg créé (1920×1080)
//    - overrides_json mis à jour dans la DB
//    - Tentative de recapture screenshot (peut échouer si monsitehq.com/preview/{slug}
//      n'existe pas — on log l'erreur sans bloquer).
//
// Lancement :   node --env-file=.env.test scripts/test-e2e.mjs
// Reset :       supprime data/test-* avant relance

import Database from 'better-sqlite3';
import { mkdirSync, existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

const TEST_DIR = resolve('./data');
const FAKE_OUTIL_DB_PATH = join(TEST_DIR, 'test-outil-coiffure.db');
const FAKE_HERO_DIR = join(TEST_DIR, 'test-hero-images');
const FAKE_SCREENSHOTS_DIR = join(TEST_DIR, 'test-screenshots');

// On force les paths AVANT de charger sync.js (sinon il prendra les défauts de .env)
process.env.OUTIL_DB_PATH = FAKE_OUTIL_DB_PATH;
process.env.HERO_IMAGES_DIR = FAKE_HERO_DIR;
process.env.SCREENSHOTS_DIR = FAKE_SCREENSHOTS_DIR;
// On laisse SITE_PUBLIC_URL=https://monsitehq.com par défaut — la recapture va probablement
// 404 sur les slugs test, on capturera la page 404, c'est OK pour valider le pipeline.

console.log('--- Setup ---');
console.log('Fake outil-coiffure DB :', FAKE_OUTIL_DB_PATH);
console.log('Hero images           :', FAKE_HERO_DIR);
console.log('Screenshots           :', FAKE_SCREENSHOTS_DIR);

mkdirSync(FAKE_HERO_DIR, { recursive: true });
mkdirSync(FAKE_SCREENSHOTS_DIR, { recursive: true });

// 1. Schéma minimum outil-coiffure (extrait de outil-coiffure/src/db.js)
const outilDb = new Database(FAKE_OUTIL_DB_PATH);
outilDb.pragma('journal_mode = WAL');
outilDb.exec(`
  CREATE TABLE IF NOT EXISTS salons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    nom TEXT NOT NULL,
    data_json TEXT NOT NULL,
    overrides_json TEXT,
    overrides_updated_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_test_slug ON salons(slug);
`);

// 2. Charger 5 salons depuis photo-picker.db (ceux qui ont le plus de photos)
const pickerDb = new Database(join(TEST_DIR, 'photo-picker.db'), { readonly: true });
const sampleSalons = pickerDb
  .prepare(
    `SELECT id, google_id, candidate_slug, nom, ville
     FROM salons
     WHERE status = 'fetched' AND photos_count >= 5
     ORDER BY photos_count DESC LIMIT 5`
  )
  .all();
pickerDb.close();

console.log(`\n--- Insère ${sampleSalons.length} salons dans la fake outil-coiffure DB ---`);
const insert = outilDb.prepare(
  `INSERT OR IGNORE INTO salons (slug, nom, data_json) VALUES (?, ?, ?)`
);
for (const s of sampleSalons) {
  // data_json doit contenir google_id pour matcher via findSalonByGoogleId
  const data = { google_id: s.google_id, nom: s.nom, ville: s.ville };
  insert.run(s.candidate_slug, s.nom, JSON.stringify(data));
  console.log(`  ${s.candidate_slug} (google_id=${s.google_id.slice(0, 20)}...)`);
}
outilDb.close();

// 3. Maintenant on charge sync.js (qui lira les bons paths via process.env)
const { syncSalon } = await import('../src/sync.js');
const pickerDbRw = (await import('../src/db.js')).default;

// On choisit le 1er salon, on simule "user a sélectionné la photo n°0, crop centré"
const target = sampleSalons[0];
const photo = pickerDbRw
  .prepare(
    `SELECT photo_id, original_url FROM salon_photos
     WHERE salon_id = ? ORDER BY position ASC LIMIT 1`
  )
  .get(target.id);

console.log(`\n--- Test sync sur ${target.candidate_slug} ---`);
console.log(`Photo sélectionnée : photo_id=${photo.photo_id.slice(0, 16)}...`);
console.log(`URL source         : ${photo.original_url.slice(0, 80)}...`);

// Crop simulé : centré, 1920x1080 (l'image source est probablement plus petite ;
// Sharp gérera quand même via extract() — si le crop dépasse, sharp throw une erreur claire).
// Pour faire un test robuste on télécharge d'abord l'image et on calcule un crop valide.
const { fetchImage } = await import('../src/cropper.js');
const { toOriginalResolution } = await import('../src/scraper.js');

const sourceUrl = toOriginalResolution(photo.original_url);
console.log(`\nDownload source full-res : ${sourceUrl.slice(0, 80)}...`);
const { width, height } = await fetchImage(sourceUrl);
console.log(`Source dimensions : ${width} × ${height}`);

// Crop 16:9 centré dans l'image
const targetRatio = 16 / 9;
let cropW, cropH;
if (width / height > targetRatio) {
  // Image plus large que 16:9 → on prend toute la hauteur
  cropH = height;
  cropW = Math.round(height * targetRatio);
} else {
  cropW = width;
  cropH = Math.round(width / targetRatio);
}
const cropX = Math.round((width - cropW) / 2);
const cropY = Math.round((height - cropH) / 2);
const crop = { x: cropX, y: cropY, w: cropW, h: cropH };
console.log(`Crop calculé      : ${JSON.stringify(crop)}`);

// Persist le choix dans photo-picker.db
pickerDbRw
  .prepare(
    `UPDATE salons
     SET picked_photo_id = ?, picked_crop_json = ?, picked_by = ?
     WHERE id = ?`
  )
  .run(photo.photo_id, JSON.stringify(crop), 'test-e2e', target.id);

console.log('\n--- Lance syncSalon() ---');
try {
  const result = await syncSalon(target.id, { pickedBy: 'test-e2e' });
  console.log('\n✅ Sync RÉUSSI');
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error('\n❌ Sync ÉCHEC :', e.message);
  process.exit(1);
}

// 4. Vérifications
console.log('\n--- Vérifications ---');
const heroPath = join(FAKE_HERO_DIR, `${target.candidate_slug}.jpg`);
if (existsSync(heroPath)) {
  const size = statSync(heroPath).size;
  console.log(`✅ Hero JPEG créé : ${heroPath} (${(size / 1024).toFixed(0)} KB)`);
  // Vérifie dimensions via sharp
  const sharp = (await import('sharp')).default;
  const meta = await sharp(heroPath).metadata();
  console.log(`   Dimensions     : ${meta.width} × ${meta.height} (attendu 1920 × 1080)`);
  if (meta.width !== 1920 || meta.height !== 1080) {
    console.error(`   ❌ DIMENSIONS INCORRECTES`);
  }
} else {
  console.error(`❌ Hero JPEG manquant : ${heroPath}`);
}

const checkDb = new Database(FAKE_OUTIL_DB_PATH, { readonly: true });
const row = checkDb
  .prepare('SELECT slug, overrides_json FROM salons WHERE slug = ?')
  .get(target.candidate_slug);
checkDb.close();

if (row && row.overrides_json) {
  const ov = JSON.parse(row.overrides_json);
  if (ov.hero && ov.hero.backgroundImage) {
    console.log(`✅ overrides_json mis à jour : hero.backgroundImage = "${ov.hero.backgroundImage}"`);
    console.log(`   Source : ${ov.hero.backgroundImageSource}`);
  } else {
    console.error('❌ overrides_json.hero.backgroundImage manquant');
  }
} else {
  console.error('❌ Pas de overrides_json dans la fake outil-coiffure DB');
}

// Screenshot
const screenshotPath = join(FAKE_SCREENSHOTS_DIR, `${target.candidate_slug}.jpg`);
if (existsSync(screenshotPath)) {
  const size = statSync(screenshotPath).size;
  console.log(`✅ Screenshot recapturé : ${(size / 1024).toFixed(0)} KB`);
} else {
  console.log(`⚠️ Screenshot non recapturé (attendu : monsitehq.com/preview/${target.candidate_slug} 404 probablement)`);
}

console.log('\n--- Test terminé ---');
