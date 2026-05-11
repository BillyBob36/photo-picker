// Auth simple : mot de passe unique dans .env, session côté serveur.
// Utilisé par tous tes amis qui viennent t'aider à swiper.

const PICKER_PASSWORD = process.env.PICKER_PASSWORD;

if (!PICKER_PASSWORD) {
  console.warn('[auth] PICKER_PASSWORD non défini — l\'app ne peut pas démarrer en mode authentifié');
}

export function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  const acceptsJson = (req.headers.accept || '').includes('application/json');
  if (acceptsJson || req.headers['sec-fetch-mode'] === 'cors') {
    return res.status(401).json({ error: 'not authenticated' });
  }
  return res.redirect('/login');
}

export function loginHandler(req, res) {
  const { password, name } = req.body || {};
  if (!PICKER_PASSWORD) return res.status(500).json({ error: 'server not configured' });
  if (password !== PICKER_PASSWORD) {
    return res.status(401).json({ error: 'mot de passe invalide' });
  }
  req.session.authenticated = true;
  req.session.user_name = (name || 'anon').slice(0, 40);
  req.session.ip = req.ip;
  res.json({ ok: true, name: req.session.user_name });
}

export function logoutHandler(req, res) {
  req.session.destroy(() => res.json({ ok: true }));
}

export function whoamiHandler(req, res) {
  if (req.session && req.session.authenticated) {
    return res.json({ authenticated: true, name: req.session.user_name });
  }
  res.json({ authenticated: false });
}
