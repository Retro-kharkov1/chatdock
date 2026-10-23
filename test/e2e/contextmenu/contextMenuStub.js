'use strict';

// UI-08 acceptance harness, test-only (never packaged: package.json build.files lists src/** only).
// One HTTPS server standing in for https://chat.google.com (Chromium --host-resolver-rules maps the host to it).
// The page models the Chat surfaces the context menu must handle: a contenteditable composer, a link, an image,
// an element whose own contextmenu handler calls preventDefault() (Chat's message menu), and empty page space.
// It also serves /test.png (a real PNG), and /dict/* from a Chromium spellcheck .bdic file, so the spellchecker
// initialises without any real Google origin.

const https = require('https');
const fs = require('fs');
const zlib = require('zlib');

const CHAT_HOST = 'chat.google.com';
const LINK_URL = 'https://example.org/docs?a=1';

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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
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
<div id="composer" contenteditable="true" role="textbox" spellcheck="true"
  style="width:500px;border:1px solid #888;margin:8px 10px;padding:6px;line-height:20px;min-height:40px"></div>
<p style="margin:8px 10px"><a id="link" href="${LINK_URL}">Example link</a></p>
<p style="margin:8px 10px"><img id="img" src="/test.png" width="64" height="64" alt="test image"></p>
<div id="own-menu" style="width:300px;margin:8px 10px;padding:8px;border:1px solid #484">Message with its own menu</div>
<div id="own-menu-drawn" style="margin:0 10px"></div>
<script>
window.__ownMenuFired = 0;
window.__docContextmenu = [];
document.getElementById('own-menu').addEventListener('contextmenu', function (e) {
  e.preventDefault();
  window.__ownMenuFired++;
  document.getElementById('own-menu-drawn').textContent = 'custom page menu open';
});
document.addEventListener('contextmenu', function (e) {
  window.__docContextmenu.push({ target: e.target.id || e.target.tagName, defaultPrevented: e.defaultPrevented });
});
</script></body></html>`;

/** startStubServer({ key, cert, port, dictFile }) -> Promise<{ server }> */
const dictRequests = [];
function startStubServer({ key, cert, port, dictFile }) {
  const png = pngBytes(64, 64);
  const server = https.createServer({ key, cert }, (req, res) => {
    const url = String(req.url || '/').split('?')[0];
    if (url === '/test.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
      return res.end(png);
    }
    if (url.startsWith('/dict/')) {
      dictRequests.push(url + ' -> ' + (dictFile && fs.existsSync(dictFile) ? 200 : 404));
      if (dictFile && fs.existsSync(dictFile)) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(fs.readFileSync(dictFile));
      }
      return res.writeHead(404).end();
    }
    if (url !== '/') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server }));
  });
}

module.exports = { dictRequests, startStubServer, CHAT_HOST, LINK_URL };
