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
| Charges | Read |
| Events | Read (optional) |
| Refunds, Coupons, Promotion codes, Webhook endpoints | None |
| Everything else | None |

## Production

`migrate-056.sql` must be applied to the production database (`smbhl-rsvp`) before the next production deploy. The schema guard checks the same manifest on both workers: without the tables, the production worker answers 503 and skips its cron. The code from before this migration runs unchanged on the new schema (new tables only).

```
npx wrangler d1 execute smbhl-rsvp --remote --file=./migrate-056.sql
```

Then deploy production in the same sitting.
