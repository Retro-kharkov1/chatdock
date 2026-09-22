#!/usr/bin/env node
/**
 * Regenerates every raster icon asset from the hand-authored SVG sources in
 * assets/src/. Run with: node scripts/generate-icons.js
 *
 * Requires devDependencies: sharp, png-to-ico (see assets/README.md for the
 * npm install line — they are intentionally NOT added to the app's own
 * package.json, since this script is an asset-authoring tool, not a runtime
 * dependency of the Electron app).
 *
 * Sources (single source of truth — never hand-edit a PNG or .ico directly):
 *   assets/src/master.svg        — full app/installer mark (128x128 viewBox)
 *   assets/src/mark-tray.svg     — tight-cropped, heavier-stroke tray mark
 *   assets/src/badge-unread.svg  — halo dot composited onto the tray mark
 *   assets/src/badge-muted.svg   — halo crescent composited onto the tray mark
 *
 * Outputs:
 *   assets/icons/icon.ico          multi-res Windows app/installer icon
 *   assets/icons/icon-512.png      Linux AppImage icon
 *   assets/icons/icon-<n>.png      intermediate sizes, kept for inspection/reuse
 *   assets/tray/tray-normal-<n>.png
 *   assets/tray/tray-unread-<n>.png
 *   assets/tray/tray-muted-<n>.png
 *   assets/tray/overlay-unread-<n>.png   (Windows BrowserWindow.setOverlayIcon badge)
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
// png-to-ico ships as a pure ESM package (its own package.json sets
// "type": "module"), so it is loaded via a dynamic import from this
// CommonJS script rather than require() — see
// https://nodejs.org/api/esm.html#interoperability-with-commonjs.
const pngToIcoPromise = import('png-to-ico').then((m) => m.default);

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'src');
const ICONS_OUT = path.join(ROOT, 'assets', 'icons');
const TRAY_OUT = path.join(ROOT, 'assets', 'tray');

const MUTED_GRAY = '#8A8F98';
const BRAND_GREEN = '#149960';

// electron-builder / NSIS / AppImage consume these (see docs/architecture/packaging-release.md)
const APP_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]; // Windows .ico frame set

// Tray sizes actually requested by the two in-scope platforms (electron-desktop.md §7):
// Windows system tray reads at 16/20/24/32 depending on DPI scaling; Linux tray/appindicator
// implementations commonly request 16/22/24/32/48.
const TRAY_SIZES = [16, 20, 22, 24, 32, 48];
const OVERLAY_SIZES = [16, 32]; // BrowserWindow.setOverlayIcon badge (Windows taskbar, not the tray)

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function renderSvgToPng(svgPath, size, { recolor } = {}) {
  let svg = await fs.promises.readFile(svgPath, 'utf8');
  if (recolor) {
    svg = svg.split(BRAND_GREEN.toUpperCase()).join(recolor).split(BRAND_GREEN).join(recolor);
  }
  // density scales the rasterizer's working resolution so small targets stay crisp
  // instead of downsampling from a fixed base (sharp/resvg docs: density is DPI-based,
  // https://sharp.pixelplumbing.com/api-constructor).
  const density = Math.max(96, Math.round((size / 100) * 384));
  return sharp(Buffer.from(svg), { density }).resize(size, size).png().toBuffer();
}

async function generateAppIcons() {
  const pngToIco = await pngToIcoPromise;
  await ensureDir(ICONS_OUT);
  const masterSvg = path.join(SRC, 'master.svg');
  const pngsForIco = [];

  for (const size of APP_ICON_SIZES) {
    const buf = await renderSvgToPng(masterSvg, size);
    await fs.promises.writeFile(path.join(ICONS_OUT, `icon-${size}.png`), buf);
    if (ICO_SIZES.includes(size)) pngsForIco.push(buf);
  }

  const icoBuffer = await pngToIco(pngsForIco);
  await fs.promises.writeFile(path.join(ICONS_OUT, 'icon.ico'), icoBuffer);

  // electron-builder's linux target wants a 512x512 PNG (already produced above); copy it
  // to the canonical name electron-builder looks for by convention.
  await fs.promises.copyFile(
    path.join(ICONS_OUT, 'icon-512.png'),
    path.join(ICONS_OUT, 'icon.png')
  );

  console.log(`app icons: ${APP_ICON_SIZES.join(', ')} -> assets/icons/ (+ icon.ico, icon.png)`);
}

async function compositeBadge(baseBuf, badgeSvgPath, size) {
  // Badge sits in the top-right, sized proportionally, slightly overflowing the
  // canvas the way OS badge conventions (Windows overlay, macOS dock, Android)
  // all do — this is rendered fresh per target size, not scaled down from one
  // large composite, so edges stay crisp down to 16px.
  // Small and mostly-overflowing the corner (Slack/Teams-style unread dot
  // convention) so the badge accents the mark instead of eating the ring
  // that makes it legible in the first place.
  const badgeSize = Math.max(6, Math.round(size * 0.4));
  const badgeBuf = await renderSvgToPng(badgeSvgPath, badgeSize);
  const offset = Math.round(size * 0.16);
  const left = Math.min(size - 1, size - badgeSize + offset);
  const top = -offset;
  return sharp(baseBuf)
    .resize(size, size) // no-op if already that size; keeps the pipeline explicit
    .composite([{ input: badgeBuf, left: Math.max(0, left), top: Math.max(0, top) }])
    .png()
    .toBuffer();
}

async function generateTrayIcons() {
  const pngToIco = await pngToIcoPromise;
  await ensureDir(TRAY_OUT);
  const trayMarkSvg = path.join(SRC, 'mark-tray.svg');
  const badgeUnreadSvg = path.join(SRC, 'badge-unread.svg');
  const badgeMutedSvg = path.join(SRC, 'badge-muted.svg');

  for (const size of TRAY_SIZES) {
    const normal = await renderSvgToPng(trayMarkSvg, size);
    await fs.promises.writeFile(path.join(TRAY_OUT, `tray-normal-${size}.png`), normal);

    const unread = await compositeBadge(normal, badgeUnreadSvg, size);
    await fs.promises.writeFile(path.join(TRAY_OUT, `tray-unread-${size}.png`), unread);

    // Muted state: desaturated base mark (not merely the color version dimmed —
    // rendered fresh at the target size, since flat gray anti-aliases differently
    // than green would if just filtered) plus the crescent badge for a non-color
    // signal (accessibility: don't rely on hue alone).
    const mutedBase = await renderSvgToPng(trayMarkSvg, size, { recolor: MUTED_GRAY });
    const muted = await compositeBadge(mutedBase, badgeMutedSvg, size);
    await fs.promises.writeFile(path.join(TRAY_OUT, `tray-muted-${size}.png`), muted);
  }

  for (const size of OVERLAY_SIZES) {
    const overlay = await renderSvgToPng(badgeUnreadSvg, size);
    await fs.promises.writeFile(path.join(TRAY_OUT, `overlay-unread-${size}.png`), overlay);
  }

  // Windows tray also accepts a single .ico with the common tray sizes embedded.
  const icoSizes = [16, 24, 32, 48];
  const normalPngs = await Promise.all(
    icoSizes.map((s) => fs.promises.readFile(path.join(TRAY_OUT, `tray-normal-${s}.png`)))
  );
  await fs.promises.writeFile(path.join(TRAY_OUT, 'tray-normal.ico'), await pngToIco(normalPngs));

  const unreadPngs = await Promise.all(
    icoSizes.map((s) => fs.promises.readFile(path.join(TRAY_OUT, `tray-unread-${s}.png`)))
  );
  await fs.promises.writeFile(path.join(TRAY_OUT, 'tray-unread.ico'), await pngToIco(unreadPngs));

  const mutedPngs = await Promise.all(
    icoSizes.map((s) => fs.promises.readFile(path.join(TRAY_OUT, `tray-muted-${s}.png`)))
  );
  await fs.promises.writeFile(path.join(TRAY_OUT, 'tray-muted.ico'), await pngToIco(mutedPngs));

  console.log(`tray icons: ${TRAY_SIZES.join(', ')} x {normal,unread,muted} -> assets/tray/`);
  console.log(`overlay badges: ${OVERLAY_SIZES.join(', ')} -> assets/tray/overlay-unread-*.png`);
}

(async () => {
  await generateAppIcons();
  await generateTrayIcons();
  console.log('done.');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
