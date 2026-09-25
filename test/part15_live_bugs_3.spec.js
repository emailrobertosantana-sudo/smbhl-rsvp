// Two bugs found via a real end-to-end live verification against
// notreligue.ca:
//
// Bug 1 (CRITICAL): every league sent email FROM the admin's own raw
// signup email ("{league name} <{admin_email}>") -- Resend rejects
// that outright (403, "API key is not authorized to send emails from
// <domain>") since it's never a domain verified in the account, so
// EVERY league's email (reminders, sub-invites, logistics, co-admin
// invites) silently failed to send for every league except SMBHL (see
// live wrangler-tail evidence in the task report). Fixed: a league now
// sends from its own slug under mail.notreligue.ca (the domain already
// verified in this Resend account -- see DEFAULT_FROM_NON_SMBHL's own
// pre-existing identity), with Reply-To still the admin's real email
// so a player's reply reaches them directly.
//
// Bug 2: when a send failed (for any reason, including Bug 1's
// rejection), the manual "send now" trigger's own response ("sent: 0")
// was indistinguishable from "there was genuinely nothing to send",
// so a real failure looked exactly like ordinary success to the admin.
// Fixed: sendLeagueReminderKind now also returns eligible/failed
// counts, and the client shows a different, honest message depending
// on which case actually happened.
import { env, SELF } from 'cloudflare:test';
import { getLeagueSeasonConfig } from '../src/leagues.js';
import { runLeagueReminders } from '../src/index.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part15-live-bugs-3-secret';
const RSVP_SECRET = 'test-part15-live-bugs-3-rsvp-secret';

function extractCookie(res) {
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function extractCsrfToken(res) {
  const cookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') || '').split(', ');
  const csrfCookie = cookies.find(c => c.startsWith('csrf_token='));
  return csrfCookie ? csrfCookie.split(';')[0].split('=')[1] : '';
}
async function signupAndCreateLeague(email, ip, name, teamNames) {
  const signupRes = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);
  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, teamNames, tracksStats: true })
  });
  const leagueId = (await leagueRes.json()).league.id;
  await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ season_name: `${name} Season` })
  });
  return { cookie, csrfToken, leagueId };
}
function easternDateTimeHoursFromNow(hoursFromNow) {
  const target = new Date(Date.now() + hoursFromNow * 3600000);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(target);
  const get = t => parts.find(p => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${(get('hour') === '24' ? '00' : get('hour'))}:${get('minute')}` };
}
async function createEventHoursFromNow(cookie, csrfToken, hoursFromNow) {
  const { date, time } = easternDateTimeHoursFromNow(hoursFromNow);
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ date, start_time: time, venue: 'Test Gym' })
  });
  return (await res.json()).event.id;
}
// Reminder-window-skip-on-create bug fix task: createEventHoursFromNow
// (above) goes through the real /league/events route, which now marks
// any cadence step whose window has already elapsed AT CREATION as
// skipped (see reminder_scheduling.js) -- an event created 70h out no
// longer fires its 72h reminder on the very next cron tick. This
// inserts directly, bypassing that new hook, for the one test below
// whose actual purpose is the cron's own send behavior, not the
// creation-time skip mechanism (see part8_league_reminders.spec.js's
// own version of this same helper for the full rationale).
let directEventCounter = 0;
async function insertEventDirectlyHoursFromNow(leagueId, hoursFromNow) {
  const { date, time } = easternDateTimeHoursFromNow(hoursFromNow);
  const id = `${leagueId}:direct-${++directEventCounter}:${date}`;
  await env.DB.prepare(
    `INSERT INTO events (id, season, week, date, venue, state, start_time, league_id) VALUES (?, 'Direct Season', 1, ?, 'Direct Venue', 'open', ?, ?)`
  ).bind(id, date, time, leagueId).run();
  return id;
}
async function addPlayer(cookie, csrfToken, name, team, email) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, team, email })
  });
  return (await res.json()).contact.player_id;
}
async function withMailMock(fn) {
  const originalFetch = globalThis.fetch;
  const sentMails = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      sentMails.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: 'mock' }), { status: 200 });
    }
    return originalFetch(url, opts);
  };
  try {
    return { sentMails, result: await fn() };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
// Simulates the exact live failure: Resend rejects every send (e.g.
// the real 403 an unverified From domain gets), so sendMail throws for
// every recipient.
async function withFailingMailMock(fn) {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      attempts++;
      return new Response(JSON.stringify({ statusCode: 403, message: 'not authorized' }), { status: 403 });
    }
    return originalFetch(url, opts);
  };
  try {
    return { attempts: () => attempts, result: await fn() };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('Live-testing bugs, round 3: broken email sending', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    env.RESEND_API_KEY = 'mock-key';
    env.PUBLIC_URL = 'https://rsvp.notreligue.ca';
    await applyRealSchema(env);
  });

  describe('Bug 1: league email sends from slug@mail.notreligue.ca, Reply-To is the real admin email', () => {
    it("getLeagueSeasonConfig's own league branding uses the slug pattern, not the admin's raw email", async () => {
      const { leagueId } = await signupAndCreateLeague('bugs3.fromaddr@example.com', '203.0.118.001', 'From Address League', ['A', 'B']);
      const cfg = await getLeagueSeasonConfig(env, leagueId);
      expect(cfg.league.fromEmail).toContain('@mail.notreligue.ca');
      expect(cfg.league.fromEmail).not.toContain('bugs3.fromaddr@example.com');
      expect(cfg.league.replyToEmail).toBe('bugs3.fromaddr@example.com');
      const leagueRow = await env.DB.prepare('SELECT slug FROM leagues WHERE id = ?').bind(leagueId).first();
      expect(cfg.league.fromEmail).toContain(`${leagueRow.slug}@mail.notreligue.ca`);
    });

    it('a real sub-invite email sends from the slug pattern with the real admin email as Reply-To', async () => {
      const { cookie, csrfToken } = await signupAndCreateLeague('bugs3.subinvite@example.com', '203.0.118.002', 'Sub Invite League', ['A', 'B']);
      const eventId = await createEventHoursFromNow(cookie, csrfToken, 200);
      await addPlayer(cookie, csrfToken, 'Sub Invite Target', 'A', 'subinvitetarget@example.com');

      const { sentMails, result: res } = await withMailMock(() =>
        SELF.fetch('http://example.com/league/events/send-reminder', {
          method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ event_id: eventId })
        })
      );
      expect(res.status).toBe(200);
      expect(sentMails.length).toBe(1);
      expect(sentMails[0].from).toContain('@mail.notreligue.ca');
      expect(sentMails[0].from).not.toContain('bugs3.subinvite@example.com');
      expect(sentMails[0].reply_to).toBe('bugs3.subinvite@example.com');
    });

    it("SMBHL's own email identity (joueur@smbhl.com) is completely unaffected", async () => {
      // SMBHL never resolves league branding through getLeagueSeasonConfig
      // at all (every league-scoped route explicitly blocks SMBHL_LEAGUE_ID
      // before reaching it) -- this asserts SMBHL's own default identity,
      // untouched by this fix, is still exactly what it always was.
      const { getSeasonConfig } = await import('../src/season_config.js');
      const cfg = getSeasonConfig(undefined);
      expect(cfg.league.fromEmail).toBe('SMBHL - Hockey <joueur@smbhl.com>');
      expect(cfg.league.replyToEmail).toBe('info@smbhl.com');
    });
  });

  describe('Bug 2: send failures are distinguishable from "nothing to send"', () => {
    it('zero eligible recipients: sent=0, eligible=0, failed=0', async () => {
      const { cookie, csrfToken } = await signupAndCreateLeague('bugs3.noeligible@example.com', '203.0.118.003', 'No Eligible League', ['A', 'B']);
      const eventId = await createEventHoursFromNow(cookie, csrfToken, 200);
      // No players added at all -- genuinely nothing to send.
      const res = await SELF.fetch('http://example.com/league/events/send-reminder', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ event_id: eventId })
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.sent).toBe(0);
      expect(json.eligible).toBe(0);
      expect(json.failed).toBe(0);
    });

    it('real recipients but every send fails: sent=0, eligible>0, failed>0 -- distinguishable from the zero-eligible case', async () => {
      const { cookie, csrfToken } = await signupAndCreateLeague('bugs3.allfail@example.com', '203.0.118.004', 'All Fail League', ['A', 'B']);
      const eventId = await createEventHoursFromNow(cookie, csrfToken, 200);
      await addPlayer(cookie, csrfToken, 'All Fail Target', 'A', 'allfailtarget@example.com');

      const { attempts, result: res } = await withFailingMailMock(() =>
        SELF.fetch('http://example.com/league/events/send-reminder', {
          method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ event_id: eventId })
        })
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(attempts()).toBe(1); // a real send was genuinely attempted
      expect(json.sent).toBe(0);
      expect(json.eligible).toBe(1);
      expect(json.failed).toBe(1);
    });

    it('partial failure: some recipients succeed, some fail -- both counts are real', async () => {
      const { cookie, csrfToken } = await signupAndCreateLeague('bugs3.partial@example.com', '203.0.118.005', 'Partial League', ['A', 'B']);
      const eventId = await createEventHoursFromNow(cookie, csrfToken, 200);
      await addPlayer(cookie, csrfToken, 'Partial Target Good', 'A', 'partialgood@example.com');
      await addPlayer(cookie, csrfToken, 'Partial Target Bad', 'A', 'partialbad@example.com');

      const originalFetch = globalThis.fetch;
      const sentMails = [];
      globalThis.fetch = async (url, opts) => {
        if (String(url).includes('api.resend.com')) {
          const body = JSON.parse(opts.body);
          if (body.to.includes('partialbad@example.com')) {
            return new Response(JSON.stringify({ message: 'rejected' }), { status: 403 });
          }
          sentMails.push(body);
          return new Response(JSON.stringify({ id: 'mock' }), { status: 200 });
        }
        return originalFetch(url, opts);
      };
      let res;
      try {
        res = await SELF.fetch('http://example.com/league/events/send-reminder', {
          method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ event_id: eventId })
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.eligible).toBe(2);
      expect(json.sent).toBe(1);
      expect(json.failed).toBe(1);
      expect(sentMails.length).toBe(1);
    });

    it('the automated cron wave (runLeagueReminders) is unaffected by the return-shape change -- still sums to a plain count', async () => {
      const { cookie, csrfToken, leagueId } = await signupAndCreateLeague('bugs3.autowave@example.com', '203.0.118.006', 'Auto Wave League', ['A', 'B']);
      const eventId = await insertEventDirectlyHoursFromNow(leagueId, 70);
      await addPlayer(cookie, csrfToken, 'Auto Wave Target', 'A', 'autowavetarget@example.com');
      const { sentMails } = await withMailMock(() => runLeagueReminders(env));
      expect(sentMails.some(m => m.to.includes('autowavetarget@example.com'))).toBe(true);
    });
  });
});
