// Plural forms (src/plural.js), so no copy needs "game(s)".
//
// The server's pluralText and the pages' window.__pluralText are two
// copies of the same few lines: both are run over the same cases here and
// must give the same text. Then the real strings, on the real pages, in
// Chromium, at 0, 1 and many, in French and in English.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPublicPageWorker, seedBareLeague, launchChromium } from './support/public_page_harness.mjs';
import { pluralText, PLURAL_TEXT_JS } from '../../src/plural.js';

let h, browser, league;
const SHOTS = process.env.PLURAL_SHOTS || null; // a folder: the rendered strings, for the report

beforeAll(async () => {
  h = await startPublicPageWorker({ extraVars: { RSVP_SECRET: 'plural-text' } });
  league = await seedBareLeague(h, { email: 'owner@plural.example', name: 'Plural League' });
  await h.api('/league/events/bulk', { ...league.session, body: { startDate: '2099-01-05', occurrences: 3, start_time: '19:00', end_time: '20:00', venue: 'Gym' } });
  browser = await launchChromium();
}, 240000);
afterAll(async () => { await browser?.close(); await h?.dispose(); });

async function open(path, lang) {
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 900 } });
  await context.addCookies(league.session.cookie.split('; ').map(c => { const i = c.indexOf('='); return { name: c.slice(0, i), value: c.slice(i + 1), url: h.baseUrl + '/' }; }));
  await context.addInitScript(l => { try { localStorage.setItem('smbhl_admin_lang', l); } catch (e) {} }, lang);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => (r.request().url().startsWith(h.baseUrl) ? r.continue() : r.abort()));
  await page.goto(h.baseUrl + path, { waitUntil: 'load' });
  return { page, errors, close: () => context.close() };
}
// A key of the page's own dictionary, through the page's own formatter.
const fmt = (page, key, vars) => page.evaluate(([k, v]) => window.__pluralText(window.__pageDict()[k], v), [key, vars]);

describe('pluralText: the rule', () => {
  it('French counts 0 and 1 as singular, English only 1; an optional zero form; "#" is the number', () => {
    const t = '{n|# game|# games}';
    expect([0, 1, 2].map(n => pluralText(t, { n }, 'en'))).toEqual(['0 games', '1 game', '2 games']);
    const f = '{n|# match|# matchs}';
    expect([0, 1, 2].map(n => pluralText(f, { n }, 'fr'))).toEqual(['0 match', '1 match', '2 matchs']);
    const z = '{n|none|one|# many}';
    expect([0, 1, 9].map(n => pluralText(z, { n }, 'en'))).toEqual(['none', 'one', '9 many']);
    expect([0, 1, 9].map(n => pluralText(z, { n }, 'fr'))).toEqual(['none', 'one', '9 many']);
    // Plain values, several names, and a name nobody passed.
    expect(pluralText('{team}: {sum} of {target|# goal|# goals}, {other}', { team: 'Red', sum: 2, target: 1 }, 'en')).toBe('Red: 2 of 1 goal, {other}');
    expect(pluralText(null, {}, 'en')).toBe('');
    expect(pluralText('no closing {brace', { brace: 1 }, 'en')).toBe('no closing {brace');
  });

  it('the page copy (window.__pluralText) gives exactly what the server copy gives', () => {
    const win = { __currentLang: 'fr' };
    new Function('window', PLURAL_TEXT_JS)(win);
    const templates = ['{n|# game|# games}', '{n|none|one|# many}', '{a} and {b|# x|# xs}{c|, no c|, 1 c|, # cs}.', 'plain', '{missing|a|b}', '{n}', 'broken {n'];
    for (const lang of ['fr', 'en']) {
      win.__currentLang = lang;
      for (const tpl of templates) for (const n of [0, 1, 2, 9]) {
        const vars = { n, a: n, b: n, c: n };
        expect(win.__pluralText(tpl, vars), `${lang} ${tpl} ${n}`).toBe(pluralText(tpl, vars, lang));
      }
    }
  });
});

describe('Plural copy on the real pages, at 0, 1 and many', () => {
  const ROUNDS = {
    en: {
      '9,0': '9 complete rounds of the regular season, no partial round.',
      '1,0': '1 complete round of the regular season, no partial round.',
      '0,3': 'No complete round of the regular season, plus a partial round of 3 games.',
      '2,1': '2 complete rounds of the regular season, plus a partial round of 1 game.',
      '0,0': 'No complete round of the regular season, no partial round.'
    },
    fr: {
      '9,0': '9 rondes complètes de saison régulière, aucune ronde partielle.',
      '1,0': '1 ronde complète de saison régulière, aucune ronde partielle.',
      '0,3': 'Aucune ronde complète de saison régulière, plus une ronde partielle de 3 matchs.',
      '2,1': '2 rondes complètes de saison régulière, plus une ronde partielle de 1 match.',
      '0,0': 'Aucune ronde complète de saison régulière, aucune ronde partielle.'
    }
  };
  const SCHEDULE = {
    en: {
      total: ['0 games total: 0 for the playoffs, 0 for the regular season.', '1 game total: 0 for the playoffs, 1 for the regular season.', '9 games total: 0 for the playoffs, 9 for the regular season.'],
      overwrite: ['This will overwrite 0 games that already have a matchup assigned. Click again to confirm.', 'This will overwrite 1 game that already has a matchup assigned. Click again to confirm.', 'This will overwrite 9 games that already have a matchup assigned. Click again to confirm.']
    },
    fr: {
      total: ['0 match au total : 0 pour les séries, 0 pour la saison régulière.', '1 match au total : 0 pour les séries, 1 pour la saison régulière.', '9 matchs au total : 0 pour les séries, 9 pour la saison régulière.'],
      overwrite: ['Ceci écrasera 0 match qui a déjà un affrontement assigné. Clique de nouveau pour confirmer.', 'Ceci écrasera 1 match qui a déjà un affrontement assigné. Clique de nouveau pour confirmer.', 'Ceci écrasera 9 matchs qui ont déjà un affrontement assigné. Clique de nouveau pour confirmer.']
    }
  };
  const GAME = {
    en: {
      failed: ['Failed to send to 0 players.', 'Failed to send to 1 player.', 'Failed to send to 9 players.'],
      partial: ['Reminder sent to 0 players, but 0 sends failed.', 'Reminder sent to 1 player, but 1 send failed.', 'Reminder sent to 9 players, but 9 sends failed.'],
      tally: ['Red: 0 of 0 goals attributed', 'Red: 0 of 1 goal attributed', 'Red: 0 of 9 goals attributed']
    },
    fr: {
      failed: ["Échec de l'envoi à 0 joueur.", "Échec de l'envoi à 1 joueur.", "Échec de l'envoi à 9 joueurs."],
      partial: ['Rappel envoyé à 0 joueur, mais 0 envoi a échoué.', 'Rappel envoyé à 1 joueur, mais 1 envoi a échoué.', 'Rappel envoyé à 9 joueurs, mais 9 envois ont échoué.'],
      tally: ['Red : 0 sur 0 but attribué', 'Red : 0 sur 1 but attribué', 'Red : 0 sur 9 buts attribués']
    }
  };
  const COMMS = {
    en: { recipients: ['0 recipients', '1 recipient', '9 recipients'], sent: ['0 emails sent.', '1 email sent.', '9 emails sent.'], sentFailed: ['0 emails sent, 0 failed.', '1 email sent, 1 failed.', '9 emails sent, 9 failed.'] },
    fr: { recipients: ['0 destinataire', '1 destinataire', '9 destinataires'], sent: ['0 courriel envoyé.', '1 courriel envoyé.', '9 courriels envoyés.'], sentFailed: ['0 courriel envoyé, 0 échec.', '1 courriel envoyé, 1 échec.', '9 courriels envoyés, 9 échecs.'] }
  };

  for (const lang of ['fr', 'en']) {
    it(`${lang}: schedule page (rounds, totals, overwrite warning), and the preview shows the rounds line`, async () => {
      const { page, errors, close } = await open('/league/schedule', lang);
      const rounds = {};
      for (const k of Object.keys(ROUNDS[lang])) { const [full, partial] = k.split(',').map(Number); rounds[k] = await fmt(page, 'matchupsArithmeticRounds', { full, partial }); }
      expect(rounds).toEqual(ROUNDS[lang]);
      expect(await Promise.all([0, 1, 9].map(n => fmt(page, 'matchupsArithmeticSummary', { total: n, playoff: 0, regular: n })))).toEqual(SCHEDULE[lang].total);
      expect(await Promise.all([0, 1, 9].map(n => fmt(page, 'matchupsOverwriteConfirm', { count: n })))).toEqual(SCHEDULE[lang].overwrite);
      // The real preview: 3 games, 2 teams (one game per round): 3 complete rounds.
      await page.evaluate(() => toggleMatchupsPanel());
      await page.click('#mx_preview_btn');
      await page.waitForSelector('#mx_rounds_line');
      const shown = await page.textContent('#mx_rounds_line');
      expect(shown).toBe(lang === 'en' ? '3 complete rounds of the regular season, no partial round.' : '3 rondes complètes de saison régulière, aucune ronde partielle.');
      if (SHOTS) {
        const fs = await import('node:fs');
        fs.writeFileSync(`${SHOTS}/rounds_${lang}.json`, JSON.stringify({ rounds, shownInPreview: shown }, null, 1));
        await page.locator('#sc_matchups_panel').screenshot({ path: `${SHOTS}/rounds_preview_${lang}.png` });
      }
      expect((await page.locator('#sc_matchups_panel').innerText())).not.toMatch(/\(s\)|\(es\)/);
      expect(errors).toEqual([]);
      await close();
    }, 120000);

    it(`${lang}: game page and communications page`, async () => {
      const ev = await h.db.prepare('SELECT id FROM events WHERE league_id = ? LIMIT 1').bind(league.league.id).first();
      let { page, errors, close } = await open('/league/events/detail?e=' + encodeURIComponent(ev.id), lang);
      const cut = s => s.split('. ')[0] + (s.includes('. ') ? '.' : ''); // first sentence
      expect((await Promise.all([0, 1, 9].map(n => fmt(page, 'remindSendFailed', { n })))).map(cut)).toEqual(GAME[lang].failed);
      expect(await Promise.all([0, 1, 9].map(n => fmt(page, 'remindSentPartial', { sent: n, failed: n })))).toEqual(GAME[lang].partial);
      expect(await Promise.all([0, 1, 9].map(n => fmt(page, 'psTallyLine', { team: 'Red', sum: 0, target: n })))).toEqual(GAME[lang].tally);
      expect(errors).toEqual([]);
      await close();
      ({ page, errors, close } = await open('/league/comms', lang));
      expect(await Promise.all([0, 1, 9].map(n => fmt(page, 'recipientCountLabel', { n })))).toEqual(COMMS[lang].recipients);
      expect(await Promise.all([0, 1, 9].map(n => fmt(page, 'drainSent', { sent: n })))).toEqual(COMMS[lang].sent);
      expect(await Promise.all([0, 1, 9].map(n => fmt(page, 'drainSentFailed', { sent: n, failed: n })))).toEqual(COMMS[lang].sentFailed);
      expect(errors).toEqual([]);
      await close();
    }, 120000);
  }
});
