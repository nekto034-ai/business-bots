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

fs.mkdirSync(SESSIONS_DIR, { recursive: true });
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

function readBody(req, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) req.destroy(); else chunks.push(c);
  });
  req.on('end', () => {
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { cb(null); }
  });
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
