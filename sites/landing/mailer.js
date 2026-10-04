// Minimal SMTP client (implicit TLS, port 465, AUTH LOGIN). No dependencies.
'use strict';

const tls = require('tls');
const crypto = require('crypto');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encodeHeader = (s) => `=?UTF-8?B?${b64(s)}?=`;

function buildMessage({ from, to, subject, text }) {
  const body = b64(text).replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${encodeHeader('Сайт «Математика бизнеса»')} <${from}>`,
    `To: <${to}>`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

function sendMail({ host, port = 465, user, pass, to, subject, text }) {
  return new Promise((resolve, reject) => {
    const steps = [
      { expect: 220, send: 'EHLO landing' },
      { expect: 250, send: 'AUTH LOGIN' },
      { expect: 334, send: b64(user) },
      { expect: 334, send: b64(pass), secret: true },
      { expect: 235, send: `MAIL FROM:<${user}>` },
      { expect: 250, send: `RCPT TO:<${to}>` },
      { expect: 250, send: 'DATA' },
      { expect: 354, send: `${buildMessage({ from: user, to, subject, text })}\r\n.` },
      { expect: 250, send: 'QUIT' },
    ];
    let step = 0;
    let buffer = '';
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('SMTP timeout (port closed?)')), 20_000);
    const socket = tls.connect({ host, port, servername: host });
    socket.setEncoding('utf8');
    socket.on('error', (err) => finish(err));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!/^\d{3} /.test(line)) continue; // multi-line reply continues with "250-"
        const code = Number(line.slice(0, 3));
        const current = steps[step];
        if (!current) return finish();
        if (code !== current.expect) {
          const what = current.secret || steps[step - 1]?.secret ? 'login/password rejected' : line;
          return finish(new Error(`SMTP error: ${what}`));
        }
        socket.write(current.send + '\r\n');
        step += 1;
        if (step === steps.length) setTimeout(() => finish(), 200);
      }
    });
  });
}

module.exports = { sendMail };
