# Working on this repo

SMBHL (rsvp.smbhl.com) and Notre Ligue (rsvp.notreligue.ca) run from this one codebase. Roberto owns both.

## Speed rules (apply to every item)

- One test run at a time. Before each run, make sure no vitest or Playwright process is still running. Never run two in parallel.
- Per item: run only the new test files and the test files you edit. No extra targeted runs, no timing investigations, no A/B comparisons.
- Full suite once, at the end: workers project, then rendered project, sequentially. If something fails, rerun only the failing files, alone, once. Report what still fails and do not deploy.
- Golden recordings: the part114 golden tests are the check. Only capture and diff recordings for items allowed to change them (see each item).
- Edits: use the Edit tool or a script file in the scratchpad. Never node -e or heredocs containing JavaScript template literals.
- If an item would break many existing tests, stop and report the count before rewriting them.
- Do not wait for me between steps listed here. Stop only on the stop conditions written in the item.
- Report: a table of item, status and commit, then only decisions needed and anything that differs from the plan.

## Standing rules

Never deploy production, never push, never write to the production database or KV, never change DNS or Cloudflare settings. Never print secrets, tokens or full email addresses. Never touch copy-audit/ or the design system files. No em dashes in code comments, commit messages, copy or the report. No migration in this batch.

## One codebase

SMBHL and Notre Ligue share their code. No forks: build a feature once, for both products, and keep SMBHL's behaviour unchanged unless the item says otherwise.

## Production

The agent never deploys production. Roberto does. The agent may deploy the demo (`npm run deploy:demo`) when a batch says so.

## Migrations

A migration must keep the old code working on the new schema, and the new code working on the old schema. In the 054 incident, the migration reached production before the code that used it, and finance saves failed. Production code is deployed in the same sitting as any migration.

## French copy

- Notre Ligue speaks to players with "tu" and says "remplaçant".
- No space before « ? » and « ! ». Keep the space before « : » and inside « ».
- Avoid gendered forms such as « ·e » or « (e) »: rewrite the sentence so it is neutral.

## Golden recordings

The part114 golden recordings (SMBHL and leagues) change only with Roberto's explicit permission, given per item. Any other change to them means stop.

## Tests

- `npx vitest run --project workers --maxWorkers=4` (about 8 min), then `npx vitest run --project rendered` (about 7 min).
- `src/index.js` is CRLF and very large: read only the part you need.
