// bots-agent: tiny HTTPS-fronted (via Caddy) remote control for the bots server.
// Runs shell commands only for requests signed with an Ed25519 key listed in
// one of the authorized_keys files. No dependencies — plain Node.js.
'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const PORT = Number(process.env.AGENT_PORT || 8787);
const REPO_DIR = process.env.REPO_DIR || '/opt/business-bots';
const KEY_FILES = [
  '/etc/bots-agent/authorized_keys',
  `${REPO_DIR}/infra/authorized_keys`,
];
const MAX_SKEW_MS = 120_000;
const MAX_BODY = 1_000_000;
const MAX_OUTPUT = 2_000_000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 1800;

// Key file line format: "ed25519 <base64url raw public key> [comment]"
function loadKeys() {
  const keys = [];
  for (const file of KEY_FILES) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const [type, x, ...comment] = line.trim().split(/\s+/);
      if (type !== 'ed25519' || !x) continue;
      try {
        keys.push({
          key: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }),
          name: comment.join(' ') || x.slice(0, 8),
        });
      } catch { /* skip malformed line */ }
    }
  }
  return keys;
}

const seenNonces = new Map();
function nonceIsFresh(nonce) {
  const now = Date.now();
  for (const [n, t] of seenNonces) if (now - t > 2 * MAX_SKEW_MS) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now);
  return true;
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function repoCommit() {
  try {
    return execFileSync('git', ['-C', REPO_DIR, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch { return null; }
}

function runCommand(cmd, timeoutS) {
  return new Promise((resolve) => {
    const started = Date.now();
    // The command goes in via stdin: argv has a ~128 KB per-argument limit (E2BIG).
    const child = spawn('bash', ['-l', '-s'], {
      cwd: fs.existsSync(REPO_DIR) ? REPO_DIR : '/',
      env: { ...process.env, HOME: '/root' },
    });
    child.on('error', (err) => resolve({ code: null, stdout: '', stderr: `spawn failed: ${err.message}`, durationMs: 0 }));
    child.stdin.on('error', () => {});
    child.stdin.end(cmd);
    let stdout = '', stderr = '', truncated = false;
    const append = (which, chunk) => {
      if (stdout.length + stderr.length > MAX_OUTPUT) { truncated = true; return; }
      if (which === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', (c) => append('out', c));
    child.stderr.on('data', (c) => append('err', c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutS * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, truncated, durationMs: Date.now() - started });
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, hostname: os.hostname(), uptimeS: Math.round(os.uptime()), commit: repoCommit() });
  }
  if (req.method !== 'POST' || req.url !== '/exec') return send(res, 404, { error: 'not found' });

  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) req.destroy(); else chunks.push(c);
  });
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    let sig;
    try { sig = Buffer.from(String(req.headers['x-signature'] || ''), 'base64'); } catch { sig = Buffer.alloc(0); }
    const signer = sig.length && loadKeys().find((k) => crypto.verify(null, body, k.key, sig));
    if (!signer) return send(res, 401, { error: 'bad signature' });

    let msg;
    try { msg = JSON.parse(body.toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
    if (typeof msg.cmd !== 'string' || typeof msg.nonce !== 'string' || typeof msg.ts !== 'number') {
      return send(res, 400, { error: 'need cmd, nonce, ts' });
    }
    if (Math.abs(Date.now() - msg.ts) > MAX_SKEW_MS) return send(res, 401, { error: 'stale request' });
    if (!nonceIsFresh(msg.nonce)) return send(res, 401, { error: 'replayed request' });

    const timeoutS = Math.min(Math.max(Number(msg.timeout) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
    console.log(`exec by "${signer.name}": ${msg.cmd.slice(0, 200)}`);
    send(res, 200, await runCommand(msg.cmd, timeoutS));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`bots-agent listening on 127.0.0.1:${PORT}`));
