// Debug : charge 1 salon, dump HTML + screenshot + liste TOUS les liens googleusercontent.
// Objectif = comprendre pourquoi le POC retourne 0 photos.

import { writeFileSync, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const CSV_PATH = '../exports-scrap.io/coiffeur-france-auvergne-rhone-alpes-ain.csv';
const OUT_DIR = './data';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  mkdirSync(OUT_DIR, { recursive: true });

  const raw = readFileSync(CSV_PATH, 'utf8');
  const rows = parse(raw, {
    delimiter: '\t',
    columns: true,
    bom: true,
    relax_quotes: true,
    skip_records_with_error: true,
  });
  // Salon #2 (DESSANGE) — chaîne connue, sûr d'avoir des photos
  const salon = rows.find((r) => r.Nom && r.Nom.includes('DESSANGE')) || rows[1];
  console.log('Salon:', salon.Nom);
  console.log('Lien:', salon.Lien);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=fr-FR'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9' });

  console.log('Navigation...');
  await page.goto(salon.Lien, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await sleep(2_000);

  // Détecte consent
  const url1 = page.url();
  console.log('URL après navigation:', url1);

  // Tente d'accepter le consent (FR)
  const consentClicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, [role="button"]')];
    const acc = btns.find((b) => {
      const t = (b.textContent || '').trim().toLowerCase();
      const al = (b.getAttribute('aria-label') || '').toLowerCase();
      return t.includes('accepter') || t === 'tout accepter' || al.includes('tout accepter') || al.includes('accept all');
    });
    if (acc) {
      acc.click();
      return acc.textContent.trim();
    }
    return null;
  });
  console.log('Consent button cliqué:', consentClicked);

  if (consentClicked) {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    await sleep(3_000);
  }

  const url2 = page.url();
  console.log('URL finale:', url2);

  // Compte les iframes (parfois Maps embarque le résultat)
  const iframes = await page.$$('iframe');
  console.log('Iframes:', iframes.length);

  // Dump le HTML principal
  const html = await page.content();
  writeFileSync(`${OUT_DIR}/debug-main.html`, html);
  console.log(`HTML main : ${html.length} bytes -> ${OUT_DIR}/debug-main.html`);

  // Compte les occurrences de googleusercontent dans le HTML
  const ucMatches = html.match(/lh\d\.googleusercontent\.com\/p\/[A-Za-z0-9_-]+/g) || [];
  console.log('Occurrences lh{n}.googleusercontent.com/p/ :', ucMatches.length);
  const uniqIds = [...new Set(ucMatches.map((u) => u.match(/\/p\/([A-Za-z0-9_-]+)/)[1]))];
  console.log('IDs photos uniques :', uniqIds.length);
  console.log('Premiers IDs :', uniqIds.slice(0, 5));

  // Dump aussi le contenu des iframes le cas échéant
  for (const [i, fr] of iframes.entries()) {
    try {
      const f = await fr.contentFrame();
      if (!f) continue;
      const fhtml = await f.content();
      writeFileSync(`${OUT_DIR}/debug-iframe-${i}.html`, fhtml);
      const fm = fhtml.match(/lh\d\.googleusercontent\.com\/p\/[A-Za-z0-9_-]+/g) || [];
      console.log(`iframe[${i}] : ${fhtml.length} bytes, ${fm.length} photo URLs`);
    } catch (e) {
      console.log(`iframe[${i}] inaccessible : ${e.message}`);
    }
  }

  await page.screenshot({ path: `${OUT_DIR}/debug-screenshot.png`, fullPage: false });
  console.log(`Screenshot -> ${OUT_DIR}/debug-screenshot.png`);

  // Liste les boutons cliquables avec texte "Photos" ou similaire
  const tabs = await page.evaluate(() => {
    return [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')]
      .map((el) => ({
        tag: el.tagName,
        text: (el.textContent || '').trim().slice(0, 60),
        aria: el.getAttribute('aria-label') || '',
        jsaction: (el.getAttribute('jsaction') || '').slice(0, 80),
      }))
      .filter(
        (x) =>
          /photo/i.test(x.text) ||
          /photo/i.test(x.aria) ||
          /hero/i.test(x.jsaction)
      )
      .slice(0, 20);
  });
  console.log('Tabs/boutons "photo" :', JSON.stringify(tabs, null, 2));

  await browser.close();
  console.log('DONE');
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
