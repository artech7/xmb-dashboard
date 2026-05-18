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
    // Preserve server-side secrets that clients don't hold
    const existing = readConfig();
    if (existing.abs && existing.abs.token && cfg.abs) {
      cfg.abs.token = existing.abs.token; // never let client overwrite the token
    }
    if (existing.subsonic && existing.subsonic.password && cfg.subsonic && !cfg.subsonic.password) {
      cfg.subsonic.password = existing.subsonic.password;
    }
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

// Cover art proxy — with long-lived browser cache
app.get('/api/subsonic/coverart', (req, res) => {
  const cfg = readConfig();
  const { url, username, password } = cfg.subsonic || {};
  if (!url || !username || !password) return res.status(400).send('Not configured');

  const base    = url.replace(/\/$/, '');
  const size    = req.query.size || 300;
  const qp      = new URLSearchParams({ u: username, p: password, v: '1.16.1', c: 'xmb-dashboard', id: req.query.id, size });
  const fullUrl = `${base}/rest/getCoverArt?${qp.toString()}`;

  const lib = fullUrl.startsWith('https') ? https : http;
  const req2 = lib.get(fullUrl, (r2) => {
    if (r2.statusCode !== 200) {
      res.status(r2.statusCode || 502).send('Cover art fetch failed');
      return;
    }
    res.setHeader('Content-Type', r2.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable'); // 7 days
    res.setHeader('ETag', `"cover-${req.query.id}-${size}"`);
    r2.pipe(res);
  }).on('error', err => { if (!res.headersSent) res.status(502).send(err.message); });
  req2.setTimeout(8000, () => { req2.destroy(); if (!res.headersSent) res.status(504).send('Timeout'); });
});


// Direct stream URL — returns a pre-authenticated Navidrome URL
// Browser streams directly from Navidrome, bypassing Node proxy
app.get('/api/subsonic/streamurl', (req, res) => {
  const cfg = readConfig();
  const { url, username, password } = cfg.subsonic || {};
  if (!url || !username || !password) return res.status(400).json({ error: 'Not configured' });
  const base = url.replace(/\/$/, '');
  const qp   = new URLSearchParams({ u: username, p: password, v: '1.16.1', c: 'xmb-dashboard', id: req.query.id });
  res.json({ url: `${base}/rest/stream?${qp.toString()}` });
});

// Direct cover art URL — same idea
app.get('/api/subsonic/coverurl', (req, res) => {
  const cfg = readConfig();
  const { url, username, password } = cfg.subsonic || {};
  if (!url || !username || !password) return res.status(400).json({ error: 'Not configured' });
  const base = url.replace(/\/$/, '');
  const qp   = new URLSearchParams({ u: username, p: password, v: '1.16.1', c: 'xmb-dashboard', id: req.query.id, size: 300 });
  res.json({ url: `${base}/rest/getCoverArt?${qp.toString()}` });
});


// ── AudiobookShelf proxy ───────────────────────────────────────────────────────

function absRequest(absCfg, method, endpoint, body, res) {
  const { url, token } = absCfg;
  if (!url || !token) return res.status(400).json({ error: 'ABS not configured' });
  const base    = url.replace(/\/$/, '');
  const fullUrl = `${base}${endpoint}`;
  const lib     = fullUrl.startsWith('https') ? https : http;
  const opts    = {
    method: method || 'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  };
  const urlObj  = new URL(fullUrl);
  const reqOpts = { ...opts, hostname: urlObj.hostname, port: urlObj.port || (fullUrl.startsWith('https') ? 443 : 80), path: urlObj.pathname + urlObj.search };
  const req2    = lib.request(reqOpts, (r2) => {
    let data = '';
    r2.on('data', chunk => data += chunk);
    r2.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch { res.status(502).json({ error: 'Bad response from ABS' }); }
    });
  });
  req2.on('error', err => { if (!res.headersSent) res.status(502).json({ error: err.message }); });
  req2.setTimeout(10000, () => { req2.destroy(); if (!res.headersSent) res.status(504).json({ error: 'Timeout' }); });
  if (body) req2.write(JSON.stringify(body));
  req2.end();
}

// Login — returns token
app.post('/api/abs/login', auth, (req, res) => {
  const { url, username, password, categoryId } = req.body || {};
  if (!url || !username || !password) return res.status(400).json({ error: 'Missing credentials' });
  const base    = url.replace(/\/$/, '');
  const fullUrl = `${base}/login`;
  const lib     = fullUrl.startsWith('https') ? https : http;
  const body    = JSON.stringify({ username, password });
  const urlObj  = new URL(fullUrl);
  const reqOpts = {
    method: 'POST', hostname: urlObj.hostname,
    port: parseInt(urlObj.port) || (fullUrl.startsWith('https') ? 443 : 80),
    path: urlObj.pathname,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  const req2 = lib.request(reqOpts, (r2) => {
    let data = '';
    r2.on('data', chunk => data += chunk);
    r2.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.user && json.user.token) {
          // Save token to config
          const cfg = readConfig();
          if (!cfg.abs) cfg.abs = {};
          cfg.abs.token      = json.user.token;
          cfg.abs.url        = url;
          cfg.abs.username   = username;
          if (categoryId) cfg.abs.categoryId = categoryId;
          writeConfig(cfg);
          res.json({ ok: true, token: json.user.token });
        } else {
          res.status(401).json({ error: json.error || 'Login failed' });
        }
      } catch { res.status(502).json({ error: 'Bad response' }); }
    });
  });
  req2.on('error', err => res.status(502).json({ error: err.message }));
  req2.write(body);
  req2.end();
});

// Ping - test connection with current saved config
app.get('/api/abs/ping', auth, (req, res) => {
  const cfg = readConfig();
  const abs = cfg.abs || {};
  if (!abs.url || !abs.token) return res.status(400).json({ error: 'ABS not configured — save credentials first' });
  absRequest(abs, 'GET', '/api/libraries', null, res);
});

app.get('/api/abs/libraries', (req, res) => {
  const cfg = readConfig();
  absRequest(cfg.abs || {}, 'GET', '/api/libraries', null, res);
});

app.get('/api/abs/library/:id/items', (req, res) => {
  const cfg    = readConfig();
  const limit  = req.query.limit || 100;
  const page   = req.query.page  || 0;
  const sort   = req.query.sort  || 'media.metadata.title';
  const desc   = req.query.desc  || '0';
  absRequest(cfg.abs || {}, 'GET', `/api/libraries/${req.params.id}/items?limit=${limit}&page=${page}&sort=${sort}&desc=${desc}`, null, res);
});

app.get('/api/abs/item/:id', (req, res) => {
  const cfg = readConfig();
  absRequest(cfg.abs || {}, 'GET', `/api/items/${req.params.id}?expanded=1`, null, res);
});

app.get('/api/abs/episode/:itemId/:episodeId', (req, res) => {
  const cfg = readConfig();
  absRequest(cfg.abs || {}, 'GET', `/api/items/${req.params.itemId}?expanded=1`, null, res);
});

// Stream proxy for ABS audio
app.get('/api/abs/stream/:id', (req, res) => {
  const cfg  = readConfig();
  const { url, token } = cfg.abs || {};
  if (!url || !token) return res.status(400).send('ABS not configured');
  // episode param for podcast episodes
  const ep      = req.query.episode || '';
  const path    = ep ? `/api/items/${req.params.id}/file?episode=${ep}&token=${token}` : `/api/items/${req.params.id}/file?token=${token}`;
  const fullUrl = url.replace(/\/$/, '') + path;
  const lib     = fullUrl.startsWith('https') ? https : http;
  lib.get(fullUrl, (r2) => {
    res.setHeader('Content-Type', r2.headers['content-type'] || 'audio/mpeg');
    if (r2.headers['content-length']) res.setHeader('Content-Length', r2.headers['content-length']);
    if (r2.headers['content-range'])  res.setHeader('Content-Range', r2.headers['content-range']);
    r2.pipe(res);
  }).on('error', err => { if (!res.headersSent) res.status(502).send(err.message); });
});

// Cover art proxy for ABS
app.get('/api/abs/cover/:id', (req, res) => {
  const cfg  = readConfig();
  const { url, token } = cfg.abs || {};
  if (!url || !token) return res.status(400).send('Not configured');
  const fullUrl = `${url.replace(/\/$/, '')}/api/items/${req.params.id}/cover?token=${token}&width=300`;
  const lib     = fullUrl.startsWith('https') ? https : http;
  lib.get(fullUrl, (r2) => {
    res.setHeader('Content-Type', r2.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    r2.pipe(res);
  }).on('error', err => { if (!res.headersSent) res.status(502).send(err.message); });
});

// Direct stream URL (bypass proxy)
app.get('/api/abs/streamurl/:id', auth, (req, res) => {
  const cfg  = readConfig();
  const { url, token } = cfg.abs || {};
  if (!url || !token) return res.status(400).json({ error: 'Not configured' });
  const ep  = req.query.episode || '';
  const base = url.replace(/\/$/, '');

  // For episodes, direct file URL works fine
  if (ep) {
    return res.json({ url: `${base}/api/items/${req.params.id}/file?episode=${ep}&token=${token}` });
  }

  // For audiobooks: fetch item to find audio tracks
  // Some books are single-file (just use /file), others are multi-track
  const absRequest2 = (path, cb) => {
    const fullUrl = base + path;
    const lib2 = fullUrl.startsWith('https') ? https : http;
    const urlObj = new URL(fullUrl);
    const r = lib2.request({
      method: 'GET', hostname: urlObj.hostname,
      port: parseInt(urlObj.port) || (fullUrl.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      headers: { Authorization: `Bearer ${token}` }
    }, (r2) => {
      let data = '';
      r2.on('data', c => data += c);
      r2.on('end', () => { try { cb(JSON.parse(data)); } catch { cb(null); } });
    });
    r.on('error', () => cb(null));
    r.end();
  };

  absRequest2(`/api/items/${req.params.id}?expanded=1`, (item) => {
    if (!item) return res.json({ url: `${base}/api/items/${req.params.id}/file?token=${token}` });
    const tracks = (item.media && item.media.audioFiles) || [];
    if (tracks.length <= 1) {
      // Single file — direct URL
      return res.json({ url: `${base}/api/items/${req.params.id}/file?token=${token}`, tracks: [] });
    }
    // Multi-track — return track list so client can seek correctly
    const trackUrls = tracks.map((t, i) => ({
      index: i,
      filename: t.metadata && t.metadata.filename,
      duration: t.duration,
      url: `${base}/api/items/${req.params.id}/file/${encodeURIComponent(t.ino || i)}?token=${token}`
    }));
    // Fallback: use /file which ABS serves as concatenated stream
    res.json({ url: `${base}/api/items/${req.params.id}/file?token=${token}`, tracks: trackUrls });
  });
});



// ── ROMM proxy ────────────────────────────────────────────────────────────────
// ROMM server URL stored in config; user tokens passed per-request from client

function rommProxy(req, res, endpoint, method, body) {
  const cfg  = readConfig();
  const url  = cfg.romm && cfg.romm.url;
  if (!url) return res.status(400).json({ error: 'ROMM not configured' });

  const token   = req.headers['x-romm-token'] || '';
  const base    = url.replace(/\/$/, '');
  const fullUrl = `${base}${endpoint}`;
  const lib     = fullUrl.startsWith('https') ? https : http;
  const urlObj  = new URL(fullUrl);
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {})
  };

  const reqOpts = {
    method: method || 'GET',
    hostname: urlObj.hostname,
    port: parseInt(urlObj.port) || (fullUrl.startsWith('https') ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    headers
  };

  const req2 = lib.request(reqOpts, (r2) => {
    let data = '';
    r2.on('data', c => data += c);
    r2.on('end', () => {
      res.status(r2.statusCode);
      try { res.json(JSON.parse(data)); }
      catch { res.send(data); }
    });
  });
  req2.on('error', err => { if (!res.headersSent) res.status(502).json({ error: err.message }); });
  req2.setTimeout(10000, () => { req2.destroy(); if (!res.headersSent) res.status(504).json({ error: 'Timeout' }); });
  if (body) req2.write(JSON.stringify(body));
  req2.end();
}

// Login — returns JWT token to client (not stored server-side)
app.post('/api/romm/login', (req, res) => {
  const cfg = readConfig();
  const url = cfg.romm && cfg.romm.url;
  if (!url) return res.status(400).json({ error: 'ROMM not configured' });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  const base    = url.replace(/\/$/, '');
  const fullUrl = `${base}/api/auth/login`;
  const lib     = fullUrl.startsWith('https') ? https : http;
  // ROMM uses Basic auth for login
  const creds   = Buffer.from(`${username}:${password}`).toString('base64');
  const urlObj  = new URL(fullUrl);

  const req2 = lib.request({
    method: 'POST', hostname: urlObj.hostname,
    port: parseInt(urlObj.port) || (fullUrl.startsWith('https') ? 443 : 80),
    path: urlObj.pathname,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${creds}`
    }
  }, (r2) => {
    let data = '';
    r2.on('data', c => data += c);
    r2.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.access_token) {
          res.json({ ok: true, token: json.access_token, username });
        } else {
          res.status(401).json({ error: json.detail || 'Login failed' });
        }
      } catch { res.status(502).json({ error: 'Bad response from ROMM' }); }
    });
  });
  req2.on('error', err => res.status(502).json({ error: err.message }));
  req2.write(''); // empty body, auth is in header
  req2.end();
});

// Proxy routes — forward user token from client
app.get('/api/romm/platforms', (req, res) => {
  rommProxy(req, res, '/api/platforms', 'GET');
});

app.get('/api/romm/roms', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  rommProxy(req, res, `/api/roms?${qs}`, 'GET');
});

app.get('/api/romm/rom/:id', (req, res) => {
  rommProxy(req, res, `/api/roms/${req.params.id}`, 'GET');
});

// Cover art proxy
app.get('/api/romm/cover', (req, res) => {
  const cfg = readConfig();
  const url = cfg.romm && cfg.romm.url;
  if (!url) return res.status(400).send('Not configured');
  const token   = req.headers['x-romm-token'] || '';
  const imgPath = req.query.path || '';
  const fullUrl = url.replace(/\/$/, '') + imgPath;
  const lib     = fullUrl.startsWith('https') ? https : http;
  const urlObj  = new URL(fullUrl);
  const r3 = lib.request({
    hostname: urlObj.hostname,
    port: parseInt(urlObj.port) || (fullUrl.startsWith('https') ? 443 : 80),
    path: urlObj.pathname + urlObj.search,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  }, (r2) => {
    res.setHeader('Content-Type', r2.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    r2.pipe(res);
  });
  r3.on('error', err => { if (!res.headersSent) res.status(502).send(err.message); });
  r3.end();
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
