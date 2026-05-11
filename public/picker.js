// Photo Picker SPA — vanilla JS module.
// Charge le prochain salon, affiche la grille des photos, modale crop, sync via /api/pick.

const $ = (sel) => document.querySelector(sel);

const state = {
  current: null,           // { salon, photos, hero_dimensions }
  cropper: null,           // instance Cropper.js
  currentPhotoIndex: 0,    // index dans state.current.photos
  heroAspect: 16 / 9,      // sera mis à jour à partir de hero_dimensions
};

// --- API ---

async function api(method, path, body) {
  const opts = { method, headers: { 'Accept': 'application/json' } };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('unauthorized');
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

// --- Stats badge ---

async function refreshStats() {
  try {
    const s = await api('GET', '/api/stats');
    const by = s.by_status || {};
    const total = s.total_salons || 0;
    const picked = by.picked || 0;
    const skipped = by.skipped || 0;
    const remaining = by.fetched || 0;
    const noPhotos = by.no_photos || 0;
    $('#stats').textContent =
      `${picked} validés · ${skipped} skip · ${remaining} en attente · ${noPhotos} sans photo · ${total} total`;
  } catch (e) {
    $('#stats').textContent = '(stats: ' + e.message + ')';
  }
}

// --- Salon courant ---

async function loadNext() {
  show('loader');
  $('#stats').textContent = 'chargement…';
  try {
    const data = await api('GET', '/api/next');
    if (data.done) {
      show('done-screen');
      await refreshStats();
      return;
    }
    state.current = data;
    if (data.hero_dimensions) {
      state.heroAspect = data.hero_dimensions.aspect;
    }
    renderPicker();
    show('picker');
    await refreshStats();
  } catch (e) {
    show('loader');
    $('#loader').innerHTML = `<p class="error">Erreur: ${e.message}</p><button onclick="location.reload()">Recharger</button>`;
  }
}

function renderPicker() {
  const { salon, photos } = state.current;
  $('#salon-name').textContent = salon.nom;
  const addressParts = [salon.adresse, salon.code_postal, salon.ville].filter(Boolean).join(', ');
  $('#salon-address').textContent = addressParts || '(pas d\'adresse)';
  $('#salon-maps').href = salon.google_maps_url;
  $('#salon-source').textContent = salon.csv_source || 'inconnu';

  const grid = $('#photos-grid');
  grid.innerHTML = '';
  photos.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'photo-card';
    card.dataset.photoId = p.photo_id;
    card.dataset.index = i;
    card.innerHTML = `
      <img src="${p.url}" alt="" loading="lazy">
      <span class="num">${i + 1}</span>
      <span class="kind">${p.kind}</span>
    `;
    card.addEventListener('click', () => openCropModal(i));
    grid.appendChild(card);
  });
}

function show(sectionId) {
  for (const id of ['loader', 'done-screen', 'picker']) {
    document.getElementById(id).hidden = id !== sectionId;
  }
}

// --- Modale crop ---

function openCropModal(photoIndex) {
  state.currentPhotoIndex = photoIndex;
  $('#crop-modal').hidden = false;
  $('#crop-status').hidden = true;
  loadCurrentPhoto();
}

// Charge la photo à state.currentPhotoIndex dans la modale.
// Détruit le Cropper précédent et en crée un nouveau au chargement.
// On sert l'image via /proxy-image pour éviter le CORS de Google CDN (Cropper.js
// force crossOrigin="anonymous" par défaut, et lh3.googleusercontent.com ne renvoie
// pas Access-Control-Allow-Origin → image bloquée. Avec le proxy = same-origin.)
function loadCurrentPhoto() {
  const photo = state.current.photos[state.currentPhotoIndex];
  const total = state.current.photos.length;
  $('#crop-counter').textContent = `Photo ${state.currentPhotoIndex + 1} / ${total}`;
  $('#crop-prev').disabled = total <= 1;
  $('#crop-next').disabled = total <= 1;

  const sourceUrl = toOriginalRes(photo.original_url);
  const proxiedUrl = '/proxy-image?url=' + encodeURIComponent(sourceUrl);

  if (state.cropper) {
    state.cropper.destroy();
    state.cropper = null;
  }

  const img = $('#crop-img');
  const initCropper = () => {
    // Double rAF : 1er = browser termine le paint en cours, 2e = layout de
    // la modale (qui vient juste d'être affichée) garanti calculé. Sans ça,
    // Cropper.js voit parfois une zone parent de 0 px au tout 1er open et
    // ne s'affiche pas (apparu en prod chez utilisateurs après refresh).
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (state.cropper) return; // déjà initialisé (navigation rapide)
      state.cropper = new Cropper(img, {
        aspectRatio: state.heroAspect,
        viewMode: 1,
        autoCropArea: 0.9,
        background: false,
        movable: true,
        zoomable: true,
        scalable: false,
        rotatable: false,
        cropBoxResizable: true,
        checkCrossOrigin: false,
      });
    }));
  };
  img.onload = initCropper;
  img.onerror = () => {
    setStatus("Impossible de charger l'image. Essaie une autre photo (← / →).", 'error');
  };
  img.src = proxiedUrl;
  // Cas image en cache navigateur : onload peut ne pas se déclencher.
  // Si l'image est déjà chargée à ce point, on init manuellement.
  if (img.complete && img.naturalWidth > 0) {
    initCropper();
  }
}

// Navigation circulaire entre les photos du salon courant.
function navPhoto(delta) {
  if (!state.current || !state.current.photos.length) return;
  const n = state.current.photos.length;
  state.currentPhotoIndex = (state.currentPhotoIndex + delta + n) % n;
  loadCurrentPhoto();
}

function closeCropModal() {
  $('#crop-modal').hidden = true;
  if (state.cropper) {
    state.cropper.destroy();
    state.cropper = null;
  }
}

function toOriginalRes(url) {
  const eq = url.indexOf('=');
  return eq === -1 ? url + '=s0' : url.slice(0, eq) + '=s0';
}

async function confirmCrop() {
  if (!state.cropper || !state.current) return;
  const cropData = state.cropper.getData(true); // true = round to integers
  const photo = state.current.photos[state.currentPhotoIndex];
  const salon = state.current.salon;

  setStatus('Validation en cours… (download, crop, mise à jour DB, recapture screenshot — 10-20s)', 'loading');
  $('#crop-confirm').disabled = true;
  $('#crop-cancel').disabled = true;

  try {
    const result = await api('POST', '/api/pick', {
      salon_id: salon.id,
      photo_id: photo.photo_id,
      crop: { x: cropData.x, y: cropData.y, w: cropData.width, h: cropData.height },
    });
    setStatus(
      `✓ Hero appliqué sur ${result.sync.slug}. Screenshot ` +
        (result.sync.screenshot ? 'recapturée.' : '⚠️ recapture échouée : ' + (result.sync.screenshot_error || 'n/a')),
      result.sync.screenshot ? 'success' : 'error'
    );
    setTimeout(() => {
      closeCropModal();
      loadNext();
    }, 1500);
  } catch (e) {
    setStatus('Erreur : ' + e.message, 'error');
  } finally {
    $('#crop-confirm').disabled = false;
    $('#crop-cancel').disabled = false;
  }
}

function setStatus(text, kind) {
  const el = $('#crop-status');
  el.textContent = text;
  el.className = 'status ' + (kind || '');
  el.hidden = false;
}

// --- Garder l'image par défaut ---

async function keepDefault() {
  if (!state.current) return;
  setStatus('Application…', 'loading');
  $('#keep-default').disabled = true;
  $('#crop-confirm').disabled = true;
  try {
    const r = await api('POST', '/api/keep-default', { salon_id: state.current.salon.id });
    const screenshotMsg = {
      captured: 'screenshot recapturée',
      skipped_already_exists: 'screenshot existante conservée',
      no_outil_match: 'salon non trouvé dans outil-coiffure (sync DB skip)',
      error: 'screenshot ÉCHEC : ' + (r.screenshot_error || 'n/a'),
    }[r.screenshot_action] || r.screenshot_action;
    setStatus(
      `✓ Image par défaut conservée (${screenshotMsg}).`,
      r.screenshot_action === 'error' ? 'error' : 'success'
    );
    setTimeout(() => {
      closeCropModal();
      loadNext();
    }, 1200);
  } catch (e) {
    setStatus('Erreur : ' + e.message, 'error');
  } finally {
    $('#keep-default').disabled = false;
    $('#crop-confirm').disabled = false;
  }
}

// --- Skip ---

async function skipSalon() {
  if (!state.current) return;
  try {
    await api('POST', '/api/skip', { salon_id: state.current.salon.id });
    await loadNext();
  } catch (e) {
    alert('Erreur: ' + e.message);
  }
}

// --- Logout ---

async function logout() {
  await api('POST', '/logout');
  location.href = '/login';
}

// --- Raccourcis clavier ---

document.addEventListener('keydown', (e) => {
  // Si modale ouverte
  if (!$('#crop-modal').hidden) {
    if (e.key === 'Escape') {
      closeCropModal();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      navPhoto(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      navPhoto(1);
    } else if (e.key.toLowerCase() === 'd' && !e.ctrlKey && !e.metaKey) {
      // 'd' seul = "Garder l'image par défaut"
      e.preventDefault();
      keepDefault();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      confirmCrop();
    }
    return;
  }
  // Sinon, picker actif (grille)
  if ($('#picker').hidden) return;
  if (e.key >= '1' && e.key <= '9') {
    const idx = parseInt(e.key, 10) - 1;
    const photos = state.current?.photos || [];
    if (photos[idx]) openCropModal(idx);
  } else if (e.key.toLowerCase() === 's') {
    skipSalon();
  }
});

// --- Init ---

$('#skip-btn').addEventListener('click', skipSalon);
$('#logout').addEventListener('click', logout);
$('#refresh').addEventListener('click', loadNext);
$('#crop-close').addEventListener('click', closeCropModal);
$('#crop-cancel').addEventListener('click', closeCropModal);
$('#crop-confirm').addEventListener('click', confirmCrop);
$('#crop-prev').addEventListener('click', () => navPhoto(-1));
$('#crop-next').addEventListener('click', () => navPhoto(1));
$('#keep-default').addEventListener('click', keepDefault);

// Affiche le nom de l'utilisateur connecté
api('GET', '/whoami').then((r) => {
  if (r.authenticated) $('#user').textContent = r.name;
});

loadNext();
