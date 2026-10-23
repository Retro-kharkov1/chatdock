'use strict';

// BUG-11 paste acceptance table, in-container driver. Runs the REAL app (src/main/index.js; the "prefix" tree differs
// only in src/main/editShortcuts.js, swapped by in-container.sh) under Xvfb against a local https stub of chat.google.com
// and drives it with real key events (webContents.sendInputEvent keyDown/keyUp with modifiers). The page records its
// paste events (pasteStub.js). Nothing in src/** of the repo is changed.
//
// Env (set by in-container.sh): GCD_E2E_RUN=1, GCD_TREE (fix|prefix), GCD_ELECTRON, GCD_APP_DIR, GCD_OUT_DIR, GCD_CERT_DIR.
// Without GCD_E2E_RUN this file does nothing (`node --test` treats every .js under test/ as a test file).

if (!process.env.GCD_E2E_RUN) process.exit(0);

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { startStubServer, pngBytes, CHAT_HOST } = require('./pasteStub');

const PORT = 8443;
const HOOK = 9333;
const TREE = process.env.GCD_TREE || 'fix';
const APP_DIR = process.env.GCD_APP_DIR;
const OUT_DIR = process.env.GCD_OUT_DIR;
const CERT_DIR = process.env.GCD_CERT_DIR;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const PLAIN = 'PASTE-PLAIN-ONCE';
const HTML_TEXT = 'HTMLBOLD';
const rows = [];
let current = null;

async function post(code) {
  const r = await fetch(`http://127.0.0.1:${HOOK}/eval`, { method: 'POST', body: J({ code }) });
  const j = await r.json();
  if (j.error) throw new Error('eval: ' + j.error);
  return j.result;
}
const getState = async () => (await fetch(`http://127.0.0.1:${HOOK}/state`)).json();
const page = (js) => post(`return await ctx.wc.executeJavaScript(${J(js)});`);

const composerText = `document.getElementById('composer').textContent`;
const composerHtml = `document.getElementById('composer').innerHTML`;
const composerCenter = `(()=>{const r=document.getElementById('composer').getBoundingClientRect();return {x:Math.round(r.left+40),y:Math.round(r.top+17)};})()`;

/** Empty composer, empty recorder, focus the window and the composer. */
async function resetPage() {
  await page(
    `(()=>{const c=document.getElementById('composer');c.focus();getSelection().selectAllChildren(c);document.execCommand('delete');c.innerHTML='';window.__pastes=[];return true;})()`
  );
  await post(`const w = ctx.electron.BrowserWindow.fromWebContents(ctx.wc); w.show(); w.focus(); ctx.wc.focus(); return true;`);
  await page(`document.getElementById('composer').focus()`);
  await sleep(200);
}

/** Real Ctrl+V / Ctrl+Shift+V key events to the Chat window. */
async function pressPaste(shift) {
  const mods = shift ? "['control','shift']" : "['control']";
  await post(`ctx.wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ${mods} });
    ctx.wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ${mods} });
    await ctx.sleep(1200); return true;`);
}

const clipTypes = () =>
  post(`const items = await ctx.clipboard.read(); return items.map((i) => i.types || []);`);
const clearClip = () => post(`ctx.clipboard.clear(); return true;`);
async function pageState() {
  return page(
    `({ text: ${composerText}, html: ${composerHtml}, imgs: document.getElementById('composer').querySelectorAll('img').length, pastes: window.__pastes, active: document.activeElement && document.activeElement.id, hasFocus: document.hasFocus() })`
  );
}

async function shot(name) {
  try {
    const b64 = await post(`return (await ctx.wc.capturePage()).toPNG().toString('base64');`);
    fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(b64, 'base64'));
    return name;
  } catch (err) {
    return 'screenshot failed: ' + err.message;
  }
}

async function row(id, title, fn) {
  const r = { id, title, status: 'PASS', checks: [], notes: [] };
  rows.push(r);
  const check = (name, ok, evidence) => {
    r.checks.push({ name, ok: !!ok, evidence: evidence === undefined ? '' : String(evidence) });
    if (!ok) r.status = 'FAIL';
  };
  try {
    await fn(check, r);
  } catch (err) {
    r.status = 'FAIL';
    r.checks.push({ name: 'automation/app error', ok: false, evidence: String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' / ') : err) });
  }
  console.log(`[e2e] (${TREE}) row ${id}: ${r.status}`);
}

async function launch() {
  const cfgHome = fs.mkdtempSync('/tmp/gcd-cfg-');
  const home = fs.mkdtempSync('/tmp/gcd-home-');
  const args = [APP_DIR, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--host-resolver-rules=MAP ${CHAT_HOST} 127.0.0.1:${PORT}`, '--ignore-certificate-errors'];
  const logStream = fs.createWriteStream(path.join(OUT_DIR, 'electron-output.log'));
  const child = spawn(process.env.GCD_ELECTRON, args, {
    env: { ...process.env, XDG_CONFIG_HOME: cfgHome, HOME: home, ELECTRON_ENABLE_LOGGING: '1', GCD_E2E_HOOK: '1', GCD_HOOK_PORT: String(HOOK) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  const l = { child, exited: null };
  child.on('error', (err) => {
    console.error('[e2e] cannot start electron:', err.message);
    process.exit(2);
  });
  child.on('exit', (code, sig) => (l.exited = { code, sig }));
  current = l;
  const deadline = Date.now() + 90000;
  for (;;) {
    if (l.exited) throw new Error('app exited during startup: ' + J(l.exited));
    if (Date.now() > deadline) throw new Error('chat stub page did not load in 90 s');
    try {
      if (await post(`return ctx.wc ? await ctx.wc.executeJavaScript("!!document.getElementById('composer')") : false;`)) break;
    } catch {
      /* hook not up yet */
    }
    await sleep(500);
  }
  return l;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { server } = await startStubServer({
    key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
    cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
    port: PORT,
  });
  const A = await launch();
  const png64 = pngBytes(64, 64).toString('base64');

  await row('1', 'Plain text on the clipboard, Ctrl+V into the composer: pasted exactly once (regression guard)', async (check) => {
    await resetPage();
    await post(`await ctx.clipboard.writeText(${J(PLAIN)}); return true;`);
    await pressPaste(false);
    const s = await pageState();
    check('composer holds the text exactly once', s.text === PLAIN, `field="${s.text}" (expected "${PLAIN}")`);
    check('the page received exactly one paste event', s.pastes.length === 1, `paste events=${s.pastes.length} ${J(s.pastes)}`);
    check('screenshot', true, await shot('row1-plain-text.png'));
  });

  await row('2', 'PNG image on the clipboard, Ctrl+V into the composer: the paste event carries an image/png item or file', async (check, r) => {
    await resetPage();
    // Electron 44 main-process clipboard.write takes ClipboardItem[] (electron.d.ts 44.4.3), not the legacy data object.
    await post(`const blob = new Blob([Buffer.from(${J(png64)}, 'base64')], { type: 'image/png' });
      await ctx.clipboard.write([new ctx.electron.ClipboardItem({ 'image/png': blob })]); return true;`);
    const types = await clipTypes();
    check('precondition: the clipboard holds an image', types.some((t) => t.some((x) => /^image[/]/.test(x))), `clipboard types=${J(types)}`);
    await pressPaste(false);
    const s = await pageState();
    const p = s.pastes[0] || { items: [], files: [], types: [] };
    const hasItem = p.items.some((i) => /^image[/]png$/.test(i.type)) || p.files.some((f) => f.type === 'image/png');
    check('a paste event fired', s.pastes.length >= 1, `paste events=${s.pastes.length}`);
    check('clipboardData has an image/png item or file', hasItem, `types=${J(p.types)} items=${J(p.items)} files=${J(p.files)}`);
    r.notes.push(`composer after paste: imgs=${s.imgs} textLength=${s.text.length} (informational; Chat inserts its own attachment from the event)`);
    check('screenshot', true, await shot('row2-image.png'));
  });

  await row('3', 'Ctrl+Shift+V with HTML on the clipboard: record what Chromium does (no requirement invented)', async (check, r) => {
    await resetPage();
    await post(`await ctx.clipboard.write([new ctx.electron.ClipboardItem({
      'text/html': new Blob([${J('<b>' + HTML_TEXT + '</b>')}], { type: 'text/html' }),
      'text/plain': new Blob([${J(HTML_TEXT)}], { type: 'text/plain' }) })]); return true;`);
    const htmlTypes = await clipTypes();
    check('precondition: the clipboard holds text/html', htmlTypes.some((t) => t.includes('text/html')), `clipboard types=${J(htmlTypes)}`);
    await pressPaste(true);
    const s = await pageState();
    const p = s.pastes[0] || { items: [], files: [], types: [] };
    check('a paste event fired (Ctrl+Shift+V reached the page)', s.pastes.length >= 1, `paste events=${s.pastes.length} types=${J(p.types)}`);
    r.notes.push(`OBSERVED: paste events=${s.pastes.length}, clipboardData types=${J(p.types)}, composer text="${s.text}", composer html="${s.html}", bold element present=${/<b>|<strong>|font-weight/i.test(s.html)}, result is plain text=${s.text === HTML_TEXT && !/<b>|<strong>|font-weight/i.test(s.html)}`);
    // control: plain Ctrl+V of the same HTML clipboard, to show what Shift changes
    await resetPage();
    await pressPaste(false);
    const c = await pageState();
    r.notes.push(`CONTROL Ctrl+V, same clipboard: paste events=${c.pastes.length}, composer text="${c.text}", composer html="${c.html}"`);
    check('screenshot', true, await shot('row3-shift-v-html.png'));
  });

  await row('4', 'UI-08 context-menu Paste still pastes text', async (check) => {
    await resetPage();
    await post(`await ctx.clipboard.writeText(${J(PLAIN)}); return true;`);
    const p = await page(composerCenter);
    const out = await post(`ctx.wc.focus();
      const before = ctx.state.menus.length;
      ctx.wc.sendInputEvent({ type: 'mouseMove', x: ${p.x}, y: ${p.y} });
      ctx.wc.sendInputEvent({ type: 'mouseDown', x: ${p.x}, y: ${p.y}, button: 'right', clickCount: 1 });
      ctx.wc.sendInputEvent({ type: 'mouseUp', x: ${p.x}, y: ${p.y}, button: 'right', clickCount: 1 });
      await ctx.sleep(900);
      const popped = ctx.state.menus.slice(before).filter((m) => m.popped);
      return popped.length ? popped[popped.length - 1].items : null;`);
    const paste = (out || []).find((i) => i.label === 'Paste');
    check('context menu popped with an enabled Paste', !!paste && paste.enabled === true, J(out && out.map((i) => i.label + (i.enabled === false ? '(disabled)' : ''))));
    if (!paste || !paste.enabled) return;
    await post(`return ctx.clickItem('Paste');`);
    await sleep(800);
    const s = await pageState();
    check('Paste action: clipboard text lands in the composer', s.text === PLAIN, `field="${s.text}"`);
    check('screenshot', true, await shot('row4-context-menu-paste.png'));
  });

  await row('5', 'File paste from Explorer', async (check, r) => {
    r.status = 'NOT RUN';
    r.notes.push('NOT RUN headless: owner Windows hand check (a file copied in Explorer cannot be put on the clipboard of a Linux/Xvfb container).');
  });

  const alive = !A.exited && !!(await getState().catch(() => ({}))).pid;
  const ran = rows.filter((r) => r.status !== 'NOT RUN');
  const pass = ran.every((r) => r.status === 'PASS');
  const lines = [`BUG-11 paste acceptance, tree=${TREE}: ${pass ? 'ALL RUN ROWS PASS' : 'FAIL'}`, `electron ${process.env.GCD_ELECTRON_VERSION || ''} on Linux/Xvfb, app alive at end: ${alive}`];
  for (const r of rows) {
    lines.push('', `Row ${r.id}: ${r.title}  =>  ${r.status}`);
    for (const c of r.checks) lines.push(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}\n         evidence: ${c.evidence}`);
    for (const n of r.notes) lines.push(`  NOTE: ${n}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'rows.json'), J(rows, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'result.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'summary.txt'), rows.map((r) => `row ${r.id}: ${r.status}`).join('\n') + `\ntree: ${TREE}\noverall: ${pass ? 'PASS' : 'FAIL'}\n`);
  console.log(lines.join('\n'));

  if (!A.exited) A.child.kill('SIGKILL'); // started by this script
  server.close();
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error('[e2e] harness error:', err);
  if (current && current.child && !current.exited) current.child.kill('SIGKILL');
  process.exit(2);
});
