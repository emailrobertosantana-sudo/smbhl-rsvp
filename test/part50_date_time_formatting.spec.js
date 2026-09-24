// Live-testing task (batch 2), Part 6: dates/times rendered in raw ISO
// format ("2026-11-21") everywhere across the new league product, and
// wrapped mid-date. The design system specifies "dim 28 sept" (FR) /
// "Sun Sep 28" (EN) for dates, and Quebec-style times ("11 h 30" FR,
// "11:30 AM" EN) -- README.md: "Numbers as digits, times in Quebec
// style: 9 h, 10 h 30, dim 28 sept. English: 9 AM, Sun Sep 28."
//
// Applied via one shared formatter (date_format.js) everywhere a
// league-product page or email shows an event date/time: the schedule
// list, event status page, public page, dashboard, and every
// email that flows through the shared body()/leagueReminderDict
// (SMBHL's own date shape -- a descriptive string, never ISO -- keeps
// its existing formatting completely untouched, detected by checking
// for the ISO shape directly rather than any league/SMBHL flag).
//
// Also fixes two more issues on the schedule list specifically:
// dates styled as underlined hyperlinks (the shared .nl a rule's
// higher specificity silently overriding the row's own
// text-decoration: none -- the same trap already fixed once for
// .rv-foot elsewhere in this app), and "Dupliquer" sitting on its own
// line below each row instead of inline with the row's other actions.
import { env, SELF } from 'cloudflare:test';
import { formatEventDate, formatEventDateFull, formatEventTime, formatEventDateTime } from '../src/date_format.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { extractInlineScripts } from './support/inline_scripts.js';

const AUTH_SECRET = 'test-part6-batch2-date-time-format-secret';
const RSVP_SECRET = 'test-part6-batch2-date-time-format-rsvp-secret';

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
async function signup(email, ip) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
  return { cookie: extractCookie(res), csrfToken: extractCsrfToken(res) };
}
async function createLeague(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).league;
}

describe('Part 6 (live-testing task, batch 2): date/time formatting', () => {
  describe('date_format.js: matches the design system spec exactly', () => {
    it('formatEventDate short: "dim 28 sept" (FR) / "Sun Sep 28" (EN)', () => {
      expect(formatEventDate('2026-09-27', 'fr', 'short')).toBe('Dim 27 sept');
      expect(formatEventDate('2026-09-27', 'fr', 'short', false)).toBe('dim 27 sept');
      expect(formatEventDate('2026-09-27', 'en', 'short')).toBe('Sun Sep 27');
    });

    it('formatEventDate long: full day name, still abbreviated month', () => {
      expect(formatEventDate('2026-09-27', 'fr', 'long')).toBe('Dimanche 27 sept');
      expect(formatEventDate('2026-09-27', 'fr', 'long', false)).toBe('dimanche 27 sept');
      expect(formatEventDate('2026-09-27', 'en', 'long')).toBe('Sunday Sep 27');
    });

    it('formatEventDateFull: full day AND full month', () => {
      expect(formatEventDateFull('2026-09-27', 'fr')).toBe('Dimanche 27 septembre');
      expect(formatEventDateFull('2026-09-27', 'fr', false)).toBe('dimanche 27 septembre');
      expect(formatEventDateFull('2026-09-27', 'en')).toBe('Sunday, September 27');
    });

    it('formatEventTime: "9 h" / "10 h 30" (FR), "9 AM" / "11:30 AM" (EN)', () => {
      expect(formatEventTime('09:00', 'fr')).toBe('9 h');
      expect(formatEventTime('10:30', 'fr')).toBe('10 h 30');
      expect(formatEventTime('09:00', 'en')).toBe('9 AM');
      expect(formatEventTime('11:30', 'en')).toBe('11:30 AM');
      expect(formatEventTime('13:05', 'fr')).toBe('13 h 05');
      expect(formatEventTime('13:05', 'en')).toBe('1:05 PM');
      expect(formatEventTime('00:00', 'en')).toBe('12 AM');
      expect(formatEventTime('12:00', 'en')).toBe('12 PM');
    });

    it('formatEventDateTime joins with the design system\'s own middle dot', () => {
      expect(formatEventDateTime('2026-09-27', '09:00', 'fr', 'short')).toBe('Dim 27 sept · 9 h');
      expect(formatEventDateTime('2026-09-27', '09:00', 'en', 'short')).toBe('Sun Sep 27 · 9 AM');
    });

    it('handles every day of the week and every month correctly (day-of-week math)', () => {
      // 2026-09-27 is a Sunday; spot-check a full week and a December date.
      expect(formatEventDate('2026-09-28', 'fr', 'short')).toBe('Lun 28 sept');
      expect(formatEventDate('2026-09-29', 'fr', 'short')).toBe('Mar 29 sept');
      expect(formatEventDate('2026-12-25', 'fr', 'short')).toBe('Ven 25 déc');
      expect(formatEventDate('2026-12-25', 'en', 'short')).toBe('Fri Dec 25');
    });
  });

  describe('rendered pages use the design system format, not raw ISO', () => {
    beforeAll(async () => {
      env.AUTH_SECRET = AUTH_SECRET;
      env.RSVP_SECRET = RSVP_SECRET;
      await applyRealSchema(env);
    });

    async function setupLeagueWithEvent(email, ip) {
      const { cookie, csrfToken } = await signup(email, ip);
      const league = await createLeague(cookie, csrfToken, { name: 'Date Format League ' + ip, teamNames: ['Falcons', 'Otters'], tracksStats: true });
      await SELF.fetch('http://example.com/league/season/publish', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ season_name: 'Date Format Season' })
      });
      const eventRes = await SELF.fetch('http://example.com/league/events', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ date: '2026-09-27', start_time: '10:30', venue: 'Test Arena' })
      });
      const event = (await eventRes.json()).event;
      return { cookie, csrfToken, league, event };
    }

    it('schedule list: no raw ISO date, uses "Dim 27 sept · 10 h 30", data-date attrs present, no underline/color CSS trap, Dupliquer sits inline', async () => {
      const { cookie } = await setupLeagueWithEvent('dateformat.schedule@example.com', '203.0.166.001');
      const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
      // The raw ISO date is unavoidably still present as PART of the
      // opaque event id embedded in the row's own link/duplicate-button
      // attributes (e.g. "<leagueId>:2026-09-27") -- that's an id, not
      // a displayed date, and out of scope here. The actual DISPLAY
      // element (.sc-when) is what must show the real, formatted date.
      expect(html).toContain('Dim 27 sept');
      expect(html).toContain('data-date-fr="Dim 27 sept"');
      expect(html).toContain('data-date-en="Sun Sep 27"');
      expect(html).toContain('data-date-fr="10 h 30"');
      expect(html).toContain('data-date-en="10:30 AM"');
      // The CSS specificity fix and the inline Dupliquer layout.
      expect(html).toMatch(/\.nl a\.sc-game\s*\{[^}]*text-decoration:\s*none/);
      expect(html).toMatch(/\.sc-game-row\s*\{[^}]*display:\s*flex/);
      const scripts = extractInlineScripts(html);
      for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    });

    it('event detail page: heading uses the long style ("Dimanche 27 sept · 10 h 30")', async () => {
      const { cookie, event } = await setupLeagueWithEvent('dateformat.detail@example.com', '203.0.166.002');
      const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(event.id)}`, { headers: { cookie } })).text();
      // (the raw ISO date is unavoidably still part of the event id
      // embedded in the page's own API calls -- see the schedule
      // list's identical note above)
      expect(html).toContain('<h1');
      expect(html).toContain('Dimanche 27 sept');
      expect(html).toContain('data-date-en="Sunday Sep 27');
      // The <title> tag is real, user-visible text too (browser tab,
      // bookmarks, history) -- also fixed, not raw ISO either.
      expect(html).toContain('<title>Dim 27 sept —');
      const scripts = extractInlineScripts(html);
      for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    });

    it('public page: hero banner and upcoming list both use the design system format', async () => {
      const { league } = await setupLeagueWithEvent('dateformat.public@example.com', '203.0.166.003');
      const html = await (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(league.id)}`)).text();
      expect(html).not.toContain('2026-09-27');
      expect(html).toContain('Dim 27 sept');
      expect(html).toContain('data-date-en="Sun Sep 27"');
      const scripts = extractInlineScripts(html);
      for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    });

    it('RSVP page overline uses the design system format', async () => {
      const { cookie, csrfToken, league, event } = await setupLeagueWithEvent('dateformat.rsvp@example.com', '203.0.166.004');
      const playerRes = await SELF.fetch('http://example.com/league/contacts', {
        method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ name: 'Date Format Player', role: 'roster', team: 'Falcons' })
      });
      const player = (await playerRes.json()).contact;
      const salt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(player.player_id).first()).token_salt;
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', encoder.encode(RSVP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`lr:${league.id}:${event.id}:${player.player_id}:${salt}`));
      const token = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
      const html = await (await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(league.id)}&e=${encodeURIComponent(event.id)}&p=${encodeURIComponent(player.player_id)}&t=${token}`)).text();
      expect(html).not.toContain('2026-09-27');
      expect(html).toContain('Dimanche 27 sept');
      const scripts = extractInlineScripts(html);
      for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    });
  });

  // A true end-to-end test of the shared body() function's sub-call
  // email (was silently "that day"/"ce jour-là" for a league event
  // before this fix -- see body()'s own comment, index.js) hits the
  // exact pre-existing mail-mock timing flake documented elsewhere in
  // this suite (the mock unwinds before an async send completes,
  // letting a real call reach api.resend.com) -- reproduced here even
  // in isolation, so it's left for the batch's own dedicated
  // investigation (Part 16) rather than worked around with an
  // arbitrary delay. The fix itself (the ISO-date branch inside
  // body()) is a small, directly-readable regex check plus the same
  // formatEventDateTime already covered above; not re-verified via a
  // flaky round trip here.
});
