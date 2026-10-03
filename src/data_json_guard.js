// The guard before SMBHL's data_json is written (data_json guard batch,
// item 2). data_json is read by rsvp.smbhl.com and smbhl.com; in September
// 2026 it was written twice with text garbled by a Windows console
// (src/mojibake.js). Every code path that writes it goes through
// putDataJson: when any string is garbled, nothing is written (the current
// value stays), Roberto gets one operator alert listing each damaged string
// and its path (src/health.js postWebhook: the alert email and the
// webhook), and the caller gets an error to show the admin.
import { findMojibake } from './mojibake.js';
import { postWebhook } from './health.js';

export const DATA_JSON_DAMAGED = 'DATA_JSON_DAMAGED';
const ALERTED_PREFIX = 'datajson_guard:';
const SHOWN = 30;

export class DataJsonDamagedError extends Error {
  constructor(damaged) {
    const first = damaged[0] || { path: '', value: '' };
    super(`Pas enregistré : du texte endommagé (mauvais encodage) a été trouvé dans data.json, ${damaged.length > 1 ? `${damaged.length} textes, dont` : 'à'} ${first.path} « ${String(first.value).slice(0, 60)} ». `
      + "La version actuelle est gardée et Roberto a été averti. / "
      + `Not saved: damaged text (wrong encoding) was found in data.json, ${damaged.length > 1 ? `${damaged.length} texts, including` : 'at'} ${first.path} "${String(first.value).slice(0, 60)}". `
      + 'The current version is kept and Roberto has been told.');
    this.name = 'DataJsonDamagedError';
    this.dataJsonDamaged = true;
    this.damaged = damaged;
  }
  // The admin's answer: the routes' { ok, error } shape, 422.
  response() {
    return Response.json({ ok: false, error: this.message, errorKey: DATA_JSON_DAMAGED, damaged: this.damaged.slice(0, SHOWN) }, { status: 422 });
  }
}

// A short, stable fingerprint of what was refused, so a retried write of
// the same damaged text alerts once.
function fingerprint(damaged) {
  let h = 0;
  for (const d of damaged) for (const c of d.path + '\u0000' + d.value) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36) + ':' + damaged.length;
}

async function alertOnce(env, damaged, source) {
  const key = ALERTED_PREFIX + fingerprint(damaged);
  try {
    if (env.DB) {
      const r = await env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').bind(key, new Date().toISOString()).run();
      if (r && r.meta && r.meta.changes === 0) return false;
    }
  } catch (e) { console.error('[data_json guard] alert marker not written'); }
  const lines = damaged.slice(0, SHOWN).map(d => `- ${d.path} : ${JSON.stringify(String(d.value).slice(0, 120))}`).join('\n');
  const more = damaged.length > SHOWN ? `\n(+ ${damaged.length - SHOWN})` : '';
  const title = 'SMBHL : data_json refusé, texte endommagé / data_json refused, damaged text';
  const text = `Écriture de data_json refusée (${source}) : ${damaged.length} ${damaged.length > 1 ? 'textes endommagés' : 'texte endommagé'} (encodage). La version actuelle est gardée.\n\n`
    + `data_json write refused (${source}): ${damaged.length} damaged ${damaged.length > 1 ? 'texts' : 'text'} (encoding). The current version is kept.\n\n${lines}${more}`;
  await postWebhook(env, title, text);
  return true;
}

// The check alone: [] when the text is clean (or not JSON: nothing to read).
export function damagedInDataJson(text) {
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch (_) { return []; }
  return findMojibake(data);
}

// Writes SMBHL's data_json, or refuses: throws DataJsonDamagedError (after
// the alert) when any string is garbled. source: who was writing, for the
// alert (« review publish », « teams move »...).
export async function putDataJson(env, text, source = '') {
  const damaged = damagedInDataJson(text);
  if (damaged.length) throw await refuseDamaged(env, damaged, source);
  await env.SHEETS_KV.put('data_json', text);
}

// A write refused before it is built (a route checking what it was sent):
// the same alert, once, and the error to show. damaged: findMojibake's list.
export async function refuseDamaged(env, damaged, source = '') {
  console.error(`[data_json guard] write refused (${source}): ${damaged.length} damaged`);
  try { await alertOnce(env, damaged, source); } catch (e) { console.error('[data_json guard] alert not sent'); }
  return new DataJsonDamagedError(damaged);
}
