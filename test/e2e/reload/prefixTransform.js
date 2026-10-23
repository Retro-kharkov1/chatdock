'use strict';

// BUG-10 acceptance, test-only. Derives the PRE-FIX main process from the fix tree: removes the three index.js pieces the
// fix added (the require, and the createMainReload / bind / dispose block). Usage: node prefixTransform.js <index.js>.
// Exits 2 when an anchor is missing or any "mainReload" text remains (so a changed index.js cannot pass silently).
// It only acts when run with an argument (`node --test` scans every .js under test/ and requires this file).

const fs = require('fs');

function transform(src) {
  const req = /^[ \t]*const \{ createMainReload \} = require\('\.\/mainReload'\);\r?\n/m;
  const block =
    /^[ \t]*const mainReload = createMainReload\(\{[\s\S]*?\}\);\r?\n[ \t]*mainReload\.bind\(\);\r?\n[ \t]*mainWindow\.on\('closed', \(\) => mainReload\.dispose\(\)\);\r?\n/m;
  if (!req.test(src)) throw new Error('require anchor not found');
  if (!block.test(src)) throw new Error('wiring block anchor not found');
  const out = src.replace(req, '').replace(block, '');
  // comment lines that merely mention the module are descriptive; drop any line that still names it
  const kept = out
    .split('\n')
    .filter((l) => !/mainReload|main-window-reload/.test(l))
    .join('\n');
  if (/mainReload/.test(kept)) throw new Error('mainReload text remains');
  return kept;
}

module.exports = { transform };

if (require.main === module && process.argv[2]) {
  const file = process.argv[2];
  try {
    fs.writeFileSync(file, transform(fs.readFileSync(file, 'utf8')));
  } catch (err) {
    console.error('[e2e] prefix transform failed:', err.message);
    process.exit(2);
  }
}
