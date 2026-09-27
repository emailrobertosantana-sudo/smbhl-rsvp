// Scoresheets for a week accumulate in that week's ONE open draft.
//
// Production, Fall 2026 week 3: two uploads overlapped (one started
// 16:33:35 with Red/Black/Blue, the other 16:34:11 with White). Each looked
// for an open draft before parsing, found none (the first row was only
// written at 16:34:51, after Gemini), and inserted its own -- two partial
// drafts, each warning about the sheets the other held. Now sheets are
// parsed first, then merged into the season+week draft (created by one
// conditional INSERT, updated by compare-and-swap), so uploads -- even
// overlapping ones -- land in one draft. Published or discarded reviews
// are never reopened. A second sheet for the same team replaces the first.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';

const ADMIN_KEY = 'test-part117-admin';
const SEASON = 'Fall 2026';
let originalFetch;
let geminiDelayMs = 0;

// The fake Gemini reads which team a "photo" is from its bytes ("SHEET:<team>:<week>:<tag>").
function geminiReply(body) {
  const parts = JSON.parse(body).contents[0].parts;
  const inline = parts.find(p => p.inline_data || p.inlineData);
  const b64 = (inline.inline_data || inline.inlineData).data;
  const [, team, week, tag] = atob(b64).split(':');
  const opponent = { Red: 'White', White: 'Red', Blue: 'Black', Black: 'Blue' }[team];
  const sheet = { team, week: Number(week), tag, game1: { opponent, team_score: 2, opponent_score: 2 }, players: [] };
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(sheet) }] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}
const photo = (team, week, tag = 'a') => new File([`SHEET:${team}:${week}:${tag}`], `${team}.jpg`, { type: 'image/jpeg' });
async function upload(...files) {
  const fd = new FormData();
  for (const f of files) fd.append('sheets', f);
  const res = await SELF.fetch('http://example.com/admin/review/upload', { method: 'POST', headers: { 'x-admin': ADMIN_KEY }, body: fd, redirect: 'manual' });
  return { status: res.status, id: new URL(res.headers.get('location') || 'http://x/?id=').searchParams.get('id') };
}
const drafts = week => env.DB.prepare(`SELECT id, status, images_json, extracted_json, validated_json FROM sheet_reviews WHERE season = ? AND week = ? ORDER BY created_at`).bind(SEASON, week).all().then(r => r.results);
const teamsOf = row => JSON.parse(row.extracted_json).map(s => s.team).sort();
// The review page warns "Feuille <team> manquante" for each game side whose sheet is missing (has_*_sheet false).
const missingWarnings = row => JSON.parse(row.validated_json).flatMap(g => [
  g.has_home_sheet === false ? `Feuille ${g.home_team} manquante` : null,
  g.has_away_sheet === false ? `Feuille ${g.away_team} manquante` : null
]).filter(Boolean);

beforeAll(async () => {
  env.ADMIN_KEY = ADMIN_KEY;
  env.GEMINI_API_KEY = 'test-part117-gemini';
  await applyRealSchema(env);
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      if (geminiDelayMs) await new Promise(r => setTimeout(r, geminiDelayMs));
      return geminiReply(opts.body);
    }
    return new Response('{}', { status: 404 });
  };
  const fixtures = [];
  for (const [week, date] of [[3, 'Sunday September 27 2026'], [4, 'Sunday October 4 2026'], [5, 'Sunday October 11 2026'], [6, 'Sunday October 18 2026']]) {
    fixtures.push({ week, date, time: '10:30 AM', home: 'Red', away: 'White' }, { week, date, time: '11:30 AM', home: 'Blue', away: 'Black' });
  }
  await env.SHEETS_KV.put('data_json', JSON.stringify({ current_season: SEASON, seasons: [{ name: SEASON, fixtures, standings: [] }], players: [] }));
  await env.DB.prepare(`INSERT INTO events (id, season, week, date, state, start_time) VALUES ('2026-09-27', ?, 3, 'Sunday September 27 2026', 'open', '10:30')`).bind(SEASON).run();
});
afterAll(() => { globalThis.fetch = originalFetch; });

describe('One open draft per week', () => {
  let first;

  it("a second upload for the week merges into the open draft: images accumulate, and the missing-sheet warnings clear once all four sheets are in", async () => {
    const a = await upload(photo('White', 3));
    expect(a.status).toBe(303);
    let rows = await drafts(3);
    expect(rows).toHaveLength(1);
    expect(missingWarnings(rows[0]).sort()).toEqual(['Feuille Black manquante', 'Feuille Blue manquante', 'Feuille Red manquante']);

    const b = await upload(photo('Red', 3), photo('Black', 3), photo('Blue', 3));
    expect(b.id).toBe(a.id);
    rows = await drafts(3);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].images_json)).toHaveLength(4);
    expect(teamsOf(rows[0])).toEqual(['Black', 'Blue', 'Red', 'White']);
    expect(missingWarnings(rows[0])).toEqual([]);
    for (const key of JSON.parse(rows[0].images_json)) {
      expect(key.split(':')[1]).toBe(a.id); // the scoped review link still covers every photo
      expect(await env.SHEETS_KV.get(key)).not.toBeNull();
    }
    first = rows[0];
  });

  it('two uploads that overlap in time (the production case) still end in one draft holding every image', async () => {
    geminiDelayMs = 150;
    const [x, y] = await Promise.all([upload(photo('Red', 4), photo('Black', 4), photo('Blue', 4)), upload(photo('White', 4))]);
    geminiDelayMs = 0;
    const rows = await drafts(4);
    expect(rows).toHaveLength(1);
    expect(x.id).toBe(y.id);
    expect(JSON.parse(rows[0].images_json)).toHaveLength(4);
    expect(teamsOf(rows[0])).toEqual(['Black', 'Blue', 'Red', 'White']);
    expect(missingWarnings(rows[0])).toEqual([]);
  });

  it("the same team's sheet uploaded again REPLACES the earlier one (and its photo)", async () => {
    const oldWhite = JSON.parse(first.extracted_json).find(s => s.team === 'White');
    await upload(photo('White', 3, 'corrected'));
    const [row] = await drafts(3);
    const sheets = JSON.parse(row.extracted_json);
    expect(sheets.filter(s => s.team === 'White')).toHaveLength(1);
    expect(sheets.find(s => s.team === 'White').tag).toBe('corrected');
    expect(JSON.parse(row.images_json)).toHaveLength(4);
    expect(JSON.parse(row.images_json)).not.toContain(oldWhite.image_key);
    expect(await env.SHEETS_KV.get(oldWhite.image_key)).toBeNull();
  });

  it('a published review is not reopened: a later upload for that week starts a new draft', async () => {
    await upload(photo('Red', 5));
    const [pub] = await drafts(5);
    await env.DB.prepare(`UPDATE sheet_reviews SET status = 'published', images_json = NULL WHERE id = ?`).bind(pub.id).run();
    const later = await upload(photo('White', 5));
    const rows = await drafts(5);
    expect(rows.map(r => r.status)).toEqual(['published', 'draft']);
    expect(later.id).toBe(rows[1].id);
    expect(rows[0].images_json).toBeNull();
    expect(teamsOf(rows[0])).toEqual(['Red']);
  });

  it('a discarded review is not reopened either, and "add a sheet" refuses anything but a draft', async () => {
    const d = await upload(photo('Blue', 6));
    const discard = await SELF.fetch('http://example.com/admin/review/discard', { method: 'POST', headers: { 'x-admin': ADMIN_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ review_id: d.id }) });
    expect(discard.status).toBe(200);
    const later = await upload(photo('Black', 6));
    expect(later.id).not.toBe(d.id);
    expect((await drafts(6)).map(r => r.status)).toEqual(['discarded', 'draft']);

    const fd = new FormData();
    fd.append('review_id', d.id);
    fd.append('sheets', photo('Red', 6));
    const add = await SELF.fetch('http://example.com/admin/review/add-sheet', { method: 'POST', headers: { 'x-admin': ADMIN_KEY }, body: fd, redirect: 'manual' });
    expect(add.status).toBe(409);
    expect((await env.DB.prepare(`SELECT status, images_json FROM sheet_reviews WHERE id = ?`).bind(d.id).first())).toEqual({ status: 'discarded', images_json: null });
  });
});
