'use strict';

// BUG-09 acceptance harness, test-only (never packaged: package.json build.files lists src/** only).
// Stub servers that stand in for three origins inside the container:
//   https://chat.google.com   top-level page embedding two iframes
//   https://meet.google.com   iframe that calls getUserMedia({audio, video}) (fake devices)
//   https://thirdparty.example  negative iframe, same getUserMedia call, must be denied
// One HTTPS server answers all three hostnames (Chromium --host-resolver-rules maps them to it); the page origin
// is therefore exactly what the app's real permission handlers see.

const https = require('https');

const MEET_HOST = 'meet.google.com';
const CHAT_HOST = 'chat.google.com';
const THIRD_HOST = 'thirdparty.example';
const ERROR_TEXT = 'There was a problem with the call';

const CHAT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Chat stub</title></head><body>
<h1 id="chat-stub">Chat stub</h1>
<iframe id="meet" src="https://${MEET_HOST}/call" allow="camera; microphone; autoplay" width="480" height="240"></iframe>
<iframe id="third" src="https://${THIRD_HOST}/call" allow="camera; microphone; autoplay" width="480" height="240"></iframe>
<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    fetch('/report', { method: 'POST', body: JSON.stringify({ errorTextPresent: document.body.innerText.includes(${JSON.stringify(ERROR_TEXT)}) }) });
  }, 6000);
});
</script></body></html>`;

const CALL_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Call stub</title></head><body>
<h2 id="state">Joining...</h2>
<script>
(async function () {
  var report = { host: location.host };
  try {
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    report.ok = true;
    report.audioTracks = stream.getAudioTracks().length;
    report.videoTracks = stream.getVideoTracks().length;
    report.labels = stream.getTracks().map(function (t) { return t.label; });
    document.getElementById('state').textContent = 'In call (media granted)';
  } catch (e) {
    report.ok = false;
    report.error = e && e.name;
    document.getElementById('state').textContent = ${JSON.stringify(ERROR_TEXT)};
  }
  report.errorTextPresent = document.body.innerText.includes(${JSON.stringify(ERROR_TEXT)});
  try { await fetch('/report', { method: 'POST', body: JSON.stringify(report) }); } catch (e) {}
})();
</script></body></html>`;

/** startStubServer({ key, cert, port }) -> Promise<{ server, reports }>; reports: { [host]: object[] } */
function startStubServer({ key, cert, port }) {
  const reports = {};
  const server = https.createServer({ key, cert }, (req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    if (req.method === 'POST' && req.url === '/report') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          (reports[host] = reports[host] || []).push(JSON.parse(body));
        } catch {
          /* ignored */
        }
        res.writeHead(204).end();
      });
      return;
    }
    if (req.url === '/favicon.ico') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(host === CHAT_HOST ? CHAT_PAGE : CALL_PAGE);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, reports }));
  });
}

module.exports = { startStubServer, MEET_HOST, CHAT_HOST, THIRD_HOST, ERROR_TEXT };
