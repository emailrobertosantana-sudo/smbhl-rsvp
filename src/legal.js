// Notre Ligue's legal pages: /confidentialite (privacy policy) and
// /conditions (terms of service), French then English on one page, from
// legal/privacy.md and legal/terms.md (src/legal_text.js, built by
// scripts/build_legal.mjs). /privacy and /terms redirect to them. Served
// on the Notre Ligue host only (LEAGUE_PRODUCT); SMBHL's host has none.
//
// Also the links to them: the footer of Notre Ligue emails
// (nlLegalEmailWrap) and of its pages (legalLinks).
import { nlDocument, nlEmailWrap } from './design_system.js';
import { LEGAL_TEXT } from './legal_text.js';

// Each text's publication date, shown as "last updated" on its page. The
// privacy policy changed on 2026-10-02 (support access, section 5), then
// the terms the same day (section 8, the launch-day trial sentence gone).
export const LEGAL_UPDATED_BY_KIND = { privacy: '2026-10-02', terms: '2026-10-02' };
// The latest of them.
export const LEGAL_UPDATED = Object.values(LEGAL_UPDATED_BY_KIND).sort().slice(-1)[0];
// The version an account's acceptance records (src/terms.js). Change it
// with every change to either text: each account whose acceptance is of
// another version is asked once to accept the new one. Two publications
// on 2026-10-02, hence the ".2".
export const LEGAL_VERSION = '2026-10-02.2';

export const LEGAL_PATHS = { privacy: '/confidentialite', terms: '/conditions' };
export const LEGAL_REDIRECTS = { '/privacy': '/confidentialite', '/terms': '/conditions' };
const LEGAL_BASE = 'https://notreligue.ca';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MONTHS = {
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
};
// « 1er octobre 2026 » / "October 1, 2026"
export function legalDate(iso, lang) {
  const [y, m, d] = iso.split('-').map(Number);
  return lang === 'en' ? `${MONTHS.en[m - 1]} ${d}, ${y}` : `${d === 1 ? '1er' : d} ${MONTHS.fr[m - 1]} ${y}`;
}

const LABELS = {
  fr: { privacy: 'Confidentialité', terms: 'Conditions', updated: 'Dernière mise à jour', jump: 'English version', back: 'Version française' },
  en: { privacy: 'Privacy', terms: 'Terms', updated: 'Last updated', jump: 'English version', back: 'Version française' }
};

// The links, for an email footer: in the email's language mode ('fr',
// 'en' or 'both').
export function legalLinksEmailHtml(languageMode) {
  const a = (path, label) => `<a href="${LEGAL_BASE}${path}" style="color:#55585f;text-decoration:underline;">${label}</a>`;
  if (languageMode === 'fr') return `${a(LEGAL_PATHS.privacy, 'Confidentialité')} · ${a(LEGAL_PATHS.terms, 'Conditions')}`;
  if (languageMode === 'en') return `${a(LEGAL_PATHS.privacy + '#en', 'Privacy')} · ${a(LEGAL_PATHS.terms + '#en', 'Terms')}`;
  return `${a(LEGAL_PATHS.privacy, 'Confidentialité / Privacy')} · ${a(LEGAL_PATHS.terms, 'Conditions / Terms')}`;
}

// nlEmailWrap with the legal links on their own line under the footer.
export function nlLegalEmailWrap({ languageMode = 'both', footerHtml = '', ...rest }) {
  return nlEmailWrap({ ...rest, footerHtml: `${footerHtml}<br>${legalLinksEmailHtml(languageMode)}` });
}

// The links, for a page footer, with data-i18n keys legalPrivacy and
// legalTerms so a page's language switch relabels them. cls: the page's
// own footer link class, so the links take its colors.
export function legalLinksPageHtml(lang = 'fr', cls = '') {
  const L = LABELS[lang === 'en' ? 'en' : 'fr'];
  const c = cls ? ` class="${esc(cls)}"` : '';
  return `<a${c} href="${LEGAL_PATHS.privacy}" data-i18n="legalPrivacy">${L.privacy}</a> · <a${c} href="${LEGAL_PATHS.terms}" data-i18n="legalTerms">${L.terms}</a>`;
}
export const LEGAL_I18N = { fr: { legalPrivacy: 'Confidentialité', legalTerms: 'Conditions' }, en: { legalPrivacy: 'Privacy', legalTerms: 'Terms' } };

// ---- the markdown the two texts use: ### headings, paragraphs, "- "
// lists, | tables |, **bold**; email addresses become mailto links ----
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '<a href="mailto:$1">$1</a>');
}
export function legalMarkdownToHtml(md) {
  const blocks = md.split(/\n{2,}/);
  return blocks.map(block => {
    const lines = block.split('\n');
    const h = block.match(/^(#{2,4}) (.+)$/);
    if (h && lines.length === 1) return `<h3>${inline(h[2])}</h3>`;
    if (lines.every(l => l.startsWith('- '))) return `<ul>${lines.map(l => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`;
    if (lines.every(l => l.startsWith('|'))) {
      const cells = l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const [head, , ...body] = lines;
      return `<div class="lg-table"><table><thead><tr>${cells(head).map(c => `<th scope="col">${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    return `<p>${inline(lines.join(' '))}</p>`;
  }).join('\n');
}

const STYLE = `<style>
  .lg-head { padding: var(--space-4) var(--space-4) 0; max-width: 760px; margin: 0 auto; }
  .lg-head a { font-weight: 800; text-decoration: none; color: var(--ink, #16181d); }
  .lg-main { max-width: 760px; margin: 0 auto; padding: var(--space-4) var(--space-4) var(--space-6, 48px); line-height: 1.6; }
  .lg-main h1 { margin: var(--space-3) 0 var(--space-2); }
  .lg-main h2 { margin: var(--space-6, 48px) 0 var(--space-2); padding-top: var(--space-4); border-top: 1px solid var(--line, #e3e3e0); }
  .lg-main h3 { margin: var(--space-5, 32px) 0 var(--space-2); font-size: 18px; }
  .lg-main ul { padding-left: 22px; }
  .lg-meta { color: var(--ink-muted, #55585f); font-size: 14px; display: flex; gap: var(--space-3); flex-wrap: wrap; }
  .lg-table { overflow-x: auto; margin: var(--space-3) 0; }
  .lg-table table { border-collapse: collapse; width: 100%; font-size: 15px; }
  .lg-table th, .lg-table td { border: 1px solid var(--line, #e3e3e0); padding: 8px 10px; text-align: left; vertical-align: top; }
  .lg-foot { max-width: 760px; margin: 0 auto; padding: var(--space-4); font-size: 13px; color: var(--ink-muted, #55585f); text-align: center; }
</style>`;

// The page: French, then English, a link at the top to the English part.
export function renderLegalPage(kind) {
  const t = LEGAL_TEXT[kind];
  const [frTitle, enTitle] = t.title.split(' / ');
  const enFull = `Notre Ligue: ${enTitle}`;
  const L = LABELS;
  const body = `${STYLE}
<header class="lg-head"><a href="/">Notre Ligue</a></header>
<main class="lg-main">
  <h1>${esc(frTitle)}</h1>
  <p class="lg-meta"><span>${L.fr.updated} : ${legalDate(LEGAL_UPDATED_BY_KIND[kind] || LEGAL_UPDATED, 'fr')}</span><a href="#en" lang="en-CA">${L.fr.jump}</a></p>
  ${legalMarkdownToHtml(t.fr)}
  <section id="en" lang="en-CA">
    <h2>${esc(enFull)}</h2>
    <p class="lg-meta"><span>${L.en.updated}: ${legalDate(LEGAL_UPDATED_BY_KIND[kind] || LEGAL_UPDATED, 'en')}</span><a href="#top" lang="fr-CA">${L.en.back}</a></p>
    ${legalMarkdownToHtml(t.en)}
  </section>
</main>
<footer class="lg-foot">Notre Ligue · ${legalLinksPageHtml('fr')} · <a href="mailto:bonjour@notreligue.ca">bonjour@notreligue.ca</a></footer>`;
  return nlDocument({ title: `${frTitle} | ${enFull}`, description: frTitle, bodyHtml: `<div id="top"></div>${body}`, lang: 'fr' });
}

// GET /confidentialite, /conditions (200) and /privacy, /terms (301), on
// the Notre Ligue host. null for any other path, or on SMBHL's host.
export function legalRoute(env, url) {
  if (env.LEAGUE_PRODUCT !== 'true') return null;
  const p = url.pathname.replace(/\/$/, '') || '/';
  if (LEGAL_REDIRECTS[p]) return new Response(null, { status: 301, headers: { location: url.origin + LEGAL_REDIRECTS[p] } });
  const kind = Object.keys(LEGAL_PATHS).find(k => LEGAL_PATHS[k] === p);
  if (!kind) return null;
  return new Response(renderLegalPage(kind), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}
