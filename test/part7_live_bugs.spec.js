// Six bugs found via live testing on notreligue.ca after the design
// system task, fixed here. One describe block per bug, each proving
// the fix rather than just the absence of a crash.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { ERROR_I18N } from '../src/error_i18n.js';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part7-live-bugs-secret';
const RSVP_SECRET = 'test-part7-live-bugs-rsvp-secret';

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
  return SELF.fetch('http://example.com/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ email, password: 'a-strong-password-1' })
  });
}
async function signupAndCreateLeague(email, ip, name, teamNames) {
  const signupRes = await signup(email, ip);
  const cookie = extractCookie(signupRes);
  const csrfToken = extractCsrfToken(signupRes);
  const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ name, teamNames, tracksStats: true })
  });
  const leagueId = (await leagueRes.json()).league.id;
  return { cookie, csrfToken, leagueId, verification: (await signupRes.clone().json().catch(() => ({}))) };
}

describe('Bug 1: GET /auth/verify shows a real styled page to a browser, JSON to everyone else', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a real browser navigation (Accept: text/html) gets a real styled confirmation page, not JSON', async () => {
    const signupRes = await signup('bug1.verify@example.com', '203.0.113.901');
    const { verification } = await signupRes.json();

    const res = await SELF.fetch(`http://example.com/auth/verify?token=${encodeURIComponent(verification.token)}`, {
      headers: { accept: 'text/html,application/xhtml+xml' }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Archivo');
    expect(html).toContain('nl-btn');
    expect(html).toContain('Courriel confirmé');
    expect(html).toContain('Email confirmed');
  });

  it('an invalid token with Accept: text/html still gets a real styled page, not raw JSON', async () => {
    const res = await SELF.fetch('http://example.com/auth/verify?token=not-a-real-token', {
      headers: { accept: 'text/html,application/xhtml+xml' }
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Archivo');
    expect(html).toContain(ERROR_I18N.LINK_MALFORMED.fr);
  });

  it('a bare fetch with no Accept header (every existing programmatic caller) still gets JSON, unchanged', async () => {
    const signupRes = await signup('bug1.verify.json@example.com', '203.0.113.902');
    const { verification } = await signupRes.json();
    const res = await SELF.fetch(`http://example.com/auth/verify?token=${encodeURIComponent(verification.token)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});

// Bug 2 (superseded by the live-testing task, Part 6): the done
// screen's PRIMARY button now targets /dashboard ("Lancer ma
// saison"/"Start my season") instead of /league/roster -- the
// corrected dependency order (the dashboard's own checklist) is
// league -> season -> real roster/event use, so starting the season is
// the real next step, not adding players.
// B3 bug fix (i18n/onboarding polish task): "Add my players" removed
// outright, not just kept as a secondary action -- a season has to
// exist before adding players is meaningful, so it was never really a
// second real option here. See
// test/part41_signup_done_starts_season.spec.js for the full coverage.
describe('signup done screen: primary action starts the season (live-testing task, Part 6)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the done screen\'s primary button targets /dashboard; "add players" is gone, not just secondary', async () => {
    const { cookie } = await signupAndCreateLeague('bug2.addplayers@example.com', '203.0.113.903', 'Bug 2 League', ['A', 'B']);
    const res = await SELF.fetch('http://example.com/signup?step=done', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain("onclick=\"location.href='/dashboard'\"");
    expect(html).not.toContain("onclick=\"location.href='/league/roster'\"");
  });
});

describe('Bug 3: blank team-name fields fall back to their own placeholder, matching "names are optional"', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it("step 3's client script falls back to the placeholder text instead of dropping blank fields", async () => {
    const { cookie } = await signupAndCreateLeague('bug3.blank@example.com', '203.0.113.904', 'Bug 3 League', ['A', 'B']);
    const res = await SELF.fetch('http://example.com/signup?step=3', { headers: { cookie } });
    const html = await res.text();
    // The fixed fallback -- a blank field's own placeholder becomes the
    // real submitted name -- not the old .filter(Boolean) that silently
    // dropped blank rows below the server's 2-name minimum.
    expect(html).toContain('v || (dict.teamPlaceholder + (idx + 1))');
    expect(html).not.toContain(".filter(Boolean)");
  });

  it('submitting the literal placeholder-fallback names (what an all-blank step 3 now actually sends) succeeds', async () => {
    const { cookie, csrfToken } = await signupAndCreateLeague('bug3.submit@example.com', '203.0.113.905', 'Bug 3 Submit League', ['A', 'B']);
    const res = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Bug 3 Real League', teamNames: ['Équipe 1', 'Équipe 2', 'Équipe 3', 'Équipe 4'], tracksStats: true })
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.league.teamNames).toEqual(['Équipe 1', 'Équipe 2', 'Équipe 3', 'Équipe 4']);
  });
});

describe('Bug 4: /league/schedule hides the create-match form until a season exists', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('no season yet: shows the "start your season" prompt, not the create-match form', async () => {
    const { cookie } = await signupAndCreateLeague('bug4.noseason@example.com', '203.0.113.906', 'Bug 4 League', ['A', 'B']);
    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('sc-needs-season');
    expect(html).toContain("Lance ta saison d'abord");
    expect(html).toContain('href="/dashboard"');
    expect(html).not.toContain('id="e_submit"');
    expect(html).not.toContain('id="sc_panel"');
  });

  it('once a season exists, the create-match form is back and the prompt is gone', async () => {
    const { cookie, csrfToken } = await signupAndCreateLeague('bug4.hasseason@example.com', '203.0.113.907', 'Bug 4 Season League', ['A', 'B']);
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Bug 4 Season' })
    });
    const res = await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('id="e_submit"');
    expect(html).toContain('id="sc_panel"');
    expect(html).not.toContain('<section class="nl-card sc-needs-season">');
  });

  it('the raw "season is required" backend error is no longer reachable through this page\'s own form, and its translation is no longer raw API jargon', () => {
    expect(ERROR_I18N.SEASON_REQUIRED.fr).not.toContain('/league/season/publish');
    expect(ERROR_I18N.SEASON_REQUIRED.en).not.toContain('/league/season/publish');
  });
});

describe('Bug 5: dashboard onboarding checklist reflects the real dependency order (season before players)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('"Créer la saison" appears before "Ajouter les joueurs" in the checklist markup', async () => {
    const { cookie } = await signupAndCreateLeague('bug5.order@example.com', '203.0.113.908', 'Bug 5 League', ['A', 'B']);
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    const seasonIdx = html.indexOf('ckSeason');
    const playersIdx = html.indexOf('ckPlayers');
    expect(seasonIdx).toBeGreaterThan(-1);
    expect(playersIdx).toBeGreaterThan(-1);
    expect(seasonIdx).toBeLessThan(playersIdx);
  });
});

describe('Bug 6: sweep -- raw backend errors now resolve through ERROR_I18N on every session-gated route checked', () => {
  let cookie, csrfToken, leagueId, eventId, playerId, playerSalt;

  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    env.RSVP_SECRET = RSVP_SECRET;
    await applyRealSchema(env);

    const league = await signupAndCreateLeague('bug6.sweep@example.com', '203.0.113.909', 'Bug 6 League', ['A', 'B']);
    cookie = league.cookie; csrfToken = league.csrfToken; leagueId = league.leagueId;
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'Bug 6 Season' })
    });
    const contactRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Bug 6 Player', team: 'A' })
    });
    playerId = (await contactRes.json()).contact.player_id;
    playerSalt = (await env.DB.prepare('SELECT token_salt FROM contacts WHERE player_id = ?').bind(playerId).first()).token_salt;
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-03-03' })
    });
    eventId = (await eventRes.json()).event.id;
  });

  it('POST /league/rsvp on a locked event now returns real JSON with a translatable errorKey, not raw "locked" text', async () => {
    await env.DB.prepare(`UPDATE events SET state = 'closed' WHERE id = ?`).bind(eventId).run();
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(RSVP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`lr:${leagueId}:${eventId}:${playerId}:${playerSalt}`));
    const token = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in' })
    });
    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/json');
    const json = await res.json();
    expect(json.errorKey).toBe('RSVP_LOCKED');
    expect(ERROR_I18N.RSVP_LOCKED).toBeUndefined(); // page-local dict, not the shared one -- see leagueRsvpPost's own comment
    await env.DB.prepare(`UPDATE events SET state = 'open' WHERE id = ?`).bind(eventId).run();
  });

  it("the RSVP page's own error dict (RV_I18N) has a real translation wired to that errorKey, and the page's click handler resolves through it", async () => {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(RSVP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`lr:${leagueId}:${eventId}:${playerId}:${playerSalt}`));
    const token = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
    const res = await SELF.fetch(`http://example.com/league/rsvp?league=${encodeURIComponent(leagueId)}&e=${encodeURIComponent(eventId)}&p=${encodeURIComponent(playerId)}&t=${token}`);
    const html = await res.text();
    expect(html).toContain('RV_ERR_KEY_MAP');
    expect(html).toContain('RSVP_LOCKED');
    expect(html).toContain("Cet événement n'accepte plus de réponses.");
    expect(html).not.toContain('throw new Error(await res.text())'); // the old raw-body-as-error-message pattern is gone
  });

  it('the admin IN/OUT override on a locked event now carries a real errorKey (EVENT_LOCKED), not raw English', async () => {
    await env.DB.prepare(`UPDATE events SET state = 'closed' WHERE id = ?`).bind(eventId).run();
    const res = await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: playerId, status: 'in' })
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.errorKey).toBe('EVENT_LOCKED');
    expect(ERROR_I18N.EVENT_LOCKED.fr).toBeTruthy();
    expect(ERROR_I18N.EVENT_LOCKED.en).toBeTruthy();
    await env.DB.prepare(`UPDATE events SET state = 'open' WHERE id = ?`).bind(eventId).run();
  });

  it('inviting subs for an unknown team now carries a real errorKey (TEAM_UNKNOWN)', async () => {
    const res = await SELF.fetch('http://example.com/league/events/invite-subs', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, team: 'Not A Real Team', need: 'skater' })
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorKey).toBe('TEAM_UNKNOWN');
    expect(ERROR_I18N.TEAM_UNKNOWN.fr).toBeTruthy();
  });

  it('adding a player with an invalid email on the roster page now carries a real errorKey (INVALID_EMAIL)', async () => {
    const res = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Bad Email Player', email: 'not-an-email' })
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorKey).toBe('INVALID_EMAIL');
  });

  it('inviting a co-admin with an invalid email now carries a real errorKey (INVALID_EMAIL)', async () => {
    const res = await SELF.fetch('http://example.com/league/admins/invite', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ email: 'also-not-an-email' })
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.errorKey).toBe('INVALID_EMAIL');
  });
});

describe('F1 (players/reminders polish task): new leagues start with automated reminders OFF, with a checklist nudge to turn them on', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('a freshly created league has all three reminder columns at 0 in the DB, not the schema default of 1', async () => {
    const { leagueId } = await signupAndCreateLeague('f1.offbydefault@example.com', '203.0.113.951', 'F1 Off By Default League', ['A', 'B']);
    const row = await env.DB.prepare('SELECT reminder_72h_enabled, reminder_24h_enabled, reminder_12h_enabled FROM leagues WHERE id = ?').bind(leagueId).first();
    expect(row.reminder_72h_enabled).toBe(0);
    expect(row.reminder_24h_enabled).toBe(0);
    expect(row.reminder_12h_enabled).toBe(0);
  });

  it('the Getting Started checklist shows a not-done "turn on reminders" row before any reminder is enabled', async () => {
    const { cookie } = await signupAndCreateLeague('f1.checklistoff@example.com', '203.0.113.952', 'F1 Checklist Off League', ['A', 'B']);
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('data-i18n="ckReminders"');
    expect(html).toContain('href="/league/settings#reminders-section"');
    const anchorIdx = html.indexOf('data-i18n="ckReminders"');
    const rowStart = html.lastIndexOf('<div class="dash-ck', anchorIdx);
    expect(html.slice(rowStart, anchorIdx)).not.toContain('dash-ck done');
  });

  it('the checklist row flips to done once any one reminder is turned on, and the settings page reminders section is anchorable', async () => {
    const { cookie, csrfToken } = await signupAndCreateLeague('f1.checklistone@example.com', '203.0.113.953', 'F1 Checklist One League', ['A', 'B']);
    const settingsHtml = await (await SELF.fetch('http://example.com/league/settings', { headers: { cookie } })).text();
    expect(settingsHtml).toContain('id="reminders-section"');

    await SELF.fetch('http://example.com/league/reminders/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ reminder72h: true })
    });
    const res = await SELF.fetch('http://example.com/dashboard', { headers: { cookie } });
    const html = await res.text();
    expect(html).toContain('data-i18n="ckReminders"');
    const anchorIdx = html.indexOf('data-i18n="ckReminders"');
    const rowStart = html.lastIndexOf('<div class="dash-ck', anchorIdx);
    expect(html.slice(rowStart, anchorIdx)).toContain('dash-ck done');
  });
});
