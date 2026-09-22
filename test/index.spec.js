import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";
import worker, { body, drain, notifyAdminGoalieCancel, getTeamMessages, addTeamMessage, getStandingsTooltip, sanitizeAndValidateEmail, acceptAvailability, sortTeamBoardRows, computeTeamBalance, resolveTeamGoalies, boardData, ensureNextEvent, teamState, expected, handleLeagueMessageGet, handleLeagueMessageSave, runSchedule, handleSendSampleInvites } from "../src";
import { handleReviewPublish, handleReviewManualStart } from "../src/review.js";

describe("SMBHL Worker", () => {
	beforeAll(async () => {
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS sheet_reviews (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, season TEXT NOT NULL, week INTEGER NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', images_json TEXT, extracted_json TEXT, validated_json TEXT, published_at TEXT)`).run();
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS team_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, team TEXT NOT NULL, player_name TEXT NOT NULL, player_id TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS season_pricing (season TEXT PRIMARY KEY, price_player REAL NOT NULL DEFAULT 170, price_goalie REAL NOT NULL DEFAULT 0, price_sub_player REAL NOT NULL DEFAULT 10, price_sub_goalie REAL NOT NULL DEFAULT 0, etransfer_phone TEXT, updated_at TEXT NOT NULL)`).run();
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS player_dues (season TEXT NOT NULL, player_id TEXT NOT NULL, custom_due REAL, adjustment REAL NOT NULL DEFAULT 0, amount_paid REAL NOT NULL DEFAULT 0, notes TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (season, player_id))`).run();
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS season_costs (id TEXT PRIMARY KEY, season TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`).run();
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS planned_absences (id INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL, date TEXT NOT NULL, season TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL, UNIQUE(player_id, date))` ).run();
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS contacts (player_id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, role TEXT, is_sub INT DEFAULT 0, is_goalie INT DEFAULT 0, token_salt TEXT, opted_out INT DEFAULT 0, asked_streak INT DEFAULT 0, last_asked TEXT, dormant INT DEFAULT 0, answered_ever INT DEFAULT 0, preferred_team TEXT, last_played TEXT, position TEXT)`).run();
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
		await env.DB.prepare(`ALTER TABLE contacts ADD COLUMN position TEXT DEFAULT NULL`).run().catch(() => {});
		await env.DB.prepare(`ALTER TABLE contacts ADD COLUMN previous_role TEXT DEFAULT NULL`).run().catch(() => {});
		await env.DB.prepare(`ALTER TABLE contacts ADD COLUMN archive_reason TEXT DEFAULT NULL`).run().catch(() => {});
		await env.DB.prepare(`ALTER TABLE contacts ADD COLUMN is_backup_goalie INT DEFAULT 0`).run().catch(() => {});
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS polls (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT NOT NULL, title TEXT NOT NULL, description TEXT, category TEXT NOT NULL DEFAULT 'general', target_position TEXT, allow_subs INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, closed_at TEXT, last_sent_at TEXT, sent_count INTEGER DEFAULT 0, show_on_rsvp INTEGER NOT NULL DEFAULT 0, show_results INTEGER NOT NULL DEFAULT 0)`).run();
		await env.DB.prepare(`ALTER TABLE polls ADD COLUMN last_sent_at TEXT DEFAULT NULL`).run().catch(() => {});
		await env.DB.prepare(`ALTER TABLE polls ADD COLUMN sent_count INTEGER DEFAULT 0`).run().catch(() => {});
		await env.DB.prepare(`ALTER TABLE polls ADD COLUMN show_on_rsvp INTEGER NOT NULL DEFAULT 0`).run().catch(() => {});
		await env.DB.prepare(`ALTER TABLE polls ADD COLUMN show_results INTEGER NOT NULL DEFAULT 0`).run().catch(() => {});
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS poll_votes (id INTEGER PRIMARY KEY AUTOINCREMENT, poll_id INTEGER NOT NULL REFERENCES polls(id), voter_id TEXT NOT NULL, candidate_id TEXT, candidate_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(poll_id, voter_id))` ).run();
	});

	it("responds with ok on /health", async () => {
		const request = new Request("http://example.com/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toBe("ok");
	});

	it("renders admin/board page with navigation tabs", async () => {
		const response = await SELF.fetch("http://example.com/admin/board");
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Tableau");
		expect(html).toContain("Substituts");
		expect(html.includes("Joueurs") || html.includes("Contacts")).toBe(true);
	});

	it("renders admin/subs page with navigation tabs", async () => {
		const response = await SELF.fetch("http://example.com/admin/subs");
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Substituts sollicités");
		expect(html).toContain("/admin/subs");
		expect(html).toContain("Tableau");
		expect(html.includes("Joueurs") || html.includes("Contacts")).toBe(true);
	});

	it("rejects unauthorized access to /admin/subs/data", async () => {
		const response = await SELF.fetch("http://example.com/admin/subs/data");
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("nope");
	});

	it("responds with json on /api/sheet-data with CORS headers", async () => {
		const response = await SELF.fetch("http://example.com/api/sheet-data");
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		const data = await response.json();
		expect(data).toHaveProperty("teams");
	});

	it("handles CORS preflight on /api/sheet-data", async () => {
		const response = await SELF.fetch("http://example.com/api/sheet-data", { method: "OPTIONS" });
		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
	});

	it("rejects unauthorized access to /admin/subs/reassign", async () => {
		const response = await SELF.fetch("http://example.com/admin/subs/reassign", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ event_id: "test", player_id: "P0001", team: "Red" })
		});
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("nope");
	});

	it("renders /admin/review index page with upload controls", async () => {
		env.ADMIN_KEY = "test-review-index-admin";
		const response = await SELF.fetch("http://example.com/admin/review", {
			headers: { "x-admin": "test-review-index-admin" }
		});
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Feuilles de match");
		expect(html).toContain("Téléverser");
	});

	it("rejects unauthenticated access to /admin/review with 403, unlike /admin/board's login-gate page", async () => {
		env.ADMIN_KEY = "test-review-index-admin";
		const response = await SELF.fetch("http://example.com/admin/review");
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("nope");
	});

	describe("Security: every /admin/review/* route requires admin auth", () => {
		const SECURITY_ADMIN_KEY = "test-review-security-admin-key";
		let reviewId;

		beforeAll(async () => {
			env.ADMIN_KEY = SECURITY_ADMIN_KEY;
			reviewId = "rev_security_test_1";
			await env.DB.prepare(
				`INSERT OR REPLACE INTO sheet_reviews (id, event_id, season, week, created_at, status, images_json, extracted_json, validated_json)
				 VALUES (?, 'sec-evt-1', 'Fall 2026', 1, '2026-09-22T12:00:00Z', 'draft', '[]', '[]', '[]')`
			).bind(reviewId).run();
		});

		const routes = () => [
			{ method: "GET", path: "/admin/review" },
			{ method: "GET", path: `/admin/review?id=${reviewId}` },
			{ method: "GET", path: "/admin/review/image?key=img:whatever:0" },
			{ method: "POST", path: "/admin/review/upload" },
			{ method: "POST", path: "/admin/review/manual-start" },
			{ method: "POST", path: "/admin/review/publish" },
			{ method: "POST", path: "/admin/review/discard" },
			{ method: "POST", path: "/admin/review/add-sheet" },
			{ method: "POST", path: "/admin/review/reprocess" }
		];

		for (const route of routes()) {
			it(`${route.method} ${route.path} — no credentials at all returns 403`, async () => {
				env.ADMIN_KEY = SECURITY_ADMIN_KEY;
				const res = await SELF.fetch(`http://example.com${route.path}`, {
					method: route.method,
					headers: route.method === "POST" ? { "content-type": "application/json" } : undefined,
					body: route.method === "POST" ? "{}" : undefined
				});
				expect(res.status).toBe(403);
				expect(await res.text()).toBe("nope");
			});

			it(`${route.method} ${route.path} — wrong key returns 403`, async () => {
				env.ADMIN_KEY = SECURITY_ADMIN_KEY;
				const res = await SELF.fetch(`http://example.com${route.path}`, {
					method: route.method,
					headers: Object.assign(
						{ "x-admin": "definitely-not-the-real-key" },
						route.method === "POST" ? { "content-type": "application/json" } : {}
					),
					body: route.method === "POST" ? "{}" : undefined
				});
				expect(res.status).toBe(403);
			});
		}

		it("GET /admin/review (index, authenticated) never contains the literal ADMIN_KEY value anywhere in the response body", async () => {
			env.ADMIN_KEY = SECURITY_ADMIN_KEY;
			const res = await SELF.fetch("http://example.com/admin/review", {
				headers: { "x-admin": SECURITY_ADMIN_KEY }
			});
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).not.toContain(SECURITY_ADMIN_KEY);
		});

		it("GET /admin/review?id=... (authenticated) never contains the literal ADMIN_KEY value anywhere in the response body", async () => {
			env.ADMIN_KEY = SECURITY_ADMIN_KEY;
			const res = await SELF.fetch(`http://example.com/admin/review?id=${reviewId}`, {
				headers: { "x-admin": SECURITY_ADMIN_KEY }
			});
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).not.toContain(SECURITY_ADMIN_KEY);
		});

		it("a valid key via ?key= query param (as a magic link would carry it) authenticates GET /admin/review", async () => {
			env.ADMIN_KEY = SECURITY_ADMIN_KEY;
			const res = await SELF.fetch(`http://example.com/admin/review?key=${encodeURIComponent(SECURITY_ADMIN_KEY)}`);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).not.toContain(SECURITY_ADMIN_KEY);
			// Successful auth via any method refreshes the shared admin_key cookie,
			// same as /admin/board and every other protected admin page.
			expect(res.headers.get("set-cookie") || "").toContain("admin_key=");
		});
	});

	describe("Manual entry end-to-end through the real HTTP/auth path (not just direct handler calls)", () => {
		const E2E_ADMIN_KEY = "test-review-e2e-admin-key";
		const E2E_SEASON = "E2EManualSeason2027";

		beforeAll(async () => {
			env.ADMIN_KEY = E2E_ADMIN_KEY;
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season TEXT, week INT, date TEXT, venue TEXT, state TEXT, start_time TEXT, end_time TEXT)`).run();
			await env.DB.prepare(
				`INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time, end_time)
				 VALUES ('e2e-manual-evt-1', ?, 1, 'Sunday', 'Court A', 'open', '10:00', '11:00')`
			).bind(E2E_SEASON).run();
			await env.SHEETS_KV.put("data_json", JSON.stringify({
				current_season: E2E_SEASON,
				seasons: [{
					name: E2E_SEASON,
					standings: [],
					fixtures: [
						{ week: 1, date: "Sunday", venue: "Court A", time: "10:00 AM", gym: "Court A", home: "Red", away: "Blue", hg: null, ag: null }
					]
				}],
				players: []
			}));
		});

		it("an authenticated admin can start a manual review and load its editing page through the real router (auth included)", async () => {
			const startRes = await SELF.fetch("http://example.com/admin/review/manual-start", {
				method: "POST",
				headers: { "x-admin": E2E_ADMIN_KEY, "content-type": "application/json" },
				body: JSON.stringify({ season: E2E_SEASON, week: 1 })
			});
			expect(startRes.status).toBe(200);
			const { ok, id } = await startRes.json();
			expect(ok).toBe(true);
			expect(id).toBeTruthy();

			const pageRes = await SELF.fetch(`http://example.com/admin/review?id=${id}`, {
				headers: { "x-admin": E2E_ADMIN_KEY }
			});
			expect(pageRes.status).toBe(200);
			const html = await pageRes.text();
			expect(html).toContain("Red");
			expect(html).toContain("Blue");
			expect(html).toContain("addPlayerRow(0, 'home')");
			expect(html).not.toContain(E2E_ADMIN_KEY);
		});

		it("the same authenticated admin can then publish that manually-created review through the real router", async () => {
			const startRes = await SELF.fetch("http://example.com/admin/review/manual-start", {
				method: "POST",
				headers: { "x-admin": E2E_ADMIN_KEY, "content-type": "application/json" },
				body: JSON.stringify({ season: E2E_SEASON, week: 1 })
			});
			const { id } = await startRes.json();

			const publishRes = await SELF.fetch("http://example.com/admin/review/publish", {
				method: "POST",
				headers: { "x-admin": E2E_ADMIN_KEY, "content-type": "application/json" },
				body: JSON.stringify({
					review_id: id, week: 1,
					games: [{
						home_team: "Red", away_team: "Blue", home_score: 3, away_score: 1,
						home_players: [],
						away_players: []
					}]
				})
			});
			expect(publishRes.status).toBe(200);
			const publishJson = await publishRes.json();
			expect(publishJson.ok).toBe(true);
		});
	});

	it("responds on /api/data-json with JSON", async () => {
		const response = await SELF.fetch("http://example.com/api/data-json");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
	});

	it("returns 404 on unknown route", async () => {
		const response = await SELF.fetch("http://example.com/unknown-path");
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("not found");
	});

	it("renders 24-hour gameday reminder email with team link and cancellation button", () => {
		const ev = { id: "2026-09-20", week: 3, date: "Sunday September 20", start_time: "10:30 AM", venue: "College Jean-de-Brebeuf" };
		const payload = {
			fixtureText: "\n10:30 AM vs. Blue\nChandail rouge requis / Red shirt required.\n",
			teamLink: "https://rsvp.smbhl.com/team-rsvp?s=Fall%202026&team=Red&t=abc123token",
			websiteTeamLink: "https://smbhl.com/#/team/Fall%202026/Red",
			no: "https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0001&t=xyz789&v=out"
		};
		const res = body('gameday', {
			ev,
			name: 'Roberto',
			team: 'Red',
			link: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0001&t=xyz789',
			payload
		});

		expect(res.subject).toContain("À demain pour le match !");
		expect(res.subject).toContain("See you at the gym tomorrow!");

		// French text
		expect(res.text).toContain("Salut Roberto");
		expect(res.text).toContain("tu es confirmé(e) avec Rouge pour demain");
		expect(res.text).toContain("Voir l'alignement de l'équipe : https://rsvp.smbhl.com/team-rsvp?s=Fall%202026&team=Red&t=abc123token");
		expect(res.text).toContain("Fiche d'équipe : https://smbhl.com/#/team/Fall%202026/Red");
		expect(res.text).toContain("Tu ne peux plus venir ? Mets ton statut à jour ici.");
		expect(res.text).toContain("Je ne peux pas jouer / I can't play : https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0001&t=xyz789&v=out");

		// English text
		expect(res.text).toContain("Hi Roberto");
		expect(res.text).toContain("Reminder: you are confirmed with Red for tomorrow");
		expect(res.text).toContain("View team lineup: https://rsvp.smbhl.com/team-rsvp?s=Fall%202026&team=Red&t=abc123token");
		expect(res.text).toContain("Team page: https://smbhl.com/#/team/Fall%202026/Red");
		expect(res.text).toContain("Can't make it? Update your status here.");

		// HTML elements
		expect(res.html).toContain("📋 Voir l&#39;alignement de l&#39;équipe");
		expect(res.html).toContain("View team lineup");
		expect(res.html).toContain("https://rsvp.smbhl.com/team-rsvp?s=Fall%202026&amp;team=Red&amp;t=abc123token");
		expect(res.html).toContain("https://smbhl.com/#/team/Fall%202026/Red");
		expect(res.html).toContain("Tu ne peux plus venir ? Mets ton statut à jour ici.");
		expect(res.html).toContain("Can't make it? Update your status here.");
		expect(res.html).toContain("Je ne peux pas jouer / I can&#39;t play");
		expect(res.html).toContain("https://rsvp.smbhl.com/rsvp?e=2026-09-20&amp;p=P0001&amp;t=xyz789&amp;v=out");
	});

	it("gracefully falls back when optional gameday payload fields are omitted", () => {
		const ev = { id: "2026-09-20", week: 3, date: "Sunday September 20" };
		const res = body('gameday', {
			ev,
			name: 'Sam',
			team: null,
			link: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0002&t=tok123',
			payload: {}
		});

		expect(res.subject).toContain("À demain pour le match !");
		expect(res.text).toContain("Salut Sam");
		expect(res.text).toContain("ton équipe");
		expect(res.text).toContain("your team");
		expect(res.text).toContain("https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0002&t=tok123");
		expect(res.html).toContain("Je ne peux pas jouer / I can&#39;t play");
	});

	it("cancels queued gameday email if player is no longer confirmed in", async () => {
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season TEXT, week INT, date TEXT, venue TEXT, state TEXT, start_time TEXT, end_time TEXT)`).run();
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS contacts (player_id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, role TEXT, is_sub INT DEFAULT 0, is_goalie INT DEFAULT 0, token_salt TEXT, opted_out INT DEFAULT 0, asked_streak INT DEFAULT 0, last_asked TEXT, dormant INT DEFAULT 0, answered_ever INT DEFAULT 0, preferred_team TEXT, last_played TEXT, position TEXT)`).run();
		await env.DB.prepare(`ALTER TABLE contacts ADD COLUMN is_sub INT DEFAULT 0`).run().catch(() => {});
		await env.DB.prepare(`ALTER TABLE contacts ADD COLUMN preferred_team TEXT`).run().catch(() => {});
		await env.DB.prepare(`ALTER TABLE contacts ADD COLUMN last_played TEXT`).run().catch(() => {});
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rsvp (event_id TEXT, player_id TEXT, guest_name TEXT, team TEXT, status TEXT, role TEXT, status_by TEXT, updated_at TEXT, PRIMARY KEY (event_id, player_id))`).run();
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, event_id TEXT, player_id TEXT, team TEXT, dedup_key TEXT, payload TEXT, send_after TEXT, sent_at TEXT, cancelled INT DEFAULT 0, error TEXT, created_at TEXT)`).run();
		await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();

		env.RSVP_SECRET = 'test-secret-12345';
		const now = new Date().toISOString();
		await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES ('2026-09-20', 'Fall 2026', 3, 'Sunday September 20', 'College Jean-de-Brebeuf', 'open', '10:30')`).run();
		await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('P9999', 'Test Player', 'test@smbhl.com', 'roster', 'salt123')`).run();
		// Status is OUT, not IN
		await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'P9999', 'Red', 'out', 'roster', 'self', ?)`).bind(now).run();
		// Queued gameday email
		await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('gameday', '2026-09-20', 'P9999', 'Red', 'gameday24:2026-09-20:P9999', '{}', ?, ?)`).bind(now, now).run();

		const result = await drain(env);
		expect(result.sent).toBe(0);

		const outboxRow = await env.DB.prepare(`SELECT cancelled, error FROM outbox WHERE dedup_key = 'gameday24:2026-09-20:P9999'`).first();
		expect(outboxRow.cancelled).toBe(1);
		expect(outboxRow.error).toBe('no longer confirmed in');
	});

	it("sends gameday email to roster players who have no response (pending status)", async () => {
		const originalFetch = globalThis.fetch;
		const sent = [];
		globalThis.fetch = async (url, opts) => {
			if (String(url).includes('api.resend.com')) {
				sent.push(JSON.parse(opts.body));
				return new Response(JSON.stringify({ id: 'mock_resend_id' }), { status: 200 });
			}
			return originalFetch(url, opts);
		};

		try {
			env.RESEND_API_KEY = 're_test_key_123';
			env.RSVP_SECRET = 'test-secret-12345';
			const past = new Date(Date.now() - 60000).toISOString();
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season TEXT, week INT, date TEXT, venue TEXT, state TEXT, start_time TEXT, end_time TEXT)`).run();
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS contacts (player_id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, role TEXT, is_sub INT DEFAULT 0, is_goalie INT DEFAULT 0, token_salt TEXT, opted_out INT DEFAULT 0, asked_streak INT DEFAULT 0, last_asked TEXT, dormant INT DEFAULT 0, answered_ever INT DEFAULT 0, preferred_team TEXT, last_played TEXT, position TEXT)`).run();
			await env.DB.prepare(`ALTER TABLE contacts ADD COLUMN is_sub INT DEFAULT 0`).run().catch(() => {});
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rsvp (event_id TEXT, player_id TEXT, guest_name TEXT, team TEXT, status TEXT, role TEXT, status_by TEXT, updated_at TEXT, PRIMARY KEY (event_id, player_id))`).run();
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, event_id TEXT, player_id TEXT, team TEXT, dedup_key TEXT, payload TEXT, send_after TEXT, sent_at TEXT, cancelled INT DEFAULT 0, error TEXT, created_at TEXT)`).run();
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`).run();
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS team_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, team TEXT NOT NULL, player_name TEXT NOT NULL, player_id TEXT, message TEXT NOT NULL, created_at TEXT NOT NULL)`).run();

			await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES ('2026-09-20', 'Fall 2026', 3, 'Sunday September 20', 'College Jean-de-Brebeuf', 'open', '10:30')`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('P8888', 'Pending Regular', 'pending@smbhl.com', 'roster', 'salt888')`).run();
			// Regular roster player, but status is pending (no response)
			await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'P8888', 'Red', 'pending', 'roster', 'auto', ?)`).bind(past).run();
			await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('gameday', '2026-09-20', 'P8888', 'Red', 'gameday24:2026-09-20:P8888', '{}', ?, ?)`).bind(past, past).run();

			const result = await drain(env);
			expect(result.sent).toBe(1);
			expect(sent.length).toBe(1);
			expect(sent[0].to[0]).toBe('pending@smbhl.com');
			expect(sent[0].subject).toContain('À demain pour le match !');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("cancels gameday email for pending sub players (only roster regulars are eligible when pending)", async () => {
		const past = new Date(Date.now() - 60000).toISOString();
		await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('P7777', 'Pending Sub', 'sub@smbhl.com', 'sub', 'salt777')`).run();
		await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'P7777', 'Red', 'pending', 'sub', 'auto', ?)`).bind(past).run();
		await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('gameday', '2026-09-20', 'P7777', 'Red', 'gameday24:2026-09-20:P7777', '{}', ?, ?)`).bind(past, past).run();

		const result = await drain(env);
		expect(result.sent).toBe(0);

		const outboxRow = await env.DB.prepare(`SELECT cancelled, error FROM outbox WHERE dedup_key = 'gameday24:2026-09-20:P7777'`).first();
		expect(outboxRow.cancelled).toBe(1);
		expect(outboxRow.error).toBe('no longer confirmed in');
	});

	it("sends admin alert email when notifyAdminGoalieCancel is called", async () => {
		const originalFetch = globalThis.fetch;
		const fetchCalls = [];
		globalThis.fetch = async (url, opts) => {
			if (String(url).includes('api.resend.com')) {
				fetchCalls.push({ url, opts, body: JSON.parse(opts.body) });
				return new Response(JSON.stringify({ id: 'mock_resend_id' }), { status: 200 });
			}
			return originalFetch(url, opts);
		};

		try {
			env.RESEND_API_KEY = 're_test_key_123';
			env.RSVP_SECRET = 'test-secret-12345';
			const ev = { id: '2026-09-20', season: 'Fall 2026', week: 3, date: 'Sunday September 20', start_time: '10:30 AM', venue: 'College Jean-de-Brebeuf' };
			const contact = { player_id: 'P0088', name: 'Francois Taillefer', is_goalie: 1, role: 'roster' };

			const sent = await notifyAdminGoalieCancel(env, ev, contact, 'Red', 'self', 'in');
			expect(sent).toBe(true);
			expect(fetchCalls.length).toBe(1);

			const mail = fetchCalls[0].body;
			expect(mail.to).toContain('emailrobertosantana@gmail.com');
			expect(mail.subject).toContain('Alerte Gardien : Francois Taillefer absent pour Rouge');
			expect(mail.text).toContain('Le gardien Francois Taillefer a été marqué ABSENT pour Rouge (Red)');
			expect(mail.text).toContain('était déjà confirmé PRÉSENT');
			expect(mail.text).toContain('/admin/subs');
			expect(mail.text).toContain('/admin/board');
			expect(mail.html).toContain('Alerte : Un gardien a annulé');
			expect(mail.html).toContain('Gérer et appeler des substituts');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("triggers goalie alert in rsvpGet when a goalie responds OUT, but not for skaters", async () => {
		const originalFetch = globalThis.fetch;
		const sentMails = [];
		globalThis.fetch = async (url, opts) => {
			if (String(url).includes('api.resend.com')) {
				sentMails.push(JSON.parse(opts.body));
				return new Response(JSON.stringify({ id: 'mock_resend_id' }), { status: 200 });
			}
			return originalFetch(url, opts);
		};

		try {
			env.RESEND_API_KEY = 're_test_key_123';
			env.RSVP_SECRET = 'test-secret-12345';
			const now = new Date().toISOString();

			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS availability (event_id TEXT, player_id TEXT, need TEXT, status TEXT, answered_at TEXT, PRIMARY KEY (event_id, player_id, need))`).run();
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS jobs (event_id TEXT, job TEXT, ran_at TEXT, PRIMARY KEY (event_id, job))`).run();

			// Setup goalie & skater contacts
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_goalie, token_salt) VALUES ('G001', 'Goalie Bob', 'goalie@smbhl.com', 'roster', 1, 'salt_g')`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_goalie, token_salt) VALUES ('S001', 'Skater Sam', 'skater@smbhl.com', 'roster', 0, 'salt_s')`).run();

			await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'G001', 'Blue', 'pending', 'roster', 'auto', ?)`).bind(now).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'S001', 'Blue', 'pending', 'roster', 'auto', ?)`).bind(now).run();

			// 1. Skater marks OUT -> no goalie alert sent
			const ctx = createExecutionContext();
			// Compute token for skater
			const encoder = new TextEncoder();
			const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			const sigS = await crypto.subtle.sign("HMAC", key, encoder.encode(`p:2026-09-20:S001:salt_s`));
			const tokS = [...new Uint8Array(sigS)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

			const skaterResp = await worker.fetch(new Request(`http://example.com/rsvp?e=2026-09-20&p=S001&t=${tokS}&v=out`), env, ctx);
			await waitOnExecutionContext(ctx);
			expect(skaterResp.status).toBe(200);
			expect(sentMails.length).toBe(0); // No goalie alert for skater!

			// 2. Goalie marks OUT -> goalie alert IS sent to admin!
			const sigG = await crypto.subtle.sign("HMAC", key, encoder.encode(`p:2026-09-20:G001:salt_g`));
			const tokG = [...new Uint8Array(sigG)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

			const goalieResp = await worker.fetch(new Request(`http://example.com/rsvp?e=2026-09-20&p=G001&t=${tokG}&v=out`), env, ctx);
			await waitOnExecutionContext(ctx);
			expect(goalieResp.status).toBe(200);
			expect(sentMails.length).toBe(1);
			expect(sentMails[0].subject).toContain('Alerte Gardien : Goalie Bob absent pour Bleu');

			// 3. Goalie re-clicks or refreshes v=out -> duplicate alert is suppressed
			await worker.fetch(new Request(`http://example.com/rsvp?e=2026-09-20&p=G001&t=${tokG}&v=out`), env, ctx);
			await waitOnExecutionContext(ctx);
			expect(sentMails.length).toBe(1); // Still 1, no duplicate!
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("triggers goalie alert in teamPost when teammate marks goalie OUT", async () => {
		const originalFetch = globalThis.fetch;
		const sentMails = [];
		globalThis.fetch = async (url, opts) => {
			if (String(url).includes('api.resend.com')) {
				sentMails.push(JSON.parse(opts.body));
				return new Response(JSON.stringify({ id: 'mock_resend_id' }), { status: 200 });
			}
			return originalFetch(url, opts);
		};

		try {
			env.RESEND_API_KEY = 're_test_key_123';
			env.RSVP_SECRET = 'test-secret-12345';
			const now = new Date().toISOString();

			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_goalie, token_salt) VALUES ('G002', 'Goalie Jacques', 'jacques@smbhl.com', 'roster', 1, 'salt_j')`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'G002', 'Red', 'in', 'roster', 'self', ?)`).bind(now).run();

			// Generate team token
			const salt = 'teamsalt_red_123';
			await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('teamsalt:Fall 2026:Red', ?)`).bind(salt).run();
			const encoder = new TextEncoder();
			const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`t:Fall 2026:Red:${salt}`));
			const tok = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

			const ctx = createExecutionContext();
			const resp = await worker.fetch(new Request(`http://example.com/team-rsvp?s=Fall%202026&team=Red&t=${tok}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ player_id: 'G002', status: 'out' })
			}), env, ctx);
			await waitOnExecutionContext(ctx);

			expect(resp.status).toBe(200);
			expect(sentMails.length).toBe(1);
			expect(sentMails[0].subject).toContain('Alerte Gardien : Goalie Jacques absent pour Rouge');
			expect(sentMails[0].text).toContain('coéquipier ou admin');
			expect(sentMails[0].text).toContain('était déjà confirmé PRÉSENT');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("inserts and retrieves team messages in chronological order", async () => {
		await addTeamMessage(env.DB, '2026-09-20', 'Red', 'Alex V.', 'P1001', 'Ankle gametime decision');
		await addTeamMessage(env.DB, '2026-09-20', 'Red', 'Dave L.', 'P1002', 'Carpool from metro');

		const msgs = await getTeamMessages(env.DB, '2026-09-20', 'Red', 5);
		expect(msgs.length).toBe(2);
		expect(msgs[0].player_name).toBe('Alex V.');
		expect(msgs[0].message).toBe('Ankle gametime decision');
		expect(msgs[1].player_name).toBe('Dave L.');
		expect(msgs[1].message).toBe('Carpool from metro');
	});

	it("handles posting a team message via /team-rsvp POST", async () => {
		env.RSVP_SECRET = 'test-secret-12345';
		const salt = 'teamsalt_red_123';
		await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('teamsalt:Fall 2026:Red', ?)`).bind(salt).run();
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`t:Fall 2026:Red:${salt}`));
		const tok = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

		const ctx = createExecutionContext();
		const resp = await worker.fetch(new Request(`http://example.com/team-rsvp?s=Fall%202026&team=Red&t=${tok}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'message', player_name: 'Roberto S.', message: 'Bringing new orange balls' })
		}), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(resp.status).toBe(200);
		const json = await resp.json();
		expect(json.ok).toBe(true);

		const msgs = await getTeamMessages(env.DB, '2026-09-20', 'Red', 10);
		expect(msgs.some(m => m.player_name === 'Roberto S.' && m.message === 'Bringing new orange balls')).toBe(true);
	});

	it("renders team messages inside gameday reminder email", async () => {
		const ev = { id: '2026-09-20', season: 'Fall 2026', week: 2, date: 'Sunday September 20, 2026' };
		const payload = {
			teamLink: 'https://rsvp.smbhl.com/team-rsvp?s=Fall%202026&team=Red&t=xyz',
			teamMessages: [
				{ player_name: 'Alex V.', message: 'Gametime decision', created_at: '2026-09-18T15:30:00Z' },
				{ player_name: 'Roberto S.', message: 'Bringing balls', created_at: '2026-09-19T12:00:00Z' }
			]
		};

		const email = body('gameday', {
			ev,
			name: 'Marc',
			team: 'Red',
			link: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0001&t=xyz',
			payload
		});
		expect(email.text).toContain("Notes d'équipe / Team board");
		expect(email.text).toContain("Alex V.");
		expect(email.text).toContain("Gametime decision");
		expect(email.html).toContain("Notes d'équipe / Team Board (Red)");
		expect(email.html).toContain("Bringing balls");
	});

	it("renders friday_board and gameday_morning email templates", async () => {
		const ev = { id: '2026-09-20', season: 'Fall 2026', week: 2, date: 'Sunday September 20, 2026' };
		const payload = {
			teamLink: 'https://rsvp.smbhl.com/team-rsvp?s=Fall%202026&team=Red&t=xyz',
			teamMessages: [
				{ player_name: 'Sam P.', message: 'Running 10 mins late', created_at: '2026-09-20T07:45:00Z' }
			]
		};

		const friEmail = body('friday_board', {
			ev,
			name: 'Marc',
			team: 'Red',
			link: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0001&t=xyz',
			payload
		});
		expect(friEmail.subject).toContain("Notes d'équipe : Red");
		expect(friEmail.text).toContain("Running 10 mins late");
		expect(friEmail.html).toContain("Voir l&#39;alignement et répondre");

		const morningEmail = body('gameday_morning', {
			ev,
			name: 'Marc',
			team: 'Red',
			link: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0001&t=xyz',
			payload
		});
		expect(morningEmail.subject).toContain("Notes de dernière minute : Red");
		expect(morningEmail.text).toContain("Running 10 mins late");
		expect(morningEmail.html).toContain("Voir le tableau d&#39;équipe");
	});

	it("locks author name in /team-rsvp when player_id &p= is provided in URL", async () => {
		env.RSVP_SECRET = 'test-secret-12345';
		const salt = 'teamsalt_red_123';
		await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('teamsalt:Fall 2026:Red', ?)`).bind(salt).run();
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`t:Fall 2026:Red:${salt}`));
		const tok = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

		// 1. Visit with &p=P9999 (Test Player) -> locked, no dropdown
		const ctx1 = createExecutionContext();
		const resp1 = await worker.fetch(new Request(`http://example.com/team-rsvp?s=Fall%202026&team=Red&t=${tok}&p=P9999`), env, ctx1);
		await waitOnExecutionContext(ctx1);
		const html1 = await resp1.text();

		expect(resp1.status).toBe(200);
		expect(html1).toContain('De / From : <b style="color:var(--blue); font-size:16px;">Test Player</b>');
		expect(html1).not.toContain('<select id="msgauthor"');

		// 2. Visit without &p= (Admin / generic link) -> dropdown selector visible
		const ctx2 = createExecutionContext();
		const resp2 = await worker.fetch(new Request(`http://example.com/team-rsvp?s=Fall%202026&team=Red&t=${tok}`), env, ctx2);
		await waitOnExecutionContext(ctx2);
		const html2 = await resp2.text();

		expect(resp2.status).toBe(200);
		expect(html2).toContain('<select id="msgauthor"');
	});

	it("renders compact notes banner above roster with smooth scroll jump link", async () => {
		env.RSVP_SECRET = 'test-secret-12345';
		const salt = 'teamsalt_red_123';
		await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('teamsalt:Fall 2026:Red', ?)`).bind(salt).run();
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`t:Fall 2026:Red:${salt}`));
		const tok = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

		// Post a message for 2026-09-20 Red
		await addTeamMessage(env.DB, '2026-09-20', 'Red', 'Dave L.', 'P1002', 'Carpooling from metro');

		const ctx = createExecutionContext();
		const resp = await worker.fetch(new Request(`http://example.com/team-rsvp?s=Fall%202026&team=Red&t=${tok}`), env, ctx);
		await waitOnExecutionContext(ctx);
		const html = await resp.text();

		expect(resp.status).toBe(200);
		// Compact top banner above roster
		expect(html).toContain("💬 Notes d'équipe / Team Notes");
		expect(html).toContain("Dave L.");
		expect(html).toContain("Carpooling from metro");
		expect(html).toContain('href="#team-board" class="jump-to-board"');
		// Bottom full board target
		expect(html).toContain('id="team-board"');
		expect(html).toContain("Tableau d'équipe");
	});

	it("formats standings tooltip from data_json in SHEETS_KV", async () => {
		const mockData = {
			current_season: "Fall 2026",
			seasons: [{
				name: "Fall 2026",
				standings: [
					{ team: "Black", gp: 2, pts: 4, gf: 10, ga: 4 },
					{ team: "Red", gp: 2, pts: 2, gf: 8, ga: 7 },
					{ team: "Blue", gp: 2, pts: 2, gf: 6, ga: 8 },
					{ team: "White", gp: 2, pts: 0, gf: 3, ga: 8 }
				]
			}]
		};
		await env.SHEETS_KV.put("data_json", JSON.stringify(mockData));

		const tooltip = await getStandingsTooltip(env);
		expect(tooltip).toContain("Classement SMBHL — 1er : Black (4 pts) · 2e : Red (2 pts) · 3e : Blue (2 pts) · 4e : White (0 pt)");
		expect(tooltip).toContain("SMBHL Standings — 1st: Black (4 pts) · 2nd: Red (2 pts) · 3rd: Blue (2 pts) · 4th: White (0 pt)");
	});

	it("renders logo with standings tooltip title attribute on /team-rsvp", async () => {
		env.RSVP_SECRET = 'test-secret-12345';
		const salt = 'teamsalt_red_123';
		await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('teamsalt:Fall 2026:Red', ?)`).bind(salt).run();
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`t:Fall 2026:Red:${salt}`));
		const tok = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

		const mockData = {
			current_season: "Fall 2026",
			seasons: [{
				name: "Fall 2026",
				standings: [
					{ team: "Black", gp: 2, pts: 4, gf: 10, ga: 4 },
					{ team: "Red", gp: 2, pts: 2, gf: 8, ga: 7 }
				]
			}]
		};
		await env.SHEETS_KV.put("data_json", JSON.stringify(mockData));

		const ctx = createExecutionContext();
		const resp = await worker.fetch(new Request(`http://example.com/team-rsvp?s=Fall%202026&team=Red&t=${tok}`), env, ctx);
		await waitOnExecutionContext(ctx);
		const html = await resp.text();

		expect(resp.status).toBe(200);
		expect(html).toContain('title="Classement SMBHL — 1er : Black (4 pts) · 2e : Red (2 pts)');
	});

	it("sorts standings tooltip using official 5 tie-breaking rules (Points -> Wins -> +/- -> GF -> Regular Player Goals)", async () => {
		const mockData = {
			current_season: "Fall 2026",
			seasons: [{
				name: "Fall 2026",
				standings: [
					// Tied on points (4 pts), but Blue has more wins (2 vs 1)
					{ team: "Red", gp: 2, w: 1, pts: 4, gf: 10, ga: 4 },
					{ team: "Blue", gp: 2, w: 2, pts: 4, gf: 10, ga: 4 },
					// Tied on points (2 pts) and wins (1 w), but Black has better +/- (+3 vs 0)
					{ team: "White", gp: 2, w: 1, pts: 2, gf: 8, ga: 8 },
					{ team: "Black", gp: 2, w: 1, pts: 2, gf: 9, ga: 6 }
				]
			}],
			players: [
				{ id: "P1", name: "Red Reg", seasons: { "Fall 2026": { team: "Red", g: 5 } } },
				{ id: "P2", name: "Blue Reg", seasons: { "Fall 2026": { team: "Blue", g: 5 } } }
			]
		};
		await env.SHEETS_KV.put("data_json", JSON.stringify(mockData));

		const tooltip = await getStandingsTooltip(env);
		// Blue (2w) over Red (1w), Black (+3) over White (0)
		expect(tooltip).toContain("1er : Blue (4 pts) · 2e : Red (4 pts) · 3e : Black (2 pts) · 4e : White (2 pts)");
	});

	it("serves dynamic logo SVG on /api/logo.svg with colors ordered by standings", async () => {
		const res = await SELF.fetch("http://example.com/api/logo.svg");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("image/svg+xml");
		const svg = await res.text();
		expect(svg).toContain("<svg");
		expect(svg).toContain('fill="#2a5fa8"');
	});

	it("renders admin/season-recap page with champion select, photo upload, and 10 awards", async () => {
		const response = await SELF.fetch("http://example.com/admin/season-recap");
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("Bilan de fin de saison");
		expect(html).toContain("Équipe Championne");
		expect(html).toContain("Photo officielle des champions");
		expect(html).toContain("Rocket Richard");
		expect(html).toContain("Lady Byng");
		expect(html).toContain("Art Ross");
		expect(html).toContain("Hart");
		expect(html).toContain("James Norris");
		expect(html).toContain("Georges Vézina");
		expect(html).toContain("Calder");
		expect(html).toContain("Subway");
		expect(html).toContain("MVP");
		expect(html).toContain("Bill Masterton");
		expect(html).toContain("Bilan 🏆");
	});

	it("rejects unauthorized access to /admin/season-recap/data", async () => {
		const response = await SELF.fetch("http://example.com/admin/season-recap/data");
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("nope");
	});

	it("loads pre-calculated awards and draft on /admin/season-recap/data with admin key", async () => {
		env.ADMIN_KEY = "super-secret-admin";
		const mockData = {
			current_season: "Fall 2026",
			seasons: [{
				name: "Fall 2026",
				champion: "Blue",
				standings: [
					{ team: "Blue", gf: 20, ga: 10, pts: 6 },
					{ team: "Red", gf: 15, ga: 15, pts: 4 }
				]
			}],
			players: [
				{
					id: "P0001",
					name: "Top Scorer Player",
					seasons: {
						"Fall 2026": { team: "Blue", gp: 4, g: 10, a: 2, pts: 12, pos: "F" }
					}
				}
			]
		};
		await env.SHEETS_KV.put("data_json", JSON.stringify(mockData));

		const response = await SELF.fetch("http://example.com/admin/season-recap/data", {
			headers: { "x-admin": env.ADMIN_KEY }
		});
		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.season).toBe("Fall 2026");
		expect(data.champion).toBe("Blue");
		expect(data.awards.rocketRichard).toContain("Top Scorer Player, 10 buts / goals");
	});

	it("handles saving draft and uploading photo on /admin/season-recap/save and /upload-photo", async () => {
		env.ADMIN_KEY = "super-secret-admin";

		// 1. Save draft
		const saveResp = await SELF.fetch("http://example.com/admin/season-recap/save", {
			method: "POST",
			headers: { "content-type": "application/json", "x-admin": env.ADMIN_KEY },
			body: JSON.stringify({
				season: "Fall 2026",
				champion: "Blue",
				intro_note: "Félicitations pour cette belle saison!",
				awards: {
					rocketRichard: "Custom Scorer with 20 goals",
					billMasterton: "Great perseverance story"
				}
			})
		});
		expect(saveResp.status).toBe(200);
		const saveData = await saveResp.json();
		expect(saveData.ok).toBe(true);

		// 2. Upload photo
		const formData = new FormData();
		const fakeImageContent = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46]);
		const file = new File([fakeImageContent], "champion.jpg", { type: "image/jpeg" });
		formData.append("photo", file);
		formData.append("season", "Fall 2026");

		const photoResp = await SELF.fetch("http://example.com/admin/season-recap/upload-photo", {
			method: "POST",
			headers: { "x-admin": env.ADMIN_KEY },
			body: formData
		});
		expect(photoResp.status).toBe(200);
		const photoData = await photoResp.json();
		expect(photoData.ok).toBe(true);
		expect(photoData.url).toContain("/api/champion-photo");

		// 3. Verify photo is publicly servable via /api/champion-photo
		const getPhotoResp = await SELF.fetch("http://example.com/api/champion-photo?s=Fall%202026");
		expect(getPhotoResp.status).toBe(200);
		expect(getPhotoResp.headers.get("content-type")).toBe("image/jpeg");
		const servedBuf = await getPhotoResp.arrayBuffer();
		expect(servedBuf.byteLength).toBe(fakeImageContent.byteLength);
	});

	it("renders season_recap_prompt email to admin with link to /admin/season-recap", () => {
		const ev = { id: "2026-12-20", season: "Fall 2026", week: 14, date: "Sunday December 20, 2026" };
		const payload = { season: "Fall 2026", to: "emailrobertosantana@gmail.com" };
		const msg = body("season_recap_prompt", { ev, name: "Roberto", payload });

		expect(msg.subject).toContain("Préparation du bilan de fin de saison");
		expect(msg.text).toContain("/admin/season-recap");
		expect(msg.html).toContain("/admin/season-recap");
		expect(msg.html).toContain("Préparer le bilan de fin de saison");
	});

	it("renders season_recap email to players with champions banner, photo, and 10 awards cards", () => {
		const ev = { id: "Fall 2026-recap", season: "Fall 2026", week: 14, date: "Playoffs" };
		const payload = {
			season: "Fall 2026",
			champion: "Blue",
			photo_url: "https://rsvp.smbhl.com/api/champion-photo?s=Fall%202026",
			intro_note: "Merci à tous pour cette saison inoubliable!",
			outro_note: "À l'an prochain!",
			awards: {
				rocketRichard: "Roberto Santana with 15 goals",
				ladyByng: "Alex Romanello with 12 Assists, Francois was just behind at 11!",
				artRoss: "Roberto Santana with 20 Points",
				hartTrophy: "Roberto Santana with 3.3 PPG",
				norris: "Top Defenseman with 12 points",
				vezina: "Star Goalie (2.00 GAA)",
				calder: "Great Rookie with 10 points",
				subway: "Super Sub with 8 points",
				mvp: "Roberto scored or assisted in 67% of Team Blue's Goals",
				billMasterton: "Yanick Audet for dedication"
			}
		};

		const msg = body("season_recap", { ev, name: "Alex", team: "Blue", payload });
		expect(msg.subject).toContain("Félicitations aux Champions (Blue) & Bilan Fall 2026");
		expect(msg.text).toContain("FÉLICITATIONS AUX CHAMPIONS DE LA SAISON FALL 2026 : TEAM BLUE");
		expect(msg.text).toContain("Rocket Richard (Meilleur buteur, Top Goal Scorer)");
		expect(msg.text).toContain("Roberto Santana with 15 goals");
		expect(msg.text).toContain("Bill Masterton (Persévérance & esprit sportif, Perseverance & Sportsmanship)");
		expect(msg.text).toContain("Yanick Audet for dedication");
		expect(msg.html).toContain("Champions Fall 2026");
		expect(msg.html).toContain("Team Blue");
		expect(msg.html).toContain("https://rsvp.smbhl.com/api/champion-photo?s=Fall%202026");
		expect(msg.html).toContain("Georges Vézina");
		expect(msg.html).toContain("Star Goalie (2.00 GAA)");
	});

	it("dispatches season_recap to all regular players and subs who played, but excludes inactive subs", async () => {
		env.ADMIN_KEY = "super-secret-admin";

		// Setup database contacts
		// 1. Regular player (role = 'roster')
		await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt, opted_out)
			VALUES ('P1001', 'Regular Player', 'regular@example.com', 'roster', 'salt1', 0)`).run();

		// 2. Active sub who played in RSVP (role = 'sub_skater')
		await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt, opted_out)
			VALUES ('P1002', 'Active RSVP Sub', 'activesub@example.com', 'sub_skater', 'salt2', 0)`).run();
		await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date)
			VALUES ('2026-10-01', 'Fall 2026', 4, 'Sunday Oct 1, 2026')`).run();
		await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, updated_at)
			VALUES ('2026-10-01', 'P1002', 'Red', 'in', 'sub', '2026-10-01T10:00:00Z')`).run();

		// 3. Active sub who played according to data.json (role = 'sub_skater')
		await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt, opted_out)
			VALUES ('P1003', 'DataJson Sub', 'datajsonsub@example.com', 'sub_skater', 'salt3', 0)`).run();

		// 4. Inactive sub who NEVER played (role = 'sub_skater', 0 GP, no RSVP in)
		await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt, opted_out)
			VALUES ('P1004', 'Inactive Sub', 'inactivesub@example.com', 'sub_skater', 'salt4', 0)`).run();

		// 5. Opted out regular player
		await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt, opted_out)
			VALUES ('P1005', 'Opted Out Player', 'optedout@example.com', 'roster', 'salt5', 1)`).run();

		const mockData = {
			current_season: "Fall 2026",
			seasons: [{ name: "Fall 2026", standings: [] }],
			players: [
				{ id: "P1001", name: "Regular Player", seasons: { "Fall 2026": { gp: 5 } } },
				{ id: "P1003", name: "DataJson Sub", seasons: { "Fall 2026": { gp: 2 } } },
				{ id: "P1004", name: "Inactive Sub", seasons: { "Fall 2026": { gp: 0 } } }
			]
		};
		await env.SHEETS_KV.put("data_json", JSON.stringify(mockData));

		// Clear outbox first
		await env.DB.prepare("DELETE FROM outbox WHERE kind = 'season_recap'").run();

		const sendResp = await SELF.fetch("http://example.com/admin/season-recap/send", {
			method: "POST",
			headers: { "content-type": "application/json", "x-admin": env.ADMIN_KEY },
			body: JSON.stringify({
				season: "Fall 2026",
				champion: "Blue",
				awards: { rocketRichard: "Player with 10 goals" }
			})
		});
		expect(sendResp.status).toBe(200);

		// Verify recipients in outbox
		const queuedRecaps = (await env.DB.prepare("SELECT player_id FROM outbox WHERE kind = 'season_recap'").all()).results || [];
		const queuedPlayerIds = queuedRecaps.map(r => r.player_id);

		// Regular player received it
		expect(queuedPlayerIds).toContain("P1001");
		// Active sub from RSVP received it
		expect(queuedPlayerIds).toContain("P1002");
		// Active sub from data.json received it
		expect(queuedPlayerIds).toContain("P1003");
		// Inactive sub did NOT receive it
		expect(queuedPlayerIds).not.toContain("P1004");
		// Opted-out player did NOT receive it
		expect(queuedPlayerIds).not.toContain("P1005");
	});

	it("sanitizes accidental commas, trims whitespace, and rejects invalid emails", () => {
		expect(sanitizeAndValidateEmail("frederick,crevier@hec,ca")).toEqual({
			valid: true,
			email: "frederick.crevier@hec.ca"
		});
		expect(sanitizeAndValidateEmail("  CarlParise@Hotmail,com  ")).toEqual({
			valid: true,
			email: "carlparise@hotmail.com"
		});
		expect(sanitizeAndValidateEmail("bad-email")).toEqual({
			valid: false,
			email: "bad-email",
			error: "Format de courriel invalide / Invalid email format"
		});
		expect(sanitizeAndValidateEmail("user@domain")).toEqual({
			valid: false,
			email: "user@domain",
			error: "Format de courriel invalide / Invalid email format"
		});
		expect(sanitizeAndValidateEmail("")).toEqual({
			valid: false,
			email: "",
			error: "Courriel requis / Email required"
		});
	});

	it("validates and sanitizes email in /admin/people API", async () => {
		// Insert a test contact
		await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, is_sub, role, token_salt) VALUES ('P9988', 'Test Player', 'initial@example.com', 1, 'sub_skater', 'salt123')").run();

		// Try updating with invalid email -> should return 400
		const badResp = await SELF.fetch("http://example.com/admin/people", {
			method: "POST",
			headers: { "content-type": "application/json", "x-admin": env.ADMIN_KEY },
			body: JSON.stringify({ action: "email", player_id: "P9988", email: "invalid-email" })
		});
		expect(badResp.status).toBe(400);

		// Update with email containing commas -> should succeed and auto-fix
		const goodResp = await SELF.fetch("http://example.com/admin/people", {
			method: "POST",
			headers: { "content-type": "application/json", "x-admin": env.ADMIN_KEY },
			body: JSON.stringify({ action: "email", player_id: "P9988", email: "test,sub@example,com" })
		});
		expect(goodResp.status).toBe(200);
		const goodJson = await goodResp.json();
		expect(goodJson.ok).toBe(true);
		expect(goodJson.email).toBe("test.sub@example.com");

		const updated = await env.DB.prepare("SELECT email FROM contacts WHERE player_id = 'P9988'").first();
		expect(updated.email).toBe("test.sub@example.com");
	});

	it("manages contacts, phones, and renders /admin/contacts page", async () => {
		// 1. GET /admin/contacts page
		const pageResp = await SELF.fetch("http://example.com/admin/contacts");
		expect(pageResp.status).toBe(200);
		const html = await pageResp.text();
		expect(html).toContain("Contacts & Coordonnées");
		expect(html).toContain("Alignement Régulier");
		expect(html).toContain("data-ph=");
		expect(html).toContain("filter-contacts");

		// 2. Save phone number via POST /admin/contacts
		const phoneResp = await SELF.fetch("http://example.com/admin/contacts", {
			method: "POST",
			headers: { "content-type": "application/json", "x-admin": env.ADMIN_KEY },
			body: JSON.stringify({ action: "phone", player_id: "P9988", phone: "(514) 555-1234" })
		});
		expect(phoneResp.status).toBe(200);
		const phoneJson = await phoneResp.json();
		expect(phoneJson.ok).toBe(true);
		expect(phoneJson.phone).toBe("(514) 555-1234");

		const updatedContact = await env.DB.prepare("SELECT phone FROM contacts WHERE player_id = 'P9988'").first();
		expect(updatedContact.phone).toBe("(514) 555-1234");

		// 3. GET /admin/contacts/data returns people with phone field
		const dataResp = await SELF.fetch("http://example.com/admin/contacts/data", {
			headers: { "x-admin": env.ADMIN_KEY }
		});
		expect(dataResp.status).toBe(200);
		const dataJson = await dataResp.json();
		expect(dataJson).toHaveProperty("people");
		expect(dataJson).toHaveProperty("current_season");
		const testP = dataJson.people.find(p => p.player_id === "P9988");
		expect(testP).toBeDefined();
		expect(testP.phone).toBe("(514) 555-1234");
	});

	it("supports archiving, restoring, and safe-removing contacts without data loss", async () => {
		// 1. Setup a test regular player and a test sub
		await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, phone, role, is_sub, token_salt) VALUES ('P_ARCH_REG', 'Reggie Retiree', 'reggie@example.com', '514-111-2222', 'roster', 0, 'salt1')").run();
		await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, phone, role, is_sub, token_salt) VALUES ('P_ARCH_SUB', 'Sam Sub', 'sam@example.com', '514-333-4444', 'sub_skater', 1, 'salt2')").run();
		await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('P_TYPO', 'Typo Player', 'rantana@live.ca', 'roster', 'salt3')").run();
		await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, state) VALUES ('2026-10-11', 'Fall 2026', 2, '2026-10-11', 'open')").run();
		await env.DB.prepare("INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-10-11', 'P_ARCH_REG', 'Blue', 'pending', 'roster', 'auto', '2026-10-01T00:00:00Z')").run();

		// 2. Verify contacts page HTML renders archive table and card
		const pageResp = await SELF.fetch("http://example.com/admin/contacts");
		expect(pageResp.status).toBe(200);
		const html = await pageResp.text();
		expect(html).toContain("Archives");
		expect(html).toContain("cnt-archived");
		expect(html).toContain("data-archive=");
		expect(html).toContain("data-restore=");

		// 3. Archive regular player (e.g. taking a season off)
		const archResp = await SELF.fetch("http://example.com/admin/contacts", {
			method: "POST",
			headers: { "content-type": "application/json", "x-admin": env.ADMIN_KEY },
			body: JSON.stringify({ action: "archive", player_id: "P_ARCH_REG", reason: "season_off" })
		});
		expect(archResp.status).toBe(200);
		const archJson = await archResp.json();
		expect(archJson.ok).toBe(true);
		expect(archJson.archived).toBe(true);

		// Verify DB state: role='archived', dormant=1, previous_role='roster', open rsvp status set to 'out'
		const regDb = await env.DB.prepare("SELECT * FROM contacts WHERE player_id = 'P_ARCH_REG'").first();
		expect(regDb.role).toBe("archived");
		expect(regDb.previous_role).toBe("roster");
		expect(regDb.archive_reason).toBe("season_off");
		expect(regDb.dormant).toBe(1);

		const rsvpDb = await env.DB.prepare("SELECT status FROM rsvp WHERE event_id = '2026-10-11' AND player_id = 'P_ARCH_REG'").first();
		expect(rsvpDb.status).toBe("out");

		// 4. Safe remove sub (must archive, not delete!)
		const rmResp = await SELF.fetch("http://example.com/admin/contacts", {
			method: "POST",
			headers: { "content-type": "application/json", "x-admin": env.ADMIN_KEY },
			body: JSON.stringify({ action: "remove", player_id: "P_ARCH_SUB" })
		});
		expect(rmResp.status).toBe(200);
		const rmJson = await rmResp.json();
		expect(rmJson.ok).toBe(true);
		expect(rmJson.archived).toBe(true);

		const subDb = await env.DB.prepare("SELECT * FROM contacts WHERE player_id = 'P_ARCH_SUB'").first();
		expect(subDb).not.toBeNull();
		expect(subDb.role).toBe("archived");
		expect(subDb.previous_role).toBe("sub_skater");
		expect(subDb.phone).toBe("514-333-4444");

		// 5. GET /admin/contacts/data returns both players under archived
		const dataResp = await SELF.fetch("http://example.com/admin/contacts/data", {
			headers: { "x-admin": env.ADMIN_KEY }
		});
		expect(dataResp.status).toBe(200);
		const dataJson = await dataResp.json();
		expect(dataJson).toHaveProperty("archived");
		expect(dataJson.counts.archived).toBeGreaterThanOrEqual(2);

		const foundReg = dataJson.archived.find(p => p.player_id === "P_ARCH_REG");
		expect(foundReg).toBeDefined();
		expect(foundReg.previous_role).toBe("roster");
		expect(foundReg.archive_reason).toBe("season_off");

		// 6. Verify auto-correction of typo email
		const typoDb = await env.DB.prepare("SELECT email FROM contacts WHERE player_id = 'P_TYPO'").first();
		expect(typoDb.email).toBe("rsantana@live.ca");

		// 7. Restore sub back to active
		const restoreResp = await SELF.fetch("http://example.com/admin/contacts", {
			method: "POST",
			headers: { "content-type": "application/json", "x-admin": env.ADMIN_KEY },
			body: JSON.stringify({ action: "restore", player_id: "P_ARCH_SUB", target_role: "sub_skater" })
		});
		expect(restoreResp.status).toBe(200);
		const restoredSub = await env.DB.prepare("SELECT * FROM contacts WHERE player_id = 'P_ARCH_SUB'").first();
		expect(restoredSub.role).toBe("sub_skater");
		expect(restoredSub.dormant).toBe(0);
		expect(restoredSub.archive_reason).toBeNull();

		// 8. Purge permanent delete
		const purgeResp = await SELF.fetch("http://example.com/admin/contacts", {
			method: "POST",
			headers: { "content-type": "application/json", "x-admin": env.ADMIN_KEY },
			body: JSON.stringify({ action: "purge", player_id: "P_ARCH_REG" })
		});
		expect(purgeResp.status).toBe(200);
		const purgedDb = await env.DB.prepare("SELECT * FROM contacts WHERE player_id = 'P_ARCH_REG'").first();
		expect(purgedDb).toBeNull();
	});

	it("always restores archived contacts as subs and initializes new season contacts as subs", async () => {
		// 1. Setup former regular player who was archived
		await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, phone, role, previous_role, preferred_team, is_sub, is_goalie, dormant, asked_streak, token_salt) VALUES ('P_FORMER_ROSTER', 'Ex Regular', 'ex@example.com', '514-555-0000', 'archived', 'roster', 'Red', 0, 0, 1, 4, 'salt_ex')").run();
		await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, state) VALUES ('2026-10-11', 'Fall 2026', 2, '2026-10-11', 'open')").run();
		await env.DB.prepare("INSERT OR REPLACE INTO rsvp (event_id, player_id, team, role, status) VALUES ('2026-10-11', 'P_FORMER_ROSTER', 'Red', 'roster', 'out')").run();

		// 2. Restore via 1-Click Restore ([⚡ RÉACTIVER])
		const restoreResp = await SELF.fetch("http://example.com/admin/contacts", {
			method: "POST",
			headers: { "content-type": "application/json", "x-admin": env.ADMIN_KEY },
			body: JSON.stringify({ action: "restore", player_id: "P_FORMER_ROSTER" })
		});
		expect(restoreResp.status).toBe(200);
		const restoredData = await restoreResp.json();
		expect(restoredData.restored_to).toBe("sub_skater");

		const restoredContact = await env.DB.prepare("SELECT * FROM contacts WHERE player_id = 'P_FORMER_ROSTER'").first();
		expect(restoredContact.role).toBe("sub_skater");
		expect(restoredContact.is_sub).toBe(1);
		expect(restoredContact.preferred_team).toBeNull();
		expect(restoredContact.dormant).toBe(0);
		expect(restoredContact.asked_streak).toBe(0);
		expect(restoredContact.archive_reason).toBeNull();

		// 3. Verify open roster RSVPs for this player were removed
		const openRsvp = await env.DB.prepare("SELECT * FROM rsvp WHERE player_id = 'P_FORMER_ROSTER' AND role = 'roster'").first();
		expect(openRsvp).toBeNull();

		// 4. Test new_season_reset: converts all remaining 'roster' players into subs
		await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, role, preferred_team, is_sub, is_goalie, token_salt) VALUES ('P_REG_SEASON', 'Roster Player', 'reg@example.com', 'roster', 'Blue', 0, 0, 'salt_r')").run();
		const resetResp = await SELF.fetch("http://example.com/admin/contacts", {
			method: "POST",
			headers: { "content-type": "application/json", "x-admin": env.ADMIN_KEY },
			body: JSON.stringify({ action: "new_season_reset" })
		});
		expect(resetResp.status).toBe(200);
		const resetContact = await env.DB.prepare("SELECT * FROM contacts WHERE player_id = 'P_REG_SEASON'").first();
		expect(resetContact.role).toBe("sub_skater");
		expect(resetContact.is_sub).toBe(1);
		expect(resetContact.preferred_team).toBeNull();
	});

	it("marks outbox errors as failed statusCode in /admin/subs/data", async () => {
		await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, state) VALUES ('2026-10-04', 'Fall 2026', 1, '2026-10-04', 'open')").run();
		await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, is_sub, role, token_salt) VALUES ('P9977', 'Failed Delivery Sub', 'bad@example.com', 1, 'sub_skater', 'salt9977')").run();
		await env.DB.prepare("DELETE FROM outbox WHERE event_id = '2026-10-04'").run();
		await env.DB.prepare("INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, sent_at, cancelled, error, created_at) VALUES ('sub_call', '2026-10-04', 'P9977', 'Red', 'call:2026-10-04:skater:P9977', '{\"need\":\"skater\"}', '2026-10-01T00:00:00Z', NULL, 0, 'resend 422: validation_error', '2026-10-01T00:00:00Z')").run();

		const resp = await SELF.fetch("http://example.com/admin/subs/data?e=2026-10-04", {
			headers: { "x-admin": env.ADMIN_KEY }
		});
		expect(resp.status).toBe(200);
		const data = await resp.json();
		const sub = data.subs.find(s => s.player_id === "P9977");
		expect(sub).toBeDefined();
		expect(sub.statusCode).toBe("failed");
		expect(sub.statusLabelFr).toBe("⚠️ Échec d'envoi");
		expect(data.stats.failed).toBeGreaterThanOrEqual(1);
	});

	it("auto-cancels outbox messages when permanent validation error occurs during drain", async () => {
		env.RESEND_API_KEY = "re_mock_test";
		const past = new Date(Date.now() - 60000).toISOString();
		await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES ('2026-10-11', 'Fall 2026', 2, 'Sunday October 11', 'Brebeuf', 'open', '10:30')").run();
		await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, is_sub, role, token_salt) VALUES ('P9966', 'Invalid Mail Player', 'bad@broken', 1, 'sub_skater', 'salt9966')").run();
		await env.DB.prepare("DELETE FROM outbox WHERE event_id = '2026-10-11'").run();
		await env.DB.prepare("INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('sub_call', '2026-10-11', 'P9966', 'Red', 'call:2026-10-11:skater:P9966', '{\"need\":\"skater\"}', ?, ?)").bind(past, past).run();

		const result = await drain(env);
		expect(result.failed).toBe(1);

		const row = await env.DB.prepare("SELECT cancelled, error FROM outbox WHERE dedup_key = 'call:2026-10-11:skater:P9966'").first();
		expect(row.cancelled).toBe(1);
		expect(row.error).toContain("invalid email format");
	});

	it("places sub on team with greatest shortage when no team preference is set", async () => {
		const evId = "2026-10-18";
		await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES (?, 'Fall 2026', 3, 'Sunday Oct 18', 'Brebeuf', 'open', '10:30')").bind(evId).run();
		await env.DB.prepare("DELETE FROM rsvp WHERE event_id = ?").bind(evId).run();

		// Blue and White are full (8 skaters each)
		for (let i = 1; i <= 8; i++) {
			await env.DB.prepare("INSERT INTO rsvp (event_id, player_id, team, status, role) VALUES (?, ?, 'Blue', 'in', 'roster')").bind(evId, `P_BLU_${i}`).run();
			await env.DB.prepare("INSERT INTO rsvp (event_id, player_id, team, status, role) VALUES (?, ?, 'White', 'in', 'roster')").bind(evId, `P_WHT_${i}`).run();
		}

		// Red has 7 expected skaters (1 open spot)
		for (let i = 1; i <= 6; i++) {
			await env.DB.prepare("INSERT INTO rsvp (event_id, player_id, team, status, role) VALUES (?, ?, 'Red', 'in', 'roster')").bind(evId, `P_RED_${i}`).run();
		}
		await env.DB.prepare("INSERT INTO rsvp (event_id, player_id, team, status, role) VALUES (?, 'P_RED_PENDING', 'Red', 'pending', 'roster')").bind(evId).run();

		// Black has 6 expected skaters (2 open spots - higher shortage!)
		for (let i = 1; i <= 5; i++) {
			await env.DB.prepare("INSERT INTO rsvp (event_id, player_id, team, status, role) VALUES (?, ?, 'Black', 'in', 'roster')").bind(evId, `P_BLK_${i}`).run();
		}
		await env.DB.prepare("INSERT INTO rsvp (event_id, player_id, team, status, role) VALUES (?, 'P_BLK_PENDING', 'Black', 'pending', 'roster')").bind(evId).run();

		// Sub with no preferred team
		await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, is_sub, role, token_salt, preferred_team) VALUES ('P_SUB_NEUTRAL', 'Neutral Sub', 'neutral@example.com', 1, 'sub_skater', 'salt_neu', NULL)").run();

		const res = await acceptAvailability(env, { id: evId, state: 'open' }, 'P_SUB_NEUTRAL', 'skater');
		// Should be placed on Black because Black has 2 open spots vs Red's 1
		expect(res.placed).toBe("Black");
	});

	it("places sub on preferred team if an open spot exists", async () => {
		const evId = "2026-10-18";
		// Sub with preferred_team = Red
		await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, is_sub, role, token_salt, preferred_team) VALUES ('P_SUB_PREF_RED', 'Pref Red Sub', 'prefred@example.com', 1, 'sub_skater', 'salt_red', 'Red')").run();

		const res = await acceptAvailability(env, { id: evId, state: 'open' }, 'P_SUB_PREF_RED', 'skater');
		// Even though Black still has 1 open spot left, this sub prefers Red and Red has an open spot
		expect(res.placed).toBe("Red");
	});

	describe("Admin Finances & Dues Tracker", () => {
		it("renders /admin/finances page with streamlined table and no redundant adjustment column", async () => {
			const response = await SELF.fetch("http://example.com/admin/finances");
			expect(response.status).toBe(200);
			const html = await response.text();
			expect(html).toContain("Cotisations et Finances");
			expect(html).toContain("Tarification de la saison");
			expect(html).toContain("Total Attendu");
			expect(html).toContain("Total Perçu");
			expect(html).toContain("Total Dépenses");
			expect(html).toContain("Solde Net");
			expect(html).toContain("Dépenses & Coûts d'exploitation");
			// Verified streamlined columns
			expect(html).toContain("Dû ($)");
			expect(html).toContain("Payé ($)");
			expect(html).not.toContain("Ajust. (+/-)");
			// Verified bilingual engine support
			expect(html).toContain("I18N_FINANCES");
			expect(html).toContain("Total Billed");
			expect(html).toContain("Total Collected");
			expect(html).toContain("Season Pricing Setup");

			// Admin navigation tabs present and unhidden in client script
			expect(html).toContain('href="/admin/board"');
			expect(html).toContain('href="/admin/subs"');
			expect(html.includes('href="/admin/people"') || html.includes('href="/admin/contacts"')).toBe(true);
			expect(html).toContain('href="/admin/schedule"');
			expect(html).toContain('href="/admin/finances"');
			expect(html).toContain('href="/admin/review"');
			expect(html).toContain('href="/admin/polls"');
			expect(html).toContain('href="/admin/season-recap"');
			expect(html).toContain("document.querySelectorAll('.picker').forEach");
		});

		it("rejects unauthorized access to /admin/finances endpoints", async () => {
			const dResp = await SELF.fetch("http://example.com/admin/finances/data");
			expect(dResp.status).toBe(403);
			expect(await dResp.text()).toBe("nope");

			const pResp = await SELF.fetch("http://example.com/admin/finances/pricing", { method: "POST" });
			expect(pResp.status).toBe(403);
			expect(await pResp.text()).toBe("nope");

			const plResp = await SELF.fetch("http://example.com/admin/finances/player", { method: "POST" });
			expect(plResp.status).toBe(403);
			expect(await plResp.text()).toBe("nope");

			const cResp = await SELF.fetch("http://example.com/admin/finances/cost", { method: "POST" });
			expect(cResp.status).toBe(403);
			expect(await cResp.text()).toBe("nope");

			const cdResp = await SELF.fetch("http://example.com/admin/finances/cost/delete", { method: "POST" });
			expect(cdResp.status).toBe(403);
			expect(await cdResp.text()).toBe("nope");
		});

		it("correctly identifies subs (Henrik/Armando), excludes dropped 0-GP players (Alexandre), and ignores open upcoming events", async () => {
			env.ADMIN_KEY = "test-finances-admin";
			const season = "Winter 2027";

			// Mock data representing:
			// 1. Regular active skater on Blue (Adam)
			// 2. Regular active goalie on Blue (Anthony)
			// 3. Sub skater with 2 games played in data.json (Henrik Santana)
			// 4. Sub skater with 2 games played in data.json (Armando Tempestilli)
			// 5. Dropped player with team null and 0 GP (Alexandre Oliveira)
			const mockData = {
				current_season: season,
				seasons: [{ name: season }],
				players: [
					{
						id: "P_TEST_REG_SKATER",
						name: "Adam Regular",
						seasons: { "Winter 2027": { team: "Blue", gp: 2, pos: "F" } }
					},
					{
						id: "P_TEST_REG_GOALIE",
						name: "Anthony Goalie",
						seasons: { "Winter 2027": { team: "Blue", gp: 2, pos: "G" } },
						gseasons: { "Winter 2027": { team: "Blue", gp: 2 } }
					},
					{
						id: "P_TEST_HENRIK",
						name: "Henrik Santana",
						seasons: { "Winter 2027": { team: null, pos: null, gp: 2 } }
					},
					{
						id: "P_TEST_ARMANDO",
						name: "Armando Tempestilli",
						seasons: { "Winter 2027": { team: null, pos: null, gp: 2 } }
					},
					{
						id: "P_TEST_ALEXANDRE",
						name: "Alexandre Oliveira",
						seasons: { "Winter 2027": { team: null, pos: "D", gp: 0 } }
					}
				]
			};
			await env.SHEETS_KV.put("data_json", JSON.stringify(mockData));

			// Contacts table
			await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, is_sub, role) VALUES ('P_TEST_REG_SKATER', 'Adam Regular', 'adam@test.com', 0, 'roster')").run();
			await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, is_sub, role, is_goalie) VALUES ('P_TEST_REG_GOALIE', 'Anthony Goalie', 'anthony@test.com', 0, 'roster', 1)").run();
			await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, is_sub, role) VALUES ('P_TEST_HENRIK', 'Henrik Santana', 'henrik@test.com', 1, 'sub_skater')").run();
			await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, is_sub, role) VALUES ('P_TEST_ARMANDO', 'Armando Tempestilli', 'armando@test.com', 1, 'sub_skater')").run();
			await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, is_sub, role) VALUES ('P_TEST_ALEXANDRE', 'Alexandre Oliveira', 'alex@test.com', 1, 'sub_skater')").run();

			// Setup an upcoming OPEN event for next week with subs signed up 'in'
			// These subs have NOT played yet, so they must NOT owe anything or appear
			await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES ('2027-01-20', 'Winter 2027', 3, 'Sunday Jan 20', 'Letendre', 'open', '10:30')").run();
			await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, is_sub, role) VALUES ('P_TEST_UPCOMING_SUB', 'Upcoming Sub', 'upcoming@test.com', 1, 'sub_skater')").run();
			await env.DB.prepare("INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role) VALUES ('2027-01-20', 'P_TEST_UPCOMING_SUB', 'Red', 'in', 'sub')").run();

			// Clean any prior dues for clean assertions
			await env.DB.prepare("DELETE FROM season_pricing WHERE season = ?").bind(season).run();
			await env.DB.prepare("DELETE FROM player_dues WHERE season = ?").bind(season).run();

			// Set pricing: 170 regular skater, 0 regular goalie, 10 sub skater, 0 sub goalie
			await env.DB.prepare("INSERT INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, updated_at) VALUES (?, 170, 0, 10, 0, datetime('now'))").bind(season).run();

			const res = await SELF.fetch(`http://example.com/admin/finances/data?s=${encodeURIComponent(season)}`, {
				headers: { "x-admin": env.ADMIN_KEY }
			});
			expect(res.status).toBe(200);
			const data = await res.json();

			// 1. Regular Skater: owes $170
			const regSkater = data.players.find(p => p.player_id === "P_TEST_REG_SKATER");
			expect(regSkater).toBeDefined();
			expect(regSkater.is_sub).toBe(false);
			expect(regSkater.total_due).toBe(170);

			// 2. Regular Goalie: owes $0 (exempt)
			const regGoalie = data.players.find(p => p.player_id === "P_TEST_REG_GOALIE");
			expect(regGoalie).toBeDefined();
			expect(regGoalie.is_sub).toBe(false);
			expect(regGoalie.total_due).toBe(0);

			// 3. Henrik Santana: played as sub (team: null), 2 games -> owes $20 (2 * $10)
			const henrik = data.players.find(p => p.player_id === "P_TEST_HENRIK");
			expect(henrik).toBeDefined();
			expect(henrik.is_sub).toBe(true);
			expect(henrik.role).toBe("sub_skater");
			expect(henrik.games_played).toBe(2);
			expect(henrik.total_due).toBe(20);

			// 4. Armando Tempestilli: played as sub (team: null), 2 games -> owes $20 (2 * $10)
			const armando = data.players.find(p => p.player_id === "P_TEST_ARMANDO");
			expect(armando).toBeDefined();
			expect(armando.is_sub).toBe(true);
			expect(armando.role).toBe("sub_skater");
			expect(armando.games_played).toBe(2);
			expect(armando.total_due).toBe(20);

			// 5. Alexandre Oliveira: dropped, 0 GP, no custom dues -> must NOT be in the table
			const alexandre = data.players.find(p => p.player_id === "P_TEST_ALEXANDRE");
			expect(alexandre).toBeUndefined();

			// 6. Upcoming sub in open event: has not played yet -> must NOT be in the table
			const upcomingSub = data.players.find(p => p.player_id === "P_TEST_UPCOMING_SUB");
			expect(upcomingSub).toBeUndefined();

			// Summary KPIs: 170 (regSkater) + 0 (regGoalie) + 20 (henrik) + 20 (armando) = 210
			expect(data.summary.totalDue).toBe(210);
			expect(data.summary.totalPaid).toBe(0);
			expect(data.summary.totalOutstanding).toBe(210);
		});

		it("allows direct inline editing of custom due amount and payments without separate adjustment math", async () => {
			env.ADMIN_KEY = "test-finances-admin";
			const season = "Winter 2027";

			// Change Adam's due directly to $150 (late start override) and record full payment
			const savePlayerResp = await SELF.fetch("http://example.com/admin/finances/player", {
				method: "POST",
				headers: { "x-admin": env.ADMIN_KEY, "content-type": "application/json" },
				body: JSON.stringify({
					season,
					player_id: "P_TEST_REG_SKATER",
					custom_due: 150,
					amount_paid: 150,
					notes: "Special pricing $150 paid in full"
				})
			});
			expect(savePlayerResp.status).toBe(200);

			// Reload data to verify
			const res = await SELF.fetch(`http://example.com/admin/finances/data?s=${encodeURIComponent(season)}`, {
				headers: { "x-admin": env.ADMIN_KEY }
			});
			const data = await res.json();
			const regSkater = data.players.find(p => p.player_id === "P_TEST_REG_SKATER");
			expect(regSkater.custom_due).toBe(150);
			expect(regSkater.total_due).toBe(150);
			expect(regSkater.amount_paid).toBe(150);
			expect(regSkater.outstanding).toBe(0);
			expect(regSkater.status).toBe("paid");

			// Total due is now 150 (reg) + 0 (goalie) + 20 (henrik) + 20 (armando) = 190
			expect(data.summary.totalDue).toBe(190);
			expect(data.summary.totalPaid).toBe(150);
			expect(data.summary.totalOutstanding).toBe(40);
		});

		it("tracks league operational costs (rental, equipment, technology, other), computes net balance, and allows deletion", async () => {
			env.ADMIN_KEY = "test-finances-admin";
			const season = "Winter 2027";

			// 1. Add costs in the 4 categories
			// Rental
			const cRentalResp = await SELF.fetch("http://example.com/admin/finances/cost", {
				method: "POST",
				headers: { "x-admin": env.ADMIN_KEY, "content-type": "application/json" },
				body: JSON.stringify({ season, category: "rental", description: "Gymnase Collège Letendre", amount: 1200 })
			});
			expect(cRentalResp.status).toBe(200);
			const cRentalJson = await cRentalResp.json();
			expect(cRentalJson.ok).toBe(true);

			// Equipment
			const cEquipResp = await SELF.fetch("http://example.com/admin/finances/cost", {
				method: "POST",
				headers: { "x-admin": env.ADMIN_KEY, "content-type": "application/json" },
				body: JSON.stringify({ season, category: "equipment", description: "Balles officielles D-Gel & filets", amount: 250 })
			});
			expect(cEquipResp.status).toBe(200);

			// Technology
			const cTechResp = await SELF.fetch("http://example.com/admin/finances/cost", {
				method: "POST",
				headers: { "x-admin": env.ADMIN_KEY, "content-type": "application/json" },
				body: JSON.stringify({ season, category: "technology", description: "Domaine smbhl.com + Resend emails", amount: 60 })
			});
			expect(cTechResp.status).toBe(200);

			// Other
			const cOtherResp = await SELF.fetch("http://example.com/admin/finances/cost", {
				method: "POST",
				headers: { "x-admin": env.ADMIN_KEY, "content-type": "application/json" },
				body: JSON.stringify({ season, category: "other", description: "Trophées des séries & ruban", amount: 40 })
			});
			expect(cOtherResp.status).toBe(200);
			const cOtherJson = await cOtherResp.json();
			const otherCostId = cOtherJson.id;

			// 2. Fetch data and verify cost breakdown and net financial balances
			const res = await SELF.fetch(`http://example.com/admin/finances/data?s=${encodeURIComponent(season)}`, {
				headers: { "x-admin": env.ADMIN_KEY }
			});
			expect(res.status).toBe(200);
			const data = await res.json();

			expect(data.costs).toHaveLength(4);
			expect(data.costSummary.rental).toBe(1200);
			expect(data.costSummary.equipment).toBe(250);
			expect(data.costSummary.technology).toBe(60);
			expect(data.costSummary.other).toBe(40);
			expect(data.costSummary.totalCosts).toBe(1550);
			expect(data.summary.totalCosts).toBe(1550);

			// Player dues: totalPaid = 150, totalDue = 190
			// netBalance = 150 - 1550 = -1400 (deficit / à combler)
			// netProjected = 190 - 1550 = -1360
			expect(data.summary.netBalance).toBe(-1400);
			expect(data.summary.netProjected).toBe(-1360);

			// 3. Delete 'other' cost
			const delResp = await SELF.fetch("http://example.com/admin/finances/cost/delete", {
				method: "POST",
				headers: { "x-admin": env.ADMIN_KEY, "content-type": "application/json" },
				body: JSON.stringify({ id: otherCostId, season })
			});
			expect(delResp.status).toBe(200);

			// Verify cost was deleted and summary updated
			const res2 = await SELF.fetch(`http://example.com/admin/finances/data?s=${encodeURIComponent(season)}`, {
				headers: { "x-admin": env.ADMIN_KEY }
			});
			const data2 = await res2.json();
			expect(data2.costs).toHaveLength(3);
			expect(data2.costSummary.other).toBe(0);
			expect(data2.costSummary.totalCosts).toBe(1510);
			expect(data2.summary.totalCosts).toBe(1510);
			expect(data2.summary.netBalance).toBe(150 - 1510); // -1360
		});

		it("supports 2-decimal amounts and Interac e-transfer phone number across pricing, dues, and costs", async () => {
			env.ADMIN_KEY = "test-finances-admin";
			const season = "Summer 2027";

			// 1. Save pricing with 2 decimals and e-transfer phone
			const pricingResp = await SELF.fetch("http://example.com/admin/finances/pricing", {
				method: "POST",
				headers: { "x-admin": env.ADMIN_KEY, "content-type": "application/json" },
				body: JSON.stringify({
					season,
					price_player: 175.50,
					price_goalie: 0,
					price_sub_player: 7.25,
					price_sub_goalie: 0,
					etransfer_phone: "514-555-4321"
				})
			});
			expect(pricingResp.status).toBe(200);

			// 2. Save player custom dues and payment with 2 decimals
			const playerResp = await SELF.fetch("http://example.com/admin/finances/player", {
				method: "POST",
				headers: { "x-admin": env.ADMIN_KEY, "content-type": "application/json" },
				body: JSON.stringify({
					season,
					player_id: "P_DECIMAL_TEST",
					custom_due: 143.75,
					amount_paid: 50.25,
					notes: "Pro-rated dues"
				})
			});
			expect(playerResp.status).toBe(200);

			// 3. Save operating cost with 2 decimals
			const costResp = await SELF.fetch("http://example.com/admin/finances/cost", {
				method: "POST",
				headers: { "x-admin": env.ADMIN_KEY, "content-type": "application/json" },
				body: JSON.stringify({
					season,
					category: "equipment",
					description: "Tape and balls",
					amount: 42.50
				})
			});
			expect(costResp.status).toBe(200);

			// 4. Fetch /admin/finances/data and verify pricing, dues, and costs
			const res = await SELF.fetch(`http://example.com/admin/finances/data?s=${encodeURIComponent(season)}`, {
				headers: { "x-admin": env.ADMIN_KEY }
			});
			expect(res.status).toBe(200);
			const data = await res.json();

			expect(data.pricing.price_player).toBe(175.5);
			expect(data.pricing.price_sub_player).toBe(7.25);
			expect(data.pricing.etransfer_phone).toBe("514-555-4321");

			const p = data.players.find(x => x.player_id === "P_DECIMAL_TEST");
			expect(p).toBeDefined();
			expect(p.custom_due).toBe(143.75);
			expect(p.total_due).toBe(143.75);
			expect(p.amount_paid).toBe(50.25);
			expect(p.outstanding).toBe(93.5); // 143.75 - 50.25

			const costItem = data.costs.find(c => c.description === "Tape and balls");
			expect(costItem).toBeDefined();
			expect(costItem.amount).toBe(42.5);
			expect(data.costSummary.equipment).toBe(42.5);
		});

		it("renders sub fee in gameday email for sub skaters and excludes it for sub goalies ($0 fee)", () => {
			const ev = { id: "2026-09-20", week: 3, date: "Sunday September 20" };

			// Sub skater with fee ($10.00 = 2 * $5.00)
			const resSkater = body('gameday', {
				ev,
				name: 'Henrik',
				team: 'Blue',
				link: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0003&t=tok123',
				payload: {
					subFee: { perGame: 5, total: 10, phone: "514-555-7890" }
				}
			});
			expect(resSkater.text).toContain("💵 Frais de substitut / Sub Fee : 10,00 $");
			expect(resSkater.text).not.toContain("2 matchs");
			expect(resSkater.text).toContain("Paiement en argent comptant sur place ou par virement Interac au 514-555-7890.");
			expect(resSkater.text).toContain("Please bring cash to the gym or send an Interac e-Transfer to 514-555-7890.");
			expect(resSkater.html).toContain("10,00 $");
			expect(resSkater.html).not.toContain("2 matchs");
			expect(resSkater.html).toContain("514-555-7890");

			// Sub goalie with $0 fee (subFee is omitted or 0)
			const resGoalie = body('gameday', {
				ev,
				name: 'Anthony',
				team: 'Red',
				link: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0004&t=tok456',
				payload: {}
			});
			expect(resGoalie.text).not.toContain("Frais de substitut");
			expect(resGoalie.text).not.toContain("Sub Fee");
			expect(resGoalie.html).not.toContain("Frais de substitut");
			expect(resGoalie.html).not.toContain("Sub Fee");
		});

		it("renders dues reminder in invite email for regulars with balance and excludes it when fully paid", () => {
			const ev = { id: "2026-09-20", week: 3, date: "Sunday September 20" };

			// Regular player with balance due ($170.00)
			const resUnpaid = body('invite', {
				ev,
				name: 'Roberto',
				team: 'Red',
				link: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0001&t=tok111',
				payload: {
					yes: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0001&t=tok111&v=in',
					no: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0001&t=tok111&v=out',
					duesReminder: { balance: 170, phone: "514-555-7890" },
					teamLink: 'https://rsvp.smbhl.com/team-rsvp?s=2026&team=Red&t=tok999'
				}
			});
			expect(resUnpaid.text).toContain("Montant dû / Amount due : 170,00 $");
			expect(resUnpaid.text).toContain("Paiement en argent comptant sur place ou par virement Interac au 514-555-7890.");
			expect(resUnpaid.text).toContain("Please bring cash to the gym or send an Interac e-Transfer to 514-555-7890.");
			expect(resUnpaid.html).toContain("170,00 $");
			expect(resUnpaid.html).toContain("514-555-7890");
			expect(resUnpaid.text).toContain("Gérer l'équipe Rouge / Manage Red roster & subs");
			expect(resUnpaid.text).toContain("https://rsvp.smbhl.com/team-rsvp?s=2026&team=Red&t=tok999");
			expect(resUnpaid.html).toContain("Gérer l&#39;équipe Rouge / Manage Red roster &amp; subs");
			expect(resUnpaid.html).toContain("https://rsvp.smbhl.com/team-rsvp?s=2026&amp;team=Red&amp;t=tok999");

			// Regular player with 0 balance
			const resPaid = body('invite', {
				ev,
				name: 'Roberto',
				team: 'Red',
				link: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0001&t=tok111',
				payload: {
					yes: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0001&t=tok111&v=in',
					no: 'https://rsvp.smbhl.com/rsvp?e=2026-09-20&p=P0001&t=tok111&v=out'
				}
			});
			expect(resPaid.text).not.toContain("Cotisation de saison");
			expect(resPaid.text).not.toContain("Season Dues");
			expect(resPaid.html).not.toContain("Cotisation de saison");
			expect(resPaid.html).not.toContain("Season Dues");
			expect(resPaid.text).not.toContain("Gérer l'équipe");
			expect(resPaid.html).not.toContain("Gérer l'équipe");
		});

		it("drain() populates subFee for confirmed sub skaters and duesReminder for unpaid regular players", async () => {
			const originalFetch = globalThis.fetch;
			const sent = [];
			globalThis.fetch = async (url, opts) => {
				if (String(url).includes('api.resend.com')) {
					sent.push(JSON.parse(opts.body));
					return new Response(JSON.stringify({ id: 'mock_resend_drain_dues' }), { status: 200 });
				}
				return originalFetch(url, opts);
			};

			try {
				env.RESEND_API_KEY = 're_test_key_123';
				env.RSVP_SECRET = 'test-secret-12345';
				const now = new Date(Date.now() - 60000).toISOString();
				const season = "DrainSeason 2026";

				await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES ('ev-drain-dues', ?, 1, 'Sunday Sept 20', 'Gym', 'open', '10:30')`).bind(season).run();
				await env.DB.prepare(`INSERT OR REPLACE INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, etransfer_phone, updated_at) VALUES (?, 170, 0, 5, 0, '514-555-0000', ?)`).bind(season, now).run();

				// 1. Confirmed sub skater
				await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt) VALUES ('P_SUB_SKATER', 'Sub Skater', 'sub_skater@test.com', 'sub', 1, 'salt_sub')`).run();
				await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('ev-drain-dues', 'P_SUB_SKATER', 'Blue', 'in', 'sub', 'self', ?)`).bind(now).run();
				await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('gameday', 'ev-drain-dues', 'P_SUB_SKATER', 'Blue', 'gameday:sub_skater', '{}', ?, ?)`).bind(now, now).run();

				// 2. Confirmed sub goalie ($0 fee)
				await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt) VALUES ('P_SUB_GOALIE', 'Sub Goalie', 'sub_goalie@test.com', 'sub_goalie', 1, 1, 'salt_sub_g')`).run();
				await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('ev-drain-dues', 'P_SUB_GOALIE', 'Red', 'in', 'sub', 'self', ?)`).bind(now).run();
				await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('gameday', 'ev-drain-dues', 'P_SUB_GOALIE', 'Red', 'gameday:sub_goalie', '{}', ?, ?)`).bind(now, now).run();

				// 3. Regular player with unpaid balance ($170)
				await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt) VALUES ('P_REG_UNPAID', 'Unpaid Regular', 'unpaid_reg@test.com', 'roster', 0, 'salt_reg_unpaid')`).run();
				await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('invite', 'ev-drain-dues', 'P_REG_UNPAID', 'Blue', 'invite:reg_unpaid', '{}', ?, ?)`).bind(now, now).run();

				// 4. Regular player who is fully paid
				await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt) VALUES ('P_REG_PAID', 'Paid Regular', 'paid_reg@test.com', 'roster', 0, 'salt_reg_paid')`).run();
				await env.DB.prepare(`INSERT OR REPLACE INTO player_dues (season, player_id, custom_due, adjustment, amount_paid, notes, updated_at) VALUES (?, 'P_REG_PAID', 170, 0, 170, 'Paid', ?)`).bind(season, now).run();
				await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('invite', 'ev-drain-dues', 'P_REG_PAID', 'Red', 'invite:reg_paid', '{}', ?, ?)`).bind(now, now).run();

				const drainResult = await drain(env);
				expect(drainResult.sent).toBe(4);

				// Verify emails sent
				const subSkaterMail = sent.find(m => m.to[0] === 'sub_skater@test.com');
				expect(subSkaterMail).toBeDefined();
				expect(subSkaterMail.html).toContain("10,00 $");
				expect(subSkaterMail.html).toContain("514-555-0000");

				const subGoalieMail = sent.find(m => m.to[0] === 'sub_goalie@test.com');
				expect(subGoalieMail).toBeDefined();
				expect(subGoalieMail.html).not.toContain("Frais de substitut");

				const unpaidRegMail = sent.find(m => m.to[0] === 'unpaid_reg@test.com');
				expect(unpaidRegMail).toBeDefined();
				expect(unpaidRegMail.html).toContain("170,00 $");
				expect(unpaidRegMail.html).toContain("514-555-0000");
				expect(unpaidRegMail.html).toContain("Gérer l&#39;équipe Bleu / Manage Blue roster &amp; subs");

				const paidRegMail = sent.find(m => m.to[0] === 'paid_reg@test.com');
				expect(paidRegMail).toBeDefined();
				expect(paidRegMail.html).not.toContain("Cotisation de saison");
				expect(paidRegMail.html).toContain("Gérer l&#39;équipe Rouge / Manage Red roster &amp; subs");
			} finally {
				globalThis.fetch = originalFetch;
			}
		}, 15000);
	});

	describe("Permanent Team Redirect Links (/t/:team and /team/:team)", () => {
		it("redirects /t/red, /t/blue, /t/white, /t/black to the authenticated team-rsvp URL", async () => {
			for (const team of ["red", "blue", "white", "black"]) {
				const res = await SELF.fetch(`http://example.com/t/${team}`, { redirect: "manual" });
				expect(res.status).toBe(302);
				const loc = res.headers.get("location");
				expect(loc).toContain("/team-rsvp?");
				expect(loc).toContain(`team=${team.charAt(0).toUpperCase() + team.slice(1)}`);
				expect(loc).toContain("&t=");
			}
		});

		it("supports case-insensitive /team/:team redirects", async () => {
			const res = await SELF.fetch("http://example.com/team/Red", { redirect: "manual" });
			expect(res.status).toBe(302);
			const loc = res.headers.get("location");
			expect(loc).toContain("/team-rsvp?");
			expect(loc).toContain("team=Red");
		});
	});

	describe("Planned Absences & Security Rate-Limiting", () => {
		it("allows players to save planned future absences via POST /rsvp/absences with HMAC authentication", async () => {
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('P100', 'Absence Player', 'abs@test.com', 'roster', 'salt_abs')`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date, state) VALUES ('2026-09-20', 'Fall 2026', 2, 'Sunday September 20', 'open')`).run();

			const encoder = new TextEncoder();
			const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			const sig = await crypto.subtle.sign("HMAC", key, encoder.encode("p:2026-09-20:P100:salt_abs"));
			const validToken = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

			// Unauthorized request with invalid token
			const badRes = await SELF.fetch("http://example.com/rsvp/absences", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ event_id: "2026-09-20", player_id: "P100", token: "badtoken", season: "Fall 2026", dates: ["2026-09-27"] })
			});
			expect(badRes.status).toBe(403);

			// Authorized request
			const goodRes = await SELF.fetch("http://example.com/rsvp/absences", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ event_id: "2026-09-20", player_id: "P100", token: validToken, season: "Fall 2026", dates: ["2026-09-27", "2026-10-04"] })
			});
			expect(goodRes.status).toBe(200);
			const data = await goodRes.json();
			expect(data.ok).toBe(true);
			expect(data.count).toBe(2);

			// Verify in DB
			const saved = (await env.DB.prepare(`SELECT date FROM planned_absences WHERE player_id='P100' ORDER BY date`).all()).results;
			expect(saved.map(s => s.date)).toEqual(["2026-09-27", "2026-10-04"]);
		});

		it("blocks subs from submitting planned absences via POST /rsvp/absences", async () => {
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt) VALUES ('P_SUB_TEST', 'Sub Player', 'sub@test.com', 'sub', 1, 'salt_sub')`).run();

			const encoder = new TextEncoder();
			const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			const sig = await crypto.subtle.sign("HMAC", key, encoder.encode("p:2026-09-20:P_SUB_TEST:salt_sub"));
			const subToken = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);

			const subRes = await SELF.fetch("http://example.com/rsvp/absences", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ event_id: "2026-09-20", player_id: "P_SUB_TEST", token: subToken, season: "Fall 2026", dates: ["2026-09-27"] })
			});
			expect(subRes.status).toBe(400);
			const txt = await subRes.text();
			expect(txt).toContain("Planned absences are only for regular roster players");
		});

		it("allows admin to add and delete planned absences via POST /admin/absences (by player_id/date or by id)", async () => {
			const adminKey = env.ADMIN_KEY || "SMBHLCAUFIELD";
			// Delete one of the absences
			const delRes = await SELF.fetch("http://example.com/admin/absences", {
				method: "POST",
				headers: { "x-admin": adminKey, "content-type": "application/json" },
				body: JSON.stringify({ action: "delete", player_id: "P100", date: "2026-10-04" })
			});
			expect(delRes.status).toBe(200);

			const afterDel = (await env.DB.prepare(`SELECT date FROM planned_absences WHERE player_id='P100'`).all()).results;
			expect(afterDel.map(s => s.date)).toEqual(["2026-09-27"]);

			// Add an absence
			const addRes = await SELF.fetch("http://example.com/admin/absences", {
				method: "POST",
				headers: { "x-admin": adminKey, "content-type": "application/json" },
				body: JSON.stringify({ action: "add", player_id: "P100", date: "2026-10-11", season: "Fall 2026" })
			});
			expect(addRes.status).toBe(200);

			// Delete by ID
			const row = await env.DB.prepare(`SELECT id FROM planned_absences WHERE player_id='P100' AND date='2026-10-11'`).first();
			expect(row && row.id).toBeTruthy();

			const delByIdRes = await SELF.fetch("http://example.com/admin/absences", {
				method: "POST",
				headers: { "x-admin": adminKey, "content-type": "application/json" },
				body: JSON.stringify({ action: "delete", id: row.id })
			});
			expect(delByIdRes.status).toBe(200);

			const afterDelById = (await env.DB.prepare(`SELECT date FROM planned_absences WHERE player_id='P100' ORDER BY date`).all()).results;
			expect(afterDelById.map(s => s.date)).toEqual(["2026-09-27"]);
		});

		it("returns planned_absences in /admin/board/data", async () => {
			const adminKey = env.ADMIN_KEY || "SMBHLCAUFIELD";
			const res = await SELF.fetch("http://example.com/admin/board/data", {
				headers: { "x-admin": adminKey }
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(Array.isArray(data.planned_absences)).toBe(true);
			expect(data.planned_absences.some(a => a.player_id === "P100")).toBe(true);
		});

		it("returns HTTP 429 when an IP exceeds 10 failed admin login attempts", async () => {
			const attackerIp = "198.51.100.42";
			for (let i = 0; i < 10; i++) {
				const res = await SELF.fetch("http://example.com/admin/board/data", {
					headers: { "cf-connecting-ip": attackerIp, "x-admin": "wrong-password-" + i }
				});
				expect(res.status).toBe(403);
			}

			// 11th attempt must be locked out with 429
			const lockedRes = await SELF.fetch("http://example.com/admin/board/data", {
				headers: { "cf-connecting-ip": attackerIp, "x-admin": "wrong-password-11" }
			});
			expect(lockedRes.status).toBe(429);
			const txt = await lockedRes.text();
			expect(txt).toContain("Too many failed attempts");
		});

		it("does not send automated email right away when subs are assigned or reassigned > 24h out; only sends with final reminder", async () => {
			const eventId = "2026-11-15"; // Way in the future (> 24 hours)
			await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, start_time, venue, state) VALUES (?, 'Fall 2026', 10, '2026-11-15', '10:30', 'Collège Letendre', 'open')")
				.bind(eventId).run();

			const subId = "P_SUB_TEST";
			await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub) VALUES (?, 'Sub Test', 'subtest@example.com', 'sub_skater', 1)")
				.bind(subId).run();

			// Place sub on White
			await env.DB.prepare("INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by) VALUES (?, ?, 'White', 'in', 'sub', 'admin')")
				.bind(eventId, subId).run();

			// Reassign sub to Black via /admin/subs/reassign
			const adminKey = env.ADMIN_KEY || "SMBHLCAUFIELD";
			const reassignRes = await SELF.fetch("http://example.com/admin/subs/reassign", {
				method: "POST",
				headers: { "x-admin": adminKey, "content-type": "application/json" },
				body: JSON.stringify({ event_id: eventId, player_id: subId, team: "Black" })
			});
			expect(reassignRes.status).toBe(200);

			// Check outbox: NO immediate email must be enqueued because it is > 24 hours out!
			const pendingEmails = (await env.DB.prepare("SELECT * FROM outbox WHERE event_id = ? AND player_id = ? AND cancelled = 0")
				.bind(eventId, subId).all()).results || [];
			expect(pendingEmails.length).toBe(0);

			// Verify team in DB is updated to Black
			const rsvp = await env.DB.prepare("SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?")
				.bind(eventId, subId).first();
			expect(rsvp.team).toBe("Black");
		});

		it("sorts team rows on admin board: G on top -> regulars confirmed -> subs confirmed -> regulars unsure -> absent", async () => {
			const sampleRows = [
				{ name: "Zack Absent Skater", is_goalie: 0, role: "roster", status: "out" },
				{ name: "Bob Confirmed Regular", is_goalie: 0, role: "roster", status: "in" },
				{ name: "Charlie Unsure Regular", is_goalie: 0, role: "roster", status: "pending" },
				{ name: "Sam Confirmed Sub", is_goalie: 0, role: "sub", status: "in" },
				{ name: "Alice Confirmed Regular", is_goalie: 0, role: "roster", status: "in" },
				{ name: "Gerry Confirmed Goalie", is_goalie: 1, role: "roster", status: "in" },
				{ name: "David Absent Regular", is_goalie: 0, role: "roster", status: "out" },
				{ name: "Frank Unsure Regular", is_goalie: 0, role: "roster", status: "pending" },
			];

			const sorted = sortTeamBoardRows(sampleRows);
			const names = sorted.map(r => r.name);

			expect(names).toEqual([
				"Gerry Confirmed Goalie",     // 1. The G on top
				"Alice Confirmed Regular",    // 2. Regulars who confirmed (alphabetical)
				"Bob Confirmed Regular",      // 2. Regulars who confirmed
				"Sam Confirmed Sub",          // 3. Subs that confirmed
				"Charlie Unsure Regular",     // 4. Regulars that are unsure (alphabetical)
				"Frank Unsure Regular",       // 4. Regulars that are unsure
				"David Absent Regular",       // 5. Absent (alphabetical)
				"Zack Absent Skater"          // 5. Absent
			]);
		});

		it("puts sub goalie on top when regular goalie is absent", async () => {
			const sampleRows = [
				{ name: "Sean Regular Goalie", is_goalie: 1, role: "roster", status: "out" },
				{ name: "Anthony Sub Goalie", is_goalie: 1, role: "sub", status: "in" },
				{ name: "Brad Skater", is_goalie: 0, role: "roster", status: "in" },
				{ name: "Carl Sub Skater", is_goalie: 0, role: "sub", status: "in" },
				{ name: "Paul Unsure", is_goalie: 0, role: "roster", status: "pending" },
			];

			const sorted = sortTeamBoardRows(sampleRows);
			const names = sorted.map(r => r.name);

			expect(names).toEqual([
				"Anthony Sub Goalie", // 1. The G on top (confirmed sub goalie)
				"Brad Skater",        // 2. Regulars who confirmed
				"Carl Sub Skater",    // 3. Subs that confirmed
				"Paul Unsure",        // 4. Regulars that are unsure
				"Sean Regular Goalie" // 5. Absent (goalie at top of absent)
			]);
		});

		it("computes team parity balance: sum of expected points per team, net diff with roster, and Phase 2 swap suggestion", () => {
			const mockTeams = [
				{
					team: "Red",
					rows: [
						{ player_id: "G1", name: "Goalie Red", is_goalie: 1, pts: 10, status: "in", role: "roster", ppg: 0.2 }, // goalie pts ignored (0)
						{ player_id: "R1", name: "Skater R1", is_goalie: 0, pts: 50, status: "in", role: "roster", ppg: 1.2 },
						{ player_id: "R2", name: "Skater R2", is_goalie: 0, pts: 70, status: "in", role: "roster", ppg: 1.4 },
						{ player_id: "S1", name: "Sub Red", is_goalie: 0, pts: 0, status: "in", role: "sub", ppg: 1.8 }, // strong sub on Red (1.8)
						{ player_id: "R4", name: "Absent R4", is_goalie: 0, pts: 30, status: "out", role: "roster", ppg: 0.8 } // absent roster player (0.8)
					]
				},
				{
					team: "White",
					rows: [
						{ player_id: "G2", name: "Goalie White", is_goalie: 1, pts: 0, status: "in", role: "roster" },
						{ player_id: "W1", name: "Skater W1", is_goalie: 0, pts: 20, status: "in", role: "roster", ppg: 0.6 },
						{ player_id: "W2", name: "Skater W2", is_goalie: 0, pts: 100, status: "in", role: "roster", ppg: 1.0 },
						{ player_id: "S2", name: "Sub White", is_goalie: 0, pts: 0, status: "in", role: "sub", ppg: 0.8 } // weaker sub on White (0.8)
					]
				}
			];

			const bal = computeTeamBalance(mockTeams, "2026-09-20");

			// Red active skaters: R1 (1.2) + R2 (1.4) + S1 (1.8) = 4.4 expected points
			// White active skaters: W1 (0.6) + W2 (1.0) + S2 (0.8) = 2.4 expected points
			// Average = (4.4 + 2.4) / 2 = 3.4 pts
			// Red net_diff vs average = 4.4 - 3.4 = +1.0 pts
			// White net_diff vs average = 2.4 - 3.4 = -1.0 pts
			expect(mockTeams[0].expected_pts).toBe(4.4);
			expect(mockTeams[0].confirmed_skaters).toBe(3);
			expect(mockTeams[0].roster_expected_pts).toBe(3.4);
			expect(mockTeams[0].net_diff).toBe(1.0);

			expect(mockTeams[1].expected_pts).toBe(2.4);
			expect(mockTeams[1].confirmed_skaters).toBe(3);
			expect(mockTeams[1].net_diff).toBe(-1.0);

			// Spread = 4.4 - 2.4 = 2.0 pts
			expect(bal.spread).toBe(2.0);

			// Phase 2: swap suggestion should suggest swapping S1 (Red, 1.8) and S2 (White, 0.8)
			// If swapped: Red = 4.4 - 1.8 + 0.8 = 3.4. White = 2.4 - 0.8 + 1.8 = 3.4. Spread becomes 0.0!
			expect(bal.swapSuggestion).toBeDefined();
			expect(bal.swapSuggestion.sub1.player_id).toBe("S1");
			expect(bal.swapSuggestion.sub2.player_id).toBe("S2");
			expect(bal.swapSuggestion.newSpread).toBe(0);
			expect(bal.swapSuggestion.improvement).toBe(2.0);
		});

		it("enforces single goalie rule: when main goalie Anthony plays on Blue, secondary goalie Tyler plays as skater and points count", () => {
			const blueRows = [
				{ player_id: "P0031", name: "Anthony Saragoca", is_goalie: 1, role: "roster", status: "in", ppg: 0.5 },
				{ player_id: "P0260", name: "Tyler Myrans", is_goalie: 1, role: "roster", status: "in", ppg: 0.9 },
				{ player_id: "P0064", name: "Daniel Vespa", is_goalie: 0, role: "roster", status: "in", ppg: 1.4 },
				{ player_id: "P0101", name: "Greg D'Alesio", is_goalie: 0, role: "roster", status: "out", ppg: 0.8 },
				{ player_id: "P0109", name: "Jack Tessari", is_goalie: 0, role: "roster", status: "in", ppg: 1.1 },
				{ player_id: "P0121", name: "Joe Gallo", is_goalie: 0, role: "roster", status: "in", ppg: 0.8 },
				{ player_id: "P0250", name: "Sylvain Couturier", is_goalie: 0, role: "roster", status: "in", ppg: 1.6 },
				{ player_id: "P0269", name: "Yanick Audet", is_goalie: 0, role: "roster", status: "in", ppg: 1.1 },
				{ player_id: "P0298", name: "Henrik Santana", is_goalie: 0, role: "sub", status: "in", ppg: 1.0 }
			];

			const sorted = sortTeamBoardRows(blueRows, "Blue");
			const names = sorted.map(r => r.name);

			// Anthony Saragoca must be the only G on top!
			expect(names[0]).toBe("Anthony Saragoca");
			expect(sorted[0].is_net_goalie).toBe(true);
			expect(sorted[0].is_goalie).toBe(1);

			// Tyler Myrans must be sorted with the confirmed regular skaters (alphabetical), NOT as a goalie!
			expect(sorted.find(r => r.name === "Tyler Myrans").is_goalie).toBe(0);
			expect(sorted.find(r => r.name === "Tyler Myrans").plays_as_skater).toBe(true);

			// Verify balance calculations
			const mockTeams = [{ team: "Blue", rows: blueRows }];
			computeTeamBalance(mockTeams, "2026-09-20");

			// Active confirmed skaters: Tyler (0.9) + Vespa (1.4) + Tessari (1.1) + Gallo (0.8) + Couturier (1.6) + Audet (1.1) + Henrik (1.0) = 7.9 pts
			expect(mockTeams[0].confirmed_skaters).toBe(7);
			expect(mockTeams[0].expected_pts).toBe(7.9);

			// Regular roster skaters: Tyler (0.9) + Vespa (1.4) + Greg (0.8) + Tessari (1.1) + Gallo (0.8) + Couturier (1.6) + Audet (1.1) = 7.7 pts
			// (Anthony counts as regular goalie = 0 pts)
			expect(mockTeams[0].roster_expected_pts).toBe(7.7);
			expect(mockTeams[0].net_diff).toBe(0);
		});

		it("when main goalie Anthony is absent on Blue, Tyler plays in net as starting goalie and his skater points do not count", () => {
			const blueRows = [
				{ player_id: "P0031", name: "Anthony Saragoca", is_goalie: 1, role: "roster", status: "out", ppg: 0.5 },
				{ player_id: "P0260", name: "Tyler Myrans", is_goalie: 1, role: "roster", status: "in", ppg: 0.9 },
				{ player_id: "P0064", name: "Daniel Vespa", is_goalie: 0, role: "roster", status: "in", ppg: 1.4 },
				{ player_id: "P0109", name: "Jack Tessari", is_goalie: 0, role: "roster", status: "in", ppg: 1.1 }
			];

			const sorted = sortTeamBoardRows(blueRows, "Blue");
			const names = sorted.map(r => r.name);

			// Tyler Myrans is starting in net
			expect(names[0]).toBe("Tyler Myrans");
			expect(sorted[0].is_net_goalie).toBe(true);
			expect(sorted[0].is_goalie).toBe(1);

			// Anthony Saragoca is absent (at bottom)
			expect(names[names.length - 1]).toBe("Anthony Saragoca");

			// Balance calculation
			const mockTeams = [{ team: "Blue", rows: blueRows }];
			computeTeamBalance(mockTeams, "2026-09-20");

			// Only Vespa (1.4) + Tessari (1.1) are confirmed active skaters = 2.5 pts (Tyler in net = 0)
			expect(mockTeams[0].confirmed_skaters).toBe(2);
			expect(mockTeams[0].expected_pts).toBe(2.5);
		});
	});

	describe("Player Polling & F/D Position Data Enrichment", () => {
		it("updates skater position via POST /api/player-position with team HMAC token", async () => {
			const salt = "teamsalt_red_123";
			env.RSVP_SECRET = 'test-secret-12345';
			await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('teamsalt:Fall 2026:Red', ?)`).bind(salt).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, position) VALUES ('P9999', 'Test Skater', 'test@smbhl.com', 'roster', NULL)`).run();

			const encoder = new TextEncoder();
			const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`t:Fall 2026:Red:${salt}`));
			const tok = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

			// 1. Set to 'D'
			const res = await worker.fetch(new Request("http://example.com/api/player-position", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					player_id: "P9999",
					position: "D",
					season: "Fall 2026",
					team: "Red",
					token: tok
				})
			}), env);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.ok).toBe(true);
			expect(data.position).toBe("D");

			const contact = await env.DB.prepare("SELECT position FROM contacts WHERE player_id = 'P9999'").first();
			expect(contact.position).toBe("D");

			// 2. Reject unauthorized request without valid token
			const badRes = await worker.fetch(new Request("http://example.com/api/player-position", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					player_id: "P9999",
					position: "F",
					season: "Fall 2026",
					team: "Red",
					token: "wrong-token"
				})
			}), env);
			expect(badRes.status).toBe(403);
		});

		it("renders F/D toggles on /team-rsvp and self position picker on /rsvp", async () => {
			const season = "Season-Poll-Test";
			const evId = "ev-poll-pos-1";
			const salt = "teamsalt_red_123";
			env.RSVP_SECRET = 'test-secret-12345';
			await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).bind(`teamsalt:${season}:Red`, salt).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_goalie, token_salt, position) VALUES ('P9999', 'Test Skater', 'test@smbhl.com', 'roster', 0, 'salt999', 'D')`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date, venue, state) VALUES (?, ?, 1, 'Sunday September 20', 'College Jean-de-Brebeuf', 'open')`).bind(evId, season).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES (?, 'P9999', 'Red', 'in', 'roster', 'self', '2026-09-18')`).bind(evId).run();

			const encoder = new TextEncoder();
			const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			const teamSig = await crypto.subtle.sign("HMAC", key, encoder.encode(`t:${season}:Red:${salt}`));
			const teamTok = [...new Uint8Array(teamSig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

			// Team page has pos-toggle but NOT the poll card
			const teamRes = await worker.fetch(new Request(`http://example.com/team-rsvp?s=${encodeURIComponent(season)}&team=Red&t=${teamTok}`), env);
			expect(teamRes.status).toBe(200);
			const teamHtml = await teamRes.text();
			expect(teamHtml).toContain('class="pos-toggle"');
			expect(teamHtml).toContain('data-pid="P9999"');
			expect(teamHtml).toContain('data-pos="D"');
			expect(teamHtml).not.toContain('id="poll-card"');
			expect(teamHtml).not.toContain('poll-vote-btn');

			// RSVP page has self-pos-picker but NOT the poll card
			const pSig = await crypto.subtle.sign("HMAC", key, encoder.encode(`p:${evId}:P9999:salt999`));
			const pTok = [...new Uint8Array(pSig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

			const rsvpRes = await worker.fetch(new Request(`http://example.com/rsvp?e=${evId}&p=P9999&t=${pTok}`), env);
			expect(rsvpRes.status).toBe(200);
			const rsvpHtml = await rsvpRes.text();
			expect(rsvpHtml).toContain('id="self-pos-picker"');
			expect(rsvpHtml).toContain('Défenseur / Defenseman (D)');
			expect(rsvpHtml).not.toContain('id="poll-card"');
			expect(rsvpHtml).not.toContain('poll-vote-btn');
		});

		it("renders standalone /poll page and records vote with poll HMAC token", async () => {
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, position, is_goalie) VALUES ('D010', 'Arber Xhekaj', 'D', 0)`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, token_salt) VALUES ('V002', 'Martin St-Louis', 'martin@smbhl.com', 'salt_marty')`).run();

			const pollRes = await env.DB.prepare(`
				INSERT INTO polls (season, title, description, category, target_position, state, created_at, show_results)
				VALUES ('Fall 2026', 'Trophée Norris', 'Meilleur défenseur', 'norris', 'D', 'open', '2026-09-18', 1)
			`).run();
			const pollId = pollRes.meta.last_row_id;

			env.RSVP_SECRET = 'test-secret-12345';
			const encoder = new TextEncoder();
			const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			const pollSig = await crypto.subtle.sign("HMAC", key, encoder.encode(`poll:${pollId}:V002:salt_marty`));
			const pollTok = [...new Uint8Array(pollSig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

			// 1. GET /poll without valid token fails
			const badRes = await worker.fetch(new Request(`http://example.com/poll?id=${pollId}&p=V002&t=invalid`), env);
			expect(badRes.status).toBe(200);
			const badHtml = await badRes.text();
			expect(badHtml).toContain('Lien invalide ou expiré');

			// 2. GET /poll with valid token renders voting page
			const goodRes = await worker.fetch(new Request(`http://example.com/poll?id=${pollId}&p=V002&t=${pollTok}`), env);
			expect(goodRes.status).toBe(200);
			const goodHtml = await goodRes.text();
			expect(goodHtml).toContain('Sondage · Trophée Norris');
			expect(goodHtml).toContain('Martin St-Louis');
			expect(goodHtml).toContain('Arber Xhekaj');
			expect(goodHtml).toContain('SOUMETTRE MON VOTE 🗳️');

			// 3. POST /api/poll/vote with poll token
			const voteRes = await worker.fetch(new Request("http://example.com/api/poll/vote", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					poll_id: pollId,
					voter_id: "V002",
					candidate_id: "D010",
					candidate_name: "Arber Xhekaj",
					token: pollTok
				})
			}), env);
			expect(voteRes.status).toBe(200);
			const voteData = await voteRes.json();
			expect(voteData.ok).toBe(true);
			expect(voteData.results.totalVotes).toBe(1);
			expect(voteData.results.votes[0].candidate_name).toBe("Arber Xhekaj");

			// 4. GET /poll after voting shows recorded vote and live results bar
			const afterRes = await worker.fetch(new Request(`http://example.com/poll?id=${pollId}&p=V002&t=${pollTok}`), env);
			expect(afterRes.status).toBe(200);
			const afterHtml = await afterRes.text();
			expect(afterHtml).toContain('Ton vote enregistré : <b>Arber Xhekaj</b>');
			expect(afterHtml).toContain('Résultats en direct (1 vote)');
			expect(afterHtml).toContain('MODIFIER MON VOTE ✎');
		});

		it("manages polls, filters candidates by target_position, and records votes", async () => {
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, position, is_goalie) VALUES ('D001', 'David Savard', 'D', 0)`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, position, is_goalie) VALUES ('F001', 'Cole Caufield', 'F', 0)`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, token_salt) VALUES ('V001', 'Voter Guy', 'salt_v1')`).run();

			// Create Norris poll with target_position = 'D'
			const pollRes = await env.DB.prepare(`
				INSERT INTO polls (season, title, description, category, target_position, state, created_at, show_results)
				VALUES ('Fall 2026', 'Trophée Norris', 'Meilleur défenseur', 'norris', 'D', 'open', '2026-09-18', 1)
			`).run();
			const pollId = pollRes.meta.last_row_id;

			// Check candidate filtering
			const poll = await env.DB.prepare("SELECT * FROM polls WHERE id = ?").bind(pollId).first();
			const candidates = await env.DB.prepare("SELECT player_id, name FROM contacts WHERE position = ? AND (is_goalie = 0 OR is_goalie IS NULL)").bind(poll.target_position).all();
			const candNames = (candidates.results || []).map(c => c.name);
			expect(candNames).toContain("David Savard");
			expect(candNames).not.toContain("Cole Caufield");

			// Cast vote via team token
			env.RSVP_SECRET = 'test-secret-12345';
			const salt = "teamsalt_red_123";
			await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('salt:team:Fall 2026:Red', ?)`).bind(salt).run();
			const encoder = new TextEncoder();
			const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`t:Fall 2026:Red:${salt}`));
			const tok = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

			const voteRes = await worker.fetch(new Request("http://example.com/api/poll/vote", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					poll_id: pollId,
					voter_id: "V001",
					candidate_id: "D001",
					candidate_name: "David Savard",
					season: "Fall 2026",
					team: "Red",
					token: tok
				})
			}), env);
			expect(voteRes.status).toBe(200);
			const voteData = await voteRes.json();
			expect(voteData.ok).toBe(true);
			expect(voteData.results.totalVotes).toBe(1);
			expect(voteData.results.votes[0].candidate_name).toBe("David Savard");
			expect(voteData.results.votes[0].pct).toBe(100);

			// Update vote (upsert check)
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, position, is_goalie) VALUES ('D002', 'Mike Matheson', 'D', 0)`).run();
			const updateVoteRes = await worker.fetch(new Request("http://example.com/api/poll/vote", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					poll_id: pollId,
					voter_id: "V001",
					candidate_id: "D002",
					candidate_name: "Mike Matheson",
					season: "Fall 2026",
					team: "Red",
					token: tok
				})
			}), env);
			expect(updateVoteRes.status).toBe(200);
			const updatedData = await updateVoteRes.json();
			expect(updatedData.results.totalVotes).toBe(1); // Still 1 vote, updated!
			expect(updatedData.results.votes[0].candidate_name).toBe("Mike Matheson");
		});

		it("renders /admin/polls, supports creating, closing, and launching polls via email", async () => {
			env.ADMIN_KEY = "test-adminkey-123";
			env.RESEND_API_KEY = "test-resend-key";

			// Mock fetch for sendMail
			const originalFetch = globalThis.fetch;
			let sentEmails = [];
			globalThis.fetch = async (url, opts) => {
				if (String(url).includes('api.resend.com/emails')) {
					const body = JSON.parse(opts.body);
					sentEmails.push(body);
					return new Response(JSON.stringify({ id: 'resend-123' }), { status: 200 });
				}
				return originalFetch(url, opts);
			};

			try {
				// Seed roster contacts and sub contacts
				await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('R001', 'Nick Suzuki', 'nick@smbhl.com', 'roster', 'salt_nick')`).run();
				await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('R002', 'Juraj Slafkovsky', 'juraj@smbhl.com', 'roster', 'salt_juraj')`).run();
				await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('S001', 'Sub Player', 'sub@smbhl.com', 'sub', 'salt_sub')`).run();
				await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date, venue, state) VALUES ('ev-poll-1', 'Fall 2026', 1, 'Sunday Sept 20', 'Gym', 'open')`).run();
				await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role) VALUES ('ev-poll-1', 'S001', 'Red', 'in', 'sub')`).run();

				// GET /admin/polls
				const pageRes = await worker.fetch(new Request("http://example.com/admin/polls"), env);
				expect(pageRes.status).toBe(200);
				const html = await pageRes.text();
				expect(html).toContain("Sondages & Trophées");
				expect(html).toContain("Sondages 🗳️");

				// POST /admin/polls/create
				const createRes = await worker.fetch(new Request("http://example.com/admin/polls/create", {
					method: "POST",
					headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
					body: JSON.stringify({
						season: "Fall 2026",
						title: "Trophée Hart",
						description: "Joueur par excellence",
						category: "mvp",
						target_position: null,
						allow_subs: 1
					})
				}), env);
				expect(createRes.status).toBe(200);
				const created = await createRes.json();
				expect(created.ok).toBe(true);
				expect(created.id).toBeDefined();

				// GET /admin/polls/data includes recipient counts
				const dataRes = await worker.fetch(new Request("http://example.com/admin/polls/data", {
					headers: { "x-admin": "test-adminkey-123" }
				}), env);
				expect(dataRes.status).toBe(200);
				const d = await dataRes.json();
				expect(d.ok).toBe(true);
				const createdPoll = d.polls.find(p => p.id === created.id);
				expect(createdPoll).toBeDefined();
				expect(createdPoll.recipients).toBeDefined();
				expect(createdPoll.recipients.total).toBeGreaterThanOrEqual(2);

				// POST /admin/polls/send (test_only: true)
				sentEmails = [];
				const testSendRes = await worker.fetch(new Request("http://example.com/admin/polls/send", {
					method: "POST",
					headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
					body: JSON.stringify({
						poll_id: created.id,
						test_only: true
					})
				}), env);
				expect(testSendRes.status).toBe(200);
				const testData = await testSendRes.json();
				expect(testData.ok).toBe(true);
				expect(testData.test).toBe(true);
				expect(sentEmails.length).toBe(1);
				expect(sentEmails[0].subject).toContain("[TEST] Vote SMBHL : Trophée Hart");

				// POST /admin/polls/send (live send to all eligible voters)
				sentEmails = [];
				const liveSendRes = await worker.fetch(new Request("http://example.com/admin/polls/send", {
					method: "POST",
					headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
					body: JSON.stringify({
						poll_id: created.id,
						test_only: false
					})
				}), env);
				expect(liveSendRes.status).toBe(200);
				const liveData = await liveSendRes.json();
				expect(liveData.ok).toBe(true);
				expect(liveData.sent_count).toBeGreaterThanOrEqual(3); // R001, R002, S001
				expect(sentEmails.some(m => m.to.includes('nick@smbhl.com'))).toBe(true);
				expect(sentEmails.some(m => m.to.includes('sub@smbhl.com'))).toBe(true);
				expect(sentEmails[0].html).toContain('/poll?id=' + created.id);

				// Verify DB updated with last_sent_at
				const updatedPoll = await env.DB.prepare("SELECT last_sent_at, sent_count FROM polls WHERE id = ?").bind(created.id).first();
				expect(updatedPoll.last_sent_at).not.toBeNull();
				expect(updatedPoll.sent_count).toBeGreaterThanOrEqual(3);

				// POST /admin/polls/close
				const closeRes = await worker.fetch(new Request("http://example.com/admin/polls/close", {
					method: "POST",
					headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
					body: JSON.stringify({
						id: created.id,
						state: "closed"
					})
				}), env);
				expect(closeRes.status).toBe(200);
				const closed = await closeRes.json();
				expect(closed.state).toBe("closed");
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("supports show_on_rsvp toggle and renders live poll card strictly on personalized /rsvp pages", async () => {
			env.ADMIN_KEY = "test-adminkey-123";

			// 1. Seed regular player and sub
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt, position) VALUES ('REG1', 'Martin Brodeur', 'mb@smbhl.com', 'roster', 0, 'salt_reg1', 'D')`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt, position) VALUES ('REG2', 'Scott Stevens', 'ss@smbhl.com', 'roster', 0, 'salt_reg2', 'D')`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt, position) VALUES ('SUB1', 'Sub Voter', 'sv@smbhl.com', 'sub', 1, 'salt_sub1', 'F')`).run();

			// Seed open event
			await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date, venue, state) VALUES ('ev-rsvp-poll', 'Fall 2026', 2, 'Sunday Sept 27', 'Arena', 'open')`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role) VALUES ('ev-rsvp-poll', 'REG1', 'Red', 'in', 'roster')`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role) VALUES ('ev-rsvp-poll', 'SUB1', 'Red', 'in', 'sub')`).run();

			// Generate HMAC tokens
			const encoder = new TextEncoder();
			const key = await crypto.subtle.importKey("raw", encoder.encode(env.RSVP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
			
			const sig1 = await crypto.subtle.sign("HMAC", key, encoder.encode("p:ev-rsvp-poll:REG1:salt_reg1"));
			const tok1 = [...new Uint8Array(sig1)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

			const sigSub = await crypto.subtle.sign("HMAC", key, encoder.encode("p:ev-rsvp-poll:SUB1:salt_sub1"));
			const tokSub = [...new Uint8Array(sigSub)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

			const saltRed = "salt_team_red";
			await env.DB.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('teamsalt:Fall 2026:Red', '${saltRed}')`).run();
			const sigTeam = await crypto.subtle.sign("HMAC", key, encoder.encode(`Fall 2026:Red:${saltRed}`));
			const tokTeam = [...new Uint8Array(sigTeam)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

			// 2. Create poll with show_on_rsvp = 0 initially
			const createRes = await worker.fetch(new Request("http://example.com/admin/polls/create", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({
					season: "Fall 2026",
					title: "Trophée Norris 2026",
					description: "Vote pour le meilleur défenseur",
					category: "norris",
					target_position: "D",
					allow_subs: 0,
					show_on_rsvp: 0
				})
			}), env);
			const poll = await createRes.json();
			expect(poll.ok).toBe(true);

			// Check /rsvp when show_on_rsvp = 0 -> poll NOT present
			const rsvpRes1 = await worker.fetch(new Request(`http://example.com/rsvp?e=ev-rsvp-poll&p=REG1&t=${tok1}`), env);
			expect(rsvpRes1.status).toBe(200);
			const html1 = await rsvpRes1.text();
			expect(html1).not.toContain("Trophée Norris 2026");
			expect(html1).not.toContain("VOTE EN DIRECT");

			// 3. Toggle show_on_rsvp to 1 via /admin/polls/toggle-rsvp
			const toggleRes = await worker.fetch(new Request("http://example.com/admin/polls/toggle-rsvp", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({
					id: poll.id,
					show_on_rsvp: 1
				})
			}), env);
			expect(toggleRes.status).toBe(200);
			const toggleData = await toggleRes.json();
			expect(toggleData.show_on_rsvp).toBe(1);

			// Verify DB updated
			const row = await env.DB.prepare("SELECT show_on_rsvp FROM polls WHERE id = ?").bind(poll.id).first();
			expect(row.show_on_rsvp).toBe(1);

			// 4. Check /rsvp when show_on_rsvp = 1 (and show_results = 0 by default -> private ballot)
			const rsvpRes2 = await worker.fetch(new Request(`http://example.com/rsvp?e=ev-rsvp-poll&p=REG1&t=${tok1}`), env);
			expect(rsvpRes2.status).toBe(200);
			const html2 = await rsvpRes2.text();
			expect(html2).toContain("Trophée Norris 2026");
			expect(html2).toContain("SCRUTIN SECRET");
			expect(html2).toContain("Scott Stevens");
			expect(html2).toContain("SOUMETTRE MON VOTE");

			// 5. Shared team page (/team-rsvp) NEVER renders poll card
			const teamRes = await worker.fetch(new Request(`http://example.com/team-rsvp?s=Fall%202026&team=Red&t=${tokTeam}`), env);
			expect(teamRes.status).toBe(200);
			const teamHtml = await teamRes.text();
			expect(teamHtml).not.toContain("Trophée Norris 2026");
			expect(teamHtml).not.toContain("SCRUTIN SECRET");

			// 6. Sub player on /rsvp should NOT see the poll because allow_subs = 0
			const subRsvpRes = await worker.fetch(new Request(`http://example.com/rsvp?e=ev-rsvp-poll&p=SUB1&t=${tokSub}`), env);
			expect(subRsvpRes.status).toBe(200);
			const subHtml = await subRsvpRes.text();
			expect(subHtml).not.toContain("Trophée Norris 2026");

			// Sub attempting to vote directly via API on allow_subs = 0 poll gets 403
			const subVoteRes = await worker.fetch(new Request("http://example.com/api/poll/vote", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					poll_id: poll.id,
					voter_id: "SUB1",
					candidate_id: "REG2",
					candidate_name: "Scott Stevens",
					event_id: "ev-rsvp-poll",
					token: tokSub
				})
			}), env);
			expect(subVoteRes.status).toBe(403);

			// 7. Regular player votes via /api/poll/vote with their personalized RSVP token
			const voteRes = await worker.fetch(new Request("http://example.com/api/poll/vote", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					poll_id: poll.id,
					voter_id: "REG1",
					candidate_id: "REG2",
					candidate_name: "Scott Stevens",
					event_id: "ev-rsvp-poll",
					token: tok1
				})
			}), env);
			expect(voteRes.status).toBe(200);
			const voteData = await voteRes.json();
			expect(voteData.ok).toBe(true);
			expect(voteData.candidate_name).toBe("Scott Stevens");
			// In private voting mode, results are not leaked in the JSON response
			expect(voteData.results).toBeNull();

			// 8. Re-visiting /rsvp as REG1: vote recorded, but tallies remain PRIVATE
			const rsvpRes3 = await worker.fetch(new Request(`http://example.com/rsvp?e=ev-rsvp-poll&p=REG1&t=${tok1}`), env);
			expect(rsvpRes3.status).toBe(200);
			const html3 = await rsvpRes3.text();
			expect(html3).toContain("Ton vote enregistré : <b>Scott Stevens</b>");
			expect(html3).toContain("Scrutin secret");
			expect(html3).not.toContain("Résultats en direct");
			expect(html3).toContain("MODIFIER MON VOTE");

			// 9. Admin specifies public results via POST /admin/polls/toggle-results
			const toggleResultsRes = await worker.fetch(new Request("http://example.com/admin/polls/toggle-results", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({
					id: poll.id,
					show_results: 1
				})
			}), env);
			expect(toggleResultsRes.status).toBe(200);
			const toggleResultsData = await toggleResultsRes.json();
			expect(toggleResultsData.show_results).toBe(1);

			// With show_results = 1, live results are now visible on /rsvp
			const rsvpResPub = await worker.fetch(new Request(`http://example.com/rsvp?e=ev-rsvp-poll&p=REG1&t=${tok1}`), env);
			const htmlPub = await rsvpResPub.text();
			expect(htmlPub).toContain("Résultats en direct");
			expect(htmlPub).toContain("VOTE EN DIRECT");

			// 10. Toggle show_on_rsvp back to 0
			await worker.fetch(new Request("http://example.com/admin/polls/toggle-rsvp", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({
					id: poll.id,
					show_on_rsvp: 0
				})
			}), env);
			const rsvpRes4 = await worker.fetch(new Request(`http://example.com/rsvp?e=ev-rsvp-poll&p=REG1&t=${tok1}`), env);
			expect(rsvpRes4.status).toBe(200);
			const html4 = await rsvpRes4.text();
			expect(html4).not.toContain("Trophée Norris 2026");
		});
	});

	describe("Admin Schedule Management (/admin/schedule)", () => {
		beforeAll(async () => {
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season TEXT, week INT, date TEXT, venue TEXT, state TEXT, start_time TEXT, end_time TEXT)`).run();
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rsvp (event_id TEXT, player_id TEXT, team TEXT, status TEXT, role TEXT, status_by TEXT, updated_at TEXT, guest_name TEXT, PRIMARY KEY(event_id, player_id))`).run();
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, event_id TEXT, player_id TEXT, team TEXT, send_after TEXT, sent_at TEXT, cancelled INT, error TEXT)`).run();
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS jobs (event_id TEXT, job TEXT, ran_at TEXT, PRIMARY KEY(event_id, job))`).run();
		});

		it("renders /admin/schedule page with navigation tabs and controls", async () => {
			const res = await worker.fetch(new Request("http://example.com/admin/schedule"), env);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Gestion du calendrier");
			expect(html).toContain('href="/admin/schedule"');
			expect(html).toContain("Ajouter un match");
			expect(html).toContain("Matchs prévus au calendrier officiel");
		});

		it("rejects unauthorized access to /admin/schedule endpoints", async () => {
			const dResp = await worker.fetch(new Request("http://example.com/admin/schedule/data"), env);
			expect(dResp.status).toBe(403);

			const sResp = await worker.fetch(new Request("http://example.com/admin/schedule/save", { method: "POST" }), env);
			expect(sResp.status).toBe(403);

			const stResp = await worker.fetch(new Request("http://example.com/admin/schedule/set-state", { method: "POST" }), env);
			expect(stResp.status).toBe(403);

			const delResp = await worker.fetch(new Request("http://example.com/admin/schedule/delete", { method: "POST" }), env);
			expect(delResp.status).toBe(403);

			const impResp = await worker.fetch(new Request("http://example.com/admin/schedule/import-fixture", { method: "POST" }), env);
			expect(impResp.status).toBe(403);
		});

		it("supports creating, listing, modifying, and rescheduling games via /admin/schedule/save and /admin/schedule/data", async () => {
			env.ADMIN_KEY = "test-adminkey-123";

			// 1. Create a new custom game
			const createRes = await worker.fetch(new Request("http://example.com/admin/schedule/save", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({
					id: "2026-11-22",
					season: "Fall 2026",
					week: 8,
					date: "Sunday Nov 22",
					start_time: "18:00",
					end_time: "21:00",
					venue: "Collège Jean-de-Brébeuf",
					state: "open",
					is_new: true
				})
			}), env);
			expect(createRes.status).toBe(200);
			const createData = await createRes.json();
			expect(createData.ok).toBe(true);
			expect(createData.id).toBe("2026-11-22");

			// 2. Fetch schedule data to confirm it's in the list
			const dataRes = await worker.fetch(new Request("http://example.com/admin/schedule/data", {
				headers: { "x-admin": "test-adminkey-123" }
			}), env);
			expect(dataRes.status).toBe(200);
			const data = await dataRes.json();
			expect(data.ok).toBe(true);
			const ev = data.events.find(e => e.id === "2026-11-22");
			expect(ev).toBeDefined();
			expect(ev.week).toBe(8);
			expect(ev.state).toBe("open");
			expect(ev.venue).toBe("Collège Jean-de-Brébeuf");

			// 3. Move / reschedule game (change week to 9, date to Nov 29, venue to Maisonneuve)
			const updateRes = await worker.fetch(new Request("http://example.com/admin/schedule/save", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({
					id: "2026-11-29",
					old_id: "2026-11-22",
					season: "Fall 2026",
					week: 9,
					date: "Sunday Nov 29",
					start_time: "19:00",
					end_time: "22:00",
					venue: "Collège de Maisonneuve",
					state: "open",
					is_new: false
				})
			}), env);
			expect(updateRes.status).toBe(200);

			// Verify updated in DB
			const row = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind("2026-11-29").first();
			expect(row).toBeDefined();
			expect(row.week).toBe(9);
			expect(row.date).toBe("Sunday Nov 29");
			expect(row.venue).toBe("Collège de Maisonneuve");
			expect(row.start_time).toBe("19:00");
		});

		it("cancelling a game cancels pending outbox emails and shows cancellation banner on /rsvp", async () => {
			env.ADMIN_KEY = "test-adminkey-123";
			env.RSVP_SECRET = "secret-rsvp-key";

			const evId = "2026-12-06";
			await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES (?, 'Fall 2026', 10, 'Sunday Dec 6', 'Arena', 'open', '18:00')").bind(evId).run();

			// Add contact and RSVP
			await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('P_CANCEL', 'Carey Price', 'carey@smbhl.com', 'roster', 'salt_price')").run();
			await env.DB.prepare("INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role) VALUES (?, 'P_CANCEL', 'Red', 'in', 'roster')").bind(evId).run();

			// Queue a reminder in outbox for this event
			await env.DB.prepare("INSERT INTO outbox (kind, event_id, player_id, team, send_after, cancelled) VALUES ('reminder', ?, 'P_CANCEL', 'Red', '2026-12-05T12:00:00Z', 0)").bind(evId).run();

			// Confirm outbox entry is active (cancelled = 0)
			let outboxItem = await env.DB.prepare("SELECT * FROM outbox WHERE event_id = ? AND player_id = 'P_CANCEL'").bind(evId).first();
			expect(outboxItem.cancelled).toBe(0);

			// 1. Cancel the game via /admin/schedule/set-state
			const cancelRes = await worker.fetch(new Request("http://example.com/admin/schedule/set-state", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({ id: evId, state: "cancelled" })
			}), env);
			expect(cancelRes.status).toBe(200);
			const cancelData = await cancelRes.json();
			expect(cancelData.state).toBe("cancelled");
			expect(cancelData.cancelled_outbox).toBeGreaterThanOrEqual(1);

			// Confirm outbox entry was automatically cancelled
			outboxItem = await env.DB.prepare("SELECT * FROM outbox WHERE event_id = ? AND player_id = 'P_CANCEL'").bind(evId).first();
			expect(outboxItem.cancelled).toBe(1);

			// 2. Check /rsvp for Carey Price on this cancelled game
			const enc = new TextEncoder();
			const key = await crypto.subtle.importKey(
				"raw",
				enc.encode(env.RSVP_SECRET),
				{ name: "HMAC", hash: "SHA-256" },
				false,
				["sign"]
			);
			const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`p:${evId}:P_CANCEL:salt_price`));
			const tok = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);

			const rsvpRes = await worker.fetch(new Request(`http://example.com/rsvp?e=${evId}&p=P_CANCEL&t=${tok}`), env);
			expect(rsvpRes.status).toBe(200);
			const html = await rsvpRes.text();
			expect(html).toContain("Ce match a été annulé");
			expect(html).toContain("This game has been cancelled");
			expect(html).toContain('disabled');

			// 3. Re-open the game via /admin/schedule/set-state
			const reopenRes = await worker.fetch(new Request("http://example.com/admin/schedule/set-state", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({ id: evId, state: "open" })
			}), env);
			expect(reopenRes.status).toBe(200);
			const evRow = await env.DB.prepare("SELECT state FROM events WHERE id = ?").bind(evId).first();
			expect(evRow.state).toBe("open");

			// 4. Delete the game via /admin/schedule/delete
			const delRes = await worker.fetch(new Request("http://example.com/admin/schedule/delete", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({ id: evId })
			}), env);
			expect(delRes.status).toBe(200);
			const deletedEv = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(evId).first();
			expect(deletedEv).toBeNull();
		});

		it("correctly identifies is_past flag for planned fixtures and supports sending cancellation emails", async () => {
			env.ADMIN_KEY = "test-adminkey-123";
			env.ADMIN_EMAIL = "admin@smbhl.com";
			env.RESEND_API_KEY = "test-resend-key";

			const origFetch = globalThis.fetch;
			globalThis.fetch = async (url, opts) => {
				if (String(url).includes('api.resend.com/emails')) {
					return new Response(JSON.stringify({ id: 'resend-cancel-123' }), { status: 200 });
				}
				return origFetch(url, opts);
			};

			try {
				// 1. Verify planned fixtures return is_past
				const dataRes = await worker.fetch(new Request("http://example.com/admin/schedule/data", {
					headers: { "x-admin": "test-adminkey-123" }
				}), env);
				expect(dataRes.status).toBe(200);
				const data = await dataRes.json();
				expect(data.ok).toBe(true);
				expect(Array.isArray(data.planned)).toBe(true);
				if (data.planned.length > 0) {
					const fixture = data.planned[0];
					expect(typeof fixture.is_past).toBe("boolean");
				}

				// 2. Setup a cancelled event with players to test cancellation email
				const cancelEvId = "test-cancelled-game-2026";
				await env.DB.prepare(
					`INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time, end_time)
					 VALUES (?, 'Fall 2026', 10, 'Sunday Oct 25, 2026', 'Maisonneuve', 'cancelled', '18:00', '21:00')`
				).bind(cancelEvId).run();

				// Add a contact with email
				await env.DB.prepare(
					`INSERT OR REPLACE INTO contacts (player_id, name, email, role, preferred_team, token_salt)
					 VALUES ('P9901', 'Test Player Cancel', 'player-cancel@example.com', 'roster', 'Red', 'salt9901')`
				).bind().run();

				await env.DB.prepare(
					`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at)
					 VALUES (?, 'P9901', 'Red', 'in', 'roster', 'self', datetime('now'))`
				).bind(cancelEvId).run();

				// Add a pending outbox entry to ensure it gets cancelled
				await env.DB.prepare(
					`INSERT INTO outbox (kind, event_id, player_id, team, send_after, cancelled)
					 VALUES ('invite', ?, 'P9901', 'Red', datetime('now', '+1 hour'), 0)`
				).bind(cancelEvId).run();

				// Test send-cancellation validation
				const noIdRes = await worker.fetch(new Request("http://example.com/admin/schedule/send-cancellation", {
					method: "POST",
					headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
					body: JSON.stringify({})
				}), env);
				expect(noIdRes.status).toBe(400);

				// Test test_only mode
				const testRes = await worker.fetch(new Request("http://example.com/admin/schedule/send-cancellation", {
					method: "POST",
					headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
					body: JSON.stringify({ event_id: cancelEvId, test_only: true })
				}), env);
				expect(testRes.status).toBe(200);
				const testBody = await testRes.json();
				expect(testBody.ok).toBe(true);
				expect(testBody.test).toBe(true);
				expect(testBody.sent_to).toBe("admin@smbhl.com");
				expect(testBody.total_recipients).toBeGreaterThanOrEqual(1);

				// Test live blast mode
				const blastRes = await worker.fetch(new Request("http://example.com/admin/schedule/send-cancellation", {
					method: "POST",
					headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
					body: JSON.stringify({ event_id: cancelEvId, test_only: false })
				}), env);
				expect(blastRes.status).toBe(200);
				const blastBody = await blastRes.json();
				expect(blastBody.ok).toBe(true);
				expect(blastBody.sent_count).toBeGreaterThanOrEqual(1);

				// Verify outbox entries were marked cancelled = 1
				const outRow = await env.DB.prepare("SELECT cancelled FROM outbox WHERE event_id = ?").bind(cancelEvId).first();
				expect(outRow.cancelled).toBe(1);
			} finally {
				globalThis.fetch = origFetch;
			}
		});
	});

	describe("Admin Team Rosters Management (/admin/teams)", () => {
		beforeAll(async () => {
			env.ADMIN_KEY = "test-adminkey-123";
		});

		it("renders /admin/teams page shell with navigation tabs and empty, JS-populated team containers (no hardcoded Red/Blue/White/Black left in server-rendered markup)", async () => {
			// The team-card grid and the Move/Add-Player team dropdowns are all populated
			// client-side from /admin/teams/data's season-config-driven team list (see the
			// "Move and Add Player team dropdowns" test below), so the server-rendered shell
			// should contain the empty containers/selects, not literal legacy team names.
			const res = await worker.fetch(new Request("http://example.com/admin/teams"), env);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Alignements & Équipes");
			expect(html).toContain('href="/admin/teams"');
			expect(html).toContain('<div class="teams-grid" id="teams-grid"></div>');
			expect(html).toMatch(/<select id="move-target-team" class="form-control" required><\/select>/);
			expect(html).toMatch(/<select id="add-target-team" class="form-control" required><\/select>/);
			expect(html).toContain("Pool de substituts");
			expect(html).not.toContain('option value="Red"');
			expect(html).not.toContain('option value="Black"');
		});

		it("Move and Add Player team dropdowns are populated from the season's own team list (populateTeamDropdowns), not hardcoded Red/Blue/White/Black", async () => {
			const res = await worker.fetch(new Request("http://example.com/admin/teams"), env);
			const html = await res.text();

			// Extract the real shipped function source (balanced-brace) so this test exercises
			// the actual client-side logic rather than a reimplementation of it.
			function extractFn(src, name) {
				const start = src.indexOf('function ' + name);
				expect(start).toBeGreaterThan(-1);
				let i = src.indexOf('{', start);
				let depth = 0;
				for (; i < src.length; i++) {
					if (src[i] === '{') depth++;
					else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
				}
				return src.slice(start, i);
			}

			const fallbackConstMatch = html.match(/const FALLBACK_TEAM_EMOJI = \[[^\]]*\];/);
			expect(fallbackConstMatch).not.toBeNull();
			const teamEmojiSrc = extractFn(html, 'teamEmojiFor');
			const populateSrc = extractFn(html, 'populateTeamDropdowns');

			const fakeSelects = { 'add-target-team': { innerHTML: '' }, 'move-target-team': { innerHTML: '' } };
			const $ = id => fakeSelects[id] || null;
			const esc = s => String(s);
			const t = key => ({ optSubPool: 'Sub Pool', optDropout: 'Drop-out' })[key] || key;

			const populateTeamDropdowns = new Function('$', 'esc', 't', `
				${fallbackConstMatch[0]}
				${teamEmojiSrc}
				${populateSrc}
				return populateTeamDropdowns;
			`)($, esc, t);

			// 4-team season (Fall 2026 default config)
			populateTeamDropdowns(['Red', 'Blue', 'White', 'Black']);
			['Red', 'Blue', 'White', 'Black'].forEach(name => {
				expect(fakeSelects['add-target-team'].innerHTML).toContain('value="' + name + '"');
				expect(fakeSelects['move-target-team'].innerHTML).toContain('value="' + name + '"');
			});
			expect((fakeSelects['add-target-team'].innerHTML.match(/<option/g) || []).length).toBe(4);
			expect(fakeSelects['move-target-team'].innerHTML).toContain('value="sub"');
			expect(fakeSelects['move-target-team'].innerHTML).toContain('value="none"');
			expect((fakeSelects['move-target-team'].innerHTML.match(/<option/g) || []).length).toBe(6);

			// 6-team TestLeague2026-shaped config
			const sixTeams = ['Hawks', 'Wolves', 'Bears', 'Lions', 'Eagles', 'Sharks'];
			populateTeamDropdowns(sixTeams);
			sixTeams.forEach(name => {
				expect(fakeSelects['add-target-team'].innerHTML).toContain('value="' + name + '"');
				expect(fakeSelects['move-target-team'].innerHTML).toContain('value="' + name + '"');
			});
			expect((fakeSelects['add-target-team'].innerHTML.match(/<option/g) || []).length).toBe(6);
			expect((fakeSelects['move-target-team'].innerHTML.match(/<option/g) || []).length).toBe(8);
			expect(fakeSelects['add-target-team'].innerHTML).not.toContain('value="Red"');
			expect(fakeSelects['move-target-team'].innerHTML).not.toContain('value="Red"');
		});

		it("/admin/teams/data does not crash when data.json's seasons array has a null hole (sparse array from delete arr[i])", async () => {
			// Reproduces the demo environment's actual data shape: `seasons` is a real JS array,
			// and an earlier `delete d.seasons[key]` left a hole that JSON.stringify serialized
			// as `null` instead of removing the element. Any `.map(s => s.name)` over the raw
			// array then throws "Cannot read properties of null (reading 'name')".
			const seasonsWithHole = [];
			for (let i = 0; i < 42; i++) {
				seasonsWithHole.push({ name: `Legacy Season ${i}`, standings: [] });
			}
			seasonsWithHole[0] = { name: "Fall 2026", standings: [] };
			seasonsWithHole.push(null); // the sparse-array hole, index 42

			await env.SHEETS_KV.put("data_json", JSON.stringify({
				current_season: "Fall 2026",
				seasons: seasonsWithHole,
				players: []
			}));

			const res = await worker.fetch(new Request("http://example.com/admin/teams/data", {
				headers: { "x-admin": "test-adminkey-123" }
			}), env);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.season).toBe("Fall 2026");
			expect(data.seasons).toContain("Fall 2026");
		});

		it("rejects unauthorized access to /admin/teams endpoints", async () => {
			const dResp = await worker.fetch(new Request("http://example.com/admin/teams/data"), env);
			expect(dResp.status).toBe(403);

			const mResp = await worker.fetch(new Request("http://example.com/admin/teams/move", { method: "POST" }), env);
			expect(mResp.status).toBe(403);

			const tResp = await worker.fetch(new Request("http://example.com/admin/teams/trade", { method: "POST" }), env);
			expect(tResp.status).toBe(403);

			const aResp = await worker.fetch(new Request("http://example.com/admin/teams/add", { method: "POST" }), env);
			expect(aResp.status).toBe(403);
		});

		it("/admin/teams/data returns the correct team count and names for a 4-team season (Fall 2026, default config), unaffected by the roster-card layout change", async () => {
			await env.SHEETS_KV.put("data_json", JSON.stringify({
				current_season: "Fall 2026",
				seasons: [{ name: "Fall 2026", standings: [] }],
				players: []
			}));

			const res = await worker.fetch(new Request("http://example.com/admin/teams/data?season=Fall+2026", {
				headers: { "x-admin": "test-adminkey-123" }
			}), env);
			expect(res.status).toBe(200);
			const data = await res.json();
			const teamNames = Object.keys(data.teams).sort();
			expect(teamNames).toEqual(["Black", "Blue", "Red", "White"]);
			expect(teamNames.length).toBe(4);
		});

		it("supports loading team rosters, moving players, and trading players with open RSVP sync", async () => {
			// Mock data.json in SHEETS_KV
			const initialData = {
				current_season: "Fall 2026",
				seasons: [{ name: "Fall 2026", standings: [] }],
				players: [
					{
						id: "P101",
						name: "Player Red",
						seasons: { "Fall 2026": { team: "Red", pos: "A", gp: 2, g: 3, a: 1, pts: 4 } },
						gseasons: {}
					},
					{
						id: "P102",
						name: "Player Blue",
						seasons: { "Fall 2026": { team: "Blue", pos: "D", gp: 2, g: 0, a: 2, pts: 2 } },
						gseasons: {}
					}
				]
			};
			await env.SHEETS_KV.put("data_json", JSON.stringify(initialData));

			// Seed contacts
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, preferred_team, position, token_salt) VALUES ('P101', 'Player Red', 'p101@example.com', 'roster', 'Red', 'A', 'salt101')`).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, preferred_team, position, token_salt) VALUES ('P102', 'Player Blue', 'p102@example.com', 'roster', 'Blue', 'D', 'salt102')`).run();

			// Setup an open event in Fall 2026 with RSVP entries
			const openEvId = "event-open-sync-test";
			await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date, state) VALUES (?, 'Fall 2026', 3, 'Sunday Oct 4', 'open')`).bind(openEvId).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES (?, 'P101', 'Red', 'in', 'roster', 'self', datetime('now'))`).bind(openEvId).run();
			await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES (?, 'P102', 'Blue', 'pending', 'roster', 'auto', datetime('now'))`).bind(openEvId).run();

			// 1. GET /admin/teams/data
			const dataRes = await worker.fetch(new Request("http://example.com/admin/teams/data?season=Fall+2026", {
				headers: { "x-admin": "test-adminkey-123" }
			}), env);
			expect(dataRes.status).toBe(200);
			const d = await dataRes.json();
			expect(d.ok).toBe(true);
			expect(d.teams.Red.some(p => p.id === "P101")).toBe(true);
			expect(d.teams.Blue.some(p => p.id === "P102")).toBe(true);

			// 2. Trade Player Red (P101) with Player Blue (P102)
			const tradeRes = await worker.fetch(new Request("http://example.com/admin/teams/trade", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({
					season: "Fall 2026",
					player_a_id: "P101",
					player_b_id: "P102"
				})
			}), env);
			expect(tradeRes.status).toBe(200);
			const tradeData = await tradeRes.json();
			expect(tradeData.ok).toBe(true);

			// Verify contacts preferred_team updated
			const c101 = await env.DB.prepare("SELECT preferred_team FROM contacts WHERE player_id = 'P101'").first();
			const c102 = await env.DB.prepare("SELECT preferred_team FROM contacts WHERE player_id = 'P102'").first();
			expect(c101.preferred_team).toBe("Blue");
			expect(c102.preferred_team).toBe("Red");

			// Verify open event RSVP synced
			const rsvp101 = await env.DB.prepare("SELECT team FROM rsvp WHERE event_id = ? AND player_id = 'P101'").bind(openEvId).first();
			const rsvp102 = await env.DB.prepare("SELECT team FROM rsvp WHERE event_id = ? AND player_id = 'P102'").bind(openEvId).first();
			expect(rsvp101.team).toBe("Blue");
			expect(rsvp102.team).toBe("Red");

			// 3. Move Player P101 to White
			const moveRes = await worker.fetch(new Request("http://example.com/admin/teams/move", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({
					season: "Fall 2026",
					player_id: "P101",
					target_team: "White",
					position: "A"
				})
			}), env);
			expect(moveRes.status).toBe(200);
			const rsvp101White = await env.DB.prepare("SELECT team FROM rsvp WHERE event_id = ? AND player_id = 'P101'").bind(openEvId).first();
			expect(rsvp101White.team).toBe("White");

			// 4. Drop-out / move to sub
			const subMoveRes = await worker.fetch(new Request("http://example.com/admin/teams/move", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({
					season: "Fall 2026",
					player_id: "P101",
					target_team: "sub"
				})
			}), env);
			expect(subMoveRes.status).toBe(200);
			const c101Sub = await env.DB.prepare("SELECT role, preferred_team FROM contacts WHERE player_id = 'P101'").first();
			expect(c101Sub.role).toBe("sub_skater");
			expect(c101Sub.preferred_team).toBeNull();
			// Rsvp for open event deleted
			const rsvp101Deleted = await env.DB.prepare("SELECT * FROM rsvp WHERE event_id = ? AND player_id = 'P101'").bind(openEvId).first();
			expect(rsvp101Deleted).toBeNull();

			// 5. Add new player to Black
			const addRes = await worker.fetch(new Request("http://example.com/admin/teams/add", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({
					season: "Fall 2026",
					name: "New Rookie",
					email: "rookie@example.com",
					target_team: "Black",
					position: "A"
				})
			}), env);
			expect(addRes.status).toBe(200);
			const addBody = await addRes.json();
			expect(addBody.ok).toBe(true);
			expect(addBody.team).toBe("Black");
			// Check open event has rsvp row
			// 6. Reject modifications on past seasons
			const pastMoveRes = await worker.fetch(new Request("http://example.com/admin/teams/move", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({
					season: "Winter 2026",
					player_id: "P101",
					target_team: "White"
				})
			}), env);
			expect(pastMoveRes.status).toBe(400);
			const pastErr = await pastMoveRes.json();
			expect(pastErr.error).toContain("Seule la saison active");

			// 7. Schedule trailing slash support
			const schedSlashRes = await worker.fetch(new Request("http://example.com/admin/schedule/"), env);
			expect(schedSlashRes.status).toBe(200);
		});
	});

	describe("Season-config-driven league branding & email identity", () => {
		beforeAll(async () => {
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, season TEXT, week INT, date TEXT, venue TEXT, state TEXT, start_time TEXT, end_time TEXT)`).run();
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rsvp (event_id TEXT, player_id TEXT, guest_name TEXT, team TEXT, status TEXT, role TEXT, status_by TEXT, updated_at TEXT, PRIMARY KEY (event_id, player_id))`).run();
			await env.DB.prepare(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, event_id TEXT, player_id TEXT, team TEXT, dedup_key TEXT, payload TEXT, send_after TEXT, sent_at TEXT, cancelled INT DEFAULT 0, error TEXT, created_at TEXT)`).run();
		});

		it("Fall 2026 (no league override) still sends under SMBHL's exact original identity — byte-for-byte unchanged", async () => {
			const originalFetch = globalThis.fetch;
			const sent = [];
			globalThis.fetch = async (url, opts) => {
				if (String(url).includes('api.resend.com')) {
					sent.push(JSON.parse(opts.body));
					return new Response(JSON.stringify({ id: 'mock_resend_id' }), { status: 200 });
				}
				return originalFetch(url, opts);
			};

			try {
				env.RESEND_API_KEY = 're_test_key_branding';
				env.RSVP_SECRET = 'test-secret-branding';
				await env.SHEETS_KV.put("data_json", JSON.stringify({
					current_season: "Fall 2026",
					seasons: [{ name: "Fall 2026", standings: [] }],
					players: []
				}));
				const past = new Date(Date.now() - 60000).toISOString();
				await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES ('brand-test-fall2026', 'Fall 2026', 3, 'Sunday', 'Gym', 'open', '10:30')`).run();
				await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('BRAND_P1', 'Brand Test Player', 'brandtest1@example.com', 'roster', 'salt-brand-1')`).run();
				await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('brand-test-fall2026', 'BRAND_P1', 'Red', 'pending', 'roster', 'auto', ?)`).bind(past).run();
				await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('gameday', 'brand-test-fall2026', 'BRAND_P1', 'Red', 'brandtest:fall2026:1', '{}', ?, ?)`).bind(past, past).run();

				const result = await drain(env);
				expect(result.sent).toBe(1);
				expect(sent.length).toBe(1);
				expect(sent[0].from).toBe('SMBHL - Hockey <joueur@smbhl.com>');
				expect(sent[0].reply_to).toBe('info@smbhl.com');
				expect(sent[0].headers['List-Unsubscribe']).toBe('<mailto:joueur@smbhl.com?subject=unsubscribe>');
				expect(sent[0].html).toContain('SMBHL');
			} finally {
				globalThis.fetch = originalFetch;
			}
		});

		it("a season with its own league config (TestLeague2026) sends under that league's identity, not SMBHL's", async () => {
			const originalFetch = globalThis.fetch;
			const sent = [];
			globalThis.fetch = async (url, opts) => {
				if (String(url).includes('api.resend.com')) {
					sent.push(JSON.parse(opts.body));
					return new Response(JSON.stringify({ id: 'mock_resend_id' }), { status: 200 });
				}
				return originalFetch(url, opts);
			};

			try {
				env.RESEND_API_KEY = 're_test_key_branding';
				env.RSVP_SECRET = 'test-secret-branding';
				await env.SHEETS_KV.put("data_json", JSON.stringify({
					current_season: "Fall 2026",
					seasons: [
						{ name: "Fall 2026", standings: [] },
						{
							name: "TestLeague2026",
							standings: [],
							config: {
								teams: [{ name: 'Hawks', name_fr: 'Faucons', colour: '#1c1f24', aliases: [] }],
								league: {
									name: 'TestLeague2026',
									tagline: 'Test League of the Testing Suite',
									fromEmail: 'test@testleague.example',
									replyToEmail: 'reply@testleague.example',
									siteUrl: 'https://testleague.example',
									faviconUrl: 'https://testleague.example/favicon.svg'
								}
							}
						}
					],
					players: []
				}));
				const past = new Date(Date.now() - 60000).toISOString();
				await env.DB.prepare(`INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES ('brand-test-testleague', 'TestLeague2026', 1, 'Sunday', 'Gym', 'open', '10:30')`).run();
				await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, email, role, token_salt) VALUES ('BRAND_P2', 'Brand Test Player Two', 'brandtest2@example.com', 'roster', 'salt-brand-2')`).run();
				await env.DB.prepare(`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('brand-test-testleague', 'BRAND_P2', 'Hawks', 'pending', 'roster', 'auto', ?)`).bind(past).run();
				await env.DB.prepare(`INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('gameday', 'brand-test-testleague', 'BRAND_P2', 'Hawks', 'brandtest:testleague:1', '{}', ?, ?)`).bind(past, past).run();

				const result = await drain(env);
				expect(result.sent).toBe(1);
				expect(sent.length).toBe(1);
				expect(sent[0].from).toBe('test@testleague.example');
				expect(sent[0].reply_to).toBe('reply@testleague.example');
				expect(sent[0].headers['List-Unsubscribe']).toBe('<mailto:test@testleague.example?subject=unsubscribe>');
				expect(sent[0].html).toContain('TestLeague2026');
				expect(sent[0].html).toContain('testleague.example');
				expect(sent[0].html).not.toContain('SMBHL');
				// The RSVP action links (yes/no, team-rsvp) still use env.PUBLIC_URL's fallback,
				// a separate, already-existing mechanism from league.siteUrl (not part of this
				// change) — only the "team page" / marketing-site link uses league.siteUrl.
				expect(sent[0].html).toContain('testleague.example/#/team/');
				expect(sent[0].html).not.toContain('href="https://smbhl.com');
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});


	describe("Attendance-only mode (league.tracksStats: false)", () => {
		const ATTENDANCE_SEASON = 'AttendanceOnly2026';

		beforeAll(async () => {
			env.ADMIN_KEY = "test-adminkey-attendance";
			// current_season is set to the attendance-only season itself so pages that resolve
			// "the current season" (like the admin nav's tab visibility) actually exercise the
			// tracksStats:false path, not Fall 2026's.
			await env.SHEETS_KV.put("data_json", JSON.stringify({
				current_season: ATTENDANCE_SEASON,
				seasons: [
					{ name: "Fall 2026", standings: [] },
					{
						name: ATTENDANCE_SEASON,
						standings: [],
						config: {
							teams: [
								{ name: 'Alpha', name_fr: 'Alpha', colour: '#334155', aliases: [] },
								{ name: 'Beta', name_fr: 'Beta', colour: '#64748b', aliases: [] }
							],
							tracksStats: false
						}
					}
				],
				players: []
			}));
			// week 0 so this event sorts first among any other 'open' events left by earlier
			// tests in this shared D1 instance (handleReviewUpload picks the open event with
			// the lowest week when none is specified).
			await env.DB.prepare(
				`INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time, end_time)
				 VALUES ('attendance-evt-1', ?, 0, 'Sunday', 'Gym', 'open', '10:30', '12:30')`
			).bind(ATTENDANCE_SEASON).run();
		});

		it("attendance/RSVP core still works normally: /admin/teams/data resolves the season's own teams", async () => {
			const res = await worker.fetch(new Request(`http://example.com/admin/teams/data?season=${encodeURIComponent(ATTENDANCE_SEASON)}`, {
				headers: { "x-admin": "test-adminkey-attendance" }
			}), env);
			expect(res.status).toBe(200);
			const data = await res.json();
			expect(data.ok).toBe(true);
			expect(Object.keys(data.teams).sort()).toEqual(['Alpha', 'Beta']);
		});

		it("/admin/season-recap/data returns a clear 'not enabled' response instead of computing awards", async () => {
			const res = await worker.fetch(new Request(`http://example.com/admin/season-recap/data?s=${encodeURIComponent(ATTENDANCE_SEASON)}`, {
				headers: { "x-admin": "test-adminkey-attendance" }
			}), env);
			expect(res.status).toBe(404);
			const data = await res.json();
			expect(data.ok).toBe(false);
			expect(data.error).toContain('tracksStats');
		});

		it("/admin/review/upload (OCR ingestion) returns a clear 'not enabled' response instead of calling Gemini or crashing", async () => {
			const formData = new FormData();
			formData.append('sheets', new Blob(['fake-image-bytes'], { type: 'image/jpeg' }), 'sheet1.jpg');

			const res = await worker.fetch(new Request("http://example.com/admin/review/upload", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-attendance" },
				body: formData
			}), env);
			expect(res.status).toBe(404);
			const data = await res.json();
			expect(data.ok).toBe(false);
			expect(data.error).toContain('tracksStats');
		});

		it("/admin/review/manual-start also returns a clear 'not enabled' response instead of creating a blank review", async () => {
			const req = new Request("http://example.com/admin/review/manual-start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ season: ATTENDANCE_SEASON, week: 0 })
			});
			const res = await handleReviewManualStart(req, env);
			expect(res.status).toBe(404);
			const data = await res.json();
			expect(data.ok).toBe(false);
			expect(data.error).toContain('tracksStats');

			const row = await env.DB.prepare("SELECT id FROM sheet_reviews WHERE season = ?").bind(ATTENDANCE_SEASON).first();
			expect(row).toBeNull();
		});

		it("admin nav hides the Scoresheets and Season Recap tabs (but not others) when the current season doesn't track stats, and the page itself still renders fine", async () => {
			const teamsPageRes = await worker.fetch(new Request("http://example.com/admin/teams"), env);
			expect(teamsPageRes.status).toBe(200);
			const html = await teamsPageRes.text();
			expect(html).toContain('Alignements');
			expect(html).not.toContain('data-tab="review"');
			expect(html).not.toContain('data-tab="recap"');
			expect(html).toContain('data-tab="subs"');
			expect(html).toContain('data-tab="finances"');
			expect(html).toContain('data-tab="polls"');
		});
	});


	describe("Text wordmark logo generator (/api/logo.svg)", () => {
		it("Fall 2026 (SMBHL, no league override) still renders the exact original hand-drawn lockup, not the generated wordmark", async () => {
			await env.SHEETS_KV.put("data_json", JSON.stringify({
				current_season: "Fall 2026",
				seasons: [{ name: "Fall 2026", standings: [] }],
				players: []
			}));
			const res = await worker.fetch(new Request("http://example.com/api/logo.svg"), env);
			expect(res.status).toBe(200);
			const svg = await res.text();
			expect(svg).toContain('aria-label="SMBHL"');
			expect(svg).toContain('<title>SMBHL horizontal lockup</title>');
			// Signature path data unique to the hand-drawn letterforms (the "S" glyph).
			expect(svg).toContain('M32 0C48 0 58.5 8.5 60 23H41');
		});

		it("a season with its own league.name (TestLeague2026) renders a generated wordmark containing that name, not SMBHL", async () => {
			await env.SHEETS_KV.put("data_json", JSON.stringify({
				current_season: "TestLeague2026",
				seasons: [
					{ name: "Fall 2026", standings: [] },
					{
						name: "TestLeague2026",
						standings: [],
						config: {
							teams: [
								{ name: 'Hawks', name_fr: 'Faucons', colour: '#1c1f24', aliases: [] },
								{ name: 'Wolves', name_fr: 'Loups', colour: '#374151', aliases: [] }
							],
							league: { name: 'TestLeague2026' }
						}
					}
				],
				players: []
			}));
			const res = await worker.fetch(new Request("http://example.com/api/logo.svg"), env);
			expect(res.status).toBe(200);
			const svg = await res.text();
			expect(svg).toContain('aria-label="TESTLEAGUE2026"');
			expect(svg).not.toContain('SMBHL');
			expect(svg).not.toContain('<title>SMBHL horizontal lockup</title>');
			// The generated wordmark spells the name out as individual coloured <tspan> glyphs.
			const letters = 'TESTLEAGUE2026'.split('');
			for (const ch of letters) {
				expect(svg).toContain('>' + ch + '</tspan>');
			}
		});

		it("a non-SMBHL league's generated wordmark does NOT reorder colours based on standings (unlike SMBHL's own hand-drawn logo)", async () => {
			const baseData = {
				current_season: "TestLeague2026",
				seasons: [
					{ name: "Fall 2026", standings: [] },
					{
						name: "TestLeague2026",
						standings: [],
						config: {
							teams: [
								{ name: 'Hawks', name_fr: 'Faucons', colour: '#1c1f24', aliases: [] },
								{ name: 'Wolves', name_fr: 'Loups', colour: '#374151', aliases: [] },
								{ name: 'Bears', name_fr: 'Ours', colour: '#78350f', aliases: [] }
							],
							league: { name: 'TestLeague2026' }
						}
					}
				],
				players: []
			};

			// Render once with Hawks in first place...
			await env.SHEETS_KV.put("data_json", JSON.stringify({
				...baseData,
				seasons: [baseData.seasons[0], {
					...baseData.seasons[1],
					standings: [
						{ team: 'Hawks', gp: 4, w: 4, l: 0, t: 0, pts: 8, gf: 20, ga: 5 },
						{ team: 'Wolves', gp: 4, w: 2, l: 2, t: 0, pts: 4, gf: 10, ga: 10 },
						{ team: 'Bears', gp: 4, w: 0, l: 4, t: 0, pts: 0, gf: 5, ga: 20 }
					]
				}]
			}));
			const res1 = await worker.fetch(new Request("http://example.com/api/logo.svg"), env);
			const svg1 = await res1.text();

			// ...then again with the standings completely reversed (Bears now in first place).
			await env.SHEETS_KV.put("data_json", JSON.stringify({
				...baseData,
				seasons: [baseData.seasons[0], {
					...baseData.seasons[1],
					standings: [
						{ team: 'Bears', gp: 4, w: 4, l: 0, t: 0, pts: 8, gf: 20, ga: 5 },
						{ team: 'Wolves', gp: 4, w: 2, l: 2, t: 0, pts: 4, gf: 10, ga: 10 },
						{ team: 'Hawks', gp: 4, w: 0, l: 4, t: 0, pts: 0, gf: 5, ga: 20 }
					]
				}]
			}));
			const res2 = await worker.fetch(new Request("http://example.com/api/logo.svg"), env);
			const svg2 = await res2.text();

			// The generated wordmark must be byte-for-byte identical regardless of standings —
			// its colour order is fixed by the season config's own team order, not live results.
			expect(svg1).toBe(svg2);
			expect(svg1).toContain('aria-label="TESTLEAGUE2026"');
		});
	});

	describe("Season-aware admin team resolution (custom 6-team season config)", () => {
		const sixTeamConfig = {
			teams: [
				{ name: 'Hawks', name_fr: 'Faucons', colour: '#1c1f24', aliases: [] },
				{ name: 'Wolves', name_fr: 'Loups', colour: '#374151', aliases: [] },
				{ name: 'Bears', name_fr: 'Ours', colour: '#78350f', aliases: [] },
				{ name: 'Lions', name_fr: 'Lions', colour: '#b45309', aliases: [] },
				{ name: 'Eagles', name_fr: 'Aigles', colour: '#166534', aliases: [] },
				{ name: 'Sharks', name_fr: 'Requins', colour: '#0369a1', aliases: [] }
			],
			goaliesPerTeam: 1,
			skatersPerTeam: 7,
			minSkaters: 4,
			playoffFormat: 'top4_two_weeks'
		};
		const TEST_SEASON = 'TestLeague2026';
		const TEST_EVENT_ID = 'testleague-2027-02-07';

		beforeAll(async () => {
			env.ADMIN_KEY = "test-adminkey-123";

			await env.SHEETS_KV.put("data_json", JSON.stringify({
				current_season: "Fall 2026",
				seasons: [
					{ name: "Fall 2026", standings: [] },
					{ name: TEST_SEASON, config: sixTeamConfig, standings: [] }
				],
				players: []
			}));

			await env.DB.prepare(
				`INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time, end_time)
				 VALUES (?, ?, 1, 'Sunday, February 7, 2027', 'Letendre', 'open', '10:30', '12:30')`
			).bind(TEST_EVENT_ID, TEST_SEASON).run();

			// 1 confirmed goalie + 5 confirmed skaters on Hawks (minSkaters is 4, so this must NOT be short)
			const hawksPlayers = [
				{ id: 'hawk-g1', goalie: 1 },
				{ id: 'hawk-s1', goalie: 0 },
				{ id: 'hawk-s2', goalie: 0 },
				{ id: 'hawk-s3', goalie: 0 },
				{ id: 'hawk-s4', goalie: 0 },
				{ id: 'hawk-s5', goalie: 0 }
			];
			for (const p of hawksPlayers) {
				await env.DB.prepare(
					`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_goalie, token_salt)
					 VALUES (?, ?, ?, 'roster', ?, ?)`
				).bind(p.id, p.id, p.id + '@example.com', p.goalie, p.id + '-salt').run();
				await env.DB.prepare(
					`INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at)
					 VALUES (?, ?, 'Hawks', 'in', 'roster', 'self', datetime('now'))`
				).bind(TEST_EVENT_ID, p.id).run();
			}
		});

		it("/admin/team-links generates links for every team in the season's own config, not the legacy Red/Blue/White/Black list", async () => {
			const res = await SELF.fetch(`http://example.com/admin/team-links?s=${encodeURIComponent(TEST_SEASON)}`, {
				headers: { "x-admin": "test-adminkey-123" }
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			const teamNames = data.links.map(l => l.team).sort();
			expect(teamNames).toEqual(['Bears', 'Eagles', 'Hawks', 'Lions', 'Sharks', 'Wolves']);

			const hawksLink = data.links.find(l => l.team === 'Hawks');
			expect(hawksLink.link).toContain('team=Hawks');
			expect(data.links.some(l => l.team === 'Red')).toBe(false);
		});

		it("/admin/board/data reports shortage per the season's own teams and config (5 confirmed skaters, minSkaters 4, is not short)", async () => {
			const data = await (await boardData(env, new URL(`http://example.com/admin/board/data?e=${TEST_EVENT_ID}`))).json();
			expect(data.event.id).toBe(TEST_EVENT_ID);

			const teamNames = data.teams.map(t => t.team).sort();
			expect(teamNames).toEqual(['Bears', 'Eagles', 'Hawks', 'Lions', 'Sharks', 'Wolves']);
			expect(teamNames).not.toContain('Red');

			const hawks = data.teams.find(t => t.team === 'Hawks');
			expect(hawks.skaters).toBe(5);
			expect(hawks.goalies).toBe(1);
			expect(hawks.short).toBe(false); // 5 >= minSkaters(4) and 1 >= goaliesPerTeam(1)
			expect(hawks.link).toContain('team=Hawks');
		});

		it("/admin/subs/reassign accepts a team from the season's own config and rejects a legacy team not in it", async () => {
			await env.DB.prepare(
				`INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt)
				 VALUES ('hawk-sub1', 'Hawks Sub', 'hawksub@example.com', 'sub_skater', 1, 'hawk-sub1-salt')`
			).run();

			const okRes = await SELF.fetch("http://example.com/admin/subs/reassign", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({ event_id: TEST_EVENT_ID, player_id: 'hawk-sub1', team: 'Hawks' })
			});
			expect(okRes.status).toBe(200);
			const rsvpRow = await env.DB.prepare(
				"SELECT team FROM rsvp WHERE event_id = ? AND player_id = ?"
			).bind(TEST_EVENT_ID, 'hawk-sub1').first();
			expect(rsvpRow.team).toBe('Hawks');

			const badRes = await SELF.fetch("http://example.com/admin/subs/reassign", {
				method: "POST",
				headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
				body: JSON.stringify({ event_id: TEST_EVENT_ID, player_id: 'hawk-sub1', team: 'Red' })
			});
			expect(badRes.status).toBe(400);
		});

		it("/admin/teams/data returns the correct team count and names for a 6-team season (TestLeague2026 config), unaffected by the roster-card layout change", async () => {
			const res = await SELF.fetch(`http://example.com/admin/teams/data?season=${encodeURIComponent(TEST_SEASON)}`, {
				headers: { "x-admin": "test-adminkey-123" }
			});
			expect(res.status).toBe(200);
			const data = await res.json();
			const teamNames = Object.keys(data.teams).sort();
			expect(teamNames).toEqual(["Bears", "Eagles", "Hawks", "Lions", "Sharks", "Wolves"]);
			expect(teamNames.length).toBe(6);
		});
	});

	describe("Admin Email Automations & Outbox Management (/admin/emails)", () => {
		beforeAll(async () => {
			env.ADMIN_KEY = "test-adminkey-123";
		});

		it("renders /admin/emails and /admin/comms pages with subtabs and automation controls", async () => {
			const res = await worker.fetch(new Request("http://example.com/admin/emails"), env);
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Gestion des communications");
			expect(html).toContain('href="/admin/comms"');
			expect(html).toContain("Automatisations & Cadence");
			expect(html).toContain("File d'envois (Outbox)");
			expect(html).toContain("Diffusion manuelle");

			const commsRes = await worker.fetch(new Request("http://example.com/admin/comms"), env);
			expect(commsRes.status).toBe(200);
		});

		it("rejects unauthorized access to /admin/emails endpoints", async () => {
			const dResp = await worker.fetch(new Request("http://example.com/admin/emails/data"), env);
			expect(dResp.status).toBe(403);

			const sResp = await worker.fetch(new Request("http://example.com/admin/emails/settings", { method: "POST" }), env);
			expect(sResp.status).toBe(403);

			const cResp = await worker.fetch(new Request("http://example.com/admin/emails/cancel", { method: "POST" }), env);
			expect(cResp.status).toBe(403);

			const bResp = await worker.fetch(new Request("http://example.com/admin/emails/broadcast", { method: "POST" }), env);
			expect(bResp.status).toBe(403);
		});

		it("manages cadence settings, outbox lifecycle, and manual broadcasts", async () => {
			env.ADMIN_EMAIL = "admin@smbhl.com";
			env.RESEND_API_KEY = "test-resend-key";

			const origFetch = globalThis.fetch;
			globalThis.fetch = async (url, opts) => {
				if (String(url).includes('api.resend.com/emails')) {
					return new Response(JSON.stringify({ id: 'resend-broadcast-123' }), { status: 200 });
				}
				return origFetch(url, opts);
			};

			try {
				// 1. GET /admin/emails/data
				const dataRes = await worker.fetch(new Request("http://example.com/admin/emails/data", {
					headers: { "x-admin": "test-adminkey-123" }
				}), env);
				expect(dataRes.status).toBe(200);
				const d = await dataRes.json();
				expect(d.ok).toBe(true);
				expect(d.settings).toBeDefined();
				expect(Array.isArray(d.outbox)).toBe(true);
				expect(d.stats).toBeDefined();

				// 2. Save settings
				const saveRes = await worker.fetch(new Request("http://example.com/admin/emails/settings", {
					method: "POST",
					headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
					body: JSON.stringify({
						invite_hours: 96,
						invite_day: "Wednesday",
						invite_hour_of_day: 10,
						r72_hours: 72,
						r72_day: "Thursday",
						r72_hour_of_day: 14,
						r49_hours: 40,
						short48_hours: 42,
						pool_hours: 30,
						r24_hours: 20,
						r24_hour_of_day: 16,
						gameday_morning_hours: 3,
						quiet_hours_enabled: true,
						quiet_hours_start: 22,
						quiet_hours_end: 8
					})
				}), env);
				expect(saveRes.status).toBe(200);
				const saveBody = await saveRes.json();
				expect(saveBody.ok).toBe(true);
				expect(saveBody.settings.invite_hours).toBe(96);
				expect(saveBody.settings.r24_hour_of_day).toBe(16);
				expect(saveBody.settings.quiet_hours_enabled).toBe(true);

				// 3. Insert an outbox message and test cancelling it
				const insRes = await env.DB.prepare(`
					INSERT INTO outbox (kind, event_id, player_id, team, send_after, cancelled)
					VALUES ('test_cancel', 'event-1', 'P9999', 'Red', datetime('now', '+1 hour'), 0)
				`).run();
				const outboxId = insRes.meta.last_row_id;

				const cancelRes = await worker.fetch(new Request("http://example.com/admin/emails/cancel", {
					method: "POST",
					headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
					body: JSON.stringify({ id: outboxId })
				}), env);
				expect(cancelRes.status).toBe(200);
				const checkCancelled = await env.DB.prepare("SELECT cancelled FROM outbox WHERE id = ?").bind(outboxId).first();
				expect(checkCancelled.cancelled).toBe(1);

				// 4. Test broadcast test mode
				const bcTestRes = await worker.fetch(new Request("http://example.com/admin/emails/broadcast", {
					method: "POST",
					headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
					body: JSON.stringify({
						target: "all",
						subject: "Test Broadcast",
						message: "Hello world broadcast test",
						test_only: true
					})
				}), env);
				expect(bcTestRes.status).toBe(200);
				const bcTestBody = await bcTestRes.json();
				expect(bcTestBody.ok).toBe(true);
				expect(bcTestBody.test).toBe(true);

				// 5. Test broadcast live mode to team Red
				const bcLiveRes = await worker.fetch(new Request("http://example.com/admin/emails/broadcast", {
					method: "POST",
					headers: { "x-admin": "test-adminkey-123", "content-type": "application/json" },
					body: JSON.stringify({
						target: "Red",
						subject: "Notice to Red",
						message: "Important team red notice",
						test_only: false
					})
				}), env);
				expect(bcLiveRes.status).toBe(200);
				const bcLiveBody = await bcLiveRes.json();
				expect(bcLiveBody.ok).toBe(true);
				expect(typeof bcLiveBody.sent_count).toBe("number");
			} finally {
				globalThis.fetch = origFetch;
			}
		});

		it("allows correct admin key to unlock immediately and clear lockout even after 10 failed attempts", async () => {
			const fakeIp = "192.168.1.99";
			// Trigger 10 failed attempts from this IP
			for (let i = 0; i < 10; i++) {
				const res = await worker.fetch(new Request("http://example.com/admin/schedule/data", {
					headers: { "x-admin": "wrong-key", "cf-connecting-ip": fakeIp }
				}), env);
				expect(res.status).toBe(403);
			}

			// 11th attempt with wrong key should be locked out (429)
			const lockRes = await worker.fetch(new Request("http://example.com/admin/schedule/data", {
				headers: { "x-admin": "wrong-key", "cf-connecting-ip": fakeIp }
			}), env);
			expect(lockRes.status).toBe(429);

			// Entering the CORRECT key must succeed (200), clear the lockout, and not be blocked
			const okRes = await worker.fetch(new Request("http://example.com/admin/schedule/data", {
				headers: { "x-admin": "test-adminkey-123", "cf-connecting-ip": fakeIp }
			}), env);
			expect(okRes.status).toBe(200);

			// Subsequent request with query parameter ?key= must also succeed
			const queryRes = await worker.fetch(new Request("http://example.com/admin/emails/data?key=test-adminkey-123", {
				headers: { "cf-connecting-ip": fakeIp }
			}), env);
			expect(queryRes.status).toBe(200);
		});

		it("persists admin authentication via cookie and supports Cloudflare Access authenticated email without lockouts", async () => {
			const fakeIp = "192.168.1.100";

			// 1. GET with ?key=... returns 200, sets 30-day cookie, and renders gate hidden
			const keyRes = await worker.fetch(new Request("http://example.com/admin/contacts?key=test-adminkey-123", {
				headers: { "cf-connecting-ip": fakeIp }
			}), env);
			expect(keyRes.status).toBe(200);
			const setCookieHeader = keyRes.headers.get("set-cookie");
			expect(setCookieHeader).toBeTruthy();
			expect(setCookieHeader).toContain("admin_key=test-adminkey-123");
			expect(setCookieHeader).toContain("Max-Age=2592000");
			const keyHtml = await keyRes.text();
			expect(keyHtml).toContain('id="gate" style="display:none"');
			expect(keyHtml).toContain('id="main"');
			expect(keyHtml).not.toContain('id="main" style="display:none"');

			// 2. Subsequent GET with cookie returns 200 and renders gate hidden
			const cookieRes = await worker.fetch(new Request("http://example.com/admin/contacts", {
				headers: { "cookie": "admin_key=test-adminkey-123", "cf-connecting-ip": fakeIp }
			}), env);
			expect(cookieRes.status).toBe(200);
			expect(cookieRes.headers.get("set-cookie")).toContain("admin_key=test-adminkey-123");
			const cookieHtml = await cookieRes.text();
			expect(cookieHtml).toContain('id="gate" style="display:none"');

			// 3. Request carrying cf-access-authenticated-user-email without admin key must be rejected
			const cfRes = await worker.fetch(new Request("http://example.com/admin/contacts", {
				headers: { "cf-access-authenticated-user-email": "emailrobertosantana@gmail.com", "cf-connecting-ip": fakeIp }
			}), env);
			expect(cfRes.status).toBe(200);
			expect(cfRes.headers.get("set-cookie")).toBeNull();
			const cfHtml = await cfRes.text();
			expect(cfHtml).not.toContain('id="gate" style="display:none"');
			expect(cfHtml).toContain('id="main" style="display:none"');

			// Admin API endpoint must return 403 when carrying Cloudflare Access header without ADMIN_KEY
			const cfApiRes = await worker.fetch(new Request("http://example.com/admin/board/data", {
				headers: { "cf-access-authenticated-user-email": "emailrobertosantana@gmail.com", "cf-connecting-ip": fakeIp }
			}), env);
			expect(cfApiRes.status).toBe(403);

			// 4. Multiple unauthenticated visits to admin pages must NEVER trigger IP lockout
			const unauthIp = "192.168.1.101";
			for (let i = 0; i < 15; i++) {
				const unauthRes = await worker.fetch(new Request("http://example.com/admin/contacts", {
					headers: { "cf-connecting-ip": unauthIp }
				}), env);
				expect(unauthRes.status).toBe(200);
			}

			// Unauthenticated user then enters correct key and immediately gains access
			const unlockRes = await worker.fetch(new Request("http://example.com/admin/contacts?key=test-adminkey-123", {
				headers: { "cf-connecting-ip": unauthIp }
			}), env);
			expect(unlockRes.status).toBe(200);
			expect(await unlockRes.text()).toContain('id="gate" style="display:none"');
		});

		it("renders /admin/season page with navigation tabs and protects /admin/season/data", async () => {
			// 1. GET /admin/season renders Season Hub
			const res = await SELF.fetch("http://example.com/admin/season");
			expect(res.status).toBe(200);
			const html = await res.text();
			expect(html).toContain("Hub de Lancement de Saison");
			expect(html).toContain("Draft Board");
			expect(html).toContain("Saison 🏒");

			// 2. Reject unauthenticated access to /admin/season/data
			const unauth = await SELF.fetch("http://example.com/admin/season/data");
			expect(unauth.status).toBe(403);

			// 3. Authenticated access returns season data
			const authRes = await worker.fetch(new Request("http://example.com/admin/season/data", {
				headers: { "x-admin": "test-adminkey-123" }
			}), env);
			expect(authRes.status).toBe(200);
			const data = await authRes.json();
			expect(data.ok).toBe(true);
			expect(data.currentSeason).toBeDefined();
			expect(Array.isArray(data.candidates)).toBe(true);
		});

		it("verifies bilingual switching infrastructure for /admin/season, /admin/comms, and /admin/season-recap", async () => {
			// 1. /admin/season
			const sRes = await SELF.fetch("http://example.com/admin/season");
			expect(sRes.status).toBe(200);
			const sHtml = await sRes.text();
			expect(sHtml).toContain("window.__currentLang");
			expect(sHtml).toContain("window.__setLang");
			expect(sHtml).toContain("Season Launch Hub 🏒");
			expect(sHtml).toContain("applyLanguage");
			expect(sHtml).toContain("admin_lang_changed");
			expect(sHtml).toContain("Admin Key");

			// 2. /admin/comms
			const cRes = await SELF.fetch("http://example.com/admin/comms");
			expect(cRes.status).toBe(200);
			const cHtml = await cRes.text();
			expect(cHtml).toContain("I18N_COMMS");
			expect(cHtml).toContain("Communications & Alerts");
			expect(cHtml).toContain("Automations & Cadence");
			expect(cHtml).toContain("Outbox Queue");
			expect(cHtml).toContain("Admin Key");
			expect(cHtml).toContain("applyLanguage");
			expect(cHtml).toContain("admin_lang_changed");

			// 3. /admin/season-recap
			const rRes = await SELF.fetch("http://example.com/admin/season-recap");
			expect(rRes.status).toBe(200);
			const rHtml = await rRes.text();
			expect(rHtml).toContain("I18N_RECAP");
			expect(rHtml).toContain("Season Recap & Awards");
			expect(rHtml).toContain("Champion Team & Official Photo");
			expect(rHtml).toContain("The 10 Seasonal Awards");
			expect(rHtml).toContain("Admin Key");
			expect(rHtml).toContain("applyLanguage");
			expect(rHtml).toContain("admin_lang_changed");
		});

		it("boardData falls back to latest event when no event is open and supports ?e= selection", async () => {
			await env.DB.prepare("UPDATE events SET state = 'done' WHERE state = 'open'").run();
			const eventId1 = "2026-09-20";
			const eventId2 = "2026-09-27";
			await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time, end_time) VALUES (?, 'Fall 2026', 2, 'Sunday September 20, 2026', 'Letendre', 'done', '10:30', '12:30')").bind(eventId1).run();
			await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time, end_time) VALUES (?, 'Fall 2026', 3, 'Sunday September 27, 2026', 'Letendre', 'open', '10:30', '12:30')").bind(eventId2).run();

			// 1. Without e param, returns the open event (Week 3)
			const resOpen = await boardData(env, new URL("http://example.com/admin/board/data"));
			const dataOpen = await resOpen.json();
			expect(dataOpen.event.id).toBe(eventId2);
			expect(dataOpen.events.length).toBeGreaterThanOrEqual(2);

			// 2. With ?e=2026-09-20, returns Week 2 explicitly even though it is 'done'
			const resW2 = await boardData(env, new URL(`http://example.com/admin/board/data?e=${eventId1}`));
			const dataW2 = await resW2.json();
			expect(dataW2.event.id).toBe(eventId1);
			expect(dataW2.event.week).toBe(2);

			// 3. When no event is 'open', falls back to a valid latest event instead of null
			await env.DB.prepare("UPDATE events SET state = 'done' WHERE id = ?").bind(eventId2).run();
			const resFallback = await boardData(env, new URL("http://example.com/admin/board/data"));
			const dataFallback = await resFallback.json();
			expect(dataFallback.event).not.toBeNull();
			expect(dataFallback.events.length).toBeGreaterThanOrEqual(2);

			// 4. Verify explicit ?e= selection works for any week
			const resW3 = await boardData(env, new URL(`http://example.com/admin/board/data?e=${eventId2}`));
			const dataW3 = await resW3.json();
			expect(dataW3.event.id).toBe(eventId2);
			expect(dataW3.event.week).toBe(3);
		});

		it("handleReviewPublish marks finalized event as done and calls ensureNextEventFunc", async () => {
			const evId = "2026-09-20";
			await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time, end_time) VALUES (?, 'Fall 2026', 2, 'Sunday September 20, 2026', 'Letendre', 'locked', '10:30', '12:30')").bind(evId).run();

			const revId = "rev_test_done_transition";
			await env.DB.prepare("INSERT OR REPLACE INTO sheet_reviews (id, event_id, season, week, created_at, status) VALUES (?, ?, 'Fall 2026', 2, '2026-09-20T12:00:00Z', 'draft')").bind(revId, evId).run();

			const sampleData = {
				seasons: [{ name: "Fall 2026", games: 4 }],
				players: []
			};
			await env.SHEETS_KV.put("data_json", JSON.stringify(sampleData));

			let nextEventTriggered = false;
			const mockEnsureNext = async (e, force) => {
				if (force) nextEventTriggered = true;
			};

			const req = new Request("http://example.com/admin/review/publish", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					review_id: revId,
					week: 2,
					games: [
						{ home_team: "Red", away_team: "Blue", home_score: 5, away_score: 3, home_players: [], away_players: [] }
					]
				})
			});

			const res = await handleReviewPublish(req, env, null, null, mockEnsureNext);
			const json = await res.json();
			expect(json.ok).toBe(true);

			// Verify event transitioned from 'locked' to 'done'
			const evUpdated = await env.DB.prepare("SELECT state FROM events WHERE id = ?").bind(evId).first();
			expect(evUpdated.state).toBe("done");

			// Verify ensureNextEventFunc was called with force=true
			expect(nextEventTriggered).toBe(true);
		});


		it("handleReviewPublish's backup email uses SMBHL's exact identity for Fall 2026 — byte-for-byte unchanged", async () => {
			const evId = "2026-11-01-backup-smbhl";
			await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time, end_time) VALUES (?, 'Fall 2026', 5, 'Sunday November 1, 2026', 'Letendre', 'locked', '10:30', '12:30')").bind(evId).run();

			const revId = "rev_backup_smbhl";
			await env.DB.prepare("INSERT OR REPLACE INTO sheet_reviews (id, event_id, season, week, created_at, status) VALUES (?, ?, 'Fall 2026', 5, '2026-11-01T12:00:00Z', 'draft')").bind(revId, evId).run();

			await env.SHEETS_KV.put("data_json", JSON.stringify({
				current_season: "Fall 2026",
				seasons: [{ name: "Fall 2026", games: 4, standings: [] }],
				players: []
			}));

			const sentEmails = [];
			const mockSendMail = async (env2, to, subject, text, html, attachments, leagueCfg) => {
				sentEmails.push({ to, subject, text, html, leagueCfg });
			};
			const mockEnsureNext = async () => {};

			const req = new Request("http://example.com/admin/review/publish", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					review_id: revId,
					week: 5,
					games: [
						{ home_team: "Red", away_team: "Blue", home_score: 5, away_score: 3, home_players: [], away_players: [] }
					]
				})
			});

			const res = await handleReviewPublish(req, env, mockSendMail, "admin@example.com", mockEnsureNext);
			expect((await res.json()).ok).toBe(true);

			const backupEmail = sentEmails.find(e => e.subject.includes('Sauvegarde automatique'));
			expect(backupEmail).toBeTruthy();
			expect(backupEmail.subject).toContain('[SMBHL]');
			expect(backupEmail.text).toContain('smbhl.com');
			expect(backupEmail.text).toContain('SMBHL Automation');
			expect(backupEmail.html).toContain('SMBHL — Sauvegarde Automatique');
			expect(backupEmail.html).toContain('smbhl.com');
		});

		it("handleReviewPublish's backup email uses a non-SMBHL season's own league identity, not SMBHL's", async () => {
			const evId = "2026-11-01-backup-testleague";
			await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time, end_time) VALUES (?, 'TestLeague2026', 1, 'Sunday November 1, 2026', 'Gym', 'locked', '10:30', '12:30')").bind(evId).run();

			const revId = "rev_backup_testleague";
			await env.DB.prepare("INSERT OR REPLACE INTO sheet_reviews (id, event_id, season, week, created_at, status) VALUES (?, ?, 'TestLeague2026', 1, '2026-11-01T12:00:00Z', 'draft')").bind(revId, evId).run();

			await env.SHEETS_KV.put("data_json", JSON.stringify({
				current_season: "TestLeague2026",
				seasons: [
					{ name: "Fall 2026", games: 4, standings: [] },
					{
						name: "TestLeague2026",
						games: 0,
						standings: [],
						config: {
							teams: [
								{ name: 'Hawks', name_fr: 'Faucons', colour: '#1c1f24', aliases: [] },
								{ name: 'Wolves', name_fr: 'Loups', colour: '#374151', aliases: [] }
							],
							league: {
								name: 'TestLeague2026',
								tagline: 'Test League of the Testing Suite',
								fromEmail: 'test@testleague.example',
								replyToEmail: 'reply@testleague.example',
								siteUrl: 'https://testleague.example',
								faviconUrl: 'https://testleague.example/favicon.svg'
							}
						}
					}
				],
				players: []
			}));

			const sentEmails = [];
			const mockSendMail = async (env2, to, subject, text, html, attachments, leagueCfg) => {
				sentEmails.push({ to, subject, text, html, leagueCfg });
			};
			const mockEnsureNext = async () => {};

			const req = new Request("http://example.com/admin/review/publish", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					review_id: revId,
					week: 1,
					games: [
						{ home_team: "Hawks", away_team: "Wolves", home_score: 4, away_score: 2, home_players: [], away_players: [] }
					]
				})
			});

			const res = await handleReviewPublish(req, env, mockSendMail, "admin@example.com", mockEnsureNext);
			expect((await res.json()).ok).toBe(true);

			const backupEmail = sentEmails.find(e => e.subject.includes('Sauvegarde automatique'));
			expect(backupEmail).toBeTruthy();
			expect(backupEmail.subject).toContain('[TestLeague2026]');
			expect(backupEmail.text).toContain('testleague.example');
			expect(backupEmail.text).toContain('TestLeague2026 Automation');
			expect(backupEmail.html).toContain('TestLeague2026 — Sauvegarde Automatique');
			expect(backupEmail.html).toContain('testleague.example');
			expect(backupEmail.subject).not.toContain('SMBHL');
			// The download link still uses env.PUBLIC_URL's fallback (rsvp.smbhl.com) — a
			// separate, already-correct mechanism from league.siteUrl, same as Part A.
			expect(backupEmail.text).not.toContain('Site en direct : https://smbhl.com');
			expect(backupEmail.html).not.toContain('SMBHL');
		});

		describe("Manual (no-photo) game-stat entry", () => {
			const MANUAL_SEASON = "SixTeamManual2027";
			const sixTeamConfig = {
				teams: [
					{ name: 'Hawks', name_fr: 'Faucons', colour: '#1c1f24', aliases: [] },
					{ name: 'Wolves', name_fr: 'Loups', colour: '#374151', aliases: [] },
					{ name: 'Bears', name_fr: 'Ours', colour: '#78350f', aliases: [] },
					{ name: 'Lions', name_fr: 'Lions', colour: '#b45309', aliases: [] },
					{ name: 'Eagles', name_fr: 'Aigles', colour: '#166534', aliases: [] },
					{ name: 'Sharks', name_fr: 'Requins', colour: '#0369a1', aliases: [] }
				],
				goaliesPerTeam: 1,
				skatersPerTeam: 7,
				minSkaters: 4,
				playoffFormat: 'top4_two_weeks'
			};

			beforeAll(async () => {
				await env.DB.prepare(
					`INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time, end_time)
					 VALUES ('sixteam-manual-evt-1', ?, 1, 'Sunday', 'Court A', 'open', '10:00', '11:00')`
				).bind(MANUAL_SEASON).run();

				await env.SHEETS_KV.put("data_json", JSON.stringify({
					current_season: MANUAL_SEASON,
					seasons: [{
						name: MANUAL_SEASON,
						standings: [],
						fixtures: [
							{ week: 1, date: "Sunday", venue: "Court A", time: "10:00 AM", gym: "Court A", home: "Hawks", away: "Wolves", hg: null, ag: null }
						],
						config: sixTeamConfig
					}],
					players: []
				}));
			});

			it("handleReviewManualStart creates a blank per-fixture draft review — same shape as an OCR review, but with no images/OCR output — for a non-SMBHL 6-team config", async () => {
				const req = new Request("http://example.com/admin/review/manual-start", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ season: MANUAL_SEASON, week: 1 })
				});
				const res = await handleReviewManualStart(req, env);
				const json = await res.json();
				expect(json.ok).toBe(true);
				expect(json.id).toBeTruthy();

				const row = await env.DB.prepare("SELECT * FROM sheet_reviews WHERE id = ?").bind(json.id).first();
				expect(row.season).toBe(MANUAL_SEASON);
				expect(row.week).toBe(1);
				expect(row.status).toBe("draft");
				expect(row.images_json).toBe("[]");
				expect(row.extracted_json).toBe("[]"); // no OCR data at all — blank instead of populated

				const games = JSON.parse(row.validated_json);
				expect(games.length).toBe(1);
				expect(games[0].home_team).toBe("Hawks");
				expect(games[0].away_team).toBe("Wolves");
				expect(games[0].home_players).toEqual([]);
				expect(games[0].away_players).toEqual([]);
				expect(games[0].has_home_sheet).toBe(false);
				expect(games[0].has_away_sheet).toBe(false);
			});

			it("re-requesting manual-start for the same season+week reuses the existing draft instead of creating a duplicate", async () => {
				const req1 = new Request("http://example.com/admin/review/manual-start", {
					method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ season: MANUAL_SEASON, week: 1 })
				});
				const { id: id1 } = await (await handleReviewManualStart(req1, env)).json();

				const req2 = new Request("http://example.com/admin/review/manual-start", {
					method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ season: MANUAL_SEASON, week: 1 })
				});
				const { id: id2 } = await (await handleReviewManualStart(req2, env)).json();

				expect(id2).toBe(id1);
				const count = await env.DB.prepare("SELECT COUNT(*) as c FROM sheet_reviews WHERE season = ? AND week = ?").bind(MANUAL_SEASON, 1).first();
				expect(count.c).toBe(1);
			});

			it("a manually-created review, filled in entirely by hand with no photo, publishes correctly for a non-SMBHL config and updates standings + player stats identically to an OCR review", async () => {
				const existing = await env.DB.prepare(
					"SELECT id FROM sheet_reviews WHERE season = ? AND week = ? AND status = 'draft'"
				).bind(MANUAL_SEASON, 1).first();
				const reviewId = existing.id;

				// This mirrors exactly what addPlayerRow() + the counter/goalie inputs produce
				// client-side: new players (id: null) with full names, goals/assists, and a
				// goalie per side — typed in by hand, with no photo or OCR involved.
				const filledGames = [{
					home_team: "Hawks", away_team: "Wolves",
					home_score: 4, away_score: 2,
					home_goalie: { name: "Hawks Goalie", id: null, ga: 2, is_sub: false },
					away_goalie: { name: "Wolves Goalie", id: null, ga: 4, is_sub: false },
					home_players: [
						{ name: "Alex Tremblay", id: null, is_sub: false, absent: false, goals: 3, assists: 1 },
						{ name: "Sam Bouchard", id: null, is_sub: false, absent: false, goals: 1, assists: 2 }
					],
					away_players: [
						{ name: "Chris Nadeau", id: null, is_sub: false, absent: false, goals: 2, assists: 0 }
					]
				}];

				const req = new Request("http://example.com/admin/review/publish", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ review_id: reviewId, week: 1, games: filledGames })
				});
				const res = await handleReviewPublish(req, env, null, null, async () => {});
				const json = await res.json();
				expect(json.ok).toBe(true);

				const updated = JSON.parse(await env.SHEETS_KV.get("data_json"));
				const season = updated.seasons.find(s => s.name === MANUAL_SEASON);

				const hawks = season.standings.find(s => s.team === "Hawks");
				const wolves = season.standings.find(s => s.team === "Wolves");
				expect(hawks.w).toBe(1);
				expect(hawks.pts).toBe(2);
				expect(hawks.gf).toBe(4);
				expect(hawks.ga).toBe(2);
				expect(wolves.l).toBe(1);
				expect(wolves.pts).toBe(0);

				const alex = updated.players.find(p => p.name === "Alex Tremblay");
				expect(alex).toBeTruthy();
				expect(alex.seasons[MANUAL_SEASON].g).toBe(3);
				expect(alex.seasons[MANUAL_SEASON].a).toBe(1);
				expect(alex.seasons[MANUAL_SEASON].team).toBe("Hawks");

				const chris = updated.players.find(p => p.name === "Chris Nadeau");
				expect(chris.seasons[MANUAL_SEASON].g).toBe(2);
				expect(chris.seasons[MANUAL_SEASON].team).toBe("Wolves");

				const hawksGoalie = updated.players.find(p => p.name === "Hawks Goalie");
				expect(hawksGoalie).toBeTruthy();
				expect(hawksGoalie.gseasons[MANUAL_SEASON].w).toBe(1);
				expect(hawksGoalie.gseasons[MANUAL_SEASON].ga).toBe(2);

				const reviewRow = await env.DB.prepare("SELECT status FROM sheet_reviews WHERE id = ?").bind(reviewId).first();
				expect(reviewRow.status).toBe("published");
			});

			it("Fall 2026's existing OCR-originated publish flow still works exactly as before (unaffected by the manual-entry additions)", async () => {
				const evId = "2026-09-27-ocr-unchanged";
				await env.DB.prepare(
					"INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time, end_time) VALUES (?, 'Fall 2026', 3, 'Sunday September 27, 2026', 'Letendre', 'locked', '10:30', '12:30')"
				).bind(evId).run();

				const revId = "rev_ocr_unchanged";
				await env.DB.prepare(
					"INSERT OR REPLACE INTO sheet_reviews (id, event_id, season, week, created_at, status, images_json, extracted_json) VALUES (?, ?, 'Fall 2026', 3, '2026-09-27T12:00:00Z', 'draft', ?, ?)"
				).bind(
					revId, evId,
					JSON.stringify(['img:rev_ocr_unchanged:0']),
					JSON.stringify([{ team: 'Red', game1: { opponent: 'Blue', team_score: 5, opponent_score: 3 } }])
				).run();

				await env.SHEETS_KV.put("data_json", JSON.stringify({
					current_season: "Fall 2026",
					seasons: [{ name: "Fall 2026", games: 4, standings: [] }],
					players: []
				}));

				const req = new Request("http://example.com/admin/review/publish", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						review_id: revId, week: 3,
						games: [{ home_team: "Red", away_team: "Blue", home_score: 5, away_score: 3, home_players: [], away_players: [] }]
					})
				});
				const res = await handleReviewPublish(req, env, null, null, async () => {});
				const json = await res.json();
				expect(json.ok).toBe(true);

				const updated = JSON.parse(await env.SHEETS_KV.get("data_json"));
				const fall2026 = updated.seasons.find(s => s.name === "Fall 2026");
				expect(fall2026.games).toBe(0); // no fixtures defined in this minimal data_json, matches pre-existing behavior
			});
		});

		describe("Dynamic Backup Goalie Support", () => {
			const evId = "2026-10-04";
			beforeAll(async () => {
				await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state) VALUES (?, 'Fall 2026', 4, 'Sunday October 4, 2026', 'Letendre', 'open')").bind(evId).run();
				// Primary goalie: P_PRIMARY (Anthony)
				await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, role, is_goalie, is_backup_goalie, token_salt) VALUES ('P_PRIMARY', 'Starting Goalie', 'roster', 1, 0, 'salt1')").run();
				// Backup goalie: P_BACKUP (Tyler)
				await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, role, is_goalie, is_backup_goalie, position, token_salt) VALUES ('P_BACKUP', 'Backup Goalie', 'roster', 0, 1, 'D', 'salt2')").run();
				// 5 Skaters
				for (let i = 1; i <= 5; i++) {
					await env.DB.prepare(`INSERT OR REPLACE INTO contacts (player_id, name, role, is_goalie, is_backup_goalie, position, token_salt) VALUES ('P_SKATER_${i}', 'Skater ${i}', 'roster', 0, 0, 'F', 'salt_s')`).run();
				}
			});

			it("Starting goalie IN + Backup goalie IN: backup goalie counts as skater, goalies = 1", async () => {
				const now = new Date().toISOString();
				await env.DB.prepare("DELETE FROM rsvp WHERE event_id = ? AND team = 'Blue'").bind(evId).run();
				await env.DB.prepare("INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES (?, 'P_PRIMARY', 'Blue', 'in', 'roster', 'self', ?)").bind(evId, now).run();
				await env.DB.prepare("INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES (?, 'P_BACKUP', 'Blue', 'in', 'roster', 'self', ?)").bind(evId, now).run();
				for (let i = 1; i <= 5; i++) {
					await env.DB.prepare("INSERT INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES (?, ?, 'Blue', 'in', 'roster', 'self', ?)").bind(evId, `P_SKATER_${i}`, now).run();
				}

				const st = await teamState(env.DB, evId, 'Blue');
				expect(st.goalies).toBe(1);
				expect(st.shortGoalie).toBe(false);
				expect(st.skaters).toBe(6); // 5 skaters + backup goalie playing defense!

				const exp = await expected(env.DB, evId, 'Blue');
				expect(exp.goalies).toBe(1);
				expect(exp.skaters).toBe(6);
			});

			it("Starting goalie OUT + Backup goalie IN: backup goalie takes net, goalies = 1, shortGoalie = false", async () => {
				const now = new Date().toISOString();
				await env.DB.prepare("UPDATE rsvp SET status = 'out' WHERE event_id = ? AND player_id = 'P_PRIMARY'").bind(evId).run();
				await env.DB.prepare("UPDATE rsvp SET status = 'in' WHERE event_id = ? AND player_id = 'P_BACKUP'").bind(evId).run();

				const st = await teamState(env.DB, evId, 'Blue');
				expect(st.goalies).toBe(1); // Tyler takes net!
				expect(st.shortGoalie).toBe(false);
				expect(st.skaters).toBe(5); // Backup goalie shifted from D to G, leaving 5 skaters

				const exp = await expected(env.DB, evId, 'Blue');
				expect(exp.goalies).toBe(1);
				expect(exp.skaters).toBe(5);
			});

			it("Starting goalie OUT + Backup goalie OUT: team has 0 goalies, shortGoalie = true", async () => {
				await env.DB.prepare("UPDATE rsvp SET status = 'out' WHERE event_id = ? AND player_id IN ('P_PRIMARY', 'P_BACKUP')").bind(evId).run();

				const st = await teamState(env.DB, evId, 'Blue');
				expect(st.goalies).toBe(0);
				expect(st.shortGoalie).toBe(true);
				expect(st.skaters).toBe(5);

				const exp = await expected(env.DB, evId, 'Blue');
				expect(exp.goalies).toBe(0); // 0 goalies expected -> opens 1 goalie spot!
			});

			it("Admin API toggles is_backup_goalie for any player", async () => {
				env.ADMIN_KEY = "test_admin_key";
				const req = new Request("http://example.com/admin/contacts", {
					method: "POST",
					headers: { "content-type": "application/json", "x-admin": "test_admin_key" },
					body: JSON.stringify({ action: "backup_goalie", player_id: "P_SKATER_1", is_backup_goalie: 1 })
				});
				const res = await worker.fetch(req, env);
				const json = await res.json();
				expect(json.ok).toBe(true);
				expect(json.is_backup_goalie).toBe(1);

				const row = await env.DB.prepare("SELECT is_backup_goalie FROM contacts WHERE player_id = 'P_SKATER_1'").first();
				expect(row.is_backup_goalie).toBe(1);
			});
		});

		describe("Previous-Week Sub Invites & Weekly League Announcement", () => {
			const ev = { id: "2026-09-27", week: 3, date: "Sunday September 27" };

			it("renders league message in invite email when present", () => {
				const res = body('invite', {
					ev,
					name: 'Roberto',
					team: 'Blue',
					link: 'https://rsvp.smbhl.com/rsvp?e=2026-09-27&p=P0001&t=tok1',
					payload: {
						yes: 'https://rsvp.smbhl.com/rsvp?e=2026-09-27&p=P0001&t=tok1&v=in',
						no: 'https://rsvp.smbhl.com/rsvp?e=2026-09-27&p=P0001&t=tok1&v=out',
						leagueMessage: "Attention: gym entrance will be through the East door this Sunday due to renovations."
					}
				});

				expect(res.text).toContain("Message de la ligue / League note :");
				expect(res.text).toContain("gym entrance will be through the East door");
				expect(res.html).toContain("Message de la ligue / League note");
				expect(res.html).toContain("gym entrance will be through the East door");
			});

			it("renders sub waitlist invite layout for previous-week subs and omits season dues", () => {
				const res = body('invite', {
					ev,
					name: 'Henrik',
					link: 'https://rsvp.smbhl.com/rsvp?e=2026-09-27&p=P0298&t=tok2',
					payload: {
						isSubInvite: true,
						yes: 'https://rsvp.smbhl.com/avail?e=2026-09-27&p=P0298&n=skater&t=tokyes&a=yes',
						no: 'https://rsvp.smbhl.com/avail?e=2026-09-27&p=P0298&n=skater&t=tokno&a=no',
						leagueMessage: "Weekly note for everyone."
					}
				});

				expect(res.text).toContain("Dispo pour remplacer");
				expect(res.text).toContain("Available to sub");
				expect(res.text).toContain("https://rsvp.smbhl.com/avail?e=2026-09-27&p=P0298&n=skater&t=tokyes&a=yes");
				expect(res.text).toContain("Oui = liste d'attente, placement automatique si une place se libère.");
				expect(res.html).toContain("Oui / Yes");
				expect(res.html).toContain("Weekly note for everyone.");

				// Must NOT have regular dues or team manage links
				expect(res.text).not.toContain("Cotisation de saison");
				expect(res.text).not.toContain("Season Dues");
				expect(res.html).not.toContain("Cotisation de saison");
				expect(res.text).not.toContain("Gérer l'équipe");
			});

			it("renders dues reminder for previous-week subs when balance is due", () => {
				const res = body('invite', {
					ev,
					name: 'Armando',
					link: 'https://rsvp.smbhl.com/rsvp?e=2026-09-27&p=P0036&t=tok3',
					payload: {
						isSubInvite: true,
						yes: 'https://rsvp.smbhl.com/avail?e=2026-09-27&p=P0036&n=skater&t=tokyes&a=yes',
						no: 'https://rsvp.smbhl.com/avail?e=2026-09-27&p=P0036&n=skater&t=tokno&a=no',
						duesReminder: { balance: 10, phone: "514-575-5251" }
					}
				});

				expect(res.text).toContain("Montant dû / Amount due : 10,00 $");
				expect(res.text).toContain("514-575-5251");
				expect(res.html).toContain("10,00 $");
				expect(res.html).toContain("514-575-5251");
				expect(res.html).toContain("Oui / Yes");
				expect(res.text).not.toContain("Gérer l'équipe");
			});

			it("API GET & POST /admin/comms/league-message persists and clears note in settings", async () => {
				env.ADMIN_KEY = "test_admin_key";

				// 1. Save note
				const saveReq = new Request("http://example.com/admin/comms/league-message", {
					method: "POST",
					headers: { "content-type": "application/json", "x-admin": "test_admin_key" },
					body: JSON.stringify({ event_id: "2026-09-27", message: "  Puck drop is 15 minutes earlier!  " })
				});
				const saveRes = await worker.fetch(saveReq, env);
				const saveJson = await saveRes.json();
				expect(saveJson.ok).toBe(true);
				expect(saveJson.message).toBe("Puck drop is 15 minutes earlier!");

				// 2. Get note
				const getReq = new Request("http://example.com/admin/comms/league-message?e=2026-09-27", {
					method: "GET",
					headers: { "x-admin": "test_admin_key" }
				});
				const getRes = await worker.fetch(getReq, env);
				const getJson = await getRes.json();
				expect(getJson.ok).toBe(true);
				expect(getJson.message).toBe("Puck drop is 15 minutes earlier!");

				// Verify in settings table
				const dbRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'league_message:2026-09-27'").first();
				expect(dbRow.value).toBe("Puck drop is 15 minutes earlier!");

				// 3. Clear note
				const clearReq = new Request("http://example.com/admin/comms/league-message", {
					method: "POST",
					headers: { "content-type": "application/json", "x-admin": "test_admin_key" },
					body: JSON.stringify({ event_id: "2026-09-27", message: "" })
				});
				const clearRes = await worker.fetch(clearReq, env);
				const clearJson = await clearRes.json();
				expect(clearJson.ok).toBe(true);
				expect(clearJson.message).toBe("");

				const afterClear = await env.DB.prepare("SELECT value FROM settings WHERE key = 'league_message:2026-09-27'").first();
				expect(afterClear).toBeNull();
			});

			it("runSchedule fire('invite') enqueues both regular roster and previous-week subs", async () => {
				const season = "SubInviteSeason 2026";
				const now = new Date().toISOString();
				const pastId = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
				const futureId = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

				// Week 1 event (completed)
				await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES (?, ?, 1, 'Past Week', 'Gym', 'done', '10:30')").bind(pastId, season).run();
				// Week 2 event (open, ready for invite)
				await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES (?, ?, 2, 'Future Week', 'Gym', 'open', '10:30')").bind(futureId, season).run();

				// Contacts
				await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt) VALUES ('P_REG_W2', 'Regular W2', 'regw2@test.com', 'roster', 0, 'salt1')").run();
				await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt) VALUES ('P_SUB_W1', 'Sub Played W1', 'subw1@test.com', 'sub', 1, 'salt2')").run();

				// In Week 1: Sub played and had status = 'in'
				await env.DB.prepare("INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES (?, 'P_SUB_W1', 'Blue', 'in', 'sub', 'sheet', ?)").bind(pastId, now).run();

				// In Week 2: Regular player is on roster
				await env.DB.prepare("INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES (?, 'P_REG_W2', 'Blue', 'pending', 'roster', 'auto', ?)").bind(futureId, now).run();

				// Trigger schedule with invite_hours large enough so it fires
				await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('email_cadence_settings', ?)").bind(JSON.stringify({ invite_hours: 999999, invite_hour_of_day: 0 })).run();

				await runSchedule(env);

				// Check outbox for Week 2 invites
				const outboxRows = (await env.DB.prepare("SELECT player_id, payload FROM outbox WHERE event_id = ? AND kind = 'invite'").bind(futureId).all()).results;
				const playerIds = outboxRows.map(r => r.player_id);

				expect(playerIds).toContain('P_REG_W2');
				expect(playerIds).toContain('P_SUB_W1');

				const subOutbox = outboxRows.find(r => r.player_id === 'P_SUB_W1');
				const subPayload = JSON.parse(subOutbox.payload || '{}');
				expect(subPayload.is_sub).toBe(true);
			});

			it("drain() populates duesReminder for subs who played and owe money", async () => {
				const origFetch = globalThis.fetch;
				const sentMails = [];
				globalThis.fetch = async (url, opts) => {
					if (String(url).includes('api.resend.com')) {
						sentMails.push(JSON.parse(opts.body));
						return new Response(JSON.stringify({ id: 'mock_resend_sub_dues' }), { status: 200 });
					}
					return origFetch(url, opts);
				};

				try {
					env.RESEND_API_KEY = 're_test_key_sub_dues';
					env.RSVP_SECRET = 'test-secret-sub-dues';
					const now = new Date(Date.now() - 60000).toISOString();
					const season = "SubDuesSeason 2026";

					// Week 1 done, Week 2 open
					await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES ('ev-sub-w1', ?, 1, 'Sunday Sept 13', 'Gym', 'done', '10:30')").bind(season).run();
					await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES ('ev-sub-w2', ?, 2, 'Sunday Sept 20', 'Gym', 'open', '10:30')").bind(season).run();
					await env.DB.prepare("INSERT OR REPLACE INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, etransfer_phone, updated_at) VALUES (?, 170, 0, 5, 0, '514-575-5251', ?)").bind(season, now).run();

					// 1. Sub skater who owes money (played Week 1, unpaid)
					await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt) VALUES ('P_SUB_OWES', 'Armando Sub', 'armando_sub@test.com', 'sub', 1, 'salt_armando')").run();
					await env.DB.prepare("INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('ev-sub-w1', 'P_SUB_OWES', 'White', 'in', 'sub', 'sheet', ?)").bind(now).run();
					await env.DB.prepare("INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('invite', 'ev-sub-w2', 'P_SUB_OWES', NULL, 'invite:sub_owes', '{\"is_sub\":true}', ?, ?)").bind(now, now).run();

					// 2. Sub skater who paid (played Week 1, paid $10)
					await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt) VALUES ('P_SUB_PAID', 'Emile Sub', 'emile_sub@test.com', 'sub', 1, 'salt_emile')").run();
					await env.DB.prepare("INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('ev-sub-w1', 'P_SUB_PAID', 'Black', 'in', 'sub', 'sheet', ?)").bind(now).run();
					await env.DB.prepare("INSERT OR REPLACE INTO player_dues (season, player_id, custom_due, adjustment, amount_paid, notes, updated_at) VALUES (?, 'P_SUB_PAID', 10, 0, 10, 'Paid', ?)").bind(season, now).run();
					await env.DB.prepare("INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('invite', 'ev-sub-w2', 'P_SUB_PAID', NULL, 'invite:sub_paid', '{\"is_sub\":true}', ?, ?)").bind(now, now).run();

					// 3. Sub goalie ($0 fee)
					await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, is_goalie, token_salt) VALUES ('P_SUB_G', 'Anthony SubG', 'anthony_subg@test.com', 'sub_goalie', 1, 1, 'salt_anthony_g')").run();
					await env.DB.prepare("INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('ev-sub-w1', 'P_SUB_G', 'Red', 'in', 'sub', 'sheet', ?)").bind(now).run();
					await env.DB.prepare("INSERT INTO outbox (kind, event_id, player_id, team, dedup_key, payload, send_after, created_at) VALUES ('invite', 'ev-sub-w2', 'P_SUB_G', NULL, 'invite:sub_g', '{\"is_sub\":true}', ?, ?)").bind(now, now).run();

					const drainRes = await drain(env);
					expect(drainRes.sent).toBe(3);

					const owesMail = sentMails.find(m => m.to[0] === 'armando_sub@test.com');
					expect(owesMail).toBeDefined();
					expect(owesMail.html).toContain("10,00 $");
					expect(owesMail.html).toContain("514-575-5251");
					expect(owesMail.html).toContain("Dispo pour remplacer");
					expect(owesMail.html).toContain("Oui / Yes");

					const paidMail = sentMails.find(m => m.to[0] === 'emile_sub@test.com');
					expect(paidMail).toBeDefined();
					expect(paidMail.html).not.toContain("Cotisation de saison");
					expect(paidMail.html).not.toContain("Season Dues");
					expect(paidMail.html).toContain("Dispo pour remplacer");

					const goalieMail = sentMails.find(m => m.to[0] === 'anthony_subg@test.com');
					expect(goalieMail).toBeDefined();
					expect(goalieMail.html).not.toContain("Cotisation de saison");
					expect(goalieMail.html).not.toContain("Season Dues");
				} finally {
					globalThis.fetch = origFetch;
				}
			});

			it("handleSendSampleInvites triggers preview emails for regular and sub", async () => {
				const origFetch = globalThis.fetch;
				const sentMails = [];
				globalThis.fetch = async (url, opts) => {
					if (String(url).includes('api.resend.com')) {
						sentMails.push(JSON.parse(opts.body));
						return new Response(JSON.stringify({ id: 'mock_resend_sample_invites' }), { status: 200 });
					}
					return origFetch(url, opts);
				};

				try {
					env.RESEND_API_KEY = 're_test_key_sample';
					env.RSVP_SECRET = 'test-secret-sample';
					const now = new Date().toISOString();
					const season = "SampleInviteSeason 2026";

					await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES ('2026-09-27', ?, 3, 'Sunday September 27', 'Gym', 'open', '10:30')").bind(season).run();
					await env.DB.prepare("INSERT OR REPLACE INTO events (id, season, week, date, venue, state, start_time) VALUES ('2026-09-20', ?, 2, 'Sunday September 20', 'Gym', 'done', '10:30')").bind(season).run();
					await env.DB.prepare("INSERT OR REPLACE INTO season_pricing (season, price_player, price_goalie, price_sub_player, price_sub_goalie, etransfer_phone, updated_at) VALUES (?, 170, 0, 5, 0, '514-575-5251', ?)").bind(season, now).run();

					// Regular player
					await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt) VALUES ('P0001', 'Adam Albanese', 'adam@test.com', 'roster', 0, 'salt_adam')").run();
					await env.DB.prepare("INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-27', 'P0001', 'Red', 'pending', 'roster', 'auto', ?)").bind(now).run();

					// Sub player who played Week 2
					await env.DB.prepare("INSERT OR REPLACE INTO contacts (player_id, name, email, role, is_sub, token_salt) VALUES ('P0036', 'Armando Tempestilli', 'armando@test.com', 'sub', 1, 'salt_armando')").run();
					await env.DB.prepare("INSERT OR REPLACE INTO rsvp (event_id, player_id, team, status, role, status_by, updated_at) VALUES ('2026-09-20', 'P0036', 'White', 'in', 'sub', 'sheet', ?)").bind(now).run();

					const req = new Request("http://example.com/api/send-sample-invites", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							event_id: "2026-09-27",
							recipients: ["emailrobertosantana@gmail.com", "rsantana@live.ca"]
						})
					});

					const res = await worker.fetch(req, env);
					const data = await res.json();
					expect(data.ok).toBe(true);
					expect(data.sent_samples.length).toBe(2);

					// 2 emails (Regular + Sub) sent to each of the 2 recipients = 4 emails sent
					expect(sentMails.length).toBe(4);

					// Regular preview verification
					const regMail = sentMails.find(m => m.subject.includes("REGULAR"));
					expect(regMail).toBeDefined();
					expect(regMail.html).toContain("170,00 $");
					expect(regMail.html).toContain("514-575-5251");
					expect(regMail.html).toContain("Gérer l&#39;équipe Rouge / Manage Red roster &amp; subs");

					// Sub preview verification
					const subMail = sentMails.find(m => m.subject.includes("SUB"));
					expect(subMail).toBeDefined();
					expect(subMail.html).toContain("10,00 $");
					expect(subMail.html).toContain("514-575-5251");
					expect(subMail.html).toContain("Dispo pour remplacer");
					expect(subMail.html).toContain("Oui / Yes");
				} finally {
					globalThis.fetch = origFetch;
				}
			});
		});
	});
});



