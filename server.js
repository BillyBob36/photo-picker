// Photo-picker server : extraction + UI de tri + push automatique vers outil-coiffure.
// Démarrage :   node --env-file=.env server.js
// Ou :          node server.js  (variables d'env doivent être set dans le shell)

import express from 'express';
import session from 'express-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import db from './src/db.js';
import { requireAuth, loginHandler, logoutHandler, whoamiHandler } from './src/auth.js';
import { syncSalon, keepDefaultHero } from './src/sync.js';
import { isOutilDbAvailable, getOutilDbPath, countSalonsWithPickerHero, findSalonByGoogleId } from './src/outil-db.js';
import { HERO_DIMENSIONS } from './src/cropper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '4000', 10);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-only-not-secure-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 jours
    },
  })
);

// =============================================================================
// Routes publiques (auth)
// =============================================================================
app.get('/whoami', whoamiHandler);
app.post('/login', loginHandler);
app.post('/logout', logoutHandler);
app.get('/login', (_req, res) => res.sendFile(join(__dirname, 'public', 'login.html')));

// Proxy d'image : sert les images Google CDN sous notre origin pour permettre à
// Cropper.js d'y accéder sans bloquer sur CORS (les domaines lh{N}.googleusercontent.com
// ne renvoient pas Access-Control-Allow-Origin). Allowlist stricte pour éviter
// l'open-proxy.
app.get('/proxy-image', requireAuth, async (req, res) => {
  const target = String(req.query.url || '');
  if (!/^https:\/\/lh\d\.googleusercontent\.com\//.test(target)) {
    return res.status(400).json({ error: 'URL non autorisée (allowlist Google CDN uniquement)' });
  }
  try {
    const upstream = await fetch(target);
    if (!upstream.ok) return res.status(upstream.status).end();
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Healthcheck (utile pour Coolify)
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    outil_db_available: isOutilDbAvailable(),
    outil_db_path: getOutilDbPath(),
    salons_picker_hero_count: countSalonsWithPickerHero(),
  });
});

// =============================================================================
// API authentifiée
// =============================================================================
const api = express.Router();
api.use(requireAuth);

// Stats globales
api.get('/stats', (_req, res) => {
  const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM salons GROUP BY status').all();
  const total = byStatus.reduce((a, b) => a + b.c, 0);
  const photos = db.prepare('SELECT COUNT(*) AS c FROM salon_photos').get();
  const csvSources = db
    .prepare('SELECT csv_source, COUNT(*) AS c FROM salons GROUP BY csv_source ORDER BY csv_source')
    .all();
  res.json({
    total_salons: total,
    by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.c])),
    total_photos: photos.c,
    by_csv_source: csvSources,
    hero_dimensions: HERO_DIMENSIONS,
    outil_coiffure: {
      available: isOutilDbAvailable(),
      synced_count: countSalonsWithPickerHero(),
    },
  });
});

// Renvoie le prochain salon à trier. Lorsqu'on a plusieurs utilisateurs qui
// swipent en parallèle, on disperse les choix en piochant pseudo-aléatoirement
// dans les 30 plus anciens : très peu probable que deux users tombent sur le
// même salon au même instant (et même si c'est le cas, le dernier .pick() gagne,
// pas grave pour notre usage).
api.get('/next', (req, res) => {
  const where = ["status = 'fetched'"];
  const params = [];
  if (req.query.csv_source) {
    where.push('csv_source = ?');
    params.push(req.query.csv_source);
  }
  const salon = db
    .prepare(
      `SELECT * FROM salons WHERE ${where.join(' AND ')}
       ORDER BY photos_fetched_at ASC
       LIMIT 1 OFFSET ABS(RANDOM() % 30)`
    )
    .get(...params)
    // Fallback si OFFSET dépasse le count (cas où il reste < 30 salons)
    || db.prepare(
      `SELECT * FROM salons WHERE ${where.join(' AND ')}
       ORDER BY photos_fetched_at ASC LIMIT 1`
    ).get(...params);
  if (!salon) return res.json({ done: true });

  const photos = db
    .prepare(
      `SELECT photo_id, kind, url, original_url, position
       FROM salon_photos WHERE salon_id = ? ORDER BY position ASC`
    )
    .all(salon.id);

  // On a aussi besoin du slug outil-coiffure pour afficher le preview existant
  const outilSalon = isOutilDbAvailable() ? findSalonByGoogleId(salon.google_id) : null;

  res.json({
    salon: {
      id: salon.id,
      nom: salon.nom,
      ville: salon.ville,
      adresse: salon.adresse,
      code_postal: salon.code_postal,
      google_maps_url: salon.google_maps_url,
      csv_source: salon.csv_source,
      outil_slug: outilSalon?.slug || null,
      site_public_url: process.env.SITE_PUBLIC_URL || 'https://monsitehq.com',
    },
    photos,
    hero_dimensions: HERO_DIMENSIONS,
  });
});

// L'utilisateur a choisi une photo + cropé → sync complet
api.post('/pick', async (req, res) => {
  const { salon_id, photo_id, crop } = req.body || {};
  if (!salon_id || !photo_id || !crop) {
    return res.status(400).json({ error: 'salon_id, photo_id, crop requis' });
  }
  if (typeof crop.x !== 'number' || typeof crop.y !== 'number' || typeof crop.w !== 'number' || typeof crop.h !== 'number') {
    return res.status(400).json({ error: 'crop.x/y/w/h doivent être des nombres' });
  }

  // Sauvegarde le choix immédiatement (avant le sync, qui peut prendre 10-20s)
  db.prepare(
    `UPDATE salons
     SET picked_photo_id = ?, picked_crop_json = ?, picked_by = ?, picked_at = datetime('now')
     WHERE id = ?`
  ).run(photo_id, JSON.stringify(crop), req.session.user_name || 'anon', salon_id);

  // Sync (download + crop + DB + screenshot)
  try {
    const result = await syncSalon(salon_id, { pickedBy: req.session.user_name });
    res.json({ ok: true, sync: result });
  } catch (e) {
    // Le pick est sauvé mais le sync a échoué — on garde l'info pour retry
    db.prepare('UPDATE salons SET sync_error = ? WHERE id = ?').run(e.message, salon_id);
    res.status(500).json({ ok: false, error: e.message, picked: true });
  }
});

// "Garder l'image par défaut" : marque le salon comme traité sans cropper,
// supprime le hero précédemment posé par photo-picker (s'il y en avait un),
// recapture le screenshot uniquement s'il n'existe pas déjà.
api.post('/keep-default', async (req, res) => {
  const { salon_id } = req.body || {};
  if (!salon_id) return res.status(400).json({ error: 'salon_id requis' });
  try {
    const result = await keepDefaultHero(salon_id, { pickedBy: req.session.user_name });
    res.json({ ok: true, ...result });
  } catch (e) {
    db.prepare('UPDATE salons SET sync_error = ? WHERE id = ?').run(e.message, salon_id);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Skip un salon (aucune photo ne convient OU on passe)
api.post('/skip', (req, res) => {
  const { salon_id } = req.body || {};
  if (!salon_id) return res.status(400).json({ error: 'salon_id requis' });
  db.prepare(
    `UPDATE salons SET status = 'skipped', picked_at = datetime('now'), picked_by = ? WHERE id = ?`
  ).run(req.session.user_name || 'anon', salon_id);
  res.json({ ok: true });
});

// Retry sync pour un salon dont le sync a échoué
api.post('/retry-sync', async (req, res) => {
  const { salon_id } = req.body || {};
  if (!salon_id) return res.status(400).json({ error: 'salon_id requis' });
  try {
    const result = await syncSalon(salon_id);
    res.json({ ok: true, sync: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use('/api', api);

// =============================================================================
// Statics + UI
// =============================================================================
// Pas de cache HTTP sur l'UI : nos amis n'iront pas faire Ctrl+Shift+R à chaque
// déploiement. Coût négligeable (fichiers servis statiquement, ~20 KB total).
app.use(
  '/static',
  express.static(join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.set('Cache-Control', 'no-store'),
  })
);
app.get('/', requireAuth, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`photo-picker-poc en écoute sur http://localhost:${PORT}`);
  console.log(`Outil-coiffure DB : ${isOutilDbAvailable() ? '✓' : '✗ (absent)'} ${getOutilDbPath()}`);
});
