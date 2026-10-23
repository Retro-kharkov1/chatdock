'use strict';

// BUG-10 reload / recovery acceptance table, in-container driver. Runs the REAL app (src/main/index.js; the "prefix" tree
// differs only by the missing mainReload wiring, derived by in-container.sh) under Xvfb against a local https stub of
// chat.google.com that the driver can make unreachable and reachable again. Real key events go through
// webContents.sendInputEvent. Nothing in src/** of the repo is changed. The back-off is the real one (2 s, 5 s, ...):
// there is no test seam for it, so rows wait for the real steps.
//
// Env (set by in-container.sh): GCD_E2E_RUN=1, GCD_TREE (fix|prefix), GCD_ELECTRON, GCD_APP_DIR, GCD_OUT_DIR, GCD_CERT_DIR.
// Without GCD_E2E_RUN this file does nothing (`node --test` treats every .js under test/ as a test file).

if (!process.env.GCD_E2E_RUN) process.exit(0);

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createStub, CHAT_HOST, SIGN_IN_HOST, OTHER_HOST } = require('./reloadStub');

const PORT = 8443;
const HOOK = 9334;
const TREE = process.env.GCD_TREE || 'fix';
const APP_DIR = process.env.GCD_APP_DIR;
const OUT_DIR = process.env.GCD_OUT_DIR;
const CERT_DIR = process.env.GCD_CERT_DIR;
const LOG_FILE = path.join(OUT_DIR, 'electron-output.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const rows = [];
let current = null;
let stub = null;

async function post(code) {
  const r = await fetch(`http://127.0.0.1:${HOOK}/eval`, { method: 'POST', body: J({ code }) });
  const j = await r.json();
  if (j.error) throw new Error('eval: ' + j.error);
  return j.result;
}
const getState = async () => (await fetch(`http://127.0.0.1:${HOOK}/state`)).json();

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not ready */
    }
    if (Date.now() >= end) return null;
    await sleep(stepMs);
  }
}

/** The main window shows the Chat stub page (document loaded, marker element present). */
const chatPageUp = () =>
  post(`return ctx.wc ? await ctx.wc.executeJavaScript("location.origin === 'https://${CHAT_HOST}' && !!document.getElementById('chat-stub')") : false;`);
const currentUrl = () => post(`return ctx.wc ? ctx.hostPath(ctx.wc.getURL()) : null;`);
const mainFails = async () => (await getState()).events.filter((e) => e.ev === 'fail' && e.isMainFrame);
const appLoadsAfter = async (t) => (await getState()).loads.filter((l) => l.by === 'app' && l.t > t);
const now = async () => (await getState()).now;

async function shot(name) {
  try {
    const b64 = await post(`return (await ctx.wc.capturePage()).toPNG().toString('base64');`);
    fs.writeFileSync(path.join(OUT_DIR, name), Buffer.from(b64, 'base64'));
    return name;
  } catch (err) {
    return 'screenshot failed: ' + err.message;
  }
}

async function pressKey(keyCode, mods) {
  const m = J(mods);
  await post(`ctx.wc.focus();
    ctx.wc.sendInputEvent({ type: 'keyDown', keyCode: ${J(keyCode)}, modifiers: ${m} });
    ctx.wc.sendInputEvent({ type: 'keyUp', keyCode: ${J(keyCode)}, modifiers: ${m} });
    return true;`);
}

/** Driver-initiated load of a URL in the main window, tagged 'driver'. Its rejection (a failed load) is expected. */
const driverLoad = (url) => post(`ctx.asDriver(() => { Promise.resolve(ctx.wc.loadURL(${J(url)})).catch(() => {}); }); return true;`);

function readLog() {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8');
  } catch {
    return '';
  }
}

async function row(id, title, fn) {
  const r = { id, title, status: 'PASS', checks: [], notes: [] };
  rows.push(r);
  const check = (name, ok, evidence) => {
    r.checks.push({ name, ok: !!ok, evidence: evidence === undefined ? '' : String(evidence) });
    if (!ok && r.status === 'PASS') r.status = 'FAIL';
  };
  try {
    await fn(check, r);
  } catch (err) {
    r.status = 'FAIL';
    r.checks.push({ name: 'automation/app error', ok: false, evidence: String(err && err.stack ? err.stack.split('\n').slice(0, 3).join(' / ') : err) });
  } finally {
    await killApp();
    await stub.stop();
  }
  console.log(`[e2e] (${TREE}) row ${id}: ${r.status}`);
}

/** Start the app. stubUp=false leaves the stub unreachable (connection refused) at launch. */
async function launch(stubUp) {
  if (stubUp) await stub.start();
  else await stub.stop();
  const cfgHome = fs.mkdtempSync('/tmp/gcd-cfg-');
  const home = fs.mkdtempSync('/tmp/gcd-home-');
  const rules = [`MAP ${CHAT_HOST} 127.0.0.1:${PORT}`, `MAP ${SIGN_IN_HOST} 127.0.0.1:${PORT}`, `MAP ${OTHER_HOST} 127.0.0.1:1`].join(', ');
  const args = [APP_DIR, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', `--host-resolver-rules=${rules}`, '--ignore-certificate-errors'];
  const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  logStream.write(`\n==== launch (tree=${TREE}, stubUp=${stubUp}) ====\n`);
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
  const up = await waitFor(async () => (l.exited ? Promise.reject(new Error('app exited during startup ' + J(l.exited))) : (await getState()).hasWindow), 60000, 500);
  if (!up) throw new Error('main window was not created in 60 s');
  return l;
}

async function killApp() {
  const l = current;
  current = null;
  if (!l || l.exited) return;
  l.child.kill('SIGKILL'); // started by this script
  await waitFor(() => l.exited, 10000, 100);
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, '');
  stub = createStub({
    key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
    cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
    port: PORT,
  });

  // ---- Row 1 -------------------------------------------------------------------------------------------------------
  await row('1', 'Offline launch (failed main-frame load), then the stub becomes reachable: the window recovers by itself, no user action', async (check, r) => {
    await launch(false);
    const failed = await waitFor(async () => (await mainFails()).length > 0, 30000);
    check('precondition: the launch load failed (main frame, stub unreachable)', failed, J(await mainFails()));
    check('precondition: no page is shown', !(await chatPageUp().catch(() => false)), 'url=' + (await currentUrl().catch(() => '?')));
    const tFail = await now();
    await sleep(3000); // past the 2 s step: the second try (5 s step) will also find it down only if the stub stays down
    await stub.start();
    const tUp = await now();
    const recovered = await waitFor(chatPageUp, 20000);
    const tRec = await now();
    const st = await getState();
    check('the Chat stub page loads without any user action', recovered, `failed at ${tFail} ms, stub up at ${tUp} ms, recovered=${!!recovered} at ${tRec} ms; url=${await currentUrl().catch(() => '?')}`);
    check('the retry was the app\'s own (no driver-initiated load)', st.loads.every((l) => l.by === 'app'), J(st.loads));
    r.notes.push(`loads: ${J(st.loads)}; events: ${J(st.events)}`);
    r.notes.push(`stub requests for /: ${stub.rootCount()}`);
    check('screenshot', true, await shot('row1-recovered.png'));
  });

  // ---- Row 2 -------------------------------------------------------------------------------------------------------
  await row('2', 'Same as row 1 with the window hidden to tray: recovers while hidden, window stays alive, no background-throttling flag', async (check, r) => {
    await launch(false);
    check('precondition: the launch load failed', await waitFor(async () => (await mainFails()).length > 0, 30000), J(await mainFails()));
    const wasVisible = await waitFor(() => post(`return ctx.win.isVisible();`), 8000);
    r.notes.push(`window visible before hide: ${!!wasVisible}`);
    // The real close (X) path: the app's own close handler hides to tray.
    await post(`ctx.win.close(); return true;`);
    await sleep(500);
    const hidden = await post(`return { visible: ctx.win.isVisible(), destroyed: ctx.win.isDestroyed() };`);
    check('precondition: the window is hidden to tray and alive', hidden.visible === false && hidden.destroyed === false, J(hidden));
    await sleep(2500);
    await stub.start();
    const recovered = await waitFor(chatPageUp, 20000);
    check('the page recovers while the window is hidden', recovered, `url=${await currentUrl().catch(() => '?')}`);
    const after = await post(`return { visible: ctx.win.isVisible(), destroyed: ctx.win.isDestroyed(), throttling: ctx.wc.getLastWebPreferences().backgroundThrottling,
      vis: await ctx.wc.executeJavaScript('document.visibilityState') };`).catch((e) => ({ error: String(e) }));
    check('the window is not destroyed', after.destroyed === false, J(after));
    check('no backgroundThrottling:false flag on the window', after.throttling !== false, `backgroundThrottling=${after.throttling}`);
    check('the retry did not show the window', after.visible === false, `visible=${after.visible}`);
    r.notes.push(`document.visibilityState after recovery: ${after.vis}`);
    r.notes.push(`events: ${J((await getState()).events)}`);
  });

  // ---- Row 3 -------------------------------------------------------------------------------------------------------
  await row('3', 'After a failure F5 retries at once; Ctrl+R and Ctrl+Shift+R reload the main window', async (check, r) => {
    await launch(false);
    check('precondition: the launch load failed', await waitFor(async () => (await mainFails()).length > 0, 30000), J(await mainFails()));
    // Let the 2 s step (fix tree) fail once more, so the next automatic try is a 5 s step away.
    await sleep(3000);
    const before = (await getState()).loads.length;
    await stub.start();
    const tPress = await now();
    await pressKey('F5', []);
    const recovered = await waitFor(chatPageUp, 3000, 100);
    const tRec = await now();
    const loads = (await getState()).loads.slice(before);
    check('F5 after a failure loads the Chat page within 3 s (the automatic next step is 5 s away)', recovered, `pressed at ${tPress} ms, recovered=${!!recovered} at ${tRec} ms; new loads: ${J(loads)}`);
    if (!recovered) {
      await driverLoad(`https://${CHAT_HOST}/`); // continue the table on the prefix tree
      await waitFor(chatPageUp, 10000);
    }

    let n0 = stub.rootCount();
    await pressKey('R', ['control']);
    const reloaded = await waitFor(() => stub.rootCount() > n0, 4000, 100);
    check('Ctrl+R reloads the main window (a new request for the page reaches the stub)', reloaded, `requests ${n0} -> ${stub.rootCount()}`);
    await waitFor(chatPageUp, 5000);
    check('Ctrl+R went through webContents.reload()', (await getState()).loads.some((l) => l.kind === 'reload' && l.by === 'app'), J((await getState()).loads.filter((l) => l.kind !== 'loadURL')));

    n0 = stub.rootCount();
    await pressKey('R', ['control', 'shift']);
    const hard = await waitFor(() => stub.rootCount() > n0, 4000, 100);
    check('Ctrl+Shift+R reloads the main window', hard, `requests ${n0} -> ${stub.rootCount()}`);
    const last = stub.requests.filter((q) => q.path === '/').pop();
    check('Ctrl+Shift+R ignores the cache (reloadIgnoringCache, request says no-cache)', (await getState()).loads.some((l) => l.kind === 'reloadIgnoringCache' && l.by === 'app') && /no-cache/i.test(last ? last.cacheControl : ''), `cache-control="${last && last.cacheControl}"`);
    check('screenshot', true, await shot('row3-reloaded.png'));
  });

  // ---- Row 4 -------------------------------------------------------------------------------------------------------
  await row('4', 'A failed URL outside the Chat origins is never retried; the start page is loaded instead', async (check, r) => {
    await launch(true);
    check('precondition: the Chat stub loaded', await waitFor(chatPageUp, 30000), 'url=' + (await currentUrl().catch(() => '?')));
    const tStart = await now();
    await driverLoad(`https://${OTHER_HOST}/`);
    const failed = await waitFor(async () => (await mainFails()).some((e) => e.url.includes(OTHER_HOST)), 15000);
    check('precondition: the non-Chat load failed (main frame)', failed, J(await mainFails()));
    const recovered = await waitFor(chatPageUp, 15000);
    check('the start page (Chat stub) is loaded without any user action', recovered, 'url=' + (await currentUrl().catch(() => '?')));
    await sleep(7000); // longer than the 2 s and 5 s steps: a retry of the failed URL would have shown up
    const appLoads = await appLoadsAfter(tStart);
    check('the app never retried the failed non-Chat URL', appLoads.every((l) => !l.url.includes(OTHER_HOST)), J(appLoads));
    check('every app-initiated load targets a Chat origin (the start page)', appLoads.every((l) => l.url.startsWith(`https://${CHAT_HOST}/`)), J(appLoads));
    check('the window stays on the start page', (await chatPageUp().catch(() => false)) && (await currentUrl()) === `https://${CHAT_HOST}/`, 'url=' + (await currentUrl().catch(() => '?')));
    check('screenshot', true, await shot('row4-start-page.png'));
  });

  // ---- Row 5 -------------------------------------------------------------------------------------------------------
  await row('5', 'Sign-in mode (FR-19): a failed load is not retried automatically', async (check, r) => {
    await launch(true);
    check('precondition: the Chat stub loaded', await waitFor(chatPageUp, 30000), 'url=' + (await currentUrl().catch(() => '?')));
    // Entry A: a committed main-frame navigation to the sign-in origin turns the mode on (signInFlow.onCommitted).
    await driverLoad(`https://${SIGN_IN_HOST}/`);
    const onSignIn = await waitFor(async () => (await getState()).events.some((e) => e.ev === 'finish' && e.url.startsWith(`https://${SIGN_IN_HOST}/`)), 15000);
    await sleep(500);
    const modeOn = /sign-in mode on/.test(readLog());
    if (!onSignIn || !modeOn) {
      r.status = 'NOT RUN';
      r.notes.push(`NOT RUN: could not enter the sign-in mode from the stub (sign-in page finished=${!!onSignIn}, "sign-in mode on" in app log=${modeOn}).`);
      return;
    }
    r.notes.push('sign-in mode entered from the stub: a main-frame commit on the sign-in origin (accounts.google.com mapped to the stub); confirmed by the app log line "sign-in mode on".');
    const tFail0 = await now();
    await driverLoad(`https://${SIGN_IN_HOST}/reset`); // the stub destroys the socket: a failed main-frame load while the mode is on
    const failed = await waitFor(async () => (await mainFails()).some((e) => e.url.includes('/reset')), 15000);
    check('precondition: the load failed while the sign-in mode is on', failed, J(await mainFails()));
    await sleep(9000); // past the 2 s and 5 s steps
    const appLoads = await appLoadsAfter(tFail0);
    check('no automatic retry: the app issued no load or reload', appLoads.length === 0, J(appLoads));
    check('the window did not go back to the Chat page by itself', !(await chatPageUp().catch(() => false)), 'url=' + (await currentUrl().catch(() => '?')));
    if (TREE === 'fix') check('the fix tree saw the failure and held back (log "main load failed")', /main load failed/.test(readLog()), 'log line present=' + /main load failed/.test(readLog()));
    r.notes.push('This row is a guard: it passes on the prefix tree too (the prefix never retries). Row 4 shows the same failure kind is retried outside the mode.');
  });

  const ran = rows.filter((r) => r.status !== 'NOT RUN');
  const pass = ran.every((r) => r.status === 'PASS');
  const lines = [`BUG-10 reload acceptance, tree=${TREE}: ${pass ? 'ALL RUN ROWS PASS' : 'FAIL'}`, `electron ${process.env.GCD_ELECTRON_VERSION || ''} on Linux/Xvfb`];
  for (const r of rows) {
    lines.push('', `Row ${r.id}: ${r.title}  =>  ${r.status}`);
    for (const c of r.checks) lines.push(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}\n         evidence: ${c.evidence}`);
    for (const n of r.notes) lines.push(`  NOTE: ${n}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'rows.json'), J(rows, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'result.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'summary.txt'), rows.map((r) => `row ${r.id}: ${r.status}`).join('\n') + `\ntree: ${TREE}\noverall: ${pass ? 'PASS' : 'FAIL'}\n`);
  console.log(lines.join('\n'));
  await killApp();
  await stub.stop();
  process.exit(pass ? 0 : 1);
})().catch(async (err) => {
  console.error('[e2e] harness error:', err);
  await killApp().catch(() => {});
  process.exit(2);
});
