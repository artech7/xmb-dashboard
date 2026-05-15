const express = require('express');
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');
const http    = require('http');
const https   = require('https');

const app    = express();
const PORT   = process.env.PORT           || 8484;
const PASS   = process.env.ADMIN_PASSWORD || 'admin';
const SECRET = process.env.JWT_SECRET     || 'xmb-change-this-secret';

const DATA_DIR = path.join(__dirname, 'data');
const DATA_CFG = path.join(DATA_DIR,  'config.json');
const SEED_CFG = path.join(__dirname, 'www', 'config.json');

// ── Helpers ───────────────────────────────────────────────────────────────────

const SYSTEM_ITEMS = [
  { name: 'Preferences', url: '#prefs', desc: 'Theme, display & motion', icon: 'edit' },
  { name: 'Admin Panel', url: '#admin', desc: 'Edit dashboard settings', icon: 'edit' },
];

function ensureSystemItems(cfg) {
  const settingsCat = cfg.categories.find(c =>
    c.id === 'settings' || c.items.some(i => i.url === '#admin' || i.url === '#prefs')
  );
  if (!settingsCat) return cfg;

  let changed = false;
  [...SYSTEM_ITEMS].reverse().forEach(sysItem => {
    if (!settingsCat.items.some(i => i.url === sysItem.url)) {
      settingsCat.items.unshift(sysItem);
      changed = true;
      console.log('Injected missing system item:', sysItem.name);
    }
  });

  if (changed) writeConfig(cfg);
  return cfg;
}

let _configCache = null;

function readConfig() {
  if (_configCache) return _configCache;
  let cfg;
  if (fs.existsSync(DATA_CFG)) {
    cfg = JSON.parse(fs.readFileSync(DATA_CFG, 'utf8'));
  } else {
    cfg = JSON.parse(fs.readFileSync(SEED_CFG, 'utf8'));
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_CFG, JSON.stringify(cfg, null, 2));
    console.log('First boot: seeded config to', DATA_CFG);
  }
  _configCache = ensureSystemItems(cfg);
  return _configCache;
}

function writeConfig(cfg) {
  _configCache = null; // invalidate cache
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_CFG, JSON.stringify(cfg, null, 2));
  console.log('Config saved to', DATA_CFG, '—', cfg.categories.length, 'categories');
}

function filterForNonAdmin(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  out.categories = out.categories
    .filter(cat => !cat.adminOnly)
    .map(cat => ({
      ...cat,
      items: cat.items.filter(item => !item.adminOnly)
    }));
  return out;
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(header.slice(7), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalid or expired' });
  }
}

// ── Subsonic proxy helper ─────────────────────────────────────────────────────

function subsonicRequest(subsonicCfg, endpoint, params, res) {
  const { url, username, password } = subsonicCfg;
  if (!url || !username || !password) {
    return res.status(400).json({ error: 'Subsonic not configured' });
  }

  const base   = url.replace(/\/$/, '');
  const qp     = new URLSearchParams({
    u: username,
    p: password,
    v: '1.16.1',
    c: 'xmb-dashboard',
    f: 'json',
    ...params,
  });
  const fullUrl = `${base}/rest/${endpoint}?${qp.toString()}`;

  const lib = fullUrl.startsWith('https') ? https : http;
  const req2 = lib.get(fullUrl, (r2) => {
    let data = '';
    r2.on('data', chunk => data += chunk);
    r2.on('end', () => {
      try {
        const json = JSON.parse(data);
        res.json(json['subsonic-response'] || json);
      } catch {
        res.status(502).json({ error: 'Bad response from Subsonic' });
      }
    });
  });
  req2.on('error', err => res.status(502).json({ error: err.message }));
  req2.setTimeout(8000, () => { req2.destroy(); res.status(504).json({ error: 'Timeout' }); });
}

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json({ limit: '16mb' }));
app.use(express.static(path.join(__dirname, 'www')));

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  const cfg = readConfig();
  const header = req.headers.authorization || '';
  let isAdmin = false;
  if (header.startsWith('Bearer ')) {
    try { jwt.verify(header.slice(7), SECRET); isAdmin = true; } catch {}
  }
  // Strip subsonic password from non-admin response
  const out = isAdmin ? cfg : filterForNonAdmin(cfg);
  if (!isAdmin && out.subsonic) { delete out.subsonic.password; }
  res.json(out);
});

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (!password || password !== PASS) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = jwt.sign({ admin: true }, SECRET, { expiresIn: '8h' });
  res.json({ token });
});

app.put('/api/config', auth, (req, res) => {
  const cfg = req.body;
  if (!cfg || !Array.isArray(cfg.categories)) {
    return res.status(400).json({ error: 'Invalid config structure' });
  }
  try {
    writeConfig(cfg);
    res.json({ ok: true });
  } catch (err) {
    console.error('Failed to write config:', err.message);
    res.status(500).json({ error: 'Failed to save: ' + err.message });
  }
});

app.get('/api/verify', auth, (_req, res) => res.json({ ok: true }));

// ── Subsonic proxy routes ─────────────────────────────────────────────────────

// Test connection — accepts credentials from query params OR saved config
app.get('/api/subsonic/ping', auth, (req, res) => {
  const cfg = readConfig();
  const sub = {
    url:      req.query.url      || (cfg.subsonic && cfg.subsonic.url)      || '',
    username: req.query.username || (cfg.subsonic && cfg.subsonic.username) || '',
    password: req.query.password || (cfg.subsonic && cfg.subsonic.password) || '',
  };
  subsonicRequest(sub, 'ping', {}, res);
});

app.get('/api/subsonic/artists', (req, res) => {
  const cfg = readConfig();
  subsonicRequest(cfg.subsonic || {}, 'getArtists', {}, res);
});

app.get('/api/subsonic/artist', (req, res) => {
  const cfg = readConfig();
  subsonicRequest(cfg.subsonic || {}, 'getArtist', { id: req.query.id }, res);
});

app.get('/api/subsonic/album', (req, res) => {
  const cfg = readConfig();
  subsonicRequest(cfg.subsonic || {}, 'getAlbum', { id: req.query.id }, res);
});

app.get('/api/subsonic/playlists', (req, res) => {
  const cfg = readConfig();
  subsonicRequest(cfg.subsonic || {}, 'getPlaylists', {}, res);
});

app.get('/api/subsonic/playlist', (req, res) => {
  const cfg = readConfig();
  subsonicRequest(cfg.subsonic || {}, 'getPlaylist', { id: req.query.id }, res);
});

app.get('/api/subsonic/genres', (req, res) => {
  const cfg = readConfig();
  subsonicRequest(cfg.subsonic || {}, 'getGenres', {}, res);
});

app.get('/api/subsonic/bygenre', (req, res) => {
  const cfg = readConfig();
  subsonicRequest(cfg.subsonic || {}, 'getSongsByGenre', { genre: req.query.genre, count: 500 }, res);
});

// Stream proxy — pipes audio through server so we don't expose credentials to client
app.get('/api/subsonic/stream', (req, res) => {
  const cfg = readConfig();
  const { url, username, password } = cfg.subsonic || {};
  if (!url || !username || !password) return res.status(400).send('Not configured');

  const base   = url.replace(/\/$/, '');
  const qp     = new URLSearchParams({ u: username, p: password, v: '1.16.1', c: 'xmb-dashboard', id: req.query.id });
  const fullUrl = `${base}/rest/stream?${qp.toString()}`;

  const lib = fullUrl.startsWith('https') ? https : http;
  lib.get(fullUrl, (r2) => {
    res.setHeader('Content-Type', r2.headers['content-type'] || 'audio/mpeg');
    if (r2.headers['content-length']) res.setHeader('Content-Length', r2.headers['content-length']);
    r2.pipe(res);
  }).on('error', err => res.status(502).send(err.message));
});

// Cover art proxy
app.get('/api/subsonic/coverart', (req, res) => {
  const cfg = readConfig();
  const { url, username, password } = cfg.subsonic || {};
  if (!url || !username || !password) return res.status(400).send('Not configured');

  const base   = url.replace(/\/$/, '');
  const qp     = new URLSearchParams({ u: username, p: password, v: '1.16.1', c: 'xmb-dashboard', id: req.query.id, size: 64 });
  const fullUrl = `${base}/rest/getCoverArt?${qp.toString()}`;

  const lib = fullUrl.startsWith('https') ? https : http;
  lib.get(fullUrl, (r2) => {
    res.setHeader('Content-Type', r2.headers['content-type'] || 'image/jpeg');
    r2.pipe(res);
  }).on('error', err => res.status(502).send(err.message));
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`XMB Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`Config path: ${DATA_CFG}`);
  console.log(`Admin password: ${PASS === 'admin' ? '⚠️  default "admin" — set ADMIN_PASSWORD' : '(custom)'}`);
});
