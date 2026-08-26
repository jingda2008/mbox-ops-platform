# M-BOX 1.0.0-rc.138

## Scope

This candidate supersedes `1.0.0-rc.137`. It corrects the server-authoritative
customer-left turnover command for a table that also has historical settled or
refunded orders.

The command now keeps settled order headers, payments and refunds unchanged so
they remain available for reconciliation and after-sales handling. It cancels
only outstanding, unfulfilled items, KDS work and inventory reservations that
belong to the departing table occupant. Unpaid/pending orders retain the
existing cancellation and delivered-unpaid exception behavior.

This release does not mark any payment successful or failed, mutate a
historical refund, issue a new payment request, or build, upload or replace the
native WeChat mini-program package.

## Acceptance boundary

Before activation, the immutable tag must pass release CI and a fresh
PostgreSQL migration from `001` through `143`. The customer-left regression
must exercise a single table containing both an unresolved order and a
settled/refunded order with an unfulfilled KDS task. It must prove that the
table closes, the settled financial facts remain unchanged, and the obsolete
task is cancelled.

Local builds and isolated database tests do not prove a real payment-channel
result, physical POS, printer, hardware, staffed-field operation or native
WeChat acceptance.

## Production route

Deployment uses the approved release script with backup/readback, migration,
candidate health, Caddy cutover, rollback safeguards and external route smoke.
Post-switch evidence must confirm the exact commit, image digest, schema `143`,
worker health and `/`, `/guest?table=W01`, `/reserve` and `/staff/live`.

## Deployment evidence

Not yet deployed. The release workflow will add immutable tag, CI, image,
backup/readback, migration and smoke evidence after this candidate passes.
