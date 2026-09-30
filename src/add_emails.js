// "Email players when they are added": a league's own setting.
//
// What adding a player sends, today: a regular player gets nothing at the
// moment they are added (their first email is the game's next scheduled
// reminder). A substitute is called right away, by email, when a game in
// the coming days is short at their position: that is the email this
// setting is about. Importing twenty substitutes the day before a short
// game sent twenty emails with no warning.
//
// The setting lives in the settings table, one row per league (no column,
// no migration), like the league's email cadence:
//   key    league_add_emails:<league id>
//   value  { "mode": "on" | "off", "held": ["<player id>", ...],
//            "regularNotice": true }
// No row, or no mode: the admin has not chosen yet. The first time an add
// or an import would email someone, they are asked first.
//
// regularNotice: true once the notice for regular players (they get no
// email when added; here is when their first one comes) has been shown in
// this league. It is shown once per league.
//
// held: substitutes added without emailing. The automatic sub calls skip
// them (index.js callSubs, league product only) until an admin invites
// subs by hand for a game, or turns the setting back on: either one
// empties the list. SMBHL has no such row and is never read for one.
export const addEmailsKey = leagueId => `league_add_emails:${leagueId}`;

export async function getAddEmails(db, leagueId) {
  const out = { mode: null, held: [], regularNotice: false };
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(addEmailsKey(leagueId)).first();
    if (row && row.value) {
      const v = JSON.parse(row.value);
      if (v && (v.mode === 'on' || v.mode === 'off')) out.mode = v.mode;
      if (v && Array.isArray(v.held)) out.held = v.held.filter(x => typeof x === 'string');
      if (v && v.regularNotice === true) out.regularNotice = true;
    }
  } catch (_) {}
  return out;
}

// value: the fields to change; the others keep what is stored.
export async function saveAddEmails(db, leagueId, value) {
  const cur = await getAddEmails(db, leagueId);
  const merged = { ...cur, ...value };
  const v = { mode: merged.mode === 'on' || merged.mode === 'off' ? merged.mode : null, held: [...new Set(merged.held || [])], regularNotice: merged.regularNotice === true };
  await db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(addEmailsKey(leagueId), JSON.stringify(v)).run();
  return v;
}
