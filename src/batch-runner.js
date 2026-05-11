// Worker pool : N browsers Puppeteer en parallèle, chacun pioche un salon
// pending et écrit les photos dans la DB. Recyclage proactif après K salons
// (évite les fuites memoire des sessions Chromium longues).

import db from './db.js';
import { launchBrowser, scrapeSalon } from './scraper.js';

const BROWSER_RECYCLE_EVERY = 20; // ferme + relance un browser tous les 20 salons

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Picks the next pending salon and atomically marks it as in-progress
// to prevent two workers grabbing the same row.
function claimNextPending(filter = {}) {
  // Atomic claim via UPDATE ... RETURNING (better-sqlite3 supporte RETURNING)
  const where = ["status = 'pending'", 'photos_fetched_at IS NULL'];
  const params = [];
  if (filter.csv_source) {
    where.push('csv_source = ?');
    params.push(filter.csv_source);
  }
  const sql = `
    UPDATE salons
    SET status = 'fetching'
    WHERE id = (
      SELECT id FROM salons WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT 1
    )
    RETURNING id, google_id, nom, google_maps_url
  `;
  return db.prepare(sql).get(...params);
}

function saveResult(salonId, result) {
  const tx = db.transaction(() => {
    const status = result.error
      ? 'pending' // on remet en pending pour qu'on puisse retry plus tard
      : result.photos.length === 0
        ? 'no_photos'
        : 'fetched';

    db.prepare(
      `UPDATE salons
       SET photos_fetched_at = datetime('now'),
           photos_count = ?,
           fetch_error = ?,
           consent_screen_seen = ?,
           status = ?
       WHERE id = ?`
    ).run(
      result.photos.length,
      result.error || null,
      result.consent_seen ? 1 : 0,
      status,
      salonId
    );

    if (result.photos.length > 0) {
      // Delete + insert pour idempotence (au cas où on retry un salon)
      db.prepare('DELETE FROM salon_photos WHERE salon_id = ?').run(salonId);
      const ins = db.prepare(
        `INSERT INTO salon_photos (salon_id, photo_id, kind, url, original_url, position)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const p of result.photos) {
        ins.run(salonId, p.photo_id, p.kind, p.url, p.original_url, p.position);
      }
    }
  });
  tx();
}

async function worker(workerId, opts) {
  const { delayMs, filter, onProgress } = opts;
  let browser = await launchBrowser();
  let processed = 0;

  while (true) {
    const salon = claimNextPending(filter);
    if (!salon) {
      // Plus rien à faire
      break;
    }

    const r = await scrapeSalon(browser, salon.google_maps_url);
    saveResult(salon.id, r);
    processed++;

    if (onProgress) onProgress({ workerId, salonId: salon.id, salonNom: salon.nom, result: r });

    // Recycle le browser périodiquement
    if (processed % BROWSER_RECYCLE_EVERY === 0) {
      await browser.close().catch(() => {});
      browser = await launchBrowser();
    }

    // Anti-rate-limit
    if (delayMs > 0) await sleep(delayMs + Math.floor(Math.random() * 1000));
  }

  await browser.close().catch(() => {});
  return processed;
}

export async function runBatch(opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || 4);
  const delayMs = Math.max(0, opts.delayMs ?? 2000);
  const filter = {
    csv_source: opts.csvSource || null,
  };

  // Compte initial pour reporting
  const pending = db
    .prepare(
      `SELECT COUNT(*) AS c FROM salons
       WHERE status = 'pending' AND photos_fetched_at IS NULL
       ${filter.csv_source ? 'AND csv_source = ?' : ''}`
    )
    .get(...(filter.csv_source ? [filter.csv_source] : ['']).filter(Boolean));
  const totalPending = pending?.c || 0;
  if (totalPending === 0) {
    console.log('Aucun salon en attente de scrape.');
    return { processed: 0, totalPending };
  }

  const startedAt = Date.now();
  let done = 0;
  const onProgress = ({ salonId, salonNom, result }) => {
    done++;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    const rate = (done / (Date.now() - startedAt)) * 60_000;
    const eta = ((totalPending - done) / Math.max(0.1, rate / 60_000)).toFixed(0);
    console.log(
      `[${done}/${totalPending}] (${elapsed}s, ~${rate.toFixed(1)}/min, ETA ~${eta}s) ` +
        `salon #${salonId} "${(salonNom || '').slice(0, 50)}" → ${result.photos.length} photos` +
        `${result.error ? ' ERROR: ' + result.error : ''}`
    );
  };

  const workers = Array.from({ length: concurrency }, (_, i) =>
    worker(i, { delayMs, filter, onProgress })
  );
  const counts = await Promise.all(workers);
  const total = counts.reduce((a, b) => a + b, 0);

  return { processed: total, totalPending, durationMs: Date.now() - startedAt };
}
