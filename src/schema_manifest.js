// GENERATED FILE -- do not hand-edit.
// Produced by scripts/generate_schema_manifest.js from
// test/support/base_schema_v1.sql +
// all migrate-*.sql files (49 files parsed, as of this
// generation). Re-run that script after adding a new migration, then
// run the full test suite -- test/schema_manifest.spec.js fails loudly
// if this file and the real migrated schema disagree.
//
// Consumed by src/schema_guard.js (the runtime drift check) and
// scripts/check_schema_remote.js (the pre-deploy check) -- both compare
// this list against a real database's actual PRAGMA table_info output.
// This is the single source of truth both share.
//
// 27 tables, 247 columns tracked.
export const SCHEMA_MANIFEST = {
  "availability": [
    "answered_at",
    "event_id",
    "league_id",
    "need",
    "player_id",
    "status"
  ],
  "contacts": [
    "answered_ever",
    "archive_reason",
    "asked_streak",
    "dormant",
    "email",
    "is_active",
    "is_backup_goalie",
    "is_goalie",
    "is_sub",
    "last_asked",
    "last_played",
    "league_id",
    "name",
    "opted_out",
    "phone",
    "player_id",
    "position",
    "preferred_team",
    "previous_role",
    "role",
    "token_salt"
  ],
  "events": [
    "auto_reminders_enabled",
    "away_score",
    "away_team",
    "date",
    "end_time",
    "home_score",
    "home_team",
    "id",
    "is_playoff",
    "league_id",
    "playoff_meta",
    "result_entered_at",
    "season",
    "start_time",
    "state",
    "venue",
    "venue_address",
    "venue_id",
    "venue_map_link",
    "week"
  ],
  "jobs": [
    "event_id",
    "job",
    "league_id",
    "ran_at"
  ],
  "league_admins": [
    "created_at",
    "league_id",
    "role",
    "user_id"
  ],
  "league_auto_draw_log": [
    "assigned_count",
    "drawn_at",
    "event_id",
    "league_id"
  ],
  "league_capability_flags": [
    "enabled",
    "flag_key",
    "league_id",
    "updated_at"
  ],
  "league_hard_delete_log": [
    "deleted_at",
    "deleted_by_user_id",
    "deleted_via",
    "league_id",
    "league_name",
    "rows_deleted",
    "users_deleted"
  ],
  "league_mail_failure_log": [
    "error",
    "event_id",
    "failed_at",
    "id",
    "kind",
    "league_id",
    "player_id"
  ],
  "league_reminder_log": [
    "event_id",
    "kind",
    "league_id",
    "recipient_count",
    "sent_at",
    "skipped"
  ],
  "league_team_assigned_email_log": [
    "event_id",
    "player_id",
    "sent_at"
  ],
  "leagues": [
    "auto_draw_enabled",
    "auto_draw_hours_before",
    "color",
    "created_at",
    "created_by",
    "deactivated_at",
    "division_label",
    "id",
    "language_mode",
    "max_goalies",
    "max_players",
    "min_goalies",
    "min_players",
    "name",
    "organizer_note",
    "plan_tier",
    "playoff_best_of",
    "playoff_format",
    "playoff_reserved_slots",
    "playoff_teams",
    "playoff_third_place",
    "playoffs_enabled",
    "public_page_enabled",
    "public_theme",
    "reminder_12h_enabled",
    "reminder_24h_enabled",
    "reminder_72h_enabled",
    "slug",
    "sport_type",
    "team_colors",
    "team_count",
    "team_names",
    "team_structure",
    "tracks_player_stats",
    "tracks_results",
    "tracks_stats"
  ],
  "outbox": [
    "cancelled",
    "created_at",
    "dedup_key",
    "error",
    "event_id",
    "id",
    "kind",
    "league_id",
    "payload",
    "player_id",
    "send_after",
    "sent_at",
    "team"
  ],
  "planned_absences": [
    "created_at",
    "date",
    "id",
    "league_id",
    "player_id",
    "reason",
    "season"
  ],
  "player_dues": [
    "adjustment",
    "amount_paid",
    "custom_due",
    "league_id",
    "notes",
    "player_id",
    "season",
    "updated_at"
  ],
  "player_game_stats": [
    "assists",
    "event_id",
    "goals",
    "goals_against",
    "league_id",
    "player_id",
    "role",
    "team",
    "updated_at"
  ],
  "poll_votes": [
    "candidate_id",
    "candidate_name",
    "created_at",
    "id",
    "league_id",
    "poll_id",
    "updated_at",
    "voter_id"
  ],
  "polls": [
    "allow_subs",
    "category",
    "closed_at",
    "created_at",
    "description",
    "id",
    "last_sent_at",
    "league_id",
    "season",
    "sent_count",
    "show_on_rsvp",
    "show_results",
    "state",
    "target_position",
    "title"
  ],
  "rsvp": [
    "claimed_at",
    "event_id",
    "guest_name",
    "league_id",
    "player_id",
    "role",
    "status",
    "status_by",
    "team",
    "updated_at"
  ],
  "season_costs": [
    "amount",
    "category",
    "created_at",
    "description",
    "id",
    "league_id",
    "season",
    "updated_at"
  ],
  "season_pricing": [
    "etransfer_phone",
    "league_id",
    "price_goalie",
    "price_player",
    "price_sub_goalie",
    "price_sub_player",
    "season",
    "updated_at"
  ],
  "settings": [
    "key",
    "league_id",
    "value"
  ],
  "sheet_reviews": [
    "created_at",
    "event_id",
    "extracted_json",
    "id",
    "images_json",
    "league_id",
    "published_at",
    "season",
    "status",
    "validated_json",
    "week"
  ],
  "signup_attempts": [
    "count",
    "ip",
    "window_start"
  ],
  "team_messages": [
    "created_at",
    "event_id",
    "id",
    "league_id",
    "message",
    "player_id",
    "player_name",
    "team"
  ],
  "users": [
    "created_at",
    "email",
    "email_verified_at",
    "id",
    "last_login_at",
    "password_hash",
    "session_epoch",
    "signup_lang"
  ],
  "venues": [
    "address",
    "created_at",
    "id",
    "league_id",
    "map_link",
    "name"
  ]
};
