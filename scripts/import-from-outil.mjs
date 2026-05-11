// Import des salons depuis outil-coiffure salons.db directement (au lieu des CSV).
// - On lit tous les salons d'outil-coiffure qui ont un google_id dans data_json
// - On les insère dans photo-picker.db avec google_id comme clé canonique
// - Le candidate_slug stocké = slug réel d'outil-coiffure (pas de divergence)
// - Idempotent : skip les google_id déjà présents
//
// Pré-requis : OUTIL_DB_PATH pointant sur la BDD d'outil-coiffure (en prod = /data/salons.db).
//
// Usage :
//   node scripts/import-from-outil.mjs
//   node scripts/import-from-outil.mjs --csv-source ain  # tag la source pour filtrer plus tard

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import db from '../src/db.js';

const outilPath = process.env.OUTIL_DB_PATH;
if (!outilPath || !existsSync(outilPath)) {
  console.error(`OUTIL_DB_PATH introuvable : ${outilPath}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let csvSourceFilter = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--csv-source') csvSourceFilter = args[++i];
}

const outil = new Database(outilPath, { readonly: true });
let rows;
if (csvSourceFilter) {
  rows = outil
    .prepare(
      `SELECT slug, nom, ville, code_postal, adresse, lien_google_maps, csv_source, data_json
       FROM salons
       WHERE lien_google_maps IS NOT NULL AND lien_google_maps != '' AND csv_source = ?`
    )
    .all(csvSourceFilter);
} else {
  rows = outil
    .prepare(
      `SELECT slug, nom, ville, code_postal, adresse, lien_google_maps, csv_source, data_json
       FROM salons
       WHERE lien_google_maps IS NOT NULL AND lien_google_maps != ''`
    )
    .all();
}
outil.close();

console.log(`Salons trouvés dans outil-coiffure : ${rows.length}`);

const insert = db.prepare(`
  INSERT INTO salons (google_id, candidate_slug, nom, ville, code_postal, adresse, google_maps_url, csv_source)
  VALUES (@google_id, @candidate_slug, @nom, @ville, @code_postal, @adresse, @google_maps_url, @csv_source)
  ON CONFLICT (google_id) DO NOTHING
`);

let imported = 0;
let skipped = 0;
const reasons = [];

const tx = db.transaction(() => {
  for (const r of rows) {
    let data;
    try { data = JSON.parse(r.data_json); } catch { data = {}; }
    const googleId = data.google_id;
    if (!googleId) { skipped++; reasons.push(`Pas de google_id: ${r.slug}`); continue; }

    const result = insert.run({
      google_id: googleId,
      candidate_slug: r.slug,
      nom: r.nom,
      ville: r.ville || null,
      code_postal: r.code_postal || null,
      adresse: r.adresse || null,
      google_maps_url: r.lien_google_maps,
      csv_source: r.csv_source || null,
    });
    if (result.changes > 0) imported++;
    else skipped++;
  }
});
tx();

console.log(`Importés : ${imported}`);
console.log(`Skippés  : ${skipped}`);
if (reasons.length > 0) console.log('Premières raisons :', reasons.slice(0, 5));
