// The name a contact is shown under, on every page that lists people.
//
// Sources, in this order; the first non-empty one wins:
//   1. contacts.name in D1. The admin pages keep it current, so it wins
//      over everything else.
//   2. The roster in data.json (players[].name), matched by the exact id.
//      Never with the league prefix stripped: the P9xxx sub numbers were
//      issued twice, once bare and once as 'smbhl:P9xxx', so 'P9008' and
//      'smbhl:P9008' are two different people.
// When neither has a name, the raw key ('smbhl:P9008') is never shown.
// Instead: « (sans nom) / (no name) » followed by the masked email, so the
// admin can still tell who it is. When the contact row itself is gone (a
// sub call or a send left behind by a deleted contact), there is no email
// to show, and the label says the contact was deleted.

export const NO_NAME_LABEL = '(sans nom) / (no name)';
export const DELETED_CONTACT_LABEL = '(contact supprimé) / (deleted contact)';

// 'olivier@gmail.com' -> 'o***@gmail.com'. Anything that is not an address
// gives ''.
export function maskEmail(email) {
  const s = String(email || '').trim();
  const at = s.indexOf('@');
  if (at < 1 || at === s.length - 1) return '';
  return `${s[0]}***@${s.slice(at + 1)}`;
}

// players[] from data.json -> Map(id -> name), for source 2.
export function rosterNameMap(players) {
  const map = new Map();
  for (const p of players || []) {
    const name = String((p && p.name) || '').trim();
    if (p && p.id && name) map.set(String(p.id), name);
  }
  return map;
}

// contact: the contacts row (or null when there is none).
// roster: a Map from rosterNameMap(), or a Map whose values carry .name
// (getPlayerStats's map), or nothing.
// id: the key the row was looked up by, for the roster match.
export function contactDisplayName({ contact = null, roster = null, id = null } = {}) {
  const fromContact = String((contact && contact.name) || '').trim();
  if (fromContact) return fromContact;
  const key = String(id || (contact && contact.player_id) || '');
  const r = roster && key ? roster.get(key) : null;
  const fromRoster = String((r && typeof r === 'object' ? r.name : r) || '').trim();
  if (fromRoster) return fromRoster;
  if (!contact) return DELETED_CONTACT_LABEL;
  const masked = maskEmail(contact.email);
  return masked ? `${NO_NAME_LABEL} ${masked}` : NO_NAME_LABEL;
}
