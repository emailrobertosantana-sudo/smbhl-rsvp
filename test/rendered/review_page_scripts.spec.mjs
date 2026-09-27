// The scoresheet review page's inline script, EXECUTED in Chromium.
//
// Week 3 of Fall 2026 could not be published: the page's single inline
// <script> block had two SyntaxErrors, so none of its functions existed --
// totals stuck on "Calcul des totaux…", the −/+ buttons did nothing, and
// "Confirmer et Publier" never sent a request. Both came from JS written
// inside a server-side template literal:
//   - \' in the template reaches the browser as a bare ' -- the add-player
//     row's onclick strings became  ', '' + side + '', '  (500ffba);
//   - '\n\n' in the template reaches the browser as two real line breaks
//     inside a single-quoted string (the publish backup-email message,
//     73cf25b).
// No test executed this script. This file renders every review-page state
// and the review list, loads each in a real browser, and uses the page.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { launchChromium } from './support/public_page_harness.mjs';
import { renderReviewPage, renderReviewIndex, consolidateSheetsIntoGames } from '../../src/review.js';
import { getSeasonConfig } from '../../src/season_config.js';

const SEASON = 'Fall 2026';
const fixtures = [
  { week: 3, time: '10:30 AM', home: 'Red', away: 'Black' }, { week: 3, time: '10:30 AM', home: 'Blue', away: 'White' },
  { week: 3, time: '11:30 AM', home: 'Red', away: 'White' }, { week: 3, time: '11:30 AM', home: 'Blue', away: 'Black' }
];
const cfg = getSeasonConfig({ current_season: SEASON, seasons: [{ name: SEASON, fixtures }] }, SEASON);
// A balanced week: every team's goals match its scores, every goalie's GA the opponent's.
const sheet = (team, g1, g2, goals1, goals2, ga1, ga2) => ({
  team, week: 3,
  goalie: { name: `${team} Goalie`, game1_ga: ga1, game2_ga: ga2 },
  game1: { opponent: g1[0], team_score: g1[1], opponent_score: g1[2] },
  game2: { opponent: g2[0], team_score: g2[1], opponent_score: g2[2] },
  players: [{ name: `${team} Scorer`, game1_goals: goals1, game2_goals: goals2 }, { name: `${team} Skater`, game1_goals: 0, game2_goals: 0 }]
});
const sheets = [
  sheet('Red', ['Black', 2, 1], ['White', 1, 1], 2, 1, 1, 1),
  sheet('Black', ['Red', 1, 2], ['Blue', 0, 2], 1, 0, 2, 2),
  sheet('Blue', ['White', 3, 2], ['Black', 2, 0], 3, 2, 2, 0),
  sheet('White', ['Blue', 2, 3], ['Red', 1, 1], 2, 1, 3, 1)
];
const candidatePlayers = ['Red', 'Black', 'Blue', 'White'].flatMap(t => [`${t} Scorer`, `${t} Skater`, `${t} Goalie`]).map((name, i) => ({ id: `P${String(i + 1).padStart(4, '0')}`, name, is_goalie: /Goalie/.test(name) }));
const games = consolidateSheetsIntoGames(sheets, fixtures, candidatePlayers.map(c => ({ player_id: c.id, name: c.name })), { config: cfg });
const review = (over = {}) => ({
  id: 'rev_test_week3', season: SEASON, week: 3, event_id: '2026-09-27', status: 'draft', created_at: '2026-09-27T16:36:15Z',
  images_json: JSON.stringify(['img:rev_test_week3:0', 'img:rev_test_week3:1', 'img:rev_test_week3:2', 'img:rev_other:0']),
  extracted_json: JSON.stringify(sheets), validated_json: JSON.stringify(games), ...over
});
const render = (r, opts = {}) => renderReviewPage(r, candidatePlayers, { maxAssistsPerGoal: 1, config: cfg, reviewToken: { rt: '', exp: '' }, ...opts });

let browser;
beforeAll(async () => { browser = await launchChromium(); });
afterAll(async () => { await browser?.close(); });

// Loads html as http://review.local/...; answers the publish request locally (never forwarded).
async function open(html) {
  const page = await browser.newPage();
  const errors = [];
  const published = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route('**/*', async r => {
    const u = r.request().url();
    if (u.startsWith('http://review.local/admin/review/publish')) { published.push(JSON.parse(r.request().postData())); return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }); }
    if (u.startsWith('http://review.local/')) return r.fulfill({ status: 200, contentType: 'text/html', body: html });
    return r.abort(); // fonts, photos: not needed
  });
  await page.goto('http://review.local/admin/review?id=rev_test_week3');
  await page.waitForTimeout(300);
  return { page, errors, published };
}

describe('Review page scripts run in a real browser', () => {
  it('every review-page state and the review list load without a script error', async () => {
    const pages = {
      draft: render(review()),
      manualNoPhotos: render(review({ images_json: '[]', extracted_json: '[]' })),
      published: render(review({ status: 'published', images_json: null })),
      discarded: render(review({ status: 'discarded', images_json: null })),
      scopedLink: render(review(), { reviewToken: { rt: 'tok', exp: '999' } }),
      list: renderReviewIndex([{ id: 'rev_test_week3', season: SEASON, week: 3, status: 'draft', created_at: '2026-09-27T16:36:15Z' }], [], true)
    };
    for (const [label, html] of Object.entries(pages)) {
      const { page, errors } = await open(html);
      expect(errors, `${label}: page errors`).toEqual([]);
      await page.close();
    }
  });

  it('the draft computes its totals, the −/+ buttons work, and publish sends every game', async () => {
    const { page, errors, published } = await open(render(review()));
    const status = (await page.textContent('#statusBar')).trim();
    expect(status).not.toMatch(/Calcul des totaux/);
    expect(status).toMatch(/✅/);

    await page.click('#btnPublish');
    await page.waitForTimeout(300);
    expect(errors).toEqual([]);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ review_id: 'rev_test_week3', week: 3 });
    expect(published[0].games.map(g => `${g.home_team}-${g.away_team} ${g.home_score}-${g.away_score}`).sort())
      .toEqual(['Blue-Black 2-0', 'Blue-White 3-2', 'Red-Black 2-1', 'Red-White 1-1']);
    await page.close();
  });

  it('an added player row (the code that carried the bad quotes) works: its −/+ change its own values', async () => {
    const { page, errors } = await open(render(review()));
    await page.locator('.btn-add-player').first().click();
    const row = page.locator('tbody[id^="tbody_"]').first().locator('tr').last();
    const goals = row.locator('.counter-input').first();
    expect(await goals.inputValue()).toBe('0');
    await row.locator('.btn-step').nth(1).click(); // goals +
    await row.locator('.btn-step').nth(1).click();
    expect(await goals.inputValue()).toBe('2');
    await row.locator('.btn-step').nth(0).click(); // goals −
    expect(await goals.inputValue()).toBe('1');
    expect(errors).toEqual([]);
    await page.close();
  });
});
