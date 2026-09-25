// Forms polish task, Group D: three fixes to the schedule page's
// create/bulk-create/edit forms.
//
// D2: the :00/:15/:30/:45 quick-set buttons beside start time wrapped
// badly and weren't useful -- removed. Prefill from the league's own
// most recently used start time is unaffected (locked separately by
// test/league_ui_schedule.spec.js's C4/D2 describe block).
//
// D3: an end time before the start time (e.g. 10:00 start, 00:30 end)
// used to be accepted silently -- almost always a typo, but a late
// game can genuinely cross midnight, so the create/bulk-create forms
// now warn (via window.confirm) instead of blocking or staying silent.
//
// D4: once a saved venue is selected, the free-text Venue field and
// its "no map link" help line used to stay visible (and, on the edit
// form, merely disabled) alongside the now-irrelevant selection. All
// three forms (create, bulk-create, edit) now hide that field/help
// entirely while a saved venue is selected, showing it again only when
// the dropdown is back to "None".
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { extractInlineScripts, assertNoSyntaxError } from './support/inline_scripts.js';

const AUTH_SECRET = 'test-part84-schedule-form-polish-secret';

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
async function createVenue(cookie, csrfToken, body) {
  return SELF.fetch('http://example.com/league/venues', {
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

describe('D2/D3/D4 (forms polish task): schedule create/bulk/edit forms', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('D2: no quick-set time-preset buttons remain on the create form', async () => {
    const { cookie, csrfToken } = await signup('d2.presets@example.com', '203.0.200.001');
    await createLeague(cookie, csrfToken, { name: 'D2 Presets League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(html).not.toContain('sc-time-presets');
    expect(html).not.toContain('setTimePreset');
    expect(html).not.toMatch(/>:(00|15|30|45)</);
    // Prefill mechanism (value=) untouched.
    expect(html).toContain('id="e_start" type="time"');
  });

  it('D3: both languages carry the midnight-crossing warning copy, and the check is wired into both submit paths', async () => {
    const { cookie, csrfToken } = await signup('d3.copy@example.com', '203.0.200.002');
    await createLeague(cookie, csrfToken, { name: 'D3 Copy League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    const m = html.match(/var __I18N = (\{[\s\S]*?\});\n/);
    const dict = JSON.parse(m[1]);
    expect(dict.fr.crossMidnightWarning).toBe("L'heure de fin est avant l'heure de début, donc ce match se terminerait après minuit (le lendemain). Continuer quand même?");
    expect(dict.en.crossMidnightWarning).toBe('The end time is before the start time, so this game would end after midnight (the next day). Continue anyway?');
    // Wired into both the single-event and bulk-create submit paths,
    // gated by end_time < start_time, and it's a warning (confirm),
    // never a hard block (no early return without the confirm check).
    expect(html).toMatch(/function submitEvent\(\)[\s\S]*?end_time < start_time[\s\S]*?window\.confirm/);
    expect(html).toMatch(/function submitBulkEvents\(\)[\s\S]*?end_time < start_time[\s\S]*?window\.confirm/);
  });

  it('D3: inline scripts stay syntactically valid with the new warning logic', async () => {
    const { cookie, csrfToken } = await signup('d3.syntax@example.com', '203.0.200.003');
    await createLeague(cookie, csrfToken, { name: 'D3 Syntax League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    const scripts = extractInlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    assertNoSyntaxError(scripts);
  });

  it('D4: the create form hides the free-text venue field/help behind an onchange handler, wrapped so it can be hidden entirely', async () => {
    const { cookie, csrfToken } = await signup('d4.create@example.com', '203.0.200.004');
    await createLeague(cookie, csrfToken, { name: 'D4 Create League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await createVenue(cookie, csrfToken, { name: 'D4 Arena' });
    const html = await (await SELF.fetch('http://example.com/league/schedule', { headers: { cookie } })).text();
    expect(html).toContain('id="e_venue_select" onchange="onVenueSelectChange()"');
    expect(html).toContain('id="e_venue_wrap"');
    expect(html).toMatch(/function onVenueSelectChange\(\)[\s\S]*?wrap\.style\.display = 'none'/);
    expect(html).toContain('id="be_venue_select" onchange="onBulkVenueSelectChange()"');
    expect(html).toContain('id="be_venue_wrap"');
    expect(html).toMatch(/function onBulkVenueSelectChange\(\)[\s\S]*?wrap\.style\.display = 'none'/);
  });

  it('D4: the event detail edit form starts with the venue field hidden when the event already has a saved venue, and its handler hides (not just disables) on change', async () => {
    const { cookie, csrfToken } = await signup('d4.edit@example.com', '203.0.200.005');
    await createLeague(cookie, csrfToken, { name: 'D4 Edit League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    const v = await (await createVenue(cookie, csrfToken, { name: 'D4 Edit Arena' })).json();
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-06-01', venue_id: v.venue.id })).json();

    const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.event.id)}`, { headers: { cookie } })).text();
    const wrapTag = (html.match(/<div[^>]*id="ev_edit_venue_wrap"[^>]*>/) || [''])[0];
    expect(wrapTag).toContain('display:none');
    expect(html).toMatch(/function onEditVenueSelectChange\(\)[\s\S]*?wrap\.style\.display = 'none'/);
    // No 'disabled' attribute on the input anymore -- mutual exclusion
    // is handled by hiding the whole wrapper, not disabling the field.
    const inputTag = (html.match(/<input[^>]*id="ev_edit_venue"[^>]*>/) || [''])[0];
    expect(inputTag).not.toContain('disabled');
  });

  it('D4: a free-text-only event (no saved venue) shows the venue field open, not hidden', async () => {
    const { cookie, csrfToken } = await signup('d4.freetext@example.com', '203.0.200.006');
    await createLeague(cookie, csrfToken, { name: 'D4 Freetext League', teamNames: ['A', 'B'] });
    await publishSeason(cookie, csrfToken, { season_name: 'S1' });
    await createVenue(cookie, csrfToken, { name: 'D4 Unused Arena' });
    const ev = await (await createEvent(cookie, csrfToken, { date: '2099-06-02', venue: 'Some Rink' })).json();

    const html = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(ev.event.id)}`, { headers: { cookie } })).text();
    const wrapTag = (html.match(/<div[^>]*id="ev_edit_venue_wrap"[^>]*>/) || [''])[0];
    expect(wrapTag).not.toContain('display:none');
  });
});
