// Contrast check for the Notre Ligue homepage (docs/contrast-check.md).
// Loads /fr and /en from a local Worker (the rendered tests' harness), in
// light and dark, at 390 and 1280 px, in the headless Chromium the repo
// already has, and measures each text and tile pair below on every element
// it matches (the lowest ratio counts). Thresholds: text 4.5, icon tile
// against its card 3, glyph against its tile 3; borders and card edges are
// shown for information only.
// Exit 1 when a pair fails its threshold or matches nothing, 0 otherwise.
// Without a browser: prints "not visually verified", computes the main
// pairs from the design tokens instead, and exits 0.
//   npm run check:contrast
import { TOKENS_CSS } from '../src/design_system.js';

// [label, selector, kind, threshold]. kind: text (its color on the first
// opaque background behind it), glyph (same, for a button's or tile's own
// background), tile (its background against its parent's), info (border or
// card edge against the parent's background, never fails).
const PAIRS = [
  ['hero headline', '.home-hero h1', 'text', 4.5],
  ['hero subline', '.home-hero p:not(.home-proof)', 'text', 4.5],
  ['hero offer line', '.home-hero .home-proof', 'text', 4.5],
  ['hero button', '.home-hero .nl-btn--primary', 'glyph', 4.5],
  ['language toggle', '.nl-lang a:not([aria-current="true"])', 'text', 4.5],
  ['language toggle, current', '.nl-lang a[aria-current="true"]', 'glyph', 4.5],
  ['mockup league name', '.home-mock .card.a .ov', 'text', 4.5],
  ['mockup question', '.home-mock .card.a .q', 'text', 4.5],
  ['mockup main button', '.home-mock .card.a .btn.p', 'glyph', 4.5],
  ['mockup second button', '.home-mock .card.a .btn.s', 'text', 4.5],
  ['mockup team row', '.home-mock .card.b .row b', 'text', 4.5],
  ['mockup full count', '.home-mock .card.b .ok', 'text', 4.5],
  ['mockup short badge', '.home-mock .card.b .short', 'glyph', 4.5],
  ['mockup subs line', '.home-mock .card.b .muted', 'text', 4.5],
  ['mockup card edge', '.home-mock .card', 'info', null],
  ['how it works eyebrow', '#how-it-works .home-eyebrow, #comment-ca-marche .home-eyebrow', 'text', 4.5],
  ['how it works step title', '.home-step h3', 'text', 4.5],
  ['how it works step text', '.home-step p', 'text', 4.5],
  ['features eyebrow', '#features .home-eyebrow, #fonctionnalites .home-eyebrow', 'text', 4.5],
  ['features heading', '#features .home-sec-h, #fonctionnalites .home-sec-h', 'text', 4.5],
  ['card title (six cards)', '.home-feat h3', 'text', 4.5],
  ['card text (six cards)', '.home-feat p', 'text', 4.5],
  ['icon tile against card', '.home-ico', 'tile', 3],
  ['glyph against tile', '.home-ico', 'glyph', 3],
  ['card border', '.home-feat', 'info', null],
  ['pricing eyebrow', '#pricing .home-eyebrow', 'text', 4.5],
  ['pricing heading', '#pricing .home-sec-h', 'text', 4.5],
  ['pricing subline', '#pricing .home-sub', 'text', 4.5],
  ['tier name', '.home-tier h3', 'text', 4.5],
  ['tier range', '.home-tier .range', 'text', 4.5],
  ['tier price', '.home-tier .price', 'text', 4.5],
  ['tier link', '.home-tier .go a', 'text', 4.5],
  ['tier card border', '.home-tier', 'info', null],
  ['pricing fine print', '.home-fine', 'text', 4.5],
  ['trust text', '.home-trust-text', 'text', 4.5],
  ['trust signature', '.home-sign', 'text', 4.5],
  ['trust email link', '.home-sign a', 'text', 4.5],
  ['closing heading', '.home-final h2', 'text', 4.5],
  ['closing offer line', '.home-final .home-proof', 'text', 4.5],
  ['closing button', '.home-final .nl-btn--primary', 'glyph', 4.5],
  ['footer line', '.home-footer span', 'text', 4.5],
  ['footer link', '.home-footer a', 'text', 4.5],
  ['footer operator line', '.home-footer .home-operator', 'text', 4.5]
];

// Runs in the page: the lowest ratio over every element the selector matches.
function measure(pairs) {
  const parse = s => { const m = s && s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = el => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  return pairs.map(([label, sel, kind]) => {
    const els = [...document.querySelectorAll(sel)].filter(el => el.getClientRects().length);
    if (!els.length) return { label, ratio: null };
    const rs = els.map(el => {
      const cs = getComputedStyle(el);
      if (kind === 'text' || kind === 'glyph') return ratio(parse(cs.color), bgOf(el));
      if (kind === 'tile') return ratio(bgOf(el), bgOf(el.parentElement));
      return ratio(parse(cs.borderTopColor) || bgOf(el), bgOf(el.parentElement));
    });
    return { label, ratio: Math.round(Math.min(...rs) * 100) / 100 };
  });
}

function printTable(rows) {
  console.log('| Pair | Light | Dark | Threshold | Result |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.label} | ${r.light} | ${r.dark} | ${r.th == null ? 'info' : r.th} | ${r.result} |`);
}

// Fallback: the main pairs from the design tokens, light and dark.
function tokenPairs() {
  const read = block => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1], m[2]]));
  const [lightBlock, darkBlock] = TOKENS_CSS.split('@media (prefers-color-scheme: dark)');
  const light = read(lightBlock);
  const dark = { ...light, ...read(darkBlock) };
  const hex = h => ({ r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(hex(a)), y = lum(hex(b)); return Math.round(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
  // The homepage's tile and glyph (src/index.js): hero surface and yellow
  // in light, yellow and its ink in dark.
  const tile = { light: [light['surface-hero'], light.yellow], dark: [dark.yellow, dark['on-yellow']] };
  const P = [
    ['text on page', 'ink', 'surface', 4.5], ['muted text on page', 'ink-muted', 'surface', 4.5],
    ['text on card', 'ink', 'surface-raised', 4.5], ['muted text on card', 'ink-muted', 'surface-raised', 4.5],
    ['text on hero', 'ink-inverse', 'surface-hero', 4.5], ['yellow button text', 'on-yellow', 'yellow', 4.5],
    ['card border', 'line', 'surface', null]
  ];
  const rows = P.map(([label, fg, bg, th]) => {
    const l = ratio(light[fg], light[bg]), d = ratio(dark[fg], dark[bg]);
    return { label, light: l, dark: d, th, result: th == null ? 'info' : (Math.min(l, d) >= th ? 'pass' : 'fail') };
  });
  const tl = ratio(tile.light[0], light['surface-raised']), td = ratio(tile.dark[0], dark['surface-raised']);
  rows.push({ label: 'icon tile against card', light: tl, dark: td, th: 3, result: Math.min(tl, td) >= 3 ? 'pass' : 'fail' });
  const gl = ratio(tile.light[1], tile.light[0]), gd = ratio(tile.dark[1], tile.dark[0]);
  rows.push({ label: 'glyph against tile', light: gl, dark: gd, th: 3, result: Math.min(gl, gd) >= 3 ? 'pass' : 'fail' });
  return rows;
}

let browser = null;
let harness = null;
try {
  const h = await import('../test/rendered/support/public_page_harness.mjs');
  browser = await h.launchChromium();
  harness = await h.startPublicPageWorker();
} catch (e) {
  if (browser) await browser.close().catch(() => {});
  console.log('not visually verified: ' + String(e && e.message || e).split('\n')[0]);
  console.log('Ratios from the design tokens instead:');
  printTable(tokenPairs());
  process.exit(0);
}

const seen = {};
const fails = [];
try {
  for (const scheme of ['light', 'dark']) for (const lang of ['fr', 'en']) for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
    await page.goto(harness.baseUrl + '/' + lang);
    await page.evaluate(() => document.fonts.ready);
    const rows = await page.evaluate(measure, PAIRS);
    rows.forEach((r, i) => {
      const [label, , , th] = PAIRS[i];
      const s = seen[label] = seen[label] || { th, light: [], dark: [] };
      if (r.ratio == null) return;
      s[scheme].push(r.ratio);
      if (th != null && r.ratio < th) fails.push(`${label}: ${r.ratio} < ${th} (${scheme}, ${lang}, ${width} px)`);
    });
    await page.close();
  }
} finally {
  await browser.close();
  await harness.dispose();
}

const min = a => a.length ? Math.min(...a).toFixed(2) : 'n/a';
const rows = PAIRS.map(([label, , , th]) => {
  const s = seen[label];
  const found = s.light.length + s.dark.length > 0;
  if (!found && th != null) fails.push(`${label}: no element matches its selector`);
  const failed = fails.some(f => f.startsWith(label + ':'));
  return { label, light: min(s.light), dark: min(s.dark), th, result: !found ? 'not found' : th == null ? 'info' : failed ? 'fail' : 'pass' };
});
printTable(rows);
if (fails.length) {
  console.log('\nFailures:');
  for (const f of fails) console.log('- ' + f);
  process.exit(1);
}
console.log('\nAll pairs pass (light and dark, fr and en, 390 and 1280 px).');
