// Landing site server: static files from public/ + POST /api/lead.
// Leads are appended as JSON lines to LEADS_FILE. No dependencies.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const LEADS_FILE = process.env.LEADS_FILE || path.join(__dirname, 'leads.jsonl');
// Review letters contain clients' requisites, so they are kept out of the public
// repo and uploaded to the server directly; served from REVIEWS_DIR when set.
const REVIEWS_DIR = process.env.REVIEWS_DIR || path.join(PUBLIC_DIR, 'reviews');
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
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > MAX_BODY) req.destroy(); });
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch { return json(res, 400, { error: 'bad json' }); }
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
    });
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
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`landing on 127.0.0.1:${PORT}`));
