// The dashboard's notice when a free league reached its daily limit (caps
// batch, item 1c, src/mail_guard.js FREE_DAILY_CAP): how many emails wait
// for tomorrow, a button that cancels them (POST /league/mail/held/cancel,
// the dashboard's cancelHeldMail()), and the way out: subscribing. Both
// languages are rendered into data-date-fr/data-date-en, which the page's
// language toggle swaps. Pure.
import { pluralText } from './plural.js';

export const LIMIT_TEXT = {
  fr: {
    line: 'Limite quotidienne atteinte : {n|# courriel sera envoyé|# courriels seront envoyés} demain.',
    button: "{n|Ne pas l'envoyer|Ne pas les envoyer}",
    subscribe: 'Abonne-toi pour envoyer sans limite quotidienne.',
    done: '{n|# courriel ne sera pas envoyé.|# courriels ne seront pas envoyés.}'
  },
  en: {
    line: 'Daily limit reached: {n|# email|# emails} will be sent tomorrow.',
    button: "{n|Don't send it|Don't send them}",
    subscribe: 'Subscribe to send with no daily limit.',
    done: "{n|# email won't be sent.|# emails won't be sent.}"
  }
};

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const both = (tag, key, n, lang, attrs = '') => {
  const fr = pluralText(LIMIT_TEXT.fr[key], { n }, 'fr');
  const en = pluralText(LIMIT_TEXT.en[key], { n }, 'en');
  return `<${tag}${attrs ? ' ' + attrs : ''} data-date-fr="${esc(fr)}" data-date-en="${esc(en)}">${esc(lang === 'en' ? en : fr)}</${tag}>`;
};

// n: the emails held by the limit. '' when there are none.
export function freeCapBannerHtml(n, lang = 'fr') {
  if (!n || n < 1) return '';
  return `
  <section class="nl-card nl-card--pad-lg" id="dash_mail_limit" style="border-color:var(--yellow)">
    ${both('p', 'line', n, lang, 'style="margin:0;font-weight:700;"')}
    <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;">
      ${both('button', 'button', n, lang, 'type="button" class="nl-btn nl-btn--secondary nl-btn--sm" id="heldCancelBtn" onclick="cancelHeldMail()"')}
      ${both('p', 'done', n, lang, 'id="heldCancelMsg" class="nl-help" style="margin:0;display:none;"')}
    </div>
    <p class="nl-help" style="margin:10px 0 0;">${both('a', 'subscribe', n, lang, 'href="/league/billing"')}</p>
  </section>`;
}
