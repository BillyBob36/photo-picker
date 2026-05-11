// DB locale du photo-picker. Isolée d'outil-coiffure : on ne touche jamais
// salons.db depuis ici, uniquement notre propre fichier photo-picker.db.
// L'unique passerelle vers outil-coiffure se fait dans src/outil-db.js (au sync).

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.PICKER_DB_PATH || join(__dirname, '..', 'data', 'photo-picker.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS salons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT NOT NULL UNIQUE,           -- FID Google "0x...:0x..." (clé canonique)
    candidate_slug TEXT NOT NULL,             -- slug calculé localement (peut diverger de outil-coiffure si collision)
    nom TEXT NOT NULL,
    ville TEXT,
    code_postal TEXT,
    adresse TEXT,
    google_maps_url TEXT NOT NULL,
    csv_source TEXT,                          -- ex: 'ain', 'rhone'
    imported_at TEXT DEFAULT (datetime('now')),

    -- Scrape state
    photos_fetched_at TEXT,                   -- null = pas encore scrapé
    photos_count INTEGER DEFAULT 0,
    fetch_error TEXT,
    consent_screen_seen INTEGER DEFAULT 0,

    -- Pick state
    status TEXT NOT NULL DEFAULT 'pending',
      -- pending : pas encore traité côté UI
      -- fetched : photos OK, en attente de tri
      -- no_photos : 0 photo trouvée
      -- picked : photo choisie + crop validé + synced
      -- skipped : utilisateur a passé (aucune photo ne convient)
    picked_at TEXT,
    picked_photo_id TEXT,                     -- FK vers salon_photos.photo_id (gardé en string pour stabilité)
    picked_crop_json TEXT,                    -- {x,y,w,h} en coordonnées de l'image source
    picked_by TEXT,                           -- ip ou identifiant de la personne qui a swipé
    synced_at TEXT,                           -- quand le push vers outil-coiffure a réussi
    sync_error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_salons_status ON salons(status);
  CREATE INDEX IF NOT EXISTS idx_salons_csv_source ON salons(csv_source);
  CREATE INDEX IF NOT EXISTS idx_salons_google_id ON salons(google_id);

  CREATE TABLE IF NOT EXISTS salon_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    salon_id INTEGER NOT NULL,
    photo_id TEXT NOT NULL,                   -- ID extrait de l'URL Google (/{ns}/{ID})
    kind TEXT NOT NULL,                       -- 'place' | 'ugc' | 'legacy'
    url TEXT NOT NULL,                        -- URL en résolution hero w1280-h800
    original_url TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    fetched_at TEXT DEFAULT (datetime('now')),
    UNIQUE(salon_id, photo_id),
    FOREIGN KEY (salon_id) REFERENCES salons(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_salon_photos_salon_id ON salon_photos(salon_id);
`);

// Migrations idempotentes (pour DB déjà créées avant l'ajout de colonnes)
const existingCols = db.prepare("PRAGMA table_info(salons)").all().map((c) => c.name);
// picked_kind : 'cropped' (image Google cropée) | 'default' (image fake conservée)
if (!existingCols.includes('picked_kind')) {
  db.exec("ALTER TABLE salons ADD COLUMN picked_kind TEXT");
}

export function initSchema() {
  // Schema déjà créé au load par le exec ci-dessus. Cette fonction reste
  // exportée pour clarté côté caller (et symétrie avec outil-coiffure/src/db.js).
}

export default db;
