// Sync : applique le pick d'un salon vers outil-coiffure de bout en bout.
//
// 1. Récupère le salon dans photo-picker.db (avec sa photo choisie + crop)
// 2. Télécharge l'image source en pleine résolution (=s0)
// 3. Crop selon le rectangle fourni → 1920×1080 JPEG
// 4. Sauve dans HERO_IMAGES_DIR/{slug}.jpg (le slug vient de outil-coiffure pas photo-picker)
// 5. Met à jour overrides_json.hero.backgroundImage dans salons.db
// 6. Recapture le screenshot landing (1280×800) en visitant SITE_PUBLIC_URL/preview/{slug}
//    → écrase SCREENSHOTS_DIR/{slug}.jpg
//
// Toute erreur est enregistrée dans photo-picker.db (sync_error) et propagée.

import { join, resolve } from 'node:path';
import db from './db.js';
import {
  findSalonByGoogleId,
  updateHeroImage,
  removeHeroImage,
  isOutilDbAvailable,
  getOutilDbPath,
} from './outil-db.js';
import { downloadCropAndSave } from './cropper.js';
import { toOriginalResolution } from './scraper.js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

puppeteer.use(StealthPlugin());

const SCREENSHOT_W = 1280;
const SCREENSHOT_H = 800;
const SCREENSHOT_QUALITY = 80;

function getHeroImagesDir() {
  return resolve(process.env.HERO_IMAGES_DIR || '../outil-coiffure/data/hero-images');
}
function getScreenshotsDir() {
  return resolve(process.env.SCREENSHOTS_DIR || '../outil-coiffure/data/screenshots');
}
function getSitePublicUrl() {
  return (process.env.SITE_PUBLIC_URL || 'https://monsitehq.com').replace(/\/$/, '');
}

async function recaptureScreenshot(slug) {
  const url = `${getSitePublicUrl()}/preview/${encodeURIComponent(slug)}`;
  const outPath = join(getScreenshotsDir(), `${slug}.jpg`);
  mkdirSync(getScreenshotsDir(), { recursive: true });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: SCREENSHOT_W, height: SCREENSHOT_H, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45_000 });
    // Petit settle pour fonts + hero background
    await new Promise((r) => setTimeout(r, 1_500));
    const buf = await page.screenshot({
      type: 'jpeg',
      quality: SCREENSHOT_QUALITY,
      clip: { x: 0, y: 0, width: SCREENSHOT_W, height: SCREENSHOT_H },
    });
    writeFileSync(outPath, buf);
    return { url, path: outPath, bytes: buf.length };
  } finally {
    await browser.close().catch(() => {});
  }
}

// Sync principal — usage :
//   await syncSalon(salonId, { pickedBy: 'johann@...' })
export async function syncSalon(salonId, opts = {}) {
  const salon = db
    .prepare(
      `SELECT s.*, p.url AS picked_url, p.original_url AS picked_original_url, p.photo_id AS picked_photo_id_check
       FROM salons s
       LEFT JOIN salon_photos p ON p.salon_id = s.id AND p.photo_id = s.picked_photo_id
       WHERE s.id = ?`
    )
    .get(salonId);

  if (!salon) throw new Error(`Salon photo-picker id=${salonId} introuvable`);
  if (!salon.picked_photo_id) throw new Error(`Pas de photo choisie pour salon ${salonId}`);
  if (!salon.picked_crop_json) throw new Error(`Pas de crop défini pour salon ${salonId}`);
  if (!salon.picked_original_url) throw new Error(`Photo ${salon.picked_photo_id} introuvable dans salon_photos`);

  if (!isOutilDbAvailable()) {
    throw new Error(`outil-coiffure DB introuvable à ${getOutilDbPath()} — la copie n'est pas encore importée ?`);
  }

  // 1. Match via google_id (FID) — robuste aux variations de slug
  const outilSalon = findSalonByGoogleId(salon.google_id);
  if (!outilSalon) {
    throw new Error(
      `Salon google_id=${salon.google_id} pas trouvé dans outil-coiffure. ` +
        `Il faut importer le CSV dans outil-coiffure avant de pouvoir sync.`
    );
  }

  // 2-4. Download + crop + save
  const slug = outilSalon.slug;
  const crop = JSON.parse(salon.picked_crop_json);
  const heroPath = join(getHeroImagesDir(), `${slug}.jpg`);
  const sourceUrl = toOriginalResolution(salon.picked_original_url);

  const cropResult = await downloadCropAndSave({
    url: sourceUrl,
    crop,
    outPath: heroPath,
  });

  // 5. Update DB outil-coiffure
  const heroUrlPath = `/hero-images/${slug}.jpg`;
  updateHeroImage(outilSalon.id, heroUrlPath);

  // 6. Recapture screenshot
  let screenshotResult = null;
  let screenshotError = null;
  try {
    screenshotResult = await recaptureScreenshot(slug);
  } catch (e) {
    screenshotError = e.message;
  }

  // Marque le salon comme synced côté photo-picker (même si le screenshot a échoué :
  // le hero est en place, le screenshot peut être re-déclenché manuellement plus tard).
  db.prepare(
    `UPDATE salons
     SET synced_at = datetime('now'),
         sync_error = ?,
         status = 'picked',
         picked_kind = 'cropped'
     WHERE id = ?`
  ).run(screenshotError, salonId);

  return {
    slug,
    hero_path: heroPath,
    hero_url: heroUrlPath,
    crop_result: cropResult,
    screenshot: screenshotResult,
    screenshot_error: screenshotError,
  };
}

// "Garder l'image par défaut" : marque le salon comme traité sans uploader d'image.
// - Si outil-coiffure a un hero.backgroundImage précédent posé par photo-picker,
//   on le supprime (retour propre au DEFAULT_HERO_IMAGE global d'outil-coiffure).
// - On ne (re)génère un screenshot QUE si SCREENSHOTS_DIR/{slug}.jpg n'existe pas.
// - Si outil-coiffure DB indisponible ou salon absent, on marque quand même côté
//   photo-picker (l'admin pourra resync plus tard).
export async function keepDefaultHero(salonId, opts = {}) {
  const salon = db.prepare('SELECT * FROM salons WHERE id = ?').get(salonId);
  if (!salon) throw new Error(`Salon photo-picker id=${salonId} introuvable`);

  let outilSlug = null;
  let heroOverrideRemoved = false;
  if (isOutilDbAvailable()) {
    const outilSalon = findSalonByGoogleId(salon.google_id);
    if (outilSalon) {
      outilSlug = outilSalon.slug;
      try {
        heroOverrideRemoved = removeHeroImage(outilSalon.id);
      } catch (e) {
        // Non-bloquant : on log et on continue
        console.warn('[keep-default] removeHeroImage failed:', e.message);
      }
    }
  }

  let screenshotAction = 'no_outil_match';
  let screenshotResult = null;
  let screenshotError = null;
  if (outilSlug) {
    const screenshotPath = join(getScreenshotsDir(), `${outilSlug}.jpg`);
    if (existsSync(screenshotPath)) {
      screenshotAction = 'skipped_already_exists';
    } else {
      try {
        screenshotResult = await recaptureScreenshot(outilSlug);
        screenshotAction = 'captured';
      } catch (e) {
        screenshotError = e.message;
        screenshotAction = 'error';
      }
    }
  }

  db.prepare(
    `UPDATE salons
     SET status = 'picked',
         picked_kind = 'default',
         picked_photo_id = NULL,
         picked_crop_json = NULL,
         picked_by = ?,
         picked_at = datetime('now'),
         synced_at = datetime('now'),
         sync_error = ?
     WHERE id = ?`
  ).run(opts.pickedBy || 'anon', screenshotError, salonId);

  return {
    slug: outilSlug,
    kept_default: true,
    hero_override_removed: heroOverrideRemoved,
    screenshot_action: screenshotAction,
    screenshot: screenshotResult,
    screenshot_error: screenshotError,
  };
}
