# SMBHL Attendance, Outbox & League Operations — smbhl-rsvp

Cloudflare Worker handling attendance, automated sub invite waves, scoresheet OCR verification, financial cost tracking, team locker room message boards, league polling, player archives, dues reminders, and weekly honors & milestone highlights.

Last updated: 21 September 2026

---

## 1. System Overview

- **Public URL**: `https://rsvp.smbhl.com`
- **Cloudflare Worker**: `smbhl-rsvp` (`smbhl-rsvp.emailrobertosantana.workers.dev`)
- **Primary Mission**: Ensure every team has a full roster (1 goalie and 8 skaters) before game time through automated shortage detection and staged sub invitations, with full administrative controls for league management, game reviews, and stats broadcasting.
- **Key Infrastructure**:
  - Cloudflare D1 SQL database (`smbhl-rsvp`, `6f1838cf-30b0-4b4b-b9fe-716b61b961e4`)
  - Cloudflare KV (`SHEETS_KV`, `e5af34ebf39b4c5d8851d7b071368a0e`)
  - Scheduled Cron (`*/5 * * * *`)
  - Resend Email API for transactional emails (`joueur@smbhl.com` / `info@smbhl.com`)
  - Google Gemini 2.5 Flash Vision AI for paper scoresheet OCR

---

## 2. File & Directory Table

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
| `contacts.sql` | SQL Script | Generated D1 batch script to populate and sync `contacts` table. |
| `data.json` | Data (JSON) | Local synchronized copy of historical league statistics and season fixtures. |
| `event-week2.sql` | SQL Script | Manual fixture and roster setup script for Fall 2026 Week 2. |
| `fix-duplicate-subs-week2.sql` | SQL Script | Data repair script for Week 2 sub allocation de-duplication. |
| `get_reviews.mjs` | Script (Node) | Administrative inspection script to fetch review records from live D1. |
| `make-contacts-sql.js` | Script (Node) | Local generator converting `contacts.csv` into D1 SQL statements with random token salts. |
| `make-event-sql.js` | Script (Node) | Utility generating D1 SQL statements for creating upcoming game events manually. |
| `migrate-002.sql` | SQL Migration | Adds event time windows, contact roles (`roster`, `sub_skater`, `sub_goalie`), goalie sub pool, and `is_goalie`. |
| `migrate-003.sql` | SQL Migration | Adds `outbox` queue table (for holds, retries, and de-duplication) and `jobs` execution tracker table. |
| `migrate-004.sql` | SQL Migration | Adds `availability` table for sub response tracking and queue-based waitlisting. |
| `migrate-005.sql` | SQL Migration | Adds sub wave ranking, rotation, and dormancy tracking columns (`asked_streak`, `last_asked`, `last_played`, `answered_ever`, `dormant`) to `contacts`. |
| `migrate-006.sql` | SQL Migration | Adds `preferred_team` column to `contacts` for soft team affinity sub matching. |
| `migrate-007.sql` | SQL Migration | Adds `sheet_reviews` table and `idx_reviews_status` index for scoresheet ingestion and AI verification. |
| `migrate-008.sql` | SQL Migration | Adds `team_messages` table and event/team index for team locker room chat boards. |
| `migrate-009.sql` | SQL Migration | Empty placeholder migration. |
| `migrate-010.sql` | SQL Migration | Adds `season_costs` table and index for league financial and expense tracking. |
| `migrate-011.sql` | SQL Migration | Adds `etransfer_phone` column to `season_pricing` table. |
| `migrate-012.sql` | SQL Migration | Adds `planned_absences` table and indexes for player season-long vacation and absence tracking. |
| `migrate-013.sql` | SQL Migration | Adds `contacts.position`, `polls` table, and `poll_votes` table for league voting and awards polling. |
| `migrate-014.sql` | SQL Migration | Adds email dispatch tracking columns `last_sent_at` and `sent_count` to `polls` table. |
| `migrate-015.sql` | SQL Migration | Adds `show_on_rsvp` column to `polls` table to embed active voting polls into personalized RSVP pages. |
| `migrate-016.sql` | SQL Migration | Adds `show_results` column to `polls` table to control public vs admin-only visibility of poll voting results. |
| `migrate-017.sql` | SQL Migration | Adds `previous_role` and `archive_reason` columns to `contacts` table for player archive and reactivation management. |
| `node_modules/` | Directory | Installed npm dependencies. |
| `package-lock.json` | Config | Exact npm dependency lockfile. |
| `package.json` | Config | Node package configuration, scripts, and dependencies (`vitest`, `wrangler`). |
| `schema.sql` | SQL Schema | Initial base D1 tables (`contacts`, `events`, `rsvp`, `sheet_reviews`, `team_messages`). |
| `scratch/` | Directory | Scratch directory for diagnostic tools and verification scripts. |
| `scratch/check_all_invites.js`| Script (Node) | Local test script to verify sub invite eligibility. |
| `scratch/check_invites.js` | Script (Node) | Local test script for invite validation. |
| `src/` | Directory | Worker source modules. |
| `src/awards.js` | Source (JS) | Seasonal awards calculation, standings tie-breakers, Masterton candidate detection. |
| `src/highlights.js` | Source (JS) | Weekly honors, milestone tracking, all-time Top 25 points & Top 10 goalie wins rank movements, and email HTML/text rendering. |
| `src/index.js` | Source (JS) | Main Cloudflare Worker entry point: routing, auth, cron scheduler, outbox drain, email templates, and admin UI. |
| `src/review.js` | Source (JS) | Scoresheet OCR ingestion, Gemini AI multimodal vision parsing, boxscore verification, stats updates, and backup management. |
| `src/season_hub.js` | Source (JS) | Season Hub portal: live standings, schedule, team sheets integration, financial tracker, and dues reminders. |
| `test/` | Directory | Vitest automated test suite (143 passing tests). |
| `test/highlights.spec.js` | Test (JS) | Unit and integration tests for weekly honors, milestones, all-time rank movements, and email formatting. |
| `test/index.spec.js` | Test (JS) | Integration tests for worker routes, RSVP flows, sub waves, outbox queue, board rosters, trades, and email automations. |
| `test/review.spec.js` | Test (JS) | Tests for OCR parsing, scoresheet validation, and data.json updates. |
| `test/season_hub.spec.js` | Test (JS) | Tests for Season Hub portal, expense tracking, and season launch workflows. |
| `vitest.config.mjs` | Config | Vitest runner configuration. |
| `wrangler.jsonc` | Config | Cloudflare deployment configuration (D1, KV, variables, cron schedules). |

---

## 3. Database Migrations

| Migration File | Summary of Changes |
|---|---|
| `schema.sql` | Creates base tables: `contacts`, `events`, `rsvp`, `sheet_reviews`, and `team_messages`. |
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

---

## 4. Cloudflare Bindings (`wrangler.jsonc`)

| Binding Name | Type | ID / Value | Purpose & KV Key Patterns |
|---|---|---|---|
| `DB` | D1 Database | `6f1838cf-30b0-4b4b-b9fe-716b61b961e4` (`smbhl-rsvp`) | Relational database storage for all contacts, events, RSVPs, outbox emails, cron jobs, locker room messages, reviews, polls, votes, season costs, and planned absences. |
| `SHEETS_KV` | KV Namespace | `e5af34ebf39b4c5d8851d7b071368a0e` | High-speed key-value store for live stats JSON, automated backups, scoresheet photos, and weekly recaps. |
| `PUBLIC_URL` | Variable (`vars`) | `https://rsvp.smbhl.com` | Base canonical domain for generating personalized player links, team links, action webhooks, and CORS headers. |
| `crons` | Trigger | `["*/5 * * * *"]` | Cron trigger firing every 5 minutes to process the outbox queue, automated reminders, sub wave sweeps, lockups, and next event creation. |

### KV Namespace Key Patterns (`SHEETS_KV`)

| Key Pattern | Written By | Read By | Purpose / Content |
|---|---|---|---|
| `data_json` | `smbhl-rsvp` (`src/review.js`, `src/season_hub.js`, `src/index.js`) | `smbhl-rsvp`, `SMBHLw` (`worker.js`) | Live serialized `data.json` database. When written by `smbhl-rsvp`, `smbhl.com` immediately serves fresh stats at the edge. |
| `backup:data_json:<ISO_TIMESTAMP>` | `smbhl-rsvp` (`src/review.js`) | `smbhl-rsvp` | Cloud snapshot backup of `data.json` taken before publishing verified game scoresheets. |
| `backup:data_json:<season>:week_<weekNum>` | `smbhl-rsvp` (`src/review.js`) | `smbhl-rsvp` | Cloud snapshot backup of `data.json` keyed by season and week number. |
| `backup:history` | `smbhl-rsvp` (`src/review.js`) | `smbhl-rsvp` | JSON array of recent backup metadata (timestamps, keys, week, season, games count; capped at 30). |
| `backup:season_launch:<seasonName>` | `smbhl-rsvp` (`src/season_hub.js`) | `smbhl-rsvp` | Snapshot of `data.json` preserved at the exact moment a new season is launched in Season Hub. |
| `recap:<season>:week_<w>` & `recap:week_<w>` | `smbhl-rsvp` (`src/review.js`) | `smbhl-rsvp` (`src/highlights.js`) | Cached weekly recap object containing stars of the week, firsts, milestones, and rank movements. |
| `season_recap_draft:<season>` | `smbhl-rsvp` (`src/index.js`) | `smbhl-rsvp` | Draft configuration and text for the end-of-season celebratory wrap-up email. |
| `season_recap:<season>` | `smbhl-rsvp` (`src/index.js`) | `smbhl-rsvp` | Published record of the end-of-season wrap-up broadcast, including `sent_at`. |
| `champion_photo:<season>` | `smbhl-rsvp` (`src/index.js`) | `smbhl-rsvp` | Binary ArrayBuffer of the uploaded high-resolution championship team photo. |
| `champion_photo_mime:<season>` | `smbhl-rsvp` (`src/index.js`) | `smbhl-rsvp` | MIME type string of the championship team photo (e.g. `image/jpeg`). |
| `review_img:<review_id>:<index>` | `smbhl-rsvp` (`src/review.js`) | `smbhl-rsvp` | Temporary scoresheet photo buffer (48-hour expiration TTL) used for AI vision OCR and UI review. Deleted upon review discard or publish cleanup. |

---

## 5. Environment Secrets

Set via `npx wrangler secret put <NAME>`:

| Secret Name | Purpose & Security Impact |
|---|---|
| `ADMIN_KEY` | Authenticates `/admin` dashboard, `/admin/emails`, `/admin/review`, and all admin API endpoints via `x-admin` header or cookie. Harmless to rotate. |
| `RSVP_SECRET` | Cryptographic secret used to generate HMAC token salts for personalized player links, team links, and voting tokens. **Rotating this invalidates all links previously emailed.** |
| `RESEND_API_KEY` | API key for Resend email dispatch service (`https://api.resend.com/emails`). Harmless to rotate. |
| `GEMINI_API_KEY` | Google Gemini API key used by `src/review.js` (`parseSheetWithGemini`) to perform multimodal vision OCR on uploaded paper score sheets. |
| `ADMIN_EMAIL` | Destination email address for administrative notifications, weekly game night summaries, deadman alerts, and goalie OUT warnings (falls back to `santarob@gmail.com`). |
| `SITE_URL` | Optional base URL for public stats site data fetches (defaults to `https://smbhl.com`). |
| `ETRANSFER_PHONE` | Optional phone number displayed on player RSVP pages for Interac e-Transfers. |

---

## 6. Features Added Since Last Update

### Player Archive (`previous_role`, `archive_reason`)
- Dedicated archive system (`POST /admin/players/archive`, `POST /admin/players/unarchive`, `GET /admin/players/archived`).
- Preserves player history while removing inactive or injured players from active team rosters and sub pools.
- Stores the player's previous role (`roster`, `sub_skater`, `sub_goalie`) in `contacts.previous_role`, sets `role = 'archived'`, and stores an archive reason (`contacts.archive_reason`).
- Reactivating restores the player back to their exact previous role seamlessly.

### Weekly Honors & Milestone Highlights Engine (`src/highlights.js`)
- Integrated into weekly invite emails and recap announcements.
- **Weekly Stars**: Joueur de la semaine / Player of the week (highest skater points), Gardien / Goalie of the week (lowest GAA, min 1 GP), Substitut / Sub of the week (top substitute skater points; skips duplicate with POTW).
- **Career Milestones**: 10, 25, 50, 75, 100, 200... 1000+ for points, goals, assists, games played, and goalie wins.
- **All-Time Leaderboard Movements (Option C Compact Format)**:
  - **Skaters**: Highlighted when moving into or within the **Top 25 all-time career points**. Ties broken by higher career goals. Format: `<b>Nicola Tiberio</b> : 9e rang historique · 866 pts (dépasse Carlo Mirarchi)`.
  - **Goalies**: Highlighted when moving into or within the **Top 10 all-time goalie wins**. Ties broken by fewer games played. Format: `<b>Fabio Russo</b> : 10e rang historique · 29 victoires (dépasse Michael Pacheco)`.
  - **Strict Passing**: "Only passing counts" — achievements only trigger when a player strictly overtakes someone who was previously ahead. If multiple players are passed in one week, all are listed: `(dépasse Player A, Player B)`.
  - Priority: Displayed at the very top of *Plateaux / Milestones* ahead of numerical milestone counters.
- **Career Firsts**: Highlights players scoring their first career goal, first career assist, first goalie win, or first goalie shutout.
- **Closing In**: Radar highlighting active players closest to reaching upcoming career milestones.
- **Bilingual Rendering**: Output cleanly formatted for both responsive HTML (bilingual headings, bold names, grey item labels) and plain text fallback.

### Email Automations & Outbox Management (`/admin/emails`)
- Complete management portal to inspect all scheduled, queued, sent, and cancelled emails.
- Filter by event, status, and message kind (`invite`, `r72`, `r49`, `short48`, `pool36`, `r24`, `summary`, `weekly_recap`, etc.).
- Preview email templates and send live test previews directly to any custom email address.
- Cancel pending outbox items and manually trigger outbox drain runs.

### Player Dues & Sub Fee Tracking
- Automated sub fee notice ($15/game) included in confirmation emails for placed substitute skaters.
- Automated seasonal dues reminder included for unpaid regular roster players.

### Live In-League Polling (`/admin/polls` & `/rsvp`)
- Create and manage season awards polls (e.g. Masterton Trophy, All-Star voting) with position filters (`F`, `D`, `G`).
- Toggle `show_on_rsvp` to embed the active voting card directly into players' personalized `/rsvp` pages.
- Toggle `show_results` for public vs private voting tallies.

### Primary Goalie Alert
- Whenever a team's primary starting goalie responds OUT on their RSVP, an immediate high-priority alert email is dispatched to the admin.

### Printable Score Sheets API (`/api/sheet-data`)
- Feeds live attendance and sub assignments into `https://smbhl.com/team-sheets.html`.
- Players with an official NO are crossed out; confirmed substitute skaters and goalies are pre-printed.

### Board Roster Management & Trades
- Admin drag-and-drop roster management (`POST /admin/teams/move`) and player trade endpoint (`POST /admin/teams/trade`).
- Automatically updates D1 open RSVPs, team assignments, and `is_sub` flags while preserving audit trails.

---

## 7. Hardcoded Values

| File | Line | Value | Context / Purpose |
|---|---|---|---|
| `src/index.js` | 143, 201, 425, 1656, 2044, 3922, 5991, 6177, 6219, 6249, 6289, 6358, 6456, 7911, 7999, 8030, 8087, 11071, 11190, 11295, 13515, 13637, 13736, 13810, 14719 | `https://smbhl.com/data.json` | Fallback URL to fetch league data if not present in KV. |
| `src/index.js` | 241 | `https://smbhl.com/img/favicon-32.svg` | Favicon asset URL on RSVP pages. |
| `src/index.js` | 326, 343 | `https://smbhl.com/` | Navigation and footer link back to the stats site. |
| `src/index.js` | 506 | `SMBHL - Hockey <joueur@smbhl.com>` | Default `FROM` address for all league transactional emails. |
| `src/index.js` | 507 | `info@smbhl.com` | Default `REPLY_TO` address for player communications. |
| `src/index.js` | 508 | `emailrobertosantana@gmail.com` | Default fallback for `ADMIN_EMAIL`. |
| `src/index.js` | 513 | `frederick.crevier@hec.ca` | Typo autocorrection regex example/comment. |
| `src/index.js` | 536 | `mailto:joueur@smbhl.com?subject=unsubscribe` | `List-Unsubscribe` email header. |
| `src/index.js` | 693, 855, 864, 1417, 1422, 1468, 2700, 9546, 9615 | `smbhl.com` | Email footers, button links, and plain text sign-offs. |
| `src/index.js` | 995 | `https://smbhl.com` | Link to team roster and stats page. |
| `src/index.js` | 1337, 1538, 6507, 8056, 9525, 11492, 14787, 14893 | `https://rsvp.smbhl.com` | Default fallback for `env.PUBLIC_URL`. |
| `src/index.js` | 1554 | `https://smbhl-rsvp.emailrobertosantana.workers.dev` | Fallback worker subdomain URL. |
| `src/index.js` | 3577, 10710 | `https://smbhl.com/team-sheets.html` | Link to printable score sheets. |
| `src/index.js` | 3621 | `https://rsvp.smbhl.com/t/` | Base route for team links. |
| `src/index.js` | 5591 | `user@domain.com` | Input placeholder for email field. |
| `src/index.js` | 5988, 5989 | `rsantana@live.ca`, `rantana@live.ca` | Auto-correction hook for player P0217 email. |
| `src/index.js` | 8591 | `smbhl.com` | Placeholder text for financial expense description. |
| `src/index.js` | 11412, 11790 | `scores@smbhl.com`, `https://smbhl.com` | Receipt footer for score sheet uploads. |
| `src/index.js` | 11461 | `emailrobertosantana@gmail.com`, `rsantana@live.ca` | Default recipient addresses for scoresheet notifications. |
| `src/index.js` | 15103 | `https://smbhl.com` | Fallback 302 redirect on unknown root path. |
| `src/highlights.js` | 639 | `https://smbhl.com/data.json` | Fallback fetch URL for league data. |
| `src/highlights.js` | 734, 833 | `https://smbhl.com` | Footer link ("Tout voir sur smbhl.com / See all on smbhl.com") in HTML and text highlights. |
| `src/review.js` | 846, 2069 | `https://smbhl.com/img/favicon-32.svg` | Favicon asset URL on review UI pages. |
| `src/review.js` | 1039, 2137 | `https://smbhl.com/` | Logo header link to stats site. |
| `src/review.js` | 1432, 1504 | `smbhl.com` | Success notification message upon publishing game scores. |
| `src/review.js` | 2165, 2255, 2285 | `scores@smbhl.com` | Upload instructions email address. |
| `src/review.js` | 2484, 2635, 2712, 2799, 2881, 2978, 3284 | `https://smbhl.com/data.json` | Fallback fetch URL for league data. |
| `src/review.js` | 2526, 3037 | `https://rsvp.smbhl.com` | Fallback for `PUBLIC_URL`. |
| `src/review.js` | 2578, 3056, 3061, 3098, 3111, 3117 | `smbhl.com` | Links and announcement text for published game results. |
| `src/review.js` | 3225 | `emailrobertosantana@gmail.com` | Default fallback notification address. |
| `src/season_hub.js` | 2835, 2836 | `smbhl.com`, `rsvp.smbhl.com` | Season launch banner text. |
| `wrangler.jsonc` | 3 | `smbhl-rsvp` | Cloudflare Worker name. |
| `wrangler.jsonc` | 10 | `https://rsvp.smbhl.com` | Canonical `PUBLIC_URL` variable. |
| `wrangler.jsonc` | 18 | `smbhl-rsvp` | D1 database name. |
| `wrangler.jsonc` | 19 | `6f1838cf-30b0-4b4b-b9fe-716b61b961e4` | Cloudflare D1 database ID (`DB`). |
| `wrangler.jsonc` | 25 | `e5af34ebf39b4c5d8851d7b071368a0e` | Cloudflare KV namespace ID (`SHEETS_KV`). |
| `migrate-002.sql` | 12 | `trapslash@hotmail.com` | Seed email for Michael Pacheco. |
| `migrate-002.sql` | 13 | `alexvochau@gmail.com` | Seed email for Alex Chau. |
| `migrate-002.sql` | 14 | `philrc.assurances@gmail.com` | Seed email for Philippe Charbonneau. |
| `migrate-008.sql` | 2 | `smbhl-rsvp` | D1 database execute command comment. |
| `migrate-010.sql` | 2 | `smbhl-rsvp` | D1 database execute command comment. |
| `schema.sql` | 2 | `smbhl-rsvp` | D1 database execute command comment. |

---

## 8. Deploying & Verifying

Before deploying, run the syntax check:

```powershell
cd C:\Users\santarob\Downloads\smbhl-rsvp
node check.js
```

Deploy the worker to Cloudflare:

```powershell
npx wrangler deploy
```

Run the automated test suite (143 tests):

```powershell
npm test -- --run
```

