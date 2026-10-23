'use strict';

// BUG-10 reload acceptance harness, test-only (never packaged: package.json build.files lists src/** only).
// One HTTPS server standing in for https://chat.google.com and https://accounts.google.com (Chromium
// --host-resolver-rules maps both hosts to it). It can be stopped and started again on the same port, so a test can
// make the "network" unreachable and reachable. GET / serves the Chat stub page; GET /reset destroys the socket
// (a failed load that is not a refused connection). Every request is counted per path, with the host and cache header.

const https = require('https');

const CHAT_HOST = 'chat.google.com';
const SIGN_IN_HOST = 'accounts.google.com';
const OTHER_HOST = 'other.example'; // mapped to a closed port by the driver: a failing non-Chat origin

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Chat stub</title></head>
<body style="margin:0;font:16px sans-serif"><h1 id="chat-stub" style="margin:8px 10px">Chat stub</h1>
<script>window.__marker = 'loaded-once';</script></body></html>`;

function createStub({ key, cert, port }) {
  const requests = []; // { host, path, cacheControl, t }
  let server = null;

  const handler = (req, res) => {
    const path = String(req.url || '/').split('?')[0];
    requests.push({ host: String(req.headers.host || ''), path, cacheControl: String(req.headers['cache-control'] || ''), t: Date.now() });
    if (path === '/reset') return req.socket.destroy();
    if (path !== '/') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=3600' });
    res.end(PAGE);
  };

  return {
    requests,
    isUp: () => server !== null,
    start() {
      return new Promise((resolve, reject) => {
        const s = https.createServer({ key, cert }, handler);
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => {
          server = s;
          resolve();
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        const s = server;
        server = null;
        s.closeAllConnections();
        s.close(() => resolve());
      });
    },
    rootCount: (host) => requests.filter((r) => r.path === '/' && (!host || r.host.startsWith(host))).length,
  };
}

module.exports = { createStub, CHAT_HOST, SIGN_IN_HOST, OTHER_HOST };
