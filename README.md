# SMBHL Attendance, Outbox & League Operations — smbhl-rsvp

Cloudflare Worker handling attendance, automated sub invite waves, scoresheet OCR verification, financial cost tracking, team locker room message boards, league polling, player archives, dues reminders, weekly honors & milestone highlights, and a season-config-driven Season Hub for launching new seasons (team counts, roster targets, and playoff formats are organizer-entered, not hardcoded).

Last updated: 22 September 2026

---

## 1. System Overview

- **Production URL**: `https://rsvp.smbhl.com`
- **Production Cloudflare Worker**: `smbhl-rsvp` (`smbhl-rsvp.emailrobertosantana.workers.dev`)
- **Demo URL**: `https://rsvp.notreligue.ca` (Worker `notreligue-rsvp`) — a second, isolated deployment of the exact same code, used to preview a different league's data without touching production. See **Section 2** for how it relates to production.
- **Primary Mission**: Ensure every team has a full roster before game time through automated shortage detection and staged sub invitations, with full administrative controls for league management, game reviews, and stats broadcasting.
- **Season Configuration Engine** (`src/season_config.js`): team names/colours/aliases, goalies-per-team, skaters-per-team, minimum skaters, and playoff format are all read from each season's own `config` object in `data.json`, not hardcoded. See **Section 7**.
- **Key Infrastructure**:
  - Cloudflare D1 SQL database (one per environment — see **Section 5**)
  - Cloudflare KV (`SHEETS_KV`, one namespace per environment)
  - Scheduled Cron (`*/5 * * * *`, production only)
  - Resend Email API for transactional emails (`joueur@smbhl.com` / `info@smbhl.com` — currently hardcoded; see **Section 9**)
  - Google Gemini Vision AI for paper scoresheet OCR

---

## 2. Environments: Production vs. Demo

`wrangler.jsonc` defines a top-level (production) config plus one named environment, `demo`, under the `env` key. Both share the same `src/index.js` entry point and the same code — only the bindings differ.

| | Production (default) | Demo (`--env demo`) |
|---|---|---|
| Worker name | `smbhl-rsvp` | `notreligue-rsvp` |
| Public URL | `https://rsvp.smbhl.com` | `https://rsvp.notreligue.ca` (custom domain) |
| D1 database | `smbhl-rsvp` (`6f1838cf-30b0-4b4b-b9fe-716b61b961e4`) | `notreligue-demo` (`87411a46-fc5f-414f-bd46-6ff26feb155f`) |
| KV namespace (`SHEETS_KV`) | `e5af34ebf39b4c5d8851d7b071368a0e` | `28a2834f15814fcb84bb98f62f4919f1` |
| `DEMO_ENV` var | not set | `"true"` |
| Cron trigger | `*/5 * * * *` | none (`triggers.crons: []`) |
| Custom domain route | — | `rsvp.notreligue.ca` |

**Why it exists**: the demo environment is a fully separate Worker, D1 database, and KV namespace — it shares zero data with production. It exists to demo/validate the season-config engine against a differently-shaped league (different team names/count) without any risk to real SMBHL data.

**`DEMO_ENV=true` behavior** (`src/index.js`, top-level `fetch` handler): every response gets an `X-Robots-Tag: noindex, nofollow` header, and `GET /robots.txt` returns `Disallow: /`. This keeps the demo site out of search engines. This is currently the *only* thing gated on `DEMO_ENV` — branding, sender email, and default fallback URLs are not (see **Section 9**).

**Deploying**:
```powershell
npx wrangler deploy              # production (smbhl-rsvp)
npx wrangler deploy --env demo   # demo (notreligue-rsvp) — never omit --env demo here
```

Secrets are set per environment and do not carry over automatically:
```powershell
npx wrangler secret put ADMIN_KEY --env demo
```

---

## 3. File & Directory Table

| File / Folder | Type | Description |
|---|---|---|
| `.editorconfig` | Config | Editor coding styles and formatting settings. |
| `.gitignore` | Config | Git file and directory ignore rules. |
| `.prettierrc` | Config | Prettier code formatter rules. |
| `.vscode/` | Directory | VS Code workspace configuration. |
| `.vscode/settings.json` | Config | Editor workspace settings. |
| `.wrangler/` | Directory | Local Wrangler build state and runtime storage. |
| `README.md` | Documentation | Authoritative system documentation (this file). |
| `check.js` | Utility (Node) | Pre-deploy syntax and module verifier matching Cloudflare Worker packaging rules. |
| `contacts.csv` | Data (CSV) | Raw player directory (names, emails, phones). |
| `data.json` | Data (JSON) | Local synchronized copy of historical league statistics, season fixtures, and per-season `config` objects. |
| `event-week2.sql` | SQL Script | Manual fixture and roster setup script for Fall 2026 Week 2. |
| `fix-duplicate-subs-week2.sql` | SQL Script | Data repair script for Week 2 sub allocation de-duplication. |
| `get_reviews.mjs` | Script (Node) | Administrative inspection script to fetch review records from live D1. |
| `make-contacts-sql.js` | Script (Node) | Local generator converting `contacts.csv` into D1 SQL statements with random token salts. |
| `make-event-sql.js` | Script (Node) | Utility generating D1 SQL statements for creating upcoming game events manually. |
| `migrate-002.sql` … `migrate-017.sql` | SQL Migrations | See **Section 4**. |
| `node_modules/` | Directory | Installed npm dependencies. |
| `package-lock.json` | Config | Exact npm dependency lockfile. |
| `package.json` | Config | Node package configuration, scripts, and dependencies (`vitest`, `wrangler`). |
| `test/support/base_schema_v1.sql` | SQL Schema (test-only) | Initial base D1 tables (`contacts`, `events`, `rsvp`, `sheet_reviews`, `team_messages`). **Never run against a live/remote database** — opens with `DROP TABLE`. Replayed only by the test suite and `scripts/generate_schema_manifest.js`; see **Section 10** for the schema-drift guard this feeds. |
| `scratch/` | Directory | Scratch directory for diagnostic tools and verification scripts. |
| `scratch/check_all_invites.js`| Script (Node) | Local test script to verify sub invite eligibility. |
| `scratch/check_invites.js` | Script (Node) | Local test script for invite validation. |
| `src/` | Directory | Worker source modules. |
| `src/awards.js` | Source (JS) | Seasonal awards calculation, standings tie-breakers, Masterton candidate detection, playoff bracket resolution — season-config-aware (reads team names and `playoffFormat` from the season's own config). |
| `src/highlights.js` | Source (JS) | Weekly honors, milestone tracking, all-time Top 25 points & Top 10 goalie wins rank movements, and email HTML/text rendering. |
| `src/index.js` | Source (JS) | Main Cloudflare Worker entry point: routing, auth, cron scheduler, outbox drain, email templates, and admin UI (including `/admin/teams`, `/admin/emails`, `/admin/schedule`). |
| `src/review.js` | Source (JS) | Scoresheet OCR ingestion, Gemini AI multimodal vision parsing, boxscore verification, stats updates, and backup management. |
| `src/season_config.js` | Source (JS) | **Season Configuration Engine.** Resolves, normalizes, and reads each season's own `config` (teams, roster targets, playoff format) with fallback to SMBHL historical defaults. See **Section 7**. |
| `src/season_hub.js` | Source (JS) | Season Hub portal: season launch wizard (structure/teams, census, draft board, schedule generator), live standings, financial tracker, and dues reminders. |
| `test/` | Directory | Vitest automated test suite (155 passing tests). |
| `test/highlights.spec.js` | Test (JS) | Unit and integration tests for weekly honors, milestones, all-time rank movements, and email formatting. |
| `test/index.spec.js` | Test (JS) | Integration tests for worker routes, RSVP flows, sub waves, outbox queue, board rosters, trades, admin team pages, and email automations — including season-config-aware team resolution for non-default team counts/names. |
| `test/review.spec.js` | Test (JS) | Tests for OCR parsing, scoresheet validation, and data.json updates. |
| `test/season_hub.spec.js` | Test (JS) | Tests for Season Hub portal, expense tracking, and season launch workflows. |
| `vitest.config.mjs` | Config | Vitest runner configuration. |
| `wrangler.jsonc` | Config | Cloudflare deployment configuration for **both** the production and `demo` environments (D1, KV, variables, routes, cron schedules). |

---

## 4. Database Migrations

| Migration File | Summary of Changes |
|---|---|
| `test/support/base_schema_v1.sql` (test-only, see **Section 3**) | Creates base tables: `contacts`, `events`, `rsvp`, `sheet_reviews`, and `team_messages`. |
| `migrate-002.sql` | Adds event time windows (`start_time`, `end_time`), contact `role`, goalie sub pool (`is_goalie`), and `settings` table. |
| `migrate-003.sql` | Creates `outbox` queue table for asynchronous mail holds and `jobs` table to prevent duplicate cron runs. |
| `migrate-004.sql` | Creates `availability` table to queue sub responses and automate immediate waitlist placement. |
| `migrate-005.sql` | Adds sub wave ranking, rotation, and dormancy tracking columns (`asked_streak`, `last_asked`, `last_played`, `answered_ever`, `dormant`) to `contacts`. |
| `migrate-006.sql` | Adds `preferred_team` to `contacts` for soft team affinity sub assignments. |
| `migrate-007.sql` | Creates `sheet_reviews` table and status index for scoresheet upload and AI review workflows. |
| `migrate-008.sql` | Creates `team_messages` table and event/team index for team locker room chat boards. |
| `migrate-009.sql` | Empty placeholder migration. |
| `migrate-010.sql` | Creates `season_costs` table and index for league financial and expense tracking. |
| `migrate-011.sql` | Adds `etransfer_phone` column to `season_pricing` table. |
| `migrate-012.sql` | Creates `planned_absences` table and indexes for season-long vacation and absence tracking. |
| `migrate-013.sql` | Adds `contacts.position`, `polls` table, and `poll_votes` table for league awards and general voting polls. |
| `migrate-014.sql` | Adds email dispatch tracking columns `last_sent_at` and `sent_count` to `polls` table. |
| `migrate-015.sql` | Adds `show_on_rsvp` to `polls` table to embed active voting polls into personalized RSVP pages. |
| `migrate-016.sql` | Adds `show_results` to `polls` table to toggle public vs admin-only poll voting results. |
| `migrate-017.sql` | Adds `previous_role` and `archive_reason` to `contacts` table for player archiving and reactivation. |

No new migrations since `migrate-017.sql`; the season-config engine lives entirely in `data.json` (KV), not D1, so no schema changes were needed to support it.

---

## 5. Cloudflare Bindings (`wrangler.jsonc`)

### Production (top-level)

| Binding Name | Type | ID / Value | Purpose |
|---|---|---|---|
| `DB` | D1 Database | `6f1838cf-30b0-4b4b-b9fe-716b61b961e4` (`smbhl-rsvp`) | Relational storage for contacts, events, RSVPs, outbox, jobs, locker room messages, reviews, polls, votes, season costs, planned absences. |
| `SHEETS_KV` | KV Namespace | `e5af34ebf39b4c5d8851d7b071368a0e` | Live stats JSON, automated backups, scoresheet photos, weekly recaps. |
| `PUBLIC_URL` | Variable | `https://rsvp.smbhl.com` | Base canonical domain for personalized player/team links and CORS headers. |
| `crons` | Trigger | `["*/5 * * * *"]` | Fires every 5 minutes: outbox drain, reminders, sub wave sweeps, next-event creation. |

### Demo (`env.demo`)

| Binding Name | Type | ID / Value | Purpose |
|---|---|---|---|
| `DB` | D1 Database | `87411a46-fc5f-414f-bd46-6ff26feb155f` (`notreligue-demo`) | Isolated demo database — same schema as production, zero shared rows. |
| `SHEETS_KV` | KV Namespace | `28a2834f15814fcb84bb98f62f4919f1` | Isolated demo `data.json` and related keys — see **Section 2**. |
| `PUBLIC_URL` | Variable | `https://rsvp.notreligue.ca` | Canonical domain for the demo deployment. |
| `DEMO_ENV` | Variable | `"true"` | Enables `noindex`/`robots.txt` protection (**Section 2**). |
| `crons` | Trigger | `[]` | Cron disabled in demo — no automated outbox/reminder sweeps. |
| Route | Custom domain | `rsvp.notreligue.ca` | Attaches the demo Worker to its own domain. |

### KV Namespace Key Patterns (`SHEETS_KV`, both environments — same key names, separate data)

| Key Pattern | Written By | Read By | Purpose / Content |
|---|---|---|---|
| `data_json` | `src/review.js`, `src/season_hub.js`, `src/index.js` | all modules | Live serialized `data.json` — league stats, season fixtures, and each season's `config` object (see **Section 7**). |
| `backup:data_json:<ISO_TIMESTAMP>` | `src/review.js` | — | Snapshot backup of `data.json` before publishing verified game scoresheets. |
| `backup:data_json:<season>:week_<weekNum>` | `src/review.js` | — | Snapshot backup keyed by season and week number. |
| `backup:history` | `src/review.js` | — | JSON array of recent backup metadata (capped at 30). |
| `backup:season_launch:<seasonName>` | `src/season_hub.js` | — | Snapshot of `data.json` taken at the moment a new season is launched. |
| `recap:<season>:week_<w>` & `recap:week_<w>` | `src/review.js` | `src/highlights.js` | Cached weekly recap object (stars of the week, firsts, milestones, rank movements). |
| `season_recap_draft:<season>` | `src/index.js` | — | Draft configuration/text for the end-of-season wrap-up email. |
| `season_recap:<season>` | `src/index.js` | — | Published record of the end-of-season broadcast, including `sent_at`. |
| `champion_photo:<season>` / `champion_photo_mime:<season>` | `src/index.js` | — | Championship team photo binary + MIME type. |
| `review_img:<review_id>:<index>` | `src/review.js` | — | Temporary scoresheet photo buffer (48h TTL) for AI vision OCR/UI review. |

---

## 6. Environment Secrets

Set independently per environment via `npx wrangler secret put <NAME>` (production) or `npx wrangler secret put <NAME> --env demo` (demo):

| Secret Name | Purpose & Security Impact |
|---|---|
| `ADMIN_KEY` | Authenticates `/admin/*` dashboard and API endpoints via `x-admin` header or cookie. Harmless to rotate. |
| `RSVP_SECRET` | HMAC secret for personalized player links, team links, and voting tokens. **Rotating invalidates all previously emailed links.** |
| `RESEND_API_KEY` | API key for Resend email dispatch (`https://api.resend.com/emails`). Harmless to rotate. |
| `GEMINI_API_KEY` | Google Gemini API key for `src/review.js` (`parseSheetWithGemini`) multimodal vision OCR on uploaded scoresheets. |
| `ADMIN_EMAIL` | Destination for administrative notifications, weekly summaries, deadman alerts, goalie OUT warnings (falls back to a hardcoded address in `src/index.js`). |
| `SITE_URL` | Base URL for public stats-site `data.json` fetches when KV is empty (falls back to `https://smbhl.com` — see **Section 9**). |
| `ETRANSFER_PHONE` | Optional phone number shown on RSVP pages for Interac e-Transfers. |

Both production and the demo environment have their own copies of every secret above (confirmed via `wrangler secret list --env demo`); they are never shared or inherited from production.

---

## 7. Season Configuration Engine (`src/season_config.js`)

Each season stored in `data.json`'s `seasons` array can carry its own `config` object. This is what makes team count, team names, roster targets, and playoff format organizer-configurable per season instead of hardcoded.

### Schema

```js
{
  teams: [
    { name: 'Hawks', name_fr: 'Faucons', colour: '#1c1f24', aliases: [] },
    // ...one entry per team, any count
  ],
  goaliesPerTeam: 1,
  skatersPerTeam: 7,
  minSkaters: 4,
  playoffFormat: 'top4_two_weeks'   // or 'top4_single_day'
}
```

- **`teams`**: array of `{ name, name_fr, colour, aliases }`. `name` is canonical (used as the DB/API identifier — `contacts.preferred_team`, `rsvp.team`, etc.); `name_fr` is display-only; `aliases` lets scoresheet OCR and free-text team matching recognize alternate spellings (e.g. `"Red Wings"` → `Red`).
- **`goaliesPerTeam` / `skatersPerTeam` / `minSkaters`**: used by shortage detection and sub-wave triggering.
- **`playoffFormat`**: read by `src/awards.js` to pick the correct bracket/seeding logic.

### Resolution (`getSeasonConfig(seasonOrData, targetSeasonName)`)

1. If the season object has its own `.config`, use it (normalized).
2. Else, look up `targetSeasonName` in `dataJson.seasons`.
3. Else, look up `dataJson.current_season` in `dataJson.seasons`.
4. Else, fall back to `DEFAULT_SEASON_CONFIG` (SMBHL's historical Red/Blue/White/Black, 1 goalie + 8 skaters, 5 min skaters, `top4_single_day`) — this is the same fallback every historical season without an explicit `config` implicitly uses, so it is intentional, not a bug.

Helper functions built on this: `getTeamNames(config)`, `getTeamNameFr`, `getTeamColour`, `isTeamValid`, `normalizeTeamWithConfig` (matches a raw string against canonical name / `name_fr` / aliases, including word-boundary alias matching), and the async `getSeasonConfigFromEnv(env, seasonName)` / `getSeasonConfigForEvent(env, eventId, season)` wrappers used by request handlers that only have an event ID.

### Where it's wired in (as of tonight)

- `/admin/teams`, `/admin/teams/data`, roster move/trade/add, board shortage detection, sub-wave targeting, `/admin/team-links`, playoffs, and awards all resolve the season's own config rather than assuming the legacy 4-team default.
- The Season Hub launch wizard (`src/season_hub.js`) lets an organizer add/remove teams via a "+ Add a team" control before drafting, and `publishSeasonToProduction()` writes whatever team list/roster targets the organizer actually entered (falling back to SMBHL defaults only for fields left blank).
- **Not yet wired in**: a short list of client-side dropdowns and one OCR code path still assume the legacy 4-team default regardless of season config. These are tracked separately (see the Part B hardcoding-audit findings from this session) and are not fixed by this update beyond the `/admin/teams` Move/Add-Player dropdowns, which now read from the same season-config-driven list as the roster cards.

---

## 8. Features Added Since Last Update (17 → 22 September 2026)

### Season Configuration Engine
- New `src/season_config.js` module (see **Section 7**) — the season-config schema, resolution order, and helper functions.
- `/admin/teams`, board/shortage detection, sub-wave targeting, `/admin/team-links`, playoffs (`src/awards.js`), and OCR team normalization (`src/review.js`) made season-config-aware.
- Season Hub launch flow (`publishSeasonToProduction`) now writes the organizer's actual entered team list/roster config to the new season's `data.json` entry, rather than always writing the legacy 4-team default.

### Demo Environment
- New `env.demo` block in `wrangler.jsonc`: separate Worker (`notreligue-rsvp`), D1 database (`notreligue-demo`), KV namespace, and custom domain (`rsvp.notreligue.ca`) — see **Section 2**.
- `noindex`/`robots.txt` protection so the demo site doesn't get indexed by search engines.

### Data Integrity Hardening
- Season-array lookups (`data_json.seasons`) hardened against `null` holes left by earlier `delete arr[i]` calls (a real production data shape), so `/admin/teams/data` and related endpoints no longer throw on a sparse `seasons` array.

### Responsive `/admin/teams` Roster Cards & Dropdowns
- The roster-card grid, and the Move/Add-Player team dropdowns, now render dynamically from the season's own team list (`/admin/teams/data`'s `teams` keys) instead of four static Red/Blue/White/Black slots — so a season with a different team count/names renders correctly instead of silently dropping unrecognized teams.
- Grid CSS uses `repeat(auto-fit, minmax(270px, 1fr))` with an explicit single-column breakpoint at 768px, consistent with the rest of the site.

### (Carried over, unchanged this update)
Player Archive, Weekly Honors & Milestone Highlights, Email Automations & Outbox Management, Player Dues & Sub Fee Tracking, Live In-League Polling, Primary Goalie Alert, Printable Score Sheets API, and Board Roster Management & Trades — see prior git history for details; no functional changes to these in this update.

---

## 9. Hardcoded Values

Values still hardcoded to SMBHL specifics rather than driven by season config or environment (updated tonight; a more exhaustive audit — including doubleheader/2-games-per-night assumptions and the OCR roster list — was done as part of this session's Part B review and is tracked outside this README).

| File | Line(s) | Value | Context / Purpose |
|---|---|---|---|
| `src/index.js` | 154, 214, 438, 2073, 3970, 6041, 6229, 6272, 6302, 6342, 6411, 6509, 7973, 8063, 8094, 8151, 11135, 11254, 11359, 13579, 13699, 13798, 13868, 14772 | `https://smbhl.com/data.json` | Fallback URL to fetch league data when KV has no `data_json` key. |
| `src/index.js` | 248 | `https://smbhl.com/img/favicon-32.svg` | Favicon asset URL on every page (including demo). |
| `src/index.js` | 333, 350 | `https://smbhl.com/` | Logo header link and footer link. |
| `src/index.js` | 350 | `SMBHL · Laval, Québec` | Hardcoded footer text (not env-driven). |
| `src/index.js` | 513 | `SMBHL - Hockey <joueur@smbhl.com>` | Hardcoded `FROM` address for **all** transactional emails, in every environment — no `env.FROM` override exists. |
| `src/index.js` | 514 | `info@smbhl.com` | Hardcoded `REPLY_TO` address — same gap as above. |
| `src/index.js` | 515 | `emailrobertosantana@gmail.com` | Fallback for `ADMIN_EMAIL` (only used when the secret isn't set — each environment has its own `ADMIN_EMAIL` secret, so this fallback is rarely hit in practice). |
| `src/index.js` | 543 | `mailto:joueur@smbhl.com?subject=unsubscribe` | `List-Unsubscribe` email header. |
| `src/index.js` | 1547, 6554, 8114, 9583, 11550, 14846, 14952 | `https://rsvp.smbhl.com` | Fallback for `env.PUBLIC_URL` when unset. |
| `src/index.js` | 3619, 10768 | `https://smbhl.com/team-sheets.html` | Link to printable score sheets — production-only page, not environment-aware. |
| `src/index.js` | 3663 | `https://rsvp.smbhl.com/t/` | Base route for team redirect links. |
| `src/index.js` | 11470, 11848 | `scores@smbhl.com` | Scoresheet upload instructions email address. |
| `src/index.js` | 15163 | `https://smbhl.com` | Fallback 302 redirect on unknown root path. |
| `src/review.js` | 853, 2076 | `https://smbhl.com/img/favicon-32.svg` | Favicon asset URL on review UI pages. |
| `src/review.js` | 1046, 2144 | `https://smbhl.com/` | Logo header link. |
| `src/review.js` | 2172, 2262, 2292 | `scores@smbhl.com` | Upload instructions email address. |
| `src/review.js` | 2491, 2644, 2722, 2759, 2894, 2992, 3298 | `https://smbhl.com/data.json` | Fallback fetch URL for league data. |
| `src/review.js` | 2535, 3051 | `https://rsvp.smbhl.com` | Fallback for `env.PUBLIC_URL`. |
| `src/review.js` | 1439, 1511, 2587, 3070, 3075, 3112, 3125, 3131 | `smbhl.com` | Links and announcement text for published game results. |
| `src/review.js` | 132–192 | Real 2026 player roster names, `Red\|Blue\|White\|Black` enum, "max 1 assist per goal" rule | The Gemini OCR prompt (`parseSheetWithGemini`) and its `deduceTeamFromPlayers`/`ROSTERS` fallback are hardcoded to SMBHL's current roster and scoring rule, with no season-config integration. |
| `src/highlights.js` | 641 | `https://smbhl.com/data.json` | Fallback fetch URL for league data. |
| `src/highlights.js` | 968, 1053 | `https://smbhl.com` | Footer link in HTML and text highlights. |
| `src/season_hub.js` | 3012, 3013 | `smbhl.com`, `rsvp.smbhl.com` | Season launch success banner text. |
| `wrangler.jsonc` | 3, 18, 19, 25 | `smbhl-rsvp` (Worker name, D1 name/ID, KV ID) | Production identifiers. |
| `migrate-002.sql` | 12–14 | Real seed player emails | Historical data seed, not a functional issue. |

---

## 10. Deploying & Verifying

**Built after the Sept 24 production incident**: 22 migrations had been applied to the demo database but never to production, so a deploy shipped code that depended on a column production's schema didn't have, and broke SMBHL's live admin. This checklist — and the schema-drift guard described below it — exist so that can't happen silently again.

### Deploy checklist

1. **Syntax check:**
   ```powershell
   node check.js
   ```
2. **Full test suite** (must be green):
   ```powershell
   npm test -- --run
   ```
3. **Schema check** — *optional, but do it*:
   ```powershell
   npm run schema:check:demo         # before deploying to demo
   npm run schema:check:production   # before deploying to production
   ```
   Read-only. Tells you exactly which migrations are pending, before you deploy anything. This is a script — it only helps if you remember to run it. The **runtime guard** below is the part that can't be skipped.
4. **Deploy:**
   ```powershell
   npx wrangler deploy              # production — smbhl-rsvp / rsvp.smbhl.com
   npx wrangler deploy --env demo   # demo — notreligue-rsvp / rsvp.notreligue.ca
   ```
5. **Verify:** load the deployed site. If it 503s with `Schema drift detected`, see below — don't just retry the deploy, it won't help.

### The schema-drift guard

Every real request now passes through `src/schema_guard.js` before any routing. On the first request per isolate, it checks (via `PRAGMA table_info`, read-only) that the database this deployment is actually bound to has every table/column the code expects, cached for that isolate's lifetime. If something's missing, **every request 503s** with the exact gap named, e.g.:

```
table "outbox" has no column named "league_id"
```

**To fix:** apply the named migration(s) — `npx wrangler d1 execute <db-name> --remote --file=./migrate-NNN.sql` (never `--file=./test/support/base_schema_v1.sql`, see below) — then the guard clears itself on the very next request. No redeploy needed.

**After adding a new `migrate-NNN.sql` file:**
```powershell
npm run schema:manifest   # regenerates src/schema_manifest.js from the real .sql files
npm test -- --run         # test/schema_manifest.spec.js fails loudly if you skip this step
```

### ⚠️ `test/support/base_schema_v1.sql` — never run this against a live database

This is the app's *original* base schema (before any `migrate-*.sql` file existed). It opens with `DROP TABLE` and is **test-only** — replayed by the test suite and by `scripts/generate_schema_manifest.js`, nothing else. It used to live at the repo root as `schema.sql`, right next to every real migration file with an identically-phrased "apply this remotely" comment; it was moved and rewritten specifically to stop that pattern-match. If you're ever setting up a database from scratch for real, use the numbered `migrate-*.sql` chain in order, not this file.

### Cloudflare Access — SMBHL's admin gate

`rsvp.smbhl.com/admin/*` is protected by **two independent layers**:

1. **A Cloudflare Access policy**, configured in the Cloudflare dashboard (Zero Trust → Access → Applications) — **not in this repo, not in `wrangler.jsonc`, not carried by any deploy.** It must stay configured permanently; nothing here recreates it if it's ever removed. Requests that fail it never reach the Worker at all.
2. **`checkAdminAuth`** (`src/admin_auth.js`), the Worker's own `ADMIN_KEY` gate — genuinely independent of layer 1, verified by `test/cloudflare_access_independence.spec.js`: it never reads any Access-shaped header or cookie, so it would still correctly reject an unauthenticated request even if Access were somehow removed.

**To verify Access is still actually in place** (this can't be part of `npm test` — Access sits at Cloudflare's edge, outside what an in-process test can observe; this needs a real external request):
```powershell
npm run check:cloudflare-access
```
A healthy result redirects (302) to `<team>.cloudflareaccess.com/cdn-cgi/access/login/...` with a `Www-Authenticate: Cloudflare-Access` header — Access's own challenge, never reaching the Worker. If you instead see the Worker's own response (the admin page shell, or a plain 403), Access may have been removed from the dashboard — check there directly; layer 2 (`checkAdminAuth`) is likely still holding, but layer 1 needs attention.
