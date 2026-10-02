// The operator's daily digest (stage 2): one email a day to
// bonjour@notreligue.ca, French then English, on days with something to
// report, and nothing on quiet days. Notre Ligue only.
//
// What it reports, since the previous digest:
//   - new sign-ups (leagues created);
//   - leagues that turned yellow or red (the daily health, src/league_health.js);
//   - trials that entered their last 7 days without a subscription (once,
//     the day they enter);
//   - failed payments (Stripe's invoice.payment_failed events);
//   - leagues that went above 100 regular players (billing batch 3: the
//     owner's notice to write for a custom price, src/billing_enforcement.js).
//
// When: right after the daily health run (prepareOpsDigest stores what is
// to be told, settings key ops_digest:pending, no migration), and sent by
// the same or a later pass (deliverOpsDigest) through the normal mail path:
// an outbox row (kind ops_digest, league 'system'), then the system drain.
// It never uses the payment reminder reserve: it waits (for a later pass,
// the next day if need be) while the day's budget left is within the
// reserve (index.js paymentReminderBudget). Nothing is lost while it
// waits: a later day's items are added to the pending digest.
import { SMBHL_LEAGUE_ID } from './league_ids.js';
import { maskEmail } from './contact_name.js';
import { getSetting, putSetting } from './league_health.js';
import { nlEmailWrap } from './design_system.js';

export const OPS_DIGEST_TO = 'bonjour@notreligue.ca';
export const OPS_DIGEST_KIND = 'ops_digest';
export const DIGEST_PENDING_KEY = 'ops_digest:pending';
export const DIGEST_CUTOFF_KEY = 'ops_digest:cutoff';
export const DIGEST_LAST_KEY = 'ops_digest:last';

const parseJson = v => { try { return JSON.parse(v); } catch (_) { return null; } };
const emptyItems = () => ({ signups: [], worsened: [], trials: [], payments: [], custom: [] });
export const digestHasItems = items => !!items && ['signups', 'worsened', 'trials', 'payments', 'custom'].some(k => (items[k] || []).length > 0);

// After the daily health run: what happened since the last cutoff, added to
// any digest still waiting. Returns the pending digest, or null.
export async function prepareOpsDigest(env, health, now = new Date()) {
  const db = env.DB;
  const cutoff = (await getSetting(db, DIGEST_CUTOFF_KEY)) || new Date(now.getTime() - 86400000).toISOString();
  const nowIso = now.toISOString();
  const items = emptyItems();
  const signups = (await db.prepare(
    `SELECT l.id, l.name, l.created_at, u.email FROM leagues l LEFT JOIN users u ON u.id = l.created_by
      WHERE l.id != ? AND l.created_at > ? AND l.created_at <= ? ORDER BY l.created_at`
  ).bind(SMBHL_LEAGUE_ID, cutoff, nowIso).all()).results || [];
  for (const s of signups) items.signups.push({ id: s.id, name: s.name, at: s.created_at, owner: maskEmail(s.email || '') });
  for (const w of (health && health.worsened) || []) items.worsened.push({ id: w.id, name: w.name, from: w.from, to: w.to });
  for (const t of (health && health.trialsEntering) || []) items.trials.push({ id: t.id, name: t.name, trialEndsAt: t.trialEndsAt });
  try {
    const failed = (await db.prepare(
      `SELECT e.league_id, e.created, e.processed_at, l.name FROM stripe_events e LEFT JOIN leagues l ON l.id = e.league_id
        WHERE e.type = 'invoice.payment_failed' AND e.league_id IS NOT NULL AND e.processed_at > ? AND e.processed_at <= ?
        ORDER BY e.processed_at`
    ).bind(cutoff, nowIso).all()).results || [];
    for (const f of failed) items.payments.push({ id: f.league_id, name: f.name || f.league_id, at: f.created ? new Date(Number(f.created) * 1000).toISOString() : f.processed_at });
  } catch (_) {}
  try {
    const big = (await db.prepare(
      `SELECT n.league_id, n.sent_at, l.name, b.regular_count FROM billing_notices n
         LEFT JOIN leagues l ON l.id = n.league_id LEFT JOIN league_billing b ON b.league_id = n.league_id
        WHERE n.kind = 'over_100' AND n.sent_at > ? AND n.sent_at <= ? ORDER BY n.sent_at`
    ).bind(cutoff, nowIso).all()).results || [];
    for (const g of big) items.custom.push({ id: g.league_id, name: g.name || g.league_id, count: Number(g.regular_count) || null });
  } catch (_) {}
  await putSetting(db, DIGEST_CUTOFF_KEY, nowIso);
  const pending = parseJson(await getSetting(db, DIGEST_PENDING_KEY));
  if (!digestHasItems(items)) return pending && digestHasItems(pending.items) ? pending : null;
  const merged = pending && pending.items ? pending : { since: cutoff, items: emptyItems() };
  for (const k of Object.keys(items)) merged.items[k] = [...(merged.items[k] || []), ...items[k]];
  merged.day = (health && health.day) || nowIso.slice(0, 10);
  merged.preparedAt = nowIso;
  await putSetting(db, DIGEST_PENDING_KEY, merged);
  return merged;
}

const LIGHT = { fr: { red: 'rouge', yellow: 'jaune', green: 'vert' }, en: { red: 'red', yellow: 'yellow', green: 'green' } };
const day = s => String(s || '').slice(0, 10);

// The email: French, then English. Pure.
export function renderOpsDigest(pending, publicUrl = '') {
  const it = pending.items;
  const link = `${publicUrl || 'https://rsvp.notreligue.ca'}/super-admin/leagues`;
  const sections = lang => {
    const fr = lang === 'fr';
    const out = [];
    if (it.signups.length) out.push({
      title: fr ? 'Nouvelles inscriptions' : 'New sign-ups',
      lines: it.signups.map(s => fr ? `${s.name} : inscrite le ${day(s.at)}${s.owner ? `, ${s.owner}` : ''}` : `${s.name}: signed up on ${day(s.at)}${s.owner ? `, ${s.owner}` : ''}`)
    });
    if (it.worsened.length) out.push({
      title: fr ? 'Ligues passées au jaune ou au rouge' : 'Leagues that turned yellow or red',
      lines: it.worsened.map(w => fr ? `${w.name} : ${LIGHT.fr[w.to]} (était ${LIGHT.fr[w.from]})` : `${w.name}: ${LIGHT.en[w.to]} (was ${LIGHT.en[w.from]})`)
    });
    if (it.trials.length) out.push({
      title: fr ? "Essais qui finissent dans 7 jours ou moins, sans abonnement" : 'Trials ending within 7 days, without a subscription',
      lines: it.trials.map(t => fr ? `${t.name} : fin de l'essai le ${day(t.trialEndsAt)}` : `${t.name}: trial ends on ${day(t.trialEndsAt)}`)
    });
    if ((it.custom || []).length) out.push({
      title: fr ? 'Plus de 100 joueurs réguliers (prix sur mesure)' : 'More than 100 regular players (custom price)',
      lines: it.custom.map(c => fr ? `${c.name} : ${c.count || '100+'} joueurs réguliers` : `${c.name}: ${c.count || '100+'} regular players`)
    });
    if (it.payments.length) out.push({
      title: fr ? 'Paiements en échec' : 'Failed payments',
      lines: it.payments.map(p => fr ? `${p.name} : le ${day(p.at)}` : `${p.name}: on ${day(p.at)}`)
    });
    return out;
  };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = lang => {
    const intro = lang === 'fr' ? `Résumé du ${pending.day} :` : `Digest for ${pending.day}:`;
    const more = lang === 'fr' ? 'Toutes les ligues :' : 'Every league:';
    return [intro, '', ...sections(lang).flatMap(s => [s.title, ...s.lines.map(l => `- ${l}`), '']), `${more} ${link}`].join('\n');
  };
  const html = lang => {
    const intro = lang === 'fr' ? `Résumé du ${pending.day} :` : `Digest for ${pending.day}:`;
    const more = lang === 'fr' ? 'Toutes les ligues' : 'Every league';
    return `<div lang="${lang === 'fr' ? 'fr-CA' : 'en-CA'}"><p style="margin:0 0 12px;font-size:16px;line-height:25px;">${esc(intro)}</p>`
      + sections(lang).map(s => `<p style="margin:16px 0 4px;font-size:16px;line-height:24px;font-weight:700;">${esc(s.title)}</p><ul style="margin:0;padding-left:20px;font-size:15px;line-height:23px;">${s.lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`).join('')
      + `<p style="margin:16px 0 0;font-size:15px;line-height:23px;"><a href="${esc(link)}" style="color:#16181d;">${esc(more)}</a></p></div>`;
  };
  return {
    subject: `Notre Ligue : résumé du jour / daily digest (${pending.day})`,
    text: `${text('fr')}\n\n---\n\n${text('en')}`,
    html: nlEmailWrap({ brandName: 'Notre Ligue', bodyHtml: `${html('fr')}<hr style="border:none;border-top:1px solid #e3e3e0;margin:28px 0;">${html('en')}`, footerHtml: 'Notre Ligue' })
  };
}

// Sends the pending digest when the day's budget has room beyond the payment
// reminder reserve. host: { budgetLeft(): number|null (null = no cap),
// enqueue(mail), drainSystem() }. Returns 'sent' | 'waiting' | 'none'.
export async function deliverOpsDigest(env, host, now = new Date()) {
  const pending = parseJson(await getSetting(env.DB, DIGEST_PENDING_KEY));
  if (!pending || !digestHasItems(pending.items)) return 'none';
  const left = await host.budgetLeft();
  if (left != null && left < 1) return 'waiting';
  const mail = renderOpsDigest(pending, env.PUBLIC_URL || '');
  await host.enqueue(mail, `${OPS_DIGEST_KIND}:${pending.day}:${pending.preparedAt}`);
  await env.DB.prepare('DELETE FROM settings WHERE key = ?').bind(DIGEST_PENDING_KEY).run();
  await putSetting(env.DB, DIGEST_LAST_KEY, { day: pending.day, queuedAt: now.toISOString() });
  await host.drainSystem();
  return 'sent';
}
