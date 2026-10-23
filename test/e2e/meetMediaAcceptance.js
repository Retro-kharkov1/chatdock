'use strict';

// BUG-09 acceptance row, in-container driver. Runs the REAL app (src/main/index.js, unmodified, real permission
// handlers) under Xvfb with Chromium fake media devices, against stub origins (meetMediaStub.js).
//
// Origins resolve to the stub server through Chromium command-line switches only (no app code is touched):
//   --host-resolver-rules="MAP chat.google.com 127.0.0.1:PORT, ..."   --ignore-certificate-errors
// Do NOT pass --use-fake-ui-for-media-stream: it swaps in a fake media UI that auto-accepts getUserMedia and
// skips Electron's permission REQUEST handler, so the app's gate would never be exercised (BUG-09 run 2).
// Env (set by in-container.sh): GCD_E2E_RUN=1, GCD_ELECTRON (binary), GCD_APP_DIR, GCD_OUT_DIR, GCD_CERT_DIR.
//
// `node --test` treats every .js under test/ as a test file; without GCD_E2E_RUN this file does nothing.

if (!process.env.GCD_E2E_RUN) process.exit(0);

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { startStubServer, MEET_HOST, CHAT_HOST, THIRD_HOST, ERROR_TEXT } = require('./meetMediaStub');

const PORT = 8443;
const APP_DIR = process.env.GCD_APP_DIR;
const OUT_DIR = process.env.GCD_OUT_DIR;
const CERT_DIR = process.env.GCD_CERT_DIR;
const CDP_PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFile(dir, name) {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findFile(p, name);
      if (r) return r;
    } else if (e.name === name) return p;
  }
  return null;
}

async function screenshot(file) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
    const page = targets.find((t) => t.type === 'page' && String(t.url).startsWith(`https://${CHAT_HOST}`));
    if (!page) return false;
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
    const data = await new Promise((res, rej) => {
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id === 1) (d.error ? rej(new Error(d.error.message)) : res(d.result.data));
      };
      ws.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    ws.close();
    return true;
  } catch (err) {
    console.error('[e2e] screenshot failed:', err.message);
    return false;
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { server, reports } = await startStubServer({
    key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
    cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
    port: PORT,
  });
  const cfgHome = fs.mkdtempSync('/tmp/gcd-cfg-');
  const rules = [CHAT_HOST, MEET_HOST, THIRD_HOST].map((h) => `MAP ${h} 127.0.0.1:${PORT}`).join(', ');
  const args = [
    APP_DIR,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`,
    `--host-resolver-rules=${rules}`,
    '--ignore-certificate-errors',
    '--use-fake-device-for-media-stream',
  ];
  const logStream = fs.createWriteStream(path.join(OUT_DIR, 'electron-output.log'));
  const child = spawn(process.env.GCD_ELECTRON, args, {
    env: { ...process.env, XDG_CONFIG_HOME: cfgHome, ELECTRON_ENABLE_LOGGING: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  let exited = null;
  child.on('error', (err) => {
    console.error('[e2e] cannot start electron:', err.message);
    process.exit(2);
  });
  child.on('exit',(code, sig) => (exited = { code, sig }));

  const pick = () => ({
    meet: (reports[MEET_HOST] || []).find((r) => 'ok' in r),
    third: (reports[THIRD_HOST] || []).find((r) => 'ok' in r),
    chat: (reports[CHAT_HOST] || []).find((r) => 'errorTextPresent' in r),
  });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !exited) {
    const p = pick();
    if (p.meet && p.third && p.chat) break;
    await sleep(500);
  }
  await sleep(1000);
  const shot = await screenshot(path.join(OUT_DIR, 'chat-stub-with-meet-iframe.png'));

  const diagFile = findFile(cfgHome, 'diagnostics.log');
  const diag = diagFile ? fs.readFileSync(diagFile, 'utf8') : '';
  if (diagFile) fs.copyFileSync(diagFile, path.join(OUT_DIR, 'diagnostics.log'));
  const permLines = diag.split(/\r?\n/).filter((l) => l.includes('permission-'));
  const mediaLines = (requesting, decision) =>
    permLines.filter(
      (l) =>
        l.includes('permission="media"') &&
        l.includes(`requesting="https://${requesting}"`) &&
        l.includes(`decision="${decision}"`)
    );

  const { meet, third, chat } = pick();
  const meetGrantRequest = mediaLines(MEET_HOST, 'grant').filter(
    (l) => l.includes(' permission-request ') && l.includes(`topLevel="https://${CHAT_HOST}"`)
  );

  const checks = [
    ['meet iframe getUserMedia succeeded', !!meet && meet.ok === true],
    ['meet iframe received audio and video tracks', !!meet && meet.audioTracks >= 1 && meet.videoTracks >= 1],
    [`meet iframe shows no "${ERROR_TEXT}"`, !!meet && meet.errorTextPresent === false],
    [`chat page shows no "${ERROR_TEXT}"`, !!chat && chat.errorTextPresent === false],
    ['diagnostics.log: permission-request media requesting=meet topLevel=chat decision=grant', meetGrantRequest.length >= 1],
    ['diagnostics.log: no media deny for meet', mediaLines(MEET_HOST, 'deny').length === 0],
    ['negative: third-party iframe getUserMedia failed', !!third && third.ok === false],
    ['negative: no media grant for the third-party origin', mediaLines(THIRD_HOST, 'grant').length === 0],
    [
      'diagnostics.log: permission-request media requesting=thirdparty decision=deny',
      mediaLines(THIRD_HOST, 'deny').some((l) => l.includes(' permission-request ')),
    ],
  ];
  const passed = checks.every(([, ok]) => ok);

  const lines = [];
  lines.push(`BUG-09 acceptance row: ${passed ? 'PASS' : 'FAIL'}`);
  for (const [name, ok] of checks) lines.push(`  [${ok ? 'PASS' : 'FAIL'}] ${name}`);
  lines.push(`  screenshot: ${shot ? 'chat-stub-with-meet-iframe.png' : 'not captured'}`);
  lines.push(`  reports: ${JSON.stringify(reports)}`);
  lines.push('  diagnostics permission lines:');
  for (const l of permLines) lines.push(`    ${l}`);
  if (exited) lines.push(`  NOTE: app exited early: ${JSON.stringify(exited)}`);
  fs.writeFileSync(path.join(OUT_DIR, 'result.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(
    path.join(OUT_DIR, 'summary.txt'),
    `BUG-09 acceptance row ${passed ? 'PASS' : 'FAIL'}: ${checks.filter(([, ok]) => ok).length}/${checks.length} checks\n`
  );
  console.log(lines.join('\n'));

  if (!exited) child.kill('SIGTERM');
  await sleep(1500);
  if (!exited) child.kill('SIGKILL');
  server.close();
  process.exit(passed ? 0 : 1);
})().catch((err) => {
  console.error('[e2e] harness error:', err);
  process.exit(2);
});
