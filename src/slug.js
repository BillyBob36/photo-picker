// Copie de la fonction slugify de outil-coiffure/src/slug-generator.js.
// On ne fait PAS de résolution de collisions ici : la collision suffix vient
// d'outil-coiffure au moment de l'import CSV. Pour matcher un salon photo-picker
// avec son enregistrement en BDD prod, on utilise toujours `google_id` (FID),
// pas le slug.

const ACCENT_MAP = {
  à: 'a', á: 'a', â: 'a', ä: 'a', ã: 'a', å: 'a', ą: 'a',
  è: 'e', é: 'e', ê: 'e', ë: 'e', ę: 'e',
  ì: 'i', í: 'i', î: 'i', ï: 'i',
  ò: 'o', ó: 'o', ô: 'o', ö: 'o', õ: 'o', ø: 'o',
  ù: 'u', ú: 'u', û: 'u', ü: 'u',
  ý: 'y', ÿ: 'y',
  ñ: 'n', ń: 'n',
  ç: 'c', č: 'c',
  ß: 'ss',
  œ: 'oe', æ: 'ae',
};

const MAX_SLUG_LENGTH = 80;

export function slugify(input) {
  if (!input) return '';
  let s = String(input).toLowerCase().trim();
  s = s.replace(/[àáâäãåąèéêëęìíîïòóôöõøùúûüýÿñńçčßœæ]/g, (ch) => ACCENT_MAP[ch] || ch);
  s = s.replace(/&/g, 'et');
  s = s.replace(/[''`]/g, '');
  s = s.replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  s = s.replace(/-+/g, '-');
  return s;
}

export function candidateSlug(nom, ville) {
  const villeSlug = slugify(ville);
  const nomSlug = slugify(nom);
  let base = villeSlug && nomSlug ? `${villeSlug}-${nomSlug}` : villeSlug || nomSlug || 'salon';
  if (base.length > MAX_SLUG_LENGTH) {
    base = base.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
  }
  return base;
}
