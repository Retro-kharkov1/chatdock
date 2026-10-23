// Spellcheck probe (UI-08 row 2): a minimal Electron app, NOT the product, to learn whether Chromium flags a
// misspelling in this Electron/Xvfb setup and by which typing path. Env: GCD_DICT_FILE.
const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[probe]', ...a);
app.commandLine.appendSwitch('no-sandbox');
const PAGE = '<!doctype html><body><div id="c" contenteditable="true" spellcheck="true" style="width:500px;height:60px;border:1px solid #888;margin:10px;font:16px sans-serif"></div></body>';
(async () => {
  const dict = fs.readFileSync(process.env.GCD_DICT_FILE);
  const srv = http.createServer((req, res) => {
    log('http', req.url);
    if (req.url.startsWith('/dict/')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(dict); }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await app.whenReady();
  const ses = session.defaultSession;
  const evs = [];
  for (const e of ['download-begin', 'download-success', 'download-failure', 'initialized']) ses.on('spellcheck-dictionary-' + e, () => evs.push(e));
  ses.setSpellCheckerDictionaryDownloadURL(`http://127.0.0.1:${port}/dict/`);
  ses.setSpellCheckerLanguages(['en-US']);
  for (let i = 0; i < 60 && !evs.includes('initialized'); i++) await sleep(500);
  log('dict events', JSON.stringify(evs), 'enabled', ses.isSpellCheckerEnabled(), 'langs', JSON.stringify(ses.getSpellCheckerLanguages()));
  const sandbox = process.env.PROBE_SANDBOX !== '0';
  const win = new BrowserWindow({ width: 800, height: 400, show: true, webPreferences: { sandbox, preload: path.join(__dirname, 'preload.js') } });
  const wc = win.webContents;
  const ctxEvents = [];
  wc.on('context-menu', (_e, p) => ctxEvents.push({ w: p.misspelledWord, s: p.dictionarySuggestions }));
  await win.loadURL(`http://127.0.0.1:${port}/`);
  win.show(); win.focus(); wc.focus();
  const js = (c) => wc.executeJavaScript(c);
  await sleep(1000);
  log('renderer isMisspelled(recieve)=', await js(`spellProbe.isMisspelled('recieve')`), 'isMisspelled(receive)=', await js(`spellProbe.isMisspelled('receive')`), 'suggestions=', JSON.stringify(await js(`spellProbe.suggestions('recieve')`)));
  const clear = async () => { await js(`(()=>{const c=document.getElementById('c');c.focus();c.textContent='';})()`); };
  const pointOf = () => js(`(()=>{const c=document.getElementById('c');const t=c.firstChild;const i=t.data.indexOf('recieve');const r=document.createRange();r.setStart(t,i+3);r.setEnd(t,i+4);const b=r.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)};})()`);
  const rclick = async () => {
    const p = await pointOf(); const n = ctxEvents.length;
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'right', clickCount: 1 });
    await sleep(800);
    return ctxEvents.slice(n).map((e) => e.w);
  };
  const variants = {
    insertText: async (t) => { await wc.insertText(t); },
    keyEvents: async (t) => { for (const ch of t) { wc.sendInputEvent({ type: 'keyDown', keyCode: ch }); wc.sendInputEvent({ type: 'char', keyCode: ch }); wc.sendInputEvent({ type: 'keyUp', keyCode: ch }); await sleep(15); } },
    'insertText+space': async (t) => { await wc.insertText(t + ' '); },
    'keyEvents+space': async (t) => { await variants.keyEvents(t + ' '); },
  };
  for (const [name, fn] of Object.entries(variants)) {
    await clear();
    wc.focus();
    await fn('I will recieve it now');
    for (const wait of [2500, 5000, 5000]) {
      await sleep(wait);
      const got = [];
      for (let i = 0; i < 3; i++) got.push(JSON.stringify(await rclick()));
      log(name, 'after+', wait, 'ms text=', JSON.stringify(await js(`document.getElementById('c').textContent`)), 'misspelledWord per click=', got.join(','));
      if (got.some((g) => g.includes('recieve'))) break;
    }
  }
  win.destroy(); srv.close(); app.quit();
})().catch((e) => { console.log('[probe] ERROR', e && e.stack || e); app.exit(3); });
