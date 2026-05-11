// POC v2 : extraire les photos Google Maps de 5 salons coiffeurs.
// Découverte v1 : le DOM moderne utilise lh{N}.googleusercontent.com/{gps-cs-s|geougc|p}/...
// pas /p/ comme l'ancien blog SerpApi 2022. On filtre les avatars (=w36-h36, mo-br100).
// Lecture seule sur le CSV. Aucun side-effect sur la DB outil-coiffure.
// Output : ./data/poc-results.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const CSV_PATH = '../exports-scrap.io/coiffeur-france-auvergne-rhone-alpes-ain.csv';
const OUT_PATH = './data/poc-results.json';
const SAMPLE_SIZE = 5;
const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 2_500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// On match les 3 namespaces où Google Maps cache les photos de place :
//   gps-cs-s/  -> Photos de l'établissement (les plus pertinentes pour nous)
//   geougc/    -> User-generated content (souvent intérieur du salon)
//   p/         -> Ancien format (rare en 2026 mais on garde au cas où)
// On EXCLUT :
//   /a/ et /a-/  -> avatars utilisateurs
//   =w36-h36, mo-br100, mo-ba   -> petites miniatures rondes (avatars)
const RX_PHOTO =
  /https:\/\/lh\d\.googleusercontent\.com\/(?:gps-cs-s|geougc|p)\/[A-Za-z0-9_-]+(?:=[A-Za-z0-9_-]+)?/g;

function isAvatarUrl(url) {
  return /=w36-h36|mo-br100|mo-ba/.test(url);
}

// Réécrit l'URL pour demander une résolution hero (1280×800). Garde tout le reste tel quel.
function toHeroResolution(url, width = 1280, height = 800) {
  // Format général : .../<ID>=w{W}-h{H}-{flags}    ou    .../<ID>=h{H}-no    ou pas de "=" du tout
  // On split sur "=" et on remplace tout après par les nouveaux paramètres.
  const eqIdx = url.indexOf('=');
  if (eqIdx === -1) return `${url}=w${width}-h${height}-k-no`;
  return `${url.slice(0, eqIdx)}=w${width}-h${height}-k-no`;
}

async function extractPhotos(page) {
  // 1. HTML statique (déjà beaucoup de photos)
  const html = await page.content();
  const found = new Set();
  for (const m of html.matchAll(RX_PHOTO)) {
    const url = m[0].replace(/&quot;.*$/, '').replace(/\\u003d/g, '=');
    if (!isAvatarUrl(url)) found.add(url);
  }

  // 2. <img> du DOM (potentiellement chargés en lazy après JS)
  const imgs = await page.evaluate(() => {
    return [...document.querySelectorAll('img')]
      .map((i) => i.src || i.dataset.src || '')
      .filter((s) => /googleusercontent\.com\/(gps-cs-s|geougc|p)\//.test(s));
  });
  for (const u of imgs) {
    if (!isAvatarUrl(u)) found.add(u);
  }

  // 3. background-image inline (Maps utilise parfois ça pour la grille photos)
  const bgs = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('[style*="background-image"]').forEach((el) => {
      const m = (el.getAttribute('style') || '').match(
        /url\(["']?(https:\/\/[^"')]+googleusercontent\.com\/(?:gps-cs-s|geougc|p)\/[^"')]+)["']?\)/
      );
      if (m) out.push(m[1]);
    });
    return out;
  });
  for (const u of bgs) {
    if (!isAvatarUrl(u)) found.add(u);
  }

  // Dédoublonne par ID (la même photo peut apparaître en plusieurs résolutions)
  const byId = new Map();
  for (const url of found) {
    const idMatch = url.match(/\/(?:gps-cs-s|geougc|p)\/([A-Za-z0-9_-]+)/);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        kind: url.includes('/gps-cs-s/') ? 'place' : url.includes('/geougc/') ? 'ugc' : 'legacy',
        original_url: url,
        hero_url: toHeroResolution(url),
      });
    }
  }
  return Array.from(byId.values());
}

async function processSalon(browser, salon) {
  const t0 = Date.now();
  const result = {
    nom: salon.Nom,
    ville: salon.Ville,
    google_id: salon['Google ID'],
    lien: salon.Lien,
    photos: [],
    photo_count_place: 0,
    photo_count_ugc: 0,
    error: null,
    timing_ms: 0,
    consent_seen: false,
    photos_tab_clicked: false,
  };

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const t = req.resourceType();
      if (t === 'font' || t === 'media') return req.abort();
      req.continue();
    });

    await page.goto(salon.Lien, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // Consent screen FR
    const consent = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, [role="button"]')];
      const acc = btns.find((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        const al = (b.getAttribute('aria-label') || '').toLowerCase();
        return t === 'tout accepter' || al.includes('tout accepter') || al.includes('accept all');
      });
      if (acc) {
        acc.click();
        return true;
      }
      return false;
    });
    if (consent) {
      result.consent_seen = true;
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    }

    await sleep(SETTLE_MS);

    // Première extraction (HTML statique)
    let photos = await extractPhotos(page);

    // Si on a moins de 5 photos, on essaie de cliquer "Voir les photos" pour ouvrir la grille
    if (photos.length < 5) {
      const clicked = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button, a')];
        const target = btns.find((b) => {
          const t = (b.textContent || '').trim().toLowerCase();
          return t === 'voir les photos' || t === 'see photos' || t === 'photos';
        });
        if (target) {
          target.click();
          return true;
        }
        return false;
      });
      if (clicked) {
        result.photos_tab_clicked = true;
        await sleep(3_000);
        // Scroll dans la grille (le main panel a un overflow custom)
        for (let i = 0; i < 4; i++) {
          await page.evaluate(() => {
            const candidates = [
              document.querySelector('div[role="main"]'),
              document.querySelector('div.m6QErb'),
              document.scrollingElement,
            ].filter(Boolean);
            for (const c of candidates) c.scrollBy(0, 1200);
          });
          await sleep(1_200);
        }
        photos = await extractPhotos(page);
      }
    }

    result.photos = photos;
    result.photo_count_place = photos.filter((p) => p.kind === 'place').length;
    result.photo_count_ugc = photos.filter((p) => p.kind === 'ugc').length;
  } catch (e) {
    result.error = e.message;
  } finally {
    await page.close().catch(() => {});
    result.timing_ms = Date.now() - t0;
  }
  return result;
}

(async () => {
  mkdirSync('./data', { recursive: true });

  const raw = readFileSync(CSV_PATH, 'utf8');
  const rows = parse(raw, {
    delimiter: '\t',
    columns: true,
    bom: true,
    relax_quotes: true,
    skip_records_with_error: true,
  });
  const sample = rows.filter((r) => r.Lien && r.Lien.startsWith('http')).slice(0, SAMPLE_SIZE);
  console.log(`Sample : ${sample.length} salons sur ${rows.length}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=fr-FR'],
  });

  const results = [];
  for (const [i, salon] of sample.entries()) {
    console.log(`\n[${i + 1}/${sample.length}] ${salon.Nom}`);
    const r = await processSalon(browser, salon);
    console.log(
      `  -> ${r.photos.length} photos (${r.photo_count_place} place + ${r.photo_count_ugc} ugc), ${r.timing_ms}ms` +
        `${r.error ? ', ERROR: ' + r.error : ''}` +
        `${r.consent_seen ? ' [consent]' : ''}` +
        `${r.photos_tab_clicked ? ' [tab-clicked]' : ''}`
    );
    if (r.photos[0]) console.log(`     ex: ${r.photos[0].hero_url}`);
    results.push(r);
    await sleep(2_000 + Math.random() * 2_000);
  }

  await browser.close();

  const counts = results.map((r) => r.photos.length);
  const summary = {
    sample_size: sample.length,
    photos_total: counts.reduce((a, b) => a + b, 0),
    photos_avg: counts.length ? +(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1) : 0,
    photos_median: counts.slice().sort((a, b) => a - b)[Math.floor(counts.length / 2)] || 0,
    photos_min: Math.min(...counts),
    photos_max: Math.max(...counts),
    salons_with_zero: results.filter((r) => r.photos.length === 0).length,
    salons_with_at_least_3: results.filter((r) => r.photos.length >= 3).length,
    salons_with_error: results.filter((r) => r.error).length,
    consent_screens_seen: results.filter((r) => r.consent_seen).length,
    timing_avg_ms: Math.round(results.reduce((a, r) => a + r.timing_ms, 0) / Math.max(1, results.length)),
  };

  console.log('\n=== POC RESULT ===');
  console.log(JSON.stringify(summary, null, 2));

  writeFileSync(OUT_PATH, JSON.stringify({ summary, results }, null, 2));
  console.log(`\nDétail sauvé : ${OUT_PATH}`);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
