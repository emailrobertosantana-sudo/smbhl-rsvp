// Small, shared, dependency-free validation helpers. Extracted out of
// index.js so leagues.js (which index.js itself imports from — a reverse
// import would be circular) can reuse the exact same email validation as
// every existing contact-creation/email-update path, instead of a second,
// possibly-drifting copy.

export function sanitizeAndValidateEmail(raw) {
  if (!raw || typeof raw !== 'string') return { valid: false, email: '', error: 'Courriel requis / Email required' };
  let email = raw.trim().toLowerCase();
  // Auto-convert accidental commas to dots (e.g. "frederick,crevier@hec,ca" -> "frederick.crevier@hec.ca")
  email = email.replace(/,/g, '.');
  // Strip any whitespace
  email = email.replace(/\s+/g, '');
  const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
  if (!emailRegex.test(email)) {
    return { valid: false, email, error: 'Format de courriel invalide / Invalid email format' };
  }
  return { valid: true, email };
}
