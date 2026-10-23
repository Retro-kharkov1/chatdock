#!/usr/bin/env bash
# UI-08 acceptance table, in-container driver. Mounts: /src repo (read-only), /out artifacts (writable), /cache volume.
# Copies the repo, points the COPY's package.json "main" at the test-only hook (the repo itself is untouched), installs the
# Electron version pinned in package.json (runtime only), fetches the en-US spellcheck dictionary into the cache,
# generates a throwaway self-signed TLS certificate for the stub origin, then runs the driver under Xvfb.
set -euo pipefail
WORK=/work/app
RT=/work/rt
TLS=/work/tls
mkdir -p "$WORK" "$RT" "$TLS"
tar -C /src --exclude=node_modules --exclude=./release --exclude=./artifacts --exclude=./.git -cf - . | tar -C "$WORK" --no-same-owner -xf -
node -e "const f='$WORK/package.json';const p=require(f);p.main='test/e2e/contextmenu/hookMain.js';require('fs').writeFileSync(f,JSON.stringify(p,null,2));"
EV=$(node -p "require('$WORK/package.json').devDependencies.electron")
echo "[e2e] electron $EV"
cd "$RT"
npm init -y >/dev/null
npm install --no-audit --no-fund "electron@$EV"
if [ ! -f node_modules/electron/path.txt ]; then
  echo "[e2e] electron binary missing after npm install; running its installer explicitly"
  (cd node_modules/electron && node install.js)
fi
ELECTRON_BIN=$(node -p "require('$RT/node_modules/electron')")
echo "[e2e] electron binary: $ELECTRON_BIN"
[ -x "$ELECTRON_BIN" ] || { echo "[e2e] electron binary not executable" >&2; exit 2; }

mkdir -p /cache
DICT=/cache/en-US-10-1.bdic
if [ ! -s "$DICT" ]; then
  node -e "
const fs=require('fs');
const out=process.argv[1];
const tries=[
  ['https://redirector.gvt1.com/edgedl/chrome/dict/en-us-10-1.bdic',false],
  ['https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries/+/refs/heads/main/en-US-10-1.bdic?format=TEXT',true],
];
(async()=>{
  for(const [u,b64] of tries){
    try{
      const r=await fetch(u);
      if(!r.ok) throw new Error('HTTP '+r.status);
      let b=Buffer.from(await r.arrayBuffer());
      if(b64) b=Buffer.from(b.toString('ascii'),'base64');
      if(b.length<1000||b.slice(0,4).toString('ascii')!=='BDic') throw new Error('not a bdic file');
      fs.writeFileSync(out,b);
      console.log('[e2e] dictionary fetched from '+new URL(u).host+', '+b.length+' bytes');
      return;
    }catch(e){console.log('[e2e] dictionary fetch failed from '+new URL(u).host+': '+e.message);}
  }
})();
" "$DICT" || true
fi
[ -s "$DICT" ] && echo "[e2e] dictionary cached: $(stat -c %s "$DICT") bytes" || echo "[e2e] no dictionary available: row 2 will report NOT RUN"

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TLS/key.pem" -out "$TLS/cert.pem" -days 1 -subj "/CN=stub" \
  -addext "subjectAltName=DNS:chat.google.com" 2>/dev/null
export GCD_E2E_RUN=1 GCD_ELECTRON="$ELECTRON_BIN" GCD_ELECTRON_VERSION="$EV" GCD_APP_DIR="$WORK" GCD_OUT_DIR=/out GCD_CERT_DIR="$TLS" GCD_DICT_FILE="$DICT"
set +e
xvfb-run -a -s "-screen 0 1280x800x24" node "$WORK/test/e2e/contextmenu/contextMenuAcceptance.js"
rc=$?
chmod -R a+rwX /out 2>/dev/null || true
exit $rc
