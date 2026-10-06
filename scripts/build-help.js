'use strict';

// UI-06: docs/user-guide.md -> src/renderer/help/help.html (the page the Help window loads).
//
//   node scripts/build-help.js          write the file
//   node scripts/build-help.js --check  exit 1 if the checked-in file is out of date
//
// scripts/build.js runs this before packaging, so an installer always carries a current guide; the
// generated file is also checked in (and test/helpBuild.test.js fails when it drifts).

const fs = require('fs');
const path = require('path');
const { renderGuideHtml } = require('./lib/helpGuide.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const GUIDE_PATH = path.join(REPO_ROOT, 'docs', 'user-guide.md');
const OUTPUT_PATH = path.join(REPO_ROOT, 'src', 'renderer', 'help', 'help.html');

function generateHelp({ write = true } = {}) {
  const html = renderGuideHtml(fs.readFileSync(GUIDE_PATH, 'utf8'));
  if (write) {
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, html, 'utf8');
  }
  return html;
}

module.exports = { generateHelp, GUIDE_PATH, OUTPUT_PATH };

if (require.main === module) {
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : '';
    if (current !== generateHelp({ write: false })) {
      console.error('[build-help] src/renderer/help/help.html is out of date: run `npm run build-help`.');
      process.exit(1);
    }
    console.log('[build-help] help.html is up to date.');
  } else {
    generateHelp();
    console.log(`[build-help] wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)}`);
  }
}
