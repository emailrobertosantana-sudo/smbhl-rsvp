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
- Pause (monthly only): `pause_collection[behavior]=void`. Stripe keeps the subscription and voids each invoice while paused, so nothing is charged, for as long as it lasts. Resume reads the subscription from Stripe first. Past its trial, resume clears the pause with `billing_cycle_anchor=now` and `proration_behavior=none`: a new cycle starts that day. Still trialing, resume only clears the pause (Stripe refuses to reset a trialing subscription's `billing_cycle_anchor`), and the first charge stays at the trial's end.
- Tier change at renewal: the Notre Ligue cron checks every pass. A subscription whose stored count belongs in the other paid tier gets the other price (same interval) within the last 36 hours before its renewal, with `proration_behavior=none`, so the renewal invoice is the first at the new price. Free and custom counts are left to batch 3.

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
