# Notre Ligue billing (Stripe)

Built in three batches. Batch 1 (this one) is the foundation and is invisible to admins.

## Switch

`BILLING_LAUNCH_AT` (an ISO date, `wrangler.jsonc` `env.demo.vars` only). Unset or not a date: billing is off.

- Nothing is gated and no notice is sent.
- Stripe is never called: `src/stripe.js` refuses every request.
- `POST /billing/stripe-webhook` verifies the signature and records each event once in `stripe_events`, without processing it, and answers 200. Without `STRIPE_WEBHOOK_SECRET` it answers 404. Once `BILLING_LAUNCH_AT` is set, the recorded events are processed once, oldest first (next delivery, and the Notre Ligue cron).
- The only thing kept is each league's regular-player count (`league_billing`), shown on the super-admin page.

SMBHL is never counted or billed.

## Batch 1

- `migrate-056.sql`: `league_billing`, `stripe_events`, `billing_notices`. Additive, no foreign key.
- `src/billing.js`:
  - The count: regular players (`role = 'roster'`, active, not opted out) with a non-empty email, each lowercase address once.
  - The tier it implies: under 15 free, 15 to 50 Standard, 51 to 100 Plus, over 100 custom.
  - When the count is refreshed: after `POST /league/contacts`, `/league/contacts/bulk`, `/league/contacts/update`, `/league/contacts/active` and `/league/season/rollover-import`, and once a day from the Notre Ligue cron.
  - The trial: 2 months from the league's creation or the launch, whichever is later.
  - The super-admin summary.
- `src/stripe.js`: plain `fetch`, form encoded, `Stripe-Version` pinned by `STRIPE_API_VERSION`, `Idempotency-Key` on marked POSTs. Errors never include the key or Stripe's own message.
- `src/stripe_webhook.js`:
  - The signature: HMAC-SHA256 over `t.payload` with Web Crypto, the full hex digest, any `v1`, constant-time compare, 300 seconds tolerance.
  - Each event is processed once (`stripe_events`): 400 on a bad signature, 200 on a duplicate, 500 on a failure so Stripe retries.
  - Handlers fetch the current object from Stripe. Events handled: `checkout.session.completed`, `customer.subscription.created/updated/deleted/paused/resumed`, `invoice.paid`, `invoice.payment_failed`, `customer.deleted`. `charge.refunded` is recorded only (batch 2 cancels on a full refund).
- Super-admin page: regular players and the tier they imply, billed tier and status, trial end, and the "free exception" toggle.

## Decisions (Roberto, 2026-10-01)

- A league that subscribes during its trial keeps the rest of the trial and is first charged at its end. A card is required at checkout unless the total is 0.
- Players can still answer in a read-only league.
- When one owner has two small leagues, the oldest keeps the free slot.
- Payment and card notices go to the owner only. Read-only and deletion warnings go to every admin.
- The "Test interne" promotion code is deactivated at launch, and its test subscriptions are cancelled.
- No beta leagues: billing launches on demo for every Notre Ligue league at once (batch 2). SMBHL and production never get a launch date.
- A full refund ends the subscription at once (Roberto makes refunds in the Dashboard).

## Batch 2: the billing page (src/billing_actions.js)

- `/league/billing`, linked from the settings page once billing is on. Every admin sees it; only the owner (`leagues.created_by`) acts. Never SMBHL.
- Checkout: Stripe's hosted page (a redirect, the default `ui_mode`; no Stripe script on our pages). Subscription mode, the price for the tier the count implies and the chosen interval, `client_reference_id` and metadata with the league id, the owner's email, promotion codes allowed, `payment_method_collection` `if_required`, locale `fr-CA` or `en`, success and cancel URLs back to the page.
- Inside the trial: `subscription_data[trial_end]` is the league's trial end (when at least 48 hours away), so the first charge is then. No card is asked at checkout when nothing is due; `trial_settings[end_behavior][missing_payment_method]` is `pause`, so a subscription with no card and an amount due is paused when the trial ends. A card is required then unless the total is 0.
- A live subscription (active, trialing, past due or paused) shows "Manage my subscription" (the Customer Portal, the account's default configuration) instead of a second Checkout. Back from Checkout, the session is read and the subscription written at once.
- Cancellation from the portal takes effect at the period end; the page shows the end date.
- Refunds: `charge.refunded` with the full amount refunded cancels the league's subscription at once (DELETE); a partial refund changes nothing.
- Pause (monthly only): `pause_collection[behavior]=void`. Stripe keeps the subscription and voids each invoice while paused, so nothing is charged, for as long as it lasts. Resume reads the subscription from Stripe first. Past its trial, resume clears the pause with `billing_cycle_anchor=now` and `proration_behavior=none`: a new cycle starts that day. Still trialing, resume only clears the pause (Stripe refuses to reset a trialing subscription's `billing_cycle_anchor`), and the first charge stays at the trial's end. The page says "Billing restarts today." only for a paused subscription past its trial.
- Tier change at renewal: the Notre Ligue cron checks every pass. A subscription whose stored count belongs in the other paid tier gets the other price (same interval) within the last 36 hours before its renewal, with `proration_behavior=none`, so the renewal invoice is the first at the new price. Free and custom counts are left to batch 3.

## Batch 3: enforcement (src/billing_enforcement.js, src/billing_notices.js)

Only once `BILLING_LAUNCH_AT` is set; SMBHL is never read. No migration: `league_billing` and `billing_notices` (056) have every column.

- The state, `src/billing.js` `classifyLeague`: trial, free, active, past due, paused, grace, custom (over 100) or unpaid.
- Read-only: the trial ended without a subscription (and the league is not free), the subscription is paused (by the owner, or by Stripe for want of a card), or a payment failed and is still unpaid; and a cancelled league that is not free. Refused server-side before routing (`src/write_guard.js` mode `billing`, `LEAGUE_READ_ONLY`, 403), for the league the session acts on. Still allowed: the billing page and its actions, the Stripe webhook, the account (`/auth/`), the super-admin, players' answers (`/rsvp`, `/rsvp/confirm`, `/rsvp/absences`, `/team-rsvp`, `/league/rsvp`, `/league/rsvp/confirm`, `/league/rsvp/game`, `/avail`, `/api/poll/vote`, `/api/player-position`), creating another league, accepting an admin invitation, deactivating and deleting the league. Pages (GET) work, with a banner pointing to the billing page; the public league page is unchanged.
- Automatic emails stop (read-only, or a free league past its 14 days): the reminder waves, the auto-draw and shortfall sub calls of the cron, the sub call after a player's answer, the admin alerts (short game, night waitlist, thin game, late reversal, health alerts). Queued mail, billing notices and anything an admin sends by hand (in a league that is not read-only) still go.
- One free league per owner (the oldest under 15; deactivated and excepted leagues never hold the slot). Another small league needs the Standard plan after its trial. The super-admin's free exception overrides this (the count must still be under 15).
- A free league at 15: 14 days (`grace_ends_at`), then its automatic emails stop (`emails_paused_since`). Never read-only, adding players never blocked. `league_billing.status = 'free'` marks a league that was free, so the job tells this case from a trial that ended unpaid.
- Over 100: a notice to the owner and a line in the operator's digest. No gating.
- Notices, once each (`billing_notices`), through the outbox (kind `billing_notice`, the league's own rows), in the league's language: `trial_7d`, `trial_day`, `grace_start`, `tier_change`, `payment_failed`, `over_100` to the owner; `trial_end`, `grace_end`, `deletion_30d`, `deletion_7d` to every admin. Links go to the billing page (a portal session expires).
- The 12-month clock (`inactive_since`): from the trial's end (unpaid, or Stripe-paused for want of a card) or the cancellation. Subscribing clears it. A league the owner paused is never deleted. Deletion through `performLeagueHardDelete` (`deleted_via` `billing_inactive_12_months`), at the earliest 30 days after the first notice and 7 days after the second; a subscription Stripe still keeps paused is cancelled first.
- Decision 3: a subscription Stripe paused at its trial's end (Stripe status `paused`) shows « Ajouter une carte » (the portal). The portal does not resume it: the app calls `POST /subscriptions/{id}/resume` (`billing_cycle_anchor=now`, no proration) once a card is on file, from the billing page load (back from the portal), the cron, and `invoice.paid`.

## Decisions (Roberto, 2026-10-02)

- Read-only still allows: deactivating or deleting the league, creating another league, accepting an admin invitation (`src/write_guard.js` mode `billing`).
- A cancelled subscription makes a league that is not free read-only at the end of the paid period (Stripe ends it then), and starts its 12-month clock.
- A trial that Stripe paused for want of a card counts as an unpaid trial: its 12-month clock runs, and its Stripe subscription is cancelled before the deletion. Only a pause the owner chose is never deleted.

## Batch 2: secrets, variables, key

Secrets (`npx wrangler secret put <NAME> --env demo`):

- `STRIPE_SECRET_KEY` (the restricted `rk_live_` key)
- `STRIPE_WEBHOOK_SECRET` (the endpoint's `whsec_` signing secret)

Variables (`wrangler.jsonc` `env.demo.vars` only, never top level):

- `STRIPE_PRICE_STANDARD_MONTHLY`, `STRIPE_PRICE_STANDARD_YEARLY`
- `STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PLUS_YEARLY`
- `STRIPE_PORTAL_CONFIGURATION_ID`
- `STRIPE_API_VERSION`
- `BILLING_LAUNCH_AT`

Restricted key permissions (live mode):

| Resource | Access |
|---|---|
| Checkout Sessions | Write |
| Customer portal | Write |
| Subscriptions | Write |
| Customers | Read |
| Prices | Read |
| Products | Read |
| Invoices | Read |
| Charges and Refunds | Read |
| Events | Read (optional) |
| Coupons, Promotion codes, Webhook endpoints | None |
| Everything else | None |

In this Stripe account refunds share one permission with charges ("Charges and Refunds"). Read is needed to check a charge for a full refund; it cannot create a refund. Refunds are made by Roberto in the Dashboard.

`GET /super-admin/billing/check` (admin key, Notre Ligue only) reads the four prices and their products and reports amount, currency, interval, tax behaviour and tier, plus whether the key can read refunds. Read only, no customer data.

## Production

`migrate-056.sql` must be applied to the production database (`smbhl-rsvp`) before the next production deploy. The schema guard checks the same manifest on both workers: without the tables, the production worker answers 503 and skips its cron. The code from before this migration runs unchanged on the new schema (new tables only).

```
npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-056.sql
```

Then deploy production in the same sitting.
