// Cœur de l'extraction Google Maps. Reprend la logique du POC (extract-photos.mjs)
// mais factorisée pour usage en worker pool dans batch-runner.js.
//
// Découvertes POC :
// - Le DOM moderne utilise lh{N}.googleusercontent.com/{gps-cs-s|geougc|p}/{ID}=w{W}-h{H}-k-no
//   pas /p/ comme la doc SerpApi 2022.
// - Le HTML brut contient déjà la majorité des photos (médiane 7/salon), pas besoin
//   de cliquer "Voir les photos" la plupart du temps.
// - On filtre les avatars (mo-br100, mo-ba, =w36-h36).
// - URLs permanentes : on stocke l'URL avec resolution paramétrable.

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const RX_PHOTO =
  /https:\/\/lh\d\.googleusercontent\.com\/(?:gps-cs-s|geougc|p)\/[A-Za-z0-9_-]+(?:=[A-Za-z0-9_-]+)?/g;

function isAvatarUrl(url) {
  return /=w36-h36|mo-br100|mo-ba/.test(url);
}

export function toHeroResolution(url, width = 1280, height = 800) {
  const eqIdx = url.indexOf('=');
  if (eqIdx === -1) return `${url}=w${width}-h${height}-k-no`;
  return `${url.slice(0, eqIdx)}=w${width}-h${height}-k-no`;
}

// "Originale" : on demande la résolution maximale (=s0) que Google accepte de servir.
// Pratique côté UI quand l'utilisateur affine son crop — il a tous les pixels.
export function toOriginalResolution(url) {
  const eqIdx = url.indexOf('=');
  return `${eqIdx === -1 ? url : url.slice(0, eqIdx)}=s0`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchBrowser() {
  return await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=fr-FR'],
  });
}

// Extrait les photos d'une page Maps déjà chargée + consentée
async function extractPhotos(page) {
  const html = await page.content();
  const found = new Set();
  for (const m of html.matchAll(RX_PHOTO)) {
    const url = m[0].replace(/&quot;.*$/, '').replace(/\\u003d/g, '=');
    if (!isAvatarUrl(url)) found.add(url);
  }

  const imgs = await page.evaluate(() =>
    [...document.querySelectorAll('img')]
      .map((i) => i.src || i.dataset.src || '')
      .filter((s) => /googleusercontent\.com\/(gps-cs-s|geougc|p)\//.test(s))
  );
  for (const u of imgs) {
    if (!isAvatarUrl(u)) found.add(u);
  }

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

  const byId = new Map();
  let position = 0;
  for (const url of found) {
    const idMatch = url.match(/\/(?:gps-cs-s|geougc|p)\/([A-Za-z0-9_-]+)/);
    if (!idMatch) continue;
    const photoId = idMatch[1];
    if (!byId.has(photoId)) {
      byId.set(photoId, {
        photo_id: photoId,
        kind: url.includes('/gps-cs-s/') ? 'place' : url.includes('/geougc/') ? 'ugc' : 'legacy',
        original_url: url,
        url: toHeroResolution(url),
        position: position++,
      });
    }
  }
  return Array.from(byId.values());
}

// Scrape une URL Google Maps, retourne { photos[], consent_seen, error?, timing_ms }
//
// Stratégie v3 : on clique TOUJOURS sur "Voir les photos" pour ouvrir l'onglet
// dédié du salon — Google y expose uniquement les photos officielles du lieu
// sélectionné, sans contamination par les vignettes du panneau "Établissements
// similaires" / "À proximité" qui pollue le HTML initial (~24% de doublons
// inter-salons observés en v2 quand on extrayait du HTML initial).
//
// Si le bouton "Voir les photos" est absent (salon sans photos), on garde le
// fallback sur le HTML initial — au pire on récupère 0 photo.
export async function scrapeSalon(browser, googleMapsUrl, opts = {}) {
  const {
    navTimeoutMs = 45_000,
    settleMs = 2_500,
    photosTabWaitMs = 3_000,
    photosScrollPasses = 4,
  } = opts;

  const t0 = Date.now();
  const result = {
    photos: [],
    consent_seen: false,
    photos_tab_clicked: false,
    error: null,
    timing_ms: 0,
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

    await page.goto(googleMapsUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });

    // Consent FR
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

    await sleep(settleMs);

    // Étape clé : on ouvre l'onglet "Voir les photos" / "Photos" — c'est la
    // seule façon d'éviter les vignettes parasites du panneau "À proximité".
    // Plusieurs labels selon la locale et la version Google :
    //   FR : "Voir les photos", "Photos"
    //   EN : "See photos", "Photos"
    //   aria-label : "Photo de <Nom du salon>" pour le tile principal
    const clicked = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('button, a, [role="button"]')];
      // 1. Bouton textuel évident
      let target = candidates.find((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        return t === 'voir les photos' || t === 'see photos' || t === 'photos';
      });
      // 2. Fallback : bouton avec jsaction sur heroHeaderImage (cliquer la photo
      //    hero ouvre aussi la galerie complète du salon)
      if (!target) {
        target = candidates.find((b) => {
          const ja = b.getAttribute('jsaction') || '';
          return ja.includes('heroHeaderImage');
        });
      }
      if (target) {
        target.click();
        return true;
      }
      return false;
    });

    if (clicked) {
      result.photos_tab_clicked = true;
      await sleep(photosTabWaitMs);
      // Scroll pour faire charger toutes les vignettes (Google lazy-load)
      for (let i = 0; i < photosScrollPasses; i++) {
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
    }

    // Extraction APRÈS clic+scroll. Si on n'a pas pu cliquer (pas de bouton),
    // on extrait quand même du HTML initial — fallback dégradé : peut contenir
    // des photos parasites, mais c'est mieux que 0.
    result.photos = await extractPhotos(page);
  } catch (e) {
    result.error = e.message;
  } finally {
    await page.close().catch(() => {});
    result.timing_ms = Date.now() - t0;
  }
  return result;
}
