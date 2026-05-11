// Reset complet de photo-picker.db (drop tout, recrée le schéma vide).
// Utile pendant le dev. NE TOUCHE PAS la DB outil-coiffure.

import { unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DB = resolve('./data/photo-picker.db');
const WAL = `${DB}-wal`;
const SHM = `${DB}-shm`;

for (const f of [DB, WAL, SHM]) {
  if (existsSync(f)) {
    unlinkSync(f);
    console.log('Supprimé :', f);
  }
}

// Réimporte le schema en chargeant src/db.js (qui run le CREATE TABLE)
await import('../src/db.js');
console.log('Schema recréé.');
