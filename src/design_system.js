/**
 * design_system.js — the real "Notre Ligue" design system
 * (notre-ligue-design-system/), applied to this app for the first
 * time (overnight follow-up task). Exclusively for the NEW Notre
 * Ligue product pages built this session (marketing, signup, login,
 * forgot/reset-password, dashboard, roster, schedule, event status,
 * the player RSVP page, the public league page). SMBHL's own real
 * site and its legacy ADMIN_KEY admin pages keep using the existing
 * page() shell (src/index.js) completely unchanged -- this module is
 * never imported by anything on that path.
 *
 * TOKENS_CSS is hand-transcribed from notre-ligue-design-system/
 * tokens.json (no tokens.css file ships in the design system itself --
 * only the JSON source -- so this IS that CSS, generated once here
 * rather than at request time). BUNDLE_CSS/BUNDLE_JS are byte-for-byte
 * copies of notre-ligue-design-system/components/bundle.{css,js}.
 * Kept as plain string constants (not a build-time file import)
 * because this Worker's production bundle (Wrangler's own esbuild) and
 * its test bundle (Vite, via vitest-pool-workers) are two different
 * toolchains -- a raw-text import that works in one isn't guaranteed
 * in the other, and every existing page in this app already inlines
 * its own CSS/JS rather than serving separate static assets, so this
 * matches established convention rather than introducing a new one.
 */

// ---------- design tokens (tokens.json, transcribed) ----------
// Light is the default :root; dark follows the OS via
// prefers-color-scheme, guarded so it can never affect anything
// outside .nl-scoped pages (SMBHL's page() shell defines its own,
// completely separate set of CSS custom properties with different
// names, so there is no collision even on a page that somehow loaded
// both -- but nothing does).
export const TOKENS_CSS = `
:root{
  --font-display:"Archivo",system-ui,-apple-system,"Segoe UI",sans-serif;
  --font-sans:"Archivo",system-ui,-apple-system,"Segoe UI",sans-serif;
  --surface:#ffffff; --surface-sunken:#f4f4f2; --surface-raised:#ffffff; --surface-hero:#16181d;
  --ink:#16181d; --ink-muted:#55585f; --ink-inverse:#f4f4f2;
  --line:#e3e3e0; --line-strong:#8a8d94;
  --primary:#16181d; --primary-hover:#33363d; --on-primary:#ffffff; --primary-tint:#eeeeeb;
  --yellow:#ffd23f; --on-yellow:#16181d;
  --short-surface:#fff6d6; --short-text:#16181d;
  --league:#b3122e; --on-league:#ffffff;
  --success:#0e7a4f; --on-success:#ffffff; --success-tint:#e7faf0;
  --danger:#c4153a; --focus:#16181d;
  --shadow-sheet:0 8px 24px rgba(22,24,29,0.14);
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:24px; --space-6:32px; --space-7:48px; --space-8:64px; --space-9:96px;
  --radius-sm:3px; --radius-md:4px; --radius-lg:6px;
  --control-sm:40px; --control-md:48px; --control-lg:64px; --header-h:56px; --content-narrow:480px; --content-wide:1120px;
}
@media (prefers-color-scheme: dark) {
  :root{
    --surface:#121418; --surface-sunken:#1c1f25; --surface-raised:#1c1f25; --surface-hero:#16181d;
    --ink:#f2f2ef; --ink-muted:#a3a6ad; --ink-inverse:#f4f4f2;
    --line:#2a2e36; --line-strong:#6f737c;
    --primary:#f2f2ef; --primary-hover:#d6d6d2; --on-primary:#16181d; --primary-tint:#262a31;
    --yellow:#ffd23f; --on-yellow:#16181d;
    --short-surface:#2a2410; --short-text:#ffd23f;
    --league:#b3122e; --on-league:#ffffff;
    --success:#3dd68c; --on-success:#121418; --success-tint:#10281d;
    --danger:#ff6b85; --focus:#ffd23f;
    --shadow-sheet:0 8px 24px rgba(0,0,0,0.5);
  }
}
`;

// ---------- component bundle (components/bundle.css, verbatim) ----------
export const BUNDLE_CSS = `
.nl, .nl * { box-sizing: border-box; }
.nl { font-family: var(--font-sans); font-size: 16px; line-height: 24px; color: var(--ink); background: var(--surface); -webkit-font-smoothing: antialiased; }
.nl h1, .nl h2, .nl h3, .nl .nl-display, .display-xl, .display-lg, .h1, .h2, .h3, .stat { font-family: var(--font-display); font-stretch: 118%; }
.nl h1, .nl h2, .nl h3 { margin: 0; color: var(--ink); }
.nl p { margin: 0; }
.nl a { color: var(--ink); text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 3px; }
.nl :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.nl .tnum, .stat { font-variant-numeric: tabular-nums; }
.nl .muted { color: var(--ink-muted); }
.nl .overline { font-family: var(--font-sans); font-size: 12px; line-height: 16px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-muted); }
.display-xl { font-size:52px; line-height:54px; font-weight:800; letter-spacing:-0.01em; }
.display-lg { font-size:34px; line-height:36px; font-weight:800; letter-spacing:-0.01em; }
.h1 { font-size:28px; line-height:32px; font-weight:800; letter-spacing:-0.01em; }
.h2 { font-size:22px; line-height:26px; font-weight:700; }
.h3 { font-size:18px; line-height:22px; font-weight:700; }
.stat { font-size:40px; line-height:40px; font-weight:800; }
.body-lg { font-size:18px; line-height:28px; font-weight:400; }
.small { font-size:14px; line-height:20px; font-weight:400; color: var(--ink-muted); }
.caption { font-size:13px; line-height:18px; font-weight:500; color: var(--ink-muted); }
@media (min-width: 1024px) { .display-xl { font-size:52px; line-height:54px; } .h1 { font-size:32px; line-height:36px; } }
@media (max-width: 480px) { .display-lg { font-size:32px; line-height:35px; } }

.nl-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2); height: var(--control-md); padding: 0 var(--space-5); border: 1.5px solid transparent; border-radius: var(--radius-md); font: 700 16px/20px var(--font-sans); cursor: pointer; text-decoration: none !important; white-space: nowrap; transition: background-color .12s, border-color .12s; }
.nl-btn svg { width: 20px; height: 20px; flex: none; }
.nl-btn--primary { background: var(--primary); color: var(--on-primary) !important; }
.nl-btn--primary:hover { background: var(--primary-hover); }
.nl-btn--accent { background: var(--yellow); color: var(--on-yellow) !important; }
.nl-btn--league { background: var(--league); color: var(--on-league) !important; }
.nl-btn--secondary { background: transparent; color: var(--ink) !important; border-color: var(--line-strong); }
.nl-btn--secondary:hover { background: var(--surface-sunken); }
.nl-btn--ghost { background: transparent; color: var(--ink) !important; padding: 0 var(--space-3); text-decoration: underline !important; text-underline-offset: 3px; }
.nl-btn--ghost:hover { background: var(--primary-tint); }
.nl-btn--danger { background: transparent; color: var(--danger) !important; border-color: var(--danger); }
.nl-btn--sm { height: var(--control-sm); padding: 0 var(--space-4); font-size: 14px; }
.nl-btn--lg { height: var(--control-lg); font-size: 18px; padding: 0 var(--space-6); }
.nl-btn--block { display: flex; width: 100%; }
.nl-btn[disabled] { opacity: .45; cursor: not-allowed; }
.nl-hero .nl-btn--secondary { color: var(--ink-inverse) !important; border-color: #6f737c; }

.nl-field { display: flex; flex-direction: column; gap: var(--space-2); }
.nl-label { font: 600 14px/20px var(--font-sans); color: var(--ink); }
.nl-help { font-size: 14px; line-height: 20px; color: var(--ink-muted); }
.nl-input, .nl-select { height: var(--control-md); width: 100%; padding: 0 var(--space-3); border: 1.5px solid var(--line-strong); border-radius: var(--radius-md); background: var(--surface); color: var(--ink); font: 400 16px/24px var(--font-sans); }
.nl-input:focus, .nl-select:focus { outline: 2px solid var(--focus); outline-offset: 1px; border-color: var(--ink); }
.nl-input--error { border-color: var(--danger); }
.nl-error { display: flex; gap: var(--space-1); align-items: center; font-size: 14px; line-height: 20px; color: var(--danger); font-weight: 600; }
.nl-error svg { width: 16px; height: 16px; flex: none; }
.nl-prefix { display: flex; align-items: stretch; border: 1.5px solid var(--line-strong); border-radius: var(--radius-md); overflow: hidden; background: var(--surface); }
.nl-prefix span { display: flex; align-items: center; padding: 0 var(--space-3); background: var(--surface-sunken); color: var(--ink-muted); font-size: 16px; border-right: 1.5px solid var(--line-strong); white-space: nowrap; }
.nl-prefix .nl-input { border: 0; border-radius: 0; }

.nl-toggle { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); min-height: var(--control-md); }
.nl-switch { position: relative; width: 48px; height: 28px; flex: none; border-radius: var(--radius-sm); background: var(--line-strong); border: 0; cursor: pointer; }
.nl-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 2px; background: #ffffff; transition: left .15s; }
.nl-switch[aria-checked="true"] { background: var(--primary); }
.nl-switch[aria-checked="true"]::after { left: 23px; background: var(--yellow); }

.nl-card { background: var(--surface-raised); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: var(--space-4); }
.nl-card--pad-lg { padding: var(--space-5); }
.nl-card--short { background: var(--short-surface); border-color: var(--yellow); }
.nl-card--short, .nl-card--short h3 { color: var(--short-text); }
.nl-card--selected { border: 2px solid var(--primary); background: var(--primary-tint); }

.nl-badge { display: inline-flex; align-items: center; gap: var(--space-1); height: 24px; padding: 0 var(--space-2); border-radius: var(--radius-sm); font: 700 13px/18px var(--font-sans); white-space: nowrap; }
.nl-badge svg { width: 14px; height: 14px; }
.nl-badge--in { background: var(--success); color: var(--on-success); }
.nl-badge--out { background: var(--surface-sunken); color: var(--ink-muted); border: 1px solid var(--line); }
.nl-badge--pending { background: transparent; color: var(--ink-muted); border: 1px dashed var(--line-strong); }
.nl-badge--short { background: var(--yellow); color: var(--on-yellow); }
.nl-badge--sub { background: var(--primary-tint); color: var(--ink); }
.nl-badge--new { background: var(--primary); color: var(--on-primary); }

.nl-header { display: flex; align-items: center; gap: var(--space-4); height: var(--header-h); padding: 0 var(--space-4); border-bottom: 1px solid var(--line); background: var(--surface); }
.nl-brand { font: 700 16px/20px var(--font-display); font-stretch: 118%; color: var(--ink); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; display: block; }
.nl-brand--product { font-weight: 800; letter-spacing: .01em; text-transform: uppercase; display: flex; align-items: center; gap: var(--space-2); }
.nl-brand--product i { width: 10px; height: 10px; background: var(--yellow); flex: none; border-radius: 1px; }
.nl-brand--league { border-left: 4px solid var(--league); padding-left: var(--space-2); }
.nl-hero .nl-brand { color: var(--ink-inverse); }
.nl-header .spacer { flex: 1; }
.nl-nav { display: flex; gap: var(--space-1); }
.nl-nav a { display: flex; align-items: center; height: 40px; padding: 0 var(--space-3); border-radius: var(--radius-md); color: var(--ink-muted); font: 600 14px/20px var(--font-sans); text-decoration: none; }
.nl-nav a[aria-current="page"] { color: var(--ink); background: var(--primary-tint); box-shadow: inset 0 -3px 0 var(--yellow); }
.nl-lang { display: inline-flex; padding: 2px; border: 1.5px solid var(--line-strong); border-radius: var(--radius-md); background: var(--surface); }
.nl-lang button { height: 32px; min-width: 40px; padding: 0 var(--space-2); border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--ink-muted); font: 700 13px/1 var(--font-sans); letter-spacing: .04em; cursor: pointer; }
.nl-lang button[aria-pressed="true"] { background: var(--ink); color: var(--surface); }
.nl-hero .nl-lang { background: transparent; border-color: #6f737c; }
.nl-hero .nl-lang button { color: #a3a6ad; }
.nl-hero .nl-lang button[aria-pressed="true"] { background: var(--ink-inverse); color: #16181d; }

.nl-steps { display: flex; gap: var(--space-2); }
.nl-steps i { flex: 1; height: 4px; border-radius: 1px; background: var(--line); }
.nl-steps i.done { background: var(--primary); }
.nl-steps i.on { background: var(--yellow); }

.nl-meter { display: flex; gap: 3px; }
.nl-meter i { flex: 1; height: 10px; border-radius: 1px; background: var(--line); }
.nl-meter i.in { background: var(--success); }
.nl-meter i.open { background: transparent; border: 1.5px dashed var(--line-strong); }
.nl-card--short .nl-meter i.open { border-color: var(--short-text); }

.nl-list { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--radius-lg); overflow: hidden; background: var(--surface-raised); }
.nl-row { display: flex; align-items: center; gap: var(--space-3); min-height: 56px; padding: var(--space-2) var(--space-4); border-top: 1px solid var(--line); }
.nl-row:first-child { border-top: 0; }
.nl-row .grow { flex: 1; min-width: 0; }
.nl-dot { width: 12px; height: 12px; border-radius: 1px; flex: none; }

.nl-page { max-width: var(--content-wide); margin: 0 auto; padding: var(--space-6); }
.nl-page--narrow { max-width: var(--content-narrow); }
.nl-phone { width: 375px; min-height: 740px; border: 1px solid var(--line); border-radius: 18px; overflow: hidden; background: var(--surface); flex: none; }
.nl-hero { background: var(--surface-hero); color: var(--ink-inverse); }
.nl-hero h1, .nl-hero h2, .nl-hero h3 { color: var(--ink-inverse); }

/* Bottom tab bar (admin, phone -- guidelines/10-screens.md) */
.nl-tabbar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; height: 60px; background: var(--surface); border-top: 1px solid var(--line); z-index: 20; }
.nl-tabbar a { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; color: var(--ink-muted); text-decoration: none; font: 600 12px/16px var(--font-sans); }
.nl-tabbar a svg { width: 22px; height: 22px; }
.nl-tabbar a[aria-current="page"] { color: var(--ink); }
`;

// ---------- component bundle (components/bundle.js, verbatim) ----------
export const BUNDLE_JS = `
(function () {
  "use strict";
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var ICONS = {
    check: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M4 10.5l4 4 8-9"/></svg>',
    alert: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M10 3l8 14H2z"/><path d="M10 8v4M10 14.5v.5"/></svg>',
    minus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M5 10h10"/></svg>',
    clock: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/></svg>',
    plus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>',
    arrow: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5"/></svg>'
  };
  function slugify(s) {
    return String(s || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  }
  function Button(o) {
    o = o || {};
    var b = el(o.href ? "a" : "button", "nl-btn nl-btn--" + (o.variant || "primary") + (o.size ? " nl-btn--" + o.size : "") + (o.block ? " nl-btn--block" : ""));
    if (o.href) b.href = o.href; else b.type = o.type || "button";
    if (o.icon && ICONS[o.icon]) b.innerHTML = ICONS[o.icon];
    b.appendChild(document.createTextNode(o.label || ""));
    if (o.onClick) b.addEventListener("click", o.onClick);
    return b;
  }
  function Field(o) {
    o = o || {};
    var id = o.id || "f-" + Math.random().toString(36).slice(2, 8);
    var w = el("div", "nl-field");
    var l = el("label", "nl-label", o.label); l.htmlFor = id; w.appendChild(l);
    var input = el(o.options ? "select" : "input", o.options ? "nl-select" : "nl-input" + (o.error ? " nl-input--error" : ""));
    input.id = id;
    if (o.options) o.options.forEach(function (t) { input.appendChild(el("option", null, t)); });
    else { input.type = o.type || "text"; if (o.value) input.value = o.value; if (o.placeholder) input.placeholder = o.placeholder; }
    if (o.prefix) { var p = el("div", "nl-prefix"); p.appendChild(el("span", null, o.prefix)); p.appendChild(input); w.appendChild(p); }
    else w.appendChild(input);
    if (o.error) { var e = el("p", "nl-error"); e.innerHTML = ICONS.alert; e.appendChild(document.createTextNode(o.error)); w.appendChild(e); input.setAttribute("aria-invalid", "true"); }
    else if (o.help) w.appendChild(el("p", "nl-help", o.help));
    return w;
  }
  function Card(o) {
    o = o || {};
    var c = el("section", "nl-card" + (o.tone ? " nl-card--" + o.tone : ""));
    if (o.title) c.appendChild(el("h3", "h3", o.title));
    if (o.children) o.children.forEach(function (k) { c.appendChild(k); });
    return c;
  }
  var BADGE_ICON = { in: "check", out: "minus", pending: "clock", short: "alert" };
  function Badge(o) {
    o = o || {};
    var b = el("span", "nl-badge nl-badge--" + (o.tone || "pending"));
    var ic = BADGE_ICON[o.tone];
    if (ic) b.innerHTML = ICONS[ic];
    b.appendChild(document.createTextNode(o.label || ""));
    return b;
  }
  function LangToggle(o) {
    o = o || {};
    var w = el("div", "nl-lang"); w.setAttribute("role", "group"); w.setAttribute("aria-label", "Langue / Language");
    ["FR", "EN"].forEach(function (code) {
      var b = el("button", null, code); b.type = "button"; b.lang = code.toLowerCase();
      b.setAttribute("aria-pressed", String((o.lang || "fr") === code.toLowerCase()));
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(w.children, function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        if (o.onChange) o.onChange(code.toLowerCase());
      });
      w.appendChild(b);
    });
    return w;
  }
  function AppHeader(o) {
    o = o || {};
    var h = el("header", "nl-header");
    var product = !o.title;
    var brand = el("a", "nl-brand" + (product ? " nl-brand--product" : o.playerFacing ? " nl-brand--league" : "")); brand.href = o.homeHref || "#";
    if (product) brand.appendChild(el("i"));
    brand.appendChild(document.createTextNode(o.title || "Notre Ligue"));
    h.appendChild(brand);
    if (o.nav) {
      var n = el("nav", "nl-nav");
      o.nav.forEach(function (it) { var a = el("a", null, it.label); a.href = it.href || "#"; if (it.current) a.setAttribute("aria-current", "page"); n.appendChild(a); });
      h.appendChild(n);
    }
    h.appendChild(el("div", "spacer"));
    h.appendChild(LangToggle({ lang: o.lang, onChange: o.onLangChange }));
    return h;
  }
  function Stepper(o) {
    o = o || {};
    var w = el("div", "nl-steps"); w.setAttribute("role", "progressbar");
    w.setAttribute("aria-valuemin", "1"); w.setAttribute("aria-valuemax", String(o.total || 3)); w.setAttribute("aria-valuenow", String(o.current || 1));
    for (var i = 1; i <= (o.total || 3); i++) w.appendChild(el("i", i < o.current ? "done" : i === o.current ? "on" : ""));
    return w;
  }
  function SpotMeter(o) {
    o = o || {};
    var w = el("div", "nl-meter"); w.setAttribute("role", "img");
    w.setAttribute("aria-label", (o.confirmed || 0) + " / " + (o.spots || 10));
    for (var i = 0; i < (o.spots || 10); i++) w.appendChild(el("i", i < (o.confirmed || 0) ? "in" : "open"));
    return w;
  }
  window.NotreLigue = { Button: Button, Field: Field, Card: Card, Badge: Badge, AppHeader: AppHeader, LangToggle: LangToggle, Stepper: Stepper, SpotMeter: SpotMeter, slugify: slugify, icons: ICONS };
})();
`;

// ---------- league color contrast (README: "darkened automatically
// until white text on it reaches 4.5:1; the original value is still
// used for small dots") ----------
// Uses real WCAG relative-luminance contrast math (precise). The
// darkening STEP itself uses HSL lightness reduction rather than a
// true OKLCH conversion (the spec's literal wording) -- a documented,
// deliberate simplification: OKLCH parsing/conversion has no built-in
// Workers API and no dependency is already in this project for it,
// while HSL darkening reaches the same goal (step down lightness until
// the contrast target passes) with a small, dependency-free function.
// The visible outcome -- a safely-darkened league color -- is the same;
// only the exact intermediate hues on the way there could differ
// slightly from a true OKLCH implementation.
function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
  if (!m) return { r: 0x16, g: 0x18, b: 0x1d };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
function rgbToHex(r, g, b) {
  const h = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}
function relLuminance({ r, g, b }) {
  const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [R, G, B] = [f(r), f(g), f(b)];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}
function contrastRatio(hex1, hex2) {
  const L1 = relLuminance(hexToRgb(hex1));
  const L2 = relLuminance(hexToRgb(hex2));
  const [lighter, darker] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (lighter + 0.05) / (darker + 0.05);
}
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h, s, l };
}
function hslToRgb({ h, s, l }) {
  if (s === 0) { const v = l * 255; return { r: v, g: v, b: v }; }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue2rgb(p, q, h + 1 / 3) * 255, g: hue2rgb(p, q, h) * 255, b: hue2rgb(p, q, h - 1 / 3) * 255 };
}

// Returns the league color to actually FILL a surface with (header bar,
// main button) -- darkened in steps until white text on it reaches
// 4.5:1, or already-black if the original never will. The original,
// un-darkened hex is what callers should use for small dots (nl-dot),
// per the design system's own rule.
export function leagueFillColor(originalHex) {
  let hex = hexToRgb(originalHex);
  let hexStr = rgbToHex(hex.r, hex.g, hex.b);
  if (contrastRatio(hexStr, '#ffffff') >= 4.5) return hexStr;
  const hsl = rgbToHsl(hex);
  for (let step = 1; step <= 20; step++) {
    const darker = { h: hsl.h, s: hsl.s, l: Math.max(0, hsl.l - step * 0.04) };
    const rgb = hslToRgb(darker);
    hexStr = rgbToHex(rgb.r, rgb.g, rgb.b);
    if (contrastRatio(hexStr, '#ffffff') >= 4.5) return hexStr;
  }
  return '#16181d'; // fell through every step -- fall back to ink, never ship a failing contrast
}

/* ---------- transactional emails (design system Part 5) ----------
 * A small, self-contained implementation of guidelines/30-emails.md's
 * build rules: 560px content table, role="presentation", inline
 * styles only, no flexbox/grid/background-images, Archivo/Arial/
 * Helvetica with font-stretch:118% on the headline, a 6px color bar +
 * white header row (the color appears twice only: the bar and the
 * button), one bulletproof button, language-switch link in the
 * footer. Deliberately separate from this app's existing shared
 * emailWrap()/body() (src/index.js) -- that system is used identically
 * by SMBHL's own real, live transactional emails (the weekly game
 * invite, the sub-call, etc.), so redesigning it would restyle
 * SMBHL's actual production email output, which this task's own scope
 * explicitly forbids. This helper is used ONLY by email templates
 * that are exclusively part of the new account/league system
 * (verification, password reset, co-admin invite) and never touched
 * by any SMBHL code path.
 */
function nlEmailEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Live-testing task, Part 8: this used to be `padding:16px 0` --
// vertical padding only, no horizontal inset at all, so the label text
// sat flush against the button's left/right edges in real inbox
// testing. 16px 24px matches the app's own .nl-btn horizontal padding
// (--space-5, design_system.js's own CSS variable block) for visual
// consistency between the email and the in-app buttons it's meant to
// echo.
export function nlEmailButton(url, label, color = '#16181d') {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
  <td style="background:${nlEmailEsc(color)};border-radius:4px;text-align:center;"><a href="${nlEmailEsc(url)}" style="display:block;padding:16px 24px;font:700 17px/20px Archivo,Arial,Helvetica,sans-serif;color:#ffffff;text-decoration:none;">${nlEmailEsc(label)}</a></td>
</tr></table>`;
}

// footerHtml gets the language-switch link inlined by the caller
// (each template's own two languages know their own toggle URL/label);
// this just provides the shared structural wrapper.
export function nlEmailWrap({ brandName, barColor = '#16181d', bodyHtml, footerHtml }) {
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 0;background:#f4f4f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;background:#ffffff;border-radius:6px;border:1px solid #e3e3e0;font-family:Archivo,Arial,Helvetica,sans-serif;color:#16181d;">
  <tr><td style="background:${nlEmailEsc(barColor)};height:6px;line-height:6px;font-size:0;border-radius:6px 6px 0 0;">&nbsp;</td></tr>
  <tr><td style="padding:18px 28px;border-bottom:1px solid #e3e3e0;">
    <span style="font:800 18px/24px Archivo,Arial,Helvetica,sans-serif;font-stretch:118%;color:#16181d;">${nlEmailEsc(brandName)}</span>
  </td></tr>
  <tr><td style="padding:32px 28px 8px;">
    ${bodyHtml}
  </td></tr>
  <tr><td style="padding:16px 28px 28px;font-size:12px;line-height:18px;color:#55585f;">
    ${footerHtml}
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

/* ---------- document shell ----------
 * The real design-system page shell -- fonts, design tokens,
 * bundle.css component styles, and bundle.js's vanilla DOM helpers
 * (window.NotreLigue), all inlined (matching this app's own
 * established convention of inlining every page's CSS/JS rather than
 * serving separate static assets). A SEPARATE shell from SMBHL's own
 * page() (src/index.js) -- SMBHL's real site and its legacy ADMIN_KEY
 * admin pages keep using page() completely unchanged; nlDocument is
 * used only by the new Notre Ligue product pages/emails built this
 * session. Lives here (not in index.js, where every call site is)
 * specifically so auth.js can also import it directly -- auth.js
 * never imports from index.js (index.js imports auth.js, so the
 * reverse would be circular), but both already import this module.
 *
 * leagueColor: player-facing pages (RSVP, public page) pass the
 * league's own contrast-safe fill color (leagueFillColor()) here to
 * override the --league/--on-league tokens for that one response --
 * the "league's own color" rule (guidelines/20-public-site-themes.md)
 * applies ONLY when this is set; every Notre-Ligue-branded page
 * (marketing, signup, admin) leaves it unset and keeps the shared
 * sample --league token, which is never shown to a real player. A
 * second :root block, appended after TOKENS_CSS in the same <style>,
 * wins the cascade (same specificity, later rule).
 */
export function nlDocument({ title, description = '', bodyHtml, lang = 'fr', leagueColor = null }) {
  return `<!DOCTYPE html><html lang="${lang === 'en' ? 'en-CA' : 'fr-CA'}"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${nlEmailEsc(title)}</title>
${description ? `<meta name="description" content="${nlEmailEsc(description)}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&display=swap" rel="stylesheet">
<style>${TOKENS_CSS}${BUNDLE_CSS}${leagueColor ? `:root{--league:${nlEmailEsc(leagueColor)};--on-league:#ffffff}` : ''}</style>
</head><body class="nl">
${bodyHtml}
<script>${BUNDLE_JS}</script>
</body></html>`;
}
