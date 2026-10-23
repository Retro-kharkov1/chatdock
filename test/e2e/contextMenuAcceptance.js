'use strict';

// UI-08 acceptance table, in-container driver. Runs the REAL app (src/main/index.js, unmodified) under Xvfb against a
// local https stub of chat.google.com (contextMenuStub.js) and drives it with real input events: a right mouse
// button press and release sent to the Chat window (webContents.sendInputEvent), so Chromium itself decides whether
// a `context-menu` event fires and the app's own listener builds and pops the menu. The test-only hook (hookMain.js,
// loaded through the package.json "main" of the container's copy of the repo) records the built menus and params and
// activates a menu item like a click would. Nothing in src/** is changed.
//
// Env (set by in-container.sh): GCD_E2E_RUN=1, GCD_ELECTRON, GCD_APP_DIR, GCD_OUT_DIR, GCD_CERT_DIR, GCD_DICT_FILE.
// Without GCD_E2E_RUN this file does nothing (`node --test` treats every .js under test/ as a test file).

if (!process.env.GCD_E2E_RUN) process.exit(0);

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { dictRequests, startStubServer, CHAT_HOST, LINK_URL } = require('./contextMenuStub');

const PORT = 8443;
const HOOK = 9333;
const APP_DIR = process.env.GCD_APP_DIR;
const OUT_DIR = process.env.GCD_OUT_DIR;
const CERT_DIR = process.env.GCD_CERT_DIR;
const DICT_FILE = process.env.GCD_DICT_FILE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

const rows = [];
const allPopped = []; // every context menu that was popped, both launches: { launch, row, items }
const aliveChecks = [];
let current = null; // the running launch

// ---- control channel -------------------------------------------------------------------------------------------
async function post(code) {
  const r = await fetch(`http://127.0.0.1:${HOOK}/eval`, { method: 'POST', body: J({ code }) });
  const j = await r.json();
  if (j.error) throw new Error('eval: ' + j.error);
  return j.result;
}
const getState = async () => (await fetch(`http://127.0.0.1:${HOOK}/state`)).json();
const page = (js) => post(`return await ctx.wc.executeJavaScript(${J(js)});`);

// ---- page snippets ---------------------------------------------------------------------------------------------
const center = (rectExpr) =>
  `(()=>{const b=${rectExpr};return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};})()`;
const selPoint = (s) => center(`document.querySelector(${J(s)}).getBoundingClientRect()`);
const wordPoint = (w) =>
  `(()=>{const c=document.getElementById('composer');const t=document.createTreeWalker(c,NodeFilter.SHOW_TEXT);let n;` +
  `while((n=t.nextNode())){const i=n.data.indexOf(${J(w)});if(i>=0){const r=document.createRange();r.setStart(n,i);` +
  `r.setEnd(n,i+${w.length});const b=r.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};}}` +
  `throw new Error('word not found');})()`;
const selectionPoint = center('getSelection().getRangeAt(0).getBoundingClientRect()');
const composerLineEnd = `(()=>{const r=document.getElementById('composer').getBoundingClientRect();return {x:Math.round(r.right-20),y:Math.round(r.top+17)};})()`;
const composerLine = `(()=>{const r=document.getElementById('composer').getBoundingClientRect();return {x:Math.round(r.left+40),y:Math.round(r.top+17)};})()`;
const emptySpacePoint = `({x:Math.round(innerWidth*0.8),y:Math.round(innerHeight*0.85)})`;
const setText = (t) =>
  `(()=>{const c=document.getElementById('composer');c.focus();getSelection().selectAllChildren(c);document.execCommand('delete');` +
  (t ? `document.execCommand('insertText',false,${J(t)});` : '') +
  `return c.textContent;})()`;
const selectWord = (w) =>
  `(()=>{const c=document.getElementById('composer');c.focus();const t=document.createTreeWalker(c,NodeFilter.SHOW_TEXT);let n;` +
  `while((n=t.nextNode())){const i=n.data.indexOf(${J(w)});if(i>=0){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+${w.length});` +
  `getSelection().removeAllRanges();getSelection().addRange(r);return getSelection().toString();}}throw new Error('word not found');})()`;
const composerText = `document.getElementById('composer').textContent`;
// Spellcheck (row 2): Chromium only marks misspellings in a focused, active frame, and (probe spellProbe/main.js,
// Electron 44.4.3 on Xvfb) not for text inserted by wc.insertText with no word boundary after the last word: the same
// text typed as real key events (keyDown/char/keyUp, the way a user types) is flagged. So type with key events, then
// let the idle spellchecker run.
async function typeInto(t) {
  await page(setText(''));
  await post(`const w = ctx.electron.BrowserWindow.fromWebContents(ctx.wc); w.show(); w.focus(); ctx.wc.focus();`);
  await page(`document.getElementById('composer').focus()`);
  await post(`for (const ch of ${J(t)}) { ctx.wc.sendInputEvent({ type: 'keyDown', keyCode: ch }); ctx.wc.sendInputEvent({ type: 'char', keyCode: ch }); ctx.wc.sendInputEvent({ type: 'keyUp', keyCode: ch }); await ctx.sleep(15); }`);
  await sleep(2500);
  return page(`({ text: document.getElementById('composer').textContent, hasFocus: document.hasFocus(), active: document.activeElement && document.activeElement.id })`);
}

// ---- observations ----------------------------------------------------------------------------------------------
/** Real right click at a page point. Returns the new context-menu events and the new popped menus. */
async function rightClick(pointJs, rowId) {
  const out = await post(
    `const p = await ctx.wc.executeJavaScript(${J(pointJs)});
     ctx.wc.focus();
     const before = { ev: ctx.state.contextEvents.length, menus: ctx.state.menus.length, pop: ctx.state.popups };
     ctx.wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
     ctx.wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'right', clickCount: 1 });
     ctx.wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'right', clickCount: 1 });
     await ctx.sleep(900);
     return { p, events: ctx.state.contextEvents.slice(before.ev),
       popped: ctx.state.menus.slice(before.menus).filter((m) => m.popped).map((m) => m.menu.items.map((i) => ({ label: i.label, role: i.role || null, type: i.type, enabled: i.enabled }))),
       popDelta: ctx.state.popups - before.pop };`
  );
  for (const items of out.popped) allPopped.push({ launch: current.name, row: rowId, items });
  out.items = out.popped.length ? out.popped[out.popped.length - 1] : null;
  return out;
}
const fmt = (items) => (items ? '[' + items.map((i) => (i.type === 'separator' ? '---' : i.label + (i.enabled === false ? '(disabled)' : ''))).join(' | ') + ']' : 'no menu');
const labelOf = (items, l) => (items || []).find((i) => i.label === l);
const enabledOf = (items, l) => (labelOf(items, l) ? labelOf(items, l).enabled : undefined);
// Electron 44's clipboard is promise-based (clear, has, read, readText, write, writeText; no readImage): text through
// readText(), the image through read() -> ClipboardItem.getType('image/*') -> Blob -> nativeImage.
const clip = () =>
  post(`const text = await ctx.clipboard.readText();
const items = await ctx.clipboard.read();
let image = { empty: true, size: { width: 0, height: 0 }, types: [] };
for (const it of items) {
  const types = it.types || [];
  const t = types.find((x) => /^image[/]/.test(x));
  if (!t) continue;
  const blob = await it.getType(t);
  const img = ctx.electron.nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
  image = { empty: img.isEmpty(), size: img.getSize(), types };
}
return { text, image };`);
const clearClip = () => post(`ctx.clipboard.clear(); return true;`);
const click = (label) => post(`return ctx.clickItem(${J(label)});`);
const text = () => page(composerText);

async function alive(what) {
  let ok = false;
  try {
    ok = !current.exited && !!(await getState()).pid;
  } catch {
    ok = false;
  }
  aliveChecks.push({ after: what, alive: ok });
  return ok;
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

function findFiles(dir, re, acc = []) {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, re, acc);
    else if (re.test(e.name)) acc.push(p);
  }
  return acc;
}

function countLog(re) {
  try {
    return fs.readFileSync(current.logFile, 'utf8').split(/\r?\n/).filter((l) => re.test(l)).length;
  } catch {
    return 0;
  }
}

// ---- row bookkeeping -------------------------------------------------------------------------------------------
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
  console.log(`[e2e] row ${id}: ${r.status}`);
}

// ---- app launch ------------------------------------------------------------------------------------------------
async function launch(name, cfgHome, home) {
  const rules = `MAP ${CHAT_HOST} 127.0.0.1:${PORT}`;
  const args = [
    APP_DIR,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--host-resolver-rules=${rules}`,
    '--ignore-certificate-errors',
  ];
  const logFile = path.join(OUT_DIR, `electron-output-${name}.log`);
  const logStream = fs.createWriteStream(logFile);
  const child = spawn(process.env.GCD_ELECTRON, args, {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: cfgHome,
      HOME: home,
      ELECTRON_ENABLE_LOGGING: '1',
      GCD_E2E_HOOK: '1',
      GCD_HOOK_PORT: String(HOOK),
      GCD_DICT_URL: `https://${CHAT_HOST}/dict/`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(logStream, { end: false });
  child.stderr.pipe(logStream, { end: false });
  const l = { name, child, logFile, exited: null, cfgHome, home };
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
  l.langs = await post(`return ctx.ensureSpell(ctx.wc.session);`);
  const chatSid = await post('return ctx.chatSid();');
  const dictDeadline = Date.now() + 90000;
  for (;;) {
    const st = await getState();
    if (st.spell.some((e) => e.ev === 'initialized' && e.sid === chatSid)) {
      l.dict = 'initialized';
      break;
    }
    if (st.spell.some((e) => e.ev === 'download-failure' && e.sid === chatSid)) {
      l.dict = 'download-failure';
      break;
    }
    if (Date.now() > dictDeadline) {
      l.dict = 'timeout';
      break;
    }
    await sleep(500);
  }
  l.spellEvents = (await getState()).spell.map((e) => e.ev + '@s' + e.sid + (e.lang ? ':' + e.lang : ''));
  console.log('[e2e] launch ' + name + ' spell diagnostics: chatSid=' + chatSid + ' events=' + J(l.spellEvents) + ' info=' + J(await post('return ctx.spellInfo();')) + ' dictRequests=' + J(dictRequests));
  return l;
}

async function exitViaTray(l) {
  await post(`return ctx.trayExit();`);
  const deadline = Date.now() + 20000;
  while (!l.exited && Date.now() < deadline) await sleep(300);
  if (!l.exited) {
    l.child.kill('SIGKILL'); // started by this script
    await sleep(1000);
    return { exitedByTray: false };
  }
  return { exitedByTray: true, ...l.exited };
}

// ---- main ------------------------------------------------------------------------------------------------------
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const { server } = await startStubServer({
    key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
    cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
    port: PORT,
    dictFile: DICT_FILE,
  });
  const cfgHome = fs.mkdtempSync('/tmp/gcd-cfg-');
  const home = fs.mkdtempSync('/tmp/gcd-home-');
  const A = await launch('A', cfgHome, home);
  const dictOk = A.dict === 'initialized';
  console.log(`[e2e] launch A ready; spellcheck langs=${J(A.langs)} dictionary=${A.dict}`);
  let trayA = null;
  let menusA = [];

  // Row 1: editable field (composer stub).
  await row('1', 'Editable field: Cut, Copy, Paste, Select all, enabled per state, each action works', async (check) => {
    // State A: empty field, clipboard empty.
    await page(setText(''));
    await clearClip();
    let r = await rightClick(composerLine, '1');
    check('A empty field, clipboard empty: menu shows Cut, Copy, Paste, Select all', ['Cut', 'Copy', 'Paste', 'Select all'].every((l) => labelOf(r.items, l)), fmt(r.items));
    check('A: Cut, Copy, Paste disabled', enabledOf(r.items, 'Cut') === false && enabledOf(r.items, 'Copy') === false && enabledOf(r.items, 'Paste') === false, `editFlags=${J(r.events.at(-1) && r.events.at(-1).editFlags)}`);
    check('A: context-menu params isEditable', !!(r.events.at(-1) && r.events.at(-1).isEditable), `selectAll observed enabled=${enabledOf(r.items, 'Select all')}`);
    await alive('row1 state A');

    // State B: text selected, clipboard empty.
    await page(setText('hello world'));
    await page(selectWord('hello'));
    await clearClip();
    r = await rightClick(selectionPoint, '1');
    check('B text selected, clipboard empty: Cut, Copy, Select all enabled; Paste disabled', enabledOf(r.items, 'Cut') === true && enabledOf(r.items, 'Copy') === true && enabledOf(r.items, 'Select all') === true && enabledOf(r.items, 'Paste') === false, fmt(r.items));
    await clearClip(); // the silent copy-on-select may have written on mouse release; assert only the menu action's effect
    await click('Cut');
    await sleep(400);
    let c = await clip();
    let t = await text();
    check('Cut action: clipboard holds the selection and the field lost it', c.text === 'hello' && !t.includes('hello'), `clipboard="${c.text}" field="${t}"`);

    await page(setText('hello world'));
    await page(selectWord('hello'));
    r = await rightClick(selectionPoint, '1');
    await clearClip();
    await click('Copy');
    await sleep(400);
    c = await clip();
    t = await text();
    check('Copy action: clipboard holds the selection, field unchanged', c.text === 'hello' && t === 'hello world', `clipboard="${c.text}" field="${t}"`);
    await alive('row1 cut/copy');

    // State C: clipboard full, empty field.
    await page(setText(''));
    await post(`await ctx.clipboard.writeText('PASTED-TEXT'); return true;`);
    r = await rightClick(composerLine, '1');
    check('C empty field, clipboard full: Paste enabled; Cut, Copy disabled', enabledOf(r.items, 'Paste') === true && enabledOf(r.items, 'Cut') === false && enabledOf(r.items, 'Copy') === false, fmt(r.items));
    await click('Paste');
    await sleep(400);
    t = await text();
    check('Paste action: clipboard text lands in the field', t === 'PASTED-TEXT', `field="${t}"`);
    await alive('row1 paste');

    // State D: text, nothing selected, clipboard empty -> Select all.
    await page(setText('one two'));
    await clearClip();
    r = await rightClick(composerLineEnd, '1');
    check('D text, no selection, clipboard empty: Select all enabled; Cut, Copy, Paste disabled', enabledOf(r.items, 'Select all') === true && enabledOf(r.items, 'Cut') === false && enabledOf(r.items, 'Copy') === false && enabledOf(r.items, 'Paste') === false, fmt(r.items));
    await click('Select all');
    await sleep(400);
    const sel = await page(`getSelection().toString()`);
    check('Select all action: the whole field text is selected', sel === 'one two', `selection="${sel}"`);
    check('screenshot', true, await shot('row1-composer.png'));
    await alive('row1 select all');
  });

  // Row 3: image.
  await row('3', 'Image: Copy image puts an image on the clipboard; Save image as... requests the Save dialog, never auto-saves', async (check, r3) => {
    await clearClip();
    const r = await rightClick(selPoint('#img'), '3');
    const ev = r.events.at(-1) || {};
    check('image right-click: menu has Copy image and Save image as...', !!labelOf(r.items, 'Copy image') && !!labelOf(r.items, 'Save image as...'), `${fmt(r.items)} mediaType=${ev.mediaType} hasImageContents=${ev.hasImageContents}`);
    await clearClip();
    await click('Copy image');
    let c;
    for (let i = 0; i < 20; i++) {
      c = await clip();
      if (!c.image.empty) break;
      await sleep(250);
    }
    check('Copy image: an image (64x64) is on the clipboard', !c.image.empty && c.image.size.width === 64 && c.image.size.height === 64, `clipboard image=${J(c.image)} (read back inside the app process; an image on a real OS clipboard shared with another app is not run, see notes)`);
    r3.notes.push('Clipboard is read through Electron clipboard.read() (ClipboardItem image) in the app process under Xvfb; reading it from a second X client (xclip) was not run.');
    await alive('row3 copy image');

    await rightClick(selPoint('#img'), '3');
    const homeBefore = findFiles(current.home, /\.png$/i).length;
    await click('Save image as...');
    await sleep(2500);
    const st = await getState();
    const d = st.downloads.at(-1) || {};
    const later = d.later || {};
    const opts = later.saveDialogOptions || {};
    check('Save image as...: a session will-download fired for the image URL', !!d.url && d.url.endsWith('/test.png'), `url=${d.url} filename=${d.filename}`);
    check('Save dialog requested, not auto-saved: no save path set, dialog options set by the app handler', later.savePath === '' && typeof opts.defaultPath === 'string' && opts.defaultPath.endsWith('test.png'), `savePath="${later.savePath}" state=${later.state} saveDialogOptions=${J(opts)} showSaveDialog calls=${st.dialogs.length}`);
    check('app log: download started via the existing handler', countLog(/\[gcd\] download started/) >= 1, `log lines "[gcd] download started": ${countLog(/\[gcd\] download started/)}`);
    check('no file was written to disk', findFiles(current.home, /\.png$/i).length === homeBefore && findFiles(current.home, /test\.png/).length === 0, `png files under HOME: before=${homeBefore} after=${findFiles(current.home, /\.png$/i).length}`);
    await post(`for (const i of ctx.state.items) { try { i.cancel(); } catch {} } return true;`);
    await sleep(500);
    check('screenshot', true, await shot('row3-image.png'));
    await alive('row3 save image');
  });

  // Row 4: link.
  await row('4', 'Link: Copy link puts the URL on the clipboard', async (check) => {
    await clearClip();
    const r = await rightClick(selPoint('#link'), '4');
    const ev = r.events.at(-1) || {};
    const silent = await clip();
    check('link right-click: menu has Copy link', !!labelOf(r.items, 'Copy link'), `${fmt(r.items)} linkURL=${ev.linkURL}`);
    await clearClip(); // the existing silent right-click copy (UI-05) already wrote the URL; clear so only the menu action counts
    await click('Copy link');
    await sleep(300);
    const c = await clip();
    check('Copy link: clipboard holds the link URL', c.text === LINK_URL, `clipboard="${c.text}" (before clearing, the silent UI-05 copy had written "${silent.text}")`);
    check('screenshot', true, await shot('row4-link.png'));
    await alive('row4 copy link');
  });

  // Row 5: page element with its own contextmenu handler (preventDefault).
  await row('5', 'Element whose contextmenu handler calls preventDefault: no native menu (no second menu)', async (check) => {
    const before = await getState();
    const logBefore = countLog(/\[gcd\] contextmenu shown/);
    const r = await rightClick(selPoint('#own-menu'), '5');
    await sleep(500);
    const after = await getState();
    const fired = await page(`window.__ownMenuFired`);
    const drawn = await page(`document.getElementById('own-menu-drawn').textContent`);
    const dc = await page(`window.__docContextmenu.slice(-1)[0]`);
    check('control: the page handler ran (the right click landed on the element)', fired >= 1 && drawn === 'custom page menu open', `__ownMenuFired=${fired} page menu text="${drawn}" last document-level contextmenu=${J(dc)}`);
    check('no context-menu event reached the app', after.contextEvents.length === before.contextEvents.length && r.events.length === 0, `contextEvents before=${before.contextEvents.length} after=${after.contextEvents.length}`);
    check('no native menu was popped', after.popups === before.popups && r.popDelta === 0, `popups before=${before.popups} after=${after.popups}`);
    check('app log: no new "contextmenu shown" line', countLog(/\[gcd\] contextmenu shown/) === logBefore, `lines before=${logBefore} after=${countLog(/\[gcd\] contextmenu shown/)} (control: earlier rows produced shown lines, total ${logBefore})`);
    check('control: the log does show the menu for the earlier rows (the check is not vacuous)', logBefore >= 1, `total shown lines before this row=${logBefore}`);
    check('screenshot', true, await shot('row5-own-menu.png'));
    await alive('row5 own menu');
  });

  // Row 7: empty page space.
  await row('7', 'Empty page space: no menu', async (check) => {
    const before = await getState();
    const n0 = await page(`window.__docContextmenu.length`);
    const logBefore = countLog(/\[gcd\] contextmenu shown/);
    const r = await rightClick(emptySpacePoint, '7');
    await sleep(500);
    const after = await getState();
    const n1 = await page(`window.__docContextmenu.length`);
    const dc = await page(`window.__docContextmenu.slice(-1)[0]`);
    check('control: the right click landed in the page (document contextmenu listener ran)', n1 === n0 + 1, `document-level contextmenu events ${n0} -> ${n1}, target=${J(dc)}`);
    check('no native menu was popped', after.popups === before.popups && r.popDelta === 0, `popups before=${before.popups} after=${after.popups}; new context-menu events=${J(r.events.map((e) => ({ isEditable: e.isEditable, mediaType: e.mediaType, linkURL: e.linkURL, misspelledWord: e.misspelledWord })))}`);
    check('app log: no new "contextmenu shown" line', countLog(/\[gcd\] contextmenu shown/) === logBefore, `lines before=${logBefore} after=${countLog(/\[gcd\] contextmenu shown/)}`);
    check('screenshot', true, await shot('row7-empty-space.png'));
    await alive('row7 empty space');
  });

  // Row 2, launch A part: suggestions, replace, add to dictionary.
  let addedWord = false;
  await row('2', 'Misspelled word: suggestions, replace, Add to dictionary persists across a full quit and relaunch', async (check, r2) => {
    if (!dictOk) {
      r2.status = 'NOT RUN';
      r2.notes.push(`spellcheck dictionary did not initialise (${A.dict}; events ${J(A.spellEvents)}). Needs the en-US .bdic: it is fetched into the cache by in-container.sh; network access to it is required.`);
      return;
    }
    const typed = await typeInto('I will recieve it');
    console.log('[e2e] row2 typed state: ' + J(typed) + ' spellEnabled=' + J(await post('return ctx.wc.session.isSpellCheckerEnabled();')));
    r2.notes.push('typed state ' + J(typed));
    let r = null;
    let ev = null;
    for (let i = 0; i < 15; i++) {
      r = await rightClick(wordPoint('recieve'), '2');
      ev = r.events.at(-1) || {};
      if (ev.misspelledWord) break;
      await sleep(1000);
    }
    const sugg = (ev.dictionarySuggestions || []).filter((s) => /^receive$/i.test(s));
    check('misspelled word flagged: menu shows spelling suggestions and Add to dictionary', ev.misspelledWord === 'recieve' && !!labelOf(r.items, 'receive') && !!labelOf(r.items, 'Add to dictionary'), `${fmt(r.items)} suggestions=${J(ev.dictionarySuggestions)} langs=${J(A.langs)}`);
    if (!labelOf(r.items, 'receive')) return;
    await click('receive');
    await sleep(500);
    let t = await text();
    check('picking a suggestion replaces the word', t === 'I will receive it', `field="${t}" (suggestion matched: ${J(sugg)})`);
    await alive('row2 replace');

    // Second typing for Add to dictionary: a fresh sentence (the first one was already spell-checked and corrected),
    // retried with a different one if Chromium has not flagged it; every attempt is logged.
    for (const sentence of ['We recieve it today', 'Please recieve the file now', 'They recieve mail often']) {
      const typed2 = await typeInto(sentence);
      for (let i = 0; i < 8; i++) {
        r = await rightClick(wordPoint('recieve'), '2');
        ev = r.events.at(-1) || {};
        if (ev.misspelledWord) break;
        await sleep(1000);
      }
      console.log('[e2e] row2 add-word attempt ' + J({ sentence, typed2, misspelledWord: ev.misspelledWord || '', items: fmt(r.items) }));
      if (ev.misspelledWord) break;
    }
    check('misspelled word flagged again before Add to dictionary', ev.misspelledWord === 'recieve' && !!labelOf(r.items, 'Add to dictionary'), fmt(r.items));
    if (!labelOf(r.items, 'Add to dictionary')) return;
    await click('Add to dictionary');
    addedWord = true;
    await sleep(1500);
    const dictFiles = findFiles(current.cfgHome, /^Custom Dictionary\.txt$/);
    const inFile = dictFiles.some((f) => fs.readFileSync(f, 'utf8').includes('recieve'));
    check('Add to dictionary: the persist: session wrote its custom dictionary', dictFiles.length >= 1 && inFile, `files=${J(dictFiles)} containsWord=${inFile}`);
    check('screenshot', true, await shot('row2-before-quit.png'));
    await alive('row2 add to dictionary');
  });

  // Row 6 evidence from launch A, then the only quit path (tray Exit).
  menusA = (await getState()).menus;
  fs.writeFileSync(path.join(OUT_DIR, 'menus-A.json'), J(menusA, null, 1));
  const aliveBeforeExit = await alive('end of launch A (before tray Exit)');
  trayA = await exitViaTray(A);
  console.log(`[e2e] launch A tray Exit: ${J(trayA)}`);

  // Row 2, launch B: same persist: session / userData, full relaunch.
  let B = null;
  if (addedWord) {
    B = await launch('B', cfgHome, home);
    await row('2b', 'After full quit and relaunch (same userData): the added word is no longer flagged', async (check) => {
      if (B.dict !== 'initialized') {
        rows[rows.length - 1].status = 'NOT RUN';
        rows[rows.length - 1].notes.push(`dictionary did not initialise on relaunch (${B.dict})`);
        return;
      }
      await typeInto('Also wrold and recieve here');
      let r = null;
      let ev = null;
      for (let i = 0; i < 15; i++) {
        r = await rightClick(wordPoint('wrold'), '2b');
        ev = r.events.at(-1) || {};
        if (ev.misspelledWord) break;
        await sleep(1000);
      }
      check('control: spellcheck is live after relaunch (another misspelling is still flagged)', ev.misspelledWord === 'wrold' && !!labelOf(r.items, 'Add to dictionary'), `${fmt(r.items)} misspelledWord="${ev.misspelledWord}"`);
      r = await rightClick(wordPoint('recieve'), '2b');
      ev = r.events.at(-1) || {};
      check('added word is not flagged: no misspelledWord, no spelling section, no Add to dictionary', !ev.misspelledWord && !labelOf(r.items, 'Add to dictionary'), `${fmt(r.items)} misspelledWord="${ev.misspelledWord || ''}"`);
      check('screenshot', true, await shot('row2-after-relaunch.png'));
      await alive('row2b relaunch');
    });
  }

  // Row 6: quit entries and keep-running.
  const trayB = B ? (await getState().catch(() => ({ menus: [] }))).menus : [];
  if (B) fs.writeFileSync(path.join(OUT_DIR, 'menus-B.json'), J(trayB, null, 1));
  const aliveBeforeExitB = B ? await alive('end of launch B (before tray Exit)') : true;
  const trayExitB = B ? await exitViaTray(B) : null;
  await row('6', 'No menu offers Quit, Exit or Close; the app keeps running after every menu action; the only quit path is the tray menu', async (check) => {
    const re = /quit|exit|close|minimi[sz]e|hide/i;
    const roles = /^(quit|close|minimize|hide|hideothers|togglefullscreen|zoom|front)$/i;
    const offenders = allPopped.filter((m) => m.items.some((i) => re.test(i.label || '') || roles.test(i.role || '')));
    const labels = [...new Set(allPopped.flatMap((m) => m.items.map((i) => i.label)).filter(Boolean))];
    check('no popped context menu has a Quit / Exit / Close / window-management item', allPopped.length >= 8 && offenders.length === 0, `${allPopped.length} context menus popped in total; distinct labels: ${J(labels)}; offenders=${offenders.length}`);
    const failedAlive = aliveChecks.filter((a) => !a.alive);
    check('the app kept running after every menu action', aliveChecks.length >= 10 && failedAlive.length === 0 && aliveBeforeExit && aliveBeforeExitB, `${aliveChecks.length} liveness checks after menu actions, failures=${J(failedAlive)}`);
    const trayMenu = menusA.filter((m) => !m.popped && m.items.some((i) => i.label === 'Exit')).at(-1);
    check('the tray menu has an Exit item, and it is not a context menu', !!trayMenu && !allPopped.some((m) => m.items.some((i) => i.label === 'Exit')), `tray items=${J(trayMenu ? trayMenu.items.map((i) => i.label) : null)}`);
    check('tray Exit quits the app (launch A and B)', trayA.exitedByTray === true && (!trayExitB || trayExitB.exitedByTray === true), `A=${J(trayA)} B=${J(trayExitB)}`);
  });

  // ---- report ----
  const order = ['1', '2', '2b', '3', '4', '5', '6', '7'];
  rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const lines = [];
  const pass = rows.every((r) => r.status === 'PASS');
  const anyFail = rows.some((r) => r.status === 'FAIL');
  lines.push(`UI-08 context menu acceptance table: ${pass ? 'ALL PASS' : anyFail ? 'FAIL' : 'INCOMPLETE (rows not run)'}`);
  lines.push(`electron ${process.env.GCD_ELECTRON_VERSION || ''} on Linux/Xvfb, stub origin https://${CHAT_HOST}, spellcheck dictionary: ${A.dict}`);
  for (const r of rows) {
    lines.push('');
    lines.push(`Row ${r.id}: ${r.title}  =>  ${r.status}`);
    for (const c of r.checks) lines.push(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}\n         evidence: ${c.evidence}`);
    for (const n of r.notes) lines.push(`  NOTE: ${n}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'rows.json'), J(rows, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'context-menus-popped.json'), J(allPopped, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'result.txt'), lines.join('\n') + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'summary.txt'), rows.map((r) => `row ${r.id}: ${r.status}`).join('\n') + `\noverall: ${pass ? 'PASS' : anyFail ? 'FAIL' : 'INCOMPLETE'}\n`);
  for (const f of findFiles(cfgHome, /^diagnostics.*\.log$/)) fs.copyFileSync(f, path.join(OUT_DIR, 'diagnostics-' + path.basename(f)));
  console.log(lines.join('\n'));

  for (const l of [A, B]) if (l && !l.exited) l.child.kill('SIGKILL');
  server.close();
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.error('[e2e] harness error:', err);
  if (current && current.child && !current.exited) current.child.kill('SIGKILL');
  process.exit(2);
});
