#!/usr/bin/env node
// Client for bots-agent.
//   node infra/remote.js keygen [comment]   -> create key, print authorized_keys line
//   node infra/remote.js health             -> GET /health
//   node infra/remote.js exec "<command>" [timeoutSeconds]   ("-" reads the command from stdin)
// Env: AGENT_URL (default from infra/server.json), AGENT_KEY (default ~/.bots-agent/key.pem)
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY_PATH = process.env.AGENT_KEY || path.join(os.homedir(), '.bots-agent', 'key.pem');

function agentUrl() {
  if (process.env.AGENT_URL) return process.env.AGENT_URL.replace(/\/$/, '');
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'server.json'), 'utf8'));
  return cfg.agent_url.replace(/\/$/, '');
}

function publicLine(privateKey, comment) {
  const { x } = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  return `ed25519 ${x} ${comment}`.trim();
}

async function main() {
  const [, , command, ...args] = process.argv;

  if (command === 'keygen') {
    if (!fs.existsSync(KEY_PATH)) {
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true, mode: 0o700 });
      fs.writeFileSync(KEY_PATH, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    }
    const key = crypto.createPrivateKey(fs.readFileSync(KEY_PATH));
    console.log(publicLine(key, args.join(' ')));
    return;
  }

  if (command === 'health') {
    const res = await fetch(`${agentUrl()}/health`);
    console.log(res.status, await res.text());
    return;
  }

  if (command === 'exec') {
    let [cmd, timeout] = args;
    if (cmd === '-') cmd = fs.readFileSync(0, 'utf8'); // read a long command from stdin
    if (!cmd) throw new Error('usage: exec "<command>"|- [timeoutSeconds]');
    const body = Buffer.from(JSON.stringify({
      cmd, timeout: timeout ? Number(timeout) : undefined,
      ts: Date.now(), nonce: crypto.randomUUID(),
    }));
    const key = crypto.createPrivateKey(fs.readFileSync(KEY_PATH));
    const sig = crypto.sign(null, body, key).toString('base64');
    const res = await fetch(`${agentUrl()}/exec`, {
      method: 'POST', body, headers: { 'content-type': 'application/json', 'x-signature': sig },
    });
    const out = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (out.error) { console.error('error:', out.error); process.exit(2); }
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
    if (out.truncated) console.error('[output truncated]');
    process.exit(out.code ?? 1);
  }

  console.error('usage: remote.js keygen|health|exec');
  process.exit(64);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
