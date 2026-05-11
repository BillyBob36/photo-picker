// Test rapide du fix : rescrape 1 salon connu pour avoir des photos parasites
// (DESSANGE Bourg-en-Bresse) et compare avec les anciennes photos en DB.

import { launchBrowser, scrapeSalon } from '../src/scraper.js';
import db from '../src/db.js';

const TARGET_NOM = 'DESSANGE';

const salon = db
  .prepare(`SELECT id, nom, google_maps_url FROM salons WHERE nom LIKE ? LIMIT 1`)
  .get('%' + TARGET_NOM + '%');
if (!salon) {
  console.error('Salon introuvable');
  process.exit(1);
}
console.log('Test sur :', salon.nom);
console.log('URL      :', salon.google_maps_url);

const oldPhotos = db
  .prepare('SELECT photo_id FROM salon_photos WHERE salon_id = ?')
  .all(salon.id);
console.log(`Anciennes photos en DB : ${oldPhotos.length}`);

const browser = await launchBrowser();
const t0 = Date.now();
const r = await scrapeSalon(browser, salon.google_maps_url);
console.log(`Nouvelle extraction    : ${r.photos.length} photos, ${Date.now() - t0}ms`);
console.log(`Tab "Photos" cliqué    : ${r.photos_tab_clicked}`);
console.log(`Consent screen        : ${r.consent_seen}`);

const oldIds = new Set(oldPhotos.map((p) => p.photo_id));
const newIds = new Set(r.photos.map((p) => p.photo_id));
const common = [...newIds].filter((id) => oldIds.has(id));
const onlyOld = [...oldIds].filter((id) => !newIds.has(id));
const onlyNew = [...newIds].filter((id) => !oldIds.has(id));
console.log('\nDiff :');
console.log(`  En commun (probablement vraies photos) : ${common.length}`);
console.log(`  Seulement ancien (parasites filtrées ?) : ${onlyOld.length}`);
console.log(`  Seulement nouveau (manquaient avant ?)  : ${onlyNew.length}`);

// Combien des "anciennes only" étaient des photos partagées sur > 1 salon (= parasites confirmés)
let parasitesConfirmed = 0;
for (const id of onlyOld) {
  const c = db.prepare('SELECT COUNT(DISTINCT salon_id) AS c FROM salon_photos WHERE photo_id = ?').get(id);
  if (c.c > 1) parasitesConfirmed++;
}
console.log(`  Dont anciennes parasites (sur >1 salon) : ${parasitesConfirmed} / ${onlyOld.length}`);

await browser.close();
