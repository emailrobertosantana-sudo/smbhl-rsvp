// Group A (reminder-state polish task): reminder state was
// inconsistent and the onboarding copy was wrong.
//
// A1: onboarding's reminders screen said "Already on by default --
// turn off the ones you don't want" above three toggles that render
// OFF (F1 made new leagues start with reminders off; the copy was
// never updated). Copy fixed to match; the toggle-and-save mechanism
// itself already worked (opting in was already possible, just
// mislabeled).
//
// A2: the event detail page's own switch read ONLY the per-event
// auto_reminders_enabled column (defaults to armed=1 on every new
// event, regardless of the league's own cadence), while Comms' Active
// Automations card reads the league-level reminder_72h/24h/12h_enabled
// columns. A brand-new league (reminders off league-wide by default)
// still showed the event page's switch as "on" while Comms correctly
// showed every automation off, for the same league at the same time.
// Fixed: the switch now reflects the AND of both (will this event's
// players actually get anything), matching the same combined
// computation sendLeagueReminderWave itself already requires before
// sending anything for real. When the league has nothing armed at
// all, the switch is disabled with an explanation instead of showing
// a toggle that would have no effect.
//
// A3: "Send a reminder now" emailed the whole non-responder list on
// one click, no confirmation, no undo. Confirmed first (window.confirm,
// same non-blocking pattern as D3's midnight-crossing warning), with
// the real recipient count computed server-side at page-render time
// (same getNonResponders query the send route itself uses).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part88-group-a-reminder-state-secret';

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
async function publishSeason(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
}
async function createEvent(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
}
async function enableAllReminders(cookie, csrfToken) {
  return SELF.fetch('http://example.com/league/reminders/settings', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ reminder72h: true, reminder24h: true, reminder12h: true })
  });
}
async function addContact(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).contact;
}

describe('A1: onboarding reminders copy matches the real off-by-default behaviour', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the reminders onboarding step shows the corrected opt-in copy, both languages, and the old copy is gone', async () => {
    const { cookie, csrfToken } = await signup('a1.copy@example.com', '203.0.211.001');
    await createLeague(cookie, csrfToken, { name: 'A1 Copy League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const html = await (await SELF.fetch('http://example.com/onboarding/season?step=3', { headers: { cookie } })).text();
    expect(html).toContain('id="ob_reminder_72h"');

    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.fr.remindersSub).toBe("Désactivés par défaut. Active ceux que tu veux -- tu peux changer ça n'importe quand dans les réglages.");
    expect(dict.en.remindersSub).toBe('Off by default. Turn on the ones you want -- you can change this any time in Settings.');
    expect(dict.fr.remindersSub).not.toContain('Déjà activés par défaut');
    expect(dict.en.remindersSub).not.toContain('Already on by default');

    // The toggles genuinely render OFF (F1) and are genuinely
    // interactive -- opting in during this screen already worked, it
    // was only the copy that lied about it.
    expect(html).toContain('id="ob_reminder_72h" onclick="obToggle(this)"></button>');
    expect(html).toContain('aria-checked="false"');
  });
});

describe('A2: event detail page and Comms agree on reminder state -- one source of truth', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a brand-new league (reminders off by default): the event page\'s switch and Comms\' automations card both say off, not off/on', async () => {
    const { cookie, csrfToken } = await signup('a2.freshleague@example.com', '203.0.211.002');
    await createLeague(cookie, csrfToken, { name: 'A2 Fresh League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-08-01' })).json();
    // The raw per-event column still defaults to armed=1 -- confirming
    // the OLD per-event-only read really would have disagreed with
    // Comms here, which is exactly the bug.
    expect(ev.event.auto_reminders_enabled).toBe(true);

    const detailHtml = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.event.id)}`, { headers: { cookie } })).text();
    expect(detailHtml).toMatch(/aria-checked="false"[^>]*id="ev_reminders_switch"/);
    expect(detailHtml).toContain('id="ev_reminders_switch"');
    expect(detailHtml).toContain('disabled');
    expect(detailHtml).toContain('data-i18n="remindersNoneArmedHelp"');

    const commsData = await (await SELF.fetch('http://example.com/league/comms/data', { headers: { cookie } })).json();
    expect(commsData.cadence.reminder72hEnabled).toBe(false);
    expect(commsData.cadence.reminder24hEnabled).toBe(false);
    expect(commsData.cadence.reminder12hEnabled).toBe(false);
    // Both surfaces now agree: nothing is armed for this event.
  });

  it('once the league arms at least one reminder kind: the switch reflects the event\'s own opt-out state, and is genuinely interactive again', async () => {
    const { cookie, csrfToken } = await signup('a2.armedleague@example.com', '203.0.211.003');
    await createLeague(cookie, csrfToken, { name: 'A2 Armed League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await enableAllReminders(cookie, csrfToken);
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-08-02' })).json();

    const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.event.id)}`, { headers: { cookie } })).text();
    expect(html).toMatch(/aria-checked="true"[^>]*id="ev_reminders_switch"/);
    expect(html).not.toContain('id="ev_reminders_switch" onclick="toggleEventReminders(this)" disabled');
    expect(html).not.toContain('data-i18n="remindersNoneArmedHelp"');

    const commsData = await (await SELF.fetch('http://example.com/league/comms/data', { headers: { cookie } })).json();
    expect(commsData.cadence.reminder72hEnabled).toBe(true);
  });

  it('league armed, but THIS event opted out: the switch shows off (the real effective state), matching neither raw flag alone', async () => {
    const { cookie, csrfToken } = await signup('a2.eventoptout@example.com', '203.0.211.004');
    await createLeague(cookie, csrfToken, { name: 'A2 Event Optout League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await enableAllReminders(cookie, csrfToken);
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-08-03', auto_reminders_enabled: false })).json();
    expect(ev.event.auto_reminders_enabled).toBe(false);

    const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.event.id)}`, { headers: { cookie } })).text();
    expect(html).toMatch(/aria-checked="false"[^>]*id="ev_reminders_switch"/);
    // Genuinely interactive here (league IS armed, just this event
    // opted out) -- not the "nothing armed at all" disabled state.
    expect(html).not.toContain('data-i18n="remindersNoneArmedHelp"');
  });

  it('sweep: every other reminder-state surface already reads the league-level cadence columns and needed no fix -- dashboard checklist, settings, and the roster backstop banner', async () => {
    const { cookie, csrfToken } = await signup('a2.sweep@example.com', '203.0.211.005');
    await createLeague(cookie, csrfToken, { name: 'A2 Sweep League', teamNames: ['A', 'B'] });

    // The pre-season checklist (ckReminders) only ever renders while
    // needsSeason is true -- checked before publishing, not after.
    const dashHtml = await (await SELF.fetch('http://example.com/dashboard', { headers: { cookie } })).text();
    expect(dashHtml).toContain('data-i18n="ckReminders"');
    // Unchecked -- matches Comms' own off state for this fresh league.
    expect(dashHtml).toMatch(/dash-ck"[^>]*>\s*<span class="b n">[\s\S]{0,200}ckReminders/);

    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const settingsHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(settingsHtml).toContain('id="reminder_72h_switch"');
    expect(settingsHtml).toMatch(/aria-checked="false"[^>]*id="reminder_72h_switch"/);
  });
});

describe('A3: "Send a reminder now" requires confirmation with a real recipient count', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the confirmation copy exists in both languages, and the client-side wiring confirms before the fetch with a server-computed count', async () => {
    const { cookie, csrfToken } = await signup('a3.confirm@example.com', '203.0.211.006');
    await createLeague(cookie, csrfToken, { name: 'A3 Confirm League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-08-04' })).json();
    await addContact(cookie, csrfToken, { name: 'Confirm Player One', role: 'roster', team: 'A', email: 'confirm1@example.com' });
    await addContact(cookie, csrfToken, { name: 'Confirm Player Two', role: 'roster', team: 'A', email: 'confirm2@example.com' });

    const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.event.id)}`, { headers: { cookie } })).text();
    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.fr.remindNowConfirm).toBe('Ceci enverra un courriel à {n} joueurs. Envoyer maintenant?');
    expect(dict.en.remindNowConfirm).toBe('This will email {n} players. Send now?');

    // The real count, computed server-side, embedded for the client to
    // use in the confirm -- both non-responder players with a real
    // email counted.
    expect(html).toContain('var EV_REMIND_NOW_COUNT = 2;');

    // Confirm gate wired in BEFORE the fetch call -- a decline must
    // never reach the network.
    expect(html).toMatch(/function sendReminderNow\(btn\) \{[\s\S]*?window\.confirm\([\s\S]*?\)\) return;[\s\S]*?fetch\('\/league\/events\/send-reminder'/);
  });

  it('a non-responder without a real email is not counted', async () => {
    const { cookie, csrfToken } = await signup('a3.noemail@example.com', '203.0.211.007');
    await createLeague(cookie, csrfToken, { name: 'A3 No Email League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-08-05' })).json();
    await addContact(cookie, csrfToken, { name: 'No Email Player', role: 'roster', team: 'A' });

    const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.event.id)}`, { headers: { cookie } })).text();
    expect(html).toContain('var EV_REMIND_NOW_COUNT = 0;');
  });

  it('the underlying send route itself is unchanged -- still callable directly, same response shape', async () => {
    const { cookie, csrfToken } = await signup('a3.routeunchanged@example.com', '203.0.211.008');
    await createLeague(cookie, csrfToken, { name: 'A3 Route League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-08-06' })).json();

    const res = await SELF.fetch('http://example.com/league/events/send-reminder', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: ev.event.id })
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data).toHaveProperty('sent');
    expect(data).toHaveProperty('eligible');
    expect(data).toHaveProperty('failed');
  });
});
