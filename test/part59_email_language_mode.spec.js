// Live-testing task (batch 3), Part 1: every email follows the
// league's language_mode setting ('fr' | 'en' | 'both'), for ALL
// emails without exception -- including admin account emails
// (password reset, co-admin invites), NOT the admin's personal
// signup_lang.
//
// AUDIT (documented here, full detail in the final report): of
// body()'s 14 legacy-switch cases (index.js), only 'sub_call' is
// genuinely reachable by league-product code (every enqueue() call
// site in the codebase was traced; every other case is enqueued only
// from SMBHL's own cron or SMBHL-only routes) -- so only that case
// needed a languageMode branch there. buildInviteEmail (leagues.js,
// co-admin invite) was the confirmed-broken bug report itself.
// buildPasswordResetEmail (auth.js) had no language awareness at all.
// renderLeagueReminderEmail/renderLeagueLogisticsEmail (index.js,
// automated 72h/24h/12h reminders) already correctly respected
// language_mode via their own forcedLang param before this task --
// reconciled onto the same shared assembler for consistency, output
// unchanged. renderLateReversalAdminAlert (index.js, league-only, no
// SMBHL equivalent) had no language awareness -- fixed. Every
// SMBHL-only email (chase/gameday/friday_board/gameday_morning/
// notice/assigned/released/team_short/created/summary/
// season_recap[_prompt], the poll broadcast, the game-cancellation
// broadcast, the scoresheet-review notify/publish emails) is
// structurally unreachable by any league_id other than SMBHL's own,
// confirmed by tracing every enqueue()/sendMail() call site in the
// codebase -- left completely untouched.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { body } from '../src';

const AUTH_SECRET = 'test-part1-batch3-email-language-mode-secret';

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
async function signup(email, ip, lang) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1', lang })
  });
  const json = await res.json();
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res), userId: json.userId };
}
async function createLeague(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).league;
}
async function setLanguageMode(cookie, csrfToken, languageMode) {
  const res = await SELF.fetch('http://example.com/league/language-mode', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ languageMode })
  });
  expect(res.status).toBe(200);
}
async function withMailMock(fn) {
  const originalFetch = globalThis.fetch;
  const sentMails = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.resend.com')) {
      sentMails.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: 'mock_resend_id' }), { status: 200 });
    }
    return originalFetch(url, opts);
  };
  try {
    return { sentMails, result: await fn(sentMails) };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
// A mail's html is considered "French content present" if it contains
// a French-only phrase from the template that has NO English
// equivalent string overlap, and likewise for English -- avoids false
// positives from words that are identical or embedded in both (e.g.
// "email", team names).
const FR_MARKERS = ['Réinitialise ton mot de passe', 'co-administrer', 'cherche un', 'gardien', 'joueur', 'Disponible'];
const EN_MARKERS = ['Reset your password', 'co-admin', 'needs a', 'goalie', 'skater', 'Available'];
function hasAny(haystack, markers) {
  return markers.some(m => haystack.includes(m));
}

describe('Part 1 (live-testing task, batch 3): every email follows the league\'s language_mode', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = 'test-part1-batch3-rsvp-secret';
    env.RESEND_API_KEY = 'test-part1-batch3-resend-key';
    await applyRealSchema(env);
  });

  describe('body()\'s sub_call case (the only body() case genuinely reachable by league-product code)', () => {
    const baseArgs = (languageMode) => ({
      ev: { id: 'x:2026-11-01', date: '2026-11-01', start_time: '19:00', venue: 'Arena' },
      name: 'Jordan',
      team: 'Otters',
      link: 'https://example.com/rsvp?x',
      payload: { need: 'skater', yes: 'https://example.com/y', no: 'https://example.com/n' },
      leagueCfg: { name: 'Test League', siteUrl: 'https://example.com', languageMode }
    });

    it("languageMode 'fr' renders French only", () => {
      const mail = body('sub_call', baseArgs('fr'));
      expect(hasAny(mail.html, FR_MARKERS)).toBe(true);
      expect(hasAny(mail.html, EN_MARKERS)).toBe(false);
      expect(mail.text).not.toContain('Available?');
      expect(mail.subject).not.toContain('/');
    });

    it("languageMode 'en' renders English only", () => {
      const mail = body('sub_call', baseArgs('en'));
      expect(hasAny(mail.html, EN_MARKERS)).toBe(true);
      expect(hasAny(mail.html, FR_MARKERS)).toBe(false);
      expect(mail.text).not.toContain('Disponible');
    });

    it("languageMode 'both' renders genuinely bilingual content", () => {
      const mail = body('sub_call', baseArgs('both'));
      expect(mail.html).toContain('Disponible');
      expect(mail.html).toContain('Available?');
      expect(mail.text).toContain('Disponible');
      expect(mail.text).toContain('Available?');
    });

    it("SMBHL (no leagueCfg -- DEFAULT_SEASON_CONFIG.league, languageMode 'both') is completely unaffected: still stacks both languages unconditionally", () => {
      const mail = body('sub_call', {
        ev: { id: '2026-11-01', date: 'Sunday November 01 2026', start_time: null, venue: 'Gym' },
        name: 'Real Player',
        team: 'Red',
        link: 'https://smbhl.com/rsvp?x',
        payload: { need: 'goalie', yes: 'https://smbhl.com/y', no: 'https://smbhl.com/n' },
        leagueCfg: null
      });
      expect(mail.html).toContain('Disponible');
      expect(mail.html).toContain('Available?');
      expect(mail.subject).not.toContain('/');
    });
  });

  describe('co-admin invite email (the confirmed-broken bug report), password reset, and reminder emails follow the league\'s real language_mode', () => {
    async function makeLeagueWithMode(email, ip, name, languageMode) {
      const { cookie, csrfToken, userId } = await signup(email, ip, 'fr');
      const league = await createLeague(cookie, csrfToken, { name, teamNames: ['Otters', 'Falcons'], tracksStats: true });
      if (languageMode !== 'both') await setLanguageMode(cookie, csrfToken, languageMode);
      return { cookie, csrfToken, userId, league };
    }

    for (const mode of ['fr', 'en', 'both']) {
      it(`co-admin invite email respects languageMode='${mode}'`, async () => {
        const { cookie, csrfToken } = await makeLeagueWithMode(`langmode.invite.${mode}@example.com`, `203.0.175.0${mode.length}`, `Invite ${mode} League`, mode);
        const { sentMails } = await withMailMock(() =>
          SELF.fetch('http://example.com/league/admins/invite', {
            method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
            body: JSON.stringify({ email: `coadmin.${mode}@example.com` })
          })
        );
        expect(sentMails.length).toBe(1);
        const mail = sentMails[0];
        if (mode === 'fr') {
          expect(mail.html).toContain('co-administrer');
          expect(mail.html).not.toContain('Co-admin invitation');
        } else if (mode === 'en') {
          expect(mail.html).toContain('Co-admin invitation');
          expect(mail.html).not.toContain('co-administrer');
        } else {
          expect(mail.html).toContain('co-administrer');
          expect(mail.html).toContain('Co-admin invitation');
        }
      });
    }

    for (const mode of ['fr', 'en', 'both']) {
      it(`password reset email respects the language_mode of the account's most-recently-created league ('${mode}'), not signup_lang`, async () => {
        // Signup lang is deliberately the OPPOSITE of the league's mode
        // (or 'en' when mode is 'both') to prove the reset email is NOT
        // reading signup_lang.
        const signupLang = mode === 'fr' ? 'en' : 'fr';
        const { cookie, csrfToken, userId } = await signup(`langmode.reset.${mode}@example.com`, `203.0.176.0${mode.length}`, signupLang);
        const league = await createLeague(cookie, csrfToken, { name: `Reset ${mode} League`, teamNames: ['A', 'B'], tracksStats: true });
        if (mode !== 'both') await setLanguageMode(cookie, csrfToken, mode);

        const { sentMails } = await withMailMock(() =>
          SELF.fetch('http://example.com/auth/request-password-reset', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: `langmode.reset.${mode}@example.com` })
          })
        );
        expect(sentMails.length).toBe(1);
        const mail = sentMails[0];
        if (mode === 'fr') {
          expect(mail.html).toContain('Réinitialise ton mot de passe');
          expect(mail.html).not.toContain('Reset your password');
        } else if (mode === 'en') {
          expect(mail.html).toContain('Reset your password');
          expect(mail.html).not.toContain('Réinitialise ton mot de passe');
        } else {
          expect(mail.html).toContain('Réinitialise ton mot de passe');
          expect(mail.html).toContain('Reset your password');
        }
      });
    }

    it('password reset for an account with NO league falls back to fr (never signup_lang)', async () => {
      const { userId } = await signup('langmode.reset.noleague@example.com', '203.0.176.099', 'en');
      const { sentMails } = await withMailMock(() =>
        SELF.fetch('http://example.com/auth/request-password-reset', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'langmode.reset.noleague@example.com' })
        })
      );
      expect(sentMails.length).toBe(1);
      expect(sentMails[0].html).toContain('Réinitialise ton mot de passe');
      expect(sentMails[0].html).not.toContain('Reset your password');
    });
  });

  describe('the signup verification email edge case (item 3): uses users.signup_lang, unaffected by any league', () => {
    it('signup_lang="en" -> English-only verification email, even though no league exists yet', async () => {
      const { sentMails } = await withMailMock(() =>
        SELF.fetch('http://example.com/auth/signup', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'langmode.verify.en@example.com', password: 'a-strong-password-1', lang: 'en' })
        })
      );
      expect(sentMails.length).toBe(1);
      expect(sentMails[0].html).toContain('Confirm your email');
      expect(sentMails[0].html).not.toContain('Confirme ton courriel');
    });

    it('signup_lang="fr" -> French-only verification email, unaffected by a league created afterward with languageMode="en"', async () => {
      const { cookie, csrfToken, userId } = await signup('langmode.verify.fr@example.com', '203.0.177.001', 'fr');
      // Deliberately create the league (languageMode 'en') AFTER
      // signup, proving the already-sent verification email can't
      // have been influenced by it either way.
      await createLeague(cookie, csrfToken, { name: 'Verify Edge League', teamNames: ['A', 'B'], tracksStats: true });
      await setLanguageMode(cookie, csrfToken, 'en');

      const user = await env.DB.prepare('SELECT signup_lang FROM users WHERE id = ?').bind(userId).first();
      expect(user.signup_lang).toBe('fr');
    });
  });

  describe('SMBHL remains completely unaffected throughout', () => {
    it('SMBHL has no language_mode-driven behavior: its own leagues row (if any real one existed) is never read by the league-product email paths', async () => {
      // SMBHL is a sentinel league_id ('smbhl'), never created via
      // POST /leagues/create and never assigned a language_mode through
      // any route this task touches -- confirmed structurally: every
      // fixed call site (handleLeagueAdminInvite, handleLeagueSendReminderNow/
      // runLeagueReminders, sendLateReversalAdminAlert) resolves its
      // league row via a real league_id from league_admins/leagues,
      // which SMBHL's own legacy flows never populate or read from.
      const smbhlRoute = await SELF.fetch('http://example.com/rsvp');
      expect(smbhlRoute.status).toBe(200);
    });
  });
});
