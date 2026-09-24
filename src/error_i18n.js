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
// Voice pass (design system Part 6): tutoiement throughout, matching
// every rebuilt page's own copy -- this dict is embedded only on the
// new product's pages (signup, login, dashboard, roster, schedule,
// event status, RSVP, public page), never on SMBHL's own /rsvp (see
// this file's own class comment above, and the dedicated isolation
// test that proves it).
export const ERROR_I18N = {
  INVALID_EMAIL: { fr: 'Entre un courriel valide.', en: 'Please enter a valid email address.' },
  WEAK_PASSWORD: { fr: 'Ton mot de passe doit contenir au moins 8 caractères.', en: 'Password must be at least 8 characters.' },
  RATE_LIMITED_SIGNUP: { fr: 'Trop de tentatives de création de compte depuis ce réseau. Réessaie plus tard.', en: 'Too many signup attempts from this network. Please try again later.' },
  RATE_LIMITED_LOGIN: { fr: 'Trop de tentatives de connexion depuis ce réseau. Réessaie plus tard.', en: 'Too many login attempts from this network. Please try again later.' },
  RATE_LIMITED_RESET: { fr: 'Trop de tentatives de réinitialisation depuis ce réseau. Réessaie plus tard.', en: 'Too many reset attempts from this network. Please try again later.' },
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
  LEAGUE_NO_ACCESS: { fr: "Tu n'as pas accès à cette ligue.", en: 'You do not have access to this league.' },
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
  INVALID_ROLE: { fr: 'Le rôle doit être régulier ou remplaçant.', en: 'role must be roster or sub_skater.' },
  CONTACT_EMAIL_EXISTS: { fr: 'Un contact avec ce courriel existe déjà dans ta ligue.', en: 'A contact with this email already exists in your league.' },
  BULK_CONTACTS_REQUIRED: { fr: 'Aucun joueur à importer.', en: 'No contacts provided.' },
  ROUTE_BLOCKED_EVENTS: { fr: 'Cette route ne peut pas créer de matchs pour cette ligue.', en: 'This route cannot create events for this league.' },
  DATE_REQUIRED: { fr: 'La date est requise, au format AAAA-MM-JJ.', en: 'date is required, in YYYY-MM-DD format.' },
  START_TIME_FORMAT: { fr: "L'heure de début doit être au format HH:MM.", en: 'start_time must be in HH:MM format.' },
  END_TIME_FORMAT: { fr: "L'heure de fin doit être au format HH:MM.", en: 'end_time must be in HH:MM format.' },
  SEASON_REQUIRED: { fr: "Il te faut une saison active avant de créer un match. Lance ta saison depuis le tableau de bord.", en: 'You need an active season before creating an event. Start your season from the dashboard.' },
  EVENT_DATE_EXISTS: { fr: 'Un match existe déjà à cette date dans ta ligue.', en: 'An event already exists for this date in your league.' },
  BULK_EVENTS_RECURRENCE_REQUIRED: { fr: 'Indique un nombre de matchs ou une date de fin après la date de départ.', en: 'Provide an occurrence count or an end date after the start date.' },
  EVENT_ID_REQUIRED: { fr: "L'identifiant du match est requis.", en: 'event_id is required.' },
  // Live-testing bug fix (Bug 6 sweep): the event-status page's admin
  // IN/OUT override was reaching these 4 without an errorKey at all --
  // window.__errorText() falls back to the raw English `error` string
  // whenever no key matches, so a French admin hitting one of these
  // (e.g. clicking IN/OUT on a just-locked event) saw untranslated
  // English.
  ADMIN_RSVP_FIELDS_REQUIRED: { fr: 'Des champs requis sont manquants.', en: 'event_id, player_id, and status (in|out) are required.' },
  EVENT_NOT_FOUND: { fr: 'Match introuvable.', en: 'Event not found.' },
  EVENT_LOCKED: { fr: "Ce match n'accepte plus de changements.", en: 'This event is locked.' },
  PLAYER_NOT_FOUND: { fr: 'Joueur introuvable.', en: 'Player not found.' },
  PLAYER_ID_REQUIRED: { fr: "L'identifiant du joueur est requis.", en: 'player_id is required.' },
  NO_GOALIE_POSITION: { fr: "Cette ligue n'a pas de poste de gardien.", en: 'This league has no goalie position.' },
  ADMIN_INVITE_SUBS_FIELDS_REQUIRED: { fr: 'Des champs requis sont manquants.', en: 'event_id, team, and need (goalie|skater) are required.' },
  TEAM_UNKNOWN: { fr: 'Équipe inconnue pour cette ligue.', en: 'Unknown team for this league.' },
  SEASON_NAME_REQUIRED: { fr: 'Le nom de la saison est requis.', en: 'season_name is required.' },
  ROUTE_BLOCKED_PUBLISH: { fr: 'Cette route ne peut pas publier dans les données de cette ligue.', en: "This route cannot publish to this league's data." },
  NO_TEAM_NAMES: { fr: "Cette ligue n'a pas encore de noms d'équipe enregistrés.", en: 'This league has no team names on file yet.' },
  LEAGUE_NAME_REQUIRED: { fr: 'Le nom de la ligue est requis.', en: 'League name is required.' },
  MIN_TEAM_NAMES: { fr: "Au moins 2 noms d'équipe sont requis.", en: 'At least 2 team names are required.' },
  HEADCOUNT_LIMITS_REQUIRED: { fr: 'Un nombre minimum et maximum de joueurs est requis.', en: 'A minimum and maximum player count are required.' },
  HEADCOUNT_MAX_TOO_LOW: { fr: 'Le maximum doit être au moins égal au minimum.', en: 'The maximum must be at least the minimum.' },
  HEADCOUNT_MIN_GOALIES_INVALID: { fr: 'Le minimum de gardiens doit être zéro ou plus.', en: 'Minimum goalies must be zero or more.' },
  HEADCOUNT_MIN_GOALIES_TOO_HIGH: { fr: "Le minimum de gardiens ne peut pas dépasser le maximum de joueurs.", en: "Minimum goalies can't be more than the maximum player count." },
  HEADCOUNT_MAX_GOALIES_INVALID: { fr: 'Le maximum de gardiens doit être zéro ou plus.', en: 'Maximum goalies must be zero or more.' },
  HEADCOUNT_MAX_GOALIES_TOO_LOW: { fr: 'Le maximum de gardiens doit être au moins égal au minimum.', en: 'The maximum goalies must be at least the minimum.' },
  ROSTER_LIMITS_REQUIRED: { fr: 'Un nombre minimum et maximum de joueurs est requis ensemble.', en: 'A minimum and maximum player count are required together.' },
  ROSTER_MAX_TOO_LOW: { fr: 'Le maximum doit être au moins égal au minimum.', en: 'The maximum must be at least the minimum.' },
  MIN_GOALIES_INVALID: { fr: 'Le minimum de gardiens doit être zéro ou plus.', en: 'Minimum goalies must be zero or more.' },
  MAX_GOALIES_INVALID: { fr: 'Le maximum de gardiens doit être zéro ou plus.', en: 'Maximum goalies must be zero or more.' },
  MAX_GOALIES_TOO_LOW: { fr: 'Le maximum de gardiens doit être au moins égal au minimum.', en: 'The maximum goalies must be at least the minimum.' },
  NOT_WEEKLY_DRAW: { fr: "Cette ligue n'assigne pas les équipes par match.", en: 'This league does not assign teams per event.' },
  INVALID_TEAM_STRUCTURE: { fr: "La structure doit être 'équipes fixes', 'aucune équipe' ou 'équipes chaque semaine'.", en: "team_structure must be 'fixed', 'headcount', or 'weekly_draw'." },
  ASSIGN_TEAM_FIELDS_REQUIRED: { fr: 'Des champs requis sont manquants.', en: 'event_id, player_id, and team are required.' },
  ASSIGN_TEAM_NOT_CONFIRMED: { fr: 'Seul un joueur confirmé peut être assigné à une équipe.', en: 'Only a confirmed player can be assigned to a team.' },
  LEAGUE_NOT_FOUND: { fr: 'Ligue introuvable.', en: 'League not found.' },
  ROUTE_BLOCKED_SETTINGS: { fr: 'Cette route ne peut pas modifier les paramètres de cette ligue.', en: 'This route cannot update this league.' },
  INVALID_COLOR: { fr: 'La couleur doit être une valeur hexadécimale comme #b3122e.', en: 'Colour must be a hex value like #b3122e.' },
  NO_TEAMS_TO_EDIT: { fr: "Cette ligue n'a pas de noms d'équipe à modifier.", en: 'This league has no team names to edit.' },
  SEASON_NOT_FOUND: { fr: 'Aucune saison publiée avec ce nom.', en: 'No published season with that name.' },
  TEAM_HAS_GAMES: { fr: "L'équipe « {team} » a des matchs enregistrés et ne peut pas être retirée.", en: 'The team "{team}" has recorded games and cannot be removed.' },
  TEAM_HAS_PLAYERS: { fr: "L'équipe « {team} » a encore des joueurs assignés et ne peut pas être retirée.", en: 'The team "{team}" still has players assigned to it and cannot be removed.' },
  BROADCAST_FIELDS_REQUIRED: { fr: 'Le sujet et le message sont requis.', en: 'Subject and message are required.' },
  BROADCAST_EVENT_REQUIRED: { fr: 'Un match est requis pour cibler par statut de présence.', en: 'A game is required to target by RSVP status.' },
  BROADCAST_INVALID_TARGET: { fr: 'Cible de destinataires invalide.', en: 'Invalid recipient target.' },
  ROUTE_BLOCKED_BROADCAST: { fr: "Cette route ne peut pas diffuser pour cette ligue.", en: 'This route cannot broadcast for this league.' },
  INVALID_PUBLIC_THEME: { fr: "Le thème doit être 'arene' ou 'clean'.", en: "Theme must be 'arene' or 'clean'." },
  ALREADY_ADMIN: { fr: 'Cette personne est déjà administratrice de cette ligue.', en: 'This person is already an admin of this league.' },
  LEAGUE_GONE: { fr: "Cette ligue n'existe plus.", en: 'League no longer exists.' },
  LOGIN_AS_EMAIL: { fr: 'Connecte-toi en tant que {email} pour accepter cette invitation.', en: 'Please log in as {email} to accept this invite.' },
  CONFIRM_NAME_MISMATCH: { fr: 'Le texte de confirmation ne correspond pas au nom de la ligue.', en: 'Confirmation text does not match the league name.' },
  SLUG_INVALID_FORMAT: { fr: "L'adresse doit contenir seulement des lettres minuscules, des chiffres et des traits d'union.", en: 'The URL must contain only lowercase letters, numbers, and hyphens.' },
  SLUG_TAKEN: { fr: 'Cette adresse est déjà utilisée par une autre ligue.', en: 'This URL is already used by another league.' },
  SLUG_RESERVED: { fr: 'Cette adresse est réservée. Choisis-en une autre.', en: 'This URL is reserved. Please choose another one.' },
  INVALID_LANGUAGE_MODE: { fr: "La langue doit être 'les deux', 'français' ou 'anglais'.", en: "Language must be 'both', 'fr', or 'en'." },
  NO_SETTINGS_PROVIDED: { fr: 'Aucun réglage fourni.', en: 'No settings provided.' },
  AUTO_DRAW_HOURS_INVALID: { fr: 'Le nombre d\'heures avant le match doit être au moins 1.', en: 'Auto-draw hours-before must be at least 1.' },
  NO_UPCOMING_EVENT: { fr: 'Aucun prochain match trouvé.', en: 'No upcoming event found.' },

  // Client-side-only validation keys (no server round trip needed for
  // these -- checked in the page's own JS before submitting -- but
  // kept in this same shared dictionary so there's exactly one source
  // of truth, not a second one-off translation system for these).
  EMAIL_REQUIRED_CLIENT: { fr: 'Le courriel est requis.', en: 'Email is required.' },
  EMAIL_PASSWORD_REQUIRED_CLIENT: { fr: 'Entre ton courriel et ton mot de passe.', en: 'Please enter your email and password.' },
  LEAGUE_NAME_REQUIRED_CLIENT: { fr: 'Le nom de la ligue est requis.', en: 'League name is required.' },
  MIN_TEAM_NAMES_CLIENT: { fr: "Entre au moins 2 noms d'équipe.", en: 'Please enter at least 2 team names.' },
  NAME_REQUIRED_CLIENT: { fr: 'Le nom est requis.', en: 'Name is required.' },
  DATE_REQUIRED_CLIENT: { fr: 'La date est requise.', en: 'Date is required.' },
  SEASON_NAME_REQUIRED_CLIENT: { fr: 'Le nom de la saison est requis.', en: 'Season name is required.' },
  NETWORK_ERROR: { fr: 'Erreur réseau. Réessaie.', en: 'Network error. Please try again.' }
};
