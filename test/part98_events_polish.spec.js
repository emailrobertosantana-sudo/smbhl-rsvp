// Events polish (Group C): delete + cancel (C1), create buttons that
// scroll/focus (C2), a free-text venue's own optional address/map
// link (C3), the bulk reminder warning's real plural wording (C4/C5),
// and the midnight-crossing warning on the bulk form (C6).
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part98-events-polish-secret';

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
  const res = await SELF.fetch('http://example.com/league/season/publish', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return res.json();
}
async function createEvent(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function bulkCreateEvents(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/events/bulk', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}
async function cancelEvent(cookie, csrfToken, eventId) {
  const res = await SELF.fetch('http://example.com/league/events/cancel', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId })
  });
  return { status: res.status, json: await res.json() };
}
async function deleteEvent(cookie, csrfToken, eventId, confirm) {
  const res = await SELF.fetch('http://example.com/league/events/delete', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, confirm })
  });
  return { status: res.status, json: await res.json() };
}
async function setRsvp(cookie, csrfToken, eventId, playerId, status) {
  const res = await SELF.fetch('http://example.com/league/rsvp/admin', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ event_id: eventId, player_id: playerId, status })
  });
  return res.json();
}
async function addContact(cookie, csrfToken, body) {
  const res = await SELF.fetch('http://example.com/league/contacts', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify(body)
  });
  return (await res.json()).contact;
}
async function scheduleHtml(cookie) {
  return (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
}
async function publicPageHtml(leagueId) {
  return (await SELF.fetch(`http://example.com/league/public?league=${encodeURIComponent(leagueId)}`)).text();
}
async function enableReminders(cookie, csrfToken) {
  const res = await SELF.fetch('http://example.com/league/reminders/settings', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ reminder72h: true })
  });
  return res.json();
}

describe('Events polish, C1: delete and cancel', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('deleting an event with no RSVPs needs no confirmation and removes it', async () => {
    const { cookie, csrfToken } = await signup('c1.deletenone@example.com', '203.0.230.001');
    await createLeague(cookie, csrfToken, { name: 'C1 Delete None League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = (await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' })).json.event;
    const res = await deleteEvent(cookie, csrfToken, ev.id, false);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    const row = await env.DB.prepare('SELECT id FROM events WHERE id = ?').bind(ev.id).first();
    expect(row).toBeNull();
  });

  it('deleting an event WITH real RSVPs is rejected first, reporting the real count -- only proceeds once confirm: true is sent', async () => {
    const { cookie, csrfToken } = await signup('c1.deleterecvps@example.com', '203.0.230.002');
    await createLeague(cookie, csrfToken, { name: 'C1 Delete RSVPs League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = (await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' })).json.event;
    const p1 = await addContact(cookie, csrfToken, { name: 'RSVP Player One', role: 'roster' });
    const p2 = await addContact(cookie, csrfToken, { name: 'RSVP Player Two', role: 'roster' });
    await setRsvp(cookie, csrfToken, ev.id, p1.player_id, 'in');
    await setRsvp(cookie, csrfToken, ev.id, p2.player_id, 'out');

    const rejected = await deleteEvent(cookie, csrfToken, ev.id, false);
    expect(rejected.status).toBe(409);
    expect(rejected.json.errorKey).toBe('EVENT_HAS_RSVPS');
    expect(rejected.json.rsvpCount).toBe(2);
    let row = await env.DB.prepare('SELECT id FROM events WHERE id = ?').bind(ev.id).first();
    expect(row).toBeTruthy(); // not deleted yet

    const confirmed = await deleteEvent(cookie, csrfToken, ev.id, true);
    expect(confirmed.status).toBe(200);
    expect(confirmed.json.rsvpCount).toBe(2);
    row = await env.DB.prepare('SELECT id FROM events WHERE id = ?').bind(ev.id).first();
    expect(row).toBeNull();
    const rsvpRows = await env.DB.prepare('SELECT player_id FROM rsvp WHERE event_id = ?').bind(ev.id).all();
    expect((rsvpRows.results || []).length).toBe(0);
  });

  it('cancelling a real game keeps it visible (never deleted), marked cancelled, with its RSVPs untouched', async () => {
    const { cookie, csrfToken } = await signup('c1.cancel@example.com', '203.0.230.003');
    await createLeague(cookie, csrfToken, { name: 'C1 Cancel League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = (await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1' })).json.event;
    const p1 = await addContact(cookie, csrfToken, { name: 'Cancel Player One', role: 'roster' });
    await setRsvp(cookie, csrfToken, ev.id, p1.player_id, 'in');

    const res = await cancelEvent(cookie, csrfToken, ev.id);
    expect(res.status).toBe(200);
    expect(res.json.event.state).toBe('cancelled');
    const row = await env.DB.prepare('SELECT state FROM events WHERE id = ?').bind(ev.id).first();
    expect(row.state).toBe('cancelled');
    const rsvpRows = await env.DB.prepare('SELECT status FROM rsvp WHERE event_id = ?').bind(ev.id).all();
    expect((rsvpRows.results || []).length).toBe(1); // still there, never lost

    // Still listed on the schedule -- "visible", per the task's own wording.
    const html = await scheduleHtml(cookie);
    expect(html).toContain(ev.id);
    expect(html).toContain('data-i18n="stateCancelled"');
  });

  it('SMBHL is protected from both routes', async () => {
    const { cookie, csrfToken } = await signup('c1.smbhl@example.com', '203.0.230.004');
    const del = await deleteEvent(cookie, csrfToken, 'smbhl:2099-01-01', false);
    expect([403, 404]).toContain(del.status);
    const cancel = await cancelEvent(cookie, csrfToken, 'smbhl:2099-01-01');
    expect([403, 404]).toContain(cancel.status);
  });
});

describe('Events polish, C2: create buttons scroll and focus', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the schedule page\'s create buttons call functions that ensure the panel is open, scrolled into view, and its first field focused', async () => {
    const { cookie, csrfToken } = await signup('c2.buttons@example.com', '203.0.230.010');
    await createLeague(cookie, csrfToken, { name: 'C2 League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const html = await scheduleHtml(cookie);
    expect(html).toContain('onclick="openSchedulePanel()"');
    expect(html).toContain('onclick="openBulkPanel()"');
    expect(html).toContain("function openCreatePanel(panelId, firstFieldId)");
    expect(html).toContain("panel.scrollIntoView({ behavior: 'smooth', block: 'start' })");
    expect(html).toContain("function openSchedulePanel() { openCreatePanel('sc_panel', 'e_date'); }");
    expect(html).toContain("function openBulkPanel() { openCreatePanel('sc_bulk_panel', 'be_start_date'); }");
  });

  it('"Add a player" also scrolls the roster panel into view, not just focuses it', async () => {
    const { cookie, csrfToken } = await signup('c2.roster@example.com', '203.0.230.011');
    await createLeague(cookie, csrfToken, { name: 'C2 Roster League', teamNames: ['A', 'B'] });
    const html = (await SELF.fetch('http://example.com/league/roster', { headers: { cookie } })).text();
    const text = await html;
    expect(text).toContain('panel.scrollIntoView({ behavior: \'smooth\', block: \'start\' })');
  });
});

describe('Events polish, C3: a free-text venue can carry its own address and map link', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('creating an event with a free-text venue plus address/map link stores and returns both', async () => {
    const { cookie, csrfToken } = await signup('c3.create@example.com', '203.0.230.020');
    const league = await createLeague(cookie, csrfToken, { name: 'C3 League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const created = await createEvent(cookie, csrfToken, {
      date: '2024-01-05', season: 'S1', venue: 'Parc Central',
      venue_address: '123 rue Principale, Ville', venue_map_link: 'https://maps.example.com/parc-central'
    });
    expect(created.status).toBe(200);
    expect(created.json.event.venue_address).toBe('123 rue Principale, Ville');
    expect(created.json.event.venue_map_link).toBe('https://maps.example.com/parc-central');

    const row = await env.DB.prepare('SELECT venue_address, venue_map_link FROM events WHERE id = ?').bind(created.json.event.id).first();
    expect(row.venue_address).toBe('123 rue Principale, Ville');
    expect(row.venue_map_link).toBe('https://maps.example.com/parc-central');

    // Rendered on the public page (past event, so it's in that list).
    const html = await publicPageHtml(league.id);
    expect(html).toContain('https://maps.example.com/parc-central');
  });

  it('a SAVED venue wins over free-text address/map-link fields, and its own map link (not the free-text one) resolves', async () => {
    const { cookie, csrfToken } = await signup('c3.savedvenue@example.com', '203.0.230.021');
    const league = await createLeague(cookie, csrfToken, { name: 'C3 Saved Venue League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const venueRes = await SELF.fetch('http://example.com/league/venues', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Saved Arena', map_link: 'https://maps.example.com/saved-arena' })
    });
    const venue = (await venueRes.json()).venue;
    const created = await createEvent(cookie, csrfToken, {
      date: '2024-01-06', season: 'S1', venue_id: venue.id,
      venue_address: 'should be ignored', venue_map_link: 'https://maps.example.com/ignored'
    });
    expect(created.status).toBe(200);
    expect(created.json.event.venue_address).toBeNull();
    expect(created.json.event.venue_map_link).toBeNull();
    const html = await publicPageHtml(league.id);
    expect(html).toContain('https://maps.example.com/saved-arena');
    expect(html).not.toContain('https://maps.example.com/ignored');
  });

  it('editing an event to add a free-text address/map-link afterward works too', async () => {
    const { cookie, csrfToken } = await signup('c3.edit@example.com', '203.0.230.022');
    await createLeague(cookie, csrfToken, { name: 'C3 Edit League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const ev = (await createEvent(cookie, csrfToken, { date: '2099-01-05', season: 'S1', venue: 'Bare Name Rink' })).json.event;
    const res = await SELF.fetch('http://example.com/league/events/update', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: ev.id, venue: 'Bare Name Rink', venue_address: '456 Ice Ave', venue_map_link: 'https://maps.example.com/bare-name-rink' })
    });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT venue_address, venue_map_link FROM events WHERE id = ?').bind(ev.id).first();
    expect(row.venue_address).toBe('456 Ice Ave');
    expect(row.venue_map_link).toBe('https://maps.example.com/bare-name-rink');
  });

  it('the create-event and bulk-create forms both render the new optional fields, no longer claiming free text can never have a map link', async () => {
    const { cookie, csrfToken } = await signup('c3.formui@example.com', '203.0.230.023');
    await createLeague(cookie, csrfToken, { name: 'C3 Form UI League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const html = await scheduleHtml(cookie);
    expect(html).toContain('id="e_venue_address"');
    expect(html).toContain('id="e_venue_map_link"');
    expect(html).toContain('id="be_venue_address"');
    expect(html).toContain('id="be_venue_map_link"');
    expect(html).not.toContain('data-i18n="freeTextNoMapLink"');
  });
});

describe('Events polish, C4/C5: the bulk reminder warning is plural-aware, and the opt-out covers the WHOLE series', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the bulk panel shows its OWN plural wording ("each of these games"/"chacun de ces matchs"), not the single-event "this game" text', async () => {
    const { cookie, csrfToken } = await signup('c4.wording@example.com', '203.0.230.030');
    await createLeague(cookie, csrfToken, { name: 'C4 Wording League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const contact = await addContact(cookie, csrfToken, { name: 'Reminder Player', role: 'roster', email: 'reminder.player@example.com' });
    expect(contact.player_id).toBeTruthy();
    const remindersRes = await enableReminders(cookie, csrfToken);
    expect(remindersRes.ok).toBe(true);

    const html = await scheduleHtml(cookie);
    expect(html).toContain('Chacun de ces matchs enverra automatiquement');
    expect(html).toContain('Each of these games will automatically send');
    expect(html).toContain('data-i18n="remindersOptOutLabelBulk"');
    expect(html).toContain('Ne pas envoyer les rappels automatiques pour ces matchs');
    expect(html).toContain("Don't send automated reminders for these games");
    // The single-event panel's own wording is untouched, still present too.
    expect(html).toContain('Ce match enverra automatiquement');
    // C5: real pluralization -- exactly 1 real email on file here.
    expect(html).toContain('1 joueur avec un courriel');
    expect(html).toContain('1 player with an email');
    expect(html).not.toContain('joueur(s)');
    expect(html).not.toContain('player(s)');
  });

  it('C5: 2+ players pluralizes correctly ("2 players", not "2 player(s)")', async () => {
    const { cookie, csrfToken } = await signup('c5.plural@example.com', '203.0.230.031');
    await createLeague(cookie, csrfToken, { name: 'C5 Plural League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await addContact(cookie, csrfToken, { name: 'Plural Player One', role: 'roster', email: 'plural1@example.com' });
    await addContact(cookie, csrfToken, { name: 'Plural Player Two', role: 'roster', email: 'plural2@example.com' });
    await enableReminders(cookie, csrfToken);
    const html = await scheduleHtml(cookie);
    expect(html).toContain('2 joueurs avec un courriel');
    expect(html).toContain('2 players with an email');
  });

  it('confirmed: the opt-out checkbox suppresses reminders for EVERY event the bulk route creates, not just the first', async () => {
    const { cookie, csrfToken } = await signup('c4.optoutall@example.com', '203.0.230.032');
    await createLeague(cookie, csrfToken, { name: 'C4 Optout League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const res = await bulkCreateEvents(cookie, csrfToken, { startDate: '2099-02-01', occurrences: 4, auto_reminders_enabled: false });
    expect(res.status).toBe(200);
    expect(res.json.createdCount).toBe(4);
    const rows = (await env.DB.prepare("SELECT auto_reminders_enabled FROM events WHERE league_id = ? ORDER BY date").bind((await env.DB.prepare('SELECT id FROM leagues WHERE name = ?').bind('C4 Optout League').first()).id).all()).results;
    expect(rows.length).toBe(4);
    for (const r of rows) expect(r.auto_reminders_enabled).toBe(0);
  });
});

describe('Events polish, C6: the midnight-crossing warning already covers the bulk form (verified, not newly added)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the bulk-create script contains its OWN midnight-crossing check, matching the single-event form\'s own logic', async () => {
    const { cookie, csrfToken } = await signup('c6.check@example.com', '203.0.230.040');
    await createLeague(cookie, csrfToken, { name: 'C6 League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const html = await scheduleHtml(cookie);
    // Present once for the single-event form, once for the bulk form --
    // both gated on the exact same end_time < start_time comparison.
    const occurrences = (html.match(/end_time < start_time/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(html).toContain('same non-blocking midnight-crossing warning');
    expect(html).toContain('as the single-event form');
  });
});
