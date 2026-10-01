// Copy audit fixes N1 to N3 (copy-audit/REPORT.md, "Changed since the
// first audit"): a sentence that ends on a date never gets a second period;
// the dual-role admin alert has a heading and a button instead of a raw
// address; the text part of the admin alerts and the cancelled-game email
// keeps the HTML's paragraphs.
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { applyRealSchema } from './support/real_schema.js';
import { endSentence, formatEventDate } from '../src/date_format.js';
import { renderLateReversalAdminAlert, dualGoalieAlert } from '../src/index.js';

describe('N1: a sentence that ends on a date', () => {
  it('one period, never two', () => {
    expect(endSentence(`Blue ne joue plus le ${formatEventDate('2026-04-10', 'fr', 'long', false)}`)).toBe('Blue ne joue plus le vendredi 10 avr.');
    expect(endSentence(`Blue ne joue plus le ${formatEventDate('2026-05-08', 'fr', 'long', false)}`)).toBe('Blue ne joue plus le vendredi 8 mai.');
    expect(endSentence('Blue is no longer playing on Fri Apr 10')).toBe('Blue is no longer playing on Fri Apr 10.');
  });
});

describe('N3: the text part keeps its paragraphs', () => {
  it('the late drop-out alert: title, sentence, then the link on its own line', () => {
    const m = renderLateReversalAdminAlert({ leagueName: 'Ligue', leagueColor: '#2a5fa8', playerName: 'Léa', team: 'Otters', ev: { date: '2099-11-15', start_time: '19:00' }, dashboardLink: 'https://x.test/g', languageMode: 'fr' });
    expect(m.text).toMatch(/^Léa ne peut plus venir\n\nLéa avait confirmé sa présence pour dimanche 15 nov\. à 19 h et vient de changer sa réponse, .+ avant le match\.\nÉquipe : Otters\n\nDes remplaçants ont déjà été invités automatiquement\.\n\nVoir le match : https:\/\/x\.test\/g$/);
    const en = renderLateReversalAdminAlert({ leagueName: 'League', playerName: 'Lea', team: 'Otters', ev: { date: '2099-11-15', start_time: '19:00' }, dashboardLink: 'https://x.test/g', languageMode: 'en' });
    expect(en.text).toMatch(/^Lea can't make it\n\nLea had confirmed for Sunday, Nov 15 at 7 PM and just changed their answer, .+ before the game\.\nTeam: Otters\n\nSubs have already been invited automatically\.\n\nView the game: https:\/\/x\.test\/g$/);
  });
});

describe('N2: the dual-role admin alert', () => {
  beforeAll(async () => {
    env.RSVP_SECRET = 'p205'; env.PUBLIC_URL = 'https://rsvp.example.com';
    await applyRealSchema(env);
    await env.DB.prepare(`INSERT INTO users (id, email, password_hash, created_at) VALUES ('u205', 'owner205@example.com', 'x', '2026-10-01T00:00:00Z')`).run();
    await env.DB.prepare(`INSERT INTO leagues (id, name, team_count, team_names, created_by, created_at, slug, team_structure, language_mode, min_players, max_players, min_goalies) VALUES ('lg205', 'Ligue 205', 2, '["Red","Blue"]', 'u205', '2026-10-01T00:00:00Z', 'ligue-205', 'fixed', 'fr', 2, 10, 1)`).run();
    await env.DB.prepare(`INSERT INTO league_admins (league_id, user_id, created_at) VALUES ('lg205', 'u205', '2026-10-01T00:00:00Z')`).run().catch(() => {});
    const c = (id, name, role, goalie, dual, team) => env.DB.prepare(`INSERT INTO contacts (player_id, name, email, role, is_sub, is_goalie, is_backup_goalie, preferred_team, token_salt, league_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 's', 'lg205', 1)`)
      .bind(`lg205:${id}`, name, `${id.toLowerCase()}.p205@example.com`, role, role === 'roster' ? 0 : 1, goalie, dual, team).run();
    await c('GR', 'Gilles Rouge', 'roster', 1, 0, 'Red');
    await c('DR', 'Dany Deux', 'roster', 0, 1, 'Red');
    await c('GB', 'Guy Bleu', 'roster', 1, 0, 'Blue');
    await c('SB', 'Sid Bleu', 'roster', 0, 0, 'Blue');
  });

  it('a heading and a button, the address only in the text part, on its own line', async () => {
    const start = Date.now() + 40 * 3600000;
    const iso = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(start));
    const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(start));
    const id = `lg205:${iso}`;
    await env.DB.prepare(`INSERT INTO events (id, season, week, date, venue, state, start_time, league_id, home_team, away_team) VALUES (?, 'S1', 1, ?, 'Aréna', 'open', ?, 'lg205', 'Red', 'Blue')`).bind(id, iso, hhmm).run();
    const rsvp = (pid, team, status) => env.DB.prepare(`INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at, league_id) VALUES (?, ?, ?, ?, 'roster', 'self', ?, 'lg205')`).bind(id, `lg205:${pid}`, team, status, new Date().toISOString()).run();
    await rsvp('GR', 'Red', 'in'); await rsvp('DR', 'Red', 'in'); await rsvp('GB', 'Blue', 'out'); await rsvp('SB', 'Blue', 'in');
    const ev = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first();
    expect(await dualGoalieAlert(env, ev)).toBeGreaterThan(0);
    const row = await env.DB.prepare("SELECT payload FROM outbox WHERE kind = 'dual_goalie_alert' AND event_id = ?").bind(id).first();
    const p = JSON.parse(row.payload).prerendered;
    expect(p.html).toContain('>Gardien manquant : Blue</h1>');
    expect(p.html).toContain('Voir le match');
    expect(p.html).not.toMatch(/buts : https?:/);
    expect(p.html).not.toMatch(/>https?:\/\/[^<]*</);
    expect(p.text).toMatch(/^Gardien manquant : Blue\n\n/);
    expect(p.text).toMatch(/dans les buts\.\nhttps:\/\/rsvp\.example\.com\/league\/events\/detail\?e=/);
  });
});
