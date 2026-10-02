// Notre Ligue billing, batch 3: the billing notices, rendered. Sent by the
// daily job (src/billing_enforcement.js) through the outbox, once each
// (billing_notices), in the league's language setting (French, English or
// both). Pure: no database, no Stripe.
//
// Recipients (Roberto, 2026-10-01): payment and card notices go to the
// owner only; read-only and deletion warnings go to every admin.
//
// Links: a Stripe portal session expires within minutes, so no email links
// to one. Every notice links to the league's billing page, where the owner
// presses « Ajouter une carte » or « Gérer mon abonnement » to open the
// portal.
import { assembleBilingualEmail, nlEmailButton } from './design_system.js';
import { nlLegalEmailWrap } from './legal.js';
import { PRICE_CENTS, money } from './billing_actions.js';

export const NOTICE_KINDS = ['trial_7d', 'trial_day', 'trial_end', 'grace_start', 'grace_end', 'tier_change', 'payment_failed', 'over_100', 'deletion_30d', 'deletion_7d'];
export const OWNER_NOTICES = new Set(['trial_7d', 'trial_day', 'grace_start', 'tier_change', 'payment_failed', 'over_100']);
export const BILLING_NOTICE_KIND = 'billing_notice';

const NB = ' ';
const DAY = { fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'], en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] };
const MONTH = {
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
};
const PLAN = { fr: { free: 'Gratuit', standard: 'Standard', plus: 'Plus', custom: 'Sur mesure' }, en: { free: 'Free', standard: 'Standard', plus: 'Plus', custom: 'Custom' } };

// The date in words, from the ISO date (UTC, as the billing page shows it):
// « mercredi 2 décembre 2026 », « mardi 1er décembre 2026 » / "Wednesday,
// December 2, 2026".
export function noticeDate(iso, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  return lang === 'en'
    ? `${DAY.en[dow]}, ${MONTH.en[mo - 1]} ${d}, ${y}`
    : `${DAY.fr[dow]} ${d === 1 ? '1er' : d} ${MONTH.fr[mo - 1]} ${y}`;
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function price(tier, interval, lang) {
  const c = PRICE_CENTS[tier];
  if (!c) return '';
  const yearly = interval === 'year';
  const amount = money(yearly ? c.year : c.month, lang);
  if (lang === 'en') return `${amount} per ${yearly ? 'year' : 'month'}`;
  return `${amount} par ${yearly ? 'année' : 'mois'}`;
}

// The words of each notice: { subject, paragraphs, button } per language.
// v: { leagueName, date, since, count, oldTier, newTier, interval, variant }
export function noticeContent(kind, v) {
  const L = v.leagueName;
  const D = { fr: noticeDate(v.date, 'fr'), en: noticeDate(v.date, 'en') };
  const S = { fr: noticeDate(v.since, 'fr'), en: noticeDate(v.since, 'en') };
  const N = v.count;
  const card = v.variant === 'card';
  const see = { fr: "Voir l'abonnement", en: 'See the subscription' };
  const onlyOwner = {
    fr: 'Seul le compte qui a créé la ligue peut le faire.',
    en: 'Only the account that created the league can do this.'
  };
  switch (kind) {
    case 'trial_7d':
    case 'trial_day': {
      const last = kind === 'trial_day';
      if (card) return {
        fr: {
          subject: `${L}${NB}: ${last ? 'dernier rappel, ' : ''}ajoute une carte avant le ${D.fr}`,
          paragraphs: [
            `L'essai gratuit de ${L} se termine le ${D.fr}. Ton abonnement est prêt, mais aucune carte n'est enregistrée.`,
            `Ajoute une carte avant cette date${NB}: sur la page Abonnement, choisis «${NB}Gérer mon abonnement${NB}». Sans carte, l'abonnement sera mis en pause et la ligue passera en lecture seule.`
          ],
          button: 'Ajouter une carte'
        },
        en: {
          subject: `${L}: ${last ? 'last reminder, ' : ''}add a card before ${D.en}`,
          paragraphs: [
            `The free trial of ${L} ends on ${D.en}. Your subscription is ready, but no card is on file.`,
            'Add a card before then: on the Subscription page, choose “Manage my subscription”. Without a card, the subscription will be paused and the league will become read-only.'
          ],
          button: 'Add a card'
        }
      };
      return {
        fr: {
          subject: `${L}${NB}: ${last ? 'dernier rappel, ' : ''}ton essai gratuit se termine le ${D.fr}`,
          paragraphs: [
            `L'essai gratuit de ${L} se termine le ${D.fr}.`,
            "Abonne-toi avant cette date pour que la ligue reste active. Sans abonnement, elle passera en lecture seule et ses courriels automatiques s'arrêteront. Rien ne sera supprimé."
          ],
          button: "S'abonner"
        },
        en: {
          subject: `${L}: ${last ? 'last reminder, ' : ''}your free trial ends on ${D.en}`,
          paragraphs: [
            `The free trial of ${L} ends on ${D.en}.`,
            'Subscribe before then to keep the league active. Without a subscription, it will become read-only and its automatic emails will stop. Nothing will be deleted.'
          ],
          button: 'Subscribe'
        }
      };
    }
    case 'trial_end':
      return {
        fr: {
          subject: `${L}${NB}: la ligue est en lecture seule`,
          paragraphs: [
            `L'essai gratuit de ${L} est terminé. La ligue est maintenant en lecture seule${NB}: tu peux tout consulter, mais rien modifier, et ses courriels automatiques sont arrêtés.`,
            "Les joueurs peuvent encore répondre aux invitations déjà reçues. Rien n'est supprimé.",
            `${card ? 'Pour la réactiver, ajoute une carte depuis la page Abonnement.' : 'Pour la réactiver, abonne la ligue depuis la page Abonnement.'} ${onlyOwner.fr}`
          ],
          button: see.fr
        },
        en: {
          subject: `${L}: the league is read-only`,
          paragraphs: [
            `The free trial of ${L} has ended. The league is now read-only: you can see everything but change nothing, and its automatic emails are stopped.`,
            'Players can still answer the invitations they already have. Nothing is deleted.',
            `${card ? 'To reactivate it, add a card from the Subscription page.' : 'To reactivate it, subscribe from the Subscription page.'} ${onlyOwner.en}`
          ],
          button: see.en
        }
      };
    case 'grace_start':
      return {
        fr: {
          subject: `${L}${NB}: abonne-toi d'ici le ${D.fr} pour garder les courriels automatiques`,
          paragraphs: [
            `${L} compte maintenant ${N} joueurs réguliers. Une ligue gratuite en compte moins de 15.`,
            `Abonne-toi d'ici le ${D.fr} pour garder les courriels automatiques (rappels, appels aux remplaçants, alertes). Après cette date, ils s'arrêteront jusqu'à ton abonnement. Tout le reste continue de fonctionner, et tu peux toujours ajouter des joueurs.`
          ],
          button: "S'abonner"
        },
        en: {
          subject: `${L}: subscribe by ${D.en} to keep the automatic emails`,
          paragraphs: [
            `${L} now has ${N} regular players. A free league has fewer than 15.`,
            `Subscribe by ${D.en} to keep the automatic emails (reminders, sub calls, alerts). After that date, they will stop until you subscribe. Everything else keeps working, and you can still add players.`
          ],
          button: 'Subscribe'
        }
      };
    case 'grace_end':
      return {
        fr: {
          subject: `${L}${NB}: les courriels automatiques sont arrêtés`,
          paragraphs: [
            `${L} compte 15 joueurs réguliers ou plus, et le délai de 14 jours pour s'abonner est passé. Les courriels automatiques (rappels, appels aux remplaçants, alertes) sont maintenant arrêtés. Tout le reste fonctionne.`,
            `Pour les remettre en marche, abonne la ligue depuis la page Abonnement. ${onlyOwner.fr}`
          ],
          button: see.fr
        },
        en: {
          subject: `${L}: automatic emails are stopped`,
          paragraphs: [
            `${L} has 15 or more regular players, and the 14 days to subscribe have passed. Automatic emails (reminders, sub calls, alerts) are now stopped. Everything else still works.`,
            `To turn them back on, subscribe from the Subscription page. ${onlyOwner.en}`
          ],
          button: see.en
        }
      };
    case 'tier_change':
      return {
        fr: {
          subject: `${L}${NB}: ton forfait passe à ${PLAN.fr[v.newTier]} le ${D.fr}`,
          paragraphs: [
            `${L} compte maintenant ${N} joueurs réguliers. Ton forfait passera de ${PLAN.fr[v.oldTier]} à ${PLAN.fr[v.newTier]} le ${D.fr}, ta prochaine date de facturation, au prix de ${price(v.newTier, v.interval, 'fr')} avant taxes.`,
            "Rien ne change d'ici là."
          ],
          button: see.fr
        },
        en: {
          subject: `${L}: your plan changes to ${PLAN.en[v.newTier]} on ${D.en}`,
          paragraphs: [
            `${L} now has ${N} regular players. Your plan will change from ${PLAN.en[v.oldTier]} to ${PLAN.en[v.newTier]} on ${D.en}, your next billing date, at ${price(v.newTier, v.interval, 'en')} before tax.`,
            'Nothing changes until then.'
          ],
          button: see.en
        }
      };
    case 'payment_failed':
      return {
        fr: {
          subject: `${L}${NB}: le paiement n'a pas passé`,
          paragraphs: [
            `Le dernier paiement de l'abonnement de ${L} n'a pas passé. La ligue est en lecture seule jusqu'au paiement.`,
            `Mets ta carte à jour sur la page Abonnement, avec «${NB}Gérer mon abonnement${NB}». Dès que le paiement passe, la ligue est débloquée.`
          ],
          button: 'Mettre ma carte à jour'
        },
        en: {
          subject: `${L}: the payment didn't go through`,
          paragraphs: [
            `The last payment for the ${L} subscription didn't go through. The league is read-only until it is paid.`,
            'Update your card on the Subscription page, with “Manage my subscription”. As soon as the payment goes through, the league is unlocked.'
          ],
          button: 'Update my card'
        }
      };
    case 'over_100':
      return {
        fr: {
          subject: `${L}${NB}: plus de 100 joueurs réguliers`,
          paragraphs: [
            `${L} compte maintenant ${N} joueurs réguliers. Au-delà de 100, le prix est établi sur mesure.`,
            "Écris-nous à bonjour@notreligue.ca et nous te proposerons un prix. Rien ne change pour ta ligue d'ici là."
          ],
          button: null
        },
        en: {
          subject: `${L}: more than 100 regular players`,
          paragraphs: [
            `${L} now has ${N} regular players. Above 100, the price is set case by case.`,
            "Write to us at bonjour@notreligue.ca and we'll suggest a price. Nothing changes for your league until then."
          ],
          button: null
        }
      };
    case 'deletion_30d':
    case 'deletion_7d':
      return {
        fr: {
          subject: `${L}${NB}: suppression prévue le ${D.fr}`,
          paragraphs: [
            `Aucun abonnement n'est actif pour ${L} depuis le ${S.fr} (essai non payé ou abonnement annulé). Comme le prévoit notre politique de confidentialité, une ligue inactive pendant 12 mois est supprimée définitivement.`,
            `Toutes les données de ${L} seront supprimées le ${D.fr}${NB}: ses joueurs, son horaire et son historique. Cette suppression ne peut pas être annulée.`,
            `Pour l'arrêter, abonne la ligue depuis la page Abonnement avant cette date. ${onlyOwner.fr}`
          ],
          button: see.fr
        },
        en: {
          subject: `${L}: deletion scheduled for ${D.en}`,
          paragraphs: [
            `${L} has had no active subscription since ${S.en} (unpaid trial or cancelled subscription). As our privacy policy says, a league inactive for 12 months is permanently deleted.`,
            `All of ${L}'s data will be deleted on ${D.en}: its players, schedule and history. This cannot be undone.`,
            `To stop it, subscribe from the Subscription page before then. ${onlyOwner.en}`
          ],
          button: see.en
        }
      };
    default:
      throw new Error(`unknown billing notice: ${kind}`);
  }
}

// The email: { subject, text, html }, in the league's language mode.
// v also has languageMode and billingUrl.
export function renderBillingNotice(kind, v) {
  const content = noticeContent(kind, v);
  const one = lang => {
    const c = content[lang];
    const hello = lang === 'en' ? 'Hi,' : 'Bonjour,';
    const team = lang === 'en' ? 'The Notre Ligue team' : "L'équipe Notre Ligue";
    const linkLine = c.button ? `${c.button}${lang === 'en' ? ':' : `${NB}:`} ${v.billingUrl}` : null;
    const text = [hello, ...c.paragraphs, linkLine, team].filter(Boolean).join('\n\n');
    const p = s => `<p style="margin:0 0 16px;font-size:16px;line-height:25px;">${esc(s)}</p>`;
    const html = `<div lang="${lang === 'en' ? 'en-CA' : 'fr-CA'}">${p(hello)}${c.paragraphs.map(p).join('')}`
      + `${c.button ? `<div style="margin:8px 0 24px;">${nlEmailButton(v.billingUrl, c.button)}</div>` : ''}${p(team)}</div>`;
    return { subject: c.subject, text, html };
  };
  const mode = v.languageMode === 'fr' || v.languageMode === 'en' ? v.languageMode : 'both';
  const assembled = assembleBilingualEmail(mode, { fr: one('fr'), en: one('en') });
  return {
    subject: assembled.subject,
    text: assembled.text,
    html: nlLegalEmailWrap({ languageMode: mode, brandName: 'Notre Ligue', bodyHtml: assembled.html, footerHtml: 'Notre Ligue' })
  };
}
