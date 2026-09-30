// src/email_preview.js -- see an email exactly as it would go out, without
// sending it. One implementation for SMBHL and the league product.
//
// WHAT A PREVIEW IS
//   The real renderer, fed the real data a send would use now: the league's
//   next game, the real recipients of that email (the first one is shown,
//   with the total), the real links, dues, fixtures and team messages. For
//   outbox mail it goes through prepareOutboxMessage() -- the very function
//   drain() sends from -- so a preview cannot drift from what is sent.
//
//   Emails tied to a completed season (the season recap and its admin
//   prompt) render from the most recent season that has a champion, and the
//   preview says which season it used.
//
// WHAT A PREVIEW NEVER DOES
//   No outbox row, no Resend call, no daily budget. The only thing a
//   preview can write is a team link's salt (settings teamsalt:<season>:
//   <team>) the first time that team's link is ever built -- the same salt
//   the first real email would create.
//
// Helpers that live in index.js come through installEmailPreviewHost(), the
// same host pattern as src/reminders.js (no circular import).
import { eventStart, SMBHL_LEAGUE_ID } from './league_ids.js';
import { getSeasonConfigForEvent, getTeamNames } from './season_config.js';
import { buildSummaryText } from './reminders.js';
import { buildInviteEmail } from './leagues.js';

let host = null;
export function installEmailPreviewHost(h) { host = h; }
function H() {
  if (!host) throw new Error('email_preview.js: installEmailPreviewHost() has not run (index.js installs it at load)');
  return host;
}

// Every email an admin can configure or trigger, per product. Labels are
// the preview's own title.
export const PREVIEW_KINDS = {
  smbhl: {
    invite: { fr: 'Invitation de la semaine', en: 'Weekly invite' },
    invite_sub: { fr: 'Invitation aux substituts', en: 'Sub invite' },
    chase_72: { fr: 'Rappel 72 h', en: '72 h reminder' },
    chase_49: { fr: 'Rappel 49 h', en: '49 h reminder' },
    chase_24: { fr: 'Dernier rappel 24 h', en: '24 h last call' },
    team_short: { fr: 'Équipe incomplète', en: 'Short-team notice' },
    sub_call: { fr: 'Appel aux substituts', en: 'Sub call' },
    sub_call_reminder: { fr: "Rappel d'appel aux substituts", en: 'Sub call reminder' },
    gameday: { fr: 'Veille de match', en: 'Game-day reminder' },
    gameday_sub: { fr: 'Veille de match (substitut, frais)', en: 'Game-day reminder (sub, fee)' },
    gameday_morning: { fr: 'Matin du match', en: 'Game-day morning' },
    friday_board: { fr: 'Tableau du vendredi', en: 'Friday board' },
    notice: { fr: 'Statut modifié par un coéquipier', en: 'Status changed by a teammate' },
    released: { fr: 'Substitut libéré', en: 'Sub released' },
    poll: { fr: 'Sondage', en: 'Poll' },
    cancellation: { fr: "Avis d'annulation", en: 'Cancellation notice' },
    broadcast: { fr: 'Message à la ligue', en: 'Broadcast' },
    season_recap: { fr: 'Bilan de saison', en: 'Season recap' },
    season_recap_prompt: { fr: 'Rappel du bilan (admin)', en: 'Recap prompt (admin)' },
    summary: { fr: 'Sommaire de la semaine (admin)', en: 'Weekly summary (admin)' },
    created: { fr: 'Semaine créée (admin)', en: 'Week created (admin)' },
    goalie_cancel: { fr: 'Alerte gardien (admin)', en: 'Goalie alert (admin)' }
  },
  league: {
    reminder_72h: { fr: 'Rappel 72 h', en: '72 h reminder' },
    reminder_24h: { fr: 'Rappel 24 h', en: '24 h reminder' },
    logistics_12h: { fr: 'Détails 12 h', en: '12 h details' },
    team_assigned: { fr: 'Équipe assignée', en: 'Team assigned' },
    sub_call: { fr: 'Appel aux remplaçants', en: 'Sub call' },
    broadcast: { fr: 'Message à la ligue', en: 'Broadcast' },
    late_reversal: { fr: 'Désistement tardif (admin)', en: 'Late dropout (admin)' },
    coadmin_invite: { fr: 'Invitation co-admin', en: 'Co-admin invite' }
  }
};

const note = (fr, en) => ({ fr, en });
class PreviewError extends Error {
  constructor(fr, en, status = 400) { super(en); this.fr = fr; this.en = en; this.status = status; }
}

// The league's next game: its soonest open event not yet over (a game in
// progress still counts). null when it has none.
async function nextEvent(env, leagueId) {
  const rows = (await env.DB.prepare(
    `SELECT * FROM events WHERE state = 'open' AND COALESCE(league_id, ?) = ?`
  ).bind(SMBHL_LEAGUE_ID, leagueId).all()).results || [];
  const now = Date.now();
  const timed = rows.map(ev => ({ ev, t: (eventStart(ev) || new Date(0)).getTime() }))
    .filter(x => x.t > now - 6 * 3600000)
    .sort((a, b) => a.t - b.t);
  return timed.length ? timed[0].ev : null;
}

async function requireEvent(env, leagueId, eventId) {
  const ev = eventId
    ? await env.DB.prepare('SELECT * FROM events WHERE id = ? AND COALESCE(league_id, ?) = ?').bind(eventId, SMBHL_LEAGUE_ID, leagueId).first()
    : await nextEvent(env, leagueId);
  if (!ev) throw new PreviewError("Aucun match à venir : cet aperçu a besoin du prochain match.", 'No upcoming game: this preview needs the next game.', 404);
  return ev;
}

const eventSource = (ev, dateFR) => note(
  `Prochain match : semaine ${ev.week}, ${dateFR(ev.date)}`,
  `Next game: week ${ev.week}, ${ev.date}`
);

// Emailable players of an event, filtered by an rsvp condition.
async function eventPlayers(env, ev, where, ...binds) {
  return (await env.DB.prepare(
    `SELECT r.player_id, r.team, r.role, r.status, c.name, c.email, c.is_goalie, c.role AS contact_role
       FROM rsvp r JOIN contacts c ON c.player_id = r.player_id
      WHERE r.event_id = ? AND c.email IS NOT NULL AND c.email != '' AND c.opted_out = 0 AND ${where}
      ORDER BY c.name`
  ).bind(ev.id, ...binds).all()).results || [];
}

// SMBHL subs (contacts) not on this game yet, in call order (least asked first).
async function freeSubs(env, ev, leagueId, goalie = false) {
  return (await env.DB.prepare(
    `SELECT player_id, name, email, role FROM contacts
      WHERE COALESCE(league_id, ?) = ? AND role = ? AND opted_out = 0 AND COALESCE(is_active, 1) = 1
        AND email IS NOT NULL AND email != '' AND COALESCE(dormant, 0) = 0
        AND player_id NOT IN (SELECT player_id FROM rsvp WHERE event_id = ? AND player_id IS NOT NULL)
      ORDER BY COALESCE(asked_streak, 0), name`
  ).bind(SMBHL_LEAGUE_ID, leagueId, goalie ? 'sub_goalie' : 'sub_skater', ev.id).all()).results || [];
}

// An outbox row that would be queued, rendered the way drain() renders it.
async function previewRow(env, row, ev) {
  const { prepareOutboxMessage, createOutboxRenderContext } = H();
  const m = { id: 0, league_id: SMBHL_LEAGUE_ID, team: null, player_id: null, ...row, payload: JSON.stringify(row.payload || {}) };
  const prep = await prepareOutboxMessage(env, m, createOutboxRenderContext(env), { preview: true, event: ev });
  if (prep.action !== 'send') {
    throw new PreviewError(`Ce courriel ne partirait pas : ${prep.reason}`, `This email would not be sent: ${prep.reason}`, 409);
  }
  const notes = (prep.notes || []).map(r => note(`À l'envoi, il serait retenu : ${r}`, `At send time it would be held back: ${r}`));
  return { to: prep.to, mail: prep.msg, notes };
}

// The most recent season with a champion -- a completed season.
async function completedSeason(env, requested) {
  let d = null;
  try { const raw = await env.SHEETS_KV.get('data_json'); d = raw ? JSON.parse(raw) : null; } catch (_) {}
  const seasons = ((d && d.seasons) || []).filter(Boolean);
  if (requested) {
    const s = seasons.find(x => x.name === requested);
    if (s) return { d, season: s };
  }
  const s = seasons.find(x => x.champion);
  if (!s) throw new PreviewError('Aucune saison terminée (avec un champion) pour cet aperçu.', 'No completed season (with a champion) to preview from.', 404);
  return { d, season: s };
}

// What the season-recap email of `season` would carry: what was sent,
// else the saved draft, else the awards computed from the stats.
async function recapPayload(env, d, season) {
  const { computeSeasonAwards } = H();
  const name = season.name;
  let saved = null, from = 'auto';
  for (const [key, label] of [[`season_recap:${name}`, 'sent'], [`season_recap_draft:${name}`, 'draft']]) {
    const raw = await env.SHEETS_KV.get(key);
    if (raw) { try { saved = JSON.parse(raw); from = label; break; } catch (_) {} }
  }
  const auto = saved && saved.awards ? null : computeSeasonAwards(d, name);
  const hasPhoto = !!(await env.SHEETS_KV.get(`champion_photo:${name}`));
  const publicUrl = env.PUBLIC_URL || 'https://rsvp.smbhl.com';
  return {
    from,
    payload: {
      season: name,
      champion: (saved && saved.champion) || season.champion || (auto && auto.champion) || '',
      photo_url: hasPhoto ? `${publicUrl}/api/champion-photo?s=${encodeURIComponent(name)}` : null,
      awards: (saved && saved.awards) || (auto ? {
        rocketRichard: auto.rocketRichard, ladyByng: auto.ladyByng, artRoss: auto.artRoss, hartTrophy: auto.hartTrophy,
        norris: auto.norris, vezina: auto.vezina, calder: auto.calder, subway: auto.subway, mvp: auto.mvp, billMasterton: auto.billMasterton
      } : {}),
      intro_note: (saved && saved.intro_note) || '',
      outro_note: (saved && saved.outro_note) || ''
    }
  };
}

const RECAP_FROM = {
  sent: note('le bilan envoyé', 'the recap as sent'),
  draft: note('le brouillon enregistré', 'the saved draft'),
  auto: note('les trophées calculés des statistiques', 'the awards computed from the stats')
};

async function previewSmbhl(env, kind, p) {
  const { dateFR, teamState, renderCancellationEmail, cancellationRecipients, renderGoalieCancelEmail,
    smbhlBroadcastRecipients, renderSmbhlBroadcastEmail, pollRecipients, renderPollEmail, buildCreatedNoticeText, ADMIN_EMAIL } = H();
  const leagueId = SMBHL_LEAGUE_ID;
  const admin = env.ADMIN_EMAIL || ADMIN_EMAIL;
  const notes = [];

  // Emails of a completed season: no event needed.
  if (kind === 'season_recap' || kind === 'season_recap_prompt') {
    const { d, season } = await completedSeason(env, p.season);
    const source = note(`Saison terminée la plus récente : ${season.name}`, `Most recent completed season: ${season.name}`);
    if (p.season && p.season === season.name) Object.assign(source, note(`Saison : ${season.name}`, `Season: ${season.name}`));
    if (kind === 'season_recap_prompt') {
      const r = await previewRow(env, { kind, event_id: `${season.name}-recap`, payload: { season: season.name, to: admin } });
      return { ...r, recipientCount: 1, source };
    }
    const { from, payload } = await recapPayload(env, d, season);
    notes.push(note(`Contenu : ${RECAP_FROM[from].fr}.`, `Content: ${RECAP_FROM[from].en}.`));
    const regulars = (await env.DB.prepare(
      `SELECT player_id FROM contacts WHERE opted_out = 0 AND email IS NOT NULL AND email != '' AND role NOT LIKE 'sub%' AND COALESCE(league_id, ?) = ? ORDER BY name`
    ).bind(leagueId, leagueId).all()).results || [];
    const subsWhoPlayed = (await env.DB.prepare(
      `SELECT DISTINCT c.player_id FROM rsvp r JOIN events e ON e.id = r.event_id JOIN contacts c ON c.player_id = r.player_id
        WHERE e.season = ? AND r.status = 'in' AND c.role LIKE 'sub%' AND c.opted_out = 0 AND c.email IS NOT NULL AND c.email != ''`
    ).bind(season.name).all()).results || [];
    if (!regulars.length) throw new PreviewError('Aucun joueur régulier avec un courriel.', 'No regular player with an email.', 404);
    const r = await previewRow(env, { kind, event_id: `${season.name}-recap`, player_id: regulars[0].player_id, payload });
    return { ...r, recipientCount: regulars.length + subsWhoPlayed.length, source, notes: [...notes, ...r.notes] };
  }

  if (kind === 'broadcast') {
    const subject = String(p.subject || '').trim(), message = String(p.message || '').trim();
    if (!subject || !message) throw new PreviewError("Écris un sujet et un message pour voir l'aperçu.", 'Write a subject and a message to see the preview.');
    const picked = await smbhlBroadcastRecipients(env, p.target || 'all', p.event_id || null);
    if (picked.error) throw new PreviewError(picked.error, picked.error);
    const mail = renderSmbhlBroadcastEmail(subject, message);
    const first = picked.recipients[0];
    return { to: first ? first.email : null, mail, recipientCount: picked.recipients.length,
      source: note('Destinataires selon la cible choisie', 'Recipients for the chosen target'), notes };
  }

  if (kind === 'poll') {
    const poll = p.poll_id
      ? await env.DB.prepare('SELECT * FROM polls WHERE id = ?').bind(p.poll_id).first()
      : await env.DB.prepare('SELECT * FROM polls ORDER BY created_at DESC LIMIT 1').first();
    if (!poll) throw new PreviewError('Aucun sondage à prévisualiser.', 'No poll to preview.', 404);
    const recipients = await pollRecipients(env, poll);
    if (!recipients.length) throw new PreviewError('Ce sondage n’a aucun destinataire.', 'This poll has no recipients.', 404);
    const mail = await renderPollEmail(env, poll, recipients[0]);
    return { to: recipients[0].email, mail, recipientCount: recipients.length,
      source: note(`Sondage : ${poll.title}`, `Poll: ${poll.title}`), notes };
  }

  const ev = await requireEvent(env, leagueId, p.event_id);
  const source = eventSource(ev, dateFR);
  const cfg = await getSeasonConfigForEvent(env, ev.id, ev.season);
  const teams = getTeamNames(cfg);

  if (kind === 'cancellation') {
    const recipients = await cancellationRecipients(env, ev.id);
    return { to: recipients[0] ? recipients[0].email : null, mail: renderCancellationEmail(ev), recipientCount: recipients.length, source, notes };
  }
  if (kind === 'summary') {
    const r = await previewRow(env, { kind, event_id: ev.id, payload: { text: await buildSummaryText(env, ev) } }, ev);
    return { ...r, recipientCount: 1, source };
  }
  if (kind === 'created') {
    const n = (await env.DB.prepare(`SELECT count(*) n FROM rsvp WHERE event_id = ? AND role = 'roster'`).bind(ev.id).first()).n;
    const r = await previewRow(env, { kind, event_id: ev.id, payload: { text: await buildCreatedNoticeText(env, ev, n) } }, ev);
    return { ...r, recipientCount: 1, source };
  }
  if (kind === 'goalie_cancel') {
    const goalies = await eventPlayers(env, ev, `r.role = 'roster' AND c.is_goalie = 1`);
    if (!goalies.length) throw new PreviewError("Aucun gardien à l'alignement de ce match.", 'No goalie on this game’s roster.', 404);
    const g = goalies[0];
    notes.push(note(`Exemple : si ${g.name} se désistait lui-même.`, `Example: if ${g.name} dropped out themself.`));
    const mail = await renderGoalieCancelEmail(env, ev, g, g.team, 'self', 'in');
    return { to: mail.to, mail, recipientCount: 1, source, notes };
  }

  // Player mail, rendered through the outbox path.
  let pick = [], row;
  const fallback = async (where, fr, en, ...binds) => { pick = await eventPlayers(env, ev, where, ...binds); if (pick.length) notes.push(note(fr, en)); };
  switch (kind) {
    case 'invite':
      pick = await eventPlayers(env, ev, `r.role = 'roster'`);
      row = r => ({ kind: 'invite' });
      break;
    case 'invite_sub': {
      const prevEv = await env.DB.prepare(`SELECT id FROM events WHERE season = ? AND week < ? ORDER BY week DESC LIMIT 1`).bind(ev.season, ev.week).first();
      if (prevEv) {
        pick = (await env.DB.prepare(
          `SELECT DISTINCT r.player_id, c.name, c.email FROM rsvp r JOIN contacts c ON c.player_id = r.player_id
            WHERE r.event_id = ? AND r.status = 'in' AND c.opted_out = 0 AND c.email IS NOT NULL AND c.email != ''
              AND r.player_id NOT IN (SELECT player_id FROM rsvp WHERE event_id = ? AND role = 'roster')
            ORDER BY c.name`).bind(prevEv.id, ev.id).all()).results || [];
      }
      if (!pick.length) {
        pick = await freeSubs(env, ev, leagueId);
        if (pick.length) notes.push(note("Aucun substitut n'a joué la semaine dernière; aperçu avec un substitut de la liste.", 'No sub played last week; previewing with a sub from the list.'));
      }
      row = () => ({ kind: 'invite', payload: { is_sub: true } });
      break;
    }
    case 'chase_72': case 'chase_49': case 'chase_24':
      pick = await eventPlayers(env, ev, `r.role = 'roster' AND r.status = 'pending'`);
      if (!pick.length) await fallback(`r.role = 'roster'`, "Tout le monde a répondu; ce rappel ne partirait à personne. Aperçu avec un joueur de l'alignement.", 'Everyone has answered; this reminder would go to no one. Previewing with a roster player.');
      row = () => ({ kind: 'chase', payload: { stage: kind.slice(6) } });
      break;
    case 'gameday':
      pick = await eventPlayers(env, ev, `r.role = 'roster' AND r.status = 'in'`);
      if (!pick.length) await fallback(`r.role = 'roster' AND r.status = 'pending'`, "Personne n'est confirmé; aperçu avec un joueur sans réponse (il le recevrait aussi).", 'No one is confirmed; previewing with a player who has not answered (they would get it too).');
      row = () => ({ kind: 'gameday' });
      break;
    case 'gameday_sub':
      pick = await eventPlayers(env, ev, `r.role = 'sub' AND r.status = 'in'`);
      if (!pick.length) throw new PreviewError("Aucun substitut n'est confirmé pour ce match.", 'No sub is confirmed for this game.', 404);
      row = () => ({ kind: 'gameday' });
      break;
    case 'gameday_morning': case 'friday_board': {
      const top = await env.DB.prepare(`SELECT team, count(*) n FROM team_messages WHERE event_id = ? GROUP BY team ORDER BY n DESC LIMIT 1`).bind(ev.id).first();
      if (!top) notes.push(note("Aucun message d'équipe pour ce match : ce courriel ne partirait pas. Aperçu sans messages.", 'No team messages for this game: this email would not go out. Previewing without messages.'));
      const team = top ? top.team : teams[0];
      pick = await eventPlayers(env, ev, `r.team = ? AND (r.status = 'in' OR (r.role = 'roster' AND r.status = 'pending'))`, team);
      row = r => ({ kind, team });
      break;
    }
    case 'notice':
      pick = await eventPlayers(env, ev, `r.role = 'roster'`);
      row = r => ({ kind: 'notice', payload: { status: 'out', by: 'teammate' } });
      if (pick.length) notes.push(note(`Exemple : un coéquipier marque ${pick[0].name} absent.`, `Example: a teammate marks ${pick[0].name} out.`));
      break;
    case 'released':
      pick = await eventPlayers(env, ev, `r.role = 'sub'`);
      if (!pick.length) throw new PreviewError("Aucun substitut placé pour ce match.", 'No sub placed on this game.', 404);
      row = r => ({ kind: 'released', team: r.team });
      break;
    case 'team_short': {
      let chosen = null;
      const states = [];
      for (const team of teams) {
        const st = await teamState(env.DB, ev.id, team, cfg);
        states.push({ team, st });
        if (st.short && !chosen) chosen = { team, st };
      }
      if (!chosen) {
        chosen = states.sort((a, b) => a.st.skaters - b.st.skaters)[0];
        notes.push(note(`Aucune équipe n'est incomplète en ce moment : ce courriel ne partirait pas. Aperçu avec ${chosen.team}, ses vrais chiffres.`, `No team is short right now: this email would not go out. Previewing with ${chosen.team}, its real counts.`));
      }
      pick = await eventPlayers(env, ev, `r.team = ? AND r.status = 'in'`, chosen.team);
      if (!pick.length) await fallback(`r.team = ?`, "Personne n'est confirmé dans cette équipe; aperçu avec un joueur de l'alignement.", 'No one is confirmed on this team; previewing with a roster player.', chosen.team);
      const st = chosen.st;
      row = r => ({ kind: 'team_short', team: chosen.team, payload: { skaters: st.skaters, goalies: st.goalies, needGoalie: st.shortGoalie, needSkaters: st.shortSkaters } });
      break;
    }
    case 'sub_call': case 'sub_call_reminder': {
      pick = await freeSubs(env, ev, leagueId);
      let team = teams[0];
      for (const t of teams) { const st = await teamState(env.DB, ev.id, t, cfg); if (st.shortSkaters) { team = t; break; } }
      notes.push(note('Substitut : le premier dans l’ordre d’appel.', 'Sub: the first one in call order.'));
      row = r => ({ kind: 'sub_call', team, payload: { need: 'skater', ...(kind === 'sub_call_reminder' ? { reminder: true } : {}) } });
      break;
    }
    default:
      throw new PreviewError(`Aperçu inconnu : ${kind}`, `Unknown preview: ${kind}`);
  }
  if (!pick.length) throw new PreviewError("Personne ne recevrait ce courriel pour le prochain match.", 'No one would receive this email for the next game.', 404);
  const first = pick[0];
  const r = await previewRow(env, { event_id: ev.id, player_id: first.player_id, team: first.team || null, ...row(first) }, ev);
  return { ...r, recipientCount: pick.length, source, notes: [...notes, ...r.notes] };
}

async function previewLeague(env, leagueId, kind, p) {
  const { renderLeagueReminderForContact, getNonResponders, getConfirmedPlayers, renderLateReversalForLeague, leagueAdminEmails,
    leagueBroadcastRecipients, renderLeagueBroadcastEmail, formatEventDate } = H();
  const leagueRow = await env.DB.prepare('SELECT * FROM leagues WHERE id = ?').bind(leagueId).first();
  if (!leagueRow) throw new PreviewError('Ligue introuvable.', 'League not found.', 404);
  const notes = [];

  if (kind === 'coadmin_invite') {
    const link = `${env.PUBLIC_URL || 'https://rsvp.notreligue.ca'}/league/admins/accept?token=…`;
    notes.push(note("Le lien d'acceptation est créé à l'envoi, pour l'adresse invitée.", 'The accept link is created when sent, for the invited address.'));
    return { to: null, mail: buildInviteEmail(leagueRow.name, link, leagueRow.color || '#b3122e', leagueRow.language_mode || 'both'), recipientCount: 1,
      source: note('La personne que tu invites', 'The person you invite'), notes };
  }
  if (kind === 'broadcast') {
    const subject = String(p.subject || '').trim(), message = String(p.message || '').trim();
    if (!subject || !message) throw new PreviewError("Écris un sujet et un message pour voir l'aperçu.", 'Write a subject and a message to see the preview.');
    const picked = await leagueBroadcastRecipients(env, leagueId, leagueRow, p.target || 'all', p.event_id || '');
    if (picked.error) throw new PreviewError(picked.error, picked.error);
    const first = picked.recipients[0];
    return { to: first ? first.email : null, mail: renderLeagueBroadcastEmail(leagueRow, subject, message), recipientCount: picked.recipients.length,
      source: note('Destinataires selon la cible choisie', 'Recipients for the chosen target'), notes };
  }

  const ev = await requireEvent(env, leagueId, p.event_id);
  const source = note(`Prochain match : ${formatEventDate(ev.date, 'fr', 'long')}`, `Next game: ${formatEventDate(ev.date, 'en', 'long')}`);
  const anyActive = async () => (await env.DB.prepare(
    `SELECT player_id, name, email, token_salt, preferred_team FROM contacts WHERE league_id = ? AND is_active = 1 AND opted_out = 0 AND email IS NOT NULL AND email != '' ORDER BY name`
  ).bind(leagueId).all()).results || [];

  if (kind === 'reminder_72h' || kind === 'reminder_24h') {
    let pick = await getNonResponders(env, leagueId, ev.id, ev.season);
    if (!pick.length) {
      pick = await anyActive();
      if (pick.length) notes.push(note("Tout le monde a répondu : ce rappel ne partirait à personne. Aperçu avec un joueur de la ligue.", 'Everyone has answered: this reminder would go to no one. Previewing with a league player.'));
    }
    if (!pick.length) throw new PreviewError('Aucun joueur avec un courriel.', 'No player with an email.', 404);
    const mail = await renderLeagueReminderForContact(env, leagueRow, ev, pick[0], kind);
    return { to: pick[0].email, mail, recipientCount: pick.length, source, notes };
  }
  if (kind === 'logistics_12h' || kind === 'team_assigned' || kind === 'late_reversal') {
    let pick = await getConfirmedPlayers(env, leagueId, ev.id);
    if (!pick.length) {
      pick = (await anyActive()).map(c => ({ ...c, rsvp_team: c.preferred_team || null }));
      if (pick.length) notes.push(note("Personne n'est confirmé : aperçu avec un joueur de la ligue.", 'No one is confirmed: previewing with a league player.'));
    }
    if (!pick.length) throw new PreviewError('Aucun joueur avec un courriel.', 'No player with an email.', 404);
    const c = pick[0];
    if (kind === 'late_reversal') {
      const admins = await leagueAdminEmails(env, leagueId);
      notes.push(note(`Exemple : si ${c.name} se désistait à 12 h du match.`, `Example: if ${c.name} dropped out 12 hours before the game.`));
      return { to: admins[0] ? admins[0].email : null, mail: renderLateReversalForLeague(env, leagueRow, ev, c), recipientCount: admins.length, source, notes };
    }
    if (kind === 'team_assigned') notes.push(note("Envoyé seulement si les équipes sont formées après l'envoi des détails 12 h.", 'Sent only when teams are drawn after the 12 h details went out.'));
    const mail = await renderLeagueReminderForContact(env, leagueRow, ev, c, kind, c.rsvp_team || null);
    return { to: c.email, mail, recipientCount: pick.length, source, notes };
  }
  if (kind === 'sub_call') {
    const subs = (await env.DB.prepare(
      `SELECT player_id FROM contacts WHERE league_id = ? AND role LIKE 'sub_%' AND is_active = 1 AND opted_out = 0 AND email IS NOT NULL AND email != ''
         AND player_id NOT IN (SELECT player_id FROM rsvp WHERE event_id = ? AND player_id IS NOT NULL) ORDER BY COALESCE(asked_streak, 0), name`
    ).bind(leagueId, ev.id).all()).results || [];
    if (!subs.length) throw new PreviewError("Aucun remplaçant disponible pour ce match.", 'No sub available for this game.', 404);
    let teams = [];
    try { teams = JSON.parse(leagueRow.team_names || '[]'); } catch (_) {}
    const r = await previewRow(env, { kind: 'sub_call', league_id: leagueId, event_id: ev.id, player_id: subs[0].player_id, team: teams[0] || '', payload: { need: 'skater' } }, ev);
    return { ...r, recipientCount: subs.length, source, notes: [note('Remplaçant : le premier dans l’ordre d’appel.', 'Sub: the first one in call order.'), ...r.notes] };
  }
  throw new PreviewError(`Aperçu inconnu : ${kind}`, `Unknown preview: ${kind}`);
}

// The preview for one kind: { ok, kind, label, subject, html, text, to,
// recipientCount, source, notes } -- or { ok: false, error: { fr, en } }.
export async function buildEmailPreview(env, leagueId, params = {}) {
  const product = !leagueId || leagueId === SMBHL_LEAGUE_ID ? 'smbhl' : 'league';
  const kind = String(params.kind || '');
  const label = PREVIEW_KINDS[product][kind];
  if (!label) return { ok: false, status: 400, error: note(`Aperçu inconnu : ${kind}`, `Unknown preview: ${kind}`) };
  try {
    const r = product === 'smbhl' ? await previewSmbhl(env, kind, params) : await previewLeague(env, leagueId, kind, params);
    return {
      ok: true, kind, label,
      subject: r.mail.subject, html: r.mail.html || null, text: r.mail.text || '',
      to: r.to, recipientCount: r.recipientCount, source: r.source, notes: r.notes || []
    };
  } catch (e) {
    if (e instanceof PreviewError) return { ok: false, status: e.status, error: note(e.fr, e.en) };
    throw e;
  }
}

// ---------------------------------------------------------------------
// The one UI: a button anywhere with data-email-preview="<kind>" opens the
// preview in a modal (subject, recipient, which data it used, and the HTML
// part as a mail client shows it, in a sandboxed frame). Optional:
//   data-preview-endpoint  /admin/comms/preview (SMBHL, default) or
//                          /league/comms/preview (league product)
//   data-preview-params    JSON of fixed parameters, e.g. {"event_id":"…"}
//   data-preview-event / -poll / -season   one fixed parameter each
//   data-preview-fields    "subject=bc-subject,message=bc-message": form
//                          fields read when clicked (broadcast drafts)
// One String.raw literal with no backslash, backtick or ${ in it, so nothing
// is re-escaped on its way to the browser. (Not a function's .toString():
// the bundler wraps functions in __name() helpers the page doesn't have.)
const EMAIL_PREVIEW_CLIENT_JS = String.raw`(function () {
  var T = {
    fr: { title: 'Aperçu du courriel', subject: 'Objet', to: 'Destinataire', count: 'Destinataires au total', source: 'Données utilisées', none: '(personne)', only: "Aperçu seulement : rien n'est envoyé.", loading: 'Chargement…', close: 'Fermer', textOnly: 'Courriel en texte seulement (aucune version HTML).', error: "L'aperçu n'a pas pu être créé." },
    en: { title: 'Email preview', subject: 'Subject', to: 'Recipient', count: 'Total recipients', source: 'Data used', none: '(no one)', only: 'Preview only: nothing is sent.', loading: 'Loading…', close: 'Close', textOnly: 'Text-only email (no HTML version).', error: 'The preview could not be created.' }
  };
  function lang() {
    var l = window.__currentLang || document.documentElement.getAttribute('lang') || 'fr';
    return String(l).slice(0, 2) === 'en' ? 'en' : 'fr';
  }
  function pick(v) { return v && typeof v === 'object' ? (v[lang()] || v.fr || '') : (v == null ? '' : String(v)); }
  function node(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var ui = null;
  function build() {
    if (ui) return ui;
    var overlay = node('div', 'ep-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    var box = node('div', 'ep-dialog');
    var head = node('div', 'ep-head');
    var title = node('div', 'ep-title');
    var close = node('button', 'ep-close', '×');
    close.type = 'button';
    head.appendChild(title); head.appendChild(close);
    var meta = node('div', 'ep-meta');
    var frame = document.createElement('iframe');
    frame.className = 'ep-frame';
    frame.setAttribute('sandbox', '');
    frame.setAttribute('title', 'email');
    box.appendChild(head); box.appendChild(meta); box.appendChild(frame);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    function hide() { overlay.classList.remove('on'); frame.srcdoc = ''; }
    close.addEventListener('click', hide);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) hide(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
    ui = { overlay: overlay, title: title, meta: meta, frame: frame, close: close };
    return ui;
  }
  function row(label, value, cls) {
    var r = node('div', 'ep-row' + (cls ? ' ' + cls : ''));
    r.appendChild(node('span', 'ep-k', label));
    r.appendChild(node('span', 'ep-v', value));
    return r;
  }
  function escapeHtml(s) { return String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;'); }
  function show(d) {
    var t = T[lang()];
    var u = build();
    u.title.textContent = t.title + ' · ' + pick(d.label);
    u.meta.innerHTML = '';
    u.meta.appendChild(row(t.subject, d.subject || '', 'ep-subject'));
    u.meta.appendChild(row(t.to, d.to || t.none));
    u.meta.appendChild(row(t.count, String(d.recipientCount == null ? '' : d.recipientCount)));
    u.meta.appendChild(row(t.source, pick(d.source)));
    (d.notes || []).forEach(function (n) { u.meta.appendChild(node('div', 'ep-note', pick(n))); });
    if (!d.html) u.meta.appendChild(node('div', 'ep-note', t.textOnly));
    u.meta.appendChild(node('div', 'ep-only', t.only));
    u.frame.srcdoc = d.html || ('<pre style="white-space:pre-wrap;font:14px/1.5 -apple-system,Segoe UI,Arial,sans-serif;margin:16px;">' + escapeHtml(d.text || '') + '</pre>');
  }
  function fail(msg) {
    var u = build();
    u.title.textContent = T[lang()].title;
    u.meta.innerHTML = '';
    u.meta.appendChild(node('div', 'ep-error', msg || T[lang()].error));
    u.frame.srcdoc = '';
  }
  function headers() {
    var h = { 'content-type': 'application/json' };
    try { if (window.__csrfHeader) { var c = window.__csrfHeader(); for (var k in c) h[k] = c[k]; } } catch (e) {}
    try { if (typeof K === 'string' && K) h['x-admin'] = K; } catch (e) {}
    return h;
  }
  function open(btn) {
    var u = build();
    u.overlay.classList.add('on');
    u.title.textContent = T[lang()].title;
    u.meta.innerHTML = '';
    u.meta.appendChild(node('div', 'ep-note', T[lang()].loading));
    u.frame.srcdoc = '';
    var body = { kind: btn.getAttribute('data-email-preview') };
    var fixed = btn.getAttribute('data-preview-params');
    if (fixed) { try { var o = JSON.parse(fixed); for (var k in o) body[k] = o[k]; } catch (e) {} }
    [['event_id', 'data-preview-event'], ['poll_id', 'data-preview-poll'], ['season', 'data-preview-season']].forEach(function (pair) {
      var v = btn.getAttribute(pair[1]);
      if (v) body[pair[0]] = v;
    });
    var fields = btn.getAttribute('data-preview-fields');
    if (fields) fields.split(',').forEach(function (pair) {
      var bits = pair.split('=');
      var f = document.getElementById(bits[1]);
      if (f) body[bits[0]] = f.value;
    });
    fetch(btn.getAttribute('data-preview-endpoint') || '/admin/comms/preview', {
      method: 'POST', credentials: 'same-origin', headers: headers(), body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (d) {
        if (!res.ok || !d.ok) return fail(pick(d.error));
        show(d);
      });
    }).catch(function () { fail(); });
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-email-preview]') : null;
    if (!b) return;
    e.preventDefault();
    open(b);
  });
})();`;

export const EMAIL_PREVIEW_ASSETS = `<style>
.ep-btn{font:inherit;font-size:12px;font-weight:600;padding:3px 9px;border-radius:4px;border:1px solid #cbd5e1;background:#fff;color:#17457f;cursor:pointer;white-space:nowrap}
.ep-btn:hover{background:#f1f5f9}
.ep-overlay{position:fixed;inset:0;background:rgba(15,23,42,.55);display:none;align-items:center;justify-content:center;z-index:9999;padding:16px}
.ep-overlay.on{display:flex}
.ep-dialog{background:#fff;color:#16181d;border-radius:8px;width:min(720px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.3)}
.ep-head{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #e2e8f0}
.ep-title{font-weight:700;font-size:16px}
.ep-close{font:inherit;font-size:22px;line-height:1;border:none;background:none;cursor:pointer;color:#475569;padding:0 4px}
.ep-meta{padding:10px 16px;font-size:13px;border-bottom:1px solid #e2e8f0;display:grid;gap:4px}
.ep-row{display:flex;gap:8px;flex-wrap:wrap}
.ep-k{color:#64748b;min-width:150px}
.ep-v{font-weight:600;word-break:break-word}
.ep-subject .ep-v{font-size:14px}
.ep-note{color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:4px;padding:4px 8px}
.ep-only{color:#0e7a4f;font-weight:600}
.ep-error{color:#b91c1c;font-weight:600}
.ep-frame{border:0;width:100%;flex:1;min-height:420px;background:#f4f5f8}
</style>
<script>${EMAIL_PREVIEW_CLIENT_JS}</script>`;
