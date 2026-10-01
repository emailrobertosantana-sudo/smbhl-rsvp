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
  // Signup/recovery task (A4): the catch-all path for an unexpected
  // server error during signup/login -- used to have no errorKey at
  // all, falling through to a fully generic client-side fallback.
  SIGNUP_FAILED: { fr: "La création de compte a échoué. Réessaie dans un instant.", en: 'Signup failed. Please try again in a moment.' },
  LOGIN_FAILED: { fr: 'La connexion a échoué. Réessaie dans un instant.', en: 'Login failed. Please try again in a moment.' },
  LEAGUE_CREATE_FAILED: { fr: 'La création de la ligue a échoué. Réessaie dans un instant.', en: 'League creation failed. Please try again in a moment.' },
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
  // Nights (2026-09-30): which games overlap is worked out from their
  // times, so every league game needs both.
  START_TIME_REQUIRED: { fr: "Indique l'heure de début du match.", en: "Add the game's start time." },
  MATCHUP_TEAM_BUSY: { fr: 'Une de ces équipes joue déjà un match à la même heure.', en: 'One of these teams already plays a game at the same time.' },
  GAME_TIME_DOUBLE_BOOKS: { fr: "À cette heure, {players} seraient dans deux matchs en même temps. Retire-les d'un des deux matchs d'abord.", en: 'At this time, {players} would be in two games at once. Take them out of one of the games first.' },
  PLAYER_IN_OVERLAPPING_GAME: { fr: "Ce joueur est déjà inscrit à un match qui se joue en même temps. Retire-le de ce match d'abord.", en: 'This player is already in a game at the same time. Take them out of that game first.' },
  END_TIME_REQUIRED: { fr: "Indique l'heure de fin du match : elle sert à savoir quels matchs se chevauchent.", en: "Add the game's end time: it's how we tell which games overlap." },
  SEASON_REQUIRED: { fr: "Il te faut une saison active avant de créer un match. Lance ta saison depuis le tableau de bord.", en: 'You need an active season before creating an event. Start your season from the dashboard.' },
  EVENT_DATE_EXISTS: { fr: 'Un match existe déjà à cette date dans ta ligue.', en: 'An event already exists for this date in your league.' },
  // "Create multiple events" (src/bulk_events_validation.js): one message
  // per field, shown beside the field.
  // Adding players: the admin has to say whether they are emailed (the
  // Players page answers this one with its own dialog, never as an error).
  ADD_EMAILS_ENABLED_REQUIRED: { fr: 'Indique si les courriels sont activés ou non.', en: 'Say whether emails are on or off.' },
  SUB_CALL_HOURS_INVALID: { fr: 'Choisis un des délais offerts.', en: 'Choose one of the times offered.' },
  DUAL_TEAM_NOT_SHORT: { fr: "Cette équipe ne manque pas de gardien.", en: 'This team is not short a goalie.' },
  DUAL_PLAYER_NOT_AVAILABLE: { fr: 'Ce joueur ne peut pas être mis dans les buts pour ce match.', en: 'This player cannot be put in goal for this game.' },
  DUAL_ACTION_UNKNOWN: { fr: 'Action inconnue.', en: 'Unknown action.' },
  // Terms acceptance (src/terms.js).
  TERMS_NOT_ACCEPTED: { fr: 'Coche la case pour accepter les conditions et la politique de confidentialité.', en: 'Check the box to accept the terms and the privacy policy.' },
  // Payment reminders (src/payment_reminders.js).
  PAYMENT_INFO_MISSING: { fr: "Ajoute d'abord ton courriel ou ton cellulaire pour virement Interac dans les Paramètres.", en: 'Add your e-Transfer email or mobile number in Settings first.' },
  PAYMENT_NOTE_TOO_LONG: { fr: 'La note dépasse 500 caractères.', en: 'The note is over 500 characters.' },
  PAYMENT_NO_PLAYERS: { fr: 'Choisis au moins un joueur.', en: 'Choose at least one player.' },
  PAYMENT_PLAYER_NOT_IN_LEAGUE: { fr: "Un joueur choisi ne fait pas partie de cette ligue.", en: 'A selected player is not in this league.' },
  PAYMENT_OVER_BUDGET: { fr: "Trop de courriels pour aujourd'hui.", en: 'Too many emails for today.' },
  PAYMENT_EMAIL_INVALID: { fr: 'Entre une adresse courriel valide.', en: 'Enter a valid email address.' },
  PAYMENT_PHONE_INVALID: { fr: 'Entre un numéro à 10 chiffres, par exemple 514-555-1234.', en: 'Enter a 10-digit number, for example 514-555-1234.' },
  ADD_NOTICE_REQUIRED: { fr: "Lis d'abord quand ces joueurs recevront leur premier courriel.", en: 'Read first when these players will get their first email.' },
  ADD_EMAIL_CHOICE_REQUIRED: { fr: "Choisis d'abord si ces joueurs reçoivent un courriel.", en: 'Choose first whether these players are emailed.' },
  BULK_FIRST_DATE_REQUIRED: { fr: 'Choisis une première date.', en: 'Choose a first date.' },
  BULK_DATE_INVALID: { fr: "Cette date n'existe pas. Choisis une date valide.", en: 'This date does not exist. Please choose a valid date.' },
  BULK_COUNT_OR_END_REQUIRED: { fr: "Indique un nombre d'événements ou une date de fin.", en: 'Enter a number of events or an end date.' },
  BULK_COUNT_RANGE: { fr: "Le nombre d'événements doit être entre 1 et 52.", en: 'The number of events must be between 1 and 52.' },
  BULK_END_BEFORE_START: { fr: 'La date de fin doit être postérieure à la première date.', en: 'The end date must be after the first date.' },
  BULK_START_TIME_REQUIRED: { fr: 'Choisis une heure de début.', en: 'Choose a start time.' },
  BULK_END_TIME_REQUIRED: { fr: 'Choisis une heure de fin.', en: 'Choose an end time.' },
  BULK_TIMES_EQUAL: { fr: "L'heure de fin doit être différente de l'heure de début.", en: 'The end time must be different from the start time.' },
  BULK_TIME_INVALID: { fr: "Cette heure n'est pas valide.", en: 'This time is not valid.' },
  BULK_NETWORK_ERROR: { fr: "La connexion a échoué. Vérifie ta connexion Internet et réessaie.", en: 'The connection failed. Check your internet connection and try again.' },
  BULK_EVENTS_RECURRENCE_REQUIRED: { fr: 'Indique un nombre de matchs ou une date de fin après la date de départ.', en: 'Provide an occurrence count or an end date after the start date.' },
  EVENT_ID_REQUIRED: { fr: "L'identifiant du match est requis.", en: 'event_id is required.' },
  VENUE_UNKNOWN: { fr: "Ce lieu n'appartient pas à ta ligue.", en: "venue_id must be one of this league's own saved venues." },
  VENUE_NAME_REQUIRED: { fr: 'Le nom du lieu est requis.', en: 'name is required.' },
  VENUE_NAME_TOO_LONG: { fr: 'Le nom du lieu est trop long.', en: 'Name is too long.' },
  VENUE_MAP_LINK_INVALID: { fr: 'Le lien vers la carte doit être une adresse web (http ou https).', en: 'The map link must be a web address (http or https).' },
  VENUE_ID_REQUIRED: { fr: "L'identifiant du lieu est requis.", en: 'id is required.' },
  VENUE_NOT_FOUND: { fr: 'Lieu introuvable.', en: 'Venue not found.' },
  ROUTE_BLOCKED_VENUES: { fr: 'Cette route ne peut pas gérer les lieux de cette ligue.', en: 'This route cannot manage venues for this league.' },
  // Live-testing bug fix (Bug 6 sweep): the event-status page's admin
  // IN/OUT override was reaching these 4 without an errorKey at all --
  // window.__errorText() falls back to the raw English `error` string
  // whenever no key matches, so a French admin hitting one of these
  // (e.g. clicking IN/OUT on a just-locked event) saw untranslated
  // English.
  ADMIN_RSVP_FIELDS_REQUIRED: { fr: 'Des champs requis sont manquants.', en: 'event_id, player_id, and status (in|out) are required.' },
  EVENT_NOT_FOUND: { fr: 'Match introuvable.', en: 'Event not found.' },
  GAME_NOT_STARTED: { fr: "Ce match n'a pas encore commencé. Le résultat et les statistiques s'entrent une fois le match commencé.", en: "This game hasn't started yet. The result and stats can be entered once it has." },
  EVENT_LOCKED: { fr: "Ce match n'accepte plus de changements.", en: 'This event is locked.' },
  // The Schedule list's in-place matchup editor (/league/events/matchup).
  TEAM_NOT_IN_GAME: { fr: 'Cette équipe ne joue pas ce match.', en: "That team isn't playing this game." },
  MATCHUP_TEAMS_REQUIRED: { fr: 'Choisis les deux équipes.', en: 'Choose both teams.' },
  MATCHUP_TEAMS_SAME: { fr: 'Choisis deux équipes différentes.', en: 'Choose two different teams.' },
  MATCHUP_TEAM_UNKNOWN: { fr: "Cette équipe n'est pas dans la saison.", en: 'That team is not in this season.' },
  MATCHUP_PLAYOFF_AUTOMATIC: { fr: 'Les affrontements des séries sont placés automatiquement selon les résultats.', en: 'Playoff matchups are set automatically from results.' },
  PLAYER_NOT_FOUND: { fr: 'Joueur introuvable.', en: 'Player not found.' },
  PLAYER_ID_REQUIRED: { fr: "L'identifiant du joueur est requis.", en: 'player_id is required.' },
  IS_ACTIVE_REQUIRED: { fr: 'is_active doit être vrai ou faux.', en: 'is_active must be true or false.' },
  PLAYER_IDS_REQUIRED: { fr: 'player_ids doit être un tableau.', en: 'player_ids must be an array.' },
  NO_GOALIE_POSITION: { fr: "Cette ligue n'a pas de poste de gardien.", en: 'This league has no goalie position.' },
  ADMIN_INVITE_SUBS_FIELDS_REQUIRED: { fr: 'Des champs requis sont manquants.', en: 'event_id, team, and need (goalie or player) are required.' },
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
  // League finance.
  FINANCE_BAD_AMOUNT: { fr: 'Les montants doivent être des nombres, 0 ou plus.', en: 'Amounts must be numbers, 0 or more.' },
  FINANCE_BAD_MODE: { fr: 'Mode de tarification inconnu.', en: 'Unknown pricing mode.' },
  NO_SHOW_NOT_STARTED: { fr: "Le match n'a pas encore commencé.", en: 'The game has not started yet.' },
  NO_SHOW_HAS_STATS: { fr: "Des statistiques ont été entrées pour ce joueur à ce match : retire-les d'abord.", en: 'Stats were entered for this player in this game: remove them first.' },
  NO_SHOW_NOT_IN: { fr: "Seul un joueur inscrit au match peut être marqué comme absent.", en: 'Only a player marked in for the game can be marked as not having shown.' },
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
  // Schedule-generation redesign task (Group D).
  MATCHUPS_NO_EVENTS: { fr: "Cette ligue n'a pas encore de matchs pour assigner des affrontements. Crée d'abord tes créneaux de gym (Créer un match / Créer plusieurs matchs).", en: "This league has no events yet to assign matchups to. Create your schedule's gym slots first (Create a game / Create multiple games)." },
  MATCHUPS_OVERWRITE_NEEDS_CONFIRM: { fr: 'Ceci écrasera des matchs qui ont déjà un affrontement assigné. Confirme pour continuer.', en: 'This will overwrite games that already have a matchup assigned. Confirm to continue.' },
  // Scheduling correction task (Part 1): ONE POOL OF SLOTS -- refuses
  // outright, explaining the shortfall, rather than inventing a slot
  // for either the regular season or the playoffs.
  MATCHUPS_TOO_FEW_SLOTS: { fr: "Les séries de cette ligue ont besoin de plus de matchs qu'il n'y en a au total dans le calendrier. Crée d'autres matchs, ou réduis le format des séries dans les paramètres.", en: "This league's playoffs need more games than there are events in total. Create more events, or reduce the playoff format in Settings." },
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
  ADVANCED_REMINDERS_OFF: { fr: 'L\'horaire avancé des rappels n\'est pas activé pour ta ligue.', en: 'Advanced reminder timing is not enabled for your league.' },
  FLAG_ALWAYS_ON: { fr: 'Cet indicateur est toujours actif pour cette ligue.', en: 'This flag is always on for this league.' },
  CADENCE_INVALID: { fr: 'Les heures avant le match vont de 1 à 168, et l\'heure de la journée de 0 à 23.', en: 'Hours before the game must be 1 to 168; an hour of the day must be 0 to 23.' },
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
  NETWORK_ERROR: { fr: 'Erreur réseau. Réessaie.', en: 'Network error. Please try again.' },
  // Server messages that used to reach a French page in English: each had
  // an errorKey (or none) with no entry here, so the page fell back to the
  // server's own English text. A count or a name the server puts in its
  // own text is left out: the page cannot fill it in.
  EVENT_SLOT_EXISTS: { fr: 'Un match existe déjà à cette date, à ce lieu et à cette heure dans ta ligue.', en: 'A game already exists for this date, venue and time in your league.' },
  EVENT_HAS_RSVPS: { fr: 'Des joueurs ont déjà répondu pour ce match. Le supprimer effacera leurs réponses. Confirme pour continuer.', en: 'Players have already answered for this game. Deleting it will lose their answers. Confirm to proceed.' },
  SEASON_CLOSED: { fr: "Cette saison est fermée, en lecture seule. Lance une nouvelle saison au lieu de republier une saison fermée.", en: 'This season is closed and read-only. Start a new season instead of republishing a closed one.' },
  SEASON_MOVE_SAME: { fr: "La saison de départ et la saison d'arrivée doivent être différentes.", en: 'The season to move from and the season to move to must be different.' },
  SEASON_MOVE_TARGET_NOT_CURRENT: { fr: "La saison d'arrivée doit être la saison en cours de ta ligue.", en: "The season to move to must be your league's current season." },
  FIXTURE_REQUIRES_FIXED_TEAMS: { fr: 'Offert seulement aux ligues à équipes fixes.', en: 'This is only offered for leagues with fixed teams.' },
  FIXTURE_NEEDS_TWO_TEAMS: { fr: 'Il faut au moins 2 équipes dans ta ligue pour générer un horaire.', en: 'Your league needs at least 2 teams to generate a schedule.' },
  MULTI_ADMIN_DISABLED: { fr: 'Cette ligue est limitée à un seul administrateur.', en: 'This league is limited to a single admin.' },
  ORGANIZER_NOTE_TOO_LONG: { fr: "Le mot de l'organisateur doit compter 500 caractères ou moins.", en: 'The organizer note must be 500 characters or fewer.' },
  PLAYOFFS_REQUIRE_FIXED_TEAMS: { fr: 'Les séries sont offertes seulement aux ligues à équipes fixes.', en: 'Playoffs are only offered for leagues with fixed teams.' },
  INVALID_PLAYOFF_FORMAT: { fr: 'Choisis un format de séries valide.', en: 'Choose a valid playoff format.' },
  PLAYOFF_RESERVED_SLOTS_REQUIRED: { fr: 'Réserve au moins 1 match pour les séries.', en: 'Reserve at least 1 game for the playoffs.' },
  INVALID_PLAYOFF_TEAMS: { fr: "Le nombre d'équipes en séries doit être entre 2 et le nombre d'équipes de ta ligue.", en: 'The number of playoff teams must be between 2 and the number of teams in your league.' },
  INVALID_PLAYOFF_BEST_OF: { fr: 'Une série doit compter au moins 1 match.', en: 'A series must have at least 1 game.' },
  RESULTS_REQUIRE_TEAMS: { fr: "Un résultat a besoin de deux équipes. Ce n'est pas offert pour une ligue sans équipes.", en: 'A game result needs two sides. It is not offered for a league without teams.' },
  RESULTS_NOT_TRACKED: { fr: 'Cette ligue ne suit pas les résultats des matchs.', en: 'This league does not track game results.' },
  NO_MATCHUP_SET: { fr: "Aucun affrontement n'est choisi pour ce match. Choisis-en un avant d'entrer un résultat.", en: 'No matchup is set for this game yet. Set one before entering a score.' },
  DRAW_NOT_TWO_TEAMS: { fr: "Le tirage de ce match n'a pas donné exactement deux équipes. Un résultat en demande deux.", en: 'The draw for this game did not give exactly two teams. A score needs two.' },
  EVENT_CANCELLED: { fr: 'Ce match a été annulé : on ne peut pas y entrer de résultat.', en: 'This game was cancelled and cannot be scored.' },
  INVALID_SCORE: { fr: 'Entre un score pour chaque équipe : un nombre entier, zéro ou plus.', en: 'Enter a score for each team: a whole number, zero or more.' },
  PLAYER_STATS_NOT_TRACKED: { fr: 'Cette ligue ne suit pas les statistiques des joueurs.', en: 'This league does not track player stats.' },
  ENTRIES_REQUIRED: { fr: 'Entre au moins une ligne de statistiques.', en: 'Enter at least one line of stats.' },
  PLAYER_NOT_CONFIRMED: { fr: "Un des joueurs n'était pas confirmé présent à ce match.", en: 'One of the players was not confirmed in for this game.' },
  GOALIE_STATS_REQUIRE_RESULTS: { fr: 'Les statistiques de gardien ont besoin que les résultats des matchs soient activés pour cette ligue.', en: 'Goalie stats need game results turned on for this league.' },
  INVALID_GOALS_AGAINST: { fr: 'Entre les buts accordés de chaque gardien : zéro ou plus.', en: "Enter each goalie's goals against: zero or more." },
  ROUTE_BLOCKED_PREVIEW: { fr: "Cet aperçu n'est pas offert pour cette ligue.", en: 'This preview is not available for this league.' },
  ONBOARDING_STEP_UNKNOWN: { fr: "Cette étape n'existe pas.", en: 'This step does not exist.' },
  LEAGUE_ID_REQUIRED: { fr: "L'identifiant de la ligue est requis.", en: 'The league id is required.' }
};
