// Landing site server: static files from public/ + POST /api/lead + one-time /setup.
// Leads are appended as JSON lines to LEADS_FILE and e-mailed when mail is set up.
// No dependencies.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sendMail } = require('./mailer');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const LEADS_FILE = process.env.LEADS_FILE || path.join(__dirname, 'leads.jsonl');
// Review letters contain clients' requisites, so they are kept out of the public
// repo and uploaded to the server directly; served from REVIEWS_DIR when set.
const REVIEWS_DIR = process.env.REVIEWS_DIR || path.join(PUBLIC_DIR, 'reviews');
const STATE_DIR = path.dirname(LEADS_FILE);
// Mail settings (incl. the app password) are entered by the owner on /setup and
// never pass through the repo or the agent. /setup works only while SETUP_CODE_FILE exists.
const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');
const SETUP_CODE_FILE = path.join(STATE_DIR, 'setup-code');
const SMTP_HOSTS = { yandex: 'smtp.yandex.ru', gmail: 'smtp.gmail.com', mailru: 'smtp.mail.ru' };
const PRIORITY_NAMES = { fast: 'Быстро', quality: 'Качественно', budget: 'Недорого' };
const MAX_BODY = 10_000;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

// Simple per-IP limit: 5 leads per 10 minutes.
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 5;
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function handleLead(req, res) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  readBody(req, (data) => {
    if (!data) return json(res, 400, { error: 'bad json' });
    if (data.website) return json(res, 200, { ok: true }); // honeypot: silently drop bots
    const lead = {
      ts: new Date().toISOString(),
      name: str(data.name, 100),
      contact: str(data.contact, 100),
      comment: str(data.comment, 1000),
      priorities: Array.isArray(data.priorities)
        ? data.priorities.filter((p) => ['fast', 'quality', 'budget'].includes(p)).slice(0, 2) : [],
      consent: data.consent === true,
      ip,
    };
    if (!lead.name || !lead.contact || !lead.consent) return json(res, 400, { error: 'missing fields' });
    if (rateLimited(ip)) return json(res, 429, { error: 'too many requests' });
    fs.appendFile(LEADS_FILE, JSON.stringify(lead) + '\n', (err) => {
      if (err) { console.error('cannot save lead:', err.message); return json(res, 500, { error: 'save failed' }); }
      console.log(`new lead from ${lead.name}`);
      json(res, 200, { ok: true });
      notifyByMail(lead);
    });
  });
}

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return null; }
}

function leadText(lead) {
  const when = new Date(lead.ts).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
  return [
    `Новая заявка с сайта (${when} МСК)`,
    '',
    `Имя: ${lead.name}`,
    `Контакт: ${lead.contact}`,
    `Важно: ${lead.priorities.map((p) => PRIORITY_NAMES[p]).join(' + ') || 'не выбрано'}`,
    `Что болит: ${lead.comment || '—'}`,
  ].join('\n');
}

function notifyByMail(lead) {
  const s = readSettings();
  if (!s) return;
  sendMail({ host: s.host, port: s.port, user: s.user, pass: s.pass, to: s.to, subject: `Заявка с сайта: ${lead.name}`, text: leadText(lead) })
    .then(() => console.log('lead e-mailed'))
    .catch((err) => console.error('mail failed:', err.message));
}

function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > MAX_BODY) req.destroy(); });
  req.on('end', () => { try { cb(JSON.parse(body)); } catch { cb(null); } });
}

function setupCodeMatches(code) {
  let expected;
  try { expected = fs.readFileSync(SETUP_CODE_FILE, 'utf8').trim(); } catch { return false; }
  const a = Buffer.from(String(code || '')), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function handleSetup(req, res) {
  if (!fs.existsSync(SETUP_CODE_FILE)) { res.writeHead(404); return res.end(); }
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, 'setup.html')));
  }
  readBody(req, async (data) => {
    if (!data || !setupCodeMatches(data.code)) return json(res, 403, { error: 'Неверный или устаревший код' });
    const s = { host: SMTP_HOSTS[data.provider], user: str(data.user, 200), pass: str(data.pass, 200), to: str(data.to, 200) };
    if (!s.host || !s.user.includes('@') || !s.pass || !s.to.includes('@')) return json(res, 400, { error: 'Заполните все поля' });
    try {
      await sendMail({ ...s, subject: 'Сайт подключён к почте', text: 'Готово! Заявки с сайта «Математика бизнеса» будут приходить на этот адрес.' });
    } catch (err) {
      return json(res, 502, { error: `Не удалось отправить тестовое письмо: ${err.message}` });
    }
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s), { mode: 0o600 });
    fs.rmSync(SETUP_CODE_FILE, { force: true });
    console.log('mail settings saved');
    json(res, 200, { ok: true });
  });
}

function serveStatic(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { urlPath = '/'; }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const [root, rel] = urlPath.startsWith('/reviews/')
    ? [REVIEWS_DIR, urlPath.slice('/reviews'.length)] : [PUBLIC_DIR, urlPath];
  const file = path.join(root, path.normalize(rel));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, content) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Страница не найдена');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(content);
  });
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/lead') return handleLead(req, res);
  if (req.url.split('?')[0] === '/setup') return handleSetup(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`landing on 127.0.0.1:${PORT}`));
