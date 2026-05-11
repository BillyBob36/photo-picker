// Passerelle unique vers la BDD prod d'outil-coiffure.
// Lecture : retrouver le slug & overrides_json d'un salon via son google_id (FID).
// Écriture : mettre à jour overrides_json.hero.backgroundImage.
//
// Si OUTIL_DB_PATH n'existe pas (dev local, pas encore migré), tous les appels
// retournent null/false proprement — l'UI reste utilisable pour le tri, mais le
// sync échoue avec un message clair.

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

let _db = null;
let _path = null;

function open() {
  if (_db) return _db;
  _path = process.env.OUTIL_DB_PATH || '../outil-coiffure/data/salons.db';
  if (!existsSync(_path)) {
    return null;
  }
  // Ouverture en read-write : WAL mode, on partage proprement avec le process outil-coiffure.
  _db = new Database(_path);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000'); // retry 5s si lock concurrent
  return _db;
}

export function isOutilDbAvailable() {
  return open() !== null;
}

export function getOutilDbPath() {
  return _path;
}

export function findSalonByGoogleId(googleId) {
  const d = open();
  if (!d) return null;
  // google_id est stocké dans data_json (JSON blob), il faut json_extract.
  const stmt = d.prepare(
    `SELECT id, slug, nom, overrides_json
     FROM salons
     WHERE json_extract(data_json, '$.google_id') = ?
     LIMIT 1`
  );
  return stmt.get(googleId) || null;
}

export function updateHeroImage(salonId, heroImagePath) {
  const d = open();
  if (!d) throw new Error(`outil-coiffure DB introuvable : ${_path}`);

  // Merge avec les overrides existants (on ne veut PAS écraser les autres clés)
  const row = d.prepare('SELECT overrides_json FROM salons WHERE id = ?').get(salonId);
  if (!row) throw new Error(`Salon id=${salonId} introuvable dans outil-coiffure`);

  let overrides = {};
  if (row.overrides_json) {
    try {
      overrides = JSON.parse(row.overrides_json);
    } catch (_) {
      overrides = {};
    }
  }
  overrides.hero = overrides.hero || {};
  overrides.hero.backgroundImage = heroImagePath;
  // Marqueur facultatif pour qu'on puisse identifier d'où vient cette image
  overrides.hero.backgroundImageSource = 'photo-picker';
  overrides.hero.backgroundImageUpdatedAt = new Date().toISOString();

  const update = d.prepare(
    `UPDATE salons
     SET overrides_json = ?, overrides_updated_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  );
  update.run(JSON.stringify(overrides), salonId);
}

// Inverse de updateHeroImage : retire la clé hero.backgroundImage des overrides
// (et les marqueurs photo-picker associés). Utilisé quand l'utilisateur clique
// "Garder l'image par défaut" → on veut un retour propre au DEFAULT_HERO_IMAGE
// global d'outil-coiffure. No-op si la clé n'existait pas.
export function removeHeroImage(salonId) {
  const d = open();
  if (!d) throw new Error(`outil-coiffure DB introuvable : ${_path}`);

  const row = d.prepare('SELECT overrides_json FROM salons WHERE id = ?').get(salonId);
  if (!row) throw new Error(`Salon id=${salonId} introuvable dans outil-coiffure`);
  if (!row.overrides_json) return false; // rien à faire

  let overrides;
  try { overrides = JSON.parse(row.overrides_json); } catch { return false; }
  if (!overrides.hero || !overrides.hero.backgroundImage) return false;

  delete overrides.hero.backgroundImage;
  delete overrides.hero.backgroundImageSource;
  delete overrides.hero.backgroundImageUpdatedAt;
  if (Object.keys(overrides.hero).length === 0) delete overrides.hero;

  const finalJson = Object.keys(overrides).length === 0 ? null : JSON.stringify(overrides);
  d.prepare(
    `UPDATE salons
     SET overrides_json = ?, overrides_updated_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?`
  ).run(finalJson, salonId);
  return true;
}

// Pour /admin-style stats : combien de salons ont déjà un hero overridé par nous
export function countSalonsWithPickerHero() {
  const d = open();
  if (!d) return 0;
  const r = d.prepare(
    `SELECT COUNT(*) AS c
     FROM salons
     WHERE json_extract(overrides_json, '$.hero.backgroundImageSource') = 'photo-picker'`
  ).get();
  return r ? r.c : 0;
}
