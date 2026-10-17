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
const XIAOMI_PORT = Number(process.env.XIAOMI_PORT || 8091);
const SYNC_LOG = path.join(HEALTH_DIR, 'syncs.jsonl');
// Progress site (progress.<host>): the same data, read-only views + a daily journal (food deviations, hunger).
const PROGRESS_DIR = path.join(__dirname, 'progress');
const INTRADAY_DIR = path.join(HEALTH_DIR, 'intraday');
const JOURNAL_DIR = path.join(DATA_DIR, 'journal');
const INBODY_FILE = path.join(DATA_DIR, 'inbody.json');
const TZ = 'Europe/Moscow';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
fs.mkdirSync(INTRADAY_DIR, { recursive: true });
fs.mkdirSync(JOURNAL_DIR, { recursive: true });
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
  // Days are merged, never replaced: if a source disappears from Health Connect (e.g. an app is
  // disconnected and its data deleted), the values we already received must not be wiped.
  for (const d of Array.isArray(data.days) ? data.days : []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(path.join(HEALTH_DIR, 'days', d.date + '.json'), 'utf8')); } catch {}
    put('days', d.date, { ...prev, ...d });
  }
  // Raw copy of every upload, so any day can be rebuilt later.
  fs.mkdirSync(path.join(HEALTH_DIR, 'raw'), { recursive: true });
  writeJson(path.join(HEALTH_DIR, 'raw', new Date().toISOString().replace(/[:.]/g, '-') + '.json'), data);
  for (const kind of ['sleep', 'exercise', 'weight']) {
    for (const r of Array.isArray(data[kind]) ? data[kind] : []) put(kind, safeId(r.id), r);
  }
  const sync = {
    received_at: new Date().toISOString(), synced_at: data.synced_at, timezone: data.timezone, app_version: data.app_version,
    trigger: data.trigger, bg_permission: data.bg_permission, battery_unrestricted: data.battery_unrestricted, counts,
  };
  writeJson(path.join(HEALTH_DIR, 'last-sync.json'), sync);
  try { saveIntraday(data.diag); } catch (err) { console.error('intraday failed:', err.message); }
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

// Local (Moscow) date and hour of a unix time.
const tzFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
function local(epochSec) {
  const p = Object.fromEntries(tzFmt.formatToParts(new Date(epochSec * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

// The courier sends the raw step and pulse records of the last 48 hours (diag). We keep them per local
// day, merged across uploads, so the progress site can draw steps by hour and pulse through the day.
// Steps: record key = start|origin (a re-sent record replaces itself). Pulse: [start, min, max] per record.
function saveIntraday(diag) {
  if (!diag || typeof diag !== 'object') return;
  const byDate = {};
  const day = (d) => {
    if (!byDate[d]) {
      let prev = { date: d, steps: {}, hr: {} };
      try { prev = JSON.parse(fs.readFileSync(path.join(INTRADAY_DIR, d + '.json'), 'utf8')); } catch {}
      byDate[d] = prev;
    }
    return byDate[d];
  };
  for (const r of Array.isArray(diag.steps) ? diag.steps : []) {
    const [start, end, count, origin] = r;
    if (!Number.isFinite(start) || !Number.isFinite(count)) continue;
    day(local(start).date).steps[start + '|' + String(origin || '')] = [start, end, count, String(origin || '')];
  }
  for (const r of Array.isArray(diag.heart_rate) ? diag.heart_rate : []) {
    const [start, , n, min, max, origin] = r;
    if (!Number.isFinite(start) || !min) continue;
    day(local(start).date).hr[start] = [start, min, max, n, String(origin || '')];
  }
  for (const d of Object.values(byDate)) writeJson(path.join(INTRADAY_DIR, d.date + '.json'), d);
}

// One pass over all raw uploads (oldest first) when the intraday store is still empty.
function backfillIntraday() {
  if (fs.readdirSync(INTRADAY_DIR).length) return;
  const rawDir = path.join(HEALTH_DIR, 'raw');
  if (!fs.existsSync(rawDir)) return;
  for (const f of fs.readdirSync(rawDir).filter((x) => x.endsWith('.json')).sort()) {
    try { saveIntraday(JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')).diag); } catch {}
  }
}

function readIntraday(date) {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(path.join(INTRADAY_DIR, date + '.json'), 'utf8')); } catch { return { date, steps: [], hr: [] }; }
  // Steps by hour: two apps may cover the same hour (Mi Fitness before the switch, Gadgetbridge after),
  // so per hour we take the larger app total instead of adding them up.
  const perHour = {};
  for (const [start, , count, origin] of Object.values(d.steps || {})) {
    const h = local(start).hour;
    perHour[h] = perHour[h] || {};
    perHour[h][origin] = (perHour[h][origin] || 0) + count;
  }
  const steps = Array.from({ length: 24 }, (_, h) => Math.max(0, ...Object.values(perHour[h] || {})));
  const hr = Object.values(d.hr || {}).sort((a, b) => a[0] - b[0]).map(([t, min, max]) => [t, min, max]);
  return { date, steps, hr };
}

function readDir(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
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
  const isProgress = String(req.headers.host || '').startsWith('progress.');

  if (isProgress && req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return fs.createReadStream(path.join(PROGRESS_DIR, 'index.html')).pipe(res);
  }
  // Everything the progress views need in one request; intraday (by hour / minute) is fetched per day.
  if (req.method === 'GET' && url.pathname === '/api/progress') {
    const out = readHealth('0000');
    let inbody = [];
    try { inbody = JSON.parse(fs.readFileSync(INBODY_FILE, 'utf8')); } catch {}
    return json(res, 200, { ...out, syncs: undefined, sessions: listSessions(), journal: readDir(JOURNAL_DIR), inbody, tz: TZ });
  }
  if (req.method === 'GET' && url.pathname === '/api/intraday') {
    const date = url.searchParams.get('date');
    if (!DATE_RE.test(date || '')) return json(res, 400, { error: 'bad date' });
    return json(res, 200, readIntraday(date));
  }
  const jm = url.pathname.match(/^\/api\/journal\/(\d{4}-\d{2}-\d{2})$/);
  if (jm && req.method === 'PUT') {
    return readBody(req, (data) => {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return json(res, 400, { error: 'bad json' });
      data.date = jm[1];
      data.updatedAt = new Date().toISOString();
      try { writeJson(path.join(JOURNAL_DIR, jm[1] + '.json'), data); } catch { return json(res, 500, { error: 'save failed' }); }
      json(res, 200, { ok: true, updatedAt: data.updatedAt });
    });
  }

  // Xiaomi cloud bridge (sites/fitness/xiaomi/bridge.py): same password, proxied to localhost.
  if (url.pathname === '/xiaomi') { res.writeHead(302, { location: '/xiaomi/' }); return res.end(); }
  if (url.pathname.startsWith('/xiaomi/')) {
    const up = http.request({ host: '127.0.0.1', port: XIAOMI_PORT, path: req.url, method: req.method, headers: { 'content-type': req.headers['content-type'] || '' } }, (r) => {
      res.writeHead(r.statusCode, { 'content-type': r.headers['content-type'] || 'application/json', 'cache-control': 'no-store' });
      r.pipe(res);
    });
    up.on('error', () => json(res, 502, { error: 'xiaomi bridge is not running' }));
    return req.pipe(up);
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return fs.createReadStream(path.join(PUBLIC_DIR, 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/tips.json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
    return fs.createReadStream(path.join(PUBLIC_DIR, 'tips.json')).pipe(res);
  }
  const img = url.pathname.match(/^\/img\/([a-z_]+_[01]\.jpg)$/);
  if (req.method === 'GET' && img) {
    const file = path.join(PUBLIC_DIR, 'img', img[1]);
    if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=604800' });
    return fs.createReadStream(file).pipe(res);
  }
  // APKs kept on the server: the courier and Gadgetbridge (F-Droid build, hash-checked on upload).
  const APKS = { '/app.apk': ['fitcourier.apk', APK_FILE], '/gadgetbridge.apk': ['gadgetbridge.apk', path.join(DATA_DIR, 'app', 'gadgetbridge.apk')] };
  if (req.method === 'GET' && APKS[url.pathname]) {
    const [name, file] = APKS[url.pathname];
    if (!fs.existsSync(file)) return json(res, 404, { error: 'apk not uploaded yet' });
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-disposition': `attachment; filename="${name}"`,
      'content-length': fs.statSync(file).size,
    });
    return fs.createReadStream(file).pipe(res);
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

try { backfillIntraday(); } catch (err) { console.error('intraday backfill failed:', err.message); }
server.listen(PORT, '127.0.0.1', () => console.log(`fitness listening on 127.0.0.1:${PORT}`));
