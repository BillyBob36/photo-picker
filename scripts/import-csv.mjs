// Import d'un CSV scrap.io dans photo-picker.db.
//
// Usage :
//   node scripts/import-csv.mjs ../exports-scrap.io/coiffeur-france-auvergne-rhone-alpes-ain.csv
//   node scripts/import-csv.mjs <csv> [--source nom-source]
//
// Idempotent : skip les salons dont le google_id est déjà en base.

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'csv-parse/sync';
import db from '../src/db.js';
import { candidateSlug } from '../src/slug.js';

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/import-csv.mjs <chemin-csv> [--source source-name]');
    process.exit(1);
  }
  const csv = args[0];
  let source = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--source') source = args[++i];
  }
  if (!source) {
    // Auto-dérive : "coiffeur-france-auvergne-rhone-alpes-ain.csv" → "ain"
    source = basename(csv).replace(/\.(csv|tsv|txt)$/i, '').split('-').pop();
  }
  return { csv, source };
}

const { csv, source } = parseArgs(process.argv);
if (!existsSync(csv)) {
  console.error(`Fichier introuvable: ${csv}`);
  process.exit(1);
}

const raw = readFileSync(csv, 'utf8');
const rows = parse(raw, {
  delimiter: '\t',
  columns: (h) => h.map((x) => x.replace(/^﻿/, '').trim()),
  bom: true,
  relax_quotes: true,
  relax_column_count: true,
  skip_records_with_error: true,
});

console.log(`Source: ${source}`);
console.log(`CSV   : ${csv} (${rows.length} lignes)`);

const insert = db.prepare(`
  INSERT INTO salons (google_id, candidate_slug, nom, ville, code_postal, adresse, google_maps_url, csv_source)
  VALUES (@google_id, @candidate_slug, @nom, @ville, @code_postal, @adresse, @google_maps_url, @csv_source)
  ON CONFLICT (google_id) DO NOTHING
`);

let imported = 0;
let skipped = 0;
const skippedReasons = [];

const tx = db.transaction(() => {
  for (const r of rows) {
    const nom = r['Nom'] || r['﻿Nom'];
    const googleId = r['Google ID'];
    const lien = r['Lien'];

    if (!nom) {
      skipped++;
      skippedReasons.push('Pas de nom');
      continue;
    }
    if (!googleId) {
      skipped++;
      skippedReasons.push(`Pas de Google ID: ${nom}`);
      continue;
    }
    if (!lien || !lien.startsWith('http')) {
      skipped++;
      skippedReasons.push(`Pas de Lien valide: ${nom}`);
      continue;
    }
    const fermeRaw = r['Est fermé définitivement'];
    if (fermeRaw && fermeRaw.toLowerCase() === 'oui') {
      skipped++;
      skippedReasons.push(`Fermé: ${nom}`);
      continue;
    }

    const ville = r['Ville'] || '';
    const result = insert.run({
      google_id: googleId,
      candidate_slug: candidateSlug(nom, ville),
      nom,
      ville,
      code_postal: r['Code postal'] || null,
      adresse: r['Adresse 1'] || r['Adresse complète'] || null,
      google_maps_url: lien,
      csv_source: source,
    });
    if (result.changes > 0) imported++;
    else skipped++;
  }
});

tx();

console.log(`Importés : ${imported}`);
console.log(`Skippés  : ${skipped}`);
if (skippedReasons.length > 0) {
  console.log('Raisons de skip (10 premières) :');
  for (const r of skippedReasons.slice(0, 10)) console.log('  -', r);
}
