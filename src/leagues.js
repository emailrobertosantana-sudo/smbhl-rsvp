// League provisioning for real user accounts (auth.js). Purely additive:
// nothing existing reads from the leagues/league_admins tables, and this
// does not touch data_json, events, or any other Fall-2026 data path.
//
// ARCHITECTURE DECISION — read this before extending anything here:
// Actually creating a new physical D1 database or KV namespace per league
// requires the Cloudflare account-level API (what `wrangler d1 create` /
// `wrangler kv namespace create` do) — a Worker's own request handler cannot
// provision new account-level resources like that from inside a fetch event;
// there is no "create me a new database" call available at runtime. So
// leagues in this file are ROWS in the one shared D1 database this Worker
// already has (env.DB), scoped by league_id, not separate physical
// databases. This is a deliberate fork away from tonight's one-database-
// per-league demo setup (one manually wrangler-provisioned DB per league) —
// see the final report for the honest scope of what still needs to change
// before a second league's actual attendance/stats data is isolated by this
// league_id (short version: everything that currently reads a single shared
// data_json / unscoped events table would need to become league_id-aware;
// that is explicitly NOT done in this task).

import { checkUserSession } from './auth.js';

export async function handleLeagueCreate(req, env) {
  try {
    const session = await checkUserSession(req, env);
    if (!session) {
      return Response.json({ ok: false, error: 'Authentication required.' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const name = String(body.name || '').trim();
    const teamNames = Array.isArray(body.teamNames)
      ? body.teamNames.map(t => String(t || '').trim()).filter(Boolean)
      : [];
    const tracksStats = body.tracksStats !== false; // defaults to true, matching season_config.js's own default
    const divisionLabel = body.divisionLabel ? String(body.divisionLabel).trim() : null;

    if (!name) {
      return Response.json({ ok: false, error: 'League name is required.' }, { status: 400 });
    }
    if (teamNames.length < 2) {
      return Response.json({ ok: false, error: 'At least 2 team names are required.' }, { status: 400 });
    }

    const leagueId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO leagues (id, name, division_label, tracks_stats, team_count, team_names, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(leagueId, name, divisionLabel, tracksStats ? 1 : 0, teamNames.length, JSON.stringify(teamNames), session.userId, now).run();

    await env.DB.prepare(
      `INSERT INTO league_admins (user_id, league_id, role, created_at) VALUES (?, ?, 'admin', ?)`
    ).bind(session.userId, leagueId, now).run();

    return Response.json({
      ok: true,
      league: {
        id: leagueId,
        name,
        divisionLabel,
        tracksStats,
        teamCount: teamNames.length,
        teamNames
      }
    });
  } catch (err) {
    return Response.json({ ok: false, error: 'League creation failed: ' + err.message }, { status: 500 });
  }
}
