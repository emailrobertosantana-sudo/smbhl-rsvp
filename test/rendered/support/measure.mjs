// Contrast/layout measurement from a RENDERED page (public page QA
// batch). Two independent measurements, both from what Chromium
// actually painted -- never from reading CSS or token values:
//
//  - domContrast(): for an element, its computed foreground colour
//    against the background it ACTUALLY sits on, composited up the
//    real ancestor chain (so an inline style="background:..." or a
//    card's own fill counts, which is exactly what the earlier
//    token-based check missed).
//  - pixelContrast(): screenshots the element, takes the dominant
//    pixel colour as the background and the most-contrasting painted
//    pixel as the text, and returns their WCAG 2.x ratio. Anti-aliasing
//    can only make this LOWER than the true value, so passing it is a
//    conservative result.

export function wcagRatio(a, b) {
  const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Runs in the page. Returns [{ sel, text, ratio, need, fg, bg }] for
// every visible element that directly holds text.
export function domSweepInPage(rootSelector) {
  const parse = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(v => parseFloat(v)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
  function effBg(el) {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    if (!layers.length || layers[layers.length - 1].a < 1) {
      const root = parse(getComputedStyle(document.documentElement).backgroundColor);
      const body = parse(getComputedStyle(document.body).backgroundColor);
      if (root && root.a > 0) base = over(root, base); else if (body && body.a > 0) base = over(body, base);
    }
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  }
  const out = [];
  for (const el of document.querySelectorAll(rootSelector || 'body *')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName)) continue;
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (!r.width || !r.height || cs.visibility === 'hidden' || !el.getClientRects().length) continue;
    if (el.closest('.pb-view') && el.closest('.pb-view').style.display === 'none') continue;
    const bg = effBg(el); const fg0 = parse(cs.color);
    const fg = over({ ...fg0, a: fg0.a * parseFloat(cs.opacity || 1) }, bg);
    const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight, 10);
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    out.push({
      sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + cls,
      text: el.textContent.trim().slice(0, 40), ratio: Math.round(ratio(fg, bg) * 100) / 100,
      need: (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5,
      fg: cs.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`
    });
  }
  return out;
}

export async function domContrast(page, selector) {
  return page.evaluate(domSweepInPage, selector);
}

export async function pixelContrast(page, handle) {
  const box = await handle.boundingBox();
  if (!box || box.width < 2 || box.height < 2) return null;
  const png = await page.screenshot({ clip: { x: box.x, y: box.y, width: Math.min(box.width, 600), height: box.height } });
  const { bg, fg } = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data; const counts = new Map();
    for (let i = 0; i < d.length; i += 4) { const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; counts.set(k, (counts.get(k) || 0) + 1); }
    let bgK = 0, best = -1; for (const [k, n] of counts) if (n > best) { best = n; bgK = k; }
    const rgb = k => [(k >> 16) & 255, (k >> 8) & 255, k & 255];
    return { bg: rgb(bgK), fg: [...counts.keys()].map(rgb) };
  }, png.toString('base64'));
  let best = 1, bestFg = bg;
  for (const c of fg) { const r = wcagRatio(bg, c); if (r > best) { best = r; bestFg = c; } }
  return { ratio: Math.round(best * 100) / 100, bg: `rgb(${bg.join(', ')})`, fg: `rgb(${bestFg.join(', ')})` };
}

// Shows one hash-routed section (the page's own router does the work).
export async function showSection(page, id) {
  await page.evaluate(s => { location.hash = s; }, id);
  await page.waitForFunction(s => { const el = document.getElementById(s); return el && el.style.display !== 'none'; }, id);
}
