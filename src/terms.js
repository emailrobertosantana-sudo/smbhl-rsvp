// Acceptance of the terms of service and the privacy policy (src/legal.js),
// for Notre Ligue admin accounts. Required to create an account (sign-up,
// and a co-admin invitation that creates one); an account with none on
// record, or with one of an older version, is asked once, at its next
// sign-in (/accept-terms). SMBHL's own admin key is not an account and is
// never asked.
//
// Stored in the settings table, one row per account, no migration:
//   key    terms_acceptance:<user id>
//   value  { "at": "<ISO time>", "version": "<LEGAL_VERSION>" }
import { LEGAL_VERSION } from './legal.js';

export const termsKey = userId => `terms_acceptance:${userId}`;

export async function recordTermsAcceptance(db, userId, now = new Date()) {
  await db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(termsKey(userId), JSON.stringify({ at: now.toISOString(), version: LEGAL_VERSION })).run();
}

// An acceptance of the texts as published now.
export const termsAcceptanceCurrent = acceptance => !!acceptance && acceptance.version === LEGAL_VERSION;

export async function getTermsAcceptance(db, userId) {
  try {
    const row = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(termsKey(userId)).first();
    return row && row.value ? JSON.parse(row.value) : null;
  } catch (_) { return null; }
}

// A request's body accepts them only with accept_terms: true.
export const acceptsTerms = body => !!body && body.accept_terms === true;

export const TERMS_REFUSAL = { ok: false, error: 'Check the box to accept the terms and the privacy policy.', errorKey: 'TERMS_NOT_ACCEPTED' };

// The checkbox's label, both terms linked (the pages open in a new tab, so
// a half-filled form is not lost).
export const TERMS_LABEL = {
  fr: "J'accepte les <a href=\"/conditions\" target=\"_blank\" rel=\"noopener\">conditions d'utilisation</a> et la <a href=\"/confidentialite\" target=\"_blank\" rel=\"noopener\">politique de confidentialité</a>",
  en: 'I accept the <a href="/conditions#en" target="_blank" rel="noopener">terms of service</a> and the <a href="/confidentialite#en" target="_blank" rel="noopener">privacy policy</a>'
};
