// Crop + resize d'une image source vers la résolution hero (1920×1080).
// L'utilisateur a choisi un rectangle (x, y, w, h) en coordonnées du source
// (= les dimensions natives renvoyées par Google quand on demande l'URL =s0).
//
// Sharp gère le download + resize + crop + jpeg en une passe.

import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const HERO_W = 1920;
const HERO_H = 1080;
const JPEG_QUALITY = 85;

// Télécharge l'image source et retourne le Buffer + dimensions réelles.
export async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch ${res.status} sur ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(buf).metadata();
  return { buf, width: meta.width, height: meta.height };
}

// Applique le crop demandé puis resize → 1920×1080 JPEG q85.
// Coordonnées en pixels du source.
export async function cropToHero(sourceBuf, crop) {
  const { x, y, w, h } = crop;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    throw new Error(`Crop invalide: ${JSON.stringify(crop)}`);
  }
  if (w <= 0 || h <= 0) throw new Error('Crop dimensions <= 0');

  return await sharp(sourceBuf)
    .extract({ left: Math.round(x), top: Math.round(y), width: Math.round(w), height: Math.round(h) })
    .resize(HERO_W, HERO_H, { fit: 'cover', position: 'center' })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
}

// Sauvegarde le buffer cropé sur le disque (chemin absolu attendu).
export function saveHeroJpeg(absPath, buf) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, buf);
}

// Helper haut niveau : url → buffer → crop → save.
export async function downloadCropAndSave({ url, crop, outPath }) {
  const { buf, width, height } = await fetchImage(url);
  const out = await cropToHero(buf, crop);
  saveHeroJpeg(outPath, out);
  return { source_width: width, source_height: height, bytes: out.length };
}

export const HERO_DIMENSIONS = { width: HERO_W, height: HERO_H, aspect: HERO_W / HERO_H };
