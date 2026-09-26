// Rendered-page harness for the league public page (public page QA
// batch). The rest of this suite runs inside workerd via
// @cloudflare/vitest-plugin, which can fetch HTML but can never lay it
// out -- and two themes previously shipped invisible text precisely
// because their contrast was "verified" from CSS token values instead
// of from a rendered page. This harness closes that gap:
//
//   1. wrangler's own createTestHarness bundles and runs src/index.js
//      in a local workerd, exactly as `wrangler dev` would;
//   2. with a PRIVATE, LOCAL-ONLY D1 (fake database id, inline config --
//      never wrangler.jsonc, so this can never touch the demo
//      or production database) built from the same base_schema_v1.sql +
//      migrate-*.sql chain test/support/real_schema.js uses;
//   3. leagues are seeded through the app's own HTTP routes (signup,
//      create league, publish season, contacts, events, scores, stats)
//      -- the same way test/part99 builds its fixtures;
//   4. a real Chromium (Playwright) loads the page from the harness's own
//      local URL, so every contrast/layout assertion is measured from
//      what the browser actually painted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function splitStatements(sql) {
  // Same splitter (and same single-line-comment assumption) as
  // test/support/real_schema.js -- see that file's own header.
  return sql.split('\n').map(line => { const i = line.indexOf('--'); return i === -1 ? line : line.slice(0, i); })
    .join('\n').split(';').map(s => s.trim()).filter(Boolean);
}

function realSchemaFiles() {
  const base = fs.readFileSync(path.join(ROOT, 'test/support/base_schema_v1.sql'), 'utf8');
  const migrations = fs.readdirSync(ROOT).map(f => ({ f, m: f.match(/^migrate-(\d+)\.sql$/) }))
    .filter(x => x.m).map(x => ({ num: parseInt(x.m[1], 10), sql: fs.readFileSync(path.join(ROOT, x.f), 'utf8') }))
    .sort((a, b) => a.num - b.num);
  // migrate-021.sql is applied right after the base schema -- see
  // real_schema.js's own FILE ORDER note.
  const gap021 = migrations.find(m => m.num === 21);
  return [base, gap021.sql, ...migrations.filter(m => m.num !== 21).map(m => m.sql)];
}

export async function startPublicPageWorker() {
  // No network needed: skip Miniflare's download of a real Request.cf
  // object (the page never reads one).
  process.env.CLOUDFLARE_CF_FETCH_ENABLED = 'false';
  // Inline config, NOT wrangler.jsonc: the D1/KV ids below are fake,
  // local-only names, so this harness has no path to the real demo or
  // production databases at all -- not even a misconfigured one.
  const server = createTestHarness({
    root: ROOT,
    workers: [{ config: {
      name: 'nl-rendered-public-page', main: 'src/index.js', compatibility_date: '2026-09-11',
      d1_databases: [{ binding: 'DB', database_name: 'rendered-test-db', database_id: 'rendered-test-db-local-only' }],
      kv_namespaces: [{ binding: 'SHEETS_KV', id: 'rendered-test-kv-local-only' }],
      vars: { AUTH_SECRET: 'rendered-public-page-secret', PUBLIC_URL: 'http://localhost', LEAGUE_PRODUCT: 'true' }
    } }]
  });
  const { url } = await server.listen();
  const baseUrl = url.toString().replace(/\/$/, '');
  const db = (await server.getWorker().getEnv()).DB;
  for (const sql of realSchemaFiles()) {
    const stmts = splitStatements(sql);
    if (stmts.length) await db.batch(stmts.map(s => db.prepare(s)));
  }
  let ipCounter = 0;
  async function api(pathname, { cookie, csrf, body, method = 'POST' } = {}) {
    const res = await fetch(baseUrl + pathname, {
      method, redirect: 'manual',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${++ipCounter % 250}`, ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return res;
  }
  async function signup(email) {
    const res = await api('/auth/signup', { body: { email, password: 'a-strong-password-1' } });
    const cookies = res.headers.getSetCookie();
    const cookie = cookies.map(c => c.split(';')[0]).join('; ');
    const csrfC = cookies.find(c => c.startsWith('csrf_token='));
    return { cookie, csrf: csrfC ? csrfC.split(';')[0].split('=')[1] : '' };
  }
  return {
    baseUrl, db, api, signup,
    async dispose() { await server.close(); }
  };
}

// A league with every public section populated (standings, players,
// goalies, leaders, schedule, recent results, organizer's note) --
// optionally with realistically LONG team/player names, the case the
// original proof data (short names) never exercised.
export async function seedPopulatedLeague(h, { email, name, teamNames, playerName, goalieName, organizerNote = 'Bienvenue!' }) {
  const s = await h.signup(email);
  const j = async (p, body) => (await h.api(p, { ...s, body })).json();
  const league = (await j('/leagues/create', { name, teamNames, tracksStats: false })).league;
  await j('/league/settings/identity', { tracksResults: true, tracksPlayerStats: true, organizerNote });
  await j('/league/season/publish', { season_name: 'S1' });
  const player = (await j('/league/contacts', { name: playerName, role: 'roster', team: teamNames[0] })).contact;
  const goalie = (await j('/league/contacts', { name: goalieName, role: 'roster', team: teamNames[0] })).contact;
  const venue = 'Aréna Municipal de Saint-Michel';
  // One past game (with a score and stats) and one upcoming game.
  const past = (await j('/league/events', { date: '2020-01-05', season: 'S1', venue })).event;
  const next = (await j('/league/events', { date: '2099-01-05', season: 'S1', venue, start_time: '20:30' })).event;
  for (const ev of [past, next]) {
    await j('/league/rsvp/admin', { event_id: ev.id, player_id: player.player_id, status: 'in' });
    await j('/league/rsvp/admin', { event_id: ev.id, player_id: goalie.player_id, status: 'in' });
  }
  await j('/league/events/score', { event_id: past.id, home_score: 5, away_score: 3 });
  await j('/league/events/player-stats', { event_id: past.id, entries: [
    { player_id: player.player_id, role: 'skater', goals: 3, assists: 2 },
    { player_id: goalie.player_id, role: 'goalie', goals_against: 0 }
  ] });
  const slug = (await h.db.prepare('SELECT slug FROM leagues WHERE id = ?').bind(league.id).first()).slug;
  return { league, slug, session: s };
}

export async function seedBareLeague(h, { email, name }) {
  const s = await h.signup(email);
  const league = (await (await h.api('/leagues/create', { ...s, body: { name, teamNames: ['A', 'B'], tracksStats: false } })).json()).league;
  await h.api('/league/season/publish', { ...s, body: { season_name: 'S1' } });
  const slug = (await h.db.prepare('SELECT slug FROM leagues WHERE id = ?').bind(league.id).first()).slug;
  return { league, slug, session: s };
}

// Saves a league's public theme the real way (the Settings form's own
// endpoint), so a rendered test exercises the stored-theme path, not
// just the ?theme= preview.
export async function saveTheme(h, session, theme) {
  const res = await h.api('/league/settings/identity', { ...session, body: { publicTheme: theme } });
  if (res.status !== 200) throw new Error(`saveTheme(${theme}) failed: ${res.status} ${await res.text()}`);
}

export async function launchChromium() {
  const { chromium } = await import('playwright');
  try {
    return await chromium.launch();
  } catch (e) {
    throw new Error('Rendered public-page tests need Playwright\'s Chromium: run `npx playwright install chromium` once on this machine.\n' + e.message);
  }
}
