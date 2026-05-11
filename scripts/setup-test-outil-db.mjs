// Peuple la fake outil-coiffure DB avec TOUS les salons de photo-picker.db.
// Permet de tester le sync depuis l'UI sur n'importe quel salon.
// Reset aussi les salons synced/picked → fetched pour pouvoir re-tester.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const TEST_DIR = resolve('./data');
const FAKE = join(TEST_DIR, 'test-outil-coiffure.db');

mkdirSync(TEST_DIR, { recursive: true });

const outil = new Database(FAKE);
outil.pragma('journal_mode = WAL');
outil.exec(`
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

const picker = new Database(join(TEST_DIR, 'photo-picker.db'), { readonly: true });
const salons = picker.prepare('SELECT google_id, candidate_slug, nom, ville FROM salons').all();
picker.close();

const insert = outil.prepare(
  'INSERT OR IGNORE INTO salons (slug, nom, data_json) VALUES (?, ?, ?)'
);

let inserted = 0;
const tx = outil.transaction(() => {
  for (const s of salons) {
    const data = { google_id: s.google_id, nom: s.nom, ville: s.ville };
    const r = insert.run(s.candidate_slug, s.nom, JSON.stringify(data));
    if (r.changes > 0) inserted++;
  }
});
tx();

console.log(`Fake outil-coiffure DB peuplée : ${inserted} nouveaux salons (sur ${salons.length} totaux dans photo-picker.db)`);
outil.close();

// Reset les salons synced/picked dans photo-picker pour pouvoir re-tester via l'UI
const pickerRw = new Database(join(TEST_DIR, 'photo-picker.db'));
const reset = pickerRw
  .prepare(
    `UPDATE salons
     SET status = 'fetched',
         picked_at = NULL,
         picked_photo_id = NULL,
         picked_crop_json = NULL,
         picked_by = NULL,
         synced_at = NULL,
         sync_error = NULL
     WHERE status IN ('picked', 'skipped')`
  )
  .run();
console.log(`Reset ${reset.changes} salons en photo-picker.db (picked/skipped → fetched)`);
pickerRw.close();
