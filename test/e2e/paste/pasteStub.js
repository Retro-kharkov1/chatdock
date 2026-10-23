'use strict';

// BUG-11 paste acceptance harness, test-only (never packaged: package.json build.files lists src/** only).
// One HTTPS server standing in for https://chat.google.com (Chromium --host-resolver-rules maps the host to it).
// The page has a contenteditable composer and a document-level paste recorder: it notes what the page's paste event
// receives (clipboardData items and files) and never calls preventDefault, so Chromium's default insertion still runs.

const https = require('https');
const zlib = require('zlib');

const CHAT_HOST = 'chat.google.com';

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function pngBytes(w, h) {
  const row = w * 3 + 1;
  const raw = Buffer.alloc(row * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * row + 1 + x * 3;
      raw[o] = (x * 4) & 255;
      raw[o + 1] = (y * 4) & 255;
      raw[o + 2] = 160;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Chat stub</title></head>
<body style="margin:0;font:16px sans-serif">
<h1 id="chat-stub" style="margin:8px 10px">Chat stub</h1>
<div id="composer" contenteditable="true" role="textbox" spellcheck="false"
  style="width:500px;border:1px solid #888;margin:8px 10px;padding:6px;line-height:20px;min-height:60px"></div>
<script>
window.__pastes = [];
document.addEventListener('paste', function (e) {
  var cd = e.clipboardData;
  var items = [];
  var files = [];
  var types = [];
  if (cd) {
    types = Array.prototype.slice.call(cd.types || []);
    for (var i = 0; i < cd.items.length; i++) items.push({ kind: cd.items[i].kind, type: cd.items[i].type });
    for (var j = 0; j < cd.files.length; j++) files.push({ type: cd.files[j].type, size: cd.files[j].size });
  }
  window.__pastes.push({ target: e.target.id || e.target.tagName, defaultPrevented: e.defaultPrevented, types: types, items: items, files: files });
}, true);
</script></body></html>`;

function startStubServer({ key, cert, port }) {
  const server = https.createServer({ key, cert }, (req, res) => {
    const url = String(req.url || '/').split('?')[0];
    if (url !== '/') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server }));
  });
}

module.exports = { startStubServer, pngBytes, CHAT_HOST };
