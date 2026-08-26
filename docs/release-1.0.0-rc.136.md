# M-BOX 1.0.0-rc.136

## Scope

This candidate supersedes `1.0.0-rc.135`. It repairs the operational release
configuration for the customer-left turnover path: migration `142` restores
the default capability for existing stores, while store configuration v17
retains it after every future provisioning run.

Prior-business-day orders on the cashier page now expose a compact, exact
“顾客已离店，去翻台” entry when the signed-in employee has both the turnover
capabilities and the original table session is still open or closing. The
target staff page selects that same table; the final decision remains server
authorized and auditable.

This release does not weaken confirmed-payment, active-refund, inventory,
fulfillment or table-access safeguards. A staff member without all-table
access must still be assigned to the table; an administrator can configure
that data scope separately.

This release does not build, upload or replace the native WeChat mini-program
package.

## Acceptance boundary

Before activation, the immutable tag must pass release CI and a fresh
PostgreSQL migration from `001` through `142`, including the customer-left
turnover integration path and authoritative store provisioning checks.

Local builds and database tests do not prove real payment, physical POS,
printer, hardware, staffed-field operation or native WeChat acceptance.

## Production route

Deployment uses the approved release script with backup/readback, migration,
candidate health, Caddy cutover, rollback safeguards and external route
smoke. Post-switch evidence must confirm the exact commit, image digest,
schema `142`, worker health and `/`, `/guest?table=W01`, `/reserve` and
`/staff/live`.

## Deployment evidence

Not yet deployed. The release workflow will add immutable tag, CI, image,
backup/readback, migration and smoke evidence after this candidate passes.
