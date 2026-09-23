// Design system Part 3: event status page
// (components/ScreenEventStatus/preview.html) -- confirms the real
// SpotMeter segment count and the short/complete Badge both track
// actual RSVP data, not static markup.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const AUTH_SECRET = 'test-part3-event-status-ds-secret';

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

describe('Part 3: event status page (design system)', () => {
  beforeAll(async () => {
    env.AUTH_SECRET = AUTH_SECRET;
    await applyRealSchema(env);
  });

  it('the SpotMeter segment count and the short Badge both reflect real confirmed/target numbers, not decoration', async () => {
    const signupRes = await SELF.fetch('http://example.com/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.821' },
      body: JSON.stringify({ email: 'ds.eventstatus@example.com', password: 'a-strong-password-1' })
    });
    const cookie = extractCookie(signupRes);
    const csrfToken = extractCsrfToken(signupRes);
    const leagueRes = await SELF.fetch('http://example.com/leagues/create', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Event Status DS League', teamNames: ['Alpha', 'Beta'], tracksStats: true })
    });
    const leagueId = (await leagueRes.json()).league.id;
    await SELF.fetch('http://example.com/league/season/publish', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ season_name: 'DS Season' })
    });
    const eventRes = await SELF.fetch('http://example.com/league/events', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ date: '2099-08-08' })
    });
    const eventId = (await eventRes.json()).event.id;

    // No players confirmed yet -- Alpha should show as short, with a
    // real invite button, and zero "in" segments in its SpotMeter.
    const beforeHtml = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
    expect(beforeHtml).toContain('nl-badge nl-badge--short');
    expect(beforeHtml).toContain('nl-meter');
    expect(beforeHtml).not.toContain('<i class="in"></i>');

    // Add a player to Alpha and mark them in -- the meter should now
    // show exactly one confirmed ("in") segment.
    const contactRes = await SELF.fetch('http://example.com/league/contacts', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'DS Alpha Player', team: 'Alpha' })
    });
    const playerId = (await contactRes.json()).contact.player_id;
    await SELF.fetch('http://example.com/league/rsvp/admin', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ event_id: eventId, player_id: playerId, status: 'in' })
    });

    const afterHtml = await (await SELF.fetch(`http://example.com/league/events/detail?e=${encodeURIComponent(eventId)}`, { headers: { cookie } })).text();
    expect((afterHtml.match(/<i class="in"><\/i>/g) || []).length).toBe(1);
    expect(afterHtml).toContain('DS Alpha Player');
  });
});
