// The link checker: every link in every email the league product sends is
// opened, and must reach the page it is for. Never a 404, never an empty
// page, and for a page that needs a session, never a login page that
// forgets where the person was going.
//
// A league is run for real (its own routes, the cron on a clock, players
// acting on their emails) so that each kind of email is the one the
// product sends: account confirmation, password reset, co-admin
// invitation, the 72 h and 24 h reminders, the 12 h details, a sub call,
// a late drop-out alert, a short-of-players alert, a cancelled game, a
// changed time, a message to the league.
//
// Each link is requested twice: with no session (a phone's mail app), and
// with the admin's session.
//   player links (an answer, a sub's yes, the public page): the page, with
//     or without a session;
//   admin links (the game page, the dashboard): with a session, the page
//     itself; without, the login page carrying the exact destination, and
//     signing in lands on it (test/part180_login_return.spec.js follows
//     that flow to the end, for every way of signing in).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { H, DAY, local, mail, installMailCapture, removeMailCapture, admin, must, pass, answer, rows } from './support/league_season.js';

const BASE = 'https://links.example';
const T0 = Date.parse('2027-03-01T15:00:00Z');
let a, league, g1, g2, start;

// What each path is, and what opening it must give.
//   login: needs a session (signed out: 302 to /login?next=<this link>).
//   shows: text the page must contain when it is the right page.
const PAGES = {
  '/auth/verify': { what: 'account confirmation', login: false, shows: [/Courriel confirmé|Email confirmed/] },
  '/reset-password': { what: 'new password form', login: false, shows: [/id="rp_password"/] },
  '/league/admins/accept': { what: 'co-admin invitation', login: false, shows: [/P182 League/] },
  '/league/rsvp': { what: "player's answer page (a yes or no link stops at its confirmation step)", login: false, shows: [/<form method="post"|rv-answers/] },
  '/': { what: 'site home', login: false, shows: [/Notre Ligue/] },
  '/avail': { what: "sub's answer (confirmation step)", login: false, shows: [/<form method="post"/] },
  '/league/events/detail': { what: 'game page (admin)', login: true, shows: [/id="ev_|class="ev-/] },
  '/dashboard': { what: 'dashboard (admin)', login: true, shows: [/P182 League/] }
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T0));
  env.AUTH_SECRET = 'p182-auth'; env.RSVP_SECRET = 'p182-rsvp'; env.RESEND_API_KEY = 'p182'; env.LEAGUE_PRODUCT = 'true'; env.PUBLIC_URL = BASE; env.MAIL_DAILY_CAP = ''; env.MAIL_HARD_DAILY_CAP = '';
  await applyRealSchema(env);
  installMailCapture();
  a = await admin('p182'); // the confirmation email
  league = (await must(a.post('/leagues/create', { name: 'P182 League', teamNames: ['Bulls', 'Parade'] }), 'create')).league;
  await must(a.post('/league/season/publish', { season_name: 'S1' }), 'season');
  let n = 0;
  for (const team of ['Bulls', 'Parade']) {
    await must(a.post('/league/contacts', { name: `${team} Goalie`, email: `p${++n}@players.example`, team, is_goalie: true }), 'g');
    for (let i = 0; i < 5; i++) await must(a.post('/league/contacts', { name: `${team} Player${String.fromCharCode(65 + i)}`, email: `p${++n}@players.example`, team }), 'p');
  }
  await must(a.post('/league/contacts', { name: 'Sam Sub', email: 'sam@subs.example', role: 'sub_skater' }), 'sub');
  const d1 = local(T0 + 5 * DAY), d2 = local(T0 + 6 * DAY);
  g1 = (await must(a.post('/league/events', { date: d1.date, start_time: '19:00', end_time: '20:00', venue: 'Gym', home_team: 'Bulls', away_team: 'Parade' }), 'g1')).event;
  g2 = (await must(a.post('/league/events', { date: d2.date, start_time: '19:00', end_time: '20:00', venue: 'Gym', home_team: 'Bulls', away_team: 'Parade' }), 'g2')).event;
  start = Date.parse(`${d1.date}T19:00:00-05:00`);

  // The league's other emails, as an admin and the clock produce them.
  await must(a.post('/league/admins/invite', { email: 'coadmin@example.com' }), 'invite');
  await must(a.post('/league/comms/broadcast', { target: 'all', subject: 'Avis', message: 'Bonjour à tous.' }), 'broadcast');
  await SELF.fetch(BASE + '/auth/request-password-reset', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify({ email: 'admin.p182@example.com' }) });
  await pass(start - 70 * H); // 72 h reminder
  // The Bulls say yes, from their own email; the Parade do not answer yet.
  const asks = mail.sent.filter(m => /^p[1-6]@players\.example$/.test(m.to) && linksIn(m).some(l => l.pathname === '/league/rsvp'));
  for (const m of asks) {
    const yes = linksIn(m).find(l => l.pathname === '/league/rsvp' && l.searchParams.get('v') === 'in');
    if (yes) await answer(yes.href);
  }
  await pass(start - 23 * H); // 24 h reminder (whoever has not answered)
  await pass(start - 11 * H); // 12 h details
  // A confirmed Bulls player drops out late: the admin is told, the sub is called.
  const late = mail.sent.filter(m => m.to === 'p2@players.example').flatMap(m => linksIn(m)).find(l => l.pathname === '/league/rsvp' && l.searchParams.get('v') === 'out');
  if (late) await answer(late.href);
  await pass(start - 10 * H);
  // The second game moves, then is cancelled.
  await a.post('/league/events/update', { event_id: g2.id, start_time: '20:30', end_time: '21:30' });
  await must(a.post('/league/events/cancel', { event_id: g2.id }), 'cancel');
  await pass(start - 9 * H);
}, 120000);
afterAll(() => { removeMailCapture(); vi.useRealTimers(); });

// Every link of this site in an email (HTML and text), &amp; undone.
function linksIn(m) {
  const out = new Map();
  for (const src of [m.html, m.text]) {
    for (const x of String(src).matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      const raw = x[0].replace(/&amp;/g, '&').replace(/[).,]+$/, '');
      try { const u = new URL(raw); if (u.origin === BASE) out.set(u.href, u); } catch (_) {}
    }
  }
  return [...out.values()];
}
const get = (u, cookie) => SELF.fetch(u.href, { redirect: 'manual', headers: { accept: 'text/html', ...(cookie ? { cookie } : {}) } });

describe('Every link in every league email', () => {
  it('the season produced every kind of email', async () => {
    const kinds = (await rows('SELECT DISTINCT kind FROM outbox')).map(r => r.kind).sort();
    for (const k of ['reminder_72h', 'reminder_24h', 'logistics_12h', 'sub_call', 'game_cancelled']) expect(kinds, kinds.join(',')).toContain(k);
    const subjects = mail.sent.map(m => m.subject).join('\n');
    for (const re of [/Confirme ton courriel|Confirm your email/, /mot de passe|password/i, /Avis/, /invit/i]) expect(subjects).toMatch(re);
    expect(mail.sent.length).toBeGreaterThan(30);
  });

  it('reaches its page: no session, then the admin\'s session', async () => {
    const seen = new Map(); // path -> { count, mails }
    const problems = [];
    // The admin's current session (sessions are 30 days; the clock moved less).
    const cookie = a.s.cookie;
    for (const m of [...mail.sent]) {
      // Opened a minute after it arrived (a confirmation or invitation link has its own lifetime).
      vi.setSystemTime(new Date(m.at + 60000));
      for (const u of linksIn(m)) {
        // The league's public page is named by its slug: any single-segment path.
        const spec = PAGES[u.pathname] || (/^\/[a-z0-9-]+$/.test(u.pathname) ? { what: 'public page', login: false, shows: [/P182 League/] } : null);
        if (!spec) { problems.push(`unknown link ${u.pathname} in "${m.subject}"`); continue; }
        const key = u.pathname.startsWith('/league/') || PAGES[u.pathname] ? u.pathname : '/<league slug>';
        const e = seen.get(key) || { what: spec.what, links: 0, subjects: new Set() };
        e.links++; e.subjects.add(m.subject.replace(/\d+/g, 'N').slice(0, 40));
        seen.set(key, e);
        if (e.links > 6) continue; // six of each are opened; the rest are the same link for other players
        const out = await get(u);
        const outBody = await out.text();
        if (spec.login) {
          const want = `${BASE}/login?next=${encodeURIComponent(u.pathname + u.search)}`;
          if (out.status !== 302 || out.headers.get('location') !== want) problems.push(`${u.pathname} signed out: ${out.status} ${out.headers.get('location')} (wanted 302 ${want})`);
          const login = await get(new URL(want));
          const loginHtml = await login.text();
          if (login.status !== 200 || !loginHtml.includes(`window.location.href = ${JSON.stringify(u.pathname + u.search)} || '/dashboard';`)) problems.push(`${u.pathname}: the login page does not carry the destination`);
        } else if (out.status !== 200 || outBody.length < 500 || !spec.shows.every(re => re.test(outBody))) {
          problems.push(`${u.pathname} signed out: ${out.status}, ${outBody.length} bytes, in "${m.subject}"`);
        }
        const inn = await get(u, cookie);
        const inBody = await inn.text();
        // A reset or confirmation token is used once or tied to its owner; the page itself must still answer.
        if (inn.status !== 200 || inBody.length < 500 || !spec.shows.every(re => re.test(inBody))) problems.push(`${u.pathname} signed in: ${inn.status}, ${inBody.length} bytes, in "${m.subject}"`);
      }
    }
    expect(problems).toEqual([]);
    // French voice, in every email of the season: "tu", and "remplaçant"
    // (the sub call's closing line included: Notre Ligue's says
    // « liste des remplaçants »).
    const FORMAL_FR = /(^|[^a-zà-ÿ])(vous|votre|vos|veuillez)(?![a-zà-ÿ])|substituts?(?![a-zà-ÿ])/i;
    const voice = [];
    for (const m of mail.sent) {
      for (const part of [m.subject, m.text, m.html.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ')]) {
        const shown = part;
        const hit = FORMAL_FR.exec(shown);
        if (hit) voice.push(`"${m.subject}": ${shown.slice(Math.max(0, hit.index - 50), hit.index + 60).replace(/\s+/g, ' ')}`);
      }
    }
    expect([...new Set(voice)]).toEqual([]);
    // Every kind of destination was met.
    expect([...seen.keys()].sort()).toEqual(['/', '/auth/verify', '/avail', '/league/admins/accept', '/league/events/detail', '/league/rsvp', '/reset-password'].sort());
  }, 120000);
});
