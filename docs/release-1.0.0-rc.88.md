# M-BOX 1.0.0-rc.88

## Scope

This candidate closes the audited normalization regressions selected for V2.3:
role-scoped operating configuration, performance visibility, strong product and
reservation policy fields, normalized performer songs, typed notification
consent facts, and payment-before-fulfillment isolation.

## Business behavior

- Authorized managers can assign primary, backup and temporary service
  responsibility, configure venue tables, products, prices, recommendations,
  performers, schedules and song catalogs, and control the per-store online
  payment policy. These actions require server-side permissions, reasons,
  versioned state and read-back verification.
- Guests see the current performance while ordering; reservation users see the
  published performance for their selected date. Members retain benefits and
  reservation functions without technical WeChat or SMS authorization switches.
- Guest recommendations use typed visibility, search, party-size, priority,
  availability, channel, quantity, fulfillment and cost fields. Flexible images
  and copy remain JSONB display data.

## Payment and data protection

- A store with no commerce-policy row is closed to new online payment even when
  provider configuration exists. Existing callbacks, queries, refunds and
  reconciliation remain processable when new payment initiation is closed.
- The operating policy and effective provider availability are displayed as
  separate facts. An authorized manager can always close an open policy while
  a provider is unavailable, preventing payment from reopening automatically
  when channel configuration returns.
- Immediate-payment orders reserve inventory but cannot consume it or create a
  KDS task before trusted payment success. Database triggers reject direct
  activation or KDS insertion that attempts to bypass the application service.
- Migrations 042–048 are additive. Compatibility copies and write adapters are
  retained only for the `rc.87` rollback window; current runtime eligibility,
  timing, money, permission and notification decisions use typed structures.

## Acceptance boundary

The candidate requires immutable CI, backup, migration, candidate and public
route verification before traffic cutover. Automated tests do not prove real
acquiring, refund, reconciliation, printing, POS hardware or three live business
shifts. Production payment configuration and secrets must not be changed by this
release. New online payment must remain closed unless the existing controlled
production policy explicitly opens it and provider readiness is independently
verified.
