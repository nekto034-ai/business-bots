// Fitness log site: workout card (public/index.html) + a tiny JSON API for workout sessions.
// The whole site is behind HTTP Basic auth (user "artem"); the password is generated on first
// start into DATA_DIR/password and never passes through the repo. Personal data stays on the server.
// No dependencies.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8090);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const PASSWORD_FILE = path.join(DATA_DIR, 'password');
const PUBLIC_DIR = path.join(__dirname, 'public');
const USER = 'artem';
const MAX_BODY = 200_000;
const SESSION_ID = /^\d{4}-\d{2}-\d{2}_[ABC]$/;
// Health data from the phone (Health Connect via the FitCourier app): one file per day / per session.
const HEALTH_DIR = path.join(DATA_DIR, 'health');
const HEALTH_KINDS = ['days', 'sleep', 'exercise', 'weight'];
const APK_FILE = path.join(DATA_DIR, 'app', 'fitcourier.apk');
const MAX_HEALTH_BODY = 3_000_000;
const SYNC_LOG = path.join(HEALTH_DIR, 'syncs.jsonl');

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
for (const k of HEALTH_KINDS) fs.mkdirSync(path.join(HEALTH_DIR, k), { recursive: true });
if (!fs.existsSync(PASSWORD_FILE)) {
  fs.writeFileSync(PASSWORD_FILE, crypto.randomBytes(9).toString('base64url') + '\n', { mode: 0o600 });
}
const PASSWORD = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
const EXPECTED = Buffer.from('Basic ' + Buffer.from(`${USER}:${PASSWORD}`).toString('base64'));

function authorized(req) {
  const got = Buffer.from(String(req.headers.authorization || ''));
  return got.length === EXPECTED.length && crypto.timingSafeEqual(got, EXPECTED);
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) req.destroy(); else chunks.push(c);
  });
  req.on('end', () => {
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { cb(null); }
  });
}

const safeId = (v) => String(v || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 120);

function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function saveHealth(data) {
  const counts = {};
  const put = (kind, id, obj) => { if (!id) return; writeJson(path.join(HEALTH_DIR, kind, id + '.json'), obj); counts[kind] = (counts[kind] || 0) + 1; };
  for (const d of Array.isArray(data.days) ? data.days : []) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d.date)) put('days', d.date, d);
  }
  for (const kind of ['sleep', 'exercise', 'weight']) {
    for (const r of Array.isArray(data[kind]) ? data[kind] : []) put(kind, safeId(r.id), r);
  }
  const sync = {
    received_at: new Date().toISOString(), synced_at: data.synced_at, timezone: data.timezone, app_version: data.app_version,
    trigger: data.trigger, bg_permission: data.bg_permission, battery_unrestricted: data.battery_unrestricted, counts,
  };
  writeJson(path.join(HEALTH_DIR, 'last-sync.json'), sync);
  // One line per sync: shows whether the phone keeps sending on its own.
  fs.appendFileSync(SYNC_LOG, JSON.stringify(sync) + '\n');
  return counts;
}

function readHealth(sinceIso) {
  const out = {};
  for (const kind of HEALTH_KINDS) {
    out[kind] = fs.readdirSync(path.join(HEALTH_DIR, kind))
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(HEALTH_DIR, kind, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .filter((r) => (r.date || r.start || r.time || '') >= sinceIso)
      .sort((a, b) => ((a.date || a.start || a.time) < (b.date || b.start || b.time) ? -1 : 1));
  }
  try { out.last_sync = JSON.parse(fs.readFileSync(path.join(HEALTH_DIR, 'last-sync.json'), 'utf8')); } catch { out.last_sync = null; }
  try {
    out.syncs = fs.readFileSync(SYNC_LOG, 'utf8').trim().split('\n').slice(-50)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { out.syncs = []; }
  return out;
}

function listSessions() {
  return fs.readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

const server = http.createServer((req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="fitness", charset="UTF-8"' });
    return res.end('auth required');
  }
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
  }
  const img = url.pathname.match(/^\/img\/([a-z_]+_[01]\.jpg)$/);
  if (req.method === 'GET' && img) {
    const file = path.join(PUBLIC_DIR, 'img', img[1]);
    if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=604800' });
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/app.apk') {
    if (!fs.existsSync(APK_FILE)) return json(res, 404, { error: 'apk not uploaded yet' });
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-disposition': 'attachment; filename="fitcourier.apk"',
      'content-length': fs.statSync(APK_FILE).size,
    });
    return fs.createReadStream(APK_FILE).pipe(res);
  }
  if (req.method === 'POST' && url.pathname === '/api/health') {
    return readBody(req, (data) => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return json(res, 400, { error: 'bad json' });
      try {
        const counts = saveHealth(data);
        console.log('health sync', JSON.stringify(counts));
        json(res, 200, { ok: true, counts });
      } catch (err) {
        console.error('health save failed:', err.message);
        json(res, 500, { error: 'save failed' });
      }
    }, MAX_HEALTH_BODY);
  }
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 400);
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return json(res, 200, readHealth(since));
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    return json(res, 200, { sessions: listSessions() });
  }
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (m && req.method === 'PUT') {
    const id = decodeURIComponent(m[1]);
    if (!SESSION_ID.test(id)) return json(res, 400, { error: 'bad id' });
    return readBody(req, (data) => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return json(res, 400, { error: 'bad json' });
      data.id = id;
      data.updatedAt = new Date().toISOString();
      const file = path.join(SESSIONS_DIR, id + '.json');
      const tmp = file + '.tmp';
      fs.writeFile(tmp, JSON.stringify(data, null, 1), (err) => {
        if (err) return json(res, 500, { error: 'save failed' });
        fs.rename(tmp, file, (err2) => (err2 ? json(res, 500, { error: 'save failed' }) : json(res, 200, { ok: true, updatedAt: data.updatedAt })));
      });
    });
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`fitness listening on 127.0.0.1:${PORT}`));
