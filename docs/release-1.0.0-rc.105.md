# M-BOX 1.0.0-rc.105

## Scope

This candidate updates the normalized staff web and service from the current
main branch. It uses the existing `001` through `098` database contract and adds
no migration. The release bundle deliberately excludes the WeChat mini-program
package, so deployment does not upload or overwrite the customer mini-program.

## Business-day closure

- The background worker closes prior-business-day table sessions only when all
  typed operational facts are settled, then closes the corresponding business
  day and records the audit and outbox facts.
- Unsettled orders or order items, active KDS or service work, pending payment or
  refund facts, reserved pricing or benefits, active experience, redemption,
  song and checkout-upgrade facts all block closure. Blocked tables remain open
  on their original business date and retain an explicit resolution message.
- Authorized cashiers and managers can run the same idempotent check from the
  after-sales workbench. The action reports which tables closed and which remain
  blocked without rewriting historical revenue, orders or payment evidence.
- A second business day therefore does not make the prior day's exceptions
  disappear: settled tables close automatically, while genuine exceptions stay
  visible until their authoritative business facts are resolved.

## Verification boundary

The candidate requires clean `001` through `098` migration, PostgreSQL/RLS,
focused business-day, API, UI, build and release-system evidence for its exact
commit and image. The isolated PostgreSQL test verifies safe closure, typed
blocking, later resolution and exactly-once audit/outbox facts. Production
maintenance credentials, backup restoration and post-cutover staff checks
remain runtime deployment evidence rather than claims derived from source tests.
