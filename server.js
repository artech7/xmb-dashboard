const express = require('express');
const jwt     = require('jsonwebtoken');
const fs      = require('fs');
const path    = require('path');

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

function readConfig() {
  let cfg;
  if (fs.existsSync(DATA_CFG)) {
    cfg = JSON.parse(fs.readFileSync(DATA_CFG, 'utf8'));
  } else {
    cfg = JSON.parse(fs.readFileSync(SEED_CFG, 'utf8'));
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_CFG, JSON.stringify(cfg, null, 2));
    console.log('First boot: seeded config to', DATA_CFG);
  }
  return ensureSystemItems(cfg);
}

function writeConfig(cfg) {
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

// ── Middleware ────────────────────────────────────────────────────────────────

// Raised to 16mb to handle large base64 favicon/icon uploads
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
  res.json(isAdmin ? cfg : filterForNonAdmin(cfg));
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

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'www', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`XMB Dashboard running at http://0.0.0.0:${PORT}`);
  console.log(`Config path: ${DATA_CFG}`);
  console.log(`Admin password: ${PASS === 'admin' ? '⚠️  default "admin" — set ADMIN_PASSWORD' : '(custom)'}`);
});
