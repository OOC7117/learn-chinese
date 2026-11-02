#!/usr/bin/env node
// The brand mark: app/icons/icon.svg (a vermilion rounded square with 中 drawn as shapes, so it needs no
// font) and its PNG renders for the web app manifest and iOS, made with Playwright's Chromium:
//   icon-192.png, icon-512.png    purpose "any" (full square; launchers that round corners do so themselves)
//   icon-maskable-512.png         purpose "maskable": the mark inside the 80% safe-zone circle
//   apple-touch-icon.png          180 x 180, opaque (iOS fills transparency with black and rounds the corners)
// Run (CommonJS because Playwright is installed globally):  NODE_PATH=$(npm root -g) node scripts/build-icons.cjs
// then `node scripts/build-sw.mjs` (the icons are part of the precached app shell).
'use strict';

const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const ICONS = join(__dirname, '..', 'app', 'icons');
const VERMILION = '#a8231b'; // --accent-fill (light) in app/styles.css
const WHITE = '#ffffff';

// 中 on a 512 grid, as two filled paths: the box (口, an outline with a hole) and the long vertical stroke.
// The box sits a little above the middle of the vertical stroke, as in the written character.
const BOX = 'M120 146H392V338H120Z M166 192V292H346V192Z';
const STROKE = 'M233 84H279V428H233Z';

/** The mark as SVG. radius: corner radius of the square (0 = full bleed); scale: size of the character. */
function markSvg({ radius = 0, scale = 1, title = true } = {}) {
  const transform = scale === 1 ? '' : ` transform="translate(256 256) scale(${scale}) translate(-256 -256)"`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">',
    title ? '  <title>Learn Chinese</title>' : null,
    `  <rect width="512" height="512"${radius ? ` rx="${radius}"` : ''} fill="${VERMILION}"/>`,
    `  <g fill="${WHITE}"${transform}>`,
    `    <path fill-rule="evenodd" d="${BOX}"/>`,
    `    <path d="${STROKE}"/>`,
    '  </g>',
    '</svg>',
    '',
  ].filter((line) => line !== null).join('\n');
}

const RENDERS = [
  { file: 'icon-192.png', size: 192, svg: markSvg({ scale: 0.92, title: false }) },
  { file: 'icon-512.png', size: 512, svg: markSvg({ scale: 0.92, title: false }) },
  // Safe zone: the circle of radius 40% (205 of 512) around the centre. The character's farthest points
  // (the ends of the vertical stroke) are sqrt(23^2 + 172^2) = 174 units away at scale 1, 141 at 0.81.
  { file: 'icon-maskable-512.png', size: 512, svg: markSvg({ scale: 0.81, title: false }) },
  { file: 'apple-touch-icon.png', size: 180, svg: markSvg({ scale: 0.86, title: false }) },
];

async function main() {
  const { chromium } = require('playwright');
  mkdirSync(ICONS, { recursive: true });
  writeFileSync(join(ICONS, 'icon.svg'), markSvg({ radius: 112 }));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const { file, size, svg } of RENDERS) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:${VERMILION}}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`);
      await page.screenshot({ path: join(ICONS, file), omitBackground: false, clip: { x: 0, y: 0, width: size, height: size } });
      console.log(`app/icons/${file} ${size}x${size}`);
    }
  } finally {
    await browser.close();
  }
  console.log('app/icons/icon.svg');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { markSvg, VERMILION };
