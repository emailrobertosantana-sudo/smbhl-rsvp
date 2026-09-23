/**
 * error_i18n.js — single shared dictionary for every server-returned
 * API error string that a real page can display to a user.
 *
 * Design (Part 1, overnight follow-up task): the FR/EN toggle built
 * earlier only ever translated STATIC page markup (data-i18n +
 * per-page dict + applyLanguage()) — every server-returned `error`
 * string was still shown verbatim in whatever language the code
 * happened to write it in, completely bypassing the toggle. Rather
 * than hand-translate each string in place (two parallel systems),
 * every route that returns a user-facing error now ALSO returns an
 * `errorKey` alongside the existing `error` field. `error` itself is
 * left byte-for-byte unchanged (still English, still whatever text
 * existed before) so nothing that already asserts on that exact string
 * (tests, any external API consumer) breaks. `errorKey` is new,
 * additive, and is what the client actually displays: every page's
 * error-rendering code now resolves it through this same dictionary,
 * via the shared window.__errorText() helper added to page()'s script
 * (src/index.js) — the exact same data-i18n-dictionary PATTERN already
 * used for static content, just one shared instance instead of a
 * per-page copy, since error keys are used across many pages.
 *
 * A handful of genuinely unexpected, exception-message-suffixed errors
 * (`'Signup failed: ' + err.message`, `'Login failed: ' + err.message`,
 * `'League creation failed: ' + err.message`) deliberately have NO key
 * — window.__errorText() falls back to the raw server string when no
 * key is given or matched, and a raw JS exception message isn't
 * meaningfully translatable anyway. Same for handleVerifyEmail's
 * response (hit by a browser navigating a link, not read by any page's
 * JS at all).
 *
 * One key, LOGIN_AS_EMAIL, needs a dynamic value (the invited email)
 * — window.__errorText(key, fallback, vars) supports simple
 * {placeholder} substitution, the same convention SMBHL's own existing
 * I18N_RECAP dict already uses elsewhere in this app (e.g.
 * "Emails successfully sent to {count} players!").
 */
export const ERROR_I18N = {
  INVALID_EMAIL: { fr: 'Veuillez entrer un courriel valide.', en: 'Please enter a valid email address.' },
  WEAK_PASSWORD: { fr: 'Le mot de passe doit contenir au moins 8 caractères.', en: 'Password must be at least 8 characters.' },
  RATE_LIMITED_SIGNUP: { fr: 'Trop de tentatives de création de compte depuis ce réseau. Veuillez réessayer plus tard.', en: 'Too many signup attempts from this network. Please try again later.' },
  RATE_LIMITED_LOGIN: { fr: 'Trop de tentatives de connexion depuis ce réseau. Veuillez réessayer plus tard.', en: 'Too many login attempts from this network. Please try again later.' },
  RATE_LIMITED_RESET: { fr: 'Trop de tentatives de réinitialisation depuis ce réseau. Veuillez réessayer plus tard.', en: 'Too many reset attempts from this network. Please try again later.' },
  EMAIL_EXISTS: { fr: 'Un compte avec ce courriel existe déjà.', en: 'An account with this email already exists.' },
  INVALID_CREDENTIALS: { fr: 'Courriel ou mot de passe invalide.', en: 'Invalid email or password.' },
  MISSING_TOKEN: { fr: 'Jeton manquant.', en: 'Missing token' },
  AUTH_REQUIRED: { fr: 'Authentification requise.', en: 'Authentication required.' },
  CSRF_INVALID: { fr: 'Jeton CSRF invalide ou manquant.', en: 'Invalid or missing CSRF token.' },
  ACCOUNT_NOT_FOUND: { fr: 'Compte introuvable.', en: 'Account not found.' },
  LINK_EXPIRED: { fr: 'Ce lien a expiré.', en: 'This link has expired.' },
  LINK_MALFORMED: { fr: 'Ce lien est invalide.', en: 'This link is invalid.' },
  LINK_INVALID: { fr: 'Ce lien est invalide.', en: 'This link is invalid.' },

  LEAGUE_DEACTIVATED: { fr: 'Cette ligue a été désactivée.', en: 'This league has been deactivated.' },
  LEAGUE_NO_ACCESS: { fr: "Vous n'avez pas accès à cette ligue.", en: 'You do not have access to this league.' },
  NO_LEAGUE_FOUND: { fr: 'Aucune ligue trouvée pour ce compte.', en: 'No league found for this account.' },
  // Deliberately generic here (never names SMBHL), even though the raw
  // server `error` field still does (unchanged, for logs/API
  // consumers) -- this dict is embedded once in page()'s SHARED shell
  // script, used by every league's page, so a literal "SMBHL" here
  // would leak onto every other league's branded page too (found via
  // test/part2_league_branding.spec.js's own not.toContain('SMBHL')
  // isolation check).
  ROUTE_BLOCKED_CONTACTS: { fr: 'Cette route ne peut pas créer de contacts pour cette ligue.', en: 'This route cannot create contacts for this league.' },
  FULL_NAME_REQUIRED: { fr: 'Le nom complet (prénom et nom) est requis.', en: 'Full name (first and last) is required.' },
  NAME_TOO_LONG: { fr: 'Le nom est trop long.', en: 'Name is too long.' },
  INVALID_ROLE: { fr: 'Le rôle doit être régulier, sub joueur ou sub gardien.', en: 'role must be roster, sub_skater, or sub_goalie.' },
  CONTACT_EMAIL_EXISTS: { fr: 'Un contact avec ce courriel existe déjà dans votre ligue.', en: 'A contact with this email already exists in your league.' },
  ROUTE_BLOCKED_EVENTS: { fr: 'Cette route ne peut pas créer de matchs pour cette ligue.', en: 'This route cannot create events for this league.' },
  DATE_REQUIRED: { fr: 'La date est requise, au format AAAA-MM-JJ.', en: 'date is required, in YYYY-MM-DD format.' },
  START_TIME_FORMAT: { fr: "L'heure de début doit être au format HH:MM.", en: 'start_time must be in HH:MM format.' },
  END_TIME_FORMAT: { fr: "L'heure de fin doit être au format HH:MM.", en: 'end_time must be in HH:MM format.' },
  SEASON_REQUIRED: { fr: "Une saison est requise (publiez d'abord une saison via /league/season/publish, ou spécifiez-en une).", en: 'season is required (publish a season first via /league/season/publish, or pass one explicitly).' },
  EVENT_DATE_EXISTS: { fr: 'Un match existe déjà à cette date dans votre ligue.', en: 'An event already exists for this date in your league.' },
  SEASON_NAME_REQUIRED: { fr: 'Le nom de la saison est requis.', en: 'season_name is required.' },
  ROUTE_BLOCKED_PUBLISH: { fr: 'Cette route ne peut pas publier dans les données de cette ligue.', en: "This route cannot publish to this league's data." },
  NO_TEAM_NAMES: { fr: "Cette ligue n'a pas encore de noms d'équipe enregistrés.", en: 'This league has no team names on file yet.' },
  LEAGUE_NAME_REQUIRED: { fr: 'Le nom de la ligue est requis.', en: 'League name is required.' },
  MIN_TEAM_NAMES: { fr: "Au moins 2 noms d'équipe sont requis.", en: 'At least 2 team names are required.' },
  LEAGUE_NOT_FOUND: { fr: 'Ligue introuvable.', en: 'League not found.' },
  ALREADY_ADMIN: { fr: 'Cette personne est déjà administratrice de cette ligue.', en: 'This person is already an admin of this league.' },
  LEAGUE_GONE: { fr: "Cette ligue n'existe plus.", en: 'League no longer exists.' },
  LOGIN_AS_EMAIL: { fr: 'Veuillez vous connecter en tant que {email} pour accepter cette invitation.', en: 'Please log in as {email} to accept this invite.' },
  CONFIRM_NAME_MISMATCH: { fr: 'Le texte de confirmation ne correspond pas au nom de la ligue.', en: 'Confirmation text does not match the league name.' },

  // Client-side-only validation keys (no server round trip needed for
  // these -- checked in the page's own JS before submitting -- but
  // kept in this same shared dictionary so there's exactly one source
  // of truth, not a second one-off translation system for these).
  EMAIL_REQUIRED_CLIENT: { fr: 'Le courriel est requis.', en: 'Email is required.' },
  EMAIL_PASSWORD_REQUIRED_CLIENT: { fr: 'Veuillez entrer votre courriel et mot de passe.', en: 'Please enter your email and password.' },
  LEAGUE_NAME_REQUIRED_CLIENT: { fr: 'Le nom de la ligue est requis.', en: 'League name is required.' },
  MIN_TEAM_NAMES_CLIENT: { fr: "Veuillez entrer au moins 2 noms d'équipe.", en: 'Please enter at least 2 team names.' },
  NAME_REQUIRED_CLIENT: { fr: 'Le nom est requis.', en: 'Name is required.' },
  DATE_REQUIRED_CLIENT: { fr: 'La date est requise.', en: 'Date is required.' },
  SEASON_NAME_REQUIRED_CLIENT: { fr: 'Le nom de la saison est requis.', en: 'Season name is required.' },
  NETWORK_ERROR: { fr: 'Erreur réseau. Veuillez réessayer.', en: 'Network error. Please try again.' }
};
