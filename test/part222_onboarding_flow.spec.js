// Onboarding batch (2026-10-02): a new organizer goes from sign-up to a
// working league without confusion. The season is the wizard's own screen;
// the flow ends with an optional finance step and a summary of where the
// league stands (structure, players, games, billing); left half-way, it
// picks up where it was; a co-admin is never counted into the creator's
// steps; an owner can create a second league and switch between them; a
// co-admin's invitation is in Notre Ligue's look. Notre Ligue only.
import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { withGameTimes } from './support/game_times.js';
import { hmac } from '../src/crypto_utils.js';

let ip = 0;
async function signup(email) {
  const res = await SELF.fetch('http://example.com/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': `203.0.222.${++ip}` },
    body: JSON.stringify({ accept_terms: true, email, password: 'a-strong-password-1' })
  });
  const cookies = res.headers.getSetCookie();
  return { cookie: cookies.map(c => c.split(';')[0]).join('; '), csrf: (cookies.find(c => c.startsWith('csrf_token=')) || '').split(';')[0].split('=')[1] };
}
const post = (s, path, body) => SELF.fetch('http://example.com' + path, { method: 'POST', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const get = (s, path) => SELF.fetch('http://example.com' + path, { headers: s ? { cookie: s.cookie } : {}, redirect: 'manual' });
const html = async (s, path) => (await get(s, path)).text();
// The session's cookies with a response's Set-Cookie applied (same name: replaced).
const withCookie = (s, res) => {
  const jar = new Map(s.cookie.split('; ').map(c => [c.slice(0, c.indexOf('=')), c]));
  for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; jar.set(kv.slice(0, kv.indexOf('=')), kv); }
  return { ...s, cookie: [...jar.values()].join('; ') };
};

async function league(email, body) {
  const s = await signup(email);
  const res = await post(s, '/leagues/create', { name: `League ${email}`, ...body });
  return { s: withCookie(s, res), league: (await res.json()).league };
}

beforeAll(async () => {
  env.AUTH_SECRET = 'p222-auth'; env.LEAGUE_PRODUCT = 'true'; env.BILLING_LAUNCH_AT = '2026-10-02';
  await applyRealSchema(env);
});
afterAll(() => { delete env.LEAGUE_PRODUCT; delete env.BILLING_LAUNCH_AT; });

describe('sign-up', () => {
  it('the account step, signed in already (the back button): straight on to the league form', async () => {
    const s = await signup('p222.back@example.com');
    const res = await get(s, '/signup?lang=fr');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/signup?step=2&lang=fr');
  });

  it('step 2 has no way back to the account step; the done page leads to the season screen', async () => {
    const s = await signup('p222.done@example.com');
    const step2 = await html(s, '/signup?step=2');
    expect(step2).not.toContain("window.__navWithLang('/signup?step=1')");
    expect(step2).not.toContain('id="su_cancel"');
    await post(s, '/leagues/create', { name: 'Done League', teamNames: ['A', 'B'] });
    expect(await html(s, '/signup?step=done')).toContain(`onclick="window.__navWithLang('/onboarding/season')"`);
  });

  it('a new league becomes the current one (nl_league)', async () => {
    const s = await signup('p222.cookie@example.com');
    const res = await post(s, '/leagues/create', { name: 'Cookie League', teamNames: ['A', 'B'] });
    const id = (await res.clone().json()).league.id;
    expect(res.headers.getSetCookie().some(c => c.startsWith(`nl_league=${encodeURIComponent(id)};`))).toBe(true);
  });
});

describe('the season screen and the step count', () => {
  it('no season yet: the wizard asks for it, counted (4 of 8 fixed, 3 of 6 otherwise)', async () => {
    const fixed = await league('p222.fixed@example.com', { teamNames: ['A', 'B'] });
    const page = await html(fixed.s, '/onboarding/season?lang=fr');
    expect(page).toContain('id="ob_season_name"');
    expect(page).toContain('Étape 4 sur 8');
    expect(page).toContain('"seasonTitle":"Start your first season"');
    const drop = await league('p222.drop@example.com', { teamStructure: 'headcount' });
    expect(await html(drop.s, '/onboarding/season')).toContain('Étape 3 sur 6');
    // Sign-up's own step 3 counts to the same total.
    expect(await html((await signup('p222.step3@example.com')), '/signup?step=3')).toContain('Étape 3 sur 8');
  });

  it('the steps after it: roster first, finance last (8 of 8), each with a way back (review 1e: the first too, to the season screen)', async () => {
    const { s } = await league('p222.steps@example.com', { teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    const first = await html(s, '/onboarding/season?step=1');
    expect(first).toContain('Étape 5 sur 8');
    expect(first).toContain(`onclick="location.href='/onboarding/season?step=season'"`);
    const fin = await html(s, '/onboarding/season?step=4');
    expect(fin).toContain('Étape 8 sur 8');
    // Item 5: tracking the money is the norm, "Oui" chosen by default.
    expect(fin).toContain('Veux-tu faire le suivi des finances de ta ligue?');
    expect(fin).toContain('"financeTitle":"Do you want to track your league\'s money?"');
    expect(fin).toContain('Les frais des joueurs, les paiements reçus et les dépenses, comme la location du gymnase.');
    expect(fin).toContain('id="ob_finance_yes" value="yes" checked');
    expect(fin).toContain("Non, pas pour l&#39;instant");
    expect(fin).toContain('data-i18n="financeCostsLabel">Tes principales dépenses<');
    expect(fin).toContain('"financeCostsLabel":"Your main expenses"');
    expect(fin).toContain('data-i18n="skipFinance" onclick="return obSkip()">Passer cette étape<');
    expect(fin).toContain('Tu pourras tout changer plus tard sur la page Finances.');
    expect(fin).toContain(`onclick="location.href='/onboarding/season?step=3'"`);
    expect(fin).toContain('href="/onboarding/season?step=summary"');
  });
});

describe('the stats section of the options step explains each choice (item 8, review 3b)', () => {
  it('fixed with goalies: results, player stats, goalie stats, and where they are entered', async () => {
    const { s } = await league('p222.stats@example.com', { teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    await post(s, '/league/settings/structure', { min_goalies: 1 });
    const page = await html(s, '/onboarding/season?step=3');
    expect(page).toContain('Résultats : tu entres le pointage de chaque match, et le classement se calcule tout seul.');
    expect(page).toContain('Statistiques des joueurs : buts et passes, entrés après le match, avec un tableau des meneurs sur ta page publique.');
    expect(page).toContain('data-i18n="statsExplainGoalies"');
    expect(page).toContain('Tu entres tout ça depuis la page d&#39;un match, une fois la partie commencée.');
    expect(page).toContain(`"statsExplainResults":"Results: you enter each game's score, and the standings calculate themselves."`);
  });
  it('pickup: no standings promised; no teams: no results, no goalie line', async () => {
    const pick = await league('p222.statspick@example.com', { teamStructure: 'weekly_draw', teamNames: ['A', 'B'] });
    await post(pick.s, '/league/season/publish', { season_name: 'S1' });
    const p = await html(pick.s, '/onboarding/season?step=2');
    expect(p).toContain('data-i18n="statsExplainResultsPickup"');
    expect(p).not.toContain('data-i18n="statsExplainResults"');
    const none = await league('p222.statsnone@example.com', { teamStructure: 'headcount' });
    await post(none.s, '/league/season/publish', { season_name: 'S1' });
    const n = await html(none.s, '/onboarding/season?step=2');
    expect(n).not.toContain('data-i18n="statsExplainResults');
    expect(n).not.toContain('data-i18n="statsExplainGoalies"');
    expect(n).toContain('data-i18n="statsExplainPlayers"');
  });
});

describe('left half-way and back', () => {
  it('resumes at the first step not answered; the dashboard says so until every step is seen', async () => {
    const { s } = await league('p222.resume@example.com', { teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    expect((await post(s, '/league/onboarding/step', { step: 'season', action: 'done' })).status).toBe(200);
    expect((await post(s, '/league/onboarding/step', { step: 'roster', action: 'done' })).status).toBe(200);
    expect((await post(s, '/league/onboarding/step', { step: 'teams', action: 'skip' })).status).toBe(200);
    expect(await html(s, '/onboarding/season')).toContain('var OB_STEP = "options"');
    const dash = await html(s, '/dashboard');
    expect(dash).toContain('href="/onboarding/season?step=3" data-i18n="nsFinishSetup"');
    for (const step of ['options', 'finance']) await post(s, '/league/onboarding/step', { step, action: 'done' });
    expect(await html(s, '/dashboard')).not.toContain('data-i18n="nsFinishSetup"');
    // Every step seen: back to the summary.
    expect(await html(s, '/onboarding/season')).toContain('id="ob_summary"');
  });

  it('a league with no record (set up before) is never told to finish', async () => {
    const { s } = await league('p222.legacy@example.com', { teamNames: ['A', 'B'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    expect(await html(s, '/dashboard')).not.toContain('data-i18n="nsFinishSetup"');
  });
});

describe('the summary', () => {
  it('structure, players (and those with no team), games with the first one, billing, links', async () => {
    const { s } = await league('p222.sum@example.com', { teamNames: ['Castors', 'Hiboux'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    let page = await html(s, '/onboarding/season?step=summary');
    expect(page).toContain('Équipes fixes : 2 équipes (Castors, Hiboux).');
    expect(page).toContain("Aucun joueur pour l&#39;instant.");
    expect(page).toContain("Aucun match pour l&#39;instant.");
    expect(page).toContain('Ta ligue est gratuite.');
    expect(page).toContain('data-i18n="actSchedule"');
    expect(page).toContain('data-i18n="actPlayers"');
    await post(s, '/league/events', withGameTimes({ date: '2099-06-07', season: 'S1', venue: 'Parc', start_time: '19:00' }));
    await post(s, '/league/contacts/bulk', { contacts: [{ name: 'Ann Player', role: 'roster' }, { name: 'Ben Player', role: 'roster', team: 'Castors' }], emailChoice: 'skip' });
    page = await html(s, '/onboarding/season?step=summary');
    expect(page).toContain('2 joueurs, dont 1 sans équipe.');
    expect(page).toContain('data-date-en="2 players, 1 without a team."');
    expect(page).toContain('1 match à l&#39;horaire.');
    expect(page).toContain('data-i18n="sumFirstGame">Premier match :<');
    expect(page).toContain('data-i18n="actTeams"');
    expect(page).toContain('href="/dashboard" data-i18n="finish"');
  });

  it('a second league under 15 when the free slot is taken: it needs a plan, and its trial', async () => {
    const first = await league('p222.slot@example.com', { teamNames: ['A', 'B'] });
    await post(first.s, '/league/contacts', { name: 'Only Player', role: 'roster' });
    const res = await post(first.s, '/leagues/create', { name: 'Second Slot League', teamStructure: 'headcount' });
    const s2 = withCookie(first.s, res);
    await post(s2, '/league/season/publish', { season_name: 'S1' });
    const page = await html(s2, '/onboarding/season?step=summary');
    expect(page).toContain('Cette ligue demande un forfait.');
    expect(page).toMatch(/Essai gratuit : il reste \d+ jours\./);
    expect(page).toContain('Sans équipes : une seule liste de joueurs.');
  });
});

describe('the dashboard', () => {
  it('regular players on no team: a next step, and no "ready" card', async () => {
    const { s } = await league('p222.teamless@example.com', { teamNames: ['Otters', 'Bears'] });
    await post(s, '/league/season/publish', { season_name: 'S1' });
    await post(s, '/league/settings/structure', { min_players: 1, max_players: 20 });
    await post(s, '/league/events', withGameTimes({ date: '2099-06-07', season: 'S1', venue: 'Parc', start_time: '19:00' }));
    await post(s, '/league/contacts', { name: 'Lea Player', role: 'roster' });
    let dash = await html(s, '/dashboard');
    expect(dash).toContain('data-i18n="nsAssignTeams">Placer tes joueurs dans une équipe<');
    expect(dash).not.toContain('id="setup_done_card"');
    const pid = (await env.DB.prepare("SELECT player_id FROM contacts WHERE name = 'Lea Player'").first()).player_id;
    await env.DB.prepare("UPDATE contacts SET preferred_team = 'Otters' WHERE player_id = ?").bind(pid).run();
    dash = await html(s, '/dashboard');
    expect(dash).not.toContain('data-i18n="nsAssignTeams"');
    expect(dash).toContain('id="setup_done_card"');
  });

  it('an owner of two leagues: a picker, and the link to create another', async () => {
    const first = await league('p222.two@example.com', { teamNames: ['A', 'B'] });
    await post(first.s, '/league/season/publish', { season_name: 'S1' });
    let dash = await html(first.s, '/dashboard');
    expect(dash).toContain('href="/signup?step=2&amp;new=1" id="dash_new_league"');
    expect(dash).not.toContain('id="dash_league"');
    // "Créer une autre ligue": the league form, with a way back.
    const form = await get(first.s, '/signup?step=2&new=1');
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('id="su_cancel"');
    const res = await post(first.s, '/leagues/create', { name: 'Second League', teamStructure: 'headcount' });
    const s2 = withCookie(first.s, res);
    dash = await html(s2, '/dashboard');
    expect(dash).toContain('id="dash_league"');
    expect(dash).toContain(`<option value="${first.league.id}">League p222.two@example.com</option>`);
  });
});

describe('a co-admin', () => {
  it('the invitation is in Notre Ligue\'s look (no SMBHL), and the steps carry no count for them', async () => {
    const owner = await league('p222.owner@example.com', { teamNames: ['A', 'B'] });
    await post(owner.s, '/league/season/publish', { season_name: 'S1' });
    const email = 'p222.co@example.com';
    const exp = Date.now() + 3600 * 1000;
    const enc = btoa(email).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const token = `${owner.league.id}.${enc}.${exp}.${await hmac(env.AUTH_SECRET, `invite:${owner.league.id}:${email}:${exp}`)}`;
    const page = await html(null, '/league/admins/accept?token=' + encodeURIComponent(token));
    expect(page).not.toContain('SMBHL');
    expect(page).toContain('id="accept_password"');
    expect(page).toContain('data-i18n="createBtn" onclick="submitAccept()">Créer mon compte<');
    expect(page).toContain('Rejoindre League p222.owner@example.com');
    const acc = await SELF.fetch('http://example.com/league/admins/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accept_terms: true, token, password: 'co-admin-password-1' }) });
    expect(acc.status).toBe(200);
    const co = { cookie: acc.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') };
    const step = await html(co, '/onboarding/season?step=1');
    expect(step).toContain('id="ob_submit"');
    expect(step).not.toMatch(/Étape \d+ sur \d+/);
  });
});
